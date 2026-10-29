/**
 * UIVERIFY 钩子 —— 逐功能真实 UI 驱动验收(2026-10-10 用户指令:
 * "对每一个功能,每一个业务流程全面的验收")。
 *
 * 直接对渲染后的 DOM 断言(布局几何/可见性),并用原生事件驱动 React
 * (受控输入用原型 setter + input 事件;按钮 click;键盘走 window
 * keydown)。fake 模式跑完整任务链(发送→工具→审批→交付物→汇总);
 * real 模式只跑只读子集(不动真实会话、不烧 token)。
 * 每步输出 `UIVERIFY PASS|FAIL name | detail`,结尾 SUMMARY,exit code。
 */
import { app, type BrowserWindow } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function runUiVerify(win: BrowserWindow, mode: 'fake' | 'real'): Promise<void> {
  const shots = process.env.HMH_DESKTOP_UIVERIFY_SHOTS ?? join(app.getPath('temp'), 'hmh-uiverify');
  await mkdir(shots, { recursive: true }).catch(() => undefined);
  const results: Array<[string, boolean, string]> = [];
  let shotIdx = 0;

  const js = <T>(code: string): Promise<T> => win.webContents.executeJavaScript(code, true) as Promise<T>;
  const step = async (name: string, fn: () => Promise<[boolean, string]>): Promise<void> => {
    try {
      const [ok, detail] = await fn();
      results.push([name, ok, detail]);
    } catch (err) {
      const detail = err instanceof Error && err.stack !== undefined ? err.stack : String(err);
      results.push([name, false, detail.slice(0, 300)]);
    }
    const last = results[results.length - 1]!;
    console.log(`UIVERIFY ${last[1] ? 'PASS' : 'FAIL'} | ${last[0]} | ${last[2]}`);
  };
  /** 轮询直到 predicateCode 返回 {ok:true,...} 或超时(返回最后的 detail)。 */
  const waitFor = async (label: string, predicateCode: string, timeoutMs: number): Promise<[boolean, string]> => {
    const started = Date.now();
    for (;;) {
      const r = (await js(`(function(){ try { return JSON.stringify((function(){ ${predicateCode} })()); } catch(e){ return JSON.stringify({ok:false, detail:String(e).slice(0,120)}); } })()`)) as string;
      let parsed: { ok?: boolean; detail?: string };
      try { parsed = JSON.parse(r) as { ok?: boolean; detail?: string }; } catch { parsed = { ok: false, detail: String(r).slice(0, 120) }; }
      if (parsed.ok === true) return [true, String(parsed.detail ?? '')];
      if (Date.now() - started > timeoutMs) return [false, `${label}: ${String(parsed.detail ?? 'timeout')}`];
      await sleep(250);
    }
  };
  const shot = async (label: string): Promise<void> => {
    shotIdx += 1;
    try {
      const img = await win.webContents.capturePage();
      await writeFile(join(shots, `${mode}-${String(shotIdx).padStart(2, '0')}-${label}.png`), img.toPNG());
    } catch { /* 截图失败不判死 */ }
  };

  /* ---- 受控输入(React:原型 setter 触发 onChange) ---- */
  const typeInto = (sel: string, text: string): Promise<unknown> =>
    js(`(function(){
      var el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return 'NOEL';
      var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'OK';
    })()`);

  /* ---- 启动等待:React 挂载 + host 绿点(real 的 hmharness 冷启动要编译
     整套 CLI 依赖,可到 30s+;不等绿点就开跑会全部超时误报) ---- */
  await waitFor('host ready', `var t=document.querySelector('.composer textarea'); return {ok: !!t, detail: t ? 'mounted' : 'no composer'};`, 20_000);
  await waitFor('host dot on', `var d=document.querySelector('.host-dot'); return {ok: !!d && d.classList.contains('on'), detail: d ? d.className : 'no dot'};`, mode === 'real' ? 60_000 : 20_000);
  await sleep(1_200); // 会话列表/顶栏数据落地

  /* ========== 通用:布局几何(用户报障的直接断言) ========== */
  await step('布局:标题栏+三栏+composer 在视口内(输入框可见)', async () => {
    const r = (await js(`(function(){
      var q = document.querySelector.bind(document);
      var tb = q('.titlebar'), shell = q('.app-shell'), sb = q('.sidebar'), ws = q('.workspace'), ta = q('.composer textarea');
      var missing = [!tb && 'titlebar', !shell && 'shell', !sb && 'sidebar', !ws && 'workspace', !ta && 'textarea'].filter(Boolean).join(',');
      if (missing !== '') return JSON.stringify({ok:false, detail:'missing:'+missing});
      var r = ta.getBoundingClientRect(), vh = window.innerHeight, vw = window.innerWidth;
      var hint = q('.empty-hint.big'); var hr = hint ? hint.getBoundingClientRect() : null;
      return JSON.stringify({ ok: r.height > 30 && r.bottom <= vh && r.width > 100 && hr !== null && hr.top >= 0 && hr.bottom <= vh,
        detail: 'textarea y='+Math.round(r.y)+' h='+Math.round(r.height)+' bottom='+Math.round(r.bottom)+' vh='+vh+(hr ? ' hint y='+Math.round(hr.y) : ' no-hint') });
    })()`)) as string;
    const p = JSON.parse(r) as { ok: boolean; detail: string };
    return [p.ok === true, p.detail];
  });

  if (mode === 'fake') {
    /* ========== fake(向导构造,HMH_DESKTOP_UIVERIFY_WIZARD=fake):
       伪造未配置态 → 向导出现 → 检测(未装)→ 选择 → 内置 → 连上 ========== */
    if (process.env.HMH_DESKTOP_UIVERIFY_WIZARD === 'fake') {
      await step('向导:首启弹出欢迎页(开始配置/演示入口)', async () => {
        const w = await waitFor('wizard overlay', `var o=document.querySelector('.wizard-overlay');
          var b=[].slice.call(document.querySelectorAll('.wizard-overlay button')).find(function(x){return x.textContent.trim()==='开始配置';});
          return {ok: !!o && !!b, detail: o ? 'overlay+开始配置' : 'no overlay'};`, 12_000);
        await shot('wizard-welcome');
        return w;
      });
      await step('向导:开始配置→检测(伪造未装)→未装即自动安装页(说明横幅+切换链接)', async () => {
        await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.wizard-overlay button')).find(function(x){return x.textContent.trim()==='开始配置';}); if(b) b.click(); })()`);
        const w = await waitFor('auto install page', `var p=document.querySelector('.wizard-card.wizard-page-install');
          if(!p) return {ok:false, detail:'not on install'};
          var t=p.textContent;
          var note=t.indexOf('未检测到 hmh CLI,已自动开始安装')>=0;
          var l1=t.indexOf('改用内置精简内核')>=0, l2=t.indexOf('演示模式')>=0;
          var bar=!!p.querySelector('.wizard-progress');
          var sel=document.querySelector('.wizard-card.wizard-page-select');
          return {ok: note&&l1&&l2&&bar&&!sel, detail: 'note='+note+' 内置链接='+l1+' 演示链接='+l2+' bar='+bar+' selectLeak='+!!sel};`, 12_000);
        await shot('wizard-auto-install');
        return w;
      });
      await step('向导:横幅"改用内置精简内核"→配置跳过→完成页→开始使用→关闭且已连接', async () => {
        await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.wizard-page-install .wizard-alt-link')).find(function(x){return x.textContent.indexOf('改用内置精简内核')>=0;}); if(b) b.click(); })()`);
        // 配置页:fake providers 已有密钥 → 自动跳过;兜底点"跳过"
        await waitFor('config or done', `var d=document.querySelector('.wizard-card.wizard-page-done');
          if(d) return {ok:true, detail:'done'};
          var c=document.querySelector('.wizard-card.wizard-page-config');
          if(c){ var s=[].slice.call(document.querySelectorAll('.wizard-overlay button')).find(function(x){return x.textContent.indexOf('跳过')>=0;}); if(s) s.click(); }
          return {ok:false, detail:'waiting'};`, 15_000);
        const w = await waitFor('done page', `var d=document.querySelector('.wizard-card.wizard-page-done');
          var t=d?d.textContent:'';
          return {ok: !!d && t.indexOf('就绪')>=0 && t.indexOf('共享')>=0, detail: t.replace(/\\s+/g,' ').slice(0,60)};`, 8_000);
        await shot('wizard-done');
        await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.wizard-overlay button')).find(function(x){return x.textContent.trim()==='开始使用';}); if(b) b.click(); })()`);
        const closed = await waitFor('wizard closed + connected', `return {ok: !document.querySelector('.wizard-overlay') && !!document.querySelector('.host-dot.on'),
          detail: 'overlay='+(document.querySelector('.wizard-overlay')?'open':'closed')+' dot='+(document.querySelector('.host-dot.on')?'on':'off')};`, 10_000);
        return [w[0] && closed[0], `done: ${w[1]}; ${closed[1]}`];
      });
    }

    /* ========== fake:首跑引导层 ========== */
    await step('引导层:演示模式提示出现并可关闭', async () => {
      const w = await waitFor('guide', `var g=document.querySelector('.runtime-guide'); return {ok: !!g, detail: g ? 'shown' : 'not shown'};`, 8_000);
      if (!w[0]) return w;
      await js(`(function(){
        var btns = [].slice.call(document.querySelectorAll('.runtime-guide button'));
        var b = btns.find(function(x){ return x.textContent.indexOf('演示') >= 0; });
        if (b) b.click();
      })()`);
      return waitFor('guide gone', `return {ok: !document.querySelector('.runtime-guide'), detail: document.querySelector('.runtime-guide') ? 'still' : 'dismissed'};`, 5_000);
    });

    /* ========== fake:新建会话(Ctrl+N) ========== */
    await step('Ctrl+N 新建会话,输入框可用', async () => {
      await js(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'n', ctrlKey:true, bubbles:true}))`);
      return waitFor('textarea enabled', `var t=document.querySelector('.composer textarea');
        return {ok: !!t && t.disabled === false && (t.placeholder||'').indexOf('描述目标') >= 0, detail: t ? ('disabled='+t.disabled+' ph='+(t.placeholder||'').slice(0,20)) : 'no ta'};`, 5_000);
    });

    /* ========== fake:发送任务 → 用户轮出现(且仅一条,双消息回归) ========== */
    await step('输入并发送任务,用户消息上屏且不重复', async () => {
      await typeInto('.composer textarea', '验收任务:写入一个文件');
      await sleep(200);
      await js(`(function(){
        var btns = [].slice.call(document.querySelectorAll('.composer button'));
        var b = btns.find(function(x){ return x.textContent.trim() === '发送'; });
        if (b) b.click();
      })()`);
      return waitFor('exactly one user turn', `var ts=[].slice.call(document.querySelectorAll('.turn.user')).filter(function(x){ return x.textContent.indexOf('验收任务') >= 0; });
        return {ok: ts.length === 1, detail: 'count='+ts.length+' text='+(ts[0]?ts[0].textContent.slice(0,30):'none')};`, 8_000);
    });

    /* ========== fake:工具卡(read_file 完成) ========== */
    await step('工具折叠卡:read_file 执行并完成', async () => {
      const w = await waitFor('tool card', `var c=[].slice.call(document.querySelectorAll('.tool-card'));
        var done = c.filter(function(x){ return x.textContent.indexOf('read_file') >= 0 && x.textContent.indexOf('# demo') >= 0; });
        return {ok: done.length >= 1, detail: 'cards='+c.length+' done='+done.length};`, 8_000);
      return w;
    });

    /* ========== fake:审批纵切片(用户报障核心之一) ========== */
    await step('审批:approval 卡出现(等待人工批准)', async () => {
      await shot('approval-pending');
      return waitFor('approval card', `var a=document.querySelector('.approval-card');
        return {ok: !!a && a.textContent.indexOf('需要审批') >= 0, detail: a ? a.textContent.replace(/\\s+/g,' ').slice(0, 60) : 'no approval card'};`, 8_000);
    });
    await step('审批:点批准 → 任务继续到交付物+汇总', async () => {
      await js(`(function(){
        var b=[].slice.call(document.querySelectorAll('.approval-card button')).find(function(x){ return x.textContent.trim()==='批准'; });
        if (b) b.click();
      })()`);
      const w = await waitFor('artifact+sum', `var art=document.querySelector('.artifact-card');
        var sum=document.querySelector('.turn-sum');
        var ast=[].slice.call(document.querySelectorAll('.turn')).filter(function(x){ return x.className.indexOf('user')<0 && x.textContent.indexOf('echo:')>=0; });
        return {ok: !!art && !!sum && ast.length>=1, detail: 'artifact='+(art?art.textContent.slice(0,30):'none')+' sum='+(sum?sum.textContent:'none')+' answered='+ast.length};`, 12_000);
      await shot('run-completed');
      return w;
    });

    /* ========== fake:历史会话内容(用户报障"看不到内容") ========== */
    await step('点击历史会话 → transcript 内容可见', async () => {
      await js(`(function(){ var it=document.querySelector('.session-item'); if (it) it.click(); })()`);
      return waitFor('history turns', `var ts=[].slice.call(document.querySelectorAll('.turn'));
        return {ok: ts.length >= 2, detail: 'turns='+ts.length+' first='+(ts[0]?ts[0].textContent.replace(/\\s+/g,' ').slice(0,40):'none')};`, 8_000);
    });

    /* ========== fake:五页签 ========== */
    await step('Dock:Overview 数据行', async () => {
      await js(`(function(){ var t=[].slice.call(document.querySelectorAll('.dock-tab')).find(function(x){return x.textContent==='Overview';}); if(t) t.click(); })()`);
      return waitFor('overview rows', `var rows=[].slice.call(document.querySelectorAll('.dock-row'));
        var ver = rows.find(function(r){ return r.textContent.indexOf('runtime 版本')>=0; });
        return {ok: rows.length >= 5 && !!ver, detail: 'rows='+rows.length+(ver?' ver='+ver.textContent.replace(/\\s+/g,' ').slice(0,40):'')};`, 6_000);
    });
    await step('Dock:Files 浏览+文件预览', async () => {
      await js(`(function(){ var t=[].slice.call(document.querySelectorAll('.dock-tab')).find(function(x){return x.textContent==='文件'||x.textContent==='Files';}); if(t) t.click(); })()`);
      const w = await waitFor('fs rows', `var rows=document.querySelectorAll('.fs-row').length;
        return {ok: rows >= 1, detail: 'rows='+rows};`, 6_000);
      if (!w[0]) return w;
      // 根目录只有工作区目录(fake 与真实 runtime 同形):先进目录,再点文件
      await js(`(function(){ var d=[].slice.call(document.querySelectorAll('.fs-row')).find(function(x){return x.textContent.indexOf('demo-workspace')>=0 || x.textContent.indexOf('📁')>=0;}); if(d) d.click(); })()`);
      const w2 = await waitFor('file rows', `var rows=[].slice.call(document.querySelectorAll('.fs-row'));
        return {ok: rows.some(function(x){return x.textContent.indexOf('README')>=0;}), detail: 'rows='+rows.length};`, 6_000);
      if (!w2[0]) return w2;
      await js(`(function(){ var f=[].slice.call(document.querySelectorAll('.fs-row')).find(function(x){return x.textContent.indexOf('README')>=0;}); if(f) f.click(); })()`);
      return waitFor('file preview', `var p=document.querySelector('.fs-preview');
        return {ok: !!p && p.textContent.indexOf('demo workspace') >= 0, detail: p ? p.textContent.replace(/\\s+/g,' ').slice(0,40) : 'no preview'};`, 6_000);
    });
    await step('Dock:Diff 变更行', async () => {
      await js(`(function(){ var t=[].slice.call(document.querySelectorAll('.dock-tab')).find(function(x){return x.textContent==='变更'||x.textContent==='Diff';}); if(t) t.click(); })()`);
      return waitFor('diff rows', `var rows=document.querySelectorAll('.diff-row').length;
        return {ok: rows >= 1, detail: 'diff rows='+rows};`, 6_000);
    });
    await step('Dock:Evidence 认知数据', async () => {
      await js(`(function(){ var t=[].slice.call(document.querySelectorAll('.dock-tab')).find(function(x){return x.textContent==='证据'||x.textContent==='Evidence';}); if(t) t.click(); })()`);
      return waitFor('evidence rows', `var rows=[].slice.call(document.querySelectorAll('.dock-row'));
        var mem = rows.find(function(r){ return r.textContent.indexOf('记忆层')>=0 || r.textContent.indexOf('Memory layers')>=0; });
        return {ok: !!mem && mem.textContent.indexOf('3') >= 0, detail: mem ? mem.textContent.replace(/\\s+/g,' ') : 'no memory row'};`, 6_000);
    });
    await step('Dock:Logs 面板(空态提示)', async () => {
      await js(`(function(){ var t=[].slice.call(document.querySelectorAll('.dock-tab')).find(function(x){return x.textContent==='日志'||x.textContent==='Logs';}); if(t) t.click(); })()`);
      const w = await waitFor('logs pane', `var l=document.querySelector('.logs-list');
        return {ok: !!l, detail: l ? ('rows='+l.querySelectorAll('.log-row').length) : 'no logs list'};`, 5_000);
      return w;
    });

    /* ========== fake:Dock:远程页签(手机远程控制面板+开机自启行) ========== */
    await step('Dock:远程页签(手机远程控制面板)', async () => {
      await js(`(function(){ var t=[].slice.call(document.querySelectorAll('.dock-tab')).find(function(x){return x.textContent==='远程'||x.textContent==='Remote';}); if(t) t.click(); })()`);
      return waitFor('remote pane', `var p=document.querySelector('.dock-body');
        var t = p ? p.textContent : '';
        var okT = t.indexOf('手机远程控制')>=0 || t.indexOf('Phone remote')>=0;
        var okA = t.indexOf('开机自启')>=0 || t.indexOf('Autostart')>=0;
        return {ok: !!p && okT && okA, detail: t.replace(/\\s+/g,' ').slice(0,60)};`, 6_000);
    });

    /* ========== fake:搜索过滤 ========== */
    await step('会话搜索:过滤生效', async () => {
      const before = (await js(`document.querySelectorAll('.session-item').length`)) as number;
      await typeInto('.session-search', 'zzz-不存在的会话');
      const w = await waitFor('filtered empty', `var n=document.querySelectorAll('.session-item').length;
        return {ok: n === 0, detail: 'after='+n};`, 5_000);
      await typeInto('.session-search', '');
      await sleep(400);
      const after = (await js(`document.querySelectorAll('.session-item').length`)) as number;
      return [w[0] && after === before, `${w[1]}; 恢复后 ${after}===${before}`];
    });

    /* ========== fake:Ctrl+K 命令面板 ========== */
    await step('Ctrl+K 命令面板:打开并执行命令', async () => {
      await js(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'k', ctrlKey:true, bubbles:true}))`);
      const w = await waitFor('cmdk open', `var c=document.querySelector('.cmdk');
        return {ok: !!c, detail: c ? 'open' : 'not open'};`, 5_000);
      if (!w[0]) return w;
      await js(`(function(){ var it=[].slice.call(document.querySelectorAll('.cmdk-item')).find(function(x){return x.textContent.indexOf('文件')>=0 || x.textContent.indexOf('Files')>=0;}); if(it) it.click(); })()`);
      return waitFor('tab switched', `var t=document.querySelector('.dock-tab.active');
        return {ok: !!t && (t.textContent==='文件'||t.textContent==='Files'), detail: 'active='+(t?t.textContent:'none')};`, 5_000);
    });

    /* ========== fake:设置面板 ========== */
    await step('设置(Ctrl+Shift+P):Provider 表单可见,Esc 关闭', async () => {
      await js(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'p', ctrlKey:true, shiftKey:true, bubbles:true}))`);
      const w = await waitFor('settings open', `var s=document.querySelector('.cmdk.settings');
        return {ok: !!s && !!s.querySelector('.provider-form'), detail: s ? 'open+form' : 'not open'};`, 5_000);
      if (!w[0]) return w;
      await js(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
      return waitFor('settings closed', `return {ok: !document.querySelector('.cmdk-overlay'), detail: 'closed'};`, 5_000);
    });

    /* ========== fake:i18n 语言切换 ========== */
    await step('语言切换:中文 → English → 恢复中文', async () => {
      await js(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'p', ctrlKey:true, shiftKey:true, bubbles:true}))`);
      const w = await waitFor('settings open', `var s=document.querySelector('.cmdk.settings');
        return {ok: !!s, detail: s ? 'open' : 'not open'};`, 5_000);
      if (!w[0]) return w;
      await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.cmdk.settings button')).find(function(x){return x.textContent.trim()==='English';}); if(b) b.click(); })()`);
      const en = await waitFor('english shown', `var b=document.querySelector('.sidebar-head .btn.primary');
        return {ok: !!b && b.textContent === '+ New Session', detail: 'btn='+(b?b.textContent:'none')};`, 5_000);
      await shot('english');
      await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.cmdk.settings button')).find(function(x){return x.textContent.trim()==='中文';}); if(b) b.click(); })()`);
      const zh = await waitFor('chinese back', `var b=document.querySelector('.sidebar-head .btn.primary');
        return {ok: !!b && b.textContent === '+ 新建会话', detail: 'btn='+(b?b.textContent:'none')};`, 5_000);
      await js(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
      return [en[0] && zh[0], `en: ${en[1]}; zh: ${zh[1]}`];
    });

    /* ========== fake:工作区管理(左栏栏位 + 菜单 + 新建会话选工作区) ========== */
    await step('工作区:左栏工作区栏可见(当前工作区名)', async () => {
      return waitFor('workspace bar', `var b=document.querySelector('.workspace-bar');
        var n = b ? (b.querySelector('.ws-bar-name')||{}).textContent : '';
        return {ok: !!b && !!n && n.length > 0 && n.indexOf('加载') < 0, detail: 'bar='+(b?'yes':'no')+' name='+n};`, 8_000);
    });
    await step('工作区:菜单弹出,列表+当前高亮+添加入口;在指定工作区新建会话', async () => {
      await js(`(function(){ var b=document.querySelector('.workspace-bar'); if(b) b.click(); })()`);
      const w = await waitFor('ws menu', `var m=document.querySelector('.ws-menu');
        var items = m ? m.querySelectorAll('.ws-menu-item').length : 0;
        var cur = m ? m.querySelectorAll('.ws-menu-item.current').length : 0;
        var add = m ? (m.textContent.indexOf('添加工作区')>=0 || m.textContent.indexOf('Add workspace')>=0) : false;
        return {ok: items >= 1 && cur >= 1 && add, detail: 'items='+items+' current='+cur+' add='+add};`, 6_000);
      if (!w[0]) return w;
      await shot('ws-menu');
      // 点第一个工作区项 = 在该工作区新建会话(菜单关闭、composer 可用)
      await js(`(function(){ var it=document.querySelector('.ws-menu-item'); if(it) it.click(); })()`);
      const closed = await waitFor('menu closed + session active', `var ta=document.querySelector('.composer textarea');
        return {ok: !document.querySelector('.ws-menu') && !!ta && ta.disabled === false, detail: 'menu='+(document.querySelector('.ws-menu')?'open':'closed')+' ta='+(ta?ta.disabled:'none')};`, 6_000);
      return [closed[0], `${w[1]}; ${closed[1]}`];
    });

    /* ========== fake:会话按工作区分组 + 展开/收起 ========== */
    await step('会话分组:组头出现(工作区名+数量)', async () => {
      return waitFor('group head', `var h=document.querySelector('.ws-group-head');
        var n = h ? (h.querySelector('.ws-group-name')||{}).textContent : '';
        var c = h ? (h.querySelector('.ws-group-count')||{}).textContent : '';
        return {ok: !!h && n.length > 0 && c.length > 0, detail: 'name='+n+' count='+c};`, 8_000);
    });
    await step('会话分组:点击组头收起,再点展开恢复', async () => {
      const before = (await js(`document.querySelectorAll('.session-item').length`)) as number;
      if (before === 0) return [false, 'no sessions to group'];
      await js(`(function(){ var h=document.querySelector('.ws-group-head'); if(h) h.click(); })()`);
      const collapsed = await waitFor('collapsed', `var g=document.querySelector('.ws-group');
        var hidden = document.querySelectorAll('.session-item').length < ${before};
        return {ok: hidden, detail: 'items='+document.querySelectorAll('.session-item').length+' before=${before}'};`, 5_000);
      await shot('ws-group-collapsed');
      await js(`(function(){ var h=document.querySelector('.ws-group-head'); if(h) h.click(); })()`);
      const expanded = await waitFor('expanded back', `var n=document.querySelectorAll('.session-item').length;
        return {ok: n >= ${before}, detail: 'items='+n};`, 5_000);
      return [collapsed[0] && expanded[0], `collapse: ${collapsed[1]}; expand: ${expanded[1]}`];
    });

    /* ========== fake:快捷键帮助面板(Ctrl+/) ========== */
    await step('快捷键帮助:Ctrl+/ 打开,Esc 关闭', async () => {
      await js(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'/', ctrlKey:true, bubbles:true}))`);
      const w = await waitFor('shortcuts open', `var s=document.querySelector('.cmdk');
        var rows = s ? s.querySelectorAll('.shortcut-row').length : 0;
        return {ok: rows >= 5, detail: 'rows='+rows};`, 5_000);
      if (!w[0]) return w;
      await shot('shortcuts');
      await js(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
      return waitFor('shortcuts closed', `return {ok: !document.querySelector('.cmdk-overlay'), detail: 'closed'};`, 5_000);
    });

    /* ========== fake:侧栏收缩 + 状态过滤 ========== */
    await step('侧栏收缩:⇤ 收起左栏,⇥ 展开恢复', async () => {
      // HIG P3 组2:⇤/⇥ Emoji 已换 SVG icon,按钮以 aria-label(含"侧栏")定位
      const w = await waitFor('toggle btn', `var b=[].slice.call(document.querySelectorAll('.topbar button')).find(function(x){return (x.getAttribute('aria-label')||'').indexOf('侧栏')>=0;});
        return {ok: !!b, detail: 'btn='+(b?b.getAttribute('aria-label'):'none')};`, 5_000);
      if (!w[0]) return w;
      await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.topbar button')).find(function(x){return (x.getAttribute('aria-label')||'').indexOf('侧栏')>=0;}); if(b) b.click(); })()`);
      const hidden = await waitFor('sidebar hidden', `var sb=document.querySelector('.sidebar');
        var gone = !sb || getComputedStyle(sb).display === 'none';
        return {ok: gone, detail: 'display='+(sb?getComputedStyle(sb).display:'none')};`, 5_000);
      await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.topbar button')).find(function(x){return (x.getAttribute('aria-label')||'').indexOf('侧栏')>=0;}); if(b) b.click(); })()`);
      const shown = await waitFor('sidebar back', `var sb=document.querySelector('.sidebar');
        return {ok: !!sb && getComputedStyle(sb).display !== 'none', detail: 'display='+(sb?getComputedStyle(sb).display:'none')};`, 5_000);
      return [hidden[0] && shown[0], `hide: ${hidden[1]}; show: ${shown[1]}`];
    });
    await step('状态过滤:下拉切换到"运行中"不崩溃并恢复', async () => {
      const sel = await waitFor('filter select', `var s=document.querySelector('.status-filter');
        return {ok: !!s && s.options.length >= 4, detail: 'options='+(s?s.options.length:0)};`, 5_000);
      if (!sel[0]) return sel;
      await js(`(function(){ var s=document.querySelector('.status-filter'); s.value='running'; s.dispatchEvent(new Event('change',{bubbles:true})); })()`);
      await sleep(500);
      const r1 = (await js(`document.querySelectorAll('.session-item').length`)) as number;
      await js(`(function(){ var s=document.querySelector('.status-filter'); s.value='all'; s.dispatchEvent(new Event('change',{bubbles:true})); })()`);
      await sleep(500);
      const r2 = (await js(`document.querySelectorAll('.session-item').length`)) as number;
      return [r2 >= r1 && r2 >= 1, `running=${r1} all=${r2}`];
    });

    /* ========== fake:模型选择器(顶栏切换 chat 路由) ========== */
    await step('模型选择器:顶栏菜单列出 providers 并可切换', async () => {
      const w = await waitFor('model button', `var b=document.querySelector('.topbar-model.as-button');
        return {ok: !!b && b.disabled === false, detail: b ? b.textContent : 'none'};`, 6_000);
      if (!w[0]) return w;
      await js(`(function(){ var b=document.querySelector('.topbar-model.as-button'); if(b) b.click(); })()`);
      const m = await waitFor('model menu', `var m=document.querySelector('.model-menu');
        var items = m ? m.querySelectorAll('.ws-menu-item').length : 0;
        var cur = m ? m.querySelectorAll('.ws-menu-item.current').length : 0;
        return {ok: items >= 2 && cur >= 1, detail: 'items='+items+' current='+cur};`, 5_000);
      if (!m[0]) return m;
      await shot('model-menu');
      // 切到第二个 provider(fake: demo-vision/fake-m-vision)
      await js(`(function(){ var its=[].slice.call(document.querySelectorAll('.model-menu .ws-menu-item')); var it=its[its.length-1]; if(it) it.click(); })()`);
      return waitFor('model switched', `var b=document.querySelector('.topbar-model.as-button');
        return {ok: !!b && b.textContent.indexOf('fake-m-vision') >= 0, detail: 'badge='+(b?b.textContent:'none')};`, 6_000);
    });

    /* ========== fake:主题(浅色生效→恢复深色) ========== */
    await step('主题:设置切浅色生效,恢复深色', async () => {
      await js(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'p', ctrlKey:true, shiftKey:true, bubbles:true}))`);
      const w = await waitFor('settings open', `var s=document.querySelector('.cmdk.settings');
        return {ok: !!s, detail: s ? 'open' : 'not open'};`, 5_000);
      if (!w[0]) return w;
      await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.cmdk.settings .seg button')).find(function(x){return x.textContent.trim()==='浅色'||x.textContent.trim()==='Light';}); if(b) b.click(); })()`);
      const light = await waitFor('light theme', `var dt=document.documentElement.dataset.theme;
        var bg = getComputedStyle(document.body).backgroundColor;
        var m = /\\d+/g; var nums=(bg.match(m)||['0','0','0']).map(Number);
        return {ok: dt==='light' && nums[0]>200 && nums[1]>200 && nums[2]>200, detail: 'theme='+dt+' bg='+bg};`, 5_000);
      await shot('light-theme');
      await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.cmdk.settings .seg button')).find(function(x){return x.textContent.trim()==='深色'||x.textContent.trim()==='Dark';}); if(b) b.click(); })()`);
      const dark = await waitFor('dark back', `return {ok: document.documentElement.dataset.theme==='dark', detail: 'theme='+document.documentElement.dataset.theme};`, 5_000);
      await js(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
      return [light[0] && dark[0], `light: ${light[1]}; dark: ${dark[1]}`];
    });

    /* ========== fake:顶栏 中/EN 快捷切换(可发现性) ========== */
    await step('顶栏快捷切换:中/EN 一键切换', async () => {
      const w = await waitFor('lang seg', `var s=document.querySelector('.lang-seg');
        return {ok: !!s && s.querySelectorAll('button').length === 2, detail: s ? 'present' : 'absent'};`, 5_000);
      if (!w[0]) return w;
      await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.lang-seg button')).find(function(x){return x.textContent.trim()==='EN';}); if(b) b.click(); })()`);
      const en = await waitFor('english', `var b=document.querySelector('.sidebar-head .btn.primary');
        return {ok: !!b && b.textContent === '+ New Session', detail: 'btn='+(b?b.textContent:'none')};`, 5_000);
      await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.lang-seg button')).find(function(x){return x.textContent.trim()==='中';}); if(b) b.click(); })()`);
      const zh = await waitFor('chinese back', `var b=document.querySelector('.sidebar-head .btn.primary');
        return {ok: !!b && b.textContent === '+ 新建会话', detail: 'btn='+(b?b.textContent:'none')};`, 5_000);
      return [en[0] && zh[0], `en: ${en[1]}; zh: ${zh[1]}`];
    });

    /* ========== fake:粘贴图片 → 缩略图 chip → 发送 → runtime 收到 ========== */
    await step('粘贴图片:缩略图 chip + 发送后 runtime 收到图片', async () => {
      // 新建会话确保 composer 可用
      await js(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'n', ctrlKey:true, bubbles:true}))`);
      await sleep(300);
      await js(`(function(){
        var ta = document.querySelector('.composer textarea');
        if (!ta) return;
        var c = document.createElement('canvas');
        c.width = 8; c.height = 8;
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#3f9650'; ctx.fillRect(0, 0, 8, 8);
        c.toBlob(function(blob){
          var dt = new DataTransfer();
          dt.items.add(new File([blob], 'pasted.png', {type: 'image/png'}));
          ta.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true}));
        }, 'image/png');
      })()`);
      const chip = await waitFor('image chip', `var n=document.querySelectorAll('.att-chip.img').length;
        return {ok: n >= 1, detail: 'img chips='+n};`, 6_000);
      if (!chip[0]) return chip;
      await typeInto('.composer textarea', '看这张图');
      await sleep(200);
      await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.composer button')).find(function(x){return x.textContent.trim()==='发送';}); if(b) b.click(); })()`);
      const done = await waitFor('image sent', `
        var ap = document.querySelector('.approval-card button');
        if (ap && ap.textContent.trim().indexOf('批准')>=0) ap.click();
        var ts=[].slice.call(document.querySelectorAll('.turn'));
        var hit = ts.filter(function(x){ return x.className.indexOf('user')<0 && x.textContent.indexOf('[images: 1]') >= 0; });
        return {ok: hit.length >= 1, detail: 'runtime-echo-with-image='+hit.length};
      `, 15_000);
      await shot('pasted-image');
      return done;
    });

    /* ========== fake:📎 上传/📁 浏览按钮就位 ========== */
    await step('附件与目录入口:📎 上传 + 📁 浏览按钮存在', async () => {
      const r = (await js(`(function(){
        var up = document.querySelector('.composer button[aria-label*="上传"], .composer button[aria-label*="Upload"]');
        var br = document.querySelector('.ws-picker button');
        return JSON.stringify({up: !!up, browse: !!br});
      })()`)) as string;
      const p = JSON.parse(r) as { up: boolean; browse: boolean };
      return [p.up && p.browse, `📎=${p.up} 📁=${p.browse}`];
    });

    /* ========== fake:@ 附件选择器 ========== */
    await step('@ 附件:选择器出现并可选文件', async () => {
      await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.composer button')).find(function(x){return x.textContent.trim()==='@';}); if(b) b.click(); })()`);
      const w = await waitFor('att picker', `var p=document.querySelector('.att-picker');
        return {ok: !!p, detail: p ? 'open' : 'not open'};`, 5_000);
      if (!w[0]) return w;
      await typeInto('.att-picker input', 'read');
      const w2 = await waitFor('att results', `var r=document.querySelectorAll('.att-results .fs-row').length;
        return {ok: r >= 1, detail: 'results='+r};`, 6_000);
      if (!w2[0]) return w2;
      await js(`(function(){ var f=document.querySelector('.att-results .fs-row'); if(f) f.click(); })()`);
      return waitFor('att chip', `var c=document.querySelectorAll('.att-chip').length;
        return {ok: c >= 1, detail: 'chips='+c};`, 5_000);
    });

    /* ========== fake(向导构造):设置「重新配置」重入 + 选择持久 ========== */
    if (process.env.HMH_DESKTOP_UIVERIFY_WIZARD === 'fake') {
      await step('向导:设置「重新配置」重入 + 选择持久(wizard.json)', async () => {
        await js(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'p', ctrlKey:true, shiftKey:true, bubbles:true}))`);
        const open = await waitFor('settings open', `var s=document.querySelector('.cmdk.settings');
          return {ok: !!s, detail: s ? 'open' : 'closed'};`, 5_000);
        if (!open[0]) return open;
        await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.cmdk.settings button')).find(function(x){return x.textContent.indexOf('重新配置')>=0;}); if(b) b.click(); })()`);
        const shown = await waitFor('wizard reopened', `return {ok: !!document.querySelector('.wizard-overlay'),
          detail: document.querySelector('.wizard-overlay') ? 'open' : 'closed'};`, 5_000);
        if (!shown[0]) return shown;
        await shot('wizard-reentry');
        await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.wizard-overlay button')).find(function(x){return x.textContent.trim()==='取消';}); if(b) b.click(); })()`);
        const closed = await waitFor('wizard closed', `return {ok: !document.querySelector('.wizard-overlay'), detail: 'closed'};`, 5_000);
        const st = (await js(`window.hmh.getWizard().then(function(r){return JSON.stringify(r);})`)) as string;
        const p = JSON.parse(st) as { persisted?: { done?: boolean; choice?: string } };
        const persisted = p.persisted?.done === true && p.persisted?.choice === 'bundled';
        return [closed[0] && persisted, `closed=${closed[0]} persisted=${JSON.stringify(p.persisted ?? null)}`];
      });

      /* ========== fake(向导构造):窄屏 360×640 全元素可达 + 单击选项即前进 ==========
         用户手机实测痛点:窄视口下选项/按钮被裁切点不到。伪造"检测到已装"
         (主进程 env 即时读)让向导出现三选项路径,缩到 360×640 后逐个
         elementFromPoint 断言(不是被裁切);再验证单击前进与取消。 */
      await step('向导:窄屏 360×640——三选项(含 note 整栏)与按钮全部可命中+单击即前进', async () => {
        process.env.HMH_DESKTOP_UIVERIFY_FAKE_DETECT_FOUND = '1';
        const size0 = win.getSize();
        const w0 = size0[0] ?? 1280;
        const h0 = size0[1] ?? 800;
        try {
          await js(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'p', ctrlKey:true, shiftKey:true, bubbles:true}))`);
          const open = await waitFor('settings open', `var s=document.querySelector('.cmdk.settings'); return {ok: !!s, detail: s ? 'open' : 'closed'};`, 5_000);
          if (!open[0]) return open;
          await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.cmdk.settings button')).find(function(x){return x.textContent.indexOf('重新配置')>=0;}); if(b) b.click(); })()`);
          const shown = await waitFor('wizard reopened', `return {ok: !!document.querySelector('.wizard-overlay'), detail: document.querySelector('.wizard-overlay') ? 'open' : 'closed'};`, 5_000);
          if (!shown[0]) return shown;
          await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.wizard-overlay button')).find(function(x){return x.textContent.trim()==='开始配置';}); if(b) b.click(); })()`);
          const detectPage = await waitFor('detect found page(3 options)', `var p=document.querySelector('.wizard-card.wizard-page-detect');
            var opts=p?p.querySelectorAll('.wizard-opt').length:0;
            return {ok: !!p && opts===3, detail: 'opts='+opts};`, 12_000);
          if (!detectPage[0]) return detectPage;
          // 单击选项即前进:点"仍要下载新版"应直接落到选择页(无需再点"下一步")
          await js(`(function(){ var o=[].slice.call(document.querySelectorAll('.wizard-opt')).find(function(x){return x.textContent.indexOf('仍要下载新版')>=0;}); if(o) o.click(); })()`);
          const selectPage = await waitFor('select page via single click', `var p=document.querySelector('.wizard-card.wizard-page-select');
            return {ok: !!p && p.querySelectorAll('.wizard-opt').length===3, detail: p ? 'select' : 'not select'};`, 6_000);
          if (!selectPage[0]) return [false, `单击选项未前进到选择页: ${selectPage[1]}`];
          // 缩到 360×640(minWidth 已在 UIVERIFY 下放宽),断言全部可命中
          win.setSize(360, 640);
          await sleep(500);
          const r = (await js(`(function(){
            function hit(el){ el.scrollIntoView({block:'nearest'}); var r=el.getBoundingClientRect();
              var x=r.left+r.width/2, y=r.top+r.height/2;
              var e=document.elementFromPoint(x,y);
              return !!(e && (e===el || el.contains(e))); }
            var card=document.querySelector('.wizard-card.wizard-page-select');
            var opts=[].slice.call(card.querySelectorAll('.wizard-opt'));
            var optHit=opts.map(hit);
            var notes=[].slice.call(card.querySelectorAll('.wizard-opt-note'));
            var noteHit=notes.map(function(n){ n.scrollIntoView({block:'nearest'}); var r=n.getBoundingClientRect();
              var e=document.elementFromPoint(r.left+r.width/2, r.top+Math.min(r.height/2, 8));
              return !!(e && opts.some(function(o){ return e===o || o.contains(e); })); });
            var act=document.querySelector('.wizard-card.wizard-page-select .wizard-actions .btn.primary');
            var footer=[].slice.call(document.querySelectorAll('.wizard-footer button'));
            return JSON.stringify({vw: window.innerWidth, vh: window.innerHeight, opts: opts.length,
              optHit: optHit, noteHit: noteHit, actHit: act ? hit(act) : false, ftHit: footer.map(hit)});
          })()`)) as string;
          const q = JSON.parse(r) as { vw: number; vh: number; opts: number; optHit: boolean[]; noteHit: boolean[]; actHit: boolean; ftHit: boolean[] };
          await shot('wizard-narrow-360-select');
          const narrowOk = q.opts === 3 && q.vw <= 380 && q.optHit.every(Boolean) && q.noteHit.every(Boolean) && q.actHit && q.ftHit.every(Boolean);
          // 窄屏下单击选项① = 选中并前进到安装页(verify 模拟进度,不落盘)
          await js(`(function(){ var o=[].slice.call(document.querySelectorAll('.wizard-opt')).find(function(x){return x.textContent.indexOf('下载安装完整 hmh CLI')>=0;}); if(o) o.click(); })()`);
          const adv = await waitFor('install page via single click', `var p=document.querySelector('.wizard-card.wizard-page-install');
            return {ok: !!p, detail: p ? 'installing' : 'not shown'};`, 6_000);
          await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.wizard-overlay button')).find(function(x){return x.textContent.trim()==='取消';}); if(b) b.click(); })()`);
          const closedNarrow = await waitFor('wizard closed at 360px', `return {ok: !document.querySelector('.wizard-overlay'), detail: 'closed'};`, 5_000);
          return [narrowOk && adv[0] && closedNarrow[0],
            `vp=${q.vw}x${q.vh} opts=${q.opts} optHit=[${q.optHit.join(',')}] noteHit=[${q.noteHit.join(',')}] 主按钮=${q.actHit} footer=[${q.ftHit.join(',')}]; 单击前进: ${adv[1]}; 窄屏取消: ${closedNarrow[1]}`];
        } finally {
          win.setSize(w0, h0);
          process.env.HMH_DESKTOP_UIVERIFY_FAKE_DETECT_FOUND = undefined;
        }
      });
    }

    await shot('final');
  } else if ((process.env.HMH_DESKTOP_UIVERIFY_WIZARD ?? '') !== '') {
    /* ========== real(向导构造,互斥于常规 real 步骤):
       WZ2 本机真实检测(默认共享页)/ WZ3 下载安装实测 ========== */
    if (process.env.HMH_DESKTOP_UIVERIFY_WIZARD === 'detect') {
      await step('向导(真实):欢迎→检测到本机已装 CLI(默认共享,勾选正确)', async () => {
        const w = await waitFor('wizard overlay', `var o=document.querySelector('.wizard-overlay');
          var b=[].slice.call(document.querySelectorAll('.wizard-overlay button')).find(function(x){return x.textContent.trim()==='开始配置';});
          return {ok: !!o && !!b, detail: o ? 'overlay+开始配置' : 'no overlay'};`, 12_000);
        if (!w[0]) return w;
        await shot('wizard-real-welcome');
        await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.wizard-overlay button')).find(function(x){return x.textContent.trim()==='开始配置';}); if(b) b.click(); })()`);
        const found = await waitFor('detect found', `var p=document.querySelector('.wizard-card.wizard-page-detect');
          if(!p) return {ok:false, detail:'detect page not shown'};
          var t=p.textContent;
          var ok1=t.indexOf('检测到已安装 hmharness v')>=0;
          var ok2=t.indexOf('默认共享使用它(推荐)')>=0;
          var radio=p.querySelector('.wizard-opt.on');
          return {ok: ok1&&ok2&&!!radio, detail: t.replace(/\\s+/g,' ').slice(0,90)};`, 20_000);
        await shot('wizard-real-detect');
        return found;
      });
    } else if (process.env.HMH_DESKTOP_UIVERIFY_WIZARD === 'install') {
      await step('向导(真实):检测→仍要下载新版→选择①→进入安装页', async () => {
        const w = await waitFor('wizard overlay', `var o=document.querySelector('.wizard-overlay');
          return {ok: !!o, detail: o ? 'open' : 'closed'};`, 12_000);
        if (!w[0]) return w;
        await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.wizard-overlay button')).find(function(x){return x.textContent.trim()==='开始配置';}); if(b) b.click(); })()`);
        const found = await waitFor('detect found', `var p=document.querySelector('.wizard-card.wizard-page-detect');
          return {ok: !!p && p.textContent.indexOf('检测到已安装 hmharness v')>=0, detail: p ? p.textContent.replace(/\\s+/g,' ').slice(0,60) : 'no detect page'};`, 20_000);
        if (!found[0]) return found;
        await js(`(function(){ var o=[].slice.call(document.querySelectorAll('.wizard-opt')).find(function(x){return x.textContent.indexOf('仍要下载新版')>=0;}); if(o) o.click(); })()`);
        await sleep(200);
        await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.wizard-overlay button')).find(function(x){return x.textContent.trim()==='下一步';}); if(b) b.click(); })()`);
        const sel = await waitFor('select page ① on', `var p=document.querySelector('.wizard-card.wizard-page-select');
          var on=p?p.querySelector('.wizard-opt.on'):null;
          return {ok: !!p && !!on && on.textContent.indexOf('下载安装完整 hmh CLI')>=0, detail: p ? 'select ① on' : 'no select'};`, 8_000);
        if (!sel[0]) return sel;
        await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.wizard-overlay button')).find(function(x){return x.textContent.trim()==='开始安装';}); if(b) b.click(); })()`);
        return waitFor('install page', `var p=document.querySelector('.wizard-card.wizard-page-install');
          return {ok: !!p, detail: p ? 'installing' : 'not shown'};`, 8_000);
      });
      await step('向导(真实):安装进度可见(步骤文案/下载百分比滚动)', async () => {
        const w = await waitFor('progress visible', `var bar=document.querySelector('.wizard-progress');
          var log=document.querySelector('.wizard-install-log');
          var lines=log?log.textContent.split('\\n').filter(function(x){return x.trim()!=='';}):[];
          return {ok: !!bar && lines.length>=1, detail: 'bar='+(bar?'y':'n')+' lines='+lines.length+(lines.length>0?(' last='+(lines[lines.length-1]||'').slice(0,50)):'')};`, 60_000);
        await shot('wizard-real-install');
        return w;
      });
      await step('向导(真实):安装完成→配置跳过(已有密钥)→完成页→开始使用→新 runtime 连接', async () => {
        // 安装全程(npm 解析+下载+落盘;镜像 npmmirror 通常 <2 分钟),上限 8 分钟
        await waitFor('done page', `var d=document.querySelector('.wizard-card.wizard-page-done');
          if(d) return {ok:true, detail:'done'};
          var c=document.querySelector('.wizard-card.wizard-page-config');
          if(c){ var s=[].slice.call(document.querySelectorAll('.wizard-overlay button')).find(function(x){return x.textContent.indexOf('跳过')>=0;}); if(s) s.click(); }
          var err=document.querySelector('.wizard-error');
          if(err) return {ok:false, detail:'install error: '+err.textContent.slice(0,80)};
          return {ok:false, detail:'installing…'};`, 8 * 60_000);
        const w = await waitFor('done ready text', `var d=document.querySelector('.wizard-card.wizard-page-done');
          var t=d?d.textContent:'';
          return {ok: !!d && t.indexOf('就绪')>=0, detail: t.replace(/\\s+/g,' ').slice(0,60)};`, 10_000);
        if (!w[0]) return w;
        await shot('wizard-real-done');
        await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.wizard-overlay button')).find(function(x){return x.textContent.trim()==='开始使用';}); if(b) b.click(); })()`);
        const connected = await waitFor('new runtime connected', `var dot=document.querySelector('.host-dot.on');
          var l=document.querySelector('.host-label');
          return {ok: !!dot && !!l && l.textContent.indexOf('runtime')>=0, detail: 'dot='+(dot?'on':'off')+' label='+(l?l.textContent.replace(/\\s+/g,' ').slice(0,50):'none')};`, 60_000);
        const st = (await js(`window.hmh.getState().then(function(r){return JSON.stringify({mode:r.mode, runtimeEntry:r.runtimeEntry});})`)) as string;
        const p = JSON.parse(st) as { mode?: string; runtimeEntry?: string | null };
        const entryOk = (p.runtimeEntry ?? '').indexOf('.hmharness-global') >= 0;
        await shot('wizard-real-final');
        return [connected[0] && entryOk, `connected: ${connected[1]}; state=${st.slice(0, 90)}`];
      });
    }
    await shot('final');
  } else {
    /* ========== real:只读子集(不动真实会话) ========== */
    await step('顶栏:runtime 版本与端口已显示(非 ?)', async () => {
      return waitFor('host label', `var l=document.querySelector('.host-label');
        var t = l ? l.textContent : '';
        return {ok: t.indexOf('?') < 0 && t.indexOf('runtime') >= 0, detail: t.replace(/\\s+/g,' ').slice(0,60)};`, 15_000);
    });
    await step('会话列表:真实历史加载(数量>0)', async () => {
      return waitFor('sessions', `var n=document.querySelectorAll('.session-item').length;
        return {ok: n > 0, detail: 'sessions='+n};`, 15_000);
    });
    await step('点击历史会话 → 真实 transcript 内容可见', async () => {
      const n = (await js(`document.querySelectorAll('.session-item').length`)) as number;
      if (n === 0) return [false, 'no sessions to click'];
      await js(`(function(){ var it=document.querySelector('.session-item'); if (it) it.click(); })()`);
      const w = await waitFor('history turns', `var ts=[].slice.call(document.querySelectorAll('.turn'));
        return {ok: ts.length >= 1, detail: 'turns='+ts.length+' first='+(ts[0]?ts[0].textContent.replace(/\\s+/g,' ').slice(0,40):'none')};`, 15_000);
      await shot('real-history');
      return w;
    });
    await step('Dock:Overview 真实数据(runtime 版本非无数据)', async () => {
      await js(`(function(){ var t=[].slice.call(document.querySelectorAll('.dock-tab')).find(function(x){return x.textContent==='Overview';}); if(t) t.click(); })()`);
      return waitFor('overview', `var rows=[].slice.call(document.querySelectorAll('.dock-row'));
        var ver = rows.find(function(r){ return r.textContent.indexOf('runtime 版本')>=0; });
        return {ok: !!ver && ver.textContent.indexOf('无数据') < 0, detail: ver ? ver.textContent.replace(/\\s+/g,' ').slice(0,50) : 'no ver row'};`, 10_000);
    });
    await step('Dock:Diff 真实 git 状态(非加载中)', async () => {
      await js(`(function(){ var t=[].slice.call(document.querySelectorAll('.dock-tab')).find(function(x){return x.textContent==='变更'||x.textContent==='Diff';}); if(t) t.click(); })()`);
      return waitFor('diff', `var p=document.querySelector('.diff-pane');
        var t = p ? p.textContent : '';
        return {ok: !!p && t.indexOf('加载中') < 0, detail: t.replace(/\\s+/g,' ').slice(0,60)};`, 15_000);
    });
    await step('Dock:Evidence 真实认知数据', async () => {
      await js(`(function(){ var t=[].slice.call(document.querySelectorAll('.dock-tab')).find(function(x){return x.textContent==='证据'||x.textContent==='Evidence';}); if(t) t.click(); })()`);
      return waitFor('evidence', `var rows=[].slice.call(document.querySelectorAll('.dock-row'));
        var mem = rows.find(function(r){ return r.textContent.indexOf('记忆层')>=0 || r.textContent.indexOf('Memory layers')>=0; });
        return {ok: !!mem && mem.textContent.indexOf('…') < 0, detail: mem ? mem.textContent.replace(/\\s+/g,' ').slice(0,50) : 'no row'};`, 15_000);
    });
    await step('附件与目录入口:📎 上传 + 顶栏中/EN + 📁 浏览按钮存在', async () => {
      await js(`(function(){ var t=[].slice.call(document.querySelectorAll('.dock-tab')).find(function(x){return x.textContent==='文件'||x.textContent==='Files';}); if(t) t.click(); })()`);
      await waitFor('files tab', `var t=document.querySelector('.dock-tab.active');
        return {ok: !!t && (t.textContent==='文件'||t.textContent==='Files'), detail: 'active='+(t?t.textContent:'none')};`, 5_000);
      // real 模式 workspaces 请求走 runtime(冷启动后可能排队),放宽到 15s
      const ws = await waitFor('ws picker', `var w=document.querySelector('.ws-picker');
        return {ok: !!w, detail: w ? 'loaded' : 'workspaces not loaded yet'};`, mode === 'real' ? 15_000 : 6_000);
      const r = (await js(`(function(){
        var up = document.querySelector('.composer button[aria-label*="上传"], .composer button[aria-label*="Upload"]');
        var lang = document.querySelector('.lang-seg');
        var br = document.querySelector('.ws-picker button');
        return JSON.stringify({up: !!up, lang: !!lang, browse: !!br});
      })()`)) as string;
      const p = JSON.parse(r) as { up: boolean; lang: boolean; browse: boolean };
      return [p.up && p.lang && p.browse, `📎=${p.up} 中/EN=${p.lang} 📁=${p.browse}; ${ws[1]}`];
    });
    /* ========== real:真实任务端到端首验(发短任务→模型回复) ==========
       用户 glm-5.3 已配置;提示词约束直接回复。若 agent 请求审批,轮询里
       自动点批准(最多见卡即点,幂等)。超时 150s。 */
    if (process.env.HMH_DESKTOP_UIVERIFY_REAL_TASK === '1') {
      await step('真实任务:发送→模型回复(端到端首验)', async () => {
        await js(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'n', ctrlKey:true, bubbles:true}))`);
        await sleep(400);
        await typeInto('.composer textarea', '请只回复两个字:收到(本次验收任务,不要使用任何工具,直接回复)');
        await sleep(200);
        await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.composer button')).find(function(x){return x.textContent.trim()==='发送';}); if(b) b.click(); })()`);
        const sent = await waitFor('user turn', `var t=document.querySelector('.turn.user');
          var s = (t && t.textContent) ? String(t.textContent) : '';
          return {ok: s.indexOf('收到')>=0 || s.indexOf('验收任务')>=0, detail: s.slice(0,30) || 'none'};`, 10_000);
        if (!sent[0]) return sent;
        const reply = await waitFor('assistant reply', `
          var ap = document.querySelector('.approval-card button');
          if (ap && ap.textContent.trim().indexOf('批准')>=0) ap.click();
          var ts=[].slice.call(document.querySelectorAll('.turn')).filter(function(x){ return x.className.indexOf('user')<0 && x.className.indexOf('approval')<0 && x.className.indexOf('system')<0 && x.textContent.trim().length>0 && x.textContent.indexOf('回合')<0; });
          var sum = document.querySelector('.turn-sum');
          return {ok: ts.length>=1 && !!sum, detail: 'assistant='+ts.length+' sum='+(sum?sum.textContent:'none')+' first='+(ts[0]?ts[0].textContent.replace(/\\s+/g,' ').slice(0,40):'none')};
        `, 150_000);
        await shot('real-task');
        return reply;
      });
    }
    await step('会话分组:左栏按工作区分组(组头可见)', async () => {
      return waitFor('group head', `var h=document.querySelector('.ws-group-head');
        var n = h ? (h.querySelector('.ws-group-name')||{}).textContent : '';
        return {ok: !!h && n.length > 0, detail: 'name='+n};`, 15_000);
    });
    await step('工作区:左栏工作区栏可见(真实工作区名)', async () => {
      return waitFor('workspace bar', `var b=document.querySelector('.workspace-bar');
        var n = b ? (b.querySelector('.ws-bar-name')||{}).textContent : '';
        return {ok: !!b && !!n && n.length > 0 && n.indexOf('加载') < 0 && n.indexOf('Loading') < 0, detail: 'name='+n};`, 15_000);
    });
    await shot('final');
  }

  const failed = results.filter((r) => !r[1]).length;
  console.log(`UIVERIFY SUMMARY pass=${results.length - failed}/${results.length} mode=${mode} shots=${shots}`);
  app.exit(failed === 0 ? 0 : 1);
}

export function attachUiVerify(win: BrowserWindow): void {
  const mode = process.env.HMH_DESKTOP_UIVERIFY_MODE === 'real' ? 'real' : 'fake';
  win.webContents.once('did-finish-load', () => {
    // 给 host 启动留时间;步骤内部各自轮询等待
    setTimeout(() => { void runUiVerify(win, mode); }, 3_000);
  });
}
