# RESUME-STATE-V2 · 鸿蒙版 v2 · 棒 V2-3 收棒(矩阵纯逻辑层)

> 前棒:V2-2(P0 三件套,commit 22fc379)。本棒=矩阵 20 项之纯逻辑地基,ArkTS 侧未动。

## 本棒完成 ✅(代码层,未装机)
**矩阵纯逻辑三模块 + 单测,全量 52/52 绿**(`node --import tsx --test tests/*.test.ts`):
1. `tests/turn-items.ts`(+test 9/9)——矩阵#1 工具折叠卡/#2 交付物卡/#3 回合汇总的归约:
   - tool→running 卡;toolResult 回填 ok/error;同名聚合;迟到 result 补终态卡
   - final→turnSum 卡(`N 回合 · N 次工具 · N tokens`,tokens null 不显示)+write 类工具出交付物卡
   - busy:true(run 开始)清空条目
2. `tests/session-list.ts`(+test 5/5)——矩阵#5 工作区分组/#6 收藏置顶/#7 状态过滤:
   - groupByWorkspace(组内 pin 置顶+时间降序;组间含 pin 组优先);applyFilter(all/running/done/failed);toggleGroup 折叠
3. `tests/i18n-dict.ts`(+test 4/4)——矩阵#18 i18n:zh/en 双语 ~70 键(语义 1:1 抄 desktop i18n.ts 子集);pickLocale(zh*→zh);dictKeysMatch 键集一致性校验

## 本棒新增的关键契约事实(server.ts 实读,下棒直接用)
- LAN broadcast 字段:L547-558/584:
  - `tool {name,args,sessionId}`;`toolResult {name,isError,preview(300 截断),full,sessionId}`
  - `delta {kind,chunk,sessionId}`;`final {text,sessionId,runId,turns,toolUses,usage,turnsInThread}`
  - `approvalReq {name,args,sessionId}`(**无 approvalId**,LAN 模式 approve 按 session 定位 pending——V1 已实现)
  - `error {message,sessionId}`;`busy {busy,task,mode,sessionId,cwd,runId}`
- **artifact 事件仅 desktop 桥**(L589 if(desktop)),LAN 无 → 交付物卡=write 类工具近似(方案 B 已批,turn-items 已实现)
- desktop i18n.ts 共 576 行,已抄子集入 i18n-dict.ts;蓝本余下词条(dock.remote*/settings.provider 细项)按需再抄

## 下棒(按 Zode 棒3令序,ArkTS 同构)⬜
1. **ArkTS 同构三件**:`model/TurnItems.ets`(抄 turn-items.ts,Map→ArkTS 兼容写法)、`model/I18n.ets`(抄 i18n-dict.ts + @ohos.i18n 系统语言)、`model/SessionList.ets`(抄 session-list.ts)
2. **Reducer.ets 扩展**:tool/toolResult/final/busy 事件喂入 TurnItemsState;ChatMessage 增条目渲染(工具折叠卡=默认折叠行+展开;交付物卡=relPath+tool;turnSum=汇总行)
3. **SessionsPage.ets 重构列表**:分组组头(wsGroupLabel)+收藏★+过滤条(四 Segment)+加载更多(#8);pin/archive/delete/export 按钮调 /api/session/*(V1 ApiClient 已有部分)
4. 每批:build→deploy.mjs(--skip-build 可选)→dump/截图→ACCEPTANCE-V2.md 该行更新
5. 后续序:总览/日志页签(WorkspacesPage 扩展)→主题(#17,@ohos.app.ability ConfigurationConstant)→模型选择/审批模式/Provider(设置页扩展,调 /api/state 的 models+config)→@文件引用(#16)→通知(#19 approvalReq→notificationManager,点击拉起)→相册图片(#20)
6. **ACCEPTANCE-V2.md 开档**(V2-2 遗留):门 A 证据已有(重启对比+deploy.mjs+自动重连);本棒纯逻辑 52/52 记入门 B 首行

## 环境事实(承 V2-2,仍有效)
- VM 重启后坐标整体左移 ~150px,**操作前必重新 dump**;锁屏 PIN 后 unlock 须点"登录"
- deploy.mjs 全链可用(HMH_HDC_TARGET 覆盖;全程无 token)
- token 零落盘纪律:hilog 复查在每棒装机后

## 纪律
禁改 hmharness/apps-desktop;测试先行;每项举证;诚实条款。
