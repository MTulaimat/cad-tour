// Minimal Radiance RGBE (.hdr) reader and writer.
// Reader: flat and new-style (adaptive) RLE scanlines, standard "-Y H +X W" orientation
// (what Poly Haven ships). Writer: new-style RLE, same orientation.

/**
 * @param {Uint8Array} buf
 * @returns {{ width: number, height: number, data: Float32Array, rgbe: Uint8Array, header: string[] }}
 *   data is width*height*3 linear RGB, row 0 = top of the image (zenith for an equirect).
 *   rgbe is the raw width*height*4 RGBE bytes (same order), for lossless rewrites.
 */
export function readRGBE(buf) {
  let pos = 0;
  const readLine = () => {
    let s = '';
    while (pos < buf.length && buf[pos] !== 0x0a) s += String.fromCharCode(buf[pos++]);
    pos++; // skip \n
    return s;
  };

  const magic = readLine();
  if (!magic.startsWith('#?')) throw new Error('Not a Radiance HDR file (missing #? header)');
  const header = [magic];
  let format = '';
  for (;;) {
    const line = readLine();
    if (line === '') break;
    header.push(line);
    if (line.startsWith('FORMAT=')) format = line.slice(7).trim();
    if (pos >= buf.length) throw new Error('Unexpected end of header');
  }
  if (format && format !== '32-bit_rle_rgbe') throw new Error(`Unsupported HDR format ${format}`);
  const res = readLine().trim().split(/\s+/);
  if (res.length !== 4 || res[0] !== '-Y' || res[2] !== '+X') {
    throw new Error(`Unsupported HDR orientation "${res.join(' ')}" (only -Y H +X W)`);
  }
  const height = parseInt(res[1], 10);
  const width = parseInt(res[3], 10);
  const rgbe = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    const isNewRle =
      width >= 8 && width < 32768 && buf[pos] === 2 && buf[pos + 1] === 2 && (buf[pos + 2] & 0x80) === 0;
    if (isNewRle) {
      const w = (buf[pos + 2] << 8) | buf[pos + 3];
      if (w !== width) throw new Error(`Scanline width mismatch at row ${y}`);
      pos += 4;
      for (let c = 0; c < 4; c++) {
        let x = 0;
        while (x < width) {
          let count = buf[pos++];
          if (count > 128) {
            count -= 128;
            if (x + count > width) throw new Error(`Bad RLE run at row ${y}`);
            const v = buf[pos++];
            for (let i = 0; i < count; i++) rgbe[row + (x++) * 4 + c] = v;
          } else {
            if (count === 0 || x + count > width) throw new Error(`Bad RLE dump at row ${y}`);
            for (let i = 0; i < count; i++) rgbe[row + (x++) * 4 + c] = buf[pos++];
          }
        }
      }
    } else {
      // Flat (uncompressed) scanline. Old-style RLE is not supported (never used by modern tools).
      rgbe.set(buf.subarray(pos, pos + width * 4), row);
      pos += width * 4;
    }
  }
  if (pos > buf.length) throw new Error('Truncated HDR pixel data');
  return { width, height, data: decodeRGBE(rgbe), rgbe, header };
}

/** Same decode as three's HDRLoader (mantissa * 2^(e-128) / 255), so values match PMREM's input. */
export function decodeRGBE(rgbe) {
  const n = rgbe.length / 4;
  const data = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const e = rgbe[i * 4 + 3];
    if (e === 0) continue;
    const f = Math.pow(2, e - 128) / 255;
    data[i * 3] = rgbe[i * 4] * f;
    data[i * 3 + 1] = rgbe[i * 4 + 1] * f;
    data[i * 3 + 2] = rgbe[i * 4 + 2] * f;
  }
  return data;
}

/** Encode one linear RGB value to RGBE bytes (inverse of decodeRGBE). */
export function encodeRGBEPixel(r, g, b, out, o) {
  const v = Math.max(r, g, b);
  if (!(v > 1e-32)) {
    out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
    return;
  }
  // Smallest exponent with v <= 2^e, so the largest channel's mantissa is <= 255.
  let e = Math.ceil(Math.log2(v));
  if (v > Math.pow(2, e)) e++;
  e = Math.max(-128, Math.min(127, e));
  const s = 255 / Math.pow(2, e);
  out[o] = Math.min(255, Math.round(r * s));
  out[o + 1] = Math.min(255, Math.round(g * s));
  out[o + 2] = Math.min(255, Math.round(b * s));
  out[o + 3] = e + 128;
}

/**
 * Write raw RGBE bytes as an RLE Radiance file.
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgbe width*height*4
 * @param {string[]} [extraHeader] extra header lines (e.g. comments starting with '#')
 */
export function writeRGBE(width, height, rgbe, extraHeader = []) {
  const head = ['#?RADIANCE', ...extraHeader, 'FORMAT=32-bit_rle_rgbe', '', `-Y ${height} +X ${width}`, ''].join('\n');
  const chunks = [Buffer.from(head, 'latin1')];
  const line = new Uint8Array(width);
  for (let y = 0; y < height; y++) {
    const out = [2, 2, width >> 8, width & 255];
    for (let c = 0; c < 4; c++) {
      for (let x = 0; x < width; x++) line[x] = rgbe[(y * width + x) * 4 + c];
      let x = 0;
      while (x < width) {
        // find a run of >= 3 identical bytes starting at x
        let run = 1;
        while (x + run < width && run < 127 && line[x + run] === line[x]) run++;
        if (run >= 3) {
          out.push(128 + run, line[x]);
          x += run;
          continue;
        }
        // literal dump until the next run of >= 3 (max 128)
        let end = x;
        while (end < width && end - x < 128) {
          if (end + 2 < width && line[end] === line[end + 1] && line[end] === line[end + 2]) break;
          end++;
        }
        if (end === x) end = Math.min(width, x + 1);
        out.push(end - x);
        for (let i = x; i < end; i++) out.push(line[i]);
        x = end;
      }
    }
    chunks.push(Buffer.from(out));
  }
  return Buffer.concat(chunks);
}
