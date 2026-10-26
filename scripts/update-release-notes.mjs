/** 把详细说明写入 v0.2.6 release notes。 */
import { readFileSync, writeFileSync } from 'node:fs';

// gh release edit 的 --notes 从文件读不如直接传参;写一个临时 ps1 不如走 gh 的 --notes-file
const notes = readFileSync('G:/hmh-desktop/.hm-tmp/release-notes-v026.md', 'utf8');
writeFileSync('G:/hmh-desktop/.hm-tmp/release-notes-body.md', notes, 'utf8');
console.log('body ready,', notes.length, 'chars');
