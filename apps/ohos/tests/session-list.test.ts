import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFilter, groupByWorkspace, toggleGroup, wsGroupLabel } from './session-list.ts';

const mk = (over: Partial<Parameters<typeof Object.assign>[0]> = {}): SessionRowT => {
  const base: SessionRowT = {
    id: 's1', title: 't', workspace: '', running: false, failed: false,
    turns: 0, pinned: false, updatedAt: 100,
  };
  return Object.assign(base, over);
};
type SessionRowT = import('./session-list.ts').SessionRow;

test('过滤:running/done/failed', () => {
  const rows = [
    mk({ id: 'a', running: true }),
    mk({ id: 'b', running: false, failed: false }),
    mk({ id: 'c', running: false, failed: true }),
  ];
  assert.deepEqual(applyFilter(rows, 'all').map((r) => r.id), ['a', 'b', 'c']);
  assert.deepEqual(applyFilter(rows, 'running').map((r) => r.id), ['a']);
  assert.deepEqual(applyFilter(rows, 'done').map((r) => r.id), ['b']);
  assert.deepEqual(applyFilter(rows, 'failed').map((r) => r.id), ['c']);
});

test('分组:按工作区;组内收藏置顶+时间降序', () => {
  const rows = [
    mk({ id: 'x1', workspace: 'wsA', updatedAt: 10 }),
    mk({ id: 'pin', workspace: 'wsA', pinned: true, updatedAt: 5 }),
    mk({ id: 'y1', workspace: 'wsB', updatedAt: 99 }),
    mk({ id: 'nows', workspace: '' }),
  ];
  const gs = groupByWorkspace(rows, new Set());
  assert.equal(gs.length, 3);
  // wsA 含收藏 → 组间优先(优先级高于"最新时间")
  assert.equal(gs[0].workspace, 'wsA');
  const b = gs.find((g) => g.workspace === 'wsB')!;
  assert.equal(b.rows[0].id, 'y1');
  const a = gs.find((g) => g.workspace === 'wsA')!;
  assert.equal(a.rows[0].id, 'pin'); // 收藏置顶(即使更旧)
  assert.equal(a.rows[1].id, 'x1');
});

test('分组:含收藏的组优先', () => {
  const rows = [
    mk({ id: 'new', workspace: 'wsNew', updatedAt: 1000 }),
    mk({ id: 'p', workspace: 'wsOld', pinned: true, updatedAt: 1 }),
  ];
  const gs = groupByWorkspace(rows, new Set());
  assert.equal(gs[0].workspace, 'wsOld');
});

test('折叠:toggle 双向;折叠集不含的组不折叠', () => {
  let c = new Set<string>();
  c = toggleGroup(c, 'wsA');
  assert.ok(c.has('wsA'));
  c = toggleGroup(c, 'wsA');
  assert.ok(!c.has('wsA'));
  const gs = groupByWorkspace([mk({ workspace: 'wsA' })], new Set(['wsA']));
  assert.equal(gs[0].collapsed, true);
});

test('组标签:未记录工作区命名', () => {
  assert.equal(wsGroupLabel('', 2), '未记录工作区(2 个会话)');
  assert.equal(wsGroupLabel('D:\\proj', 1), 'D:\\proj(1 个会话)');
});
