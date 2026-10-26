/** 图标配置侦查。 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';

console.log('=== AppScope/app.json5 ===');
console.log(readFileSync('G:/hmh-desktop/apps/ohos/AppScope/app.json5', 'utf8').slice(0, 500));
console.log('=== module.json5 icon/label ===');
const m = readFileSync('G:/hmh-desktop/apps/ohos/entry/src/main/module.json5', 'utf8');
console.log(m.split('\n').filter((l) => /icon|label/i.test(l)).join('\n').slice(0, 500));
for (const d of ['G:/hmh-desktop/apps/ohos/entry/src/main/resources/base/media', 'G:/hmh-desktop/apps/ohos/AppScope/resources/base/media']) {
  try {
    console.log('=== ' + d.split('/').slice(-3).join('/') + ' ===');
    for (const f of readdirSync(d)) console.log(' ', f, statSync(`${d}/${f}`).size + 'b');
  } catch { console.log('(none):', d); }
}
console.log('=== brand icon (windows) ===');
console.log('build/icon.png:', existsSync('G:/hmh-desktop/apps/desktop/build/icon.png') ? statSync('G:/hmh-desktop/apps/desktop/build/icon.png').size + 'b' : 'missing');
