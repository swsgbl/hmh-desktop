/**
 * v5.1 首启安装向导(Setup Wizard)。
 *
 * 成熟安装器流程:欢迎 → 检测(自动,复用 main 发现链)→ 选择(检测到时
 * 默认共享 / 未检测到三选一)→ 安装进度(下载 %/解压/npm 步骤文案,
 * 失败重试+换源)→ Provider 配置(已有密钥自动跳过)→ 完成。
 * 选择持久化在 main(wizard.json + runtime.json);全程上一步/取消;
 * 设置面板「重新配置」可重入。全局配置语义(~/.hmharness 共享)在选择页与
 * 完成页明示(v1 不做用户级隔离切换,文案只诚实说明共享)。
 */
import { useEffect, useRef, useState } from 'react';
import { bridge, type DetectRuntimeDto, type InstallProgressDto } from './bridge.ts';
import type { Strings } from './i18n.ts';

type WizardPage = 'welcome' | 'detect' | 'select' | 'install' | 'config' | 'done';
type Choice = 'external' | 'install' | 'bundled' | 'demo';

const PAGE_ORDER: WizardPage[] = ['welcome', 'detect', 'select', 'install', 'config', 'done'];

export function SetupWizard({ L, hostState, onClose }: { L: Strings; hostState: string; onClose: () => void }): React.ReactElement {
  const [page, setPage] = useState<WizardPage>('welcome');
  const [detect, setDetect] = useState<DetectRuntimeDto | null>(null);
  const [detectChoice, setDetectChoice] = useState<'use' | 'new' | 'bundled'>('use');
  const [opt, setOpt] = useState<'install' | 'bundled' | 'demo'>('install');
  const [install, setInstall] = useState<{ p: InstallProgressDto | null; lines: string[]; entry: string }>({ p: null, lines: [], entry: '' });
  const [mirrorFirst, setMirrorFirst] = useState<'npmjs' | 'npmmirror'>('npmjs');
  const [providersReady, setProvidersReady] = useState<boolean | null>(null);
  const [form, setForm] = useState({ name: '', baseUrl: '', model: '', apiKey: '' });
  const [formHint, setFormHint] = useState('');
  const [choice, setChoice] = useState<Choice>('bundled');
  const choiceEntry = useRef('');
  const pageRef = useRef<WizardPage>('welcome');
  pageRef.current = page;

  const go = (p: WizardPage): void => { setPage(p); };
  /** 上一步(安装页运行中/完成后不回退,避免重复安装歧义)。 */
  const back = (): void => {
    if (page === 'detect') go('welcome');
    else if (page === 'select') go(detect?.found === true ? 'detect' : 'welcome');
    else if (page === 'config') go(detect?.found === true && choice !== 'install' ? 'detect' : 'select');
  };
  const backDisabled = page === 'welcome' || page === 'done' || page === 'install';

  /* ---- 检测页:进入即扫描;未检测到 → 自动进选择页 ---- */
  useEffect(() => {
    if (page !== 'detect' || bridge === undefined) return;
    let alive = true;
    void bridge.detectRuntime().then((r) => {
      if (!alive || !('found' in r)) return;
      setDetect(r);
      if (!r.found) {
        setTimeout(() => { if (alive && pageRef.current === 'detect') go('select'); }, 700);
      }
    });
    return () => { alive = false; };
  }, [page]);

  /* ---- 安装进度(组件级订阅:安装跨页继续,后台跑完也生效) ---- */
  useEffect(() => {
    if (bridge === undefined) return;
    const off = bridge.onInstallProgress((p) => {
      setInstall((prev) => ({
        p,
        lines: [...prev.lines.slice(-7), p.text],
        entry: p.phase === 'done' && p.entry !== undefined ? p.entry : prev.entry,
      }));
      if (p.phase === 'done') {
        setChoice('install');
        choiceEntry.current = p.entry ?? '';
        setTimeout(() => { if (pageRef.current === 'install') go('config'); }, 600);
      }
    });
    return off;
  }, []);

  const startInstall = (m: 'npmjs' | 'npmmirror'): void => {
    setInstall({ p: null, lines: [], entry: '' });
    if (bridge !== undefined) void bridge.installCli({ mirrorFirst: m });
  };

  /* ---- 配置页:等 host ready → 查 providers(已有密钥自动跳过) ---- */
  useEffect(() => {
    if (page !== 'config' || bridge === undefined) return;
    if (hostState !== 'ready') { setProvidersReady(null); return; }
    let alive = true;
    void bridge.providers().then((r) => {
      if (!alive || !('providersDetail' in r)) return;
      if (r.providersDetail?.some((p) => p.hasKey) === true) {
        setProvidersReady(true);
        setTimeout(() => { if (alive && pageRef.current === 'config') go('done'); }, 500);
      } else {
        setProvidersReady(false);
      }
    });
    return () => { alive = false; };
  }, [page, hostState]);

  /* ---- 收尾 ---- */
  const demoNow = (): void => {
    setChoice('demo');
    if (bridge !== undefined) void bridge.wizardComplete('demo');
    onClose();
  };
  const finish = (): void => {
    if (bridge !== undefined) void bridge.wizardComplete(choice, choiceEntry.current);
    onClose();
  };
  const saveProvider = async (): Promise<void> => {
    if (bridge === undefined) return;
    const { name, baseUrl, model, apiKey } = form;
    if (name === '' || baseUrl === '' || model === '') { setFormHint(L.settings.required); return; }
    const r = await bridge.providerSave(apiKey === '' ? { name, baseUrl, model } : { name, baseUrl, model, apiKey });
    if ('ok' in r && r.ok === true) go('done');
    else setFormHint(L.settings.saveFailed('error' in r ? r.error : 'unknown'));
  };

  const confirmDetect = (): void => {
    if (detectChoice === 'use') {
      setChoice('external');
      choiceEntry.current = detect?.entry ?? '';
      go('config');
    } else if (detectChoice === 'new') {
      setOpt('install');
      go('select');
    } else {
      setChoice('bundled');
      go('config');
    }
  };
  const confirmSelect = (): void => {
    if (opt === 'install') {
      setChoice('install');
      go('install');
      startInstall(mirrorFirst);
    } else if (opt === 'bundled') {
      setChoice('bundled');
      go('config');
    } else {
      demoNow();
    }
  };

  const stepIdx = PAGE_ORDER.indexOf(page);
  const p = install.p;

  return (
    <div className="wizard-overlay" role="dialog" aria-label={L.wizard.dialogAria}>
      <div className={`wizard-card wizard-page-${page}`}>
        <div className="wizard-brand" aria-hidden="true">⬢</div>
        <div className="wizard-steps" aria-hidden="true">
          {[L.wizard.stepWelcome, L.wizard.stepDetect, L.wizard.stepSelect, L.wizard.stepInstall, L.wizard.stepConfig, L.wizard.stepDone].map((s, i) => (
            <span key={s} className={`wizard-step${i === stepIdx ? ' on' : i < stepIdx ? ' past' : ''}`}>{s}</span>
          ))}
        </div>

        {page === 'welcome' && (
          <section className="wizard-body">
            <h2 className="wizard-title">{L.wizard.welcomeTitle}</h2>
            <p className="wizard-text">{L.wizard.welcomeText}</p>
            <div className="wizard-actions">
              <button className="btn primary" onClick={() => go('detect')}>{L.wizard.start}</button>
              <button className="btn ghost" onClick={demoNow}>{L.wizard.demoFirst}</button>
            </div>
          </section>
        )}

        {page === 'detect' && (
          <section className="wizard-body">
            <h2 className="wizard-title">{L.wizard.stepDetect}</h2>
            {detect === null && <p className="wizard-text">{L.wizard.detecting}</p>}
            {detect !== null && detect.found && (
              <>
                <div className="wizard-detect-found">
                  <div className="wizard-opt-title">{L.wizard.detectFound(detect.version !== '' ? `v${detect.version}` : '')}</div>
                  <p className="wizard-opt-note">{L.wizard.detectFoundNote} · {detect.entry}</p>
                </div>
                <div className="wizard-opt-list" role="radiogroup" aria-label={L.wizard.stepDetect}>
                  <button role="radio" aria-checked={detectChoice === 'use'} className={`wizard-opt${detectChoice === 'use' ? ' on' : ''}`} onClick={() => setDetectChoice('use')}>
                    <span className="wizard-radio" aria-hidden="true" />
                    <span className="wizard-opt-title">{L.wizard.useDetected}</span>
                  </button>
                  <button role="radio" aria-checked={detectChoice === 'new'} className={`wizard-opt${detectChoice === 'new' ? ' on' : ''}`} onClick={() => setDetectChoice('new')}>
                    <span className="wizard-radio" aria-hidden="true" />
                    <span className="wizard-opt-title">{L.wizard.downloadNew}</span>
                  </button>
                  <button role="radio" aria-checked={detectChoice === 'bundled'} className={`wizard-opt${detectChoice === 'bundled' ? ' on' : ''}`} onClick={() => setDetectChoice('bundled')}>
                    <span className="wizard-radio" aria-hidden="true" />
                    <span className="wizard-opt-title">{L.wizard.useBundled}</span>
                  </button>
                </div>
                <div className="wizard-actions">
                  <button className="btn primary" onClick={confirmDetect}>{L.wizard.next}</button>
                </div>
              </>
            )}
          </section>
        )}

        {page === 'select' && (
          <section className="wizard-body">
            <h2 className="wizard-title">{L.wizard.selectTitle}</h2>
            <div className="wizard-opt-list" role="radiogroup" aria-label={L.wizard.selectTitle}>
              <button role="radio" aria-checked={opt === 'install'} className={`wizard-opt${opt === 'install' ? ' on' : ''}`} onClick={() => setOpt('install')}>
                <span className="wizard-radio" aria-hidden="true" />
                <span className="wizard-opt-title">① {L.wizard.optInstall}</span>
                <span className="wizard-opt-note">{L.wizard.optInstallNote}</span>
              </button>
              <button role="radio" aria-checked={opt === 'bundled'} className={`wizard-opt${opt === 'bundled' ? ' on' : ''}`} onClick={() => setOpt('bundled')}>
                <span className="wizard-radio" aria-hidden="true" />
                <span className="wizard-opt-title">② {L.wizard.optBundled}</span>
                <span className="wizard-opt-note">{L.wizard.optBundledNote(detect?.bundled.version !== '' ? `v${detect?.bundled.version}` : '')}</span>
              </button>
              <button role="radio" aria-checked={opt === 'demo'} className={`wizard-opt${opt === 'demo' ? ' on' : ''}`} onClick={() => setOpt('demo')}>
                <span className="wizard-radio" aria-hidden="true" />
                <span className="wizard-opt-title">③ {L.wizard.optDemo}</span>
                <span className="wizard-opt-note">{L.wizard.optDemoNote}</span>
              </button>
            </div>
            <p className="wizard-note">{L.wizard.globalHomeNote}</p>
            <div className="wizard-actions">
              <button className="btn primary" onClick={confirmSelect}>{opt === 'install' ? L.wizard.startInstall : L.wizard.next}</button>
            </div>
          </section>
        )}

        {page === 'install' && (
          <section className="wizard-body">
            <h2 className="wizard-title">{p?.phase === 'error' ? L.wizard.installFailed : p?.phase === 'done' ? L.wizard.installDone : L.wizard.installing}</h2>
            {p?.phase !== 'error' && (
              <>
                <div className={`wizard-progress${p?.pct === undefined ? ' indeterminate' : ''}`}>
                  <div className="wizard-progress-fill" style={p?.pct !== undefined ? { width: `${Math.min(100, Math.max(0, p.pct))}%` } : undefined} />
                </div>
                <p className="wizard-text">{p?.text ?? L.wizard.detecting}</p>
                {install.lines.length > 0 && (
                  <pre className="wizard-install-log">{install.lines.join('\n')}</pre>
                )}
              </>
            )}
            {p?.phase === 'error' && (
              <>
                <div className="wizard-error">{p.error ?? p.text}</div>
                <div className="wizard-actions">
                  <button className="btn primary" onClick={() => startInstall(mirrorFirst)}>{L.wizard.retry}</button>
                  <button className="btn ghost" onClick={() => { const m: 'npmjs' | 'npmmirror' = mirrorFirst === 'npmjs' ? 'npmmirror' : 'npmjs'; setMirrorFirst(m); startInstall(m); }}>{L.wizard.switchMirror}</button>
                  <button className="btn ghost" onClick={() => { setChoice('bundled'); go('config'); }}>{L.wizard.fallbackBundled}</button>
                </div>
              </>
            )}
          </section>
        )}

        {page === 'config' && (
          <section className="wizard-body">
            <h2 className="wizard-title">{L.wizard.configTitle}</h2>
            <p className="wizard-note">{L.wizard.configNote}</p>
            {providersReady === null && <p className="wizard-text">{hostState === 'ready' ? L.dock.loading : L.status.starting}…</p>}
            {providersReady === false && (
              <>
                <div className="wizard-form">
                  <input placeholder={L.settings.providerNamePh} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-label={L.settings.providerName} />
                  <input placeholder={L.settings.providerBaseUrlPh} value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} aria-label={L.settings.providerBaseUrl} />
                  <input placeholder={L.settings.providerModelPh} value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} aria-label={L.settings.providerModel} />
                  <input type="password" placeholder={L.settings.providerKeyPh} value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} aria-label={L.settings.providerApiKey} />
                </div>
                {formHint !== '' && <div className="wizard-note" role="status">{formHint}</div>}
                <div className="wizard-actions">
                  <button className="btn primary" onClick={() => void saveProvider()}>{L.wizard.saveAndContinue}</button>
                  <button className="btn ghost" onClick={() => go('done')}>{L.wizard.skipConfig}</button>
                </div>
              </>
            )}
          </section>
        )}

        {page === 'done' && (
          <section className="wizard-body">
            <h2 className="wizard-title">{L.wizard.doneTitle}</h2>
            <p className="wizard-text">{L.wizard.doneText}</p>
            <p className="wizard-note">{L.wizard.globalHomeNote}</p>
            <div className="wizard-actions">
              <button className="btn primary" onClick={finish}>{L.wizard.begin}</button>
            </div>
          </section>
        )}

        {page !== 'done' && (
          <footer className="wizard-footer">
            <button className="btn ghost" disabled={backDisabled} onClick={back}>{L.wizard.back}</button>
            <button className="btn ghost" onClick={onClose}>{L.wizard.cancel}</button>
          </footer>
        )}
      </div>
    </div>
  );
}
