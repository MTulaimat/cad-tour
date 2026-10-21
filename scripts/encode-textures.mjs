#!/usr/bin/env node
// Encode the cached Poly Haven maps (from fetch-textures.mjs) to KTX2 with mipmaps:
//
//   public/textures/<material>/<res>/{albedo,normal,orm}.ktx2     res = 1k | 2k | 4k
//   public/textures/manifest.json
//
//   node scripts/encode-textures.mjs [materialKey ...] [--res 1k,2k] [--only-missing] [--manifest-only]
//
// Encoder: the official KTX-Software `ktx create` CLI (see scripts/lib/ktx-tool.mjs; it is
// downloaded into tools/ on first run). The pure-npm Basis encoder (ktx2-encoder, Basis v2.5 wasm)
// was evaluated and works in Node, but its wasm build refuses sources above 12 Mpix, so it cannot
// produce the 4096x4096 hero set.
//
// Map conventions in the output (what the app must assume):
//   albedo  ETC1S / BasisLZ, sRGB transfer + BT.709 primaries -> KTX2Loader sets SRGBColorSpace
//   orm     ETC1S / BasisLZ, linear, primaries unspecified -> NoColorSpace.
//           R = ambient occlusion, G = roughness, B = metalness (glTF convention)
//   normal  tangent space, OpenGL convention (+Y = up in the image, Poly Haven "nor_gl"),
//           RGB = XYZ, linear. 1k: UASTC + RDO + Zstandard. 2k / 4k: ETC1S / BasisLZ (budget).
//   All maps are stored with a bottom-left texture origin (KTXorientation "ru"): images are flipped
//   at encode time, so with KTX2Loader (which cannot flip compressed data, flipY = false) they map
//   exactly like a TextureLoader image with flipY = true. Normal maps need no green flip:
//   normalScale = (1, 1).
//   Mipmaps: full chain, generated with wrap-around edge filtering (textures tile).
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { TEXTURES } from './assets.config.mjs';
import { ensureKtx, KTX_VERSION } from './lib/ktx-tool.mjs';
import { readKtx2Header } from './lib/ktx2-header.mjs';
import { mb } from './lib/net.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, '.cache', 'textures');
const PREP = path.join(ROOT, '.cache', 'textures-prep');
const OUT = path.join(ROOT, 'public', 'textures');
const SIZE = { '1k': 1024, '2k': 2048, '4k': 4096 };

const COMMON = [
  '--convert-texcoord-origin', 'bottom-left',
  '--generate-mipmap', '--mipmap-wrap', 'wrap', '--mipmap-filter', 'lanczos4',
];
const SRGB = ['--format', 'R8G8B8_SRGB', '--assign-tf', 'srgb', '--assign-primaries', 'bt709'];
const LINEAR = ['--format', 'R8G8B8_UNORM', '--assign-tf', 'linear', '--assign-primaries', 'none'];
const ETC1S = (qlevel) => ['--encode', 'basis-lz', '--clevel', '4', '--qlevel', String(qlevel)];
const UASTC_RDO = (lambda) => [
  '--encode', 'uastc', '--uastc-quality', '2',
  '--uastc-rdo', '--uastc-rdo-l', String(lambda), '--uastc-rdo-d', '32768',
  '--zstd', '18',
];

/** Encoder settings per map role and resolution. */
function profile(role, res) {
  if (role === 'albedo') return { color: SRGB, encode: ETC1S(192), label: 'ETC1S q192, sRGB' };
  if (role === 'orm') return { color: LINEAR, encode: ETC1S(160), label: 'ETC1S q160, linear' };
  if (res === '1k') return { color: LINEAR, encode: UASTC_RDO(1.0), label: 'UASTC q2 + RDO 1.0 + zstd 18, linear' };
  return { color: LINEAR, encode: ETC1S(255), label: 'ETC1S q255, linear' };
}

// ---------- source preparation (sharp) ----------

async function toSquare(img, size) {
  const m = await img.metadata();
  return m.width === size && m.height === size ? img : img.resize(size, size, { fit: 'fill', kernel: 'lanczos3' });
}

async function prepAlbedo(src, dst, size) {
  // Honour an embedded ICC profile (converts to sRGB), drop alpha.
  const img = await toSquare(sharp(src).removeAlpha(), size);
  await img.toColourspace('srgb').png({ compressionLevel: 1 }).toFile(dst);
}

