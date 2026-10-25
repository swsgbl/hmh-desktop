/** 从 hilog-raw.txt 脱敏 web.token(独立脚本,防 && 链静默失败)。 */
import { readFileSync, writeFileSync } from 'node:fs';

const home = process.env.HMH_HOME ?? `${process.env.USERPROFILE}/.hmharness`;
const cfg = JSON.parse(readFileSync(`${home}/config.json`, 'utf8'));
const tok = cfg?.web?.token ?? '';
console.log('token len:', tok.length);
const p = 'G:/hmh-desktop/.hm-tmp/hilog-raw.txt';
const t = readFileSync(p, 'utf8');
if (tok !== '' && t.includes(tok)) {
  writeFileSync(p, t.split(tok).join('[REDACTED]'));
  console.log('REDACTED: token 已替换为 [REDACTED]');
} else {
  console.log('完整 token 未出现;检查部分片段…');
  // hilog 可能记录了分段输入(uiInput 逐字符)——检查连续 6 字符片段
  let fragHits = 0;
  for (let i = 0; i + 6 <= tok.length; i++) {
    if (t.includes(tok.slice(i, i + 6))) fragHits += 1;
  }
  console.log('6 字符片段命中:', fragHits);
  if (fragHits > 0) {
    // 逐字符输入会让 token 以碎片散落;直接把含 token 字符的 uiInput 行整行脱敏
    const lines = t.split('\n').map((l) =>
      (tok.includes(l.match(/[a-z0-9]/i)?.[0] ?? '') || /uiInput|text\s*=/i.test(l)) && /[a-z0-9]{4,}/i.test(l) && !/http|127\.0\.0\.1|com\.hmh/.test(l)
        ? l.replace(/[a-zA-Z0-9-]{4,}/g, '[R]') : l);
    writeFileSync(p, lines.join('\n'));
    console.log('碎片模式:含输入行已整行脱敏');
  }
}
