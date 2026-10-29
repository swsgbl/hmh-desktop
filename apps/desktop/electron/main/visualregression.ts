/**
 * 视觉回归截图钩子 —— 确定性视口截图,供 scripts/visual-regression.mjs 做像素 diff。
 *
 * 与 ui-verify 同族(零第三方依赖),但目标是"同一输入 → 逐字节可比的图":
 *  - 窗口归一 1280×800;主题/语言固定(light + 当前 locale 默认,写 localStorage 后 reload)
 *  - fake host(HMH_DESKTOP_VISREG=1 时 main 已强制 fake):空会话/固定工作区与 provider
 *  - 三视口:main(会话主界面空态)/ settings(设置弹层)/ dock(Files 浏览)
 *  - 动态区 mask:动态端口/时间戳/计数等元素按 bounding box 记入 meta.json,
 *    像素 diff 时跳过(坐标已按 capturePage 实际尺寸 × devicePixelRatio 换算)
 *  - HMH_DESKTOP_VISREG_MUTATE=<viewport>:在该视口注入固定色块,用于管线自检
 *    (baseline 自比 0 差异 + 故意改动必 FAIL,证明阈值与 diff 图真实工作)
 * env:HMH_DESKTOP_VISREG=1(开关)/ HMH_DESKTOP_VISREG_OUT=<dir>(输出目录)
 */
import { app, type BrowserWindow } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 动态区域(每次运行必变的内容)→ mask 选择器;静态结构不 mask,diff 才有意义 */
const MASK_SELECTORS: Array<{ sel: string; reason: string }> = [
  { sel: '.host-label', reason: 'host 端口/版本(fake host 每次随机端口)' },
  { sel: '.session-time', reason: '会话时间戳' },
  { sel: '.turn-sum', reason: '回合/token 计数' },
];

/** 固定视口:覆盖三栏布局与底部 dock 的分支,同时远离 820/1100 断点 */
const VIEWPORT_W = 1280;
const VIEWPORT_H = 800;

