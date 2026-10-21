#!/usr/bin/env node
// Build the sky assets from one Poly Haven CC0 HDRI (id in scripts/assets.config.mjs):
//
//   public/hdri/env-1k.hdr         Radiance RGBE equirect for PMREM lighting (three's HDRLoader).
//                                  By default the sun disc is replaced by the surrounding sky so
//                                  the shadow-casting DirectionalLight carries the sun's energy
//                                  without double counting (the removed energy is
//                                  sun.json suggestedIntensity). --keep-sun ships it untouched.
//   public/hdri/backplate-2k.jpg   LDR equirect backgrounds (sRGB JPEG, q85) made from the 4K HDR:
//   public/hdri/backplate-4k.jpg   auto exposure + soft highlight shoulder, left a little flat and
//                                  bright because the app tone maps them again (ACES) in post.
//   public/hdri/sun.json           sun direction (three.js equirect convention), colour,
//                                  intensity and source credits.
//
//   node scripts/process-hdri.mjs [--keep-sun]
//
// three.js r186 equirect convention (src/renderers/shaders/ShaderChunk/common.glsl.js, equirectUv):
//   u = atan(dir.z, dir.x) / (2*PI) + 0.5,  v = asin(dir.y) / PI + 0.5
// HDRLoader and TextureLoader both set flipY = true, so v = 1 is the top row of the image.
// The image centre (u = 0.5) looks along +X, u = 0.75 along +Z, u = 0.25 along -Z, the edges -X.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { HDRI, POLYHAVEN_API } from './assets.config.mjs';
import { getJson, downloadFile, mb } from './lib/net.mjs';
import { readRGBE, writeRGBE, encodeRGBEPixel } from './lib/rgbe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache', 'hdri', HDRI.id);
const OUT = path.join(ROOT, 'public', 'hdri');
const KEEP_SUN = process.argv.includes('--keep-sun');

const DEG = Math.PI / 180;
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Pixel centre -> unit direction in three's equirect convention (row 0 = top = +Y). */
function pixelDir(x, y, W, H) {
  const u = (x + 0.5) / W;
  const v = 1 - (y + 0.5) / H;
  const phi = (u - 0.5) * 2 * Math.PI; // atan2(z, x)
  const el = (v - 0.5) * Math.PI; // asin(y)
  return [Math.cos(el) * Math.cos(phi), Math.sin(el), Math.cos(el) * Math.sin(phi)];
}

/** Solid angle of one equirect pixel in row y. */
const pixelSolidAngle = (y, W, H) => {
  const el0 = (0.5 - y / H) * Math.PI;
  const el1 = (0.5 - (y + 1) / H) * Math.PI;
  return (2 * Math.PI / W) * (Math.sin(el0) - Math.sin(el1));
};

/** Brightest region: peak of a 3x3 box-filtered luminance, then a luminance-weighted centroid. */
function findSun({ width: W, height: H, data }) {
  const L = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) L[i] = lum(data[i * 3], data[i * 3 + 1], data[i * 3 + 2]);
  let best = -1;
  let bestI = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += L[(y + dy) * W + ((x + dx + W) % W)];
      if (s > best) {
        best = s;
        bestI = y * W + x;
      }
    }
  }
  const peakDir = pixelDir(bestI % W, Math.floor(bestI / W), W, H);
  const peak = L[bestI];
  // Centroid of pixels within 2 degrees of the peak that are at least 25% of the peak.
  const c = Math.cos(2 * DEG);
  const acc = [0, 0, 0];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const l = L[y * W + x];
      if (l < 0.25 * peak) continue;
      const d = pixelDir(x, y, W, H);
      if (d[0] * peakDir[0] + d[1] * peakDir[1] + d[2] * peakDir[2] < c) continue;
      const w = l * pixelSolidAngle(y, W, H);
      acc[0] += d[0] * w;
      acc[1] += d[1] * w;
      acc[2] += d[2] * w;
    }
  }
  const n = Math.hypot(...acc);
  return { dir: acc.map((v) => v / n), peak };
}

