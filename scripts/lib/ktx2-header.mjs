// Tiny KTX2 header + basic Data Format Descriptor reader, used to verify encoder output.
// Spec: https://registry.khronos.org/KTX/specs/2.0/ktxspec.v2.html

const IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
const SUPERCOMPRESSION = { 0: 'none', 1: 'BasisLZ', 2: 'Zstandard', 3: 'ZLIB' };
const COLOR_MODEL = { 160: 'ASTC', 163: 'ETC1S', 166: 'UASTC', 1: 'RGBSDA' };
const TRANSFER = { 1: 'linear', 2: 'srgb' };
const PRIMARIES = { 0: 'unspecified', 1: 'bt709' };

/** @param {Uint8Array} buf */
export function readKtx2Header(buf) {
  for (let i = 0; i < IDENTIFIER.length; i++) {
    if (buf[i] !== IDENTIFIER[i]) throw new Error('Not a KTX2 file (bad identifier)');
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u32 = (o) => dv.getUint32(o, true);
  const header = {
    vkFormat: u32(12),
    typeSize: u32(16),
    width: u32(20),
    height: u32(24),
    depth: u32(28),
    layers: u32(32),
    faces: u32(36),
    levels: u32(40),
    supercompression: SUPERCOMPRESSION[u32(44)] ?? `unknown(${u32(44)})`,
  };
  const dfdOffset = u32(48);
  const kvdOffset = u32(56);
  const kvdLength = u32(60);
  // Basic DFD block starts after the 4-byte dfdTotalSize and the 8-byte block header.
  const b = dfdOffset + 4 + 8;
  header.colorModel = COLOR_MODEL[buf[b]] ?? `model(${buf[b]})`;
  header.colorPrimaries = PRIMARIES[buf[b + 1]] ?? `primaries(${buf[b + 1]})`;
  header.transferFunction = TRANSFER[buf[b + 2]] ?? `tf(${buf[b + 2]})`;
  // Key/value data: [u32 length][key\0value] padded to 4 bytes.
  const kv = {};
  let p = kvdOffset;
  while (p < kvdOffset + kvdLength) {
    const len = u32(p);
    const bytes = buf.subarray(p + 4, p + 4 + len);
    const nul = bytes.indexOf(0);
    const key = new TextDecoder().decode(bytes.subarray(0, nul));
    let val = bytes.subarray(nul + 1);
    if (val.length && val[val.length - 1] === 0) val = val.subarray(0, val.length - 1);
    kv[key] = new TextDecoder().decode(val);
    p += 4 + len;
    p += (4 - (p % 4)) % 4;
  }
  header.keyValue = kv;
  return header;
}
