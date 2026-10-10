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
      emit(sessionId, runId, "artifact.created", {
        artifact: { relPath: "out.txt", kind: "file", title: "out.txt" }
      });
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
var selfUrl = typeof __filename === "string" ? pathToFileURL(realpathSync(__filename)).href : import.meta.url;
var invokedAsScript = (() => {
  if (process.argv[1] === void 0) return false;
  try {
    return selfUrl === pathToFileURL(realpathSync(process.argv[1])).href;
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
    const packaged = app.isPackaged;
    let spec;
    if (useReal) {
      const entry = process.env.HMH_DESKTOP_REAL_ENTRY ?? (packaged ? "" : join(repoRoot, "..", "hmharness", "packages", "web", "src", "desktop-host.ts"));
      if (entry === "") {
        bridge = { ...bridge, hostState: "failed", lastError: "\u771F\u5B9E runtime \u672A\u914D\u7F6E:\u6253\u5305\u4EA7\u54C1\u9700\u8BBE\u7F6E HMH_DESKTOP_REAL_ENTRY \u6307\u5411 hmharness desktop-host \u5165\u53E3" };
        logInfo("host", "real mode without HMH_DESKTOP_REAL_ENTRY in packaged app");
        return;
      }
      spec = {
        command: process.execPath,
        args: ["--import", "tsx", entry],
        env: { ELECTRON_RUN_AS_NODE: "1" }
      };
    } else if (packaged) {
      spec = {
        command: process.execPath,
        args: [join(process.resourcesPath, "fake-host.cjs")],
        env: { ELECTRON_RUN_AS_NODE: "1" }
      };
    } else {
      spec = {
        command: process.execPath,
        // 直接走包真实路径(node_modules 里的 workspace junction 会被 ESM
        // realpath 化,导致 fake-host 的 argv[1]/import.meta.url 匹配失效)
        args: ["--import", "tsx", join(repoRoot, "packages", "host-adapter", "src", "fake-host.ts")],
        env: { ELECTRON_RUN_AS_NODE: "1" }
      };
    }
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
    if (process.env.HMH_DESKTOP_SECURITY_TEST === "1") {
      const win0 = BrowserWindow.getAllWindows()[0];
      if (win0 !== void 0) {
        win0.webContents.once("did-finish-load", () => {
          void securitySelfTest(win0);
        });
      }
    }
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow2();
    });
  });
  async function securitySelfTest(win) {
    const results = [];
    const check = async (name, probe) => {
      try {
        const [ok, detail] = await probe();
        results.push([name, ok, detail]);
      } catch (err) {
        results.push([name, false, String(err).slice(0, 120)]);
      }
    };
    const js = (code) => win.webContents.executeJavaScript(code, true);
    await check("renderer \u65E0\u53EF\u7528\u7684 process/require(sandbox \u751F\u6548)", async () => {
      const r = await js(`(function(){
        var t = function(f){ try { var v = f(); return (v === undefined || v === null) ? 'unavailable' : typeof v; } catch(e){ return 'blocked'; } };
        return JSON.stringify([t(function(){return process}), t(function(){return require}), t(function(){return globalThis.process})]);
      })()`);
      const parsed = JSON.parse(r);
      const p = parsed[0] ?? "unknown";
      const req = parsed[1] ?? "unknown";
      const safe = (v) => v === "unavailable" || v === "blocked";
      return [safe(p) && safe(req), `process=${p} require=${req}`];
    });
    await check("window.hmh \u53EA\u6709\u767D\u540D\u5355\u65B9\u6CD5(\u65E0 ipcRenderer/\u989D\u5916\u9762)", async () => {
      const r = await js('Object.keys(window.hmh || {}).sort().join(",")');
      const allow = ["approve", "cognitive", "diff", "fsList", "fsRead", "getState", "interrupt", "onEventBatches", "onHostState", "onStreamChunks", "sendTask", "sessionPreview", "sessions", "stopHost"];
      const got = r === "" ? [] : r.split(",");
      const unexpected = got.filter((k) => !allow.includes(k));
      return [unexpected.length === 0, `keys=${r}`];
    });
    await check("\u5916\u90E8\u5BFC\u822A\u88AB\u62E6\u622A(URL \u4E0D\u53D8)", async () => {
      const before = win.webContents.getURL();
      await js('location.href = "https://example.invalid/x"; "noop"').catch(() => "noop");
      await new Promise((r2) => setTimeout(r2, 1200));
      const after = win.webContents.getURL();
      return [after === before, `${before} \u2192 ${after}`];
    });
    await check("window.open \u88AB\u62D2\u7EDD(\u8FD4\u56DE null \u4E14\u65E0\u65B0\u7A97\u53E3)", async () => {
      const before = BrowserWindow.getAllWindows().length;
      const r = await js('String(window.open("https://example.invalid"))');
      await new Promise((r2) => setTimeout(r2, 400));
      const after = BrowserWindow.getAllWindows().length;
      return [r === "null" && after === before, `open()=${r} windows=${before}\u2192${after}`];
    });
    await check("CSP \u5B58\u5728(meta \u6CE8\u5165\u6216\u54CD\u5E94\u5934)", async () => {
      const meta = await js(`Boolean(document.querySelector("meta[http-equiv='Content-Security-Policy']"))`);
      const headerCsp = isDev ? "dev: header CSP \u7531 onHeadersReceived \u6CE8\u5165(\u4E0D\u9002\u7528 meta \u65AD\u8A00)" : "prod";
      return [meta || isDev, `meta=${meta} ${headerCsp}`];
    });
    await check("bridge:get-state \u6B63\u5E38\u8FD4\u56DE(host \u6865\u53EF\u7528)", async () => {
      const r = await js('window.hmh.getState().then(s => JSON.stringify(s)).catch(e => "ERR:"+e)');
      return [r.startsWith("{") && r.includes("hostState"), r.slice(0, 80)];
    });
    let failed = 0;
    for (const [name, ok, detail] of results) {
      console.log(`SECURITY-TEST ${ok ? "PASS" : "FAIL"} | ${name} | ${redact(detail)}`);
      if (!ok) failed += 1;
    }
    console.log(`SECURITY-TEST SUMMARY pass=${results.length - failed}/${results.length}`);
    app.exit(failed === 0 ? 0 : 1);
  }
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vZWxlY3Ryb24vbWFpbi9pbmRleC50cyIsICIuLi8uLi8uLi8uLi9wYWNrYWdlcy9ob3N0LWFkYXB0ZXIvc3JjL3N1cGVydmlzb3IudHMiLCAiLi4vLi4vLi4vLi4vcGFja2FnZXMvY29udHJhY3RzL3NyYy9ldmVudC50cyIsICIuLi8uLi8uLi8uLi9wYWNrYWdlcy9jb250cmFjdHMvc3JjL2Vycm9yLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2NvbnRyYWN0cy9zcmMvZ3VhcmRzLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2hvc3QtYWRhcHRlci9zcmMvY2xpZW50LnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2hvc3QtYWRhcHRlci9zcmMvZmFrZS1ob3N0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIEhNSCBEZXNrdG9wIFx1MjAxNCBFbGVjdHJvbiBcdTRFM0JcdThGREJcdTdBMEIoQURSLTAwMS8wMDMvMDA0KVx1MzAwMlxuICpcbiAqIFx1NUI4OVx1NTE2OFx1NEUwRFx1NTNEOFx1OTFDRihcdTVGMDBcdTUzRDFcdThCQTFcdTUyMTIgTTAgXHU1MUZBXHU1M0UzXHU5NUU4ICsgRWxlY3Ryb24gXHU1Qjk4XHU2NUI5XHU1Qjg5XHU1MTY4XHU2RTA1XHU1MzU1KTpcbiAqICAtIHJlbmRlcmVyOmNvbnRleHRJc29sYXRpb24gKyBzYW5kYm94ICsgXHU3OTgxIG5vZGVJbnRlZ3JhdGlvbixcdTRFMjVcdTY4M0MgQ1NQO1xuICogIC0gXHU1QkZDXHU4MjJBL1x1NjVCMFx1N0E5N1x1NTNFM1x1NEUwMFx1NUY4Qlx1NjJEMlx1N0VERChcdTUzRUFcdTUyQTBcdThGN0RcdTYyMTFcdTRFRUNcdTgxRUFcdTVERjFcdTc2ODQgcmVuZGVyZXIpO1xuICogIC0gXHU2QkNGXHU2NzYxIElQQyBcdTY4MjFcdTlBOEMgc2VuZGVyIFx1NzY4NFx1OTg3Nlx1NUM0MiBmcmFtZSBVUkwgXHU1QzVFXHU0RThFXHU2NzJDXHU1RTk0XHU3NTI4LFx1OTAxQVx1OTA1M1x1NzY3RFx1NTQwRFx1NTM1NTtcbiAqICAtIGhvc3QgdG9rZW4gXHU1M0VBXHU1QjU4XHU1NzI4XHU0RThFXHU2NzJDXHU4RkRCXHU3QTBCXHU0RTBFXHU1QjUwXHU4RkRCXHU3QTBCIGVudixcdTY1RTVcdTVGRDdcdThGOTNcdTUxRkFcdTUyNERcdTUxNDhcdTgxMzFcdTY1NEY7XG4gKiAgLSBcdTUzNTVcdTVCOUVcdTRGOEJcdTk1MDE7XHU5MDAwXHU1MUZBXHU2NUY2XHU1M0VBXHU1MDVDXHU2QjYyXHU4MUVBXHU1REYxIHNwYXduIFx1NzY4NCBob3N0KFx1NEYxOFx1OTZDNVx1MjE5Mlx1NTE1Q1x1NUU5NSBraWxsKVx1MzAwMlxuICpcbiAqIFx1OTYzNlx1NkJCNUUoMjAyNi0xMC0xMCk6bWFpbiBcdTYzMDFcdTY3MDkgRGVza3RvcEhvc3RDbGllbnQsU1NFIFx1NEZFMVx1NUMwMVx1NkQ0MShldmVudDogaG1oKVxuICogXHU3RUNGIDUwbXMgXHU2Mjc5XHU5MUNGXHU2M0E4XHU3RUQ5IHJlbmRlcmVyO3NlbmRUYXNrL2FwcHJvdmUvaW50ZXJydXB0L3Nlc3Npb25zIFx1NTE2OFx1OTBFOFx1OEY2Q1x1NTNEMVxuICogXHU3RUQ5IGhvc3QgXHUyMDE0XHUyMDE0IGZha2UgXHU0RTBFXHU3NzFGXHU1QjlFIGhtaGFybmVzcyBkZXNrdG9wLWhvc3QgXHU4RDcwXHU1NDBDXHU0RTAwXHU2NzYxXHU0RUUzXHU3ODAxXHU4REVGXHU1Rjg0XHUzMDAyXG4gKi9cbmltcG9ydCB7IGFwcCwgQnJvd3NlcldpbmRvdywgaXBjTWFpbiwgc2Vzc2lvbiwgc2hlbGwgfSBmcm9tICdlbGVjdHJvbic7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSAnbm9kZTpwYXRoJztcbmltcG9ydCB7IHBhdGhUb0ZpbGVVUkwgfSBmcm9tICdub2RlOnVybCc7XG5pbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSAnbm9kZTpjcnlwdG8nO1xuaW1wb3J0IHsgRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yLCBEZXNrdG9wSG9zdENsaWVudCwgZW52ZWxvcGVGcm9tRnJhbWUsIHR5cGUgSG9zdFN0YXRlIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2hvc3QtYWRhcHRlcic7XG5pbXBvcnQgeyBpc0V2ZW50RW52ZWxvcGUsIHR5cGUgRXZlbnRFbnZlbG9wZSB9IGZyb20gJ0BobWgtZGVza3RvcC9jb250cmFjdHMnO1xuXG5jb25zdCBoZXJlID0gaW1wb3J0Lm1ldGEuZGlybmFtZSA/PyAnLic7XG5jb25zdCBpc0RldiA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX0RFViA9PT0gJzEnO1xuY29uc3QgcmVuZGVyZXJEZXZVcmwgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9SRU5ERVJFUl9VUkwgPz8gJyc7XG5jb25zdCBwcmVsb2FkUGF0aCA9IGpvaW4oaGVyZSwgJy4uL3ByZWxvYWQvaW5kZXguY2pzJyk7XG5cbi8qIC0tLS0gXHU2NUU1XHU1RkQ3XHU4MTMxXHU2NTRGOnRva2VuL2F1dGhvcml6YXRpb24gXHU2QzM4XHU0RTBEXHU4RkRCXHU2M0E3XHU1MjM2XHU1M0YwIC0tLS0gKi9cbmNvbnN0IHNlY3JldHM6IHN0cmluZ1tdID0gW107XG5mdW5jdGlvbiByZWRhY3Qoczogc3RyaW5nKTogc3RyaW5nIHtcbiAgbGV0IG91dCA9IHM7XG4gIGZvciAoY29uc3Qgc2VjIG9mIHNlY3JldHMpIHtcbiAgICBpZiAoc2VjLmxlbmd0aCA+PSA4KSBvdXQgPSBvdXQuc3BsaXQoc2VjKS5qb2luKCdbcmVkYWN0ZWRdJyk7XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cbmZ1bmN0aW9uIGxvZ0luZm8odGFnOiBzdHJpbmcsIG1zZzogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnNvbGUubG9nKGBbaG1oLWRlc2t0b3A6JHt0YWd9XSAke3JlZGFjdChtc2cpfWApO1xufVxuXG4vKiAtLS0tIFx1NTM1NVx1NUI5RVx1NEY4QiAtLS0tICovXG5pZiAoIWFwcC5yZXF1ZXN0U2luZ2xlSW5zdGFuY2VMb2NrKCkpIHtcbiAgYXBwLnF1aXQoKTtcbn0gZWxzZSB7XG4gIGFwcC5vbignc2Vjb25kLWluc3RhbmNlJywgKCkgPT4ge1xuICAgIGNvbnN0IHdpbiA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpWzBdO1xuICAgIGlmICh3aW4pIHtcbiAgICAgIGlmICh3aW4uaXNNaW5pbWl6ZWQoKSkgd2luLnJlc3RvcmUoKTtcbiAgICAgIHdpbi5mb2N1cygpO1xuICAgIH1cbiAgfSk7XG5cbiAgLyogLS0tLSBob3N0IFx1NzZEMVx1N0JBMSArIFx1Njg2NVx1NUJBMlx1NjIzN1x1N0FFRiAtLS0tICovXG4gIGludGVyZmFjZSBCcmlkZ2VTbmFwc2hvdCB7XG4gICAgaG9zdFN0YXRlOiBIb3N0U3RhdGU7XG4gICAgaG9zdFBvcnQ6IG51bWJlciB8IG51bGw7XG4gICAgaG9zdFZlcnNpb246IHN0cmluZyB8IG51bGw7XG4gICAgbGFzdEVycm9yOiBzdHJpbmcgfCBudWxsO1xuICAgIG1vZGU6ICdmYWtlJyB8ICdyZWFsJztcbiAgfVxuICBsZXQgc3VwZXJ2aXNvcjogRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yIHwgbnVsbCA9IG51bGw7XG4gIGxldCBjbGllbnQ6IERlc2t0b3BIb3N0Q2xpZW50IHwgbnVsbCA9IG51bGw7XG4gIGxldCBicmlkZ2U6IEJyaWRnZVNuYXBzaG90ID0geyBob3N0U3RhdGU6ICdzdG9wcGVkJywgaG9zdFBvcnQ6IG51bGwsIGhvc3RWZXJzaW9uOiBudWxsLCBsYXN0RXJyb3I6IG51bGwsIG1vZGU6ICdmYWtlJyB9O1xuICAvKiogXHU0RThCXHU0RUY2XHU2Mjc5XHU5MUNGXHU3RjEzXHU1MUIyOlx1OUFEOFx1OTg5MSBTU0UgXHU0RTBEXHU5MDEwXHU2NzYxXHU4RkM3IElQQyw1MG1zIFx1NjI3OVx1OTFDRiBmbHVzaChcdTZFMzJcdTY3RDNcdTRFMERcdTUzNjEpXHUzMDAyICovXG4gIGxldCBldmVudEJ1ZmZlcjogRXZlbnRFbnZlbG9wZVtdID0gW107XG4gIGxldCBmbHVzaFRpbWVyOiBOb2RlSlMuVGltZW91dCB8IG51bGwgPSBudWxsO1xuICBsZXQgc3NlQWJvcnQ6IEFib3J0Q29udHJvbGxlciB8IG51bGwgPSBudWxsO1xuICBsZXQgbGFzdEV2ZW50SWQgPSAnJztcbiAgLyoqIFx1NjcyQVx1NzdFNS9cdTc1NzhcdTVGNjJcdTRGRTFcdTVDMDFcdThCQTFcdTY1NzAoU0NIRU1BX01JU01BVENIIFx1OTc2Mlx1NTQxMVx1OEJDQVx1NjVBRCxcdTRFMERcdTVEMjkpXHUzMDAyICovXG4gIGxldCBkcm9wcGVkRnJhbWVzID0gMDtcblxuICBmdW5jdGlvbiBwdXNoRXZlbnQoZW52OiBFdmVudEVudmVsb3BlKTogdm9pZCB7XG4gICAgZXZlbnRCdWZmZXIucHVzaChlbnYpO1xuICAgIGlmIChldmVudEJ1ZmZlci5sZW5ndGggPiAyXzAwMCkgZXZlbnRCdWZmZXIuc3BsaWNlKDAsIGV2ZW50QnVmZmVyLmxlbmd0aCAtIDJfMDAwKTtcbiAgICBpZiAoZmx1c2hUaW1lciA9PT0gbnVsbCkge1xuICAgICAgZmx1c2hUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICBmbHVzaFRpbWVyID0gbnVsbDtcbiAgICAgICAgY29uc3QgYmF0Y2ggPSBldmVudEJ1ZmZlcjtcbiAgICAgICAgZXZlbnRCdWZmZXIgPSBbXTtcbiAgICAgICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XG4gICAgICAgICAgaWYgKCF3LmlzRGVzdHJveWVkKCkpIHcud2ViQ29udGVudHMuc2VuZCgnYnJpZGdlOmV2ZW50LWJhdGNoJywgYmF0Y2gpO1xuICAgICAgICB9XG4gICAgICB9LCA1MCk7XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gYnJvYWRjYXN0SG9zdFN0YXRlKHM6IEhvc3RTdGF0ZSwgaW5mbzogeyByZXN0YXJ0Q291bnQ6IG51bWJlcjsgbGFzdEVycm9yPzogc3RyaW5nIH0pOiB2b2lkIHtcbiAgICBicmlkZ2UgPSB7IC4uLmJyaWRnZSwgaG9zdFN0YXRlOiBzLCBob3N0UG9ydDogc3VwZXJ2aXNvcj8uZW5kcG9pbnQ/LnBvcnQgPz8gbnVsbCwgaG9zdFZlcnNpb246IHN1cGVydmlzb3I/LmVuZHBvaW50Py52ZXJzaW9uID8/IG51bGwgfTtcbiAgICBsb2dJbmZvKCdob3N0JywgYHN0YXRlPSR7c30ke2luZm8ubGFzdEVycm9yICE9PSB1bmRlZmluZWQgPyBgIGVycj0ke2luZm8ubGFzdEVycm9yfWAgOiAnJ31gKTtcbiAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcbiAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ2JyaWRnZTpob3N0LXN0YXRlJywgcywgaW5mbyk7XG4gICAgfVxuICB9XG5cbiAgLyoqIFNTRSBcdTZENDFcdThCQTJcdTk2MDU6XHU0RkUxXHU1QzAxKGV2ZW50OiBobWgpXHU2Mjc5XHU5MUNGXHU2M0E4IHJlbmRlcmVyO1x1OUFEOFx1OTg5MSBkZWx0YS9saW5lIFx1NTM5Rlx1NUUyN1xuICAgKiAgXHU0RjVDXHU0RTNBXHU2RDQxXHU1NzU3XHU4RjZDXHU1M0QxKHJlbmRlcmVyIFx1NjJGQ1x1NjNBNVx1NUY1M1x1NTI0RCBhc3Npc3RhbnQgXHU1MzYwXHU0RjREKVx1MzAwMlx1NjVBRFx1N0VCRlx1ODFFQVx1NTJBOFx1OTFDRFx1OEZERVx1MzAwMiAqL1xuICBhc3luYyBmdW5jdGlvbiBwdW1wRXZlbnRzKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmIChjbGllbnQgPT09IG51bGwpIHJldHVybjtcbiAgICBmb3IgKDs7KSB7XG4gICAgICBjb25zdCBjID0gY2xpZW50O1xuICAgICAgaWYgKGMgPT09IG51bGwpIHJldHVybjtcbiAgICAgIHRyeSB7XG4gICAgICAgIGZvciBhd2FpdCAoY29uc3QgZnJhbWUgb2YgYy5yYXdFdmVudHMobGFzdEV2ZW50SWQgPT09ICcnID8gdW5kZWZpbmVkIDogbGFzdEV2ZW50SWQsIHNzZUFib3J0Py5zaWduYWwpKSB7XG4gICAgICAgICAgaWYgKGZyYW1lLmV2ZW50ID09PSAnaG1oJykge1xuICAgICAgICAgICAgY29uc3QgZW52ID0gZW52ZWxvcGVGcm9tRnJhbWUoZnJhbWUpO1xuICAgICAgICAgICAgaWYgKGVudiA9PT0gbnVsbCkge1xuICAgICAgICAgICAgICBkcm9wcGVkRnJhbWVzICs9IDE7XG4gICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgbGFzdEV2ZW50SWQgPSBlbnYuZXZlbnRJZDtcbiAgICAgICAgICAgIHB1c2hFdmVudChlbnYpO1xuICAgICAgICAgIH0gZWxzZSBpZiAoZnJhbWUuZXZlbnQgPT09ICdkZWx0YScgfHwgZnJhbWUuZXZlbnQgPT09ICdsaW5lJykge1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgY29uc3QgZCA9IEpTT04ucGFyc2UoZnJhbWUuZGF0YSkgYXMgeyBzZXNzaW9uSWQ/OiBzdHJpbmc7IGs/OiBzdHJpbmc7IGNodW5rPzogc3RyaW5nOyB0ZXh0Pzogc3RyaW5nIH07XG4gICAgICAgICAgICAgIGNvbnN0IHBheWxvYWQgPSBmcmFtZS5ldmVudCA9PT0gJ2RlbHRhJ1xuICAgICAgICAgICAgICAgID8geyBzZXNzaW9uSWQ6IGQuc2Vzc2lvbklkID8/ICcnLCBraW5kOiBkLmsgPz8gJ3RleHQnLCBjaHVuazogU3RyaW5nKGQuY2h1bmsgPz8gJycpIH1cbiAgICAgICAgICAgICAgICA6IHsgc2Vzc2lvbklkOiBkLnNlc3Npb25JZCA/PyAnJywga2luZDogJ2xpbmUnLCBjaHVuazogU3RyaW5nKGQudGV4dCA/PyAnJykgfTtcbiAgICAgICAgICAgICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XG4gICAgICAgICAgICAgICAgaWYgKCF3LmlzRGVzdHJveWVkKCkpIHcud2ViQ29udGVudHMuc2VuZCgnYnJpZGdlOnN0cmVhbS1jaHVuaycsIHBheWxvYWQpO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGNhdGNoIHsgLyogbWFsZm9ybWVkIHN0cmVhbSBmcmFtZTogc2tpcCAqLyB9XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHJldHVybjsgLy8gXHU2RDQxXHU2QjYzXHU1RTM4XHU3RUQzXHU2NzVGKGhvc3QgXHU1MTczXHU5NUVEKVxuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8vIFx1NjVBRFx1N0VCRjpcdTc3RURcdTkwMDBcdTkwN0ZcdTU0MEVcdTkxQ0RcdThGREUoc3VwZXJ2aXNvciBcdTUzRUZcdTgwRkRcdTZCNjNcdTU3MjhcdTkxQ0RcdTU0MkYgaG9zdClcbiAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgMV8wMDApKTtcbiAgICAgICAgaWYgKHNzZUFib3J0Py5zaWduYWwuYWJvcnRlZCkgcmV0dXJuO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8qKiBkZXYgXHU5RUQ4XHU4QkE0IGZha2UgaG9zdDtITUhfREVTS1RPUF9SRUFMPTEgXHU2NUY2XHU4RkRFXHU3NzFGXHU1QjlFIGhtaGFybmVzcyBkZXNrdG9wLWhvc3RcdTMwMDJcbiAgICogIFx1NkNFOFx1NjEwRjpFbGVjdHJvbiBcdTRFM0JcdThGREJcdTdBMEJcdTc2ODQgcHJvY2Vzcy5leGVjUGF0aCBcdTY2MkYgZWxlY3Ryb24uZXhlXHUyMDE0XHUyMDE0aG9zdCBcdTVCNTBcdThGREJcdTdBMEJcbiAgICogIFx1NUZDNVx1OTg3Qlx1NUUyNiBFTEVDVFJPTl9SVU5fQVNfTk9ERT0xIFx1NjI0RFx1NEYxQVx1NEVFNVx1N0VBRiBub2RlIFx1OEJFRFx1NEU0OVx1OEREMVx1MzAwMlxuICAgKiAgXHU2MjUzXHU1MzA1XHU0RUE3XHU1NEMxKGFwcC5pc1BhY2thZ2VkKTpmYWtlIGhvc3QgXHU3NTI4IGV4dHJhUmVzb3VyY2VzIFx1OTFDQ1x1NzY4NFx1ODFFQVx1NTMwNVx1NTQyQiBjanM7XG4gICAqICBcdTc3MUZcdTVCOUUgcnVudGltZSBcdTk3MDAgSE1IX0RFU0tUT1BfUkVBTF9FTlRSWSBcdTYzMDdcdTU0MTEgZGVza3RvcC1ob3N0IFx1NTE2NVx1NTNFMyhcdTRFQTdcdTU0QzFcdTUzMTZcbiAgICogIFx1NzY4NCBydW50aW1lIFx1NjM0Nlx1N0VEMVx1NUM1RVx1NTQwRVx1N0VFRFx1OEJCRVx1OEJBMSxcdTg5QzFcdTlBOENcdTY1MzZcdTYyQTVcdTU0NEEpXHUzMDAyICovXG4gIGFzeW5jIGZ1bmN0aW9uIHN0YXJ0SG9zdCgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCB1c2VSZWFsID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfUkVBTCA9PT0gJzEnO1xuICAgIGJyaWRnZSA9IHsgLi4uYnJpZGdlLCBtb2RlOiB1c2VSZWFsID8gJ3JlYWwnIDogJ2Zha2UnIH07XG4gICAgY29uc3QgcmVwb1Jvb3QgPSBqb2luKGhlcmUsICcuLicsICcuLicsICcuLicsICcuLicpOyAvLyBhcHBzL2Rlc2t0b3AvZGlzdC1lbGVjdHJvbi9tYWluIFx1MjE5MiByZXBvIHJvb3RcbiAgICBjb25zdCBwYWNrYWdlZCA9IGFwcC5pc1BhY2thZ2VkO1xuICAgIGxldCBzcGVjOiB7IGNvbW1hbmQ6IHN0cmluZzsgYXJnczogc3RyaW5nW107IGVudjogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB9O1xuICAgIGlmICh1c2VSZWFsKSB7XG4gICAgICBjb25zdCBlbnRyeSA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1JFQUxfRU5UUlkgPz8gKHBhY2thZ2VkID8gJycgOiBqb2luKHJlcG9Sb290LCAnLi4nLCAnaG1oYXJuZXNzJywgJ3BhY2thZ2VzJywgJ3dlYicsICdzcmMnLCAnZGVza3RvcC1ob3N0LnRzJykpO1xuICAgICAgaWYgKGVudHJ5ID09PSAnJykge1xuICAgICAgICBicmlkZ2UgPSB7IC4uLmJyaWRnZSwgaG9zdFN0YXRlOiAnZmFpbGVkJywgbGFzdEVycm9yOiAnXHU3NzFGXHU1QjlFIHJ1bnRpbWUgXHU2NzJBXHU5MTREXHU3RjZFOlx1NjI1M1x1NTMwNVx1NEVBN1x1NTRDMVx1OTcwMFx1OEJCRVx1N0Y2RSBITUhfREVTS1RPUF9SRUFMX0VOVFJZIFx1NjMwN1x1NTQxMSBobWhhcm5lc3MgZGVza3RvcC1ob3N0IFx1NTE2NVx1NTNFMycgfTtcbiAgICAgICAgbG9nSW5mbygnaG9zdCcsICdyZWFsIG1vZGUgd2l0aG91dCBITUhfREVTS1RPUF9SRUFMX0VOVFJZIGluIHBhY2thZ2VkIGFwcCcpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBzcGVjID0ge1xuICAgICAgICBjb21tYW5kOiBwcm9jZXNzLmV4ZWNQYXRoLFxuICAgICAgICBhcmdzOiBbJy0taW1wb3J0JywgJ3RzeCcsIGVudHJ5XSxcbiAgICAgICAgZW52OiB7IEVMRUNUUk9OX1JVTl9BU19OT0RFOiAnMScgfSxcbiAgICAgIH07XG4gICAgfSBlbHNlIGlmIChwYWNrYWdlZCkge1xuICAgICAgc3BlYyA9IHtcbiAgICAgICAgY29tbWFuZDogcHJvY2Vzcy5leGVjUGF0aCxcbiAgICAgICAgYXJnczogW2pvaW4ocHJvY2Vzcy5yZXNvdXJjZXNQYXRoLCAnZmFrZS1ob3N0LmNqcycpXSxcbiAgICAgICAgZW52OiB7IEVMRUNUUk9OX1JVTl9BU19OT0RFOiAnMScgfSxcbiAgICAgIH07XG4gICAgfSBlbHNlIHtcbiAgICAgIHNwZWMgPSB7XG4gICAgICAgIGNvbW1hbmQ6IHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgICAgIC8vIFx1NzZGNFx1NjNBNVx1OEQ3MFx1NTMwNVx1NzcxRlx1NUI5RVx1OERFRlx1NUY4NChub2RlX21vZHVsZXMgXHU5MUNDXHU3Njg0IHdvcmtzcGFjZSBqdW5jdGlvbiBcdTRGMUFcdTg4QUIgRVNNXG4gICAgICAgIC8vIHJlYWxwYXRoIFx1NTMxNixcdTVCRkNcdTgxRjQgZmFrZS1ob3N0IFx1NzY4NCBhcmd2WzFdL2ltcG9ydC5tZXRhLnVybCBcdTUzMzlcdTkxNERcdTU5MzFcdTY1NDgpXG4gICAgICAgIGFyZ3M6IFsnLS1pbXBvcnQnLCAndHN4Jywgam9pbihyZXBvUm9vdCwgJ3BhY2thZ2VzJywgJ2hvc3QtYWRhcHRlcicsICdzcmMnLCAnZmFrZS1ob3N0LnRzJyldLFxuICAgICAgICBlbnY6IHsgRUxFQ1RST05fUlVOX0FTX05PREU6ICcxJyB9LFxuICAgICAgfTtcbiAgICB9XG4gICAgc3VwZXJ2aXNvciA9IG5ldyBEZXNrdG9wUnVudGltZVN1cGVydmlzb3Ioc3BlYywge1xuICAgICAgb25TdGF0ZUNoYW5nZTogYnJvYWRjYXN0SG9zdFN0YXRlLFxuICAgICAgLy8gXHU5OTk2XHU2QjIxXHU1NDJGXHU1MkE4XHU0RTBFIGNyYXNoIFx1ODFFQVx1NjEwOFx1NTQwRVx1NzY4NFx1OTFDRFx1NTQyRlx1OTBGRFx1NEYxQVx1OEQ3MFx1OEZEOVx1OTFDQzpcdTdBRUZcdTUzRTMvdG9rZW4gXHU5MEZEXHU2NjJGXHU2NUIwXHU3Njg0LFxuICAgICAgLy8gXHU5MUNEXHU1RUZBXHU2ODY1XHU1QkEyXHU2MjM3XHU3QUVGXHU1RTc2XHU5MUNEXHU2NUIwXHU4QkEyXHU5NjA1IFNTRShyZW5kZXJlciBcdTc2ODQgRXZlbnRTdG9yZSBcdTk3NjAgZXZlbnRJZCBcdTUzQkJcdTkxQ0QpXG4gICAgICBvblJlYWR5OiAoZXApID0+IHtcbiAgICAgICAgY2xpZW50ID0gbmV3IERlc2t0b3BIb3N0Q2xpZW50KGBodHRwOi8vMTI3LjAuMC4xOiR7ZXAucG9ydH1gLCBlcC50b2tlbik7XG4gICAgICAgIHNzZUFib3J0Py5hYm9ydCgpO1xuICAgICAgICBzc2VBYm9ydCA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgICAgICAgbGFzdEV2ZW50SWQgPSAnJztcbiAgICAgICAgdm9pZCBwdW1wRXZlbnRzKCk7XG4gICAgICAgIGxvZ0luZm8oJ2hvc3QnLCBgYnJpZGdlIHJlYWR5IG9uIDEyNy4wLjAuMToke2VwLnBvcnR9IChydW50aW1lICR7ZXAudmVyc2lvbn0sIG1vZGUgJHticmlkZ2UubW9kZX0pYCk7XG4gICAgICB9LFxuICAgIH0pO1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCBzdXBlcnZpc29yLnN0YXJ0KCk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBjb25zdCBkZXRhaWwgPSAoKCkgPT4geyB0cnkgeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkoZXJyKTsgfSBjYXRjaCB7IHJldHVybiBTdHJpbmcoZXJyKTsgfSB9KSgpLnNsaWNlKDAsIDQwMCk7XG4gICAgICBicmlkZ2UgPSB7IC4uLmJyaWRnZSwgaG9zdFN0YXRlOiAnZmFpbGVkJywgbGFzdEVycm9yOiBkZXRhaWwgfTtcbiAgICAgIGxvZ0luZm8oJ2hvc3QnLCBgc3RhcnQgZmFpbGVkOiAke2RldGFpbH1gKTtcbiAgICB9XG4gIH1cblxuICAvKiAtLS0tIElQQyBcdTc2N0RcdTU0MERcdTUzNTUgKyBzZW5kZXIgXHU2ODIxXHU5QThDIC0tLS0gKi9cbiAgY29uc3QgYWxsb3dlZE9yaWdpbnMgPSBuZXcgU2V0PHN0cmluZz4oXG4gICAgaXNEZXYgJiYgcmVuZGVyZXJEZXZVcmxcbiAgICAgID8gW3JlbmRlcmVyRGV2VXJsXVxuICAgICAgOiBbcGF0aFRvRmlsZVVSTChqb2luKGhlcmUsICcuLicsICcuLicsICdkaXN0LXJlbmRlcmVyJywgJ2luZGV4Lmh0bWwnKSkuaHJlZl0sXG4gICk7XG5cbiAgZnVuY3Rpb24gc2VuZGVyVHJ1c3RlZChzZW5kZXJGcmFtZTogRWxlY3Ryb24uV2ViRnJhbWVNYWluIHwgbnVsbCB8IHVuZGVmaW5lZCk6IGJvb2xlYW4ge1xuICAgIGlmIChzZW5kZXJGcmFtZSA9PT0gbnVsbCB8fCBzZW5kZXJGcmFtZSA9PT0gdW5kZWZpbmVkKSByZXR1cm4gZmFsc2U7XG4gICAgbGV0IHRvcDogRWxlY3Ryb24uV2ViRnJhbWVNYWluIHwgbnVsbCA9IHNlbmRlckZyYW1lO1xuICAgIHdoaWxlICh0b3A/LnBhcmVudCAhPT0gbnVsbCAmJiB0b3A/LnBhcmVudCAhPT0gdW5kZWZpbmVkKSB0b3AgPSB0b3AucGFyZW50O1xuICAgIGNvbnN0IHVybCA9IHRvcD8udXJsID8/ICcnO1xuICAgIGZvciAoY29uc3Qgb3JpZ2luIG9mIGFsbG93ZWRPcmlnaW5zKSB7XG4gICAgICBpZiAodXJsID09PSBvcmlnaW4gfHwgdXJsLnN0YXJ0c1dpdGgoYCR7b3JpZ2lufS9gKSB8fCB1cmwuc3RhcnRzV2l0aChgJHtvcmlnaW59P2ApKSByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgLyoqIFx1OTcwMFx1ODk4MSBob3N0IFx1NUMzMVx1N0VFQVx1NzY4NCBJUEMgaGFuZGxlciBcdTUxNkNcdTUxNzFcdTU4RjM6XHU2NzJBXHU1QzMxXHU3RUVBXHU4RkQ0XHU1NkRFXHU3RUQzXHU2Nzg0XHU1MzE2XHU5NTE5XHU4QkVGXHUzMDAyICovXG4gIGZ1bmN0aW9uIGhvc3RDYWxsPFQ+KGV2ZW50OiBFbGVjdHJvbi5JcGNNYWluSW52b2tlRXZlbnQsIGZuOiAoYzogRGVza3RvcEhvc3RDbGllbnQpID0+IFByb21pc2U8VD4pOiBQcm9taXNlPFQgfCB7IGVycm9yOiBzdHJpbmc7IGNvZGU6IHN0cmluZyB9PiB7XG4gICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH0pO1xuICAgIGlmIChjbGllbnQgPT09IG51bGwgfHwgYnJpZGdlLmhvc3RTdGF0ZSAhPT0gJ3JlYWR5Jykge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiBgaG9zdCBub3QgcmVhZHkgKCR7YnJpZGdlLmhvc3RTdGF0ZX0pYCwgY29kZTogJ0hPU1RfTk9UX1JFQURZJyB9KTtcbiAgICB9XG4gICAgcmV0dXJuIGZuKGNsaWVudCkuY2F0Y2goKGVycjogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3QgZGV0YWlsID0gKCgpID0+IHsgdHJ5IHsgcmV0dXJuIEpTT04uc3RyaW5naWZ5KGVycik7IH0gY2F0Y2ggeyByZXR1cm4gU3RyaW5nKGVycik7IH0gfSkoKS5zbGljZSgwLCAzMDApO1xuICAgICAgcmV0dXJuIHsgZXJyb3I6IGRldGFpbCwgY29kZTogJ0JSSURHRV9FUlJPUicgfTtcbiAgICB9KTtcbiAgfVxuXG4gIGZ1bmN0aW9uIHJlZ2lzdGVySXBjKCk6IHZvaWQge1xuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6Z2V0LXN0YXRlJywgKGV2ZW50KSA9PiB7XG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInIH07XG4gICAgICByZXR1cm4geyAuLi5icmlkZ2UsIGRyb3BwZWRGcmFtZXMgfTtcbiAgICB9KTtcblxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6c2Vzc2lvbnMnLCAoZXZlbnQpID0+XG4gICAgICBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjx7IHNlc3Npb25zOiBBcnJheTx7IGlkOiBzdHJpbmc7IHRpdGxlOiBzdHJpbmc7IHRhc2s6IHN0cmluZzsgb3V0Y29tZTogc3RyaW5nOyB0dXJuczogbnVtYmVyOyB0b29sVXNlczogbnVtYmVyOyB0aW1lOiBzdHJpbmc7IGN3ZDogc3RyaW5nOyBjcmVhdGVkQXQ6IHN0cmluZzsgdXBkYXRlZEF0OiBzdHJpbmcgfT4gfT4oJy9hcGkvc2Vzc2lvbnM/bGltaXQ9MTAwJykpKTtcblxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6c2VuZC10YXNrJywgKGV2ZW50LCB0ZXh0OiB1bmtub3duLCBzZXNzaW9uSWQ6IHVua25vd24sIG1vZGU6IHVua25vd24pID0+IHtcbiAgICAgIGNvbnN0IHRhc2sgPSB0eXBlb2YgdGV4dCA9PT0gJ3N0cmluZycgPyB0ZXh0LnNsaWNlKDAsIDIwXzAwMCkgOiAnJztcbiAgICAgIGNvbnN0IHNpZCA9IHR5cGVvZiBzZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gc2Vzc2lvbklkLnNsaWNlKDAsIDgwKSA6ICcnO1xuICAgICAgY29uc3QgbSA9IG1vZGUgPT09ICdhdXRvJyB8fCBtb2RlID09PSAneW9sbycgPyBtb2RlIDogJ2Fzayc7XG4gICAgICBpZiAodGFzayA9PT0gJycgfHwgc2lkID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IG9rOiBmYWxzZSwgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbjsgcnVuSWQ/OiBzdHJpbmcgfT4oJy9hcGkvdGFzaycsIHsgdGV4dDogdGFzaywgc2Vzc2lvbklkOiBzaWQsIG1vZGU6IG0gfSkpO1xuICAgIH0pO1xuXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTphcHByb3ZlJywgKGV2ZW50LCBncmFudGVkOiB1bmtub3duLCBzZXNzaW9uSWQ6IHVua25vd24pID0+XG4gICAgICBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PignL2FwaS9hcHByb3ZlJywge1xuICAgICAgICBncmFudGVkOiBncmFudGVkID09PSB0cnVlLFxuICAgICAgICBzZXNzaW9uSWQ6IHR5cGVvZiBzZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gc2Vzc2lvbklkLnNsaWNlKDAsIDgwKSA6ICcnLFxuICAgICAgfSkpKTtcblxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6aW50ZXJydXB0JywgKGV2ZW50LCBzZXNzaW9uSWQ6IHVua25vd24pID0+XG4gICAgICBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PignL2FwaS9pbnRlcnJ1cHQnLCB7XG4gICAgICAgIHNlc3Npb25JZDogdHlwZW9mIHNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBzZXNzaW9uSWQuc2xpY2UoMCwgODApIDogJycsXG4gICAgICB9KSkpO1xuXG4gICAgLy8gLS0tLSBNNDpcdTVERTVcdTRGNUNcdTUzM0FcdTY1ODdcdTRFRjZcdTk3NjIoXHU4REVGXHU1Rjg0XHU2Mzg4XHU2NzQzXHU1NzI4IHJ1bnRpbWU6aW5zaWRlV3MgXHU2ODIxXHU5QThDKSAtLS0tXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpmcy1saXN0JywgKGV2ZW50LCBwYXRoOiB1bmtub3duKSA9PiB7XG4gICAgICBjb25zdCBwID0gdHlwZW9mIHBhdGggPT09ICdzdHJpbmcnID8gcGF0aC5zbGljZSgwLCAxMDAwKSA6ICcnO1xuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPFJlY29yZDxzdHJpbmcsIHVua25vd24+PihgL2FwaS9mcz9maWxlcz0xJHtwICE9PSAnJyA/IGAmcGF0aD0ke2VuY29kZVVSSUNvbXBvbmVudChwKX1gIDogJyd9YCkpO1xuICAgIH0pO1xuXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpmcy1yZWFkJywgKGV2ZW50LCBwYXRoOiB1bmtub3duKSA9PiB7XG4gICAgICBjb25zdCBwID0gdHlwZW9mIHBhdGggPT09ICdzdHJpbmcnID8gcGF0aC5zbGljZSgwLCAxMDAwKSA6ICcnO1xuICAgICAgaWYgKHAgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICdwYXRoIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oYC9hcGkvZnMvcmVhZD9wYXRoPSR7ZW5jb2RlVVJJQ29tcG9uZW50KHApfWApKTtcbiAgICB9KTtcblxuICAgIC8vIC0tLS0gTTQ6RGlmZiBcdTk3NjJcdTY3N0YoXHU1M0VBXHU4QkZCIGdpdCBcdTUzRDhcdTY2RjQ7XHU2Mzg4XHU2NzQzXHU1NzI4IHJ1bnRpbWUpIC0tLS1cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmRpZmYnLCAoZXZlbnQsIHNlc3Npb25JZDogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIHNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBzZXNzaW9uSWQuc2xpY2UoMCwgODApIDogJyc7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KGAvYXBpL2RpZmYke3NpZCAhPT0gJycgPyBgP3Nlc3Npb25JZD0ke2VuY29kZVVSSUNvbXBvbmVudChzaWQpfWAgOiAnJ31gKSk7XG4gICAgfSk7XG5cbiAgICAvLyAtLS0tIE01Olx1OEJBNFx1NzdFNVx1NzJCNlx1NjAwMShcdTdFRDNcdTY3ODRcdTUzMTZcdTRFOEJcdTVCOUU7XHU3RjNBXHU2NTcwXHU2MzZFXHU1QjU3XHU2QkI1XHU3NTMxIFVJIFx1NjYzRVx1NzkzQVwiXHU2NUUwXHU2NTcwXHU2MzZFXCIpIC0tLS1cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmNvZ25pdGl2ZScsIChldmVudCkgPT5cbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPFJlY29yZDxzdHJpbmcsIHVua25vd24+PignL2FwaS9jb2duaXRpdmUnKSkpO1xuXG4gICAgLy8gLS0tLSBcdTUzODZcdTUzRjJcdTRGMUFcdThCRERcdTk4ODRcdTg5QzgoXHU2NzAwXHU1NDBFIDgwIFx1Njc2MSxcdTZCQ0ZcdTY3NjEgNTAwIFx1NUI1NztydW50aW1lIFx1Njc0M1x1NUEwMVx1NjU3MFx1NjM2RSkgLS0tLVxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6c2Vzc2lvbi1wcmV2aWV3JywgKGV2ZW50LCBpZDogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIGlkID09PSAnc3RyaW5nJyA/IGlkLnJlcGxhY2UoL1teYS16QS1aMC05XzouQC1dL2csICcnKS5zbGljZSgwLCA4MCkgOiAnJztcbiAgICAgIGlmIChzaWQgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICdpZCByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KGAvYXBpL3Nlc3Npb25zLyR7ZW5jb2RlVVJJQ29tcG9uZW50KHNpZCl9YCkpO1xuICAgIH0pO1xuXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpzdG9wLWhvc3QnLCAoZXZlbnQpID0+IHtcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicgfTtcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcbiAgICAgICAgc3NlQWJvcnQ/LmFib3J0KCk7XG4gICAgICAgIGF3YWl0IHN1cGVydmlzb3I/LnN0b3AoKTtcbiAgICAgICAgYXBwLnF1aXQoKTtcbiAgICAgIH0pKCk7XG4gICAgICByZXR1cm4geyBvazogdHJ1ZSB9O1xuICAgIH0pO1xuICB9XG5cbiAgLyogLS0tLSBcdTdBOTdcdTUzRTNcdTRFMEVcdTVCODlcdTUxNjhcdTdCNTZcdTc1NjUgLS0tLSAqL1xuICBmdW5jdGlvbiBjcmVhdGVXaW5kb3coKTogdm9pZCB7XG4gICAgY29uc3Qgd2luID0gbmV3IEJyb3dzZXJXaW5kb3coe1xuICAgICAgd2lkdGg6IDE0NDAsXG4gICAgICBoZWlnaHQ6IDkwMCxcbiAgICAgIG1pbldpZHRoOiA5NjAsXG4gICAgICBtaW5IZWlnaHQ6IDYwMCxcbiAgICAgIHNob3c6IGZhbHNlLFxuICAgICAgYmFja2dyb3VuZENvbG9yOiAnIzE0MTQxNicsXG4gICAgICB0aXRsZTogJ0hNSCBEZXNrdG9wJyxcbiAgICAgIHdlYlByZWZlcmVuY2VzOiB7XG4gICAgICAgIHByZWxvYWQ6IHByZWxvYWRQYXRoLFxuICAgICAgICBjb250ZXh0SXNvbGF0aW9uOiB0cnVlLFxuICAgICAgICBzYW5kYm94OiB0cnVlLFxuICAgICAgICBub2RlSW50ZWdyYXRpb246IGZhbHNlLFxuICAgICAgICBub2RlSW50ZWdyYXRpb25JbldvcmtlcjogZmFsc2UsXG4gICAgICAgIHdlYlNlY3VyaXR5OiB0cnVlLFxuICAgICAgICBzcGVsbGNoZWNrOiBmYWxzZSxcbiAgICAgICAgZGV2VG9vbHM6IGlzRGV2LFxuICAgICAgfSxcbiAgICB9KTtcbiAgICB3aW4ub25jZSgncmVhZHktdG8tc2hvdycsICgpID0+IHdpbi5zaG93KCkpO1xuXG4gICAgLy8gXHU1M0VBXHU1MTQxXHU4QkI4XHU1MkEwXHU4RjdEXHU2MjExXHU0RUVDXHU4MUVBXHU1REYxXHU3Njg0IHJlbmRlcmVyO1x1NEVGQlx1NEY1NVx1NUJGQ1x1ODIyQS9cdTY1QjBcdTdBOTdcdTUzRTNcdTRFMDBcdTVGOEJcdTYyRDJcdTdFRERcbiAgICB3aW4ud2ViQ29udGVudHMuc2V0V2luZG93T3BlbkhhbmRsZXIoKHsgdXJsIH0pID0+IHtcbiAgICAgIGlmICgvXmh0dHBzPzpcXC9cXC8vLnRlc3QodXJsKSkgdm9pZCBzaGVsbC5vcGVuRXh0ZXJuYWwodXJsKTtcbiAgICAgIHJldHVybiB7IGFjdGlvbjogJ2RlbnknIH07XG4gICAgfSk7XG4gICAgd2luLndlYkNvbnRlbnRzLm9uKCd3aWxsLW5hdmlnYXRlJywgKGUsIHVybCkgPT4ge1xuICAgICAgY29uc3Qgb2sgPSBbLi4uYWxsb3dlZE9yaWdpbnNdLnNvbWUoKG8pID0+IHVybCA9PT0gbyB8fCB1cmwuc3RhcnRzV2l0aChgJHtvfS9gKSB8fCB1cmwuc3RhcnRzV2l0aChgJHtvfT9gKSk7XG4gICAgICBpZiAoIW9rKSB7XG4gICAgICAgIGxvZ0luZm8oJ25hdicsIGBibG9ja2VkIG5hdmlnYXRpb24gdG8gJHt1cmwuc2xpY2UoMCwgMTIwKX1gKTtcbiAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgaWYgKGlzRGV2ICYmIHJlbmRlcmVyRGV2VXJsKSB7XG4gICAgICB2b2lkIHdpbi5sb2FkVVJMKHJlbmRlcmVyRGV2VXJsKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdm9pZCB3aW4ubG9hZEZpbGUoam9pbihoZXJlLCAnLi4nLCAnLi4nLCAnZGlzdC1yZW5kZXJlcicsICdpbmRleC5odG1sJykpO1xuICAgIH1cbiAgfVxuXG4gIGFwcC53aGVuUmVhZHkoKS50aGVuKCgpID0+IHtcbiAgICAvLyBDU1AoZGV2IFx1NEUwRSBwcm9kIFx1NEUwRFx1NTQwQztwcm9kIFx1NEUwRFx1NTE0MVx1OEJCOFx1NEVGQlx1NEY1NVx1OEZEQ1x1N0EwQlx1NkU5MClcbiAgICBjb25zdCBjc3AgPSBpc0RldlxuICAgICAgPyBbXG4gICAgICAgICAgXCJkZWZhdWx0LXNyYyAnc2VsZidcIixcbiAgICAgICAgICBgc2NyaXB0LXNyYyAnc2VsZicgJHtyZW5kZXJlckRldlVybH1gLFxuICAgICAgICAgIFwic3R5bGUtc3JjICdzZWxmJyAndW5zYWZlLWlubGluZSdcIixcbiAgICAgICAgICBgY29ubmVjdC1zcmMgJ3NlbGYnICR7cmVuZGVyZXJEZXZVcmx9IHdzOi8vMTI3LjAuMC4xOipgLFxuICAgICAgICAgIFwiaW1nLXNyYyAnc2VsZicgZGF0YTpcIixcbiAgICAgICAgICBcImZvbnQtc3JjICdzZWxmJyBkYXRhOlwiLFxuICAgICAgICBdLmpvaW4oJzsgJylcbiAgICAgIDogXCJkZWZhdWx0LXNyYyAnc2VsZic7IHNjcmlwdC1zcmMgJ3NlbGYnOyBzdHlsZS1zcmMgJ3NlbGYnICd1bnNhZmUtaW5saW5lJzsgaW1nLXNyYyAnc2VsZicgZGF0YTo7IGZvbnQtc3JjICdzZWxmJyBkYXRhOlwiO1xuICAgIHNlc3Npb24uZGVmYXVsdFNlc3Npb24ud2ViUmVxdWVzdC5vbkhlYWRlcnNSZWNlaXZlZCgoZGV0YWlscywgY2FsbGJhY2spID0+IHtcbiAgICAgIGNhbGxiYWNrKHtcbiAgICAgICAgcmVzcG9uc2VIZWFkZXJzOiB7XG4gICAgICAgICAgLi4uZGV0YWlscy5yZXNwb25zZUhlYWRlcnMsXG4gICAgICAgICAgJ0NvbnRlbnQtU2VjdXJpdHktUG9saWN5JzogW2NzcF0sXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHJlZ2lzdGVySXBjKCk7XG4gICAgY3JlYXRlV2luZG93KCk7XG4gICAgdm9pZCBzdGFydEhvc3QoKTtcblxuICAgIC8vIFx1OTYzNlx1NkJCNUggXHU1Qjg5XHU1MTY4XHU4MUVBXHU2RDRCKE1hc3RlclByb21wdCBIOnJlbmRlcmVyIFx1NjVFMCBwcm9jZXNzL3JlcXVpcmVcdTMwMDFcdTc2N0RcdTU0MERcdTUzNTVcdTY4NjVcdTMwMDFcbiAgICAvLyBcdTVCRkNcdTgyMkFcdTYyRTZcdTYyMkFcdTMwMDFDU1BcdTMwMDF3aW5kb3cub3BlbiBcdTYyRDJcdTdFREQpXHUzMDAyXHU4MUVBXHU5QTcxXHU2M0EyXHU5NDg4LHNjcmlwdHMvc2VjdXJpdHktdGVzdC5tanMgXHU2RDg4XHU4RDM5XHUzMDAyXG4gICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NFQ1VSSVRZX1RFU1QgPT09ICcxJykge1xuICAgICAgY29uc3Qgd2luMCA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpWzBdO1xuICAgICAgaWYgKHdpbjAgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICB3aW4wLndlYkNvbnRlbnRzLm9uY2UoJ2RpZC1maW5pc2gtbG9hZCcsICgpID0+IHtcbiAgICAgICAgICB2b2lkIHNlY3VyaXR5U2VsZlRlc3Qod2luMCk7XG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cblxuICAgIGFwcC5vbignYWN0aXZhdGUnLCAoKSA9PiB7XG4gICAgICBpZiAoQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkubGVuZ3RoID09PSAwKSBjcmVhdGVXaW5kb3coKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgYXN5bmMgZnVuY3Rpb24gc2VjdXJpdHlTZWxmVGVzdCh3aW46IEJyb3dzZXJXaW5kb3cpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCByZXN1bHRzOiBBcnJheTxbc3RyaW5nLCBib29sZWFuLCBzdHJpbmddPiA9IFtdO1xuICAgIGNvbnN0IGNoZWNrID0gYXN5bmMgKG5hbWU6IHN0cmluZywgcHJvYmU6ICgpID0+IFByb21pc2U8W2Jvb2xlYW4sIHN0cmluZ10+KTogUHJvbWlzZTx2b2lkPiA9PiB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBbb2ssIGRldGFpbF0gPSBhd2FpdCBwcm9iZSgpO1xuICAgICAgICByZXN1bHRzLnB1c2goW25hbWUsIG9rLCBkZXRhaWxdKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICByZXN1bHRzLnB1c2goW25hbWUsIGZhbHNlLCBTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApXSk7XG4gICAgICB9XG4gICAgfTtcbiAgICBjb25zdCBqcyA9IChjb2RlOiBzdHJpbmcpOiBQcm9taXNlPHVua25vd24+ID0+IHdpbi53ZWJDb250ZW50cy5leGVjdXRlSmF2YVNjcmlwdChjb2RlLCB0cnVlKTtcblxuICAgIGF3YWl0IGNoZWNrKCdyZW5kZXJlciBcdTY1RTBcdTUzRUZcdTc1MjhcdTc2ODQgcHJvY2Vzcy9yZXF1aXJlKHNhbmRib3ggXHU3NTFGXHU2NTQ4KScsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoYChmdW5jdGlvbigpe1xuICAgICAgICB2YXIgdCA9IGZ1bmN0aW9uKGYpeyB0cnkgeyB2YXIgdiA9IGYoKTsgcmV0dXJuICh2ID09PSB1bmRlZmluZWQgfHwgdiA9PT0gbnVsbCkgPyAndW5hdmFpbGFibGUnIDogdHlwZW9mIHY7IH0gY2F0Y2goZSl7IHJldHVybiAnYmxvY2tlZCc7IH0gfTtcbiAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KFt0KGZ1bmN0aW9uKCl7cmV0dXJuIHByb2Nlc3N9KSwgdChmdW5jdGlvbigpe3JldHVybiByZXF1aXJlfSksIHQoZnVuY3Rpb24oKXtyZXR1cm4gZ2xvYmFsVGhpcy5wcm9jZXNzfSldKTtcbiAgICAgIH0pKClgKSkgYXMgc3RyaW5nO1xuICAgICAgY29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShyKSBhcyBzdHJpbmdbXTtcbiAgICAgIGNvbnN0IHAgPSBwYXJzZWRbMF0gPz8gJ3Vua25vd24nO1xuICAgICAgY29uc3QgcmVxID0gcGFyc2VkWzFdID8/ICd1bmtub3duJztcbiAgICAgIGNvbnN0IHNhZmUgPSAodjogc3RyaW5nKTogYm9vbGVhbiA9PiB2ID09PSAndW5hdmFpbGFibGUnIHx8IHYgPT09ICdibG9ja2VkJztcbiAgICAgIHJldHVybiBbc2FmZShwKSAmJiBzYWZlKHJlcSksIGBwcm9jZXNzPSR7cH0gcmVxdWlyZT0ke3JlcX1gXTtcbiAgICB9KTtcbiAgICBhd2FpdCBjaGVjaygnd2luZG93LmhtaCBcdTUzRUFcdTY3MDlcdTc2N0RcdTU0MERcdTUzNTVcdTY1QjlcdTZDRDUoXHU2NUUwIGlwY1JlbmRlcmVyL1x1OTg5RFx1NTkxNlx1OTc2MiknLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKCdPYmplY3Qua2V5cyh3aW5kb3cuaG1oIHx8IHt9KS5zb3J0KCkuam9pbihcIixcIiknKSkgYXMgc3RyaW5nO1xuICAgICAgY29uc3QgYWxsb3cgPSBbJ2FwcHJvdmUnLCAnY29nbml0aXZlJywgJ2RpZmYnLCAnZnNMaXN0JywgJ2ZzUmVhZCcsICdnZXRTdGF0ZScsICdpbnRlcnJ1cHQnLCAnb25FdmVudEJhdGNoZXMnLCAnb25Ib3N0U3RhdGUnLCAnb25TdHJlYW1DaHVua3MnLCAnc2VuZFRhc2snLCAnc2Vzc2lvblByZXZpZXcnLCAnc2Vzc2lvbnMnLCAnc3RvcEhvc3QnXTtcbiAgICAgIGNvbnN0IGdvdCA9IHIgPT09ICcnID8gW10gOiByLnNwbGl0KCcsJyk7XG4gICAgICBjb25zdCB1bmV4cGVjdGVkID0gZ290LmZpbHRlcigoaykgPT4gIWFsbG93LmluY2x1ZGVzKGspKTtcbiAgICAgIHJldHVybiBbdW5leHBlY3RlZC5sZW5ndGggPT09IDAsIGBrZXlzPSR7cn1gXTtcbiAgICB9KTtcbiAgICBhd2FpdCBjaGVjaygnXHU1OTE2XHU5MEU4XHU1QkZDXHU4MjJBXHU4OEFCXHU2MkU2XHU2MjJBKFVSTCBcdTRFMERcdTUzRDgpJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgYmVmb3JlID0gd2luLndlYkNvbnRlbnRzLmdldFVSTCgpO1xuICAgICAgYXdhaXQganMoJ2xvY2F0aW9uLmhyZWYgPSBcImh0dHBzOi8vZXhhbXBsZS5pbnZhbGlkL3hcIjsgXCJub29wXCInKS5jYXRjaCgoKSA9PiAnbm9vcCcpO1xuICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHIyKSA9PiBzZXRUaW1lb3V0KHIyLCAxXzIwMCkpO1xuICAgICAgY29uc3QgYWZ0ZXIgPSB3aW4ud2ViQ29udGVudHMuZ2V0VVJMKCk7XG4gICAgICByZXR1cm4gW2FmdGVyID09PSBiZWZvcmUsIGAke2JlZm9yZX0gXHUyMTkyICR7YWZ0ZXJ9YF07XG4gICAgfSk7XG4gICAgYXdhaXQgY2hlY2soJ3dpbmRvdy5vcGVuIFx1ODhBQlx1NjJEMlx1N0VERChcdThGRDRcdTU2REUgbnVsbCBcdTRFMTRcdTY1RTBcdTY1QjBcdTdBOTdcdTUzRTMpJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgYmVmb3JlID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkubGVuZ3RoO1xuICAgICAgY29uc3QgciA9IChhd2FpdCBqcygnU3RyaW5nKHdpbmRvdy5vcGVuKFwiaHR0cHM6Ly9leGFtcGxlLmludmFsaWRcIikpJykpIGFzIHN0cmluZztcbiAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyMikgPT4gc2V0VGltZW91dChyMiwgNDAwKSk7XG4gICAgICBjb25zdCBhZnRlciA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmxlbmd0aDtcbiAgICAgIHJldHVybiBbciA9PT0gJ251bGwnICYmIGFmdGVyID09PSBiZWZvcmUsIGBvcGVuKCk9JHtyfSB3aW5kb3dzPSR7YmVmb3JlfVx1MjE5MiR7YWZ0ZXJ9YF07XG4gICAgfSk7XG4gICAgYXdhaXQgY2hlY2soJ0NTUCBcdTVCNThcdTU3MjgobWV0YSBcdTZDRThcdTUxNjVcdTYyMTZcdTU0Q0RcdTVFOTRcdTU5MzQpJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgbWV0YSA9IChhd2FpdCBqcygnQm9vbGVhbihkb2N1bWVudC5xdWVyeVNlbGVjdG9yKFwibWV0YVtodHRwLWVxdWl2PVxcJ0NvbnRlbnQtU2VjdXJpdHktUG9saWN5XFwnXVwiKSknKSkgYXMgYm9vbGVhbjtcbiAgICAgIGNvbnN0IGhlYWRlckNzcCA9IGlzRGV2ID8gJ2RldjogaGVhZGVyIENTUCBcdTc1MzEgb25IZWFkZXJzUmVjZWl2ZWQgXHU2Q0U4XHU1MTY1KFx1NEUwRFx1OTAwMlx1NzUyOCBtZXRhIFx1NjVBRFx1OEEwMCknIDogJ3Byb2QnO1xuICAgICAgcmV0dXJuIFttZXRhIHx8IGlzRGV2LCBgbWV0YT0ke21ldGF9ICR7aGVhZGVyQ3NwfWBdO1xuICAgIH0pO1xuICAgIGF3YWl0IGNoZWNrKCdicmlkZ2U6Z2V0LXN0YXRlIFx1NkI2M1x1NUUzOFx1OEZENFx1NTZERShob3N0IFx1Njg2NVx1NTNFRlx1NzUyOCknLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKCd3aW5kb3cuaG1oLmdldFN0YXRlKCkudGhlbihzID0+IEpTT04uc3RyaW5naWZ5KHMpKS5jYXRjaChlID0+IFwiRVJSOlwiK2UpJykpIGFzIHN0cmluZztcbiAgICAgIHJldHVybiBbci5zdGFydHNXaXRoKCd7JykgJiYgci5pbmNsdWRlcygnaG9zdFN0YXRlJyksIHIuc2xpY2UoMCwgODApXTtcbiAgICB9KTtcblxuICAgIGxldCBmYWlsZWQgPSAwO1xuICAgIGZvciAoY29uc3QgW25hbWUsIG9rLCBkZXRhaWxdIG9mIHJlc3VsdHMpIHtcbiAgICAgIGNvbnNvbGUubG9nKGBTRUNVUklUWS1URVNUICR7b2sgPyAnUEFTUycgOiAnRkFJTCd9IHwgJHtuYW1lfSB8ICR7cmVkYWN0KGRldGFpbCl9YCk7XG4gICAgICBpZiAoIW9rKSBmYWlsZWQgKz0gMTtcbiAgICB9XG4gICAgY29uc29sZS5sb2coYFNFQ1VSSVRZLVRFU1QgU1VNTUFSWSBwYXNzPSR7cmVzdWx0cy5sZW5ndGggLSBmYWlsZWR9LyR7cmVzdWx0cy5sZW5ndGh9YCk7XG4gICAgYXBwLmV4aXQoZmFpbGVkID09PSAwID8gMCA6IDEpO1xuICB9XG5cbiAgLy8gXHU5MDAwXHU1MUZBOlx1NEYxOFx1OTZDNVx1NTA1Q1x1NkI2Mlx1ODFFQVx1NURGMSBzcGF3biBcdTc2ODQgaG9zdChzaHV0ZG93biBcdTdBRUZcdTcwQjkgXHUyMTkyIFx1NTE1Q1x1NUU5NVx1NTNFQSBraWxsIFx1ODFFQVx1NURGMVx1NzY4NFx1NTNFNVx1NjdDNClcbiAgYXBwLm9uKCdiZWZvcmUtcXVpdCcsIChlKSA9PiB7XG4gICAgaWYgKHN1cGVydmlzb3IgIT09IG51bGwgJiYgc3VwZXJ2aXNvci5zdGF0ZSAhPT0gJ3N0b3BwZWQnKSB7XG4gICAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgICBzc2VBYm9ydD8uYWJvcnQoKTtcbiAgICAgIHZvaWQgc3VwZXJ2aXNvci5zdG9wKCkuZmluYWxseSgoKSA9PiBhcHAucXVpdCgpKTtcbiAgICB9XG4gIH0pO1xuICBhcHAub24oJ3dpbmRvdy1hbGwtY2xvc2VkJywgKCkgPT4ge1xuICAgIGlmIChwcm9jZXNzLnBsYXRmb3JtICE9PSAnZGFyd2luJykgYXBwLnF1aXQoKTtcbiAgfSk7XG59XG4iLCAiLyoqXG4gKiBEZXNrdG9wUnVudGltZVN1cGVydmlzb3IgXHUyMDE0IGhtaGFybmVzcyBob3N0IFx1OEZEQlx1N0EwQlx1NzY4NFx1NzUxRlx1NTQ3RFx1NTQ2OFx1NjcxRlx1NzJCNlx1NjAwMVx1NjczQShBRFItMDAzKVx1MzAwMlxuICpcbiAqIFx1NUI4OVx1NTE2OFx1NEUwRFx1NTNEOFx1OTFDRjpcbiAqICAtIFx1NTNFQVx1N0VEMVx1NUI5QS9cdTYzQTJcdTZENEIgMTI3LjAuMC4xO2hvc3QgXHU0RjdGXHU3NTI4XHU2NENEXHU0RjVDXHU3Q0ZCXHU3RURGXHU1MjA2XHU5MTREXHU3QUVGXHU1M0UzKHBvcnQgMCksXHU1QjlFXHU5NjQ1XHU3QUVGXHU1M0UzXG4gKiAgICBcdTc1MzEgaG9zdCBcdTc2ODQgc3Rkb3V0IFx1NUYxNVx1NUJGQ1x1ODg0Q1x1NTZERVx1NEYyMChIb3N0UmVhZHlMaW5lKVx1MzAwMlxuICogIC0gXHU5QUQ4XHU3MUI1IHRva2VuIFx1NTNFQVx1OTAxQVx1OEZDN1x1NUI1MFx1OEZEQlx1N0EwQlx1NzNBRlx1NTg4M1x1NTNEOFx1OTFDRlx1NEYyMFx1OTAxMixcdTdFRERcdTRFMERcdThGREIgVVJML1x1NjVFNVx1NUZENy9JUEMgXHU2NjBFXHU2NTg3XHU4RDFGXHU4RjdEXHUzMDAyXG4gKiAgLSBcdTUzRUFcdTUwNUNcdTZCNjJcdTY3MkMgc3VwZXJ2aXNvciBzcGF3biBcdTc2ODRcdThGREJcdTdBMEJcdTUzRTVcdTY3QzQ7XHU3RUREXHU0RTBEXHU2MzA5XHU4RkRCXHU3QTBCXHU1NDBEIGtpbGxcdTMwMDJcbiAqICAtIGhvc3QgY3Jhc2ggXHU1NDBFXHU2NzA5XHU5NjUwXHU5MUNEXHU1NDJGO1x1OTFDRFx1NTQyRlx1NEUwRFx1OTFDRFx1NjUzRVx1NEVGQlx1NEY1NVx1NzUyOFx1NjIzN1x1NTJBOFx1NEY1QyhcdTk3NUVcdTVFNDJcdTdCNDlcdTUyQThcdTRGNUNcdTc1MzFcdTc1MjhcdTYyMzdcdTc4NkVcdThCQTQpXHUzMDAyXG4gKi9cbmltcG9ydCB7IHNwYXduLCB0eXBlIENoaWxkUHJvY2VzcyB9IGZyb20gJ25vZGU6Y2hpbGRfcHJvY2Vzcyc7XG5pbXBvcnQgeyBjcmVhdGVJbnRlcmZhY2UgfSBmcm9tICdub2RlOnJlYWRsaW5lJztcbmltcG9ydCB7IHJhbmRvbUJ5dGVzIH0gZnJvbSAnbm9kZTpjcnlwdG8nO1xuaW1wb3J0IHsgZGVza3RvcEVycm9yLCBpc0Rlc2t0b3BFcnJvciwgdHlwZSBEZXNrdG9wRXJyb3IgfSBmcm9tICdAaG1oLWRlc2t0b3AvY29udHJhY3RzJztcblxuZXhwb3J0IHR5cGUgSG9zdFN0YXRlID1cbiAgfCAnc3RvcHBlZCdcbiAgfCAnc3RhcnRpbmcnXG4gIHwgJ3JlYWR5J1xuICB8ICdkaXNjb25uZWN0ZWQnXG4gIHwgJ3Jlc3RhcnRpbmcnXG4gIHwgJ3N0b3BwaW5nJ1xuICB8ICdmYWlsZWQnO1xuXG5leHBvcnQgaW50ZXJmYWNlIEhvc3RTcGVjIHtcbiAgLyoqIFx1NTNFRlx1NjI2N1x1ODg0Q1x1NjU4N1x1NEVGNihcdTkwMUFcdTVFMzggcHJvY2Vzcy5leGVjUGF0aClcdTMwMDIgKi9cbiAgY29tbWFuZDogc3RyaW5nO1xuICBhcmdzOiBzdHJpbmdbXTtcbiAgY3dkPzogc3RyaW5nO1xuICAvKiogXHU5ODlEXHU1OTE2XHU3M0FGXHU1ODgzXHU1M0Q4XHU5MUNGKFx1NEYxQVx1NEUwRSBwcm9jZXNzLmVudiBcdTU0MDhcdTVFNzYpXHUzMDAyICovXG4gIGVudj86IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3VwZXJ2aXNvck9wdGlvbnMge1xuICAvKiogXHU2NzFGXHU2NzFCIGhvc3QgXHU2ODIxXHU5QThDXHU3Njg0IGJlYXJlciB0b2tlbjtcdTRFMERcdTRGMjBcdTUyMTlcdTZCQ0ZcdTZCMjEgc3RhcnQgXHU3NTFGXHU2MjEwXHU5QUQ4XHU3MUI1XHU5NjhGXHU2NzNBXHU1MDNDXHUzMDAyICovXG4gIHRva2VuPzogc3RyaW5nO1xuICBtYXhSZXN0YXJ0cz86IG51bWJlcjtcbiAgc3RhcnRUaW1lb3V0TXM/OiBudW1iZXI7XG4gIGdyYWNlZnVsU2h1dGRvd25Ncz86IG51bWJlcjtcbiAgb25TdGF0ZUNoYW5nZT8oc3RhdGU6IEhvc3RTdGF0ZSwgaW5mbzogeyByZXN0YXJ0Q291bnQ6IG51bWJlcjsgbGFzdEVycm9yPzogc3RyaW5nIH0pOiB2b2lkO1xuICAvKiogXHU2QkNGXHU2QjIxIGhvc3QgXHU1QzMxXHU3RUVBKFx1NTQyQiBjcmFzaCBcdTgxRUFcdTYxMDhcdTU0MEVcdTc2ODRcdTkxQ0RcdTU0MkYpXHU5MEZEXHU0RjFBXHU4OUU2XHU1M0QxLFx1NjQzQVx1NUUyNlx1N0FFRlx1NzBCOShcdTU0MkIgdG9rZW4sXG4gICAqICBcdTRFQzVcdTRGOUJcdTU0MENcdTRGRTFcdTRFRkJcdTU3REZcdTc2ODRcdTVCQkZcdTRFM0JcdThGREJcdTdBMEJcdTkxQ0RcdTVFRkFcdTY4NjVcdTVCQTJcdTYyMzdcdTdBRUY7XHU0RTBEXHU4OTgxXHU4REU4XHU4RkRCIHJlbmRlcmVyKVx1MzAwMiAqL1xuICBvblJlYWR5PyhlbmRwb2ludDogSG9zdEVuZHBvaW50KTogdm9pZDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBIb3N0RW5kcG9pbnQge1xuICBwb3J0OiBudW1iZXI7XG4gIHZlcnNpb246IHN0cmluZztcbiAgdG9rZW46IHN0cmluZztcbn1cblxuLyoqIEhvc3RSZWFkeUxpbmUgXHU3Njg0XHU3QzdCXHU1NzhCXHU1Qjg4XHU1MzZCXHU0RUNFIGNvbnRyYWN0cyBcdTVGMTVcdTUxNjUsXHU5MDdGXHU1MTREXHU1M0NDXHU1QjlFXHU3M0IwXHUzMDAyICovXG5pbXBvcnQgeyBpc0hvc3RSZWFkeUxpbmUgfSBmcm9tICdAaG1oLWRlc2t0b3AvY29udHJhY3RzJztcblxuY29uc3QgREVGQVVMVF9TVEFSVF9USU1FT1VUX01TID0gMjBfMDAwO1xuY29uc3QgREVGQVVMVF9NQVhfUkVTVEFSVFMgPSAzO1xuY29uc3QgREVGQVVMVF9HUkFDRUZVTF9NUyA9IDVfMDAwO1xuXG5leHBvcnQgY2xhc3MgRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yIHtcbiAgcHJpdmF0ZSBjaGlsZDogQ2hpbGRQcm9jZXNzIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgX3N0YXRlOiBIb3N0U3RhdGUgPSAnc3RvcHBlZCc7XG4gIHByaXZhdGUgcmVzdGFydENvdW50ID0gMDtcbiAgcHJpdmF0ZSBsYXN0RXJyb3IgPSAnJztcbiAgcHJpdmF0ZSBzdG9wcGluZyA9IGZhbHNlO1xuICBwcml2YXRlIHJlYWRvbmx5IHRva2VuOiBzdHJpbmc7XG4gIHByaXZhdGUgcmVhZG9ubHkgb3B0czogUmVxdWlyZWQ8UGljazxTdXBlcnZpc29yT3B0aW9ucywgJ21heFJlc3RhcnRzJyB8ICdzdGFydFRpbWVvdXRNcycgfCAnZ3JhY2VmdWxTaHV0ZG93bk1zJz4+ICYgU3VwZXJ2aXNvck9wdGlvbnM7XG4gIHByaXZhdGUgZXhpdFdhaXRlcnM6IEFycmF5PCgpID0+IHZvaWQ+ID0gW107XG5cbiAgY29uc3RydWN0b3IoXG4gICAgcHJpdmF0ZSByZWFkb25seSBzcGVjOiBIb3N0U3BlYyxcbiAgICBvcHRzOiBTdXBlcnZpc29yT3B0aW9ucyA9IHt9LFxuICApIHtcbiAgICB0aGlzLnRva2VuID0gb3B0cy50b2tlbiA/PyByYW5kb21CeXRlcygzMikudG9TdHJpbmcoJ2Jhc2U2NHVybCcpO1xuICAgIHRoaXMub3B0cyA9IHtcbiAgICAgIG1heFJlc3RhcnRzOiBvcHRzLm1heFJlc3RhcnRzID8/IERFRkFVTFRfTUFYX1JFU1RBUlRTLFxuICAgICAgc3RhcnRUaW1lb3V0TXM6IG9wdHMuc3RhcnRUaW1lb3V0TXMgPz8gREVGQVVMVF9TVEFSVF9USU1FT1VUX01TLFxuICAgICAgZ3JhY2VmdWxTaHV0ZG93bk1zOiBvcHRzLmdyYWNlZnVsU2h1dGRvd25NcyA/PyBERUZBVUxUX0dSQUNFRlVMX01TLFxuICAgICAgLi4ub3B0cyxcbiAgICB9O1xuICB9XG5cbiAgZ2V0IHN0YXRlKCk6IEhvc3RTdGF0ZSB7XG4gICAgcmV0dXJuIHRoaXMuX3N0YXRlO1xuICB9XG5cbiAgZ2V0IHJlc3RhcnRzVXNlZCgpOiBudW1iZXIge1xuICAgIHJldHVybiB0aGlzLnJlc3RhcnRDb3VudDtcbiAgfVxuXG4gIHByaXZhdGUgc2V0U3RhdGUoczogSG9zdFN0YXRlLCBlcnI/OiBzdHJpbmcpOiB2b2lkIHtcbiAgICB0aGlzLl9zdGF0ZSA9IHM7XG4gICAgaWYgKGVyciAhPT0gdW5kZWZpbmVkKSB0aGlzLmxhc3RFcnJvciA9IGVycjtcbiAgICBjb25zdCBpbmZvOiB7IHJlc3RhcnRDb3VudDogbnVtYmVyOyBsYXN0RXJyb3I/OiBzdHJpbmcgfSA9IHsgcmVzdGFydENvdW50OiB0aGlzLnJlc3RhcnRDb3VudCB9O1xuICAgIGlmICh0aGlzLmxhc3RFcnJvciAhPT0gJycpIGluZm8ubGFzdEVycm9yID0gdGhpcy5sYXN0RXJyb3I7XG4gICAgdGhpcy5vcHRzLm9uU3RhdGVDaGFuZ2U/LihzLCBpbmZvKTtcbiAgfVxuXG4gIC8qKiBcdTU0MkZcdTUyQTggaG9zdCBcdTVFNzZcdTdCNDlcdTVGODUgcmVhZHkoXHU1RjE1XHU1QkZDXHU4ODRDICsgXHU1RTI2IHRva2VuIFx1NzY4NFx1NTA2NVx1NUVCN1x1NjNBMlx1NkQ0QilcdTMwMDIgKi9cbiAgYXN5bmMgc3RhcnQoKTogUHJvbWlzZTxIb3N0RW5kcG9pbnQ+IHtcbiAgICBpZiAodGhpcy5fc3RhdGUgPT09ICdyZWFkeScgfHwgdGhpcy5fc3RhdGUgPT09ICdzdGFydGluZycpIHtcbiAgICAgIHRocm93IGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgc3VwZXJ2aXNvciBhbHJlYWR5ICR7dGhpcy5fc3RhdGV9YCk7XG4gICAgfVxuICAgIHRoaXMucmVzdGFydENvdW50ID0gMDtcbiAgICB0aGlzLnN0b3BwaW5nID0gZmFsc2U7XG4gICAgcmV0dXJuIHRoaXMubGF1bmNoKCk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGxhdW5jaCgpOiBQcm9taXNlPEhvc3RFbmRwb2ludD4ge1xuICAgIHRoaXMuc2V0U3RhdGUoJ3N0YXJ0aW5nJyk7XG4gICAgY29uc3QgY2hpbGQgPSBzcGF3bih0aGlzLnNwZWMuY29tbWFuZCwgdGhpcy5zcGVjLmFyZ3MsIHtcbiAgICAgIGN3ZDogdGhpcy5zcGVjLmN3ZCxcbiAgICAgIGVudjoge1xuICAgICAgICAuLi5wcm9jZXNzLmVudixcbiAgICAgICAgLi4udGhpcy5zcGVjLmVudixcbiAgICAgICAgSE1IX0RFU0tUT1BfVE9LRU46IHRoaXMudG9rZW4sXG4gICAgICB9LFxuICAgICAgc3RkaW86IFsnaWdub3JlJywgJ3BpcGUnLCAncGlwZSddLFxuICAgICAgd2luZG93c0hpZGU6IHRydWUsXG4gICAgfSk7XG4gICAgdGhpcy5jaGlsZCA9IGNoaWxkO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGVuZHBvaW50ID0gYXdhaXQgdGhpcy5hd2FpdFJlYWR5KGNoaWxkKTtcbiAgICAgIHRoaXMuY3VycmVudEVuZHBvaW50ID0geyBwb3J0OiBlbmRwb2ludC5wb3J0LCB2ZXJzaW9uOiBlbmRwb2ludC52ZXJzaW9uIH07XG4gICAgICB0aGlzLnNldFN0YXRlKCdyZWFkeScpO1xuICAgICAgdGhpcy5vcHRzLm9uUmVhZHk/LihlbmRwb2ludCk7XG4gICAgICAvLyByZWFkeSBcdTRFNEJcdTU0MEVcdThGREJcdTdBMEJcdTZCN0JcdTRFQTEgPSBcdTYxMEZcdTU5MTZcdTkwMDBcdTUxRkEgXHUyMTkyIFx1NjcwOVx1OTY1MFx1OTFDRFx1NTQyRlxuICAgICAgY2hpbGQub25jZSgnZXhpdCcsICgpID0+IHtcbiAgICAgICAgdGhpcy5leGl0V2FpdGVycy5mb3JFYWNoKCh3KSA9PiB3KCkpO1xuICAgICAgICB0aGlzLmV4aXRXYWl0ZXJzID0gW107XG4gICAgICAgIHRoaXMub25VbmV4cGVjdGVkRXhpdCgpO1xuICAgICAgfSk7XG4gICAgICByZXR1cm4gZW5kcG9pbnQ7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBpZiAoIWNoaWxkLmtpbGxlZCkgY2hpbGQua2lsbCgpO1xuICAgICAgaWYgKHRoaXMuY2hpbGQgPT09IGNoaWxkKSB0aGlzLmNoaWxkID0gbnVsbDtcbiAgICAgIHRocm93IGVycjtcbiAgICB9XG4gIH1cblxuICAvKiogXHU0RUNFIHN0ZG91dCBcdTYyN0UgSG9zdFJlYWR5TGluZSxcdTcxMzZcdTU0MEVcdTUwNjVcdTVFQjdcdTYzQTJcdTZENEJcdTMwMDIgKi9cbiAgcHJpdmF0ZSBhd2FpdFJlYWR5KGNoaWxkOiBDaGlsZFByb2Nlc3MpOiBQcm9taXNlPEhvc3RFbmRwb2ludD4ge1xuICAgIHJldHVybiBuZXcgUHJvbWlzZTxIb3N0RW5kcG9pbnQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgIHJlamVjdChkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYGhvc3QgZGlkIG5vdCBzaWduYWwgcmVhZHkgd2l0aGluICR7dGhpcy5vcHRzLnN0YXJ0VGltZW91dE1zfW1zYCwgeyByZXRyeWFibGU6IHRydWUsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XG4gICAgICB9LCB0aGlzLm9wdHMuc3RhcnRUaW1lb3V0TXMpO1xuXG4gICAgICBjb25zdCBkb25lID0gKGZuOiAoKSA9PiB2b2lkKTogdm9pZCA9PiB7XG4gICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgIGZuKCk7XG4gICAgICB9O1xuXG4gICAgICBpZiAoIWNoaWxkLnN0ZG91dCkge1xuICAgICAgICBkb25lKCgpID0+IHJlamVjdChkZXNrdG9wRXJyb3IoJ1JVTlRJTUVfQ1JBU0hFRCcsICdob3N0IHNwYXduZWQgd2l0aG91dCBzdGRvdXQgcGlwZScpKSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgY29uc3QgcmwgPSBjcmVhdGVJbnRlcmZhY2UoeyBpbnB1dDogY2hpbGQuc3Rkb3V0IH0pO1xuICAgICAgY29uc3Qgb25MaW5lID0gKGxpbmU6IHN0cmluZyk6IHZvaWQgPT4ge1xuICAgICAgICBsZXQgcGFyc2VkOiB1bmtub3duO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHBhcnNlZCA9IEpTT04ucGFyc2UobGluZSk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIHJldHVybjsgLy8gaG9zdCBcdTc2ODRcdTY2NkVcdTkwMUFcdTY1RTVcdTVGRDdcdTg4NEMsXHU1RkZEXHU3NTY1XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGlzSG9zdFJlYWR5TGluZShwYXJzZWQpKSB7XG4gICAgICAgICAgcmwuY2xvc2UoKTtcbiAgICAgICAgICB2b2lkIHRoaXMucHJvYmVBbmRSZW1lbWJlcihwYXJzZWQucG9ydCwgcGFyc2VkLnZlcnNpb24pXG4gICAgICAgICAgICAudGhlbigoZW5kcG9pbnQpID0+IGRvbmUoKCkgPT4gcmVzb2x2ZShlbmRwb2ludCkpKVxuICAgICAgICAgICAgLmNhdGNoKChlcnI6IHVua25vd24pID0+IGRvbmUoKCkgPT4gcmVqZWN0KGVycikpKTtcbiAgICAgICAgfVxuICAgICAgfTtcbiAgICAgIHJsLm9uKCdsaW5lJywgb25MaW5lKTtcblxuICAgICAgY2hpbGQub25jZSgnZXhpdCcsIChjb2RlKSA9PiB7XG4gICAgICAgIGRvbmUoKCkgPT4gcmVqZWN0KGRlc2t0b3BFcnJvcignUlVOVElNRV9DUkFTSEVEJywgYGhvc3QgZXhpdGVkIGR1cmluZyBzdGFydHVwIChjb2RlICR7Y29kZSA/PyAnbnVsbCd9KWAsIHsgcmV0cnlhYmxlOiBmYWxzZSwgcmVjb3ZlcnlBY3Rpb246ICdPUEVOX0xPR1MnIH0pKSk7XG4gICAgICB9KTtcbiAgICB9KTtcbiAgfVxuXG4gIC8qKiBcdTVFMjYgdG9rZW4gXHU3Njg0XHU1MDY1XHU1RUI3XHU2M0EyXHU2RDRCOkdFVCAvYXBpL3N0YXRlXHUzMDAyNDAxIFx1MjE5MiBBVVRIX0ZBSUxFRChcdTRFMERcdTkxQ0RcdThCRDUpXHUzMDAyICovXG4gIHByaXZhdGUgYXN5bmMgcHJvYmUocG9ydDogbnVtYmVyLCB2ZXJzaW9uOiBzdHJpbmcpOiBQcm9taXNlPEhvc3RFbmRwb2ludD4ge1xuICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgIHRyeSB7XG4gICAgICByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2FwaS9zdGF0ZWAsIHtcbiAgICAgICAgaGVhZGVyczogeyAneC1obWgta2V5JzogdGhpcy50b2tlbiB9LFxuICAgICAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoM18wMDApLFxuICAgICAgfSk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICB0aHJvdyBkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYGhlYWx0aCBwcm9iZSBmYWlsZWQ6ICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTYwKX1gLCB7IHJldHJ5YWJsZTogdHJ1ZSB9KTtcbiAgICB9XG4gICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSB8fCByZXMuc3RhdHVzID09PSA0MDMpIHtcbiAgICAgIHRocm93IGRlc2t0b3BFcnJvcignQVVUSF9GQUlMRUQnLCBgaG9zdCByZWplY3RlZCB0aGUgc2Vzc2lvbiB0b2tlbiAoSFRUUCAke3Jlcy5zdGF0dXN9KWAsIHsgcmV0cnlhYmxlOiBmYWxzZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pO1xuICAgIH1cbiAgICBpZiAoIXJlcy5vaykge1xuICAgICAgdGhyb3cgZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBoZWFsdGggcHJvYmUgSFRUUCAke3Jlcy5zdGF0dXN9YCwgeyByZXRyeWFibGU6IHRydWUgfSk7XG4gICAgfVxuICAgIHJldHVybiB7IHBvcnQsIHZlcnNpb24sIHRva2VuOiB0aGlzLnRva2VuIH07XG4gIH1cblxuICBwcml2YXRlIG9uVW5leHBlY3RlZEV4aXQoKTogdm9pZCB7XG4gICAgaWYgKHRoaXMuc3RvcHBpbmcgfHwgdGhpcy5fc3RhdGUgPT09ICdzdG9wcGVkJyB8fCB0aGlzLl9zdGF0ZSA9PT0gJ3N0b3BwaW5nJykgcmV0dXJuO1xuICAgIHRoaXMuY2hpbGQgPSBudWxsO1xuICAgIGlmICh0aGlzLnJlc3RhcnRDb3VudCA8IHRoaXMub3B0cy5tYXhSZXN0YXJ0cykge1xuICAgICAgdGhpcy5yZXN0YXJ0Q291bnQgKz0gMTtcbiAgICAgIHRoaXMuc2V0U3RhdGUoJ3Jlc3RhcnRpbmcnKTtcbiAgICAgIHZvaWQgdGhpcy5sYXVuY2goKS5jYXRjaCgoKSA9PiB7XG4gICAgICAgIC8vIFx1OTFDRFx1NTQyRlx1NUMxRFx1OEJENVx1NTkzMVx1OEQyNShcdTU0MkZcdTUyQThcdTUzNzNcdTVEMjkvXHU4RDg1XHU2NUY2L1x1NjJEMlx1OEJBNCk6XHU3RUU3XHU3RUVEXHU2RDg4XHU4MDE3XHU5MUNEXHU1NDJGXHU2QjIxXHU2NTcwXHU3NkY0XHU1MjMwXHU2NTNFXHU1RjAzXG4gICAgICAgIHRoaXMucmV0cnlPckZhaWwoKTtcbiAgICAgIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLnNldFN0YXRlKCdmYWlsZWQnLCBgaG9zdCBleGl0ZWQgdW5leHBlY3RlZGx5ICR7dGhpcy5yZXN0YXJ0Q291bnQgKyAxfSB0aW1lczsgZ2l2aW5nIHVwYCk7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSByZXRyeU9yRmFpbCgpOiB2b2lkIHtcbiAgICBpZiAodGhpcy5zdG9wcGluZyB8fCB0aGlzLl9zdGF0ZSA9PT0gJ3N0b3BwZWQnIHx8IHRoaXMuX3N0YXRlID09PSAnc3RvcHBpbmcnKSByZXR1cm47XG4gICAgaWYgKHRoaXMucmVzdGFydENvdW50IDwgdGhpcy5vcHRzLm1heFJlc3RhcnRzKSB7XG4gICAgICB0aGlzLnJlc3RhcnRDb3VudCArPSAxO1xuICAgICAgdGhpcy5zZXRTdGF0ZSgncmVzdGFydGluZycpO1xuICAgICAgdm9pZCB0aGlzLmxhdW5jaCgpLmNhdGNoKCgpID0+IHRoaXMucmV0cnlPckZhaWwoKSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMuc2V0U3RhdGUoJ2ZhaWxlZCcsIGBob3N0IGZhaWxlZCB0byBzdGF5IHVwIGFmdGVyICR7dGhpcy5yZXN0YXJ0Q291bnR9IHJlc3RhcnQgYXR0ZW1wdHNgKTtcbiAgICB9XG4gIH1cblxuICAvKiogXHU0RjE4XHU5NkM1XHU1MDVDXHU2QjYyOlx1NTE0OCBIVFRQIHNodXRkb3duLFx1OEQ4NVx1NjVGNlx1NjI0RFx1NUJGOVx1NjcyQ1x1OEZEQlx1N0EwQlx1NTNFNVx1NjdDNCBraWxsXHUzMDAyICovXG4gIGFzeW5jIHN0b3AoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgdGhpcy5zdG9wcGluZyA9IHRydWU7XG4gICAgaWYgKHRoaXMuX3N0YXRlID09PSAnc3RvcHBlZCcpIHJldHVybjtcbiAgICB0aGlzLnNldFN0YXRlKCdzdG9wcGluZycpO1xuICAgIGNvbnN0IGNoaWxkID0gdGhpcy5jaGlsZDtcbiAgICB0aGlzLmNoaWxkID0gbnVsbDtcbiAgICB0aGlzLmN1cnJlbnRFbmRwb2ludCA9IG51bGw7XG4gICAgaWYgKCFjaGlsZCkge1xuICAgICAgdGhpcy5zZXRTdGF0ZSgnc3RvcHBlZCcpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBleGl0ZWQgPSBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4ge1xuICAgICAgaWYgKGNoaWxkLmV4aXRDb2RlICE9PSBudWxsIHx8IGNoaWxkLnNpZ25hbENvZGUgIT09IG51bGwpIHJlc29sdmUoKTtcbiAgICAgIGVsc2Uge1xuICAgICAgICBjb25zdCB3ID0gKCk6IHZvaWQgPT4gcmVzb2x2ZSgpO1xuICAgICAgICB0aGlzLmV4aXRXYWl0ZXJzLnB1c2godyk7XG4gICAgICAgIGNoaWxkLm9uY2UoJ2V4aXQnLCB3KTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICAvLyBcdTVERjJcdTc3RTVcdTdBRUZcdTUzRTNcdTYyNERcdTVDMURcdThCRDUgSFRUUCBcdTRGMThcdTk2QzVcdTUxNzNcdTk1RUQ7XHU2NzJBXHU3N0U1XHU3QUVGXHU1M0UzXHU3NkY0XHU2M0E1XHU4RDcwIGtpbGwgXHU1MTVDXHU1RTk1XG4gICAgaWYgKHRoaXMubGFzdEVuZHBvaW50ICE9PSBudWxsKSB7XG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3RoaXMubGFzdEVuZHBvaW50fS9hcGkvZGVza3RvcC9zaHV0ZG93bmAsIHtcbiAgICAgICAgICBtZXRob2Q6ICdQT1NUJyxcbiAgICAgICAgICBoZWFkZXJzOiB7ICd4LWhtaC1rZXknOiB0aGlzLnRva2VuIH0sXG4gICAgICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDFfMDAwKSxcbiAgICAgICAgfSk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLy8gaG9zdCBcdTVERjJcdTZCN0JcdTYyMTZcdTRFMERcdTVFOTRcdTdCNTQ6XHU4RDcwIGtpbGwgXHU1MTVDXHU1RTk1XG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IGdyYWNlZnVsID0gYXdhaXQgUHJvbWlzZS5yYWNlKFtcbiAgICAgIGV4aXRlZC50aGVuKCgpID0+IHRydWUpLFxuICAgICAgbmV3IFByb21pc2U8Ym9vbGVhbj4oKHJlc29sdmUpID0+IHNldFRpbWVvdXQoKCkgPT4gcmVzb2x2ZShmYWxzZSksIHRoaXMub3B0cy5ncmFjZWZ1bFNodXRkb3duTXMpKSxcbiAgICBdKTtcbiAgICBpZiAoIWdyYWNlZnVsICYmIGNoaWxkLmV4aXRDb2RlID09PSBudWxsICYmIGNoaWxkLnNpZ25hbENvZGUgPT09IG51bGwpIHtcbiAgICAgIGNoaWxkLmtpbGwoKTsgLy8gXHU1M0VBXHU2NzQwXHU4MUVBXHU1REYxXHU2MzAxXHU2NzA5XHU3Njg0XHU1M0U1XHU2N0M0LFx1N0VERFx1NEUwRFx1NjMwOVx1OEZEQlx1N0EwQlx1NTQwRFxuICAgIH1cbiAgICBhd2FpdCBleGl0ZWQuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcbiAgICB0aGlzLnNldFN0YXRlKCdzdG9wcGVkJyk7XG4gIH1cblxuICBwcml2YXRlIGxhc3RFbmRwb2ludDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgY3VycmVudEVuZHBvaW50OiB7IHBvcnQ6IG51bWJlcjsgdmVyc2lvbjogc3RyaW5nIH0gfCBudWxsID0gbnVsbDtcblxuICAvKiogXHU1RjUzXHU1MjREIGhvc3QgXHU3QUVGXHU3MEI5KHJlYWR5IFx1NTQwRVx1NjcwOVx1NTAzQztcdTRFMERcdTU0MkIgdG9rZW4pXHUzMDAyICovXG4gIGdldCBlbmRwb2ludCgpOiB7IHBvcnQ6IG51bWJlcjsgdmVyc2lvbjogc3RyaW5nIH0gfCBudWxsIHtcbiAgICByZXR1cm4gdGhpcy5jdXJyZW50RW5kcG9pbnQ7XG4gIH1cblxuICAvKiogXHU2M0EyXHU2RDRCXHU2MjEwXHU1MjlGXHU1NDBFXHU4QkIwXHU0RjRGXHU3QUVGXHU1M0UzLFx1NEY5QiBzdG9wKCkgXHU3Njg0XHU0RjE4XHU5NkM1XHU1MTczXHU5NUVEXHU0RjdGXHU3NTI4XHUzMDAyICovXG4gIHByaXZhdGUgYXN5bmMgcHJvYmVBbmRSZW1lbWJlcihwb3J0OiBudW1iZXIsIHZlcnNpb246IHN0cmluZyk6IFByb21pc2U8SG9zdEVuZHBvaW50PiB7XG4gICAgY29uc3QgZXAgPSBhd2FpdCB0aGlzLnByb2JlKHBvcnQsIHZlcnNpb24pO1xuICAgIHRoaXMubGFzdEVuZHBvaW50ID0gZXAucG9ydDtcbiAgICByZXR1cm4gZXA7XG4gIH1cbn1cblxuLyoqIFx1NjI4QVx1NjcyQVx1NzdFNVx1OTUxOVx1OEJFRlx1ODlDNFx1N0VBNlx1NEUzQSBEZXNrdG9wRXJyb3IoXHU1REYyXHU2NjJGXHU1MjE5XHU1MzlGXHU2ODM3XHU4RkQ0XHU1NkRFKVx1MzAwMiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRvRGVza3RvcEVycm9yKGVycjogdW5rbm93bik6IERlc2t0b3BFcnJvciB7XG4gIGlmIChpc0Rlc2t0b3BFcnJvcihlcnIpKSByZXR1cm4gZXJyO1xuICBjb25zdCBtZXNzYWdlID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICByZXR1cm4gZGVza3RvcEVycm9yKCdSVU5USU1FX0NSQVNIRUQnLCBtZXNzYWdlLnNsaWNlKDAsIDMwMCksIHsgcmV0cnlhYmxlOiBmYWxzZSB9KTtcbn1cbiIsICIvKipcbiAqIEBobWgtZGVza3RvcC9jb250cmFjdHMgXHUyMDE0IFx1NEU4Qlx1NEVGNlx1NEZFMVx1NUMwMShcdTVGMDBcdTUzRDFcdThCQTFcdTUyMTJcdTY1ODdcdTY4NjMgMDQgXHUwMEE3XHU0RTA5KVxuICpcbiAqIFx1NEUwMFx1Njc2MSBVSSBcdTRFOEJcdTRFRjZcdTc2ODRcdTU1MkZcdTRFMDBcdTVGNjJcdTcyQjZcdTMwMDJcdTUyNERcdTdBRUYgcmVkdWNlciBcdTVGQzVcdTk4N0JcdTYzMDkgc2Vzc2lvbklkL3J1bklkL3NlcSBcdTU5MDRcdTc0MDY7XG4gKiBcdTkxQ0RcdTU5MEQgZXZlbnRJZCBcdTVFNDJcdTdCNDlcdTRFMjJcdTVGMDM7c2VxIFx1N0YzQVx1NTNFM1x1ODlFNlx1NTNEMVx1ODg2NVx1NjJDOTtcdTk3NUVcdTVFNDJcdTdCNDlcdTUyQThcdTRGNUNcdTRFMERcdTc1MzEgU1NFIFx1ODFFQVx1NTJBOFx1OTFDRFx1NTNEMVx1MzAwMlxuICovXG5cbmltcG9ydCB0eXBlIHsgQXJ0aWZhY3RSZWYgfSBmcm9tICcuL2R0by50cyc7XG5pbXBvcnQgdHlwZSB7IERlc2t0b3BFcnJvciB9IGZyb20gJy4vZXJyb3IudHMnO1xuXG4vKiogXHU0RThCXHU0RUY2XHU3OUNEXHU3QzdCKFx1NTIyNFx1NTIyQlx1OTUyRSlcdTMwMDJcdTY1QjBcdTU4OUUga2luZCA9IHNjaGVtYVZlcnNpb24gXHU1MzQ3XHU3RUE3LFx1NEUwRFx1NTE0MVx1OEJCOFx1OTc1OVx1OUVEOFx1NjI2OVx1Njc5QVx1NEUzRVx1MzAwMiAqL1xuZXhwb3J0IGNvbnN0IEVWRU5UX0tJTkRTID0gW1xuICAncnVuLnN0YXJ0ZWQnLFxuICAncGxhbi51cGRhdGVkJyxcbiAgJ3Rvb2wuc3RhcnRlZCcsXG4gICd0b29sLmNvbXBsZXRlZCcsXG4gICdhcHByb3ZhbC5yZXF1aXJlZCcsXG4gICd2ZXJpZmljYXRpb24udXBkYXRlZCcsXG4gICdhcnRpZmFjdC5jcmVhdGVkJyxcbiAgJ3J1bi5jb21wbGV0ZWQnLFxuICAncnVuLmZhaWxlZCcsXG5dIGFzIGNvbnN0O1xuXG5leHBvcnQgdHlwZSBFdmVudEtpbmQgPSAodHlwZW9mIEVWRU5UX0tJTkRTKVtudW1iZXJdO1xuXG5leHBvcnQgY29uc3QgRVZFTlRfU0NIRU1BX1ZFUlNJT04gPSAxO1xuZXhwb3J0IHR5cGUgRXZlbnRTY2hlbWFWZXJzaW9uID0gMTtcblxuLyoqIFNTRSBcdTZENDFcdTRFMEFcdTc2ODRcdTZCQ0ZcdTRFMDBcdTY3NjFcdTRFOEJcdTRFRjZcdTMwMDIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgRXZlbnRFbnZlbG9wZTxUID0gdW5rbm93bj4ge1xuICBzY2hlbWFWZXJzaW9uOiBFdmVudFNjaGVtYVZlcnNpb247XG4gIC8qKiBcdTUxNjhcdTVDNDBcdTU1MkZcdTRFMDA7XHU5MUNEXHU4RkRFL1x1ODg2NVx1NjJDOVx1NTQwRVx1OTFDRFx1NTkwRFx1NTFGQVx1NzNCMFx1NjVGNlx1NjNBNVx1NjUzNlx1NjVCOVx1NUU0Mlx1N0I0OVx1NEUyMlx1NUYwM1x1MzAwMiAqL1xuICBldmVudElkOiBzdHJpbmc7XG4gIHNlc3Npb25JZDogc3RyaW5nO1xuICBydW5JZDogc3RyaW5nO1xuICAvKiogXHU0RjFBXHU4QkREXHU1MTg1XHU1MzU1XHU4QzAzXHU5MDEyXHU1ODlFO1x1N0YzQVx1NTNFM1x1NjEwRlx1NTQ3M1x1Nzc0MFx1NEUyMlx1NEU4Qlx1NEVGNixcdTk3MDBcdTg5ODFcdTg4NjVcdTYyQzlcdTMwMDIgKi9cbiAgc2VxOiBudW1iZXI7XG4gIC8qKiBSRkMzMzM5XHUzMDAyICovXG4gIG9jY3VycmVkQXQ6IHN0cmluZztcbiAga2luZDogRXZlbnRLaW5kO1xuICBwYXlsb2FkOiBUO1xufVxuXG4vKiogcnVuLnN0YXJ0ZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgUnVuU3RhcnRlZFBheWxvYWQge1xuICB0YXNrOiBzdHJpbmc7XG4gIG1vZGU6ICdhc2snIHwgJ2F1dG8nIHwgJ3lvbG8nO1xufVxuXG4vKiogcGxhbi51cGRhdGVkIFx1NzY4NCBwYXlsb2FkKFx1OEJBMVx1NTIxMlx1NkI2NVx1OUFBNFx1NTIxN1x1ODg2OCxcdTY3NjVcdTgxRUEgcnVudGltZSBcdTc2ODRcdTdFRDNcdTY3ODRcdTUzMTZcdThCQTFcdTUyMTIsXHU0RTBEXHU2NjJGIGNoYWluLW9mLXRob3VnaHQpXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIFBsYW5VcGRhdGVkUGF5bG9hZCB7XG4gIHN0ZXBzOiBBcnJheTx7IHRpdGxlOiBzdHJpbmc7IHN0YXR1czogJ3BlbmRpbmcnIHwgJ2FjdGl2ZScgfCAnZG9uZScgfCAnZmFpbGVkJyB9Pjtcbn1cblxuLyoqIHRvb2wuc3RhcnRlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBUb29sU3RhcnRlZFBheWxvYWQge1xuICBuYW1lOiBzdHJpbmc7XG4gIC8qKiBcdTUzQzJcdTY1NzBcdTRFRTVcdTY1ODdcdTY3MkNcdTU0NDhcdTczQjAsXHU2RTMyXHU2N0QzXHU3QUVGXHU2QzM4XHU0RTBEIGV2YWw7XHU1OTI3XHU1QkY5XHU4QzYxXHU3NTMxIHJ1bnRpbWUgXHU2MjJBXHU2NUFEXHUzMDAyICovXG4gIGFyZ3NQcmV2aWV3OiBzdHJpbmc7XG59XG5cbi8qKiB0b29sLmNvbXBsZXRlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBUb29sQ29tcGxldGVkUGF5bG9hZCB7XG4gIG5hbWU6IHN0cmluZztcbiAgaXNFcnJvcjogYm9vbGVhbjtcbiAgb3V0cHV0UHJldmlldzogc3RyaW5nO1xufVxuXG4vKiogYXBwcm92YWwucmVxdWlyZWQgXHU3Njg0IHBheWxvYWRcdTMwMDJcdTVCQTFcdTYyNzlcdTY3NDNcdTVBMDFcdTU3MjggcnVudGltZSBcdTU0MEVcdTdBRUY7VUkgXHU1M0VBXHU2NjJGXHU4RjZDXHU4RkYwXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcHJvdmFsUmVxdWlyZWRQYXlsb2FkIHtcbiAgYXBwcm92YWxJZDogc3RyaW5nO1xuICB0b29sOiBzdHJpbmc7XG4gIGFyZ3NQcmV2aWV3OiBzdHJpbmc7XG4gIC8qKiBcdTVGNzFcdTU0Q0RcdTgzMDNcdTU2RjQvXHU5OENFXHU5NjY5XHU3Njg0XHU0RUJBXHU3QzdCXHU1M0VGXHU4QkZCXHU4QkY0XHU2NjBFLFx1NzUzMSBydW50aW1lIFx1NzUxRlx1NjIxMFx1MzAwMiAqL1xuICByaXNrOiBzdHJpbmc7XG59XG5cbi8qKiB2ZXJpZmljYXRpb24udXBkYXRlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBWZXJpZmljYXRpb25VcGRhdGVkUGF5bG9hZCB7XG4gIHN1bW1hcnk6IHN0cmluZztcbiAgcGFzc2VkOiBib29sZWFuIHwgbnVsbDsgLy8gbnVsbCA9IFx1NjcyQVx1NzdFNS9cdThGREJcdTg4NENcdTRFMkQoTkVFRFMtREFUQSBcdTY1RjZcdTRFMERcdTUwNDdcdTU4NkIpXG59XG5cbi8qKiBhcnRpZmFjdC5jcmVhdGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIEFydGlmYWN0Q3JlYXRlZFBheWxvYWQge1xuICBhcnRpZmFjdDogQXJ0aWZhY3RSZWY7XG59XG5cbi8qKiBydW4uY29tcGxldGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIFJ1bkNvbXBsZXRlZFBheWxvYWQge1xuICB0ZXh0OiBzdHJpbmc7XG4gIHR1cm5zOiBudW1iZXI7XG4gIHRvb2xVc2VzOiBudW1iZXI7XG4gIHVzYWdlPzogeyBwcm9tcHRUb2tlbnM6IG51bWJlcjsgY29tcGxldGlvblRva2VuczogbnVtYmVyIH07XG59XG5cbi8qKiBydW4uZmFpbGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIFJ1bkZhaWxlZFBheWxvYWQge1xuICBlcnJvcjogRGVza3RvcEVycm9yO1xufVxuIiwgIi8qKlxuICogQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyBcdTIwMTQgXHU3RUQzXHU2Nzg0XHU1MzE2XHU2ODRDXHU5NzYyXHU5NTE5XHU4QkVGKFx1NUYwMFx1NTNEMVx1OEJBMVx1NTIxMlx1NjU4N1x1Njg2MyAwNCBcdTAwQTdcdTRFMDkpXHUzMDAyXG4gKlxuICogaG9zdC1ub3QtcmVhZHkgLyBhdXRoLWZhaWxlZCAvIHN0YWxlLXZlcnNpb24gLyBydW50aW1lLWNyYXNoZWQgL1xuICogcG9ydC1iaW5kLWZhaWxlZCAvIHNjaGVtYS1taXNtYXRjaCBcdTVGQzVcdTk4N0JcdTY2MkZcdTdFRDNcdTY3ODRcdTUzMTZcdTk1MTlcdThCRUZcdTc4MDEsXHU1RTc2XHU2M0QwXHU0RjlCXHU0RTBCXHU0RTAwXHU2QjY1XHU1MkE4XHU0RjVDXHUzMDAyXG4gKiBtZXNzYWdlIFx1NjYyRlx1N0VBRlx1NjU4N1x1NjcyQyxcdTZFMzJcdTY3RDNcdTdBRUZcdTZDMzhcdTRFMERcdTYyOEFcdTVCODNcdTVGNTMgSFRNTFx1MzAwMlxuICovXG5leHBvcnQgY29uc3QgRVJST1JfQ09ERVMgPSBbXG4gICdIT1NUX05PVF9SRUFEWScsXG4gICdBVVRIX0ZBSUxFRCcsXG4gICdSVU5USU1FX0NSQVNIRUQnLFxuICAnUE9SVF9CSU5EX0ZBSUxFRCcsXG4gICdTVEFMRV9WRVJTSU9OJyxcbiAgJ1NDSEVNQV9NSVNNQVRDSCcsXG5dIGFzIGNvbnN0O1xuXG5leHBvcnQgdHlwZSBFcnJvckNvZGUgPSAodHlwZW9mIEVSUk9SX0NPREVTKVtudW1iZXJdO1xuXG5leHBvcnQgY29uc3QgUkVDT1ZFUllfQUNUSU9OUyA9IFsnUkVDT05ORUNUJywgJ1JFU1VNRScsICdFWFBPUlQnLCAnT1BFTl9MT0dTJ10gYXMgY29uc3Q7XG5leHBvcnQgdHlwZSBSZWNvdmVyeUFjdGlvbiA9ICh0eXBlb2YgUkVDT1ZFUllfQUNUSU9OUylbbnVtYmVyXTtcblxuZXhwb3J0IGludGVyZmFjZSBEZXNrdG9wRXJyb3Ige1xuICBjb2RlOiBFcnJvckNvZGU7XG4gIC8qKiBcdTdFQUZcdTY1ODdcdTY3MkMsXHU2QzM4XHU0RTBEXHU0RkUxXHU0RUZCXHU0RTNBIEhUTUxcdTMwMDIgKi9cbiAgbWVzc2FnZTogc3RyaW5nO1xuICByZXRyeWFibGU6IGJvb2xlYW47XG4gIHNlc3Npb25JZD86IHN0cmluZztcbiAgcnVuSWQ/OiBzdHJpbmc7XG4gIHJlY292ZXJ5QWN0aW9uPzogUmVjb3ZlcnlBY3Rpb247XG59XG5cbi8qKiBcdTY3ODRcdTkwMjBcdTRFMDBcdTRFMkEgRGVza3RvcEVycm9yKGV4YWN0T3B0aW9uYWxQcm9wZXJ0eVR5cGVzIFx1NTNDQlx1NTk3RClcdTMwMDIgKi9cbmV4cG9ydCBmdW5jdGlvbiBkZXNrdG9wRXJyb3IoXG4gIGNvZGU6IEVycm9yQ29kZSxcbiAgbWVzc2FnZTogc3RyaW5nLFxuICBvcHRzOiB7IHJldHJ5YWJsZT86IGJvb2xlYW47IHNlc3Npb25JZD86IHN0cmluZzsgcnVuSWQ/OiBzdHJpbmc7IHJlY292ZXJ5QWN0aW9uPzogUmVjb3ZlcnlBY3Rpb24gfSA9IHt9LFxuKTogRGVza3RvcEVycm9yIHtcbiAgY29uc3QgZTogRGVza3RvcEVycm9yID0geyBjb2RlLCBtZXNzYWdlLCByZXRyeWFibGU6IG9wdHMucmV0cnlhYmxlID09PSB0cnVlIH07XG4gIGlmIChvcHRzLnNlc3Npb25JZCAhPT0gdW5kZWZpbmVkKSBlLnNlc3Npb25JZCA9IG9wdHMuc2Vzc2lvbklkO1xuICBpZiAob3B0cy5ydW5JZCAhPT0gdW5kZWZpbmVkKSBlLnJ1bklkID0gb3B0cy5ydW5JZDtcbiAgaWYgKG9wdHMucmVjb3ZlcnlBY3Rpb24gIT09IHVuZGVmaW5lZCkgZS5yZWNvdmVyeUFjdGlvbiA9IG9wdHMucmVjb3ZlcnlBY3Rpb247XG4gIHJldHVybiBlO1xufVxuIiwgIi8qKlxuICogQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyBcdTIwMTQgcnVudGltZSBcdTY4MjFcdTlBOEMoZ3VhcmRzKVx1MzAwMlxuICpcbiAqIFx1NkJDRlx1NEUyQVx1OERFOFx1NEZFMVx1NEVGQlx1OEZCOVx1NzU0Q1x1NzY4NFx1NjU3MFx1NjM2RShydW50aW1lXHUyMTkycmVuZGVyZXJcdTMwMDFob3N0XHUyMTkybWFpbilcdThGREJcdTUxNjVcdTUyNERcdTUxNDhcdThGQzcgZ3VhcmQ7XG4gKiBcdTY4MjFcdTlBOENcdTU5MzFcdThEMjVcdTc2ODRcdTY1NzBcdTYzNkVcdTYzMDkgU0NIRU1BX01JU01BVENIIFx1N0VEM1x1Njc4NFx1NTMxNlx1OTUxOVx1OEJFRlx1NTkwNFx1NzQwNixcdTRFMERcdTk3NTlcdTlFRDhcdTYzQTVcdTUzRDdcdTMwMDJcbiAqIFx1NjI0Qlx1NTE5OVx1NUI4OFx1NTM2Qlx1ODAwQ1x1NEUwRFx1NjYyRlx1NUYxNVx1N0IyQ1x1NEUwOVx1NjVCOSBzY2hlbWEgXHU1RTkzOlx1NTk1MVx1N0VBNlx1OTc2Mlx1NUMwRixcdTk2RjZcdTRGOURcdThENTZcdTY1ODdcdTUzMTYoaG1oYXJuZXNzIFx1NTQwQ1x1NkU5MClcdTMwMDJcbiAqL1xuaW1wb3J0IHtcbiAgRVZFTlRfS0lORFMsXG4gIEVWRU5UX1NDSEVNQV9WRVJTSU9OLFxuICB0eXBlIEV2ZW50RW52ZWxvcGUsXG4gIHR5cGUgRXZlbnRLaW5kLFxufSBmcm9tICcuL2V2ZW50LnRzJztcbmltcG9ydCB7IEVSUk9SX0NPREVTLCBSRUNPVkVSWV9BQ1RJT05TLCB0eXBlIERlc2t0b3BFcnJvciB9IGZyb20gJy4vZXJyb3IudHMnO1xuaW1wb3J0IHsgUlVOX1NUQVRVU0VTLCB0eXBlIFJ1blN0YXR1cyB9IGZyb20gJy4vZHRvLnRzJztcblxuY29uc3QgaXNSZWNvcmQgPSAodjogdW5rbm93bik6IHYgaXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPT5cbiAgdHlwZW9mIHYgPT09ICdvYmplY3QnICYmIHYgIT09IG51bGwgJiYgIUFycmF5LmlzQXJyYXkodik7XG5cbmNvbnN0IGlzTm9uRW1wdHlTdHJpbmcgPSAodjogdW5rbm93bik6IHYgaXMgc3RyaW5nID0+IHR5cGVvZiB2ID09PSAnc3RyaW5nJyAmJiB2Lmxlbmd0aCA+IDA7XG5cbmNvbnN0IGlzUmZjMzMzOSA9ICh2OiBzdHJpbmcpOiBib29sZWFuID0+IHtcbiAgY29uc3QgdCA9IERhdGUucGFyc2Uodik7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUodCkgJiYgL1xcZHs0fS1cXGR7Mn0tXFxkezJ9VC8udGVzdCh2KTtcbn07XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0V2ZW50RW52ZWxvcGUodjogdW5rbm93bik6IHYgaXMgRXZlbnRFbnZlbG9wZSB7XG4gIGlmICghaXNSZWNvcmQodikpIHJldHVybiBmYWxzZTtcbiAgaWYgKHYuc2NoZW1hVmVyc2lvbiAhPT0gRVZFTlRfU0NIRU1BX1ZFUlNJT04pIHJldHVybiBmYWxzZTtcbiAgaWYgKCFpc05vbkVtcHR5U3RyaW5nKHYuZXZlbnRJZCkpIHJldHVybiBmYWxzZTtcbiAgaWYgKCFpc05vbkVtcHR5U3RyaW5nKHYuc2Vzc2lvbklkKSkgcmV0dXJuIGZhbHNlO1xuICBpZiAoIWlzTm9uRW1wdHlTdHJpbmcodi5ydW5JZCkpIHJldHVybiBmYWxzZTtcbiAgaWYgKHR5cGVvZiB2LnNlcSAhPT0gJ251bWJlcicgfHwgIU51bWJlci5pc0ludGVnZXIodi5zZXEpIHx8IHYuc2VxIDwgMCkgcmV0dXJuIGZhbHNlO1xuICBpZiAoIWlzTm9uRW1wdHlTdHJpbmcodi5vY2N1cnJlZEF0KSB8fCAhaXNSZmMzMzM5KHYub2NjdXJyZWRBdCkpIHJldHVybiBmYWxzZTtcbiAgaWYgKCFFVkVOVF9LSU5EUy5pbmNsdWRlcyh2LmtpbmQgYXMgRXZlbnRLaW5kKSkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gaXNSZWNvcmQodi5wYXlsb2FkKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzRGVza3RvcEVycm9yKHY6IHVua25vd24pOiB2IGlzIERlc2t0b3BFcnJvciB7XG4gIGlmICghaXNSZWNvcmQodikpIHJldHVybiBmYWxzZTtcbiAgaWYgKCFFUlJPUl9DT0RFUy5pbmNsdWRlcyh2LmNvZGUgYXMgbmV2ZXIpKSByZXR1cm4gZmFsc2U7XG4gIGlmICh0eXBlb2Ygdi5tZXNzYWdlICE9PSAnc3RyaW5nJykgcmV0dXJuIGZhbHNlO1xuICBpZiAodHlwZW9mIHYucmV0cnlhYmxlICE9PSAnYm9vbGVhbicpIHJldHVybiBmYWxzZTtcbiAgaWYgKHYuc2Vzc2lvbklkICE9PSB1bmRlZmluZWQgJiYgIWlzTm9uRW1wdHlTdHJpbmcodi5zZXNzaW9uSWQpKSByZXR1cm4gZmFsc2U7XG4gIGlmICh2LnJ1bklkICE9PSB1bmRlZmluZWQgJiYgIWlzTm9uRW1wdHlTdHJpbmcodi5ydW5JZCkpIHJldHVybiBmYWxzZTtcbiAgaWYgKHYucmVjb3ZlcnlBY3Rpb24gIT09IHVuZGVmaW5lZCAmJiAhUkVDT1ZFUllfQUNUSU9OUy5pbmNsdWRlcyh2LnJlY292ZXJ5QWN0aW9uIGFzIG5ldmVyKSkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzUnVuU3RhdHVzKHY6IHVua25vd24pOiB2IGlzIFJ1blN0YXR1cyB7XG4gIHJldHVybiB0eXBlb2YgdiA9PT0gJ3N0cmluZycgJiYgUlVOX1NUQVRVU0VTLmluY2x1ZGVzKHYgYXMgUnVuU3RhdHVzKTtcbn1cblxuLyoqIEhvc3QgXHU1RjE1XHU1QkZDXHU4ODRDKHN0ZG91dCBcdTdCMkNcdTRFMDBcdTg4NEMpXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gaXNIb3N0UmVhZHlMaW5lKHY6IHVua25vd24pOiB2IGlzIHsgaG1oRGVza3RvcEhvc3RSZWFkeTogdHJ1ZTsgcG9ydDogbnVtYmVyOyB2ZXJzaW9uOiBzdHJpbmcgfSB7XG4gIGlmICghaXNSZWNvcmQodikpIHJldHVybiBmYWxzZTtcbiAgaWYgKHYuaG1oRGVza3RvcEhvc3RSZWFkeSAhPT0gdHJ1ZSkgcmV0dXJuIGZhbHNlO1xuICBpZiAodHlwZW9mIHYucG9ydCAhPT0gJ251bWJlcicgfHwgIU51bWJlci5pc0ludGVnZXIodi5wb3J0KSB8fCB2LnBvcnQgPD0gMCB8fCB2LnBvcnQgPiA2NTUzNSkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gaXNOb25FbXB0eVN0cmluZyh2LnZlcnNpb24pO1xufVxuIiwgIi8qKlxuICogRGVza3RvcEhvc3RDbGllbnQgXHUyMDE0IFx1NUJGOSBobWggaG9zdCBcdTc2ODQgSFRUUCtTU0UgXHU1QkEyXHU2MjM3XHU3QUVGXHUzMDAyXG4gKlxuICogLSBcdTZCQ0ZcdTRFMkEgSFRUUCBcdThCRjdcdTZDNDJcdTgxRUFcdTUyQThcdTVFMjYgWC1IbWgtS2V5KHRva2VuIFx1NEUwRFx1OEZEQiBVUkwpO1xuICogLSBcdTdFRDNcdTY3ODRcdTUzMTZcdTk1MTlcdThCRUYocmVzLmJvZHkgXHU5MUNDXHU3Njg0IERlc2t0b3BFcnJvciBcdTVGNjJcdTcyQjZcdTYyMTYgSFRUUCBcdTcyQjZcdTYwMDEpXHU4OUM0XHU3RUE2XHU2MjEwXHU1RjAyXHU1RTM4XHU2MjlCXHU1MUZBO1xuICogLSBTU0UgXHU3NTI4IGZldGNoIFx1NkQ0MVx1NjI0Qlx1NTE5OVx1ODlFM1x1Njc5MChpZC9ldmVudC9kYXRhIFx1NUUyNyksXHU2NTJGXHU2MzAxIExhc3QtRXZlbnQtSUQgXHU4ODY1XHU2MkM5XHU5MUNEXHU4RkRFXHUzMDAyXG4gKi9cbmltcG9ydCB7IGRlc2t0b3BFcnJvciwgaXNEZXNrdG9wRXJyb3IsIGlzRXZlbnRFbnZlbG9wZSwgdHlwZSBEZXNrdG9wRXJyb3IsIHR5cGUgRXZlbnRFbnZlbG9wZSB9IGZyb20gJ0BobWgtZGVza3RvcC9jb250cmFjdHMnO1xuXG5leHBvcnQgaW50ZXJmYWNlIFNzZUZyYW1lIHtcbiAgaWQ/OiBzdHJpbmc7XG4gIGV2ZW50OiBzdHJpbmc7XG4gIGRhdGE6IHN0cmluZztcbn1cblxuLyoqIFx1ODlFM1x1Njc5MFx1NEUwMFx1NkJCNSBTU0UgXHU2NTg3XHU2NzJDXHU0RTNBXHU1RTI3KFx1NEUwRFx1NTQyQlx1OERFOCBjaHVuayBcdTc2ODRcdTdGMTNcdTUxQjJcdTkwM0JcdThGOTEsXHU3RUFGXHU1MUZEXHU2NTcwXHU0RkJGXHU0RThFXHU2RDRCXHU4QkQ1KVx1MzAwMiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlU3NlQ2h1bmsoY2h1bms6IHN0cmluZyk6IFNzZUZyYW1lW10ge1xuICBjb25zdCBmcmFtZXM6IFNzZUZyYW1lW10gPSBbXTtcbiAgZm9yIChjb25zdCBibG9jayBvZiBjaHVuay5zcGxpdCgvXFxuXFxuLykpIHtcbiAgICBpZiAoIWJsb2NrLnRyaW0oKSkgY29udGludWU7XG4gICAgbGV0IGlkOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gICAgbGV0IGV2ZW50ID0gJ21lc3NhZ2UnO1xuICAgIGNvbnN0IGRhdGFMaW5lczogc3RyaW5nW10gPSBbXTtcbiAgICBsZXQgc2F3RmllbGQgPSBmYWxzZTtcbiAgICBmb3IgKGNvbnN0IGxpbmUgb2YgYmxvY2suc3BsaXQoJ1xcbicpKSB7XG4gICAgICBpZiAobGluZS5zdGFydHNXaXRoKCc6JykpIGNvbnRpbnVlOyAvLyBcdTZDRThcdTkxQ0EvXHU1RkMzXHU4REYzXG4gICAgICBpZiAobGluZS5zdGFydHNXaXRoKCdpZDonKSkgeyBpZCA9IGxpbmUuc2xpY2UoMykudHJpbSgpOyBzYXdGaWVsZCA9IHRydWU7IH1cbiAgICAgIGVsc2UgaWYgKGxpbmUuc3RhcnRzV2l0aCgnZXZlbnQ6JykpIHsgZXZlbnQgPSBsaW5lLnNsaWNlKDYpLnRyaW0oKTsgc2F3RmllbGQgPSB0cnVlOyB9XG4gICAgICBlbHNlIGlmIChsaW5lLnN0YXJ0c1dpdGgoJ2RhdGE6JykpIHsgZGF0YUxpbmVzLnB1c2gobGluZS5zbGljZSg1KS5yZXBsYWNlKC9eIC8sICcnKSk7IHNhd0ZpZWxkID0gdHJ1ZTsgfVxuICAgIH1cbiAgICBpZiAoIXNhd0ZpZWxkKSBjb250aW51ZTsgLy8gXHU3RUFGXHU2Q0U4XHU5MUNBL1x1NUZDM1x1OERGM1x1NTc1N1x1NEUwRFx1NEVBN1x1NzUxRlx1NUUyN1xuICAgIGZyYW1lcy5wdXNoKHsgLi4uKGlkICE9PSB1bmRlZmluZWQgPyB7IGlkIH0gOiB7fSksIGV2ZW50LCBkYXRhOiBkYXRhTGluZXMuam9pbignXFxuJykgfSk7XG4gIH1cbiAgcmV0dXJuIGZyYW1lcztcbn1cblxuLyoqIFx1NEVDRSBTU0UgXHU1RTI3XHU2NTcwXHU2MzZFXHU0RTJEXHU4OUUzXHU1MUZBXHU1NDA4XHU2Q0Q1IEV2ZW50RW52ZWxvcGU7XHU0RTBEXHU1NDA4XHU2Q0Q1XHU3Njg0XHU4RkQ0XHU1NkRFIG51bGwoU0NIRU1BX01JU01BVENIIFx1NzUzMVx1OEMwM1x1NzUyOFx1NjVCOVx1OEJBMVx1NjU3MClcdTMwMDIgKi9cbmV4cG9ydCBmdW5jdGlvbiBlbnZlbG9wZUZyb21GcmFtZShmcmFtZTogU3NlRnJhbWUpOiBFdmVudEVudmVsb3BlIHwgbnVsbCB7XG4gIGlmIChmcmFtZS5ldmVudCAhPT0gJ2htaCcpIHJldHVybiBudWxsOyAvLyBcdTYyMTFcdTRFRUNcdTc2ODRcdTRFOEJcdTRFRjZcdTRGRTFcdTVDMDFcdTdFREZcdTRFMDBcdThENzAgZXZlbnQ6IGhtaFxuICB0cnkge1xuICAgIGNvbnN0IHBhcnNlZDogdW5rbm93biA9IEpTT04ucGFyc2UoZnJhbWUuZGF0YSk7XG4gICAgcmV0dXJuIGlzRXZlbnRFbnZlbG9wZShwYXJzZWQpID8gcGFyc2VkIDogbnVsbDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuZXhwb3J0IGNsYXNzIERlc2t0b3BIdHRwRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKHB1YmxpYyByZWFkb25seSBkZXRhaWw6IERlc2t0b3BFcnJvcikge1xuICAgIHN1cGVyKGRldGFpbC5tZXNzYWdlKTtcbiAgfVxufVxuXG5leHBvcnQgY2xhc3MgRGVza3RvcEhvc3RDbGllbnQge1xuICBjb25zdHJ1Y3RvcihcbiAgICBwcml2YXRlIHJlYWRvbmx5IGJhc2VVcmw6IHN0cmluZyxcbiAgICBwcml2YXRlIHJlYWRvbmx5IHRva2VuOiBzdHJpbmcsXG4gICkge31cblxuICBwcml2YXRlIGhlYWRlcnMoZXh0cmE6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fSk6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4ge1xuICAgIHJldHVybiB7ICd4LWhtaC1rZXknOiB0aGlzLnRva2VuLCAuLi5leHRyYSB9O1xuICB9XG5cbiAgYXN5bmMgZ2V0SnNvbjxUPihwYXRoOiBzdHJpbmcsIHRpbWVvdXRNcyA9IDVfMDAwKTogUHJvbWlzZTxUPiB7XG4gICAgbGV0IHJlczogUmVzcG9uc2U7XG4gICAgdHJ5IHtcbiAgICAgIHJlcyA9IGF3YWl0IGZldGNoKGAke3RoaXMuYmFzZVVybH0ke3BhdGh9YCwgeyBoZWFkZXJzOiB0aGlzLmhlYWRlcnMoKSwgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KHRpbWVvdXRNcykgfSk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYHJlcXVlc3QgZmFpbGVkOiAke1N0cmluZyhlcnIpLnNsaWNlKDAsIDE2MCl9YCwgeyByZXRyeWFibGU6IHRydWUsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XG4gICAgfVxuICAgIHJldHVybiB0aGlzLnBhcnNlUmVzcG9uc2U8VD4ocmVzKTtcbiAgfVxuXG4gIGFzeW5jIHBvc3RKc29uPFQ+KHBhdGg6IHN0cmluZywgYm9keTogdW5rbm93biwgdGltZW91dE1zID0gMTBfMDAwKTogUHJvbWlzZTxUPiB7XG4gICAgbGV0IHJlczogUmVzcG9uc2U7XG4gICAgdHJ5IHtcbiAgICAgIHJlcyA9IGF3YWl0IGZldGNoKGAke3RoaXMuYmFzZVVybH0ke3BhdGh9YCwge1xuICAgICAgICBtZXRob2Q6ICdQT1NUJyxcbiAgICAgICAgaGVhZGVyczogdGhpcy5oZWFkZXJzKHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyB9KSxcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoYm9keSksXG4gICAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCh0aW1lb3V0TXMpLFxuICAgICAgfSk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYHJlcXVlc3QgZmFpbGVkOiAke1N0cmluZyhlcnIpLnNsaWNlKDAsIDE2MCl9YCwgeyByZXRyeWFibGU6IHRydWUsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XG4gICAgfVxuICAgIHJldHVybiB0aGlzLnBhcnNlUmVzcG9uc2U8VD4ocmVzKTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgcGFyc2VSZXNwb25zZTxUPihyZXM6IFJlc3BvbnNlKTogUHJvbWlzZTxUPiB7XG4gICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSB8fCByZXMuc3RhdHVzID09PSA0MDMpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignQVVUSF9GQUlMRUQnLCBgaG9zdCByZWplY3RlZCB0aGUgc2Vzc2lvbiB0b2tlbiAoSFRUUCAke3Jlcy5zdGF0dXN9KWAsIHsgcmV0cnlhYmxlOiBmYWxzZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcbiAgICB9XG4gICAgY29uc3QgdGV4dCA9IGF3YWl0IHJlcy50ZXh0KCk7XG4gICAgbGV0IHBhcnNlZDogdW5rbm93biA9IG51bGw7XG4gICAgdHJ5IHtcbiAgICAgIHBhcnNlZCA9IHRleHQgPyBKU09OLnBhcnNlKHRleHQpIDogbnVsbDtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHBhcnNlZCA9IG51bGw7XG4gICAgfVxuICAgIGlmICghcmVzLm9rKSB7XG4gICAgICBpZiAoaXNEZXNrdG9wRXJyb3IocGFyc2VkKSkgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IocGFyc2VkKTtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgSFRUUCAke3Jlcy5zdGF0dXN9OiAke3RleHQuc2xpY2UoMCwgMTYwKX1gLCB7IHJldHJ5YWJsZTogcmVzLnN0YXR1cyA+PSA1MDAgfSkpO1xuICAgIH1cbiAgICByZXR1cm4gcGFyc2VkIGFzIFQ7XG4gIH1cblxuICAvKipcbiAgICogXHU4QkEyXHU5NjA1XHU1MTY4XHU5MEU4IFNTRSBcdTVFMjcoXHU1NDJCXHU5NzVFXHU0RkUxXHU1QzAxXHU0RThCXHU0RUY2OmRlbHRhL2xpbmUgXHU3QjQ5XHU5QUQ4XHU5ODkxXHU2RDQxKVx1MzAwMlx1NEZFMVx1NUMwMVx1NzUzMVx1OEMwM1x1NzUyOFx1NjVCOVxuICAgKiBcdTc1MjggZW52ZWxvcGVGcm9tRnJhbWUgXHU4MUVBXHU4ODRDXHU1MjA2XHU2RDQxO1x1NjVBRFx1N0VCRlx1OTFDRFx1OEZERVx1OEJFRFx1NEU0OVx1NTQwQyBldmVudHMoKVx1MzAwMlxuICAgKi9cbiAgYXN5bmMgKnJhd0V2ZW50cyhsYXN0RXZlbnRJZD86IHN0cmluZywgc2lnbmFsPzogQWJvcnRTaWduYWwpOiBBc3luY0dlbmVyYXRvcjxTc2VGcmFtZT4ge1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGAke3RoaXMuYmFzZVVybH0vYXBpL2V2ZW50c2AsIHtcbiAgICAgIGhlYWRlcnM6IHRoaXMuaGVhZGVycyh7XG4gICAgICAgIGFjY2VwdDogJ3RleHQvZXZlbnQtc3RyZWFtJyxcbiAgICAgICAgLi4uKGxhc3RFdmVudElkICE9PSB1bmRlZmluZWQgPyB7ICdsYXN0LWV2ZW50LWlkJzogbGFzdEV2ZW50SWQgfSA6IHt9KSxcbiAgICAgIH0pLFxuICAgICAgLi4uKHNpZ25hbCAhPT0gdW5kZWZpbmVkID8geyBzaWduYWwgfSA6IHt9KSxcbiAgICB9KTtcbiAgICBpZiAocmVzLnN0YXR1cyA9PT0gNDAxIHx8IHJlcy5zdGF0dXMgPT09IDQwMykge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdBVVRIX0ZBSUxFRCcsIGBob3N0IHJlamVjdGVkIHRoZSBzZXNzaW9uIHRva2VuIChIVFRQICR7cmVzLnN0YXR1c30pYCwgeyByZXRyeWFibGU6IGZhbHNlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICBpZiAoIXJlcy5vayB8fCByZXMuYm9keSA9PT0gbnVsbCkge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBTU0UgSFRUUCAke3Jlcy5zdGF0dXN9YCwgeyByZXRyeWFibGU6IHRydWUsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XG4gICAgfVxuICAgIGNvbnN0IHJlYWRlciA9IHJlcy5ib2R5LmdldFJlYWRlcigpO1xuICAgIGNvbnN0IGRlY29kZXIgPSBuZXcgVGV4dERlY29kZXIoKTtcbiAgICBsZXQgYnVmZmVyID0gJyc7XG4gICAgZm9yICg7Oykge1xuICAgICAgY29uc3QgeyBkb25lLCB2YWx1ZSB9ID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcbiAgICAgIGlmIChkb25lKSByZXR1cm47XG4gICAgICBidWZmZXIgKz0gZGVjb2Rlci5kZWNvZGUodmFsdWUsIHsgc3RyZWFtOiB0cnVlIH0pO1xuICAgICAgbGV0IGlkeDogbnVtYmVyO1xuICAgICAgd2hpbGUgKChpZHggPSBidWZmZXIuaW5kZXhPZignXFxuXFxuJykpICE9PSAtMSkge1xuICAgICAgICBjb25zdCBibG9jayA9IGJ1ZmZlci5zbGljZSgwLCBpZHgpO1xuICAgICAgICBidWZmZXIgPSBidWZmZXIuc2xpY2UoaWR4ICsgMik7XG4gICAgICAgIGZvciAoY29uc3QgZnJhbWUgb2YgcGFyc2VTc2VDaHVuayhibG9jaykpIHlpZWxkIGZyYW1lO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBcdThCQTJcdTk2MDUgU1NFIFx1NEU4Qlx1NEVGNlx1NkQ0MShhc3luYyBpdGVyYXRvcilcdTMwMDJcdTY1QURcdTdFQkZcdTc1MzFcdThDMDNcdTc1MjhcdTY1QjlcdTkxQ0RcdThGREU7XHU5MUNEXHU4RkRFXHU2NUY2XHU2MjhBXHU2NzAwXHU1NDBFXG4gICAqIFx1NjUzNlx1NTIzMFx1NzY4NCBldmVudElkIFx1NEYyMFx1NTE2NSBsYXN0RXZlbnRJZCxob3N0IFx1N0FFRlx1NEVDRVx1OTFDRFx1NjUzRVx1NzNBRlx1ODg2NVx1NTNEMVx1MzAwMlxuICAgKi9cbiAgYXN5bmMgKmV2ZW50cyhsYXN0RXZlbnRJZD86IHN0cmluZywgc2lnbmFsPzogQWJvcnRTaWduYWwpOiBBc3luY0dlbmVyYXRvcjxFdmVudEVudmVsb3BlPiB7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYCR7dGhpcy5iYXNlVXJsfS9hcGkvZXZlbnRzYCwge1xuICAgICAgaGVhZGVyczogdGhpcy5oZWFkZXJzKHtcbiAgICAgICAgYWNjZXB0OiAndGV4dC9ldmVudC1zdHJlYW0nLFxuICAgICAgICAuLi4obGFzdEV2ZW50SWQgIT09IHVuZGVmaW5lZCA/IHsgJ2xhc3QtZXZlbnQtaWQnOiBsYXN0RXZlbnRJZCB9IDoge30pLFxuICAgICAgfSksXG4gICAgICAuLi4oc2lnbmFsICE9PSB1bmRlZmluZWQgPyB7IHNpZ25hbCB9IDoge30pLFxuICAgIH0pO1xuICAgIGlmIChyZXMuc3RhdHVzID09PSA0MDEgfHwgcmVzLnN0YXR1cyA9PT0gNDAzKSB7XG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgYGhvc3QgcmVqZWN0ZWQgdGhlIHNlc3Npb24gdG9rZW4gKEhUVFAgJHtyZXMuc3RhdHVzfSlgLCB7IHJldHJ5YWJsZTogZmFsc2UsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XG4gICAgfVxuICAgIGlmICghcmVzLm9rIHx8ICFyZXMuYm9keSkge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBTU0UgSFRUUCAke3Jlcy5zdGF0dXN9YCwgeyByZXRyeWFibGU6IHRydWUsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XG4gICAgfVxuICAgIGNvbnN0IHJlYWRlciA9IHJlcy5ib2R5LmdldFJlYWRlcigpO1xuICAgIGNvbnN0IGRlY29kZXIgPSBuZXcgVGV4dERlY29kZXIoKTtcbiAgICBsZXQgYnVmZmVyID0gJyc7XG4gICAgZm9yICg7Oykge1xuICAgICAgY29uc3QgeyBkb25lLCB2YWx1ZSB9ID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcbiAgICAgIGlmIChkb25lKSByZXR1cm47XG4gICAgICBidWZmZXIgKz0gZGVjb2Rlci5kZWNvZGUodmFsdWUsIHsgc3RyZWFtOiB0cnVlIH0pO1xuICAgICAgLy8gXHU0RUU1XHU3QTdBXHU4ODRDXHU1MjA2XHU1RTI3O1x1NEZERFx1NzU1OVx1NEUwRFx1NUI4Q1x1NjU3NFx1NzY4NFx1NUMzRVx1OTBFOFxuICAgICAgbGV0IGlkeDogbnVtYmVyO1xuICAgICAgd2hpbGUgKChpZHggPSBidWZmZXIuaW5kZXhPZignXFxuXFxuJykpICE9PSAtMSkge1xuICAgICAgICBjb25zdCBibG9jayA9IGJ1ZmZlci5zbGljZSgwLCBpZHgpO1xuICAgICAgICBidWZmZXIgPSBidWZmZXIuc2xpY2UoaWR4ICsgMik7XG4gICAgICAgIGZvciAoY29uc3QgZnJhbWUgb2YgcGFyc2VTc2VDaHVuayhibG9jaykpIHtcbiAgICAgICAgICBjb25zdCBlbnYgPSBlbnZlbG9wZUZyb21GcmFtZShmcmFtZSk7XG4gICAgICAgICAgaWYgKGVudiAhPT0gbnVsbCkgeWllbGQgZW52O1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG59XG4iLCAiLyoqXG4gKiBmYWtlIGhvc3QgXHUyMDE0IGhtaGFybmVzcyBydW50aW1lIFx1NzY4NFx1NkQ0Qlx1OEJENVx1NjZGRlx1OEVBQihNYXN0ZXJQcm9tcHQgXHU5NjM2XHU2QkI1IEQvRTpcbiAqIFwiXHU1MTQ4XHU0RjdGXHU3NTI4IGZha2UgaG9zdCBcdTdGMTZcdTUxOTlcdTcyQjZcdTYwMDFcdTY3M0FcdTZENEJcdThCRDUsXHU1MThEXHU2M0E1XHU3NzFGXHU1QjlFIEFQSVwiO1x1OTYzNlx1NkJCNSBFIFx1NzY4NFx1NEYxQVx1OEJERFx1N0VCNVx1NTIwN1x1NzI0N1xuICogZTJlIFx1NEU1Rlx1NTE0OFx1NTcyOCBmYWtlIFx1NUM0Mlx1OTVFRFx1NzNBRilcdTMwMDJcbiAqXG4gKiBcdTY4NENcdTk3NjIgaG9zdCBcdTU0MDhcdTU0MEM6XG4gKiAgLSBcdTUzRUFcdTdFRDEgMTI3LjAuMC4xLFx1N0FFRlx1NTNFMyBPUyBcdTUyMDZcdTkxNEQsXHU1QjlFXHU5NjQ1XHU3QUVGXHU1M0UzXHU1MTk5IHN0ZG91dCBcdTVGMTVcdTVCRkNcdTg4NEM7XG4gKiAgLSBcdTYyNDBcdTY3MDkgL2FwaS8qIFx1ODk4MVx1NkM0MiBYLUhtaC1LZXkgPT09IEhNSF9ERVNLVE9QX1RPS0VOLFx1NTQyNlx1NTIxOSA0MDEgKyBEZXNrdG9wRXJyb3I7XG4gKiAgLSBHRVQgL2FwaS9zdGF0ZSBcdTUwNjVcdTVFQjdcdTYzQTJcdTZENEI7R0VUIC9hcGkvZXZlbnRzIFNTRShldmVudDogaG1oIFx1NEZFMVx1NUMwMVx1NkQ0MSArIFx1OTFDRFx1NjUzRVx1NzNBRik7XG4gKiAgLSBQT1NUIC9hcGkvZGVza3RvcC9zaHV0ZG93biBcdTRGMThcdTk2QzVcdTkwMDBcdTUxRkFcdTMwMDJcbiAqXG4gKiBcdTk2MzZcdTZCQjUgRSBcdTZBMjFcdTYyREZcdTk3NjIoXHU0RTBFIGhtaGFybmVzcyBkZXNrdG9wIFx1NkEyMVx1NUYwRlx1NTQwQ1x1NUY2Mik6XG4gKiAgLSBQT1NUIC9hcGkvdGFzayB7dGV4dCwgc2Vzc2lvbklkLCBtb2RlfTpcdTYzOTJcdTk2MUZcdTVFNzZcdTYzMDlcdTgxMUFcdTY3MkNcdTUzRDFcbiAqICAgIHJ1bi5zdGFydGVkIFx1MjE5MiB0b29sLnN0YXJ0ZWQvY29tcGxldGVkIFx1MjE5Mihtb2RlPT09J2FzaycgXHU2NUY2KVxuICogICAgYXBwcm92YWwucmVxdWlyZWQoXHU3QjQ5IC9hcGkvYXBwcm92ZSlcdTIxOTIgcnVuLmNvbXBsZXRlZDtcbiAqICAtIFBPU1QgL2FwaS9hcHByb3ZlIHtncmFudGVkLCBzZXNzaW9uSWR9O1xuICogIC0gUE9TVCAvYXBpL2ludGVycnVwdCB7c2Vzc2lvbklkfTtcbiAqICAtIEdFVCAvYXBpL3Nlc3Npb25zXHUzMDAyXG4gKlxuICogXHU2RDRCXHU4QkQ1XHU5NEE5XHU1QjUwOkZBS0VfSE9TVF9ESUVfQUZURVJfTVMgLyBGQUtFX0hPU1RfRElFX0FUX0JPT1QgL1xuICogRkFLRV9IT1NUX0VYUEVDVF9UT0tFTiAvIEZBS0VfSE9TVF9UQVNLX0RFTEFZX01TIC8gRkFLRV9IT1NUX1RBU0tfRkFJTD0xXG4gKiAoXHU0RUZCXHU1MkExXHU0RUU1IHJ1bi5mYWlsZWQgXHU3RUQzXHU2NzVGLFx1Njc4NFx1OTAyMFx1OTUxOVx1OEJFRlx1NjA2Mlx1NTkwRFx1NTczQVx1NjY2RilcdTMwMDJcbiAqL1xuaW1wb3J0IHsgY3JlYXRlU2VydmVyLCB0eXBlIFNlcnZlclJlc3BvbnNlIH0gZnJvbSAnbm9kZTpodHRwJztcbmltcG9ydCB7IHJhbmRvbVVVSUQgfSBmcm9tICdub2RlOmNyeXB0byc7XG5pbXBvcnQgeyBwYXRoVG9GaWxlVVJMIH0gZnJvbSAnbm9kZTp1cmwnO1xuaW1wb3J0IHsgcmVhbHBhdGhTeW5jIH0gZnJvbSAnbm9kZTpmcyc7XG5pbXBvcnQgeyBFVkVOVF9TQ0hFTUFfVkVSU0lPTiwgZGVza3RvcEVycm9yLCB0eXBlIEV2ZW50RW52ZWxvcGUsIHR5cGUgRXZlbnRLaW5kIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgRmFrZUhvc3RIYW5kbGUge1xuICBwb3J0OiBudW1iZXI7XG4gIGVtaXQoc2Vzc2lvbklkOiBzdHJpbmcsIHJ1bklkOiBzdHJpbmcsIGtpbmQ6IEV2ZW50S2luZCwgcGF5bG9hZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBudW1iZXI7XG4gIGNsb3NlKCk6IFByb21pc2U8dm9pZD47XG59XG5cbmludGVyZmFjZSBGYWtlU2Vzc2lvbiB7XG4gIGlkOiBzdHJpbmc7XG4gIGNyZWF0ZWRBdDogc3RyaW5nO1xuICB1cGRhdGVkQXQ6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFBlbmRpbmdBcHByb3ZhbCB7XG4gIHNlc3Npb25JZDogc3RyaW5nO1xuICBhcHByb3ZhbElkOiBzdHJpbmc7XG4gIHJlc29sdmUoZ3JhbnRlZDogYm9vbGVhbik6IHZvaWQ7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzdGFydEZha2VIb3N0KG9wdHM6IHsgdG9rZW46IHN0cmluZzsgcXVpZXQ/OiBib29sZWFuIH0pOiBQcm9taXNlPEZha2VIb3N0SGFuZGxlPiB7XG4gIGNvbnN0IHRva2VuID0gb3B0cy50b2tlbjtcbiAgLy8gXHU2RDRCXHU4QkQ1XHU5NEE5XHU1QjUwOkZBS0VfSE9TVF9FWFBFQ1RfVE9LRU4gXHU4QkE5IGhvc3QgXHU2ODIxXHU5QThDXHU0RTAwXHU0RTJBXHU0RTBFIEhNSF9ERVNLVE9QX1RPS0VOXG4gIC8vIFx1NEUwRFx1NTQwQ1x1NzY4NFx1NTAzQyhcdTY3ODRcdTkwMjAgQVVUSF9GQUlMRUQgXHU1NzNBXHU2NjZGO3N1cGVydmlzb3IgXHU2MDNCXHU2NjJGXHU4OTg2XHU3NkQ2IEhNSF9ERVNLVE9QX1RPS0VOKVxuICBjb25zdCBleHBlY3RlZCA9IHByb2Nlc3MuZW52LkZBS0VfSE9TVF9FWFBFQ1RfVE9LRU4gPz8gdG9rZW47XG4gIGNvbnN0IHRhc2tEZWxheSA9IE51bWJlcihwcm9jZXNzLmVudi5GQUtFX0hPU1RfVEFTS19ERUxBWV9NUyA/PyAzMCk7XG4gIGNvbnN0IGZhaWxUYXNrcyA9IHByb2Nlc3MuZW52LkZBS0VfSE9TVF9UQVNLX0ZBSUwgPT09ICcxJztcblxuICBjb25zdCBzc2VDbGllbnRzID0gbmV3IFNldDxTZXJ2ZXJSZXNwb25zZT4oKTtcbiAgY29uc3Qgc2VxQnlSdW4gPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xuICAvLyBcdTkxQ0RcdTY1M0VcdTczQUY6XHU2NzAwXHU4RkQxIDIwMCBcdTVFMjcoTGFzdC1FdmVudC1JRCBcdTY1QURcdTdFQkZcdTg4NjVcdTYyQzkpLFx1NEUwRSBobWhhcm5lc3Mgd2ViIFx1NTQwQ1x1NkIzRVx1OEJFRFx1NEU0OVxuICBjb25zdCByaW5nOiBBcnJheTx7IGlkOiBudW1iZXI7IGV2ZW50OiBzdHJpbmc7IGRhdGE6IHVua25vd24gfT4gPSBbXTtcbiAgbGV0IHJpbmdTZXEgPSAwO1xuICBjb25zdCBzZXNzaW9ucyA9IG5ldyBNYXA8c3RyaW5nLCBGYWtlU2Vzc2lvbj4oKTtcbiAgbGV0IHBlbmRpbmc6IFBlbmRpbmdBcHByb3ZhbCB8IG51bGwgPSBudWxsO1xuICBjb25zdCBydW5UaW1lcnMgPSBuZXcgTWFwPHN0cmluZywgTm9kZUpTLlRpbWVvdXQ+KCk7XG5cbiAgY29uc3QgZW1pdCA9IChzZXNzaW9uSWQ6IHN0cmluZywgcnVuSWQ6IHN0cmluZywga2luZDogRXZlbnRLaW5kLCBwYXlsb2FkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IG51bWJlciA9PiB7XG4gICAgY29uc3Qga2V5ID0gYCR7c2Vzc2lvbklkfVxcMCR7cnVuSWR9YDtcbiAgICBjb25zdCBzZXEgPSAoc2VxQnlSdW4uZ2V0KGtleSkgPz8gMCkgKyAxO1xuICAgIHNlcUJ5UnVuLnNldChrZXksIHNlcSk7XG4gICAgY29uc3QgZW52OiBFdmVudEVudmVsb3BlID0ge1xuICAgICAgc2NoZW1hVmVyc2lvbjogRVZFTlRfU0NIRU1BX1ZFUlNJT04sXG4gICAgICBldmVudElkOiByYW5kb21VVUlEKCksXG4gICAgICBzZXNzaW9uSWQsXG4gICAgICBydW5JZCxcbiAgICAgIHNlcSxcbiAgICAgIG9jY3VycmVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgIGtpbmQsXG4gICAgICBwYXlsb2FkLFxuICAgIH07XG4gICAgY29uc3QgaWQgPSArK3JpbmdTZXE7XG4gICAgcmluZy5wdXNoKHsgaWQsIGV2ZW50OiAnaG1oJywgZGF0YTogZW52IH0pO1xuICAgIGlmIChyaW5nLmxlbmd0aCA+IDIwMCkgcmluZy5zcGxpY2UoMCwgcmluZy5sZW5ndGggLSAyMDApO1xuICAgIGZvciAoY29uc3QgYyBvZiBzc2VDbGllbnRzKSB7XG4gICAgICBjLndyaXRlKGBpZDogJHtpZH1cXG5ldmVudDogaG1oXFxuZGF0YTogJHtKU09OLnN0cmluZ2lmeShlbnYpfVxcblxcbmApO1xuICAgIH1cbiAgICByZXR1cm4gc2VxO1xuICB9O1xuXG4gIGNvbnN0IHRvdWNoID0gKHNlc3Npb25JZDogc3RyaW5nKTogRmFrZVNlc3Npb24gPT4ge1xuICAgIGxldCBzID0gc2Vzc2lvbnMuZ2V0KHNlc3Npb25JZCk7XG4gICAgaWYgKHMgPT09IHVuZGVmaW5lZCkge1xuICAgICAgcyA9IHsgaWQ6IHNlc3Npb25JZCwgY3JlYXRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksIHVwZGF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpIH07XG4gICAgICBzZXNzaW9ucy5zZXQoc2Vzc2lvbklkLCBzKTtcbiAgICB9XG4gICAgcy51cGRhdGVkQXQgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XG4gICAgcmV0dXJuIHM7XG4gIH07XG5cbiAgLyoqIFx1NkEyMVx1NjJERlx1NEUwMFx1NkIyMVx1NEVGQlx1NTJBMTpcdTYyNzlcdTUxQzZcdTZBMjFcdTVGMEZcdTYzMDJcdThENzdcdTdCNDlcdTVGODUgL2FwaS9hcHByb3ZlXHUzMDAyICovXG4gIGNvbnN0IHJ1blRhc2sgPSAoc2Vzc2lvbklkOiBzdHJpbmcsIHRleHQ6IHN0cmluZywgbW9kZTogc3RyaW5nKTogc3RyaW5nID0+IHtcbiAgICBjb25zdCBydW5JZCA9IGBydW4tJHtEYXRlLm5vdygpLnRvU3RyaW5nKDM2KX0tJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCA4KX1gO1xuICAgIHRvdWNoKHNlc3Npb25JZCk7XG4gICAgY29uc3Qgc3RlcHM6IEFycmF5PCgpID0+IHZvaWQ+ID0gW107XG4gICAgY29uc3Qgd2FpdCA9IChmbjogKCkgPT4gdm9pZCwgbXMgPSB0YXNrRGVsYXkpOiB2b2lkID0+IHtcbiAgICAgIGNvbnN0IHQgPSBzZXRUaW1lb3V0KGZuLCBtcyk7XG4gICAgICBydW5UaW1lcnMuc2V0KGAke3Nlc3Npb25JZH1cXDAke3J1bklkfWAsIHQpO1xuICAgIH07XG4gICAgY29uc3QgY2hhaW4gPSAoZm5zOiBBcnJheTwoKSA9PiB2b2lkPik6IHZvaWQgPT4ge1xuICAgICAgY29uc3QgW2ZpcnN0LCAuLi5yZXN0XSA9IGZucztcbiAgICAgIGlmIChmaXJzdCA9PT0gdW5kZWZpbmVkKSByZXR1cm47XG4gICAgICB3YWl0KCgpID0+IHtcbiAgICAgICAgZmlyc3QoKTtcbiAgICAgICAgY2hhaW4ocmVzdCk7XG4gICAgICB9KTtcbiAgICB9O1xuXG4gICAgZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAncnVuLnN0YXJ0ZWQnLCB7IHRhc2s6IHRleHQsIG1vZGUgfSk7XG4gICAgaWYgKGZhaWxUYXNrcykge1xuICAgICAgd2FpdCgoKSA9PiBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICdydW4uZmFpbGVkJywge1xuICAgICAgICBlcnJvcjogeyBjb2RlOiAnQVVUSF9GQUlMRUQnLCBtZXNzYWdlOiAnc2ltdWxhdGVkIHByb3ZpZGVyIGF1dGggZmFpbHVyZScsIHJldHJ5YWJsZTogZmFsc2UgfSxcbiAgICAgIH0pKTtcbiAgICAgIHJldHVybiBydW5JZDtcbiAgICB9XG5cbiAgICBjb25zdCBmaW5pc2hSdW4gPSAoYW5zd2VyOiBzdHJpbmcsIHRvb2xVc2VzOiBudW1iZXIpOiB2b2lkID0+IHtcbiAgICAgIHJ1blRpbWVycy5kZWxldGUoYCR7c2Vzc2lvbklkfVxcMCR7cnVuSWR9YCk7XG4gICAgICAvLyBcdTRFQTRcdTRFRDhcdTcyNjlcdTUxNDhcdTRFOEVcdTdFQzhcdTYwMDEoXHU0RTBFIGhtaGFybmVzcyBkZXNrdG9wIFx1Njg2NVx1NTQwQ1x1NUU4RjphcnRpZmFjdC5jcmVhdGVkIFx1MjE5MiBydW4uY29tcGxldGVkKVxuICAgICAgZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAnYXJ0aWZhY3QuY3JlYXRlZCcsIHtcbiAgICAgICAgYXJ0aWZhY3Q6IHsgcmVsUGF0aDogJ291dC50eHQnLCBraW5kOiAnZmlsZScsIHRpdGxlOiAnb3V0LnR4dCcgfSxcbiAgICAgIH0pO1xuICAgICAgZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAncnVuLmNvbXBsZXRlZCcsIHsgdGV4dDogYW5zd2VyLCB0dXJuczogMSwgdG9vbFVzZXMgfSk7XG4gICAgfTtcblxuICAgIGNvbnN0IHNjcmlwdGVkOiBBcnJheTwoKSA9PiB2b2lkPiA9IFtcbiAgICAgICgpID0+IGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ3Rvb2wuc3RhcnRlZCcsIHsgbmFtZTogJ3JlYWRfZmlsZScsIGFyZ3NQcmV2aWV3OiAne1wicGF0aFwiOlwiUkVBRE1FLm1kXCJ9JyB9KSxcbiAgICAgICgpID0+IGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ3Rvb2wuY29tcGxldGVkJywgeyBuYW1lOiAncmVhZF9maWxlJywgaXNFcnJvcjogZmFsc2UsIG91dHB1dFByZXZpZXc6ICcjIGRlbW8nIH0pLFxuICAgIF07XG5cbiAgICBpZiAobW9kZSA9PT0gJ2FzaycpIHtcbiAgICAgIHNjcmlwdGVkLnB1c2goKCkgPT4ge1xuICAgICAgICBjb25zdCBhcHByb3ZhbElkID0gYGFwLSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMiwgOCl9YDtcbiAgICAgICAgZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAnYXBwcm92YWwucmVxdWlyZWQnLCB7XG4gICAgICAgICAgYXBwcm92YWxJZCxcbiAgICAgICAgICB0b29sOiAnd3JpdGVfZmlsZScsXG4gICAgICAgICAgYXJnc1ByZXZpZXc6ICd7XCJwYXRoXCI6XCJvdXQudHh0XCIsXCJjb250ZW50XCI6XCJoaVwifScsXG4gICAgICAgICAgcmlzazogJ1x1NTE5OVx1NTE2NVx1NURFNVx1NEY1Q1x1NTMzQVx1NjU4N1x1NEVGNiBvdXQudHh0KFx1NkEyMVx1NjJERiknLFxuICAgICAgICB9KTtcbiAgICAgICAgcGVuZGluZyA9IHtcbiAgICAgICAgICBzZXNzaW9uSWQsXG4gICAgICAgICAgYXBwcm92YWxJZCxcbiAgICAgICAgICByZXNvbHZlOiAoZ3JhbnRlZCkgPT4ge1xuICAgICAgICAgICAgcGVuZGluZyA9IG51bGw7XG4gICAgICAgICAgICBpZiAoZ3JhbnRlZCkge1xuICAgICAgICAgICAgICBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICd0b29sLnN0YXJ0ZWQnLCB7IG5hbWU6ICd3cml0ZV9maWxlJywgYXJnc1ByZXZpZXc6ICd7XCJwYXRoXCI6XCJvdXQudHh0XCJ9JyB9KTtcbiAgICAgICAgICAgICAgd2FpdCgoKSA9PiBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICd0b29sLmNvbXBsZXRlZCcsIHsgbmFtZTogJ3dyaXRlX2ZpbGUnLCBpc0Vycm9yOiBmYWxzZSwgb3V0cHV0UHJldmlldzogJ3dyb3RlIDIgYnl0ZXMnIH0pKTtcbiAgICAgICAgICAgICAgd2FpdCgoKSA9PiBmaW5pc2hSdW4oYGVjaG86ICR7dGV4dH0oXHU1REYyXHU2MjY3XHU4ODRDXHU1MTk5XHU1MTY1KWAsIDMpLCB0YXNrRGVsYXkgKiAyKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIGZpbmlzaFJ1bihgZWNobzogJHt0ZXh0fShcdTVCQTFcdTYyNzlcdTg4QUJcdTYyRDJcdTdFREQsXHU2NzJBXHU2MjY3XHU4ODRDXHU1MTk5XHU1MTY1KWAsIDEpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0sXG4gICAgICAgIH07XG4gICAgICB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgc2NyaXB0ZWQucHVzaCgoKSA9PiBmaW5pc2hSdW4oYGVjaG86ICR7dGV4dH1gLCAxKSk7XG4gICAgfVxuICAgIGNoYWluKHNjcmlwdGVkKTtcbiAgICByZXR1cm4gcnVuSWQ7XG4gIH07XG5cbiAgY29uc3Qgc2VydmVyID0gY3JlYXRlU2VydmVyKChyZXEsIHJlcykgPT4ge1xuICAgIGNvbnN0IHVybCA9IG5ldyBVUkwocmVxLnVybCA/PyAnLycsICdodHRwOi8vMTI3LjAuMC4xJyk7XG4gICAgY29uc3QgYXV0aG9yaXplZCA9IHJlcS5oZWFkZXJzWyd4LWhtaC1rZXknXSA9PT0gZXhwZWN0ZWQ7XG4gICAgY29uc3QgZGVueSA9ICgpOiB2b2lkID0+IHtcbiAgICAgIHJlcy53cml0ZUhlYWQoNDAxLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignQVVUSF9GQUlMRUQnLCAnbWlzc2luZyBvciBpbnZhbGlkIHgtaG1oLWtleScsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgIH07XG5cbiAgICBjb25zdCByZWFkQm9keSA9ICgpOiBQcm9taXNlPHN0cmluZz4gPT5cbiAgICAgIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG4gICAgICAgIGxldCBiID0gJyc7XG4gICAgICAgIHJlcS5vbignZGF0YScsIChjOiBCdWZmZXIpID0+IHsgYiArPSBjLnRvU3RyaW5nKCk7IH0pO1xuICAgICAgICByZXEub24oJ2VuZCcsICgpID0+IHJlc29sdmUoYikpO1xuICAgICAgfSk7XG5cbiAgICBpZiAodXJsLnBhdGhuYW1lID09PSAnL2FwaS9ldmVudHMnKSB7XG4gICAgICBpZiAoIWF1dGhvcml6ZWQpIHsgZGVueSgpOyByZXR1cm47IH1cbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAndGV4dC9ldmVudC1zdHJlYW0nLCAnY2FjaGUtY29udHJvbCc6ICduby1jYWNoZScsIGNvbm5lY3Rpb246ICdrZWVwLWFsaXZlJyB9KTtcbiAgICAgIHJlcy5mbHVzaEhlYWRlcnM/LigpO1xuICAgICAgc3NlQ2xpZW50cy5hZGQocmVzKTtcbiAgICAgIC8vIFx1NjVBRFx1N0VCRlx1ODg2NVx1NjJDOTpMYXN0LUV2ZW50LUlEIFx1NEU0Qlx1NTI0RFx1NzY4NFx1NUUyN1x1NURGMlx1NTcyOFx1NUJBMlx1NjIzN1x1N0FFRixcdTkxQ0RcdTUzRDFcdTUxNzZcdTU0MEVcdTc2ODRcdTczQUZcdTVGNjJcdTdGMTNcdTUxQjJcbiAgICAgIGNvbnN0IGxhc3RJZCA9IE51bWJlcihyZXEuaGVhZGVyc1snbGFzdC1ldmVudC1pZCddID8/IDApO1xuICAgICAgaWYgKE51bWJlci5pc0Zpbml0ZShsYXN0SWQpICYmIGxhc3RJZCA+IDApIHtcbiAgICAgICAgZm9yIChjb25zdCBlIG9mIHJpbmcpIHtcbiAgICAgICAgICBpZiAoZS5pZCA+IGxhc3RJZCkgcmVzLndyaXRlKGBpZDogJHtlLmlkfVxcbmV2ZW50OiAke2UuZXZlbnR9XFxuZGF0YTogJHtKU09OLnN0cmluZ2lmeShlLmRhdGEpfVxcblxcbmApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICByZXEub24oJ2Nsb3NlJywgKCkgPT4gc3NlQ2xpZW50cy5kZWxldGUocmVzKSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICghYXV0aG9yaXplZCkgeyBkZW55KCk7IHJldHVybjsgfVxuXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvc3RhdGUnKSB7XG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIGRhZW1vblZlcnNpb246ICdmYWtlLTAuMC4wJywgZGVza3RvcDogdHJ1ZSwgbW9kZWw6ICdmYWtlLW1vZGVsJywgbG9jYWxlOiAnemgnLFxuICAgICAgICBidXN5U2Vzc2lvbnM6IFsuLi5zZXNzaW9ucy5rZXlzKCldLnNsaWNlKDAsIDIpLFxuICAgICAgICBhcHByb3ZhbFBlbmRpbmc6IHBlbmRpbmcgIT09IG51bGwsXG4gICAgICB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9kZXNrdG9wL3NodXRkb3duJykge1xuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSB9KSk7XG4gICAgICBzZXJ2ZXIuY2xvc2UoKCkgPT4gcHJvY2Vzcy5leGl0KDApKTtcbiAgICAgIHNldFRpbWVvdXQoKCkgPT4gcHJvY2Vzcy5leGl0KDApLCAxXzAwMCkudW5yZWYoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2Zha2UvZGllJykge1xuICAgICAgLy8gXHU2RDRCXHU4QkQ1XHU5NEE5XHU1QjUwOlx1NkEyMVx1NjJERiBob3N0IFx1NUQyOVx1NkU4MyhcdTUxNDhcdTVFOTRcdTdCNTRcdTUxOERcdTkwMDBcdTUxRkEsXHU0RkREXHU4QkMxXHU1NENEXHU1RTk0XHU1REYyXHU1M0QxXHU1MUZBKVxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSB9KSk7XG4gICAgICBzZXRUaW1lb3V0KCgpID0+IHByb2Nlc3MuZXhpdCgxKSwgNTApO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvdGFzaycpIHtcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgoYXdhaXQgcmVhZEJvZHkoKSkgfHwgJ3t9JykgYXMgeyB0ZXh0PzogdW5rbm93bjsgc2Vzc2lvbklkPzogdW5rbm93bjsgbW9kZT86IHVua25vd24gfTtcbiAgICAgICAgICBjb25zdCB0ZXh0ID0gdHlwZW9mIGJvZHkudGV4dCA9PT0gJ3N0cmluZycgPyBib2R5LnRleHQgOiAnJztcbiAgICAgICAgICBjb25zdCBzZXNzaW9uSWQgPSB0eXBlb2YgYm9keS5zZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gYm9keS5zZXNzaW9uSWQgOiBgd2ViLSR7RGF0ZS5ub3coKS50b1N0cmluZygzNil9YDtcbiAgICAgICAgICBjb25zdCBtb2RlID0gYm9keS5tb2RlID09PSAnYXNrJyB8fCBib2R5Lm1vZGUgPT09ICdhdXRvJyB8fCBib2R5Lm1vZGUgPT09ICd5b2xvJyA/IGJvZHkubW9kZSA6ICdhc2snO1xuICAgICAgICAgIGlmICghdGV4dCkge1xuICAgICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAndGV4dCByZXF1aXJlZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgICBjb25zdCBydW5JZCA9IHJ1blRhc2soc2Vzc2lvbklkLCB0ZXh0LCBtb2RlKTtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgcnVuSWQgfSkpO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCBTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgfVxuICAgICAgfSkoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2FwcHJvdmUnKSB7XG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7IGdyYW50ZWQ/OiB1bmtub3duOyBzZXNzaW9uSWQ/OiB1bmtub3duIH07XG4gICAgICAgIGNvbnN0IHNpZCA9IHR5cGVvZiBib2R5LnNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBib2R5LnNlc3Npb25JZCA6ICcnO1xuICAgICAgICBpZiAocGVuZGluZyA9PT0gbnVsbCB8fCAoc2lkICE9PSAnJyAmJiBwZW5kaW5nLnNlc3Npb25JZCAhPT0gc2lkKSkge1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICdubyBhcHByb3ZhbCBwZW5kaW5nJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHAgPSBwZW5kaW5nO1xuICAgICAgICBwZW5kaW5nID0gbnVsbDtcbiAgICAgICAgcC5yZXNvbHZlKGJvZHkuZ3JhbnRlZCA9PT0gdHJ1ZSk7XG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgZ3JhbnRlZDogYm9keS5ncmFudGVkID09PSB0cnVlIH0pKTtcbiAgICAgIH0pKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9pbnRlcnJ1cHQnKSB7XG4gICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgnJykgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47IC8vIGludGVycnVwdCBcdTY1RTAgYm9keSBcdThCRURcdTRFNDlcbiAgICAgIHZvaWQgYm9keTtcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUgfSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9zZXNzaW9ucycpIHtcbiAgICAgIGNvbnN0IGxpc3QgPSBbLi4uc2Vzc2lvbnMudmFsdWVzKCldLm1hcCgocykgPT4gKHtcbiAgICAgICAgaWQ6IHMuaWQsIHRpdGxlOiAnJywgdGFzazogJycsIG91dGNvbWU6ICdvaycsIHR1cm5zOiAxLCB0b29sVXNlczogMSxcbiAgICAgICAgdGltZTogcy51cGRhdGVkQXQsIGN3ZDogJ0M6XFxcXGRlbW8nLCBicmFuY2g6ICcnLCBjcmVhdGVkQXQ6IHMuY3JlYXRlZEF0LCB1cGRhdGVkQXQ6IHMudXBkYXRlZEF0LFxuICAgICAgfSkpO1xuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBzZXNzaW9uczogbGlzdCwgbmV4dEN1cnNvcjogbnVsbCB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUuc3RhcnRzV2l0aCgnL2FwaS9zZXNzaW9ucy8nKSkge1xuICAgICAgLy8gXHU0RjFBXHU4QkREXHU5ODg0XHU4OUM4KFx1NEUwRSBobWhhcm5lc3MgR0VUIC9hcGkvc2Vzc2lvbnMvOmlkIFx1NTQwQ1x1NUY2MjpcdTY3MDBcdTU0MEUgODAgXHU2NzYxLFx1NkJDRlx1Njc2MSA1MDAgXHU1QjU3KVxuICAgICAgY29uc3QgaWQgPSBkZWNvZGVVUklDb21wb25lbnQodXJsLnBhdGhuYW1lLnNsaWNlKCcvYXBpL3Nlc3Npb25zLycubGVuZ3RoKSkucmVwbGFjZSgvW15hLXpBLVowLTlfOi5ALV0vZywgJycpO1xuICAgICAgY29uc3QgcyA9IHNlc3Npb25zLmdldChpZCk7XG4gICAgICBpZiAocyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnc2Vzc2lvbiBub3QgZm91bmQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBpZCwgbW9kZWw6ICdmYWtlLW1vZGVsJywgY3dkOiAnQzpcXFxcZGVtbycsXG4gICAgICAgIG1lc3NhZ2VzOiBbXG4gICAgICAgICAgeyByb2xlOiAndXNlcicsIHRleHQ6ICdcdTRFNEJcdTUyNERcdTc2ODRcdTRFRkJcdTUyQTEoZmFrZSBcdTk4ODRcdTg5QzgpJywgdG9vbHM6IFtdIH0sXG4gICAgICAgICAgeyByb2xlOiAnYXNzaXN0YW50JywgdGV4dDogJ1x1OEZEOVx1NjYyRlx1NTM4Nlx1NTNGMlx1NEYxQVx1OEJERFx1NzY4NFx1NTZERVx1NTkwRFx1OTg4NFx1ODlDOChmYWtlKVx1MzAwMicsIHRvb2xzOiBbJ3JlYWRfZmlsZSddIH0sXG4gICAgICAgIF0sXG4gICAgICB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2ZzJykge1xuICAgICAgLy8gXHU3NkVFXHU1RjU1XHU2RDRGXHU4OUM4KFx1NEUwRSBobWhhcm5lc3MgXHU1NDBDXHU1RjYyOnBhdGggXHU3NzAxXHU3NTY1PVx1NjgzOTtmaWxlcz0xIFx1OTY0NFx1NUUyNlx1NjU4N1x1NEVGNlx1NTIxN1x1ODg2OClcbiAgICAgIGNvbnN0IHEgPSB1cmwuc2VhcmNoUGFyYW1zLmdldCgncGF0aCcpID8/ICcnO1xuICAgICAgY29uc3Qgd2l0aEZpbGVzID0gdXJsLnNlYXJjaFBhcmFtcy5nZXQoJ2ZpbGVzJykgPT09ICcxJztcbiAgICAgIGlmIChxID09PSAnJykge1xuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICBwYXRoOiAnJywgc2VnbWVudHM6IFtdLCBwYXJlbnQ6ICcnLFxuICAgICAgICAgIGRpcnM6IFt7IG5hbWU6ICdkZW1vLXdvcmtzcGFjZScsIHBhdGg6ICdDOlxcXFxkZW1vJyB9XSxcbiAgICAgICAgICAuLi4od2l0aEZpbGVzID8geyBmaWxlczogW10gfSA6IHt9KSxcbiAgICAgICAgfSkpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIHBhdGg6IHEsIHNlZ21lbnRzOiBbeyBuYW1lOiBxLnNwbGl0KC9bXFxcXC9dLykuZmlsdGVyKEJvb2xlYW4pLnBvcCgpID8/IHEsIHBhdGg6IHEgfV0sIHBhcmVudDogJycsXG4gICAgICAgIGRpcnM6IFt7IG5hbWU6ICdzcmMnLCBwYXRoOiBgJHtxLnJlcGxhY2UoL1tcXFxcL10kLywgJycpfVxcXFxzcmNgIH1dLFxuICAgICAgICAuLi4od2l0aEZpbGVzID8geyBmaWxlczogW1xuICAgICAgICAgIHsgbmFtZTogJ1JFQURNRS5tZCcsIHBhdGg6IGAke3EucmVwbGFjZSgvW1xcXFwvXSQvLCAnJyl9XFxcXFJFQURNRS5tZGAsIHJlbDogJ1JFQURNRS5tZCcgfSxcbiAgICAgICAgICB7IG5hbWU6ICdwYWNrYWdlLmpzb24nLCBwYXRoOiBgJHtxLnJlcGxhY2UoL1tcXFxcL10kLywgJycpfVxcXFxwYWNrYWdlLmpzb25gLCByZWw6ICdwYWNrYWdlLmpzb24nIH0sXG4gICAgICAgIF0gfSA6IHt9KSxcbiAgICAgIH0pKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZnMvcmVhZCcpIHtcbiAgICAgIC8vIFx1NjU4N1x1NEVGNlx1OTg4NFx1ODlDOCg2NEtCIFx1NEUwQVx1OTY1MFx1OEJFRFx1NEU0OTtmYWtlIFx1OEZENFx1NTZERVx1NTZGQVx1NUI5QVx1NjU4N1x1NjcyQylcbiAgICAgIGNvbnN0IHAgPSB1cmwuc2VhcmNoUGFyYW1zLmdldCgncGF0aCcpID8/ICcnO1xuICAgICAgaWYgKHAgPT09ICcnKSB7XG4gICAgICAgIHJlcy53cml0ZUhlYWQoNDAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAncGF0aCByZXF1aXJlZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIHBhdGg6IHAsIHJlbDogcC5zcGxpdCgvW1xcXFwvXS8pLnBvcCgpID8/IHAsIHNpemU6IDQyLFxuICAgICAgICB0ZXh0OiAnIyBkZW1vIHdvcmtzcGFjZVxcblxcblx1OEZEOVx1NjYyRiBmYWtlIGhvc3QgXHU3Njg0XHU2NTg3XHU0RUY2XHU5ODg0XHU4OUM4XHU1MTg1XHU1QkI5XHUzMDAyXFxuJyxcbiAgICAgIH0pKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZGlmZicpIHtcbiAgICAgIC8vIERpZmYgXHU5NzYyXHU2NzdGKFx1NEUwRSBobWhhcm5lc3MgL2FwaS9kaWZmIFx1NTQwQ1x1NUY2MjtmYWtlIFx1OEZENFx1NTZERVx1NTZGQVx1NUI5QVx1NUMwRlx1NTNEOFx1NjZGNFx1OTZDNilcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgZ2l0OiB0cnVlLCBjd2Q6ICdDOlxcXFxkZW1vJyxcbiAgICAgICAgY2hhbmdlZDogW1xuICAgICAgICAgIHsgc3RhdGU6ICdNJywgcGF0aDogJ3NyYy9hcHAudHMnIH0sXG4gICAgICAgICAgeyBzdGF0ZTogJ0EnLCBwYXRoOiAnZG9jcy9ub3Rlcy5tZCcgfSxcbiAgICAgICAgXSxcbiAgICAgICAgc3RhdDogJyBzcmMvYXBwLnRzICAgICAgfCAxMiArKysrKysrLS0tXFxuIGRvY3Mvbm90ZXMubWQgICB8ICA0ICsrKytcXG4gMiBmaWxlcyBjaGFuZ2VkLCAxNiBpbnNlcnRpb25zKCspLCAzIGRlbGV0aW9ucygtKScsXG4gICAgICB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2NvZ25pdGl2ZScpIHtcbiAgICAgIC8vIFx1OEJBNFx1NzdFNVx1NzJCNlx1NjAwMShcdTRFMEUgaG1oYXJuZXNzIGNvZ25pdGl2ZVN0YXR1cyBcdTU0MENcdTVGNjJcdTVCNTBcdTk2QzY7XHU3RjNBXHU2NTcwXHU2MzZFXHU2NjNFXHU1RjBGIG51bGwpXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIG1lbW9yeTogeyBsYXllcnM6IDMsIGVudHJpZXM6IDEyLCBjb250cmFkaWN0aW9uczogMCB9LFxuICAgICAgICB0cmFqZWN0b3JpZXM6IDcsXG4gICAgICAgIGF1ZGl0RXZlbnRzOiAyMSxcbiAgICAgICAgd29ybGRNb2RlbDogeyB2ZXJzaW9uOiA0LCBiZWxpZWZzOiA5LCB0cnVzdGVkOiA1LCBicmllcjogMC4zMSB9LFxuICAgICAgICBjYWxpYnJhdGlvbjogeyBwcmVkaWN0aW9uczogNDYsIHJlbGlhYmlsaXR5OiAwLjcyIH0sXG4gICAgICB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9mYWtlL2VtaXQnKSB7XG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoKGF3YWl0IHJlYWRCb2R5KCkpIHx8ICd7fScpIGFzIHtcbiAgICAgICAgICAgIHNlc3Npb25JZDogc3RyaW5nOyBydW5JZDogc3RyaW5nOyBraW5kOiBFdmVudEtpbmQ7IHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgICAgIH07XG4gICAgICAgICAgY29uc3Qgc2VxID0gZW1pdChib2R5LnNlc3Npb25JZCwgYm9keS5ydW5JZCwgYm9keS5raW5kLCBib2R5LnBheWxvYWQpO1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlLCBzZXEgfSkpO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCBTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgfVxuICAgICAgfSkoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgYG5vIHJvdXRlICR7cmVxLm1ldGhvZH0gJHt1cmwucGF0aG5hbWV9YCwgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gIH0pO1xuXG4gIGF3YWl0IG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICBzZXJ2ZXIub25jZSgnZXJyb3InLCByZWplY3QpO1xuICAgIHNlcnZlci5saXN0ZW4oMCwgJzEyNy4wLjAuMScsICgpID0+IHJlc29sdmUoKSk7XG4gIH0pO1xuICBjb25zdCBhZGRyZXNzID0gc2VydmVyLmFkZHJlc3MoKTtcbiAgaWYgKGFkZHJlc3MgPT09IG51bGwgfHwgdHlwZW9mIGFkZHJlc3MgIT09ICdvYmplY3QnKSB0aHJvdyBuZXcgRXJyb3IoJ2Zha2UgaG9zdDogbm8gcG9ydCcpO1xuICBjb25zdCBwb3J0ID0gYWRkcmVzcy5wb3J0O1xuXG4gIGlmICghb3B0cy5xdWlldCkge1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KHsgaG1oRGVza3RvcEhvc3RSZWFkeTogdHJ1ZSwgcG9ydCwgdmVyc2lvbjogJ2Zha2UtMC4wLjAnIH0pfVxcbmApO1xuICB9XG4gIGNvbnN0IGRpZUFmdGVyID0gTnVtYmVyKHByb2Nlc3MuZW52LkZBS0VfSE9TVF9ESUVfQUZURVJfTVMgPz8gMCk7XG4gIGlmIChOdW1iZXIuaXNGaW5pdGUoZGllQWZ0ZXIpICYmIGRpZUFmdGVyID4gMCkge1xuICAgIHNldFRpbWVvdXQoKCkgPT4gcHJvY2Vzcy5leGl0KDEpLCBkaWVBZnRlcikudW5yZWYoKTtcbiAgfVxuXG4gIC8vIGNsb3NlKCk6IFx1NTE0OFx1NjVBRFx1NUYwMFx1NTE2OFx1OTBFOCBTU0UgXHU4RkRFXHU2M0E1KFx1NUI4M1x1NEVFQ1x1NkMzOFx1NEUwRFx1ODFFQVx1NzEzNlx1NTE3M1x1OTVFRCksXHU1NDI2XHU1MjE5IHNlcnZlci5jbG9zZVxuICAvLyBcdTRGMUFcdTRFMDBcdTc2RjRcdTdCNDlcdTZEM0JcdThEQzNcdThGREVcdTYzQTUsXHU2RDRCXHU4QkQ1XHU4RkRCXHU3QTBCXHU2MzAyXHU2QjdCXHUzMDAyXG4gIGNvbnN0IGNsb3NlID0gKCk6IFByb21pc2U8dm9pZD4gPT5cbiAgICBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4ge1xuICAgICAgZm9yIChjb25zdCBjIG9mIHNzZUNsaWVudHMpIHtcbiAgICAgICAgdHJ5IHsgYy5lbmQoKTsgYy5kZXN0cm95KCk7IH0gY2F0Y2ggeyAvKiBhbHJlYWR5IGdvbmUgKi8gfVxuICAgICAgfVxuICAgICAgc3NlQ2xpZW50cy5jbGVhcigpO1xuICAgICAgc2VydmVyLmNsb3NlKCgpID0+IHJlc29sdmUoKSk7XG4gICAgICBzZXRUaW1lb3V0KCgpID0+IHJlc29sdmUoKSwgMV8wMDApLnVucmVmKCk7XG4gICAgfSk7XG5cbiAgcmV0dXJuIHsgcG9ydCwgZW1pdCwgY2xvc2UgfTtcbn1cblxuLy8gXHU3NkY0XHU2M0E1XHU4RkQwXHU4ODRDKHN1cGVydmlzb3Igc3Bhd24gXHU3Njg0XHU1QjUwXHU4RkRCXHU3QTBCXHU1RjYyXHU2MDAxKVx1MzAwMnJlYWxwYXRoIFx1NkJENFx1OEY4MzpucG0gd29ya3NwYWNlXG4vLyBqdW5jdGlvbiAvIFx1NTkyN1x1NUMwRlx1NTE5OVx1NURFRVx1NUYwMlx1OTBGRFx1NEUwRFx1ODBGRFx1OEJBOVx1OEZEOVx1NEUyQVx1NjhDMFx1NkQ0Qlx1NTkzMVx1NjI0QihcdTU5MzFcdTYyNEI9XHU5NzU5XHU5RUQ4XHU5MDAwXHU1MUZBIGNvZGUgMCxcdTk2QkVcdTY3RTUpXHUzMDAyXG4vLyBjanMgYnVuZGxlKGVzYnVpbGQsXHU2MjUzXHU1MzA1XHU0RUE3XHU1NEMxKVx1NEUwQiBfX2ZpbGVuYW1lIFx1NUI1OFx1NTcyODtFU00odHN4L1x1NkU5MFx1NzgwMSlcdTc1MjggaW1wb3J0Lm1ldGFcdTMwMDJcbmNvbnN0IHNlbGZVcmw6IHN0cmluZyA9IHR5cGVvZiBfX2ZpbGVuYW1lID09PSAnc3RyaW5nJ1xuICA/IHBhdGhUb0ZpbGVVUkwocmVhbHBhdGhTeW5jKF9fZmlsZW5hbWUpKS5ocmVmXG4gIDogaW1wb3J0Lm1ldGEudXJsO1xuY29uc3QgaW52b2tlZEFzU2NyaXB0ID0gKCgpID0+IHtcbiAgaWYgKHByb2Nlc3MuYXJndlsxXSA9PT0gdW5kZWZpbmVkKSByZXR1cm4gZmFsc2U7XG4gIHRyeSB7XG4gICAgcmV0dXJuIHNlbGZVcmwgPT09IHBhdGhUb0ZpbGVVUkwocmVhbHBhdGhTeW5jKHByb2Nlc3MuYXJndlsxXSkpLmhyZWY7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufSkoKTtcbmlmIChpbnZva2VkQXNTY3JpcHQpIHtcbiAgY29uc3QgdG9rZW4gPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9UT0tFTiA/PyAnJztcbiAgLy8gRkFLRV9IT1NUX0RJRV9BVF9CT09UPTE6XHU1RjE1XHU1QkZDXHU4ODRDXHU4RjkzXHU1MUZBXHU1MjREXHU1MzczXHU2QjdCKFx1Njc4NFx1OTAyMFx1NTQyRlx1NTJBOFx1NjcxRiBSVU5USU1FX0NSQVNIRUQpXG4gIGlmIChwcm9jZXNzLmVudi5GQUtFX0hPU1RfRElFX0FUX0JPT1QgPT09ICcxJykge1xuICAgIHByb2Nlc3MuZXhpdCgxKTtcbiAgfVxuICBjb25zdCBzbG93ID0gTnVtYmVyKHByb2Nlc3MuZW52LkZBS0VfSE9TVF9TTE9XX0FGVEVSID8/IDApO1xuICBjb25zdCBib290ID0gKCk6IHZvaWQgPT4ge1xuICAgIHZvaWQgc3RhcnRGYWtlSG9zdCh7IHRva2VuIH0pLmNhdGNoKChlcnIpID0+IHtcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBmYWtlLWhvc3QgZmFpbGVkOiAke1N0cmluZyhlcnIpfVxcbmApO1xuICAgICAgcHJvY2Vzcy5leGl0KDEpO1xuICAgIH0pO1xuICB9O1xuICBpZiAoTnVtYmVyLmlzRmluaXRlKHNsb3cpICYmIHNsb3cgPiAwKSBzZXRUaW1lb3V0KGJvb3QsIHNsb3cpO1xuICBlbHNlIGJvb3QoKTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICI7QUFjQSxTQUFTLEtB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QU0sWUFBWSxRQUFRLGdHQUF3RDtBQUNsRixhQUFPLENBQUMsUUFBUSxPQUFPLFFBQVEsSUFBSSxJQUFJLFNBQVMsRUFBRTtBQUFBLElBQ3BELENBQUM7QUFDRCxVQUFNLE1BQU0sc0VBQW1DLFlBQVk7QUFDekQsWUFBTSxJQUFLLE1BQU0sR0FBRyx5RUFBeUU7QUFDN0YsYUFBTyxDQUFDLEVBQUUsV0FBVyxHQUFHLEtBQUssRUFBRSxTQUFTLFdBQVcsR0FBRyxFQUFFLE1BQU0sR0FBRyxFQUFFLENBQUM7QUFBQSxJQUN0RSxDQUFDO0FBRUQsUUFBSSxTQUFTO0FBQ2IsZUFBVyxDQUFDLE1BQU0sSUFBSSxNQUFNLEtBQUssU0FBUztBQUN4QyxjQUFRLElBQUksaUJBQWlCLEtBQUssU0FBUyxNQUFNLE1BQU0sSUFBSSxNQUFNLE9BQU8sTUFBTSxDQUFDLEVBQUU7QUFDakYsVUFBSSxDQUFDLEdBQUksV0FBVTtBQUFBLElBQ3JCO0FBQ0EsWUFBUSxJQUFJLDhCQUE4QixRQUFRLFNBQVMsTUFBTSxJQUFJLFFBQVEsTUFBTSxFQUFFO0FBQ3JGLFFBQUksS0FBSyxXQUFXLElBQUksSUFBSSxDQUFDO0FBQUEsRUFDL0I7QUFHQSxNQUFJLEdBQUcsZUFBZSxDQUFDLE1BQU07QUFDM0IsUUFBSSxlQUFlLFFBQVEsV0FBVyxVQUFVLFdBQVc7QUFDekQsUUFBRSxlQUFlO0FBQ2pCLGdCQUFVLE1BQU07QUFDaEIsV0FBSyxXQUFXLEtBQUssRUFBRSxRQUFRLE1BQU0sSUFBSSxLQUFLLENBQUM7QUFBQSxJQUNqRDtBQUFBLEVBQ0YsQ0FBQztBQUNELE1BQUksR0FBRyxxQkFBcUIsTUFBTTtBQUNoQyxRQUFJLFFBQVEsYUFBYSxTQUFVLEtBQUksS0FBSztBQUFBLEVBQzlDLENBQUM7QUFDSDtBQTFYVztBQWVBO0FBa0hBO0FBWUE7QUFXQTtBQXFFQTsiLAogICJuYW1lcyI6IFsicGF0aFRvRmlsZVVSTCIsICJwdXNoRXZlbnQiLCAiYnJvYWRjYXN0SG9zdFN0YXRlIiwgInNlbmRlclRydXN0ZWQiLCAiaG9zdENhbGwiLCAicmVnaXN0ZXJJcGMiLCAiY3JlYXRlV2luZG93IiwgInBhdGhUb0ZpbGVVUkwiXQp9Cg==
