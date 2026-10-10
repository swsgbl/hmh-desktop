// apps/desktop/electron/main/index.ts
import { app, BrowserWindow, ipcMain, session, shell } from "electron";
import { join } from "node:path";
import { pathToFileURL as pathToFileURL2 } from "node:url";

// packages/host-adapter/src/supervisor.ts
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";

// packages/contracts/src/event.ts
var EVENT_KINDS = [
  "run.started",
  "plan.updated",
  "tool.started",
  "tool.completed",
  "approval.required",
  "verification.updated",
  "artifact.created",
  "run.completed",
  "run.failed"
];
var EVENT_SCHEMA_VERSION = 1;

// packages/contracts/src/error.ts
var ERROR_CODES = [
  "HOST_NOT_READY",
  "AUTH_FAILED",
  "RUNTIME_CRASHED",
  "PORT_BIND_FAILED",
  "STALE_VERSION",
  "SCHEMA_MISMATCH"
];
var RECOVERY_ACTIONS = ["RECONNECT", "RESUME", "EXPORT", "OPEN_LOGS"];
function desktopError(code, message, opts = {}) {
  const e = { code, message, retryable: opts.retryable === true };
  if (opts.sessionId !== void 0) e.sessionId = opts.sessionId;
  if (opts.runId !== void 0) e.runId = opts.runId;
  if (opts.recoveryAction !== void 0) e.recoveryAction = opts.recoveryAction;
  return e;
}

// packages/contracts/src/guards.ts
var isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var isNonEmptyString = (v) => typeof v === "string" && v.length > 0;
var isRfc3339 = (v) => {
  const t = Date.parse(v);
  return Number.isFinite(t) && /\d{4}-\d{2}-\d{2}T/.test(v);
};
function isEventEnvelope(v) {
  if (!isRecord(v)) return false;
  if (v.schemaVersion !== EVENT_SCHEMA_VERSION) return false;
  if (!isNonEmptyString(v.eventId)) return false;
  if (!isNonEmptyString(v.sessionId)) return false;
  if (!isNonEmptyString(v.runId)) return false;
  if (typeof v.seq !== "number" || !Number.isInteger(v.seq) || v.seq < 0) return false;
  if (!isNonEmptyString(v.occurredAt) || !isRfc3339(v.occurredAt)) return false;
  if (!EVENT_KINDS.includes(v.kind)) return false;
  return isRecord(v.payload);
}
function isDesktopError(v) {
  if (!isRecord(v)) return false;
  if (!ERROR_CODES.includes(v.code)) return false;
  if (typeof v.message !== "string") return false;
  if (typeof v.retryable !== "boolean") return false;
  if (v.sessionId !== void 0 && !isNonEmptyString(v.sessionId)) return false;
  if (v.runId !== void 0 && !isNonEmptyString(v.runId)) return false;
  if (v.recoveryAction !== void 0 && !RECOVERY_ACTIONS.includes(v.recoveryAction)) return false;
  return true;
}
function isHostReadyLine(v) {
  if (!isRecord(v)) return false;
  if (v.hmhDesktopHostReady !== true) return false;
  if (typeof v.port !== "number" || !Number.isInteger(v.port) || v.port <= 0 || v.port > 65535) return false;
  return isNonEmptyString(v.version);
}

// packages/host-adapter/src/supervisor.ts
var DEFAULT_START_TIMEOUT_MS = 2e4;
var DEFAULT_MAX_RESTARTS = 3;
var DEFAULT_GRACEFUL_MS = 5e3;
var DesktopRuntimeSupervisor = class {
  constructor(spec, opts = {}) {
    this.spec = spec;
    this.token = opts.token ?? randomBytes(32).toString("base64url");
    this.opts = {
      maxRestarts: opts.maxRestarts ?? DEFAULT_MAX_RESTARTS,
      startTimeoutMs: opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
      gracefulShutdownMs: opts.gracefulShutdownMs ?? DEFAULT_GRACEFUL_MS,
      ...opts
    };
  }
  spec;
  child = null;
  _state = "stopped";
  restartCount = 0;
  lastError = "";
  stopping = false;
  token;
  opts;
  exitWaiters = [];
  get state() {
    return this._state;
  }
  get restartsUsed() {
    return this.restartCount;
  }
  setState(s, err) {
    this._state = s;
    if (err !== void 0) this.lastError = err;
    const info = { restartCount: this.restartCount };
    if (this.lastError !== "") info.lastError = this.lastError;
    this.opts.onStateChange?.(s, info);
  }
  /** 启动 host 并等待 ready(引导行 + 带 token 的健康探测)。 */
  async start() {
    if (this._state === "ready" || this._state === "starting") {
      throw desktopError("HOST_NOT_READY", `supervisor already ${this._state}`);
    }
    this.restartCount = 0;
    this.stopping = false;
    return this.launch();
  }
  async launch() {
    this.setState("starting");
    const child = spawn(this.spec.command, this.spec.args, {
      cwd: this.spec.cwd,
      env: {
        ...process.env,
        ...this.spec.env,
        HMH_DESKTOP_TOKEN: this.token
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    this.child = child;
    try {
      const endpoint = await this.awaitReady(child);
      this.currentEndpoint = { port: endpoint.port, version: endpoint.version };
      this.setState("ready");
      this.opts.onReady?.(endpoint);
      child.once("exit", () => {
        this.exitWaiters.forEach((w) => w());
        this.exitWaiters = [];
        this.onUnexpectedExit();
      });
      return endpoint;
    } catch (err) {
      if (!child.killed) child.kill();
      if (this.child === child) this.child = null;
      throw err;
    }
  }
  /** 从 stdout 找 HostReadyLine,然后健康探测。 */
  awaitReady(child) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(desktopError("HOST_NOT_READY", `host did not signal ready within ${this.opts.startTimeoutMs}ms`, { retryable: true, recoveryAction: "RECONNECT" }));
      }, this.opts.startTimeoutMs);
      const done = (fn) => {
        clearTimeout(timer);
        fn();
      };
      if (!child.stdout) {
        done(() => reject(desktopError("RUNTIME_CRASHED", "host spawned without stdout pipe")));
        return;
      }
      const rl = createInterface({ input: child.stdout });
      const onLine = (line) => {
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          return;
        }
        if (isHostReadyLine(parsed)) {
          rl.close();
          void this.probeAndRemember(parsed.port, parsed.version).then((endpoint) => done(() => resolve(endpoint))).catch((err) => done(() => reject(err)));
        }
      };
      rl.on("line", onLine);
      child.once("exit", (code) => {
        done(() => reject(desktopError("RUNTIME_CRASHED", `host exited during startup (code ${code ?? "null"})`, { retryable: false, recoveryAction: "OPEN_LOGS" })));
      });
    });
  }
  /** 带 token 的健康探测:GET /api/state。401 → AUTH_FAILED(不重试)。 */
  async probe(port, version) {
    let res;
    try {
      res = await fetch(`http://127.0.0.1:${port}/api/state`, {
        headers: { "x-hmh-key": this.token },
        signal: AbortSignal.timeout(3e3)
      });
    } catch (err) {
      throw desktopError("HOST_NOT_READY", `health probe failed: ${String(err).slice(0, 160)}`, { retryable: true });
    }
    if (res.status === 401 || res.status === 403) {
      throw desktopError("AUTH_FAILED", `host rejected the session token (HTTP ${res.status})`, { retryable: false, recoveryAction: "RECONNECT" });
    }
    if (!res.ok) {
      throw desktopError("HOST_NOT_READY", `health probe HTTP ${res.status}`, { retryable: true });
    }
    return { port, version, token: this.token };
  }
  onUnexpectedExit() {
    if (this.stopping || this._state === "stopped" || this._state === "stopping") return;
    this.child = null;
    if (this.restartCount < this.opts.maxRestarts) {
      this.restartCount += 1;
      this.setState("restarting");
      void this.launch().catch(() => {
        this.retryOrFail();
      });
    } else {
      this.setState("failed", `host exited unexpectedly ${this.restartCount + 1} times; giving up`);
    }
  }
  retryOrFail() {
    if (this.stopping || this._state === "stopped" || this._state === "stopping") return;
    if (this.restartCount < this.opts.maxRestarts) {
      this.restartCount += 1;
      this.setState("restarting");
      void this.launch().catch(() => this.retryOrFail());
    } else {
      this.setState("failed", `host failed to stay up after ${this.restartCount} restart attempts`);
    }
  }
  /** 优雅停止:先 HTTP shutdown,超时才对本进程句柄 kill。 */
  async stop() {
    this.stopping = true;
    if (this._state === "stopped") return;
    this.setState("stopping");
    const child = this.child;
    this.child = null;
    this.currentEndpoint = null;
    if (!child) {
      this.setState("stopped");
      return;
    }
    const exited = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else {
        const w = () => resolve();
        this.exitWaiters.push(w);
        child.once("exit", w);
      }
    });
    if (this.lastEndpoint !== null) {
      try {
        await fetch(`http://127.0.0.1:${this.lastEndpoint}/api/desktop/shutdown`, {
          method: "POST",
          headers: { "x-hmh-key": this.token },
          signal: AbortSignal.timeout(1e3)
        });
      } catch {
      }
    }
    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), this.opts.gracefulShutdownMs))
    ]);
    if (!graceful && child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
    await exited.catch(() => void 0);
    this.setState("stopped");
  }
  lastEndpoint = null;
  currentEndpoint = null;
  /** 当前 host 端点(ready 后有值;不含 token)。 */
  get endpoint() {
    return this.currentEndpoint;
  }
  /** 探测成功后记住端口,供 stop() 的优雅关闭使用。 */
  async probeAndRemember(port, version) {
    const ep = await this.probe(port, version);
    this.lastEndpoint = ep.port;
    return ep;
  }
};

// packages/host-adapter/src/client.ts
function parseSseChunk(chunk) {
  const frames = [];
  for (const block of chunk.split(/\n\n/)) {
    if (!block.trim()) continue;
    let id;
    let event = "message";
    const dataLines = [];
    let sawField = false;
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("id:")) {
        id = line.slice(3).trim();
        sawField = true;
      } else if (line.startsWith("event:")) {
        event = line.slice(6).trim();
        sawField = true;
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
        sawField = true;
      }
    }
    if (!sawField) continue;
    frames.push({ ...id !== void 0 ? { id } : {}, event, data: dataLines.join("\n") });
  }
  return frames;
}
function envelopeFromFrame(frame) {
  if (frame.event !== "hmh") return null;
  try {
    const parsed = JSON.parse(frame.data);
    return isEventEnvelope(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
var DesktopHttpError = class extends Error {
  constructor(detail) {
    super(detail.message);
    this.detail = detail;
  }
  detail;
};
var DesktopHostClient = class {
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl;
    this.token = token;
  }
  baseUrl;
  token;
  headers(extra = {}) {
    return { "x-hmh-key": this.token, ...extra };
  }
  async getJson(path, timeoutMs = 5e3) {
    let res;
    try {
      res = await fetch(`${this.baseUrl}${path}`, { headers: this.headers(), signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new DesktopHttpError(desktopError("HOST_NOT_READY", `request failed: ${String(err).slice(0, 160)}`, { retryable: true, recoveryAction: "RECONNECT" }));
    }
    return this.parseResponse(res);
  }
  async postJson(path, body, timeoutMs = 1e4) {
    let res;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      throw new DesktopHttpError(desktopError("HOST_NOT_READY", `request failed: ${String(err).slice(0, 160)}`, { retryable: true, recoveryAction: "RECONNECT" }));
    }
    return this.parseResponse(res);
  }
  async parseResponse(res) {
    if (res.status === 401 || res.status === 403) {
      throw new DesktopHttpError(desktopError("AUTH_FAILED", `host rejected the session token (HTTP ${res.status})`, { retryable: false, recoveryAction: "RECONNECT" }));
    }
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      if (isDesktopError(parsed)) throw new DesktopHttpError(parsed);
      throw new DesktopHttpError(desktopError("HOST_NOT_READY", `HTTP ${res.status}: ${text.slice(0, 160)}`, { retryable: res.status >= 500 }));
    }
    return parsed;
  }
  /**
   * 订阅全部 SSE 帧(含非信封事件:delta/line 等高频流)。信封由调用方
   * 用 envelopeFromFrame 自行分流;断线重连语义同 events()。
   */
  async *rawEvents(lastEventId, signal) {
    const res = await fetch(`${this.baseUrl}/api/events`, {
      headers: this.headers({
        accept: "text/event-stream",
        ...lastEventId !== void 0 ? { "last-event-id": lastEventId } : {}
      }),
      ...signal !== void 0 ? { signal } : {}
    });
    if (res.status === 401 || res.status === 403) {
      throw new DesktopHttpError(desktopError("AUTH_FAILED", `host rejected the session token (HTTP ${res.status})`, { retryable: false, recoveryAction: "RECONNECT" }));
    }
    if (!res.ok || res.body === null) {
      throw new DesktopHttpError(desktopError("HOST_NOT_READY", `SSE HTTP ${res.status}`, { retryable: true, recoveryAction: "RECONNECT" }));
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const frame of parseSseChunk(block)) yield frame;
      }
    }
  }
  /**
   * 订阅 SSE 事件流(async iterator)。断线由调用方重连;重连时把最后
   * 收到的 eventId 传入 lastEventId,host 端从重放环补发。
   */
  async *events(lastEventId, signal) {
    const res = await fetch(`${this.baseUrl}/api/events`, {
      headers: this.headers({
        accept: "text/event-stream",
        ...lastEventId !== void 0 ? { "last-event-id": lastEventId } : {}
      }),
      ...signal !== void 0 ? { signal } : {}
    });
    if (res.status === 401 || res.status === 403) {
      throw new DesktopHttpError(desktopError("AUTH_FAILED", `host rejected the session token (HTTP ${res.status})`, { retryable: false, recoveryAction: "RECONNECT" }));
    }
    if (!res.ok || !res.body) {
      throw new DesktopHttpError(desktopError("HOST_NOT_READY", `SSE HTTP ${res.status}`, { retryable: true, recoveryAction: "RECONNECT" }));
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const frame of parseSseChunk(block)) {
          const env = envelopeFromFrame(frame);
          if (env !== null) yield env;
        }
      }
    }
  }
};

