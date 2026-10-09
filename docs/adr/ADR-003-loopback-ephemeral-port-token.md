# ADR-003:Host 桥只走 loopback + 临时端口 + 高熵 token

日期:2026-10-09 · 状态:已接受(方案文档 03 §四 Host 与 Bridge 合同)

## 决策
Desktop↔hmharness 的本地桥:
1. **只绑定 127.0.0.1**;桌面桥不启用 LAN/WAN/tunnel;
2. **端口用操作系统分配(port 0)**,实际端口由 host stdout 引导行 `{"hmhDesktopHostReady":true,"port":N,"version":V}` 回传——不抢、不碰固定 7788;
3. **每次 host 启动生成高熵随机 token**(256-bit base64url),只通过子进程环境变量 `HMH_DESKTOP_TOKEN` 传递;所有 `/api/*` 强制 `X-Hmh-Key` 校验;
4. token 不出现在 URL、localStorage、renderer、日志、崩溃报告(main 进程日志输出前脱敏);
5. host 重启立即轮换 token。

## 理由
- 机器上已有 `hmh web`(7788)时 Desktop 必须共存不冲突(验收清单"端口安全");
- loopback 无鉴权 = 本机任意进程可驱动 agent(v0.23.33 GAP,C3);
- 进程名 kill 会误杀用户手动启动的服务——supervisor 只跟踪自己 spawn 的 PID/句柄。

## 实现锚点
- `packages/host-adapter/src/supervisor.ts`:token 生成/env 注入/状态机/只杀自有句柄;
- `packages/host-adapter/src/fake-host.ts`:同一合同的测试替身(401/state/SSE/shutdown/die 钩子);
- hmharness 侧:desktop-host 入口(待 §5 改造,向后兼容)。

## 测试证据
supervisor 测试:AUTH_FAILED 不重启、crash 自愈(restarting→ready)、烧完 maxRestarts→failed、优雅 stop 后端口不可达且幂等。
