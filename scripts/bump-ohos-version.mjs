/** 改 ohos versionName。 */
import { readFileSync, writeFileSync } from 'node:fs';
const v = process.argv[2];
let s = readFileSync('G:/hmh-desktop/apps/ohos/AppScope/app.json5', 'utf8');
s = s.replace(/"versionName": "[^"]+"/, `"versionName": "${v}"`);
writeFileSync('G:/hmh-desktop/apps/ohos/AppScope/app.json5', s, 'utf8');
console.log('versionName →', s.match(/"versionName": "[^"]+"/)[0]);
