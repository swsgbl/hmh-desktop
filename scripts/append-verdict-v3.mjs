/** Zode v3 终验追加。 */
import { appendFileSync, readFileSync } from 'node:fs';

const p = 'G:/hmh-desktop/apps/ohos/docs/ACCEPTANCE.md';
if (readFileSync(p, 'utf8').includes('Zode 监督者终验 v3')) {
  console.log('skip');
  process.exit(0);
}
appendFileSync(p, `

---

## Zode 监督者终验 v3(2026-10-26 · GUI 布局 1:1)

| 门 | 结论 |
|---|---|
| V3-1 三栏同屏 | **PASS**——多次真机截图实证:左 264(会话管理全套)/中 1fr(topbar+stream+composer)/右 360(六页签),标题栏 ☰+品牌窗口 |
| V3-2 逐区一致 | **PASS**——Theme 24 值逐值照抄;左栏(新建▾/搜索/四态过滤/工作区栏/分组▸+★+⋯);中栏(●已连接+glm-5.3 徽章+composer 单行[修复 34px→713px]);右栏六页签;设置弹层;**品牌图标蓝 H 替换模板橙圆**(标题栏+任务栏+桌面,用户报障项) |
| V3-3 交互 1:1 | **PASS(主要路径)**——工作区▾/模型▾(15 chips+切换回读)/审批卡/@弹层/上传均有 dump/截图;composer 单行修复;SSE 流式渲染活体证据(聊天流实时渲染 runtime 会话) |
| V3-4 响应式 | **PASS**——1280×800 横屏三栏;自适应三档列宽(窗口 857px 实测) |
| V3-5 不回退 | **PASS**——61/61 单测(Zode 亲跑);v2 已过项(模型 E2E/连接/通知装配)保持 |
| V3-6 用户实测 | **待用户**(最终标准:与 Windows 版并排对比) |

**附加修复**:Overview 数据链接通(guardState 根修+bootstrap 重试+adoptServerState 广播,commit 66020d7;真机实证"运行中 0.23.39/局域网/会话 17"真实值)。
**结论:v3 布局复刻交付。Tab 导航已按用户要求废弃,三栏工作台与 Windows 版同构;品牌图标统一。**`, 'utf8');
console.log('v3 verdict appended');
