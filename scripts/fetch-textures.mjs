#!/usr/bin/env node
// Download the CC0 source maps for every CAD Tour material from Poly Haven into .cache/textures/.
//
//   node scripts/fetch-textures.mjs [materialKey ...]
//
// For each material and resolution (see scripts/assets.config.mjs) this fetches:
//   albedo  Diffuse (JPG, sRGB)
//   normal  nor_gl  (PNG, OpenGL convention: +Y = up in the image)
//   arm     packed AO/rough/metal (JPG, linear; R=AO, G=roughness, B=metalness)
//           or, when an asset has no arm map, AO + Rough separately (packed later by encode-textures)
// Files are verified against the md5 the Poly Haven files API reports, and re-runs skip files
// that are already cached. It also writes .cache/textures/<key>/meta.json with the asset's name,
// authors, URL and real-world size (Poly Haven `dimensions`, in mm) for the manifest and CREDITS.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEXTURES, POLYHAVEN_API } from './assets.config.mjs';
import { getJson, downloadFile, mb } from './lib/net.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache', 'textures');

/** Poly Haven sometimes reports a broken dimension (e.g. white_stucco_02 width = 0.00008 mm). */
function fixDimensions(dimensions, maxResolution) {
  let [w, h] = dimensions ?? [];
  const aspect = maxResolution ? maxResolution[0] / maxResolution[1] : 1;
  const valid = (v) => Number.isFinite(v) && v > 1;
  let note = null;
  if (!valid(w) && valid(h)) {
    w = h * aspect;
    note = `Poly Haven reports width ${dimensions[0]} mm; derived from height and pixel aspect`;
  } else if (valid(w) && !valid(h)) {
    h = w / aspect;
    note = `Poly Haven reports height ${dimensions[1]} mm; derived from width and pixel aspect`;
  } else if (!valid(w) && !valid(h)) {
    throw new Error(`No usable dimensions: ${JSON.stringify(dimensions)}`);
  }
  // Values come back as e.g. 1699.9999284744263; round to 0.1 mm.
  return { widthMm: Math.round(w * 10) / 10, heightMm: Math.round(h * 10) / 10, note };
}

function pickMap(files, names) {
  for (const n of names) if (files[n]) return files[n];
  return null;
}

async function fetchMaterial(mat) {
  const [info, files] = await Promise.all([
    getJson(`${POLYHAVEN_API}/info/${mat.id}`),
    getJson(`${POLYHAVEN_API}/files/${mat.id}`),
  ]);
  const dims = fixDimensions(info.dimensions, info.max_resolution);
  const dir = path.join(CACHE, mat.key);
  const meta = {
    key: mat.key,
    sourceId: mat.id,
    name: info.name.trim(),
    sourceUrl: `https://polyhaven.com/a/${mat.id}`,
    authors: info.authors, // { name: role }
    license: 'CC0',
    dimensionsMm: { width: dims.widthMm, height: dims.heightMm },
    dimensionsNote: dims.note,
    reportedDimensions: info.dimensions,
    resolutions: {},
  };

  const diffuse = pickMap(files, ['Diffuse', 'diff', 'diffuse']);
  const normal = pickMap(files, ['nor_gl']);
  const arm = pickMap(files, ['arm']);
  const ao = pickMap(files, ['AO', 'ao']);
  const rough = pickMap(files, ['Rough', 'rough']);
  if (!diffuse || !normal || (!arm && !(ao && rough))) {
    throw new Error(`${mat.id}: missing maps (have ${Object.keys(files).join(', ')})`);
  }

  for (const res of mat.resolutions) {
    const want = [
      ['albedo', diffuse, 'jpg'],
      ['normal', normal, 'png'],
      ...(arm ? [['arm', arm, 'jpg']] : [['ao', ao, 'jpg'], ['rough', rough, 'jpg']]),
    ];
    meta.resolutions[res] = {};
    for (const [role, map, ext] of want) {
      const entry = map[res]?.[ext];
      if (!entry) throw new Error(`${mat.id}: no ${role} ${res} ${ext}`);
      const dest = path.join(dir, res, `${role}.${ext}`);
      const status = await downloadFile(entry.url, dest, entry.md5);
      meta.resolutions[res][role] = { file: path.relative(dir, dest).replaceAll('\\', '/'), url: entry.url, md5: entry.md5, size: entry.size };
      console.log(`  ${mat.key.padEnd(10)} ${res} ${role.padEnd(6)} ${status.padEnd(10)} ${mb(entry.size)}`);
    }
  }
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  return meta;
}

const only = process.argv.slice(2);
const list = only.length ? TEXTURES.filter((m) => only.includes(m.key)) : TEXTURES;
if (only.length && list.length !== only.length) {
  console.error(`Unknown material key. Known: ${TEXTURES.map((m) => m.key).join(', ')}`);
  process.exit(1);
}
console.log(`Fetching ${list.length} materials from Poly Haven into ${path.relative(ROOT, CACHE)}`);
for (const mat of list) {
  const meta = await fetchMaterial(mat);
  console.log(`${mat.key}: ${meta.name} (${mat.id}), ${meta.dimensionsMm.width} x ${meta.dimensionsMm.height} mm${meta.dimensionsNote ? ` [${meta.dimensionsNote}]` : ''}`);
}
console.log('Done.');
