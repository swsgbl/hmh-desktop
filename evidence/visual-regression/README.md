# 视觉回归证据(任务 11-A 缺口4)

零第三方依赖的像素 diff 管线:Electron 侧 `apps/desktop/electron/main/visualregression.ts`
产出确定性三视口截图(fake host、1280×800、浅色+中文、动态区 mask),node 侧
`scripts/visual-regression.mjs`(PNG 编解码 `scripts/lib/png.mjs`)做阈值 diff。

## 三视口

| 视口 | 内容 | mask |
|---|---|---|
| main | 会话主界面空态(标题栏/顶栏/空态提示/composer/Overview dock) | `.host-label`(动态端口) |
| settings | Ctrl+Shift+P 设置弹层 | 同上 |
| dock | Files 页签浏览 | 同上(+ `.turn-sum`) |

## 阈值

- 单通道容差:`|Δ| ≤ 5`(= 2% × 255)视为相同(抗锯齿/亚像素抖动)
- FAIL 阈值:差异像素 / 可比像素(mask 外)> **0.5%**
- mask:meta.json 记录动态元素 bounding box(已按 devicePixelRatio 换算到图像像素)

## 本目录文件

- `baseline/{main,settings,dock}.png + meta.json` —— 基线(2026-10-29 生成)
- `report-selfcheck.json` —— 自比轮:3/3 PASS,全部 0.0000% 差异
- `report-intentional-fail.json` + `diff-main-intentional-fail.png` —— 故意改动轮
  (`--mutate main` 注入 120×90 红块 ≈ 1.06% > 0.5%):main FAIL / 其余 PASS,exit 1
- `report.json` —— 最近一次运行(终态为修复红块清理后的 PASS 自比)

## 再生方法

```bash
npm run build                       # 截图走 dist 产物
npm run verify:visual               # 首次:自动生成 baseline;之后:diff,FAIL 则 exit 1
npm run verify:visual -- --mutate main        # 管线自检:应 main FAIL
npm run verify:visual -- --update-baseline    # UI 有意变更后显式刷新基线
npm run verify:visual -- --packaged           # win-unpacked 产物(本轮验证 dev)
```
