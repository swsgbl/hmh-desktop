/** 下载 DSH hero 截图。 */
import { writeFileSync, mkdirSync } from 'node:fs';
const r = await fetch('https://raw.githubusercontent.com/dataelement/dsh-desktop/main/docs/images/dsh-desktop-hero-v021.png');
if (!r.ok) { console.log('HTTP', r.status); process.exit(1); }
const b = Buffer.from(await r.arrayBuffer());
mkdirSync('G:/hmh-desktop/evidence/dsh', { recursive: true });
writeFileSync('G:/hmh-desktop/evidence/dsh/dsh-hero.png', b);
console.log('saved', b.byteLength, 'bytes');
