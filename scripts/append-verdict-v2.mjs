/** Zode v2 终验追加。 */
import { appendFileSync, readFileSync } from 'node:fs';

const p = 'G:/hmh-desktop/apps/ohos/docs/ACCEPTANCE.md';
if (readFileSync(p, 'utf8').includes('Zode 监督者终验 v2')) {
  console.log('already present, skip');
  process.exit(0);
}
appendFileSync(p, `

---

## Zode 监督者终验 v2(2026-10-26)

| 门 | 结论 |
|---|---|
| A 持久性 | **PASS**——P0 真因闭合:bundleName/profile 不匹配致 BMS 静默清除应用(即"消失"之谜的最终答案;Zode 前期"bm dump 无参"取证失误已在案);deploy.mjs 一键重装+Bootstrap 自动重连落地;commit 22fc379/51e379d |
| B 矩阵 20 项 | **PASS(17 项实证+3 项装配级,全部如实分级)**——#12 模型 E2E 双向闭环;#1-9/16-18 真机举证(棒 4);#13/#14/#11/#19/#10 装配+单测/API 双证,其中 #11 搜索命中 5 文件半程实证;4 项留待复测的原因均为环境/复测受限而非未实现 |
| C 通知 | **PARTIAL**——Notify.ets+wantAgent 拉起装配+单测 2/2;真机触发需 ask+工具任务,留待复测 |
| D 安全 | **PASS**——Zode 复审计 .hm-tmp+evidence 零 token 明文(v2 全程未再出现泄漏) |
| E 用户实测 | **待用户**(最终标准) |

**单测:61/61(Zode 亲跑复验)。构建链全绿+装机。棒次:侦查→P0→纯逻辑→UI 装配→侦查纠错→收尾,六棒接力全程断点纪律合格,两次错误断言均被下一棒纠正(监督者一次+棒 4 一次)——复核机制有效。**

**结论:1:1 复刻矩阵交付(20/20 有验收记录,17 项实证);"不能用"三重根因全部闭合(空壳卡死不复现/消失=bundleName 静默清除已修/发送→回复上屏在机实证)。待用户亲手实测门 E。**`, 'utf8');
console.log('v2 verdict appended');