/**
 * Measure the sun's irradiance (energy above the surrounding sky inside `capDeg`) and, unless
 * keepSun, clamp those pixels down to the sky level. Returns RGB irradiance in HDR units, i.e.
 * the DirectionalLight colour * intensity that reproduces the removed energy at
 * environmentIntensity = 1.
 */
function extractSun(img, sunDir, capDeg, keepSun) {
  const { width: W, height: H, data, rgbe } = img;
  const cosCap = Math.cos(capDeg * DEG);
  const cosIn = cosCap;
  const cosOut = Math.cos((capDeg + 1) * DEG);
  // Sky level just outside the cap (1 degree ring): clamping to it keeps the circumsolar glow
  // continuous at the cap edge, so glossy reflections show no dark disc where the sun was.
  const ring = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = pixelDir(x, y, W, H);
      const c = d[0] * sunDir[0] + d[1] * sunDir[1] + d[2] * sunDir[2];
      if (c <= cosIn && c >= cosOut) {
        const i = (y * W + x) * 3;
        ring.push([lum(data[i], data[i + 1], data[i + 2]), data[i], data[i + 1], data[i + 2]]);
      }
    }
  }
  ring.sort((a, b) => a[0] - b[0]);
  const mid = ring.slice(Math.floor(ring.length * 0.4), Math.ceil(ring.length * 0.6));
  const bg = [1, 2, 3].map((k) => mid.reduce((s, p) => s + p[k], 0) / mid.length);
  const bgL = lum(...bg);
  const limit = 1.25 * bgL;

  const E = [0, 0, 0];
  const out = new Uint8Array(rgbe);
  let touched = 0;
  for (let y = 0; y < H; y++) {
    const dw = pixelSolidAngle(y, W, H);
    for (let x = 0; x < W; x++) {
      const d = pixelDir(x, y, W, H);
      if (d[0] * sunDir[0] + d[1] * sunDir[1] + d[2] * sunDir[2] < cosCap) continue;
      const i = (y * W + x) * 3;
      const l = lum(data[i], data[i + 1], data[i + 2]);
      if (l <= limit) continue;
      const s = limit / l; // scale the pixel down to the sky level, keeping its hue
      for (let k = 0; k < 3; k++) E[k] += data[i + k] * (1 - s) * dw;
      if (!keepSun) encodeRGBEPixel(data[i] * s, data[i + 1] * s, data[i + 2] * s, out, (y * W + x) * 4);
      touched++;
    }
  }
  return { E, bg, touched, rgbe: out };
}

/** Irradiance on an upward-facing horizontal plane from the whole map (cosine weighted). */
function horizontalIrradiance({ width: W, height: H, data }) {
  const E = [0, 0, 0];
  for (let y = 0; y < H / 2; y++) {
    const dw = pixelSolidAngle(y, W, H);
    for (let x = 0; x < W; x++) {
      const cos = pixelDir(x, y, W, H)[1];
      const i = (y * W + x) * 3;
      for (let k = 0; k < 3; k++) E[k] += data[i + k] * cos * dw;
    }
  }
  return E;
}

const srgbEncode = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const toHex = (rgb) => '#' + rgb.map((c) => Math.round(Math.min(1, Math.max(0, srgbEncode(c))) * 255).toString(16).padStart(2, '0')).join('');

/** Soft shoulder: linear up to `knee`, then an exponential roll-off approaching 1.0. */
const shoulder = (x, knee) => (x <= knee ? x : knee + (1 - knee) * (1 - Math.exp(-(x - knee) / (1 - knee))));

function median(values) {
  const a = Float32Array.from(values).sort();
  return a[a.length >> 1];
}

/** Exposure so the city/ground band and the sky both land in a readable range. */
function chooseExposure({ width: W, height: H, data }, sunDir) {
  const low = [];
  const sky = [];
  const cosSun = Math.cos(15 * DEG);
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const d = pixelDir(x, y, W, H);
      const el = Math.asin(d[1]) / DEG;
      const i = (y * W + x) * 3;
      const l = lum(data[i], data[i + 1], data[i + 2]);
      if (el > -20 && el < 3) low.push(l);
      else if (el > 10 && el < 70 && d[0] * sunDir[0] + d[1] * sunDir[1] + d[2] * sunDir[2] < cosSun) sky.push(l);
    }
  }
  const mLow = median(low);
  const mSky = median(sky);
  // Targets are pre-ACES linear values: three's ACES maps 0.2 -> ~sRGB 130 and 0.55 -> ~sRGB 200.
  const k = Math.min(0.2 / mLow, 0.55 / mSky);
  return { k, mLow, mSky };
}

