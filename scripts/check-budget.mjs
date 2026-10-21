// P7 download budget: the initial download for each starting tier must stay under 25 MB
// (JS, CSS, fonts, transcoder, HDR, backplate and every texture for that tier).
// Run after `npm run build`. Exits non-zero when a tier is over budget.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIST = process.argv[2] ?? 'dist';
const LIMIT = 25 * 1000 * 1000;
const size = (p) => statSync(join(DIST, p)).size;
const assets = readdirSync(join(DIST, 'assets'));
const shell =
  size('index.html') +
  assets
    .filter((f) => /\.(js|css|wasm)$/.test(f) || (f.endsWith('.woff2') && f.includes('latin') && !f.includes('ext')))
    .reduce((a, f) => a + size(join('assets', f)), 0);
const manifest = JSON.parse(readFileSync(join(DIST, 'textures', 'manifest.json'), 'utf8'));
const materials = Object.values(manifest.materials);
const texBytes = (res) =>
  materials.reduce((a, m) => {
    const r = m.resolutions.includes(res) ? res : '1k';
    return a + m.files[r].totalBytes;
  }, 0);
const hdr = size('hdri/env-1k.hdr') + size('hdri/sun.json') + size('textures/manifest.json');
const tiers = [
  ['Low (any device)', '1k', '2k'],
  ['Medium mobile', '1k', '2k'],
  ['Medium desktop', '2k', '4k'],
  ['High mobile', '2k', '2k'],
  ['High desktop (before 4K hero sets)', '2k', '4k'],
];
let ok = true;
const mb = (b) => `${(b / 1e6).toFixed(2)} MB`;
console.log(`app shell (html, js, css, wasm, latin font): ${mb(shell)}`);
for (const [name, res, plate] of tiers) {
  const total = shell + hdr + size(`hdri/backplate-${plate}.jpg`) + texBytes(res);
  const pass = total < LIMIT;
  ok &&= pass;
  console.log(`${pass ? 'ok  ' : 'OVER'} ${name.padEnd(36)} ${mb(total)} (textures ${res}, backplate ${plate})`);
}
process.exit(ok ? 0 : 1);
