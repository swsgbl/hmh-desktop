/**
 * 纯 node PNG 编解码(zlib + 手写 filter/反 filter)——视觉回归管线自用,零第三方依赖。
 * 解码支持:8-bit、非隔行、color type 0(灰)/2(RGB)/3(调色板)/4(灰+α)/6(RGBA),统一输出 RGBA。
 * 编码:RGBA、filter 0(None)、deflate level 6。capturePage 的 PNG 均在支持范围内。
 */
import { deflateSync, inflateSync } from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** PNG → { width, height, data: RGBA Uint8Array }。不支持的变体抛错(带明确信息)。 */
export function decodePng(buf) {
  if (!(buf.length >= 8) || !buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG (bad signature)');
  let off = 8;
  let width = 0, height = 0, bitDepth = -1, colorType = -1, interlace = -1;
  let palette = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth} (need 8)`);
  if (interlace !== 0) throw new Error('unsupported interlaced PNG (need Adam7 off)');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (channels === undefined) throw new Error(`unsupported PNG color type ${colorType}`);
  if (colorType === 3 && palette === null) throw new Error('palette PNG without PLTE chunk');
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    for (let i = 0; i < stride; i++) {
      const x = raw[p + i];
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: {
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`bad PNG filter type ${filter}`);
      }
      cur[i] = v & 0xff;
    }
    p += stride;
    for (let x2 = 0; x2 < width; x2++) {
      const o = (y * width + x2) * 4;
      if (colorType === 6) { out[o] = cur[x2 * 4]; out[o + 1] = cur[x2 * 4 + 1]; out[o + 2] = cur[x2 * 4 + 2]; out[o + 3] = cur[x2 * 4 + 3]; }
      else if (colorType === 2) { out[o] = cur[x2 * 3]; out[o + 1] = cur[x2 * 3 + 1]; out[o + 2] = cur[x2 * 3 + 2]; out[o + 3] = 255; }
      else if (colorType === 0) { out[o] = out[o + 1] = out[o + 2] = cur[x2]; out[o + 3] = 255; }
      else if (colorType === 4) { out[o] = out[o + 1] = out[o + 2] = cur[x2 * 2]; out[o + 3] = cur[x2 * 2 + 1]; }
      else { const pi = cur[x2] * 3; out[o] = palette[pi]; out[o + 1] = palette[pi + 1]; out[o + 2] = palette[pi + 2]; out[o + 3] = 255; }
    }
    const t = prev; prev = cur; cur = t;
  }
  return { width, height, data: out };
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** RGBA { width, height, data } → PNG Buffer(RGBA、filter 0)。 */
export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter None
    for (let i = 0; i < stride; i++) raw[y * (stride + 1) + 1 + i] = rgba[y * stride + i];
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