/** Tone map linear HDR (already box-downsampled to the target size) to sRGB 8-bit. */
function toneMap(data, n, k, knee) {
  const out = Buffer.alloc(n * 3);
  for (let i = 0; i < n * 3; i++) out[i] = Math.round(srgbEncode(shoulder(data[i] * k, knee)) * 255);
  return out;
}

/** Exact 2:1 box downsample in linear space. */
function downsample2({ width: W, height: H, data }) {
  const w = W / 2;
  const h = H / 2;
  const out = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let k = 0; k < 3; k++) {
        const a = ((2 * y) * W + 2 * x) * 3 + k;
        const b = ((2 * y + 1) * W + 2 * x) * 3 + k;
        out[(y * w + x) * 3 + k] = (data[a] + data[a + 3] + data[b] + data[b + 3]) / 4;
      }
    }
  }
  return { width: w, height: h, data: out };
}

/** three.js ACESFilmicToneMapping (exposure 1), for the preview only. */
function acesPreview(rgb) {
  const [r, g, b] = rgb.map((c) => c / 0.6);
  const i0 = 0.59719 * r + 0.35458 * g + 0.04823 * b;
  const i1 = 0.076 * r + 0.90834 * g + 0.01566 * b;
  const i2 = 0.0284 * r + 0.13383 * g + 0.83777 * b;
  const fit = (v) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
  const [a, bb, c] = [fit(i0), fit(i1), fit(i2)];
  return [
    1.60475 * a - 0.53108 * bb - 0.07367 * c,
    -0.10208 * a + 1.10813 * bb - 0.00605 * c,
    -0.00327 * a - 0.07276 * bb + 1.07602 * c,
  ].map((v) => Math.min(1, Math.max(0, v)));
}

// ---------- main ----------

const [info, files] = await Promise.all([getJson(`${POLYHAVEN_API}/info/${HDRI.id}`), getJson(`${POLYHAVEN_API}/files/${HDRI.id}`)]);
const envEntry = files.hdri[HDRI.envResolution].hdr;
const plateEntry = files.hdri[HDRI.backplateSource].hdr;
const envSrc = path.join(CACHE, `${HDRI.id}_${HDRI.envResolution}.hdr`);
const plateSrc = path.join(CACHE, `${HDRI.id}_${HDRI.backplateSource}.hdr`);
console.log(`${info.name} (${HDRI.id}) by ${Object.keys(info.authors).join(', ')}`);
console.log(`  ${HDRI.envResolution}: ${await downloadFile(envEntry.url, envSrc, envEntry.md5)} ${mb(envEntry.size)}`);
console.log(`  ${HDRI.backplateSource}: ${await downloadFile(plateEntry.url, plateSrc, plateEntry.md5)} ${mb(plateEntry.size)}`);

const env = readRGBE(new Uint8Array(await fs.readFile(envSrc)));
const plate = readRGBE(new Uint8Array(await fs.readFile(plateSrc)));
console.log(`  parsed env ${env.width}x${env.height}, backplate source ${plate.width}x${plate.height}`);

// Sun direction from the higher-resolution map (sun disc is ~6 px wide at 4K), cross-checked on 1K.
const sunHi = findSun(plate);
const sunLo = findSun(env);
const sep = Math.acos(Math.min(1, sunHi.dir.reduce((s, v, i) => s + v * sunLo.dir[i], 0))) / DEG;
const dir = sunHi.dir;
const elevationDeg = Math.asin(dir[1]) / DEG;
const azimuthDeg = Math.atan2(dir[2], dir[0]) / DEG;
console.log(`  sun: elevation ${elevationDeg.toFixed(2)} deg, azimuth ${azimuthDeg.toFixed(2)} deg (1K estimate differs by ${sep.toFixed(2)} deg)`);