// packages/host-adapter/src/fake-host.ts
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
async function startFakeHost(opts) {
  const token = opts.token;
  const expected = process.env.FAKE_HOST_EXPECT_TOKEN ?? token;
  const taskDelay = Number(process.env.FAKE_HOST_TASK_DELAY_MS ?? 30);
  const failTasks = process.env.FAKE_HOST_TASK_FAIL === "1";
  const sseClients = /* @__PURE__ */ new Set();
  const seqByRun = /* @__PURE__ */ new Map();
  const ring = [];
  let ringSeq = 0;
  const sessions = /* @__PURE__ */ new Map();
  let pending = null;
  const runTimers = /* @__PURE__ */ new Map();
  const emit = (sessionId, runId, kind, payload) => {
    const key = `${sessionId}\0${runId}`;
    const seq = (seqByRun.get(key) ?? 0) + 1;
    seqByRun.set(key, seq);
    const env = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventId: randomUUID(),
      sessionId,
      runId,
      seq,
      occurredAt: (/* @__PURE__ */ new Date()).toISOString(),
      kind,
      payload
    };
    const id = ++ringSeq;
    ring.push({ id, event: "hmh", data: env });
    if (ring.length > 200) ring.splice(0, ring.length - 200);
    for (const c of sseClients) {
      c.write(`id: ${id}
event: hmh
data: ${JSON.stringify(env)}

`);
    }
    return seq;
  };
  const touch = (sessionId) => {
    let s = sessions.get(sessionId);
    if (s === void 0) {
      s = { id: sessionId, createdAt: (/* @__PURE__ */ new Date()).toISOString(), updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
      sessions.set(sessionId, s);
    }
    s.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    return s;
  };
  const runTask = (sessionId, text, mode) => {
    const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    touch(sessionId);
    const steps = [];
    const wait = (fn, ms = taskDelay) => {
      const t = setTimeout(fn, ms);
      runTimers.set(`${sessionId}\0${runId}`, t);
    };
    const chain = (fns) => {
      const [first, ...rest] = fns;
      if (first === void 0) return;
      wait(() => {
        first();
        chain(rest);
      });
    };
    emit(sessionId, runId, "run.started", { task: text, mode });
    if (failTasks) {
      wait(() => emit(sessionId, runId, "run.failed", {
        error: { code: "AUTH_FAILED", message: "simulated provider auth failure", retryable: false }
      }));
      return runId;
    }
    const finishRun = (answer, toolUses) => {
      runTimers.delete(`${sessionId}\0${runId}`);
      emit(sessionId, runId, "run.completed", { text: answer, turns: 1, toolUses });
    };
    const scripted = [
      () => emit(sessionId, runId, "tool.started", { name: "read_file", argsPreview: '{"path":"README.md"}' }),
      () => emit(sessionId, runId, "tool.completed", { name: "read_file", isError: false, outputPreview: "# demo" })
    ];
    if (mode === "ask") {
      scripted.push(() => {
        const approvalId = `ap-${Math.random().toString(36).slice(2, 8)}`;
        emit(sessionId, runId, "approval.required", {
          approvalId,
          tool: "write_file",
          argsPreview: '{"path":"out.txt","content":"hi"}',
          risk: "\u5199\u5165\u5DE5\u4F5C\u533A\u6587\u4EF6 out.txt(\u6A21\u62DF)"
        });
        pending = {
          sessionId,
          approvalId,
          resolve: (granted) => {
            pending = null;
            if (granted) {
              emit(sessionId, runId, "tool.started", { name: "write_file", argsPreview: '{"path":"out.txt"}' });
              wait(() => emit(sessionId, runId, "tool.completed", { name: "write_file", isError: false, outputPreview: "wrote 2 bytes" }));
              wait(() => finishRun(`echo: ${text}(\u5DF2\u6267\u884C\u5199\u5165)`, 3), taskDelay * 2);
            } else {
              finishRun(`echo: ${text}(\u5BA1\u6279\u88AB\u62D2\u7EDD,\u672A\u6267\u884C\u5199\u5165)`, 1);
            }
          }
        };
      });
    } else {
      scripted.push(() => finishRun(`echo: ${text}`, 1));
    }
    chain(scripted);
    return runId;
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const authorized = req.headers["x-hmh-key"] === expected;
    const deny = () => {
      res.writeHead(401, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(desktopError("AUTH_FAILED", "missing or invalid x-hmh-key", { retryable: false })));
    };
    const readBody = () => new Promise((resolve) => {
      let b = "";
      req.on("data", (c) => {
        b += c.toString();
      });
      req.on("end", () => resolve(b));
    });
    if (url.pathname === "/api/events") {
      if (!authorized) {
        deny();
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.flushHeaders?.();
      sseClients.add(res);
      const lastId = Number(req.headers["last-event-id"] ?? 0);
      if (Number.isFinite(lastId) && lastId > 0) {
        for (const e of ring) {
          if (e.id > lastId) res.write(`id: ${e.id}
event: ${e.event}
data: ${JSON.stringify(e.data)}

`);
        }
      }
      req.on("close", () => sseClients.delete(res));
      return;
    }
    if (!authorized) {
      deny();
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        daemonVersion: "fake-0.0.0",
        desktop: true,
        model: "fake-model",
        locale: "zh",
        busySessions: [...sessions.keys()].slice(0, 2),
        approvalPending: pending !== null
      }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/desktop/shutdown") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1e3).unref();
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/fake/die") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
      setTimeout(() => process.exit(1), 50);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/task") {
      void (async () => {
        try {
          const body = JSON.parse(await readBody() || "{}");
          const text = typeof body.text === "string" ? body.text : "";
          const sessionId = typeof body.sessionId === "string" ? body.sessionId : `web-${Date.now().toString(36)}`;
          const mode = body.mode === "ask" || body.mode === "auto" || body.mode === "yolo" ? body.mode : "ask";
          if (!text) {
            res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify(desktopError("SCHEMA_MISMATCH", "text required", { retryable: false })));
            return;
          }
          const runId = runTask(sessionId, text, mode);
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true, runId }));
        } catch (err) {
          res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(desktopError("SCHEMA_MISMATCH", String(err).slice(0, 120), { retryable: false })));
        }
      })();
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/approve") {
      void (async () => {
        const body = JSON.parse(await readBody() || "{}");
        const sid = typeof body.sessionId === "string" ? body.sessionId : "";
        if (pending === null || sid !== "" && pending.sessionId !== sid) {
          res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(desktopError("SCHEMA_MISMATCH", "no approval pending", { retryable: false })));
          return;
        }
        const p = pending;
        pending = null;
        p.resolve(body.granted === true);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, granted: body.granted === true }));
      })();
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/interrupt") {
      const body = JSON.parse("");
      void body;
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/sessions") {
      const list = [...sessions.values()].map((s) => ({
        id: s.id,
        title: "",
        task: "",
        outcome: "ok",
        turns: 1,
        toolUses: 1,
        time: s.updatedAt,
        cwd: "C:\\demo",
        branch: "",
        createdAt: s.createdAt,
        updatedAt: s.updatedAt
      }));
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ sessions: list, nextCursor: null }));
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/sessions/".length)).replace(/[^a-zA-Z0-9_:.@-]/g, "");
      const s = sessions.get(id);
      if (s === void 0) {
        res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(desktopError("SCHEMA_MISMATCH", "session not found", { retryable: false })));
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        id,
        model: "fake-model",
        cwd: "C:\\demo",
        messages: [
          { role: "user", text: "\u4E4B\u524D\u7684\u4EFB\u52A1(fake \u9884\u89C8)", tools: [] },
          { role: "assistant", text: "\u8FD9\u662F\u5386\u53F2\u4F1A\u8BDD\u7684\u56DE\u590D\u9884\u89C8(fake)\u3002", tools: ["read_file"] }
        ]
      }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/fs") {
      const q = url.searchParams.get("path") ?? "";
      const withFiles = url.searchParams.get("files") === "1";
      if (q === "") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          path: "",
          segments: [],
          parent: "",
          dirs: [{ name: "demo-workspace", path: "C:\\demo" }],
          ...withFiles ? { files: [] } : {}
        }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        path: q,
        segments: [{ name: q.split(/[\\/]/).filter(Boolean).pop() ?? q, path: q }],
        parent: "",
        dirs: [{ name: "src", path: `${q.replace(/[\\/]$/, "")}\\src` }],
        ...withFiles ? { files: [
          { name: "README.md", path: `${q.replace(/[\\/]$/, "")}\\README.md`, rel: "README.md" },
          { name: "package.json", path: `${q.replace(/[\\/]$/, "")}\\package.json`, rel: "package.json" }
        ] } : {}
      }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/fs/read") {
      const p = url.searchParams.get("path") ?? "";
      if (p === "") {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(desktopError("SCHEMA_MISMATCH", "path required", { retryable: false })));
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        path: p,
        rel: p.split(/[\\/]/).pop() ?? p,
        size: 42,
        text: "# demo workspace\n\n\u8FD9\u662F fake host \u7684\u6587\u4EF6\u9884\u89C8\u5185\u5BB9\u3002\n"
      }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/diff") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        git: true,
        cwd: "C:\\demo",
        changed: [
          { state: "M", path: "src/app.ts" },
          { state: "A", path: "docs/notes.md" }
        ],
        stat: " src/app.ts      | 12 +++++++---\n docs/notes.md   |  4 ++++\n 2 files changed, 16 insertions(+), 3 deletions(-)"
      }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/cognitive") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        memory: { layers: 3, entries: 12, contradictions: 0 },
        trajectories: 7,
        auditEvents: 21,
        worldModel: { version: 4, beliefs: 9, trusted: 5, brier: 0.31 },
        calibration: { predictions: 46, reliability: 0.72 }
      }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/fake/emit") {
      void (async () => {
        try {
          const body = JSON.parse(await readBody() || "{}");
          const seq = emit(body.sessionId, body.runId, body.kind, body.payload);
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true, seq }));
        } catch (err) {
          res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(desktopError("SCHEMA_MISMATCH", String(err).slice(0, 120), { retryable: false })));
        }
      })();
      return;
    }
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(desktopError("SCHEMA_MISMATCH", `no route ${req.method} ${url.pathname}`, { retryable: false })));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("fake host: no port");
  const port = address.port;
  if (!opts.quiet) {
    process.stdout.write(`${JSON.stringify({ hmhDesktopHostReady: true, port, version: "fake-0.0.0" })}
`);
  }
  const dieAfter = Number(process.env.FAKE_HOST_DIE_AFTER_MS ?? 0);
  if (Number.isFinite(dieAfter) && dieAfter > 0) {
    setTimeout(() => process.exit(1), dieAfter).unref();
  }
  const close = () => new Promise((resolve) => {
    for (const c of sseClients) {
      try {
        c.end();
        c.destroy();
      } catch {
      }
    }
    sseClients.clear();
    server.close(() => resolve());
    setTimeout(() => resolve(), 1e3).unref();
  });
  return { port, emit, close };
}
var invokedAsScript = (() => {
  if (process.argv[1] === void 0) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (invokedAsScript) {
  const token = process.env.HMH_DESKTOP_TOKEN ?? "";
  if (process.env.FAKE_HOST_DIE_AT_BOOT === "1") {
    process.exit(1);
  }
  const slow = Number(process.env.FAKE_HOST_SLOW_AFTER ?? 0);
  const boot = () => {
    void startFakeHost({ token }).catch((err) => {
      process.stderr.write(`fake-host failed: ${String(err)}
`);
      process.exit(1);
    });
  };
  if (Number.isFinite(slow) && slow > 0) setTimeout(boot, slow);
  else boot();
}

// apps/desktop/electron/main/index.ts
var here = import.meta.dirname ?? ".";
var isDev = process.env.HMH_DESKTOP_DEV === "1";
var rendererDevUrl = process.env.HMH_DESKTOP_RENDERER_URL ?? "";
var preloadPath = join(here, "../preload/index.cjs");
var secrets = [];
function redact(s) {
  let out = s;
  for (const sec of secrets) {
    if (sec.length >= 8) out = out.split(sec).join("[redacted]");
  }
  return out;
}
function logInfo(tag, msg) {
  console.log(`[hmh-desktop:${tag}] ${redact(msg)}`);
}
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let pushEvent2 = function(env) {
    eventBuffer.push(env);
    if (eventBuffer.length > 2e3) eventBuffer.splice(0, eventBuffer.length - 2e3);
    if (flushTimer === null) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        const batch = eventBuffer;
        eventBuffer = [];
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) w.webContents.send("bridge:event-batch", batch);
        }
      }, 50);
    }
  }, broadcastHostState2 = function(s, info) {
    bridge = { ...bridge, hostState: s, hostPort: supervisor?.endpoint?.port ?? null, hostVersion: supervisor?.endpoint?.version ?? null };
    logInfo("host", `state=${s}${info.lastError !== void 0 ? ` err=${info.lastError}` : ""}`);
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send("bridge:host-state", s, info);
    }
  }, senderTrusted2 = function(senderFrame) {
    if (senderFrame === null || senderFrame === void 0) return false;
    let top = senderFrame;
    while (top?.parent !== null && top?.parent !== void 0) top = top.parent;
    const url = top?.url ?? "";
    for (const origin of allowedOrigins) {
      if (url === origin || url.startsWith(`${origin}/`) || url.startsWith(`${origin}?`)) return true;
    }
    return false;
  }, hostCall2 = function(event, fn) {
    if (!senderTrusted2(event.senderFrame)) return Promise.resolve({ error: "untrusted sender", code: "FORBIDDEN" });
    if (client === null || bridge.hostState !== "ready") {
      return Promise.resolve({ error: `host not ready (${bridge.hostState})`, code: "HOST_NOT_READY" });
    }
    return fn(client).catch((err) => {
      const detail = (() => {
        try {
          return JSON.stringify(err);
        } catch {
          return String(err);
        }
      })().slice(0, 300);
      return { error: detail, code: "BRIDGE_ERROR" };
    });
  }, registerIpc2 = function() {
    ipcMain.handle("bridge:get-state", (event) => {
      if (!senderTrusted2(event.senderFrame)) return { error: "untrusted sender" };
      return { ...bridge, droppedFrames };
    });
    ipcMain.handle("bridge:sessions", (event) => hostCall2(event, (c) => c.getJson("/api/sessions?limit=100")));
    ipcMain.handle("bridge:send-task", (event, text, sessionId, mode) => {
      const task = typeof text === "string" ? text.slice(0, 2e4) : "";
      const sid = typeof sessionId === "string" ? sessionId.slice(0, 80) : "";
      const m = mode === "auto" || mode === "yolo" ? mode : "ask";
      if (task === "" || sid === "") return Promise.resolve({ ok: false, code: "BAD_REQUEST" });
      return hostCall2(event, (c) => c.postJson("/api/task", { text: task, sessionId: sid, mode: m }));
    });
    ipcMain.handle("bridge:approve", (event, granted, sessionId) => hostCall2(event, (c) => c.postJson("/api/approve", {
      granted: granted === true,
      sessionId: typeof sessionId === "string" ? sessionId.slice(0, 80) : ""
    })));
    ipcMain.handle("bridge:interrupt", (event, sessionId) => hostCall2(event, (c) => c.postJson("/api/interrupt", {
      sessionId: typeof sessionId === "string" ? sessionId.slice(0, 80) : ""
    })));
    ipcMain.handle("bridge:fs-list", (event, path) => {
      const p = typeof path === "string" ? path.slice(0, 1e3) : "";
      return hostCall2(event, (c) => c.getJson(`/api/fs?files=1${p !== "" ? `&path=${encodeURIComponent(p)}` : ""}`));
    });
    ipcMain.handle("bridge:fs-read", (event, path) => {
      const p = typeof path === "string" ? path.slice(0, 1e3) : "";
      if (p === "") return Promise.resolve({ error: "path required", code: "BAD_REQUEST" });
      return hostCall2(event, (c) => c.getJson(`/api/fs/read?path=${encodeURIComponent(p)}`));
    });
    ipcMain.handle("bridge:diff", (event, sessionId) => {
      const sid = typeof sessionId === "string" ? sessionId.slice(0, 80) : "";
      return hostCall2(event, (c) => c.getJson(`/api/diff${sid !== "" ? `?sessionId=${encodeURIComponent(sid)}` : ""}`));
    });
    ipcMain.handle("bridge:cognitive", (event) => hostCall2(event, (c) => c.getJson("/api/cognitive")));
    ipcMain.handle("bridge:session-preview", (event, id) => {
      const sid = typeof id === "string" ? id.replace(/[^a-zA-Z0-9_:.@-]/g, "").slice(0, 80) : "";
      if (sid === "") return Promise.resolve({ error: "id required", code: "BAD_REQUEST" });
      return hostCall2(event, (c) => c.getJson(`/api/sessions/${encodeURIComponent(sid)}`));
    });
    ipcMain.handle("bridge:stop-host", (event) => {
      if (!senderTrusted2(event.senderFrame)) return { error: "untrusted sender" };
      void (async () => {
        sseAbort?.abort();
        await supervisor?.stop();
        app.quit();
      })();
      return { ok: true };
    });
  }, createWindow2 = function() {
    const win = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 960,
      minHeight: 600,
      show: false,
      backgroundColor: "#141416",
      title: "HMH Desktop",
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        webSecurity: true,
        spellcheck: false,
        devTools: isDev
      }
    });
    win.once("ready-to-show", () => win.show());
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (e, url) => {
      const ok = [...allowedOrigins].some((o) => url === o || url.startsWith(`${o}/`) || url.startsWith(`${o}?`));
      if (!ok) {
        logInfo("nav", `blocked navigation to ${url.slice(0, 120)}`);
        e.preventDefault();
      }
    });
    if (isDev && rendererDevUrl) {
      void win.loadURL(rendererDevUrl);
    } else {
      void win.loadFile(join(here, "..", "..", "dist-renderer", "index.html"));
    }
  };
  pushEvent = pushEvent2, broadcastHostState = broadcastHostState2, senderTrusted = senderTrusted2, hostCall = hostCall2, registerIpc = registerIpc2, createWindow = createWindow2;
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  let supervisor = null;
  let client = null;
  let bridge = { hostState: "stopped", hostPort: null, hostVersion: null, lastError: null, mode: "fake" };
  let eventBuffer = [];
  let flushTimer = null;
  let sseAbort = null;
  let lastEventId = "";
  let droppedFrames = 0;
  async function pumpEvents() {
    if (client === null) return;
    for (; ; ) {
      const c = client;
      if (c === null) return;
      try {
        for await (const frame of c.rawEvents(lastEventId === "" ? void 0 : lastEventId, sseAbort?.signal)) {
          if (frame.event === "hmh") {
            const env = envelopeFromFrame(frame);
            if (env === null) {
              droppedFrames += 1;
              continue;
            }
            lastEventId = env.eventId;
            pushEvent2(env);
          } else if (frame.event === "delta" || frame.event === "line") {
            try {
              const d = JSON.parse(frame.data);
              const payload = frame.event === "delta" ? { sessionId: d.sessionId ?? "", kind: d.k ?? "text", chunk: String(d.chunk ?? "") } : { sessionId: d.sessionId ?? "", kind: "line", chunk: String(d.text ?? "") };
              for (const w of BrowserWindow.getAllWindows()) {
                if (!w.isDestroyed()) w.webContents.send("bridge:stream-chunk", payload);
              }
            } catch {
            }
          }
        }
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 1e3));
        if (sseAbort?.signal.aborted) return;
      }
    }
  }
  async function startHost() {
    const useReal = process.env.HMH_DESKTOP_REAL === "1";
    bridge = { ...bridge, mode: useReal ? "real" : "fake" };
    const repoRoot = join(here, "..", "..", "..", "..");
    const spec = useReal ? {
      command: process.execPath,
      args: ["--import", "tsx", join(repoRoot, "..", "hmharness", "packages", "web", "src", "desktop-host.ts")],
      env: { ELECTRON_RUN_AS_NODE: "1" }
    } : {
      command: process.execPath,
      // 直接走包真实路径(node_modules 里的 workspace junction 会被 ESM
      // realpath 化,导致 fake-host 的 argv[1]/import.meta.url 匹配失效)
      args: ["--import", "tsx", join(repoRoot, "packages", "host-adapter", "src", "fake-host.ts")],
      env: { ELECTRON_RUN_AS_NODE: "1" }
    };
    supervisor = new DesktopRuntimeSupervisor(spec, {
      onStateChange: broadcastHostState2,
      // 首次启动与 crash 自愈后的重启都会走这里:端口/token 都是新的,
      // 重建桥客户端并重新订阅 SSE(renderer 的 EventStore 靠 eventId 去重)
      onReady: (ep) => {
        client = new DesktopHostClient(`http://127.0.0.1:${ep.port}`, ep.token);
        sseAbort?.abort();
        sseAbort = new AbortController();
        lastEventId = "";
        void pumpEvents();
        logInfo("host", `bridge ready on 127.0.0.1:${ep.port} (runtime ${ep.version}, mode ${bridge.mode})`);
      }
    });
    try {
      await supervisor.start();
    } catch (err) {
      const detail = (() => {
        try {
          return JSON.stringify(err);
        } catch {
          return String(err);
        }
      })().slice(0, 400);
      bridge = { ...bridge, hostState: "failed", lastError: detail };
      logInfo("host", `start failed: ${detail}`);
    }
  }
  const allowedOrigins = new Set(
    isDev && rendererDevUrl ? [rendererDevUrl] : [pathToFileURL2(join(here, "..", "..", "dist-renderer", "index.html")).href]
  );
  app.whenReady().then(() => {
    const csp = isDev ? [
      "default-src 'self'",
      `script-src 'self' ${rendererDevUrl}`,
      "style-src 'self' 'unsafe-inline'",
      `connect-src 'self' ${rendererDevUrl} ws://127.0.0.1:*`,
      "img-src 'self' data:",
      "font-src 'self' data:"
    ].join("; ") : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:";
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [csp]
        }
      });
    });
    registerIpc2();
    createWindow2();
    void startHost();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow2();
    });
  });
  app.on("before-quit", (e) => {
    if (supervisor !== null && supervisor.state !== "stopped") {
      e.preventDefault();
      sseAbort?.abort();
      void supervisor.stop().finally(() => app.quit());
    }
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
var pushEvent;
var broadcastHostState;
var senderTrusted;
var hostCall;
var registerIpc;
var createWindow;
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vZWxlY3Ryb24vbWFpbi9pbmRleC50cyIsICIuLi8uLi8uLi8uLi9wYWNrYWdlcy9ob3N0LWFkYXB0ZXIvc3JjL3N1cGVydmlzb3IudHMiLCAiLi4vLi4vLi4vLi4vcGFja2FnZXMvY29udHJhY3RzL3NyYy9ldmVudC50cyIsICIuLi8uLi8uLi8uLi9wYWNrYWdlcy9jb250cmFjdHMvc3JjL2Vycm9yLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2NvbnRyYWN0cy9zcmMvZ3VhcmRzLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2hvc3QtYWRhcHRlci9zcmMvY2xpZW50LnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2hvc3QtYWRhcHRlci9zcmMvZmFrZS1ob3N0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIEhNSCBEZXNrdG9wIFx1MjAxNCBFbGVjdHJvbiBcdTRFM0JcdThGREJcdTdBMEIoQURSLTAwMS8wMDMvMDA0KVx1MzAwMlxuICpcbiAqIFx1NUI4OVx1NTE2OFx1NEUwRFx1NTNEOFx1OTFDRihcdTVGMDBcdTUzRDFcdThCQTFcdTUyMTIgTTAgXHU1MUZBXHU1M0UzXHU5NUU4ICsgRWxlY3Ryb24gXHU1Qjk4XHU2NUI5XHU1Qjg5XHU1MTY4XHU2RTA1XHU1MzU1KTpcbiAqICAtIHJlbmRlcmVyOmNvbnRleHRJc29sYXRpb24gKyBzYW5kYm94ICsgXHU3OTgxIG5vZGVJbnRlZ3JhdGlvbixcdTRFMjVcdTY4M0MgQ1NQO1xuICogIC0gXHU1QkZDXHU4MjJBL1x1NjVCMFx1N0E5N1x1NTNFM1x1NEUwMFx1NUY4Qlx1NjJEMlx1N0VERChcdTUzRUFcdTUyQTBcdThGN0RcdTYyMTFcdTRFRUNcdTgxRUFcdTVERjFcdTc2ODQgcmVuZGVyZXIpO1xuICogIC0gXHU2QkNGXHU2NzYxIElQQyBcdTY4MjFcdTlBOEMgc2VuZGVyIFx1NzY4NFx1OTg3Nlx1NUM0MiBmcmFtZSBVUkwgXHU1QzVFXHU0RThFXHU2NzJDXHU1RTk0XHU3NTI4LFx1OTAxQVx1OTA1M1x1NzY3RFx1NTQwRFx1NTM1NTtcbiAqICAtIGhvc3QgdG9rZW4gXHU1M0VBXHU1QjU4XHU1NzI4XHU0RThFXHU2NzJDXHU4RkRCXHU3QTBCXHU0RTBFXHU1QjUwXHU4RkRCXHU3QTBCIGVudixcdTY1RTVcdTVGRDdcdThGOTNcdTUxRkFcdTUyNERcdTUxNDhcdTgxMzFcdTY1NEY7XG4gKiAgLSBcdTUzNTVcdTVCOUVcdTRGOEJcdTk1MDE7XHU5MDAwXHU1MUZBXHU2NUY2XHU1M0VBXHU1MDVDXHU2QjYyXHU4MUVBXHU1REYxIHNwYXduIFx1NzY4NCBob3N0KFx1NEYxOFx1OTZDNVx1MjE5Mlx1NTE1Q1x1NUU5NSBraWxsKVx1MzAwMlxuICpcbiAqIFx1OTYzNlx1NkJCNUUoMjAyNi0xMC0xMCk6bWFpbiBcdTYzMDFcdTY3MDkgRGVza3RvcEhvc3RDbGllbnQsU1NFIFx1NEZFMVx1NUMwMVx1NkQ0MShldmVudDogaG1oKVxuICogXHU3RUNGIDUwbXMgXHU2Mjc5XHU5MUNGXHU2M0E4XHU3RUQ5IHJlbmRlcmVyO3NlbmRUYXNrL2FwcHJvdmUvaW50ZXJydXB0L3Nlc3Npb25zIFx1NTE2OFx1OTBFOFx1OEY2Q1x1NTNEMVxuICogXHU3RUQ5IGhvc3QgXHUyMDE0XHUyMDE0IGZha2UgXHU0RTBFXHU3NzFGXHU1QjlFIGhtaGFybmVzcyBkZXNrdG9wLWhvc3QgXHU4RDcwXHU1NDBDXHU0RTAwXHU2NzYxXHU0RUUzXHU3ODAxXHU4REVGXHU1Rjg0XHUzMDAyXG4gKi9cbmltcG9ydCB7IGFwcCwgQnJvd3NlcldpbmRvdywgaXBjTWFpbiwgc2Vzc2lvbiwgc2hlbGwgfSBmcm9tICdlbGVjdHJvbic7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSAnbm9kZTpwYXRoJztcbmltcG9ydCB7IHBhdGhUb0ZpbGVVUkwgfSBmcm9tICdub2RlOnVybCc7XG5pbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSAnbm9kZTpjcnlwdG8nO1xuaW1wb3J0IHsgRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yLCBEZXNrdG9wSG9zdENsaWVudCwgZW52ZWxvcGVGcm9tRnJhbWUsIHR5cGUgSG9zdFN0YXRlIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2hvc3QtYWRhcHRlcic7XG5pbXBvcnQgeyBpc0V2ZW50RW52ZWxvcGUsIHR5cGUgRXZlbnRFbnZlbG9wZSB9IGZyb20gJ0BobWgtZGVza3RvcC9jb250cmFjdHMnO1xuXG5jb25zdCBoZXJlID0gaW1wb3J0Lm1ldGEuZGlybmFtZSA/PyAnLic7XG5jb25zdCBpc0RldiA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX0RFViA9PT0gJzEnO1xuY29uc3QgcmVuZGVyZXJEZXZVcmwgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9SRU5ERVJFUl9VUkwgPz8gJyc7XG5jb25zdCBwcmVsb2FkUGF0aCA9IGpvaW4oaGVyZSwgJy4uL3ByZWxvYWQvaW5kZXguY2pzJyk7XG5cbi8qIC0tLS0gXHU2NUU1XHU1RkQ3XHU4MTMxXHU2NTRGOnRva2VuL2F1dGhvcml6YXRpb24gXHU2QzM4XHU0RTBEXHU4RkRCXHU2M0E3XHU1MjM2XHU1M0YwIC0tLS0gKi9cbmNvbnN0IHNlY3JldHM6IHN0cmluZ1tdID0gW107XG5mdW5jdGlvbiByZWRhY3Qoczogc3RyaW5nKTogc3RyaW5nIHtcbiAgbGV0IG91dCA9IHM7XG4gIGZvciAoY29uc3Qgc2VjIG9mIHNlY3JldHMpIHtcbiAgICBpZiAoc2VjLmxlbmd0aCA+PSA4KSBvdXQgPSBvdXQuc3BsaXQoc2VjKS5qb2luKCdbcmVkYWN0ZWRdJyk7XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cbmZ1bmN0aW9uIGxvZ0luZm8odGFnOiBzdHJpbmcsIG1zZzogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnNvbGUubG9nKGBbaG1oLWRlc2t0b3A6JHt0YWd9XSAke3JlZGFjdChtc2cpfWApO1xufVxuXG4vKiAtLS0tIFx1NTM1NVx1NUI5RVx1NEY4QiAtLS0tICovXG5pZiAoIWFwcC5yZXF1ZXN0U2luZ2xlSW5zdGFuY2VMb2NrKCkpIHtcbiAgYXBwLnF1aXQoKTtcbn0gZWxzZSB7XG4gIGFwcC5vbignc2Vjb25kLWluc3RhbmNlJywgKCkgPT4ge1xuICAgIGNvbnN0IHdpbiA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpWzBdO1xuICAgIGlmICh3aW4pIHtcbiAgICAgIGlmICh3aW4uaXNNaW5pbWl6ZWQoKSkgd2luLnJlc3RvcmUoKTtcbiAgICAgIHdpbi5mb2N1cygpO1xuICAgIH1cbiAgfSk7XG5cbiAgLyogLS0tLSBob3N0IFx1NzZEMVx1N0JBMSArIFx1Njg2NVx1NUJBMlx1NjIzN1x1N0FFRiAtLS0tICovXG4gIGludGVyZmFjZSBCcmlkZ2VTbmFwc2hvdCB7XG4gICAgaG9zdFN0YXRlOiBIb3N0U3RhdGU7XG4gICAgaG9zdFBvcnQ6IG51bWJlciB8IG51bGw7XG4gICAgaG9zdFZlcnNpb246IHN0cmluZyB8IG51bGw7XG4gICAgbGFzdEVycm9yOiBzdHJpbmcgfCBudWxsO1xuICAgIG1vZGU6ICdmYWtlJyB8ICdyZWFsJztcbiAgfVxuICBsZXQgc3VwZXJ2aXNvcjogRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yIHwgbnVsbCA9IG51bGw7XG4gIGxldCBjbGllbnQ6IERlc2t0b3BIb3N0Q2xpZW50IHwgbnVsbCA9IG51bGw7XG4gIGxldCBicmlkZ2U6IEJyaWRnZVNuYXBzaG90ID0geyBob3N0U3RhdGU6ICdzdG9wcGVkJywgaG9zdFBvcnQ6IG51bGwsIGhvc3RWZXJzaW9uOiBudWxsLCBsYXN0RXJyb3I6IG51bGwsIG1vZGU6ICdmYWtlJyB9O1xuICAvKiogXHU0RThCXHU0RUY2XHU2Mjc5XHU5MUNGXHU3RjEzXHU1MUIyOlx1OUFEOFx1OTg5MSBTU0UgXHU0RTBEXHU5MDEwXHU2NzYxXHU4RkM3IElQQyw1MG1zIFx1NjI3OVx1OTFDRiBmbHVzaChcdTZFMzJcdTY3RDNcdTRFMERcdTUzNjEpXHUzMDAyICovXG4gIGxldCBldmVudEJ1ZmZlcjogRXZlbnRFbnZlbG9wZVtdID0gW107XG4gIGxldCBmbHVzaFRpbWVyOiBOb2RlSlMuVGltZW91dCB8IG51bGwgPSBudWxsO1xuICBsZXQgc3NlQWJvcnQ6IEFib3J0Q29udHJvbGxlciB8IG51bGwgPSBudWxsO1xuICBsZXQgbGFzdEV2ZW50SWQgPSAnJztcbiAgLyoqIFx1NjcyQVx1NzdFNS9cdTc1NzhcdTVGNjJcdTRGRTFcdTVDMDFcdThCQTFcdTY1NzAoU0NIRU1BX01JU01BVENIIFx1OTc2Mlx1NTQxMVx1OEJDQVx1NjVBRCxcdTRFMERcdTVEMjkpXHUzMDAyICovXG4gIGxldCBkcm9wcGVkRnJhbWVzID0gMDtcblxuICBmdW5jdGlvbiBwdXNoRXZlbnQoZW52OiBFdmVudEVudmVsb3BlKTogdm9pZCB7XG4gICAgZXZlbnRCdWZmZXIucHVzaChlbnYpO1xuICAgIGlmIChldmVudEJ1ZmZlci5sZW5ndGggPiAyXzAwMCkgZXZlbnRCdWZmZXIuc3BsaWNlKDAsIGV2ZW50QnVmZmVyLmxlbmd0aCAtIDJfMDAwKTtcbiAgICBpZiAoZmx1c2hUaW1lciA9PT0gbnVsbCkge1xuICAgICAgZmx1c2hUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICBmbHVzaFRpbWVyID0gbnVsbDtcbiAgICAgICAgY29uc3QgYmF0Y2ggPSBldmVudEJ1ZmZlcjtcbiAgICAgICAgZXZlbnRCdWZmZXIgPSBbXTtcbiAgICAgICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XG4gICAgICAgICAgaWYgKCF3LmlzRGVzdHJveWVkKCkpIHcud2ViQ29udGVudHMuc2VuZCgnYnJpZGdlOmV2ZW50LWJhdGNoJywgYmF0Y2gpO1xuICAgICAgICB9XG4gICAgICB9LCA1MCk7XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gYnJvYWRjYXN0SG9zdFN0YXRlKHM6IEhvc3RTdGF0ZSwgaW5mbzogeyByZXN0YXJ0Q291bnQ6IG51bWJlcjsgbGFzdEVycm9yPzogc3RyaW5nIH0pOiB2b2lkIHtcbiAgICBicmlkZ2UgPSB7IC4uLmJyaWRnZSwgaG9zdFN0YXRlOiBzLCBob3N0UG9ydDogc3VwZXJ2aXNvcj8uZW5kcG9pbnQ/LnBvcnQgPz8gbnVsbCwgaG9zdFZlcnNpb246IHN1cGVydmlzb3I/LmVuZHBvaW50Py52ZXJzaW9uID8/IG51bGwgfTtcbiAgICBsb2dJbmZvKCdob3N0JywgYHN0YXRlPSR7c30ke2luZm8ubGFzdEVycm9yICE9PSB1bmRlZmluZWQgPyBgIGVycj0ke2luZm8ubGFzdEVycm9yfWAgOiAnJ31gKTtcbiAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcbiAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ2JyaWRnZTpob3N0LXN0YXRlJywgcywgaW5mbyk7XG4gICAgfVxuICB9XG5cbiAgLyoqIFNTRSBcdTZENDFcdThCQTJcdTk2MDU6XHU0RkUxXHU1QzAxKGV2ZW50OiBobWgpXHU2Mjc5XHU5MUNGXHU2M0E4IHJlbmRlcmVyO1x1OUFEOFx1OTg5MSBkZWx0YS9saW5lIFx1NTM5Rlx1NUUyN1xuICAgKiAgXHU0RjVDXHU0RTNBXHU2RDQxXHU1NzU3XHU4RjZDXHU1M0QxKHJlbmRlcmVyIFx1NjJGQ1x1NjNBNVx1NUY1M1x1NTI0RCBhc3Npc3RhbnQgXHU1MzYwXHU0RjREKVx1MzAwMlx1NjVBRFx1N0VCRlx1ODFFQVx1NTJBOFx1OTFDRFx1OEZERVx1MzAwMiAqL1xuICBhc3luYyBmdW5jdGlvbiBwdW1wRXZlbnRzKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmIChjbGllbnQgPT09IG51bGwpIHJldHVybjtcbiAgICBmb3IgKDs7KSB7XG4gICAgICBjb25zdCBjID0gY2xpZW50O1xuICAgICAgaWYgKGMgPT09IG51bGwpIHJldHVybjtcbiAgICAgIHRyeSB7XG4gICAgICAgIGZvciBhd2FpdCAoY29uc3QgZnJhbWUgb2YgYy5yYXdFdmVudHMobGFzdEV2ZW50SWQgPT09ICcnID8gdW5kZWZpbmVkIDogbGFzdEV2ZW50SWQsIHNzZUFib3J0Py5zaWduYWwpKSB7XG4gICAgICAgICAgaWYgKGZyYW1lLmV2ZW50ID09PSAnaG1oJykge1xuICAgICAgICAgICAgY29uc3QgZW52ID0gZW52ZWxvcGVGcm9tRnJhbWUoZnJhbWUpO1xuICAgICAgICAgICAgaWYgKGVudiA9PT0gbnVsbCkge1xuICAgICAgICAgICAgICBkcm9wcGVkRnJhbWVzICs9IDE7XG4gICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgbGFzdEV2ZW50SWQgPSBlbnYuZXZlbnRJZDtcbiAgICAgICAgICAgIHB1c2hFdmVudChlbnYpO1xuICAgICAgICAgIH0gZWxzZSBpZiAoZnJhbWUuZXZlbnQgPT09ICdkZWx0YScgfHwgZnJhbWUuZXZlbnQgPT09ICdsaW5lJykge1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgY29uc3QgZCA9IEpTT04ucGFyc2UoZnJhbWUuZGF0YSkgYXMgeyBzZXNzaW9uSWQ/OiBzdHJpbmc7IGs/OiBzdHJpbmc7IGNodW5rPzogc3RyaW5nOyB0ZXh0Pzogc3RyaW5nIH07XG4gICAgICAgICAgICAgIGNvbnN0IHBheWxvYWQgPSBmcmFtZS5ldmVudCA9PT0gJ2RlbHRhJ1xuICAgICAgICAgICAgICAgID8geyBzZXNzaW9uSWQ6IGQuc2Vzc2lvbklkID8/ICcnLCBraW5kOiBkLmsgPz8gJ3RleHQnLCBjaHVuazogU3RyaW5nKGQuY2h1bmsgPz8gJycpIH1cbiAgICAgICAgICAgICAgICA6IHsgc2Vzc2lvbklkOiBkLnNlc3Npb25JZCA/PyAnJywga2luZDogJ2xpbmUnLCBjaHVuazogU3RyaW5nKGQudGV4dCA/PyAnJykgfTtcbiAgICAgICAgICAgICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XG4gICAgICAgICAgICAgICAgaWYgKCF3LmlzRGVzdHJveWVkKCkpIHcud2ViQ29udGVudHMuc2VuZCgnYnJpZGdlOnN0cmVhbS1jaHVuaycsIHBheWxvYWQpO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGNhdGNoIHsgLyogbWFsZm9ybWVkIHN0cmVhbSBmcmFtZTogc2tpcCAqLyB9XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHJldHVybjsgLy8gXHU2RDQxXHU2QjYzXHU1RTM4XHU3RUQzXHU2NzVGKGhvc3QgXHU1MTczXHU5NUVEKVxuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8vIFx1NjVBRFx1N0VCRjpcdTc3RURcdTkwMDBcdTkwN0ZcdTU0MEVcdTkxQ0RcdThGREUoc3VwZXJ2aXNvciBcdTUzRUZcdTgwRkRcdTZCNjNcdTU3MjhcdTkxQ0RcdTU0MkYgaG9zdClcbiAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgMV8wMDApKTtcbiAgICAgICAgaWYgKHNzZUFib3J0Py5zaWduYWwuYWJvcnRlZCkgcmV0dXJuO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8qKiBkZXYgXHU5RUQ4XHU4QkE0IGZha2UgaG9zdDtITUhfREVTS1RPUF9SRUFMPTEgXHU2NUY2XHU4RkRFXHU3NzFGXHU1QjlFIGhtaGFybmVzcyBkZXNrdG9wLWhvc3RcdTMwMDJcbiAgICogIFx1NkNFOFx1NjEwRjpFbGVjdHJvbiBcdTRFM0JcdThGREJcdTdBMEJcdTc2ODQgcHJvY2Vzcy5leGVjUGF0aCBcdTY2MkYgZWxlY3Ryb24uZXhlXHUyMDE0XHUyMDE0aG9zdCBcdTVCNTBcdThGREJcdTdBMEJcbiAgICogIFx1NUZDNVx1OTg3Qlx1NUUyNiBFTEVDVFJPTl9SVU5fQVNfTk9ERT0xIFx1NjI0RFx1NEYxQVx1NEVFNVx1N0VBRiBub2RlIFx1OEJFRFx1NEU0OVx1OEREMSAtLWltcG9ydCB0c3hcdTMwMDIgKi9cbiAgYXN5bmMgZnVuY3Rpb24gc3RhcnRIb3N0KCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IHVzZVJlYWwgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9SRUFMID09PSAnMSc7XG4gICAgYnJpZGdlID0geyAuLi5icmlkZ2UsIG1vZGU6IHVzZVJlYWwgPyAncmVhbCcgOiAnZmFrZScgfTtcbiAgICBjb25zdCByZXBvUm9vdCA9IGpvaW4oaGVyZSwgJy4uJywgJy4uJywgJy4uJywgJy4uJyk7IC8vIGFwcHMvZGVza3RvcC9kaXN0LWVsZWN0cm9uL21haW4gXHUyMTkyIHJlcG8gcm9vdFxuICAgIGNvbnN0IHNwZWMgPSB1c2VSZWFsXG4gICAgICA/IHtcbiAgICAgICAgICBjb21tYW5kOiBwcm9jZXNzLmV4ZWNQYXRoLFxuICAgICAgICAgIGFyZ3M6IFsnLS1pbXBvcnQnLCAndHN4Jywgam9pbihyZXBvUm9vdCwgJy4uJywgJ2htaGFybmVzcycsICdwYWNrYWdlcycsICd3ZWInLCAnc3JjJywgJ2Rlc2t0b3AtaG9zdC50cycpXSxcbiAgICAgICAgICBlbnY6IHsgRUxFQ1RST05fUlVOX0FTX05PREU6ICcxJyB9LFxuICAgICAgICB9XG4gICAgICA6IHtcbiAgICAgICAgICBjb21tYW5kOiBwcm9jZXNzLmV4ZWNQYXRoLFxuICAgICAgICAgIC8vIFx1NzZGNFx1NjNBNVx1OEQ3MFx1NTMwNVx1NzcxRlx1NUI5RVx1OERFRlx1NUY4NChub2RlX21vZHVsZXMgXHU5MUNDXHU3Njg0IHdvcmtzcGFjZSBqdW5jdGlvbiBcdTRGMUFcdTg4QUIgRVNNXG4gICAgICAgICAgLy8gcmVhbHBhdGggXHU1MzE2LFx1NUJGQ1x1ODFGNCBmYWtlLWhvc3QgXHU3Njg0IGFyZ3ZbMV0vaW1wb3J0Lm1ldGEudXJsIFx1NTMzOVx1OTE0RFx1NTkzMVx1NjU0OClcbiAgICAgICAgICBhcmdzOiBbJy0taW1wb3J0JywgJ3RzeCcsIGpvaW4ocmVwb1Jvb3QsICdwYWNrYWdlcycsICdob3N0LWFkYXB0ZXInLCAnc3JjJywgJ2Zha2UtaG9zdC50cycpXSxcbiAgICAgICAgICBlbnY6IHsgRUxFQ1RST05fUlVOX0FTX05PREU6ICcxJyB9LFxuICAgICAgICB9O1xuICAgIHN1cGVydmlzb3IgPSBuZXcgRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yKHNwZWMsIHtcbiAgICAgIG9uU3RhdGVDaGFuZ2U6IGJyb2FkY2FzdEhvc3RTdGF0ZSxcbiAgICAgIC8vIFx1OTk5Nlx1NkIyMVx1NTQyRlx1NTJBOFx1NEUwRSBjcmFzaCBcdTgxRUFcdTYxMDhcdTU0MEVcdTc2ODRcdTkxQ0RcdTU0MkZcdTkwRkRcdTRGMUFcdThENzBcdThGRDlcdTkxQ0M6XHU3QUVGXHU1M0UzL3Rva2VuIFx1OTBGRFx1NjYyRlx1NjVCMFx1NzY4NCxcbiAgICAgIC8vIFx1OTFDRFx1NUVGQVx1Njg2NVx1NUJBMlx1NjIzN1x1N0FFRlx1NUU3Nlx1OTFDRFx1NjVCMFx1OEJBMlx1OTYwNSBTU0UocmVuZGVyZXIgXHU3Njg0IEV2ZW50U3RvcmUgXHU5NzYwIGV2ZW50SWQgXHU1M0JCXHU5MUNEKVxuICAgICAgb25SZWFkeTogKGVwKSA9PiB7XG4gICAgICAgIGNsaWVudCA9IG5ldyBEZXNrdG9wSG9zdENsaWVudChgaHR0cDovLzEyNy4wLjAuMToke2VwLnBvcnR9YCwgZXAudG9rZW4pO1xuICAgICAgICBzc2VBYm9ydD8uYWJvcnQoKTtcbiAgICAgICAgc3NlQWJvcnQgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gICAgICAgIGxhc3RFdmVudElkID0gJyc7XG4gICAgICAgIHZvaWQgcHVtcEV2ZW50cygpO1xuICAgICAgICBsb2dJbmZvKCdob3N0JywgYGJyaWRnZSByZWFkeSBvbiAxMjcuMC4wLjE6JHtlcC5wb3J0fSAocnVudGltZSAke2VwLnZlcnNpb259LCBtb2RlICR7YnJpZGdlLm1vZGV9KWApO1xuICAgICAgfSxcbiAgICB9KTtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgc3VwZXJ2aXNvci5zdGFydCgpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgY29uc3QgZGV0YWlsID0gKCgpID0+IHsgdHJ5IHsgcmV0dXJuIEpTT04uc3RyaW5naWZ5KGVycik7IH0gY2F0Y2ggeyByZXR1cm4gU3RyaW5nKGVycik7IH0gfSkoKS5zbGljZSgwLCA0MDApO1xuICAgICAgYnJpZGdlID0geyAuLi5icmlkZ2UsIGhvc3RTdGF0ZTogJ2ZhaWxlZCcsIGxhc3RFcnJvcjogZGV0YWlsIH07XG4gICAgICBsb2dJbmZvKCdob3N0JywgYHN0YXJ0IGZhaWxlZDogJHtkZXRhaWx9YCk7XG4gICAgfVxuICB9XG5cbiAgLyogLS0tLSBJUEMgXHU3NjdEXHU1NDBEXHU1MzU1ICsgc2VuZGVyIFx1NjgyMVx1OUE4QyAtLS0tICovXG4gIGNvbnN0IGFsbG93ZWRPcmlnaW5zID0gbmV3IFNldDxzdHJpbmc+KFxuICAgIGlzRGV2ICYmIHJlbmRlcmVyRGV2VXJsXG4gICAgICA/IFtyZW5kZXJlckRldlVybF1cbiAgICAgIDogW3BhdGhUb0ZpbGVVUkwoam9pbihoZXJlLCAnLi4nLCAnLi4nLCAnZGlzdC1yZW5kZXJlcicsICdpbmRleC5odG1sJykpLmhyZWZdLFxuICApO1xuXG4gIGZ1bmN0aW9uIHNlbmRlclRydXN0ZWQoc2VuZGVyRnJhbWU6IEVsZWN0cm9uLldlYkZyYW1lTWFpbiB8IG51bGwgfCB1bmRlZmluZWQpOiBib29sZWFuIHtcbiAgICBpZiAoc2VuZGVyRnJhbWUgPT09IG51bGwgfHwgc2VuZGVyRnJhbWUgPT09IHVuZGVmaW5lZCkgcmV0dXJuIGZhbHNlO1xuICAgIGxldCB0b3A6IEVsZWN0cm9uLldlYkZyYW1lTWFpbiB8IG51bGwgPSBzZW5kZXJGcmFtZTtcbiAgICB3aGlsZSAodG9wPy5wYXJlbnQgIT09IG51bGwgJiYgdG9wPy5wYXJlbnQgIT09IHVuZGVmaW5lZCkgdG9wID0gdG9wLnBhcmVudDtcbiAgICBjb25zdCB1cmwgPSB0b3A/LnVybCA/PyAnJztcbiAgICBmb3IgKGNvbnN0IG9yaWdpbiBvZiBhbGxvd2VkT3JpZ2lucykge1xuICAgICAgaWYgKHVybCA9PT0gb3JpZ2luIHx8IHVybC5zdGFydHNXaXRoKGAke29yaWdpbn0vYCkgfHwgdXJsLnN0YXJ0c1dpdGgoYCR7b3JpZ2lufT9gKSkgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIC8qKiBcdTk3MDBcdTg5ODEgaG9zdCBcdTVDMzFcdTdFRUFcdTc2ODQgSVBDIGhhbmRsZXIgXHU1MTZDXHU1MTcxXHU1OEYzOlx1NjcyQVx1NUMzMVx1N0VFQVx1OEZENFx1NTZERVx1N0VEM1x1Njc4NFx1NTMxNlx1OTUxOVx1OEJFRlx1MzAwMiAqL1xuICBmdW5jdGlvbiBob3N0Q2FsbDxUPihldmVudDogRWxlY3Ryb24uSXBjTWFpbkludm9rZUV2ZW50LCBmbjogKGM6IERlc2t0b3BIb3N0Q2xpZW50KSA9PiBQcm9taXNlPFQ+KTogUHJvbWlzZTxUIHwgeyBlcnJvcjogc3RyaW5nOyBjb2RlOiBzdHJpbmcgfT4ge1xuICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9KTtcbiAgICBpZiAoY2xpZW50ID09PSBudWxsIHx8IGJyaWRnZS5ob3N0U3RhdGUgIT09ICdyZWFkeScpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogYGhvc3Qgbm90IHJlYWR5ICgke2JyaWRnZS5ob3N0U3RhdGV9KWAsIGNvZGU6ICdIT1NUX05PVF9SRUFEWScgfSk7XG4gICAgfVxuICAgIHJldHVybiBmbihjbGllbnQpLmNhdGNoKChlcnI6IHVua25vd24pID0+IHtcbiAgICAgIGNvbnN0IGRldGFpbCA9ICgoKSA9PiB7IHRyeSB7IHJldHVybiBKU09OLnN0cmluZ2lmeShlcnIpOyB9IGNhdGNoIHsgcmV0dXJuIFN0cmluZyhlcnIpOyB9IH0pKCkuc2xpY2UoMCwgMzAwKTtcbiAgICAgIHJldHVybiB7IGVycm9yOiBkZXRhaWwsIGNvZGU6ICdCUklER0VfRVJST1InIH07XG4gICAgfSk7XG4gIH1cblxuICBmdW5jdGlvbiByZWdpc3RlcklwYygpOiB2b2lkIHtcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmdldC1zdGF0ZScsIChldmVudCkgPT4ge1xuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJyB9O1xuICAgICAgcmV0dXJuIHsgLi4uYnJpZGdlLCBkcm9wcGVkRnJhbWVzIH07XG4gICAgfSk7XG5cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnNlc3Npb25zJywgKGV2ZW50KSA9PlxuICAgICAgaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248eyBzZXNzaW9uczogQXJyYXk8eyBpZDogc3RyaW5nOyB0aXRsZTogc3RyaW5nOyB0YXNrOiBzdHJpbmc7IG91dGNvbWU6IHN0cmluZzsgdHVybnM6IG51bWJlcjsgdG9vbFVzZXM6IG51bWJlcjsgdGltZTogc3RyaW5nOyBjd2Q6IHN0cmluZzsgY3JlYXRlZEF0OiBzdHJpbmc7IHVwZGF0ZWRBdDogc3RyaW5nIH0+IH0+KCcvYXBpL3Nlc3Npb25zP2xpbWl0PTEwMCcpKSk7XG5cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnNlbmQtdGFzaycsIChldmVudCwgdGV4dDogdW5rbm93biwgc2Vzc2lvbklkOiB1bmtub3duLCBtb2RlOiB1bmtub3duKSA9PiB7XG4gICAgICBjb25zdCB0YXNrID0gdHlwZW9mIHRleHQgPT09ICdzdHJpbmcnID8gdGV4dC5zbGljZSgwLCAyMF8wMDApIDogJyc7XG4gICAgICBjb25zdCBzaWQgPSB0eXBlb2Ygc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IHNlc3Npb25JZC5zbGljZSgwLCA4MCkgOiAnJztcbiAgICAgIGNvbnN0IG0gPSBtb2RlID09PSAnYXV0bycgfHwgbW9kZSA9PT0gJ3lvbG8nID8gbW9kZSA6ICdhc2snO1xuICAgICAgaWYgKHRhc2sgPT09ICcnIHx8IHNpZCA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBvazogZmFsc2UsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW47IHJ1bklkPzogc3RyaW5nIH0+KCcvYXBpL3Rhc2snLCB7IHRleHQ6IHRhc2ssIHNlc3Npb25JZDogc2lkLCBtb2RlOiBtIH0pKTtcbiAgICB9KTtcblxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6YXBwcm92ZScsIChldmVudCwgZ3JhbnRlZDogdW5rbm93biwgc2Vzc2lvbklkOiB1bmtub3duKSA9PlxuICAgICAgaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvYXBwcm92ZScsIHtcbiAgICAgICAgZ3JhbnRlZDogZ3JhbnRlZCA9PT0gdHJ1ZSxcbiAgICAgICAgc2Vzc2lvbklkOiB0eXBlb2Ygc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IHNlc3Npb25JZC5zbGljZSgwLCA4MCkgOiAnJyxcbiAgICAgIH0pKSk7XG5cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmludGVycnVwdCcsIChldmVudCwgc2Vzc2lvbklkOiB1bmtub3duKSA9PlxuICAgICAgaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvaW50ZXJydXB0Jywge1xuICAgICAgICBzZXNzaW9uSWQ6IHR5cGVvZiBzZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gc2Vzc2lvbklkLnNsaWNlKDAsIDgwKSA6ICcnLFxuICAgICAgfSkpKTtcblxuICAgIC8vIC0tLS0gTTQ6XHU1REU1XHU0RjVDXHU1MzNBXHU2NTg3XHU0RUY2XHU5NzYyKFx1OERFRlx1NUY4NFx1NjM4OFx1Njc0M1x1NTcyOCBydW50aW1lOmluc2lkZVdzIFx1NjgyMVx1OUE4QykgLS0tLVxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6ZnMtbGlzdCcsIChldmVudCwgcGF0aDogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3QgcCA9IHR5cGVvZiBwYXRoID09PSAnc3RyaW5nJyA/IHBhdGguc2xpY2UoMCwgMTAwMCkgOiAnJztcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oYC9hcGkvZnM/ZmlsZXM9MSR7cCAhPT0gJycgPyBgJnBhdGg9JHtlbmNvZGVVUklDb21wb25lbnQocCl9YCA6ICcnfWApKTtcbiAgICB9KTtcblxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6ZnMtcmVhZCcsIChldmVudCwgcGF0aDogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3QgcCA9IHR5cGVvZiBwYXRoID09PSAnc3RyaW5nJyA/IHBhdGguc2xpY2UoMCwgMTAwMCkgOiAnJztcbiAgICAgIGlmIChwID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAncGF0aCByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KGAvYXBpL2ZzL3JlYWQ/cGF0aD0ke2VuY29kZVVSSUNvbXBvbmVudChwKX1gKSk7XG4gICAgfSk7XG5cbiAgICAvLyAtLS0tIE00OkRpZmYgXHU5NzYyXHU2NzdGKFx1NTNFQVx1OEJGQiBnaXQgXHU1M0Q4XHU2NkY0O1x1NjM4OFx1Njc0M1x1NTcyOCBydW50aW1lKSAtLS0tXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpkaWZmJywgKGV2ZW50LCBzZXNzaW9uSWQ6IHVua25vd24pID0+IHtcbiAgICAgIGNvbnN0IHNpZCA9IHR5cGVvZiBzZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gc2Vzc2lvbklkLnNsaWNlKDAsIDgwKSA6ICcnO1xuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPFJlY29yZDxzdHJpbmcsIHVua25vd24+PihgL2FwaS9kaWZmJHtzaWQgIT09ICcnID8gYD9zZXNzaW9uSWQ9JHtlbmNvZGVVUklDb21wb25lbnQoc2lkKX1gIDogJyd9YCkpO1xuICAgIH0pO1xuXG4gICAgLy8gLS0tLSBNNTpcdThCQTRcdTc3RTVcdTcyQjZcdTYwMDEoXHU3RUQzXHU2Nzg0XHU1MzE2XHU0RThCXHU1QjlFO1x1N0YzQVx1NjU3MFx1NjM2RVx1NUI1N1x1NkJCNVx1NzUzMSBVSSBcdTY2M0VcdTc5M0FcIlx1NjVFMFx1NjU3MFx1NjM2RVwiKSAtLS0tXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpjb2duaXRpdmUnLCAoZXZlbnQpID0+XG4gICAgICBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oJy9hcGkvY29nbml0aXZlJykpKTtcblxuICAgIC8vIC0tLS0gXHU1Mzg2XHU1M0YyXHU0RjFBXHU4QkREXHU5ODg0XHU4OUM4KFx1NjcwMFx1NTQwRSA4MCBcdTY3NjEsXHU2QkNGXHU2NzYxIDUwMCBcdTVCNTc7cnVudGltZSBcdTY3NDNcdTVBMDFcdTY1NzBcdTYzNkUpIC0tLS1cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnNlc3Npb24tcHJldmlldycsIChldmVudCwgaWQ6IHVua25vd24pID0+IHtcbiAgICAgIGNvbnN0IHNpZCA9IHR5cGVvZiBpZCA9PT0gJ3N0cmluZycgPyBpZC5yZXBsYWNlKC9bXmEtekEtWjAtOV86LkAtXS9nLCAnJykuc2xpY2UoMCwgODApIDogJyc7XG4gICAgICBpZiAoc2lkID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAnaWQgcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPFJlY29yZDxzdHJpbmcsIHVua25vd24+PihgL2FwaS9zZXNzaW9ucy8ke2VuY29kZVVSSUNvbXBvbmVudChzaWQpfWApKTtcbiAgICB9KTtcblxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6c3RvcC1ob3N0JywgKGV2ZW50KSA9PiB7XG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInIH07XG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XG4gICAgICAgIHNzZUFib3J0Py5hYm9ydCgpO1xuICAgICAgICBhd2FpdCBzdXBlcnZpc29yPy5zdG9wKCk7XG4gICAgICAgIGFwcC5xdWl0KCk7XG4gICAgICB9KSgpO1xuICAgICAgcmV0dXJuIHsgb2s6IHRydWUgfTtcbiAgICB9KTtcbiAgfVxuXG4gIC8qIC0tLS0gXHU3QTk3XHU1M0UzXHU0RTBFXHU1Qjg5XHU1MTY4XHU3QjU2XHU3NTY1IC0tLS0gKi9cbiAgZnVuY3Rpb24gY3JlYXRlV2luZG93KCk6IHZvaWQge1xuICAgIGNvbnN0IHdpbiA9IG5ldyBCcm93c2VyV2luZG93KHtcbiAgICAgIHdpZHRoOiAxNDQwLFxuICAgICAgaGVpZ2h0OiA5MDAsXG4gICAgICBtaW5XaWR0aDogOTYwLFxuICAgICAgbWluSGVpZ2h0OiA2MDAsXG4gICAgICBzaG93OiBmYWxzZSxcbiAgICAgIGJhY2tncm91bmRDb2xvcjogJyMxNDE0MTYnLFxuICAgICAgdGl0bGU6ICdITUggRGVza3RvcCcsXG4gICAgICB3ZWJQcmVmZXJlbmNlczoge1xuICAgICAgICBwcmVsb2FkOiBwcmVsb2FkUGF0aCxcbiAgICAgICAgY29udGV4dElzb2xhdGlvbjogdHJ1ZSxcbiAgICAgICAgc2FuZGJveDogdHJ1ZSxcbiAgICAgICAgbm9kZUludGVncmF0aW9uOiBmYWxzZSxcbiAgICAgICAgbm9kZUludGVncmF0aW9uSW5Xb3JrZXI6IGZhbHNlLFxuICAgICAgICB3ZWJTZWN1cml0eTogdHJ1ZSxcbiAgICAgICAgc3BlbGxjaGVjazogZmFsc2UsXG4gICAgICAgIGRldlRvb2xzOiBpc0RldixcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgd2luLm9uY2UoJ3JlYWR5LXRvLXNob3cnLCAoKSA9PiB3aW4uc2hvdygpKTtcblxuICAgIC8vIFx1NTNFQVx1NTE0MVx1OEJCOFx1NTJBMFx1OEY3RFx1NjIxMVx1NEVFQ1x1ODFFQVx1NURGMVx1NzY4NCByZW5kZXJlcjtcdTRFRkJcdTRGNTVcdTVCRkNcdTgyMkEvXHU2NUIwXHU3QTk3XHU1M0UzXHU0RTAwXHU1RjhCXHU2MkQyXHU3RUREXG4gICAgd2luLndlYkNvbnRlbnRzLnNldFdpbmRvd09wZW5IYW5kbGVyKCh7IHVybCB9KSA9PiB7XG4gICAgICBpZiAoL15odHRwcz86XFwvXFwvLy50ZXN0KHVybCkpIHZvaWQgc2hlbGwub3BlbkV4dGVybmFsKHVybCk7XG4gICAgICByZXR1cm4geyBhY3Rpb246ICdkZW55JyB9O1xuICAgIH0pO1xuICAgIHdpbi53ZWJDb250ZW50cy5vbignd2lsbC1uYXZpZ2F0ZScsIChlLCB1cmwpID0+IHtcbiAgICAgIGNvbnN0IG9rID0gWy4uLmFsbG93ZWRPcmlnaW5zXS5zb21lKChvKSA9PiB1cmwgPT09IG8gfHwgdXJsLnN0YXJ0c1dpdGgoYCR7b30vYCkgfHwgdXJsLnN0YXJ0c1dpdGgoYCR7b30/YCkpO1xuICAgICAgaWYgKCFvaykge1xuICAgICAgICBsb2dJbmZvKCduYXYnLCBgYmxvY2tlZCBuYXZpZ2F0aW9uIHRvICR7dXJsLnNsaWNlKDAsIDEyMCl9YCk7XG4gICAgICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIGlmIChpc0RldiAmJiByZW5kZXJlckRldlVybCkge1xuICAgICAgdm9pZCB3aW4ubG9hZFVSTChyZW5kZXJlckRldlVybCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHZvaWQgd2luLmxvYWRGaWxlKGpvaW4oaGVyZSwgJy4uJywgJy4uJywgJ2Rpc3QtcmVuZGVyZXInLCAnaW5kZXguaHRtbCcpKTtcbiAgICB9XG4gIH1cblxuICBhcHAud2hlblJlYWR5KCkudGhlbigoKSA9PiB7XG4gICAgLy8gQ1NQKGRldiBcdTRFMEUgcHJvZCBcdTRFMERcdTU0MEM7cHJvZCBcdTRFMERcdTUxNDFcdThCQjhcdTRFRkJcdTRGNTVcdThGRENcdTdBMEJcdTZFOTApXG4gICAgY29uc3QgY3NwID0gaXNEZXZcbiAgICAgID8gW1xuICAgICAgICAgIFwiZGVmYXVsdC1zcmMgJ3NlbGYnXCIsXG4gICAgICAgICAgYHNjcmlwdC1zcmMgJ3NlbGYnICR7cmVuZGVyZXJEZXZVcmx9YCxcbiAgICAgICAgICBcInN0eWxlLXNyYyAnc2VsZicgJ3Vuc2FmZS1pbmxpbmUnXCIsXG4gICAgICAgICAgYGNvbm5lY3Qtc3JjICdzZWxmJyAke3JlbmRlcmVyRGV2VXJsfSB3czovLzEyNy4wLjAuMToqYCxcbiAgICAgICAgICBcImltZy1zcmMgJ3NlbGYnIGRhdGE6XCIsXG4gICAgICAgICAgXCJmb250LXNyYyAnc2VsZicgZGF0YTpcIixcbiAgICAgICAgXS5qb2luKCc7ICcpXG4gICAgICA6IFwiZGVmYXVsdC1zcmMgJ3NlbGYnOyBzY3JpcHQtc3JjICdzZWxmJzsgc3R5bGUtc3JjICdzZWxmJyAndW5zYWZlLWlubGluZSc7IGltZy1zcmMgJ3NlbGYnIGRhdGE6OyBmb250LXNyYyAnc2VsZicgZGF0YTpcIjtcbiAgICBzZXNzaW9uLmRlZmF1bHRTZXNzaW9uLndlYlJlcXVlc3Qub25IZWFkZXJzUmVjZWl2ZWQoKGRldGFpbHMsIGNhbGxiYWNrKSA9PiB7XG4gICAgICBjYWxsYmFjayh7XG4gICAgICAgIHJlc3BvbnNlSGVhZGVyczoge1xuICAgICAgICAgIC4uLmRldGFpbHMucmVzcG9uc2VIZWFkZXJzLFxuICAgICAgICAgICdDb250ZW50LVNlY3VyaXR5LVBvbGljeSc6IFtjc3BdLFxuICAgICAgICB9LFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICByZWdpc3RlcklwYygpO1xuICAgIGNyZWF0ZVdpbmRvdygpO1xuICAgIHZvaWQgc3RhcnRIb3N0KCk7XG5cbiAgICBhcHAub24oJ2FjdGl2YXRlJywgKCkgPT4ge1xuICAgICAgaWYgKEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmxlbmd0aCA9PT0gMCkgY3JlYXRlV2luZG93KCk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIC8vIFx1OTAwMFx1NTFGQTpcdTRGMThcdTk2QzVcdTUwNUNcdTZCNjJcdTgxRUFcdTVERjEgc3Bhd24gXHU3Njg0IGhvc3Qoc2h1dGRvd24gXHU3QUVGXHU3MEI5IFx1MjE5MiBcdTUxNUNcdTVFOTVcdTUzRUEga2lsbCBcdTgxRUFcdTVERjFcdTc2ODRcdTUzRTVcdTY3QzQpXG4gIGFwcC5vbignYmVmb3JlLXF1aXQnLCAoZSkgPT4ge1xuICAgIGlmIChzdXBlcnZpc29yICE9PSBudWxsICYmIHN1cGVydmlzb3Iuc3RhdGUgIT09ICdzdG9wcGVkJykge1xuICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgc3NlQWJvcnQ/LmFib3J0KCk7XG4gICAgICB2b2lkIHN1cGVydmlzb3Iuc3RvcCgpLmZpbmFsbHkoKCkgPT4gYXBwLnF1aXQoKSk7XG4gICAgfVxuICB9KTtcbiAgYXBwLm9uKCd3aW5kb3ctYWxsLWNsb3NlZCcsICgpID0+IHtcbiAgICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSAhPT0gJ2RhcndpbicpIGFwcC5xdWl0KCk7XG4gIH0pO1xufVxuIiwgIi8qKlxuICogRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yIFx1MjAxNCBobWhhcm5lc3MgaG9zdCBcdThGREJcdTdBMEJcdTc2ODRcdTc1MUZcdTU0N0RcdTU0NjhcdTY3MUZcdTcyQjZcdTYwMDFcdTY3M0EoQURSLTAwMylcdTMwMDJcbiAqXG4gKiBcdTVCODlcdTUxNjhcdTRFMERcdTUzRDhcdTkxQ0Y6XG4gKiAgLSBcdTUzRUFcdTdFRDFcdTVCOUEvXHU2M0EyXHU2RDRCIDEyNy4wLjAuMTtob3N0IFx1NEY3Rlx1NzUyOFx1NjRDRFx1NEY1Q1x1N0NGQlx1N0VERlx1NTIwNlx1OTE0RFx1N0FFRlx1NTNFMyhwb3J0IDApLFx1NUI5RVx1OTY0NVx1N0FFRlx1NTNFM1xuICogICAgXHU3NTMxIGhvc3QgXHU3Njg0IHN0ZG91dCBcdTVGMTVcdTVCRkNcdTg4NENcdTU2REVcdTRGMjAoSG9zdFJlYWR5TGluZSlcdTMwMDJcbiAqICAtIFx1OUFEOFx1NzFCNSB0b2tlbiBcdTUzRUFcdTkwMUFcdThGQzdcdTVCNTBcdThGREJcdTdBMEJcdTczQUZcdTU4ODNcdTUzRDhcdTkxQ0ZcdTRGMjBcdTkwMTIsXHU3RUREXHU0RTBEXHU4RkRCIFVSTC9cdTY1RTVcdTVGRDcvSVBDIFx1NjYwRVx1NjU4N1x1OEQxRlx1OEY3RFx1MzAwMlxuICogIC0gXHU1M0VBXHU1MDVDXHU2QjYyXHU2NzJDIHN1cGVydmlzb3Igc3Bhd24gXHU3Njg0XHU4RkRCXHU3QTBCXHU1M0U1XHU2N0M0O1x1N0VERFx1NEUwRFx1NjMwOVx1OEZEQlx1N0EwQlx1NTQwRCBraWxsXHUzMDAyXG4gKiAgLSBob3N0IGNyYXNoIFx1NTQwRVx1NjcwOVx1OTY1MFx1OTFDRFx1NTQyRjtcdTkxQ0RcdTU0MkZcdTRFMERcdTkxQ0RcdTY1M0VcdTRFRkJcdTRGNTVcdTc1MjhcdTYyMzdcdTUyQThcdTRGNUMoXHU5NzVFXHU1RTQyXHU3QjQ5XHU1MkE4XHU0RjVDXHU3NTMxXHU3NTI4XHU2MjM3XHU3ODZFXHU4QkE0KVx1MzAwMlxuICovXG5pbXBvcnQgeyBzcGF3biwgdHlwZSBDaGlsZFByb2Nlc3MgfSBmcm9tICdub2RlOmNoaWxkX3Byb2Nlc3MnO1xuaW1wb3J0IHsgY3JlYXRlSW50ZXJmYWNlIH0gZnJvbSAnbm9kZTpyZWFkbGluZSc7XG5pbXBvcnQgeyByYW5kb21CeXRlcyB9IGZyb20gJ25vZGU6Y3J5cHRvJztcbmltcG9ydCB7IGRlc2t0b3BFcnJvciwgaXNEZXNrdG9wRXJyb3IsIHR5cGUgRGVza3RvcEVycm9yIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyc7XG5cbmV4cG9ydCB0eXBlIEhvc3RTdGF0ZSA9XG4gIHwgJ3N0b3BwZWQnXG4gIHwgJ3N0YXJ0aW5nJ1xuICB8ICdyZWFkeSdcbiAgfCAnZGlzY29ubmVjdGVkJ1xuICB8ICdyZXN0YXJ0aW5nJ1xuICB8ICdzdG9wcGluZydcbiAgfCAnZmFpbGVkJztcblxuZXhwb3J0IGludGVyZmFjZSBIb3N0U3BlYyB7XG4gIC8qKiBcdTUzRUZcdTYyNjdcdTg4NENcdTY1ODdcdTRFRjYoXHU5MDFBXHU1RTM4IHByb2Nlc3MuZXhlY1BhdGgpXHUzMDAyICovXG4gIGNvbW1hbmQ6IHN0cmluZztcbiAgYXJnczogc3RyaW5nW107XG4gIGN3ZD86IHN0cmluZztcbiAgLyoqIFx1OTg5RFx1NTkxNlx1NzNBRlx1NTg4M1x1NTNEOFx1OTFDRihcdTRGMUFcdTRFMEUgcHJvY2Vzcy5lbnYgXHU1NDA4XHU1RTc2KVx1MzAwMiAqL1xuICBlbnY/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFN1cGVydmlzb3JPcHRpb25zIHtcbiAgLyoqIFx1NjcxRlx1NjcxQiBob3N0IFx1NjgyMVx1OUE4Q1x1NzY4NCBiZWFyZXIgdG9rZW47XHU0RTBEXHU0RjIwXHU1MjE5XHU2QkNGXHU2QjIxIHN0YXJ0IFx1NzUxRlx1NjIxMFx1OUFEOFx1NzFCNVx1OTY4Rlx1NjczQVx1NTAzQ1x1MzAwMiAqL1xuICB0b2tlbj86IHN0cmluZztcbiAgbWF4UmVzdGFydHM/OiBudW1iZXI7XG4gIHN0YXJ0VGltZW91dE1zPzogbnVtYmVyO1xuICBncmFjZWZ1bFNodXRkb3duTXM/OiBudW1iZXI7XG4gIG9uU3RhdGVDaGFuZ2U/KHN0YXRlOiBIb3N0U3RhdGUsIGluZm86IHsgcmVzdGFydENvdW50OiBudW1iZXI7IGxhc3RFcnJvcj86IHN0cmluZyB9KTogdm9pZDtcbiAgLyoqIFx1NkJDRlx1NkIyMSBob3N0IFx1NUMzMVx1N0VFQShcdTU0MkIgY3Jhc2ggXHU4MUVBXHU2MTA4XHU1NDBFXHU3Njg0XHU5MUNEXHU1NDJGKVx1OTBGRFx1NEYxQVx1ODlFNlx1NTNEMSxcdTY0M0FcdTVFMjZcdTdBRUZcdTcwQjkoXHU1NDJCIHRva2VuLFxuICAgKiAgXHU0RUM1XHU0RjlCXHU1NDBDXHU0RkUxXHU0RUZCXHU1N0RGXHU3Njg0XHU1QkJGXHU0RTNCXHU4RkRCXHU3QTBCXHU5MUNEXHU1RUZBXHU2ODY1XHU1QkEyXHU2MjM3XHU3QUVGO1x1NEUwRFx1ODk4MVx1OERFOFx1OEZEQiByZW5kZXJlcilcdTMwMDIgKi9cbiAgb25SZWFkeT8oZW5kcG9pbnQ6IEhvc3RFbmRwb2ludCk6IHZvaWQ7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgSG9zdEVuZHBvaW50IHtcbiAgcG9ydDogbnVtYmVyO1xuICB2ZXJzaW9uOiBzdHJpbmc7XG4gIHRva2VuOiBzdHJpbmc7XG59XG5cbi8qKiBIb3N0UmVhZHlMaW5lIFx1NzY4NFx1N0M3Qlx1NTc4Qlx1NUI4OFx1NTM2Qlx1NEVDRSBjb250cmFjdHMgXHU1RjE1XHU1MTY1LFx1OTA3Rlx1NTE0RFx1NTNDQ1x1NUI5RVx1NzNCMFx1MzAwMiAqL1xuaW1wb3J0IHsgaXNIb3N0UmVhZHlMaW5lIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyc7XG5cbmNvbnN0IERFRkFVTFRfU1RBUlRfVElNRU9VVF9NUyA9IDIwXzAwMDtcbmNvbnN0IERFRkFVTFRfTUFYX1JFU1RBUlRTID0gMztcbmNvbnN0IERFRkFVTFRfR1JBQ0VGVUxfTVMgPSA1XzAwMDtcblxuZXhwb3J0IGNsYXNzIERlc2t0b3BSdW50aW1lU3VwZXJ2aXNvciB7XG4gIHByaXZhdGUgY2hpbGQ6IENoaWxkUHJvY2VzcyB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIF9zdGF0ZTogSG9zdFN0YXRlID0gJ3N0b3BwZWQnO1xuICBwcml2YXRlIHJlc3RhcnRDb3VudCA9IDA7XG4gIHByaXZhdGUgbGFzdEVycm9yID0gJyc7XG4gIHByaXZhdGUgc3RvcHBpbmcgPSBmYWxzZTtcbiAgcHJpdmF0ZSByZWFkb25seSB0b2tlbjogc3RyaW5nO1xuICBwcml2YXRlIHJlYWRvbmx5IG9wdHM6IFJlcXVpcmVkPFBpY2s8U3VwZXJ2aXNvck9wdGlvbnMsICdtYXhSZXN0YXJ0cycgfCAnc3RhcnRUaW1lb3V0TXMnIHwgJ2dyYWNlZnVsU2h1dGRvd25Ncyc+PiAmIFN1cGVydmlzb3JPcHRpb25zO1xuICBwcml2YXRlIGV4aXRXYWl0ZXJzOiBBcnJheTwoKSA9PiB2b2lkPiA9IFtdO1xuXG4gIGNvbnN0cnVjdG9yKFxuICAgIHByaXZhdGUgcmVhZG9ubHkgc3BlYzogSG9zdFNwZWMsXG4gICAgb3B0czogU3VwZXJ2aXNvck9wdGlvbnMgPSB7fSxcbiAgKSB7XG4gICAgdGhpcy50b2tlbiA9IG9wdHMudG9rZW4gPz8gcmFuZG9tQnl0ZXMoMzIpLnRvU3RyaW5nKCdiYXNlNjR1cmwnKTtcbiAgICB0aGlzLm9wdHMgPSB7XG4gICAgICBtYXhSZXN0YXJ0czogb3B0cy5tYXhSZXN0YXJ0cyA/PyBERUZBVUxUX01BWF9SRVNUQVJUUyxcbiAgICAgIHN0YXJ0VGltZW91dE1zOiBvcHRzLnN0YXJ0VGltZW91dE1zID8/IERFRkFVTFRfU1RBUlRfVElNRU9VVF9NUyxcbiAgICAgIGdyYWNlZnVsU2h1dGRvd25Nczogb3B0cy5ncmFjZWZ1bFNodXRkb3duTXMgPz8gREVGQVVMVF9HUkFDRUZVTF9NUyxcbiAgICAgIC4uLm9wdHMsXG4gICAgfTtcbiAgfVxuXG4gIGdldCBzdGF0ZSgpOiBIb3N0U3RhdGUge1xuICAgIHJldHVybiB0aGlzLl9zdGF0ZTtcbiAgfVxuXG4gIGdldCByZXN0YXJ0c1VzZWQoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gdGhpcy5yZXN0YXJ0Q291bnQ7XG4gIH1cblxuICBwcml2YXRlIHNldFN0YXRlKHM6IEhvc3RTdGF0ZSwgZXJyPzogc3RyaW5nKTogdm9pZCB7XG4gICAgdGhpcy5fc3RhdGUgPSBzO1xuICAgIGlmIChlcnIgIT09IHVuZGVmaW5lZCkgdGhpcy5sYXN0RXJyb3IgPSBlcnI7XG4gICAgY29uc3QgaW5mbzogeyByZXN0YXJ0Q291bnQ6IG51bWJlcjsgbGFzdEVycm9yPzogc3RyaW5nIH0gPSB7IHJlc3RhcnRDb3VudDogdGhpcy5yZXN0YXJ0Q291bnQgfTtcbiAgICBpZiAodGhpcy5sYXN0RXJyb3IgIT09ICcnKSBpbmZvLmxhc3RFcnJvciA9IHRoaXMubGFzdEVycm9yO1xuICAgIHRoaXMub3B0cy5vblN0YXRlQ2hhbmdlPy4ocywgaW5mbyk7XG4gIH1cblxuICAvKiogXHU1NDJGXHU1MkE4IGhvc3QgXHU1RTc2XHU3QjQ5XHU1Rjg1IHJlYWR5KFx1NUYxNVx1NUJGQ1x1ODg0QyArIFx1NUUyNiB0b2tlbiBcdTc2ODRcdTUwNjVcdTVFQjdcdTYzQTJcdTZENEIpXHUzMDAyICovXG4gIGFzeW5jIHN0YXJ0KCk6IFByb21pc2U8SG9zdEVuZHBvaW50PiB7XG4gICAgaWYgKHRoaXMuX3N0YXRlID09PSAncmVhZHknIHx8IHRoaXMuX3N0YXRlID09PSAnc3RhcnRpbmcnKSB7XG4gICAgICB0aHJvdyBkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYHN1cGVydmlzb3IgYWxyZWFkeSAke3RoaXMuX3N0YXRlfWApO1xuICAgIH1cbiAgICB0aGlzLnJlc3RhcnRDb3VudCA9IDA7XG4gICAgdGhpcy5zdG9wcGluZyA9IGZhbHNlO1xuICAgIHJldHVybiB0aGlzLmxhdW5jaCgpO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBsYXVuY2goKTogUHJvbWlzZTxIb3N0RW5kcG9pbnQ+IHtcbiAgICB0aGlzLnNldFN0YXRlKCdzdGFydGluZycpO1xuICAgIGNvbnN0IGNoaWxkID0gc3Bhd24odGhpcy5zcGVjLmNvbW1hbmQsIHRoaXMuc3BlYy5hcmdzLCB7XG4gICAgICBjd2Q6IHRoaXMuc3BlYy5jd2QsXG4gICAgICBlbnY6IHtcbiAgICAgICAgLi4ucHJvY2Vzcy5lbnYsXG4gICAgICAgIC4uLnRoaXMuc3BlYy5lbnYsXG4gICAgICAgIEhNSF9ERVNLVE9QX1RPS0VOOiB0aGlzLnRva2VuLFxuICAgICAgfSxcbiAgICAgIHN0ZGlvOiBbJ2lnbm9yZScsICdwaXBlJywgJ3BpcGUnXSxcbiAgICAgIHdpbmRvd3NIaWRlOiB0cnVlLFxuICAgIH0pO1xuICAgIHRoaXMuY2hpbGQgPSBjaGlsZDtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCBlbmRwb2ludCA9IGF3YWl0IHRoaXMuYXdhaXRSZWFkeShjaGlsZCk7XG4gICAgICB0aGlzLmN1cnJlbnRFbmRwb2ludCA9IHsgcG9ydDogZW5kcG9pbnQucG9ydCwgdmVyc2lvbjogZW5kcG9pbnQudmVyc2lvbiB9O1xuICAgICAgdGhpcy5zZXRTdGF0ZSgncmVhZHknKTtcbiAgICAgIHRoaXMub3B0cy5vblJlYWR5Py4oZW5kcG9pbnQpO1xuICAgICAgLy8gcmVhZHkgXHU0RTRCXHU1NDBFXHU4RkRCXHU3QTBCXHU2QjdCXHU0RUExID0gXHU2MTBGXHU1OTE2XHU5MDAwXHU1MUZBIFx1MjE5MiBcdTY3MDlcdTk2NTBcdTkxQ0RcdTU0MkZcbiAgICAgIGNoaWxkLm9uY2UoJ2V4aXQnLCAoKSA9PiB7XG4gICAgICAgIHRoaXMuZXhpdFdhaXRlcnMuZm9yRWFjaCgodykgPT4gdygpKTtcbiAgICAgICAgdGhpcy5leGl0V2FpdGVycyA9IFtdO1xuICAgICAgICB0aGlzLm9uVW5leHBlY3RlZEV4aXQoKTtcbiAgICAgIH0pO1xuICAgICAgcmV0dXJuIGVuZHBvaW50O1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgaWYgKCFjaGlsZC5raWxsZWQpIGNoaWxkLmtpbGwoKTtcbiAgICAgIGlmICh0aGlzLmNoaWxkID09PSBjaGlsZCkgdGhpcy5jaGlsZCA9IG51bGw7XG4gICAgICB0aHJvdyBlcnI7XG4gICAgfVxuICB9XG5cbiAgLyoqIFx1NEVDRSBzdGRvdXQgXHU2MjdFIEhvc3RSZWFkeUxpbmUsXHU3MTM2XHU1NDBFXHU1MDY1XHU1RUI3XHU2M0EyXHU2RDRCXHUzMDAyICovXG4gIHByaXZhdGUgYXdhaXRSZWFkeShjaGlsZDogQ2hpbGRQcm9jZXNzKTogUHJvbWlzZTxIb3N0RW5kcG9pbnQ+IHtcbiAgICByZXR1cm4gbmV3IFByb21pc2U8SG9zdEVuZHBvaW50PigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICByZWplY3QoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBob3N0IGRpZCBub3Qgc2lnbmFsIHJlYWR5IHdpdGhpbiAke3RoaXMub3B0cy5zdGFydFRpbWVvdXRNc31tc2AsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgICAgfSwgdGhpcy5vcHRzLnN0YXJ0VGltZW91dE1zKTtcblxuICAgICAgY29uc3QgZG9uZSA9IChmbjogKCkgPT4gdm9pZCk6IHZvaWQgPT4ge1xuICAgICAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgICAgICBmbigpO1xuICAgICAgfTtcblxuICAgICAgaWYgKCFjaGlsZC5zdGRvdXQpIHtcbiAgICAgICAgZG9uZSgoKSA9PiByZWplY3QoZGVza3RvcEVycm9yKCdSVU5USU1FX0NSQVNIRUQnLCAnaG9zdCBzcGF3bmVkIHdpdGhvdXQgc3Rkb3V0IHBpcGUnKSkpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHJsID0gY3JlYXRlSW50ZXJmYWNlKHsgaW5wdXQ6IGNoaWxkLnN0ZG91dCB9KTtcbiAgICAgIGNvbnN0IG9uTGluZSA9IChsaW5lOiBzdHJpbmcpOiB2b2lkID0+IHtcbiAgICAgICAgbGV0IHBhcnNlZDogdW5rbm93bjtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBwYXJzZWQgPSBKU09OLnBhcnNlKGxpbmUpO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICByZXR1cm47IC8vIGhvc3QgXHU3Njg0XHU2NjZFXHU5MDFBXHU2NUU1XHU1RkQ3XHU4ODRDLFx1NUZGRFx1NzU2NVxuICAgICAgICB9XG4gICAgICAgIGlmIChpc0hvc3RSZWFkeUxpbmUocGFyc2VkKSkge1xuICAgICAgICAgIHJsLmNsb3NlKCk7XG4gICAgICAgICAgdm9pZCB0aGlzLnByb2JlQW5kUmVtZW1iZXIocGFyc2VkLnBvcnQsIHBhcnNlZC52ZXJzaW9uKVxuICAgICAgICAgICAgLnRoZW4oKGVuZHBvaW50KSA9PiBkb25lKCgpID0+IHJlc29sdmUoZW5kcG9pbnQpKSlcbiAgICAgICAgICAgIC5jYXRjaCgoZXJyOiB1bmtub3duKSA9PiBkb25lKCgpID0+IHJlamVjdChlcnIpKSk7XG4gICAgICAgIH1cbiAgICAgIH07XG4gICAgICBybC5vbignbGluZScsIG9uTGluZSk7XG5cbiAgICAgIGNoaWxkLm9uY2UoJ2V4aXQnLCAoY29kZSkgPT4ge1xuICAgICAgICBkb25lKCgpID0+IHJlamVjdChkZXNrdG9wRXJyb3IoJ1JVTlRJTUVfQ1JBU0hFRCcsIGBob3N0IGV4aXRlZCBkdXJpbmcgc3RhcnR1cCAoY29kZSAke2NvZGUgPz8gJ251bGwnfSlgLCB7IHJldHJ5YWJsZTogZmFsc2UsIHJlY292ZXJ5QWN0aW9uOiAnT1BFTl9MT0dTJyB9KSkpO1xuICAgICAgfSk7XG4gICAgfSk7XG4gIH1cblxuICAvKiogXHU1RTI2IHRva2VuIFx1NzY4NFx1NTA2NVx1NUVCN1x1NjNBMlx1NkQ0QjpHRVQgL2FwaS9zdGF0ZVx1MzAwMjQwMSBcdTIxOTIgQVVUSF9GQUlMRUQoXHU0RTBEXHU5MUNEXHU4QkQ1KVx1MzAwMiAqL1xuICBwcml2YXRlIGFzeW5jIHByb2JlKHBvcnQ6IG51bWJlciwgdmVyc2lvbjogc3RyaW5nKTogUHJvbWlzZTxIb3N0RW5kcG9pbnQ+IHtcbiAgICBsZXQgcmVzOiBSZXNwb25zZTtcbiAgICB0cnkge1xuICAgICAgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9hcGkvc3RhdGVgLCB7XG4gICAgICAgIGhlYWRlcnM6IHsgJ3gtaG1oLWtleSc6IHRoaXMudG9rZW4gfSxcbiAgICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDNfMDAwKSxcbiAgICAgIH0pO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgdGhyb3cgZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBoZWFsdGggcHJvYmUgZmFpbGVkOiAke1N0cmluZyhlcnIpLnNsaWNlKDAsIDE2MCl9YCwgeyByZXRyeWFibGU6IHRydWUgfSk7XG4gICAgfVxuICAgIGlmIChyZXMuc3RhdHVzID09PSA0MDEgfHwgcmVzLnN0YXR1cyA9PT0gNDAzKSB7XG4gICAgICB0aHJvdyBkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgYGhvc3QgcmVqZWN0ZWQgdGhlIHNlc3Npb24gdG9rZW4gKEhUVFAgJHtyZXMuc3RhdHVzfSlgLCB7IHJldHJ5YWJsZTogZmFsc2UsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KTtcbiAgICB9XG4gICAgaWYgKCFyZXMub2spIHtcbiAgICAgIHRocm93IGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgaGVhbHRoIHByb2JlIEhUVFAgJHtyZXMuc3RhdHVzfWAsIHsgcmV0cnlhYmxlOiB0cnVlIH0pO1xuICAgIH1cbiAgICByZXR1cm4geyBwb3J0LCB2ZXJzaW9uLCB0b2tlbjogdGhpcy50b2tlbiB9O1xuICB9XG5cbiAgcHJpdmF0ZSBvblVuZXhwZWN0ZWRFeGl0KCk6IHZvaWQge1xuICAgIGlmICh0aGlzLnN0b3BwaW5nIHx8IHRoaXMuX3N0YXRlID09PSAnc3RvcHBlZCcgfHwgdGhpcy5fc3RhdGUgPT09ICdzdG9wcGluZycpIHJldHVybjtcbiAgICB0aGlzLmNoaWxkID0gbnVsbDtcbiAgICBpZiAodGhpcy5yZXN0YXJ0Q291bnQgPCB0aGlzLm9wdHMubWF4UmVzdGFydHMpIHtcbiAgICAgIHRoaXMucmVzdGFydENvdW50ICs9IDE7XG4gICAgICB0aGlzLnNldFN0YXRlKCdyZXN0YXJ0aW5nJyk7XG4gICAgICB2b2lkIHRoaXMubGF1bmNoKCkuY2F0Y2goKCkgPT4ge1xuICAgICAgICAvLyBcdTkxQ0RcdTU0MkZcdTVDMURcdThCRDVcdTU5MzFcdThEMjUoXHU1NDJGXHU1MkE4XHU1MzczXHU1RDI5L1x1OEQ4NVx1NjVGNi9cdTYyRDJcdThCQTQpOlx1N0VFN1x1N0VFRFx1NkQ4OFx1ODAxN1x1OTFDRFx1NTQyRlx1NkIyMVx1NjU3MFx1NzZGNFx1NTIzMFx1NjUzRVx1NUYwM1xuICAgICAgICB0aGlzLnJldHJ5T3JGYWlsKCk7XG4gICAgICB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5zZXRTdGF0ZSgnZmFpbGVkJywgYGhvc3QgZXhpdGVkIHVuZXhwZWN0ZWRseSAke3RoaXMucmVzdGFydENvdW50ICsgMX0gdGltZXM7IGdpdmluZyB1cGApO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgcmV0cnlPckZhaWwoKTogdm9pZCB7XG4gICAgaWYgKHRoaXMuc3RvcHBpbmcgfHwgdGhpcy5fc3RhdGUgPT09ICdzdG9wcGVkJyB8fCB0aGlzLl9zdGF0ZSA9PT0gJ3N0b3BwaW5nJykgcmV0dXJuO1xuICAgIGlmICh0aGlzLnJlc3RhcnRDb3VudCA8IHRoaXMub3B0cy5tYXhSZXN0YXJ0cykge1xuICAgICAgdGhpcy5yZXN0YXJ0Q291bnQgKz0gMTtcbiAgICAgIHRoaXMuc2V0U3RhdGUoJ3Jlc3RhcnRpbmcnKTtcbiAgICAgIHZvaWQgdGhpcy5sYXVuY2goKS5jYXRjaCgoKSA9PiB0aGlzLnJldHJ5T3JGYWlsKCkpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLnNldFN0YXRlKCdmYWlsZWQnLCBgaG9zdCBmYWlsZWQgdG8gc3RheSB1cCBhZnRlciAke3RoaXMucmVzdGFydENvdW50fSByZXN0YXJ0IGF0dGVtcHRzYCk7XG4gICAgfVxuICB9XG5cbiAgLyoqIFx1NEYxOFx1OTZDNVx1NTA1Q1x1NkI2MjpcdTUxNDggSFRUUCBzaHV0ZG93bixcdThEODVcdTY1RjZcdTYyNERcdTVCRjlcdTY3MkNcdThGREJcdTdBMEJcdTUzRTVcdTY3QzQga2lsbFx1MzAwMiAqL1xuICBhc3luYyBzdG9wKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIHRoaXMuc3RvcHBpbmcgPSB0cnVlO1xuICAgIGlmICh0aGlzLl9zdGF0ZSA9PT0gJ3N0b3BwZWQnKSByZXR1cm47XG4gICAgdGhpcy5zZXRTdGF0ZSgnc3RvcHBpbmcnKTtcbiAgICBjb25zdCBjaGlsZCA9IHRoaXMuY2hpbGQ7XG4gICAgdGhpcy5jaGlsZCA9IG51bGw7XG4gICAgdGhpcy5jdXJyZW50RW5kcG9pbnQgPSBudWxsO1xuICAgIGlmICghY2hpbGQpIHtcbiAgICAgIHRoaXMuc2V0U3RhdGUoJ3N0b3BwZWQnKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgZXhpdGVkID0gbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUpID0+IHtcbiAgICAgIGlmIChjaGlsZC5leGl0Q29kZSAhPT0gbnVsbCB8fCBjaGlsZC5zaWduYWxDb2RlICE9PSBudWxsKSByZXNvbHZlKCk7XG4gICAgICBlbHNlIHtcbiAgICAgICAgY29uc3QgdyA9ICgpOiB2b2lkID0+IHJlc29sdmUoKTtcbiAgICAgICAgdGhpcy5leGl0V2FpdGVycy5wdXNoKHcpO1xuICAgICAgICBjaGlsZC5vbmNlKCdleGl0Jywgdyk7XG4gICAgICB9XG4gICAgfSk7XG4gICAgLy8gXHU1REYyXHU3N0U1XHU3QUVGXHU1M0UzXHU2MjREXHU1QzFEXHU4QkQ1IEhUVFAgXHU0RjE4XHU5NkM1XHU1MTczXHU5NUVEO1x1NjcyQVx1NzdFNVx1N0FFRlx1NTNFM1x1NzZGNFx1NjNBNVx1OEQ3MCBraWxsIFx1NTE1Q1x1NUU5NVxuICAgIGlmICh0aGlzLmxhc3RFbmRwb2ludCAhPT0gbnVsbCkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHt0aGlzLmxhc3RFbmRwb2ludH0vYXBpL2Rlc2t0b3Avc2h1dGRvd25gLCB7XG4gICAgICAgICAgbWV0aG9kOiAnUE9TVCcsXG4gICAgICAgICAgaGVhZGVyczogeyAneC1obWgta2V5JzogdGhpcy50b2tlbiB9LFxuICAgICAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCgxXzAwMCksXG4gICAgICAgIH0pO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8vIGhvc3QgXHU1REYyXHU2QjdCXHU2MjE2XHU0RTBEXHU1RTk0XHU3QjU0Olx1OEQ3MCBraWxsIFx1NTE1Q1x1NUU5NVxuICAgICAgfVxuICAgIH1cbiAgICBjb25zdCBncmFjZWZ1bCA9IGF3YWl0IFByb21pc2UucmFjZShbXG4gICAgICBleGl0ZWQudGhlbigoKSA9PiB0cnVlKSxcbiAgICAgIG5ldyBQcm9taXNlPGJvb2xlYW4+KChyZXNvbHZlKSA9PiBzZXRUaW1lb3V0KCgpID0+IHJlc29sdmUoZmFsc2UpLCB0aGlzLm9wdHMuZ3JhY2VmdWxTaHV0ZG93bk1zKSksXG4gICAgXSk7XG4gICAgaWYgKCFncmFjZWZ1bCAmJiBjaGlsZC5leGl0Q29kZSA9PT0gbnVsbCAmJiBjaGlsZC5zaWduYWxDb2RlID09PSBudWxsKSB7XG4gICAgICBjaGlsZC5raWxsKCk7IC8vIFx1NTNFQVx1Njc0MFx1ODFFQVx1NURGMVx1NjMwMVx1NjcwOVx1NzY4NFx1NTNFNVx1NjdDNCxcdTdFRERcdTRFMERcdTYzMDlcdThGREJcdTdBMEJcdTU0MERcbiAgICB9XG4gICAgYXdhaXQgZXhpdGVkLmNhdGNoKCgpID0+IHVuZGVmaW5lZCk7XG4gICAgdGhpcy5zZXRTdGF0ZSgnc3RvcHBlZCcpO1xuICB9XG5cbiAgcHJpdmF0ZSBsYXN0RW5kcG9pbnQ6IG51bWJlciB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIGN1cnJlbnRFbmRwb2ludDogeyBwb3J0OiBudW1iZXI7IHZlcnNpb246IHN0cmluZyB9IHwgbnVsbCA9IG51bGw7XG5cbiAgLyoqIFx1NUY1M1x1NTI0RCBob3N0IFx1N0FFRlx1NzBCOShyZWFkeSBcdTU0MEVcdTY3MDlcdTUwM0M7XHU0RTBEXHU1NDJCIHRva2VuKVx1MzAwMiAqL1xuICBnZXQgZW5kcG9pbnQoKTogeyBwb3J0OiBudW1iZXI7IHZlcnNpb246IHN0cmluZyB9IHwgbnVsbCB7XG4gICAgcmV0dXJuIHRoaXMuY3VycmVudEVuZHBvaW50O1xuICB9XG5cbiAgLyoqIFx1NjNBMlx1NkQ0Qlx1NjIxMFx1NTI5Rlx1NTQwRVx1OEJCMFx1NEY0Rlx1N0FFRlx1NTNFMyxcdTRGOUIgc3RvcCgpIFx1NzY4NFx1NEYxOFx1OTZDNVx1NTE3M1x1OTVFRFx1NEY3Rlx1NzUyOFx1MzAwMiAqL1xuICBwcml2YXRlIGFzeW5jIHByb2JlQW5kUmVtZW1iZXIocG9ydDogbnVtYmVyLCB2ZXJzaW9uOiBzdHJpbmcpOiBQcm9taXNlPEhvc3RFbmRwb2ludD4ge1xuICAgIGNvbnN0IGVwID0gYXdhaXQgdGhpcy5wcm9iZShwb3J0LCB2ZXJzaW9uKTtcbiAgICB0aGlzLmxhc3RFbmRwb2ludCA9IGVwLnBvcnQ7XG4gICAgcmV0dXJuIGVwO1xuICB9XG59XG5cbi8qKiBcdTYyOEFcdTY3MkFcdTc3RTVcdTk1MTlcdThCRUZcdTg5QzRcdTdFQTZcdTRFM0EgRGVza3RvcEVycm9yKFx1NURGMlx1NjYyRlx1NTIxOVx1NTM5Rlx1NjgzN1x1OEZENFx1NTZERSlcdTMwMDIgKi9cbmV4cG9ydCBmdW5jdGlvbiB0b0Rlc2t0b3BFcnJvcihlcnI6IHVua25vd24pOiBEZXNrdG9wRXJyb3Ige1xuICBpZiAoaXNEZXNrdG9wRXJyb3IoZXJyKSkgcmV0dXJuIGVycjtcbiAgY29uc3QgbWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgcmV0dXJuIGRlc2t0b3BFcnJvcignUlVOVElNRV9DUkFTSEVEJywgbWVzc2FnZS5zbGljZSgwLCAzMDApLCB7IHJldHJ5YWJsZTogZmFsc2UgfSk7XG59XG4iLCAiLyoqXG4gKiBAaG1oLWRlc2t0b3AvY29udHJhY3RzIFx1MjAxNCBcdTRFOEJcdTRFRjZcdTRGRTFcdTVDMDEoXHU1RjAwXHU1M0QxXHU4QkExXHU1MjEyXHU2NTg3XHU2ODYzIDA0IFx1MDBBN1x1NEUwOSlcbiAqXG4gKiBcdTRFMDBcdTY3NjEgVUkgXHU0RThCXHU0RUY2XHU3Njg0XHU1NTJGXHU0RTAwXHU1RjYyXHU3MkI2XHUzMDAyXHU1MjREXHU3QUVGIHJlZHVjZXIgXHU1RkM1XHU5ODdCXHU2MzA5IHNlc3Npb25JZC9ydW5JZC9zZXEgXHU1OTA0XHU3NDA2O1xuICogXHU5MUNEXHU1OTBEIGV2ZW50SWQgXHU1RTQyXHU3QjQ5XHU0RTIyXHU1RjAzO3NlcSBcdTdGM0FcdTUzRTNcdTg5RTZcdTUzRDFcdTg4NjVcdTYyQzk7XHU5NzVFXHU1RTQyXHU3QjQ5XHU1MkE4XHU0RjVDXHU0RTBEXHU3NTMxIFNTRSBcdTgxRUFcdTUyQThcdTkxQ0RcdTUzRDFcdTMwMDJcbiAqL1xuXG5pbXBvcnQgdHlwZSB7IEFydGlmYWN0UmVmIH0gZnJvbSAnLi9kdG8udHMnO1xuaW1wb3J0IHR5cGUgeyBEZXNrdG9wRXJyb3IgfSBmcm9tICcuL2Vycm9yLnRzJztcblxuLyoqIFx1NEU4Qlx1NEVGNlx1NzlDRFx1N0M3QihcdTUyMjRcdTUyMkJcdTk1MkUpXHUzMDAyXHU2NUIwXHU1ODlFIGtpbmQgPSBzY2hlbWFWZXJzaW9uIFx1NTM0N1x1N0VBNyxcdTRFMERcdTUxNDFcdThCQjhcdTk3NTlcdTlFRDhcdTYyNjlcdTY3OUFcdTRFM0VcdTMwMDIgKi9cbmV4cG9ydCBjb25zdCBFVkVOVF9LSU5EUyA9IFtcbiAgJ3J1bi5zdGFydGVkJyxcbiAgJ3BsYW4udXBkYXRlZCcsXG4gICd0b29sLnN0YXJ0ZWQnLFxuICAndG9vbC5jb21wbGV0ZWQnLFxuICAnYXBwcm92YWwucmVxdWlyZWQnLFxuICAndmVyaWZpY2F0aW9uLnVwZGF0ZWQnLFxuICAnYXJ0aWZhY3QuY3JlYXRlZCcsXG4gICdydW4uY29tcGxldGVkJyxcbiAgJ3J1bi5mYWlsZWQnLFxuXSBhcyBjb25zdDtcblxuZXhwb3J0IHR5cGUgRXZlbnRLaW5kID0gKHR5cGVvZiBFVkVOVF9LSU5EUylbbnVtYmVyXTtcblxuZXhwb3J0IGNvbnN0IEVWRU5UX1NDSEVNQV9WRVJTSU9OID0gMTtcbmV4cG9ydCB0eXBlIEV2ZW50U2NoZW1hVmVyc2lvbiA9IDE7XG5cbi8qKiBTU0UgXHU2RDQxXHU0RTBBXHU3Njg0XHU2QkNGXHU0RTAwXHU2NzYxXHU0RThCXHU0RUY2XHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIEV2ZW50RW52ZWxvcGU8VCA9IHVua25vd24+IHtcbiAgc2NoZW1hVmVyc2lvbjogRXZlbnRTY2hlbWFWZXJzaW9uO1xuICAvKiogXHU1MTY4XHU1QzQwXHU1NTJGXHU0RTAwO1x1OTFDRFx1OEZERS9cdTg4NjVcdTYyQzlcdTU0MEVcdTkxQ0RcdTU5MERcdTUxRkFcdTczQjBcdTY1RjZcdTYzQTVcdTY1MzZcdTY1QjlcdTVFNDJcdTdCNDlcdTRFMjJcdTVGMDNcdTMwMDIgKi9cbiAgZXZlbnRJZDogc3RyaW5nO1xuICBzZXNzaW9uSWQ6IHN0cmluZztcbiAgcnVuSWQ6IHN0cmluZztcbiAgLyoqIFx1NEYxQVx1OEJERFx1NTE4NVx1NTM1NVx1OEMwM1x1OTAxMlx1NTg5RTtcdTdGM0FcdTUzRTNcdTYxMEZcdTU0NzNcdTc3NDBcdTRFMjJcdTRFOEJcdTRFRjYsXHU5NzAwXHU4OTgxXHU4ODY1XHU2MkM5XHUzMDAyICovXG4gIHNlcTogbnVtYmVyO1xuICAvKiogUkZDMzMzOVx1MzAwMiAqL1xuICBvY2N1cnJlZEF0OiBzdHJpbmc7XG4gIGtpbmQ6IEV2ZW50S2luZDtcbiAgcGF5bG9hZDogVDtcbn1cblxuLyoqIHJ1bi5zdGFydGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIFJ1blN0YXJ0ZWRQYXlsb2FkIHtcbiAgdGFzazogc3RyaW5nO1xuICBtb2RlOiAnYXNrJyB8ICdhdXRvJyB8ICd5b2xvJztcbn1cblxuLyoqIHBsYW4udXBkYXRlZCBcdTc2ODQgcGF5bG9hZChcdThCQTFcdTUyMTJcdTZCNjVcdTlBQTRcdTUyMTdcdTg4NjgsXHU2NzY1XHU4MUVBIHJ1bnRpbWUgXHU3Njg0XHU3RUQzXHU2Nzg0XHU1MzE2XHU4QkExXHU1MjEyLFx1NEUwRFx1NjYyRiBjaGFpbi1vZi10aG91Z2h0KVx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBQbGFuVXBkYXRlZFBheWxvYWQge1xuICBzdGVwczogQXJyYXk8eyB0aXRsZTogc3RyaW5nOyBzdGF0dXM6ICdwZW5kaW5nJyB8ICdhY3RpdmUnIHwgJ2RvbmUnIHwgJ2ZhaWxlZCcgfT47XG59XG5cbi8qKiB0b29sLnN0YXJ0ZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgVG9vbFN0YXJ0ZWRQYXlsb2FkIHtcbiAgbmFtZTogc3RyaW5nO1xuICAvKiogXHU1M0MyXHU2NTcwXHU0RUU1XHU2NTg3XHU2NzJDXHU1NDQ4XHU3M0IwLFx1NkUzMlx1NjdEM1x1N0FFRlx1NkMzOFx1NEUwRCBldmFsO1x1NTkyN1x1NUJGOVx1OEM2MVx1NzUzMSBydW50aW1lIFx1NjIyQVx1NjVBRFx1MzAwMiAqL1xuICBhcmdzUHJldmlldzogc3RyaW5nO1xufVxuXG4vKiogdG9vbC5jb21wbGV0ZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgVG9vbENvbXBsZXRlZFBheWxvYWQge1xuICBuYW1lOiBzdHJpbmc7XG4gIGlzRXJyb3I6IGJvb2xlYW47XG4gIG91dHB1dFByZXZpZXc6IHN0cmluZztcbn1cblxuLyoqIGFwcHJvdmFsLnJlcXVpcmVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyXHU1QkExXHU2Mjc5XHU2NzQzXHU1QTAxXHU1NzI4IHJ1bnRpbWUgXHU1NDBFXHU3QUVGO1VJIFx1NTNFQVx1NjYyRlx1OEY2Q1x1OEZGMFx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHByb3ZhbFJlcXVpcmVkUGF5bG9hZCB7XG4gIGFwcHJvdmFsSWQ6IHN0cmluZztcbiAgdG9vbDogc3RyaW5nO1xuICBhcmdzUHJldmlldzogc3RyaW5nO1xuICAvKiogXHU1RjcxXHU1NENEXHU4MzAzXHU1NkY0L1x1OThDRVx1OTY2OVx1NzY4NFx1NEVCQVx1N0M3Qlx1NTNFRlx1OEJGQlx1OEJGNFx1NjYwRSxcdTc1MzEgcnVudGltZSBcdTc1MUZcdTYyMTBcdTMwMDIgKi9cbiAgcmlzazogc3RyaW5nO1xufVxuXG4vKiogdmVyaWZpY2F0aW9uLnVwZGF0ZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgVmVyaWZpY2F0aW9uVXBkYXRlZFBheWxvYWQge1xuICBzdW1tYXJ5OiBzdHJpbmc7XG4gIHBhc3NlZDogYm9vbGVhbiB8IG51bGw7IC8vIG51bGwgPSBcdTY3MkFcdTc3RTUvXHU4RkRCXHU4ODRDXHU0RTJEKE5FRURTLURBVEEgXHU2NUY2XHU0RTBEXHU1MDQ3XHU1ODZCKVxufVxuXG4vKiogYXJ0aWZhY3QuY3JlYXRlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcnRpZmFjdENyZWF0ZWRQYXlsb2FkIHtcbiAgYXJ0aWZhY3Q6IEFydGlmYWN0UmVmO1xufVxuXG4vKiogcnVuLmNvbXBsZXRlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBSdW5Db21wbGV0ZWRQYXlsb2FkIHtcbiAgdGV4dDogc3RyaW5nO1xuICB0dXJuczogbnVtYmVyO1xuICB0b29sVXNlczogbnVtYmVyO1xuICB1c2FnZT86IHsgcHJvbXB0VG9rZW5zOiBudW1iZXI7IGNvbXBsZXRpb25Ub2tlbnM6IG51bWJlciB9O1xufVxuXG4vKiogcnVuLmZhaWxlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBSdW5GYWlsZWRQYXlsb2FkIHtcbiAgZXJyb3I6IERlc2t0b3BFcnJvcjtcbn1cbiIsICIvKipcbiAqIEBobWgtZGVza3RvcC9jb250cmFjdHMgXHUyMDE0IFx1N0VEM1x1Njc4NFx1NTMxNlx1Njg0Q1x1OTc2Mlx1OTUxOVx1OEJFRihcdTVGMDBcdTUzRDFcdThCQTFcdTUyMTJcdTY1ODdcdTY4NjMgMDQgXHUwMEE3XHU0RTA5KVx1MzAwMlxuICpcbiAqIGhvc3Qtbm90LXJlYWR5IC8gYXV0aC1mYWlsZWQgLyBzdGFsZS12ZXJzaW9uIC8gcnVudGltZS1jcmFzaGVkIC9cbiAqIHBvcnQtYmluZC1mYWlsZWQgLyBzY2hlbWEtbWlzbWF0Y2ggXHU1RkM1XHU5ODdCXHU2NjJGXHU3RUQzXHU2Nzg0XHU1MzE2XHU5NTE5XHU4QkVGXHU3ODAxLFx1NUU3Nlx1NjNEMFx1NEY5Qlx1NEUwQlx1NEUwMFx1NkI2NVx1NTJBOFx1NEY1Q1x1MzAwMlxuICogbWVzc2FnZSBcdTY2MkZcdTdFQUZcdTY1ODdcdTY3MkMsXHU2RTMyXHU2N0QzXHU3QUVGXHU2QzM4XHU0RTBEXHU2MjhBXHU1QjgzXHU1RjUzIEhUTUxcdTMwMDJcbiAqL1xuZXhwb3J0IGNvbnN0IEVSUk9SX0NPREVTID0gW1xuICAnSE9TVF9OT1RfUkVBRFknLFxuICAnQVVUSF9GQUlMRUQnLFxuICAnUlVOVElNRV9DUkFTSEVEJyxcbiAgJ1BPUlRfQklORF9GQUlMRUQnLFxuICAnU1RBTEVfVkVSU0lPTicsXG4gICdTQ0hFTUFfTUlTTUFUQ0gnLFxuXSBhcyBjb25zdDtcblxuZXhwb3J0IHR5cGUgRXJyb3JDb2RlID0gKHR5cGVvZiBFUlJPUl9DT0RFUylbbnVtYmVyXTtcblxuZXhwb3J0IGNvbnN0IFJFQ09WRVJZX0FDVElPTlMgPSBbJ1JFQ09OTkVDVCcsICdSRVNVTUUnLCAnRVhQT1JUJywgJ09QRU5fTE9HUyddIGFzIGNvbnN0O1xuZXhwb3J0IHR5cGUgUmVjb3ZlcnlBY3Rpb24gPSAodHlwZW9mIFJFQ09WRVJZX0FDVElPTlMpW251bWJlcl07XG5cbmV4cG9ydCBpbnRlcmZhY2UgRGVza3RvcEVycm9yIHtcbiAgY29kZTogRXJyb3JDb2RlO1xuICAvKiogXHU3RUFGXHU2NTg3XHU2NzJDLFx1NkMzOFx1NEUwRFx1NEZFMVx1NEVGQlx1NEUzQSBIVE1MXHUzMDAyICovXG4gIG1lc3NhZ2U6IHN0cmluZztcbiAgcmV0cnlhYmxlOiBib29sZWFuO1xuICBzZXNzaW9uSWQ/OiBzdHJpbmc7XG4gIHJ1bklkPzogc3RyaW5nO1xuICByZWNvdmVyeUFjdGlvbj86IFJlY292ZXJ5QWN0aW9uO1xufVxuXG4vKiogXHU2Nzg0XHU5MDIwXHU0RTAwXHU0RTJBIERlc2t0b3BFcnJvcihleGFjdE9wdGlvbmFsUHJvcGVydHlUeXBlcyBcdTUzQ0JcdTU5N0QpXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gZGVza3RvcEVycm9yKFxuICBjb2RlOiBFcnJvckNvZGUsXG4gIG1lc3NhZ2U6IHN0cmluZyxcbiAgb3B0czogeyByZXRyeWFibGU/OiBib29sZWFuOyBzZXNzaW9uSWQ/OiBzdHJpbmc7IHJ1bklkPzogc3RyaW5nOyByZWNvdmVyeUFjdGlvbj86IFJlY292ZXJ5QWN0aW9uIH0gPSB7fSxcbik6IERlc2t0b3BFcnJvciB7XG4gIGNvbnN0IGU6IERlc2t0b3BFcnJvciA9IHsgY29kZSwgbWVzc2FnZSwgcmV0cnlhYmxlOiBvcHRzLnJldHJ5YWJsZSA9PT0gdHJ1ZSB9O1xuICBpZiAob3B0cy5zZXNzaW9uSWQgIT09IHVuZGVmaW5lZCkgZS5zZXNzaW9uSWQgPSBvcHRzLnNlc3Npb25JZDtcbiAgaWYgKG9wdHMucnVuSWQgIT09IHVuZGVmaW5lZCkgZS5ydW5JZCA9IG9wdHMucnVuSWQ7XG4gIGlmIChvcHRzLnJlY292ZXJ5QWN0aW9uICE9PSB1bmRlZmluZWQpIGUucmVjb3ZlcnlBY3Rpb24gPSBvcHRzLnJlY292ZXJ5QWN0aW9uO1xuICByZXR1cm4gZTtcbn1cbiIsICIvKipcbiAqIEBobWgtZGVza3RvcC9jb250cmFjdHMgXHUyMDE0IHJ1bnRpbWUgXHU2ODIxXHU5QThDKGd1YXJkcylcdTMwMDJcbiAqXG4gKiBcdTZCQ0ZcdTRFMkFcdThERThcdTRGRTFcdTRFRkJcdThGQjlcdTc1NENcdTc2ODRcdTY1NzBcdTYzNkUocnVudGltZVx1MjE5MnJlbmRlcmVyXHUzMDAxaG9zdFx1MjE5Mm1haW4pXHU4RkRCXHU1MTY1XHU1MjREXHU1MTQ4XHU4RkM3IGd1YXJkO1xuICogXHU2ODIxXHU5QThDXHU1OTMxXHU4RDI1XHU3Njg0XHU2NTcwXHU2MzZFXHU2MzA5IFNDSEVNQV9NSVNNQVRDSCBcdTdFRDNcdTY3ODRcdTUzMTZcdTk1MTlcdThCRUZcdTU5MDRcdTc0MDYsXHU0RTBEXHU5NzU5XHU5RUQ4XHU2M0E1XHU1M0Q3XHUzMDAyXG4gKiBcdTYyNEJcdTUxOTlcdTVCODhcdTUzNkJcdTgwMENcdTRFMERcdTY2MkZcdTVGMTVcdTdCMkNcdTRFMDlcdTY1Qjkgc2NoZW1hIFx1NUU5MzpcdTU5NTFcdTdFQTZcdTk3NjJcdTVDMEYsXHU5NkY2XHU0RjlEXHU4RDU2XHU2NTg3XHU1MzE2KGhtaGFybmVzcyBcdTU0MENcdTZFOTApXHUzMDAyXG4gKi9cbmltcG9ydCB7XG4gIEVWRU5UX0tJTkRTLFxuICBFVkVOVF9TQ0hFTUFfVkVSU0lPTixcbiAgdHlwZSBFdmVudEVudmVsb3BlLFxuICB0eXBlIEV2ZW50S2luZCxcbn0gZnJvbSAnLi9ldmVudC50cyc7XG5pbXBvcnQgeyBFUlJPUl9DT0RFUywgUkVDT1ZFUllfQUNUSU9OUywgdHlwZSBEZXNrdG9wRXJyb3IgfSBmcm9tICcuL2Vycm9yLnRzJztcbmltcG9ydCB7IFJVTl9TVEFUVVNFUywgdHlwZSBSdW5TdGF0dXMgfSBmcm9tICcuL2R0by50cyc7XG5cbmNvbnN0IGlzUmVjb3JkID0gKHY6IHVua25vd24pOiB2IGlzIFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0+XG4gIHR5cGVvZiB2ID09PSAnb2JqZWN0JyAmJiB2ICE9PSBudWxsICYmICFBcnJheS5pc0FycmF5KHYpO1xuXG5jb25zdCBpc05vbkVtcHR5U3RyaW5nID0gKHY6IHVua25vd24pOiB2IGlzIHN0cmluZyA9PiB0eXBlb2YgdiA9PT0gJ3N0cmluZycgJiYgdi5sZW5ndGggPiAwO1xuXG5jb25zdCBpc1JmYzMzMzkgPSAodjogc3RyaW5nKTogYm9vbGVhbiA9PiB7XG4gIGNvbnN0IHQgPSBEYXRlLnBhcnNlKHYpO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKHQpICYmIC9cXGR7NH0tXFxkezJ9LVxcZHsyfVQvLnRlc3Qodik7XG59O1xuXG5leHBvcnQgZnVuY3Rpb24gaXNFdmVudEVudmVsb3BlKHY6IHVua25vd24pOiB2IGlzIEV2ZW50RW52ZWxvcGUge1xuICBpZiAoIWlzUmVjb3JkKHYpKSByZXR1cm4gZmFsc2U7XG4gIGlmICh2LnNjaGVtYVZlcnNpb24gIT09IEVWRU5UX1NDSEVNQV9WRVJTSU9OKSByZXR1cm4gZmFsc2U7XG4gIGlmICghaXNOb25FbXB0eVN0cmluZyh2LmV2ZW50SWQpKSByZXR1cm4gZmFsc2U7XG4gIGlmICghaXNOb25FbXB0eVN0cmluZyh2LnNlc3Npb25JZCkpIHJldHVybiBmYWxzZTtcbiAgaWYgKCFpc05vbkVtcHR5U3RyaW5nKHYucnVuSWQpKSByZXR1cm4gZmFsc2U7XG4gIGlmICh0eXBlb2Ygdi5zZXEgIT09ICdudW1iZXInIHx8ICFOdW1iZXIuaXNJbnRlZ2VyKHYuc2VxKSB8fCB2LnNlcSA8IDApIHJldHVybiBmYWxzZTtcbiAgaWYgKCFpc05vbkVtcHR5U3RyaW5nKHYub2NjdXJyZWRBdCkgfHwgIWlzUmZjMzMzOSh2Lm9jY3VycmVkQXQpKSByZXR1cm4gZmFsc2U7XG4gIGlmICghRVZFTlRfS0lORFMuaW5jbHVkZXModi5raW5kIGFzIEV2ZW50S2luZCkpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIGlzUmVjb3JkKHYucGF5bG9hZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0Rlc2t0b3BFcnJvcih2OiB1bmtub3duKTogdiBpcyBEZXNrdG9wRXJyb3Ige1xuICBpZiAoIWlzUmVjb3JkKHYpKSByZXR1cm4gZmFsc2U7XG4gIGlmICghRVJST1JfQ09ERVMuaW5jbHVkZXModi5jb2RlIGFzIG5ldmVyKSkgcmV0dXJuIGZhbHNlO1xuICBpZiAodHlwZW9mIHYubWVzc2FnZSAhPT0gJ3N0cmluZycpIHJldHVybiBmYWxzZTtcbiAgaWYgKHR5cGVvZiB2LnJldHJ5YWJsZSAhPT0gJ2Jvb2xlYW4nKSByZXR1cm4gZmFsc2U7XG4gIGlmICh2LnNlc3Npb25JZCAhPT0gdW5kZWZpbmVkICYmICFpc05vbkVtcHR5U3RyaW5nKHYuc2Vzc2lvbklkKSkgcmV0dXJuIGZhbHNlO1xuICBpZiAodi5ydW5JZCAhPT0gdW5kZWZpbmVkICYmICFpc05vbkVtcHR5U3RyaW5nKHYucnVuSWQpKSByZXR1cm4gZmFsc2U7XG4gIGlmICh2LnJlY292ZXJ5QWN0aW9uICE9PSB1bmRlZmluZWQgJiYgIVJFQ09WRVJZX0FDVElPTlMuaW5jbHVkZXModi5yZWNvdmVyeUFjdGlvbiBhcyBuZXZlcikpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpc1J1blN0YXR1cyh2OiB1bmtub3duKTogdiBpcyBSdW5TdGF0dXMge1xuICByZXR1cm4gdHlwZW9mIHYgPT09ICdzdHJpbmcnICYmIFJVTl9TVEFUVVNFUy5pbmNsdWRlcyh2IGFzIFJ1blN0YXR1cyk7XG59XG5cbi8qKiBIb3N0IFx1NUYxNVx1NUJGQ1x1ODg0QyhzdGRvdXQgXHU3QjJDXHU0RTAwXHU4ODRDKVx1MzAwMiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzSG9zdFJlYWR5TGluZSh2OiB1bmtub3duKTogdiBpcyB7IGhtaERlc2t0b3BIb3N0UmVhZHk6IHRydWU7IHBvcnQ6IG51bWJlcjsgdmVyc2lvbjogc3RyaW5nIH0ge1xuICBpZiAoIWlzUmVjb3JkKHYpKSByZXR1cm4gZmFsc2U7XG4gIGlmICh2LmhtaERlc2t0b3BIb3N0UmVhZHkgIT09IHRydWUpIHJldHVybiBmYWxzZTtcbiAgaWYgKHR5cGVvZiB2LnBvcnQgIT09ICdudW1iZXInIHx8ICFOdW1iZXIuaXNJbnRlZ2VyKHYucG9ydCkgfHwgdi5wb3J0IDw9IDAgfHwgdi5wb3J0ID4gNjU1MzUpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIGlzTm9uRW1wdHlTdHJpbmcodi52ZXJzaW9uKTtcbn1cbiIsICIvKipcbiAqIERlc2t0b3BIb3N0Q2xpZW50IFx1MjAxNCBcdTVCRjkgaG1oIGhvc3QgXHU3Njg0IEhUVFArU1NFIFx1NUJBMlx1NjIzN1x1N0FFRlx1MzAwMlxuICpcbiAqIC0gXHU2QkNGXHU0RTJBIEhUVFAgXHU4QkY3XHU2QzQyXHU4MUVBXHU1MkE4XHU1RTI2IFgtSG1oLUtleSh0b2tlbiBcdTRFMERcdThGREIgVVJMKTtcbiAqIC0gXHU3RUQzXHU2Nzg0XHU1MzE2XHU5NTE5XHU4QkVGKHJlcy5ib2R5IFx1OTFDQ1x1NzY4NCBEZXNrdG9wRXJyb3IgXHU1RjYyXHU3MkI2XHU2MjE2IEhUVFAgXHU3MkI2XHU2MDAxKVx1ODlDNFx1N0VBNlx1NjIxMFx1NUYwMlx1NUUzOFx1NjI5Qlx1NTFGQTtcbiAqIC0gU1NFIFx1NzUyOCBmZXRjaCBcdTZENDFcdTYyNEJcdTUxOTlcdTg5RTNcdTY3OTAoaWQvZXZlbnQvZGF0YSBcdTVFMjcpLFx1NjUyRlx1NjMwMSBMYXN0LUV2ZW50LUlEIFx1ODg2NVx1NjJDOVx1OTFDRFx1OEZERVx1MzAwMlxuICovXG5pbXBvcnQgeyBkZXNrdG9wRXJyb3IsIGlzRGVza3RvcEVycm9yLCBpc0V2ZW50RW52ZWxvcGUsIHR5cGUgRGVza3RvcEVycm9yLCB0eXBlIEV2ZW50RW52ZWxvcGUgfSBmcm9tICdAaG1oLWRlc2t0b3AvY29udHJhY3RzJztcblxuZXhwb3J0IGludGVyZmFjZSBTc2VGcmFtZSB7XG4gIGlkPzogc3RyaW5nO1xuICBldmVudDogc3RyaW5nO1xuICBkYXRhOiBzdHJpbmc7XG59XG5cbi8qKiBcdTg5RTNcdTY3OTBcdTRFMDBcdTZCQjUgU1NFIFx1NjU4N1x1NjcyQ1x1NEUzQVx1NUUyNyhcdTRFMERcdTU0MkJcdThERTggY2h1bmsgXHU3Njg0XHU3RjEzXHU1MUIyXHU5MDNCXHU4RjkxLFx1N0VBRlx1NTFGRFx1NjU3MFx1NEZCRlx1NEU4RVx1NkQ0Qlx1OEJENSlcdTMwMDIgKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVNzZUNodW5rKGNodW5rOiBzdHJpbmcpOiBTc2VGcmFtZVtdIHtcbiAgY29uc3QgZnJhbWVzOiBTc2VGcmFtZVtdID0gW107XG4gIGZvciAoY29uc3QgYmxvY2sgb2YgY2h1bmsuc3BsaXQoL1xcblxcbi8pKSB7XG4gICAgaWYgKCFibG9jay50cmltKCkpIGNvbnRpbnVlO1xuICAgIGxldCBpZDogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAgIGxldCBldmVudCA9ICdtZXNzYWdlJztcbiAgICBjb25zdCBkYXRhTGluZXM6IHN0cmluZ1tdID0gW107XG4gICAgbGV0IHNhd0ZpZWxkID0gZmFsc2U7XG4gICAgZm9yIChjb25zdCBsaW5lIG9mIGJsb2NrLnNwbGl0KCdcXG4nKSkge1xuICAgICAgaWYgKGxpbmUuc3RhcnRzV2l0aCgnOicpKSBjb250aW51ZTsgLy8gXHU2Q0U4XHU5MUNBL1x1NUZDM1x1OERGM1xuICAgICAgaWYgKGxpbmUuc3RhcnRzV2l0aCgnaWQ6JykpIHsgaWQgPSBsaW5lLnNsaWNlKDMpLnRyaW0oKTsgc2F3RmllbGQgPSB0cnVlOyB9XG4gICAgICBlbHNlIGlmIChsaW5lLnN0YXJ0c1dpdGgoJ2V2ZW50OicpKSB7IGV2ZW50ID0gbGluZS5zbGljZSg2KS50cmltKCk7IHNhd0ZpZWxkID0gdHJ1ZTsgfVxuICAgICAgZWxzZSBpZiAobGluZS5zdGFydHNXaXRoKCdkYXRhOicpKSB7IGRhdGFMaW5lcy5wdXNoKGxpbmUuc2xpY2UoNSkucmVwbGFjZSgvXiAvLCAnJykpOyBzYXdGaWVsZCA9IHRydWU7IH1cbiAgICB9XG4gICAgaWYgKCFzYXdGaWVsZCkgY29udGludWU7IC8vIFx1N0VBRlx1NkNFOFx1OTFDQS9cdTVGQzNcdThERjNcdTU3NTdcdTRFMERcdTRFQTdcdTc1MUZcdTVFMjdcbiAgICBmcmFtZXMucHVzaCh7IC4uLihpZCAhPT0gdW5kZWZpbmVkID8geyBpZCB9IDoge30pLCBldmVudCwgZGF0YTogZGF0YUxpbmVzLmpvaW4oJ1xcbicpIH0pO1xuICB9XG4gIHJldHVybiBmcmFtZXM7XG59XG5cbi8qKiBcdTRFQ0UgU1NFIFx1NUUyN1x1NjU3MFx1NjM2RVx1NEUyRFx1ODlFM1x1NTFGQVx1NTQwOFx1NkNENSBFdmVudEVudmVsb3BlO1x1NEUwRFx1NTQwOFx1NkNENVx1NzY4NFx1OEZENFx1NTZERSBudWxsKFNDSEVNQV9NSVNNQVRDSCBcdTc1MzFcdThDMDNcdTc1MjhcdTY1QjlcdThCQTFcdTY1NzApXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gZW52ZWxvcGVGcm9tRnJhbWUoZnJhbWU6IFNzZUZyYW1lKTogRXZlbnRFbnZlbG9wZSB8IG51bGwge1xuICBpZiAoZnJhbWUuZXZlbnQgIT09ICdobWgnKSByZXR1cm4gbnVsbDsgLy8gXHU2MjExXHU0RUVDXHU3Njg0XHU0RThCXHU0RUY2XHU0RkUxXHU1QzAxXHU3RURGXHU0RTAwXHU4RDcwIGV2ZW50OiBobWhcbiAgdHJ5IHtcbiAgICBjb25zdCBwYXJzZWQ6IHVua25vd24gPSBKU09OLnBhcnNlKGZyYW1lLmRhdGEpO1xuICAgIHJldHVybiBpc0V2ZW50RW52ZWxvcGUocGFyc2VkKSA/IHBhcnNlZCA6IG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbmV4cG9ydCBjbGFzcyBEZXNrdG9wSHR0cEVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICBjb25zdHJ1Y3RvcihwdWJsaWMgcmVhZG9ubHkgZGV0YWlsOiBEZXNrdG9wRXJyb3IpIHtcbiAgICBzdXBlcihkZXRhaWwubWVzc2FnZSk7XG4gIH1cbn1cblxuZXhwb3J0IGNsYXNzIERlc2t0b3BIb3N0Q2xpZW50IHtcbiAgY29uc3RydWN0b3IoXG4gICAgcHJpdmF0ZSByZWFkb25seSBiYXNlVXJsOiBzdHJpbmcsXG4gICAgcHJpdmF0ZSByZWFkb25seSB0b2tlbjogc3RyaW5nLFxuICApIHt9XG5cbiAgcHJpdmF0ZSBoZWFkZXJzKGV4dHJhOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge30pOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IHtcbiAgICByZXR1cm4geyAneC1obWgta2V5JzogdGhpcy50b2tlbiwgLi4uZXh0cmEgfTtcbiAgfVxuXG4gIGFzeW5jIGdldEpzb248VD4ocGF0aDogc3RyaW5nLCB0aW1lb3V0TXMgPSA1XzAwMCk6IFByb21pc2U8VD4ge1xuICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgIHRyeSB7XG4gICAgICByZXMgPSBhd2FpdCBmZXRjaChgJHt0aGlzLmJhc2VVcmx9JHtwYXRofWAsIHsgaGVhZGVyczogdGhpcy5oZWFkZXJzKCksIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCh0aW1lb3V0TXMpIH0pO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGByZXF1ZXN0IGZhaWxlZDogJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxNjApfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy5wYXJzZVJlc3BvbnNlPFQ+KHJlcyk7XG4gIH1cblxuICBhc3luYyBwb3N0SnNvbjxUPihwYXRoOiBzdHJpbmcsIGJvZHk6IHVua25vd24sIHRpbWVvdXRNcyA9IDEwXzAwMCk6IFByb21pc2U8VD4ge1xuICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgIHRyeSB7XG4gICAgICByZXMgPSBhd2FpdCBmZXRjaChgJHt0aGlzLmJhc2VVcmx9JHtwYXRofWAsIHtcbiAgICAgICAgbWV0aG9kOiAnUE9TVCcsXG4gICAgICAgIGhlYWRlcnM6IHRoaXMuaGVhZGVycyh7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbicgfSksXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpLFxuICAgICAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQodGltZW91dE1zKSxcbiAgICAgIH0pO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGByZXF1ZXN0IGZhaWxlZDogJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxNjApfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy5wYXJzZVJlc3BvbnNlPFQ+KHJlcyk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHBhcnNlUmVzcG9uc2U8VD4ocmVzOiBSZXNwb25zZSk6IFByb21pc2U8VD4ge1xuICAgIGlmIChyZXMuc3RhdHVzID09PSA0MDEgfHwgcmVzLnN0YXR1cyA9PT0gNDAzKSB7XG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgYGhvc3QgcmVqZWN0ZWQgdGhlIHNlc3Npb24gdG9rZW4gKEhUVFAgJHtyZXMuc3RhdHVzfSlgLCB7IHJldHJ5YWJsZTogZmFsc2UsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XG4gICAgfVxuICAgIGNvbnN0IHRleHQgPSBhd2FpdCByZXMudGV4dCgpO1xuICAgIGxldCBwYXJzZWQ6IHVua25vd24gPSBudWxsO1xuICAgIHRyeSB7XG4gICAgICBwYXJzZWQgPSB0ZXh0ID8gSlNPTi5wYXJzZSh0ZXh0KSA6IG51bGw7XG4gICAgfSBjYXRjaCB7XG4gICAgICBwYXJzZWQgPSBudWxsO1xuICAgIH1cbiAgICBpZiAoIXJlcy5vaykge1xuICAgICAgaWYgKGlzRGVza3RvcEVycm9yKHBhcnNlZCkpIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKHBhcnNlZCk7XG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYEhUVFAgJHtyZXMuc3RhdHVzfTogJHt0ZXh0LnNsaWNlKDAsIDE2MCl9YCwgeyByZXRyeWFibGU6IHJlcy5zdGF0dXMgPj0gNTAwIH0pKTtcbiAgICB9XG4gICAgcmV0dXJuIHBhcnNlZCBhcyBUO1xuICB9XG5cbiAgLyoqXG4gICAqIFx1OEJBMlx1OTYwNVx1NTE2OFx1OTBFOCBTU0UgXHU1RTI3KFx1NTQyQlx1OTc1RVx1NEZFMVx1NUMwMVx1NEU4Qlx1NEVGNjpkZWx0YS9saW5lIFx1N0I0OVx1OUFEOFx1OTg5MVx1NkQ0MSlcdTMwMDJcdTRGRTFcdTVDMDFcdTc1MzFcdThDMDNcdTc1MjhcdTY1QjlcbiAgICogXHU3NTI4IGVudmVsb3BlRnJvbUZyYW1lIFx1ODFFQVx1ODg0Q1x1NTIwNlx1NkQ0MTtcdTY1QURcdTdFQkZcdTkxQ0RcdThGREVcdThCRURcdTRFNDlcdTU0MEMgZXZlbnRzKClcdTMwMDJcbiAgICovXG4gIGFzeW5jICpyYXdFdmVudHMobGFzdEV2ZW50SWQ/OiBzdHJpbmcsIHNpZ25hbD86IEFib3J0U2lnbmFsKTogQXN5bmNHZW5lcmF0b3I8U3NlRnJhbWU+IHtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgJHt0aGlzLmJhc2VVcmx9L2FwaS9ldmVudHNgLCB7XG4gICAgICBoZWFkZXJzOiB0aGlzLmhlYWRlcnMoe1xuICAgICAgICBhY2NlcHQ6ICd0ZXh0L2V2ZW50LXN0cmVhbScsXG4gICAgICAgIC4uLihsYXN0RXZlbnRJZCAhPT0gdW5kZWZpbmVkID8geyAnbGFzdC1ldmVudC1pZCc6IGxhc3RFdmVudElkIH0gOiB7fSksXG4gICAgICB9KSxcbiAgICAgIC4uLihzaWduYWwgIT09IHVuZGVmaW5lZCA/IHsgc2lnbmFsIH0gOiB7fSksXG4gICAgfSk7XG4gICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSB8fCByZXMuc3RhdHVzID09PSA0MDMpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignQVVUSF9GQUlMRUQnLCBgaG9zdCByZWplY3RlZCB0aGUgc2Vzc2lvbiB0b2tlbiAoSFRUUCAke3Jlcy5zdGF0dXN9KWAsIHsgcmV0cnlhYmxlOiBmYWxzZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcbiAgICB9XG4gICAgaWYgKCFyZXMub2sgfHwgcmVzLmJvZHkgPT09IG51bGwpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgU1NFIEhUVFAgJHtyZXMuc3RhdHVzfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICBjb25zdCByZWFkZXIgPSByZXMuYm9keS5nZXRSZWFkZXIoKTtcbiAgICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKCk7XG4gICAgbGV0IGJ1ZmZlciA9ICcnO1xuICAgIGZvciAoOzspIHtcbiAgICAgIGNvbnN0IHsgZG9uZSwgdmFsdWUgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICBpZiAoZG9uZSkgcmV0dXJuO1xuICAgICAgYnVmZmVyICs9IGRlY29kZXIuZGVjb2RlKHZhbHVlLCB7IHN0cmVhbTogdHJ1ZSB9KTtcbiAgICAgIGxldCBpZHg6IG51bWJlcjtcbiAgICAgIHdoaWxlICgoaWR4ID0gYnVmZmVyLmluZGV4T2YoJ1xcblxcbicpKSAhPT0gLTEpIHtcbiAgICAgICAgY29uc3QgYmxvY2sgPSBidWZmZXIuc2xpY2UoMCwgaWR4KTtcbiAgICAgICAgYnVmZmVyID0gYnVmZmVyLnNsaWNlKGlkeCArIDIpO1xuICAgICAgICBmb3IgKGNvbnN0IGZyYW1lIG9mIHBhcnNlU3NlQ2h1bmsoYmxvY2spKSB5aWVsZCBmcmFtZTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogXHU4QkEyXHU5NjA1IFNTRSBcdTRFOEJcdTRFRjZcdTZENDEoYXN5bmMgaXRlcmF0b3IpXHUzMDAyXHU2NUFEXHU3RUJGXHU3NTMxXHU4QzAzXHU3NTI4XHU2NUI5XHU5MUNEXHU4RkRFO1x1OTFDRFx1OEZERVx1NjVGNlx1NjI4QVx1NjcwMFx1NTQwRVxuICAgKiBcdTY1MzZcdTUyMzBcdTc2ODQgZXZlbnRJZCBcdTRGMjBcdTUxNjUgbGFzdEV2ZW50SWQsaG9zdCBcdTdBRUZcdTRFQ0VcdTkxQ0RcdTY1M0VcdTczQUZcdTg4NjVcdTUzRDFcdTMwMDJcbiAgICovXG4gIGFzeW5jICpldmVudHMobGFzdEV2ZW50SWQ/OiBzdHJpbmcsIHNpZ25hbD86IEFib3J0U2lnbmFsKTogQXN5bmNHZW5lcmF0b3I8RXZlbnRFbnZlbG9wZT4ge1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGAke3RoaXMuYmFzZVVybH0vYXBpL2V2ZW50c2AsIHtcbiAgICAgIGhlYWRlcnM6IHRoaXMuaGVhZGVycyh7XG4gICAgICAgIGFjY2VwdDogJ3RleHQvZXZlbnQtc3RyZWFtJyxcbiAgICAgICAgLi4uKGxhc3RFdmVudElkICE9PSB1bmRlZmluZWQgPyB7ICdsYXN0LWV2ZW50LWlkJzogbGFzdEV2ZW50SWQgfSA6IHt9KSxcbiAgICAgIH0pLFxuICAgICAgLi4uKHNpZ25hbCAhPT0gdW5kZWZpbmVkID8geyBzaWduYWwgfSA6IHt9KSxcbiAgICB9KTtcbiAgICBpZiAocmVzLnN0YXR1cyA9PT0gNDAxIHx8IHJlcy5zdGF0dXMgPT09IDQwMykge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdBVVRIX0ZBSUxFRCcsIGBob3N0IHJlamVjdGVkIHRoZSBzZXNzaW9uIHRva2VuIChIVFRQICR7cmVzLnN0YXR1c30pYCwgeyByZXRyeWFibGU6IGZhbHNlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICBpZiAoIXJlcy5vayB8fCAhcmVzLmJvZHkpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgU1NFIEhUVFAgJHtyZXMuc3RhdHVzfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICBjb25zdCByZWFkZXIgPSByZXMuYm9keS5nZXRSZWFkZXIoKTtcbiAgICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKCk7XG4gICAgbGV0IGJ1ZmZlciA9ICcnO1xuICAgIGZvciAoOzspIHtcbiAgICAgIGNvbnN0IHsgZG9uZSwgdmFsdWUgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICBpZiAoZG9uZSkgcmV0dXJuO1xuICAgICAgYnVmZmVyICs9IGRlY29kZXIuZGVjb2RlKHZhbHVlLCB7IHN0cmVhbTogdHJ1ZSB9KTtcbiAgICAgIC8vIFx1NEVFNVx1N0E3QVx1ODg0Q1x1NTIwNlx1NUUyNztcdTRGRERcdTc1NTlcdTRFMERcdTVCOENcdTY1NzRcdTc2ODRcdTVDM0VcdTkwRThcbiAgICAgIGxldCBpZHg6IG51bWJlcjtcbiAgICAgIHdoaWxlICgoaWR4ID0gYnVmZmVyLmluZGV4T2YoJ1xcblxcbicpKSAhPT0gLTEpIHtcbiAgICAgICAgY29uc3QgYmxvY2sgPSBidWZmZXIuc2xpY2UoMCwgaWR4KTtcbiAgICAgICAgYnVmZmVyID0gYnVmZmVyLnNsaWNlKGlkeCArIDIpO1xuICAgICAgICBmb3IgKGNvbnN0IGZyYW1lIG9mIHBhcnNlU3NlQ2h1bmsoYmxvY2spKSB7XG4gICAgICAgICAgY29uc3QgZW52ID0gZW52ZWxvcGVGcm9tRnJhbWUoZnJhbWUpO1xuICAgICAgICAgIGlmIChlbnYgIT09IG51bGwpIHlpZWxkIGVudjtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxufVxuIiwgIi8qKlxuICogZmFrZSBob3N0IFx1MjAxNCBobWhhcm5lc3MgcnVudGltZSBcdTc2ODRcdTZENEJcdThCRDVcdTY2RkZcdThFQUIoTWFzdGVyUHJvbXB0IFx1OTYzNlx1NkJCNSBEL0U6XG4gKiBcIlx1NTE0OFx1NEY3Rlx1NzUyOCBmYWtlIGhvc3QgXHU3RjE2XHU1MTk5XHU3MkI2XHU2MDAxXHU2NzNBXHU2RDRCXHU4QkQ1LFx1NTE4RFx1NjNBNVx1NzcxRlx1NUI5RSBBUElcIjtcdTk2MzZcdTZCQjUgRSBcdTc2ODRcdTRGMUFcdThCRERcdTdFQjVcdTUyMDdcdTcyNDdcbiAqIGUyZSBcdTRFNUZcdTUxNDhcdTU3MjggZmFrZSBcdTVDNDJcdTk1RURcdTczQUYpXHUzMDAyXG4gKlxuICogXHU2ODRDXHU5NzYyIGhvc3QgXHU1NDA4XHU1NDBDOlxuICogIC0gXHU1M0VBXHU3RUQxIDEyNy4wLjAuMSxcdTdBRUZcdTUzRTMgT1MgXHU1MjA2XHU5MTRELFx1NUI5RVx1OTY0NVx1N0FFRlx1NTNFM1x1NTE5OSBzdGRvdXQgXHU1RjE1XHU1QkZDXHU4ODRDO1xuICogIC0gXHU2MjQwXHU2NzA5IC9hcGkvKiBcdTg5ODFcdTZDNDIgWC1IbWgtS2V5ID09PSBITUhfREVTS1RPUF9UT0tFTixcdTU0MjZcdTUyMTkgNDAxICsgRGVza3RvcEVycm9yO1xuICogIC0gR0VUIC9hcGkvc3RhdGUgXHU1MDY1XHU1RUI3XHU2M0EyXHU2RDRCO0dFVCAvYXBpL2V2ZW50cyBTU0UoZXZlbnQ6IGhtaCBcdTRGRTFcdTVDMDFcdTZENDEgKyBcdTkxQ0RcdTY1M0VcdTczQUYpO1xuICogIC0gUE9TVCAvYXBpL2Rlc2t0b3Avc2h1dGRvd24gXHU0RjE4XHU5NkM1XHU5MDAwXHU1MUZBXHUzMDAyXG4gKlxuICogXHU5NjM2XHU2QkI1IEUgXHU2QTIxXHU2MkRGXHU5NzYyKFx1NEUwRSBobWhhcm5lc3MgZGVza3RvcCBcdTZBMjFcdTVGMEZcdTU0MENcdTVGNjIpOlxuICogIC0gUE9TVCAvYXBpL3Rhc2sge3RleHQsIHNlc3Npb25JZCwgbW9kZX06XHU2MzkyXHU5NjFGXHU1RTc2XHU2MzA5XHU4MTFBXHU2NzJDXHU1M0QxXG4gKiAgICBydW4uc3RhcnRlZCBcdTIxOTIgdG9vbC5zdGFydGVkL2NvbXBsZXRlZCBcdTIxOTIobW9kZT09PSdhc2snIFx1NjVGNilcbiAqICAgIGFwcHJvdmFsLnJlcXVpcmVkKFx1N0I0OSAvYXBpL2FwcHJvdmUpXHUyMTkyIHJ1bi5jb21wbGV0ZWQ7XG4gKiAgLSBQT1NUIC9hcGkvYXBwcm92ZSB7Z3JhbnRlZCwgc2Vzc2lvbklkfTtcbiAqICAtIFBPU1QgL2FwaS9pbnRlcnJ1cHQge3Nlc3Npb25JZH07XG4gKiAgLSBHRVQgL2FwaS9zZXNzaW9uc1x1MzAwMlxuICpcbiAqIFx1NkQ0Qlx1OEJENVx1OTRBOVx1NUI1MDpGQUtFX0hPU1RfRElFX0FGVEVSX01TIC8gRkFLRV9IT1NUX0RJRV9BVF9CT09UIC9cbiAqIEZBS0VfSE9TVF9FWFBFQ1RfVE9LRU4gLyBGQUtFX0hPU1RfVEFTS19ERUxBWV9NUyAvIEZBS0VfSE9TVF9UQVNLX0ZBSUw9MVxuICogKFx1NEVGQlx1NTJBMVx1NEVFNSBydW4uZmFpbGVkIFx1N0VEM1x1Njc1RixcdTY3ODRcdTkwMjBcdTk1MTlcdThCRUZcdTYwNjJcdTU5MERcdTU3M0FcdTY2NkYpXHUzMDAyXG4gKi9cbmltcG9ydCB7IGNyZWF0ZVNlcnZlciwgdHlwZSBTZXJ2ZXJSZXNwb25zZSB9IGZyb20gJ25vZGU6aHR0cCc7XG5pbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSAnbm9kZTpjcnlwdG8nO1xuaW1wb3J0IHsgcGF0aFRvRmlsZVVSTCB9IGZyb20gJ25vZGU6dXJsJztcbmltcG9ydCB7IHJlYWxwYXRoU3luYyB9IGZyb20gJ25vZGU6ZnMnO1xuaW1wb3J0IHsgRVZFTlRfU0NIRU1BX1ZFUlNJT04sIGRlc2t0b3BFcnJvciwgdHlwZSBFdmVudEVudmVsb3BlLCB0eXBlIEV2ZW50S2luZCB9IGZyb20gJ0BobWgtZGVza3RvcC9jb250cmFjdHMnO1xuXG5leHBvcnQgaW50ZXJmYWNlIEZha2VIb3N0SGFuZGxlIHtcbiAgcG9ydDogbnVtYmVyO1xuICBlbWl0KHNlc3Npb25JZDogc3RyaW5nLCBydW5JZDogc3RyaW5nLCBraW5kOiBFdmVudEtpbmQsIHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogbnVtYmVyO1xuICBjbG9zZSgpOiBQcm9taXNlPHZvaWQ+O1xufVxuXG5pbnRlcmZhY2UgRmFrZVNlc3Npb24ge1xuICBpZDogc3RyaW5nO1xuICBjcmVhdGVkQXQ6IHN0cmluZztcbiAgdXBkYXRlZEF0OiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBQZW5kaW5nQXBwcm92YWwge1xuICBzZXNzaW9uSWQ6IHN0cmluZztcbiAgYXBwcm92YWxJZDogc3RyaW5nO1xuICByZXNvbHZlKGdyYW50ZWQ6IGJvb2xlYW4pOiB2b2lkO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc3RhcnRGYWtlSG9zdChvcHRzOiB7IHRva2VuOiBzdHJpbmc7IHF1aWV0PzogYm9vbGVhbiB9KTogUHJvbWlzZTxGYWtlSG9zdEhhbmRsZT4ge1xuICBjb25zdCB0b2tlbiA9IG9wdHMudG9rZW47XG4gIC8vIFx1NkQ0Qlx1OEJENVx1OTRBOVx1NUI1MDpGQUtFX0hPU1RfRVhQRUNUX1RPS0VOIFx1OEJBOSBob3N0IFx1NjgyMVx1OUE4Q1x1NEUwMFx1NEUyQVx1NEUwRSBITUhfREVTS1RPUF9UT0tFTlxuICAvLyBcdTRFMERcdTU0MENcdTc2ODRcdTUwM0MoXHU2Nzg0XHU5MDIwIEFVVEhfRkFJTEVEIFx1NTczQVx1NjY2RjtzdXBlcnZpc29yIFx1NjAzQlx1NjYyRlx1ODk4Nlx1NzZENiBITUhfREVTS1RPUF9UT0tFTilcbiAgY29uc3QgZXhwZWN0ZWQgPSBwcm9jZXNzLmVudi5GQUtFX0hPU1RfRVhQRUNUX1RPS0VOID8/IHRva2VuO1xuICBjb25zdCB0YXNrRGVsYXkgPSBOdW1iZXIocHJvY2Vzcy5lbnYuRkFLRV9IT1NUX1RBU0tfREVMQVlfTVMgPz8gMzApO1xuICBjb25zdCBmYWlsVGFza3MgPSBwcm9jZXNzLmVudi5GQUtFX0hPU1RfVEFTS19GQUlMID09PSAnMSc7XG5cbiAgY29uc3Qgc3NlQ2xpZW50cyA9IG5ldyBTZXQ8U2VydmVyUmVzcG9uc2U+KCk7XG4gIGNvbnN0IHNlcUJ5UnVuID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgLy8gXHU5MUNEXHU2NTNFXHU3M0FGOlx1NjcwMFx1OEZEMSAyMDAgXHU1RTI3KExhc3QtRXZlbnQtSUQgXHU2NUFEXHU3RUJGXHU4ODY1XHU2MkM5KSxcdTRFMEUgaG1oYXJuZXNzIHdlYiBcdTU0MENcdTZCM0VcdThCRURcdTRFNDlcbiAgY29uc3QgcmluZzogQXJyYXk8eyBpZDogbnVtYmVyOyBldmVudDogc3RyaW5nOyBkYXRhOiB1bmtub3duIH0+ID0gW107XG4gIGxldCByaW5nU2VxID0gMDtcbiAgY29uc3Qgc2Vzc2lvbnMgPSBuZXcgTWFwPHN0cmluZywgRmFrZVNlc3Npb24+KCk7XG4gIGxldCBwZW5kaW5nOiBQZW5kaW5nQXBwcm92YWwgfCBudWxsID0gbnVsbDtcbiAgY29uc3QgcnVuVGltZXJzID0gbmV3IE1hcDxzdHJpbmcsIE5vZGVKUy5UaW1lb3V0PigpO1xuXG4gIGNvbnN0IGVtaXQgPSAoc2Vzc2lvbklkOiBzdHJpbmcsIHJ1bklkOiBzdHJpbmcsIGtpbmQ6IEV2ZW50S2luZCwgcGF5bG9hZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBudW1iZXIgPT4ge1xuICAgIGNvbnN0IGtleSA9IGAke3Nlc3Npb25JZH1cXDAke3J1bklkfWA7XG4gICAgY29uc3Qgc2VxID0gKHNlcUJ5UnVuLmdldChrZXkpID8/IDApICsgMTtcbiAgICBzZXFCeVJ1bi5zZXQoa2V5LCBzZXEpO1xuICAgIGNvbnN0IGVudjogRXZlbnRFbnZlbG9wZSA9IHtcbiAgICAgIHNjaGVtYVZlcnNpb246IEVWRU5UX1NDSEVNQV9WRVJTSU9OLFxuICAgICAgZXZlbnRJZDogcmFuZG9tVVVJRCgpLFxuICAgICAgc2Vzc2lvbklkLFxuICAgICAgcnVuSWQsXG4gICAgICBzZXEsXG4gICAgICBvY2N1cnJlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICBraW5kLFxuICAgICAgcGF5bG9hZCxcbiAgICB9O1xuICAgIGNvbnN0IGlkID0gKytyaW5nU2VxO1xuICAgIHJpbmcucHVzaCh7IGlkLCBldmVudDogJ2htaCcsIGRhdGE6IGVudiB9KTtcbiAgICBpZiAocmluZy5sZW5ndGggPiAyMDApIHJpbmcuc3BsaWNlKDAsIHJpbmcubGVuZ3RoIC0gMjAwKTtcbiAgICBmb3IgKGNvbnN0IGMgb2Ygc3NlQ2xpZW50cykge1xuICAgICAgYy53cml0ZShgaWQ6ICR7aWR9XFxuZXZlbnQ6IGhtaFxcbmRhdGE6ICR7SlNPTi5zdHJpbmdpZnkoZW52KX1cXG5cXG5gKTtcbiAgICB9XG4gICAgcmV0dXJuIHNlcTtcbiAgfTtcblxuICBjb25zdCB0b3VjaCA9IChzZXNzaW9uSWQ6IHN0cmluZyk6IEZha2VTZXNzaW9uID0+IHtcbiAgICBsZXQgcyA9IHNlc3Npb25zLmdldChzZXNzaW9uSWQpO1xuICAgIGlmIChzID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHMgPSB7IGlkOiBzZXNzaW9uSWQsIGNyZWF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLCB1cGRhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSB9O1xuICAgICAgc2Vzc2lvbnMuc2V0KHNlc3Npb25JZCwgcyk7XG4gICAgfVxuICAgIHMudXBkYXRlZEF0ID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuICAgIHJldHVybiBzO1xuICB9O1xuXG4gIC8qKiBcdTZBMjFcdTYyREZcdTRFMDBcdTZCMjFcdTRFRkJcdTUyQTE6XHU2Mjc5XHU1MUM2XHU2QTIxXHU1RjBGXHU2MzAyXHU4RDc3XHU3QjQ5XHU1Rjg1IC9hcGkvYXBwcm92ZVx1MzAwMiAqL1xuICBjb25zdCBydW5UYXNrID0gKHNlc3Npb25JZDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcsIG1vZGU6IHN0cmluZyk6IHN0cmluZyA9PiB7XG4gICAgY29uc3QgcnVuSWQgPSBgcnVuLSR7RGF0ZS5ub3coKS50b1N0cmluZygzNil9LSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMiwgOCl9YDtcbiAgICB0b3VjaChzZXNzaW9uSWQpO1xuICAgIGNvbnN0IHN0ZXBzOiBBcnJheTwoKSA9PiB2b2lkPiA9IFtdO1xuICAgIGNvbnN0IHdhaXQgPSAoZm46ICgpID0+IHZvaWQsIG1zID0gdGFza0RlbGF5KTogdm9pZCA9PiB7XG4gICAgICBjb25zdCB0ID0gc2V0VGltZW91dChmbiwgbXMpO1xuICAgICAgcnVuVGltZXJzLnNldChgJHtzZXNzaW9uSWR9XFwwJHtydW5JZH1gLCB0KTtcbiAgICB9O1xuICAgIGNvbnN0IGNoYWluID0gKGZuczogQXJyYXk8KCkgPT4gdm9pZD4pOiB2b2lkID0+IHtcbiAgICAgIGNvbnN0IFtmaXJzdCwgLi4ucmVzdF0gPSBmbnM7XG4gICAgICBpZiAoZmlyc3QgPT09IHVuZGVmaW5lZCkgcmV0dXJuO1xuICAgICAgd2FpdCgoKSA9PiB7XG4gICAgICAgIGZpcnN0KCk7XG4gICAgICAgIGNoYWluKHJlc3QpO1xuICAgICAgfSk7XG4gICAgfTtcblxuICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ3J1bi5zdGFydGVkJywgeyB0YXNrOiB0ZXh0LCBtb2RlIH0pO1xuICAgIGlmIChmYWlsVGFza3MpIHtcbiAgICAgIHdhaXQoKCkgPT4gZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAncnVuLmZhaWxlZCcsIHtcbiAgICAgICAgZXJyb3I6IHsgY29kZTogJ0FVVEhfRkFJTEVEJywgbWVzc2FnZTogJ3NpbXVsYXRlZCBwcm92aWRlciBhdXRoIGZhaWx1cmUnLCByZXRyeWFibGU6IGZhbHNlIH0sXG4gICAgICB9KSk7XG4gICAgICByZXR1cm4gcnVuSWQ7XG4gICAgfVxuXG4gICAgY29uc3QgZmluaXNoUnVuID0gKGFuc3dlcjogc3RyaW5nLCB0b29sVXNlczogbnVtYmVyKTogdm9pZCA9PiB7XG4gICAgICBydW5UaW1lcnMuZGVsZXRlKGAke3Nlc3Npb25JZH1cXDAke3J1bklkfWApO1xuICAgICAgZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAncnVuLmNvbXBsZXRlZCcsIHsgdGV4dDogYW5zd2VyLCB0dXJuczogMSwgdG9vbFVzZXMgfSk7XG4gICAgfTtcblxuICAgIGNvbnN0IHNjcmlwdGVkOiBBcnJheTwoKSA9PiB2b2lkPiA9IFtcbiAgICAgICgpID0+IGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ3Rvb2wuc3RhcnRlZCcsIHsgbmFtZTogJ3JlYWRfZmlsZScsIGFyZ3NQcmV2aWV3OiAne1wicGF0aFwiOlwiUkVBRE1FLm1kXCJ9JyB9KSxcbiAgICAgICgpID0+IGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ3Rvb2wuY29tcGxldGVkJywgeyBuYW1lOiAncmVhZF9maWxlJywgaXNFcnJvcjogZmFsc2UsIG91dHB1dFByZXZpZXc6ICcjIGRlbW8nIH0pLFxuICAgIF07XG5cbiAgICBpZiAobW9kZSA9PT0gJ2FzaycpIHtcbiAgICAgIHNjcmlwdGVkLnB1c2goKCkgPT4ge1xuICAgICAgICBjb25zdCBhcHByb3ZhbElkID0gYGFwLSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMiwgOCl9YDtcbiAgICAgICAgZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAnYXBwcm92YWwucmVxdWlyZWQnLCB7XG4gICAgICAgICAgYXBwcm92YWxJZCxcbiAgICAgICAgICB0b29sOiAnd3JpdGVfZmlsZScsXG4gICAgICAgICAgYXJnc1ByZXZpZXc6ICd7XCJwYXRoXCI6XCJvdXQudHh0XCIsXCJjb250ZW50XCI6XCJoaVwifScsXG4gICAgICAgICAgcmlzazogJ1x1NTE5OVx1NTE2NVx1NURFNVx1NEY1Q1x1NTMzQVx1NjU4N1x1NEVGNiBvdXQudHh0KFx1NkEyMVx1NjJERiknLFxuICAgICAgICB9KTtcbiAgICAgICAgcGVuZGluZyA9IHtcbiAgICAgICAgICBzZXNzaW9uSWQsXG4gICAgICAgICAgYXBwcm92YWxJZCxcbiAgICAgICAgICByZXNvbHZlOiAoZ3JhbnRlZCkgPT4ge1xuICAgICAgICAgICAgcGVuZGluZyA9IG51bGw7XG4gICAgICAgICAgICBpZiAoZ3JhbnRlZCkge1xuICAgICAgICAgICAgICBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICd0b29sLnN0YXJ0ZWQnLCB7IG5hbWU6ICd3cml0ZV9maWxlJywgYXJnc1ByZXZpZXc6ICd7XCJwYXRoXCI6XCJvdXQudHh0XCJ9JyB9KTtcbiAgICAgICAgICAgICAgd2FpdCgoKSA9PiBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICd0b29sLmNvbXBsZXRlZCcsIHsgbmFtZTogJ3dyaXRlX2ZpbGUnLCBpc0Vycm9yOiBmYWxzZSwgb3V0cHV0UHJldmlldzogJ3dyb3RlIDIgYnl0ZXMnIH0pKTtcbiAgICAgICAgICAgICAgd2FpdCgoKSA9PiBmaW5pc2hSdW4oYGVjaG86ICR7dGV4dH0oXHU1REYyXHU2MjY3XHU4ODRDXHU1MTk5XHU1MTY1KWAsIDMpLCB0YXNrRGVsYXkgKiAyKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIGZpbmlzaFJ1bihgZWNobzogJHt0ZXh0fShcdTVCQTFcdTYyNzlcdTg4QUJcdTYyRDJcdTdFREQsXHU2NzJBXHU2MjY3XHU4ODRDXHU1MTk5XHU1MTY1KWAsIDEpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0sXG4gICAgICAgIH07XG4gICAgICB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgc2NyaXB0ZWQucHVzaCgoKSA9PiBmaW5pc2hSdW4oYGVjaG86ICR7dGV4dH1gLCAxKSk7XG4gICAgfVxuICAgIGNoYWluKHNjcmlwdGVkKTtcbiAgICByZXR1cm4gcnVuSWQ7XG4gIH07XG5cbiAgY29uc3Qgc2VydmVyID0gY3JlYXRlU2VydmVyKChyZXEsIHJlcykgPT4ge1xuICAgIGNvbnN0IHVybCA9IG5ldyBVUkwocmVxLnVybCA/PyAnLycsICdodHRwOi8vMTI3LjAuMC4xJyk7XG4gICAgY29uc3QgYXV0aG9yaXplZCA9IHJlcS5oZWFkZXJzWyd4LWhtaC1rZXknXSA9PT0gZXhwZWN0ZWQ7XG4gICAgY29uc3QgZGVueSA9ICgpOiB2b2lkID0+IHtcbiAgICAgIHJlcy53cml0ZUhlYWQoNDAxLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignQVVUSF9GQUlMRUQnLCAnbWlzc2luZyBvciBpbnZhbGlkIHgtaG1oLWtleScsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgIH07XG5cbiAgICBjb25zdCByZWFkQm9keSA9ICgpOiBQcm9taXNlPHN0cmluZz4gPT5cbiAgICAgIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG4gICAgICAgIGxldCBiID0gJyc7XG4gICAgICAgIHJlcS5vbignZGF0YScsIChjOiBCdWZmZXIpID0+IHsgYiArPSBjLnRvU3RyaW5nKCk7IH0pO1xuICAgICAgICByZXEub24oJ2VuZCcsICgpID0+IHJlc29sdmUoYikpO1xuICAgICAgfSk7XG5cbiAgICBpZiAodXJsLnBhdGhuYW1lID09PSAnL2FwaS9ldmVudHMnKSB7XG4gICAgICBpZiAoIWF1dGhvcml6ZWQpIHsgZGVueSgpOyByZXR1cm47IH1cbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAndGV4dC9ldmVudC1zdHJlYW0nLCAnY2FjaGUtY29udHJvbCc6ICduby1jYWNoZScsIGNvbm5lY3Rpb246ICdrZWVwLWFsaXZlJyB9KTtcbiAgICAgIHJlcy5mbHVzaEhlYWRlcnM/LigpO1xuICAgICAgc3NlQ2xpZW50cy5hZGQocmVzKTtcbiAgICAgIC8vIFx1NjVBRFx1N0VCRlx1ODg2NVx1NjJDOTpMYXN0LUV2ZW50LUlEIFx1NEU0Qlx1NTI0RFx1NzY4NFx1NUUyN1x1NURGMlx1NTcyOFx1NUJBMlx1NjIzN1x1N0FFRixcdTkxQ0RcdTUzRDFcdTUxNzZcdTU0MEVcdTc2ODRcdTczQUZcdTVGNjJcdTdGMTNcdTUxQjJcbiAgICAgIGNvbnN0IGxhc3RJZCA9IE51bWJlcihyZXEuaGVhZGVyc1snbGFzdC1ldmVudC1pZCddID8/IDApO1xuICAgICAgaWYgKE51bWJlci5pc0Zpbml0ZShsYXN0SWQpICYmIGxhc3RJZCA+IDApIHtcbiAgICAgICAgZm9yIChjb25zdCBlIG9mIHJpbmcpIHtcbiAgICAgICAgICBpZiAoZS5pZCA+IGxhc3RJZCkgcmVzLndyaXRlKGBpZDogJHtlLmlkfVxcbmV2ZW50OiAke2UuZXZlbnR9XFxuZGF0YTogJHtKU09OLnN0cmluZ2lmeShlLmRhdGEpfVxcblxcbmApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICByZXEub24oJ2Nsb3NlJywgKCkgPT4gc3NlQ2xpZW50cy5kZWxldGUocmVzKSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICghYXV0aG9yaXplZCkgeyBkZW55KCk7IHJldHVybjsgfVxuXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvc3RhdGUnKSB7XG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIGRhZW1vblZlcnNpb246ICdmYWtlLTAuMC4wJywgZGVza3RvcDogdHJ1ZSwgbW9kZWw6ICdmYWtlLW1vZGVsJywgbG9jYWxlOiAnemgnLFxuICAgICAgICBidXN5U2Vzc2lvbnM6IFsuLi5zZXNzaW9ucy5rZXlzKCldLnNsaWNlKDAsIDIpLFxuICAgICAgICBhcHByb3ZhbFBlbmRpbmc6IHBlbmRpbmcgIT09IG51bGwsXG4gICAgICB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9kZXNrdG9wL3NodXRkb3duJykge1xuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSB9KSk7XG4gICAgICBzZXJ2ZXIuY2xvc2UoKCkgPT4gcHJvY2Vzcy5leGl0KDApKTtcbiAgICAgIHNldFRpbWVvdXQoKCkgPT4gcHJvY2Vzcy5leGl0KDApLCAxXzAwMCkudW5yZWYoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2Zha2UvZGllJykge1xuICAgICAgLy8gXHU2RDRCXHU4QkQ1XHU5NEE5XHU1QjUwOlx1NkEyMVx1NjJERiBob3N0IFx1NUQyOVx1NkU4MyhcdTUxNDhcdTVFOTRcdTdCNTRcdTUxOERcdTkwMDBcdTUxRkEsXHU0RkREXHU4QkMxXHU1NENEXHU1RTk0XHU1REYyXHU1M0QxXHU1MUZBKVxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSB9KSk7XG4gICAgICBzZXRUaW1lb3V0KCgpID0+IHByb2Nlc3MuZXhpdCgxKSwgNTApO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvdGFzaycpIHtcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgoYXdhaXQgcmVhZEJvZHkoKSkgfHwgJ3t9JykgYXMgeyB0ZXh0PzogdW5rbm93bjsgc2Vzc2lvbklkPzogdW5rbm93bjsgbW9kZT86IHVua25vd24gfTtcbiAgICAgICAgICBjb25zdCB0ZXh0ID0gdHlwZW9mIGJvZHkudGV4dCA9PT0gJ3N0cmluZycgPyBib2R5LnRleHQgOiAnJztcbiAgICAgICAgICBjb25zdCBzZXNzaW9uSWQgPSB0eXBlb2YgYm9keS5zZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gYm9keS5zZXNzaW9uSWQgOiBgd2ViLSR7RGF0ZS5ub3coKS50b1N0cmluZygzNil9YDtcbiAgICAgICAgICBjb25zdCBtb2RlID0gYm9keS5tb2RlID09PSAnYXNrJyB8fCBib2R5Lm1vZGUgPT09ICdhdXRvJyB8fCBib2R5Lm1vZGUgPT09ICd5b2xvJyA/IGJvZHkubW9kZSA6ICdhc2snO1xuICAgICAgICAgIGlmICghdGV4dCkge1xuICAgICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAndGV4dCByZXF1aXJlZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgICBjb25zdCBydW5JZCA9IHJ1blRhc2soc2Vzc2lvbklkLCB0ZXh0LCBtb2RlKTtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgcnVuSWQgfSkpO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCBTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgfVxuICAgICAgfSkoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2FwcHJvdmUnKSB7XG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7IGdyYW50ZWQ/OiB1bmtub3duOyBzZXNzaW9uSWQ/OiB1bmtub3duIH07XG4gICAgICAgIGNvbnN0IHNpZCA9IHR5cGVvZiBib2R5LnNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBib2R5LnNlc3Npb25JZCA6ICcnO1xuICAgICAgICBpZiAocGVuZGluZyA9PT0gbnVsbCB8fCAoc2lkICE9PSAnJyAmJiBwZW5kaW5nLnNlc3Npb25JZCAhPT0gc2lkKSkge1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICdubyBhcHByb3ZhbCBwZW5kaW5nJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHAgPSBwZW5kaW5nO1xuICAgICAgICBwZW5kaW5nID0gbnVsbDtcbiAgICAgICAgcC5yZXNvbHZlKGJvZHkuZ3JhbnRlZCA9PT0gdHJ1ZSk7XG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgZ3JhbnRlZDogYm9keS5ncmFudGVkID09PSB0cnVlIH0pKTtcbiAgICAgIH0pKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9pbnRlcnJ1cHQnKSB7XG4gICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgnJykgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47IC8vIGludGVycnVwdCBcdTY1RTAgYm9keSBcdThCRURcdTRFNDlcbiAgICAgIHZvaWQgYm9keTtcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUgfSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9zZXNzaW9ucycpIHtcbiAgICAgIGNvbnN0IGxpc3QgPSBbLi4uc2Vzc2lvbnMudmFsdWVzKCldLm1hcCgocykgPT4gKHtcbiAgICAgICAgaWQ6IHMuaWQsIHRpdGxlOiAnJywgdGFzazogJycsIG91dGNvbWU6ICdvaycsIHR1cm5zOiAxLCB0b29sVXNlczogMSxcbiAgICAgICAgdGltZTogcy51cGRhdGVkQXQsIGN3ZDogJ0M6XFxcXGRlbW8nLCBicmFuY2g6ICcnLCBjcmVhdGVkQXQ6IHMuY3JlYXRlZEF0LCB1cGRhdGVkQXQ6IHMudXBkYXRlZEF0LFxuICAgICAgfSkpO1xuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBzZXNzaW9uczogbGlzdCwgbmV4dEN1cnNvcjogbnVsbCB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUuc3RhcnRzV2l0aCgnL2FwaS9zZXNzaW9ucy8nKSkge1xuICAgICAgLy8gXHU0RjFBXHU4QkREXHU5ODg0XHU4OUM4KFx1NEUwRSBobWhhcm5lc3MgR0VUIC9hcGkvc2Vzc2lvbnMvOmlkIFx1NTQwQ1x1NUY2MjpcdTY3MDBcdTU0MEUgODAgXHU2NzYxLFx1NkJDRlx1Njc2MSA1MDAgXHU1QjU3KVxuICAgICAgY29uc3QgaWQgPSBkZWNvZGVVUklDb21wb25lbnQodXJsLnBhdGhuYW1lLnNsaWNlKCcvYXBpL3Nlc3Npb25zLycubGVuZ3RoKSkucmVwbGFjZSgvW15hLXpBLVowLTlfOi5ALV0vZywgJycpO1xuICAgICAgY29uc3QgcyA9IHNlc3Npb25zLmdldChpZCk7XG4gICAgICBpZiAocyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnc2Vzc2lvbiBub3QgZm91bmQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBpZCwgbW9kZWw6ICdmYWtlLW1vZGVsJywgY3dkOiAnQzpcXFxcZGVtbycsXG4gICAgICAgIG1lc3NhZ2VzOiBbXG4gICAgICAgICAgeyByb2xlOiAndXNlcicsIHRleHQ6ICdcdTRFNEJcdTUyNERcdTc2ODRcdTRFRkJcdTUyQTEoZmFrZSBcdTk4ODRcdTg5QzgpJywgdG9vbHM6IFtdIH0sXG4gICAgICAgICAgeyByb2xlOiAnYXNzaXN0YW50JywgdGV4dDogJ1x1OEZEOVx1NjYyRlx1NTM4Nlx1NTNGMlx1NEYxQVx1OEJERFx1NzY4NFx1NTZERVx1NTkwRFx1OTg4NFx1ODlDOChmYWtlKVx1MzAwMicsIHRvb2xzOiBbJ3JlYWRfZmlsZSddIH0sXG4gICAgICAgIF0sXG4gICAgICB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2ZzJykge1xuICAgICAgLy8gXHU3NkVFXHU1RjU1XHU2RDRGXHU4OUM4KFx1NEUwRSBobWhhcm5lc3MgXHU1NDBDXHU1RjYyOnBhdGggXHU3NzAxXHU3NTY1PVx1NjgzOTtmaWxlcz0xIFx1OTY0NFx1NUUyNlx1NjU4N1x1NEVGNlx1NTIxN1x1ODg2OClcbiAgICAgIGNvbnN0IHEgPSB1cmwuc2VhcmNoUGFyYW1zLmdldCgncGF0aCcpID8/ICcnO1xuICAgICAgY29uc3Qgd2l0aEZpbGVzID0gdXJsLnNlYXJjaFBhcmFtcy5nZXQoJ2ZpbGVzJykgPT09ICcxJztcbiAgICAgIGlmIChxID09PSAnJykge1xuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICBwYXRoOiAnJywgc2VnbWVudHM6IFtdLCBwYXJlbnQ6ICcnLFxuICAgICAgICAgIGRpcnM6IFt7IG5hbWU6ICdkZW1vLXdvcmtzcGFjZScsIHBhdGg6ICdDOlxcXFxkZW1vJyB9XSxcbiAgICAgICAgICAuLi4od2l0aEZpbGVzID8geyBmaWxlczogW10gfSA6IHt9KSxcbiAgICAgICAgfSkpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIHBhdGg6IHEsIHNlZ21lbnRzOiBbeyBuYW1lOiBxLnNwbGl0KC9bXFxcXC9dLykuZmlsdGVyKEJvb2xlYW4pLnBvcCgpID8/IHEsIHBhdGg6IHEgfV0sIHBhcmVudDogJycsXG4gICAgICAgIGRpcnM6IFt7IG5hbWU6ICdzcmMnLCBwYXRoOiBgJHtxLnJlcGxhY2UoL1tcXFxcL10kLywgJycpfVxcXFxzcmNgIH1dLFxuICAgICAgICAuLi4od2l0aEZpbGVzID8geyBmaWxlczogW1xuICAgICAgICAgIHsgbmFtZTogJ1JFQURNRS5tZCcsIHBhdGg6IGAke3EucmVwbGFjZSgvW1xcXFwvXSQvLCAnJyl9XFxcXFJFQURNRS5tZGAsIHJlbDogJ1JFQURNRS5tZCcgfSxcbiAgICAgICAgICB7IG5hbWU6ICdwYWNrYWdlLmpzb24nLCBwYXRoOiBgJHtxLnJlcGxhY2UoL1tcXFxcL10kLywgJycpfVxcXFxwYWNrYWdlLmpzb25gLCByZWw6ICdwYWNrYWdlLmpzb24nIH0sXG4gICAgICAgIF0gfSA6IHt9KSxcbiAgICAgIH0pKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZnMvcmVhZCcpIHtcbiAgICAgIC8vIFx1NjU4N1x1NEVGNlx1OTg4NFx1ODlDOCg2NEtCIFx1NEUwQVx1OTY1MFx1OEJFRFx1NEU0OTtmYWtlIFx1OEZENFx1NTZERVx1NTZGQVx1NUI5QVx1NjU4N1x1NjcyQylcbiAgICAgIGNvbnN0IHAgPSB1cmwuc2VhcmNoUGFyYW1zLmdldCgncGF0aCcpID8/ICcnO1xuICAgICAgaWYgKHAgPT09ICcnKSB7XG4gICAgICAgIHJlcy53cml0ZUhlYWQoNDAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAncGF0aCByZXF1aXJlZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIHBhdGg6IHAsIHJlbDogcC5zcGxpdCgvW1xcXFwvXS8pLnBvcCgpID8/IHAsIHNpemU6IDQyLFxuICAgICAgICB0ZXh0OiAnIyBkZW1vIHdvcmtzcGFjZVxcblxcblx1OEZEOVx1NjYyRiBmYWtlIGhvc3QgXHU3Njg0XHU2NTg3XHU0RUY2XHU5ODg0XHU4OUM4XHU1MTg1XHU1QkI5XHUzMDAyXFxuJyxcbiAgICAgIH0pKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZGlmZicpIHtcbiAgICAgIC8vIERpZmYgXHU5NzYyXHU2NzdGKFx1NEUwRSBobWhhcm5lc3MgL2FwaS9kaWZmIFx1NTQwQ1x1NUY2MjtmYWtlIFx1OEZENFx1NTZERVx1NTZGQVx1NUI5QVx1NUMwRlx1NTNEOFx1NjZGNFx1OTZDNilcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgZ2l0OiB0cnVlLCBjd2Q6ICdDOlxcXFxkZW1vJyxcbiAgICAgICAgY2hhbmdlZDogW1xuICAgICAgICAgIHsgc3RhdGU6ICdNJywgcGF0aDogJ3NyYy9hcHAudHMnIH0sXG4gICAgICAgICAgeyBzdGF0ZTogJ0EnLCBwYXRoOiAnZG9jcy9ub3Rlcy5tZCcgfSxcbiAgICAgICAgXSxcbiAgICAgICAgc3RhdDogJyBzcmMvYXBwLnRzICAgICAgfCAxMiArKysrKysrLS0tXFxuIGRvY3Mvbm90ZXMubWQgICB8ICA0ICsrKytcXG4gMiBmaWxlcyBjaGFuZ2VkLCAxNiBpbnNlcnRpb25zKCspLCAzIGRlbGV0aW9ucygtKScsXG4gICAgICB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2NvZ25pdGl2ZScpIHtcbiAgICAgIC8vIFx1OEJBNFx1NzdFNVx1NzJCNlx1NjAwMShcdTRFMEUgaG1oYXJuZXNzIGNvZ25pdGl2ZVN0YXR1cyBcdTU0MENcdTVGNjJcdTVCNTBcdTk2QzY7XHU3RjNBXHU2NTcwXHU2MzZFXHU2NjNFXHU1RjBGIG51bGwpXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIG1lbW9yeTogeyBsYXllcnM6IDMsIGVudHJpZXM6IDEyLCBjb250cmFkaWN0aW9uczogMCB9LFxuICAgICAgICB0cmFqZWN0b3JpZXM6IDcsXG4gICAgICAgIGF1ZGl0RXZlbnRzOiAyMSxcbiAgICAgICAgd29ybGRNb2RlbDogeyB2ZXJzaW9uOiA0LCBiZWxpZWZzOiA5LCB0cnVzdGVkOiA1LCBicmllcjogMC4zMSB9LFxuICAgICAgICBjYWxpYnJhdGlvbjogeyBwcmVkaWN0aW9uczogNDYsIHJlbGlhYmlsaXR5OiAwLjcyIH0sXG4gICAgICB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9mYWtlL2VtaXQnKSB7XG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoKGF3YWl0IHJlYWRCb2R5KCkpIHx8ICd7fScpIGFzIHtcbiAgICAgICAgICAgIHNlc3Npb25JZDogc3RyaW5nOyBydW5JZDogc3RyaW5nOyBraW5kOiBFdmVudEtpbmQ7IHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgICAgIH07XG4gICAgICAgICAgY29uc3Qgc2VxID0gZW1pdChib2R5LnNlc3Npb25JZCwgYm9keS5ydW5JZCwgYm9keS5raW5kLCBib2R5LnBheWxvYWQpO1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlLCBzZXEgfSkpO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCBTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgfVxuICAgICAgfSkoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgYG5vIHJvdXRlICR7cmVxLm1ldGhvZH0gJHt1cmwucGF0aG5hbWV9YCwgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gIH0pO1xuXG4gIGF3YWl0IG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICBzZXJ2ZXIub25jZSgnZXJyb3InLCByZWplY3QpO1xuICAgIHNlcnZlci5saXN0ZW4oMCwgJzEyNy4wLjAuMScsICgpID0+IHJlc29sdmUoKSk7XG4gIH0pO1xuICBjb25zdCBhZGRyZXNzID0gc2VydmVyLmFkZHJlc3MoKTtcbiAgaWYgKGFkZHJlc3MgPT09IG51bGwgfHwgdHlwZW9mIGFkZHJlc3MgIT09ICdvYmplY3QnKSB0aHJvdyBuZXcgRXJyb3IoJ2Zha2UgaG9zdDogbm8gcG9ydCcpO1xuICBjb25zdCBwb3J0ID0gYWRkcmVzcy5wb3J0O1xuXG4gIGlmICghb3B0cy5xdWlldCkge1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KHsgaG1oRGVza3RvcEhvc3RSZWFkeTogdHJ1ZSwgcG9ydCwgdmVyc2lvbjogJ2Zha2UtMC4wLjAnIH0pfVxcbmApO1xuICB9XG4gIGNvbnN0IGRpZUFmdGVyID0gTnVtYmVyKHByb2Nlc3MuZW52LkZBS0VfSE9TVF9ESUVfQUZURVJfTVMgPz8gMCk7XG4gIGlmIChOdW1iZXIuaXNGaW5pdGUoZGllQWZ0ZXIpICYmIGRpZUFmdGVyID4gMCkge1xuICAgIHNldFRpbWVvdXQoKCkgPT4gcHJvY2Vzcy5leGl0KDEpLCBkaWVBZnRlcikudW5yZWYoKTtcbiAgfVxuXG4gIC8vIGNsb3NlKCk6IFx1NTE0OFx1NjVBRFx1NUYwMFx1NTE2OFx1OTBFOCBTU0UgXHU4RkRFXHU2M0E1KFx1NUI4M1x1NEVFQ1x1NkMzOFx1NEUwRFx1ODFFQVx1NzEzNlx1NTE3M1x1OTVFRCksXHU1NDI2XHU1MjE5IHNlcnZlci5jbG9zZVxuICAvLyBcdTRGMUFcdTRFMDBcdTc2RjRcdTdCNDlcdTZEM0JcdThEQzNcdThGREVcdTYzQTUsXHU2RDRCXHU4QkQ1XHU4RkRCXHU3QTBCXHU2MzAyXHU2QjdCXHUzMDAyXG4gIGNvbnN0IGNsb3NlID0gKCk6IFByb21pc2U8dm9pZD4gPT5cbiAgICBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4ge1xuICAgICAgZm9yIChjb25zdCBjIG9mIHNzZUNsaWVudHMpIHtcbiAgICAgICAgdHJ5IHsgYy5lbmQoKTsgYy5kZXN0cm95KCk7IH0gY2F0Y2ggeyAvKiBhbHJlYWR5IGdvbmUgKi8gfVxuICAgICAgfVxuICAgICAgc3NlQ2xpZW50cy5jbGVhcigpO1xuICAgICAgc2VydmVyLmNsb3NlKCgpID0+IHJlc29sdmUoKSk7XG4gICAgICBzZXRUaW1lb3V0KCgpID0+IHJlc29sdmUoKSwgMV8wMDApLnVucmVmKCk7XG4gICAgfSk7XG5cbiAgcmV0dXJuIHsgcG9ydCwgZW1pdCwgY2xvc2UgfTtcbn1cblxuLy8gXHU3NkY0XHU2M0E1XHU4RkQwXHU4ODRDKHN1cGVydmlzb3Igc3Bhd24gXHU3Njg0XHU1QjUwXHU4RkRCXHU3QTBCXHU1RjYyXHU2MDAxKVx1MzAwMnJlYWxwYXRoIFx1NkJENFx1OEY4MzpucG0gd29ya3NwYWNlXG4vLyBqdW5jdGlvbiAvIFx1NTkyN1x1NUMwRlx1NTE5OVx1NURFRVx1NUYwMlx1OTBGRFx1NEUwRFx1ODBGRFx1OEJBOVx1OEZEOVx1NEUyQVx1NjhDMFx1NkQ0Qlx1NTkzMVx1NjI0QihcdTU5MzFcdTYyNEI9XHU5NzU5XHU5RUQ4XHU5MDAwXHU1MUZBIGNvZGUgMCxcdTk2QkVcdTY3RTUpXHUzMDAyXG5jb25zdCBpbnZva2VkQXNTY3JpcHQgPSAoKCkgPT4ge1xuICBpZiAocHJvY2Vzcy5hcmd2WzFdID09PSB1bmRlZmluZWQpIHJldHVybiBmYWxzZTtcbiAgdHJ5IHtcbiAgICByZXR1cm4gaW1wb3J0Lm1ldGEudXJsID09PSBwYXRoVG9GaWxlVVJMKHJlYWxwYXRoU3luYyhwcm9jZXNzLmFyZ3ZbMV0pKS5ocmVmO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn0pKCk7XG5pZiAoaW52b2tlZEFzU2NyaXB0KSB7XG4gIGNvbnN0IHRva2VuID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVE9LRU4gPz8gJyc7XG4gIC8vIEZBS0VfSE9TVF9ESUVfQVRfQk9PVD0xOlx1NUYxNVx1NUJGQ1x1ODg0Q1x1OEY5M1x1NTFGQVx1NTI0RFx1NTM3M1x1NkI3QihcdTY3ODRcdTkwMjBcdTU0MkZcdTUyQThcdTY3MUYgUlVOVElNRV9DUkFTSEVEKVxuICBpZiAocHJvY2Vzcy5lbnYuRkFLRV9IT1NUX0RJRV9BVF9CT09UID09PSAnMScpIHtcbiAgICBwcm9jZXNzLmV4aXQoMSk7XG4gIH1cbiAgY29uc3Qgc2xvdyA9IE51bWJlcihwcm9jZXNzLmVudi5GQUtFX0hPU1RfU0xPV19BRlRFUiA/PyAwKTtcbiAgY29uc3QgYm9vdCA9ICgpOiB2b2lkID0+IHtcbiAgICB2b2lkIHN0YXJ0RmFrZUhvc3QoeyB0b2tlbiB9KS5jYXRjaCgoZXJyKSA9PiB7XG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgZmFrZS1ob3N0IGZhaWxlZDogJHtTdHJpbmcoZXJyKX1cXG5gKTtcbiAgICAgIHByb2Nlc3MuZXhpdCgxKTtcbiAgICB9KTtcbiAgfTtcbiAgaWYgKE51bWJlci5pc0Zpbml0ZShzbG93KSAmJiBzbG93ID4gMCkgc2V0VGltZW91dChib290LCBzbG93KTtcbiAgZWxzZSBib290KCk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiO0FBY0EsU0FBUyxLQUFLLGVBQWUsU0FBUyxTQUFTLGFBQWE7QUFDNUQsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsaUJBQUFBLHNCQUFxQjs7O0FDTjlCLFNBQVMsYUFBZ0M7QUFDekMsU0FBUyx1QkFBdUI7QUFDaEMsU0FBUyxtQkFBbUI7OztBQ0RyQixJQUFNLGNBQWM7QUFBQSxFQUN6QjtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQ0Y7QUFJTyxJQUFNLHVCQUF1Qjs7O0FDbEI3QixJQUFNLGNBQWM7QUFBQSxFQUN6QjtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQ0Y7QUFJTyxJQUFNLG1CQUFtQixDQUFDLGFBQWEsVUFBVSxVQUFVLFdBQVc7QUFjdEUsU0FBUyxhQUNkLE1BQ0EsU0FDQSxPQUFxRyxDQUFDLEdBQ3hGO0FBQ2QsUUFBTSxJQUFrQixFQUFFLE1BQU0sU0FBUyxXQUFXLEtBQUssY0FBYyxLQUFLO0FBQzVFLE1BQUksS0FBSyxjQUFjLE9BQVcsR0FBRSxZQUFZLEtBQUs7QUFDckQsTUFBSSxLQUFLLFVBQVUsT0FBVyxHQUFFLFFBQVEsS0FBSztBQUM3QyxNQUFJLEtBQUssbUJBQW1CLE9BQVcsR0FBRSxpQkFBaUIsS0FBSztBQUMvRCxTQUFPO0FBQ1Q7OztBQzFCQSxJQUFNLFdB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LEdBQUcsRUFBRSxNQUFNLEdBQUcsR0FBRztBQUMzRyxlQUFTLEVBQUUsR0FBRyxRQUFRLFdBQVcsVUFBVSxXQUFXLE9BQU87QUFDN0QsY0FBUSxRQUFRLGlCQUFpQixNQUFNLEVBQUU7QUFBQSxJQUMzQztBQUFBLEVBQ0Y7QUFHQSxRQUFNLGlCQUFpQixJQUFJO0FBQUEsSUFDekIsU0FBUyxpQkFDTCxDQUFDLGNBQWMsSUFDZixDQUFDSyxlQUFjLEtBQUssTUFBTSxNQUFNLE1BQU0saUJBQWlCLFlBQVksQ0FBQyxFQUFFLElBQUk7QUFBQSxFQUNoRjtBQXdJQSxNQUFJLFVBQVUsRUFBRSxLQUFLLE1BQU07QUFFekIsVUFBTSxNQUFNLFFBQ1I7QUFBQSxNQUNFO0FBQUEsTUFDQSxxQkFBcUIsY0FBYztBQUFBLE1BQ25DO0FBQUEsTUFDQSxzQkFBc0IsY0FBYztBQUFBLE1BQ3BDO0FBQUEsTUFDQTtBQUFBLElBQ0YsRUFBRSxLQUFLLElBQUksSUFDWDtBQUNKLFlBQVEsZUFBZSxXQUFXLGtCQUFrQixDQUFDLFNBQVMsYUFBYTtBQUN6RSxlQUFTO0FBQUEsUUFDUCxpQkFBaUI7QUFBQSxVQUNmLEdBQUcsUUFBUTtBQUFBLFVBQ1gsMkJBQTJCLENBQUMsR0FBRztBQUFBLFFBQ2pDO0FBQUEsTUFDRixDQUFDO0FBQUEsSUFDSCxDQUFDO0FBRUQsSUFBQUYsYUFBWTtBQUNaLElBQUFDLGNBQWE7QUFDYixTQUFLLFVBQVU7QUFFZixRQUFJLEdBQUcsWUFBWSxNQUFNO0FBQ3ZCLFVBQUksY0FBYyxjQUFjLEVBQUUsV0FBVyxFQUFHLENBQUFBLGNBQWE7QUFBQSxJQUMvRCxDQUFDO0FBQUEsRUFDSCxDQUFDO0FBR0QsTUFBSSxHQUFHLGVBQWUsQ0FBQyxNQUFNO0FBQzNCLFFBQUksZUFBZSxRQUFRLFdBQVcsVUFBVSxXQUFXO0FBQ3pELFFBQUUsZUFBZTtBQUNqQixnQkFBVSxNQUFNO0FBQ2hCLFdBQUssV0FBVyxLQUFLLEVBQUUsUUFBUSxNQUFNLElBQUksS0FBSyxDQUFDO0FBQUEsSUFDakQ7QUFBQSxFQUNGLENBQUM7QUFDRCxNQUFJLEdBQUcscUJBQXFCLE1BQU07QUFDaEMsUUFBSSxRQUFRLGFBQWEsU0FBVSxLQUFJLEtBQUs7QUFBQSxFQUM5QyxDQUFDO0FBQ0g7QUE3Ulc7QUFlQTtBQStGQTtBQVlBO0FBV0E7QUFxRUE7IiwKICAibmFtZXMiOiBbInBhdGhUb0ZpbGVVUkwiLCAicHVzaEV2ZW50IiwgImJyb2FkY2FzdEhvc3RTdGF0ZSIsICJzZW5kZXJUcnVzdGVkIiwgImhvc3RDYWxsIiwgInJlZ2lzdGVySXBjIiwgImNyZWF0ZVdpbmRvdyIsICJwYXRoVG9GaWxlVVJMIl0KfQo=
