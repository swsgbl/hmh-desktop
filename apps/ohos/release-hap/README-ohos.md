# HMH-OHOS(深开鸿/HarmonyOS 版)安装说明

资产:`HMH-OHOS-0.2.8.hap`(API23,versionCode 1000002,OpenHarmony 公共测试签名——侧载形态;sha256 `8448fb96736143d2178d7b9557ccf7c013dc4962b8b03aa4877902fef04be0f1`)。历史:0.2.4 → 0.2.5 → 0.2.6 → 0.2.7 同目录归档。

## 安装(两种)

**A. 一键脚本**(Windows,本仓库 clone 后):
```bash
node apps/ohos/scripts/deploy.mjs   # 需 hdc(DevEco toolchains)且 VM/设备可连
```

**B. 手动 hdc**(设备已 tconn):
```bash
hdc install -r HMH-OHOS-0.2.8.hap
hdc shell aa start -a EntryAbility -b com.hmh.desktop.ohos
```

## 首次配置
应用启动 → 设置页:服务器地址填电脑的局域网地址(http://<PC-IP>:7788)+ 电脑 HMH_HOME config.json 里的 web.token → 测试连接。PC 端需 `hmh web --exposure=lan` 在线(桌面版"远程"页签可一键启动)。

## 已知边界
- **OpenHarmony 公共测试签名**:适合开发/侧载;上架应用市场需华为开发者账号 + AGC 发布证书(正式发布签名)——登记为外部依赖。
- IP 漂移:电脑换网后地址变化 → 应用设置里改,或用参数注入一条命令:`hdc shell aa start -a EntryAbility -b com.hmh.desktop.ohos --ps hmhUrl http://<新IP>:7788`
