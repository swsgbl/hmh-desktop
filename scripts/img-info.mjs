/** 图片信息。 */
import { readFileSync, writeFileSync } from 'node:fs';
const b = readFileSync('G:/hmh-desktop/evidence/dsh/dsh-hero.png');
writeFileSync('G:/hmh-desktop/.hm-tmp/imginfo.txt', `size=${b.length} dims=${b.readUInt32BE(16)}x${b.readUInt32BE(20)}\n`, 'utf8');
console.log('ok');
