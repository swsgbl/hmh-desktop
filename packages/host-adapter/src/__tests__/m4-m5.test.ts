/**
 * M4/M5 面板数据合同测试(fake host 层):
 * 文件浏览/预览、认知状态、历史会话预览 —— renderer 的 Files/Evidence
 * 面板与真实 hmharness 之间靠这些形状对接,漂移即红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopRuntimeSupervisor, DesktopHostClient } from '../index.ts';

const fakeHostPath = new URL('../fake-host.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

test('M4 文件面:根列表 → 目录浏览 → 文件预览', async () => {
  const sup = new DesktopRuntimeSupervisor(
    { command: process.execPath, args: ['--import', 'tsx', fakeHostPath], env: {} },
    { token: 'm4-tok' },
  );
  const ep = await sup.start();
  const c = new DesktopHostClient(`http://127.0.0.1:${ep.port}`, 'm4-tok');
  try {
    // 根(驱动器/工作区列表)
    const root = await c.getJson<{ path: string; dirs: Array<{ name: string; path: string }>; files?: Array<{ name: string }> }>('/api/fs?files=1');
    assert.equal(root.path, '');
    assert.ok(root.dirs.length > 0, '根目录有入口');

    // 子目录(files 附带)
    const sub = await c.getJson<{ path: string; dirs: unknown[]; files: Array<{ name: string; path: string; rel?: string }> }>(`/api/fs?files=1&path=${encodeURIComponent(root.dirs[0]!.path)}`);
    assert.ok(sub.path.length > 0);
    assert.ok(sub.files !== undefined && sub.files.length > 0, '带 files=1 返回文件');

    // 文件预览(文本)
    const r = await c.getJson<{ path: string; rel: string; text?: string; binary?: boolean }>(`/api/fs/read?path=${encodeURIComponent(sub.files[0]!.path)}`);
    assert.ok(typeof r.text === 'string' && r.text.length > 0, '文本预览返回');

    // 无 path 参数 → 400 结构化
    const bad = await fetch(`http://127.0.0.1:${ep.port}/api/fs/read`, { headers: { 'x-hmh-key': 'm4-tok' } });
    assert.equal(bad.status, 400);
  } finally {
    await sup.stop();
  }
});

test('M5 认知状态:结构化字段可缺(null),不假填', async () => {
  const sup = new DesktopRuntimeSupervisor(
    { command: process.execPath, args: ['--import', 'tsx', fakeHostPath], env: {} },
    { token: 'm5-tok' },
  );
  const ep = await sup.start();
  const c = new DesktopHostClient(`http://127.0.0.1:${ep.port}`, 'm5-tok');
  try {
    const cog = await c.getJson<Record<string, unknown>>('/api/cognitive');
    assert.equal(typeof cog.trajectories, 'number');
    const wm = cog.worldModel as { brier?: unknown } | undefined;
    assert.ok(wm === undefined || wm.brier === undefined || typeof wm.brier === 'number' || wm.brier === null, 'brier 是数字或 null(NEEDS-DATA),不是编造值');
  } finally {
    await sup.stop();
  }
});

test('会话预览:任务后可回读历史消息(404 亦有结构化错误)', async () => {
  const sup = new DesktopRuntimeSupervisor(
    { command: process.execPath, args: ['--import', 'tsx', fakeHostPath], env: {} },
    { token: 'm6-tok' },
  );
  const ep = await sup.start();
  const c = new DesktopHostClient(`http://127.0.0.1:${ep.port}`, 'm6-tok');
  try {
    await c.postJson('/api/task', { text: 'history task', sessionId: 'hist-1', mode: 'auto' });
    const p = await c.getJson<{ id: string; messages: Array<{ role: string; text: string }> }>('/api/sessions/hist-1');
    assert.equal(p.id, 'hist-1');
    assert.ok(p.messages.length > 0, '预览含历史消息');
    assert.ok(p.messages.some((m) => m.role === 'user'));

    const nf = await fetch(`http://127.0.0.1:${ep.port}/api/sessions/nope-404`, { headers: { 'x-hmh-key': 'm6-tok' } });
    assert.equal(nf.status, 404);
    const body = (await nf.json()) as { code: string };
    assert.equal(body.code, 'SCHEMA_MISMATCH');
  } finally {
    await sup.stop();
  }
});

test('Provider 面板:key 只出 hasKey/末四位,永不明文(03 §七)', async () => {
  const sup = new DesktopRuntimeSupervisor(
    { command: process.execPath, args: ['--import', 'tsx', fakeHostPath], env: {} },
    { token: 'pv-tok' },
  );
  const ep = await sup.start();
  const c = new DesktopHostClient(`http://127.0.0.1:${ep.port}`, 'pv-tok');
  try {
    const st = await c.getJson<{ providersDetail: Array<{ name: string; hasKey: boolean; keyTail?: string; apiKey?: string }> }>('/api/state');
    const demo = st.providersDetail.find((p) => p.name === 'demo');
    assert.ok(demo !== undefined, '预置 provider 可见');
    assert.equal(demo.hasKey, true);
    assert.equal(demo.keyTail, '1234');
    assert.equal((demo as { apiKey?: string }).apiKey, undefined, '明文 key 永不出现');

    const save = await c.postJson<{ ok: boolean }>('/api/providers', { name: 'newp', baseUrl: 'http://x/v1', model: 'm2', apiKey: 'sk-new-9999' });
    assert.equal(save.ok, true);
    const st2 = await c.getJson<{ providersDetail: Array<{ name: string; keyTail?: string }> }>('/api/state');
    const added = st2.providersDetail.find((p) => p.name === 'newp');
    assert.equal(added?.keyTail, '9999', '保存后末四位可见');
  } finally {
    await sup.stop();
  }
});

test('工作区:列表/添加/切换(runtime 单选 cwd 语义)', async () => {
  const sup = new DesktopRuntimeSupervisor(
    { command: process.execPath, args: ['--import', 'tsx', fakeHostPath], env: {} },
    { token: 'ws-tok' },
  );
  const ep = await sup.start();
  const c = new DesktopHostClient(`http://127.0.0.1:${ep.port}`, 'ws-tok');
  try {
    const list0 = await c.getJson<{ current: string; items: Array<{ id: string }> }>('/api/workspaces');
    assert.ok(list0.items.length > 0);

    const add = await c.postJson<{ ok: boolean; items: Array<{ id: string; name: string }> }>('/api/workspaces', { name: 'proj', path: 'C:\\proj' });
    assert.equal(add.ok, true);
    const added = add.items.find((w) => w.name === 'proj');
    assert.ok(added !== undefined);

    const use = await c.postJson<{ ok: boolean; current: string }>('/api/workspaces/use', { id: added!.id });
    assert.equal(use.ok, true);
    assert.equal(use.current, added!.id, '切换后 current 指向新工作区');
  } finally {
    await sup.stop();
  }
});

test('会话归档/删除:可恢复语义(从列表移除,不硬删)', async () => {
  const sup = new DesktopRuntimeSupervisor(
    { command: process.execPath, args: ['--import', 'tsx', fakeHostPath], env: {} },
    { token: 'op-tok' },
  );
  const ep = await sup.start();
  const c = new DesktopHostClient(`http://127.0.0.1:${ep.port}`, 'op-tok');
  try {
    await c.postJson('/api/task', { text: 'to archive', sessionId: 'op-1', mode: 'auto' });
    const arch = await c.postJson<{ ok: boolean }>('/api/sessions/op-1/archive', {});
    assert.equal(arch.ok, true);
    const gone = await c.getJson('/api/sessions/op-1').catch(() => null);
    assert.equal(gone, null, '归档后不在常规列表');

    await c.postJson('/api/task', { text: 'to delete', sessionId: 'op-2', mode: 'auto' });
    const del = await c.postJson<{ ok: boolean }>('/api/sessions/op-2/delete', {});
    assert.equal(del.ok, true);
  } finally {
    await sup.stop();
  }
});
