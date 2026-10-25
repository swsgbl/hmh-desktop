# RESUME-STATE · HMH Desktop 鸿蒙版(棒 2 收棒 · 2026-10-25 · commit 195c36b)

> **唯一真相**。棒 2 已完成:全量代码+构建+装机+启动验证。**棒 3 只剩:app 内 E2E 真任务流转+补 2 张截图+补 ACCEPTANCE 门 4/5。**

## 1. 棒 2 战果 ✅(commit 195c36b)
- **门 1** 单测 27/27 全绿:`cd /d G:\hmh-desktop && node --import tsx --test apps/ohos/tests/*.test.ts`
- **门 2** BUILD SUCCESSFUL,产物 `apps/ohos/entry/build/default/outputs/default/entry-default-unsigned.hap`
- **门 3** VM 装机成功+启动:降版重打包(apiVersion 26→23)→VM 双签→bm install OK→aa start OK
  - 证据:`evidence/ohos/hmh-launch1.json`(布局 dump)、`shot-home.jpeg`(会话页截图,"未配置"状态正常)
- **门 6** ACCEPTANCE.md 已写:`apps/ohos/docs/ACCEPTANCE.md`(门 4/5 标 PARTIAL)
- 服务端探针:7788 在线,鉴权墙正常(错 key→auth-required)

## 2. 棒 3 待办(唯一重点)⬜
1. **E2E 真任务**(门 4):
   - token:现场 `node -e "console.log(JSON.parse(require('fs').readFileSync('C:/Users/hongfu/.hmharness/config.json','utf8')).web.token)"` 读到**内存/剪贴板即可,禁止写文件**
   - VM 操作:app 设置页填 `http://192.168.161.1:7788` + token → 保存 → 测试连接(应显 daemon 版本/模型)
   - 会话页:新建会话 → 输入简单任务(如"用一句话介绍你自己") → 发送(mode=ask) → 观察 SSE delta 流式+final 收尾
   - 截图×2:聊天流界面、(若触发)审批卡;存 `evidence/ohos/shot-chat.jpeg` 等
   - uinput 注意:先 `aa start -a EntryAbility -b com.hmh.desktop.ohos` 唤前台再 dump/点击(VM 多窗口层叠坑)
2. 若验收要求限流/50 连发:未实现,如实报 partial
3. 更新 ACCEPTANCE.md 门 4/5 → 全 PASS,简报 Zode

## 3. 一键复用链(全部已验证)🔧
- 构建:`cd /d G:\hmh-desktop\apps\ohos && hvigorw.bat assembleHap --mode module -p product=default -p buildMode=debug --no-daemon`
- 降版:`node G:\hmh-desktop\.hm-tmp\hm-patch-hap23.cjs <unsigned.hap> <out.hap>`
- 推送+签+装(VM 192.168.161.137:10178):
  ```
  hdc -t 192.168.161.137:10178 file send <out.hap> /data/local/tmp/entry-api23-unsigned.hap
  hdc -t 192.168.161.137:10178 shell "sh /data/local/tmp/vm-sign23.sh"   # hmh-profile.p7b 已在 VM 可复用
  ```
- 启动:`hdc -t 192.168.161.137:10178 shell "aa start -a EntryAbility -b com.hmh.desktop.ohos"`
- dump:`hdc -t 192.168.161.137:10178 shell "uitest dumpLayout -p /data/local/tmp/x.json"` + file recv
- 截图:`snapshot_display -f /data/local/tmp/x.jpeg` + file recv

## 4. 构建链命脉(勿动)⚠️
1. 工程内 `hvigorw.bat`(.cjs 因根 pkg type:module)
2. junction `apps\hvigor` & `apps\hvigor-ohos-plugin` → DevEco 真身(删除=构建死)
3. project_caches `3cbaca83...` workspace 内 package.json(6.26.4)+双 junction
4. `hvigor/hvigor-config.json5` = modelVersion 5.0.0 + deps {}
5. entry/ 有自己 build-profile.json5 + hvigorfile.ts(hapTasks)

## 5. 安全红线
token 只在内存;Text() 渲染外部串;审批权威在 runtime;禁改 hmharness/apps-desktop;.gitignore 已排除 .hvigor/ 与 entry/build/
