# HMH Desktop · HarmonyOS (深开鸿 KaihongOS)

鸿蒙桌面客户端,与 Windows 桌面版同源同协议(hmh web 7788)。


## 单机安装(深开鸿设备独立完成,无需其他电脑)

> 重要:此系统**不要双击 .hap 文件**——系统安装器会先卸载现有应用且界面损坏,装不上。

**第 1 步**:在本页(Releases)下载 `hmh-offline-bundle.tar.gz`(约 40MB,内含桌面应用+hmh 内核+node 运行时)。

**第 2 步**:打开系统终端(Terminal),粘贴这一行并回车:

```sh
D=$(ls /storage/media/100/local/files/Docs/Download/hmh-offline-bundle.tar.gz 2>/dev/null || ls /storage/Users/currentUser/Download/hmh-offline-bundle.tar.gz 2>/dev/null || ls ~/Download/hmh-offline-bundle.tar.gz 2>/dev/null); [ -f "$D" ] || { echo 找不到安装包; exit 1; }; cd /data/local/tmp && rm -rf hmh-bundle && busybox tar xzf "$D" && sh hmh-bundle/install.sh
```

装完自动启动本机内核服务;打开桌面上的 HMH Desktop(蓝色 H 图标)即自动连接。

⚠️ 窗口请保持浮动(勿点"最大化"按钮):此系统版本最大化后鼠标会失灵(系统缺陷)。

## 双模式

应用支持两种运行模式,首启智能检测(免手工配置):

| 模式 | 连接目标 | 适用 | 配置/密钥/会话 |
|---|---|---|---|
| **本机模式(设备独立)** | `http://127.0.0.1:7788` | 设备上装有 hmh 内核(TUI/CLI 同机) | 共享设备 `/data/local/home/.hmharness` — **CLI / TUI / 桌面应用 / 浏览器四端同核** |
| **远程模式** | `http://<PC-IP>:7788` | hmh 跑在 PC 上 | 共享 PC 侧 `~/.hmharness` |

### 首启智能检测(v6.1)

- 本机 `127.0.0.1:7788` 可达 → **默认连本地共享**,横幅注明"已连接本机 hmh 内核(与 TUI/浏览器共享 /data/local/home/.hmharness)"
- 本机装了 hmh 但服务未起 → 启动指引
- 都没有 → 安装向导(三选一):
  - **① 在本机安装 hmh 内核(推荐)** — PC 端一条命令装到设备:
    ```
    node apps/ohos/scripts/deploy-local-kernel.mjs
    ```
    应用内带"复制"按钮 + 轮询自动连接(装好即连,免手填)
  - **② 连接电脑(远程模式)** — 转设置页填 PC 地址
  - **③ 演示模式** — 免服务浏览界面
- 向导可跳过、可上一步;选择持久(preferences),设置页可"重新配置"重入

> IP 漂移 = 已知运维场景(PC DHCP 换网段时远程模式地址需更新;长期方案配对二维码/服务发现待立项)。

## 设备独立模式部署(L5 一键化)

前置:VM/设备开启开发者模式,hdc 可连(`hdc tconn <ip>:10178`)。

```
# 一条命令:装 hmh 15 包 → jitless 启动器补丁 → 自检 → 起 web(0.0.0.0:7788) → API 探针
node apps/ohos/scripts/deploy-local-kernel.mjs [--target ip:port] [--token-env HMH_WEB_TOKEN] [--arch x64|arm]
```

装完后在应用设置页填 `http://127.0.0.1:7788`(loopback 免 token),即与设备 TUI/浏览器三端同核。

### 已知边界(如实)

- 设备侧独立 `HMH_HOME`(`/data/local/home/.hmharness`),与 PC 不共享会话;
- 侧载形态(非应用市场),需开发者模式;
- 本 VM root 的 hdc shell 也禁 RWX → 启动器强制 `--jitless`(环境变量 `NODE_ALLOW_JIT=0` 语义,补丁幂等,重装后需重跑脚本);
- arm 设备需自备 arm 版 node 二进制(`--arch arm` + `HMH_ARM_NODE=<tar>`);
- `/usr/local/bin` 与 `/system/bin` 的 hmh 启动器补丁在 rootfs remount rw 窗口内完成,系统更新后重跑。

## HAP 构建与部署

```
cd apps/ohos
hvigorw.bat assembleHap          # 真构建(API26 产物)
node scripts/deploy.mjs          # 降版重打包(API23) → VM 侧双签 → bm install → aa start
```

VM(192.168.161.137:10178 · KaihongOS 6.1.2.08 · API23)拒宿主 SDK26 签名,签名链在设备侧 hap-sign-tool 完成。

## 单测

```
node --import tsx --test apps/ohos/tests/*.test.ts    # 纯逻辑,与 ArkUI 零依赖(68 用例)
```

## 证据

`evidence/ohos/v6/` — L1-L5 与 SW1-SW4 的 dump/截图/探针输出。
