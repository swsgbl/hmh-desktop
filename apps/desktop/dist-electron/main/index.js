// apps/desktop/electron/main/index.ts
import { app, BrowserWindow, dialog, ipcMain, session, shell } from "electron";
import { join } from "node:path";
import { writeFile, readFile } from "node:fs/promises";
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
import { randomUUID } from "node:crypto";
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
  /** 每个带副作用的 POST 自动携带幂等键(03 §四防重放:请求使用 idempotencyKey;
   *  runtime 侧短期兼容忽略,协议先行——重试可凭键去重,不盲目重放)。 */
  async postJson(path, body, timeoutMs = 1e4) {
    let res;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: this.headers({
          "content-type": "application/json",
          "x-idempotency-key": randomUUID()
        }),
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
import { randomUUID as randomUUID2 } from "node:crypto";
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
      eventId: randomUUID2(),
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
          const attachments = Array.isArray(body.attachments) ? body.attachments.filter((a) => typeof a === "string") : [];
          if (!text) {
            res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify(desktopError("SCHEMA_MISMATCH", "text required", { retryable: false })));
            return;
          }
          const composed = attachments.length > 0 ? `[referenced files]
${attachments.map((a) => `- ${a.split(/[\\/]/).pop()}`).join("\n")}

${text}` : text;
          const runId = runTask(sessionId, composed, mode);
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
    if (req.method === "GET" && url.pathname === "/api/fs/search") {
      const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
      const all = [
        { rel: "README.md", path: "C:\\demo\\README.md", kind: "file" },
        { rel: "src/app.ts", path: "C:\\demo\\src\\app.ts", kind: "file" },
        { rel: "docs/notes.md", path: "C:\\demo\\docs\\notes.md", kind: "file" }
      ];
      const hits = q === "" ? all : all.filter((f) => f.rel.toLowerCase().includes(q));
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ results: hits.slice(0, 20), truncated: false, total: hits.length }));
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
    ipcMain.handle("bridge:send-task", (event, text, sessionId, mode, attachments) => {
      const task = typeof text === "string" ? text.slice(0, 2e4) : "";
      const sid = typeof sessionId === "string" ? sessionId.slice(0, 80) : "";
      const m = mode === "auto" || mode === "yolo" ? mode : "ask";
      const atts = Array.isArray(attachments) ? attachments.filter((a) => typeof a === "string").slice(0, 10) : [];
      if (task === "" || sid === "") return Promise.resolve({ ok: false, code: "BAD_REQUEST" });
      return hostCall2(event, (c) => c.postJson("/api/task", { text: task, sessionId: sid, mode: m, attachments: atts }));
    });
    ipcMain.handle("bridge:fs-search", (event, q) => {
      const query = typeof q === "string" ? q.slice(0, 200) : "";
      if (query === "") return Promise.resolve({ results: [] });
      return hostCall2(event, (c) => c.getJson(`/api/fs/search?q=${encodeURIComponent(query)}`));
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
  };
  pushEvent = pushEvent2, broadcastHostState = broadcastHostState2, senderTrusted = senderTrusted2, hostCall = hostCall2, registerIpc = registerIpc2;
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
  const windowStateFile = () => join(app.getPath("userData"), "window-state.json");
  async function loadBounds() {
    try {
      return JSON.parse(await readFile(windowStateFile(), "utf8"));
    } catch {
      return null;
    }
  }
  async function saveBounds(win) {
    try {
      await writeFile(windowStateFile(), JSON.stringify(win.getBounds()), "utf8");
    } catch {
    }
  }
  async function createWindow() {
    const saved = await loadBounds();
    const win = new BrowserWindow({
      width: saved?.width ?? 1440,
      height: saved?.height ?? 900,
      ...saved?.x !== void 0 && saved?.y !== void 0 ? { x: saved.x, y: saved.y } : {},
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
    win.on("close", () => {
      void saveBounds(win);
    });
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
    return win;
  }
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
    void createWindow().then((win) => {
      if (win !== null && process.env.HMH_DESKTOP_SECURITY_TEST === "1") {
        win.webContents.once("did-finish-load", () => {
          void securitySelfTest(win);
        });
      }
    });
    void startHost();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
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
      const allow = ["approve", "approvalGet", "approvalSet", "cognitive", "diff", "exportSession", "fsList", "fsRead", "fsSearch", "getState", "inject", "interrupt", "onEventBatches", "onHostState", "onStreamChunks", "providerSave", "providers", "sendTask", "sessionOp", "sessionPreview", "sessions", "stopHost", "workspaces", "workspaceAdd", "workspaceUse"];
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vZWxlY3Ryb24vbWFpbi9pbmRleC50cyIsICIuLi8uLi8uLi8uLi9wYWNrYWdlcy9ob3N0LWFkYXB0ZXIvc3JjL3N1cGVydmlzb3IudHMiLCAiLi4vLi4vLi4vLi4vcGFja2FnZXMvY29udHJhY3RzL3NyYy9ldmVudC50cyIsICIuLi8uLi8uLi8uLi9wYWNrYWdlcy9jb250cmFjdHMvc3JjL2Vycm9yLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2NvbnRyYWN0cy9zcmMvZ3VhcmRzLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2hvc3QtYWRhcHRlci9zcmMvY2xpZW50LnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2hvc3QtYWRhcHRlci9zcmMvZmFrZS1ob3N0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIEhNSCBEZXNrdG9wIFx1MjAxNCBFbGVjdHJvbiBcdTRFM0JcdThGREJcdTdBMEIoQURSLTAwMS8wMDMvMDA0KVx1MzAwMlxuICpcbiAqIFx1NUI4OVx1NTE2OFx1NEUwRFx1NTNEOFx1OTFDRihcdTVGMDBcdTUzRDFcdThCQTFcdTUyMTIgTTAgXHU1MUZBXHU1M0UzXHU5NUU4ICsgRWxlY3Ryb24gXHU1Qjk4XHU2NUI5XHU1Qjg5XHU1MTY4XHU2RTA1XHU1MzU1KTpcbiAqICAtIHJlbmRlcmVyOmNvbnRleHRJc29sYXRpb24gKyBzYW5kYm94ICsgXHU3OTgxIG5vZGVJbnRlZ3JhdGlvbixcdTRFMjVcdTY4M0MgQ1NQO1xuICogIC0gXHU1QkZDXHU4MjJBL1x1NjVCMFx1N0E5N1x1NTNFM1x1NEUwMFx1NUY4Qlx1NjJEMlx1N0VERChcdTUzRUFcdTUyQTBcdThGN0RcdTYyMTFcdTRFRUNcdTgxRUFcdTVERjFcdTc2ODQgcmVuZGVyZXIpO1xuICogIC0gXHU2QkNGXHU2NzYxIElQQyBcdTY4MjFcdTlBOEMgc2VuZGVyIFx1NzY4NFx1OTg3Nlx1NUM0MiBmcmFtZSBVUkwgXHU1QzVFXHU0RThFXHU2NzJDXHU1RTk0XHU3NTI4LFx1OTAxQVx1OTA1M1x1NzY3RFx1NTQwRFx1NTM1NTtcbiAqICAtIGhvc3QgdG9rZW4gXHU1M0VBXHU1QjU4XHU1NzI4XHU0RThFXHU2NzJDXHU4RkRCXHU3QTBCXHU0RTBFXHU1QjUwXHU4RkRCXHU3QTBCIGVudixcdTY1RTVcdTVGRDdcdThGOTNcdTUxRkFcdTUyNERcdTUxNDhcdTgxMzFcdTY1NEY7XG4gKiAgLSBcdTUzNTVcdTVCOUVcdTRGOEJcdTk1MDE7XHU5MDAwXHU1MUZBXHU2NUY2XHU1M0VBXHU1MDVDXHU2QjYyXHU4MUVBXHU1REYxIHNwYXduIFx1NzY4NCBob3N0KFx1NEYxOFx1OTZDNVx1MjE5Mlx1NTE1Q1x1NUU5NSBraWxsKVx1MzAwMlxuICpcbiAqIFx1OTYzNlx1NkJCNUUoMjAyNi0xMC0xMCk6bWFpbiBcdTYzMDFcdTY3MDkgRGVza3RvcEhvc3RDbGllbnQsU1NFIFx1NEZFMVx1NUMwMVx1NkQ0MShldmVudDogaG1oKVxuICogXHU3RUNGIDUwbXMgXHU2Mjc5XHU5MUNGXHU2M0E4XHU3RUQ5IHJlbmRlcmVyO3NlbmRUYXNrL2FwcHJvdmUvaW50ZXJydXB0L3Nlc3Npb25zIFx1NTE2OFx1OTBFOFx1OEY2Q1x1NTNEMVxuICogXHU3RUQ5IGhvc3QgXHUyMDE0XHUyMDE0IGZha2UgXHU0RTBFXHU3NzFGXHU1QjlFIGhtaGFybmVzcyBkZXNrdG9wLWhvc3QgXHU4RDcwXHU1NDBDXHU0RTAwXHU2NzYxXHU0RUUzXHU3ODAxXHU4REVGXHU1Rjg0XHUzMDAyXG4gKi9cbmltcG9ydCB7IGFwcCwgQnJvd3NlcldpbmRvdywgZGlhbG9nLCBpcGNNYWluLCBzZXNzaW9uLCBzaGVsbCB9IGZyb20gJ2VsZWN0cm9uJztcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdub2RlOnBhdGgnO1xuaW1wb3J0IHsgd3JpdGVGaWxlLCByZWFkRmlsZSB9IGZyb20gJ25vZGU6ZnMvcHJvbWlzZXMnO1xuaW1wb3J0IHsgcGF0aFRvRmlsZVVSTCB9IGZyb20gJ25vZGU6dXJsJztcbmltcG9ydCB7IHJhbmRvbVVVSUQgfSBmcm9tICdub2RlOmNyeXB0byc7XG5pbXBvcnQgeyBEZXNrdG9wUnVudGltZVN1cGVydmlzb3IsIERlc2t0b3BIb3N0Q2xpZW50LCBlbnZlbG9wZUZyb21GcmFtZSwgdHlwZSBIb3N0U3RhdGUgfSBmcm9tICdAaG1oLWRlc2t0b3AvaG9zdC1hZGFwdGVyJztcbmltcG9ydCB7IGlzRXZlbnRFbnZlbG9wZSwgdHlwZSBFdmVudEVudmVsb3BlIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyc7XG5cbmNvbnN0IGhlcmUgPSBpbXBvcnQubWV0YS5kaXJuYW1lID8/ICcuJztcbmNvbnN0IGlzRGV2ID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfREVWID09PSAnMSc7XG5jb25zdCByZW5kZXJlckRldlVybCA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1JFTkRFUkVSX1VSTCA/PyAnJztcbmNvbnN0IHByZWxvYWRQYXRoID0gam9pbihoZXJlLCAnLi4vcHJlbG9hZC9pbmRleC5janMnKTtcblxuLyogLS0tLSBcdTY1RTVcdTVGRDdcdTgxMzFcdTY1NEY6dG9rZW4vYXV0aG9yaXphdGlvbiBcdTZDMzhcdTRFMERcdThGREJcdTYzQTdcdTUyMzZcdTUzRjAgLS0tLSAqL1xuY29uc3Qgc2VjcmV0czogc3RyaW5nW10gPSBbXTtcbmZ1bmN0aW9uIHJlZGFjdChzOiBzdHJpbmcpOiBzdHJpbmcge1xuICBsZXQgb3V0ID0gcztcbiAgZm9yIChjb25zdCBzZWMgb2Ygc2VjcmV0cykge1xuICAgIGlmIChzZWMubGVuZ3RoID49IDgpIG91dCA9IG91dC5zcGxpdChzZWMpLmpvaW4oJ1tyZWRhY3RlZF0nKTtcbiAgfVxuICByZXR1cm4gb3V0O1xufVxuZnVuY3Rpb24gbG9nSW5mbyh0YWc6IHN0cmluZywgbXNnOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc29sZS5sb2coYFtobWgtZGVza3RvcDoke3RhZ31dICR7cmVkYWN0KG1zZyl9YCk7XG59XG5cbi8qIC0tLS0gXHU1MzU1XHU1QjlFXHU0RjhCIC0tLS0gKi9cbmlmICghYXBwLnJlcXVlc3RTaW5nbGVJbnN0YW5jZUxvY2soKSkge1xuICBhcHAucXVpdCgpO1xufSBlbHNlIHtcbiAgYXBwLm9uKCdzZWNvbmQtaW5zdGFuY2UnLCAoKSA9PiB7XG4gICAgY29uc3Qgd2luID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKClbMF07XG4gICAgaWYgKHdpbikge1xuICAgICAgaWYgKHdpbi5pc01pbmltaXplZCgpKSB3aW4ucmVzdG9yZSgpO1xuICAgICAgd2luLmZvY3VzKCk7XG4gICAgfVxuICB9KTtcblxuICAvKiAtLS0tIGhvc3QgXHU3NkQxXHU3QkExICsgXHU2ODY1XHU1QkEyXHU2MjM3XHU3QUVGIC0tLS0gKi9cbiAgaW50ZXJmYWNlIEJyaWRnZVNuYXBzaG90IHtcbiAgICBob3N0U3RhdGU6IEhvc3RTdGF0ZTtcbiAgICBob3N0UG9ydDogbnVtYmVyIHwgbnVsbDtcbiAgICBob3N0VmVyc2lvbjogc3RyaW5nIHwgbnVsbDtcbiAgICBsYXN0RXJyb3I6IHN0cmluZyB8IG51bGw7XG4gICAgbW9kZTogJ2Zha2UnIHwgJ3JlYWwnO1xuICB9XG4gIGxldCBzdXBlcnZpc29yOiBEZXNrdG9wUnVudGltZVN1cGVydmlzb3IgfCBudWxsID0gbnVsbDtcbiAgbGV0IGNsaWVudDogRGVza3RvcEhvc3RDbGllbnQgfCBudWxsID0gbnVsbDtcbiAgbGV0IGJyaWRnZTogQnJpZGdlU25hcHNob3QgPSB7IGhvc3RTdGF0ZTogJ3N0b3BwZWQnLCBob3N0UG9ydDogbnVsbCwgaG9zdFZlcnNpb246IG51bGwsIGxhc3RFcnJvcjogbnVsbCwgbW9kZTogJ2Zha2UnIH07XG4gIC8qKiBcdTRFOEJcdTRFRjZcdTYyNzlcdTkxQ0ZcdTdGMTNcdTUxQjI6XHU5QUQ4XHU5ODkxIFNTRSBcdTRFMERcdTkwMTBcdTY3NjFcdThGQzcgSVBDLDUwbXMgXHU2Mjc5XHU5MUNGIGZsdXNoKFx1NkUzMlx1NjdEM1x1NEUwRFx1NTM2MSlcdTMwMDIgKi9cbiAgbGV0IGV2ZW50QnVmZmVyOiBFdmVudEVudmVsb3BlW10gPSBbXTtcbiAgbGV0IGZsdXNoVGltZXI6IE5vZGVKUy5UaW1lb3V0IHwgbnVsbCA9IG51bGw7XG4gIGxldCBzc2VBYm9ydDogQWJvcnRDb250cm9sbGVyIHwgbnVsbCA9IG51bGw7XG4gIGxldCBsYXN0RXZlbnRJZCA9ICcnO1xuICAvKiogXHU2NzJBXHU3N0U1L1x1NzU3OFx1NUY2Mlx1NEZFMVx1NUMwMVx1OEJBMVx1NjU3MChTQ0hFTUFfTUlTTUFUQ0ggXHU5NzYyXHU1NDExXHU4QkNBXHU2NUFELFx1NEUwRFx1NUQyOSlcdTMwMDIgKi9cbiAgbGV0IGRyb3BwZWRGcmFtZXMgPSAwO1xuXG4gIGZ1bmN0aW9uIHB1c2hFdmVudChlbnY6IEV2ZW50RW52ZWxvcGUpOiB2b2lkIHtcbiAgICBldmVudEJ1ZmZlci5wdXNoKGVudik7XG4gICAgaWYgKGV2ZW50QnVmZmVyLmxlbmd0aCA+IDJfMDAwKSBldmVudEJ1ZmZlci5zcGxpY2UoMCwgZXZlbnRCdWZmZXIubGVuZ3RoIC0gMl8wMDApO1xuICAgIGlmIChmbHVzaFRpbWVyID09PSBudWxsKSB7XG4gICAgICBmbHVzaFRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgIGZsdXNoVGltZXIgPSBudWxsO1xuICAgICAgICBjb25zdCBiYXRjaCA9IGV2ZW50QnVmZmVyO1xuICAgICAgICBldmVudEJ1ZmZlciA9IFtdO1xuICAgICAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcbiAgICAgICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCdicmlkZ2U6ZXZlbnQtYmF0Y2gnLCBiYXRjaCk7XG4gICAgICAgIH1cbiAgICAgIH0sIDUwKTtcbiAgICB9XG4gIH1cblxuICBmdW5jdGlvbiBicm9hZGNhc3RIb3N0U3RhdGUoczogSG9zdFN0YXRlLCBpbmZvOiB7IHJlc3RhcnRDb3VudDogbnVtYmVyOyBsYXN0RXJyb3I/OiBzdHJpbmcgfSk6IHZvaWQge1xuICAgIGJyaWRnZSA9IHsgLi4uYnJpZGdlLCBob3N0U3RhdGU6IHMsIGhvc3RQb3J0OiBzdXBlcnZpc29yPy5lbmRwb2ludD8ucG9ydCA/PyBudWxsLCBob3N0VmVyc2lvbjogc3VwZXJ2aXNvcj8uZW5kcG9pbnQ/LnZlcnNpb24gPz8gbnVsbCB9O1xuICAgIGxvZ0luZm8oJ2hvc3QnLCBgc3RhdGU9JHtzfSR7aW5mby5sYXN0RXJyb3IgIT09IHVuZGVmaW5lZCA/IGAgZXJyPSR7aW5mby5sYXN0RXJyb3J9YCA6ICcnfWApO1xuICAgIGZvciAoY29uc3QgdyBvZiBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKSkge1xuICAgICAgaWYgKCF3LmlzRGVzdHJveWVkKCkpIHcud2ViQ29udGVudHMuc2VuZCgnYnJpZGdlOmhvc3Qtc3RhdGUnLCBzLCBpbmZvKTtcbiAgICB9XG4gIH1cblxuICAvKiogU1NFIFx1NkQ0MVx1OEJBMlx1OTYwNTpcdTRGRTFcdTVDMDEoZXZlbnQ6IGhtaClcdTYyNzlcdTkxQ0ZcdTYzQTggcmVuZGVyZXI7XHU5QUQ4XHU5ODkxIGRlbHRhL2xpbmUgXHU1MzlGXHU1RTI3XG4gICAqICBcdTRGNUNcdTRFM0FcdTZENDFcdTU3NTdcdThGNkNcdTUzRDEocmVuZGVyZXIgXHU2MkZDXHU2M0E1XHU1RjUzXHU1MjREIGFzc2lzdGFudCBcdTUzNjBcdTRGNEQpXHUzMDAyXHU2NUFEXHU3RUJGXHU4MUVBXHU1MkE4XHU5MUNEXHU4RkRFXHUzMDAyICovXG4gIGFzeW5jIGZ1bmN0aW9uIHB1bXBFdmVudHMoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKGNsaWVudCA9PT0gbnVsbCkgcmV0dXJuO1xuICAgIGZvciAoOzspIHtcbiAgICAgIGNvbnN0IGMgPSBjbGllbnQ7XG4gICAgICBpZiAoYyA9PT0gbnVsbCkgcmV0dXJuO1xuICAgICAgdHJ5IHtcbiAgICAgICAgZm9yIGF3YWl0IChjb25zdCBmcmFtZSBvZiBjLnJhd0V2ZW50cyhsYXN0RXZlbnRJZCA9PT0gJycgPyB1bmRlZmluZWQgOiBsYXN0RXZlbnRJZCwgc3NlQWJvcnQ/LnNpZ25hbCkpIHtcbiAgICAgICAgICBpZiAoZnJhbWUuZXZlbnQgPT09ICdobWgnKSB7XG4gICAgICAgICAgICBjb25zdCBlbnYgPSBlbnZlbG9wZUZyb21GcmFtZShmcmFtZSk7XG4gICAgICAgICAgICBpZiAoZW52ID09PSBudWxsKSB7XG4gICAgICAgICAgICAgIGRyb3BwZWRGcmFtZXMgKz0gMTtcbiAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBsYXN0RXZlbnRJZCA9IGVudi5ldmVudElkO1xuICAgICAgICAgICAgcHVzaEV2ZW50KGVudik7XG4gICAgICAgICAgfSBlbHNlIGlmIChmcmFtZS5ldmVudCA9PT0gJ2RlbHRhJyB8fCBmcmFtZS5ldmVudCA9PT0gJ2xpbmUnKSB7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICBjb25zdCBkID0gSlNPTi5wYXJzZShmcmFtZS5kYXRhKSBhcyB7IHNlc3Npb25JZD86IHN0cmluZzsgaz86IHN0cmluZzsgY2h1bms/OiBzdHJpbmc7IHRleHQ/OiBzdHJpbmcgfTtcbiAgICAgICAgICAgICAgY29uc3QgcGF5bG9hZCA9IGZyYW1lLmV2ZW50ID09PSAnZGVsdGEnXG4gICAgICAgICAgICAgICAgPyB7IHNlc3Npb25JZDogZC5zZXNzaW9uSWQgPz8gJycsIGtpbmQ6IGQuayA/PyAndGV4dCcsIGNodW5rOiBTdHJpbmcoZC5jaHVuayA/PyAnJykgfVxuICAgICAgICAgICAgICAgIDogeyBzZXNzaW9uSWQ6IGQuc2Vzc2lvbklkID8/ICcnLCBraW5kOiAnbGluZScsIGNodW5rOiBTdHJpbmcoZC50ZXh0ID8/ICcnKSB9O1xuICAgICAgICAgICAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcbiAgICAgICAgICAgICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCdicmlkZ2U6c3RyZWFtLWNodW5rJywgcGF5bG9hZCk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gY2F0Y2ggeyAvKiBtYWxmb3JtZWQgc3RyZWFtIGZyYW1lOiBza2lwICovIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuOyAvLyBcdTZENDFcdTZCNjNcdTVFMzhcdTdFRDNcdTY3NUYoaG9zdCBcdTUxNzNcdTk1RUQpXG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLy8gXHU2NUFEXHU3RUJGOlx1NzdFRFx1OTAwMFx1OTA3Rlx1NTQwRVx1OTFDRFx1OEZERShzdXBlcnZpc29yIFx1NTNFRlx1ODBGRFx1NkI2M1x1NTcyOFx1OTFDRFx1NTQyRiBob3N0KVxuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCAxXzAwMCkpO1xuICAgICAgICBpZiAoc3NlQWJvcnQ/LnNpZ25hbC5hYm9ydGVkKSByZXR1cm47XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLyoqIGRldiBcdTlFRDhcdThCQTQgZmFrZSBob3N0O0hNSF9ERVNLVE9QX1JFQUw9MSBcdTY1RjZcdThGREVcdTc3MUZcdTVCOUUgaG1oYXJuZXNzIGRlc2t0b3AtaG9zdFx1MzAwMlxuICAgKiAgXHU2Q0U4XHU2MTBGOkVsZWN0cm9uIFx1NEUzQlx1OEZEQlx1N0EwQlx1NzY4NCBwcm9jZXNzLmV4ZWNQYXRoIFx1NjYyRiBlbGVjdHJvbi5leGVcdTIwMTRcdTIwMTRob3N0IFx1NUI1MFx1OEZEQlx1N0EwQlxuICAgKiAgXHU1RkM1XHU5ODdCXHU1RTI2IEVMRUNUUk9OX1JVTl9BU19OT0RFPTEgXHU2MjREXHU0RjFBXHU0RUU1XHU3RUFGIG5vZGUgXHU4QkVEXHU0RTQ5XHU4REQxXHUzMDAyXG4gICAqICBcdTYyNTNcdTUzMDVcdTRFQTdcdTU0QzEoYXBwLmlzUGFja2FnZWQpOmZha2UgaG9zdCBcdTc1MjggZXh0cmFSZXNvdXJjZXMgXHU5MUNDXHU3Njg0XHU4MUVBXHU1MzA1XHU1NDJCIGNqcztcbiAgICogIFx1NzcxRlx1NUI5RSBydW50aW1lIFx1OTcwMCBITUhfREVTS1RPUF9SRUFMX0VOVFJZIFx1NjMwN1x1NTQxMSBkZXNrdG9wLWhvc3QgXHU1MTY1XHU1M0UzKFx1NEVBN1x1NTRDMVx1NTMxNlxuICAgKiAgXHU3Njg0IHJ1bnRpbWUgXHU2MzQ2XHU3RUQxXHU1QzVFXHU1NDBFXHU3RUVEXHU4QkJFXHU4QkExLFx1ODlDMVx1OUE4Q1x1NjUzNlx1NjJBNVx1NTQ0QSlcdTMwMDIgKi9cbiAgYXN5bmMgZnVuY3Rpb24gc3RhcnRIb3N0KCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IHVzZVJlYWwgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9SRUFMID09PSAnMSc7XG4gICAgYnJpZGdlID0geyAuLi5icmlkZ2UsIG1vZGU6IHVzZVJlYWwgPyAncmVhbCcgOiAnZmFrZScgfTtcbiAgICBjb25zdCByZXBvUm9vdCA9IGpvaW4oaGVyZSwgJy4uJywgJy4uJywgJy4uJywgJy4uJyk7IC8vIGFwcHMvZGVza3RvcC9kaXN0LWVsZWN0cm9uL21haW4gXHUyMTkyIHJlcG8gcm9vdFxuICAgIGNvbnN0IHBhY2thZ2VkID0gYXBwLmlzUGFja2FnZWQ7XG4gICAgbGV0IHNwZWM6IHsgY29tbWFuZDogc3RyaW5nOyBhcmdzOiBzdHJpbmdbXTsgZW52OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IH07XG4gICAgaWYgKHVzZVJlYWwpIHtcbiAgICAgIGNvbnN0IGVudHJ5ID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfUkVBTF9FTlRSWSA/PyAocGFja2FnZWQgPyAnJyA6IGpvaW4ocmVwb1Jvb3QsICcuLicsICdobWhhcm5lc3MnLCAncGFja2FnZXMnLCAnd2ViJywgJ3NyYycsICdkZXNrdG9wLWhvc3QudHMnKSk7XG4gICAgICBpZiAoZW50cnkgPT09ICcnKSB7XG4gICAgICAgIGJyaWRnZSA9IHsgLi4uYnJpZGdlLCBob3N0U3RhdGU6ICdmYWlsZWQnLCBsYXN0RXJyb3I6ICdcdTc3MUZcdTVCOUUgcnVudGltZSBcdTY3MkFcdTkxNERcdTdGNkU6XHU2MjUzXHU1MzA1XHU0RUE3XHU1NEMxXHU5NzAwXHU4QkJFXHU3RjZFIEhNSF9ERVNLVE9QX1JFQUxfRU5UUlkgXHU2MzA3XHU1NDExIGhtaGFybmVzcyBkZXNrdG9wLWhvc3QgXHU1MTY1XHU1M0UzJyB9O1xuICAgICAgICBsb2dJbmZvKCdob3N0JywgJ3JlYWwgbW9kZSB3aXRob3V0IEhNSF9ERVNLVE9QX1JFQUxfRU5UUlkgaW4gcGFja2FnZWQgYXBwJyk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHNwZWMgPSB7XG4gICAgICAgIGNvbW1hbmQ6IHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgICAgIGFyZ3M6IFsnLS1pbXBvcnQnLCAndHN4JywgZW50cnldLFxuICAgICAgICBlbnY6IHsgRUxFQ1RST05fUlVOX0FTX05PREU6ICcxJyB9LFxuICAgICAgfTtcbiAgICB9IGVsc2UgaWYgKHBhY2thZ2VkKSB7XG4gICAgICBzcGVjID0ge1xuICAgICAgICBjb21tYW5kOiBwcm9jZXNzLmV4ZWNQYXRoLFxuICAgICAgICBhcmdzOiBbam9pbihwcm9jZXNzLnJlc291cmNlc1BhdGgsICdmYWtlLWhvc3QuY2pzJyldLFxuICAgICAgICBlbnY6IHsgRUxFQ1RST05fUlVOX0FTX05PREU6ICcxJyB9LFxuICAgICAgfTtcbiAgICB9IGVsc2Uge1xuICAgICAgc3BlYyA9IHtcbiAgICAgICAgY29tbWFuZDogcHJvY2Vzcy5leGVjUGF0aCxcbiAgICAgICAgLy8gXHU3NkY0XHU2M0E1XHU4RDcwXHU1MzA1XHU3NzFGXHU1QjlFXHU4REVGXHU1Rjg0KG5vZGVfbW9kdWxlcyBcdTkxQ0NcdTc2ODQgd29ya3NwYWNlIGp1bmN0aW9uIFx1NEYxQVx1ODhBQiBFU01cbiAgICAgICAgLy8gcmVhbHBhdGggXHU1MzE2LFx1NUJGQ1x1ODFGNCBmYWtlLWhvc3QgXHU3Njg0IGFyZ3ZbMV0vaW1wb3J0Lm1ldGEudXJsIFx1NTMzOVx1OTE0RFx1NTkzMVx1NjU0OClcbiAgICAgICAgYXJnczogWyctLWltcG9ydCcsICd0c3gnLCBqb2luKHJlcG9Sb290LCAncGFja2FnZXMnLCAnaG9zdC1hZGFwdGVyJywgJ3NyYycsICdmYWtlLWhvc3QudHMnKV0sXG4gICAgICAgIGVudjogeyBFTEVDVFJPTl9SVU5fQVNfTk9ERTogJzEnIH0sXG4gICAgICB9O1xuICAgIH1cbiAgICBzdXBlcnZpc29yID0gbmV3IERlc2t0b3BSdW50aW1lU3VwZXJ2aXNvcihzcGVjLCB7XG4gICAgICBvblN0YXRlQ2hhbmdlOiBicm9hZGNhc3RIb3N0U3RhdGUsXG4gICAgICAvLyBcdTk5OTZcdTZCMjFcdTU0MkZcdTUyQThcdTRFMEUgY3Jhc2ggXHU4MUVBXHU2MTA4XHU1NDBFXHU3Njg0XHU5MUNEXHU1NDJGXHU5MEZEXHU0RjFBXHU4RDcwXHU4RkQ5XHU5MUNDOlx1N0FFRlx1NTNFMy90b2tlbiBcdTkwRkRcdTY2MkZcdTY1QjBcdTc2ODQsXG4gICAgICAvLyBcdTkxQ0RcdTVFRkFcdTY4NjVcdTVCQTJcdTYyMzdcdTdBRUZcdTVFNzZcdTkxQ0RcdTY1QjBcdThCQTJcdTk2MDUgU1NFKHJlbmRlcmVyIFx1NzY4NCBFdmVudFN0b3JlIFx1OTc2MCBldmVudElkIFx1NTNCQlx1OTFDRClcbiAgICAgIG9uUmVhZHk6IChlcCkgPT4ge1xuICAgICAgICBjbGllbnQgPSBuZXcgRGVza3RvcEhvc3RDbGllbnQoYGh0dHA6Ly8xMjcuMC4wLjE6JHtlcC5wb3J0fWAsIGVwLnRva2VuKTtcbiAgICAgICAgc3NlQWJvcnQ/LmFib3J0KCk7XG4gICAgICAgIHNzZUFib3J0ID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICAgICAgICBsYXN0RXZlbnRJZCA9ICcnO1xuICAgICAgICB2b2lkIHB1bXBFdmVudHMoKTtcbiAgICAgICAgbG9nSW5mbygnaG9zdCcsIGBicmlkZ2UgcmVhZHkgb24gMTI3LjAuMC4xOiR7ZXAucG9ydH0gKHJ1bnRpbWUgJHtlcC52ZXJzaW9ufSwgbW9kZSAke2JyaWRnZS5tb2RlfSlgKTtcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IHN1cGVydmlzb3Iuc3RhcnQoKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGNvbnN0IGRldGFpbCA9ICgoKSA9PiB7IHRyeSB7IHJldHVybiBKU09OLnN0cmluZ2lmeShlcnIpOyB9IGNhdGNoIHsgcmV0dXJuIFN0cmluZyhlcnIpOyB9IH0pKCkuc2xpY2UoMCwgNDAwKTtcbiAgICAgIGJyaWRnZSA9IHsgLi4uYnJpZGdlLCBob3N0U3RhdGU6ICdmYWlsZWQnLCBsYXN0RXJyb3I6IGRldGFpbCB9O1xuICAgICAgbG9nSW5mbygnaG9zdCcsIGBzdGFydCBmYWlsZWQ6ICR7ZGV0YWlsfWApO1xuICAgIH1cbiAgfVxuXG4gIC8qIC0tLS0gSVBDIFx1NzY3RFx1NTQwRFx1NTM1NSArIHNlbmRlciBcdTY4MjFcdTlBOEMgLS0tLSAqL1xuICBjb25zdCBhbGxvd2VkT3JpZ2lucyA9IG5ldyBTZXQ8c3RyaW5nPihcbiAgICBpc0RldiAmJiByZW5kZXJlckRldlVybFxuICAgICAgPyBbcmVuZGVyZXJEZXZVcmxdXG4gICAgICA6IFtwYXRoVG9GaWxlVVJMKGpvaW4oaGVyZSwgJy4uJywgJy4uJywgJ2Rpc3QtcmVuZGVyZXInLCAnaW5kZXguaHRtbCcpKS5ocmVmXSxcbiAgKTtcblxuICBmdW5jdGlvbiBzZW5kZXJUcnVzdGVkKHNlbmRlckZyYW1lOiBFbGVjdHJvbi5XZWJGcmFtZU1haW4gfCBudWxsIHwgdW5kZWZpbmVkKTogYm9vbGVhbiB7XG4gICAgaWYgKHNlbmRlckZyYW1lID09PSBudWxsIHx8IHNlbmRlckZyYW1lID09PSB1bmRlZmluZWQpIHJldHVybiBmYWxzZTtcbiAgICBsZXQgdG9wOiBFbGVjdHJvbi5XZWJGcmFtZU1haW4gfCBudWxsID0gc2VuZGVyRnJhbWU7XG4gICAgd2hpbGUgKHRvcD8ucGFyZW50ICE9PSBudWxsICYmIHRvcD8ucGFyZW50ICE9PSB1bmRlZmluZWQpIHRvcCA9IHRvcC5wYXJlbnQ7XG4gICAgY29uc3QgdXJsID0gdG9wPy51cmwgPz8gJyc7XG4gICAgZm9yIChjb25zdCBvcmlnaW4gb2YgYWxsb3dlZE9yaWdpbnMpIHtcbiAgICAgIGlmICh1cmwgPT09IG9yaWdpbiB8fCB1cmwuc3RhcnRzV2l0aChgJHtvcmlnaW59L2ApIHx8IHVybC5zdGFydHNXaXRoKGAke29yaWdpbn0/YCkpIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICAvKiogXHU5NzAwXHU4OTgxIGhvc3QgXHU1QzMxXHU3RUVBXHU3Njg0IElQQyBoYW5kbGVyIFx1NTE2Q1x1NTE3MVx1NThGMzpcdTY3MkFcdTVDMzFcdTdFRUFcdThGRDRcdTU2REVcdTdFRDNcdTY3ODRcdTUzMTZcdTk1MTlcdThCRUZcdTMwMDIgKi9cbiAgZnVuY3Rpb24gaG9zdENhbGw8VD4oZXZlbnQ6IEVsZWN0cm9uLklwY01haW5JbnZva2VFdmVudCwgZm46IChjOiBEZXNrdG9wSG9zdENsaWVudCkgPT4gUHJvbWlzZTxUPik6IFByb21pc2U8VCB8IHsgZXJyb3I6IHN0cmluZzsgY29kZTogc3RyaW5nIH0+IHtcbiAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfSk7XG4gICAgaWYgKGNsaWVudCA9PT0gbnVsbCB8fCBicmlkZ2UuaG9zdFN0YXRlICE9PSAncmVhZHknKSB7XG4gICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6IGBob3N0IG5vdCByZWFkeSAoJHticmlkZ2UuaG9zdFN0YXRlfSlgLCBjb2RlOiAnSE9TVF9OT1RfUkVBRFknIH0pO1xuICAgIH1cbiAgICByZXR1cm4gZm4oY2xpZW50KS5jYXRjaCgoZXJyOiB1bmtub3duKSA9PiB7XG4gICAgICBjb25zdCBkZXRhaWwgPSAoKCkgPT4geyB0cnkgeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkoZXJyKTsgfSBjYXRjaCB7IHJldHVybiBTdHJpbmcoZXJyKTsgfSB9KSgpLnNsaWNlKDAsIDMwMCk7XG4gICAgICByZXR1cm4geyBlcnJvcjogZGV0YWlsLCBjb2RlOiAnQlJJREdFX0VSUk9SJyB9O1xuICAgIH0pO1xuICB9XG5cbiAgZnVuY3Rpb24gcmVnaXN0ZXJJcGMoKTogdm9pZCB7XG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpnZXQtc3RhdGUnLCAoZXZlbnQpID0+IHtcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicgfTtcbiAgICAgIHJldHVybiB7IC4uLmJyaWRnZSwgZHJvcHBlZEZyYW1lcyB9O1xuICAgIH0pO1xuXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpzZXNzaW9ucycsIChldmVudCkgPT5cbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPHsgc2Vzc2lvbnM6IEFycmF5PHsgaWQ6IHN0cmluZzsgdGl0bGU6IHN0cmluZzsgdGFzazogc3RyaW5nOyBvdXRjb21lOiBzdHJpbmc7IHR1cm5zOiBudW1iZXI7IHRvb2xVc2VzOiBudW1iZXI7IHRpbWU6IHN0cmluZzsgY3dkOiBzdHJpbmc7IGNyZWF0ZWRBdDogc3RyaW5nOyB1cGRhdGVkQXQ6IHN0cmluZyB9PiB9PignL2FwaS9zZXNzaW9ucz9saW1pdD0xMDAnKSkpO1xuXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpzZW5kLXRhc2snLCAoZXZlbnQsIHRleHQ6IHVua25vd24sIHNlc3Npb25JZDogdW5rbm93biwgbW9kZTogdW5rbm93biwgYXR0YWNobWVudHM6IHVua25vd24pID0+IHtcbiAgICAgIGNvbnN0IHRhc2sgPSB0eXBlb2YgdGV4dCA9PT0gJ3N0cmluZycgPyB0ZXh0LnNsaWNlKDAsIDIwXzAwMCkgOiAnJztcbiAgICAgIGNvbnN0IHNpZCA9IHR5cGVvZiBzZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gc2Vzc2lvbklkLnNsaWNlKDAsIDgwKSA6ICcnO1xuICAgICAgY29uc3QgbSA9IG1vZGUgPT09ICdhdXRvJyB8fCBtb2RlID09PSAneW9sbycgPyBtb2RlIDogJ2Fzayc7XG4gICAgICAvLyBcdTk2NDRcdTRFRjY6XHU1NDBFXHU3QUVGXHU2Mzg4XHU2NzQzIERUTyBcdTc2ODRcdTdFRERcdTVCRjlcdThERUZcdTVGODQoQCBcdTkwMDlcdTYyRTlcdTU2NjhcdTUzRUFcdTY3NjVcdTgxRUEgL2FwaS9mcy9zZWFyY2gpXG4gICAgICBjb25zdCBhdHRzID0gQXJyYXkuaXNBcnJheShhdHRhY2htZW50cykgPyBhdHRhY2htZW50cy5maWx0ZXIoKGEpOiBhIGlzIHN0cmluZyA9PiB0eXBlb2YgYSA9PT0gJ3N0cmluZycpLnNsaWNlKDAsIDEwKSA6IFtdO1xuICAgICAgaWYgKHRhc2sgPT09ICcnIHx8IHNpZCA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBvazogZmFsc2UsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW47IHJ1bklkPzogc3RyaW5nIH0+KCcvYXBpL3Rhc2snLCB7IHRleHQ6IHRhc2ssIHNlc3Npb25JZDogc2lkLCBtb2RlOiBtLCBhdHRhY2htZW50czogYXR0cyB9KSk7XG4gICAgfSk7XG5cbiAgICAvLyAtLS0tIEAgXHU5NjQ0XHU0RUY2Olx1NURFNVx1NEY1Q1x1NTMzQVx1NjU4N1x1NEVGNlx1NjQxQ1x1N0QyMihydW50aW1lIFx1NjM4OFx1Njc0M1x1NzY4NFx1OERFRlx1NUY4NFx1Njc2NVx1NkU5MCkgLS0tLVxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6ZnMtc2VhcmNoJywgKGV2ZW50LCBxOiB1bmtub3duKSA9PiB7XG4gICAgICBjb25zdCBxdWVyeSA9IHR5cGVvZiBxID09PSAnc3RyaW5nJyA/IHEuc2xpY2UoMCwgMjAwKSA6ICcnO1xuICAgICAgaWYgKHF1ZXJ5ID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IHJlc3VsdHM6IFtdIH0pO1xuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPHsgcmVzdWx0czogQXJyYXk8eyByZWw6IHN0cmluZzsgcGF0aDogc3RyaW5nIH0+IH0+KGAvYXBpL2ZzL3NlYXJjaD9xPSR7ZW5jb2RlVVJJQ29tcG9uZW50KHF1ZXJ5KX1gKSk7XG4gICAgfSk7XG5cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmFwcHJvdmUnLCAoZXZlbnQsIGdyYW50ZWQ6IHVua25vd24sIHNlc3Npb25JZDogdW5rbm93bikgPT5cbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KCcvYXBpL2FwcHJvdmUnLCB7XG4gICAgICAgIGdyYW50ZWQ6IGdyYW50ZWQgPT09IHRydWUsXG4gICAgICAgIHNlc3Npb25JZDogdHlwZW9mIHNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBzZXNzaW9uSWQuc2xpY2UoMCwgODApIDogJycsXG4gICAgICB9KSkpO1xuXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTppbnRlcnJ1cHQnLCAoZXZlbnQsIHNlc3Npb25JZDogdW5rbm93bikgPT5cbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KCcvYXBpL2ludGVycnVwdCcsIHtcbiAgICAgICAgc2Vzc2lvbklkOiB0eXBlb2Ygc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IHNlc3Npb25JZC5zbGljZSgwLCA4MCkgOiAnJyxcbiAgICAgIH0pKSk7XG5cbiAgICAvLyAtLS0tIE00Olx1NURFNVx1NEY1Q1x1NTMzQVx1NjU4N1x1NEVGNlx1OTc2MihcdThERUZcdTVGODRcdTYzODhcdTY3NDNcdTU3MjggcnVudGltZTppbnNpZGVXcyBcdTY4MjFcdTlBOEMpIC0tLS1cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmZzLWxpc3QnLCAoZXZlbnQsIHBhdGg6IHVua25vd24pID0+IHtcbiAgICAgIGNvbnN0IHAgPSB0eXBlb2YgcGF0aCA9PT0gJ3N0cmluZycgPyBwYXRoLnNsaWNlKDAsIDEwMDApIDogJyc7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KGAvYXBpL2ZzP2ZpbGVzPTEke3AgIT09ICcnID8gYCZwYXRoPSR7ZW5jb2RlVVJJQ29tcG9uZW50KHApfWAgOiAnJ31gKSk7XG4gICAgfSk7XG5cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmZzLXJlYWQnLCAoZXZlbnQsIHBhdGg6IHVua25vd24pID0+IHtcbiAgICAgIGNvbnN0IHAgPSB0eXBlb2YgcGF0aCA9PT0gJ3N0cmluZycgPyBwYXRoLnNsaWNlKDAsIDEwMDApIDogJyc7XG4gICAgICBpZiAocCA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ3BhdGggcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPFJlY29yZDxzdHJpbmcsIHVua25vd24+PihgL2FwaS9mcy9yZWFkP3BhdGg9JHtlbmNvZGVVUklDb21wb25lbnQocCl9YCkpO1xuICAgIH0pO1xuXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTppbmplY3QnLCAoZXZlbnQsIHRleHQ6IHVua25vd24sIHNlc3Npb25JZDogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3QgdCA9IHR5cGVvZiB0ZXh0ID09PSAnc3RyaW5nJyA/IHRleHQuc2xpY2UoMCwgMjBfMDAwKSA6ICcnO1xuICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIHNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBzZXNzaW9uSWQuc2xpY2UoMCwgODApIDogJyc7XG4gICAgICBpZiAodCA9PT0gJycgfHwgc2lkID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IG9rOiBmYWxzZSwgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PignL2FwaS9pbmplY3QnLCB7IHRleHQ6IHQsIHNlc3Npb25JZDogc2lkIH0pKTtcbiAgICB9KTtcblxuICAgIC8vIC0tLS0gXHU0RjFBXHU4QkREXHU1QkZDXHU1MUZBKGV4cG9ydC5tZCBcdTIxOTIgXHU0RkREXHU1QjU4XHU1QkY5XHU4QkREXHU2ODQ2O1x1NjU4N1x1NEVGNlx1NTE5OVx1NTE2NVx1NTNFQVx1NTcyOCBtYWluKSAtLS0tXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpleHBvcnQtc2Vzc2lvbicsIGFzeW5jIChldmVudCwgaWQ6IHVua25vd24pID0+IHtcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XG4gICAgICBjb25zdCBzaWQgPSB0eXBlb2YgaWQgPT09ICdzdHJpbmcnID8gaWQucmVwbGFjZSgvW15hLXpBLVowLTlfOi5ALV0vZywgJycpLnNsaWNlKDAsIDgwKSA6ICcnO1xuICAgICAgaWYgKHNpZCA9PT0gJycpIHJldHVybiB7IGVycm9yOiAnaWQgcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH07XG4gICAgICBpZiAoY2xpZW50ID09PSBudWxsIHx8IGJyaWRnZS5ob3N0U3RhdGUgIT09ICdyZWFkeScpIHJldHVybiB7IGVycm9yOiBgaG9zdCBub3QgcmVhZHkgKCR7YnJpZGdlLmhvc3RTdGF0ZX0pYCwgY29kZTogJ0hPU1RfTk9UX1JFQURZJyB9O1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgbWQgPSBhd2FpdCBjbGllbnQuZ2V0VGV4dChgL2FwaS9zZXNzaW9ucy8ke2VuY29kZVVSSUNvbXBvbmVudChzaWQpfS9leHBvcnQubWRgKTtcbiAgICAgICAgY29uc3Qgd2luID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkuZmluZCgodykgPT4gIXcuaXNEZXN0cm95ZWQoKSk7XG4gICAgICAgIGlmICh3aW4gPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgZXJyb3I6ICdubyB3aW5kb3cnLCBjb2RlOiAnQlJJREdFX0VSUk9SJyB9O1xuICAgICAgICBjb25zdCByID0gYXdhaXQgZGlhbG9nLnNob3dTYXZlRGlhbG9nKHdpbiwge1xuICAgICAgICAgIHRpdGxlOiAnXHU1QkZDXHU1MUZBXHU0RjFBXHU4QkREJyxcbiAgICAgICAgICBkZWZhdWx0UGF0aDogYGhtaC0ke3NpZH0ubWRgLFxuICAgICAgICAgIGZpbHRlcnM6IFt7IG5hbWU6ICdNYXJrZG93bicsIGV4dGVuc2lvbnM6IFsnbWQnXSB9XSxcbiAgICAgICAgfSk7XG4gICAgICAgIGlmIChyLmNhbmNlbGVkIHx8IHIuZmlsZVBhdGggPT09IHVuZGVmaW5lZCB8fCByLmZpbGVQYXRoID09PSAnJykgcmV0dXJuIHsgb2s6IGZhbHNlLCBjYW5jZWxlZDogdHJ1ZSB9O1xuICAgICAgICBhd2FpdCB3cml0ZUZpbGUoci5maWxlUGF0aCwgbWQsICd1dGY4Jyk7XG4gICAgICAgIGxvZ0luZm8oJ2V4cG9ydCcsIGBzZXNzaW9uICR7c2lkfSBcdTIxOTIgJHtyLmZpbGVQYXRofWApO1xuICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgcGF0aDogci5maWxlUGF0aCB9O1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGNvbnN0IGRldGFpbCA9ICgoKSA9PiB7IHRyeSB7IHJldHVybiBKU09OLnN0cmluZ2lmeShlcnIpOyB9IGNhdGNoIHsgcmV0dXJuIFN0cmluZyhlcnIpOyB9IH0pKCkuc2xpY2UoMCwgMzAwKTtcbiAgICAgICAgcmV0dXJuIHsgZXJyb3I6IGRldGFpbCwgY29kZTogJ0JSSURHRV9FUlJPUicgfTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIC8vIC0tLS0gXHU1QkExXHU2Mjc5XHU2QTIxXHU1RjBGXHU4QkZCXHU1MTk5KFx1Njc0M1x1NUEwMVx1NTcyOCBydW50aW1lIGNvbmZpZztcdTUyMDdcdTYzNjJcdTVGQzVcdTk4N0JcdTY2M0VcdTVGMEYpIC0tLS1cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmFwcHJvdmFsLWdldCcsIChldmVudCkgPT5cbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPHsgc2V0dGluZ3M/OiB7IGFwcHJvdmFsPzogc3RyaW5nIH0gfT4oJy9hcGkvc3RhdGUnKSkpO1xuXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTphcHByb3ZhbC1zZXQnLCAoZXZlbnQsIG1vZGU6IHVua25vd24pID0+IHtcbiAgICAgIGNvbnN0IG0gPSBtb2RlID09PSAnYXV0bycgPyAnYXV0bycgOiBtb2RlID09PSAnYXNrJyA/ICdhc2snIDogJyc7XG4gICAgICBpZiAobSA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ21vZGUgbXVzdCBiZSBhc2t8YXV0bycsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvY29uZmlnJywgeyBhcHByb3ZhbDogbSB9KSk7XG4gICAgfSk7XG5cbiAgICAvLyAtLS0tIFByb3ZpZGVyIFx1OEJCRVx1N0Y2RSgwMyBcdTAwQTdcdTRFMDM6a2V5IFx1NTNFQVx1NTFGQSBoYXNLZXkvXHU2NzJCXHU1NkRCXHU0RjREO1x1NEZERFx1NUI1OFx1NzZGNFx1NTE5OSBydW50aW1lKSAtLS0tXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpwcm92aWRlcnMnLCAoZXZlbnQpID0+XG4gICAgICBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjx7IHByb3ZpZGVyc0RldGFpbD86IEFycmF5PHsgbmFtZTogc3RyaW5nOyBtb2RlbDogc3RyaW5nOyBiYXNlVXJsOiBzdHJpbmc7IGhhc0tleTogYm9vbGVhbjsga2V5VGFpbD86IHN0cmluZyB9PjsgbW9kZWw/OiBzdHJpbmcgfT4oJy9hcGkvc3RhdGUnKSkpO1xuXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpwcm92aWRlci1zYXZlJywgKGV2ZW50LCBwcm92aWRlcjogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3QgcCA9IHByb3ZpZGVyIGFzIHsgbmFtZT86IHVua25vd247IGJhc2VVcmw/OiB1bmtub3duOyBtb2RlbD86IHVua25vd247IGFwaUtleT86IHVua25vd24gfTtcbiAgICAgIGNvbnN0IG5hbWUgPSB0eXBlb2YgcD8ubmFtZSA9PT0gJ3N0cmluZycgPyBwLm5hbWUuc2xpY2UoMCwgODApIDogJyc7XG4gICAgICBjb25zdCBiYXNlVXJsID0gdHlwZW9mIHA/LmJhc2VVcmwgPT09ICdzdHJpbmcnID8gcC5iYXNlVXJsLnNsaWNlKDAsIDMwMCkgOiAnJztcbiAgICAgIGNvbnN0IG1vZGVsID0gdHlwZW9mIHA/Lm1vZGVsID09PSAnc3RyaW5nJyA/IHAubW9kZWwuc2xpY2UoMCwgMTIwKSA6ICcnO1xuICAgICAgaWYgKG5hbWUgPT09ICcnIHx8IGJhc2VVcmwgPT09ICcnIHx8IG1vZGVsID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAnbmFtZS9iYXNlVXJsL21vZGVsIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcbiAgICAgIGNvbnN0IGJvZHk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0geyBuYW1lLCBiYXNlVXJsLCBtb2RlbCB9O1xuICAgICAgLy8gYXBpS2V5IFx1NTNFQVx1NTcyOFx1NjYzRVx1NUYwRlx1OEY5M1x1NTE2NVx1NjVGNlx1NEUwQVx1NEYyMCxcdTdFRERcdTRFMERcdTU2REVcdTY2M0UocmVuZGVyZXIgXHU4ODY4XHU1MzU1XHU2M0QwXHU0RUE0XHU1NDBFXHU1MzczXHU2RTA1XHU3QTdBKVxuICAgICAgaWYgKHR5cGVvZiBwPy5hcGlLZXkgPT09ICdzdHJpbmcnICYmIHAuYXBpS2V5ICE9PSAnJykgYm9keS5hcGlLZXkgPSBwLmFwaUtleS5zbGljZSgwLCAzMDApO1xuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KCcvYXBpL3Byb3ZpZGVycycsIGJvZHkpKTtcbiAgICB9KTtcblxuICAgIC8vIC0tLS0gXHU1REU1XHU0RjVDXHU1MzNBKDAzIFx1MDBBN1x1NTE2RDtcdTUyMDdcdTYzNjJcdThCRURcdTRFNDlcdTRFMEUgd2ViIFx1NzZGOFx1NTQwQzpydW50aW1lIFx1NTM1NVx1OTAwOSBjd2QpIC0tLS1cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOndvcmtzcGFjZXMnLCAoZXZlbnQpID0+XG4gICAgICBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjx7IGN1cnJlbnQ6IHN0cmluZzsgaXRlbXM6IEFycmF5PHsgaWQ6IHN0cmluZzsgbmFtZTogc3RyaW5nOyBwYXRoOiBzdHJpbmcgfT4gfT4oJy9hcGkvd29ya3NwYWNlcycpKSk7XG5cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOndvcmtzcGFjZS11c2UnLCAoZXZlbnQsIGlkOiB1bmtub3duKSA9PiB7XG4gICAgICBjb25zdCB3aWQgPSB0eXBlb2YgaWQgPT09ICdzdHJpbmcnID8gaWQuc2xpY2UoMCwgNjApIDogJyc7XG4gICAgICBpZiAod2lkID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAnaWQgcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KCcvYXBpL3dvcmtzcGFjZXMvdXNlJywgeyBpZDogd2lkIH0pKTtcbiAgICB9KTtcblxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6d29ya3NwYWNlLWFkZCcsIChldmVudCwgbmFtZTogdW5rbm93biwgcGF0aDogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3QgbiA9IHR5cGVvZiBuYW1lID09PSAnc3RyaW5nJyA/IG5hbWUuc2xpY2UoMCwgMTIwKSA6ICcnO1xuICAgICAgY29uc3QgcCA9IHR5cGVvZiBwYXRoID09PSAnc3RyaW5nJyA/IHBhdGguc2xpY2UoMCwgMTAwMCkgOiAnJztcbiAgICAgIGlmIChwID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAncGF0aCByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvd29ya3NwYWNlcycsIHsgbmFtZTogbiA9PT0gJycgPyB1bmRlZmluZWQgOiBuLCBwYXRoOiBwIH0pKTtcbiAgICB9KTtcblxuICAgIC8vIC0tLS0gXHU0RjFBXHU4QkREXHU1RjUyXHU2ODYzL1x1NTIyMFx1OTY2NChcdTc5RkJcdTUxNjUgYXJjaGl2ZS90cmFzaCxcdTUzRUZcdTYwNjJcdTU5MEQ7cnVudGltZSBcdTY3NDNcdTVBMDEpIC0tLS1cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnNlc3Npb24tb3AnLCAoZXZlbnQsIGlkOiB1bmtub3duLCBvcDogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIGlkID09PSAnc3RyaW5nJyA/IGlkLnJlcGxhY2UoL1teYS16QS1aMC05XzouQC1dL2csICcnKS5zbGljZSgwLCA4MCkgOiAnJztcbiAgICAgIGNvbnN0IG8gPSBvcCA9PT0gJ2FyY2hpdmUnIHx8IG9wID09PSAnZGVsZXRlJyA/IG9wIDogJyc7XG4gICAgICBpZiAoc2lkID09PSAnJyB8fCBvID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAnaWQgYW5kIG9wKGFyY2hpdmV8ZGVsZXRlKSByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oYC9hcGkvc2Vzc2lvbnMvJHtlbmNvZGVVUklDb21wb25lbnQoc2lkKX0vJHtvfWAsIHt9KSk7XG4gICAgfSk7XG5cbiAgICAvLyAtLS0tIE00OkRpZmYgXHU5NzYyXHU2NzdGKFx1NTNFQVx1OEJGQiBnaXQgXHU1M0Q4XHU2NkY0O1x1NjM4OFx1Njc0M1x1NTcyOCBydW50aW1lKSAtLS0tXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpkaWZmJywgKGV2ZW50LCBzZXNzaW9uSWQ6IHVua25vd24pID0+IHtcbiAgICAgIGNvbnN0IHNpZCA9IHR5cGVvZiBzZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gc2Vzc2lvbklkLnNsaWNlKDAsIDgwKSA6ICcnO1xuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPFJlY29yZDxzdHJpbmcsIHVua25vd24+PihgL2FwaS9kaWZmJHtzaWQgIT09ICcnID8gYD9zZXNzaW9uSWQ9JHtlbmNvZGVVUklDb21wb25lbnQoc2lkKX1gIDogJyd9YCkpO1xuICAgIH0pO1xuXG4gICAgLy8gLS0tLSBNNTpcdThCQTRcdTc3RTVcdTcyQjZcdTYwMDEoXHU3RUQzXHU2Nzg0XHU1MzE2XHU0RThCXHU1QjlFO1x1N0YzQVx1NjU3MFx1NjM2RVx1NUI1N1x1NkJCNVx1NzUzMSBVSSBcdTY2M0VcdTc5M0FcIlx1NjVFMFx1NjU3MFx1NjM2RVwiKSAtLS0tXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpjb2duaXRpdmUnLCAoZXZlbnQpID0+XG4gICAgICBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oJy9hcGkvY29nbml0aXZlJykpKTtcblxuICAgIC8vIC0tLS0gXHU1Mzg2XHU1M0YyXHU0RjFBXHU4QkREXHU5ODg0XHU4OUM4KFx1NjcwMFx1NTQwRSA4MCBcdTY3NjEsXHU2QkNGXHU2NzYxIDUwMCBcdTVCNTc7cnVudGltZSBcdTY3NDNcdTVBMDFcdTY1NzBcdTYzNkUpIC0tLS1cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnNlc3Npb24tcHJldmlldycsIChldmVudCwgaWQ6IHVua25vd24pID0+IHtcbiAgICAgIGNvbnN0IHNpZCA9IHR5cGVvZiBpZCA9PT0gJ3N0cmluZycgPyBpZC5yZXBsYWNlKC9bXmEtekEtWjAtOV86LkAtXS9nLCAnJykuc2xpY2UoMCwgODApIDogJyc7XG4gICAgICBpZiAoc2lkID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAnaWQgcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPFJlY29yZDxzdHJpbmcsIHVua25vd24+PihgL2FwaS9zZXNzaW9ucy8ke2VuY29kZVVSSUNvbXBvbmVudChzaWQpfWApKTtcbiAgICB9KTtcblxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6c3RvcC1ob3N0JywgKGV2ZW50KSA9PiB7XG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInIH07XG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XG4gICAgICAgIHNzZUFib3J0Py5hYm9ydCgpO1xuICAgICAgICBhd2FpdCBzdXBlcnZpc29yPy5zdG9wKCk7XG4gICAgICAgIGFwcC5xdWl0KCk7XG4gICAgICB9KSgpO1xuICAgICAgcmV0dXJuIHsgb2s6IHRydWUgfTtcbiAgICB9KTtcbiAgfVxuXG4gIC8qIC0tLS0gXHU3QTk3XHU1M0UzXHU0RTBFXHU1Qjg5XHU1MTY4XHU3QjU2XHU3NTY1IC0tLS0gKi9cbiAgLy8gMDMgXHUwMEE3XHU0RTAzOkRlc2t0b3AgXHU2NzJDXHU1NzMwXHU1M0VBXHU1QjU4IFVJIFx1NTA0Rlx1NTk3RC9cdTdBOTdcdTUzRTNcdTcyQjZcdTYwMDEodXNlckRhdGEvd2luZG93LXN0YXRlLmpzb24pXG4gIGNvbnN0IHdpbmRvd1N0YXRlRmlsZSA9ICgpOiBzdHJpbmcgPT4gam9pbihhcHAuZ2V0UGF0aCgndXNlckRhdGEnKSwgJ3dpbmRvdy1zdGF0ZS5qc29uJyk7XG4gIGFzeW5jIGZ1bmN0aW9uIGxvYWRCb3VuZHMoKTogUHJvbWlzZTx7IHdpZHRoOiBudW1iZXI7IGhlaWdodDogbnVtYmVyOyB4PzogbnVtYmVyOyB5PzogbnVtYmVyIH0gfCBudWxsPiB7XG4gICAgdHJ5IHtcbiAgICAgIHJldHVybiBKU09OLnBhcnNlKGF3YWl0IHJlYWRGaWxlKHdpbmRvd1N0YXRlRmlsZSgpLCAndXRmOCcpKSBhcyB7IHdpZHRoOiBudW1iZXI7IGhlaWdodDogbnVtYmVyOyB4PzogbnVtYmVyOyB5PzogbnVtYmVyIH07XG4gICAgfSBjYXRjaCB7IHJldHVybiBudWxsOyB9XG4gIH1cbiAgYXN5bmMgZnVuY3Rpb24gc2F2ZUJvdW5kcyh3aW46IEJyb3dzZXJXaW5kb3cpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICB0cnkgeyBhd2FpdCB3cml0ZUZpbGUod2luZG93U3RhdGVGaWxlKCksIEpTT04uc3RyaW5naWZ5KHdpbi5nZXRCb3VuZHMoKSksICd1dGY4Jyk7IH0gY2F0Y2ggeyAvKiBiZXN0IGVmZm9ydCAqLyB9XG4gIH1cblxuICBhc3luYyBmdW5jdGlvbiBjcmVhdGVXaW5kb3coKTogUHJvbWlzZTxCcm93c2VyV2luZG93IHwgbnVsbD4ge1xuICAgIGNvbnN0IHNhdmVkID0gYXdhaXQgbG9hZEJvdW5kcygpO1xuICAgIGNvbnN0IHdpbiA9IG5ldyBCcm93c2VyV2luZG93KHtcbiAgICAgIHdpZHRoOiBzYXZlZD8ud2lkdGggPz8gMTQ0MCxcbiAgICAgIGhlaWdodDogc2F2ZWQ/LmhlaWdodCA/PyA5MDAsXG4gICAgICAuLi4oc2F2ZWQ/LnggIT09IHVuZGVmaW5lZCAmJiBzYXZlZD8ueSAhPT0gdW5kZWZpbmVkID8geyB4OiBzYXZlZC54LCB5OiBzYXZlZC55IH0gOiB7fSksXG4gICAgICBtaW5XaWR0aDogOTYwLFxuICAgICAgbWluSGVpZ2h0OiA2MDAsXG4gICAgICBzaG93OiBmYWxzZSxcbiAgICAgIGJhY2tncm91bmRDb2xvcjogJyMxNDE0MTYnLFxuICAgICAgdGl0bGU6ICdITUggRGVza3RvcCcsXG4gICAgICB3ZWJQcmVmZXJlbmNlczoge1xuICAgICAgICBwcmVsb2FkOiBwcmVsb2FkUGF0aCxcbiAgICAgICAgY29udGV4dElzb2xhdGlvbjogdHJ1ZSxcbiAgICAgICAgc2FuZGJveDogdHJ1ZSxcbiAgICAgICAgbm9kZUludGVncmF0aW9uOiBmYWxzZSxcbiAgICAgICAgbm9kZUludGVncmF0aW9uSW5Xb3JrZXI6IGZhbHNlLFxuICAgICAgICB3ZWJTZWN1cml0eTogdHJ1ZSxcbiAgICAgICAgc3BlbGxjaGVjazogZmFsc2UsXG4gICAgICAgIGRldlRvb2xzOiBpc0RldixcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgd2luLm9uY2UoJ3JlYWR5LXRvLXNob3cnLCAoKSA9PiB3aW4uc2hvdygpKTtcbiAgICB3aW4ub24oJ2Nsb3NlJywgKCkgPT4geyB2b2lkIHNhdmVCb3VuZHMod2luKTsgfSk7XG5cbiAgICAvLyBcdTUzRUFcdTUxNDFcdThCQjhcdTUyQTBcdThGN0RcdTYyMTFcdTRFRUNcdTgxRUFcdTVERjFcdTc2ODQgcmVuZGVyZXI7XHU0RUZCXHU0RjU1XHU1QkZDXHU4MjJBL1x1NjVCMFx1N0E5N1x1NTNFM1x1NEUwMFx1NUY4Qlx1NjJEMlx1N0VERFxuICAgIHdpbi53ZWJDb250ZW50cy5zZXRXaW5kb3dPcGVuSGFuZGxlcigoeyB1cmwgfSkgPT4ge1xuICAgICAgaWYgKC9eaHR0cHM/OlxcL1xcLy8udGVzdCh1cmwpKSB2b2lkIHNoZWxsLm9wZW5FeHRlcm5hbCh1cmwpO1xuICAgICAgcmV0dXJuIHsgYWN0aW9uOiAnZGVueScgfTtcbiAgICB9KTtcbiAgICB3aW4ud2ViQ29udGVudHMub24oJ3dpbGwtbmF2aWdhdGUnLCAoZSwgdXJsKSA9PiB7XG4gICAgICBjb25zdCBvayA9IFsuLi5hbGxvd2VkT3JpZ2luc10uc29tZSgobykgPT4gdXJsID09PSBvIHx8IHVybC5zdGFydHNXaXRoKGAke299L2ApIHx8IHVybC5zdGFydHNXaXRoKGAke299P2ApKTtcbiAgICAgIGlmICghb2spIHtcbiAgICAgICAgbG9nSW5mbygnbmF2JywgYGJsb2NrZWQgbmF2aWdhdGlvbiB0byAke3VybC5zbGljZSgwLCAxMjApfWApO1xuICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICBpZiAoaXNEZXYgJiYgcmVuZGVyZXJEZXZVcmwpIHtcbiAgICAgIHZvaWQgd2luLmxvYWRVUkwocmVuZGVyZXJEZXZVcmwpO1xuICAgIH0gZWxzZSB7XG4gICAgICB2b2lkIHdpbi5sb2FkRmlsZShqb2luKGhlcmUsICcuLicsICcuLicsICdkaXN0LXJlbmRlcmVyJywgJ2luZGV4Lmh0bWwnKSk7XG4gICAgfVxuICAgIHJldHVybiB3aW47XG4gIH1cblxuICBhcHAud2hlblJlYWR5KCkudGhlbigoKSA9PiB7XG4gICAgLy8gQ1NQKGRldiBcdTRFMEUgcHJvZCBcdTRFMERcdTU0MEM7cHJvZCBcdTRFMERcdTUxNDFcdThCQjhcdTRFRkJcdTRGNTVcdThGRENcdTdBMEJcdTZFOTApXG4gICAgY29uc3QgY3NwID0gaXNEZXZcbiAgICAgID8gW1xuICAgICAgICAgIFwiZGVmYXVsdC1zcmMgJ3NlbGYnXCIsXG4gICAgICAgICAgYHNjcmlwdC1zcmMgJ3NlbGYnICR7cmVuZGVyZXJEZXZVcmx9YCxcbiAgICAgICAgICBcInN0eWxlLXNyYyAnc2VsZicgJ3Vuc2FmZS1pbmxpbmUnXCIsXG4gICAgICAgICAgYGNvbm5lY3Qtc3JjICdzZWxmJyAke3JlbmRlcmVyRGV2VXJsfSB3czovLzEyNy4wLjAuMToqYCxcbiAgICAgICAgICBcImltZy1zcmMgJ3NlbGYnIGRhdGE6XCIsXG4gICAgICAgICAgXCJmb250LXNyYyAnc2VsZicgZGF0YTpcIixcbiAgICAgICAgXS5qb2luKCc7ICcpXG4gICAgICA6IFwiZGVmYXVsdC1zcmMgJ3NlbGYnOyBzY3JpcHQtc3JjICdzZWxmJzsgc3R5bGUtc3JjICdzZWxmJyAndW5zYWZlLWlubGluZSc7IGltZy1zcmMgJ3NlbGYnIGRhdGE6OyBmb250LXNyYyAnc2VsZicgZGF0YTpcIjtcbiAgICBzZXNzaW9uLmRlZmF1bHRTZXNzaW9uLndlYlJlcXVlc3Qub25IZWFkZXJzUmVjZWl2ZWQoKGRldGFpbHMsIGNhbGxiYWNrKSA9PiB7XG4gICAgICBjYWxsYmFjayh7XG4gICAgICAgIHJlc3BvbnNlSGVhZGVyczoge1xuICAgICAgICAgIC4uLmRldGFpbHMucmVzcG9uc2VIZWFkZXJzLFxuICAgICAgICAgICdDb250ZW50LVNlY3VyaXR5LVBvbGljeSc6IFtjc3BdLFxuICAgICAgICB9LFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICByZWdpc3RlcklwYygpO1xuICAgIC8vIGNyZWF0ZVdpbmRvdyBcdTY2MkYgYXN5bmMoYm91bmRzIFx1NjA2Mlx1NTkwRCk7XHU1Qjg5XHU1MTY4XHU4MUVBXHU2RDRCXHU1NzI4XHU3QTk3XHU1M0UzXHU1QzMxXHU3RUVBXHU1NDBFXHU0RUNFXHU1MTg1XHU5MEU4XHU2MzAyXHU4RjdEXG4gICAgdm9pZCBjcmVhdGVXaW5kb3coKS50aGVuKCh3aW4pID0+IHtcbiAgICAgIGlmICh3aW4gIT09IG51bGwgJiYgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfU0VDVVJJVFlfVEVTVCA9PT0gJzEnKSB7XG4gICAgICAgIHdpbi53ZWJDb250ZW50cy5vbmNlKCdkaWQtZmluaXNoLWxvYWQnLCAoKSA9PiB7XG4gICAgICAgICAgdm9pZCBzZWN1cml0eVNlbGZUZXN0KHdpbik7XG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH0pO1xuICAgIHZvaWQgc3RhcnRIb3N0KCk7XG5cbiAgICBhcHAub24oJ2FjdGl2YXRlJywgKCkgPT4ge1xuICAgICAgaWYgKEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmxlbmd0aCA9PT0gMCkgdm9pZCBjcmVhdGVXaW5kb3coKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgYXN5bmMgZnVuY3Rpb24gc2VjdXJpdHlTZWxmVGVzdCh3aW46IEJyb3dzZXJXaW5kb3cpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCByZXN1bHRzOiBBcnJheTxbc3RyaW5nLCBib29sZWFuLCBzdHJpbmddPiA9IFtdO1xuICAgIGNvbnN0IGNoZWNrID0gYXN5bmMgKG5hbWU6IHN0cmluZywgcHJvYmU6ICgpID0+IFByb21pc2U8W2Jvb2xlYW4sIHN0cmluZ10+KTogUHJvbWlzZTx2b2lkPiA9PiB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBbb2ssIGRldGFpbF0gPSBhd2FpdCBwcm9iZSgpO1xuICAgICAgICByZXN1bHRzLnB1c2goW25hbWUsIG9rLCBkZXRhaWxdKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICByZXN1bHRzLnB1c2goW25hbWUsIGZhbHNlLCBTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApXSk7XG4gICAgICB9XG4gICAgfTtcbiAgICBjb25zdCBqcyA9IChjb2RlOiBzdHJpbmcpOiBQcm9taXNlPHVua25vd24+ID0+IHdpbi53ZWJDb250ZW50cy5leGVjdXRlSmF2YVNjcmlwdChjb2RlLCB0cnVlKTtcblxuICAgIGF3YWl0IGNoZWNrKCdyZW5kZXJlciBcdTY1RTBcdTUzRUZcdTc1MjhcdTc2ODQgcHJvY2Vzcy9yZXF1aXJlKHNhbmRib3ggXHU3NTFGXHU2NTQ4KScsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoYChmdW5jdGlvbigpe1xuICAgICAgICB2YXIgdCA9IGZ1bmN0aW9uKGYpeyB0cnkgeyB2YXIgdiA9IGYoKTsgcmV0dXJuICh2ID09PSB1bmRlZmluZWQgfHwgdiA9PT0gbnVsbCkgPyAndW5hdmFpbGFibGUnIDogdHlwZW9mIHY7IH0gY2F0Y2goZSl7IHJldHVybiAnYmxvY2tlZCc7IH0gfTtcbiAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KFt0KGZ1bmN0aW9uKCl7cmV0dXJuIHByb2Nlc3N9KSwgdChmdW5jdGlvbigpe3JldHVybiByZXF1aXJlfSksIHQoZnVuY3Rpb24oKXtyZXR1cm4gZ2xvYmFsVGhpcy5wcm9jZXNzfSldKTtcbiAgICAgIH0pKClgKSkgYXMgc3RyaW5nO1xuICAgICAgY29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShyKSBhcyBzdHJpbmdbXTtcbiAgICAgIGNvbnN0IHAgPSBwYXJzZWRbMF0gPz8gJ3Vua25vd24nO1xuICAgICAgY29uc3QgcmVxID0gcGFyc2VkWzFdID8/ICd1bmtub3duJztcbiAgICAgIGNvbnN0IHNhZmUgPSAodjogc3RyaW5nKTogYm9vbGVhbiA9PiB2ID09PSAndW5hdmFpbGFibGUnIHx8IHYgPT09ICdibG9ja2VkJztcbiAgICAgIHJldHVybiBbc2FmZShwKSAmJiBzYWZlKHJlcSksIGBwcm9jZXNzPSR7cH0gcmVxdWlyZT0ke3JlcX1gXTtcbiAgICB9KTtcbiAgICBhd2FpdCBjaGVjaygnd2luZG93LmhtaCBcdTUzRUFcdTY3MDlcdTc2N0RcdTU0MERcdTUzNTVcdTY1QjlcdTZDRDUoXHU2NUUwIGlwY1JlbmRlcmVyL1x1OTg5RFx1NTkxNlx1OTc2MiknLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKCdPYmplY3Qua2V5cyh3aW5kb3cuaG1oIHx8IHt9KS5zb3J0KCkuam9pbihcIixcIiknKSkgYXMgc3RyaW5nO1xuICAgICAgY29uc3QgYWxsb3cgPSBbJ2FwcHJvdmUnLCAnYXBwcm92YWxHZXQnLCAnYXBwcm92YWxTZXQnLCAnY29nbml0aXZlJywgJ2RpZmYnLCAnZXhwb3J0U2Vzc2lvbicsICdmc0xpc3QnLCAnZnNSZWFkJywgJ2ZzU2VhcmNoJywgJ2dldFN0YXRlJywgJ2luamVjdCcsICdpbnRlcnJ1cHQnLCAnb25FdmVudEJhdGNoZXMnLCAnb25Ib3N0U3RhdGUnLCAnb25TdHJlYW1DaHVua3MnLCAncHJvdmlkZXJTYXZlJywgJ3Byb3ZpZGVycycsICdzZW5kVGFzaycsICdzZXNzaW9uT3AnLCAnc2Vzc2lvblByZXZpZXcnLCAnc2Vzc2lvbnMnLCAnc3RvcEhvc3QnLCAnd29ya3NwYWNlcycsICd3b3Jrc3BhY2VBZGQnLCAnd29ya3NwYWNlVXNlJ107XG4gICAgICBjb25zdCBnb3QgPSByID09PSAnJyA/IFtdIDogci5zcGxpdCgnLCcpO1xuICAgICAgY29uc3QgdW5leHBlY3RlZCA9IGdvdC5maWx0ZXIoKGspID0+ICFhbGxvdy5pbmNsdWRlcyhrKSk7XG4gICAgICByZXR1cm4gW3VuZXhwZWN0ZWQubGVuZ3RoID09PSAwLCBga2V5cz0ke3J9YF07XG4gICAgfSk7XG4gICAgYXdhaXQgY2hlY2soJ1x1NTkxNlx1OTBFOFx1NUJGQ1x1ODIyQVx1ODhBQlx1NjJFNlx1NjIyQShVUkwgXHU0RTBEXHU1M0Q4KScsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IGJlZm9yZSA9IHdpbi53ZWJDb250ZW50cy5nZXRVUkwoKTtcbiAgICAgIGF3YWl0IGpzKCdsb2NhdGlvbi5ocmVmID0gXCJodHRwczovL2V4YW1wbGUuaW52YWxpZC94XCI7IFwibm9vcFwiJykuY2F0Y2goKCkgPT4gJ25vb3AnKTtcbiAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyMikgPT4gc2V0VGltZW91dChyMiwgMV8yMDApKTtcbiAgICAgIGNvbnN0IGFmdGVyID0gd2luLndlYkNvbnRlbnRzLmdldFVSTCgpO1xuICAgICAgcmV0dXJuIFthZnRlciA9PT0gYmVmb3JlLCBgJHtiZWZvcmV9IFx1MjE5MiAke2FmdGVyfWBdO1xuICAgIH0pO1xuICAgIGF3YWl0IGNoZWNrKCd3aW5kb3cub3BlbiBcdTg4QUJcdTYyRDJcdTdFREQoXHU4RkQ0XHU1NkRFIG51bGwgXHU0RTE0XHU2NUUwXHU2NUIwXHU3QTk3XHU1M0UzKScsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IGJlZm9yZSA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmxlbmd0aDtcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoJ1N0cmluZyh3aW5kb3cub3BlbihcImh0dHBzOi8vZXhhbXBsZS5pbnZhbGlkXCIpKScpKSBhcyBzdHJpbmc7XG4gICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocjIpID0+IHNldFRpbWVvdXQocjIsIDQwMCkpO1xuICAgICAgY29uc3QgYWZ0ZXIgPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5sZW5ndGg7XG4gICAgICByZXR1cm4gW3IgPT09ICdudWxsJyAmJiBhZnRlciA9PT0gYmVmb3JlLCBgb3BlbigpPSR7cn0gd2luZG93cz0ke2JlZm9yZX1cdTIxOTIke2FmdGVyfWBdO1xuICAgIH0pO1xuICAgIGF3YWl0IGNoZWNrKCdDU1AgXHU1QjU4XHU1NzI4KG1ldGEgXHU2Q0U4XHU1MTY1XHU2MjE2XHU1NENEXHU1RTk0XHU1OTM0KScsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IG1ldGEgPSAoYXdhaXQganMoJ0Jvb2xlYW4oZG9jdW1lbnQucXVlcnlTZWxlY3RvcihcIm1ldGFbaHR0cC1lcXVpdj1cXCdDb250ZW50LVNlY3VyaXR5LVBvbGljeVxcJ11cIikpJykpIGFzIGJvb2xlYW47XG4gICAgICBjb25zdCBoZWFkZXJDc3AgPSBpc0RldiA/ICdkZXY6IGhlYWRlciBDU1AgXHU3NTMxIG9uSGVhZGVyc1JlY2VpdmVkIFx1NkNFOFx1NTE2NShcdTRFMERcdTkwMDJcdTc1MjggbWV0YSBcdTY1QURcdThBMDApJyA6ICdwcm9kJztcbiAgICAgIHJldHVybiBbbWV0YSB8fCBpc0RldiwgYG1ldGE9JHttZXRhfSAke2hlYWRlckNzcH1gXTtcbiAgICB9KTtcbiAgICBhd2FpdCBjaGVjaygnYnJpZGdlOmdldC1zdGF0ZSBcdTZCNjNcdTVFMzhcdThGRDRcdTU2REUoaG9zdCBcdTY4NjVcdTUzRUZcdTc1MjgpJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgciA9IChhd2FpdCBqcygnd2luZG93LmhtaC5nZXRTdGF0ZSgpLnRoZW4ocyA9PiBKU09OLnN0cmluZ2lmeShzKSkuY2F0Y2goZSA9PiBcIkVSUjpcIitlKScpKSBhcyBzdHJpbmc7XG4gICAgICByZXR1cm4gW3Iuc3RhcnRzV2l0aCgneycpICYmIHIuaW5jbHVkZXMoJ2hvc3RTdGF0ZScpLCByLnNsaWNlKDAsIDgwKV07XG4gICAgfSk7XG4gICAgYXdhaXQgY2hlY2soJ1hTUzpcdTYwNzZcdTYxMEZcdTRFRkJcdTUyQTFcdTY1ODdcdTY3MkNcdTUzRUFcdTRFRTVcdTY1ODdcdTY3MkNcdTZFMzJcdTY3RDMoXHU0RTBEXHU2MjY3XHU4ODRDKScsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHBheWxvYWQgPSAnPGltZyBzcmM9eCBvbmVycm9yPVwid2luZG93Ll9feHNzPTFcIj48c2NyaXB0PndpbmRvdy5fX3hzcz0yPFxcL3NjcmlwdD5cIiZcXCcnO1xuICAgICAgY29uc3Qgc2VuZFIgPSAoYXdhaXQganMoYHdpbmRvdy5obWguc2VuZFRhc2soJHtKU09OLnN0cmluZ2lmeShwYXlsb2FkKX0sICdzZWMteHNzLTEnLCAnYXV0bycpLnRoZW4ocj0+SlNPTi5zdHJpbmdpZnkocikpLmNhdGNoKGU9PidFUlI6JytlKWApKSBhcyBzdHJpbmc7XG4gICAgICBpZiAoIXNlbmRSLmluY2x1ZGVzKCdcIm9rXCI6dHJ1ZScpKSByZXR1cm4gW2ZhbHNlLCBgc2VuZFRhc2sgXHU2NzJBXHU1M0Q3XHU3NDA2OiAke3NlbmRSLnNsaWNlKDAsIDgwKX1gXTtcbiAgICAgIC8vIGZha2UgaG9zdCBlY2hvIFx1NTZERVx1Njc2NVx1NTQwRVx1N0VDRiBSZWFjdCBcdTZFMzJcdTY3RDMoXHU3NTI4XHU2MjM3XHU2RDg4XHU2MDZGICsgXHU1MkE5XHU2MjRCIGVjaG8gXHU1M0NDXHU4REVGXHU1Rjg0KVxuICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHIyKSA9PiBzZXRUaW1lb3V0KHIyLCAzXzAwMCkpO1xuICAgICAgY29uc3QgcHJvYmUgPSAoYXdhaXQganMoYEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgeHNzRmxhZzogdHlwZW9mIHdpbmRvdy5fX3hzcyxcbiAgICAgICAgaW1nQ291bnQ6IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ2ltZ1tzcmM9XCJ4XCJdJykubGVuZ3RoLFxuICAgICAgICBzY3JpcHRSYW46IGRvY3VtZW50LmJvZHkuaW5uZXJUZXh0LmluZGV4T2YoJ3dpbmRvdy5fX3hzcz0yJykgPj0gMFxuICAgICAgfSlgKSkgYXMgc3RyaW5nO1xuICAgICAgY29uc3QgcCA9IEpTT04ucGFyc2UocHJvYmUpIGFzIHsgeHNzRmxhZzogc3RyaW5nOyBpbWdDb3VudDogbnVtYmVyOyBzY3JpcHRSYW46IGJvb2xlYW4gfTtcbiAgICAgIHJldHVybiBbcC54c3NGbGFnID09PSAndW5kZWZpbmVkJyAmJiBwLmltZ0NvdW50ID09PSAwLCBgeHNzRmxhZz0ke3AueHNzRmxhZ30gaW1nPSR7cC5pbWdDb3VudH1gXTtcbiAgICB9KTtcblxuICAgIGxldCBmYWlsZWQgPSAwO1xuICAgIGZvciAoY29uc3QgW25hbWUsIG9rLCBkZXRhaWxdIG9mIHJlc3VsdHMpIHtcbiAgICAgIGNvbnNvbGUubG9nKGBTRUNVUklUWS1URVNUICR7b2sgPyAnUEFTUycgOiAnRkFJTCd9IHwgJHtuYW1lfSB8ICR7cmVkYWN0KGRldGFpbCl9YCk7XG4gICAgICBpZiAoIW9rKSBmYWlsZWQgKz0gMTtcbiAgICB9XG4gICAgY29uc29sZS5sb2coYFNFQ1VSSVRZLVRFU1QgU1VNTUFSWSBwYXNzPSR7cmVzdWx0cy5sZW5ndGggLSBmYWlsZWR9LyR7cmVzdWx0cy5sZW5ndGh9YCk7XG4gICAgYXBwLmV4aXQoZmFpbGVkID09PSAwID8gMCA6IDEpO1xuICB9XG5cbiAgLy8gXHU5MDAwXHU1MUZBOlx1NEYxOFx1OTZDNVx1NTA1Q1x1NkI2Mlx1ODFFQVx1NURGMSBzcGF3biBcdTc2ODQgaG9zdChzaHV0ZG93biBcdTdBRUZcdTcwQjkgXHUyMTkyIFx1NTE1Q1x1NUU5NVx1NTNFQSBraWxsIFx1ODFFQVx1NURGMVx1NzY4NFx1NTNFNVx1NjdDNClcbiAgYXBwLm9uKCdiZWZvcmUtcXVpdCcsIChlKSA9PiB7XG4gICAgaWYgKHN1cGVydmlzb3IgIT09IG51bGwgJiYgc3VwZXJ2aXNvci5zdGF0ZSAhPT0gJ3N0b3BwZWQnKSB7XG4gICAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgICBzc2VBYm9ydD8uYWJvcnQoKTtcbiAgICAgIHZvaWQgc3VwZXJ2aXNvci5zdG9wKCkuZmluYWxseSgoKSA9PiBhcHAucXVpdCgpKTtcbiAgICB9XG4gIH0pO1xuICBhcHAub24oJ3dpbmRvdy1hbGwtY2xvc2VkJywgKCkgPT4ge1xuICAgIGlmIChwcm9jZXNzLnBsYXRmb3JtICE9PSAnZGFyd2luJykgYXBwLnF1aXQoKTtcbiAgfSk7XG59XG4iLCAiLyoqXG4gKiBEZXNrdG9wUnVudGltZVN1cGVydmlzb3IgXHUyMDE0IGhtaGFybmVzcyBob3N0IFx1OEZEQlx1N0EwQlx1NzY4NFx1NzUxRlx1NTQ3RFx1NTQ2OFx1NjcxRlx1NzJCNlx1NjAwMVx1NjczQShBRFItMDAzKVx1MzAwMlxuICpcbiAqIFx1NUI4OVx1NTE2OFx1NEUwRFx1NTNEOFx1OTFDRjpcbiAqICAtIFx1NTNFQVx1N0VEMVx1NUI5QS9cdTYzQTJcdTZENEIgMTI3LjAuMC4xO2hvc3QgXHU0RjdGXHU3NTI4XHU2NENEXHU0RjVDXHU3Q0ZCXHU3RURGXHU1MjA2XHU5MTREXHU3QUVGXHU1M0UzKHBvcnQgMCksXHU1QjlFXHU5NjQ1XHU3QUVGXHU1M0UzXG4gKiAgICBcdTc1MzEgaG9zdCBcdTc2ODQgc3Rkb3V0IFx1NUYxNVx1NUJGQ1x1ODg0Q1x1NTZERVx1NEYyMChIb3N0UmVhZHlMaW5lKVx1MzAwMlxuICogIC0gXHU5QUQ4XHU3MUI1IHRva2VuIFx1NTNFQVx1OTAxQVx1OEZDN1x1NUI1MFx1OEZEQlx1N0EwQlx1NzNBRlx1NTg4M1x1NTNEOFx1OTFDRlx1NEYyMFx1OTAxMixcdTdFRERcdTRFMERcdThGREIgVVJML1x1NjVFNVx1NUZENy9JUEMgXHU2NjBFXHU2NTg3XHU4RDFGXHU4RjdEXHUzMDAyXG4gKiAgLSBcdTUzRUFcdTUwNUNcdTZCNjJcdTY3MkMgc3VwZXJ2aXNvciBzcGF3biBcdTc2ODRcdThGREJcdTdBMEJcdTUzRTVcdTY3QzQ7XHU3RUREXHU0RTBEXHU2MzA5XHU4RkRCXHU3QTBCXHU1NDBEIGtpbGxcdTMwMDJcbiAqICAtIGhvc3QgY3Jhc2ggXHU1NDBFXHU2NzA5XHU5NjUwXHU5MUNEXHU1NDJGO1x1OTFDRFx1NTQyRlx1NEUwRFx1OTFDRFx1NjUzRVx1NEVGQlx1NEY1NVx1NzUyOFx1NjIzN1x1NTJBOFx1NEY1QyhcdTk3NUVcdTVFNDJcdTdCNDlcdTUyQThcdTRGNUNcdTc1MzFcdTc1MjhcdTYyMzdcdTc4NkVcdThCQTQpXHUzMDAyXG4gKi9cbmltcG9ydCB7IHNwYXduLCB0eXBlIENoaWxkUHJvY2VzcyB9IGZyb20gJ25vZGU6Y2hpbGRfcHJvY2Vzcyc7XG5pbXBvcnQgeyBjcmVhdGVJbnRlcmZhY2UgfSBmcm9tICdub2RlOnJlYWRsaW5lJztcbmltcG9ydCB7IHJhbmRvbUJ5dGVzIH0gZnJvbSAnbm9kZTpjcnlwdG8nO1xuaW1wb3J0IHsgZGVza3RvcEVycm9yLCBpc0Rlc2t0b3BFcnJvciwgdHlwZSBEZXNrdG9wRXJyb3IgfSBmcm9tICdAaG1oLWRlc2t0b3AvY29udHJhY3RzJztcblxuZXhwb3J0IHR5cGUgSG9zdFN0YXRlID1cbiAgfCAnc3RvcHBlZCdcbiAgfCAnc3RhcnRpbmcnXG4gIHwgJ3JlYWR5J1xuICB8ICdkaXNjb25uZWN0ZWQnXG4gIHwgJ3Jlc3RhcnRpbmcnXG4gIHwgJ3N0b3BwaW5nJ1xuICB8ICdmYWlsZWQnO1xuXG5leHBvcnQgaW50ZXJmYWNlIEhvc3RTcGVjIHtcbiAgLyoqIFx1NTNFRlx1NjI2N1x1ODg0Q1x1NjU4N1x1NEVGNihcdTkwMUFcdTVFMzggcHJvY2Vzcy5leGVjUGF0aClcdTMwMDIgKi9cbiAgY29tbWFuZDogc3RyaW5nO1xuICBhcmdzOiBzdHJpbmdbXTtcbiAgY3dkPzogc3RyaW5nO1xuICAvKiogXHU5ODlEXHU1OTE2XHU3M0FGXHU1ODgzXHU1M0Q4XHU5MUNGKFx1NEYxQVx1NEUwRSBwcm9jZXNzLmVudiBcdTU0MDhcdTVFNzYpXHUzMDAyICovXG4gIGVudj86IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3VwZXJ2aXNvck9wdGlvbnMge1xuICAvKiogXHU2NzFGXHU2NzFCIGhvc3QgXHU2ODIxXHU5QThDXHU3Njg0IGJlYXJlciB0b2tlbjtcdTRFMERcdTRGMjBcdTUyMTlcdTZCQ0ZcdTZCMjEgc3RhcnQgXHU3NTFGXHU2MjEwXHU5QUQ4XHU3MUI1XHU5NjhGXHU2NzNBXHU1MDNDXHUzMDAyICovXG4gIHRva2VuPzogc3RyaW5nO1xuICBtYXhSZXN0YXJ0cz86IG51bWJlcjtcbiAgc3RhcnRUaW1lb3V0TXM/OiBudW1iZXI7XG4gIGdyYWNlZnVsU2h1dGRvd25Ncz86IG51bWJlcjtcbiAgb25TdGF0ZUNoYW5nZT8oc3RhdGU6IEhvc3RTdGF0ZSwgaW5mbzogeyByZXN0YXJ0Q291bnQ6IG51bWJlcjsgbGFzdEVycm9yPzogc3RyaW5nIH0pOiB2b2lkO1xuICAvKiogXHU2QkNGXHU2QjIxIGhvc3QgXHU1QzMxXHU3RUVBKFx1NTQyQiBjcmFzaCBcdTgxRUFcdTYxMDhcdTU0MEVcdTc2ODRcdTkxQ0RcdTU0MkYpXHU5MEZEXHU0RjFBXHU4OUU2XHU1M0QxLFx1NjQzQVx1NUUyNlx1N0FFRlx1NzBCOShcdTU0MkIgdG9rZW4sXG4gICAqICBcdTRFQzVcdTRGOUJcdTU0MENcdTRGRTFcdTRFRkJcdTU3REZcdTc2ODRcdTVCQkZcdTRFM0JcdThGREJcdTdBMEJcdTkxQ0RcdTVFRkFcdTY4NjVcdTVCQTJcdTYyMzdcdTdBRUY7XHU0RTBEXHU4OTgxXHU4REU4XHU4RkRCIHJlbmRlcmVyKVx1MzAwMiAqL1xuICBvblJlYWR5PyhlbmRwb2ludDogSG9zdEVuZHBvaW50KTogdm9pZDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBIb3N0RW5kcG9pbnQge1xuICBwb3J0OiBudW1iZXI7XG4gIHZlcnNpb246IHN0cmluZztcbiAgdG9rZW46IHN0cmluZztcbn1cblxuLyoqIEhvc3RSZWFkeUxpbmUgXHU3Njg0XHU3QzdCXHU1NzhCXHU1Qjg4XHU1MzZCXHU0RUNFIGNvbnRyYWN0cyBcdTVGMTVcdTUxNjUsXHU5MDdGXHU1MTREXHU1M0NDXHU1QjlFXHU3M0IwXHUzMDAyICovXG5pbXBvcnQgeyBpc0hvc3RSZWFkeUxpbmUgfSBmcm9tICdAaG1oLWRlc2t0b3AvY29udHJhY3RzJztcblxuY29uc3QgREVGQVVMVF9TVEFSVF9USU1FT1VUX01TID0gMjBfMDAwO1xuY29uc3QgREVGQVVMVF9NQVhfUkVTVEFSVFMgPSAzO1xuY29uc3QgREVGQVVMVF9HUkFDRUZVTF9NUyA9IDVfMDAwO1xuXG5leHBvcnQgY2xhc3MgRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yIHtcbiAgcHJpdmF0ZSBjaGlsZDogQ2hpbGRQcm9jZXNzIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgX3N0YXRlOiBIb3N0U3RhdGUgPSAnc3RvcHBlZCc7XG4gIHByaXZhdGUgcmVzdGFydENvdW50ID0gMDtcbiAgcHJpdmF0ZSBsYXN0RXJyb3IgPSAnJztcbiAgcHJpdmF0ZSBzdG9wcGluZyA9IGZhbHNlO1xuICBwcml2YXRlIHJlYWRvbmx5IHRva2VuOiBzdHJpbmc7XG4gIHByaXZhdGUgcmVhZG9ubHkgb3B0czogUmVxdWlyZWQ8UGljazxTdXBlcnZpc29yT3B0aW9ucywgJ21heFJlc3RhcnRzJyB8ICdzdGFydFRpbWVvdXRNcycgfCAnZ3JhY2VmdWxTaHV0ZG93bk1zJz4+ICYgU3VwZXJ2aXNvck9wdGlvbnM7XG4gIHByaXZhdGUgZXhpdFdhaXRlcnM6IEFycmF5PCgpID0+IHZvaWQ+ID0gW107XG5cbiAgY29uc3RydWN0b3IoXG4gICAgcHJpdmF0ZSByZWFkb25seSBzcGVjOiBIb3N0U3BlYyxcbiAgICBvcHRzOiBTdXBlcnZpc29yT3B0aW9ucyA9IHt9LFxuICApIHtcbiAgICB0aGlzLnRva2VuID0gb3B0cy50b2tlbiA/PyByYW5kb21CeXRlcygzMikudG9TdHJpbmcoJ2Jhc2U2NHVybCcpO1xuICAgIHRoaXMub3B0cyA9IHtcbiAgICAgIG1heFJlc3RhcnRzOiBvcHRzLm1heFJlc3RhcnRzID8/IERFRkFVTFRfTUFYX1JFU1RBUlRTLFxuICAgICAgc3RhcnRUaW1lb3V0TXM6IG9wdHMuc3RhcnRUaW1lb3V0TXMgPz8gREVGQVVMVF9TVEFSVF9USU1FT1VUX01TLFxuICAgICAgZ3JhY2VmdWxTaHV0ZG93bk1zOiBvcHRzLmdyYWNlZnVsU2h1dGRvd25NcyA/PyBERUZBVUxUX0dSQUNFRlVMX01TLFxuICAgICAgLi4ub3B0cyxcbiAgICB9O1xuICB9XG5cbiAgZ2V0IHN0YXRlKCk6IEhvc3RTdGF0ZSB7XG4gICAgcmV0dXJuIHRoaXMuX3N0YXRlO1xuICB9XG5cbiAgZ2V0IHJlc3RhcnRzVXNlZCgpOiBudW1iZXIge1xuICAgIHJldHVybiB0aGlzLnJlc3RhcnRDb3VudDtcbiAgfVxuXG4gIHByaXZhdGUgc2V0U3RhdGUoczogSG9zdFN0YXRlLCBlcnI/OiBzdHJpbmcpOiB2b2lkIHtcbiAgICB0aGlzLl9zdGF0ZSA9IHM7XG4gICAgaWYgKGVyciAhPT0gdW5kZWZpbmVkKSB0aGlzLmxhc3RFcnJvciA9IGVycjtcbiAgICBjb25zdCBpbmZvOiB7IHJlc3RhcnRDb3VudDogbnVtYmVyOyBsYXN0RXJyb3I/OiBzdHJpbmcgfSA9IHsgcmVzdGFydENvdW50OiB0aGlzLnJlc3RhcnRDb3VudCB9O1xuICAgIGlmICh0aGlzLmxhc3RFcnJvciAhPT0gJycpIGluZm8ubGFzdEVycm9yID0gdGhpcy5sYXN0RXJyb3I7XG4gICAgdGhpcy5vcHRzLm9uU3RhdGVDaGFuZ2U/LihzLCBpbmZvKTtcbiAgfVxuXG4gIC8qKiBcdTU0MkZcdTUyQTggaG9zdCBcdTVFNzZcdTdCNDlcdTVGODUgcmVhZHkoXHU1RjE1XHU1QkZDXHU4ODRDICsgXHU1RTI2IHRva2VuIFx1NzY4NFx1NTA2NVx1NUVCN1x1NjNBMlx1NkQ0QilcdTMwMDIgKi9cbiAgYXN5bmMgc3RhcnQoKTogUHJvbWlzZTxIb3N0RW5kcG9pbnQ+IHtcbiAgICBpZiAodGhpcy5fc3RhdGUgPT09ICdyZWFkeScgfHwgdGhpcy5fc3RhdGUgPT09ICdzdGFydGluZycpIHtcbiAgICAgIHRocm93IGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgc3VwZXJ2aXNvciBhbHJlYWR5ICR7dGhpcy5fc3RhdGV9YCk7XG4gICAgfVxuICAgIHRoaXMucmVzdGFydENvdW50ID0gMDtcbiAgICB0aGlzLnN0b3BwaW5nID0gZmFsc2U7XG4gICAgcmV0dXJuIHRoaXMubGF1bmNoKCk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGxhdW5jaCgpOiBQcm9taXNlPEhvc3RFbmRwb2ludD4ge1xuICAgIHRoaXMuc2V0U3RhdGUoJ3N0YXJ0aW5nJyk7XG4gICAgY29uc3QgY2hpbGQgPSBzcGF3bih0aGlzLnNwZWMuY29tbWFuZCwgdGhpcy5zcGVjLmFyZ3MsIHtcbiAgICAgIGN3ZDogdGhpcy5zcGVjLmN3ZCxcbiAgICAgIGVudjoge1xuICAgICAgICAuLi5wcm9jZXNzLmVudixcbiAgICAgICAgLi4udGhpcy5zcGVjLmVudixcbiAgICAgICAgSE1IX0RFU0tUT1BfVE9LRU46IHRoaXMudG9rZW4sXG4gICAgICB9LFxuICAgICAgc3RkaW86IFsnaWdub3JlJywgJ3BpcGUnLCAncGlwZSddLFxuICAgICAgd2luZG93c0hpZGU6IHRydWUsXG4gICAgfSk7XG4gICAgdGhpcy5jaGlsZCA9IGNoaWxkO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGVuZHBvaW50ID0gYXdhaXQgdGhpcy5hd2FpdFJlYWR5KGNoaWxkKTtcbiAgICAgIHRoaXMuY3VycmVudEVuZHBvaW50ID0geyBwb3J0OiBlbmRwb2ludC5wb3J0LCB2ZXJzaW9uOiBlbmRwb2ludC52ZXJzaW9uIH07XG4gICAgICB0aGlzLnNldFN0YXRlKCdyZWFkeScpO1xuICAgICAgdGhpcy5vcHRzLm9uUmVhZHk/LihlbmRwb2ludCk7XG4gICAgICAvLyByZWFkeSBcdTRFNEJcdTU0MEVcdThGREJcdTdBMEJcdTZCN0JcdTRFQTEgPSBcdTYxMEZcdTU5MTZcdTkwMDBcdTUxRkEgXHUyMTkyIFx1NjcwOVx1OTY1MFx1OTFDRFx1NTQyRlxuICAgICAgY2hpbGQub25jZSgnZXhpdCcsICgpID0+IHtcbiAgICAgICAgdGhpcy5leGl0V2FpdGVycy5mb3JFYWNoKCh3KSA9PiB3KCkpO1xuICAgICAgICB0aGlzLmV4aXRXYWl0ZXJzID0gW107XG4gICAgICAgIHRoaXMub25VbmV4cGVjdGVkRXhpdCgpO1xuICAgICAgfSk7XG4gICAgICByZXR1cm4gZW5kcG9pbnQ7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBpZiAoIWNoaWxkLmtpbGxlZCkgY2hpbGQua2lsbCgpO1xuICAgICAgaWYgKHRoaXMuY2hpbGQgPT09IGNoaWxkKSB0aGlzLmNoaWxkID0gbnVsbDtcbiAgICAgIHRocm93IGVycjtcbiAgICB9XG4gIH1cblxuICAvKiogXHU0RUNFIHN0ZG91dCBcdTYyN0UgSG9zdFJlYWR5TGluZSxcdTcxMzZcdTU0MEVcdTUwNjVcdTVFQjdcdTYzQTJcdTZENEJcdTMwMDIgKi9cbiAgcHJpdmF0ZSBhd2FpdFJlYWR5KGNoaWxkOiBDaGlsZFByb2Nlc3MpOiBQcm9taXNlPEhvc3RFbmRwb2ludD4ge1xuICAgIHJldHVybiBuZXcgUHJvbWlzZTxIb3N0RW5kcG9pbnQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgIHJlamVjdChkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYGhvc3QgZGlkIG5vdCBzaWduYWwgcmVhZHkgd2l0aGluICR7dGhpcy5vcHRzLnN0YXJ0VGltZW91dE1zfW1zYCwgeyByZXRyeWFibGU6IHRydWUsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XG4gICAgICB9LCB0aGlzLm9wdHMuc3RhcnRUaW1lb3V0TXMpO1xuXG4gICAgICBjb25zdCBkb25lID0gKGZuOiAoKSA9PiB2b2lkKTogdm9pZCA9PiB7XG4gICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgIGZuKCk7XG4gICAgICB9O1xuXG4gICAgICBpZiAoIWNoaWxkLnN0ZG91dCkge1xuICAgICAgICBkb25lKCgpID0+IHJlamVjdChkZXNrdG9wRXJyb3IoJ1JVTlRJTUVfQ1JBU0hFRCcsICdob3N0IHNwYXduZWQgd2l0aG91dCBzdGRvdXQgcGlwZScpKSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgY29uc3QgcmwgPSBjcmVhdGVJbnRlcmZhY2UoeyBpbnB1dDogY2hpbGQuc3Rkb3V0IH0pO1xuICAgICAgY29uc3Qgb25MaW5lID0gKGxpbmU6IHN0cmluZyk6IHZvaWQgPT4ge1xuICAgICAgICBsZXQgcGFyc2VkOiB1bmtub3duO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHBhcnNlZCA9IEpTT04ucGFyc2UobGluZSk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIHJldHVybjsgLy8gaG9zdCBcdTc2ODRcdTY2NkVcdTkwMUFcdTY1RTVcdTVGRDdcdTg4NEMsXHU1RkZEXHU3NTY1XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGlzSG9zdFJlYWR5TGluZShwYXJzZWQpKSB7XG4gICAgICAgICAgcmwuY2xvc2UoKTtcbiAgICAgICAgICB2b2lkIHRoaXMucHJvYmVBbmRSZW1lbWJlcihwYXJzZWQucG9ydCwgcGFyc2VkLnZlcnNpb24pXG4gICAgICAgICAgICAudGhlbigoZW5kcG9pbnQpID0+IGRvbmUoKCkgPT4gcmVzb2x2ZShlbmRwb2ludCkpKVxuICAgICAgICAgICAgLmNhdGNoKChlcnI6IHVua25vd24pID0+IGRvbmUoKCkgPT4gcmVqZWN0KGVycikpKTtcbiAgICAgICAgfVxuICAgICAgfTtcbiAgICAgIHJsLm9uKCdsaW5lJywgb25MaW5lKTtcblxuICAgICAgY2hpbGQub25jZSgnZXhpdCcsIChjb2RlKSA9PiB7XG4gICAgICAgIGRvbmUoKCkgPT4gcmVqZWN0KGRlc2t0b3BFcnJvcignUlVOVElNRV9DUkFTSEVEJywgYGhvc3QgZXhpdGVkIGR1cmluZyBzdGFydHVwIChjb2RlICR7Y29kZSA/PyAnbnVsbCd9KWAsIHsgcmV0cnlhYmxlOiBmYWxzZSwgcmVjb3ZlcnlBY3Rpb246ICdPUEVOX0xPR1MnIH0pKSk7XG4gICAgICB9KTtcbiAgICB9KTtcbiAgfVxuXG4gIC8qKiBcdTVFMjYgdG9rZW4gXHU3Njg0XHU1MDY1XHU1RUI3XHU2M0EyXHU2RDRCOkdFVCAvYXBpL3N0YXRlXHUzMDAyNDAxIFx1MjE5MiBBVVRIX0ZBSUxFRChcdTRFMERcdTkxQ0RcdThCRDUpXHUzMDAyICovXG4gIHByaXZhdGUgYXN5bmMgcHJvYmUocG9ydDogbnVtYmVyLCB2ZXJzaW9uOiBzdHJpbmcpOiBQcm9taXNlPEhvc3RFbmRwb2ludD4ge1xuICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgIHRyeSB7XG4gICAgICByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2FwaS9zdGF0ZWAsIHtcbiAgICAgICAgaGVhZGVyczogeyAneC1obWgta2V5JzogdGhpcy50b2tlbiB9LFxuICAgICAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoM18wMDApLFxuICAgICAgfSk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICB0aHJvdyBkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYGhlYWx0aCBwcm9iZSBmYWlsZWQ6ICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTYwKX1gLCB7IHJldHJ5YWJsZTogdHJ1ZSB9KTtcbiAgICB9XG4gICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSB8fCByZXMuc3RhdHVzID09PSA0MDMpIHtcbiAgICAgIHRocm93IGRlc2t0b3BFcnJvcignQVVUSF9GQUlMRUQnLCBgaG9zdCByZWplY3RlZCB0aGUgc2Vzc2lvbiB0b2tlbiAoSFRUUCAke3Jlcy5zdGF0dXN9KWAsIHsgcmV0cnlhYmxlOiBmYWxzZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pO1xuICAgIH1cbiAgICBpZiAoIXJlcy5vaykge1xuICAgICAgdGhyb3cgZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBoZWFsdGggcHJvYmUgSFRUUCAke3Jlcy5zdGF0dXN9YCwgeyByZXRyeWFibGU6IHRydWUgfSk7XG4gICAgfVxuICAgIHJldHVybiB7IHBvcnQsIHZlcnNpb24sIHRva2VuOiB0aGlzLnRva2VuIH07XG4gIH1cblxuICBwcml2YXRlIG9uVW5leHBlY3RlZEV4aXQoKTogdm9pZCB7XG4gICAgaWYgKHRoaXMuc3RvcHBpbmcgfHwgdGhpcy5fc3RhdGUgPT09ICdzdG9wcGVkJyB8fCB0aGlzLl9zdGF0ZSA9PT0gJ3N0b3BwaW5nJykgcmV0dXJuO1xuICAgIHRoaXMuY2hpbGQgPSBudWxsO1xuICAgIGlmICh0aGlzLnJlc3RhcnRDb3VudCA8IHRoaXMub3B0cy5tYXhSZXN0YXJ0cykge1xuICAgICAgdGhpcy5yZXN0YXJ0Q291bnQgKz0gMTtcbiAgICAgIHRoaXMuc2V0U3RhdGUoJ3Jlc3RhcnRpbmcnKTtcbiAgICAgIHZvaWQgdGhpcy5sYXVuY2goKS5jYXRjaCgoKSA9PiB7XG4gICAgICAgIC8vIFx1OTFDRFx1NTQyRlx1NUMxRFx1OEJENVx1NTkzMVx1OEQyNShcdTU0MkZcdTUyQThcdTUzNzNcdTVEMjkvXHU4RDg1XHU2NUY2L1x1NjJEMlx1OEJBNCk6XHU3RUU3XHU3RUVEXHU2RDg4XHU4MDE3XHU5MUNEXHU1NDJGXHU2QjIxXHU2NTcwXHU3NkY0XHU1MjMwXHU2NTNFXHU1RjAzXG4gICAgICAgIHRoaXMucmV0cnlPckZhaWwoKTtcbiAgICAgIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLnNldFN0YXRlKCdmYWlsZWQnLCBgaG9zdCBleGl0ZWQgdW5leHBlY3RlZGx5ICR7dGhpcy5yZXN0YXJ0Q291bnQgKyAxfSB0aW1lczsgZ2l2aW5nIHVwYCk7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSByZXRyeU9yRmFpbCgpOiB2b2lkIHtcbiAgICBpZiAodGhpcy5zdG9wcGluZyB8fCB0aGlzLl9zdGF0ZSA9PT0gJ3N0b3BwZWQnIHx8IHRoaXMuX3N0YXRlID09PSAnc3RvcHBpbmcnKSByZXR1cm47XG4gICAgaWYgKHRoaXMucmVzdGFydENvdW50IDwgdGhpcy5vcHRzLm1heFJlc3RhcnRzKSB7XG4gICAgICB0aGlzLnJlc3RhcnRDb3VudCArPSAxO1xuICAgICAgdGhpcy5zZXRTdGF0ZSgncmVzdGFydGluZycpO1xuICAgICAgdm9pZCB0aGlzLmxhdW5jaCgpLmNhdGNoKCgpID0+IHRoaXMucmV0cnlPckZhaWwoKSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMuc2V0U3RhdGUoJ2ZhaWxlZCcsIGBob3N0IGZhaWxlZCB0byBzdGF5IHVwIGFmdGVyICR7dGhpcy5yZXN0YXJ0Q291bnR9IHJlc3RhcnQgYXR0ZW1wdHNgKTtcbiAgICB9XG4gIH1cblxuICAvKiogXHU0RjE4XHU5NkM1XHU1MDVDXHU2QjYyOlx1NTE0OCBIVFRQIHNodXRkb3duLFx1OEQ4NVx1NjVGNlx1NjI0RFx1NUJGOVx1NjcyQ1x1OEZEQlx1N0EwQlx1NTNFNVx1NjdDNCBraWxsXHUzMDAyICovXG4gIGFzeW5jIHN0b3AoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgdGhpcy5zdG9wcGluZyA9IHRydWU7XG4gICAgaWYgKHRoaXMuX3N0YXRlID09PSAnc3RvcHBlZCcpIHJldHVybjtcbiAgICB0aGlzLnNldFN0YXRlKCdzdG9wcGluZycpO1xuICAgIGNvbnN0IGNoaWxkID0gdGhpcy5jaGlsZDtcbiAgICB0aGlzLmNoaWxkID0gbnVsbDtcbiAgICB0aGlzLmN1cnJlbnRFbmRwb2ludCA9IG51bGw7XG4gICAgaWYgKCFjaGlsZCkge1xuICAgICAgdGhpcy5zZXRTdGF0ZSgnc3RvcHBlZCcpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBleGl0ZWQgPSBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4ge1xuICAgICAgaWYgKGNoaWxkLmV4aXRDb2RlICE9PSBudWxsIHx8IGNoaWxkLnNpZ25hbENvZGUgIT09IG51bGwpIHJlc29sdmUoKTtcbiAgICAgIGVsc2Uge1xuICAgICAgICBjb25zdCB3ID0gKCk6IHZvaWQgPT4gcmVzb2x2ZSgpO1xuICAgICAgICB0aGlzLmV4aXRXYWl0ZXJzLnB1c2godyk7XG4gICAgICAgIGNoaWxkLm9uY2UoJ2V4aXQnLCB3KTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICAvLyBcdTVERjJcdTc3RTVcdTdBRUZcdTUzRTNcdTYyNERcdTVDMURcdThCRDUgSFRUUCBcdTRGMThcdTk2QzVcdTUxNzNcdTk1RUQ7XHU2NzJBXHU3N0U1XHU3QUVGXHU1M0UzXHU3NkY0XHU2M0E1XHU4RDcwIGtpbGwgXHU1MTVDXHU1RTk1XG4gICAgaWYgKHRoaXMubGFzdEVuZHBvaW50ICE9PSBudWxsKSB7XG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3RoaXMubGFzdEVuZHBvaW50fS9hcGkvZGVza3RvcC9zaHV0ZG93bmAsIHtcbiAgICAgICAgICBtZXRob2Q6ICdQT1NUJyxcbiAgICAgICAgICBoZWFkZXJzOiB7ICd4LWhtaC1rZXknOiB0aGlzLnRva2VuIH0sXG4gICAgICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDFfMDAwKSxcbiAgICAgICAgfSk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLy8gaG9zdCBcdTVERjJcdTZCN0JcdTYyMTZcdTRFMERcdTVFOTRcdTdCNTQ6XHU4RDcwIGtpbGwgXHU1MTVDXHU1RTk1XG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IGdyYWNlZnVsID0gYXdhaXQgUHJvbWlzZS5yYWNlKFtcbiAgICAgIGV4aXRlZC50aGVuKCgpID0+IHRydWUpLFxuICAgICAgbmV3IFByb21pc2U8Ym9vbGVhbj4oKHJlc29sdmUpID0+IHNldFRpbWVvdXQoKCkgPT4gcmVzb2x2ZShmYWxzZSksIHRoaXMub3B0cy5ncmFjZWZ1bFNodXRkb3duTXMpKSxcbiAgICBdKTtcbiAgICBpZiAoIWdyYWNlZnVsICYmIGNoaWxkLmV4aXRDb2RlID09PSBudWxsICYmIGNoaWxkLnNpZ25hbENvZGUgPT09IG51bGwpIHtcbiAgICAgIGNoaWxkLmtpbGwoKTsgLy8gXHU1M0VBXHU2NzQwXHU4MUVBXHU1REYxXHU2MzAxXHU2NzA5XHU3Njg0XHU1M0U1XHU2N0M0LFx1N0VERFx1NEUwRFx1NjMwOVx1OEZEQlx1N0EwQlx1NTQwRFxuICAgIH1cbiAgICBhd2FpdCBleGl0ZWQuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcbiAgICB0aGlzLnNldFN0YXRlKCdzdG9wcGVkJyk7XG4gIH1cblxuICBwcml2YXRlIGxhc3RFbmRwb2ludDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgY3VycmVudEVuZHBvaW50OiB7IHBvcnQ6IG51bWJlcjsgdmVyc2lvbjogc3RyaW5nIH0gfCBudWxsID0gbnVsbDtcblxuICAvKiogXHU1RjUzXHU1MjREIGhvc3QgXHU3QUVGXHU3MEI5KHJlYWR5IFx1NTQwRVx1NjcwOVx1NTAzQztcdTRFMERcdTU0MkIgdG9rZW4pXHUzMDAyICovXG4gIGdldCBlbmRwb2ludCgpOiB7IHBvcnQ6IG51bWJlcjsgdmVyc2lvbjogc3RyaW5nIH0gfCBudWxsIHtcbiAgICByZXR1cm4gdGhpcy5jdXJyZW50RW5kcG9pbnQ7XG4gIH1cblxuICAvKiogXHU2M0EyXHU2RDRCXHU2MjEwXHU1MjlGXHU1NDBFXHU4QkIwXHU0RjRGXHU3QUVGXHU1M0UzLFx1NEY5QiBzdG9wKCkgXHU3Njg0XHU0RjE4XHU5NkM1XHU1MTczXHU5NUVEXHU0RjdGXHU3NTI4XHUzMDAyICovXG4gIHByaXZhdGUgYXN5bmMgcHJvYmVBbmRSZW1lbWJlcihwb3J0OiBudW1iZXIsIHZlcnNpb246IHN0cmluZyk6IFByb21pc2U8SG9zdEVuZHBvaW50PiB7XG4gICAgY29uc3QgZXAgPSBhd2FpdCB0aGlzLnByb2JlKHBvcnQsIHZlcnNpb24pO1xuICAgIHRoaXMubGFzdEVuZHBvaW50ID0gZXAucG9ydDtcbiAgICByZXR1cm4gZXA7XG4gIH1cbn1cblxuLyoqIFx1NjI4QVx1NjcyQVx1NzdFNVx1OTUxOVx1OEJFRlx1ODlDNFx1N0VBNlx1NEUzQSBEZXNrdG9wRXJyb3IoXHU1REYyXHU2NjJGXHU1MjE5XHU1MzlGXHU2ODM3XHU4RkQ0XHU1NkRFKVx1MzAwMiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRvRGVza3RvcEVycm9yKGVycjogdW5rbm93bik6IERlc2t0b3BFcnJvciB7XG4gIGlmIChpc0Rlc2t0b3BFcnJvcihlcnIpKSByZXR1cm4gZXJyO1xuICBjb25zdCBtZXNzYWdlID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICByZXR1cm4gZGVza3RvcEVycm9yKCdSVU5USU1FX0NSQVNIRUQnLCBtZXNzYWdlLnNsaWNlKDAsIDMwMCksIHsgcmV0cnlhYmxlOiBmYWxzZSB9KTtcbn1cbiIsICIvKipcbiAqIEBobWgtZGVza3RvcC9jb250cmFjdHMgXHUyMDE0IFx1NEU4Qlx1NEVGNlx1NEZFMVx1NUMwMShcdTVGMDBcdTUzRDFcdThCQTFcdTUyMTJcdTY1ODdcdTY4NjMgMDQgXHUwMEE3XHU0RTA5KVxuICpcbiAqIFx1NEUwMFx1Njc2MSBVSSBcdTRFOEJcdTRFRjZcdTc2ODRcdTU1MkZcdTRFMDBcdTVGNjJcdTcyQjZcdTMwMDJcdTUyNERcdTdBRUYgcmVkdWNlciBcdTVGQzVcdTk4N0JcdTYzMDkgc2Vzc2lvbklkL3J1bklkL3NlcSBcdTU5MDRcdTc0MDY7XG4gKiBcdTkxQ0RcdTU5MEQgZXZlbnRJZCBcdTVFNDJcdTdCNDlcdTRFMjJcdTVGMDM7c2VxIFx1N0YzQVx1NTNFM1x1ODlFNlx1NTNEMVx1ODg2NVx1NjJDOTtcdTk3NUVcdTVFNDJcdTdCNDlcdTUyQThcdTRGNUNcdTRFMERcdTc1MzEgU1NFIFx1ODFFQVx1NTJBOFx1OTFDRFx1NTNEMVx1MzAwMlxuICovXG5cbmltcG9ydCB0eXBlIHsgQXJ0aWZhY3RSZWYgfSBmcm9tICcuL2R0by50cyc7XG5pbXBvcnQgdHlwZSB7IERlc2t0b3BFcnJvciB9IGZyb20gJy4vZXJyb3IudHMnO1xuXG4vKiogXHU0RThCXHU0RUY2XHU3OUNEXHU3QzdCKFx1NTIyNFx1NTIyQlx1OTUyRSlcdTMwMDJcdTY1QjBcdTU4OUUga2luZCA9IHNjaGVtYVZlcnNpb24gXHU1MzQ3XHU3RUE3LFx1NEUwRFx1NTE0MVx1OEJCOFx1OTc1OVx1OUVEOFx1NjI2OVx1Njc5QVx1NEUzRVx1MzAwMiAqL1xuZXhwb3J0IGNvbnN0IEVWRU5UX0tJTkRTID0gW1xuICAncnVuLnN0YXJ0ZWQnLFxuICAncGxhbi51cGRhdGVkJyxcbiAgJ3Rvb2wuc3RhcnRlZCcsXG4gICd0b29sLmNvbXBsZXRlZCcsXG4gICdhcHByb3ZhbC5yZXF1aXJlZCcsXG4gICd2ZXJpZmljYXRpb24udXBkYXRlZCcsXG4gICdhcnRpZmFjdC5jcmVhdGVkJyxcbiAgJ3J1bi5jb21wbGV0ZWQnLFxuICAncnVuLmZhaWxlZCcsXG5dIGFzIGNvbnN0O1xuXG5leHBvcnQgdHlwZSBFdmVudEtpbmQgPSAodHlwZW9mIEVWRU5UX0tJTkRTKVtudW1iZXJdO1xuXG5leHBvcnQgY29uc3QgRVZFTlRfU0NIRU1BX1ZFUlNJT04gPSAxO1xuZXhwb3J0IHR5cGUgRXZlbnRTY2hlbWFWZXJzaW9uID0gMTtcblxuLyoqIFNTRSBcdTZENDFcdTRFMEFcdTc2ODRcdTZCQ0ZcdTRFMDBcdTY3NjFcdTRFOEJcdTRFRjZcdTMwMDIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgRXZlbnRFbnZlbG9wZTxUID0gdW5rbm93bj4ge1xuICBzY2hlbWFWZXJzaW9uOiBFdmVudFNjaGVtYVZlcnNpb247XG4gIC8qKiBcdTUxNjhcdTVDNDBcdTU1MkZcdTRFMDA7XHU5MUNEXHU4RkRFL1x1ODg2NVx1NjJDOVx1NTQwRVx1OTFDRFx1NTkwRFx1NTFGQVx1NzNCMFx1NjVGNlx1NjNBNVx1NjUzNlx1NjVCOVx1NUU0Mlx1N0I0OVx1NEUyMlx1NUYwM1x1MzAwMiAqL1xuICBldmVudElkOiBzdHJpbmc7XG4gIHNlc3Npb25JZDogc3RyaW5nO1xuICBydW5JZDogc3RyaW5nO1xuICAvKiogXHU0RjFBXHU4QkREXHU1MTg1XHU1MzU1XHU4QzAzXHU5MDEyXHU1ODlFO1x1N0YzQVx1NTNFM1x1NjEwRlx1NTQ3M1x1Nzc0MFx1NEUyMlx1NEU4Qlx1NEVGNixcdTk3MDBcdTg5ODFcdTg4NjVcdTYyQzlcdTMwMDIgKi9cbiAgc2VxOiBudW1iZXI7XG4gIC8qKiBSRkMzMzM5XHUzMDAyICovXG4gIG9jY3VycmVkQXQ6IHN0cmluZztcbiAga2luZDogRXZlbnRLaW5kO1xuICBwYXlsb2FkOiBUO1xufVxuXG4vKiogcnVuLnN0YXJ0ZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgUnVuU3RhcnRlZFBheWxvYWQge1xuICB0YXNrOiBzdHJpbmc7XG4gIG1vZGU6ICdhc2snIHwgJ2F1dG8nIHwgJ3lvbG8nO1xufVxuXG4vKiogcGxhbi51cGRhdGVkIFx1NzY4NCBwYXlsb2FkKFx1OEJBMVx1NTIxMlx1NkI2NVx1OUFBNFx1NTIxN1x1ODg2OCxcdTY3NjVcdTgxRUEgcnVudGltZSBcdTc2ODRcdTdFRDNcdTY3ODRcdTUzMTZcdThCQTFcdTUyMTIsXHU0RTBEXHU2NjJGIGNoYWluLW9mLXRob3VnaHQpXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIFBsYW5VcGRhdGVkUGF5bG9hZCB7XG4gIHN0ZXBzOiBBcnJheTx7IHRpdGxlOiBzdHJpbmc7IHN0YXR1czogJ3BlbmRpbmcnIHwgJ2FjdGl2ZScgfCAnZG9uZScgfCAnZmFpbGVkJyB9Pjtcbn1cblxuLyoqIHRvb2wuc3RhcnRlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBUb29sU3RhcnRlZFBheWxvYWQge1xuICBuYW1lOiBzdHJpbmc7XG4gIC8qKiBcdTUzQzJcdTY1NzBcdTRFRTVcdTY1ODdcdTY3MkNcdTU0NDhcdTczQjAsXHU2RTMyXHU2N0QzXHU3QUVGXHU2QzM4XHU0RTBEIGV2YWw7XHU1OTI3XHU1QkY5XHU4QzYxXHU3NTMxIHJ1bnRpbWUgXHU2MjJBXHU2NUFEXHUzMDAyICovXG4gIGFyZ3NQcmV2aWV3OiBzdHJpbmc7XG59XG5cbi8qKiB0b29sLmNvbXBsZXRlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBUb29sQ29tcGxldGVkUGF5bG9hZCB7XG4gIG5hbWU6IHN0cmluZztcbiAgaXNFcnJvcjogYm9vbGVhbjtcbiAgb3V0cHV0UHJldmlldzogc3RyaW5nO1xufVxuXG4vKiogYXBwcm92YWwucmVxdWlyZWQgXHU3Njg0IHBheWxvYWRcdTMwMDJcdTVCQTFcdTYyNzlcdTY3NDNcdTVBMDFcdTU3MjggcnVudGltZSBcdTU0MEVcdTdBRUY7VUkgXHU1M0VBXHU2NjJGXHU4RjZDXHU4RkYwXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcHJvdmFsUmVxdWlyZWRQYXlsb2FkIHtcbiAgYXBwcm92YWxJZDogc3RyaW5nO1xuICB0b29sOiBzdHJpbmc7XG4gIGFyZ3NQcmV2aWV3OiBzdHJpbmc7XG4gIC8qKiBcdTVGNzFcdTU0Q0RcdTgzMDNcdTU2RjQvXHU5OENFXHU5NjY5XHU3Njg0XHU0RUJBXHU3QzdCXHU1M0VGXHU4QkZCXHU4QkY0XHU2NjBFLFx1NzUzMSBydW50aW1lIFx1NzUxRlx1NjIxMFx1MzAwMiAqL1xuICByaXNrOiBzdHJpbmc7XG59XG5cbi8qKiB2ZXJpZmljYXRpb24udXBkYXRlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBWZXJpZmljYXRpb25VcGRhdGVkUGF5bG9hZCB7XG4gIHN1bW1hcnk6IHN0cmluZztcbiAgcGFzc2VkOiBib29sZWFuIHwgbnVsbDsgLy8gbnVsbCA9IFx1NjcyQVx1NzdFNS9cdThGREJcdTg4NENcdTRFMkQoTkVFRFMtREFUQSBcdTY1RjZcdTRFMERcdTUwNDdcdTU4NkIpXG59XG5cbi8qKiBhcnRpZmFjdC5jcmVhdGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIEFydGlmYWN0Q3JlYXRlZFBheWxvYWQge1xuICBhcnRpZmFjdDogQXJ0aWZhY3RSZWY7XG59XG5cbi8qKiBydW4uY29tcGxldGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIFJ1bkNvbXBsZXRlZFBheWxvYWQge1xuICB0ZXh0OiBzdHJpbmc7XG4gIHR1cm5zOiBudW1iZXI7XG4gIHRvb2xVc2VzOiBudW1iZXI7XG4gIHVzYWdlPzogeyBwcm9tcHRUb2tlbnM6IG51bWJlcjsgY29tcGxldGlvblRva2VuczogbnVtYmVyIH07XG59XG5cbi8qKiBydW4uZmFpbGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIFJ1bkZhaWxlZFBheWxvYWQge1xuICBlcnJvcjogRGVza3RvcEVycm9yO1xufVxuIiwgIi8qKlxuICogQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyBcdTIwMTQgXHU3RUQzXHU2Nzg0XHU1MzE2XHU2ODRDXHU5NzYyXHU5NTE5XHU4QkVGKFx1NUYwMFx1NTNEMVx1OEJBMVx1NTIxMlx1NjU4N1x1Njg2MyAwNCBcdTAwQTdcdTRFMDkpXHUzMDAyXG4gKlxuICogaG9zdC1ub3QtcmVhZHkgLyBhdXRoLWZhaWxlZCAvIHN0YWxlLXZlcnNpb24gLyBydW50aW1lLWNyYXNoZWQgL1xuICogcG9ydC1iaW5kLWZhaWxlZCAvIHNjaGVtYS1taXNtYXRjaCBcdTVGQzVcdTk4N0JcdTY2MkZcdTdFRDNcdTY3ODRcdTUzMTZcdTk1MTlcdThCRUZcdTc4MDEsXHU1RTc2XHU2M0QwXHU0RjlCXHU0RTBCXHU0RTAwXHU2QjY1XHU1MkE4XHU0RjVDXHUzMDAyXG4gKiBtZXNzYWdlIFx1NjYyRlx1N0VBRlx1NjU4N1x1NjcyQyxcdTZFMzJcdTY3RDNcdTdBRUZcdTZDMzhcdTRFMERcdTYyOEFcdTVCODNcdTVGNTMgSFRNTFx1MzAwMlxuICovXG5leHBvcnQgY29uc3QgRVJST1JfQ09ERVMgPSBbXG4gICdIT1NUX05PVF9SRUFEWScsXG4gICdBVVRIX0ZBSUxFRCcsXG4gICdSVU5USU1FX0NSQVNIRUQnLFxuICAnUE9SVF9CSU5EX0ZBSUxFRCcsXG4gICdTVEFMRV9WRVJTSU9OJyxcbiAgJ1NDSEVNQV9NSVNNQVRDSCcsXG5dIGFzIGNvbnN0O1xuXG5leHBvcnQgdHlwZSBFcnJvckNvZGUgPSAodHlwZW9mIEVSUk9SX0NPREVTKVtudW1iZXJdO1xuXG5leHBvcnQgY29uc3QgUkVDT1ZFUllfQUNUSU9OUyA9IFsnUkVDT05ORUNUJywgJ1JFU1VNRScsICdFWFBPUlQnLCAnT1BFTl9MT0dTJ10gYXMgY29uc3Q7XG5leHBvcnQgdHlwZSBSZWNvdmVyeUFjdGlvbiA9ICh0eXBlb2YgUkVDT1ZFUllfQUNUSU9OUylbbnVtYmVyXTtcblxuZXhwb3J0IGludGVyZmFjZSBEZXNrdG9wRXJyb3Ige1xuICBjb2RlOiBFcnJvckNvZGU7XG4gIC8qKiBcdTdFQUZcdTY1ODdcdTY3MkMsXHU2QzM4XHU0RTBEXHU0RkUxXHU0RUZCXHU0RTNBIEhUTUxcdTMwMDIgKi9cbiAgbWVzc2FnZTogc3RyaW5nO1xuICByZXRyeWFibGU6IGJvb2xlYW47XG4gIHNlc3Npb25JZD86IHN0cmluZztcbiAgcnVuSWQ/OiBzdHJpbmc7XG4gIHJlY292ZXJ5QWN0aW9uPzogUmVjb3ZlcnlBY3Rpb247XG59XG5cbi8qKiBcdTY3ODRcdTkwMjBcdTRFMDBcdTRFMkEgRGVza3RvcEVycm9yKGV4YWN0T3B0aW9uYWxQcm9wZXJ0eVR5cGVzIFx1NTNDQlx1NTk3RClcdTMwMDIgKi9cbmV4cG9ydCBmdW5jdGlvbiBkZXNrdG9wRXJyb3IoXG4gIGNvZGU6IEVycm9yQ29kZSxcbiAgbWVzc2FnZTogc3RyaW5nLFxuICBvcHRzOiB7IHJldHJ5YWJsZT86IGJvb2xlYW47IHNlc3Npb25JZD86IHN0cmluZzsgcnVuSWQ/OiBzdHJpbmc7IHJlY292ZXJ5QWN0aW9uPzogUmVjb3ZlcnlBY3Rpb24gfSA9IHt9LFxuKTogRGVza3RvcEVycm9yIHtcbiAgY29uc3QgZTogRGVza3RvcEVycm9yID0geyBjb2RlLCBtZXNzYWdlLCByZXRyeWFibGU6IG9wdHMucmV0cnlhYmxlID09PSB0cnVlIH07XG4gIGlmIChvcHRzLnNlc3Npb25JZCAhPT0gdW5kZWZpbmVkKSBlLnNlc3Npb25JZCA9IG9wdHMuc2Vzc2lvbklkO1xuICBpZiAob3B0cy5ydW5JZCAhPT0gdW5kZWZpbmVkKSBlLnJ1bklkID0gb3B0cy5ydW5JZDtcbiAgaWYgKG9wdHMucmVjb3ZlcnlBY3Rpb24gIT09IHVuZGVmaW5lZCkgZS5yZWNvdmVyeUFjdGlvbiA9IG9wdHMucmVjb3ZlcnlBY3Rpb247XG4gIHJldHVybiBlO1xufVxuIiwgIi8qKlxuICogQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyBcdTIwMTQgcnVudGltZSBcdTY4MjFcdTlBOEMoZ3VhcmRzKVx1MzAwMlxuICpcbiAqIFx1NkJDRlx1NEUyQVx1OERFOFx1NEZFMVx1NEVGQlx1OEZCOVx1NzU0Q1x1NzY4NFx1NjU3MFx1NjM2RShydW50aW1lXHUyMTkycmVuZGVyZXJcdTMwMDFob3N0XHUyMTkybWFpbilcdThGREJcdTUxNjVcdTUyNERcdTUxNDhcdThGQzcgZ3VhcmQ7XG4gKiBcdTY4MjFcdTlBOENcdTU5MzFcdThEMjVcdTc2ODRcdTY1NzBcdTYzNkVcdTYzMDkgU0NIRU1BX01JU01BVENIIFx1N0VEM1x1Njc4NFx1NTMxNlx1OTUxOVx1OEJFRlx1NTkwNFx1NzQwNixcdTRFMERcdTk3NTlcdTlFRDhcdTYzQTVcdTUzRDdcdTMwMDJcbiAqIFx1NjI0Qlx1NTE5OVx1NUI4OFx1NTM2Qlx1ODAwQ1x1NEUwRFx1NjYyRlx1NUYxNVx1N0IyQ1x1NEUwOVx1NjVCOSBzY2hlbWEgXHU1RTkzOlx1NTk1MVx1N0VBNlx1OTc2Mlx1NUMwRixcdTk2RjZcdTRGOURcdThENTZcdTY1ODdcdTUzMTYoaG1oYXJuZXNzIFx1NTQwQ1x1NkU5MClcdTMwMDJcbiAqL1xuaW1wb3J0IHtcbiAgRVZFTlRfS0lORFMsXG4gIEVWRU5UX1NDSEVNQV9WRVJTSU9OLFxuICB0eXBlIEV2ZW50RW52ZWxvcGUsXG4gIHR5cGUgRXZlbnRLaW5kLFxufSBmcm9tICcuL2V2ZW50LnRzJztcbmltcG9ydCB7IEVSUk9SX0NPREVTLCBSRUNPVkVSWV9BQ1RJT05TLCB0eXBlIERlc2t0b3BFcnJvciB9IGZyb20gJy4vZXJyb3IudHMnO1xuaW1wb3J0IHsgUlVOX1NUQVRVU0VTLCB0eXBlIFJ1blN0YXR1cyB9IGZyb20gJy4vZHRvLnRzJztcblxuY29uc3QgaXNSZWNvcmQgPSAodjogdW5rbm93bik6IHYgaXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPT5cbiAgdHlwZW9mIHYgPT09ICdvYmplY3QnICYmIHYgIT09IG51bGwgJiYgIUFycmF5LmlzQXJyYXkodik7XG5cbmNvbnN0IGlzTm9uRW1wdHlTdHJpbmcgPSAodjogdW5rbm93bik6IHYgaXMgc3RyaW5nID0+IHR5cGVvZiB2ID09PSAnc3RyaW5nJyAmJiB2Lmxlbmd0aCA+IDA7XG5cbmNvbnN0IGlzUmZjMzMzOSA9ICh2OiBzdHJpbmcpOiBib29sZWFuID0+IHtcbiAgY29uc3QgdCA9IERhdGUucGFyc2Uodik7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUodCkgJiYgL1xcZHs0fS1cXGR7Mn0tXFxkezJ9VC8udGVzdCh2KTtcbn07XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0V2ZW50RW52ZWxvcGUodjogdW5rbm93bik6IHYgaXMgRXZlbnRFbnZlbG9wZSB7XG4gIGlmICghaXNSZWNvcmQodikpIHJldHVybiBmYWxzZTtcbiAgaWYgKHYuc2NoZW1hVmVyc2lvbiAhPT0gRVZFTlRfU0NIRU1BX1ZFUlNJT04pIHJldHVybiBmYWxzZTtcbiAgaWYgKCFpc05vbkVtcHR5U3RyaW5nKHYuZXZlbnRJZCkpIHJldHVybiBmYWxzZTtcbiAgaWYgKCFpc05vbkVtcHR5U3RyaW5nKHYuc2Vzc2lvbklkKSkgcmV0dXJuIGZhbHNlO1xuICBpZiAoIWlzTm9uRW1wdHlTdHJpbmcodi5ydW5JZCkpIHJldHVybiBmYWxzZTtcbiAgaWYgKHR5cGVvZiB2LnNlcSAhPT0gJ251bWJlcicgfHwgIU51bWJlci5pc0ludGVnZXIodi5zZXEpIHx8IHYuc2VxIDwgMCkgcmV0dXJuIGZhbHNlO1xuICBpZiAoIWlzTm9uRW1wdHlTdHJpbmcodi5vY2N1cnJlZEF0KSB8fCAhaXNSZmMzMzM5KHYub2NjdXJyZWRBdCkpIHJldHVybiBmYWxzZTtcbiAgaWYgKCFFVkVOVF9LSU5EUy5pbmNsdWRlcyh2LmtpbmQgYXMgRXZlbnRLaW5kKSkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gaXNSZWNvcmQodi5wYXlsb2FkKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzRGVza3RvcEVycm9yKHY6IHVua25vd24pOiB2IGlzIERlc2t0b3BFcnJvciB7XG4gIGlmICghaXNSZWNvcmQodikpIHJldHVybiBmYWxzZTtcbiAgaWYgKCFFUlJPUl9DT0RFUy5pbmNsdWRlcyh2LmNvZGUgYXMgbmV2ZXIpKSByZXR1cm4gZmFsc2U7XG4gIGlmICh0eXBlb2Ygdi5tZXNzYWdlICE9PSAnc3RyaW5nJykgcmV0dXJuIGZhbHNlO1xuICBpZiAodHlwZW9mIHYucmV0cnlhYmxlICE9PSAnYm9vbGVhbicpIHJldHVybiBmYWxzZTtcbiAgaWYgKHYuc2Vzc2lvbklkICE9PSB1bmRlZmluZWQgJiYgIWlzTm9uRW1wdHlTdHJpbmcodi5zZXNzaW9uSWQpKSByZXR1cm4gZmFsc2U7XG4gIGlmICh2LnJ1bklkICE9PSB1bmRlZmluZWQgJiYgIWlzTm9uRW1wdHlTdHJpbmcodi5ydW5JZCkpIHJldHVybiBmYWxzZTtcbiAgaWYgKHYucmVjb3ZlcnlBY3Rpb24gIT09IHVuZGVmaW5lZCAmJiAhUkVDT1ZFUllfQUNUSU9OUy5pbmNsdWRlcyh2LnJlY292ZXJ5QWN0aW9uIGFzIG5ldmVyKSkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzUnVuU3RhdHVzKHY6IHVua25vd24pOiB2IGlzIFJ1blN0YXR1cyB7XG4gIHJldHVybiB0eXBlb2YgdiA9PT0gJ3N0cmluZycgJiYgUlVOX1NUQVRVU0VTLmluY2x1ZGVzKHYgYXMgUnVuU3RhdHVzKTtcbn1cblxuLyoqIEhvc3QgXHU1RjE1XHU1QkZDXHU4ODRDKHN0ZG91dCBcdTdCMkNcdTRFMDBcdTg4NEMpXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gaXNIb3N0UmVhZHlMaW5lKHY6IHVua25vd24pOiB2IGlzIHsgaG1oRGVza3RvcEhvc3RSZWFkeTogdHJ1ZTsgcG9ydDogbnVtYmVyOyB2ZXJzaW9uOiBzdHJpbmcgfSB7XG4gIGlmICghaXNSZWNvcmQodikpIHJldHVybiBmYWxzZTtcbiAgaWYgKHYuaG1oRGVza3RvcEhvc3RSZWFkeSAhPT0gdHJ1ZSkgcmV0dXJuIGZhbHNlO1xuICBpZiAodHlwZW9mIHYucG9ydCAhPT0gJ251bWJlcicgfHwgIU51bWJlci5pc0ludGVnZXIodi5wb3J0KSB8fCB2LnBvcnQgPD0gMCB8fCB2LnBvcnQgPiA2NTUzNSkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gaXNOb25FbXB0eVN0cmluZyh2LnZlcnNpb24pO1xufVxuIiwgIi8qKlxuICogRGVza3RvcEhvc3RDbGllbnQgXHUyMDE0IFx1NUJGOSBobWggaG9zdCBcdTc2ODQgSFRUUCtTU0UgXHU1QkEyXHU2MjM3XHU3QUVGXHUzMDAyXG4gKlxuICogLSBcdTZCQ0ZcdTRFMkEgSFRUUCBcdThCRjdcdTZDNDJcdTgxRUFcdTUyQThcdTVFMjYgWC1IbWgtS2V5KHRva2VuIFx1NEUwRFx1OEZEQiBVUkwpO1xuICogLSBcdTdFRDNcdTY3ODRcdTUzMTZcdTk1MTlcdThCRUYocmVzLmJvZHkgXHU5MUNDXHU3Njg0IERlc2t0b3BFcnJvciBcdTVGNjJcdTcyQjZcdTYyMTYgSFRUUCBcdTcyQjZcdTYwMDEpXHU4OUM0XHU3RUE2XHU2MjEwXHU1RjAyXHU1RTM4XHU2MjlCXHU1MUZBO1xuICogLSBTU0UgXHU3NTI4IGZldGNoIFx1NkQ0MVx1NjI0Qlx1NTE5OVx1ODlFM1x1Njc5MChpZC9ldmVudC9kYXRhIFx1NUUyNyksXHU2NTJGXHU2MzAxIExhc3QtRXZlbnQtSUQgXHU4ODY1XHU2MkM5XHU5MUNEXHU4RkRFXHUzMDAyXG4gKi9cbmltcG9ydCB7IGRlc2t0b3BFcnJvciwgaXNEZXNrdG9wRXJyb3IsIGlzRXZlbnRFbnZlbG9wZSwgdHlwZSBEZXNrdG9wRXJyb3IsIHR5cGUgRXZlbnRFbnZlbG9wZSB9IGZyb20gJ0BobWgtZGVza3RvcC9jb250cmFjdHMnO1xuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gJ25vZGU6Y3J5cHRvJztcblxuZXhwb3J0IGludGVyZmFjZSBTc2VGcmFtZSB7XG4gIGlkPzogc3RyaW5nO1xuICBldmVudDogc3RyaW5nO1xuICBkYXRhOiBzdHJpbmc7XG59XG5cbi8qKiBcdTg5RTNcdTY3OTBcdTRFMDBcdTZCQjUgU1NFIFx1NjU4N1x1NjcyQ1x1NEUzQVx1NUUyNyhcdTRFMERcdTU0MkJcdThERTggY2h1bmsgXHU3Njg0XHU3RjEzXHU1MUIyXHU5MDNCXHU4RjkxLFx1N0VBRlx1NTFGRFx1NjU3MFx1NEZCRlx1NEU4RVx1NkQ0Qlx1OEJENSlcdTMwMDIgKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVNzZUNodW5rKGNodW5rOiBzdHJpbmcpOiBTc2VGcmFtZVtdIHtcbiAgY29uc3QgZnJhbWVzOiBTc2VGcmFtZVtdID0gW107XG4gIGZvciAoY29uc3QgYmxvY2sgb2YgY2h1bmsuc3BsaXQoL1xcblxcbi8pKSB7XG4gICAgaWYgKCFibG9jay50cmltKCkpIGNvbnRpbnVlO1xuICAgIGxldCBpZDogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAgIGxldCBldmVudCA9ICdtZXNzYWdlJztcbiAgICBjb25zdCBkYXRhTGluZXM6IHN0cmluZ1tdID0gW107XG4gICAgbGV0IHNhd0ZpZWxkID0gZmFsc2U7XG4gICAgZm9yIChjb25zdCBsaW5lIG9mIGJsb2NrLnNwbGl0KCdcXG4nKSkge1xuICAgICAgaWYgKGxpbmUuc3RhcnRzV2l0aCgnOicpKSBjb250aW51ZTsgLy8gXHU2Q0U4XHU5MUNBL1x1NUZDM1x1OERGM1xuICAgICAgaWYgKGxpbmUuc3RhcnRzV2l0aCgnaWQ6JykpIHsgaWQgPSBsaW5lLnNsaWNlKDMpLnRyaW0oKTsgc2F3RmllbGQgPSB0cnVlOyB9XG4gICAgICBlbHNlIGlmIChsaW5lLnN0YXJ0c1dpdGgoJ2V2ZW50OicpKSB7IGV2ZW50ID0gbGluZS5zbGljZSg2KS50cmltKCk7IHNhd0ZpZWxkID0gdHJ1ZTsgfVxuICAgICAgZWxzZSBpZiAobGluZS5zdGFydHNXaXRoKCdkYXRhOicpKSB7IGRhdGFMaW5lcy5wdXNoKGxpbmUuc2xpY2UoNSkucmVwbGFjZSgvXiAvLCAnJykpOyBzYXdGaWVsZCA9IHRydWU7IH1cbiAgICB9XG4gICAgaWYgKCFzYXdGaWVsZCkgY29udGludWU7IC8vIFx1N0VBRlx1NkNFOFx1OTFDQS9cdTVGQzNcdThERjNcdTU3NTdcdTRFMERcdTRFQTdcdTc1MUZcdTVFMjdcbiAgICBmcmFtZXMucHVzaCh7IC4uLihpZCAhPT0gdW5kZWZpbmVkID8geyBpZCB9IDoge30pLCBldmVudCwgZGF0YTogZGF0YUxpbmVzLmpvaW4oJ1xcbicpIH0pO1xuICB9XG4gIHJldHVybiBmcmFtZXM7XG59XG5cbi8qKiBcdTRFQ0UgU1NFIFx1NUUyN1x1NjU3MFx1NjM2RVx1NEUyRFx1ODlFM1x1NTFGQVx1NTQwOFx1NkNENSBFdmVudEVudmVsb3BlO1x1NEUwRFx1NTQwOFx1NkNENVx1NzY4NFx1OEZENFx1NTZERSBudWxsKFNDSEVNQV9NSVNNQVRDSCBcdTc1MzFcdThDMDNcdTc1MjhcdTY1QjlcdThCQTFcdTY1NzApXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gZW52ZWxvcGVGcm9tRnJhbWUoZnJhbWU6IFNzZUZyYW1lKTogRXZlbnRFbnZlbG9wZSB8IG51bGwge1xuICBpZiAoZnJhbWUuZXZlbnQgIT09ICdobWgnKSByZXR1cm4gbnVsbDsgLy8gXHU2MjExXHU0RUVDXHU3Njg0XHU0RThCXHU0RUY2XHU0RkUxXHU1QzAxXHU3RURGXHU0RTAwXHU4RDcwIGV2ZW50OiBobWhcbiAgdHJ5IHtcbiAgICBjb25zdCBwYXJzZWQ6IHVua25vd24gPSBKU09OLnBhcnNlKGZyYW1lLmRhdGEpO1xuICAgIHJldHVybiBpc0V2ZW50RW52ZWxvcGUocGFyc2VkKSA/IHBhcnNlZCA6IG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbmV4cG9ydCBjbGFzcyBEZXNrdG9wSHR0cEVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICBjb25zdHJ1Y3RvcihwdWJsaWMgcmVhZG9ubHkgZGV0YWlsOiBEZXNrdG9wRXJyb3IpIHtcbiAgICBzdXBlcihkZXRhaWwubWVzc2FnZSk7XG4gIH1cbn1cblxuZXhwb3J0IGNsYXNzIERlc2t0b3BIb3N0Q2xpZW50IHtcbiAgY29uc3RydWN0b3IoXG4gICAgcHJpdmF0ZSByZWFkb25seSBiYXNlVXJsOiBzdHJpbmcsXG4gICAgcHJpdmF0ZSByZWFkb25seSB0b2tlbjogc3RyaW5nLFxuICApIHt9XG5cbiAgcHJpdmF0ZSBoZWFkZXJzKGV4dHJhOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge30pOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IHtcbiAgICByZXR1cm4geyAneC1obWgta2V5JzogdGhpcy50b2tlbiwgLi4uZXh0cmEgfTtcbiAgfVxuXG4gIGFzeW5jIGdldEpzb248VD4ocGF0aDogc3RyaW5nLCB0aW1lb3V0TXMgPSA1XzAwMCk6IFByb21pc2U8VD4ge1xuICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgIHRyeSB7XG4gICAgICByZXMgPSBhd2FpdCBmZXRjaChgJHt0aGlzLmJhc2VVcmx9JHtwYXRofWAsIHsgaGVhZGVyczogdGhpcy5oZWFkZXJzKCksIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCh0aW1lb3V0TXMpIH0pO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGByZXF1ZXN0IGZhaWxlZDogJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxNjApfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy5wYXJzZVJlc3BvbnNlPFQ+KHJlcyk7XG4gIH1cblxuICAvKiogXHU2MkM5XHU1M0Q2XHU3RUFGXHU2NTg3XHU2NzJDXHU3QUVGXHU3MEI5KFx1NTk4MiAvYXBpL3Nlc3Npb25zLzppZC9leHBvcnQubWQpXHUzMDAyICovXG4gIGFzeW5jIGdldFRleHQocGF0aDogc3RyaW5nLCB0aW1lb3V0TXMgPSAxMF8wMDApOiBQcm9taXNlPHN0cmluZz4ge1xuICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgIHRyeSB7XG4gICAgICByZXMgPSBhd2FpdCBmZXRjaChgJHt0aGlzLmJhc2VVcmx9JHtwYXRofWAsIHsgaGVhZGVyczogdGhpcy5oZWFkZXJzKCksIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCh0aW1lb3V0TXMpIH0pO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGByZXF1ZXN0IGZhaWxlZDogJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxNjApfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICBpZiAocmVzLnN0YXR1cyA9PT0gNDAxIHx8IHJlcy5zdGF0dXMgPT09IDQwMykge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdBVVRIX0ZBSUxFRCcsIGBob3N0IHJlamVjdGVkIHRoZSBzZXNzaW9uIHRva2VuIChIVFRQICR7cmVzLnN0YXR1c30pYCwgeyByZXRyeWFibGU6IGZhbHNlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICBpZiAoIXJlcy5vaykge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBIVFRQICR7cmVzLnN0YXR1c31gLCB7IHJldHJ5YWJsZTogcmVzLnN0YXR1cyA+PSA1MDAgfSkpO1xuICAgIH1cbiAgICByZXR1cm4gcmVzLnRleHQoKTtcbiAgfVxuXG4gIC8qKiBcdTZCQ0ZcdTRFMkFcdTVFMjZcdTUyNkZcdTRGNUNcdTc1MjhcdTc2ODQgUE9TVCBcdTgxRUFcdTUyQThcdTY0M0FcdTVFMjZcdTVFNDJcdTdCNDlcdTk1MkUoMDMgXHUwMEE3XHU1NkRCXHU5NjMyXHU5MUNEXHU2NTNFOlx1OEJGN1x1NkM0Mlx1NEY3Rlx1NzUyOCBpZGVtcG90ZW5jeUtleTtcbiAgICogIHJ1bnRpbWUgXHU0RkE3XHU3N0VEXHU2NzFGXHU1MTdDXHU1QkI5XHU1RkZEXHU3NTY1LFx1NTM0Rlx1OEJBRVx1NTE0OFx1ODg0Q1x1MjAxNFx1MjAxNFx1OTFDRFx1OEJENVx1NTNFRlx1NTFFRFx1OTUyRVx1NTNCQlx1OTFDRCxcdTRFMERcdTc2RjJcdTc2RUVcdTkxQ0RcdTY1M0UpXHUzMDAyICovXG4gIGFzeW5jIHBvc3RKc29uPFQ+KHBhdGg6IHN0cmluZywgYm9keTogdW5rbm93biwgdGltZW91dE1zID0gMTBfMDAwKTogUHJvbWlzZTxUPiB7XG4gICAgbGV0IHJlczogUmVzcG9uc2U7XG4gICAgdHJ5IHtcbiAgICAgIHJlcyA9IGF3YWl0IGZldGNoKGAke3RoaXMuYmFzZVVybH0ke3BhdGh9YCwge1xuICAgICAgICBtZXRob2Q6ICdQT1NUJyxcbiAgICAgICAgaGVhZGVyczogdGhpcy5oZWFkZXJzKHtcbiAgICAgICAgICAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgICAgICAgICd4LWlkZW1wb3RlbmN5LWtleSc6IHJhbmRvbVVVSUQoKSxcbiAgICAgICAgfSksXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpLFxuICAgICAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQodGltZW91dE1zKSxcbiAgICAgIH0pO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGByZXF1ZXN0IGZhaWxlZDogJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxNjApfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy5wYXJzZVJlc3BvbnNlPFQ+KHJlcyk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHBhcnNlUmVzcG9uc2U8VD4ocmVzOiBSZXNwb25zZSk6IFByb21pc2U8VD4ge1xuICAgIGlmIChyZXMuc3RhdHVzID09PSA0MDEgfHwgcmVzLnN0YXR1cyA9PT0gNDAzKSB7XG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgYGhvc3QgcmVqZWN0ZWQgdGhlIHNlc3Npb24gdG9rZW4gKEhUVFAgJHtyZXMuc3RhdHVzfSlgLCB7IHJldHJ5YWJsZTogZmFsc2UsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XG4gICAgfVxuICAgIGNvbnN0IHRleHQgPSBhd2FpdCByZXMudGV4dCgpO1xuICAgIGxldCBwYXJzZWQ6IHVua25vd24gPSBudWxsO1xuICAgIHRyeSB7XG4gICAgICBwYXJzZWQgPSB0ZXh0ID8gSlNPTi5wYXJzZSh0ZXh0KSA6IG51bGw7XG4gICAgfSBjYXRjaCB7XG4gICAgICBwYXJzZWQgPSBudWxsO1xuICAgIH1cbiAgICBpZiAoIXJlcy5vaykge1xuICAgICAgaWYgKGlzRGVza3RvcEVycm9yKHBhcnNlZCkpIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKHBhcnNlZCk7XG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYEhUVFAgJHtyZXMuc3RhdHVzfTogJHt0ZXh0LnNsaWNlKDAsIDE2MCl9YCwgeyByZXRyeWFibGU6IHJlcy5zdGF0dXMgPj0gNTAwIH0pKTtcbiAgICB9XG4gICAgcmV0dXJuIHBhcnNlZCBhcyBUO1xuICB9XG5cbiAgLyoqXG4gICAqIFx1OEJBMlx1OTYwNVx1NTE2OFx1OTBFOCBTU0UgXHU1RTI3KFx1NTQyQlx1OTc1RVx1NEZFMVx1NUMwMVx1NEU4Qlx1NEVGNjpkZWx0YS9saW5lIFx1N0I0OVx1OUFEOFx1OTg5MVx1NkQ0MSlcdTMwMDJcdTRGRTFcdTVDMDFcdTc1MzFcdThDMDNcdTc1MjhcdTY1QjlcbiAgICogXHU3NTI4IGVudmVsb3BlRnJvbUZyYW1lIFx1ODFFQVx1ODg0Q1x1NTIwNlx1NkQ0MTtcdTY1QURcdTdFQkZcdTkxQ0RcdThGREVcdThCRURcdTRFNDlcdTU0MEMgZXZlbnRzKClcdTMwMDJcbiAgICovXG4gIGFzeW5jICpyYXdFdmVudHMobGFzdEV2ZW50SWQ/OiBzdHJpbmcsIHNpZ25hbD86IEFib3J0U2lnbmFsKTogQXN5bmNHZW5lcmF0b3I8U3NlRnJhbWU+IHtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgJHt0aGlzLmJhc2VVcmx9L2FwaS9ldmVudHNgLCB7XG4gICAgICBoZWFkZXJzOiB0aGlzLmhlYWRlcnMoe1xuICAgICAgICBhY2NlcHQ6ICd0ZXh0L2V2ZW50LXN0cmVhbScsXG4gICAgICAgIC4uLihsYXN0RXZlbnRJZCAhPT0gdW5kZWZpbmVkID8geyAnbGFzdC1ldmVudC1pZCc6IGxhc3RFdmVudElkIH0gOiB7fSksXG4gICAgICB9KSxcbiAgICAgIC4uLihzaWduYWwgIT09IHVuZGVmaW5lZCA/IHsgc2lnbmFsIH0gOiB7fSksXG4gICAgfSk7XG4gICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSB8fCByZXMuc3RhdHVzID09PSA0MDMpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignQVVUSF9GQUlMRUQnLCBgaG9zdCByZWplY3RlZCB0aGUgc2Vzc2lvbiB0b2tlbiAoSFRUUCAke3Jlcy5zdGF0dXN9KWAsIHsgcmV0cnlhYmxlOiBmYWxzZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcbiAgICB9XG4gICAgaWYgKCFyZXMub2sgfHwgcmVzLmJvZHkgPT09IG51bGwpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgU1NFIEhUVFAgJHtyZXMuc3RhdHVzfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICBjb25zdCByZWFkZXIgPSByZXMuYm9keS5nZXRSZWFkZXIoKTtcbiAgICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKCk7XG4gICAgbGV0IGJ1ZmZlciA9ICcnO1xuICAgIGZvciAoOzspIHtcbiAgICAgIGNvbnN0IHsgZG9uZSwgdmFsdWUgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICBpZiAoZG9uZSkgcmV0dXJuO1xuICAgICAgYnVmZmVyICs9IGRlY29kZXIuZGVjb2RlKHZhbHVlLCB7IHN0cmVhbTogdHJ1ZSB9KTtcbiAgICAgIGxldCBpZHg6IG51bWJlcjtcbiAgICAgIHdoaWxlICgoaWR4ID0gYnVmZmVyLmluZGV4T2YoJ1xcblxcbicpKSAhPT0gLTEpIHtcbiAgICAgICAgY29uc3QgYmxvY2sgPSBidWZmZXIuc2xpY2UoMCwgaWR4KTtcbiAgICAgICAgYnVmZmVyID0gYnVmZmVyLnNsaWNlKGlkeCArIDIpO1xuICAgICAgICBmb3IgKGNvbnN0IGZyYW1lIG9mIHBhcnNlU3NlQ2h1bmsoYmxvY2spKSB5aWVsZCBmcmFtZTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogXHU4QkEyXHU5NjA1IFNTRSBcdTRFOEJcdTRFRjZcdTZENDEoYXN5bmMgaXRlcmF0b3IpXHUzMDAyXHU2NUFEXHU3RUJGXHU3NTMxXHU4QzAzXHU3NTI4XHU2NUI5XHU5MUNEXHU4RkRFO1x1OTFDRFx1OEZERVx1NjVGNlx1NjI4QVx1NjcwMFx1NTQwRVxuICAgKiBcdTY1MzZcdTUyMzBcdTc2ODQgZXZlbnRJZCBcdTRGMjBcdTUxNjUgbGFzdEV2ZW50SWQsaG9zdCBcdTdBRUZcdTRFQ0VcdTkxQ0RcdTY1M0VcdTczQUZcdTg4NjVcdTUzRDFcdTMwMDJcbiAgICovXG4gIGFzeW5jICpldmVudHMobGFzdEV2ZW50SWQ/OiBzdHJpbmcsIHNpZ25hbD86IEFib3J0U2lnbmFsKTogQXN5bmNHZW5lcmF0b3I8RXZlbnRFbnZlbG9wZT4ge1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGAke3RoaXMuYmFzZVVybH0vYXBpL2V2ZW50c2AsIHtcbiAgICAgIGhlYWRlcnM6IHRoaXMuaGVhZGVycyh7XG4gICAgICAgIGFjY2VwdDogJ3RleHQvZXZlbnQtc3RyZWFtJyxcbiAgICAgICAgLi4uKGxhc3RFdmVudElkICE9PSB1bmRlZmluZWQgPyB7ICdsYXN0LWV2ZW50LWlkJzogbGFzdEV2ZW50SWQgfSA6IHt9KSxcbiAgICAgIH0pLFxuICAgICAgLi4uKHNpZ25hbCAhPT0gdW5kZWZpbmVkID8geyBzaWduYWwgfSA6IHt9KSxcbiAgICB9KTtcbiAgICBpZiAocmVzLnN0YXR1cyA9PT0gNDAxIHx8IHJlcy5zdGF0dXMgPT09IDQwMykge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdBVVRIX0ZBSUxFRCcsIGBob3N0IHJlamVjdGVkIHRoZSBzZXNzaW9uIHRva2VuIChIVFRQICR7cmVzLnN0YXR1c30pYCwgeyByZXRyeWFibGU6IGZhbHNlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICBpZiAoIXJlcy5vayB8fCAhcmVzLmJvZHkpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgU1NFIEhUVFAgJHtyZXMuc3RhdHVzfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICBjb25zdCByZWFkZXIgPSByZXMuYm9keS5nZXRSZWFkZXIoKTtcbiAgICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKCk7XG4gICAgbGV0IGJ1ZmZlciA9ICcnO1xuICAgIGZvciAoOzspIHtcbiAgICAgIGNvbnN0IHsgZG9uZSwgdmFsdWUgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICBpZiAoZG9uZSkgcmV0dXJuO1xuICAgICAgYnVmZmVyICs9IGRlY29kZXIuZGVjb2RlKHZhbHVlLCB7IHN0cmVhbTogdHJ1ZSB9KTtcbiAgICAgIC8vIFx1NEVFNVx1N0E3QVx1ODg0Q1x1NTIwNlx1NUUyNztcdTRGRERcdTc1NTlcdTRFMERcdTVCOENcdTY1NzRcdTc2ODRcdTVDM0VcdTkwRThcbiAgICAgIGxldCBpZHg6IG51bWJlcjtcbiAgICAgIHdoaWxlICgoaWR4ID0gYnVmZmVyLmluZGV4T2YoJ1xcblxcbicpKSAhPT0gLTEpIHtcbiAgICAgICAgY29uc3QgYmxvY2sgPSBidWZmZXIuc2xpY2UoMCwgaWR4KTtcbiAgICAgICAgYnVmZmVyID0gYnVmZmVyLnNsaWNlKGlkeCArIDIpO1xuICAgICAgICBmb3IgKGNvbnN0IGZyYW1lIG9mIHBhcnNlU3NlQ2h1bmsoYmxvY2spKSB7XG4gICAgICAgICAgY29uc3QgZW52ID0gZW52ZWxvcGVGcm9tRnJhbWUoZnJhbWUpO1xuICAgICAgICAgIGlmIChlbnYgIT09IG51bGwpIHlpZWxkIGVudjtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxufVxuIiwgIi8qKlxuICogZmFrZSBob3N0IFx1MjAxNCBobWhhcm5lc3MgcnVudGltZSBcdTc2ODRcdTZENEJcdThCRDVcdTY2RkZcdThFQUIoTWFzdGVyUHJvbXB0IFx1OTYzNlx1NkJCNSBEL0U6XG4gKiBcIlx1NTE0OFx1NEY3Rlx1NzUyOCBmYWtlIGhvc3QgXHU3RjE2XHU1MTk5XHU3MkI2XHU2MDAxXHU2NzNBXHU2RDRCXHU4QkQ1LFx1NTE4RFx1NjNBNVx1NzcxRlx1NUI5RSBBUElcIjtcdTk2MzZcdTZCQjUgRSBcdTc2ODRcdTRGMUFcdThCRERcdTdFQjVcdTUyMDdcdTcyNDdcbiAqIGUyZSBcdTRFNUZcdTUxNDhcdTU3MjggZmFrZSBcdTVDNDJcdTk1RURcdTczQUYpXHUzMDAyXG4gKlxuICogXHU2ODRDXHU5NzYyIGhvc3QgXHU1NDA4XHU1NDBDOlxuICogIC0gXHU1M0VBXHU3RUQxIDEyNy4wLjAuMSxcdTdBRUZcdTUzRTMgT1MgXHU1MjA2XHU5MTRELFx1NUI5RVx1OTY0NVx1N0FFRlx1NTNFM1x1NTE5OSBzdGRvdXQgXHU1RjE1XHU1QkZDXHU4ODRDO1xuICogIC0gXHU2MjQwXHU2NzA5IC9hcGkvKiBcdTg5ODFcdTZDNDIgWC1IbWgtS2V5ID09PSBITUhfREVTS1RPUF9UT0tFTixcdTU0MjZcdTUyMTkgNDAxICsgRGVza3RvcEVycm9yO1xuICogIC0gR0VUIC9hcGkvc3RhdGUgXHU1MDY1XHU1RUI3XHU2M0EyXHU2RDRCO0dFVCAvYXBpL2V2ZW50cyBTU0UoZXZlbnQ6IGhtaCBcdTRGRTFcdTVDMDFcdTZENDEgKyBcdTkxQ0RcdTY1M0VcdTczQUYpO1xuICogIC0gUE9TVCAvYXBpL2Rlc2t0b3Avc2h1dGRvd24gXHU0RjE4XHU5NkM1XHU5MDAwXHU1MUZBXHUzMDAyXG4gKlxuICogXHU5NjM2XHU2QkI1IEUgXHU2QTIxXHU2MkRGXHU5NzYyKFx1NEUwRSBobWhhcm5lc3MgZGVza3RvcCBcdTZBMjFcdTVGMEZcdTU0MENcdTVGNjIpOlxuICogIC0gUE9TVCAvYXBpL3Rhc2sge3RleHQsIHNlc3Npb25JZCwgbW9kZX06XHU2MzkyXHU5NjFGXHU1RTc2XHU2MzA5XHU4MTFBXHU2NzJDXHU1M0QxXG4gKiAgICBydW4uc3RhcnRlZCBcdTIxOTIgdG9vbC5zdGFydGVkL2NvbXBsZXRlZCBcdTIxOTIobW9kZT09PSdhc2snIFx1NjVGNilcbiAqICAgIGFwcHJvdmFsLnJlcXVpcmVkKFx1N0I0OSAvYXBpL2FwcHJvdmUpXHUyMTkyIHJ1bi5jb21wbGV0ZWQ7XG4gKiAgLSBQT1NUIC9hcGkvYXBwcm92ZSB7Z3JhbnRlZCwgc2Vzc2lvbklkfTtcbiAqICAtIFBPU1QgL2FwaS9pbnRlcnJ1cHQge3Nlc3Npb25JZH07XG4gKiAgLSBHRVQgL2FwaS9zZXNzaW9uc1x1MzAwMlxuICpcbiAqIFx1NkQ0Qlx1OEJENVx1OTRBOVx1NUI1MDpGQUtFX0hPU1RfRElFX0FGVEVSX01TIC8gRkFLRV9IT1NUX0RJRV9BVF9CT09UIC9cbiAqIEZBS0VfSE9TVF9FWFBFQ1RfVE9LRU4gLyBGQUtFX0hPU1RfVEFTS19ERUxBWV9NUyAvIEZBS0VfSE9TVF9UQVNLX0ZBSUw9MVxuICogKFx1NEVGQlx1NTJBMVx1NEVFNSBydW4uZmFpbGVkIFx1N0VEM1x1Njc1RixcdTY3ODRcdTkwMjBcdTk1MTlcdThCRUZcdTYwNjJcdTU5MERcdTU3M0FcdTY2NkYpXHUzMDAyXG4gKi9cbmltcG9ydCB7IGNyZWF0ZVNlcnZlciwgdHlwZSBTZXJ2ZXJSZXNwb25zZSB9IGZyb20gJ25vZGU6aHR0cCc7XG5pbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSAnbm9kZTpjcnlwdG8nO1xuaW1wb3J0IHsgcGF0aFRvRmlsZVVSTCB9IGZyb20gJ25vZGU6dXJsJztcbmltcG9ydCB7IHJlYWxwYXRoU3luYyB9IGZyb20gJ25vZGU6ZnMnO1xuaW1wb3J0IHsgRVZFTlRfU0NIRU1BX1ZFUlNJT04sIGRlc2t0b3BFcnJvciwgdHlwZSBFdmVudEVudmVsb3BlLCB0eXBlIEV2ZW50S2luZCB9IGZyb20gJ0BobWgtZGVza3RvcC9jb250cmFjdHMnO1xuXG5leHBvcnQgaW50ZXJmYWNlIEZha2VIb3N0SGFuZGxlIHtcbiAgcG9ydDogbnVtYmVyO1xuICBlbWl0KHNlc3Npb25JZDogc3RyaW5nLCBydW5JZDogc3RyaW5nLCBraW5kOiBFdmVudEtpbmQsIHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogbnVtYmVyO1xuICBjbG9zZSgpOiBQcm9taXNlPHZvaWQ+O1xufVxuXG5pbnRlcmZhY2UgRmFrZVNlc3Npb24ge1xuICBpZDogc3RyaW5nO1xuICBjcmVhdGVkQXQ6IHN0cmluZztcbiAgdXBkYXRlZEF0OiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBQZW5kaW5nQXBwcm92YWwge1xuICBzZXNzaW9uSWQ6IHN0cmluZztcbiAgYXBwcm92YWxJZDogc3RyaW5nO1xuICByZXNvbHZlKGdyYW50ZWQ6IGJvb2xlYW4pOiB2b2lkO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc3RhcnRGYWtlSG9zdChvcHRzOiB7IHRva2VuOiBzdHJpbmc7IHF1aWV0PzogYm9vbGVhbiB9KTogUHJvbWlzZTxGYWtlSG9zdEhhbmRsZT4ge1xuICBjb25zdCB0b2tlbiA9IG9wdHMudG9rZW47XG4gIC8vIFx1NkQ0Qlx1OEJENVx1OTRBOVx1NUI1MDpGQUtFX0hPU1RfRVhQRUNUX1RPS0VOIFx1OEJBOSBob3N0IFx1NjgyMVx1OUE4Q1x1NEUwMFx1NEUyQVx1NEUwRSBITUhfREVTS1RPUF9UT0tFTlxuICAvLyBcdTRFMERcdTU0MENcdTc2ODRcdTUwM0MoXHU2Nzg0XHU5MDIwIEFVVEhfRkFJTEVEIFx1NTczQVx1NjY2RjtzdXBlcnZpc29yIFx1NjAzQlx1NjYyRlx1ODk4Nlx1NzZENiBITUhfREVTS1RPUF9UT0tFTilcbiAgY29uc3QgZXhwZWN0ZWQgPSBwcm9jZXNzLmVudi5GQUtFX0hPU1RfRVhQRUNUX1RPS0VOID8/IHRva2VuO1xuICBjb25zdCB0YXNrRGVsYXkgPSBOdW1iZXIocHJvY2Vzcy5lbnYuRkFLRV9IT1NUX1RBU0tfREVMQVlfTVMgPz8gMzApO1xuICBjb25zdCBmYWlsVGFza3MgPSBwcm9jZXNzLmVudi5GQUtFX0hPU1RfVEFTS19GQUlMID09PSAnMSc7XG5cbiAgY29uc3Qgc3NlQ2xpZW50cyA9IG5ldyBTZXQ8U2VydmVyUmVzcG9uc2U+KCk7XG4gIGNvbnN0IHNlcUJ5UnVuID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgLy8gXHU5MUNEXHU2NTNFXHU3M0FGOlx1NjcwMFx1OEZEMSAyMDAgXHU1RTI3KExhc3QtRXZlbnQtSUQgXHU2NUFEXHU3RUJGXHU4ODY1XHU2MkM5KSxcdTRFMEUgaG1oYXJuZXNzIHdlYiBcdTU0MENcdTZCM0VcdThCRURcdTRFNDlcbiAgY29uc3QgcmluZzogQXJyYXk8eyBpZDogbnVtYmVyOyBldmVudDogc3RyaW5nOyBkYXRhOiB1bmtub3duIH0+ID0gW107XG4gIGxldCByaW5nU2VxID0gMDtcbiAgY29uc3Qgc2Vzc2lvbnMgPSBuZXcgTWFwPHN0cmluZywgRmFrZVNlc3Npb24+KCk7XG4gIGxldCBwZW5kaW5nOiBQZW5kaW5nQXBwcm92YWwgfCBudWxsID0gbnVsbDtcbiAgY29uc3QgcnVuVGltZXJzID0gbmV3IE1hcDxzdHJpbmcsIE5vZGVKUy5UaW1lb3V0PigpO1xuICAvLyBcdTVERTVcdTRGNUNcdTUzM0EvUHJvdmlkZXIgXHU3MkI2XHU2MDAxKFx1NEUwRSBobWhhcm5lc3MgXHU1NDBDXHU1RjYyXHU3Njg0XHU2NzAwXHU1QzBGXHU2QTIxXHU2MkRGKVxuICBjb25zdCBmYWtlV29ya3NwYWNlcyA9IHtcbiAgICBjdXJyZW50OiAnd3MtZGVtbycsXG4gICAgaXRlbXM6IFtcbiAgICAgIHsgaWQ6ICd3cy1kZW1vJywgbmFtZTogJ2RlbW8td29ya3NwYWNlJywgcGF0aDogJ0M6XFxcXGRlbW8nIH0sXG4gICAgXSxcbiAgfTtcbiAgY29uc3QgZmFrZVByb3ZpZGVycyA9IG5ldyBNYXA8c3RyaW5nLCB7IGJhc2VVcmw6IHN0cmluZzsgbW9kZWw6IHN0cmluZzsgYXBpS2V5OiBzdHJpbmcgfT4oW1xuICAgIFsnZGVtbycsIHsgYmFzZVVybDogJ2h0dHA6Ly8xMjcuMC4wLjE6OS92MScsIG1vZGVsOiAnZmFrZS1tJywgYXBpS2V5OiAnc2stZGVtby0xMjM0JyB9XSxcbiAgXSk7XG5cbiAgY29uc3QgZW1pdCA9IChzZXNzaW9uSWQ6IHN0cmluZywgcnVuSWQ6IHN0cmluZywga2luZDogRXZlbnRLaW5kLCBwYXlsb2FkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IG51bWJlciA9PiB7XG4gICAgY29uc3Qga2V5ID0gYCR7c2Vzc2lvbklkfVxcMCR7cnVuSWR9YDtcbiAgICBjb25zdCBzZXEgPSAoc2VxQnlSdW4uZ2V0KGtleSkgPz8gMCkgKyAxO1xuICAgIHNlcUJ5UnVuLnNldChrZXksIHNlcSk7XG4gICAgY29uc3QgZW52OiBFdmVudEVudmVsb3BlID0ge1xuICAgICAgc2NoZW1hVmVyc2lvbjogRVZFTlRfU0NIRU1BX1ZFUlNJT04sXG4gICAgICBldmVudElkOiByYW5kb21VVUlEKCksXG4gICAgICBzZXNzaW9uSWQsXG4gICAgICBydW5JZCxcbiAgICAgIHNlcSxcbiAgICAgIG9jY3VycmVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgIGtpbmQsXG4gICAgICBwYXlsb2FkLFxuICAgIH07XG4gICAgY29uc3QgaWQgPSArK3JpbmdTZXE7XG4gICAgcmluZy5wdXNoKHsgaWQsIGV2ZW50OiAnaG1oJywgZGF0YTogZW52IH0pO1xuICAgIGlmIChyaW5nLmxlbmd0aCA+IDIwMCkgcmluZy5zcGxpY2UoMCwgcmluZy5sZW5ndGggLSAyMDApO1xuICAgIGZvciAoY29uc3QgYyBvZiBzc2VDbGllbnRzKSB7XG4gICAgICBjLndyaXRlKGBpZDogJHtpZH1cXG5ldmVudDogaG1oXFxuZGF0YTogJHtKU09OLnN0cmluZ2lmeShlbnYpfVxcblxcbmApO1xuICAgIH1cbiAgICByZXR1cm4gc2VxO1xuICB9O1xuXG4gIGNvbnN0IHRvdWNoID0gKHNlc3Npb25JZDogc3RyaW5nKTogRmFrZVNlc3Npb24gPT4ge1xuICAgIGxldCBzID0gc2Vzc2lvbnMuZ2V0KHNlc3Npb25JZCk7XG4gICAgaWYgKHMgPT09IHVuZGVmaW5lZCkge1xuICAgICAgcyA9IHsgaWQ6IHNlc3Npb25JZCwgY3JlYXRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksIHVwZGF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpIH07XG4gICAgICBzZXNzaW9ucy5zZXQoc2Vzc2lvbklkLCBzKTtcbiAgICB9XG4gICAgcy51cGRhdGVkQXQgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XG4gICAgcmV0dXJuIHM7XG4gIH07XG5cbiAgLyoqIFx1NkEyMVx1NjJERlx1NEUwMFx1NkIyMVx1NEVGQlx1NTJBMTpcdTYyNzlcdTUxQzZcdTZBMjFcdTVGMEZcdTYzMDJcdThENzdcdTdCNDlcdTVGODUgL2FwaS9hcHByb3ZlXHUzMDAyICovXG4gIGNvbnN0IHJ1blRhc2sgPSAoc2Vzc2lvbklkOiBzdHJpbmcsIHRleHQ6IHN0cmluZywgbW9kZTogc3RyaW5nKTogc3RyaW5nID0+IHtcbiAgICBjb25zdCBydW5JZCA9IGBydW4tJHtEYXRlLm5vdygpLnRvU3RyaW5nKDM2KX0tJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCA4KX1gO1xuICAgIHRvdWNoKHNlc3Npb25JZCk7XG4gICAgY29uc3Qgc3RlcHM6IEFycmF5PCgpID0+IHZvaWQ+ID0gW107XG4gICAgY29uc3Qgd2FpdCA9IChmbjogKCkgPT4gdm9pZCwgbXMgPSB0YXNrRGVsYXkpOiB2b2lkID0+IHtcbiAgICAgIGNvbnN0IHQgPSBzZXRUaW1lb3V0KGZuLCBtcyk7XG4gICAgICBydW5UaW1lcnMuc2V0KGAke3Nlc3Npb25JZH1cXDAke3J1bklkfWAsIHQpO1xuICAgIH07XG4gICAgY29uc3QgY2hhaW4gPSAoZm5zOiBBcnJheTwoKSA9PiB2b2lkPik6IHZvaWQgPT4ge1xuICAgICAgY29uc3QgW2ZpcnN0LCAuLi5yZXN0XSA9IGZucztcbiAgICAgIGlmIChmaXJzdCA9PT0gdW5kZWZpbmVkKSByZXR1cm47XG4gICAgICB3YWl0KCgpID0+IHtcbiAgICAgICAgZmlyc3QoKTtcbiAgICAgICAgY2hhaW4ocmVzdCk7XG4gICAgICB9KTtcbiAgICB9O1xuXG4gICAgZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAncnVuLnN0YXJ0ZWQnLCB7IHRhc2s6IHRleHQsIG1vZGUgfSk7XG4gICAgaWYgKGZhaWxUYXNrcykge1xuICAgICAgd2FpdCgoKSA9PiBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICdydW4uZmFpbGVkJywge1xuICAgICAgICBlcnJvcjogeyBjb2RlOiAnQVVUSF9GQUlMRUQnLCBtZXNzYWdlOiAnc2ltdWxhdGVkIHByb3ZpZGVyIGF1dGggZmFpbHVyZScsIHJldHJ5YWJsZTogZmFsc2UgfSxcbiAgICAgIH0pKTtcbiAgICAgIHJldHVybiBydW5JZDtcbiAgICB9XG5cbiAgICBjb25zdCBmaW5pc2hSdW4gPSAoYW5zd2VyOiBzdHJpbmcsIHRvb2xVc2VzOiBudW1iZXIpOiB2b2lkID0+IHtcbiAgICAgIHJ1blRpbWVycy5kZWxldGUoYCR7c2Vzc2lvbklkfVxcMCR7cnVuSWR9YCk7XG4gICAgICAvLyBcdTRFQTRcdTRFRDhcdTcyNjlcdTUxNDhcdTRFOEVcdTdFQzhcdTYwMDEoXHU0RTBFIGhtaGFybmVzcyBkZXNrdG9wIFx1Njg2NVx1NTQwQ1x1NUU4RjphcnRpZmFjdC5jcmVhdGVkIFx1MjE5MiBydW4uY29tcGxldGVkKVxuICAgICAgZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAnYXJ0aWZhY3QuY3JlYXRlZCcsIHtcbiAgICAgICAgYXJ0aWZhY3Q6IHsgcmVsUGF0aDogJ291dC50eHQnLCBraW5kOiAnZmlsZScsIHRpdGxlOiAnb3V0LnR4dCcgfSxcbiAgICAgIH0pO1xuICAgICAgZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAncnVuLmNvbXBsZXRlZCcsIHsgdGV4dDogYW5zd2VyLCB0dXJuczogMSwgdG9vbFVzZXMgfSk7XG4gICAgfTtcblxuICAgIGNvbnN0IHNjcmlwdGVkOiBBcnJheTwoKSA9PiB2b2lkPiA9IFtcbiAgICAgICgpID0+IGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ3Rvb2wuc3RhcnRlZCcsIHsgbmFtZTogJ3JlYWRfZmlsZScsIGFyZ3NQcmV2aWV3OiAne1wicGF0aFwiOlwiUkVBRE1FLm1kXCJ9JyB9KSxcbiAgICAgICgpID0+IGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ3Rvb2wuY29tcGxldGVkJywgeyBuYW1lOiAncmVhZF9maWxlJywgaXNFcnJvcjogZmFsc2UsIG91dHB1dFByZXZpZXc6ICcjIGRlbW8nIH0pLFxuICAgIF07XG5cbiAgICBpZiAobW9kZSA9PT0gJ2FzaycpIHtcbiAgICAgIHNjcmlwdGVkLnB1c2goKCkgPT4ge1xuICAgICAgICBjb25zdCBhcHByb3ZhbElkID0gYGFwLSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMiwgOCl9YDtcbiAgICAgICAgZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAnYXBwcm92YWwucmVxdWlyZWQnLCB7XG4gICAgICAgICAgYXBwcm92YWxJZCxcbiAgICAgICAgICB0b29sOiAnd3JpdGVfZmlsZScsXG4gICAgICAgICAgYXJnc1ByZXZpZXc6ICd7XCJwYXRoXCI6XCJvdXQudHh0XCIsXCJjb250ZW50XCI6XCJoaVwifScsXG4gICAgICAgICAgcmlzazogJ1x1NTE5OVx1NTE2NVx1NURFNVx1NEY1Q1x1NTMzQVx1NjU4N1x1NEVGNiBvdXQudHh0KFx1NkEyMVx1NjJERiknLFxuICAgICAgICB9KTtcbiAgICAgICAgcGVuZGluZyA9IHtcbiAgICAgICAgICBzZXNzaW9uSWQsXG4gICAgICAgICAgYXBwcm92YWxJZCxcbiAgICAgICAgICByZXNvbHZlOiAoZ3JhbnRlZCkgPT4ge1xuICAgICAgICAgICAgcGVuZGluZyA9IG51bGw7XG4gICAgICAgICAgICBpZiAoZ3JhbnRlZCkge1xuICAgICAgICAgICAgICBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICd0b29sLnN0YXJ0ZWQnLCB7IG5hbWU6ICd3cml0ZV9maWxlJywgYXJnc1ByZXZpZXc6ICd7XCJwYXRoXCI6XCJvdXQudHh0XCJ9JyB9KTtcbiAgICAgICAgICAgICAgd2FpdCgoKSA9PiBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICd0b29sLmNvbXBsZXRlZCcsIHsgbmFtZTogJ3dyaXRlX2ZpbGUnLCBpc0Vycm9yOiBmYWxzZSwgb3V0cHV0UHJldmlldzogJ3dyb3RlIDIgYnl0ZXMnIH0pKTtcbiAgICAgICAgICAgICAgd2FpdCgoKSA9PiBmaW5pc2hSdW4oYGVjaG86ICR7dGV4dH0oXHU1REYyXHU2MjY3XHU4ODRDXHU1MTk5XHU1MTY1KWAsIDMpLCB0YXNrRGVsYXkgKiAyKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIGZpbmlzaFJ1bihgZWNobzogJHt0ZXh0fShcdTVCQTFcdTYyNzlcdTg4QUJcdTYyRDJcdTdFREQsXHU2NzJBXHU2MjY3XHU4ODRDXHU1MTk5XHU1MTY1KWAsIDEpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0sXG4gICAgICAgIH07XG4gICAgICB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgc2NyaXB0ZWQucHVzaCgoKSA9PiBmaW5pc2hSdW4oYGVjaG86ICR7dGV4dH1gLCAxKSk7XG4gICAgfVxuICAgIGNoYWluKHNjcmlwdGVkKTtcbiAgICByZXR1cm4gcnVuSWQ7XG4gIH07XG5cbiAgY29uc3Qgc2VydmVyID0gY3JlYXRlU2VydmVyKChyZXEsIHJlcykgPT4ge1xuICAgIGNvbnN0IHVybCA9IG5ldyBVUkwocmVxLnVybCA/PyAnLycsICdodHRwOi8vMTI3LjAuMC4xJyk7XG4gICAgY29uc3QgYXV0aG9yaXplZCA9IHJlcS5oZWFkZXJzWyd4LWhtaC1rZXknXSA9PT0gZXhwZWN0ZWQ7XG4gICAgY29uc3QgZGVueSA9ICgpOiB2b2lkID0+IHtcbiAgICAgIHJlcy53cml0ZUhlYWQoNDAxLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignQVVUSF9GQUlMRUQnLCAnbWlzc2luZyBvciBpbnZhbGlkIHgtaG1oLWtleScsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgIH07XG5cbiAgICBjb25zdCByZWFkQm9keSA9ICgpOiBQcm9taXNlPHN0cmluZz4gPT5cbiAgICAgIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG4gICAgICAgIGxldCBiID0gJyc7XG4gICAgICAgIHJlcS5vbignZGF0YScsIChjOiBCdWZmZXIpID0+IHsgYiArPSBjLnRvU3RyaW5nKCk7IH0pO1xuICAgICAgICByZXEub24oJ2VuZCcsICgpID0+IHJlc29sdmUoYikpO1xuICAgICAgfSk7XG5cbiAgICBpZiAodXJsLnBhdGhuYW1lID09PSAnL2FwaS9ldmVudHMnKSB7XG4gICAgICBpZiAoIWF1dGhvcml6ZWQpIHsgZGVueSgpOyByZXR1cm47IH1cbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAndGV4dC9ldmVudC1zdHJlYW0nLCAnY2FjaGUtY29udHJvbCc6ICduby1jYWNoZScsIGNvbm5lY3Rpb246ICdrZWVwLWFsaXZlJyB9KTtcbiAgICAgIHJlcy5mbHVzaEhlYWRlcnM/LigpO1xuICAgICAgc3NlQ2xpZW50cy5hZGQocmVzKTtcbiAgICAgIC8vIFx1NjVBRFx1N0VCRlx1ODg2NVx1NjJDOTpMYXN0LUV2ZW50LUlEIFx1NEU0Qlx1NTI0RFx1NzY4NFx1NUUyN1x1NURGMlx1NTcyOFx1NUJBMlx1NjIzN1x1N0FFRixcdTkxQ0RcdTUzRDFcdTUxNzZcdTU0MEVcdTc2ODRcdTczQUZcdTVGNjJcdTdGMTNcdTUxQjJcbiAgICAgIGNvbnN0IGxhc3RJZCA9IE51bWJlcihyZXEuaGVhZGVyc1snbGFzdC1ldmVudC1pZCddID8/IDApO1xuICAgICAgaWYgKE51bWJlci5pc0Zpbml0ZShsYXN0SWQpICYmIGxhc3RJZCA+IDApIHtcbiAgICAgICAgZm9yIChjb25zdCBlIG9mIHJpbmcpIHtcbiAgICAgICAgICBpZiAoZS5pZCA+IGxhc3RJZCkgcmVzLndyaXRlKGBpZDogJHtlLmlkfVxcbmV2ZW50OiAke2UuZXZlbnR9XFxuZGF0YTogJHtKU09OLnN0cmluZ2lmeShlLmRhdGEpfVxcblxcbmApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICByZXEub24oJ2Nsb3NlJywgKCkgPT4gc3NlQ2xpZW50cy5kZWxldGUocmVzKSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICghYXV0aG9yaXplZCkgeyBkZW55KCk7IHJldHVybjsgfVxuXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvc3RhdGUnKSB7XG4gICAgICAvLyBwcm92aWRlcnNEZXRhaWw6XHU0RTBFIGhtaGFybmVzcyBcdTU0MENcdTVGNjJcdTIwMTRcdTIwMTRrZXkgXHU1M0VBXHU1MUZBIGhhc0tleS9cdTY3MkJcdTU2REJcdTRGNEQsXHU2QzM4XHU0RTBEXHU2NjBFXHU2NTg3XG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIGRhZW1vblZlcnNpb246ICdmYWtlLTAuMC4wJywgZGVza3RvcDogdHJ1ZSwgbW9kZWw6ICdmYWtlLW1vZGVsJywgbG9jYWxlOiAnemgnLFxuICAgICAgICBidXN5U2Vzc2lvbnM6IFsuLi5zZXNzaW9ucy5rZXlzKCldLnNsaWNlKDAsIDIpLFxuICAgICAgICBhcHByb3ZhbFBlbmRpbmc6IHBlbmRpbmcgIT09IG51bGwsXG4gICAgICAgIHNldHRpbmdzOiB7IGFwcHJvdmFsOiAnYXNrJyB9LFxuICAgICAgICB3b3Jrc3BhY2U6IGZha2VXb3Jrc3BhY2VzLml0ZW1zLmZpbmQoKHcpID0+IHcuaWQgPT09IGZha2VXb3Jrc3BhY2VzLmN1cnJlbnQpID8/IG51bGwsXG4gICAgICAgIHByb3ZpZGVyc0RldGFpbDogWy4uLmZha2VQcm92aWRlcnMuZW50cmllcygpXS5tYXAoKFtuYW1lLCBwXSkgPT4gKHtcbiAgICAgICAgICBuYW1lLCBtb2RlbDogcC5tb2RlbCwgYmFzZVVybDogcC5iYXNlVXJsLFxuICAgICAgICAgIGhhc0tleTogcC5hcGlLZXkgIT09ICcnLFxuICAgICAgICAgIGtleVRhaWw6IHAuYXBpS2V5Lmxlbmd0aCA+PSA0ID8gcC5hcGlLZXkuc2xpY2UoLTQpIDogdW5kZWZpbmVkLFxuICAgICAgICAgIHB1cnBvc2VzOiBbJ2NoYXQnXSxcbiAgICAgICAgfSkpLFxuICAgICAgfSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZGVza3RvcC9zaHV0ZG93bicpIHtcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUgfSkpO1xuICAgICAgc2VydmVyLmNsb3NlKCgpID0+IHByb2Nlc3MuZXhpdCgwKSk7XG4gICAgICBzZXRUaW1lb3V0KCgpID0+IHByb2Nlc3MuZXhpdCgwKSwgMV8wMDApLnVucmVmKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9mYWtlL2RpZScpIHtcbiAgICAgIC8vIFx1NkQ0Qlx1OEJENVx1OTRBOVx1NUI1MDpcdTZBMjFcdTYyREYgaG9zdCBcdTVEMjlcdTZFODMoXHU1MTQ4XHU1RTk0XHU3QjU0XHU1MThEXHU5MDAwXHU1MUZBLFx1NEZERFx1OEJDMVx1NTRDRFx1NUU5NFx1NURGMlx1NTNEMVx1NTFGQSlcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUgfSkpO1xuICAgICAgc2V0VGltZW91dCgoKSA9PiBwcm9jZXNzLmV4aXQoMSksIDUwKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3Rhc2snKSB7XG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoKGF3YWl0IHJlYWRCb2R5KCkpIHx8ICd7fScpIGFzIHsgdGV4dD86IHVua25vd247IHNlc3Npb25JZD86IHVua25vd247IG1vZGU/OiB1bmtub3duOyBhdHRhY2htZW50cz86IHVua25vd24gfTtcbiAgICAgICAgICBjb25zdCB0ZXh0ID0gdHlwZW9mIGJvZHkudGV4dCA9PT0gJ3N0cmluZycgPyBib2R5LnRleHQgOiAnJztcbiAgICAgICAgICBjb25zdCBzZXNzaW9uSWQgPSB0eXBlb2YgYm9keS5zZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gYm9keS5zZXNzaW9uSWQgOiBgd2ViLSR7RGF0ZS5ub3coKS50b1N0cmluZygzNil9YDtcbiAgICAgICAgICBjb25zdCBtb2RlID0gYm9keS5tb2RlID09PSAnYXNrJyB8fCBib2R5Lm1vZGUgPT09ICdhdXRvJyB8fCBib2R5Lm1vZGUgPT09ICd5b2xvJyA/IGJvZHkubW9kZSA6ICdhc2snO1xuICAgICAgICAgIGNvbnN0IGF0dGFjaG1lbnRzID0gQXJyYXkuaXNBcnJheShib2R5LmF0dGFjaG1lbnRzKSA/IGJvZHkuYXR0YWNobWVudHMuZmlsdGVyKChhKTogYSBpcyBzdHJpbmcgPT4gdHlwZW9mIGEgPT09ICdzdHJpbmcnKSA6IFtdO1xuICAgICAgICAgIGlmICghdGV4dCkge1xuICAgICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAndGV4dCByZXF1aXJlZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgICAvLyBcdTRFMEUgaG1oYXJuZXNzIFx1NTQwQ1x1OEJFRFx1NEU0OTpcdTU0MDhcdTZDRDVcdTk2NDRcdTRFRjZcdTRFRTUgW3JlZmVyZW5jZWQgZmlsZXNdIFx1NTI0RFx1N0YwMFx1NUU3Nlx1NTE2NVx1NEVGQlx1NTJBMVx1NjU4N1x1NjcyQ1xuICAgICAgICAgIGNvbnN0IGNvbXBvc2VkID0gYXR0YWNobWVudHMubGVuZ3RoID4gMCA/IGBbcmVmZXJlbmNlZCBmaWxlc11cXG4ke2F0dGFjaG1lbnRzLm1hcCgoYSkgPT4gYC0gJHthLnNwbGl0KC9bXFxcXC9dLykucG9wKCl9YCkuam9pbignXFxuJyl9XFxuXFxuJHt0ZXh0fWAgOiB0ZXh0O1xuICAgICAgICAgIGNvbnN0IHJ1bklkID0gcnVuVGFzayhzZXNzaW9uSWQsIGNvbXBvc2VkLCBtb2RlKTtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgcnVuSWQgfSkpO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCBTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgfVxuICAgICAgfSkoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2FwcHJvdmUnKSB7XG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7IGdyYW50ZWQ/OiB1bmtub3duOyBzZXNzaW9uSWQ/OiB1bmtub3duIH07XG4gICAgICAgIGNvbnN0IHNpZCA9IHR5cGVvZiBib2R5LnNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBib2R5LnNlc3Npb25JZCA6ICcnO1xuICAgICAgICBpZiAocGVuZGluZyA9PT0gbnVsbCB8fCAoc2lkICE9PSAnJyAmJiBwZW5kaW5nLnNlc3Npb25JZCAhPT0gc2lkKSkge1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICdubyBhcHByb3ZhbCBwZW5kaW5nJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHAgPSBwZW5kaW5nO1xuICAgICAgICBwZW5kaW5nID0gbnVsbDtcbiAgICAgICAgcC5yZXNvbHZlKGJvZHkuZ3JhbnRlZCA9PT0gdHJ1ZSk7XG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgZ3JhbnRlZDogYm9keS5ncmFudGVkID09PSB0cnVlIH0pKTtcbiAgICAgIH0pKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lLnN0YXJ0c1dpdGgoJy9hcGkvc2Vzc2lvbnMvJykgJiYgKHVybC5wYXRobmFtZS5lbmRzV2l0aCgnL2FyY2hpdmUnKSB8fCB1cmwucGF0aG5hbWUuZW5kc1dpdGgoJy9kZWxldGUnKSkpIHtcbiAgICAgIC8vIFx1NEYxQVx1OEJERFx1NUY1Mlx1Njg2My9cdTUyMjBcdTk2NjQoaG1oYXJuZXNzIFx1NTQwQ1x1NUY2MjpcdTc5RkJcdTUxNjUgYXJjaGl2ZS90cmFzaCxcdTUzRUZcdTYwNjJcdTU5MEQsXHU0RTBEXHU3ODZDXHU1MjIwKVxuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCBwYXJ0cyA9IHVybC5wYXRobmFtZS5zbGljZSgnL2FwaS9zZXNzaW9ucy8nLmxlbmd0aCkuc3BsaXQoJy8nKTtcbiAgICAgICAgY29uc3Qgb3AgPSBwYXJ0c1sxXSA/PyAnJztcbiAgICAgICAgY29uc3Qgb2lkID0gZGVjb2RlVVJJQ29tcG9uZW50KHBhcnRzWzBdID8/ICcnKS5yZXBsYWNlKC9bXmEtekEtWjAtOV86LkAtXS9nLCAnJyk7XG4gICAgICAgIGlmIChvaWQgPT09ICcnIHx8IChvcCAhPT0gJ2FyY2hpdmUnICYmIG9wICE9PSAnZGVsZXRlJykpIHtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnYmFkIG9wJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGlmICghc2Vzc2lvbnMuaGFzKG9pZCkpIHtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnc2Vzc2lvbiBub3QgZm91bmQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgc2Vzc2lvbnMuZGVsZXRlKG9pZCk7XG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSB9KSk7XG4gICAgICB9KSgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvaW5qZWN0Jykge1xuICAgICAgLy8gXHU4RkQwXHU4ODRDXHU0RTJEXHU2Q0U4XHU1MTY1KFx1NEUwRSBobWhhcm5lc3MgL2FwaS9pbmplY3QgXHU1NDBDXHU1RjYyO2Zha2UgXHU1M0VBXHU1NkRFXHU2MjY3KVxuICAgICAgdm9pZCByZWFkQm9keSgpO1xuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9pbnRlcnJ1cHQnKSB7XG4gICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgnJykgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47IC8vIGludGVycnVwdCBcdTY1RTAgYm9keSBcdThCRURcdTRFNDlcbiAgICAgIHZvaWQgYm9keTtcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUgfSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9zZXNzaW9ucycpIHtcbiAgICAgIGNvbnN0IGxpc3QgPSBbLi4uc2Vzc2lvbnMudmFsdWVzKCldLm1hcCgocykgPT4gKHtcbiAgICAgICAgaWQ6IHMuaWQsIHRpdGxlOiAnJywgdGFzazogJycsIG91dGNvbWU6ICdvaycsIHR1cm5zOiAxLCB0b29sVXNlczogMSxcbiAgICAgICAgdGltZTogcy51cGRhdGVkQXQsIGN3ZDogJ0M6XFxcXGRlbW8nLCBicmFuY2g6ICcnLCBjcmVhdGVkQXQ6IHMuY3JlYXRlZEF0LCB1cGRhdGVkQXQ6IHMudXBkYXRlZEF0LFxuICAgICAgfSkpO1xuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBzZXNzaW9uczogbGlzdCwgbmV4dEN1cnNvcjogbnVsbCB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUuc3RhcnRzV2l0aCgnL2FwaS9zZXNzaW9ucy8nKSkge1xuICAgICAgY29uc3Qgc2VnID0gZGVjb2RlVVJJQ29tcG9uZW50KHVybC5wYXRobmFtZS5zbGljZSgnL2FwaS9zZXNzaW9ucy8nLmxlbmd0aCkpO1xuICAgICAgLy8gXHU1QkZDXHU1MUZBKFx1NEUwRSBobWhhcm5lc3MgL2FwaS9zZXNzaW9ucy86aWQvZXhwb3J0Lm1kIFx1NTQwQ1x1NUY2Mjp0ZXh0L21hcmtkb3duIFx1NEUwQlx1OEY3RClcbiAgICAgIGNvbnN0IGV4cG9ydE1hdGNoID0gL14oLiopXFwvZXhwb3J0XFwubWQkLy5leGVjKHNlZykgPz8gL14oLiopXFwuZXhwb3J0XFwubWQkLy5leGVjKHNlZyk7XG4gICAgICBpZiAoZXhwb3J0TWF0Y2ggIT09IG51bGwgJiYgZXhwb3J0TWF0Y2hbMV0gIT09IHVuZGVmaW5lZCAmJiBleHBvcnRNYXRjaFsxXSAhPT0gJycpIHtcbiAgICAgICAgY29uc3QgZWlkID0gZXhwb3J0TWF0Y2hbMV0ucmVwbGFjZSgvW15hLXpBLVowLTlfOi5ALV0vZywgJycpO1xuICAgICAgICBjb25zdCBlcyA9IHNlc3Npb25zLmdldChlaWQpO1xuICAgICAgICBpZiAoZXMgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICdzZXNzaW9uIG5vdCBmb3VuZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ3RleHQvbWFya2Rvd247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICByZXMuZW5kKGAjIGhtaGFybmVzcyBcdTRGMUFcdThCRERcdTVCRkNcdTUxRkEoZmFrZSlcXG5cXG4tIFx1NEYxQVx1OEJERDoke2VpZH1cXG5cXG4jIyBcdTc1MjhcdTYyMzdcXG5cXG5cdTRFNEJcdTUyNERcdTc2ODRcdTRFRkJcdTUyQTEoZmFrZSBcdTk4ODRcdTg5QzgpXFxuXFxuIyMgXHU1MkE5XHU2MjRCXFxuXFxuXHU4RkQ5XHU2NjJGXHU1QkZDXHU1MUZBXHU3Njg0XHU1NkRFXHU1OTBEXHU5ODg0XHU4OUM4KGZha2UpXHUzMDAyXFxuYCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIC8vIFx1NEYxQVx1OEJERFx1OTg4NFx1ODlDOChcdTRFMEUgaG1oYXJuZXNzIEdFVCAvYXBpL3Nlc3Npb25zLzppZCBcdTU0MENcdTVGNjI6XHU2NzAwXHU1NDBFIDgwIFx1Njc2MSxcdTZCQ0ZcdTY3NjEgNTAwIFx1NUI1NylcbiAgICAgIGNvbnN0IGlkID0gc2VnLnJlcGxhY2UoL1teYS16QS1aMC05XzouQC1dL2csICcnKTtcbiAgICAgIGNvbnN0IHMgPSBzZXNzaW9ucy5nZXQoaWQpO1xuICAgICAgaWYgKHMgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3Nlc3Npb24gbm90IGZvdW5kJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgaWQsIG1vZGVsOiAnZmFrZS1tb2RlbCcsIGN3ZDogJ0M6XFxcXGRlbW8nLFxuICAgICAgICBtZXNzYWdlczogW1xuICAgICAgICAgIHsgcm9sZTogJ3VzZXInLCB0ZXh0OiAnXHU0RTRCXHU1MjREXHU3Njg0XHU0RUZCXHU1MkExKGZha2UgXHU5ODg0XHU4OUM4KScsIHRvb2xzOiBbXSB9LFxuICAgICAgICAgIHsgcm9sZTogJ2Fzc2lzdGFudCcsIHRleHQ6ICdcdThGRDlcdTY2MkZcdTUzODZcdTUzRjJcdTRGMUFcdThCRERcdTc2ODRcdTU2REVcdTU5MERcdTk4ODRcdTg5QzgoZmFrZSlcdTMwMDInLCB0b29sczogWydyZWFkX2ZpbGUnXSB9LFxuICAgICAgICBdLFxuICAgICAgfSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9mcycpIHtcbiAgICAgIC8vIFx1NzZFRVx1NUY1NVx1NkQ0Rlx1ODlDOChcdTRFMEUgaG1oYXJuZXNzIFx1NTQwQ1x1NUY2MjpwYXRoIFx1NzcwMVx1NzU2NT1cdTY4Mzk7ZmlsZXM9MSBcdTk2NDRcdTVFMjZcdTY1ODdcdTRFRjZcdTUyMTdcdTg4NjgpXG4gICAgICBjb25zdCBxID0gdXJsLnNlYXJjaFBhcmFtcy5nZXQoJ3BhdGgnKSA/PyAnJztcbiAgICAgIGNvbnN0IHdpdGhGaWxlcyA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KCdmaWxlcycpID09PSAnMSc7XG4gICAgICBpZiAocSA9PT0gJycpIHtcbiAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgcGF0aDogJycsIHNlZ21lbnRzOiBbXSwgcGFyZW50OiAnJyxcbiAgICAgICAgICBkaXJzOiBbeyBuYW1lOiAnZGVtby13b3Jrc3BhY2UnLCBwYXRoOiAnQzpcXFxcZGVtbycgfV0sXG4gICAgICAgICAgLi4uKHdpdGhGaWxlcyA/IHsgZmlsZXM6IFtdIH0gOiB7fSksXG4gICAgICAgIH0pKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBwYXRoOiBxLCBzZWdtZW50czogW3sgbmFtZTogcS5zcGxpdCgvW1xcXFwvXS8pLmZpbHRlcihCb29sZWFuKS5wb3AoKSA/PyBxLCBwYXRoOiBxIH1dLCBwYXJlbnQ6ICcnLFxuICAgICAgICBkaXJzOiBbeyBuYW1lOiAnc3JjJywgcGF0aDogYCR7cS5yZXBsYWNlKC9bXFxcXC9dJC8sICcnKX1cXFxcc3JjYCB9XSxcbiAgICAgICAgLi4uKHdpdGhGaWxlcyA/IHsgZmlsZXM6IFtcbiAgICAgICAgICB7IG5hbWU6ICdSRUFETUUubWQnLCBwYXRoOiBgJHtxLnJlcGxhY2UoL1tcXFxcL10kLywgJycpfVxcXFxSRUFETUUubWRgLCByZWw6ICdSRUFETUUubWQnIH0sXG4gICAgICAgICAgeyBuYW1lOiAncGFja2FnZS5qc29uJywgcGF0aDogYCR7cS5yZXBsYWNlKC9bXFxcXC9dJC8sICcnKX1cXFxccGFja2FnZS5qc29uYCwgcmVsOiAncGFja2FnZS5qc29uJyB9LFxuICAgICAgICBdIH0gOiB7fSksXG4gICAgICB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2ZzL3JlYWQnKSB7XG4gICAgICAvLyBcdTY1ODdcdTRFRjZcdTk4ODRcdTg5QzgoNjRLQiBcdTRFMEFcdTk2NTBcdThCRURcdTRFNDk7ZmFrZSBcdThGRDRcdTU2REVcdTU2RkFcdTVCOUFcdTY1ODdcdTY3MkMpXG4gICAgICBjb25zdCBwID0gdXJsLnNlYXJjaFBhcmFtcy5nZXQoJ3BhdGgnKSA/PyAnJztcbiAgICAgIGlmIChwID09PSAnJykge1xuICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3BhdGggcmVxdWlyZWQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBwYXRoOiBwLCByZWw6IHAuc3BsaXQoL1tcXFxcL10vKS5wb3AoKSA/PyBwLCBzaXplOiA0MixcbiAgICAgICAgdGV4dDogJyMgZGVtbyB3b3Jrc3BhY2VcXG5cXG5cdThGRDlcdTY2MkYgZmFrZSBob3N0IFx1NzY4NFx1NjU4N1x1NEVGNlx1OTg4NFx1ODlDOFx1NTE4NVx1NUJCOVx1MzAwMlxcbicsXG4gICAgICB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2RpZmYnKSB7XG4gICAgICAvLyBEaWZmIFx1OTc2Mlx1Njc3RihcdTRFMEUgaG1oYXJuZXNzIC9hcGkvZGlmZiBcdTU0MENcdTVGNjI7ZmFrZSBcdThGRDRcdTU2REVcdTU2RkFcdTVCOUFcdTVDMEZcdTUzRDhcdTY2RjRcdTk2QzYpXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIGdpdDogdHJ1ZSwgY3dkOiAnQzpcXFxcZGVtbycsXG4gICAgICAgIGNoYW5nZWQ6IFtcbiAgICAgICAgICB7IHN0YXRlOiAnTScsIHBhdGg6ICdzcmMvYXBwLnRzJyB9LFxuICAgICAgICAgIHsgc3RhdGU6ICdBJywgcGF0aDogJ2RvY3Mvbm90ZXMubWQnIH0sXG4gICAgICAgIF0sXG4gICAgICAgIHN0YXQ6ICcgc3JjL2FwcC50cyAgICAgIHwgMTIgKysrKysrKy0tLVxcbiBkb2NzL25vdGVzLm1kICAgfCAgNCArKysrXFxuIDIgZmlsZXMgY2hhbmdlZCwgMTYgaW5zZXJ0aW9ucygrKSwgMyBkZWxldGlvbnMoLSknLFxuICAgICAgfSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS93b3Jrc3BhY2VzJykge1xuICAgICAgLy8gXHU1REU1XHU0RjVDXHU1MzNBKFx1NEUwRSBobWhhcm5lc3MgXHU1NDBDXHU1RjYyOmN1cnJlbnQgKyBpdGVtcylcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgY3VycmVudDogZmFrZVdvcmtzcGFjZXMuY3VycmVudCxcbiAgICAgICAgaXRlbXM6IGZha2VXb3Jrc3BhY2VzLml0ZW1zLFxuICAgICAgfSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvd29ya3NwYWNlcycpIHtcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoKGF3YWl0IHJlYWRCb2R5KCkpIHx8ICd7fScpIGFzIHsgbmFtZT86IHVua25vd247IHBhdGg/OiB1bmtub3duIH07XG4gICAgICAgIGNvbnN0IHBhdGggPSB0eXBlb2YgYm9keS5wYXRoID09PSAnc3RyaW5nJyA/IGJvZHkucGF0aCA6ICcnO1xuICAgICAgICBjb25zdCBuYW1lID0gdHlwZW9mIGJvZHkubmFtZSA9PT0gJ3N0cmluZycgJiYgYm9keS5uYW1lICE9PSAnJyA/IGJvZHkubmFtZSA6IChwYXRoLnNwbGl0KC9bXFxcXC9dLykuZmlsdGVyKEJvb2xlYW4pLnBvcCgpID8/ICcnKTtcbiAgICAgICAgaWYgKHBhdGggPT09ICcnIHx8IG5hbWUgPT09ICcnKSB7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ2Fic29sdXRlIHBhdGggYW5kIG5hbWUgcmVxdWlyZWQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGZha2VXb3Jrc3BhY2VzLml0ZW1zLnNvbWUoKHcpID0+IHcucGF0aC50b0xvd2VyQ2FzZSgpID09PSBwYXRoLnRvTG93ZXJDYXNlKCkpKSB7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDksIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3dvcmtzcGFjZSBhbHJlYWR5IHJlZ2lzdGVyZWQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgaXRlbSA9IHsgaWQ6IGB3cy0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDgpfWAsIG5hbWUsIHBhdGggfTtcbiAgICAgICAgZmFrZVdvcmtzcGFjZXMuaXRlbXMucHVzaChpdGVtKTtcbiAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlLCBjdXJyZW50OiBmYWtlV29ya3NwYWNlcy5jdXJyZW50LCBpdGVtczogZmFrZVdvcmtzcGFjZXMuaXRlbXMgfSkpO1xuICAgICAgfSkoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3dvcmtzcGFjZXMvdXNlJykge1xuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgoYXdhaXQgcmVhZEJvZHkoKSkgfHwgJ3t9JykgYXMgeyBpZD86IHVua25vd24gfTtcbiAgICAgICAgY29uc3QgaGl0ID0gZmFrZVdvcmtzcGFjZXMuaXRlbXMuZmluZCgodykgPT4gdy5pZCA9PT0gYm9keS5pZCk7XG4gICAgICAgIGlmIChoaXQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICd3b3Jrc3BhY2Ugbm90IGZvdW5kJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGZha2VXb3Jrc3BhY2VzLmN1cnJlbnQgPSBoaXQuaWQ7XG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgY3VycmVudDogZmFrZVdvcmtzcGFjZXMuY3VycmVudCwgaXRlbXM6IGZha2VXb3Jrc3BhY2VzLml0ZW1zIH0pKTtcbiAgICAgIH0pKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9wcm92aWRlcnMnKSB7XG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7IG5hbWU/OiB1bmtub3duOyBiYXNlVXJsPzogdW5rbm93bjsgbW9kZWw/OiB1bmtub3duOyBhcGlLZXk/OiB1bmtub3duIH07XG4gICAgICAgIGNvbnN0IG5hbWUgPSB0eXBlb2YgYm9keS5uYW1lID09PSAnc3RyaW5nJyA/IGJvZHkubmFtZS50cmltKCkgOiAnJztcbiAgICAgICAgY29uc3QgYmFzZVVybCA9IHR5cGVvZiBib2R5LmJhc2VVcmwgPT09ICdzdHJpbmcnID8gYm9keS5iYXNlVXJsLnRyaW0oKSA6ICcnO1xuICAgICAgICBjb25zdCBtb2RlbCA9IHR5cGVvZiBib2R5Lm1vZGVsID09PSAnc3RyaW5nJyA/IGJvZHkubW9kZWwudHJpbSgpIDogJyc7XG4gICAgICAgIGlmIChuYW1lID09PSAnJyB8fCBiYXNlVXJsID09PSAnJyB8fCBtb2RlbCA9PT0gJycpIHtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnbmFtZSwgYmFzZVVybCBhbmQgbW9kZWwgYXJlIHJlcXVpcmVkJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGZha2VQcm92aWRlcnMuc2V0KG5hbWUsIHsgYmFzZVVybCwgbW9kZWwsIGFwaUtleTogdHlwZW9mIGJvZHkuYXBpS2V5ID09PSAnc3RyaW5nJyA/IGJvZHkuYXBpS2V5IDogJycgfSk7XG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgbmFtZSB9KSk7XG4gICAgICB9KSgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9mcy9zZWFyY2gnKSB7XG4gICAgICAvLyBcdTVERTVcdTRGNUNcdTUzM0FcdTY1ODdcdTRFRjZcdTY0MUNcdTdEMjIoXHU0RTBFIGhtaGFybmVzcyBcdTU0MENcdTVGNjI6QFx1OTY0NFx1NEVGNlx1OTAwOVx1NjJFOVx1NTY2OFx1NzY4NFx1NjU3MFx1NjM2RVx1NkU5MClcbiAgICAgIGNvbnN0IHEgPSAodXJsLnNlYXJjaFBhcmFtcy5nZXQoJ3EnKSA/PyAnJykudHJpbSgpLnRvTG93ZXJDYXNlKCk7XG4gICAgICBjb25zdCBhbGwgPSBbXG4gICAgICAgIHsgcmVsOiAnUkVBRE1FLm1kJywgcGF0aDogJ0M6XFxcXGRlbW9cXFxcUkVBRE1FLm1kJywga2luZDogJ2ZpbGUnIH0sXG4gICAgICAgIHsgcmVsOiAnc3JjL2FwcC50cycsIHBhdGg6ICdDOlxcXFxkZW1vXFxcXHNyY1xcXFxhcHAudHMnLCBraW5kOiAnZmlsZScgfSxcbiAgICAgICAgeyByZWw6ICdkb2NzL25vdGVzLm1kJywgcGF0aDogJ0M6XFxcXGRlbW9cXFxcZG9jc1xcXFxub3Rlcy5tZCcsIGtpbmQ6ICdmaWxlJyB9LFxuICAgICAgXTtcbiAgICAgIGNvbnN0IGhpdHMgPSBxID09PSAnJyA/IGFsbCA6IGFsbC5maWx0ZXIoKGYpID0+IGYucmVsLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMocSkpO1xuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyByZXN1bHRzOiBoaXRzLnNsaWNlKDAsIDIwKSwgdHJ1bmNhdGVkOiBmYWxzZSwgdG90YWw6IGhpdHMubGVuZ3RoIH0pKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvY29nbml0aXZlJykge1xuICAgICAgLy8gXHU4QkE0XHU3N0U1XHU3MkI2XHU2MDAxKFx1NEUwRSBobWhhcm5lc3MgY29nbml0aXZlU3RhdHVzIFx1NTQwQ1x1NUY2Mlx1NUI1MFx1OTZDNjtcdTdGM0FcdTY1NzBcdTYzNkVcdTY2M0VcdTVGMEYgbnVsbClcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgbWVtb3J5OiB7IGxheWVyczogMywgZW50cmllczogMTIsIGNvbnRyYWRpY3Rpb25zOiAwIH0sXG4gICAgICAgIHRyYWplY3RvcmllczogNyxcbiAgICAgICAgYXVkaXRFdmVudHM6IDIxLFxuICAgICAgICB3b3JsZE1vZGVsOiB7IHZlcnNpb246IDQsIGJlbGllZnM6IDksIHRydXN0ZWQ6IDUsIGJyaWVyOiAwLjMxIH0sXG4gICAgICAgIGNhbGlicmF0aW9uOiB7IHByZWRpY3Rpb25zOiA0NiwgcmVsaWFiaWxpdHk6IDAuNzIgfSxcbiAgICAgIH0pKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2Zha2UvZW1pdCcpIHtcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgoYXdhaXQgcmVhZEJvZHkoKSkgfHwgJ3t9JykgYXMge1xuICAgICAgICAgICAgc2Vzc2lvbklkOiBzdHJpbmc7IHJ1bklkOiBzdHJpbmc7IGtpbmQ6IEV2ZW50S2luZDsgcGF5bG9hZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICAgICAgfTtcbiAgICAgICAgICBjb25zdCBzZXEgPSBlbWl0KGJvZHkuc2Vzc2lvbklkLCBib2R5LnJ1bklkLCBib2R5LmtpbmQsIGJvZHkucGF5bG9hZCk7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIHNlcSB9KSk7XG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsIFN0cmluZyhlcnIpLnNsaWNlKDAsIDEyMCksIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICB9XG4gICAgICB9KSgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCBgbm8gcm91dGUgJHtyZXEubWV0aG9kfSAke3VybC5wYXRobmFtZX1gLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgfSk7XG5cbiAgYXdhaXQgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgIHNlcnZlci5vbmNlKCdlcnJvcicsIHJlamVjdCk7XG4gICAgc2VydmVyLmxpc3RlbigwLCAnMTI3LjAuMC4xJywgKCkgPT4gcmVzb2x2ZSgpKTtcbiAgfSk7XG4gIGNvbnN0IGFkZHJlc3MgPSBzZXJ2ZXIuYWRkcmVzcygpO1xuICBpZiAoYWRkcmVzcyA9PT0gbnVsbCB8fCB0eXBlb2YgYWRkcmVzcyAhPT0gJ29iamVjdCcpIHRocm93IG5ldyBFcnJvcignZmFrZSBob3N0OiBubyBwb3J0Jyk7XG4gIGNvbnN0IHBvcnQgPSBhZGRyZXNzLnBvcnQ7XG5cbiAgaWYgKCFvcHRzLnF1aWV0KSB7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7SlNPTi5zdHJpbmdpZnkoeyBobWhEZXNrdG9wSG9zdFJlYWR5OiB0cnVlLCBwb3J0LCB2ZXJzaW9uOiAnZmFrZS0wLjAuMCcgfSl9XFxuYCk7XG4gIH1cbiAgY29uc3QgZGllQWZ0ZXIgPSBOdW1iZXIocHJvY2Vzcy5lbnYuRkFLRV9IT1NUX0RJRV9BRlRFUl9NUyA/PyAwKTtcbiAgaWYgKE51bWJlci5pc0Zpbml0ZShkaWVBZnRlcikgJiYgZGllQWZ0ZXIgPiAwKSB7XG4gICAgc2V0VGltZW91dCgoKSA9PiBwcm9jZXNzLmV4aXQoMSksIGRpZUFmdGVyKS51bnJlZigpO1xuICB9XG5cbiAgLy8gY2xvc2UoKTogXHU1MTQ4XHU2NUFEXHU1RjAwXHU1MTY4XHU5MEU4IFNTRSBcdThGREVcdTYzQTUoXHU1QjgzXHU0RUVDXHU2QzM4XHU0RTBEXHU4MUVBXHU3MTM2XHU1MTczXHU5NUVEKSxcdTU0MjZcdTUyMTkgc2VydmVyLmNsb3NlXG4gIC8vIFx1NEYxQVx1NEUwMFx1NzZGNFx1N0I0OVx1NkQzQlx1OERDM1x1OEZERVx1NjNBNSxcdTZENEJcdThCRDVcdThGREJcdTdBMEJcdTYzMDJcdTZCN0JcdTMwMDJcbiAgY29uc3QgY2xvc2UgPSAoKTogUHJvbWlzZTx2b2lkPiA9PlxuICAgIG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlKSA9PiB7XG4gICAgICBmb3IgKGNvbnN0IGMgb2Ygc3NlQ2xpZW50cykge1xuICAgICAgICB0cnkgeyBjLmVuZCgpOyBjLmRlc3Ryb3koKTsgfSBjYXRjaCB7IC8qIGFscmVhZHkgZ29uZSAqLyB9XG4gICAgICB9XG4gICAgICBzc2VDbGllbnRzLmNsZWFyKCk7XG4gICAgICBzZXJ2ZXIuY2xvc2UoKCkgPT4gcmVzb2x2ZSgpKTtcbiAgICAgIHNldFRpbWVvdXQoKCkgPT4gcmVzb2x2ZSgpLCAxXzAwMCkudW5yZWYoKTtcbiAgICB9KTtcblxuICByZXR1cm4geyBwb3J0LCBlbWl0LCBjbG9zZSB9O1xufVxuXG4vLyBcdTc2RjRcdTYzQTVcdThGRDBcdTg4NEMoc3VwZXJ2aXNvciBzcGF3biBcdTc2ODRcdTVCNTBcdThGREJcdTdBMEJcdTVGNjJcdTYwMDEpXHUzMDAycmVhbHBhdGggXHU2QkQ0XHU4RjgzOm5wbSB3b3Jrc3BhY2Vcbi8vIGp1bmN0aW9uIC8gXHU1OTI3XHU1QzBGXHU1MTk5XHU1REVFXHU1RjAyXHU5MEZEXHU0RTBEXHU4MEZEXHU4QkE5XHU4RkQ5XHU0RTJBXHU2OEMwXHU2RDRCXHU1OTMxXHU2MjRCKFx1NTkzMVx1NjI0Qj1cdTk3NTlcdTlFRDhcdTkwMDBcdTUxRkEgY29kZSAwLFx1OTZCRVx1NjdFNSlcdTMwMDJcbi8vIGNqcyBidW5kbGUoZXNidWlsZCxcdTYyNTNcdTUzMDVcdTRFQTdcdTU0QzEpXHU0RTBCIF9fZmlsZW5hbWUgXHU1QjU4XHU1NzI4O0VTTSh0c3gvXHU2RTkwXHU3ODAxKVx1NzUyOCBpbXBvcnQubWV0YVx1MzAwMlxuY29uc3Qgc2VsZlVybDogc3RyaW5nID0gdHlwZW9mIF9fZmlsZW5hbWUgPT09ICdzdHJpbmcnXG4gID8gcGF0aFRvRmlsZVVSTChyZWFscGF0aFN5bmMoX19maWxlbmFtZSkpLmhyZWZcbiAgOiBpbXBvcnQubWV0YS51cmw7XG5jb25zdCBpbnZva2VkQXNTY3JpcHQgPSAoKCkgPT4ge1xuICBpZiAocHJvY2Vzcy5hcmd2WzFdID09PSB1bmRlZmluZWQpIHJldHVybiBmYWxzZTtcbiAgdHJ5IHtcbiAgICByZXR1cm4gc2VsZlVybCA9PT0gcGF0aFRvRmlsZVVSTChyZWFscGF0aFN5bmMocHJvY2Vzcy5hcmd2WzFdKSkuaHJlZjtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59KSgpO1xuaWYgKGludm9rZWRBc1NjcmlwdCkge1xuICBjb25zdCB0b2tlbiA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1RPS0VOID8/ICcnO1xuICAvLyBGQUtFX0hPU1RfRElFX0FUX0JPT1Q9MTpcdTVGMTVcdTVCRkNcdTg4NENcdThGOTNcdTUxRkFcdTUyNERcdTUzNzNcdTZCN0IoXHU2Nzg0XHU5MDIwXHU1NDJGXHU1MkE4XHU2NzFGIFJVTlRJTUVfQ1JBU0hFRClcbiAgaWYgKHByb2Nlc3MuZW52LkZBS0VfSE9TVF9ESUVfQVRfQk9PVCA9PT0gJzEnKSB7XG4gICAgcHJvY2Vzcy5leGl0KDEpO1xuICB9XG4gIGNvbnN0IHNsb3cgPSBOdW1iZXIocHJvY2Vzcy5lbnYuRkFLRV9IT1NUX1NMT1dfQUZURVIgPz8gMCk7XG4gIGNvbnN0IGJvb3QgPSAoKTogdm9pZCA9PiB7XG4gICAgdm9pZCBzdGFydEZha2VIb3N0KHsgdG9rZW4gfSkuY2F0Y2goKGVycikgPT4ge1xuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYGZha2UtaG9zdCBmYWlsZWQ6ICR7U3RyaW5nKGVycil9XFxuYCk7XG4gICAgICBwcm9jZXNzLmV4aXQoMSk7XG4gICAgfSk7XG4gIH07XG4gIGlmIChOdW1iZXIuaXNGaW5pdGUoc2xvdykgJiYgc2xvdyA+IDApIHNldFRpbWVvdXQoYm9vdCwgc2xvdyk7XG4gIGVsc2UgYm9vdCgpO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIjtBQWNBLFNBQVMsS0FBSyxlQUFlLFFBQVEsU0FBUyxTQUFTLGFBQWE7QUFDcEUsU0FBUyxZQUFZ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QyxFQUFFO0FBQ2pGLFVBQUksQ0FBQyxHQUFJLFdBQVU7QUFBQSxJQUNyQjtBQUNBLFlBQVEsSUFBSSw4QkFBOEIsUUFBUSxTQUFTLE1BQU0sSUFBSSxRQUFRLE1BQU0sRUFBRTtBQUNyRixRQUFJLEtBQUssV0FBVyxJQUFJLElBQUksQ0FBQztBQUFBLEVBQy9CO0FBR0EsTUFBSSxHQUFHLGVBQWUsQ0FBQyxNQUFNO0FBQzNCLFFBQUksZUFBZSxRQUFRLFdBQVcsVUFBVSxXQUFXO0FBQ3pELFFBQUUsZUFBZTtBQUNqQixnQkFBVSxNQUFNO0FBQ2hCLFdBQUssV0FBVyxLQUFLLEVBQUUsUUFBUSxNQUFNLElBQUksS0FBSyxDQUFDO0FBQUEsSUFDakQ7QUFBQSxFQUNGLENBQUM7QUFDRCxNQUFJLEdBQUcscUJBQXFCLE1BQU07QUFDaEMsUUFBSSxRQUFRLGFBQWEsU0FBVSxLQUFJLEtBQUs7QUFBQSxFQUM5QyxDQUFDO0FBQ0g7QUEvZVc7QUFlQTtBQWtIQTtBQVlBO0FBV0E7IiwKICAibmFtZXMiOiBbInBhdGhUb0ZpbGVVUkwiLCAicmFuZG9tVVVJRCIsICJyYW5kb21VVUlEIiwgInB1c2hFdmVudCIsICJicm9hZGNhc3RIb3N0U3RhdGUiLCAic2VuZGVyVHJ1c3RlZCIsICJob3N0Q2FsbCIsICJyZWdpc3RlcklwYyIsICJwYXRoVG9GaWxlVVJMIl0KfQo=
