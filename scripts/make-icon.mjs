/** 生成 HMH 品牌图标:圆角深色方块 + 白色 "H"。
 *  输出 build/icon.png(256,electron-builder 用)+ 托盘 16x16 的 base64 打印。 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function makePng(size) {
  const px = (x, y, r, g, b, a) => {
    const i = (y * size + x) * 4;
    raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; raw[i + 3] = a;
  };
  const raw = Buffer.alloc(size * size * 4);
  const radius = Math.round(size * 0.22);
  const bg = [27, 29, 33]; // --hmh-bg-raised
  const fg = [47, 129, 247]; // --hmh-accent
  const inRounded = (x, y) => {
    const cx = Math.min(Math.max(x, radius), size - 1 - radius);
    const cy = Math.min(Math.max(y, radius), size - 1 - radius);
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2 + 0.5;
  };
  // "H" 像素画(7x7 网格,粗 1.5 格),映射到 size
  const u = size / 12; // 1 单位
  const barW = Math.max(1, Math.round(u * 1.6));
  const x0 = Math.round(u * 2.6), x1 = Math.round(u * 8.4);
  const y0 = Math.round(u * 2.5), y1 = Math.round(u * 9.5);
  const midY0 = Math.round(u * 5.4), midY1 = Math.round(u * 6.6);
  const inH = (x, y) =>
    (x >= x0 && x < x0 + barW && y >= y0 && y < y1) ||
    (x >= x1 - barW && x < x1 && y >= y0 && y < y1) ||
    (x >= x0 && x < x1 && y >= midY0 && y < midY1);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (inRounded(x, y)) {
        const c = inH(x, y) ? fg : bg;
        px(x, y, c[0], c[1], c[2], 255);
      } else {
        px(x, y, 0, 0, 0, 0);
      }
    }
  }
  // PNG: filter=0 每行
  const stride = size * 4;
  const data = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    data[y * (stride + 1)] = 0;
    raw.copy(data, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(data)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync('apps/desktop/build', { recursive: true });
const big = makePng(256);
writeFileSync('apps/desktop/build/icon.png', big);
const small = makePng(16);
writeFileSync('apps/desktop/build/icon-tray.png', small);
console.log('icon.png 256x256:', big.length, 'bytes');
console.log('tray16 base64:');
console.log(small.toString('base64'));
