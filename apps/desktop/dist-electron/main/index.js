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
  const fakeWorkspaces = {
    current: "ws-demo",
    items: [
      { id: "ws-demo", name: "demo-workspace", path: "C:\\demo" }
    ]
  };
  const fakeProviders = /* @__PURE__ */ new Map([
    ["demo", { baseUrl: "http://127.0.0.1:9/v1", model: "fake-m", apiKey: "sk-demo-1234" }]
  ]);
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
        approvalPending: pending !== null,
        settings: { approval: "ask" },
        workspace: fakeWorkspaces.items.find((w) => w.id === fakeWorkspaces.current) ?? null,
        providersDetail: [...fakeProviders.entries()].map(([name, p]) => ({
          name,
          model: p.model,
          baseUrl: p.baseUrl,
          hasKey: p.apiKey !== "",
          keyTail: p.apiKey.length >= 4 ? p.apiKey.slice(-4) : void 0,
          purposes: ["chat"]
        }))
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
    if (req.method === "POST" && url.pathname.startsWith("/api/sessions/") && (url.pathname.endsWith("/archive") || url.pathname.endsWith("/delete"))) {
      void (async () => {
        const parts = url.pathname.slice("/api/sessions/".length).split("/");
        const op = parts[1] ?? "";
        const oid = decodeURIComponent(parts[0] ?? "").replace(/[^a-zA-Z0-9_:.@-]/g, "");
        if (oid === "" || op !== "archive" && op !== "delete") {
          res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(desktopError("SCHEMA_MISMATCH", "bad op", { retryable: false })));
          return;
        }
        if (!sessions.has(oid)) {
          res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(desktopError("SCHEMA_MISMATCH", "session not found", { retryable: false })));
          return;
        }
        sessions.delete(oid);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true }));
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
    if (req.method === "GET" && url.pathname === "/api/workspaces") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        current: fakeWorkspaces.current,
        items: fakeWorkspaces.items
      }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/workspaces") {
      void (async () => {
        const body = JSON.parse(await readBody() || "{}");
        const path = typeof body.path === "string" ? body.path : "";
        const name = typeof body.name === "string" && body.name !== "" ? body.name : path.split(/[\\/]/).filter(Boolean).pop() ?? "";
        if (path === "" || name === "") {
          res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(desktopError("SCHEMA_MISMATCH", "absolute path and name required", { retryable: false })));
          return;
        }
        if (fakeWorkspaces.items.some((w) => w.path.toLowerCase() === path.toLowerCase())) {
          res.writeHead(409, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(desktopError("SCHEMA_MISMATCH", "workspace already registered", { retryable: false })));
          return;
        }
        const item = { id: `ws-${Math.random().toString(36).slice(2, 8)}`, name, path };
        fakeWorkspaces.items.push(item);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, current: fakeWorkspaces.current, items: fakeWorkspaces.items }));
      })();
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/workspaces/use") {
      void (async () => {
        const body = JSON.parse(await readBody() || "{}");
        const hit = fakeWorkspaces.items.find((w) => w.id === body.id);
        if (hit === void 0) {
          res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(desktopError("SCHEMA_MISMATCH", "workspace not found", { retryable: false })));
          return;
        }
        fakeWorkspaces.current = hit.id;
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, current: fakeWorkspaces.current, items: fakeWorkspaces.items }));
      })();
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/providers") {
      void (async () => {
        const body = JSON.parse(await readBody() || "{}");
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
        const model = typeof body.model === "string" ? body.model.trim() : "";
        if (name === "" || baseUrl === "" || model === "") {
          res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(desktopError("SCHEMA_MISMATCH", "name, baseUrl and model are required", { retryable: false })));
          return;
        }
        fakeProviders.set(name, { baseUrl, model, apiKey: typeof body.apiKey === "string" ? body.apiKey : "" });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, name }));
      })();
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
    ipcMain.handle("bridge:providers", (event) => hostCall2(event, (c) => c.getJson("/api/state")));
    ipcMain.handle("bridge:provider-save", (event, provider) => {
      const p = provider;
      const name = typeof p?.name === "string" ? p.name.slice(0, 80) : "";
      const baseUrl = typeof p?.baseUrl === "string" ? p.baseUrl.slice(0, 300) : "";
      const model = typeof p?.model === "string" ? p.model.slice(0, 120) : "";
      if (name === "" || baseUrl === "" || model === "") return Promise.resolve({ error: "name/baseUrl/model required", code: "BAD_REQUEST" });
      const body = { name, baseUrl, model };
      if (typeof p?.apiKey === "string" && p.apiKey !== "") body.apiKey = p.apiKey.slice(0, 300);
      return hostCall2(event, (c) => c.postJson("/api/providers", body));
    });
    ipcMain.handle("bridge:workspaces", (event) => hostCall2(event, (c) => c.getJson("/api/workspaces")));
    ipcMain.handle("bridge:workspace-use", (event, id) => {
      const wid = typeof id === "string" ? id.slice(0, 60) : "";
      if (wid === "") return Promise.resolve({ error: "id required", code: "BAD_REQUEST" });
      return hostCall2(event, (c) => c.postJson("/api/workspaces/use", { id: wid }));
    });
    ipcMain.handle("bridge:workspace-add", (event, name, path) => {
      const n = typeof name === "string" ? name.slice(0, 120) : "";
      const p = typeof path === "string" ? path.slice(0, 1e3) : "";
      if (p === "") return Promise.resolve({ error: "path required", code: "BAD_REQUEST" });
      return hostCall2(event, (c) => c.postJson("/api/workspaces", { name: n === "" ? void 0 : n, path: p }));
    });
    ipcMain.handle("bridge:session-op", (event, id, op) => {
      const sid = typeof id === "string" ? id.replace(/[^a-zA-Z0-9_:.@-]/g, "").slice(0, 80) : "";
      const o = op === "archive" || op === "delete" ? op : "";
      if (sid === "" || o === "") return Promise.resolve({ error: "id and op(archive|delete) required", code: "BAD_REQUEST" });
      return hostCall2(event, (c) => c.postJson(`/api/sessions/${encodeURIComponent(sid)}/${o}`, {}));
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
      const allow = ["approve", "approvalGet", "approvalSet", "cognitive", "diff", "exportSession", "fsList", "fsRead", "getState", "inject", "interrupt", "onEventBatches", "onHostState", "onStreamChunks", "providerSave", "providers", "sendTask", "sessionOp", "sessionPreview", "sessions", "stopHost", "workspaces", "workspaceAdd", "workspaceUse"];
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vZWxlY3Ryb24vbWFpbi9pbmRleC50cyIsICIuLi8uLi8uLi8uLi9wYWNrYWdlcy9ob3N0LWFkYXB0ZXIvc3JjL3N1cGVydmlzb3IudHMiLCAiLi4vLi4vLi4vLi4vcGFja2FnZXMvY29udHJhY3RzL3NyYy9ldmVudC50cyIsICIuLi8uLi8uLi8uLi9wYWNrYWdlcy9jb250cmFjdHMvc3JjL2Vycm9yLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2NvbnRyYWN0cy9zcmMvZ3VhcmRzLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2hvc3QtYWRhcHRlci9zcmMvY2xpZW50LnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2hvc3QtYWRhcHRlci9zcmMvZmFrZS1ob3N0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIEhNSCBEZXNrdG9wIFx1MjAxNCBFbGVjdHJvbiBcdTRFM0JcdThGREJcdTdBMEIoQURSLTAwMS8wMDMvMDA0KVx1MzAwMlxuICpcbiAqIFx1NUI4OVx1NTE2OFx1NEUwRFx1NTNEOFx1OTFDRihcdTVGMDBcdTUzRDFcdThCQTFcdTUyMTIgTTAgXHU1MUZBXHU1M0UzXHU5NUU4ICsgRWxlY3Ryb24gXHU1Qjk4XHU2NUI5XHU1Qjg5XHU1MTY4XHU2RTA1XHU1MzU1KTpcbiAqICAtIHJlbmRlcmVyOmNvbnRleHRJc29sYXRpb24gKyBzYW5kYm94ICsgXHU3OTgxIG5vZGVJbnRlZ3JhdGlvbixcdTRFMjVcdTY4M0MgQ1NQO1xuICogIC0gXHU1QkZDXHU4MjJBL1x1NjVCMFx1N0E5N1x1NTNFM1x1NEUwMFx1NUY4Qlx1NjJEMlx1N0VERChcdTUzRUFcdTUyQTBcdThGN0RcdTYyMTFcdTRFRUNcdTgxRUFcdTVERjFcdTc2ODQgcmVuZGVyZXIpO1xuICogIC0gXHU2QkNGXHU2NzYxIElQQyBcdTY4MjFcdTlBOEMgc2VuZGVyIFx1NzY4NFx1OTg3Nlx1NUM0MiBmcmFtZSBVUkwgXHU1QzVFXHU0RThFXHU2NzJDXHU1RTk0XHU3NTI4LFx1OTAxQVx1OTA1M1x1NzY3RFx1NTQwRFx1NTM1NTtcbiAqICAtIGhvc3QgdG9rZW4gXHU1M0VBXHU1QjU4XHU1NzI4XHU0RThFXHU2NzJDXHU4RkRCXHU3QTBCXHU0RTBFXHU1QjUwXHU4RkRCXHU3QTBCIGVudixcdTY1RTVcdTVGRDdcdThGOTNcdTUxRkFcdTUyNERcdTUxNDhcdTgxMzFcdTY1NEY7XG4gKiAgLSBcdTUzNTVcdTVCOUVcdTRGOEJcdTk1MDE7XHU5MDAwXHU1MUZBXHU2NUY2XHU1M0VBXHU1MDVDXHU2QjYyXHU4MUVBXHU1REYxIHNwYXduIFx1NzY4NCBob3N0KFx1NEYxOFx1OTZDNVx1MjE5Mlx1NTE1Q1x1NUU5NSBraWxsKVx1MzAwMlxuICpcbiAqIFx1OTYzNlx1NkJCNUUoMjAyNi0xMC0xMCk6bWFpbiBcdTYzMDFcdTY3MDkgRGVza3RvcEhvc3RDbGllbnQsU1NFIFx1NEZFMVx1NUMwMVx1NkQ0MShldmVudDogaG1oKVxuICogXHU3RUNGIDUwbXMgXHU2Mjc5XHU5MUNGXHU2M0E4XHU3RUQ5IHJlbmRlcmVyO3NlbmRUYXNrL2FwcHJvdmUvaW50ZXJydXB0L3Nlc3Npb25zIFx1NTE2OFx1OTBFOFx1OEY2Q1x1NTNEMVxuICogXHU3RUQ5IGhvc3QgXHUyMDE0XHUyMDE0IGZha2UgXHU0RTBFXHU3NzFGXHU1QjlFIGhtaGFybmVzcyBkZXNrdG9wLWhvc3QgXHU4RDcwXHU1NDBDXHU0RTAwXHU2NzYxXHU0RUUzXHU3ODAxXHU4REVGXHU1Rjg0XHUzMDAyXG4gKi9cbmltcG9ydCB7IGFwcCwgQnJvd3NlcldpbmRvdywgZGlhbG9nLCBpcGNNYWluLCBzZXNzaW9uLCBzaGVsbCB9IGZyb20gJ2VsZWN0cm9uJztcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdub2RlOnBhdGgnO1xuaW1wb3J0IHsgd3JpdGVGaWxlIH0gZnJvbSAnbm9kZTpmcy9wcm9taXNlcyc7XG5pbXBvcnQgeyBwYXRoVG9GaWxlVVJMIH0gZnJvbSAnbm9kZTp1cmwnO1xuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gJ25vZGU6Y3J5cHRvJztcbmltcG9ydCB7IERlc2t0b3BSdW50aW1lU3VwZXJ2aXNvciwgRGVza3RvcEhvc3RDbGllbnQsIGVudmVsb3BlRnJvbUZyYW1lLCB0eXBlIEhvc3RTdGF0ZSB9IGZyb20gJ0BobWgtZGVza3RvcC9ob3N0LWFkYXB0ZXInO1xuaW1wb3J0IHsgaXNFdmVudEVudmVsb3BlLCB0eXBlIEV2ZW50RW52ZWxvcGUgfSBmcm9tICdAaG1oLWRlc2t0b3AvY29udHJhY3RzJztcblxuY29uc3QgaGVyZSA9IGltcG9ydC5tZXRhLmRpcm5hbWUgPz8gJy4nO1xuY29uc3QgaXNEZXYgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9ERVYgPT09ICcxJztcbmNvbnN0IHJlbmRlcmVyRGV2VXJsID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfUkVOREVSRVJfVVJMID8/ICcnO1xuY29uc3QgcHJlbG9hZFBhdGggPSBqb2luKGhlcmUsICcuLi9wcmVsb2FkL2luZGV4LmNqcycpO1xuXG4vKiAtLS0tIFx1NjVFNVx1NUZEN1x1ODEzMVx1NjU0Rjp0b2tlbi9hdXRob3JpemF0aW9uIFx1NkMzOFx1NEUwRFx1OEZEQlx1NjNBN1x1NTIzNlx1NTNGMCAtLS0tICovXG5jb25zdCBzZWNyZXRzOiBzdHJpbmdbXSA9IFtdO1xuZnVuY3Rpb24gcmVkYWN0KHM6IHN0cmluZyk6IHN0cmluZyB7XG4gIGxldCBvdXQgPSBzO1xuICBmb3IgKGNvbnN0IHNlYyBvZiBzZWNyZXRzKSB7XG4gICAgaWYgKHNlYy5sZW5ndGggPj0gOCkgb3V0ID0gb3V0LnNwbGl0KHNlYykuam9pbignW3JlZGFjdGVkXScpO1xuICB9XG4gIHJldHVybiBvdXQ7XG59XG5mdW5jdGlvbiBsb2dJbmZvKHRhZzogc3RyaW5nLCBtc2c6IHN0cmluZyk6IHZvaWQge1xuICBjb25zb2xlLmxvZyhgW2htaC1kZXNrdG9wOiR7dGFnfV0gJHtyZWRhY3QobXNnKX1gKTtcbn1cblxuLyogLS0tLSBcdTUzNTVcdTVCOUVcdTRGOEIgLS0tLSAqL1xuaWYgKCFhcHAucmVxdWVzdFNpbmdsZUluc3RhbmNlTG9jaygpKSB7XG4gIGFwcC5xdWl0KCk7XG59IGVsc2Uge1xuICBhcHAub24oJ3NlY29uZC1pbnN0YW5jZScsICgpID0+IHtcbiAgICBjb25zdCB3aW4gPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKVswXTtcbiAgICBpZiAod2luKSB7XG4gICAgICBpZiAod2luLmlzTWluaW1pemVkKCkpIHdpbi5yZXN0b3JlKCk7XG4gICAgICB3aW4uZm9jdXMoKTtcbiAgICB9XG4gIH0pO1xuXG4gIC8qIC0tLS0gaG9zdCBcdTc2RDFcdTdCQTEgKyBcdTY4NjVcdTVCQTJcdTYyMzdcdTdBRUYgLS0tLSAqL1xuICBpbnRlcmZhY2UgQnJpZGdlU25hcHNob3Qge1xuICAgIGhvc3RTdGF0ZTogSG9zdFN0YXRlO1xuICAgIGhvc3RQb3J0OiBudW1iZXIgfCBudWxsO1xuICAgIGhvc3RWZXJzaW9uOiBzdHJpbmcgfCBudWxsO1xuICAgIGxhc3RFcnJvcjogc3RyaW5nIHwgbnVsbDtcbiAgICBtb2RlOiAnZmFrZScgfCAncmVhbCc7XG4gIH1cbiAgbGV0IHN1cGVydmlzb3I6IERlc2t0b3BSdW50aW1lU3VwZXJ2aXNvciB8IG51bGwgPSBudWxsO1xuICBsZXQgY2xpZW50OiBEZXNrdG9wSG9zdENsaWVudCB8IG51bGwgPSBudWxsO1xuICBsZXQgYnJpZGdlOiBCcmlkZ2VTbmFwc2hvdCA9IHsgaG9zdFN0YXRlOiAnc3RvcHBlZCcsIGhvc3RQb3J0OiBudWxsLCBob3N0VmVyc2lvbjogbnVsbCwgbGFzdEVycm9yOiBudWxsLCBtb2RlOiAnZmFrZScgfTtcbiAgLyoqIFx1NEU4Qlx1NEVGNlx1NjI3OVx1OTFDRlx1N0YxM1x1NTFCMjpcdTlBRDhcdTk4OTEgU1NFIFx1NEUwRFx1OTAxMFx1Njc2MVx1OEZDNyBJUEMsNTBtcyBcdTYyNzlcdTkxQ0YgZmx1c2goXHU2RTMyXHU2N0QzXHU0RTBEXHU1MzYxKVx1MzAwMiAqL1xuICBsZXQgZXZlbnRCdWZmZXI6IEV2ZW50RW52ZWxvcGVbXSA9IFtdO1xuICBsZXQgZmx1c2hUaW1lcjogTm9kZUpTLlRpbWVvdXQgfCBudWxsID0gbnVsbDtcbiAgbGV0IHNzZUFib3J0OiBBYm9ydENvbnRyb2xsZXIgfCBudWxsID0gbnVsbDtcbiAgbGV0IGxhc3RFdmVudElkID0gJyc7XG4gIC8qKiBcdTY3MkFcdTc3RTUvXHU3NTc4XHU1RjYyXHU0RkUxXHU1QzAxXHU4QkExXHU2NTcwKFNDSEVNQV9NSVNNQVRDSCBcdTk3NjJcdTU0MTFcdThCQ0FcdTY1QUQsXHU0RTBEXHU1RDI5KVx1MzAwMiAqL1xuICBsZXQgZHJvcHBlZEZyYW1lcyA9IDA7XG5cbiAgZnVuY3Rpb24gcHVzaEV2ZW50KGVudjogRXZlbnRFbnZlbG9wZSk6IHZvaWQge1xuICAgIGV2ZW50QnVmZmVyLnB1c2goZW52KTtcbiAgICBpZiAoZXZlbnRCdWZmZXIubGVuZ3RoID4gMl8wMDApIGV2ZW50QnVmZmVyLnNwbGljZSgwLCBldmVudEJ1ZmZlci5sZW5ndGggLSAyXzAwMCk7XG4gICAgaWYgKGZsdXNoVGltZXIgPT09IG51bGwpIHtcbiAgICAgIGZsdXNoVGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgZmx1c2hUaW1lciA9IG51bGw7XG4gICAgICAgIGNvbnN0IGJhdGNoID0gZXZlbnRCdWZmZXI7XG4gICAgICAgIGV2ZW50QnVmZmVyID0gW107XG4gICAgICAgIGZvciAoY29uc3QgdyBvZiBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKSkge1xuICAgICAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ2JyaWRnZTpldmVudC1iYXRjaCcsIGJhdGNoKTtcbiAgICAgICAgfVxuICAgICAgfSwgNTApO1xuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIGJyb2FkY2FzdEhvc3RTdGF0ZShzOiBIb3N0U3RhdGUsIGluZm86IHsgcmVzdGFydENvdW50OiBudW1iZXI7IGxhc3RFcnJvcj86IHN0cmluZyB9KTogdm9pZCB7XG4gICAgYnJpZGdlID0geyAuLi5icmlkZ2UsIGhvc3RTdGF0ZTogcywgaG9zdFBvcnQ6IHN1cGVydmlzb3I/LmVuZHBvaW50Py5wb3J0ID8/IG51bGwsIGhvc3RWZXJzaW9uOiBzdXBlcnZpc29yPy5lbmRwb2ludD8udmVyc2lvbiA/PyBudWxsIH07XG4gICAgbG9nSW5mbygnaG9zdCcsIGBzdGF0ZT0ke3N9JHtpbmZvLmxhc3RFcnJvciAhPT0gdW5kZWZpbmVkID8gYCBlcnI9JHtpbmZvLmxhc3RFcnJvcn1gIDogJyd9YCk7XG4gICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XG4gICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCdicmlkZ2U6aG9zdC1zdGF0ZScsIHMsIGluZm8pO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBTU0UgXHU2RDQxXHU4QkEyXHU5NjA1Olx1NEZFMVx1NUMwMShldmVudDogaG1oKVx1NjI3OVx1OTFDRlx1NjNBOCByZW5kZXJlcjtcdTlBRDhcdTk4OTEgZGVsdGEvbGluZSBcdTUzOUZcdTVFMjdcbiAgICogIFx1NEY1Q1x1NEUzQVx1NkQ0MVx1NTc1N1x1OEY2Q1x1NTNEMShyZW5kZXJlciBcdTYyRkNcdTYzQTVcdTVGNTNcdTUyNEQgYXNzaXN0YW50IFx1NTM2MFx1NEY0RClcdTMwMDJcdTY1QURcdTdFQkZcdTgxRUFcdTUyQThcdTkxQ0RcdThGREVcdTMwMDIgKi9cbiAgYXN5bmMgZnVuY3Rpb24gcHVtcEV2ZW50cygpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAoY2xpZW50ID09PSBudWxsKSByZXR1cm47XG4gICAgZm9yICg7Oykge1xuICAgICAgY29uc3QgYyA9IGNsaWVudDtcbiAgICAgIGlmIChjID09PSBudWxsKSByZXR1cm47XG4gICAgICB0cnkge1xuICAgICAgICBmb3IgYXdhaXQgKGNvbnN0IGZyYW1lIG9mIGMucmF3RXZlbnRzKGxhc3RFdmVudElkID09PSAnJyA/IHVuZGVmaW5lZCA6IGxhc3RFdmVudElkLCBzc2VBYm9ydD8uc2lnbmFsKSkge1xuICAgICAgICAgIGlmIChmcmFtZS5ldmVudCA9PT0gJ2htaCcpIHtcbiAgICAgICAgICAgIGNvbnN0IGVudiA9IGVudmVsb3BlRnJvbUZyYW1lKGZyYW1lKTtcbiAgICAgICAgICAgIGlmIChlbnYgPT09IG51bGwpIHtcbiAgICAgICAgICAgICAgZHJvcHBlZEZyYW1lcyArPSAxO1xuICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGxhc3RFdmVudElkID0gZW52LmV2ZW50SWQ7XG4gICAgICAgICAgICBwdXNoRXZlbnQoZW52KTtcbiAgICAgICAgICB9IGVsc2UgaWYgKGZyYW1lLmV2ZW50ID09PSAnZGVsdGEnIHx8IGZyYW1lLmV2ZW50ID09PSAnbGluZScpIHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIGNvbnN0IGQgPSBKU09OLnBhcnNlKGZyYW1lLmRhdGEpIGFzIHsgc2Vzc2lvbklkPzogc3RyaW5nOyBrPzogc3RyaW5nOyBjaHVuaz86IHN0cmluZzsgdGV4dD86IHN0cmluZyB9O1xuICAgICAgICAgICAgICBjb25zdCBwYXlsb2FkID0gZnJhbWUuZXZlbnQgPT09ICdkZWx0YSdcbiAgICAgICAgICAgICAgICA/IHsgc2Vzc2lvbklkOiBkLnNlc3Npb25JZCA/PyAnJywga2luZDogZC5rID8/ICd0ZXh0JywgY2h1bms6IFN0cmluZyhkLmNodW5rID8/ICcnKSB9XG4gICAgICAgICAgICAgICAgOiB7IHNlc3Npb25JZDogZC5zZXNzaW9uSWQgPz8gJycsIGtpbmQ6ICdsaW5lJywgY2h1bms6IFN0cmluZyhkLnRleHQgPz8gJycpIH07XG4gICAgICAgICAgICAgIGZvciAoY29uc3QgdyBvZiBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKSkge1xuICAgICAgICAgICAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ2JyaWRnZTpzdHJlYW0tY2h1bmsnLCBwYXlsb2FkKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBjYXRjaCB7IC8qIG1hbGZvcm1lZCBzdHJlYW0gZnJhbWU6IHNraXAgKi8gfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICByZXR1cm47IC8vIFx1NkQ0MVx1NkI2M1x1NUUzOFx1N0VEM1x1Njc1Rihob3N0IFx1NTE3M1x1OTVFRClcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvLyBcdTY1QURcdTdFQkY6XHU3N0VEXHU5MDAwXHU5MDdGXHU1NDBFXHU5MUNEXHU4RkRFKHN1cGVydmlzb3IgXHU1M0VGXHU4MEZEXHU2QjYzXHU1NzI4XHU5MUNEXHU1NDJGIGhvc3QpXG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDFfMDAwKSk7XG4gICAgICAgIGlmIChzc2VBYm9ydD8uc2lnbmFsLmFib3J0ZWQpIHJldHVybjtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvKiogZGV2IFx1OUVEOFx1OEJBNCBmYWtlIGhvc3Q7SE1IX0RFU0tUT1BfUkVBTD0xIFx1NjVGNlx1OEZERVx1NzcxRlx1NUI5RSBobWhhcm5lc3MgZGVza3RvcC1ob3N0XHUzMDAyXG4gICAqICBcdTZDRThcdTYxMEY6RWxlY3Ryb24gXHU0RTNCXHU4RkRCXHU3QTBCXHU3Njg0IHByb2Nlc3MuZXhlY1BhdGggXHU2NjJGIGVsZWN0cm9uLmV4ZVx1MjAxNFx1MjAxNGhvc3QgXHU1QjUwXHU4RkRCXHU3QTBCXG4gICAqICBcdTVGQzVcdTk4N0JcdTVFMjYgRUxFQ1RST05fUlVOX0FTX05PREU9MSBcdTYyNERcdTRGMUFcdTRFRTVcdTdFQUYgbm9kZSBcdThCRURcdTRFNDlcdThERDFcdTMwMDJcbiAgICogIFx1NjI1M1x1NTMwNVx1NEVBN1x1NTRDMShhcHAuaXNQYWNrYWdlZCk6ZmFrZSBob3N0IFx1NzUyOCBleHRyYVJlc291cmNlcyBcdTkxQ0NcdTc2ODRcdTgxRUFcdTUzMDVcdTU0MkIgY2pzO1xuICAgKiAgXHU3NzFGXHU1QjlFIHJ1bnRpbWUgXHU5NzAwIEhNSF9ERVNLVE9QX1JFQUxfRU5UUlkgXHU2MzA3XHU1NDExIGRlc2t0b3AtaG9zdCBcdTUxNjVcdTUzRTMoXHU0RUE3XHU1NEMxXHU1MzE2XG4gICAqICBcdTc2ODQgcnVudGltZSBcdTYzNDZcdTdFRDFcdTVDNUVcdTU0MEVcdTdFRURcdThCQkVcdThCQTEsXHU4OUMxXHU5QThDXHU2NTM2XHU2MkE1XHU1NDRBKVx1MzAwMiAqL1xuICBhc3luYyBmdW5jdGlvbiBzdGFydEhvc3QoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgdXNlUmVhbCA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1JFQUwgPT09ICcxJztcbiAgICBicmlkZ2UgPSB7IC4uLmJyaWRnZSwgbW9kZTogdXNlUmVhbCA/ICdyZWFsJyA6ICdmYWtlJyB9O1xuICAgIGNvbnN0IHJlcG9Sb290ID0gam9pbihoZXJlLCAnLi4nLCAnLi4nLCAnLi4nLCAnLi4nKTsgLy8gYXBwcy9kZXNrdG9wL2Rpc3QtZWxlY3Ryb24vbWFpbiBcdTIxOTIgcmVwbyByb290XG4gICAgY29uc3QgcGFja2FnZWQgPSBhcHAuaXNQYWNrYWdlZDtcbiAgICBsZXQgc3BlYzogeyBjb21tYW5kOiBzdHJpbmc7IGFyZ3M6IHN0cmluZ1tdOyBlbnY6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gfTtcbiAgICBpZiAodXNlUmVhbCkge1xuICAgICAgY29uc3QgZW50cnkgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9SRUFMX0VOVFJZID8/IChwYWNrYWdlZCA/ICcnIDogam9pbihyZXBvUm9vdCwgJy4uJywgJ2htaGFybmVzcycsICdwYWNrYWdlcycsICd3ZWInLCAnc3JjJywgJ2Rlc2t0b3AtaG9zdC50cycpKTtcbiAgICAgIGlmIChlbnRyeSA9PT0gJycpIHtcbiAgICAgICAgYnJpZGdlID0geyAuLi5icmlkZ2UsIGhvc3RTdGF0ZTogJ2ZhaWxlZCcsIGxhc3RFcnJvcjogJ1x1NzcxRlx1NUI5RSBydW50aW1lIFx1NjcyQVx1OTE0RFx1N0Y2RTpcdTYyNTNcdTUzMDVcdTRFQTdcdTU0QzFcdTk3MDBcdThCQkVcdTdGNkUgSE1IX0RFU0tUT1BfUkVBTF9FTlRSWSBcdTYzMDdcdTU0MTEgaG1oYXJuZXNzIGRlc2t0b3AtaG9zdCBcdTUxNjVcdTUzRTMnIH07XG4gICAgICAgIGxvZ0luZm8oJ2hvc3QnLCAncmVhbCBtb2RlIHdpdGhvdXQgSE1IX0RFU0tUT1BfUkVBTF9FTlRSWSBpbiBwYWNrYWdlZCBhcHAnKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgc3BlYyA9IHtcbiAgICAgICAgY29tbWFuZDogcHJvY2Vzcy5leGVjUGF0aCxcbiAgICAgICAgYXJnczogWyctLWltcG9ydCcsICd0c3gnLCBlbnRyeV0sXG4gICAgICAgIGVudjogeyBFTEVDVFJPTl9SVU5fQVNfTk9ERTogJzEnIH0sXG4gICAgICB9O1xuICAgIH0gZWxzZSBpZiAocGFja2FnZWQpIHtcbiAgICAgIHNwZWMgPSB7XG4gICAgICAgIGNvbW1hbmQ6IHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgICAgIGFyZ3M6IFtqb2luKHByb2Nlc3MucmVzb3VyY2VzUGF0aCwgJ2Zha2UtaG9zdC5janMnKV0sXG4gICAgICAgIGVudjogeyBFTEVDVFJPTl9SVU5fQVNfTk9ERTogJzEnIH0sXG4gICAgICB9O1xuICAgIH0gZWxzZSB7XG4gICAgICBzcGVjID0ge1xuICAgICAgICBjb21tYW5kOiBwcm9jZXNzLmV4ZWNQYXRoLFxuICAgICAgICAvLyBcdTc2RjRcdTYzQTVcdThENzBcdTUzMDVcdTc3MUZcdTVCOUVcdThERUZcdTVGODQobm9kZV9tb2R1bGVzIFx1OTFDQ1x1NzY4NCB3b3Jrc3BhY2UganVuY3Rpb24gXHU0RjFBXHU4OEFCIEVTTVxuICAgICAgICAvLyByZWFscGF0aCBcdTUzMTYsXHU1QkZDXHU4MUY0IGZha2UtaG9zdCBcdTc2ODQgYXJndlsxXS9pbXBvcnQubWV0YS51cmwgXHU1MzM5XHU5MTREXHU1OTMxXHU2NTQ4KVxuICAgICAgICBhcmdzOiBbJy0taW1wb3J0JywgJ3RzeCcsIGpvaW4ocmVwb1Jvb3QsICdwYWNrYWdlcycsICdob3N0LWFkYXB0ZXInLCAnc3JjJywgJ2Zha2UtaG9zdC50cycpXSxcbiAgICAgICAgZW52OiB7IEVMRUNUUk9OX1JVTl9BU19OT0RFOiAnMScgfSxcbiAgICAgIH07XG4gICAgfVxuICAgIHN1cGVydmlzb3IgPSBuZXcgRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yKHNwZWMsIHtcbiAgICAgIG9uU3RhdGVDaGFuZ2U6IGJyb2FkY2FzdEhvc3RTdGF0ZSxcbiAgICAgIC8vIFx1OTk5Nlx1NkIyMVx1NTQyRlx1NTJBOFx1NEUwRSBjcmFzaCBcdTgxRUFcdTYxMDhcdTU0MEVcdTc2ODRcdTkxQ0RcdTU0MkZcdTkwRkRcdTRGMUFcdThENzBcdThGRDlcdTkxQ0M6XHU3QUVGXHU1M0UzL3Rva2VuIFx1OTBGRFx1NjYyRlx1NjVCMFx1NzY4NCxcbiAgICAgIC8vIFx1OTFDRFx1NUVGQVx1Njg2NVx1NUJBMlx1NjIzN1x1N0FFRlx1NUU3Nlx1OTFDRFx1NjVCMFx1OEJBMlx1OTYwNSBTU0UocmVuZGVyZXIgXHU3Njg0IEV2ZW50U3RvcmUgXHU5NzYwIGV2ZW50SWQgXHU1M0JCXHU5MUNEKVxuICAgICAgb25SZWFkeTogKGVwKSA9PiB7XG4gICAgICAgIGNsaWVudCA9IG5ldyBEZXNrdG9wSG9zdENsaWVudChgaHR0cDovLzEyNy4wLjAuMToke2VwLnBvcnR9YCwgZXAudG9rZW4pO1xuICAgICAgICBzc2VBYm9ydD8uYWJvcnQoKTtcbiAgICAgICAgc3NlQWJvcnQgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gICAgICAgIGxhc3RFdmVudElkID0gJyc7XG4gICAgICAgIHZvaWQgcHVtcEV2ZW50cygpO1xuICAgICAgICBsb2dJbmZvKCdob3N0JywgYGJyaWRnZSByZWFkeSBvbiAxMjcuMC4wLjE6JHtlcC5wb3J0fSAocnVudGltZSAke2VwLnZlcnNpb259LCBtb2RlICR7YnJpZGdlLm1vZGV9KWApO1xuICAgICAgfSxcbiAgICB9KTtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgc3VwZXJ2aXNvci5zdGFydCgpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgY29uc3QgZGV0YWlsID0gKCgpID0+IHsgdHJ5IHsgcmV0dXJuIEpTT04uc3RyaW5naWZ5KGVycik7IH0gY2F0Y2ggeyByZXR1cm4gU3RyaW5nKGVycik7IH0gfSkoKS5zbGljZSgwLCA0MDApO1xuICAgICAgYnJpZGdlID0geyAuLi5icmlkZ2UsIGhvc3RTdGF0ZTogJ2ZhaWxlZCcsIGxhc3RFcnJvcjogZGV0YWlsIH07XG4gICAgICBsb2dJbmZvKCdob3N0JywgYHN0YXJ0IGZhaWxlZDogJHtkZXRhaWx9YCk7XG4gICAgfVxuICB9XG5cbiAgLyogLS0tLSBJUEMgXHU3NjdEXHU1NDBEXHU1MzU1ICsgc2VuZGVyIFx1NjgyMVx1OUE4QyAtLS0tICovXG4gIGNvbnN0IGFsbG93ZWRPcmlnaW5zID0gbmV3IFNldDxzdHJpbmc+KFxuICAgIGlzRGV2ICYmIHJlbmRlcmVyRGV2VXJsXG4gICAgICA/IFtyZW5kZXJlckRldlVybF1cbiAgICAgIDogW3BhdGhUb0ZpbGVVUkwoam9pbihoZXJlLCAnLi4nLCAnLi4nLCAnZGlzdC1yZW5kZXJlcicsICdpbmRleC5odG1sJykpLmhyZWZdLFxuICApO1xuXG4gIGZ1bmN0aW9uIHNlbmRlclRydXN0ZWQoc2VuZGVyRnJhbWU6IEVsZWN0cm9uLldlYkZyYW1lTWFpbiB8IG51bGwgfCB1bmRlZmluZWQpOiBib29sZWFuIHtcbiAgICBpZiAoc2VuZGVyRnJhbWUgPT09IG51bGwgfHwgc2VuZGVyRnJhbWUgPT09IHVuZGVmaW5lZCkgcmV0dXJuIGZhbHNlO1xuICAgIGxldCB0b3A6IEVsZWN0cm9uLldlYkZyYW1lTWFpbiB8IG51bGwgPSBzZW5kZXJGcmFtZTtcbiAgICB3aGlsZSAodG9wPy5wYXJlbnQgIT09IG51bGwgJiYgdG9wPy5wYXJlbnQgIT09IHVuZGVmaW5lZCkgdG9wID0gdG9wLnBhcmVudDtcbiAgICBjb25zdCB1cmwgPSB0b3A/LnVybCA/PyAnJztcbiAgICBmb3IgKGNvbnN0IG9yaWdpbiBvZiBhbGxvd2VkT3JpZ2lucykge1xuICAgICAgaWYgKHVybCA9PT0gb3JpZ2luIHx8IHVybC5zdGFydHNXaXRoKGAke29yaWdpbn0vYCkgfHwgdXJsLnN0YXJ0c1dpdGgoYCR7b3JpZ2lufT9gKSkgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIC8qKiBcdTk3MDBcdTg5ODEgaG9zdCBcdTVDMzFcdTdFRUFcdTc2ODQgSVBDIGhhbmRsZXIgXHU1MTZDXHU1MTcxXHU1OEYzOlx1NjcyQVx1NUMzMVx1N0VFQVx1OEZENFx1NTZERVx1N0VEM1x1Njc4NFx1NTMxNlx1OTUxOVx1OEJFRlx1MzAwMiAqL1xuICBmdW5jdGlvbiBob3N0Q2FsbDxUPihldmVudDogRWxlY3Ryb24uSXBjTWFpbkludm9rZUV2ZW50LCBmbjogKGM6IERlc2t0b3BIb3N0Q2xpZW50KSA9PiBQcm9taXNlPFQ+KTogUHJvbWlzZTxUIHwgeyBlcnJvcjogc3RyaW5nOyBjb2RlOiBzdHJpbmcgfT4ge1xuICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9KTtcbiAgICBpZiAoY2xpZW50ID09PSBudWxsIHx8IGJyaWRnZS5ob3N0U3RhdGUgIT09ICdyZWFkeScpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogYGhvc3Qgbm90IHJlYWR5ICgke2JyaWRnZS5ob3N0U3RhdGV9KWAsIGNvZGU6ICdIT1NUX05PVF9SRUFEWScgfSk7XG4gICAgfVxuICAgIHJldHVybiBmbihjbGllbnQpLmNhdGNoKChlcnI6IHVua25vd24pID0+IHtcbiAgICAgIGNvbnN0IGRldGFpbCA9ICgoKSA9PiB7IHRyeSB7IHJldHVybiBKU09OLnN0cmluZ2lmeShlcnIpOyB9IGNhdGNoIHsgcmV0dXJuIFN0cmluZyhlcnIpOyB9IH0pKCkuc2xpY2UoMCwgMzAwKTtcbiAgICAgIHJldHVybiB7IGVycm9yOiBkZXRhaWwsIGNvZGU6ICdCUklER0VfRVJST1InIH07XG4gICAgfSk7XG4gIH1cblxuICBmdW5jdGlvbiByZWdpc3RlcklwYygpOiB2b2lkIHtcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmdldC1zdGF0ZScsIChldmVudCkgPT4ge1xuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJyB9O1xuICAgICAgcmV0dXJuIHsgLi4uYnJpZGdlLCBkcm9wcGVkRnJhbWVzIH07XG4gICAgfSk7XG5cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnNlc3Npb25zJywgKGV2ZW50KSA9PlxuICAgICAgaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248eyBzZXNzaW9uczogQXJyYXk8eyBpZDogc3RyaW5nOyB0aXRsZTogc3RyaW5nOyB0YXNrOiBzdHJpbmc7IG91dGNvbWU6IHN0cmluZzsgdHVybnM6IG51bWJlcjsgdG9vbFVzZXM6IG51bWJlcjsgdGltZTogc3RyaW5nOyBjd2Q6IHN0cmluZzsgY3JlYXRlZEF0OiBzdHJpbmc7IHVwZGF0ZWRBdDogc3RyaW5nIH0+IH0+KCcvYXBpL3Nlc3Npb25zP2xpbWl0PTEwMCcpKSk7XG5cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnNlbmQtdGFzaycsIChldmVudCwgdGV4dDogdW5rbm93biwgc2Vzc2lvbklkOiB1bmtub3duLCBtb2RlOiB1bmtub3duKSA9PiB7XG4gICAgICBjb25zdCB0YXNrID0gdHlwZW9mIHRleHQgPT09ICdzdHJpbmcnID8gdGV4dC5zbGljZSgwLCAyMF8wMDApIDogJyc7XG4gICAgICBjb25zdCBzaWQgPSB0eXBlb2Ygc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IHNlc3Npb25JZC5zbGljZSgwLCA4MCkgOiAnJztcbiAgICAgIGNvbnN0IG0gPSBtb2RlID09PSAnYXV0bycgfHwgbW9kZSA9PT0gJ3lvbG8nID8gbW9kZSA6ICdhc2snO1xuICAgICAgaWYgKHRhc2sgPT09ICcnIHx8IHNpZCA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBvazogZmFsc2UsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW47IHJ1bklkPzogc3RyaW5nIH0+KCcvYXBpL3Rhc2snLCB7IHRleHQ6IHRhc2ssIHNlc3Npb25JZDogc2lkLCBtb2RlOiBtIH0pKTtcbiAgICB9KTtcblxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6YXBwcm92ZScsIChldmVudCwgZ3JhbnRlZDogdW5rbm93biwgc2Vzc2lvbklkOiB1bmtub3duKSA9PlxuICAgICAgaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvYXBwcm92ZScsIHtcbiAgICAgICAgZ3JhbnRlZDogZ3JhbnRlZCA9PT0gdHJ1ZSxcbiAgICAgICAgc2Vzc2lvbklkOiB0eXBlb2Ygc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IHNlc3Npb25JZC5zbGljZSgwLCA4MCkgOiAnJyxcbiAgICAgIH0pKSk7XG5cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmludGVycnVwdCcsIChldmVudCwgc2Vzc2lvbklkOiB1bmtub3duKSA9PlxuICAgICAgaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvaW50ZXJydXB0Jywge1xuICAgICAgICBzZXNzaW9uSWQ6IHR5cGVvZiBzZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gc2Vzc2lvbklkLnNsaWNlKDAsIDgwKSA6ICcnLFxuICAgICAgfSkpKTtcblxuICAgIC8vIC0tLS0gTTQ6XHU1REU1XHU0RjVDXHU1MzNBXHU2NTg3XHU0RUY2XHU5NzYyKFx1OERFRlx1NUY4NFx1NjM4OFx1Njc0M1x1NTcyOCBydW50aW1lOmluc2lkZVdzIFx1NjgyMVx1OUE4QykgLS0tLVxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6ZnMtbGlzdCcsIChldmVudCwgcGF0aDogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3QgcCA9IHR5cGVvZiBwYXRoID09PSAnc3RyaW5nJyA/IHBhdGguc2xpY2UoMCwgMTAwMCkgOiAnJztcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oYC9hcGkvZnM/ZmlsZXM9MSR7cCAhPT0gJycgPyBgJnBhdGg9JHtlbmNvZGVVUklDb21wb25lbnQocCl9YCA6ICcnfWApKTtcbiAgICB9KTtcblxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6ZnMtcmVhZCcsIChldmVudCwgcGF0aDogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3QgcCA9IHR5cGVvZiBwYXRoID09PSAnc3RyaW5nJyA/IHBhdGguc2xpY2UoMCwgMTAwMCkgOiAnJztcbiAgICAgIGlmIChwID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAncGF0aCByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KGAvYXBpL2ZzL3JlYWQ/cGF0aD0ke2VuY29kZVVSSUNvbXBvbmVudChwKX1gKSk7XG4gICAgfSk7XG5cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmluamVjdCcsIChldmVudCwgdGV4dDogdW5rbm93biwgc2Vzc2lvbklkOiB1bmtub3duKSA9PiB7XG4gICAgICBjb25zdCB0ID0gdHlwZW9mIHRleHQgPT09ICdzdHJpbmcnID8gdGV4dC5zbGljZSgwLCAyMF8wMDApIDogJyc7XG4gICAgICBjb25zdCBzaWQgPSB0eXBlb2Ygc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IHNlc3Npb25JZC5zbGljZSgwLCA4MCkgOiAnJztcbiAgICAgIGlmICh0ID09PSAnJyB8fCBzaWQgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgb2s6IGZhbHNlLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KCcvYXBpL2luamVjdCcsIHsgdGV4dDogdCwgc2Vzc2lvbklkOiBzaWQgfSkpO1xuICAgIH0pO1xuXG4gICAgLy8gLS0tLSBcdTRGMUFcdThCRERcdTVCRkNcdTUxRkEoZXhwb3J0Lm1kIFx1MjE5MiBcdTRGRERcdTVCNThcdTVCRjlcdThCRERcdTY4NDY7XHU2NTg3XHU0RUY2XHU1MTk5XHU1MTY1XHU1M0VBXHU1NzI4IG1haW4pIC0tLS1cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmV4cG9ydC1zZXNzaW9uJywgYXN5bmMgKGV2ZW50LCBpZDogdW5rbm93bikgPT4ge1xuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcbiAgICAgIGNvbnN0IHNpZCA9IHR5cGVvZiBpZCA9PT0gJ3N0cmluZycgPyBpZC5yZXBsYWNlKC9bXmEtekEtWjAtOV86LkAtXS9nLCAnJykuc2xpY2UoMCwgODApIDogJyc7XG4gICAgICBpZiAoc2lkID09PSAnJykgcmV0dXJuIHsgZXJyb3I6ICdpZCByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfTtcbiAgICAgIGlmIChjbGllbnQgPT09IG51bGwgfHwgYnJpZGdlLmhvc3RTdGF0ZSAhPT0gJ3JlYWR5JykgcmV0dXJuIHsgZXJyb3I6IGBob3N0IG5vdCByZWFkeSAoJHticmlkZ2UuaG9zdFN0YXRlfSlgLCBjb2RlOiAnSE9TVF9OT1RfUkVBRFknIH07XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBtZCA9IGF3YWl0IGNsaWVudC5nZXRUZXh0KGAvYXBpL3Nlc3Npb25zLyR7ZW5jb2RlVVJJQ29tcG9uZW50KHNpZCl9L2V4cG9ydC5tZGApO1xuICAgICAgICBjb25zdCB3aW4gPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5maW5kKCh3KSA9PiAhdy5pc0Rlc3Ryb3llZCgpKTtcbiAgICAgICAgaWYgKHdpbiA9PT0gdW5kZWZpbmVkKSByZXR1cm4geyBlcnJvcjogJ25vIHdpbmRvdycsIGNvZGU6ICdCUklER0VfRVJST1InIH07XG4gICAgICAgIGNvbnN0IHIgPSBhd2FpdCBkaWFsb2cuc2hvd1NhdmVEaWFsb2cod2luLCB7XG4gICAgICAgICAgdGl0bGU6ICdcdTVCRkNcdTUxRkFcdTRGMUFcdThCREQnLFxuICAgICAgICAgIGRlZmF1bHRQYXRoOiBgaG1oLSR7c2lkfS5tZGAsXG4gICAgICAgICAgZmlsdGVyczogW3sgbmFtZTogJ01hcmtkb3duJywgZXh0ZW5zaW9uczogWydtZCddIH1dLFxuICAgICAgICB9KTtcbiAgICAgICAgaWYgKHIuY2FuY2VsZWQgfHwgci5maWxlUGF0aCA9PT0gdW5kZWZpbmVkIHx8IHIuZmlsZVBhdGggPT09ICcnKSByZXR1cm4geyBvazogZmFsc2UsIGNhbmNlbGVkOiB0cnVlIH07XG4gICAgICAgIGF3YWl0IHdyaXRlRmlsZShyLmZpbGVQYXRoLCBtZCwgJ3V0ZjgnKTtcbiAgICAgICAgbG9nSW5mbygnZXhwb3J0JywgYHNlc3Npb24gJHtzaWR9IFx1MjE5MiAke3IuZmlsZVBhdGh9YCk7XG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBwYXRoOiByLmZpbGVQYXRoIH07XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgY29uc3QgZGV0YWlsID0gKCgpID0+IHsgdHJ5IHsgcmV0dXJuIEpTT04uc3RyaW5naWZ5KGVycik7IH0gY2F0Y2ggeyByZXR1cm4gU3RyaW5nKGVycik7IH0gfSkoKS5zbGljZSgwLCAzMDApO1xuICAgICAgICByZXR1cm4geyBlcnJvcjogZGV0YWlsLCBjb2RlOiAnQlJJREdFX0VSUk9SJyB9O1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgLy8gLS0tLSBcdTVCQTFcdTYyNzlcdTZBMjFcdTVGMEZcdThCRkJcdTUxOTkoXHU2NzQzXHU1QTAxXHU1NzI4IHJ1bnRpbWUgY29uZmlnO1x1NTIwN1x1NjM2Mlx1NUZDNVx1OTg3Qlx1NjYzRVx1NUYwRikgLS0tLVxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6YXBwcm92YWwtZ2V0JywgKGV2ZW50KSA9PlxuICAgICAgaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248eyBzZXR0aW5ncz86IHsgYXBwcm92YWw/OiBzdHJpbmcgfSB9PignL2FwaS9zdGF0ZScpKSk7XG5cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmFwcHJvdmFsLXNldCcsIChldmVudCwgbW9kZTogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3QgbSA9IG1vZGUgPT09ICdhdXRvJyA/ICdhdXRvJyA6IG1vZGUgPT09ICdhc2snID8gJ2FzaycgOiAnJztcbiAgICAgIGlmIChtID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAnbW9kZSBtdXN0IGJlIGFza3xhdXRvJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PignL2FwaS9jb25maWcnLCB7IGFwcHJvdmFsOiBtIH0pKTtcbiAgICB9KTtcblxuICAgIC8vIC0tLS0gUHJvdmlkZXIgXHU4QkJFXHU3RjZFKDAzIFx1MDBBN1x1NEUwMzprZXkgXHU1M0VBXHU1MUZBIGhhc0tleS9cdTY3MkJcdTU2REJcdTRGNEQ7XHU0RkREXHU1QjU4XHU3NkY0XHU1MTk5IHJ1bnRpbWUpIC0tLS1cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnByb3ZpZGVycycsIChldmVudCkgPT5cbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPHsgcHJvdmlkZXJzRGV0YWlsPzogQXJyYXk8eyBuYW1lOiBzdHJpbmc7IG1vZGVsOiBzdHJpbmc7IGJhc2VVcmw6IHN0cmluZzsgaGFzS2V5OiBib29sZWFuOyBrZXlUYWlsPzogc3RyaW5nIH0+OyBtb2RlbD86IHN0cmluZyB9PignL2FwaS9zdGF0ZScpKSk7XG5cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnByb3ZpZGVyLXNhdmUnLCAoZXZlbnQsIHByb3ZpZGVyOiB1bmtub3duKSA9PiB7XG4gICAgICBjb25zdCBwID0gcHJvdmlkZXIgYXMgeyBuYW1lPzogdW5rbm93bjsgYmFzZVVybD86IHVua25vd247IG1vZGVsPzogdW5rbm93bjsgYXBpS2V5PzogdW5rbm93biB9O1xuICAgICAgY29uc3QgbmFtZSA9IHR5cGVvZiBwPy5uYW1lID09PSAnc3RyaW5nJyA/IHAubmFtZS5zbGljZSgwLCA4MCkgOiAnJztcbiAgICAgIGNvbnN0IGJhc2VVcmwgPSB0eXBlb2YgcD8uYmFzZVVybCA9PT0gJ3N0cmluZycgPyBwLmJhc2VVcmwuc2xpY2UoMCwgMzAwKSA6ICcnO1xuICAgICAgY29uc3QgbW9kZWwgPSB0eXBlb2YgcD8ubW9kZWwgPT09ICdzdHJpbmcnID8gcC5tb2RlbC5zbGljZSgwLCAxMjApIDogJyc7XG4gICAgICBpZiAobmFtZSA9PT0gJycgfHwgYmFzZVVybCA9PT0gJycgfHwgbW9kZWwgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICduYW1lL2Jhc2VVcmwvbW9kZWwgcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xuICAgICAgY29uc3QgYm9keTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7IG5hbWUsIGJhc2VVcmwsIG1vZGVsIH07XG4gICAgICAvLyBhcGlLZXkgXHU1M0VBXHU1NzI4XHU2NjNFXHU1RjBGXHU4RjkzXHU1MTY1XHU2NUY2XHU0RTBBXHU0RjIwLFx1N0VERFx1NEUwRFx1NTZERVx1NjYzRShyZW5kZXJlciBcdTg4NjhcdTUzNTVcdTYzRDBcdTRFQTRcdTU0MEVcdTUzNzNcdTZFMDVcdTdBN0EpXG4gICAgICBpZiAodHlwZW9mIHA/LmFwaUtleSA9PT0gJ3N0cmluZycgJiYgcC5hcGlLZXkgIT09ICcnKSBib2R5LmFwaUtleSA9IHAuYXBpS2V5LnNsaWNlKDAsIDMwMCk7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvcHJvdmlkZXJzJywgYm9keSkpO1xuICAgIH0pO1xuXG4gICAgLy8gLS0tLSBcdTVERTVcdTRGNUNcdTUzM0EoMDMgXHUwMEE3XHU1MTZEO1x1NTIwN1x1NjM2Mlx1OEJFRFx1NEU0OVx1NEUwRSB3ZWIgXHU3NkY4XHU1NDBDOnJ1bnRpbWUgXHU1MzU1XHU5MDA5IGN3ZCkgLS0tLVxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6d29ya3NwYWNlcycsIChldmVudCkgPT5cbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPHsgY3VycmVudDogc3RyaW5nOyBpdGVtczogQXJyYXk8eyBpZDogc3RyaW5nOyBuYW1lOiBzdHJpbmc7IHBhdGg6IHN0cmluZyB9PiB9PignL2FwaS93b3Jrc3BhY2VzJykpKTtcblxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6d29ya3NwYWNlLXVzZScsIChldmVudCwgaWQ6IHVua25vd24pID0+IHtcbiAgICAgIGNvbnN0IHdpZCA9IHR5cGVvZiBpZCA9PT0gJ3N0cmluZycgPyBpZC5zbGljZSgwLCA2MCkgOiAnJztcbiAgICAgIGlmICh3aWQgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICdpZCByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvd29ya3NwYWNlcy91c2UnLCB7IGlkOiB3aWQgfSkpO1xuICAgIH0pO1xuXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTp3b3Jrc3BhY2UtYWRkJywgKGV2ZW50LCBuYW1lOiB1bmtub3duLCBwYXRoOiB1bmtub3duKSA9PiB7XG4gICAgICBjb25zdCBuID0gdHlwZW9mIG5hbWUgPT09ICdzdHJpbmcnID8gbmFtZS5zbGljZSgwLCAxMjApIDogJyc7XG4gICAgICBjb25zdCBwID0gdHlwZW9mIHBhdGggPT09ICdzdHJpbmcnID8gcGF0aC5zbGljZSgwLCAxMDAwKSA6ICcnO1xuICAgICAgaWYgKHAgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICdwYXRoIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PignL2FwaS93b3Jrc3BhY2VzJywgeyBuYW1lOiBuID09PSAnJyA/IHVuZGVmaW5lZCA6IG4sIHBhdGg6IHAgfSkpO1xuICAgIH0pO1xuXG4gICAgLy8gLS0tLSBcdTRGMUFcdThCRERcdTVGNTJcdTY4NjMvXHU1MjIwXHU5NjY0KFx1NzlGQlx1NTE2NSBhcmNoaXZlL3RyYXNoLFx1NTNFRlx1NjA2Mlx1NTkwRDtydW50aW1lIFx1Njc0M1x1NUEwMSkgLS0tLVxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6c2Vzc2lvbi1vcCcsIChldmVudCwgaWQ6IHVua25vd24sIG9wOiB1bmtub3duKSA9PiB7XG4gICAgICBjb25zdCBzaWQgPSB0eXBlb2YgaWQgPT09ICdzdHJpbmcnID8gaWQucmVwbGFjZSgvW15hLXpBLVowLTlfOi5ALV0vZywgJycpLnNsaWNlKDAsIDgwKSA6ICcnO1xuICAgICAgY29uc3QgbyA9IG9wID09PSAnYXJjaGl2ZScgfHwgb3AgPT09ICdkZWxldGUnID8gb3AgOiAnJztcbiAgICAgIGlmIChzaWQgPT09ICcnIHx8IG8gPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICdpZCBhbmQgb3AoYXJjaGl2ZXxkZWxldGUpIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PihgL2FwaS9zZXNzaW9ucy8ke2VuY29kZVVSSUNvbXBvbmVudChzaWQpfS8ke299YCwge30pKTtcbiAgICB9KTtcblxuICAgIC8vIC0tLS0gTTQ6RGlmZiBcdTk3NjJcdTY3N0YoXHU1M0VBXHU4QkZCIGdpdCBcdTUzRDhcdTY2RjQ7XHU2Mzg4XHU2NzQzXHU1NzI4IHJ1bnRpbWUpIC0tLS1cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmRpZmYnLCAoZXZlbnQsIHNlc3Npb25JZDogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIHNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBzZXNzaW9uSWQuc2xpY2UoMCwgODApIDogJyc7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KGAvYXBpL2RpZmYke3NpZCAhPT0gJycgPyBgP3Nlc3Npb25JZD0ke2VuY29kZVVSSUNvbXBvbmVudChzaWQpfWAgOiAnJ31gKSk7XG4gICAgfSk7XG5cbiAgICAvLyAtLS0tIE01Olx1OEJBNFx1NzdFNVx1NzJCNlx1NjAwMShcdTdFRDNcdTY3ODRcdTUzMTZcdTRFOEJcdTVCOUU7XHU3RjNBXHU2NTcwXHU2MzZFXHU1QjU3XHU2QkI1XHU3NTMxIFVJIFx1NjYzRVx1NzkzQVwiXHU2NUUwXHU2NTcwXHU2MzZFXCIpIC0tLS1cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmNvZ25pdGl2ZScsIChldmVudCkgPT5cbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPFJlY29yZDxzdHJpbmcsIHVua25vd24+PignL2FwaS9jb2duaXRpdmUnKSkpO1xuXG4gICAgLy8gLS0tLSBcdTUzODZcdTUzRjJcdTRGMUFcdThCRERcdTk4ODRcdTg5QzgoXHU2NzAwXHU1NDBFIDgwIFx1Njc2MSxcdTZCQ0ZcdTY3NjEgNTAwIFx1NUI1NztydW50aW1lIFx1Njc0M1x1NUEwMVx1NjU3MFx1NjM2RSkgLS0tLVxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6c2Vzc2lvbi1wcmV2aWV3JywgKGV2ZW50LCBpZDogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIGlkID09PSAnc3RyaW5nJyA/IGlkLnJlcGxhY2UoL1teYS16QS1aMC05XzouQC1dL2csICcnKS5zbGljZSgwLCA4MCkgOiAnJztcbiAgICAgIGlmIChzaWQgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICdpZCByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KGAvYXBpL3Nlc3Npb25zLyR7ZW5jb2RlVVJJQ29tcG9uZW50KHNpZCl9YCkpO1xuICAgIH0pO1xuXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpzdG9wLWhvc3QnLCAoZXZlbnQpID0+IHtcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicgfTtcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcbiAgICAgICAgc3NlQWJvcnQ/LmFib3J0KCk7XG4gICAgICAgIGF3YWl0IHN1cGVydmlzb3I/LnN0b3AoKTtcbiAgICAgICAgYXBwLnF1aXQoKTtcbiAgICAgIH0pKCk7XG4gICAgICByZXR1cm4geyBvazogdHJ1ZSB9O1xuICAgIH0pO1xuICB9XG5cbiAgLyogLS0tLSBcdTdBOTdcdTUzRTNcdTRFMEVcdTVCODlcdTUxNjhcdTdCNTZcdTc1NjUgLS0tLSAqL1xuICBmdW5jdGlvbiBjcmVhdGVXaW5kb3coKTogdm9pZCB7XG4gICAgY29uc3Qgd2luID0gbmV3IEJyb3dzZXJXaW5kb3coe1xuICAgICAgd2lkdGg6IDE0NDAsXG4gICAgICBoZWlnaHQ6IDkwMCxcbiAgICAgIG1pbldpZHRoOiA5NjAsXG4gICAgICBtaW5IZWlnaHQ6IDYwMCxcbiAgICAgIHNob3c6IGZhbHNlLFxuICAgICAgYmFja2dyb3VuZENvbG9yOiAnIzE0MTQxNicsXG4gICAgICB0aXRsZTogJ0hNSCBEZXNrdG9wJyxcbiAgICAgIHdlYlByZWZlcmVuY2VzOiB7XG4gICAgICAgIHByZWxvYWQ6IHByZWxvYWRQYXRoLFxuICAgICAgICBjb250ZXh0SXNvbGF0aW9uOiB0cnVlLFxuICAgICAgICBzYW5kYm94OiB0cnVlLFxuICAgICAgICBub2RlSW50ZWdyYXRpb246IGZhbHNlLFxuICAgICAgICBub2RlSW50ZWdyYXRpb25JbldvcmtlcjogZmFsc2UsXG4gICAgICAgIHdlYlNlY3VyaXR5OiB0cnVlLFxuICAgICAgICBzcGVsbGNoZWNrOiBmYWxzZSxcbiAgICAgICAgZGV2VG9vbHM6IGlzRGV2LFxuICAgICAgfSxcbiAgICB9KTtcbiAgICB3aW4ub25jZSgncmVhZHktdG8tc2hvdycsICgpID0+IHdpbi5zaG93KCkpO1xuXG4gICAgLy8gXHU1M0VBXHU1MTQxXHU4QkI4XHU1MkEwXHU4RjdEXHU2MjExXHU0RUVDXHU4MUVBXHU1REYxXHU3Njg0IHJlbmRlcmVyO1x1NEVGQlx1NEY1NVx1NUJGQ1x1ODIyQS9cdTY1QjBcdTdBOTdcdTUzRTNcdTRFMDBcdTVGOEJcdTYyRDJcdTdFRERcbiAgICB3aW4ud2ViQ29udGVudHMuc2V0V2luZG93T3BlbkhhbmRsZXIoKHsgdXJsIH0pID0+IHtcbiAgICAgIGlmICgvXmh0dHBzPzpcXC9cXC8vLnRlc3QodXJsKSkgdm9pZCBzaGVsbC5vcGVuRXh0ZXJuYWwodXJsKTtcbiAgICAgIHJldHVybiB7IGFjdGlvbjogJ2RlbnknIH07XG4gICAgfSk7XG4gICAgd2luLndlYkNvbnRlbnRzLm9uKCd3aWxsLW5hdmlnYXRlJywgKGUsIHVybCkgPT4ge1xuICAgICAgY29uc3Qgb2sgPSBbLi4uYWxsb3dlZE9yaWdpbnNdLnNvbWUoKG8pID0+IHVybCA9PT0gbyB8fCB1cmwuc3RhcnRzV2l0aChgJHtvfS9gKSB8fCB1cmwuc3RhcnRzV2l0aChgJHtvfT9gKSk7XG4gICAgICBpZiAoIW9rKSB7XG4gICAgICAgIGxvZ0luZm8oJ25hdicsIGBibG9ja2VkIG5hdmlnYXRpb24gdG8gJHt1cmwuc2xpY2UoMCwgMTIwKX1gKTtcbiAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgaWYgKGlzRGV2ICYmIHJlbmRlcmVyRGV2VXJsKSB7XG4gICAgICB2b2lkIHdpbi5sb2FkVVJMKHJlbmRlcmVyRGV2VXJsKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdm9pZCB3aW4ubG9hZEZpbGUoam9pbihoZXJlLCAnLi4nLCAnLi4nLCAnZGlzdC1yZW5kZXJlcicsICdpbmRleC5odG1sJykpO1xuICAgIH1cbiAgfVxuXG4gIGFwcC53aGVuUmVhZHkoKS50aGVuKCgpID0+IHtcbiAgICAvLyBDU1AoZGV2IFx1NEUwRSBwcm9kIFx1NEUwRFx1NTQwQztwcm9kIFx1NEUwRFx1NTE0MVx1OEJCOFx1NEVGQlx1NEY1NVx1OEZEQ1x1N0EwQlx1NkU5MClcbiAgICBjb25zdCBjc3AgPSBpc0RldlxuICAgICAgPyBbXG4gICAgICAgICAgXCJkZWZhdWx0LXNyYyAnc2VsZidcIixcbiAgICAgICAgICBgc2NyaXB0LXNyYyAnc2VsZicgJHtyZW5kZXJlckRldlVybH1gLFxuICAgICAgICAgIFwic3R5bGUtc3JjICdzZWxmJyAndW5zYWZlLWlubGluZSdcIixcbiAgICAgICAgICBgY29ubmVjdC1zcmMgJ3NlbGYnICR7cmVuZGVyZXJEZXZVcmx9IHdzOi8vMTI3LjAuMC4xOipgLFxuICAgICAgICAgIFwiaW1nLXNyYyAnc2VsZicgZGF0YTpcIixcbiAgICAgICAgICBcImZvbnQtc3JjICdzZWxmJyBkYXRhOlwiLFxuICAgICAgICBdLmpvaW4oJzsgJylcbiAgICAgIDogXCJkZWZhdWx0LXNyYyAnc2VsZic7IHNjcmlwdC1zcmMgJ3NlbGYnOyBzdHlsZS1zcmMgJ3NlbGYnICd1bnNhZmUtaW5saW5lJzsgaW1nLXNyYyAnc2VsZicgZGF0YTo7IGZvbnQtc3JjICdzZWxmJyBkYXRhOlwiO1xuICAgIHNlc3Npb24uZGVmYXVsdFNlc3Npb24ud2ViUmVxdWVzdC5vbkhlYWRlcnNSZWNlaXZlZCgoZGV0YWlscywgY2FsbGJhY2spID0+IHtcbiAgICAgIGNhbGxiYWNrKHtcbiAgICAgICAgcmVzcG9uc2VIZWFkZXJzOiB7XG4gICAgICAgICAgLi4uZGV0YWlscy5yZXNwb25zZUhlYWRlcnMsXG4gICAgICAgICAgJ0NvbnRlbnQtU2VjdXJpdHktUG9saWN5JzogW2NzcF0sXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHJlZ2lzdGVySXBjKCk7XG4gICAgY3JlYXRlV2luZG93KCk7XG4gICAgdm9pZCBzdGFydEhvc3QoKTtcblxuICAgIC8vIFx1OTYzNlx1NkJCNUggXHU1Qjg5XHU1MTY4XHU4MUVBXHU2RDRCKE1hc3RlclByb21wdCBIOnJlbmRlcmVyIFx1NjVFMCBwcm9jZXNzL3JlcXVpcmVcdTMwMDFcdTc2N0RcdTU0MERcdTUzNTVcdTY4NjVcdTMwMDFcbiAgICAvLyBcdTVCRkNcdTgyMkFcdTYyRTZcdTYyMkFcdTMwMDFDU1BcdTMwMDF3aW5kb3cub3BlbiBcdTYyRDJcdTdFREQpXHUzMDAyXHU4MUVBXHU5QTcxXHU2M0EyXHU5NDg4LHNjcmlwdHMvc2VjdXJpdHktdGVzdC5tanMgXHU2RDg4XHU4RDM5XHUzMDAyXG4gICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NFQ1VSSVRZX1RFU1QgPT09ICcxJykge1xuICAgICAgY29uc3Qgd2luMCA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpWzBdO1xuICAgICAgaWYgKHdpbjAgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICB3aW4wLndlYkNvbnRlbnRzLm9uY2UoJ2RpZC1maW5pc2gtbG9hZCcsICgpID0+IHtcbiAgICAgICAgICB2b2lkIHNlY3VyaXR5U2VsZlRlc3Qod2luMCk7XG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cblxuICAgIGFwcC5vbignYWN0aXZhdGUnLCAoKSA9PiB7XG4gICAgICBpZiAoQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkubGVuZ3RoID09PSAwKSBjcmVhdGVXaW5kb3coKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgYXN5bmMgZnVuY3Rpb24gc2VjdXJpdHlTZWxmVGVzdCh3aW46IEJyb3dzZXJXaW5kb3cpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCByZXN1bHRzOiBBcnJheTxbc3RyaW5nLCBib29sZWFuLCBzdHJpbmddPiA9IFtdO1xuICAgIGNvbnN0IGNoZWNrID0gYXN5bmMgKG5hbWU6IHN0cmluZywgcHJvYmU6ICgpID0+IFByb21pc2U8W2Jvb2xlYW4sIHN0cmluZ10+KTogUHJvbWlzZTx2b2lkPiA9PiB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBbb2ssIGRldGFpbF0gPSBhd2FpdCBwcm9iZSgpO1xuICAgICAgICByZXN1bHRzLnB1c2goW25hbWUsIG9rLCBkZXRhaWxdKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICByZXN1bHRzLnB1c2goW25hbWUsIGZhbHNlLCBTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApXSk7XG4gICAgICB9XG4gICAgfTtcbiAgICBjb25zdCBqcyA9IChjb2RlOiBzdHJpbmcpOiBQcm9taXNlPHVua25vd24+ID0+IHdpbi53ZWJDb250ZW50cy5leGVjdXRlSmF2YVNjcmlwdChjb2RlLCB0cnVlKTtcblxuICAgIGF3YWl0IGNoZWNrKCdyZW5kZXJlciBcdTY1RTBcdTUzRUZcdTc1MjhcdTc2ODQgcHJvY2Vzcy9yZXF1aXJlKHNhbmRib3ggXHU3NTFGXHU2NTQ4KScsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoYChmdW5jdGlvbigpe1xuICAgICAgICB2YXIgdCA9IGZ1bmN0aW9uKGYpeyB0cnkgeyB2YXIgdiA9IGYoKTsgcmV0dXJuICh2ID09PSB1bmRlZmluZWQgfHwgdiA9PT0gbnVsbCkgPyAndW5hdmFpbGFibGUnIDogdHlwZW9mIHY7IH0gY2F0Y2goZSl7IHJldHVybiAnYmxvY2tlZCc7IH0gfTtcbiAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KFt0KGZ1bmN0aW9uKCl7cmV0dXJuIHByb2Nlc3N9KSwgdChmdW5jdGlvbigpe3JldHVybiByZXF1aXJlfSksIHQoZnVuY3Rpb24oKXtyZXR1cm4gZ2xvYmFsVGhpcy5wcm9jZXNzfSldKTtcbiAgICAgIH0pKClgKSkgYXMgc3RyaW5nO1xuICAgICAgY29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShyKSBhcyBzdHJpbmdbXTtcbiAgICAgIGNvbnN0IHAgPSBwYXJzZWRbMF0gPz8gJ3Vua25vd24nO1xuICAgICAgY29uc3QgcmVxID0gcGFyc2VkWzFdID8/ICd1bmtub3duJztcbiAgICAgIGNvbnN0IHNhZmUgPSAodjogc3RyaW5nKTogYm9vbGVhbiA9PiB2ID09PSAndW5hdmFpbGFibGUnIHx8IHYgPT09ICdibG9ja2VkJztcbiAgICAgIHJldHVybiBbc2FmZShwKSAmJiBzYWZlKHJlcSksIGBwcm9jZXNzPSR7cH0gcmVxdWlyZT0ke3JlcX1gXTtcbiAgICB9KTtcbiAgICBhd2FpdCBjaGVjaygnd2luZG93LmhtaCBcdTUzRUFcdTY3MDlcdTc2N0RcdTU0MERcdTUzNTVcdTY1QjlcdTZDRDUoXHU2NUUwIGlwY1JlbmRlcmVyL1x1OTg5RFx1NTkxNlx1OTc2MiknLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKCdPYmplY3Qua2V5cyh3aW5kb3cuaG1oIHx8IHt9KS5zb3J0KCkuam9pbihcIixcIiknKSkgYXMgc3RyaW5nO1xuICAgICAgY29uc3QgYWxsb3cgPSBbJ2FwcHJvdmUnLCAnYXBwcm92YWxHZXQnLCAnYXBwcm92YWxTZXQnLCAnY29nbml0aXZlJywgJ2RpZmYnLCAnZXhwb3J0U2Vzc2lvbicsICdmc0xpc3QnLCAnZnNSZWFkJywgJ2dldFN0YXRlJywgJ2luamVjdCcsICdpbnRlcnJ1cHQnLCAnb25FdmVudEJhdGNoZXMnLCAnb25Ib3N0U3RhdGUnLCAnb25TdHJlYW1DaHVua3MnLCAncHJvdmlkZXJTYXZlJywgJ3Byb3ZpZGVycycsICdzZW5kVGFzaycsICdzZXNzaW9uT3AnLCAnc2Vzc2lvblByZXZpZXcnLCAnc2Vzc2lvbnMnLCAnc3RvcEhvc3QnLCAnd29ya3NwYWNlcycsICd3b3Jrc3BhY2VBZGQnLCAnd29ya3NwYWNlVXNlJ107XG4gICAgICBjb25zdCBnb3QgPSByID09PSAnJyA/IFtdIDogci5zcGxpdCgnLCcpO1xuICAgICAgY29uc3QgdW5leHBlY3RlZCA9IGdvdC5maWx0ZXIoKGspID0+ICFhbGxvdy5pbmNsdWRlcyhrKSk7XG4gICAgICByZXR1cm4gW3VuZXhwZWN0ZWQubGVuZ3RoID09PSAwLCBga2V5cz0ke3J9YF07XG4gICAgfSk7XG4gICAgYXdhaXQgY2hlY2soJ1x1NTkxNlx1OTBFOFx1NUJGQ1x1ODIyQVx1ODhBQlx1NjJFNlx1NjIyQShVUkwgXHU0RTBEXHU1M0Q4KScsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IGJlZm9yZSA9IHdpbi53ZWJDb250ZW50cy5nZXRVUkwoKTtcbiAgICAgIGF3YWl0IGpzKCdsb2NhdGlvbi5ocmVmID0gXCJodHRwczovL2V4YW1wbGUuaW52YWxpZC94XCI7IFwibm9vcFwiJykuY2F0Y2goKCkgPT4gJ25vb3AnKTtcbiAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyMikgPT4gc2V0VGltZW91dChyMiwgMV8yMDApKTtcbiAgICAgIGNvbnN0IGFmdGVyID0gd2luLndlYkNvbnRlbnRzLmdldFVSTCgpO1xuICAgICAgcmV0dXJuIFthZnRlciA9PT0gYmVmb3JlLCBgJHtiZWZvcmV9IFx1MjE5MiAke2FmdGVyfWBdO1xuICAgIH0pO1xuICAgIGF3YWl0IGNoZWNrKCd3aW5kb3cub3BlbiBcdTg4QUJcdTYyRDJcdTdFREQoXHU4RkQ0XHU1NkRFIG51bGwgXHU0RTE0XHU2NUUwXHU2NUIwXHU3QTk3XHU1M0UzKScsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IGJlZm9yZSA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmxlbmd0aDtcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoJ1N0cmluZyh3aW5kb3cub3BlbihcImh0dHBzOi8vZXhhbXBsZS5pbnZhbGlkXCIpKScpKSBhcyBzdHJpbmc7XG4gICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocjIpID0+IHNldFRpbWVvdXQocjIsIDQwMCkpO1xuICAgICAgY29uc3QgYWZ0ZXIgPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5sZW5ndGg7XG4gICAgICByZXR1cm4gW3IgPT09ICdudWxsJyAmJiBhZnRlciA9PT0gYmVmb3JlLCBgb3BlbigpPSR7cn0gd2luZG93cz0ke2JlZm9yZX1cdTIxOTIke2FmdGVyfWBdO1xuICAgIH0pO1xuICAgIGF3YWl0IGNoZWNrKCdDU1AgXHU1QjU4XHU1NzI4KG1ldGEgXHU2Q0U4XHU1MTY1XHU2MjE2XHU1NENEXHU1RTk0XHU1OTM0KScsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IG1ldGEgPSAoYXdhaXQganMoJ0Jvb2xlYW4oZG9jdW1lbnQucXVlcnlTZWxlY3RvcihcIm1ldGFbaHR0cC1lcXVpdj1cXCdDb250ZW50LVNlY3VyaXR5LVBvbGljeVxcJ11cIikpJykpIGFzIGJvb2xlYW47XG4gICAgICBjb25zdCBoZWFkZXJDc3AgPSBpc0RldiA/ICdkZXY6IGhlYWRlciBDU1AgXHU3NTMxIG9uSGVhZGVyc1JlY2VpdmVkIFx1NkNFOFx1NTE2NShcdTRFMERcdTkwMDJcdTc1MjggbWV0YSBcdTY1QURcdThBMDApJyA6ICdwcm9kJztcbiAgICAgIHJldHVybiBbbWV0YSB8fCBpc0RldiwgYG1ldGE9JHttZXRhfSAke2hlYWRlckNzcH1gXTtcbiAgICB9KTtcbiAgICBhd2FpdCBjaGVjaygnYnJpZGdlOmdldC1zdGF0ZSBcdTZCNjNcdTVFMzhcdThGRDRcdTU2REUoaG9zdCBcdTY4NjVcdTUzRUZcdTc1MjgpJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgciA9IChhd2FpdCBqcygnd2luZG93LmhtaC5nZXRTdGF0ZSgpLnRoZW4ocyA9PiBKU09OLnN0cmluZ2lmeShzKSkuY2F0Y2goZSA9PiBcIkVSUjpcIitlKScpKSBhcyBzdHJpbmc7XG4gICAgICByZXR1cm4gW3Iuc3RhcnRzV2l0aCgneycpICYmIHIuaW5jbHVkZXMoJ2hvc3RTdGF0ZScpLCByLnNsaWNlKDAsIDgwKV07XG4gICAgfSk7XG4gICAgYXdhaXQgY2hlY2soJ1hTUzpcdTYwNzZcdTYxMEZcdTRFRkJcdTUyQTFcdTY1ODdcdTY3MkNcdTUzRUFcdTRFRTVcdTY1ODdcdTY3MkNcdTZFMzJcdTY3RDMoXHU0RTBEXHU2MjY3XHU4ODRDKScsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHBheWxvYWQgPSAnPGltZyBzcmM9eCBvbmVycm9yPVwid2luZG93Ll9feHNzPTFcIj48c2NyaXB0PndpbmRvdy5fX3hzcz0yPFxcL3NjcmlwdD5cIiZcXCcnO1xuICAgICAgY29uc3Qgc2VuZFIgPSAoYXdhaXQganMoYHdpbmRvdy5obWguc2VuZFRhc2soJHtKU09OLnN0cmluZ2lmeShwYXlsb2FkKX0sICdzZWMteHNzLTEnLCAnYXV0bycpLnRoZW4ocj0+SlNPTi5zdHJpbmdpZnkocikpLmNhdGNoKGU9PidFUlI6JytlKWApKSBhcyBzdHJpbmc7XG4gICAgICBpZiAoIXNlbmRSLmluY2x1ZGVzKCdcIm9rXCI6dHJ1ZScpKSByZXR1cm4gW2ZhbHNlLCBgc2VuZFRhc2sgXHU2NzJBXHU1M0Q3XHU3NDA2OiAke3NlbmRSLnNsaWNlKDAsIDgwKX1gXTtcbiAgICAgIC8vIGZha2UgaG9zdCBlY2hvIFx1NTZERVx1Njc2NVx1NTQwRVx1N0VDRiBSZWFjdCBcdTZFMzJcdTY3RDMoXHU3NTI4XHU2MjM3XHU2RDg4XHU2MDZGICsgXHU1MkE5XHU2MjRCIGVjaG8gXHU1M0NDXHU4REVGXHU1Rjg0KVxuICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHIyKSA9PiBzZXRUaW1lb3V0KHIyLCAzXzAwMCkpO1xuICAgICAgY29uc3QgcHJvYmUgPSAoYXdhaXQganMoYEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgeHNzRmxhZzogdHlwZW9mIHdpbmRvdy5fX3hzcyxcbiAgICAgICAgaW1nQ291bnQ6IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ2ltZ1tzcmM9XCJ4XCJdJykubGVuZ3RoLFxuICAgICAgICBzY3JpcHRSYW46IGRvY3VtZW50LmJvZHkuaW5uZXJUZXh0LmluZGV4T2YoJ3dpbmRvdy5fX3hzcz0yJykgPj0gMFxuICAgICAgfSlgKSkgYXMgc3RyaW5nO1xuICAgICAgY29uc3QgcCA9IEpTT04ucGFyc2UocHJvYmUpIGFzIHsgeHNzRmxhZzogc3RyaW5nOyBpbWdDb3VudDogbnVtYmVyOyBzY3JpcHRSYW46IGJvb2xlYW4gfTtcbiAgICAgIHJldHVybiBbcC54c3NGbGFnID09PSAndW5kZWZpbmVkJyAmJiBwLmltZ0NvdW50ID09PSAwLCBgeHNzRmxhZz0ke3AueHNzRmxhZ30gaW1nPSR7cC5pbWdDb3VudH1gXTtcbiAgICB9KTtcblxuICAgIGxldCBmYWlsZWQgPSAwO1xuICAgIGZvciAoY29uc3QgW25hbWUsIG9rLCBkZXRhaWxdIG9mIHJlc3VsdHMpIHtcbiAgICAgIGNvbnNvbGUubG9nKGBTRUNVUklUWS1URVNUICR7b2sgPyAnUEFTUycgOiAnRkFJTCd9IHwgJHtuYW1lfSB8ICR7cmVkYWN0KGRldGFpbCl9YCk7XG4gICAgICBpZiAoIW9rKSBmYWlsZWQgKz0gMTtcbiAgICB9XG4gICAgY29uc29sZS5sb2coYFNFQ1VSSVRZLVRFU1QgU1VNTUFSWSBwYXNzPSR7cmVzdWx0cy5sZW5ndGggLSBmYWlsZWR9LyR7cmVzdWx0cy5sZW5ndGh9YCk7XG4gICAgYXBwLmV4aXQoZmFpbGVkID09PSAwID8gMCA6IDEpO1xuICB9XG5cbiAgLy8gXHU5MDAwXHU1MUZBOlx1NEYxOFx1OTZDNVx1NTA1Q1x1NkI2Mlx1ODFFQVx1NURGMSBzcGF3biBcdTc2ODQgaG9zdChzaHV0ZG93biBcdTdBRUZcdTcwQjkgXHUyMTkyIFx1NTE1Q1x1NUU5NVx1NTNFQSBraWxsIFx1ODFFQVx1NURGMVx1NzY4NFx1NTNFNVx1NjdDNClcbiAgYXBwLm9uKCdiZWZvcmUtcXVpdCcsIChlKSA9PiB7XG4gICAgaWYgKHN1cGVydmlzb3IgIT09IG51bGwgJiYgc3VwZXJ2aXNvci5zdGF0ZSAhPT0gJ3N0b3BwZWQnKSB7XG4gICAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgICBzc2VBYm9ydD8uYWJvcnQoKTtcbiAgICAgIHZvaWQgc3VwZXJ2aXNvci5zdG9wKCkuZmluYWxseSgoKSA9PiBhcHAucXVpdCgpKTtcbiAgICB9XG4gIH0pO1xuICBhcHAub24oJ3dpbmRvdy1hbGwtY2xvc2VkJywgKCkgPT4ge1xuICAgIGlmIChwcm9jZXNzLnBsYXRmb3JtICE9PSAnZGFyd2luJykgYXBwLnF1aXQoKTtcbiAgfSk7XG59XG4iLCAiLyoqXG4gKiBEZXNrdG9wUnVudGltZVN1cGVydmlzb3IgXHUyMDE0IGhtaGFybmVzcyBob3N0IFx1OEZEQlx1N0EwQlx1NzY4NFx1NzUxRlx1NTQ3RFx1NTQ2OFx1NjcxRlx1NzJCNlx1NjAwMVx1NjczQShBRFItMDAzKVx1MzAwMlxuICpcbiAqIFx1NUI4OVx1NTE2OFx1NEUwRFx1NTNEOFx1OTFDRjpcbiAqICAtIFx1NTNFQVx1N0VEMVx1NUI5QS9cdTYzQTJcdTZENEIgMTI3LjAuMC4xO2hvc3QgXHU0RjdGXHU3NTI4XHU2NENEXHU0RjVDXHU3Q0ZCXHU3RURGXHU1MjA2XHU5MTREXHU3QUVGXHU1M0UzKHBvcnQgMCksXHU1QjlFXHU5NjQ1XHU3QUVGXHU1M0UzXG4gKiAgICBcdTc1MzEgaG9zdCBcdTc2ODQgc3Rkb3V0IFx1NUYxNVx1NUJGQ1x1ODg0Q1x1NTZERVx1NEYyMChIb3N0UmVhZHlMaW5lKVx1MzAwMlxuICogIC0gXHU5QUQ4XHU3MUI1IHRva2VuIFx1NTNFQVx1OTAxQVx1OEZDN1x1NUI1MFx1OEZEQlx1N0EwQlx1NzNBRlx1NTg4M1x1NTNEOFx1OTFDRlx1NEYyMFx1OTAxMixcdTdFRERcdTRFMERcdThGREIgVVJML1x1NjVFNVx1NUZENy9JUEMgXHU2NjBFXHU2NTg3XHU4RDFGXHU4RjdEXHUzMDAyXG4gKiAgLSBcdTUzRUFcdTUwNUNcdTZCNjJcdTY3MkMgc3VwZXJ2aXNvciBzcGF3biBcdTc2ODRcdThGREJcdTdBMEJcdTUzRTVcdTY3QzQ7XHU3RUREXHU0RTBEXHU2MzA5XHU4RkRCXHU3QTBCXHU1NDBEIGtpbGxcdTMwMDJcbiAqICAtIGhvc3QgY3Jhc2ggXHU1NDBFXHU2NzA5XHU5NjUwXHU5MUNEXHU1NDJGO1x1OTFDRFx1NTQyRlx1NEUwRFx1OTFDRFx1NjUzRVx1NEVGQlx1NEY1NVx1NzUyOFx1NjIzN1x1NTJBOFx1NEY1QyhcdTk3NUVcdTVFNDJcdTdCNDlcdTUyQThcdTRGNUNcdTc1MzFcdTc1MjhcdTYyMzdcdTc4NkVcdThCQTQpXHUzMDAyXG4gKi9cbmltcG9ydCB7IHNwYXduLCB0eXBlIENoaWxkUHJvY2VzcyB9IGZyb20gJ25vZGU6Y2hpbGRfcHJvY2Vzcyc7XG5pbXBvcnQgeyBjcmVhdGVJbnRlcmZhY2UgfSBmcm9tICdub2RlOnJlYWRsaW5lJztcbmltcG9ydCB7IHJhbmRvbUJ5dGVzIH0gZnJvbSAnbm9kZTpjcnlwdG8nO1xuaW1wb3J0IHsgZGVza3RvcEVycm9yLCBpc0Rlc2t0b3BFcnJvciwgdHlwZSBEZXNrdG9wRXJyb3IgfSBmcm9tICdAaG1oLWRlc2t0b3AvY29udHJhY3RzJztcblxuZXhwb3J0IHR5cGUgSG9zdFN0YXRlID1cbiAgfCAnc3RvcHBlZCdcbiAgfCAnc3RhcnRpbmcnXG4gIHwgJ3JlYWR5J1xuICB8ICdkaXNjb25uZWN0ZWQnXG4gIHwgJ3Jlc3RhcnRpbmcnXG4gIHwgJ3N0b3BwaW5nJ1xuICB8ICdmYWlsZWQnO1xuXG5leHBvcnQgaW50ZXJmYWNlIEhvc3RTcGVjIHtcbiAgLyoqIFx1NTNFRlx1NjI2N1x1ODg0Q1x1NjU4N1x1NEVGNihcdTkwMUFcdTVFMzggcHJvY2Vzcy5leGVjUGF0aClcdTMwMDIgKi9cbiAgY29tbWFuZDogc3RyaW5nO1xuICBhcmdzOiBzdHJpbmdbXTtcbiAgY3dkPzogc3RyaW5nO1xuICAvKiogXHU5ODlEXHU1OTE2XHU3M0FGXHU1ODgzXHU1M0Q4XHU5MUNGKFx1NEYxQVx1NEUwRSBwcm9jZXNzLmVudiBcdTU0MDhcdTVFNzYpXHUzMDAyICovXG4gIGVudj86IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3VwZXJ2aXNvck9wdGlvbnMge1xuICAvKiogXHU2NzFGXHU2NzFCIGhvc3QgXHU2ODIxXHU5QThDXHU3Njg0IGJlYXJlciB0b2tlbjtcdTRFMERcdTRGMjBcdTUyMTlcdTZCQ0ZcdTZCMjEgc3RhcnQgXHU3NTFGXHU2MjEwXHU5QUQ4XHU3MUI1XHU5NjhGXHU2NzNBXHU1MDNDXHUzMDAyICovXG4gIHRva2VuPzogc3RyaW5nO1xuICBtYXhSZXN0YXJ0cz86IG51bWJlcjtcbiAgc3RhcnRUaW1lb3V0TXM/OiBudW1iZXI7XG4gIGdyYWNlZnVsU2h1dGRvd25Ncz86IG51bWJlcjtcbiAgb25TdGF0ZUNoYW5nZT8oc3RhdGU6IEhvc3RTdGF0ZSwgaW5mbzogeyByZXN0YXJ0Q291bnQ6IG51bWJlcjsgbGFzdEVycm9yPzogc3RyaW5nIH0pOiB2b2lkO1xuICAvKiogXHU2QkNGXHU2QjIxIGhvc3QgXHU1QzMxXHU3RUVBKFx1NTQyQiBjcmFzaCBcdTgxRUFcdTYxMDhcdTU0MEVcdTc2ODRcdTkxQ0RcdTU0MkYpXHU5MEZEXHU0RjFBXHU4OUU2XHU1M0QxLFx1NjQzQVx1NUUyNlx1N0FFRlx1NzBCOShcdTU0MkIgdG9rZW4sXG4gICAqICBcdTRFQzVcdTRGOUJcdTU0MENcdTRGRTFcdTRFRkJcdTU3REZcdTc2ODRcdTVCQkZcdTRFM0JcdThGREJcdTdBMEJcdTkxQ0RcdTVFRkFcdTY4NjVcdTVCQTJcdTYyMzdcdTdBRUY7XHU0RTBEXHU4OTgxXHU4REU4XHU4RkRCIHJlbmRlcmVyKVx1MzAwMiAqL1xuICBvblJlYWR5PyhlbmRwb2ludDogSG9zdEVuZHBvaW50KTogdm9pZDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBIb3N0RW5kcG9pbnQge1xuICBwb3J0OiBudW1iZXI7XG4gIHZlcnNpb246IHN0cmluZztcbiAgdG9rZW46IHN0cmluZztcbn1cblxuLyoqIEhvc3RSZWFkeUxpbmUgXHU3Njg0XHU3QzdCXHU1NzhCXHU1Qjg4XHU1MzZCXHU0RUNFIGNvbnRyYWN0cyBcdTVGMTVcdTUxNjUsXHU5MDdGXHU1MTREXHU1M0NDXHU1QjlFXHU3M0IwXHUzMDAyICovXG5pbXBvcnQgeyBpc0hvc3RSZWFkeUxpbmUgfSBmcm9tICdAaG1oLWRlc2t0b3AvY29udHJhY3RzJztcblxuY29uc3QgREVGQVVMVF9TVEFSVF9USU1FT1VUX01TID0gMjBfMDAwO1xuY29uc3QgREVGQVVMVF9NQVhfUkVTVEFSVFMgPSAzO1xuY29uc3QgREVGQVVMVF9HUkFDRUZVTF9NUyA9IDVfMDAwO1xuXG5leHBvcnQgY2xhc3MgRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yIHtcbiAgcHJpdmF0ZSBjaGlsZDogQ2hpbGRQcm9jZXNzIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgX3N0YXRlOiBIb3N0U3RhdGUgPSAnc3RvcHBlZCc7XG4gIHByaXZhdGUgcmVzdGFydENvdW50ID0gMDtcbiAgcHJpdmF0ZSBsYXN0RXJyb3IgPSAnJztcbiAgcHJpdmF0ZSBzdG9wcGluZyA9IGZhbHNlO1xuICBwcml2YXRlIHJlYWRvbmx5IHRva2VuOiBzdHJpbmc7XG4gIHByaXZhdGUgcmVhZG9ubHkgb3B0czogUmVxdWlyZWQ8UGljazxTdXBlcnZpc29yT3B0aW9ucywgJ21heFJlc3RhcnRzJyB8ICdzdGFydFRpbWVvdXRNcycgfCAnZ3JhY2VmdWxTaHV0ZG93bk1zJz4+ICYgU3VwZXJ2aXNvck9wdGlvbnM7XG4gIHByaXZhdGUgZXhpdFdhaXRlcnM6IEFycmF5PCgpID0+IHZvaWQ+ID0gW107XG5cbiAgY29uc3RydWN0b3IoXG4gICAgcHJpdmF0ZSByZWFkb25seSBzcGVjOiBIb3N0U3BlYyxcbiAgICBvcHRzOiBTdXBlcnZpc29yT3B0aW9ucyA9IHt9LFxuICApIHtcbiAgICB0aGlzLnRva2VuID0gb3B0cy50b2tlbiA/PyByYW5kb21CeXRlcygzMikudG9TdHJpbmcoJ2Jhc2U2NHVybCcpO1xuICAgIHRoaXMub3B0cyA9IHtcbiAgICAgIG1heFJlc3RhcnRzOiBvcHRzLm1heFJlc3RhcnRzID8/IERFRkFVTFRfTUFYX1JFU1RBUlRTLFxuICAgICAgc3RhcnRUaW1lb3V0TXM6IG9wdHMuc3RhcnRUaW1lb3V0TXMgPz8gREVGQVVMVF9TVEFSVF9USU1FT1VUX01TLFxuICAgICAgZ3JhY2VmdWxTaHV0ZG93bk1zOiBvcHRzLmdyYWNlZnVsU2h1dGRvd25NcyA/PyBERUZBVUxUX0dSQUNFRlVMX01TLFxuICAgICAgLi4ub3B0cyxcbiAgICB9O1xuICB9XG5cbiAgZ2V0IHN0YXRlKCk6IEhvc3RTdGF0ZSB7XG4gICAgcmV0dXJuIHRoaXMuX3N0YXRlO1xuICB9XG5cbiAgZ2V0IHJlc3RhcnRzVXNlZCgpOiBudW1iZXIge1xuICAgIHJldHVybiB0aGlzLnJlc3RhcnRDb3VudDtcbiAgfVxuXG4gIHByaXZhdGUgc2V0U3RhdGUoczogSG9zdFN0YXRlLCBlcnI/OiBzdHJpbmcpOiB2b2lkIHtcbiAgICB0aGlzLl9zdGF0ZSA9IHM7XG4gICAgaWYgKGVyciAhPT0gdW5kZWZpbmVkKSB0aGlzLmxhc3RFcnJvciA9IGVycjtcbiAgICBjb25zdCBpbmZvOiB7IHJlc3RhcnRDb3VudDogbnVtYmVyOyBsYXN0RXJyb3I/OiBzdHJpbmcgfSA9IHsgcmVzdGFydENvdW50OiB0aGlzLnJlc3RhcnRDb3VudCB9O1xuICAgIGlmICh0aGlzLmxhc3RFcnJvciAhPT0gJycpIGluZm8ubGFzdEVycm9yID0gdGhpcy5sYXN0RXJyb3I7XG4gICAgdGhpcy5vcHRzLm9uU3RhdGVDaGFuZ2U/LihzLCBpbmZvKTtcbiAgfVxuXG4gIC8qKiBcdTU0MkZcdTUyQTggaG9zdCBcdTVFNzZcdTdCNDlcdTVGODUgcmVhZHkoXHU1RjE1XHU1QkZDXHU4ODRDICsgXHU1RTI2IHRva2VuIFx1NzY4NFx1NTA2NVx1NUVCN1x1NjNBMlx1NkQ0QilcdTMwMDIgKi9cbiAgYXN5bmMgc3RhcnQoKTogUHJvbWlzZTxIb3N0RW5kcG9pbnQ+IHtcbiAgICBpZiAodGhpcy5fc3RhdGUgPT09ICdyZWFkeScgfHwgdGhpcy5fc3RhdGUgPT09ICdzdGFydGluZycpIHtcbiAgICAgIHRocm93IGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgc3VwZXJ2aXNvciBhbHJlYWR5ICR7dGhpcy5fc3RhdGV9YCk7XG4gICAgfVxuICAgIHRoaXMucmVzdGFydENvdW50ID0gMDtcbiAgICB0aGlzLnN0b3BwaW5nID0gZmFsc2U7XG4gICAgcmV0dXJuIHRoaXMubGF1bmNoKCk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGxhdW5jaCgpOiBQcm9taXNlPEhvc3RFbmRwb2ludD4ge1xuICAgIHRoaXMuc2V0U3RhdGUoJ3N0YXJ0aW5nJyk7XG4gICAgY29uc3QgY2hpbGQgPSBzcGF3bih0aGlzLnNwZWMuY29tbWFuZCwgdGhpcy5zcGVjLmFyZ3MsIHtcbiAgICAgIGN3ZDogdGhpcy5zcGVjLmN3ZCxcbiAgICAgIGVudjoge1xuICAgICAgICAuLi5wcm9jZXNzLmVudixcbiAgICAgICAgLi4udGhpcy5zcGVjLmVudixcbiAgICAgICAgSE1IX0RFU0tUT1BfVE9LRU46IHRoaXMudG9rZW4sXG4gICAgICB9LFxuICAgICAgc3RkaW86IFsnaWdub3JlJywgJ3BpcGUnLCAncGlwZSddLFxuICAgICAgd2luZG93c0hpZGU6IHRydWUsXG4gICAgfSk7XG4gICAgdGhpcy5jaGlsZCA9IGNoaWxkO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGVuZHBvaW50ID0gYXdhaXQgdGhpcy5hd2FpdFJlYWR5KGNoaWxkKTtcbiAgICAgIHRoaXMuY3VycmVudEVuZHBvaW50ID0geyBwb3J0OiBlbmRwb2ludC5wb3J0LCB2ZXJzaW9uOiBlbmRwb2ludC52ZXJzaW9uIH07XG4gICAgICB0aGlzLnNldFN0YXRlKCdyZWFkeScpO1xuICAgICAgdGhpcy5vcHRzLm9uUmVhZHk/LihlbmRwb2ludCk7XG4gICAgICAvLyByZWFkeSBcdTRFNEJcdTU0MEVcdThGREJcdTdBMEJcdTZCN0JcdTRFQTEgPSBcdTYxMEZcdTU5MTZcdTkwMDBcdTUxRkEgXHUyMTkyIFx1NjcwOVx1OTY1MFx1OTFDRFx1NTQyRlxuICAgICAgY2hpbGQub25jZSgnZXhpdCcsICgpID0+IHtcbiAgICAgICAgdGhpcy5leGl0V2FpdGVycy5mb3JFYWNoKCh3KSA9PiB3KCkpO1xuICAgICAgICB0aGlzLmV4aXRXYWl0ZXJzID0gW107XG4gICAgICAgIHRoaXMub25VbmV4cGVjdGVkRXhpdCgpO1xuICAgICAgfSk7XG4gICAgICByZXR1cm4gZW5kcG9pbnQ7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBpZiAoIWNoaWxkLmtpbGxlZCkgY2hpbGQua2lsbCgpO1xuICAgICAgaWYgKHRoaXMuY2hpbGQgPT09IGNoaWxkKSB0aGlzLmNoaWxkID0gbnVsbDtcbiAgICAgIHRocm93IGVycjtcbiAgICB9XG4gIH1cblxuICAvKiogXHU0RUNFIHN0ZG91dCBcdTYyN0UgSG9zdFJlYWR5TGluZSxcdTcxMzZcdTU0MEVcdTUwNjVcdTVFQjdcdTYzQTJcdTZENEJcdTMwMDIgKi9cbiAgcHJpdmF0ZSBhd2FpdFJlYWR5KGNoaWxkOiBDaGlsZFByb2Nlc3MpOiBQcm9taXNlPEhvc3RFbmRwb2ludD4ge1xuICAgIHJldHVybiBuZXcgUHJvbWlzZTxIb3N0RW5kcG9pbnQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgIHJlamVjdChkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYGhvc3QgZGlkIG5vdCBzaWduYWwgcmVhZHkgd2l0aGluICR7dGhpcy5vcHRzLnN0YXJ0VGltZW91dE1zfW1zYCwgeyByZXRyeWFibGU6IHRydWUsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XG4gICAgICB9LCB0aGlzLm9wdHMuc3RhcnRUaW1lb3V0TXMpO1xuXG4gICAgICBjb25zdCBkb25lID0gKGZuOiAoKSA9PiB2b2lkKTogdm9pZCA9PiB7XG4gICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgIGZuKCk7XG4gICAgICB9O1xuXG4gICAgICBpZiAoIWNoaWxkLnN0ZG91dCkge1xuICAgICAgICBkb25lKCgpID0+IHJlamVjdChkZXNrdG9wRXJyb3IoJ1JVTlRJTUVfQ1JBU0hFRCcsICdob3N0IHNwYXduZWQgd2l0aG91dCBzdGRvdXQgcGlwZScpKSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgY29uc3QgcmwgPSBjcmVhdGVJbnRlcmZhY2UoeyBpbnB1dDogY2hpbGQuc3Rkb3V0IH0pO1xuICAgICAgY29uc3Qgb25MaW5lID0gKGxpbmU6IHN0cmluZyk6IHZvaWQgPT4ge1xuICAgICAgICBsZXQgcGFyc2VkOiB1bmtub3duO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHBhcnNlZCA9IEpTT04ucGFyc2UobGluZSk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIHJldHVybjsgLy8gaG9zdCBcdTc2ODRcdTY2NkVcdTkwMUFcdTY1RTVcdTVGRDdcdTg4NEMsXHU1RkZEXHU3NTY1XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGlzSG9zdFJlYWR5TGluZShwYXJzZWQpKSB7XG4gICAgICAgICAgcmwuY2xvc2UoKTtcbiAgICAgICAgICB2b2lkIHRoaXMucHJvYmVBbmRSZW1lbWJlcihwYXJzZWQucG9ydCwgcGFyc2VkLnZlcnNpb24pXG4gICAgICAgICAgICAudGhlbigoZW5kcG9pbnQpID0+IGRvbmUoKCkgPT4gcmVzb2x2ZShlbmRwb2ludCkpKVxuICAgICAgICAgICAgLmNhdGNoKChlcnI6IHVua25vd24pID0+IGRvbmUoKCkgPT4gcmVqZWN0KGVycikpKTtcbiAgICAgICAgfVxuICAgICAgfTtcbiAgICAgIHJsLm9uKCdsaW5lJywgb25MaW5lKTtcblxuICAgICAgY2hpbGQub25jZSgnZXhpdCcsIChjb2RlKSA9PiB7XG4gICAgICAgIGRvbmUoKCkgPT4gcmVqZWN0KGRlc2t0b3BFcnJvcignUlVOVElNRV9DUkFTSEVEJywgYGhvc3QgZXhpdGVkIGR1cmluZyBzdGFydHVwIChjb2RlICR7Y29kZSA/PyAnbnVsbCd9KWAsIHsgcmV0cnlhYmxlOiBmYWxzZSwgcmVjb3ZlcnlBY3Rpb246ICdPUEVOX0xPR1MnIH0pKSk7XG4gICAgICB9KTtcbiAgICB9KTtcbiAgfVxuXG4gIC8qKiBcdTVFMjYgdG9rZW4gXHU3Njg0XHU1MDY1XHU1RUI3XHU2M0EyXHU2RDRCOkdFVCAvYXBpL3N0YXRlXHUzMDAyNDAxIFx1MjE5MiBBVVRIX0ZBSUxFRChcdTRFMERcdTkxQ0RcdThCRDUpXHUzMDAyICovXG4gIHByaXZhdGUgYXN5bmMgcHJvYmUocG9ydDogbnVtYmVyLCB2ZXJzaW9uOiBzdHJpbmcpOiBQcm9taXNlPEhvc3RFbmRwb2ludD4ge1xuICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgIHRyeSB7XG4gICAgICByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2FwaS9zdGF0ZWAsIHtcbiAgICAgICAgaGVhZGVyczogeyAneC1obWgta2V5JzogdGhpcy50b2tlbiB9LFxuICAgICAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoM18wMDApLFxuICAgICAgfSk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICB0aHJvdyBkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYGhlYWx0aCBwcm9iZSBmYWlsZWQ6ICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTYwKX1gLCB7IHJldHJ5YWJsZTogdHJ1ZSB9KTtcbiAgICB9XG4gICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSB8fCByZXMuc3RhdHVzID09PSA0MDMpIHtcbiAgICAgIHRocm93IGRlc2t0b3BFcnJvcignQVVUSF9GQUlMRUQnLCBgaG9zdCByZWplY3RlZCB0aGUgc2Vzc2lvbiB0b2tlbiAoSFRUUCAke3Jlcy5zdGF0dXN9KWAsIHsgcmV0cnlhYmxlOiBmYWxzZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pO1xuICAgIH1cbiAgICBpZiAoIXJlcy5vaykge1xuICAgICAgdGhyb3cgZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBoZWFsdGggcHJvYmUgSFRUUCAke3Jlcy5zdGF0dXN9YCwgeyByZXRyeWFibGU6IHRydWUgfSk7XG4gICAgfVxuICAgIHJldHVybiB7IHBvcnQsIHZlcnNpb24sIHRva2VuOiB0aGlzLnRva2VuIH07XG4gIH1cblxuICBwcml2YXRlIG9uVW5leHBlY3RlZEV4aXQoKTogdm9pZCB7XG4gICAgaWYgKHRoaXMuc3RvcHBpbmcgfHwgdGhpcy5fc3RhdGUgPT09ICdzdG9wcGVkJyB8fCB0aGlzLl9zdGF0ZSA9PT0gJ3N0b3BwaW5nJykgcmV0dXJuO1xuICAgIHRoaXMuY2hpbGQgPSBudWxsO1xuICAgIGlmICh0aGlzLnJlc3RhcnRDb3VudCA8IHRoaXMub3B0cy5tYXhSZXN0YXJ0cykge1xuICAgICAgdGhpcy5yZXN0YXJ0Q291bnQgKz0gMTtcbiAgICAgIHRoaXMuc2V0U3RhdGUoJ3Jlc3RhcnRpbmcnKTtcbiAgICAgIHZvaWQgdGhpcy5sYXVuY2goKS5jYXRjaCgoKSA9PiB7XG4gICAgICAgIC8vIFx1OTFDRFx1NTQyRlx1NUMxRFx1OEJENVx1NTkzMVx1OEQyNShcdTU0MkZcdTUyQThcdTUzNzNcdTVEMjkvXHU4RDg1XHU2NUY2L1x1NjJEMlx1OEJBNCk6XHU3RUU3XHU3RUVEXHU2RDg4XHU4MDE3XHU5MUNEXHU1NDJGXHU2QjIxXHU2NTcwXHU3NkY0XHU1MjMwXHU2NTNFXHU1RjAzXG4gICAgICAgIHRoaXMucmV0cnlPckZhaWwoKTtcbiAgICAgIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLnNldFN0YXRlKCdmYWlsZWQnLCBgaG9zdCBleGl0ZWQgdW5leHBlY3RlZGx5ICR7dGhpcy5yZXN0YXJ0Q291bnQgKyAxfSB0aW1lczsgZ2l2aW5nIHVwYCk7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSByZXRyeU9yRmFpbCgpOiB2b2lkIHtcbiAgICBpZiAodGhpcy5zdG9wcGluZyB8fCB0aGlzLl9zdGF0ZSA9PT0gJ3N0b3BwZWQnIHx8IHRoaXMuX3N0YXRlID09PSAnc3RvcHBpbmcnKSByZXR1cm47XG4gICAgaWYgKHRoaXMucmVzdGFydENvdW50IDwgdGhpcy5vcHRzLm1heFJlc3RhcnRzKSB7XG4gICAgICB0aGlzLnJlc3RhcnRDb3VudCArPSAxO1xuICAgICAgdGhpcy5zZXRTdGF0ZSgncmVzdGFydGluZycpO1xuICAgICAgdm9pZCB0aGlzLmxhdW5jaCgpLmNhdGNoKCgpID0+IHRoaXMucmV0cnlPckZhaWwoKSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMuc2V0U3RhdGUoJ2ZhaWxlZCcsIGBob3N0IGZhaWxlZCB0byBzdGF5IHVwIGFmdGVyICR7dGhpcy5yZXN0YXJ0Q291bnR9IHJlc3RhcnQgYXR0ZW1wdHNgKTtcbiAgICB9XG4gIH1cblxuICAvKiogXHU0RjE4XHU5NkM1XHU1MDVDXHU2QjYyOlx1NTE0OCBIVFRQIHNodXRkb3duLFx1OEQ4NVx1NjVGNlx1NjI0RFx1NUJGOVx1NjcyQ1x1OEZEQlx1N0EwQlx1NTNFNVx1NjdDNCBraWxsXHUzMDAyICovXG4gIGFzeW5jIHN0b3AoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgdGhpcy5zdG9wcGluZyA9IHRydWU7XG4gICAgaWYgKHRoaXMuX3N0YXRlID09PSAnc3RvcHBlZCcpIHJldHVybjtcbiAgICB0aGlzLnNldFN0YXRlKCdzdG9wcGluZycpO1xuICAgIGNvbnN0IGNoaWxkID0gdGhpcy5jaGlsZDtcbiAgICB0aGlzLmNoaWxkID0gbnVsbDtcbiAgICB0aGlzLmN1cnJlbnRFbmRwb2ludCA9IG51bGw7XG4gICAgaWYgKCFjaGlsZCkge1xuICAgICAgdGhpcy5zZXRTdGF0ZSgnc3RvcHBlZCcpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBleGl0ZWQgPSBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4ge1xuICAgICAgaWYgKGNoaWxkLmV4aXRDb2RlICE9PSBudWxsIHx8IGNoaWxkLnNpZ25hbENvZGUgIT09IG51bGwpIHJlc29sdmUoKTtcbiAgICAgIGVsc2Uge1xuICAgICAgICBjb25zdCB3ID0gKCk6IHZvaWQgPT4gcmVzb2x2ZSgpO1xuICAgICAgICB0aGlzLmV4aXRXYWl0ZXJzLnB1c2godyk7XG4gICAgICAgIGNoaWxkLm9uY2UoJ2V4aXQnLCB3KTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICAvLyBcdTVERjJcdTc3RTVcdTdBRUZcdTUzRTNcdTYyNERcdTVDMURcdThCRDUgSFRUUCBcdTRGMThcdTk2QzVcdTUxNzNcdTk1RUQ7XHU2NzJBXHU3N0U1XHU3QUVGXHU1M0UzXHU3NkY0XHU2M0E1XHU4RDcwIGtpbGwgXHU1MTVDXHU1RTk1XG4gICAgaWYgKHRoaXMubGFzdEVuZHBvaW50ICE9PSBudWxsKSB7XG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3RoaXMubGFzdEVuZHBvaW50fS9hcGkvZGVza3RvcC9zaHV0ZG93bmAsIHtcbiAgICAgICAgICBtZXRob2Q6ICdQT1NUJyxcbiAgICAgICAgICBoZWFkZXJzOiB7ICd4LWhtaC1rZXknOiB0aGlzLnRva2VuIH0sXG4gICAgICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDFfMDAwKSxcbiAgICAgICAgfSk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLy8gaG9zdCBcdTVERjJcdTZCN0JcdTYyMTZcdTRFMERcdTVFOTRcdTdCNTQ6XHU4RDcwIGtpbGwgXHU1MTVDXHU1RTk1XG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IGdyYWNlZnVsID0gYXdhaXQgUHJvbWlzZS5yYWNlKFtcbiAgICAgIGV4aXRlZC50aGVuKCgpID0+IHRydWUpLFxuICAgICAgbmV3IFByb21pc2U8Ym9vbGVhbj4oKHJlc29sdmUpID0+IHNldFRpbWVvdXQoKCkgPT4gcmVzb2x2ZShmYWxzZSksIHRoaXMub3B0cy5ncmFjZWZ1bFNodXRkb3duTXMpKSxcbiAgICBdKTtcbiAgICBpZiAoIWdyYWNlZnVsICYmIGNoaWxkLmV4aXRDb2RlID09PSBudWxsICYmIGNoaWxkLnNpZ25hbENvZGUgPT09IG51bGwpIHtcbiAgICAgIGNoaWxkLmtpbGwoKTsgLy8gXHU1M0VBXHU2NzQwXHU4MUVBXHU1REYxXHU2MzAxXHU2NzA5XHU3Njg0XHU1M0U1XHU2N0M0LFx1N0VERFx1NEUwRFx1NjMwOVx1OEZEQlx1N0EwQlx1NTQwRFxuICAgIH1cbiAgICBhd2FpdCBleGl0ZWQuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcbiAgICB0aGlzLnNldFN0YXRlKCdzdG9wcGVkJyk7XG4gIH1cblxuICBwcml2YXRlIGxhc3RFbmRwb2ludDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgY3VycmVudEVuZHBvaW50OiB7IHBvcnQ6IG51bWJlcjsgdmVyc2lvbjogc3RyaW5nIH0gfCBudWxsID0gbnVsbDtcblxuICAvKiogXHU1RjUzXHU1MjREIGhvc3QgXHU3QUVGXHU3MEI5KHJlYWR5IFx1NTQwRVx1NjcwOVx1NTAzQztcdTRFMERcdTU0MkIgdG9rZW4pXHUzMDAyICovXG4gIGdldCBlbmRwb2ludCgpOiB7IHBvcnQ6IG51bWJlcjsgdmVyc2lvbjogc3RyaW5nIH0gfCBudWxsIHtcbiAgICByZXR1cm4gdGhpcy5jdXJyZW50RW5kcG9pbnQ7XG4gIH1cblxuICAvKiogXHU2M0EyXHU2RDRCXHU2MjEwXHU1MjlGXHU1NDBFXHU4QkIwXHU0RjRGXHU3QUVGXHU1M0UzLFx1NEY5QiBzdG9wKCkgXHU3Njg0XHU0RjE4XHU5NkM1XHU1MTczXHU5NUVEXHU0RjdGXHU3NTI4XHUzMDAyICovXG4gIHByaXZhdGUgYXN5bmMgcHJvYmVBbmRSZW1lbWJlcihwb3J0OiBudW1iZXIsIHZlcnNpb246IHN0cmluZyk6IFByb21pc2U8SG9zdEVuZHBvaW50PiB7XG4gICAgY29uc3QgZXAgPSBhd2FpdCB0aGlzLnByb2JlKHBvcnQsIHZlcnNpb24pO1xuICAgIHRoaXMubGFzdEVuZHBvaW50ID0gZXAucG9ydDtcbiAgICByZXR1cm4gZXA7XG4gIH1cbn1cblxuLyoqIFx1NjI4QVx1NjcyQVx1NzdFNVx1OTUxOVx1OEJFRlx1ODlDNFx1N0VBNlx1NEUzQSBEZXNrdG9wRXJyb3IoXHU1REYyXHU2NjJGXHU1MjE5XHU1MzlGXHU2ODM3XHU4RkQ0XHU1NkRFKVx1MzAwMiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRvRGVza3RvcEVycm9yKGVycjogdW5rbm93bik6IERlc2t0b3BFcnJvciB7XG4gIGlmIChpc0Rlc2t0b3BFcnJvcihlcnIpKSByZXR1cm4gZXJyO1xuICBjb25zdCBtZXNzYWdlID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICByZXR1cm4gZGVza3RvcEVycm9yKCdSVU5USU1FX0NSQVNIRUQnLCBtZXNzYWdlLnNsaWNlKDAsIDMwMCksIHsgcmV0cnlhYmxlOiBmYWxzZSB9KTtcbn1cbiIsICIvKipcbiAqIEBobWgtZGVza3RvcC9jb250cmFjdHMgXHUyMDE0IFx1NEU4Qlx1NEVGNlx1NEZFMVx1NUMwMShcdTVGMDBcdTUzRDFcdThCQTFcdTUyMTJcdTY1ODdcdTY4NjMgMDQgXHUwMEE3XHU0RTA5KVxuICpcbiAqIFx1NEUwMFx1Njc2MSBVSSBcdTRFOEJcdTRFRjZcdTc2ODRcdTU1MkZcdTRFMDBcdTVGNjJcdTcyQjZcdTMwMDJcdTUyNERcdTdBRUYgcmVkdWNlciBcdTVGQzVcdTk4N0JcdTYzMDkgc2Vzc2lvbklkL3J1bklkL3NlcSBcdTU5MDRcdTc0MDY7XG4gKiBcdTkxQ0RcdTU5MEQgZXZlbnRJZCBcdTVFNDJcdTdCNDlcdTRFMjJcdTVGMDM7c2VxIFx1N0YzQVx1NTNFM1x1ODlFNlx1NTNEMVx1ODg2NVx1NjJDOTtcdTk3NUVcdTVFNDJcdTdCNDlcdTUyQThcdTRGNUNcdTRFMERcdTc1MzEgU1NFIFx1ODFFQVx1NTJBOFx1OTFDRFx1NTNEMVx1MzAwMlxuICovXG5cbmltcG9ydCB0eXBlIHsgQXJ0aWZhY3RSZWYgfSBmcm9tICcuL2R0by50cyc7XG5pbXBvcnQgdHlwZSB7IERlc2t0b3BFcnJvciB9IGZyb20gJy4vZXJyb3IudHMnO1xuXG4vKiogXHU0RThCXHU0RUY2XHU3OUNEXHU3QzdCKFx1NTIyNFx1NTIyQlx1OTUyRSlcdTMwMDJcdTY1QjBcdTU4OUUga2luZCA9IHNjaGVtYVZlcnNpb24gXHU1MzQ3XHU3RUE3LFx1NEUwRFx1NTE0MVx1OEJCOFx1OTc1OVx1OUVEOFx1NjI2OVx1Njc5QVx1NEUzRVx1MzAwMiAqL1xuZXhwb3J0IGNvbnN0IEVWRU5UX0tJTkRTID0gW1xuICAncnVuLnN0YXJ0ZWQnLFxuICAncGxhbi51cGRhdGVkJyxcbiAgJ3Rvb2wuc3RhcnRlZCcsXG4gICd0b29sLmNvbXBsZXRlZCcsXG4gICdhcHByb3ZhbC5yZXF1aXJlZCcsXG4gICd2ZXJpZmljYXRpb24udXBkYXRlZCcsXG4gICdhcnRpZmFjdC5jcmVhdGVkJyxcbiAgJ3J1bi5jb21wbGV0ZWQnLFxuICAncnVuLmZhaWxlZCcsXG5dIGFzIGNvbnN0O1xuXG5leHBvcnQgdHlwZSBFdmVudEtpbmQgPSAodHlwZW9mIEVWRU5UX0tJTkRTKVtudW1iZXJdO1xuXG5leHBvcnQgY29uc3QgRVZFTlRfU0NIRU1BX1ZFUlNJT04gPSAxO1xuZXhwb3J0IHR5cGUgRXZlbnRTY2hlbWFWZXJzaW9uID0gMTtcblxuLyoqIFNTRSBcdTZENDFcdTRFMEFcdTc2ODRcdTZCQ0ZcdTRFMDBcdTY3NjFcdTRFOEJcdTRFRjZcdTMwMDIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgRXZlbnRFbnZlbG9wZTxUID0gdW5rbm93bj4ge1xuICBzY2hlbWFWZXJzaW9uOiBFdmVudFNjaGVtYVZlcnNpb247XG4gIC8qKiBcdTUxNjhcdTVDNDBcdTU1MkZcdTRFMDA7XHU5MUNEXHU4RkRFL1x1ODg2NVx1NjJDOVx1NTQwRVx1OTFDRFx1NTkwRFx1NTFGQVx1NzNCMFx1NjVGNlx1NjNBNVx1NjUzNlx1NjVCOVx1NUU0Mlx1N0I0OVx1NEUyMlx1NUYwM1x1MzAwMiAqL1xuICBldmVudElkOiBzdHJpbmc7XG4gIHNlc3Npb25JZDogc3RyaW5nO1xuICBydW5JZDogc3RyaW5nO1xuICAvKiogXHU0RjFBXHU4QkREXHU1MTg1XHU1MzU1XHU4QzAzXHU5MDEyXHU1ODlFO1x1N0YzQVx1NTNFM1x1NjEwRlx1NTQ3M1x1Nzc0MFx1NEUyMlx1NEU4Qlx1NEVGNixcdTk3MDBcdTg5ODFcdTg4NjVcdTYyQzlcdTMwMDIgKi9cbiAgc2VxOiBudW1iZXI7XG4gIC8qKiBSRkMzMzM5XHUzMDAyICovXG4gIG9jY3VycmVkQXQ6IHN0cmluZztcbiAga2luZDogRXZlbnRLaW5kO1xuICBwYXlsb2FkOiBUO1xufVxuXG4vKiogcnVuLnN0YXJ0ZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgUnVuU3RhcnRlZFBheWxvYWQge1xuICB0YXNrOiBzdHJpbmc7XG4gIG1vZGU6ICdhc2snIHwgJ2F1dG8nIHwgJ3lvbG8nO1xufVxuXG4vKiogcGxhbi51cGRhdGVkIFx1NzY4NCBwYXlsb2FkKFx1OEJBMVx1NTIxMlx1NkI2NVx1OUFBNFx1NTIxN1x1ODg2OCxcdTY3NjVcdTgxRUEgcnVudGltZSBcdTc2ODRcdTdFRDNcdTY3ODRcdTUzMTZcdThCQTFcdTUyMTIsXHU0RTBEXHU2NjJGIGNoYWluLW9mLXRob3VnaHQpXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIFBsYW5VcGRhdGVkUGF5bG9hZCB7XG4gIHN0ZXBzOiBBcnJheTx7IHRpdGxlOiBzdHJpbmc7IHN0YXR1czogJ3BlbmRpbmcnIHwgJ2FjdGl2ZScgfCAnZG9uZScgfCAnZmFpbGVkJyB9Pjtcbn1cblxuLyoqIHRvb2wuc3RhcnRlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBUb29sU3RhcnRlZFBheWxvYWQge1xuICBuYW1lOiBzdHJpbmc7XG4gIC8qKiBcdTUzQzJcdTY1NzBcdTRFRTVcdTY1ODdcdTY3MkNcdTU0NDhcdTczQjAsXHU2RTMyXHU2N0QzXHU3QUVGXHU2QzM4XHU0RTBEIGV2YWw7XHU1OTI3XHU1QkY5XHU4QzYxXHU3NTMxIHJ1bnRpbWUgXHU2MjJBXHU2NUFEXHUzMDAyICovXG4gIGFyZ3NQcmV2aWV3OiBzdHJpbmc7XG59XG5cbi8qKiB0b29sLmNvbXBsZXRlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBUb29sQ29tcGxldGVkUGF5bG9hZCB7XG4gIG5hbWU6IHN0cmluZztcbiAgaXNFcnJvcjogYm9vbGVhbjtcbiAgb3V0cHV0UHJldmlldzogc3RyaW5nO1xufVxuXG4vKiogYXBwcm92YWwucmVxdWlyZWQgXHU3Njg0IHBheWxvYWRcdTMwMDJcdTVCQTFcdTYyNzlcdTY3NDNcdTVBMDFcdTU3MjggcnVudGltZSBcdTU0MEVcdTdBRUY7VUkgXHU1M0VBXHU2NjJGXHU4RjZDXHU4RkYwXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcHJvdmFsUmVxdWlyZWRQYXlsb2FkIHtcbiAgYXBwcm92YWxJZDogc3RyaW5nO1xuICB0b29sOiBzdHJpbmc7XG4gIGFyZ3NQcmV2aWV3OiBzdHJpbmc7XG4gIC8qKiBcdTVGNzFcdTU0Q0RcdTgzMDNcdTU2RjQvXHU5OENFXHU5NjY5XHU3Njg0XHU0RUJBXHU3QzdCXHU1M0VGXHU4QkZCXHU4QkY0XHU2NjBFLFx1NzUzMSBydW50aW1lIFx1NzUxRlx1NjIxMFx1MzAwMiAqL1xuICByaXNrOiBzdHJpbmc7XG59XG5cbi8qKiB2ZXJpZmljYXRpb24udXBkYXRlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBWZXJpZmljYXRpb25VcGRhdGVkUGF5bG9hZCB7XG4gIHN1bW1hcnk6IHN0cmluZztcbiAgcGFzc2VkOiBib29sZWFuIHwgbnVsbDsgLy8gbnVsbCA9IFx1NjcyQVx1NzdFNS9cdThGREJcdTg4NENcdTRFMkQoTkVFRFMtREFUQSBcdTY1RjZcdTRFMERcdTUwNDdcdTU4NkIpXG59XG5cbi8qKiBhcnRpZmFjdC5jcmVhdGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIEFydGlmYWN0Q3JlYXRlZFBheWxvYWQge1xuICBhcnRpZmFjdDogQXJ0aWZhY3RSZWY7XG59XG5cbi8qKiBydW4uY29tcGxldGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIFJ1bkNvbXBsZXRlZFBheWxvYWQge1xuICB0ZXh0OiBzdHJpbmc7XG4gIHR1cm5zOiBudW1iZXI7XG4gIHRvb2xVc2VzOiBudW1iZXI7XG4gIHVzYWdlPzogeyBwcm9tcHRUb2tlbnM6IG51bWJlcjsgY29tcGxldGlvblRva2VuczogbnVtYmVyIH07XG59XG5cbi8qKiBydW4uZmFpbGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIFJ1bkZhaWxlZFBheWxvYWQge1xuICBlcnJvcjogRGVza3RvcEVycm9yO1xufVxuIiwgIi8qKlxuICogQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyBcdTIwMTQgXHU3RUQzXHU2Nzg0XHU1MzE2XHU2ODRDXHU5NzYyXHU5NTE5XHU4QkVGKFx1NUYwMFx1NTNEMVx1OEJBMVx1NTIxMlx1NjU4N1x1Njg2MyAwNCBcdTAwQTdcdTRFMDkpXHUzMDAyXG4gKlxuICogaG9zdC1ub3QtcmVhZHkgLyBhdXRoLWZhaWxlZCAvIHN0YWxlLXZlcnNpb24gLyBydW50aW1lLWNyYXNoZWQgL1xuICogcG9ydC1iaW5kLWZhaWxlZCAvIHNjaGVtYS1taXNtYXRjaCBcdTVGQzVcdTk4N0JcdTY2MkZcdTdFRDNcdTY3ODRcdTUzMTZcdTk1MTlcdThCRUZcdTc4MDEsXHU1RTc2XHU2M0QwXHU0RjlCXHU0RTBCXHU0RTAwXHU2QjY1XHU1MkE4XHU0RjVDXHUzMDAyXG4gKiBtZXNzYWdlIFx1NjYyRlx1N0VBRlx1NjU4N1x1NjcyQyxcdTZFMzJcdTY3RDNcdTdBRUZcdTZDMzhcdTRFMERcdTYyOEFcdTVCODNcdTVGNTMgSFRNTFx1MzAwMlxuICovXG5leHBvcnQgY29uc3QgRVJST1JfQ09ERVMgPSBbXG4gICdIT1NUX05PVF9SRUFEWScsXG4gICdBVVRIX0ZBSUxFRCcsXG4gICdSVU5USU1FX0NSQVNIRUQnLFxuICAnUE9SVF9CSU5EX0ZBSUxFRCcsXG4gICdTVEFMRV9WRVJTSU9OJyxcbiAgJ1NDSEVNQV9NSVNNQVRDSCcsXG5dIGFzIGNvbnN0O1xuXG5leHBvcnQgdHlwZSBFcnJvckNvZGUgPSAodHlwZW9mIEVSUk9SX0NPREVTKVtudW1iZXJdO1xuXG5leHBvcnQgY29uc3QgUkVDT1ZFUllfQUNUSU9OUyA9IFsnUkVDT05ORUNUJywgJ1JFU1VNRScsICdFWFBPUlQnLCAnT1BFTl9MT0dTJ10gYXMgY29uc3Q7XG5leHBvcnQgdHlwZSBSZWNvdmVyeUFjdGlvbiA9ICh0eXBlb2YgUkVDT1ZFUllfQUNUSU9OUylbbnVtYmVyXTtcblxuZXhwb3J0IGludGVyZmFjZSBEZXNrdG9wRXJyb3Ige1xuICBjb2RlOiBFcnJvckNvZGU7XG4gIC8qKiBcdTdFQUZcdTY1ODdcdTY3MkMsXHU2QzM4XHU0RTBEXHU0RkUxXHU0RUZCXHU0RTNBIEhUTUxcdTMwMDIgKi9cbiAgbWVzc2FnZTogc3RyaW5nO1xuICByZXRyeWFibGU6IGJvb2xlYW47XG4gIHNlc3Npb25JZD86IHN0cmluZztcbiAgcnVuSWQ/OiBzdHJpbmc7XG4gIHJlY292ZXJ5QWN0aW9uPzogUmVjb3ZlcnlBY3Rpb247XG59XG5cbi8qKiBcdTY3ODRcdTkwMjBcdTRFMDBcdTRFMkEgRGVza3RvcEVycm9yKGV4YWN0T3B0aW9uYWxQcm9wZXJ0eVR5cGVzIFx1NTNDQlx1NTk3RClcdTMwMDIgKi9cbmV4cG9ydCBmdW5jdGlvbiBkZXNrdG9wRXJyb3IoXG4gIGNvZGU6IEVycm9yQ29kZSxcbiAgbWVzc2FnZTogc3RyaW5nLFxuICBvcHRzOiB7IHJldHJ5YWJsZT86IGJvb2xlYW47IHNlc3Npb25JZD86IHN0cmluZzsgcnVuSWQ/OiBzdHJpbmc7IHJlY292ZXJ5QWN0aW9uPzogUmVjb3ZlcnlBY3Rpb24gfSA9IHt9LFxuKTogRGVza3RvcEVycm9yIHtcbiAgY29uc3QgZTogRGVza3RvcEVycm9yID0geyBjb2RlLCBtZXNzYWdlLCByZXRyeWFibGU6IG9wdHMucmV0cnlhYmxlID09PSB0cnVlIH07XG4gIGlmIChvcHRzLnNlc3Npb25JZCAhPT0gdW5kZWZpbmVkKSBlLnNlc3Npb25JZCA9IG9wdHMuc2Vzc2lvbklkO1xuICBpZiAob3B0cy5ydW5JZCAhPT0gdW5kZWZpbmVkKSBlLnJ1bklkID0gb3B0cy5ydW5JZDtcbiAgaWYgKG9wdHMucmVjb3ZlcnlBY3Rpb24gIT09IHVuZGVmaW5lZCkgZS5yZWNvdmVyeUFjdGlvbiA9IG9wdHMucmVjb3ZlcnlBY3Rpb247XG4gIHJldHVybiBlO1xufVxuIiwgIi8qKlxuICogQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyBcdTIwMTQgcnVudGltZSBcdTY4MjFcdTlBOEMoZ3VhcmRzKVx1MzAwMlxuICpcbiAqIFx1NkJDRlx1NEUyQVx1OERFOFx1NEZFMVx1NEVGQlx1OEZCOVx1NzU0Q1x1NzY4NFx1NjU3MFx1NjM2RShydW50aW1lXHUyMTkycmVuZGVyZXJcdTMwMDFob3N0XHUyMTkybWFpbilcdThGREJcdTUxNjVcdTUyNERcdTUxNDhcdThGQzcgZ3VhcmQ7XG4gKiBcdTY4MjFcdTlBOENcdTU5MzFcdThEMjVcdTc2ODRcdTY1NzBcdTYzNkVcdTYzMDkgU0NIRU1BX01JU01BVENIIFx1N0VEM1x1Njc4NFx1NTMxNlx1OTUxOVx1OEJFRlx1NTkwNFx1NzQwNixcdTRFMERcdTk3NTlcdTlFRDhcdTYzQTVcdTUzRDdcdTMwMDJcbiAqIFx1NjI0Qlx1NTE5OVx1NUI4OFx1NTM2Qlx1ODAwQ1x1NEUwRFx1NjYyRlx1NUYxNVx1N0IyQ1x1NEUwOVx1NjVCOSBzY2hlbWEgXHU1RTkzOlx1NTk1MVx1N0VBNlx1OTc2Mlx1NUMwRixcdTk2RjZcdTRGOURcdThENTZcdTY1ODdcdTUzMTYoaG1oYXJuZXNzIFx1NTQwQ1x1NkU5MClcdTMwMDJcbiAqL1xuaW1wb3J0IHtcbiAgRVZFTlRfS0lORFMsXG4gIEVWRU5UX1NDSEVNQV9WRVJTSU9OLFxuICB0eXBlIEV2ZW50RW52ZWxvcGUsXG4gIHR5cGUgRXZlbnRLaW5kLFxufSBmcm9tICcuL2V2ZW50LnRzJztcbmltcG9ydCB7IEVSUk9SX0NPREVTLCBSRUNPVkVSWV9BQ1RJT05TLCB0eXBlIERlc2t0b3BFcnJvciB9IGZyb20gJy4vZXJyb3IudHMnO1xuaW1wb3J0IHsgUlVOX1NUQVRVU0VTLCB0eXBlIFJ1blN0YXR1cyB9IGZyb20gJy4vZHRvLnRzJztcblxuY29uc3QgaXNSZWNvcmQgPSAodjogdW5rbm93bik6IHYgaXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPT5cbiAgdHlwZW9mIHYgPT09ICdvYmplY3QnICYmIHYgIT09IG51bGwgJiYgIUFycmF5LmlzQXJyYXkodik7XG5cbmNvbnN0IGlzTm9uRW1wdHlTdHJpbmcgPSAodjogdW5rbm93bik6IHYgaXMgc3RyaW5nID0+IHR5cGVvZiB2ID09PSAnc3RyaW5nJyAmJiB2Lmxlbmd0aCA+IDA7XG5cbmNvbnN0IGlzUmZjMzMzOSA9ICh2OiBzdHJpbmcpOiBib29sZWFuID0+IHtcbiAgY29uc3QgdCA9IERhdGUucGFyc2Uodik7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUodCkgJiYgL1xcZHs0fS1cXGR7Mn0tXFxkezJ9VC8udGVzdCh2KTtcbn07XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0V2ZW50RW52ZWxvcGUodjogdW5rbm93bik6IHYgaXMgRXZlbnRFbnZlbG9wZSB7XG4gIGlmICghaXNSZWNvcmQodikpIHJldHVybiBmYWxzZTtcbiAgaWYgKHYuc2NoZW1hVmVyc2lvbiAhPT0gRVZFTlRfU0NIRU1BX1ZFUlNJT04pIHJldHVybiBmYWxzZTtcbiAgaWYgKCFpc05vbkVtcHR5U3RyaW5nKHYuZXZlbnRJZCkpIHJldHVybiBmYWxzZTtcbiAgaWYgKCFpc05vbkVtcHR5U3RyaW5nKHYuc2Vzc2lvbklkKSkgcmV0dXJuIGZhbHNlO1xuICBpZiAoIWlzTm9uRW1wdHlTdHJpbmcodi5ydW5JZCkpIHJldHVybiBmYWxzZTtcbiAgaWYgKHR5cGVvZiB2LnNlcSAhPT0gJ251bWJlcicgfHwgIU51bWJlci5pc0ludGVnZXIodi5zZXEpIHx8IHYuc2VxIDwgMCkgcmV0dXJuIGZhbHNlO1xuICBpZiAoIWlzTm9uRW1wdHlTdHJpbmcodi5vY2N1cnJlZEF0KSB8fCAhaXNSZmMzMzM5KHYub2NjdXJyZWRBdCkpIHJldHVybiBmYWxzZTtcbiAgaWYgKCFFVkVOVF9LSU5EUy5pbmNsdWRlcyh2LmtpbmQgYXMgRXZlbnRLaW5kKSkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gaXNSZWNvcmQodi5wYXlsb2FkKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzRGVza3RvcEVycm9yKHY6IHVua25vd24pOiB2IGlzIERlc2t0b3BFcnJvciB7XG4gIGlmICghaXNSZWNvcmQodikpIHJldHVybiBmYWxzZTtcbiAgaWYgKCFFUlJPUl9DT0RFUy5pbmNsdWRlcyh2LmNvZGUgYXMgbmV2ZXIpKSByZXR1cm4gZmFsc2U7XG4gIGlmICh0eXBlb2Ygdi5tZXNzYWdlICE9PSAnc3RyaW5nJykgcmV0dXJuIGZhbHNlO1xuICBpZiAodHlwZW9mIHYucmV0cnlhYmxlICE9PSAnYm9vbGVhbicpIHJldHVybiBmYWxzZTtcbiAgaWYgKHYuc2Vzc2lvbklkICE9PSB1bmRlZmluZWQgJiYgIWlzTm9uRW1wdHlTdHJpbmcodi5zZXNzaW9uSWQpKSByZXR1cm4gZmFsc2U7XG4gIGlmICh2LnJ1bklkICE9PSB1bmRlZmluZWQgJiYgIWlzTm9uRW1wdHlTdHJpbmcodi5ydW5JZCkpIHJldHVybiBmYWxzZTtcbiAgaWYgKHYucmVjb3ZlcnlBY3Rpb24gIT09IHVuZGVmaW5lZCAmJiAhUkVDT1ZFUllfQUNUSU9OUy5pbmNsdWRlcyh2LnJlY292ZXJ5QWN0aW9uIGFzIG5ldmVyKSkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzUnVuU3RhdHVzKHY6IHVua25vd24pOiB2IGlzIFJ1blN0YXR1cyB7XG4gIHJldHVybiB0eXBlb2YgdiA9PT0gJ3N0cmluZycgJiYgUlVOX1NUQVRVU0VTLmluY2x1ZGVzKHYgYXMgUnVuU3RhdHVzKTtcbn1cblxuLyoqIEhvc3QgXHU1RjE1XHU1QkZDXHU4ODRDKHN0ZG91dCBcdTdCMkNcdTRFMDBcdTg4NEMpXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gaXNIb3N0UmVhZHlMaW5lKHY6IHVua25vd24pOiB2IGlzIHsgaG1oRGVza3RvcEhvc3RSZWFkeTogdHJ1ZTsgcG9ydDogbnVtYmVyOyB2ZXJzaW9uOiBzdHJpbmcgfSB7XG4gIGlmICghaXNSZWNvcmQodikpIHJldHVybiBmYWxzZTtcbiAgaWYgKHYuaG1oRGVza3RvcEhvc3RSZWFkeSAhPT0gdHJ1ZSkgcmV0dXJuIGZhbHNlO1xuICBpZiAodHlwZW9mIHYucG9ydCAhPT0gJ251bWJlcicgfHwgIU51bWJlci5pc0ludGVnZXIodi5wb3J0KSB8fCB2LnBvcnQgPD0gMCB8fCB2LnBvcnQgPiA2NTUzNSkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gaXNOb25FbXB0eVN0cmluZyh2LnZlcnNpb24pO1xufVxuIiwgIi8qKlxuICogRGVza3RvcEhvc3RDbGllbnQgXHUyMDE0IFx1NUJGOSBobWggaG9zdCBcdTc2ODQgSFRUUCtTU0UgXHU1QkEyXHU2MjM3XHU3QUVGXHUzMDAyXG4gKlxuICogLSBcdTZCQ0ZcdTRFMkEgSFRUUCBcdThCRjdcdTZDNDJcdTgxRUFcdTUyQThcdTVFMjYgWC1IbWgtS2V5KHRva2VuIFx1NEUwRFx1OEZEQiBVUkwpO1xuICogLSBcdTdFRDNcdTY3ODRcdTUzMTZcdTk1MTlcdThCRUYocmVzLmJvZHkgXHU5MUNDXHU3Njg0IERlc2t0b3BFcnJvciBcdTVGNjJcdTcyQjZcdTYyMTYgSFRUUCBcdTcyQjZcdTYwMDEpXHU4OUM0XHU3RUE2XHU2MjEwXHU1RjAyXHU1RTM4XHU2MjlCXHU1MUZBO1xuICogLSBTU0UgXHU3NTI4IGZldGNoIFx1NkQ0MVx1NjI0Qlx1NTE5OVx1ODlFM1x1Njc5MChpZC9ldmVudC9kYXRhIFx1NUUyNyksXHU2NTJGXHU2MzAxIExhc3QtRXZlbnQtSUQgXHU4ODY1XHU2MkM5XHU5MUNEXHU4RkRFXHUzMDAyXG4gKi9cbmltcG9ydCB7IGRlc2t0b3BFcnJvciwgaXNEZXNrdG9wRXJyb3IsIGlzRXZlbnRFbnZlbG9wZSwgdHlwZSBEZXNrdG9wRXJyb3IsIHR5cGUgRXZlbnRFbnZlbG9wZSB9IGZyb20gJ0BobWgtZGVza3RvcC9jb250cmFjdHMnO1xuXG5leHBvcnQgaW50ZXJmYWNlIFNzZUZyYW1lIHtcbiAgaWQ/OiBzdHJpbmc7XG4gIGV2ZW50OiBzdHJpbmc7XG4gIGRhdGE6IHN0cmluZztcbn1cblxuLyoqIFx1ODlFM1x1Njc5MFx1NEUwMFx1NkJCNSBTU0UgXHU2NTg3XHU2NzJDXHU0RTNBXHU1RTI3KFx1NEUwRFx1NTQyQlx1OERFOCBjaHVuayBcdTc2ODRcdTdGMTNcdTUxQjJcdTkwM0JcdThGOTEsXHU3RUFGXHU1MUZEXHU2NTcwXHU0RkJGXHU0RThFXHU2RDRCXHU4QkQ1KVx1MzAwMiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlU3NlQ2h1bmsoY2h1bms6IHN0cmluZyk6IFNzZUZyYW1lW10ge1xuICBjb25zdCBmcmFtZXM6IFNzZUZyYW1lW10gPSBbXTtcbiAgZm9yIChjb25zdCBibG9jayBvZiBjaHVuay5zcGxpdCgvXFxuXFxuLykpIHtcbiAgICBpZiAoIWJsb2NrLnRyaW0oKSkgY29udGludWU7XG4gICAgbGV0IGlkOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gICAgbGV0IGV2ZW50ID0gJ21lc3NhZ2UnO1xuICAgIGNvbnN0IGRhdGFMaW5lczogc3RyaW5nW10gPSBbXTtcbiAgICBsZXQgc2F3RmllbGQgPSBmYWxzZTtcbiAgICBmb3IgKGNvbnN0IGxpbmUgb2YgYmxvY2suc3BsaXQoJ1xcbicpKSB7XG4gICAgICBpZiAobGluZS5zdGFydHNXaXRoKCc6JykpIGNvbnRpbnVlOyAvLyBcdTZDRThcdTkxQ0EvXHU1RkMzXHU4REYzXG4gICAgICBpZiAobGluZS5zdGFydHNXaXRoKCdpZDonKSkgeyBpZCA9IGxpbmUuc2xpY2UoMykudHJpbSgpOyBzYXdGaWVsZCA9IHRydWU7IH1cbiAgICAgIGVsc2UgaWYgKGxpbmUuc3RhcnRzV2l0aCgnZXZlbnQ6JykpIHsgZXZlbnQgPSBsaW5lLnNsaWNlKDYpLnRyaW0oKTsgc2F3RmllbGQgPSB0cnVlOyB9XG4gICAgICBlbHNlIGlmIChsaW5lLnN0YXJ0c1dpdGgoJ2RhdGE6JykpIHsgZGF0YUxpbmVzLnB1c2gobGluZS5zbGljZSg1KS5yZXBsYWNlKC9eIC8sICcnKSk7IHNhd0ZpZWxkID0gdHJ1ZTsgfVxuICAgIH1cbiAgICBpZiAoIXNhd0ZpZWxkKSBjb250aW51ZTsgLy8gXHU3RUFGXHU2Q0U4XHU5MUNBL1x1NUZDM1x1OERGM1x1NTc1N1x1NEUwRFx1NEVBN1x1NzUxRlx1NUUyN1xuICAgIGZyYW1lcy5wdXNoKHsgLi4uKGlkICE9PSB1bmRlZmluZWQgPyB7IGlkIH0gOiB7fSksIGV2ZW50LCBkYXRhOiBkYXRhTGluZXMuam9pbignXFxuJykgfSk7XG4gIH1cbiAgcmV0dXJuIGZyYW1lcztcbn1cblxuLyoqIFx1NEVDRSBTU0UgXHU1RTI3XHU2NTcwXHU2MzZFXHU0RTJEXHU4OUUzXHU1MUZBXHU1NDA4XHU2Q0Q1IEV2ZW50RW52ZWxvcGU7XHU0RTBEXHU1NDA4XHU2Q0Q1XHU3Njg0XHU4RkQ0XHU1NkRFIG51bGwoU0NIRU1BX01JU01BVENIIFx1NzUzMVx1OEMwM1x1NzUyOFx1NjVCOVx1OEJBMVx1NjU3MClcdTMwMDIgKi9cbmV4cG9ydCBmdW5jdGlvbiBlbnZlbG9wZUZyb21GcmFtZShmcmFtZTogU3NlRnJhbWUpOiBFdmVudEVudmVsb3BlIHwgbnVsbCB7XG4gIGlmIChmcmFtZS5ldmVudCAhPT0gJ2htaCcpIHJldHVybiBudWxsOyAvLyBcdTYyMTFcdTRFRUNcdTc2ODRcdTRFOEJcdTRFRjZcdTRGRTFcdTVDMDFcdTdFREZcdTRFMDBcdThENzAgZXZlbnQ6IGhtaFxuICB0cnkge1xuICAgIGNvbnN0IHBhcnNlZDogdW5rbm93biA9IEpTT04ucGFyc2UoZnJhbWUuZGF0YSk7XG4gICAgcmV0dXJuIGlzRXZlbnRFbnZlbG9wZShwYXJzZWQpID8gcGFyc2VkIDogbnVsbDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuZXhwb3J0IGNsYXNzIERlc2t0b3BIdHRwRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKHB1YmxpYyByZWFkb25seSBkZXRhaWw6IERlc2t0b3BFcnJvcikge1xuICAgIHN1cGVyKGRldGFpbC5tZXNzYWdlKTtcbiAgfVxufVxuXG5leHBvcnQgY2xhc3MgRGVza3RvcEhvc3RDbGllbnQge1xuICBjb25zdHJ1Y3RvcihcbiAgICBwcml2YXRlIHJlYWRvbmx5IGJhc2VVcmw6IHN0cmluZyxcbiAgICBwcml2YXRlIHJlYWRvbmx5IHRva2VuOiBzdHJpbmcsXG4gICkge31cblxuICBwcml2YXRlIGhlYWRlcnMoZXh0cmE6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fSk6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4ge1xuICAgIHJldHVybiB7ICd4LWhtaC1rZXknOiB0aGlzLnRva2VuLCAuLi5leHRyYSB9O1xuICB9XG5cbiAgYXN5bmMgZ2V0SnNvbjxUPihwYXRoOiBzdHJpbmcsIHRpbWVvdXRNcyA9IDVfMDAwKTogUHJvbWlzZTxUPiB7XG4gICAgbGV0IHJlczogUmVzcG9uc2U7XG4gICAgdHJ5IHtcbiAgICAgIHJlcyA9IGF3YWl0IGZldGNoKGAke3RoaXMuYmFzZVVybH0ke3BhdGh9YCwgeyBoZWFkZXJzOiB0aGlzLmhlYWRlcnMoKSwgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KHRpbWVvdXRNcykgfSk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYHJlcXVlc3QgZmFpbGVkOiAke1N0cmluZyhlcnIpLnNsaWNlKDAsIDE2MCl9YCwgeyByZXRyeWFibGU6IHRydWUsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XG4gICAgfVxuICAgIHJldHVybiB0aGlzLnBhcnNlUmVzcG9uc2U8VD4ocmVzKTtcbiAgfVxuXG4gIC8qKiBcdTYyQzlcdTUzRDZcdTdFQUZcdTY1ODdcdTY3MkNcdTdBRUZcdTcwQjkoXHU1OTgyIC9hcGkvc2Vzc2lvbnMvOmlkL2V4cG9ydC5tZClcdTMwMDIgKi9cbiAgYXN5bmMgZ2V0VGV4dChwYXRoOiBzdHJpbmcsIHRpbWVvdXRNcyA9IDEwXzAwMCk6IFByb21pc2U8c3RyaW5nPiB7XG4gICAgbGV0IHJlczogUmVzcG9uc2U7XG4gICAgdHJ5IHtcbiAgICAgIHJlcyA9IGF3YWl0IGZldGNoKGAke3RoaXMuYmFzZVVybH0ke3BhdGh9YCwgeyBoZWFkZXJzOiB0aGlzLmhlYWRlcnMoKSwgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KHRpbWVvdXRNcykgfSk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYHJlcXVlc3QgZmFpbGVkOiAke1N0cmluZyhlcnIpLnNsaWNlKDAsIDE2MCl9YCwgeyByZXRyeWFibGU6IHRydWUsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XG4gICAgfVxuICAgIGlmIChyZXMuc3RhdHVzID09PSA0MDEgfHwgcmVzLnN0YXR1cyA9PT0gNDAzKSB7XG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgYGhvc3QgcmVqZWN0ZWQgdGhlIHNlc3Npb24gdG9rZW4gKEhUVFAgJHtyZXMuc3RhdHVzfSlgLCB7IHJldHJ5YWJsZTogZmFsc2UsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XG4gICAgfVxuICAgIGlmICghcmVzLm9rKSB7XG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYEhUVFAgJHtyZXMuc3RhdHVzfWAsIHsgcmV0cnlhYmxlOiByZXMuc3RhdHVzID49IDUwMCB9KSk7XG4gICAgfVxuICAgIHJldHVybiByZXMudGV4dCgpO1xuICB9XG5cbiAgYXN5bmMgcG9zdEpzb248VD4ocGF0aDogc3RyaW5nLCBib2R5OiB1bmtub3duLCB0aW1lb3V0TXMgPSAxMF8wMDApOiBQcm9taXNlPFQ+IHtcbiAgICBsZXQgcmVzOiBSZXNwb25zZTtcbiAgICB0cnkge1xuICAgICAgcmVzID0gYXdhaXQgZmV0Y2goYCR7dGhpcy5iYXNlVXJsfSR7cGF0aH1gLCB7XG4gICAgICAgIG1ldGhvZDogJ1BPU1QnLFxuICAgICAgICBoZWFkZXJzOiB0aGlzLmhlYWRlcnMoeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nIH0pLFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KSxcbiAgICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KHRpbWVvdXRNcyksXG4gICAgICB9KTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgcmVxdWVzdCBmYWlsZWQ6ICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTYwKX1gLCB7IHJldHJ5YWJsZTogdHJ1ZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcbiAgICB9XG4gICAgcmV0dXJuIHRoaXMucGFyc2VSZXNwb25zZTxUPihyZXMpO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBwYXJzZVJlc3BvbnNlPFQ+KHJlczogUmVzcG9uc2UpOiBQcm9taXNlPFQ+IHtcbiAgICBpZiAocmVzLnN0YXR1cyA9PT0gNDAxIHx8IHJlcy5zdGF0dXMgPT09IDQwMykge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdBVVRIX0ZBSUxFRCcsIGBob3N0IHJlamVjdGVkIHRoZSBzZXNzaW9uIHRva2VuIChIVFRQICR7cmVzLnN0YXR1c30pYCwgeyByZXRyeWFibGU6IGZhbHNlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICBjb25zdCB0ZXh0ID0gYXdhaXQgcmVzLnRleHQoKTtcbiAgICBsZXQgcGFyc2VkOiB1bmtub3duID0gbnVsbDtcbiAgICB0cnkge1xuICAgICAgcGFyc2VkID0gdGV4dCA/IEpTT04ucGFyc2UodGV4dCkgOiBudWxsO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcGFyc2VkID0gbnVsbDtcbiAgICB9XG4gICAgaWYgKCFyZXMub2spIHtcbiAgICAgIGlmIChpc0Rlc2t0b3BFcnJvcihwYXJzZWQpKSB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihwYXJzZWQpO1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBIVFRQICR7cmVzLnN0YXR1c306ICR7dGV4dC5zbGljZSgwLCAxNjApfWAsIHsgcmV0cnlhYmxlOiByZXMuc3RhdHVzID49IDUwMCB9KSk7XG4gICAgfVxuICAgIHJldHVybiBwYXJzZWQgYXMgVDtcbiAgfVxuXG4gIC8qKlxuICAgKiBcdThCQTJcdTk2MDVcdTUxNjhcdTkwRTggU1NFIFx1NUUyNyhcdTU0MkJcdTk3NUVcdTRGRTFcdTVDMDFcdTRFOEJcdTRFRjY6ZGVsdGEvbGluZSBcdTdCNDlcdTlBRDhcdTk4OTFcdTZENDEpXHUzMDAyXHU0RkUxXHU1QzAxXHU3NTMxXHU4QzAzXHU3NTI4XHU2NUI5XG4gICAqIFx1NzUyOCBlbnZlbG9wZUZyb21GcmFtZSBcdTgxRUFcdTg4NENcdTUyMDZcdTZENDE7XHU2NUFEXHU3RUJGXHU5MUNEXHU4RkRFXHU4QkVEXHU0RTQ5XHU1NDBDIGV2ZW50cygpXHUzMDAyXG4gICAqL1xuICBhc3luYyAqcmF3RXZlbnRzKGxhc3RFdmVudElkPzogc3RyaW5nLCBzaWduYWw/OiBBYm9ydFNpZ25hbCk6IEFzeW5jR2VuZXJhdG9yPFNzZUZyYW1lPiB7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYCR7dGhpcy5iYXNlVXJsfS9hcGkvZXZlbnRzYCwge1xuICAgICAgaGVhZGVyczogdGhpcy5oZWFkZXJzKHtcbiAgICAgICAgYWNjZXB0OiAndGV4dC9ldmVudC1zdHJlYW0nLFxuICAgICAgICAuLi4obGFzdEV2ZW50SWQgIT09IHVuZGVmaW5lZCA/IHsgJ2xhc3QtZXZlbnQtaWQnOiBsYXN0RXZlbnRJZCB9IDoge30pLFxuICAgICAgfSksXG4gICAgICAuLi4oc2lnbmFsICE9PSB1bmRlZmluZWQgPyB7IHNpZ25hbCB9IDoge30pLFxuICAgIH0pO1xuICAgIGlmIChyZXMuc3RhdHVzID09PSA0MDEgfHwgcmVzLnN0YXR1cyA9PT0gNDAzKSB7XG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgYGhvc3QgcmVqZWN0ZWQgdGhlIHNlc3Npb24gdG9rZW4gKEhUVFAgJHtyZXMuc3RhdHVzfSlgLCB7IHJldHJ5YWJsZTogZmFsc2UsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XG4gICAgfVxuICAgIGlmICghcmVzLm9rIHx8IHJlcy5ib2R5ID09PSBudWxsKSB7XG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYFNTRSBIVFRQICR7cmVzLnN0YXR1c31gLCB7IHJldHJ5YWJsZTogdHJ1ZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcbiAgICB9XG4gICAgY29uc3QgcmVhZGVyID0gcmVzLmJvZHkuZ2V0UmVhZGVyKCk7XG4gICAgY29uc3QgZGVjb2RlciA9IG5ldyBUZXh0RGVjb2RlcigpO1xuICAgIGxldCBidWZmZXIgPSAnJztcbiAgICBmb3IgKDs7KSB7XG4gICAgICBjb25zdCB7IGRvbmUsIHZhbHVlIH0gPSBhd2FpdCByZWFkZXIucmVhZCgpO1xuICAgICAgaWYgKGRvbmUpIHJldHVybjtcbiAgICAgIGJ1ZmZlciArPSBkZWNvZGVyLmRlY29kZSh2YWx1ZSwgeyBzdHJlYW06IHRydWUgfSk7XG4gICAgICBsZXQgaWR4OiBudW1iZXI7XG4gICAgICB3aGlsZSAoKGlkeCA9IGJ1ZmZlci5pbmRleE9mKCdcXG5cXG4nKSkgIT09IC0xKSB7XG4gICAgICAgIGNvbnN0IGJsb2NrID0gYnVmZmVyLnNsaWNlKDAsIGlkeCk7XG4gICAgICAgIGJ1ZmZlciA9IGJ1ZmZlci5zbGljZShpZHggKyAyKTtcbiAgICAgICAgZm9yIChjb25zdCBmcmFtZSBvZiBwYXJzZVNzZUNodW5rKGJsb2NrKSkgeWllbGQgZnJhbWU7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFx1OEJBMlx1OTYwNSBTU0UgXHU0RThCXHU0RUY2XHU2RDQxKGFzeW5jIGl0ZXJhdG9yKVx1MzAwMlx1NjVBRFx1N0VCRlx1NzUzMVx1OEMwM1x1NzUyOFx1NjVCOVx1OTFDRFx1OEZERTtcdTkxQ0RcdThGREVcdTY1RjZcdTYyOEFcdTY3MDBcdTU0MEVcbiAgICogXHU2NTM2XHU1MjMwXHU3Njg0IGV2ZW50SWQgXHU0RjIwXHU1MTY1IGxhc3RFdmVudElkLGhvc3QgXHU3QUVGXHU0RUNFXHU5MUNEXHU2NTNFXHU3M0FGXHU4ODY1XHU1M0QxXHUzMDAyXG4gICAqL1xuICBhc3luYyAqZXZlbnRzKGxhc3RFdmVudElkPzogc3RyaW5nLCBzaWduYWw/OiBBYm9ydFNpZ25hbCk6IEFzeW5jR2VuZXJhdG9yPEV2ZW50RW52ZWxvcGU+IHtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgJHt0aGlzLmJhc2VVcmx9L2FwaS9ldmVudHNgLCB7XG4gICAgICBoZWFkZXJzOiB0aGlzLmhlYWRlcnMoe1xuICAgICAgICBhY2NlcHQ6ICd0ZXh0L2V2ZW50LXN0cmVhbScsXG4gICAgICAgIC4uLihsYXN0RXZlbnRJZCAhPT0gdW5kZWZpbmVkID8geyAnbGFzdC1ldmVudC1pZCc6IGxhc3RFdmVudElkIH0gOiB7fSksXG4gICAgICB9KSxcbiAgICAgIC4uLihzaWduYWwgIT09IHVuZGVmaW5lZCA/IHsgc2lnbmFsIH0gOiB7fSksXG4gICAgfSk7XG4gICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSB8fCByZXMuc3RhdHVzID09PSA0MDMpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignQVVUSF9GQUlMRUQnLCBgaG9zdCByZWplY3RlZCB0aGUgc2Vzc2lvbiB0b2tlbiAoSFRUUCAke3Jlcy5zdGF0dXN9KWAsIHsgcmV0cnlhYmxlOiBmYWxzZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcbiAgICB9XG4gICAgaWYgKCFyZXMub2sgfHwgIXJlcy5ib2R5KSB7XG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYFNTRSBIVFRQICR7cmVzLnN0YXR1c31gLCB7IHJldHJ5YWJsZTogdHJ1ZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcbiAgICB9XG4gICAgY29uc3QgcmVhZGVyID0gcmVzLmJvZHkuZ2V0UmVhZGVyKCk7XG4gICAgY29uc3QgZGVjb2RlciA9IG5ldyBUZXh0RGVjb2RlcigpO1xuICAgIGxldCBidWZmZXIgPSAnJztcbiAgICBmb3IgKDs7KSB7XG4gICAgICBjb25zdCB7IGRvbmUsIHZhbHVlIH0gPSBhd2FpdCByZWFkZXIucmVhZCgpO1xuICAgICAgaWYgKGRvbmUpIHJldHVybjtcbiAgICAgIGJ1ZmZlciArPSBkZWNvZGVyLmRlY29kZSh2YWx1ZSwgeyBzdHJlYW06IHRydWUgfSk7XG4gICAgICAvLyBcdTRFRTVcdTdBN0FcdTg4NENcdTUyMDZcdTVFMjc7XHU0RkREXHU3NTU5XHU0RTBEXHU1QjhDXHU2NTc0XHU3Njg0XHU1QzNFXHU5MEU4XG4gICAgICBsZXQgaWR4OiBudW1iZXI7XG4gICAgICB3aGlsZSAoKGlkeCA9IGJ1ZmZlci5pbmRleE9mKCdcXG5cXG4nKSkgIT09IC0xKSB7XG4gICAgICAgIGNvbnN0IGJsb2NrID0gYnVmZmVyLnNsaWNlKDAsIGlkeCk7XG4gICAgICAgIGJ1ZmZlciA9IGJ1ZmZlci5zbGljZShpZHggKyAyKTtcbiAgICAgICAgZm9yIChjb25zdCBmcmFtZSBvZiBwYXJzZVNzZUNodW5rKGJsb2NrKSkge1xuICAgICAgICAgIGNvbnN0IGVudiA9IGVudmVsb3BlRnJvbUZyYW1lKGZyYW1lKTtcbiAgICAgICAgICBpZiAoZW52ICE9PSBudWxsKSB5aWVsZCBlbnY7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH1cbn1cbiIsICIvKipcbiAqIGZha2UgaG9zdCBcdTIwMTQgaG1oYXJuZXNzIHJ1bnRpbWUgXHU3Njg0XHU2RDRCXHU4QkQ1XHU2NkZGXHU4RUFCKE1hc3RlclByb21wdCBcdTk2MzZcdTZCQjUgRC9FOlxuICogXCJcdTUxNDhcdTRGN0ZcdTc1MjggZmFrZSBob3N0IFx1N0YxNlx1NTE5OVx1NzJCNlx1NjAwMVx1NjczQVx1NkQ0Qlx1OEJENSxcdTUxOERcdTYzQTVcdTc3MUZcdTVCOUUgQVBJXCI7XHU5NjM2XHU2QkI1IEUgXHU3Njg0XHU0RjFBXHU4QkREXHU3RUI1XHU1MjA3XHU3MjQ3XG4gKiBlMmUgXHU0RTVGXHU1MTQ4XHU1NzI4IGZha2UgXHU1QzQyXHU5NUVEXHU3M0FGKVx1MzAwMlxuICpcbiAqIFx1Njg0Q1x1OTc2MiBob3N0IFx1NTQwOFx1NTQwQzpcbiAqICAtIFx1NTNFQVx1N0VEMSAxMjcuMC4wLjEsXHU3QUVGXHU1M0UzIE9TIFx1NTIwNlx1OTE0RCxcdTVCOUVcdTk2NDVcdTdBRUZcdTUzRTNcdTUxOTkgc3Rkb3V0IFx1NUYxNVx1NUJGQ1x1ODg0QztcbiAqICAtIFx1NjI0MFx1NjcwOSAvYXBpLyogXHU4OTgxXHU2QzQyIFgtSG1oLUtleSA9PT0gSE1IX0RFU0tUT1BfVE9LRU4sXHU1NDI2XHU1MjE5IDQwMSArIERlc2t0b3BFcnJvcjtcbiAqICAtIEdFVCAvYXBpL3N0YXRlIFx1NTA2NVx1NUVCN1x1NjNBMlx1NkQ0QjtHRVQgL2FwaS9ldmVudHMgU1NFKGV2ZW50OiBobWggXHU0RkUxXHU1QzAxXHU2RDQxICsgXHU5MUNEXHU2NTNFXHU3M0FGKTtcbiAqICAtIFBPU1QgL2FwaS9kZXNrdG9wL3NodXRkb3duIFx1NEYxOFx1OTZDNVx1OTAwMFx1NTFGQVx1MzAwMlxuICpcbiAqIFx1OTYzNlx1NkJCNSBFIFx1NkEyMVx1NjJERlx1OTc2MihcdTRFMEUgaG1oYXJuZXNzIGRlc2t0b3AgXHU2QTIxXHU1RjBGXHU1NDBDXHU1RjYyKTpcbiAqICAtIFBPU1QgL2FwaS90YXNrIHt0ZXh0LCBzZXNzaW9uSWQsIG1vZGV9Olx1NjM5Mlx1OTYxRlx1NUU3Nlx1NjMwOVx1ODExQVx1NjcyQ1x1NTNEMVxuICogICAgcnVuLnN0YXJ0ZWQgXHUyMTkyIHRvb2wuc3RhcnRlZC9jb21wbGV0ZWQgXHUyMTkyKG1vZGU9PT0nYXNrJyBcdTY1RjYpXG4gKiAgICBhcHByb3ZhbC5yZXF1aXJlZChcdTdCNDkgL2FwaS9hcHByb3ZlKVx1MjE5MiBydW4uY29tcGxldGVkO1xuICogIC0gUE9TVCAvYXBpL2FwcHJvdmUge2dyYW50ZWQsIHNlc3Npb25JZH07XG4gKiAgLSBQT1NUIC9hcGkvaW50ZXJydXB0IHtzZXNzaW9uSWR9O1xuICogIC0gR0VUIC9hcGkvc2Vzc2lvbnNcdTMwMDJcbiAqXG4gKiBcdTZENEJcdThCRDVcdTk0QTlcdTVCNTA6RkFLRV9IT1NUX0RJRV9BRlRFUl9NUyAvIEZBS0VfSE9TVF9ESUVfQVRfQk9PVCAvXG4gKiBGQUtFX0hPU1RfRVhQRUNUX1RPS0VOIC8gRkFLRV9IT1NUX1RBU0tfREVMQVlfTVMgLyBGQUtFX0hPU1RfVEFTS19GQUlMPTFcbiAqIChcdTRFRkJcdTUyQTFcdTRFRTUgcnVuLmZhaWxlZCBcdTdFRDNcdTY3NUYsXHU2Nzg0XHU5MDIwXHU5NTE5XHU4QkVGXHU2MDYyXHU1OTBEXHU1NzNBXHU2NjZGKVx1MzAwMlxuICovXG5pbXBvcnQgeyBjcmVhdGVTZXJ2ZXIsIHR5cGUgU2VydmVyUmVzcG9uc2UgfSBmcm9tICdub2RlOmh0dHAnO1xuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gJ25vZGU6Y3J5cHRvJztcbmltcG9ydCB7IHBhdGhUb0ZpbGVVUkwgfSBmcm9tICdub2RlOnVybCc7XG5pbXBvcnQgeyByZWFscGF0aFN5bmMgfSBmcm9tICdub2RlOmZzJztcbmltcG9ydCB7IEVWRU5UX1NDSEVNQV9WRVJTSU9OLCBkZXNrdG9wRXJyb3IsIHR5cGUgRXZlbnRFbnZlbG9wZSwgdHlwZSBFdmVudEtpbmQgfSBmcm9tICdAaG1oLWRlc2t0b3AvY29udHJhY3RzJztcblxuZXhwb3J0IGludGVyZmFjZSBGYWtlSG9zdEhhbmRsZSB7XG4gIHBvcnQ6IG51bWJlcjtcbiAgZW1pdChzZXNzaW9uSWQ6IHN0cmluZywgcnVuSWQ6IHN0cmluZywga2luZDogRXZlbnRLaW5kLCBwYXlsb2FkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IG51bWJlcjtcbiAgY2xvc2UoKTogUHJvbWlzZTx2b2lkPjtcbn1cblxuaW50ZXJmYWNlIEZha2VTZXNzaW9uIHtcbiAgaWQ6IHN0cmluZztcbiAgY3JlYXRlZEF0OiBzdHJpbmc7XG4gIHVwZGF0ZWRBdDogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgUGVuZGluZ0FwcHJvdmFsIHtcbiAgc2Vzc2lvbklkOiBzdHJpbmc7XG4gIGFwcHJvdmFsSWQ6IHN0cmluZztcbiAgcmVzb2x2ZShncmFudGVkOiBib29sZWFuKTogdm9pZDtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHN0YXJ0RmFrZUhvc3Qob3B0czogeyB0b2tlbjogc3RyaW5nOyBxdWlldD86IGJvb2xlYW4gfSk6IFByb21pc2U8RmFrZUhvc3RIYW5kbGU+IHtcbiAgY29uc3QgdG9rZW4gPSBvcHRzLnRva2VuO1xuICAvLyBcdTZENEJcdThCRDVcdTk0QTlcdTVCNTA6RkFLRV9IT1NUX0VYUEVDVF9UT0tFTiBcdThCQTkgaG9zdCBcdTY4MjFcdTlBOENcdTRFMDBcdTRFMkFcdTRFMEUgSE1IX0RFU0tUT1BfVE9LRU5cbiAgLy8gXHU0RTBEXHU1NDBDXHU3Njg0XHU1MDNDKFx1Njc4NFx1OTAyMCBBVVRIX0ZBSUxFRCBcdTU3M0FcdTY2NkY7c3VwZXJ2aXNvciBcdTYwM0JcdTY2MkZcdTg5ODZcdTc2RDYgSE1IX0RFU0tUT1BfVE9LRU4pXG4gIGNvbnN0IGV4cGVjdGVkID0gcHJvY2Vzcy5lbnYuRkFLRV9IT1NUX0VYUEVDVF9UT0tFTiA/PyB0b2tlbjtcbiAgY29uc3QgdGFza0RlbGF5ID0gTnVtYmVyKHByb2Nlc3MuZW52LkZBS0VfSE9TVF9UQVNLX0RFTEFZX01TID8/IDMwKTtcbiAgY29uc3QgZmFpbFRhc2tzID0gcHJvY2Vzcy5lbnYuRkFLRV9IT1NUX1RBU0tfRkFJTCA9PT0gJzEnO1xuXG4gIGNvbnN0IHNzZUNsaWVudHMgPSBuZXcgU2V0PFNlcnZlclJlc3BvbnNlPigpO1xuICBjb25zdCBzZXFCeVJ1biA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG4gIC8vIFx1OTFDRFx1NjUzRVx1NzNBRjpcdTY3MDBcdThGRDEgMjAwIFx1NUUyNyhMYXN0LUV2ZW50LUlEIFx1NjVBRFx1N0VCRlx1ODg2NVx1NjJDOSksXHU0RTBFIGhtaGFybmVzcyB3ZWIgXHU1NDBDXHU2QjNFXHU4QkVEXHU0RTQ5XG4gIGNvbnN0IHJpbmc6IEFycmF5PHsgaWQ6IG51bWJlcjsgZXZlbnQ6IHN0cmluZzsgZGF0YTogdW5rbm93biB9PiA9IFtdO1xuICBsZXQgcmluZ1NlcSA9IDA7XG4gIGNvbnN0IHNlc3Npb25zID0gbmV3IE1hcDxzdHJpbmcsIEZha2VTZXNzaW9uPigpO1xuICBsZXQgcGVuZGluZzogUGVuZGluZ0FwcHJvdmFsIHwgbnVsbCA9IG51bGw7XG4gIGNvbnN0IHJ1blRpbWVycyA9IG5ldyBNYXA8c3RyaW5nLCBOb2RlSlMuVGltZW91dD4oKTtcbiAgLy8gXHU1REU1XHU0RjVDXHU1MzNBL1Byb3ZpZGVyIFx1NzJCNlx1NjAwMShcdTRFMEUgaG1oYXJuZXNzIFx1NTQwQ1x1NUY2Mlx1NzY4NFx1NjcwMFx1NUMwRlx1NkEyMVx1NjJERilcbiAgY29uc3QgZmFrZVdvcmtzcGFjZXMgPSB7XG4gICAgY3VycmVudDogJ3dzLWRlbW8nLFxuICAgIGl0ZW1zOiBbXG4gICAgICB7IGlkOiAnd3MtZGVtbycsIG5hbWU6ICdkZW1vLXdvcmtzcGFjZScsIHBhdGg6ICdDOlxcXFxkZW1vJyB9LFxuICAgIF0sXG4gIH07XG4gIGNvbnN0IGZha2VQcm92aWRlcnMgPSBuZXcgTWFwPHN0cmluZywgeyBiYXNlVXJsOiBzdHJpbmc7IG1vZGVsOiBzdHJpbmc7IGFwaUtleTogc3RyaW5nIH0+KFtcbiAgICBbJ2RlbW8nLCB7IGJhc2VVcmw6ICdodHRwOi8vMTI3LjAuMC4xOjkvdjEnLCBtb2RlbDogJ2Zha2UtbScsIGFwaUtleTogJ3NrLWRlbW8tMTIzNCcgfV0sXG4gIF0pO1xuXG4gIGNvbnN0IGVtaXQgPSAoc2Vzc2lvbklkOiBzdHJpbmcsIHJ1bklkOiBzdHJpbmcsIGtpbmQ6IEV2ZW50S2luZCwgcGF5bG9hZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBudW1iZXIgPT4ge1xuICAgIGNvbnN0IGtleSA9IGAke3Nlc3Npb25JZH1cXDAke3J1bklkfWA7XG4gICAgY29uc3Qgc2VxID0gKHNlcUJ5UnVuLmdldChrZXkpID8/IDApICsgMTtcbiAgICBzZXFCeVJ1bi5zZXQoa2V5LCBzZXEpO1xuICAgIGNvbnN0IGVudjogRXZlbnRFbnZlbG9wZSA9IHtcbiAgICAgIHNjaGVtYVZlcnNpb246IEVWRU5UX1NDSEVNQV9WRVJTSU9OLFxuICAgICAgZXZlbnRJZDogcmFuZG9tVVVJRCgpLFxuICAgICAgc2Vzc2lvbklkLFxuICAgICAgcnVuSWQsXG4gICAgICBzZXEsXG4gICAgICBvY2N1cnJlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICBraW5kLFxuICAgICAgcGF5bG9hZCxcbiAgICB9O1xuICAgIGNvbnN0IGlkID0gKytyaW5nU2VxO1xuICAgIHJpbmcucHVzaCh7IGlkLCBldmVudDogJ2htaCcsIGRhdGE6IGVudiB9KTtcbiAgICBpZiAocmluZy5sZW5ndGggPiAyMDApIHJpbmcuc3BsaWNlKDAsIHJpbmcubGVuZ3RoIC0gMjAwKTtcbiAgICBmb3IgKGNvbnN0IGMgb2Ygc3NlQ2xpZW50cykge1xuICAgICAgYy53cml0ZShgaWQ6ICR7aWR9XFxuZXZlbnQ6IGhtaFxcbmRhdGE6ICR7SlNPTi5zdHJpbmdpZnkoZW52KX1cXG5cXG5gKTtcbiAgICB9XG4gICAgcmV0dXJuIHNlcTtcbiAgfTtcblxuICBjb25zdCB0b3VjaCA9IChzZXNzaW9uSWQ6IHN0cmluZyk6IEZha2VTZXNzaW9uID0+IHtcbiAgICBsZXQgcyA9IHNlc3Npb25zLmdldChzZXNzaW9uSWQpO1xuICAgIGlmIChzID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHMgPSB7IGlkOiBzZXNzaW9uSWQsIGNyZWF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLCB1cGRhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSB9O1xuICAgICAgc2Vzc2lvbnMuc2V0KHNlc3Npb25JZCwgcyk7XG4gICAgfVxuICAgIHMudXBkYXRlZEF0ID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuICAgIHJldHVybiBzO1xuICB9O1xuXG4gIC8qKiBcdTZBMjFcdTYyREZcdTRFMDBcdTZCMjFcdTRFRkJcdTUyQTE6XHU2Mjc5XHU1MUM2XHU2QTIxXHU1RjBGXHU2MzAyXHU4RDc3XHU3QjQ5XHU1Rjg1IC9hcGkvYXBwcm92ZVx1MzAwMiAqL1xuICBjb25zdCBydW5UYXNrID0gKHNlc3Npb25JZDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcsIG1vZGU6IHN0cmluZyk6IHN0cmluZyA9PiB7XG4gICAgY29uc3QgcnVuSWQgPSBgcnVuLSR7RGF0ZS5ub3coKS50b1N0cmluZygzNil9LSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMiwgOCl9YDtcbiAgICB0b3VjaChzZXNzaW9uSWQpO1xuICAgIGNvbnN0IHN0ZXBzOiBBcnJheTwoKSA9PiB2b2lkPiA9IFtdO1xuICAgIGNvbnN0IHdhaXQgPSAoZm46ICgpID0+IHZvaWQsIG1zID0gdGFza0RlbGF5KTogdm9pZCA9PiB7XG4gICAgICBjb25zdCB0ID0gc2V0VGltZW91dChmbiwgbXMpO1xuICAgICAgcnVuVGltZXJzLnNldChgJHtzZXNzaW9uSWR9XFwwJHtydW5JZH1gLCB0KTtcbiAgICB9O1xuICAgIGNvbnN0IGNoYWluID0gKGZuczogQXJyYXk8KCkgPT4gdm9pZD4pOiB2b2lkID0+IHtcbiAgICAgIGNvbnN0IFtmaXJzdCwgLi4ucmVzdF0gPSBmbnM7XG4gICAgICBpZiAoZmlyc3QgPT09IHVuZGVmaW5lZCkgcmV0dXJuO1xuICAgICAgd2FpdCgoKSA9PiB7XG4gICAgICAgIGZpcnN0KCk7XG4gICAgICAgIGNoYWluKHJlc3QpO1xuICAgICAgfSk7XG4gICAgfTtcblxuICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ3J1bi5zdGFydGVkJywgeyB0YXNrOiB0ZXh0LCBtb2RlIH0pO1xuICAgIGlmIChmYWlsVGFza3MpIHtcbiAgICAgIHdhaXQoKCkgPT4gZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAncnVuLmZhaWxlZCcsIHtcbiAgICAgICAgZXJyb3I6IHsgY29kZTogJ0FVVEhfRkFJTEVEJywgbWVzc2FnZTogJ3NpbXVsYXRlZCBwcm92aWRlciBhdXRoIGZhaWx1cmUnLCByZXRyeWFibGU6IGZhbHNlIH0sXG4gICAgICB9KSk7XG4gICAgICByZXR1cm4gcnVuSWQ7XG4gICAgfVxuXG4gICAgY29uc3QgZmluaXNoUnVuID0gKGFuc3dlcjogc3RyaW5nLCB0b29sVXNlczogbnVtYmVyKTogdm9pZCA9PiB7XG4gICAgICBydW5UaW1lcnMuZGVsZXRlKGAke3Nlc3Npb25JZH1cXDAke3J1bklkfWApO1xuICAgICAgLy8gXHU0RUE0XHU0RUQ4XHU3MjY5XHU1MTQ4XHU0RThFXHU3RUM4XHU2MDAxKFx1NEUwRSBobWhhcm5lc3MgZGVza3RvcCBcdTY4NjVcdTU0MENcdTVFOEY6YXJ0aWZhY3QuY3JlYXRlZCBcdTIxOTIgcnVuLmNvbXBsZXRlZClcbiAgICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ2FydGlmYWN0LmNyZWF0ZWQnLCB7XG4gICAgICAgIGFydGlmYWN0OiB7IHJlbFBhdGg6ICdvdXQudHh0Jywga2luZDogJ2ZpbGUnLCB0aXRsZTogJ291dC50eHQnIH0sXG4gICAgICB9KTtcbiAgICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ3J1bi5jb21wbGV0ZWQnLCB7IHRleHQ6IGFuc3dlciwgdHVybnM6IDEsIHRvb2xVc2VzIH0pO1xuICAgIH07XG5cbiAgICBjb25zdCBzY3JpcHRlZDogQXJyYXk8KCkgPT4gdm9pZD4gPSBbXG4gICAgICAoKSA9PiBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICd0b29sLnN0YXJ0ZWQnLCB7IG5hbWU6ICdyZWFkX2ZpbGUnLCBhcmdzUHJldmlldzogJ3tcInBhdGhcIjpcIlJFQURNRS5tZFwifScgfSksXG4gICAgICAoKSA9PiBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICd0b29sLmNvbXBsZXRlZCcsIHsgbmFtZTogJ3JlYWRfZmlsZScsIGlzRXJyb3I6IGZhbHNlLCBvdXRwdXRQcmV2aWV3OiAnIyBkZW1vJyB9KSxcbiAgICBdO1xuXG4gICAgaWYgKG1vZGUgPT09ICdhc2snKSB7XG4gICAgICBzY3JpcHRlZC5wdXNoKCgpID0+IHtcbiAgICAgICAgY29uc3QgYXBwcm92YWxJZCA9IGBhcC0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDgpfWA7XG4gICAgICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ2FwcHJvdmFsLnJlcXVpcmVkJywge1xuICAgICAgICAgIGFwcHJvdmFsSWQsXG4gICAgICAgICAgdG9vbDogJ3dyaXRlX2ZpbGUnLFxuICAgICAgICAgIGFyZ3NQcmV2aWV3OiAne1wicGF0aFwiOlwib3V0LnR4dFwiLFwiY29udGVudFwiOlwiaGlcIn0nLFxuICAgICAgICAgIHJpc2s6ICdcdTUxOTlcdTUxNjVcdTVERTVcdTRGNUNcdTUzM0FcdTY1ODdcdTRFRjYgb3V0LnR4dChcdTZBMjFcdTYyREYpJyxcbiAgICAgICAgfSk7XG4gICAgICAgIHBlbmRpbmcgPSB7XG4gICAgICAgICAgc2Vzc2lvbklkLFxuICAgICAgICAgIGFwcHJvdmFsSWQsXG4gICAgICAgICAgcmVzb2x2ZTogKGdyYW50ZWQpID0+IHtcbiAgICAgICAgICAgIHBlbmRpbmcgPSBudWxsO1xuICAgICAgICAgICAgaWYgKGdyYW50ZWQpIHtcbiAgICAgICAgICAgICAgZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAndG9vbC5zdGFydGVkJywgeyBuYW1lOiAnd3JpdGVfZmlsZScsIGFyZ3NQcmV2aWV3OiAne1wicGF0aFwiOlwib3V0LnR4dFwifScgfSk7XG4gICAgICAgICAgICAgIHdhaXQoKCkgPT4gZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAndG9vbC5jb21wbGV0ZWQnLCB7IG5hbWU6ICd3cml0ZV9maWxlJywgaXNFcnJvcjogZmFsc2UsIG91dHB1dFByZXZpZXc6ICd3cm90ZSAyIGJ5dGVzJyB9KSk7XG4gICAgICAgICAgICAgIHdhaXQoKCkgPT4gZmluaXNoUnVuKGBlY2hvOiAke3RleHR9KFx1NURGMlx1NjI2N1x1ODg0Q1x1NTE5OVx1NTE2NSlgLCAzKSwgdGFza0RlbGF5ICogMik7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICBmaW5pc2hSdW4oYGVjaG86ICR7dGV4dH0oXHU1QkExXHU2Mjc5XHU4OEFCXHU2MkQyXHU3RURELFx1NjcyQVx1NjI2N1x1ODg0Q1x1NTE5OVx1NTE2NSlgLCAxKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9LFxuICAgICAgICB9O1xuICAgICAgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHNjcmlwdGVkLnB1c2goKCkgPT4gZmluaXNoUnVuKGBlY2hvOiAke3RleHR9YCwgMSkpO1xuICAgIH1cbiAgICBjaGFpbihzY3JpcHRlZCk7XG4gICAgcmV0dXJuIHJ1bklkO1xuICB9O1xuXG4gIGNvbnN0IHNlcnZlciA9IGNyZWF0ZVNlcnZlcigocmVxLCByZXMpID0+IHtcbiAgICBjb25zdCB1cmwgPSBuZXcgVVJMKHJlcS51cmwgPz8gJy8nLCAnaHR0cDovLzEyNy4wLjAuMScpO1xuICAgIGNvbnN0IGF1dGhvcml6ZWQgPSByZXEuaGVhZGVyc1sneC1obWgta2V5J10gPT09IGV4cGVjdGVkO1xuICAgIGNvbnN0IGRlbnkgPSAoKTogdm9pZCA9PiB7XG4gICAgICByZXMud3JpdGVIZWFkKDQwMSwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgJ21pc3Npbmcgb3IgaW52YWxpZCB4LWhtaC1rZXknLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICB9O1xuXG4gICAgY29uc3QgcmVhZEJvZHkgPSAoKTogUHJvbWlzZTxzdHJpbmc+ID0+XG4gICAgICBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xuICAgICAgICBsZXQgYiA9ICcnO1xuICAgICAgICByZXEub24oJ2RhdGEnLCAoYzogQnVmZmVyKSA9PiB7IGIgKz0gYy50b1N0cmluZygpOyB9KTtcbiAgICAgICAgcmVxLm9uKCdlbmQnLCAoKSA9PiByZXNvbHZlKGIpKTtcbiAgICAgIH0pO1xuXG4gICAgaWYgKHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZXZlbnRzJykge1xuICAgICAgaWYgKCFhdXRob3JpemVkKSB7IGRlbnkoKTsgcmV0dXJuOyB9XG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ3RleHQvZXZlbnQtc3RyZWFtJywgJ2NhY2hlLWNvbnRyb2wnOiAnbm8tY2FjaGUnLCBjb25uZWN0aW9uOiAna2VlcC1hbGl2ZScgfSk7XG4gICAgICByZXMuZmx1c2hIZWFkZXJzPy4oKTtcbiAgICAgIHNzZUNsaWVudHMuYWRkKHJlcyk7XG4gICAgICAvLyBcdTY1QURcdTdFQkZcdTg4NjVcdTYyQzk6TGFzdC1FdmVudC1JRCBcdTRFNEJcdTUyNERcdTc2ODRcdTVFMjdcdTVERjJcdTU3MjhcdTVCQTJcdTYyMzdcdTdBRUYsXHU5MUNEXHU1M0QxXHU1MTc2XHU1NDBFXHU3Njg0XHU3M0FGXHU1RjYyXHU3RjEzXHU1MUIyXG4gICAgICBjb25zdCBsYXN0SWQgPSBOdW1iZXIocmVxLmhlYWRlcnNbJ2xhc3QtZXZlbnQtaWQnXSA/PyAwKTtcbiAgICAgIGlmIChOdW1iZXIuaXNGaW5pdGUobGFzdElkKSAmJiBsYXN0SWQgPiAwKSB7XG4gICAgICAgIGZvciAoY29uc3QgZSBvZiByaW5nKSB7XG4gICAgICAgICAgaWYgKGUuaWQgPiBsYXN0SWQpIHJlcy53cml0ZShgaWQ6ICR7ZS5pZH1cXG5ldmVudDogJHtlLmV2ZW50fVxcbmRhdGE6ICR7SlNPTi5zdHJpbmdpZnkoZS5kYXRhKX1cXG5cXG5gKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmVxLm9uKCdjbG9zZScsICgpID0+IHNzZUNsaWVudHMuZGVsZXRlKHJlcykpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAoIWF1dGhvcml6ZWQpIHsgZGVueSgpOyByZXR1cm47IH1cblxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3N0YXRlJykge1xuICAgICAgLy8gcHJvdmlkZXJzRGV0YWlsOlx1NEUwRSBobWhhcm5lc3MgXHU1NDBDXHU1RjYyXHUyMDE0XHUyMDE0a2V5IFx1NTNFQVx1NTFGQSBoYXNLZXkvXHU2NzJCXHU1NkRCXHU0RjRELFx1NkMzOFx1NEUwRFx1NjYwRVx1NjU4N1xuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBkYWVtb25WZXJzaW9uOiAnZmFrZS0wLjAuMCcsIGRlc2t0b3A6IHRydWUsIG1vZGVsOiAnZmFrZS1tb2RlbCcsIGxvY2FsZTogJ3poJyxcbiAgICAgICAgYnVzeVNlc3Npb25zOiBbLi4uc2Vzc2lvbnMua2V5cygpXS5zbGljZSgwLCAyKSxcbiAgICAgICAgYXBwcm92YWxQZW5kaW5nOiBwZW5kaW5nICE9PSBudWxsLFxuICAgICAgICBzZXR0aW5nczogeyBhcHByb3ZhbDogJ2FzaycgfSxcbiAgICAgICAgd29ya3NwYWNlOiBmYWtlV29ya3NwYWNlcy5pdGVtcy5maW5kKCh3KSA9PiB3LmlkID09PSBmYWtlV29ya3NwYWNlcy5jdXJyZW50KSA/PyBudWxsLFxuICAgICAgICBwcm92aWRlcnNEZXRhaWw6IFsuLi5mYWtlUHJvdmlkZXJzLmVudHJpZXMoKV0ubWFwKChbbmFtZSwgcF0pID0+ICh7XG4gICAgICAgICAgbmFtZSwgbW9kZWw6IHAubW9kZWwsIGJhc2VVcmw6IHAuYmFzZVVybCxcbiAgICAgICAgICBoYXNLZXk6IHAuYXBpS2V5ICE9PSAnJyxcbiAgICAgICAgICBrZXlUYWlsOiBwLmFwaUtleS5sZW5ndGggPj0gNCA/IHAuYXBpS2V5LnNsaWNlKC00KSA6IHVuZGVmaW5lZCxcbiAgICAgICAgICBwdXJwb3NlczogWydjaGF0J10sXG4gICAgICAgIH0pKSxcbiAgICAgIH0pKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2Rlc2t0b3Avc2h1dGRvd24nKSB7XG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlIH0pKTtcbiAgICAgIHNlcnZlci5jbG9zZSgoKSA9PiBwcm9jZXNzLmV4aXQoMCkpO1xuICAgICAgc2V0VGltZW91dCgoKSA9PiBwcm9jZXNzLmV4aXQoMCksIDFfMDAwKS51bnJlZigpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZmFrZS9kaWUnKSB7XG4gICAgICAvLyBcdTZENEJcdThCRDVcdTk0QTlcdTVCNTA6XHU2QTIxXHU2MkRGIGhvc3QgXHU1RDI5XHU2RTgzKFx1NTE0OFx1NUU5NFx1N0I1NFx1NTE4RFx1OTAwMFx1NTFGQSxcdTRGRERcdThCQzFcdTU0Q0RcdTVFOTRcdTVERjJcdTUzRDFcdTUxRkEpXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlIH0pKTtcbiAgICAgIHNldFRpbWVvdXQoKCkgPT4gcHJvY2Vzcy5leGl0KDEpLCA1MCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS90YXNrJykge1xuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7IHRleHQ/OiB1bmtub3duOyBzZXNzaW9uSWQ/OiB1bmtub3duOyBtb2RlPzogdW5rbm93biB9O1xuICAgICAgICAgIGNvbnN0IHRleHQgPSB0eXBlb2YgYm9keS50ZXh0ID09PSAnc3RyaW5nJyA/IGJvZHkudGV4dCA6ICcnO1xuICAgICAgICAgIGNvbnN0IHNlc3Npb25JZCA9IHR5cGVvZiBib2R5LnNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBib2R5LnNlc3Npb25JZCA6IGB3ZWItJHtEYXRlLm5vdygpLnRvU3RyaW5nKDM2KX1gO1xuICAgICAgICAgIGNvbnN0IG1vZGUgPSBib2R5Lm1vZGUgPT09ICdhc2snIHx8IGJvZHkubW9kZSA9PT0gJ2F1dG8nIHx8IGJvZHkubW9kZSA9PT0gJ3lvbG8nID8gYm9keS5tb2RlIDogJ2Fzayc7XG4gICAgICAgICAgaWYgKCF0ZXh0KSB7XG4gICAgICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICd0ZXh0IHJlcXVpcmVkJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuICAgICAgICAgIGNvbnN0IHJ1bklkID0gcnVuVGFzayhzZXNzaW9uSWQsIHRleHQsIG1vZGUpO1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlLCBydW5JZCB9KSk7XG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsIFN0cmluZyhlcnIpLnNsaWNlKDAsIDEyMCksIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICB9XG4gICAgICB9KSgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvYXBwcm92ZScpIHtcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoKGF3YWl0IHJlYWRCb2R5KCkpIHx8ICd7fScpIGFzIHsgZ3JhbnRlZD86IHVua25vd247IHNlc3Npb25JZD86IHVua25vd24gfTtcbiAgICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIGJvZHkuc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IGJvZHkuc2Vzc2lvbklkIDogJyc7XG4gICAgICAgIGlmIChwZW5kaW5nID09PSBudWxsIHx8IChzaWQgIT09ICcnICYmIHBlbmRpbmcuc2Vzc2lvbklkICE9PSBzaWQpKSB7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ25vIGFwcHJvdmFsIHBlbmRpbmcnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgcCA9IHBlbmRpbmc7XG4gICAgICAgIHBlbmRpbmcgPSBudWxsO1xuICAgICAgICBwLnJlc29sdmUoYm9keS5ncmFudGVkID09PSB0cnVlKTtcbiAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlLCBncmFudGVkOiBib2R5LmdyYW50ZWQgPT09IHRydWUgfSkpO1xuICAgICAgfSkoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUuc3RhcnRzV2l0aCgnL2FwaS9zZXNzaW9ucy8nKSAmJiAodXJsLnBhdGhuYW1lLmVuZHNXaXRoKCcvYXJjaGl2ZScpIHx8IHVybC5wYXRobmFtZS5lbmRzV2l0aCgnL2RlbGV0ZScpKSkge1xuICAgICAgLy8gXHU0RjFBXHU4QkREXHU1RjUyXHU2ODYzL1x1NTIyMFx1OTY2NChobWhhcm5lc3MgXHU1NDBDXHU1RjYyOlx1NzlGQlx1NTE2NSBhcmNoaXZlL3RyYXNoLFx1NTNFRlx1NjA2Mlx1NTkwRCxcdTRFMERcdTc4NkNcdTUyMjApXG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IHBhcnRzID0gdXJsLnBhdGhuYW1lLnNsaWNlKCcvYXBpL3Nlc3Npb25zLycubGVuZ3RoKS5zcGxpdCgnLycpO1xuICAgICAgICBjb25zdCBvcCA9IHBhcnRzWzFdID8/ICcnO1xuICAgICAgICBjb25zdCBvaWQgPSBkZWNvZGVVUklDb21wb25lbnQocGFydHNbMF0gPz8gJycpLnJlcGxhY2UoL1teYS16QS1aMC05XzouQC1dL2csICcnKTtcbiAgICAgICAgaWYgKG9pZCA9PT0gJycgfHwgKG9wICE9PSAnYXJjaGl2ZScgJiYgb3AgIT09ICdkZWxldGUnKSkge1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICdiYWQgb3AnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFzZXNzaW9ucy5oYXMob2lkKSkge1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICdzZXNzaW9uIG5vdCBmb3VuZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBzZXNzaW9ucy5kZWxldGUob2lkKTtcbiAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlIH0pKTtcbiAgICAgIH0pKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9pbmplY3QnKSB7XG4gICAgICAvLyBcdThGRDBcdTg4NENcdTRFMkRcdTZDRThcdTUxNjUoXHU0RTBFIGhtaGFybmVzcyAvYXBpL2luamVjdCBcdTU0MENcdTVGNjI7ZmFrZSBcdTUzRUFcdTU2REVcdTYyNjcpXG4gICAgICB2b2lkIHJlYWRCb2R5KCk7XG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlIH0pKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2ludGVycnVwdCcpIHtcbiAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKCcnKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjsgLy8gaW50ZXJydXB0IFx1NjVFMCBib2R5IFx1OEJFRFx1NEU0OVxuICAgICAgdm9pZCBib2R5O1xuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3Nlc3Npb25zJykge1xuICAgICAgY29uc3QgbGlzdCA9IFsuLi5zZXNzaW9ucy52YWx1ZXMoKV0ubWFwKChzKSA9PiAoe1xuICAgICAgICBpZDogcy5pZCwgdGl0bGU6ICcnLCB0YXNrOiAnJywgb3V0Y29tZTogJ29rJywgdHVybnM6IDEsIHRvb2xVc2VzOiAxLFxuICAgICAgICB0aW1lOiBzLnVwZGF0ZWRBdCwgY3dkOiAnQzpcXFxcZGVtbycsIGJyYW5jaDogJycsIGNyZWF0ZWRBdDogcy5jcmVhdGVkQXQsIHVwZGF0ZWRBdDogcy51cGRhdGVkQXQsXG4gICAgICB9KSk7XG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IHNlc3Npb25zOiBsaXN0LCBuZXh0Q3Vyc29yOiBudWxsIH0pKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZS5zdGFydHNXaXRoKCcvYXBpL3Nlc3Npb25zLycpKSB7XG4gICAgICBjb25zdCBzZWcgPSBkZWNvZGVVUklDb21wb25lbnQodXJsLnBhdGhuYW1lLnNsaWNlKCcvYXBpL3Nlc3Npb25zLycubGVuZ3RoKSk7XG4gICAgICAvLyBcdTVCRkNcdTUxRkEoXHU0RTBFIGhtaGFybmVzcyAvYXBpL3Nlc3Npb25zLzppZC9leHBvcnQubWQgXHU1NDBDXHU1RjYyOnRleHQvbWFya2Rvd24gXHU0RTBCXHU4RjdEKVxuICAgICAgY29uc3QgZXhwb3J0TWF0Y2ggPSAvXiguKilcXC9leHBvcnRcXC5tZCQvLmV4ZWMoc2VnKSA/PyAvXiguKilcXC5leHBvcnRcXC5tZCQvLmV4ZWMoc2VnKTtcbiAgICAgIGlmIChleHBvcnRNYXRjaCAhPT0gbnVsbCAmJiBleHBvcnRNYXRjaFsxXSAhPT0gdW5kZWZpbmVkICYmIGV4cG9ydE1hdGNoWzFdICE9PSAnJykge1xuICAgICAgICBjb25zdCBlaWQgPSBleHBvcnRNYXRjaFsxXS5yZXBsYWNlKC9bXmEtekEtWjAtOV86LkAtXS9nLCAnJyk7XG4gICAgICAgIGNvbnN0IGVzID0gc2Vzc2lvbnMuZ2V0KGVpZCk7XG4gICAgICAgIGlmIChlcyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3Nlc3Npb24gbm90IGZvdW5kJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAndGV4dC9tYXJrZG93bjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgIHJlcy5lbmQoYCMgaG1oYXJuZXNzIFx1NEYxQVx1OEJERFx1NUJGQ1x1NTFGQShmYWtlKVxcblxcbi0gXHU0RjFBXHU4QkREOiR7ZWlkfVxcblxcbiMjIFx1NzUyOFx1NjIzN1xcblxcblx1NEU0Qlx1NTI0RFx1NzY4NFx1NEVGQlx1NTJBMShmYWtlIFx1OTg4NFx1ODlDOClcXG5cXG4jIyBcdTUyQTlcdTYyNEJcXG5cXG5cdThGRDlcdTY2MkZcdTVCRkNcdTUxRkFcdTc2ODRcdTU2REVcdTU5MERcdTk4ODRcdTg5QzgoZmFrZSlcdTMwMDJcXG5gKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgLy8gXHU0RjFBXHU4QkREXHU5ODg0XHU4OUM4KFx1NEUwRSBobWhhcm5lc3MgR0VUIC9hcGkvc2Vzc2lvbnMvOmlkIFx1NTQwQ1x1NUY2MjpcdTY3MDBcdTU0MEUgODAgXHU2NzYxLFx1NkJDRlx1Njc2MSA1MDAgXHU1QjU3KVxuICAgICAgY29uc3QgaWQgPSBzZWcucmVwbGFjZSgvW15hLXpBLVowLTlfOi5ALV0vZywgJycpO1xuICAgICAgY29uc3QgcyA9IHNlc3Npb25zLmdldChpZCk7XG4gICAgICBpZiAocyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnc2Vzc2lvbiBub3QgZm91bmQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBpZCwgbW9kZWw6ICdmYWtlLW1vZGVsJywgY3dkOiAnQzpcXFxcZGVtbycsXG4gICAgICAgIG1lc3NhZ2VzOiBbXG4gICAgICAgICAgeyByb2xlOiAndXNlcicsIHRleHQ6ICdcdTRFNEJcdTUyNERcdTc2ODRcdTRFRkJcdTUyQTEoZmFrZSBcdTk4ODRcdTg5QzgpJywgdG9vbHM6IFtdIH0sXG4gICAgICAgICAgeyByb2xlOiAnYXNzaXN0YW50JywgdGV4dDogJ1x1OEZEOVx1NjYyRlx1NTM4Nlx1NTNGMlx1NEYxQVx1OEJERFx1NzY4NFx1NTZERVx1NTkwRFx1OTg4NFx1ODlDOChmYWtlKVx1MzAwMicsIHRvb2xzOiBbJ3JlYWRfZmlsZSddIH0sXG4gICAgICAgIF0sXG4gICAgICB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2ZzJykge1xuICAgICAgLy8gXHU3NkVFXHU1RjU1XHU2RDRGXHU4OUM4KFx1NEUwRSBobWhhcm5lc3MgXHU1NDBDXHU1RjYyOnBhdGggXHU3NzAxXHU3NTY1PVx1NjgzOTtmaWxlcz0xIFx1OTY0NFx1NUUyNlx1NjU4N1x1NEVGNlx1NTIxN1x1ODg2OClcbiAgICAgIGNvbnN0IHEgPSB1cmwuc2VhcmNoUGFyYW1zLmdldCgncGF0aCcpID8/ICcnO1xuICAgICAgY29uc3Qgd2l0aEZpbGVzID0gdXJsLnNlYXJjaFBhcmFtcy5nZXQoJ2ZpbGVzJykgPT09ICcxJztcbiAgICAgIGlmIChxID09PSAnJykge1xuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICBwYXRoOiAnJywgc2VnbWVudHM6IFtdLCBwYXJlbnQ6ICcnLFxuICAgICAgICAgIGRpcnM6IFt7IG5hbWU6ICdkZW1vLXdvcmtzcGFjZScsIHBhdGg6ICdDOlxcXFxkZW1vJyB9XSxcbiAgICAgICAgICAuLi4od2l0aEZpbGVzID8geyBmaWxlczogW10gfSA6IHt9KSxcbiAgICAgICAgfSkpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIHBhdGg6IHEsIHNlZ21lbnRzOiBbeyBuYW1lOiBxLnNwbGl0KC9bXFxcXC9dLykuZmlsdGVyKEJvb2xlYW4pLnBvcCgpID8/IHEsIHBhdGg6IHEgfV0sIHBhcmVudDogJycsXG4gICAgICAgIGRpcnM6IFt7IG5hbWU6ICdzcmMnLCBwYXRoOiBgJHtxLnJlcGxhY2UoL1tcXFxcL10kLywgJycpfVxcXFxzcmNgIH1dLFxuICAgICAgICAuLi4od2l0aEZpbGVzID8geyBmaWxlczogW1xuICAgICAgICAgIHsgbmFtZTogJ1JFQURNRS5tZCcsIHBhdGg6IGAke3EucmVwbGFjZSgvW1xcXFwvXSQvLCAnJyl9XFxcXFJFQURNRS5tZGAsIHJlbDogJ1JFQURNRS5tZCcgfSxcbiAgICAgICAgICB7IG5hbWU6ICdwYWNrYWdlLmpzb24nLCBwYXRoOiBgJHtxLnJlcGxhY2UoL1tcXFxcL10kLywgJycpfVxcXFxwYWNrYWdlLmpzb25gLCByZWw6ICdwYWNrYWdlLmpzb24nIH0sXG4gICAgICAgIF0gfSA6IHt9KSxcbiAgICAgIH0pKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZnMvcmVhZCcpIHtcbiAgICAgIC8vIFx1NjU4N1x1NEVGNlx1OTg4NFx1ODlDOCg2NEtCIFx1NEUwQVx1OTY1MFx1OEJFRFx1NEU0OTtmYWtlIFx1OEZENFx1NTZERVx1NTZGQVx1NUI5QVx1NjU4N1x1NjcyQylcbiAgICAgIGNvbnN0IHAgPSB1cmwuc2VhcmNoUGFyYW1zLmdldCgncGF0aCcpID8/ICcnO1xuICAgICAgaWYgKHAgPT09ICcnKSB7XG4gICAgICAgIHJlcy53cml0ZUhlYWQoNDAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAncGF0aCByZXF1aXJlZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIHBhdGg6IHAsIHJlbDogcC5zcGxpdCgvW1xcXFwvXS8pLnBvcCgpID8/IHAsIHNpemU6IDQyLFxuICAgICAgICB0ZXh0OiAnIyBkZW1vIHdvcmtzcGFjZVxcblxcblx1OEZEOVx1NjYyRiBmYWtlIGhvc3QgXHU3Njg0XHU2NTg3XHU0RUY2XHU5ODg0XHU4OUM4XHU1MTg1XHU1QkI5XHUzMDAyXFxuJyxcbiAgICAgIH0pKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZGlmZicpIHtcbiAgICAgIC8vIERpZmYgXHU5NzYyXHU2NzdGKFx1NEUwRSBobWhhcm5lc3MgL2FwaS9kaWZmIFx1NTQwQ1x1NUY2MjtmYWtlIFx1OEZENFx1NTZERVx1NTZGQVx1NUI5QVx1NUMwRlx1NTNEOFx1NjZGNFx1OTZDNilcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgZ2l0OiB0cnVlLCBjd2Q6ICdDOlxcXFxkZW1vJyxcbiAgICAgICAgY2hhbmdlZDogW1xuICAgICAgICAgIHsgc3RhdGU6ICdNJywgcGF0aDogJ3NyYy9hcHAudHMnIH0sXG4gICAgICAgICAgeyBzdGF0ZTogJ0EnLCBwYXRoOiAnZG9jcy9ub3Rlcy5tZCcgfSxcbiAgICAgICAgXSxcbiAgICAgICAgc3RhdDogJyBzcmMvYXBwLnRzICAgICAgfCAxMiArKysrKysrLS0tXFxuIGRvY3Mvbm90ZXMubWQgICB8ICA0ICsrKytcXG4gMiBmaWxlcyBjaGFuZ2VkLCAxNiBpbnNlcnRpb25zKCspLCAzIGRlbGV0aW9ucygtKScsXG4gICAgICB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3dvcmtzcGFjZXMnKSB7XG4gICAgICAvLyBcdTVERTVcdTRGNUNcdTUzM0EoXHU0RTBFIGhtaGFybmVzcyBcdTU0MENcdTVGNjI6Y3VycmVudCArIGl0ZW1zKVxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBjdXJyZW50OiBmYWtlV29ya3NwYWNlcy5jdXJyZW50LFxuICAgICAgICBpdGVtczogZmFrZVdvcmtzcGFjZXMuaXRlbXMsXG4gICAgICB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS93b3Jrc3BhY2VzJykge1xuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgoYXdhaXQgcmVhZEJvZHkoKSkgfHwgJ3t9JykgYXMgeyBuYW1lPzogdW5rbm93bjsgcGF0aD86IHVua25vd24gfTtcbiAgICAgICAgY29uc3QgcGF0aCA9IHR5cGVvZiBib2R5LnBhdGggPT09ICdzdHJpbmcnID8gYm9keS5wYXRoIDogJyc7XG4gICAgICAgIGNvbnN0IG5hbWUgPSB0eXBlb2YgYm9keS5uYW1lID09PSAnc3RyaW5nJyAmJiBib2R5Lm5hbWUgIT09ICcnID8gYm9keS5uYW1lIDogKHBhdGguc3BsaXQoL1tcXFxcL10vKS5maWx0ZXIoQm9vbGVhbikucG9wKCkgPz8gJycpO1xuICAgICAgICBpZiAocGF0aCA9PT0gJycgfHwgbmFtZSA9PT0gJycpIHtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnYWJzb2x1dGUgcGF0aCBhbmQgbmFtZSByZXF1aXJlZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBpZiAoZmFrZVdvcmtzcGFjZXMuaXRlbXMuc29tZSgodykgPT4gdy5wYXRoLnRvTG93ZXJDYXNlKCkgPT09IHBhdGgudG9Mb3dlckNhc2UoKSkpIHtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwOSwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnd29ya3NwYWNlIGFscmVhZHkgcmVnaXN0ZXJlZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBpdGVtID0geyBpZDogYHdzLSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMiwgOCl9YCwgbmFtZSwgcGF0aCB9O1xuICAgICAgICBmYWtlV29ya3NwYWNlcy5pdGVtcy5wdXNoKGl0ZW0pO1xuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIGN1cnJlbnQ6IGZha2VXb3Jrc3BhY2VzLmN1cnJlbnQsIGl0ZW1zOiBmYWtlV29ya3NwYWNlcy5pdGVtcyB9KSk7XG4gICAgICB9KSgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvd29ya3NwYWNlcy91c2UnKSB7XG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7IGlkPzogdW5rbm93biB9O1xuICAgICAgICBjb25zdCBoaXQgPSBmYWtlV29ya3NwYWNlcy5pdGVtcy5maW5kKCh3KSA9PiB3LmlkID09PSBib2R5LmlkKTtcbiAgICAgICAgaWYgKGhpdCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3dvcmtzcGFjZSBub3QgZm91bmQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgZmFrZVdvcmtzcGFjZXMuY3VycmVudCA9IGhpdC5pZDtcbiAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlLCBjdXJyZW50OiBmYWtlV29ya3NwYWNlcy5jdXJyZW50LCBpdGVtczogZmFrZVdvcmtzcGFjZXMuaXRlbXMgfSkpO1xuICAgICAgfSkoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3Byb3ZpZGVycycpIHtcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoKGF3YWl0IHJlYWRCb2R5KCkpIHx8ICd7fScpIGFzIHsgbmFtZT86IHVua25vd247IGJhc2VVcmw/OiB1bmtub3duOyBtb2RlbD86IHVua25vd247IGFwaUtleT86IHVua25vd24gfTtcbiAgICAgICAgY29uc3QgbmFtZSA9IHR5cGVvZiBib2R5Lm5hbWUgPT09ICdzdHJpbmcnID8gYm9keS5uYW1lLnRyaW0oKSA6ICcnO1xuICAgICAgICBjb25zdCBiYXNlVXJsID0gdHlwZW9mIGJvZHkuYmFzZVVybCA9PT0gJ3N0cmluZycgPyBib2R5LmJhc2VVcmwudHJpbSgpIDogJyc7XG4gICAgICAgIGNvbnN0IG1vZGVsID0gdHlwZW9mIGJvZHkubW9kZWwgPT09ICdzdHJpbmcnID8gYm9keS5tb2RlbC50cmltKCkgOiAnJztcbiAgICAgICAgaWYgKG5hbWUgPT09ICcnIHx8IGJhc2VVcmwgPT09ICcnIHx8IG1vZGVsID09PSAnJykge1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICduYW1lLCBiYXNlVXJsIGFuZCBtb2RlbCBhcmUgcmVxdWlyZWQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgZmFrZVByb3ZpZGVycy5zZXQobmFtZSwgeyBiYXNlVXJsLCBtb2RlbCwgYXBpS2V5OiB0eXBlb2YgYm9keS5hcGlLZXkgPT09ICdzdHJpbmcnID8gYm9keS5hcGlLZXkgOiAnJyB9KTtcbiAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlLCBuYW1lIH0pKTtcbiAgICAgIH0pKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2NvZ25pdGl2ZScpIHtcbiAgICAgIC8vIFx1OEJBNFx1NzdFNVx1NzJCNlx1NjAwMShcdTRFMEUgaG1oYXJuZXNzIGNvZ25pdGl2ZVN0YXR1cyBcdTU0MENcdTVGNjJcdTVCNTBcdTk2QzY7XHU3RjNBXHU2NTcwXHU2MzZFXHU2NjNFXHU1RjBGIG51bGwpXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIG1lbW9yeTogeyBsYXllcnM6IDMsIGVudHJpZXM6IDEyLCBjb250cmFkaWN0aW9uczogMCB9LFxuICAgICAgICB0cmFqZWN0b3JpZXM6IDcsXG4gICAgICAgIGF1ZGl0RXZlbnRzOiAyMSxcbiAgICAgICAgd29ybGRNb2RlbDogeyB2ZXJzaW9uOiA0LCBiZWxpZWZzOiA5LCB0cnVzdGVkOiA1LCBicmllcjogMC4zMSB9LFxuICAgICAgICBjYWxpYnJhdGlvbjogeyBwcmVkaWN0aW9uczogNDYsIHJlbGlhYmlsaXR5OiAwLjcyIH0sXG4gICAgICB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9mYWtlL2VtaXQnKSB7XG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoKGF3YWl0IHJlYWRCb2R5KCkpIHx8ICd7fScpIGFzIHtcbiAgICAgICAgICAgIHNlc3Npb25JZDogc3RyaW5nOyBydW5JZDogc3RyaW5nOyBraW5kOiBFdmVudEtpbmQ7IHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgICAgIH07XG4gICAgICAgICAgY29uc3Qgc2VxID0gZW1pdChib2R5LnNlc3Npb25JZCwgYm9keS5ydW5JZCwgYm9keS5raW5kLCBib2R5LnBheWxvYWQpO1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlLCBzZXEgfSkpO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCBTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgfVxuICAgICAgfSkoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgYG5vIHJvdXRlICR7cmVxLm1ldGhvZH0gJHt1cmwucGF0aG5hbWV9YCwgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gIH0pO1xuXG4gIGF3YWl0IG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICBzZXJ2ZXIub25jZSgnZXJyb3InLCByZWplY3QpO1xuICAgIHNlcnZlci5saXN0ZW4oMCwgJzEyNy4wLjAuMScsICgpID0+IHJlc29sdmUoKSk7XG4gIH0pO1xuICBjb25zdCBhZGRyZXNzID0gc2VydmVyLmFkZHJlc3MoKTtcbiAgaWYgKGFkZHJlc3MgPT09IG51bGwgfHwgdHlwZW9mIGFkZHJlc3MgIT09ICdvYmplY3QnKSB0aHJvdyBuZXcgRXJyb3IoJ2Zha2UgaG9zdDogbm8gcG9ydCcpO1xuICBjb25zdCBwb3J0ID0gYWRkcmVzcy5wb3J0O1xuXG4gIGlmICghb3B0cy5xdWlldCkge1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KHsgaG1oRGVza3RvcEhvc3RSZWFkeTogdHJ1ZSwgcG9ydCwgdmVyc2lvbjogJ2Zha2UtMC4wLjAnIH0pfVxcbmApO1xuICB9XG4gIGNvbnN0IGRpZUFmdGVyID0gTnVtYmVyKHByb2Nlc3MuZW52LkZBS0VfSE9TVF9ESUVfQUZURVJfTVMgPz8gMCk7XG4gIGlmIChOdW1iZXIuaXNGaW5pdGUoZGllQWZ0ZXIpICYmIGRpZUFmdGVyID4gMCkge1xuICAgIHNldFRpbWVvdXQoKCkgPT4gcHJvY2Vzcy5leGl0KDEpLCBkaWVBZnRlcikudW5yZWYoKTtcbiAgfVxuXG4gIC8vIGNsb3NlKCk6IFx1NTE0OFx1NjVBRFx1NUYwMFx1NTE2OFx1OTBFOCBTU0UgXHU4RkRFXHU2M0E1KFx1NUI4M1x1NEVFQ1x1NkMzOFx1NEUwRFx1ODFFQVx1NzEzNlx1NTE3M1x1OTVFRCksXHU1NDI2XHU1MjE5IHNlcnZlci5jbG9zZVxuICAvLyBcdTRGMUFcdTRFMDBcdTc2RjRcdTdCNDlcdTZEM0JcdThEQzNcdThGREVcdTYzQTUsXHU2RDRCXHU4QkQ1XHU4RkRCXHU3QTBCXHU2MzAyXHU2QjdCXHUzMDAyXG4gIGNvbnN0IGNsb3NlID0gKCk6IFByb21pc2U8dm9pZD4gPT5cbiAgICBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4ge1xuICAgICAgZm9yIChjb25zdCBjIG9mIHNzZUNsaWVudHMpIHtcbiAgICAgICAgdHJ5IHsgYy5lbmQoKTsgYy5kZXN0cm95KCk7IH0gY2F0Y2ggeyAvKiBhbHJlYWR5IGdvbmUgKi8gfVxuICAgICAgfVxuICAgICAgc3NlQ2xpZW50cy5jbGVhcigpO1xuICAgICAgc2VydmVyLmNsb3NlKCgpID0+IHJlc29sdmUoKSk7XG4gICAgICBzZXRUaW1lb3V0KCgpID0+IHJlc29sdmUoKSwgMV8wMDApLnVucmVmKCk7XG4gICAgfSk7XG5cbiAgcmV0dXJuIHsgcG9ydCwgZW1pdCwgY2xvc2UgfTtcbn1cblxuLy8gXHU3NkY0XHU2M0E1XHU4RkQwXHU4ODRDKHN1cGVydmlzb3Igc3Bhd24gXHU3Njg0XHU1QjUwXHU4RkRCXHU3QTBCXHU1RjYyXHU2MDAxKVx1MzAwMnJlYWxwYXRoIFx1NkJENFx1OEY4MzpucG0gd29ya3NwYWNlXG4vLyBqdW5jdGlvbiAvIFx1NTkyN1x1NUMwRlx1NTE5OVx1NURFRVx1NUYwMlx1OTBGRFx1NEUwRFx1ODBGRFx1OEJBOVx1OEZEOVx1NEUyQVx1NjhDMFx1NkQ0Qlx1NTkzMVx1NjI0QihcdTU5MzFcdTYyNEI9XHU5NzU5XHU5RUQ4XHU5MDAwXHU1MUZBIGNvZGUgMCxcdTk2QkVcdTY3RTUpXHUzMDAyXG4vLyBjanMgYnVuZGxlKGVzYnVpbGQsXHU2MjUzXHU1MzA1XHU0RUE3XHU1NEMxKVx1NEUwQiBfX2ZpbGVuYW1lIFx1NUI1OFx1NTcyODtFU00odHN4L1x1NkU5MFx1NzgwMSlcdTc1MjggaW1wb3J0Lm1ldGFcdTMwMDJcbmNvbnN0IHNlbGZVcmw6IHN0cmluZyA9IHR5cGVvZiBfX2ZpbGVuYW1lID09PSAnc3RyaW5nJ1xuICA/IHBhdGhUb0ZpbGVVUkwocmVhbHBhdGhTeW5jKF9fZmlsZW5hbWUpKS5ocmVmXG4gIDogaW1wb3J0Lm1ldGEudXJsO1xuY29uc3QgaW52b2tlZEFzU2NyaXB0ID0gKCgpID0+IHtcbiAgaWYgKHByb2Nlc3MuYXJndlsxXSA9PT0gdW5kZWZpbmVkKSByZXR1cm4gZmFsc2U7XG4gIHRyeSB7XG4gICAgcmV0dXJuIHNlbGZVcmwgPT09IHBhdGhUb0ZpbGVVUkwocmVhbHBhdGhTeW5jKHByb2Nlc3MuYXJndlsxXSkpLmhyZWY7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufSkoKTtcbmlmIChpbnZva2VkQXNTY3JpcHQpIHtcbiAgY29uc3QgdG9rZW4gPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9UT0tFTiA/PyAnJztcbiAgLy8gRkFLRV9IT1NUX0RJRV9BVF9CT09UPTE6XHU1RjE1XHU1QkZDXHU4ODRDXHU4RjkzXHU1MUZBXHU1MjREXHU1MzczXHU2QjdCKFx1Njc4NFx1OTAyMFx1NTQyRlx1NTJBOFx1NjcxRiBSVU5USU1FX0NSQVNIRUQpXG4gIGlmIChwcm9jZXNzLmVudi5GQUtFX0hPU1RfRElFX0FUX0JPT1QgPT09ICcxJykge1xuICAgIHByb2Nlc3MuZXhpdCgxKTtcbiAgfVxuICBjb25zdCBzbG93ID0gTnVtYmVyKHByb2Nlc3MuZW52LkZBS0VfSE9TVF9TTE9XX0FGVEVSID8/IDApO1xuICBjb25zdCBib290ID0gKCk6IHZvaWQgPT4ge1xuICAgIHZvaWQgc3RhcnRGYWtlSG9zdCh7IHRva2VuIH0pLmNhdGNoKChlcnIpID0+IHtcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBmYWtlLWhvc3QgZmFpbGVkOiAke1N0cmluZyhlcnIpfVxcbmApO1xuICAgICAgcHJvY2Vzcy5leGl0KDEpO1xuICAgIH0pO1xuICB9O1xuICBpZiAoTnVtYmVyLmlzRmluaXRlKHNsb3cpICYmIHNsb3cgPiAwKSBzZXRUaW1lb3V0KGJvb3QsIHNsb3cpO1xuICBlbHNlIGJvb3QoKTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICI7QUFjQSxTQUFTLEtBQUssZUFBZSxRQUFRLFNBQVMsU0FBUyxhQUFhO0FBQ3BFLFNBQVMsWUFBWTtBQUNyQixTQUFTLGlCQUFpQjtBQUMxQixTQUFTLGlCQUFBQSxzQkFBcUI7OztBQ1A5QixTQUFTLGFBQWdDO0FBQ3pDLFNBQVMsdUJBQXVCO0FBQ2hDLFNBQVMsbUJBQW1COzs7QUNEckIsSUFBTSxjQUFjO0FBQUEsRUFDekI7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUNGO0FBSU8sSUFBTSx1QkFBdUI7OztBQ2xCN0IsSUFBTSxjQUFjO0FBQUEsRUFDekI7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUNGO0FBSU8sSUFBTSxtQkFBbUIsQ0FBQyxhQUFhLFVBQVUsVUFBVSxXQUFXO0FBY3RFLFNBQVMsYUFDZCxNQUNBLFNBQ0EsT0FBcUcsQ0FBQyxHQUN4RjtBQUNkLFFBQU0sSUFBa0IsRUFBRSxNQUFNLFNBQVMsV0FBVyxLQUFLLGNBQWMsS0FBSztBQUM1RSxNQUFJLEtBQUssY0FBYyxPQUFXLEdBQUUsWUFBWSxLQUFLO0FBQ3JELE1BQUksS0FBSyxVQUFVLE9BQVcsR0FBRSxRQUFRLEtBQUs7QUFDN0MsTUFBSSxLQUFLLG1CQUFtQixPQUFXLEdBQUUsaUJBQWlCLEtBQUs7QUFDL0QsU0FBTztBQUNUOzs7QUMxQkEsSUFBTSxXQUFXLENBQUMsTUFDaEIsT0FBTyxNQUFNLFlBQVksTUFBTSxRQUFRLENBQUMsTUFBTSxRQUFRLENBQUM7QUFFekQsSUFBTSxtQkFBbUIsQ0FBQyxNQUE0QixPQUFPLE1B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QUssQ0FBQztBQUMvQyxZQUFNLFFBQVMsTUFBTSxHQUFHO0FBQUE7QUFBQTtBQUFBO0FBQUEsU0FJckI7QUFDSCxZQUFNLElBQUksS0FBSyxNQUFNLEtBQUs7QUFDMUIsYUFBTyxDQUFDLEVBQUUsWUFBWSxlQUFlLEVBQUUsYUFBYSxHQUFHLFdBQVcsRUFBRSxPQUFPLFFBQVEsRUFBRSxRQUFRLEVBQUU7QUFBQSxJQUNqRyxDQUFDO0FBRUQsUUFBSSxTQUFTO0FBQ2IsZUFBVyxDQUFDLE1BQU0sSUFBSSxNQUFNLEtBQUssU0FBUztBQUN4QyxjQUFRLElBQUksaUJBQWlCLEtBQUssU0FBUyxNQUFNLE1BQU0sSUFBSSxNQUFNLE9BQU8sTUFBTSxDQUFDLEVBQUU7QUFDakYsVUFBSSxDQUFDLEdBQUksV0FBVTtBQUFBLElBQ3JCO0FBQ0EsWUFBUSxJQUFJLDhCQUE4QixRQUFRLFNBQVMsTUFBTSxJQUFJLFFBQVEsTUFBTSxFQUFFO0FBQ3JGLFFBQUksS0FBSyxXQUFXLElBQUksSUFBSSxDQUFDO0FBQUEsRUFDL0I7QUFHQSxNQUFJLEdBQUcsZUFBZSxDQUFDLE1BQU07QUFDM0IsUUFBSSxlQUFlLFFBQVEsV0FBVyxVQUFVLFdBQVc7QUFDekQsUUFBRSxlQUFlO0FBQ2pCLGdCQUFVLE1BQU07QUFDaEIsV0FBSyxXQUFXLEtBQUssRUFBRSxRQUFRLE1BQU0sSUFBSSxLQUFLLENBQUM7QUFBQSxJQUNqRDtBQUFBLEVBQ0YsQ0FBQztBQUNELE1BQUksR0FBRyxxQkFBcUIsTUFBTTtBQUNoQyxRQUFJLFFBQVEsYUFBYSxTQUFVLEtBQUksS0FBSztBQUFBLEVBQzlDLENBQUM7QUFDSDtBQTNkVztBQWVBO0FBa0hBO0FBWUE7QUFXQTtBQXdKQTsiLAogICJuYW1lcyI6IFsicGF0aFRvRmlsZVVSTCIsICJwdXNoRXZlbnQiLCAiYnJvYWRjYXN0SG9zdFN0YXRlIiwgInNlbmRlclRydXN0ZWQiLCAiaG9zdENhbGwiLCAicmVnaXN0ZXJJcGMiLCAiY3JlYXRlV2luZG93IiwgInBhdGhUb0ZpbGVVUkwiXQp9Cg==
