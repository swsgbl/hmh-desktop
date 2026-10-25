import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialTurnItems, onTool, onToolResult, onFinal, onRunStart,
  previewArgs, deliverablePath, isWriteTool, turnSumText,
} from './turn-items.ts';

test('tool 卡:running → toolResult 回填 ok/error', () => {
  let s = initialTurnItems();
  s = onTool(s, { name: 'run_command', args: { command: 'dir' } });
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].kind, 'tool');
  if (s.items[0].kind === 'tool') {
    assert.equal(s.items[0].status, 'running');
    assert.ok(s.items[0].argsPreview.length > 0);
  }
  s = onToolResult(s, { name: 'run_command', isError: false, preview: 'ok' });
  if (s.items[0].kind === 'tool') {
    assert.equal(s.items[0].status, 'ok');
    assert.equal(s.items[0].resultPreview, 'ok');
  }
});

test('tool 卡:同名并发聚合(不重复开卡)', () => {
  let s = initialTurnItems();
  s = onTool(s, { name: 'read_file' });
  s = onTool(s, { name: 'read_file' });
  assert.equal(s.items.length, 1);
});

test('tool 卡:迟到 result 补终态卡;错误状态', () => {
  let s = initialTurnItems();
  s = onToolResult(s, { name: 'web_search', isError: true, preview: 'timeout' });
  assert.equal(s.items.length, 1);
  if (s.items[0].kind === 'tool') assert.equal(s.items[0].status, 'error');
});

test('final:turnSum 卡 + write 类工具出交付物卡', () => {
  let s = initialTurnItems();
  const toolArgs = new Map<string, unknown>();
  s = onTool(s, { name: 'write_file', args: { path: 'docs/x.md' } });
  toolArgs.set('write_file', { path: 'docs/x.md' });
  s = onTool(s, { name: 'run_command', args: { command: 'ls' } });
  toolArgs.set('run_command', { command: 'ls' });
  s = onToolResult(s, { name: 'write_file' });
  s = onToolResult(s, { name: 'run_command' });
  s = onFinal(s, { turns: 3, toolUses: 2, usage: { totalTokens: 1500 } }, toolArgs);
  const kinds = s.items.map((i) => i.kind);
  assert.deepEqual(kinds, ['tool', 'tool', 'deliverable', 'turnSum']);
  const d = s.items[2];
  if (d.kind === 'deliverable') {
    assert.equal(d.relPath, 'docs/x.md');
    assert.equal(d.tool, 'write_file');
  }
  const t = s.items[3];
  if (t.kind === 'turnSum') {
    assert.equal(turnSumText(t), '3 回合 · 2 次工具 · 1500 tokens');
  }
});

test('final:tokens 缺省/null 不显示 token 段', () => {
  let s = initialTurnItems();
  s = onFinal(s, { turns: 1, toolUses: 0 }, new Map());
  const t = s.items[0];
  if (t.kind === 'turnSum') assert.equal(turnSumText(t), '1 回合 · 0 次工具');
});

test('run 重新开始:条目清空', () => {
  let s = initialTurnItems();
  s = onTool(s, { name: 'read_file' });
  s = onRunStart(s);
  assert.equal(s.items.length, 0);
});

test('previewArgs:path 优先;长 JSON 截断', () => {
  assert.equal(previewArgs({ path: 'a.txt', data: 'x' }), 'a.txt');
  const long = { data: 'x'.repeat(300) };
  const p = previewArgs(long);
  assert.ok(p.length <= 121);
});

test('deliverablePath:非对象/null 安全', () => {
  assert.equal(deliverablePath(null), null);
  assert.equal(deliverablePath('str'), null);
  assert.equal(deliverablePath({}), null);
  assert.equal(deliverablePath({ path: 123 }), null);
});

test('isWriteTool:已知写工具', () => {
  assert.ok(isWriteTool('write_file'));
  assert.ok(isWriteTool('edit_file'));
  assert.ok(!isWriteTool('run_command'));
  assert.ok(!isWriteTool('read_file'));
});