// Sun energy, measured on (and optionally removed from) the shipped 1K map. Over 98% of it sits
// inside 1 degree; 3 degrees also catches the 1K resampling blur around the disc.
const CAP_DEG = 3;
const before = horizontalIrradiance(env);
const sun = extractSun(env, dir, CAP_DEG, KEEP_SUN);
const sunMax = Math.max(...sun.E);
const colorLinear = sun.E.map((v) => v / sunMax);
const skyOnly = before.map((v, k) => v - sun.E[k] * Math.max(0, dir[1]));
console.log(`  sun irradiance (normal incidence) RGB ${sun.E.map((v) => v.toFixed(2)).join(', ')} from ${sun.touched} px; colour ${toHex(colorLinear)}`);
console.log(`  horizontal irradiance: sun ${(lum(...sun.E) * dir[1]).toFixed(2)}, sky ${lum(...skyOnly).toFixed(2)} (luminance)`);

await fs.mkdir(OUT, { recursive: true });
const envOut = path.join(OUT, 'env-1k.hdr');
if (KEEP_SUN) {
  await fs.copyFile(envSrc, envOut);
} else {
  const comment = [`# ${HDRI.id} (Poly Haven, CC0) ${HDRI.envResolution}; sun within ${CAP_DEG} deg clamped to sky level by scripts/process-hdri.mjs`];
  await fs.writeFile(envOut, writeRGBE(env.width, env.height, sun.rgbe, comment));
}
// Round-trip check: the written file must parse and match the expected pixels.
const check = readRGBE(new Uint8Array(await fs.readFile(envOut)));
if (check.width !== env.width || check.height !== env.height) throw new Error('env-1k.hdr round trip failed');
const expected = KEEP_SUN ? env.rgbe : sun.rgbe;
for (let i = 0; i < expected.length; i++) if (check.rgbe[i] !== expected[i]) throw new Error(`env-1k.hdr pixel mismatch at byte ${i}`);

// Backplates.
const expo = chooseExposure(plate, dir);
const KNEE = 0.6;
console.log(`  backplate exposure ${expo.k.toFixed(4)} (ground/city median ${expo.mLow.toFixed(3)}, sky median ${expo.mSky.toFixed(3)}), shoulder knee ${KNEE}`);
const plates = {};
let level = plate;
const levels = {};
while (level.width >= Math.min(...HDRI.backplates)) {
  levels[level.width] = level;
  if (level.width / 2 < Math.min(...HDRI.backplates)) break;
  level = downsample2(level);
}
for (const width of HDRI.backplates) {
  const src = levels[width];
  if (!src) throw new Error(`No ${width}px level (source ${plate.width}px)`);
  const name = `backplate-${width / 1024}k.jpg`;
  const pixels = toneMap(src.data, src.width * src.height, expo.k, KNEE);
  await sharp(pixels, { raw: { width: src.width, height: src.height, channels: 3 } })
    .jpeg({ quality: 85, mozjpeg: true, chromaSubsampling: '4:2:0' })
    .toFile(path.join(OUT, name));
  const { size } = await fs.stat(path.join(OUT, name));
  plates[`${width / 1024}k`] = { file: `hdri/${name}`, width: src.width, height: src.height, bytes: size };
  console.log(`  ${name}: ${src.width}x${src.height}, ${mb(size)}`);
}

// Preview of the 2K backplate after three's ACES (exposure 1), for eyeballing only (not shipped).
{
  const src = levels[2048];
  const n = src.width * src.height;
  const px = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) {
    const lin = [0, 1, 2].map((k) => {
      const s = srgbEncode(shoulder(src.data[i * 3 + k] * expo.k, KNEE));
      const q = Math.round(s * 255) / 255; // what the JPEG stores
      return q <= 0.04045 ? q / 12.92 : Math.pow((q + 0.055) / 1.055, 2.4);
    });
    const t = acesPreview(lin);
    for (let k = 0; k < 3; k++) px[i * 3 + k] = Math.round(srgbEncode(t[k]) * 255);
  }
  await sharp(px, { raw: { width: src.width, height: src.height, channels: 3 } }).jpeg({ quality: 90 }).toFile(path.join(CACHE, 'preview-backplate-2k-after-aces.jpg'));
}

