/** 提取 docx 正文文本(word/document.xml → 纯文本),用于计划核对。 */
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';

const dir = 'E:/个人文档/HMH Desktop开发文档/HMH_v0.23.33_全面审核_HMHDesktop方案_技术开发提示词文档包';
const files = readdirSync(dir).filter((f) => f.endsWith('.docx'));
console.log('docs:', files.join(' | '));
for (const f of files) {
  const tmp = mkdtempSync('hmh-doc-');
  execFileSync('tar', ['-xf', join(dir, f), '-C', tmp, 'word/document.xml']);
  const xml = readFileSync(join(tmp, 'word/document.xml'), 'utf8');
  // w:p → 段落;w:t → 文本
  const text = xml
    .replace(/<w:p[ >]/g, '\n<w:p ')
    .replace(/<w:tab[^>]*\/>/g, '  ')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .split('\n').map((l) => l.trim()).filter((l) => l !== '').join('\n');
  const out = `docx-${f}.txt`;
  // Windows 临时目录在 C:;输出到当前仓
  const { writeFileSync } = await import('node:fs');
  writeFileSync(out, text, 'utf8');
  console.log(`${f}: ${text.length} chars → ${out}`);
}