async function prepOrm(meta, dir, dst, size) {
  const files = meta.resolutions[dir];
  if (files.arm) {
    // Poly Haven "arm" is already R=AO, G=roughness, B=metalness. Raw data: ignore ICC.
    const img = await toSquare(sharp(path.join(SRC, meta.key, files.arm.file), { ignoreIcc: true }).removeAlpha(), size);
    await img.png({ compressionLevel: 1 }).toFile(dst);
    return;
  }
  // Pack AO + roughness, metalness = 0.
  const read = async (f) => (await toSquare(sharp(path.join(SRC, meta.key, f), { ignoreIcc: true }).greyscale(), size)).raw().toBuffer();
  const [ao, rough] = await Promise.all([read(files.ao.file), read(files.rough.file)]);
  const out = Buffer.alloc(size * size * 3);
  for (let i = 0; i < size * size; i++) {
    out[i * 3] = ao[i];
    out[i * 3 + 1] = rough[i];
    out[i * 3 + 2] = 0;
  }
  await sharp(out, { raw: { width: size, height: size, channels: 3 } }).png({ compressionLevel: 1 }).toFile(dst);
}

async function prepNormal(src, dst, size) {
  // Read 16-bit when available, renormalise to unit length, write 8-bit. Raw data: ignore ICC.
  const img = await toSquare(sharp(src, { ignoreIcc: true }).removeAlpha(), size);
  const { data, info } = await img.toColourspace('rgb16').raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true });
  const px = new Uint16Array(data.buffer, data.byteOffset, data.length / 2);
  const n = info.width * info.height;
  const out = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) {
    let x = (px[i * 3] / 65535) * 2 - 1;
    let y = (px[i * 3 + 1] / 65535) * 2 - 1;
    let z = (px[i * 3 + 2] / 65535) * 2 - 1;
    const len = Math.hypot(x, y, z);
    if (len > 1e-6) {
      x /= len;
      y /= len;
      z /= len;
    } else {
      x = 0;
      y = 0;
      z = 1;
    }
    out[i * 3] = Math.round((x * 0.5 + 0.5) * 255);
    out[i * 3 + 1] = Math.round((y * 0.5 + 0.5) * 255);
    out[i * 3 + 2] = Math.round((z * 0.5 + 0.5) * 255);
  }
  await sharp(out, { raw: { width: info.width, height: info.height, channels: 3 } }).png({ compressionLevel: 1 }).toFile(dst);
}

// ---------- encode + verify ----------