const { size: envBytes } = await fs.stat(envOut);
const sunJson = {
  hdri: {
    id: HDRI.id,
    name: info.name,
    author: Object.keys(info.authors).join(', '),
    authors: info.authors,
    url: `https://polyhaven.com/a/${HDRI.id}`,
    license: 'CC0-1.0',
  },
  convention:
    'three.js r186 equirect (common.glsl.js equirectUv): u = atan(dir.z, dir.x) / (2*PI) + 0.5, v = asin(dir.y) / PI + 0.5, ' +
    'v = 1 is the top image row (HDRLoader and TextureLoader use flipY = true). Image centre looks along +X, u = 0.75 along +Z. ' +
    'Values assume scene.backgroundRotation and scene.environmentRotation are zero; if you rotate the sky by an Euler e, ' +
    'rotate the sun the same way: new Vector3(...direction).applyEuler(e).',
  azimuthDeg: +azimuthDeg.toFixed(2),
  azimuthNote: 'atan2(direction.z, direction.x) in degrees: 0 = +X, 90 = +Z, -90 = -Z',
  elevationDeg: +elevationDeg.toFixed(2),
  direction: dir.map((v) => +v.toFixed(5)),
  directionNote: 'unit vector from the scene towards the sun: light.position = target + direction * distance',
  suggestedIntensity: +sunMax.toFixed(3),
  color: toHex(colorLinear),
  colorLinear: colorLinear.map((v) => +v.toFixed(4)),
  intensityNote:
    'DirectionalLight intensity in the HDR\'s own units, with color = `color` (sRGB hex) or colorLinear, so the light reproduces ' +
    `the sun energy measured inside ${CAP_DEG} deg of the sun at environmentIntensity = 1. ` +
    (KEEP_SUN
      ? 'The env map still contains the sun, so using both double counts it.'
      : 'That energy was removed from env-1k.hdr, so env + light together match the original HDRI. Scale both by the same factor to change exposure.'),
  irradiance: {
    sunNormal: +lum(...sun.E).toFixed(3),
    sunOnHorizontal: +(lum(...sun.E) * Math.max(0, dir[1])).toFixed(3),
    skyOnHorizontal: +lum(...skyOnly).toFixed(3),
    note: 'luminance-weighted, HDR units; sky = everything in env-1k.hdr except the removed sun',
  },
  env: {
    file: 'hdri/env-1k.hdr',
    width: env.width,
    height: env.height,
    bytes: envBytes,
    sunRemoved: !KEEP_SUN,
    sunCapDeg: CAP_DEG,
    skyColorAroundSun: toHex(sun.bg.map((v) => v / Math.max(...sun.bg))),
  },
  view: {
    cityAzimuthDeg: { from: 57, to: 154, centre: 110 },
    note:
      'Approximate, read off the image by eye: the Cape Town city view (suburbs, Cape Flats, mountains) spans these azimuths ' +
      '(same atan2(z, x) convention). The other directions show the memorial terrace, colonnade and trees. Point the main ' +
      'glazing and balcony at this range, or rotate the sky (and the sun with it) to suit the plan.',
  },
  backplates: {
    ...plates,
    madeFrom: `${HDRI.backplateSource} HDR`,
    exposure: +expo.k.toFixed(5),
    curve: `linear * exposure, soft shoulder above ${KNEE} approaching 1.0, sRGB OETF, JPEG q85 (mozjpeg, 4:2:0)`,
    usage: 'TextureLoader, colorSpace = SRGBColorSpace, mapping = EquirectangularReflectionMapping, scene.background; tone mapped again by ACES in post',
  },
};
await fs.writeFile(path.join(OUT, 'sun.json'), JSON.stringify(sunJson, null, 2) + '\n');
console.log(`  env-1k.hdr ${mb(envBytes)} (${KEEP_SUN ? 'original' : 'sun removed'})`);
console.log(`Wrote ${path.relative(ROOT, OUT)}/{env-1k.hdr, backplate-2k.jpg, backplate-4k.jpg, sun.json}`);
