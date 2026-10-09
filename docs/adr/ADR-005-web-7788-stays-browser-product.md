# ADR-005:Web 7788 保留为浏览器/远程产品入口

日期:2026-10-09 · 状态:已接受(方案文档 03 §一/§八)

## 决策
- `hmh web`(默认 7788)继续服务浏览器/远程/手机场景,独立演进;
- Desktop **不共用**固定 7788、不默认打开 LAN/WAN/tunnel、不嵌入 7788 页面作为产品形态;
- 两条产品线共享 hmharness runtime 与(经 contracts 的)数据契约,不共享进程/端口/认证模型。

## 理由
- Web 的暴露模型(loopback/lan/wan + 配对 + 隧道)与桌面本地信任模型不同,合并会互相拖累;
- Desktop 抢 7788 或复用其页面会把桌面生命周期与 Web daemon 的 pid/version 文件机制耦合(C6);
- 产品边界:oneaiterm/uniTerm 是独立产品线,本仓库不引入其依赖树。

## 后果
- Desktop host 一律 port 0(ADR-003),与 7788 天然无冲突;验收项"机器已有 7788 服务时 Desktop 不抢端口不杀服务"由设计保证;
- Web 端的安全改进(page.ts innerHTML 清理)在 hmharness 侧推进,不阻塞 Desktop。
