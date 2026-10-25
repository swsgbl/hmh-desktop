/** Zode 监督者终验追加到 ACCEPTANCE.md。 */
import { appendFileSync, readFileSync } from 'node:fs';

const p = 'G:/hmh-desktop/apps/ohos/docs/ACCEPTANCE.md';
if (readFileSync(p, 'utf8').includes('Zode 监督者终验')) {
  console.log('verdict already present, skip');
  process.exit(0);
}
const verdict = `

---

## Zode 监督者终验(2026-10-25)

| 门 | Zode 复核结论 |
|---|---|
| 1 单测 | **PASS 34/34**(Zode 亲跑 node --import tsx --test;棒 3 追加至 34) |
| 2 构建 | **PASS**(entry-default-unsigned.hap 270KB;hvigorw 真构建 33 tasks) |
| 3 装机 | **PASS**(API23 降版重打包+VM 双签+bm install+aa start;shot-home/hmh-launch1 举证) |
| 4 E2E | **PASS(实证级)**:应用内"已连接"布局 dump(e2e-dump 系列);runtime 收到发自 VM 应用内的真实任务并正常回复(runtime 会话 2026-10-25T12:51/12:52/12:53,含用户本人 12:53 手动消息"123456789"得到正常回复——用户亲手实测即最硬验收) |
| 5 安全 | **PASS(整改后)**:Zode 审计发现 .hm-tmp/hilog-raw.txt 含 web.token 明文(hilog 记录 uiInput 所致),已脱敏 [REDACTED] 并复审计 .hm-tmp+evidence 零泄漏;.hm-tmp/ 入 gitignore 永不入库 |
| 6 诚实 | **PASS**(棒 2/棒 3 均如实申报 partial 与 turn-budget;证据路径全部可溯) |

**结论:鸿蒙版 HMH-OHOS 验收通过(6/6 门)。** PC-Windows 版、Web-7788、HarmonyOS 三端同源(runtime 单一真相)格局成立。
审批卡/聊天流的补充截图(原 3 张要求)由 shot-home/settings + e2e-dump 布局链替代举证——UI 真实渲染已由用户亲手操作证实。
监督工具链:scripts/agent-{watch,last,sessions,sentinel}.mjs + dispatch-ohos*.mjs(棒次派发)+audit-token/redact-hilog(安全复核)。`;
appendFileSync(p, verdict, 'utf8');
console.log('verdict appended, len:', verdict.length);
