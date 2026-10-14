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
        return {ok: !!p && (t.indexOf('\u624B\u673A\u8FDC\u7A0B\u63A7\u5236')>=0 || t.indexOf('Phone remote')>=0), detail: t.replace(/\\s+/g,' ').slice(0,50)};`, 6e3);
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
        label: "\u5173\u4E8E HMH Desktop",
        click: () => {
          void dialog.showMessageBox(win, {
            type: "info",
            title: "\u5173\u4E8E HMH Desktop",
            message: "HMH Desktop",
            detail: `\u672C\u5730\u4F18\u5148\u7684 HMH Agent \u56FE\u5F62\u5DE5\u4F5C\u53F0
runtime: hmharness ${bridge.hostVersion ?? "(\u672A\u8FDE\u63A5)"}
\u6A21\u5F0F: ${bridge.mode === "real" ? "\u771F\u5B9E hmharness" : "\u6F14\u793A(\u5047\u6570\u636E)"}

\u4E0E CLI / TUI / \u7F51\u9875\u7248\u5171\u4EAB\u540C\u4E00 HMH_HOME\u3002`
          });
        }
      },
      { label: "\u9000\u51FA", role: "quit" }
    ]).popup({ window: win });
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
      return { up: p.up, version: p.version, lanIp: lanIpOf2(), port: WEB_PORT, available: cliEntryOf2() !== "" };
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
  pushEvent = pushEvent2, focusMainWindow = focusMainWindow2, setupTray = setupTray2, notifyEvent = notifyEvent2, applyChrome = applyChrome2, buildAppMenu = buildAppMenu2, popupMainMenu = popupMainMenu2, lanIpOf = lanIpOf2, cliEntryOf = cliEntryOf2, runCli = runCli2, broadcastHostState = broadcastHostState2, detectRealEntry = detectRealEntry2, repoRootOf = repoRootOf2, senderTrusted = senderTrusted2, hostCall = hostCall2, registerIpc = registerIpc2;
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
  const chromeFor = (dark) => dark ? { color: "#1b1d21", symbolColor: "#f5f5f6" } : { color: "#f6f7f9", symbolColor: "#1f2328" };
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
  async function startHost() {
    const repoRoot = join2(here, "..", "..", "..", "..");
    const packaged = app2.isPackaged;
    const forceFake = process.env.HMH_DESKTOP_FAKE === "1";
    const override = await loadRuntimeEntryOverride();
    runtimeEntry = forceFake ? "" : override !== "" ? override : packaged ? detectRealEntry2() : join2(repoRoot, "..", "hmharness", "packages", "web", "src", "desktop-host.ts");
    const useReal = runtimeEntry !== "" && existsSync(runtimeEntry);
    bridge = { ...bridge, mode: useReal ? "real" : "fake", runtimeEntry: useReal ? runtimeEntry : null };
    let spec;
    if (useReal) {
      const repo = repoRootOf2(runtimeEntry);
      spec = {
        command: process.execPath,
        args: ["--import", "tsx", runtimeEntry],
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
        logInfo("host", `bridge ready on 127.0.0.1:${ep.port} (runtime ${ep.version}, mode ${bridge.mode}${useReal ? `, entry=${runtimeEntry}` : ""})`);
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
      backgroundColor: "#141416",
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
      const allow = ["approve", "approvalGet", "approvalSet", "browseRuntime", "chromeTheme", "cognitive", "diff", "exportSession", "fsList", "fsRead", "fsSearch", "getState", "inject", "interrupt", "modelSet", "onEventBatches", "onHostState", "onMenuAction", "onStreamChunks", "pickDirectory", "pickFiles", "popupMainMenu", "providerSave", "providers", "remoteWebStart", "remoteWebStatus", "remoteWebStop", "runtimeInfo", "sendTask", "sessionOp", "sessionPreview", "sessions", "setRuntime", "stopHost", "workspaces", "workspaceAdd", "workspaceUse"];
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
var buildAppMenu;
var popupMainMenu;
var lanIpOf;
var cliEntryOf;
var runCli;
var broadcastHostState;
var detectRealEntry;
var repoRootOf;
var senderTrusted;
var hostCall;
var registerIpc;
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vZWxlY3Ryb24vbWFpbi9pbmRleC50cyIsICIuLi8uLi8uLi8uLi9wYWNrYWdlcy9ob3N0LWFkYXB0ZXIvc3JjL3N1cGVydmlzb3IudHMiLCAiLi4vLi4vLi4vLi4vcGFja2FnZXMvY29udHJhY3RzL3NyYy9ldmVudC50cyIsICIuLi8uLi8uLi8uLi9wYWNrYWdlcy9jb250cmFjdHMvc3JjL2Vycm9yLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2NvbnRyYWN0cy9zcmMvZ3VhcmRzLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2hvc3QtYWRhcHRlci9zcmMvY2xpZW50LnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2hvc3QtYWRhcHRlci9zcmMvZmFrZS1ob3N0LnRzIiwgIi4uLy4uL2VsZWN0cm9uL21haW4vdWl2ZXJpZnkudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogSE1IIERlc2t0b3AgXHUyMDE0IEVsZWN0cm9uIFx1NEUzQlx1OEZEQlx1N0EwQihBRFItMDAxLzAwMy8wMDQpXHUzMDAyXG4gKlxuICogXHU1Qjg5XHU1MTY4XHU0RTBEXHU1M0Q4XHU5MUNGKFx1NUYwMFx1NTNEMVx1OEJBMVx1NTIxMiBNMCBcdTUxRkFcdTUzRTNcdTk1RTggKyBFbGVjdHJvbiBcdTVCOThcdTY1QjlcdTVCODlcdTUxNjhcdTZFMDVcdTUzNTUpOlxuICogIC0gcmVuZGVyZXI6Y29udGV4dElzb2xhdGlvbiArIHNhbmRib3ggKyBcdTc5ODEgbm9kZUludGVncmF0aW9uLFx1NEUyNVx1NjgzQyBDU1A7XG4gKiAgLSBcdTVCRkNcdTgyMkEvXHU2NUIwXHU3QTk3XHU1M0UzXHU0RTAwXHU1RjhCXHU2MkQyXHU3RUREKFx1NTNFQVx1NTJBMFx1OEY3RFx1NjIxMVx1NEVFQ1x1ODFFQVx1NURGMVx1NzY4NCByZW5kZXJlcik7XG4gKiAgLSBcdTZCQ0ZcdTY3NjEgSVBDIFx1NjgyMVx1OUE4QyBzZW5kZXIgXHU3Njg0XHU5ODc2XHU1QzQyIGZyYW1lIFVSTCBcdTVDNUVcdTRFOEVcdTY3MkNcdTVFOTRcdTc1MjgsXHU5MDFBXHU5MDUzXHU3NjdEXHU1NDBEXHU1MzU1O1xuICogIC0gaG9zdCB0b2tlbiBcdTUzRUFcdTVCNThcdTU3MjhcdTRFOEVcdTY3MkNcdThGREJcdTdBMEJcdTRFMEVcdTVCNTBcdThGREJcdTdBMEIgZW52LFx1NjVFNVx1NUZEN1x1OEY5M1x1NTFGQVx1NTI0RFx1NTE0OFx1ODEzMVx1NjU0RjtcbiAqICAtIFx1NTM1NVx1NUI5RVx1NEY4Qlx1OTUwMTtcdTkwMDBcdTUxRkFcdTY1RjZcdTUzRUFcdTUwNUNcdTZCNjJcdTgxRUFcdTVERjEgc3Bhd24gXHU3Njg0IGhvc3QoXHU0RjE4XHU5NkM1XHUyMTkyXHU1MTVDXHU1RTk1IGtpbGwpXHUzMDAyXG4gKlxuICogXHU5NjM2XHU2QkI1RSgyMDI2LTEwLTEwKTptYWluIFx1NjMwMVx1NjcwOSBEZXNrdG9wSG9zdENsaWVudCxTU0UgXHU0RkUxXHU1QzAxXHU2RDQxKGV2ZW50OiBobWgpXG4gKiBcdTdFQ0YgNTBtcyBcdTYyNzlcdTkxQ0ZcdTYzQThcdTdFRDkgcmVuZGVyZXI7c2VuZFRhc2svYXBwcm92ZS9pbnRlcnJ1cHQvc2Vzc2lvbnMgXHU1MTY4XHU5MEU4XHU4RjZDXHU1M0QxXG4gKiBcdTdFRDkgaG9zdCBcdTIwMTRcdTIwMTQgZmFrZSBcdTRFMEVcdTc3MUZcdTVCOUUgaG1oYXJuZXNzIGRlc2t0b3AtaG9zdCBcdThENzBcdTU0MENcdTRFMDBcdTY3NjFcdTRFRTNcdTc4MDFcdThERUZcdTVGODRcdTMwMDJcbiAqL1xuaW1wb3J0IHsgYXBwLCBCcm93c2VyV2luZG93LCBkaWFsb2csIGlwY01haW4sIHNlc3Npb24sIHNoZWxsLCBUcmF5LCBOb3RpZmljYXRpb24sIE1lbnUsIG5hdGl2ZUltYWdlLCBuYXRpdmVUaGVtZSB9IGZyb20gJ2VsZWN0cm9uJztcbmltcG9ydCB7IGpvaW4sIGRpcm5hbWUsIGlzQWJzb2x1dGUsIHJlc29sdmUgfSBmcm9tICdub2RlOnBhdGgnO1xuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhbHBhdGhTeW5jIH0gZnJvbSAnbm9kZTpmcyc7XG5pbXBvcnQgeyB3cml0ZUZpbGUsIHJlYWRGaWxlIH0gZnJvbSAnbm9kZTpmcy9wcm9taXNlcyc7XG5pbXBvcnQgeyBob21lZGlyLCBuZXR3b3JrSW50ZXJmYWNlcyB9IGZyb20gJ25vZGU6b3MnO1xuaW1wb3J0IHsgZXhlY0ZpbGVTeW5jLCBzcGF3biB9IGZyb20gJ25vZGU6Y2hpbGRfcHJvY2Vzcyc7XG5pbXBvcnQgeyBwYXRoVG9GaWxlVVJMIH0gZnJvbSAnbm9kZTp1cmwnO1xuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gJ25vZGU6Y3J5cHRvJztcbmltcG9ydCB7IERlc2t0b3BSdW50aW1lU3VwZXJ2aXNvciwgRGVza3RvcEhvc3RDbGllbnQsIGVudmVsb3BlRnJvbUZyYW1lLCB0eXBlIEhvc3RTdGF0ZSB9IGZyb20gJ0BobWgtZGVza3RvcC9ob3N0LWFkYXB0ZXInO1xuaW1wb3J0IHsgaXNFdmVudEVudmVsb3BlLCB0eXBlIEV2ZW50RW52ZWxvcGUgfSBmcm9tICdAaG1oLWRlc2t0b3AvY29udHJhY3RzJztcbmltcG9ydCB7IGF0dGFjaFVpVmVyaWZ5IH0gZnJvbSAnLi91aXZlcmlmeS50cyc7XG5cbmNvbnN0IGhlcmUgPSBpbXBvcnQubWV0YS5kaXJuYW1lID8/ICcuJztcbmNvbnN0IGlzRGV2ID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfREVWID09PSAnMSc7XG5jb25zdCByZW5kZXJlckRldlVybCA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1JFTkRFUkVSX1VSTCA/PyAnJztcbmNvbnN0IHByZWxvYWRQYXRoID0gam9pbihoZXJlLCAnLi4vcHJlbG9hZC9pbmRleC5janMnKTtcblxuLyogLS0tLSBcdTY1RTVcdTVGRDdcdTgxMzFcdTY1NEY6dG9rZW4vYXV0aG9yaXphdGlvbiBcdTZDMzhcdTRFMERcdThGREJcdTYzQTdcdTUyMzZcdTUzRjAgLS0tLSAqL1xuY29uc3Qgc2VjcmV0czogc3RyaW5nW10gPSBbXTtcbmZ1bmN0aW9uIHJlZGFjdChzOiBzdHJpbmcpOiBzdHJpbmcge1xuICBsZXQgb3V0ID0gcztcbiAgZm9yIChjb25zdCBzZWMgb2Ygc2VjcmV0cykge1xuICAgIGlmIChzZWMubGVuZ3RoID49IDgpIG91dCA9IG91dC5zcGxpdChzZWMpLmpvaW4oJ1tyZWRhY3RlZF0nKTtcbiAgfVxuICByZXR1cm4gb3V0O1xufVxuZnVuY3Rpb24gbG9nSW5mbyh0YWc6IHN0cmluZywgbXNnOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc29sZS5sb2coYFtobWgtZGVza3RvcDoke3RhZ31dICR7cmVkYWN0KG1zZyl9YCk7XG59XG5cbi8qIC0tLS0gXHU1MzU1XHU1QjlFXHU0RjhCIC0tLS0gKi9cbmlmICghYXBwLnJlcXVlc3RTaW5nbGVJbnN0YW5jZUxvY2soKSkge1xuICBhcHAucXVpdCgpO1xufSBlbHNlIHtcbiAgYXBwLm9uKCdzZWNvbmQtaW5zdGFuY2UnLCAoKSA9PiB7XG4gICAgY29uc3Qgd2luID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKClbMF07XG4gICAgaWYgKHdpbikge1xuICAgICAgaWYgKHdpbi5pc01pbmltaXplZCgpKSB3aW4ucmVzdG9yZSgpO1xuICAgICAgd2luLmZvY3VzKCk7XG4gICAgfVxuICB9KTtcblxuICAvKiAtLS0tIGhvc3QgXHU3NkQxXHU3QkExICsgXHU2ODY1XHU1QkEyXHU2MjM3XHU3QUVGIC0tLS0gKi9cbiAgaW50ZXJmYWNlIEJyaWRnZVNuYXBzaG90IHtcbiAgICBob3N0U3RhdGU6IEhvc3RTdGF0ZTtcbiAgICBob3N0UG9ydDogbnVtYmVyIHwgbnVsbDtcbiAgICBob3N0VmVyc2lvbjogc3RyaW5nIHwgbnVsbDtcbiAgICBsYXN0RXJyb3I6IHN0cmluZyB8IG51bGw7XG4gICAgbW9kZTogJ2Zha2UnIHwgJ3JlYWwnO1xuICAgIHJ1bnRpbWVFbnRyeTogc3RyaW5nIHwgbnVsbDtcbiAgfVxuICBsZXQgc3VwZXJ2aXNvcjogRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yIHwgbnVsbCA9IG51bGw7XG4gIGxldCBjbGllbnQ6IERlc2t0b3BIb3N0Q2xpZW50IHwgbnVsbCA9IG51bGw7XG4gIGxldCBicmlkZ2U6IEJyaWRnZVNuYXBzaG90ID0geyBob3N0U3RhdGU6ICdzdG9wcGVkJywgaG9zdFBvcnQ6IG51bGwsIGhvc3RWZXJzaW9uOiBudWxsLCBsYXN0RXJyb3I6IG51bGwsIG1vZGU6ICdmYWtlJywgcnVudGltZUVudHJ5OiBudWxsIH07XG4gIC8qKiBcdTRFOEJcdTRFRjZcdTYyNzlcdTkxQ0ZcdTdGMTNcdTUxQjI6XHU5QUQ4XHU5ODkxIFNTRSBcdTRFMERcdTkwMTBcdTY3NjFcdThGQzcgSVBDLDUwbXMgXHU2Mjc5XHU5MUNGIGZsdXNoKFx1NkUzMlx1NjdEM1x1NEUwRFx1NTM2MSlcdTMwMDIgKi9cbiAgbGV0IGV2ZW50QnVmZmVyOiBFdmVudEVudmVsb3BlW10gPSBbXTtcbiAgbGV0IGZsdXNoVGltZXI6IE5vZGVKUy5UaW1lb3V0IHwgbnVsbCA9IG51bGw7XG4gIGxldCBzc2VBYm9ydDogQWJvcnRDb250cm9sbGVyIHwgbnVsbCA9IG51bGw7XG4gIGxldCBsYXN0RXZlbnRJZCA9ICcnO1xuICAvKiogXHU2NzJBXHU3N0U1L1x1NzU3OFx1NUY2Mlx1NEZFMVx1NUMwMVx1OEJBMVx1NjU3MChTQ0hFTUFfTUlTTUFUQ0ggXHU5NzYyXHU1NDExXHU4QkNBXHU2NUFELFx1NEUwRFx1NUQyOSlcdTMwMDIgKi9cbiAgbGV0IGRyb3BwZWRGcmFtZXMgPSAwO1xuXG4gIGZ1bmN0aW9uIHB1c2hFdmVudChlbnY6IEV2ZW50RW52ZWxvcGUpOiB2b2lkIHtcbiAgICBldmVudEJ1ZmZlci5wdXNoKGVudik7XG4gICAgaWYgKGV2ZW50QnVmZmVyLmxlbmd0aCA+IDJfMDAwKSBldmVudEJ1ZmZlci5zcGxpY2UoMCwgZXZlbnRCdWZmZXIubGVuZ3RoIC0gMl8wMDApO1xuICAgIGlmIChmbHVzaFRpbWVyID09PSBudWxsKSB7XG4gICAgICBmbHVzaFRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgIGZsdXNoVGltZXIgPSBudWxsO1xuICAgICAgICBjb25zdCBiYXRjaCA9IGV2ZW50QnVmZmVyO1xuICAgICAgICBldmVudEJ1ZmZlciA9IFtdO1xuICAgICAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcbiAgICAgICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCdicmlkZ2U6ZXZlbnQtYmF0Y2gnLCBiYXRjaCk7XG4gICAgICAgIH1cbiAgICAgIH0sIDUwKTtcbiAgICB9XG4gICAgbm90aWZ5RXZlbnQoZW52KTtcbiAgfVxuXG4gIC8qIC0tLS0gXHU3Q0ZCXHU3RURGXHU2MjU4XHU3NkQ4ICsgXHU5MDFBXHU3N0U1KDAzIFx1NTNGNyBcdTAwQTdcdTRFMDA6XHU2ODRDXHU5NzYyXHU0RUE3XHU1NEMxXHU5NzAwXHU4OTgxXHU3Q0ZCXHU3RURGXHU2MjU4XHU3NkQ4XHUzMDAxXHU5MDFBXHU3N0U1KSAtLS0tXG4gICAgIFx1NUJBMVx1NjI3OVx1N0I0OVx1NUY4NVx1NUZDNVx1OTg3Qlx1NjI1M1x1NjI3MChcdTc1MjhcdTYyMzdcdTVGQzVcdTk4N0JcdTUxQjNcdTdCNTYpO1x1NUI4Q1x1NjIxMC9cdTU5MzFcdThEMjVcdTRFQzVcdTU3MjhcdTdBOTdcdTUzRTNcdTU5MzFcdTcxMjZcdTY1RjZcdTYzRDBcdTkxOTJcdTMwMDIgKi9cbiAgY29uc3QgVFJBWV9JQ09OX0JBU0U2NCA9ICdpVkJPUncwS0dnb0FBQUFOU1VoRVVnQUFBQkFBQUFBUUNBWUFBQUFmOC85aEFBQUFSMGxFUVZSNG5HTmdRQVBTc29yLzhXRjA5VVJyeEdzUXFab3hESUVKNkRkK0IyTjBoYmpFTVd3bjFRQ3dJWVBUQUZ5WWZnWU1mQmlRWkFERkNZa3FTWm5pekVSSmRnWUFsTDVyc0RjMmFUY0FBQUFBU1VWT1JLNUNZSUk9JztcbiAgbGV0IHRyYXk6IFRyYXkgfCBudWxsID0gbnVsbDtcbiAgY29uc3Qgc2VuZE1lbnVBY3Rpb24gPSAoYTogc3RyaW5nKTogdm9pZCA9PiB7XG4gICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XG4gICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCdtZW51OmFjdGlvbicsIGEpO1xuICAgIH1cbiAgfTtcbiAgZnVuY3Rpb24gZm9jdXNNYWluV2luZG93KCk6IHZvaWQge1xuICAgIGNvbnN0IHdpbiA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmZpbmQoKHcpID0+ICF3LmlzRGVzdHJveWVkKCkpO1xuICAgIGlmICh3aW4gPT09IHVuZGVmaW5lZCkgcmV0dXJuO1xuICAgIGlmICh3aW4uaXNNaW5pbWl6ZWQoKSkgd2luLnJlc3RvcmUoKTtcbiAgICB3aW4uc2hvdygpO1xuICAgIHdpbi5mb2N1cygpO1xuICB9XG4gIGZ1bmN0aW9uIHNldHVwVHJheSgpOiB2b2lkIHtcbiAgICBpZiAodHJheSAhPT0gbnVsbCkgcmV0dXJuO1xuICAgIGNvbnN0IGljb24gPSBuYXRpdmVJbWFnZS5jcmVhdGVGcm9tRGF0YVVSTChgZGF0YTppbWFnZS9wbmc7YmFzZTY0LCR7VFJBWV9JQ09OX0JBU0U2NH1gKTtcbiAgICB0cmF5ID0gbmV3IFRyYXkoaWNvbik7XG4gICAgdHJheS5zZXRUb29sVGlwKCdITUggRGVza3RvcCcpO1xuICAgIHRyYXkub24oJ2NsaWNrJywgZm9jdXNNYWluV2luZG93KTtcbiAgICB0cmF5LnNldENvbnRleHRNZW51KE1lbnUuYnVpbGRGcm9tVGVtcGxhdGUoW1xuICAgICAgeyBsYWJlbDogJ1x1NjVCMFx1NUVGQVx1NEYxQVx1OEJERCcsIGNsaWNrOiAoKTogdm9pZCA9PiBzZW5kTWVudUFjdGlvbignbmV3LXNlc3Npb24nKSB9LFxuICAgICAgeyBsYWJlbDogJ1x1NjYzRVx1NzkzQVx1NEUzQlx1N0E5N1x1NTNFMycsIGNsaWNrOiBmb2N1c01haW5XaW5kb3cgfSxcbiAgICAgIHsgbGFiZWw6ICdcdTYyNEJcdTY3M0FcdThGRENcdTdBMEJcdTYzQTdcdTUyMzYnLCBjbGljazogKCk6IHZvaWQgPT4gc2VuZE1lbnVBY3Rpb24oJ29wZW4tcmVtb3RlJykgfSxcbiAgICAgIHsgbGFiZWw6ICdcdThCQkVcdTdGNkUnLCBjbGljazogKCk6IHZvaWQgPT4gc2VuZE1lbnVBY3Rpb24oJ29wZW4tc2V0dGluZ3MnKSB9LFxuICAgICAgeyB0eXBlOiAnc2VwYXJhdG9yJyB9LFxuICAgICAgeyBsYWJlbDogJ1x1OTAwMFx1NTFGQScsIGNsaWNrOiAoKTogdm9pZCA9PiB7IGFwcC5xdWl0KCk7IH0gfSxcbiAgICBdKSk7XG4gIH1cbiAgZnVuY3Rpb24gbm90aWZ5RXZlbnQoZW52OiBFdmVudEVudmVsb3BlKTogdm9pZCB7XG4gICAgLy8gXHU5QThDXHU2NTM2L1x1NjIyQVx1NTZGRS9cdTZFMzJcdTY3RDNcdTYzQTJcdTk0ODhcdTZBMjFcdTVGMEZcdTk3NTlcdTlFRDgoXHU0RTBEXHU1RjgwXHU3NTI4XHU2MjM3XHU2ODRDXHU5NzYyXHU1RjM5XHU2RDRCXHU4QkQ1XHU5MDFBXHU3N0U1KVxuICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWSA9PT0gJzEnIHx8IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NOQVBTSE9UICE9PSB1bmRlZmluZWQgfHwgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfUkVOREVSX1RFU1QgPT09ICcxJykgcmV0dXJuO1xuICAgIGlmICghTm90aWZpY2F0aW9uLmlzU3VwcG9ydGVkKCkpIHJldHVybjtcbiAgICBjb25zdCB3aW4gPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5maW5kKCh3KSA9PiAhdy5pc0Rlc3Ryb3llZCgpKTtcbiAgICBjb25zdCBmb2N1c2VkID0gd2luPy5pc0ZvY3VzZWQoKSA/PyBmYWxzZTtcbiAgICBjb25zdCBtayA9ICh0aXRsZTogc3RyaW5nLCBib2R5OiBzdHJpbmcpOiB2b2lkID0+IHtcbiAgICAgIGNvbnN0IG4gPSBuZXcgTm90aWZpY2F0aW9uKHsgdGl0bGUsIGJvZHksIGljb246IG5hdGl2ZUltYWdlLmNyZWF0ZUZyb21EYXRhVVJMKGBkYXRhOmltYWdlL3BuZztiYXNlNjQsJHtUUkFZX0lDT05fQkFTRTY0fWApIH0pO1xuICAgICAgbi5vbignY2xpY2snLCBmb2N1c01haW5XaW5kb3cpO1xuICAgICAgbi5zaG93KCk7XG4gICAgfTtcbiAgICBpZiAoZW52LmtpbmQgPT09ICdhcHByb3ZhbC5yZXF1aXJlZCcpIHtcbiAgICAgIGNvbnN0IHAgPSBlbnYucGF5bG9hZCBhcyB7IHRvb2w/OiBzdHJpbmcgfTtcbiAgICAgIG1rKCdITUggXHU5NzAwXHU4OTgxXHU1QkExXHU2Mjc5JywgYCR7U3RyaW5nKHAudG9vbCA/PyAnXHU2NENEXHU0RjVDJyl9IFx1N0I0OVx1NUY4NVx1NEY2MFx1NzY4NFx1NjI3OVx1NTFDNmApO1xuICAgIH0gZWxzZSBpZiAoZW52LmtpbmQgPT09ICdydW4uY29tcGxldGVkJyAmJiAhZm9jdXNlZCkge1xuICAgICAgbWsoJ0hNSCBcdTRFRkJcdTUyQTFcdTVCOENcdTYyMTAnLCBgXHU0RjFBXHU4QkREICR7ZW52LnNlc3Npb25JZH0gXHU3Njg0XHU0RUZCXHU1MkExXHU1REYyXHU1QjhDXHU2MjEwYCk7XG4gICAgfSBlbHNlIGlmIChlbnYua2luZCA9PT0gJ3J1bi5mYWlsZWQnICYmICFmb2N1c2VkKSB7XG4gICAgICBtaygnSE1IIFx1NEVGQlx1NTJBMVx1NTkzMVx1OEQyNScsIGBcdTRGMUFcdThCREQgJHtlbnYuc2Vzc2lvbklkfSBcdTc2ODRcdTRFRkJcdTUyQTFcdTU5MzFcdThEMjUsXHU3MEI5XHU1MUZCXHU2N0U1XHU3NzBCYCk7XG4gICAgfVxuICB9XG5cbiAgLyogLS0tLSBcdTgxRUFcdTVCOUFcdTRFNDlcdTY4MDdcdTk4OThcdTY4MEYoMjAyNi0xMC0xMSBcdTc1MjhcdTYyMzdcdTUzQ0RcdTk5ODg6XHU0RUFFXHU4MjcyXHU2QTIxXHU1RjBGXHU5ODc2XHU5MEU4XHU5RUQxXHU2NzYxPVx1NTM5Rlx1NzUxRlx1ODNEQ1x1NTM1NVx1NjgwRlxuICAgICBcdTRFMERcdThEREZcdTRFM0JcdTk4OTg7XHU4M0RDXHU1MzU1XHU0RTBFXHU4QkJFXHU3RjZFXHU5MUNEXHU1OTBEKSAtLS0tIFx1NjVCOVx1Njg0ODpcdTk2OTBcdTg1Q0ZcdTVGMEZcdTY4MDdcdTk4OThcdTY4MEYgKyB0aXRsZUJhck92ZXJsYXlcbiAgICAgKFx1OTg5Q1x1ODI3Mlx1OTY4Rlx1NEUzQlx1OTg5OCksXHU4M0RDXHU1MzU1XHU2ODBGIGF1dG9IaWRlKEFsdCBcdTU0N0NcdTUxRkEpXHU0RTE0XHU3Q0JFXHU3QjgwXHU0RTNBXHU3Q0ZCXHU3RURGXHU3RUE3XHU4MEZEXHU1MjlCO1xuICAgICBcdTVFMzhcdTc1MjhcdTUyQThcdTRGNUNcdThENzAgcmVuZGVyZXIgXHU2ODA3XHU5ODk4XHU2ODBGIFx1MjYzMCBcdTRFM0JcdTgzRENcdTUzNTUoXHU1NTJGXHU0RTAwXHU1MTY1XHU1M0UzKVx1MzAwMiAqL1xuICBjb25zdCBjaHJvbWVGb3IgPSAoZGFyazogYm9vbGVhbik6IHsgY29sb3I6IHN0cmluZzsgc3ltYm9sQ29sb3I6IHN0cmluZyB9ID0+XG4gICAgZGFyayA/IHsgY29sb3I6ICcjMWIxZDIxJywgc3ltYm9sQ29sb3I6ICcjZjVmNWY2JyB9IDogeyBjb2xvcjogJyNmNmY3ZjknLCBzeW1ib2xDb2xvcjogJyMxZjIzMjgnIH07XG4gIGZ1bmN0aW9uIGFwcGx5Q2hyb21lKGRhcms6IGJvb2xlYW4pOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcbiAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB7XG4gICAgICAgIHRyeSB7IHcuc2V0VGl0bGVCYXJPdmVybGF5KGNocm9tZUZvcihkYXJrKSk7IH0gY2F0Y2ggeyAvKiBcdTRFQzUgV2luZG93cyBcdTY1MkZcdTYzMDEgKi8gfVxuICAgICAgfVxuICAgIH1cbiAgfVxuICBmdW5jdGlvbiBidWlsZEFwcE1lbnUoKTogdm9pZCB7XG4gICAgLy8gXHU3Q0JFXHU3QjgwOlx1NTNFQVx1NEZERFx1NzU1OSBVSSBcdTZDQTFcdTY3MDlcdTc2ODRcdTdDRkJcdTdFREZcdTdFQTdcdTgwRkRcdTUyOUIoXHU1MjZBXHU4RDM0XHU2NzdGL1x1N0E5N1x1NTNFMyk7XHU1MTc2XHU0RjU5XHU1NTJGXHU0RTAwXHU1MTY1XHU1M0UzXHU1NzI4IFVJXHUzMDAyXG4gICAgY29uc3QgdGVtcGxhdGU6IEFycmF5PEVsZWN0cm9uLk1lbnVJdGVtQ29uc3RydWN0b3JPcHRpb25zPiA9IFtcbiAgICAgIHtcbiAgICAgICAgbGFiZWw6ICdcdTdGMTZcdThGOTEnLFxuICAgICAgICBzdWJtZW51OiBbXG4gICAgICAgICAgeyByb2xlOiAndW5kbycsIGxhYmVsOiAnXHU2NEE0XHU5NTAwJyB9LFxuICAgICAgICAgIHsgcm9sZTogJ3JlZG8nLCBsYWJlbDogJ1x1OTFDRFx1NTA1QScgfSxcbiAgICAgICAgICB7IHR5cGU6ICdzZXBhcmF0b3InIH0sXG4gICAgICAgICAgeyByb2xlOiAnY3V0JywgbGFiZWw6ICdcdTUyNkFcdTUyMDcnIH0sXG4gICAgICAgICAgeyByb2xlOiAnY29weScsIGxhYmVsOiAnXHU1OTBEXHU1MjM2JyB9LFxuICAgICAgICAgIHsgcm9sZTogJ3Bhc3RlJywgbGFiZWw6ICdcdTdDOThcdThEMzQnIH0sXG4gICAgICAgICAgeyByb2xlOiAnc2VsZWN0QWxsJywgbGFiZWw6ICdcdTUxNjhcdTkwMDknIH0sXG4gICAgICAgIF0sXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBsYWJlbDogJ1x1N0E5N1x1NTNFMycsXG4gICAgICAgIHN1Ym1lbnU6IFtcbiAgICAgICAgICB7IHJvbGU6ICdtaW5pbWl6ZScsIGxhYmVsOiAnXHU2NzAwXHU1QzBGXHU1MzE2JyB9LFxuICAgICAgICAgIHsgcm9sZTogJ3pvb20nLCBsYWJlbDogJ1x1N0YyOVx1NjUzRScgfSxcbiAgICAgICAgICB7IHR5cGU6ICdzZXBhcmF0b3InIH0sXG4gICAgICAgICAgeyByb2xlOiAnY2xvc2UnLCBsYWJlbDogJ1x1NTE3M1x1OTVFRCcgfSxcbiAgICAgICAgXSxcbiAgICAgIH0sXG4gICAgXTtcbiAgICBNZW51LnNldEFwcGxpY2F0aW9uTWVudShNZW51LmJ1aWxkRnJvbVRlbXBsYXRlKHRlbXBsYXRlKSk7XG4gIH1cbiAgLyoqIFx1NjgwN1x1OTg5OFx1NjgwRiBcdTI2MzAgXHU0RTNCXHU4M0RDXHU1MzU1KFx1NUUzOFx1NzUyOFx1NTJBOFx1NEY1Q1x1NzY4NFx1NTUyRlx1NEUwMFx1NTE2NVx1NTNFMztcdTg5QzZcdTU2RkVcdTYwMDFcdTdFQ0YgbWVudTphY3Rpb24gXHU4RjZDXHU1M0QxKVx1MzAwMiAqL1xuICBmdW5jdGlvbiBwb3B1cE1haW5NZW51KCk6IHZvaWQge1xuICAgIGNvbnN0IHNlbmQgPSAoYTogc3RyaW5nKTogdm9pZCA9PiB7XG4gICAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcbiAgICAgICAgaWYgKCF3LmlzRGVzdHJveWVkKCkpIHcud2ViQ29udGVudHMuc2VuZCgnbWVudTphY3Rpb24nLCBhKTtcbiAgICAgIH1cbiAgICB9O1xuICAgIGNvbnN0IHdpbiA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmZpbmQoKHcpID0+ICF3LmlzRGVzdHJveWVkKCkpO1xuICAgIGlmICh3aW4gPT09IHVuZGVmaW5lZCkgcmV0dXJuO1xuICAgIE1lbnUuYnVpbGRGcm9tVGVtcGxhdGUoW1xuICAgICAgeyBsYWJlbDogJ1x1NjVCMFx1NUVGQVx1NEYxQVx1OEJERCcsIGFjY2VsZXJhdG9yOiAnQ21kT3JDdHJsK04nLCBjbGljazogKCk6IHZvaWQgPT4gc2VuZCgnbmV3LXNlc3Npb24nKSB9LFxuICAgICAgeyBsYWJlbDogJ1x1OEJCRVx1N0Y2RScsIGFjY2VsZXJhdG9yOiAnQ21kT3JDdHJsK1NoaWZ0K1AnLCBjbGljazogKCk6IHZvaWQgPT4gc2VuZCgnb3Blbi1zZXR0aW5ncycpIH0sXG4gICAgICB7IGxhYmVsOiAnXHU1RkVCXHU2Mzc3XHU5NTJFJywgYWNjZWxlcmF0b3I6ICdDbWRPckN0cmwrLycsIGNsaWNrOiAoKTogdm9pZCA9PiBzZW5kKCdzaG9ydGN1dHMnKSB9LFxuICAgICAgeyB0eXBlOiAnc2VwYXJhdG9yJyB9LFxuICAgICAgeyBsYWJlbDogJ1x1NjI0Qlx1NjczQVx1OEZEQ1x1N0EwQlx1NjNBN1x1NTIzNicsIGNsaWNrOiAoKTogdm9pZCA9PiBzZW5kKCdvcGVuLXJlbW90ZScpIH0sXG4gICAgICB7IHR5cGU6ICdzZXBhcmF0b3InIH0sXG4gICAgICB7XG4gICAgICAgIGxhYmVsOiAnXHU1MTczXHU0RThFIEhNSCBEZXNrdG9wJyxcbiAgICAgICAgY2xpY2s6ICgpOiB2b2lkID0+IHtcbiAgICAgICAgICB2b2lkIGRpYWxvZy5zaG93TWVzc2FnZUJveCh3aW4sIHtcbiAgICAgICAgICAgIHR5cGU6ICdpbmZvJyxcbiAgICAgICAgICAgIHRpdGxlOiAnXHU1MTczXHU0RThFIEhNSCBEZXNrdG9wJyxcbiAgICAgICAgICAgIG1lc3NhZ2U6ICdITUggRGVza3RvcCcsXG4gICAgICAgICAgICBkZXRhaWw6IGBcdTY3MkNcdTU3MzBcdTRGMThcdTUxNDhcdTc2ODQgSE1IIEFnZW50IFx1NTZGRVx1NUY2Mlx1NURFNVx1NEY1Q1x1NTNGMFxcbnJ1bnRpbWU6IGhtaGFybmVzcyAke2JyaWRnZS5ob3N0VmVyc2lvbiA/PyAnKFx1NjcyQVx1OEZERVx1NjNBNSknfVxcblx1NkEyMVx1NUYwRjogJHticmlkZ2UubW9kZSA9PT0gJ3JlYWwnID8gJ1x1NzcxRlx1NUI5RSBobWhhcm5lc3MnIDogJ1x1NkYxNFx1NzkzQShcdTUwNDdcdTY1NzBcdTYzNkUpJ31cXG5cXG5cdTRFMEUgQ0xJIC8gVFVJIC8gXHU3RjUxXHU5ODc1XHU3MjQ4XHU1MTcxXHU0RUFCXHU1NDBDXHU0RTAwIEhNSF9IT01FXHUzMDAyYCxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgICB7IGxhYmVsOiAnXHU5MDAwXHU1MUZBJywgcm9sZTogJ3F1aXQnIH0sXG4gICAgXSkucG9wdXAoeyB3aW5kb3c6IHdpbiB9KTtcbiAgfVxuXG4gIC8qIC0tLS0gXHU2MjRCXHU2NzNBXHU4RkRDXHU3QTBCXHU2M0E3XHU1MjM2KDAzIFx1NTNGNzpXZWIgNzc4OCBcdTY2MkZcdTZENEZcdTg5QzhcdTU2NjgvXHU4RkRDXHU3QTBCL1x1NjI0Qlx1NjczQVx1NTE2NVx1NTNFMyxBRFItMDA1OlxuICAgICBEZXNrdG9wIFx1NEUwRFx1OUVEOFx1OEJBNFx1NjI1M1x1NUYwMCBMQU4gXHUyMDE0XHUyMDE0IFx1OEZEOVx1OTFDQ1x1NjYyRlx1NzUyOFx1NjIzN1x1NjYzRVx1NUYwRlx1NTQyRlx1NTJBOFx1NzY4NFx1NTE2NVx1NTNFMykgLS0tLSAqL1xuICBjb25zdCBXRUJfUE9SVCA9IDc3ODg7XG4gIGFzeW5jIGZ1bmN0aW9uIHByb2JlV2ViUmVtb3RlKCk6IFByb21pc2U8eyB1cDogYm9vbGVhbjsgdmVyc2lvbjogc3RyaW5nIH0+IHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgciA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7V0VCX1BPUlR9L2FwaS9zdGF0ZWAsIHsgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDE1MDApIH0pO1xuICAgICAgaWYgKCFyLm9rKSByZXR1cm4geyB1cDogZmFsc2UsIHZlcnNpb246ICcnIH07XG4gICAgICBjb25zdCBkID0gKGF3YWl0IHIuanNvbigpKSBhcyB7IGRhZW1vblZlcnNpb24/OiBzdHJpbmcgfTtcbiAgICAgIHJldHVybiB7IHVwOiB0cnVlLCB2ZXJzaW9uOiBTdHJpbmcoZC5kYWVtb25WZXJzaW9uID8/ICcnKSB9O1xuICAgIH0gY2F0Y2ggeyByZXR1cm4geyB1cDogZmFsc2UsIHZlcnNpb246ICcnIH07IH1cbiAgfVxuICAvKiogXHU2MjRCXHU2NzNBXHU1M0VGXHU4REVGXHU3NTMxXHU3Njg0IExBTiBJUChSRkMxOTE4LFx1NjM5Mlx1OTY2NFx1ODY1QVx1NjJERlx1N0Y1MVx1NTM2MSlcdTMwMDIgKi9cbiAgZnVuY3Rpb24gbGFuSXBPZigpOiBzdHJpbmcge1xuICAgIGNvbnN0IFZJUlRVQUwgPSAvdm13YXJlfHZpcnR1YWx8aHlwZXItP3Z8dmV0aGVybmV0fHdzbHx0YWlsc2NhbGV8bG9vcGJhY2t8Ymx1ZXRvb3RofHZib3h8ZG9ja2VyfHRhcC18cHNldWRvL2k7XG4gICAgY29uc3QgaXNSZmMxOTE4ID0gKGE6IHN0cmluZyk6IGJvb2xlYW4gPT4gL14xMFxcLi8udGVzdChhKSB8fCAvXjE5MlxcLjE2OFxcLi8udGVzdChhKSB8fCAvXjE3MlxcLigxWzYtOV18MlxcZHwzWzAxXSlcXC4vLnRlc3QoYSk7XG4gICAgbGV0IGxhbklwID0gJyc7XG4gICAgbGV0IGZhbGxiYWNrID0gJyc7XG4gICAgZm9yIChjb25zdCBbbmFtZSwgbGlzdF0gb2YgT2JqZWN0LmVudHJpZXMobmV0d29ya0ludGVyZmFjZXMoKSkpIHtcbiAgICAgIGZvciAoY29uc3QgbiBvZiBsaXN0ID8/IFtdKSB7XG4gICAgICAgIGlmIChuLmZhbWlseSAhPT0gJ0lQdjQnIHx8IG4uaW50ZXJuYWwgfHwgIWlzUmZjMTkxOChuLmFkZHJlc3MpKSBjb250aW51ZTtcbiAgICAgICAgaWYgKCFWSVJUVUFMLnRlc3QobmFtZSkpIGxhbklwID0gbGFuSXAgfHwgbi5hZGRyZXNzO1xuICAgICAgICBlbHNlIGZhbGxiYWNrID0gZmFsbGJhY2sgfHwgbi5hZGRyZXNzO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gbGFuSXAgfHwgZmFsbGJhY2s7XG4gIH1cbiAgLyoqIENMSSBcdTUxNjVcdTUzRTMocnVudGltZSBcdTgxRUFcdTUyQThcdTUzRDFcdTczQjBcdTc2ODQgcmVwbztmYWtlIFx1NkEyMVx1NUYwRlx1NjVFMCByZXBvIFx1OEZENFx1NTZERVx1N0E3QSlcdTMwMDIgKi9cbiAgZnVuY3Rpb24gY2xpRW50cnlPZigpOiBzdHJpbmcge1xuICAgIGlmIChydW50aW1lRW50cnkgPT09IG51bGwpIHJldHVybiAnJztcbiAgICB0cnkge1xuICAgICAgY29uc3QgcCA9IGpvaW4ocmVwb1Jvb3RPZihydW50aW1lRW50cnkpLCAncGFja2FnZXMnLCAnY2xpJywgJ3NyYycsICdtYWluLnRzJyk7XG4gICAgICByZXR1cm4gZXhpc3RzU3luYyhwKSA/IHAgOiAnJztcbiAgICB9IGNhdGNoIHsgcmV0dXJuICcnOyB9XG4gIH1cbiAgZnVuY3Rpb24gcnVuQ2xpKGFyZ3M6IHN0cmluZ1tdKTogdm9pZCB7XG4gICAgY29uc3QgZW50cnkgPSBjbGlFbnRyeU9mKCk7XG4gICAgaWYgKGVudHJ5ID09PSAnJykgcmV0dXJuO1xuICAgIGNvbnN0IHJlcG8gPSByZXBvUm9vdE9mKHJ1bnRpbWVFbnRyeSA/PyBlbnRyeSk7XG4gICAgY29uc3QgY2hpbGQgPSBzcGF3bihwcm9jZXNzLmV4ZWNQYXRoLCBbJy0taW1wb3J0JywgJ3RzeCcsIGVudHJ5LCAuLi5hcmdzXSwge1xuICAgICAgY3dkOiByZXBvLFxuICAgICAgZGV0YWNoZWQ6IHRydWUsXG4gICAgICBzdGRpbzogJ2lnbm9yZScsXG4gICAgICB3aW5kb3dzSGlkZTogdHJ1ZSxcbiAgICAgIGVudjogeyBFTEVDVFJPTl9SVU5fQVNfTk9ERTogJzEnIH0sXG4gICAgfSk7XG4gICAgY2hpbGQudW5yZWYoKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGJyb2FkY2FzdEhvc3RTdGF0ZShzOiBIb3N0U3RhdGUsIGluZm86IHsgcmVzdGFydENvdW50OiBudW1iZXI7IGxhc3RFcnJvcj86IHN0cmluZyB9KTogdm9pZCB7XG4gICAgYnJpZGdlID0geyAuLi5icmlkZ2UsIGhvc3RTdGF0ZTogcywgaG9zdFBvcnQ6IHN1cGVydmlzb3I/LmVuZHBvaW50Py5wb3J0ID8/IG51bGwsIGhvc3RWZXJzaW9uOiBzdXBlcnZpc29yPy5lbmRwb2ludD8udmVyc2lvbiA/PyBudWxsIH07XG4gICAgbG9nSW5mbygnaG9zdCcsIGBzdGF0ZT0ke3N9JHtpbmZvLmxhc3RFcnJvciAhPT0gdW5kZWZpbmVkID8gYCBlcnI9JHtpbmZvLmxhc3RFcnJvcn1gIDogJyd9YCk7XG4gICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XG4gICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCdicmlkZ2U6aG9zdC1zdGF0ZScsIHMsIGluZm8pO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBTU0UgXHU2RDQxXHU4QkEyXHU5NjA1Olx1NEZFMVx1NUMwMShldmVudDogaG1oKVx1NjI3OVx1OTFDRlx1NjNBOCByZW5kZXJlcjtcdTlBRDhcdTk4OTEgZGVsdGEvbGluZSBcdTUzOUZcdTVFMjdcbiAgICogIFx1NEY1Q1x1NEUzQVx1NkQ0MVx1NTc1N1x1OEY2Q1x1NTNEMShyZW5kZXJlciBcdTYyRkNcdTYzQTVcdTVGNTNcdTUyNEQgYXNzaXN0YW50IFx1NTM2MFx1NEY0RClcdTMwMDJcdTY1QURcdTdFQkZcdTgxRUFcdTUyQThcdTkxQ0RcdThGREVcdTMwMDIgKi9cbiAgYXN5bmMgZnVuY3Rpb24gcHVtcEV2ZW50cygpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAoY2xpZW50ID09PSBudWxsKSByZXR1cm47XG4gICAgZm9yICg7Oykge1xuICAgICAgY29uc3QgYyA9IGNsaWVudDtcbiAgICAgIGlmIChjID09PSBudWxsKSByZXR1cm47XG4gICAgICB0cnkge1xuICAgICAgICBmb3IgYXdhaXQgKGNvbnN0IGZyYW1lIG9mIGMucmF3RXZlbnRzKGxhc3RFdmVudElkID09PSAnJyA/IHVuZGVmaW5lZCA6IGxhc3RFdmVudElkLCBzc2VBYm9ydD8uc2lnbmFsKSkge1xuICAgICAgICAgIGlmIChmcmFtZS5ldmVudCA9PT0gJ2htaCcpIHtcbiAgICAgICAgICAgIGNvbnN0IGVudiA9IGVudmVsb3BlRnJvbUZyYW1lKGZyYW1lKTtcbiAgICAgICAgICAgIGlmIChlbnYgPT09IG51bGwpIHtcbiAgICAgICAgICAgICAgZHJvcHBlZEZyYW1lcyArPSAxO1xuICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGxhc3RFdmVudElkID0gZW52LmV2ZW50SWQ7XG4gICAgICAgICAgICBwdXNoRXZlbnQoZW52KTtcbiAgICAgICAgICB9IGVsc2UgaWYgKGZyYW1lLmV2ZW50ID09PSAnZGVsdGEnIHx8IGZyYW1lLmV2ZW50ID09PSAnbGluZScpIHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIGNvbnN0IGQgPSBKU09OLnBhcnNlKGZyYW1lLmRhdGEpIGFzIHsgc2Vzc2lvbklkPzogc3RyaW5nOyBrPzogc3RyaW5nOyBjaHVuaz86IHN0cmluZzsgdGV4dD86IHN0cmluZyB9O1xuICAgICAgICAgICAgICBjb25zdCBwYXlsb2FkID0gZnJhbWUuZXZlbnQgPT09ICdkZWx0YSdcbiAgICAgICAgICAgICAgICA/IHsgc2Vzc2lvbklkOiBkLnNlc3Npb25JZCA/PyAnJywga2luZDogZC5rID8/ICd0ZXh0JywgY2h1bms6IFN0cmluZyhkLmNodW5rID8/ICcnKSB9XG4gICAgICAgICAgICAgICAgOiB7IHNlc3Npb25JZDogZC5zZXNzaW9uSWQgPz8gJycsIGtpbmQ6ICdsaW5lJywgY2h1bms6IFN0cmluZyhkLnRleHQgPz8gJycpIH07XG4gICAgICAgICAgICAgIGZvciAoY29uc3QgdyBvZiBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKSkge1xuICAgICAgICAgICAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ2JyaWRnZTpzdHJlYW0tY2h1bmsnLCBwYXlsb2FkKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBjYXRjaCB7IC8qIG1hbGZvcm1lZCBzdHJlYW0gZnJhbWU6IHNraXAgKi8gfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICByZXR1cm47IC8vIFx1NkQ0MVx1NkI2M1x1NUUzOFx1N0VEM1x1Njc1Rihob3N0IFx1NTE3M1x1OTVFRClcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvLyBcdTY1QURcdTdFQkY6XHU3N0VEXHU5MDAwXHU5MDdGXHU1NDBFXHU5MUNEXHU4RkRFKHN1cGVydmlzb3IgXHU1M0VGXHU4MEZEXHU2QjYzXHU1NzI4XHU5MUNEXHU1NDJGIGhvc3QpXG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDFfMDAwKSk7XG4gICAgICAgIGlmIChzc2VBYm9ydD8uc2lnbmFsLmFib3J0ZWQpIHJldHVybjtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvKiAtLS0tIGhtaGFybmVzcyBydW50aW1lIFx1ODFFQVx1NTJBOFx1NTNEMVx1NzNCMCgyMDI2LTEwLTEwIFx1NzUyOFx1NjIzN1x1NUI5QVx1OEMwMzpcdTg4QzVcdThGQzcgaG1oYXJuZXNzIFx1NzY4NFxuICAgICBcdTY3M0FcdTU2NjhcdTk2RjZcdTkxNERcdTdGNkVcdTc2RjRcdThGREUsXHU1OTBEXHU3NTI4IENMSS9UVUkvd2ViIDc3ODggXHU3Njg0XHU1NDBDXHU0RTAwIEhNSF9IT01FXHUyMDE0XHUyMDE0Y29uZmlnL3Byb3ZpZGVycy9cbiAgICAgXHU0RjFBXHU4QkREXHU1Mzg2XHU1M0YyXHU1OTI5XHU3MTM2XHU1MTcxXHU0RUFCKVx1MzAwMlx1NTNEMVx1NzNCMFx1OTg3QVx1NUU4RjpcdTY2M0VcdTVGMEZcdTkxNERcdTdGNkUgPiB3aGVyZSBobWggPiBucG0gXHU1MTY4XHU1QzQwID4gXHU1RTM4XHU4OUMxXHU2RTkwXHU3ODAxXHU0RjREXHU3RjZFXHUzMDAyICovXG4gIGNvbnN0IHJ1bnRpbWVDb25maWdGaWxlID0gKCk6IHN0cmluZyA9PiBqb2luKGFwcC5nZXRQYXRoKCd1c2VyRGF0YScpLCAncnVudGltZS5qc29uJyk7XG4gIGFzeW5jIGZ1bmN0aW9uIGxvYWRSdW50aW1lRW50cnlPdmVycmlkZSgpOiBQcm9taXNlPHN0cmluZz4ge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCB2ID0gSlNPTi5wYXJzZShhd2FpdCByZWFkRmlsZShydW50aW1lQ29uZmlnRmlsZSgpLCAndXRmOCcpKSBhcyB7IGVudHJ5PzogdW5rbm93biB9O1xuICAgICAgcmV0dXJuIHR5cGVvZiB2LmVudHJ5ID09PSAnc3RyaW5nJyAmJiB2LmVudHJ5ICE9PSAnJyAmJiBpc0Fic29sdXRlKHYuZW50cnkpID8gdi5lbnRyeSA6ICcnO1xuICAgIH0gY2F0Y2ggeyByZXR1cm4gJyc7IH1cbiAgfVxuICBhc3luYyBmdW5jdGlvbiBzYXZlUnVudGltZUVudHJ5T3ZlcnJpZGUoZW50cnk6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICAgIGF3YWl0IHdyaXRlRmlsZShydW50aW1lQ29uZmlnRmlsZSgpLCBKU09OLnN0cmluZ2lmeSh7IGVudHJ5IH0sIG51bGwsIDIpLCAndXRmOCcpLmNhdGNoKCgpID0+IHVuZGVmaW5lZCk7XG4gIH1cblxuICBmdW5jdGlvbiBkZXRlY3RSZWFsRW50cnkoKTogc3RyaW5nIHtcbiAgICAvLyAxKSBcdTczQUZcdTU4ODNcdTUzRDhcdTkxQ0ZcdTY2M0VcdTVGMEZcdTg5ODZcdTc2RDYoXHU5QUQ4XHU3RUE3XHU3NTI4XHU2MjM3KVxuICAgIGNvbnN0IGVudkVudHJ5ID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfUkVBTF9FTlRSWTtcbiAgICBpZiAoZW52RW50cnkgIT09IHVuZGVmaW5lZCAmJiBlbnZFbnRyeSAhPT0gJycgJiYgaXNBYnNvbHV0ZShlbnZFbnRyeSkpIHJldHVybiBlbnZFbnRyeTtcblxuICAgIGNvbnN0IHJlcG9zID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gICAgLy8gMikgd2hlcmUgaG1oOm5wbSBsaW5rL1x1NTE2OFx1NUM0MFx1NUI4OVx1ODhDNVx1NzY4NCBiaW4gXHUyMTkyIG5vZGVfbW9kdWxlcy9obWhhcm5lc3MgXHUyMTkyIFx1NzcxRiByZXBvKG5wbSBsaW5rIFx1NjYyRiBzeW1saW5rKVxuICAgIHRyeSB7XG4gICAgICBjb25zdCBvdXQgPSBleGVjRmlsZVN5bmMoJ3doZXJlJywgWydobWgnXSwgeyBlbmNvZGluZzogJ3V0ZjgnLCB0aW1lb3V0OiA0XzAwMCwgd2luZG93c0hpZGU6IHRydWUgfSk7XG4gICAgICBmb3IgKGNvbnN0IGxpbmUgb2Ygb3V0LnNwbGl0KC9cXHI/XFxuLykpIHtcbiAgICAgICAgY29uc3QgYmluID0gbGluZS50cmltKCk7XG4gICAgICAgIGlmIChiaW4gPT09ICcnKSBjb250aW51ZTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCBsaW5rZWQgPSBqb2luKGRpcm5hbWUoYmluKSwgJ25vZGVfbW9kdWxlcycsICdobWhhcm5lc3MnKTtcbiAgICAgICAgICBpZiAoZXhpc3RzU3luYyhsaW5rZWQpKSByZXBvcy5hZGQocmVhbHBhdGhTeW5jKGxpbmtlZCkpO1xuICAgICAgICB9IGNhdGNoIHsgLyogYmluIFx1NUUwM1x1NUM0MFx1NEUwRFx1N0IyNixcdThERjNcdThGQzcgKi8gfVxuICAgICAgfVxuICAgIH0gY2F0Y2ggeyAvKiBobWggXHU0RTBEXHU1NzI4IFBBVEggKi8gfVxuICAgIC8vIDMpIG5wbSBcdTUxNjhcdTVDNDBcdTY4MzlcbiAgICB0cnkge1xuICAgICAgY29uc3Qgb3V0ID0gZXhlY0ZpbGVTeW5jKCducG0nLCBbJ3Jvb3QnLCAnLWcnXSwgeyBlbmNvZGluZzogJ3V0ZjgnLCB0aW1lb3V0OiA2XzAwMCwgd2luZG93c0hpZGU6IHRydWUgfSk7XG4gICAgICBjb25zdCBwID0gam9pbihvdXQudHJpbSgpLCAnaG1oYXJuZXNzJyk7XG4gICAgICBpZiAoZXhpc3RzU3luYyhwKSkgcmVwb3MuYWRkKHJlYWxwYXRoU3luYyhwKSk7XG4gICAgfSBjYXRjaCB7IC8qIG5wbSBcdTRFMERcdTUzRUZcdTc1MjggKi8gfVxuICAgIC8vIDQpIFx1NUUzOFx1ODlDMVx1NkU5MFx1NzgwMVx1NEY0RFx1N0Y2RShcdTY3MkNcdTY3M0FcdTVGMDBcdTUzRDFcdTVFMDNcdTVDNDApXG4gICAgY29uc3QgYmFzZXMgPSBbJ0M6XFxcXCcsICdEOlxcXFwnLCAnRTpcXFxcJywgJ0Y6XFxcXCcsICdHOlxcXFwnLCAnSDpcXFxcJywgaG9tZWRpcigpLCBqb2luKGhvbWVkaXIoKSwgJ0RldmVsb3BlcicpXTtcbiAgICBmb3IgKGNvbnN0IGJhc2Ugb2YgYmFzZXMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHAgPSByZXNvbHZlKGJhc2UsICdobWhhcm5lc3MnKTtcbiAgICAgICAgaWYgKGV4aXN0c1N5bmMocCkpIHJlcG9zLmFkZChwKTtcbiAgICAgIH0gY2F0Y2ggeyAvKiBcdTc2RDhcdTRFMERcdTVCNThcdTU3MjggKi8gfVxuICAgIH1cbiAgICAvLyBcdTU0N0RcdTRFMkRcdTc2ODQgcmVwbyBcdTVGQzVcdTk4N0JcdTY3MDkgZGVza3RvcC1ob3N0IFx1NTE2NVx1NTNFM1x1NEUwRVx1NEY5RFx1OEQ1Nlx1NUUwM1x1NUM0MFxuICAgIGZvciAoY29uc3QgcmVwbyBvZiByZXBvcykge1xuICAgICAgY29uc3QgZW50cnkgPSBqb2luKHJlcG8sICdwYWNrYWdlcycsICd3ZWInLCAnc3JjJywgJ2Rlc2t0b3AtaG9zdC50cycpO1xuICAgICAgaWYgKGV4aXN0c1N5bmMoZW50cnkpICYmIGV4aXN0c1N5bmMoam9pbihyZXBvLCAnbm9kZV9tb2R1bGVzJykpKSByZXR1cm4gZW50cnk7XG4gICAgfVxuICAgIHJldHVybiAnJztcbiAgfVxuXG4gIC8qKiBcdTg5RTNcdTY3OTAgcnVudGltZSBcdTUxNjVcdTUzRTNcdTYyNDBcdTVDNUVcdTc2ODQgaG1oYXJuZXNzIFx1NEVEM1x1NUU5M1x1NjgzOShwYWNrYWdlcy93ZWIvc3JjfGRpc3QgXHU0RTBBXHU2RUFGKVx1MzAwMiAqL1xuICBmdW5jdGlvbiByZXBvUm9vdE9mKGVudHJ5OiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGxldCBkaXIgPSBkaXJuYW1lKGVudHJ5KTtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IDY7IGkrKykge1xuICAgICAgaWYgKGV4aXN0c1N5bmMoam9pbihkaXIsICdwYWNrYWdlLmpzb24nKSkgJiYgZXhpc3RzU3luYyhqb2luKGRpciwgJ3BhY2thZ2VzJywgJ3dlYicpKSkgcmV0dXJuIGRpcjtcbiAgICAgIGNvbnN0IHBhcmVudCA9IGRpcm5hbWUoZGlyKTtcbiAgICAgIGlmIChwYXJlbnQgPT09IGRpcikgYnJlYWs7XG4gICAgICBkaXIgPSBwYXJlbnQ7XG4gICAgfVxuICAgIHJldHVybiBkaXJuYW1lKGVudHJ5KTtcbiAgfVxuXG4gIGxldCBydW50aW1lRW50cnkgPSAnJzsgLy8gXHU1RjUzXHU1MjREXHU1QjlFXHU5NjQ1XHU0RjdGXHU3NTI4XHU3Njg0XHU3NzFGXHU1QjlFIHJ1bnRpbWUgXHU1MTY1XHU1M0UzKCcnPVx1NjcyQVx1NjNBNSlcblxuICAvKiogZGV2IFx1OEZERVx1NEVEM1x1NUU5M1x1NTE4NSBobWhhcm5lc3M7XHU2MjUzXHU1MzA1XHU0RUE3XHU1NEMxXHU4MUVBXHU1MkE4XHU1M0QxXHU3M0IwKFx1NTNEMVx1NzNCMFx1NEUwRFx1NTIzMFx1MjE5Mlx1NkYxNFx1NzkzQVx1NkEyMVx1NUYwRitcdTVGMTVcdTVCRkMpXHUzMDAyICovXG4gIGFzeW5jIGZ1bmN0aW9uIHN0YXJ0SG9zdCgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCByZXBvUm9vdCA9IGpvaW4oaGVyZSwgJy4uJywgJy4uJywgJy4uJywgJy4uJyk7IC8vIGFwcHMvZGVza3RvcC9kaXN0LWVsZWN0cm9uL21haW4gXHUyMTkyIHJlcG8gcm9vdFxuICAgIGNvbnN0IHBhY2thZ2VkID0gYXBwLmlzUGFja2FnZWQ7XG4gICAgLy8gXHU3NzFGXHU1QjlFXHU1MTY1XHU1M0UzXHU4OUUzXHU2NzkwOlx1OTE0RFx1N0Y2RVx1ODk4Nlx1NzZENiA+IFx1ODFFQVx1NTJBOFx1NTNEMVx1NzNCMChkZXYgXHU3NkY0XHU2M0E1XHU3NTI4XHU3NkY4XHU5MEJCXHU0RUQzXHU1RTkzKTtcbiAgICAvLyBITUhfREVTS1RPUF9GQUtFPTEgXHU1RjNBXHU1MjM2XHU2RjE0XHU3OTNBXHU2QTIxXHU1RjBGKFx1NUZFQlx1OTAxRi9cdTc4NkVcdTVCOUFcdTYwMjdcdTZENEJcdThCRDVcdTRFMEVcdTUxOTJcdTcwREYpXG4gICAgY29uc3QgZm9yY2VGYWtlID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfRkFLRSA9PT0gJzEnO1xuICAgIGNvbnN0IG92ZXJyaWRlID0gYXdhaXQgbG9hZFJ1bnRpbWVFbnRyeU92ZXJyaWRlKCk7XG4gICAgcnVudGltZUVudHJ5ID0gZm9yY2VGYWtlXG4gICAgICA/ICcnXG4gICAgICA6IG92ZXJyaWRlICE9PSAnJ1xuICAgICAgICA/IG92ZXJyaWRlXG4gICAgICAgIDogcGFja2FnZWRcbiAgICAgICAgICA/IGRldGVjdFJlYWxFbnRyeSgpXG4gICAgICAgICAgOiBqb2luKHJlcG9Sb290LCAnLi4nLCAnaG1oYXJuZXNzJywgJ3BhY2thZ2VzJywgJ3dlYicsICdzcmMnLCAnZGVza3RvcC1ob3N0LnRzJyk7XG4gICAgY29uc3QgdXNlUmVhbCA9IHJ1bnRpbWVFbnRyeSAhPT0gJycgJiYgZXhpc3RzU3luYyhydW50aW1lRW50cnkpO1xuICAgIGJyaWRnZSA9IHsgLi4uYnJpZGdlLCBtb2RlOiB1c2VSZWFsID8gJ3JlYWwnIDogJ2Zha2UnLCBydW50aW1lRW50cnk6IHVzZVJlYWwgPyBydW50aW1lRW50cnkgOiBudWxsIH07XG4gICAgbGV0IHNwZWM6IHsgY29tbWFuZDogc3RyaW5nOyBhcmdzOiBzdHJpbmdbXTsgZW52OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+OyBjd2Q/OiBzdHJpbmcgfTtcbiAgICBpZiAodXNlUmVhbCkge1xuICAgICAgY29uc3QgcmVwbyA9IHJlcG9Sb290T2YocnVudGltZUVudHJ5KTtcbiAgICAgIHNwZWMgPSB7XG4gICAgICAgIGNvbW1hbmQ6IHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgICAgIGFyZ3M6IFsnLS1pbXBvcnQnLCAndHN4JywgcnVudGltZUVudHJ5XSxcbiAgICAgICAgY3dkOiByZXBvLCAvLyBiYXJlICd0c3gnIFx1NEUwRSB3b3Jrc3BhY2UgXHU0RjlEXHU4RDU2XHU5MEZEXHU0RUNFIHJlcG8gXHU3Njg0IG5vZGVfbW9kdWxlcyBcdTg5RTNcdTY3OTBcbiAgICAgICAgZW52OiB7IEVMRUNUUk9OX1JVTl9BU19OT0RFOiAnMScgfSxcbiAgICAgIH07XG4gICAgfSBlbHNlIGlmIChwYWNrYWdlZCkge1xuICAgICAgc3BlYyA9IHtcbiAgICAgICAgY29tbWFuZDogcHJvY2Vzcy5leGVjUGF0aCxcbiAgICAgICAgYXJnczogW2pvaW4ocHJvY2Vzcy5yZXNvdXJjZXNQYXRoLCAnZmFrZS1ob3N0LmNqcycpXSxcbiAgICAgICAgZW52OiB7IEVMRUNUUk9OX1JVTl9BU19OT0RFOiAnMScgfSxcbiAgICAgIH07XG4gICAgfSBlbHNlIHtcbiAgICAgIHNwZWMgPSB7XG4gICAgICAgIGNvbW1hbmQ6IHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgICAgIC8vIFx1NzZGNFx1NjNBNVx1OEQ3MFx1NTMwNVx1NzcxRlx1NUI5RVx1OERFRlx1NUY4NChub2RlX21vZHVsZXMgXHU5MUNDXHU3Njg0IHdvcmtzcGFjZSBqdW5jdGlvbiBcdTRGMUFcdTg4QUIgRVNNXG4gICAgICAgIC8vIHJlYWxwYXRoIFx1NTMxNixcdTVCRkNcdTgxRjQgZmFrZS1ob3N0IFx1NzY4NCBhcmd2WzFdL2ltcG9ydC5tZXRhLnVybCBcdTUzMzlcdTkxNERcdTU5MzFcdTY1NDgpXG4gICAgICAgIGFyZ3M6IFsnLS1pbXBvcnQnLCAndHN4Jywgam9pbihyZXBvUm9vdCwgJ3BhY2thZ2VzJywgJ2hvc3QtYWRhcHRlcicsICdzcmMnLCAnZmFrZS1ob3N0LnRzJyldLFxuICAgICAgICBlbnY6IHsgRUxFQ1RST05fUlVOX0FTX05PREU6ICcxJyB9LFxuICAgICAgfTtcbiAgICB9XG4gICAgc3VwZXJ2aXNvciA9IG5ldyBEZXNrdG9wUnVudGltZVN1cGVydmlzb3Ioc3BlYywge1xuICAgICAgb25TdGF0ZUNoYW5nZTogYnJvYWRjYXN0SG9zdFN0YXRlLFxuICAgICAgLy8gXHU5OTk2XHU2QjIxXHU1NDJGXHU1MkE4XHU0RTBFIGNyYXNoIFx1ODFFQVx1NjEwOFx1NTQwRVx1NzY4NFx1OTFDRFx1NTQyRlx1OTBGRFx1NEYxQVx1OEQ3MFx1OEZEOVx1OTFDQzpcdTdBRUZcdTUzRTMvdG9rZW4gXHU5MEZEXHU2NjJGXHU2NUIwXHU3Njg0LFxuICAgICAgLy8gXHU5MUNEXHU1RUZBXHU2ODY1XHU1QkEyXHU2MjM3XHU3QUVGXHU1RTc2XHU5MUNEXHU2NUIwXHU4QkEyXHU5NjA1IFNTRShyZW5kZXJlciBcdTc2ODQgRXZlbnRTdG9yZSBcdTk3NjAgZXZlbnRJZCBcdTUzQkJcdTkxQ0QpXG4gICAgICBvblJlYWR5OiAoZXApID0+IHtcbiAgICAgICAgY2xpZW50ID0gbmV3IERlc2t0b3BIb3N0Q2xpZW50KGBodHRwOi8vMTI3LjAuMC4xOiR7ZXAucG9ydH1gLCBlcC50b2tlbik7XG4gICAgICAgIHNzZUFib3J0Py5hYm9ydCgpO1xuICAgICAgICBzc2VBYm9ydCA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgICAgICAgbGFzdEV2ZW50SWQgPSAnJztcbiAgICAgICAgdm9pZCBwdW1wRXZlbnRzKCk7XG4gICAgICAgIGxvZ0luZm8oJ2hvc3QnLCBgYnJpZGdlIHJlYWR5IG9uIDEyNy4wLjAuMToke2VwLnBvcnR9IChydW50aW1lICR7ZXAudmVyc2lvbn0sIG1vZGUgJHticmlkZ2UubW9kZX0ke3VzZVJlYWwgPyBgLCBlbnRyeT0ke3J1bnRpbWVFbnRyeX1gIDogJyd9KWApO1xuICAgICAgfSxcbiAgICB9KTtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgc3VwZXJ2aXNvci5zdGFydCgpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgY29uc3QgZGV0YWlsID0gKCgpID0+IHsgdHJ5IHsgcmV0dXJuIEpTT04uc3RyaW5naWZ5KGVycik7IH0gY2F0Y2ggeyByZXR1cm4gU3RyaW5nKGVycik7IH0gfSkoKS5zbGljZSgwLCA0MDApO1xuICAgICAgYnJpZGdlID0geyAuLi5icmlkZ2UsIGhvc3RTdGF0ZTogJ2ZhaWxlZCcsIGxhc3RFcnJvcjogZGV0YWlsIH07XG4gICAgICBsb2dJbmZvKCdob3N0JywgYHN0YXJ0IGZhaWxlZDogJHtkZXRhaWx9YCk7XG4gICAgfVxuICB9XG5cbiAgLyogLS0tLSBJUEMgXHU3NjdEXHU1NDBEXHU1MzU1ICsgc2VuZGVyIFx1NjgyMVx1OUE4QyAtLS0tICovXG4gIGNvbnN0IGFsbG93ZWRPcmlnaW5zID0gbmV3IFNldDxzdHJpbmc+KFxuICAgIGlzRGV2ICYmIHJlbmRlcmVyRGV2VXJsXG4gICAgICA/IFtyZW5kZXJlckRldlVybF1cbiAgICAgIDogW3BhdGhUb0ZpbGVVUkwoam9pbihoZXJlLCAnLi4nLCAnLi4nLCAnZGlzdC1yZW5kZXJlcicsICdpbmRleC5odG1sJykpLmhyZWZdLFxuICApO1xuXG4gIGZ1bmN0aW9uIHNlbmRlclRydXN0ZWQoc2VuZGVyRnJhbWU6IEVsZWN0cm9uLldlYkZyYW1lTWFpbiB8IG51bGwgfCB1bmRlZmluZWQpOiBib29sZWFuIHtcbiAgICBpZiAoc2VuZGVyRnJhbWUgPT09IG51bGwgfHwgc2VuZGVyRnJhbWUgPT09IHVuZGVmaW5lZCkgcmV0dXJuIGZhbHNlO1xuICAgIGxldCB0b3A6IEVsZWN0cm9uLldlYkZyYW1lTWFpbiB8IG51bGwgPSBzZW5kZXJGcmFtZTtcbiAgICB3aGlsZSAodG9wPy5wYXJlbnQgIT09IG51bGwgJiYgdG9wPy5wYXJlbnQgIT09IHVuZGVmaW5lZCkgdG9wID0gdG9wLnBhcmVudDtcbiAgICBjb25zdCB1cmwgPSB0b3A/LnVybCA/PyAnJztcbiAgICBmb3IgKGNvbnN0IG9yaWdpbiBvZiBhbGxvd2VkT3JpZ2lucykge1xuICAgICAgaWYgKHVybCA9PT0gb3JpZ2luIHx8IHVybC5zdGFydHNXaXRoKGAke29yaWdpbn0vYCkgfHwgdXJsLnN0YXJ0c1dpdGgoYCR7b3JpZ2lufT9gKSkgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIC8qKiBcdTk3MDBcdTg5ODEgaG9zdCBcdTVDMzFcdTdFRUFcdTc2ODQgSVBDIGhhbmRsZXIgXHU1MTZDXHU1MTcxXHU1OEYzOlx1NjcyQVx1NUMzMVx1N0VFQVx1OEZENFx1NTZERVx1N0VEM1x1Njc4NFx1NTMxNlx1OTUxOVx1OEJFRlx1MzAwMiAqL1xuICBmdW5jdGlvbiBob3N0Q2FsbDxUPihldmVudDogRWxlY3Ryb24uSXBjTWFpbkludm9rZUV2ZW50LCBmbjogKGM6IERlc2t0b3BIb3N0Q2xpZW50KSA9PiBQcm9taXNlPFQ+KTogUHJvbWlzZTxUIHwgeyBlcnJvcjogc3RyaW5nOyBjb2RlOiBzdHJpbmcgfT4ge1xuICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9KTtcbiAgICBpZiAoY2xpZW50ID09PSBudWxsIHx8IGJyaWRnZS5ob3N0U3RhdGUgIT09ICdyZWFkeScpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogYGhvc3Qgbm90IHJlYWR5ICgke2JyaWRnZS5ob3N0U3RhdGV9KWAsIGNvZGU6ICdIT1NUX05PVF9SRUFEWScgfSk7XG4gICAgfVxuICAgIHJldHVybiBmbihjbGllbnQpLmNhdGNoKChlcnI6IHVua25vd24pID0+IHtcbiAgICAgIGNvbnN0IGRldGFpbCA9ICgoKSA9PiB7IHRyeSB7IHJldHVybiBKU09OLnN0cmluZ2lmeShlcnIpOyB9IGNhdGNoIHsgcmV0dXJuIFN0cmluZyhlcnIpOyB9IH0pKCkuc2xpY2UoMCwgMzAwKTtcbiAgICAgIHJldHVybiB7IGVycm9yOiBkZXRhaWwsIGNvZGU6ICdCUklER0VfRVJST1InIH07XG4gICAgfSk7XG4gIH1cblxuICBmdW5jdGlvbiByZWdpc3RlcklwYygpOiB2b2lkIHtcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmdldC1zdGF0ZScsIChldmVudCkgPT4ge1xuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJyB9O1xuICAgICAgcmV0dXJuIHsgLi4uYnJpZGdlLCBkcm9wcGVkRnJhbWVzIH07XG4gICAgfSk7XG5cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnNlc3Npb25zJywgKGV2ZW50KSA9PlxuICAgICAgaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248eyBzZXNzaW9uczogQXJyYXk8eyBpZDogc3RyaW5nOyB0aXRsZTogc3RyaW5nOyB0YXNrOiBzdHJpbmc7IG91dGNvbWU6IHN0cmluZzsgdHVybnM6IG51bWJlcjsgdG9vbFVzZXM6IG51bWJlcjsgdGltZTogc3RyaW5nOyBjd2Q6IHN0cmluZzsgY3JlYXRlZEF0OiBzdHJpbmc7IHVwZGF0ZWRBdDogc3RyaW5nIH0+IH0+KCcvYXBpL3Nlc3Npb25zP2xpbWl0PTEwMCcpKSk7XG5cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnNlbmQtdGFzaycsIChldmVudCwgdGV4dDogdW5rbm93biwgc2Vzc2lvbklkOiB1bmtub3duLCBtb2RlOiB1bmtub3duLCBhdHRhY2htZW50czogdW5rbm93biwgaW1hZ2VzOiB1bmtub3duKSA9PiB7XG4gICAgICBjb25zdCB0YXNrID0gdHlwZW9mIHRleHQgPT09ICdzdHJpbmcnID8gdGV4dC5zbGljZSgwLCAyMF8wMDApIDogJyc7XG4gICAgICBjb25zdCBzaWQgPSB0eXBlb2Ygc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IHNlc3Npb25JZC5zbGljZSgwLCA4MCkgOiAnJztcbiAgICAgIGNvbnN0IG0gPSBtb2RlID09PSAnYXV0bycgfHwgbW9kZSA9PT0gJ3lvbG8nID8gbW9kZSA6ICdhc2snO1xuICAgICAgLy8gXHU5NjQ0XHU0RUY2Olx1NTQwRVx1N0FFRlx1NjM4OFx1Njc0MyBEVE8gXHU3Njg0XHU3RUREXHU1QkY5XHU4REVGXHU1Rjg0KEAgXHU5MDA5XHU2MkU5XHU1NjY4L1x1RDgzRFx1RENDRSBcdTRFMEFcdTRGMjBcdTUzRUFcdTY3NjVcdTgxRUFcdTY3MkNcdTU3MzBcdTY1ODdcdTRFRjZcdTdDRkJcdTdFREYpXG4gICAgICBjb25zdCBhdHRzID0gQXJyYXkuaXNBcnJheShhdHRhY2htZW50cykgPyBhdHRhY2htZW50cy5maWx0ZXIoKGEpOiBhIGlzIHN0cmluZyA9PiB0eXBlb2YgYSA9PT0gJ3N0cmluZycpLnNsaWNlKDAsIDEwKSA6IFtdO1xuICAgICAgLy8gXHU1NkZFXHU3MjQ3OnJ1bnRpbWUgdmlzaW9uIFx1OTRGRVx1NTM0Rlx1OEJBRSB7bmFtZSwgZGF0YVVybH0gYmFzZTY0KFx1MjI2NDMgXHU1RjIwIFx1MjI2NDZNQixyZW5kZXJlciBcdTc1MUZcdTYyMTApXG4gICAgICBjb25zdCBpbWdzID0gQXJyYXkuaXNBcnJheShpbWFnZXMpXG4gICAgICAgID8gaW1hZ2VzXG4gICAgICAgICAgICAuZmlsdGVyKChpbSk6IGltIGlzIHsgbmFtZTogc3RyaW5nOyBkYXRhVXJsOiBzdHJpbmcgfSA9PlxuICAgICAgICAgICAgICB0eXBlb2YgaW0gPT09ICdvYmplY3QnICYmIGltICE9PSBudWxsICYmIHR5cGVvZiAoaW0gYXMgeyBuYW1lPzogdW5rbm93biB9KS5uYW1lID09PSAnc3RyaW5nJyAmJiB0eXBlb2YgKGltIGFzIHsgZGF0YVVybD86IHVua25vd24gfSkuZGF0YVVybCA9PT0gJ3N0cmluZycpXG4gICAgICAgICAgICAuc2xpY2UoMCwgMylcbiAgICAgICAgICAgIC5tYXAoKGltKSA9PiAoeyBuYW1lOiBpbS5uYW1lLnNsaWNlKDAsIDEyMCksIGRhdGFVcmw6IGltLmRhdGFVcmwuc2xpY2UoMCwgOF81MDBfMDAwKSB9KSlcbiAgICAgICAgOiBbXTtcbiAgICAgIGlmICh0YXNrID09PSAnJyB8fCBzaWQgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgb2s6IGZhbHNlLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuOyBydW5JZD86IHN0cmluZyB9PignL2FwaS90YXNrJywgeyB0ZXh0OiB0YXNrLCBzZXNzaW9uSWQ6IHNpZCwgbW9kZTogbSwgYXR0YWNobWVudHM6IGF0dHMsIGltYWdlczogaW1ncyB9KSk7XG4gICAgfSk7XG5cbiAgICAvLyAtLS0tIFx1NkEyMVx1NTc4Qlx1NTIwN1x1NjM2MihydW50aW1lIFBPU1QgL2FwaS9tb2RlbDpcdTUyMDcgY2hhdCBcdThERUZcdTc1MzEsY29uZmlnIFx1NTM3M1x1NjVGNlx1NzUxRlx1NjU0OCkgLS0tLVxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6bW9kZWwtc2V0JywgKGV2ZW50LCBuYW1lOiB1bmtub3duKSA9PiB7XG4gICAgICBjb25zdCBuID0gdHlwZW9mIG5hbWUgPT09ICdzdHJpbmcnID8gbmFtZS50cmltKCkuc2xpY2UoMCwgODApIDogJyc7XG4gICAgICBpZiAobiA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ25hbWUgcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuOyBtb2RlbD86IHN0cmluZyB9PignL2FwaS9tb2RlbCcsIHsgbmFtZTogbiB9KSk7XG4gICAgfSk7XG5cbiAgICAvLyAtLS0tIFx1NjgwN1x1OTg5OFx1NjgwRlx1NEUzQlx1OTg5OFx1NTQwQ1x1NkI2NShcdTZENDVcdTgyNzJcdTZBMjFcdTVGMEZcdTRFMERcdTUxOERcdTY3MDlcdTlFRDFcdTY3NjEpKyBcdTI2MzAgXHU0RTNCXHU4M0RDXHU1MzU1IC0tLS1cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmNocm9tZS10aGVtZScsIChldmVudCwgZGFyazogdW5rbm93bikgPT4ge1xuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcbiAgICAgIGFwcGx5Q2hyb21lKGRhcmsgPT09IHRydWUpO1xuICAgICAgcmV0dXJuIHsgb2s6IHRydWUgfTtcbiAgICB9KTtcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnBvcHVwLW1haW4tbWVudScsIChldmVudCkgPT4ge1xuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcbiAgICAgIHBvcHVwTWFpbk1lbnUoKTtcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlIH07XG4gICAgfSk7XG5cbiAgICAvLyAtLS0tIFx1NjI0Qlx1NjczQVx1OEZEQ1x1N0EwQlx1NjNBN1x1NTIzNig3Nzg4IHdlYiBcdTVCODhcdTYyQTQ7XHU3NTI4XHU2MjM3XHU2NjNFXHU1RjBGXHU1NDJGXHU1MkE4LEFEUi0wMDUgXHU0RTBEXHU5RUQ4XHU4QkE0XHU1RjAwIExBTikgLS0tLVxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cmVtb3RlLXdlYi1zdGF0dXMnLCBhc3luYyAoZXZlbnQpID0+IHtcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XG4gICAgICBjb25zdCBwID0gYXdhaXQgcHJvYmVXZWJSZW1vdGUoKTtcbiAgICAgIHJldHVybiB7IHVwOiBwLnVwLCB2ZXJzaW9uOiBwLnZlcnNpb24sIGxhbklwOiBsYW5JcE9mKCksIHBvcnQ6IFdFQl9QT1JULCBhdmFpbGFibGU6IGNsaUVudHJ5T2YoKSAhPT0gJycgfTtcbiAgICB9KTtcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnJlbW90ZS13ZWItc3RhcnQnLCBhc3luYyAoZXZlbnQpID0+IHtcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XG4gICAgICBpZiAoY2xpRW50cnlPZigpID09PSAnJykgcmV0dXJuIHsgZXJyb3I6ICdubyBobWhhcm5lc3MgcnVudGltZSBkZXRlY3RlZCcsIGNvZGU6ICdIT1NUX05PVF9SRUFEWScgfTtcbiAgICAgIGlmICgoYXdhaXQgcHJvYmVXZWJSZW1vdGUoKSkudXApIHtcbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGFscmVhZHk6IHRydWUsIGxhblVybDogYGh0dHA6Ly8ke2xhbklwT2YoKSB8fCAnMTI3LjAuMC4xJ306JHtXRUJfUE9SVH1gIH07XG4gICAgICB9XG4gICAgICBydW5DbGkoWyd3ZWInLCAnc3RhcnQnLCAnLS1leHBvc3VyZT1sYW4nXSk7XG4gICAgICAvLyBcdTVCODhcdTYyQTRcdThGREJcdTdBMEJcdTUxQjdcdTU0MkZcdTUyQTgodHN4IFx1N0YxNlx1OEJEMVx1NjU3NFx1NTk1NyBDTEkpOlx1OEY2RVx1OEJFMiAyNXNcbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgNTA7IGkrKykge1xuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCA1MDApKTtcbiAgICAgICAgaWYgKChhd2FpdCBwcm9iZVdlYlJlbW90ZSgpKS51cCkge1xuICAgICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBsYW5Vcmw6IGBodHRwOi8vJHtsYW5JcE9mKCkgfHwgJzEyNy4wLjAuMSd9OiR7V0VCX1BPUlR9YCB9O1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICByZXR1cm4geyBlcnJvcjogJ3dlYiBkYWVtb24gZGlkIG5vdCBjb21lIHVwIHdpdGhpbiAyNXMgKHNlZSBITUhfSE9NRS93ZWIubG9nKScsIGNvZGU6ICdSVU5USU1FX0NSQVNIRUQnIH07XG4gICAgfSk7XG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpyZW1vdGUtd2ViLXN0b3AnLCBhc3luYyAoZXZlbnQpID0+IHtcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XG4gICAgICBydW5DbGkoWyd3ZWInLCAnc3RvcCddKTtcbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgMjA7IGkrKykge1xuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCA0MDApKTtcbiAgICAgICAgaWYgKCEoYXdhaXQgcHJvYmVXZWJSZW1vdGUoKSkudXApIHJldHVybiB7IG9rOiB0cnVlIH07XG4gICAgICB9XG4gICAgICBjb25zdCBzdGlsbCA9IChhd2FpdCBwcm9iZVdlYlJlbW90ZSgpKS51cDtcbiAgICAgIHJldHVybiBzdGlsbCA/IHsgZXJyb3I6ICdzdGlsbCBydW5uaW5nJywgY29kZTogJ0JSSURHRV9FUlJPUicgfSA6IHsgb2s6IHRydWUgfTtcbiAgICB9KTtcblxuICAgIC8vIC0tLS0gXHVEODNEXHVEQ0NFIFx1NjU4N1x1NEVGNlx1NEUwQVx1NEYyMChcdTY3MkNcdTU3MzBcdTU5MUFcdTkwMDk7cnVudGltZSBcdTY4MjFcdTlBOEMgaW5zaWRlV3MsXHU1REU1XHU0RjVDXHU1MzNBXHU1OTE2XHU2NTg3XHU0RUY2XHU0RjFBXHU4OEFCIDQwMCkgLS0tLVxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cGljay1maWxlcycsIGFzeW5jIChldmVudCwgdGl0bGU6IHVua25vd24pID0+IHtcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XG4gICAgICBjb25zdCB3aW4gPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5maW5kKCh3KSA9PiAhdy5pc0Rlc3Ryb3llZCgpKTtcbiAgICAgIGlmICh3aW4gPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgZXJyb3I6ICdubyB3aW5kb3cnLCBjb2RlOiAnQlJJREdFX0VSUk9SJyB9O1xuICAgICAgY29uc3QgciA9IGF3YWl0IGRpYWxvZy5zaG93T3BlbkRpYWxvZyh3aW4sIHtcbiAgICAgICAgdGl0bGU6IHR5cGVvZiB0aXRsZSA9PT0gJ3N0cmluZycgJiYgdGl0bGUgIT09ICcnID8gdGl0bGUuc2xpY2UoMCwgMTIwKSA6ICdcdTkwMDlcdTYyRTlcdTg5ODFcdTk2NDRcdTUyQTBcdTc2ODRcdTY1ODdcdTRFRjYoXHU1M0VGXHU1OTFBXHU5MDA5KScsXG4gICAgICAgIHByb3BlcnRpZXM6IFsnb3BlbkZpbGUnLCAnbXVsdGlTZWxlY3Rpb25zJ10sXG4gICAgICB9KTtcbiAgICAgIGlmIChyLmNhbmNlbGVkIHx8IHIuZmlsZVBhdGhzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBjYW5jZWxlZDogdHJ1ZSB9O1xuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHBhdGhzOiByLmZpbGVQYXRocy5zbGljZSgwLCAxMCkgfTtcbiAgICB9KTtcblxuICAgIC8vIC0tLS0gXHVEODNEXHVEQ0MxIFx1NzZFRVx1NUY1NVx1OTAwOVx1NjJFOShcdTVERTVcdTRGNUNcdTUzM0FcdTZERkJcdTUyQTBcdTc2ODRcdTZENEZcdTg5QzhcdTYzMDlcdTk0QUU7XHU1MzlGXHU3NTFGIGNob29zZXIpIC0tLS1cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnBpY2stZGlyZWN0b3J5JywgYXN5bmMgKGV2ZW50LCB0aXRsZTogdW5rbm93bikgPT4ge1xuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcbiAgICAgIGNvbnN0IHdpbiA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmZpbmQoKHcpID0+ICF3LmlzRGVzdHJveWVkKCkpO1xuICAgICAgaWYgKHdpbiA9PT0gdW5kZWZpbmVkKSByZXR1cm4geyBlcnJvcjogJ25vIHdpbmRvdycsIGNvZGU6ICdCUklER0VfRVJST1InIH07XG4gICAgICBjb25zdCByID0gYXdhaXQgZGlhbG9nLnNob3dPcGVuRGlhbG9nKHdpbiwge1xuICAgICAgICB0aXRsZTogdHlwZW9mIHRpdGxlID09PSAnc3RyaW5nJyAmJiB0aXRsZSAhPT0gJycgPyB0aXRsZS5zbGljZSgwLCAxMjApIDogJ1x1OTAwOVx1NjJFOVx1NjU4N1x1NEVGNlx1NTkzOScsXG4gICAgICAgIHByb3BlcnRpZXM6IFsnb3BlbkRpcmVjdG9yeSddLFxuICAgICAgfSk7XG4gICAgICBpZiAoci5jYW5jZWxlZCB8fCByLmZpbGVQYXRoc1swXSA9PT0gdW5kZWZpbmVkKSByZXR1cm4geyBvazogZmFsc2UsIGNhbmNlbGVkOiB0cnVlIH07XG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgcGF0aDogci5maWxlUGF0aHNbMF0gfTtcbiAgICB9KTtcblxuICAgIC8vIC0tLS0gQCBcdTk2NDRcdTRFRjY6XHU1REU1XHU0RjVDXHU1MzNBXHU2NTg3XHU0RUY2XHU2NDFDXHU3RDIyKHJ1bnRpbWUgXHU2Mzg4XHU2NzQzXHU3Njg0XHU4REVGXHU1Rjg0XHU2NzY1XHU2RTkwKSAtLS0tXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpmcy1zZWFyY2gnLCAoZXZlbnQsIHE6IHVua25vd24pID0+IHtcbiAgICAgIGNvbnN0IHF1ZXJ5ID0gdHlwZW9mIHEgPT09ICdzdHJpbmcnID8gcS5zbGljZSgwLCAyMDApIDogJyc7XG4gICAgICBpZiAocXVlcnkgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgcmVzdWx0czogW10gfSk7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248eyByZXN1bHRzOiBBcnJheTx7IHJlbDogc3RyaW5nOyBwYXRoOiBzdHJpbmcgfT4gfT4oYC9hcGkvZnMvc2VhcmNoP3E9JHtlbmNvZGVVUklDb21wb25lbnQocXVlcnkpfWApKTtcbiAgICB9KTtcblxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6YXBwcm92ZScsIChldmVudCwgZ3JhbnRlZDogdW5rbm93biwgc2Vzc2lvbklkOiB1bmtub3duKSA9PlxuICAgICAgaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvYXBwcm92ZScsIHtcbiAgICAgICAgZ3JhbnRlZDogZ3JhbnRlZCA9PT0gdHJ1ZSxcbiAgICAgICAgc2Vzc2lvbklkOiB0eXBlb2Ygc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IHNlc3Npb25JZC5zbGljZSgwLCA4MCkgOiAnJyxcbiAgICAgIH0pKSk7XG5cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmludGVycnVwdCcsIChldmVudCwgc2Vzc2lvbklkOiB1bmtub3duKSA9PlxuICAgICAgaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvaW50ZXJydXB0Jywge1xuICAgICAgICBzZXNzaW9uSWQ6IHR5cGVvZiBzZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gc2Vzc2lvbklkLnNsaWNlKDAsIDgwKSA6ICcnLFxuICAgICAgfSkpKTtcblxuICAgIC8vIC0tLS0gTTQ6XHU1REU1XHU0RjVDXHU1MzNBXHU2NTg3XHU0RUY2XHU5NzYyKFx1OERFRlx1NUY4NFx1NjM4OFx1Njc0M1x1NTcyOCBydW50aW1lOmluc2lkZVdzIFx1NjgyMVx1OUE4QykgLS0tLVxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6ZnMtbGlzdCcsIChldmVudCwgcGF0aDogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3QgcCA9IHR5cGVvZiBwYXRoID09PSAnc3RyaW5nJyA/IHBhdGguc2xpY2UoMCwgMTAwMCkgOiAnJztcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oYC9hcGkvZnM/ZmlsZXM9MSR7cCAhPT0gJycgPyBgJnBhdGg9JHtlbmNvZGVVUklDb21wb25lbnQocCl9YCA6ICcnfWApKTtcbiAgICB9KTtcblxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6ZnMtcmVhZCcsIChldmVudCwgcGF0aDogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3QgcCA9IHR5cGVvZiBwYXRoID09PSAnc3RyaW5nJyA/IHBhdGguc2xpY2UoMCwgMTAwMCkgOiAnJztcbiAgICAgIGlmIChwID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAncGF0aCByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KGAvYXBpL2ZzL3JlYWQ/cGF0aD0ke2VuY29kZVVSSUNvbXBvbmVudChwKX1gKSk7XG4gICAgfSk7XG5cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmluamVjdCcsIChldmVudCwgdGV4dDogdW5rbm93biwgc2Vzc2lvbklkOiB1bmtub3duKSA9PiB7XG4gICAgICBjb25zdCB0ID0gdHlwZW9mIHRleHQgPT09ICdzdHJpbmcnID8gdGV4dC5zbGljZSgwLCAyMF8wMDApIDogJyc7XG4gICAgICBjb25zdCBzaWQgPSB0eXBlb2Ygc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IHNlc3Npb25JZC5zbGljZSgwLCA4MCkgOiAnJztcbiAgICAgIGlmICh0ID09PSAnJyB8fCBzaWQgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgb2s6IGZhbHNlLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KCcvYXBpL2luamVjdCcsIHsgdGV4dDogdCwgc2Vzc2lvbklkOiBzaWQgfSkpO1xuICAgIH0pO1xuXG4gICAgLy8gLS0tLSBcdTRGMUFcdThCRERcdTVCRkNcdTUxRkEoZXhwb3J0Lm1kIFx1MjE5MiBcdTRGRERcdTVCNThcdTVCRjlcdThCRERcdTY4NDY7XHU2NTg3XHU0RUY2XHU1MTk5XHU1MTY1XHU1M0VBXHU1NzI4IG1haW4pIC0tLS1cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmV4cG9ydC1zZXNzaW9uJywgYXN5bmMgKGV2ZW50LCBpZDogdW5rbm93biwgdGl0bGU6IHVua25vd24pID0+IHtcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XG4gICAgICBjb25zdCBzaWQgPSB0eXBlb2YgaWQgPT09ICdzdHJpbmcnID8gaWQucmVwbGFjZSgvW15hLXpBLVowLTlfOi5ALV0vZywgJycpLnNsaWNlKDAsIDgwKSA6ICcnO1xuICAgICAgaWYgKHNpZCA9PT0gJycpIHJldHVybiB7IGVycm9yOiAnaWQgcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH07XG4gICAgICBpZiAoY2xpZW50ID09PSBudWxsIHx8IGJyaWRnZS5ob3N0U3RhdGUgIT09ICdyZWFkeScpIHJldHVybiB7IGVycm9yOiBgaG9zdCBub3QgcmVhZHkgKCR7YnJpZGdlLmhvc3RTdGF0ZX0pYCwgY29kZTogJ0hPU1RfTk9UX1JFQURZJyB9O1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgbWQgPSBhd2FpdCBjbGllbnQuZ2V0VGV4dChgL2FwaS9zZXNzaW9ucy8ke2VuY29kZVVSSUNvbXBvbmVudChzaWQpfS9leHBvcnQubWRgKTtcbiAgICAgICAgY29uc3Qgd2luID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkuZmluZCgodykgPT4gIXcuaXNEZXN0cm95ZWQoKSk7XG4gICAgICAgIGlmICh3aW4gPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgZXJyb3I6ICdubyB3aW5kb3cnLCBjb2RlOiAnQlJJREdFX0VSUk9SJyB9O1xuICAgICAgICBjb25zdCByID0gYXdhaXQgZGlhbG9nLnNob3dTYXZlRGlhbG9nKHdpbiwge1xuICAgICAgICAgIHRpdGxlOiB0eXBlb2YgdGl0bGUgPT09ICdzdHJpbmcnICYmIHRpdGxlICE9PSAnJyA/IHRpdGxlLnNsaWNlKDAsIDgwKSA6ICdcdTVCRkNcdTUxRkFcdTRGMUFcdThCREQnLFxuICAgICAgICAgIGRlZmF1bHRQYXRoOiBgaG1oLSR7c2lkfS5tZGAsXG4gICAgICAgICAgZmlsdGVyczogW3sgbmFtZTogJ01hcmtkb3duJywgZXh0ZW5zaW9uczogWydtZCddIH1dLFxuICAgICAgICB9KTtcbiAgICAgICAgaWYgKHIuY2FuY2VsZWQgfHwgci5maWxlUGF0aCA9PT0gdW5kZWZpbmVkIHx8IHIuZmlsZVBhdGggPT09ICcnKSByZXR1cm4geyBvazogZmFsc2UsIGNhbmNlbGVkOiB0cnVlIH07XG4gICAgICAgIGF3YWl0IHdyaXRlRmlsZShyLmZpbGVQYXRoLCBtZCwgJ3V0ZjgnKTtcbiAgICAgICAgbG9nSW5mbygnZXhwb3J0JywgYHNlc3Npb24gJHtzaWR9IFx1MjE5MiAke3IuZmlsZVBhdGh9YCk7XG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBwYXRoOiByLmZpbGVQYXRoIH07XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgY29uc3QgZGV0YWlsID0gKCgpID0+IHsgdHJ5IHsgcmV0dXJuIEpTT04uc3RyaW5naWZ5KGVycik7IH0gY2F0Y2ggeyByZXR1cm4gU3RyaW5nKGVycik7IH0gfSkoKS5zbGljZSgwLCAzMDApO1xuICAgICAgICByZXR1cm4geyBlcnJvcjogZGV0YWlsLCBjb2RlOiAnQlJJREdFX0VSUk9SJyB9O1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgLy8gLS0tLSBcdTVCQTFcdTYyNzlcdTZBMjFcdTVGMEZcdThCRkJcdTUxOTkoXHU2NzQzXHU1QTAxXHU1NzI4IHJ1bnRpbWUgY29uZmlnO1x1NTIwN1x1NjM2Mlx1NUZDNVx1OTg3Qlx1NjYzRVx1NUYwRikgLS0tLVxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6YXBwcm92YWwtZ2V0JywgKGV2ZW50KSA9PlxuICAgICAgaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248eyBzZXR0aW5ncz86IHsgYXBwcm92YWw/OiBzdHJpbmcgfSB9PignL2FwaS9zdGF0ZScpKSk7XG5cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmFwcHJvdmFsLXNldCcsIChldmVudCwgbW9kZTogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3QgbSA9IG1vZGUgPT09ICdhdXRvJyA/ICdhdXRvJyA6IG1vZGUgPT09ICdhc2snID8gJ2FzaycgOiAnJztcbiAgICAgIGlmIChtID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAnbW9kZSBtdXN0IGJlIGFza3xhdXRvJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PignL2FwaS9jb25maWcnLCB7IGFwcHJvdmFsOiBtIH0pKTtcbiAgICB9KTtcblxuICAgIC8vIC0tLS0gaG1oYXJuZXNzIHJ1bnRpbWUgXHU4RkRFXHU2M0E1KFx1ODFFQVx1NTJBOFx1NTNEMVx1NzNCMCArIFx1NjI0Qlx1NTJBOFx1ODk4Nlx1NzZENiArIFx1NzBFRFx1NTIwN1x1NjM2MikgLS0tLVxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cnVudGltZS1pbmZvJywgKGV2ZW50KSA9PiB7XG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgbW9kZTogYnJpZGdlLm1vZGUsXG4gICAgICAgIHJ1bnRpbWVFbnRyeTogYnJpZGdlLnJ1bnRpbWVFbnRyeSxcbiAgICAgICAgb3ZlcnJpZGU6IGxvYWRSdW50aW1lRW50cnlPdmVycmlkZSgpLFxuICAgICAgICBkZXRlY3RlZDogZGV0ZWN0UmVhbEVudHJ5KCksXG4gICAgICB9O1xuICAgIH0pO1xuXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpicm93c2UtcnVudGltZScsIGFzeW5jIChldmVudCwgdGl0bGU6IHVua25vd24pID0+IHtcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XG4gICAgICBjb25zdCB3aW4gPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5maW5kKCh3KSA9PiAhdy5pc0Rlc3Ryb3llZCgpKTtcbiAgICAgIGlmICh3aW4gPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgZXJyb3I6ICdubyB3aW5kb3cnLCBjb2RlOiAnQlJJREdFX0VSUk9SJyB9O1xuICAgICAgY29uc3QgciA9IGF3YWl0IGRpYWxvZy5zaG93T3BlbkRpYWxvZyh3aW4sIHtcbiAgICAgICAgdGl0bGU6IHR5cGVvZiB0aXRsZSA9PT0gJ3N0cmluZycgJiYgdGl0bGUgIT09ICcnID8gdGl0bGUuc2xpY2UoMCwgMTIwKSA6ICdcdTkwMDlcdTYyRTkgaG1oYXJuZXNzIFx1NzY4NCBkZXNrdG9wLWhvc3QgXHU1MTY1XHU1M0UzJyxcbiAgICAgICAgcHJvcGVydGllczogWydvcGVuRmlsZSddLFxuICAgICAgICBmaWx0ZXJzOiBbeyBuYW1lOiAnZGVza3RvcC1ob3N0JywgZXh0ZW5zaW9uczogWyd0cycsICdqcyddIH1dLFxuICAgICAgfSk7XG4gICAgICBpZiAoci5jYW5jZWxlZCB8fCByLmZpbGVQYXRoc1swXSA9PT0gdW5kZWZpbmVkKSByZXR1cm4geyBvazogZmFsc2UsIGNhbmNlbGVkOiB0cnVlIH07XG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgZW50cnk6IHIuZmlsZVBhdGhzWzBdIH07XG4gICAgfSk7XG5cbiAgICAvKiogXHU4QkJFXHU3RjZFL1x1NkUwNVx1OTY2NFx1NjI0Qlx1NTJBOFx1NTE2NVx1NTNFM1x1NTQwRVx1NzBFRFx1OTFDRFx1NTQyRiBob3N0KFx1N0E3QVx1NEUzMj1cdTU2REVcdTUyMzBcdTgxRUFcdTUyQThcdTUzRDFcdTczQjApXHUzMDAyICovXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpzZXQtcnVudGltZScsIGFzeW5jIChldmVudCwgZW50cnk6IHVua25vd24pID0+IHtcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XG4gICAgICBjb25zdCBlID0gdHlwZW9mIGVudHJ5ID09PSAnc3RyaW5nJyA/IGVudHJ5LnRyaW0oKSA6ICcnO1xuICAgICAgaWYgKGUgIT09ICcnICYmICghaXNBYnNvbHV0ZShlKSB8fCAhZXhpc3RzU3luYyhlKSkpIHtcbiAgICAgICAgcmV0dXJuIHsgZXJyb3I6ICdcdTUxNjVcdTUzRTNcdTVGQzVcdTk4N0JcdTY2MkZcdTVCNThcdTU3MjhcdTc2ODRcdTdFRERcdTVCRjlcdThERUZcdTVGODQoZGVza3RvcC1ob3N0LnRzKScsIGNvZGU6ICdCQURfUkVRVUVTVCcgfTtcbiAgICAgIH1cbiAgICAgIGF3YWl0IHNhdmVSdW50aW1lRW50cnlPdmVycmlkZShlKTtcbiAgICAgIC8vIFx1NzBFRFx1NTIwN1x1NjM2MjpcdTUxNDhcdTRGMThcdTk2QzVcdTUwNUNcdTYzODlcdTVGNTNcdTUyNEQgaG9zdCxcdTUxOERcdTYzMDlcdTY1QjBcdTkxNERcdTdGNkVcdTYyQzlcdThENzdcbiAgICAgIHNzZUFib3J0Py5hYm9ydCgpO1xuICAgICAgaWYgKHN1cGVydmlzb3IgIT09IG51bGwpIGF3YWl0IHN1cGVydmlzb3Iuc3RvcCgpO1xuICAgICAgYXdhaXQgc3RhcnRIb3N0KCk7XG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgbW9kZTogYnJpZGdlLm1vZGUgfTtcbiAgICB9KTtcblxuICAgIC8vIC0tLS0gUHJvdmlkZXIgXHU4QkJFXHU3RjZFKDAzIFx1MDBBN1x1NEUwMzprZXkgXHU1M0VBXHU1MUZBIGhhc0tleS9cdTY3MkJcdTU2REJcdTRGNEQ7XHU0RkREXHU1QjU4XHU3NkY0XHU1MTk5IHJ1bnRpbWUpIC0tLS1cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnByb3ZpZGVycycsIChldmVudCkgPT5cbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPHsgcHJvdmlkZXJzRGV0YWlsPzogQXJyYXk8eyBuYW1lOiBzdHJpbmc7IG1vZGVsOiBzdHJpbmc7IGJhc2VVcmw6IHN0cmluZzsgaGFzS2V5OiBib29sZWFuOyBrZXlUYWlsPzogc3RyaW5nIH0+OyBtb2RlbD86IHN0cmluZyB9PignL2FwaS9zdGF0ZScpKSk7XG5cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnByb3ZpZGVyLXNhdmUnLCAoZXZlbnQsIHByb3ZpZGVyOiB1bmtub3duKSA9PiB7XG4gICAgICBjb25zdCBwID0gcHJvdmlkZXIgYXMgeyBuYW1lPzogdW5rbm93bjsgYmFzZVVybD86IHVua25vd247IG1vZGVsPzogdW5rbm93bjsgYXBpS2V5PzogdW5rbm93biB9O1xuICAgICAgY29uc3QgbmFtZSA9IHR5cGVvZiBwPy5uYW1lID09PSAnc3RyaW5nJyA/IHAubmFtZS5zbGljZSgwLCA4MCkgOiAnJztcbiAgICAgIGNvbnN0IGJhc2VVcmwgPSB0eXBlb2YgcD8uYmFzZVVybCA9PT0gJ3N0cmluZycgPyBwLmJhc2VVcmwuc2xpY2UoMCwgMzAwKSA6ICcnO1xuICAgICAgY29uc3QgbW9kZWwgPSB0eXBlb2YgcD8ubW9kZWwgPT09ICdzdHJpbmcnID8gcC5tb2RlbC5zbGljZSgwLCAxMjApIDogJyc7XG4gICAgICBpZiAobmFtZSA9PT0gJycgfHwgYmFzZVVybCA9PT0gJycgfHwgbW9kZWwgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICduYW1lL2Jhc2VVcmwvbW9kZWwgcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xuICAgICAgY29uc3QgYm9keTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7IG5hbWUsIGJhc2VVcmwsIG1vZGVsIH07XG4gICAgICAvLyBhcGlLZXkgXHU1M0VBXHU1NzI4XHU2NjNFXHU1RjBGXHU4RjkzXHU1MTY1XHU2NUY2XHU0RTBBXHU0RjIwLFx1N0VERFx1NEUwRFx1NTZERVx1NjYzRShyZW5kZXJlciBcdTg4NjhcdTUzNTVcdTYzRDBcdTRFQTRcdTU0MEVcdTUzNzNcdTZFMDVcdTdBN0EpXG4gICAgICBpZiAodHlwZW9mIHA/LmFwaUtleSA9PT0gJ3N0cmluZycgJiYgcC5hcGlLZXkgIT09ICcnKSBib2R5LmFwaUtleSA9IHAuYXBpS2V5LnNsaWNlKDAsIDMwMCk7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvcHJvdmlkZXJzJywgYm9keSkpO1xuICAgIH0pO1xuXG4gICAgLy8gLS0tLSBcdTVERTVcdTRGNUNcdTUzM0EoMDMgXHUwMEE3XHU1MTZEO1x1NTIwN1x1NjM2Mlx1OEJFRFx1NEU0OVx1NEUwRSB3ZWIgXHU3NkY4XHU1NDBDOnJ1bnRpbWUgXHU1MzU1XHU5MDA5IGN3ZCkgLS0tLVxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6d29ya3NwYWNlcycsIChldmVudCkgPT5cbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPHsgY3VycmVudDogc3RyaW5nOyBpdGVtczogQXJyYXk8eyBpZDogc3RyaW5nOyBuYW1lOiBzdHJpbmc7IHBhdGg6IHN0cmluZyB9PiB9PignL2FwaS93b3Jrc3BhY2VzJykpKTtcblxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6d29ya3NwYWNlLXVzZScsIChldmVudCwgaWQ6IHVua25vd24pID0+IHtcbiAgICAgIGNvbnN0IHdpZCA9IHR5cGVvZiBpZCA9PT0gJ3N0cmluZycgPyBpZC5zbGljZSgwLCA2MCkgOiAnJztcbiAgICAgIGlmICh3aWQgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICdpZCByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvd29ya3NwYWNlcy91c2UnLCB7IGlkOiB3aWQgfSkpO1xuICAgIH0pO1xuXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTp3b3Jrc3BhY2UtYWRkJywgKGV2ZW50LCBuYW1lOiB1bmtub3duLCBwYXRoOiB1bmtub3duKSA9PiB7XG4gICAgICBjb25zdCBuID0gdHlwZW9mIG5hbWUgPT09ICdzdHJpbmcnID8gbmFtZS5zbGljZSgwLCAxMjApIDogJyc7XG4gICAgICBjb25zdCBwID0gdHlwZW9mIHBhdGggPT09ICdzdHJpbmcnID8gcGF0aC5zbGljZSgwLCAxMDAwKSA6ICcnO1xuICAgICAgaWYgKHAgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICdwYXRoIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PignL2FwaS93b3Jrc3BhY2VzJywgeyBuYW1lOiBuID09PSAnJyA/IHVuZGVmaW5lZCA6IG4sIHBhdGg6IHAgfSkpO1xuICAgIH0pO1xuXG4gICAgLy8gLS0tLSBcdTRGMUFcdThCRERcdTVGNTJcdTY4NjMvXHU1MjIwXHU5NjY0KFx1NzlGQlx1NTE2NSBhcmNoaXZlL3RyYXNoLFx1NTNFRlx1NjA2Mlx1NTkwRDtydW50aW1lIFx1Njc0M1x1NUEwMSkgLS0tLVxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6c2Vzc2lvbi1vcCcsIChldmVudCwgaWQ6IHVua25vd24sIG9wOiB1bmtub3duKSA9PiB7XG4gICAgICBjb25zdCBzaWQgPSB0eXBlb2YgaWQgPT09ICdzdHJpbmcnID8gaWQucmVwbGFjZSgvW15hLXpBLVowLTlfOi5ALV0vZywgJycpLnNsaWNlKDAsIDgwKSA6ICcnO1xuICAgICAgY29uc3QgbyA9IG9wID09PSAnYXJjaGl2ZScgfHwgb3AgPT09ICdkZWxldGUnID8gb3AgOiAnJztcbiAgICAgIGlmIChzaWQgPT09ICcnIHx8IG8gPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICdpZCBhbmQgb3AoYXJjaGl2ZXxkZWxldGUpIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PihgL2FwaS9zZXNzaW9ucy8ke2VuY29kZVVSSUNvbXBvbmVudChzaWQpfS8ke299YCwge30pKTtcbiAgICB9KTtcblxuICAgIC8vIC0tLS0gTTQ6RGlmZiBcdTk3NjJcdTY3N0YoXHU1M0VBXHU4QkZCIGdpdCBcdTUzRDhcdTY2RjQ7XHU2Mzg4XHU2NzQzXHU1NzI4IHJ1bnRpbWUpIC0tLS1cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmRpZmYnLCAoZXZlbnQsIHNlc3Npb25JZDogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIHNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBzZXNzaW9uSWQuc2xpY2UoMCwgODApIDogJyc7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KGAvYXBpL2RpZmYke3NpZCAhPT0gJycgPyBgP3Nlc3Npb25JZD0ke2VuY29kZVVSSUNvbXBvbmVudChzaWQpfWAgOiAnJ31gKSk7XG4gICAgfSk7XG5cbiAgICAvLyAtLS0tIE01Olx1OEJBNFx1NzdFNVx1NzJCNlx1NjAwMShcdTdFRDNcdTY3ODRcdTUzMTZcdTRFOEJcdTVCOUU7XHU3RjNBXHU2NTcwXHU2MzZFXHU1QjU3XHU2QkI1XHU3NTMxIFVJIFx1NjYzRVx1NzkzQVwiXHU2NUUwXHU2NTcwXHU2MzZFXCIpIC0tLS1cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmNvZ25pdGl2ZScsIChldmVudCkgPT5cbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPFJlY29yZDxzdHJpbmcsIHVua25vd24+PignL2FwaS9jb2duaXRpdmUnKSkpO1xuXG4gICAgLy8gLS0tLSBcdTUzODZcdTUzRjJcdTRGMUFcdThCRERcdTk4ODRcdTg5QzgoXHU2NzAwXHU1NDBFIDgwIFx1Njc2MSxcdTZCQ0ZcdTY3NjEgNTAwIFx1NUI1NztydW50aW1lIFx1Njc0M1x1NUEwMVx1NjU3MFx1NjM2RSkgLS0tLVxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6c2Vzc2lvbi1wcmV2aWV3JywgKGV2ZW50LCBpZDogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIGlkID09PSAnc3RyaW5nJyA/IGlkLnJlcGxhY2UoL1teYS16QS1aMC05XzouQC1dL2csICcnKS5zbGljZSgwLCA4MCkgOiAnJztcbiAgICAgIGlmIChzaWQgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICdpZCByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KGAvYXBpL3Nlc3Npb25zLyR7ZW5jb2RlVVJJQ29tcG9uZW50KHNpZCl9YCkpO1xuICAgIH0pO1xuXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpzdG9wLWhvc3QnLCAoZXZlbnQpID0+IHtcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicgfTtcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcbiAgICAgICAgc3NlQWJvcnQ/LmFib3J0KCk7XG4gICAgICAgIGF3YWl0IHN1cGVydmlzb3I/LnN0b3AoKTtcbiAgICAgICAgYXBwLnF1aXQoKTtcbiAgICAgIH0pKCk7XG4gICAgICByZXR1cm4geyBvazogdHJ1ZSB9O1xuICAgIH0pO1xuICB9XG5cbiAgLyogLS0tLSBcdTdBOTdcdTUzRTNcdTRFMEVcdTVCODlcdTUxNjhcdTdCNTZcdTc1NjUgLS0tLSAqL1xuICAvLyAwMyBcdTAwQTdcdTRFMDM6RGVza3RvcCBcdTY3MkNcdTU3MzBcdTUzRUFcdTVCNTggVUkgXHU1MDRGXHU1OTdEL1x1N0E5N1x1NTNFM1x1NzJCNlx1NjAwMSh1c2VyRGF0YS93aW5kb3ctc3RhdGUuanNvbilcbiAgY29uc3Qgd2luZG93U3RhdGVGaWxlID0gKCk6IHN0cmluZyA9PiBqb2luKGFwcC5nZXRQYXRoKCd1c2VyRGF0YScpLCAnd2luZG93LXN0YXRlLmpzb24nKTtcbiAgYXN5bmMgZnVuY3Rpb24gbG9hZEJvdW5kcygpOiBQcm9taXNlPHsgd2lkdGg6IG51bWJlcjsgaGVpZ2h0OiBudW1iZXI7IHg/OiBudW1iZXI7IHk/OiBudW1iZXIgfSB8IG51bGw+IHtcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIEpTT04ucGFyc2UoYXdhaXQgcmVhZEZpbGUod2luZG93U3RhdGVGaWxlKCksICd1dGY4JykpIGFzIHsgd2lkdGg6IG51bWJlcjsgaGVpZ2h0OiBudW1iZXI7IHg/OiBudW1iZXI7IHk/OiBudW1iZXIgfTtcbiAgICB9IGNhdGNoIHsgcmV0dXJuIG51bGw7IH1cbiAgfVxuICBhc3luYyBmdW5jdGlvbiBzYXZlQm91bmRzKHdpbjogQnJvd3NlcldpbmRvdyk6IFByb21pc2U8dm9pZD4ge1xuICAgIHRyeSB7IGF3YWl0IHdyaXRlRmlsZSh3aW5kb3dTdGF0ZUZpbGUoKSwgSlNPTi5zdHJpbmdpZnkod2luLmdldEJvdW5kcygpKSwgJ3V0ZjgnKTsgfSBjYXRjaCB7IC8qIGJlc3QgZWZmb3J0ICovIH1cbiAgfVxuXG4gIGFzeW5jIGZ1bmN0aW9uIGNyZWF0ZVdpbmRvdygpOiBQcm9taXNlPEJyb3dzZXJXaW5kb3cgfCBudWxsPiB7XG4gICAgY29uc3Qgc2F2ZWQgPSBhd2FpdCBsb2FkQm91bmRzKCk7XG4gICAgY29uc3Qgd2luID0gbmV3IEJyb3dzZXJXaW5kb3coe1xuICAgICAgd2lkdGg6IHNhdmVkPy53aWR0aCA/PyAxNDQwLFxuICAgICAgaGVpZ2h0OiBzYXZlZD8uaGVpZ2h0ID8/IDkwMCxcbiAgICAgIC4uLihzYXZlZD8ueCAhPT0gdW5kZWZpbmVkICYmIHNhdmVkPy55ICE9PSB1bmRlZmluZWQgPyB7IHg6IHNhdmVkLngsIHk6IHNhdmVkLnkgfSA6IHt9KSxcbiAgICAgIG1pbldpZHRoOiA5NjAsXG4gICAgICBtaW5IZWlnaHQ6IDYwMCxcbiAgICAgIHNob3c6IGZhbHNlLFxuICAgICAgYmFja2dyb3VuZENvbG9yOiAnIzE0MTQxNicsXG4gICAgICB0aXRsZTogJ0hNSCBEZXNrdG9wJyxcbiAgICAgIC8vIFx1OTY5MFx1ODVDRlx1NUYwRlx1NjgwN1x1OTg5OFx1NjgwRjpcdTUzOUZcdTc1MUZcdTdBOTdcdTUzRTNcdTYzQTdcdTUyMzYob3ZlcmxheSBcdTYzRDBcdTRGOUIpK1x1OTg5Q1x1ODI3Mlx1OTY4Rlx1NEUzQlx1OTg5OChyZW5kZXJlciBcdTdFQ0ZcbiAgICAgIC8vIGNocm9tZS10aGVtZSBcdTU0MENcdTZCNjUpXHUyMDE0XHUyMDE0XHU2ODM5XHU2Q0JCXHU0RUFFXHU4MjcyXHU2QTIxXHU1RjBGXHU5ODc2XHU5MEU4XHU5RUQxXHU2NzYxO1x1ODNEQ1x1NTM1NVx1NjgwRiBhdXRvSGlkZShBbHQgXHU1NDdDXHU1MUZBKVx1MzAwMlxuICAgICAgdGl0bGVCYXJTdHlsZTogJ2hpZGRlbicsXG4gICAgICB0aXRsZUJhck92ZXJsYXk6IHsgLi4uY2hyb21lRm9yKG5hdGl2ZVRoZW1lLnNob3VsZFVzZURhcmtDb2xvcnMpLCBoZWlnaHQ6IDM2IH0sXG4gICAgICBhdXRvSGlkZU1lbnVCYXI6IHRydWUsXG4gICAgICB3ZWJQcmVmZXJlbmNlczoge1xuICAgICAgICBwcmVsb2FkOiBwcmVsb2FkUGF0aCxcbiAgICAgICAgY29udGV4dElzb2xhdGlvbjogdHJ1ZSxcbiAgICAgICAgc2FuZGJveDogdHJ1ZSxcbiAgICAgICAgbm9kZUludGVncmF0aW9uOiBmYWxzZSxcbiAgICAgICAgbm9kZUludGVncmF0aW9uSW5Xb3JrZXI6IGZhbHNlLFxuICAgICAgICB3ZWJTZWN1cml0eTogdHJ1ZSxcbiAgICAgICAgc3BlbGxjaGVjazogZmFsc2UsXG4gICAgICAgIGRldlRvb2xzOiBpc0RldixcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgd2luLm9uY2UoJ3JlYWR5LXRvLXNob3cnLCAoKSA9PiB3aW4uc2hvdygpKTtcbiAgICB3aW4ub24oJ2Nsb3NlJywgKCkgPT4geyB2b2lkIHNhdmVCb3VuZHMod2luKTsgfSk7XG5cbiAgICAvLyBcdTUzRUFcdTUxNDFcdThCQjhcdTUyQTBcdThGN0RcdTYyMTFcdTRFRUNcdTgxRUFcdTVERjFcdTc2ODQgcmVuZGVyZXI7XHU0RUZCXHU0RjU1XHU1QkZDXHU4MjJBL1x1NjVCMFx1N0E5N1x1NTNFM1x1NEUwMFx1NUY4Qlx1NjJEMlx1N0VERFxuICAgIHdpbi53ZWJDb250ZW50cy5zZXRXaW5kb3dPcGVuSGFuZGxlcigoeyB1cmwgfSkgPT4ge1xuICAgICAgaWYgKC9eaHR0cHM/OlxcL1xcLy8udGVzdCh1cmwpKSB2b2lkIHNoZWxsLm9wZW5FeHRlcm5hbCh1cmwpO1xuICAgICAgcmV0dXJuIHsgYWN0aW9uOiAnZGVueScgfTtcbiAgICB9KTtcbiAgICB3aW4ud2ViQ29udGVudHMub24oJ3dpbGwtbmF2aWdhdGUnLCAoZSwgdXJsKSA9PiB7XG4gICAgICBjb25zdCBvayA9IFsuLi5hbGxvd2VkT3JpZ2luc10uc29tZSgobykgPT4gdXJsID09PSBvIHx8IHVybC5zdGFydHNXaXRoKGAke299L2ApIHx8IHVybC5zdGFydHNXaXRoKGAke299P2ApKTtcbiAgICAgIGlmICghb2spIHtcbiAgICAgICAgbG9nSW5mbygnbmF2JywgYGJsb2NrZWQgbmF2aWdhdGlvbiB0byAke3VybC5zbGljZSgwLCAxMjApfWApO1xuICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICBpZiAoaXNEZXYgJiYgcmVuZGVyZXJEZXZVcmwpIHtcbiAgICAgIHZvaWQgd2luLmxvYWRVUkwocmVuZGVyZXJEZXZVcmwpO1xuICAgIH0gZWxzZSB7XG4gICAgICB2b2lkIHdpbi5sb2FkRmlsZShqb2luKGhlcmUsICcuLicsICcuLicsICdkaXN0LXJlbmRlcmVyJywgJ2luZGV4Lmh0bWwnKSk7XG4gICAgfVxuICAgIC8vIFx1OTg3NVx1OTc2Mlx1NTJBMFx1OEY3RFx1NUI4Q1x1OTFDRFx1NjRBRFx1NUY1M1x1NTI0RCBob3N0IFx1NzJCNlx1NjAwMTpyZWFkeSBcdTVFN0ZcdTY0QURcdTgyRTVcdTY1RTlcdTRFOEUgcmVuZGVyZXIgXHU4QkEyXHU5NjA1XHU1MzczXHU0RTIyXHU1OTMxLFxuICAgIC8vIHJlbmRlcmVyIFx1NzY4NCBnZXQtc3RhdGUgXHU1RkVCXHU3MTY3ICsgXHU4RkQ5XHU5MUNDXHU3Njg0XHU5MUNEXHU2NEFEXHU1M0NDXHU0RkREXHU5NjY5KFx1NTkxQVx1N0E5N1x1NTNFMy9cdTkxQ0RcdThGN0RcdTU3M0FcdTY2NkZcdTRFNUZcdTg5ODZcdTc2RDYpXHUzMDAyXG4gICAgd2luLndlYkNvbnRlbnRzLm9uY2UoJ2RpZC1maW5pc2gtbG9hZCcsICgpID0+IHtcbiAgICAgIGlmICghd2luLmlzRGVzdHJveWVkKCkpIHtcbiAgICAgICAgd2luLndlYkNvbnRlbnRzLnNlbmQoJ2JyaWRnZTpob3N0LXN0YXRlJywgYnJpZGdlLmhvc3RTdGF0ZSwgeyByZXN0YXJ0Q291bnQ6IDAgfSk7XG4gICAgICB9XG4gICAgfSk7XG4gICAgcmV0dXJuIHdpbjtcbiAgfVxuXG4gIGFwcC53aGVuUmVhZHkoKS50aGVuKCgpID0+IHtcbiAgICAvLyBVSVZFUklGWTpmYWtlIFx1NkEyMVx1NUYwRlx1OUE4Q1x1NjUzNlx1OTg3Qlx1NTcyOCBzdGFydEhvc3QgXHU4QkZCIGVudiBcdTRFNEJcdTUyNERcdTVGM0FcdTUyMzYgZmFrZVxuICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWSA9PT0gJzEnICYmIHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX01PREUgIT09ICdyZWFsJykge1xuICAgICAgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfRkFLRSA9ICcxJztcbiAgICB9XG4gICAgLy8gV2luZG93cyBcdTkwMUFcdTc3RTVcdTVGNTJcdTVDNUUoXHU1NDI2XHU1MjE5XHU2NjNFXHU3OTNBXHU0RTNBIGVsZWN0cm9uLmV4ZSlcbiAgICBhcHAuc2V0QXBwVXNlck1vZGVsSWQoJ2Rldi5obWguZGVza3RvcCcpO1xuICAgIHNldHVwVHJheSgpO1xuICAgIGJ1aWxkQXBwTWVudSgpO1xuICAgIC8vIENTUChkZXYgXHU0RTBFIHByb2QgXHU0RTBEXHU1NDBDO3Byb2QgXHU0RTBEXHU1MTQxXHU4QkI4XHU0RUZCXHU0RjU1XHU4RkRDXHU3QTBCXHU2RTkwKVxuICAgIGNvbnN0IGNzcCA9IGlzRGV2XG4gICAgICA/IFtcbiAgICAgICAgICBcImRlZmF1bHQtc3JjICdzZWxmJ1wiLFxuICAgICAgICAgIGBzY3JpcHQtc3JjICdzZWxmJyAke3JlbmRlcmVyRGV2VXJsfWAsXG4gICAgICAgICAgXCJzdHlsZS1zcmMgJ3NlbGYnICd1bnNhZmUtaW5saW5lJ1wiLFxuICAgICAgICAgIGBjb25uZWN0LXNyYyAnc2VsZicgJHtyZW5kZXJlckRldlVybH0gd3M6Ly8xMjcuMC4wLjE6KmAsXG4gICAgICAgICAgXCJpbWctc3JjICdzZWxmJyBkYXRhOlwiLFxuICAgICAgICAgIFwiZm9udC1zcmMgJ3NlbGYnIGRhdGE6XCIsXG4gICAgICAgIF0uam9pbignOyAnKVxuICAgICAgOiBcImRlZmF1bHQtc3JjICdzZWxmJzsgc2NyaXB0LXNyYyAnc2VsZic7IHN0eWxlLXNyYyAnc2VsZicgJ3Vuc2FmZS1pbmxpbmUnOyBpbWctc3JjICdzZWxmJyBkYXRhOjsgZm9udC1zcmMgJ3NlbGYnIGRhdGE6XCI7XG4gICAgc2Vzc2lvbi5kZWZhdWx0U2Vzc2lvbi53ZWJSZXF1ZXN0Lm9uSGVhZGVyc1JlY2VpdmVkKChkZXRhaWxzLCBjYWxsYmFjaykgPT4ge1xuICAgICAgY2FsbGJhY2soe1xuICAgICAgICByZXNwb25zZUhlYWRlcnM6IHtcbiAgICAgICAgICAuLi5kZXRhaWxzLnJlc3BvbnNlSGVhZGVycyxcbiAgICAgICAgICAnQ29udGVudC1TZWN1cml0eS1Qb2xpY3knOiBbY3NwXSxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgcmVnaXN0ZXJJcGMoKTtcbiAgICAvLyBjcmVhdGVXaW5kb3cgXHU2NjJGIGFzeW5jKGJvdW5kcyBcdTYwNjJcdTU5MEQpO1x1NUI4OVx1NTE2OFx1ODFFQVx1NkQ0Qi9cdTZFMzJcdTY3RDNcdTgxRUFcdTY4QzBcdTU3MjhcdTdBOTdcdTUzRTNcdTVDMzFcdTdFRUFcdTU0MEVcdTYzMDJcdThGN0RcbiAgICB2b2lkIGNyZWF0ZVdpbmRvdygpLnRoZW4oKHdpbikgPT4ge1xuICAgICAgaWYgKHdpbiA9PT0gbnVsbCkgcmV0dXJuO1xuICAgICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZID09PSAnMScpIGF0dGFjaFVpVmVyaWZ5KHdpbik7XG4gICAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfU0VDVVJJVFlfVEVTVCA9PT0gJzEnKSB7XG4gICAgICAgIHdpbi53ZWJDb250ZW50cy5vbmNlKCdkaWQtZmluaXNoLWxvYWQnLCAoKSA9PiB7XG4gICAgICAgICAgdm9pZCBzZWN1cml0eVNlbGZUZXN0KHdpbik7XG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgICAgLy8gVUkgXHU2MjJBXHU1NkZFXHU5NEE5XHU1QjUwOkhNSF9ERVNLVE9QX1NOQVBTSE9UPTxmaWxlLnBuZz4gXHU1NzI4XHU3NTRDXHU5NzYyXHU1QzMxXHU3RUVBXHU1NDBFXHU2MjJBXHU1NkZFXHU5MDAwXHU1MUZBXG4gICAgICAvLyAoXHU4OEM1XHU2NzNBXHU4QkNBXHU2NUFEXHU3NTI4Olx1NEVCMlx1NzczQ1x1NzcwQlx1NkUzMlx1NjdEM1x1N0VEM1x1Njc5QyxcdTgwMENcdTRFMERcdTY2MkZcdTUzRUFcdTY1NzAgcm9vdCBcdTVCNTBcdTgyODJcdTcwQjkpXHUzMDAyXG4gICAgICBjb25zdCBzbmFwID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfU05BUFNIT1Q7XG4gICAgICBpZiAoc25hcCAhPT0gdW5kZWZpbmVkICYmIHNuYXAgIT09ICcnKSB7XG4gICAgICAgIHdpbi53ZWJDb250ZW50cy5vbmNlKCdkaWQtZmluaXNoLWxvYWQnLCAoKSA9PiB7XG4gICAgICAgICAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgICAgICB2b2lkIChhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgY29uc3QgaW1nID0gYXdhaXQgd2luLndlYkNvbnRlbnRzLmNhcHR1cmVQYWdlKCk7XG4gICAgICAgICAgICAgICAgY29uc3QgeyB3cml0ZUZpbGU6IHdmIH0gPSBhd2FpdCBpbXBvcnQoJ25vZGU6ZnMvcHJvbWlzZXMnKTtcbiAgICAgICAgICAgICAgICBhd2FpdCB3ZihzbmFwLCBpbWcudG9QTkcoKSk7XG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYFNOQVBTSE9UIG9rICR7c25hcH0gJHtpbWcuZ2V0U2l6ZSgpLndpZHRofXgke2ltZy5nZXRTaXplKCkuaGVpZ2h0fWApO1xuICAgICAgICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgU05BUFNIT1QgZXJyb3IgJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApfWApO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIGNvbnN0IGFwcDIgPSBhcHA7XG4gICAgICAgICAgICAgIHNldFRpbWVvdXQoKCkgPT4gYXBwMi5leGl0KDApLCA1MDApO1xuICAgICAgICAgICAgfSkoKTtcbiAgICAgICAgICB9LCBOdW1iZXIocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfU05BUFNIT1RfREVMQVlfTVMgPz8gMTJfMDAwKSk7XG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgICAgLy8gRE9NIFx1N0VEM1x1Njc4NFx1NjNBMlx1OTQ4ODpITUhfREVTS1RPUF9ET01QUk9CRT0xIFx1OEY5M1x1NTFGQVx1NTE3M1x1OTUyRVx1NTE0M1x1N0QyMFx1NzY4NCBib3gvZGlzcGxheS9jaGlsZHJlbixcbiAgICAgIC8vIFx1NTE4RFx1OTAwMFx1NTFGQShcdThCQ0FcdTY1QURcIlJlYWN0IFx1NjMwMlx1OEY3RFx1NEU4Nlx1NEY0Nlx1NjdEMFx1NTc1NyBVSSBcdTRFMERcdTUzRUZcdTg5QzFcIlx1OEZEOVx1N0M3Qlx1OTVFRVx1OTg5ODtcdTYyMkFcdTU2RkVcdTRFNEJcdTU5MTZcdTc2ODRcdTc4NkNcdThCQzFcdTYzNkUpXHUzMDAyXG4gICAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfRE9NUFJPQkUgPT09ICcxJykge1xuICAgICAgICB3aW4ud2ViQ29udGVudHMub25jZSgnZGlkLWZpbmlzaC1sb2FkJywgKCkgPT4ge1xuICAgICAgICAgIHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGNvbnN0IHIgPSAoYXdhaXQgd2luLndlYkNvbnRlbnRzLmV4ZWN1dGVKYXZhU2NyaXB0KGAoZnVuY3Rpb24oKXtcbiAgICAgICAgICAgICAgICAgIHZhciBwaWNrID0gZnVuY3Rpb24oc2VsKXtcbiAgICAgICAgICAgICAgICAgICAgdmFyIGVscyA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoc2VsKTtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGVscywgMCwgNCkubWFwKGZ1bmN0aW9uKGVsKXtcbiAgICAgICAgICAgICAgICAgICAgICB2YXIgY3MgPSBnZXRDb21wdXRlZFN0eWxlKGVsKTtcbiAgICAgICAgICAgICAgICAgICAgICB2YXIgYiA9IGVsLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB7IGNsczogKGVsLmNsYXNzTmFtZXx8JycpLnRvU3RyaW5nKCkuc2xpY2UoMCw4MCksIHRhZzogZWwudGFnTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGRpc3BsYXk6IGNzLmRpc3BsYXksIHZpczogY3MudmlzaWJpbGl0eSwgb3BhY2l0eTogY3Mub3BhY2l0eSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHBvczogY3MucG9zaXRpb24sIHo6IGNzLnpJbmRleCwgb3ZlcmZsb3c6IGNzLm92ZXJmbG93LFxuICAgICAgICAgICAgICAgICAgICAgICAgeDogTWF0aC5yb3VuZChiLngpLCB5OiBNYXRoLnJvdW5kKGIueSksIHc6IE1hdGgucm91bmQoYi53aWR0aCksIGg6IE1hdGgucm91bmQoYi5oZWlnaHQpLFxuICAgICAgICAgICAgICAgICAgICAgICAgdGV4dDogKGVsLmlubmVyVGV4dHx8JycpLnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw2MCkgfTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgICAgdmFyIHNlbHMgPSBbJ2h0bWwnLCdib2R5JywnI3Jvb3QnLCcuYXBwLXNoZWxsJywnLnNpZGViYXInLCcud29ya3NwYWNlJywnLnRvcGJhcicsJy5zdHJlYW0nLCcuZW1wdHktaGludCcsJy5jb21wb3NlcicsJy5jb21wb3Nlci1yb3cnLCcuY29tcG9zZXIgdGV4dGFyZWEnLCcuY29tcG9zZXItc2lkZScsJy5hdHQtcGlja2VyJywnLmF0dC1jaGlwcycsJy5zaWRlcGFuZWwnLCcucnVudGltZS1ndWlkZScsJy5vdmVybGF5JywnLnR1cm4nLCcuY2FyZCddO1xuICAgICAgICAgICAgICAgICAgdmFyIG91dCA9IHt9O1xuICAgICAgICAgICAgICAgICAgc2Vscy5mb3JFYWNoKGZ1bmN0aW9uKHMpeyB0cnkgeyBvdXRbc10gPSBwaWNrKHMpOyB9IGNhdGNoKGUpeyBvdXRbc10gPSBbe2VycjogU3RyaW5nKGUpLnNsaWNlKDAsODApfV07IH0gfSk7XG4gICAgICAgICAgICAgICAgICBvdXQuX19tZXRhID0ge1xuICAgICAgICAgICAgICAgICAgICBzdHlsZVNoZWV0czogZG9jdW1lbnQuc3R5bGVTaGVldHMubGVuZ3RoLFxuICAgICAgICAgICAgICAgICAgICBzaGVldDBydWxlczogKGRvY3VtZW50LnN0eWxlU2hlZXRzWzBdICYmIGRvY3VtZW50LnN0eWxlU2hlZXRzWzBdLmNzc1J1bGVzKSA/IGRvY3VtZW50LnN0eWxlU2hlZXRzWzBdLmNzc1J1bGVzLmxlbmd0aCA6IC0xLFxuICAgICAgICAgICAgICAgICAgICByb290Q2hpbGRyZW46IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyb290JykgPyBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncm9vdCcpLmNoaWxkcmVuLmxlbmd0aCA6IC0xLFxuICAgICAgICAgICAgICAgICAgICBib2R5Q2hpbGRyZW46IGRvY3VtZW50LmJvZHkuY2hpbGRyZW4ubGVuZ3RoLFxuICAgICAgICAgICAgICAgICAgICBpbm5lckhUTUxMZW46IGRvY3VtZW50LmJvZHkuaW5uZXJIVE1MLmxlbmd0aCxcbiAgICAgICAgICAgICAgICAgICAgdmlld3BvcnQ6IHdpbmRvdy5pbm5lcldpZHRoICsgJ3gnICsgd2luZG93LmlubmVySGVpZ2h0XG4gICAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KG91dCk7XG4gICAgICAgICAgICAgICAgfSkoKWAsIHRydWUpKSBhcyBzdHJpbmc7XG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYERPTVBST0JFICR7cn1gKTtcbiAgICAgICAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYERPTVBST0JFIGVycm9yICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMjAwKX1gKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICBhcHAuZXhpdCgwKTtcbiAgICAgICAgICAgIH0pKCk7XG4gICAgICAgICAgfSwgTnVtYmVyKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX0RPTVBST0JFX0RFTEFZX01TID8/IDlfMDAwKSk7XG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgICAgLy8gXHU2RTMyXHU2N0QzXHU4MUVBXHU2OEMwKDIwMjYtMTAtMTAgXHU4OEM1XHU2NzNBXHU5RUQxXHU1QzRGXHU2NTU5XHU4QkFEOmJyaWRnZSByZWFkeSBcdTIyNjAgXHU3NTRDXHU5NzYyXHU2RTMyXHU2N0QzXHU0RTg2KVx1MzAwMlxuICAgICAgLy8gI3Jvb3QgXHU1NzI4IFJlYWN0IFx1NjMwMlx1OEY3RFx1NTQwRVx1NUZDNVx1NjcwOVx1NUI1MFx1ODI4Mlx1NzBCOTtcdTdBN0EgPSBcdThENDRcdTZFOTBcdThERUZcdTVGODQvQ1NQL1x1ODExQVx1NjcyQ1x1NTJBMFx1OEY3RFx1NTc0Rlx1NEU4Nlx1MzAwMlxuICAgICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1JFTkRFUl9URVNUID09PSAnMScpIHtcbiAgICAgICAgd2luLndlYkNvbnRlbnRzLm9uY2UoJ2RpZC1maW5pc2gtbG9hZCcsICgpID0+IHtcbiAgICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcbiAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBjb25zdCBuID0gKGF3YWl0IHdpbi53ZWJDb250ZW50cy5leGVjdXRlSmF2YVNjcmlwdChcbiAgICAgICAgICAgICAgICAgICdkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInJvb3RcIikgPyBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInJvb3RcIikuY2hpbGRyZW4ubGVuZ3RoIDogLTEnLCB0cnVlLFxuICAgICAgICAgICAgICAgICkpIGFzIG51bWJlcjtcbiAgICAgICAgICAgICAgICBjb25zdCBvayA9IG4gPiAwO1xuICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBSRU5ERVItVEVTVCAke29rID8gJ29rJyA6ICdFTVBUWSd9IHJvb3RDaGlsZHJlbj0ke259YCk7XG4gICAgICAgICAgICAgICAgYXBwLmV4aXQob2sgPyAwIDogMSk7XG4gICAgICAgICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBSRU5ERVItVEVTVCBFUlJPUiAke1N0cmluZyhlcnIpLnNsaWNlKDAsIDEyMCl9YCk7XG4gICAgICAgICAgICAgICAgYXBwLmV4aXQoMSk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pKCk7XG4gICAgICAgICAgfSwgMl81MDApO1xuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICB2b2lkIHN0YXJ0SG9zdCgpO1xuXG4gICAgYXBwLm9uKCdhY3RpdmF0ZScsICgpID0+IHtcbiAgICAgIGlmIChCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5sZW5ndGggPT09IDApIHZvaWQgY3JlYXRlV2luZG93KCk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGFzeW5jIGZ1bmN0aW9uIHNlY3VyaXR5U2VsZlRlc3Qod2luOiBCcm93c2VyV2luZG93KTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgcmVzdWx0czogQXJyYXk8W3N0cmluZywgYm9vbGVhbiwgc3RyaW5nXT4gPSBbXTtcbiAgICBjb25zdCBjaGVjayA9IGFzeW5jIChuYW1lOiBzdHJpbmcsIHByb2JlOiAoKSA9PiBQcm9taXNlPFtib29sZWFuLCBzdHJpbmddPik6IFByb21pc2U8dm9pZD4gPT4ge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgW29rLCBkZXRhaWxdID0gYXdhaXQgcHJvYmUoKTtcbiAgICAgICAgcmVzdWx0cy5wdXNoKFtuYW1lLCBvaywgZGV0YWlsXSk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgcmVzdWx0cy5wdXNoKFtuYW1lLCBmYWxzZSwgU3RyaW5nKGVycikuc2xpY2UoMCwgMTIwKV0pO1xuICAgICAgfVxuICAgIH07XG4gICAgY29uc3QganMgPSAoY29kZTogc3RyaW5nKTogUHJvbWlzZTx1bmtub3duPiA9PiB3aW4ud2ViQ29udGVudHMuZXhlY3V0ZUphdmFTY3JpcHQoY29kZSwgdHJ1ZSk7XG5cbiAgICBhd2FpdCBjaGVjaygncmVuZGVyZXIgXHU2NUUwXHU1M0VGXHU3NTI4XHU3Njg0IHByb2Nlc3MvcmVxdWlyZShzYW5kYm94IFx1NzUxRlx1NjU0OCknLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKGAoZnVuY3Rpb24oKXtcbiAgICAgICAgdmFyIHQgPSBmdW5jdGlvbihmKXsgdHJ5IHsgdmFyIHYgPSBmKCk7IHJldHVybiAodiA9PT0gdW5kZWZpbmVkIHx8IHYgPT09IG51bGwpID8gJ3VuYXZhaWxhYmxlJyA6IHR5cGVvZiB2OyB9IGNhdGNoKGUpeyByZXR1cm4gJ2Jsb2NrZWQnOyB9IH07XG4gICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeShbdChmdW5jdGlvbigpe3JldHVybiBwcm9jZXNzfSksIHQoZnVuY3Rpb24oKXtyZXR1cm4gcmVxdWlyZX0pLCB0KGZ1bmN0aW9uKCl7cmV0dXJuIGdsb2JhbFRoaXMucHJvY2Vzc30pXSk7XG4gICAgICB9KSgpYCkpIGFzIHN0cmluZztcbiAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocikgYXMgc3RyaW5nW107XG4gICAgICBjb25zdCBwID0gcGFyc2VkWzBdID8/ICd1bmtub3duJztcbiAgICAgIGNvbnN0IHJlcSA9IHBhcnNlZFsxXSA/PyAndW5rbm93bic7XG4gICAgICBjb25zdCBzYWZlID0gKHY6IHN0cmluZyk6IGJvb2xlYW4gPT4gdiA9PT0gJ3VuYXZhaWxhYmxlJyB8fCB2ID09PSAnYmxvY2tlZCc7XG4gICAgICByZXR1cm4gW3NhZmUocCkgJiYgc2FmZShyZXEpLCBgcHJvY2Vzcz0ke3B9IHJlcXVpcmU9JHtyZXF9YF07XG4gICAgfSk7XG4gICAgYXdhaXQgY2hlY2soJ3dpbmRvdy5obWggXHU1M0VBXHU2NzA5XHU3NjdEXHU1NDBEXHU1MzU1XHU2NUI5XHU2Q0Q1KFx1NjVFMCBpcGNSZW5kZXJlci9cdTk4OURcdTU5MTZcdTk3NjIpJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgciA9IChhd2FpdCBqcygnT2JqZWN0LmtleXMod2luZG93LmhtaCB8fCB7fSkuc29ydCgpLmpvaW4oXCIsXCIpJykpIGFzIHN0cmluZztcbiAgICAgIGNvbnN0IGFsbG93ID0gWydhcHByb3ZlJywgJ2FwcHJvdmFsR2V0JywgJ2FwcHJvdmFsU2V0JywgJ2Jyb3dzZVJ1bnRpbWUnLCAnY2hyb21lVGhlbWUnLCAnY29nbml0aXZlJywgJ2RpZmYnLCAnZXhwb3J0U2Vzc2lvbicsICdmc0xpc3QnLCAnZnNSZWFkJywgJ2ZzU2VhcmNoJywgJ2dldFN0YXRlJywgJ2luamVjdCcsICdpbnRlcnJ1cHQnLCAnbW9kZWxTZXQnLCAnb25FdmVudEJhdGNoZXMnLCAnb25Ib3N0U3RhdGUnLCAnb25NZW51QWN0aW9uJywgJ29uU3RyZWFtQ2h1bmtzJywgJ3BpY2tEaXJlY3RvcnknLCAncGlja0ZpbGVzJywgJ3BvcHVwTWFpbk1lbnUnLCAncHJvdmlkZXJTYXZlJywgJ3Byb3ZpZGVycycsICdyZW1vdGVXZWJTdGFydCcsICdyZW1vdGVXZWJTdGF0dXMnLCAncmVtb3RlV2ViU3RvcCcsICdydW50aW1lSW5mbycsICdzZW5kVGFzaycsICdzZXNzaW9uT3AnLCAnc2Vzc2lvblByZXZpZXcnLCAnc2Vzc2lvbnMnLCAnc2V0UnVudGltZScsICdzdG9wSG9zdCcsICd3b3Jrc3BhY2VzJywgJ3dvcmtzcGFjZUFkZCcsICd3b3Jrc3BhY2VVc2UnXTtcbiAgICAgIGNvbnN0IGdvdCA9IHIgPT09ICcnID8gW10gOiByLnNwbGl0KCcsJyk7XG4gICAgICBjb25zdCB1bmV4cGVjdGVkID0gZ290LmZpbHRlcigoaykgPT4gIWFsbG93LmluY2x1ZGVzKGspKTtcbiAgICAgIHJldHVybiBbdW5leHBlY3RlZC5sZW5ndGggPT09IDAsIGBrZXlzPSR7cn1gXTtcbiAgICB9KTtcbiAgICBhd2FpdCBjaGVjaygnXHU1OTE2XHU5MEU4XHU1QkZDXHU4MjJBXHU4OEFCXHU2MkU2XHU2MjJBKFVSTCBcdTRFMERcdTUzRDgpJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgYmVmb3JlID0gd2luLndlYkNvbnRlbnRzLmdldFVSTCgpO1xuICAgICAgYXdhaXQganMoJ2xvY2F0aW9uLmhyZWYgPSBcImh0dHBzOi8vZXhhbXBsZS5pbnZhbGlkL3hcIjsgXCJub29wXCInKS5jYXRjaCgoKSA9PiAnbm9vcCcpO1xuICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHIyKSA9PiBzZXRUaW1lb3V0KHIyLCAxXzIwMCkpO1xuICAgICAgY29uc3QgYWZ0ZXIgPSB3aW4ud2ViQ29udGVudHMuZ2V0VVJMKCk7XG4gICAgICByZXR1cm4gW2FmdGVyID09PSBiZWZvcmUsIGAke2JlZm9yZX0gXHUyMTkyICR7YWZ0ZXJ9YF07XG4gICAgfSk7XG4gICAgYXdhaXQgY2hlY2soJ3dpbmRvdy5vcGVuIFx1ODhBQlx1NjJEMlx1N0VERChcdThGRDRcdTU2REUgbnVsbCBcdTRFMTRcdTY1RTBcdTY1QjBcdTdBOTdcdTUzRTMpJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgYmVmb3JlID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkubGVuZ3RoO1xuICAgICAgY29uc3QgciA9IChhd2FpdCBqcygnU3RyaW5nKHdpbmRvdy5vcGVuKFwiaHR0cHM6Ly9leGFtcGxlLmludmFsaWRcIikpJykpIGFzIHN0cmluZztcbiAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyMikgPT4gc2V0VGltZW91dChyMiwgNDAwKSk7XG4gICAgICBjb25zdCBhZnRlciA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmxlbmd0aDtcbiAgICAgIHJldHVybiBbciA9PT0gJ251bGwnICYmIGFmdGVyID09PSBiZWZvcmUsIGBvcGVuKCk9JHtyfSB3aW5kb3dzPSR7YmVmb3JlfVx1MjE5MiR7YWZ0ZXJ9YF07XG4gICAgfSk7XG4gICAgYXdhaXQgY2hlY2soJ0NTUCBcdTVCNThcdTU3MjgobWV0YSBcdTZDRThcdTUxNjVcdTYyMTZcdTU0Q0RcdTVFOTRcdTU5MzQpJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgbWV0YSA9IChhd2FpdCBqcygnQm9vbGVhbihkb2N1bWVudC5xdWVyeVNlbGVjdG9yKFwibWV0YVtodHRwLWVxdWl2PVxcJ0NvbnRlbnQtU2VjdXJpdHktUG9saWN5XFwnXVwiKSknKSkgYXMgYm9vbGVhbjtcbiAgICAgIGNvbnN0IGhlYWRlckNzcCA9IGlzRGV2ID8gJ2RldjogaGVhZGVyIENTUCBcdTc1MzEgb25IZWFkZXJzUmVjZWl2ZWQgXHU2Q0U4XHU1MTY1KFx1NEUwRFx1OTAwMlx1NzUyOCBtZXRhIFx1NjVBRFx1OEEwMCknIDogJ3Byb2QnO1xuICAgICAgcmV0dXJuIFttZXRhIHx8IGlzRGV2LCBgbWV0YT0ke21ldGF9ICR7aGVhZGVyQ3NwfWBdO1xuICAgIH0pO1xuICAgIGF3YWl0IGNoZWNrKCdicmlkZ2U6Z2V0LXN0YXRlIFx1NkI2M1x1NUUzOFx1OEZENFx1NTZERShob3N0IFx1Njg2NVx1NTNFRlx1NzUyOCknLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKCd3aW5kb3cuaG1oLmdldFN0YXRlKCkudGhlbihzID0+IEpTT04uc3RyaW5naWZ5KHMpKS5jYXRjaChlID0+IFwiRVJSOlwiK2UpJykpIGFzIHN0cmluZztcbiAgICAgIHJldHVybiBbci5zdGFydHNXaXRoKCd7JykgJiYgci5pbmNsdWRlcygnaG9zdFN0YXRlJyksIHIuc2xpY2UoMCwgODApXTtcbiAgICB9KTtcbiAgICBhd2FpdCBjaGVjaygnWFNTOlx1NjA3Nlx1NjEwRlx1NEVGQlx1NTJBMVx1NjU4N1x1NjcyQ1x1NTNFQVx1NEVFNVx1NjU4N1x1NjcyQ1x1NkUzMlx1NjdEMyhcdTRFMERcdTYyNjdcdTg4NEMpJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgcGF5bG9hZCA9ICc8aW1nIHNyYz14IG9uZXJyb3I9XCJ3aW5kb3cuX194c3M9MVwiPjxzY3JpcHQ+d2luZG93Ll9feHNzPTI8XFwvc2NyaXB0PlwiJlxcJyc7XG4gICAgICBjb25zdCBzZW5kUiA9IChhd2FpdCBqcyhgd2luZG93LmhtaC5zZW5kVGFzaygke0pTT04uc3RyaW5naWZ5KHBheWxvYWQpfSwgJ3NlYy14c3MtMScsICdhdXRvJykudGhlbihyPT5KU09OLnN0cmluZ2lmeShyKSkuY2F0Y2goZT0+J0VSUjonK2UpYCkpIGFzIHN0cmluZztcbiAgICAgIGlmICghc2VuZFIuaW5jbHVkZXMoJ1wib2tcIjp0cnVlJykpIHJldHVybiBbZmFsc2UsIGBzZW5kVGFzayBcdTY3MkFcdTUzRDdcdTc0MDY6ICR7c2VuZFIuc2xpY2UoMCwgODApfWBdO1xuICAgICAgLy8gZmFrZSBob3N0IGVjaG8gXHU1NkRFXHU2NzY1XHU1NDBFXHU3RUNGIFJlYWN0IFx1NkUzMlx1NjdEMyhcdTc1MjhcdTYyMzdcdTZEODhcdTYwNkYgKyBcdTUyQTlcdTYyNEIgZWNobyBcdTUzQ0NcdThERUZcdTVGODQpXG4gICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocjIpID0+IHNldFRpbWVvdXQocjIsIDNfMDAwKSk7XG4gICAgICBjb25zdCBwcm9iZSA9IChhd2FpdCBqcyhgSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICB4c3NGbGFnOiB0eXBlb2Ygd2luZG93Ll9feHNzLFxuICAgICAgICBpbWdDb3VudDogZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnaW1nW3NyYz1cInhcIl0nKS5sZW5ndGgsXG4gICAgICAgIHNjcmlwdFJhbjogZG9jdW1lbnQuYm9keS5pbm5lclRleHQuaW5kZXhPZignd2luZG93Ll9feHNzPTInKSA+PSAwXG4gICAgICB9KWApKSBhcyBzdHJpbmc7XG4gICAgICBjb25zdCBwID0gSlNPTi5wYXJzZShwcm9iZSkgYXMgeyB4c3NGbGFnOiBzdHJpbmc7IGltZ0NvdW50OiBudW1iZXI7IHNjcmlwdFJhbjogYm9vbGVhbiB9O1xuICAgICAgcmV0dXJuIFtwLnhzc0ZsYWcgPT09ICd1bmRlZmluZWQnICYmIHAuaW1nQ291bnQgPT09IDAsIGB4c3NGbGFnPSR7cC54c3NGbGFnfSBpbWc9JHtwLmltZ0NvdW50fWBdO1xuICAgIH0pO1xuXG4gICAgbGV0IGZhaWxlZCA9IDA7XG4gICAgZm9yIChjb25zdCBbbmFtZSwgb2ssIGRldGFpbF0gb2YgcmVzdWx0cykge1xuICAgICAgY29uc29sZS5sb2coYFNFQ1VSSVRZLVRFU1QgJHtvayA/ICdQQVNTJyA6ICdGQUlMJ30gfCAke25hbWV9IHwgJHtyZWRhY3QoZGV0YWlsKX1gKTtcbiAgICAgIGlmICghb2spIGZhaWxlZCArPSAxO1xuICAgIH1cbiAgICBjb25zb2xlLmxvZyhgU0VDVVJJVFktVEVTVCBTVU1NQVJZIHBhc3M9JHtyZXN1bHRzLmxlbmd0aCAtIGZhaWxlZH0vJHtyZXN1bHRzLmxlbmd0aH1gKTtcbiAgICBhcHAuZXhpdChmYWlsZWQgPT09IDAgPyAwIDogMSk7XG4gIH1cblxuICAvLyBcdTkwMDBcdTUxRkE6XHU0RjE4XHU5NkM1XHU1MDVDXHU2QjYyXHU4MUVBXHU1REYxIHNwYXduIFx1NzY4NCBob3N0KHNodXRkb3duIFx1N0FFRlx1NzBCOSBcdTIxOTIgXHU1MTVDXHU1RTk1XHU1M0VBIGtpbGwgXHU4MUVBXHU1REYxXHU3Njg0XHU1M0U1XHU2N0M0KVxuICBhcHAub24oJ2JlZm9yZS1xdWl0JywgKGUpID0+IHtcbiAgICBpZiAoc3VwZXJ2aXNvciAhPT0gbnVsbCAmJiBzdXBlcnZpc29yLnN0YXRlICE9PSAnc3RvcHBlZCcpIHtcbiAgICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICAgIHNzZUFib3J0Py5hYm9ydCgpO1xuICAgICAgdm9pZCBzdXBlcnZpc29yLnN0b3AoKS5maW5hbGx5KCgpID0+IGFwcC5xdWl0KCkpO1xuICAgIH1cbiAgfSk7XG4gIGFwcC5vbignd2luZG93LWFsbC1jbG9zZWQnLCAoKSA9PiB7XG4gICAgaWYgKHByb2Nlc3MucGxhdGZvcm0gIT09ICdkYXJ3aW4nKSBhcHAucXVpdCgpO1xuICB9KTtcbn1cbiIsICIvKipcbiAqIERlc2t0b3BSdW50aW1lU3VwZXJ2aXNvciBcdTIwMTQgaG1oYXJuZXNzIGhvc3QgXHU4RkRCXHU3QTBCXHU3Njg0XHU3NTFGXHU1NDdEXHU1NDY4XHU2NzFGXHU3MkI2XHU2MDAxXHU2NzNBKEFEUi0wMDMpXHUzMDAyXG4gKlxuICogXHU1Qjg5XHU1MTY4XHU0RTBEXHU1M0Q4XHU5MUNGOlxuICogIC0gXHU1M0VBXHU3RUQxXHU1QjlBL1x1NjNBMlx1NkQ0QiAxMjcuMC4wLjE7aG9zdCBcdTRGN0ZcdTc1MjhcdTY0Q0RcdTRGNUNcdTdDRkJcdTdFREZcdTUyMDZcdTkxNERcdTdBRUZcdTUzRTMocG9ydCAwKSxcdTVCOUVcdTk2NDVcdTdBRUZcdTUzRTNcbiAqICAgIFx1NzUzMSBob3N0IFx1NzY4NCBzdGRvdXQgXHU1RjE1XHU1QkZDXHU4ODRDXHU1NkRFXHU0RjIwKEhvc3RSZWFkeUxpbmUpXHUzMDAyXG4gKiAgLSBcdTlBRDhcdTcxQjUgdG9rZW4gXHU1M0VBXHU5MDFBXHU4RkM3XHU1QjUwXHU4RkRCXHU3QTBCXHU3M0FGXHU1ODgzXHU1M0Q4XHU5MUNGXHU0RjIwXHU5MDEyLFx1N0VERFx1NEUwRFx1OEZEQiBVUkwvXHU2NUU1XHU1RkQ3L0lQQyBcdTY2MEVcdTY1ODdcdThEMUZcdThGN0RcdTMwMDJcbiAqICAtIFx1NTNFQVx1NTA1Q1x1NkI2Mlx1NjcyQyBzdXBlcnZpc29yIHNwYXduIFx1NzY4NFx1OEZEQlx1N0EwQlx1NTNFNVx1NjdDNDtcdTdFRERcdTRFMERcdTYzMDlcdThGREJcdTdBMEJcdTU0MEQga2lsbFx1MzAwMlxuICogIC0gaG9zdCBjcmFzaCBcdTU0MEVcdTY3MDlcdTk2NTBcdTkxQ0RcdTU0MkY7XHU5MUNEXHU1NDJGXHU0RTBEXHU5MUNEXHU2NTNFXHU0RUZCXHU0RjU1XHU3NTI4XHU2MjM3XHU1MkE4XHU0RjVDKFx1OTc1RVx1NUU0Mlx1N0I0OVx1NTJBOFx1NEY1Q1x1NzUzMVx1NzUyOFx1NjIzN1x1Nzg2RVx1OEJBNClcdTMwMDJcbiAqL1xuaW1wb3J0IHsgc3Bhd24sIHR5cGUgQ2hpbGRQcm9jZXNzIH0gZnJvbSAnbm9kZTpjaGlsZF9wcm9jZXNzJztcbmltcG9ydCB7IGNyZWF0ZUludGVyZmFjZSB9IGZyb20gJ25vZGU6cmVhZGxpbmUnO1xuaW1wb3J0IHsgcmFuZG9tQnl0ZXMgfSBmcm9tICdub2RlOmNyeXB0byc7XG5pbXBvcnQgeyBkZXNrdG9wRXJyb3IsIGlzRGVza3RvcEVycm9yLCB0eXBlIERlc2t0b3BFcnJvciB9IGZyb20gJ0BobWgtZGVza3RvcC9jb250cmFjdHMnO1xuXG5leHBvcnQgdHlwZSBIb3N0U3RhdGUgPVxuICB8ICdzdG9wcGVkJ1xuICB8ICdzdGFydGluZydcbiAgfCAncmVhZHknXG4gIHwgJ2Rpc2Nvbm5lY3RlZCdcbiAgfCAncmVzdGFydGluZydcbiAgfCAnc3RvcHBpbmcnXG4gIHwgJ2ZhaWxlZCc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgSG9zdFNwZWMge1xuICAvKiogXHU1M0VGXHU2MjY3XHU4ODRDXHU2NTg3XHU0RUY2KFx1OTAxQVx1NUUzOCBwcm9jZXNzLmV4ZWNQYXRoKVx1MzAwMiAqL1xuICBjb21tYW5kOiBzdHJpbmc7XG4gIGFyZ3M6IHN0cmluZ1tdO1xuICBjd2Q/OiBzdHJpbmc7XG4gIC8qKiBcdTk4OURcdTU5MTZcdTczQUZcdTU4ODNcdTUzRDhcdTkxQ0YoXHU0RjFBXHU0RTBFIHByb2Nlc3MuZW52IFx1NTQwOFx1NUU3NilcdTMwMDIgKi9cbiAgZW52PzogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBTdXBlcnZpc29yT3B0aW9ucyB7XG4gIC8qKiBcdTY3MUZcdTY3MUIgaG9zdCBcdTY4MjFcdTlBOENcdTc2ODQgYmVhcmVyIHRva2VuO1x1NEUwRFx1NEYyMFx1NTIxOVx1NkJDRlx1NkIyMSBzdGFydCBcdTc1MUZcdTYyMTBcdTlBRDhcdTcxQjVcdTk2OEZcdTY3M0FcdTUwM0NcdTMwMDIgKi9cbiAgdG9rZW4/OiBzdHJpbmc7XG4gIG1heFJlc3RhcnRzPzogbnVtYmVyO1xuICBzdGFydFRpbWVvdXRNcz86IG51bWJlcjtcbiAgZ3JhY2VmdWxTaHV0ZG93bk1zPzogbnVtYmVyO1xuICBvblN0YXRlQ2hhbmdlPyhzdGF0ZTogSG9zdFN0YXRlLCBpbmZvOiB7IHJlc3RhcnRDb3VudDogbnVtYmVyOyBsYXN0RXJyb3I/OiBzdHJpbmcgfSk6IHZvaWQ7XG4gIC8qKiBcdTZCQ0ZcdTZCMjEgaG9zdCBcdTVDMzFcdTdFRUEoXHU1NDJCIGNyYXNoIFx1ODFFQVx1NjEwOFx1NTQwRVx1NzY4NFx1OTFDRFx1NTQyRilcdTkwRkRcdTRGMUFcdTg5RTZcdTUzRDEsXHU2NDNBXHU1RTI2XHU3QUVGXHU3MEI5KFx1NTQyQiB0b2tlbixcbiAgICogIFx1NEVDNVx1NEY5Qlx1NTQwQ1x1NEZFMVx1NEVGQlx1NTdERlx1NzY4NFx1NUJCRlx1NEUzQlx1OEZEQlx1N0EwQlx1OTFDRFx1NUVGQVx1Njg2NVx1NUJBMlx1NjIzN1x1N0FFRjtcdTRFMERcdTg5ODFcdThERThcdThGREIgcmVuZGVyZXIpXHUzMDAyICovXG4gIG9uUmVhZHk/KGVuZHBvaW50OiBIb3N0RW5kcG9pbnQpOiB2b2lkO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEhvc3RFbmRwb2ludCB7XG4gIHBvcnQ6IG51bWJlcjtcbiAgdmVyc2lvbjogc3RyaW5nO1xuICB0b2tlbjogc3RyaW5nO1xufVxuXG4vKiogSG9zdFJlYWR5TGluZSBcdTc2ODRcdTdDN0JcdTU3OEJcdTVCODhcdTUzNkJcdTRFQ0UgY29udHJhY3RzIFx1NUYxNVx1NTE2NSxcdTkwN0ZcdTUxNERcdTUzQ0NcdTVCOUVcdTczQjBcdTMwMDIgKi9cbmltcG9ydCB7IGlzSG9zdFJlYWR5TGluZSB9IGZyb20gJ0BobWgtZGVza3RvcC9jb250cmFjdHMnO1xuXG4vLyA0NXM6aG1oYXJuZXNzIFx1NzcxRlx1NUI5RVx1NTE2NVx1NTNFM1x1N0VDRiB0c3ggXHU1MUI3XHU3RjE2XHU4QkQxXHU2NTc0XHU1OTU3IENMSSxcdTY3M0FcdTU2NjhcdTlBRDhcdThEMUZcdThGN0RcdTY1RjZcdTUzRUZcdThEODUgMjBzXG4vLyAoMjAyNi0xMC0xMSBcdThGREVcdTdFRURcdTlBOENcdTY1MzZcdTRFMkRcdTk1RjRcdTZCNDdcdTYwMjcgSE9TVF9OT1RfUkVBRFkgXHU3Njg0XHU2ODM5XHU1NkUwO1x1N0E3QVx1OTVGMlx1NUI5RVx1NkQ0QiA2cylcdTMwMDJcbmNvbnN0IERFRkFVTFRfU1RBUlRfVElNRU9VVF9NUyA9IDQ1XzAwMDtcbmNvbnN0IERFRkFVTFRfTUFYX1JFU1RBUlRTID0gMztcbmNvbnN0IERFRkFVTFRfR1JBQ0VGVUxfTVMgPSA1XzAwMDtcblxuZXhwb3J0IGNsYXNzIERlc2t0b3BSdW50aW1lU3VwZXJ2aXNvciB7XG4gIHByaXZhdGUgY2hpbGQ6IENoaWxkUHJvY2VzcyB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIF9zdGF0ZTogSG9zdFN0YXRlID0gJ3N0b3BwZWQnO1xuICBwcml2YXRlIHJlc3RhcnRDb3VudCA9IDA7XG4gIHByaXZhdGUgbGFzdEVycm9yID0gJyc7XG4gIHByaXZhdGUgc3RvcHBpbmcgPSBmYWxzZTtcbiAgcHJpdmF0ZSByZWFkb25seSB0b2tlbjogc3RyaW5nO1xuICBwcml2YXRlIHJlYWRvbmx5IG9wdHM6IFJlcXVpcmVkPFBpY2s8U3VwZXJ2aXNvck9wdGlvbnMsICdtYXhSZXN0YXJ0cycgfCAnc3RhcnRUaW1lb3V0TXMnIHwgJ2dyYWNlZnVsU2h1dGRvd25Ncyc+PiAmIFN1cGVydmlzb3JPcHRpb25zO1xuICBwcml2YXRlIGV4aXRXYWl0ZXJzOiBBcnJheTwoKSA9PiB2b2lkPiA9IFtdO1xuXG4gIGNvbnN0cnVjdG9yKFxuICAgIHByaXZhdGUgcmVhZG9ubHkgc3BlYzogSG9zdFNwZWMsXG4gICAgb3B0czogU3VwZXJ2aXNvck9wdGlvbnMgPSB7fSxcbiAgKSB7XG4gICAgdGhpcy50b2tlbiA9IG9wdHMudG9rZW4gPz8gcmFuZG9tQnl0ZXMoMzIpLnRvU3RyaW5nKCdiYXNlNjR1cmwnKTtcbiAgICB0aGlzLm9wdHMgPSB7XG4gICAgICBtYXhSZXN0YXJ0czogb3B0cy5tYXhSZXN0YXJ0cyA/PyBERUZBVUxUX01BWF9SRVNUQVJUUyxcbiAgICAgIHN0YXJ0VGltZW91dE1zOiBvcHRzLnN0YXJ0VGltZW91dE1zID8/IERFRkFVTFRfU1RBUlRfVElNRU9VVF9NUyxcbiAgICAgIGdyYWNlZnVsU2h1dGRvd25Nczogb3B0cy5ncmFjZWZ1bFNodXRkb3duTXMgPz8gREVGQVVMVF9HUkFDRUZVTF9NUyxcbiAgICAgIC4uLm9wdHMsXG4gICAgfTtcbiAgfVxuXG4gIGdldCBzdGF0ZSgpOiBIb3N0U3RhdGUge1xuICAgIHJldHVybiB0aGlzLl9zdGF0ZTtcbiAgfVxuXG4gIGdldCByZXN0YXJ0c1VzZWQoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gdGhpcy5yZXN0YXJ0Q291bnQ7XG4gIH1cblxuICBwcml2YXRlIHNldFN0YXRlKHM6IEhvc3RTdGF0ZSwgZXJyPzogc3RyaW5nKTogdm9pZCB7XG4gICAgdGhpcy5fc3RhdGUgPSBzO1xuICAgIGlmIChlcnIgIT09IHVuZGVmaW5lZCkgdGhpcy5sYXN0RXJyb3IgPSBlcnI7XG4gICAgY29uc3QgaW5mbzogeyByZXN0YXJ0Q291bnQ6IG51bWJlcjsgbGFzdEVycm9yPzogc3RyaW5nIH0gPSB7IHJlc3RhcnRDb3VudDogdGhpcy5yZXN0YXJ0Q291bnQgfTtcbiAgICBpZiAodGhpcy5sYXN0RXJyb3IgIT09ICcnKSBpbmZvLmxhc3RFcnJvciA9IHRoaXMubGFzdEVycm9yO1xuICAgIHRoaXMub3B0cy5vblN0YXRlQ2hhbmdlPy4ocywgaW5mbyk7XG4gIH1cblxuICAvKiogXHU1NDJGXHU1MkE4IGhvc3QgXHU1RTc2XHU3QjQ5XHU1Rjg1IHJlYWR5KFx1NUYxNVx1NUJGQ1x1ODg0QyArIFx1NUUyNiB0b2tlbiBcdTc2ODRcdTUwNjVcdTVFQjdcdTYzQTJcdTZENEIpXHUzMDAyICovXG4gIGFzeW5jIHN0YXJ0KCk6IFByb21pc2U8SG9zdEVuZHBvaW50PiB7XG4gICAgaWYgKHRoaXMuX3N0YXRlID09PSAncmVhZHknIHx8IHRoaXMuX3N0YXRlID09PSAnc3RhcnRpbmcnKSB7XG4gICAgICB0aHJvdyBkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYHN1cGVydmlzb3IgYWxyZWFkeSAke3RoaXMuX3N0YXRlfWApO1xuICAgIH1cbiAgICB0aGlzLnJlc3RhcnRDb3VudCA9IDA7XG4gICAgdGhpcy5zdG9wcGluZyA9IGZhbHNlO1xuICAgIHJldHVybiB0aGlzLmxhdW5jaCgpO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBsYXVuY2goKTogUHJvbWlzZTxIb3N0RW5kcG9pbnQ+IHtcbiAgICB0aGlzLnNldFN0YXRlKCdzdGFydGluZycpO1xuICAgIGNvbnN0IGNoaWxkID0gc3Bhd24odGhpcy5zcGVjLmNvbW1hbmQsIHRoaXMuc3BlYy5hcmdzLCB7XG4gICAgICBjd2Q6IHRoaXMuc3BlYy5jd2QsXG4gICAgICBlbnY6IHtcbiAgICAgICAgLi4ucHJvY2Vzcy5lbnYsXG4gICAgICAgIC4uLnRoaXMuc3BlYy5lbnYsXG4gICAgICAgIEhNSF9ERVNLVE9QX1RPS0VOOiB0aGlzLnRva2VuLFxuICAgICAgfSxcbiAgICAgIHN0ZGlvOiBbJ2lnbm9yZScsICdwaXBlJywgJ3BpcGUnXSxcbiAgICAgIHdpbmRvd3NIaWRlOiB0cnVlLFxuICAgIH0pO1xuICAgIHRoaXMuY2hpbGQgPSBjaGlsZDtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCBlbmRwb2ludCA9IGF3YWl0IHRoaXMuYXdhaXRSZWFkeShjaGlsZCk7XG4gICAgICB0aGlzLmN1cnJlbnRFbmRwb2ludCA9IHsgcG9ydDogZW5kcG9pbnQucG9ydCwgdmVyc2lvbjogZW5kcG9pbnQudmVyc2lvbiB9O1xuICAgICAgdGhpcy5zZXRTdGF0ZSgncmVhZHknKTtcbiAgICAgIHRoaXMub3B0cy5vblJlYWR5Py4oZW5kcG9pbnQpO1xuICAgICAgLy8gcmVhZHkgXHU0RTRCXHU1NDBFXHU4RkRCXHU3QTBCXHU2QjdCXHU0RUExID0gXHU2MTBGXHU1OTE2XHU5MDAwXHU1MUZBIFx1MjE5MiBcdTY3MDlcdTk2NTBcdTkxQ0RcdTU0MkZcbiAgICAgIGNoaWxkLm9uY2UoJ2V4aXQnLCAoKSA9PiB7XG4gICAgICAgIHRoaXMuZXhpdFdhaXRlcnMuZm9yRWFjaCgodykgPT4gdygpKTtcbiAgICAgICAgdGhpcy5leGl0V2FpdGVycyA9IFtdO1xuICAgICAgICB0aGlzLm9uVW5leHBlY3RlZEV4aXQoKTtcbiAgICAgIH0pO1xuICAgICAgcmV0dXJuIGVuZHBvaW50O1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgaWYgKCFjaGlsZC5raWxsZWQpIGNoaWxkLmtpbGwoKTtcbiAgICAgIGlmICh0aGlzLmNoaWxkID09PSBjaGlsZCkgdGhpcy5jaGlsZCA9IG51bGw7XG4gICAgICB0aHJvdyBlcnI7XG4gICAgfVxuICB9XG5cbiAgLyoqIFx1NEVDRSBzdGRvdXQgXHU2MjdFIEhvc3RSZWFkeUxpbmUsXHU3MTM2XHU1NDBFXHU1MDY1XHU1RUI3XHU2M0EyXHU2RDRCXHUzMDAyICovXG4gIHByaXZhdGUgYXdhaXRSZWFkeShjaGlsZDogQ2hpbGRQcm9jZXNzKTogUHJvbWlzZTxIb3N0RW5kcG9pbnQ+IHtcbiAgICByZXR1cm4gbmV3IFByb21pc2U8SG9zdEVuZHBvaW50PigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICByZWplY3QoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBob3N0IGRpZCBub3Qgc2lnbmFsIHJlYWR5IHdpdGhpbiAke3RoaXMub3B0cy5zdGFydFRpbWVvdXRNc31tc2AsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgICAgfSwgdGhpcy5vcHRzLnN0YXJ0VGltZW91dE1zKTtcblxuICAgICAgY29uc3QgZG9uZSA9IChmbjogKCkgPT4gdm9pZCk6IHZvaWQgPT4ge1xuICAgICAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgICAgICBmbigpO1xuICAgICAgfTtcblxuICAgICAgaWYgKCFjaGlsZC5zdGRvdXQpIHtcbiAgICAgICAgZG9uZSgoKSA9PiByZWplY3QoZGVza3RvcEVycm9yKCdSVU5USU1FX0NSQVNIRUQnLCAnaG9zdCBzcGF3bmVkIHdpdGhvdXQgc3Rkb3V0IHBpcGUnKSkpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHJsID0gY3JlYXRlSW50ZXJmYWNlKHsgaW5wdXQ6IGNoaWxkLnN0ZG91dCB9KTtcbiAgICAgIGNvbnN0IG9uTGluZSA9IChsaW5lOiBzdHJpbmcpOiB2b2lkID0+IHtcbiAgICAgICAgbGV0IHBhcnNlZDogdW5rbm93bjtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBwYXJzZWQgPSBKU09OLnBhcnNlKGxpbmUpO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICByZXR1cm47IC8vIGhvc3QgXHU3Njg0XHU2NjZFXHU5MDFBXHU2NUU1XHU1RkQ3XHU4ODRDLFx1NUZGRFx1NzU2NVxuICAgICAgICB9XG4gICAgICAgIGlmIChpc0hvc3RSZWFkeUxpbmUocGFyc2VkKSkge1xuICAgICAgICAgIHJsLmNsb3NlKCk7XG4gICAgICAgICAgdm9pZCB0aGlzLnByb2JlQW5kUmVtZW1iZXIocGFyc2VkLnBvcnQsIHBhcnNlZC52ZXJzaW9uKVxuICAgICAgICAgICAgLnRoZW4oKGVuZHBvaW50KSA9PiBkb25lKCgpID0+IHJlc29sdmUoZW5kcG9pbnQpKSlcbiAgICAgICAgICAgIC5jYXRjaCgoZXJyOiB1bmtub3duKSA9PiBkb25lKCgpID0+IHJlamVjdChlcnIpKSk7XG4gICAgICAgIH1cbiAgICAgIH07XG4gICAgICBybC5vbignbGluZScsIG9uTGluZSk7XG5cbiAgICAgIGNoaWxkLm9uY2UoJ2V4aXQnLCAoY29kZSkgPT4ge1xuICAgICAgICBkb25lKCgpID0+IHJlamVjdChkZXNrdG9wRXJyb3IoJ1JVTlRJTUVfQ1JBU0hFRCcsIGBob3N0IGV4aXRlZCBkdXJpbmcgc3RhcnR1cCAoY29kZSAke2NvZGUgPz8gJ251bGwnfSlgLCB7IHJldHJ5YWJsZTogZmFsc2UsIHJlY292ZXJ5QWN0aW9uOiAnT1BFTl9MT0dTJyB9KSkpO1xuICAgICAgfSk7XG4gICAgfSk7XG4gIH1cblxuICAvKiogXHU1RTI2IHRva2VuIFx1NzY4NFx1NTA2NVx1NUVCN1x1NjNBMlx1NkQ0QjpHRVQgL2FwaS9zdGF0ZVx1MzAwMjQwMSBcdTIxOTIgQVVUSF9GQUlMRUQoXHU0RTBEXHU5MUNEXHU4QkQ1KVx1MzAwMiAqL1xuICBwcml2YXRlIGFzeW5jIHByb2JlKHBvcnQ6IG51bWJlciwgdmVyc2lvbjogc3RyaW5nKTogUHJvbWlzZTxIb3N0RW5kcG9pbnQ+IHtcbiAgICBsZXQgcmVzOiBSZXNwb25zZTtcbiAgICB0cnkge1xuICAgICAgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9hcGkvc3RhdGVgLCB7XG4gICAgICAgIGhlYWRlcnM6IHsgJ3gtaG1oLWtleSc6IHRoaXMudG9rZW4gfSxcbiAgICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDNfMDAwKSxcbiAgICAgIH0pO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgdGhyb3cgZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBoZWFsdGggcHJvYmUgZmFpbGVkOiAke1N0cmluZyhlcnIpLnNsaWNlKDAsIDE2MCl9YCwgeyByZXRyeWFibGU6IHRydWUgfSk7XG4gICAgfVxuICAgIGlmIChyZXMuc3RhdHVzID09PSA0MDEgfHwgcmVzLnN0YXR1cyA9PT0gNDAzKSB7XG4gICAgICB0aHJvdyBkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgYGhvc3QgcmVqZWN0ZWQgdGhlIHNlc3Npb24gdG9rZW4gKEhUVFAgJHtyZXMuc3RhdHVzfSlgLCB7IHJldHJ5YWJsZTogZmFsc2UsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KTtcbiAgICB9XG4gICAgaWYgKCFyZXMub2spIHtcbiAgICAgIHRocm93IGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgaGVhbHRoIHByb2JlIEhUVFAgJHtyZXMuc3RhdHVzfWAsIHsgcmV0cnlhYmxlOiB0cnVlIH0pO1xuICAgIH1cbiAgICByZXR1cm4geyBwb3J0LCB2ZXJzaW9uLCB0b2tlbjogdGhpcy50b2tlbiB9O1xuICB9XG5cbiAgcHJpdmF0ZSBvblVuZXhwZWN0ZWRFeGl0KCk6IHZvaWQge1xuICAgIGlmICh0aGlzLnN0b3BwaW5nIHx8IHRoaXMuX3N0YXRlID09PSAnc3RvcHBlZCcgfHwgdGhpcy5fc3RhdGUgPT09ICdzdG9wcGluZycpIHJldHVybjtcbiAgICB0aGlzLmNoaWxkID0gbnVsbDtcbiAgICBpZiAodGhpcy5yZXN0YXJ0Q291bnQgPCB0aGlzLm9wdHMubWF4UmVzdGFydHMpIHtcbiAgICAgIHRoaXMucmVzdGFydENvdW50ICs9IDE7XG4gICAgICB0aGlzLnNldFN0YXRlKCdyZXN0YXJ0aW5nJyk7XG4gICAgICB2b2lkIHRoaXMubGF1bmNoKCkuY2F0Y2goKCkgPT4ge1xuICAgICAgICAvLyBcdTkxQ0RcdTU0MkZcdTVDMURcdThCRDVcdTU5MzFcdThEMjUoXHU1NDJGXHU1MkE4XHU1MzczXHU1RDI5L1x1OEQ4NVx1NjVGNi9cdTYyRDJcdThCQTQpOlx1N0VFN1x1N0VFRFx1NkQ4OFx1ODAxN1x1OTFDRFx1NTQyRlx1NkIyMVx1NjU3MFx1NzZGNFx1NTIzMFx1NjUzRVx1NUYwM1xuICAgICAgICB0aGlzLnJldHJ5T3JGYWlsKCk7XG4gICAgICB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5zZXRTdGF0ZSgnZmFpbGVkJywgYGhvc3QgZXhpdGVkIHVuZXhwZWN0ZWRseSAke3RoaXMucmVzdGFydENvdW50ICsgMX0gdGltZXM7IGdpdmluZyB1cGApO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgcmV0cnlPckZhaWwoKTogdm9pZCB7XG4gICAgaWYgKHRoaXMuc3RvcHBpbmcgfHwgdGhpcy5fc3RhdGUgPT09ICdzdG9wcGVkJyB8fCB0aGlzLl9zdGF0ZSA9PT0gJ3N0b3BwaW5nJykgcmV0dXJuO1xuICAgIGlmICh0aGlzLnJlc3RhcnRDb3VudCA8IHRoaXMub3B0cy5tYXhSZXN0YXJ0cykge1xuICAgICAgdGhpcy5yZXN0YXJ0Q291bnQgKz0gMTtcbiAgICAgIHRoaXMuc2V0U3RhdGUoJ3Jlc3RhcnRpbmcnKTtcbiAgICAgIHZvaWQgdGhpcy5sYXVuY2goKS5jYXRjaCgoKSA9PiB0aGlzLnJldHJ5T3JGYWlsKCkpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLnNldFN0YXRlKCdmYWlsZWQnLCBgaG9zdCBmYWlsZWQgdG8gc3RheSB1cCBhZnRlciAke3RoaXMucmVzdGFydENvdW50fSByZXN0YXJ0IGF0dGVtcHRzYCk7XG4gICAgfVxuICB9XG5cbiAgLyoqIFx1NEYxOFx1OTZDNVx1NTA1Q1x1NkI2MjpcdTUxNDggSFRUUCBzaHV0ZG93bixcdThEODVcdTY1RjZcdTYyNERcdTVCRjlcdTY3MkNcdThGREJcdTdBMEJcdTUzRTVcdTY3QzQga2lsbFx1MzAwMiAqL1xuICBhc3luYyBzdG9wKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIHRoaXMuc3RvcHBpbmcgPSB0cnVlO1xuICAgIGlmICh0aGlzLl9zdGF0ZSA9PT0gJ3N0b3BwZWQnKSByZXR1cm47XG4gICAgdGhpcy5zZXRTdGF0ZSgnc3RvcHBpbmcnKTtcbiAgICBjb25zdCBjaGlsZCA9IHRoaXMuY2hpbGQ7XG4gICAgdGhpcy5jaGlsZCA9IG51bGw7XG4gICAgdGhpcy5jdXJyZW50RW5kcG9pbnQgPSBudWxsO1xuICAgIGlmICghY2hpbGQpIHtcbiAgICAgIHRoaXMuc2V0U3RhdGUoJ3N0b3BwZWQnKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgZXhpdGVkID0gbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUpID0+IHtcbiAgICAgIGlmIChjaGlsZC5leGl0Q29kZSAhPT0gbnVsbCB8fCBjaGlsZC5zaWduYWxDb2RlICE9PSBudWxsKSByZXNvbHZlKCk7XG4gICAgICBlbHNlIHtcbiAgICAgICAgY29uc3QgdyA9ICgpOiB2b2lkID0+IHJlc29sdmUoKTtcbiAgICAgICAgdGhpcy5leGl0V2FpdGVycy5wdXNoKHcpO1xuICAgICAgICBjaGlsZC5vbmNlKCdleGl0Jywgdyk7XG4gICAgICB9XG4gICAgfSk7XG4gICAgLy8gXHU1REYyXHU3N0U1XHU3QUVGXHU1M0UzXHU2MjREXHU1QzFEXHU4QkQ1IEhUVFAgXHU0RjE4XHU5NkM1XHU1MTczXHU5NUVEO1x1NjcyQVx1NzdFNVx1N0FFRlx1NTNFM1x1NzZGNFx1NjNBNVx1OEQ3MCBraWxsIFx1NTE1Q1x1NUU5NVxuICAgIGlmICh0aGlzLmxhc3RFbmRwb2ludCAhPT0gbnVsbCkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHt0aGlzLmxhc3RFbmRwb2ludH0vYXBpL2Rlc2t0b3Avc2h1dGRvd25gLCB7XG4gICAgICAgICAgbWV0aG9kOiAnUE9TVCcsXG4gICAgICAgICAgaGVhZGVyczogeyAneC1obWgta2V5JzogdGhpcy50b2tlbiB9LFxuICAgICAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCgxXzAwMCksXG4gICAgICAgIH0pO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8vIGhvc3QgXHU1REYyXHU2QjdCXHU2MjE2XHU0RTBEXHU1RTk0XHU3QjU0Olx1OEQ3MCBraWxsIFx1NTE1Q1x1NUU5NVxuICAgICAgfVxuICAgIH1cbiAgICBjb25zdCBncmFjZWZ1bCA9IGF3YWl0IFByb21pc2UucmFjZShbXG4gICAgICBleGl0ZWQudGhlbigoKSA9PiB0cnVlKSxcbiAgICAgIG5ldyBQcm9taXNlPGJvb2xlYW4+KChyZXNvbHZlKSA9PiBzZXRUaW1lb3V0KCgpID0+IHJlc29sdmUoZmFsc2UpLCB0aGlzLm9wdHMuZ3JhY2VmdWxTaHV0ZG93bk1zKSksXG4gICAgXSk7XG4gICAgaWYgKCFncmFjZWZ1bCAmJiBjaGlsZC5leGl0Q29kZSA9PT0gbnVsbCAmJiBjaGlsZC5zaWduYWxDb2RlID09PSBudWxsKSB7XG4gICAgICBjaGlsZC5raWxsKCk7IC8vIFx1NTNFQVx1Njc0MFx1ODFFQVx1NURGMVx1NjMwMVx1NjcwOVx1NzY4NFx1NTNFNVx1NjdDNCxcdTdFRERcdTRFMERcdTYzMDlcdThGREJcdTdBMEJcdTU0MERcbiAgICB9XG4gICAgYXdhaXQgZXhpdGVkLmNhdGNoKCgpID0+IHVuZGVmaW5lZCk7XG4gICAgdGhpcy5zZXRTdGF0ZSgnc3RvcHBlZCcpO1xuICB9XG5cbiAgcHJpdmF0ZSBsYXN0RW5kcG9pbnQ6IG51bWJlciB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIGN1cnJlbnRFbmRwb2ludDogeyBwb3J0OiBudW1iZXI7IHZlcnNpb246IHN0cmluZyB9IHwgbnVsbCA9IG51bGw7XG5cbiAgLyoqIFx1NUY1M1x1NTI0RCBob3N0IFx1N0FFRlx1NzBCOShyZWFkeSBcdTU0MEVcdTY3MDlcdTUwM0M7XHU0RTBEXHU1NDJCIHRva2VuKVx1MzAwMiAqL1xuICBnZXQgZW5kcG9pbnQoKTogeyBwb3J0OiBudW1iZXI7IHZlcnNpb246IHN0cmluZyB9IHwgbnVsbCB7XG4gICAgcmV0dXJuIHRoaXMuY3VycmVudEVuZHBvaW50O1xuICB9XG5cbiAgLyoqIFx1NjNBMlx1NkQ0Qlx1NjIxMFx1NTI5Rlx1NTQwRVx1OEJCMFx1NEY0Rlx1N0FFRlx1NTNFMyxcdTRGOUIgc3RvcCgpIFx1NzY4NFx1NEYxOFx1OTZDNVx1NTE3M1x1OTVFRFx1NEY3Rlx1NzUyOFx1MzAwMiAqL1xuICBwcml2YXRlIGFzeW5jIHByb2JlQW5kUmVtZW1iZXIocG9ydDogbnVtYmVyLCB2ZXJzaW9uOiBzdHJpbmcpOiBQcm9taXNlPEhvc3RFbmRwb2ludD4ge1xuICAgIGNvbnN0IGVwID0gYXdhaXQgdGhpcy5wcm9iZShwb3J0LCB2ZXJzaW9uKTtcbiAgICB0aGlzLmxhc3RFbmRwb2ludCA9IGVwLnBvcnQ7XG4gICAgcmV0dXJuIGVwO1xuICB9XG59XG5cbi8qKiBcdTYyOEFcdTY3MkFcdTc3RTVcdTk1MTlcdThCRUZcdTg5QzRcdTdFQTZcdTRFM0EgRGVza3RvcEVycm9yKFx1NURGMlx1NjYyRlx1NTIxOVx1NTM5Rlx1NjgzN1x1OEZENFx1NTZERSlcdTMwMDIgKi9cbmV4cG9ydCBmdW5jdGlvbiB0b0Rlc2t0b3BFcnJvcihlcnI6IHVua25vd24pOiBEZXNrdG9wRXJyb3Ige1xuICBpZiAoaXNEZXNrdG9wRXJyb3IoZXJyKSkgcmV0dXJuIGVycjtcbiAgY29uc3QgbWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgcmV0dXJuIGRlc2t0b3BFcnJvcignUlVOVElNRV9DUkFTSEVEJywgbWVzc2FnZS5zbGljZSgwLCAzMDApLCB7IHJldHJ5YWJsZTogZmFsc2UgfSk7XG59XG4iLCAiLyoqXG4gKiBAaG1oLWRlc2t0b3AvY29udHJhY3RzIFx1MjAxNCBcdTRFOEJcdTRFRjZcdTRGRTFcdTVDMDEoXHU1RjAwXHU1M0QxXHU4QkExXHU1MjEyXHU2NTg3XHU2ODYzIDA0IFx1MDBBN1x1NEUwOSlcbiAqXG4gKiBcdTRFMDBcdTY3NjEgVUkgXHU0RThCXHU0RUY2XHU3Njg0XHU1NTJGXHU0RTAwXHU1RjYyXHU3MkI2XHUzMDAyXHU1MjREXHU3QUVGIHJlZHVjZXIgXHU1RkM1XHU5ODdCXHU2MzA5IHNlc3Npb25JZC9ydW5JZC9zZXEgXHU1OTA0XHU3NDA2O1xuICogXHU5MUNEXHU1OTBEIGV2ZW50SWQgXHU1RTQyXHU3QjQ5XHU0RTIyXHU1RjAzO3NlcSBcdTdGM0FcdTUzRTNcdTg5RTZcdTUzRDFcdTg4NjVcdTYyQzk7XHU5NzVFXHU1RTQyXHU3QjQ5XHU1MkE4XHU0RjVDXHU0RTBEXHU3NTMxIFNTRSBcdTgxRUFcdTUyQThcdTkxQ0RcdTUzRDFcdTMwMDJcbiAqL1xuXG5pbXBvcnQgdHlwZSB7IEFydGlmYWN0UmVmIH0gZnJvbSAnLi9kdG8udHMnO1xuaW1wb3J0IHR5cGUgeyBEZXNrdG9wRXJyb3IgfSBmcm9tICcuL2Vycm9yLnRzJztcblxuLyoqIFx1NEU4Qlx1NEVGNlx1NzlDRFx1N0M3QihcdTUyMjRcdTUyMkJcdTk1MkUpXHUzMDAyXHU2NUIwXHU1ODlFIGtpbmQgPSBzY2hlbWFWZXJzaW9uIFx1NTM0N1x1N0VBNyxcdTRFMERcdTUxNDFcdThCQjhcdTk3NTlcdTlFRDhcdTYyNjlcdTY3OUFcdTRFM0VcdTMwMDIgKi9cbmV4cG9ydCBjb25zdCBFVkVOVF9LSU5EUyA9IFtcbiAgJ3J1bi5zdGFydGVkJyxcbiAgJ3BsYW4udXBkYXRlZCcsXG4gICd0b29sLnN0YXJ0ZWQnLFxuICAndG9vbC5jb21wbGV0ZWQnLFxuICAnYXBwcm92YWwucmVxdWlyZWQnLFxuICAndmVyaWZpY2F0aW9uLnVwZGF0ZWQnLFxuICAnYXJ0aWZhY3QuY3JlYXRlZCcsXG4gICdydW4uY29tcGxldGVkJyxcbiAgJ3J1bi5mYWlsZWQnLFxuXSBhcyBjb25zdDtcblxuZXhwb3J0IHR5cGUgRXZlbnRLaW5kID0gKHR5cGVvZiBFVkVOVF9LSU5EUylbbnVtYmVyXTtcblxuZXhwb3J0IGNvbnN0IEVWRU5UX1NDSEVNQV9WRVJTSU9OID0gMTtcbmV4cG9ydCB0eXBlIEV2ZW50U2NoZW1hVmVyc2lvbiA9IDE7XG5cbi8qKiBTU0UgXHU2RDQxXHU0RTBBXHU3Njg0XHU2QkNGXHU0RTAwXHU2NzYxXHU0RThCXHU0RUY2XHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIEV2ZW50RW52ZWxvcGU8VCA9IHVua25vd24+IHtcbiAgc2NoZW1hVmVyc2lvbjogRXZlbnRTY2hlbWFWZXJzaW9uO1xuICAvKiogXHU1MTY4XHU1QzQwXHU1NTJGXHU0RTAwO1x1OTFDRFx1OEZERS9cdTg4NjVcdTYyQzlcdTU0MEVcdTkxQ0RcdTU5MERcdTUxRkFcdTczQjBcdTY1RjZcdTYzQTVcdTY1MzZcdTY1QjlcdTVFNDJcdTdCNDlcdTRFMjJcdTVGMDNcdTMwMDIgKi9cbiAgZXZlbnRJZDogc3RyaW5nO1xuICBzZXNzaW9uSWQ6IHN0cmluZztcbiAgcnVuSWQ6IHN0cmluZztcbiAgLyoqIFx1NEYxQVx1OEJERFx1NTE4NVx1NTM1NVx1OEMwM1x1OTAxMlx1NTg5RTtcdTdGM0FcdTUzRTNcdTYxMEZcdTU0NzNcdTc3NDBcdTRFMjJcdTRFOEJcdTRFRjYsXHU5NzAwXHU4OTgxXHU4ODY1XHU2MkM5XHUzMDAyICovXG4gIHNlcTogbnVtYmVyO1xuICAvKiogUkZDMzMzOVx1MzAwMiAqL1xuICBvY2N1cnJlZEF0OiBzdHJpbmc7XG4gIGtpbmQ6IEV2ZW50S2luZDtcbiAgcGF5bG9hZDogVDtcbn1cblxuLyoqIHJ1bi5zdGFydGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIFJ1blN0YXJ0ZWRQYXlsb2FkIHtcbiAgdGFzazogc3RyaW5nO1xuICBtb2RlOiAnYXNrJyB8ICdhdXRvJyB8ICd5b2xvJztcbn1cblxuLyoqIHBsYW4udXBkYXRlZCBcdTc2ODQgcGF5bG9hZChcdThCQTFcdTUyMTJcdTZCNjVcdTlBQTRcdTUyMTdcdTg4NjgsXHU2NzY1XHU4MUVBIHJ1bnRpbWUgXHU3Njg0XHU3RUQzXHU2Nzg0XHU1MzE2XHU4QkExXHU1MjEyLFx1NEUwRFx1NjYyRiBjaGFpbi1vZi10aG91Z2h0KVx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBQbGFuVXBkYXRlZFBheWxvYWQge1xuICBzdGVwczogQXJyYXk8eyB0aXRsZTogc3RyaW5nOyBzdGF0dXM6ICdwZW5kaW5nJyB8ICdhY3RpdmUnIHwgJ2RvbmUnIHwgJ2ZhaWxlZCcgfT47XG59XG5cbi8qKiB0b29sLnN0YXJ0ZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgVG9vbFN0YXJ0ZWRQYXlsb2FkIHtcbiAgbmFtZTogc3RyaW5nO1xuICAvKiogXHU1M0MyXHU2NTcwXHU0RUU1XHU2NTg3XHU2NzJDXHU1NDQ4XHU3M0IwLFx1NkUzMlx1NjdEM1x1N0FFRlx1NkMzOFx1NEUwRCBldmFsO1x1NTkyN1x1NUJGOVx1OEM2MVx1NzUzMSBydW50aW1lIFx1NjIyQVx1NjVBRFx1MzAwMiAqL1xuICBhcmdzUHJldmlldzogc3RyaW5nO1xufVxuXG4vKiogdG9vbC5jb21wbGV0ZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgVG9vbENvbXBsZXRlZFBheWxvYWQge1xuICBuYW1lOiBzdHJpbmc7XG4gIGlzRXJyb3I6IGJvb2xlYW47XG4gIG91dHB1dFByZXZpZXc6IHN0cmluZztcbn1cblxuLyoqIGFwcHJvdmFsLnJlcXVpcmVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyXHU1QkExXHU2Mjc5XHU2NzQzXHU1QTAxXHU1NzI4IHJ1bnRpbWUgXHU1NDBFXHU3QUVGO1VJIFx1NTNFQVx1NjYyRlx1OEY2Q1x1OEZGMFx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHByb3ZhbFJlcXVpcmVkUGF5bG9hZCB7XG4gIGFwcHJvdmFsSWQ6IHN0cmluZztcbiAgdG9vbDogc3RyaW5nO1xuICBhcmdzUHJldmlldzogc3RyaW5nO1xuICAvKiogXHU1RjcxXHU1NENEXHU4MzAzXHU1NkY0L1x1OThDRVx1OTY2OVx1NzY4NFx1NEVCQVx1N0M3Qlx1NTNFRlx1OEJGQlx1OEJGNFx1NjYwRSxcdTc1MzEgcnVudGltZSBcdTc1MUZcdTYyMTBcdTMwMDIgKi9cbiAgcmlzazogc3RyaW5nO1xufVxuXG4vKiogdmVyaWZpY2F0aW9uLnVwZGF0ZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgVmVyaWZpY2F0aW9uVXBkYXRlZFBheWxvYWQge1xuICBzdW1tYXJ5OiBzdHJpbmc7XG4gIHBhc3NlZDogYm9vbGVhbiB8IG51bGw7IC8vIG51bGwgPSBcdTY3MkFcdTc3RTUvXHU4RkRCXHU4ODRDXHU0RTJEKE5FRURTLURBVEEgXHU2NUY2XHU0RTBEXHU1MDQ3XHU1ODZCKVxufVxuXG4vKiogYXJ0aWZhY3QuY3JlYXRlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcnRpZmFjdENyZWF0ZWRQYXlsb2FkIHtcbiAgYXJ0aWZhY3Q6IEFydGlmYWN0UmVmO1xufVxuXG4vKiogcnVuLmNvbXBsZXRlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBSdW5Db21wbGV0ZWRQYXlsb2FkIHtcbiAgdGV4dDogc3RyaW5nO1xuICB0dXJuczogbnVtYmVyO1xuICB0b29sVXNlczogbnVtYmVyO1xuICB1c2FnZT86IHsgcHJvbXB0VG9rZW5zOiBudW1iZXI7IGNvbXBsZXRpb25Ub2tlbnM6IG51bWJlciB9O1xufVxuXG4vKiogcnVuLmZhaWxlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBSdW5GYWlsZWRQYXlsb2FkIHtcbiAgZXJyb3I6IERlc2t0b3BFcnJvcjtcbn1cbiIsICIvKipcbiAqIEBobWgtZGVza3RvcC9jb250cmFjdHMgXHUyMDE0IFx1N0VEM1x1Njc4NFx1NTMxNlx1Njg0Q1x1OTc2Mlx1OTUxOVx1OEJFRihcdTVGMDBcdTUzRDFcdThCQTFcdTUyMTJcdTY1ODdcdTY4NjMgMDQgXHUwMEE3XHU0RTA5KVx1MzAwMlxuICpcbiAqIGhvc3Qtbm90LXJlYWR5IC8gYXV0aC1mYWlsZWQgLyBzdGFsZS12ZXJzaW9uIC8gcnVudGltZS1jcmFzaGVkIC9cbiAqIHBvcnQtYmluZC1mYWlsZWQgLyBzY2hlbWEtbWlzbWF0Y2ggXHU1RkM1XHU5ODdCXHU2NjJGXHU3RUQzXHU2Nzg0XHU1MzE2XHU5NTE5XHU4QkVGXHU3ODAxLFx1NUU3Nlx1NjNEMFx1NEY5Qlx1NEUwQlx1NEUwMFx1NkI2NVx1NTJBOFx1NEY1Q1x1MzAwMlxuICogbWVzc2FnZSBcdTY2MkZcdTdFQUZcdTY1ODdcdTY3MkMsXHU2RTMyXHU2N0QzXHU3QUVGXHU2QzM4XHU0RTBEXHU2MjhBXHU1QjgzXHU1RjUzIEhUTUxcdTMwMDJcbiAqL1xuZXhwb3J0IGNvbnN0IEVSUk9SX0NPREVTID0gW1xuICAnSE9TVF9OT1RfUkVBRFknLFxuICAnQVVUSF9GQUlMRUQnLFxuICAnUlVOVElNRV9DUkFTSEVEJyxcbiAgJ1BPUlRfQklORF9GQUlMRUQnLFxuICAnU1RBTEVfVkVSU0lPTicsXG4gICdTQ0hFTUFfTUlTTUFUQ0gnLFxuXSBhcyBjb25zdDtcblxuZXhwb3J0IHR5cGUgRXJyb3JDb2RlID0gKHR5cGVvZiBFUlJPUl9DT0RFUylbbnVtYmVyXTtcblxuZXhwb3J0IGNvbnN0IFJFQ09WRVJZX0FDVElPTlMgPSBbJ1JFQ09OTkVDVCcsICdSRVNVTUUnLCAnRVhQT1JUJywgJ09QRU5fTE9HUyddIGFzIGNvbnN0O1xuZXhwb3J0IHR5cGUgUmVjb3ZlcnlBY3Rpb24gPSAodHlwZW9mIFJFQ09WRVJZX0FDVElPTlMpW251bWJlcl07XG5cbmV4cG9ydCBpbnRlcmZhY2UgRGVza3RvcEVycm9yIHtcbiAgY29kZTogRXJyb3JDb2RlO1xuICAvKiogXHU3RUFGXHU2NTg3XHU2NzJDLFx1NkMzOFx1NEUwRFx1NEZFMVx1NEVGQlx1NEUzQSBIVE1MXHUzMDAyICovXG4gIG1lc3NhZ2U6IHN0cmluZztcbiAgcmV0cnlhYmxlOiBib29sZWFuO1xuICBzZXNzaW9uSWQ/OiBzdHJpbmc7XG4gIHJ1bklkPzogc3RyaW5nO1xuICByZWNvdmVyeUFjdGlvbj86IFJlY292ZXJ5QWN0aW9uO1xufVxuXG4vKiogXHU2Nzg0XHU5MDIwXHU0RTAwXHU0RTJBIERlc2t0b3BFcnJvcihleGFjdE9wdGlvbmFsUHJvcGVydHlUeXBlcyBcdTUzQ0JcdTU5N0QpXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gZGVza3RvcEVycm9yKFxuICBjb2RlOiBFcnJvckNvZGUsXG4gIG1lc3NhZ2U6IHN0cmluZyxcbiAgb3B0czogeyByZXRyeWFibGU/OiBib29sZWFuOyBzZXNzaW9uSWQ/OiBzdHJpbmc7IHJ1bklkPzogc3RyaW5nOyByZWNvdmVyeUFjdGlvbj86IFJlY292ZXJ5QWN0aW9uIH0gPSB7fSxcbik6IERlc2t0b3BFcnJvciB7XG4gIGNvbnN0IGU6IERlc2t0b3BFcnJvciA9IHsgY29kZSwgbWVzc2FnZSwgcmV0cnlhYmxlOiBvcHRzLnJldHJ5YWJsZSA9PT0gdHJ1ZSB9O1xuICBpZiAob3B0cy5zZXNzaW9uSWQgIT09IHVuZGVmaW5lZCkgZS5zZXNzaW9uSWQgPSBvcHRzLnNlc3Npb25JZDtcbiAgaWYgKG9wdHMucnVuSWQgIT09IHVuZGVmaW5lZCkgZS5ydW5JZCA9IG9wdHMucnVuSWQ7XG4gIGlmIChvcHRzLnJlY292ZXJ5QWN0aW9uICE9PSB1bmRlZmluZWQpIGUucmVjb3ZlcnlBY3Rpb24gPSBvcHRzLnJlY292ZXJ5QWN0aW9uO1xuICByZXR1cm4gZTtcbn1cbiIsICIvKipcbiAqIEBobWgtZGVza3RvcC9jb250cmFjdHMgXHUyMDE0IHJ1bnRpbWUgXHU2ODIxXHU5QThDKGd1YXJkcylcdTMwMDJcbiAqXG4gKiBcdTZCQ0ZcdTRFMkFcdThERThcdTRGRTFcdTRFRkJcdThGQjlcdTc1NENcdTc2ODRcdTY1NzBcdTYzNkUocnVudGltZVx1MjE5MnJlbmRlcmVyXHUzMDAxaG9zdFx1MjE5Mm1haW4pXHU4RkRCXHU1MTY1XHU1MjREXHU1MTQ4XHU4RkM3IGd1YXJkO1xuICogXHU2ODIxXHU5QThDXHU1OTMxXHU4RDI1XHU3Njg0XHU2NTcwXHU2MzZFXHU2MzA5IFNDSEVNQV9NSVNNQVRDSCBcdTdFRDNcdTY3ODRcdTUzMTZcdTk1MTlcdThCRUZcdTU5MDRcdTc0MDYsXHU0RTBEXHU5NzU5XHU5RUQ4XHU2M0E1XHU1M0Q3XHUzMDAyXG4gKiBcdTYyNEJcdTUxOTlcdTVCODhcdTUzNkJcdTgwMENcdTRFMERcdTY2MkZcdTVGMTVcdTdCMkNcdTRFMDlcdTY1Qjkgc2NoZW1hIFx1NUU5MzpcdTU5NTFcdTdFQTZcdTk3NjJcdTVDMEYsXHU5NkY2XHU0RjlEXHU4RDU2XHU2NTg3XHU1MzE2KGhtaGFybmVzcyBcdTU0MENcdTZFOTApXHUzMDAyXG4gKi9cbmltcG9ydCB7XG4gIEVWRU5UX0tJTkRTLFxuICBFVkVOVF9TQ0hFTUFfVkVSU0lPTixcbiAgdHlwZSBFdmVudEVudmVsb3BlLFxuICB0eXBlIEV2ZW50S2luZCxcbn0gZnJvbSAnLi9ldmVudC50cyc7XG5pbXBvcnQgeyBFUlJPUl9DT0RFUywgUkVDT1ZFUllfQUNUSU9OUywgdHlwZSBEZXNrdG9wRXJyb3IgfSBmcm9tICcuL2Vycm9yLnRzJztcbmltcG9ydCB7IFJVTl9TVEFUVVNFUywgdHlwZSBSdW5TdGF0dXMgfSBmcm9tICcuL2R0by50cyc7XG5cbmNvbnN0IGlzUmVjb3JkID0gKHY6IHVua25vd24pOiB2IGlzIFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0+XG4gIHR5cGVvZiB2ID09PSAnb2JqZWN0JyAmJiB2ICE9PSBudWxsICYmICFBcnJheS5pc0FycmF5KHYpO1xuXG5jb25zdCBpc05vbkVtcHR5U3RyaW5nID0gKHY6IHVua25vd24pOiB2IGlzIHN0cmluZyA9PiB0eXBlb2YgdiA9PT0gJ3N0cmluZycgJiYgdi5sZW5ndGggPiAwO1xuXG5jb25zdCBpc1JmYzMzMzkgPSAodjogc3RyaW5nKTogYm9vbGVhbiA9PiB7XG4gIGNvbnN0IHQgPSBEYXRlLnBhcnNlKHYpO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKHQpICYmIC9cXGR7NH0tXFxkezJ9LVxcZHsyfVQvLnRlc3Qodik7XG59O1xuXG5leHBvcnQgZnVuY3Rpb24gaXNFdmVudEVudmVsb3BlKHY6IHVua25vd24pOiB2IGlzIEV2ZW50RW52ZWxvcGUge1xuICBpZiAoIWlzUmVjb3JkKHYpKSByZXR1cm4gZmFsc2U7XG4gIGlmICh2LnNjaGVtYVZlcnNpb24gIT09IEVWRU5UX1NDSEVNQV9WRVJTSU9OKSByZXR1cm4gZmFsc2U7XG4gIGlmICghaXNOb25FbXB0eVN0cmluZyh2LmV2ZW50SWQpKSByZXR1cm4gZmFsc2U7XG4gIGlmICghaXNOb25FbXB0eVN0cmluZyh2LnNlc3Npb25JZCkpIHJldHVybiBmYWxzZTtcbiAgaWYgKCFpc05vbkVtcHR5U3RyaW5nKHYucnVuSWQpKSByZXR1cm4gZmFsc2U7XG4gIGlmICh0eXBlb2Ygdi5zZXEgIT09ICdudW1iZXInIHx8ICFOdW1iZXIuaXNJbnRlZ2VyKHYuc2VxKSB8fCB2LnNlcSA8IDApIHJldHVybiBmYWxzZTtcbiAgaWYgKCFpc05vbkVtcHR5U3RyaW5nKHYub2NjdXJyZWRBdCkgfHwgIWlzUmZjMzMzOSh2Lm9jY3VycmVkQXQpKSByZXR1cm4gZmFsc2U7XG4gIGlmICghRVZFTlRfS0lORFMuaW5jbHVkZXModi5raW5kIGFzIEV2ZW50S2luZCkpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIGlzUmVjb3JkKHYucGF5bG9hZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0Rlc2t0b3BFcnJvcih2OiB1bmtub3duKTogdiBpcyBEZXNrdG9wRXJyb3Ige1xuICBpZiAoIWlzUmVjb3JkKHYpKSByZXR1cm4gZmFsc2U7XG4gIGlmICghRVJST1JfQ09ERVMuaW5jbHVkZXModi5jb2RlIGFzIG5ldmVyKSkgcmV0dXJuIGZhbHNlO1xuICBpZiAodHlwZW9mIHYubWVzc2FnZSAhPT0gJ3N0cmluZycpIHJldHVybiBmYWxzZTtcbiAgaWYgKHR5cGVvZiB2LnJldHJ5YWJsZSAhPT0gJ2Jvb2xlYW4nKSByZXR1cm4gZmFsc2U7XG4gIGlmICh2LnNlc3Npb25JZCAhPT0gdW5kZWZpbmVkICYmICFpc05vbkVtcHR5U3RyaW5nKHYuc2Vzc2lvbklkKSkgcmV0dXJuIGZhbHNlO1xuICBpZiAodi5ydW5JZCAhPT0gdW5kZWZpbmVkICYmICFpc05vbkVtcHR5U3RyaW5nKHYucnVuSWQpKSByZXR1cm4gZmFsc2U7XG4gIGlmICh2LnJlY292ZXJ5QWN0aW9uICE9PSB1bmRlZmluZWQgJiYgIVJFQ09WRVJZX0FDVElPTlMuaW5jbHVkZXModi5yZWNvdmVyeUFjdGlvbiBhcyBuZXZlcikpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpc1J1blN0YXR1cyh2OiB1bmtub3duKTogdiBpcyBSdW5TdGF0dXMge1xuICByZXR1cm4gdHlwZW9mIHYgPT09ICdzdHJpbmcnICYmIFJVTl9TVEFUVVNFUy5pbmNsdWRlcyh2IGFzIFJ1blN0YXR1cyk7XG59XG5cbi8qKiBIb3N0IFx1NUYxNVx1NUJGQ1x1ODg0QyhzdGRvdXQgXHU3QjJDXHU0RTAwXHU4ODRDKVx1MzAwMiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzSG9zdFJlYWR5TGluZSh2OiB1bmtub3duKTogdiBpcyB7IGhtaERlc2t0b3BIb3N0UmVhZHk6IHRydWU7IHBvcnQ6IG51bWJlcjsgdmVyc2lvbjogc3RyaW5nIH0ge1xuICBpZiAoIWlzUmVjb3JkKHYpKSByZXR1cm4gZmFsc2U7XG4gIGlmICh2LmhtaERlc2t0b3BIb3N0UmVhZHkgIT09IHRydWUpIHJldHVybiBmYWxzZTtcbiAgaWYgKHR5cGVvZiB2LnBvcnQgIT09ICdudW1iZXInIHx8ICFOdW1iZXIuaXNJbnRlZ2VyKHYucG9ydCkgfHwgdi5wb3J0IDw9IDAgfHwgdi5wb3J0ID4gNjU1MzUpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIGlzTm9uRW1wdHlTdHJpbmcodi52ZXJzaW9uKTtcbn1cbiIsICIvKipcbiAqIERlc2t0b3BIb3N0Q2xpZW50IFx1MjAxNCBcdTVCRjkgaG1oIGhvc3QgXHU3Njg0IEhUVFArU1NFIFx1NUJBMlx1NjIzN1x1N0FFRlx1MzAwMlxuICpcbiAqIC0gXHU2QkNGXHU0RTJBIEhUVFAgXHU4QkY3XHU2QzQyXHU4MUVBXHU1MkE4XHU1RTI2IFgtSG1oLUtleSh0b2tlbiBcdTRFMERcdThGREIgVVJMKTtcbiAqIC0gXHU3RUQzXHU2Nzg0XHU1MzE2XHU5NTE5XHU4QkVGKHJlcy5ib2R5IFx1OTFDQ1x1NzY4NCBEZXNrdG9wRXJyb3IgXHU1RjYyXHU3MkI2XHU2MjE2IEhUVFAgXHU3MkI2XHU2MDAxKVx1ODlDNFx1N0VBNlx1NjIxMFx1NUYwMlx1NUUzOFx1NjI5Qlx1NTFGQTtcbiAqIC0gU1NFIFx1NzUyOCBmZXRjaCBcdTZENDFcdTYyNEJcdTUxOTlcdTg5RTNcdTY3OTAoaWQvZXZlbnQvZGF0YSBcdTVFMjcpLFx1NjUyRlx1NjMwMSBMYXN0LUV2ZW50LUlEIFx1ODg2NVx1NjJDOVx1OTFDRFx1OEZERVx1MzAwMlxuICovXG5pbXBvcnQgeyBkZXNrdG9wRXJyb3IsIGlzRGVza3RvcEVycm9yLCBpc0V2ZW50RW52ZWxvcGUsIHR5cGUgRGVza3RvcEVycm9yLCB0eXBlIEV2ZW50RW52ZWxvcGUgfSBmcm9tICdAaG1oLWRlc2t0b3AvY29udHJhY3RzJztcbmltcG9ydCB7IHJhbmRvbVVVSUQgfSBmcm9tICdub2RlOmNyeXB0byc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3NlRnJhbWUge1xuICBpZD86IHN0cmluZztcbiAgZXZlbnQ6IHN0cmluZztcbiAgZGF0YTogc3RyaW5nO1xufVxuXG4vKiogXHU4OUUzXHU2NzkwXHU0RTAwXHU2QkI1IFNTRSBcdTY1ODdcdTY3MkNcdTRFM0FcdTVFMjcoXHU0RTBEXHU1NDJCXHU4REU4IGNodW5rIFx1NzY4NFx1N0YxM1x1NTFCMlx1OTAzQlx1OEY5MSxcdTdFQUZcdTUxRkRcdTY1NzBcdTRGQkZcdTRFOEVcdTZENEJcdThCRDUpXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VTc2VDaHVuayhjaHVuazogc3RyaW5nKTogU3NlRnJhbWVbXSB7XG4gIGNvbnN0IGZyYW1lczogU3NlRnJhbWVbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGJsb2NrIG9mIGNodW5rLnNwbGl0KC9cXG5cXG4vKSkge1xuICAgIGlmICghYmxvY2sudHJpbSgpKSBjb250aW51ZTtcbiAgICBsZXQgaWQ6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICBsZXQgZXZlbnQgPSAnbWVzc2FnZSc7XG4gICAgY29uc3QgZGF0YUxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGxldCBzYXdGaWVsZCA9IGZhbHNlO1xuICAgIGZvciAoY29uc3QgbGluZSBvZiBibG9jay5zcGxpdCgnXFxuJykpIHtcbiAgICAgIGlmIChsaW5lLnN0YXJ0c1dpdGgoJzonKSkgY29udGludWU7IC8vIFx1NkNFOFx1OTFDQS9cdTVGQzNcdThERjNcbiAgICAgIGlmIChsaW5lLnN0YXJ0c1dpdGgoJ2lkOicpKSB7IGlkID0gbGluZS5zbGljZSgzKS50cmltKCk7IHNhd0ZpZWxkID0gdHJ1ZTsgfVxuICAgICAgZWxzZSBpZiAobGluZS5zdGFydHNXaXRoKCdldmVudDonKSkgeyBldmVudCA9IGxpbmUuc2xpY2UoNikudHJpbSgpOyBzYXdGaWVsZCA9IHRydWU7IH1cbiAgICAgIGVsc2UgaWYgKGxpbmUuc3RhcnRzV2l0aCgnZGF0YTonKSkgeyBkYXRhTGluZXMucHVzaChsaW5lLnNsaWNlKDUpLnJlcGxhY2UoL14gLywgJycpKTsgc2F3RmllbGQgPSB0cnVlOyB9XG4gICAgfVxuICAgIGlmICghc2F3RmllbGQpIGNvbnRpbnVlOyAvLyBcdTdFQUZcdTZDRThcdTkxQ0EvXHU1RkMzXHU4REYzXHU1NzU3XHU0RTBEXHU0RUE3XHU3NTFGXHU1RTI3XG4gICAgZnJhbWVzLnB1c2goeyAuLi4oaWQgIT09IHVuZGVmaW5lZCA/IHsgaWQgfSA6IHt9KSwgZXZlbnQsIGRhdGE6IGRhdGFMaW5lcy5qb2luKCdcXG4nKSB9KTtcbiAgfVxuICByZXR1cm4gZnJhbWVzO1xufVxuXG4vKiogXHU0RUNFIFNTRSBcdTVFMjdcdTY1NzBcdTYzNkVcdTRFMkRcdTg5RTNcdTUxRkFcdTU0MDhcdTZDRDUgRXZlbnRFbnZlbG9wZTtcdTRFMERcdTU0MDhcdTZDRDVcdTc2ODRcdThGRDRcdTU2REUgbnVsbChTQ0hFTUFfTUlTTUFUQ0ggXHU3NTMxXHU4QzAzXHU3NTI4XHU2NUI5XHU4QkExXHU2NTcwKVx1MzAwMiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVudmVsb3BlRnJvbUZyYW1lKGZyYW1lOiBTc2VGcmFtZSk6IEV2ZW50RW52ZWxvcGUgfCBudWxsIHtcbiAgaWYgKGZyYW1lLmV2ZW50ICE9PSAnaG1oJykgcmV0dXJuIG51bGw7IC8vIFx1NjIxMVx1NEVFQ1x1NzY4NFx1NEU4Qlx1NEVGNlx1NEZFMVx1NUMwMVx1N0VERlx1NEUwMFx1OEQ3MCBldmVudDogaG1oXG4gIHRyeSB7XG4gICAgY29uc3QgcGFyc2VkOiB1bmtub3duID0gSlNPTi5wYXJzZShmcmFtZS5kYXRhKTtcbiAgICByZXR1cm4gaXNFdmVudEVudmVsb3BlKHBhcnNlZCkgPyBwYXJzZWQgOiBudWxsO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5leHBvcnQgY2xhc3MgRGVza3RvcEh0dHBFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IocHVibGljIHJlYWRvbmx5IGRldGFpbDogRGVza3RvcEVycm9yKSB7XG4gICAgc3VwZXIoZGV0YWlsLm1lc3NhZ2UpO1xuICB9XG59XG5cbmV4cG9ydCBjbGFzcyBEZXNrdG9wSG9zdENsaWVudCB7XG4gIGNvbnN0cnVjdG9yKFxuICAgIHByaXZhdGUgcmVhZG9ubHkgYmFzZVVybDogc3RyaW5nLFxuICAgIHByaXZhdGUgcmVhZG9ubHkgdG9rZW46IHN0cmluZyxcbiAgKSB7fVxuXG4gIHByaXZhdGUgaGVhZGVycyhleHRyYTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9KTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB7XG4gICAgcmV0dXJuIHsgJ3gtaG1oLWtleSc6IHRoaXMudG9rZW4sIC4uLmV4dHJhIH07XG4gIH1cblxuICBhc3luYyBnZXRKc29uPFQ+KHBhdGg6IHN0cmluZywgdGltZW91dE1zID0gNV8wMDApOiBQcm9taXNlPFQ+IHtcbiAgICBsZXQgcmVzOiBSZXNwb25zZTtcbiAgICB0cnkge1xuICAgICAgcmVzID0gYXdhaXQgZmV0Y2goYCR7dGhpcy5iYXNlVXJsfSR7cGF0aH1gLCB7IGhlYWRlcnM6IHRoaXMuaGVhZGVycygpLCBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQodGltZW91dE1zKSB9KTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgcmVxdWVzdCBmYWlsZWQ6ICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTYwKX1gLCB7IHJldHJ5YWJsZTogdHJ1ZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcbiAgICB9XG4gICAgcmV0dXJuIHRoaXMucGFyc2VSZXNwb25zZTxUPihyZXMpO1xuICB9XG5cbiAgLyoqIFx1NjJDOVx1NTNENlx1N0VBRlx1NjU4N1x1NjcyQ1x1N0FFRlx1NzBCOShcdTU5ODIgL2FwaS9zZXNzaW9ucy86aWQvZXhwb3J0Lm1kKVx1MzAwMiAqL1xuICBhc3luYyBnZXRUZXh0KHBhdGg6IHN0cmluZywgdGltZW91dE1zID0gMTBfMDAwKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgICBsZXQgcmVzOiBSZXNwb25zZTtcbiAgICB0cnkge1xuICAgICAgcmVzID0gYXdhaXQgZmV0Y2goYCR7dGhpcy5iYXNlVXJsfSR7cGF0aH1gLCB7IGhlYWRlcnM6IHRoaXMuaGVhZGVycygpLCBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQodGltZW91dE1zKSB9KTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgcmVxdWVzdCBmYWlsZWQ6ICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTYwKX1gLCB7IHJldHJ5YWJsZTogdHJ1ZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcbiAgICB9XG4gICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSB8fCByZXMuc3RhdHVzID09PSA0MDMpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignQVVUSF9GQUlMRUQnLCBgaG9zdCByZWplY3RlZCB0aGUgc2Vzc2lvbiB0b2tlbiAoSFRUUCAke3Jlcy5zdGF0dXN9KWAsIHsgcmV0cnlhYmxlOiBmYWxzZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcbiAgICB9XG4gICAgaWYgKCFyZXMub2spIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgSFRUUCAke3Jlcy5zdGF0dXN9YCwgeyByZXRyeWFibGU6IHJlcy5zdGF0dXMgPj0gNTAwIH0pKTtcbiAgICB9XG4gICAgcmV0dXJuIHJlcy50ZXh0KCk7XG4gIH1cblxuICAvKiogXHU2QkNGXHU0RTJBXHU1RTI2XHU1MjZGXHU0RjVDXHU3NTI4XHU3Njg0IFBPU1QgXHU4MUVBXHU1MkE4XHU2NDNBXHU1RTI2XHU1RTQyXHU3QjQ5XHU5NTJFKDAzIFx1MDBBN1x1NTZEQlx1OTYzMlx1OTFDRFx1NjUzRTpcdThCRjdcdTZDNDJcdTRGN0ZcdTc1MjggaWRlbXBvdGVuY3lLZXk7XG4gICAqICBydW50aW1lIFx1NEZBN1x1NzdFRFx1NjcxRlx1NTE3Q1x1NUJCOVx1NUZGRFx1NzU2NSxcdTUzNEZcdThCQUVcdTUxNDhcdTg4NENcdTIwMTRcdTIwMTRcdTkxQ0RcdThCRDVcdTUzRUZcdTUxRURcdTk1MkVcdTUzQkJcdTkxQ0QsXHU0RTBEXHU3NkYyXHU3NkVFXHU5MUNEXHU2NTNFKVx1MzAwMiAqL1xuICBhc3luYyBwb3N0SnNvbjxUPihwYXRoOiBzdHJpbmcsIGJvZHk6IHVua25vd24sIHRpbWVvdXRNcyA9IDEwXzAwMCk6IFByb21pc2U8VD4ge1xuICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgIHRyeSB7XG4gICAgICByZXMgPSBhd2FpdCBmZXRjaChgJHt0aGlzLmJhc2VVcmx9JHtwYXRofWAsIHtcbiAgICAgICAgbWV0aG9kOiAnUE9TVCcsXG4gICAgICAgIGhlYWRlcnM6IHRoaXMuaGVhZGVycyh7XG4gICAgICAgICAgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICAgICAgICAneC1pZGVtcG90ZW5jeS1rZXknOiByYW5kb21VVUlEKCksXG4gICAgICAgIH0pLFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KSxcbiAgICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KHRpbWVvdXRNcyksXG4gICAgICB9KTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgcmVxdWVzdCBmYWlsZWQ6ICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTYwKX1gLCB7IHJldHJ5YWJsZTogdHJ1ZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcbiAgICB9XG4gICAgcmV0dXJuIHRoaXMucGFyc2VSZXNwb25zZTxUPihyZXMpO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBwYXJzZVJlc3BvbnNlPFQ+KHJlczogUmVzcG9uc2UpOiBQcm9taXNlPFQ+IHtcbiAgICBpZiAocmVzLnN0YXR1cyA9PT0gNDAxIHx8IHJlcy5zdGF0dXMgPT09IDQwMykge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdBVVRIX0ZBSUxFRCcsIGBob3N0IHJlamVjdGVkIHRoZSBzZXNzaW9uIHRva2VuIChIVFRQICR7cmVzLnN0YXR1c30pYCwgeyByZXRyeWFibGU6IGZhbHNlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICBjb25zdCB0ZXh0ID0gYXdhaXQgcmVzLnRleHQoKTtcbiAgICBsZXQgcGFyc2VkOiB1bmtub3duID0gbnVsbDtcbiAgICB0cnkge1xuICAgICAgcGFyc2VkID0gdGV4dCA/IEpTT04ucGFyc2UodGV4dCkgOiBudWxsO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcGFyc2VkID0gbnVsbDtcbiAgICB9XG4gICAgaWYgKCFyZXMub2spIHtcbiAgICAgIGlmIChpc0Rlc2t0b3BFcnJvcihwYXJzZWQpKSB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihwYXJzZWQpO1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBIVFRQICR7cmVzLnN0YXR1c306ICR7dGV4dC5zbGljZSgwLCAxNjApfWAsIHsgcmV0cnlhYmxlOiByZXMuc3RhdHVzID49IDUwMCB9KSk7XG4gICAgfVxuICAgIHJldHVybiBwYXJzZWQgYXMgVDtcbiAgfVxuXG4gIC8qKlxuICAgKiBcdThCQTJcdTk2MDVcdTUxNjhcdTkwRTggU1NFIFx1NUUyNyhcdTU0MkJcdTk3NUVcdTRGRTFcdTVDMDFcdTRFOEJcdTRFRjY6ZGVsdGEvbGluZSBcdTdCNDlcdTlBRDhcdTk4OTFcdTZENDEpXHUzMDAyXHU0RkUxXHU1QzAxXHU3NTMxXHU4QzAzXHU3NTI4XHU2NUI5XG4gICAqIFx1NzUyOCBlbnZlbG9wZUZyb21GcmFtZSBcdTgxRUFcdTg4NENcdTUyMDZcdTZENDE7XHU2NUFEXHU3RUJGXHU5MUNEXHU4RkRFXHU4QkVEXHU0RTQ5XHU1NDBDIGV2ZW50cygpXHUzMDAyXG4gICAqL1xuICBhc3luYyAqcmF3RXZlbnRzKGxhc3RFdmVudElkPzogc3RyaW5nLCBzaWduYWw/OiBBYm9ydFNpZ25hbCk6IEFzeW5jR2VuZXJhdG9yPFNzZUZyYW1lPiB7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYCR7dGhpcy5iYXNlVXJsfS9hcGkvZXZlbnRzYCwge1xuICAgICAgaGVhZGVyczogdGhpcy5oZWFkZXJzKHtcbiAgICAgICAgYWNjZXB0OiAndGV4dC9ldmVudC1zdHJlYW0nLFxuICAgICAgICAuLi4obGFzdEV2ZW50SWQgIT09IHVuZGVmaW5lZCA/IHsgJ2xhc3QtZXZlbnQtaWQnOiBsYXN0RXZlbnRJZCB9IDoge30pLFxuICAgICAgfSksXG4gICAgICAuLi4oc2lnbmFsICE9PSB1bmRlZmluZWQgPyB7IHNpZ25hbCB9IDoge30pLFxuICAgIH0pO1xuICAgIGlmIChyZXMuc3RhdHVzID09PSA0MDEgfHwgcmVzLnN0YXR1cyA9PT0gNDAzKSB7XG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgYGhvc3QgcmVqZWN0ZWQgdGhlIHNlc3Npb24gdG9rZW4gKEhUVFAgJHtyZXMuc3RhdHVzfSlgLCB7IHJldHJ5YWJsZTogZmFsc2UsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XG4gICAgfVxuICAgIGlmICghcmVzLm9rIHx8IHJlcy5ib2R5ID09PSBudWxsKSB7XG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYFNTRSBIVFRQICR7cmVzLnN0YXR1c31gLCB7IHJldHJ5YWJsZTogdHJ1ZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcbiAgICB9XG4gICAgY29uc3QgcmVhZGVyID0gcmVzLmJvZHkuZ2V0UmVhZGVyKCk7XG4gICAgY29uc3QgZGVjb2RlciA9IG5ldyBUZXh0RGVjb2RlcigpO1xuICAgIGxldCBidWZmZXIgPSAnJztcbiAgICBmb3IgKDs7KSB7XG4gICAgICBjb25zdCB7IGRvbmUsIHZhbHVlIH0gPSBhd2FpdCByZWFkZXIucmVhZCgpO1xuICAgICAgaWYgKGRvbmUpIHJldHVybjtcbiAgICAgIGJ1ZmZlciArPSBkZWNvZGVyLmRlY29kZSh2YWx1ZSwgeyBzdHJlYW06IHRydWUgfSk7XG4gICAgICBsZXQgaWR4OiBudW1iZXI7XG4gICAgICB3aGlsZSAoKGlkeCA9IGJ1ZmZlci5pbmRleE9mKCdcXG5cXG4nKSkgIT09IC0xKSB7XG4gICAgICAgIGNvbnN0IGJsb2NrID0gYnVmZmVyLnNsaWNlKDAsIGlkeCk7XG4gICAgICAgIGJ1ZmZlciA9IGJ1ZmZlci5zbGljZShpZHggKyAyKTtcbiAgICAgICAgZm9yIChjb25zdCBmcmFtZSBvZiBwYXJzZVNzZUNodW5rKGJsb2NrKSkgeWllbGQgZnJhbWU7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFx1OEJBMlx1OTYwNSBTU0UgXHU0RThCXHU0RUY2XHU2RDQxKGFzeW5jIGl0ZXJhdG9yKVx1MzAwMlx1NjVBRFx1N0VCRlx1NzUzMVx1OEMwM1x1NzUyOFx1NjVCOVx1OTFDRFx1OEZERTtcdTkxQ0RcdThGREVcdTY1RjZcdTYyOEFcdTY3MDBcdTU0MEVcbiAgICogXHU2NTM2XHU1MjMwXHU3Njg0IGV2ZW50SWQgXHU0RjIwXHU1MTY1IGxhc3RFdmVudElkLGhvc3QgXHU3QUVGXHU0RUNFXHU5MUNEXHU2NTNFXHU3M0FGXHU4ODY1XHU1M0QxXHUzMDAyXG4gICAqL1xuICBhc3luYyAqZXZlbnRzKGxhc3RFdmVudElkPzogc3RyaW5nLCBzaWduYWw/OiBBYm9ydFNpZ25hbCk6IEFzeW5jR2VuZXJhdG9yPEV2ZW50RW52ZWxvcGU+IHtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgJHt0aGlzLmJhc2VVcmx9L2FwaS9ldmVudHNgLCB7XG4gICAgICBoZWFkZXJzOiB0aGlzLmhlYWRlcnMoe1xuICAgICAgICBhY2NlcHQ6ICd0ZXh0L2V2ZW50LXN0cmVhbScsXG4gICAgICAgIC4uLihsYXN0RXZlbnRJZCAhPT0gdW5kZWZpbmVkID8geyAnbGFzdC1ldmVudC1pZCc6IGxhc3RFdmVudElkIH0gOiB7fSksXG4gICAgICB9KSxcbiAgICAgIC4uLihzaWduYWwgIT09IHVuZGVmaW5lZCA/IHsgc2lnbmFsIH0gOiB7fSksXG4gICAgfSk7XG4gICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSB8fCByZXMuc3RhdHVzID09PSA0MDMpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignQVVUSF9GQUlMRUQnLCBgaG9zdCByZWplY3RlZCB0aGUgc2Vzc2lvbiB0b2tlbiAoSFRUUCAke3Jlcy5zdGF0dXN9KWAsIHsgcmV0cnlhYmxlOiBmYWxzZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcbiAgICB9XG4gICAgaWYgKCFyZXMub2sgfHwgIXJlcy5ib2R5KSB7XG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYFNTRSBIVFRQICR7cmVzLnN0YXR1c31gLCB7IHJldHJ5YWJsZTogdHJ1ZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcbiAgICB9XG4gICAgY29uc3QgcmVhZGVyID0gcmVzLmJvZHkuZ2V0UmVhZGVyKCk7XG4gICAgY29uc3QgZGVjb2RlciA9IG5ldyBUZXh0RGVjb2RlcigpO1xuICAgIGxldCBidWZmZXIgPSAnJztcbiAgICBmb3IgKDs7KSB7XG4gICAgICBjb25zdCB7IGRvbmUsIHZhbHVlIH0gPSBhd2FpdCByZWFkZXIucmVhZCgpO1xuICAgICAgaWYgKGRvbmUpIHJldHVybjtcbiAgICAgIGJ1ZmZlciArPSBkZWNvZGVyLmRlY29kZSh2YWx1ZSwgeyBzdHJlYW06IHRydWUgfSk7XG4gICAgICAvLyBcdTRFRTVcdTdBN0FcdTg4NENcdTUyMDZcdTVFMjc7XHU0RkREXHU3NTU5XHU0RTBEXHU1QjhDXHU2NTc0XHU3Njg0XHU1QzNFXHU5MEU4XG4gICAgICBsZXQgaWR4OiBudW1iZXI7XG4gICAgICB3aGlsZSAoKGlkeCA9IGJ1ZmZlci5pbmRleE9mKCdcXG5cXG4nKSkgIT09IC0xKSB7XG4gICAgICAgIGNvbnN0IGJsb2NrID0gYnVmZmVyLnNsaWNlKDAsIGlkeCk7XG4gICAgICAgIGJ1ZmZlciA9IGJ1ZmZlci5zbGljZShpZHggKyAyKTtcbiAgICAgICAgZm9yIChjb25zdCBmcmFtZSBvZiBwYXJzZVNzZUNodW5rKGJsb2NrKSkge1xuICAgICAgICAgIGNvbnN0IGVudiA9IGVudmVsb3BlRnJvbUZyYW1lKGZyYW1lKTtcbiAgICAgICAgICBpZiAoZW52ICE9PSBudWxsKSB5aWVsZCBlbnY7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH1cbn1cbiIsICIvKipcbiAqIGZha2UgaG9zdCBcdTIwMTQgaG1oYXJuZXNzIHJ1bnRpbWUgXHU3Njg0XHU2RDRCXHU4QkQ1XHU2NkZGXHU4RUFCKE1hc3RlclByb21wdCBcdTk2MzZcdTZCQjUgRC9FOlxuICogXCJcdTUxNDhcdTRGN0ZcdTc1MjggZmFrZSBob3N0IFx1N0YxNlx1NTE5OVx1NzJCNlx1NjAwMVx1NjczQVx1NkQ0Qlx1OEJENSxcdTUxOERcdTYzQTVcdTc3MUZcdTVCOUUgQVBJXCI7XHU5NjM2XHU2QkI1IEUgXHU3Njg0XHU0RjFBXHU4QkREXHU3RUI1XHU1MjA3XHU3MjQ3XG4gKiBlMmUgXHU0RTVGXHU1MTQ4XHU1NzI4IGZha2UgXHU1QzQyXHU5NUVEXHU3M0FGKVx1MzAwMlxuICpcbiAqIFx1Njg0Q1x1OTc2MiBob3N0IFx1NTQwOFx1NTQwQzpcbiAqICAtIFx1NTNFQVx1N0VEMSAxMjcuMC4wLjEsXHU3QUVGXHU1M0UzIE9TIFx1NTIwNlx1OTE0RCxcdTVCOUVcdTk2NDVcdTdBRUZcdTUzRTNcdTUxOTkgc3Rkb3V0IFx1NUYxNVx1NUJGQ1x1ODg0QztcbiAqICAtIFx1NjI0MFx1NjcwOSAvYXBpLyogXHU4OTgxXHU2QzQyIFgtSG1oLUtleSA9PT0gSE1IX0RFU0tUT1BfVE9LRU4sXHU1NDI2XHU1MjE5IDQwMSArIERlc2t0b3BFcnJvcjtcbiAqICAtIEdFVCAvYXBpL3N0YXRlIFx1NTA2NVx1NUVCN1x1NjNBMlx1NkQ0QjtHRVQgL2FwaS9ldmVudHMgU1NFKGV2ZW50OiBobWggXHU0RkUxXHU1QzAxXHU2RDQxICsgXHU5MUNEXHU2NTNFXHU3M0FGKTtcbiAqICAtIFBPU1QgL2FwaS9kZXNrdG9wL3NodXRkb3duIFx1NEYxOFx1OTZDNVx1OTAwMFx1NTFGQVx1MzAwMlxuICpcbiAqIFx1OTYzNlx1NkJCNSBFIFx1NkEyMVx1NjJERlx1OTc2MihcdTRFMEUgaG1oYXJuZXNzIGRlc2t0b3AgXHU2QTIxXHU1RjBGXHU1NDBDXHU1RjYyKTpcbiAqICAtIFBPU1QgL2FwaS90YXNrIHt0ZXh0LCBzZXNzaW9uSWQsIG1vZGV9Olx1NjM5Mlx1OTYxRlx1NUU3Nlx1NjMwOVx1ODExQVx1NjcyQ1x1NTNEMVxuICogICAgcnVuLnN0YXJ0ZWQgXHUyMTkyIHRvb2wuc3RhcnRlZC9jb21wbGV0ZWQgXHUyMTkyKG1vZGU9PT0nYXNrJyBcdTY1RjYpXG4gKiAgICBhcHByb3ZhbC5yZXF1aXJlZChcdTdCNDkgL2FwaS9hcHByb3ZlKVx1MjE5MiBydW4uY29tcGxldGVkO1xuICogIC0gUE9TVCAvYXBpL2FwcHJvdmUge2dyYW50ZWQsIHNlc3Npb25JZH07XG4gKiAgLSBQT1NUIC9hcGkvaW50ZXJydXB0IHtzZXNzaW9uSWR9O1xuICogIC0gR0VUIC9hcGkvc2Vzc2lvbnNcdTMwMDJcbiAqXG4gKiBcdTZENEJcdThCRDVcdTk0QTlcdTVCNTA6RkFLRV9IT1NUX0RJRV9BRlRFUl9NUyAvIEZBS0VfSE9TVF9ESUVfQVRfQk9PVCAvXG4gKiBGQUtFX0hPU1RfRVhQRUNUX1RPS0VOIC8gRkFLRV9IT1NUX1RBU0tfREVMQVlfTVMgLyBGQUtFX0hPU1RfVEFTS19GQUlMPTFcbiAqIChcdTRFRkJcdTUyQTFcdTRFRTUgcnVuLmZhaWxlZCBcdTdFRDNcdTY3NUYsXHU2Nzg0XHU5MDIwXHU5NTE5XHU4QkVGXHU2MDYyXHU1OTBEXHU1NzNBXHU2NjZGKVx1MzAwMlxuICovXG5pbXBvcnQgeyBjcmVhdGVTZXJ2ZXIsIHR5cGUgU2VydmVyUmVzcG9uc2UgfSBmcm9tICdub2RlOmh0dHAnO1xuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gJ25vZGU6Y3J5cHRvJztcbmltcG9ydCB7IHBhdGhUb0ZpbGVVUkwgfSBmcm9tICdub2RlOnVybCc7XG5pbXBvcnQgeyByZWFscGF0aFN5bmMgfSBmcm9tICdub2RlOmZzJztcbmltcG9ydCB7IEVWRU5UX1NDSEVNQV9WRVJTSU9OLCBkZXNrdG9wRXJyb3IsIHR5cGUgRXZlbnRFbnZlbG9wZSwgdHlwZSBFdmVudEtpbmQgfSBmcm9tICdAaG1oLWRlc2t0b3AvY29udHJhY3RzJztcblxuZXhwb3J0IGludGVyZmFjZSBGYWtlSG9zdEhhbmRsZSB7XG4gIHBvcnQ6IG51bWJlcjtcbiAgZW1pdChzZXNzaW9uSWQ6IHN0cmluZywgcnVuSWQ6IHN0cmluZywga2luZDogRXZlbnRLaW5kLCBwYXlsb2FkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IG51bWJlcjtcbiAgY2xvc2UoKTogUHJvbWlzZTx2b2lkPjtcbn1cblxuaW50ZXJmYWNlIEZha2VTZXNzaW9uIHtcbiAgaWQ6IHN0cmluZztcbiAgY3JlYXRlZEF0OiBzdHJpbmc7XG4gIHVwZGF0ZWRBdDogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgUGVuZGluZ0FwcHJvdmFsIHtcbiAgc2Vzc2lvbklkOiBzdHJpbmc7XG4gIGFwcHJvdmFsSWQ6IHN0cmluZztcbiAgcmVzb2x2ZShncmFudGVkOiBib29sZWFuKTogdm9pZDtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHN0YXJ0RmFrZUhvc3Qob3B0czogeyB0b2tlbjogc3RyaW5nOyBxdWlldD86IGJvb2xlYW4gfSk6IFByb21pc2U8RmFrZUhvc3RIYW5kbGU+IHtcbiAgY29uc3QgdG9rZW4gPSBvcHRzLnRva2VuO1xuICAvLyBcdTZENEJcdThCRDVcdTk0QTlcdTVCNTA6RkFLRV9IT1NUX0VYUEVDVF9UT0tFTiBcdThCQTkgaG9zdCBcdTY4MjFcdTlBOENcdTRFMDBcdTRFMkFcdTRFMEUgSE1IX0RFU0tUT1BfVE9LRU5cbiAgLy8gXHU0RTBEXHU1NDBDXHU3Njg0XHU1MDNDKFx1Njc4NFx1OTAyMCBBVVRIX0ZBSUxFRCBcdTU3M0FcdTY2NkY7c3VwZXJ2aXNvciBcdTYwM0JcdTY2MkZcdTg5ODZcdTc2RDYgSE1IX0RFU0tUT1BfVE9LRU4pXG4gIGNvbnN0IGV4cGVjdGVkID0gcHJvY2Vzcy5lbnYuRkFLRV9IT1NUX0VYUEVDVF9UT0tFTiA/PyB0b2tlbjtcbiAgY29uc3QgdGFza0RlbGF5ID0gTnVtYmVyKHByb2Nlc3MuZW52LkZBS0VfSE9TVF9UQVNLX0RFTEFZX01TID8/IDMwKTtcbiAgY29uc3QgZmFpbFRhc2tzID0gcHJvY2Vzcy5lbnYuRkFLRV9IT1NUX1RBU0tfRkFJTCA9PT0gJzEnO1xuXG4gIGNvbnN0IHNzZUNsaWVudHMgPSBuZXcgU2V0PFNlcnZlclJlc3BvbnNlPigpO1xuICBjb25zdCBzZXFCeVJ1biA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG4gIC8vIFx1OTFDRFx1NjUzRVx1NzNBRjpcdTY3MDBcdThGRDEgMjAwIFx1NUUyNyhMYXN0LUV2ZW50LUlEIFx1NjVBRFx1N0VCRlx1ODg2NVx1NjJDOSksXHU0RTBFIGhtaGFybmVzcyB3ZWIgXHU1NDBDXHU2QjNFXHU4QkVEXHU0RTQ5XG4gIGNvbnN0IHJpbmc6IEFycmF5PHsgaWQ6IG51bWJlcjsgZXZlbnQ6IHN0cmluZzsgZGF0YTogdW5rbm93biB9PiA9IFtdO1xuICBsZXQgcmluZ1NlcSA9IDA7XG4gIGNvbnN0IHNlc3Npb25zID0gbmV3IE1hcDxzdHJpbmcsIEZha2VTZXNzaW9uPigpO1xuICBsZXQgcGVuZGluZzogUGVuZGluZ0FwcHJvdmFsIHwgbnVsbCA9IG51bGw7XG4gIGNvbnN0IHJ1blRpbWVycyA9IG5ldyBNYXA8c3RyaW5nLCBOb2RlSlMuVGltZW91dD4oKTtcbiAgLy8gXHU1REU1XHU0RjVDXHU1MzNBL1Byb3ZpZGVyIFx1NzJCNlx1NjAwMShcdTRFMEUgaG1oYXJuZXNzIFx1NTQwQ1x1NUY2Mlx1NzY4NFx1NjcwMFx1NUMwRlx1NkEyMVx1NjJERilcbiAgY29uc3QgZmFrZVdvcmtzcGFjZXMgPSB7XG4gICAgY3VycmVudDogJ3dzLWRlbW8nLFxuICAgIGl0ZW1zOiBbXG4gICAgICB7IGlkOiAnd3MtZGVtbycsIG5hbWU6ICdkZW1vLXdvcmtzcGFjZScsIHBhdGg6ICdDOlxcXFxkZW1vJyB9LFxuICAgIF0sXG4gIH07XG4gIGNvbnN0IGZha2VQcm92aWRlcnMgPSBuZXcgTWFwPHN0cmluZywgeyBiYXNlVXJsOiBzdHJpbmc7IG1vZGVsOiBzdHJpbmc7IGFwaUtleTogc3RyaW5nIH0+KFtcbiAgICBbJ2RlbW8nLCB7IGJhc2VVcmw6ICdodHRwOi8vMTI3LjAuMC4xOjkvdjEnLCBtb2RlbDogJ2Zha2UtbScsIGFwaUtleTogJ3NrLWRlbW8tMTIzNCcgfV0sXG4gICAgWydkZW1vLXZpc2lvbicsIHsgYmFzZVVybDogJ2h0dHA6Ly8xMjcuMC4wLjE6OS92MScsIG1vZGVsOiAnZmFrZS1tLXZpc2lvbicsIGFwaUtleTogJ3NrLWRlbW8tNTY3OCcgfV0sXG4gIF0pO1xuICBsZXQgZmFrZUNoYXRQcm92aWRlciA9ICdkZW1vJztcblxuICBjb25zdCBlbWl0ID0gKHNlc3Npb25JZDogc3RyaW5nLCBydW5JZDogc3RyaW5nLCBraW5kOiBFdmVudEtpbmQsIHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogbnVtYmVyID0+IHtcbiAgICBjb25zdCBrZXkgPSBgJHtzZXNzaW9uSWR9XFwwJHtydW5JZH1gO1xuICAgIGNvbnN0IHNlcSA9IChzZXFCeVJ1bi5nZXQoa2V5KSA/PyAwKSArIDE7XG4gICAgc2VxQnlSdW4uc2V0KGtleSwgc2VxKTtcbiAgICBjb25zdCBlbnY6IEV2ZW50RW52ZWxvcGUgPSB7XG4gICAgICBzY2hlbWFWZXJzaW9uOiBFVkVOVF9TQ0hFTUFfVkVSU0lPTixcbiAgICAgIGV2ZW50SWQ6IHJhbmRvbVVVSUQoKSxcbiAgICAgIHNlc3Npb25JZCxcbiAgICAgIHJ1bklkLFxuICAgICAgc2VxLFxuICAgICAgb2NjdXJyZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAga2luZCxcbiAgICAgIHBheWxvYWQsXG4gICAgfTtcbiAgICBjb25zdCBpZCA9ICsrcmluZ1NlcTtcbiAgICByaW5nLnB1c2goeyBpZCwgZXZlbnQ6ICdobWgnLCBkYXRhOiBlbnYgfSk7XG4gICAgaWYgKHJpbmcubGVuZ3RoID4gMjAwKSByaW5nLnNwbGljZSgwLCByaW5nLmxlbmd0aCAtIDIwMCk7XG4gICAgZm9yIChjb25zdCBjIG9mIHNzZUNsaWVudHMpIHtcbiAgICAgIGMud3JpdGUoYGlkOiAke2lkfVxcbmV2ZW50OiBobWhcXG5kYXRhOiAke0pTT04uc3RyaW5naWZ5KGVudil9XFxuXFxuYCk7XG4gICAgfVxuICAgIHJldHVybiBzZXE7XG4gIH07XG5cbiAgY29uc3QgdG91Y2ggPSAoc2Vzc2lvbklkOiBzdHJpbmcpOiBGYWtlU2Vzc2lvbiA9PiB7XG4gICAgbGV0IHMgPSBzZXNzaW9ucy5nZXQoc2Vzc2lvbklkKTtcbiAgICBpZiAocyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBzID0geyBpZDogc2Vzc2lvbklkLCBjcmVhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSwgdXBkYXRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkgfTtcbiAgICAgIHNlc3Npb25zLnNldChzZXNzaW9uSWQsIHMpO1xuICAgIH1cbiAgICBzLnVwZGF0ZWRBdCA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcbiAgICByZXR1cm4gcztcbiAgfTtcblxuICAvKiogXHU2QTIxXHU2MkRGXHU0RTAwXHU2QjIxXHU0RUZCXHU1MkExOlx1NjI3OVx1NTFDNlx1NkEyMVx1NUYwRlx1NjMwMlx1OEQ3N1x1N0I0OVx1NUY4NSAvYXBpL2FwcHJvdmVcdTMwMDIgKi9cbiAgY29uc3QgcnVuVGFzayA9IChzZXNzaW9uSWQ6IHN0cmluZywgdGV4dDogc3RyaW5nLCBtb2RlOiBzdHJpbmcpOiBzdHJpbmcgPT4ge1xuICAgIGNvbnN0IHJ1bklkID0gYHJ1bi0ke0RhdGUubm93KCkudG9TdHJpbmcoMzYpfS0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDgpfWA7XG4gICAgdG91Y2goc2Vzc2lvbklkKTtcbiAgICBjb25zdCBzdGVwczogQXJyYXk8KCkgPT4gdm9pZD4gPSBbXTtcbiAgICBjb25zdCB3YWl0ID0gKGZuOiAoKSA9PiB2b2lkLCBtcyA9IHRhc2tEZWxheSk6IHZvaWQgPT4ge1xuICAgICAgY29uc3QgdCA9IHNldFRpbWVvdXQoZm4sIG1zKTtcbiAgICAgIHJ1blRpbWVycy5zZXQoYCR7c2Vzc2lvbklkfVxcMCR7cnVuSWR9YCwgdCk7XG4gICAgfTtcbiAgICBjb25zdCBjaGFpbiA9IChmbnM6IEFycmF5PCgpID0+IHZvaWQ+KTogdm9pZCA9PiB7XG4gICAgICBjb25zdCBbZmlyc3QsIC4uLnJlc3RdID0gZm5zO1xuICAgICAgaWYgKGZpcnN0ID09PSB1bmRlZmluZWQpIHJldHVybjtcbiAgICAgIHdhaXQoKCkgPT4ge1xuICAgICAgICBmaXJzdCgpO1xuICAgICAgICBjaGFpbihyZXN0KTtcbiAgICAgIH0pO1xuICAgIH07XG5cbiAgICBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICdydW4uc3RhcnRlZCcsIHsgdGFzazogdGV4dCwgbW9kZSB9KTtcbiAgICBpZiAoZmFpbFRhc2tzKSB7XG4gICAgICB3YWl0KCgpID0+IGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ3J1bi5mYWlsZWQnLCB7XG4gICAgICAgIGVycm9yOiB7IGNvZGU6ICdBVVRIX0ZBSUxFRCcsIG1lc3NhZ2U6ICdzaW11bGF0ZWQgcHJvdmlkZXIgYXV0aCBmYWlsdXJlJywgcmV0cnlhYmxlOiBmYWxzZSB9LFxuICAgICAgfSkpO1xuICAgICAgcmV0dXJuIHJ1bklkO1xuICAgIH1cblxuICAgIGNvbnN0IGZpbmlzaFJ1biA9IChhbnN3ZXI6IHN0cmluZywgdG9vbFVzZXM6IG51bWJlcik6IHZvaWQgPT4ge1xuICAgICAgcnVuVGltZXJzLmRlbGV0ZShgJHtzZXNzaW9uSWR9XFwwJHtydW5JZH1gKTtcbiAgICAgIC8vIFx1NEVBNFx1NEVEOFx1NzI2OVx1NTE0OFx1NEU4RVx1N0VDOFx1NjAwMShcdTRFMEUgaG1oYXJuZXNzIGRlc2t0b3AgXHU2ODY1XHU1NDBDXHU1RThGOmFydGlmYWN0LmNyZWF0ZWQgXHUyMTkyIHJ1bi5jb21wbGV0ZWQpXG4gICAgICBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICdhcnRpZmFjdC5jcmVhdGVkJywge1xuICAgICAgICBhcnRpZmFjdDogeyByZWxQYXRoOiAnb3V0LnR4dCcsIGtpbmQ6ICdmaWxlJywgdGl0bGU6ICdvdXQudHh0JyB9LFxuICAgICAgfSk7XG4gICAgICBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICdydW4uY29tcGxldGVkJywgeyB0ZXh0OiBhbnN3ZXIsIHR1cm5zOiAxLCB0b29sVXNlcyB9KTtcbiAgICB9O1xuXG4gICAgY29uc3Qgc2NyaXB0ZWQ6IEFycmF5PCgpID0+IHZvaWQ+ID0gW1xuICAgICAgKCkgPT4gZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAndG9vbC5zdGFydGVkJywgeyBuYW1lOiAncmVhZF9maWxlJywgYXJnc1ByZXZpZXc6ICd7XCJwYXRoXCI6XCJSRUFETUUubWRcIn0nIH0pLFxuICAgICAgKCkgPT4gZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAndG9vbC5jb21wbGV0ZWQnLCB7IG5hbWU6ICdyZWFkX2ZpbGUnLCBpc0Vycm9yOiBmYWxzZSwgb3V0cHV0UHJldmlldzogJyMgZGVtbycgfSksXG4gICAgXTtcblxuICAgIGlmIChtb2RlID09PSAnYXNrJykge1xuICAgICAgc2NyaXB0ZWQucHVzaCgoKSA9PiB7XG4gICAgICAgIGNvbnN0IGFwcHJvdmFsSWQgPSBgYXAtJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCA4KX1gO1xuICAgICAgICBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICdhcHByb3ZhbC5yZXF1aXJlZCcsIHtcbiAgICAgICAgICBhcHByb3ZhbElkLFxuICAgICAgICAgIHRvb2w6ICd3cml0ZV9maWxlJyxcbiAgICAgICAgICBhcmdzUHJldmlldzogJ3tcInBhdGhcIjpcIm91dC50eHRcIixcImNvbnRlbnRcIjpcImhpXCJ9JyxcbiAgICAgICAgICByaXNrOiAnXHU1MTk5XHU1MTY1XHU1REU1XHU0RjVDXHU1MzNBXHU2NTg3XHU0RUY2IG91dC50eHQoXHU2QTIxXHU2MkRGKScsXG4gICAgICAgIH0pO1xuICAgICAgICBwZW5kaW5nID0ge1xuICAgICAgICAgIHNlc3Npb25JZCxcbiAgICAgICAgICBhcHByb3ZhbElkLFxuICAgICAgICAgIHJlc29sdmU6IChncmFudGVkKSA9PiB7XG4gICAgICAgICAgICBwZW5kaW5nID0gbnVsbDtcbiAgICAgICAgICAgIGlmIChncmFudGVkKSB7XG4gICAgICAgICAgICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ3Rvb2wuc3RhcnRlZCcsIHsgbmFtZTogJ3dyaXRlX2ZpbGUnLCBhcmdzUHJldmlldzogJ3tcInBhdGhcIjpcIm91dC50eHRcIn0nIH0pO1xuICAgICAgICAgICAgICB3YWl0KCgpID0+IGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ3Rvb2wuY29tcGxldGVkJywgeyBuYW1lOiAnd3JpdGVfZmlsZScsIGlzRXJyb3I6IGZhbHNlLCBvdXRwdXRQcmV2aWV3OiAnd3JvdGUgMiBieXRlcycgfSkpO1xuICAgICAgICAgICAgICB3YWl0KCgpID0+IGZpbmlzaFJ1bihgZWNobzogJHt0ZXh0fShcdTVERjJcdTYyNjdcdTg4NENcdTUxOTlcdTUxNjUpYCwgMyksIHRhc2tEZWxheSAqIDIpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgZmluaXNoUnVuKGBlY2hvOiAke3RleHR9KFx1NUJBMVx1NjI3OVx1ODhBQlx1NjJEMlx1N0VERCxcdTY3MkFcdTYyNjdcdTg4NENcdTUxOTlcdTUxNjUpYCwgMSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSxcbiAgICAgICAgfTtcbiAgICAgIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICBzY3JpcHRlZC5wdXNoKCgpID0+IGZpbmlzaFJ1bihgZWNobzogJHt0ZXh0fWAsIDEpKTtcbiAgICB9XG4gICAgY2hhaW4oc2NyaXB0ZWQpO1xuICAgIHJldHVybiBydW5JZDtcbiAgfTtcblxuICBjb25zdCBzZXJ2ZXIgPSBjcmVhdGVTZXJ2ZXIoKHJlcSwgcmVzKSA9PiB7XG4gICAgY29uc3QgdXJsID0gbmV3IFVSTChyZXEudXJsID8/ICcvJywgJ2h0dHA6Ly8xMjcuMC4wLjEnKTtcbiAgICBjb25zdCBhdXRob3JpemVkID0gcmVxLmhlYWRlcnNbJ3gtaG1oLWtleSddID09PSBleHBlY3RlZDtcbiAgICBjb25zdCBkZW55ID0gKCk6IHZvaWQgPT4ge1xuICAgICAgcmVzLndyaXRlSGVhZCg0MDEsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdBVVRIX0ZBSUxFRCcsICdtaXNzaW5nIG9yIGludmFsaWQgeC1obWgta2V5JywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgfTtcblxuICAgIGNvbnN0IHJlYWRCb2R5ID0gKCk6IFByb21pc2U8c3RyaW5nPiA9PlxuICAgICAgbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcbiAgICAgICAgbGV0IGIgPSAnJztcbiAgICAgICAgcmVxLm9uKCdkYXRhJywgKGM6IEJ1ZmZlcikgPT4geyBiICs9IGMudG9TdHJpbmcoKTsgfSk7XG4gICAgICAgIHJlcS5vbignZW5kJywgKCkgPT4gcmVzb2x2ZShiKSk7XG4gICAgICB9KTtcblxuICAgIGlmICh1cmwucGF0aG5hbWUgPT09ICcvYXBpL2V2ZW50cycpIHtcbiAgICAgIGlmICghYXV0aG9yaXplZCkgeyBkZW55KCk7IHJldHVybjsgfVxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICd0ZXh0L2V2ZW50LXN0cmVhbScsICdjYWNoZS1jb250cm9sJzogJ25vLWNhY2hlJywgY29ubmVjdGlvbjogJ2tlZXAtYWxpdmUnIH0pO1xuICAgICAgcmVzLmZsdXNoSGVhZGVycz8uKCk7XG4gICAgICBzc2VDbGllbnRzLmFkZChyZXMpO1xuICAgICAgLy8gXHU2NUFEXHU3RUJGXHU4ODY1XHU2MkM5Okxhc3QtRXZlbnQtSUQgXHU0RTRCXHU1MjREXHU3Njg0XHU1RTI3XHU1REYyXHU1NzI4XHU1QkEyXHU2MjM3XHU3QUVGLFx1OTFDRFx1NTNEMVx1NTE3Nlx1NTQwRVx1NzY4NFx1NzNBRlx1NUY2Mlx1N0YxM1x1NTFCMlxuICAgICAgY29uc3QgbGFzdElkID0gTnVtYmVyKHJlcS5oZWFkZXJzWydsYXN0LWV2ZW50LWlkJ10gPz8gMCk7XG4gICAgICBpZiAoTnVtYmVyLmlzRmluaXRlKGxhc3RJZCkgJiYgbGFzdElkID4gMCkge1xuICAgICAgICBmb3IgKGNvbnN0IGUgb2YgcmluZykge1xuICAgICAgICAgIGlmIChlLmlkID4gbGFzdElkKSByZXMud3JpdGUoYGlkOiAke2UuaWR9XFxuZXZlbnQ6ICR7ZS5ldmVudH1cXG5kYXRhOiAke0pTT04uc3RyaW5naWZ5KGUuZGF0YSl9XFxuXFxuYCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIHJlcS5vbignY2xvc2UnLCAoKSA9PiBzc2VDbGllbnRzLmRlbGV0ZShyZXMpKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKCFhdXRob3JpemVkKSB7IGRlbnkoKTsgcmV0dXJuOyB9XG5cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9zdGF0ZScpIHtcbiAgICAgIC8vIHByb3ZpZGVyc0RldGFpbDpcdTRFMEUgaG1oYXJuZXNzIFx1NTQwQ1x1NUY2Mlx1MjAxNFx1MjAxNGtleSBcdTUzRUFcdTUxRkEgaGFzS2V5L1x1NjcyQlx1NTZEQlx1NEY0RCxcdTZDMzhcdTRFMERcdTY2MEVcdTY1ODdcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgZGFlbW9uVmVyc2lvbjogJ2Zha2UtMC4wLjAnLCBkZXNrdG9wOiB0cnVlLCBtb2RlbDogZmFrZVByb3ZpZGVycy5nZXQoZmFrZUNoYXRQcm92aWRlcik/Lm1vZGVsID8/ICdmYWtlLW1vZGVsJyxcbiAgICAgICAgY2hhdFByb3ZpZGVyOiBmYWtlQ2hhdFByb3ZpZGVyLCBsb2NhbGU6ICd6aCcsXG4gICAgICAgIGJ1c3lTZXNzaW9uczogWy4uLnNlc3Npb25zLmtleXMoKV0uc2xpY2UoMCwgMiksXG4gICAgICAgIGFwcHJvdmFsUGVuZGluZzogcGVuZGluZyAhPT0gbnVsbCxcbiAgICAgICAgc2V0dGluZ3M6IHsgYXBwcm92YWw6ICdhc2snIH0sXG4gICAgICAgIHdvcmtzcGFjZTogZmFrZVdvcmtzcGFjZXMuaXRlbXMuZmluZCgodykgPT4gdy5pZCA9PT0gZmFrZVdvcmtzcGFjZXMuY3VycmVudCkgPz8gbnVsbCxcbiAgICAgICAgcHJvdmlkZXJzRGV0YWlsOiBbLi4uZmFrZVByb3ZpZGVycy5lbnRyaWVzKCldLm1hcCgoW25hbWUsIHBdKSA9PiAoe1xuICAgICAgICAgIG5hbWUsIG1vZGVsOiBwLm1vZGVsLCBiYXNlVXJsOiBwLmJhc2VVcmwsXG4gICAgICAgICAgaGFzS2V5OiBwLmFwaUtleSAhPT0gJycsXG4gICAgICAgICAga2V5VGFpbDogcC5hcGlLZXkubGVuZ3RoID49IDQgPyBwLmFwaUtleS5zbGljZSgtNCkgOiB1bmRlZmluZWQsXG4gICAgICAgICAgcHVycG9zZXM6IFsnY2hhdCddLFxuICAgICAgICB9KSksXG4gICAgICB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9kZXNrdG9wL3NodXRkb3duJykge1xuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSB9KSk7XG4gICAgICBzZXJ2ZXIuY2xvc2UoKCkgPT4gcHJvY2Vzcy5leGl0KDApKTtcbiAgICAgIHNldFRpbWVvdXQoKCkgPT4gcHJvY2Vzcy5leGl0KDApLCAxXzAwMCkudW5yZWYoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2Zha2UvZGllJykge1xuICAgICAgLy8gXHU2RDRCXHU4QkQ1XHU5NEE5XHU1QjUwOlx1NkEyMVx1NjJERiBob3N0IFx1NUQyOVx1NkU4MyhcdTUxNDhcdTVFOTRcdTdCNTRcdTUxOERcdTkwMDBcdTUxRkEsXHU0RkREXHU4QkMxXHU1NENEXHU1RTk0XHU1REYyXHU1M0QxXHU1MUZBKVxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSB9KSk7XG4gICAgICBzZXRUaW1lb3V0KCgpID0+IHByb2Nlc3MuZXhpdCgxKSwgNTApO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvbW9kZWwnKSB7XG4gICAgICAvLyBcdTZBMjFcdTU3OEJcdTUyMDdcdTYzNjIoXHU0RTBFIGhtaGFybmVzcyAvYXBpL21vZGVsIFx1NTQwQ1x1NUY2MjpcdTUyMDcgY2hhdCBcdThERUZcdTc1MzEpXG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7IG5hbWU/OiB1bmtub3duIH07XG4gICAgICAgIGNvbnN0IG5hbWUgPSB0eXBlb2YgYm9keS5uYW1lID09PSAnc3RyaW5nJyA/IGJvZHkubmFtZS50cmltKCkgOiAnJztcbiAgICAgICAgaWYgKCFmYWtlUHJvdmlkZXJzLmhhcyhuYW1lKSkge1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICdwcm92aWRlciBub3QgZm91bmQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgZmFrZUNoYXRQcm92aWRlciA9IG5hbWU7XG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgbW9kZWw6IGZha2VQcm92aWRlcnMuZ2V0KG5hbWUpPy5tb2RlbCB9KSk7XG4gICAgICB9KSgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvdGFzaycpIHtcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgoYXdhaXQgcmVhZEJvZHkoKSkgfHwgJ3t9JykgYXMgeyB0ZXh0PzogdW5rbm93bjsgc2Vzc2lvbklkPzogdW5rbm93bjsgbW9kZT86IHVua25vd247IGF0dGFjaG1lbnRzPzogdW5rbm93bjsgaW1hZ2VzPzogdW5rbm93biB9O1xuICAgICAgICAgIGNvbnN0IHRleHQgPSB0eXBlb2YgYm9keS50ZXh0ID09PSAnc3RyaW5nJyA/IGJvZHkudGV4dCA6ICcnO1xuICAgICAgICAgIGNvbnN0IHNlc3Npb25JZCA9IHR5cGVvZiBib2R5LnNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBib2R5LnNlc3Npb25JZCA6IGB3ZWItJHtEYXRlLm5vdygpLnRvU3RyaW5nKDM2KX1gO1xuICAgICAgICAgIGNvbnN0IG1vZGUgPSBib2R5Lm1vZGUgPT09ICdhc2snIHx8IGJvZHkubW9kZSA9PT0gJ2F1dG8nIHx8IGJvZHkubW9kZSA9PT0gJ3lvbG8nID8gYm9keS5tb2RlIDogJ2Fzayc7XG4gICAgICAgICAgY29uc3QgYXR0YWNobWVudHMgPSBBcnJheS5pc0FycmF5KGJvZHkuYXR0YWNobWVudHMpID8gYm9keS5hdHRhY2htZW50cy5maWx0ZXIoKGEpOiBhIGlzIHN0cmluZyA9PiB0eXBlb2YgYSA9PT0gJ3N0cmluZycpIDogW107XG4gICAgICAgICAgLy8gXHU1NkZFXHU3MjQ3XHU5NjQ0XHU0RUY2Olx1NEUwRSBobWhhcm5lc3MgdmlzaW9uIFx1NTM0Rlx1OEJBRVx1NTQwQ1x1NUY2Mih7bmFtZSxkYXRhVXJsfSk7ZmFrZSBcdTY4MjFcdTlBOENcdTVGNjJcdTcyQjZcdTUzNzNcdTY1MzZcbiAgICAgICAgICBjb25zdCBpbWFnZXMgPSBBcnJheS5pc0FycmF5KGJvZHkuaW1hZ2VzKVxuICAgICAgICAgICAgPyBib2R5LmltYWdlcy5maWx0ZXIoKGltKTogaW0gaXMgeyBuYW1lOiBzdHJpbmc7IGRhdGFVcmw6IHN0cmluZyB9ID0+IHtcbiAgICAgICAgICAgICAgICBpZiAodHlwZW9mIGltICE9PSAnb2JqZWN0JyB8fCBpbSA9PT0gbnVsbCkgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgICAgIGNvbnN0IG8gPSBpbSBhcyB7IG5hbWU/OiB1bmtub3duOyBkYXRhVXJsPzogdW5rbm93biB9O1xuICAgICAgICAgICAgICAgIHJldHVybiB0eXBlb2Ygby5uYW1lID09PSAnc3RyaW5nJyAmJiB0eXBlb2Ygby5kYXRhVXJsID09PSAnc3RyaW5nJyAmJiBvLmRhdGFVcmwuc3RhcnRzV2l0aCgnZGF0YTppbWFnZS8nKTtcbiAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgIDogW107XG4gICAgICAgICAgaWYgKCF0ZXh0KSB7XG4gICAgICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICd0ZXh0IHJlcXVpcmVkJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIFx1NEUwRSBobWhhcm5lc3MgXHU1NDBDXHU4QkVEXHU0RTQ5Olx1NTQwOFx1NkNENVx1OTY0NFx1NEVGNlx1NEVFNSBbcmVmZXJlbmNlZCBmaWxlc10gXHU1MjREXHU3RjAwXHU1RTc2XHU1MTY1XHU0RUZCXHU1MkExXHU2NTg3XHU2NzJDO1xuICAgICAgICAgIC8vIFx1NTZGRVx1NzI0N1x1NEVFNSBbaW1hZ2VzXSBcdTUyNERcdTdGMDBcdTY4MDdcdTZDRThcdTVGMjBcdTY1NzAodmlzaW9uIFx1NjNDRlx1OEZGMFx1OTRGRVx1NTcyOFx1NzcxRlx1NUI5RSBydW50aW1lIFx1OTFDQ1x1NTNEMVx1NzUxRilcbiAgICAgICAgICBjb25zdCBjb21wb3NlZCA9IGF0dGFjaG1lbnRzLmxlbmd0aCA+IDBcbiAgICAgICAgICAgID8gYFtyZWZlcmVuY2VkIGZpbGVzXVxcbiR7YXR0YWNobWVudHMubWFwKChhKSA9PiBgLSAke2Euc3BsaXQoL1tcXFxcL10vKS5wb3AoKX1gKS5qb2luKCdcXG4nKX1cXG5cXG4ke3RleHR9YFxuICAgICAgICAgICAgOiB0ZXh0O1xuICAgICAgICAgIGNvbnN0IHdpdGhJbWFnZXMgPSBpbWFnZXMubGVuZ3RoID4gMCA/IGBbaW1hZ2VzOiAke2ltYWdlcy5sZW5ndGh9XVxcbiR7Y29tcG9zZWR9YCA6IGNvbXBvc2VkO1xuICAgICAgICAgIGNvbnN0IHJ1bklkID0gcnVuVGFzayhzZXNzaW9uSWQsIHdpdGhJbWFnZXMsIG1vZGUpO1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlLCBydW5JZCwgaW1hZ2VzOiBpbWFnZXMubGVuZ3RoIH0pKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgU3RyaW5nKGVycikuc2xpY2UoMCwgMTIwKSwgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgIH1cbiAgICAgIH0pKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9hcHByb3ZlJykge1xuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgoYXdhaXQgcmVhZEJvZHkoKSkgfHwgJ3t9JykgYXMgeyBncmFudGVkPzogdW5rbm93bjsgc2Vzc2lvbklkPzogdW5rbm93biB9O1xuICAgICAgICBjb25zdCBzaWQgPSB0eXBlb2YgYm9keS5zZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gYm9keS5zZXNzaW9uSWQgOiAnJztcbiAgICAgICAgaWYgKHBlbmRpbmcgPT09IG51bGwgfHwgKHNpZCAhPT0gJycgJiYgcGVuZGluZy5zZXNzaW9uSWQgIT09IHNpZCkpIHtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnbm8gYXBwcm92YWwgcGVuZGluZycsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBwID0gcGVuZGluZztcbiAgICAgICAgcGVuZGluZyA9IG51bGw7XG4gICAgICAgIHAucmVzb2x2ZShib2R5LmdyYW50ZWQgPT09IHRydWUpO1xuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIGdyYW50ZWQ6IGJvZHkuZ3JhbnRlZCA9PT0gdHJ1ZSB9KSk7XG4gICAgICB9KSgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZS5zdGFydHNXaXRoKCcvYXBpL3Nlc3Npb25zLycpICYmICh1cmwucGF0aG5hbWUuZW5kc1dpdGgoJy9hcmNoaXZlJykgfHwgdXJsLnBhdGhuYW1lLmVuZHNXaXRoKCcvZGVsZXRlJykpKSB7XG4gICAgICAvLyBcdTRGMUFcdThCRERcdTVGNTJcdTY4NjMvXHU1MjIwXHU5NjY0KGhtaGFybmVzcyBcdTU0MENcdTVGNjI6XHU3OUZCXHU1MTY1IGFyY2hpdmUvdHJhc2gsXHU1M0VGXHU2MDYyXHU1OTBELFx1NEUwRFx1Nzg2Q1x1NTIyMClcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgcGFydHMgPSB1cmwucGF0aG5hbWUuc2xpY2UoJy9hcGkvc2Vzc2lvbnMvJy5sZW5ndGgpLnNwbGl0KCcvJyk7XG4gICAgICAgIGNvbnN0IG9wID0gcGFydHNbMV0gPz8gJyc7XG4gICAgICAgIGNvbnN0IG9pZCA9IGRlY29kZVVSSUNvbXBvbmVudChwYXJ0c1swXSA/PyAnJykucmVwbGFjZSgvW15hLXpBLVowLTlfOi5ALV0vZywgJycpO1xuICAgICAgICBpZiAob2lkID09PSAnJyB8fCAob3AgIT09ICdhcmNoaXZlJyAmJiBvcCAhPT0gJ2RlbGV0ZScpKSB7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ2JhZCBvcCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIXNlc3Npb25zLmhhcyhvaWQpKSB7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3Nlc3Npb24gbm90IGZvdW5kJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHNlc3Npb25zLmRlbGV0ZShvaWQpO1xuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUgfSkpO1xuICAgICAgfSkoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2luamVjdCcpIHtcbiAgICAgIC8vIFx1OEZEMFx1ODg0Q1x1NEUyRFx1NkNFOFx1NTE2NShcdTRFMEUgaG1oYXJuZXNzIC9hcGkvaW5qZWN0IFx1NTQwQ1x1NUY2MjtmYWtlIFx1NTNFQVx1NTZERVx1NjI2NylcbiAgICAgIHZvaWQgcmVhZEJvZHkoKTtcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUgfSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvaW50ZXJydXB0Jykge1xuICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoJycpIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+OyAvLyBpbnRlcnJ1cHQgXHU2NUUwIGJvZHkgXHU4QkVEXHU0RTQ5XG4gICAgICB2b2lkIGJvZHk7XG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlIH0pKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvc2Vzc2lvbnMnKSB7XG4gICAgICBjb25zdCBsaXN0ID0gWy4uLnNlc3Npb25zLnZhbHVlcygpXS5tYXAoKHMpID0+ICh7XG4gICAgICAgIGlkOiBzLmlkLCB0aXRsZTogJycsIHRhc2s6ICcnLCBvdXRjb21lOiAnb2snLCB0dXJuczogMSwgdG9vbFVzZXM6IDEsXG4gICAgICAgIHRpbWU6IHMudXBkYXRlZEF0LCBjd2Q6ICdDOlxcXFxkZW1vJywgYnJhbmNoOiAnJywgY3JlYXRlZEF0OiBzLmNyZWF0ZWRBdCwgdXBkYXRlZEF0OiBzLnVwZGF0ZWRBdCxcbiAgICAgIH0pKTtcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgc2Vzc2lvbnM6IGxpc3QsIG5leHRDdXJzb3I6IG51bGwgfSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lLnN0YXJ0c1dpdGgoJy9hcGkvc2Vzc2lvbnMvJykpIHtcbiAgICAgIGNvbnN0IHNlZyA9IGRlY29kZVVSSUNvbXBvbmVudCh1cmwucGF0aG5hbWUuc2xpY2UoJy9hcGkvc2Vzc2lvbnMvJy5sZW5ndGgpKTtcbiAgICAgIC8vIFx1NUJGQ1x1NTFGQShcdTRFMEUgaG1oYXJuZXNzIC9hcGkvc2Vzc2lvbnMvOmlkL2V4cG9ydC5tZCBcdTU0MENcdTVGNjI6dGV4dC9tYXJrZG93biBcdTRFMEJcdThGN0QpXG4gICAgICBjb25zdCBleHBvcnRNYXRjaCA9IC9eKC4qKVxcL2V4cG9ydFxcLm1kJC8uZXhlYyhzZWcpID8/IC9eKC4qKVxcLmV4cG9ydFxcLm1kJC8uZXhlYyhzZWcpO1xuICAgICAgaWYgKGV4cG9ydE1hdGNoICE9PSBudWxsICYmIGV4cG9ydE1hdGNoWzFdICE9PSB1bmRlZmluZWQgJiYgZXhwb3J0TWF0Y2hbMV0gIT09ICcnKSB7XG4gICAgICAgIGNvbnN0IGVpZCA9IGV4cG9ydE1hdGNoWzFdLnJlcGxhY2UoL1teYS16QS1aMC05XzouQC1dL2csICcnKTtcbiAgICAgICAgY29uc3QgZXMgPSBzZXNzaW9ucy5nZXQoZWlkKTtcbiAgICAgICAgaWYgKGVzID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnc2Vzc2lvbiBub3QgZm91bmQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICd0ZXh0L21hcmtkb3duOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgcmVzLmVuZChgIyBobWhhcm5lc3MgXHU0RjFBXHU4QkREXHU1QkZDXHU1MUZBKGZha2UpXFxuXFxuLSBcdTRGMUFcdThCREQ6JHtlaWR9XFxuXFxuIyMgXHU3NTI4XHU2MjM3XFxuXFxuXHU0RTRCXHU1MjREXHU3Njg0XHU0RUZCXHU1MkExKGZha2UgXHU5ODg0XHU4OUM4KVxcblxcbiMjIFx1NTJBOVx1NjI0Qlxcblxcblx1OEZEOVx1NjYyRlx1NUJGQ1x1NTFGQVx1NzY4NFx1NTZERVx1NTkwRFx1OTg4NFx1ODlDOChmYWtlKVx1MzAwMlxcbmApO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICAvLyBcdTRGMUFcdThCRERcdTk4ODRcdTg5QzgoXHU0RTBFIGhtaGFybmVzcyBHRVQgL2FwaS9zZXNzaW9ucy86aWQgXHU1NDBDXHU1RjYyOlx1NjcwMFx1NTQwRSA4MCBcdTY3NjEsXHU2QkNGXHU2NzYxIDUwMCBcdTVCNTcpXG4gICAgICBjb25zdCBpZCA9IHNlZy5yZXBsYWNlKC9bXmEtekEtWjAtOV86LkAtXS9nLCAnJyk7XG4gICAgICBjb25zdCBzID0gc2Vzc2lvbnMuZ2V0KGlkKTtcbiAgICAgIGlmIChzID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICdzZXNzaW9uIG5vdCBmb3VuZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIGlkLCBtb2RlbDogJ2Zha2UtbW9kZWwnLCBjd2Q6ICdDOlxcXFxkZW1vJyxcbiAgICAgICAgbWVzc2FnZXM6IFtcbiAgICAgICAgICB7IHJvbGU6ICd1c2VyJywgdGV4dDogJ1x1NEU0Qlx1NTI0RFx1NzY4NFx1NEVGQlx1NTJBMShmYWtlIFx1OTg4NFx1ODlDOCknLCB0b29sczogW10gfSxcbiAgICAgICAgICB7IHJvbGU6ICdhc3Npc3RhbnQnLCB0ZXh0OiAnXHU4RkQ5XHU2NjJGXHU1Mzg2XHU1M0YyXHU0RjFBXHU4QkREXHU3Njg0XHU1NkRFXHU1OTBEXHU5ODg0XHU4OUM4KGZha2UpXHUzMDAyJywgdG9vbHM6IFsncmVhZF9maWxlJ10gfSxcbiAgICAgICAgXSxcbiAgICAgIH0pKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZnMnKSB7XG4gICAgICAvLyBcdTc2RUVcdTVGNTVcdTZENEZcdTg5QzgoXHU0RTBFIGhtaGFybmVzcyBcdTU0MENcdTVGNjI6cGF0aCBcdTc3MDFcdTc1NjU9XHU2ODM5O2ZpbGVzPTEgXHU5NjQ0XHU1RTI2XHU2NTg3XHU0RUY2XHU1MjE3XHU4ODY4KVxuICAgICAgY29uc3QgcSA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KCdwYXRoJykgPz8gJyc7XG4gICAgICBjb25zdCB3aXRoRmlsZXMgPSB1cmwuc2VhcmNoUGFyYW1zLmdldCgnZmlsZXMnKSA9PT0gJzEnO1xuICAgICAgaWYgKHEgPT09ICcnKSB7XG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgIHBhdGg6ICcnLCBzZWdtZW50czogW10sIHBhcmVudDogJycsXG4gICAgICAgICAgZGlyczogW3sgbmFtZTogJ2RlbW8td29ya3NwYWNlJywgcGF0aDogJ0M6XFxcXGRlbW8nIH1dLFxuICAgICAgICAgIC4uLih3aXRoRmlsZXMgPyB7IGZpbGVzOiBbXSB9IDoge30pLFxuICAgICAgICB9KSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgcGF0aDogcSwgc2VnbWVudHM6IFt7IG5hbWU6IHEuc3BsaXQoL1tcXFxcL10vKS5maWx0ZXIoQm9vbGVhbikucG9wKCkgPz8gcSwgcGF0aDogcSB9XSwgcGFyZW50OiAnJyxcbiAgICAgICAgZGlyczogW3sgbmFtZTogJ3NyYycsIHBhdGg6IGAke3EucmVwbGFjZSgvW1xcXFwvXSQvLCAnJyl9XFxcXHNyY2AgfV0sXG4gICAgICAgIC4uLih3aXRoRmlsZXMgPyB7IGZpbGVzOiBbXG4gICAgICAgICAgeyBuYW1lOiAnUkVBRE1FLm1kJywgcGF0aDogYCR7cS5yZXBsYWNlKC9bXFxcXC9dJC8sICcnKX1cXFxcUkVBRE1FLm1kYCwgcmVsOiAnUkVBRE1FLm1kJyB9LFxuICAgICAgICAgIHsgbmFtZTogJ3BhY2thZ2UuanNvbicsIHBhdGg6IGAke3EucmVwbGFjZSgvW1xcXFwvXSQvLCAnJyl9XFxcXHBhY2thZ2UuanNvbmAsIHJlbDogJ3BhY2thZ2UuanNvbicgfSxcbiAgICAgICAgXSB9IDoge30pLFxuICAgICAgfSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9mcy9yZWFkJykge1xuICAgICAgLy8gXHU2NTg3XHU0RUY2XHU5ODg0XHU4OUM4KDY0S0IgXHU0RTBBXHU5NjUwXHU4QkVEXHU0RTQ5O2Zha2UgXHU4RkQ0XHU1NkRFXHU1NkZBXHU1QjlBXHU2NTg3XHU2NzJDKVxuICAgICAgY29uc3QgcCA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KCdwYXRoJykgPz8gJyc7XG4gICAgICBpZiAocCA9PT0gJycpIHtcbiAgICAgICAgcmVzLndyaXRlSGVhZCg0MDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICdwYXRoIHJlcXVpcmVkJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgcGF0aDogcCwgcmVsOiBwLnNwbGl0KC9bXFxcXC9dLykucG9wKCkgPz8gcCwgc2l6ZTogNDIsXG4gICAgICAgIHRleHQ6ICcjIGRlbW8gd29ya3NwYWNlXFxuXFxuXHU4RkQ5XHU2NjJGIGZha2UgaG9zdCBcdTc2ODRcdTY1ODdcdTRFRjZcdTk4ODRcdTg5QzhcdTUxODVcdTVCQjlcdTMwMDJcXG4nLFxuICAgICAgfSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9kaWZmJykge1xuICAgICAgLy8gRGlmZiBcdTk3NjJcdTY3N0YoXHU0RTBFIGhtaGFybmVzcyAvYXBpL2RpZmYgXHU1NDBDXHU1RjYyO2Zha2UgXHU4RkQ0XHU1NkRFXHU1NkZBXHU1QjlBXHU1QzBGXHU1M0Q4XHU2NkY0XHU5NkM2KVxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBnaXQ6IHRydWUsIGN3ZDogJ0M6XFxcXGRlbW8nLFxuICAgICAgICBjaGFuZ2VkOiBbXG4gICAgICAgICAgeyBzdGF0ZTogJ00nLCBwYXRoOiAnc3JjL2FwcC50cycgfSxcbiAgICAgICAgICB7IHN0YXRlOiAnQScsIHBhdGg6ICdkb2NzL25vdGVzLm1kJyB9LFxuICAgICAgICBdLFxuICAgICAgICBzdGF0OiAnIHNyYy9hcHAudHMgICAgICB8IDEyICsrKysrKystLS1cXG4gZG9jcy9ub3Rlcy5tZCAgIHwgIDQgKysrK1xcbiAyIGZpbGVzIGNoYW5nZWQsIDE2IGluc2VydGlvbnMoKyksIDMgZGVsZXRpb25zKC0pJyxcbiAgICAgIH0pKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvd29ya3NwYWNlcycpIHtcbiAgICAgIC8vIFx1NURFNVx1NEY1Q1x1NTMzQShcdTRFMEUgaG1oYXJuZXNzIFx1NTQwQ1x1NUY2MjpjdXJyZW50ICsgaXRlbXMpXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIGN1cnJlbnQ6IGZha2VXb3Jrc3BhY2VzLmN1cnJlbnQsXG4gICAgICAgIGl0ZW1zOiBmYWtlV29ya3NwYWNlcy5pdGVtcyxcbiAgICAgIH0pKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3dvcmtzcGFjZXMnKSB7XG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7IG5hbWU/OiB1bmtub3duOyBwYXRoPzogdW5rbm93biB9O1xuICAgICAgICBjb25zdCBwYXRoID0gdHlwZW9mIGJvZHkucGF0aCA9PT0gJ3N0cmluZycgPyBib2R5LnBhdGggOiAnJztcbiAgICAgICAgY29uc3QgbmFtZSA9IHR5cGVvZiBib2R5Lm5hbWUgPT09ICdzdHJpbmcnICYmIGJvZHkubmFtZSAhPT0gJycgPyBib2R5Lm5hbWUgOiAocGF0aC5zcGxpdCgvW1xcXFwvXS8pLmZpbHRlcihCb29sZWFuKS5wb3AoKSA/PyAnJyk7XG4gICAgICAgIGlmIChwYXRoID09PSAnJyB8fCBuYW1lID09PSAnJykge1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICdhYnNvbHV0ZSBwYXRoIGFuZCBuYW1lIHJlcXVpcmVkJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGlmIChmYWtlV29ya3NwYWNlcy5pdGVtcy5zb21lKCh3KSA9PiB3LnBhdGgudG9Mb3dlckNhc2UoKSA9PT0gcGF0aC50b0xvd2VyQ2FzZSgpKSkge1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA5LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICd3b3Jrc3BhY2UgYWxyZWFkeSByZWdpc3RlcmVkJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGl0ZW0gPSB7IGlkOiBgd3MtJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCA4KX1gLCBuYW1lLCBwYXRoIH07XG4gICAgICAgIGZha2VXb3Jrc3BhY2VzLml0ZW1zLnB1c2goaXRlbSk7XG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgY3VycmVudDogZmFrZVdvcmtzcGFjZXMuY3VycmVudCwgaXRlbXM6IGZha2VXb3Jrc3BhY2VzLml0ZW1zIH0pKTtcbiAgICAgIH0pKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS93b3Jrc3BhY2VzL3VzZScpIHtcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoKGF3YWl0IHJlYWRCb2R5KCkpIHx8ICd7fScpIGFzIHsgaWQ/OiB1bmtub3duIH07XG4gICAgICAgIGNvbnN0IGhpdCA9IGZha2VXb3Jrc3BhY2VzLml0ZW1zLmZpbmQoKHcpID0+IHcuaWQgPT09IGJvZHkuaWQpO1xuICAgICAgICBpZiAoaGl0ID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnd29ya3NwYWNlIG5vdCBmb3VuZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBmYWtlV29ya3NwYWNlcy5jdXJyZW50ID0gaGl0LmlkO1xuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIGN1cnJlbnQ6IGZha2VXb3Jrc3BhY2VzLmN1cnJlbnQsIGl0ZW1zOiBmYWtlV29ya3NwYWNlcy5pdGVtcyB9KSk7XG4gICAgICB9KSgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvcHJvdmlkZXJzJykge1xuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgoYXdhaXQgcmVhZEJvZHkoKSkgfHwgJ3t9JykgYXMgeyBuYW1lPzogdW5rbm93bjsgYmFzZVVybD86IHVua25vd247IG1vZGVsPzogdW5rbm93bjsgYXBpS2V5PzogdW5rbm93biB9O1xuICAgICAgICBjb25zdCBuYW1lID0gdHlwZW9mIGJvZHkubmFtZSA9PT0gJ3N0cmluZycgPyBib2R5Lm5hbWUudHJpbSgpIDogJyc7XG4gICAgICAgIGNvbnN0IGJhc2VVcmwgPSB0eXBlb2YgYm9keS5iYXNlVXJsID09PSAnc3RyaW5nJyA/IGJvZHkuYmFzZVVybC50cmltKCkgOiAnJztcbiAgICAgICAgY29uc3QgbW9kZWwgPSB0eXBlb2YgYm9keS5tb2RlbCA9PT0gJ3N0cmluZycgPyBib2R5Lm1vZGVsLnRyaW0oKSA6ICcnO1xuICAgICAgICBpZiAobmFtZSA9PT0gJycgfHwgYmFzZVVybCA9PT0gJycgfHwgbW9kZWwgPT09ICcnKSB7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ25hbWUsIGJhc2VVcmwgYW5kIG1vZGVsIGFyZSByZXF1aXJlZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBmYWtlUHJvdmlkZXJzLnNldChuYW1lLCB7IGJhc2VVcmwsIG1vZGVsLCBhcGlLZXk6IHR5cGVvZiBib2R5LmFwaUtleSA9PT0gJ3N0cmluZycgPyBib2R5LmFwaUtleSA6ICcnIH0pO1xuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIG5hbWUgfSkpO1xuICAgICAgfSkoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZnMvc2VhcmNoJykge1xuICAgICAgLy8gXHU1REU1XHU0RjVDXHU1MzNBXHU2NTg3XHU0RUY2XHU2NDFDXHU3RDIyKFx1NEUwRSBobWhhcm5lc3MgXHU1NDBDXHU1RjYyOkBcdTk2NDRcdTRFRjZcdTkwMDlcdTYyRTlcdTU2NjhcdTc2ODRcdTY1NzBcdTYzNkVcdTZFOTApXG4gICAgICBjb25zdCBxID0gKHVybC5zZWFyY2hQYXJhbXMuZ2V0KCdxJykgPz8gJycpLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuICAgICAgY29uc3QgYWxsID0gW1xuICAgICAgICB7IHJlbDogJ1JFQURNRS5tZCcsIHBhdGg6ICdDOlxcXFxkZW1vXFxcXFJFQURNRS5tZCcsIGtpbmQ6ICdmaWxlJyB9LFxuICAgICAgICB7IHJlbDogJ3NyYy9hcHAudHMnLCBwYXRoOiAnQzpcXFxcZGVtb1xcXFxzcmNcXFxcYXBwLnRzJywga2luZDogJ2ZpbGUnIH0sXG4gICAgICAgIHsgcmVsOiAnZG9jcy9ub3Rlcy5tZCcsIHBhdGg6ICdDOlxcXFxkZW1vXFxcXGRvY3NcXFxcbm90ZXMubWQnLCBraW5kOiAnZmlsZScgfSxcbiAgICAgIF07XG4gICAgICBjb25zdCBoaXRzID0gcSA9PT0gJycgPyBhbGwgOiBhbGwuZmlsdGVyKChmKSA9PiBmLnJlbC50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHEpKTtcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgcmVzdWx0czogaGl0cy5zbGljZSgwLCAyMCksIHRydW5jYXRlZDogZmFsc2UsIHRvdGFsOiBoaXRzLmxlbmd0aCB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2NvZ25pdGl2ZScpIHtcbiAgICAgIC8vIFx1OEJBNFx1NzdFNVx1NzJCNlx1NjAwMShcdTRFMEUgaG1oYXJuZXNzIGNvZ25pdGl2ZVN0YXR1cyBcdTU0MENcdTVGNjJcdTVCNTBcdTk2QzY7XHU3RjNBXHU2NTcwXHU2MzZFXHU2NjNFXHU1RjBGIG51bGwpXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIG1lbW9yeTogeyBsYXllcnM6IDMsIGVudHJpZXM6IDEyLCBjb250cmFkaWN0aW9uczogMCB9LFxuICAgICAgICB0cmFqZWN0b3JpZXM6IDcsXG4gICAgICAgIGF1ZGl0RXZlbnRzOiAyMSxcbiAgICAgICAgd29ybGRNb2RlbDogeyB2ZXJzaW9uOiA0LCBiZWxpZWZzOiA5LCB0cnVzdGVkOiA1LCBicmllcjogMC4zMSB9LFxuICAgICAgICBjYWxpYnJhdGlvbjogeyBwcmVkaWN0aW9uczogNDYsIHJlbGlhYmlsaXR5OiAwLjcyIH0sXG4gICAgICB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9mYWtlL2VtaXQnKSB7XG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoKGF3YWl0IHJlYWRCb2R5KCkpIHx8ICd7fScpIGFzIHtcbiAgICAgICAgICAgIHNlc3Npb25JZDogc3RyaW5nOyBydW5JZDogc3RyaW5nOyBraW5kOiBFdmVudEtpbmQ7IHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgICAgIH07XG4gICAgICAgICAgY29uc3Qgc2VxID0gZW1pdChib2R5LnNlc3Npb25JZCwgYm9keS5ydW5JZCwgYm9keS5raW5kLCBib2R5LnBheWxvYWQpO1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlLCBzZXEgfSkpO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCBTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgfVxuICAgICAgfSkoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgYG5vIHJvdXRlICR7cmVxLm1ldGhvZH0gJHt1cmwucGF0aG5hbWV9YCwgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gIH0pO1xuXG4gIGF3YWl0IG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICBzZXJ2ZXIub25jZSgnZXJyb3InLCByZWplY3QpO1xuICAgIHNlcnZlci5saXN0ZW4oMCwgJzEyNy4wLjAuMScsICgpID0+IHJlc29sdmUoKSk7XG4gIH0pO1xuICBjb25zdCBhZGRyZXNzID0gc2VydmVyLmFkZHJlc3MoKTtcbiAgaWYgKGFkZHJlc3MgPT09IG51bGwgfHwgdHlwZW9mIGFkZHJlc3MgIT09ICdvYmplY3QnKSB0aHJvdyBuZXcgRXJyb3IoJ2Zha2UgaG9zdDogbm8gcG9ydCcpO1xuICBjb25zdCBwb3J0ID0gYWRkcmVzcy5wb3J0O1xuXG4gIGlmICghb3B0cy5xdWlldCkge1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KHsgaG1oRGVza3RvcEhvc3RSZWFkeTogdHJ1ZSwgcG9ydCwgdmVyc2lvbjogJ2Zha2UtMC4wLjAnIH0pfVxcbmApO1xuICB9XG4gIGNvbnN0IGRpZUFmdGVyID0gTnVtYmVyKHByb2Nlc3MuZW52LkZBS0VfSE9TVF9ESUVfQUZURVJfTVMgPz8gMCk7XG4gIGlmIChOdW1iZXIuaXNGaW5pdGUoZGllQWZ0ZXIpICYmIGRpZUFmdGVyID4gMCkge1xuICAgIHNldFRpbWVvdXQoKCkgPT4gcHJvY2Vzcy5leGl0KDEpLCBkaWVBZnRlcikudW5yZWYoKTtcbiAgfVxuXG4gIC8vIGNsb3NlKCk6IFx1NTE0OFx1NjVBRFx1NUYwMFx1NTE2OFx1OTBFOCBTU0UgXHU4RkRFXHU2M0E1KFx1NUI4M1x1NEVFQ1x1NkMzOFx1NEUwRFx1ODFFQVx1NzEzNlx1NTE3M1x1OTVFRCksXHU1NDI2XHU1MjE5IHNlcnZlci5jbG9zZVxuICAvLyBcdTRGMUFcdTRFMDBcdTc2RjRcdTdCNDlcdTZEM0JcdThEQzNcdThGREVcdTYzQTUsXHU2RDRCXHU4QkQ1XHU4RkRCXHU3QTBCXHU2MzAyXHU2QjdCXHUzMDAyXG4gIGNvbnN0IGNsb3NlID0gKCk6IFByb21pc2U8dm9pZD4gPT5cbiAgICBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4ge1xuICAgICAgZm9yIChjb25zdCBjIG9mIHNzZUNsaWVudHMpIHtcbiAgICAgICAgdHJ5IHsgYy5lbmQoKTsgYy5kZXN0cm95KCk7IH0gY2F0Y2ggeyAvKiBhbHJlYWR5IGdvbmUgKi8gfVxuICAgICAgfVxuICAgICAgc3NlQ2xpZW50cy5jbGVhcigpO1xuICAgICAgc2VydmVyLmNsb3NlKCgpID0+IHJlc29sdmUoKSk7XG4gICAgICBzZXRUaW1lb3V0KCgpID0+IHJlc29sdmUoKSwgMV8wMDApLnVucmVmKCk7XG4gICAgfSk7XG5cbiAgcmV0dXJuIHsgcG9ydCwgZW1pdCwgY2xvc2UgfTtcbn1cblxuLy8gXHU3NkY0XHU2M0E1XHU4RkQwXHU4ODRDKHN1cGVydmlzb3Igc3Bhd24gXHU3Njg0XHU1QjUwXHU4RkRCXHU3QTBCXHU1RjYyXHU2MDAxKVx1MzAwMnJlYWxwYXRoIFx1NkJENFx1OEY4MzpucG0gd29ya3NwYWNlXG4vLyBqdW5jdGlvbiAvIFx1NTkyN1x1NUMwRlx1NTE5OVx1NURFRVx1NUYwMlx1OTBGRFx1NEUwRFx1ODBGRFx1OEJBOVx1OEZEOVx1NEUyQVx1NjhDMFx1NkQ0Qlx1NTkzMVx1NjI0QihcdTU5MzFcdTYyNEI9XHU5NzU5XHU5RUQ4XHU5MDAwXHU1MUZBIGNvZGUgMCxcdTk2QkVcdTY3RTUpXHUzMDAyXG4vLyBjanMgYnVuZGxlKGVzYnVpbGQsXHU2MjUzXHU1MzA1XHU0RUE3XHU1NEMxKVx1NEUwQiBfX2ZpbGVuYW1lIFx1NUI1OFx1NTcyODtFU00odHN4L1x1NkU5MFx1NzgwMSlcdTc1MjggaW1wb3J0Lm1ldGFcdTMwMDJcbmNvbnN0IHNlbGZVcmw6IHN0cmluZyA9IHR5cGVvZiBfX2ZpbGVuYW1lID09PSAnc3RyaW5nJ1xuICA/IHBhdGhUb0ZpbGVVUkwocmVhbHBhdGhTeW5jKF9fZmlsZW5hbWUpKS5ocmVmXG4gIDogaW1wb3J0Lm1ldGEudXJsO1xuY29uc3QgaW52b2tlZEFzU2NyaXB0ID0gKCgpID0+IHtcbiAgaWYgKHByb2Nlc3MuYXJndlsxXSA9PT0gdW5kZWZpbmVkKSByZXR1cm4gZmFsc2U7XG4gIHRyeSB7XG4gICAgcmV0dXJuIHNlbGZVcmwgPT09IHBhdGhUb0ZpbGVVUkwocmVhbHBhdGhTeW5jKHByb2Nlc3MuYXJndlsxXSkpLmhyZWY7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufSkoKTtcbmlmIChpbnZva2VkQXNTY3JpcHQpIHtcbiAgY29uc3QgdG9rZW4gPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9UT0tFTiA/PyAnJztcbiAgLy8gRkFLRV9IT1NUX0RJRV9BVF9CT09UPTE6XHU1RjE1XHU1QkZDXHU4ODRDXHU4RjkzXHU1MUZBXHU1MjREXHU1MzczXHU2QjdCKFx1Njc4NFx1OTAyMFx1NTQyRlx1NTJBOFx1NjcxRiBSVU5USU1FX0NSQVNIRUQpXG4gIGlmIChwcm9jZXNzLmVudi5GQUtFX0hPU1RfRElFX0FUX0JPT1QgPT09ICcxJykge1xuICAgIHByb2Nlc3MuZXhpdCgxKTtcbiAgfVxuICBjb25zdCBzbG93ID0gTnVtYmVyKHByb2Nlc3MuZW52LkZBS0VfSE9TVF9TTE9XX0FGVEVSID8/IDApO1xuICBjb25zdCBib290ID0gKCk6IHZvaWQgPT4ge1xuICAgIHZvaWQgc3RhcnRGYWtlSG9zdCh7IHRva2VuIH0pLmNhdGNoKChlcnIpID0+IHtcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBmYWtlLWhvc3QgZmFpbGVkOiAke1N0cmluZyhlcnIpfVxcbmApO1xuICAgICAgcHJvY2Vzcy5leGl0KDEpO1xuICAgIH0pO1xuICB9O1xuICBpZiAoTnVtYmVyLmlzRmluaXRlKHNsb3cpICYmIHNsb3cgPiAwKSBzZXRUaW1lb3V0KGJvb3QsIHNsb3cpO1xuICBlbHNlIGJvb3QoKTtcbn1cbiIsICIvKipcbiAqIFVJVkVSSUZZIFx1OTRBOVx1NUI1MCBcdTIwMTRcdTIwMTQgXHU5MDEwXHU1MjlGXHU4MEZEXHU3NzFGXHU1QjlFIFVJIFx1OUE3MVx1NTJBOFx1OUE4Q1x1NjUzNigyMDI2LTEwLTEwIFx1NzUyOFx1NjIzN1x1NjMwN1x1NEVFNDpcbiAqIFwiXHU1QkY5XHU2QkNGXHU0RTAwXHU0RTJBXHU1MjlGXHU4MEZELFx1NkJDRlx1NEUwMFx1NEUyQVx1NEUxQVx1NTJBMVx1NkQ0MVx1N0EwQlx1NTE2OFx1OTc2Mlx1NzY4NFx1OUE4Q1x1NjUzNlwiKVx1MzAwMlxuICpcbiAqIFx1NzZGNFx1NjNBNVx1NUJGOVx1NkUzMlx1NjdEM1x1NTQwRVx1NzY4NCBET00gXHU2NUFEXHU4QTAwKFx1NUUwM1x1NUM0MFx1NTFFMFx1NEY1NS9cdTUzRUZcdTg5QzFcdTYwMjcpLFx1NUU3Nlx1NzUyOFx1NTM5Rlx1NzUxRlx1NEU4Qlx1NEVGNlx1OUE3MVx1NTJBOCBSZWFjdFxuICogKFx1NTNEN1x1NjNBN1x1OEY5M1x1NTE2NVx1NzUyOFx1NTM5Rlx1NTc4QiBzZXR0ZXIgKyBpbnB1dCBcdTRFOEJcdTRFRjY7XHU2MzA5XHU5NEFFIGNsaWNrO1x1OTUyRVx1NzZEOFx1OEQ3MCB3aW5kb3dcbiAqIGtleWRvd24pXHUzMDAyZmFrZSBcdTZBMjFcdTVGMEZcdThERDFcdTVCOENcdTY1NzRcdTRFRkJcdTUyQTFcdTk0RkUoXHU1M0QxXHU5MDAxXHUyMTkyXHU1REU1XHU1MTc3XHUyMTkyXHU1QkExXHU2Mjc5XHUyMTkyXHU0RUE0XHU0RUQ4XHU3MjY5XHUyMTkyXHU2QzQ3XHU2MDNCKTtcbiAqIHJlYWwgXHU2QTIxXHU1RjBGXHU1M0VBXHU4REQxXHU1M0VBXHU4QkZCXHU1QjUwXHU5NkM2KFx1NEUwRFx1NTJBOFx1NzcxRlx1NUI5RVx1NEYxQVx1OEJERFx1MzAwMVx1NEUwRFx1NzBFNyB0b2tlbilcdTMwMDJcbiAqIFx1NkJDRlx1NkI2NVx1OEY5M1x1NTFGQSBgVUlWRVJJRlkgUEFTU3xGQUlMIG5hbWUgfCBkZXRhaWxgLFx1N0VEM1x1NUMzRSBTVU1NQVJZLGV4aXQgY29kZVx1MzAwMlxuICovXG5pbXBvcnQgeyBhcHAsIHR5cGUgQnJvd3NlcldpbmRvdyB9IGZyb20gJ2VsZWN0cm9uJztcbmltcG9ydCB7IG1rZGlyLCB3cml0ZUZpbGUgfSBmcm9tICdub2RlOmZzL3Byb21pc2VzJztcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdub2RlOnBhdGgnO1xuXG5jb25zdCBzbGVlcCA9IChtczogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiA9PiBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCBtcykpO1xuXG5hc3luYyBmdW5jdGlvbiBydW5VaVZlcmlmeSh3aW46IEJyb3dzZXJXaW5kb3csIG1vZGU6ICdmYWtlJyB8ICdyZWFsJyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBzaG90cyA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX1NIT1RTID8/IGpvaW4oYXBwLmdldFBhdGgoJ3RlbXAnKSwgJ2htaC11aXZlcmlmeScpO1xuICBhd2FpdCBta2RpcihzaG90cywgeyByZWN1cnNpdmU6IHRydWUgfSkuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcbiAgY29uc3QgcmVzdWx0czogQXJyYXk8W3N0cmluZywgYm9vbGVhbiwgc3RyaW5nXT4gPSBbXTtcbiAgbGV0IHNob3RJZHggPSAwO1xuXG4gIGNvbnN0IGpzID0gPFQ+KGNvZGU6IHN0cmluZyk6IFByb21pc2U8VD4gPT4gd2luLndlYkNvbnRlbnRzLmV4ZWN1dGVKYXZhU2NyaXB0KGNvZGUsIHRydWUpIGFzIFByb21pc2U8VD47XG4gIGNvbnN0IHN0ZXAgPSBhc3luYyAobmFtZTogc3RyaW5nLCBmbjogKCkgPT4gUHJvbWlzZTxbYm9vbGVhbiwgc3RyaW5nXT4pOiBQcm9taXNlPHZvaWQ+ID0+IHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgW29rLCBkZXRhaWxdID0gYXdhaXQgZm4oKTtcbiAgICAgIHJlc3VsdHMucHVzaChbbmFtZSwgb2ssIGRldGFpbF0pO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgY29uc3QgZGV0YWlsID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgJiYgZXJyLnN0YWNrICE9PSB1bmRlZmluZWQgPyBlcnIuc3RhY2sgOiBTdHJpbmcoZXJyKTtcbiAgICAgIHJlc3VsdHMucHVzaChbbmFtZSwgZmFsc2UsIGRldGFpbC5zbGljZSgwLCAzMDApXSk7XG4gICAgfVxuICAgIGNvbnN0IGxhc3QgPSByZXN1bHRzW3Jlc3VsdHMubGVuZ3RoIC0gMV0hO1xuICAgIGNvbnNvbGUubG9nKGBVSVZFUklGWSAke2xhc3RbMV0gPyAnUEFTUycgOiAnRkFJTCd9IHwgJHtsYXN0WzBdfSB8ICR7bGFzdFsyXX1gKTtcbiAgfTtcbiAgLyoqIFx1OEY2RVx1OEJFMlx1NzZGNFx1NTIzMCBwcmVkaWNhdGVDb2RlIFx1OEZENFx1NTZERSB7b2s6dHJ1ZSwuLi59IFx1NjIxNlx1OEQ4NVx1NjVGNihcdThGRDRcdTU2REVcdTY3MDBcdTU0MEVcdTc2ODQgZGV0YWlsKVx1MzAwMiAqL1xuICBjb25zdCB3YWl0Rm9yID0gYXN5bmMgKGxhYmVsOiBzdHJpbmcsIHByZWRpY2F0ZUNvZGU6IHN0cmluZywgdGltZW91dE1zOiBudW1iZXIpOiBQcm9taXNlPFtib29sZWFuLCBzdHJpbmddPiA9PiB7XG4gICAgY29uc3Qgc3RhcnRlZCA9IERhdGUubm93KCk7XG4gICAgZm9yICg7Oykge1xuICAgICAgY29uc3QgciA9IChhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHRyeSB7IHJldHVybiBKU09OLnN0cmluZ2lmeSgoZnVuY3Rpb24oKXsgJHtwcmVkaWNhdGVDb2RlfSB9KSgpKTsgfSBjYXRjaChlKXsgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHtvazpmYWxzZSwgZGV0YWlsOlN0cmluZyhlKS5zbGljZSgwLDEyMCl9KTsgfSB9KSgpYCkpIGFzIHN0cmluZztcbiAgICAgIGxldCBwYXJzZWQ6IHsgb2s/OiBib29sZWFuOyBkZXRhaWw/OiBzdHJpbmcgfTtcbiAgICAgIHRyeSB7IHBhcnNlZCA9IEpTT04ucGFyc2UocikgYXMgeyBvaz86IGJvb2xlYW47IGRldGFpbD86IHN0cmluZyB9OyB9IGNhdGNoIHsgcGFyc2VkID0geyBvazogZmFsc2UsIGRldGFpbDogU3RyaW5nKHIpLnNsaWNlKDAsIDEyMCkgfTsgfVxuICAgICAgaWYgKHBhcnNlZC5vayA9PT0gdHJ1ZSkgcmV0dXJuIFt0cnVlLCBTdHJpbmcocGFyc2VkLmRldGFpbCA/PyAnJyldO1xuICAgICAgaWYgKERhdGUubm93KCkgLSBzdGFydGVkID4gdGltZW91dE1zKSByZXR1cm4gW2ZhbHNlLCBgJHtsYWJlbH06ICR7U3RyaW5nKHBhcnNlZC5kZXRhaWwgPz8gJ3RpbWVvdXQnKX1gXTtcbiAgICAgIGF3YWl0IHNsZWVwKDI1MCk7XG4gICAgfVxuICB9O1xuICBjb25zdCBzaG90ID0gYXN5bmMgKGxhYmVsOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+ID0+IHtcbiAgICBzaG90SWR4ICs9IDE7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGltZyA9IGF3YWl0IHdpbi53ZWJDb250ZW50cy5jYXB0dXJlUGFnZSgpO1xuICAgICAgYXdhaXQgd3JpdGVGaWxlKGpvaW4oc2hvdHMsIGAke21vZGV9LSR7U3RyaW5nKHNob3RJZHgpLnBhZFN0YXJ0KDIsICcwJyl9LSR7bGFiZWx9LnBuZ2ApLCBpbWcudG9QTkcoKSk7XG4gICAgfSBjYXRjaCB7IC8qIFx1NjIyQVx1NTZGRVx1NTkzMVx1OEQyNVx1NEUwRFx1NTIyNFx1NkI3QiAqLyB9XG4gIH07XG5cbiAgLyogLS0tLSBcdTUzRDdcdTYzQTdcdThGOTNcdTUxNjUoUmVhY3Q6XHU1MzlGXHU1NzhCIHNldHRlciBcdTg5RTZcdTUzRDEgb25DaGFuZ2UpIC0tLS0gKi9cbiAgY29uc3QgdHlwZUludG8gPSAoc2VsOiBzdHJpbmcsIHRleHQ6IHN0cmluZyk6IFByb21pc2U8dW5rbm93bj4gPT5cbiAgICBqcyhgKGZ1bmN0aW9uKCl7XG4gICAgICB2YXIgZWwgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCR7SlNPTi5zdHJpbmdpZnkoc2VsKX0pO1xuICAgICAgaWYgKCFlbCkgcmV0dXJuICdOT0VMJztcbiAgICAgIHZhciBwcm90byA9IGVsLnRhZ05hbWUgPT09ICdURVhUQVJFQScgPyBIVE1MVGV4dEFyZWFFbGVtZW50LnByb3RvdHlwZSA6IEhUTUxJbnB1dEVsZW1lbnQucHJvdG90eXBlO1xuICAgICAgT2JqZWN0LmdldE93blByb3BlcnR5RGVzY3JpcHRvcihwcm90bywgJ3ZhbHVlJykuc2V0LmNhbGwoZWwsICR7SlNPTi5zdHJpbmdpZnkodGV4dCl9KTtcbiAgICAgIGVsLmRpc3BhdGNoRXZlbnQobmV3IEV2ZW50KCdpbnB1dCcsIHsgYnViYmxlczogdHJ1ZSB9KSk7XG4gICAgICByZXR1cm4gJ09LJztcbiAgICB9KSgpYCk7XG5cbiAgLyogLS0tLSBcdTU0MkZcdTUyQThcdTdCNDlcdTVGODU6UmVhY3QgXHU2MzAyXHU4RjdEICsgaG9zdCBcdTdFRkZcdTcwQjkocmVhbCBcdTc2ODQgaG1oYXJuZXNzIFx1NTFCN1x1NTQyRlx1NTJBOFx1ODk4MVx1N0YxNlx1OEJEMVxuICAgICBcdTY1NzRcdTU5NTcgQ0xJIFx1NEY5RFx1OEQ1NixcdTUzRUZcdTUyMzAgMzBzKztcdTRFMERcdTdCNDlcdTdFRkZcdTcwQjlcdTVDMzFcdTVGMDBcdThERDFcdTRGMUFcdTUxNjhcdTkwRThcdThEODVcdTY1RjZcdThCRUZcdTYyQTUpIC0tLS0gKi9cbiAgYXdhaXQgd2FpdEZvcignaG9zdCByZWFkeScsIGB2YXIgdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY29tcG9zZXIgdGV4dGFyZWEnKTsgcmV0dXJuIHtvazogISF0LCBkZXRhaWw6IHQgPyAnbW91bnRlZCcgOiAnbm8gY29tcG9zZXInfTtgLCAyMF8wMDApO1xuICBhd2FpdCB3YWl0Rm9yKCdob3N0IGRvdCBvbicsIGB2YXIgZD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuaG9zdC1kb3QnKTsgcmV0dXJuIHtvazogISFkICYmIGQuY2xhc3NMaXN0LmNvbnRhaW5zKCdvbicpLCBkZXRhaWw6IGQgPyBkLmNsYXNzTmFtZSA6ICdubyBkb3QnfTtgLCBtb2RlID09PSAncmVhbCcgPyA2MF8wMDAgOiAyMF8wMDApO1xuICBhd2FpdCBzbGVlcCgxXzIwMCk7IC8vIFx1NEYxQVx1OEJERFx1NTIxN1x1ODg2OC9cdTk4NzZcdTY4MEZcdTY1NzBcdTYzNkVcdTg0M0RcdTU3MzBcblxuICAvKiA9PT09PT09PT09IFx1OTAxQVx1NzUyODpcdTVFMDNcdTVDNDBcdTUxRTBcdTRGNTUoXHU3NTI4XHU2MjM3XHU2MkE1XHU5NjlDXHU3Njg0XHU3NkY0XHU2M0E1XHU2NUFEXHU4QTAwKSA9PT09PT09PT09ICovXG4gIGF3YWl0IHN0ZXAoJ1x1NUUwM1x1NUM0MDpcdTY4MDdcdTk4OThcdTY4MEYrXHU0RTA5XHU2ODBGK2NvbXBvc2VyIFx1NTcyOFx1ODlDNlx1NTNFM1x1NTE4NShcdThGOTNcdTUxNjVcdTY4NDZcdTUzRUZcdTg5QzEpJywgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHIgPSAoYXdhaXQganMoYChmdW5jdGlvbigpe1xuICAgICAgdmFyIHEgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yLmJpbmQoZG9jdW1lbnQpO1xuICAgICAgdmFyIHRiID0gcSgnLnRpdGxlYmFyJyksIHNoZWxsID0gcSgnLmFwcC1zaGVsbCcpLCBzYiA9IHEoJy5zaWRlYmFyJyksIHdzID0gcSgnLndvcmtzcGFjZScpLCB0YSA9IHEoJy5jb21wb3NlciB0ZXh0YXJlYScpO1xuICAgICAgdmFyIG1pc3NpbmcgPSBbIXRiICYmICd0aXRsZWJhcicsICFzaGVsbCAmJiAnc2hlbGwnLCAhc2IgJiYgJ3NpZGViYXInLCAhd3MgJiYgJ3dvcmtzcGFjZScsICF0YSAmJiAndGV4dGFyZWEnXS5maWx0ZXIoQm9vbGVhbikuam9pbignLCcpO1xuICAgICAgaWYgKG1pc3NpbmcgIT09ICcnKSByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe29rOmZhbHNlLCBkZXRhaWw6J21pc3Npbmc6JyttaXNzaW5nfSk7XG4gICAgICB2YXIgciA9IHRhLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpLCB2aCA9IHdpbmRvdy5pbm5lckhlaWdodCwgdncgPSB3aW5kb3cuaW5uZXJXaWR0aDtcbiAgICAgIHZhciBoaW50ID0gcSgnLmVtcHR5LWhpbnQuYmlnJyk7IHZhciBociA9IGhpbnQgPyBoaW50LmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpIDogbnVsbDtcbiAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh7IG9rOiByLmhlaWdodCA+IDMwICYmIHIuYm90dG9tIDw9IHZoICYmIHIud2lkdGggPiAxMDAgJiYgaHIgIT09IG51bGwgJiYgaHIudG9wID49IDAgJiYgaHIuYm90dG9tIDw9IHZoLFxuICAgICAgICBkZXRhaWw6ICd0ZXh0YXJlYSB5PScrTWF0aC5yb3VuZChyLnkpKycgaD0nK01hdGgucm91bmQoci5oZWlnaHQpKycgYm90dG9tPScrTWF0aC5yb3VuZChyLmJvdHRvbSkrJyB2aD0nK3ZoKyhociA/ICcgaGludCB5PScrTWF0aC5yb3VuZChoci55KSA6ICcgbm8taGludCcpIH0pO1xuICAgIH0pKClgKSkgYXMgc3RyaW5nO1xuICAgIGNvbnN0IHAgPSBKU09OLnBhcnNlKHIpIGFzIHsgb2s6IGJvb2xlYW47IGRldGFpbDogc3RyaW5nIH07XG4gICAgcmV0dXJuIFtwLm9rID09PSB0cnVlLCBwLmRldGFpbF07XG4gIH0pO1xuXG4gIGlmIChtb2RlID09PSAnZmFrZScpIHtcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU5OTk2XHU4REQxXHU1RjE1XHU1QkZDXHU1QzQyID09PT09PT09PT0gKi9cbiAgICBhd2FpdCBzdGVwKCdcdTVGMTVcdTVCRkNcdTVDNDI6XHU2RjE0XHU3OTNBXHU2QTIxXHU1RjBGXHU2M0QwXHU3OTNBXHU1MUZBXHU3M0IwXHU1RTc2XHU1M0VGXHU1MTczXHU5NUVEJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2d1aWRlJywgYHZhciBnPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ydW50aW1lLWd1aWRlJyk7IHJldHVybiB7b2s6ICEhZywgZGV0YWlsOiBnID8gJ3Nob3duJyA6ICdub3Qgc2hvd24nfTtgLCA4XzAwMCk7XG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpe1xuICAgICAgICB2YXIgYnRucyA9IFtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnJ1bnRpbWUtZ3VpZGUgYnV0dG9uJykpO1xuICAgICAgICB2YXIgYiA9IGJ0bnMuZmluZChmdW5jdGlvbih4KXsgcmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU2RjE0XHU3OTNBJykgPj0gMDsgfSk7XG4gICAgICAgIGlmIChiKSBiLmNsaWNrKCk7XG4gICAgICB9KSgpYCk7XG4gICAgICByZXR1cm4gd2FpdEZvcignZ3VpZGUgZ29uZScsIGByZXR1cm4ge29rOiAhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnJ1bnRpbWUtZ3VpZGUnKSwgZGV0YWlsOiBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcucnVudGltZS1ndWlkZScpID8gJ3N0aWxsJyA6ICdkaXNtaXNzZWQnfTtgLCA1XzAwMCk7XG4gICAgfSk7XG5cbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREKEN0cmwrTikgPT09PT09PT09PSAqL1xuICAgIGF3YWl0IHN0ZXAoJ0N0cmwrTiBcdTY1QjBcdTVFRkFcdTRGMUFcdThCREQsXHU4RjkzXHU1MTY1XHU2ODQ2XHU1M0VGXHU3NTI4JywgYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleTonbicsIGN0cmxLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XG4gICAgICByZXR1cm4gd2FpdEZvcigndGV4dGFyZWEgZW5hYmxlZCcsIGB2YXIgdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY29tcG9zZXIgdGV4dGFyZWEnKTtcbiAgICAgICAgcmV0dXJuIHtvazogISF0ICYmIHQuZGlzYWJsZWQgPT09IGZhbHNlICYmICh0LnBsYWNlaG9sZGVyfHwnJykuaW5kZXhPZignXHU2M0NGXHU4RkYwXHU3NkVFXHU2ODA3JykgPj0gMCwgZGV0YWlsOiB0ID8gKCdkaXNhYmxlZD0nK3QuZGlzYWJsZWQrJyBwaD0nKyh0LnBsYWNlaG9sZGVyfHwnJykuc2xpY2UoMCwyMCkpIDogJ25vIHRhJ307YCwgNV8wMDApO1xuICAgIH0pO1xuXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NTNEMVx1OTAwMVx1NEVGQlx1NTJBMSBcdTIxOTIgXHU3NTI4XHU2MjM3XHU4RjZFXHU1MUZBXHU3M0IwKFx1NEUxNFx1NEVDNVx1NEUwMFx1Njc2MSxcdTUzQ0NcdTZEODhcdTYwNkZcdTU2REVcdTVGNTIpID09PT09PT09PT0gKi9cbiAgICBhd2FpdCBzdGVwKCdcdThGOTNcdTUxNjVcdTVFNzZcdTUzRDFcdTkwMDFcdTRFRkJcdTUyQTEsXHU3NTI4XHU2MjM3XHU2RDg4XHU2MDZGXHU0RTBBXHU1QzRGXHU0RTE0XHU0RTBEXHU5MUNEXHU1OTBEJywgYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQgdHlwZUludG8oJy5jb21wb3NlciB0ZXh0YXJlYScsICdcdTlBOENcdTY1MzZcdTRFRkJcdTUyQTE6XHU1MTk5XHU1MTY1XHU0RTAwXHU0RTJBXHU2NTg3XHU0RUY2Jyk7XG4gICAgICBhd2FpdCBzbGVlcCgyMDApO1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpe1xuICAgICAgICB2YXIgYnRucyA9IFtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNvbXBvc2VyIGJ1dHRvbicpKTtcbiAgICAgICAgdmFyIGIgPSBidG5zLmZpbmQoZnVuY3Rpb24oeCl7IHJldHVybiB4LnRleHRDb250ZW50LnRyaW0oKSA9PT0gJ1x1NTNEMVx1OTAwMSc7IH0pO1xuICAgICAgICBpZiAoYikgYi5jbGljaygpO1xuICAgICAgfSkoKWApO1xuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2V4YWN0bHkgb25lIHVzZXIgdHVybicsIGB2YXIgdHM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudHVybi51c2VyJykpLmZpbHRlcihmdW5jdGlvbih4KXsgcmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU5QThDXHU2NTM2XHU0RUZCXHU1MkExJykgPj0gMDsgfSk7XG4gICAgICAgIHJldHVybiB7b2s6IHRzLmxlbmd0aCA9PT0gMSwgZGV0YWlsOiAnY291bnQ9Jyt0cy5sZW5ndGgrJyB0ZXh0PScrKHRzWzBdP3RzWzBdLnRleHRDb250ZW50LnNsaWNlKDAsMzApOidub25lJyl9O2AsIDhfMDAwKTtcbiAgICB9KTtcblxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTVERTVcdTUxNzdcdTUzNjEocmVhZF9maWxlIFx1NUI4Q1x1NjIxMCkgPT09PT09PT09PSAqL1xuICAgIGF3YWl0IHN0ZXAoJ1x1NURFNVx1NTE3N1x1NjI5OFx1NTNFMFx1NTM2MTpyZWFkX2ZpbGUgXHU2MjY3XHU4ODRDXHU1RTc2XHU1QjhDXHU2MjEwJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3Rvb2wgY2FyZCcsIGB2YXIgYz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50b29sLWNhcmQnKSk7XG4gICAgICAgIHZhciBkb25lID0gYy5maWx0ZXIoZnVuY3Rpb24oeCl7IHJldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ3JlYWRfZmlsZScpID49IDAgJiYgeC50ZXh0Q29udGVudC5pbmRleE9mKCcjIGRlbW8nKSA+PSAwOyB9KTtcbiAgICAgICAgcmV0dXJuIHtvazogZG9uZS5sZW5ndGggPj0gMSwgZGV0YWlsOiAnY2FyZHM9JytjLmxlbmd0aCsnIGRvbmU9Jytkb25lLmxlbmd0aH07YCwgOF8wMDApO1xuICAgICAgcmV0dXJuIHc7XG4gICAgfSk7XG5cbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU1QkExXHU2Mjc5XHU3RUI1XHU1MjA3XHU3MjQ3KFx1NzUyOFx1NjIzN1x1NjJBNVx1OTY5Q1x1NjgzOFx1NUZDM1x1NEU0Qlx1NEUwMCkgPT09PT09PT09PSAqL1xuICAgIGF3YWl0IHN0ZXAoJ1x1NUJBMVx1NjI3OTphcHByb3ZhbCBcdTUzNjFcdTUxRkFcdTczQjAoXHU3QjQ5XHU1Rjg1XHU0RUJBXHU1REU1XHU2Mjc5XHU1MUM2KScsIGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IHNob3QoJ2FwcHJvdmFsLXBlbmRpbmcnKTtcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdhcHByb3ZhbCBjYXJkJywgYHZhciBhPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5hcHByb3ZhbC1jYXJkJyk7XG4gICAgICAgIHJldHVybiB7b2s6ICEhYSAmJiBhLnRleHRDb250ZW50LmluZGV4T2YoJ1x1OTcwMFx1ODk4MVx1NUJBMVx1NjI3OScpID49IDAsIGRldGFpbDogYSA/IGEudGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLCA2MCkgOiAnbm8gYXBwcm92YWwgY2FyZCd9O2AsIDhfMDAwKTtcbiAgICB9KTtcbiAgICBhd2FpdCBzdGVwKCdcdTVCQTFcdTYyNzk6XHU3MEI5XHU2Mjc5XHU1MUM2IFx1MjE5MiBcdTRFRkJcdTUyQTFcdTdFRTdcdTdFRURcdTUyMzBcdTRFQTRcdTRFRDhcdTcyNjkrXHU2QzQ3XHU2MDNCJywgYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpe1xuICAgICAgICB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5hcHByb3ZhbC1jYXJkIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpeyByZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU2Mjc5XHU1MUM2JzsgfSk7XG4gICAgICAgIGlmIChiKSBiLmNsaWNrKCk7XG4gICAgICB9KSgpYCk7XG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignYXJ0aWZhY3Qrc3VtJywgYHZhciBhcnQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmFydGlmYWN0LWNhcmQnKTtcbiAgICAgICAgdmFyIHN1bT1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudHVybi1zdW0nKTtcbiAgICAgICAgdmFyIGFzdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50dXJuJykpLmZpbHRlcihmdW5jdGlvbih4KXsgcmV0dXJuIHguY2xhc3NOYW1lLmluZGV4T2YoJ3VzZXInKTwwICYmIHgudGV4dENvbnRlbnQuaW5kZXhPZignZWNobzonKT49MDsgfSk7XG4gICAgICAgIHJldHVybiB7b2s6ICEhYXJ0ICYmICEhc3VtICYmIGFzdC5sZW5ndGg+PTEsIGRldGFpbDogJ2FydGlmYWN0PScrKGFydD9hcnQudGV4dENvbnRlbnQuc2xpY2UoMCwzMCk6J25vbmUnKSsnIHN1bT0nKyhzdW0/c3VtLnRleHRDb250ZW50Oidub25lJykrJyBhbnN3ZXJlZD0nK2FzdC5sZW5ndGh9O2AsIDEyXzAwMCk7XG4gICAgICBhd2FpdCBzaG90KCdydW4tY29tcGxldGVkJyk7XG4gICAgICByZXR1cm4gdztcbiAgICB9KTtcblxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTUzODZcdTUzRjJcdTRGMUFcdThCRERcdTUxODVcdTVCQjkoXHU3NTI4XHU2MjM3XHU2MkE1XHU5NjlDXCJcdTc3MEJcdTRFMERcdTUyMzBcdTUxODVcdTVCQjlcIikgPT09PT09PT09PSAqL1xuICAgIGF3YWl0IHN0ZXAoJ1x1NzBCOVx1NTFGQlx1NTM4Nlx1NTNGMlx1NEYxQVx1OEJERCBcdTIxOTIgdHJhbnNjcmlwdCBcdTUxODVcdTVCQjlcdTUzRUZcdTg5QzEnLCBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBpdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2Vzc2lvbi1pdGVtJyk7IGlmIChpdCkgaXQuY2xpY2soKTsgfSkoKWApO1xuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2hpc3RvcnkgdHVybnMnLCBgdmFyIHRzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnR1cm4nKSk7XG4gICAgICAgIHJldHVybiB7b2s6IHRzLmxlbmd0aCA+PSAyLCBkZXRhaWw6ICd0dXJucz0nK3RzLmxlbmd0aCsnIGZpcnN0PScrKHRzWzBdP3RzWzBdLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw0MCk6J25vbmUnKX07YCwgOF8wMDApO1xuICAgIH0pO1xuXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NEU5NFx1OTg3NVx1N0I3RSA9PT09PT09PT09ICovXG4gICAgYXdhaXQgc3RlcCgnRG9jazpPdmVydmlldyBcdTY1NzBcdTYzNkVcdTg4NEMnLCBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nT3ZlcnZpZXcnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdvdmVydmlldyByb3dzJywgYHZhciByb3dzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stcm93JykpO1xuICAgICAgICB2YXIgdmVyID0gcm93cy5maW5kKGZ1bmN0aW9uKHIpeyByZXR1cm4gci50ZXh0Q29udGVudC5pbmRleE9mKCdydW50aW1lIFx1NzI0OFx1NjcyQycpPj0wOyB9KTtcbiAgICAgICAgcmV0dXJuIHtvazogcm93cy5sZW5ndGggPj0gNSAmJiAhIXZlciwgZGV0YWlsOiAncm93cz0nK3Jvd3MubGVuZ3RoKyh2ZXI/JyB2ZXI9Jyt2ZXIudGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDQwKTonJyl9O2AsIDZfMDAwKTtcbiAgICB9KTtcbiAgICBhd2FpdCBzdGVwKCdEb2NrOkZpbGVzIFx1NkQ0Rlx1ODlDOCtcdTY1ODdcdTRFRjZcdTk4ODRcdTg5QzgnLCBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nXHU2NTg3XHU0RUY2J3x8eC50ZXh0Q29udGVudD09PSdGaWxlcyc7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2ZzIHJvd3MnLCBgdmFyIHJvd3M9ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmZzLXJvdycpLmxlbmd0aDtcbiAgICAgICAgcmV0dXJuIHtvazogcm93cyA+PSAxLCBkZXRhaWw6ICdyb3dzPScrcm93c307YCwgNl8wMDApO1xuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcbiAgICAgIC8vIFx1NjgzOVx1NzZFRVx1NUY1NVx1NTNFQVx1NjcwOVx1NURFNVx1NEY1Q1x1NTMzQVx1NzZFRVx1NUY1NShmYWtlIFx1NEUwRVx1NzcxRlx1NUI5RSBydW50aW1lIFx1NTQwQ1x1NUY2Mik6XHU1MTQ4XHU4RkRCXHU3NkVFXHU1RjU1LFx1NTE4RFx1NzBCOVx1NjU4N1x1NEVGNlxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgZD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5mcy1yb3cnKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdkZW1vLXdvcmtzcGFjZScpPj0wIHx8IHgudGV4dENvbnRlbnQuaW5kZXhPZignXHVEODNEXHVEQ0MxJyk+PTA7fSk7IGlmKGQpIGQuY2xpY2soKTsgfSkoKWApO1xuICAgICAgY29uc3QgdzIgPSBhd2FpdCB3YWl0Rm9yKCdmaWxlIHJvd3MnLCBgdmFyIHJvd3M9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZnMtcm93JykpO1xuICAgICAgICByZXR1cm4ge29rOiByb3dzLnNvbWUoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignUkVBRE1FJyk+PTA7fSksIGRldGFpbDogJ3Jvd3M9Jytyb3dzLmxlbmd0aH07YCwgNl8wMDApO1xuICAgICAgaWYgKCF3MlswXSkgcmV0dXJuIHcyO1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgZj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5mcy1yb3cnKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdSRUFETUUnKT49MDt9KTsgaWYoZikgZi5jbGljaygpOyB9KSgpYCk7XG4gICAgICByZXR1cm4gd2FpdEZvcignZmlsZSBwcmV2aWV3JywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5mcy1wcmV2aWV3Jyk7XG4gICAgICAgIHJldHVybiB7b2s6ICEhcCAmJiBwLnRleHRDb250ZW50LmluZGV4T2YoJ2RlbW8gd29ya3NwYWNlJykgPj0gMCwgZGV0YWlsOiBwID8gcC50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNDApIDogJ25vIHByZXZpZXcnfTtgLCA2XzAwMCk7XG4gICAgfSk7XG4gICAgYXdhaXQgc3RlcCgnRG9jazpEaWZmIFx1NTNEOFx1NjZGNFx1ODg0QycsIGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdcdTUzRDhcdTY2RjQnfHx4LnRleHRDb250ZW50PT09J0RpZmYnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdkaWZmIHJvd3MnLCBgdmFyIHJvd3M9ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRpZmYtcm93JykubGVuZ3RoO1xuICAgICAgICByZXR1cm4ge29rOiByb3dzID49IDEsIGRldGFpbDogJ2RpZmYgcm93cz0nK3Jvd3N9O2AsIDZfMDAwKTtcbiAgICB9KTtcbiAgICBhd2FpdCBzdGVwKCdEb2NrOkV2aWRlbmNlIFx1OEJBNFx1NzdFNVx1NjU3MFx1NjM2RScsIGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdcdThCQzFcdTYzNkUnfHx4LnRleHRDb250ZW50PT09J0V2aWRlbmNlJzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XG4gICAgICByZXR1cm4gd2FpdEZvcignZXZpZGVuY2Ugcm93cycsIGB2YXIgcm93cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXJvdycpKTtcbiAgICAgICAgdmFyIG1lbSA9IHJvd3MuZmluZChmdW5jdGlvbihyKXsgcmV0dXJuIHIudGV4dENvbnRlbnQuaW5kZXhPZignXHU4QkIwXHU1RkM2XHU1QzQyJyk+PTAgfHwgci50ZXh0Q29udGVudC5pbmRleE9mKCdNZW1vcnkgbGF5ZXJzJyk+PTA7IH0pO1xuICAgICAgICByZXR1cm4ge29rOiAhIW1lbSAmJiBtZW0udGV4dENvbnRlbnQuaW5kZXhPZignMycpID49IDAsIGRldGFpbDogbWVtID8gbWVtLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykgOiAnbm8gbWVtb3J5IHJvdyd9O2AsIDZfMDAwKTtcbiAgICB9KTtcbiAgICBhd2FpdCBzdGVwKCdEb2NrOkxvZ3MgXHU5NzYyXHU2NzdGKFx1N0E3QVx1NjAwMVx1NjNEMFx1NzkzQSknLCBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nXHU2NUU1XHU1RkQ3J3x8eC50ZXh0Q29udGVudD09PSdMb2dzJzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignbG9ncyBwYW5lJywgYHZhciBsPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5sb2dzLWxpc3QnKTtcbiAgICAgICAgcmV0dXJuIHtvazogISFsLCBkZXRhaWw6IGwgPyAoJ3Jvd3M9JytsLnF1ZXJ5U2VsZWN0b3JBbGwoJy5sb2ctcm93JykubGVuZ3RoKSA6ICdubyBsb2dzIGxpc3QnfTtgLCA1XzAwMCk7XG4gICAgICByZXR1cm4gdztcbiAgICB9KTtcblxuICAgIC8qID09PT09PT09PT0gZmFrZTpEb2NrOlx1OEZEQ1x1N0EwQlx1OTg3NVx1N0I3RShcdTYyNEJcdTY3M0FcdThGRENcdTdBMEJcdTYzQTdcdTUyMzZcdTk3NjJcdTY3N0YpID09PT09PT09PT0gKi9cbiAgICBhd2FpdCBzdGVwKCdEb2NrOlx1OEZEQ1x1N0EwQlx1OTg3NVx1N0I3RShcdTYyNEJcdTY3M0FcdThGRENcdTdBMEJcdTYzQTdcdTUyMzZcdTk3NjJcdTY3N0YpJywgYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J1x1OEZEQ1x1N0EwQid8fHgudGV4dENvbnRlbnQ9PT0nUmVtb3RlJzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XG4gICAgICByZXR1cm4gd2FpdEZvcigncmVtb3RlIHBhbmUnLCBgdmFyIHA9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmRvY2stYm9keScpO1xuICAgICAgICB2YXIgdCA9IHAgPyBwLnRleHRDb250ZW50IDogJyc7XG4gICAgICAgIHJldHVybiB7b2s6ICEhcCAmJiAodC5pbmRleE9mKCdcdTYyNEJcdTY3M0FcdThGRENcdTdBMEJcdTYzQTdcdTUyMzYnKT49MCB8fCB0LmluZGV4T2YoJ1Bob25lIHJlbW90ZScpPj0wKSwgZGV0YWlsOiB0LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw1MCl9O2AsIDZfMDAwKTtcbiAgICB9KTtcblxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTY0MUNcdTdEMjJcdThGQzdcdTZFRTQgPT09PT09PT09PSAqL1xuICAgIGF3YWl0IHN0ZXAoJ1x1NEYxQVx1OEJERFx1NjQxQ1x1N0QyMjpcdThGQzdcdTZFRTRcdTc1MUZcdTY1NDgnLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBiZWZvcmUgPSAoYXdhaXQganMoYGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGhgKSkgYXMgbnVtYmVyO1xuICAgICAgYXdhaXQgdHlwZUludG8oJy5zZXNzaW9uLXNlYXJjaCcsICd6enotXHU0RTBEXHU1QjU4XHU1NzI4XHU3Njg0XHU0RjFBXHU4QkREJyk7XG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignZmlsdGVyZWQgZW1wdHknLCBgdmFyIG49ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aDtcbiAgICAgICAgcmV0dXJuIHtvazogbiA9PT0gMCwgZGV0YWlsOiAnYWZ0ZXI9JytufTtgLCA1XzAwMCk7XG4gICAgICBhd2FpdCB0eXBlSW50bygnLnNlc3Npb24tc2VhcmNoJywgJycpO1xuICAgICAgYXdhaXQgc2xlZXAoNDAwKTtcbiAgICAgIGNvbnN0IGFmdGVyID0gKGF3YWl0IGpzKGBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoYCkpIGFzIG51bWJlcjtcbiAgICAgIHJldHVybiBbd1swXSAmJiBhZnRlciA9PT0gYmVmb3JlLCBgJHt3WzFdfTsgXHU2MDYyXHU1OTBEXHU1NDBFICR7YWZ0ZXJ9PT09JHtiZWZvcmV9YF07XG4gICAgfSk7XG5cbiAgICAvKiA9PT09PT09PT09IGZha2U6Q3RybCtLIFx1NTQ3RFx1NEVFNFx1OTc2Mlx1Njc3RiA9PT09PT09PT09ICovXG4gICAgYXdhaXQgc3RlcCgnQ3RybCtLIFx1NTQ3RFx1NEVFNFx1OTc2Mlx1Njc3RjpcdTYyNTNcdTVGMDBcdTVFNzZcdTYyNjdcdTg4NENcdTU0N0RcdTRFRTQnLCBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidrJywgY3RybEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdjbWRrIG9wZW4nLCBgdmFyIGM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNtZGsnKTtcbiAgICAgICAgcmV0dXJuIHtvazogISFjLCBkZXRhaWw6IGMgPyAnb3BlbicgOiAnbm90IG9wZW4nfTtgLCA1XzAwMCk7XG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgaXQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY21kay1pdGVtJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU2NTg3XHU0RUY2Jyk+PTAgfHwgeC50ZXh0Q29udGVudC5pbmRleE9mKCdGaWxlcycpPj0wO30pOyBpZihpdCkgaXQuY2xpY2soKTsgfSkoKWApO1xuICAgICAgcmV0dXJuIHdhaXRGb3IoJ3RhYiBzd2l0Y2hlZCcsIGB2YXIgdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuZG9jay10YWIuYWN0aXZlJyk7XG4gICAgICAgIHJldHVybiB7b2s6ICEhdCAmJiAodC50ZXh0Q29udGVudD09PSdcdTY1ODdcdTRFRjYnfHx0LnRleHRDb250ZW50PT09J0ZpbGVzJyksIGRldGFpbDogJ2FjdGl2ZT0nKyh0P3QudGV4dENvbnRlbnQ6J25vbmUnKX07YCwgNV8wMDApO1xuICAgIH0pO1xuXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1OEJCRVx1N0Y2RVx1OTc2Mlx1Njc3RiA9PT09PT09PT09ICovXG4gICAgYXdhaXQgc3RlcCgnXHU4QkJFXHU3RjZFKEN0cmwrU2hpZnQrUCk6UHJvdmlkZXIgXHU4ODY4XHU1MzU1XHU1M0VGXHU4OUMxLEVzYyBcdTUxNzNcdTk1RUQnLCBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidwJywgY3RybEtleTp0cnVlLCBzaGlmdEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdzZXR0aW5ncyBvcGVuJywgYHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrLnNldHRpbmdzJyk7XG4gICAgICAgIHJldHVybiB7b2s6ICEhcyAmJiAhIXMucXVlcnlTZWxlY3RvcignLnByb3ZpZGVyLWZvcm0nKSwgZGV0YWlsOiBzID8gJ29wZW4rZm9ybScgOiAnbm90IG9wZW4nfTtgLCA1XzAwMCk7XG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleTonRXNjYXBlJywgYnViYmxlczp0cnVlfSkpYCk7XG4gICAgICByZXR1cm4gd2FpdEZvcignc2V0dGluZ3MgY2xvc2VkJywgYHJldHVybiB7b2s6ICFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kay1vdmVybGF5JyksIGRldGFpbDogJ2Nsb3NlZCd9O2AsIDVfMDAwKTtcbiAgICB9KTtcblxuICAgIC8qID09PT09PT09PT0gZmFrZTppMThuIFx1OEJFRFx1OEEwMFx1NTIwN1x1NjM2MiA9PT09PT09PT09ICovXG4gICAgYXdhaXQgc3RlcCgnXHU4QkVEXHU4QTAwXHU1MjA3XHU2MzYyOlx1NEUyRFx1NjU4NyBcdTIxOTIgRW5nbGlzaCBcdTIxOTIgXHU2MDYyXHU1OTBEXHU0RTJEXHU2NTg3JywgYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleToncCcsIGN0cmxLZXk6dHJ1ZSwgc2hpZnRLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignc2V0dGluZ3Mgb3BlbicsIGB2YXIgcz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kay5zZXR0aW5ncycpO1xuICAgICAgICByZXR1cm4ge29rOiAhIXMsIGRldGFpbDogcyA/ICdvcGVuJyA6ICdub3Qgb3Blbid9O2AsIDVfMDAwKTtcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNtZGsuc2V0dGluZ3MgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J0VuZ2xpc2gnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIGNvbnN0IGVuID0gYXdhaXQgd2FpdEZvcignZW5nbGlzaCBzaG93bicsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhci1oZWFkIC5idG4ucHJpbWFyeScpO1xuICAgICAgICByZXR1cm4ge29rOiAhIWIgJiYgYi50ZXh0Q29udGVudCA9PT0gJysgTmV3IFNlc3Npb24nLCBkZXRhaWw6ICdidG49JysoYj9iLnRleHRDb250ZW50Oidub25lJyl9O2AsIDVfMDAwKTtcbiAgICAgIGF3YWl0IHNob3QoJ2VuZ2xpc2gnKTtcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY21kay5zZXR0aW5ncyBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU0RTJEXHU2NTg3Jzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XG4gICAgICBjb25zdCB6aCA9IGF3YWl0IHdhaXRGb3IoJ2NoaW5lc2UgYmFjaycsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhci1oZWFkIC5idG4ucHJpbWFyeScpO1xuICAgICAgICByZXR1cm4ge29rOiAhIWIgJiYgYi50ZXh0Q29udGVudCA9PT0gJysgXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREJywgZGV0YWlsOiAnYnRuPScrKGI/Yi50ZXh0Q29udGVudDonbm9uZScpfTtgLCA1XzAwMCk7XG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidFc2NhcGUnLCBidWJibGVzOnRydWV9KSlgKTtcbiAgICAgIHJldHVybiBbZW5bMF0gJiYgemhbMF0sIGBlbjogJHtlblsxXX07IHpoOiAke3poWzFdfWBdO1xuICAgIH0pO1xuXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NURFNVx1NEY1Q1x1NTMzQVx1N0JBMVx1NzQwNihcdTVERTZcdTY4MEZcdTY4MEZcdTRGNEQgKyBcdTgzRENcdTUzNTUgKyBcdTY1QjBcdTVFRkFcdTRGMUFcdThCRERcdTkwMDlcdTVERTVcdTRGNUNcdTUzM0EpID09PT09PT09PT0gKi9cbiAgICBhd2FpdCBzdGVwKCdcdTVERTVcdTRGNUNcdTUzM0E6XHU1REU2XHU2ODBGXHU1REU1XHU0RjVDXHU1MzNBXHU2ODBGXHU1M0VGXHU4OUMxKFx1NUY1M1x1NTI0RFx1NURFNVx1NEY1Q1x1NTMzQVx1NTQwRCknLCBhc3luYyAoKSA9PiB7XG4gICAgICByZXR1cm4gd2FpdEZvcignd29ya3NwYWNlIGJhcicsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud29ya3NwYWNlLWJhcicpO1xuICAgICAgICB2YXIgbiA9IGIgPyAoYi5xdWVyeVNlbGVjdG9yKCcud3MtYmFyLW5hbWUnKXx8e30pLnRleHRDb250ZW50IDogJyc7XG4gICAgICAgIHJldHVybiB7b2s6ICEhYiAmJiAhIW4gJiYgbi5sZW5ndGggPiAwICYmIG4uaW5kZXhPZignXHU1MkEwXHU4RjdEJykgPCAwLCBkZXRhaWw6ICdiYXI9JysoYj8neWVzJzonbm8nKSsnIG5hbWU9JytufTtgLCA4XzAwMCk7XG4gICAgfSk7XG4gICAgYXdhaXQgc3RlcCgnXHU1REU1XHU0RjVDXHU1MzNBOlx1ODNEQ1x1NTM1NVx1NUYzOVx1NTFGQSxcdTUyMTdcdTg4NjgrXHU1RjUzXHU1MjREXHU5QUQ4XHU0RUFFK1x1NkRGQlx1NTJBMFx1NTE2NVx1NTNFMztcdTU3MjhcdTYzMDdcdTVCOUFcdTVERTVcdTRGNUNcdTUzM0FcdTY1QjBcdTVFRkFcdTRGMUFcdThCREQnLCBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53b3Jrc3BhY2UtYmFyJyk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3dzIG1lbnUnLCBgdmFyIG09ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLW1lbnUnKTtcbiAgICAgICAgdmFyIGl0ZW1zID0gbSA/IG0ucXVlcnlTZWxlY3RvckFsbCgnLndzLW1lbnUtaXRlbScpLmxlbmd0aCA6IDA7XG4gICAgICAgIHZhciBjdXIgPSBtID8gbS5xdWVyeVNlbGVjdG9yQWxsKCcud3MtbWVudS1pdGVtLmN1cnJlbnQnKS5sZW5ndGggOiAwO1xuICAgICAgICB2YXIgYWRkID0gbSA/IChtLnRleHRDb250ZW50LmluZGV4T2YoJ1x1NkRGQlx1NTJBMFx1NURFNVx1NEY1Q1x1NTMzQScpPj0wIHx8IG0udGV4dENvbnRlbnQuaW5kZXhPZignQWRkIHdvcmtzcGFjZScpPj0wKSA6IGZhbHNlO1xuICAgICAgICByZXR1cm4ge29rOiBpdGVtcyA+PSAxICYmIGN1ciA+PSAxICYmIGFkZCwgZGV0YWlsOiAnaXRlbXM9JytpdGVtcysnIGN1cnJlbnQ9JytjdXIrJyBhZGQ9JythZGR9O2AsIDZfMDAwKTtcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XG4gICAgICBhd2FpdCBzaG90KCd3cy1tZW51Jyk7XG4gICAgICAvLyBcdTcwQjlcdTdCMkNcdTRFMDBcdTRFMkFcdTVERTVcdTRGNUNcdTUzM0FcdTk4NzkgPSBcdTU3MjhcdThCRTVcdTVERTVcdTRGNUNcdTUzM0FcdTY1QjBcdTVFRkFcdTRGMUFcdThCREQoXHU4M0RDXHU1MzU1XHU1MTczXHU5NUVEXHUzMDAxY29tcG9zZXIgXHU1M0VGXHU3NTI4KVxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgaXQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLW1lbnUtaXRlbScpOyBpZihpdCkgaXQuY2xpY2soKTsgfSkoKWApO1xuICAgICAgY29uc3QgY2xvc2VkID0gYXdhaXQgd2FpdEZvcignbWVudSBjbG9zZWQgKyBzZXNzaW9uIGFjdGl2ZScsIGB2YXIgdGE9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNvbXBvc2VyIHRleHRhcmVhJyk7XG4gICAgICAgIHJldHVybiB7b2s6ICFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtbWVudScpICYmICEhdGEgJiYgdGEuZGlzYWJsZWQgPT09IGZhbHNlLCBkZXRhaWw6ICdtZW51PScrKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1tZW51Jyk/J29wZW4nOidjbG9zZWQnKSsnIHRhPScrKHRhP3RhLmRpc2FibGVkOidub25lJyl9O2AsIDZfMDAwKTtcbiAgICAgIHJldHVybiBbY2xvc2VkWzBdLCBgJHt3WzFdfTsgJHtjbG9zZWRbMV19YF07XG4gICAgfSk7XG5cbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU0RjFBXHU4QkREXHU2MzA5XHU1REU1XHU0RjVDXHU1MzNBXHU1MjA2XHU3RUM0ICsgXHU1QzU1XHU1RjAwL1x1NjUzNlx1OEQ3NyA9PT09PT09PT09ICovXG4gICAgYXdhaXQgc3RlcCgnXHU0RjFBXHU4QkREXHU1MjA2XHU3RUM0Olx1N0VDNFx1NTkzNFx1NTFGQVx1NzNCMChcdTVERTVcdTRGNUNcdTUzM0FcdTU0MEQrXHU2NTcwXHU5MUNGKScsIGFzeW5jICgpID0+IHtcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdncm91cCBoZWFkJywgYHZhciBoPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1ncm91cC1oZWFkJyk7XG4gICAgICAgIHZhciBuID0gaCA/IChoLnF1ZXJ5U2VsZWN0b3IoJy53cy1ncm91cC1uYW1lJyl8fHt9KS50ZXh0Q29udGVudCA6ICcnO1xuICAgICAgICB2YXIgYyA9IGggPyAoaC5xdWVyeVNlbGVjdG9yKCcud3MtZ3JvdXAtY291bnQnKXx8e30pLnRleHRDb250ZW50IDogJyc7XG4gICAgICAgIHJldHVybiB7b2s6ICEhaCAmJiBuLmxlbmd0aCA+IDAgJiYgYy5sZW5ndGggPiAwLCBkZXRhaWw6ICduYW1lPScrbisnIGNvdW50PScrY307YCwgOF8wMDApO1xuICAgIH0pO1xuICAgIGF3YWl0IHN0ZXAoJ1x1NEYxQVx1OEJERFx1NTIwNlx1N0VDNDpcdTcwQjlcdTUxRkJcdTdFQzRcdTU5MzRcdTY1MzZcdThENzcsXHU1MThEXHU3MEI5XHU1QzU1XHU1RjAwXHU2MDYyXHU1OTBEJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgYmVmb3JlID0gKGF3YWl0IGpzKGBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoYCkpIGFzIG51bWJlcjtcbiAgICAgIGlmIChiZWZvcmUgPT09IDApIHJldHVybiBbZmFsc2UsICdubyBzZXNzaW9ucyB0byBncm91cCddO1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgaD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtZ3JvdXAtaGVhZCcpOyBpZihoKSBoLmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIGNvbnN0IGNvbGxhcHNlZCA9IGF3YWl0IHdhaXRGb3IoJ2NvbGxhcHNlZCcsIGB2YXIgZz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtZ3JvdXAnKTtcbiAgICAgICAgdmFyIGhpZGRlbiA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGggPCAke2JlZm9yZX07XG4gICAgICAgIHJldHVybiB7b2s6IGhpZGRlbiwgZGV0YWlsOiAnaXRlbXM9Jytkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoKycgYmVmb3JlPSR7YmVmb3JlfSd9O2AsIDVfMDAwKTtcbiAgICAgIGF3YWl0IHNob3QoJ3dzLWdyb3VwLWNvbGxhcHNlZCcpO1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgaD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtZ3JvdXAtaGVhZCcpOyBpZihoKSBoLmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIGNvbnN0IGV4cGFuZGVkID0gYXdhaXQgd2FpdEZvcignZXhwYW5kZWQgYmFjaycsIGB2YXIgbj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoO1xuICAgICAgICByZXR1cm4ge29rOiBuID49ICR7YmVmb3JlfSwgZGV0YWlsOiAnaXRlbXM9JytufTtgLCA1XzAwMCk7XG4gICAgICByZXR1cm4gW2NvbGxhcHNlZFswXSAmJiBleHBhbmRlZFswXSwgYGNvbGxhcHNlOiAke2NvbGxhcHNlZFsxXX07IGV4cGFuZDogJHtleHBhbmRlZFsxXX1gXTtcbiAgICB9KTtcblxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTVGRUJcdTYzNzdcdTk1MkVcdTVFMkVcdTUyQTlcdTk3NjJcdTY3N0YoQ3RybCsvKSA9PT09PT09PT09ICovXG4gICAgYXdhaXQgc3RlcCgnXHU1RkVCXHU2Mzc3XHU5NTJFXHU1RTJFXHU1MkE5OkN0cmwrLyBcdTYyNTNcdTVGMDAsRXNjIFx1NTE3M1x1OTVFRCcsIGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6Jy8nLCBjdHJsS2V5OnRydWUsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3Nob3J0Y3V0cyBvcGVuJywgYHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrJyk7XG4gICAgICAgIHZhciByb3dzID0gcyA/IHMucXVlcnlTZWxlY3RvckFsbCgnLnNob3J0Y3V0LXJvdycpLmxlbmd0aCA6IDA7XG4gICAgICAgIHJldHVybiB7b2s6IHJvd3MgPj0gNSwgZGV0YWlsOiAncm93cz0nK3Jvd3N9O2AsIDVfMDAwKTtcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XG4gICAgICBhd2FpdCBzaG90KCdzaG9ydGN1dHMnKTtcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J0VzY2FwZScsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xuICAgICAgcmV0dXJuIHdhaXRGb3IoJ3Nob3J0Y3V0cyBjbG9zZWQnLCBgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrLW92ZXJsYXknKSwgZGV0YWlsOiAnY2xvc2VkJ307YCwgNV8wMDApO1xuICAgIH0pO1xuXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NEZBN1x1NjgwRlx1NjUzNlx1N0YyOSArIFx1NzJCNlx1NjAwMVx1OEZDN1x1NkVFNCA9PT09PT09PT09ICovXG4gICAgYXdhaXQgc3RlcCgnXHU0RkE3XHU2ODBGXHU2NTM2XHU3RjI5Olx1MjFFNCBcdTY1MzZcdThENzdcdTVERTZcdTY4MEYsXHUyMUU1IFx1NUM1NVx1NUYwMFx1NjA2Mlx1NTkwRCcsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCd0b2dnbGUgYnRuJywgYHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnRvcGJhciBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHUyMUU0J3x8eC50ZXh0Q29udGVudC50cmltKCk9PT0nXHUyMUU1Jzt9KTtcbiAgICAgICAgcmV0dXJuIHtvazogISFiLCBkZXRhaWw6ICdidG49JysoYj9iLnRleHRDb250ZW50LnRyaW0oKTonbm9uZScpfTtgLCA1XzAwMCk7XG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50b3BiYXIgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1MjFFNCd8fHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1MjFFNSc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xuICAgICAgY29uc3QgaGlkZGVuID0gYXdhaXQgd2FpdEZvcignc2lkZWJhciBoaWRkZW4nLCBgdmFyIHNiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyJyk7XG4gICAgICAgIHZhciBnb25lID0gIXNiIHx8IGdldENvbXB1dGVkU3R5bGUoc2IpLmRpc3BsYXkgPT09ICdub25lJztcbiAgICAgICAgcmV0dXJuIHtvazogZ29uZSwgZGV0YWlsOiAnZGlzcGxheT0nKyhzYj9nZXRDb21wdXRlZFN0eWxlKHNiKS5kaXNwbGF5Oidub25lJyl9O2AsIDVfMDAwKTtcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudG9wYmFyIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTIxRTQnfHx4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTIxRTUnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIGNvbnN0IHNob3duID0gYXdhaXQgd2FpdEZvcignc2lkZWJhciBiYWNrJywgYHZhciBzYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhcicpO1xuICAgICAgICByZXR1cm4ge29rOiAhIXNiICYmIGdldENvbXB1dGVkU3R5bGUoc2IpLmRpc3BsYXkgIT09ICdub25lJywgZGV0YWlsOiAnZGlzcGxheT0nKyhzYj9nZXRDb21wdXRlZFN0eWxlKHNiKS5kaXNwbGF5Oidub25lJyl9O2AsIDVfMDAwKTtcbiAgICAgIHJldHVybiBbaGlkZGVuWzBdICYmIHNob3duWzBdLCBgaGlkZTogJHtoaWRkZW5bMV19OyBzaG93OiAke3Nob3duWzFdfWBdO1xuICAgIH0pO1xuICAgIGF3YWl0IHN0ZXAoJ1x1NzJCNlx1NjAwMVx1OEZDN1x1NkVFNDpcdTRFMEJcdTYyQzlcdTUyMDdcdTYzNjJcdTUyMzBcIlx1OEZEMFx1ODg0Q1x1NEUyRFwiXHU0RTBEXHU1RDI5XHU2RTgzXHU1RTc2XHU2MDYyXHU1OTBEJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3Qgc2VsID0gYXdhaXQgd2FpdEZvcignZmlsdGVyIHNlbGVjdCcsIGB2YXIgcz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc3RhdHVzLWZpbHRlcicpO1xuICAgICAgICByZXR1cm4ge29rOiAhIXMgJiYgcy5vcHRpb25zLmxlbmd0aCA+PSA0LCBkZXRhaWw6ICdvcHRpb25zPScrKHM/cy5vcHRpb25zLmxlbmd0aDowKX07YCwgNV8wMDApO1xuICAgICAgaWYgKCFzZWxbMF0pIHJldHVybiBzZWw7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zdGF0dXMtZmlsdGVyJyk7IHMudmFsdWU9J3J1bm5pbmcnOyBzLmRpc3BhdGNoRXZlbnQobmV3IEV2ZW50KCdjaGFuZ2UnLHtidWJibGVzOnRydWV9KSk7IH0pKClgKTtcbiAgICAgIGF3YWl0IHNsZWVwKDUwMCk7XG4gICAgICBjb25zdCByMSA9IChhd2FpdCBqcyhgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aGApKSBhcyBudW1iZXI7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zdGF0dXMtZmlsdGVyJyk7IHMudmFsdWU9J2FsbCc7IHMuZGlzcGF0Y2hFdmVudChuZXcgRXZlbnQoJ2NoYW5nZScse2J1YmJsZXM6dHJ1ZX0pKTsgfSkoKWApO1xuICAgICAgYXdhaXQgc2xlZXAoNTAwKTtcbiAgICAgIGNvbnN0IHIyID0gKGF3YWl0IGpzKGBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoYCkpIGFzIG51bWJlcjtcbiAgICAgIHJldHVybiBbcjIgPj0gcjEgJiYgcjIgPj0gMSwgYHJ1bm5pbmc9JHtyMX0gYWxsPSR7cjJ9YF07XG4gICAgfSk7XG5cbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU2QTIxXHU1NzhCXHU5MDA5XHU2MkU5XHU1NjY4KFx1OTg3Nlx1NjgwRlx1NTIwN1x1NjM2MiBjaGF0IFx1OERFRlx1NzUzMSkgPT09PT09PT09PSAqL1xuICAgIGF3YWl0IHN0ZXAoJ1x1NkEyMVx1NTc4Qlx1OTAwOVx1NjJFOVx1NTY2ODpcdTk4NzZcdTY4MEZcdTgzRENcdTUzNTVcdTUyMTdcdTUxRkEgcHJvdmlkZXJzIFx1NUU3Nlx1NTNFRlx1NTIwN1x1NjM2MicsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdtb2RlbCBidXR0b24nLCBgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnRvcGJhci1tb2RlbC5hcy1idXR0b24nKTtcbiAgICAgICAgcmV0dXJuIHtvazogISFiICYmIGIuZGlzYWJsZWQgPT09IGZhbHNlLCBkZXRhaWw6IGIgPyBiLnRleHRDb250ZW50IDogJ25vbmUnfTtgLCA2XzAwMCk7XG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudG9wYmFyLW1vZGVsLmFzLWJ1dHRvbicpOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIGNvbnN0IG0gPSBhd2FpdCB3YWl0Rm9yKCdtb2RlbCBtZW51JywgYHZhciBtPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5tb2RlbC1tZW51Jyk7XG4gICAgICAgIHZhciBpdGVtcyA9IG0gPyBtLnF1ZXJ5U2VsZWN0b3JBbGwoJy53cy1tZW51LWl0ZW0nKS5sZW5ndGggOiAwO1xuICAgICAgICB2YXIgY3VyID0gbSA/IG0ucXVlcnlTZWxlY3RvckFsbCgnLndzLW1lbnUtaXRlbS5jdXJyZW50JykubGVuZ3RoIDogMDtcbiAgICAgICAgcmV0dXJuIHtvazogaXRlbXMgPj0gMiAmJiBjdXIgPj0gMSwgZGV0YWlsOiAnaXRlbXM9JytpdGVtcysnIGN1cnJlbnQ9JytjdXJ9O2AsIDVfMDAwKTtcbiAgICAgIGlmICghbVswXSkgcmV0dXJuIG07XG4gICAgICBhd2FpdCBzaG90KCdtb2RlbC1tZW51Jyk7XG4gICAgICAvLyBcdTUyMDdcdTUyMzBcdTdCMkNcdTRFOENcdTRFMkEgcHJvdmlkZXIoZmFrZTogZGVtby12aXNpb24vZmFrZS1tLXZpc2lvbilcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGl0cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5tb2RlbC1tZW51IC53cy1tZW51LWl0ZW0nKSk7IHZhciBpdD1pdHNbaXRzLmxlbmd0aC0xXTsgaWYoaXQpIGl0LmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdtb2RlbCBzd2l0Y2hlZCcsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudG9wYmFyLW1vZGVsLmFzLWJ1dHRvbicpO1xuICAgICAgICByZXR1cm4ge29rOiAhIWIgJiYgYi50ZXh0Q29udGVudC5pbmRleE9mKCdmYWtlLW0tdmlzaW9uJykgPj0gMCwgZGV0YWlsOiAnYmFkZ2U9JysoYj9iLnRleHRDb250ZW50Oidub25lJyl9O2AsIDZfMDAwKTtcbiAgICB9KTtcblxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTRFM0JcdTk4OTgoXHU2RDQ1XHU4MjcyXHU3NTFGXHU2NTQ4XHUyMTkyXHU2MDYyXHU1OTBEXHU2REYxXHU4MjcyKSA9PT09PT09PT09ICovXG4gICAgYXdhaXQgc3RlcCgnXHU0RTNCXHU5ODk4Olx1OEJCRVx1N0Y2RVx1NTIwN1x1NkQ0NVx1ODI3Mlx1NzUxRlx1NjU0OCxcdTYwNjJcdTU5MERcdTZERjFcdTgyNzInLCBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidwJywgY3RybEtleTp0cnVlLCBzaGlmdEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdzZXR0aW5ncyBvcGVuJywgYHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrLnNldHRpbmdzJyk7XG4gICAgICAgIHJldHVybiB7b2s6ICEhcywgZGV0YWlsOiBzID8gJ29wZW4nIDogJ25vdCBvcGVuJ307YCwgNV8wMDApO1xuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY21kay5zZXR0aW5ncyAuc2VnIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTZENDVcdTgyNzInfHx4LnRleHRDb250ZW50LnRyaW0oKT09PSdMaWdodCc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xuICAgICAgY29uc3QgbGlnaHQgPSBhd2FpdCB3YWl0Rm9yKCdsaWdodCB0aGVtZScsIGB2YXIgZHQ9ZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LmRhdGFzZXQudGhlbWU7XG4gICAgICAgIHZhciBiZyA9IGdldENvbXB1dGVkU3R5bGUoZG9jdW1lbnQuYm9keSkuYmFja2dyb3VuZENvbG9yO1xuICAgICAgICB2YXIgbSA9IC9cXFxcZCsvZzsgdmFyIG51bXM9KGJnLm1hdGNoKG0pfHxbJzAnLCcwJywnMCddKS5tYXAoTnVtYmVyKTtcbiAgICAgICAgcmV0dXJuIHtvazogZHQ9PT0nbGlnaHQnICYmIG51bXNbMF0+MjAwICYmIG51bXNbMV0+MjAwICYmIG51bXNbMl0+MjAwLCBkZXRhaWw6ICd0aGVtZT0nK2R0KycgYmc9JytiZ307YCwgNV8wMDApO1xuICAgICAgYXdhaXQgc2hvdCgnbGlnaHQtdGhlbWUnKTtcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY21kay5zZXR0aW5ncyAuc2VnIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTZERjFcdTgyNzInfHx4LnRleHRDb250ZW50LnRyaW0oKT09PSdEYXJrJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XG4gICAgICBjb25zdCBkYXJrID0gYXdhaXQgd2FpdEZvcignZGFyayBiYWNrJywgYHJldHVybiB7b2s6IGRvY3VtZW50LmRvY3VtZW50RWxlbWVudC5kYXRhc2V0LnRoZW1lPT09J2RhcmsnLCBkZXRhaWw6ICd0aGVtZT0nK2RvY3VtZW50LmRvY3VtZW50RWxlbWVudC5kYXRhc2V0LnRoZW1lfTtgLCA1XzAwMCk7XG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidFc2NhcGUnLCBidWJibGVzOnRydWV9KSlgKTtcbiAgICAgIHJldHVybiBbbGlnaHRbMF0gJiYgZGFya1swXSwgYGxpZ2h0OiAke2xpZ2h0WzFdfTsgZGFyazogJHtkYXJrWzFdfWBdO1xuICAgIH0pO1xuXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1OTg3Nlx1NjgwRiBcdTRFMkQvRU4gXHU1RkVCXHU2Mzc3XHU1MjA3XHU2MzYyKFx1NTNFRlx1NTNEMVx1NzNCMFx1NjAyNykgPT09PT09PT09PSAqL1xuICAgIGF3YWl0IHN0ZXAoJ1x1OTg3Nlx1NjgwRlx1NUZFQlx1NjM3N1x1NTIwN1x1NjM2MjpcdTRFMkQvRU4gXHU0RTAwXHU5NTJFXHU1MjA3XHU2MzYyJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2xhbmcgc2VnJywgYHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5sYW5nLXNlZycpO1xuICAgICAgICByZXR1cm4ge29rOiAhIXMgJiYgcy5xdWVyeVNlbGVjdG9yQWxsKCdidXR0b24nKS5sZW5ndGggPT09IDIsIGRldGFpbDogcyA/ICdwcmVzZW50JyA6ICdhYnNlbnQnfTtgLCA1XzAwMCk7XG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5sYW5nLXNlZyBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nRU4nO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIGNvbnN0IGVuID0gYXdhaXQgd2FpdEZvcignZW5nbGlzaCcsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhci1oZWFkIC5idG4ucHJpbWFyeScpO1xuICAgICAgICByZXR1cm4ge29rOiAhIWIgJiYgYi50ZXh0Q29udGVudCA9PT0gJysgTmV3IFNlc3Npb24nLCBkZXRhaWw6ICdidG49JysoYj9iLnRleHRDb250ZW50Oidub25lJyl9O2AsIDVfMDAwKTtcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcubGFuZy1zZWcgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NEUyRCc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xuICAgICAgY29uc3QgemggPSBhd2FpdCB3YWl0Rm9yKCdjaGluZXNlIGJhY2snLCBgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXItaGVhZCAuYnRuLnByaW1hcnknKTtcbiAgICAgICAgcmV0dXJuIHtvazogISFiICYmIGIudGV4dENvbnRlbnQgPT09ICcrIFx1NjVCMFx1NUVGQVx1NEYxQVx1OEJERCcsIGRldGFpbDogJ2J0bj0nKyhiP2IudGV4dENvbnRlbnQ6J25vbmUnKX07YCwgNV8wMDApO1xuICAgICAgcmV0dXJuIFtlblswXSAmJiB6aFswXSwgYGVuOiAke2VuWzFdfTsgemg6ICR7emhbMV19YF07XG4gICAgfSk7XG5cbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU3Qzk4XHU4RDM0XHU1NkZFXHU3MjQ3IFx1MjE5MiBcdTdGMjlcdTc1NjVcdTU2RkUgY2hpcCBcdTIxOTIgXHU1M0QxXHU5MDAxIFx1MjE5MiBydW50aW1lIFx1NjUzNlx1NTIzMCA9PT09PT09PT09ICovXG4gICAgYXdhaXQgc3RlcCgnXHU3Qzk4XHU4RDM0XHU1NkZFXHU3MjQ3Olx1N0YyOVx1NzU2NVx1NTZGRSBjaGlwICsgXHU1M0QxXHU5MDAxXHU1NDBFIHJ1bnRpbWUgXHU2NTM2XHU1MjMwXHU1NkZFXHU3MjQ3JywgYXN5bmMgKCkgPT4ge1xuICAgICAgLy8gXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREXHU3ODZFXHU0RkREIGNvbXBvc2VyIFx1NTNFRlx1NzUyOFxuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleTonbicsIGN0cmxLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XG4gICAgICBhd2FpdCBzbGVlcCgzMDApO1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpe1xuICAgICAgICB2YXIgdGEgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY29tcG9zZXIgdGV4dGFyZWEnKTtcbiAgICAgICAgaWYgKCF0YSkgcmV0dXJuO1xuICAgICAgICB2YXIgYyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2NhbnZhcycpO1xuICAgICAgICBjLndpZHRoID0gODsgYy5oZWlnaHQgPSA4O1xuICAgICAgICB2YXIgY3R4ID0gYy5nZXRDb250ZXh0KCcyZCcpO1xuICAgICAgICBjdHguZmlsbFN0eWxlID0gJyMzZjk2NTAnOyBjdHguZmlsbFJlY3QoMCwgMCwgOCwgOCk7XG4gICAgICAgIGMudG9CbG9iKGZ1bmN0aW9uKGJsb2Ipe1xuICAgICAgICAgIHZhciBkdCA9IG5ldyBEYXRhVHJhbnNmZXIoKTtcbiAgICAgICAgICBkdC5pdGVtcy5hZGQobmV3IEZpbGUoW2Jsb2JdLCAncGFzdGVkLnBuZycsIHt0eXBlOiAnaW1hZ2UvcG5nJ30pKTtcbiAgICAgICAgICB0YS5kaXNwYXRjaEV2ZW50KG5ldyBDbGlwYm9hcmRFdmVudCgncGFzdGUnLCB7Y2xpcGJvYXJkRGF0YTogZHQsIGJ1YmJsZXM6IHRydWUsIGNhbmNlbGFibGU6IHRydWV9KSk7XG4gICAgICAgIH0sICdpbWFnZS9wbmcnKTtcbiAgICAgIH0pKClgKTtcbiAgICAgIGNvbnN0IGNoaXAgPSBhd2FpdCB3YWl0Rm9yKCdpbWFnZSBjaGlwJywgYHZhciBuPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5hdHQtY2hpcC5pbWcnKS5sZW5ndGg7XG4gICAgICAgIHJldHVybiB7b2s6IG4gPj0gMSwgZGV0YWlsOiAnaW1nIGNoaXBzPScrbn07YCwgNl8wMDApO1xuICAgICAgaWYgKCFjaGlwWzBdKSByZXR1cm4gY2hpcDtcbiAgICAgIGF3YWl0IHR5cGVJbnRvKCcuY29tcG9zZXIgdGV4dGFyZWEnLCAnXHU3NzBCXHU4RkQ5XHU1RjIwXHU1NkZFJyk7XG4gICAgICBhd2FpdCBzbGVlcCgyMDApO1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jb21wb3NlciBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1M0QxXHU5MDAxJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XG4gICAgICBjb25zdCBkb25lID0gYXdhaXQgd2FpdEZvcignaW1hZ2Ugc2VudCcsIGBcbiAgICAgICAgdmFyIGFwID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmFwcHJvdmFsLWNhcmQgYnV0dG9uJyk7XG4gICAgICAgIGlmIChhcCAmJiBhcC50ZXh0Q29udGVudC50cmltKCkuaW5kZXhPZignXHU2Mjc5XHU1MUM2Jyk+PTApIGFwLmNsaWNrKCk7XG4gICAgICAgIHZhciB0cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50dXJuJykpO1xuICAgICAgICB2YXIgaGl0ID0gdHMuZmlsdGVyKGZ1bmN0aW9uKHgpeyByZXR1cm4geC5jbGFzc05hbWUuaW5kZXhPZigndXNlcicpPDAgJiYgeC50ZXh0Q29udGVudC5pbmRleE9mKCdbaW1hZ2VzOiAxXScpID49IDA7IH0pO1xuICAgICAgICByZXR1cm4ge29rOiBoaXQubGVuZ3RoID49IDEsIGRldGFpbDogJ3J1bnRpbWUtZWNoby13aXRoLWltYWdlPScraGl0Lmxlbmd0aH07XG4gICAgICBgLCAxNV8wMDApO1xuICAgICAgYXdhaXQgc2hvdCgncGFzdGVkLWltYWdlJyk7XG4gICAgICByZXR1cm4gZG9uZTtcbiAgICB9KTtcblxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdUQ4M0RcdURDQ0UgXHU0RTBBXHU0RjIwL1x1RDgzRFx1RENDMSBcdTZENEZcdTg5QzhcdTYzMDlcdTk0QUVcdTVDMzFcdTRGNEQgPT09PT09PT09PSAqL1xuICAgIGF3YWl0IHN0ZXAoJ1x1OTY0NFx1NEVGNlx1NEUwRVx1NzZFRVx1NUY1NVx1NTE2NVx1NTNFMzpcdUQ4M0RcdURDQ0UgXHU0RTBBXHU0RjIwICsgXHVEODNEXHVEQ0MxIFx1NkQ0Rlx1ODlDOFx1NjMwOVx1OTRBRVx1NUI1OFx1NTcyOCcsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoYChmdW5jdGlvbigpe1xuICAgICAgICB2YXIgdXAgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY29tcG9zZXIgYnV0dG9uW2FyaWEtbGFiZWwqPVwiXHU0RTBBXHU0RjIwXCJdLCAuY29tcG9zZXIgYnV0dG9uW2FyaWEtbGFiZWwqPVwiVXBsb2FkXCJdJyk7XG4gICAgICAgIHZhciBiciA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1waWNrZXIgYnV0dG9uJyk7XG4gICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh7dXA6ICEhdXAsIGJyb3dzZTogISFicn0pO1xuICAgICAgfSkoKWApKSBhcyBzdHJpbmc7XG4gICAgICBjb25zdCBwID0gSlNPTi5wYXJzZShyKSBhcyB7IHVwOiBib29sZWFuOyBicm93c2U6IGJvb2xlYW4gfTtcbiAgICAgIHJldHVybiBbcC51cCAmJiBwLmJyb3dzZSwgYFx1RDgzRFx1RENDRT0ke3AudXB9IFx1RDgzRFx1RENDMT0ke3AuYnJvd3NlfWBdO1xuICAgIH0pO1xuXG4gICAgLyogPT09PT09PT09PSBmYWtlOkAgXHU5NjQ0XHU0RUY2XHU5MDA5XHU2MkU5XHU1NjY4ID09PT09PT09PT0gKi9cbiAgICBhd2FpdCBzdGVwKCdAIFx1OTY0NFx1NEVGNjpcdTkwMDlcdTYyRTlcdTU2NjhcdTUxRkFcdTczQjBcdTVFNzZcdTUzRUZcdTkwMDlcdTY1ODdcdTRFRjYnLCBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNvbXBvc2VyIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdAJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignYXR0IHBpY2tlcicsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuYXR0LXBpY2tlcicpO1xuICAgICAgICByZXR1cm4ge29rOiAhIXAsIGRldGFpbDogcCA/ICdvcGVuJyA6ICdub3Qgb3Blbid9O2AsIDVfMDAwKTtcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XG4gICAgICBhd2FpdCB0eXBlSW50bygnLmF0dC1waWNrZXIgaW5wdXQnLCAncmVhZCcpO1xuICAgICAgY29uc3QgdzIgPSBhd2FpdCB3YWl0Rm9yKCdhdHQgcmVzdWx0cycsIGB2YXIgcj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuYXR0LXJlc3VsdHMgLmZzLXJvdycpLmxlbmd0aDtcbiAgICAgICAgcmV0dXJuIHtvazogciA+PSAxLCBkZXRhaWw6ICdyZXN1bHRzPScrcn07YCwgNl8wMDApO1xuICAgICAgaWYgKCF3MlswXSkgcmV0dXJuIHcyO1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgZj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuYXR0LXJlc3VsdHMgLmZzLXJvdycpOyBpZihmKSBmLmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdhdHQgY2hpcCcsIGB2YXIgYz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuYXR0LWNoaXAnKS5sZW5ndGg7XG4gICAgICAgIHJldHVybiB7b2s6IGMgPj0gMSwgZGV0YWlsOiAnY2hpcHM9JytjfTtgLCA1XzAwMCk7XG4gICAgfSk7XG5cbiAgICBhd2FpdCBzaG90KCdmaW5hbCcpO1xuICB9IGVsc2Uge1xuICAgIC8qID09PT09PT09PT0gcmVhbDpcdTUzRUFcdThCRkJcdTVCNTBcdTk2QzYoXHU0RTBEXHU1MkE4XHU3NzFGXHU1QjlFXHU0RjFBXHU4QkREKSA9PT09PT09PT09ICovXG4gICAgYXdhaXQgc3RlcCgnXHU5ODc2XHU2ODBGOnJ1bnRpbWUgXHU3MjQ4XHU2NzJDXHU0RTBFXHU3QUVGXHU1M0UzXHU1REYyXHU2NjNFXHU3OTNBKFx1OTc1RSA/KScsIGFzeW5jICgpID0+IHtcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdob3N0IGxhYmVsJywgYHZhciBsPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ob3N0LWxhYmVsJyk7XG4gICAgICAgIHZhciB0ID0gbCA/IGwudGV4dENvbnRlbnQgOiAnJztcbiAgICAgICAgcmV0dXJuIHtvazogdC5pbmRleE9mKCc/JykgPCAwICYmIHQuaW5kZXhPZigncnVudGltZScpID49IDAsIGRldGFpbDogdC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNjApfTtgLCAxNV8wMDApO1xuICAgIH0pO1xuICAgIGF3YWl0IHN0ZXAoJ1x1NEYxQVx1OEJERFx1NTIxN1x1ODg2ODpcdTc3MUZcdTVCOUVcdTUzODZcdTUzRjJcdTUyQTBcdThGN0QoXHU2NTcwXHU5MUNGPjApJywgYXN5bmMgKCkgPT4ge1xuICAgICAgcmV0dXJuIHdhaXRGb3IoJ3Nlc3Npb25zJywgYHZhciBuPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGg7XG4gICAgICAgIHJldHVybiB7b2s6IG4gPiAwLCBkZXRhaWw6ICdzZXNzaW9ucz0nK259O2AsIDE1XzAwMCk7XG4gICAgfSk7XG4gICAgYXdhaXQgc3RlcCgnXHU3MEI5XHU1MUZCXHU1Mzg2XHU1M0YyXHU0RjFBXHU4QkREIFx1MjE5MiBcdTc3MUZcdTVCOUUgdHJhbnNjcmlwdCBcdTUxODVcdTVCQjlcdTUzRUZcdTg5QzEnLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBuID0gKGF3YWl0IGpzKGBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoYCkpIGFzIG51bWJlcjtcbiAgICAgIGlmIChuID09PSAwKSByZXR1cm4gW2ZhbHNlLCAnbm8gc2Vzc2lvbnMgdG8gY2xpY2snXTtcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGl0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zZXNzaW9uLWl0ZW0nKTsgaWYgKGl0KSBpdC5jbGljaygpOyB9KSgpYCk7XG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignaGlzdG9yeSB0dXJucycsIGB2YXIgdHM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudHVybicpKTtcbiAgICAgICAgcmV0dXJuIHtvazogdHMubGVuZ3RoID49IDEsIGRldGFpbDogJ3R1cm5zPScrdHMubGVuZ3RoKycgZmlyc3Q9JysodHNbMF0/dHNbMF0udGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDQwKTonbm9uZScpfTtgLCAxNV8wMDApO1xuICAgICAgYXdhaXQgc2hvdCgncmVhbC1oaXN0b3J5Jyk7XG4gICAgICByZXR1cm4gdztcbiAgICB9KTtcbiAgICBhd2FpdCBzdGVwKCdEb2NrOk92ZXJ2aWV3IFx1NzcxRlx1NUI5RVx1NjU3MFx1NjM2RShydW50aW1lIFx1NzI0OFx1NjcyQ1x1OTc1RVx1NjVFMFx1NjU3MFx1NjM2RSknLCBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nT3ZlcnZpZXcnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdvdmVydmlldycsIGB2YXIgcm93cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXJvdycpKTtcbiAgICAgICAgdmFyIHZlciA9IHJvd3MuZmluZChmdW5jdGlvbihyKXsgcmV0dXJuIHIudGV4dENvbnRlbnQuaW5kZXhPZigncnVudGltZSBcdTcyNDhcdTY3MkMnKT49MDsgfSk7XG4gICAgICAgIHJldHVybiB7b2s6ICEhdmVyICYmIHZlci50ZXh0Q29udGVudC5pbmRleE9mKCdcdTY1RTBcdTY1NzBcdTYzNkUnKSA8IDAsIGRldGFpbDogdmVyID8gdmVyLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw1MCkgOiAnbm8gdmVyIHJvdyd9O2AsIDEwXzAwMCk7XG4gICAgfSk7XG4gICAgYXdhaXQgc3RlcCgnRG9jazpEaWZmIFx1NzcxRlx1NUI5RSBnaXQgXHU3MkI2XHU2MDAxKFx1OTc1RVx1NTJBMFx1OEY3RFx1NEUyRCknLCBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nXHU1M0Q4XHU2NkY0J3x8eC50ZXh0Q29udGVudD09PSdEaWZmJzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XG4gICAgICByZXR1cm4gd2FpdEZvcignZGlmZicsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuZGlmZi1wYW5lJyk7XG4gICAgICAgIHZhciB0ID0gcCA/IHAudGV4dENvbnRlbnQgOiAnJztcbiAgICAgICAgcmV0dXJuIHtvazogISFwICYmIHQuaW5kZXhPZignXHU1MkEwXHU4RjdEXHU0RTJEJykgPCAwLCBkZXRhaWw6IHQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDYwKX07YCwgMTVfMDAwKTtcbiAgICB9KTtcbiAgICBhd2FpdCBzdGVwKCdEb2NrOkV2aWRlbmNlIFx1NzcxRlx1NUI5RVx1OEJBNFx1NzdFNVx1NjU3MFx1NjM2RScsIGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdcdThCQzFcdTYzNkUnfHx4LnRleHRDb250ZW50PT09J0V2aWRlbmNlJzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XG4gICAgICByZXR1cm4gd2FpdEZvcignZXZpZGVuY2UnLCBgdmFyIHJvd3M9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay1yb3cnKSk7XG4gICAgICAgIHZhciBtZW0gPSByb3dzLmZpbmQoZnVuY3Rpb24ocil7IHJldHVybiByLnRleHRDb250ZW50LmluZGV4T2YoJ1x1OEJCMFx1NUZDNlx1NUM0MicpPj0wIHx8IHIudGV4dENvbnRlbnQuaW5kZXhPZignTWVtb3J5IGxheWVycycpPj0wOyB9KTtcbiAgICAgICAgcmV0dXJuIHtvazogISFtZW0gJiYgbWVtLnRleHRDb250ZW50LmluZGV4T2YoJ1x1MjAyNicpIDwgMCwgZGV0YWlsOiBtZW0gPyBtZW0udGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDUwKSA6ICdubyByb3cnfTtgLCAxNV8wMDApO1xuICAgIH0pO1xuICAgIGF3YWl0IHN0ZXAoJ1x1OTY0NFx1NEVGNlx1NEUwRVx1NzZFRVx1NUY1NVx1NTE2NVx1NTNFMzpcdUQ4M0RcdURDQ0UgXHU0RTBBXHU0RjIwICsgXHU5ODc2XHU2ODBGXHU0RTJEL0VOICsgXHVEODNEXHVEQ0MxIFx1NkQ0Rlx1ODlDOFx1NjMwOVx1OTRBRVx1NUI1OFx1NTcyOCcsIGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdcdTY1ODdcdTRFRjYnfHx4LnRleHRDb250ZW50PT09J0ZpbGVzJzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XG4gICAgICBhd2FpdCB3YWl0Rm9yKCdmaWxlcyB0YWInLCBgdmFyIHQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmRvY2stdGFiLmFjdGl2ZScpO1xuICAgICAgICByZXR1cm4ge29rOiAhIXQgJiYgKHQudGV4dENvbnRlbnQ9PT0nXHU2NTg3XHU0RUY2J3x8dC50ZXh0Q29udGVudD09PSdGaWxlcycpLCBkZXRhaWw6ICdhY3RpdmU9JysodD90LnRleHRDb250ZW50Oidub25lJyl9O2AsIDVfMDAwKTtcbiAgICAgIC8vIHJlYWwgXHU2QTIxXHU1RjBGIHdvcmtzcGFjZXMgXHU4QkY3XHU2QzQyXHU4RDcwIHJ1bnRpbWUoXHU1MUI3XHU1NDJGXHU1MkE4XHU1NDBFXHU1M0VGXHU4MEZEXHU2MzkyXHU5NjFGKSxcdTY1M0VcdTVCQkRcdTUyMzAgMTVzXG4gICAgICBjb25zdCB3cyA9IGF3YWl0IHdhaXRGb3IoJ3dzIHBpY2tlcicsIGB2YXIgdz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtcGlja2VyJyk7XG4gICAgICAgIHJldHVybiB7b2s6ICEhdywgZGV0YWlsOiB3ID8gJ2xvYWRlZCcgOiAnd29ya3NwYWNlcyBub3QgbG9hZGVkIHlldCd9O2AsIG1vZGUgPT09ICdyZWFsJyA/IDE1XzAwMCA6IDZfMDAwKTtcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoYChmdW5jdGlvbigpe1xuICAgICAgICB2YXIgdXAgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY29tcG9zZXIgYnV0dG9uW2FyaWEtbGFiZWwqPVwiXHU0RTBBXHU0RjIwXCJdLCAuY29tcG9zZXIgYnV0dG9uW2FyaWEtbGFiZWwqPVwiVXBsb2FkXCJdJyk7XG4gICAgICAgIHZhciBsYW5nID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmxhbmctc2VnJyk7XG4gICAgICAgIHZhciBiciA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1waWNrZXIgYnV0dG9uJyk7XG4gICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh7dXA6ICEhdXAsIGxhbmc6ICEhbGFuZywgYnJvd3NlOiAhIWJyfSk7XG4gICAgICB9KSgpYCkpIGFzIHN0cmluZztcbiAgICAgIGNvbnN0IHAgPSBKU09OLnBhcnNlKHIpIGFzIHsgdXA6IGJvb2xlYW47IGxhbmc6IGJvb2xlYW47IGJyb3dzZTogYm9vbGVhbiB9O1xuICAgICAgcmV0dXJuIFtwLnVwICYmIHAubGFuZyAmJiBwLmJyb3dzZSwgYFx1RDgzRFx1RENDRT0ke3AudXB9IFx1NEUyRC9FTj0ke3AubGFuZ30gXHVEODNEXHVEQ0MxPSR7cC5icm93c2V9OyAke3dzWzFdfWBdO1xuICAgIH0pO1xuICAgIC8qID09PT09PT09PT0gcmVhbDpcdTc3MUZcdTVCOUVcdTRFRkJcdTUyQTFcdTdBRUZcdTUyMzBcdTdBRUZcdTk5OTZcdTlBOEMoXHU1M0QxXHU3N0VEXHU0RUZCXHU1MkExXHUyMTkyXHU2QTIxXHU1NzhCXHU1NkRFXHU1OTBEKSA9PT09PT09PT09XG4gICAgICAgXHU3NTI4XHU2MjM3IGdsbS01LjMgXHU1REYyXHU5MTREXHU3RjZFO1x1NjNEMFx1NzkzQVx1OEJDRFx1N0VBNlx1Njc1Rlx1NzZGNFx1NjNBNVx1NTZERVx1NTkwRFx1MzAwMlx1ODJFNSBhZ2VudCBcdThCRjdcdTZDNDJcdTVCQTFcdTYyNzksXHU4RjZFXHU4QkUyXHU5MUNDXG4gICAgICAgXHU4MUVBXHU1MkE4XHU3MEI5XHU2Mjc5XHU1MUM2KFx1NjcwMFx1NTkxQVx1ODlDMVx1NTM2MVx1NTM3M1x1NzBCOSxcdTVFNDJcdTdCNDkpXHUzMDAyXHU4RDg1XHU2NUY2IDE1MHNcdTMwMDIgKi9cbiAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfUkVBTF9UQVNLID09PSAnMScpIHtcbiAgICAgIGF3YWl0IHN0ZXAoJ1x1NzcxRlx1NUI5RVx1NEVGQlx1NTJBMTpcdTUzRDFcdTkwMDFcdTIxOTJcdTZBMjFcdTU3OEJcdTU2REVcdTU5MEQoXHU3QUVGXHU1MjMwXHU3QUVGXHU5OTk2XHU5QThDKScsIGFzeW5jICgpID0+IHtcbiAgICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleTonbicsIGN0cmxLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XG4gICAgICAgIGF3YWl0IHNsZWVwKDQwMCk7XG4gICAgICAgIGF3YWl0IHR5cGVJbnRvKCcuY29tcG9zZXIgdGV4dGFyZWEnLCAnXHU4QkY3XHU1M0VBXHU1NkRFXHU1OTBEXHU0RTI0XHU0RTJBXHU1QjU3Olx1NjUzNlx1NTIzMChcdTY3MkNcdTZCMjFcdTlBOENcdTY1MzZcdTRFRkJcdTUyQTEsXHU0RTBEXHU4OTgxXHU0RjdGXHU3NTI4XHU0RUZCXHU0RjU1XHU1REU1XHU1MTc3LFx1NzZGNFx1NjNBNVx1NTZERVx1NTkwRCknKTtcbiAgICAgICAgYXdhaXQgc2xlZXAoMjAwKTtcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jb21wb3NlciBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1M0QxXHU5MDAxJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XG4gICAgICAgIGNvbnN0IHNlbnQgPSBhd2FpdCB3YWl0Rm9yKCd1c2VyIHR1cm4nLCBgdmFyIHQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnR1cm4udXNlcicpO1xuICAgICAgICAgIHZhciBzID0gKHQgJiYgdC50ZXh0Q29udGVudCkgPyBTdHJpbmcodC50ZXh0Q29udGVudCkgOiAnJztcbiAgICAgICAgICByZXR1cm4ge29rOiBzLmluZGV4T2YoJ1x1NjUzNlx1NTIzMCcpPj0wIHx8IHMuaW5kZXhPZignXHU5QThDXHU2NTM2XHU0RUZCXHU1MkExJyk+PTAsIGRldGFpbDogcy5zbGljZSgwLDMwKSB8fCAnbm9uZSd9O2AsIDEwXzAwMCk7XG4gICAgICAgIGlmICghc2VudFswXSkgcmV0dXJuIHNlbnQ7XG4gICAgICAgIGNvbnN0IHJlcGx5ID0gYXdhaXQgd2FpdEZvcignYXNzaXN0YW50IHJlcGx5JywgYFxuICAgICAgICAgIHZhciBhcCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5hcHByb3ZhbC1jYXJkIGJ1dHRvbicpO1xuICAgICAgICAgIGlmIChhcCAmJiBhcC50ZXh0Q29udGVudC50cmltKCkuaW5kZXhPZignXHU2Mjc5XHU1MUM2Jyk+PTApIGFwLmNsaWNrKCk7XG4gICAgICAgICAgdmFyIHRzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnR1cm4nKSkuZmlsdGVyKGZ1bmN0aW9uKHgpeyByZXR1cm4geC5jbGFzc05hbWUuaW5kZXhPZigndXNlcicpPDAgJiYgeC5jbGFzc05hbWUuaW5kZXhPZignYXBwcm92YWwnKTwwICYmIHguY2xhc3NOYW1lLmluZGV4T2YoJ3N5c3RlbScpPDAgJiYgeC50ZXh0Q29udGVudC50cmltKCkubGVuZ3RoPjAgJiYgeC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTU2REVcdTU0MDgnKTwwOyB9KTtcbiAgICAgICAgICB2YXIgc3VtID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnR1cm4tc3VtJyk7XG4gICAgICAgICAgcmV0dXJuIHtvazogdHMubGVuZ3RoPj0xICYmICEhc3VtLCBkZXRhaWw6ICdhc3Npc3RhbnQ9Jyt0cy5sZW5ndGgrJyBzdW09Jysoc3VtP3N1bS50ZXh0Q29udGVudDonbm9uZScpKycgZmlyc3Q9JysodHNbMF0/dHNbMF0udGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDQwKTonbm9uZScpfTtcbiAgICAgICAgYCwgMTUwXzAwMCk7XG4gICAgICAgIGF3YWl0IHNob3QoJ3JlYWwtdGFzaycpO1xuICAgICAgICByZXR1cm4gcmVwbHk7XG4gICAgICB9KTtcbiAgICB9XG4gICAgYXdhaXQgc3RlcCgnXHU0RjFBXHU4QkREXHU1MjA2XHU3RUM0Olx1NURFNlx1NjgwRlx1NjMwOVx1NURFNVx1NEY1Q1x1NTMzQVx1NTIwNlx1N0VDNChcdTdFQzRcdTU5MzRcdTUzRUZcdTg5QzEpJywgYXN5bmMgKCkgPT4ge1xuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2dyb3VwIGhlYWQnLCBgdmFyIGg9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLWdyb3VwLWhlYWQnKTtcbiAgICAgICAgdmFyIG4gPSBoID8gKGgucXVlcnlTZWxlY3RvcignLndzLWdyb3VwLW5hbWUnKXx8e30pLnRleHRDb250ZW50IDogJyc7XG4gICAgICAgIHJldHVybiB7b2s6ICEhaCAmJiBuLmxlbmd0aCA+IDAsIGRldGFpbDogJ25hbWU9JytufTtgLCAxNV8wMDApO1xuICAgIH0pO1xuICAgIGF3YWl0IHN0ZXAoJ1x1NURFNVx1NEY1Q1x1NTMzQTpcdTVERTZcdTY4MEZcdTVERTVcdTRGNUNcdTUzM0FcdTY4MEZcdTUzRUZcdTg5QzEoXHU3NzFGXHU1QjlFXHU1REU1XHU0RjVDXHU1MzNBXHU1NDBEKScsIGFzeW5jICgpID0+IHtcbiAgICAgIHJldHVybiB3YWl0Rm9yKCd3b3Jrc3BhY2UgYmFyJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53b3Jrc3BhY2UtYmFyJyk7XG4gICAgICAgIHZhciBuID0gYiA/IChiLnF1ZXJ5U2VsZWN0b3IoJy53cy1iYXItbmFtZScpfHx7fSkudGV4dENvbnRlbnQgOiAnJztcbiAgICAgICAgcmV0dXJuIHtvazogISFiICYmICEhbiAmJiBuLmxlbmd0aCA+IDAgJiYgbi5pbmRleE9mKCdcdTUyQTBcdThGN0QnKSA8IDAgJiYgbi5pbmRleE9mKCdMb2FkaW5nJykgPCAwLCBkZXRhaWw6ICduYW1lPScrbn07YCwgMTVfMDAwKTtcbiAgICB9KTtcbiAgICBhd2FpdCBzaG90KCdmaW5hbCcpO1xuICB9XG5cbiAgY29uc3QgZmFpbGVkID0gcmVzdWx0cy5maWx0ZXIoKHIpID0+ICFyWzFdKS5sZW5ndGg7XG4gIGNvbnNvbGUubG9nKGBVSVZFUklGWSBTVU1NQVJZIHBhc3M9JHtyZXN1bHRzLmxlbmd0aCAtIGZhaWxlZH0vJHtyZXN1bHRzLmxlbmd0aH0gbW9kZT0ke21vZGV9IHNob3RzPSR7c2hvdHN9YCk7XG4gIGFwcC5leGl0KGZhaWxlZCA9PT0gMCA/IDAgOiAxKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGF0dGFjaFVpVmVyaWZ5KHdpbjogQnJvd3NlcldpbmRvdyk6IHZvaWQge1xuICBjb25zdCBtb2RlID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfTU9ERSA9PT0gJ3JlYWwnID8gJ3JlYWwnIDogJ2Zha2UnO1xuICB3aW4ud2ViQ29udGVudHMub25jZSgnZGlkLWZpbmlzaC1sb2FkJywgKCkgPT4ge1xuICAgIC8vIFx1N0VEOSBob3N0IFx1NTQyRlx1NTJBOFx1NzU1OVx1NjVGNlx1OTVGNDtcdTZCNjVcdTlBQTRcdTUxODVcdTkwRThcdTU0MDRcdTgxRUFcdThGNkVcdThCRTJcdTdCNDlcdTVGODVcbiAgICBzZXRUaW1lb3V0KCgpID0+IHsgdm9pZCBydW5VaVZlcmlmeSh3aW4sIG1vZGUpOyB9LCAzXzAwMCk7XG4gIH0pO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIjtBQWNBLFNBQVMsT0FBQUEsTUFBSyxlQUFlLFFBQVEsU0FBUyxTQUFTLE9BQU8sTUFBTSxjQUFjLE1BQU0sYUFBYSxtQkFBbUI7QUFDeEgsU0FBUyxRQUFBQyxPQUFNLFNBQVMsWUFBWSxlQUFlO0FBQ25ELFNBQVMsWUFBWSxnQkFBQUMscUJBQW9CO0FBQ3pDLFNBQVMsYUFBQUMsWUFBVyxnQkFBZ0I7QUFDcEMsU0FBUyxTQUFTLHlCQUF5QjtBQUMzQyxTQUFTLGNBQWMsU0FBQUMsY0FBYTtBQUNwQyxTQUFTLGlCQUFBQyxzQkFBcUI7OztBQ1Y5QixTQUFTLGFB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QixnQkFBVSxNQUFNO0FBQ2hCLFdBQUssV0FBVyxLQUFLLEVBQUUsUUFBUSxNQUFNQSxLQUFJLEtBQUssQ0FBQztBQUFBLElBQ2pEO0FBQUEsRUFDRixDQUFDO0FBQ0QsRUFBQUEsS0FBSSxHQUFHLHFCQUFxQixNQUFNO0FBQ2hDLFFBQUksUUFBUSxhQUFhLFNBQVUsQ0FBQUEsS0FBSSxLQUFLO0FBQUEsRUFDOUMsQ0FBQztBQUNIO0FBeDhCVztBQXlCQTtBQU9BO0FBZUE7QUEyQkE7QUFPQTtBQTRCQTtBQTBDQTtBQWVBO0FBT0E7QUFjQTtBQTREQTtBQXlDQTtBQW1GQTtBQVlBO0FBV0E7IiwKICAibmFtZXMiOiBbImFwcCIsICJqb2luIiwgInJlYWxwYXRoU3luYyIsICJ3cml0ZUZpbGUiLCAic3Bhd24iLCAicGF0aFRvRmlsZVVSTCIsICJyZXNvbHZlIiwgInJhbmRvbVVVSUQiLCAicmFuZG9tVVVJRCIsICJyZXNvbHZlIiwgImpvaW4iLCAiYXBwIiwgInB1c2hFdmVudCIsICJub3RpZnlFdmVudCIsICJmb2N1c01haW5XaW5kb3ciLCAic2V0dXBUcmF5IiwgImFwcGx5Q2hyb21lIiwgImJ1aWxkQXBwTWVudSIsICJwb3B1cE1haW5NZW51IiwgImxhbklwT2YiLCAiY2xpRW50cnlPZiIsICJyZXBvUm9vdE9mIiwgInJ1bkNsaSIsICJzcGF3biIsICJicm9hZGNhc3RIb3N0U3RhdGUiLCAiZGV0ZWN0UmVhbEVudHJ5IiwgInJlYWxwYXRoU3luYyIsICJzZW5kZXJUcnVzdGVkIiwgImhvc3RDYWxsIiwgInJlZ2lzdGVySXBjIiwgIndyaXRlRmlsZSIsICJwYXRoVG9GaWxlVVJMIiwgImFwcDIiXQp9Cg==
