/**
 * fake host — hmharness runtime 的测试替身(MasterPrompt 阶段 D:
 * "先使用 fake host 编写状态机测试,再接真实 API")。
 *
 * 实现桌面 host 合同的最小子集:
 *  - 只绑 127.0.0.1,端口由 OS 分配(port 0),实际端口写 stdout 引导行;
 *  - 所有 /api/* 要求 X-Hmh-Key === HMH_DESKTOP_TOKEN,否则 401 + DesktopError;
 *  - GET /api/state 健康探测;GET /api/events SSE(event: hmh 的 EventEnvelope 流);
 *  - POST /api/desktop/shutdown 优雅退出;POST /api/fake/emit 注入测试事件;
 *  - FAKE_HOST_DIE_AFTER_MS / FAKE_HOST_SLOW_READY_MS 模拟崩溃与慢启动。
 */
import { createServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { EVENT_SCHEMA_VERSION, desktopError, type EventEnvelope, type EventKind } from '@hmh-desktop/contracts';

export interface FakeHostHandle {
  port: number;
  emit(sessionId: string, runId: string, kind: EventKind, payload: Record<string, unknown>): number;
  close(): Promise<void>;
}

export async function startFakeHost(opts: { token: string; quiet?: boolean }): Promise<FakeHostHandle> {
  const token = opts.token;
  // 测试钩子:FAKE_HOST_EXPECT_TOKEN 让 host 校验一个与 HMH_DESKTOP_TOKEN
  // 不同的值(构造 AUTH_FAILED 场景;supervisor 总是覆盖 HMH_DESKTOP_TOKEN)
  const expected = process.env.FAKE_HOST_EXPECT_TOKEN ?? token;
  const sseClients = new Set<ServerResponse>();
  const seqByRun = new Map<string, number>();

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const authorized = req.headers['x-hmh-key'] === expected;
    const deny = (): void => {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(desktopError('AUTH_FAILED', 'missing or invalid x-hmh-key', { retryable: false })));
    };

    if (url.pathname === '/api/events') {
      // SSE 先鉴权再升级
      if (!authorized) { deny(); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.flushHeaders?.();
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (!authorized) { deny(); return; }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ daemonVersion: 'fake-0.0.0', desktop: true, model: 'fake-model', locale: 'zh' }));
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
    if (req.method === 'POST' && url.pathname === '/api/fake/emit') {
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); });
      req.on('end', () => {
        try {
          const { sessionId, runId, kind, payload } = JSON.parse(body) as {
            sessionId: string; runId: string; kind: EventKind; payload: Record<string, unknown>;
          };
          const seq = emit(sessionId, runId, kind, payload);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, seq }));
        } catch (err) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(desktopError('SCHEMA_MISMATCH', String(err).slice(0, 120), { retryable: false })));
        }
      });
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
    for (const c of sseClients) {
      c.write(`id: ${seq}\nevent: hmh\ndata: ${JSON.stringify(env)}\n\n`);
    }
    return seq;
  };

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

// 直接运行(supervisor spawn 的子进程形态)
const invokedAsScript = (() => {
  if (process.argv[1] === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
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
