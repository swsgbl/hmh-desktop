/** Zode v4(鸿蒙)终验追加。 */
import { appendFileSync, readFileSync } from 'node:fs';

const p = 'G:/hmh-desktop/apps/ohos/docs/ACCEPTANCE.md';
if (readFileSync(p, 'utf8').includes('Zode 监督者终验 v4')) {
  console.log('skip');
  process.exit(0);
}
appendFileSync(p, `

---

## Zode 监督者终验 v4(DSH 设计语言 · 鸿蒙 · 2026-10-26)

| 门 | 结论 |
|---|---|
| D1 浅色全局 | **PASS**——真机截图(evidence/ohos/ohos-check.jpeg):浅色分层底/白卡片/无深色残留;智能体另做像素色彩矩阵采样自验(全浅色系值) |
| D2 组件合规 | **PASS(抽验)**——胶囊按钮(新建会话/时间筛选 pill)/白卡片浮层/品牌蓝;逐 token 全查以 evidence/dsh/src/alias-theme.css 为准可追溯 |
| D3 深色主题 | **装配**(alias 换值结构就绪;切换即时性未单独截图——如实) |
| D4 不回退 | **PASS**——61/61 单测(Zode 亲跑);三栏结构/v2v3 功能保持;连接修复实证(已连接 0.23.39/18 会话加载) |
| D5 纪律 | **PASS**——token 安全复审零泄漏;IP 漂移如实登记+修复通道(--ps hmhUrl) |
| D6 用户实测 | **待用户**(最终标准) |

**结论:鸿蒙版 v4 交付(commit 99d4bb4)。附:连接故障根因=PC LAN IP 漂移(161.1→8.3,非代码 bug),已修+运维通道建立。**`, 'utf8');
console.log('v4-ohos verdict appended');
