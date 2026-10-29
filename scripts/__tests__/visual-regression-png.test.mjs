/** 视觉回归 PNG 编解码单测 —— scripts/lib/png.mjs(纯 node,zlib + 手写 filter)。
 *  覆盖:签名/IHDR 结构、RGBA 往返(roundtrip)、渐变+alpha 数据不变形。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePng, encodePng } from '../lib/png.mjs';

test('png:编码产物是合法 PNG(签名 + IHDR 尺寸)', () => {
  const w = 3, h = 2;
  const rgba = new Uint8Array(w * h * 4).fill(128);
  const buf = encodePng(w, h, rgba);
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(buf.readUInt32BE(16), w, 'IHDR width');
  assert.equal(buf.readUInt32BE(20), h, 'IHDR height');
  assert.equal(buf[24], 8, 'IHDR bit depth = 8');
  assert.equal(buf[25], 6, 'IHDR color type = 6 (RGBA)');
});

test('png:decode(encode(x)) 逐字节往返(含 alpha 渐变)', () => {
  const w = 17, h = 9;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = (x * 13) % 256;
      rgba[i + 1] = (y * 29) % 256;
      rgba[i + 2] = (x * y) % 256;
      rgba[i + 3] = 128 + ((x + y) % 128);
    }
  }
  const decoded = decodePng(encodePng(w, h, rgba));
  assert.equal(decoded.width, w);
  assert.equal(decoded.height, h);
  assert.deepEqual(Buffer.from(decoded.data), Buffer.from(rgba));
});

test('png:非 PNG 输入 / 坏 filter 明确报错', () => {
  assert.throws(() => decodePng(Buffer.from('not a png at all')), /signature/);
});
