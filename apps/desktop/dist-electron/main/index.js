// apps/desktop/electron/main/index.ts
import { app, BrowserWindow, dialog, ipcMain, session, shell } from "electron";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
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
  /** 拉取纯文本端点(如 /api/sessions/:id/export.md)。 */
  async getText(path, timeoutMs = 1e4) {
    let res;
    try {
      res = await fetch(`${this.baseUrl}${path}`, { headers: this.headers(), signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new DesktopHttpError(desktopError("HOST_NOT_READY", `request failed: ${String(err).slice(0, 160)}`, { retryable: true, recoveryAction: "RECONNECT" }));
    }
    if (res.status === 401 || res.status === 403) {
      throw new DesktopHttpError(desktopError("AUTH_FAILED", `host rejected the session token (HTTP ${res.status})`, { retryable: false, recoveryAction: "RECONNECT" }));
    }
    if (!res.ok) {
      throw new DesktopHttpError(desktopError("HOST_NOT_READY", `HTTP ${res.status}`, { retryable: res.status >= 500 }));
    }
    return res.text();
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
    if (req.method === "POST" && url.pathname === "/api/inject") {
      void readBody();
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
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
      const seg = decodeURIComponent(url.pathname.slice("/api/sessions/".length));
      const exportMatch = /^(.*)\/export\.md$/.exec(seg) ?? /^(.*)\.export\.md$/.exec(seg);
      if (exportMatch !== null && exportMatch[1] !== void 0 && exportMatch[1] !== "") {
        const eid = exportMatch[1].replace(/[^a-zA-Z0-9_:.@-]/g, "");
        const es = sessions.get(eid);
        if (es === void 0) {
          res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(desktopError("SCHEMA_MISMATCH", "session not found", { retryable: false })));
          return;
        }
        res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
        res.end(`# hmharness \u4F1A\u8BDD\u5BFC\u51FA(fake)

- \u4F1A\u8BDD:${eid}

## \u7528\u6237

\u4E4B\u524D\u7684\u4EFB\u52A1(fake \u9884\u89C8)

## \u52A9\u624B

\u8FD9\u662F\u5BFC\u51FA\u7684\u56DE\u590D\u9884\u89C8(fake)\u3002
`);
        return;
      }
      const id = seg.replace(/[^a-zA-Z0-9_:.@-]/g, "");
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
    ipcMain.handle("bridge:inject", (event, text, sessionId) => {
      const t = typeof text === "string" ? text.slice(0, 2e4) : "";
      const sid = typeof sessionId === "string" ? sessionId.slice(0, 80) : "";
      if (t === "" || sid === "") return Promise.resolve({ ok: false, code: "BAD_REQUEST" });
      return hostCall2(event, (c) => c.postJson("/api/inject", { text: t, sessionId: sid }));
    });
    ipcMain.handle("bridge:export-session", async (event, id) => {
      if (!senderTrusted2(event.senderFrame)) return { error: "untrusted sender", code: "FORBIDDEN" };
      const sid = typeof id === "string" ? id.replace(/[^a-zA-Z0-9_:.@-]/g, "").slice(0, 80) : "";
      if (sid === "") return { error: "id required", code: "BAD_REQUEST" };
      if (client === null || bridge.hostState !== "ready") return { error: `host not ready (${bridge.hostState})`, code: "HOST_NOT_READY" };
      try {
        const md = await client.getText(`/api/sessions/${encodeURIComponent(sid)}/export.md`);
        const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
        if (win === void 0) return { error: "no window", code: "BRIDGE_ERROR" };
        const r = await dialog.showSaveDialog(win, {
          title: "\u5BFC\u51FA\u4F1A\u8BDD",
          defaultPath: `hmh-${sid}.md`,
          filters: [{ name: "Markdown", extensions: ["md"] }]
        });
        if (r.canceled || r.filePath === void 0 || r.filePath === "") return { ok: false, canceled: true };
        await writeFile(r.filePath, md, "utf8");
        logInfo("export", `session ${sid} \u2192 ${r.filePath}`);
        return { ok: true, path: r.filePath };
      } catch (err) {
        const detail = (() => {
          try {
            return JSON.stringify(err);
          } catch {
            return String(err);
          }
        })().slice(0, 300);
        return { error: detail, code: "BRIDGE_ERROR" };
      }
    });
    ipcMain.handle("bridge:approval-get", (event) => hostCall2(event, (c) => c.getJson("/api/state")));
    ipcMain.handle("bridge:approval-set", (event, mode) => {
      const m = mode === "auto" ? "auto" : mode === "ask" ? "ask" : "";
      if (m === "") return Promise.resolve({ error: "mode must be ask|auto", code: "BAD_REQUEST" });
      return hostCall2(event, (c) => c.postJson("/api/config", { approval: m }));
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
      const allow = ["approve", "approvalGet", "approvalSet", "cognitive", "diff", "exportSession", "fsList", "fsRead", "getState", "inject", "interrupt", "onEventBatches", "onHostState", "onStreamChunks", "sendTask", "sessionPreview", "sessions", "stopHost"];
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
    await check("XSS:\u6076\u610F\u4EFB\u52A1\u6587\u672C\u53EA\u4EE5\u6587\u672C\u6E32\u67D3(\u4E0D\u6267\u884C)", async () => {
      const payload = `<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>"&'`;
      const sendR = await js(`window.hmh.sendTask(${JSON.stringify(payload)}, 'sec-xss-1', 'auto').then(r=>JSON.stringify(r)).catch(e=>'ERR:'+e)`);
      if (!sendR.includes('"ok":true')) return [false, `sendTask \u672A\u53D7\u7406: ${sendR.slice(0, 80)}`];
      await new Promise((r2) => setTimeout(r2, 3e3));
      const probe = await js(`JSON.stringify({
        xssFlag: typeof window.__xss,
        imgCount: document.querySelectorAll('img[src="x"]').length,
        scriptRan: document.body.innerText.indexOf('window.__xss=2') >= 0
      })`);
      const p = JSON.parse(probe);
      return [p.xssFlag === "undefined" && p.imgCount === 0, `xssFlag=${p.xssFlag} img=${p.imgCount}`];
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vZWxlY3Ryb24vbWFpbi9pbmRleC50cyIsICIuLi8uLi8uLi8uLi9wYWNrYWdlcy9ob3N0LWFkYXB0ZXIvc3JjL3N1cGVydmlzb3IudHMiLCAiLi4vLi4vLi4vLi4vcGFja2FnZXMvY29udHJhY3RzL3NyYy9ldmVudC50cyIsICIuLi8uLi8uLi8uLi9wYWNrYWdlcy9jb250cmFjdHMvc3JjL2Vycm9yLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2NvbnRyYWN0cy9zcmMvZ3VhcmRzLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2hvc3QtYWRhcHRlci9zcmMvY2xpZW50LnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2hvc3QtYWRhcHRlci9zcmMvZmFrZS1ob3N0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIEhNSCBEZXNrdG9wIFx1MjAxNCBFbGVjdHJvbiBcdTRFM0JcdThGREJcdTdBMEIoQURSLTAwMS8wMDMvMDA0KVx1MzAwMlxuICpcbiAqIFx1NUI4OVx1NTE2OFx1NEUwRFx1NTNEOFx1OTFDRihcdTVGMDBcdTUzRDFcdThCQTFcdTUyMTIgTTAgXHU1MUZBXHU1M0UzXHU5NUU4ICsgRWxlY3Ryb24gXHU1Qjk4XHU2NUI5XHU1Qjg5XHU1MTY4XHU2RTA1XHU1MzU1KTpcbiAqICAtIHJlbmRlcmVyOmNvbnRleHRJc29sYXRpb24gKyBzYW5kYm94ICsgXHU3OTgxIG5vZGVJbnRlZ3JhdGlvbixcdTRFMjVcdTY4M0MgQ1NQO1xuICogIC0gXHU1QkZDXHU4MjJBL1x1NjVCMFx1N0E5N1x1NTNFM1x1NEUwMFx1NUY4Qlx1NjJEMlx1N0VERChcdTUzRUFcdTUyQTBcdThGN0RcdTYyMTFcdTRFRUNcdTgxRUFcdTVERjFcdTc2ODQgcmVuZGVyZXIpO1xuICogIC0gXHU2QkNGXHU2NzYxIElQQyBcdTY4MjFcdTlBOEMgc2VuZGVyIFx1NzY4NFx1OTg3Nlx1NUM0MiBmcmFtZSBVUkwgXHU1QzVFXHU0RThFXHU2NzJDXHU1RTk0XHU3NTI4LFx1OTAxQVx1OTA1M1x1NzY3RFx1NTQwRFx1NTM1NTtcbiAqICAtIGhvc3QgdG9rZW4gXHU1M0VBXHU1QjU4XHU1NzI4XHU0RThFXHU2NzJDXHU4RkRCXHU3QTBCXHU0RTBFXHU1QjUwXHU4RkRCXHU3QTBCIGVudixcdTY1RTVcdTVGRDdcdThGOTNcdTUxRkFcdTUyNERcdTUxNDhcdTgxMzFcdTY1NEY7XG4gKiAgLSBcdTUzNTVcdTVCOUVcdTRGOEJcdTk1MDE7XHU5MDAwXHU1MUZBXHU2NUY2XHU1M0VBXHU1MDVDXHU2QjYyXHU4MUVBXHU1REYxIHNwYXduIFx1NzY4NCBob3N0KFx1NEYxOFx1OTZDNVx1MjE5Mlx1NTE1Q1x1NUU5NSBraWxsKVx1MzAwMlxuICpcbiAqIFx1OTYzNlx1NkJCNUUoMjAyNi0xMC0xMCk6bWFpbiBcdTYzMDFcdTY3MDkgRGVza3RvcEhvc3RDbGllbnQsU1NFIFx1NEZFMVx1NUMwMVx1NkQ0MShldmVudDogaG1oKVxuICogXHU3RUNGIDUwbXMgXHU2Mjc5XHU5MUNGXHU2M0E4XHU3RUQ5IHJlbmRlcmVyO3NlbmRUYXNrL2FwcHJvdmUvaW50ZXJydXB0L3Nlc3Npb25zIFx1NTE2OFx1OTBFOFx1OEY2Q1x1NTNEMVxuICogXHU3RUQ5IGhvc3QgXHUyMDE0XHUyMDE0IGZha2UgXHU0RTBFXHU3NzFGXHU1QjlFIGhtaGFybmVzcyBkZXNrdG9wLWhvc3QgXHU4RDcwXHU1NDBDXHU0RTAwXHU2NzYxXHU0RUUzXHU3ODAxXHU4REVGXHU1Rjg0XHUzMDAyXG4gKi9cbmltcG9ydCB7IGFwcCwgQnJvd3NlcldpbmRvdywgZGlhbG9nLCBpcGNNYWluLCBzZXNzaW9uLCBzaGVsbCB9IGZyb20gJ2VsZWN0cm9uJztcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdub2RlOnBhdGgnO1xuaW1wb3J0IHsgd3JpdGVGaWxlIH0gZnJvbSAnbm9kZTpmcy9wcm9taXNlcyc7XG5pbXBvcnQgeyBwYXRoVG9GaWxlVVJMIH0gZnJvbSAnbm9kZTp1cmwnO1xuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gJ25vZGU6Y3J5cHRvJztcbmltcG9ydCB7IERlc2t0b3BSdW50aW1lU3VwZXJ2aXNvciwgRGVza3RvcEhvc3RDbGllbnQsIGVudmVsb3BlRnJvbUZyYW1lLCB0eXBlIEhvc3RTdGF0ZSB9IGZyb20gJ0BobWgtZGVza3RvcC9ob3N0LWFkYXB0ZXInO1xuaW1wb3J0IHsgaXNFdmVudEVudmVsb3BlLCB0eXBlIEV2ZW50RW52ZWxvcGUgfSBmcm9tICdAaG1oLWRlc2t0b3AvY29udHJhY3RzJztcblxuY29uc3QgaGVyZSA9IGltcG9ydC5tZXRhLmRpcm5hbWUgPz8gJy4nO1xuY29uc3QgaXNEZXYgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9ERVYgPT09ICcxJztcbmNvbnN0IHJlbmRlcmVyRGV2VXJsID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfUkVOREVSRVJfVVJMID8/ICcnO1xuY29uc3QgcHJlbG9hZFBhdGggPSBqb2luKGhlcmUsICcuLi9wcmVsb2FkL2luZGV4LmNqcycpO1xuXG4vKiAtLS0tIFx1NjVFNVx1NUZEN1x1ODEzMVx1NjU0Rjp0b2tlbi9hdXRob3JpemF0aW9uIFx1NkMzOFx1NEUwRFx1OEZEQlx1NjNBN1x1NTIzNlx1NTNGMCAtLS0tICovXG5jb25zdCBzZWNyZXRzOiBzdHJpbmdbXSA9IFtdO1xuZnVuY3Rpb24gcmVkYWN0KHM6IHN0cmluZyk6IHN0cmluZyB7XG4gIGxldCBvdXQgPSBzO1xuICBmb3IgKGNvbnN0IHNlYyBvZiBzZWNyZXRzKSB7XG4gICAgaWYgKHNlYy5sZW5ndGggPj0gOCkgb3V0ID0gb3V0LnNwbGl0KHNlYykuam9pbignW3JlZGFjdGVkXScpO1xuICB9XG4gIHJldHVybiBvdXQ7XG59XG5mdW5jdGlvbiBsb2dJbmZvKHRhZzogc3RyaW5nLCBtc2c6IHN0cmluZyk6IHZvaWQge1xuICBjb25zb2xlLmxvZyhgW2htaC1kZXNrdG9wOiR7dGFnfV0gJHtyZWRhY3QobXNnKX1gKTtcbn1cblxuLyogLS0tLSBcdTUzNTVcdTVCOUVcdTRGOEIgLS0tLSAqL1xuaWYgKCFhcHAucmVxdWVzdFNpbmdsZUluc3RhbmNlTG9jaygpKSB7XG4gIGFwcC5xdWl0KCk7XG59IGVsc2Uge1xuICBhcHAub24oJ3NlY29uZC1pbnN0YW5jZScsICgpID0+IHtcbiAgICBjb25zdCB3aW4gPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKVswXTtcbiAgICBpZiAod2luKSB7XG4gICAgICBpZiAod2luLmlzTWluaW1pemVkKCkpIHdpbi5yZXN0b3JlKCk7XG4gICAgICB3aW4uZm9jdXMoKTtcbiAgICB9XG4gIH0pO1xuXG4gIC8qIC0tLS0gaG9zdCBcdTc2RDFcdTdCQTEgKyBcdTY4NjVcdTVCQTJcdTYyMzdcdTdBRUYgLS0tLSAqL1xuICBpbnRlcmZhY2UgQnJpZGdlU25hcHNob3Qge1xuICAgIGhvc3RTdGF0ZTogSG9zdFN0YXRlO1xuICAgIGhvc3RQb3J0OiBudW1iZXIgfCBudWxsO1xuICAgIGhvc3RWZXJzaW9uOiBzdHJpbmcgfCBudWxsO1xuICAgIGxhc3RFcnJvcjogc3RyaW5nIHwgbnVsbDtcbiAgICBtb2RlOiAnZmFrZScgfCAncmVhbCc7XG4gIH1cbiAgbGV0IHN1cGVydmlzb3I6IERlc2t0b3BSdW50aW1lU3VwZXJ2aXNvciB8IG51bGwgPSBudWxsO1xuICBsZXQgY2xpZW50OiBEZXNrdG9wSG9zdENsaWVudCB8IG51bGwgPSBudWxsO1xuICBsZXQgYnJpZGdlOiBCcmlkZ2VTbmFwc2hvdCA9IHsgaG9zdFN0YXRlOiAnc3RvcHBlZCcsIGhvc3RQb3J0OiBudWxsLCBob3N0VmVyc2lvbjogbnVsbCwgbGFzdEVycm9yOiBudWxsLCBtb2RlOiAnZmFrZScgfTtcbiAgLyoqIFx1NEU4Qlx1NEVGNlx1NjI3OVx1OTFDRlx1N0YxM1x1NTFCMjpcdTlBRDhcdTk4OTEgU1NFIFx1NEUwRFx1OTAxMFx1Njc2MVx1OEZDNyBJUEMsNTBtcyBcdTYyNzlcdTkxQ0YgZmx1c2goXHU2RTMyXHU2N0QzXHU0RTBEXHU1MzYxKVx1MzAwMiAqL1xuICBsZXQgZXZlbnRCdWZmZXI6IEV2ZW50RW52ZWxvcGVbXSA9IFtdO1xuICBsZXQgZmx1c2hUaW1lcjogTm9kZUpTLlRpbWVvdXQgfCBudWxsID0gbnVsbDtcbiAgbGV0IHNzZUFib3J0OiBBYm9ydENvbnRyb2xsZXIgfCBudWxsID0gbnVsbDtcbiAgbGV0IGxhc3RFdmVudElkID0gJyc7XG4gIC8qKiBcdTY3MkFcdTc3RTUvXHU3NTc4XHU1RjYyXHU0RkUxXHU1QzAxXHU4QkExXHU2NTcwKFNDSEVNQV9NSVNNQVRDSCBcdTk3NjJcdTU0MTFcdThCQ0FcdTY1QUQsXHU0RTBEXHU1RDI5KVx1MzAwMiAqL1xuICBsZXQgZHJvcHBlZEZyYW1lcyA9IDA7XG5cbiAgZnVuY3Rpb24gcHVzaEV2ZW50KGVudjogRXZlbnRFbnZlbG9wZSk6IHZvaWQge1xuICAgIGV2ZW50QnVmZmVyLnB1c2goZW52KTtcbiAgICBpZiAoZXZlbnRCdWZmZXIubGVuZ3RoID4gMl8wMDApIGV2ZW50QnVmZmVyLnNwbGljZSgwLCBldmVudEJ1ZmZlci5sZW5ndGggLSAyXzAwMCk7XG4gICAgaWYgKGZsdXNoVGltZXIgPT09IG51bGwpIHtcbiAgICAgIGZsdXNoVGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgZmx1c2hUaW1lciA9IG51bGw7XG4gICAgICAgIGNvbnN0IGJhdGNoID0gZXZlbnRCdWZmZXI7XG4gICAgICAgIGV2ZW50QnVmZmVyID0gW107XG4gICAgICAgIGZvciAoY29uc3QgdyBvZiBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKSkge1xuICAgICAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ2JyaWRnZTpldmVudC1iYXRjaCcsIGJhdGNoKTtcbiAgICAgICAgfVxuICAgICAgfSwgNTApO1xuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIGJyb2FkY2FzdEhvc3RTdGF0ZShzOiBIb3N0U3RhdGUsIGluZm86IHsgcmVzdGFydENvdW50OiBudW1iZXI7IGxhc3RFcnJvcj86IHN0cmluZyB9KTogdm9pZCB7XG4gICAgYnJpZGdlID0geyAuLi5icmlkZ2UsIGhvc3RTdGF0ZTogcywgaG9zdFBvcnQ6IHN1cGVydmlzb3I/LmVuZHBvaW50Py5wb3J0ID8/IG51bGwsIGhvc3RWZXJzaW9uOiBzdXBlcnZpc29yPy5lbmRwb2ludD8udmVyc2lvbiA/PyBudWxsIH07XG4gICAgbG9nSW5mbygnaG9zdCcsIGBzdGF0ZT0ke3N9JHtpbmZvLmxhc3RFcnJvciAhPT0gdW5kZWZpbmVkID8gYCBlcnI9JHtpbmZvLmxhc3RFcnJvcn1gIDogJyd9YCk7XG4gICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XG4gICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCdicmlkZ2U6aG9zdC1zdGF0ZScsIHMsIGluZm8pO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBTU0UgXHU2RDQxXHU4QkEyXHU5NjA1Olx1NEZFMVx1NUMwMShldmVudDogaG1oKVx1NjI3OVx1OTFDRlx1NjNBOCByZW5kZXJlcjtcdTlBRDhcdTk4OTEgZGVsdGEvbGluZSBcdTUzOUZcdTVFMjdcbiAgICogIFx1NEY1Q1x1NEUzQVx1NkQ0MVx1NTc1N1x1OEY2Q1x1NTNEMShyZW5kZXJlciBcdTYyRkNcdTYzQTVcdTVGNTNcdTUyNEQgYXNzaXN0YW50IFx1NTM2MFx1NEY0RClcdTMwMDJcdTY1QURcdTdFQkZcdTgxRUFcdTUyQThcdTkxQ0RcdThGREVcdTMwMDIgKi9cbiAgYXN5bmMgZnVuY3Rpb24gcHVtcEV2ZW50cygpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAoY2xpZW50ID09PSBudWxsKSByZXR1cm47XG4gICAgZm9yICg7Oykge1xuICAgICAgY29uc3QgYyA9IGNsaWVudDtcbiAgICAgIGlmIChjID09PSBudWxsKSByZXR1cm47XG4gICAgICB0cnkge1xuICAgICAgICBmb3IgYXdhaXQgKGNvbnN0IGZyYW1lIG9mIGMucmF3RXZlbnRzKGxhc3RFdmVudElkID09PSAnJyA/IHVuZGVmaW5lZCA6IGxhc3RFdmVudElkLCBzc2VBYm9ydD8uc2lnbmFsKSkge1xuICAgICAgICAgIGlmIChmcmFtZS5ldmVudCA9PT0gJ2htaCcpIHtcbiAgICAgICAgICAgIGNvbnN0IGVudiA9IGVudmVsb3BlRnJvbUZyYW1lKGZyYW1lKTtcbiAgICAgICAgICAgIGlmIChlbnYgPT09IG51bGwpIHtcbiAgICAgICAgICAgICAgZHJvcHBlZEZyYW1lcyArPSAxO1xuICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGxhc3RFdmVudElkID0gZW52LmV2ZW50SWQ7XG4gICAgICAgICAgICBwdXNoRXZlbnQoZW52KTtcbiAgICAgICAgICB9IGVsc2UgaWYgKGZyYW1lLmV2ZW50ID09PSAnZGVsdGEnIHx8IGZyYW1lLmV2ZW50ID09PSAnbGluZScpIHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIGNvbnN0IGQgPSBKU09OLnBhcnNlKGZyYW1lLmRhdGEpIGFzIHsgc2Vzc2lvbklkPzogc3RyaW5nOyBrPzogc3RyaW5nOyBjaHVuaz86IHN0cmluZzsgdGV4dD86IHN0cmluZyB9O1xuICAgICAgICAgICAgICBjb25zdCBwYXlsb2FkID0gZnJhbWUuZXZlbnQgPT09ICdkZWx0YSdcbiAgICAgICAgICAgICAgICA/IHsgc2Vzc2lvbklkOiBkLnNlc3Npb25JZCA/PyAnJywga2luZDogZC5rID8/ICd0ZXh0JywgY2h1bms6IFN0cmluZyhkLmNodW5rID8/ICcnKSB9XG4gICAgICAgICAgICAgICAgOiB7IHNlc3Npb25JZDogZC5zZXNzaW9uSWQgPz8gJycsIGtpbmQ6ICdsaW5lJywgY2h1bms6IFN0cmluZyhkLnRleHQgPz8gJycpIH07XG4gICAgICAgICAgICAgIGZvciAoY29uc3QgdyBvZiBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKSkge1xuICAgICAgICAgICAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ2JyaWRnZTpzdHJlYW0tY2h1bmsnLCBwYXlsb2FkKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBjYXRjaCB7IC8qIG1hbGZvcm1lZCBzdHJlYW0gZnJhbWU6IHNraXAgKi8gfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICByZXR1cm47IC8vIFx1NkQ0MVx1NkI2M1x1NUUzOFx1N0VEM1x1Njc1Rihob3N0IFx1NTE3M1x1OTVFRClcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvLyBcdTY1QURcdTdFQkY6XHU3N0VEXHU5MDAwXHU5MDdGXHU1NDBFXHU5MUNEXHU4RkRFKHN1cGVydmlzb3IgXHU1M0VGXHU4MEZEXHU2QjYzXHU1NzI4XHU5MUNEXHU1NDJGIGhvc3QpXG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDFfMDAwKSk7XG4gICAgICAgIGlmIChzc2VBYm9ydD8uc2lnbmFsLmFib3J0ZWQpIHJldHVybjtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvKiogZGV2IFx1OUVEOFx1OEJBNCBmYWtlIGhvc3Q7SE1IX0RFU0tUT1BfUkVBTD0xIFx1NjVGNlx1OEZERVx1NzcxRlx1NUI5RSBobWhhcm5lc3MgZGVza3RvcC1ob3N0XHUzMDAyXG4gICAqICBcdTZDRThcdTYxMEY6RWxlY3Ryb24gXHU0RTNCXHU4RkRCXHU3QTBCXHU3Njg0IHByb2Nlc3MuZXhlY1BhdGggXHU2NjJGIGVsZWN0cm9uLmV4ZVx1MjAxNFx1MjAxNGhvc3QgXHU1QjUwXHU4RkRCXHU3QTBCXG4gICAqICBcdTVGQzVcdTk4N0JcdTVFMjYgRUxFQ1RST05fUlVOX0FTX05PREU9MSBcdTYyNERcdTRGMUFcdTRFRTVcdTdFQUYgbm9kZSBcdThCRURcdTRFNDlcdThERDFcdTMwMDJcbiAgICogIFx1NjI1M1x1NTMwNVx1NEVBN1x1NTRDMShhcHAuaXNQYWNrYWdlZCk6ZmFrZSBob3N0IFx1NzUyOCBleHRyYVJlc291cmNlcyBcdTkxQ0NcdTc2ODRcdTgxRUFcdTUzMDVcdTU0MkIgY2pzO1xuICAgKiAgXHU3NzFGXHU1QjlFIHJ1bnRpbWUgXHU5NzAwIEhNSF9ERVNLVE9QX1JFQUxfRU5UUlkgXHU2MzA3XHU1NDExIGRlc2t0b3AtaG9zdCBcdTUxNjVcdTUzRTMoXHU0RUE3XHU1NEMxXHU1MzE2XG4gICAqICBcdTc2ODQgcnVudGltZSBcdTYzNDZcdTdFRDFcdTVDNUVcdTU0MEVcdTdFRURcdThCQkVcdThCQTEsXHU4OUMxXHU5QThDXHU2NTM2XHU2MkE1XHU1NDRBKVx1MzAwMiAqL1xuICBhc3luYyBmdW5jdGlvbiBzdGFydEhvc3QoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgdXNlUmVhbCA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1JFQUwgPT09ICcxJztcbiAgICBicmlkZ2UgPSB7IC4uLmJyaWRnZSwgbW9kZTogdXNlUmVhbCA/ICdyZWFsJyA6ICdmYWtlJyB9O1xuICAgIGNvbnN0IHJlcG9Sb290ID0gam9pbihoZXJlLCAnLi4nLCAnLi4nLCAnLi4nLCAnLi4nKTsgLy8gYXBwcy9kZXNrdG9wL2Rpc3QtZWxlY3Ryb24vbWFpbiBcdTIxOTIgcmVwbyByb290XG4gICAgY29uc3QgcGFja2FnZWQgPSBhcHAuaXNQYWNrYWdlZDtcbiAgICBsZXQgc3BlYzogeyBjb21tYW5kOiBzdHJpbmc7IGFyZ3M6IHN0cmluZ1tdOyBlbnY6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gfTtcbiAgICBpZiAodXNlUmVhbCkge1xuICAgICAgY29uc3QgZW50cnkgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9SRUFMX0VOVFJZID8/IChwYWNrYWdlZCA/ICcnIDogam9pbihyZXBvUm9vdCwgJy4uJywgJ2htaGFybmVzcycsICdwYWNrYWdlcycsICd3ZWInLCAnc3JjJywgJ2Rlc2t0b3AtaG9zdC50cycpKTtcbiAgICAgIGlmIChlbnRyeSA9PT0gJycpIHtcbiAgICAgICAgYnJpZGdlID0geyAuLi5icmlkZ2UsIGhvc3RTdGF0ZTogJ2ZhaWxlZCcsIGxhc3RFcnJvcjogJ1x1NzcxRlx1NUI5RSBydW50aW1lIFx1NjcyQVx1OTE0RFx1N0Y2RTpcdTYyNTNcdTUzMDVcdTRFQTdcdTU0QzFcdTk3MDBcdThCQkVcdTdGNkUgSE1IX0RFU0tUT1BfUkVBTF9FTlRSWSBcdTYzMDdcdTU0MTEgaG1oYXJuZXNzIGRlc2t0b3AtaG9zdCBcdTUxNjVcdTUzRTMnIH07XG4gICAgICAgIGxvZ0luZm8oJ2hvc3QnLCAncmVhbCBtb2RlIHdpdGhvdXQgSE1IX0RFU0tUT1BfUkVBTF9FTlRSWSBpbiBwYWNrYWdlZCBhcHAnKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgc3BlYyA9IHtcbiAgICAgICAgY29tbWFuZDogcHJvY2Vzcy5leGVjUGF0aCxcbiAgICAgICAgYXJnczogWyctLWltcG9ydCcsICd0c3gnLCBlbnRyeV0sXG4gICAgICAgIGVudjogeyBFTEVDVFJPTl9SVU5fQVNfTk9ERTogJzEnIH0sXG4gICAgICB9O1xuICAgIH0gZWxzZSBpZiAocGFja2FnZWQpIHtcbiAgICAgIHNwZWMgPSB7XG4gICAgICAgIGNvbW1hbmQ6IHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgICAgIGFyZ3M6IFtqb2luKHByb2Nlc3MucmVzb3VyY2VzUGF0aCwgJ2Zha2UtaG9zdC5janMnKV0sXG4gICAgICAgIGVudjogeyBFTEVDVFJPTl9SVU5fQVNfTk9ERTogJzEnIH0sXG4gICAgICB9O1xuICAgIH0gZWxzZSB7XG4gICAgICBzcGVjID0ge1xuICAgICAgICBjb21tYW5kOiBwcm9jZXNzLmV4ZWNQYXRoLFxuICAgICAgICAvLyBcdTc2RjRcdTYzQTVcdThENzBcdTUzMDVcdTc3MUZcdTVCOUVcdThERUZcdTVGODQobm9kZV9tb2R1bGVzIFx1OTFDQ1x1NzY4NCB3b3Jrc3BhY2UganVuY3Rpb24gXHU0RjFBXHU4OEFCIEVTTVxuICAgICAgICAvLyByZWFscGF0aCBcdTUzMTYsXHU1QkZDXHU4MUY0IGZha2UtaG9zdCBcdTc2ODQgYXJndlsxXS9pbXBvcnQubWV0YS51cmwgXHU1MzM5XHU5MTREXHU1OTMxXHU2NTQ4KVxuICAgICAgICBhcmdzOiBbJy0taW1wb3J0JywgJ3RzeCcsIGpvaW4ocmVwb1Jvb3QsICdwYWNrYWdlcycsICdob3N0LWFkYXB0ZXInLCAnc3JjJywgJ2Zha2UtaG9zdC50cycpXSxcbiAgICAgICAgZW52OiB7IEVMRUNUUk9OX1JVTl9BU19OT0RFOiAnMScgfSxcbiAgICAgIH07XG4gICAgfVxuICAgIHN1cGVydmlzb3IgPSBuZXcgRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yKHNwZWMsIHtcbiAgICAgIG9uU3RhdGVDaGFuZ2U6IGJyb2FkY2FzdEhvc3RTdGF0ZSxcbiAgICAgIC8vIFx1OTk5Nlx1NkIyMVx1NTQyRlx1NTJBOFx1NEUwRSBjcmFzaCBcdTgxRUFcdTYxMDhcdTU0MEVcdTc2ODRcdTkxQ0RcdTU0MkZcdTkwRkRcdTRGMUFcdThENzBcdThGRDlcdTkxQ0M6XHU3QUVGXHU1M0UzL3Rva2VuIFx1OTBGRFx1NjYyRlx1NjVCMFx1NzY4NCxcbiAgICAgIC8vIFx1OTFDRFx1NUVGQVx1Njg2NVx1NUJBMlx1NjIzN1x1N0FFRlx1NUU3Nlx1OTFDRFx1NjVCMFx1OEJBMlx1OTYwNSBTU0UocmVuZGVyZXIgXHU3Njg0IEV2ZW50U3RvcmUgXHU5NzYwIGV2ZW50SWQgXHU1M0JCXHU5MUNEKVxuICAgICAgb25SZWFkeTogKGVwKSA9PiB7XG4gICAgICAgIGNsaWVudCA9IG5ldyBEZXNrdG9wSG9zdENsaWVudChgaHR0cDovLzEyNy4wLjAuMToke2VwLnBvcnR9YCwgZXAudG9rZW4pO1xuICAgICAgICBzc2VBYm9ydD8uYWJvcnQoKTtcbiAgICAgICAgc3NlQWJvcnQgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gICAgICAgIGxhc3RFdmVudElkID0gJyc7XG4gICAgICAgIHZvaWQgcHVtcEV2ZW50cygpO1xuICAgICAgICBsb2dJbmZvKCdob3N0JywgYGJyaWRnZSByZWFkeSBvbiAxMjcuMC4wLjE6JHtlcC5wb3J0fSAocnVudGltZSAke2VwLnZlcnNpb259LCBtb2RlICR7YnJpZGdlLm1vZGV9KWApO1xuICAgICAgfSxcbiAgICB9KTtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgc3VwZXJ2aXNvci5zdGFydCgpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgY29uc3QgZGV0YWlsID0gKCgpID0+IHsgdHJ5IHsgcmV0dXJuIEpTT04uc3RyaW5naWZ5KGVycik7IH0gY2F0Y2ggeyByZXR1cm4gU3RyaW5nKGVycik7IH0gfSkoKS5zbGljZSgwLCA0MDApO1xuICAgICAgYnJpZGdlID0geyAuLi5icmlkZ2UsIGhvc3RTdGF0ZTogJ2ZhaWxlZCcsIGxhc3RFcnJvcjogZGV0YWlsIH07XG4gICAgICBsb2dJbmZvKCdob3N0JywgYHN0YXJ0IGZhaWxlZDogJHtkZXRhaWx9YCk7XG4gICAgfVxuICB9XG5cbiAgLyogLS0tLSBJUEMgXHU3NjdEXHU1NDBEXHU1MzU1ICsgc2VuZGVyIFx1NjgyMVx1OUE4QyAtLS0tICovXG4gIGNvbnN0IGFsbG93ZWRPcmlnaW5zID0gbmV3IFNldDxzdHJpbmc+KFxuICAgIGlzRGV2ICYmIHJlbmRlcmVyRGV2VXJsXG4gICAgICA/IFtyZW5kZXJlckRldlVybF1cbiAgICAgIDogW3BhdGhUb0ZpbGVVUkwoam9pbihoZXJlLCAnLi4nLCAnLi4nLCAnZGlzdC1yZW5kZXJlcicsICdpbmRleC5odG1sJykpLmhyZWZdLFxuICApO1xuXG4gIGZ1bmN0aW9uIHNlbmRlclRydXN0ZWQoc2VuZGVyRnJhbWU6IEVsZWN0cm9uLldlYkZyYW1lTWFpbiB8IG51bGwgfCB1bmRlZmluZWQpOiBib29sZWFuIHtcbiAgICBpZiAoc2VuZGVyRnJhbWUgPT09IG51bGwgfHwgc2VuZGVyRnJhbWUgPT09IHVuZGVmaW5lZCkgcmV0dXJuIGZhbHNlO1xuICAgIGxldCB0b3A6IEVsZWN0cm9uLldlYkZyYW1lTWFpbiB8IG51bGwgPSBzZW5kZXJGcmFtZTtcbiAgICB3aGlsZSAodG9wPy5wYXJlbnQgIT09IG51bGwgJiYgdG9wPy5wYXJlbnQgIT09IHVuZGVmaW5lZCkgdG9wID0gdG9wLnBhcmVudDtcbiAgICBjb25zdCB1cmwgPSB0b3A/LnVybCA/PyAnJztcbiAgICBmb3IgKGNvbnN0IG9yaWdpbiBvZiBhbGxvd2VkT3JpZ2lucykge1xuICAgICAgaWYgKHVybCA9PT0gb3JpZ2luIHx8IHVybC5zdGFydHNXaXRoKGAke29yaWdpbn0vYCkgfHwgdXJsLnN0YXJ0c1dpdGgoYCR7b3JpZ2lufT9gKSkgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIC8qKiBcdTk3MDBcdTg5ODEgaG9zdCBcdTVDMzFcdTdFRUFcdTc2ODQgSVBDIGhhbmRsZXIgXHU1MTZDXHU1MTcxXHU1OEYzOlx1NjcyQVx1NUMzMVx1N0VFQVx1OEZENFx1NTZERVx1N0VEM1x1Njc4NFx1NTMxNlx1OTUxOVx1OEJFRlx1MzAwMiAqL1xuICBmdW5jdGlvbiBob3N0Q2FsbDxUPihldmVudDogRWxlY3Ryb24uSXBjTWFpbkludm9rZUV2ZW50LCBmbjogKGM6IERlc2t0b3BIb3N0Q2xpZW50KSA9PiBQcm9taXNlPFQ+KTogUHJvbWlzZTxUIHwgeyBlcnJvcjogc3RyaW5nOyBjb2RlOiBzdHJpbmcgfT4ge1xuICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9KTtcbiAgICBpZiAoY2xpZW50ID09PSBudWxsIHx8IGJyaWRnZS5ob3N0U3RhdGUgIT09ICdyZWFkeScpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogYGhvc3Qgbm90IHJlYWR5ICgke2JyaWRnZS5ob3N0U3RhdGV9KWAsIGNvZGU6ICdIT1NUX05PVF9SRUFEWScgfSk7XG4gICAgfVxuICAgIHJldHVybiBmbihjbGllbnQpLmNhdGNoKChlcnI6IHVua25vd24pID0+IHtcbiAgICAgIGNvbnN0IGRldGFpbCA9ICgoKSA9PiB7IHRyeSB7IHJldHVybiBKU09OLnN0cmluZ2lmeShlcnIpOyB9IGNhdGNoIHsgcmV0dXJuIFN0cmluZyhlcnIpOyB9IH0pKCkuc2xpY2UoMCwgMzAwKTtcbiAgICAgIHJldHVybiB7IGVycm9yOiBkZXRhaWwsIGNvZGU6ICdCUklER0VfRVJST1InIH07XG4gICAgfSk7XG4gIH1cblxuICBmdW5jdGlvbiByZWdpc3RlcklwYygpOiB2b2lkIHtcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmdldC1zdGF0ZScsIChldmVudCkgPT4ge1xuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJyB9O1xuICAgICAgcmV0dXJuIHsgLi4uYnJpZGdlLCBkcm9wcGVkRnJhbWVzIH07XG4gICAgfSk7XG5cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnNlc3Npb25zJywgKGV2ZW50KSA9PlxuICAgICAgaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248eyBzZXNzaW9uczogQXJyYXk8eyBpZDogc3RyaW5nOyB0aXRsZTogc3RyaW5nOyB0YXNrOiBzdHJpbmc7IG91dGNvbWU6IHN0cmluZzsgdHVybnM6IG51bWJlcjsgdG9vbFVzZXM6IG51bWJlcjsgdGltZTogc3RyaW5nOyBjd2Q6IHN0cmluZzsgY3JlYXRlZEF0OiBzdHJpbmc7IHVwZGF0ZWRBdDogc3RyaW5nIH0+IH0+KCcvYXBpL3Nlc3Npb25zP2xpbWl0PTEwMCcpKSk7XG5cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnNlbmQtdGFzaycsIChldmVudCwgdGV4dDogdW5rbm93biwgc2Vzc2lvbklkOiB1bmtub3duLCBtb2RlOiB1bmtub3duKSA9PiB7XG4gICAgICBjb25zdCB0YXNrID0gdHlwZW9mIHRleHQgPT09ICdzdHJpbmcnID8gdGV4dC5zbGljZSgwLCAyMF8wMDApIDogJyc7XG4gICAgICBjb25zdCBzaWQgPSB0eXBlb2Ygc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IHNlc3Npb25JZC5zbGljZSgwLCA4MCkgOiAnJztcbiAgICAgIGNvbnN0IG0gPSBtb2RlID09PSAnYXV0bycgfHwgbW9kZSA9PT0gJ3lvbG8nID8gbW9kZSA6ICdhc2snO1xuICAgICAgaWYgKHRhc2sgPT09ICcnIHx8IHNpZCA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBvazogZmFsc2UsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW47IHJ1bklkPzogc3RyaW5nIH0+KCcvYXBpL3Rhc2snLCB7IHRleHQ6IHRhc2ssIHNlc3Npb25JZDogc2lkLCBtb2RlOiBtIH0pKTtcbiAgICB9KTtcblxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6YXBwcm92ZScsIChldmVudCwgZ3JhbnRlZDogdW5rbm93biwgc2Vzc2lvbklkOiB1bmtub3duKSA9PlxuICAgICAgaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvYXBwcm92ZScsIHtcbiAgICAgICAgZ3JhbnRlZDogZ3JhbnRlZCA9PT0gdHJ1ZSxcbiAgICAgICAgc2Vzc2lvbklkOiB0eXBlb2Ygc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IHNlc3Npb25JZC5zbGljZSgwLCA4MCkgOiAnJyxcbiAgICAgIH0pKSk7XG5cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmludGVycnVwdCcsIChldmVudCwgc2Vzc2lvbklkOiB1bmtub3duKSA9PlxuICAgICAgaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvaW50ZXJydXB0Jywge1xuICAgICAgICBzZXNzaW9uSWQ6IHR5cGVvZiBzZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gc2Vzc2lvbklkLnNsaWNlKDAsIDgwKSA6ICcnLFxuICAgICAgfSkpKTtcblxuICAgIC8vIC0tLS0gTTQ6XHU1REU1XHU0RjVDXHU1MzNBXHU2NTg3XHU0RUY2XHU5NzYyKFx1OERFRlx1NUY4NFx1NjM4OFx1Njc0M1x1NTcyOCBydW50aW1lOmluc2lkZVdzIFx1NjgyMVx1OUE4QykgLS0tLVxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6ZnMtbGlzdCcsIChldmVudCwgcGF0aDogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3QgcCA9IHR5cGVvZiBwYXRoID09PSAnc3RyaW5nJyA/IHBhdGguc2xpY2UoMCwgMTAwMCkgOiAnJztcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oYC9hcGkvZnM/ZmlsZXM9MSR7cCAhPT0gJycgPyBgJnBhdGg9JHtlbmNvZGVVUklDb21wb25lbnQocCl9YCA6ICcnfWApKTtcbiAgICB9KTtcblxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6ZnMtcmVhZCcsIChldmVudCwgcGF0aDogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3QgcCA9IHR5cGVvZiBwYXRoID09PSAnc3RyaW5nJyA/IHBhdGguc2xpY2UoMCwgMTAwMCkgOiAnJztcbiAgICAgIGlmIChwID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAncGF0aCByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KGAvYXBpL2ZzL3JlYWQ/cGF0aD0ke2VuY29kZVVSSUNvbXBvbmVudChwKX1gKSk7XG4gICAgfSk7XG5cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmluamVjdCcsIChldmVudCwgdGV4dDogdW5rbm93biwgc2Vzc2lvbklkOiB1bmtub3duKSA9PiB7XG4gICAgICBjb25zdCB0ID0gdHlwZW9mIHRleHQgPT09ICdzdHJpbmcnID8gdGV4dC5zbGljZSgwLCAyMF8wMDApIDogJyc7XG4gICAgICBjb25zdCBzaWQgPSB0eXBlb2Ygc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IHNlc3Npb25JZC5zbGljZSgwLCA4MCkgOiAnJztcbiAgICAgIGlmICh0ID09PSAnJyB8fCBzaWQgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgb2s6IGZhbHNlLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KCcvYXBpL2luamVjdCcsIHsgdGV4dDogdCwgc2Vzc2lvbklkOiBzaWQgfSkpO1xuICAgIH0pO1xuXG4gICAgLy8gLS0tLSBcdTRGMUFcdThCRERcdTVCRkNcdTUxRkEoZXhwb3J0Lm1kIFx1MjE5MiBcdTRGRERcdTVCNThcdTVCRjlcdThCRERcdTY4NDY7XHU2NTg3XHU0RUY2XHU1MTk5XHU1MTY1XHU1M0VBXHU1NzI4IG1haW4pIC0tLS1cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmV4cG9ydC1zZXNzaW9uJywgYXN5bmMgKGV2ZW50LCBpZDogdW5rbm93bikgPT4ge1xuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcbiAgICAgIGNvbnN0IHNpZCA9IHR5cGVvZiBpZCA9PT0gJ3N0cmluZycgPyBpZC5yZXBsYWNlKC9bXmEtekEtWjAtOV86LkAtXS9nLCAnJykuc2xpY2UoMCwgODApIDogJyc7XG4gICAgICBpZiAoc2lkID09PSAnJykgcmV0dXJuIHsgZXJyb3I6ICdpZCByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfTtcbiAgICAgIGlmIChjbGllbnQgPT09IG51bGwgfHwgYnJpZGdlLmhvc3RTdGF0ZSAhPT0gJ3JlYWR5JykgcmV0dXJuIHsgZXJyb3I6IGBob3N0IG5vdCByZWFkeSAoJHticmlkZ2UuaG9zdFN0YXRlfSlgLCBjb2RlOiAnSE9TVF9OT1RfUkVBRFknIH07XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBtZCA9IGF3YWl0IGNsaWVudC5nZXRUZXh0KGAvYXBpL3Nlc3Npb25zLyR7ZW5jb2RlVVJJQ29tcG9uZW50KHNpZCl9L2V4cG9ydC5tZGApO1xuICAgICAgICBjb25zdCB3aW4gPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5maW5kKCh3KSA9PiAhdy5pc0Rlc3Ryb3llZCgpKTtcbiAgICAgICAgaWYgKHdpbiA9PT0gdW5kZWZpbmVkKSByZXR1cm4geyBlcnJvcjogJ25vIHdpbmRvdycsIGNvZGU6ICdCUklER0VfRVJST1InIH07XG4gICAgICAgIGNvbnN0IHIgPSBhd2FpdCBkaWFsb2cuc2hvd1NhdmVEaWFsb2cod2luLCB7XG4gICAgICAgICAgdGl0bGU6ICdcdTVCRkNcdTUxRkFcdTRGMUFcdThCREQnLFxuICAgICAgICAgIGRlZmF1bHRQYXRoOiBgaG1oLSR7c2lkfS5tZGAsXG4gICAgICAgICAgZmlsdGVyczogW3sgbmFtZTogJ01hcmtkb3duJywgZXh0ZW5zaW9uczogWydtZCddIH1dLFxuICAgICAgICB9KTtcbiAgICAgICAgaWYgKHIuY2FuY2VsZWQgfHwgci5maWxlUGF0aCA9PT0gdW5kZWZpbmVkIHx8IHIuZmlsZVBhdGggPT09ICcnKSByZXR1cm4geyBvazogZmFsc2UsIGNhbmNlbGVkOiB0cnVlIH07XG4gICAgICAgIGF3YWl0IHdyaXRlRmlsZShyLmZpbGVQYXRoLCBtZCwgJ3V0ZjgnKTtcbiAgICAgICAgbG9nSW5mbygnZXhwb3J0JywgYHNlc3Npb24gJHtzaWR9IFx1MjE5MiAke3IuZmlsZVBhdGh9YCk7XG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBwYXRoOiByLmZpbGVQYXRoIH07XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgY29uc3QgZGV0YWlsID0gKCgpID0+IHsgdHJ5IHsgcmV0dXJuIEpTT04uc3RyaW5naWZ5KGVycik7IH0gY2F0Y2ggeyByZXR1cm4gU3RyaW5nKGVycik7IH0gfSkoKS5zbGljZSgwLCAzMDApO1xuICAgICAgICByZXR1cm4geyBlcnJvcjogZGV0YWlsLCBjb2RlOiAnQlJJREdFX0VSUk9SJyB9O1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgLy8gLS0tLSBcdTVCQTFcdTYyNzlcdTZBMjFcdTVGMEZcdThCRkJcdTUxOTkoXHU2NzQzXHU1QTAxXHU1NzI4IHJ1bnRpbWUgY29uZmlnO1x1NTIwN1x1NjM2Mlx1NUZDNVx1OTg3Qlx1NjYzRVx1NUYwRikgLS0tLVxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6YXBwcm92YWwtZ2V0JywgKGV2ZW50KSA9PlxuICAgICAgaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248eyBzZXR0aW5ncz86IHsgYXBwcm92YWw/OiBzdHJpbmcgfSB9PignL2FwaS9zdGF0ZScpKSk7XG5cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmFwcHJvdmFsLXNldCcsIChldmVudCwgbW9kZTogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3QgbSA9IG1vZGUgPT09ICdhdXRvJyA/ICdhdXRvJyA6IG1vZGUgPT09ICdhc2snID8gJ2FzaycgOiAnJztcbiAgICAgIGlmIChtID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAnbW9kZSBtdXN0IGJlIGFza3xhdXRvJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PignL2FwaS9jb25maWcnLCB7IGFwcHJvdmFsOiBtIH0pKTtcbiAgICB9KTtcblxuICAgIC8vIC0tLS0gTTQ6RGlmZiBcdTk3NjJcdTY3N0YoXHU1M0VBXHU4QkZCIGdpdCBcdTUzRDhcdTY2RjQ7XHU2Mzg4XHU2NzQzXHU1NzI4IHJ1bnRpbWUpIC0tLS1cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmRpZmYnLCAoZXZlbnQsIHNlc3Npb25JZDogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIHNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBzZXNzaW9uSWQuc2xpY2UoMCwgODApIDogJyc7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KGAvYXBpL2RpZmYke3NpZCAhPT0gJycgPyBgP3Nlc3Npb25JZD0ke2VuY29kZVVSSUNvbXBvbmVudChzaWQpfWAgOiAnJ31gKSk7XG4gICAgfSk7XG5cbiAgICAvLyAtLS0tIE01Olx1OEJBNFx1NzdFNVx1NzJCNlx1NjAwMShcdTdFRDNcdTY3ODRcdTUzMTZcdTRFOEJcdTVCOUU7XHU3RjNBXHU2NTcwXHU2MzZFXHU1QjU3XHU2QkI1XHU3NTMxIFVJIFx1NjYzRVx1NzkzQVwiXHU2NUUwXHU2NTcwXHU2MzZFXCIpIC0tLS1cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmNvZ25pdGl2ZScsIChldmVudCkgPT5cbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPFJlY29yZDxzdHJpbmcsIHVua25vd24+PignL2FwaS9jb2duaXRpdmUnKSkpO1xuXG4gICAgLy8gLS0tLSBcdTUzODZcdTUzRjJcdTRGMUFcdThCRERcdTk4ODRcdTg5QzgoXHU2NzAwXHU1NDBFIDgwIFx1Njc2MSxcdTZCQ0ZcdTY3NjEgNTAwIFx1NUI1NztydW50aW1lIFx1Njc0M1x1NUEwMVx1NjU3MFx1NjM2RSkgLS0tLVxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6c2Vzc2lvbi1wcmV2aWV3JywgKGV2ZW50LCBpZDogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIGlkID09PSAnc3RyaW5nJyA/IGlkLnJlcGxhY2UoL1teYS16QS1aMC05XzouQC1dL2csICcnKS5zbGljZSgwLCA4MCkgOiAnJztcbiAgICAgIGlmIChzaWQgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICdpZCByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KGAvYXBpL3Nlc3Npb25zLyR7ZW5jb2RlVVJJQ29tcG9uZW50KHNpZCl9YCkpO1xuICAgIH0pO1xuXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpzdG9wLWhvc3QnLCAoZXZlbnQpID0+IHtcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicgfTtcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcbiAgICAgICAgc3NlQWJvcnQ/LmFib3J0KCk7XG4gICAgICAgIGF3YWl0IHN1cGVydmlzb3I/LnN0b3AoKTtcbiAgICAgICAgYXBwLnF1aXQoKTtcbiAgICAgIH0pKCk7XG4gICAgICByZXR1cm4geyBvazogdHJ1ZSB9O1xuICAgIH0pO1xuICB9XG5cbiAgLyogLS0tLSBcdTdBOTdcdTUzRTNcdTRFMEVcdTVCODlcdTUxNjhcdTdCNTZcdTc1NjUgLS0tLSAqL1xuICBmdW5jdGlvbiBjcmVhdGVXaW5kb3coKTogdm9pZCB7XG4gICAgY29uc3Qgd2luID0gbmV3IEJyb3dzZXJXaW5kb3coe1xuICAgICAgd2lkdGg6IDE0NDAsXG4gICAgICBoZWlnaHQ6IDkwMCxcbiAgICAgIG1pbldpZHRoOiA5NjAsXG4gICAgICBtaW5IZWlnaHQ6IDYwMCxcbiAgICAgIHNob3c6IGZhbHNlLFxuICAgICAgYmFja2dyb3VuZENvbG9yOiAnIzE0MTQxNicsXG4gICAgICB0aXRsZTogJ0hNSCBEZXNrdG9wJyxcbiAgICAgIHdlYlByZWZlcmVuY2VzOiB7XG4gICAgICAgIHByZWxvYWQ6IHByZWxvYWRQYXRoLFxuICAgICAgICBjb250ZXh0SXNvbGF0aW9uOiB0cnVlLFxuICAgICAgICBzYW5kYm94OiB0cnVlLFxuICAgICAgICBub2RlSW50ZWdyYXRpb246IGZhbHNlLFxuICAgICAgICBub2RlSW50ZWdyYXRpb25JbldvcmtlcjogZmFsc2UsXG4gICAgICAgIHdlYlNlY3VyaXR5OiB0cnVlLFxuICAgICAgICBzcGVsbGNoZWNrOiBmYWxzZSxcbiAgICAgICAgZGV2VG9vbHM6IGlzRGV2LFxuICAgICAgfSxcbiAgICB9KTtcbiAgICB3aW4ub25jZSgncmVhZHktdG8tc2hvdycsICgpID0+IHdpbi5zaG93KCkpO1xuXG4gICAgLy8gXHU1M0VBXHU1MTQxXHU4QkI4XHU1MkEwXHU4RjdEXHU2MjExXHU0RUVDXHU4MUVBXHU1REYxXHU3Njg0IHJlbmRlcmVyO1x1NEVGQlx1NEY1NVx1NUJGQ1x1ODIyQS9cdTY1QjBcdTdBOTdcdTUzRTNcdTRFMDBcdTVGOEJcdTYyRDJcdTdFRERcbiAgICB3aW4ud2ViQ29udGVudHMuc2V0V2luZG93T3BlbkhhbmRsZXIoKHsgdXJsIH0pID0+IHtcbiAgICAgIGlmICgvXmh0dHBzPzpcXC9cXC8vLnRlc3QodXJsKSkgdm9pZCBzaGVsbC5vcGVuRXh0ZXJuYWwodXJsKTtcbiAgICAgIHJldHVybiB7IGFjdGlvbjogJ2RlbnknIH07XG4gICAgfSk7XG4gICAgd2luLndlYkNvbnRlbnRzLm9uKCd3aWxsLW5hdmlnYXRlJywgKGUsIHVybCkgPT4ge1xuICAgICAgY29uc3Qgb2sgPSBbLi4uYWxsb3dlZE9yaWdpbnNdLnNvbWUoKG8pID0+IHVybCA9PT0gbyB8fCB1cmwuc3RhcnRzV2l0aChgJHtvfS9gKSB8fCB1cmwuc3RhcnRzV2l0aChgJHtvfT9gKSk7XG4gICAgICBpZiAoIW9rKSB7XG4gICAgICAgIGxvZ0luZm8oJ25hdicsIGBibG9ja2VkIG5hdmlnYXRpb24gdG8gJHt1cmwuc2xpY2UoMCwgMTIwKX1gKTtcbiAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgaWYgKGlzRGV2ICYmIHJlbmRlcmVyRGV2VXJsKSB7XG4gICAgICB2b2lkIHdpbi5sb2FkVVJMKHJlbmRlcmVyRGV2VXJsKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdm9pZCB3aW4ubG9hZEZpbGUoam9pbihoZXJlLCAnLi4nLCAnLi4nLCAnZGlzdC1yZW5kZXJlcicsICdpbmRleC5odG1sJykpO1xuICAgIH1cbiAgfVxuXG4gIGFwcC53aGVuUmVhZHkoKS50aGVuKCgpID0+IHtcbiAgICAvLyBDU1AoZGV2IFx1NEUwRSBwcm9kIFx1NEUwRFx1NTQwQztwcm9kIFx1NEUwRFx1NTE0MVx1OEJCOFx1NEVGQlx1NEY1NVx1OEZEQ1x1N0EwQlx1NkU5MClcbiAgICBjb25zdCBjc3AgPSBpc0RldlxuICAgICAgPyBbXG4gICAgICAgICAgXCJkZWZhdWx0LXNyYyAnc2VsZidcIixcbiAgICAgICAgICBgc2NyaXB0LXNyYyAnc2VsZicgJHtyZW5kZXJlckRldlVybH1gLFxuICAgICAgICAgIFwic3R5bGUtc3JjICdzZWxmJyAndW5zYWZlLWlubGluZSdcIixcbiAgICAgICAgICBgY29ubmVjdC1zcmMgJ3NlbGYnICR7cmVuZGVyZXJEZXZVcmx9IHdzOi8vMTI3LjAuMC4xOipgLFxuICAgICAgICAgIFwiaW1nLXNyYyAnc2VsZicgZGF0YTpcIixcbiAgICAgICAgICBcImZvbnQtc3JjICdzZWxmJyBkYXRhOlwiLFxuICAgICAgICBdLmpvaW4oJzsgJylcbiAgICAgIDogXCJkZWZhdWx0LXNyYyAnc2VsZic7IHNjcmlwdC1zcmMgJ3NlbGYnOyBzdHlsZS1zcmMgJ3NlbGYnICd1bnNhZmUtaW5saW5lJzsgaW1nLXNyYyAnc2VsZicgZGF0YTo7IGZvbnQtc3JjICdzZWxmJyBkYXRhOlwiO1xuICAgIHNlc3Npb24uZGVmYXVsdFNlc3Npb24ud2ViUmVxdWVzdC5vbkhlYWRlcnNSZWNlaXZlZCgoZGV0YWlscywgY2FsbGJhY2spID0+IHtcbiAgICAgIGNhbGxiYWNrKHtcbiAgICAgICAgcmVzcG9uc2VIZWFkZXJzOiB7XG4gICAgICAgICAgLi4uZGV0YWlscy5yZXNwb25zZUhlYWRlcnMsXG4gICAgICAgICAgJ0NvbnRlbnQtU2VjdXJpdHktUG9saWN5JzogW2NzcF0sXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHJlZ2lzdGVySXBjKCk7XG4gICAgY3JlYXRlV2luZG93KCk7XG4gICAgdm9pZCBzdGFydEhvc3QoKTtcblxuICAgIC8vIFx1OTYzNlx1NkJCNUggXHU1Qjg5XHU1MTY4XHU4MUVBXHU2RDRCKE1hc3RlclByb21wdCBIOnJlbmRlcmVyIFx1NjVFMCBwcm9jZXNzL3JlcXVpcmVcdTMwMDFcdTc2N0RcdTU0MERcdTUzNTVcdTY4NjVcdTMwMDFcbiAgICAvLyBcdTVCRkNcdTgyMkFcdTYyRTZcdTYyMkFcdTMwMDFDU1BcdTMwMDF3aW5kb3cub3BlbiBcdTYyRDJcdTdFREQpXHUzMDAyXHU4MUVBXHU5QTcxXHU2M0EyXHU5NDg4LHNjcmlwdHMvc2VjdXJpdHktdGVzdC5tanMgXHU2RDg4XHU4RDM5XHUzMDAyXG4gICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NFQ1VSSVRZX1RFU1QgPT09ICcxJykge1xuICAgICAgY29uc3Qgd2luMCA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpWzBdO1xuICAgICAgaWYgKHdpbjAgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICB3aW4wLndlYkNvbnRlbnRzLm9uY2UoJ2RpZC1maW5pc2gtbG9hZCcsICgpID0+IHtcbiAgICAgICAgICB2b2lkIHNlY3VyaXR5U2VsZlRlc3Qod2luMCk7XG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cblxuICAgIGFwcC5vbignYWN0aXZhdGUnLCAoKSA9PiB7XG4gICAgICBpZiAoQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkubGVuZ3RoID09PSAwKSBjcmVhdGVXaW5kb3coKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgYXN5bmMgZnVuY3Rpb24gc2VjdXJpdHlTZWxmVGVzdCh3aW46IEJyb3dzZXJXaW5kb3cpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCByZXN1bHRzOiBBcnJheTxbc3RyaW5nLCBib29sZWFuLCBzdHJpbmddPiA9IFtdO1xuICAgIGNvbnN0IGNoZWNrID0gYXN5bmMgKG5hbWU6IHN0cmluZywgcHJvYmU6ICgpID0+IFByb21pc2U8W2Jvb2xlYW4sIHN0cmluZ10+KTogUHJvbWlzZTx2b2lkPiA9PiB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBbb2ssIGRldGFpbF0gPSBhd2FpdCBwcm9iZSgpO1xuICAgICAgICByZXN1bHRzLnB1c2goW25hbWUsIG9rLCBkZXRhaWxdKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICByZXN1bHRzLnB1c2goW25hbWUsIGZhbHNlLCBTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApXSk7XG4gICAgICB9XG4gICAgfTtcbiAgICBjb25zdCBqcyA9IChjb2RlOiBzdHJpbmcpOiBQcm9taXNlPHVua25vd24+ID0+IHdpbi53ZWJDb250ZW50cy5leGVjdXRlSmF2YVNjcmlwdChjb2RlLCB0cnVlKTtcblxuICAgIGF3YWl0IGNoZWNrKCdyZW5kZXJlciBcdTY1RTBcdTUzRUZcdTc1MjhcdTc2ODQgcHJvY2Vzcy9yZXF1aXJlKHNhbmRib3ggXHU3NTFGXHU2NTQ4KScsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoYChmdW5jdGlvbigpe1xuICAgICAgICB2YXIgdCA9IGZ1bmN0aW9uKGYpeyB0cnkgeyB2YXIgdiA9IGYoKTsgcmV0dXJuICh2ID09PSB1bmRlZmluZWQgfHwgdiA9PT0gbnVsbCkgPyAndW5hdmFpbGFibGUnIDogdHlwZW9mIHY7IH0gY2F0Y2goZSl7IHJldHVybiAnYmxvY2tlZCc7IH0gfTtcbiAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KFt0KGZ1bmN0aW9uKCl7cmV0dXJuIHByb2Nlc3N9KSwgdChmdW5jdGlvbigpe3JldHVybiByZXF1aXJlfSksIHQoZnVuY3Rpb24oKXtyZXR1cm4gZ2xvYmFsVGhpcy5wcm9jZXNzfSldKTtcbiAgICAgIH0pKClgKSkgYXMgc3RyaW5nO1xuICAgICAgY29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShyKSBhcyBzdHJpbmdbXTtcbiAgICAgIGNvbnN0IHAgPSBwYXJzZWRbMF0gPz8gJ3Vua25vd24nO1xuICAgICAgY29uc3QgcmVxID0gcGFyc2VkWzFdID8/ICd1bmtub3duJztcbiAgICAgIGNvbnN0IHNhZmUgPSAodjogc3RyaW5nKTogYm9vbGVhbiA9PiB2ID09PSAndW5hdmFpbGFibGUnIHx8IHYgPT09ICdibG9ja2VkJztcbiAgICAgIHJldHVybiBbc2FmZShwKSAmJiBzYWZlKHJlcSksIGBwcm9jZXNzPSR7cH0gcmVxdWlyZT0ke3JlcX1gXTtcbiAgICB9KTtcbiAgICBhd2FpdCBjaGVjaygnd2luZG93LmhtaCBcdTUzRUFcdTY3MDlcdTc2N0RcdTU0MERcdTUzNTVcdTY1QjlcdTZDRDUoXHU2NUUwIGlwY1JlbmRlcmVyL1x1OTg5RFx1NTkxNlx1OTc2MiknLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKCdPYmplY3Qua2V5cyh3aW5kb3cuaG1oIHx8IHt9KS5zb3J0KCkuam9pbihcIixcIiknKSkgYXMgc3RyaW5nO1xuICAgICAgY29uc3QgYWxsb3cgPSBbJ2FwcHJvdmUnLCAnYXBwcm92YWxHZXQnLCAnYXBwcm92YWxTZXQnLCAnY29nbml0aXZlJywgJ2RpZmYnLCAnZXhwb3J0U2Vzc2lvbicsICdmc0xpc3QnLCAnZnNSZWFkJywgJ2dldFN0YXRlJywgJ2luamVjdCcsICdpbnRlcnJ1cHQnLCAnb25FdmVudEJhdGNoZXMnLCAnb25Ib3N0U3RhdGUnLCAnb25TdHJlYW1DaHVua3MnLCAnc2VuZFRhc2snLCAnc2Vzc2lvblByZXZpZXcnLCAnc2Vzc2lvbnMnLCAnc3RvcEhvc3QnXTtcbiAgICAgIGNvbnN0IGdvdCA9IHIgPT09ICcnID8gW10gOiByLnNwbGl0KCcsJyk7XG4gICAgICBjb25zdCB1bmV4cGVjdGVkID0gZ290LmZpbHRlcigoaykgPT4gIWFsbG93LmluY2x1ZGVzKGspKTtcbiAgICAgIHJldHVybiBbdW5leHBlY3RlZC5sZW5ndGggPT09IDAsIGBrZXlzPSR7cn1gXTtcbiAgICB9KTtcbiAgICBhd2FpdCBjaGVjaygnXHU1OTE2XHU5MEU4XHU1QkZDXHU4MjJBXHU4OEFCXHU2MkU2XHU2MjJBKFVSTCBcdTRFMERcdTUzRDgpJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgYmVmb3JlID0gd2luLndlYkNvbnRlbnRzLmdldFVSTCgpO1xuICAgICAgYXdhaXQganMoJ2xvY2F0aW9uLmhyZWYgPSBcImh0dHBzOi8vZXhhbXBsZS5pbnZhbGlkL3hcIjsgXCJub29wXCInKS5jYXRjaCgoKSA9PiAnbm9vcCcpO1xuICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHIyKSA9PiBzZXRUaW1lb3V0KHIyLCAxXzIwMCkpO1xuICAgICAgY29uc3QgYWZ0ZXIgPSB3aW4ud2ViQ29udGVudHMuZ2V0VVJMKCk7XG4gICAgICByZXR1cm4gW2FmdGVyID09PSBiZWZvcmUsIGAke2JlZm9yZX0gXHUyMTkyICR7YWZ0ZXJ9YF07XG4gICAgfSk7XG4gICAgYXdhaXQgY2hlY2soJ3dpbmRvdy5vcGVuIFx1ODhBQlx1NjJEMlx1N0VERChcdThGRDRcdTU2REUgbnVsbCBcdTRFMTRcdTY1RTBcdTY1QjBcdTdBOTdcdTUzRTMpJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgYmVmb3JlID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkubGVuZ3RoO1xuICAgICAgY29uc3QgciA9IChhd2FpdCBqcygnU3RyaW5nKHdpbmRvdy5vcGVuKFwiaHR0cHM6Ly9leGFtcGxlLmludmFsaWRcIikpJykpIGFzIHN0cmluZztcbiAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyMikgPT4gc2V0VGltZW91dChyMiwgNDAwKSk7XG4gICAgICBjb25zdCBhZnRlciA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmxlbmd0aDtcbiAgICAgIHJldHVybiBbciA9PT0gJ251bGwnICYmIGFmdGVyID09PSBiZWZvcmUsIGBvcGVuKCk9JHtyfSB3aW5kb3dzPSR7YmVmb3JlfVx1MjE5MiR7YWZ0ZXJ9YF07XG4gICAgfSk7XG4gICAgYXdhaXQgY2hlY2soJ0NTUCBcdTVCNThcdTU3MjgobWV0YSBcdTZDRThcdTUxNjVcdTYyMTZcdTU0Q0RcdTVFOTRcdTU5MzQpJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgbWV0YSA9IChhd2FpdCBqcygnQm9vbGVhbihkb2N1bWVudC5xdWVyeVNlbGVjdG9yKFwibWV0YVtodHRwLWVxdWl2PVxcJ0NvbnRlbnQtU2VjdXJpdHktUG9saWN5XFwnXVwiKSknKSkgYXMgYm9vbGVhbjtcbiAgICAgIGNvbnN0IGhlYWRlckNzcCA9IGlzRGV2ID8gJ2RldjogaGVhZGVyIENTUCBcdTc1MzEgb25IZWFkZXJzUmVjZWl2ZWQgXHU2Q0U4XHU1MTY1KFx1NEUwRFx1OTAwMlx1NzUyOCBtZXRhIFx1NjVBRFx1OEEwMCknIDogJ3Byb2QnO1xuICAgICAgcmV0dXJuIFttZXRhIHx8IGlzRGV2LCBgbWV0YT0ke21ldGF9ICR7aGVhZGVyQ3NwfWBdO1xuICAgIH0pO1xuICAgIGF3YWl0IGNoZWNrKCdicmlkZ2U6Z2V0LXN0YXRlIFx1NkI2M1x1NUUzOFx1OEZENFx1NTZERShob3N0IFx1Njg2NVx1NTNFRlx1NzUyOCknLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKCd3aW5kb3cuaG1oLmdldFN0YXRlKCkudGhlbihzID0+IEpTT04uc3RyaW5naWZ5KHMpKS5jYXRjaChlID0+IFwiRVJSOlwiK2UpJykpIGFzIHN0cmluZztcbiAgICAgIHJldHVybiBbci5zdGFydHNXaXRoKCd7JykgJiYgci5pbmNsdWRlcygnaG9zdFN0YXRlJyksIHIuc2xpY2UoMCwgODApXTtcbiAgICB9KTtcbiAgICBhd2FpdCBjaGVjaygnWFNTOlx1NjA3Nlx1NjEwRlx1NEVGQlx1NTJBMVx1NjU4N1x1NjcyQ1x1NTNFQVx1NEVFNVx1NjU4N1x1NjcyQ1x1NkUzMlx1NjdEMyhcdTRFMERcdTYyNjdcdTg4NEMpJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgcGF5bG9hZCA9ICc8aW1nIHNyYz14IG9uZXJyb3I9XCJ3aW5kb3cuX194c3M9MVwiPjxzY3JpcHQ+d2luZG93Ll9feHNzPTI8XFwvc2NyaXB0PlwiJlxcJyc7XG4gICAgICBjb25zdCBzZW5kUiA9IChhd2FpdCBqcyhgd2luZG93LmhtaC5zZW5kVGFzaygke0pTT04uc3RyaW5naWZ5KHBheWxvYWQpfSwgJ3NlYy14c3MtMScsICdhdXRvJykudGhlbihyPT5KU09OLnN0cmluZ2lmeShyKSkuY2F0Y2goZT0+J0VSUjonK2UpYCkpIGFzIHN0cmluZztcbiAgICAgIGlmICghc2VuZFIuaW5jbHVkZXMoJ1wib2tcIjp0cnVlJykpIHJldHVybiBbZmFsc2UsIGBzZW5kVGFzayBcdTY3MkFcdTUzRDdcdTc0MDY6ICR7c2VuZFIuc2xpY2UoMCwgODApfWBdO1xuICAgICAgLy8gZmFrZSBob3N0IGVjaG8gXHU1NkRFXHU2NzY1XHU1NDBFXHU3RUNGIFJlYWN0IFx1NkUzMlx1NjdEMyhcdTc1MjhcdTYyMzdcdTZEODhcdTYwNkYgKyBcdTUyQTlcdTYyNEIgZWNobyBcdTUzQ0NcdThERUZcdTVGODQpXG4gICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocjIpID0+IHNldFRpbWVvdXQocjIsIDNfMDAwKSk7XG4gICAgICBjb25zdCBwcm9iZSA9IChhd2FpdCBqcyhgSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICB4c3NGbGFnOiB0eXBlb2Ygd2luZG93Ll9feHNzLFxuICAgICAgICBpbWdDb3VudDogZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnaW1nW3NyYz1cInhcIl0nKS5sZW5ndGgsXG4gICAgICAgIHNjcmlwdFJhbjogZG9jdW1lbnQuYm9keS5pbm5lclRleHQuaW5kZXhPZignd2luZG93Ll9feHNzPTInKSA+PSAwXG4gICAgICB9KWApKSBhcyBzdHJpbmc7XG4gICAgICBjb25zdCBwID0gSlNPTi5wYXJzZShwcm9iZSkgYXMgeyB4c3NGbGFnOiBzdHJpbmc7IGltZ0NvdW50OiBudW1iZXI7IHNjcmlwdFJhbjogYm9vbGVhbiB9O1xuICAgICAgcmV0dXJuIFtwLnhzc0ZsYWcgPT09ICd1bmRlZmluZWQnICYmIHAuaW1nQ291bnQgPT09IDAsIGB4c3NGbGFnPSR7cC54c3NGbGFnfSBpbWc9JHtwLmltZ0NvdW50fWBdO1xuICAgIH0pO1xuXG4gICAgbGV0IGZhaWxlZCA9IDA7XG4gICAgZm9yIChjb25zdCBbbmFtZSwgb2ssIGRldGFpbF0gb2YgcmVzdWx0cykge1xuICAgICAgY29uc29sZS5sb2coYFNFQ1VSSVRZLVRFU1QgJHtvayA/ICdQQVNTJyA6ICdGQUlMJ30gfCAke25hbWV9IHwgJHtyZWRhY3QoZGV0YWlsKX1gKTtcbiAgICAgIGlmICghb2spIGZhaWxlZCArPSAxO1xuICAgIH1cbiAgICBjb25zb2xlLmxvZyhgU0VDVVJJVFktVEVTVCBTVU1NQVJZIHBhc3M9JHtyZXN1bHRzLmxlbmd0aCAtIGZhaWxlZH0vJHtyZXN1bHRzLmxlbmd0aH1gKTtcbiAgICBhcHAuZXhpdChmYWlsZWQgPT09IDAgPyAwIDogMSk7XG4gIH1cblxuICAvLyBcdTkwMDBcdTUxRkE6XHU0RjE4XHU5NkM1XHU1MDVDXHU2QjYyXHU4MUVBXHU1REYxIHNwYXduIFx1NzY4NCBob3N0KHNodXRkb3duIFx1N0FFRlx1NzBCOSBcdTIxOTIgXHU1MTVDXHU1RTk1XHU1M0VBIGtpbGwgXHU4MUVBXHU1REYxXHU3Njg0XHU1M0U1XHU2N0M0KVxuICBhcHAub24oJ2JlZm9yZS1xdWl0JywgKGUpID0+IHtcbiAgICBpZiAoc3VwZXJ2aXNvciAhPT0gbnVsbCAmJiBzdXBlcnZpc29yLnN0YXRlICE9PSAnc3RvcHBlZCcpIHtcbiAgICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICAgIHNzZUFib3J0Py5hYm9ydCgpO1xuICAgICAgdm9pZCBzdXBlcnZpc29yLnN0b3AoKS5maW5hbGx5KCgpID0+IGFwcC5xdWl0KCkpO1xuICAgIH1cbiAgfSk7XG4gIGFwcC5vbignd2luZG93LWFsbC1jbG9zZWQnLCAoKSA9PiB7XG4gICAgaWYgKHByb2Nlc3MucGxhdGZvcm0gIT09ICdkYXJ3aW4nKSBhcHAucXVpdCgpO1xuICB9KTtcbn1cbiIsICIvKipcbiAqIERlc2t0b3BSdW50aW1lU3VwZXJ2aXNvciBcdTIwMTQgaG1oYXJuZXNzIGhvc3QgXHU4RkRCXHU3QTBCXHU3Njg0XHU3NTFGXHU1NDdEXHU1NDY4XHU2NzFGXHU3MkI2XHU2MDAxXHU2NzNBKEFEUi0wMDMpXHUzMDAyXG4gKlxuICogXHU1Qjg5XHU1MTY4XHU0RTBEXHU1M0Q4XHU5MUNGOlxuICogIC0gXHU1M0VBXHU3RUQxXHU1QjlBL1x1NjNBMlx1NkQ0QiAxMjcuMC4wLjE7aG9zdCBcdTRGN0ZcdTc1MjhcdTY0Q0RcdTRGNUNcdTdDRkJcdTdFREZcdTUyMDZcdTkxNERcdTdBRUZcdTUzRTMocG9ydCAwKSxcdTVCOUVcdTk2NDVcdTdBRUZcdTUzRTNcbiAqICAgIFx1NzUzMSBob3N0IFx1NzY4NCBzdGRvdXQgXHU1RjE1XHU1QkZDXHU4ODRDXHU1NkRFXHU0RjIwKEhvc3RSZWFkeUxpbmUpXHUzMDAyXG4gKiAgLSBcdTlBRDhcdTcxQjUgdG9rZW4gXHU1M0VBXHU5MDFBXHU4RkM3XHU1QjUwXHU4RkRCXHU3QTBCXHU3M0FGXHU1ODgzXHU1M0Q4XHU5MUNGXHU0RjIwXHU5MDEyLFx1N0VERFx1NEUwRFx1OEZEQiBVUkwvXHU2NUU1XHU1RkQ3L0lQQyBcdTY2MEVcdTY1ODdcdThEMUZcdThGN0RcdTMwMDJcbiAqICAtIFx1NTNFQVx1NTA1Q1x1NkI2Mlx1NjcyQyBzdXBlcnZpc29yIHNwYXduIFx1NzY4NFx1OEZEQlx1N0EwQlx1NTNFNVx1NjdDNDtcdTdFRERcdTRFMERcdTYzMDlcdThGREJcdTdBMEJcdTU0MEQga2lsbFx1MzAwMlxuICogIC0gaG9zdCBjcmFzaCBcdTU0MEVcdTY3MDlcdTk2NTBcdTkxQ0RcdTU0MkY7XHU5MUNEXHU1NDJGXHU0RTBEXHU5MUNEXHU2NTNFXHU0RUZCXHU0RjU1XHU3NTI4XHU2MjM3XHU1MkE4XHU0RjVDKFx1OTc1RVx1NUU0Mlx1N0I0OVx1NTJBOFx1NEY1Q1x1NzUzMVx1NzUyOFx1NjIzN1x1Nzg2RVx1OEJBNClcdTMwMDJcbiAqL1xuaW1wb3J0IHsgc3Bhd24sIHR5cGUgQ2hpbGRQcm9jZXNzIH0gZnJvbSAnbm9kZTpjaGlsZF9wcm9jZXNzJztcbmltcG9ydCB7IGNyZWF0ZUludGVyZmFjZSB9IGZyb20gJ25vZGU6cmVhZGxpbmUnO1xuaW1wb3J0IHsgcmFuZG9tQnl0ZXMgfSBmcm9tICdub2RlOmNyeXB0byc7XG5pbXBvcnQgeyBkZXNrdG9wRXJyb3IsIGlzRGVza3RvcEVycm9yLCB0eXBlIERlc2t0b3BFcnJvciB9IGZyb20gJ0BobWgtZGVza3RvcC9jb250cmFjdHMnO1xuXG5leHBvcnQgdHlwZSBIb3N0U3RhdGUgPVxuICB8ICdzdG9wcGVkJ1xuICB8ICdzdGFydGluZydcbiAgfCAncmVhZHknXG4gIHwgJ2Rpc2Nvbm5lY3RlZCdcbiAgfCAncmVzdGFydGluZydcbiAgfCAnc3RvcHBpbmcnXG4gIHwgJ2ZhaWxlZCc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgSG9zdFNwZWMge1xuICAvKiogXHU1M0VGXHU2MjY3XHU4ODRDXHU2NTg3XHU0RUY2KFx1OTAxQVx1NUUzOCBwcm9jZXNzLmV4ZWNQYXRoKVx1MzAwMiAqL1xuICBjb21tYW5kOiBzdHJpbmc7XG4gIGFyZ3M6IHN0cmluZ1tdO1xuICBjd2Q/OiBzdHJpbmc7XG4gIC8qKiBcdTk4OURcdTU5MTZcdTczQUZcdTU4ODNcdTUzRDhcdTkxQ0YoXHU0RjFBXHU0RTBFIHByb2Nlc3MuZW52IFx1NTQwOFx1NUU3NilcdTMwMDIgKi9cbiAgZW52PzogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBTdXBlcnZpc29yT3B0aW9ucyB7XG4gIC8qKiBcdTY3MUZcdTY3MUIgaG9zdCBcdTY4MjFcdTlBOENcdTc2ODQgYmVhcmVyIHRva2VuO1x1NEUwRFx1NEYyMFx1NTIxOVx1NkJDRlx1NkIyMSBzdGFydCBcdTc1MUZcdTYyMTBcdTlBRDhcdTcxQjVcdTk2OEZcdTY3M0FcdTUwM0NcdTMwMDIgKi9cbiAgdG9rZW4/OiBzdHJpbmc7XG4gIG1heFJlc3RhcnRzPzogbnVtYmVyO1xuICBzdGFydFRpbWVvdXRNcz86IG51bWJlcjtcbiAgZ3JhY2VmdWxTaHV0ZG93bk1zPzogbnVtYmVyO1xuICBvblN0YXRlQ2hhbmdlPyhzdGF0ZTogSG9zdFN0YXRlLCBpbmZvOiB7IHJlc3RhcnRDb3VudDogbnVtYmVyOyBsYXN0RXJyb3I/OiBzdHJpbmcgfSk6IHZvaWQ7XG4gIC8qKiBcdTZCQ0ZcdTZCMjEgaG9zdCBcdTVDMzFcdTdFRUEoXHU1NDJCIGNyYXNoIFx1ODFFQVx1NjEwOFx1NTQwRVx1NzY4NFx1OTFDRFx1NTQyRilcdTkwRkRcdTRGMUFcdTg5RTZcdTUzRDEsXHU2NDNBXHU1RTI2XHU3QUVGXHU3MEI5KFx1NTQyQiB0b2tlbixcbiAgICogIFx1NEVDNVx1NEY5Qlx1NTQwQ1x1NEZFMVx1NEVGQlx1NTdERlx1NzY4NFx1NUJCRlx1NEUzQlx1OEZEQlx1N0EwQlx1OTFDRFx1NUVGQVx1Njg2NVx1NUJBMlx1NjIzN1x1N0FFRjtcdTRFMERcdTg5ODFcdThERThcdThGREIgcmVuZGVyZXIpXHUzMDAyICovXG4gIG9uUmVhZHk/KGVuZHBvaW50OiBIb3N0RW5kcG9pbnQpOiB2b2lkO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEhvc3RFbmRwb2ludCB7XG4gIHBvcnQ6IG51bWJlcjtcbiAgdmVyc2lvbjogc3RyaW5nO1xuICB0b2tlbjogc3RyaW5nO1xufVxuXG4vKiogSG9zdFJlYWR5TGluZSBcdTc2ODRcdTdDN0JcdTU3OEJcdTVCODhcdTUzNkJcdTRFQ0UgY29udHJhY3RzIFx1NUYxNVx1NTE2NSxcdTkwN0ZcdTUxNERcdTUzQ0NcdTVCOUVcdTczQjBcdTMwMDIgKi9cbmltcG9ydCB7IGlzSG9zdFJlYWR5TGluZSB9IGZyb20gJ0BobWgtZGVza3RvcC9jb250cmFjdHMnO1xuXG5jb25zdCBERUZBVUxUX1NUQVJUX1RJTUVPVVRfTVMgPSAyMF8wMDA7XG5jb25zdCBERUZBVUxUX01BWF9SRVNUQVJUUyA9IDM7XG5jb25zdCBERUZBVUxUX0dSQUNFRlVMX01TID0gNV8wMDA7XG5cbmV4cG9ydCBjbGFzcyBEZXNrdG9wUnVudGltZVN1cGVydmlzb3Ige1xuICBwcml2YXRlIGNoaWxkOiBDaGlsZFByb2Nlc3MgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBfc3RhdGU6IEhvc3RTdGF0ZSA9ICdzdG9wcGVkJztcbiAgcHJpdmF0ZSByZXN0YXJ0Q291bnQgPSAwO1xuICBwcml2YXRlIGxhc3RFcnJvciA9ICcnO1xuICBwcml2YXRlIHN0b3BwaW5nID0gZmFsc2U7XG4gIHByaXZhdGUgcmVhZG9ubHkgdG9rZW46IHN0cmluZztcbiAgcHJpdmF0ZSByZWFkb25seSBvcHRzOiBSZXF1aXJlZDxQaWNrPFN1cGVydmlzb3JPcHRpb25zLCAnbWF4UmVzdGFydHMnIHwgJ3N0YXJ0VGltZW91dE1zJyB8ICdncmFjZWZ1bFNodXRkb3duTXMnPj4gJiBTdXBlcnZpc29yT3B0aW9ucztcbiAgcHJpdmF0ZSBleGl0V2FpdGVyczogQXJyYXk8KCkgPT4gdm9pZD4gPSBbXTtcblxuICBjb25zdHJ1Y3RvcihcbiAgICBwcml2YXRlIHJlYWRvbmx5IHNwZWM6IEhvc3RTcGVjLFxuICAgIG9wdHM6IFN1cGVydmlzb3JPcHRpb25zID0ge30sXG4gICkge1xuICAgIHRoaXMudG9rZW4gPSBvcHRzLnRva2VuID8/IHJhbmRvbUJ5dGVzKDMyKS50b1N0cmluZygnYmFzZTY0dXJsJyk7XG4gICAgdGhpcy5vcHRzID0ge1xuICAgICAgbWF4UmVzdGFydHM6IG9wdHMubWF4UmVzdGFydHMgPz8gREVGQVVMVF9NQVhfUkVTVEFSVFMsXG4gICAgICBzdGFydFRpbWVvdXRNczogb3B0cy5zdGFydFRpbWVvdXRNcyA/PyBERUZBVUxUX1NUQVJUX1RJTUVPVVRfTVMsXG4gICAgICBncmFjZWZ1bFNodXRkb3duTXM6IG9wdHMuZ3JhY2VmdWxTaHV0ZG93bk1zID8/IERFRkFVTFRfR1JBQ0VGVUxfTVMsXG4gICAgICAuLi5vcHRzLFxuICAgIH07XG4gIH1cblxuICBnZXQgc3RhdGUoKTogSG9zdFN0YXRlIHtcbiAgICByZXR1cm4gdGhpcy5fc3RhdGU7XG4gIH1cblxuICBnZXQgcmVzdGFydHNVc2VkKCk6IG51bWJlciB7XG4gICAgcmV0dXJuIHRoaXMucmVzdGFydENvdW50O1xuICB9XG5cbiAgcHJpdmF0ZSBzZXRTdGF0ZShzOiBIb3N0U3RhdGUsIGVycj86IHN0cmluZyk6IHZvaWQge1xuICAgIHRoaXMuX3N0YXRlID0gcztcbiAgICBpZiAoZXJyICE9PSB1bmRlZmluZWQpIHRoaXMubGFzdEVycm9yID0gZXJyO1xuICAgIGNvbnN0IGluZm86IHsgcmVzdGFydENvdW50OiBudW1iZXI7IGxhc3RFcnJvcj86IHN0cmluZyB9ID0geyByZXN0YXJ0Q291bnQ6IHRoaXMucmVzdGFydENvdW50IH07XG4gICAgaWYgKHRoaXMubGFzdEVycm9yICE9PSAnJykgaW5mby5sYXN0RXJyb3IgPSB0aGlzLmxhc3RFcnJvcjtcbiAgICB0aGlzLm9wdHMub25TdGF0ZUNoYW5nZT8uKHMsIGluZm8pO1xuICB9XG5cbiAgLyoqIFx1NTQyRlx1NTJBOCBob3N0IFx1NUU3Nlx1N0I0OVx1NUY4NSByZWFkeShcdTVGMTVcdTVCRkNcdTg4NEMgKyBcdTVFMjYgdG9rZW4gXHU3Njg0XHU1MDY1XHU1RUI3XHU2M0EyXHU2RDRCKVx1MzAwMiAqL1xuICBhc3luYyBzdGFydCgpOiBQcm9taXNlPEhvc3RFbmRwb2ludD4ge1xuICAgIGlmICh0aGlzLl9zdGF0ZSA9PT0gJ3JlYWR5JyB8fCB0aGlzLl9zdGF0ZSA9PT0gJ3N0YXJ0aW5nJykge1xuICAgICAgdGhyb3cgZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBzdXBlcnZpc29yIGFscmVhZHkgJHt0aGlzLl9zdGF0ZX1gKTtcbiAgICB9XG4gICAgdGhpcy5yZXN0YXJ0Q291bnQgPSAwO1xuICAgIHRoaXMuc3RvcHBpbmcgPSBmYWxzZTtcbiAgICByZXR1cm4gdGhpcy5sYXVuY2goKTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgbGF1bmNoKCk6IFByb21pc2U8SG9zdEVuZHBvaW50PiB7XG4gICAgdGhpcy5zZXRTdGF0ZSgnc3RhcnRpbmcnKTtcbiAgICBjb25zdCBjaGlsZCA9IHNwYXduKHRoaXMuc3BlYy5jb21tYW5kLCB0aGlzLnNwZWMuYXJncywge1xuICAgICAgY3dkOiB0aGlzLnNwZWMuY3dkLFxuICAgICAgZW52OiB7XG4gICAgICAgIC4uLnByb2Nlc3MuZW52LFxuICAgICAgICAuLi50aGlzLnNwZWMuZW52LFxuICAgICAgICBITUhfREVTS1RPUF9UT0tFTjogdGhpcy50b2tlbixcbiAgICAgIH0sXG4gICAgICBzdGRpbzogWydpZ25vcmUnLCAncGlwZScsICdwaXBlJ10sXG4gICAgICB3aW5kb3dzSGlkZTogdHJ1ZSxcbiAgICB9KTtcbiAgICB0aGlzLmNoaWxkID0gY2hpbGQ7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgZW5kcG9pbnQgPSBhd2FpdCB0aGlzLmF3YWl0UmVhZHkoY2hpbGQpO1xuICAgICAgdGhpcy5jdXJyZW50RW5kcG9pbnQgPSB7IHBvcnQ6IGVuZHBvaW50LnBvcnQsIHZlcnNpb246IGVuZHBvaW50LnZlcnNpb24gfTtcbiAgICAgIHRoaXMuc2V0U3RhdGUoJ3JlYWR5Jyk7XG4gICAgICB0aGlzLm9wdHMub25SZWFkeT8uKGVuZHBvaW50KTtcbiAgICAgIC8vIHJlYWR5IFx1NEU0Qlx1NTQwRVx1OEZEQlx1N0EwQlx1NkI3Qlx1NEVBMSA9IFx1NjEwRlx1NTkxNlx1OTAwMFx1NTFGQSBcdTIxOTIgXHU2NzA5XHU5NjUwXHU5MUNEXHU1NDJGXG4gICAgICBjaGlsZC5vbmNlKCdleGl0JywgKCkgPT4ge1xuICAgICAgICB0aGlzLmV4aXRXYWl0ZXJzLmZvckVhY2goKHcpID0+IHcoKSk7XG4gICAgICAgIHRoaXMuZXhpdFdhaXRlcnMgPSBbXTtcbiAgICAgICAgdGhpcy5vblVuZXhwZWN0ZWRFeGl0KCk7XG4gICAgICB9KTtcbiAgICAgIHJldHVybiBlbmRwb2ludDtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGlmICghY2hpbGQua2lsbGVkKSBjaGlsZC5raWxsKCk7XG4gICAgICBpZiAodGhpcy5jaGlsZCA9PT0gY2hpbGQpIHRoaXMuY2hpbGQgPSBudWxsO1xuICAgICAgdGhyb3cgZXJyO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBcdTRFQ0Ugc3Rkb3V0IFx1NjI3RSBIb3N0UmVhZHlMaW5lLFx1NzEzNlx1NTQwRVx1NTA2NVx1NUVCN1x1NjNBMlx1NkQ0Qlx1MzAwMiAqL1xuICBwcml2YXRlIGF3YWl0UmVhZHkoY2hpbGQ6IENoaWxkUHJvY2Vzcyk6IFByb21pc2U8SG9zdEVuZHBvaW50PiB7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlPEhvc3RFbmRwb2ludD4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgcmVqZWN0KGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgaG9zdCBkaWQgbm90IHNpZ25hbCByZWFkeSB3aXRoaW4gJHt0aGlzLm9wdHMuc3RhcnRUaW1lb3V0TXN9bXNgLCB7IHJldHJ5YWJsZTogdHJ1ZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcbiAgICAgIH0sIHRoaXMub3B0cy5zdGFydFRpbWVvdXRNcyk7XG5cbiAgICAgIGNvbnN0IGRvbmUgPSAoZm46ICgpID0+IHZvaWQpOiB2b2lkID0+IHtcbiAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgICAgZm4oKTtcbiAgICAgIH07XG5cbiAgICAgIGlmICghY2hpbGQuc3Rkb3V0KSB7XG4gICAgICAgIGRvbmUoKCkgPT4gcmVqZWN0KGRlc2t0b3BFcnJvcignUlVOVElNRV9DUkFTSEVEJywgJ2hvc3Qgc3Bhd25lZCB3aXRob3V0IHN0ZG91dCBwaXBlJykpKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBybCA9IGNyZWF0ZUludGVyZmFjZSh7IGlucHV0OiBjaGlsZC5zdGRvdXQgfSk7XG4gICAgICBjb25zdCBvbkxpbmUgPSAobGluZTogc3RyaW5nKTogdm9pZCA9PiB7XG4gICAgICAgIGxldCBwYXJzZWQ6IHVua25vd247XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcGFyc2VkID0gSlNPTi5wYXJzZShsaW5lKTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgcmV0dXJuOyAvLyBob3N0IFx1NzY4NFx1NjY2RVx1OTAxQVx1NjVFNVx1NUZEN1x1ODg0QyxcdTVGRkRcdTc1NjVcbiAgICAgICAgfVxuICAgICAgICBpZiAoaXNIb3N0UmVhZHlMaW5lKHBhcnNlZCkpIHtcbiAgICAgICAgICBybC5jbG9zZSgpO1xuICAgICAgICAgIHZvaWQgdGhpcy5wcm9iZUFuZFJlbWVtYmVyKHBhcnNlZC5wb3J0LCBwYXJzZWQudmVyc2lvbilcbiAgICAgICAgICAgIC50aGVuKChlbmRwb2ludCkgPT4gZG9uZSgoKSA9PiByZXNvbHZlKGVuZHBvaW50KSkpXG4gICAgICAgICAgICAuY2F0Y2goKGVycjogdW5rbm93bikgPT4gZG9uZSgoKSA9PiByZWplY3QoZXJyKSkpO1xuICAgICAgICB9XG4gICAgICB9O1xuICAgICAgcmwub24oJ2xpbmUnLCBvbkxpbmUpO1xuXG4gICAgICBjaGlsZC5vbmNlKCdleGl0JywgKGNvZGUpID0+IHtcbiAgICAgICAgZG9uZSgoKSA9PiByZWplY3QoZGVza3RvcEVycm9yKCdSVU5USU1FX0NSQVNIRUQnLCBgaG9zdCBleGl0ZWQgZHVyaW5nIHN0YXJ0dXAgKGNvZGUgJHtjb2RlID8/ICdudWxsJ30pYCwgeyByZXRyeWFibGU6IGZhbHNlLCByZWNvdmVyeUFjdGlvbjogJ09QRU5fTE9HUycgfSkpKTtcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9XG5cbiAgLyoqIFx1NUUyNiB0b2tlbiBcdTc2ODRcdTUwNjVcdTVFQjdcdTYzQTJcdTZENEI6R0VUIC9hcGkvc3RhdGVcdTMwMDI0MDEgXHUyMTkyIEFVVEhfRkFJTEVEKFx1NEUwRFx1OTFDRFx1OEJENSlcdTMwMDIgKi9cbiAgcHJpdmF0ZSBhc3luYyBwcm9iZShwb3J0OiBudW1iZXIsIHZlcnNpb246IHN0cmluZyk6IFByb21pc2U8SG9zdEVuZHBvaW50PiB7XG4gICAgbGV0IHJlczogUmVzcG9uc2U7XG4gICAgdHJ5IHtcbiAgICAgIHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vYXBpL3N0YXRlYCwge1xuICAgICAgICBoZWFkZXJzOiB7ICd4LWhtaC1rZXknOiB0aGlzLnRva2VuIH0sXG4gICAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCgzXzAwMCksXG4gICAgICB9KTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHRocm93IGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgaGVhbHRoIHByb2JlIGZhaWxlZDogJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxNjApfWAsIHsgcmV0cnlhYmxlOiB0cnVlIH0pO1xuICAgIH1cbiAgICBpZiAocmVzLnN0YXR1cyA9PT0gNDAxIHx8IHJlcy5zdGF0dXMgPT09IDQwMykge1xuICAgICAgdGhyb3cgZGVza3RvcEVycm9yKCdBVVRIX0ZBSUxFRCcsIGBob3N0IHJlamVjdGVkIHRoZSBzZXNzaW9uIHRva2VuIChIVFRQICR7cmVzLnN0YXR1c30pYCwgeyByZXRyeWFibGU6IGZhbHNlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSk7XG4gICAgfVxuICAgIGlmICghcmVzLm9rKSB7XG4gICAgICB0aHJvdyBkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYGhlYWx0aCBwcm9iZSBIVFRQICR7cmVzLnN0YXR1c31gLCB7IHJldHJ5YWJsZTogdHJ1ZSB9KTtcbiAgICB9XG4gICAgcmV0dXJuIHsgcG9ydCwgdmVyc2lvbiwgdG9rZW46IHRoaXMudG9rZW4gfTtcbiAgfVxuXG4gIHByaXZhdGUgb25VbmV4cGVjdGVkRXhpdCgpOiB2b2lkIHtcbiAgICBpZiAodGhpcy5zdG9wcGluZyB8fCB0aGlzLl9zdGF0ZSA9PT0gJ3N0b3BwZWQnIHx8IHRoaXMuX3N0YXRlID09PSAnc3RvcHBpbmcnKSByZXR1cm47XG4gICAgdGhpcy5jaGlsZCA9IG51bGw7XG4gICAgaWYgKHRoaXMucmVzdGFydENvdW50IDwgdGhpcy5vcHRzLm1heFJlc3RhcnRzKSB7XG4gICAgICB0aGlzLnJlc3RhcnRDb3VudCArPSAxO1xuICAgICAgdGhpcy5zZXRTdGF0ZSgncmVzdGFydGluZycpO1xuICAgICAgdm9pZCB0aGlzLmxhdW5jaCgpLmNhdGNoKCgpID0+IHtcbiAgICAgICAgLy8gXHU5MUNEXHU1NDJGXHU1QzFEXHU4QkQ1XHU1OTMxXHU4RDI1KFx1NTQyRlx1NTJBOFx1NTM3M1x1NUQyOS9cdThEODVcdTY1RjYvXHU2MkQyXHU4QkE0KTpcdTdFRTdcdTdFRURcdTZEODhcdTgwMTdcdTkxQ0RcdTU0MkZcdTZCMjFcdTY1NzBcdTc2RjRcdTUyMzBcdTY1M0VcdTVGMDNcbiAgICAgICAgdGhpcy5yZXRyeU9yRmFpbCgpO1xuICAgICAgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMuc2V0U3RhdGUoJ2ZhaWxlZCcsIGBob3N0IGV4aXRlZCB1bmV4cGVjdGVkbHkgJHt0aGlzLnJlc3RhcnRDb3VudCArIDF9IHRpbWVzOyBnaXZpbmcgdXBgKTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIHJldHJ5T3JGYWlsKCk6IHZvaWQge1xuICAgIGlmICh0aGlzLnN0b3BwaW5nIHx8IHRoaXMuX3N0YXRlID09PSAnc3RvcHBlZCcgfHwgdGhpcy5fc3RhdGUgPT09ICdzdG9wcGluZycpIHJldHVybjtcbiAgICBpZiAodGhpcy5yZXN0YXJ0Q291bnQgPCB0aGlzLm9wdHMubWF4UmVzdGFydHMpIHtcbiAgICAgIHRoaXMucmVzdGFydENvdW50ICs9IDE7XG4gICAgICB0aGlzLnNldFN0YXRlKCdyZXN0YXJ0aW5nJyk7XG4gICAgICB2b2lkIHRoaXMubGF1bmNoKCkuY2F0Y2goKCkgPT4gdGhpcy5yZXRyeU9yRmFpbCgpKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5zZXRTdGF0ZSgnZmFpbGVkJywgYGhvc3QgZmFpbGVkIHRvIHN0YXkgdXAgYWZ0ZXIgJHt0aGlzLnJlc3RhcnRDb3VudH0gcmVzdGFydCBhdHRlbXB0c2ApO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBcdTRGMThcdTk2QzVcdTUwNUNcdTZCNjI6XHU1MTQ4IEhUVFAgc2h1dGRvd24sXHU4RDg1XHU2NUY2XHU2MjREXHU1QkY5XHU2NzJDXHU4RkRCXHU3QTBCXHU1M0U1XHU2N0M0IGtpbGxcdTMwMDIgKi9cbiAgYXN5bmMgc3RvcCgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICB0aGlzLnN0b3BwaW5nID0gdHJ1ZTtcbiAgICBpZiAodGhpcy5fc3RhdGUgPT09ICdzdG9wcGVkJykgcmV0dXJuO1xuICAgIHRoaXMuc2V0U3RhdGUoJ3N0b3BwaW5nJyk7XG4gICAgY29uc3QgY2hpbGQgPSB0aGlzLmNoaWxkO1xuICAgIHRoaXMuY2hpbGQgPSBudWxsO1xuICAgIHRoaXMuY3VycmVudEVuZHBvaW50ID0gbnVsbDtcbiAgICBpZiAoIWNoaWxkKSB7XG4gICAgICB0aGlzLnNldFN0YXRlKCdzdG9wcGVkJyk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IGV4aXRlZCA9IG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlKSA9PiB7XG4gICAgICBpZiAoY2hpbGQuZXhpdENvZGUgIT09IG51bGwgfHwgY2hpbGQuc2lnbmFsQ29kZSAhPT0gbnVsbCkgcmVzb2x2ZSgpO1xuICAgICAgZWxzZSB7XG4gICAgICAgIGNvbnN0IHcgPSAoKTogdm9pZCA9PiByZXNvbHZlKCk7XG4gICAgICAgIHRoaXMuZXhpdFdhaXRlcnMucHVzaCh3KTtcbiAgICAgICAgY2hpbGQub25jZSgnZXhpdCcsIHcpO1xuICAgICAgfVxuICAgIH0pO1xuICAgIC8vIFx1NURGMlx1NzdFNVx1N0FFRlx1NTNFM1x1NjI0RFx1NUMxRFx1OEJENSBIVFRQIFx1NEYxOFx1OTZDNVx1NTE3M1x1OTVFRDtcdTY3MkFcdTc3RTVcdTdBRUZcdTUzRTNcdTc2RjRcdTYzQTVcdThENzAga2lsbCBcdTUxNUNcdTVFOTVcbiAgICBpZiAodGhpcy5sYXN0RW5kcG9pbnQgIT09IG51bGwpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7dGhpcy5sYXN0RW5kcG9pbnR9L2FwaS9kZXNrdG9wL3NodXRkb3duYCwge1xuICAgICAgICAgIG1ldGhvZDogJ1BPU1QnLFxuICAgICAgICAgIGhlYWRlcnM6IHsgJ3gtaG1oLWtleSc6IHRoaXMudG9rZW4gfSxcbiAgICAgICAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoMV8wMDApLFxuICAgICAgICB9KTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvLyBob3N0IFx1NURGMlx1NkI3Qlx1NjIxNlx1NEUwRFx1NUU5NFx1N0I1NDpcdThENzAga2lsbCBcdTUxNUNcdTVFOTVcbiAgICAgIH1cbiAgICB9XG4gICAgY29uc3QgZ3JhY2VmdWwgPSBhd2FpdCBQcm9taXNlLnJhY2UoW1xuICAgICAgZXhpdGVkLnRoZW4oKCkgPT4gdHJ1ZSksXG4gICAgICBuZXcgUHJvbWlzZTxib29sZWFuPigocmVzb2x2ZSkgPT4gc2V0VGltZW91dCgoKSA9PiByZXNvbHZlKGZhbHNlKSwgdGhpcy5vcHRzLmdyYWNlZnVsU2h1dGRvd25NcykpLFxuICAgIF0pO1xuICAgIGlmICghZ3JhY2VmdWwgJiYgY2hpbGQuZXhpdENvZGUgPT09IG51bGwgJiYgY2hpbGQuc2lnbmFsQ29kZSA9PT0gbnVsbCkge1xuICAgICAgY2hpbGQua2lsbCgpOyAvLyBcdTUzRUFcdTY3NDBcdTgxRUFcdTVERjFcdTYzMDFcdTY3MDlcdTc2ODRcdTUzRTVcdTY3QzQsXHU3RUREXHU0RTBEXHU2MzA5XHU4RkRCXHU3QTBCXHU1NDBEXG4gICAgfVxuICAgIGF3YWl0IGV4aXRlZC5jYXRjaCgoKSA9PiB1bmRlZmluZWQpO1xuICAgIHRoaXMuc2V0U3RhdGUoJ3N0b3BwZWQnKTtcbiAgfVxuXG4gIHByaXZhdGUgbGFzdEVuZHBvaW50OiBudW1iZXIgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBjdXJyZW50RW5kcG9pbnQ6IHsgcG9ydDogbnVtYmVyOyB2ZXJzaW9uOiBzdHJpbmcgfSB8IG51bGwgPSBudWxsO1xuXG4gIC8qKiBcdTVGNTNcdTUyNEQgaG9zdCBcdTdBRUZcdTcwQjkocmVhZHkgXHU1NDBFXHU2NzA5XHU1MDNDO1x1NEUwRFx1NTQyQiB0b2tlbilcdTMwMDIgKi9cbiAgZ2V0IGVuZHBvaW50KCk6IHsgcG9ydDogbnVtYmVyOyB2ZXJzaW9uOiBzdHJpbmcgfSB8IG51bGwge1xuICAgIHJldHVybiB0aGlzLmN1cnJlbnRFbmRwb2ludDtcbiAgfVxuXG4gIC8qKiBcdTYzQTJcdTZENEJcdTYyMTBcdTUyOUZcdTU0MEVcdThCQjBcdTRGNEZcdTdBRUZcdTUzRTMsXHU0RjlCIHN0b3AoKSBcdTc2ODRcdTRGMThcdTk2QzVcdTUxNzNcdTk1RURcdTRGN0ZcdTc1MjhcdTMwMDIgKi9cbiAgcHJpdmF0ZSBhc3luYyBwcm9iZUFuZFJlbWVtYmVyKHBvcnQ6IG51bWJlciwgdmVyc2lvbjogc3RyaW5nKTogUHJvbWlzZTxIb3N0RW5kcG9pbnQ+IHtcbiAgICBjb25zdCBlcCA9IGF3YWl0IHRoaXMucHJvYmUocG9ydCwgdmVyc2lvbik7XG4gICAgdGhpcy5sYXN0RW5kcG9pbnQgPSBlcC5wb3J0O1xuICAgIHJldHVybiBlcDtcbiAgfVxufVxuXG4vKiogXHU2MjhBXHU2NzJBXHU3N0U1XHU5NTE5XHU4QkVGXHU4OUM0XHU3RUE2XHU0RTNBIERlc2t0b3BFcnJvcihcdTVERjJcdTY2MkZcdTUyMTlcdTUzOUZcdTY4MzdcdThGRDRcdTU2REUpXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gdG9EZXNrdG9wRXJyb3IoZXJyOiB1bmtub3duKTogRGVza3RvcEVycm9yIHtcbiAgaWYgKGlzRGVza3RvcEVycm9yKGVycikpIHJldHVybiBlcnI7XG4gIGNvbnN0IG1lc3NhZ2UgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gIHJldHVybiBkZXNrdG9wRXJyb3IoJ1JVTlRJTUVfQ1JBU0hFRCcsIG1lc3NhZ2Uuc2xpY2UoMCwgMzAwKSwgeyByZXRyeWFibGU6IGZhbHNlIH0pO1xufVxuIiwgIi8qKlxuICogQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyBcdTIwMTQgXHU0RThCXHU0RUY2XHU0RkUxXHU1QzAxKFx1NUYwMFx1NTNEMVx1OEJBMVx1NTIxMlx1NjU4N1x1Njg2MyAwNCBcdTAwQTdcdTRFMDkpXG4gKlxuICogXHU0RTAwXHU2NzYxIFVJIFx1NEU4Qlx1NEVGNlx1NzY4NFx1NTUyRlx1NEUwMFx1NUY2Mlx1NzJCNlx1MzAwMlx1NTI0RFx1N0FFRiByZWR1Y2VyIFx1NUZDNVx1OTg3Qlx1NjMwOSBzZXNzaW9uSWQvcnVuSWQvc2VxIFx1NTkwNFx1NzQwNjtcbiAqIFx1OTFDRFx1NTkwRCBldmVudElkIFx1NUU0Mlx1N0I0OVx1NEUyMlx1NUYwMztzZXEgXHU3RjNBXHU1M0UzXHU4OUU2XHU1M0QxXHU4ODY1XHU2MkM5O1x1OTc1RVx1NUU0Mlx1N0I0OVx1NTJBOFx1NEY1Q1x1NEUwRFx1NzUzMSBTU0UgXHU4MUVBXHU1MkE4XHU5MUNEXHU1M0QxXHUzMDAyXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBBcnRpZmFjdFJlZiB9IGZyb20gJy4vZHRvLnRzJztcbmltcG9ydCB0eXBlIHsgRGVza3RvcEVycm9yIH0gZnJvbSAnLi9lcnJvci50cyc7XG5cbi8qKiBcdTRFOEJcdTRFRjZcdTc5Q0RcdTdDN0IoXHU1MjI0XHU1MjJCXHU5NTJFKVx1MzAwMlx1NjVCMFx1NTg5RSBraW5kID0gc2NoZW1hVmVyc2lvbiBcdTUzNDdcdTdFQTcsXHU0RTBEXHU1MTQxXHU4QkI4XHU5NzU5XHU5RUQ4XHU2MjY5XHU2NzlBXHU0RTNFXHUzMDAyICovXG5leHBvcnQgY29uc3QgRVZFTlRfS0lORFMgPSBbXG4gICdydW4uc3RhcnRlZCcsXG4gICdwbGFuLnVwZGF0ZWQnLFxuICAndG9vbC5zdGFydGVkJyxcbiAgJ3Rvb2wuY29tcGxldGVkJyxcbiAgJ2FwcHJvdmFsLnJlcXVpcmVkJyxcbiAgJ3ZlcmlmaWNhdGlvbi51cGRhdGVkJyxcbiAgJ2FydGlmYWN0LmNyZWF0ZWQnLFxuICAncnVuLmNvbXBsZXRlZCcsXG4gICdydW4uZmFpbGVkJyxcbl0gYXMgY29uc3Q7XG5cbmV4cG9ydCB0eXBlIEV2ZW50S2luZCA9ICh0eXBlb2YgRVZFTlRfS0lORFMpW251bWJlcl07XG5cbmV4cG9ydCBjb25zdCBFVkVOVF9TQ0hFTUFfVkVSU0lPTiA9IDE7XG5leHBvcnQgdHlwZSBFdmVudFNjaGVtYVZlcnNpb24gPSAxO1xuXG4vKiogU1NFIFx1NkQ0MVx1NEUwQVx1NzY4NFx1NkJDRlx1NEUwMFx1Njc2MVx1NEU4Qlx1NEVGNlx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBFdmVudEVudmVsb3BlPFQgPSB1bmtub3duPiB7XG4gIHNjaGVtYVZlcnNpb246IEV2ZW50U2NoZW1hVmVyc2lvbjtcbiAgLyoqIFx1NTE2OFx1NUM0MFx1NTUyRlx1NEUwMDtcdTkxQ0RcdThGREUvXHU4ODY1XHU2MkM5XHU1NDBFXHU5MUNEXHU1OTBEXHU1MUZBXHU3M0IwXHU2NUY2XHU2M0E1XHU2NTM2XHU2NUI5XHU1RTQyXHU3QjQ5XHU0RTIyXHU1RjAzXHUzMDAyICovXG4gIGV2ZW50SWQ6IHN0cmluZztcbiAgc2Vzc2lvbklkOiBzdHJpbmc7XG4gIHJ1bklkOiBzdHJpbmc7XG4gIC8qKiBcdTRGMUFcdThCRERcdTUxODVcdTUzNTVcdThDMDNcdTkwMTJcdTU4OUU7XHU3RjNBXHU1M0UzXHU2MTBGXHU1NDczXHU3NzQwXHU0RTIyXHU0RThCXHU0RUY2LFx1OTcwMFx1ODk4MVx1ODg2NVx1NjJDOVx1MzAwMiAqL1xuICBzZXE6IG51bWJlcjtcbiAgLyoqIFJGQzMzMzlcdTMwMDIgKi9cbiAgb2NjdXJyZWRBdDogc3RyaW5nO1xuICBraW5kOiBFdmVudEtpbmQ7XG4gIHBheWxvYWQ6IFQ7XG59XG5cbi8qKiBydW4uc3RhcnRlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBSdW5TdGFydGVkUGF5bG9hZCB7XG4gIHRhc2s6IHN0cmluZztcbiAgbW9kZTogJ2FzaycgfCAnYXV0bycgfCAneW9sbyc7XG59XG5cbi8qKiBwbGFuLnVwZGF0ZWQgXHU3Njg0IHBheWxvYWQoXHU4QkExXHU1MjEyXHU2QjY1XHU5QUE0XHU1MjE3XHU4ODY4LFx1Njc2NVx1ODFFQSBydW50aW1lIFx1NzY4NFx1N0VEM1x1Njc4NFx1NTMxNlx1OEJBMVx1NTIxMixcdTRFMERcdTY2MkYgY2hhaW4tb2YtdGhvdWdodClcdTMwMDIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgUGxhblVwZGF0ZWRQYXlsb2FkIHtcbiAgc3RlcHM6IEFycmF5PHsgdGl0bGU6IHN0cmluZzsgc3RhdHVzOiAncGVuZGluZycgfCAnYWN0aXZlJyB8ICdkb25lJyB8ICdmYWlsZWQnIH0+O1xufVxuXG4vKiogdG9vbC5zdGFydGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIFRvb2xTdGFydGVkUGF5bG9hZCB7XG4gIG5hbWU6IHN0cmluZztcbiAgLyoqIFx1NTNDMlx1NjU3MFx1NEVFNVx1NjU4N1x1NjcyQ1x1NTQ0OFx1NzNCMCxcdTZFMzJcdTY3RDNcdTdBRUZcdTZDMzhcdTRFMEQgZXZhbDtcdTU5MjdcdTVCRjlcdThDNjFcdTc1MzEgcnVudGltZSBcdTYyMkFcdTY1QURcdTMwMDIgKi9cbiAgYXJnc1ByZXZpZXc6IHN0cmluZztcbn1cblxuLyoqIHRvb2wuY29tcGxldGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIFRvb2xDb21wbGV0ZWRQYXlsb2FkIHtcbiAgbmFtZTogc3RyaW5nO1xuICBpc0Vycm9yOiBib29sZWFuO1xuICBvdXRwdXRQcmV2aWV3OiBzdHJpbmc7XG59XG5cbi8qKiBhcHByb3ZhbC5yZXF1aXJlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMlx1NUJBMVx1NjI3OVx1Njc0M1x1NUEwMVx1NTcyOCBydW50aW1lIFx1NTQwRVx1N0FFRjtVSSBcdTUzRUFcdTY2MkZcdThGNkNcdThGRjBcdTMwMDIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwcm92YWxSZXF1aXJlZFBheWxvYWQge1xuICBhcHByb3ZhbElkOiBzdHJpbmc7XG4gIHRvb2w6IHN0cmluZztcbiAgYXJnc1ByZXZpZXc6IHN0cmluZztcbiAgLyoqIFx1NUY3MVx1NTRDRFx1ODMwM1x1NTZGNC9cdTk4Q0VcdTk2NjlcdTc2ODRcdTRFQkFcdTdDN0JcdTUzRUZcdThCRkJcdThCRjRcdTY2MEUsXHU3NTMxIHJ1bnRpbWUgXHU3NTFGXHU2MjEwXHUzMDAyICovXG4gIHJpc2s6IHN0cmluZztcbn1cblxuLyoqIHZlcmlmaWNhdGlvbi51cGRhdGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIFZlcmlmaWNhdGlvblVwZGF0ZWRQYXlsb2FkIHtcbiAgc3VtbWFyeTogc3RyaW5nO1xuICBwYXNzZWQ6IGJvb2xlYW4gfCBudWxsOyAvLyBudWxsID0gXHU2NzJBXHU3N0U1L1x1OEZEQlx1ODg0Q1x1NEUyRChORUVEUy1EQVRBIFx1NjVGNlx1NEUwRFx1NTA0N1x1NTg2Qilcbn1cblxuLyoqIGFydGlmYWN0LmNyZWF0ZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXJ0aWZhY3RDcmVhdGVkUGF5bG9hZCB7XG4gIGFydGlmYWN0OiBBcnRpZmFjdFJlZjtcbn1cblxuLyoqIHJ1bi5jb21wbGV0ZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgUnVuQ29tcGxldGVkUGF5bG9hZCB7XG4gIHRleHQ6IHN0cmluZztcbiAgdHVybnM6IG51bWJlcjtcbiAgdG9vbFVzZXM6IG51bWJlcjtcbiAgdXNhZ2U/OiB7IHByb21wdFRva2VuczogbnVtYmVyOyBjb21wbGV0aW9uVG9rZW5zOiBudW1iZXIgfTtcbn1cblxuLyoqIHJ1bi5mYWlsZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgUnVuRmFpbGVkUGF5bG9hZCB7XG4gIGVycm9yOiBEZXNrdG9wRXJyb3I7XG59XG4iLCAiLyoqXG4gKiBAaG1oLWRlc2t0b3AvY29udHJhY3RzIFx1MjAxNCBcdTdFRDNcdTY3ODRcdTUzMTZcdTY4NENcdTk3NjJcdTk1MTlcdThCRUYoXHU1RjAwXHU1M0QxXHU4QkExXHU1MjEyXHU2NTg3XHU2ODYzIDA0IFx1MDBBN1x1NEUwOSlcdTMwMDJcbiAqXG4gKiBob3N0LW5vdC1yZWFkeSAvIGF1dGgtZmFpbGVkIC8gc3RhbGUtdmVyc2lvbiAvIHJ1bnRpbWUtY3Jhc2hlZCAvXG4gKiBwb3J0LWJpbmQtZmFpbGVkIC8gc2NoZW1hLW1pc21hdGNoIFx1NUZDNVx1OTg3Qlx1NjYyRlx1N0VEM1x1Njc4NFx1NTMxNlx1OTUxOVx1OEJFRlx1NzgwMSxcdTVFNzZcdTYzRDBcdTRGOUJcdTRFMEJcdTRFMDBcdTZCNjVcdTUyQThcdTRGNUNcdTMwMDJcbiAqIG1lc3NhZ2UgXHU2NjJGXHU3RUFGXHU2NTg3XHU2NzJDLFx1NkUzMlx1NjdEM1x1N0FFRlx1NkMzOFx1NEUwRFx1NjI4QVx1NUI4M1x1NUY1MyBIVE1MXHUzMDAyXG4gKi9cbmV4cG9ydCBjb25zdCBFUlJPUl9DT0RFUyA9IFtcbiAgJ0hPU1RfTk9UX1JFQURZJyxcbiAgJ0FVVEhfRkFJTEVEJyxcbiAgJ1JVTlRJTUVfQ1JBU0hFRCcsXG4gICdQT1JUX0JJTkRfRkFJTEVEJyxcbiAgJ1NUQUxFX1ZFUlNJT04nLFxuICAnU0NIRU1BX01JU01BVENIJyxcbl0gYXMgY29uc3Q7XG5cbmV4cG9ydCB0eXBlIEVycm9yQ29kZSA9ICh0eXBlb2YgRVJST1JfQ09ERVMpW251bWJlcl07XG5cbmV4cG9ydCBjb25zdCBSRUNPVkVSWV9BQ1RJT05TID0gWydSRUNPTk5FQ1QnLCAnUkVTVU1FJywgJ0VYUE9SVCcsICdPUEVOX0xPR1MnXSBhcyBjb25zdDtcbmV4cG9ydCB0eXBlIFJlY292ZXJ5QWN0aW9uID0gKHR5cGVvZiBSRUNPVkVSWV9BQ1RJT05TKVtudW1iZXJdO1xuXG5leHBvcnQgaW50ZXJmYWNlIERlc2t0b3BFcnJvciB7XG4gIGNvZGU6IEVycm9yQ29kZTtcbiAgLyoqIFx1N0VBRlx1NjU4N1x1NjcyQyxcdTZDMzhcdTRFMERcdTRGRTFcdTRFRkJcdTRFM0EgSFRNTFx1MzAwMiAqL1xuICBtZXNzYWdlOiBzdHJpbmc7XG4gIHJldHJ5YWJsZTogYm9vbGVhbjtcbiAgc2Vzc2lvbklkPzogc3RyaW5nO1xuICBydW5JZD86IHN0cmluZztcbiAgcmVjb3ZlcnlBY3Rpb24/OiBSZWNvdmVyeUFjdGlvbjtcbn1cblxuLyoqIFx1Njc4NFx1OTAyMFx1NEUwMFx1NEUyQSBEZXNrdG9wRXJyb3IoZXhhY3RPcHRpb25hbFByb3BlcnR5VHlwZXMgXHU1M0NCXHU1OTdEKVx1MzAwMiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRlc2t0b3BFcnJvcihcbiAgY29kZTogRXJyb3JDb2RlLFxuICBtZXNzYWdlOiBzdHJpbmcsXG4gIG9wdHM6IHsgcmV0cnlhYmxlPzogYm9vbGVhbjsgc2Vzc2lvbklkPzogc3RyaW5nOyBydW5JZD86IHN0cmluZzsgcmVjb3ZlcnlBY3Rpb24/OiBSZWNvdmVyeUFjdGlvbiB9ID0ge30sXG4pOiBEZXNrdG9wRXJyb3Ige1xuICBjb25zdCBlOiBEZXNrdG9wRXJyb3IgPSB7IGNvZGUsIG1lc3NhZ2UsIHJldHJ5YWJsZTogb3B0cy5yZXRyeWFibGUgPT09IHRydWUgfTtcbiAgaWYgKG9wdHMuc2Vzc2lvbklkICE9PSB1bmRlZmluZWQpIGUuc2Vzc2lvbklkID0gb3B0cy5zZXNzaW9uSWQ7XG4gIGlmIChvcHRzLnJ1bklkICE9PSB1bmRlZmluZWQpIGUucnVuSWQgPSBvcHRzLnJ1bklkO1xuICBpZiAob3B0cy5yZWNvdmVyeUFjdGlvbiAhPT0gdW5kZWZpbmVkKSBlLnJlY292ZXJ5QWN0aW9uID0gb3B0cy5yZWNvdmVyeUFjdGlvbjtcbiAgcmV0dXJuIGU7XG59XG4iLCAiLyoqXG4gKiBAaG1oLWRlc2t0b3AvY29udHJhY3RzIFx1MjAxNCBydW50aW1lIFx1NjgyMVx1OUE4QyhndWFyZHMpXHUzMDAyXG4gKlxuICogXHU2QkNGXHU0RTJBXHU4REU4XHU0RkUxXHU0RUZCXHU4RkI5XHU3NTRDXHU3Njg0XHU2NTcwXHU2MzZFKHJ1bnRpbWVcdTIxOTJyZW5kZXJlclx1MzAwMWhvc3RcdTIxOTJtYWluKVx1OEZEQlx1NTE2NVx1NTI0RFx1NTE0OFx1OEZDNyBndWFyZDtcbiAqIFx1NjgyMVx1OUE4Q1x1NTkzMVx1OEQyNVx1NzY4NFx1NjU3MFx1NjM2RVx1NjMwOSBTQ0hFTUFfTUlTTUFUQ0ggXHU3RUQzXHU2Nzg0XHU1MzE2XHU5NTE5XHU4QkVGXHU1OTA0XHU3NDA2LFx1NEUwRFx1OTc1OVx1OUVEOFx1NjNBNVx1NTNEN1x1MzAwMlxuICogXHU2MjRCXHU1MTk5XHU1Qjg4XHU1MzZCXHU4MDBDXHU0RTBEXHU2NjJGXHU1RjE1XHU3QjJDXHU0RTA5XHU2NUI5IHNjaGVtYSBcdTVFOTM6XHU1OTUxXHU3RUE2XHU5NzYyXHU1QzBGLFx1OTZGNlx1NEY5RFx1OEQ1Nlx1NjU4N1x1NTMxNihobWhhcm5lc3MgXHU1NDBDXHU2RTkwKVx1MzAwMlxuICovXG5pbXBvcnQge1xuICBFVkVOVF9LSU5EUyxcbiAgRVZFTlRfU0NIRU1BX1ZFUlNJT04sXG4gIHR5cGUgRXZlbnRFbnZlbG9wZSxcbiAgdHlwZSBFdmVudEtpbmQsXG59IGZyb20gJy4vZXZlbnQudHMnO1xuaW1wb3J0IHsgRVJST1JfQ09ERVMsIFJFQ09WRVJZX0FDVElPTlMsIHR5cGUgRGVza3RvcEVycm9yIH0gZnJvbSAnLi9lcnJvci50cyc7XG5pbXBvcnQgeyBSVU5fU1RBVFVTRVMsIHR5cGUgUnVuU3RhdHVzIH0gZnJvbSAnLi9kdG8udHMnO1xuXG5jb25zdCBpc1JlY29yZCA9ICh2OiB1bmtub3duKTogdiBpcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9PlxuICB0eXBlb2YgdiA9PT0gJ29iamVjdCcgJiYgdiAhPT0gbnVsbCAmJiAhQXJyYXkuaXNBcnJheSh2KTtcblxuY29uc3QgaXNOb25FbXB0eVN0cmluZyA9ICh2OiB1bmtub3duKTogdiBpcyBzdHJpbmcgPT4gdHlwZW9mIHYgPT09ICdzdHJpbmcnICYmIHYubGVuZ3RoID4gMDtcblxuY29uc3QgaXNSZmMzMzM5ID0gKHY6IHN0cmluZyk6IGJvb2xlYW4gPT4ge1xuICBjb25zdCB0ID0gRGF0ZS5wYXJzZSh2KTtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZSh0KSAmJiAvXFxkezR9LVxcZHsyfS1cXGR7Mn1ULy50ZXN0KHYpO1xufTtcblxuZXhwb3J0IGZ1bmN0aW9uIGlzRXZlbnRFbnZlbG9wZSh2OiB1bmtub3duKTogdiBpcyBFdmVudEVudmVsb3BlIHtcbiAgaWYgKCFpc1JlY29yZCh2KSkgcmV0dXJuIGZhbHNlO1xuICBpZiAodi5zY2hlbWFWZXJzaW9uICE9PSBFVkVOVF9TQ0hFTUFfVkVSU0lPTikgcmV0dXJuIGZhbHNlO1xuICBpZiAoIWlzTm9uRW1wdHlTdHJpbmcodi5ldmVudElkKSkgcmV0dXJuIGZhbHNlO1xuICBpZiAoIWlzTm9uRW1wdHlTdHJpbmcodi5zZXNzaW9uSWQpKSByZXR1cm4gZmFsc2U7XG4gIGlmICghaXNOb25FbXB0eVN0cmluZyh2LnJ1bklkKSkgcmV0dXJuIGZhbHNlO1xuICBpZiAodHlwZW9mIHYuc2VxICE9PSAnbnVtYmVyJyB8fCAhTnVtYmVyLmlzSW50ZWdlcih2LnNlcSkgfHwgdi5zZXEgPCAwKSByZXR1cm4gZmFsc2U7XG4gIGlmICghaXNOb25FbXB0eVN0cmluZyh2Lm9jY3VycmVkQXQpIHx8ICFpc1JmYzMzMzkodi5vY2N1cnJlZEF0KSkgcmV0dXJuIGZhbHNlO1xuICBpZiAoIUVWRU5UX0tJTkRTLmluY2x1ZGVzKHYua2luZCBhcyBFdmVudEtpbmQpKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiBpc1JlY29yZCh2LnBheWxvYWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaXNEZXNrdG9wRXJyb3IodjogdW5rbm93bik6IHYgaXMgRGVza3RvcEVycm9yIHtcbiAgaWYgKCFpc1JlY29yZCh2KSkgcmV0dXJuIGZhbHNlO1xuICBpZiAoIUVSUk9SX0NPREVTLmluY2x1ZGVzKHYuY29kZSBhcyBuZXZlcikpIHJldHVybiBmYWxzZTtcbiAgaWYgKHR5cGVvZiB2Lm1lc3NhZ2UgIT09ICdzdHJpbmcnKSByZXR1cm4gZmFsc2U7XG4gIGlmICh0eXBlb2Ygdi5yZXRyeWFibGUgIT09ICdib29sZWFuJykgcmV0dXJuIGZhbHNlO1xuICBpZiAodi5zZXNzaW9uSWQgIT09IHVuZGVmaW5lZCAmJiAhaXNOb25FbXB0eVN0cmluZyh2LnNlc3Npb25JZCkpIHJldHVybiBmYWxzZTtcbiAgaWYgKHYucnVuSWQgIT09IHVuZGVmaW5lZCAmJiAhaXNOb25FbXB0eVN0cmluZyh2LnJ1bklkKSkgcmV0dXJuIGZhbHNlO1xuICBpZiAodi5yZWNvdmVyeUFjdGlvbiAhPT0gdW5kZWZpbmVkICYmICFSRUNPVkVSWV9BQ1RJT05TLmluY2x1ZGVzKHYucmVjb3ZlcnlBY3Rpb24gYXMgbmV2ZXIpKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiB0cnVlO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaXNSdW5TdGF0dXModjogdW5rbm93bik6IHYgaXMgUnVuU3RhdHVzIHtcbiAgcmV0dXJuIHR5cGVvZiB2ID09PSAnc3RyaW5nJyAmJiBSVU5fU1RBVFVTRVMuaW5jbHVkZXModiBhcyBSdW5TdGF0dXMpO1xufVxuXG4vKiogSG9zdCBcdTVGMTVcdTVCRkNcdTg4NEMoc3Rkb3V0IFx1N0IyQ1x1NEUwMFx1ODg0QylcdTMwMDIgKi9cbmV4cG9ydCBmdW5jdGlvbiBpc0hvc3RSZWFkeUxpbmUodjogdW5rbm93bik6IHYgaXMgeyBobWhEZXNrdG9wSG9zdFJlYWR5OiB0cnVlOyBwb3J0OiBudW1iZXI7IHZlcnNpb246IHN0cmluZyB9IHtcbiAgaWYgKCFpc1JlY29yZCh2KSkgcmV0dXJuIGZhbHNlO1xuICBpZiAodi5obWhEZXNrdG9wSG9zdFJlYWR5ICE9PSB0cnVlKSByZXR1cm4gZmFsc2U7XG4gIGlmICh0eXBlb2Ygdi5wb3J0ICE9PSAnbnVtYmVyJyB8fCAhTnVtYmVyLmlzSW50ZWdlcih2LnBvcnQpIHx8IHYucG9ydCA8PSAwIHx8IHYucG9ydCA+IDY1NTM1KSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiBpc05vbkVtcHR5U3RyaW5nKHYudmVyc2lvbik7XG59XG4iLCAiLyoqXG4gKiBEZXNrdG9wSG9zdENsaWVudCBcdTIwMTQgXHU1QkY5IGhtaCBob3N0IFx1NzY4NCBIVFRQK1NTRSBcdTVCQTJcdTYyMzdcdTdBRUZcdTMwMDJcbiAqXG4gKiAtIFx1NkJDRlx1NEUyQSBIVFRQIFx1OEJGN1x1NkM0Mlx1ODFFQVx1NTJBOFx1NUUyNiBYLUhtaC1LZXkodG9rZW4gXHU0RTBEXHU4RkRCIFVSTCk7XG4gKiAtIFx1N0VEM1x1Njc4NFx1NTMxNlx1OTUxOVx1OEJFRihyZXMuYm9keSBcdTkxQ0NcdTc2ODQgRGVza3RvcEVycm9yIFx1NUY2Mlx1NzJCNlx1NjIxNiBIVFRQIFx1NzJCNlx1NjAwMSlcdTg5QzRcdTdFQTZcdTYyMTBcdTVGMDJcdTVFMzhcdTYyOUJcdTUxRkE7XG4gKiAtIFNTRSBcdTc1MjggZmV0Y2ggXHU2RDQxXHU2MjRCXHU1MTk5XHU4OUUzXHU2NzkwKGlkL2V2ZW50L2RhdGEgXHU1RTI3KSxcdTY1MkZcdTYzMDEgTGFzdC1FdmVudC1JRCBcdTg4NjVcdTYyQzlcdTkxQ0RcdThGREVcdTMwMDJcbiAqL1xuaW1wb3J0IHsgZGVza3RvcEVycm9yLCBpc0Rlc2t0b3BFcnJvciwgaXNFdmVudEVudmVsb3BlLCB0eXBlIERlc2t0b3BFcnJvciwgdHlwZSBFdmVudEVudmVsb3BlIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3NlRnJhbWUge1xuICBpZD86IHN0cmluZztcbiAgZXZlbnQ6IHN0cmluZztcbiAgZGF0YTogc3RyaW5nO1xufVxuXG4vKiogXHU4OUUzXHU2NzkwXHU0RTAwXHU2QkI1IFNTRSBcdTY1ODdcdTY3MkNcdTRFM0FcdTVFMjcoXHU0RTBEXHU1NDJCXHU4REU4IGNodW5rIFx1NzY4NFx1N0YxM1x1NTFCMlx1OTAzQlx1OEY5MSxcdTdFQUZcdTUxRkRcdTY1NzBcdTRGQkZcdTRFOEVcdTZENEJcdThCRDUpXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VTc2VDaHVuayhjaHVuazogc3RyaW5nKTogU3NlRnJhbWVbXSB7XG4gIGNvbnN0IGZyYW1lczogU3NlRnJhbWVbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGJsb2NrIG9mIGNodW5rLnNwbGl0KC9cXG5cXG4vKSkge1xuICAgIGlmICghYmxvY2sudHJpbSgpKSBjb250aW51ZTtcbiAgICBsZXQgaWQ6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICBsZXQgZXZlbnQgPSAnbWVzc2FnZSc7XG4gICAgY29uc3QgZGF0YUxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGxldCBzYXdGaWVsZCA9IGZhbHNlO1xuICAgIGZvciAoY29uc3QgbGluZSBvZiBibG9jay5zcGxpdCgnXFxuJykpIHtcbiAgICAgIGlmIChsaW5lLnN0YXJ0c1dpdGgoJzonKSkgY29udGludWU7IC8vIFx1NkNFOFx1OTFDQS9cdTVGQzNcdThERjNcbiAgICAgIGlmIChsaW5lLnN0YXJ0c1dpdGgoJ2lkOicpKSB7IGlkID0gbGluZS5zbGljZSgzKS50cmltKCk7IHNhd0ZpZWxkID0gdHJ1ZTsgfVxuICAgICAgZWxzZSBpZiAobGluZS5zdGFydHNXaXRoKCdldmVudDonKSkgeyBldmVudCA9IGxpbmUuc2xpY2UoNikudHJpbSgpOyBzYXdGaWVsZCA9IHRydWU7IH1cbiAgICAgIGVsc2UgaWYgKGxpbmUuc3RhcnRzV2l0aCgnZGF0YTonKSkgeyBkYXRhTGluZXMucHVzaChsaW5lLnNsaWNlKDUpLnJlcGxhY2UoL14gLywgJycpKTsgc2F3RmllbGQgPSB0cnVlOyB9XG4gICAgfVxuICAgIGlmICghc2F3RmllbGQpIGNvbnRpbnVlOyAvLyBcdTdFQUZcdTZDRThcdTkxQ0EvXHU1RkMzXHU4REYzXHU1NzU3XHU0RTBEXHU0RUE3XHU3NTFGXHU1RTI3XG4gICAgZnJhbWVzLnB1c2goeyAuLi4oaWQgIT09IHVuZGVmaW5lZCA/IHsgaWQgfSA6IHt9KSwgZXZlbnQsIGRhdGE6IGRhdGFMaW5lcy5qb2luKCdcXG4nKSB9KTtcbiAgfVxuICByZXR1cm4gZnJhbWVzO1xufVxuXG4vKiogXHU0RUNFIFNTRSBcdTVFMjdcdTY1NzBcdTYzNkVcdTRFMkRcdTg5RTNcdTUxRkFcdTU0MDhcdTZDRDUgRXZlbnRFbnZlbG9wZTtcdTRFMERcdTU0MDhcdTZDRDVcdTc2ODRcdThGRDRcdTU2REUgbnVsbChTQ0hFTUFfTUlTTUFUQ0ggXHU3NTMxXHU4QzAzXHU3NTI4XHU2NUI5XHU4QkExXHU2NTcwKVx1MzAwMiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVudmVsb3BlRnJvbUZyYW1lKGZyYW1lOiBTc2VGcmFtZSk6IEV2ZW50RW52ZWxvcGUgfCBudWxsIHtcbiAgaWYgKGZyYW1lLmV2ZW50ICE9PSAnaG1oJykgcmV0dXJuIG51bGw7IC8vIFx1NjIxMVx1NEVFQ1x1NzY4NFx1NEU4Qlx1NEVGNlx1NEZFMVx1NUMwMVx1N0VERlx1NEUwMFx1OEQ3MCBldmVudDogaG1oXG4gIHRyeSB7XG4gICAgY29uc3QgcGFyc2VkOiB1bmtub3duID0gSlNPTi5wYXJzZShmcmFtZS5kYXRhKTtcbiAgICByZXR1cm4gaXNFdmVudEVudmVsb3BlKHBhcnNlZCkgPyBwYXJzZWQgOiBudWxsO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5leHBvcnQgY2xhc3MgRGVza3RvcEh0dHBFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IocHVibGljIHJlYWRvbmx5IGRldGFpbDogRGVza3RvcEVycm9yKSB7XG4gICAgc3VwZXIoZGV0YWlsLm1lc3NhZ2UpO1xuICB9XG59XG5cbmV4cG9ydCBjbGFzcyBEZXNrdG9wSG9zdENsaWVudCB7XG4gIGNvbnN0cnVjdG9yKFxuICAgIHByaXZhdGUgcmVhZG9ubHkgYmFzZVVybDogc3RyaW5nLFxuICAgIHByaXZhdGUgcmVhZG9ubHkgdG9rZW46IHN0cmluZyxcbiAgKSB7fVxuXG4gIHByaXZhdGUgaGVhZGVycyhleHRyYTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9KTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB7XG4gICAgcmV0dXJuIHsgJ3gtaG1oLWtleSc6IHRoaXMudG9rZW4sIC4uLmV4dHJhIH07XG4gIH1cblxuICBhc3luYyBnZXRKc29uPFQ+KHBhdGg6IHN0cmluZywgdGltZW91dE1zID0gNV8wMDApOiBQcm9taXNlPFQ+IHtcbiAgICBsZXQgcmVzOiBSZXNwb25zZTtcbiAgICB0cnkge1xuICAgICAgcmVzID0gYXdhaXQgZmV0Y2goYCR7dGhpcy5iYXNlVXJsfSR7cGF0aH1gLCB7IGhlYWRlcnM6IHRoaXMuaGVhZGVycygpLCBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQodGltZW91dE1zKSB9KTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgcmVxdWVzdCBmYWlsZWQ6ICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTYwKX1gLCB7IHJldHJ5YWJsZTogdHJ1ZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcbiAgICB9XG4gICAgcmV0dXJuIHRoaXMucGFyc2VSZXNwb25zZTxUPihyZXMpO1xuICB9XG5cbiAgLyoqIFx1NjJDOVx1NTNENlx1N0VBRlx1NjU4N1x1NjcyQ1x1N0FFRlx1NzBCOShcdTU5ODIgL2FwaS9zZXNzaW9ucy86aWQvZXhwb3J0Lm1kKVx1MzAwMiAqL1xuICBhc3luYyBnZXRUZXh0KHBhdGg6IHN0cmluZywgdGltZW91dE1zID0gMTBfMDAwKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgICBsZXQgcmVzOiBSZXNwb25zZTtcbiAgICB0cnkge1xuICAgICAgcmVzID0gYXdhaXQgZmV0Y2goYCR7dGhpcy5iYXNlVXJsfSR7cGF0aH1gLCB7IGhlYWRlcnM6IHRoaXMuaGVhZGVycygpLCBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQodGltZW91dE1zKSB9KTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgcmVxdWVzdCBmYWlsZWQ6ICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTYwKX1gLCB7IHJldHJ5YWJsZTogdHJ1ZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcbiAgICB9XG4gICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSB8fCByZXMuc3RhdHVzID09PSA0MDMpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignQVVUSF9GQUlMRUQnLCBgaG9zdCByZWplY3RlZCB0aGUgc2Vzc2lvbiB0b2tlbiAoSFRUUCAke3Jlcy5zdGF0dXN9KWAsIHsgcmV0cnlhYmxlOiBmYWxzZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcbiAgICB9XG4gICAgaWYgKCFyZXMub2spIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgSFRUUCAke3Jlcy5zdGF0dXN9YCwgeyByZXRyeWFibGU6IHJlcy5zdGF0dXMgPj0gNTAwIH0pKTtcbiAgICB9XG4gICAgcmV0dXJuIHJlcy50ZXh0KCk7XG4gIH1cblxuICBhc3luYyBwb3N0SnNvbjxUPihwYXRoOiBzdHJpbmcsIGJvZHk6IHVua25vd24sIHRpbWVvdXRNcyA9IDEwXzAwMCk6IFByb21pc2U8VD4ge1xuICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgIHRyeSB7XG4gICAgICByZXMgPSBhd2FpdCBmZXRjaChgJHt0aGlzLmJhc2VVcmx9JHtwYXRofWAsIHtcbiAgICAgICAgbWV0aG9kOiAnUE9TVCcsXG4gICAgICAgIGhlYWRlcnM6IHRoaXMuaGVhZGVycyh7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbicgfSksXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpLFxuICAgICAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQodGltZW91dE1zKSxcbiAgICAgIH0pO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGByZXF1ZXN0IGZhaWxlZDogJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxNjApfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy5wYXJzZVJlc3BvbnNlPFQ+KHJlcyk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHBhcnNlUmVzcG9uc2U8VD4ocmVzOiBSZXNwb25zZSk6IFByb21pc2U8VD4ge1xuICAgIGlmIChyZXMuc3RhdHVzID09PSA0MDEgfHwgcmVzLnN0YXR1cyA9PT0gNDAzKSB7XG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgYGhvc3QgcmVqZWN0ZWQgdGhlIHNlc3Npb24gdG9rZW4gKEhUVFAgJHtyZXMuc3RhdHVzfSlgLCB7IHJldHJ5YWJsZTogZmFsc2UsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XG4gICAgfVxuICAgIGNvbnN0IHRleHQgPSBhd2FpdCByZXMudGV4dCgpO1xuICAgIGxldCBwYXJzZWQ6IHVua25vd24gPSBudWxsO1xuICAgIHRyeSB7XG4gICAgICBwYXJzZWQgPSB0ZXh0ID8gSlNPTi5wYXJzZSh0ZXh0KSA6IG51bGw7XG4gICAgfSBjYXRjaCB7XG4gICAgICBwYXJzZWQgPSBudWxsO1xuICAgIH1cbiAgICBpZiAoIXJlcy5vaykge1xuICAgICAgaWYgKGlzRGVza3RvcEVycm9yKHBhcnNlZCkpIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKHBhcnNlZCk7XG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYEhUVFAgJHtyZXMuc3RhdHVzfTogJHt0ZXh0LnNsaWNlKDAsIDE2MCl9YCwgeyByZXRyeWFibGU6IHJlcy5zdGF0dXMgPj0gNTAwIH0pKTtcbiAgICB9XG4gICAgcmV0dXJuIHBhcnNlZCBhcyBUO1xuICB9XG5cbiAgLyoqXG4gICAqIFx1OEJBMlx1OTYwNVx1NTE2OFx1OTBFOCBTU0UgXHU1RTI3KFx1NTQyQlx1OTc1RVx1NEZFMVx1NUMwMVx1NEU4Qlx1NEVGNjpkZWx0YS9saW5lIFx1N0I0OVx1OUFEOFx1OTg5MVx1NkQ0MSlcdTMwMDJcdTRGRTFcdTVDMDFcdTc1MzFcdThDMDNcdTc1MjhcdTY1QjlcbiAgICogXHU3NTI4IGVudmVsb3BlRnJvbUZyYW1lIFx1ODFFQVx1ODg0Q1x1NTIwNlx1NkQ0MTtcdTY1QURcdTdFQkZcdTkxQ0RcdThGREVcdThCRURcdTRFNDlcdTU0MEMgZXZlbnRzKClcdTMwMDJcbiAgICovXG4gIGFzeW5jICpyYXdFdmVudHMobGFzdEV2ZW50SWQ/OiBzdHJpbmcsIHNpZ25hbD86IEFib3J0U2lnbmFsKTogQXN5bmNHZW5lcmF0b3I8U3NlRnJhbWU+IHtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgJHt0aGlzLmJhc2VVcmx9L2FwaS9ldmVudHNgLCB7XG4gICAgICBoZWFkZXJzOiB0aGlzLmhlYWRlcnMoe1xuICAgICAgICBhY2NlcHQ6ICd0ZXh0L2V2ZW50LXN0cmVhbScsXG4gICAgICAgIC4uLihsYXN0RXZlbnRJZCAhPT0gdW5kZWZpbmVkID8geyAnbGFzdC1ldmVudC1pZCc6IGxhc3RFdmVudElkIH0gOiB7fSksXG4gICAgICB9KSxcbiAgICAgIC4uLihzaWduYWwgIT09IHVuZGVmaW5lZCA/IHsgc2lnbmFsIH0gOiB7fSksXG4gICAgfSk7XG4gICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSB8fCByZXMuc3RhdHVzID09PSA0MDMpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignQVVUSF9GQUlMRUQnLCBgaG9zdCByZWplY3RlZCB0aGUgc2Vzc2lvbiB0b2tlbiAoSFRUUCAke3Jlcy5zdGF0dXN9KWAsIHsgcmV0cnlhYmxlOiBmYWxzZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcbiAgICB9XG4gICAgaWYgKCFyZXMub2sgfHwgcmVzLmJvZHkgPT09IG51bGwpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgU1NFIEhUVFAgJHtyZXMuc3RhdHVzfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICBjb25zdCByZWFkZXIgPSByZXMuYm9keS5nZXRSZWFkZXIoKTtcbiAgICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKCk7XG4gICAgbGV0IGJ1ZmZlciA9ICcnO1xuICAgIGZvciAoOzspIHtcbiAgICAgIGNvbnN0IHsgZG9uZSwgdmFsdWUgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICBpZiAoZG9uZSkgcmV0dXJuO1xuICAgICAgYnVmZmVyICs9IGRlY29kZXIuZGVjb2RlKHZhbHVlLCB7IHN0cmVhbTogdHJ1ZSB9KTtcbiAgICAgIGxldCBpZHg6IG51bWJlcjtcbiAgICAgIHdoaWxlICgoaWR4ID0gYnVmZmVyLmluZGV4T2YoJ1xcblxcbicpKSAhPT0gLTEpIHtcbiAgICAgICAgY29uc3QgYmxvY2sgPSBidWZmZXIuc2xpY2UoMCwgaWR4KTtcbiAgICAgICAgYnVmZmVyID0gYnVmZmVyLnNsaWNlKGlkeCArIDIpO1xuICAgICAgICBmb3IgKGNvbnN0IGZyYW1lIG9mIHBhcnNlU3NlQ2h1bmsoYmxvY2spKSB5aWVsZCBmcmFtZTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogXHU4QkEyXHU5NjA1IFNTRSBcdTRFOEJcdTRFRjZcdTZENDEoYXN5bmMgaXRlcmF0b3IpXHUzMDAyXHU2NUFEXHU3RUJGXHU3NTMxXHU4QzAzXHU3NTI4XHU2NUI5XHU5MUNEXHU4RkRFO1x1OTFDRFx1OEZERVx1NjVGNlx1NjI4QVx1NjcwMFx1NTQwRVxuICAgKiBcdTY1MzZcdTUyMzBcdTc2ODQgZXZlbnRJZCBcdTRGMjBcdTUxNjUgbGFzdEV2ZW50SWQsaG9zdCBcdTdBRUZcdTRFQ0VcdTkxQ0RcdTY1M0VcdTczQUZcdTg4NjVcdTUzRDFcdTMwMDJcbiAgICovXG4gIGFzeW5jICpldmVudHMobGFzdEV2ZW50SWQ/OiBzdHJpbmcsIHNpZ25hbD86IEFib3J0U2lnbmFsKTogQXN5bmNHZW5lcmF0b3I8RXZlbnRFbnZlbG9wZT4ge1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGAke3RoaXMuYmFzZVVybH0vYXBpL2V2ZW50c2AsIHtcbiAgICAgIGhlYWRlcnM6IHRoaXMuaGVhZGVycyh7XG4gICAgICAgIGFjY2VwdDogJ3RleHQvZXZlbnQtc3RyZWFtJyxcbiAgICAgICAgLi4uKGxhc3RFdmVudElkICE9PSB1bmRlZmluZWQgPyB7ICdsYXN0LWV2ZW50LWlkJzogbGFzdEV2ZW50SWQgfSA6IHt9KSxcbiAgICAgIH0pLFxuICAgICAgLi4uKHNpZ25hbCAhPT0gdW5kZWZpbmVkID8geyBzaWduYWwgfSA6IHt9KSxcbiAgICB9KTtcbiAgICBpZiAocmVzLnN0YXR1cyA9PT0gNDAxIHx8IHJlcy5zdGF0dXMgPT09IDQwMykge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdBVVRIX0ZBSUxFRCcsIGBob3N0IHJlamVjdGVkIHRoZSBzZXNzaW9uIHRva2VuIChIVFRQICR7cmVzLnN0YXR1c30pYCwgeyByZXRyeWFibGU6IGZhbHNlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICBpZiAoIXJlcy5vayB8fCAhcmVzLmJvZHkpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgU1NFIEhUVFAgJHtyZXMuc3RhdHVzfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICBjb25zdCByZWFkZXIgPSByZXMuYm9keS5nZXRSZWFkZXIoKTtcbiAgICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKCk7XG4gICAgbGV0IGJ1ZmZlciA9ICcnO1xuICAgIGZvciAoOzspIHtcbiAgICAgIGNvbnN0IHsgZG9uZSwgdmFsdWUgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICBpZiAoZG9uZSkgcmV0dXJuO1xuICAgICAgYnVmZmVyICs9IGRlY29kZXIuZGVjb2RlKHZhbHVlLCB7IHN0cmVhbTogdHJ1ZSB9KTtcbiAgICAgIC8vIFx1NEVFNVx1N0E3QVx1ODg0Q1x1NTIwNlx1NUUyNztcdTRGRERcdTc1NTlcdTRFMERcdTVCOENcdTY1NzRcdTc2ODRcdTVDM0VcdTkwRThcbiAgICAgIGxldCBpZHg6IG51bWJlcjtcbiAgICAgIHdoaWxlICgoaWR4ID0gYnVmZmVyLmluZGV4T2YoJ1xcblxcbicpKSAhPT0gLTEpIHtcbiAgICAgICAgY29uc3QgYmxvY2sgPSBidWZmZXIuc2xpY2UoMCwgaWR4KTtcbiAgICAgICAgYnVmZmVyID0gYnVmZmVyLnNsaWNlKGlkeCArIDIpO1xuICAgICAgICBmb3IgKGNvbnN0IGZyYW1lIG9mIHBhcnNlU3NlQ2h1bmsoYmxvY2spKSB7XG4gICAgICAgICAgY29uc3QgZW52ID0gZW52ZWxvcGVGcm9tRnJhbWUoZnJhbWUpO1xuICAgICAgICAgIGlmIChlbnYgIT09IG51bGwpIHlpZWxkIGVudjtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxufVxuIiwgIi8qKlxuICogZmFrZSBob3N0IFx1MjAxNCBobWhhcm5lc3MgcnVudGltZSBcdTc2ODRcdTZENEJcdThCRDVcdTY2RkZcdThFQUIoTWFzdGVyUHJvbXB0IFx1OTYzNlx1NkJCNSBEL0U6XG4gKiBcIlx1NTE0OFx1NEY3Rlx1NzUyOCBmYWtlIGhvc3QgXHU3RjE2XHU1MTk5XHU3MkI2XHU2MDAxXHU2NzNBXHU2RDRCXHU4QkQ1LFx1NTE4RFx1NjNBNVx1NzcxRlx1NUI5RSBBUElcIjtcdTk2MzZcdTZCQjUgRSBcdTc2ODRcdTRGMUFcdThCRERcdTdFQjVcdTUyMDdcdTcyNDdcbiAqIGUyZSBcdTRFNUZcdTUxNDhcdTU3MjggZmFrZSBcdTVDNDJcdTk1RURcdTczQUYpXHUzMDAyXG4gKlxuICogXHU2ODRDXHU5NzYyIGhvc3QgXHU1NDA4XHU1NDBDOlxuICogIC0gXHU1M0VBXHU3RUQxIDEyNy4wLjAuMSxcdTdBRUZcdTUzRTMgT1MgXHU1MjA2XHU5MTRELFx1NUI5RVx1OTY0NVx1N0FFRlx1NTNFM1x1NTE5OSBzdGRvdXQgXHU1RjE1XHU1QkZDXHU4ODRDO1xuICogIC0gXHU2MjQwXHU2NzA5IC9hcGkvKiBcdTg5ODFcdTZDNDIgWC1IbWgtS2V5ID09PSBITUhfREVTS1RPUF9UT0tFTixcdTU0MjZcdTUyMTkgNDAxICsgRGVza3RvcEVycm9yO1xuICogIC0gR0VUIC9hcGkvc3RhdGUgXHU1MDY1XHU1RUI3XHU2M0EyXHU2RDRCO0dFVCAvYXBpL2V2ZW50cyBTU0UoZXZlbnQ6IGhtaCBcdTRGRTFcdTVDMDFcdTZENDEgKyBcdTkxQ0RcdTY1M0VcdTczQUYpO1xuICogIC0gUE9TVCAvYXBpL2Rlc2t0b3Avc2h1dGRvd24gXHU0RjE4XHU5NkM1XHU5MDAwXHU1MUZBXHUzMDAyXG4gKlxuICogXHU5NjM2XHU2QkI1IEUgXHU2QTIxXHU2MkRGXHU5NzYyKFx1NEUwRSBobWhhcm5lc3MgZGVza3RvcCBcdTZBMjFcdTVGMEZcdTU0MENcdTVGNjIpOlxuICogIC0gUE9TVCAvYXBpL3Rhc2sge3RleHQsIHNlc3Npb25JZCwgbW9kZX06XHU2MzkyXHU5NjFGXHU1RTc2XHU2MzA5XHU4MTFBXHU2NzJDXHU1M0QxXG4gKiAgICBydW4uc3RhcnRlZCBcdTIxOTIgdG9vbC5zdGFydGVkL2NvbXBsZXRlZCBcdTIxOTIobW9kZT09PSdhc2snIFx1NjVGNilcbiAqICAgIGFwcHJvdmFsLnJlcXVpcmVkKFx1N0I0OSAvYXBpL2FwcHJvdmUpXHUyMTkyIHJ1bi5jb21wbGV0ZWQ7XG4gKiAgLSBQT1NUIC9hcGkvYXBwcm92ZSB7Z3JhbnRlZCwgc2Vzc2lvbklkfTtcbiAqICAtIFBPU1QgL2FwaS9pbnRlcnJ1cHQge3Nlc3Npb25JZH07XG4gKiAgLSBHRVQgL2FwaS9zZXNzaW9uc1x1MzAwMlxuICpcbiAqIFx1NkQ0Qlx1OEJENVx1OTRBOVx1NUI1MDpGQUtFX0hPU1RfRElFX0FGVEVSX01TIC8gRkFLRV9IT1NUX0RJRV9BVF9CT09UIC9cbiAqIEZBS0VfSE9TVF9FWFBFQ1RfVE9LRU4gLyBGQUtFX0hPU1RfVEFTS19ERUxBWV9NUyAvIEZBS0VfSE9TVF9UQVNLX0ZBSUw9MVxuICogKFx1NEVGQlx1NTJBMVx1NEVFNSBydW4uZmFpbGVkIFx1N0VEM1x1Njc1RixcdTY3ODRcdTkwMjBcdTk1MTlcdThCRUZcdTYwNjJcdTU5MERcdTU3M0FcdTY2NkYpXHUzMDAyXG4gKi9cbmltcG9ydCB7IGNyZWF0ZVNlcnZlciwgdHlwZSBTZXJ2ZXJSZXNwb25zZSB9IGZyb20gJ25vZGU6aHR0cCc7XG5pbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSAnbm9kZTpjcnlwdG8nO1xuaW1wb3J0IHsgcGF0aFRvRmlsZVVSTCB9IGZyb20gJ25vZGU6dXJsJztcbmltcG9ydCB7IHJlYWxwYXRoU3luYyB9IGZyb20gJ25vZGU6ZnMnO1xuaW1wb3J0IHsgRVZFTlRfU0NIRU1BX1ZFUlNJT04sIGRlc2t0b3BFcnJvciwgdHlwZSBFdmVudEVudmVsb3BlLCB0eXBlIEV2ZW50S2luZCB9IGZyb20gJ0BobWgtZGVza3RvcC9jb250cmFjdHMnO1xuXG5leHBvcnQgaW50ZXJmYWNlIEZha2VIb3N0SGFuZGxlIHtcbiAgcG9ydDogbnVtYmVyO1xuICBlbWl0KHNlc3Npb25JZDogc3RyaW5nLCBydW5JZDogc3RyaW5nLCBraW5kOiBFdmVudEtpbmQsIHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogbnVtYmVyO1xuICBjbG9zZSgpOiBQcm9taXNlPHZvaWQ+O1xufVxuXG5pbnRlcmZhY2UgRmFrZVNlc3Npb24ge1xuICBpZDogc3RyaW5nO1xuICBjcmVhdGVkQXQ6IHN0cmluZztcbiAgdXBkYXRlZEF0OiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBQZW5kaW5nQXBwcm92YWwge1xuICBzZXNzaW9uSWQ6IHN0cmluZztcbiAgYXBwcm92YWxJZDogc3RyaW5nO1xuICByZXNvbHZlKGdyYW50ZWQ6IGJvb2xlYW4pOiB2b2lkO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc3RhcnRGYWtlSG9zdChvcHRzOiB7IHRva2VuOiBzdHJpbmc7IHF1aWV0PzogYm9vbGVhbiB9KTogUHJvbWlzZTxGYWtlSG9zdEhhbmRsZT4ge1xuICBjb25zdCB0b2tlbiA9IG9wdHMudG9rZW47XG4gIC8vIFx1NkQ0Qlx1OEJENVx1OTRBOVx1NUI1MDpGQUtFX0hPU1RfRVhQRUNUX1RPS0VOIFx1OEJBOSBob3N0IFx1NjgyMVx1OUE4Q1x1NEUwMFx1NEUyQVx1NEUwRSBITUhfREVTS1RPUF9UT0tFTlxuICAvLyBcdTRFMERcdTU0MENcdTc2ODRcdTUwM0MoXHU2Nzg0XHU5MDIwIEFVVEhfRkFJTEVEIFx1NTczQVx1NjY2RjtzdXBlcnZpc29yIFx1NjAzQlx1NjYyRlx1ODk4Nlx1NzZENiBITUhfREVTS1RPUF9UT0tFTilcbiAgY29uc3QgZXhwZWN0ZWQgPSBwcm9jZXNzLmVudi5GQUtFX0hPU1RfRVhQRUNUX1RPS0VOID8/IHRva2VuO1xuICBjb25zdCB0YXNrRGVsYXkgPSBOdW1iZXIocHJvY2Vzcy5lbnYuRkFLRV9IT1NUX1RBU0tfREVMQVlfTVMgPz8gMzApO1xuICBjb25zdCBmYWlsVGFza3MgPSBwcm9jZXNzLmVudi5GQUtFX0hPU1RfVEFTS19GQUlMID09PSAnMSc7XG5cbiAgY29uc3Qgc3NlQ2xpZW50cyA9IG5ldyBTZXQ8U2VydmVyUmVzcG9uc2U+KCk7XG4gIGNvbnN0IHNlcUJ5UnVuID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgLy8gXHU5MUNEXHU2NTNFXHU3M0FGOlx1NjcwMFx1OEZEMSAyMDAgXHU1RTI3KExhc3QtRXZlbnQtSUQgXHU2NUFEXHU3RUJGXHU4ODY1XHU2MkM5KSxcdTRFMEUgaG1oYXJuZXNzIHdlYiBcdTU0MENcdTZCM0VcdThCRURcdTRFNDlcbiAgY29uc3QgcmluZzogQXJyYXk8eyBpZDogbnVtYmVyOyBldmVudDogc3RyaW5nOyBkYXRhOiB1bmtub3duIH0+ID0gW107XG4gIGxldCByaW5nU2VxID0gMDtcbiAgY29uc3Qgc2Vzc2lvbnMgPSBuZXcgTWFwPHN0cmluZywgRmFrZVNlc3Npb24+KCk7XG4gIGxldCBwZW5kaW5nOiBQZW5kaW5nQXBwcm92YWwgfCBudWxsID0gbnVsbDtcbiAgY29uc3QgcnVuVGltZXJzID0gbmV3IE1hcDxzdHJpbmcsIE5vZGVKUy5UaW1lb3V0PigpO1xuXG4gIGNvbnN0IGVtaXQgPSAoc2Vzc2lvbklkOiBzdHJpbmcsIHJ1bklkOiBzdHJpbmcsIGtpbmQ6IEV2ZW50S2luZCwgcGF5bG9hZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBudW1iZXIgPT4ge1xuICAgIGNvbnN0IGtleSA9IGAke3Nlc3Npb25JZH1cXDAke3J1bklkfWA7XG4gICAgY29uc3Qgc2VxID0gKHNlcUJ5UnVuLmdldChrZXkpID8/IDApICsgMTtcbiAgICBzZXFCeVJ1bi5zZXQoa2V5LCBzZXEpO1xuICAgIGNvbnN0IGVudjogRXZlbnRFbnZlbG9wZSA9IHtcbiAgICAgIHNjaGVtYVZlcnNpb246IEVWRU5UX1NDSEVNQV9WRVJTSU9OLFxuICAgICAgZXZlbnRJZDogcmFuZG9tVVVJRCgpLFxuICAgICAgc2Vzc2lvbklkLFxuICAgICAgcnVuSWQsXG4gICAgICBzZXEsXG4gICAgICBvY2N1cnJlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICBraW5kLFxuICAgICAgcGF5bG9hZCxcbiAgICB9O1xuICAgIGNvbnN0IGlkID0gKytyaW5nU2VxO1xuICAgIHJpbmcucHVzaCh7IGlkLCBldmVudDogJ2htaCcsIGRhdGE6IGVudiB9KTtcbiAgICBpZiAocmluZy5sZW5ndGggPiAyMDApIHJpbmcuc3BsaWNlKDAsIHJpbmcubGVuZ3RoIC0gMjAwKTtcbiAgICBmb3IgKGNvbnN0IGMgb2Ygc3NlQ2xpZW50cykge1xuICAgICAgYy53cml0ZShgaWQ6ICR7aWR9XFxuZXZlbnQ6IGhtaFxcbmRhdGE6ICR7SlNPTi5zdHJpbmdpZnkoZW52KX1cXG5cXG5gKTtcbiAgICB9XG4gICAgcmV0dXJuIHNlcTtcbiAgfTtcblxuICBjb25zdCB0b3VjaCA9IChzZXNzaW9uSWQ6IHN0cmluZyk6IEZha2VTZXNzaW9uID0+IHtcbiAgICBsZXQgcyA9IHNlc3Npb25zLmdldChzZXNzaW9uSWQpO1xuICAgIGlmIChzID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHMgPSB7IGlkOiBzZXNzaW9uSWQsIGNyZWF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLCB1cGRhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSB9O1xuICAgICAgc2Vzc2lvbnMuc2V0KHNlc3Npb25JZCwgcyk7XG4gICAgfVxuICAgIHMudXBkYXRlZEF0ID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuICAgIHJldHVybiBzO1xuICB9O1xuXG4gIC8qKiBcdTZBMjFcdTYyREZcdTRFMDBcdTZCMjFcdTRFRkJcdTUyQTE6XHU2Mjc5XHU1MUM2XHU2QTIxXHU1RjBGXHU2MzAyXHU4RDc3XHU3QjQ5XHU1Rjg1IC9hcGkvYXBwcm92ZVx1MzAwMiAqL1xuICBjb25zdCBydW5UYXNrID0gKHNlc3Npb25JZDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcsIG1vZGU6IHN0cmluZyk6IHN0cmluZyA9PiB7XG4gICAgY29uc3QgcnVuSWQgPSBgcnVuLSR7RGF0ZS5ub3coKS50b1N0cmluZygzNil9LSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMiwgOCl9YDtcbiAgICB0b3VjaChzZXNzaW9uSWQpO1xuICAgIGNvbnN0IHN0ZXBzOiBBcnJheTwoKSA9PiB2b2lkPiA9IFtdO1xuICAgIGNvbnN0IHdhaXQgPSAoZm46ICgpID0+IHZvaWQsIG1zID0gdGFza0RlbGF5KTogdm9pZCA9PiB7XG4gICAgICBjb25zdCB0ID0gc2V0VGltZW91dChmbiwgbXMpO1xuICAgICAgcnVuVGltZXJzLnNldChgJHtzZXNzaW9uSWR9XFwwJHtydW5JZH1gLCB0KTtcbiAgICB9O1xuICAgIGNvbnN0IGNoYWluID0gKGZuczogQXJyYXk8KCkgPT4gdm9pZD4pOiB2b2lkID0+IHtcbiAgICAgIGNvbnN0IFtmaXJzdCwgLi4ucmVzdF0gPSBmbnM7XG4gICAgICBpZiAoZmlyc3QgPT09IHVuZGVmaW5lZCkgcmV0dXJuO1xuICAgICAgd2FpdCgoKSA9PiB7XG4gICAgICAgIGZpcnN0KCk7XG4gICAgICAgIGNoYWluKHJlc3QpO1xuICAgICAgfSk7XG4gICAgfTtcblxuICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ3J1bi5zdGFydGVkJywgeyB0YXNrOiB0ZXh0LCBtb2RlIH0pO1xuICAgIGlmIChmYWlsVGFza3MpIHtcbiAgICAgIHdhaXQoKCkgPT4gZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAncnVuLmZhaWxlZCcsIHtcbiAgICAgICAgZXJyb3I6IHsgY29kZTogJ0FVVEhfRkFJTEVEJywgbWVzc2FnZTogJ3NpbXVsYXRlZCBwcm92aWRlciBhdXRoIGZhaWx1cmUnLCByZXRyeWFibGU6IGZhbHNlIH0sXG4gICAgICB9KSk7XG4gICAgICByZXR1cm4gcnVuSWQ7XG4gICAgfVxuXG4gICAgY29uc3QgZmluaXNoUnVuID0gKGFuc3dlcjogc3RyaW5nLCB0b29sVXNlczogbnVtYmVyKTogdm9pZCA9PiB7XG4gICAgICBydW5UaW1lcnMuZGVsZXRlKGAke3Nlc3Npb25JZH1cXDAke3J1bklkfWApO1xuICAgICAgLy8gXHU0RUE0XHU0RUQ4XHU3MjY5XHU1MTQ4XHU0RThFXHU3RUM4XHU2MDAxKFx1NEUwRSBobWhhcm5lc3MgZGVza3RvcCBcdTY4NjVcdTU0MENcdTVFOEY6YXJ0aWZhY3QuY3JlYXRlZCBcdTIxOTIgcnVuLmNvbXBsZXRlZClcbiAgICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ2FydGlmYWN0LmNyZWF0ZWQnLCB7XG4gICAgICAgIGFydGlmYWN0OiB7IHJlbFBhdGg6ICdvdXQudHh0Jywga2luZDogJ2ZpbGUnLCB0aXRsZTogJ291dC50eHQnIH0sXG4gICAgICB9KTtcbiAgICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ3J1bi5jb21wbGV0ZWQnLCB7IHRleHQ6IGFuc3dlciwgdHVybnM6IDEsIHRvb2xVc2VzIH0pO1xuICAgIH07XG5cbiAgICBjb25zdCBzY3JpcHRlZDogQXJyYXk8KCkgPT4gdm9pZD4gPSBbXG4gICAgICAoKSA9PiBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICd0b29sLnN0YXJ0ZWQnLCB7IG5hbWU6ICdyZWFkX2ZpbGUnLCBhcmdzUHJldmlldzogJ3tcInBhdGhcIjpcIlJFQURNRS5tZFwifScgfSksXG4gICAgICAoKSA9PiBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICd0b29sLmNvbXBsZXRlZCcsIHsgbmFtZTogJ3JlYWRfZmlsZScsIGlzRXJyb3I6IGZhbHNlLCBvdXRwdXRQcmV2aWV3OiAnIyBkZW1vJyB9KSxcbiAgICBdO1xuXG4gICAgaWYgKG1vZGUgPT09ICdhc2snKSB7XG4gICAgICBzY3JpcHRlZC5wdXNoKCgpID0+IHtcbiAgICAgICAgY29uc3QgYXBwcm92YWxJZCA9IGBhcC0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDgpfWA7XG4gICAgICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ2FwcHJvdmFsLnJlcXVpcmVkJywge1xuICAgICAgICAgIGFwcHJvdmFsSWQsXG4gICAgICAgICAgdG9vbDogJ3dyaXRlX2ZpbGUnLFxuICAgICAgICAgIGFyZ3NQcmV2aWV3OiAne1wicGF0aFwiOlwib3V0LnR4dFwiLFwiY29udGVudFwiOlwiaGlcIn0nLFxuICAgICAgICAgIHJpc2s6ICdcdTUxOTlcdTUxNjVcdTVERTVcdTRGNUNcdTUzM0FcdTY1ODdcdTRFRjYgb3V0LnR4dChcdTZBMjFcdTYyREYpJyxcbiAgICAgICAgfSk7XG4gICAgICAgIHBlbmRpbmcgPSB7XG4gICAgICAgICAgc2Vzc2lvbklkLFxuICAgICAgICAgIGFwcHJvdmFsSWQsXG4gICAgICAgICAgcmVzb2x2ZTogKGdyYW50ZWQpID0+IHtcbiAgICAgICAgICAgIHBlbmRpbmcgPSBudWxsO1xuICAgICAgICAgICAgaWYgKGdyYW50ZWQpIHtcbiAgICAgICAgICAgICAgZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAndG9vbC5zdGFydGVkJywgeyBuYW1lOiAnd3JpdGVfZmlsZScsIGFyZ3NQcmV2aWV3OiAne1wicGF0aFwiOlwib3V0LnR4dFwifScgfSk7XG4gICAgICAgICAgICAgIHdhaXQoKCkgPT4gZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAndG9vbC5jb21wbGV0ZWQnLCB7IG5hbWU6ICd3cml0ZV9maWxlJywgaXNFcnJvcjogZmFsc2UsIG91dHB1dFByZXZpZXc6ICd3cm90ZSAyIGJ5dGVzJyB9KSk7XG4gICAgICAgICAgICAgIHdhaXQoKCkgPT4gZmluaXNoUnVuKGBlY2hvOiAke3RleHR9KFx1NURGMlx1NjI2N1x1ODg0Q1x1NTE5OVx1NTE2NSlgLCAzKSwgdGFza0RlbGF5ICogMik7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICBmaW5pc2hSdW4oYGVjaG86ICR7dGV4dH0oXHU1QkExXHU2Mjc5XHU4OEFCXHU2MkQyXHU3RURELFx1NjcyQVx1NjI2N1x1ODg0Q1x1NTE5OVx1NTE2NSlgLCAxKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9LFxuICAgICAgICB9O1xuICAgICAgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHNjcmlwdGVkLnB1c2goKCkgPT4gZmluaXNoUnVuKGBlY2hvOiAke3RleHR9YCwgMSkpO1xuICAgIH1cbiAgICBjaGFpbihzY3JpcHRlZCk7XG4gICAgcmV0dXJuIHJ1bklkO1xuICB9O1xuXG4gIGNvbnN0IHNlcnZlciA9IGNyZWF0ZVNlcnZlcigocmVxLCByZXMpID0+IHtcbiAgICBjb25zdCB1cmwgPSBuZXcgVVJMKHJlcS51cmwgPz8gJy8nLCAnaHR0cDovLzEyNy4wLjAuMScpO1xuICAgIGNvbnN0IGF1dGhvcml6ZWQgPSByZXEuaGVhZGVyc1sneC1obWgta2V5J10gPT09IGV4cGVjdGVkO1xuICAgIGNvbnN0IGRlbnkgPSAoKTogdm9pZCA9PiB7XG4gICAgICByZXMud3JpdGVIZWFkKDQwMSwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgJ21pc3Npbmcgb3IgaW52YWxpZCB4LWhtaC1rZXknLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICB9O1xuXG4gICAgY29uc3QgcmVhZEJvZHkgPSAoKTogUHJvbWlzZTxzdHJpbmc+ID0+XG4gICAgICBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xuICAgICAgICBsZXQgYiA9ICcnO1xuICAgICAgICByZXEub24oJ2RhdGEnLCAoYzogQnVmZmVyKSA9PiB7IGIgKz0gYy50b1N0cmluZygpOyB9KTtcbiAgICAgICAgcmVxLm9uKCdlbmQnLCAoKSA9PiByZXNvbHZlKGIpKTtcbiAgICAgIH0pO1xuXG4gICAgaWYgKHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZXZlbnRzJykge1xuICAgICAgaWYgKCFhdXRob3JpemVkKSB7IGRlbnkoKTsgcmV0dXJuOyB9XG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ3RleHQvZXZlbnQtc3RyZWFtJywgJ2NhY2hlLWNvbnRyb2wnOiAnbm8tY2FjaGUnLCBjb25uZWN0aW9uOiAna2VlcC1hbGl2ZScgfSk7XG4gICAgICByZXMuZmx1c2hIZWFkZXJzPy4oKTtcbiAgICAgIHNzZUNsaWVudHMuYWRkKHJlcyk7XG4gICAgICAvLyBcdTY1QURcdTdFQkZcdTg4NjVcdTYyQzk6TGFzdC1FdmVudC1JRCBcdTRFNEJcdTUyNERcdTc2ODRcdTVFMjdcdTVERjJcdTU3MjhcdTVCQTJcdTYyMzdcdTdBRUYsXHU5MUNEXHU1M0QxXHU1MTc2XHU1NDBFXHU3Njg0XHU3M0FGXHU1RjYyXHU3RjEzXHU1MUIyXG4gICAgICBjb25zdCBsYXN0SWQgPSBOdW1iZXIocmVxLmhlYWRlcnNbJ2xhc3QtZXZlbnQtaWQnXSA/PyAwKTtcbiAgICAgIGlmIChOdW1iZXIuaXNGaW5pdGUobGFzdElkKSAmJiBsYXN0SWQgPiAwKSB7XG4gICAgICAgIGZvciAoY29uc3QgZSBvZiByaW5nKSB7XG4gICAgICAgICAgaWYgKGUuaWQgPiBsYXN0SWQpIHJlcy53cml0ZShgaWQ6ICR7ZS5pZH1cXG5ldmVudDogJHtlLmV2ZW50fVxcbmRhdGE6ICR7SlNPTi5zdHJpbmdpZnkoZS5kYXRhKX1cXG5cXG5gKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmVxLm9uKCdjbG9zZScsICgpID0+IHNzZUNsaWVudHMuZGVsZXRlKHJlcykpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAoIWF1dGhvcml6ZWQpIHsgZGVueSgpOyByZXR1cm47IH1cblxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3N0YXRlJykge1xuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBkYWVtb25WZXJzaW9uOiAnZmFrZS0wLjAuMCcsIGRlc2t0b3A6IHRydWUsIG1vZGVsOiAnZmFrZS1tb2RlbCcsIGxvY2FsZTogJ3poJyxcbiAgICAgICAgYnVzeVNlc3Npb25zOiBbLi4uc2Vzc2lvbnMua2V5cygpXS5zbGljZSgwLCAyKSxcbiAgICAgICAgYXBwcm92YWxQZW5kaW5nOiBwZW5kaW5nICE9PSBudWxsLFxuICAgICAgfSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZGVza3RvcC9zaHV0ZG93bicpIHtcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUgfSkpO1xuICAgICAgc2VydmVyLmNsb3NlKCgpID0+IHByb2Nlc3MuZXhpdCgwKSk7XG4gICAgICBzZXRUaW1lb3V0KCgpID0+IHByb2Nlc3MuZXhpdCgwKSwgMV8wMDApLnVucmVmKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9mYWtlL2RpZScpIHtcbiAgICAgIC8vIFx1NkQ0Qlx1OEJENVx1OTRBOVx1NUI1MDpcdTZBMjFcdTYyREYgaG9zdCBcdTVEMjlcdTZFODMoXHU1MTQ4XHU1RTk0XHU3QjU0XHU1MThEXHU5MDAwXHU1MUZBLFx1NEZERFx1OEJDMVx1NTRDRFx1NUU5NFx1NURGMlx1NTNEMVx1NTFGQSlcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUgfSkpO1xuICAgICAgc2V0VGltZW91dCgoKSA9PiBwcm9jZXNzLmV4aXQoMSksIDUwKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3Rhc2snKSB7XG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoKGF3YWl0IHJlYWRCb2R5KCkpIHx8ICd7fScpIGFzIHsgdGV4dD86IHVua25vd247IHNlc3Npb25JZD86IHVua25vd247IG1vZGU/OiB1bmtub3duIH07XG4gICAgICAgICAgY29uc3QgdGV4dCA9IHR5cGVvZiBib2R5LnRleHQgPT09ICdzdHJpbmcnID8gYm9keS50ZXh0IDogJyc7XG4gICAgICAgICAgY29uc3Qgc2Vzc2lvbklkID0gdHlwZW9mIGJvZHkuc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IGJvZHkuc2Vzc2lvbklkIDogYHdlYi0ke0RhdGUubm93KCkudG9TdHJpbmcoMzYpfWA7XG4gICAgICAgICAgY29uc3QgbW9kZSA9IGJvZHkubW9kZSA9PT0gJ2FzaycgfHwgYm9keS5tb2RlID09PSAnYXV0bycgfHwgYm9keS5tb2RlID09PSAneW9sbycgPyBib2R5Lm1vZGUgOiAnYXNrJztcbiAgICAgICAgICBpZiAoIXRleHQpIHtcbiAgICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3RleHQgcmVxdWlyZWQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgICAgY29uc3QgcnVuSWQgPSBydW5UYXNrKHNlc3Npb25JZCwgdGV4dCwgbW9kZSk7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIHJ1bklkIH0pKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgU3RyaW5nKGVycikuc2xpY2UoMCwgMTIwKSwgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgIH1cbiAgICAgIH0pKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9hcHByb3ZlJykge1xuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgoYXdhaXQgcmVhZEJvZHkoKSkgfHwgJ3t9JykgYXMgeyBncmFudGVkPzogdW5rbm93bjsgc2Vzc2lvbklkPzogdW5rbm93biB9O1xuICAgICAgICBjb25zdCBzaWQgPSB0eXBlb2YgYm9keS5zZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gYm9keS5zZXNzaW9uSWQgOiAnJztcbiAgICAgICAgaWYgKHBlbmRpbmcgPT09IG51bGwgfHwgKHNpZCAhPT0gJycgJiYgcGVuZGluZy5zZXNzaW9uSWQgIT09IHNpZCkpIHtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnbm8gYXBwcm92YWwgcGVuZGluZycsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBwID0gcGVuZGluZztcbiAgICAgICAgcGVuZGluZyA9IG51bGw7XG4gICAgICAgIHAucmVzb2x2ZShib2R5LmdyYW50ZWQgPT09IHRydWUpO1xuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIGdyYW50ZWQ6IGJvZHkuZ3JhbnRlZCA9PT0gdHJ1ZSB9KSk7XG4gICAgICB9KSgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvaW5qZWN0Jykge1xuICAgICAgLy8gXHU4RkQwXHU4ODRDXHU0RTJEXHU2Q0U4XHU1MTY1KFx1NEUwRSBobWhhcm5lc3MgL2FwaS9pbmplY3QgXHU1NDBDXHU1RjYyO2Zha2UgXHU1M0VBXHU1NkRFXHU2MjY3KVxuICAgICAgdm9pZCByZWFkQm9keSgpO1xuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9pbnRlcnJ1cHQnKSB7XG4gICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgnJykgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47IC8vIGludGVycnVwdCBcdTY1RTAgYm9keSBcdThCRURcdTRFNDlcbiAgICAgIHZvaWQgYm9keTtcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUgfSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9zZXNzaW9ucycpIHtcbiAgICAgIGNvbnN0IGxpc3QgPSBbLi4uc2Vzc2lvbnMudmFsdWVzKCldLm1hcCgocykgPT4gKHtcbiAgICAgICAgaWQ6IHMuaWQsIHRpdGxlOiAnJywgdGFzazogJycsIG91dGNvbWU6ICdvaycsIHR1cm5zOiAxLCB0b29sVXNlczogMSxcbiAgICAgICAgdGltZTogcy51cGRhdGVkQXQsIGN3ZDogJ0M6XFxcXGRlbW8nLCBicmFuY2g6ICcnLCBjcmVhdGVkQXQ6IHMuY3JlYXRlZEF0LCB1cGRhdGVkQXQ6IHMudXBkYXRlZEF0LFxuICAgICAgfSkpO1xuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBzZXNzaW9uczogbGlzdCwgbmV4dEN1cnNvcjogbnVsbCB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUuc3RhcnRzV2l0aCgnL2FwaS9zZXNzaW9ucy8nKSkge1xuICAgICAgY29uc3Qgc2VnID0gZGVjb2RlVVJJQ29tcG9uZW50KHVybC5wYXRobmFtZS5zbGljZSgnL2FwaS9zZXNzaW9ucy8nLmxlbmd0aCkpO1xuICAgICAgLy8gXHU1QkZDXHU1MUZBKFx1NEUwRSBobWhhcm5lc3MgL2FwaS9zZXNzaW9ucy86aWQvZXhwb3J0Lm1kIFx1NTQwQ1x1NUY2Mjp0ZXh0L21hcmtkb3duIFx1NEUwQlx1OEY3RClcbiAgICAgIGNvbnN0IGV4cG9ydE1hdGNoID0gL14oLiopXFwvZXhwb3J0XFwubWQkLy5leGVjKHNlZykgPz8gL14oLiopXFwuZXhwb3J0XFwubWQkLy5leGVjKHNlZyk7XG4gICAgICBpZiAoZXhwb3J0TWF0Y2ggIT09IG51bGwgJiYgZXhwb3J0TWF0Y2hbMV0gIT09IHVuZGVmaW5lZCAmJiBleHBvcnRNYXRjaFsxXSAhPT0gJycpIHtcbiAgICAgICAgY29uc3QgZWlkID0gZXhwb3J0TWF0Y2hbMV0ucmVwbGFjZSgvW15hLXpBLVowLTlfOi5ALV0vZywgJycpO1xuICAgICAgICBjb25zdCBlcyA9IHNlc3Npb25zLmdldChlaWQpO1xuICAgICAgICBpZiAoZXMgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICdzZXNzaW9uIG5vdCBmb3VuZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ3RleHQvbWFya2Rvd247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICByZXMuZW5kKGAjIGhtaGFybmVzcyBcdTRGMUFcdThCRERcdTVCRkNcdTUxRkEoZmFrZSlcXG5cXG4tIFx1NEYxQVx1OEJERDoke2VpZH1cXG5cXG4jIyBcdTc1MjhcdTYyMzdcXG5cXG5cdTRFNEJcdTUyNERcdTc2ODRcdTRFRkJcdTUyQTEoZmFrZSBcdTk4ODRcdTg5QzgpXFxuXFxuIyMgXHU1MkE5XHU2MjRCXFxuXFxuXHU4RkQ5XHU2NjJGXHU1QkZDXHU1MUZBXHU3Njg0XHU1NkRFXHU1OTBEXHU5ODg0XHU4OUM4KGZha2UpXHUzMDAyXFxuYCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIC8vIFx1NEYxQVx1OEJERFx1OTg4NFx1ODlDOChcdTRFMEUgaG1oYXJuZXNzIEdFVCAvYXBpL3Nlc3Npb25zLzppZCBcdTU0MENcdTVGNjI6XHU2NzAwXHU1NDBFIDgwIFx1Njc2MSxcdTZCQ0ZcdTY3NjEgNTAwIFx1NUI1NylcbiAgICAgIGNvbnN0IGlkID0gc2VnLnJlcGxhY2UoL1teYS16QS1aMC05XzouQC1dL2csICcnKTtcbiAgICAgIGNvbnN0IHMgPSBzZXNzaW9ucy5nZXQoaWQpO1xuICAgICAgaWYgKHMgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3Nlc3Npb24gbm90IGZvdW5kJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgaWQsIG1vZGVsOiAnZmFrZS1tb2RlbCcsIGN3ZDogJ0M6XFxcXGRlbW8nLFxuICAgICAgICBtZXNzYWdlczogW1xuICAgICAgICAgIHsgcm9sZTogJ3VzZXInLCB0ZXh0OiAnXHU0RTRCXHU1MjREXHU3Njg0XHU0RUZCXHU1MkExKGZha2UgXHU5ODg0XHU4OUM4KScsIHRvb2xzOiBbXSB9LFxuICAgICAgICAgIHsgcm9sZTogJ2Fzc2lzdGFudCcsIHRleHQ6ICdcdThGRDlcdTY2MkZcdTUzODZcdTUzRjJcdTRGMUFcdThCRERcdTc2ODRcdTU2REVcdTU5MERcdTk4ODRcdTg5QzgoZmFrZSlcdTMwMDInLCB0b29sczogWydyZWFkX2ZpbGUnXSB9LFxuICAgICAgICBdLFxuICAgICAgfSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9mcycpIHtcbiAgICAgIC8vIFx1NzZFRVx1NUY1NVx1NkQ0Rlx1ODlDOChcdTRFMEUgaG1oYXJuZXNzIFx1NTQwQ1x1NUY2MjpwYXRoIFx1NzcwMVx1NzU2NT1cdTY4Mzk7ZmlsZXM9MSBcdTk2NDRcdTVFMjZcdTY1ODdcdTRFRjZcdTUyMTdcdTg4NjgpXG4gICAgICBjb25zdCBxID0gdXJsLnNlYXJjaFBhcmFtcy5nZXQoJ3BhdGgnKSA/PyAnJztcbiAgICAgIGNvbnN0IHdpdGhGaWxlcyA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KCdmaWxlcycpID09PSAnMSc7XG4gICAgICBpZiAocSA9PT0gJycpIHtcbiAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgcGF0aDogJycsIHNlZ21lbnRzOiBbXSwgcGFyZW50OiAnJyxcbiAgICAgICAgICBkaXJzOiBbeyBuYW1lOiAnZGVtby13b3Jrc3BhY2UnLCBwYXRoOiAnQzpcXFxcZGVtbycgfV0sXG4gICAgICAgICAgLi4uKHdpdGhGaWxlcyA/IHsgZmlsZXM6IFtdIH0gOiB7fSksXG4gICAgICAgIH0pKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBwYXRoOiBxLCBzZWdtZW50czogW3sgbmFtZTogcS5zcGxpdCgvW1xcXFwvXS8pLmZpbHRlcihCb29sZWFuKS5wb3AoKSA/PyBxLCBwYXRoOiBxIH1dLCBwYXJlbnQ6ICcnLFxuICAgICAgICBkaXJzOiBbeyBuYW1lOiAnc3JjJywgcGF0aDogYCR7cS5yZXBsYWNlKC9bXFxcXC9dJC8sICcnKX1cXFxcc3JjYCB9XSxcbiAgICAgICAgLi4uKHdpdGhGaWxlcyA/IHsgZmlsZXM6IFtcbiAgICAgICAgICB7IG5hbWU6ICdSRUFETUUubWQnLCBwYXRoOiBgJHtxLnJlcGxhY2UoL1tcXFxcL10kLywgJycpfVxcXFxSRUFETUUubWRgLCByZWw6ICdSRUFETUUubWQnIH0sXG4gICAgICAgICAgeyBuYW1lOiAncGFja2FnZS5qc29uJywgcGF0aDogYCR7cS5yZXBsYWNlKC9bXFxcXC9dJC8sICcnKX1cXFxccGFja2FnZS5qc29uYCwgcmVsOiAncGFja2FnZS5qc29uJyB9LFxuICAgICAgICBdIH0gOiB7fSksXG4gICAgICB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2ZzL3JlYWQnKSB7XG4gICAgICAvLyBcdTY1ODdcdTRFRjZcdTk4ODRcdTg5QzgoNjRLQiBcdTRFMEFcdTk2NTBcdThCRURcdTRFNDk7ZmFrZSBcdThGRDRcdTU2REVcdTU2RkFcdTVCOUFcdTY1ODdcdTY3MkMpXG4gICAgICBjb25zdCBwID0gdXJsLnNlYXJjaFBhcmFtcy5nZXQoJ3BhdGgnKSA/PyAnJztcbiAgICAgIGlmIChwID09PSAnJykge1xuICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3BhdGggcmVxdWlyZWQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBwYXRoOiBwLCByZWw6IHAuc3BsaXQoL1tcXFxcL10vKS5wb3AoKSA/PyBwLCBzaXplOiA0MixcbiAgICAgICAgdGV4dDogJyMgZGVtbyB3b3Jrc3BhY2VcXG5cXG5cdThGRDlcdTY2MkYgZmFrZSBob3N0IFx1NzY4NFx1NjU4N1x1NEVGNlx1OTg4NFx1ODlDOFx1NTE4NVx1NUJCOVx1MzAwMlxcbicsXG4gICAgICB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2RpZmYnKSB7XG4gICAgICAvLyBEaWZmIFx1OTc2Mlx1Njc3RihcdTRFMEUgaG1oYXJuZXNzIC9hcGkvZGlmZiBcdTU0MENcdTVGNjI7ZmFrZSBcdThGRDRcdTU2REVcdTU2RkFcdTVCOUFcdTVDMEZcdTUzRDhcdTY2RjRcdTk2QzYpXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIGdpdDogdHJ1ZSwgY3dkOiAnQzpcXFxcZGVtbycsXG4gICAgICAgIGNoYW5nZWQ6IFtcbiAgICAgICAgICB7IHN0YXRlOiAnTScsIHBhdGg6ICdzcmMvYXBwLnRzJyB9LFxuICAgICAgICAgIHsgc3RhdGU6ICdBJywgcGF0aDogJ2RvY3Mvbm90ZXMubWQnIH0sXG4gICAgICAgIF0sXG4gICAgICAgIHN0YXQ6ICcgc3JjL2FwcC50cyAgICAgIHwgMTIgKysrKysrKy0tLVxcbiBkb2NzL25vdGVzLm1kICAgfCAgNCArKysrXFxuIDIgZmlsZXMgY2hhbmdlZCwgMTYgaW5zZXJ0aW9ucygrKSwgMyBkZWxldGlvbnMoLSknLFxuICAgICAgfSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9jb2duaXRpdmUnKSB7XG4gICAgICAvLyBcdThCQTRcdTc3RTVcdTcyQjZcdTYwMDEoXHU0RTBFIGhtaGFybmVzcyBjb2duaXRpdmVTdGF0dXMgXHU1NDBDXHU1RjYyXHU1QjUwXHU5NkM2O1x1N0YzQVx1NjU3MFx1NjM2RVx1NjYzRVx1NUYwRiBudWxsKVxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBtZW1vcnk6IHsgbGF5ZXJzOiAzLCBlbnRyaWVzOiAxMiwgY29udHJhZGljdGlvbnM6IDAgfSxcbiAgICAgICAgdHJhamVjdG9yaWVzOiA3LFxuICAgICAgICBhdWRpdEV2ZW50czogMjEsXG4gICAgICAgIHdvcmxkTW9kZWw6IHsgdmVyc2lvbjogNCwgYmVsaWVmczogOSwgdHJ1c3RlZDogNSwgYnJpZXI6IDAuMzEgfSxcbiAgICAgICAgY2FsaWJyYXRpb246IHsgcHJlZGljdGlvbnM6IDQ2LCByZWxpYWJpbGl0eTogMC43MiB9LFxuICAgICAgfSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZmFrZS9lbWl0Jykge1xuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7XG4gICAgICAgICAgICBzZXNzaW9uSWQ6IHN0cmluZzsgcnVuSWQ6IHN0cmluZzsga2luZDogRXZlbnRLaW5kOyBwYXlsb2FkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgICAgICB9O1xuICAgICAgICAgIGNvbnN0IHNlcSA9IGVtaXQoYm9keS5zZXNzaW9uSWQsIGJvZHkucnVuSWQsIGJvZHkua2luZCwgYm9keS5wYXlsb2FkKTtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgc2VxIH0pKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgU3RyaW5nKGVycikuc2xpY2UoMCwgMTIwKSwgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgIH1cbiAgICAgIH0pKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsIGBubyByb3V0ZSAke3JlcS5tZXRob2R9ICR7dXJsLnBhdGhuYW1lfWAsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICB9KTtcblxuICBhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgc2VydmVyLm9uY2UoJ2Vycm9yJywgcmVqZWN0KTtcbiAgICBzZXJ2ZXIubGlzdGVuKDAsICcxMjcuMC4wLjEnLCAoKSA9PiByZXNvbHZlKCkpO1xuICB9KTtcbiAgY29uc3QgYWRkcmVzcyA9IHNlcnZlci5hZGRyZXNzKCk7XG4gIGlmIChhZGRyZXNzID09PSBudWxsIHx8IHR5cGVvZiBhZGRyZXNzICE9PSAnb2JqZWN0JykgdGhyb3cgbmV3IEVycm9yKCdmYWtlIGhvc3Q6IG5vIHBvcnQnKTtcbiAgY29uc3QgcG9ydCA9IGFkZHJlc3MucG9ydDtcblxuICBpZiAoIW9wdHMucXVpZXQpIHtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtKU09OLnN0cmluZ2lmeSh7IGhtaERlc2t0b3BIb3N0UmVhZHk6IHRydWUsIHBvcnQsIHZlcnNpb246ICdmYWtlLTAuMC4wJyB9KX1cXG5gKTtcbiAgfVxuICBjb25zdCBkaWVBZnRlciA9IE51bWJlcihwcm9jZXNzLmVudi5GQUtFX0hPU1RfRElFX0FGVEVSX01TID8/IDApO1xuICBpZiAoTnVtYmVyLmlzRmluaXRlKGRpZUFmdGVyKSAmJiBkaWVBZnRlciA+IDApIHtcbiAgICBzZXRUaW1lb3V0KCgpID0+IHByb2Nlc3MuZXhpdCgxKSwgZGllQWZ0ZXIpLnVucmVmKCk7XG4gIH1cblxuICAvLyBjbG9zZSgpOiBcdTUxNDhcdTY1QURcdTVGMDBcdTUxNjhcdTkwRTggU1NFIFx1OEZERVx1NjNBNShcdTVCODNcdTRFRUNcdTZDMzhcdTRFMERcdTgxRUFcdTcxMzZcdTUxNzNcdTk1RUQpLFx1NTQyNlx1NTIxOSBzZXJ2ZXIuY2xvc2VcbiAgLy8gXHU0RjFBXHU0RTAwXHU3NkY0XHU3QjQ5XHU2RDNCXHU4REMzXHU4RkRFXHU2M0E1LFx1NkQ0Qlx1OEJENVx1OEZEQlx1N0EwQlx1NjMwMlx1NkI3Qlx1MzAwMlxuICBjb25zdCBjbG9zZSA9ICgpOiBQcm9taXNlPHZvaWQ+ID0+XG4gICAgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUpID0+IHtcbiAgICAgIGZvciAoY29uc3QgYyBvZiBzc2VDbGllbnRzKSB7XG4gICAgICAgIHRyeSB7IGMuZW5kKCk7IGMuZGVzdHJveSgpOyB9IGNhdGNoIHsgLyogYWxyZWFkeSBnb25lICovIH1cbiAgICAgIH1cbiAgICAgIHNzZUNsaWVudHMuY2xlYXIoKTtcbiAgICAgIHNlcnZlci5jbG9zZSgoKSA9PiByZXNvbHZlKCkpO1xuICAgICAgc2V0VGltZW91dCgoKSA9PiByZXNvbHZlKCksIDFfMDAwKS51bnJlZigpO1xuICAgIH0pO1xuXG4gIHJldHVybiB7IHBvcnQsIGVtaXQsIGNsb3NlIH07XG59XG5cbi8vIFx1NzZGNFx1NjNBNVx1OEZEMFx1ODg0QyhzdXBlcnZpc29yIHNwYXduIFx1NzY4NFx1NUI1MFx1OEZEQlx1N0EwQlx1NUY2Mlx1NjAwMSlcdTMwMDJyZWFscGF0aCBcdTZCRDRcdThGODM6bnBtIHdvcmtzcGFjZVxuLy8ganVuY3Rpb24gLyBcdTU5MjdcdTVDMEZcdTUxOTlcdTVERUVcdTVGMDJcdTkwRkRcdTRFMERcdTgwRkRcdThCQTlcdThGRDlcdTRFMkFcdTY4QzBcdTZENEJcdTU5MzFcdTYyNEIoXHU1OTMxXHU2MjRCPVx1OTc1OVx1OUVEOFx1OTAwMFx1NTFGQSBjb2RlIDAsXHU5NkJFXHU2N0U1KVx1MzAwMlxuLy8gY2pzIGJ1bmRsZShlc2J1aWxkLFx1NjI1M1x1NTMwNVx1NEVBN1x1NTRDMSlcdTRFMEIgX19maWxlbmFtZSBcdTVCNThcdTU3Mjg7RVNNKHRzeC9cdTZFOTBcdTc4MDEpXHU3NTI4IGltcG9ydC5tZXRhXHUzMDAyXG5jb25zdCBzZWxmVXJsOiBzdHJpbmcgPSB0eXBlb2YgX19maWxlbmFtZSA9PT0gJ3N0cmluZydcbiAgPyBwYXRoVG9GaWxlVVJMKHJlYWxwYXRoU3luYyhfX2ZpbGVuYW1lKSkuaHJlZlxuICA6IGltcG9ydC5tZXRhLnVybDtcbmNvbnN0IGludm9rZWRBc1NjcmlwdCA9ICgoKSA9PiB7XG4gIGlmIChwcm9jZXNzLmFyZ3ZbMV0gPT09IHVuZGVmaW5lZCkgcmV0dXJuIGZhbHNlO1xuICB0cnkge1xuICAgIHJldHVybiBzZWxmVXJsID09PSBwYXRoVG9GaWxlVVJMKHJlYWxwYXRoU3luYyhwcm9jZXNzLmFyZ3ZbMV0pKS5ocmVmO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn0pKCk7XG5pZiAoaW52b2tlZEFzU2NyaXB0KSB7XG4gIGNvbnN0IHRva2VuID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVE9LRU4gPz8gJyc7XG4gIC8vIEZBS0VfSE9TVF9ESUVfQVRfQk9PVD0xOlx1NUYxNVx1NUJGQ1x1ODg0Q1x1OEY5M1x1NTFGQVx1NTI0RFx1NTM3M1x1NkI3QihcdTY3ODRcdTkwMjBcdTU0MkZcdTUyQThcdTY3MUYgUlVOVElNRV9DUkFTSEVEKVxuICBpZiAocHJvY2Vzcy5lbnYuRkFLRV9IT1NUX0RJRV9BVF9CT09UID09PSAnMScpIHtcbiAgICBwcm9jZXNzLmV4aXQoMSk7XG4gIH1cbiAgY29uc3Qgc2xvdyA9IE51bWJlcihwcm9jZXNzLmVudi5GQUtFX0hPU1RfU0xPV19BRlRFUiA/PyAwKTtcbiAgY29uc3QgYm9vdCA9ICgpOiB2b2lkID0+IHtcbiAgICB2b2lkIHN0YXJ0RmFrZUhvc3QoeyB0b2tlbiB9KS5jYXRjaCgoZXJyKSA9PiB7XG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgZmFrZS1ob3N0IGZhaWxlZDogJHtTdHJpbmcoZXJyKX1cXG5gKTtcbiAgICAgIHByb2Nlc3MuZXhpdCgxKTtcbiAgICB9KTtcbiAgfTtcbiAgaWYgKE51bWJlci5pc0Zpbml0ZShzbG93KSAmJiBzbG93ID4gMCkgc2V0VGltZW91dChib290LCBzbG93KTtcbiAgZWxzZSBib290KCk7XG59XG4i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O0FBQy9DLFlBQU0sUUFBUyxNQUFNLEdBQUc7QUFBQTtBQUFBO0FBQUE7QUFBQSxTQUlyQjtBQUNILFlBQU0sSUFBSSxLQUFLLE1BQU0sS0FBSztBQUMxQixhQUFPLENBQUMsRUFBRSxZQUFZLGVBQWUsRUFBRSxhQUFhLEdBQUcsV0FBVyxFQUFFLE9BQU8sUUFBUSxFQUFFLFFBQVEsRUFBRTtBQUFBLElBQ2pHLENBQUM7QUFFRCxRQUFJLFNBQVM7QUFDYixlQUFXLENBQUMsTUFBTSxJQUFJLE1BQU0sS0FBSyxTQUFTO0FBQ3hDLGNBQVEsSUFBSSxpQkFBaUIsS0FBSyxTQUFTLE1BQU0sTUFBTSxJQUFJLE1BQU0sT0FBTyxNQUFNLENBQUMsRUFBRTtBQUNqRixVQUFJLENBQUMsR0FBSSxXQUFVO0FBQUEsSUFDckI7QUFDQSxZQUFRLElBQUksOEJBQThCLFFBQVEsU0FBUyxNQUFNLElBQUksUUFBUSxNQUFNLEVBQUU7QUFDckYsUUFBSSxLQUFLLFdBQVcsSUFBSSxJQUFJLENBQUM7QUFBQSxFQUMvQjtBQUdBLE1BQUksR0FBRyxlQUFlLENBQUMsTUFBTTtBQUMzQixRQUFJLGVBQWUsUUFBUSxXQUFXLFVBQVUsV0FBVztBQUN6RCxRQUFFLGVBQWU7QUFDakIsZ0JBQVUsTUFBTTtBQUNoQixXQUFLLFdBQVcsS0FBSyxFQUFFLFFBQVEsTUFBTSxJQUFJLEtBQUssQ0FBQztBQUFBLElBQ2pEO0FBQUEsRUFDRixDQUFDO0FBQ0QsTUFBSSxHQUFHLHFCQUFxQixNQUFNO0FBQ2hDLFFBQUksUUFBUSxhQUFhLFNBQVUsS0FBSSxLQUFLO0FBQUEsRUFDOUMsQ0FBQztBQUNIO0FBbGJXO0FBZUE7QUFrSEE7QUFZQTtBQVdBO0FBK0dBOyIsCiAgIm5hbWVzIjogWyJwYXRoVG9GaWxlVVJMIiwgInB1c2hFdmVudCIsICJicm9hZGNhc3RIb3N0U3RhdGUiLCAic2VuZGVyVHJ1c3RlZCIsICJob3N0Q2FsbCIsICJyZWdpc3RlcklwYyIsICJjcmVhdGVXaW5kb3ciLCAicGF0aFRvRmlsZVVSTCJdCn0K
