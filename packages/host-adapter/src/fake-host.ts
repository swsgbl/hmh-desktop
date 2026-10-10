/**
 * fake host — hmharness runtime 的测试替身(MasterPrompt 阶段 D/E:
 * "先使用 fake host 编写状态机测试,再接真实 API";阶段 E 的会话纵切片
 * e2e 也先在 fake 层闭环)。
 *
 * 桌面 host 合同:
 *  - 只绑 127.0.0.1,端口 OS 分配,实际端口写 stdout 引导行;
 *  - 所有 /api/* 要求 X-Hmh-Key === HMH_DESKTOP_TOKEN,否则 401 + DesktopError;
 *  - GET /api/state 健康探测;GET /api/events SSE(event: hmh 信封流 + 重放环);
 *  - POST /api/desktop/shutdown 优雅退出。
 *
 * 阶段 E 模拟面(与 hmharness desktop 模式同形):
 *  - POST /api/task {text, sessionId, mode}:排队并按脚本发
 *    run.started → tool.started/completed →(mode==='ask' 时)
 *    approval.required(等 /api/approve)→ run.completed;
 *  - POST /api/approve {granted, sessionId};
 *  - POST /api/interrupt {sessionId};
 *  - GET /api/sessions。
 *
 * 测试钩子:FAKE_HOST_DIE_AFTER_MS / FAKE_HOST_DIE_AT_BOOT /
 * FAKE_HOST_EXPECT_TOKEN / FAKE_HOST_TASK_DELAY_MS / FAKE_HOST_TASK_FAIL=1
 * (任务以 run.failed 结束,构造错误恢复场景)。
 */
import { createServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { EVENT_SCHEMA_VERSION, desktopError, type EventEnvelope, type EventKind } from '@hmh-desktop/contracts';

export interface FakeHostHandle {
  port: number;
  emit(sessionId: string, runId: string, kind: EventKind, payload: Record<string, unknown>): number;
  close(): Promise<void>;
}

interface FakeSession {
  id: string;
  createdAt: string;
  updatedAt: string;
}

interface PendingApproval {
  sessionId: string;
  approvalId: string;
  resolve(granted: boolean): void;
}

export async function startFakeHost(opts: { token: string; quiet?: boolean }): Promise<FakeHostHandle> {
  const token = opts.token;
  // 测试钩子:FAKE_HOST_EXPECT_TOKEN 让 host 校验一个与 HMH_DESKTOP_TOKEN
  // 不同的值(构造 AUTH_FAILED 场景;supervisor 总是覆盖 HMH_DESKTOP_TOKEN)
  const expected = process.env.FAKE_HOST_EXPECT_TOKEN ?? token;
  const taskDelay = Number(process.env.FAKE_HOST_TASK_DELAY_MS ?? 30);
  const failTasks = process.env.FAKE_HOST_TASK_FAIL === '1';

  const sseClients = new Set<ServerResponse>();
  const seqByRun = new Map<string, number>();
  // 重放环:最近 200 帧(Last-Event-ID 断线补拉),与 hmharness web 同款语义
  const ring: Array<{ id: number; event: string; data: unknown }> = [];
  let ringSeq = 0;
  const sessions = new Map<string, FakeSession>();
  let pending: PendingApproval | null = null;
  const runTimers = new Map<string, NodeJS.Timeout>();

  const emit = (sessionId: string, runId: string, kind: EventKind, payload: Record<string, unknown>): number => {
    const key = `${sessionId}\0${runId}`;
    const seq = (seqByRun.get(key) ?? 0) + 1;
    seqByRun.set(key, seq);
    const env: EventEnvelope = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventId: randomUUID(),
      sessionId,
      runId,
      seq,
      occurredAt: new Date().toISOString(),
      kind,
      payload,
    };
    const id = ++ringSeq;
    ring.push({ id, event: 'hmh', data: env });
    if (ring.length > 200) ring.splice(0, ring.length - 200);
    for (const c of sseClients) {
      c.write(`id: ${id}\nevent: hmh\ndata: ${JSON.stringify(env)}\n\n`);
    }
    return seq;
  };

  const touch = (sessionId: string): FakeSession => {
    let s = sessions.get(sessionId);
    if (s === undefined) {
      s = { id: sessionId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      sessions.set(sessionId, s);
    }
    s.updatedAt = new Date().toISOString();
    return s;
  };

  /** 模拟一次任务:批准模式挂起等待 /api/approve。 */
  const runTask = (sessionId: string, text: string, mode: string): string => {
    const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    touch(sessionId);
    const steps: Array<() => void> = [];
    const wait = (fn: () => void, ms = taskDelay): void => {
      const t = setTimeout(fn, ms);
      runTimers.set(`${sessionId}\0${runId}`, t);
    };
    const chain = (fns: Array<() => void>): void => {
      const [first, ...rest] = fns;
      if (first === undefined) return;
      wait(() => {
        first();
        chain(rest);
      });
    };

    emit(sessionId, runId, 'run.started', { task: text, mode });
    if (failTasks) {
      wait(() => emit(sessionId, runId, 'run.failed', {
        error: { code: 'AUTH_FAILED', message: 'simulated provider auth failure', retryable: false },
      }));
      return runId;
    }

    const finishRun = (answer: string, toolUses: number): void => {
      runTimers.delete(`${sessionId}\0${runId}`);
      // 交付物先于终态(与 hmharness desktop 桥同序:artifact.created → run.completed)
      emit(sessionId, runId, 'artifact.created', {
        artifact: { relPath: 'out.txt', kind: 'file', title: 'out.txt' },
      });
      emit(sessionId, runId, 'run.completed', { text: answer, turns: 1, toolUses });
    };

    const scripted: Array<() => void> = [
      () => emit(sessionId, runId, 'tool.started', { name: 'read_file', argsPreview: '{"path":"README.md"}' }),
      () => emit(sessionId, runId, 'tool.completed', { name: 'read_file', isError: false, outputPreview: '# demo' }),
    ];

    if (mode === 'ask') {
      scripted.push(() => {
        const approvalId = `ap-${Math.random().toString(36).slice(2, 8)}`;
        emit(sessionId, runId, 'approval.required', {
          approvalId,
          tool: 'write_file',
          argsPreview: '{"path":"out.txt","content":"hi"}',
          risk: '写入工作区文件 out.txt(模拟)',
        });
        pending = {
          sessionId,
          approvalId,
          resolve: (granted) => {
            pending = null;
            if (granted) {
              emit(sessionId, runId, 'tool.started', { name: 'write_file', argsPreview: '{"path":"out.txt"}' });
              wait(() => emit(sessionId, runId, 'tool.completed', { name: 'write_file', isError: false, outputPreview: 'wrote 2 bytes' }));
              wait(() => finishRun(`echo: ${text}(已执行写入)`, 3), taskDelay * 2);
            } else {
              finishRun(`echo: ${text}(审批被拒绝,未执行写入)`, 1);
            }
          },
        };
      });
    } else {
      scripted.push(() => finishRun(`echo: ${text}`, 1));
    }
    chain(scripted);
    return runId;
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const authorized = req.headers['x-hmh-key'] === expected;
    const deny = (): void => {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(desktopError('AUTH_FAILED', 'missing or invalid x-hmh-key', { retryable: false })));
    };

    const readBody = (): Promise<string> =>
      new Promise((resolve) => {
        let b = '';
        req.on('data', (c: Buffer) => { b += c.toString(); });
        req.on('end', () => resolve(b));
      });

    if (url.pathname === '/api/events') {
      if (!authorized) { deny(); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.flushHeaders?.();
      sseClients.add(res);
      // 断线补拉:Last-Event-ID 之前的帧已在客户端,重发其后的环形缓冲
      const lastId = Number(req.headers['last-event-id'] ?? 0);
      if (Number.isFinite(lastId) && lastId > 0) {
        for (const e of ring) {
          if (e.id > lastId) res.write(`id: ${e.id}\nevent: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
        }
      }
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (!authorized) { deny(); return; }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        daemonVersion: 'fake-0.0.0', desktop: true, model: 'fake-model', locale: 'zh',
        busySessions: [...sessions.keys()].slice(0, 2),
        approvalPending: pending !== null,
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/desktop/shutdown') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1_000).unref();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/fake/die') {
      // 测试钩子:模拟 host 崩溃(先应答再退出,保证响应已发出)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      setTimeout(() => process.exit(1), 50);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/task') {
      void (async () => {
        try {
          const body = JSON.parse((await readBody()) || '{}') as { text?: unknown; sessionId?: unknown; mode?: unknown };
          const text = typeof body.text === 'string' ? body.text : '';
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : `web-${Date.now().toString(36)}`;
          const mode = body.mode === 'ask' || body.mode === 'auto' || body.mode === 'yolo' ? body.mode : 'ask';
          if (!text) {
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(desktopError('SCHEMA_MISMATCH', 'text required', { retryable: false })));
            return;
          }
          const runId = runTask(sessionId, text, mode);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, runId }));
        } catch (err) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(desktopError('SCHEMA_MISMATCH', String(err).slice(0, 120), { retryable: false })));
        }
      })();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/approve') {
      void (async () => {
        const body = JSON.parse((await readBody()) || '{}') as { granted?: unknown; sessionId?: unknown };
        const sid = typeof body.sessionId === 'string' ? body.sessionId : '';
        if (pending === null || (sid !== '' && pending.sessionId !== sid)) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(desktopError('SCHEMA_MISMATCH', 'no approval pending', { retryable: false })));
          return;
        }
        const p = pending;
        pending = null;
        p.resolve(body.granted === true);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, granted: body.granted === true }));
      })();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/interrupt') {
      const body = JSON.parse('') as Record<string, unknown>; // interrupt 无 body 语义
      void body;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      const list = [...sessions.values()].map((s) => ({
        id: s.id, title: '', task: '', outcome: 'ok', turns: 1, toolUses: 1,
        time: s.updatedAt, cwd: 'C:\\demo', branch: '', createdAt: s.createdAt, updatedAt: s.updatedAt,
      }));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ sessions: list, nextCursor: null }));
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/sessions/')) {
      // 会话预览(与 hmharness GET /api/sessions/:id 同形:最后 80 条,每条 500 字)
      const id = decodeURIComponent(url.pathname.slice('/api/sessions/'.length)).replace(/[^a-zA-Z0-9_:.@-]/g, '');
      const s = sessions.get(id);
      if (s === undefined) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(desktopError('SCHEMA_MISMATCH', 'session not found', { retryable: false })));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        id, model: 'fake-model', cwd: 'C:\\demo',
        messages: [
          { role: 'user', text: '之前的任务(fake 预览)', tools: [] },
          { role: 'assistant', text: '这是历史会话的回复预览(fake)。', tools: ['read_file'] },
        ],
      }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/fs') {
      // 目录浏览(与 hmharness 同形:path 省略=根;files=1 附带文件列表)
      const q = url.searchParams.get('path') ?? '';
      const withFiles = url.searchParams.get('files') === '1';
      if (q === '') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          path: '', segments: [], parent: '',
          dirs: [{ name: 'demo-workspace', path: 'C:\\demo' }],
          ...(withFiles ? { files: [] } : {}),
        }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        path: q, segments: [{ name: q.split(/[\\/]/).filter(Boolean).pop() ?? q, path: q }], parent: '',
        dirs: [{ name: 'src', path: `${q.replace(/[\\/]$/, '')}\\src` }],
        ...(withFiles ? { files: [
          { name: 'README.md', path: `${q.replace(/[\\/]$/, '')}\\README.md`, rel: 'README.md' },
          { name: 'package.json', path: `${q.replace(/[\\/]$/, '')}\\package.json`, rel: 'package.json' },
        ] } : {}),
      }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/fs/read') {
      // 文件预览(64KB 上限语义;fake 返回固定文本)
      const p = url.searchParams.get('path') ?? '';
      if (p === '') {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(desktopError('SCHEMA_MISMATCH', 'path required', { retryable: false })));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        path: p, rel: p.split(/[\\/]/).pop() ?? p, size: 42,
        text: '# demo workspace\n\n这是 fake host 的文件预览内容。\n',
      }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/diff') {
      // Diff 面板(与 hmharness /api/diff 同形;fake 返回固定小变更集)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        git: true, cwd: 'C:\\demo',
        changed: [
          { state: 'M', path: 'src/app.ts' },
          { state: 'A', path: 'docs/notes.md' },
        ],
        stat: ' src/app.ts      | 12 +++++++---\n docs/notes.md   |  4 ++++\n 2 files changed, 16 insertions(+), 3 deletions(-)',
      }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/cognitive') {
      // 认知状态(与 hmharness cognitiveStatus 同形子集;缺数据显式 null)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        memory: { layers: 3, entries: 12, contradictions: 0 },
        trajectories: 7,
        auditEvents: 21,
        worldModel: { version: 4, beliefs: 9, trusted: 5, brier: 0.31 },
        calibration: { predictions: 46, reliability: 0.72 },
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/fake/emit') {
      void (async () => {
        try {
          const body = JSON.parse((await readBody()) || '{}') as {
            sessionId: string; runId: string; kind: EventKind; payload: Record<string, unknown>;
          };
          const seq = emit(body.sessionId, body.runId, body.kind, body.payload);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, seq }));
        } catch (err) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(desktopError('SCHEMA_MISMATCH', String(err).slice(0, 120), { retryable: false })));
        }
      })();
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(desktopError('SCHEMA_MISMATCH', `no route ${req.method} ${url.pathname}`, { retryable: false })));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address !== 'object') throw new Error('fake host: no port');
  const port = address.port;

  if (!opts.quiet) {
    process.stdout.write(`${JSON.stringify({ hmhDesktopHostReady: true, port, version: 'fake-0.0.0' })}\n`);
  }
  const dieAfter = Number(process.env.FAKE_HOST_DIE_AFTER_MS ?? 0);
  if (Number.isFinite(dieAfter) && dieAfter > 0) {
    setTimeout(() => process.exit(1), dieAfter).unref();
  }

  // close(): 先断开全部 SSE 连接(它们永不自然关闭),否则 server.close
  // 会一直等活跃连接,测试进程挂死。
  const close = (): Promise<void> =>
    new Promise<void>((resolve) => {
      for (const c of sseClients) {
        try { c.end(); c.destroy(); } catch { /* already gone */ }
      }
      sseClients.clear();
      server.close(() => resolve());
      setTimeout(() => resolve(), 1_000).unref();
    });

  return { port, emit, close };
}

// 直接运行(supervisor spawn 的子进程形态)。realpath 比较:npm workspace
// junction / 大小写差异都不能让这个检测失手(失手=静默退出 code 0,难查)。
// cjs bundle(esbuild,打包产品)下 __filename 存在;ESM(tsx/源码)用 import.meta。
const selfUrl: string = typeof __filename === 'string'
  ? pathToFileURL(realpathSync(__filename)).href
  : import.meta.url;
const invokedAsScript = (() => {
  if (process.argv[1] === undefined) return false;
  try {
    return selfUrl === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (invokedAsScript) {
  const token = process.env.HMH_DESKTOP_TOKEN ?? '';
  // FAKE_HOST_DIE_AT_BOOT=1:引导行输出前即死(构造启动期 RUNTIME_CRASHED)
  if (process.env.FAKE_HOST_DIE_AT_BOOT === '1') {
    process.exit(1);
  }
  const slow = Number(process.env.FAKE_HOST_SLOW_AFTER ?? 0);
  const boot = (): void => {
    void startFakeHost({ token }).catch((err) => {
      process.stderr.write(`fake-host failed: ${String(err)}\n`);
      process.exit(1);
    });
  };
  if (Number.isFinite(slow) && slow > 0) setTimeout(boot, slow);
  else boot();
}