function run(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${path.basename(bin)} ${args.join(' ')}\n${r.stdout}\n${r.stderr}`);
  return r.stdout + r.stderr;
}

function verify(ktx, file, role, res) {
  const out = run(ktx, ['validate', file]); // exits non-zero on any spec violation
  const h = readKtx2Header(new Uint8Array(readFileSync(file)));
  const size = SIZE[res];
  const problems = [];
  if (h.width !== size || h.height !== size) problems.push(`size ${h.width}x${h.height}`);
  if (h.levels !== Math.log2(size) + 1) problems.push(`levels ${h.levels}`);
  if (role === 'albedo' && h.transferFunction !== 'srgb') problems.push(`albedo transfer ${h.transferFunction}`);
  if (role !== 'albedo' && h.transferFunction !== 'linear') problems.push(`${role} transfer ${h.transferFunction}`);
  if (h.keyValue.KTXorientation !== 'ru') problems.push(`orientation ${h.keyValue.KTXorientation}`);
  if (problems.length) throw new Error(`${file}: ${problems.join(', ')}\n${out}`);
  return h;
}

// ---------- main ----------

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const resArg = args.includes('--res') ? args[args.indexOf('--res') + 1].split(',') : null;
const keys = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--res');
const materials = keys.length ? TEXTURES.filter((m) => keys.includes(m.key)) : TEXTURES;
if (keys.length && materials.length !== keys.length) {
  console.error(`Unknown material key. Known: ${TEXTURES.map((m) => m.key).join(', ')}`);
  process.exit(1);
}

if (!flag('--manifest-only')) {
  const ktx = await ensureKtx(ROOT);
  console.log(`Using ${ktx} (${run(ktx, ['--version']).trim()}), ${os.cpus().length} threads`);
  for (const mat of materials) {
    const meta = JSON.parse(await fs.readFile(path.join(SRC, mat.key, 'meta.json'), 'utf8'));
    for (const res of mat.resolutions) {
      if (resArg && !resArg.includes(res)) continue;
      const size = SIZE[res];
      const prepDir = path.join(PREP, mat.key, res);
      const outDir = path.join(OUT, mat.key, res);
      await fs.mkdir(prepDir, { recursive: true });
      await fs.mkdir(outDir, { recursive: true });
      const srcFiles = meta.resolutions[res];
      for (const role of ['albedo', 'normal', 'orm']) {
        const outFile = path.join(outDir, `${role}.ktx2`);
        if (flag('--only-missing') && existsSync(outFile)) continue;
        const prepFile = path.join(prepDir, `${role}.png`);
        if (role === 'albedo') await prepAlbedo(path.join(SRC, mat.key, srcFiles.albedo.file), prepFile, size);
        else if (role === 'normal') await prepNormal(path.join(SRC, mat.key, srcFiles.normal.file), prepFile, size);
        else await prepOrm(meta, res, prepFile, size);
        const p = profile(role, res);
        const t0 = Date.now();
        run(ktx, ['create', ...p.color, ...COMMON, ...p.encode, prepFile, outFile]);
        const h = verify(ktx, outFile, role, res);
        const { size: bytes } = await fs.stat(outFile);
        console.log(
          `${mat.key.padEnd(10)} ${res} ${role.padEnd(6)} ${mb(bytes).padStart(9)}  ${h.colorModel}/${h.supercompression}/${h.transferFunction}  ` +
            `${h.levels} mips  ${((Date.now() - t0) / 1000).toFixed(1)}s  (${p.label})`,
        );
      }
    }
  }
}

// ---------- manifest ----------

const manifest = {
  generatedBy: 'scripts/encode-textures.mjs',
  encoder: `KTX-Software ktx create v${KTX_VERSION}`,
  pathsRelativeTo: 'public/ (prefix with import.meta.env.BASE_URL)',
  conventions: {
    orientation: 'bottom-left origin (KTXorientation "ru"): behaves like TextureLoader with flipY = true; KTX2Loader leaves flipY = false',
    albedo: 'ETC1S/BasisLZ, sRGB transfer, BT.709 primaries (KTX2Loader sets SRGBColorSpace)',
    orm: 'ETC1S/BasisLZ, linear, primaries unspecified (NoColorSpace). R = ambient occlusion, G = roughness, B = metalness',
    normal: 'tangent space, OpenGL (+Y up, Poly Haven nor_gl), RGB = XYZ, linear (NoColorSpace). 1k = UASTC + RDO + Zstandard; 2k and 4k = ETC1S/BasisLZ to fit the download budget. normalScale (1, 1)',
    mipmaps: 'full chain, wrap-around filtering (textures tile)',
    uvs: 'set texture.repeat = 1 / metersPerRepeat for UVs in meters (or scale UVs by the same factor)',
  },
  materials: {},
  totals: {},
};
for (const mat of TEXTURES) {
  const metaFile = path.join(SRC, mat.key, 'meta.json');
  if (!existsSync(metaFile)) continue;
  const meta = JSON.parse(await fs.readFile(metaFile, 'utf8'));
  const entry = {
    key: mat.key,
    use: mat.use,
    sourceId: meta.sourceId,
    name: meta.name,
    sourceUrl: meta.sourceUrl,
    author: Object.keys(meta.authors).join(', '),
    authors: meta.authors,
    license: 'CC0-1.0',
    metersPerRepeat: { x: meta.dimensionsMm.width / 1000, y: meta.dimensionsMm.height / 1000 },
    ...(meta.dimensionsNote ? { dimensionsNote: meta.dimensionsNote } : {}),
    resolutions: [],
    files: {},
  };
  for (const res of mat.resolutions) {
    const files = {};
    let total = 0;
    for (const role of ['albedo', 'normal', 'orm']) {
      const file = path.join(OUT, mat.key, res, `${role}.ktx2`);
      if (!existsSync(file)) continue;
      const h = readKtx2Header(new Uint8Array(readFileSync(file)));
      const { size } = await fs.stat(file);
      total += size;
      files[role] = {
        path: `textures/${mat.key}/${res}/${role}.ktx2`,
        bytes: size,
        width: h.width,
        height: h.height,
        levels: h.levels,
        encoding: h.colorModel,
        supercompression: h.supercompression,
        transfer: h.transferFunction,
      };
    }
    if (Object.keys(files).length === 3) {
      entry.resolutions.push(res);
      entry.files[res] = { ...files, totalBytes: total };
      manifest.totals[res] = (manifest.totals[res] ?? 0) + total;
    }
  }
  manifest.materials[mat.key] = entry;
}
await fs.mkdir(OUT, { recursive: true });
await fs.writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('\nTotals per resolution set:');
for (const [res, bytes] of Object.entries(manifest.totals)) console.log(`  ${res}: ${mb(bytes)} (${bytes} bytes)`);
console.log(`Wrote ${path.relative(ROOT, path.join(OUT, 'manifest.json'))}`);
