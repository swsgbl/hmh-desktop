# 鸿蒙版 · 开发提示词 v6(设备本地内核共享——桌面应用与 hmh CLI 同内核实证)

> 签发:Zode · 承接:hmharness 智能体 · 2026-10-26
> 用户问题:"深开鸿上桌面应用不能和 HMH TUI 共享一个本地内核 CLI 吗?"
> 答案:能——HAP 应用连哪个服务器只是配置;把 hmh 内核装进设备本机起 web,
> 应用切 127.0.0.1:7788 即与设备上的 hmh CLI/TUI **共享同一内核与 HMH_HOME**。
> 本任务把这个形态真正跑通并一键化。

## 任务

1. **设备端装 hmh**(VM 192.168.161.137:10178,KaihongOS 5.0 x86_64):
   - 配方=G:\hmharness\docs\KAIHONGOS.md(当年实测同款系统)+scripts/install-kaihongos.cjs;
   - 前提=设备上有任意 Node≥22:VM 若无,先探测系统 libc(glibc/musl)并推入匹配的
     node linux 二进制(x86_64,nodejs.org 官方 glibc 版或 musl 版,解压到 /data/local/hmh-node);
   - 跑一键安装器(可先推 install-kaihongos.cjs 进设备,用设备 node 执行;
     断网时安装器自带的内置版本集兜底);装完 `hmh --version` 应答。
2. **设备上起 web 服务**:写好设备侧 config(复制 PC 的 provider 配置含密钥——
   **密钥只经 hdc 推送落设备 /data/local/home/.hmharness/config.json,不进任何
   仓库/日志/截图**),`hmh web start --exposure=lan`(监听 0.0.0.0:7788)。
3. **HAP 应用切本地**:`hdc shell aa start ... --ps hmhUrl http://127.0.0.1:7788`
   (onNewWant 持久化通道已有),应用应显示已连接(版本=设备侧 hmharness 版本),
   会话列表=设备侧 HMH_HOME(与 PC 独立,如实说明)。
4. **三端同核实证**:设备上 `hmh tui` 与 HAP 应用与设备浏览器(127.0.0.1:7788)
   同内核同时可用——各截图/dump 一份存 evidence/ohos/v6/。
5. **一键化**:`apps/ohos/scripts/deploy-local-kernel.mjs`(PC 上跑一条命令=
   探测/推 node→装 hmh→写 config(密钥参数化,不入库)→起服务→切换应用地址);
   README-ohos.md 增"设备独立模式"章节(远程壳/本地共享两种模式说明)。
6. **验收记录**:ACCEPTANCE.md 增 v6 门(L1 设备 hmh 可跑/L2 本地 web 起/L3 应用
   连本地实证/L4 三端同核/L5 一键脚本+文档)。纪律:棒次断点/token 安全/如实。

## 已知边界(如实写进文档)
- 设备侧是独立 HMH_HOME(会话与 PC 各自独立;远程壳模式才共享 PC 会话);
- 设备独立模式=侧载形态(需 hdc;应用市场形态仍是未来项);
- x86_64 VM 实测为准;arm 设备需换 node 二进制(脚本参数化)。
