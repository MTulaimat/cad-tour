// Dev helper: tiles screenshots into one image for review.
// Usage: node scripts/contact-sheet.mjs <out.png> <columns> <tileWidth> <file...>
import sharp from 'sharp';

const [out, cols, tileW, ...files] = process.argv.slice(2);
const columns = Number(cols);
const w = Number(tileW);
const metas = await Promise.all(files.map((f) => sharp(f).metadata()));
const h = Math.round((w * metas[0].height) / metas[0].width);
const gap = 6;
const tiles = await Promise.all(files.map((f) => sharp(f).resize(w, h, { fit: 'cover' }).toBuffer()));
const rows = Math.ceil(files.length / columns);
await sharp({ create: { width: columns * (w + gap) - gap, height: rows * (h + gap) - gap, channels: 3, background: '#111' } })
  .composite(tiles.map((input, i) => ({ input, left: (i % columns) * (w + gap), top: Math.floor(i / columns) * (h + gap) })))
  .png()
  .toFile(out);
console.log('wrote', out);