async function runVisualRegression(win: BrowserWindow): Promise<void> {
  const out = process.env.HMH_DESKTOP_VISREG_OUT ?? join(app.getPath('temp'), 'hmh-visreg');
  const mutate = process.env.HMH_DESKTOP_VISREG_MUTATE ?? '';
  await mkdir(out, { recursive: true }).catch(() => undefined);
  const js = <T>(code: string): Promise<T> => win.webContents.executeJavaScript(code, true) as Promise<T>;
  const waitFor = async (label: string, predicateCode: string, timeoutMs: number): Promise<void> => {
    const started = Date.now();
    for (;;) {
      const r = (await js(`(function(){ try { return JSON.stringify((function(){ ${predicateCode} })()); } catch(e){ return JSON.stringify({ok:false, detail:String(e).slice(0,120)}); } })()`)) as string;
      let parsed: { ok?: boolean };
      try { parsed = JSON.parse(r) as { ok?: boolean }; } catch { parsed = {}; }
      if (parsed.ok === true) return;
      if (Date.now() - started > timeoutMs) {
        console.log(`VISREG-CAPTURE FAIL | wait ${label} timeout`);
        app.exit(1);
        return;
      }
      await sleep(250);
    }
  };

  // 0) 窗口归一:尺寸固定(位置保持用户桌面上的);主题浅色 + 中文,写偏好后 reload 生效
  try { win.setBounds({ width: VIEWPORT_W, height: VIEWPORT_H }); } catch { /* 最小尺寸兜底 */ }
  await sleep(400);
  await js(`(function(){ try { localStorage.setItem('hmh.theme', 'light'); localStorage.setItem('hmh.locale', 'zh'); } catch (e) {} return 'ok'; })()`);
  win.webContents.reload();
  await waitFor('mounted', `var t=document.querySelector('.composer textarea'); return {ok: !!t, detail: t ? 'up' : 'down'};`, 20_000);
  await waitFor('host dot on', `var d=document.querySelector('.host-dot'); return {ok: !!d && d.classList.contains('on'), detail: d ? d.className : 'none'};`, 30_000);
  await sleep(1_200); // 会话列表/顶栏数据落地

  // 1) 关掉 fake 演示引导层(遮罩弹层不属于被测视口;不依赖文案,按结构取 ghost 按钮)
  await js(`(function(){ var g=document.querySelector('.runtime-guide'); if(!g) return 'no-guide';
    var b=document.querySelector('.runtime-guide-actions .btn.ghost'); if(b) b.click(); return 'dismissed'; })()`);
  await waitFor('guide closed', `return {ok: !document.querySelector('.runtime-guide'), detail: 'closed'};`, 5_000);

  // 2) 视口序列:main(空态主界面)→ settings(设置弹层)→ dock(Files 浏览)
  const viewports: Array<{ name: string; setup: () => Promise<void> }> = [
    { name: 'main', setup: async () => { /* 启动默认态:空会话 + Overview dock */ } },
    {
      name: 'settings',
      setup: async () => {
        await js(`(function(){ window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, shiftKey: true, bubbles: true })); })()`);
        await waitFor('settings open', `return {ok: !!document.querySelector('.cmdk.settings'), detail: 'open'};`, 5_000);
      },
    },
    {
      name: 'dock',
      setup: async () => {
        await js(`(function(){ window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); })()`);
        await waitFor('settings closed', `return {ok: !document.querySelector('.cmdk.settings'), detail: 'closed'};`, 5_000);
        // Files tab:按 dock-tab 顺序第 2 个(Overview/Files/…),避免依赖文案
        await js(`(function(){ var t=document.querySelectorAll('.dock-tab')[1]; if(t) t.click(); })()`);
        await waitFor('files rows', `var r=document.querySelectorAll('.fs-row'); return {ok: r.length >= 1, detail: 'rows=' + r.length};`, 5_000);
      },
    },
  ];

  const meta: { generatedAt: string; window: { width: number; height: number }; mutate: string; viewports: Array<{ name: string; file: string; width: number; height: number; dpr: number; masks: Array<{ x: number; y: number; w: number; h: number; for: string }> }> } = {
    generatedAt: new Date().toISOString(),
    window: { width: VIEWPORT_W, height: VIEWPORT_H },
    mutate,
    viewports: [],
  };
  for (const v of viewports) {
    await v.setup();
    await js(`(function(){ var a=document.activeElement; if(a && a.blur) a.blur(); })()`); // 去焦点环
    await sleep(600); // 过渡与渲染稳定
    if (mutate === v.name) {
      // 管线自检:注入 120×90 固定红块(约 1% 面积,> 0.5% 阈值,应判 FAIL)
      await js(`(function(){ var d=document.createElement('div'); d.setAttribute('data-visreg-mutate','1');
        d.style.cssText='position:fixed;left:560px;top:300px;width:120px;height:90px;background:rgb(255,0,0);z-index:9999;';
        document.body.appendChild(d); })()`);
      await sleep(150);
    }
    const img = await win.webContents.capturePage();
    const size = img.getSize();
    // 管线自检红块只属于目标视口:截图后立即移除,不污染后续视口
    if (mutate === v.name) {
      await js(`(function(){ var d=document.querySelector('[data-visreg-mutate]'); if(d) d.remove(); })()`);
    }
    const innerW = (await js<number>('window.innerWidth')) || size.width;
    const dpr = size.width / innerW;
    const masks: Array<{ x: number; y: number; w: number; h: number; for: string }> = [];
    for (const m of MASK_SELECTORS) {
      const rects = (await js<string>(`(function(){ return JSON.stringify([].slice.call(document.querySelectorAll('${m.sel}')).map(function(el){
        var r=el.getBoundingClientRect(); return { x:r.x, y:r.y, w:r.width, h:r.height };
      }).filter(function(r){ return r.w > 0 && r.h > 0 && r.y >= 0 && r.y < window.innerHeight; })) })()`));
      let list: Array<{ x: number; y: number; w: number; h: number }> = [];
      try { list = JSON.parse(rects) as typeof list; } catch { /* 空 */ }
      for (const r of list) {
        masks.push({ x: Math.round(r.x * dpr), y: Math.round(r.y * dpr), w: Math.round(r.w * dpr), h: Math.round(r.h * dpr), for: m.reason });
      }
    }
    const file = `${v.name}.png`;
    await writeFile(join(out, file), img.toPNG());
    meta.viewports.push({ name: v.name, file, width: size.width, height: size.height, dpr: Math.round(dpr * 100) / 100, masks });
    console.log(`VISREG-CAPTURE ${v.name} ${size.width}x${size.height} masks=${masks.length}${mutate === v.name ? ' MUTATED' : ''}`);
  }
  await writeFile(join(out, 'meta.json'), JSON.stringify(meta, null, 2));
  console.log('VISREG-CAPTURE DONE');
  app.exit(0);
}

export function attachVisualRegression(win: BrowserWindow): void {
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => { void runVisualRegression(win); }, 1_500);
  });
}
