/**
 * HAP 降版重打包:SDK26 产物 → API23 VM 可装
 * 改 pack.info 的 apiVersion.compatible/target + module.json 的 minAPIVersion/targetAPIVersion
 * (配方源自 hm-parity v1: 自写 zip 解析器, entries 全 STORE)
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const src = process.argv[2]
const dst = process.argv[3]

// ---- 最小 zip 读写 ----
function parseZip(buf) {
  const entries = []
  // 找 EOCD
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('no EOCD')
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('bad central dir at ' + off)
    const method = buf.readUInt16LE(off + 10)
    const csize = buf.readUInt32LE(off + 20)
    const usize = buf.readUInt32LE(off + 24)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const lho = buf.readUInt32LE(off + 42)
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8')
    entries.push({ name, method, csize, usize, lho })
    off += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

function readEntry(buf, e) {
  const lho = e.lho
  if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error('bad LHO')
  const nameLen = buf.readUInt16LE(lho + 26)
  const extraLen = buf.readUInt16LE(lho + 28)
  const dataStart = lho + 30 + nameLen + extraLen
  const raw = buf.slice(dataStart, dataStart + e.csize)
  if (e.method === 0) return raw
  if (e.method === 8) return zlib.inflateRawSync(raw)
  throw new Error('method ' + e.method)
}

function writeZip(items) {
  // items: {name, data(Buffer)} 全 STORE
  const chunks = []
  const central = []
  let offset = 0
  const now = 0x0000 // dos time
  for (const it of items) {
    const nameB = Buffer.from(it.name, 'utf8')
    const crc = crc32(it.data)
    const lho = Buffer.alloc(30)
    lho.writeUInt32LE(0x04034b50, 0)
    lho.writeUInt16LE(20, 4)       // version needed
    lho.writeUInt16LE(0, 6)        // flags
    lho.writeUInt16LE(0, 8)        // method STORE
    lho.writeUInt16LE(now, 10)     // time
    lho.writeUInt16LE(0x21, 12)    // date
    lho.writeUInt32LE(crc, 14)
    lho.writeUInt32LE(it.data.length, 18)
    lho.writeUInt32LE(it.data.length, 22)
    lho.writeUInt16LE(nameB.length, 26)
    lho.writeUInt16LE(0, 28)
    chunks.push(lho, nameB, it.data)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)        // version made by
    cd.writeUInt16LE(20, 6)        // version needed
    cd.writeUInt16LE(0, 8)
    cd.writeUInt16LE(0, 10)        // method
    cd.writeUInt16LE(now, 12)
    cd.writeUInt16LE(0x21, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(it.data.length, 20)
    cd.writeUInt32LE(it.data.length, 24)
    cd.writeUInt16LE(nameB.length, 28)
    // extra/comment/disk/attr = 0
    cd.writeUInt32LE(offset, 42)
    central.push(cd, nameB)

    offset += 30 + nameB.length + it.data.length
  }
  const cdStart = offset
  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(items.length, 8)
  eocd.writeUInt16LE(items.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(cdStart, 16)
  return Buffer.concat([...chunks, cdBuf, eocd])
}

let CRC_TABLE = null
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
      CRC_TABLE[n] = c
    }
  }
  let crc = -1
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

// ---- main ----
const buf = fs.readFileSync(src)
const entries = parseZip(buf)
const items = []
let patched = []
for (const e of entries) {
  let data = readEntry(buf, e)
  if (e.name === 'pack.info') {
    let s = data.toString('utf8')
    s = s.replace(/"compatible"\s*:\s*\d+/, '"compatible": 23')
      .replace(/"target"\s*:\s*\d+/, '"target": 23')
      .replace(/"releaseType"\s*:\s*"[^"]*"/, '"releaseType": "Release"')
    data = Buffer.from(s, 'utf8')
    patched.push(e.name + ' → compatible/target 23')
  }
  if (e.name.endsWith('module.json')) {
    let s = data.toString('utf8')
    s = s.replace(/"minAPIVersion"\s*:\s*\d+/, '"minAPIVersion": 60101023')
      .replace(/"targetAPIVersion"\s*:\s*\d+/, '"targetAPIVersion": 60101023')
    data = Buffer.from(s, 'utf8')
    patched.push(e.name + ' → APIVersion 60101023')
  }
  items.push({ name: e.name, data })
}
fs.writeFileSync(dst, writeZip(items))
console.log('repacked →', dst)
console.log(patched.join('\n'))
console.log('entries:', items.length)
