// apps/desktop/electron/main/index.ts
import { app as app2, BrowserWindow, dialog, ipcMain, session, shell, Tray, Notification, Menu, nativeImage, nativeTheme } from "electron";
import { join as join2, dirname, isAbsolute, resolve } from "node:path";
import { existsSync, realpathSync as realpathSync2 } from "node:fs";
import { writeFile as writeFile2, readFile } from "node:fs/promises";
import { homedir, networkInterfaces } from "node:os";
import { execFileSync, spawn as spawn2 } from "node:child_process";
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
var DEFAULT_START_TIMEOUT_MS = 45e3;
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
    return new Promise((resolve2, reject) => {
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
          void this.probeAndRemember(parsed.port, parsed.version).then((endpoint) => done(() => resolve2(endpoint))).catch((err) => done(() => reject(err)));
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
    const exited = new Promise((resolve2) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve2();
      else {
        const w = () => resolve2();
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
      new Promise((resolve2) => setTimeout(() => resolve2(false), this.opts.gracefulShutdownMs))
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
    ["demo", { baseUrl: "http://127.0.0.1:9/v1", model: "fake-m", apiKey: "sk-demo-1234" }],
    ["demo-vision", { baseUrl: "http://127.0.0.1:9/v1", model: "fake-m-vision", apiKey: "sk-demo-5678" }]
  ]);
  let fakeChatProvider = "demo";
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
    const readBody = () => new Promise((resolve2) => {
      let b = "";
      req.on("data", (c) => {
        b += c.toString();
      });
      req.on("end", () => resolve2(b));
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
        model: fakeProviders.get(fakeChatProvider)?.model ?? "fake-model",
        chatProvider: fakeChatProvider,
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
    if (req.method === "POST" && url.pathname === "/api/model") {
      void (async () => {
        const body = JSON.parse(await readBody() || "{}");
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!fakeProviders.has(name)) {
          res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(desktopError("SCHEMA_MISMATCH", "provider not found", { retryable: false })));
          return;
        }
        fakeChatProvider = name;
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, model: fakeProviders.get(name)?.model }));
      })();
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
          const images = Array.isArray(body.images) ? body.images.filter((im) => {
            if (typeof im !== "object" || im === null) return false;
            const o = im;
            return typeof o.name === "string" && typeof o.dataUrl === "string" && o.dataUrl.startsWith("data:image/");
          }) : [];
          if (!text) {
            res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify(desktopError("SCHEMA_MISMATCH", "text required", { retryable: false })));
            return;
          }
          const composed = attachments.length > 0 ? `[referenced files]
${attachments.map((a) => `- ${a.split(/[\\/]/).pop()}`).join("\n")}

${text}` : text;
          const withImages = images.length > 0 ? `[images: ${images.length}]
${composed}` : composed;
          const runId = runTask(sessionId, withImages, mode);
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true, runId, images: images.length }));
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
  await new Promise((resolve2, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve2());
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
  const close = () => new Promise((resolve2) => {
    for (const c of sseClients) {
      try {
        c.end();
        c.destroy();
      } catch {
      }
    }
    sseClients.clear();
    server.close(() => resolve2());
    setTimeout(() => resolve2(), 1e3).unref();
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

// apps/desktop/electron/main/uiverify.ts
import { app } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function runUiVerify(win, mode) {
  const shots = process.env.HMH_DESKTOP_UIVERIFY_SHOTS ?? join(app.getPath("temp"), "hmh-uiverify");
  await mkdir(shots, { recursive: true }).catch(() => void 0);
  const results = [];
  let shotIdx = 0;
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const step = async (name, fn) => {
    try {
      const [ok, detail] = await fn();
      results.push([name, ok, detail]);
    } catch (err) {
      const detail = err instanceof Error && err.stack !== void 0 ? err.stack : String(err);
      results.push([name, false, detail.slice(0, 300)]);
    }
    const last = results[results.length - 1];
    console.log(`UIVERIFY ${last[1] ? "PASS" : "FAIL"} | ${last[0]} | ${last[2]}`);
  };
  const waitFor = async (label, predicateCode, timeoutMs) => {
    const started = Date.now();
    for (; ; ) {
      const r = await js(`(function(){ try { return JSON.stringify((function(){ ${predicateCode} })()); } catch(e){ return JSON.stringify({ok:false, detail:String(e).slice(0,120)}); } })()`);
      let parsed;
      try {
        parsed = JSON.parse(r);
      } catch {
        parsed = { ok: false, detail: String(r).slice(0, 120) };
      }
      if (parsed.ok === true) return [true, String(parsed.detail ?? "")];
      if (Date.now() - started > timeoutMs) return [false, `${label}: ${String(parsed.detail ?? "timeout")}`];
      await sleep(250);
    }
  };
  const shot = async (label) => {
    shotIdx += 1;
    try {
      const img = await win.webContents.capturePage();
      await writeFile(join(shots, `${mode}-${String(shotIdx).padStart(2, "0")}-${label}.png`), img.toPNG());
    } catch {
    }
  };
  const typeInto = (sel, text) => js(`(function(){
      var el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return 'NOEL';
      var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'OK';
    })()`);
  await waitFor("host ready", `var t=document.querySelector('.composer textarea'); return {ok: !!t, detail: t ? 'mounted' : 'no composer'};`, 2e4);
  await waitFor("host dot on", `var d=document.querySelector('.host-dot'); return {ok: !!d && d.classList.contains('on'), detail: d ? d.className : 'no dot'};`, mode === "real" ? 6e4 : 2e4);
  await sleep(1200);
  await step("\u5E03\u5C40:\u6807\u9898\u680F+\u4E09\u680F+composer \u5728\u89C6\u53E3\u5185(\u8F93\u5165\u6846\u53EF\u89C1)", async () => {
    const r = await js(`(function(){
      var q = document.querySelector.bind(document);
      var tb = q('.titlebar'), shell = q('.app-shell'), sb = q('.sidebar'), ws = q('.workspace'), ta = q('.composer textarea');
      var missing = [!tb && 'titlebar', !shell && 'shell', !sb && 'sidebar', !ws && 'workspace', !ta && 'textarea'].filter(Boolean).join(',');
      if (missing !== '') return JSON.stringify({ok:false, detail:'missing:'+missing});
      var r = ta.getBoundingClientRect(), vh = window.innerHeight, vw = window.innerWidth;
      var hint = q('.empty-hint.big'); var hr = hint ? hint.getBoundingClientRect() : null;
      return JSON.stringify({ ok: r.height > 30 && r.bottom <= vh && r.width > 100 && hr !== null && hr.top >= 0 && hr.bottom <= vh,
        detail: 'textarea y='+Math.round(r.y)+' h='+Math.round(r.height)+' bottom='+Math.round(r.bottom)+' vh='+vh+(hr ? ' hint y='+Math.round(hr.y) : ' no-hint') });
    })()`);
    const p = JSON.parse(r);
    return [p.ok === true, p.detail];
  });
  if (mode === "fake") {
    await step("\u5F15\u5BFC\u5C42:\u6F14\u793A\u6A21\u5F0F\u63D0\u793A\u51FA\u73B0\u5E76\u53EF\u5173\u95ED", async () => {
      const w = await waitFor("guide", `var g=document.querySelector('.runtime-guide'); return {ok: !!g, detail: g ? 'shown' : 'not shown'};`, 8e3);
      if (!w[0]) return w;
      await js(`(function(){
        var btns = [].slice.call(document.querySelectorAll('.runtime-guide button'));
        var b = btns.find(function(x){ return x.textContent.indexOf('\u6F14\u793A') >= 0; });
        if (b) b.click();
      })()`);
      return waitFor("guide gone", `return {ok: !document.querySelector('.runtime-guide'), detail: document.querySelector('.runtime-guide') ? 'still' : 'dismissed'};`, 5e3);
    });
    await step("Ctrl+N \u65B0\u5EFA\u4F1A\u8BDD,\u8F93\u5165\u6846\u53EF\u7528", async () => {
      await js(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'n', ctrlKey:true, bubbles:true}))`);
      return waitFor("textarea enabled", `var t=document.querySelector('.composer textarea');
        return {ok: !!t && t.disabled === false && (t.placeholder||'').indexOf('\u63CF\u8FF0\u76EE\u6807') >= 0, detail: t ? ('disabled='+t.disabled+' ph='+(t.placeholder||'').slice(0,20)) : 'no ta'};`, 5e3);
    });
    await step("\u8F93\u5165\u5E76\u53D1\u9001\u4EFB\u52A1,\u7528\u6237\u6D88\u606F\u4E0A\u5C4F\u4E14\u4E0D\u91CD\u590D", async () => {
      await typeInto(".composer textarea", "\u9A8C\u6536\u4EFB\u52A1:\u5199\u5165\u4E00\u4E2A\u6587\u4EF6");
      await sleep(200);
      await js(`(function(){
        var btns = [].slice.call(document.querySelectorAll('.composer button'));
        var b = btns.find(function(x){ return x.textContent.trim() === '\u53D1\u9001'; });
        if (b) b.click();
      })()`);
      return waitFor("exactly one user turn", `var ts=[].slice.call(document.querySelectorAll('.turn.user')).filter(function(x){ return x.textContent.indexOf('\u9A8C\u6536\u4EFB\u52A1') >= 0; });
        return {ok: ts.length === 1, detail: 'count='+ts.length+' text='+(ts[0]?ts[0].textContent.slice(0,30):'none')};`, 8e3);
    });
    await step("\u5DE5\u5177\u6298\u53E0\u5361:read_file \u6267\u884C\u5E76\u5B8C\u6210", async () => {
      const w = await waitFor("tool card", `var c=[].slice.call(document.querySelectorAll('.tool-card'));
        var done = c.filter(function(x){ return x.textContent.indexOf('read_file') >= 0 && x.textContent.indexOf('# demo') >= 0; });
        return {ok: done.length >= 1, detail: 'cards='+c.length+' done='+done.length};`, 8e3);
      return w;
    });
    await step("\u5BA1\u6279:approval \u5361\u51FA\u73B0(\u7B49\u5F85\u4EBA\u5DE5\u6279\u51C6)", async () => {
      await shot("approval-pending");
      return waitFor("approval card", `var a=document.querySelector('.approval-card');
        return {ok: !!a && a.textContent.indexOf('\u9700\u8981\u5BA1\u6279') >= 0, detail: a ? a.textContent.replace(/\\s+/g,' ').slice(0, 60) : 'no approval card'};`, 8e3);
    });
    await step("\u5BA1\u6279:\u70B9\u6279\u51C6 \u2192 \u4EFB\u52A1\u7EE7\u7EED\u5230\u4EA4\u4ED8\u7269+\u6C47\u603B", async () => {
      await js(`(function(){
        var b=[].slice.call(document.querySelectorAll('.approval-card button')).find(function(x){ return x.textContent.trim()==='\u6279\u51C6'; });
        if (b) b.click();
      })()`);
      const w = await waitFor("artifact+sum", `var art=document.querySelector('.artifact-card');
        var sum=document.querySelector('.turn-sum');
        var ast=[].slice.call(document.querySelectorAll('.turn')).filter(function(x){ return x.className.indexOf('user')<0 && x.textContent.indexOf('echo:')>=0; });
        return {ok: !!art && !!sum && ast.length>=1, detail: 'artifact='+(art?art.textContent.slice(0,30):'none')+' sum='+(sum?sum.textContent:'none')+' answered='+ast.length};`, 12e3);
      await shot("run-completed");
      return w;
    });
    await step("\u70B9\u51FB\u5386\u53F2\u4F1A\u8BDD \u2192 transcript \u5185\u5BB9\u53EF\u89C1", async () => {
      await js(`(function(){ var it=document.querySelector('.session-item'); if (it) it.click(); })()`);
      return waitFor("history turns", `var ts=[].slice.call(document.querySelectorAll('.turn'));
        return {ok: ts.length >= 2, detail: 'turns='+ts.length+' first='+(ts[0]?ts[0].textContent.replace(/\\s+/g,' ').slice(0,40):'none')};`, 8e3);
    });
    await step("Dock:Overview \u6570\u636E\u884C", async () => {
      await js(`(function(){ var t=[].slice.call(document.querySelectorAll('.dock-tab')).find(function(x){return x.textContent==='Overview';}); if(t) t.click(); })()`);
      return waitFor("overview rows", `var rows=[].slice.call(document.querySelectorAll('.dock-row'));
        var ver = rows.find(function(r){ return r.textContent.indexOf('runtime \u7248\u672C')>=0; });
        return {ok: rows.length >= 5 && !!ver, detail: 'rows='+rows.length+(ver?' ver='+ver.textContent.replace(/\\s+/g,' ').slice(0,40):'')};`, 6e3);
    });
    await step("Dock:Files \u6D4F\u89C8+\u6587\u4EF6\u9884\u89C8", async () => {
      await js(`(function(){ var t=[].slice.call(document.querySelectorAll('.dock-tab')).find(function(x){return x.textContent==='\u6587\u4EF6'||x.textContent==='Files';}); if(t) t.click(); })()`);
      const w = await waitFor("fs rows", `var rows=document.querySelectorAll('.fs-row').length;
        return {ok: rows >= 1, detail: 'rows='+rows};`, 6e3);
      if (!w[0]) return w;
      await js(`(function(){ var d=[].slice.call(document.querySelectorAll('.fs-row')).find(function(x){return x.textContent.indexOf('demo-workspace')>=0 || x.textContent.indexOf('\u{1F4C1}')>=0;}); if(d) d.click(); })()`);
      const w2 = await waitFor("file rows", `var rows=[].slice.call(document.querySelectorAll('.fs-row'));
        return {ok: rows.some(function(x){return x.textContent.indexOf('README')>=0;}), detail: 'rows='+rows.length};`, 6e3);
      if (!w2[0]) return w2;
      await js(`(function(){ var f=[].slice.call(document.querySelectorAll('.fs-row')).find(function(x){return x.textContent.indexOf('README')>=0;}); if(f) f.click(); })()`);
      return waitFor("file preview", `var p=document.querySelector('.fs-preview');
        return {ok: !!p && p.textContent.indexOf('demo workspace') >= 0, detail: p ? p.textContent.replace(/\\s+/g,' ').slice(0,40) : 'no preview'};`, 6e3);
    });
    await step("Dock:Diff \u53D8\u66F4\u884C", async () => {
      await js(`(function(){ var t=[].slice.call(document.querySelectorAll('.dock-tab')).find(function(x){return x.textContent==='\u53D8\u66F4'||x.textContent==='Diff';}); if(t) t.click(); })()`);
      return waitFor("diff rows", `var rows=document.querySelectorAll('.diff-row').length;
        return {ok: rows >= 1, detail: 'diff rows='+rows};`, 6e3);
    });
    await step("Dock:Evidence \u8BA4\u77E5\u6570\u636E", async () => {
      await js(`(function(){ var t=[].slice.call(document.querySelectorAll('.dock-tab')).find(function(x){return x.textContent==='\u8BC1\u636E'||x.textContent==='Evidence';}); if(t) t.click(); })()`);
      return waitFor("evidence rows", `var rows=[].slice.call(document.querySelectorAll('.dock-row'));
        var mem = rows.find(function(r){ return r.textContent.indexOf('\u8BB0\u5FC6\u5C42')>=0 || r.textContent.indexOf('Memory layers')>=0; });
        return {ok: !!mem && mem.textContent.indexOf('3') >= 0, detail: mem ? mem.textContent.replace(/\\s+/g,' ') : 'no memory row'};`, 6e3);
    });
    await step("Dock:Logs \u9762\u677F(\u7A7A\u6001\u63D0\u793A)", async () => {
      await js(`(function(){ var t=[].slice.call(document.querySelectorAll('.dock-tab')).find(function(x){return x.textContent==='\u65E5\u5FD7'||x.textContent==='Logs';}); if(t) t.click(); })()`);
      const w = await waitFor("logs pane", `var l=document.querySelector('.logs-list');
        return {ok: !!l, detail: l ? ('rows='+l.querySelectorAll('.log-row').length) : 'no logs list'};`, 5e3);
      return w;
    });
    await step("Dock:\u8FDC\u7A0B\u9875\u7B7E(\u624B\u673A\u8FDC\u7A0B\u63A7\u5236\u9762\u677F)", async () => {
      await js(`(function(){ var t=[].slice.call(document.querySelectorAll('.dock-tab')).find(function(x){return x.textContent==='\u8FDC\u7A0B'||x.textContent==='Remote';}); if(t) t.click(); })()`);
      return waitFor("remote pane", `var p=document.querySelector('.dock-body');
        var t = p ? p.textContent : '';
        var okT = t.indexOf('\u624B\u673A\u8FDC\u7A0B\u63A7\u5236')>=0 || t.indexOf('Phone remote')>=0;
        var okA = t.indexOf('\u5F00\u673A\u81EA\u542F')>=0 || t.indexOf('Autostart')>=0;
        return {ok: !!p && okT && okA, detail: t.replace(/\\s+/g,' ').slice(0,60)};`, 6e3);
    });
    await step("\u4F1A\u8BDD\u641C\u7D22:\u8FC7\u6EE4\u751F\u6548", async () => {
      const before = await js(`document.querySelectorAll('.session-item').length`);
      await typeInto(".session-search", "zzz-\u4E0D\u5B58\u5728\u7684\u4F1A\u8BDD");
      const w = await waitFor("filtered empty", `var n=document.querySelectorAll('.session-item').length;
        return {ok: n === 0, detail: 'after='+n};`, 5e3);
      await typeInto(".session-search", "");
      await sleep(400);
      const after = await js(`document.querySelectorAll('.session-item').length`);
      return [w[0] && after === before, `${w[1]}; \u6062\u590D\u540E ${after}===${before}`];
    });
    await step("Ctrl+K \u547D\u4EE4\u9762\u677F:\u6253\u5F00\u5E76\u6267\u884C\u547D\u4EE4", async () => {
      await js(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'k', ctrlKey:true, bubbles:true}))`);
      const w = await waitFor("cmdk open", `var c=document.querySelector('.cmdk');
        return {ok: !!c, detail: c ? 'open' : 'not open'};`, 5e3);
      if (!w[0]) return w;
      await js(`(function(){ var it=[].slice.call(document.querySelectorAll('.cmdk-item')).find(function(x){return x.textContent.indexOf('\u6587\u4EF6')>=0 || x.textContent.indexOf('Files')>=0;}); if(it) it.click(); })()`);
      return waitFor("tab switched", `var t=document.querySelector('.dock-tab.active');
        return {ok: !!t && (t.textContent==='\u6587\u4EF6'||t.textContent==='Files'), detail: 'active='+(t?t.textContent:'none')};`, 5e3);
    });
    await step("\u8BBE\u7F6E(Ctrl+Shift+P):Provider \u8868\u5355\u53EF\u89C1,Esc \u5173\u95ED", async () => {
      await js(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'p', ctrlKey:true, shiftKey:true, bubbles:true}))`);
      const w = await waitFor("settings open", `var s=document.querySelector('.cmdk.settings');
        return {ok: !!s && !!s.querySelector('.provider-form'), detail: s ? 'open+form' : 'not open'};`, 5e3);
      if (!w[0]) return w;
      await js(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
      return waitFor("settings closed", `return {ok: !document.querySelector('.cmdk-overlay'), detail: 'closed'};`, 5e3);
    });
    await step("\u8BED\u8A00\u5207\u6362:\u4E2D\u6587 \u2192 English \u2192 \u6062\u590D\u4E2D\u6587", async () => {
      await js(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'p', ctrlKey:true, shiftKey:true, bubbles:true}))`);
      const w = await waitFor("settings open", `var s=document.querySelector('.cmdk.settings');
        return {ok: !!s, detail: s ? 'open' : 'not open'};`, 5e3);
      if (!w[0]) return w;
      await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.cmdk.settings button')).find(function(x){return x.textContent.trim()==='English';}); if(b) b.click(); })()`);
      const en = await waitFor("english shown", `var b=document.querySelector('.sidebar-head .btn.primary');
        return {ok: !!b && b.textContent === '+ New Session', detail: 'btn='+(b?b.textContent:'none')};`, 5e3);
      await shot("english");
      await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.cmdk.settings button')).find(function(x){return x.textContent.trim()==='\u4E2D\u6587';}); if(b) b.click(); })()`);
      const zh = await waitFor("chinese back", `var b=document.querySelector('.sidebar-head .btn.primary');
        return {ok: !!b && b.textContent === '+ \u65B0\u5EFA\u4F1A\u8BDD', detail: 'btn='+(b?b.textContent:'none')};`, 5e3);
      await js(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
      return [en[0] && zh[0], `en: ${en[1]}; zh: ${zh[1]}`];
    });
    await step("\u5DE5\u4F5C\u533A:\u5DE6\u680F\u5DE5\u4F5C\u533A\u680F\u53EF\u89C1(\u5F53\u524D\u5DE5\u4F5C\u533A\u540D)", async () => {
      return waitFor("workspace bar", `var b=document.querySelector('.workspace-bar');
        var n = b ? (b.querySelector('.ws-bar-name')||{}).textContent : '';
        return {ok: !!b && !!n && n.length > 0 && n.indexOf('\u52A0\u8F7D') < 0, detail: 'bar='+(b?'yes':'no')+' name='+n};`, 8e3);
    });
    await step("\u5DE5\u4F5C\u533A:\u83DC\u5355\u5F39\u51FA,\u5217\u8868+\u5F53\u524D\u9AD8\u4EAE+\u6DFB\u52A0\u5165\u53E3;\u5728\u6307\u5B9A\u5DE5\u4F5C\u533A\u65B0\u5EFA\u4F1A\u8BDD", async () => {
      await js(`(function(){ var b=document.querySelector('.workspace-bar'); if(b) b.click(); })()`);
      const w = await waitFor("ws menu", `var m=document.querySelector('.ws-menu');
        var items = m ? m.querySelectorAll('.ws-menu-item').length : 0;
        var cur = m ? m.querySelectorAll('.ws-menu-item.current').length : 0;
        var add = m ? (m.textContent.indexOf('\u6DFB\u52A0\u5DE5\u4F5C\u533A')>=0 || m.textContent.indexOf('Add workspace')>=0) : false;
        return {ok: items >= 1 && cur >= 1 && add, detail: 'items='+items+' current='+cur+' add='+add};`, 6e3);
      if (!w[0]) return w;
      await shot("ws-menu");
      await js(`(function(){ var it=document.querySelector('.ws-menu-item'); if(it) it.click(); })()`);
      const closed = await waitFor("menu closed + session active", `var ta=document.querySelector('.composer textarea');
        return {ok: !document.querySelector('.ws-menu') && !!ta && ta.disabled === false, detail: 'menu='+(document.querySelector('.ws-menu')?'open':'closed')+' ta='+(ta?ta.disabled:'none')};`, 6e3);
      return [closed[0], `${w[1]}; ${closed[1]}`];
    });
    await step("\u4F1A\u8BDD\u5206\u7EC4:\u7EC4\u5934\u51FA\u73B0(\u5DE5\u4F5C\u533A\u540D+\u6570\u91CF)", async () => {
      return waitFor("group head", `var h=document.querySelector('.ws-group-head');
        var n = h ? (h.querySelector('.ws-group-name')||{}).textContent : '';
        var c = h ? (h.querySelector('.ws-group-count')||{}).textContent : '';
        return {ok: !!h && n.length > 0 && c.length > 0, detail: 'name='+n+' count='+c};`, 8e3);
    });
    await step("\u4F1A\u8BDD\u5206\u7EC4:\u70B9\u51FB\u7EC4\u5934\u6536\u8D77,\u518D\u70B9\u5C55\u5F00\u6062\u590D", async () => {
      const before = await js(`document.querySelectorAll('.session-item').length`);
      if (before === 0) return [false, "no sessions to group"];
      await js(`(function(){ var h=document.querySelector('.ws-group-head'); if(h) h.click(); })()`);
      const collapsed = await waitFor("collapsed", `var g=document.querySelector('.ws-group');
        var hidden = document.querySelectorAll('.session-item').length < ${before};
        return {ok: hidden, detail: 'items='+document.querySelectorAll('.session-item').length+' before=${before}'};`, 5e3);
      await shot("ws-group-collapsed");
      await js(`(function(){ var h=document.querySelector('.ws-group-head'); if(h) h.click(); })()`);
      const expanded = await waitFor("expanded back", `var n=document.querySelectorAll('.session-item').length;
        return {ok: n >= ${before}, detail: 'items='+n};`, 5e3);
      return [collapsed[0] && expanded[0], `collapse: ${collapsed[1]}; expand: ${expanded[1]}`];
    });
    await step("\u5FEB\u6377\u952E\u5E2E\u52A9:Ctrl+/ \u6253\u5F00,Esc \u5173\u95ED", async () => {
      await js(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'/', ctrlKey:true, bubbles:true}))`);
      const w = await waitFor("shortcuts open", `var s=document.querySelector('.cmdk');
        var rows = s ? s.querySelectorAll('.shortcut-row').length : 0;
        return {ok: rows >= 5, detail: 'rows='+rows};`, 5e3);
      if (!w[0]) return w;
      await shot("shortcuts");
      await js(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
      return waitFor("shortcuts closed", `return {ok: !document.querySelector('.cmdk-overlay'), detail: 'closed'};`, 5e3);
    });
    await step("\u4FA7\u680F\u6536\u7F29:\u21E4 \u6536\u8D77\u5DE6\u680F,\u21E5 \u5C55\u5F00\u6062\u590D", async () => {
      const w = await waitFor("toggle btn", `var b=[].slice.call(document.querySelectorAll('.topbar button')).find(function(x){return x.textContent.trim()==='\u21E4'||x.textContent.trim()==='\u21E5';});
        return {ok: !!b, detail: 'btn='+(b?b.textContent.trim():'none')};`, 5e3);
      if (!w[0]) return w;
      await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.topbar button')).find(function(x){return x.textContent.trim()==='\u21E4'||x.textContent.trim()==='\u21E5';}); if(b) b.click(); })()`);
      const hidden = await waitFor("sidebar hidden", `var sb=document.querySelector('.sidebar');
        var gone = !sb || getComputedStyle(sb).display === 'none';
        return {ok: gone, detail: 'display='+(sb?getComputedStyle(sb).display:'none')};`, 5e3);
      await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.topbar button')).find(function(x){return x.textContent.trim()==='\u21E4'||x.textContent.trim()==='\u21E5';}); if(b) b.click(); })()`);
      const shown = await waitFor("sidebar back", `var sb=document.querySelector('.sidebar');
        return {ok: !!sb && getComputedStyle(sb).display !== 'none', detail: 'display='+(sb?getComputedStyle(sb).display:'none')};`, 5e3);
      return [hidden[0] && shown[0], `hide: ${hidden[1]}; show: ${shown[1]}`];
    });
    await step('\u72B6\u6001\u8FC7\u6EE4:\u4E0B\u62C9\u5207\u6362\u5230"\u8FD0\u884C\u4E2D"\u4E0D\u5D29\u6E83\u5E76\u6062\u590D', async () => {
      const sel = await waitFor("filter select", `var s=document.querySelector('.status-filter');
        return {ok: !!s && s.options.length >= 4, detail: 'options='+(s?s.options.length:0)};`, 5e3);
      if (!sel[0]) return sel;
      await js(`(function(){ var s=document.querySelector('.status-filter'); s.value='running'; s.dispatchEvent(new Event('change',{bubbles:true})); })()`);
      await sleep(500);
      const r1 = await js(`document.querySelectorAll('.session-item').length`);
      await js(`(function(){ var s=document.querySelector('.status-filter'); s.value='all'; s.dispatchEvent(new Event('change',{bubbles:true})); })()`);
      await sleep(500);
      const r2 = await js(`document.querySelectorAll('.session-item').length`);
      return [r2 >= r1 && r2 >= 1, `running=${r1} all=${r2}`];
    });
    await step("\u6A21\u578B\u9009\u62E9\u5668:\u9876\u680F\u83DC\u5355\u5217\u51FA providers \u5E76\u53EF\u5207\u6362", async () => {
      const w = await waitFor("model button", `var b=document.querySelector('.topbar-model.as-button');
        return {ok: !!b && b.disabled === false, detail: b ? b.textContent : 'none'};`, 6e3);
      if (!w[0]) return w;
      await js(`(function(){ var b=document.querySelector('.topbar-model.as-button'); if(b) b.click(); })()`);
      const m = await waitFor("model menu", `var m=document.querySelector('.model-menu');
        var items = m ? m.querySelectorAll('.ws-menu-item').length : 0;
        var cur = m ? m.querySelectorAll('.ws-menu-item.current').length : 0;
        return {ok: items >= 2 && cur >= 1, detail: 'items='+items+' current='+cur};`, 5e3);
      if (!m[0]) return m;
      await shot("model-menu");
      await js(`(function(){ var its=[].slice.call(document.querySelectorAll('.model-menu .ws-menu-item')); var it=its[its.length-1]; if(it) it.click(); })()`);
      return waitFor("model switched", `var b=document.querySelector('.topbar-model.as-button');
        return {ok: !!b && b.textContent.indexOf('fake-m-vision') >= 0, detail: 'badge='+(b?b.textContent:'none')};`, 6e3);
    });
    await step("\u4E3B\u9898:\u8BBE\u7F6E\u5207\u6D45\u8272\u751F\u6548,\u6062\u590D\u6DF1\u8272", async () => {
      await js(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'p', ctrlKey:true, shiftKey:true, bubbles:true}))`);
      const w = await waitFor("settings open", `var s=document.querySelector('.cmdk.settings');
        return {ok: !!s, detail: s ? 'open' : 'not open'};`, 5e3);
      if (!w[0]) return w;
      await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.cmdk.settings .seg button')).find(function(x){return x.textContent.trim()==='\u6D45\u8272'||x.textContent.trim()==='Light';}); if(b) b.click(); })()`);
      const light = await waitFor("light theme", `var dt=document.documentElement.dataset.theme;
        var bg = getComputedStyle(document.body).backgroundColor;
        var m = /\\d+/g; var nums=(bg.match(m)||['0','0','0']).map(Number);
        return {ok: dt==='light' && nums[0]>200 && nums[1]>200 && nums[2]>200, detail: 'theme='+dt+' bg='+bg};`, 5e3);
      await shot("light-theme");
      await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.cmdk.settings .seg button')).find(function(x){return x.textContent.trim()==='\u6DF1\u8272'||x.textContent.trim()==='Dark';}); if(b) b.click(); })()`);
      const dark = await waitFor("dark back", `return {ok: document.documentElement.dataset.theme==='dark', detail: 'theme='+document.documentElement.dataset.theme};`, 5e3);
      await js(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
      return [light[0] && dark[0], `light: ${light[1]}; dark: ${dark[1]}`];
    });
    await step("\u9876\u680F\u5FEB\u6377\u5207\u6362:\u4E2D/EN \u4E00\u952E\u5207\u6362", async () => {
      const w = await waitFor("lang seg", `var s=document.querySelector('.lang-seg');
        return {ok: !!s && s.querySelectorAll('button').length === 2, detail: s ? 'present' : 'absent'};`, 5e3);
      if (!w[0]) return w;
      await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.lang-seg button')).find(function(x){return x.textContent.trim()==='EN';}); if(b) b.click(); })()`);
      const en = await waitFor("english", `var b=document.querySelector('.sidebar-head .btn.primary');
        return {ok: !!b && b.textContent === '+ New Session', detail: 'btn='+(b?b.textContent:'none')};`, 5e3);
      await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.lang-seg button')).find(function(x){return x.textContent.trim()==='\u4E2D';}); if(b) b.click(); })()`);
      const zh = await waitFor("chinese back", `var b=document.querySelector('.sidebar-head .btn.primary');
        return {ok: !!b && b.textContent === '+ \u65B0\u5EFA\u4F1A\u8BDD', detail: 'btn='+(b?b.textContent:'none')};`, 5e3);
      return [en[0] && zh[0], `en: ${en[1]}; zh: ${zh[1]}`];
    });
    await step("\u7C98\u8D34\u56FE\u7247:\u7F29\u7565\u56FE chip + \u53D1\u9001\u540E runtime \u6536\u5230\u56FE\u7247", async () => {
      await js(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'n', ctrlKey:true, bubbles:true}))`);
      await sleep(300);
      await js(`(function(){
        var ta = document.querySelector('.composer textarea');
        if (!ta) return;
        var c = document.createElement('canvas');
        c.width = 8; c.height = 8;
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#3f9650'; ctx.fillRect(0, 0, 8, 8);
        c.toBlob(function(blob){
          var dt = new DataTransfer();
          dt.items.add(new File([blob], 'pasted.png', {type: 'image/png'}));
          ta.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true}));
        }, 'image/png');
      })()`);
      const chip = await waitFor("image chip", `var n=document.querySelectorAll('.att-chip.img').length;
        return {ok: n >= 1, detail: 'img chips='+n};`, 6e3);
      if (!chip[0]) return chip;
      await typeInto(".composer textarea", "\u770B\u8FD9\u5F20\u56FE");
      await sleep(200);
      await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.composer button')).find(function(x){return x.textContent.trim()==='\u53D1\u9001';}); if(b) b.click(); })()`);
      const done = await waitFor("image sent", `
        var ap = document.querySelector('.approval-card button');
        if (ap && ap.textContent.trim().indexOf('\u6279\u51C6')>=0) ap.click();
        var ts=[].slice.call(document.querySelectorAll('.turn'));
        var hit = ts.filter(function(x){ return x.className.indexOf('user')<0 && x.textContent.indexOf('[images: 1]') >= 0; });
        return {ok: hit.length >= 1, detail: 'runtime-echo-with-image='+hit.length};
      `, 15e3);
      await shot("pasted-image");
      return done;
    });
    await step("\u9644\u4EF6\u4E0E\u76EE\u5F55\u5165\u53E3:\u{1F4CE} \u4E0A\u4F20 + \u{1F4C1} \u6D4F\u89C8\u6309\u94AE\u5B58\u5728", async () => {
      const r = await js(`(function(){
        var up = document.querySelector('.composer button[aria-label*="\u4E0A\u4F20"], .composer button[aria-label*="Upload"]');
        var br = document.querySelector('.ws-picker button');
        return JSON.stringify({up: !!up, browse: !!br});
      })()`);
      const p = JSON.parse(r);
      return [p.up && p.browse, `\u{1F4CE}=${p.up} \u{1F4C1}=${p.browse}`];
    });
    await step("@ \u9644\u4EF6:\u9009\u62E9\u5668\u51FA\u73B0\u5E76\u53EF\u9009\u6587\u4EF6", async () => {
      await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.composer button')).find(function(x){return x.textContent.trim()==='@';}); if(b) b.click(); })()`);
      const w = await waitFor("att picker", `var p=document.querySelector('.att-picker');
        return {ok: !!p, detail: p ? 'open' : 'not open'};`, 5e3);
      if (!w[0]) return w;
      await typeInto(".att-picker input", "read");
      const w2 = await waitFor("att results", `var r=document.querySelectorAll('.att-results .fs-row').length;
        return {ok: r >= 1, detail: 'results='+r};`, 6e3);
      if (!w2[0]) return w2;
      await js(`(function(){ var f=document.querySelector('.att-results .fs-row'); if(f) f.click(); })()`);
      return waitFor("att chip", `var c=document.querySelectorAll('.att-chip').length;
        return {ok: c >= 1, detail: 'chips='+c};`, 5e3);
    });
    await shot("final");
  } else {
    await step("\u9876\u680F:runtime \u7248\u672C\u4E0E\u7AEF\u53E3\u5DF2\u663E\u793A(\u975E ?)", async () => {
      return waitFor("host label", `var l=document.querySelector('.host-label');
        var t = l ? l.textContent : '';
        return {ok: t.indexOf('?') < 0 && t.indexOf('runtime') >= 0, detail: t.replace(/\\s+/g,' ').slice(0,60)};`, 15e3);
    });
    await step("\u4F1A\u8BDD\u5217\u8868:\u771F\u5B9E\u5386\u53F2\u52A0\u8F7D(\u6570\u91CF>0)", async () => {
      return waitFor("sessions", `var n=document.querySelectorAll('.session-item').length;
        return {ok: n > 0, detail: 'sessions='+n};`, 15e3);
    });
    await step("\u70B9\u51FB\u5386\u53F2\u4F1A\u8BDD \u2192 \u771F\u5B9E transcript \u5185\u5BB9\u53EF\u89C1", async () => {
      const n = await js(`document.querySelectorAll('.session-item').length`);
      if (n === 0) return [false, "no sessions to click"];
      await js(`(function(){ var it=document.querySelector('.session-item'); if (it) it.click(); })()`);
      const w = await waitFor("history turns", `var ts=[].slice.call(document.querySelectorAll('.turn'));
        return {ok: ts.length >= 1, detail: 'turns='+ts.length+' first='+(ts[0]?ts[0].textContent.replace(/\\s+/g,' ').slice(0,40):'none')};`, 15e3);
      await shot("real-history");
      return w;
    });
    await step("Dock:Overview \u771F\u5B9E\u6570\u636E(runtime \u7248\u672C\u975E\u65E0\u6570\u636E)", async () => {
      await js(`(function(){ var t=[].slice.call(document.querySelectorAll('.dock-tab')).find(function(x){return x.textContent==='Overview';}); if(t) t.click(); })()`);
      return waitFor("overview", `var rows=[].slice.call(document.querySelectorAll('.dock-row'));
        var ver = rows.find(function(r){ return r.textContent.indexOf('runtime \u7248\u672C')>=0; });
        return {ok: !!ver && ver.textContent.indexOf('\u65E0\u6570\u636E') < 0, detail: ver ? ver.textContent.replace(/\\s+/g,' ').slice(0,50) : 'no ver row'};`, 1e4);
    });
    await step("Dock:Diff \u771F\u5B9E git \u72B6\u6001(\u975E\u52A0\u8F7D\u4E2D)", async () => {
      await js(`(function(){ var t=[].slice.call(document.querySelectorAll('.dock-tab')).find(function(x){return x.textContent==='\u53D8\u66F4'||x.textContent==='Diff';}); if(t) t.click(); })()`);
      return waitFor("diff", `var p=document.querySelector('.diff-pane');
        var t = p ? p.textContent : '';
        return {ok: !!p && t.indexOf('\u52A0\u8F7D\u4E2D') < 0, detail: t.replace(/\\s+/g,' ').slice(0,60)};`, 15e3);
    });
    await step("Dock:Evidence \u771F\u5B9E\u8BA4\u77E5\u6570\u636E", async () => {
      await js(`(function(){ var t=[].slice.call(document.querySelectorAll('.dock-tab')).find(function(x){return x.textContent==='\u8BC1\u636E'||x.textContent==='Evidence';}); if(t) t.click(); })()`);
      return waitFor("evidence", `var rows=[].slice.call(document.querySelectorAll('.dock-row'));
        var mem = rows.find(function(r){ return r.textContent.indexOf('\u8BB0\u5FC6\u5C42')>=0 || r.textContent.indexOf('Memory layers')>=0; });
        return {ok: !!mem && mem.textContent.indexOf('\u2026') < 0, detail: mem ? mem.textContent.replace(/\\s+/g,' ').slice(0,50) : 'no row'};`, 15e3);
    });
    await step("\u9644\u4EF6\u4E0E\u76EE\u5F55\u5165\u53E3:\u{1F4CE} \u4E0A\u4F20 + \u9876\u680F\u4E2D/EN + \u{1F4C1} \u6D4F\u89C8\u6309\u94AE\u5B58\u5728", async () => {
      await js(`(function(){ var t=[].slice.call(document.querySelectorAll('.dock-tab')).find(function(x){return x.textContent==='\u6587\u4EF6'||x.textContent==='Files';}); if(t) t.click(); })()`);
      await waitFor("files tab", `var t=document.querySelector('.dock-tab.active');
        return {ok: !!t && (t.textContent==='\u6587\u4EF6'||t.textContent==='Files'), detail: 'active='+(t?t.textContent:'none')};`, 5e3);
      const ws = await waitFor("ws picker", `var w=document.querySelector('.ws-picker');
        return {ok: !!w, detail: w ? 'loaded' : 'workspaces not loaded yet'};`, mode === "real" ? 15e3 : 6e3);
      const r = await js(`(function(){
        var up = document.querySelector('.composer button[aria-label*="\u4E0A\u4F20"], .composer button[aria-label*="Upload"]');
        var lang = document.querySelector('.lang-seg');
        var br = document.querySelector('.ws-picker button');
        return JSON.stringify({up: !!up, lang: !!lang, browse: !!br});
      })()`);
      const p = JSON.parse(r);
      return [p.up && p.lang && p.browse, `\u{1F4CE}=${p.up} \u4E2D/EN=${p.lang} \u{1F4C1}=${p.browse}; ${ws[1]}`];
    });
    if (process.env.HMH_DESKTOP_UIVERIFY_REAL_TASK === "1") {
      await step("\u771F\u5B9E\u4EFB\u52A1:\u53D1\u9001\u2192\u6A21\u578B\u56DE\u590D(\u7AEF\u5230\u7AEF\u9996\u9A8C)", async () => {
        await js(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'n', ctrlKey:true, bubbles:true}))`);
        await sleep(400);
        await typeInto(".composer textarea", "\u8BF7\u53EA\u56DE\u590D\u4E24\u4E2A\u5B57:\u6536\u5230(\u672C\u6B21\u9A8C\u6536\u4EFB\u52A1,\u4E0D\u8981\u4F7F\u7528\u4EFB\u4F55\u5DE5\u5177,\u76F4\u63A5\u56DE\u590D)");
        await sleep(200);
        await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.composer button')).find(function(x){return x.textContent.trim()==='\u53D1\u9001';}); if(b) b.click(); })()`);
        const sent = await waitFor("user turn", `var t=document.querySelector('.turn.user');
          var s = (t && t.textContent) ? String(t.textContent) : '';
          return {ok: s.indexOf('\u6536\u5230')>=0 || s.indexOf('\u9A8C\u6536\u4EFB\u52A1')>=0, detail: s.slice(0,30) || 'none'};`, 1e4);
        if (!sent[0]) return sent;
        const reply = await waitFor("assistant reply", `
          var ap = document.querySelector('.approval-card button');
          if (ap && ap.textContent.trim().indexOf('\u6279\u51C6')>=0) ap.click();
          var ts=[].slice.call(document.querySelectorAll('.turn')).filter(function(x){ return x.className.indexOf('user')<0 && x.className.indexOf('approval')<0 && x.className.indexOf('system')<0 && x.textContent.trim().length>0 && x.textContent.indexOf('\u56DE\u5408')<0; });
          var sum = document.querySelector('.turn-sum');
          return {ok: ts.length>=1 && !!sum, detail: 'assistant='+ts.length+' sum='+(sum?sum.textContent:'none')+' first='+(ts[0]?ts[0].textContent.replace(/\\s+/g,' ').slice(0,40):'none')};
        `, 15e4);
        await shot("real-task");
        return reply;
      });
    }
    await step("\u4F1A\u8BDD\u5206\u7EC4:\u5DE6\u680F\u6309\u5DE5\u4F5C\u533A\u5206\u7EC4(\u7EC4\u5934\u53EF\u89C1)", async () => {
      return waitFor("group head", `var h=document.querySelector('.ws-group-head');
        var n = h ? (h.querySelector('.ws-group-name')||{}).textContent : '';
        return {ok: !!h && n.length > 0, detail: 'name='+n};`, 15e3);
    });
    await step("\u5DE5\u4F5C\u533A:\u5DE6\u680F\u5DE5\u4F5C\u533A\u680F\u53EF\u89C1(\u771F\u5B9E\u5DE5\u4F5C\u533A\u540D)", async () => {
      return waitFor("workspace bar", `var b=document.querySelector('.workspace-bar');
        var n = b ? (b.querySelector('.ws-bar-name')||{}).textContent : '';
        return {ok: !!b && !!n && n.length > 0 && n.indexOf('\u52A0\u8F7D') < 0 && n.indexOf('Loading') < 0, detail: 'name='+n};`, 15e3);
    });
    await shot("final");
  }
  const failed = results.filter((r) => !r[1]).length;
  console.log(`UIVERIFY SUMMARY pass=${results.length - failed}/${results.length} mode=${mode} shots=${shots}`);
  app.exit(failed === 0 ? 0 : 1);
}
function attachUiVerify(win) {
  const mode = process.env.HMH_DESKTOP_UIVERIFY_MODE === "real" ? "real" : "fake";
  win.webContents.once("did-finish-load", () => {
    setTimeout(() => {
      void runUiVerify(win, mode);
    }, 3e3);
  });
}

// apps/desktop/electron/main/index.ts
var here = import.meta.dirname ?? ".";
var isDev = process.env.HMH_DESKTOP_DEV === "1";
var rendererDevUrl = process.env.HMH_DESKTOP_RENDERER_URL ?? "";
var preloadPath = join2(here, "../preload/index.cjs");
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
if (!app2.requestSingleInstanceLock()) {
  app2.quit();
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
    notifyEvent2(env);
  }, focusMainWindow2 = function() {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (win === void 0) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }, setupTray2 = function() {
    if (tray !== null) return;
    const icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_BASE64}`);
    tray = new Tray(icon);
    tray.setToolTip("HMH Desktop");
    tray.on("click", focusMainWindow2);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "\u65B0\u5EFA\u4F1A\u8BDD", click: () => sendMenuAction("new-session") },
      { label: "\u663E\u793A\u4E3B\u7A97\u53E3", click: focusMainWindow2 },
      { label: "\u624B\u673A\u8FDC\u7A0B\u63A7\u5236", click: () => sendMenuAction("open-remote") },
      { label: "\u8BBE\u7F6E", click: () => sendMenuAction("open-settings") },
      { type: "separator" },
      { label: "\u9000\u51FA", click: () => {
        app2.quit();
      } }
    ]));
  }, notifyEvent2 = function(env) {
    if (process.env.HMH_DESKTOP_UIVERIFY === "1" || process.env.HMH_DESKTOP_SNAPSHOT !== void 0 || process.env.HMH_DESKTOP_RENDER_TEST === "1") return;
    if (!Notification.isSupported()) return;
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    const focused = win?.isFocused() ?? false;
    const mk = (title, body) => {
      const n = new Notification({ title, body, icon: nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_BASE64}`) });
      n.on("click", focusMainWindow2);
      n.show();
    };
    if (env.kind === "approval.required") {
      const p = env.payload;
      mk("HMH \u9700\u8981\u5BA1\u6279", `${String(p.tool ?? "\u64CD\u4F5C")} \u7B49\u5F85\u4F60\u7684\u6279\u51C6`);
    } else if (env.kind === "run.completed" && !focused) {
      mk("HMH \u4EFB\u52A1\u5B8C\u6210", `\u4F1A\u8BDD ${env.sessionId} \u7684\u4EFB\u52A1\u5DF2\u5B8C\u6210`);
    } else if (env.kind === "run.failed" && !focused) {
      mk("HMH \u4EFB\u52A1\u5931\u8D25", `\u4F1A\u8BDD ${env.sessionId} \u7684\u4EFB\u52A1\u5931\u8D25,\u70B9\u51FB\u67E5\u770B`);
    }
  }, applyChrome2 = function(dark) {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) {
        try {
          w.setTitleBarOverlay(chromeFor(dark));
        } catch {
        }
      }
    }
  }, applyUpdate2 = function() {
    if (installerPath === null) return;
    const installDir = dirname(process.execPath);
    const child = spawn2(`"${installerPath}" /S /D=${installDir}`, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: false,
      windowsVerbatimArguments: true
    });
    child.unref();
    logInfo("update", `apply: ${installerPath} \u2192 ${installDir}`);
    app2.exit(0);
  }, buildAppMenu2 = function() {
    const template = [
      {
        label: "\u7F16\u8F91",
        submenu: [
          { role: "undo", label: "\u64A4\u9500" },
          { role: "redo", label: "\u91CD\u505A" },
          { type: "separator" },
          { role: "cut", label: "\u526A\u5207" },
          { role: "copy", label: "\u590D\u5236" },
          { role: "paste", label: "\u7C98\u8D34" },
          { role: "selectAll", label: "\u5168\u9009" }
        ]
      },
      {
        label: "\u7A97\u53E3",
        submenu: [
          { role: "minimize", label: "\u6700\u5C0F\u5316" },
          { role: "zoom", label: "\u7F29\u653E" },
          { type: "separator" },
          { role: "close", label: "\u5173\u95ED" }
        ]
      }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }, popupMainMenu2 = function() {
    const send = (a) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send("menu:action", a);
      }
    };
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (win === void 0) return;
    Menu.buildFromTemplate([
      { label: "\u65B0\u5EFA\u4F1A\u8BDD", accelerator: "CmdOrCtrl+N", click: () => send("new-session") },
      { label: "\u8BBE\u7F6E", accelerator: "CmdOrCtrl+Shift+P", click: () => send("open-settings") },
      { label: "\u5FEB\u6377\u952E", accelerator: "CmdOrCtrl+/", click: () => send("shortcuts") },
      { type: "separator" },
      { label: "\u624B\u673A\u8FDC\u7A0B\u63A7\u5236", click: () => send("open-remote") },
      { type: "separator" },
      {
        label: updateState.downloaded ? `\u91CD\u542F\u5E76\u5B89\u88C5\u66F4\u65B0(v${updateState.latest ?? "?"})` : "\u68C0\u67E5\u66F4\u65B0\u2026",
        click: () => {
          if (updateState.downloaded) {
            applyUpdate2();
            return;
          }
          void checkForUpdates().then((st) => {
            const newer = st.latest !== null && cmpVersion(st.currentVersion, st.latest) < 0;
            const detail = newer ? `${st.notes}

\u5B89\u88C5\u5305\u6B63\u5728\u540E\u53F0\u4E0B\u8F7D,\u5B8C\u6210\u540E \u2630 \u83DC\u5355\u4F1A\u51FA\u73B0"\u91CD\u542F\u5E76\u5B89\u88C5\u66F4\u65B0"\u3002` : "";
            void dialog.showMessageBox(win, {
              type: "info",
              title: "\u68C0\u67E5\u66F4\u65B0",
              message: newer ? `\u53D1\u73B0\u65B0\u7248\u672C v${st.latest}!` : st.error !== "" ? `\u68C0\u67E5\u5931\u8D25:${st.error}` : `\u5DF2\u662F\u6700\u65B0\u7248\u672C(v${st.currentVersion})`,
              detail
            });
          });
        }
      },
      {
        label: "\u5173\u4E8E HMH Desktop",
        click: () => {
          void dialog.showMessageBox(win, {
            type: "info",
            title: "\u5173\u4E8E HMH Desktop",
            message: "HMH Desktop",
            detail: `\u672C\u5730\u4F18\u5148\u7684 HMH Agent \u56FE\u5F62\u5DE5\u4F5C\u53F0 v${app2.getVersion()}
runtime: hmharness ${bridge.hostVersion ?? "(\u672A\u8FDE\u63A5)"}${useBundledRuntime ? "(\u5185\u7F6E)" : ""}
\u6A21\u5F0F: ${bridge.mode === "real" ? useBundledRuntime ? "\u771F\u5B9E hmharness(\u5185\u7F6E runtime)" : "\u771F\u5B9E hmharness(\u5916\u90E8\u5B89\u88C5)" : "\u6F14\u793A(\u5047\u6570\u636E)"}

\u4E0E CLI / TUI / \u7F51\u9875\u7248\u5171\u4EAB\u540C\u4E00 HMH_HOME\u3002`
          });
        }
      },
      { label: "\u9000\u51FA", role: "quit" }
    ]).popup({ window: win });
  }, webAutostartInstalled2 = function() {
    const home = process.env.HOME ?? "";
    const candidates = process.platform === "win32" ? [join2(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "hmharness-web-daemon.cmd")] : process.platform === "darwin" ? [join2(home, "Library", "LaunchAgents", "hmharness-web-daemon.plist")] : [join2(home, ".config", "systemd", "user", "hmharness-web-daemon.service")];
    return candidates.some((p) => {
      try {
        return existsSync(p);
      } catch {
        return false;
      }
    });
  }, lanIpOf2 = function() {
    const VIRTUAL = /vmware|virtual|hyper-?v|vethernet|wsl|tailscale|loopback|bluetooth|vbox|docker|tap-|pseudo/i;
    const isRfc1918 = (a) => /^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a);
    let lanIp = "";
    let fallback = "";
    for (const [name, list] of Object.entries(networkInterfaces())) {
      for (const n of list ?? []) {
        if (n.family !== "IPv4" || n.internal || !isRfc1918(n.address)) continue;
        if (!VIRTUAL.test(name)) lanIp = lanIp || n.address;
        else fallback = fallback || n.address;
      }
    }
    return lanIp || fallback;
  }, cliEntryOf2 = function() {
    if (runtimeEntry === null) return "";
    try {
      const p = join2(repoRootOf2(runtimeEntry), "packages", "cli", "src", "main.ts");
      return existsSync(p) ? p : "";
    } catch {
      return "";
    }
  }, runCli2 = function(args) {
    const entry = cliEntryOf2();
    if (entry === "") return;
    const repo = repoRootOf2(runtimeEntry ?? entry);
    const child = spawn2(process.execPath, ["--import", "tsx", entry, ...args], {
      cwd: repo,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ELECTRON_RUN_AS_NODE: "1" }
    });
    child.unref();
  }, broadcastHostState2 = function(s, info) {
    bridge = { ...bridge, hostState: s, hostPort: supervisor?.endpoint?.port ?? null, hostVersion: supervisor?.endpoint?.version ?? null };
    logInfo("host", `state=${s}${info.lastError !== void 0 ? ` err=${info.lastError}` : ""}`);
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send("bridge:host-state", s, info);
    }
  }, detectRealEntry2 = function() {
    const envEntry = process.env.HMH_DESKTOP_REAL_ENTRY;
    if (envEntry !== void 0 && envEntry !== "" && isAbsolute(envEntry)) return envEntry;
    const repos = /* @__PURE__ */ new Set();
    try {
      const out = execFileSync("where", ["hmh"], { encoding: "utf8", timeout: 4e3, windowsHide: true });
      for (const line of out.split(/\r?\n/)) {
        const bin = line.trim();
        if (bin === "") continue;
        try {
          const linked = join2(dirname(bin), "node_modules", "hmharness");
          if (existsSync(linked)) repos.add(realpathSync2(linked));
        } catch {
        }
      }
    } catch {
    }
    try {
      const out = execFileSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 6e3, windowsHide: true });
      const p = join2(out.trim(), "hmharness");
      if (existsSync(p)) repos.add(realpathSync2(p));
    } catch {
    }
    const bases = ["C:\\", "D:\\", "E:\\", "F:\\", "G:\\", "H:\\", homedir(), join2(homedir(), "Developer")];
    for (const base of bases) {
      try {
        const p = resolve(base, "hmharness");
        if (existsSync(p)) repos.add(p);
      } catch {
      }
    }
    for (const repo of repos) {
      const entry = join2(repo, "packages", "web", "src", "desktop-host.ts");
      if (existsSync(entry) && existsSync(join2(repo, "node_modules"))) return entry;
    }
    return "";
  }, repoRootOf2 = function(entry) {
    let dir = dirname(entry);
    for (let i = 0; i < 6; i++) {
      if (existsSync(join2(dir, "package.json")) && existsSync(join2(dir, "packages", "web"))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return dirname(entry);
  }, bundledRuntimePath2 = function(repoRoot) {
    return join2(app2.isPackaged ? process.resourcesPath : join2(repoRoot, "apps", "desktop", "resources"), "runtime", "runtime.cjs");
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
    ipcMain.handle("bridge:send-task", (event, text, sessionId, mode, attachments, images) => {
      const task = typeof text === "string" ? text.slice(0, 2e4) : "";
      const sid = typeof sessionId === "string" ? sessionId.slice(0, 80) : "";
      const m = mode === "auto" || mode === "yolo" ? mode : "ask";
      const atts = Array.isArray(attachments) ? attachments.filter((a) => typeof a === "string").slice(0, 10) : [];
      const imgs = Array.isArray(images) ? images.filter((im) => typeof im === "object" && im !== null && typeof im.name === "string" && typeof im.dataUrl === "string").slice(0, 3).map((im) => ({ name: im.name.slice(0, 120), dataUrl: im.dataUrl.slice(0, 85e5) })) : [];
      if (task === "" || sid === "") return Promise.resolve({ ok: false, code: "BAD_REQUEST" });
      return hostCall2(event, (c) => c.postJson("/api/task", { text: task, sessionId: sid, mode: m, attachments: atts, images: imgs }));
    });
    ipcMain.handle("bridge:model-set", (event, name) => {
      const n = typeof name === "string" ? name.trim().slice(0, 80) : "";
      if (n === "") return Promise.resolve({ error: "name required", code: "BAD_REQUEST" });
      return hostCall2(event, (c) => c.postJson("/api/model", { name: n }));
    });
    ipcMain.handle("bridge:check-update", async (event) => {
      if (!senderTrusted2(event.senderFrame)) return { error: "untrusted sender", code: "FORBIDDEN" };
      return checkForUpdates();
    });
    ipcMain.handle("bridge:apply-update", (event) => {
      if (!senderTrusted2(event.senderFrame)) return { error: "untrusted sender", code: "FORBIDDEN" };
      if (installerPath === null) return { error: "no installer downloaded", code: "HOST_NOT_READY" };
      applyUpdate2();
      return { ok: true };
    });
    ipcMain.handle("bridge:chrome-theme", (event, dark) => {
      if (!senderTrusted2(event.senderFrame)) return { error: "untrusted sender", code: "FORBIDDEN" };
      applyChrome2(dark === true);
      return { ok: true };
    });
    ipcMain.handle("bridge:popup-main-menu", (event) => {
      if (!senderTrusted2(event.senderFrame)) return { error: "untrusted sender", code: "FORBIDDEN" };
      popupMainMenu2();
      return { ok: true };
    });
    ipcMain.handle("bridge:remote-web-status", async (event) => {
      if (!senderTrusted2(event.senderFrame)) return { error: "untrusted sender", code: "FORBIDDEN" };
      const p = await probeWebRemote();
      return { up: p.up, version: p.version, lanIp: lanIpOf2(), port: WEB_PORT, available: cliEntryOf2() !== "", autostart: webAutostartInstalled2() };
    });
    ipcMain.handle("bridge:remote-web-autostart", async (event, enabled) => {
      if (!senderTrusted2(event.senderFrame)) return { error: "untrusted sender", code: "FORBIDDEN" };
      if (cliEntryOf2() === "") return { error: "no hmharness runtime detected", code: "HOST_NOT_READY" };
      runCli2(["web", enabled === true ? "install-daemon" : "uninstall-daemon"]);
      if (enabled === true) {
        for (let i = 0; i < 50; i++) {
          await new Promise((r) => setTimeout(r, 500));
          if ((await probeWebRemote()).up) return { ok: true, autostart: webAutostartInstalled2() };
        }
        return { error: "daemon did not come up within 25s", code: "RUNTIME_CRASHED" };
      }
      return { ok: true, autostart: webAutostartInstalled2() };
    });
    ipcMain.handle("bridge:remote-web-start", async (event) => {
      if (!senderTrusted2(event.senderFrame)) return { error: "untrusted sender", code: "FORBIDDEN" };
      if (cliEntryOf2() === "") return { error: "no hmharness runtime detected", code: "HOST_NOT_READY" };
      if ((await probeWebRemote()).up) {
        return { ok: true, already: true, lanUrl: `http://${lanIpOf2() || "127.0.0.1"}:${WEB_PORT}` };
      }
      runCli2(["web", "start", "--exposure=lan"]);
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if ((await probeWebRemote()).up) {
          return { ok: true, lanUrl: `http://${lanIpOf2() || "127.0.0.1"}:${WEB_PORT}` };
        }
      }
      return { error: "web daemon did not come up within 25s (see HMH_HOME/web.log)", code: "RUNTIME_CRASHED" };
    });
    ipcMain.handle("bridge:remote-web-stop", async (event) => {
      if (!senderTrusted2(event.senderFrame)) return { error: "untrusted sender", code: "FORBIDDEN" };
      runCli2(["web", "stop"]);
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 400));
        if (!(await probeWebRemote()).up) return { ok: true };
      }
      const still = (await probeWebRemote()).up;
      return still ? { error: "still running", code: "BRIDGE_ERROR" } : { ok: true };
    });
    ipcMain.handle("bridge:pick-files", async (event, title) => {
      if (!senderTrusted2(event.senderFrame)) return { error: "untrusted sender", code: "FORBIDDEN" };
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
      if (win === void 0) return { error: "no window", code: "BRIDGE_ERROR" };
      const r = await dialog.showOpenDialog(win, {
        title: typeof title === "string" && title !== "" ? title.slice(0, 120) : "\u9009\u62E9\u8981\u9644\u52A0\u7684\u6587\u4EF6(\u53EF\u591A\u9009)",
        properties: ["openFile", "multiSelections"]
      });
      if (r.canceled || r.filePaths.length === 0) return { ok: false, canceled: true };
      return { ok: true, paths: r.filePaths.slice(0, 10) };
    });
    ipcMain.handle("bridge:pick-directory", async (event, title) => {
      if (!senderTrusted2(event.senderFrame)) return { error: "untrusted sender", code: "FORBIDDEN" };
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
      if (win === void 0) return { error: "no window", code: "BRIDGE_ERROR" };
      const r = await dialog.showOpenDialog(win, {
        title: typeof title === "string" && title !== "" ? title.slice(0, 120) : "\u9009\u62E9\u6587\u4EF6\u5939",
        properties: ["openDirectory"]
      });
      if (r.canceled || r.filePaths[0] === void 0) return { ok: false, canceled: true };
      return { ok: true, path: r.filePaths[0] };
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
    ipcMain.handle("bridge:export-session", async (event, id, title) => {
      if (!senderTrusted2(event.senderFrame)) return { error: "untrusted sender", code: "FORBIDDEN" };
      const sid = typeof id === "string" ? id.replace(/[^a-zA-Z0-9_:.@-]/g, "").slice(0, 80) : "";
      if (sid === "") return { error: "id required", code: "BAD_REQUEST" };
      if (client === null || bridge.hostState !== "ready") return { error: `host not ready (${bridge.hostState})`, code: "HOST_NOT_READY" };
      try {
        const md = await client.getText(`/api/sessions/${encodeURIComponent(sid)}/export.md`);
        const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
        if (win === void 0) return { error: "no window", code: "BRIDGE_ERROR" };
        const r = await dialog.showSaveDialog(win, {
          title: typeof title === "string" && title !== "" ? title.slice(0, 80) : "\u5BFC\u51FA\u4F1A\u8BDD",
          defaultPath: `hmh-${sid}.md`,
          filters: [{ name: "Markdown", extensions: ["md"] }]
        });
        if (r.canceled || r.filePath === void 0 || r.filePath === "") return { ok: false, canceled: true };
        await writeFile2(r.filePath, md, "utf8");
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
    ipcMain.handle("bridge:runtime-info", (event) => {
      if (!senderTrusted2(event.senderFrame)) return { error: "untrusted sender", code: "FORBIDDEN" };
      return {
        mode: bridge.mode,
        runtimeEntry: bridge.runtimeEntry,
        override: loadRuntimeEntryOverride(),
        detected: detectRealEntry2()
      };
    });
    ipcMain.handle("bridge:browse-runtime", async (event, title) => {
      if (!senderTrusted2(event.senderFrame)) return { error: "untrusted sender", code: "FORBIDDEN" };
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
      if (win === void 0) return { error: "no window", code: "BRIDGE_ERROR" };
      const r = await dialog.showOpenDialog(win, {
        title: typeof title === "string" && title !== "" ? title.slice(0, 120) : "\u9009\u62E9 hmharness \u7684 desktop-host \u5165\u53E3",
        properties: ["openFile"],
        filters: [{ name: "desktop-host", extensions: ["ts", "js"] }]
      });
      if (r.canceled || r.filePaths[0] === void 0) return { ok: false, canceled: true };
      return { ok: true, entry: r.filePaths[0] };
    });
    ipcMain.handle("bridge:set-runtime", async (event, entry) => {
      if (!senderTrusted2(event.senderFrame)) return { error: "untrusted sender", code: "FORBIDDEN" };
      const e = typeof entry === "string" ? entry.trim() : "";
      if (e !== "" && (!isAbsolute(e) || !existsSync(e))) {
        return { error: "\u5165\u53E3\u5FC5\u987B\u662F\u5B58\u5728\u7684\u7EDD\u5BF9\u8DEF\u5F84(desktop-host.ts)", code: "BAD_REQUEST" };
      }
      await saveRuntimeEntryOverride(e);
      sseAbort?.abort();
      if (supervisor !== null) await supervisor.stop();
      await startHost();
      return { ok: true, mode: bridge.mode };
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
        app2.quit();
      })();
      return { ok: true };
    });
  };
  pushEvent = pushEvent2, focusMainWindow = focusMainWindow2, setupTray = setupTray2, notifyEvent = notifyEvent2, applyChrome = applyChrome2, applyUpdate = applyUpdate2, buildAppMenu = buildAppMenu2, popupMainMenu = popupMainMenu2, webAutostartInstalled = webAutostartInstalled2, lanIpOf = lanIpOf2, cliEntryOf = cliEntryOf2, runCli = runCli2, broadcastHostState = broadcastHostState2, detectRealEntry = detectRealEntry2, repoRootOf = repoRootOf2, bundledRuntimePath = bundledRuntimePath2, senderTrusted = senderTrusted2, hostCall = hostCall2, registerIpc = registerIpc2;
  app2.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  let supervisor = null;
  let client = null;
  let bridge = { hostState: "stopped", hostPort: null, hostVersion: null, lastError: null, mode: "fake", runtimeEntry: null };
  let eventBuffer = [];
  let flushTimer = null;
  let sseAbort = null;
  let lastEventId = "";
  let droppedFrames = 0;
  const TRAY_ICON_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAR0lEQVR4nGNgQAPSsor/8WF09URrxGsQqZoxDIEJ6Dd+B2N0hbjEMWwn1QCwIYPTAFyYfgYMfBiQZADFCYkqSZnizERJdgYAlL5rsDc2aTcAAAAASUVORK5CYII=";
  let tray = null;
  const sendMenuAction = (a) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send("menu:action", a);
    }
  };
  const chromeFor = (dark) => dark ? { color: "#16181d", symbolColor: "#f5f6f8" } : { color: "#ffffff", symbolColor: "#0f1115" };
  const UPDATE_REPO = "swsgbl/hmh-desktop";
  let updateState = { checking: false, currentVersion: app2.getVersion(), latest: null, notes: "", downloaded: false, error: "" };
  let installerPath = null;
  const bumpUpdate = (patch) => {
    updateState = { ...updateState, ...patch };
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send("update:state", updateState);
    }
  };
  const cmpVersion = (a, b) => {
    const pa = a.replace(/^v/, "").split(".").map(Number);
    const pb = b.replace(/^v/, "").split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
    }
    return 0;
  };
  async function checkForUpdates() {
    if (updateState.checking || updateState.downloaded) return updateState;
    bumpUpdate({ checking: true, error: "" });
    logInfo("update", `checking\u2026 (current v${app2.getVersion()})`);
    try {
      const r = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
        headers: { "user-agent": "hmh-desktop-updater" },
        signal: AbortSignal.timeout(15e3)
      });
      if (!r.ok) throw new Error(`GitHub API ${r.status}`);
      const rel = await r.json();
      const tag = String(rel.tag_name ?? "");
      logInfo("update", `latest=${tag} assets=${(rel.assets ?? []).length}`);
      bumpUpdate({ checking: false, latest: tag, notes: String(rel.body ?? "").slice(0, 600) });
      if (tag !== "" && cmpVersion(app2.getVersion(), tag) < 0 && !updateState.downloaded) {
        void downloadInstaller(rel.assets ?? []);
      }
    } catch (err) {
      logInfo("update", `check failed: ${String(err).slice(0, 140)}`);
      bumpUpdate({ checking: false, error: String(err).slice(0, 120) });
    }
    return updateState;
  }
  async function downloadInstaller(assets) {
    try {
      const asset = assets.find((a) => /^HMH-Desktop-Setup-.*\.exe$/i.test(a.name)) ?? assets.find((a) => a.name.endsWith(".exe"));
      if (asset === void 0) {
        bumpUpdate({ error: "release \u65E0\u5B89\u88C5\u5305\u8D44\u4EA7" });
        return;
      }
      const dest = join2(app2.getPath("temp"), asset.name);
      const mirrors = [
        asset.browser_download_url,
        `https://ghfast.top/${asset.browser_download_url}`,
        `https://gh-proxy.com/${asset.browser_download_url}`,
        `https://ghproxy.cn/${asset.browser_download_url}`
      ];
      let buf = null;
      let lastErr = "";
      for (const u of mirrors) {
        try {
          logInfo("update", `trying ${new URL(u).host}\u2026`);
          const r = await fetch(u, { signal: AbortSignal.timeout(6e5) });
          if (!r.ok) {
            lastErr = `HTTP ${r.status}`;
            logInfo("update", `\u2192 HTTP ${r.status}`);
            continue;
          }
          buf = Buffer.from(await r.arrayBuffer());
          if (buf.length > 1e6) {
            logInfo("update", `\u2192 ok ${Math.round(buf.length / 1e6)}MB`);
            break;
          }
          lastErr = "\u5185\u5BB9\u5F02\u5E38";
          buf = null;
        } catch (err) {
          const e = err;
          lastErr = String(e.cause?.code ?? err).slice(0, 60);
          logInfo("update", `\u2192 fail ${lastErr}`);
        }
      }
      if (buf === null) throw new Error(`\u5168\u90E8\u4E0B\u8F7D\u901A\u9053\u5931\u8D25(${lastErr})`);
      const { writeFile: wf } = await import("node:fs/promises");
      await wf(dest, buf);
      installerPath = dest;
      bumpUpdate({ downloaded: true });
      logInfo("update", `\u5DF2\u4E0B\u8F7D ${asset.name}(${Math.round(buf.length / 1e6)}MB) \u2192 ${dest}`);
    } catch (err) {
      bumpUpdate({ error: `\u4E0B\u8F7D\u5931\u8D25: ${String(err).slice(0, 120)}` });
    }
  }
  const WEB_PORT = 7788;
  async function probeWebRemote() {
    try {
      const r = await fetch(`http://127.0.0.1:${WEB_PORT}/api/state`, { signal: AbortSignal.timeout(1500) });
      if (!r.ok) return { up: false, version: "" };
      const d = await r.json();
      return { up: true, version: String(d.daemonVersion ?? "") };
    } catch {
      return { up: false, version: "" };
    }
  }
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
  const runtimeConfigFile = () => join2(app2.getPath("userData"), "runtime.json");
  async function loadRuntimeEntryOverride() {
    try {
      const v = JSON.parse(await readFile(runtimeConfigFile(), "utf8"));
      return typeof v.entry === "string" && v.entry !== "" && isAbsolute(v.entry) ? v.entry : "";
    } catch {
      return "";
    }
  }
  async function saveRuntimeEntryOverride(entry) {
    await writeFile2(runtimeConfigFile(), JSON.stringify({ entry }, null, 2), "utf8").catch(() => void 0);
  }
  let runtimeEntry = "";
  let useBundledRuntime = false;
  async function startHost() {
    const repoRoot = join2(here, "..", "..", "..", "..");
    const packaged = app2.isPackaged;
    const forceFake = process.env.HMH_DESKTOP_FAKE === "1";
    const forceBundled = process.env.HMH_DESKTOP_BUNDLED === "1";
    const override = await loadRuntimeEntryOverride();
    const adjacent = join2(repoRoot, "..", "hmharness", "packages", "web", "src", "desktop-host.ts");
    const bundled = bundledRuntimePath2(repoRoot);
    const bundledReady = existsSync(bundled);
    let entry = "";
    useBundledRuntime = false;
    if (forceFake) {
    } else if (override !== "") {
      entry = override;
    } else if (forceBundled) {
      if (bundledReady) {
        entry = bundled;
        useBundledRuntime = true;
      } else logInfo("host", "HMH_DESKTOP_BUNDLED=1 \u4F46\u5185\u7F6E runtime \u7F3A\u5931(\u5148\u8DD1 scripts/bundle-runtime.mjs)");
    } else {
      entry = packaged ? detectRealEntry2() : existsSync(adjacent) ? adjacent : detectRealEntry2();
      if (entry === "" && bundledReady) {
        entry = bundled;
        useBundledRuntime = true;
      }
    }
    runtimeEntry = entry;
    const useReal = entry !== "" && (useBundledRuntime || existsSync(entry));
    bridge = {
      ...bridge,
      mode: useReal ? "real" : "fake",
      runtimeEntry: useReal ? useBundledRuntime ? `${entry} (bundled)` : entry : null
    };
    let spec;
    if (useBundledRuntime) {
      spec = {
        command: process.execPath,
        args: [entry],
        // 自包含单文件:electron-as-node 直跑,无 tsx 无 repo
        env: { ELECTRON_RUN_AS_NODE: "1" }
      };
    } else if (useReal) {
      const repo = repoRootOf2(entry);
      spec = {
        command: process.execPath,
        args: ["--import", "tsx", entry],
        cwd: repo,
        // bare 'tsx' 与 workspace 依赖都从 repo 的 node_modules 解析
        env: { ELECTRON_RUN_AS_NODE: "1" }
      };
    } else if (packaged) {
      spec = {
        command: process.execPath,
        args: [join2(process.resourcesPath, "fake-host.cjs")],
        env: { ELECTRON_RUN_AS_NODE: "1" }
      };
    } else {
      spec = {
        command: process.execPath,
        // 直接走包真实路径(node_modules 里的 workspace junction 会被 ESM
        // realpath 化,导致 fake-host 的 argv[1]/import.meta.url 匹配失效)
        args: ["--import", "tsx", join2(repoRoot, "packages", "host-adapter", "src", "fake-host.ts")],
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
        logInfo("host", `bridge ready on 127.0.0.1:${ep.port} (runtime ${ep.version}, mode ${bridge.mode}${useReal ? `, entry=${runtimeEntry}${useBundledRuntime ? " [bundled]" : ""}` : ""})`);
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
    isDev && rendererDevUrl ? [rendererDevUrl] : [pathToFileURL2(join2(here, "..", "..", "dist-renderer", "index.html")).href]
  );
  const windowStateFile = () => join2(app2.getPath("userData"), "window-state.json");
  async function loadBounds() {
    try {
      return JSON.parse(await readFile(windowStateFile(), "utf8"));
    } catch {
      return null;
    }
  }
  async function saveBounds(win) {
    try {
      await writeFile2(windowStateFile(), JSON.stringify(win.getBounds()), "utf8");
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
      backgroundColor: "#f9fafb",
      // v4 DSH:浅色默认(bg-base),避免深色闪屏
      title: "HMH Desktop",
      // 隐藏式标题栏:原生窗口控制(overlay 提供)+颜色随主题(renderer 经
      // chrome-theme 同步)——根治亮色模式顶部黑条;菜单栏 autoHide(Alt 呼出)。
      titleBarStyle: "hidden",
      titleBarOverlay: { ...chromeFor(nativeTheme.shouldUseDarkColors), height: 36 },
      autoHideMenuBar: true,
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
      void win.loadFile(join2(here, "..", "..", "dist-renderer", "index.html"));
    }
    win.webContents.once("did-finish-load", () => {
      if (!win.isDestroyed()) {
        win.webContents.send("bridge:host-state", bridge.hostState, { restartCount: 0 });
      }
    });
    return win;
  }
  app2.whenReady().then(() => {
    if (process.env.HMH_DESKTOP_UIVERIFY === "1" && process.env.HMH_DESKTOP_UIVERIFY_MODE !== "real") {
      process.env.HMH_DESKTOP_FAKE = "1";
    }
    app2.setAppUserModelId("dev.hmh.desktop");
    setupTray2();
    buildAppMenu2();
    if (app2.isPackaged) setTimeout(() => {
      void checkForUpdates();
    }, 3e4);
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
      if (win === null) return;
      if (process.env.HMH_DESKTOP_UIVERIFY === "1") attachUiVerify(win);
      if (process.env.HMH_DESKTOP_SECURITY_TEST === "1") {
        win.webContents.once("did-finish-load", () => {
          void securitySelfTest(win);
        });
      }
      const snap = process.env.HMH_DESKTOP_SNAPSHOT;
      if (snap !== void 0 && snap !== "") {
        win.webContents.once("did-finish-load", () => {
          setTimeout(() => {
            void (async () => {
              try {
                const img = await win.webContents.capturePage();
                const { writeFile: wf } = await import("node:fs/promises");
                await wf(snap, img.toPNG());
                console.log(`SNAPSHOT ok ${snap} ${img.getSize().width}x${img.getSize().height}`);
              } catch (err) {
                console.log(`SNAPSHOT error ${String(err).slice(0, 120)}`);
              }
              const app22 = app2;
              setTimeout(() => app22.exit(0), 500);
            })();
          }, Number(process.env.HMH_DESKTOP_SNAPSHOT_DELAY_MS ?? 12e3));
        });
      }
      if (process.env.HMH_DESKTOP_DOMPROBE === "1") {
        win.webContents.once("did-finish-load", () => {
          setTimeout(() => {
            void (async () => {
              try {
                const r = await win.webContents.executeJavaScript(`(function(){
                  var pick = function(sel){
                    var els = document.querySelectorAll(sel);
                    return Array.prototype.slice.call(els, 0, 4).map(function(el){
                      var cs = getComputedStyle(el);
                      var b = el.getBoundingClientRect();
                      return { cls: (el.className||'').toString().slice(0,80), tag: el.tagName,
                        display: cs.display, vis: cs.visibility, opacity: cs.opacity,
                        pos: cs.position, z: cs.zIndex, overflow: cs.overflow,
                        x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
                        text: (el.innerText||'').replace(/\\s+/g,' ').slice(0,60) };
                    });
                  };
                  var sels = ['html','body','#root','.app-shell','.sidebar','.workspace','.topbar','.stream','.empty-hint','.composer','.composer-row','.composer textarea','.composer-side','.att-picker','.att-chips','.sidepanel','.runtime-guide','.overlay','.turn','.card'];
                  var out = {};
                  sels.forEach(function(s){ try { out[s] = pick(s); } catch(e){ out[s] = [{err: String(e).slice(0,80)}]; } });
                  out.__meta = {
                    styleSheets: document.styleSheets.length,
                    sheet0rules: (document.styleSheets[0] && document.styleSheets[0].cssRules) ? document.styleSheets[0].cssRules.length : -1,
                    rootChildren: document.getElementById('root') ? document.getElementById('root').children.length : -1,
                    bodyChildren: document.body.children.length,
                    innerHTMLLen: document.body.innerHTML.length,
                    viewport: window.innerWidth + 'x' + window.innerHeight
                  };
                  return JSON.stringify(out);
                })()`, true);
                console.log(`DOMPROBE ${r}`);
              } catch (err) {
                console.log(`DOMPROBE error ${String(err).slice(0, 200)}`);
              }
              app2.exit(0);
            })();
          }, Number(process.env.HMH_DESKTOP_DOMPROBE_DELAY_MS ?? 9e3));
        });
      }
      if (process.env.HMH_DESKTOP_RENDER_TEST === "1") {
        win.webContents.once("did-finish-load", () => {
          setTimeout(() => {
            void (async () => {
              try {
                const n = await win.webContents.executeJavaScript(
                  'document.getElementById("root") ? document.getElementById("root").children.length : -1',
                  true
                );
                const ok = n > 0;
                console.log(`RENDER-TEST ${ok ? "ok" : "EMPTY"} rootChildren=${n}`);
                app2.exit(ok ? 0 : 1);
              } catch (err) {
                console.log(`RENDER-TEST ERROR ${String(err).slice(0, 120)}`);
                app2.exit(1);
              }
            })();
          }, 2500);
        });
      }
    });
    void startHost();
    app2.on("activate", () => {
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
      const allow = ["approve", "approvalGet", "approvalSet", "browseRuntime", "chromeTheme", "cognitive", "diff", "exportSession", "fsList", "fsRead", "fsSearch", "getState", "inject", "interrupt", "modelSet", "onEventBatches", "onHostState", "onMenuAction", "onStreamChunks", "pickDirectory", "pickFiles", "popupMainMenu", "providerSave", "providers", "remoteWebAutostart", "remoteWebStart", "remoteWebStatus", "remoteWebStop", "runtimeInfo", "sendTask", "sessionOp", "sessionPreview", "sessions", "setRuntime", "stopHost", "workspaces", "workspaceAdd", "workspaceUse"];
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
    app2.exit(failed === 0 ? 0 : 1);
  }
  app2.on("before-quit", (e) => {
    if (supervisor !== null && supervisor.state !== "stopped") {
      e.preventDefault();
      sseAbort?.abort();
      void supervisor.stop().finally(() => app2.quit());
    }
  });
  app2.on("window-all-closed", () => {
    if (process.platform !== "darwin") app2.quit();
  });
}
var pushEvent;
var focusMainWindow;
var setupTray;
var notifyEvent;
var applyChrome;
var applyUpdate;
var buildAppMenu;
var popupMainMenu;
var webAutostartInstalled;
var lanIpOf;
var cliEntryOf;
var runCli;
var broadcastHostState;
var detectRealEntry;
var repoRootOf;
var bundledRuntimePath;
var senderTrusted;
var hostCall;
var registerIpc;
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vZWxlY3Ryb24vbWFpbi9pbmRleC50cyIsICIuLi8uLi8uLi8uLi9wYWNrYWdlcy9ob3N0LWFkYXB0ZXIvc3JjL3N1cGVydmlzb3IudHMiLCAiLi4vLi4vLi4vLi4vcGFja2FnZXMvY29udHJhY3RzL3NyYy9ldmVudC50cyIsICIuLi8uLi8uLi8uLi9wYWNrYWdlcy9jb250cmFjdHMvc3JjL2Vycm9yLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2NvbnRyYWN0cy9zcmMvZ3VhcmRzLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2hvc3QtYWRhcHRlci9zcmMvY2xpZW50LnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2hvc3QtYWRhcHRlci9zcmMvZmFrZS1ob3N0LnRzIiwgIi4uLy4uL2VsZWN0cm9uL21haW4vdWl2ZXJpZnkudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogSE1IIERlc2t0b3AgXHUyMDE0IEVsZWN0cm9uIFx1NEUzQlx1OEZEQlx1N0EwQihBRFItMDAxLzAwMy8wMDQpXHUzMDAyXG4gKlxuICogXHU1Qjg5XHU1MTY4XHU0RTBEXHU1M0Q4XHU5MUNGKFx1NUYwMFx1NTNEMVx1OEJBMVx1NTIxMiBNMCBcdTUxRkFcdTUzRTNcdTk1RTggKyBFbGVjdHJvbiBcdTVCOThcdTY1QjlcdTVCODlcdTUxNjhcdTZFMDVcdTUzNTUpOlxuICogIC0gcmVuZGVyZXI6Y29udGV4dElzb2xhdGlvbiArIHNhbmRib3ggKyBcdTc5ODEgbm9kZUludGVncmF0aW9uLFx1NEUyNVx1NjgzQyBDU1A7XG4gKiAgLSBcdTVCRkNcdTgyMkEvXHU2NUIwXHU3QTk3XHU1M0UzXHU0RTAwXHU1RjhCXHU2MkQyXHU3RUREKFx1NTNFQVx1NTJBMFx1OEY3RFx1NjIxMVx1NEVFQ1x1ODFFQVx1NURGMVx1NzY4NCByZW5kZXJlcik7XG4gKiAgLSBcdTZCQ0ZcdTY3NjEgSVBDIFx1NjgyMVx1OUE4QyBzZW5kZXIgXHU3Njg0XHU5ODc2XHU1QzQyIGZyYW1lIFVSTCBcdTVDNUVcdTRFOEVcdTY3MkNcdTVFOTRcdTc1MjgsXHU5MDFBXHU5MDUzXHU3NjdEXHU1NDBEXHU1MzU1O1xuICogIC0gaG9zdCB0b2tlbiBcdTUzRUFcdTVCNThcdTU3MjhcdTRFOEVcdTY3MkNcdThGREJcdTdBMEJcdTRFMEVcdTVCNTBcdThGREJcdTdBMEIgZW52LFx1NjVFNVx1NUZEN1x1OEY5M1x1NTFGQVx1NTI0RFx1NTE0OFx1ODEzMVx1NjU0RjtcbiAqICAtIFx1NTM1NVx1NUI5RVx1NEY4Qlx1OTUwMTtcdTkwMDBcdTUxRkFcdTY1RjZcdTUzRUFcdTUwNUNcdTZCNjJcdTgxRUFcdTVERjEgc3Bhd24gXHU3Njg0IGhvc3QoXHU0RjE4XHU5NkM1XHUyMTkyXHU1MTVDXHU1RTk1IGtpbGwpXHUzMDAyXG4gKlxuICogXHU5NjM2XHU2QkI1RSgyMDI2LTEwLTEwKTptYWluIFx1NjMwMVx1NjcwOSBEZXNrdG9wSG9zdENsaWVudCxTU0UgXHU0RkUxXHU1QzAxXHU2RDQxKGV2ZW50OiBobWgpXG4gKiBcdTdFQ0YgNTBtcyBcdTYyNzlcdTkxQ0ZcdTYzQThcdTdFRDkgcmVuZGVyZXI7c2VuZFRhc2svYXBwcm92ZS9pbnRlcnJ1cHQvc2Vzc2lvbnMgXHU1MTY4XHU5MEU4XHU4RjZDXHU1M0QxXG4gKiBcdTdFRDkgaG9zdCBcdTIwMTRcdTIwMTQgZmFrZSBcdTRFMEVcdTc3MUZcdTVCOUUgaG1oYXJuZXNzIGRlc2t0b3AtaG9zdCBcdThENzBcdTU0MENcdTRFMDBcdTY3NjFcdTRFRTNcdTc4MDFcdThERUZcdTVGODRcdTMwMDJcbiAqL1xuaW1wb3J0IHsgYXBwLCBCcm93c2VyV2luZG93LCBkaWFsb2csIGlwY01haW4sIHNlc3Npb24sIHNoZWxsLCBUcmF5LCBOb3RpZmljYXRpb24sIE1lbnUsIG5hdGl2ZUltYWdlLCBuYXRpdmVUaGVtZSB9IGZyb20gJ2VsZWN0cm9uJztcbmltcG9ydCB7IGpvaW4sIGRpcm5hbWUsIGlzQWJzb2x1dGUsIHJlc29sdmUgfSBmcm9tICdub2RlOnBhdGgnO1xuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhbHBhdGhTeW5jIH0gZnJvbSAnbm9kZTpmcyc7XG5pbXBvcnQgeyB3cml0ZUZpbGUsIHJlYWRGaWxlIH0gZnJvbSAnbm9kZTpmcy9wcm9taXNlcyc7XG5pbXBvcnQgeyBob21lZGlyLCBuZXR3b3JrSW50ZXJmYWNlcyB9IGZyb20gJ25vZGU6b3MnO1xuaW1wb3J0IHsgZXhlY0ZpbGVTeW5jLCBzcGF3biB9IGZyb20gJ25vZGU6Y2hpbGRfcHJvY2Vzcyc7XG5pbXBvcnQgeyBwYXRoVG9GaWxlVVJMIH0gZnJvbSAnbm9kZTp1cmwnO1xuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gJ25vZGU6Y3J5cHRvJztcbmltcG9ydCB7IERlc2t0b3BSdW50aW1lU3VwZXJ2aXNvciwgRGVza3RvcEhvc3RDbGllbnQsIGVudmVsb3BlRnJvbUZyYW1lLCB0eXBlIEhvc3RTdGF0ZSB9IGZyb20gJ0BobWgtZGVza3RvcC9ob3N0LWFkYXB0ZXInO1xuaW1wb3J0IHsgaXNFdmVudEVudmVsb3BlLCB0eXBlIEV2ZW50RW52ZWxvcGUgfSBmcm9tICdAaG1oLWRlc2t0b3AvY29udHJhY3RzJztcbmltcG9ydCB7IGF0dGFjaFVpVmVyaWZ5IH0gZnJvbSAnLi91aXZlcmlmeS50cyc7XG5cbmNvbnN0IGhlcmUgPSBpbXBvcnQubWV0YS5kaXJuYW1lID8/ICcuJztcbmNvbnN0IGlzRGV2ID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfREVWID09PSAnMSc7XG5jb25zdCByZW5kZXJlckRldlVybCA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1JFTkRFUkVSX1VSTCA/PyAnJztcbmNvbnN0IHByZWxvYWRQYXRoID0gam9pbihoZXJlLCAnLi4vcHJlbG9hZC9pbmRleC5janMnKTtcblxuLyogLS0tLSBcdTY1RTVcdTVGRDdcdTgxMzFcdTY1NEY6dG9rZW4vYXV0aG9yaXphdGlvbiBcdTZDMzhcdTRFMERcdThGREJcdTYzQTdcdTUyMzZcdTUzRjAgLS0tLSAqL1xuY29uc3Qgc2VjcmV0czogc3RyaW5nW10gPSBbXTtcbmZ1bmN0aW9uIHJlZGFjdChzOiBzdHJpbmcpOiBzdHJpbmcge1xuICBsZXQgb3V0ID0gcztcbiAgZm9yIChjb25zdCBzZWMgb2Ygc2VjcmV0cykge1xuICAgIGlmIChzZWMubGVuZ3RoID49IDgpIG91dCA9IG91dC5zcGxpdChzZWMpLmpvaW4oJ1tyZWRhY3RlZF0nKTtcbiAgfVxuICByZXR1cm4gb3V0O1xufVxuZnVuY3Rpb24gbG9nSW5mbyh0YWc6IHN0cmluZywgbXNnOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc29sZS5sb2coYFtobWgtZGVza3RvcDoke3RhZ31dICR7cmVkYWN0KG1zZyl9YCk7XG59XG5cbi8qIC0tLS0gXHU1MzU1XHU1QjlFXHU0RjhCIC0tLS0gKi9cbmlmICghYXBwLnJlcXVlc3RTaW5nbGVJbnN0YW5jZUxvY2soKSkge1xuICBhcHAucXVpdCgpO1xufSBlbHNlIHtcbiAgYXBwLm9uKCdzZWNvbmQtaW5zdGFuY2UnLCAoKSA9PiB7XG4gICAgY29uc3Qgd2luID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKClbMF07XG4gICAgaWYgKHdpbikge1xuICAgICAgaWYgKHdpbi5pc01pbmltaXplZCgpKSB3aW4ucmVzdG9yZSgpO1xuICAgICAgd2luLmZvY3VzKCk7XG4gICAgfVxuICB9KTtcblxuICAvKiAtLS0tIGhvc3QgXHU3NkQxXHU3QkExICsgXHU2ODY1XHU1QkEyXHU2MjM3XHU3QUVGIC0tLS0gKi9cbiAgaW50ZXJmYWNlIEJyaWRnZVNuYXBzaG90IHtcbiAgICBob3N0U3RhdGU6IEhvc3RTdGF0ZTtcbiAgICBob3N0UG9ydDogbnVtYmVyIHwgbnVsbDtcbiAgICBob3N0VmVyc2lvbjogc3RyaW5nIHwgbnVsbDtcbiAgICBsYXN0RXJyb3I6IHN0cmluZyB8IG51bGw7XG4gICAgbW9kZTogJ2Zha2UnIHwgJ3JlYWwnO1xuICAgIHJ1bnRpbWVFbnRyeTogc3RyaW5nIHwgbnVsbDtcbiAgfVxuICBsZXQgc3VwZXJ2aXNvcjogRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yIHwgbnVsbCA9IG51bGw7XG4gIGxldCBjbGllbnQ6IERlc2t0b3BIb3N0Q2xpZW50IHwgbnVsbCA9IG51bGw7XG4gIGxldCBicmlkZ2U6IEJyaWRnZVNuYXBzaG90ID0geyBob3N0U3RhdGU6ICdzdG9wcGVkJywgaG9zdFBvcnQ6IG51bGwsIGhvc3RWZXJzaW9uOiBudWxsLCBsYXN0RXJyb3I6IG51bGwsIG1vZGU6ICdmYWtlJywgcnVudGltZUVudHJ5OiBudWxsIH07XG4gIC8qKiBcdTRFOEJcdTRFRjZcdTYyNzlcdTkxQ0ZcdTdGMTNcdTUxQjI6XHU5QUQ4XHU5ODkxIFNTRSBcdTRFMERcdTkwMTBcdTY3NjFcdThGQzcgSVBDLDUwbXMgXHU2Mjc5XHU5MUNGIGZsdXNoKFx1NkUzMlx1NjdEM1x1NEUwRFx1NTM2MSlcdTMwMDIgKi9cbiAgbGV0IGV2ZW50QnVmZmVyOiBFdmVudEVudmVsb3BlW10gPSBbXTtcbiAgbGV0IGZsdXNoVGltZXI6IE5vZGVKUy5UaW1lb3V0IHwgbnVsbCA9IG51bGw7XG4gIGxldCBzc2VBYm9ydDogQWJvcnRDb250cm9sbGVyIHwgbnVsbCA9IG51bGw7XG4gIGxldCBsYXN0RXZlbnRJZCA9ICcnO1xuICAvKiogXHU2NzJBXHU3N0U1L1x1NzU3OFx1NUY2Mlx1NEZFMVx1NUMwMVx1OEJBMVx1NjU3MChTQ0hFTUFfTUlTTUFUQ0ggXHU5NzYyXHU1NDExXHU4QkNBXHU2NUFELFx1NEUwRFx1NUQyOSlcdTMwMDIgKi9cbiAgbGV0IGRyb3BwZWRGcmFtZXMgPSAwO1xuXG4gIGZ1bmN0aW9uIHB1c2hFdmVudChlbnY6IEV2ZW50RW52ZWxvcGUpOiB2b2lkIHtcbiAgICBldmVudEJ1ZmZlci5wdXNoKGVudik7XG4gICAgaWYgKGV2ZW50QnVmZmVyLmxlbmd0aCA+IDJfMDAwKSBldmVudEJ1ZmZlci5zcGxpY2UoMCwgZXZlbnRCdWZmZXIubGVuZ3RoIC0gMl8wMDApO1xuICAgIGlmIChmbHVzaFRpbWVyID09PSBudWxsKSB7XG4gICAgICBmbHVzaFRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgIGZsdXNoVGltZXIgPSBudWxsO1xuICAgICAgICBjb25zdCBiYXRjaCA9IGV2ZW50QnVmZmVyO1xuICAgICAgICBldmVudEJ1ZmZlciA9IFtdO1xuICAgICAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcbiAgICAgICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCdicmlkZ2U6ZXZlbnQtYmF0Y2gnLCBiYXRjaCk7XG4gICAgICAgIH1cbiAgICAgIH0sIDUwKTtcbiAgICB9XG4gICAgbm90aWZ5RXZlbnQoZW52KTtcbiAgfVxuXG4gIC8qIC0tLS0gXHU3Q0ZCXHU3RURGXHU2MjU4XHU3NkQ4ICsgXHU5MDFBXHU3N0U1KDAzIFx1NTNGNyBcdTAwQTdcdTRFMDA6XHU2ODRDXHU5NzYyXHU0RUE3XHU1NEMxXHU5NzAwXHU4OTgxXHU3Q0ZCXHU3RURGXHU2MjU4XHU3NkQ4XHUzMDAxXHU5MDFBXHU3N0U1KSAtLS0tXG4gICAgIFx1NUJBMVx1NjI3OVx1N0I0OVx1NUY4NVx1NUZDNVx1OTg3Qlx1NjI1M1x1NjI3MChcdTc1MjhcdTYyMzdcdTVGQzVcdTk4N0JcdTUxQjNcdTdCNTYpO1x1NUI4Q1x1NjIxMC9cdTU5MzFcdThEMjVcdTRFQzVcdTU3MjhcdTdBOTdcdTUzRTNcdTU5MzFcdTcxMjZcdTY1RjZcdTYzRDBcdTkxOTJcdTMwMDIgKi9cbiAgY29uc3QgVFJBWV9JQ09OX0JBU0U2NCA9ICdpVkJPUncwS0dnb0FBQUFOU1VoRVVnQUFBQkFBQUFBUUNBWUFBQUFmOC85aEFBQUFSMGxFUVZSNG5HTmdRQVBTc29yLzhXRjA5VVJyeEdzUXFab3hESUVKNkRkK0IyTjBoYmpFTVd3bjFRQ3dJWVBUQUZ5WWZnWU1mQmlRWkFERkNZa3FTWm5pekVSSmRnWUFsTDVyc0RjMmFUY0FBQUFBU1VWT1JLNUNZSUk9JztcbiAgbGV0IHRyYXk6IFRyYXkgfCBudWxsID0gbnVsbDtcbiAgY29uc3Qgc2VuZE1lbnVBY3Rpb24gPSAoYTogc3RyaW5nKTogdm9pZCA9PiB7XG4gICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XG4gICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCdtZW51OmFjdGlvbicsIGEpO1xuICAgIH1cbiAgfTtcbiAgZnVuY3Rpb24gZm9jdXNNYWluV2luZG93KCk6IHZvaWQge1xuICAgIGNvbnN0IHdpbiA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmZpbmQoKHcpID0+ICF3LmlzRGVzdHJveWVkKCkpO1xuICAgIGlmICh3aW4gPT09IHVuZGVmaW5lZCkgcmV0dXJuO1xuICAgIGlmICh3aW4uaXNNaW5pbWl6ZWQoKSkgd2luLnJlc3RvcmUoKTtcbiAgICB3aW4uc2hvdygpO1xuICAgIHdpbi5mb2N1cygpO1xuICB9XG4gIGZ1bmN0aW9uIHNldHVwVHJheSgpOiB2b2lkIHtcbiAgICBpZiAodHJheSAhPT0gbnVsbCkgcmV0dXJuO1xuICAgIGNvbnN0IGljb24gPSBuYXRpdmVJbWFnZS5jcmVhdGVGcm9tRGF0YVVSTChgZGF0YTppbWFnZS9wbmc7YmFzZTY0LCR7VFJBWV9JQ09OX0JBU0U2NH1gKTtcbiAgICB0cmF5ID0gbmV3IFRyYXkoaWNvbik7XG4gICAgdHJheS5zZXRUb29sVGlwKCdITUggRGVza3RvcCcpO1xuICAgIHRyYXkub24oJ2NsaWNrJywgZm9jdXNNYWluV2luZG93KTtcbiAgICB0cmF5LnNldENvbnRleHRNZW51KE1lbnUuYnVpbGRGcm9tVGVtcGxhdGUoW1xuICAgICAgeyBsYWJlbDogJ1x1NjVCMFx1NUVGQVx1NEYxQVx1OEJERCcsIGNsaWNrOiAoKTogdm9pZCA9PiBzZW5kTWVudUFjdGlvbignbmV3LXNlc3Npb24nKSB9LFxuICAgICAgeyBsYWJlbDogJ1x1NjYzRVx1NzkzQVx1NEUzQlx1N0E5N1x1NTNFMycsIGNsaWNrOiBmb2N1c01haW5XaW5kb3cgfSxcbiAgICAgIHsgbGFiZWw6ICdcdTYyNEJcdTY3M0FcdThGRENcdTdBMEJcdTYzQTdcdTUyMzYnLCBjbGljazogKCk6IHZvaWQgPT4gc2VuZE1lbnVBY3Rpb24oJ29wZW4tcmVtb3RlJykgfSxcbiAgICAgIHsgbGFiZWw6ICdcdThCQkVcdTdGNkUnLCBjbGljazogKCk6IHZvaWQgPT4gc2VuZE1lbnVBY3Rpb24oJ29wZW4tc2V0dGluZ3MnKSB9LFxuICAgICAgeyB0eXBlOiAnc2VwYXJhdG9yJyB9LFxuICAgICAgeyBsYWJlbDogJ1x1OTAwMFx1NTFGQScsIGNsaWNrOiAoKTogdm9pZCA9PiB7IGFwcC5xdWl0KCk7IH0gfSxcbiAgICBdKSk7XG4gIH1cbiAgZnVuY3Rpb24gbm90aWZ5RXZlbnQoZW52OiBFdmVudEVudmVsb3BlKTogdm9pZCB7XG4gICAgLy8gXHU5QThDXHU2NTM2L1x1NjIyQVx1NTZGRS9cdTZFMzJcdTY3RDNcdTYzQTJcdTk0ODhcdTZBMjFcdTVGMEZcdTk3NTlcdTlFRDgoXHU0RTBEXHU1RjgwXHU3NTI4XHU2MjM3XHU2ODRDXHU5NzYyXHU1RjM5XHU2RDRCXHU4QkQ1XHU5MDFBXHU3N0U1KVxuICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWSA9PT0gJzEnIHx8IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NOQVBTSE9UICE9PSB1bmRlZmluZWQgfHwgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfUkVOREVSX1RFU1QgPT09ICcxJykgcmV0dXJuO1xuICAgIGlmICghTm90aWZpY2F0aW9uLmlzU3VwcG9ydGVkKCkpIHJldHVybjtcbiAgICBjb25zdCB3aW4gPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5maW5kKCh3KSA9PiAhdy5pc0Rlc3Ryb3llZCgpKTtcbiAgICBjb25zdCBmb2N1c2VkID0gd2luPy5pc0ZvY3VzZWQoKSA/PyBmYWxzZTtcbiAgICBjb25zdCBtayA9ICh0aXRsZTogc3RyaW5nLCBib2R5OiBzdHJpbmcpOiB2b2lkID0+IHtcbiAgICAgIGNvbnN0IG4gPSBuZXcgTm90aWZpY2F0aW9uKHsgdGl0bGUsIGJvZHksIGljb246IG5hdGl2ZUltYWdlLmNyZWF0ZUZyb21EYXRhVVJMKGBkYXRhOmltYWdlL3BuZztiYXNlNjQsJHtUUkFZX0lDT05fQkFTRTY0fWApIH0pO1xuICAgICAgbi5vbignY2xpY2snLCBmb2N1c01haW5XaW5kb3cpO1xuICAgICAgbi5zaG93KCk7XG4gICAgfTtcbiAgICBpZiAoZW52LmtpbmQgPT09ICdhcHByb3ZhbC5yZXF1aXJlZCcpIHtcbiAgICAgIGNvbnN0IHAgPSBlbnYucGF5bG9hZCBhcyB7IHRvb2w/OiBzdHJpbmcgfTtcbiAgICAgIG1rKCdITUggXHU5NzAwXHU4OTgxXHU1QkExXHU2Mjc5JywgYCR7U3RyaW5nKHAudG9vbCA/PyAnXHU2NENEXHU0RjVDJyl9IFx1N0I0OVx1NUY4NVx1NEY2MFx1NzY4NFx1NjI3OVx1NTFDNmApO1xuICAgIH0gZWxzZSBpZiAoZW52LmtpbmQgPT09ICdydW4uY29tcGxldGVkJyAmJiAhZm9jdXNlZCkge1xuICAgICAgbWsoJ0hNSCBcdTRFRkJcdTUyQTFcdTVCOENcdTYyMTAnLCBgXHU0RjFBXHU4QkREICR7ZW52LnNlc3Npb25JZH0gXHU3Njg0XHU0RUZCXHU1MkExXHU1REYyXHU1QjhDXHU2MjEwYCk7XG4gICAgfSBlbHNlIGlmIChlbnYua2luZCA9PT0gJ3J1bi5mYWlsZWQnICYmICFmb2N1c2VkKSB7XG4gICAgICBtaygnSE1IIFx1NEVGQlx1NTJBMVx1NTkzMVx1OEQyNScsIGBcdTRGMUFcdThCREQgJHtlbnYuc2Vzc2lvbklkfSBcdTc2ODRcdTRFRkJcdTUyQTFcdTU5MzFcdThEMjUsXHU3MEI5XHU1MUZCXHU2N0U1XHU3NzBCYCk7XG4gICAgfVxuICB9XG5cbiAgLyogLS0tLSBcdTgxRUFcdTVCOUFcdTRFNDlcdTY4MDdcdTk4OThcdTY4MEYoMjAyNi0xMC0xMSBcdTc1MjhcdTYyMzdcdTUzQ0RcdTk5ODg6XHU0RUFFXHU4MjcyXHU2QTIxXHU1RjBGXHU5ODc2XHU5MEU4XHU5RUQxXHU2NzYxPVx1NTM5Rlx1NzUxRlx1ODNEQ1x1NTM1NVx1NjgwRlxuICAgICBcdTRFMERcdThEREZcdTRFM0JcdTk4OTg7XHU4M0RDXHU1MzU1XHU0RTBFXHU4QkJFXHU3RjZFXHU5MUNEXHU1OTBEKSAtLS0tIFx1NjVCOVx1Njg0ODpcdTk2OTBcdTg1Q0ZcdTVGMEZcdTY4MDdcdTk4OThcdTY4MEYgKyB0aXRsZUJhck92ZXJsYXlcbiAgICAgKFx1OTg5Q1x1ODI3Mlx1OTY4Rlx1NEUzQlx1OTg5OCksXHU4M0RDXHU1MzU1XHU2ODBGIGF1dG9IaWRlKEFsdCBcdTU0N0NcdTUxRkEpXHU0RTE0XHU3Q0JFXHU3QjgwXHU0RTNBXHU3Q0ZCXHU3RURGXHU3RUE3XHU4MEZEXHU1MjlCO1xuICAgICBcdTVFMzhcdTc1MjhcdTUyQThcdTRGNUNcdThENzAgcmVuZGVyZXIgXHU2ODA3XHU5ODk4XHU2ODBGIFx1MjYzMCBcdTRFM0JcdTgzRENcdTUzNTUoXHU1NTJGXHU0RTAwXHU1MTY1XHU1M0UzKVx1MzAwMiAqL1xuICAvLyB2NCBEU0ggXHU4QkJFXHU4QkExXHU4QkVEXHU4QTAwOm92ZXJsYXkgXHU4MjcyXHU4RERGXHU5NjhGIHRpdGxlYmFyIFx1NzY4NCBiZy1sYXllci0xKFx1NkQ0NSAjZmZmL1x1NkRGMSAjMTYxODFkKVxuICBjb25zdCBjaHJvbWVGb3IgPSAoZGFyazogYm9vbGVhbik6IHsgY29sb3I6IHN0cmluZzsgc3ltYm9sQ29sb3I6IHN0cmluZyB9ID0+XG4gICAgZGFyayA/IHsgY29sb3I6ICcjMTYxODFkJywgc3ltYm9sQ29sb3I6ICcjZjVmNmY4JyB9IDogeyBjb2xvcjogJyNmZmZmZmYnLCBzeW1ib2xDb2xvcjogJyMwZjExMTUnIH07XG4gIGZ1bmN0aW9uIGFwcGx5Q2hyb21lKGRhcms6IGJvb2xlYW4pOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcbiAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB7XG4gICAgICAgIHRyeSB7IHcuc2V0VGl0bGVCYXJPdmVybGF5KGNocm9tZUZvcihkYXJrKSk7IH0gY2F0Y2ggeyAvKiBcdTRFQzUgV2luZG93cyBcdTY1MkZcdTYzMDEgKi8gfVxuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8qIC0tLS0gXHU1RTk0XHU3NTI4XHU1MTg1XHU2NkY0XHU2NUIwKDIwMjYtMTAtMjY6XHU4MUVBXHU3ODE0XHU4RjdCXHU5MUNGXHU2NkY0XHU2NUIwXHU1NjY4LFx1OTZGNlx1NEY5RFx1OEQ1NjtHaXRIdWIgUmVsZWFzZXMgXHU5MDFBXHU5MDUzKVxuICAgICBcdTZENDFcdTdBMEI6XHUyNjMwXCJcdTY4QzBcdTY3RTVcdTY2RjRcdTY1QjBcIlx1MjE5MiBmZXRjaCBsYXRlc3QgcmVsZWFzZSB0YWcgXHUyMTkyIFx1NkJENFx1NzI0OFx1NjcyQyBcdTIxOTIgXHU1NDBFXHU1M0YwXHU0RTBCXHU4RjdEIFNldHVwXG4gICAgIGV4ZSBcdTUyMzBcdTRFMzRcdTY1RjZcdTc2RUVcdTVGNTUgXHUyMTkyIFx1ODNEQ1x1NTM1NVx1NTNEOFwiXHU5MUNEXHU1NDJGXHU1RTc2XHU1Qjg5XHU4OEM1XHU2NkY0XHU2NUIwXCJcdTIxOTIgXHU5MDAwXHU1MUZBXHU1RTk0XHU3NTI4XHU1NDBFIE5TSVMgL1MgL0Q9XHU1MzlGXHU3NkVFXHU1RjU1XG4gICAgIFx1OTc1OVx1OUVEOFx1ODk4Nlx1NzZENlx1NUI4OVx1ODhDNShcdTRFMEJcdTZCMjFcdTU0MkZcdTUyQThcdTUzNzNcdTY1QjBcdTcyNDgpXHUzMDAyXHU2NUUwXHU3QjdFXHU1NDBEXHU4QkMxXHU0RTY2XHU5NjM2XHU2QkI1XHU1M0VGXHU3NTI4O1x1NkI2M1x1NUYwRlx1N0I3RVx1NTQwRFx1NTQwRVx1NTNFRlx1NTJBMFx1NjgyMVx1OUE4Q1x1MzAwMiAqL1xuICBjb25zdCBVUERBVEVfUkVQTyA9ICdzd3NnYmwvaG1oLWRlc2t0b3AnO1xuICBpbnRlcmZhY2UgVXBkYXRlU3RhdGUgeyBjaGVja2luZzogYm9vbGVhbjsgY3VycmVudFZlcnNpb246IHN0cmluZzsgbGF0ZXN0OiBzdHJpbmcgfCBudWxsOyBub3Rlczogc3RyaW5nOyBkb3dubG9hZGVkOiBib29sZWFuOyBlcnJvcjogc3RyaW5nIH1cbiAgbGV0IHVwZGF0ZVN0YXRlOiBVcGRhdGVTdGF0ZSA9IHsgY2hlY2tpbmc6IGZhbHNlLCBjdXJyZW50VmVyc2lvbjogYXBwLmdldFZlcnNpb24oKSwgbGF0ZXN0OiBudWxsLCBub3RlczogJycsIGRvd25sb2FkZWQ6IGZhbHNlLCBlcnJvcjogJycgfTtcbiAgbGV0IGluc3RhbGxlclBhdGg6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBjb25zdCBidW1wVXBkYXRlID0gKHBhdGNoOiBQYXJ0aWFsPFVwZGF0ZVN0YXRlPik6IHZvaWQgPT4ge1xuICAgIHVwZGF0ZVN0YXRlID0geyAuLi51cGRhdGVTdGF0ZSwgLi4ucGF0Y2ggfTtcbiAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcbiAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ3VwZGF0ZTpzdGF0ZScsIHVwZGF0ZVN0YXRlKTtcbiAgICB9XG4gIH07XG4gIGNvbnN0IGNtcFZlcnNpb24gPSAoYTogc3RyaW5nLCBiOiBzdHJpbmcpOiBudW1iZXIgPT4ge1xuICAgIGNvbnN0IHBhID0gYS5yZXBsYWNlKC9edi8sICcnKS5zcGxpdCgnLicpLm1hcChOdW1iZXIpO1xuICAgIGNvbnN0IHBiID0gYi5yZXBsYWNlKC9edi8sICcnKS5zcGxpdCgnLicpLm1hcChOdW1iZXIpO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgMzsgaSsrKSB7IGlmICgocGFbaV0gPz8gMCkgIT09IChwYltpXSA/PyAwKSkgcmV0dXJuIChwYVtpXSA/PyAwKSA8IChwYltpXSA/PyAwKSA/IC0xIDogMTsgfVxuICAgIHJldHVybiAwO1xuICB9O1xuICBhc3luYyBmdW5jdGlvbiBjaGVja0ZvclVwZGF0ZXMoKTogUHJvbWlzZTxVcGRhdGVTdGF0ZT4ge1xuICAgIGlmICh1cGRhdGVTdGF0ZS5jaGVja2luZyB8fCB1cGRhdGVTdGF0ZS5kb3dubG9hZGVkKSByZXR1cm4gdXBkYXRlU3RhdGU7XG4gICAgYnVtcFVwZGF0ZSh7IGNoZWNraW5nOiB0cnVlLCBlcnJvcjogJycgfSk7XG4gICAgbG9nSW5mbygndXBkYXRlJywgYGNoZWNraW5nXHUyMDI2IChjdXJyZW50IHYke2FwcC5nZXRWZXJzaW9uKCl9KWApO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCByID0gYXdhaXQgZmV0Y2goYGh0dHBzOi8vYXBpLmdpdGh1Yi5jb20vcmVwb3MvJHtVUERBVEVfUkVQT30vcmVsZWFzZXMvbGF0ZXN0YCwge1xuICAgICAgICBoZWFkZXJzOiB7ICd1c2VyLWFnZW50JzogJ2htaC1kZXNrdG9wLXVwZGF0ZXInIH0sXG4gICAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCgxNV8wMDApLFxuICAgICAgfSk7XG4gICAgICBpZiAoIXIub2spIHRocm93IG5ldyBFcnJvcihgR2l0SHViIEFQSSAke3Iuc3RhdHVzfWApO1xuICAgICAgY29uc3QgcmVsID0gKGF3YWl0IHIuanNvbigpKSBhcyB7IHRhZ19uYW1lPzogc3RyaW5nOyBib2R5Pzogc3RyaW5nOyBhc3NldHM/OiBBcnJheTx7IG5hbWU6IHN0cmluZzsgYnJvd3Nlcl9kb3dubG9hZF91cmw6IHN0cmluZzsgc2l6ZTogbnVtYmVyIH0+IH07XG4gICAgICBjb25zdCB0YWcgPSBTdHJpbmcocmVsLnRhZ19uYW1lID8/ICcnKTtcbiAgICAgIGxvZ0luZm8oJ3VwZGF0ZScsIGBsYXRlc3Q9JHt0YWd9IGFzc2V0cz0keyhyZWwuYXNzZXRzID8/IFtdKS5sZW5ndGh9YCk7XG4gICAgICBidW1wVXBkYXRlKHsgY2hlY2tpbmc6IGZhbHNlLCBsYXRlc3Q6IHRhZywgbm90ZXM6IFN0cmluZyhyZWwuYm9keSA/PyAnJykuc2xpY2UoMCwgNjAwKSB9KTtcbiAgICAgIC8vIFx1NjcwOVx1NjVCMFx1NzI0OFx1NEUxNFx1NjcyQVx1NEUwQlx1OEY3RFx1OEZDNyBcdTIxOTIgXHU1NDBFXHU1M0YwXHU0RTBCXHU4RjdEXHU1Qjg5XHU4OEM1XHU1MzA1XG4gICAgICBpZiAodGFnICE9PSAnJyAmJiBjbXBWZXJzaW9uKGFwcC5nZXRWZXJzaW9uKCksIHRhZykgPCAwICYmICF1cGRhdGVTdGF0ZS5kb3dubG9hZGVkKSB7XG4gICAgICAgIHZvaWQgZG93bmxvYWRJbnN0YWxsZXIocmVsLmFzc2V0cyA/PyBbXSk7XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBsb2dJbmZvKCd1cGRhdGUnLCBgY2hlY2sgZmFpbGVkOiAke1N0cmluZyhlcnIpLnNsaWNlKDAsIDE0MCl9YCk7XG4gICAgICBidW1wVXBkYXRlKHsgY2hlY2tpbmc6IGZhbHNlLCBlcnJvcjogU3RyaW5nKGVycikuc2xpY2UoMCwgMTIwKSB9KTtcbiAgICB9XG4gICAgcmV0dXJuIHVwZGF0ZVN0YXRlO1xuICB9XG4gIGFzeW5jIGZ1bmN0aW9uIGRvd25sb2FkSW5zdGFsbGVyKGFzc2V0czogQXJyYXk8eyBuYW1lOiBzdHJpbmc7IGJyb3dzZXJfZG93bmxvYWRfdXJsOiBzdHJpbmc7IHNpemU6IG51bWJlciB9Pik6IFByb21pc2U8dm9pZD4ge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBhc3NldCA9IGFzc2V0cy5maW5kKChhKSA9PiAvXkhNSC1EZXNrdG9wLVNldHVwLS4qXFwuZXhlJC9pLnRlc3QoYS5uYW1lKSkgPz8gYXNzZXRzLmZpbmQoKGEpID0+IGEubmFtZS5lbmRzV2l0aCgnLmV4ZScpKTtcbiAgICAgIGlmIChhc3NldCA9PT0gdW5kZWZpbmVkKSB7IGJ1bXBVcGRhdGUoeyBlcnJvcjogJ3JlbGVhc2UgXHU2NUUwXHU1Qjg5XHU4OEM1XHU1MzA1XHU4RDQ0XHU0RUE3JyB9KTsgcmV0dXJuOyB9XG4gICAgICBjb25zdCBkZXN0ID0gam9pbihhcHAuZ2V0UGF0aCgndGVtcCcpLCBhc3NldC5uYW1lKTtcbiAgICAgIC8vIGdpdGh1Yi5jb20gXHU3NkY0XHU4RkRFXHU1NzI4XHU5MEU4XHU1MjA2XHU3RjUxXHU3RURDXHU4RDg1XHU2NUY2IFx1MjE5MiBcdTk1NUNcdTUwQ0ZcdTU2REVcdTkwMDBcdTk0RkUoXHU1QjlFXHU2RDRCIGdoZmFzdC9naC1wcm94eSBcdTUzRUZcdTc1MjgpXG4gICAgICBjb25zdCBtaXJyb3JzID0gW1xuICAgICAgICBhc3NldC5icm93c2VyX2Rvd25sb2FkX3VybCxcbiAgICAgICAgYGh0dHBzOi8vZ2hmYXN0LnRvcC8ke2Fzc2V0LmJyb3dzZXJfZG93bmxvYWRfdXJsfWAsXG4gICAgICAgIGBodHRwczovL2doLXByb3h5LmNvbS8ke2Fzc2V0LmJyb3dzZXJfZG93bmxvYWRfdXJsfWAsXG4gICAgICAgIGBodHRwczovL2docHJveHkuY24vJHthc3NldC5icm93c2VyX2Rvd25sb2FkX3VybH1gLFxuICAgICAgXTtcbiAgICAgIGxldCBidWY6IEJ1ZmZlciB8IG51bGwgPSBudWxsO1xuICAgICAgbGV0IGxhc3RFcnIgPSAnJztcbiAgICAgIGZvciAoY29uc3QgdSBvZiBtaXJyb3JzKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgbG9nSW5mbygndXBkYXRlJywgYHRyeWluZyAke25ldyBVUkwodSkuaG9zdH1cdTIwMjZgKTtcbiAgICAgICAgICBjb25zdCByID0gYXdhaXQgZmV0Y2godSwgeyBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoNjAwXzAwMCkgfSk7XG4gICAgICAgICAgaWYgKCFyLm9rKSB7IGxhc3RFcnIgPSBgSFRUUCAke3Iuc3RhdHVzfWA7IGxvZ0luZm8oJ3VwZGF0ZScsIGBcdTIxOTIgSFRUUCAke3Iuc3RhdHVzfWApOyBjb250aW51ZTsgfVxuICAgICAgICAgIGJ1ZiA9IEJ1ZmZlci5mcm9tKGF3YWl0IHIuYXJyYXlCdWZmZXIoKSk7XG4gICAgICAgICAgaWYgKGJ1Zi5sZW5ndGggPiAxXzAwMF8wMDApIHsgbG9nSW5mbygndXBkYXRlJywgYFx1MjE5MiBvayAke01hdGgucm91bmQoYnVmLmxlbmd0aCAvIDFlNil9TUJgKTsgYnJlYWs7IH1cbiAgICAgICAgICBsYXN0RXJyID0gJ1x1NTE4NVx1NUJCOVx1NUYwMlx1NUUzOCc7IGJ1ZiA9IG51bGw7XG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgIGNvbnN0IGUgPSBlcnIgYXMgeyBjYXVzZT86IHsgY29kZT86IHVua25vd24gfSB9O1xuICAgICAgICAgIGxhc3RFcnIgPSBTdHJpbmcoZS5jYXVzZT8uY29kZSA/PyBlcnIpLnNsaWNlKDAsIDYwKTtcbiAgICAgICAgICBsb2dJbmZvKCd1cGRhdGUnLCBgXHUyMTkyIGZhaWwgJHtsYXN0RXJyfWApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBpZiAoYnVmID09PSBudWxsKSB0aHJvdyBuZXcgRXJyb3IoYFx1NTE2OFx1OTBFOFx1NEUwQlx1OEY3RFx1OTAxQVx1OTA1M1x1NTkzMVx1OEQyNSgke2xhc3RFcnJ9KWApO1xuICAgICAgY29uc3QgeyB3cml0ZUZpbGU6IHdmIH0gPSBhd2FpdCBpbXBvcnQoJ25vZGU6ZnMvcHJvbWlzZXMnKTtcbiAgICAgIGF3YWl0IHdmKGRlc3QsIGJ1Zik7XG4gICAgICBpbnN0YWxsZXJQYXRoID0gZGVzdDtcbiAgICAgIGJ1bXBVcGRhdGUoeyBkb3dubG9hZGVkOiB0cnVlIH0pO1xuICAgICAgbG9nSW5mbygndXBkYXRlJywgYFx1NURGMlx1NEUwQlx1OEY3RCAke2Fzc2V0Lm5hbWV9KCR7TWF0aC5yb3VuZChidWYubGVuZ3RoIC8gMWU2KX1NQikgXHUyMTkyICR7ZGVzdH1gKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGJ1bXBVcGRhdGUoeyBlcnJvcjogYFx1NEUwQlx1OEY3RFx1NTkzMVx1OEQyNTogJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApfWAgfSk7XG4gICAgfVxuICB9XG4gIGZ1bmN0aW9uIGFwcGx5VXBkYXRlKCk6IHZvaWQge1xuICAgIGlmIChpbnN0YWxsZXJQYXRoID09PSBudWxsKSByZXR1cm47XG4gICAgLy8gXHU5MDAwXHU1MUZBXHU1RjUzXHU1MjREXHU1RTk0XHU3NTI4XHU1NDBFXHU3NTMxXHU1Qjg5XHU4OEM1XHU1NjY4XHU5NzU5XHU5RUQ4XHU4OTg2XHU3NkQ2XHU1Qjg5XHU4OEM1KFx1ODhDNVx1NTZERVx1NTM5Rlx1NzZFRVx1NUY1NSlcdTMwMDJOU0lTIGFzc2lzdGVkIFx1ODlDNFx1NTIxOTpcbiAgICAvLyAvUyBcdTRFMTQgL0Q9cGF0aCBcdTVGQzVcdTk4N0JcdTY3MDBcdTU0MEVcdTRFMDBcdTRFMkFcdTUzQzJcdTY1NzBcdTMwMDFcdTUwM0NcdTRFMERcdTUyQTBcdTVGMTVcdTUzRjcoXHU1NDJCXHU3QTdBXHU2ODNDXHU0RTVGXHU0RTBEXHU1MkEwKVx1MjAxNFx1MjAxNG5vZGUgc3Bhd25cbiAgICAvLyBcdTlFRDhcdThCQTRcdTRGMUFcdTdFRDlcdTU0MkJcdTdBN0FcdTY4M0NcdTUzQzJcdTY1NzBcdTUyQTBcdTVGMTVcdTUzRjdcdTVCRkNcdTgxRjQgTlNJUyBcdTg5RTNcdTY3OTBcdTk1MTlcdThERUZcdTVGODQoXHU1QjlFXHU2RDRCXHU4OEM1XHU1NzRGXHU3NkVFXHU1RjU1KSxcdTY1NDVcdTc1MjhcbiAgICAvLyB3aW5kb3dzVmVyYmF0aW1Bcmd1bWVudHMgXHU1MzlGXHU2ODM3XHU0RjIwXHU5MDEyXHUzMDAyXG4gICAgY29uc3QgaW5zdGFsbERpciA9IGRpcm5hbWUocHJvY2Vzcy5leGVjUGF0aCk7XG4gICAgY29uc3QgY2hpbGQgPSBzcGF3bihgXCIke2luc3RhbGxlclBhdGh9XCIgL1MgL0Q9JHtpbnN0YWxsRGlyfWAsIHtcbiAgICAgIGRldGFjaGVkOiB0cnVlLFxuICAgICAgc3RkaW86ICdpZ25vcmUnLFxuICAgICAgd2luZG93c0hpZGU6IHRydWUsXG4gICAgICBzaGVsbDogZmFsc2UsXG4gICAgICB3aW5kb3dzVmVyYmF0aW1Bcmd1bWVudHM6IHRydWUsXG4gICAgfSk7XG4gICAgY2hpbGQudW5yZWYoKTtcbiAgICBsb2dJbmZvKCd1cGRhdGUnLCBgYXBwbHk6ICR7aW5zdGFsbGVyUGF0aH0gXHUyMTkyICR7aW5zdGFsbERpcn1gKTtcbiAgICBhcHAuZXhpdCgwKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGJ1aWxkQXBwTWVudSgpOiB2b2lkIHtcbiAgICAvLyBcdTdDQkVcdTdCODA6XHU1M0VBXHU0RkREXHU3NTU5IFVJIFx1NkNBMVx1NjcwOVx1NzY4NFx1N0NGQlx1N0VERlx1N0VBN1x1ODBGRFx1NTI5QihcdTUyNkFcdThEMzRcdTY3N0YvXHU3QTk3XHU1M0UzKTtcdTUxNzZcdTRGNTlcdTU1MkZcdTRFMDBcdTUxNjVcdTUzRTNcdTU3MjggVUlcdTMwMDJcbiAgICBjb25zdCB0ZW1wbGF0ZTogQXJyYXk8RWxlY3Ryb24uTWVudUl0ZW1Db25zdHJ1Y3Rvck9wdGlvbnM+ID0gW1xuICAgICAge1xuICAgICAgICBsYWJlbDogJ1x1N0YxNlx1OEY5MScsXG4gICAgICAgIHN1Ym1lbnU6IFtcbiAgICAgICAgICB7IHJvbGU6ICd1bmRvJywgbGFiZWw6ICdcdTY0QTRcdTk1MDAnIH0sXG4gICAgICAgICAgeyByb2xlOiAncmVkbycsIGxhYmVsOiAnXHU5MUNEXHU1MDVBJyB9LFxuICAgICAgICAgIHsgdHlwZTogJ3NlcGFyYXRvcicgfSxcbiAgICAgICAgICB7IHJvbGU6ICdjdXQnLCBsYWJlbDogJ1x1NTI2QVx1NTIwNycgfSxcbiAgICAgICAgICB7IHJvbGU6ICdjb3B5JywgbGFiZWw6ICdcdTU5MERcdTUyMzYnIH0sXG4gICAgICAgICAgeyByb2xlOiAncGFzdGUnLCBsYWJlbDogJ1x1N0M5OFx1OEQzNCcgfSxcbiAgICAgICAgICB7IHJvbGU6ICdzZWxlY3RBbGwnLCBsYWJlbDogJ1x1NTE2OFx1OTAwOScgfSxcbiAgICAgICAgXSxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIGxhYmVsOiAnXHU3QTk3XHU1M0UzJyxcbiAgICAgICAgc3VibWVudTogW1xuICAgICAgICAgIHsgcm9sZTogJ21pbmltaXplJywgbGFiZWw6ICdcdTY3MDBcdTVDMEZcdTUzMTYnIH0sXG4gICAgICAgICAgeyByb2xlOiAnem9vbScsIGxhYmVsOiAnXHU3RjI5XHU2NTNFJyB9LFxuICAgICAgICAgIHsgdHlwZTogJ3NlcGFyYXRvcicgfSxcbiAgICAgICAgICB7IHJvbGU6ICdjbG9zZScsIGxhYmVsOiAnXHU1MTczXHU5NUVEJyB9LFxuICAgICAgICBdLFxuICAgICAgfSxcbiAgICBdO1xuICAgIE1lbnUuc2V0QXBwbGljYXRpb25NZW51KE1lbnUuYnVpbGRGcm9tVGVtcGxhdGUodGVtcGxhdGUpKTtcbiAgfVxuICAvKiogXHU2ODA3XHU5ODk4XHU2ODBGIFx1MjYzMCBcdTRFM0JcdTgzRENcdTUzNTUoXHU1RTM4XHU3NTI4XHU1MkE4XHU0RjVDXHU3Njg0XHU1NTJGXHU0RTAwXHU1MTY1XHU1M0UzO1x1ODlDNlx1NTZGRVx1NjAwMVx1N0VDRiBtZW51OmFjdGlvbiBcdThGNkNcdTUzRDEpXHUzMDAyICovXG4gIGZ1bmN0aW9uIHBvcHVwTWFpbk1lbnUoKTogdm9pZCB7XG4gICAgY29uc3Qgc2VuZCA9IChhOiBzdHJpbmcpOiB2b2lkID0+IHtcbiAgICAgIGZvciAoY29uc3QgdyBvZiBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKSkge1xuICAgICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCdtZW51OmFjdGlvbicsIGEpO1xuICAgICAgfVxuICAgIH07XG4gICAgY29uc3Qgd2luID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkuZmluZCgodykgPT4gIXcuaXNEZXN0cm95ZWQoKSk7XG4gICAgaWYgKHdpbiA9PT0gdW5kZWZpbmVkKSByZXR1cm47XG4gICAgTWVudS5idWlsZEZyb21UZW1wbGF0ZShbXG4gICAgICB7IGxhYmVsOiAnXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREJywgYWNjZWxlcmF0b3I6ICdDbWRPckN0cmwrTicsIGNsaWNrOiAoKTogdm9pZCA9PiBzZW5kKCduZXctc2Vzc2lvbicpIH0sXG4gICAgICB7IGxhYmVsOiAnXHU4QkJFXHU3RjZFJywgYWNjZWxlcmF0b3I6ICdDbWRPckN0cmwrU2hpZnQrUCcsIGNsaWNrOiAoKTogdm9pZCA9PiBzZW5kKCdvcGVuLXNldHRpbmdzJykgfSxcbiAgICAgIHsgbGFiZWw6ICdcdTVGRUJcdTYzNzdcdTk1MkUnLCBhY2NlbGVyYXRvcjogJ0NtZE9yQ3RybCsvJywgY2xpY2s6ICgpOiB2b2lkID0+IHNlbmQoJ3Nob3J0Y3V0cycpIH0sXG4gICAgICB7IHR5cGU6ICdzZXBhcmF0b3InIH0sXG4gICAgICB7IGxhYmVsOiAnXHU2MjRCXHU2NzNBXHU4RkRDXHU3QTBCXHU2M0E3XHU1MjM2JywgY2xpY2s6ICgpOiB2b2lkID0+IHNlbmQoJ29wZW4tcmVtb3RlJykgfSxcbiAgICAgIHsgdHlwZTogJ3NlcGFyYXRvcicgfSxcbiAgICAgIHtcbiAgICAgICAgbGFiZWw6IHVwZGF0ZVN0YXRlLmRvd25sb2FkZWQgPyBgXHU5MUNEXHU1NDJGXHU1RTc2XHU1Qjg5XHU4OEM1XHU2NkY0XHU2NUIwKHYke3VwZGF0ZVN0YXRlLmxhdGVzdCA/PyAnPyd9KWAgOiAnXHU2OEMwXHU2N0U1XHU2NkY0XHU2NUIwXHUyMDI2JyxcbiAgICAgICAgY2xpY2s6ICgpOiB2b2lkID0+IHtcbiAgICAgICAgICBpZiAodXBkYXRlU3RhdGUuZG93bmxvYWRlZCkgeyBhcHBseVVwZGF0ZSgpOyByZXR1cm47IH1cbiAgICAgICAgICB2b2lkIGNoZWNrRm9yVXBkYXRlcygpLnRoZW4oKHN0KSA9PiB7XG4gICAgICAgICAgICBjb25zdCBuZXdlciA9IHN0LmxhdGVzdCAhPT0gbnVsbCAmJiBjbXBWZXJzaW9uKHN0LmN1cnJlbnRWZXJzaW9uLCBzdC5sYXRlc3QpIDwgMDtcbiAgICAgICAgICAgIGNvbnN0IGRldGFpbCA9IG5ld2VyID8gYCR7c3Qubm90ZXN9XFxuXFxuXHU1Qjg5XHU4OEM1XHU1MzA1XHU2QjYzXHU1NzI4XHU1NDBFXHU1M0YwXHU0RTBCXHU4RjdELFx1NUI4Q1x1NjIxMFx1NTQwRSBcdTI2MzAgXHU4M0RDXHU1MzU1XHU0RjFBXHU1MUZBXHU3M0IwXCJcdTkxQ0RcdTU0MkZcdTVFNzZcdTVCODlcdTg4QzVcdTY2RjRcdTY1QjBcIlx1MzAwMmAgOiAnJztcbiAgICAgICAgICAgIHZvaWQgZGlhbG9nLnNob3dNZXNzYWdlQm94KHdpbiwge1xuICAgICAgICAgICAgICB0eXBlOiAnaW5mbycsXG4gICAgICAgICAgICAgIHRpdGxlOiAnXHU2OEMwXHU2N0U1XHU2NkY0XHU2NUIwJyxcbiAgICAgICAgICAgICAgbWVzc2FnZTogbmV3ZXJcbiAgICAgICAgICAgICAgICA/IGBcdTUzRDFcdTczQjBcdTY1QjBcdTcyNDhcdTY3MkMgdiR7c3QubGF0ZXN0fSFgXG4gICAgICAgICAgICAgICAgOiAoc3QuZXJyb3IgIT09ICcnID8gYFx1NjhDMFx1NjdFNVx1NTkzMVx1OEQyNToke3N0LmVycm9yfWAgOiBgXHU1REYyXHU2NjJGXHU2NzAwXHU2NUIwXHU3MjQ4XHU2NzJDKHYke3N0LmN1cnJlbnRWZXJzaW9ufSlgKSxcbiAgICAgICAgICAgICAgZGV0YWlsLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfSk7XG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBsYWJlbDogJ1x1NTE3M1x1NEU4RSBITUggRGVza3RvcCcsXG4gICAgICAgIGNsaWNrOiAoKTogdm9pZCA9PiB7XG4gICAgICAgICAgdm9pZCBkaWFsb2cuc2hvd01lc3NhZ2VCb3god2luLCB7XG4gICAgICAgICAgICB0eXBlOiAnaW5mbycsXG4gICAgICAgICAgICB0aXRsZTogJ1x1NTE3M1x1NEU4RSBITUggRGVza3RvcCcsXG4gICAgICAgICAgICBtZXNzYWdlOiAnSE1IIERlc2t0b3AnLFxuICAgICAgICAgICAgZGV0YWlsOiBgXHU2NzJDXHU1NzMwXHU0RjE4XHU1MTQ4XHU3Njg0IEhNSCBBZ2VudCBcdTU2RkVcdTVGNjJcdTVERTVcdTRGNUNcdTUzRjAgdiR7YXBwLmdldFZlcnNpb24oKX1cXG5ydW50aW1lOiBobWhhcm5lc3MgJHticmlkZ2UuaG9zdFZlcnNpb24gPz8gJyhcdTY3MkFcdThGREVcdTYzQTUpJ30ke3VzZUJ1bmRsZWRSdW50aW1lID8gJyhcdTUxODVcdTdGNkUpJyA6ICcnfVxcblx1NkEyMVx1NUYwRjogJHticmlkZ2UubW9kZSA9PT0gJ3JlYWwnID8gKHVzZUJ1bmRsZWRSdW50aW1lID8gJ1x1NzcxRlx1NUI5RSBobWhhcm5lc3MoXHU1MTg1XHU3RjZFIHJ1bnRpbWUpJyA6ICdcdTc3MUZcdTVCOUUgaG1oYXJuZXNzKFx1NTkxNlx1OTBFOFx1NUI4OVx1ODhDNSknKSA6ICdcdTZGMTRcdTc5M0EoXHU1MDQ3XHU2NTcwXHU2MzZFKSd9XFxuXFxuXHU0RTBFIENMSSAvIFRVSSAvIFx1N0Y1MVx1OTg3NVx1NzI0OFx1NTE3MVx1NEVBQlx1NTQwQ1x1NEUwMCBITUhfSE9NRVx1MzAwMmAsXG4gICAgICAgICAgfSk7XG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAgeyBsYWJlbDogJ1x1OTAwMFx1NTFGQScsIHJvbGU6ICdxdWl0JyB9LFxuICAgIF0pLnBvcHVwKHsgd2luZG93OiB3aW4gfSk7XG4gIH1cblxuICAvKiAtLS0tIFx1NjI0Qlx1NjczQVx1OEZEQ1x1N0EwQlx1NjNBN1x1NTIzNigwMyBcdTUzRjc6V2ViIDc3ODggXHU2NjJGXHU2RDRGXHU4OUM4XHU1NjY4L1x1OEZEQ1x1N0EwQi9cdTYyNEJcdTY3M0FcdTUxNjVcdTUzRTMsQURSLTAwNTpcbiAgICAgRGVza3RvcCBcdTRFMERcdTlFRDhcdThCQTRcdTYyNTNcdTVGMDAgTEFOIFx1MjAxNFx1MjAxNCBcdThGRDlcdTkxQ0NcdTY2MkZcdTc1MjhcdTYyMzdcdTY2M0VcdTVGMEZcdTU0MkZcdTUyQThcdTc2ODRcdTUxNjVcdTUzRTMpIC0tLS0gKi9cbiAgY29uc3QgV0VCX1BPUlQgPSA3Nzg4O1xuICBhc3luYyBmdW5jdGlvbiBwcm9iZVdlYlJlbW90ZSgpOiBQcm9taXNlPHsgdXA6IGJvb2xlYW47IHZlcnNpb246IHN0cmluZyB9PiB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHIgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke1dFQl9QT1JUfS9hcGkvc3RhdGVgLCB7IHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCgxNTAwKSB9KTtcbiAgICAgIGlmICghci5vaykgcmV0dXJuIHsgdXA6IGZhbHNlLCB2ZXJzaW9uOiAnJyB9O1xuICAgICAgY29uc3QgZCA9IChhd2FpdCByLmpzb24oKSkgYXMgeyBkYWVtb25WZXJzaW9uPzogc3RyaW5nIH07XG4gICAgICByZXR1cm4geyB1cDogdHJ1ZSwgdmVyc2lvbjogU3RyaW5nKGQuZGFlbW9uVmVyc2lvbiA/PyAnJykgfTtcbiAgICB9IGNhdGNoIHsgcmV0dXJuIHsgdXA6IGZhbHNlLCB2ZXJzaW9uOiAnJyB9OyB9XG4gIH1cbiAgLyoqIFx1NUYwMFx1NjczQVx1ODFFQVx1NTQyRlx1NjYyRlx1NTQyNlx1NURGMlx1ODhDNShydW50aW1lIHdlYi1kYWVtb24gXHU3Njg0XHU1NDJGXHU1MkE4XHU5ODc5XHU2NTg3XHU0RUY2XHU1QjU4XHU1NzI4XHU2MDI3OzAuMjMuMzcgXHU2NUIwXHU4MEZEXHU1MjlCKVx1MzAwMiAqL1xuICBmdW5jdGlvbiB3ZWJBdXRvc3RhcnRJbnN0YWxsZWQoKTogYm9vbGVhbiB7XG4gICAgY29uc3QgaG9tZSA9IHByb2Nlc3MuZW52LkhPTUUgPz8gJyc7XG4gICAgY29uc3QgY2FuZGlkYXRlcyA9IHByb2Nlc3MucGxhdGZvcm0gPT09ICd3aW4zMidcbiAgICAgID8gW2pvaW4ocHJvY2Vzcy5lbnYuQVBQREFUQSA/PyAnJywgJ01pY3Jvc29mdCcsICdXaW5kb3dzJywgJ1N0YXJ0IE1lbnUnLCAnUHJvZ3JhbXMnLCAnU3RhcnR1cCcsICdobWhhcm5lc3Mtd2ViLWRhZW1vbi5jbWQnKV1cbiAgICAgIDogcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gJ2RhcndpbidcbiAgICAgICAgPyBbam9pbihob21lLCAnTGlicmFyeScsICdMYXVuY2hBZ2VudHMnLCAnaG1oYXJuZXNzLXdlYi1kYWVtb24ucGxpc3QnKV1cbiAgICAgICAgOiBbam9pbihob21lLCAnLmNvbmZpZycsICdzeXN0ZW1kJywgJ3VzZXInLCAnaG1oYXJuZXNzLXdlYi1kYWVtb24uc2VydmljZScpXTtcbiAgICByZXR1cm4gY2FuZGlkYXRlcy5zb21lKChwKSA9PiB7IHRyeSB7IHJldHVybiBleGlzdHNTeW5jKHApOyB9IGNhdGNoIHsgcmV0dXJuIGZhbHNlOyB9IH0pO1xuICB9XG4gIC8qKiBcdTYyNEJcdTY3M0FcdTUzRUZcdThERUZcdTc1MzFcdTc2ODQgTEFOIElQKFJGQzE5MTgsXHU2MzkyXHU5NjY0XHU4NjVBXHU2MkRGXHU3RjUxXHU1MzYxKVx1MzAwMiAqL1xuICBmdW5jdGlvbiBsYW5JcE9mKCk6IHN0cmluZyB7XG4gICAgY29uc3QgVklSVFVBTCA9IC92bXdhcmV8dmlydHVhbHxoeXBlci0/dnx2ZXRoZXJuZXR8d3NsfHRhaWxzY2FsZXxsb29wYmFja3xibHVldG9vdGh8dmJveHxkb2NrZXJ8dGFwLXxwc2V1ZG8vaTtcbiAgICBjb25zdCBpc1JmYzE5MTggPSAoYTogc3RyaW5nKTogYm9vbGVhbiA9PiAvXjEwXFwuLy50ZXN0KGEpIHx8IC9eMTkyXFwuMTY4XFwuLy50ZXN0KGEpIHx8IC9eMTcyXFwuKDFbNi05XXwyXFxkfDNbMDFdKVxcLi8udGVzdChhKTtcbiAgICBsZXQgbGFuSXAgPSAnJztcbiAgICBsZXQgZmFsbGJhY2sgPSAnJztcbiAgICBmb3IgKGNvbnN0IFtuYW1lLCBsaXN0XSBvZiBPYmplY3QuZW50cmllcyhuZXR3b3JrSW50ZXJmYWNlcygpKSkge1xuICAgICAgZm9yIChjb25zdCBuIG9mIGxpc3QgPz8gW10pIHtcbiAgICAgICAgaWYgKG4uZmFtaWx5ICE9PSAnSVB2NCcgfHwgbi5pbnRlcm5hbCB8fCAhaXNSZmMxOTE4KG4uYWRkcmVzcykpIGNvbnRpbnVlO1xuICAgICAgICBpZiAoIVZJUlRVQUwudGVzdChuYW1lKSkgbGFuSXAgPSBsYW5JcCB8fCBuLmFkZHJlc3M7XG4gICAgICAgIGVsc2UgZmFsbGJhY2sgPSBmYWxsYmFjayB8fCBuLmFkZHJlc3M7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBsYW5JcCB8fCBmYWxsYmFjaztcbiAgfVxuICAvKiogQ0xJIFx1NTE2NVx1NTNFMyhydW50aW1lIFx1ODFFQVx1NTJBOFx1NTNEMVx1NzNCMFx1NzY4NCByZXBvO2Zha2UgXHU2QTIxXHU1RjBGXHU2NUUwIHJlcG8gXHU4RkQ0XHU1NkRFXHU3QTdBKVx1MzAwMiAqL1xuICBmdW5jdGlvbiBjbGlFbnRyeU9mKCk6IHN0cmluZyB7XG4gICAgaWYgKHJ1bnRpbWVFbnRyeSA9PT0gbnVsbCkgcmV0dXJuICcnO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBwID0gam9pbihyZXBvUm9vdE9mKHJ1bnRpbWVFbnRyeSksICdwYWNrYWdlcycsICdjbGknLCAnc3JjJywgJ21haW4udHMnKTtcbiAgICAgIHJldHVybiBleGlzdHNTeW5jKHApID8gcCA6ICcnO1xuICAgIH0gY2F0Y2ggeyByZXR1cm4gJyc7IH1cbiAgfVxuICBmdW5jdGlvbiBydW5DbGkoYXJnczogc3RyaW5nW10pOiB2b2lkIHtcbiAgICBjb25zdCBlbnRyeSA9IGNsaUVudHJ5T2YoKTtcbiAgICBpZiAoZW50cnkgPT09ICcnKSByZXR1cm47XG4gICAgY29uc3QgcmVwbyA9IHJlcG9Sb290T2YocnVudGltZUVudHJ5ID8/IGVudHJ5KTtcbiAgICBjb25zdCBjaGlsZCA9IHNwYXduKHByb2Nlc3MuZXhlY1BhdGgsIFsnLS1pbXBvcnQnLCAndHN4JywgZW50cnksIC4uLmFyZ3NdLCB7XG4gICAgICBjd2Q6IHJlcG8sXG4gICAgICBkZXRhY2hlZDogdHJ1ZSxcbiAgICAgIHN0ZGlvOiAnaWdub3JlJyxcbiAgICAgIHdpbmRvd3NIaWRlOiB0cnVlLFxuICAgICAgZW52OiB7IEVMRUNUUk9OX1JVTl9BU19OT0RFOiAnMScgfSxcbiAgICB9KTtcbiAgICBjaGlsZC51bnJlZigpO1xuICB9XG5cbiAgZnVuY3Rpb24gYnJvYWRjYXN0SG9zdFN0YXRlKHM6IEhvc3RTdGF0ZSwgaW5mbzogeyByZXN0YXJ0Q291bnQ6IG51bWJlcjsgbGFzdEVycm9yPzogc3RyaW5nIH0pOiB2b2lkIHtcbiAgICBicmlkZ2UgPSB7IC4uLmJyaWRnZSwgaG9zdFN0YXRlOiBzLCBob3N0UG9ydDogc3VwZXJ2aXNvcj8uZW5kcG9pbnQ/LnBvcnQgPz8gbnVsbCwgaG9zdFZlcnNpb246IHN1cGVydmlzb3I/LmVuZHBvaW50Py52ZXJzaW9uID8/IG51bGwgfTtcbiAgICBsb2dJbmZvKCdob3N0JywgYHN0YXRlPSR7c30ke2luZm8ubGFzdEVycm9yICE9PSB1bmRlZmluZWQgPyBgIGVycj0ke2luZm8ubGFzdEVycm9yfWAgOiAnJ31gKTtcbiAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcbiAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ2JyaWRnZTpob3N0LXN0YXRlJywgcywgaW5mbyk7XG4gICAgfVxuICB9XG5cbiAgLyoqIFNTRSBcdTZENDFcdThCQTJcdTk2MDU6XHU0RkUxXHU1QzAxKGV2ZW50OiBobWgpXHU2Mjc5XHU5MUNGXHU2M0E4IHJlbmRlcmVyO1x1OUFEOFx1OTg5MSBkZWx0YS9saW5lIFx1NTM5Rlx1NUUyN1xuICAgKiAgXHU0RjVDXHU0RTNBXHU2RDQxXHU1NzU3XHU4RjZDXHU1M0QxKHJlbmRlcmVyIFx1NjJGQ1x1NjNBNVx1NUY1M1x1NTI0RCBhc3Npc3RhbnQgXHU1MzYwXHU0RjREKVx1MzAwMlx1NjVBRFx1N0VCRlx1ODFFQVx1NTJBOFx1OTFDRFx1OEZERVx1MzAwMiAqL1xuICBhc3luYyBmdW5jdGlvbiBwdW1wRXZlbnRzKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmIChjbGllbnQgPT09IG51bGwpIHJldHVybjtcbiAgICBmb3IgKDs7KSB7XG4gICAgICBjb25zdCBjID0gY2xpZW50O1xuICAgICAgaWYgKGMgPT09IG51bGwpIHJldHVybjtcbiAgICAgIHRyeSB7XG4gICAgICAgIGZvciBhd2FpdCAoY29uc3QgZnJhbWUgb2YgYy5yYXdFdmVudHMobGFzdEV2ZW50SWQgPT09ICcnID8gdW5kZWZpbmVkIDogbGFzdEV2ZW50SWQsIHNzZUFib3J0Py5zaWduYWwpKSB7XG4gICAgICAgICAgaWYgKGZyYW1lLmV2ZW50ID09PSAnaG1oJykge1xuICAgICAgICAgICAgY29uc3QgZW52ID0gZW52ZWxvcGVGcm9tRnJhbWUoZnJhbWUpO1xuICAgICAgICAgICAgaWYgKGVudiA9PT0gbnVsbCkge1xuICAgICAgICAgICAgICBkcm9wcGVkRnJhbWVzICs9IDE7XG4gICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgbGFzdEV2ZW50SWQgPSBlbnYuZXZlbnRJZDtcbiAgICAgICAgICAgIHB1c2hFdmVudChlbnYpO1xuICAgICAgICAgIH0gZWxzZSBpZiAoZnJhbWUuZXZlbnQgPT09ICdkZWx0YScgfHwgZnJhbWUuZXZlbnQgPT09ICdsaW5lJykge1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgY29uc3QgZCA9IEpTT04ucGFyc2UoZnJhbWUuZGF0YSkgYXMgeyBzZXNzaW9uSWQ/OiBzdHJpbmc7IGs/OiBzdHJpbmc7IGNodW5rPzogc3RyaW5nOyB0ZXh0Pzogc3RyaW5nIH07XG4gICAgICAgICAgICAgIGNvbnN0IHBheWxvYWQgPSBmcmFtZS5ldmVudCA9PT0gJ2RlbHRhJ1xuICAgICAgICAgICAgICAgID8geyBzZXNzaW9uSWQ6IGQuc2Vzc2lvbklkID8/ICcnLCBraW5kOiBkLmsgPz8gJ3RleHQnLCBjaHVuazogU3RyaW5nKGQuY2h1bmsgPz8gJycpIH1cbiAgICAgICAgICAgICAgICA6IHsgc2Vzc2lvbklkOiBkLnNlc3Npb25JZCA/PyAnJywga2luZDogJ2xpbmUnLCBjaHVuazogU3RyaW5nKGQudGV4dCA/PyAnJykgfTtcbiAgICAgICAgICAgICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XG4gICAgICAgICAgICAgICAgaWYgKCF3LmlzRGVzdHJveWVkKCkpIHcud2ViQ29udGVudHMuc2VuZCgnYnJpZGdlOnN0cmVhbS1jaHVuaycsIHBheWxvYWQpO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGNhdGNoIHsgLyogbWFsZm9ybWVkIHN0cmVhbSBmcmFtZTogc2tpcCAqLyB9XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHJldHVybjsgLy8gXHU2RDQxXHU2QjYzXHU1RTM4XHU3RUQzXHU2NzVGKGhvc3QgXHU1MTczXHU5NUVEKVxuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8vIFx1NjVBRFx1N0VCRjpcdTc3RURcdTkwMDBcdTkwN0ZcdTU0MEVcdTkxQ0RcdThGREUoc3VwZXJ2aXNvciBcdTUzRUZcdTgwRkRcdTZCNjNcdTU3MjhcdTkxQ0RcdTU0MkYgaG9zdClcbiAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgMV8wMDApKTtcbiAgICAgICAgaWYgKHNzZUFib3J0Py5zaWduYWwuYWJvcnRlZCkgcmV0dXJuO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8qIC0tLS0gaG1oYXJuZXNzIHJ1bnRpbWUgXHU4MUVBXHU1MkE4XHU1M0QxXHU3M0IwKDIwMjYtMTAtMTAgXHU3NTI4XHU2MjM3XHU1QjlBXHU4QzAzOlx1ODhDNVx1OEZDNyBobWhhcm5lc3MgXHU3Njg0XG4gICAgIFx1NjczQVx1NTY2OFx1OTZGNlx1OTE0RFx1N0Y2RVx1NzZGNFx1OEZERSxcdTU5MERcdTc1MjggQ0xJL1RVSS93ZWIgNzc4OCBcdTc2ODRcdTU0MENcdTRFMDAgSE1IX0hPTUVcdTIwMTRcdTIwMTRjb25maWcvcHJvdmlkZXJzL1xuICAgICBcdTRGMUFcdThCRERcdTUzODZcdTUzRjJcdTU5MjlcdTcxMzZcdTUxNzFcdTRFQUIpXHUzMDAyXHU1M0QxXHU3M0IwXHU5ODdBXHU1RThGOlx1NjYzRVx1NUYwRlx1OTE0RFx1N0Y2RSA+IHdoZXJlIGhtaCA+IG5wbSBcdTUxNjhcdTVDNDAgPiBcdTVFMzhcdTg5QzFcdTZFOTBcdTc4MDFcdTRGNERcdTdGNkVcdTMwMDIgKi9cbiAgY29uc3QgcnVudGltZUNvbmZpZ0ZpbGUgPSAoKTogc3RyaW5nID0+IGpvaW4oYXBwLmdldFBhdGgoJ3VzZXJEYXRhJyksICdydW50aW1lLmpzb24nKTtcbiAgYXN5bmMgZnVuY3Rpb24gbG9hZFJ1bnRpbWVFbnRyeU92ZXJyaWRlKCk6IFByb21pc2U8c3RyaW5nPiB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHYgPSBKU09OLnBhcnNlKGF3YWl0IHJlYWRGaWxlKHJ1bnRpbWVDb25maWdGaWxlKCksICd1dGY4JykpIGFzIHsgZW50cnk/OiB1bmtub3duIH07XG4gICAgICByZXR1cm4gdHlwZW9mIHYuZW50cnkgPT09ICdzdHJpbmcnICYmIHYuZW50cnkgIT09ICcnICYmIGlzQWJzb2x1dGUodi5lbnRyeSkgPyB2LmVudHJ5IDogJyc7XG4gICAgfSBjYXRjaCB7IHJldHVybiAnJzsgfVxuICB9XG4gIGFzeW5jIGZ1bmN0aW9uIHNhdmVSdW50aW1lRW50cnlPdmVycmlkZShlbnRyeTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgYXdhaXQgd3JpdGVGaWxlKHJ1bnRpbWVDb25maWdGaWxlKCksIEpTT04uc3RyaW5naWZ5KHsgZW50cnkgfSwgbnVsbCwgMiksICd1dGY4JykuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGRldGVjdFJlYWxFbnRyeSgpOiBzdHJpbmcge1xuICAgIC8vIDEpIFx1NzNBRlx1NTg4M1x1NTNEOFx1OTFDRlx1NjYzRVx1NUYwRlx1ODk4Nlx1NzZENihcdTlBRDhcdTdFQTdcdTc1MjhcdTYyMzcpXG4gICAgY29uc3QgZW52RW50cnkgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9SRUFMX0VOVFJZO1xuICAgIGlmIChlbnZFbnRyeSAhPT0gdW5kZWZpbmVkICYmIGVudkVudHJ5ICE9PSAnJyAmJiBpc0Fic29sdXRlKGVudkVudHJ5KSkgcmV0dXJuIGVudkVudHJ5O1xuXG4gICAgY29uc3QgcmVwb3MgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgICAvLyAyKSB3aGVyZSBobWg6bnBtIGxpbmsvXHU1MTY4XHU1QzQwXHU1Qjg5XHU4OEM1XHU3Njg0IGJpbiBcdTIxOTIgbm9kZV9tb2R1bGVzL2htaGFybmVzcyBcdTIxOTIgXHU3NzFGIHJlcG8obnBtIGxpbmsgXHU2NjJGIHN5bWxpbmspXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IG91dCA9IGV4ZWNGaWxlU3luYygnd2hlcmUnLCBbJ2htaCddLCB7IGVuY29kaW5nOiAndXRmOCcsIHRpbWVvdXQ6IDRfMDAwLCB3aW5kb3dzSGlkZTogdHJ1ZSB9KTtcbiAgICAgIGZvciAoY29uc3QgbGluZSBvZiBvdXQuc3BsaXQoL1xccj9cXG4vKSkge1xuICAgICAgICBjb25zdCBiaW4gPSBsaW5lLnRyaW0oKTtcbiAgICAgICAgaWYgKGJpbiA9PT0gJycpIGNvbnRpbnVlO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IGxpbmtlZCA9IGpvaW4oZGlybmFtZShiaW4pLCAnbm9kZV9tb2R1bGVzJywgJ2htaGFybmVzcycpO1xuICAgICAgICAgIGlmIChleGlzdHNTeW5jKGxpbmtlZCkpIHJlcG9zLmFkZChyZWFscGF0aFN5bmMobGlua2VkKSk7XG4gICAgICAgIH0gY2F0Y2ggeyAvKiBiaW4gXHU1RTAzXHU1QzQwXHU0RTBEXHU3QjI2LFx1OERGM1x1OEZDNyAqLyB9XG4gICAgICB9XG4gICAgfSBjYXRjaCB7IC8qIGhtaCBcdTRFMERcdTU3MjggUEFUSCAqLyB9XG4gICAgLy8gMykgbnBtIFx1NTE2OFx1NUM0MFx1NjgzOVxuICAgIHRyeSB7XG4gICAgICBjb25zdCBvdXQgPSBleGVjRmlsZVN5bmMoJ25wbScsIFsncm9vdCcsICctZyddLCB7IGVuY29kaW5nOiAndXRmOCcsIHRpbWVvdXQ6IDZfMDAwLCB3aW5kb3dzSGlkZTogdHJ1ZSB9KTtcbiAgICAgIGNvbnN0IHAgPSBqb2luKG91dC50cmltKCksICdobWhhcm5lc3MnKTtcbiAgICAgIGlmIChleGlzdHNTeW5jKHApKSByZXBvcy5hZGQocmVhbHBhdGhTeW5jKHApKTtcbiAgICB9IGNhdGNoIHsgLyogbnBtIFx1NEUwRFx1NTNFRlx1NzUyOCAqLyB9XG4gICAgLy8gNCkgXHU1RTM4XHU4OUMxXHU2RTkwXHU3ODAxXHU0RjREXHU3RjZFKFx1NjcyQ1x1NjczQVx1NUYwMFx1NTNEMVx1NUUwM1x1NUM0MClcbiAgICBjb25zdCBiYXNlcyA9IFsnQzpcXFxcJywgJ0Q6XFxcXCcsICdFOlxcXFwnLCAnRjpcXFxcJywgJ0c6XFxcXCcsICdIOlxcXFwnLCBob21lZGlyKCksIGpvaW4oaG9tZWRpcigpLCAnRGV2ZWxvcGVyJyldO1xuICAgIGZvciAoY29uc3QgYmFzZSBvZiBiYXNlcykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcCA9IHJlc29sdmUoYmFzZSwgJ2htaGFybmVzcycpO1xuICAgICAgICBpZiAoZXhpc3RzU3luYyhwKSkgcmVwb3MuYWRkKHApO1xuICAgICAgfSBjYXRjaCB7IC8qIFx1NzZEOFx1NEUwRFx1NUI1OFx1NTcyOCAqLyB9XG4gICAgfVxuICAgIC8vIFx1NTQ3RFx1NEUyRFx1NzY4NCByZXBvIFx1NUZDNVx1OTg3Qlx1NjcwOSBkZXNrdG9wLWhvc3QgXHU1MTY1XHU1M0UzXHU0RTBFXHU0RjlEXHU4RDU2XHU1RTAzXHU1QzQwXG4gICAgZm9yIChjb25zdCByZXBvIG9mIHJlcG9zKSB7XG4gICAgICBjb25zdCBlbnRyeSA9IGpvaW4ocmVwbywgJ3BhY2thZ2VzJywgJ3dlYicsICdzcmMnLCAnZGVza3RvcC1ob3N0LnRzJyk7XG4gICAgICBpZiAoZXhpc3RzU3luYyhlbnRyeSkgJiYgZXhpc3RzU3luYyhqb2luKHJlcG8sICdub2RlX21vZHVsZXMnKSkpIHJldHVybiBlbnRyeTtcbiAgICB9XG4gICAgcmV0dXJuICcnO1xuICB9XG5cbiAgLyoqIFx1ODlFM1x1Njc5MCBydW50aW1lIFx1NTE2NVx1NTNFM1x1NjI0MFx1NUM1RVx1NzY4NCBobWhhcm5lc3MgXHU0RUQzXHU1RTkzXHU2ODM5KHBhY2thZ2VzL3dlYi9zcmN8ZGlzdCBcdTRFMEFcdTZFQUYpXHUzMDAyICovXG4gIGZ1bmN0aW9uIHJlcG9Sb290T2YoZW50cnk6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgbGV0IGRpciA9IGRpcm5hbWUoZW50cnkpO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgNjsgaSsrKSB7XG4gICAgICBpZiAoZXhpc3RzU3luYyhqb2luKGRpciwgJ3BhY2thZ2UuanNvbicpKSAmJiBleGlzdHNTeW5jKGpvaW4oZGlyLCAncGFja2FnZXMnLCAnd2ViJykpKSByZXR1cm4gZGlyO1xuICAgICAgY29uc3QgcGFyZW50ID0gZGlybmFtZShkaXIpO1xuICAgICAgaWYgKHBhcmVudCA9PT0gZGlyKSBicmVhaztcbiAgICAgIGRpciA9IHBhcmVudDtcbiAgICB9XG4gICAgcmV0dXJuIGRpcm5hbWUoZW50cnkpO1xuICB9XG5cbiAgbGV0IHJ1bnRpbWVFbnRyeSA9ICcnOyAvLyBcdTVGNTNcdTUyNERcdTVCOUVcdTk2NDVcdTRGN0ZcdTc1MjhcdTc2ODRcdTc3MUZcdTVCOUUgcnVudGltZSBcdTUxNjVcdTUzRTMoJyc9XHU2NzJBXHU2M0E1KVxuICBsZXQgdXNlQnVuZGxlZFJ1bnRpbWUgPSBmYWxzZTsgLy8gdjU6XHU2NjJGXHU1NDI2XHU1NzI4XHU3NTI4XHU1MTg1XHU3RjZFIHJ1bnRpbWUoXHU1MTczXHU0RThFL1x1OTc2Mlx1Njc3Rlx1NjgwN1x1NkNFOClcblxuICAvKiogXHU1MTg1XHU3RjZFIHJ1bnRpbWUodjUgXHU1RjAwXHU3QkIxXHU1MzczXHU3NTI4KTpcdTYyNTNcdTUzMDVcdTU0MEVcdTk2OEYgZXh0cmFSZXNvdXJjZXMgXHU1RTczXHU5NEZBXHU1NzI4IHJlc291cmNlcy87XG4gICAgIGRldiBcdTc1MjhcdTRFRDNcdTVFOTNcdTUxODVcdTY3ODRcdTVFRkFcdTRFQTdcdTcyNjkoc2NyaXB0cy9idW5kbGUtcnVudGltZS5tanMpXHUzMDAyXHU4MUVBXHU1MzA1XHU1NDJCXHU1MzU1XHU2NTg3XHU0RUY2LFx1NjVFMCB0c3hcdTMwMDFcbiAgICAgXHU2NUUwIHJlcG8gbm9kZV9tb2R1bGVzIFx1NEY5RFx1OEQ1Nlx1MzAwMiAqL1xuICBmdW5jdGlvbiBidW5kbGVkUnVudGltZVBhdGgocmVwb1Jvb3Q6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgcmV0dXJuIGpvaW4oYXBwLmlzUGFja2FnZWQgPyBwcm9jZXNzLnJlc291cmNlc1BhdGggOiBqb2luKHJlcG9Sb290LCAnYXBwcycsICdkZXNrdG9wJywgJ3Jlc291cmNlcycpLCAncnVudGltZScsICdydW50aW1lLmNqcycpO1xuICB9XG5cbiAgLyoqIFx1NTNEMVx1NzNCMFx1OTg3QVx1NUU4RjpcdTY2M0VcdTVGMEZcdTg5ODZcdTc2RDYgPiBcdTUxODVcdTdGNkVcdTVGMDBcdTUxNzMoSE1IX0RFU0tUT1BfQlVORExFRD0xKT4gXHU1OTE2XHU5MEU4XHU1M0QxXHU3M0IwXG4gICAgIChkZXYgXHU3NkY4XHU5MEJCXHU0RUQzXHU1RTkzIC8gd2hlcmUgaG1oIC8gbnBtIFx1NTE2OFx1NUM0MCAvIFx1NkU5MFx1NzgwMVx1NEY0RFx1N0Y2RSk+IFx1NTE4NVx1N0Y2RVx1NTE1Q1x1NUU5NVx1MzAwMlxuICAgICBcdTU5MTZcdTkwRThcdTRGMThcdTUxNDg9XHU4MDAxXHU3NTI4XHU2MjM3XHU3RUU3XHU3RUVEXHU3NTI4XHU4MUVBXHU1REYxXHU4OEM1XHU3Njg0XHU3MjQ4XHU2NzJDO1x1NTE4NVx1N0Y2RT1cdTY1QjBcdTY3M0FcdTU2NjhcdTg4QzVcdTVCOENcdTc2RjRcdThGREVcdTc3MUZcdTVCOUVcdTUxODVcdTY4MzgsXG4gICAgIFx1NEUwRFx1NTE4RFx1ODQzRFx1NkYxNFx1NzkzQVx1NkEyMVx1NUYwRlx1MzAwMkhNSF9ERVNLVE9QX0ZBS0U9MSBcdTRFQ0RcdTVGM0FcdTUyMzZcdTZGMTRcdTc5M0EoXHU2RDRCXHU4QkQ1L1x1NTE5Mlx1NzBERilcdTMwMDIgKi9cbiAgYXN5bmMgZnVuY3Rpb24gc3RhcnRIb3N0KCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IHJlcG9Sb290ID0gam9pbihoZXJlLCAnLi4nLCAnLi4nLCAnLi4nLCAnLi4nKTsgLy8gYXBwcy9kZXNrdG9wL2Rpc3QtZWxlY3Ryb24vbWFpbiBcdTIxOTIgcmVwbyByb290XG4gICAgY29uc3QgcGFja2FnZWQgPSBhcHAuaXNQYWNrYWdlZDtcbiAgICBjb25zdCBmb3JjZUZha2UgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9GQUtFID09PSAnMSc7XG4gICAgY29uc3QgZm9yY2VCdW5kbGVkID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfQlVORExFRCA9PT0gJzEnO1xuICAgIGNvbnN0IG92ZXJyaWRlID0gYXdhaXQgbG9hZFJ1bnRpbWVFbnRyeU92ZXJyaWRlKCk7XG4gICAgY29uc3QgYWRqYWNlbnQgPSBqb2luKHJlcG9Sb290LCAnLi4nLCAnaG1oYXJuZXNzJywgJ3BhY2thZ2VzJywgJ3dlYicsICdzcmMnLCAnZGVza3RvcC1ob3N0LnRzJyk7XG4gICAgY29uc3QgYnVuZGxlZCA9IGJ1bmRsZWRSdW50aW1lUGF0aChyZXBvUm9vdCk7XG4gICAgY29uc3QgYnVuZGxlZFJlYWR5ID0gZXhpc3RzU3luYyhidW5kbGVkKTtcbiAgICAvLyBcdTg5RTNcdTY3OTAoXHU3RUQzXHU2NzlDXHU1RjUyXHU0RTAwOm92ZXJyaWRlL2V4dGVybmFsPS50cyBcdTk3MDAgdHN4O2J1bmRsZWQ9XHU4MUVBXHU1MzA1XHU1NDJCIGNqcyBcdTc2RjRcdThERDEpXG4gICAgbGV0IGVudHJ5ID0gJyc7XG4gICAgdXNlQnVuZGxlZFJ1bnRpbWUgPSBmYWxzZTtcbiAgICBpZiAoZm9yY2VGYWtlKSB7XG4gICAgICAvLyBcdTZGMTRcdTc5M0FcdTZBMjFcdTVGMEZcbiAgICB9IGVsc2UgaWYgKG92ZXJyaWRlICE9PSAnJykge1xuICAgICAgZW50cnkgPSBvdmVycmlkZTtcbiAgICB9IGVsc2UgaWYgKGZvcmNlQnVuZGxlZCkge1xuICAgICAgaWYgKGJ1bmRsZWRSZWFkeSkgeyBlbnRyeSA9IGJ1bmRsZWQ7IHVzZUJ1bmRsZWRSdW50aW1lID0gdHJ1ZTsgfVxuICAgICAgZWxzZSBsb2dJbmZvKCdob3N0JywgJ0hNSF9ERVNLVE9QX0JVTkRMRUQ9MSBcdTRGNDZcdTUxODVcdTdGNkUgcnVudGltZSBcdTdGM0FcdTU5MzEoXHU1MTQ4XHU4REQxIHNjcmlwdHMvYnVuZGxlLXJ1bnRpbWUubWpzKScpO1xuICAgIH0gZWxzZSB7XG4gICAgICBlbnRyeSA9IHBhY2thZ2VkID8gZGV0ZWN0UmVhbEVudHJ5KCkgOiAoZXhpc3RzU3luYyhhZGphY2VudCkgPyBhZGphY2VudCA6IGRldGVjdFJlYWxFbnRyeSgpKTtcbiAgICAgIGlmIChlbnRyeSA9PT0gJycgJiYgYnVuZGxlZFJlYWR5KSB7IGVudHJ5ID0gYnVuZGxlZDsgdXNlQnVuZGxlZFJ1bnRpbWUgPSB0cnVlOyB9XG4gICAgfVxuICAgIHJ1bnRpbWVFbnRyeSA9IGVudHJ5O1xuICAgIGNvbnN0IHVzZVJlYWwgPSBlbnRyeSAhPT0gJycgJiYgKHVzZUJ1bmRsZWRSdW50aW1lIHx8IGV4aXN0c1N5bmMoZW50cnkpKTtcbiAgICBicmlkZ2UgPSB7XG4gICAgICAuLi5icmlkZ2UsXG4gICAgICBtb2RlOiB1c2VSZWFsID8gJ3JlYWwnIDogJ2Zha2UnLFxuICAgICAgcnVudGltZUVudHJ5OiB1c2VSZWFsID8gKHVzZUJ1bmRsZWRSdW50aW1lID8gYCR7ZW50cnl9IChidW5kbGVkKWAgOiBlbnRyeSkgOiBudWxsLFxuICAgIH07XG4gICAgbGV0IHNwZWM6IHsgY29tbWFuZDogc3RyaW5nOyBhcmdzOiBzdHJpbmdbXTsgZW52OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+OyBjd2Q/OiBzdHJpbmcgfTtcbiAgICBpZiAodXNlQnVuZGxlZFJ1bnRpbWUpIHtcbiAgICAgIHNwZWMgPSB7XG4gICAgICAgIGNvbW1hbmQ6IHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgICAgIGFyZ3M6IFtlbnRyeV0sIC8vIFx1ODFFQVx1NTMwNVx1NTQyQlx1NTM1NVx1NjU4N1x1NEVGNjplbGVjdHJvbi1hcy1ub2RlIFx1NzZGNFx1OEREMSxcdTY1RTAgdHN4IFx1NjVFMCByZXBvXG4gICAgICAgIGVudjogeyBFTEVDVFJPTl9SVU5fQVNfTk9ERTogJzEnIH0sXG4gICAgICB9O1xuICAgIH0gZWxzZSBpZiAodXNlUmVhbCkge1xuICAgICAgY29uc3QgcmVwbyA9IHJlcG9Sb290T2YoZW50cnkpO1xuICAgICAgc3BlYyA9IHtcbiAgICAgICAgY29tbWFuZDogcHJvY2Vzcy5leGVjUGF0aCxcbiAgICAgICAgYXJnczogWyctLWltcG9ydCcsICd0c3gnLCBlbnRyeV0sXG4gICAgICAgIGN3ZDogcmVwbywgLy8gYmFyZSAndHN4JyBcdTRFMEUgd29ya3NwYWNlIFx1NEY5RFx1OEQ1Nlx1OTBGRFx1NEVDRSByZXBvIFx1NzY4NCBub2RlX21vZHVsZXMgXHU4OUUzXHU2NzkwXG4gICAgICAgIGVudjogeyBFTEVDVFJPTl9SVU5fQVNfTk9ERTogJzEnIH0sXG4gICAgICB9O1xuICAgIH0gZWxzZSBpZiAocGFja2FnZWQpIHtcbiAgICAgIHNwZWMgPSB7XG4gICAgICAgIGNvbW1hbmQ6IHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgICAgIGFyZ3M6IFtqb2luKHByb2Nlc3MucmVzb3VyY2VzUGF0aCwgJ2Zha2UtaG9zdC5janMnKV0sXG4gICAgICAgIGVudjogeyBFTEVDVFJPTl9SVU5fQVNfTk9ERTogJzEnIH0sXG4gICAgICB9O1xuICAgIH0gZWxzZSB7XG4gICAgICBzcGVjID0ge1xuICAgICAgICBjb21tYW5kOiBwcm9jZXNzLmV4ZWNQYXRoLFxuICAgICAgICAvLyBcdTc2RjRcdTYzQTVcdThENzBcdTUzMDVcdTc3MUZcdTVCOUVcdThERUZcdTVGODQobm9kZV9tb2R1bGVzIFx1OTFDQ1x1NzY4NCB3b3Jrc3BhY2UganVuY3Rpb24gXHU0RjFBXHU4OEFCIEVTTVxuICAgICAgICAvLyByZWFscGF0aCBcdTUzMTYsXHU1QkZDXHU4MUY0IGZha2UtaG9zdCBcdTc2ODQgYXJndlsxXS9pbXBvcnQubWV0YS51cmwgXHU1MzM5XHU5MTREXHU1OTMxXHU2NTQ4KVxuICAgICAgICBhcmdzOiBbJy0taW1wb3J0JywgJ3RzeCcsIGpvaW4ocmVwb1Jvb3QsICdwYWNrYWdlcycsICdob3N0LWFkYXB0ZXInLCAnc3JjJywgJ2Zha2UtaG9zdC50cycpXSxcbiAgICAgICAgZW52OiB7IEVMRUNUUk9OX1JVTl9BU19OT0RFOiAnMScgfSxcbiAgICAgIH07XG4gICAgfVxuICAgIHN1cGVydmlzb3IgPSBuZXcgRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yKHNwZWMsIHtcbiAgICAgIG9uU3RhdGVDaGFuZ2U6IGJyb2FkY2FzdEhvc3RTdGF0ZSxcbiAgICAgIC8vIFx1OTk5Nlx1NkIyMVx1NTQyRlx1NTJBOFx1NEUwRSBjcmFzaCBcdTgxRUFcdTYxMDhcdTU0MEVcdTc2ODRcdTkxQ0RcdTU0MkZcdTkwRkRcdTRGMUFcdThENzBcdThGRDlcdTkxQ0M6XHU3QUVGXHU1M0UzL3Rva2VuIFx1OTBGRFx1NjYyRlx1NjVCMFx1NzY4NCxcbiAgICAgIC8vIFx1OTFDRFx1NUVGQVx1Njg2NVx1NUJBMlx1NjIzN1x1N0FFRlx1NUU3Nlx1OTFDRFx1NjVCMFx1OEJBMlx1OTYwNSBTU0UocmVuZGVyZXIgXHU3Njg0IEV2ZW50U3RvcmUgXHU5NzYwIGV2ZW50SWQgXHU1M0JCXHU5MUNEKVxuICAgICAgb25SZWFkeTogKGVwKSA9PiB7XG4gICAgICAgIGNsaWVudCA9IG5ldyBEZXNrdG9wSG9zdENsaWVudChgaHR0cDovLzEyNy4wLjAuMToke2VwLnBvcnR9YCwgZXAudG9rZW4pO1xuICAgICAgICBzc2VBYm9ydD8uYWJvcnQoKTtcbiAgICAgICAgc3NlQWJvcnQgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gICAgICAgIGxhc3RFdmVudElkID0gJyc7XG4gICAgICAgIHZvaWQgcHVtcEV2ZW50cygpO1xuICAgICAgICBsb2dJbmZvKCdob3N0JywgYGJyaWRnZSByZWFkeSBvbiAxMjcuMC4wLjE6JHtlcC5wb3J0fSAocnVudGltZSAke2VwLnZlcnNpb259LCBtb2RlICR7YnJpZGdlLm1vZGV9JHt1c2VSZWFsID8gYCwgZW50cnk9JHtydW50aW1lRW50cnl9JHt1c2VCdW5kbGVkUnVudGltZSA/ICcgW2J1bmRsZWRdJyA6ICcnfWAgOiAnJ30pYCk7XG4gICAgICB9LFxuICAgIH0pO1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCBzdXBlcnZpc29yLnN0YXJ0KCk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBjb25zdCBkZXRhaWwgPSAoKCkgPT4geyB0cnkgeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkoZXJyKTsgfSBjYXRjaCB7IHJldHVybiBTdHJpbmcoZXJyKTsgfSB9KSgpLnNsaWNlKDAsIDQwMCk7XG4gICAgICBicmlkZ2UgPSB7IC4uLmJyaWRnZSwgaG9zdFN0YXRlOiAnZmFpbGVkJywgbGFzdEVycm9yOiBkZXRhaWwgfTtcbiAgICAgIGxvZ0luZm8oJ2hvc3QnLCBgc3RhcnQgZmFpbGVkOiAke2RldGFpbH1gKTtcbiAgICB9XG4gIH1cblxuICAvKiAtLS0tIElQQyBcdTc2N0RcdTU0MERcdTUzNTUgKyBzZW5kZXIgXHU2ODIxXHU5QThDIC0tLS0gKi9cbiAgY29uc3QgYWxsb3dlZE9yaWdpbnMgPSBuZXcgU2V0PHN0cmluZz4oXG4gICAgaXNEZXYgJiYgcmVuZGVyZXJEZXZVcmxcbiAgICAgID8gW3JlbmRlcmVyRGV2VXJsXVxuICAgICAgOiBbcGF0aFRvRmlsZVVSTChqb2luKGhlcmUsICcuLicsICcuLicsICdkaXN0LXJlbmRlcmVyJywgJ2luZGV4Lmh0bWwnKSkuaHJlZl0sXG4gICk7XG5cbiAgZnVuY3Rpb24gc2VuZGVyVHJ1c3RlZChzZW5kZXJGcmFtZTogRWxlY3Ryb24uV2ViRnJhbWVNYWluIHwgbnVsbCB8IHVuZGVmaW5lZCk6IGJvb2xlYW4ge1xuICAgIGlmIChzZW5kZXJGcmFtZSA9PT0gbnVsbCB8fCBzZW5kZXJGcmFtZSA9PT0gdW5kZWZpbmVkKSByZXR1cm4gZmFsc2U7XG4gICAgbGV0IHRvcDogRWxlY3Ryb24uV2ViRnJhbWVNYWluIHwgbnVsbCA9IHNlbmRlckZyYW1lO1xuICAgIHdoaWxlICh0b3A/LnBhcmVudCAhPT0gbnVsbCAmJiB0b3A/LnBhcmVudCAhPT0gdW5kZWZpbmVkKSB0b3AgPSB0b3AucGFyZW50O1xuICAgIGNvbnN0IHVybCA9IHRvcD8udXJsID8/ICcnO1xuICAgIGZvciAoY29uc3Qgb3JpZ2luIG9mIGFsbG93ZWRPcmlnaW5zKSB7XG4gICAgICBpZiAodXJsID09PSBvcmlnaW4gfHwgdXJsLnN0YXJ0c1dpdGgoYCR7b3JpZ2lufS9gKSB8fCB1cmwuc3RhcnRzV2l0aChgJHtvcmlnaW59P2ApKSByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgLyoqIFx1OTcwMFx1ODk4MSBob3N0IFx1NUMzMVx1N0VFQVx1NzY4NCBJUEMgaGFuZGxlciBcdTUxNkNcdTUxNzFcdTU4RjM6XHU2NzJBXHU1QzMxXHU3RUVBXHU4RkQ0XHU1NkRFXHU3RUQzXHU2Nzg0XHU1MzE2XHU5NTE5XHU4QkVGXHUzMDAyICovXG4gIGZ1bmN0aW9uIGhvc3RDYWxsPFQ+KGV2ZW50OiBFbGVjdHJvbi5JcGNNYWluSW52b2tlRXZlbnQsIGZuOiAoYzogRGVza3RvcEhvc3RDbGllbnQpID0+IFByb21pc2U8VD4pOiBQcm9taXNlPFQgfCB7IGVycm9yOiBzdHJpbmc7IGNvZGU6IHN0cmluZyB9PiB7XG4gICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH0pO1xuICAgIGlmIChjbGllbnQgPT09IG51bGwgfHwgYnJpZGdlLmhvc3RTdGF0ZSAhPT0gJ3JlYWR5Jykge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiBgaG9zdCBub3QgcmVhZHkgKCR7YnJpZGdlLmhvc3RTdGF0ZX0pYCwgY29kZTogJ0hPU1RfTk9UX1JFQURZJyB9KTtcbiAgICB9XG4gICAgcmV0dXJuIGZuKGNsaWVudCkuY2F0Y2goKGVycjogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3QgZGV0YWlsID0gKCgpID0+IHsgdHJ5IHsgcmV0dXJuIEpTT04uc3RyaW5naWZ5KGVycik7IH0gY2F0Y2ggeyByZXR1cm4gU3RyaW5nKGVycik7IH0gfSkoKS5zbGljZSgwLCAzMDApO1xuICAgICAgcmV0dXJuIHsgZXJyb3I6IGRldGFpbCwgY29kZTogJ0JSSURHRV9FUlJPUicgfTtcbiAgICB9KTtcbiAgfVxuXG4gIGZ1bmN0aW9uIHJlZ2lzdGVySXBjKCk6IHZvaWQge1xuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6Z2V0LXN0YXRlJywgKGV2ZW50KSA9PiB7XG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInIH07XG4gICAgICByZXR1cm4geyAuLi5icmlkZ2UsIGRyb3BwZWRGcmFtZXMgfTtcbiAgICB9KTtcblxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6c2Vzc2lvbnMnLCAoZXZlbnQpID0+XG4gICAgICBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjx7IHNlc3Npb25zOiBBcnJheTx7IGlkOiBzdHJpbmc7IHRpdGxlOiBzdHJpbmc7IHRhc2s6IHN0cmluZzsgb3V0Y29tZTogc3RyaW5nOyB0dXJuczogbnVtYmVyOyB0b29sVXNlczogbnVtYmVyOyB0aW1lOiBzdHJpbmc7IGN3ZDogc3RyaW5nOyBjcmVhdGVkQXQ6IHN0cmluZzsgdXBkYXRlZEF0OiBzdHJpbmcgfT4gfT4oJy9hcGkvc2Vzc2lvbnM/bGltaXQ9MTAwJykpKTtcblxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6c2VuZC10YXNrJywgKGV2ZW50LCB0ZXh0OiB1bmtub3duLCBzZXNzaW9uSWQ6IHVua25vd24sIG1vZGU6IHVua25vd24sIGF0dGFjaG1lbnRzOiB1bmtub3duLCBpbWFnZXM6IHVua25vd24pID0+IHtcbiAgICAgIGNvbnN0IHRhc2sgPSB0eXBlb2YgdGV4dCA9PT0gJ3N0cmluZycgPyB0ZXh0LnNsaWNlKDAsIDIwXzAwMCkgOiAnJztcbiAgICAgIGNvbnN0IHNpZCA9IHR5cGVvZiBzZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gc2Vzc2lvbklkLnNsaWNlKDAsIDgwKSA6ICcnO1xuICAgICAgY29uc3QgbSA9IG1vZGUgPT09ICdhdXRvJyB8fCBtb2RlID09PSAneW9sbycgPyBtb2RlIDogJ2Fzayc7XG4gICAgICAvLyBcdTk2NDRcdTRFRjY6XHU1NDBFXHU3QUVGXHU2Mzg4XHU2NzQzIERUTyBcdTc2ODRcdTdFRERcdTVCRjlcdThERUZcdTVGODQoQCBcdTkwMDlcdTYyRTlcdTU2NjgvXHVEODNEXHVEQ0NFIFx1NEUwQVx1NEYyMFx1NTNFQVx1Njc2NVx1ODFFQVx1NjcyQ1x1NTczMFx1NjU4N1x1NEVGNlx1N0NGQlx1N0VERilcbiAgICAgIGNvbnN0IGF0dHMgPSBBcnJheS5pc0FycmF5KGF0dGFjaG1lbnRzKSA/IGF0dGFjaG1lbnRzLmZpbHRlcigoYSk6IGEgaXMgc3RyaW5nID0+IHR5cGVvZiBhID09PSAnc3RyaW5nJykuc2xpY2UoMCwgMTApIDogW107XG4gICAgICAvLyBcdTU2RkVcdTcyNDc6cnVudGltZSB2aXNpb24gXHU5NEZFXHU1MzRGXHU4QkFFIHtuYW1lLCBkYXRhVXJsfSBiYXNlNjQoXHUyMjY0MyBcdTVGMjAgXHUyMjY0Nk1CLHJlbmRlcmVyIFx1NzUxRlx1NjIxMClcbiAgICAgIGNvbnN0IGltZ3MgPSBBcnJheS5pc0FycmF5KGltYWdlcylcbiAgICAgICAgPyBpbWFnZXNcbiAgICAgICAgICAgIC5maWx0ZXIoKGltKTogaW0gaXMgeyBuYW1lOiBzdHJpbmc7IGRhdGFVcmw6IHN0cmluZyB9ID0+XG4gICAgICAgICAgICAgIHR5cGVvZiBpbSA9PT0gJ29iamVjdCcgJiYgaW0gIT09IG51bGwgJiYgdHlwZW9mIChpbSBhcyB7IG5hbWU/OiB1bmtub3duIH0pLm5hbWUgPT09ICdzdHJpbmcnICYmIHR5cGVvZiAoaW0gYXMgeyBkYXRhVXJsPzogdW5rbm93biB9KS5kYXRhVXJsID09PSAnc3RyaW5nJylcbiAgICAgICAgICAgIC5zbGljZSgwLCAzKVxuICAgICAgICAgICAgLm1hcCgoaW0pID0+ICh7IG5hbWU6IGltLm5hbWUuc2xpY2UoMCwgMTIwKSwgZGF0YVVybDogaW0uZGF0YVVybC5zbGljZSgwLCA4XzUwMF8wMDApIH0pKVxuICAgICAgICA6IFtdO1xuICAgICAgaWYgKHRhc2sgPT09ICcnIHx8IHNpZCA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBvazogZmFsc2UsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW47IHJ1bklkPzogc3RyaW5nIH0+KCcvYXBpL3Rhc2snLCB7IHRleHQ6IHRhc2ssIHNlc3Npb25JZDogc2lkLCBtb2RlOiBtLCBhdHRhY2htZW50czogYXR0cywgaW1hZ2VzOiBpbWdzIH0pKTtcbiAgICB9KTtcblxuICAgIC8vIC0tLS0gXHU2QTIxXHU1NzhCXHU1MjA3XHU2MzYyKHJ1bnRpbWUgUE9TVCAvYXBpL21vZGVsOlx1NTIwNyBjaGF0IFx1OERFRlx1NzUzMSxjb25maWcgXHU1MzczXHU2NUY2XHU3NTFGXHU2NTQ4KSAtLS0tXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTptb2RlbC1zZXQnLCAoZXZlbnQsIG5hbWU6IHVua25vd24pID0+IHtcbiAgICAgIGNvbnN0IG4gPSB0eXBlb2YgbmFtZSA9PT0gJ3N0cmluZycgPyBuYW1lLnRyaW0oKS5zbGljZSgwLCA4MCkgOiAnJztcbiAgICAgIGlmIChuID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAnbmFtZSByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW47IG1vZGVsPzogc3RyaW5nIH0+KCcvYXBpL21vZGVsJywgeyBuYW1lOiBuIH0pKTtcbiAgICB9KTtcblxuICAgIC8vIC0tLS0gXHU1RTk0XHU3NTI4XHU1MTg1XHU2NkY0XHU2NUIwKEdpdEh1YiBSZWxlYXNlcztcdTgxRUFcdTc4MTRcdTk2RjZcdTRGOURcdThENTZcdTY2RjRcdTY1QjBcdTU2NjgpIC0tLS1cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmNoZWNrLXVwZGF0ZScsIGFzeW5jIChldmVudCkgPT4ge1xuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcbiAgICAgIHJldHVybiBjaGVja0ZvclVwZGF0ZXMoKTtcbiAgICB9KTtcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmFwcGx5LXVwZGF0ZScsIChldmVudCkgPT4ge1xuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcbiAgICAgIGlmIChpbnN0YWxsZXJQYXRoID09PSBudWxsKSByZXR1cm4geyBlcnJvcjogJ25vIGluc3RhbGxlciBkb3dubG9hZGVkJywgY29kZTogJ0hPU1RfTk9UX1JFQURZJyB9O1xuICAgICAgYXBwbHlVcGRhdGUoKTtcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlIH07XG4gICAgfSk7XG5cbiAgICAvLyAtLS0tIFx1NjgwN1x1OTg5OFx1NjgwRlx1NEUzQlx1OTg5OFx1NTQwQ1x1NkI2NShcdTZENDVcdTgyNzJcdTZBMjFcdTVGMEZcdTRFMERcdTUxOERcdTY3MDlcdTlFRDFcdTY3NjEpKyBcdTI2MzAgXHU0RTNCXHU4M0RDXHU1MzU1IC0tLS1cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmNocm9tZS10aGVtZScsIChldmVudCwgZGFyazogdW5rbm93bikgPT4ge1xuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcbiAgICAgIGFwcGx5Q2hyb21lKGRhcmsgPT09IHRydWUpO1xuICAgICAgcmV0dXJuIHsgb2s6IHRydWUgfTtcbiAgICB9KTtcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnBvcHVwLW1haW4tbWVudScsIChldmVudCkgPT4ge1xuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcbiAgICAgIHBvcHVwTWFpbk1lbnUoKTtcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlIH07XG4gICAgfSk7XG5cbiAgICAvLyAtLS0tIFx1NjI0Qlx1NjczQVx1OEZEQ1x1N0EwQlx1NjNBN1x1NTIzNig3Nzg4IHdlYiBcdTVCODhcdTYyQTQ7XHU3NTI4XHU2MjM3XHU2NjNFXHU1RjBGXHU1NDJGXHU1MkE4LEFEUi0wMDUgXHU0RTBEXHU5RUQ4XHU4QkE0XHU1RjAwIExBTikgLS0tLVxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cmVtb3RlLXdlYi1zdGF0dXMnLCBhc3luYyAoZXZlbnQpID0+IHtcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XG4gICAgICBjb25zdCBwID0gYXdhaXQgcHJvYmVXZWJSZW1vdGUoKTtcbiAgICAgIHJldHVybiB7IHVwOiBwLnVwLCB2ZXJzaW9uOiBwLnZlcnNpb24sIGxhbklwOiBsYW5JcE9mKCksIHBvcnQ6IFdFQl9QT1JULCBhdmFpbGFibGU6IGNsaUVudHJ5T2YoKSAhPT0gJycsIGF1dG9zdGFydDogd2ViQXV0b3N0YXJ0SW5zdGFsbGVkKCkgfTtcbiAgICB9KTtcbiAgICAvLyAtLS0tIFx1NUYwMFx1NjczQVx1ODFFQVx1NTQyRigwLjIzLjM3IHdlYiBpbnN0YWxsLWRhZW1vbi91bmluc3RhbGwtZGFlbW9uO1x1NzY3Qlx1NUY1NVx1NTM3M1x1NUI4OFx1NjJBNFx1NTcyOFx1N0VCRikgLS0tLVxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cmVtb3RlLXdlYi1hdXRvc3RhcnQnLCBhc3luYyAoZXZlbnQsIGVuYWJsZWQ6IHVua25vd24pID0+IHtcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XG4gICAgICBpZiAoY2xpRW50cnlPZigpID09PSAnJykgcmV0dXJuIHsgZXJyb3I6ICdubyBobWhhcm5lc3MgcnVudGltZSBkZXRlY3RlZCcsIGNvZGU6ICdIT1NUX05PVF9SRUFEWScgfTtcbiAgICAgIHJ1bkNsaShbJ3dlYicsIGVuYWJsZWQgPT09IHRydWUgPyAnaW5zdGFsbC1kYWVtb24nIDogJ3VuaW5zdGFsbC1kYWVtb24nXSk7XG4gICAgICAvLyBpbnN0YWxsLWRhZW1vbiBcdTdBQ0JcdTUzNzNcdTYyQzlcdThENzdcdTVCODhcdTYyQTQ6XHU4RjZFXHU4QkUyXHU3ODZFXHU4QkE0O3VuaW5zdGFsbCBcdTUzNzNcdTY1RjZcdTc1MUZcdTY1NDhcbiAgICAgIGlmIChlbmFibGVkID09PSB0cnVlKSB7XG4gICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgNTA7IGkrKykge1xuICAgICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDUwMCkpO1xuICAgICAgICAgIGlmICgoYXdhaXQgcHJvYmVXZWJSZW1vdGUoKSkudXApIHJldHVybiB7IG9rOiB0cnVlLCBhdXRvc3RhcnQ6IHdlYkF1dG9zdGFydEluc3RhbGxlZCgpIH07XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHsgZXJyb3I6ICdkYWVtb24gZGlkIG5vdCBjb21lIHVwIHdpdGhpbiAyNXMnLCBjb2RlOiAnUlVOVElNRV9DUkFTSEVEJyB9O1xuICAgICAgfVxuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGF1dG9zdGFydDogd2ViQXV0b3N0YXJ0SW5zdGFsbGVkKCkgfTtcbiAgICB9KTtcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnJlbW90ZS13ZWItc3RhcnQnLCBhc3luYyAoZXZlbnQpID0+IHtcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XG4gICAgICBpZiAoY2xpRW50cnlPZigpID09PSAnJykgcmV0dXJuIHsgZXJyb3I6ICdubyBobWhhcm5lc3MgcnVudGltZSBkZXRlY3RlZCcsIGNvZGU6ICdIT1NUX05PVF9SRUFEWScgfTtcbiAgICAgIGlmICgoYXdhaXQgcHJvYmVXZWJSZW1vdGUoKSkudXApIHtcbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGFscmVhZHk6IHRydWUsIGxhblVybDogYGh0dHA6Ly8ke2xhbklwT2YoKSB8fCAnMTI3LjAuMC4xJ306JHtXRUJfUE9SVH1gIH07XG4gICAgICB9XG4gICAgICBydW5DbGkoWyd3ZWInLCAnc3RhcnQnLCAnLS1leHBvc3VyZT1sYW4nXSk7XG4gICAgICAvLyBcdTVCODhcdTYyQTRcdThGREJcdTdBMEJcdTUxQjdcdTU0MkZcdTUyQTgodHN4IFx1N0YxNlx1OEJEMVx1NjU3NFx1NTk1NyBDTEkpOlx1OEY2RVx1OEJFMiAyNXNcbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgNTA7IGkrKykge1xuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCA1MDApKTtcbiAgICAgICAgaWYgKChhd2FpdCBwcm9iZVdlYlJlbW90ZSgpKS51cCkge1xuICAgICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBsYW5Vcmw6IGBodHRwOi8vJHtsYW5JcE9mKCkgfHwgJzEyNy4wLjAuMSd9OiR7V0VCX1BPUlR9YCB9O1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICByZXR1cm4geyBlcnJvcjogJ3dlYiBkYWVtb24gZGlkIG5vdCBjb21lIHVwIHdpdGhpbiAyNXMgKHNlZSBITUhfSE9NRS93ZWIubG9nKScsIGNvZGU6ICdSVU5USU1FX0NSQVNIRUQnIH07XG4gICAgfSk7XG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpyZW1vdGUtd2ViLXN0b3AnLCBhc3luYyAoZXZlbnQpID0+IHtcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XG4gICAgICBydW5DbGkoWyd3ZWInLCAnc3RvcCddKTtcbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgMjA7IGkrKykge1xuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCA0MDApKTtcbiAgICAgICAgaWYgKCEoYXdhaXQgcHJvYmVXZWJSZW1vdGUoKSkudXApIHJldHVybiB7IG9rOiB0cnVlIH07XG4gICAgICB9XG4gICAgICBjb25zdCBzdGlsbCA9IChhd2FpdCBwcm9iZVdlYlJlbW90ZSgpKS51cDtcbiAgICAgIHJldHVybiBzdGlsbCA/IHsgZXJyb3I6ICdzdGlsbCBydW5uaW5nJywgY29kZTogJ0JSSURHRV9FUlJPUicgfSA6IHsgb2s6IHRydWUgfTtcbiAgICB9KTtcblxuICAgIC8vIC0tLS0gXHVEODNEXHVEQ0NFIFx1NjU4N1x1NEVGNlx1NEUwQVx1NEYyMChcdTY3MkNcdTU3MzBcdTU5MUFcdTkwMDk7cnVudGltZSBcdTY4MjFcdTlBOEMgaW5zaWRlV3MsXHU1REU1XHU0RjVDXHU1MzNBXHU1OTE2XHU2NTg3XHU0RUY2XHU0RjFBXHU4OEFCIDQwMCkgLS0tLVxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cGljay1maWxlcycsIGFzeW5jIChldmVudCwgdGl0bGU6IHVua25vd24pID0+IHtcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XG4gICAgICBjb25zdCB3aW4gPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5maW5kKCh3KSA9PiAhdy5pc0Rlc3Ryb3llZCgpKTtcbiAgICAgIGlmICh3aW4gPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgZXJyb3I6ICdubyB3aW5kb3cnLCBjb2RlOiAnQlJJREdFX0VSUk9SJyB9O1xuICAgICAgY29uc3QgciA9IGF3YWl0IGRpYWxvZy5zaG93T3BlbkRpYWxvZyh3aW4sIHtcbiAgICAgICAgdGl0bGU6IHR5cGVvZiB0aXRsZSA9PT0gJ3N0cmluZycgJiYgdGl0bGUgIT09ICcnID8gdGl0bGUuc2xpY2UoMCwgMTIwKSA6ICdcdTkwMDlcdTYyRTlcdTg5ODFcdTk2NDRcdTUyQTBcdTc2ODRcdTY1ODdcdTRFRjYoXHU1M0VGXHU1OTFBXHU5MDA5KScsXG4gICAgICAgIHByb3BlcnRpZXM6IFsnb3BlbkZpbGUnLCAnbXVsdGlTZWxlY3Rpb25zJ10sXG4gICAgICB9KTtcbiAgICAgIGlmIChyLmNhbmNlbGVkIHx8IHIuZmlsZVBhdGhzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBjYW5jZWxlZDogdHJ1ZSB9O1xuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHBhdGhzOiByLmZpbGVQYXRocy5zbGljZSgwLCAxMCkgfTtcbiAgICB9KTtcblxuICAgIC8vIC0tLS0gXHVEODNEXHVEQ0MxIFx1NzZFRVx1NUY1NVx1OTAwOVx1NjJFOShcdTVERTVcdTRGNUNcdTUzM0FcdTZERkJcdTUyQTBcdTc2ODRcdTZENEZcdTg5QzhcdTYzMDlcdTk0QUU7XHU1MzlGXHU3NTFGIGNob29zZXIpIC0tLS1cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnBpY2stZGlyZWN0b3J5JywgYXN5bmMgKGV2ZW50LCB0aXRsZTogdW5rbm93bikgPT4ge1xuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcbiAgICAgIGNvbnN0IHdpbiA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmZpbmQoKHcpID0+ICF3LmlzRGVzdHJveWVkKCkpO1xuICAgICAgaWYgKHdpbiA9PT0gdW5kZWZpbmVkKSByZXR1cm4geyBlcnJvcjogJ25vIHdpbmRvdycsIGNvZGU6ICdCUklER0VfRVJST1InIH07XG4gICAgICBjb25zdCByID0gYXdhaXQgZGlhbG9nLnNob3dPcGVuRGlhbG9nKHdpbiwge1xuICAgICAgICB0aXRsZTogdHlwZW9mIHRpdGxlID09PSAnc3RyaW5nJyAmJiB0aXRsZSAhPT0gJycgPyB0aXRsZS5zbGljZSgwLCAxMjApIDogJ1x1OTAwOVx1NjJFOVx1NjU4N1x1NEVGNlx1NTkzOScsXG4gICAgICAgIHByb3BlcnRpZXM6IFsnb3BlbkRpcmVjdG9yeSddLFxuICAgICAgfSk7XG4gICAgICBpZiAoci5jYW5jZWxlZCB8fCByLmZpbGVQYXRoc1swXSA9PT0gdW5kZWZpbmVkKSByZXR1cm4geyBvazogZmFsc2UsIGNhbmNlbGVkOiB0cnVlIH07XG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgcGF0aDogci5maWxlUGF0aHNbMF0gfTtcbiAgICB9KTtcblxuICAgIC8vIC0tLS0gQCBcdTk2NDRcdTRFRjY6XHU1REU1XHU0RjVDXHU1MzNBXHU2NTg3XHU0RUY2XHU2NDFDXHU3RDIyKHJ1bnRpbWUgXHU2Mzg4XHU2NzQzXHU3Njg0XHU4REVGXHU1Rjg0XHU2NzY1XHU2RTkwKSAtLS0tXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpmcy1zZWFyY2gnLCAoZXZlbnQsIHE6IHVua25vd24pID0+IHtcbiAgICAgIGNvbnN0IHF1ZXJ5ID0gdHlwZW9mIHEgPT09ICdzdHJpbmcnID8gcS5zbGljZSgwLCAyMDApIDogJyc7XG4gICAgICBpZiAocXVlcnkgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgcmVzdWx0czogW10gfSk7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248eyByZXN1bHRzOiBBcnJheTx7IHJlbDogc3RyaW5nOyBwYXRoOiBzdHJpbmcgfT4gfT4oYC9hcGkvZnMvc2VhcmNoP3E9JHtlbmNvZGVVUklDb21wb25lbnQocXVlcnkpfWApKTtcbiAgICB9KTtcblxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6YXBwcm92ZScsIChldmVudCwgZ3JhbnRlZDogdW5rbm93biwgc2Vzc2lvbklkOiB1bmtub3duKSA9PlxuICAgICAgaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvYXBwcm92ZScsIHtcbiAgICAgICAgZ3JhbnRlZDogZ3JhbnRlZCA9PT0gdHJ1ZSxcbiAgICAgICAgc2Vzc2lvbklkOiB0eXBlb2Ygc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IHNlc3Npb25JZC5zbGljZSgwLCA4MCkgOiAnJyxcbiAgICAgIH0pKSk7XG5cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmludGVycnVwdCcsIChldmVudCwgc2Vzc2lvbklkOiB1bmtub3duKSA9PlxuICAgICAgaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvaW50ZXJydXB0Jywge1xuICAgICAgICBzZXNzaW9uSWQ6IHR5cGVvZiBzZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gc2Vzc2lvbklkLnNsaWNlKDAsIDgwKSA6ICcnLFxuICAgICAgfSkpKTtcblxuICAgIC8vIC0tLS0gTTQ6XHU1REU1XHU0RjVDXHU1MzNBXHU2NTg3XHU0RUY2XHU5NzYyKFx1OERFRlx1NUY4NFx1NjM4OFx1Njc0M1x1NTcyOCBydW50aW1lOmluc2lkZVdzIFx1NjgyMVx1OUE4QykgLS0tLVxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6ZnMtbGlzdCcsIChldmVudCwgcGF0aDogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3QgcCA9IHR5cGVvZiBwYXRoID09PSAnc3RyaW5nJyA/IHBhdGguc2xpY2UoMCwgMTAwMCkgOiAnJztcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oYC9hcGkvZnM/ZmlsZXM9MSR7cCAhPT0gJycgPyBgJnBhdGg9JHtlbmNvZGVVUklDb21wb25lbnQocCl9YCA6ICcnfWApKTtcbiAgICB9KTtcblxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6ZnMtcmVhZCcsIChldmVudCwgcGF0aDogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3QgcCA9IHR5cGVvZiBwYXRoID09PSAnc3RyaW5nJyA/IHBhdGguc2xpY2UoMCwgMTAwMCkgOiAnJztcbiAgICAgIGlmIChwID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAncGF0aCByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KGAvYXBpL2ZzL3JlYWQ/cGF0aD0ke2VuY29kZVVSSUNvbXBvbmVudChwKX1gKSk7XG4gICAgfSk7XG5cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmluamVjdCcsIChldmVudCwgdGV4dDogdW5rbm93biwgc2Vzc2lvbklkOiB1bmtub3duKSA9PiB7XG4gICAgICBjb25zdCB0ID0gdHlwZW9mIHRleHQgPT09ICdzdHJpbmcnID8gdGV4dC5zbGljZSgwLCAyMF8wMDApIDogJyc7XG4gICAgICBjb25zdCBzaWQgPSB0eXBlb2Ygc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IHNlc3Npb25JZC5zbGljZSgwLCA4MCkgOiAnJztcbiAgICAgIGlmICh0ID09PSAnJyB8fCBzaWQgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgb2s6IGZhbHNlLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KCcvYXBpL2luamVjdCcsIHsgdGV4dDogdCwgc2Vzc2lvbklkOiBzaWQgfSkpO1xuICAgIH0pO1xuXG4gICAgLy8gLS0tLSBcdTRGMUFcdThCRERcdTVCRkNcdTUxRkEoZXhwb3J0Lm1kIFx1MjE5MiBcdTRGRERcdTVCNThcdTVCRjlcdThCRERcdTY4NDY7XHU2NTg3XHU0RUY2XHU1MTk5XHU1MTY1XHU1M0VBXHU1NzI4IG1haW4pIC0tLS1cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmV4cG9ydC1zZXNzaW9uJywgYXN5bmMgKGV2ZW50LCBpZDogdW5rbm93biwgdGl0bGU6IHVua25vd24pID0+IHtcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XG4gICAgICBjb25zdCBzaWQgPSB0eXBlb2YgaWQgPT09ICdzdHJpbmcnID8gaWQucmVwbGFjZSgvW15hLXpBLVowLTlfOi5ALV0vZywgJycpLnNsaWNlKDAsIDgwKSA6ICcnO1xuICAgICAgaWYgKHNpZCA9PT0gJycpIHJldHVybiB7IGVycm9yOiAnaWQgcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH07XG4gICAgICBpZiAoY2xpZW50ID09PSBudWxsIHx8IGJyaWRnZS5ob3N0U3RhdGUgIT09ICdyZWFkeScpIHJldHVybiB7IGVycm9yOiBgaG9zdCBub3QgcmVhZHkgKCR7YnJpZGdlLmhvc3RTdGF0ZX0pYCwgY29kZTogJ0hPU1RfTk9UX1JFQURZJyB9O1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgbWQgPSBhd2FpdCBjbGllbnQuZ2V0VGV4dChgL2FwaS9zZXNzaW9ucy8ke2VuY29kZVVSSUNvbXBvbmVudChzaWQpfS9leHBvcnQubWRgKTtcbiAgICAgICAgY29uc3Qgd2luID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkuZmluZCgodykgPT4gIXcuaXNEZXN0cm95ZWQoKSk7XG4gICAgICAgIGlmICh3aW4gPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgZXJyb3I6ICdubyB3aW5kb3cnLCBjb2RlOiAnQlJJREdFX0VSUk9SJyB9O1xuICAgICAgICBjb25zdCByID0gYXdhaXQgZGlhbG9nLnNob3dTYXZlRGlhbG9nKHdpbiwge1xuICAgICAgICAgIHRpdGxlOiB0eXBlb2YgdGl0bGUgPT09ICdzdHJpbmcnICYmIHRpdGxlICE9PSAnJyA/IHRpdGxlLnNsaWNlKDAsIDgwKSA6ICdcdTVCRkNcdTUxRkFcdTRGMUFcdThCREQnLFxuICAgICAgICAgIGRlZmF1bHRQYXRoOiBgaG1oLSR7c2lkfS5tZGAsXG4gICAgICAgICAgZmlsdGVyczogW3sgbmFtZTogJ01hcmtkb3duJywgZXh0ZW5zaW9uczogWydtZCddIH1dLFxuICAgICAgICB9KTtcbiAgICAgICAgaWYgKHIuY2FuY2VsZWQgfHwgci5maWxlUGF0aCA9PT0gdW5kZWZpbmVkIHx8IHIuZmlsZVBhdGggPT09ICcnKSByZXR1cm4geyBvazogZmFsc2UsIGNhbmNlbGVkOiB0cnVlIH07XG4gICAgICAgIGF3YWl0IHdyaXRlRmlsZShyLmZpbGVQYXRoLCBtZCwgJ3V0ZjgnKTtcbiAgICAgICAgbG9nSW5mbygnZXhwb3J0JywgYHNlc3Npb24gJHtzaWR9IFx1MjE5MiAke3IuZmlsZVBhdGh9YCk7XG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBwYXRoOiByLmZpbGVQYXRoIH07XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgY29uc3QgZGV0YWlsID0gKCgpID0+IHsgdHJ5IHsgcmV0dXJuIEpTT04uc3RyaW5naWZ5KGVycik7IH0gY2F0Y2ggeyByZXR1cm4gU3RyaW5nKGVycik7IH0gfSkoKS5zbGljZSgwLCAzMDApO1xuICAgICAgICByZXR1cm4geyBlcnJvcjogZGV0YWlsLCBjb2RlOiAnQlJJREdFX0VSUk9SJyB9O1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgLy8gLS0tLSBcdTVCQTFcdTYyNzlcdTZBMjFcdTVGMEZcdThCRkJcdTUxOTkoXHU2NzQzXHU1QTAxXHU1NzI4IHJ1bnRpbWUgY29uZmlnO1x1NTIwN1x1NjM2Mlx1NUZDNVx1OTg3Qlx1NjYzRVx1NUYwRikgLS0tLVxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6YXBwcm92YWwtZ2V0JywgKGV2ZW50KSA9PlxuICAgICAgaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248eyBzZXR0aW5ncz86IHsgYXBwcm92YWw/OiBzdHJpbmcgfSB9PignL2FwaS9zdGF0ZScpKSk7XG5cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmFwcHJvdmFsLXNldCcsIChldmVudCwgbW9kZTogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3QgbSA9IG1vZGUgPT09ICdhdXRvJyA/ICdhdXRvJyA6IG1vZGUgPT09ICdhc2snID8gJ2FzaycgOiAnJztcbiAgICAgIGlmIChtID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAnbW9kZSBtdXN0IGJlIGFza3xhdXRvJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PignL2FwaS9jb25maWcnLCB7IGFwcHJvdmFsOiBtIH0pKTtcbiAgICB9KTtcblxuICAgIC8vIC0tLS0gaG1oYXJuZXNzIHJ1bnRpbWUgXHU4RkRFXHU2M0E1KFx1ODFFQVx1NTJBOFx1NTNEMVx1NzNCMCArIFx1NjI0Qlx1NTJBOFx1ODk4Nlx1NzZENiArIFx1NzBFRFx1NTIwN1x1NjM2MikgLS0tLVxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cnVudGltZS1pbmZvJywgKGV2ZW50KSA9PiB7XG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgbW9kZTogYnJpZGdlLm1vZGUsXG4gICAgICAgIHJ1bnRpbWVFbnRyeTogYnJpZGdlLnJ1bnRpbWVFbnRyeSxcbiAgICAgICAgb3ZlcnJpZGU6IGxvYWRSdW50aW1lRW50cnlPdmVycmlkZSgpLFxuICAgICAgICBkZXRlY3RlZDogZGV0ZWN0UmVhbEVudHJ5KCksXG4gICAgICB9O1xuICAgIH0pO1xuXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpicm93c2UtcnVudGltZScsIGFzeW5jIChldmVudCwgdGl0bGU6IHVua25vd24pID0+IHtcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XG4gICAgICBjb25zdCB3aW4gPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5maW5kKCh3KSA9PiAhdy5pc0Rlc3Ryb3llZCgpKTtcbiAgICAgIGlmICh3aW4gPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgZXJyb3I6ICdubyB3aW5kb3cnLCBjb2RlOiAnQlJJREdFX0VSUk9SJyB9O1xuICAgICAgY29uc3QgciA9IGF3YWl0IGRpYWxvZy5zaG93T3BlbkRpYWxvZyh3aW4sIHtcbiAgICAgICAgdGl0bGU6IHR5cGVvZiB0aXRsZSA9PT0gJ3N0cmluZycgJiYgdGl0bGUgIT09ICcnID8gdGl0bGUuc2xpY2UoMCwgMTIwKSA6ICdcdTkwMDlcdTYyRTkgaG1oYXJuZXNzIFx1NzY4NCBkZXNrdG9wLWhvc3QgXHU1MTY1XHU1M0UzJyxcbiAgICAgICAgcHJvcGVydGllczogWydvcGVuRmlsZSddLFxuICAgICAgICBmaWx0ZXJzOiBbeyBuYW1lOiAnZGVza3RvcC1ob3N0JywgZXh0ZW5zaW9uczogWyd0cycsICdqcyddIH1dLFxuICAgICAgfSk7XG4gICAgICBpZiAoci5jYW5jZWxlZCB8fCByLmZpbGVQYXRoc1swXSA9PT0gdW5kZWZpbmVkKSByZXR1cm4geyBvazogZmFsc2UsIGNhbmNlbGVkOiB0cnVlIH07XG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgZW50cnk6IHIuZmlsZVBhdGhzWzBdIH07XG4gICAgfSk7XG5cbiAgICAvKiogXHU4QkJFXHU3RjZFL1x1NkUwNVx1OTY2NFx1NjI0Qlx1NTJBOFx1NTE2NVx1NTNFM1x1NTQwRVx1NzBFRFx1OTFDRFx1NTQyRiBob3N0KFx1N0E3QVx1NEUzMj1cdTU2REVcdTUyMzBcdTgxRUFcdTUyQThcdTUzRDFcdTczQjApXHUzMDAyICovXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpzZXQtcnVudGltZScsIGFzeW5jIChldmVudCwgZW50cnk6IHVua25vd24pID0+IHtcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XG4gICAgICBjb25zdCBlID0gdHlwZW9mIGVudHJ5ID09PSAnc3RyaW5nJyA/IGVudHJ5LnRyaW0oKSA6ICcnO1xuICAgICAgaWYgKGUgIT09ICcnICYmICghaXNBYnNvbHV0ZShlKSB8fCAhZXhpc3RzU3luYyhlKSkpIHtcbiAgICAgICAgcmV0dXJuIHsgZXJyb3I6ICdcdTUxNjVcdTUzRTNcdTVGQzVcdTk4N0JcdTY2MkZcdTVCNThcdTU3MjhcdTc2ODRcdTdFRERcdTVCRjlcdThERUZcdTVGODQoZGVza3RvcC1ob3N0LnRzKScsIGNvZGU6ICdCQURfUkVRVUVTVCcgfTtcbiAgICAgIH1cbiAgICAgIGF3YWl0IHNhdmVSdW50aW1lRW50cnlPdmVycmlkZShlKTtcbiAgICAgIC8vIFx1NzBFRFx1NTIwN1x1NjM2MjpcdTUxNDhcdTRGMThcdTk2QzVcdTUwNUNcdTYzODlcdTVGNTNcdTUyNEQgaG9zdCxcdTUxOERcdTYzMDlcdTY1QjBcdTkxNERcdTdGNkVcdTYyQzlcdThENzdcbiAgICAgIHNzZUFib3J0Py5hYm9ydCgpO1xuICAgICAgaWYgKHN1cGVydmlzb3IgIT09IG51bGwpIGF3YWl0IHN1cGVydmlzb3Iuc3RvcCgpO1xuICAgICAgYXdhaXQgc3RhcnRIb3N0KCk7XG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgbW9kZTogYnJpZGdlLm1vZGUgfTtcbiAgICB9KTtcblxuICAgIC8vIC0tLS0gUHJvdmlkZXIgXHU4QkJFXHU3RjZFKDAzIFx1MDBBN1x1NEUwMzprZXkgXHU1M0VBXHU1MUZBIGhhc0tleS9cdTY3MkJcdTU2REJcdTRGNEQ7XHU0RkREXHU1QjU4XHU3NkY0XHU1MTk5IHJ1bnRpbWUpIC0tLS1cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnByb3ZpZGVycycsIChldmVudCkgPT5cbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPHsgcHJvdmlkZXJzRGV0YWlsPzogQXJyYXk8eyBuYW1lOiBzdHJpbmc7IG1vZGVsOiBzdHJpbmc7IGJhc2VVcmw6IHN0cmluZzsgaGFzS2V5OiBib29sZWFuOyBrZXlUYWlsPzogc3RyaW5nIH0+OyBtb2RlbD86IHN0cmluZyB9PignL2FwaS9zdGF0ZScpKSk7XG5cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnByb3ZpZGVyLXNhdmUnLCAoZXZlbnQsIHByb3ZpZGVyOiB1bmtub3duKSA9PiB7XG4gICAgICBjb25zdCBwID0gcHJvdmlkZXIgYXMgeyBuYW1lPzogdW5rbm93bjsgYmFzZVVybD86IHVua25vd247IG1vZGVsPzogdW5rbm93bjsgYXBpS2V5PzogdW5rbm93biB9O1xuICAgICAgY29uc3QgbmFtZSA9IHR5cGVvZiBwPy5uYW1lID09PSAnc3RyaW5nJyA/IHAubmFtZS5zbGljZSgwLCA4MCkgOiAnJztcbiAgICAgIGNvbnN0IGJhc2VVcmwgPSB0eXBlb2YgcD8uYmFzZVVybCA9PT0gJ3N0cmluZycgPyBwLmJhc2VVcmwuc2xpY2UoMCwgMzAwKSA6ICcnO1xuICAgICAgY29uc3QgbW9kZWwgPSB0eXBlb2YgcD8ubW9kZWwgPT09ICdzdHJpbmcnID8gcC5tb2RlbC5zbGljZSgwLCAxMjApIDogJyc7XG4gICAgICBpZiAobmFtZSA9PT0gJycgfHwgYmFzZVVybCA9PT0gJycgfHwgbW9kZWwgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICduYW1lL2Jhc2VVcmwvbW9kZWwgcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xuICAgICAgY29uc3QgYm9keTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7IG5hbWUsIGJhc2VVcmwsIG1vZGVsIH07XG4gICAgICAvLyBhcGlLZXkgXHU1M0VBXHU1NzI4XHU2NjNFXHU1RjBGXHU4RjkzXHU1MTY1XHU2NUY2XHU0RTBBXHU0RjIwLFx1N0VERFx1NEUwRFx1NTZERVx1NjYzRShyZW5kZXJlciBcdTg4NjhcdTUzNTVcdTYzRDBcdTRFQTRcdTU0MEVcdTUzNzNcdTZFMDVcdTdBN0EpXG4gICAgICBpZiAodHlwZW9mIHA/LmFwaUtleSA9PT0gJ3N0cmluZycgJiYgcC5hcGlLZXkgIT09ICcnKSBib2R5LmFwaUtleSA9IHAuYXBpS2V5LnNsaWNlKDAsIDMwMCk7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvcHJvdmlkZXJzJywgYm9keSkpO1xuICAgIH0pO1xuXG4gICAgLy8gLS0tLSBcdTVERTVcdTRGNUNcdTUzM0EoMDMgXHUwMEE3XHU1MTZEO1x1NTIwN1x1NjM2Mlx1OEJFRFx1NEU0OVx1NEUwRSB3ZWIgXHU3NkY4XHU1NDBDOnJ1bnRpbWUgXHU1MzU1XHU5MDA5IGN3ZCkgLS0tLVxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6d29ya3NwYWNlcycsIChldmVudCkgPT5cbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPHsgY3VycmVudDogc3RyaW5nOyBpdGVtczogQXJyYXk8eyBpZDogc3RyaW5nOyBuYW1lOiBzdHJpbmc7IHBhdGg6IHN0cmluZyB9PiB9PignL2FwaS93b3Jrc3BhY2VzJykpKTtcblxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6d29ya3NwYWNlLXVzZScsIChldmVudCwgaWQ6IHVua25vd24pID0+IHtcbiAgICAgIGNvbnN0IHdpZCA9IHR5cGVvZiBpZCA9PT0gJ3N0cmluZycgPyBpZC5zbGljZSgwLCA2MCkgOiAnJztcbiAgICAgIGlmICh3aWQgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICdpZCByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvd29ya3NwYWNlcy91c2UnLCB7IGlkOiB3aWQgfSkpO1xuICAgIH0pO1xuXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTp3b3Jrc3BhY2UtYWRkJywgKGV2ZW50LCBuYW1lOiB1bmtub3duLCBwYXRoOiB1bmtub3duKSA9PiB7XG4gICAgICBjb25zdCBuID0gdHlwZW9mIG5hbWUgPT09ICdzdHJpbmcnID8gbmFtZS5zbGljZSgwLCAxMjApIDogJyc7XG4gICAgICBjb25zdCBwID0gdHlwZW9mIHBhdGggPT09ICdzdHJpbmcnID8gcGF0aC5zbGljZSgwLCAxMDAwKSA6ICcnO1xuICAgICAgaWYgKHAgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICdwYXRoIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PignL2FwaS93b3Jrc3BhY2VzJywgeyBuYW1lOiBuID09PSAnJyA/IHVuZGVmaW5lZCA6IG4sIHBhdGg6IHAgfSkpO1xuICAgIH0pO1xuXG4gICAgLy8gLS0tLSBcdTRGMUFcdThCRERcdTVGNTJcdTY4NjMvXHU1MjIwXHU5NjY0KFx1NzlGQlx1NTE2NSBhcmNoaXZlL3RyYXNoLFx1NTNFRlx1NjA2Mlx1NTkwRDtydW50aW1lIFx1Njc0M1x1NUEwMSkgLS0tLVxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6c2Vzc2lvbi1vcCcsIChldmVudCwgaWQ6IHVua25vd24sIG9wOiB1bmtub3duKSA9PiB7XG4gICAgICBjb25zdCBzaWQgPSB0eXBlb2YgaWQgPT09ICdzdHJpbmcnID8gaWQucmVwbGFjZSgvW15hLXpBLVowLTlfOi5ALV0vZywgJycpLnNsaWNlKDAsIDgwKSA6ICcnO1xuICAgICAgY29uc3QgbyA9IG9wID09PSAnYXJjaGl2ZScgfHwgb3AgPT09ICdkZWxldGUnID8gb3AgOiAnJztcbiAgICAgIGlmIChzaWQgPT09ICcnIHx8IG8gPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICdpZCBhbmQgb3AoYXJjaGl2ZXxkZWxldGUpIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PihgL2FwaS9zZXNzaW9ucy8ke2VuY29kZVVSSUNvbXBvbmVudChzaWQpfS8ke299YCwge30pKTtcbiAgICB9KTtcblxuICAgIC8vIC0tLS0gTTQ6RGlmZiBcdTk3NjJcdTY3N0YoXHU1M0VBXHU4QkZCIGdpdCBcdTUzRDhcdTY2RjQ7XHU2Mzg4XHU2NzQzXHU1NzI4IHJ1bnRpbWUpIC0tLS1cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmRpZmYnLCAoZXZlbnQsIHNlc3Npb25JZDogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIHNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBzZXNzaW9uSWQuc2xpY2UoMCwgODApIDogJyc7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KGAvYXBpL2RpZmYke3NpZCAhPT0gJycgPyBgP3Nlc3Npb25JZD0ke2VuY29kZVVSSUNvbXBvbmVudChzaWQpfWAgOiAnJ31gKSk7XG4gICAgfSk7XG5cbiAgICAvLyAtLS0tIE01Olx1OEJBNFx1NzdFNVx1NzJCNlx1NjAwMShcdTdFRDNcdTY3ODRcdTUzMTZcdTRFOEJcdTVCOUU7XHU3RjNBXHU2NTcwXHU2MzZFXHU1QjU3XHU2QkI1XHU3NTMxIFVJIFx1NjYzRVx1NzkzQVwiXHU2NUUwXHU2NTcwXHU2MzZFXCIpIC0tLS1cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmNvZ25pdGl2ZScsIChldmVudCkgPT5cbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPFJlY29yZDxzdHJpbmcsIHVua25vd24+PignL2FwaS9jb2duaXRpdmUnKSkpO1xuXG4gICAgLy8gLS0tLSBcdTUzODZcdTUzRjJcdTRGMUFcdThCRERcdTk4ODRcdTg5QzgoXHU2NzAwXHU1NDBFIDgwIFx1Njc2MSxcdTZCQ0ZcdTY3NjEgNTAwIFx1NUI1NztydW50aW1lIFx1Njc0M1x1NUEwMVx1NjU3MFx1NjM2RSkgLS0tLVxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6c2Vzc2lvbi1wcmV2aWV3JywgKGV2ZW50LCBpZDogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIGlkID09PSAnc3RyaW5nJyA/IGlkLnJlcGxhY2UoL1teYS16QS1aMC05XzouQC1dL2csICcnKS5zbGljZSgwLCA4MCkgOiAnJztcbiAgICAgIGlmIChzaWQgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICdpZCByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KGAvYXBpL3Nlc3Npb25zLyR7ZW5jb2RlVVJJQ29tcG9uZW50KHNpZCl9YCkpO1xuICAgIH0pO1xuXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpzdG9wLWhvc3QnLCAoZXZlbnQpID0+IHtcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicgfTtcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcbiAgICAgICAgc3NlQWJvcnQ/LmFib3J0KCk7XG4gICAgICAgIGF3YWl0IHN1cGVydmlzb3I/LnN0b3AoKTtcbiAgICAgICAgYXBwLnF1aXQoKTtcbiAgICAgIH0pKCk7XG4gICAgICByZXR1cm4geyBvazogdHJ1ZSB9O1xuICAgIH0pO1xuICB9XG5cbiAgLyogLS0tLSBcdTdBOTdcdTUzRTNcdTRFMEVcdTVCODlcdTUxNjhcdTdCNTZcdTc1NjUgLS0tLSAqL1xuICAvLyAwMyBcdTAwQTdcdTRFMDM6RGVza3RvcCBcdTY3MkNcdTU3MzBcdTUzRUFcdTVCNTggVUkgXHU1MDRGXHU1OTdEL1x1N0E5N1x1NTNFM1x1NzJCNlx1NjAwMSh1c2VyRGF0YS93aW5kb3ctc3RhdGUuanNvbilcbiAgY29uc3Qgd2luZG93U3RhdGVGaWxlID0gKCk6IHN0cmluZyA9PiBqb2luKGFwcC5nZXRQYXRoKCd1c2VyRGF0YScpLCAnd2luZG93LXN0YXRlLmpzb24nKTtcbiAgYXN5bmMgZnVuY3Rpb24gbG9hZEJvdW5kcygpOiBQcm9taXNlPHsgd2lkdGg6IG51bWJlcjsgaGVpZ2h0OiBudW1iZXI7IHg/OiBudW1iZXI7IHk/OiBudW1iZXIgfSB8IG51bGw+IHtcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIEpTT04ucGFyc2UoYXdhaXQgcmVhZEZpbGUod2luZG93U3RhdGVGaWxlKCksICd1dGY4JykpIGFzIHsgd2lkdGg6IG51bWJlcjsgaGVpZ2h0OiBudW1iZXI7IHg/OiBudW1iZXI7IHk/OiBudW1iZXIgfTtcbiAgICB9IGNhdGNoIHsgcmV0dXJuIG51bGw7IH1cbiAgfVxuICBhc3luYyBmdW5jdGlvbiBzYXZlQm91bmRzKHdpbjogQnJvd3NlcldpbmRvdyk6IFByb21pc2U8dm9pZD4ge1xuICAgIHRyeSB7IGF3YWl0IHdyaXRlRmlsZSh3aW5kb3dTdGF0ZUZpbGUoKSwgSlNPTi5zdHJpbmdpZnkod2luLmdldEJvdW5kcygpKSwgJ3V0ZjgnKTsgfSBjYXRjaCB7IC8qIGJlc3QgZWZmb3J0ICovIH1cbiAgfVxuXG4gIGFzeW5jIGZ1bmN0aW9uIGNyZWF0ZVdpbmRvdygpOiBQcm9taXNlPEJyb3dzZXJXaW5kb3cgfCBudWxsPiB7XG4gICAgY29uc3Qgc2F2ZWQgPSBhd2FpdCBsb2FkQm91bmRzKCk7XG4gICAgY29uc3Qgd2luID0gbmV3IEJyb3dzZXJXaW5kb3coe1xuICAgICAgd2lkdGg6IHNhdmVkPy53aWR0aCA/PyAxNDQwLFxuICAgICAgaGVpZ2h0OiBzYXZlZD8uaGVpZ2h0ID8/IDkwMCxcbiAgICAgIC4uLihzYXZlZD8ueCAhPT0gdW5kZWZpbmVkICYmIHNhdmVkPy55ICE9PSB1bmRlZmluZWQgPyB7IHg6IHNhdmVkLngsIHk6IHNhdmVkLnkgfSA6IHt9KSxcbiAgICAgIG1pbldpZHRoOiA5NjAsXG4gICAgICBtaW5IZWlnaHQ6IDYwMCxcbiAgICAgIHNob3c6IGZhbHNlLFxuICAgICAgYmFja2dyb3VuZENvbG9yOiAnI2Y5ZmFmYicsIC8vIHY0IERTSDpcdTZENDVcdTgyNzJcdTlFRDhcdThCQTQoYmctYmFzZSksXHU5MDdGXHU1MTREXHU2REYxXHU4MjcyXHU5NUVBXHU1QzRGXG4gICAgICB0aXRsZTogJ0hNSCBEZXNrdG9wJyxcbiAgICAgIC8vIFx1OTY5MFx1ODVDRlx1NUYwRlx1NjgwN1x1OTg5OFx1NjgwRjpcdTUzOUZcdTc1MUZcdTdBOTdcdTUzRTNcdTYzQTdcdTUyMzYob3ZlcmxheSBcdTYzRDBcdTRGOUIpK1x1OTg5Q1x1ODI3Mlx1OTY4Rlx1NEUzQlx1OTg5OChyZW5kZXJlciBcdTdFQ0ZcbiAgICAgIC8vIGNocm9tZS10aGVtZSBcdTU0MENcdTZCNjUpXHUyMDE0XHUyMDE0XHU2ODM5XHU2Q0JCXHU0RUFFXHU4MjcyXHU2QTIxXHU1RjBGXHU5ODc2XHU5MEU4XHU5RUQxXHU2NzYxO1x1ODNEQ1x1NTM1NVx1NjgwRiBhdXRvSGlkZShBbHQgXHU1NDdDXHU1MUZBKVx1MzAwMlxuICAgICAgdGl0bGVCYXJTdHlsZTogJ2hpZGRlbicsXG4gICAgICB0aXRsZUJhck92ZXJsYXk6IHsgLi4uY2hyb21lRm9yKG5hdGl2ZVRoZW1lLnNob3VsZFVzZURhcmtDb2xvcnMpLCBoZWlnaHQ6IDM2IH0sXG4gICAgICBhdXRvSGlkZU1lbnVCYXI6IHRydWUsXG4gICAgICB3ZWJQcmVmZXJlbmNlczoge1xuICAgICAgICBwcmVsb2FkOiBwcmVsb2FkUGF0aCxcbiAgICAgICAgY29udGV4dElzb2xhdGlvbjogdHJ1ZSxcbiAgICAgICAgc2FuZGJveDogdHJ1ZSxcbiAgICAgICAgbm9kZUludGVncmF0aW9uOiBmYWxzZSxcbiAgICAgICAgbm9kZUludGVncmF0aW9uSW5Xb3JrZXI6IGZhbHNlLFxuICAgICAgICB3ZWJTZWN1cml0eTogdHJ1ZSxcbiAgICAgICAgc3BlbGxjaGVjazogZmFsc2UsXG4gICAgICAgIGRldlRvb2xzOiBpc0RldixcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgd2luLm9uY2UoJ3JlYWR5LXRvLXNob3cnLCAoKSA9PiB3aW4uc2hvdygpKTtcbiAgICB3aW4ub24oJ2Nsb3NlJywgKCkgPT4geyB2b2lkIHNhdmVCb3VuZHMod2luKTsgfSk7XG5cbiAgICAvLyBcdTUzRUFcdTUxNDFcdThCQjhcdTUyQTBcdThGN0RcdTYyMTFcdTRFRUNcdTgxRUFcdTVERjFcdTc2ODQgcmVuZGVyZXI7XHU0RUZCXHU0RjU1XHU1QkZDXHU4MjJBL1x1NjVCMFx1N0E5N1x1NTNFM1x1NEUwMFx1NUY4Qlx1NjJEMlx1N0VERFxuICAgIHdpbi53ZWJDb250ZW50cy5zZXRXaW5kb3dPcGVuSGFuZGxlcigoeyB1cmwgfSkgPT4ge1xuICAgICAgaWYgKC9eaHR0cHM/OlxcL1xcLy8udGVzdCh1cmwpKSB2b2lkIHNoZWxsLm9wZW5FeHRlcm5hbCh1cmwpO1xuICAgICAgcmV0dXJuIHsgYWN0aW9uOiAnZGVueScgfTtcbiAgICB9KTtcbiAgICB3aW4ud2ViQ29udGVudHMub24oJ3dpbGwtbmF2aWdhdGUnLCAoZSwgdXJsKSA9PiB7XG4gICAgICBjb25zdCBvayA9IFsuLi5hbGxvd2VkT3JpZ2luc10uc29tZSgobykgPT4gdXJsID09PSBvIHx8IHVybC5zdGFydHNXaXRoKGAke299L2ApIHx8IHVybC5zdGFydHNXaXRoKGAke299P2ApKTtcbiAgICAgIGlmICghb2spIHtcbiAgICAgICAgbG9nSW5mbygnbmF2JywgYGJsb2NrZWQgbmF2aWdhdGlvbiB0byAke3VybC5zbGljZSgwLCAxMjApfWApO1xuICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICBpZiAoaXNEZXYgJiYgcmVuZGVyZXJEZXZVcmwpIHtcbiAgICAgIHZvaWQgd2luLmxvYWRVUkwocmVuZGVyZXJEZXZVcmwpO1xuICAgIH0gZWxzZSB7XG4gICAgICB2b2lkIHdpbi5sb2FkRmlsZShqb2luKGhlcmUsICcuLicsICcuLicsICdkaXN0LXJlbmRlcmVyJywgJ2luZGV4Lmh0bWwnKSk7XG4gICAgfVxuICAgIC8vIFx1OTg3NVx1OTc2Mlx1NTJBMFx1OEY3RFx1NUI4Q1x1OTFDRFx1NjRBRFx1NUY1M1x1NTI0RCBob3N0IFx1NzJCNlx1NjAwMTpyZWFkeSBcdTVFN0ZcdTY0QURcdTgyRTVcdTY1RTlcdTRFOEUgcmVuZGVyZXIgXHU4QkEyXHU5NjA1XHU1MzczXHU0RTIyXHU1OTMxLFxuICAgIC8vIHJlbmRlcmVyIFx1NzY4NCBnZXQtc3RhdGUgXHU1RkVCXHU3MTY3ICsgXHU4RkQ5XHU5MUNDXHU3Njg0XHU5MUNEXHU2NEFEXHU1M0NDXHU0RkREXHU5NjY5KFx1NTkxQVx1N0E5N1x1NTNFMy9cdTkxQ0RcdThGN0RcdTU3M0FcdTY2NkZcdTRFNUZcdTg5ODZcdTc2RDYpXHUzMDAyXG4gICAgd2luLndlYkNvbnRlbnRzLm9uY2UoJ2RpZC1maW5pc2gtbG9hZCcsICgpID0+IHtcbiAgICAgIGlmICghd2luLmlzRGVzdHJveWVkKCkpIHtcbiAgICAgICAgd2luLndlYkNvbnRlbnRzLnNlbmQoJ2JyaWRnZTpob3N0LXN0YXRlJywgYnJpZGdlLmhvc3RTdGF0ZSwgeyByZXN0YXJ0Q291bnQ6IDAgfSk7XG4gICAgICB9XG4gICAgfSk7XG4gICAgcmV0dXJuIHdpbjtcbiAgfVxuXG4gIGFwcC53aGVuUmVhZHkoKS50aGVuKCgpID0+IHtcbiAgICAvLyBVSVZFUklGWTpmYWtlIFx1NkEyMVx1NUYwRlx1OUE4Q1x1NjUzNlx1OTg3Qlx1NTcyOCBzdGFydEhvc3QgXHU4QkZCIGVudiBcdTRFNEJcdTUyNERcdTVGM0FcdTUyMzYgZmFrZVxuICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWSA9PT0gJzEnICYmIHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX01PREUgIT09ICdyZWFsJykge1xuICAgICAgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfRkFLRSA9ICcxJztcbiAgICB9XG4gICAgLy8gV2luZG93cyBcdTkwMUFcdTc3RTVcdTVGNTJcdTVDNUUoXHU1NDI2XHU1MjE5XHU2NjNFXHU3OTNBXHU0RTNBIGVsZWN0cm9uLmV4ZSlcbiAgICBhcHAuc2V0QXBwVXNlck1vZGVsSWQoJ2Rldi5obWguZGVza3RvcCcpO1xuICAgIHNldHVwVHJheSgpO1xuICAgIGJ1aWxkQXBwTWVudSgpO1xuICAgIC8vIFx1NTQyRlx1NTJBOCAzMHMgXHU1NDBFXHU5NzU5XHU5RUQ4XHU2OEMwXHU2N0U1XHU2NkY0XHU2NUIwKFx1NjcwOVx1NjVCMFx1NzI0OFx1NEVDNVx1NTQwRVx1NTNGMFx1NEUwQlx1OEY3RCxcdTRFMERcdTYyNTNcdTYyNzA7XHU3NTI4XHU2MjM3XHU3RUNGIFx1MjYzMCBcdTgzRENcdTUzNTVcdTUxQjNcdTVCOUFcdTg4QzUpXG4gICAgaWYgKGFwcC5pc1BhY2thZ2VkKSBzZXRUaW1lb3V0KCgpID0+IHsgdm9pZCBjaGVja0ZvclVwZGF0ZXMoKTsgfSwgMzBfMDAwKTtcbiAgICAvLyBDU1AoZGV2IFx1NEUwRSBwcm9kIFx1NEUwRFx1NTQwQztwcm9kIFx1NEUwRFx1NTE0MVx1OEJCOFx1NEVGQlx1NEY1NVx1OEZEQ1x1N0EwQlx1NkU5MClcbiAgICBjb25zdCBjc3AgPSBpc0RldlxuICAgICAgPyBbXG4gICAgICAgICAgXCJkZWZhdWx0LXNyYyAnc2VsZidcIixcbiAgICAgICAgICBgc2NyaXB0LXNyYyAnc2VsZicgJHtyZW5kZXJlckRldlVybH1gLFxuICAgICAgICAgIFwic3R5bGUtc3JjICdzZWxmJyAndW5zYWZlLWlubGluZSdcIixcbiAgICAgICAgICBgY29ubmVjdC1zcmMgJ3NlbGYnICR7cmVuZGVyZXJEZXZVcmx9IHdzOi8vMTI3LjAuMC4xOipgLFxuICAgICAgICAgIFwiaW1nLXNyYyAnc2VsZicgZGF0YTpcIixcbiAgICAgICAgICBcImZvbnQtc3JjICdzZWxmJyBkYXRhOlwiLFxuICAgICAgICBdLmpvaW4oJzsgJylcbiAgICAgIDogXCJkZWZhdWx0LXNyYyAnc2VsZic7IHNjcmlwdC1zcmMgJ3NlbGYnOyBzdHlsZS1zcmMgJ3NlbGYnICd1bnNhZmUtaW5saW5lJzsgaW1nLXNyYyAnc2VsZicgZGF0YTo7IGZvbnQtc3JjICdzZWxmJyBkYXRhOlwiO1xuICAgIHNlc3Npb24uZGVmYXVsdFNlc3Npb24ud2ViUmVxdWVzdC5vbkhlYWRlcnNSZWNlaXZlZCgoZGV0YWlscywgY2FsbGJhY2spID0+IHtcbiAgICAgIGNhbGxiYWNrKHtcbiAgICAgICAgcmVzcG9uc2VIZWFkZXJzOiB7XG4gICAgICAgICAgLi4uZGV0YWlscy5yZXNwb25zZUhlYWRlcnMsXG4gICAgICAgICAgJ0NvbnRlbnQtU2VjdXJpdHktUG9saWN5JzogW2NzcF0sXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHJlZ2lzdGVySXBjKCk7XG4gICAgLy8gY3JlYXRlV2luZG93IFx1NjYyRiBhc3luYyhib3VuZHMgXHU2MDYyXHU1OTBEKTtcdTVCODlcdTUxNjhcdTgxRUFcdTZENEIvXHU2RTMyXHU2N0QzXHU4MUVBXHU2OEMwXHU1NzI4XHU3QTk3XHU1M0UzXHU1QzMxXHU3RUVBXHU1NDBFXHU2MzAyXHU4RjdEXG4gICAgdm9pZCBjcmVhdGVXaW5kb3coKS50aGVuKCh3aW4pID0+IHtcbiAgICAgIGlmICh3aW4gPT09IG51bGwpIHJldHVybjtcbiAgICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWSA9PT0gJzEnKSBhdHRhY2hVaVZlcmlmeSh3aW4pO1xuICAgICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NFQ1VSSVRZX1RFU1QgPT09ICcxJykge1xuICAgICAgICB3aW4ud2ViQ29udGVudHMub25jZSgnZGlkLWZpbmlzaC1sb2FkJywgKCkgPT4ge1xuICAgICAgICAgIHZvaWQgc2VjdXJpdHlTZWxmVGVzdCh3aW4pO1xuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICAgIC8vIFVJIFx1NjIyQVx1NTZGRVx1OTRBOVx1NUI1MDpITUhfREVTS1RPUF9TTkFQU0hPVD08ZmlsZS5wbmc+IFx1NTcyOFx1NzU0Q1x1OTc2Mlx1NUMzMVx1N0VFQVx1NTQwRVx1NjIyQVx1NTZGRVx1OTAwMFx1NTFGQVxuICAgICAgLy8gKFx1ODhDNVx1NjczQVx1OEJDQVx1NjVBRFx1NzUyODpcdTRFQjJcdTc3M0NcdTc3MEJcdTZFMzJcdTY3RDNcdTdFRDNcdTY3OUMsXHU4MDBDXHU0RTBEXHU2NjJGXHU1M0VBXHU2NTcwIHJvb3QgXHU1QjUwXHU4MjgyXHU3MEI5KVx1MzAwMlxuICAgICAgY29uc3Qgc25hcCA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NOQVBTSE9UO1xuICAgICAgaWYgKHNuYXAgIT09IHVuZGVmaW5lZCAmJiBzbmFwICE9PSAnJykge1xuICAgICAgICB3aW4ud2ViQ29udGVudHMub25jZSgnZGlkLWZpbmlzaC1sb2FkJywgKCkgPT4ge1xuICAgICAgICAgIHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGNvbnN0IGltZyA9IGF3YWl0IHdpbi53ZWJDb250ZW50cy5jYXB0dXJlUGFnZSgpO1xuICAgICAgICAgICAgICAgIGNvbnN0IHsgd3JpdGVGaWxlOiB3ZiB9ID0gYXdhaXQgaW1wb3J0KCdub2RlOmZzL3Byb21pc2VzJyk7XG4gICAgICAgICAgICAgICAgYXdhaXQgd2Yoc25hcCwgaW1nLnRvUE5HKCkpO1xuICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBTTkFQU0hPVCBvayAke3NuYXB9ICR7aW1nLmdldFNpemUoKS53aWR0aH14JHtpbWcuZ2V0U2l6ZSgpLmhlaWdodH1gKTtcbiAgICAgICAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYFNOQVBTSE9UIGVycm9yICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTIwKX1gKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICBjb25zdCBhcHAyID0gYXBwO1xuICAgICAgICAgICAgICBzZXRUaW1lb3V0KCgpID0+IGFwcDIuZXhpdCgwKSwgNTAwKTtcbiAgICAgICAgICAgIH0pKCk7XG4gICAgICAgICAgfSwgTnVtYmVyKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NOQVBTSE9UX0RFTEFZX01TID8/IDEyXzAwMCkpO1xuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICAgIC8vIERPTSBcdTdFRDNcdTY3ODRcdTYzQTJcdTk0ODg6SE1IX0RFU0tUT1BfRE9NUFJPQkU9MSBcdThGOTNcdTUxRkFcdTUxNzNcdTk1MkVcdTUxNDNcdTdEMjBcdTc2ODQgYm94L2Rpc3BsYXkvY2hpbGRyZW4sXG4gICAgICAvLyBcdTUxOERcdTkwMDBcdTUxRkEoXHU4QkNBXHU2NUFEXCJSZWFjdCBcdTYzMDJcdThGN0RcdTRFODZcdTRGNDZcdTY3RDBcdTU3NTcgVUkgXHU0RTBEXHU1M0VGXHU4OUMxXCJcdThGRDlcdTdDN0JcdTk1RUVcdTk4OTg7XHU2MjJBXHU1NkZFXHU0RTRCXHU1OTE2XHU3Njg0XHU3ODZDXHU4QkMxXHU2MzZFKVx1MzAwMlxuICAgICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX0RPTVBST0JFID09PSAnMScpIHtcbiAgICAgICAgd2luLndlYkNvbnRlbnRzLm9uY2UoJ2RpZC1maW5pc2gtbG9hZCcsICgpID0+IHtcbiAgICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcbiAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBjb25zdCByID0gKGF3YWl0IHdpbi53ZWJDb250ZW50cy5leGVjdXRlSmF2YVNjcmlwdChgKGZ1bmN0aW9uKCl7XG4gICAgICAgICAgICAgICAgICB2YXIgcGljayA9IGZ1bmN0aW9uKHNlbCl7XG4gICAgICAgICAgICAgICAgICAgIHZhciBlbHMgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKHNlbCk7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBBcnJheS5wcm90b3R5cGUuc2xpY2UuY2FsbChlbHMsIDAsIDQpLm1hcChmdW5jdGlvbihlbCl7XG4gICAgICAgICAgICAgICAgICAgICAgdmFyIGNzID0gZ2V0Q29tcHV0ZWRTdHlsZShlbCk7XG4gICAgICAgICAgICAgICAgICAgICAgdmFyIGIgPSBlbC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgICAgICAgICAgICAgICAgICAgICByZXR1cm4geyBjbHM6IChlbC5jbGFzc05hbWV8fCcnKS50b1N0cmluZygpLnNsaWNlKDAsODApLCB0YWc6IGVsLnRhZ05hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICBkaXNwbGF5OiBjcy5kaXNwbGF5LCB2aXM6IGNzLnZpc2liaWxpdHksIG9wYWNpdHk6IGNzLm9wYWNpdHksXG4gICAgICAgICAgICAgICAgICAgICAgICBwb3M6IGNzLnBvc2l0aW9uLCB6OiBjcy56SW5kZXgsIG92ZXJmbG93OiBjcy5vdmVyZmxvdyxcbiAgICAgICAgICAgICAgICAgICAgICAgIHg6IE1hdGgucm91bmQoYi54KSwgeTogTWF0aC5yb3VuZChiLnkpLCB3OiBNYXRoLnJvdW5kKGIud2lkdGgpLCBoOiBNYXRoLnJvdW5kKGIuaGVpZ2h0KSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHRleHQ6IChlbC5pbm5lclRleHR8fCcnKS5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNjApIH07XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICAgIHZhciBzZWxzID0gWydodG1sJywnYm9keScsJyNyb290JywnLmFwcC1zaGVsbCcsJy5zaWRlYmFyJywnLndvcmtzcGFjZScsJy50b3BiYXInLCcuc3RyZWFtJywnLmVtcHR5LWhpbnQnLCcuY29tcG9zZXInLCcuY29tcG9zZXItcm93JywnLmNvbXBvc2VyIHRleHRhcmVhJywnLmNvbXBvc2VyLXNpZGUnLCcuYXR0LXBpY2tlcicsJy5hdHQtY2hpcHMnLCcuc2lkZXBhbmVsJywnLnJ1bnRpbWUtZ3VpZGUnLCcub3ZlcmxheScsJy50dXJuJywnLmNhcmQnXTtcbiAgICAgICAgICAgICAgICAgIHZhciBvdXQgPSB7fTtcbiAgICAgICAgICAgICAgICAgIHNlbHMuZm9yRWFjaChmdW5jdGlvbihzKXsgdHJ5IHsgb3V0W3NdID0gcGljayhzKTsgfSBjYXRjaChlKXsgb3V0W3NdID0gW3tlcnI6IFN0cmluZyhlKS5zbGljZSgwLDgwKX1dOyB9IH0pO1xuICAgICAgICAgICAgICAgICAgb3V0Ll9fbWV0YSA9IHtcbiAgICAgICAgICAgICAgICAgICAgc3R5bGVTaGVldHM6IGRvY3VtZW50LnN0eWxlU2hlZXRzLmxlbmd0aCxcbiAgICAgICAgICAgICAgICAgICAgc2hlZXQwcnVsZXM6IChkb2N1bWVudC5zdHlsZVNoZWV0c1swXSAmJiBkb2N1bWVudC5zdHlsZVNoZWV0c1swXS5jc3NSdWxlcykgPyBkb2N1bWVudC5zdHlsZVNoZWV0c1swXS5jc3NSdWxlcy5sZW5ndGggOiAtMSxcbiAgICAgICAgICAgICAgICAgICAgcm9vdENoaWxkcmVuOiBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncm9vdCcpID8gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Jvb3QnKS5jaGlsZHJlbi5sZW5ndGggOiAtMSxcbiAgICAgICAgICAgICAgICAgICAgYm9keUNoaWxkcmVuOiBkb2N1bWVudC5ib2R5LmNoaWxkcmVuLmxlbmd0aCxcbiAgICAgICAgICAgICAgICAgICAgaW5uZXJIVE1MTGVuOiBkb2N1bWVudC5ib2R5LmlubmVySFRNTC5sZW5ndGgsXG4gICAgICAgICAgICAgICAgICAgIHZpZXdwb3J0OiB3aW5kb3cuaW5uZXJXaWR0aCArICd4JyArIHdpbmRvdy5pbm5lckhlaWdodFxuICAgICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeShvdXQpO1xuICAgICAgICAgICAgICAgIH0pKClgLCB0cnVlKSkgYXMgc3RyaW5nO1xuICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBET01QUk9CRSAke3J9YCk7XG4gICAgICAgICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBET01QUk9CRSBlcnJvciAke1N0cmluZyhlcnIpLnNsaWNlKDAsIDIwMCl9YCk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgYXBwLmV4aXQoMCk7XG4gICAgICAgICAgICB9KSgpO1xuICAgICAgICAgIH0sIE51bWJlcihwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9ET01QUk9CRV9ERUxBWV9NUyA/PyA5XzAwMCkpO1xuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICAgIC8vIFx1NkUzMlx1NjdEM1x1ODFFQVx1NjhDMCgyMDI2LTEwLTEwIFx1ODhDNVx1NjczQVx1OUVEMVx1NUM0Rlx1NjU1OVx1OEJBRDpicmlkZ2UgcmVhZHkgXHUyMjYwIFx1NzU0Q1x1OTc2Mlx1NkUzMlx1NjdEM1x1NEU4NilcdTMwMDJcbiAgICAgIC8vICNyb290IFx1NTcyOCBSZWFjdCBcdTYzMDJcdThGN0RcdTU0MEVcdTVGQzVcdTY3MDlcdTVCNTBcdTgyODJcdTcwQjk7XHU3QTdBID0gXHU4RDQ0XHU2RTkwXHU4REVGXHU1Rjg0L0NTUC9cdTgxMUFcdTY3MkNcdTUyQTBcdThGN0RcdTU3NEZcdTRFODZcdTMwMDJcbiAgICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9SRU5ERVJfVEVTVCA9PT0gJzEnKSB7XG4gICAgICAgIHdpbi53ZWJDb250ZW50cy5vbmNlKCdkaWQtZmluaXNoLWxvYWQnLCAoKSA9PiB7XG4gICAgICAgICAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgICAgICB2b2lkIChhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgY29uc3QgbiA9IChhd2FpdCB3aW4ud2ViQ29udGVudHMuZXhlY3V0ZUphdmFTY3JpcHQoXG4gICAgICAgICAgICAgICAgICAnZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJyb290XCIpID8gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJyb290XCIpLmNoaWxkcmVuLmxlbmd0aCA6IC0xJywgdHJ1ZSxcbiAgICAgICAgICAgICAgICApKSBhcyBudW1iZXI7XG4gICAgICAgICAgICAgICAgY29uc3Qgb2sgPSBuID4gMDtcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgUkVOREVSLVRFU1QgJHtvayA/ICdvaycgOiAnRU1QVFknfSByb290Q2hpbGRyZW49JHtufWApO1xuICAgICAgICAgICAgICAgIGFwcC5leGl0KG9rID8gMCA6IDEpO1xuICAgICAgICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgUkVOREVSLVRFU1QgRVJST1IgJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApfWApO1xuICAgICAgICAgICAgICAgIGFwcC5leGl0KDEpO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KSgpO1xuICAgICAgICAgIH0sIDJfNTAwKTtcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfSk7XG4gICAgdm9pZCBzdGFydEhvc3QoKTtcblxuICAgIGFwcC5vbignYWN0aXZhdGUnLCAoKSA9PiB7XG4gICAgICBpZiAoQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkubGVuZ3RoID09PSAwKSB2b2lkIGNyZWF0ZVdpbmRvdygpO1xuICAgIH0pO1xuICB9KTtcblxuICBhc3luYyBmdW5jdGlvbiBzZWN1cml0eVNlbGZUZXN0KHdpbjogQnJvd3NlcldpbmRvdyk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IHJlc3VsdHM6IEFycmF5PFtzdHJpbmcsIGJvb2xlYW4sIHN0cmluZ10+ID0gW107XG4gICAgY29uc3QgY2hlY2sgPSBhc3luYyAobmFtZTogc3RyaW5nLCBwcm9iZTogKCkgPT4gUHJvbWlzZTxbYm9vbGVhbiwgc3RyaW5nXT4pOiBQcm9taXNlPHZvaWQ+ID0+IHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IFtvaywgZGV0YWlsXSA9IGF3YWl0IHByb2JlKCk7XG4gICAgICAgIHJlc3VsdHMucHVzaChbbmFtZSwgb2ssIGRldGFpbF0pO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIHJlc3VsdHMucHVzaChbbmFtZSwgZmFsc2UsIFN0cmluZyhlcnIpLnNsaWNlKDAsIDEyMCldKTtcbiAgICAgIH1cbiAgICB9O1xuICAgIGNvbnN0IGpzID0gKGNvZGU6IHN0cmluZyk6IFByb21pc2U8dW5rbm93bj4gPT4gd2luLndlYkNvbnRlbnRzLmV4ZWN1dGVKYXZhU2NyaXB0KGNvZGUsIHRydWUpO1xuXG4gICAgYXdhaXQgY2hlY2soJ3JlbmRlcmVyIFx1NjVFMFx1NTNFRlx1NzUyOFx1NzY4NCBwcm9jZXNzL3JlcXVpcmUoc2FuZGJveCBcdTc1MUZcdTY1NDgpJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgciA9IChhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XG4gICAgICAgIHZhciB0ID0gZnVuY3Rpb24oZil7IHRyeSB7IHZhciB2ID0gZigpOyByZXR1cm4gKHYgPT09IHVuZGVmaW5lZCB8fCB2ID09PSBudWxsKSA/ICd1bmF2YWlsYWJsZScgOiB0eXBlb2YgdjsgfSBjYXRjaChlKXsgcmV0dXJuICdibG9ja2VkJzsgfSB9O1xuICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoW3QoZnVuY3Rpb24oKXtyZXR1cm4gcHJvY2Vzc30pLCB0KGZ1bmN0aW9uKCl7cmV0dXJuIHJlcXVpcmV9KSwgdChmdW5jdGlvbigpe3JldHVybiBnbG9iYWxUaGlzLnByb2Nlc3N9KV0pO1xuICAgICAgfSkoKWApKSBhcyBzdHJpbmc7XG4gICAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHIpIGFzIHN0cmluZ1tdO1xuICAgICAgY29uc3QgcCA9IHBhcnNlZFswXSA/PyAndW5rbm93bic7XG4gICAgICBjb25zdCByZXEgPSBwYXJzZWRbMV0gPz8gJ3Vua25vd24nO1xuICAgICAgY29uc3Qgc2FmZSA9ICh2OiBzdHJpbmcpOiBib29sZWFuID0+IHYgPT09ICd1bmF2YWlsYWJsZScgfHwgdiA9PT0gJ2Jsb2NrZWQnO1xuICAgICAgcmV0dXJuIFtzYWZlKHApICYmIHNhZmUocmVxKSwgYHByb2Nlc3M9JHtwfSByZXF1aXJlPSR7cmVxfWBdO1xuICAgIH0pO1xuICAgIGF3YWl0IGNoZWNrKCd3aW5kb3cuaG1oIFx1NTNFQVx1NjcwOVx1NzY3RFx1NTQwRFx1NTM1NVx1NjVCOVx1NkNENShcdTY1RTAgaXBjUmVuZGVyZXIvXHU5ODlEXHU1OTE2XHU5NzYyKScsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoJ09iamVjdC5rZXlzKHdpbmRvdy5obWggfHwge30pLnNvcnQoKS5qb2luKFwiLFwiKScpKSBhcyBzdHJpbmc7XG4gICAgICBjb25zdCBhbGxvdyA9IFsnYXBwcm92ZScsICdhcHByb3ZhbEdldCcsICdhcHByb3ZhbFNldCcsICdicm93c2VSdW50aW1lJywgJ2Nocm9tZVRoZW1lJywgJ2NvZ25pdGl2ZScsICdkaWZmJywgJ2V4cG9ydFNlc3Npb24nLCAnZnNMaXN0JywgJ2ZzUmVhZCcsICdmc1NlYXJjaCcsICdnZXRTdGF0ZScsICdpbmplY3QnLCAnaW50ZXJydXB0JywgJ21vZGVsU2V0JywgJ29uRXZlbnRCYXRjaGVzJywgJ29uSG9zdFN0YXRlJywgJ29uTWVudUFjdGlvbicsICdvblN0cmVhbUNodW5rcycsICdwaWNrRGlyZWN0b3J5JywgJ3BpY2tGaWxlcycsICdwb3B1cE1haW5NZW51JywgJ3Byb3ZpZGVyU2F2ZScsICdwcm92aWRlcnMnLCAncmVtb3RlV2ViQXV0b3N0YXJ0JywgJ3JlbW90ZVdlYlN0YXJ0JywgJ3JlbW90ZVdlYlN0YXR1cycsICdyZW1vdGVXZWJTdG9wJywgJ3J1bnRpbWVJbmZvJywgJ3NlbmRUYXNrJywgJ3Nlc3Npb25PcCcsICdzZXNzaW9uUHJldmlldycsICdzZXNzaW9ucycsICdzZXRSdW50aW1lJywgJ3N0b3BIb3N0JywgJ3dvcmtzcGFjZXMnLCAnd29ya3NwYWNlQWRkJywgJ3dvcmtzcGFjZVVzZSddO1xuICAgICAgY29uc3QgZ290ID0gciA9PT0gJycgPyBbXSA6IHIuc3BsaXQoJywnKTtcbiAgICAgIGNvbnN0IHVuZXhwZWN0ZWQgPSBnb3QuZmlsdGVyKChrKSA9PiAhYWxsb3cuaW5jbHVkZXMoaykpO1xuICAgICAgcmV0dXJuIFt1bmV4cGVjdGVkLmxlbmd0aCA9PT0gMCwgYGtleXM9JHtyfWBdO1xuICAgIH0pO1xuICAgIGF3YWl0IGNoZWNrKCdcdTU5MTZcdTkwRThcdTVCRkNcdTgyMkFcdTg4QUJcdTYyRTZcdTYyMkEoVVJMIFx1NEUwRFx1NTNEOCknLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBiZWZvcmUgPSB3aW4ud2ViQ29udGVudHMuZ2V0VVJMKCk7XG4gICAgICBhd2FpdCBqcygnbG9jYXRpb24uaHJlZiA9IFwiaHR0cHM6Ly9leGFtcGxlLmludmFsaWQveFwiOyBcIm5vb3BcIicpLmNhdGNoKCgpID0+ICdub29wJyk7XG4gICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocjIpID0+IHNldFRpbWVvdXQocjIsIDFfMjAwKSk7XG4gICAgICBjb25zdCBhZnRlciA9IHdpbi53ZWJDb250ZW50cy5nZXRVUkwoKTtcbiAgICAgIHJldHVybiBbYWZ0ZXIgPT09IGJlZm9yZSwgYCR7YmVmb3JlfSBcdTIxOTIgJHthZnRlcn1gXTtcbiAgICB9KTtcbiAgICBhd2FpdCBjaGVjaygnd2luZG93Lm9wZW4gXHU4OEFCXHU2MkQyXHU3RUREKFx1OEZENFx1NTZERSBudWxsIFx1NEUxNFx1NjVFMFx1NjVCMFx1N0E5N1x1NTNFMyknLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBiZWZvcmUgPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5sZW5ndGg7XG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKCdTdHJpbmcod2luZG93Lm9wZW4oXCJodHRwczovL2V4YW1wbGUuaW52YWxpZFwiKSknKSkgYXMgc3RyaW5nO1xuICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHIyKSA9PiBzZXRUaW1lb3V0KHIyLCA0MDApKTtcbiAgICAgIGNvbnN0IGFmdGVyID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkubGVuZ3RoO1xuICAgICAgcmV0dXJuIFtyID09PSAnbnVsbCcgJiYgYWZ0ZXIgPT09IGJlZm9yZSwgYG9wZW4oKT0ke3J9IHdpbmRvd3M9JHtiZWZvcmV9XHUyMTkyJHthZnRlcn1gXTtcbiAgICB9KTtcbiAgICBhd2FpdCBjaGVjaygnQ1NQIFx1NUI1OFx1NTcyOChtZXRhIFx1NkNFOFx1NTE2NVx1NjIxNlx1NTRDRFx1NUU5NFx1NTkzNCknLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBtZXRhID0gKGF3YWl0IGpzKCdCb29sZWFuKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoXCJtZXRhW2h0dHAtZXF1aXY9XFwnQ29udGVudC1TZWN1cml0eS1Qb2xpY3lcXCddXCIpKScpKSBhcyBib29sZWFuO1xuICAgICAgY29uc3QgaGVhZGVyQ3NwID0gaXNEZXYgPyAnZGV2OiBoZWFkZXIgQ1NQIFx1NzUzMSBvbkhlYWRlcnNSZWNlaXZlZCBcdTZDRThcdTUxNjUoXHU0RTBEXHU5MDAyXHU3NTI4IG1ldGEgXHU2NUFEXHU4QTAwKScgOiAncHJvZCc7XG4gICAgICByZXR1cm4gW21ldGEgfHwgaXNEZXYsIGBtZXRhPSR7bWV0YX0gJHtoZWFkZXJDc3B9YF07XG4gICAgfSk7XG4gICAgYXdhaXQgY2hlY2soJ2JyaWRnZTpnZXQtc3RhdGUgXHU2QjYzXHU1RTM4XHU4RkQ0XHU1NkRFKGhvc3QgXHU2ODY1XHU1M0VGXHU3NTI4KScsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoJ3dpbmRvdy5obWguZ2V0U3RhdGUoKS50aGVuKHMgPT4gSlNPTi5zdHJpbmdpZnkocykpLmNhdGNoKGUgPT4gXCJFUlI6XCIrZSknKSkgYXMgc3RyaW5nO1xuICAgICAgcmV0dXJuIFtyLnN0YXJ0c1dpdGgoJ3snKSAmJiByLmluY2x1ZGVzKCdob3N0U3RhdGUnKSwgci5zbGljZSgwLCA4MCldO1xuICAgIH0pO1xuICAgIGF3YWl0IGNoZWNrKCdYU1M6XHU2MDc2XHU2MTBGXHU0RUZCXHU1MkExXHU2NTg3XHU2NzJDXHU1M0VBXHU0RUU1XHU2NTg3XHU2NzJDXHU2RTMyXHU2N0QzKFx1NEUwRFx1NjI2N1x1ODg0QyknLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBwYXlsb2FkID0gJzxpbWcgc3JjPXggb25lcnJvcj1cIndpbmRvdy5fX3hzcz0xXCI+PHNjcmlwdD53aW5kb3cuX194c3M9MjxcXC9zY3JpcHQ+XCImXFwnJztcbiAgICAgIGNvbnN0IHNlbmRSID0gKGF3YWl0IGpzKGB3aW5kb3cuaG1oLnNlbmRUYXNrKCR7SlNPTi5zdHJpbmdpZnkocGF5bG9hZCl9LCAnc2VjLXhzcy0xJywgJ2F1dG8nKS50aGVuKHI9PkpTT04uc3RyaW5naWZ5KHIpKS5jYXRjaChlPT4nRVJSOicrZSlgKSkgYXMgc3RyaW5nO1xuICAgICAgaWYgKCFzZW5kUi5pbmNsdWRlcygnXCJva1wiOnRydWUnKSkgcmV0dXJuIFtmYWxzZSwgYHNlbmRUYXNrIFx1NjcyQVx1NTNEN1x1NzQwNjogJHtzZW5kUi5zbGljZSgwLCA4MCl9YF07XG4gICAgICAvLyBmYWtlIGhvc3QgZWNobyBcdTU2REVcdTY3NjVcdTU0MEVcdTdFQ0YgUmVhY3QgXHU2RTMyXHU2N0QzKFx1NzUyOFx1NjIzN1x1NkQ4OFx1NjA2RiArIFx1NTJBOVx1NjI0QiBlY2hvIFx1NTNDQ1x1OERFRlx1NUY4NClcbiAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyMikgPT4gc2V0VGltZW91dChyMiwgM18wMDApKTtcbiAgICAgIGNvbnN0IHByb2JlID0gKGF3YWl0IGpzKGBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIHhzc0ZsYWc6IHR5cGVvZiB3aW5kb3cuX194c3MsXG4gICAgICAgIGltZ0NvdW50OiBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdpbWdbc3JjPVwieFwiXScpLmxlbmd0aCxcbiAgICAgICAgc2NyaXB0UmFuOiBkb2N1bWVudC5ib2R5LmlubmVyVGV4dC5pbmRleE9mKCd3aW5kb3cuX194c3M9MicpID49IDBcbiAgICAgIH0pYCkpIGFzIHN0cmluZztcbiAgICAgIGNvbnN0IHAgPSBKU09OLnBhcnNlKHByb2JlKSBhcyB7IHhzc0ZsYWc6IHN0cmluZzsgaW1nQ291bnQ6IG51bWJlcjsgc2NyaXB0UmFuOiBib29sZWFuIH07XG4gICAgICByZXR1cm4gW3AueHNzRmxhZyA9PT0gJ3VuZGVmaW5lZCcgJiYgcC5pbWdDb3VudCA9PT0gMCwgYHhzc0ZsYWc9JHtwLnhzc0ZsYWd9IGltZz0ke3AuaW1nQ291bnR9YF07XG4gICAgfSk7XG5cbiAgICBsZXQgZmFpbGVkID0gMDtcbiAgICBmb3IgKGNvbnN0IFtuYW1lLCBvaywgZGV0YWlsXSBvZiByZXN1bHRzKSB7XG4gICAgICBjb25zb2xlLmxvZyhgU0VDVVJJVFktVEVTVCAke29rID8gJ1BBU1MnIDogJ0ZBSUwnfSB8ICR7bmFtZX0gfCAke3JlZGFjdChkZXRhaWwpfWApO1xuICAgICAgaWYgKCFvaykgZmFpbGVkICs9IDE7XG4gICAgfVxuICAgIGNvbnNvbGUubG9nKGBTRUNVUklUWS1URVNUIFNVTU1BUlkgcGFzcz0ke3Jlc3VsdHMubGVuZ3RoIC0gZmFpbGVkfS8ke3Jlc3VsdHMubGVuZ3RofWApO1xuICAgIGFwcC5leGl0KGZhaWxlZCA9PT0gMCA/IDAgOiAxKTtcbiAgfVxuXG4gIC8vIFx1OTAwMFx1NTFGQTpcdTRGMThcdTk2QzVcdTUwNUNcdTZCNjJcdTgxRUFcdTVERjEgc3Bhd24gXHU3Njg0IGhvc3Qoc2h1dGRvd24gXHU3QUVGXHU3MEI5IFx1MjE5MiBcdTUxNUNcdTVFOTVcdTUzRUEga2lsbCBcdTgxRUFcdTVERjFcdTc2ODRcdTUzRTVcdTY3QzQpXG4gIGFwcC5vbignYmVmb3JlLXF1aXQnLCAoZSkgPT4ge1xuICAgIGlmIChzdXBlcnZpc29yICE9PSBudWxsICYmIHN1cGVydmlzb3Iuc3RhdGUgIT09ICdzdG9wcGVkJykge1xuICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgc3NlQWJvcnQ/LmFib3J0KCk7XG4gICAgICB2b2lkIHN1cGVydmlzb3Iuc3RvcCgpLmZpbmFsbHkoKCkgPT4gYXBwLnF1aXQoKSk7XG4gICAgfVxuICB9KTtcbiAgYXBwLm9uKCd3aW5kb3ctYWxsLWNsb3NlZCcsICgpID0+IHtcbiAgICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSAhPT0gJ2RhcndpbicpIGFwcC5xdWl0KCk7XG4gIH0pO1xufVxuIiwgIi8qKlxuICogRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yIFx1MjAxNCBobWhhcm5lc3MgaG9zdCBcdThGREJcdTdBMEJcdTc2ODRcdTc1MUZcdTU0N0RcdTU0NjhcdTY3MUZcdTcyQjZcdTYwMDFcdTY3M0EoQURSLTAwMylcdTMwMDJcbiAqXG4gKiBcdTVCODlcdTUxNjhcdTRFMERcdTUzRDhcdTkxQ0Y6XG4gKiAgLSBcdTUzRUFcdTdFRDFcdTVCOUEvXHU2M0EyXHU2RDRCIDEyNy4wLjAuMTtob3N0IFx1NEY3Rlx1NzUyOFx1NjRDRFx1NEY1Q1x1N0NGQlx1N0VERlx1NTIwNlx1OTE0RFx1N0FFRlx1NTNFMyhwb3J0IDApLFx1NUI5RVx1OTY0NVx1N0FFRlx1NTNFM1xuICogICAgXHU3NTMxIGhvc3QgXHU3Njg0IHN0ZG91dCBcdTVGMTVcdTVCRkNcdTg4NENcdTU2REVcdTRGMjAoSG9zdFJlYWR5TGluZSlcdTMwMDJcbiAqICAtIFx1OUFEOFx1NzFCNSB0b2tlbiBcdTUzRUFcdTkwMUFcdThGQzdcdTVCNTBcdThGREJcdTdBMEJcdTczQUZcdTU4ODNcdTUzRDhcdTkxQ0ZcdTRGMjBcdTkwMTIsXHU3RUREXHU0RTBEXHU4RkRCIFVSTC9cdTY1RTVcdTVGRDcvSVBDIFx1NjYwRVx1NjU4N1x1OEQxRlx1OEY3RFx1MzAwMlxuICogIC0gXHU1M0VBXHU1MDVDXHU2QjYyXHU2NzJDIHN1cGVydmlzb3Igc3Bhd24gXHU3Njg0XHU4RkRCXHU3QTBCXHU1M0U1XHU2N0M0O1x1N0VERFx1NEUwRFx1NjMwOVx1OEZEQlx1N0EwQlx1NTQwRCBraWxsXHUzMDAyXG4gKiAgLSBob3N0IGNyYXNoIFx1NTQwRVx1NjcwOVx1OTY1MFx1OTFDRFx1NTQyRjtcdTkxQ0RcdTU0MkZcdTRFMERcdTkxQ0RcdTY1M0VcdTRFRkJcdTRGNTVcdTc1MjhcdTYyMzdcdTUyQThcdTRGNUMoXHU5NzVFXHU1RTQyXHU3QjQ5XHU1MkE4XHU0RjVDXHU3NTMxXHU3NTI4XHU2MjM3XHU3ODZFXHU4QkE0KVx1MzAwMlxuICovXG5pbXBvcnQgeyBzcGF3biwgdHlwZSBDaGlsZFByb2Nlc3MgfSBmcm9tICdub2RlOmNoaWxkX3Byb2Nlc3MnO1xuaW1wb3J0IHsgY3JlYXRlSW50ZXJmYWNlIH0gZnJvbSAnbm9kZTpyZWFkbGluZSc7XG5pbXBvcnQgeyByYW5kb21CeXRlcyB9IGZyb20gJ25vZGU6Y3J5cHRvJztcbmltcG9ydCB7IGRlc2t0b3BFcnJvciwgaXNEZXNrdG9wRXJyb3IsIHR5cGUgRGVza3RvcEVycm9yIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyc7XG5cbmV4cG9ydCB0eXBlIEhvc3RTdGF0ZSA9XG4gIHwgJ3N0b3BwZWQnXG4gIHwgJ3N0YXJ0aW5nJ1xuICB8ICdyZWFkeSdcbiAgfCAnZGlzY29ubmVjdGVkJ1xuICB8ICdyZXN0YXJ0aW5nJ1xuICB8ICdzdG9wcGluZydcbiAgfCAnZmFpbGVkJztcblxuZXhwb3J0IGludGVyZmFjZSBIb3N0U3BlYyB7XG4gIC8qKiBcdTUzRUZcdTYyNjdcdTg4NENcdTY1ODdcdTRFRjYoXHU5MDFBXHU1RTM4IHByb2Nlc3MuZXhlY1BhdGgpXHUzMDAyICovXG4gIGNvbW1hbmQ6IHN0cmluZztcbiAgYXJnczogc3RyaW5nW107XG4gIGN3ZD86IHN0cmluZztcbiAgLyoqIFx1OTg5RFx1NTkxNlx1NzNBRlx1NTg4M1x1NTNEOFx1OTFDRihcdTRGMUFcdTRFMEUgcHJvY2Vzcy5lbnYgXHU1NDA4XHU1RTc2KVx1MzAwMiAqL1xuICBlbnY/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFN1cGVydmlzb3JPcHRpb25zIHtcbiAgLyoqIFx1NjcxRlx1NjcxQiBob3N0IFx1NjgyMVx1OUE4Q1x1NzY4NCBiZWFyZXIgdG9rZW47XHU0RTBEXHU0RjIwXHU1MjE5XHU2QkNGXHU2QjIxIHN0YXJ0IFx1NzUxRlx1NjIxMFx1OUFEOFx1NzFCNVx1OTY4Rlx1NjczQVx1NTAzQ1x1MzAwMiAqL1xuICB0b2tlbj86IHN0cmluZztcbiAgbWF4UmVzdGFydHM/OiBudW1iZXI7XG4gIHN0YXJ0VGltZW91dE1zPzogbnVtYmVyO1xuICBncmFjZWZ1bFNodXRkb3duTXM/OiBudW1iZXI7XG4gIG9uU3RhdGVDaGFuZ2U/KHN0YXRlOiBIb3N0U3RhdGUsIGluZm86IHsgcmVzdGFydENvdW50OiBudW1iZXI7IGxhc3RFcnJvcj86IHN0cmluZyB9KTogdm9pZDtcbiAgLyoqIFx1NkJDRlx1NkIyMSBob3N0IFx1NUMzMVx1N0VFQShcdTU0MkIgY3Jhc2ggXHU4MUVBXHU2MTA4XHU1NDBFXHU3Njg0XHU5MUNEXHU1NDJGKVx1OTBGRFx1NEYxQVx1ODlFNlx1NTNEMSxcdTY0M0FcdTVFMjZcdTdBRUZcdTcwQjkoXHU1NDJCIHRva2VuLFxuICAgKiAgXHU0RUM1XHU0RjlCXHU1NDBDXHU0RkUxXHU0RUZCXHU1N0RGXHU3Njg0XHU1QkJGXHU0RTNCXHU4RkRCXHU3QTBCXHU5MUNEXHU1RUZBXHU2ODY1XHU1QkEyXHU2MjM3XHU3QUVGO1x1NEUwRFx1ODk4MVx1OERFOFx1OEZEQiByZW5kZXJlcilcdTMwMDIgKi9cbiAgb25SZWFkeT8oZW5kcG9pbnQ6IEhvc3RFbmRwb2ludCk6IHZvaWQ7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgSG9zdEVuZHBvaW50IHtcbiAgcG9ydDogbnVtYmVyO1xuICB2ZXJzaW9uOiBzdHJpbmc7XG4gIHRva2VuOiBzdHJpbmc7XG59XG5cbi8qKiBIb3N0UmVhZHlMaW5lIFx1NzY4NFx1N0M3Qlx1NTc4Qlx1NUI4OFx1NTM2Qlx1NEVDRSBjb250cmFjdHMgXHU1RjE1XHU1MTY1LFx1OTA3Rlx1NTE0RFx1NTNDQ1x1NUI5RVx1NzNCMFx1MzAwMiAqL1xuaW1wb3J0IHsgaXNIb3N0UmVhZHlMaW5lIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyc7XG5cbi8vIDQ1czpobWhhcm5lc3MgXHU3NzFGXHU1QjlFXHU1MTY1XHU1M0UzXHU3RUNGIHRzeCBcdTUxQjdcdTdGMTZcdThCRDFcdTY1NzRcdTU5NTcgQ0xJLFx1NjczQVx1NTY2OFx1OUFEOFx1OEQxRlx1OEY3RFx1NjVGNlx1NTNFRlx1OEQ4NSAyMHNcbi8vICgyMDI2LTEwLTExIFx1OEZERVx1N0VFRFx1OUE4Q1x1NjUzNlx1NEUyRFx1OTVGNFx1NkI0N1x1NjAyNyBIT1NUX05PVF9SRUFEWSBcdTc2ODRcdTY4MzlcdTU2RTA7XHU3QTdBXHU5NUYyXHU1QjlFXHU2RDRCIDZzKVx1MzAwMlxuY29uc3QgREVGQVVMVF9TVEFSVF9USU1FT1VUX01TID0gNDVfMDAwO1xuY29uc3QgREVGQVVMVF9NQVhfUkVTVEFSVFMgPSAzO1xuY29uc3QgREVGQVVMVF9HUkFDRUZVTF9NUyA9IDVfMDAwO1xuXG5leHBvcnQgY2xhc3MgRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yIHtcbiAgcHJpdmF0ZSBjaGlsZDogQ2hpbGRQcm9jZXNzIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgX3N0YXRlOiBIb3N0U3RhdGUgPSAnc3RvcHBlZCc7XG4gIHByaXZhdGUgcmVzdGFydENvdW50ID0gMDtcbiAgcHJpdmF0ZSBsYXN0RXJyb3IgPSAnJztcbiAgcHJpdmF0ZSBzdG9wcGluZyA9IGZhbHNlO1xuICBwcml2YXRlIHJlYWRvbmx5IHRva2VuOiBzdHJpbmc7XG4gIHByaXZhdGUgcmVhZG9ubHkgb3B0czogUmVxdWlyZWQ8UGljazxTdXBlcnZpc29yT3B0aW9ucywgJ21heFJlc3RhcnRzJyB8ICdzdGFydFRpbWVvdXRNcycgfCAnZ3JhY2VmdWxTaHV0ZG93bk1zJz4+ICYgU3VwZXJ2aXNvck9wdGlvbnM7XG4gIHByaXZhdGUgZXhpdFdhaXRlcnM6IEFycmF5PCgpID0+IHZvaWQ+ID0gW107XG5cbiAgY29uc3RydWN0b3IoXG4gICAgcHJpdmF0ZSByZWFkb25seSBzcGVjOiBIb3N0U3BlYyxcbiAgICBvcHRzOiBTdXBlcnZpc29yT3B0aW9ucyA9IHt9LFxuICApIHtcbiAgICB0aGlzLnRva2VuID0gb3B0cy50b2tlbiA/PyByYW5kb21CeXRlcygzMikudG9TdHJpbmcoJ2Jhc2U2NHVybCcpO1xuICAgIHRoaXMub3B0cyA9IHtcbiAgICAgIG1heFJlc3RhcnRzOiBvcHRzLm1heFJlc3RhcnRzID8/IERFRkFVTFRfTUFYX1JFU1RBUlRTLFxuICAgICAgc3RhcnRUaW1lb3V0TXM6IG9wdHMuc3RhcnRUaW1lb3V0TXMgPz8gREVGQVVMVF9TVEFSVF9USU1FT1VUX01TLFxuICAgICAgZ3JhY2VmdWxTaHV0ZG93bk1zOiBvcHRzLmdyYWNlZnVsU2h1dGRvd25NcyA/PyBERUZBVUxUX0dSQUNFRlVMX01TLFxuICAgICAgLi4ub3B0cyxcbiAgICB9O1xuICB9XG5cbiAgZ2V0IHN0YXRlKCk6IEhvc3RTdGF0ZSB7XG4gICAgcmV0dXJuIHRoaXMuX3N0YXRlO1xuICB9XG5cbiAgZ2V0IHJlc3RhcnRzVXNlZCgpOiBudW1iZXIge1xuICAgIHJldHVybiB0aGlzLnJlc3RhcnRDb3VudDtcbiAgfVxuXG4gIHByaXZhdGUgc2V0U3RhdGUoczogSG9zdFN0YXRlLCBlcnI/OiBzdHJpbmcpOiB2b2lkIHtcbiAgICB0aGlzLl9zdGF0ZSA9IHM7XG4gICAgaWYgKGVyciAhPT0gdW5kZWZpbmVkKSB0aGlzLmxhc3RFcnJvciA9IGVycjtcbiAgICBjb25zdCBpbmZvOiB7IHJlc3RhcnRDb3VudDogbnVtYmVyOyBsYXN0RXJyb3I/OiBzdHJpbmcgfSA9IHsgcmVzdGFydENvdW50OiB0aGlzLnJlc3RhcnRDb3VudCB9O1xuICAgIGlmICh0aGlzLmxhc3RFcnJvciAhPT0gJycpIGluZm8ubGFzdEVycm9yID0gdGhpcy5sYXN0RXJyb3I7XG4gICAgdGhpcy5vcHRzLm9uU3RhdGVDaGFuZ2U/LihzLCBpbmZvKTtcbiAgfVxuXG4gIC8qKiBcdTU0MkZcdTUyQTggaG9zdCBcdTVFNzZcdTdCNDlcdTVGODUgcmVhZHkoXHU1RjE1XHU1QkZDXHU4ODRDICsgXHU1RTI2IHRva2VuIFx1NzY4NFx1NTA2NVx1NUVCN1x1NjNBMlx1NkQ0QilcdTMwMDIgKi9cbiAgYXN5bmMgc3RhcnQoKTogUHJvbWlzZTxIb3N0RW5kcG9pbnQ+IHtcbiAgICBpZiAodGhpcy5fc3RhdGUgPT09ICdyZWFkeScgfHwgdGhpcy5fc3RhdGUgPT09ICdzdGFydGluZycpIHtcbiAgICAgIHRocm93IGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgc3VwZXJ2aXNvciBhbHJlYWR5ICR7dGhpcy5fc3RhdGV9YCk7XG4gICAgfVxuICAgIHRoaXMucmVzdGFydENvdW50ID0gMDtcbiAgICB0aGlzLnN0b3BwaW5nID0gZmFsc2U7XG4gICAgcmV0dXJuIHRoaXMubGF1bmNoKCk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGxhdW5jaCgpOiBQcm9taXNlPEhvc3RFbmRwb2ludD4ge1xuICAgIHRoaXMuc2V0U3RhdGUoJ3N0YXJ0aW5nJyk7XG4gICAgY29uc3QgY2hpbGQgPSBzcGF3bih0aGlzLnNwZWMuY29tbWFuZCwgdGhpcy5zcGVjLmFyZ3MsIHtcbiAgICAgIGN3ZDogdGhpcy5zcGVjLmN3ZCxcbiAgICAgIGVudjoge1xuICAgICAgICAuLi5wcm9jZXNzLmVudixcbiAgICAgICAgLi4udGhpcy5zcGVjLmVudixcbiAgICAgICAgSE1IX0RFU0tUT1BfVE9LRU46IHRoaXMudG9rZW4sXG4gICAgICB9LFxuICAgICAgc3RkaW86IFsnaWdub3JlJywgJ3BpcGUnLCAncGlwZSddLFxuICAgICAgd2luZG93c0hpZGU6IHRydWUsXG4gICAgfSk7XG4gICAgdGhpcy5jaGlsZCA9IGNoaWxkO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGVuZHBvaW50ID0gYXdhaXQgdGhpcy5hd2FpdFJlYWR5KGNoaWxkKTtcbiAgICAgIHRoaXMuY3VycmVudEVuZHBvaW50ID0geyBwb3J0OiBlbmRwb2ludC5wb3J0LCB2ZXJzaW9uOiBlbmRwb2ludC52ZXJzaW9uIH07XG4gICAgICB0aGlzLnNldFN0YXRlKCdyZWFkeScpO1xuICAgICAgdGhpcy5vcHRzLm9uUmVhZHk/LihlbmRwb2ludCk7XG4gICAgICAvLyByZWFkeSBcdTRFNEJcdTU0MEVcdThGREJcdTdBMEJcdTZCN0JcdTRFQTEgPSBcdTYxMEZcdTU5MTZcdTkwMDBcdTUxRkEgXHUyMTkyIFx1NjcwOVx1OTY1MFx1OTFDRFx1NTQyRlxuICAgICAgY2hpbGQub25jZSgnZXhpdCcsICgpID0+IHtcbiAgICAgICAgdGhpcy5leGl0V2FpdGVycy5mb3JFYWNoKCh3KSA9PiB3KCkpO1xuICAgICAgICB0aGlzLmV4aXRXYWl0ZXJzID0gW107XG4gICAgICAgIHRoaXMub25VbmV4cGVjdGVkRXhpdCgpO1xuICAgICAgfSk7XG4gICAgICByZXR1cm4gZW5kcG9pbnQ7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBpZiAoIWNoaWxkLmtpbGxlZCkgY2hpbGQua2lsbCgpO1xuICAgICAgaWYgKHRoaXMuY2hpbGQgPT09IGNoaWxkKSB0aGlzLmNoaWxkID0gbnVsbDtcbiAgICAgIHRocm93IGVycjtcbiAgICB9XG4gIH1cblxuICAvKiogXHU0RUNFIHN0ZG91dCBcdTYyN0UgSG9zdFJlYWR5TGluZSxcdTcxMzZcdTU0MEVcdTUwNjVcdTVFQjdcdTYzQTJcdTZENEJcdTMwMDIgKi9cbiAgcHJpdmF0ZSBhd2FpdFJlYWR5KGNoaWxkOiBDaGlsZFByb2Nlc3MpOiBQcm9taXNlPEhvc3RFbmRwb2ludD4ge1xuICAgIHJldHVybiBuZXcgUHJvbWlzZTxIb3N0RW5kcG9pbnQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgIHJlamVjdChkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYGhvc3QgZGlkIG5vdCBzaWduYWwgcmVhZHkgd2l0aGluICR7dGhpcy5vcHRzLnN0YXJ0VGltZW91dE1zfW1zYCwgeyByZXRyeWFibGU6IHRydWUsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XG4gICAgICB9LCB0aGlzLm9wdHMuc3RhcnRUaW1lb3V0TXMpO1xuXG4gICAgICBjb25zdCBkb25lID0gKGZuOiAoKSA9PiB2b2lkKTogdm9pZCA9PiB7XG4gICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgIGZuKCk7XG4gICAgICB9O1xuXG4gICAgICBpZiAoIWNoaWxkLnN0ZG91dCkge1xuICAgICAgICBkb25lKCgpID0+IHJlamVjdChkZXNrdG9wRXJyb3IoJ1JVTlRJTUVfQ1JBU0hFRCcsICdob3N0IHNwYXduZWQgd2l0aG91dCBzdGRvdXQgcGlwZScpKSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgY29uc3QgcmwgPSBjcmVhdGVJbnRlcmZhY2UoeyBpbnB1dDogY2hpbGQuc3Rkb3V0IH0pO1xuICAgICAgY29uc3Qgb25MaW5lID0gKGxpbmU6IHN0cmluZyk6IHZvaWQgPT4ge1xuICAgICAgICBsZXQgcGFyc2VkOiB1bmtub3duO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHBhcnNlZCA9IEpTT04ucGFyc2UobGluZSk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIHJldHVybjsgLy8gaG9zdCBcdTc2ODRcdTY2NkVcdTkwMUFcdTY1RTVcdTVGRDdcdTg4NEMsXHU1RkZEXHU3NTY1XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGlzSG9zdFJlYWR5TGluZShwYXJzZWQpKSB7XG4gICAgICAgICAgcmwuY2xvc2UoKTtcbiAgICAgICAgICB2b2lkIHRoaXMucHJvYmVBbmRSZW1lbWJlcihwYXJzZWQucG9ydCwgcGFyc2VkLnZlcnNpb24pXG4gICAgICAgICAgICAudGhlbigoZW5kcG9pbnQpID0+IGRvbmUoKCkgPT4gcmVzb2x2ZShlbmRwb2ludCkpKVxuICAgICAgICAgICAgLmNhdGNoKChlcnI6IHVua25vd24pID0+IGRvbmUoKCkgPT4gcmVqZWN0KGVycikpKTtcbiAgICAgICAgfVxuICAgICAgfTtcbiAgICAgIHJsLm9uKCdsaW5lJywgb25MaW5lKTtcblxuICAgICAgY2hpbGQub25jZSgnZXhpdCcsIChjb2RlKSA9PiB7XG4gICAgICAgIGRvbmUoKCkgPT4gcmVqZWN0KGRlc2t0b3BFcnJvcignUlVOVElNRV9DUkFTSEVEJywgYGhvc3QgZXhpdGVkIGR1cmluZyBzdGFydHVwIChjb2RlICR7Y29kZSA/PyAnbnVsbCd9KWAsIHsgcmV0cnlhYmxlOiBmYWxzZSwgcmVjb3ZlcnlBY3Rpb246ICdPUEVOX0xPR1MnIH0pKSk7XG4gICAgICB9KTtcbiAgICB9KTtcbiAgfVxuXG4gIC8qKiBcdTVFMjYgdG9rZW4gXHU3Njg0XHU1MDY1XHU1RUI3XHU2M0EyXHU2RDRCOkdFVCAvYXBpL3N0YXRlXHUzMDAyNDAxIFx1MjE5MiBBVVRIX0ZBSUxFRChcdTRFMERcdTkxQ0RcdThCRDUpXHUzMDAyICovXG4gIHByaXZhdGUgYXN5bmMgcHJvYmUocG9ydDogbnVtYmVyLCB2ZXJzaW9uOiBzdHJpbmcpOiBQcm9taXNlPEhvc3RFbmRwb2ludD4ge1xuICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgIHRyeSB7XG4gICAgICByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2FwaS9zdGF0ZWAsIHtcbiAgICAgICAgaGVhZGVyczogeyAneC1obWgta2V5JzogdGhpcy50b2tlbiB9LFxuICAgICAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoM18wMDApLFxuICAgICAgfSk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICB0aHJvdyBkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYGhlYWx0aCBwcm9iZSBmYWlsZWQ6ICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTYwKX1gLCB7IHJldHJ5YWJsZTogdHJ1ZSB9KTtcbiAgICB9XG4gICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSB8fCByZXMuc3RhdHVzID09PSA0MDMpIHtcbiAgICAgIHRocm93IGRlc2t0b3BFcnJvcignQVVUSF9GQUlMRUQnLCBgaG9zdCByZWplY3RlZCB0aGUgc2Vzc2lvbiB0b2tlbiAoSFRUUCAke3Jlcy5zdGF0dXN9KWAsIHsgcmV0cnlhYmxlOiBmYWxzZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pO1xuICAgIH1cbiAgICBpZiAoIXJlcy5vaykge1xuICAgICAgdGhyb3cgZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBoZWFsdGggcHJvYmUgSFRUUCAke3Jlcy5zdGF0dXN9YCwgeyByZXRyeWFibGU6IHRydWUgfSk7XG4gICAgfVxuICAgIHJldHVybiB7IHBvcnQsIHZlcnNpb24sIHRva2VuOiB0aGlzLnRva2VuIH07XG4gIH1cblxuICBwcml2YXRlIG9uVW5leHBlY3RlZEV4aXQoKTogdm9pZCB7XG4gICAgaWYgKHRoaXMuc3RvcHBpbmcgfHwgdGhpcy5fc3RhdGUgPT09ICdzdG9wcGVkJyB8fCB0aGlzLl9zdGF0ZSA9PT0gJ3N0b3BwaW5nJykgcmV0dXJuO1xuICAgIHRoaXMuY2hpbGQgPSBudWxsO1xuICAgIGlmICh0aGlzLnJlc3RhcnRDb3VudCA8IHRoaXMub3B0cy5tYXhSZXN0YXJ0cykge1xuICAgICAgdGhpcy5yZXN0YXJ0Q291bnQgKz0gMTtcbiAgICAgIHRoaXMuc2V0U3RhdGUoJ3Jlc3RhcnRpbmcnKTtcbiAgICAgIHZvaWQgdGhpcy5sYXVuY2goKS5jYXRjaCgoKSA9PiB7XG4gICAgICAgIC8vIFx1OTFDRFx1NTQyRlx1NUMxRFx1OEJENVx1NTkzMVx1OEQyNShcdTU0MkZcdTUyQThcdTUzNzNcdTVEMjkvXHU4RDg1XHU2NUY2L1x1NjJEMlx1OEJBNCk6XHU3RUU3XHU3RUVEXHU2RDg4XHU4MDE3XHU5MUNEXHU1NDJGXHU2QjIxXHU2NTcwXHU3NkY0XHU1MjMwXHU2NTNFXHU1RjAzXG4gICAgICAgIHRoaXMucmV0cnlPckZhaWwoKTtcbiAgICAgIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLnNldFN0YXRlKCdmYWlsZWQnLCBgaG9zdCBleGl0ZWQgdW5leHBlY3RlZGx5ICR7dGhpcy5yZXN0YXJ0Q291bnQgKyAxfSB0aW1lczsgZ2l2aW5nIHVwYCk7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSByZXRyeU9yRmFpbCgpOiB2b2lkIHtcbiAgICBpZiAodGhpcy5zdG9wcGluZyB8fCB0aGlzLl9zdGF0ZSA9PT0gJ3N0b3BwZWQnIHx8IHRoaXMuX3N0YXRlID09PSAnc3RvcHBpbmcnKSByZXR1cm47XG4gICAgaWYgKHRoaXMucmVzdGFydENvdW50IDwgdGhpcy5vcHRzLm1heFJlc3RhcnRzKSB7XG4gICAgICB0aGlzLnJlc3RhcnRDb3VudCArPSAxO1xuICAgICAgdGhpcy5zZXRTdGF0ZSgncmVzdGFydGluZycpO1xuICAgICAgdm9pZCB0aGlzLmxhdW5jaCgpLmNhdGNoKCgpID0+IHRoaXMucmV0cnlPckZhaWwoKSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMuc2V0U3RhdGUoJ2ZhaWxlZCcsIGBob3N0IGZhaWxlZCB0byBzdGF5IHVwIGFmdGVyICR7dGhpcy5yZXN0YXJ0Q291bnR9IHJlc3RhcnQgYXR0ZW1wdHNgKTtcbiAgICB9XG4gIH1cblxuICAvKiogXHU0RjE4XHU5NkM1XHU1MDVDXHU2QjYyOlx1NTE0OCBIVFRQIHNodXRkb3duLFx1OEQ4NVx1NjVGNlx1NjI0RFx1NUJGOVx1NjcyQ1x1OEZEQlx1N0EwQlx1NTNFNVx1NjdDNCBraWxsXHUzMDAyICovXG4gIGFzeW5jIHN0b3AoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgdGhpcy5zdG9wcGluZyA9IHRydWU7XG4gICAgaWYgKHRoaXMuX3N0YXRlID09PSAnc3RvcHBlZCcpIHJldHVybjtcbiAgICB0aGlzLnNldFN0YXRlKCdzdG9wcGluZycpO1xuICAgIGNvbnN0IGNoaWxkID0gdGhpcy5jaGlsZDtcbiAgICB0aGlzLmNoaWxkID0gbnVsbDtcbiAgICB0aGlzLmN1cnJlbnRFbmRwb2ludCA9IG51bGw7XG4gICAgaWYgKCFjaGlsZCkge1xuICAgICAgdGhpcy5zZXRTdGF0ZSgnc3RvcHBlZCcpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBleGl0ZWQgPSBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4ge1xuICAgICAgaWYgKGNoaWxkLmV4aXRDb2RlICE9PSBudWxsIHx8IGNoaWxkLnNpZ25hbENvZGUgIT09IG51bGwpIHJlc29sdmUoKTtcbiAgICAgIGVsc2Uge1xuICAgICAgICBjb25zdCB3ID0gKCk6IHZvaWQgPT4gcmVzb2x2ZSgpO1xuICAgICAgICB0aGlzLmV4aXRXYWl0ZXJzLnB1c2godyk7XG4gICAgICAgIGNoaWxkLm9uY2UoJ2V4aXQnLCB3KTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICAvLyBcdTVERjJcdTc3RTVcdTdBRUZcdTUzRTNcdTYyNERcdTVDMURcdThCRDUgSFRUUCBcdTRGMThcdTk2QzVcdTUxNzNcdTk1RUQ7XHU2NzJBXHU3N0U1XHU3QUVGXHU1M0UzXHU3NkY0XHU2M0E1XHU4RDcwIGtpbGwgXHU1MTVDXHU1RTk1XG4gICAgaWYgKHRoaXMubGFzdEVuZHBvaW50ICE9PSBudWxsKSB7XG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3RoaXMubGFzdEVuZHBvaW50fS9hcGkvZGVza3RvcC9zaHV0ZG93bmAsIHtcbiAgICAgICAgICBtZXRob2Q6ICdQT1NUJyxcbiAgICAgICAgICBoZWFkZXJzOiB7ICd4LWhtaC1rZXknOiB0aGlzLnRva2VuIH0sXG4gICAgICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDFfMDAwKSxcbiAgICAgICAgfSk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLy8gaG9zdCBcdTVERjJcdTZCN0JcdTYyMTZcdTRFMERcdTVFOTRcdTdCNTQ6XHU4RDcwIGtpbGwgXHU1MTVDXHU1RTk1XG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IGdyYWNlZnVsID0gYXdhaXQgUHJvbWlzZS5yYWNlKFtcbiAgICAgIGV4aXRlZC50aGVuKCgpID0+IHRydWUpLFxuICAgICAgbmV3IFByb21pc2U8Ym9vbGVhbj4oKHJlc29sdmUpID0+IHNldFRpbWVvdXQoKCkgPT4gcmVzb2x2ZShmYWxzZSksIHRoaXMub3B0cy5ncmFjZWZ1bFNodXRkb3duTXMpKSxcbiAgICBdKTtcbiAgICBpZiAoIWdyYWNlZnVsICYmIGNoaWxkLmV4aXRDb2RlID09PSBudWxsICYmIGNoaWxkLnNpZ25hbENvZGUgPT09IG51bGwpIHtcbiAgICAgIGNoaWxkLmtpbGwoKTsgLy8gXHU1M0VBXHU2NzQwXHU4MUVBXHU1REYxXHU2MzAxXHU2NzA5XHU3Njg0XHU1M0U1XHU2N0M0LFx1N0VERFx1NEUwRFx1NjMwOVx1OEZEQlx1N0EwQlx1NTQwRFxuICAgIH1cbiAgICBhd2FpdCBleGl0ZWQuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcbiAgICB0aGlzLnNldFN0YXRlKCdzdG9wcGVkJyk7XG4gIH1cblxuICBwcml2YXRlIGxhc3RFbmRwb2ludDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgY3VycmVudEVuZHBvaW50OiB7IHBvcnQ6IG51bWJlcjsgdmVyc2lvbjogc3RyaW5nIH0gfCBudWxsID0gbnVsbDtcblxuICAvKiogXHU1RjUzXHU1MjREIGhvc3QgXHU3QUVGXHU3MEI5KHJlYWR5IFx1NTQwRVx1NjcwOVx1NTAzQztcdTRFMERcdTU0MkIgdG9rZW4pXHUzMDAyICovXG4gIGdldCBlbmRwb2ludCgpOiB7IHBvcnQ6IG51bWJlcjsgdmVyc2lvbjogc3RyaW5nIH0gfCBudWxsIHtcbiAgICByZXR1cm4gdGhpcy5jdXJyZW50RW5kcG9pbnQ7XG4gIH1cblxuICAvKiogXHU2M0EyXHU2RDRCXHU2MjEwXHU1MjlGXHU1NDBFXHU4QkIwXHU0RjRGXHU3QUVGXHU1M0UzLFx1NEY5QiBzdG9wKCkgXHU3Njg0XHU0RjE4XHU5NkM1XHU1MTczXHU5NUVEXHU0RjdGXHU3NTI4XHUzMDAyICovXG4gIHByaXZhdGUgYXN5bmMgcHJvYmVBbmRSZW1lbWJlcihwb3J0OiBudW1iZXIsIHZlcnNpb246IHN0cmluZyk6IFByb21pc2U8SG9zdEVuZHBvaW50PiB7XG4gICAgY29uc3QgZXAgPSBhd2FpdCB0aGlzLnByb2JlKHBvcnQsIHZlcnNpb24pO1xuICAgIHRoaXMubGFzdEVuZHBvaW50ID0gZXAucG9ydDtcbiAgICByZXR1cm4gZXA7XG4gIH1cbn1cblxuLyoqIFx1NjI4QVx1NjcyQVx1NzdFNVx1OTUxOVx1OEJFRlx1ODlDNFx1N0VBNlx1NEUzQSBEZXNrdG9wRXJyb3IoXHU1REYyXHU2NjJGXHU1MjE5XHU1MzlGXHU2ODM3XHU4RkQ0XHU1NkRFKVx1MzAwMiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRvRGVza3RvcEVycm9yKGVycjogdW5rbm93bik6IERlc2t0b3BFcnJvciB7XG4gIGlmIChpc0Rlc2t0b3BFcnJvcihlcnIpKSByZXR1cm4gZXJyO1xuICBjb25zdCBtZXNzYWdlID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICByZXR1cm4gZGVza3RvcEVycm9yKCdSVU5USU1FX0NSQVNIRUQnLCBtZXNzYWdlLnNsaWNlKDAsIDMwMCksIHsgcmV0cnlhYmxlOiBmYWxzZSB9KTtcbn1cbiIsICIvKipcbiAqIEBobWgtZGVza3RvcC9jb250cmFjdHMgXHUyMDE0IFx1NEU4Qlx1NEVGNlx1NEZFMVx1NUMwMShcdTVGMDBcdTUzRDFcdThCQTFcdTUyMTJcdTY1ODdcdTY4NjMgMDQgXHUwMEE3XHU0RTA5KVxuICpcbiAqIFx1NEUwMFx1Njc2MSBVSSBcdTRFOEJcdTRFRjZcdTc2ODRcdTU1MkZcdTRFMDBcdTVGNjJcdTcyQjZcdTMwMDJcdTUyNERcdTdBRUYgcmVkdWNlciBcdTVGQzVcdTk4N0JcdTYzMDkgc2Vzc2lvbklkL3J1bklkL3NlcSBcdTU5MDRcdTc0MDY7XG4gKiBcdTkxQ0RcdTU5MEQgZXZlbnRJZCBcdTVFNDJcdTdCNDlcdTRFMjJcdTVGMDM7c2VxIFx1N0YzQVx1NTNFM1x1ODlFNlx1NTNEMVx1ODg2NVx1NjJDOTtcdTk3NUVcdTVFNDJcdTdCNDlcdTUyQThcdTRGNUNcdTRFMERcdTc1MzEgU1NFIFx1ODFFQVx1NTJBOFx1OTFDRFx1NTNEMVx1MzAwMlxuICovXG5cbmltcG9ydCB0eXBlIHsgQXJ0aWZhY3RSZWYgfSBmcm9tICcuL2R0by50cyc7XG5pbXBvcnQgdHlwZSB7IERlc2t0b3BFcnJvciB9IGZyb20gJy4vZXJyb3IudHMnO1xuXG4vKiogXHU0RThCXHU0RUY2XHU3OUNEXHU3QzdCKFx1NTIyNFx1NTIyQlx1OTUyRSlcdTMwMDJcdTY1QjBcdTU4OUUga2luZCA9IHNjaGVtYVZlcnNpb24gXHU1MzQ3XHU3RUE3LFx1NEUwRFx1NTE0MVx1OEJCOFx1OTc1OVx1OUVEOFx1NjI2OVx1Njc5QVx1NEUzRVx1MzAwMiAqL1xuZXhwb3J0IGNvbnN0IEVWRU5UX0tJTkRTID0gW1xuICAncnVuLnN0YXJ0ZWQnLFxuICAncGxhbi51cGRhdGVkJyxcbiAgJ3Rvb2wuc3RhcnRlZCcsXG4gICd0b29sLmNvbXBsZXRlZCcsXG4gICdhcHByb3ZhbC5yZXF1aXJlZCcsXG4gICd2ZXJpZmljYXRpb24udXBkYXRlZCcsXG4gICdhcnRpZmFjdC5jcmVhdGVkJyxcbiAgJ3J1bi5jb21wbGV0ZWQnLFxuICAncnVuLmZhaWxlZCcsXG5dIGFzIGNvbnN0O1xuXG5leHBvcnQgdHlwZSBFdmVudEtpbmQgPSAodHlwZW9mIEVWRU5UX0tJTkRTKVtudW1iZXJdO1xuXG5leHBvcnQgY29uc3QgRVZFTlRfU0NIRU1BX1ZFUlNJT04gPSAxO1xuZXhwb3J0IHR5cGUgRXZlbnRTY2hlbWFWZXJzaW9uID0gMTtcblxuLyoqIFNTRSBcdTZENDFcdTRFMEFcdTc2ODRcdTZCQ0ZcdTRFMDBcdTY3NjFcdTRFOEJcdTRFRjZcdTMwMDIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgRXZlbnRFbnZlbG9wZTxUID0gdW5rbm93bj4ge1xuICBzY2hlbWFWZXJzaW9uOiBFdmVudFNjaGVtYVZlcnNpb247XG4gIC8qKiBcdTUxNjhcdTVDNDBcdTU1MkZcdTRFMDA7XHU5MUNEXHU4RkRFL1x1ODg2NVx1NjJDOVx1NTQwRVx1OTFDRFx1NTkwRFx1NTFGQVx1NzNCMFx1NjVGNlx1NjNBNVx1NjUzNlx1NjVCOVx1NUU0Mlx1N0I0OVx1NEUyMlx1NUYwM1x1MzAwMiAqL1xuICBldmVudElkOiBzdHJpbmc7XG4gIHNlc3Npb25JZDogc3RyaW5nO1xuICBydW5JZDogc3RyaW5nO1xuICAvKiogXHU0RjFBXHU4QkREXHU1MTg1XHU1MzU1XHU4QzAzXHU5MDEyXHU1ODlFO1x1N0YzQVx1NTNFM1x1NjEwRlx1NTQ3M1x1Nzc0MFx1NEUyMlx1NEU4Qlx1NEVGNixcdTk3MDBcdTg5ODFcdTg4NjVcdTYyQzlcdTMwMDIgKi9cbiAgc2VxOiBudW1iZXI7XG4gIC8qKiBSRkMzMzM5XHUzMDAyICovXG4gIG9jY3VycmVkQXQ6IHN0cmluZztcbiAga2luZDogRXZlbnRLaW5kO1xuICBwYXlsb2FkOiBUO1xufVxuXG4vKiogcnVuLnN0YXJ0ZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgUnVuU3RhcnRlZFBheWxvYWQge1xuICB0YXNrOiBzdHJpbmc7XG4gIG1vZGU6ICdhc2snIHwgJ2F1dG8nIHwgJ3lvbG8nO1xufVxuXG4vKiogcGxhbi51cGRhdGVkIFx1NzY4NCBwYXlsb2FkKFx1OEJBMVx1NTIxMlx1NkI2NVx1OUFBNFx1NTIxN1x1ODg2OCxcdTY3NjVcdTgxRUEgcnVudGltZSBcdTc2ODRcdTdFRDNcdTY3ODRcdTUzMTZcdThCQTFcdTUyMTIsXHU0RTBEXHU2NjJGIGNoYWluLW9mLXRob3VnaHQpXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIFBsYW5VcGRhdGVkUGF5bG9hZCB7XG4gIHN0ZXBzOiBBcnJheTx7IHRpdGxlOiBzdHJpbmc7IHN0YXR1czogJ3BlbmRpbmcnIHwgJ2FjdGl2ZScgfCAnZG9uZScgfCAnZmFpbGVkJyB9Pjtcbn1cblxuLyoqIHRvb2wuc3RhcnRlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBUb29sU3RhcnRlZFBheWxvYWQge1xuICBuYW1lOiBzdHJpbmc7XG4gIC8qKiBcdTUzQzJcdTY1NzBcdTRFRTVcdTY1ODdcdTY3MkNcdTU0NDhcdTczQjAsXHU2RTMyXHU2N0QzXHU3QUVGXHU2QzM4XHU0RTBEIGV2YWw7XHU1OTI3XHU1QkY5XHU4QzYxXHU3NTMxIHJ1bnRpbWUgXHU2MjJBXHU2NUFEXHUzMDAyICovXG4gIGFyZ3NQcmV2aWV3OiBzdHJpbmc7XG59XG5cbi8qKiB0b29sLmNvbXBsZXRlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBUb29sQ29tcGxldGVkUGF5bG9hZCB7XG4gIG5hbWU6IHN0cmluZztcbiAgaXNFcnJvcjogYm9vbGVhbjtcbiAgb3V0cHV0UHJldmlldzogc3RyaW5nO1xufVxuXG4vKiogYXBwcm92YWwucmVxdWlyZWQgXHU3Njg0IHBheWxvYWRcdTMwMDJcdTVCQTFcdTYyNzlcdTY3NDNcdTVBMDFcdTU3MjggcnVudGltZSBcdTU0MEVcdTdBRUY7VUkgXHU1M0VBXHU2NjJGXHU4RjZDXHU4RkYwXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcHJvdmFsUmVxdWlyZWRQYXlsb2FkIHtcbiAgYXBwcm92YWxJZDogc3RyaW5nO1xuICB0b29sOiBzdHJpbmc7XG4gIGFyZ3NQcmV2aWV3OiBzdHJpbmc7XG4gIC8qKiBcdTVGNzFcdTU0Q0RcdTgzMDNcdTU2RjQvXHU5OENFXHU5NjY5XHU3Njg0XHU0RUJBXHU3QzdCXHU1M0VGXHU4QkZCXHU4QkY0XHU2NjBFLFx1NzUzMSBydW50aW1lIFx1NzUxRlx1NjIxMFx1MzAwMiAqL1xuICByaXNrOiBzdHJpbmc7XG59XG5cbi8qKiB2ZXJpZmljYXRpb24udXBkYXRlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBWZXJpZmljYXRpb25VcGRhdGVkUGF5bG9hZCB7XG4gIHN1bW1hcnk6IHN0cmluZztcbiAgcGFzc2VkOiBib29sZWFuIHwgbnVsbDsgLy8gbnVsbCA9IFx1NjcyQVx1NzdFNS9cdThGREJcdTg4NENcdTRFMkQoTkVFRFMtREFUQSBcdTY1RjZcdTRFMERcdTUwNDdcdTU4NkIpXG59XG5cbi8qKiBhcnRpZmFjdC5jcmVhdGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIEFydGlmYWN0Q3JlYXRlZFBheWxvYWQge1xuICBhcnRpZmFjdDogQXJ0aWZhY3RSZWY7XG59XG5cbi8qKiBydW4uY29tcGxldGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIFJ1bkNvbXBsZXRlZFBheWxvYWQge1xuICB0ZXh0OiBzdHJpbmc7XG4gIHR1cm5zOiBudW1iZXI7XG4gIHRvb2xVc2VzOiBudW1iZXI7XG4gIHVzYWdlPzogeyBwcm9tcHRUb2tlbnM6IG51bWJlcjsgY29tcGxldGlvblRva2VuczogbnVtYmVyIH07XG59XG5cbi8qKiBydW4uZmFpbGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIFJ1bkZhaWxlZFBheWxvYWQge1xuICBlcnJvcjogRGVza3RvcEVycm9yO1xufVxuIiwgIi8qKlxuICogQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyBcdTIwMTQgXHU3RUQzXHU2Nzg0XHU1MzE2XHU2ODRDXHU5NzYyXHU5NTE5XHU4QkVGKFx1NUYwMFx1NTNEMVx1OEJBMVx1NTIxMlx1NjU4N1x1Njg2MyAwNCBcdTAwQTdcdTRFMDkpXHUzMDAyXG4gKlxuICogaG9zdC1ub3QtcmVhZHkgLyBhdXRoLWZhaWxlZCAvIHN0YWxlLXZlcnNpb24gLyBydW50aW1lLWNyYXNoZWQgL1xuICogcG9ydC1iaW5kLWZhaWxlZCAvIHNjaGVtYS1taXNtYXRjaCBcdTVGQzVcdTk4N0JcdTY2MkZcdTdFRDNcdTY3ODRcdTUzMTZcdTk1MTlcdThCRUZcdTc4MDEsXHU1RTc2XHU2M0QwXHU0RjlCXHU0RTBCXHU0RTAwXHU2QjY1XHU1MkE4XHU0RjVDXHUzMDAyXG4gKiBtZXNzYWdlIFx1NjYyRlx1N0VBRlx1NjU4N1x1NjcyQyxcdTZFMzJcdTY3RDNcdTdBRUZcdTZDMzhcdTRFMERcdTYyOEFcdTVCODNcdTVGNTMgSFRNTFx1MzAwMlxuICovXG5leHBvcnQgY29uc3QgRVJST1JfQ09ERVMgPSBbXG4gICdIT1NUX05PVF9SRUFEWScsXG4gICdBVVRIX0ZBSUxFRCcsXG4gICdSVU5USU1FX0NSQVNIRUQnLFxuICAnUE9SVF9CSU5EX0ZBSUxFRCcsXG4gICdTVEFMRV9WRVJTSU9OJyxcbiAgJ1NDSEVNQV9NSVNNQVRDSCcsXG5dIGFzIGNvbnN0O1xuXG5leHBvcnQgdHlwZSBFcnJvckNvZGUgPSAodHlwZW9mIEVSUk9SX0NPREVTKVtudW1iZXJdO1xuXG5leHBvcnQgY29uc3QgUkVDT1ZFUllfQUNUSU9OUyA9IFsnUkVDT05ORUNUJywgJ1JFU1VNRScsICdFWFBPUlQnLCAnT1BFTl9MT0dTJ10gYXMgY29uc3Q7XG5leHBvcnQgdHlwZSBSZWNvdmVyeUFjdGlvbiA9ICh0eXBlb2YgUkVDT1ZFUllfQUNUSU9OUylbbnVtYmVyXTtcblxuZXhwb3J0IGludGVyZmFjZSBEZXNrdG9wRXJyb3Ige1xuICBjb2RlOiBFcnJvckNvZGU7XG4gIC8qKiBcdTdFQUZcdTY1ODdcdTY3MkMsXHU2QzM4XHU0RTBEXHU0RkUxXHU0RUZCXHU0RTNBIEhUTUxcdTMwMDIgKi9cbiAgbWVzc2FnZTogc3RyaW5nO1xuICByZXRyeWFibGU6IGJvb2xlYW47XG4gIHNlc3Npb25JZD86IHN0cmluZztcbiAgcnVuSWQ/OiBzdHJpbmc7XG4gIHJlY292ZXJ5QWN0aW9uPzogUmVjb3ZlcnlBY3Rpb247XG59XG5cbi8qKiBcdTY3ODRcdTkwMjBcdTRFMDBcdTRFMkEgRGVza3RvcEVycm9yKGV4YWN0T3B0aW9uYWxQcm9wZXJ0eVR5cGVzIFx1NTNDQlx1NTk3RClcdTMwMDIgKi9cbmV4cG9ydCBmdW5jdGlvbiBkZXNrdG9wRXJyb3IoXG4gIGNvZGU6IEVycm9yQ29kZSxcbiAgbWVzc2FnZTogc3RyaW5nLFxuICBvcHRzOiB7IHJldHJ5YWJsZT86IGJvb2xlYW47IHNlc3Npb25JZD86IHN0cmluZzsgcnVuSWQ/OiBzdHJpbmc7IHJlY292ZXJ5QWN0aW9uPzogUmVjb3ZlcnlBY3Rpb24gfSA9IHt9LFxuKTogRGVza3RvcEVycm9yIHtcbiAgY29uc3QgZTogRGVza3RvcEVycm9yID0geyBjb2RlLCBtZXNzYWdlLCByZXRyeWFibGU6IG9wdHMucmV0cnlhYmxlID09PSB0cnVlIH07XG4gIGlmIChvcHRzLnNlc3Npb25JZCAhPT0gdW5kZWZpbmVkKSBlLnNlc3Npb25JZCA9IG9wdHMuc2Vzc2lvbklkO1xuICBpZiAob3B0cy5ydW5JZCAhPT0gdW5kZWZpbmVkKSBlLnJ1bklkID0gb3B0cy5ydW5JZDtcbiAgaWYgKG9wdHMucmVjb3ZlcnlBY3Rpb24gIT09IHVuZGVmaW5lZCkgZS5yZWNvdmVyeUFjdGlvbiA9IG9wdHMucmVjb3ZlcnlBY3Rpb247XG4gIHJldHVybiBlO1xufVxuIiwgIi8qKlxuICogQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyBcdTIwMTQgcnVudGltZSBcdTY4MjFcdTlBOEMoZ3VhcmRzKVx1MzAwMlxuICpcbiAqIFx1NkJDRlx1NEUyQVx1OERFOFx1NEZFMVx1NEVGQlx1OEZCOVx1NzU0Q1x1NzY4NFx1NjU3MFx1NjM2RShydW50aW1lXHUyMTkycmVuZGVyZXJcdTMwMDFob3N0XHUyMTkybWFpbilcdThGREJcdTUxNjVcdTUyNERcdTUxNDhcdThGQzcgZ3VhcmQ7XG4gKiBcdTY4MjFcdTlBOENcdTU5MzFcdThEMjVcdTc2ODRcdTY1NzBcdTYzNkVcdTYzMDkgU0NIRU1BX01JU01BVENIIFx1N0VEM1x1Njc4NFx1NTMxNlx1OTUxOVx1OEJFRlx1NTkwNFx1NzQwNixcdTRFMERcdTk3NTlcdTlFRDhcdTYzQTVcdTUzRDdcdTMwMDJcbiAqIFx1NjI0Qlx1NTE5OVx1NUI4OFx1NTM2Qlx1ODAwQ1x1NEUwRFx1NjYyRlx1NUYxNVx1N0IyQ1x1NEUwOVx1NjVCOSBzY2hlbWEgXHU1RTkzOlx1NTk1MVx1N0VBNlx1OTc2Mlx1NUMwRixcdTk2RjZcdTRGOURcdThENTZcdTY1ODdcdTUzMTYoaG1oYXJuZXNzIFx1NTQwQ1x1NkU5MClcdTMwMDJcbiAqL1xuaW1wb3J0IHtcbiAgRVZFTlRfS0lORFMsXG4gIEVWRU5UX1NDSEVNQV9WRVJTSU9OLFxuICB0eXBlIEV2ZW50RW52ZWxvcGUsXG4gIHR5cGUgRXZlbnRLaW5kLFxufSBmcm9tICcuL2V2ZW50LnRzJztcbmltcG9ydCB7IEVSUk9SX0NPREVTLCBSRUNPVkVSWV9BQ1RJT05TLCB0eXBlIERlc2t0b3BFcnJvciB9IGZyb20gJy4vZXJyb3IudHMnO1xuaW1wb3J0IHsgUlVOX1NUQVRVU0VTLCB0eXBlIFJ1blN0YXR1cyB9IGZyb20gJy4vZHRvLnRzJztcblxuY29uc3QgaXNSZWNvcmQgPSAodjogdW5rbm93bik6IHYgaXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPT5cbiAgdHlwZW9mIHYgPT09ICdvYmplY3QnICYmIHYgIT09IG51bGwgJiYgIUFycmF5LmlzQXJyYXkodik7XG5cbmNvbnN0IGlzTm9uRW1wdHlTdHJpbmcgPSAodjogdW5rbm93bik6IHYgaXMgc3RyaW5nID0+IHR5cGVvZiB2ID09PSAnc3RyaW5nJyAmJiB2Lmxlbmd0aCA+IDA7XG5cbmNvbnN0IGlzUmZjMzMzOSA9ICh2OiBzdHJpbmcpOiBib29sZWFuID0+IHtcbiAgY29uc3QgdCA9IERhdGUucGFyc2Uodik7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUodCkgJiYgL1xcZHs0fS1cXGR7Mn0tXFxkezJ9VC8udGVzdCh2KTtcbn07XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0V2ZW50RW52ZWxvcGUodjogdW5rbm93bik6IHYgaXMgRXZlbnRFbnZlbG9wZSB7XG4gIGlmICghaXNSZWNvcmQodikpIHJldHVybiBmYWxzZTtcbiAgaWYgKHYuc2NoZW1hVmVyc2lvbiAhPT0gRVZFTlRfU0NIRU1BX1ZFUlNJT04pIHJldHVybiBmYWxzZTtcbiAgaWYgKCFpc05vbkVtcHR5U3RyaW5nKHYuZXZlbnRJZCkpIHJldHVybiBmYWxzZTtcbiAgaWYgKCFpc05vbkVtcHR5U3RyaW5nKHYuc2Vzc2lvbklkKSkgcmV0dXJuIGZhbHNlO1xuICBpZiAoIWlzTm9uRW1wdHlTdHJpbmcodi5ydW5JZCkpIHJldHVybiBmYWxzZTtcbiAgaWYgKHR5cGVvZiB2LnNlcSAhPT0gJ251bWJlcicgfHwgIU51bWJlci5pc0ludGVnZXIodi5zZXEpIHx8IHYuc2VxIDwgMCkgcmV0dXJuIGZhbHNlO1xuICBpZiAoIWlzTm9uRW1wdHlTdHJpbmcodi5vY2N1cnJlZEF0KSB8fCAhaXNSZmMzMzM5KHYub2NjdXJyZWRBdCkpIHJldHVybiBmYWxzZTtcbiAgaWYgKCFFVkVOVF9LSU5EUy5pbmNsdWRlcyh2LmtpbmQgYXMgRXZlbnRLaW5kKSkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gaXNSZWNvcmQodi5wYXlsb2FkKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzRGVza3RvcEVycm9yKHY6IHVua25vd24pOiB2IGlzIERlc2t0b3BFcnJvciB7XG4gIGlmICghaXNSZWNvcmQodikpIHJldHVybiBmYWxzZTtcbiAgaWYgKCFFUlJPUl9DT0RFUy5pbmNsdWRlcyh2LmNvZGUgYXMgbmV2ZXIpKSByZXR1cm4gZmFsc2U7XG4gIGlmICh0eXBlb2Ygdi5tZXNzYWdlICE9PSAnc3RyaW5nJykgcmV0dXJuIGZhbHNlO1xuICBpZiAodHlwZW9mIHYucmV0cnlhYmxlICE9PSAnYm9vbGVhbicpIHJldHVybiBmYWxzZTtcbiAgaWYgKHYuc2Vzc2lvbklkICE9PSB1bmRlZmluZWQgJiYgIWlzTm9uRW1wdHlTdHJpbmcodi5zZXNzaW9uSWQpKSByZXR1cm4gZmFsc2U7XG4gIGlmICh2LnJ1bklkICE9PSB1bmRlZmluZWQgJiYgIWlzTm9uRW1wdHlTdHJpbmcodi5ydW5JZCkpIHJldHVybiBmYWxzZTtcbiAgaWYgKHYucmVjb3ZlcnlBY3Rpb24gIT09IHVuZGVmaW5lZCAmJiAhUkVDT1ZFUllfQUNUSU9OUy5pbmNsdWRlcyh2LnJlY292ZXJ5QWN0aW9uIGFzIG5ldmVyKSkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzUnVuU3RhdHVzKHY6IHVua25vd24pOiB2IGlzIFJ1blN0YXR1cyB7XG4gIHJldHVybiB0eXBlb2YgdiA9PT0gJ3N0cmluZycgJiYgUlVOX1NUQVRVU0VTLmluY2x1ZGVzKHYgYXMgUnVuU3RhdHVzKTtcbn1cblxuLyoqIEhvc3QgXHU1RjE1XHU1QkZDXHU4ODRDKHN0ZG91dCBcdTdCMkNcdTRFMDBcdTg4NEMpXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gaXNIb3N0UmVhZHlMaW5lKHY6IHVua25vd24pOiB2IGlzIHsgaG1oRGVza3RvcEhvc3RSZWFkeTogdHJ1ZTsgcG9ydDogbnVtYmVyOyB2ZXJzaW9uOiBzdHJpbmcgfSB7XG4gIGlmICghaXNSZWNvcmQodikpIHJldHVybiBmYWxzZTtcbiAgaWYgKHYuaG1oRGVza3RvcEhvc3RSZWFkeSAhPT0gdHJ1ZSkgcmV0dXJuIGZhbHNlO1xuICBpZiAodHlwZW9mIHYucG9ydCAhPT0gJ251bWJlcicgfHwgIU51bWJlci5pc0ludGVnZXIodi5wb3J0KSB8fCB2LnBvcnQgPD0gMCB8fCB2LnBvcnQgPiA2NTUzNSkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gaXNOb25FbXB0eVN0cmluZyh2LnZlcnNpb24pO1xufVxuIiwgIi8qKlxuICogRGVza3RvcEhvc3RDbGllbnQgXHUyMDE0IFx1NUJGOSBobWggaG9zdCBcdTc2ODQgSFRUUCtTU0UgXHU1QkEyXHU2MjM3XHU3QUVGXHUzMDAyXG4gKlxuICogLSBcdTZCQ0ZcdTRFMkEgSFRUUCBcdThCRjdcdTZDNDJcdTgxRUFcdTUyQThcdTVFMjYgWC1IbWgtS2V5KHRva2VuIFx1NEUwRFx1OEZEQiBVUkwpO1xuICogLSBcdTdFRDNcdTY3ODRcdTUzMTZcdTk1MTlcdThCRUYocmVzLmJvZHkgXHU5MUNDXHU3Njg0IERlc2t0b3BFcnJvciBcdTVGNjJcdTcyQjZcdTYyMTYgSFRUUCBcdTcyQjZcdTYwMDEpXHU4OUM0XHU3RUE2XHU2MjEwXHU1RjAyXHU1RTM4XHU2MjlCXHU1MUZBO1xuICogLSBTU0UgXHU3NTI4IGZldGNoIFx1NkQ0MVx1NjI0Qlx1NTE5OVx1ODlFM1x1Njc5MChpZC9ldmVudC9kYXRhIFx1NUUyNyksXHU2NTJGXHU2MzAxIExhc3QtRXZlbnQtSUQgXHU4ODY1XHU2MkM5XHU5MUNEXHU4RkRFXHUzMDAyXG4gKi9cbmltcG9ydCB7IGRlc2t0b3BFcnJvciwgaXNEZXNrdG9wRXJyb3IsIGlzRXZlbnRFbnZlbG9wZSwgdHlwZSBEZXNrdG9wRXJyb3IsIHR5cGUgRXZlbnRFbnZlbG9wZSB9IGZyb20gJ0BobWgtZGVza3RvcC9jb250cmFjdHMnO1xuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gJ25vZGU6Y3J5cHRvJztcblxuZXhwb3J0IGludGVyZmFjZSBTc2VGcmFtZSB7XG4gIGlkPzogc3RyaW5nO1xuICBldmVudDogc3RyaW5nO1xuICBkYXRhOiBzdHJpbmc7XG59XG5cbi8qKiBcdTg5RTNcdTY3OTBcdTRFMDBcdTZCQjUgU1NFIFx1NjU4N1x1NjcyQ1x1NEUzQVx1NUUyNyhcdTRFMERcdTU0MkJcdThERTggY2h1bmsgXHU3Njg0XHU3RjEzXHU1MUIyXHU5MDNCXHU4RjkxLFx1N0VBRlx1NTFGRFx1NjU3MFx1NEZCRlx1NEU4RVx1NkQ0Qlx1OEJENSlcdTMwMDIgKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVNzZUNodW5rKGNodW5rOiBzdHJpbmcpOiBTc2VGcmFtZVtdIHtcbiAgY29uc3QgZnJhbWVzOiBTc2VGcmFtZVtdID0gW107XG4gIGZvciAoY29uc3QgYmxvY2sgb2YgY2h1bmsuc3BsaXQoL1xcblxcbi8pKSB7XG4gICAgaWYgKCFibG9jay50cmltKCkpIGNvbnRpbnVlO1xuICAgIGxldCBpZDogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAgIGxldCBldmVudCA9ICdtZXNzYWdlJztcbiAgICBjb25zdCBkYXRhTGluZXM6IHN0cmluZ1tdID0gW107XG4gICAgbGV0IHNhd0ZpZWxkID0gZmFsc2U7XG4gICAgZm9yIChjb25zdCBsaW5lIG9mIGJsb2NrLnNwbGl0KCdcXG4nKSkge1xuICAgICAgaWYgKGxpbmUuc3RhcnRzV2l0aCgnOicpKSBjb250aW51ZTsgLy8gXHU2Q0U4XHU5MUNBL1x1NUZDM1x1OERGM1xuICAgICAgaWYgKGxpbmUuc3RhcnRzV2l0aCgnaWQ6JykpIHsgaWQgPSBsaW5lLnNsaWNlKDMpLnRyaW0oKTsgc2F3RmllbGQgPSB0cnVlOyB9XG4gICAgICBlbHNlIGlmIChsaW5lLnN0YXJ0c1dpdGgoJ2V2ZW50OicpKSB7IGV2ZW50ID0gbGluZS5zbGljZSg2KS50cmltKCk7IHNhd0ZpZWxkID0gdHJ1ZTsgfVxuICAgICAgZWxzZSBpZiAobGluZS5zdGFydHNXaXRoKCdkYXRhOicpKSB7IGRhdGFMaW5lcy5wdXNoKGxpbmUuc2xpY2UoNSkucmVwbGFjZSgvXiAvLCAnJykpOyBzYXdGaWVsZCA9IHRydWU7IH1cbiAgICB9XG4gICAgaWYgKCFzYXdGaWVsZCkgY29udGludWU7IC8vIFx1N0VBRlx1NkNFOFx1OTFDQS9cdTVGQzNcdThERjNcdTU3NTdcdTRFMERcdTRFQTdcdTc1MUZcdTVFMjdcbiAgICBmcmFtZXMucHVzaCh7IC4uLihpZCAhPT0gdW5kZWZpbmVkID8geyBpZCB9IDoge30pLCBldmVudCwgZGF0YTogZGF0YUxpbmVzLmpvaW4oJ1xcbicpIH0pO1xuICB9XG4gIHJldHVybiBmcmFtZXM7XG59XG5cbi8qKiBcdTRFQ0UgU1NFIFx1NUUyN1x1NjU3MFx1NjM2RVx1NEUyRFx1ODlFM1x1NTFGQVx1NTQwOFx1NkNENSBFdmVudEVudmVsb3BlO1x1NEUwRFx1NTQwOFx1NkNENVx1NzY4NFx1OEZENFx1NTZERSBudWxsKFNDSEVNQV9NSVNNQVRDSCBcdTc1MzFcdThDMDNcdTc1MjhcdTY1QjlcdThCQTFcdTY1NzApXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gZW52ZWxvcGVGcm9tRnJhbWUoZnJhbWU6IFNzZUZyYW1lKTogRXZlbnRFbnZlbG9wZSB8IG51bGwge1xuICBpZiAoZnJhbWUuZXZlbnQgIT09ICdobWgnKSByZXR1cm4gbnVsbDsgLy8gXHU2MjExXHU0RUVDXHU3Njg0XHU0RThCXHU0RUY2XHU0RkUxXHU1QzAxXHU3RURGXHU0RTAwXHU4RDcwIGV2ZW50OiBobWhcbiAgdHJ5IHtcbiAgICBjb25zdCBwYXJzZWQ6IHVua25vd24gPSBKU09OLnBhcnNlKGZyYW1lLmRhdGEpO1xuICAgIHJldHVybiBpc0V2ZW50RW52ZWxvcGUocGFyc2VkKSA/IHBhcnNlZCA6IG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbmV4cG9ydCBjbGFzcyBEZXNrdG9wSHR0cEVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICBjb25zdHJ1Y3RvcihwdWJsaWMgcmVhZG9ubHkgZGV0YWlsOiBEZXNrdG9wRXJyb3IpIHtcbiAgICBzdXBlcihkZXRhaWwubWVzc2FnZSk7XG4gIH1cbn1cblxuZXhwb3J0IGNsYXNzIERlc2t0b3BIb3N0Q2xpZW50IHtcbiAgY29uc3RydWN0b3IoXG4gICAgcHJpdmF0ZSByZWFkb25seSBiYXNlVXJsOiBzdHJpbmcsXG4gICAgcHJpdmF0ZSByZWFkb25seSB0b2tlbjogc3RyaW5nLFxuICApIHt9XG5cbiAgcHJpdmF0ZSBoZWFkZXJzKGV4dHJhOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge30pOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IHtcbiAgICByZXR1cm4geyAneC1obWgta2V5JzogdGhpcy50b2tlbiwgLi4uZXh0cmEgfTtcbiAgfVxuXG4gIGFzeW5jIGdldEpzb248VD4ocGF0aDogc3RyaW5nLCB0aW1lb3V0TXMgPSA1XzAwMCk6IFByb21pc2U8VD4ge1xuICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgIHRyeSB7XG4gICAgICByZXMgPSBhd2FpdCBmZXRjaChgJHt0aGlzLmJhc2VVcmx9JHtwYXRofWAsIHsgaGVhZGVyczogdGhpcy5oZWFkZXJzKCksIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCh0aW1lb3V0TXMpIH0pO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGByZXF1ZXN0IGZhaWxlZDogJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxNjApfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy5wYXJzZVJlc3BvbnNlPFQ+KHJlcyk7XG4gIH1cblxuICAvKiogXHU2MkM5XHU1M0Q2XHU3RUFGXHU2NTg3XHU2NzJDXHU3QUVGXHU3MEI5KFx1NTk4MiAvYXBpL3Nlc3Npb25zLzppZC9leHBvcnQubWQpXHUzMDAyICovXG4gIGFzeW5jIGdldFRleHQocGF0aDogc3RyaW5nLCB0aW1lb3V0TXMgPSAxMF8wMDApOiBQcm9taXNlPHN0cmluZz4ge1xuICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgIHRyeSB7XG4gICAgICByZXMgPSBhd2FpdCBmZXRjaChgJHt0aGlzLmJhc2VVcmx9JHtwYXRofWAsIHsgaGVhZGVyczogdGhpcy5oZWFkZXJzKCksIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCh0aW1lb3V0TXMpIH0pO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGByZXF1ZXN0IGZhaWxlZDogJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxNjApfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICBpZiAocmVzLnN0YXR1cyA9PT0gNDAxIHx8IHJlcy5zdGF0dXMgPT09IDQwMykge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdBVVRIX0ZBSUxFRCcsIGBob3N0IHJlamVjdGVkIHRoZSBzZXNzaW9uIHRva2VuIChIVFRQICR7cmVzLnN0YXR1c30pYCwgeyByZXRyeWFibGU6IGZhbHNlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICBpZiAoIXJlcy5vaykge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBIVFRQICR7cmVzLnN0YXR1c31gLCB7IHJldHJ5YWJsZTogcmVzLnN0YXR1cyA+PSA1MDAgfSkpO1xuICAgIH1cbiAgICByZXR1cm4gcmVzLnRleHQoKTtcbiAgfVxuXG4gIC8qKiBcdTZCQ0ZcdTRFMkFcdTVFMjZcdTUyNkZcdTRGNUNcdTc1MjhcdTc2ODQgUE9TVCBcdTgxRUFcdTUyQThcdTY0M0FcdTVFMjZcdTVFNDJcdTdCNDlcdTk1MkUoMDMgXHUwMEE3XHU1NkRCXHU5NjMyXHU5MUNEXHU2NTNFOlx1OEJGN1x1NkM0Mlx1NEY3Rlx1NzUyOCBpZGVtcG90ZW5jeUtleTtcbiAgICogIHJ1bnRpbWUgXHU0RkE3XHU3N0VEXHU2NzFGXHU1MTdDXHU1QkI5XHU1RkZEXHU3NTY1LFx1NTM0Rlx1OEJBRVx1NTE0OFx1ODg0Q1x1MjAxNFx1MjAxNFx1OTFDRFx1OEJENVx1NTNFRlx1NTFFRFx1OTUyRVx1NTNCQlx1OTFDRCxcdTRFMERcdTc2RjJcdTc2RUVcdTkxQ0RcdTY1M0UpXHUzMDAyICovXG4gIGFzeW5jIHBvc3RKc29uPFQ+KHBhdGg6IHN0cmluZywgYm9keTogdW5rbm93biwgdGltZW91dE1zID0gMTBfMDAwKTogUHJvbWlzZTxUPiB7XG4gICAgbGV0IHJlczogUmVzcG9uc2U7XG4gICAgdHJ5IHtcbiAgICAgIHJlcyA9IGF3YWl0IGZldGNoKGAke3RoaXMuYmFzZVVybH0ke3BhdGh9YCwge1xuICAgICAgICBtZXRob2Q6ICdQT1NUJyxcbiAgICAgICAgaGVhZGVyczogdGhpcy5oZWFkZXJzKHtcbiAgICAgICAgICAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgICAgICAgICd4LWlkZW1wb3RlbmN5LWtleSc6IHJhbmRvbVVVSUQoKSxcbiAgICAgICAgfSksXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpLFxuICAgICAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQodGltZW91dE1zKSxcbiAgICAgIH0pO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGByZXF1ZXN0IGZhaWxlZDogJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxNjApfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy5wYXJzZVJlc3BvbnNlPFQ+KHJlcyk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHBhcnNlUmVzcG9uc2U8VD4ocmVzOiBSZXNwb25zZSk6IFByb21pc2U8VD4ge1xuICAgIGlmIChyZXMuc3RhdHVzID09PSA0MDEgfHwgcmVzLnN0YXR1cyA9PT0gNDAzKSB7XG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgYGhvc3QgcmVqZWN0ZWQgdGhlIHNlc3Npb24gdG9rZW4gKEhUVFAgJHtyZXMuc3RhdHVzfSlgLCB7IHJldHJ5YWJsZTogZmFsc2UsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XG4gICAgfVxuICAgIGNvbnN0IHRleHQgPSBhd2FpdCByZXMudGV4dCgpO1xuICAgIGxldCBwYXJzZWQ6IHVua25vd24gPSBudWxsO1xuICAgIHRyeSB7XG4gICAgICBwYXJzZWQgPSB0ZXh0ID8gSlNPTi5wYXJzZSh0ZXh0KSA6IG51bGw7XG4gICAgfSBjYXRjaCB7XG4gICAgICBwYXJzZWQgPSBudWxsO1xuICAgIH1cbiAgICBpZiAoIXJlcy5vaykge1xuICAgICAgaWYgKGlzRGVza3RvcEVycm9yKHBhcnNlZCkpIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKHBhcnNlZCk7XG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYEhUVFAgJHtyZXMuc3RhdHVzfTogJHt0ZXh0LnNsaWNlKDAsIDE2MCl9YCwgeyByZXRyeWFibGU6IHJlcy5zdGF0dXMgPj0gNTAwIH0pKTtcbiAgICB9XG4gICAgcmV0dXJuIHBhcnNlZCBhcyBUO1xuICB9XG5cbiAgLyoqXG4gICAqIFx1OEJBMlx1OTYwNVx1NTE2OFx1OTBFOCBTU0UgXHU1RTI3KFx1NTQyQlx1OTc1RVx1NEZFMVx1NUMwMVx1NEU4Qlx1NEVGNjpkZWx0YS9saW5lIFx1N0I0OVx1OUFEOFx1OTg5MVx1NkQ0MSlcdTMwMDJcdTRGRTFcdTVDMDFcdTc1MzFcdThDMDNcdTc1MjhcdTY1QjlcbiAgICogXHU3NTI4IGVudmVsb3BlRnJvbUZyYW1lIFx1ODFFQVx1ODg0Q1x1NTIwNlx1NkQ0MTtcdTY1QURcdTdFQkZcdTkxQ0RcdThGREVcdThCRURcdTRFNDlcdTU0MEMgZXZlbnRzKClcdTMwMDJcbiAgICovXG4gIGFzeW5jICpyYXdFdmVudHMobGFzdEV2ZW50SWQ/OiBzdHJpbmcsIHNpZ25hbD86IEFib3J0U2lnbmFsKTogQXN5bmNHZW5lcmF0b3I8U3NlRnJhbWU+IHtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgJHt0aGlzLmJhc2VVcmx9L2FwaS9ldmVudHNgLCB7XG4gICAgICBoZWFkZXJzOiB0aGlzLmhlYWRlcnMoe1xuICAgICAgICBhY2NlcHQ6ICd0ZXh0L2V2ZW50LXN0cmVhbScsXG4gICAgICAgIC4uLihsYXN0RXZlbnRJZCAhPT0gdW5kZWZpbmVkID8geyAnbGFzdC1ldmVudC1pZCc6IGxhc3RFdmVudElkIH0gOiB7fSksXG4gICAgICB9KSxcbiAgICAgIC4uLihzaWduYWwgIT09IHVuZGVmaW5lZCA/IHsgc2lnbmFsIH0gOiB7fSksXG4gICAgfSk7XG4gICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSB8fCByZXMuc3RhdHVzID09PSA0MDMpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignQVVUSF9GQUlMRUQnLCBgaG9zdCByZWplY3RlZCB0aGUgc2Vzc2lvbiB0b2tlbiAoSFRUUCAke3Jlcy5zdGF0dXN9KWAsIHsgcmV0cnlhYmxlOiBmYWxzZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcbiAgICB9XG4gICAgaWYgKCFyZXMub2sgfHwgcmVzLmJvZHkgPT09IG51bGwpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgU1NFIEhUVFAgJHtyZXMuc3RhdHVzfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICBjb25zdCByZWFkZXIgPSByZXMuYm9keS5nZXRSZWFkZXIoKTtcbiAgICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKCk7XG4gICAgbGV0IGJ1ZmZlciA9ICcnO1xuICAgIGZvciAoOzspIHtcbiAgICAgIGNvbnN0IHsgZG9uZSwgdmFsdWUgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICBpZiAoZG9uZSkgcmV0dXJuO1xuICAgICAgYnVmZmVyICs9IGRlY29kZXIuZGVjb2RlKHZhbHVlLCB7IHN0cmVhbTogdHJ1ZSB9KTtcbiAgICAgIGxldCBpZHg6IG51bWJlcjtcbiAgICAgIHdoaWxlICgoaWR4ID0gYnVmZmVyLmluZGV4T2YoJ1xcblxcbicpKSAhPT0gLTEpIHtcbiAgICAgICAgY29uc3QgYmxvY2sgPSBidWZmZXIuc2xpY2UoMCwgaWR4KTtcbiAgICAgICAgYnVmZmVyID0gYnVmZmVyLnNsaWNlKGlkeCArIDIpO1xuICAgICAgICBmb3IgKGNvbnN0IGZyYW1lIG9mIHBhcnNlU3NlQ2h1bmsoYmxvY2spKSB5aWVsZCBmcmFtZTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogXHU4QkEyXHU5NjA1IFNTRSBcdTRFOEJcdTRFRjZcdTZENDEoYXN5bmMgaXRlcmF0b3IpXHUzMDAyXHU2NUFEXHU3RUJGXHU3NTMxXHU4QzAzXHU3NTI4XHU2NUI5XHU5MUNEXHU4RkRFO1x1OTFDRFx1OEZERVx1NjVGNlx1NjI4QVx1NjcwMFx1NTQwRVxuICAgKiBcdTY1MzZcdTUyMzBcdTc2ODQgZXZlbnRJZCBcdTRGMjBcdTUxNjUgbGFzdEV2ZW50SWQsaG9zdCBcdTdBRUZcdTRFQ0VcdTkxQ0RcdTY1M0VcdTczQUZcdTg4NjVcdTUzRDFcdTMwMDJcbiAgICovXG4gIGFzeW5jICpldmVudHMobGFzdEV2ZW50SWQ/OiBzdHJpbmcsIHNpZ25hbD86IEFib3J0U2lnbmFsKTogQXN5bmNHZW5lcmF0b3I8RXZlbnRFbnZlbG9wZT4ge1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGAke3RoaXMuYmFzZVVybH0vYXBpL2V2ZW50c2AsIHtcbiAgICAgIGhlYWRlcnM6IHRoaXMuaGVhZGVycyh7XG4gICAgICAgIGFjY2VwdDogJ3RleHQvZXZlbnQtc3RyZWFtJyxcbiAgICAgICAgLi4uKGxhc3RFdmVudElkICE9PSB1bmRlZmluZWQgPyB7ICdsYXN0LWV2ZW50LWlkJzogbGFzdEV2ZW50SWQgfSA6IHt9KSxcbiAgICAgIH0pLFxuICAgICAgLi4uKHNpZ25hbCAhPT0gdW5kZWZpbmVkID8geyBzaWduYWwgfSA6IHt9KSxcbiAgICB9KTtcbiAgICBpZiAocmVzLnN0YXR1cyA9PT0gNDAxIHx8IHJlcy5zdGF0dXMgPT09IDQwMykge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdBVVRIX0ZBSUxFRCcsIGBob3N0IHJlamVjdGVkIHRoZSBzZXNzaW9uIHRva2VuIChIVFRQICR7cmVzLnN0YXR1c30pYCwgeyByZXRyeWFibGU6IGZhbHNlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICBpZiAoIXJlcy5vayB8fCAhcmVzLmJvZHkpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgU1NFIEhUVFAgJHtyZXMuc3RhdHVzfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICBjb25zdCByZWFkZXIgPSByZXMuYm9keS5nZXRSZWFkZXIoKTtcbiAgICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKCk7XG4gICAgbGV0IGJ1ZmZlciA9ICcnO1xuICAgIGZvciAoOzspIHtcbiAgICAgIGNvbnN0IHsgZG9uZSwgdmFsdWUgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICBpZiAoZG9uZSkgcmV0dXJuO1xuICAgICAgYnVmZmVyICs9IGRlY29kZXIuZGVjb2RlKHZhbHVlLCB7IHN0cmVhbTogdHJ1ZSB9KTtcbiAgICAgIC8vIFx1NEVFNVx1N0E3QVx1ODg0Q1x1NTIwNlx1NUUyNztcdTRGRERcdTc1NTlcdTRFMERcdTVCOENcdTY1NzRcdTc2ODRcdTVDM0VcdTkwRThcbiAgICAgIGxldCBpZHg6IG51bWJlcjtcbiAgICAgIHdoaWxlICgoaWR4ID0gYnVmZmVyLmluZGV4T2YoJ1xcblxcbicpKSAhPT0gLTEpIHtcbiAgICAgICAgY29uc3QgYmxvY2sgPSBidWZmZXIuc2xpY2UoMCwgaWR4KTtcbiAgICAgICAgYnVmZmVyID0gYnVmZmVyLnNsaWNlKGlkeCArIDIpO1xuICAgICAgICBmb3IgKGNvbnN0IGZyYW1lIG9mIHBhcnNlU3NlQ2h1bmsoYmxvY2spKSB7XG4gICAgICAgICAgY29uc3QgZW52ID0gZW52ZWxvcGVGcm9tRnJhbWUoZnJhbWUpO1xuICAgICAgICAgIGlmIChlbnYgIT09IG51bGwpIHlpZWxkIGVudjtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxufVxuIiwgIi8qKlxuICogZmFrZSBob3N0IFx1MjAxNCBobWhhcm5lc3MgcnVudGltZSBcdTc2ODRcdTZENEJcdThCRDVcdTY2RkZcdThFQUIoTWFzdGVyUHJvbXB0IFx1OTYzNlx1NkJCNSBEL0U6XG4gKiBcIlx1NTE0OFx1NEY3Rlx1NzUyOCBmYWtlIGhvc3QgXHU3RjE2XHU1MTk5XHU3MkI2XHU2MDAxXHU2NzNBXHU2RDRCXHU4QkQ1LFx1NTE4RFx1NjNBNVx1NzcxRlx1NUI5RSBBUElcIjtcdTk2MzZcdTZCQjUgRSBcdTc2ODRcdTRGMUFcdThCRERcdTdFQjVcdTUyMDdcdTcyNDdcbiAqIGUyZSBcdTRFNUZcdTUxNDhcdTU3MjggZmFrZSBcdTVDNDJcdTk1RURcdTczQUYpXHUzMDAyXG4gKlxuICogXHU2ODRDXHU5NzYyIGhvc3QgXHU1NDA4XHU1NDBDOlxuICogIC0gXHU1M0VBXHU3RUQxIDEyNy4wLjAuMSxcdTdBRUZcdTUzRTMgT1MgXHU1MjA2XHU5MTRELFx1NUI5RVx1OTY0NVx1N0FFRlx1NTNFM1x1NTE5OSBzdGRvdXQgXHU1RjE1XHU1QkZDXHU4ODRDO1xuICogIC0gXHU2MjQwXHU2NzA5IC9hcGkvKiBcdTg5ODFcdTZDNDIgWC1IbWgtS2V5ID09PSBITUhfREVTS1RPUF9UT0tFTixcdTU0MjZcdTUyMTkgNDAxICsgRGVza3RvcEVycm9yO1xuICogIC0gR0VUIC9hcGkvc3RhdGUgXHU1MDY1XHU1RUI3XHU2M0EyXHU2RDRCO0dFVCAvYXBpL2V2ZW50cyBTU0UoZXZlbnQ6IGhtaCBcdTRGRTFcdTVDMDFcdTZENDEgKyBcdTkxQ0RcdTY1M0VcdTczQUYpO1xuICogIC0gUE9TVCAvYXBpL2Rlc2t0b3Avc2h1dGRvd24gXHU0RjE4XHU5NkM1XHU5MDAwXHU1MUZBXHUzMDAyXG4gKlxuICogXHU5NjM2XHU2QkI1IEUgXHU2QTIxXHU2MkRGXHU5NzYyKFx1NEUwRSBobWhhcm5lc3MgZGVza3RvcCBcdTZBMjFcdTVGMEZcdTU0MENcdTVGNjIpOlxuICogIC0gUE9TVCAvYXBpL3Rhc2sge3RleHQsIHNlc3Npb25JZCwgbW9kZX06XHU2MzkyXHU5NjFGXHU1RTc2XHU2MzA5XHU4MTFBXHU2NzJDXHU1M0QxXG4gKiAgICBydW4uc3RhcnRlZCBcdTIxOTIgdG9vbC5zdGFydGVkL2NvbXBsZXRlZCBcdTIxOTIobW9kZT09PSdhc2snIFx1NjVGNilcbiAqICAgIGFwcHJvdmFsLnJlcXVpcmVkKFx1N0I0OSAvYXBpL2FwcHJvdmUpXHUyMTkyIHJ1bi5jb21wbGV0ZWQ7XG4gKiAgLSBQT1NUIC9hcGkvYXBwcm92ZSB7Z3JhbnRlZCwgc2Vzc2lvbklkfTtcbiAqICAtIFBPU1QgL2FwaS9pbnRlcnJ1cHQge3Nlc3Npb25JZH07XG4gKiAgLSBHRVQgL2FwaS9zZXNzaW9uc1x1MzAwMlxuICpcbiAqIFx1NkQ0Qlx1OEJENVx1OTRBOVx1NUI1MDpGQUtFX0hPU1RfRElFX0FGVEVSX01TIC8gRkFLRV9IT1NUX0RJRV9BVF9CT09UIC9cbiAqIEZBS0VfSE9TVF9FWFBFQ1RfVE9LRU4gLyBGQUtFX0hPU1RfVEFTS19ERUxBWV9NUyAvIEZBS0VfSE9TVF9UQVNLX0ZBSUw9MVxuICogKFx1NEVGQlx1NTJBMVx1NEVFNSBydW4uZmFpbGVkIFx1N0VEM1x1Njc1RixcdTY3ODRcdTkwMjBcdTk1MTlcdThCRUZcdTYwNjJcdTU5MERcdTU3M0FcdTY2NkYpXHUzMDAyXG4gKi9cbmltcG9ydCB7IGNyZWF0ZVNlcnZlciwgdHlwZSBTZXJ2ZXJSZXNwb25zZSB9IGZyb20gJ25vZGU6aHR0cCc7XG5pbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSAnbm9kZTpjcnlwdG8nO1xuaW1wb3J0IHsgcGF0aFRvRmlsZVVSTCB9IGZyb20gJ25vZGU6dXJsJztcbmltcG9ydCB7IHJlYWxwYXRoU3luYyB9IGZyb20gJ25vZGU6ZnMnO1xuaW1wb3J0IHsgRVZFTlRfU0NIRU1BX1ZFUlNJT04sIGRlc2t0b3BFcnJvciwgdHlwZSBFdmVudEVudmVsb3BlLCB0eXBlIEV2ZW50S2luZCB9IGZyb20gJ0BobWgtZGVza3RvcC9jb250cmFjdHMnO1xuXG5leHBvcnQgaW50ZXJmYWNlIEZha2VIb3N0SGFuZGxlIHtcbiAgcG9ydDogbnVtYmVyO1xuICBlbWl0KHNlc3Npb25JZDogc3RyaW5nLCBydW5JZDogc3RyaW5nLCBraW5kOiBFdmVudEtpbmQsIHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogbnVtYmVyO1xuICBjbG9zZSgpOiBQcm9taXNlPHZvaWQ+O1xufVxuXG5pbnRlcmZhY2UgRmFrZVNlc3Npb24ge1xuICBpZDogc3RyaW5nO1xuICBjcmVhdGVkQXQ6IHN0cmluZztcbiAgdXBkYXRlZEF0OiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBQZW5kaW5nQXBwcm92YWwge1xuICBzZXNzaW9uSWQ6IHN0cmluZztcbiAgYXBwcm92YWxJZDogc3RyaW5nO1xuICByZXNvbHZlKGdyYW50ZWQ6IGJvb2xlYW4pOiB2b2lkO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc3RhcnRGYWtlSG9zdChvcHRzOiB7IHRva2VuOiBzdHJpbmc7IHF1aWV0PzogYm9vbGVhbiB9KTogUHJvbWlzZTxGYWtlSG9zdEhhbmRsZT4ge1xuICBjb25zdCB0b2tlbiA9IG9wdHMudG9rZW47XG4gIC8vIFx1NkQ0Qlx1OEJENVx1OTRBOVx1NUI1MDpGQUtFX0hPU1RfRVhQRUNUX1RPS0VOIFx1OEJBOSBob3N0IFx1NjgyMVx1OUE4Q1x1NEUwMFx1NEUyQVx1NEUwRSBITUhfREVTS1RPUF9UT0tFTlxuICAvLyBcdTRFMERcdTU0MENcdTc2ODRcdTUwM0MoXHU2Nzg0XHU5MDIwIEFVVEhfRkFJTEVEIFx1NTczQVx1NjY2RjtzdXBlcnZpc29yIFx1NjAzQlx1NjYyRlx1ODk4Nlx1NzZENiBITUhfREVTS1RPUF9UT0tFTilcbiAgY29uc3QgZXhwZWN0ZWQgPSBwcm9jZXNzLmVudi5GQUtFX0hPU1RfRVhQRUNUX1RPS0VOID8/IHRva2VuO1xuICBjb25zdCB0YXNrRGVsYXkgPSBOdW1iZXIocHJvY2Vzcy5lbnYuRkFLRV9IT1NUX1RBU0tfREVMQVlfTVMgPz8gMzApO1xuICBjb25zdCBmYWlsVGFza3MgPSBwcm9jZXNzLmVudi5GQUtFX0hPU1RfVEFTS19GQUlMID09PSAnMSc7XG5cbiAgY29uc3Qgc3NlQ2xpZW50cyA9IG5ldyBTZXQ8U2VydmVyUmVzcG9uc2U+KCk7XG4gIGNvbnN0IHNlcUJ5UnVuID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgLy8gXHU5MUNEXHU2NTNFXHU3M0FGOlx1NjcwMFx1OEZEMSAyMDAgXHU1RTI3KExhc3QtRXZlbnQtSUQgXHU2NUFEXHU3RUJGXHU4ODY1XHU2MkM5KSxcdTRFMEUgaG1oYXJuZXNzIHdlYiBcdTU0MENcdTZCM0VcdThCRURcdTRFNDlcbiAgY29uc3QgcmluZzogQXJyYXk8eyBpZDogbnVtYmVyOyBldmVudDogc3RyaW5nOyBkYXRhOiB1bmtub3duIH0+ID0gW107XG4gIGxldCByaW5nU2VxID0gMDtcbiAgY29uc3Qgc2Vzc2lvbnMgPSBuZXcgTWFwPHN0cmluZywgRmFrZVNlc3Npb24+KCk7XG4gIGxldCBwZW5kaW5nOiBQZW5kaW5nQXBwcm92YWwgfCBudWxsID0gbnVsbDtcbiAgY29uc3QgcnVuVGltZXJzID0gbmV3IE1hcDxzdHJpbmcsIE5vZGVKUy5UaW1lb3V0PigpO1xuICAvLyBcdTVERTVcdTRGNUNcdTUzM0EvUHJvdmlkZXIgXHU3MkI2XHU2MDAxKFx1NEUwRSBobWhhcm5lc3MgXHU1NDBDXHU1RjYyXHU3Njg0XHU2NzAwXHU1QzBGXHU2QTIxXHU2MkRGKVxuICBjb25zdCBmYWtlV29ya3NwYWNlcyA9IHtcbiAgICBjdXJyZW50OiAnd3MtZGVtbycsXG4gICAgaXRlbXM6IFtcbiAgICAgIHsgaWQ6ICd3cy1kZW1vJywgbmFtZTogJ2RlbW8td29ya3NwYWNlJywgcGF0aDogJ0M6XFxcXGRlbW8nIH0sXG4gICAgXSxcbiAgfTtcbiAgY29uc3QgZmFrZVByb3ZpZGVycyA9IG5ldyBNYXA8c3RyaW5nLCB7IGJhc2VVcmw6IHN0cmluZzsgbW9kZWw6IHN0cmluZzsgYXBpS2V5OiBzdHJpbmcgfT4oW1xuICAgIFsnZGVtbycsIHsgYmFzZVVybDogJ2h0dHA6Ly8xMjcuMC4wLjE6OS92MScsIG1vZGVsOiAnZmFrZS1tJywgYXBpS2V5OiAnc2stZGVtby0xMjM0JyB9XSxcbiAgICBbJ2RlbW8tdmlzaW9uJywgeyBiYXNlVXJsOiAnaHR0cDovLzEyNy4wLjAuMTo5L3YxJywgbW9kZWw6ICdmYWtlLW0tdmlzaW9uJywgYXBpS2V5OiAnc2stZGVtby01Njc4JyB9XSxcbiAgXSk7XG4gIGxldCBmYWtlQ2hhdFByb3ZpZGVyID0gJ2RlbW8nO1xuXG4gIGNvbnN0IGVtaXQgPSAoc2Vzc2lvbklkOiBzdHJpbmcsIHJ1bklkOiBzdHJpbmcsIGtpbmQ6IEV2ZW50S2luZCwgcGF5bG9hZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBudW1iZXIgPT4ge1xuICAgIGNvbnN0IGtleSA9IGAke3Nlc3Npb25JZH1cXDAke3J1bklkfWA7XG4gICAgY29uc3Qgc2VxID0gKHNlcUJ5UnVuLmdldChrZXkpID8/IDApICsgMTtcbiAgICBzZXFCeVJ1bi5zZXQoa2V5LCBzZXEpO1xuICAgIGNvbnN0IGVudjogRXZlbnRFbnZlbG9wZSA9IHtcbiAgICAgIHNjaGVtYVZlcnNpb246IEVWRU5UX1NDSEVNQV9WRVJTSU9OLFxuICAgICAgZXZlbnRJZDogcmFuZG9tVVVJRCgpLFxuICAgICAgc2Vzc2lvbklkLFxuICAgICAgcnVuSWQsXG4gICAgICBzZXEsXG4gICAgICBvY2N1cnJlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICBraW5kLFxuICAgICAgcGF5bG9hZCxcbiAgICB9O1xuICAgIGNvbnN0IGlkID0gKytyaW5nU2VxO1xuICAgIHJpbmcucHVzaCh7IGlkLCBldmVudDogJ2htaCcsIGRhdGE6IGVudiB9KTtcbiAgICBpZiAocmluZy5sZW5ndGggPiAyMDApIHJpbmcuc3BsaWNlKDAsIHJpbmcubGVuZ3RoIC0gMjAwKTtcbiAgICBmb3IgKGNvbnN0IGMgb2Ygc3NlQ2xpZW50cykge1xuICAgICAgYy53cml0ZShgaWQ6ICR7aWR9XFxuZXZlbnQ6IGhtaFxcbmRhdGE6ICR7SlNPTi5zdHJpbmdpZnkoZW52KX1cXG5cXG5gKTtcbiAgICB9XG4gICAgcmV0dXJuIHNlcTtcbiAgfTtcblxuICBjb25zdCB0b3VjaCA9IChzZXNzaW9uSWQ6IHN0cmluZyk6IEZha2VTZXNzaW9uID0+IHtcbiAgICBsZXQgcyA9IHNlc3Npb25zLmdldChzZXNzaW9uSWQpO1xuICAgIGlmIChzID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHMgPSB7IGlkOiBzZXNzaW9uSWQsIGNyZWF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLCB1cGRhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSB9O1xuICAgICAgc2Vzc2lvbnMuc2V0KHNlc3Npb25JZCwgcyk7XG4gICAgfVxuICAgIHMudXBkYXRlZEF0ID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuICAgIHJldHVybiBzO1xuICB9O1xuXG4gIC8qKiBcdTZBMjFcdTYyREZcdTRFMDBcdTZCMjFcdTRFRkJcdTUyQTE6XHU2Mjc5XHU1MUM2XHU2QTIxXHU1RjBGXHU2MzAyXHU4RDc3XHU3QjQ5XHU1Rjg1IC9hcGkvYXBwcm92ZVx1MzAwMiAqL1xuICBjb25zdCBydW5UYXNrID0gKHNlc3Npb25JZDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcsIG1vZGU6IHN0cmluZyk6IHN0cmluZyA9PiB7XG4gICAgY29uc3QgcnVuSWQgPSBgcnVuLSR7RGF0ZS5ub3coKS50b1N0cmluZygzNil9LSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMiwgOCl9YDtcbiAgICB0b3VjaChzZXNzaW9uSWQpO1xuICAgIGNvbnN0IHN0ZXBzOiBBcnJheTwoKSA9PiB2b2lkPiA9IFtdO1xuICAgIGNvbnN0IHdhaXQgPSAoZm46ICgpID0+IHZvaWQsIG1zID0gdGFza0RlbGF5KTogdm9pZCA9PiB7XG4gICAgICBjb25zdCB0ID0gc2V0VGltZW91dChmbiwgbXMpO1xuICAgICAgcnVuVGltZXJzLnNldChgJHtzZXNzaW9uSWR9XFwwJHtydW5JZH1gLCB0KTtcbiAgICB9O1xuICAgIGNvbnN0IGNoYWluID0gKGZuczogQXJyYXk8KCkgPT4gdm9pZD4pOiB2b2lkID0+IHtcbiAgICAgIGNvbnN0IFtmaXJzdCwgLi4ucmVzdF0gPSBmbnM7XG4gICAgICBpZiAoZmlyc3QgPT09IHVuZGVmaW5lZCkgcmV0dXJuO1xuICAgICAgd2FpdCgoKSA9PiB7XG4gICAgICAgIGZpcnN0KCk7XG4gICAgICAgIGNoYWluKHJlc3QpO1xuICAgICAgfSk7XG4gICAgfTtcblxuICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ3J1bi5zdGFydGVkJywgeyB0YXNrOiB0ZXh0LCBtb2RlIH0pO1xuICAgIGlmIChmYWlsVGFza3MpIHtcbiAgICAgIHdhaXQoKCkgPT4gZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAncnVuLmZhaWxlZCcsIHtcbiAgICAgICAgZXJyb3I6IHsgY29kZTogJ0FVVEhfRkFJTEVEJywgbWVzc2FnZTogJ3NpbXVsYXRlZCBwcm92aWRlciBhdXRoIGZhaWx1cmUnLCByZXRyeWFibGU6IGZhbHNlIH0sXG4gICAgICB9KSk7XG4gICAgICByZXR1cm4gcnVuSWQ7XG4gICAgfVxuXG4gICAgY29uc3QgZmluaXNoUnVuID0gKGFuc3dlcjogc3RyaW5nLCB0b29sVXNlczogbnVtYmVyKTogdm9pZCA9PiB7XG4gICAgICBydW5UaW1lcnMuZGVsZXRlKGAke3Nlc3Npb25JZH1cXDAke3J1bklkfWApO1xuICAgICAgLy8gXHU0RUE0XHU0RUQ4XHU3MjY5XHU1MTQ4XHU0RThFXHU3RUM4XHU2MDAxKFx1NEUwRSBobWhhcm5lc3MgZGVza3RvcCBcdTY4NjVcdTU0MENcdTVFOEY6YXJ0aWZhY3QuY3JlYXRlZCBcdTIxOTIgcnVuLmNvbXBsZXRlZClcbiAgICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ2FydGlmYWN0LmNyZWF0ZWQnLCB7XG4gICAgICAgIGFydGlmYWN0OiB7IHJlbFBhdGg6ICdvdXQudHh0Jywga2luZDogJ2ZpbGUnLCB0aXRsZTogJ291dC50eHQnIH0sXG4gICAgICB9KTtcbiAgICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ3J1bi5jb21wbGV0ZWQnLCB7IHRleHQ6IGFuc3dlciwgdHVybnM6IDEsIHRvb2xVc2VzIH0pO1xuICAgIH07XG5cbiAgICBjb25zdCBzY3JpcHRlZDogQXJyYXk8KCkgPT4gdm9pZD4gPSBbXG4gICAgICAoKSA9PiBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICd0b29sLnN0YXJ0ZWQnLCB7IG5hbWU6ICdyZWFkX2ZpbGUnLCBhcmdzUHJldmlldzogJ3tcInBhdGhcIjpcIlJFQURNRS5tZFwifScgfSksXG4gICAgICAoKSA9PiBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICd0b29sLmNvbXBsZXRlZCcsIHsgbmFtZTogJ3JlYWRfZmlsZScsIGlzRXJyb3I6IGZhbHNlLCBvdXRwdXRQcmV2aWV3OiAnIyBkZW1vJyB9KSxcbiAgICBdO1xuXG4gICAgaWYgKG1vZGUgPT09ICdhc2snKSB7XG4gICAgICBzY3JpcHRlZC5wdXNoKCgpID0+IHtcbiAgICAgICAgY29uc3QgYXBwcm92YWxJZCA9IGBhcC0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDgpfWA7XG4gICAgICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ2FwcHJvdmFsLnJlcXVpcmVkJywge1xuICAgICAgICAgIGFwcHJvdmFsSWQsXG4gICAgICAgICAgdG9vbDogJ3dyaXRlX2ZpbGUnLFxuICAgICAgICAgIGFyZ3NQcmV2aWV3OiAne1wicGF0aFwiOlwib3V0LnR4dFwiLFwiY29udGVudFwiOlwiaGlcIn0nLFxuICAgICAgICAgIHJpc2s6ICdcdTUxOTlcdTUxNjVcdTVERTVcdTRGNUNcdTUzM0FcdTY1ODdcdTRFRjYgb3V0LnR4dChcdTZBMjFcdTYyREYpJyxcbiAgICAgICAgfSk7XG4gICAgICAgIHBlbmRpbmcgPSB7XG4gICAgICAgICAgc2Vzc2lvbklkLFxuICAgICAgICAgIGFwcHJvdmFsSWQsXG4gICAgICAgICAgcmVzb2x2ZTogKGdyYW50ZWQpID0+IHtcbiAgICAgICAgICAgIHBlbmRpbmcgPSBudWxsO1xuICAgICAgICAgICAgaWYgKGdyYW50ZWQpIHtcbiAgICAgICAgICAgICAgZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAndG9vbC5zdGFydGVkJywgeyBuYW1lOiAnd3JpdGVfZmlsZScsIGFyZ3NQcmV2aWV3OiAne1wicGF0aFwiOlwib3V0LnR4dFwifScgfSk7XG4gICAgICAgICAgICAgIHdhaXQoKCkgPT4gZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAndG9vbC5jb21wbGV0ZWQnLCB7IG5hbWU6ICd3cml0ZV9maWxlJywgaXNFcnJvcjogZmFsc2UsIG91dHB1dFByZXZpZXc6ICd3cm90ZSAyIGJ5dGVzJyB9KSk7XG4gICAgICAgICAgICAgIHdhaXQoKCkgPT4gZmluaXNoUnVuKGBlY2hvOiAke3RleHR9KFx1NURGMlx1NjI2N1x1ODg0Q1x1NTE5OVx1NTE2NSlgLCAzKSwgdGFza0RlbGF5ICogMik7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICBmaW5pc2hSdW4oYGVjaG86ICR7dGV4dH0oXHU1QkExXHU2Mjc5XHU4OEFCXHU2MkQyXHU3RURELFx1NjcyQVx1NjI2N1x1ODg0Q1x1NTE5OVx1NTE2NSlgLCAxKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9LFxuICAgICAgICB9O1xuICAgICAgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHNjcmlwdGVkLnB1c2goKCkgPT4gZmluaXNoUnVuKGBlY2hvOiAke3RleHR9YCwgMSkpO1xuICAgIH1cbiAgICBjaGFpbihzY3JpcHRlZCk7XG4gICAgcmV0dXJuIHJ1bklkO1xuICB9O1xuXG4gIGNvbnN0IHNlcnZlciA9IGNyZWF0ZVNlcnZlcigocmVxLCByZXMpID0+IHtcbiAgICBjb25zdCB1cmwgPSBuZXcgVVJMKHJlcS51cmwgPz8gJy8nLCAnaHR0cDovLzEyNy4wLjAuMScpO1xuICAgIGNvbnN0IGF1dGhvcml6ZWQgPSByZXEuaGVhZGVyc1sneC1obWgta2V5J10gPT09IGV4cGVjdGVkO1xuICAgIGNvbnN0IGRlbnkgPSAoKTogdm9pZCA9PiB7XG4gICAgICByZXMud3JpdGVIZWFkKDQwMSwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgJ21pc3Npbmcgb3IgaW52YWxpZCB4LWhtaC1rZXknLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICB9O1xuXG4gICAgY29uc3QgcmVhZEJvZHkgPSAoKTogUHJvbWlzZTxzdHJpbmc+ID0+XG4gICAgICBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xuICAgICAgICBsZXQgYiA9ICcnO1xuICAgICAgICByZXEub24oJ2RhdGEnLCAoYzogQnVmZmVyKSA9PiB7IGIgKz0gYy50b1N0cmluZygpOyB9KTtcbiAgICAgICAgcmVxLm9uKCdlbmQnLCAoKSA9PiByZXNvbHZlKGIpKTtcbiAgICAgIH0pO1xuXG4gICAgaWYgKHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZXZlbnRzJykge1xuICAgICAgaWYgKCFhdXRob3JpemVkKSB7IGRlbnkoKTsgcmV0dXJuOyB9XG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ3RleHQvZXZlbnQtc3RyZWFtJywgJ2NhY2hlLWNvbnRyb2wnOiAnbm8tY2FjaGUnLCBjb25uZWN0aW9uOiAna2VlcC1hbGl2ZScgfSk7XG4gICAgICByZXMuZmx1c2hIZWFkZXJzPy4oKTtcbiAgICAgIHNzZUNsaWVudHMuYWRkKHJlcyk7XG4gICAgICAvLyBcdTY1QURcdTdFQkZcdTg4NjVcdTYyQzk6TGFzdC1FdmVudC1JRCBcdTRFNEJcdTUyNERcdTc2ODRcdTVFMjdcdTVERjJcdTU3MjhcdTVCQTJcdTYyMzdcdTdBRUYsXHU5MUNEXHU1M0QxXHU1MTc2XHU1NDBFXHU3Njg0XHU3M0FGXHU1RjYyXHU3RjEzXHU1MUIyXG4gICAgICBjb25zdCBsYXN0SWQgPSBOdW1iZXIocmVxLmhlYWRlcnNbJ2xhc3QtZXZlbnQtaWQnXSA/PyAwKTtcbiAgICAgIGlmIChOdW1iZXIuaXNGaW5pdGUobGFzdElkKSAmJiBsYXN0SWQgPiAwKSB7XG4gICAgICAgIGZvciAoY29uc3QgZSBvZiByaW5nKSB7XG4gICAgICAgICAgaWYgKGUuaWQgPiBsYXN0SWQpIHJlcy53cml0ZShgaWQ6ICR7ZS5pZH1cXG5ldmVudDogJHtlLmV2ZW50fVxcbmRhdGE6ICR7SlNPTi5zdHJpbmdpZnkoZS5kYXRhKX1cXG5cXG5gKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmVxLm9uKCdjbG9zZScsICgpID0+IHNzZUNsaWVudHMuZGVsZXRlKHJlcykpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAoIWF1dGhvcml6ZWQpIHsgZGVueSgpOyByZXR1cm47IH1cblxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3N0YXRlJykge1xuICAgICAgLy8gcHJvdmlkZXJzRGV0YWlsOlx1NEUwRSBobWhhcm5lc3MgXHU1NDBDXHU1RjYyXHUyMDE0XHUyMDE0a2V5IFx1NTNFQVx1NTFGQSBoYXNLZXkvXHU2NzJCXHU1NkRCXHU0RjRELFx1NkMzOFx1NEUwRFx1NjYwRVx1NjU4N1xuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBkYWVtb25WZXJzaW9uOiAnZmFrZS0wLjAuMCcsIGRlc2t0b3A6IHRydWUsIG1vZGVsOiBmYWtlUHJvdmlkZXJzLmdldChmYWtlQ2hhdFByb3ZpZGVyKT8ubW9kZWwgPz8gJ2Zha2UtbW9kZWwnLFxuICAgICAgICBjaGF0UHJvdmlkZXI6IGZha2VDaGF0UHJvdmlkZXIsIGxvY2FsZTogJ3poJyxcbiAgICAgICAgYnVzeVNlc3Npb25zOiBbLi4uc2Vzc2lvbnMua2V5cygpXS5zbGljZSgwLCAyKSxcbiAgICAgICAgYXBwcm92YWxQZW5kaW5nOiBwZW5kaW5nICE9PSBudWxsLFxuICAgICAgICBzZXR0aW5nczogeyBhcHByb3ZhbDogJ2FzaycgfSxcbiAgICAgICAgd29ya3NwYWNlOiBmYWtlV29ya3NwYWNlcy5pdGVtcy5maW5kKCh3KSA9PiB3LmlkID09PSBmYWtlV29ya3NwYWNlcy5jdXJyZW50KSA/PyBudWxsLFxuICAgICAgICBwcm92aWRlcnNEZXRhaWw6IFsuLi5mYWtlUHJvdmlkZXJzLmVudHJpZXMoKV0ubWFwKChbbmFtZSwgcF0pID0+ICh7XG4gICAgICAgICAgbmFtZSwgbW9kZWw6IHAubW9kZWwsIGJhc2VVcmw6IHAuYmFzZVVybCxcbiAgICAgICAgICBoYXNLZXk6IHAuYXBpS2V5ICE9PSAnJyxcbiAgICAgICAgICBrZXlUYWlsOiBwLmFwaUtleS5sZW5ndGggPj0gNCA/IHAuYXBpS2V5LnNsaWNlKC00KSA6IHVuZGVmaW5lZCxcbiAgICAgICAgICBwdXJwb3NlczogWydjaGF0J10sXG4gICAgICAgIH0pKSxcbiAgICAgIH0pKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2Rlc2t0b3Avc2h1dGRvd24nKSB7XG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlIH0pKTtcbiAgICAgIHNlcnZlci5jbG9zZSgoKSA9PiBwcm9jZXNzLmV4aXQoMCkpO1xuICAgICAgc2V0VGltZW91dCgoKSA9PiBwcm9jZXNzLmV4aXQoMCksIDFfMDAwKS51bnJlZigpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZmFrZS9kaWUnKSB7XG4gICAgICAvLyBcdTZENEJcdThCRDVcdTk0QTlcdTVCNTA6XHU2QTIxXHU2MkRGIGhvc3QgXHU1RDI5XHU2RTgzKFx1NTE0OFx1NUU5NFx1N0I1NFx1NTE4RFx1OTAwMFx1NTFGQSxcdTRGRERcdThCQzFcdTU0Q0RcdTVFOTRcdTVERjJcdTUzRDFcdTUxRkEpXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlIH0pKTtcbiAgICAgIHNldFRpbWVvdXQoKCkgPT4gcHJvY2Vzcy5leGl0KDEpLCA1MCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9tb2RlbCcpIHtcbiAgICAgIC8vIFx1NkEyMVx1NTc4Qlx1NTIwN1x1NjM2MihcdTRFMEUgaG1oYXJuZXNzIC9hcGkvbW9kZWwgXHU1NDBDXHU1RjYyOlx1NTIwNyBjaGF0IFx1OERFRlx1NzUzMSlcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoKGF3YWl0IHJlYWRCb2R5KCkpIHx8ICd7fScpIGFzIHsgbmFtZT86IHVua25vd24gfTtcbiAgICAgICAgY29uc3QgbmFtZSA9IHR5cGVvZiBib2R5Lm5hbWUgPT09ICdzdHJpbmcnID8gYm9keS5uYW1lLnRyaW0oKSA6ICcnO1xuICAgICAgICBpZiAoIWZha2VQcm92aWRlcnMuaGFzKG5hbWUpKSB7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3Byb3ZpZGVyIG5vdCBmb3VuZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBmYWtlQ2hhdFByb3ZpZGVyID0gbmFtZTtcbiAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlLCBtb2RlbDogZmFrZVByb3ZpZGVycy5nZXQobmFtZSk/Lm1vZGVsIH0pKTtcbiAgICAgIH0pKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS90YXNrJykge1xuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7IHRleHQ/OiB1bmtub3duOyBzZXNzaW9uSWQ/OiB1bmtub3duOyBtb2RlPzogdW5rbm93bjsgYXR0YWNobWVudHM/OiB1bmtub3duOyBpbWFnZXM/OiB1bmtub3duIH07XG4gICAgICAgICAgY29uc3QgdGV4dCA9IHR5cGVvZiBib2R5LnRleHQgPT09ICdzdHJpbmcnID8gYm9keS50ZXh0IDogJyc7XG4gICAgICAgICAgY29uc3Qgc2Vzc2lvbklkID0gdHlwZW9mIGJvZHkuc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IGJvZHkuc2Vzc2lvbklkIDogYHdlYi0ke0RhdGUubm93KCkudG9TdHJpbmcoMzYpfWA7XG4gICAgICAgICAgY29uc3QgbW9kZSA9IGJvZHkubW9kZSA9PT0gJ2FzaycgfHwgYm9keS5tb2RlID09PSAnYXV0bycgfHwgYm9keS5tb2RlID09PSAneW9sbycgPyBib2R5Lm1vZGUgOiAnYXNrJztcbiAgICAgICAgICBjb25zdCBhdHRhY2htZW50cyA9IEFycmF5LmlzQXJyYXkoYm9keS5hdHRhY2htZW50cykgPyBib2R5LmF0dGFjaG1lbnRzLmZpbHRlcigoYSk6IGEgaXMgc3RyaW5nID0+IHR5cGVvZiBhID09PSAnc3RyaW5nJykgOiBbXTtcbiAgICAgICAgICAvLyBcdTU2RkVcdTcyNDdcdTk2NDRcdTRFRjY6XHU0RTBFIGhtaGFybmVzcyB2aXNpb24gXHU1MzRGXHU4QkFFXHU1NDBDXHU1RjYyKHtuYW1lLGRhdGFVcmx9KTtmYWtlIFx1NjgyMVx1OUE4Q1x1NUY2Mlx1NzJCNlx1NTM3M1x1NjUzNlxuICAgICAgICAgIGNvbnN0IGltYWdlcyA9IEFycmF5LmlzQXJyYXkoYm9keS5pbWFnZXMpXG4gICAgICAgICAgICA/IGJvZHkuaW1hZ2VzLmZpbHRlcigoaW0pOiBpbSBpcyB7IG5hbWU6IHN0cmluZzsgZGF0YVVybDogc3RyaW5nIH0gPT4ge1xuICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgaW0gIT09ICdvYmplY3QnIHx8IGltID09PSBudWxsKSByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICAgICAgY29uc3QgbyA9IGltIGFzIHsgbmFtZT86IHVua25vd247IGRhdGFVcmw/OiB1bmtub3duIH07XG4gICAgICAgICAgICAgICAgcmV0dXJuIHR5cGVvZiBvLm5hbWUgPT09ICdzdHJpbmcnICYmIHR5cGVvZiBvLmRhdGFVcmwgPT09ICdzdHJpbmcnICYmIG8uZGF0YVVybC5zdGFydHNXaXRoKCdkYXRhOmltYWdlLycpO1xuICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgOiBbXTtcbiAgICAgICAgICBpZiAoIXRleHQpIHtcbiAgICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3RleHQgcmVxdWlyZWQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8gXHU0RTBFIGhtaGFybmVzcyBcdTU0MENcdThCRURcdTRFNDk6XHU1NDA4XHU2Q0Q1XHU5NjQ0XHU0RUY2XHU0RUU1IFtyZWZlcmVuY2VkIGZpbGVzXSBcdTUyNERcdTdGMDBcdTVFNzZcdTUxNjVcdTRFRkJcdTUyQTFcdTY1ODdcdTY3MkM7XG4gICAgICAgICAgLy8gXHU1NkZFXHU3MjQ3XHU0RUU1IFtpbWFnZXNdIFx1NTI0RFx1N0YwMFx1NjgwN1x1NkNFOFx1NUYyMFx1NjU3MCh2aXNpb24gXHU2M0NGXHU4RkYwXHU5NEZFXHU1NzI4XHU3NzFGXHU1QjlFIHJ1bnRpbWUgXHU5MUNDXHU1M0QxXHU3NTFGKVxuICAgICAgICAgIGNvbnN0IGNvbXBvc2VkID0gYXR0YWNobWVudHMubGVuZ3RoID4gMFxuICAgICAgICAgICAgPyBgW3JlZmVyZW5jZWQgZmlsZXNdXFxuJHthdHRhY2htZW50cy5tYXAoKGEpID0+IGAtICR7YS5zcGxpdCgvW1xcXFwvXS8pLnBvcCgpfWApLmpvaW4oJ1xcbicpfVxcblxcbiR7dGV4dH1gXG4gICAgICAgICAgICA6IHRleHQ7XG4gICAgICAgICAgY29uc3Qgd2l0aEltYWdlcyA9IGltYWdlcy5sZW5ndGggPiAwID8gYFtpbWFnZXM6ICR7aW1hZ2VzLmxlbmd0aH1dXFxuJHtjb21wb3NlZH1gIDogY29tcG9zZWQ7XG4gICAgICAgICAgY29uc3QgcnVuSWQgPSBydW5UYXNrKHNlc3Npb25JZCwgd2l0aEltYWdlcywgbW9kZSk7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIHJ1bklkLCBpbWFnZXM6IGltYWdlcy5sZW5ndGggfSkpO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCBTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgfVxuICAgICAgfSkoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2FwcHJvdmUnKSB7XG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7IGdyYW50ZWQ/OiB1bmtub3duOyBzZXNzaW9uSWQ/OiB1bmtub3duIH07XG4gICAgICAgIGNvbnN0IHNpZCA9IHR5cGVvZiBib2R5LnNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBib2R5LnNlc3Npb25JZCA6ICcnO1xuICAgICAgICBpZiAocGVuZGluZyA9PT0gbnVsbCB8fCAoc2lkICE9PSAnJyAmJiBwZW5kaW5nLnNlc3Npb25JZCAhPT0gc2lkKSkge1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICdubyBhcHByb3ZhbCBwZW5kaW5nJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHAgPSBwZW5kaW5nO1xuICAgICAgICBwZW5kaW5nID0gbnVsbDtcbiAgICAgICAgcC5yZXNvbHZlKGJvZHkuZ3JhbnRlZCA9PT0gdHJ1ZSk7XG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgZ3JhbnRlZDogYm9keS5ncmFudGVkID09PSB0cnVlIH0pKTtcbiAgICAgIH0pKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lLnN0YXJ0c1dpdGgoJy9hcGkvc2Vzc2lvbnMvJykgJiYgKHVybC5wYXRobmFtZS5lbmRzV2l0aCgnL2FyY2hpdmUnKSB8fCB1cmwucGF0aG5hbWUuZW5kc1dpdGgoJy9kZWxldGUnKSkpIHtcbiAgICAgIC8vIFx1NEYxQVx1OEJERFx1NUY1Mlx1Njg2My9cdTUyMjBcdTk2NjQoaG1oYXJuZXNzIFx1NTQwQ1x1NUY2MjpcdTc5RkJcdTUxNjUgYXJjaGl2ZS90cmFzaCxcdTUzRUZcdTYwNjJcdTU5MEQsXHU0RTBEXHU3ODZDXHU1MjIwKVxuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCBwYXJ0cyA9IHVybC5wYXRobmFtZS5zbGljZSgnL2FwaS9zZXNzaW9ucy8nLmxlbmd0aCkuc3BsaXQoJy8nKTtcbiAgICAgICAgY29uc3Qgb3AgPSBwYXJ0c1sxXSA/PyAnJztcbiAgICAgICAgY29uc3Qgb2lkID0gZGVjb2RlVVJJQ29tcG9uZW50KHBhcnRzWzBdID8/ICcnKS5yZXBsYWNlKC9bXmEtekEtWjAtOV86LkAtXS9nLCAnJyk7XG4gICAgICAgIGlmIChvaWQgPT09ICcnIHx8IChvcCAhPT0gJ2FyY2hpdmUnICYmIG9wICE9PSAnZGVsZXRlJykpIHtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnYmFkIG9wJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGlmICghc2Vzc2lvbnMuaGFzKG9pZCkpIHtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnc2Vzc2lvbiBub3QgZm91bmQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgc2Vzc2lvbnMuZGVsZXRlKG9pZCk7XG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSB9KSk7XG4gICAgICB9KSgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvaW5qZWN0Jykge1xuICAgICAgLy8gXHU4RkQwXHU4ODRDXHU0RTJEXHU2Q0U4XHU1MTY1KFx1NEUwRSBobWhhcm5lc3MgL2FwaS9pbmplY3QgXHU1NDBDXHU1RjYyO2Zha2UgXHU1M0VBXHU1NkRFXHU2MjY3KVxuICAgICAgdm9pZCByZWFkQm9keSgpO1xuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9pbnRlcnJ1cHQnKSB7XG4gICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgnJykgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47IC8vIGludGVycnVwdCBcdTY1RTAgYm9keSBcdThCRURcdTRFNDlcbiAgICAgIHZvaWQgYm9keTtcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUgfSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9zZXNzaW9ucycpIHtcbiAgICAgIGNvbnN0IGxpc3QgPSBbLi4uc2Vzc2lvbnMudmFsdWVzKCldLm1hcCgocykgPT4gKHtcbiAgICAgICAgaWQ6IHMuaWQsIHRpdGxlOiAnJywgdGFzazogJycsIG91dGNvbWU6ICdvaycsIHR1cm5zOiAxLCB0b29sVXNlczogMSxcbiAgICAgICAgdGltZTogcy51cGRhdGVkQXQsIGN3ZDogJ0M6XFxcXGRlbW8nLCBicmFuY2g6ICcnLCBjcmVhdGVkQXQ6IHMuY3JlYXRlZEF0LCB1cGRhdGVkQXQ6IHMudXBkYXRlZEF0LFxuICAgICAgfSkpO1xuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBzZXNzaW9uczogbGlzdCwgbmV4dEN1cnNvcjogbnVsbCB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUuc3RhcnRzV2l0aCgnL2FwaS9zZXNzaW9ucy8nKSkge1xuICAgICAgY29uc3Qgc2VnID0gZGVjb2RlVVJJQ29tcG9uZW50KHVybC5wYXRobmFtZS5zbGljZSgnL2FwaS9zZXNzaW9ucy8nLmxlbmd0aCkpO1xuICAgICAgLy8gXHU1QkZDXHU1MUZBKFx1NEUwRSBobWhhcm5lc3MgL2FwaS9zZXNzaW9ucy86aWQvZXhwb3J0Lm1kIFx1NTQwQ1x1NUY2Mjp0ZXh0L21hcmtkb3duIFx1NEUwQlx1OEY3RClcbiAgICAgIGNvbnN0IGV4cG9ydE1hdGNoID0gL14oLiopXFwvZXhwb3J0XFwubWQkLy5leGVjKHNlZykgPz8gL14oLiopXFwuZXhwb3J0XFwubWQkLy5leGVjKHNlZyk7XG4gICAgICBpZiAoZXhwb3J0TWF0Y2ggIT09IG51bGwgJiYgZXhwb3J0TWF0Y2hbMV0gIT09IHVuZGVmaW5lZCAmJiBleHBvcnRNYXRjaFsxXSAhPT0gJycpIHtcbiAgICAgICAgY29uc3QgZWlkID0gZXhwb3J0TWF0Y2hbMV0ucmVwbGFjZSgvW15hLXpBLVowLTlfOi5ALV0vZywgJycpO1xuICAgICAgICBjb25zdCBlcyA9IHNlc3Npb25zLmdldChlaWQpO1xuICAgICAgICBpZiAoZXMgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICdzZXNzaW9uIG5vdCBmb3VuZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ3RleHQvbWFya2Rvd247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICByZXMuZW5kKGAjIGhtaGFybmVzcyBcdTRGMUFcdThCRERcdTVCRkNcdTUxRkEoZmFrZSlcXG5cXG4tIFx1NEYxQVx1OEJERDoke2VpZH1cXG5cXG4jIyBcdTc1MjhcdTYyMzdcXG5cXG5cdTRFNEJcdTUyNERcdTc2ODRcdTRFRkJcdTUyQTEoZmFrZSBcdTk4ODRcdTg5QzgpXFxuXFxuIyMgXHU1MkE5XHU2MjRCXFxuXFxuXHU4RkQ5XHU2NjJGXHU1QkZDXHU1MUZBXHU3Njg0XHU1NkRFXHU1OTBEXHU5ODg0XHU4OUM4KGZha2UpXHUzMDAyXFxuYCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIC8vIFx1NEYxQVx1OEJERFx1OTg4NFx1ODlDOChcdTRFMEUgaG1oYXJuZXNzIEdFVCAvYXBpL3Nlc3Npb25zLzppZCBcdTU0MENcdTVGNjI6XHU2NzAwXHU1NDBFIDgwIFx1Njc2MSxcdTZCQ0ZcdTY3NjEgNTAwIFx1NUI1NylcbiAgICAgIGNvbnN0IGlkID0gc2VnLnJlcGxhY2UoL1teYS16QS1aMC05XzouQC1dL2csICcnKTtcbiAgICAgIGNvbnN0IHMgPSBzZXNzaW9ucy5nZXQoaWQpO1xuICAgICAgaWYgKHMgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3Nlc3Npb24gbm90IGZvdW5kJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgaWQsIG1vZGVsOiAnZmFrZS1tb2RlbCcsIGN3ZDogJ0M6XFxcXGRlbW8nLFxuICAgICAgICBtZXNzYWdlczogW1xuICAgICAgICAgIHsgcm9sZTogJ3VzZXInLCB0ZXh0OiAnXHU0RTRCXHU1MjREXHU3Njg0XHU0RUZCXHU1MkExKGZha2UgXHU5ODg0XHU4OUM4KScsIHRvb2xzOiBbXSB9LFxuICAgICAgICAgIHsgcm9sZTogJ2Fzc2lzdGFudCcsIHRleHQ6ICdcdThGRDlcdTY2MkZcdTUzODZcdTUzRjJcdTRGMUFcdThCRERcdTc2ODRcdTU2REVcdTU5MERcdTk4ODRcdTg5QzgoZmFrZSlcdTMwMDInLCB0b29sczogWydyZWFkX2ZpbGUnXSB9LFxuICAgICAgICBdLFxuICAgICAgfSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9mcycpIHtcbiAgICAgIC8vIFx1NzZFRVx1NUY1NVx1NkQ0Rlx1ODlDOChcdTRFMEUgaG1oYXJuZXNzIFx1NTQwQ1x1NUY2MjpwYXRoIFx1NzcwMVx1NzU2NT1cdTY4Mzk7ZmlsZXM9MSBcdTk2NDRcdTVFMjZcdTY1ODdcdTRFRjZcdTUyMTdcdTg4NjgpXG4gICAgICBjb25zdCBxID0gdXJsLnNlYXJjaFBhcmFtcy5nZXQoJ3BhdGgnKSA/PyAnJztcbiAgICAgIGNvbnN0IHdpdGhGaWxlcyA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KCdmaWxlcycpID09PSAnMSc7XG4gICAgICBpZiAocSA9PT0gJycpIHtcbiAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgcGF0aDogJycsIHNlZ21lbnRzOiBbXSwgcGFyZW50OiAnJyxcbiAgICAgICAgICBkaXJzOiBbeyBuYW1lOiAnZGVtby13b3Jrc3BhY2UnLCBwYXRoOiAnQzpcXFxcZGVtbycgfV0sXG4gICAgICAgICAgLi4uKHdpdGhGaWxlcyA/IHsgZmlsZXM6IFtdIH0gOiB7fSksXG4gICAgICAgIH0pKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBwYXRoOiBxLCBzZWdtZW50czogW3sgbmFtZTogcS5zcGxpdCgvW1xcXFwvXS8pLmZpbHRlcihCb29sZWFuKS5wb3AoKSA/PyBxLCBwYXRoOiBxIH1dLCBwYXJlbnQ6ICcnLFxuICAgICAgICBkaXJzOiBbeyBuYW1lOiAnc3JjJywgcGF0aDogYCR7cS5yZXBsYWNlKC9bXFxcXC9dJC8sICcnKX1cXFxcc3JjYCB9XSxcbiAgICAgICAgLi4uKHdpdGhGaWxlcyA/IHsgZmlsZXM6IFtcbiAgICAgICAgICB7IG5hbWU6ICdSRUFETUUubWQnLCBwYXRoOiBgJHtxLnJlcGxhY2UoL1tcXFxcL10kLywgJycpfVxcXFxSRUFETUUubWRgLCByZWw6ICdSRUFETUUubWQnIH0sXG4gICAgICAgICAgeyBuYW1lOiAncGFja2FnZS5qc29uJywgcGF0aDogYCR7cS5yZXBsYWNlKC9bXFxcXC9dJC8sICcnKX1cXFxccGFja2FnZS5qc29uYCwgcmVsOiAncGFja2FnZS5qc29uJyB9LFxuICAgICAgICBdIH0gOiB7fSksXG4gICAgICB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2ZzL3JlYWQnKSB7XG4gICAgICAvLyBcdTY1ODdcdTRFRjZcdTk4ODRcdTg5QzgoNjRLQiBcdTRFMEFcdTk2NTBcdThCRURcdTRFNDk7ZmFrZSBcdThGRDRcdTU2REVcdTU2RkFcdTVCOUFcdTY1ODdcdTY3MkMpXG4gICAgICBjb25zdCBwID0gdXJsLnNlYXJjaFBhcmFtcy5nZXQoJ3BhdGgnKSA/PyAnJztcbiAgICAgIGlmIChwID09PSAnJykge1xuICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3BhdGggcmVxdWlyZWQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBwYXRoOiBwLCByZWw6IHAuc3BsaXQoL1tcXFxcL10vKS5wb3AoKSA/PyBwLCBzaXplOiA0MixcbiAgICAgICAgdGV4dDogJyMgZGVtbyB3b3Jrc3BhY2VcXG5cXG5cdThGRDlcdTY2MkYgZmFrZSBob3N0IFx1NzY4NFx1NjU4N1x1NEVGNlx1OTg4NFx1ODlDOFx1NTE4NVx1NUJCOVx1MzAwMlxcbicsXG4gICAgICB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2RpZmYnKSB7XG4gICAgICAvLyBEaWZmIFx1OTc2Mlx1Njc3RihcdTRFMEUgaG1oYXJuZXNzIC9hcGkvZGlmZiBcdTU0MENcdTVGNjI7ZmFrZSBcdThGRDRcdTU2REVcdTU2RkFcdTVCOUFcdTVDMEZcdTUzRDhcdTY2RjRcdTk2QzYpXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIGdpdDogdHJ1ZSwgY3dkOiAnQzpcXFxcZGVtbycsXG4gICAgICAgIGNoYW5nZWQ6IFtcbiAgICAgICAgICB7IHN0YXRlOiAnTScsIHBhdGg6ICdzcmMvYXBwLnRzJyB9LFxuICAgICAgICAgIHsgc3RhdGU6ICdBJywgcGF0aDogJ2RvY3Mvbm90ZXMubWQnIH0sXG4gICAgICAgIF0sXG4gICAgICAgIHN0YXQ6ICcgc3JjL2FwcC50cyAgICAgIHwgMTIgKysrKysrKy0tLVxcbiBkb2NzL25vdGVzLm1kICAgfCAgNCArKysrXFxuIDIgZmlsZXMgY2hhbmdlZCwgMTYgaW5zZXJ0aW9ucygrKSwgMyBkZWxldGlvbnMoLSknLFxuICAgICAgfSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS93b3Jrc3BhY2VzJykge1xuICAgICAgLy8gXHU1REU1XHU0RjVDXHU1MzNBKFx1NEUwRSBobWhhcm5lc3MgXHU1NDBDXHU1RjYyOmN1cnJlbnQgKyBpdGVtcylcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgY3VycmVudDogZmFrZVdvcmtzcGFjZXMuY3VycmVudCxcbiAgICAgICAgaXRlbXM6IGZha2VXb3Jrc3BhY2VzLml0ZW1zLFxuICAgICAgfSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvd29ya3NwYWNlcycpIHtcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoKGF3YWl0IHJlYWRCb2R5KCkpIHx8ICd7fScpIGFzIHsgbmFtZT86IHVua25vd247IHBhdGg/OiB1bmtub3duIH07XG4gICAgICAgIGNvbnN0IHBhdGggPSB0eXBlb2YgYm9keS5wYXRoID09PSAnc3RyaW5nJyA/IGJvZHkucGF0aCA6ICcnO1xuICAgICAgICBjb25zdCBuYW1lID0gdHlwZW9mIGJvZHkubmFtZSA9PT0gJ3N0cmluZycgJiYgYm9keS5uYW1lICE9PSAnJyA/IGJvZHkubmFtZSA6IChwYXRoLnNwbGl0KC9bXFxcXC9dLykuZmlsdGVyKEJvb2xlYW4pLnBvcCgpID8/ICcnKTtcbiAgICAgICAgaWYgKHBhdGggPT09ICcnIHx8IG5hbWUgPT09ICcnKSB7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ2Fic29sdXRlIHBhdGggYW5kIG5hbWUgcmVxdWlyZWQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGZha2VXb3Jrc3BhY2VzLml0ZW1zLnNvbWUoKHcpID0+IHcucGF0aC50b0xvd2VyQ2FzZSgpID09PSBwYXRoLnRvTG93ZXJDYXNlKCkpKSB7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDksIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3dvcmtzcGFjZSBhbHJlYWR5IHJlZ2lzdGVyZWQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgaXRlbSA9IHsgaWQ6IGB3cy0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDgpfWAsIG5hbWUsIHBhdGggfTtcbiAgICAgICAgZmFrZVdvcmtzcGFjZXMuaXRlbXMucHVzaChpdGVtKTtcbiAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlLCBjdXJyZW50OiBmYWtlV29ya3NwYWNlcy5jdXJyZW50LCBpdGVtczogZmFrZVdvcmtzcGFjZXMuaXRlbXMgfSkpO1xuICAgICAgfSkoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3dvcmtzcGFjZXMvdXNlJykge1xuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgoYXdhaXQgcmVhZEJvZHkoKSkgfHwgJ3t9JykgYXMgeyBpZD86IHVua25vd24gfTtcbiAgICAgICAgY29uc3QgaGl0ID0gZmFrZVdvcmtzcGFjZXMuaXRlbXMuZmluZCgodykgPT4gdy5pZCA9PT0gYm9keS5pZCk7XG4gICAgICAgIGlmIChoaXQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICd3b3Jrc3BhY2Ugbm90IGZvdW5kJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGZha2VXb3Jrc3BhY2VzLmN1cnJlbnQgPSBoaXQuaWQ7XG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgY3VycmVudDogZmFrZVdvcmtzcGFjZXMuY3VycmVudCwgaXRlbXM6IGZha2VXb3Jrc3BhY2VzLml0ZW1zIH0pKTtcbiAgICAgIH0pKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9wcm92aWRlcnMnKSB7XG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7IG5hbWU/OiB1bmtub3duOyBiYXNlVXJsPzogdW5rbm93bjsgbW9kZWw/OiB1bmtub3duOyBhcGlLZXk/OiB1bmtub3duIH07XG4gICAgICAgIGNvbnN0IG5hbWUgPSB0eXBlb2YgYm9keS5uYW1lID09PSAnc3RyaW5nJyA/IGJvZHkubmFtZS50cmltKCkgOiAnJztcbiAgICAgICAgY29uc3QgYmFzZVVybCA9IHR5cGVvZiBib2R5LmJhc2VVcmwgPT09ICdzdHJpbmcnID8gYm9keS5iYXNlVXJsLnRyaW0oKSA6ICcnO1xuICAgICAgICBjb25zdCBtb2RlbCA9IHR5cGVvZiBib2R5Lm1vZGVsID09PSAnc3RyaW5nJyA/IGJvZHkubW9kZWwudHJpbSgpIDogJyc7XG4gICAgICAgIGlmIChuYW1lID09PSAnJyB8fCBiYXNlVXJsID09PSAnJyB8fCBtb2RlbCA9PT0gJycpIHtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnbmFtZSwgYmFzZVVybCBhbmQgbW9kZWwgYXJlIHJlcXVpcmVkJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGZha2VQcm92aWRlcnMuc2V0KG5hbWUsIHsgYmFzZVVybCwgbW9kZWwsIGFwaUtleTogdHlwZW9mIGJvZHkuYXBpS2V5ID09PSAnc3RyaW5nJyA/IGJvZHkuYXBpS2V5IDogJycgfSk7XG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgbmFtZSB9KSk7XG4gICAgICB9KSgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9mcy9zZWFyY2gnKSB7XG4gICAgICAvLyBcdTVERTVcdTRGNUNcdTUzM0FcdTY1ODdcdTRFRjZcdTY0MUNcdTdEMjIoXHU0RTBFIGhtaGFybmVzcyBcdTU0MENcdTVGNjI6QFx1OTY0NFx1NEVGNlx1OTAwOVx1NjJFOVx1NTY2OFx1NzY4NFx1NjU3MFx1NjM2RVx1NkU5MClcbiAgICAgIGNvbnN0IHEgPSAodXJsLnNlYXJjaFBhcmFtcy5nZXQoJ3EnKSA/PyAnJykudHJpbSgpLnRvTG93ZXJDYXNlKCk7XG4gICAgICBjb25zdCBhbGwgPSBbXG4gICAgICAgIHsgcmVsOiAnUkVBRE1FLm1kJywgcGF0aDogJ0M6XFxcXGRlbW9cXFxcUkVBRE1FLm1kJywga2luZDogJ2ZpbGUnIH0sXG4gICAgICAgIHsgcmVsOiAnc3JjL2FwcC50cycsIHBhdGg6ICdDOlxcXFxkZW1vXFxcXHNyY1xcXFxhcHAudHMnLCBraW5kOiAnZmlsZScgfSxcbiAgICAgICAgeyByZWw6ICdkb2NzL25vdGVzLm1kJywgcGF0aDogJ0M6XFxcXGRlbW9cXFxcZG9jc1xcXFxub3Rlcy5tZCcsIGtpbmQ6ICdmaWxlJyB9LFxuICAgICAgXTtcbiAgICAgIGNvbnN0IGhpdHMgPSBxID09PSAnJyA/IGFsbCA6IGFsbC5maWx0ZXIoKGYpID0+IGYucmVsLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMocSkpO1xuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyByZXN1bHRzOiBoaXRzLnNsaWNlKDAsIDIwKSwgdHJ1bmNhdGVkOiBmYWxzZSwgdG90YWw6IGhpdHMubGVuZ3RoIH0pKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvY29nbml0aXZlJykge1xuICAgICAgLy8gXHU4QkE0XHU3N0U1XHU3MkI2XHU2MDAxKFx1NEUwRSBobWhhcm5lc3MgY29nbml0aXZlU3RhdHVzIFx1NTQwQ1x1NUY2Mlx1NUI1MFx1OTZDNjtcdTdGM0FcdTY1NzBcdTYzNkVcdTY2M0VcdTVGMEYgbnVsbClcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgbWVtb3J5OiB7IGxheWVyczogMywgZW50cmllczogMTIsIGNvbnRyYWRpY3Rpb25zOiAwIH0sXG4gICAgICAgIHRyYWplY3RvcmllczogNyxcbiAgICAgICAgYXVkaXRFdmVudHM6IDIxLFxuICAgICAgICB3b3JsZE1vZGVsOiB7IHZlcnNpb246IDQsIGJlbGllZnM6IDksIHRydXN0ZWQ6IDUsIGJyaWVyOiAwLjMxIH0sXG4gICAgICAgIGNhbGlicmF0aW9uOiB7IHByZWRpY3Rpb25zOiA0NiwgcmVsaWFiaWxpdHk6IDAuNzIgfSxcbiAgICAgIH0pKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2Zha2UvZW1pdCcpIHtcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgoYXdhaXQgcmVhZEJvZHkoKSkgfHwgJ3t9JykgYXMge1xuICAgICAgICAgICAgc2Vzc2lvbklkOiBzdHJpbmc7IHJ1bklkOiBzdHJpbmc7IGtpbmQ6IEV2ZW50S2luZDsgcGF5bG9hZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICAgICAgfTtcbiAgICAgICAgICBjb25zdCBzZXEgPSBlbWl0KGJvZHkuc2Vzc2lvbklkLCBib2R5LnJ1bklkLCBib2R5LmtpbmQsIGJvZHkucGF5bG9hZCk7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIHNlcSB9KSk7XG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsIFN0cmluZyhlcnIpLnNsaWNlKDAsIDEyMCksIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICB9XG4gICAgICB9KSgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCBgbm8gcm91dGUgJHtyZXEubWV0aG9kfSAke3VybC5wYXRobmFtZX1gLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgfSk7XG5cbiAgYXdhaXQgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgIHNlcnZlci5vbmNlKCdlcnJvcicsIHJlamVjdCk7XG4gICAgc2VydmVyLmxpc3RlbigwLCAnMTI3LjAuMC4xJywgKCkgPT4gcmVzb2x2ZSgpKTtcbiAgfSk7XG4gIGNvbnN0IGFkZHJlc3MgPSBzZXJ2ZXIuYWRkcmVzcygpO1xuICBpZiAoYWRkcmVzcyA9PT0gbnVsbCB8fCB0eXBlb2YgYWRkcmVzcyAhPT0gJ29iamVjdCcpIHRocm93IG5ldyBFcnJvcignZmFrZSBob3N0OiBubyBwb3J0Jyk7XG4gIGNvbnN0IHBvcnQgPSBhZGRyZXNzLnBvcnQ7XG5cbiAgaWYgKCFvcHRzLnF1aWV0KSB7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7SlNPTi5zdHJpbmdpZnkoeyBobWhEZXNrdG9wSG9zdFJlYWR5OiB0cnVlLCBwb3J0LCB2ZXJzaW9uOiAnZmFrZS0wLjAuMCcgfSl9XFxuYCk7XG4gIH1cbiAgY29uc3QgZGllQWZ0ZXIgPSBOdW1iZXIocHJvY2Vzcy5lbnYuRkFLRV9IT1NUX0RJRV9BRlRFUl9NUyA/PyAwKTtcbiAgaWYgKE51bWJlci5pc0Zpbml0ZShkaWVBZnRlcikgJiYgZGllQWZ0ZXIgPiAwKSB7XG4gICAgc2V0VGltZW91dCgoKSA9PiBwcm9jZXNzLmV4aXQoMSksIGRpZUFmdGVyKS51bnJlZigpO1xuICB9XG5cbiAgLy8gY2xvc2UoKTogXHU1MTQ4XHU2NUFEXHU1RjAwXHU1MTY4XHU5MEU4IFNTRSBcdThGREVcdTYzQTUoXHU1QjgzXHU0RUVDXHU2QzM4XHU0RTBEXHU4MUVBXHU3MTM2XHU1MTczXHU5NUVEKSxcdTU0MjZcdTUyMTkgc2VydmVyLmNsb3NlXG4gIC8vIFx1NEYxQVx1NEUwMFx1NzZGNFx1N0I0OVx1NkQzQlx1OERDM1x1OEZERVx1NjNBNSxcdTZENEJcdThCRDVcdThGREJcdTdBMEJcdTYzMDJcdTZCN0JcdTMwMDJcbiAgY29uc3QgY2xvc2UgPSAoKTogUHJvbWlzZTx2b2lkPiA9PlxuICAgIG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlKSA9PiB7XG4gICAgICBmb3IgKGNvbnN0IGMgb2Ygc3NlQ2xpZW50cykge1xuICAgICAgICB0cnkgeyBjLmVuZCgpOyBjLmRlc3Ryb3koKTsgfSBjYXRjaCB7IC8qIGFscmVhZHkgZ29uZSAqLyB9XG4gICAgICB9XG4gICAgICBzc2VDbGllbnRzLmNsZWFyKCk7XG4gICAgICBzZXJ2ZXIuY2xvc2UoKCkgPT4gcmVzb2x2ZSgpKTtcbiAgICAgIHNldFRpbWVvdXQoKCkgPT4gcmVzb2x2ZSgpLCAxXzAwMCkudW5yZWYoKTtcbiAgICB9KTtcblxuICByZXR1cm4geyBwb3J0LCBlbWl0LCBjbG9zZSB9O1xufVxuXG4vLyBcdTc2RjRcdTYzQTVcdThGRDBcdTg4NEMoc3VwZXJ2aXNvciBzcGF3biBcdTc2ODRcdTVCNTBcdThGREJcdTdBMEJcdTVGNjJcdTYwMDEpXHUzMDAycmVhbHBhdGggXHU2QkQ0XHU4RjgzOm5wbSB3b3Jrc3BhY2Vcbi8vIGp1bmN0aW9uIC8gXHU1OTI3XHU1QzBGXHU1MTk5XHU1REVFXHU1RjAyXHU5MEZEXHU0RTBEXHU4MEZEXHU4QkE5XHU4RkQ5XHU0RTJBXHU2OEMwXHU2RDRCXHU1OTMxXHU2MjRCKFx1NTkzMVx1NjI0Qj1cdTk3NTlcdTlFRDhcdTkwMDBcdTUxRkEgY29kZSAwLFx1OTZCRVx1NjdFNSlcdTMwMDJcbi8vIGNqcyBidW5kbGUoZXNidWlsZCxcdTYyNTNcdTUzMDVcdTRFQTdcdTU0QzEpXHU0RTBCIF9fZmlsZW5hbWUgXHU1QjU4XHU1NzI4O0VTTSh0c3gvXHU2RTkwXHU3ODAxKVx1NzUyOCBpbXBvcnQubWV0YVx1MzAwMlxuY29uc3Qgc2VsZlVybDogc3RyaW5nID0gdHlwZW9mIF9fZmlsZW5hbWUgPT09ICdzdHJpbmcnXG4gID8gcGF0aFRvRmlsZVVSTChyZWFscGF0aFN5bmMoX19maWxlbmFtZSkpLmhyZWZcbiAgOiBpbXBvcnQubWV0YS51cmw7XG5jb25zdCBpbnZva2VkQXNTY3JpcHQgPSAoKCkgPT4ge1xuICBpZiAocHJvY2Vzcy5hcmd2WzFdID09PSB1bmRlZmluZWQpIHJldHVybiBmYWxzZTtcbiAgdHJ5IHtcbiAgICByZXR1cm4gc2VsZlVybCA9PT0gcGF0aFRvRmlsZVVSTChyZWFscGF0aFN5bmMocHJvY2Vzcy5hcmd2WzFdKSkuaHJlZjtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59KSgpO1xuaWYgKGludm9rZWRBc1NjcmlwdCkge1xuICBjb25zdCB0b2tlbiA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1RPS0VOID8/ICcnO1xuICAvLyBGQUtFX0hPU1RfRElFX0FUX0JPT1Q9MTpcdTVGMTVcdTVCRkNcdTg4NENcdThGOTNcdTUxRkFcdTUyNERcdTUzNzNcdTZCN0IoXHU2Nzg0XHU5MDIwXHU1NDJGXHU1MkE4XHU2NzFGIFJVTlRJTUVfQ1JBU0hFRClcbiAgaWYgKHByb2Nlc3MuZW52LkZBS0VfSE9TVF9ESUVfQVRfQk9PVCA9PT0gJzEnKSB7XG4gICAgcHJvY2Vzcy5leGl0KDEpO1xuICB9XG4gIGNvbnN0IHNsb3cgPSBOdW1iZXIocHJvY2Vzcy5lbnYuRkFLRV9IT1NUX1NMT1dfQUZURVIgPz8gMCk7XG4gIGNvbnN0IGJvb3QgPSAoKTogdm9pZCA9PiB7XG4gICAgdm9pZCBzdGFydEZha2VIb3N0KHsgdG9rZW4gfSkuY2F0Y2goKGVycikgPT4ge1xuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYGZha2UtaG9zdCBmYWlsZWQ6ICR7U3RyaW5nKGVycil9XFxuYCk7XG4gICAgICBwcm9jZXNzLmV4aXQoMSk7XG4gICAgfSk7XG4gIH07XG4gIGlmIChOdW1iZXIuaXNGaW5pdGUoc2xvdykgJiYgc2xvdyA+IDApIHNldFRpbWVvdXQoYm9vdCwgc2xvdyk7XG4gIGVsc2UgYm9vdCgpO1xufVxuIiwgIi8qKlxuICogVUlWRVJJRlkgXHU5NEE5XHU1QjUwIFx1MjAxNFx1MjAxNCBcdTkwMTBcdTUyOUZcdTgwRkRcdTc3MUZcdTVCOUUgVUkgXHU5QTcxXHU1MkE4XHU5QThDXHU2NTM2KDIwMjYtMTAtMTAgXHU3NTI4XHU2MjM3XHU2MzA3XHU0RUU0OlxuICogXCJcdTVCRjlcdTZCQ0ZcdTRFMDBcdTRFMkFcdTUyOUZcdTgwRkQsXHU2QkNGXHU0RTAwXHU0RTJBXHU0RTFBXHU1MkExXHU2RDQxXHU3QTBCXHU1MTY4XHU5NzYyXHU3Njg0XHU5QThDXHU2NTM2XCIpXHUzMDAyXG4gKlxuICogXHU3NkY0XHU2M0E1XHU1QkY5XHU2RTMyXHU2N0QzXHU1NDBFXHU3Njg0IERPTSBcdTY1QURcdThBMDAoXHU1RTAzXHU1QzQwXHU1MUUwXHU0RjU1L1x1NTNFRlx1ODlDMVx1NjAyNyksXHU1RTc2XHU3NTI4XHU1MzlGXHU3NTFGXHU0RThCXHU0RUY2XHU5QTcxXHU1MkE4IFJlYWN0XG4gKiAoXHU1M0Q3XHU2M0E3XHU4RjkzXHU1MTY1XHU3NTI4XHU1MzlGXHU1NzhCIHNldHRlciArIGlucHV0IFx1NEU4Qlx1NEVGNjtcdTYzMDlcdTk0QUUgY2xpY2s7XHU5NTJFXHU3NkQ4XHU4RDcwIHdpbmRvd1xuICoga2V5ZG93bilcdTMwMDJmYWtlIFx1NkEyMVx1NUYwRlx1OEREMVx1NUI4Q1x1NjU3NFx1NEVGQlx1NTJBMVx1OTRGRShcdTUzRDFcdTkwMDFcdTIxOTJcdTVERTVcdTUxNzdcdTIxOTJcdTVCQTFcdTYyNzlcdTIxOTJcdTRFQTRcdTRFRDhcdTcyNjlcdTIxOTJcdTZDNDdcdTYwM0IpO1xuICogcmVhbCBcdTZBMjFcdTVGMEZcdTUzRUFcdThERDFcdTUzRUFcdThCRkJcdTVCNTBcdTk2QzYoXHU0RTBEXHU1MkE4XHU3NzFGXHU1QjlFXHU0RjFBXHU4QkREXHUzMDAxXHU0RTBEXHU3MEU3IHRva2VuKVx1MzAwMlxuICogXHU2QkNGXHU2QjY1XHU4RjkzXHU1MUZBIGBVSVZFUklGWSBQQVNTfEZBSUwgbmFtZSB8IGRldGFpbGAsXHU3RUQzXHU1QzNFIFNVTU1BUlksZXhpdCBjb2RlXHUzMDAyXG4gKi9cbmltcG9ydCB7IGFwcCwgdHlwZSBCcm93c2VyV2luZG93IH0gZnJvbSAnZWxlY3Ryb24nO1xuaW1wb3J0IHsgbWtkaXIsIHdyaXRlRmlsZSB9IGZyb20gJ25vZGU6ZnMvcHJvbWlzZXMnO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gJ25vZGU6cGF0aCc7XG5cbmNvbnN0IHNsZWVwID0gKG1zOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+ID0+IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIG1zKSk7XG5cbmFzeW5jIGZ1bmN0aW9uIHJ1blVpVmVyaWZ5KHdpbjogQnJvd3NlcldpbmRvdywgbW9kZTogJ2Zha2UnIHwgJ3JlYWwnKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHNob3RzID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfU0hPVFMgPz8gam9pbihhcHAuZ2V0UGF0aCgndGVtcCcpLCAnaG1oLXVpdmVyaWZ5Jyk7XG4gIGF3YWl0IG1rZGlyKHNob3RzLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KS5jYXRjaCgoKSA9PiB1bmRlZmluZWQpO1xuICBjb25zdCByZXN1bHRzOiBBcnJheTxbc3RyaW5nLCBib29sZWFuLCBzdHJpbmddPiA9IFtdO1xuICBsZXQgc2hvdElkeCA9IDA7XG5cbiAgY29uc3QganMgPSA8VD4oY29kZTogc3RyaW5nKTogUHJvbWlzZTxUPiA9PiB3aW4ud2ViQ29udGVudHMuZXhlY3V0ZUphdmFTY3JpcHQoY29kZSwgdHJ1ZSkgYXMgUHJvbWlzZTxUPjtcbiAgY29uc3Qgc3RlcCA9IGFzeW5jIChuYW1lOiBzdHJpbmcsIGZuOiAoKSA9PiBQcm9taXNlPFtib29sZWFuLCBzdHJpbmddPik6IFByb21pc2U8dm9pZD4gPT4ge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBbb2ssIGRldGFpbF0gPSBhd2FpdCBmbigpO1xuICAgICAgcmVzdWx0cy5wdXNoKFtuYW1lLCBvaywgZGV0YWlsXSk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBjb25zdCBkZXRhaWwgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciAmJiBlcnIuc3RhY2sgIT09IHVuZGVmaW5lZCA/IGVyci5zdGFjayA6IFN0cmluZyhlcnIpO1xuICAgICAgcmVzdWx0cy5wdXNoKFtuYW1lLCBmYWxzZSwgZGV0YWlsLnNsaWNlKDAsIDMwMCldKTtcbiAgICB9XG4gICAgY29uc3QgbGFzdCA9IHJlc3VsdHNbcmVzdWx0cy5sZW5ndGggLSAxXSE7XG4gICAgY29uc29sZS5sb2coYFVJVkVSSUZZICR7bGFzdFsxXSA/ICdQQVNTJyA6ICdGQUlMJ30gfCAke2xhc3RbMF19IHwgJHtsYXN0WzJdfWApO1xuICB9O1xuICAvKiogXHU4RjZFXHU4QkUyXHU3NkY0XHU1MjMwIHByZWRpY2F0ZUNvZGUgXHU4RkQ0XHU1NkRFIHtvazp0cnVlLC4uLn0gXHU2MjE2XHU4RDg1XHU2NUY2KFx1OEZENFx1NTZERVx1NjcwMFx1NTQwRVx1NzY4NCBkZXRhaWwpXHUzMDAyICovXG4gIGNvbnN0IHdhaXRGb3IgPSBhc3luYyAobGFiZWw6IHN0cmluZywgcHJlZGljYXRlQ29kZTogc3RyaW5nLCB0aW1lb3V0TXM6IG51bWJlcik6IFByb21pc2U8W2Jvb2xlYW4sIHN0cmluZ10+ID0+IHtcbiAgICBjb25zdCBzdGFydGVkID0gRGF0ZS5ub3coKTtcbiAgICBmb3IgKDs7KSB7XG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdHJ5IHsgcmV0dXJuIEpTT04uc3RyaW5naWZ5KChmdW5jdGlvbigpeyAke3ByZWRpY2F0ZUNvZGV9IH0pKCkpOyB9IGNhdGNoKGUpeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe29rOmZhbHNlLCBkZXRhaWw6U3RyaW5nKGUpLnNsaWNlKDAsMTIwKX0pOyB9IH0pKClgKSkgYXMgc3RyaW5nO1xuICAgICAgbGV0IHBhcnNlZDogeyBvaz86IGJvb2xlYW47IGRldGFpbD86IHN0cmluZyB9O1xuICAgICAgdHJ5IHsgcGFyc2VkID0gSlNPTi5wYXJzZShyKSBhcyB7IG9rPzogYm9vbGVhbjsgZGV0YWlsPzogc3RyaW5nIH07IH0gY2F0Y2ggeyBwYXJzZWQgPSB7IG9rOiBmYWxzZSwgZGV0YWlsOiBTdHJpbmcocikuc2xpY2UoMCwgMTIwKSB9OyB9XG4gICAgICBpZiAocGFyc2VkLm9rID09PSB0cnVlKSByZXR1cm4gW3RydWUsIFN0cmluZyhwYXJzZWQuZGV0YWlsID8/ICcnKV07XG4gICAgICBpZiAoRGF0ZS5ub3coKSAtIHN0YXJ0ZWQgPiB0aW1lb3V0TXMpIHJldHVybiBbZmFsc2UsIGAke2xhYmVsfTogJHtTdHJpbmcocGFyc2VkLmRldGFpbCA/PyAndGltZW91dCcpfWBdO1xuICAgICAgYXdhaXQgc2xlZXAoMjUwKTtcbiAgICB9XG4gIH07XG4gIGNvbnN0IHNob3QgPSBhc3luYyAobGFiZWw6IHN0cmluZyk6IFByb21pc2U8dm9pZD4gPT4ge1xuICAgIHNob3RJZHggKz0gMTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgaW1nID0gYXdhaXQgd2luLndlYkNvbnRlbnRzLmNhcHR1cmVQYWdlKCk7XG4gICAgICBhd2FpdCB3cml0ZUZpbGUoam9pbihzaG90cywgYCR7bW9kZX0tJHtTdHJpbmcoc2hvdElkeCkucGFkU3RhcnQoMiwgJzAnKX0tJHtsYWJlbH0ucG5nYCksIGltZy50b1BORygpKTtcbiAgICB9IGNhdGNoIHsgLyogXHU2MjJBXHU1NkZFXHU1OTMxXHU4RDI1XHU0RTBEXHU1MjI0XHU2QjdCICovIH1cbiAgfTtcblxuICAvKiAtLS0tIFx1NTNEN1x1NjNBN1x1OEY5M1x1NTE2NShSZWFjdDpcdTUzOUZcdTU3OEIgc2V0dGVyIFx1ODlFNlx1NTNEMSBvbkNoYW5nZSkgLS0tLSAqL1xuICBjb25zdCB0eXBlSW50byA9IChzZWw6IHN0cmluZywgdGV4dDogc3RyaW5nKTogUHJvbWlzZTx1bmtub3duPiA9PlxuICAgIGpzKGAoZnVuY3Rpb24oKXtcbiAgICAgIHZhciBlbCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJHtKU09OLnN0cmluZ2lmeShzZWwpfSk7XG4gICAgICBpZiAoIWVsKSByZXR1cm4gJ05PRUwnO1xuICAgICAgdmFyIHByb3RvID0gZWwudGFnTmFtZSA9PT0gJ1RFWFRBUkVBJyA/IEhUTUxUZXh0QXJlYUVsZW1lbnQucHJvdG90eXBlIDogSFRNTElucHV0RWxlbWVudC5wcm90b3R5cGU7XG4gICAgICBPYmplY3QuZ2V0T3duUHJvcGVydHlEZXNjcmlwdG9yKHByb3RvLCAndmFsdWUnKS5zZXQuY2FsbChlbCwgJHtKU09OLnN0cmluZ2lmeSh0ZXh0KX0pO1xuICAgICAgZWwuZGlzcGF0Y2hFdmVudChuZXcgRXZlbnQoJ2lucHV0JywgeyBidWJibGVzOiB0cnVlIH0pKTtcbiAgICAgIHJldHVybiAnT0snO1xuICAgIH0pKClgKTtcblxuICAvKiAtLS0tIFx1NTQyRlx1NTJBOFx1N0I0OVx1NUY4NTpSZWFjdCBcdTYzMDJcdThGN0QgKyBob3N0IFx1N0VGRlx1NzBCOShyZWFsIFx1NzY4NCBobWhhcm5lc3MgXHU1MUI3XHU1NDJGXHU1MkE4XHU4OTgxXHU3RjE2XHU4QkQxXG4gICAgIFx1NjU3NFx1NTk1NyBDTEkgXHU0RjlEXHU4RDU2LFx1NTNFRlx1NTIzMCAzMHMrO1x1NEUwRFx1N0I0OVx1N0VGRlx1NzBCOVx1NUMzMVx1NUYwMFx1OEREMVx1NEYxQVx1NTE2OFx1OTBFOFx1OEQ4NVx1NjVGNlx1OEJFRlx1NjJBNSkgLS0tLSAqL1xuICBhd2FpdCB3YWl0Rm9yKCdob3N0IHJlYWR5JywgYHZhciB0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jb21wb3NlciB0ZXh0YXJlYScpOyByZXR1cm4ge29rOiAhIXQsIGRldGFpbDogdCA/ICdtb3VudGVkJyA6ICdubyBjb21wb3Nlcid9O2AsIDIwXzAwMCk7XG4gIGF3YWl0IHdhaXRGb3IoJ2hvc3QgZG90IG9uJywgYHZhciBkPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ob3N0LWRvdCcpOyByZXR1cm4ge29rOiAhIWQgJiYgZC5jbGFzc0xpc3QuY29udGFpbnMoJ29uJyksIGRldGFpbDogZCA/IGQuY2xhc3NOYW1lIDogJ25vIGRvdCd9O2AsIG1vZGUgPT09ICdyZWFsJyA/IDYwXzAwMCA6IDIwXzAwMCk7XG4gIGF3YWl0IHNsZWVwKDFfMjAwKTsgLy8gXHU0RjFBXHU4QkREXHU1MjE3XHU4ODY4L1x1OTg3Nlx1NjgwRlx1NjU3MFx1NjM2RVx1ODQzRFx1NTczMFxuXG4gIC8qID09PT09PT09PT0gXHU5MDFBXHU3NTI4Olx1NUUwM1x1NUM0MFx1NTFFMFx1NEY1NShcdTc1MjhcdTYyMzdcdTYyQTVcdTk2OUNcdTc2ODRcdTc2RjRcdTYzQTVcdTY1QURcdThBMDApID09PT09PT09PT0gKi9cbiAgYXdhaXQgc3RlcCgnXHU1RTAzXHU1QzQwOlx1NjgwN1x1OTg5OFx1NjgwRitcdTRFMDlcdTY4MEYrY29tcG9zZXIgXHU1NzI4XHU4OUM2XHU1M0UzXHU1MTg1KFx1OEY5M1x1NTE2NVx1Njg0Nlx1NTNFRlx1ODlDMSknLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgciA9IChhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XG4gICAgICB2YXIgcSA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IuYmluZChkb2N1bWVudCk7XG4gICAgICB2YXIgdGIgPSBxKCcudGl0bGViYXInKSwgc2hlbGwgPSBxKCcuYXBwLXNoZWxsJyksIHNiID0gcSgnLnNpZGViYXInKSwgd3MgPSBxKCcud29ya3NwYWNlJyksIHRhID0gcSgnLmNvbXBvc2VyIHRleHRhcmVhJyk7XG4gICAgICB2YXIgbWlzc2luZyA9IFshdGIgJiYgJ3RpdGxlYmFyJywgIXNoZWxsICYmICdzaGVsbCcsICFzYiAmJiAnc2lkZWJhcicsICF3cyAmJiAnd29ya3NwYWNlJywgIXRhICYmICd0ZXh0YXJlYSddLmZpbHRlcihCb29sZWFuKS5qb2luKCcsJyk7XG4gICAgICBpZiAobWlzc2luZyAhPT0gJycpIHJldHVybiBKU09OLnN0cmluZ2lmeSh7b2s6ZmFsc2UsIGRldGFpbDonbWlzc2luZzonK21pc3Npbmd9KTtcbiAgICAgIHZhciByID0gdGEuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCksIHZoID0gd2luZG93LmlubmVySGVpZ2h0LCB2dyA9IHdpbmRvdy5pbm5lcldpZHRoO1xuICAgICAgdmFyIGhpbnQgPSBxKCcuZW1wdHktaGludC5iaWcnKTsgdmFyIGhyID0gaGludCA/IGhpbnQuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCkgOiBudWxsO1xuICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHsgb2s6IHIuaGVpZ2h0ID4gMzAgJiYgci5ib3R0b20gPD0gdmggJiYgci53aWR0aCA+IDEwMCAmJiBociAhPT0gbnVsbCAmJiBoci50b3AgPj0gMCAmJiBoci5ib3R0b20gPD0gdmgsXG4gICAgICAgIGRldGFpbDogJ3RleHRhcmVhIHk9JytNYXRoLnJvdW5kKHIueSkrJyBoPScrTWF0aC5yb3VuZChyLmhlaWdodCkrJyBib3R0b209JytNYXRoLnJvdW5kKHIuYm90dG9tKSsnIHZoPScrdmgrKGhyID8gJyBoaW50IHk9JytNYXRoLnJvdW5kKGhyLnkpIDogJyBuby1oaW50JykgfSk7XG4gICAgfSkoKWApKSBhcyBzdHJpbmc7XG4gICAgY29uc3QgcCA9IEpTT04ucGFyc2UocikgYXMgeyBvazogYm9vbGVhbjsgZGV0YWlsOiBzdHJpbmcgfTtcbiAgICByZXR1cm4gW3Aub2sgPT09IHRydWUsIHAuZGV0YWlsXTtcbiAgfSk7XG5cbiAgaWYgKG1vZGUgPT09ICdmYWtlJykge1xuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTk5OTZcdThERDFcdTVGMTVcdTVCRkNcdTVDNDIgPT09PT09PT09PSAqL1xuICAgIGF3YWl0IHN0ZXAoJ1x1NUYxNVx1NUJGQ1x1NUM0MjpcdTZGMTRcdTc5M0FcdTZBMjFcdTVGMEZcdTYzRDBcdTc5M0FcdTUxRkFcdTczQjBcdTVFNzZcdTUzRUZcdTUxNzNcdTk1RUQnLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignZ3VpZGUnLCBgdmFyIGc9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnJ1bnRpbWUtZ3VpZGUnKTsgcmV0dXJuIHtvazogISFnLCBkZXRhaWw6IGcgPyAnc2hvd24nIDogJ25vdCBzaG93bid9O2AsIDhfMDAwKTtcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XG4gICAgICAgIHZhciBidG5zID0gW10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcucnVudGltZS1ndWlkZSBidXR0b24nKSk7XG4gICAgICAgIHZhciBiID0gYnRucy5maW5kKGZ1bmN0aW9uKHgpeyByZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTZGMTRcdTc5M0EnKSA+PSAwOyB9KTtcbiAgICAgICAgaWYgKGIpIGIuY2xpY2soKTtcbiAgICAgIH0pKClgKTtcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdndWlkZSBnb25lJywgYHJldHVybiB7b2s6ICFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcucnVudGltZS1ndWlkZScpLCBkZXRhaWw6IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ydW50aW1lLWd1aWRlJykgPyAnc3RpbGwnIDogJ2Rpc21pc3NlZCd9O2AsIDVfMDAwKTtcbiAgICB9KTtcblxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTY1QjBcdTVFRkFcdTRGMUFcdThCREQoQ3RybCtOKSA9PT09PT09PT09ICovXG4gICAgYXdhaXQgc3RlcCgnQ3RybCtOIFx1NjVCMFx1NUVGQVx1NEYxQVx1OEJERCxcdThGOTNcdTUxNjVcdTY4NDZcdTUzRUZcdTc1MjgnLCBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OiduJywgY3RybEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcbiAgICAgIHJldHVybiB3YWl0Rm9yKCd0ZXh0YXJlYSBlbmFibGVkJywgYHZhciB0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jb21wb3NlciB0ZXh0YXJlYScpO1xuICAgICAgICByZXR1cm4ge29rOiAhIXQgJiYgdC5kaXNhYmxlZCA9PT0gZmFsc2UgJiYgKHQucGxhY2Vob2xkZXJ8fCcnKS5pbmRleE9mKCdcdTYzQ0ZcdThGRjBcdTc2RUVcdTY4MDcnKSA+PSAwLCBkZXRhaWw6IHQgPyAoJ2Rpc2FibGVkPScrdC5kaXNhYmxlZCsnIHBoPScrKHQucGxhY2Vob2xkZXJ8fCcnKS5zbGljZSgwLDIwKSkgOiAnbm8gdGEnfTtgLCA1XzAwMCk7XG4gICAgfSk7XG5cbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU1M0QxXHU5MDAxXHU0RUZCXHU1MkExIFx1MjE5MiBcdTc1MjhcdTYyMzdcdThGNkVcdTUxRkFcdTczQjAoXHU0RTE0XHU0RUM1XHU0RTAwXHU2NzYxLFx1NTNDQ1x1NkQ4OFx1NjA2Rlx1NTZERVx1NUY1MikgPT09PT09PT09PSAqL1xuICAgIGF3YWl0IHN0ZXAoJ1x1OEY5M1x1NTE2NVx1NUU3Nlx1NTNEMVx1OTAwMVx1NEVGQlx1NTJBMSxcdTc1MjhcdTYyMzdcdTZEODhcdTYwNkZcdTRFMEFcdTVDNEZcdTRFMTRcdTRFMERcdTkxQ0RcdTU5MEQnLCBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCB0eXBlSW50bygnLmNvbXBvc2VyIHRleHRhcmVhJywgJ1x1OUE4Q1x1NjUzNlx1NEVGQlx1NTJBMTpcdTUxOTlcdTUxNjVcdTRFMDBcdTRFMkFcdTY1ODdcdTRFRjYnKTtcbiAgICAgIGF3YWl0IHNsZWVwKDIwMCk7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XG4gICAgICAgIHZhciBidG5zID0gW10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY29tcG9zZXIgYnV0dG9uJykpO1xuICAgICAgICB2YXIgYiA9IGJ0bnMuZmluZChmdW5jdGlvbih4KXsgcmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpID09PSAnXHU1M0QxXHU5MDAxJzsgfSk7XG4gICAgICAgIGlmIChiKSBiLmNsaWNrKCk7XG4gICAgICB9KSgpYCk7XG4gICAgICByZXR1cm4gd2FpdEZvcignZXhhY3RseSBvbmUgdXNlciB0dXJuJywgYHZhciB0cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50dXJuLnVzZXInKSkuZmlsdGVyKGZ1bmN0aW9uKHgpeyByZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTlBOENcdTY1MzZcdTRFRkJcdTUyQTEnKSA+PSAwOyB9KTtcbiAgICAgICAgcmV0dXJuIHtvazogdHMubGVuZ3RoID09PSAxLCBkZXRhaWw6ICdjb3VudD0nK3RzLmxlbmd0aCsnIHRleHQ9JysodHNbMF0/dHNbMF0udGV4dENvbnRlbnQuc2xpY2UoMCwzMCk6J25vbmUnKX07YCwgOF8wMDApO1xuICAgIH0pO1xuXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NURFNVx1NTE3N1x1NTM2MShyZWFkX2ZpbGUgXHU1QjhDXHU2MjEwKSA9PT09PT09PT09ICovXG4gICAgYXdhaXQgc3RlcCgnXHU1REU1XHU1MTc3XHU2Mjk4XHU1M0UwXHU1MzYxOnJlYWRfZmlsZSBcdTYyNjdcdTg4NENcdTVFNzZcdTVCOENcdTYyMTAnLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcigndG9vbCBjYXJkJywgYHZhciBjPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnRvb2wtY2FyZCcpKTtcbiAgICAgICAgdmFyIGRvbmUgPSBjLmZpbHRlcihmdW5jdGlvbih4KXsgcmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZigncmVhZF9maWxlJykgPj0gMCAmJiB4LnRleHRDb250ZW50LmluZGV4T2YoJyMgZGVtbycpID49IDA7IH0pO1xuICAgICAgICByZXR1cm4ge29rOiBkb25lLmxlbmd0aCA+PSAxLCBkZXRhaWw6ICdjYXJkcz0nK2MubGVuZ3RoKycgZG9uZT0nK2RvbmUubGVuZ3RofTtgLCA4XzAwMCk7XG4gICAgICByZXR1cm4gdztcbiAgICB9KTtcblxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTVCQTFcdTYyNzlcdTdFQjVcdTUyMDdcdTcyNDcoXHU3NTI4XHU2MjM3XHU2MkE1XHU5NjlDXHU2ODM4XHU1RkMzXHU0RTRCXHU0RTAwKSA9PT09PT09PT09ICovXG4gICAgYXdhaXQgc3RlcCgnXHU1QkExXHU2Mjc5OmFwcHJvdmFsIFx1NTM2MVx1NTFGQVx1NzNCMChcdTdCNDlcdTVGODVcdTRFQkFcdTVERTVcdTYyNzlcdTUxQzYpJywgYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQgc2hvdCgnYXBwcm92YWwtcGVuZGluZycpO1xuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2FwcHJvdmFsIGNhcmQnLCBgdmFyIGE9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmFwcHJvdmFsLWNhcmQnKTtcbiAgICAgICAgcmV0dXJuIHtvazogISFhICYmIGEudGV4dENvbnRlbnQuaW5kZXhPZignXHU5NzAwXHU4OTgxXHU1QkExXHU2Mjc5JykgPj0gMCwgZGV0YWlsOiBhID8gYS50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsIDYwKSA6ICdubyBhcHByb3ZhbCBjYXJkJ307YCwgOF8wMDApO1xuICAgIH0pO1xuICAgIGF3YWl0IHN0ZXAoJ1x1NUJBMVx1NjI3OTpcdTcwQjlcdTYyNzlcdTUxQzYgXHUyMTkyIFx1NEVGQlx1NTJBMVx1N0VFN1x1N0VFRFx1NTIzMFx1NEVBNFx1NEVEOFx1NzI2OStcdTZDNDdcdTYwM0InLCBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XG4gICAgICAgIHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmFwcHJvdmFsLWNhcmQgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7IHJldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTYyNzlcdTUxQzYnOyB9KTtcbiAgICAgICAgaWYgKGIpIGIuY2xpY2soKTtcbiAgICAgIH0pKClgKTtcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdhcnRpZmFjdCtzdW0nLCBgdmFyIGFydD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuYXJ0aWZhY3QtY2FyZCcpO1xuICAgICAgICB2YXIgc3VtPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy50dXJuLXN1bScpO1xuICAgICAgICB2YXIgYXN0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnR1cm4nKSkuZmlsdGVyKGZ1bmN0aW9uKHgpeyByZXR1cm4geC5jbGFzc05hbWUuaW5kZXhPZigndXNlcicpPDAgJiYgeC50ZXh0Q29udGVudC5pbmRleE9mKCdlY2hvOicpPj0wOyB9KTtcbiAgICAgICAgcmV0dXJuIHtvazogISFhcnQgJiYgISFzdW0gJiYgYXN0Lmxlbmd0aD49MSwgZGV0YWlsOiAnYXJ0aWZhY3Q9JysoYXJ0P2FydC50ZXh0Q29udGVudC5zbGljZSgwLDMwKTonbm9uZScpKycgc3VtPScrKHN1bT9zdW0udGV4dENvbnRlbnQ6J25vbmUnKSsnIGFuc3dlcmVkPScrYXN0Lmxlbmd0aH07YCwgMTJfMDAwKTtcbiAgICAgIGF3YWl0IHNob3QoJ3J1bi1jb21wbGV0ZWQnKTtcbiAgICAgIHJldHVybiB3O1xuICAgIH0pO1xuXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NTM4Nlx1NTNGMlx1NEYxQVx1OEJERFx1NTE4NVx1NUJCOShcdTc1MjhcdTYyMzdcdTYyQTVcdTk2OUNcIlx1NzcwQlx1NEUwRFx1NTIzMFx1NTE4NVx1NUJCOVwiKSA9PT09PT09PT09ICovXG4gICAgYXdhaXQgc3RlcCgnXHU3MEI5XHU1MUZCXHU1Mzg2XHU1M0YyXHU0RjFBXHU4QkREIFx1MjE5MiB0cmFuc2NyaXB0IFx1NTE4NVx1NUJCOVx1NTNFRlx1ODlDMScsIGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGl0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zZXNzaW9uLWl0ZW0nKTsgaWYgKGl0KSBpdC5jbGljaygpOyB9KSgpYCk7XG4gICAgICByZXR1cm4gd2FpdEZvcignaGlzdG9yeSB0dXJucycsIGB2YXIgdHM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudHVybicpKTtcbiAgICAgICAgcmV0dXJuIHtvazogdHMubGVuZ3RoID49IDIsIGRldGFpbDogJ3R1cm5zPScrdHMubGVuZ3RoKycgZmlyc3Q9JysodHNbMF0/dHNbMF0udGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDQwKTonbm9uZScpfTtgLCA4XzAwMCk7XG4gICAgfSk7XG5cbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU0RTk0XHU5ODc1XHU3QjdFID09PT09PT09PT0gKi9cbiAgICBhd2FpdCBzdGVwKCdEb2NrOk92ZXJ2aWV3IFx1NjU3MFx1NjM2RVx1ODg0QycsIGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdPdmVydmlldyc7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xuICAgICAgcmV0dXJuIHdhaXRGb3IoJ292ZXJ2aWV3IHJvd3MnLCBgdmFyIHJvd3M9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay1yb3cnKSk7XG4gICAgICAgIHZhciB2ZXIgPSByb3dzLmZpbmQoZnVuY3Rpb24ocil7IHJldHVybiByLnRleHRDb250ZW50LmluZGV4T2YoJ3J1bnRpbWUgXHU3MjQ4XHU2NzJDJyk+PTA7IH0pO1xuICAgICAgICByZXR1cm4ge29rOiByb3dzLmxlbmd0aCA+PSA1ICYmICEhdmVyLCBkZXRhaWw6ICdyb3dzPScrcm93cy5sZW5ndGgrKHZlcj8nIHZlcj0nK3Zlci50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNDApOicnKX07YCwgNl8wMDApO1xuICAgIH0pO1xuICAgIGF3YWl0IHN0ZXAoJ0RvY2s6RmlsZXMgXHU2RDRGXHU4OUM4K1x1NjU4N1x1NEVGNlx1OTg4NFx1ODlDOCcsIGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdcdTY1ODdcdTRFRjYnfHx4LnRleHRDb250ZW50PT09J0ZpbGVzJzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignZnMgcm93cycsIGB2YXIgcm93cz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZnMtcm93JykubGVuZ3RoO1xuICAgICAgICByZXR1cm4ge29rOiByb3dzID49IDEsIGRldGFpbDogJ3Jvd3M9Jytyb3dzfTtgLCA2XzAwMCk7XG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xuICAgICAgLy8gXHU2ODM5XHU3NkVFXHU1RjU1XHU1M0VBXHU2NzA5XHU1REU1XHU0RjVDXHU1MzNBXHU3NkVFXHU1RjU1KGZha2UgXHU0RTBFXHU3NzFGXHU1QjlFIHJ1bnRpbWUgXHU1NDBDXHU1RjYyKTpcdTUxNDhcdThGREJcdTc2RUVcdTVGNTUsXHU1MThEXHU3MEI5XHU2NTg3XHU0RUY2XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBkPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmZzLXJvdycpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ2RlbW8td29ya3NwYWNlJyk+PTAgfHwgeC50ZXh0Q29udGVudC5pbmRleE9mKCdcdUQ4M0RcdURDQzEnKT49MDt9KTsgaWYoZCkgZC5jbGljaygpOyB9KSgpYCk7XG4gICAgICBjb25zdCB3MiA9IGF3YWl0IHdhaXRGb3IoJ2ZpbGUgcm93cycsIGB2YXIgcm93cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5mcy1yb3cnKSk7XG4gICAgICAgIHJldHVybiB7b2s6IHJvd3Muc29tZShmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdSRUFETUUnKT49MDt9KSwgZGV0YWlsOiAncm93cz0nK3Jvd3MubGVuZ3RofTtgLCA2XzAwMCk7XG4gICAgICBpZiAoIXcyWzBdKSByZXR1cm4gdzI7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBmPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmZzLXJvdycpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1JFQURNRScpPj0wO30pOyBpZihmKSBmLmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdmaWxlIHByZXZpZXcnLCBgdmFyIHA9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmZzLXByZXZpZXcnKTtcbiAgICAgICAgcmV0dXJuIHtvazogISFwICYmIHAudGV4dENvbnRlbnQuaW5kZXhPZignZGVtbyB3b3Jrc3BhY2UnKSA+PSAwLCBkZXRhaWw6IHAgPyBwLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw0MCkgOiAnbm8gcHJldmlldyd9O2AsIDZfMDAwKTtcbiAgICB9KTtcbiAgICBhd2FpdCBzdGVwKCdEb2NrOkRpZmYgXHU1M0Q4XHU2NkY0XHU4ODRDJywgYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J1x1NTNEOFx1NjZGNCd8fHgudGV4dENvbnRlbnQ9PT0nRGlmZic7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2RpZmYgcm93cycsIGB2YXIgcm93cz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZGlmZi1yb3cnKS5sZW5ndGg7XG4gICAgICAgIHJldHVybiB7b2s6IHJvd3MgPj0gMSwgZGV0YWlsOiAnZGlmZiByb3dzPScrcm93c307YCwgNl8wMDApO1xuICAgIH0pO1xuICAgIGF3YWl0IHN0ZXAoJ0RvY2s6RXZpZGVuY2UgXHU4QkE0XHU3N0U1XHU2NTcwXHU2MzZFJywgYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J1x1OEJDMVx1NjM2RSd8fHgudGV4dENvbnRlbnQ9PT0nRXZpZGVuY2UnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdldmlkZW5jZSByb3dzJywgYHZhciByb3dzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stcm93JykpO1xuICAgICAgICB2YXIgbWVtID0gcm93cy5maW5kKGZ1bmN0aW9uKHIpeyByZXR1cm4gci50ZXh0Q29udGVudC5pbmRleE9mKCdcdThCQjBcdTVGQzZcdTVDNDInKT49MCB8fCByLnRleHRDb250ZW50LmluZGV4T2YoJ01lbW9yeSBsYXllcnMnKT49MDsgfSk7XG4gICAgICAgIHJldHVybiB7b2s6ICEhbWVtICYmIG1lbS50ZXh0Q29udGVudC5pbmRleE9mKCczJykgPj0gMCwgZGV0YWlsOiBtZW0gPyBtZW0udGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKSA6ICdubyBtZW1vcnkgcm93J307YCwgNl8wMDApO1xuICAgIH0pO1xuICAgIGF3YWl0IHN0ZXAoJ0RvY2s6TG9ncyBcdTk3NjJcdTY3N0YoXHU3QTdBXHU2MDAxXHU2M0QwXHU3OTNBKScsIGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdcdTY1RTVcdTVGRDcnfHx4LnRleHRDb250ZW50PT09J0xvZ3MnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdsb2dzIHBhbmUnLCBgdmFyIGw9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmxvZ3MtbGlzdCcpO1xuICAgICAgICByZXR1cm4ge29rOiAhIWwsIGRldGFpbDogbCA/ICgncm93cz0nK2wucXVlcnlTZWxlY3RvckFsbCgnLmxvZy1yb3cnKS5sZW5ndGgpIDogJ25vIGxvZ3MgbGlzdCd9O2AsIDVfMDAwKTtcbiAgICAgIHJldHVybiB3O1xuICAgIH0pO1xuXG4gICAgLyogPT09PT09PT09PSBmYWtlOkRvY2s6XHU4RkRDXHU3QTBCXHU5ODc1XHU3QjdFKFx1NjI0Qlx1NjczQVx1OEZEQ1x1N0EwQlx1NjNBN1x1NTIzNlx1OTc2Mlx1Njc3RitcdTVGMDBcdTY3M0FcdTgxRUFcdTU0MkZcdTg4NEMpID09PT09PT09PT0gKi9cbiAgICBhd2FpdCBzdGVwKCdEb2NrOlx1OEZEQ1x1N0EwQlx1OTg3NVx1N0I3RShcdTYyNEJcdTY3M0FcdThGRENcdTdBMEJcdTYzQTdcdTUyMzZcdTk3NjJcdTY3N0YpJywgYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J1x1OEZEQ1x1N0EwQid8fHgudGV4dENvbnRlbnQ9PT0nUmVtb3RlJzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XG4gICAgICByZXR1cm4gd2FpdEZvcigncmVtb3RlIHBhbmUnLCBgdmFyIHA9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmRvY2stYm9keScpO1xuICAgICAgICB2YXIgdCA9IHAgPyBwLnRleHRDb250ZW50IDogJyc7XG4gICAgICAgIHZhciBva1QgPSB0LmluZGV4T2YoJ1x1NjI0Qlx1NjczQVx1OEZEQ1x1N0EwQlx1NjNBN1x1NTIzNicpPj0wIHx8IHQuaW5kZXhPZignUGhvbmUgcmVtb3RlJyk+PTA7XG4gICAgICAgIHZhciBva0EgPSB0LmluZGV4T2YoJ1x1NUYwMFx1NjczQVx1ODFFQVx1NTQyRicpPj0wIHx8IHQuaW5kZXhPZignQXV0b3N0YXJ0Jyk+PTA7XG4gICAgICAgIHJldHVybiB7b2s6ICEhcCAmJiBva1QgJiYgb2tBLCBkZXRhaWw6IHQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDYwKX07YCwgNl8wMDApO1xuICAgIH0pO1xuXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NjQxQ1x1N0QyMlx1OEZDN1x1NkVFNCA9PT09PT09PT09ICovXG4gICAgYXdhaXQgc3RlcCgnXHU0RjFBXHU4QkREXHU2NDFDXHU3RDIyOlx1OEZDN1x1NkVFNFx1NzUxRlx1NjU0OCcsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IGJlZm9yZSA9IChhd2FpdCBqcyhgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aGApKSBhcyBudW1iZXI7XG4gICAgICBhd2FpdCB0eXBlSW50bygnLnNlc3Npb24tc2VhcmNoJywgJ3p6ei1cdTRFMERcdTVCNThcdTU3MjhcdTc2ODRcdTRGMUFcdThCREQnKTtcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdmaWx0ZXJlZCBlbXB0eScsIGB2YXIgbj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoO1xuICAgICAgICByZXR1cm4ge29rOiBuID09PSAwLCBkZXRhaWw6ICdhZnRlcj0nK259O2AsIDVfMDAwKTtcbiAgICAgIGF3YWl0IHR5cGVJbnRvKCcuc2Vzc2lvbi1zZWFyY2gnLCAnJyk7XG4gICAgICBhd2FpdCBzbGVlcCg0MDApO1xuICAgICAgY29uc3QgYWZ0ZXIgPSAoYXdhaXQganMoYGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGhgKSkgYXMgbnVtYmVyO1xuICAgICAgcmV0dXJuIFt3WzBdICYmIGFmdGVyID09PSBiZWZvcmUsIGAke3dbMV19OyBcdTYwNjJcdTU5MERcdTU0MEUgJHthZnRlcn09PT0ke2JlZm9yZX1gXTtcbiAgICB9KTtcblxuICAgIC8qID09PT09PT09PT0gZmFrZTpDdHJsK0sgXHU1NDdEXHU0RUU0XHU5NzYyXHU2NzdGID09PT09PT09PT0gKi9cbiAgICBhd2FpdCBzdGVwKCdDdHJsK0sgXHU1NDdEXHU0RUU0XHU5NzYyXHU2NzdGOlx1NjI1M1x1NUYwMFx1NUU3Nlx1NjI2N1x1ODg0Q1x1NTQ3RFx1NEVFNCcsIGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J2snLCBjdHJsS2V5OnRydWUsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2NtZGsgb3BlbicsIGB2YXIgYz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kaycpO1xuICAgICAgICByZXR1cm4ge29rOiAhIWMsIGRldGFpbDogYyA/ICdvcGVuJyA6ICdub3Qgb3Blbid9O2AsIDVfMDAwKTtcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBpdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jbWRrLWl0ZW0nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTY1ODdcdTRFRjYnKT49MCB8fCB4LnRleHRDb250ZW50LmluZGV4T2YoJ0ZpbGVzJyk+PTA7fSk7IGlmKGl0KSBpdC5jbGljaygpOyB9KSgpYCk7XG4gICAgICByZXR1cm4gd2FpdEZvcigndGFiIHN3aXRjaGVkJywgYHZhciB0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5kb2NrLXRhYi5hY3RpdmUnKTtcbiAgICAgICAgcmV0dXJuIHtvazogISF0ICYmICh0LnRleHRDb250ZW50PT09J1x1NjU4N1x1NEVGNid8fHQudGV4dENvbnRlbnQ9PT0nRmlsZXMnKSwgZGV0YWlsOiAnYWN0aXZlPScrKHQ/dC50ZXh0Q29udGVudDonbm9uZScpfTtgLCA1XzAwMCk7XG4gICAgfSk7XG5cbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU4QkJFXHU3RjZFXHU5NzYyXHU2NzdGID09PT09PT09PT0gKi9cbiAgICBhd2FpdCBzdGVwKCdcdThCQkVcdTdGNkUoQ3RybCtTaGlmdCtQKTpQcm92aWRlciBcdTg4NjhcdTUzNTVcdTUzRUZcdTg5QzEsRXNjIFx1NTE3M1x1OTVFRCcsIGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J3AnLCBjdHJsS2V5OnRydWUsIHNoaWZ0S2V5OnRydWUsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3NldHRpbmdzIG9wZW4nLCBgdmFyIHM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNtZGsuc2V0dGluZ3MnKTtcbiAgICAgICAgcmV0dXJuIHtvazogISFzICYmICEhcy5xdWVyeVNlbGVjdG9yKCcucHJvdmlkZXItZm9ybScpLCBkZXRhaWw6IHMgPyAnb3Blbitmb3JtJyA6ICdub3Qgb3Blbid9O2AsIDVfMDAwKTtcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidFc2NhcGUnLCBidWJibGVzOnRydWV9KSlgKTtcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdzZXR0aW5ncyBjbG9zZWQnLCBgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrLW92ZXJsYXknKSwgZGV0YWlsOiAnY2xvc2VkJ307YCwgNV8wMDApO1xuICAgIH0pO1xuXG4gICAgLyogPT09PT09PT09PSBmYWtlOmkxOG4gXHU4QkVEXHU4QTAwXHU1MjA3XHU2MzYyID09PT09PT09PT0gKi9cbiAgICBhd2FpdCBzdGVwKCdcdThCRURcdThBMDBcdTUyMDdcdTYzNjI6XHU0RTJEXHU2NTg3IFx1MjE5MiBFbmdsaXNoIFx1MjE5MiBcdTYwNjJcdTU5MERcdTRFMkRcdTY1ODcnLCBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidwJywgY3RybEtleTp0cnVlLCBzaGlmdEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdzZXR0aW5ncyBvcGVuJywgYHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrLnNldHRpbmdzJyk7XG4gICAgICAgIHJldHVybiB7b2s6ICEhcywgZGV0YWlsOiBzID8gJ29wZW4nIDogJ25vdCBvcGVuJ307YCwgNV8wMDApO1xuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY21kay5zZXR0aW5ncyBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nRW5nbGlzaCc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xuICAgICAgY29uc3QgZW4gPSBhd2FpdCB3YWl0Rm9yKCdlbmdsaXNoIHNob3duJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyLWhlYWQgLmJ0bi5wcmltYXJ5Jyk7XG4gICAgICAgIHJldHVybiB7b2s6ICEhYiAmJiBiLnRleHRDb250ZW50ID09PSAnKyBOZXcgU2Vzc2lvbicsIGRldGFpbDogJ2J0bj0nKyhiP2IudGV4dENvbnRlbnQ6J25vbmUnKX07YCwgNV8wMDApO1xuICAgICAgYXdhaXQgc2hvdCgnZW5nbGlzaCcpO1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jbWRrLnNldHRpbmdzIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTRFMkRcdTY1ODcnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIGNvbnN0IHpoID0gYXdhaXQgd2FpdEZvcignY2hpbmVzZSBiYWNrJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyLWhlYWQgLmJ0bi5wcmltYXJ5Jyk7XG4gICAgICAgIHJldHVybiB7b2s6ICEhYiAmJiBiLnRleHRDb250ZW50ID09PSAnKyBcdTY1QjBcdTVFRkFcdTRGMUFcdThCREQnLCBkZXRhaWw6ICdidG49JysoYj9iLnRleHRDb250ZW50Oidub25lJyl9O2AsIDVfMDAwKTtcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J0VzY2FwZScsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xuICAgICAgcmV0dXJuIFtlblswXSAmJiB6aFswXSwgYGVuOiAke2VuWzFdfTsgemg6ICR7emhbMV19YF07XG4gICAgfSk7XG5cbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU1REU1XHU0RjVDXHU1MzNBXHU3QkExXHU3NDA2KFx1NURFNlx1NjgwRlx1NjgwRlx1NEY0RCArIFx1ODNEQ1x1NTM1NSArIFx1NjVCMFx1NUVGQVx1NEYxQVx1OEJERFx1OTAwOVx1NURFNVx1NEY1Q1x1NTMzQSkgPT09PT09PT09PSAqL1xuICAgIGF3YWl0IHN0ZXAoJ1x1NURFNVx1NEY1Q1x1NTMzQTpcdTVERTZcdTY4MEZcdTVERTVcdTRGNUNcdTUzM0FcdTY4MEZcdTUzRUZcdTg5QzEoXHU1RjUzXHU1MjREXHU1REU1XHU0RjVDXHU1MzNBXHU1NDBEKScsIGFzeW5jICgpID0+IHtcbiAgICAgIHJldHVybiB3YWl0Rm9yKCd3b3Jrc3BhY2UgYmFyJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53b3Jrc3BhY2UtYmFyJyk7XG4gICAgICAgIHZhciBuID0gYiA/IChiLnF1ZXJ5U2VsZWN0b3IoJy53cy1iYXItbmFtZScpfHx7fSkudGV4dENvbnRlbnQgOiAnJztcbiAgICAgICAgcmV0dXJuIHtvazogISFiICYmICEhbiAmJiBuLmxlbmd0aCA+IDAgJiYgbi5pbmRleE9mKCdcdTUyQTBcdThGN0QnKSA8IDAsIGRldGFpbDogJ2Jhcj0nKyhiPyd5ZXMnOidubycpKycgbmFtZT0nK259O2AsIDhfMDAwKTtcbiAgICB9KTtcbiAgICBhd2FpdCBzdGVwKCdcdTVERTVcdTRGNUNcdTUzM0E6XHU4M0RDXHU1MzU1XHU1RjM5XHU1MUZBLFx1NTIxN1x1ODg2OCtcdTVGNTNcdTUyNERcdTlBRDhcdTRFQUUrXHU2REZCXHU1MkEwXHU1MTY1XHU1M0UzO1x1NTcyOFx1NjMwN1x1NUI5QVx1NURFNVx1NEY1Q1x1NTMzQVx1NjVCMFx1NUVGQVx1NEYxQVx1OEJERCcsIGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndvcmtzcGFjZS1iYXInKTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignd3MgbWVudScsIGB2YXIgbT1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtbWVudScpO1xuICAgICAgICB2YXIgaXRlbXMgPSBtID8gbS5xdWVyeVNlbGVjdG9yQWxsKCcud3MtbWVudS1pdGVtJykubGVuZ3RoIDogMDtcbiAgICAgICAgdmFyIGN1ciA9IG0gPyBtLnF1ZXJ5U2VsZWN0b3JBbGwoJy53cy1tZW51LWl0ZW0uY3VycmVudCcpLmxlbmd0aCA6IDA7XG4gICAgICAgIHZhciBhZGQgPSBtID8gKG0udGV4dENvbnRlbnQuaW5kZXhPZignXHU2REZCXHU1MkEwXHU1REU1XHU0RjVDXHU1MzNBJyk+PTAgfHwgbS50ZXh0Q29udGVudC5pbmRleE9mKCdBZGQgd29ya3NwYWNlJyk+PTApIDogZmFsc2U7XG4gICAgICAgIHJldHVybiB7b2s6IGl0ZW1zID49IDEgJiYgY3VyID49IDEgJiYgYWRkLCBkZXRhaWw6ICdpdGVtcz0nK2l0ZW1zKycgY3VycmVudD0nK2N1cisnIGFkZD0nK2FkZH07YCwgNl8wMDApO1xuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcbiAgICAgIGF3YWl0IHNob3QoJ3dzLW1lbnUnKTtcbiAgICAgIC8vIFx1NzBCOVx1N0IyQ1x1NEUwMFx1NEUyQVx1NURFNVx1NEY1Q1x1NTMzQVx1OTg3OSA9IFx1NTcyOFx1OEJFNVx1NURFNVx1NEY1Q1x1NTMzQVx1NjVCMFx1NUVGQVx1NEYxQVx1OEJERChcdTgzRENcdTUzNTVcdTUxNzNcdTk1RURcdTMwMDFjb21wb3NlciBcdTUzRUZcdTc1MjgpXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBpdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtbWVudS1pdGVtJyk7IGlmKGl0KSBpdC5jbGljaygpOyB9KSgpYCk7XG4gICAgICBjb25zdCBjbG9zZWQgPSBhd2FpdCB3YWl0Rm9yKCdtZW51IGNsb3NlZCArIHNlc3Npb24gYWN0aXZlJywgYHZhciB0YT1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY29tcG9zZXIgdGV4dGFyZWEnKTtcbiAgICAgICAgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1tZW51JykgJiYgISF0YSAmJiB0YS5kaXNhYmxlZCA9PT0gZmFsc2UsIGRldGFpbDogJ21lbnU9JysoZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLW1lbnUnKT8nb3Blbic6J2Nsb3NlZCcpKycgdGE9JysodGE/dGEuZGlzYWJsZWQ6J25vbmUnKX07YCwgNl8wMDApO1xuICAgICAgcmV0dXJuIFtjbG9zZWRbMF0sIGAke3dbMV19OyAke2Nsb3NlZFsxXX1gXTtcbiAgICB9KTtcblxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTRGMUFcdThCRERcdTYzMDlcdTVERTVcdTRGNUNcdTUzM0FcdTUyMDZcdTdFQzQgKyBcdTVDNTVcdTVGMDAvXHU2NTM2XHU4RDc3ID09PT09PT09PT0gKi9cbiAgICBhd2FpdCBzdGVwKCdcdTRGMUFcdThCRERcdTUyMDZcdTdFQzQ6XHU3RUM0XHU1OTM0XHU1MUZBXHU3M0IwKFx1NURFNVx1NEY1Q1x1NTMzQVx1NTQwRCtcdTY1NzBcdTkxQ0YpJywgYXN5bmMgKCkgPT4ge1xuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2dyb3VwIGhlYWQnLCBgdmFyIGg9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLWdyb3VwLWhlYWQnKTtcbiAgICAgICAgdmFyIG4gPSBoID8gKGgucXVlcnlTZWxlY3RvcignLndzLWdyb3VwLW5hbWUnKXx8e30pLnRleHRDb250ZW50IDogJyc7XG4gICAgICAgIHZhciBjID0gaCA/IChoLnF1ZXJ5U2VsZWN0b3IoJy53cy1ncm91cC1jb3VudCcpfHx7fSkudGV4dENvbnRlbnQgOiAnJztcbiAgICAgICAgcmV0dXJuIHtvazogISFoICYmIG4ubGVuZ3RoID4gMCAmJiBjLmxlbmd0aCA+IDAsIGRldGFpbDogJ25hbWU9JytuKycgY291bnQ9JytjfTtgLCA4XzAwMCk7XG4gICAgfSk7XG4gICAgYXdhaXQgc3RlcCgnXHU0RjFBXHU4QkREXHU1MjA2XHU3RUM0Olx1NzBCOVx1NTFGQlx1N0VDNFx1NTkzNFx1NjUzNlx1OEQ3NyxcdTUxOERcdTcwQjlcdTVDNTVcdTVGMDBcdTYwNjJcdTU5MEQnLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBiZWZvcmUgPSAoYXdhaXQganMoYGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGhgKSkgYXMgbnVtYmVyO1xuICAgICAgaWYgKGJlZm9yZSA9PT0gMCkgcmV0dXJuIFtmYWxzZSwgJ25vIHNlc3Npb25zIHRvIGdyb3VwJ107XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBoPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1ncm91cC1oZWFkJyk7IGlmKGgpIGguY2xpY2soKTsgfSkoKWApO1xuICAgICAgY29uc3QgY29sbGFwc2VkID0gYXdhaXQgd2FpdEZvcignY29sbGFwc2VkJywgYHZhciBnPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1ncm91cCcpO1xuICAgICAgICB2YXIgaGlkZGVuID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aCA8ICR7YmVmb3JlfTtcbiAgICAgICAgcmV0dXJuIHtvazogaGlkZGVuLCBkZXRhaWw6ICdpdGVtcz0nK2RvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGgrJyBiZWZvcmU9JHtiZWZvcmV9J307YCwgNV8wMDApO1xuICAgICAgYXdhaXQgc2hvdCgnd3MtZ3JvdXAtY29sbGFwc2VkJyk7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBoPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1ncm91cC1oZWFkJyk7IGlmKGgpIGguY2xpY2soKTsgfSkoKWApO1xuICAgICAgY29uc3QgZXhwYW5kZWQgPSBhd2FpdCB3YWl0Rm9yKCdleHBhbmRlZCBiYWNrJywgYHZhciBuPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGg7XG4gICAgICAgIHJldHVybiB7b2s6IG4gPj0gJHtiZWZvcmV9LCBkZXRhaWw6ICdpdGVtcz0nK259O2AsIDVfMDAwKTtcbiAgICAgIHJldHVybiBbY29sbGFwc2VkWzBdICYmIGV4cGFuZGVkWzBdLCBgY29sbGFwc2U6ICR7Y29sbGFwc2VkWzFdfTsgZXhwYW5kOiAke2V4cGFuZGVkWzFdfWBdO1xuICAgIH0pO1xuXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NUZFQlx1NjM3N1x1OTUyRVx1NUUyRVx1NTJBOVx1OTc2Mlx1Njc3RihDdHJsKy8pID09PT09PT09PT0gKi9cbiAgICBhd2FpdCBzdGVwKCdcdTVGRUJcdTYzNzdcdTk1MkVcdTVFMkVcdTUyQTk6Q3RybCsvIFx1NjI1M1x1NUYwMCxFc2MgXHU1MTczXHU5NUVEJywgYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleTonLycsIGN0cmxLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignc2hvcnRjdXRzIG9wZW4nLCBgdmFyIHM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNtZGsnKTtcbiAgICAgICAgdmFyIHJvd3MgPSBzID8gcy5xdWVyeVNlbGVjdG9yQWxsKCcuc2hvcnRjdXQtcm93JykubGVuZ3RoIDogMDtcbiAgICAgICAgcmV0dXJuIHtvazogcm93cyA+PSA1LCBkZXRhaWw6ICdyb3dzPScrcm93c307YCwgNV8wMDApO1xuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcbiAgICAgIGF3YWl0IHNob3QoJ3Nob3J0Y3V0cycpO1xuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleTonRXNjYXBlJywgYnViYmxlczp0cnVlfSkpYCk7XG4gICAgICByZXR1cm4gd2FpdEZvcignc2hvcnRjdXRzIGNsb3NlZCcsIGByZXR1cm4ge29rOiAhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNtZGstb3ZlcmxheScpLCBkZXRhaWw6ICdjbG9zZWQnfTtgLCA1XzAwMCk7XG4gICAgfSk7XG5cbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU0RkE3XHU2ODBGXHU2NTM2XHU3RjI5ICsgXHU3MkI2XHU2MDAxXHU4RkM3XHU2RUU0ID09PT09PT09PT0gKi9cbiAgICBhd2FpdCBzdGVwKCdcdTRGQTdcdTY4MEZcdTY1MzZcdTdGMjk6XHUyMUU0IFx1NjUzNlx1OEQ3N1x1NURFNlx1NjgwRixcdTIxRTUgXHU1QzU1XHU1RjAwXHU2MDYyXHU1OTBEJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3RvZ2dsZSBidG4nLCBgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudG9wYmFyIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTIxRTQnfHx4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTIxRTUnO30pO1xuICAgICAgICByZXR1cm4ge29rOiAhIWIsIGRldGFpbDogJ2J0bj0nKyhiP2IudGV4dENvbnRlbnQudHJpbSgpOidub25lJyl9O2AsIDVfMDAwKTtcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnRvcGJhciBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHUyMUU0J3x8eC50ZXh0Q29udGVudC50cmltKCk9PT0nXHUyMUU1Jzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XG4gICAgICBjb25zdCBoaWRkZW4gPSBhd2FpdCB3YWl0Rm9yKCdzaWRlYmFyIGhpZGRlbicsIGB2YXIgc2I9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXInKTtcbiAgICAgICAgdmFyIGdvbmUgPSAhc2IgfHwgZ2V0Q29tcHV0ZWRTdHlsZShzYikuZGlzcGxheSA9PT0gJ25vbmUnO1xuICAgICAgICByZXR1cm4ge29rOiBnb25lLCBkZXRhaWw6ICdkaXNwbGF5PScrKHNiP2dldENvbXB1dGVkU3R5bGUoc2IpLmRpc3BsYXk6J25vbmUnKX07YCwgNV8wMDApO1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50b3BiYXIgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1MjFFNCd8fHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1MjFFNSc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xuICAgICAgY29uc3Qgc2hvd24gPSBhd2FpdCB3YWl0Rm9yKCdzaWRlYmFyIGJhY2snLCBgdmFyIHNiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyJyk7XG4gICAgICAgIHJldHVybiB7b2s6ICEhc2IgJiYgZ2V0Q29tcHV0ZWRTdHlsZShzYikuZGlzcGxheSAhPT0gJ25vbmUnLCBkZXRhaWw6ICdkaXNwbGF5PScrKHNiP2dldENvbXB1dGVkU3R5bGUoc2IpLmRpc3BsYXk6J25vbmUnKX07YCwgNV8wMDApO1xuICAgICAgcmV0dXJuIFtoaWRkZW5bMF0gJiYgc2hvd25bMF0sIGBoaWRlOiAke2hpZGRlblsxXX07IHNob3c6ICR7c2hvd25bMV19YF07XG4gICAgfSk7XG4gICAgYXdhaXQgc3RlcCgnXHU3MkI2XHU2MDAxXHU4RkM3XHU2RUU0Olx1NEUwQlx1NjJDOVx1NTIwN1x1NjM2Mlx1NTIzMFwiXHU4RkQwXHU4ODRDXHU0RTJEXCJcdTRFMERcdTVEMjlcdTZFODNcdTVFNzZcdTYwNjJcdTU5MEQnLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBzZWwgPSBhd2FpdCB3YWl0Rm9yKCdmaWx0ZXIgc2VsZWN0JywgYHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zdGF0dXMtZmlsdGVyJyk7XG4gICAgICAgIHJldHVybiB7b2s6ICEhcyAmJiBzLm9wdGlvbnMubGVuZ3RoID49IDQsIGRldGFpbDogJ29wdGlvbnM9Jysocz9zLm9wdGlvbnMubGVuZ3RoOjApfTtgLCA1XzAwMCk7XG4gICAgICBpZiAoIXNlbFswXSkgcmV0dXJuIHNlbDtcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnN0YXR1cy1maWx0ZXInKTsgcy52YWx1ZT0ncnVubmluZyc7IHMuZGlzcGF0Y2hFdmVudChuZXcgRXZlbnQoJ2NoYW5nZScse2J1YmJsZXM6dHJ1ZX0pKTsgfSkoKWApO1xuICAgICAgYXdhaXQgc2xlZXAoNTAwKTtcbiAgICAgIGNvbnN0IHIxID0gKGF3YWl0IGpzKGBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoYCkpIGFzIG51bWJlcjtcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnN0YXR1cy1maWx0ZXInKTsgcy52YWx1ZT0nYWxsJzsgcy5kaXNwYXRjaEV2ZW50KG5ldyBFdmVudCgnY2hhbmdlJyx7YnViYmxlczp0cnVlfSkpOyB9KSgpYCk7XG4gICAgICBhd2FpdCBzbGVlcCg1MDApO1xuICAgICAgY29uc3QgcjIgPSAoYXdhaXQganMoYGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGhgKSkgYXMgbnVtYmVyO1xuICAgICAgcmV0dXJuIFtyMiA+PSByMSAmJiByMiA+PSAxLCBgcnVubmluZz0ke3IxfSBhbGw9JHtyMn1gXTtcbiAgICB9KTtcblxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTZBMjFcdTU3OEJcdTkwMDlcdTYyRTlcdTU2NjgoXHU5ODc2XHU2ODBGXHU1MjA3XHU2MzYyIGNoYXQgXHU4REVGXHU3NTMxKSA9PT09PT09PT09ICovXG4gICAgYXdhaXQgc3RlcCgnXHU2QTIxXHU1NzhCXHU5MDA5XHU2MkU5XHU1NjY4Olx1OTg3Nlx1NjgwRlx1ODNEQ1x1NTM1NVx1NTIxN1x1NTFGQSBwcm92aWRlcnMgXHU1RTc2XHU1M0VGXHU1MjA3XHU2MzYyJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ21vZGVsIGJ1dHRvbicsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudG9wYmFyLW1vZGVsLmFzLWJ1dHRvbicpO1xuICAgICAgICByZXR1cm4ge29rOiAhIWIgJiYgYi5kaXNhYmxlZCA9PT0gZmFsc2UsIGRldGFpbDogYiA/IGIudGV4dENvbnRlbnQgOiAnbm9uZSd9O2AsIDZfMDAwKTtcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy50b3BiYXItbW9kZWwuYXMtYnV0dG9uJyk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xuICAgICAgY29uc3QgbSA9IGF3YWl0IHdhaXRGb3IoJ21vZGVsIG1lbnUnLCBgdmFyIG09ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLm1vZGVsLW1lbnUnKTtcbiAgICAgICAgdmFyIGl0ZW1zID0gbSA/IG0ucXVlcnlTZWxlY3RvckFsbCgnLndzLW1lbnUtaXRlbScpLmxlbmd0aCA6IDA7XG4gICAgICAgIHZhciBjdXIgPSBtID8gbS5xdWVyeVNlbGVjdG9yQWxsKCcud3MtbWVudS1pdGVtLmN1cnJlbnQnKS5sZW5ndGggOiAwO1xuICAgICAgICByZXR1cm4ge29rOiBpdGVtcyA+PSAyICYmIGN1ciA+PSAxLCBkZXRhaWw6ICdpdGVtcz0nK2l0ZW1zKycgY3VycmVudD0nK2N1cn07YCwgNV8wMDApO1xuICAgICAgaWYgKCFtWzBdKSByZXR1cm4gbTtcbiAgICAgIGF3YWl0IHNob3QoJ21vZGVsLW1lbnUnKTtcbiAgICAgIC8vIFx1NTIwN1x1NTIzMFx1N0IyQ1x1NEU4Q1x1NEUyQSBwcm92aWRlcihmYWtlOiBkZW1vLXZpc2lvbi9mYWtlLW0tdmlzaW9uKVxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgaXRzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLm1vZGVsLW1lbnUgLndzLW1lbnUtaXRlbScpKTsgdmFyIGl0PWl0c1tpdHMubGVuZ3RoLTFdOyBpZihpdCkgaXQuY2xpY2soKTsgfSkoKWApO1xuICAgICAgcmV0dXJuIHdhaXRGb3IoJ21vZGVsIHN3aXRjaGVkJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy50b3BiYXItbW9kZWwuYXMtYnV0dG9uJyk7XG4gICAgICAgIHJldHVybiB7b2s6ICEhYiAmJiBiLnRleHRDb250ZW50LmluZGV4T2YoJ2Zha2UtbS12aXNpb24nKSA+PSAwLCBkZXRhaWw6ICdiYWRnZT0nKyhiP2IudGV4dENvbnRlbnQ6J25vbmUnKX07YCwgNl8wMDApO1xuICAgIH0pO1xuXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NEUzQlx1OTg5OChcdTZENDVcdTgyNzJcdTc1MUZcdTY1NDhcdTIxOTJcdTYwNjJcdTU5MERcdTZERjFcdTgyNzIpID09PT09PT09PT0gKi9cbiAgICBhd2FpdCBzdGVwKCdcdTRFM0JcdTk4OTg6XHU4QkJFXHU3RjZFXHU1MjA3XHU2RDQ1XHU4MjcyXHU3NTFGXHU2NTQ4LFx1NjA2Mlx1NTkwRFx1NkRGMVx1ODI3MicsIGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J3AnLCBjdHJsS2V5OnRydWUsIHNoaWZ0S2V5OnRydWUsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3NldHRpbmdzIG9wZW4nLCBgdmFyIHM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNtZGsuc2V0dGluZ3MnKTtcbiAgICAgICAgcmV0dXJuIHtvazogISFzLCBkZXRhaWw6IHMgPyAnb3BlbicgOiAnbm90IG9wZW4nfTtgLCA1XzAwMCk7XG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jbWRrLnNldHRpbmdzIC5zZWcgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NkQ0NVx1ODI3Mid8fHgudGV4dENvbnRlbnQudHJpbSgpPT09J0xpZ2h0Jzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XG4gICAgICBjb25zdCBsaWdodCA9IGF3YWl0IHdhaXRGb3IoJ2xpZ2h0IHRoZW1lJywgYHZhciBkdD1kb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuZGF0YXNldC50aGVtZTtcbiAgICAgICAgdmFyIGJnID0gZ2V0Q29tcHV0ZWRTdHlsZShkb2N1bWVudC5ib2R5KS5iYWNrZ3JvdW5kQ29sb3I7XG4gICAgICAgIHZhciBtID0gL1xcXFxkKy9nOyB2YXIgbnVtcz0oYmcubWF0Y2gobSl8fFsnMCcsJzAnLCcwJ10pLm1hcChOdW1iZXIpO1xuICAgICAgICByZXR1cm4ge29rOiBkdD09PSdsaWdodCcgJiYgbnVtc1swXT4yMDAgJiYgbnVtc1sxXT4yMDAgJiYgbnVtc1syXT4yMDAsIGRldGFpbDogJ3RoZW1lPScrZHQrJyBiZz0nK2JnfTtgLCA1XzAwMCk7XG4gICAgICBhd2FpdCBzaG90KCdsaWdodC10aGVtZScpO1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jbWRrLnNldHRpbmdzIC5zZWcgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NkRGMVx1ODI3Mid8fHgudGV4dENvbnRlbnQudHJpbSgpPT09J0RhcmsnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIGNvbnN0IGRhcmsgPSBhd2FpdCB3YWl0Rm9yKCdkYXJrIGJhY2snLCBgcmV0dXJuIHtvazogZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LmRhdGFzZXQudGhlbWU9PT0nZGFyaycsIGRldGFpbDogJ3RoZW1lPScrZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LmRhdGFzZXQudGhlbWV9O2AsIDVfMDAwKTtcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J0VzY2FwZScsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xuICAgICAgcmV0dXJuIFtsaWdodFswXSAmJiBkYXJrWzBdLCBgbGlnaHQ6ICR7bGlnaHRbMV19OyBkYXJrOiAke2RhcmtbMV19YF07XG4gICAgfSk7XG5cbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU5ODc2XHU2ODBGIFx1NEUyRC9FTiBcdTVGRUJcdTYzNzdcdTUyMDdcdTYzNjIoXHU1M0VGXHU1M0QxXHU3M0IwXHU2MDI3KSA9PT09PT09PT09ICovXG4gICAgYXdhaXQgc3RlcCgnXHU5ODc2XHU2ODBGXHU1RkVCXHU2Mzc3XHU1MjA3XHU2MzYyOlx1NEUyRC9FTiBcdTRFMDBcdTk1MkVcdTUyMDdcdTYzNjInLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignbGFuZyBzZWcnLCBgdmFyIHM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmxhbmctc2VnJyk7XG4gICAgICAgIHJldHVybiB7b2s6ICEhcyAmJiBzLnF1ZXJ5U2VsZWN0b3JBbGwoJ2J1dHRvbicpLmxlbmd0aCA9PT0gMiwgZGV0YWlsOiBzID8gJ3ByZXNlbnQnIDogJ2Fic2VudCd9O2AsIDVfMDAwKTtcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmxhbmctc2VnIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdFTic7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xuICAgICAgY29uc3QgZW4gPSBhd2FpdCB3YWl0Rm9yKCdlbmdsaXNoJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyLWhlYWQgLmJ0bi5wcmltYXJ5Jyk7XG4gICAgICAgIHJldHVybiB7b2s6ICEhYiAmJiBiLnRleHRDb250ZW50ID09PSAnKyBOZXcgU2Vzc2lvbicsIGRldGFpbDogJ2J0bj0nKyhiP2IudGV4dENvbnRlbnQ6J25vbmUnKX07YCwgNV8wMDApO1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5sYW5nLXNlZyBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU0RTJEJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XG4gICAgICBjb25zdCB6aCA9IGF3YWl0IHdhaXRGb3IoJ2NoaW5lc2UgYmFjaycsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhci1oZWFkIC5idG4ucHJpbWFyeScpO1xuICAgICAgICByZXR1cm4ge29rOiAhIWIgJiYgYi50ZXh0Q29udGVudCA9PT0gJysgXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREJywgZGV0YWlsOiAnYnRuPScrKGI/Yi50ZXh0Q29udGVudDonbm9uZScpfTtgLCA1XzAwMCk7XG4gICAgICByZXR1cm4gW2VuWzBdICYmIHpoWzBdLCBgZW46ICR7ZW5bMV19OyB6aDogJHt6aFsxXX1gXTtcbiAgICB9KTtcblxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTdDOThcdThEMzRcdTU2RkVcdTcyNDcgXHUyMTkyIFx1N0YyOVx1NzU2NVx1NTZGRSBjaGlwIFx1MjE5MiBcdTUzRDFcdTkwMDEgXHUyMTkyIHJ1bnRpbWUgXHU2NTM2XHU1MjMwID09PT09PT09PT0gKi9cbiAgICBhd2FpdCBzdGVwKCdcdTdDOThcdThEMzRcdTU2RkVcdTcyNDc6XHU3RjI5XHU3NTY1XHU1NkZFIGNoaXAgKyBcdTUzRDFcdTkwMDFcdTU0MEUgcnVudGltZSBcdTY1MzZcdTUyMzBcdTU2RkVcdTcyNDcnLCBhc3luYyAoKSA9PiB7XG4gICAgICAvLyBcdTY1QjBcdTVFRkFcdTRGMUFcdThCRERcdTc4NkVcdTRGREQgY29tcG9zZXIgXHU1M0VGXHU3NTI4XG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OiduJywgY3RybEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcbiAgICAgIGF3YWl0IHNsZWVwKDMwMCk7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XG4gICAgICAgIHZhciB0YSA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jb21wb3NlciB0ZXh0YXJlYScpO1xuICAgICAgICBpZiAoIXRhKSByZXR1cm47XG4gICAgICAgIHZhciBjID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnY2FudmFzJyk7XG4gICAgICAgIGMud2lkdGggPSA4OyBjLmhlaWdodCA9IDg7XG4gICAgICAgIHZhciBjdHggPSBjLmdldENvbnRleHQoJzJkJyk7XG4gICAgICAgIGN0eC5maWxsU3R5bGUgPSAnIzNmOTY1MCc7IGN0eC5maWxsUmVjdCgwLCAwLCA4LCA4KTtcbiAgICAgICAgYy50b0Jsb2IoZnVuY3Rpb24oYmxvYil7XG4gICAgICAgICAgdmFyIGR0ID0gbmV3IERhdGFUcmFuc2ZlcigpO1xuICAgICAgICAgIGR0Lml0ZW1zLmFkZChuZXcgRmlsZShbYmxvYl0sICdwYXN0ZWQucG5nJywge3R5cGU6ICdpbWFnZS9wbmcnfSkpO1xuICAgICAgICAgIHRhLmRpc3BhdGNoRXZlbnQobmV3IENsaXBib2FyZEV2ZW50KCdwYXN0ZScsIHtjbGlwYm9hcmREYXRhOiBkdCwgYnViYmxlczogdHJ1ZSwgY2FuY2VsYWJsZTogdHJ1ZX0pKTtcbiAgICAgICAgfSwgJ2ltYWdlL3BuZycpO1xuICAgICAgfSkoKWApO1xuICAgICAgY29uc3QgY2hpcCA9IGF3YWl0IHdhaXRGb3IoJ2ltYWdlIGNoaXAnLCBgdmFyIG49ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmF0dC1jaGlwLmltZycpLmxlbmd0aDtcbiAgICAgICAgcmV0dXJuIHtvazogbiA+PSAxLCBkZXRhaWw6ICdpbWcgY2hpcHM9JytufTtgLCA2XzAwMCk7XG4gICAgICBpZiAoIWNoaXBbMF0pIHJldHVybiBjaGlwO1xuICAgICAgYXdhaXQgdHlwZUludG8oJy5jb21wb3NlciB0ZXh0YXJlYScsICdcdTc3MEJcdThGRDlcdTVGMjBcdTU2RkUnKTtcbiAgICAgIGF3YWl0IHNsZWVwKDIwMCk7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNvbXBvc2VyIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTUzRDFcdTkwMDEnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIGNvbnN0IGRvbmUgPSBhd2FpdCB3YWl0Rm9yKCdpbWFnZSBzZW50JywgYFxuICAgICAgICB2YXIgYXAgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuYXBwcm92YWwtY2FyZCBidXR0b24nKTtcbiAgICAgICAgaWYgKGFwICYmIGFwLnRleHRDb250ZW50LnRyaW0oKS5pbmRleE9mKCdcdTYyNzlcdTUxQzYnKT49MCkgYXAuY2xpY2soKTtcbiAgICAgICAgdmFyIHRzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnR1cm4nKSk7XG4gICAgICAgIHZhciBoaXQgPSB0cy5maWx0ZXIoZnVuY3Rpb24oeCl7IHJldHVybiB4LmNsYXNzTmFtZS5pbmRleE9mKCd1c2VyJyk8MCAmJiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1tpbWFnZXM6IDFdJykgPj0gMDsgfSk7XG4gICAgICAgIHJldHVybiB7b2s6IGhpdC5sZW5ndGggPj0gMSwgZGV0YWlsOiAncnVudGltZS1lY2hvLXdpdGgtaW1hZ2U9JytoaXQubGVuZ3RofTtcbiAgICAgIGAsIDE1XzAwMCk7XG4gICAgICBhd2FpdCBzaG90KCdwYXN0ZWQtaW1hZ2UnKTtcbiAgICAgIHJldHVybiBkb25lO1xuICAgIH0pO1xuXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1RDgzRFx1RENDRSBcdTRFMEFcdTRGMjAvXHVEODNEXHVEQ0MxIFx1NkQ0Rlx1ODlDOFx1NjMwOVx1OTRBRVx1NUMzMVx1NEY0RCA9PT09PT09PT09ICovXG4gICAgYXdhaXQgc3RlcCgnXHU5NjQ0XHU0RUY2XHU0RTBFXHU3NkVFXHU1RjU1XHU1MTY1XHU1M0UzOlx1RDgzRFx1RENDRSBcdTRFMEFcdTRGMjAgKyBcdUQ4M0RcdURDQzEgXHU2RDRGXHU4OUM4XHU2MzA5XHU5NEFFXHU1QjU4XHU1NzI4JywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgciA9IChhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XG4gICAgICAgIHZhciB1cCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jb21wb3NlciBidXR0b25bYXJpYS1sYWJlbCo9XCJcdTRFMEFcdTRGMjBcIl0sIC5jb21wb3NlciBidXR0b25bYXJpYS1sYWJlbCo9XCJVcGxvYWRcIl0nKTtcbiAgICAgICAgdmFyIGJyID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLXBpY2tlciBidXR0b24nKTtcbiAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHt1cDogISF1cCwgYnJvd3NlOiAhIWJyfSk7XG4gICAgICB9KSgpYCkpIGFzIHN0cmluZztcbiAgICAgIGNvbnN0IHAgPSBKU09OLnBhcnNlKHIpIGFzIHsgdXA6IGJvb2xlYW47IGJyb3dzZTogYm9vbGVhbiB9O1xuICAgICAgcmV0dXJuIFtwLnVwICYmIHAuYnJvd3NlLCBgXHVEODNEXHVEQ0NFPSR7cC51cH0gXHVEODNEXHVEQ0MxPSR7cC5icm93c2V9YF07XG4gICAgfSk7XG5cbiAgICAvKiA9PT09PT09PT09IGZha2U6QCBcdTk2NDRcdTRFRjZcdTkwMDlcdTYyRTlcdTU2NjggPT09PT09PT09PSAqL1xuICAgIGF3YWl0IHN0ZXAoJ0AgXHU5NjQ0XHU0RUY2Olx1OTAwOVx1NjJFOVx1NTY2OFx1NTFGQVx1NzNCMFx1NUU3Nlx1NTNFRlx1OTAwOVx1NjU4N1x1NEVGNicsIGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY29tcG9zZXIgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J0AnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdhdHQgcGlja2VyJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5hdHQtcGlja2VyJyk7XG4gICAgICAgIHJldHVybiB7b2s6ICEhcCwgZGV0YWlsOiBwID8gJ29wZW4nIDogJ25vdCBvcGVuJ307YCwgNV8wMDApO1xuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcbiAgICAgIGF3YWl0IHR5cGVJbnRvKCcuYXR0LXBpY2tlciBpbnB1dCcsICdyZWFkJyk7XG4gICAgICBjb25zdCB3MiA9IGF3YWl0IHdhaXRGb3IoJ2F0dCByZXN1bHRzJywgYHZhciByPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5hdHQtcmVzdWx0cyAuZnMtcm93JykubGVuZ3RoO1xuICAgICAgICByZXR1cm4ge29rOiByID49IDEsIGRldGFpbDogJ3Jlc3VsdHM9JytyfTtgLCA2XzAwMCk7XG4gICAgICBpZiAoIXcyWzBdKSByZXR1cm4gdzI7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBmPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5hdHQtcmVzdWx0cyAuZnMtcm93Jyk7IGlmKGYpIGYuY2xpY2soKTsgfSkoKWApO1xuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2F0dCBjaGlwJywgYHZhciBjPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5hdHQtY2hpcCcpLmxlbmd0aDtcbiAgICAgICAgcmV0dXJuIHtvazogYyA+PSAxLCBkZXRhaWw6ICdjaGlwcz0nK2N9O2AsIDVfMDAwKTtcbiAgICB9KTtcblxuICAgIGF3YWl0IHNob3QoJ2ZpbmFsJyk7XG4gIH0gZWxzZSB7XG4gICAgLyogPT09PT09PT09PSByZWFsOlx1NTNFQVx1OEJGQlx1NUI1MFx1OTZDNihcdTRFMERcdTUyQThcdTc3MUZcdTVCOUVcdTRGMUFcdThCREQpID09PT09PT09PT0gKi9cbiAgICBhd2FpdCBzdGVwKCdcdTk4NzZcdTY4MEY6cnVudGltZSBcdTcyNDhcdTY3MkNcdTRFMEVcdTdBRUZcdTUzRTNcdTVERjJcdTY2M0VcdTc5M0EoXHU5NzVFID8pJywgYXN5bmMgKCkgPT4ge1xuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2hvc3QgbGFiZWwnLCBgdmFyIGw9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmhvc3QtbGFiZWwnKTtcbiAgICAgICAgdmFyIHQgPSBsID8gbC50ZXh0Q29udGVudCA6ICcnO1xuICAgICAgICByZXR1cm4ge29rOiB0LmluZGV4T2YoJz8nKSA8IDAgJiYgdC5pbmRleE9mKCdydW50aW1lJykgPj0gMCwgZGV0YWlsOiB0LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw2MCl9O2AsIDE1XzAwMCk7XG4gICAgfSk7XG4gICAgYXdhaXQgc3RlcCgnXHU0RjFBXHU4QkREXHU1MjE3XHU4ODY4Olx1NzcxRlx1NUI5RVx1NTM4Nlx1NTNGMlx1NTJBMFx1OEY3RChcdTY1NzBcdTkxQ0Y+MCknLCBhc3luYyAoKSA9PiB7XG4gICAgICByZXR1cm4gd2FpdEZvcignc2Vzc2lvbnMnLCBgdmFyIG49ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aDtcbiAgICAgICAgcmV0dXJuIHtvazogbiA+IDAsIGRldGFpbDogJ3Nlc3Npb25zPScrbn07YCwgMTVfMDAwKTtcbiAgICB9KTtcbiAgICBhd2FpdCBzdGVwKCdcdTcwQjlcdTUxRkJcdTUzODZcdTUzRjJcdTRGMUFcdThCREQgXHUyMTkyIFx1NzcxRlx1NUI5RSB0cmFuc2NyaXB0IFx1NTE4NVx1NUJCOVx1NTNFRlx1ODlDMScsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IG4gPSAoYXdhaXQganMoYGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGhgKSkgYXMgbnVtYmVyO1xuICAgICAgaWYgKG4gPT09IDApIHJldHVybiBbZmFsc2UsICdubyBzZXNzaW9ucyB0byBjbGljayddO1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgaXQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNlc3Npb24taXRlbScpOyBpZiAoaXQpIGl0LmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdoaXN0b3J5IHR1cm5zJywgYHZhciB0cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50dXJuJykpO1xuICAgICAgICByZXR1cm4ge29rOiB0cy5sZW5ndGggPj0gMSwgZGV0YWlsOiAndHVybnM9Jyt0cy5sZW5ndGgrJyBmaXJzdD0nKyh0c1swXT90c1swXS50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNDApOidub25lJyl9O2AsIDE1XzAwMCk7XG4gICAgICBhd2FpdCBzaG90KCdyZWFsLWhpc3RvcnknKTtcbiAgICAgIHJldHVybiB3O1xuICAgIH0pO1xuICAgIGF3YWl0IHN0ZXAoJ0RvY2s6T3ZlcnZpZXcgXHU3NzFGXHU1QjlFXHU2NTcwXHU2MzZFKHJ1bnRpbWUgXHU3MjQ4XHU2NzJDXHU5NzVFXHU2NUUwXHU2NTcwXHU2MzZFKScsIGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdPdmVydmlldyc7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xuICAgICAgcmV0dXJuIHdhaXRGb3IoJ292ZXJ2aWV3JywgYHZhciByb3dzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stcm93JykpO1xuICAgICAgICB2YXIgdmVyID0gcm93cy5maW5kKGZ1bmN0aW9uKHIpeyByZXR1cm4gci50ZXh0Q29udGVudC5pbmRleE9mKCdydW50aW1lIFx1NzI0OFx1NjcyQycpPj0wOyB9KTtcbiAgICAgICAgcmV0dXJuIHtvazogISF2ZXIgJiYgdmVyLnRleHRDb250ZW50LmluZGV4T2YoJ1x1NjVFMFx1NjU3MFx1NjM2RScpIDwgMCwgZGV0YWlsOiB2ZXIgPyB2ZXIudGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDUwKSA6ICdubyB2ZXIgcm93J307YCwgMTBfMDAwKTtcbiAgICB9KTtcbiAgICBhd2FpdCBzdGVwKCdEb2NrOkRpZmYgXHU3NzFGXHU1QjlFIGdpdCBcdTcyQjZcdTYwMDEoXHU5NzVFXHU1MkEwXHU4RjdEXHU0RTJEKScsIGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdcdTUzRDhcdTY2RjQnfHx4LnRleHRDb250ZW50PT09J0RpZmYnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdkaWZmJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5kaWZmLXBhbmUnKTtcbiAgICAgICAgdmFyIHQgPSBwID8gcC50ZXh0Q29udGVudCA6ICcnO1xuICAgICAgICByZXR1cm4ge29rOiAhIXAgJiYgdC5pbmRleE9mKCdcdTUyQTBcdThGN0RcdTRFMkQnKSA8IDAsIGRldGFpbDogdC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNjApfTtgLCAxNV8wMDApO1xuICAgIH0pO1xuICAgIGF3YWl0IHN0ZXAoJ0RvY2s6RXZpZGVuY2UgXHU3NzFGXHU1QjlFXHU4QkE0XHU3N0U1XHU2NTcwXHU2MzZFJywgYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J1x1OEJDMVx1NjM2RSd8fHgudGV4dENvbnRlbnQ9PT0nRXZpZGVuY2UnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdldmlkZW5jZScsIGB2YXIgcm93cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXJvdycpKTtcbiAgICAgICAgdmFyIG1lbSA9IHJvd3MuZmluZChmdW5jdGlvbihyKXsgcmV0dXJuIHIudGV4dENvbnRlbnQuaW5kZXhPZignXHU4QkIwXHU1RkM2XHU1QzQyJyk+PTAgfHwgci50ZXh0Q29udGVudC5pbmRleE9mKCdNZW1vcnkgbGF5ZXJzJyk+PTA7IH0pO1xuICAgICAgICByZXR1cm4ge29rOiAhIW1lbSAmJiBtZW0udGV4dENvbnRlbnQuaW5kZXhPZignXHUyMDI2JykgPCAwLCBkZXRhaWw6IG1lbSA/IG1lbS50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNTApIDogJ25vIHJvdyd9O2AsIDE1XzAwMCk7XG4gICAgfSk7XG4gICAgYXdhaXQgc3RlcCgnXHU5NjQ0XHU0RUY2XHU0RTBFXHU3NkVFXHU1RjU1XHU1MTY1XHU1M0UzOlx1RDgzRFx1RENDRSBcdTRFMEFcdTRGMjAgKyBcdTk4NzZcdTY4MEZcdTRFMkQvRU4gKyBcdUQ4M0RcdURDQzEgXHU2RDRGXHU4OUM4XHU2MzA5XHU5NEFFXHU1QjU4XHU1NzI4JywgYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J1x1NjU4N1x1NEVGNid8fHgudGV4dENvbnRlbnQ9PT0nRmlsZXMnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIGF3YWl0IHdhaXRGb3IoJ2ZpbGVzIHRhYicsIGB2YXIgdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuZG9jay10YWIuYWN0aXZlJyk7XG4gICAgICAgIHJldHVybiB7b2s6ICEhdCAmJiAodC50ZXh0Q29udGVudD09PSdcdTY1ODdcdTRFRjYnfHx0LnRleHRDb250ZW50PT09J0ZpbGVzJyksIGRldGFpbDogJ2FjdGl2ZT0nKyh0P3QudGV4dENvbnRlbnQ6J25vbmUnKX07YCwgNV8wMDApO1xuICAgICAgLy8gcmVhbCBcdTZBMjFcdTVGMEYgd29ya3NwYWNlcyBcdThCRjdcdTZDNDJcdThENzAgcnVudGltZShcdTUxQjdcdTU0MkZcdTUyQThcdTU0MEVcdTUzRUZcdTgwRkRcdTYzOTJcdTk2MUYpLFx1NjUzRVx1NUJCRFx1NTIzMCAxNXNcbiAgICAgIGNvbnN0IHdzID0gYXdhaXQgd2FpdEZvcignd3MgcGlja2VyJywgYHZhciB3PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1waWNrZXInKTtcbiAgICAgICAgcmV0dXJuIHtvazogISF3LCBkZXRhaWw6IHcgPyAnbG9hZGVkJyA6ICd3b3Jrc3BhY2VzIG5vdCBsb2FkZWQgeWV0J307YCwgbW9kZSA9PT0gJ3JlYWwnID8gMTVfMDAwIDogNl8wMDApO1xuICAgICAgY29uc3QgciA9IChhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XG4gICAgICAgIHZhciB1cCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jb21wb3NlciBidXR0b25bYXJpYS1sYWJlbCo9XCJcdTRFMEFcdTRGMjBcIl0sIC5jb21wb3NlciBidXR0b25bYXJpYS1sYWJlbCo9XCJVcGxvYWRcIl0nKTtcbiAgICAgICAgdmFyIGxhbmcgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcubGFuZy1zZWcnKTtcbiAgICAgICAgdmFyIGJyID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLXBpY2tlciBidXR0b24nKTtcbiAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHt1cDogISF1cCwgbGFuZzogISFsYW5nLCBicm93c2U6ICEhYnJ9KTtcbiAgICAgIH0pKClgKSkgYXMgc3RyaW5nO1xuICAgICAgY29uc3QgcCA9IEpTT04ucGFyc2UocikgYXMgeyB1cDogYm9vbGVhbjsgbGFuZzogYm9vbGVhbjsgYnJvd3NlOiBib29sZWFuIH07XG4gICAgICByZXR1cm4gW3AudXAgJiYgcC5sYW5nICYmIHAuYnJvd3NlLCBgXHVEODNEXHVEQ0NFPSR7cC51cH0gXHU0RTJEL0VOPSR7cC5sYW5nfSBcdUQ4M0RcdURDQzE9JHtwLmJyb3dzZX07ICR7d3NbMV19YF07XG4gICAgfSk7XG4gICAgLyogPT09PT09PT09PSByZWFsOlx1NzcxRlx1NUI5RVx1NEVGQlx1NTJBMVx1N0FFRlx1NTIzMFx1N0FFRlx1OTk5Nlx1OUE4QyhcdTUzRDFcdTc3RURcdTRFRkJcdTUyQTFcdTIxOTJcdTZBMjFcdTU3OEJcdTU2REVcdTU5MEQpID09PT09PT09PT1cbiAgICAgICBcdTc1MjhcdTYyMzcgZ2xtLTUuMyBcdTVERjJcdTkxNERcdTdGNkU7XHU2M0QwXHU3OTNBXHU4QkNEXHU3RUE2XHU2NzVGXHU3NkY0XHU2M0E1XHU1NkRFXHU1OTBEXHUzMDAyXHU4MkU1IGFnZW50IFx1OEJGN1x1NkM0Mlx1NUJBMVx1NjI3OSxcdThGNkVcdThCRTJcdTkxQ0NcbiAgICAgICBcdTgxRUFcdTUyQThcdTcwQjlcdTYyNzlcdTUxQzYoXHU2NzAwXHU1OTFBXHU4OUMxXHU1MzYxXHU1MzczXHU3MEI5LFx1NUU0Mlx1N0I0OSlcdTMwMDJcdThEODVcdTY1RjYgMTUwc1x1MzAwMiAqL1xuICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9SRUFMX1RBU0sgPT09ICcxJykge1xuICAgICAgYXdhaXQgc3RlcCgnXHU3NzFGXHU1QjlFXHU0RUZCXHU1MkExOlx1NTNEMVx1OTAwMVx1MjE5Mlx1NkEyMVx1NTc4Qlx1NTZERVx1NTkwRChcdTdBRUZcdTUyMzBcdTdBRUZcdTk5OTZcdTlBOEMpJywgYXN5bmMgKCkgPT4ge1xuICAgICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OiduJywgY3RybEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcbiAgICAgICAgYXdhaXQgc2xlZXAoNDAwKTtcbiAgICAgICAgYXdhaXQgdHlwZUludG8oJy5jb21wb3NlciB0ZXh0YXJlYScsICdcdThCRjdcdTUzRUFcdTU2REVcdTU5MERcdTRFMjRcdTRFMkFcdTVCNTc6XHU2NTM2XHU1MjMwKFx1NjcyQ1x1NkIyMVx1OUE4Q1x1NjUzNlx1NEVGQlx1NTJBMSxcdTRFMERcdTg5ODFcdTRGN0ZcdTc1MjhcdTRFRkJcdTRGNTVcdTVERTVcdTUxNzcsXHU3NkY0XHU2M0E1XHU1NkRFXHU1OTBEKScpO1xuICAgICAgICBhd2FpdCBzbGVlcCgyMDApO1xuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNvbXBvc2VyIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTUzRDFcdTkwMDEnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcbiAgICAgICAgY29uc3Qgc2VudCA9IGF3YWl0IHdhaXRGb3IoJ3VzZXIgdHVybicsIGB2YXIgdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudHVybi51c2VyJyk7XG4gICAgICAgICAgdmFyIHMgPSAodCAmJiB0LnRleHRDb250ZW50KSA/IFN0cmluZyh0LnRleHRDb250ZW50KSA6ICcnO1xuICAgICAgICAgIHJldHVybiB7b2s6IHMuaW5kZXhPZignXHU2NTM2XHU1MjMwJyk+PTAgfHwgcy5pbmRleE9mKCdcdTlBOENcdTY1MzZcdTRFRkJcdTUyQTEnKT49MCwgZGV0YWlsOiBzLnNsaWNlKDAsMzApIHx8ICdub25lJ307YCwgMTBfMDAwKTtcbiAgICAgICAgaWYgKCFzZW50WzBdKSByZXR1cm4gc2VudDtcbiAgICAgICAgY29uc3QgcmVwbHkgPSBhd2FpdCB3YWl0Rm9yKCdhc3Npc3RhbnQgcmVwbHknLCBgXG4gICAgICAgICAgdmFyIGFwID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmFwcHJvdmFsLWNhcmQgYnV0dG9uJyk7XG4gICAgICAgICAgaWYgKGFwICYmIGFwLnRleHRDb250ZW50LnRyaW0oKS5pbmRleE9mKCdcdTYyNzlcdTUxQzYnKT49MCkgYXAuY2xpY2soKTtcbiAgICAgICAgICB2YXIgdHM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudHVybicpKS5maWx0ZXIoZnVuY3Rpb24oeCl7IHJldHVybiB4LmNsYXNzTmFtZS5pbmRleE9mKCd1c2VyJyk8MCAmJiB4LmNsYXNzTmFtZS5pbmRleE9mKCdhcHByb3ZhbCcpPDAgJiYgeC5jbGFzc05hbWUuaW5kZXhPZignc3lzdGVtJyk8MCAmJiB4LnRleHRDb250ZW50LnRyaW0oKS5sZW5ndGg+MCAmJiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1NTZERVx1NTQwOCcpPDA7IH0pO1xuICAgICAgICAgIHZhciBzdW0gPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudHVybi1zdW0nKTtcbiAgICAgICAgICByZXR1cm4ge29rOiB0cy5sZW5ndGg+PTEgJiYgISFzdW0sIGRldGFpbDogJ2Fzc2lzdGFudD0nK3RzLmxlbmd0aCsnIHN1bT0nKyhzdW0/c3VtLnRleHRDb250ZW50Oidub25lJykrJyBmaXJzdD0nKyh0c1swXT90c1swXS50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNDApOidub25lJyl9O1xuICAgICAgICBgLCAxNTBfMDAwKTtcbiAgICAgICAgYXdhaXQgc2hvdCgncmVhbC10YXNrJyk7XG4gICAgICAgIHJldHVybiByZXBseTtcbiAgICAgIH0pO1xuICAgIH1cbiAgICBhd2FpdCBzdGVwKCdcdTRGMUFcdThCRERcdTUyMDZcdTdFQzQ6XHU1REU2XHU2ODBGXHU2MzA5XHU1REU1XHU0RjVDXHU1MzNBXHU1MjA2XHU3RUM0KFx1N0VDNFx1NTkzNFx1NTNFRlx1ODlDMSknLCBhc3luYyAoKSA9PiB7XG4gICAgICByZXR1cm4gd2FpdEZvcignZ3JvdXAgaGVhZCcsIGB2YXIgaD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtZ3JvdXAtaGVhZCcpO1xuICAgICAgICB2YXIgbiA9IGggPyAoaC5xdWVyeVNlbGVjdG9yKCcud3MtZ3JvdXAtbmFtZScpfHx7fSkudGV4dENvbnRlbnQgOiAnJztcbiAgICAgICAgcmV0dXJuIHtvazogISFoICYmIG4ubGVuZ3RoID4gMCwgZGV0YWlsOiAnbmFtZT0nK259O2AsIDE1XzAwMCk7XG4gICAgfSk7XG4gICAgYXdhaXQgc3RlcCgnXHU1REU1XHU0RjVDXHU1MzNBOlx1NURFNlx1NjgwRlx1NURFNVx1NEY1Q1x1NTMzQVx1NjgwRlx1NTNFRlx1ODlDMShcdTc3MUZcdTVCOUVcdTVERTVcdTRGNUNcdTUzM0FcdTU0MEQpJywgYXN5bmMgKCkgPT4ge1xuICAgICAgcmV0dXJuIHdhaXRGb3IoJ3dvcmtzcGFjZSBiYXInLCBgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndvcmtzcGFjZS1iYXInKTtcbiAgICAgICAgdmFyIG4gPSBiID8gKGIucXVlcnlTZWxlY3RvcignLndzLWJhci1uYW1lJyl8fHt9KS50ZXh0Q29udGVudCA6ICcnO1xuICAgICAgICByZXR1cm4ge29rOiAhIWIgJiYgISFuICYmIG4ubGVuZ3RoID4gMCAmJiBuLmluZGV4T2YoJ1x1NTJBMFx1OEY3RCcpIDwgMCAmJiBuLmluZGV4T2YoJ0xvYWRpbmcnKSA8IDAsIGRldGFpbDogJ25hbWU9JytufTtgLCAxNV8wMDApO1xuICAgIH0pO1xuICAgIGF3YWl0IHNob3QoJ2ZpbmFsJyk7XG4gIH1cblxuICBjb25zdCBmYWlsZWQgPSByZXN1bHRzLmZpbHRlcigocikgPT4gIXJbMV0pLmxlbmd0aDtcbiAgY29uc29sZS5sb2coYFVJVkVSSUZZIFNVTU1BUlkgcGFzcz0ke3Jlc3VsdHMubGVuZ3RoIC0gZmFpbGVkfS8ke3Jlc3VsdHMubGVuZ3RofSBtb2RlPSR7bW9kZX0gc2hvdHM9JHtzaG90c31gKTtcbiAgYXBwLmV4aXQoZmFpbGVkID09PSAwID8gMCA6IDEpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYXR0YWNoVWlWZXJpZnkod2luOiBCcm93c2VyV2luZG93KTogdm9pZCB7XG4gIGNvbnN0IG1vZGUgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9NT0RFID09PSAncmVhbCcgPyAncmVhbCcgOiAnZmFrZSc7XG4gIHdpbi53ZWJDb250ZW50cy5vbmNlKCdkaWQtZmluaXNoLWxvYWQnLCAoKSA9PiB7XG4gICAgLy8gXHU3RUQ5IGhvc3QgXHU1NDJGXHU1MkE4XHU3NTU5XHU2NUY2XHU5NUY0O1x1NkI2NVx1OUFBNFx1NTE4NVx1OTBFOFx1NTQwNFx1ODFFQVx1OEY2RVx1OEJFMlx1N0I0OVx1NUY4NVxuICAgIHNldFRpbWVvdXQoKCkgPT4geyB2b2lkIHJ1blVpVmVyaWZ5KHdpbiwgbW9kZSk7IH0sIDNfMDAwKTtcbiAgfSk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiO0FBY0EsU0FBUyxPQUFBQSxNQUFLLGVBQWUsUUFBUSxTQUFTLFNBQVMsT0FBTyxNQUFNLGNBQWMsTUFBTSxhQUFhLG1CQUFtQjtBQUN4SCxTQUFTLFFBQUFDLE9BQU0sU0FBUyxZQUFZLGVBQWU7QUFDbkQsU0FBUyxZQUFZLGdCQUFBQyxxQkFBb0I7QUFDekMsU0FBUyxhQUFBQyxZQUFXLGdCQUFnQjtBQUNwQyxTQUFTLFNBQVMseUJBQXlCO0FBQzNDLFNBQVMsY0FBYyxTQUFBQyxjQUFhO0FBQ3BDLFNBQVMsaUJBQUFDLHNCQUFxQjs7O0FDVjlCLFNBQVMsYUFBZ0M7QUFDekMsU0FBUyx1QkFBdUI7QUFDaEMsU0FB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LFFBQVEsRUFBRSxRQUFRLEVBQUU7QUFBQSxJQUNqRyxDQUFDO0FBRUQsUUFBSSxTQUFTO0FBQ2IsZUFBVyxDQUFDLE1BQU0sSUFBSSxNQUFNLEtBQUssU0FBUztBQUN4QyxjQUFRLElBQUksaUJBQWlCLEtBQUssU0FBUyxNQUFNLE1BQU0sSUFBSSxNQUFNLE9BQU8sTUFBTSxDQUFDLEVBQUU7QUFDakYsVUFBSSxDQUFDLEdBQUksV0FBVTtBQUFBLElBQ3JCO0FBQ0EsWUFBUSxJQUFJLDhCQUE4QixRQUFRLFNBQVMsTUFBTSxJQUFJLFFBQVEsTUFBTSxFQUFFO0FBQ3JGLElBQUFBLEtBQUksS0FBSyxXQUFXLElBQUksSUFBSSxDQUFDO0FBQUEsRUFDL0I7QUFHQSxFQUFBQSxLQUFJLEdBQUcsZUFBZSxDQUFDLE1BQU07QUFDM0IsUUFBSSxlQUFlLFFBQVEsV0FBVyxVQUFVLFdBQVc7QUFDekQsUUFBRSxlQUFlO0FBQ2pCLGdCQUFVLE1BQU07QUFDaEIsV0FBSyxXQUFXLEtBQUssRUFBRSxRQUFRLE1BQU1BLEtBQUksS0FBSyxDQUFDO0FBQUEsSUFDakQ7QUFBQSxFQUNGLENBQUM7QUFDRCxFQUFBQSxLQUFJLEdBQUcscUJBQXFCLE1BQU07QUFDaEMsUUFBSSxRQUFRLGFBQWEsU0FBVSxDQUFBQSxLQUFJLEtBQUs7QUFBQSxFQUM5QyxDQUFDO0FBQ0g7QUF2b0NXO0FBeUJBO0FBT0E7QUFlQTtBQTRCQTtBQTBGQTtBQW1CQTtBQTRCQTtBQTREQTtBQVVBO0FBZUE7QUFPQTtBQWNBO0FBNERBO0FBeUNBO0FBaUJBO0FBaUdBO0FBWUE7QUFXQTsiLAogICJuYW1lcyI6IFsiYXBwIiwgImpvaW4iLCAicmVhbHBhdGhTeW5jIiwgIndyaXRlRmlsZSIsICJzcGF3biIsICJwYXRoVG9GaWxlVVJMIiwgInJlc29sdmUiLCAicmFuZG9tVVVJRCIsICJyYW5kb21VVUlEIiwgInJlc29sdmUiLCAiam9pbiIsICJhcHAiLCAicHVzaEV2ZW50IiwgIm5vdGlmeUV2ZW50IiwgImZvY3VzTWFpbldpbmRvdyIsICJzZXR1cFRyYXkiLCAiYXBwbHlDaHJvbWUiLCAiYXBwbHlVcGRhdGUiLCAic3Bhd24iLCAiYnVpbGRBcHBNZW51IiwgInBvcHVwTWFpbk1lbnUiLCAid2ViQXV0b3N0YXJ0SW5zdGFsbGVkIiwgImxhbklwT2YiLCAiY2xpRW50cnlPZiIsICJyZXBvUm9vdE9mIiwgInJ1bkNsaSIsICJicm9hZGNhc3RIb3N0U3RhdGUiLCAiZGV0ZWN0UmVhbEVudHJ5IiwgInJlYWxwYXRoU3luYyIsICJidW5kbGVkUnVudGltZVBhdGgiLCAic2VuZGVyVHJ1c3RlZCIsICJob3N0Q2FsbCIsICJyZWdpc3RlcklwYyIsICJ3cml0ZUZpbGUiLCAicGF0aFRvRmlsZVVSTCIsICJhcHAyIl0KfQo=
