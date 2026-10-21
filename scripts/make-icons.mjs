// Generates the app icons in public/icons from one SVG (run once; the PNGs are committed).
import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';

const mark = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffb547"/>
      <stop offset="1" stop-color="#f08a4b"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="${pad ? 0 : 112}" fill="url(#g)"/>
  <g transform="translate(256 262) scale(${pad ? 0.72 : 0.86}) translate(-256 -262)" fill="none" stroke="#1b1d21" stroke-width="30" stroke-linejoin="round" stroke-linecap="round">
    <path d="M120 236 L256 128 L392 236 V392 H120 Z"/>
    <path d="M120 300 H220 V392"/>
    <path d="M292 392 V300 H392"/>
    <path d="M256 236 V300"/>
  </g>
</svg>`;

mkdirSync('public/icons', { recursive: true });
writeFileSync('public/icons/icon.svg', mark(false));
const jobs = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
  ['apple-touch-icon.png', 180, true],
  ['favicon-32.png', 32, false],
];
for (const [name, size, pad] of jobs) {
  await sharp(Buffer.from(mark(pad))).resize(size, size).png({ compressionLevel: 9 }).toFile(`public/icons/${name}`);
  console.log('wrote', name);
}
