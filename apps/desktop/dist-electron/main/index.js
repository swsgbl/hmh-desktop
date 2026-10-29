// apps/desktop/electron/main/index.ts
import { app as app3, BrowserWindow, dialog, ipcMain, session, shell, Tray, Notification, Menu, nativeImage, nativeTheme } from "electron";
import { join as join4, dirname, basename, isAbsolute, resolve } from "node:path";
import { existsSync as existsSync2, realpathSync as realpathSync2, readFileSync } from "node:fs";
import { writeFile as writeFile3, readFile } from "node:fs/promises";
import { homedir as homedir2, networkInterfaces } from "node:os";
import { execFileSync, spawn as spawn3 } from "node:child_process";
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
    if (process.env.HMH_DESKTOP_UIVERIFY_WIZARD === "fake") {
      await step("\u5411\u5BFC:\u9996\u542F\u5F39\u51FA\u6B22\u8FCE\u9875(\u5F00\u59CB\u914D\u7F6E/\u6F14\u793A\u5165\u53E3)", async () => {
        const w = await waitFor("wizard overlay", `var o=document.querySelector('.wizard-overlay');
          var b=[].slice.call(document.querySelectorAll('.wizard-overlay button')).find(function(x){return x.textContent.trim()==='\u5F00\u59CB\u914D\u7F6E';});
          return {ok: !!o && !!b, detail: o ? 'overlay+\u5F00\u59CB\u914D\u7F6E' : 'no overlay'};`, 12e3);
        await shot("wizard-welcome");
        return w;
      });
      await step("\u5411\u5BFC:\u5F00\u59CB\u914D\u7F6E\u2192\u68C0\u6D4B(\u4F2A\u9020\u672A\u88C5)\u2192\u672A\u88C5\u5373\u81EA\u52A8\u5B89\u88C5\u9875(\u8BF4\u660E\u6A2A\u5E45+\u5207\u6362\u94FE\u63A5)", async () => {
        await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.wizard-overlay button')).find(function(x){return x.textContent.trim()==='\u5F00\u59CB\u914D\u7F6E';}); if(b) b.click(); })()`);
        const w = await waitFor("auto install page", `var p=document.querySelector('.wizard-card.wizard-page-install');
          if(!p) return {ok:false, detail:'not on install'};
          var t=p.textContent;
          var note=t.indexOf('\u672A\u68C0\u6D4B\u5230 hmh CLI,\u5DF2\u81EA\u52A8\u5F00\u59CB\u5B89\u88C5')>=0;
          var l1=t.indexOf('\u6539\u7528\u5185\u7F6E\u7CBE\u7B80\u5185\u6838')>=0, l2=t.indexOf('\u6F14\u793A\u6A21\u5F0F')>=0;
          var bar=!!p.querySelector('.wizard-progress');
          var sel=document.querySelector('.wizard-card.wizard-page-select');
          return {ok: note&&l1&&l2&&bar&&!sel, detail: 'note='+note+' \u5185\u7F6E\u94FE\u63A5='+l1+' \u6F14\u793A\u94FE\u63A5='+l2+' bar='+bar+' selectLeak='+!!sel};`, 12e3);
        await shot("wizard-auto-install");
        return w;
      });
      await step('\u5411\u5BFC:\u6A2A\u5E45"\u6539\u7528\u5185\u7F6E\u7CBE\u7B80\u5185\u6838"\u2192\u914D\u7F6E\u8DF3\u8FC7\u2192\u5B8C\u6210\u9875\u2192\u5F00\u59CB\u4F7F\u7528\u2192\u5173\u95ED\u4E14\u5DF2\u8FDE\u63A5', async () => {
        await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.wizard-page-install .wizard-alt-link')).find(function(x){return x.textContent.indexOf('\u6539\u7528\u5185\u7F6E\u7CBE\u7B80\u5185\u6838')>=0;}); if(b) b.click(); })()`);
        await waitFor("config or done", `var d=document.querySelector('.wizard-card.wizard-page-done');
          if(d) return {ok:true, detail:'done'};
          var c=document.querySelector('.wizard-card.wizard-page-config');
          if(c){ var s=[].slice.call(document.querySelectorAll('.wizard-overlay button')).find(function(x){return x.textContent.indexOf('\u8DF3\u8FC7')>=0;}); if(s) s.click(); }
          return {ok:false, detail:'waiting'};`, 15e3);
        const w = await waitFor("done page", `var d=document.querySelector('.wizard-card.wizard-page-done');
          var t=d?d.textContent:'';
          return {ok: !!d && t.indexOf('\u5C31\u7EEA')>=0 && t.indexOf('\u5171\u4EAB')>=0, detail: t.replace(/\\s+/g,' ').slice(0,60)};`, 8e3);
        await shot("wizard-done");
        await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.wizard-overlay button')).find(function(x){return x.textContent.trim()==='\u5F00\u59CB\u4F7F\u7528';}); if(b) b.click(); })()`);
        const closed = await waitFor("wizard closed + connected", `return {ok: !document.querySelector('.wizard-overlay') && !!document.querySelector('.host-dot.on'),
          detail: 'overlay='+(document.querySelector('.wizard-overlay')?'open':'closed')+' dot='+(document.querySelector('.host-dot.on')?'on':'off')};`, 1e4);
        return [w[0] && closed[0], `done: ${w[1]}; ${closed[1]}`];
      });
    }
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
      const w = await waitFor("toggle btn", `var b=[].slice.call(document.querySelectorAll('.topbar button')).find(function(x){return (x.getAttribute('aria-label')||'').indexOf('\u4FA7\u680F')>=0;});
        return {ok: !!b, detail: 'btn='+(b?b.getAttribute('aria-label'):'none')};`, 5e3);
      if (!w[0]) return w;
      await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.topbar button')).find(function(x){return (x.getAttribute('aria-label')||'').indexOf('\u4FA7\u680F')>=0;}); if(b) b.click(); })()`);
      const hidden = await waitFor("sidebar hidden", `var sb=document.querySelector('.sidebar');
        var gone = !sb || getComputedStyle(sb).display === 'none';
        return {ok: gone, detail: 'display='+(sb?getComputedStyle(sb).display:'none')};`, 5e3);
      await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.topbar button')).find(function(x){return (x.getAttribute('aria-label')||'').indexOf('\u4FA7\u680F')>=0;}); if(b) b.click(); })()`);
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
    if (process.env.HMH_DESKTOP_UIVERIFY_WIZARD === "fake") {
      await step("\u5411\u5BFC:\u8BBE\u7F6E\u300C\u91CD\u65B0\u914D\u7F6E\u300D\u91CD\u5165 + \u9009\u62E9\u6301\u4E45(wizard.json)", async () => {
        await js(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'p', ctrlKey:true, shiftKey:true, bubbles:true}))`);
        const open = await waitFor("settings open", `var s=document.querySelector('.cmdk.settings');
          return {ok: !!s, detail: s ? 'open' : 'closed'};`, 5e3);
        if (!open[0]) return open;
        await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.cmdk.settings button')).find(function(x){return x.textContent.indexOf('\u91CD\u65B0\u914D\u7F6E')>=0;}); if(b) b.click(); })()`);
        const shown = await waitFor("wizard reopened", `return {ok: !!document.querySelector('.wizard-overlay'),
          detail: document.querySelector('.wizard-overlay') ? 'open' : 'closed'};`, 5e3);
        if (!shown[0]) return shown;
        await shot("wizard-reentry");
        await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.wizard-overlay button')).find(function(x){return x.textContent.trim()==='\u53D6\u6D88';}); if(b) b.click(); })()`);
        const closed = await waitFor("wizard closed", `return {ok: !document.querySelector('.wizard-overlay'), detail: 'closed'};`, 5e3);
        const st = await js(`window.hmh.getWizard().then(function(r){return JSON.stringify(r);})`);
        const p = JSON.parse(st);
        const persisted = p.persisted?.done === true && p.persisted?.choice === "bundled";
        return [closed[0] && persisted, `closed=${closed[0]} persisted=${JSON.stringify(p.persisted ?? null)}`];
      });
      await step("\u5411\u5BFC:\u7A84\u5C4F 360\xD7640\u2014\u2014\u4E09\u9009\u9879(\u542B note \u6574\u680F)\u4E0E\u6309\u94AE\u5168\u90E8\u53EF\u547D\u4E2D+\u5355\u51FB\u5373\u524D\u8FDB", async () => {
        process.env.HMH_DESKTOP_UIVERIFY_FAKE_DETECT_FOUND = "1";
        const size0 = win.getSize();
        const w0 = size0[0] ?? 1280;
        const h0 = size0[1] ?? 800;
        try {
          await js(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'p', ctrlKey:true, shiftKey:true, bubbles:true}))`);
          const open = await waitFor("settings open", `var s=document.querySelector('.cmdk.settings'); return {ok: !!s, detail: s ? 'open' : 'closed'};`, 5e3);
          if (!open[0]) return open;
          await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.cmdk.settings button')).find(function(x){return x.textContent.indexOf('\u91CD\u65B0\u914D\u7F6E')>=0;}); if(b) b.click(); })()`);
          const shown = await waitFor("wizard reopened", `return {ok: !!document.querySelector('.wizard-overlay'), detail: document.querySelector('.wizard-overlay') ? 'open' : 'closed'};`, 5e3);
          if (!shown[0]) return shown;
          await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.wizard-overlay button')).find(function(x){return x.textContent.trim()==='\u5F00\u59CB\u914D\u7F6E';}); if(b) b.click(); })()`);
          const detectPage = await waitFor("detect found page(3 options)", `var p=document.querySelector('.wizard-card.wizard-page-detect');
            var opts=p?p.querySelectorAll('.wizard-opt').length:0;
            return {ok: !!p && opts===3, detail: 'opts='+opts};`, 12e3);
          if (!detectPage[0]) return detectPage;
          await js(`(function(){ var o=[].slice.call(document.querySelectorAll('.wizard-opt')).find(function(x){return x.textContent.indexOf('\u4ECD\u8981\u4E0B\u8F7D\u65B0\u7248')>=0;}); if(o) o.click(); })()`);
          const selectPage = await waitFor("select page via single click", `var p=document.querySelector('.wizard-card.wizard-page-select');
            return {ok: !!p && p.querySelectorAll('.wizard-opt').length===3, detail: p ? 'select' : 'not select'};`, 6e3);
          if (!selectPage[0]) return [false, `\u5355\u51FB\u9009\u9879\u672A\u524D\u8FDB\u5230\u9009\u62E9\u9875: ${selectPage[1]}`];
          win.setSize(360, 640);
          await sleep(500);
          const r = await js(`(function(){
            function hit(el){ el.scrollIntoView({block:'nearest'}); var r=el.getBoundingClientRect();
              var x=r.left+r.width/2, y=r.top+r.height/2;
              var e=document.elementFromPoint(x,y);
              return !!(e && (e===el || el.contains(e))); }
            var card=document.querySelector('.wizard-card.wizard-page-select');
            var opts=[].slice.call(card.querySelectorAll('.wizard-opt'));
            var optHit=opts.map(hit);
            var notes=[].slice.call(card.querySelectorAll('.wizard-opt-note'));
            var noteHit=notes.map(function(n){ n.scrollIntoView({block:'nearest'}); var r=n.getBoundingClientRect();
              var e=document.elementFromPoint(r.left+r.width/2, r.top+Math.min(r.height/2, 8));
              return !!(e && opts.some(function(o){ return e===o || o.contains(e); })); });
            var act=document.querySelector('.wizard-card.wizard-page-select .wizard-actions .btn.primary');
            var footer=[].slice.call(document.querySelectorAll('.wizard-footer button'));
            return JSON.stringify({vw: window.innerWidth, vh: window.innerHeight, opts: opts.length,
              optHit: optHit, noteHit: noteHit, actHit: act ? hit(act) : false, ftHit: footer.map(hit)});
          })()`);
          const q = JSON.parse(r);
          await shot("wizard-narrow-360-select");
          const narrowOk = q.opts === 3 && q.vw <= 380 && q.optHit.every(Boolean) && q.noteHit.every(Boolean) && q.actHit && q.ftHit.every(Boolean);
          await js(`(function(){ var o=[].slice.call(document.querySelectorAll('.wizard-opt')).find(function(x){return x.textContent.indexOf('\u4E0B\u8F7D\u5B89\u88C5\u5B8C\u6574 hmh CLI')>=0;}); if(o) o.click(); })()`);
          const adv = await waitFor("install page via single click", `var p=document.querySelector('.wizard-card.wizard-page-install');
            return {ok: !!p, detail: p ? 'installing' : 'not shown'};`, 6e3);
          await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.wizard-overlay button')).find(function(x){return x.textContent.trim()==='\u53D6\u6D88';}); if(b) b.click(); })()`);
          const closedNarrow = await waitFor("wizard closed at 360px", `return {ok: !document.querySelector('.wizard-overlay'), detail: 'closed'};`, 5e3);
          return [
            narrowOk && adv[0] && closedNarrow[0],
            `vp=${q.vw}x${q.vh} opts=${q.opts} optHit=[${q.optHit.join(",")}] noteHit=[${q.noteHit.join(",")}] \u4E3B\u6309\u94AE=${q.actHit} footer=[${q.ftHit.join(",")}]; \u5355\u51FB\u524D\u8FDB: ${adv[1]}; \u7A84\u5C4F\u53D6\u6D88: ${closedNarrow[1]}`
          ];
        } finally {
          win.setSize(w0, h0);
          process.env.HMH_DESKTOP_UIVERIFY_FAKE_DETECT_FOUND = void 0;
        }
      });
    }
    await step("\u7A84\u7A97\u62BD\u5C49:760px \u4FA7\u680F\u53EF\u8FBE\u53EF\u5173(\u906E\u7F69\u70B9\u51FB + Esc)", async () => {
      try {
        win.setMinimumSize(560, 600);
        win.setBounds({ width: 760, height: 700 });
      } catch {
      }
      const isNarrow = await waitFor("matchMedia 820", `return {ok: window.matchMedia('(max-width: 820px)').matches, detail: 'iw=' + window.innerWidth};`, 5e3);
      if (!isNarrow[0]) return isNarrow;
      const btn = await waitFor("drawer button", `var b=[].slice.call(document.querySelectorAll('.topbar button')).find(function(x){return (x.getAttribute('aria-label')||'').indexOf('\u62BD\u5C49')>=0;});
        return {ok: !!b, detail: 'btn='+(b?b.getAttribute('aria-label'):'none')};`, 5e3);
      if (!btn[0]) return btn;
      await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.topbar button')).find(function(x){return (x.getAttribute('aria-label')||'').indexOf('\u62BD\u5C49')>=0;}); if(b) b.click(); })()`);
      const opened = await waitFor("drawer open", `var sb=document.querySelector('.sidebar'), sc=document.querySelector('.sidebar-scrim');
        var r=sb?sb.getBoundingClientRect():null;
        return {ok: !!r && r.x >= 0 && r.x < 40 && !!sc, detail: 'x='+(r?Math.round(r.x):'none')+' scrim='+(sc?'yes':'no')};`, 5e3);
      await shot("drawer-open");
      await js(`(function(){ var sc=document.querySelector('.sidebar-scrim'); if(sc) sc.click(); })()`);
      const closed = await waitFor("drawer closed by scrim", `var sb=document.querySelector('.sidebar'), sc=document.querySelector('.sidebar-scrim');
        var r=sb?sb.getBoundingClientRect():null;
        return {ok: !!r && r.x < 0 && !sc, detail: 'x='+(r?Math.round(r.x):'none')+' scrim='+(sc?'yes':'no')};`, 5e3);
      await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.topbar button')).find(function(x){return (x.getAttribute('aria-label')||'').indexOf('\u62BD\u5C49')>=0;}); if(b) b.click(); })()`);
      await waitFor("drawer reopen", `var sb=document.querySelector('.sidebar'); var r=sb?sb.getBoundingClientRect():null;
        return {ok: !!r && r.x >= 0 && r.x < 40, detail: 'x='+(r?Math.round(r.x):'none')};`, 5e3);
      await js(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
      const escClosed = await waitFor("drawer closed by Esc", `var sb=document.querySelector('.sidebar'); var r=sb?sb.getBoundingClientRect():null;
        return {ok: !!r && r.x < 0, detail: 'x='+(r?Math.round(r.x):'none')};`, 5e3);
      try {
        win.setBounds({ width: 1280, height: 800 });
      } catch {
      }
      await sleep(400);
      const wide = await waitFor("wide restored", `var sb=document.querySelector('.sidebar'); var r=sb?sb.getBoundingClientRect():null;
        return {ok: !!r && r.width > 200 && getComputedStyle(sb).display !== 'none', detail: 'w='+(r?Math.round(r.width):'none')};`, 5e3);
      return [opened[0] && closed[0] && escClosed[0] && wide[0], `open: ${opened[1]}; scrim-close: ${closed[1]}; esc-close: ${escClosed[1]}; wide: ${wide[1]}`];
    });
    await step("\u6807\u9898\u680F:44px + drag \u533A(\u83DC\u5355 no-drag;overlay \u9AD8\u5EA6\u4E00\u81F4)", async () => {
      const r = await js(`(function(){
        var tb=document.querySelector('.titlebar'), mb=document.querySelector('.titlebar-menu');
        if(!tb || !mb) return JSON.stringify({ok:false, detail:'missing titlebar/menu'});
        var cs=getComputedStyle(tb), ms=getComputedStyle(mb);
        return JSON.stringify({ ok: cs.height === '44px' && cs.webkitAppRegion === 'drag' && ms.webkitAppRegion === 'no-drag' && mb.getBoundingClientRect().height >= 36,
          detail: 'h='+cs.height+' region='+cs.webkitAppRegion+' menu-region='+ms.webkitAppRegion+' menu-h='+Math.round(mb.getBoundingClientRect().height) });
      })()`);
      const p = JSON.parse(r);
      let overlay = "n/a";
      try {
        const probe = win;
        const o = probe.getTitleBarOverlay?.() ?? null;
        overlay = o !== null ? String(o.height) : "n/a";
      } catch {
      }
      return [p.ok === true, `${p.detail} overlay-h=${overlay}`];
    });
    await shot("final");
  } else if ((process.env.HMH_DESKTOP_UIVERIFY_WIZARD ?? "") !== "") {
    if (process.env.HMH_DESKTOP_UIVERIFY_WIZARD === "detect") {
      await step("\u5411\u5BFC(\u771F\u5B9E):\u6B22\u8FCE\u2192\u68C0\u6D4B\u5230\u672C\u673A\u5DF2\u88C5 CLI(\u9ED8\u8BA4\u5171\u4EAB,\u52FE\u9009\u6B63\u786E)", async () => {
        const w = await waitFor("wizard overlay", `var o=document.querySelector('.wizard-overlay');
          var b=[].slice.call(document.querySelectorAll('.wizard-overlay button')).find(function(x){return x.textContent.trim()==='\u5F00\u59CB\u914D\u7F6E';});
          return {ok: !!o && !!b, detail: o ? 'overlay+\u5F00\u59CB\u914D\u7F6E' : 'no overlay'};`, 12e3);
        if (!w[0]) return w;
        await shot("wizard-real-welcome");
        await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.wizard-overlay button')).find(function(x){return x.textContent.trim()==='\u5F00\u59CB\u914D\u7F6E';}); if(b) b.click(); })()`);
        const found = await waitFor("detect found", `var p=document.querySelector('.wizard-card.wizard-page-detect');
          if(!p) return {ok:false, detail:'detect page not shown'};
          var t=p.textContent;
          var ok1=t.indexOf('\u68C0\u6D4B\u5230\u5DF2\u5B89\u88C5 hmharness v')>=0;
          var ok2=t.indexOf('\u9ED8\u8BA4\u5171\u4EAB\u4F7F\u7528\u5B83(\u63A8\u8350)')>=0;
          var radio=p.querySelector('.wizard-opt.on');
          return {ok: ok1&&ok2&&!!radio, detail: t.replace(/\\s+/g,' ').slice(0,90)};`, 2e4);
        await shot("wizard-real-detect");
        return found;
      });
    } else if (process.env.HMH_DESKTOP_UIVERIFY_WIZARD === "install") {
      await step("\u5411\u5BFC(\u771F\u5B9E):\u68C0\u6D4B\u2192\u4ECD\u8981\u4E0B\u8F7D\u65B0\u7248\u2192\u9009\u62E9\u2460\u2192\u8FDB\u5165\u5B89\u88C5\u9875", async () => {
        const w = await waitFor("wizard overlay", `var o=document.querySelector('.wizard-overlay');
          return {ok: !!o, detail: o ? 'open' : 'closed'};`, 12e3);
        if (!w[0]) return w;
        await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.wizard-overlay button')).find(function(x){return x.textContent.trim()==='\u5F00\u59CB\u914D\u7F6E';}); if(b) b.click(); })()`);
        const found = await waitFor("detect found", `var p=document.querySelector('.wizard-card.wizard-page-detect');
          return {ok: !!p && p.textContent.indexOf('\u68C0\u6D4B\u5230\u5DF2\u5B89\u88C5 hmharness v')>=0, detail: p ? p.textContent.replace(/\\s+/g,' ').slice(0,60) : 'no detect page'};`, 2e4);
        if (!found[0]) return found;
        await js(`(function(){ var o=[].slice.call(document.querySelectorAll('.wizard-opt')).find(function(x){return x.textContent.indexOf('\u4ECD\u8981\u4E0B\u8F7D\u65B0\u7248')>=0;}); if(o) o.click(); })()`);
        await sleep(200);
        await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.wizard-overlay button')).find(function(x){return x.textContent.trim()==='\u4E0B\u4E00\u6B65';}); if(b) b.click(); })()`);
        const sel = await waitFor("select page \u2460 on", `var p=document.querySelector('.wizard-card.wizard-page-select');
          var on=p?p.querySelector('.wizard-opt.on'):null;
          return {ok: !!p && !!on && on.textContent.indexOf('\u4E0B\u8F7D\u5B89\u88C5\u5B8C\u6574 hmh CLI')>=0, detail: p ? 'select \u2460 on' : 'no select'};`, 8e3);
        if (!sel[0]) return sel;
        await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.wizard-overlay button')).find(function(x){return x.textContent.trim()==='\u5F00\u59CB\u5B89\u88C5';}); if(b) b.click(); })()`);
        return waitFor("install page", `var p=document.querySelector('.wizard-card.wizard-page-install');
          return {ok: !!p, detail: p ? 'installing' : 'not shown'};`, 8e3);
      });
      await step("\u5411\u5BFC(\u771F\u5B9E):\u5B89\u88C5\u8FDB\u5EA6\u53EF\u89C1(\u6B65\u9AA4\u6587\u6848/\u4E0B\u8F7D\u767E\u5206\u6BD4\u6EDA\u52A8)", async () => {
        const w = await waitFor("progress visible", `var bar=document.querySelector('.wizard-progress');
          var log=document.querySelector('.wizard-install-log');
          var lines=log?log.textContent.split('\\n').filter(function(x){return x.trim()!=='';}):[];
          return {ok: !!bar && lines.length>=1, detail: 'bar='+(bar?'y':'n')+' lines='+lines.length+(lines.length>0?(' last='+(lines[lines.length-1]||'').slice(0,50)):'')};`, 6e4);
        await shot("wizard-real-install");
        return w;
      });
      await step("\u5411\u5BFC(\u771F\u5B9E):\u5B89\u88C5\u5B8C\u6210\u2192\u914D\u7F6E\u8DF3\u8FC7(\u5DF2\u6709\u5BC6\u94A5)\u2192\u5B8C\u6210\u9875\u2192\u5F00\u59CB\u4F7F\u7528\u2192\u65B0 runtime \u8FDE\u63A5", async () => {
        await waitFor("done page", `var d=document.querySelector('.wizard-card.wizard-page-done');
          if(d) return {ok:true, detail:'done'};
          var c=document.querySelector('.wizard-card.wizard-page-config');
          if(c){ var s=[].slice.call(document.querySelectorAll('.wizard-overlay button')).find(function(x){return x.textContent.indexOf('\u8DF3\u8FC7')>=0;}); if(s) s.click(); }
          var err=document.querySelector('.wizard-error');
          if(err) return {ok:false, detail:'install error: '+err.textContent.slice(0,80)};
          return {ok:false, detail:'installing\u2026'};`, 8 * 6e4);
        const w = await waitFor("done ready text", `var d=document.querySelector('.wizard-card.wizard-page-done');
          var t=d?d.textContent:'';
          return {ok: !!d && t.indexOf('\u5C31\u7EEA')>=0, detail: t.replace(/\\s+/g,' ').slice(0,60)};`, 1e4);
        if (!w[0]) return w;
        await shot("wizard-real-done");
        await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.wizard-overlay button')).find(function(x){return x.textContent.trim()==='\u5F00\u59CB\u4F7F\u7528';}); if(b) b.click(); })()`);
        const connected = await waitFor("new runtime connected", `var dot=document.querySelector('.host-dot.on');
          var l=document.querySelector('.host-label');
          return {ok: !!dot && !!l && l.textContent.indexOf('runtime')>=0, detail: 'dot='+(dot?'on':'off')+' label='+(l?l.textContent.replace(/\\s+/g,' ').slice(0,50):'none')};`, 6e4);
        const st = await js(`window.hmh.getState().then(function(r){return JSON.stringify({mode:r.mode, runtimeEntry:r.runtimeEntry});})`);
        const p = JSON.parse(st);
        const entryOk = (p.runtimeEntry ?? "").indexOf(".hmharness-global") >= 0;
        await shot("wizard-real-final");
        return [connected[0] && entryOk, `connected: ${connected[1]}; state=${st.slice(0, 90)}`];
      });
    }
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

// apps/desktop/electron/main/visualregression.ts
import { app as app2 } from "electron";
import { mkdir as mkdir2, writeFile as writeFile2 } from "node:fs/promises";
import { join as join2 } from "node:path";
var sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
var MASK_SELECTORS = [
  { sel: ".host-label", reason: "host \u7AEF\u53E3/\u7248\u672C(fake host \u6BCF\u6B21\u968F\u673A\u7AEF\u53E3)" },
  { sel: ".session-time", reason: "\u4F1A\u8BDD\u65F6\u95F4\u6233" },
  { sel: ".turn-sum", reason: "\u56DE\u5408/token \u8BA1\u6570" }
];
var VIEWPORT_W = 1280;
var VIEWPORT_H = 800;
async function runVisualRegression(win) {
  const out = process.env.HMH_DESKTOP_VISREG_OUT ?? join2(app2.getPath("temp"), "hmh-visreg");
  const mutate = process.env.HMH_DESKTOP_VISREG_MUTATE ?? "";
  await mkdir2(out, { recursive: true }).catch(() => void 0);
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const waitFor = async (label, predicateCode, timeoutMs) => {
    const started = Date.now();
    for (; ; ) {
      const r = await js(`(function(){ try { return JSON.stringify((function(){ ${predicateCode} })()); } catch(e){ return JSON.stringify({ok:false, detail:String(e).slice(0,120)}); } })()`);
      let parsed;
      try {
        parsed = JSON.parse(r);
      } catch {
        parsed = {};
      }
      if (parsed.ok === true) return;
      if (Date.now() - started > timeoutMs) {
        console.log(`VISREG-CAPTURE FAIL | wait ${label} timeout`);
        app2.exit(1);
        return;
      }
      await sleep2(250);
    }
  };
  try {
    win.setBounds({ width: VIEWPORT_W, height: VIEWPORT_H });
  } catch {
  }
  await sleep2(400);
  await js(`(function(){ try { localStorage.setItem('hmh.theme', 'light'); localStorage.setItem('hmh.locale', 'zh'); } catch (e) {} return 'ok'; })()`);
  win.webContents.reload();
  await waitFor("mounted", `var t=document.querySelector('.composer textarea'); return {ok: !!t, detail: t ? 'up' : 'down'};`, 2e4);
  await waitFor("host dot on", `var d=document.querySelector('.host-dot'); return {ok: !!d && d.classList.contains('on'), detail: d ? d.className : 'none'};`, 3e4);
  await sleep2(1200);
  await js(`(function(){ var g=document.querySelector('.runtime-guide'); if(!g) return 'no-guide';
    var b=document.querySelector('.runtime-guide-actions .btn.ghost'); if(b) b.click(); return 'dismissed'; })()`);
  await waitFor("guide closed", `return {ok: !document.querySelector('.runtime-guide'), detail: 'closed'};`, 5e3);
  const viewports = [
    { name: "main", setup: async () => {
    } },
    {
      name: "settings",
      setup: async () => {
        await js(`(function(){ window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, shiftKey: true, bubbles: true })); })()`);
        await waitFor("settings open", `return {ok: !!document.querySelector('.cmdk.settings'), detail: 'open'};`, 5e3);
      }
    },
    {
      name: "dock",
      setup: async () => {
        await js(`(function(){ window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); })()`);
        await waitFor("settings closed", `return {ok: !document.querySelector('.cmdk.settings'), detail: 'closed'};`, 5e3);
        await js(`(function(){ var t=document.querySelectorAll('.dock-tab')[1]; if(t) t.click(); })()`);
        await waitFor("files rows", `var r=document.querySelectorAll('.fs-row'); return {ok: r.length >= 1, detail: 'rows=' + r.length};`, 5e3);
      }
    }
  ];
  const meta = {
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    window: { width: VIEWPORT_W, height: VIEWPORT_H },
    mutate,
    viewports: []
  };
  for (const v of viewports) {
    await v.setup();
    await js(`(function(){ var a=document.activeElement; if(a && a.blur) a.blur(); })()`);
    await sleep2(600);
    if (mutate === v.name) {
      await js(`(function(){ var d=document.createElement('div'); d.setAttribute('data-visreg-mutate','1');
        d.style.cssText='position:fixed;left:560px;top:300px;width:120px;height:90px;background:rgb(255,0,0);z-index:9999;';
        document.body.appendChild(d); })()`);
      await sleep2(150);
    }
    const img = await win.webContents.capturePage();
    const size = img.getSize();
    if (mutate === v.name) {
      await js(`(function(){ var d=document.querySelector('[data-visreg-mutate]'); if(d) d.remove(); })()`);
    }
    const innerW = await js("window.innerWidth") || size.width;
    const dpr = size.width / innerW;
    const masks = [];
    for (const m of MASK_SELECTORS) {
      const rects = await js(`(function(){ return JSON.stringify([].slice.call(document.querySelectorAll('${m.sel}')).map(function(el){
        var r=el.getBoundingClientRect(); return { x:r.x, y:r.y, w:r.width, h:r.height };
      }).filter(function(r){ return r.w > 0 && r.h > 0 && r.y >= 0 && r.y < window.innerHeight; })) })()`);
      let list = [];
      try {
        list = JSON.parse(rects);
      } catch {
      }
      for (const r of list) {
        masks.push({ x: Math.round(r.x * dpr), y: Math.round(r.y * dpr), w: Math.round(r.w * dpr), h: Math.round(r.h * dpr), for: m.reason });
      }
    }
    const file = `${v.name}.png`;
    await writeFile2(join2(out, file), img.toPNG());
    meta.viewports.push({ name: v.name, file, width: size.width, height: size.height, dpr: Math.round(dpr * 100) / 100, masks });
    console.log(`VISREG-CAPTURE ${v.name} ${size.width}x${size.height} masks=${masks.length}${mutate === v.name ? " MUTATED" : ""}`);
  }
  await writeFile2(join2(out, "meta.json"), JSON.stringify(meta, null, 2));
  console.log("VISREG-CAPTURE DONE");
  app2.exit(0);
}
function attachVisualRegression(win) {
  win.webContents.once("did-finish-load", () => {
    setTimeout(() => {
      void runVisualRegression(win);
    }, 1500);
  });
}

// apps/desktop/electron/main/installer.ts
import { spawn as spawn2 } from "node:child_process";
import { existsSync, mkdirSync, rmSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as join3 } from "node:path";

// packages/cli-installer/src/index.ts
import { createHash } from "node:crypto";
function cmpSemver(a, b) {
  const pa = a.replace(/^v/, "").split("-")[0].split(".").map(Number);
  const pb = b.replace(/^v/, "").split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
function satisfies(range, version) {
  const r = range.trim();
  if (r === "" || r === "*" || r === "latest" || r === "x") return true;
  if (r === version) return true;
  const bound = /^(\^|~|>=?)\s*(\d+)\.(\d+)\.(\d+)/.exec(r);
  if (bound !== null) {
    const op = bound[1];
    const major = Number(bound[2]);
    const minor = Number(bound[3]);
    const patch = Number(bound[4]);
    const c = cmpSemver(version, `${major}.${minor}.${patch}`);
    if (c < 0) return false;
    if (op === ">=") return true;
    if (op === "~") return cmpSemver(version, `${major}.${minor + 1}.0`) < 0;
    if (major === 0) return minor === 0 ? cmpSemver(version, `0.0.${patch + 1}`) < 0 : cmpSemver(version, `0.${minor + 1}.0`) < 0;
    return cmpSemver(version, `${major + 1}.0.0`) < 0;
  }
  return false;
}
function pickVersion(doc, spec) {
  const s = spec.trim();
  const tag = s === "" || s === "latest" || s === "*" ? doc["dist-tags"]?.latest : void 0;
  if (tag !== void 0 && doc.versions[tag] !== void 0) return tag;
  if (doc.versions[s] !== void 0) return s;
  let best = "";
  for (const v of Object.keys(doc.versions)) {
    if (satisfies(s, v) && cmpSemver(v, best) > 0) best = v;
  }
  return best;
}
async function resolveClosure(root, getPackument) {
  const resolved = /* @__PURE__ */ new Map();
  const queue = [root];
  while (queue.length > 0) {
    const { name, spec } = queue.shift();
    if (resolved.has(name)) continue;
    const doc = await getPackument(name);
    const version = pickVersion(doc, spec);
    const meta = version !== "" ? doc.versions[version] : void 0;
    if (meta === void 0 || meta.dist?.tarball === void 0) {
      throw new Error(`no version of ${name} satisfies ${spec || "latest"}`);
    }
    const item = {
      version,
      dependencies: meta.dependencies ?? {},
      tarball: meta.dist.tarball,
      integrity: meta.dist.integrity
    };
    resolved.set(name, item);
    for (const [dep, range] of Object.entries(item.dependencies)) {
      if (!resolved.has(dep)) queue.push({ name: dep, spec: range });
    }
  }
  return [...resolved.entries()].map(([name, m]) => ({ name, version: m.version, tarball: m.tarball, integrity: m.integrity }));
}
var REGISTRY_HOSTS = /^(https?:\/\/[^/]+)\/(.*)$/;
function tarballMirrors(tarball, registries) {
  const m = REGISTRY_HOSTS.exec(tarball);
  const path = m?.[2] ?? "";
  const out = [tarball];
  for (const reg of registries) {
    const base = reg.replace(/\/+$/, "");
    if (base === m?.[1]) continue;
    const u = `${base}/${path}`;
    if (!out.includes(u)) out.push(u);
  }
  return out;
}
function moduleDir(prefix, name) {
  const parts = name.split("/").filter((p) => p !== "" && p !== ".");
  if (name.startsWith("@") && parts.length !== 2) throw new Error(`invalid package name: ${name}`);
  if (!name.startsWith("@") && parts.length !== 1) throw new Error(`invalid package name: ${name}`);
  return [...parts].reduce((dir, p) => `${dir}\\${p}`, `${prefix}\\node_modules`);
}
function integrityOk(data, integrity) {
  if (integrity === void 0 || integrity === "") return true;
  const m = /^sha512-([A-Za-z0-9+/=]+)$/.exec(integrity.trim());
  if (m === null) return true;
  return createHash("sha512").update(data).digest("base64") === m[1];
}
function bytesLabel(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// apps/desktop/electron/main/installer.ts
var REGISTRIES = {
  npmjs: "https://registry.npmjs.org",
  npmmirror: "https://registry.npmmirror.com"
};
function installTarget() {
  return join3(homedir(), ".hmharness-global");
}
function resolveInstalledEntry(target) {
  const nested = join3(target, "node_modules", "@hmharness", "cli", "node_modules", "@hmharness", "web", "dist", "desktop-host.js");
  const hoisted = join3(target, "node_modules", "@hmharness", "web", "dist", "desktop-host.js");
  if (existsSync(nested)) return nested;
  if (existsSync(hoisted)) return hoisted;
  return "";
}
var running = false;
function startCliInstall(host, opts = {}) {
  if (running) return { ok: false, error: "\u5B89\u88C5\u5DF2\u5728\u8FDB\u884C\u4E2D" };
  running = true;
  const finish = (p) => {
    host.sendProgress(p);
    running = false;
  };
  const fail = (text, err) => {
    host.log(`install failed: ${text} ${String(err).slice(0, 180)}`);
    finish({ phase: "error", text, error: `${text}:${String(err).slice(0, 160)}` });
  };
  void (async () => {
    const target = installTarget();
    try {
      mkdirSync(target, { recursive: true });
      const npmOk = opts.forceTgz === true ? false : await probeNpm(host);
      if (npmOk) await installViaNpm(host, target, opts);
      else await installViaTarballs(host, target, opts);
    } catch (err) {
      fail("\u5B89\u88C5\u5931\u8D25", err);
    }
  })();
  return { ok: true };
}
async function probeNpm(host) {
  host.sendProgress({ phase: "check", text: "\u68C0\u67E5 npm\u2026" });
  const ok = await new Promise((resolve2) => {
    const c = spawn2("npm", ["--version"], { windowsHide: true, stdio: "ignore" });
    const t = setTimeout(() => {
      try {
        c.kill();
      } catch {
      }
      resolve2(false);
    }, 15e3);
    c.on("error", () => {
      clearTimeout(t);
      resolve2(false);
    });
    c.on("exit", (code) => {
      clearTimeout(t);
      resolve2(code === 0);
    });
  });
  host.log(`npm ${ok ? "available" : "unavailable"} \u2192 ${ok ? "npm prefix" : "tgz"} path`);
  return ok;
}
async function installViaNpm(host, target, opts) {
  host.sendProgress({ phase: "npm", text: `npm install @hmharness/cli \u2192 ${target}(\u4EC5\u7528\u6237\u76EE\u5F55)` });
  const registry = opts.mirrorFirst === "npmmirror" ? ["--registry", REGISTRIES.npmmirror] : opts.mirrorFirst === "npmjs" ? ["--registry", REGISTRIES.npmjs] : [];
  const args = ["install", "--prefix", target, "--no-audit", "--no-fund", "--loglevel", "notice", ...registry, "@hmharness/cli@latest"];
  const code = await new Promise((resolve2, reject) => {
    const c = spawn2("npm", args, { windowsHide: true, cwd: homedir() });
    let last = "";
    const onLine = (d) => {
      for (const raw of d.toString().split(/\r?\n/)) {
        const line = raw.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 180);
        if (line === "" || line === last) continue;
        last = line;
        host.sendProgress({ phase: "npm", text: line });
      }
    };
    c.stdout?.on("data", onLine);
    c.stderr?.on("data", onLine);
    c.on("error", reject);
    const killer = setTimeout(() => {
      try {
        c.kill();
      } catch {
      }
      reject(new Error("npm \u5B89\u88C5\u8D85\u65F6(8 \u5206\u949F)"));
    }, 8 * 6e4);
    c.on("exit", (x) => {
      clearTimeout(killer);
      resolve2(x ?? 1);
    });
  });
  if (code !== 0) throw new Error(`npm install \u9000\u51FA\u7801 ${code}`);
  const entry = resolveInstalledEntry(target);
  if (entry === "") throw new Error("npm \u5B89\u88C5\u5B8C\u6210\u4F46\u672A\u627E\u5230 desktop-host \u5165\u53E3");
  writeStamp(target, "npm");
  finishInstall(host, entry, "npm");
}
async function installViaTarballs(host, target, opts) {
  const order = opts.mirrorFirst === "npmmirror" ? ["npmmirror", "npmjs"] : ["npmjs", "npmmirror"];
  const mirrors = order.map((k) => REGISTRIES[k]);
  host.sendProgress({ phase: "meta", text: "\u89E3\u6790\u4F9D\u8D56\u6E05\u5355(@hmharness/cli \u5168\u5BB6)\u2026" });
  const packuments = /* @__PURE__ */ new Map();
  const getPackument = async (name) => {
    const hit = packuments.get(name);
    if (hit !== void 0) return hit;
    let lastErr = "";
    for (const m of mirrors) {
      try {
        const r = await fetch(`${m}/${encodeURIComponent(name)}`, {
          headers: { accept: "application/vnd.npm.install-v1+json" },
          signal: AbortSignal.timeout(25e3)
        });
        if (!r.ok) {
          lastErr = `HTTP ${r.status}`;
          continue;
        }
        const doc = await r.json();
        if (doc.versions === void 0) {
          lastErr = "malformed packument";
          continue;
        }
        packuments.set(name, doc);
        return doc;
      } catch (err) {
        lastErr = String(err).slice(0, 60);
      }
    }
    throw new Error(`\u83B7\u53D6 ${name} \u5143\u6570\u636E\u5931\u8D25(\u5168\u90E8\u955C\u50CF:${lastErr})`);
  };
  const closure = await resolveClosure({ name: "@hmharness/cli", spec: "latest" }, getPackument);
  const root = closure.find((p) => p.name === "@hmharness/cli");
  host.log(`closure: ${closure.length} packages (root @hmharness/cli@${root?.version ?? "?"})`);
  host.sendProgress({ phase: "meta", text: `\u4F9D\u8D56\u6E05\u5355\u5C31\u7EEA:${closure.length} \u4E2A\u5305(@hmharness/cli@${root?.version ?? "?"})` });
  const staging = join3(target, ".staging");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  for (let i = 0; i < closure.length; i++) {
    const pkg = closure[i];
    const urls = tarballMirrors(pkg.tarball, mirrors);
    let buf = null;
    let usedMirror = "";
    let lastErr = "";
    for (const u of urls) {
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(3e5) });
        if (!r.ok) {
          lastErr = `HTTP ${r.status}`;
          continue;
        }
        const total = Number(r.headers.get("content-length") ?? "0");
        const reader = r.body?.getReader();
        if (reader === void 0) throw new Error("no body");
        const chunks = [];
        let got = 0;
        let lastEmit = 0;
        for (; ; ) {
          const { done, value } = await reader.read();
          if (done === true) break;
          const b = Buffer.from(value);
          chunks.push(b);
          got += b.length;
          if (got - lastEmit > 256 * 1024) {
            lastEmit = got;
            host.sendProgress({
              phase: "download",
              pct: Math.round((i + Math.min(got / (total || got), 1)) / closure.length * 100),
              text: `\u4E0B\u8F7D ${pkg.name}@${pkg.version}(${i + 1}/${closure.length})\xB7 ${bytesLabel(got)}${total > 0 ? ` / ${bytesLabel(total)}` : ""}`,
              mirror: new URL(u).host
            });
          }
        }
        buf = Buffer.concat(chunks);
        if (!integrityOk(buf, pkg.integrity)) {
          lastErr = "integrity \u4E0D\u5339\u914D";
          buf = null;
          continue;
        }
        usedMirror = new URL(u).host;
        break;
      } catch (err) {
        lastErr = String(err).slice(0, 60);
      }
    }
    if (buf === null) throw new Error(`\u4E0B\u8F7D ${pkg.name} \u5931\u8D25(\u5168\u90E8\u955C\u50CF:${lastErr})`);
    const tgz = join3(staging, `${i}.tgz`);
    writeFileSync(tgz, buf);
    host.sendProgress({
      phase: "download",
      pct: Math.round((i + 1) / closure.length * 100),
      text: `\u4E0B\u8F7D ${pkg.name}@${pkg.version} \u5B8C\u6210(${bytesLabel(buf.length)},via ${usedMirror})`,
      mirror: usedMirror
    });
  }
  host.sendProgress({ phase: "extract", text: "\u89E3\u538B\u5E76\u5E03\u5C40 node_modules\u2026" });
  for (let i = 0; i < closure.length; i++) {
    const pkg = closure[i];
    await extractTgz(join3(staging, `${i}.tgz`), staging, pkg);
    host.sendProgress({ phase: "extract", pct: Math.round((i + 1) / closure.length * 100), text: `\u89E3\u538B ${pkg.name}(${i + 1}/${closure.length})` });
  }
  rmSync(staging, { recursive: true, force: true });
  const entry = resolveInstalledEntry(target);
  if (entry === "") throw new Error("tgz \u5B89\u88C5\u5B8C\u6210\u4F46\u672A\u627E\u5230 desktop-host \u5165\u53E3");
  writeStamp(target, "tgz");
  finishInstall(host, entry, "tgz");
}
async function extractTgz(tgz, staging, pkg) {
  const exDir = join3(staging, `x-${pkg.name.replace(/[^\w.-]/g, "_")}`);
  rmSync(exDir, { recursive: true, force: true });
  mkdirSync(exDir, { recursive: true });
  const code = await new Promise((resolve2, reject) => {
    const c = spawn2("tar", ["-xzf", tgz, "-C", exDir], { windowsHide: true, stdio: "ignore" });
    c.on("error", reject);
    c.on("exit", (x) => resolve2(x ?? 1));
  });
  if (code !== 0) throw new Error(`tar \u89E3\u538B ${pkg.name} \u5931\u8D25(\u9000\u51FA\u7801 ${code})`);
  const dest = moduleDir(installTarget(), pkg.name);
  const parent = dest.slice(0, dest.lastIndexOf("\\"));
  mkdirSync(parent, { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  renameSync(join3(exDir, "package"), dest);
  rmSync(exDir, { recursive: true, force: true });
}
function writeStamp(target, via) {
  try {
    writeFileSync(join3(target, "installed-by-hmh-desktop.json"), JSON.stringify({ via, at: (/* @__PURE__ */ new Date()).toISOString() }, null, 2), "utf8");
  } catch {
  }
}
function finishInstall(host, entry, via) {
  host.log(`install done via ${via}: ${entry}`);
  host.sendProgress({ phase: "done", text: `\u5B89\u88C5\u5B8C\u6210(${via})`, entry });
  host.onInstalled(entry, via);
  running = false;
}

// apps/desktop/electron/main/updater-channels.ts
var githubLatest = (repo) => `https://api.github.com/repos/${repo}/releases/latest`;
var CHECK_CHANNELS = [
  { id: "direct", label: "\u76F4\u8FDE", timeoutMs: 8e3, apiUrl: githubLatest, downloadPrefix: "" },
  { id: "gh-proxy", label: "gh-proxy", timeoutMs: 1e4, apiUrl: (repo) => `https://gh-proxy.com/${githubLatest(repo)}`, downloadPrefix: "https://gh-proxy.com/" },
  { id: "ghfast", label: "ghfast", timeoutMs: 1e4, apiUrl: (repo) => `https://ghfast.top/${githubLatest(repo)}`, downloadPrefix: "https://ghfast.top/" }
];
var DOWNLOAD_MIRROR_PREFIXES = ["", "https://ghfast.top/", "https://gh-proxy.com/", "https://ghproxy.cn/"];
function normalizeChannel(v) {
  return typeof v === "string" && CHECK_CHANNELS.some((c) => c.id === v) ? v : null;
}
function orderedCheckChannels(sticky) {
  const s = normalizeChannel(sticky);
  const first = s === null ? void 0 : CHECK_CHANNELS.find((c) => c.id === s);
  if (first === void 0) return CHECK_CHANNELS;
  return [first, ...CHECK_CHANNELS.filter((c) => c.id !== s)];
}
function orderedDownloadMirrors(assetUrl, channel) {
  const hit = normalizeChannel(channel);
  const prefix = hit === null ? "" : CHECK_CHANNELS.find((c) => c.id === hit)?.downloadPrefix ?? "";
  const prefixes = [.../* @__PURE__ */ new Set([prefix, ...DOWNLOAD_MIRROR_PREFIXES])];
  return prefixes.map((p) => p === "" ? assetUrl : `${p}${assetUrl}`);
}
function summarizeCheckFailures(failures) {
  return failures.map((f) => `${f.label}:${f.reason}`).join("; ");
}

// apps/desktop/electron/main/index.ts
var here = import.meta.dirname ?? ".";
var isDev = process.env.HMH_DESKTOP_DEV === "1";
var rendererDevUrl = process.env.HMH_DESKTOP_RENDERER_URL ?? "";
var preloadPath = join4(here, "../preload/index.cjs");
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
if (!app3.requestSingleInstanceLock()) {
  app3.quit();
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
        app3.quit();
      } }
    ]));
  }, notifyEvent2 = function(env) {
    if (process.env.HMH_DESKTOP_UIVERIFY === "1" || process.env.HMH_DESKTOP_SNAPSHOT !== void 0 || process.env.HMH_DESKTOP_RENDER_TEST === "1" || process.env.HMH_DESKTOP_VISREG === "1") return;
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
    const child = spawn3(`"${installerPath}" /S /D=${installDir}`, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: false,
      windowsVerbatimArguments: true
    });
    child.unref();
    logInfo("update", `apply: ${installerPath} \u2192 ${installDir}`);
    app3.exit(0);
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
            detail: `app v${app3.getVersion()} \xB7 \u66F4\u65B0\u901A\u9053:${updateState.channel || "-"}
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
    const candidates = process.platform === "win32" ? [join4(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "hmharness-web-daemon.cmd")] : process.platform === "darwin" ? [join4(home, "Library", "LaunchAgents", "hmharness-web-daemon.plist")] : [join4(home, ".config", "systemd", "user", "hmharness-web-daemon.service")];
    return candidates.some((p) => {
      try {
        return existsSync2(p);
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
    if (runtimeEntry === "" || runtimeEntry === null) return "";
    try {
      const p = join4(repoRootOf2(runtimeEntry), "packages", "cli", "src", "main.ts");
      if (existsSync2(p)) return p;
    } catch {
    }
    let dir = dirname(runtimeEntry);
    for (let i = 0; i < 8; i++) {
      if (existsSync2(join4(dir, "dist", "main.js")) && pkgNameAt2(dir) === "@hmharness/cli") return join4(dir, "dist", "main.js");
      if (basename(dir) === "@hmharness" && existsSync2(join4(dir, "cli", "dist", "main.js"))) return join4(dir, "cli", "dist", "main.js");
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return "";
  }, runCli2 = function(args) {
    const entry = cliEntryOf2();
    if (entry === "") return;
    const isTs = entry.endsWith(".ts");
    const repo = repoRootOf2(runtimeEntry ?? entry);
    const child = spawn3(process.execPath, isTs ? ["--import", "tsx", entry, ...args] : [entry, ...args], {
      cwd: isTs ? repo : dirname(entry),
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
  }, pkgVersionAt2 = function(dir) {
    try {
      const v = JSON.parse(readFileSync(join4(dir, "package.json"), "utf8"));
      return typeof v.version === "string" ? v.version : "";
    } catch {
      return "";
    }
  }, pkgNameAt2 = function(dir) {
    try {
      const v = JSON.parse(readFileSync(join4(dir, "package.json"), "utf8"));
      return typeof v.name === "string" ? v.name : "";
    } catch {
      return "";
    }
  }, entryFromCliDir2 = function(cliDir) {
    const nested = join4(cliDir, "node_modules", "@hmharness", "web", "dist", "desktop-host.js");
    if (existsSync2(nested)) return nested;
    const hoisted = join4(dirname(cliDir), "web", "dist", "desktop-host.js");
    if (existsSync2(hoisted)) return hoisted;
    return "";
  }, detectExternalRuntime2 = function() {
    const envEntry = process.env.HMH_DESKTOP_REAL_ENTRY;
    if (envEntry !== void 0 && envEntry !== "" && isAbsolute(envEntry)) {
      return { entry: envEntry, version: "", source: "env" };
    }
    const whereRepos = /* @__PURE__ */ new Set();
    const whereClis = [];
    const npmRepos = /* @__PURE__ */ new Set();
    let npmCli = "";
    try {
      const out = execFileSync("where", ["hmh"], { encoding: "utf8", timeout: 4e3, windowsHide: true });
      for (const line of out.split(/\r?\n/)) {
        const bin = line.trim();
        if (bin === "") continue;
        try {
          const binDir = dirname(bin);
          const linked = join4(binDir, "node_modules", "hmharness");
          if (existsSync2(linked)) whereRepos.add(realpathSync2(linked));
          const cli = join4(binDir, "node_modules", "@hmharness", "cli");
          if (existsSync2(cli)) whereClis.push(cli);
        } catch {
        }
      }
    } catch {
    }
    try {
      const out = execFileSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 6e3, windowsHide: true });
      const root = out.trim();
      const linked = join4(root, "hmharness");
      if (existsSync2(linked)) npmRepos.add(realpathSync2(linked));
      const cli = join4(root, "@hmharness", "cli");
      if (existsSync2(cli)) npmCli = cli;
    } catch {
    }
    for (const [cli, source] of [[whereClis[0] ?? "", "where-hmh"], [npmCli, "npm-global"]]) {
      if (cli === "") continue;
      const entry = entryFromCliDir2(cli);
      if (entry !== "") return { entry, version: pkgVersionAt2(cli), source };
    }
    const wizardEntry = resolveInstalledEntry(installTarget());
    if (wizardEntry !== "") {
      return { entry: wizardEntry, version: pkgVersionAt2(join4(installTarget(), "node_modules", "@hmharness", "cli")), source: "wizard-install" };
    }
    const repos = /* @__PURE__ */ new Set([...whereRepos, ...npmRepos]);
    const bases = ["C:\\", "D:\\", "E:\\", "F:\\", "G:\\", "H:\\", homedir2(), join4(homedir2(), "Developer")];
    for (const base of bases) {
      try {
        const p = resolve(base, "hmharness");
        if (existsSync2(p)) repos.add(p);
      } catch {
      }
    }
    for (const repo of repos) {
      const entry = join4(repo, "packages", "web", "src", "desktop-host.ts");
      if (existsSync2(entry) && existsSync2(join4(repo, "node_modules"))) {
        return { entry, version: pkgVersionAt2(repo), source: "source-repo" };
      }
    }
    return { entry: "", version: "", source: "" };
  }, detectRealEntry2 = function() {
    return detectExternalRuntime2().entry;
  }, repoRootOf2 = function(entry) {
    let dir = dirname(entry);
    for (let i = 0; i < 6; i++) {
      if (existsSync2(join4(dir, "package.json")) && existsSync2(join4(dir, "packages", "web"))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return dirname(entry);
  }, bundledRuntimePath2 = function(repoRoot) {
    return join4(app3.isPackaged ? process.resourcesPath : join4(repoRoot, "apps", "desktop", "resources"), "runtime", "runtime.cjs");
  }, bundledRuntimeInfo2 = function() {
    const repoRoot = join4(here, "..", "..", "..", "..");
    const p = bundledRuntimePath2(repoRoot);
    let version = "";
    try {
      const v = JSON.parse(readFileSync(join4(dirname(p), "package.json"), "utf8"));
      version = typeof v.version === "string" ? v.version : "";
    } catch {
    }
    return { ready: existsSync2(p), version };
  }, npmOnPath2 = function() {
    try {
      execFileSync("where", ["npm"], { encoding: "utf8", timeout: 4e3, windowsHide: true });
      return true;
    } catch {
      return false;
    }
  }, wizardSuppressed2 = function() {
    if (process.env.HMH_DESKTOP_WIZARD_FORCE === "1") return false;
    return isDev || process.env.HMH_DESKTOP_UIVERIFY === "1" || process.env.HMH_DESKTOP_SNAPSHOT !== void 0 || process.env.HMH_DESKTOP_VISREG === "1" || process.env.HMH_DESKTOP_RENDER_TEST === "1" || process.env.HMH_DESKTOP_DOMPROBE === "1" || process.env.HMH_DESKTOP_SECURITY_TEST === "1" || process.env.HMH_DESKTOP_FAKE === "1";
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
        await writeFile3(r.filePath, md, "utf8");
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
    ipcMain.handle("bridge:runtime-info", async (event) => {
      if (!senderTrusted2(event.senderFrame)) return { error: "untrusted sender", code: "FORBIDDEN" };
      const d = detectExternalRuntime2();
      const cfg = await loadRuntimeConfig();
      return {
        mode: bridge.mode,
        runtimeEntry: bridge.runtimeEntry,
        override: cfg.entry,
        demo: cfg.demo,
        detected: d.entry,
        detectedVersion: d.version,
        detectedSource: d.source
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
      if (e !== "" && (!isAbsolute(e) || !existsSync2(e))) {
        return { error: "\u5165\u53E3\u5FC5\u987B\u662F\u5B58\u5728\u7684\u7EDD\u5BF9\u8DEF\u5F84(desktop-host.ts)", code: "BAD_REQUEST" };
      }
      await saveRuntimeEntryOverride(e);
      sseAbort?.abort();
      if (supervisor !== null) await supervisor.stop();
      await startHost();
      return { ok: true, mode: bridge.mode };
    });
    ipcMain.handle("bridge:detect-runtime", (event) => {
      if (!senderTrusted2(event.senderFrame)) return { error: "untrusted sender", code: "FORBIDDEN" };
      const info = bundledRuntimeInfo2();
      if (process.env.HMH_DESKTOP_UIVERIFY_WIZARD === "fake" && process.env.HMH_DESKTOP_FAKE === "1") {
        if (process.env.HMH_DESKTOP_UIVERIFY_FAKE_DETECT_FOUND === "1") {
          return { found: true, version: "0.0.0-verify", entry: "verify://fake-entry", source: "verify", bundled: info, npm: npmOnPath2() };
        }
        return { found: false, version: "", entry: "", source: "", bundled: info, npm: npmOnPath2() };
      }
      const d = detectExternalRuntime2();
      return { found: d.entry !== "", version: d.version, entry: d.entry, source: d.source, bundled: info, npm: npmOnPath2() };
    });
    ipcMain.handle("bridge:install-cli", (event, opts) => {
      if (!senderTrusted2(event.senderFrame)) return { error: "untrusted sender", code: "FORBIDDEN" };
      const o = opts ?? {};
      if (process.env.HMH_DESKTOP_UIVERIFY_WIZARD === "fake" && process.env.HMH_DESKTOP_FAKE === "1") {
        const sendSim = (p) => {
          for (const w of BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed()) w.webContents.send("install:progress", p);
          }
        };
        void (async () => {
          sendSim({ phase: "check", text: "\u68C0\u67E5 npm\u2026(verify \u6A21\u62DF)" });
          await new Promise((r) => setTimeout(r, 400));
          sendSim({ phase: "npm", text: "npm install @hmharness/cli \u2192 ~/.hmharness-global(verify \u6A21\u62DF,\u4E0D\u843D\u76D8)" });
        })();
        return { ok: true, test: true };
      }
      return startCliInstall(
        {
          sendProgress: (p) => {
            logInfo("install", `${p.phase}${p.pct !== void 0 ? ` ${p.pct}%` : ""} ${p.text}`);
            for (const w of BrowserWindow.getAllWindows()) {
              if (!w.isDestroyed()) w.webContents.send("install:progress", p);
            }
          },
          log: (m) => {
            logInfo("install", m);
          },
          // 安装成功即持久化并热切换(向导随后收尾;中途取消也已生效)
          onInstalled: (entry) => {
            void (async () => {
              await saveRuntimeConfig({ entry, demo: false });
              sseAbort?.abort();
              if (supervisor !== null) await supervisor.stop();
              await startHost();
            })();
          }
        },
        {
          forceTgz: o.forceTgz === true,
          mirrorFirst: o.mirrorFirst === "npmmirror" ? "npmmirror" : o.mirrorFirst === "npmjs" ? "npmjs" : void 0
        }
      );
    });
    ipcMain.handle("bridge:get-wizard", async (event) => {
      if (!senderTrusted2(event.senderFrame)) return { error: "untrusted sender", code: "FORBIDDEN" };
      const variant = process.env.HMH_DESKTOP_UIVERIFY_WIZARD;
      if (variant !== void 0 && variant !== "") {
        const w2 = await loadWizardState();
        return { done: false, choice: "", suppressed: false, persisted: { done: w2.done, choice: w2.choice } };
      }
      const w = await loadWizardState();
      const cfg = await loadRuntimeConfig();
      return { done: w.done || cfg.entry !== "" || cfg.demo, choice: w.choice, suppressed: wizardSuppressed2() };
    });
    ipcMain.handle("bridge:wizard-complete", async (event, choice, entry) => {
      if (!senderTrusted2(event.senderFrame)) return { error: "untrusted sender", code: "FORBIDDEN" };
      const c = choice === "external" || choice === "install" || choice === "bundled" || choice === "demo" ? choice : "";
      if (c === "") return { error: "choice must be external|install|bundled|demo", code: "BAD_REQUEST" };
      const e = typeof entry === "string" ? entry : "";
      await saveWizardState(c);
      if (process.env.HMH_DESKTOP_FAKE === "1") return { ok: true, mode: bridge.mode, test: true };
      const repoRoot = join4(here, "..", "..", "..", "..");
      if (c === "external" || c === "bundled") {
        const target = c === "bundled" ? bundledRuntimePath2(repoRoot) : e;
        if (target === "" || !isAbsolute(target) || !existsSync2(target)) {
          return { error: "runtime \u5165\u53E3\u4E0D\u5B58\u5728", code: "BAD_REQUEST" };
        }
        await saveRuntimeConfig({ entry: target, demo: false });
      } else if (c === "demo") {
        await saveRuntimeConfig({ entry: "", demo: true });
      }
      if (c !== "install") {
        sseAbort?.abort();
        if (supervisor !== null) await supervisor.stop();
        await startHost();
      }
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
        app3.quit();
      })();
      return { ok: true };
    });
  };
  pushEvent = pushEvent2, focusMainWindow = focusMainWindow2, setupTray = setupTray2, notifyEvent = notifyEvent2, applyChrome = applyChrome2, applyUpdate = applyUpdate2, buildAppMenu = buildAppMenu2, popupMainMenu = popupMainMenu2, webAutostartInstalled = webAutostartInstalled2, lanIpOf = lanIpOf2, cliEntryOf = cliEntryOf2, runCli = runCli2, broadcastHostState = broadcastHostState2, pkgVersionAt = pkgVersionAt2, pkgNameAt = pkgNameAt2, entryFromCliDir = entryFromCliDir2, detectExternalRuntime = detectExternalRuntime2, detectRealEntry = detectRealEntry2, repoRootOf = repoRootOf2, bundledRuntimePath = bundledRuntimePath2, bundledRuntimeInfo = bundledRuntimeInfo2, npmOnPath = npmOnPath2, wizardSuppressed = wizardSuppressed2, senderTrusted = senderTrusted2, hostCall = hostCall2, registerIpc = registerIpc2;
  app3.on("second-instance", () => {
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
  let updateState = { checking: false, currentVersion: app3.getVersion(), latest: null, notes: "", downloaded: false, error: "", channel: "" };
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
  const updateChannelFile = () => join4(app3.getPath("userData"), "update-channel.json");
  async function loadStickyChannel() {
    try {
      const v = JSON.parse(await readFile(updateChannelFile(), "utf8"));
      return normalizeChannel(v.channel);
    } catch {
      return null;
    }
  }
  async function saveStickyChannel(id) {
    await writeFile3(updateChannelFile(), JSON.stringify({ channel: id }, null, 2), "utf8").catch(() => void 0);
  }
  async function checkForUpdates() {
    if (updateState.checking || updateState.downloaded) return updateState;
    bumpUpdate({ checking: true, error: "" });
    logInfo("update", `checking\u2026 (current v${app3.getVersion()})`);
    const failures = [];
    try {
      const sticky = await loadStickyChannel();
      const channels = orderedCheckChannels(sticky ?? void 0);
      for (const ch of channels) {
        let rel = null;
        try {
          const r = await fetch(ch.apiUrl(UPDATE_REPO), {
            headers: { "user-agent": "hmh-desktop-updater" },
            signal: AbortSignal.timeout(ch.timeoutMs)
          });
          if (!r.ok) {
            failures.push({ label: ch.label, reason: `HTTP ${r.status}` });
            logInfo("update", `${ch.label} \u2192 HTTP ${r.status}`);
            continue;
          }
          rel = await r.json();
          if (typeof rel?.tag_name !== "string" || rel.tag_name === "") {
            failures.push({ label: ch.label, reason: "\u54CD\u5E94\u65E0 tag_name" });
            logInfo("update", `${ch.label} \u2192 \u65E0 tag_name`);
            continue;
          }
        } catch (err) {
          const e = err;
          const reason = err instanceof Error && err.name === "TimeoutError" ? `\u8D85\u65F6(${Math.round(ch.timeoutMs / 1e3)}s)` : String(e.cause?.code ?? err).slice(0, 60);
          failures.push({ label: ch.label, reason });
          logInfo("update", `${ch.label} \u2192 fail ${reason}`);
          continue;
        }
        const tag = String(rel.tag_name);
        logInfo("update", `latest=${tag} assets=${(rel.assets ?? []).length} via ${ch.label}${sticky === ch.id ? "(sticky)" : ""}`);
        await saveStickyChannel(ch.id);
        bumpUpdate({ checking: false, latest: tag, notes: String(rel.body ?? "").slice(0, 600), channel: ch.id });
        if (cmpVersion(app3.getVersion(), tag) < 0 && !updateState.downloaded) {
          void downloadInstaller(rel.assets ?? []);
        }
        return updateState;
      }
      const summary = summarizeCheckFailures(failures);
      logInfo("update", `check failed: all channels (${summary})`);
      bumpUpdate({ checking: false, error: `\u5168\u90E8\u68C0\u67E5\u901A\u9053\u5931\u8D25(${summary})`.slice(0, 200) });
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
      const dest = join4(app3.getPath("temp"), asset.name);
      const mirrors = orderedDownloadMirrors(asset.browser_download_url, updateState.channel);
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
  const runtimeConfigFile = () => join4(app3.getPath("userData"), "runtime.json");
  async function loadRuntimeConfig() {
    try {
      const v = JSON.parse(await readFile(runtimeConfigFile(), "utf8"));
      return {
        entry: typeof v.entry === "string" && v.entry !== "" && isAbsolute(v.entry) ? v.entry : "",
        demo: v.demo === true
      };
    } catch {
      return { entry: "", demo: false };
    }
  }
  async function saveRuntimeConfig(cfg) {
    await writeFile3(runtimeConfigFile(), JSON.stringify(cfg, null, 2), "utf8").catch(() => void 0);
  }
  async function loadRuntimeEntryOverride() {
    return (await loadRuntimeConfig()).entry;
  }
  async function saveRuntimeEntryOverride(entry) {
    await saveRuntimeConfig({ entry, demo: (await loadRuntimeConfig()).demo });
  }
  let runtimeEntry = "";
  let useBundledRuntime = false;
  const wizardFile = () => join4(app3.getPath("userData"), "wizard.json");
  async function loadWizardState() {
    try {
      const v = JSON.parse(await readFile(wizardFile(), "utf8"));
      return { done: v.done === true, choice: typeof v.choice === "string" ? v.choice : "" };
    } catch {
      return { done: false, choice: "" };
    }
  }
  async function saveWizardState(choice) {
    await writeFile3(wizardFile(), JSON.stringify({ done: true, choice }, null, 2), "utf8").catch(() => void 0);
  }
  async function startHost() {
    const repoRoot = join4(here, "..", "..", "..", "..");
    const packaged = app3.isPackaged;
    const cfg = await loadRuntimeConfig();
    const forceFake = process.env.HMH_DESKTOP_FAKE === "1" || cfg.demo;
    const forceBundled = process.env.HMH_DESKTOP_BUNDLED === "1";
    const override = cfg.entry;
    const adjacent = join4(repoRoot, "..", "hmharness", "packages", "web", "src", "desktop-host.ts");
    const bundled = bundledRuntimePath2(repoRoot);
    const bundledReady = existsSync2(bundled);
    let entry = "";
    useBundledRuntime = false;
    if (forceFake) {
    } else if (override !== "") {
      entry = override;
      if (override === bundled) useBundledRuntime = true;
    } else if (forceBundled) {
      if (bundledReady) {
        entry = bundled;
        useBundledRuntime = true;
      } else logInfo("host", "HMH_DESKTOP_BUNDLED=1 \u4F46\u5185\u7F6E runtime \u7F3A\u5931(\u5148\u8DD1 scripts/bundle-runtime.mjs)");
    } else {
      entry = packaged ? detectRealEntry2() : existsSync2(adjacent) ? adjacent : detectRealEntry2();
      if (entry === "" && bundledReady) {
        entry = bundled;
        useBundledRuntime = true;
      }
    }
    runtimeEntry = entry;
    const useReal = entry !== "" && (useBundledRuntime || existsSync2(entry));
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
    } else if (useReal && entry.endsWith(".js")) {
      spec = {
        command: process.execPath,
        args: [entry],
        // npm 安装的编译产物:ESM 依赖按文件位置解析,直跑即可
        cwd: dirname(entry),
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
        args: [join4(process.resourcesPath, "fake-host.cjs")],
        env: { ELECTRON_RUN_AS_NODE: "1" }
      };
    } else {
      spec = {
        command: process.execPath,
        // 直接走包真实路径(node_modules 里的 workspace junction 会被 ESM
        // realpath 化,导致 fake-host 的 argv[1]/import.meta.url 匹配失效)
        args: ["--import", "tsx", join4(repoRoot, "packages", "host-adapter", "src", "fake-host.ts")],
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
    isDev && rendererDevUrl ? [rendererDevUrl] : [pathToFileURL2(join4(here, "..", "..", "dist-renderer", "index.html")).href]
  );
  const windowStateFile = () => join4(app3.getPath("userData"), "window-state.json");
  async function loadBounds() {
    try {
      return JSON.parse(await readFile(windowStateFile(), "utf8"));
    } catch {
      return null;
    }
  }
  async function saveBounds(win) {
    try {
      await writeFile3(windowStateFile(), JSON.stringify(win.getBounds()), "utf8");
    } catch {
    }
  }
  async function createWindow() {
    const saved = await loadBounds();
    const win = new BrowserWindow({
      width: saved?.width ?? 1440,
      height: saved?.height ?? 900,
      ...saved?.x !== void 0 && saved?.y !== void 0 ? { x: saved.x, y: saved.y } : {},
      // HIG 阶段2(11-A):窄窗下限 560(04 号规格;原 960 使 ≤820px 抽屉断点不可达);
      // UIVERIFY 窄屏验收(11-B,wizard 360×640 全元素可达)需临时放宽到 320×360。
      minWidth: process.env.HMH_DESKTOP_UIVERIFY === "1" ? 320 : 560,
      minHeight: process.env.HMH_DESKTOP_UIVERIFY === "1" ? 360 : 600,
      show: false,
      backgroundColor: "#f9fafb",
      // v4 DSH:浅色默认(bg-base),避免深色闪屏
      title: "HMH Desktop",
      // 隐藏式标题栏:原生窗口控制(overlay 提供)+颜色随主题(renderer 经
      // chrome-theme 同步)——根治亮色模式顶部黑条;菜单栏 autoHide(Alt 呼出)。
      titleBarStyle: "hidden",
      // HIG 阶段2:36→44,与 renderer .titlebar 高度一致(不一致会露出/遮住 8px)
      titleBarOverlay: { ...chromeFor(nativeTheme.shouldUseDarkColors), height: 44 },
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
      void win.loadFile(join4(here, "..", "..", "dist-renderer", "index.html"));
    }
    win.webContents.once("did-finish-load", () => {
      if (!win.isDestroyed()) {
        win.webContents.send("bridge:host-state", bridge.hostState, { restartCount: 0 });
      }
    });
    return win;
  }
  app3.whenReady().then(() => {
    if (process.env.HMH_DESKTOP_VISREG === "1" || process.env.HMH_DESKTOP_UIVERIFY === "1" && process.env.HMH_DESKTOP_UIVERIFY_MODE !== "real") {
      process.env.HMH_DESKTOP_FAKE = "1";
    }
    app3.setAppUserModelId("dev.hmh.desktop");
    setupTray2();
    buildAppMenu2();
    if (app3.isPackaged) setTimeout(() => {
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
      if (process.env.HMH_DESKTOP_VISREG === "1") attachVisualRegression(win);
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
              const app22 = app3;
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
              app3.exit(0);
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
                app3.exit(ok ? 0 : 1);
              } catch (err) {
                console.log(`RENDER-TEST ERROR ${String(err).slice(0, 120)}`);
                app3.exit(1);
              }
            })();
          }, 2500);
        });
      }
    });
    void startHost();
    app3.on("activate", () => {
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
      const allow = ["applyUpdate", "approve", "approvalGet", "approvalSet", "browseRuntime", "checkUpdate", "chromeTheme", "cognitive", "detectRuntime", "diff", "exportSession", "fsList", "fsRead", "fsSearch", "getState", "getWizard", "inject", "installCli", "interrupt", "modelSet", "onEventBatches", "onHostState", "onInstallProgress", "onMenuAction", "onStreamChunks", "onUpdateState", "pickDirectory", "pickFiles", "popupMainMenu", "providerSave", "providers", "remoteWebAutostart", "remoteWebStart", "remoteWebStatus", "remoteWebStop", "runtimeInfo", "sendTask", "sessionOp", "sessionPreview", "sessions", "setRuntime", "stopHost", "wizardComplete", "workspaces", "workspaceAdd", "workspaceUse"];
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
    app3.exit(failed === 0 ? 0 : 1);
  }
  app3.on("before-quit", (e) => {
    if (supervisor !== null && supervisor.state !== "stopped") {
      e.preventDefault();
      sseAbort?.abort();
      void supervisor.stop().finally(() => app3.quit());
    }
  });
  app3.on("window-all-closed", () => {
    if (process.platform !== "darwin") app3.quit();
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
var pkgVersionAt;
var pkgNameAt;
var entryFromCliDir;
var detectExternalRuntime;
var detectRealEntry;
var repoRootOf;
var bundledRuntimePath;
var bundledRuntimeInfo;
var npmOnPath;
var wizardSuppressed;
var senderTrusted;
var hostCall;
var registerIpc;
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vZWxlY3Ryb24vbWFpbi9pbmRleC50cyIsICIuLi8uLi8uLi8uLi9wYWNrYWdlcy9ob3N0LWFkYXB0ZXIvc3JjL3N1cGVydmlzb3IudHMiLCAiLi4vLi4vLi4vLi4vcGFja2FnZXMvY29udHJhY3RzL3NyYy9ldmVudC50cyIsICIuLi8uLi8uLi8uLi9wYWNrYWdlcy9jb250cmFjdHMvc3JjL2Vycm9yLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2NvbnRyYWN0cy9zcmMvZ3VhcmRzLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2hvc3QtYWRhcHRlci9zcmMvY2xpZW50LnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2hvc3QtYWRhcHRlci9zcmMvZmFrZS1ob3N0LnRzIiwgIi4uLy4uL2VsZWN0cm9uL21haW4vdWl2ZXJpZnkudHMiLCAiLi4vLi4vZWxlY3Ryb24vbWFpbi92aXN1YWxyZWdyZXNzaW9uLnRzIiwgIi4uLy4uL2VsZWN0cm9uL21haW4vaW5zdGFsbGVyLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2NsaS1pbnN0YWxsZXIvc3JjL2luZGV4LnRzIiwgIi4uLy4uL2VsZWN0cm9uL21haW4vdXBkYXRlci1jaGFubmVscy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXHJcbiAqIEhNSCBEZXNrdG9wIFx1MjAxNCBFbGVjdHJvbiBcdTRFM0JcdThGREJcdTdBMEIoQURSLTAwMS8wMDMvMDA0KVx1MzAwMlxyXG4gKlxyXG4gKiBcdTVCODlcdTUxNjhcdTRFMERcdTUzRDhcdTkxQ0YoXHU1RjAwXHU1M0QxXHU4QkExXHU1MjEyIE0wIFx1NTFGQVx1NTNFM1x1OTVFOCArIEVsZWN0cm9uIFx1NUI5OFx1NjVCOVx1NUI4OVx1NTE2OFx1NkUwNVx1NTM1NSk6XHJcbiAqICAtIHJlbmRlcmVyOmNvbnRleHRJc29sYXRpb24gKyBzYW5kYm94ICsgXHU3OTgxIG5vZGVJbnRlZ3JhdGlvbixcdTRFMjVcdTY4M0MgQ1NQO1xyXG4gKiAgLSBcdTVCRkNcdTgyMkEvXHU2NUIwXHU3QTk3XHU1M0UzXHU0RTAwXHU1RjhCXHU2MkQyXHU3RUREKFx1NTNFQVx1NTJBMFx1OEY3RFx1NjIxMVx1NEVFQ1x1ODFFQVx1NURGMVx1NzY4NCByZW5kZXJlcik7XHJcbiAqICAtIFx1NkJDRlx1Njc2MSBJUEMgXHU2ODIxXHU5QThDIHNlbmRlciBcdTc2ODRcdTk4NzZcdTVDNDIgZnJhbWUgVVJMIFx1NUM1RVx1NEU4RVx1NjcyQ1x1NUU5NFx1NzUyOCxcdTkwMUFcdTkwNTNcdTc2N0RcdTU0MERcdTUzNTU7XHJcbiAqICAtIGhvc3QgdG9rZW4gXHU1M0VBXHU1QjU4XHU1NzI4XHU0RThFXHU2NzJDXHU4RkRCXHU3QTBCXHU0RTBFXHU1QjUwXHU4RkRCXHU3QTBCIGVudixcdTY1RTVcdTVGRDdcdThGOTNcdTUxRkFcdTUyNERcdTUxNDhcdTgxMzFcdTY1NEY7XHJcbiAqICAtIFx1NTM1NVx1NUI5RVx1NEY4Qlx1OTUwMTtcdTkwMDBcdTUxRkFcdTY1RjZcdTUzRUFcdTUwNUNcdTZCNjJcdTgxRUFcdTVERjEgc3Bhd24gXHU3Njg0IGhvc3QoXHU0RjE4XHU5NkM1XHUyMTkyXHU1MTVDXHU1RTk1IGtpbGwpXHUzMDAyXHJcbiAqXHJcbiAqIFx1OTYzNlx1NkJCNUUoMjAyNi0xMC0xMCk6bWFpbiBcdTYzMDFcdTY3MDkgRGVza3RvcEhvc3RDbGllbnQsU1NFIFx1NEZFMVx1NUMwMVx1NkQ0MShldmVudDogaG1oKVxyXG4gKiBcdTdFQ0YgNTBtcyBcdTYyNzlcdTkxQ0ZcdTYzQThcdTdFRDkgcmVuZGVyZXI7c2VuZFRhc2svYXBwcm92ZS9pbnRlcnJ1cHQvc2Vzc2lvbnMgXHU1MTY4XHU5MEU4XHU4RjZDXHU1M0QxXHJcbiAqIFx1N0VEOSBob3N0IFx1MjAxNFx1MjAxNCBmYWtlIFx1NEUwRVx1NzcxRlx1NUI5RSBobWhhcm5lc3MgZGVza3RvcC1ob3N0IFx1OEQ3MFx1NTQwQ1x1NEUwMFx1Njc2MVx1NEVFM1x1NzgwMVx1OERFRlx1NUY4NFx1MzAwMlxyXG4gKi9cclxuaW1wb3J0IHsgYXBwLCBCcm93c2VyV2luZG93LCBkaWFsb2csIGlwY01haW4sIHNlc3Npb24sIHNoZWxsLCBUcmF5LCBOb3RpZmljYXRpb24sIE1lbnUsIG5hdGl2ZUltYWdlLCBuYXRpdmVUaGVtZSB9IGZyb20gJ2VsZWN0cm9uJztcclxuaW1wb3J0IHsgam9pbiwgZGlybmFtZSwgYmFzZW5hbWUsIGlzQWJzb2x1dGUsIHJlc29sdmUgfSBmcm9tICdub2RlOnBhdGgnO1xyXG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFscGF0aFN5bmMsIHJlYWRGaWxlU3luYyB9IGZyb20gJ25vZGU6ZnMnO1xyXG5pbXBvcnQgeyB3cml0ZUZpbGUsIHJlYWRGaWxlIH0gZnJvbSAnbm9kZTpmcy9wcm9taXNlcyc7XHJcbmltcG9ydCB7IGhvbWVkaXIsIG5ldHdvcmtJbnRlcmZhY2VzIH0gZnJvbSAnbm9kZTpvcyc7XHJcbmltcG9ydCB7IGV4ZWNGaWxlU3luYywgc3Bhd24gfSBmcm9tICdub2RlOmNoaWxkX3Byb2Nlc3MnO1xyXG5pbXBvcnQgeyBwYXRoVG9GaWxlVVJMIH0gZnJvbSAnbm9kZTp1cmwnO1xyXG5pbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSAnbm9kZTpjcnlwdG8nO1xyXG5pbXBvcnQgeyBEZXNrdG9wUnVudGltZVN1cGVydmlzb3IsIERlc2t0b3BIb3N0Q2xpZW50LCBlbnZlbG9wZUZyb21GcmFtZSwgdHlwZSBIb3N0U3RhdGUgfSBmcm9tICdAaG1oLWRlc2t0b3AvaG9zdC1hZGFwdGVyJztcclxuaW1wb3J0IHsgaXNFdmVudEVudmVsb3BlLCB0eXBlIEV2ZW50RW52ZWxvcGUgfSBmcm9tICdAaG1oLWRlc2t0b3AvY29udHJhY3RzJztcclxuaW1wb3J0IHsgYXR0YWNoVWlWZXJpZnkgfSBmcm9tICcuL3VpdmVyaWZ5LnRzJztcclxuaW1wb3J0IHsgYXR0YWNoVmlzdWFsUmVncmVzc2lvbiB9IGZyb20gJy4vdmlzdWFscmVncmVzc2lvbi50cyc7XHJcbmltcG9ydCB7IGluc3RhbGxUYXJnZXQsIHJlc29sdmVJbnN0YWxsZWRFbnRyeSwgc3RhcnRDbGlJbnN0YWxsLCB0eXBlIEluc3RhbGxQcm9ncmVzcyB9IGZyb20gJy4vaW5zdGFsbGVyLnRzJztcclxuaW1wb3J0IHsgb3JkZXJlZENoZWNrQ2hhbm5lbHMsIG9yZGVyZWREb3dubG9hZE1pcnJvcnMsIG5vcm1hbGl6ZUNoYW5uZWwsIHN1bW1hcml6ZUNoZWNrRmFpbHVyZXMsIHR5cGUgVXBkYXRlQ2hhbm5lbElkIH0gZnJvbSAnLi91cGRhdGVyLWNoYW5uZWxzLnRzJztcclxuXHJcbmNvbnN0IGhlcmUgPSBpbXBvcnQubWV0YS5kaXJuYW1lID8/ICcuJztcclxuY29uc3QgaXNEZXYgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9ERVYgPT09ICcxJztcclxuY29uc3QgcmVuZGVyZXJEZXZVcmwgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9SRU5ERVJFUl9VUkwgPz8gJyc7XHJcbmNvbnN0IHByZWxvYWRQYXRoID0gam9pbihoZXJlLCAnLi4vcHJlbG9hZC9pbmRleC5janMnKTtcclxuXHJcbi8qIC0tLS0gXHU2NUU1XHU1RkQ3XHU4MTMxXHU2NTRGOnRva2VuL2F1dGhvcml6YXRpb24gXHU2QzM4XHU0RTBEXHU4RkRCXHU2M0E3XHU1MjM2XHU1M0YwIC0tLS0gKi9cclxuY29uc3Qgc2VjcmV0czogc3RyaW5nW10gPSBbXTtcclxuZnVuY3Rpb24gcmVkYWN0KHM6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgbGV0IG91dCA9IHM7XHJcbiAgZm9yIChjb25zdCBzZWMgb2Ygc2VjcmV0cykge1xyXG4gICAgaWYgKHNlYy5sZW5ndGggPj0gOCkgb3V0ID0gb3V0LnNwbGl0KHNlYykuam9pbignW3JlZGFjdGVkXScpO1xyXG4gIH1cclxuICByZXR1cm4gb3V0O1xyXG59XHJcbmZ1bmN0aW9uIGxvZ0luZm8odGFnOiBzdHJpbmcsIG1zZzogc3RyaW5nKTogdm9pZCB7XHJcbiAgY29uc29sZS5sb2coYFtobWgtZGVza3RvcDoke3RhZ31dICR7cmVkYWN0KG1zZyl9YCk7XHJcbn1cclxuXHJcbi8qIC0tLS0gXHU1MzU1XHU1QjlFXHU0RjhCIC0tLS0gKi9cclxuaWYgKCFhcHAucmVxdWVzdFNpbmdsZUluc3RhbmNlTG9jaygpKSB7XHJcbiAgYXBwLnF1aXQoKTtcclxufSBlbHNlIHtcclxuICBhcHAub24oJ3NlY29uZC1pbnN0YW5jZScsICgpID0+IHtcclxuICAgIGNvbnN0IHdpbiA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpWzBdO1xyXG4gICAgaWYgKHdpbikge1xyXG4gICAgICBpZiAod2luLmlzTWluaW1pemVkKCkpIHdpbi5yZXN0b3JlKCk7XHJcbiAgICAgIHdpbi5mb2N1cygpO1xyXG4gICAgfVxyXG4gIH0pO1xyXG5cclxuICAvKiAtLS0tIGhvc3QgXHU3NkQxXHU3QkExICsgXHU2ODY1XHU1QkEyXHU2MjM3XHU3QUVGIC0tLS0gKi9cclxuICBpbnRlcmZhY2UgQnJpZGdlU25hcHNob3Qge1xyXG4gICAgaG9zdFN0YXRlOiBIb3N0U3RhdGU7XHJcbiAgICBob3N0UG9ydDogbnVtYmVyIHwgbnVsbDtcclxuICAgIGhvc3RWZXJzaW9uOiBzdHJpbmcgfCBudWxsO1xyXG4gICAgbGFzdEVycm9yOiBzdHJpbmcgfCBudWxsO1xyXG4gICAgbW9kZTogJ2Zha2UnIHwgJ3JlYWwnO1xyXG4gICAgcnVudGltZUVudHJ5OiBzdHJpbmcgfCBudWxsO1xyXG4gIH1cclxuICBsZXQgc3VwZXJ2aXNvcjogRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yIHwgbnVsbCA9IG51bGw7XHJcbiAgbGV0IGNsaWVudDogRGVza3RvcEhvc3RDbGllbnQgfCBudWxsID0gbnVsbDtcclxuICBsZXQgYnJpZGdlOiBCcmlkZ2VTbmFwc2hvdCA9IHsgaG9zdFN0YXRlOiAnc3RvcHBlZCcsIGhvc3RQb3J0OiBudWxsLCBob3N0VmVyc2lvbjogbnVsbCwgbGFzdEVycm9yOiBudWxsLCBtb2RlOiAnZmFrZScsIHJ1bnRpbWVFbnRyeTogbnVsbCB9O1xyXG4gIC8qKiBcdTRFOEJcdTRFRjZcdTYyNzlcdTkxQ0ZcdTdGMTNcdTUxQjI6XHU5QUQ4XHU5ODkxIFNTRSBcdTRFMERcdTkwMTBcdTY3NjFcdThGQzcgSVBDLDUwbXMgXHU2Mjc5XHU5MUNGIGZsdXNoKFx1NkUzMlx1NjdEM1x1NEUwRFx1NTM2MSlcdTMwMDIgKi9cclxuICBsZXQgZXZlbnRCdWZmZXI6IEV2ZW50RW52ZWxvcGVbXSA9IFtdO1xyXG4gIGxldCBmbHVzaFRpbWVyOiBOb2RlSlMuVGltZW91dCB8IG51bGwgPSBudWxsO1xyXG4gIGxldCBzc2VBYm9ydDogQWJvcnRDb250cm9sbGVyIHwgbnVsbCA9IG51bGw7XHJcbiAgbGV0IGxhc3RFdmVudElkID0gJyc7XHJcbiAgLyoqIFx1NjcyQVx1NzdFNS9cdTc1NzhcdTVGNjJcdTRGRTFcdTVDMDFcdThCQTFcdTY1NzAoU0NIRU1BX01JU01BVENIIFx1OTc2Mlx1NTQxMVx1OEJDQVx1NjVBRCxcdTRFMERcdTVEMjkpXHUzMDAyICovXHJcbiAgbGV0IGRyb3BwZWRGcmFtZXMgPSAwO1xyXG5cclxuICBmdW5jdGlvbiBwdXNoRXZlbnQoZW52OiBFdmVudEVudmVsb3BlKTogdm9pZCB7XHJcbiAgICBldmVudEJ1ZmZlci5wdXNoKGVudik7XHJcbiAgICBpZiAoZXZlbnRCdWZmZXIubGVuZ3RoID4gMl8wMDApIGV2ZW50QnVmZmVyLnNwbGljZSgwLCBldmVudEJ1ZmZlci5sZW5ndGggLSAyXzAwMCk7XHJcbiAgICBpZiAoZmx1c2hUaW1lciA9PT0gbnVsbCkge1xyXG4gICAgICBmbHVzaFRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XHJcbiAgICAgICAgZmx1c2hUaW1lciA9IG51bGw7XHJcbiAgICAgICAgY29uc3QgYmF0Y2ggPSBldmVudEJ1ZmZlcjtcclxuICAgICAgICBldmVudEJ1ZmZlciA9IFtdO1xyXG4gICAgICAgIGZvciAoY29uc3QgdyBvZiBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKSkge1xyXG4gICAgICAgICAgaWYgKCF3LmlzRGVzdHJveWVkKCkpIHcud2ViQ29udGVudHMuc2VuZCgnYnJpZGdlOmV2ZW50LWJhdGNoJywgYmF0Y2gpO1xyXG4gICAgICAgIH1cclxuICAgICAgfSwgNTApO1xyXG4gICAgfVxyXG4gICAgbm90aWZ5RXZlbnQoZW52KTtcclxuICB9XHJcblxyXG4gIC8qIC0tLS0gXHU3Q0ZCXHU3RURGXHU2MjU4XHU3NkQ4ICsgXHU5MDFBXHU3N0U1KDAzIFx1NTNGNyBcdTAwQTdcdTRFMDA6XHU2ODRDXHU5NzYyXHU0RUE3XHU1NEMxXHU5NzAwXHU4OTgxXHU3Q0ZCXHU3RURGXHU2MjU4XHU3NkQ4XHUzMDAxXHU5MDFBXHU3N0U1KSAtLS0tXHJcbiAgICAgXHU1QkExXHU2Mjc5XHU3QjQ5XHU1Rjg1XHU1RkM1XHU5ODdCXHU2MjUzXHU2MjcwKFx1NzUyOFx1NjIzN1x1NUZDNVx1OTg3Qlx1NTFCM1x1N0I1Nik7XHU1QjhDXHU2MjEwL1x1NTkzMVx1OEQyNVx1NEVDNVx1NTcyOFx1N0E5N1x1NTNFM1x1NTkzMVx1NzEyNlx1NjVGNlx1NjNEMFx1OTE5Mlx1MzAwMiAqL1xyXG4gIGNvbnN0IFRSQVlfSUNPTl9CQVNFNjQgPSAnaVZCT1J3MEtHZ29BQUFBTlNVaEVVZ0FBQUJBQUFBQVFDQVlBQUFBZjgvOWhBQUFBUjBsRVFWUjRuR05nUUFQU3Nvci84V0YwOVVScnhHc1FxWm94RElFSjZEZCtCMk4waGJqRU1Xd24xUUN3SVlQVEFGeVlmZ1lNZkJpUVpBREZDWWtxU1puaXpFUkpkZ1lBbEw1cnNEYzJhVGNBQUFBQVNVVk9SSzVDWUlJPSc7XHJcbiAgbGV0IHRyYXk6IFRyYXkgfCBudWxsID0gbnVsbDtcclxuICBjb25zdCBzZW5kTWVudUFjdGlvbiA9IChhOiBzdHJpbmcpOiB2b2lkID0+IHtcclxuICAgIGZvciAoY29uc3QgdyBvZiBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKSkge1xyXG4gICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCdtZW51OmFjdGlvbicsIGEpO1xyXG4gICAgfVxyXG4gIH07XHJcbiAgZnVuY3Rpb24gZm9jdXNNYWluV2luZG93KCk6IHZvaWQge1xyXG4gICAgY29uc3Qgd2luID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkuZmluZCgodykgPT4gIXcuaXNEZXN0cm95ZWQoKSk7XHJcbiAgICBpZiAod2luID09PSB1bmRlZmluZWQpIHJldHVybjtcclxuICAgIGlmICh3aW4uaXNNaW5pbWl6ZWQoKSkgd2luLnJlc3RvcmUoKTtcclxuICAgIHdpbi5zaG93KCk7XHJcbiAgICB3aW4uZm9jdXMoKTtcclxuICB9XHJcbiAgZnVuY3Rpb24gc2V0dXBUcmF5KCk6IHZvaWQge1xyXG4gICAgaWYgKHRyYXkgIT09IG51bGwpIHJldHVybjtcclxuICAgIGNvbnN0IGljb24gPSBuYXRpdmVJbWFnZS5jcmVhdGVGcm9tRGF0YVVSTChgZGF0YTppbWFnZS9wbmc7YmFzZTY0LCR7VFJBWV9JQ09OX0JBU0U2NH1gKTtcclxuICAgIHRyYXkgPSBuZXcgVHJheShpY29uKTtcclxuICAgIHRyYXkuc2V0VG9vbFRpcCgnSE1IIERlc2t0b3AnKTtcclxuICAgIHRyYXkub24oJ2NsaWNrJywgZm9jdXNNYWluV2luZG93KTtcclxuICAgIHRyYXkuc2V0Q29udGV4dE1lbnUoTWVudS5idWlsZEZyb21UZW1wbGF0ZShbXHJcbiAgICAgIHsgbGFiZWw6ICdcdTY1QjBcdTVFRkFcdTRGMUFcdThCREQnLCBjbGljazogKCk6IHZvaWQgPT4gc2VuZE1lbnVBY3Rpb24oJ25ldy1zZXNzaW9uJykgfSxcclxuICAgICAgeyBsYWJlbDogJ1x1NjYzRVx1NzkzQVx1NEUzQlx1N0E5N1x1NTNFMycsIGNsaWNrOiBmb2N1c01haW5XaW5kb3cgfSxcclxuICAgICAgeyBsYWJlbDogJ1x1NjI0Qlx1NjczQVx1OEZEQ1x1N0EwQlx1NjNBN1x1NTIzNicsIGNsaWNrOiAoKTogdm9pZCA9PiBzZW5kTWVudUFjdGlvbignb3Blbi1yZW1vdGUnKSB9LFxyXG4gICAgICB7IGxhYmVsOiAnXHU4QkJFXHU3RjZFJywgY2xpY2s6ICgpOiB2b2lkID0+IHNlbmRNZW51QWN0aW9uKCdvcGVuLXNldHRpbmdzJykgfSxcclxuICAgICAgeyB0eXBlOiAnc2VwYXJhdG9yJyB9LFxyXG4gICAgICB7IGxhYmVsOiAnXHU5MDAwXHU1MUZBJywgY2xpY2s6ICgpOiB2b2lkID0+IHsgYXBwLnF1aXQoKTsgfSB9LFxyXG4gICAgXSkpO1xyXG4gIH1cclxuICBmdW5jdGlvbiBub3RpZnlFdmVudChlbnY6IEV2ZW50RW52ZWxvcGUpOiB2b2lkIHtcclxuICAgIC8vIFx1OUE4Q1x1NjUzNi9cdTYyMkFcdTU2RkUvXHU2RTMyXHU2N0QzXHU2M0EyXHU5NDg4L1x1ODlDNlx1ODlDOVx1NTZERVx1NUY1Mlx1NkEyMVx1NUYwRlx1OTc1OVx1OUVEOChcdTRFMERcdTVGODBcdTc1MjhcdTYyMzdcdTY4NENcdTk3NjJcdTVGMzlcdTZENEJcdThCRDVcdTkwMUFcdTc3RTUpXHJcbiAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRlkgPT09ICcxJyB8fCBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9TTkFQU0hPVCAhPT0gdW5kZWZpbmVkIHx8IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1JFTkRFUl9URVNUID09PSAnMScgfHwgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVklTUkVHID09PSAnMScpIHJldHVybjtcclxuICAgIGlmICghTm90aWZpY2F0aW9uLmlzU3VwcG9ydGVkKCkpIHJldHVybjtcclxuICAgIGNvbnN0IHdpbiA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmZpbmQoKHcpID0+ICF3LmlzRGVzdHJveWVkKCkpO1xyXG4gICAgY29uc3QgZm9jdXNlZCA9IHdpbj8uaXNGb2N1c2VkKCkgPz8gZmFsc2U7XHJcbiAgICBjb25zdCBtayA9ICh0aXRsZTogc3RyaW5nLCBib2R5OiBzdHJpbmcpOiB2b2lkID0+IHtcclxuICAgICAgY29uc3QgbiA9IG5ldyBOb3RpZmljYXRpb24oeyB0aXRsZSwgYm9keSwgaWNvbjogbmF0aXZlSW1hZ2UuY3JlYXRlRnJvbURhdGFVUkwoYGRhdGE6aW1hZ2UvcG5nO2Jhc2U2NCwke1RSQVlfSUNPTl9CQVNFNjR9YCkgfSk7XHJcbiAgICAgIG4ub24oJ2NsaWNrJywgZm9jdXNNYWluV2luZG93KTtcclxuICAgICAgbi5zaG93KCk7XHJcbiAgICB9O1xyXG4gICAgaWYgKGVudi5raW5kID09PSAnYXBwcm92YWwucmVxdWlyZWQnKSB7XHJcbiAgICAgIGNvbnN0IHAgPSBlbnYucGF5bG9hZCBhcyB7IHRvb2w/OiBzdHJpbmcgfTtcclxuICAgICAgbWsoJ0hNSCBcdTk3MDBcdTg5ODFcdTVCQTFcdTYyNzknLCBgJHtTdHJpbmcocC50b29sID8/ICdcdTY0Q0RcdTRGNUMnKX0gXHU3QjQ5XHU1Rjg1XHU0RjYwXHU3Njg0XHU2Mjc5XHU1MUM2YCk7XHJcbiAgICB9IGVsc2UgaWYgKGVudi5raW5kID09PSAncnVuLmNvbXBsZXRlZCcgJiYgIWZvY3VzZWQpIHtcclxuICAgICAgbWsoJ0hNSCBcdTRFRkJcdTUyQTFcdTVCOENcdTYyMTAnLCBgXHU0RjFBXHU4QkREICR7ZW52LnNlc3Npb25JZH0gXHU3Njg0XHU0RUZCXHU1MkExXHU1REYyXHU1QjhDXHU2MjEwYCk7XHJcbiAgICB9IGVsc2UgaWYgKGVudi5raW5kID09PSAncnVuLmZhaWxlZCcgJiYgIWZvY3VzZWQpIHtcclxuICAgICAgbWsoJ0hNSCBcdTRFRkJcdTUyQTFcdTU5MzFcdThEMjUnLCBgXHU0RjFBXHU4QkREICR7ZW52LnNlc3Npb25JZH0gXHU3Njg0XHU0RUZCXHU1MkExXHU1OTMxXHU4RDI1LFx1NzBCOVx1NTFGQlx1NjdFNVx1NzcwQmApO1xyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgLyogLS0tLSBcdTgxRUFcdTVCOUFcdTRFNDlcdTY4MDdcdTk4OThcdTY4MEYoMjAyNi0xMC0xMSBcdTc1MjhcdTYyMzdcdTUzQ0RcdTk5ODg6XHU0RUFFXHU4MjcyXHU2QTIxXHU1RjBGXHU5ODc2XHU5MEU4XHU5RUQxXHU2NzYxPVx1NTM5Rlx1NzUxRlx1ODNEQ1x1NTM1NVx1NjgwRlxyXG4gICAgIFx1NEUwRFx1OERERlx1NEUzQlx1OTg5ODtcdTgzRENcdTUzNTVcdTRFMEVcdThCQkVcdTdGNkVcdTkxQ0RcdTU5MEQpIC0tLS0gXHU2NUI5XHU2ODQ4Olx1OTY5MFx1ODVDRlx1NUYwRlx1NjgwN1x1OTg5OFx1NjgwRiArIHRpdGxlQmFyT3ZlcmxheVxyXG4gICAgIChcdTk4OUNcdTgyNzJcdTk2OEZcdTRFM0JcdTk4OTgpLFx1ODNEQ1x1NTM1NVx1NjgwRiBhdXRvSGlkZShBbHQgXHU1NDdDXHU1MUZBKVx1NEUxNFx1N0NCRVx1N0I4MFx1NEUzQVx1N0NGQlx1N0VERlx1N0VBN1x1ODBGRFx1NTI5QjtcclxuICAgICBcdTVFMzhcdTc1MjhcdTUyQThcdTRGNUNcdThENzAgcmVuZGVyZXIgXHU2ODA3XHU5ODk4XHU2ODBGIFx1MjYzMCBcdTRFM0JcdTgzRENcdTUzNTUoXHU1NTJGXHU0RTAwXHU1MTY1XHU1M0UzKVx1MzAwMiAqL1xyXG4gIC8vIHY0IERTSCBcdThCQkVcdThCQTFcdThCRURcdThBMDA6b3ZlcmxheSBcdTgyNzJcdThEREZcdTk2OEYgdGl0bGViYXIgXHU3Njg0IGJnLWxheWVyLTEoXHU2RDQ1ICNmZmYvXHU2REYxICMxNjE4MWQpXHJcbiAgY29uc3QgY2hyb21lRm9yID0gKGRhcms6IGJvb2xlYW4pOiB7IGNvbG9yOiBzdHJpbmc7IHN5bWJvbENvbG9yOiBzdHJpbmcgfSA9PlxyXG4gICAgZGFyayA/IHsgY29sb3I6ICcjMTYxODFkJywgc3ltYm9sQ29sb3I6ICcjZjVmNmY4JyB9IDogeyBjb2xvcjogJyNmZmZmZmYnLCBzeW1ib2xDb2xvcjogJyMwZjExMTUnIH07XHJcbiAgZnVuY3Rpb24gYXBwbHlDaHJvbWUoZGFyazogYm9vbGVhbik6IHZvaWQge1xyXG4gICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XHJcbiAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB7XHJcbiAgICAgICAgdHJ5IHsgdy5zZXRUaXRsZUJhck92ZXJsYXkoY2hyb21lRm9yKGRhcmspKTsgfSBjYXRjaCB7IC8qIFx1NEVDNSBXaW5kb3dzIFx1NjUyRlx1NjMwMSAqLyB9XHJcbiAgICAgIH1cclxuICAgIH1cclxuICB9XHJcblxyXG4gIC8qIC0tLS0gXHU1RTk0XHU3NTI4XHU1MTg1XHU2NkY0XHU2NUIwKDIwMjYtMTAtMjY6XHU4MUVBXHU3ODE0XHU4RjdCXHU5MUNGXHU2NkY0XHU2NUIwXHU1NjY4LFx1OTZGNlx1NEY5RFx1OEQ1NjtHaXRIdWIgUmVsZWFzZXMgXHU5MDFBXHU5MDUzKVxyXG4gICAgIFx1NkQ0MVx1N0EwQjpcdTI2MzBcIlx1NjhDMFx1NjdFNVx1NjZGNFx1NjVCMFwiXHUyMTkyIGZldGNoIGxhdGVzdCByZWxlYXNlIHRhZyBcdTIxOTIgXHU2QkQ0XHU3MjQ4XHU2NzJDIFx1MjE5MiBcdTU0MEVcdTUzRjBcdTRFMEJcdThGN0QgU2V0dXBcclxuICAgICBleGUgXHU1MjMwXHU0RTM0XHU2NUY2XHU3NkVFXHU1RjU1IFx1MjE5MiBcdTgzRENcdTUzNTVcdTUzRDhcIlx1OTFDRFx1NTQyRlx1NUU3Nlx1NUI4OVx1ODhDNVx1NjZGNFx1NjVCMFwiXHUyMTkyIFx1OTAwMFx1NTFGQVx1NUU5NFx1NzUyOFx1NTQwRSBOU0lTIC9TIC9EPVx1NTM5Rlx1NzZFRVx1NUY1NVxyXG4gICAgIFx1OTc1OVx1OUVEOFx1ODk4Nlx1NzZENlx1NUI4OVx1ODhDNShcdTRFMEJcdTZCMjFcdTU0MkZcdTUyQThcdTUzNzNcdTY1QjBcdTcyNDgpXHUzMDAyXHU2NUUwXHU3QjdFXHU1NDBEXHU4QkMxXHU0RTY2XHU5NjM2XHU2QkI1XHU1M0VGXHU3NTI4O1x1NkI2M1x1NUYwRlx1N0I3RVx1NTQwRFx1NTQwRVx1NTNFRlx1NTJBMFx1NjgyMVx1OUE4Q1x1MzAwMlxyXG4gICAgIDIwMjYtMTAtMjkgXHU1M0NDXHU5MDFBXHU5MDUzXHU2ODM5XHU0RkVFKFx1NzUyOFx1NjIzN1x1NTZGRFx1NTE4NVx1NjUzNlx1NEUwRFx1NTIzMFx1NjNBOFx1OTAwMSk6XHU2OEMwXHU2N0U1XHU5MDFBXHU5MDUzXHU5NTVDXHU1MENGXHU1NkRFXHU5MDAwXHU5NEZFXHJcbiAgICAgKFx1NzZGNFx1OEZERSA4cyBcdTIxOTIgZ2gtcHJveHkgXHUyMTkyIGdoZmFzdCxcdTg5QzRcdTUyMTlcdTg5QzEgdXBkYXRlci1jaGFubmVscy50cykrIFx1NTQ3RFx1NEUyRFx1OTAxQVx1OTA1M1xyXG4gICAgIFx1N0M5OFx1NjAyN1x1OEJCMFx1NUZDNiArIFx1NEUwQlx1OEY3RFx1OTU1Q1x1NTBDRlx1NEUwRVx1NjhDMFx1NjdFNVx1OTAxQVx1OTA1M1x1NTQwQ1x1NkU5MFx1NEYxOFx1NTE0OFx1MzAwMiAqL1xyXG4gIGNvbnN0IFVQREFURV9SRVBPID0gJ3N3c2dibC9obWgtZGVza3RvcCc7XHJcbiAgaW50ZXJmYWNlIFVwZGF0ZVN0YXRlIHsgY2hlY2tpbmc6IGJvb2xlYW47IGN1cnJlbnRWZXJzaW9uOiBzdHJpbmc7IGxhdGVzdDogc3RyaW5nIHwgbnVsbDsgbm90ZXM6IHN0cmluZzsgZG93bmxvYWRlZDogYm9vbGVhbjsgZXJyb3I6IHN0cmluZzsgY2hhbm5lbDogc3RyaW5nIH1cclxuICBsZXQgdXBkYXRlU3RhdGU6IFVwZGF0ZVN0YXRlID0geyBjaGVja2luZzogZmFsc2UsIGN1cnJlbnRWZXJzaW9uOiBhcHAuZ2V0VmVyc2lvbigpLCBsYXRlc3Q6IG51bGwsIG5vdGVzOiAnJywgZG93bmxvYWRlZDogZmFsc2UsIGVycm9yOiAnJywgY2hhbm5lbDogJycgfTtcclxuICBsZXQgaW5zdGFsbGVyUGF0aDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XHJcbiAgY29uc3QgYnVtcFVwZGF0ZSA9IChwYXRjaDogUGFydGlhbDxVcGRhdGVTdGF0ZT4pOiB2b2lkID0+IHtcclxuICAgIHVwZGF0ZVN0YXRlID0geyAuLi51cGRhdGVTdGF0ZSwgLi4ucGF0Y2ggfTtcclxuICAgIGZvciAoY29uc3QgdyBvZiBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKSkge1xyXG4gICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCd1cGRhdGU6c3RhdGUnLCB1cGRhdGVTdGF0ZSk7XHJcbiAgICB9XHJcbiAgfTtcclxuICBjb25zdCBjbXBWZXJzaW9uID0gKGE6IHN0cmluZywgYjogc3RyaW5nKTogbnVtYmVyID0+IHtcclxuICAgIGNvbnN0IHBhID0gYS5yZXBsYWNlKC9edi8sICcnKS5zcGxpdCgnLicpLm1hcChOdW1iZXIpO1xyXG4gICAgY29uc3QgcGIgPSBiLnJlcGxhY2UoL152LywgJycpLnNwbGl0KCcuJykubWFwKE51bWJlcik7XHJcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IDM7IGkrKykgeyBpZiAoKHBhW2ldID8/IDApICE9PSAocGJbaV0gPz8gMCkpIHJldHVybiAocGFbaV0gPz8gMCkgPCAocGJbaV0gPz8gMCkgPyAtMSA6IDE7IH1cclxuICAgIHJldHVybiAwO1xyXG4gIH07XHJcbiAgLyoqIFx1OTAxQVx1OTA1M1x1N0M5OFx1NjAyNzpcdTRFMEFcdTZCMjFcdTYyMTBcdTUyOUZcdTU0N0RcdTRFMkRcdTc2ODRcdTY4QzBcdTY3RTVcdTkwMUFcdTkwNTModXNlckRhdGEvdXBkYXRlLWNoYW5uZWwuanNvbixcdTRFMEUgcnVudGltZS5qc29uIFx1NTQwQ1x1NkEyMVx1NUYwRilcdTMwMDIgKi9cclxuICBjb25zdCB1cGRhdGVDaGFubmVsRmlsZSA9ICgpOiBzdHJpbmcgPT4gam9pbihhcHAuZ2V0UGF0aCgndXNlckRhdGEnKSwgJ3VwZGF0ZS1jaGFubmVsLmpzb24nKTtcclxuICBhc3luYyBmdW5jdGlvbiBsb2FkU3RpY2t5Q2hhbm5lbCgpOiBQcm9taXNlPFVwZGF0ZUNoYW5uZWxJZCB8IG51bGw+IHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHYgPSBKU09OLnBhcnNlKGF3YWl0IHJlYWRGaWxlKHVwZGF0ZUNoYW5uZWxGaWxlKCksICd1dGY4JykpIGFzIHsgY2hhbm5lbD86IHVua25vd24gfTtcclxuICAgICAgcmV0dXJuIG5vcm1hbGl6ZUNoYW5uZWwodi5jaGFubmVsKTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4gbnVsbDsgfVxyXG4gIH1cclxuICBhc3luYyBmdW5jdGlvbiBzYXZlU3RpY2t5Q2hhbm5lbChpZDogVXBkYXRlQ2hhbm5lbElkKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBhd2FpdCB3cml0ZUZpbGUodXBkYXRlQ2hhbm5lbEZpbGUoKSwgSlNPTi5zdHJpbmdpZnkoeyBjaGFubmVsOiBpZCB9LCBudWxsLCAyKSwgJ3V0ZjgnKS5jYXRjaCgoKSA9PiB1bmRlZmluZWQpO1xyXG4gIH1cclxuICB0eXBlIExhdGVzdFJlbGVhc2UgPSB7IHRhZ19uYW1lPzogc3RyaW5nOyBib2R5Pzogc3RyaW5nOyBhc3NldHM/OiBBcnJheTx7IG5hbWU6IHN0cmluZzsgYnJvd3Nlcl9kb3dubG9hZF91cmw6IHN0cmluZzsgc2l6ZTogbnVtYmVyIH0+IH07XHJcbiAgYXN5bmMgZnVuY3Rpb24gY2hlY2tGb3JVcGRhdGVzKCk6IFByb21pc2U8VXBkYXRlU3RhdGU+IHtcclxuICAgIGlmICh1cGRhdGVTdGF0ZS5jaGVja2luZyB8fCB1cGRhdGVTdGF0ZS5kb3dubG9hZGVkKSByZXR1cm4gdXBkYXRlU3RhdGU7XHJcbiAgICBidW1wVXBkYXRlKHsgY2hlY2tpbmc6IHRydWUsIGVycm9yOiAnJyB9KTtcclxuICAgIGxvZ0luZm8oJ3VwZGF0ZScsIGBjaGVja2luZ1x1MjAyNiAoY3VycmVudCB2JHthcHAuZ2V0VmVyc2lvbigpfSlgKTtcclxuICAgIGNvbnN0IGZhaWx1cmVzOiBBcnJheTx7IGxhYmVsOiBzdHJpbmc7IHJlYXNvbjogc3RyaW5nIH0+ID0gW107XHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCBzdGlja3kgPSBhd2FpdCBsb2FkU3RpY2t5Q2hhbm5lbCgpO1xyXG4gICAgICBjb25zdCBjaGFubmVscyA9IG9yZGVyZWRDaGVja0NoYW5uZWxzKHN0aWNreSA/PyB1bmRlZmluZWQpO1xyXG4gICAgICBmb3IgKGNvbnN0IGNoIG9mIGNoYW5uZWxzKSB7XHJcbiAgICAgICAgbGV0IHJlbDogTGF0ZXN0UmVsZWFzZSB8IG51bGwgPSBudWxsO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICBjb25zdCByID0gYXdhaXQgZmV0Y2goY2guYXBpVXJsKFVQREFURV9SRVBPKSwge1xyXG4gICAgICAgICAgICBoZWFkZXJzOiB7ICd1c2VyLWFnZW50JzogJ2htaC1kZXNrdG9wLXVwZGF0ZXInIH0sXHJcbiAgICAgICAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dChjaC50aW1lb3V0TXMpLFxyXG4gICAgICAgICAgfSk7XHJcbiAgICAgICAgICBpZiAoIXIub2spIHsgZmFpbHVyZXMucHVzaCh7IGxhYmVsOiBjaC5sYWJlbCwgcmVhc29uOiBgSFRUUCAke3Iuc3RhdHVzfWAgfSk7IGxvZ0luZm8oJ3VwZGF0ZScsIGAke2NoLmxhYmVsfSBcdTIxOTIgSFRUUCAke3Iuc3RhdHVzfWApOyBjb250aW51ZTsgfVxyXG4gICAgICAgICAgLy8gXHU5NTVDXHU1MENGXHU1M0VGXHU4MEZEXHU1NkRFIDIwMCBcdTRGNDZcdTUxODVcdTVCQjlcdTk3NUUgSlNPTihIVE1MIFx1OTUxOVx1OEJFRlx1OTg3NSk6ci5qc29uKCkgXHU2MjlCXHU5NTE5XHU2MjE2IHRhZyBcdTdGM0FcdTU5MzFcdTkwRkRcdTYzMDlcdTY3MkNcdTkwMUFcdTkwNTNcdTU5MzFcdThEMjVcdTU2REVcdTkwMDBcclxuICAgICAgICAgIHJlbCA9IChhd2FpdCByLmpzb24oKSkgYXMgTGF0ZXN0UmVsZWFzZTtcclxuICAgICAgICAgIGlmICh0eXBlb2YgcmVsPy50YWdfbmFtZSAhPT0gJ3N0cmluZycgfHwgcmVsLnRhZ19uYW1lID09PSAnJykgeyBmYWlsdXJlcy5wdXNoKHsgbGFiZWw6IGNoLmxhYmVsLCByZWFzb246ICdcdTU0Q0RcdTVFOTRcdTY1RTAgdGFnX25hbWUnIH0pOyBsb2dJbmZvKCd1cGRhdGUnLCBgJHtjaC5sYWJlbH0gXHUyMTkyIFx1NjVFMCB0YWdfbmFtZWApOyBjb250aW51ZTsgfVxyXG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICAgICAgY29uc3QgZSA9IGVyciBhcyB7IGNhdXNlPzogeyBjb2RlPzogdW5rbm93biB9IH07XHJcbiAgICAgICAgICBjb25zdCByZWFzb24gPSBlcnIgaW5zdGFuY2VvZiBFcnJvciAmJiBlcnIubmFtZSA9PT0gJ1RpbWVvdXRFcnJvcidcclxuICAgICAgICAgICAgPyBgXHU4RDg1XHU2NUY2KCR7TWF0aC5yb3VuZChjaC50aW1lb3V0TXMgLyAxMDAwKX1zKWBcclxuICAgICAgICAgICAgOiBTdHJpbmcoZS5jYXVzZT8uY29kZSA/PyBlcnIpLnNsaWNlKDAsIDYwKTtcclxuICAgICAgICAgIGZhaWx1cmVzLnB1c2goeyBsYWJlbDogY2gubGFiZWwsIHJlYXNvbiB9KTtcclxuICAgICAgICAgIGxvZ0luZm8oJ3VwZGF0ZScsIGAke2NoLmxhYmVsfSBcdTIxOTIgZmFpbCAke3JlYXNvbn1gKTtcclxuICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCB0YWcgPSBTdHJpbmcocmVsLnRhZ19uYW1lKTtcclxuICAgICAgICBsb2dJbmZvKCd1cGRhdGUnLCBgbGF0ZXN0PSR7dGFnfSBhc3NldHM9JHsocmVsLmFzc2V0cyA/PyBbXSkubGVuZ3RofSB2aWEgJHtjaC5sYWJlbH0ke3N0aWNreSA9PT0gY2guaWQgPyAnKHN0aWNreSknIDogJyd9YCk7XHJcbiAgICAgICAgYXdhaXQgc2F2ZVN0aWNreUNoYW5uZWwoY2guaWQpOyAvLyBcdTdDOThcdTYwMjc6XHU0RTBCXHU2QjIxXHU1MTQ4XHU4QkQ1XHU2NzJDXHU5MDFBXHU5MDUzXHJcbiAgICAgICAgYnVtcFVwZGF0ZSh7IGNoZWNraW5nOiBmYWxzZSwgbGF0ZXN0OiB0YWcsIG5vdGVzOiBTdHJpbmcocmVsLmJvZHkgPz8gJycpLnNsaWNlKDAsIDYwMCksIGNoYW5uZWw6IGNoLmlkIH0pO1xyXG4gICAgICAgIC8vIFx1NjcwOVx1NjVCMFx1NzI0OFx1NEUxNFx1NjcyQVx1NEUwQlx1OEY3RFx1OEZDNyBcdTIxOTIgXHU1NDBFXHU1M0YwXHU0RTBCXHU4RjdEXHU1Qjg5XHU4OEM1XHU1MzA1XHJcbiAgICAgICAgaWYgKGNtcFZlcnNpb24oYXBwLmdldFZlcnNpb24oKSwgdGFnKSA8IDAgJiYgIXVwZGF0ZVN0YXRlLmRvd25sb2FkZWQpIHtcclxuICAgICAgICAgIHZvaWQgZG93bmxvYWRJbnN0YWxsZXIocmVsLmFzc2V0cyA/PyBbXSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiB1cGRhdGVTdGF0ZTtcclxuICAgICAgfVxyXG4gICAgICBjb25zdCBzdW1tYXJ5ID0gc3VtbWFyaXplQ2hlY2tGYWlsdXJlcyhmYWlsdXJlcyk7XHJcbiAgICAgIGxvZ0luZm8oJ3VwZGF0ZScsIGBjaGVjayBmYWlsZWQ6IGFsbCBjaGFubmVscyAoJHtzdW1tYXJ5fSlgKTtcclxuICAgICAgYnVtcFVwZGF0ZSh7IGNoZWNraW5nOiBmYWxzZSwgZXJyb3I6IGBcdTUxNjhcdTkwRThcdTY4QzBcdTY3RTVcdTkwMUFcdTkwNTNcdTU5MzFcdThEMjUoJHtzdW1tYXJ5fSlgLnNsaWNlKDAsIDIwMCkgfSk7XHJcbiAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgbG9nSW5mbygndXBkYXRlJywgYGNoZWNrIGZhaWxlZDogJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxNDApfWApO1xyXG4gICAgICBidW1wVXBkYXRlKHsgY2hlY2tpbmc6IGZhbHNlLCBlcnJvcjogU3RyaW5nKGVycikuc2xpY2UoMCwgMTIwKSB9KTtcclxuICAgIH1cclxuICAgIHJldHVybiB1cGRhdGVTdGF0ZTtcclxuICB9XHJcbiAgYXN5bmMgZnVuY3Rpb24gZG93bmxvYWRJbnN0YWxsZXIoYXNzZXRzOiBBcnJheTx7IG5hbWU6IHN0cmluZzsgYnJvd3Nlcl9kb3dubG9hZF91cmw6IHN0cmluZzsgc2l6ZTogbnVtYmVyIH0+KTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCBhc3NldCA9IGFzc2V0cy5maW5kKChhKSA9PiAvXkhNSC1EZXNrdG9wLVNldHVwLS4qXFwuZXhlJC9pLnRlc3QoYS5uYW1lKSkgPz8gYXNzZXRzLmZpbmQoKGEpID0+IGEubmFtZS5lbmRzV2l0aCgnLmV4ZScpKTtcclxuICAgICAgaWYgKGFzc2V0ID09PSB1bmRlZmluZWQpIHsgYnVtcFVwZGF0ZSh7IGVycm9yOiAncmVsZWFzZSBcdTY1RTBcdTVCODlcdTg4QzVcdTUzMDVcdThENDRcdTRFQTcnIH0pOyByZXR1cm47IH1cclxuICAgICAgY29uc3QgZGVzdCA9IGpvaW4oYXBwLmdldFBhdGgoJ3RlbXAnKSwgYXNzZXQubmFtZSk7XHJcbiAgICAgIC8vIFx1OTU1Q1x1NTBDRlx1NTZERVx1OTAwMFx1OTRGRSArIFx1NTQwQ1x1NkU5MFx1NEYxOFx1NTE0ODpcdTY4QzBcdTY3RTVcdTU0N0RcdTRFMkRcdTc2ODRcdTkwMUFcdTkwNTNcdTYzOTJcdTY3MDBcdTUyNEQoXHU4OUM0XHU1MjE5XHU4OUMxIHVwZGF0ZXItY2hhbm5lbHMudHMpXHJcbiAgICAgIGNvbnN0IG1pcnJvcnMgPSBvcmRlcmVkRG93bmxvYWRNaXJyb3JzKGFzc2V0LmJyb3dzZXJfZG93bmxvYWRfdXJsLCB1cGRhdGVTdGF0ZS5jaGFubmVsKTtcclxuICAgICAgbGV0IGJ1ZjogQnVmZmVyIHwgbnVsbCA9IG51bGw7XHJcbiAgICAgIGxldCBsYXN0RXJyID0gJyc7XHJcbiAgICAgIGZvciAoY29uc3QgdSBvZiBtaXJyb3JzKSB7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgIGxvZ0luZm8oJ3VwZGF0ZScsIGB0cnlpbmcgJHtuZXcgVVJMKHUpLmhvc3R9XHUyMDI2YCk7XHJcbiAgICAgICAgICBjb25zdCByID0gYXdhaXQgZmV0Y2godSwgeyBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoNjAwXzAwMCkgfSk7XHJcbiAgICAgICAgICBpZiAoIXIub2spIHsgbGFzdEVyciA9IGBIVFRQICR7ci5zdGF0dXN9YDsgbG9nSW5mbygndXBkYXRlJywgYFx1MjE5MiBIVFRQICR7ci5zdGF0dXN9YCk7IGNvbnRpbnVlOyB9XHJcbiAgICAgICAgICBidWYgPSBCdWZmZXIuZnJvbShhd2FpdCByLmFycmF5QnVmZmVyKCkpO1xyXG4gICAgICAgICAgaWYgKGJ1Zi5sZW5ndGggPiAxXzAwMF8wMDApIHsgbG9nSW5mbygndXBkYXRlJywgYFx1MjE5MiBvayAke01hdGgucm91bmQoYnVmLmxlbmd0aCAvIDFlNil9TUJgKTsgYnJlYWs7IH1cclxuICAgICAgICAgIGxhc3RFcnIgPSAnXHU1MTg1XHU1QkI5XHU1RjAyXHU1RTM4JzsgYnVmID0gbnVsbDtcclxuICAgICAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgICAgIGNvbnN0IGUgPSBlcnIgYXMgeyBjYXVzZT86IHsgY29kZT86IHVua25vd24gfSB9O1xyXG4gICAgICAgICAgbGFzdEVyciA9IFN0cmluZyhlLmNhdXNlPy5jb2RlID8/IGVycikuc2xpY2UoMCwgNjApO1xyXG4gICAgICAgICAgbG9nSW5mbygndXBkYXRlJywgYFx1MjE5MiBmYWlsICR7bGFzdEVycn1gKTtcclxuICAgICAgICB9XHJcbiAgICAgIH1cclxuICAgICAgaWYgKGJ1ZiA9PT0gbnVsbCkgdGhyb3cgbmV3IEVycm9yKGBcdTUxNjhcdTkwRThcdTRFMEJcdThGN0RcdTkwMUFcdTkwNTNcdTU5MzFcdThEMjUoJHtsYXN0RXJyfSlgKTtcclxuICAgICAgY29uc3QgeyB3cml0ZUZpbGU6IHdmIH0gPSBhd2FpdCBpbXBvcnQoJ25vZGU6ZnMvcHJvbWlzZXMnKTtcclxuICAgICAgYXdhaXQgd2YoZGVzdCwgYnVmKTtcclxuICAgICAgaW5zdGFsbGVyUGF0aCA9IGRlc3Q7XHJcbiAgICAgIGJ1bXBVcGRhdGUoeyBkb3dubG9hZGVkOiB0cnVlIH0pO1xyXG4gICAgICBsb2dJbmZvKCd1cGRhdGUnLCBgXHU1REYyXHU0RTBCXHU4RjdEICR7YXNzZXQubmFtZX0oJHtNYXRoLnJvdW5kKGJ1Zi5sZW5ndGggLyAxZTYpfU1CKSBcdTIxOTIgJHtkZXN0fWApO1xyXG4gICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgIGJ1bXBVcGRhdGUoeyBlcnJvcjogYFx1NEUwQlx1OEY3RFx1NTkzMVx1OEQyNTogJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApfWAgfSk7XHJcbiAgICB9XHJcbiAgfVxyXG4gIGZ1bmN0aW9uIGFwcGx5VXBkYXRlKCk6IHZvaWQge1xyXG4gICAgaWYgKGluc3RhbGxlclBhdGggPT09IG51bGwpIHJldHVybjtcclxuICAgIC8vIFx1OTAwMFx1NTFGQVx1NUY1M1x1NTI0RFx1NUU5NFx1NzUyOFx1NTQwRVx1NzUzMVx1NUI4OVx1ODhDNVx1NTY2OFx1OTc1OVx1OUVEOFx1ODk4Nlx1NzZENlx1NUI4OVx1ODhDNShcdTg4QzVcdTU2REVcdTUzOUZcdTc2RUVcdTVGNTUpXHUzMDAyTlNJUyBhc3Npc3RlZCBcdTg5QzRcdTUyMTk6XHJcbiAgICAvLyAvUyBcdTRFMTQgL0Q9cGF0aCBcdTVGQzVcdTk4N0JcdTY3MDBcdTU0MEVcdTRFMDBcdTRFMkFcdTUzQzJcdTY1NzBcdTMwMDFcdTUwM0NcdTRFMERcdTUyQTBcdTVGMTVcdTUzRjcoXHU1NDJCXHU3QTdBXHU2ODNDXHU0RTVGXHU0RTBEXHU1MkEwKVx1MjAxNFx1MjAxNG5vZGUgc3Bhd25cclxuICAgIC8vIFx1OUVEOFx1OEJBNFx1NEYxQVx1N0VEOVx1NTQyQlx1N0E3QVx1NjgzQ1x1NTNDMlx1NjU3MFx1NTJBMFx1NUYxNVx1NTNGN1x1NUJGQ1x1ODFGNCBOU0lTIFx1ODlFM1x1Njc5MFx1OTUxOVx1OERFRlx1NUY4NChcdTVCOUVcdTZENEJcdTg4QzVcdTU3NEZcdTc2RUVcdTVGNTUpLFx1NjU0NVx1NzUyOFxyXG4gICAgLy8gd2luZG93c1ZlcmJhdGltQXJndW1lbnRzIFx1NTM5Rlx1NjgzN1x1NEYyMFx1OTAxMlx1MzAwMlxyXG4gICAgY29uc3QgaW5zdGFsbERpciA9IGRpcm5hbWUocHJvY2Vzcy5leGVjUGF0aCk7XHJcbiAgICBjb25zdCBjaGlsZCA9IHNwYXduKGBcIiR7aW5zdGFsbGVyUGF0aH1cIiAvUyAvRD0ke2luc3RhbGxEaXJ9YCwge1xyXG4gICAgICBkZXRhY2hlZDogdHJ1ZSxcclxuICAgICAgc3RkaW86ICdpZ25vcmUnLFxyXG4gICAgICB3aW5kb3dzSGlkZTogdHJ1ZSxcclxuICAgICAgc2hlbGw6IGZhbHNlLFxyXG4gICAgICB3aW5kb3dzVmVyYmF0aW1Bcmd1bWVudHM6IHRydWUsXHJcbiAgICB9KTtcclxuICAgIGNoaWxkLnVucmVmKCk7XHJcbiAgICBsb2dJbmZvKCd1cGRhdGUnLCBgYXBwbHk6ICR7aW5zdGFsbGVyUGF0aH0gXHUyMTkyICR7aW5zdGFsbERpcn1gKTtcclxuICAgIGFwcC5leGl0KDApO1xyXG4gIH1cclxuXHJcbiAgZnVuY3Rpb24gYnVpbGRBcHBNZW51KCk6IHZvaWQge1xyXG4gICAgLy8gXHU3Q0JFXHU3QjgwOlx1NTNFQVx1NEZERFx1NzU1OSBVSSBcdTZDQTFcdTY3MDlcdTc2ODRcdTdDRkJcdTdFREZcdTdFQTdcdTgwRkRcdTUyOUIoXHU1MjZBXHU4RDM0XHU2NzdGL1x1N0E5N1x1NTNFMyk7XHU1MTc2XHU0RjU5XHU1NTJGXHU0RTAwXHU1MTY1XHU1M0UzXHU1NzI4IFVJXHUzMDAyXHJcbiAgICBjb25zdCB0ZW1wbGF0ZTogQXJyYXk8RWxlY3Ryb24uTWVudUl0ZW1Db25zdHJ1Y3Rvck9wdGlvbnM+ID0gW1xyXG4gICAgICB7XHJcbiAgICAgICAgbGFiZWw6ICdcdTdGMTZcdThGOTEnLFxyXG4gICAgICAgIHN1Ym1lbnU6IFtcclxuICAgICAgICAgIHsgcm9sZTogJ3VuZG8nLCBsYWJlbDogJ1x1NjRBNFx1OTUwMCcgfSxcclxuICAgICAgICAgIHsgcm9sZTogJ3JlZG8nLCBsYWJlbDogJ1x1OTFDRFx1NTA1QScgfSxcclxuICAgICAgICAgIHsgdHlwZTogJ3NlcGFyYXRvcicgfSxcclxuICAgICAgICAgIHsgcm9sZTogJ2N1dCcsIGxhYmVsOiAnXHU1MjZBXHU1MjA3JyB9LFxyXG4gICAgICAgICAgeyByb2xlOiAnY29weScsIGxhYmVsOiAnXHU1OTBEXHU1MjM2JyB9LFxyXG4gICAgICAgICAgeyByb2xlOiAncGFzdGUnLCBsYWJlbDogJ1x1N0M5OFx1OEQzNCcgfSxcclxuICAgICAgICAgIHsgcm9sZTogJ3NlbGVjdEFsbCcsIGxhYmVsOiAnXHU1MTY4XHU5MDA5JyB9LFxyXG4gICAgICAgIF0sXHJcbiAgICAgIH0sXHJcbiAgICAgIHtcclxuICAgICAgICBsYWJlbDogJ1x1N0E5N1x1NTNFMycsXHJcbiAgICAgICAgc3VibWVudTogW1xyXG4gICAgICAgICAgeyByb2xlOiAnbWluaW1pemUnLCBsYWJlbDogJ1x1NjcwMFx1NUMwRlx1NTMxNicgfSxcclxuICAgICAgICAgIHsgcm9sZTogJ3pvb20nLCBsYWJlbDogJ1x1N0YyOVx1NjUzRScgfSxcclxuICAgICAgICAgIHsgdHlwZTogJ3NlcGFyYXRvcicgfSxcclxuICAgICAgICAgIHsgcm9sZTogJ2Nsb3NlJywgbGFiZWw6ICdcdTUxNzNcdTk1RUQnIH0sXHJcbiAgICAgICAgXSxcclxuICAgICAgfSxcclxuICAgIF07XHJcbiAgICBNZW51LnNldEFwcGxpY2F0aW9uTWVudShNZW51LmJ1aWxkRnJvbVRlbXBsYXRlKHRlbXBsYXRlKSk7XHJcbiAgfVxyXG4gIC8qKiBcdTY4MDdcdTk4OThcdTY4MEYgXHUyNjMwIFx1NEUzQlx1ODNEQ1x1NTM1NShcdTVFMzhcdTc1MjhcdTUyQThcdTRGNUNcdTc2ODRcdTU1MkZcdTRFMDBcdTUxNjVcdTUzRTM7XHU4OUM2XHU1NkZFXHU2MDAxXHU3RUNGIG1lbnU6YWN0aW9uIFx1OEY2Q1x1NTNEMSlcdTMwMDIgKi9cclxuICBmdW5jdGlvbiBwb3B1cE1haW5NZW51KCk6IHZvaWQge1xyXG4gICAgY29uc3Qgc2VuZCA9IChhOiBzdHJpbmcpOiB2b2lkID0+IHtcclxuICAgICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XHJcbiAgICAgICAgaWYgKCF3LmlzRGVzdHJveWVkKCkpIHcud2ViQ29udGVudHMuc2VuZCgnbWVudTphY3Rpb24nLCBhKTtcclxuICAgICAgfVxyXG4gICAgfTtcclxuICAgIGNvbnN0IHdpbiA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmZpbmQoKHcpID0+ICF3LmlzRGVzdHJveWVkKCkpO1xyXG4gICAgaWYgKHdpbiA9PT0gdW5kZWZpbmVkKSByZXR1cm47XHJcbiAgICBNZW51LmJ1aWxkRnJvbVRlbXBsYXRlKFtcclxuICAgICAgeyBsYWJlbDogJ1x1NjVCMFx1NUVGQVx1NEYxQVx1OEJERCcsIGFjY2VsZXJhdG9yOiAnQ21kT3JDdHJsK04nLCBjbGljazogKCk6IHZvaWQgPT4gc2VuZCgnbmV3LXNlc3Npb24nKSB9LFxyXG4gICAgICB7IGxhYmVsOiAnXHU4QkJFXHU3RjZFJywgYWNjZWxlcmF0b3I6ICdDbWRPckN0cmwrU2hpZnQrUCcsIGNsaWNrOiAoKTogdm9pZCA9PiBzZW5kKCdvcGVuLXNldHRpbmdzJykgfSxcclxuICAgICAgeyBsYWJlbDogJ1x1NUZFQlx1NjM3N1x1OTUyRScsIGFjY2VsZXJhdG9yOiAnQ21kT3JDdHJsKy8nLCBjbGljazogKCk6IHZvaWQgPT4gc2VuZCgnc2hvcnRjdXRzJykgfSxcclxuICAgICAgeyB0eXBlOiAnc2VwYXJhdG9yJyB9LFxyXG4gICAgICB7IGxhYmVsOiAnXHU2MjRCXHU2NzNBXHU4RkRDXHU3QTBCXHU2M0E3XHU1MjM2JywgY2xpY2s6ICgpOiB2b2lkID0+IHNlbmQoJ29wZW4tcmVtb3RlJykgfSxcclxuICAgICAgeyB0eXBlOiAnc2VwYXJhdG9yJyB9LFxyXG4gICAgICB7XHJcbiAgICAgICAgbGFiZWw6IHVwZGF0ZVN0YXRlLmRvd25sb2FkZWQgPyBgXHU5MUNEXHU1NDJGXHU1RTc2XHU1Qjg5XHU4OEM1XHU2NkY0XHU2NUIwKHYke3VwZGF0ZVN0YXRlLmxhdGVzdCA/PyAnPyd9KWAgOiAnXHU2OEMwXHU2N0U1XHU2NkY0XHU2NUIwXHUyMDI2JyxcclxuICAgICAgICBjbGljazogKCk6IHZvaWQgPT4ge1xyXG4gICAgICAgICAgaWYgKHVwZGF0ZVN0YXRlLmRvd25sb2FkZWQpIHsgYXBwbHlVcGRhdGUoKTsgcmV0dXJuOyB9XHJcbiAgICAgICAgICB2b2lkIGNoZWNrRm9yVXBkYXRlcygpLnRoZW4oKHN0KSA9PiB7XHJcbiAgICAgICAgICAgIGNvbnN0IG5ld2VyID0gc3QubGF0ZXN0ICE9PSBudWxsICYmIGNtcFZlcnNpb24oc3QuY3VycmVudFZlcnNpb24sIHN0LmxhdGVzdCkgPCAwO1xyXG4gICAgICAgICAgICBjb25zdCBkZXRhaWwgPSBuZXdlciA/IGAke3N0Lm5vdGVzfVxcblxcblx1NUI4OVx1ODhDNVx1NTMwNVx1NkI2M1x1NTcyOFx1NTQwRVx1NTNGMFx1NEUwQlx1OEY3RCxcdTVCOENcdTYyMTBcdTU0MEUgXHUyNjMwIFx1ODNEQ1x1NTM1NVx1NEYxQVx1NTFGQVx1NzNCMFwiXHU5MUNEXHU1NDJGXHU1RTc2XHU1Qjg5XHU4OEM1XHU2NkY0XHU2NUIwXCJcdTMwMDJgIDogJyc7XHJcbiAgICAgICAgICAgIHZvaWQgZGlhbG9nLnNob3dNZXNzYWdlQm94KHdpbiwge1xyXG4gICAgICAgICAgICAgIHR5cGU6ICdpbmZvJyxcclxuICAgICAgICAgICAgICB0aXRsZTogJ1x1NjhDMFx1NjdFNVx1NjZGNFx1NjVCMCcsXHJcbiAgICAgICAgICAgICAgbWVzc2FnZTogbmV3ZXJcclxuICAgICAgICAgICAgICAgID8gYFx1NTNEMVx1NzNCMFx1NjVCMFx1NzI0OFx1NjcyQyB2JHtzdC5sYXRlc3R9IWBcclxuICAgICAgICAgICAgICAgIDogKHN0LmVycm9yICE9PSAnJyA/IGBcdTY4QzBcdTY3RTVcdTU5MzFcdThEMjU6JHtzdC5lcnJvcn1gIDogYFx1NURGMlx1NjYyRlx1NjcwMFx1NjVCMFx1NzI0OFx1NjcyQyh2JHtzdC5jdXJyZW50VmVyc2lvbn0pYCksXHJcbiAgICAgICAgICAgICAgZGV0YWlsLFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgIH0pO1xyXG4gICAgICAgIH0sXHJcbiAgICAgIH0sXHJcbiAgICAgIHtcclxuICAgICAgICBsYWJlbDogJ1x1NTE3M1x1NEU4RSBITUggRGVza3RvcCcsXHJcbiAgICAgICAgY2xpY2s6ICgpOiB2b2lkID0+IHtcclxuICAgICAgICAgIHZvaWQgZGlhbG9nLnNob3dNZXNzYWdlQm94KHdpbiwge1xyXG4gICAgICAgICAgICB0eXBlOiAnaW5mbycsXHJcbiAgICAgICAgICAgIHRpdGxlOiAnXHU1MTczXHU0RThFIEhNSCBEZXNrdG9wJyxcclxuICAgICAgICAgICAgbWVzc2FnZTogJ0hNSCBEZXNrdG9wJyxcclxuICAgICAgICAgICAgZGV0YWlsOiBgYXBwIHYke2FwcC5nZXRWZXJzaW9uKCl9IFx1MDBCNyBcdTY2RjRcdTY1QjBcdTkwMUFcdTkwNTM6JHt1cGRhdGVTdGF0ZS5jaGFubmVsIHx8ICctJ31cXG5ydW50aW1lOiBobWhhcm5lc3MgJHticmlkZ2UuaG9zdFZlcnNpb24gPz8gJyhcdTY3MkFcdThGREVcdTYzQTUpJ30ke3VzZUJ1bmRsZWRSdW50aW1lID8gJyhcdTUxODVcdTdGNkUpJyA6ICcnfVxcblx1NkEyMVx1NUYwRjogJHticmlkZ2UubW9kZSA9PT0gJ3JlYWwnID8gKHVzZUJ1bmRsZWRSdW50aW1lID8gJ1x1NzcxRlx1NUI5RSBobWhhcm5lc3MoXHU1MTg1XHU3RjZFIHJ1bnRpbWUpJyA6ICdcdTc3MUZcdTVCOUUgaG1oYXJuZXNzKFx1NTkxNlx1OTBFOFx1NUI4OVx1ODhDNSknKSA6ICdcdTZGMTRcdTc5M0EoXHU1MDQ3XHU2NTcwXHU2MzZFKSd9XFxuXFxuXHU0RTBFIENMSSAvIFRVSSAvIFx1N0Y1MVx1OTg3NVx1NzI0OFx1NTE3MVx1NEVBQlx1NTQwQ1x1NEUwMCBITUhfSE9NRVx1MzAwMmAsXHJcbiAgICAgICAgICB9KTtcclxuICAgICAgICB9LFxyXG4gICAgICB9LFxyXG4gICAgICB7IGxhYmVsOiAnXHU5MDAwXHU1MUZBJywgcm9sZTogJ3F1aXQnIH0sXHJcbiAgICBdKS5wb3B1cCh7IHdpbmRvdzogd2luIH0pO1xyXG4gIH1cclxuXHJcbiAgLyogLS0tLSBcdTYyNEJcdTY3M0FcdThGRENcdTdBMEJcdTYzQTdcdTUyMzYoMDMgXHU1M0Y3OldlYiA3Nzg4IFx1NjYyRlx1NkQ0Rlx1ODlDOFx1NTY2OC9cdThGRENcdTdBMEIvXHU2MjRCXHU2NzNBXHU1MTY1XHU1M0UzLEFEUi0wMDU6XHJcbiAgICAgRGVza3RvcCBcdTRFMERcdTlFRDhcdThCQTRcdTYyNTNcdTVGMDAgTEFOIFx1MjAxNFx1MjAxNCBcdThGRDlcdTkxQ0NcdTY2MkZcdTc1MjhcdTYyMzdcdTY2M0VcdTVGMEZcdTU0MkZcdTUyQThcdTc2ODRcdTUxNjVcdTUzRTMpIC0tLS0gKi9cclxuICBjb25zdCBXRUJfUE9SVCA9IDc3ODg7XHJcbiAgYXN5bmMgZnVuY3Rpb24gcHJvYmVXZWJSZW1vdGUoKTogUHJvbWlzZTx7IHVwOiBib29sZWFuOyB2ZXJzaW9uOiBzdHJpbmcgfT4ge1xyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3QgciA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7V0VCX1BPUlR9L2FwaS9zdGF0ZWAsIHsgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDE1MDApIH0pO1xyXG4gICAgICBpZiAoIXIub2spIHJldHVybiB7IHVwOiBmYWxzZSwgdmVyc2lvbjogJycgfTtcclxuICAgICAgY29uc3QgZCA9IChhd2FpdCByLmpzb24oKSkgYXMgeyBkYWVtb25WZXJzaW9uPzogc3RyaW5nIH07XHJcbiAgICAgIHJldHVybiB7IHVwOiB0cnVlLCB2ZXJzaW9uOiBTdHJpbmcoZC5kYWVtb25WZXJzaW9uID8/ICcnKSB9O1xyXG4gICAgfSBjYXRjaCB7IHJldHVybiB7IHVwOiBmYWxzZSwgdmVyc2lvbjogJycgfTsgfVxyXG4gIH1cclxuICAvKiogXHU1RjAwXHU2NzNBXHU4MUVBXHU1NDJGXHU2NjJGXHU1NDI2XHU1REYyXHU4OEM1KHJ1bnRpbWUgd2ViLWRhZW1vbiBcdTc2ODRcdTU0MkZcdTUyQThcdTk4NzlcdTY1ODdcdTRFRjZcdTVCNThcdTU3MjhcdTYwMjc7MC4yMy4zNyBcdTY1QjBcdTgwRkRcdTUyOUIpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gd2ViQXV0b3N0YXJ0SW5zdGFsbGVkKCk6IGJvb2xlYW4ge1xyXG4gICAgY29uc3QgaG9tZSA9IHByb2Nlc3MuZW52LkhPTUUgPz8gJyc7XHJcbiAgICBjb25zdCBjYW5kaWRhdGVzID0gcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gJ3dpbjMyJ1xyXG4gICAgICA/IFtqb2luKHByb2Nlc3MuZW52LkFQUERBVEEgPz8gJycsICdNaWNyb3NvZnQnLCAnV2luZG93cycsICdTdGFydCBNZW51JywgJ1Byb2dyYW1zJywgJ1N0YXJ0dXAnLCAnaG1oYXJuZXNzLXdlYi1kYWVtb24uY21kJyldXHJcbiAgICAgIDogcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gJ2RhcndpbidcclxuICAgICAgICA/IFtqb2luKGhvbWUsICdMaWJyYXJ5JywgJ0xhdW5jaEFnZW50cycsICdobWhhcm5lc3Mtd2ViLWRhZW1vbi5wbGlzdCcpXVxyXG4gICAgICAgIDogW2pvaW4oaG9tZSwgJy5jb25maWcnLCAnc3lzdGVtZCcsICd1c2VyJywgJ2htaGFybmVzcy13ZWItZGFlbW9uLnNlcnZpY2UnKV07XHJcbiAgICByZXR1cm4gY2FuZGlkYXRlcy5zb21lKChwKSA9PiB7IHRyeSB7IHJldHVybiBleGlzdHNTeW5jKHApOyB9IGNhdGNoIHsgcmV0dXJuIGZhbHNlOyB9IH0pO1xyXG4gIH1cclxuICAvKiogXHU2MjRCXHU2NzNBXHU1M0VGXHU4REVGXHU3NTMxXHU3Njg0IExBTiBJUChSRkMxOTE4LFx1NjM5Mlx1OTY2NFx1ODY1QVx1NjJERlx1N0Y1MVx1NTM2MSlcdTMwMDIgKi9cclxuICBmdW5jdGlvbiBsYW5JcE9mKCk6IHN0cmluZyB7XHJcbiAgICBjb25zdCBWSVJUVUFMID0gL3Ztd2FyZXx2aXJ0dWFsfGh5cGVyLT92fHZldGhlcm5ldHx3c2x8dGFpbHNjYWxlfGxvb3BiYWNrfGJsdWV0b290aHx2Ym94fGRvY2tlcnx0YXAtfHBzZXVkby9pO1xyXG4gICAgY29uc3QgaXNSZmMxOTE4ID0gKGE6IHN0cmluZyk6IGJvb2xlYW4gPT4gL14xMFxcLi8udGVzdChhKSB8fCAvXjE5MlxcLjE2OFxcLi8udGVzdChhKSB8fCAvXjE3MlxcLigxWzYtOV18MlxcZHwzWzAxXSlcXC4vLnRlc3QoYSk7XHJcbiAgICBsZXQgbGFuSXAgPSAnJztcclxuICAgIGxldCBmYWxsYmFjayA9ICcnO1xyXG4gICAgZm9yIChjb25zdCBbbmFtZSwgbGlzdF0gb2YgT2JqZWN0LmVudHJpZXMobmV0d29ya0ludGVyZmFjZXMoKSkpIHtcclxuICAgICAgZm9yIChjb25zdCBuIG9mIGxpc3QgPz8gW10pIHtcclxuICAgICAgICBpZiAobi5mYW1pbHkgIT09ICdJUHY0JyB8fCBuLmludGVybmFsIHx8ICFpc1JmYzE5MTgobi5hZGRyZXNzKSkgY29udGludWU7XHJcbiAgICAgICAgaWYgKCFWSVJUVUFMLnRlc3QobmFtZSkpIGxhbklwID0gbGFuSXAgfHwgbi5hZGRyZXNzO1xyXG4gICAgICAgIGVsc2UgZmFsbGJhY2sgPSBmYWxsYmFjayB8fCBuLmFkZHJlc3M7XHJcbiAgICAgIH1cclxuICAgIH1cclxuICAgIHJldHVybiBsYW5JcCB8fCBmYWxsYmFjaztcclxuICB9XHJcbiAgLyoqIENMSSBcdTUxNjVcdTUzRTM6XHU2RTkwXHU3ODAxIHJlcG8gXHU1RTAzXHU1QzQwKG1haW4udHMsXHU3RUNGIHRzeClcdTYyMTYgbnBtIFx1NUI4OVx1ODhDNVx1NUUwM1x1NUM0MChkaXN0L21haW4uanNcclxuICAgKiAgXHU3NkY0XHU4REQxXHUyMDE0XHUyMDE0XHU0RUNFIHJ1bnRpbWUgXHU1MTY1XHU1M0UzXHU0RTBBXHU2RUFGXHU2MjdFIEBobWhhcm5lc3MvY2xpIFx1NTMwNTtcdTVENENcdTU5NTcvXHU2M0QwXHU1MzQ3L1x1NkU5MFx1NzgwMVx1NEUwOVx1NzlDRFx1NUUwM1x1NUM0MFx1OTAxQVx1NTQwMylcdTMwMDIgKi9cclxuICBmdW5jdGlvbiBjbGlFbnRyeU9mKCk6IHN0cmluZyB7XHJcbiAgICBpZiAocnVudGltZUVudHJ5ID09PSAnJyB8fCBydW50aW1lRW50cnkgPT09IG51bGwpIHJldHVybiAnJztcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHAgPSBqb2luKHJlcG9Sb290T2YocnVudGltZUVudHJ5KSwgJ3BhY2thZ2VzJywgJ2NsaScsICdzcmMnLCAnbWFpbi50cycpO1xyXG4gICAgICBpZiAoZXhpc3RzU3luYyhwKSkgcmV0dXJuIHA7XHJcbiAgICB9IGNhdGNoIHsgLyogXHU5NzVFIHJlcG8gXHU1RTAzXHU1QzQwICovIH1cclxuICAgIGxldCBkaXIgPSBkaXJuYW1lKHJ1bnRpbWVFbnRyeSk7XHJcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IDg7IGkrKykge1xyXG4gICAgICBpZiAoZXhpc3RzU3luYyhqb2luKGRpciwgJ2Rpc3QnLCAnbWFpbi5qcycpKSAmJiBwa2dOYW1lQXQoZGlyKSA9PT0gJ0BobWhhcm5lc3MvY2xpJykgcmV0dXJuIGpvaW4oZGlyLCAnZGlzdCcsICdtYWluLmpzJyk7XHJcbiAgICAgIGlmIChiYXNlbmFtZShkaXIpID09PSAnQGhtaGFybmVzcycgJiYgZXhpc3RzU3luYyhqb2luKGRpciwgJ2NsaScsICdkaXN0JywgJ21haW4uanMnKSkpIHJldHVybiBqb2luKGRpciwgJ2NsaScsICdkaXN0JywgJ21haW4uanMnKTtcclxuICAgICAgY29uc3QgcGFyZW50ID0gZGlybmFtZShkaXIpO1xyXG4gICAgICBpZiAocGFyZW50ID09PSBkaXIpIGJyZWFrO1xyXG4gICAgICBkaXIgPSBwYXJlbnQ7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gJyc7XHJcbiAgfVxyXG4gIGZ1bmN0aW9uIHJ1bkNsaShhcmdzOiBzdHJpbmdbXSk6IHZvaWQge1xyXG4gICAgY29uc3QgZW50cnkgPSBjbGlFbnRyeU9mKCk7XHJcbiAgICBpZiAoZW50cnkgPT09ICcnKSByZXR1cm47XHJcbiAgICBjb25zdCBpc1RzID0gZW50cnkuZW5kc1dpdGgoJy50cycpO1xyXG4gICAgY29uc3QgcmVwbyA9IHJlcG9Sb290T2YocnVudGltZUVudHJ5ID8/IGVudHJ5KTtcclxuICAgIGNvbnN0IGNoaWxkID0gc3Bhd24ocHJvY2Vzcy5leGVjUGF0aCwgaXNUcyA/IFsnLS1pbXBvcnQnLCAndHN4JywgZW50cnksIC4uLmFyZ3NdIDogW2VudHJ5LCAuLi5hcmdzXSwge1xyXG4gICAgICBjd2Q6IGlzVHMgPyByZXBvIDogZGlybmFtZShlbnRyeSksXHJcbiAgICAgIGRldGFjaGVkOiB0cnVlLFxyXG4gICAgICBzdGRpbzogJ2lnbm9yZScsXHJcbiAgICAgIHdpbmRvd3NIaWRlOiB0cnVlLFxyXG4gICAgICBlbnY6IHsgRUxFQ1RST05fUlVOX0FTX05PREU6ICcxJyB9LFxyXG4gICAgfSk7XHJcbiAgICBjaGlsZC51bnJlZigpO1xyXG4gIH1cclxuXHJcbiAgZnVuY3Rpb24gYnJvYWRjYXN0SG9zdFN0YXRlKHM6IEhvc3RTdGF0ZSwgaW5mbzogeyByZXN0YXJ0Q291bnQ6IG51bWJlcjsgbGFzdEVycm9yPzogc3RyaW5nIH0pOiB2b2lkIHtcclxuICAgIGJyaWRnZSA9IHsgLi4uYnJpZGdlLCBob3N0U3RhdGU6IHMsIGhvc3RQb3J0OiBzdXBlcnZpc29yPy5lbmRwb2ludD8ucG9ydCA/PyBudWxsLCBob3N0VmVyc2lvbjogc3VwZXJ2aXNvcj8uZW5kcG9pbnQ/LnZlcnNpb24gPz8gbnVsbCB9O1xyXG4gICAgbG9nSW5mbygnaG9zdCcsIGBzdGF0ZT0ke3N9JHtpbmZvLmxhc3RFcnJvciAhPT0gdW5kZWZpbmVkID8gYCBlcnI9JHtpbmZvLmxhc3RFcnJvcn1gIDogJyd9YCk7XHJcbiAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcclxuICAgICAgaWYgKCF3LmlzRGVzdHJveWVkKCkpIHcud2ViQ29udGVudHMuc2VuZCgnYnJpZGdlOmhvc3Qtc3RhdGUnLCBzLCBpbmZvKTtcclxuICAgIH1cclxuICB9XHJcblxyXG4gIC8qKiBTU0UgXHU2RDQxXHU4QkEyXHU5NjA1Olx1NEZFMVx1NUMwMShldmVudDogaG1oKVx1NjI3OVx1OTFDRlx1NjNBOCByZW5kZXJlcjtcdTlBRDhcdTk4OTEgZGVsdGEvbGluZSBcdTUzOUZcdTVFMjdcclxuICAgKiAgXHU0RjVDXHU0RTNBXHU2RDQxXHU1NzU3XHU4RjZDXHU1M0QxKHJlbmRlcmVyIFx1NjJGQ1x1NjNBNVx1NUY1M1x1NTI0RCBhc3Npc3RhbnQgXHU1MzYwXHU0RjREKVx1MzAwMlx1NjVBRFx1N0VCRlx1ODFFQVx1NTJBOFx1OTFDRFx1OEZERVx1MzAwMiAqL1xyXG4gIGFzeW5jIGZ1bmN0aW9uIHB1bXBFdmVudHMoKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBpZiAoY2xpZW50ID09PSBudWxsKSByZXR1cm47XHJcbiAgICBmb3IgKDs7KSB7XHJcbiAgICAgIGNvbnN0IGMgPSBjbGllbnQ7XHJcbiAgICAgIGlmIChjID09PSBudWxsKSByZXR1cm47XHJcbiAgICAgIHRyeSB7XHJcbiAgICAgICAgZm9yIGF3YWl0IChjb25zdCBmcmFtZSBvZiBjLnJhd0V2ZW50cyhsYXN0RXZlbnRJZCA9PT0gJycgPyB1bmRlZmluZWQgOiBsYXN0RXZlbnRJZCwgc3NlQWJvcnQ/LnNpZ25hbCkpIHtcclxuICAgICAgICAgIGlmIChmcmFtZS5ldmVudCA9PT0gJ2htaCcpIHtcclxuICAgICAgICAgICAgY29uc3QgZW52ID0gZW52ZWxvcGVGcm9tRnJhbWUoZnJhbWUpO1xyXG4gICAgICAgICAgICBpZiAoZW52ID09PSBudWxsKSB7XHJcbiAgICAgICAgICAgICAgZHJvcHBlZEZyYW1lcyArPSAxO1xyXG4gICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGxhc3RFdmVudElkID0gZW52LmV2ZW50SWQ7XHJcbiAgICAgICAgICAgIHB1c2hFdmVudChlbnYpO1xyXG4gICAgICAgICAgfSBlbHNlIGlmIChmcmFtZS5ldmVudCA9PT0gJ2RlbHRhJyB8fCBmcmFtZS5ldmVudCA9PT0gJ2xpbmUnKSB7XHJcbiAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgY29uc3QgZCA9IEpTT04ucGFyc2UoZnJhbWUuZGF0YSkgYXMgeyBzZXNzaW9uSWQ/OiBzdHJpbmc7IGs/OiBzdHJpbmc7IGNodW5rPzogc3RyaW5nOyB0ZXh0Pzogc3RyaW5nIH07XHJcbiAgICAgICAgICAgICAgY29uc3QgcGF5bG9hZCA9IGZyYW1lLmV2ZW50ID09PSAnZGVsdGEnXHJcbiAgICAgICAgICAgICAgICA/IHsgc2Vzc2lvbklkOiBkLnNlc3Npb25JZCA/PyAnJywga2luZDogZC5rID8/ICd0ZXh0JywgY2h1bms6IFN0cmluZyhkLmNodW5rID8/ICcnKSB9XHJcbiAgICAgICAgICAgICAgICA6IHsgc2Vzc2lvbklkOiBkLnNlc3Npb25JZCA/PyAnJywga2luZDogJ2xpbmUnLCBjaHVuazogU3RyaW5nKGQudGV4dCA/PyAnJykgfTtcclxuICAgICAgICAgICAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcclxuICAgICAgICAgICAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ2JyaWRnZTpzdHJlYW0tY2h1bmsnLCBwYXlsb2FkKTtcclxuICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH0gY2F0Y2ggeyAvKiBtYWxmb3JtZWQgc3RyZWFtIGZyYW1lOiBza2lwICovIH1cclxuICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuOyAvLyBcdTZENDFcdTZCNjNcdTVFMzhcdTdFRDNcdTY3NUYoaG9zdCBcdTUxNzNcdTk1RUQpXHJcbiAgICAgIH0gY2F0Y2gge1xyXG4gICAgICAgIC8vIFx1NjVBRFx1N0VCRjpcdTc3RURcdTkwMDBcdTkwN0ZcdTU0MEVcdTkxQ0RcdThGREUoc3VwZXJ2aXNvciBcdTUzRUZcdTgwRkRcdTZCNjNcdTU3MjhcdTkxQ0RcdTU0MkYgaG9zdClcclxuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCAxXzAwMCkpO1xyXG4gICAgICAgIGlmIChzc2VBYm9ydD8uc2lnbmFsLmFib3J0ZWQpIHJldHVybjtcclxuICAgICAgfVxyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgLyogLS0tLSBobWhhcm5lc3MgcnVudGltZSBcdTgxRUFcdTUyQThcdTUzRDFcdTczQjAoMjAyNi0xMC0xMCBcdTc1MjhcdTYyMzdcdTVCOUFcdThDMDM6XHU4OEM1XHU4RkM3IGhtaGFybmVzcyBcdTc2ODRcclxuICAgICBcdTY3M0FcdTU2NjhcdTk2RjZcdTkxNERcdTdGNkVcdTc2RjRcdThGREUsXHU1OTBEXHU3NTI4IENMSS9UVUkvd2ViIDc3ODggXHU3Njg0XHU1NDBDXHU0RTAwIEhNSF9IT01FXHUyMDE0XHUyMDE0Y29uZmlnL3Byb3ZpZGVycy9cclxuICAgICBcdTRGMUFcdThCRERcdTUzODZcdTUzRjJcdTU5MjlcdTcxMzZcdTUxNzFcdTRFQUIpXHUzMDAydjUuMSBcdTUzRDFcdTczQjBcdTk4N0FcdTVFOEY6XHU2NjNFXHU1RjBGXHU5MTREXHU3RjZFID4gd2hlcmUgaG1oKFx1NkU5MFx1NzgwMSBsaW5rIFx1NEUwRVxyXG4gICAgIEBobWhhcm5lc3MvY2xpIG5wbSBcdTVCODlcdTg4QzVcdTRFMjRcdTc5Q0RcdTVFMDNcdTVDNDApPiBucG0gXHU1MTY4XHU1QzQwXHU2ODM5KFx1NTQwQyk+IFx1NTQxMVx1NUJGQ1x1NUI4OVx1ODhDNVx1NzZFRVx1NUY1NVxyXG4gICAgIH4vLmhtaGFybmVzcy1nbG9iYWwgPiBcdTVFMzhcdTg5QzFcdTZFOTBcdTc4MDFcdTRGNERcdTdGNkVcdTMwMDIgKi9cclxuICBjb25zdCBydW50aW1lQ29uZmlnRmlsZSA9ICgpOiBzdHJpbmcgPT4gam9pbihhcHAuZ2V0UGF0aCgndXNlckRhdGEnKSwgJ3J1bnRpbWUuanNvbicpO1xyXG4gIC8qKiBydW50aW1lLmpzb246eyBlbnRyeShcdTYyNEJcdTUyQTgvXHU1NDExXHU1QkZDXHU5MDA5XHU2MkU5XHU3Njg0XHU1MTY1XHU1M0UzKSwgZGVtbyhcdTYzMDFcdTRFNDVcdTZGMTRcdTc5M0FcdTZBMjFcdTVGMEYpIH1cdTMwMDIgKi9cclxuICBhc3luYyBmdW5jdGlvbiBsb2FkUnVudGltZUNvbmZpZygpOiBQcm9taXNlPHsgZW50cnk6IHN0cmluZzsgZGVtbzogYm9vbGVhbiB9PiB7XHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCB2ID0gSlNPTi5wYXJzZShhd2FpdCByZWFkRmlsZShydW50aW1lQ29uZmlnRmlsZSgpLCAndXRmOCcpKSBhcyB7IGVudHJ5PzogdW5rbm93bjsgZGVtbz86IHVua25vd24gfTtcclxuICAgICAgcmV0dXJuIHtcclxuICAgICAgICBlbnRyeTogdHlwZW9mIHYuZW50cnkgPT09ICdzdHJpbmcnICYmIHYuZW50cnkgIT09ICcnICYmIGlzQWJzb2x1dGUodi5lbnRyeSkgPyB2LmVudHJ5IDogJycsXHJcbiAgICAgICAgZGVtbzogdi5kZW1vID09PSB0cnVlLFxyXG4gICAgICB9O1xyXG4gICAgfSBjYXRjaCB7IHJldHVybiB7IGVudHJ5OiAnJywgZGVtbzogZmFsc2UgfTsgfVxyXG4gIH1cclxuICBhc3luYyBmdW5jdGlvbiBzYXZlUnVudGltZUNvbmZpZyhjZmc6IHsgZW50cnk6IHN0cmluZzsgZGVtbzogYm9vbGVhbiB9KTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBhd2FpdCB3cml0ZUZpbGUocnVudGltZUNvbmZpZ0ZpbGUoKSwgSlNPTi5zdHJpbmdpZnkoY2ZnLCBudWxsLCAyKSwgJ3V0ZjgnKS5jYXRjaCgoKSA9PiB1bmRlZmluZWQpO1xyXG4gIH1cclxuICBhc3luYyBmdW5jdGlvbiBsb2FkUnVudGltZUVudHJ5T3ZlcnJpZGUoKTogUHJvbWlzZTxzdHJpbmc+IHtcclxuICAgIHJldHVybiAoYXdhaXQgbG9hZFJ1bnRpbWVDb25maWcoKSkuZW50cnk7XHJcbiAgfVxyXG4gIGFzeW5jIGZ1bmN0aW9uIHNhdmVSdW50aW1lRW50cnlPdmVycmlkZShlbnRyeTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBhd2FpdCBzYXZlUnVudGltZUNvbmZpZyh7IGVudHJ5LCBkZW1vOiAoYXdhaXQgbG9hZFJ1bnRpbWVDb25maWcoKSkuZGVtbyB9KTtcclxuICB9XHJcblxyXG4gIGludGVyZmFjZSBFeHRlcm5hbFJ1bnRpbWUgeyBlbnRyeTogc3RyaW5nOyB2ZXJzaW9uOiBzdHJpbmc7IHNvdXJjZTogc3RyaW5nIH1cclxuXHJcbiAgLyoqIFx1OEJGQlx1NTMwNVx1NzI0OFx1NjcyQyhwYWNrYWdlLmpzb24gXHU3Njg0IHZlcnNpb24gXHU1QjU3XHU2QkI1O1x1NTkzMVx1OEQyNVx1N0E3QVx1NEUzMilcdTMwMDIgKi9cclxuICBmdW5jdGlvbiBwa2dWZXJzaW9uQXQoZGlyOiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3QgdiA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGpvaW4oZGlyLCAncGFja2FnZS5qc29uJyksICd1dGY4JykpIGFzIHsgdmVyc2lvbj86IHVua25vd24gfTtcclxuICAgICAgcmV0dXJuIHR5cGVvZiB2LnZlcnNpb24gPT09ICdzdHJpbmcnID8gdi52ZXJzaW9uIDogJyc7XHJcbiAgICB9IGNhdGNoIHsgcmV0dXJuICcnOyB9XHJcbiAgfVxyXG4gIC8qKiBcdThCRkJcdTUzMDVcdTU0MEQoXHU1NDBDXHU0RTBBO0BobWhhcm5lc3MvY2xpIFx1NUUwM1x1NUM0MFx1OEJDNlx1NTIyQlx1NzUyOClcdTMwMDIgKi9cclxuICBmdW5jdGlvbiBwa2dOYW1lQXQoZGlyOiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3QgdiA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGpvaW4oZGlyLCAncGFja2FnZS5qc29uJyksICd1dGY4JykpIGFzIHsgbmFtZT86IHVua25vd24gfTtcclxuICAgICAgcmV0dXJuIHR5cGVvZiB2Lm5hbWUgPT09ICdzdHJpbmcnID8gdi5uYW1lIDogJyc7XHJcbiAgICB9IGNhdGNoIHsgcmV0dXJuICcnOyB9XHJcbiAgfVxyXG5cclxuICAvKiogbnBtIFx1NUI4OVx1ODhDNVx1NzY4NCBAaG1oYXJuZXNzL2NsaSBcdTIxOTIgZGVza3RvcC1ob3N0IFx1N0YxNlx1OEJEMVx1NTE2NVx1NTNFMyhcdTVENENcdTU5NTdcdTRFMEVcdTYzRDBcdTUzNDdcdTRFMjRcdTc5Q0RcdTVFMDNcdTVDNDApXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gZW50cnlGcm9tQ2xpRGlyKGNsaURpcjogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIGNvbnN0IG5lc3RlZCA9IGpvaW4oY2xpRGlyLCAnbm9kZV9tb2R1bGVzJywgJ0BobWhhcm5lc3MnLCAnd2ViJywgJ2Rpc3QnLCAnZGVza3RvcC1ob3N0LmpzJyk7XHJcbiAgICBpZiAoZXhpc3RzU3luYyhuZXN0ZWQpKSByZXR1cm4gbmVzdGVkO1xyXG4gICAgY29uc3QgaG9pc3RlZCA9IGpvaW4oZGlybmFtZShjbGlEaXIpLCAnd2ViJywgJ2Rpc3QnLCAnZGVza3RvcC1ob3N0LmpzJyk7XHJcbiAgICBpZiAoZXhpc3RzU3luYyhob2lzdGVkKSkgcmV0dXJuIGhvaXN0ZWQ7XHJcbiAgICByZXR1cm4gJyc7XHJcbiAgfVxyXG5cclxuICAvKiogXHU1OTE2XHU5MEU4XHU1M0QxXHU3M0IwKFx1NEY5Qlx1ODFFQVx1NTJBOFx1OEZERVx1NjNBNVx1NEUwRVx1NTQxMVx1NUJGQ1x1NjhDMFx1NkQ0Qlx1OTg3NVx1NTE3MVx1NzUyOClcdTMwMDJcdTRGMThcdTUxNDhcdTdFQTc6ZW52ID4gd2hlcmUgaG1oID4gbnBtXHJcbiAgICogIFx1NTE2OFx1NUM0MFx1NjgzOSA+IFx1NTQxMVx1NUJGQ1x1NUI4OVx1ODhDNVx1NzZFRVx1NUY1NSB+Ly5obWhhcm5lc3MtZ2xvYmFsID4gXHU2RTkwXHU3ODAxXHU0RUQzXHU2MjZCXHU2M0NGO1x1NTQwQ1x1NEUwMFx1NUM0Mlx1NTE4NVxyXG4gICAqICBcIlx1NURGMlx1ODhDNSBDTEkobnBtIFx1NUUwM1x1NUM0MClcIiBcdTUxNDhcdTRFOEUgXCJcdTZFOTBcdTc4MDEgcmVwbyBcdTVFMDNcdTVDNDBcIlx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIGRldGVjdEV4dGVybmFsUnVudGltZSgpOiBFeHRlcm5hbFJ1bnRpbWUge1xyXG4gICAgLy8gMSkgXHU3M0FGXHU1ODgzXHU1M0Q4XHU5MUNGXHU2NjNFXHU1RjBGXHU4OTg2XHU3NkQ2KFx1OUFEOFx1N0VBN1x1NzUyOFx1NjIzNylcclxuICAgIGNvbnN0IGVudkVudHJ5ID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfUkVBTF9FTlRSWTtcclxuICAgIGlmIChlbnZFbnRyeSAhPT0gdW5kZWZpbmVkICYmIGVudkVudHJ5ICE9PSAnJyAmJiBpc0Fic29sdXRlKGVudkVudHJ5KSkge1xyXG4gICAgICByZXR1cm4geyBlbnRyeTogZW52RW50cnksIHZlcnNpb246ICcnLCBzb3VyY2U6ICdlbnYnIH07XHJcbiAgICB9XHJcblxyXG4gICAgY29uc3Qgd2hlcmVSZXBvcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgY29uc3Qgd2hlcmVDbGlzOiBzdHJpbmdbXSA9IFtdO1xyXG4gICAgY29uc3QgbnBtUmVwb3MgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgIGxldCBucG1DbGkgPSAnJztcclxuICAgIC8vIDIpIHdoZXJlIGhtaDpucG0gbGluayhcdTZFOTBcdTc4MDFcdTY4MzlcdTVFMDNcdTVDNDApXHU0RTBFIEBobWhhcm5lc3MvY2xpIG5wbSBcdTVCODlcdTg4QzVcdTVFMDNcdTVDNDBcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IG91dCA9IGV4ZWNGaWxlU3luYygnd2hlcmUnLCBbJ2htaCddLCB7IGVuY29kaW5nOiAndXRmOCcsIHRpbWVvdXQ6IDRfMDAwLCB3aW5kb3dzSGlkZTogdHJ1ZSB9KTtcclxuICAgICAgZm9yIChjb25zdCBsaW5lIG9mIG91dC5zcGxpdCgvXFxyP1xcbi8pKSB7XHJcbiAgICAgICAgY29uc3QgYmluID0gbGluZS50cmltKCk7XHJcbiAgICAgICAgaWYgKGJpbiA9PT0gJycpIGNvbnRpbnVlO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICBjb25zdCBiaW5EaXIgPSBkaXJuYW1lKGJpbik7XHJcbiAgICAgICAgICBjb25zdCBsaW5rZWQgPSBqb2luKGJpbkRpciwgJ25vZGVfbW9kdWxlcycsICdobWhhcm5lc3MnKTtcclxuICAgICAgICAgIGlmIChleGlzdHNTeW5jKGxpbmtlZCkpIHdoZXJlUmVwb3MuYWRkKHJlYWxwYXRoU3luYyhsaW5rZWQpKTtcclxuICAgICAgICAgIGNvbnN0IGNsaSA9IGpvaW4oYmluRGlyLCAnbm9kZV9tb2R1bGVzJywgJ0BobWhhcm5lc3MnLCAnY2xpJyk7XHJcbiAgICAgICAgICBpZiAoZXhpc3RzU3luYyhjbGkpKSB3aGVyZUNsaXMucHVzaChjbGkpO1xyXG4gICAgICAgIH0gY2F0Y2ggeyAvKiBiaW4gXHU1RTAzXHU1QzQwXHU0RTBEXHU3QjI2LFx1OERGM1x1OEZDNyAqLyB9XHJcbiAgICAgIH1cclxuICAgIH0gY2F0Y2ggeyAvKiBobWggXHU0RTBEXHU1NzI4IFBBVEggKi8gfVxyXG4gICAgLy8gMykgbnBtIFx1NTE2OFx1NUM0MFx1NjgzOShcdTRFMjRcdTc5Q0RcdTVFMDNcdTVDNDBcdTU0MEMgd2hlcmUpXHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCBvdXQgPSBleGVjRmlsZVN5bmMoJ25wbScsIFsncm9vdCcsICctZyddLCB7IGVuY29kaW5nOiAndXRmOCcsIHRpbWVvdXQ6IDZfMDAwLCB3aW5kb3dzSGlkZTogdHJ1ZSB9KTtcclxuICAgICAgY29uc3Qgcm9vdCA9IG91dC50cmltKCk7XHJcbiAgICAgIGNvbnN0IGxpbmtlZCA9IGpvaW4ocm9vdCwgJ2htaGFybmVzcycpO1xyXG4gICAgICBpZiAoZXhpc3RzU3luYyhsaW5rZWQpKSBucG1SZXBvcy5hZGQocmVhbHBhdGhTeW5jKGxpbmtlZCkpO1xyXG4gICAgICBjb25zdCBjbGkgPSBqb2luKHJvb3QsICdAaG1oYXJuZXNzJywgJ2NsaScpO1xyXG4gICAgICBpZiAoZXhpc3RzU3luYyhjbGkpKSBucG1DbGkgPSBjbGk7XHJcbiAgICB9IGNhdGNoIHsgLyogbnBtIFx1NEUwRFx1NTNFRlx1NzUyOCAqLyB9XHJcblxyXG4gICAgLy8gXHU1REYyXHU4OEM1IENMSShAaG1oYXJuZXNzL2NsaSBucG0gXHU1RTAzXHU1QzQwO2Rlc2t0b3AtaG9zdCBcdTRFM0FcdTdGMTZcdThCRDFcdTRFQTdcdTcyNjlcdTUzRUZcdTc2RjRcdThERDEpOlxyXG4gICAgLy8gd2hlcmUoUEFUSCBcdTc3MUZcdTc2RjgpPiBucG0gXHU1MTY4XHU1QzQwXHU2ODM5ID4gXHU1NDExXHU1QkZDXHU1Qjg5XHU4OEM1XHU3NkVFXHU1RjU1XHJcbiAgICBmb3IgKGNvbnN0IFtjbGksIHNvdXJjZV0gb2YgW1t3aGVyZUNsaXNbMF0gPz8gJycsICd3aGVyZS1obWgnXSwgW25wbUNsaSwgJ25wbS1nbG9iYWwnXV0gYXMgQXJyYXk8W3N0cmluZywgc3RyaW5nXT4pIHtcclxuICAgICAgaWYgKGNsaSA9PT0gJycpIGNvbnRpbnVlO1xyXG4gICAgICBjb25zdCBlbnRyeSA9IGVudHJ5RnJvbUNsaURpcihjbGkpO1xyXG4gICAgICBpZiAoZW50cnkgIT09ICcnKSByZXR1cm4geyBlbnRyeSwgdmVyc2lvbjogcGtnVmVyc2lvbkF0KGNsaSksIHNvdXJjZSB9O1xyXG4gICAgfVxyXG4gICAgY29uc3Qgd2l6YXJkRW50cnkgPSByZXNvbHZlSW5zdGFsbGVkRW50cnkoaW5zdGFsbFRhcmdldCgpKTtcclxuICAgIGlmICh3aXphcmRFbnRyeSAhPT0gJycpIHtcclxuICAgICAgcmV0dXJuIHsgZW50cnk6IHdpemFyZEVudHJ5LCB2ZXJzaW9uOiBwa2dWZXJzaW9uQXQoam9pbihpbnN0YWxsVGFyZ2V0KCksICdub2RlX21vZHVsZXMnLCAnQGhtaGFybmVzcycsICdjbGknKSksIHNvdXJjZTogJ3dpemFyZC1pbnN0YWxsJyB9O1xyXG4gICAgfVxyXG5cclxuICAgIC8vIFx1NkU5MFx1NzgwMSByZXBvIFx1NUUwM1x1NUM0MCh3aGVyZSA+IG5wbSBcdTUxNjhcdTVDNDAgPiBcdTVFMzhcdTg5QzFcdTZFOTBcdTc4MDFcdTRGNERcdTdGNkU7XHU1NDdEXHU0RTJEXHU5ODdCXHU2NzA5XHU1MTY1XHU1M0UzXHU0RTBFXHU0RjlEXHU4RDU2KVxyXG4gICAgY29uc3QgcmVwb3MgPSBuZXcgU2V0PHN0cmluZz4oWy4uLndoZXJlUmVwb3MsIC4uLm5wbVJlcG9zXSk7XHJcbiAgICBjb25zdCBiYXNlcyA9IFsnQzpcXFxcJywgJ0Q6XFxcXCcsICdFOlxcXFwnLCAnRjpcXFxcJywgJ0c6XFxcXCcsICdIOlxcXFwnLCBob21lZGlyKCksIGpvaW4oaG9tZWRpcigpLCAnRGV2ZWxvcGVyJyldO1xyXG4gICAgZm9yIChjb25zdCBiYXNlIG9mIGJhc2VzKSB7XHJcbiAgICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgcCA9IHJlc29sdmUoYmFzZSwgJ2htaGFybmVzcycpO1xyXG4gICAgICAgIGlmIChleGlzdHNTeW5jKHApKSByZXBvcy5hZGQocCk7XHJcbiAgICAgIH0gY2F0Y2ggeyAvKiBcdTc2RDhcdTRFMERcdTVCNThcdTU3MjggKi8gfVxyXG4gICAgfVxyXG4gICAgZm9yIChjb25zdCByZXBvIG9mIHJlcG9zKSB7XHJcbiAgICAgIGNvbnN0IGVudHJ5ID0gam9pbihyZXBvLCAncGFja2FnZXMnLCAnd2ViJywgJ3NyYycsICdkZXNrdG9wLWhvc3QudHMnKTtcclxuICAgICAgaWYgKGV4aXN0c1N5bmMoZW50cnkpICYmIGV4aXN0c1N5bmMoam9pbihyZXBvLCAnbm9kZV9tb2R1bGVzJykpKSB7XHJcbiAgICAgICAgcmV0dXJuIHsgZW50cnksIHZlcnNpb246IHBrZ1ZlcnNpb25BdChyZXBvKSwgc291cmNlOiAnc291cmNlLXJlcG8nIH07XHJcbiAgICAgIH1cclxuICAgIH1cclxuICAgIHJldHVybiB7IGVudHJ5OiAnJywgdmVyc2lvbjogJycsIHNvdXJjZTogJycgfTtcclxuICB9XHJcblxyXG4gIGZ1bmN0aW9uIGRldGVjdFJlYWxFbnRyeSgpOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIGRldGVjdEV4dGVybmFsUnVudGltZSgpLmVudHJ5O1xyXG4gIH1cclxuXHJcbiAgLyoqIFx1ODlFM1x1Njc5MCBydW50aW1lIFx1NTE2NVx1NTNFM1x1NjI0MFx1NUM1RVx1NzY4NCBobWhhcm5lc3MgXHU0RUQzXHU1RTkzXHU2ODM5KHBhY2thZ2VzL3dlYi9zcmN8ZGlzdCBcdTRFMEFcdTZFQUYpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gcmVwb1Jvb3RPZihlbnRyeTogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIGxldCBkaXIgPSBkaXJuYW1lKGVudHJ5KTtcclxuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgNjsgaSsrKSB7XHJcbiAgICAgIGlmIChleGlzdHNTeW5jKGpvaW4oZGlyLCAncGFja2FnZS5qc29uJykpICYmIGV4aXN0c1N5bmMoam9pbihkaXIsICdwYWNrYWdlcycsICd3ZWInKSkpIHJldHVybiBkaXI7XHJcbiAgICAgIGNvbnN0IHBhcmVudCA9IGRpcm5hbWUoZGlyKTtcclxuICAgICAgaWYgKHBhcmVudCA9PT0gZGlyKSBicmVhaztcclxuICAgICAgZGlyID0gcGFyZW50O1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGRpcm5hbWUoZW50cnkpO1xyXG4gIH1cclxuXHJcbiAgbGV0IHJ1bnRpbWVFbnRyeSA9ICcnOyAvLyBcdTVGNTNcdTUyNERcdTVCOUVcdTk2NDVcdTRGN0ZcdTc1MjhcdTc2ODRcdTc3MUZcdTVCOUUgcnVudGltZSBcdTUxNjVcdTUzRTMoJyc9XHU2NzJBXHU2M0E1KVxyXG4gIGxldCB1c2VCdW5kbGVkUnVudGltZSA9IGZhbHNlOyAvLyB2NTpcdTY2MkZcdTU0MjZcdTU3MjhcdTc1MjhcdTUxODVcdTdGNkUgcnVudGltZShcdTUxNzNcdTRFOEUvXHU5NzYyXHU2NzdGXHU2ODA3XHU2Q0U4KVxyXG5cclxuICAvKiogXHU1MTg1XHU3RjZFIHJ1bnRpbWUodjUgXHU1RjAwXHU3QkIxXHU1MzczXHU3NTI4KTpcdTYyNTNcdTUzMDVcdTU0MEVcdTk2OEYgZXh0cmFSZXNvdXJjZXMgXHU1RTczXHU5NEZBXHU1NzI4IHJlc291cmNlcy87XHJcbiAgICAgZGV2IFx1NzUyOFx1NEVEM1x1NUU5M1x1NTE4NVx1Njc4NFx1NUVGQVx1NEVBN1x1NzI2OShzY3JpcHRzL2J1bmRsZS1ydW50aW1lLm1qcylcdTMwMDJcdTgxRUFcdTUzMDVcdTU0MkJcdTUzNTVcdTY1ODdcdTRFRjYsXHU2NUUwIHRzeFx1MzAwMVxyXG4gICAgIFx1NjVFMCByZXBvIG5vZGVfbW9kdWxlcyBcdTRGOURcdThENTZcdTMwMDIgKi9cclxuICBmdW5jdGlvbiBidW5kbGVkUnVudGltZVBhdGgocmVwb1Jvb3Q6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICByZXR1cm4gam9pbihhcHAuaXNQYWNrYWdlZCA/IHByb2Nlc3MucmVzb3VyY2VzUGF0aCA6IGpvaW4ocmVwb1Jvb3QsICdhcHBzJywgJ2Rlc2t0b3AnLCAncmVzb3VyY2VzJyksICdydW50aW1lJywgJ3J1bnRpbWUuY2pzJyk7XHJcbiAgfVxyXG5cclxuICAvKiogXHU1MTg1XHU3RjZFIHJ1bnRpbWUgXHU1MTQzXHU0RkUxXHU2MDZGKFx1NTQxMVx1NUJGQ1wiXHU1MTg1XHU3RjZFXHU3Q0JFXHU3QjgwXHU1MTg1XHU2ODM4XCJcdTkwMDlcdTk4NzlcdTc2ODRcdTcyNDhcdTY3MkNcdTY4MDdcdTZDRTgpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gYnVuZGxlZFJ1bnRpbWVJbmZvKCk6IHsgcmVhZHk6IGJvb2xlYW47IHZlcnNpb246IHN0cmluZyB9IHtcclxuICAgIGNvbnN0IHJlcG9Sb290ID0gam9pbihoZXJlLCAnLi4nLCAnLi4nLCAnLi4nLCAnLi4nKTtcclxuICAgIGNvbnN0IHAgPSBidW5kbGVkUnVudGltZVBhdGgocmVwb1Jvb3QpO1xyXG4gICAgbGV0IHZlcnNpb24gPSAnJztcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHYgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKGRpcm5hbWUocCksICdwYWNrYWdlLmpzb24nKSwgJ3V0ZjgnKSkgYXMgeyB2ZXJzaW9uPzogdW5rbm93biB9O1xyXG4gICAgICB2ZXJzaW9uID0gdHlwZW9mIHYudmVyc2lvbiA9PT0gJ3N0cmluZycgPyB2LnZlcnNpb24gOiAnJztcclxuICAgIH0gY2F0Y2ggeyAvKiBcdTUxNDNcdTY1NzBcdTYzNkVcdTdGM0FcdTU5MzFcdTUyMTlcdTUzRUFcdTYyQTUgcmVhZHkgKi8gfVxyXG4gICAgcmV0dXJuIHsgcmVhZHk6IGV4aXN0c1N5bmMocCksIHZlcnNpb24gfTtcclxuICB9XHJcblxyXG4gIC8qKiBucG0gXHU2NjJGXHU1NDI2XHU1NzI4IFBBVEgoXHU1NDExXHU1QkZDXHU5MDA5XHU2MkU5XHU5ODc1IFx1MjQ2MCBcdTc2ODRcdTVCODlcdTg4QzVcdTY1QjlcdTVGMEZcdTY4MDdcdTZDRTg7d2hlcmUgXHU1RkVCXHU2M0EyLFx1NEUwRFx1NTA1QVx1NUI4Q1x1NjU3NFx1NjNBMlx1NkQ0QilcdTMwMDIgKi9cclxuICBmdW5jdGlvbiBucG1PblBhdGgoKTogYm9vbGVhbiB7XHJcbiAgICB0cnkge1xyXG4gICAgICBleGVjRmlsZVN5bmMoJ3doZXJlJywgWyducG0nXSwgeyBlbmNvZGluZzogJ3V0ZjgnLCB0aW1lb3V0OiA0XzAwMCwgd2luZG93c0hpZGU6IHRydWUgfSk7XHJcbiAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgfSBjYXRjaCB7IHJldHVybiBmYWxzZTsgfVxyXG4gIH1cclxuXHJcbiAgLyogLS0tLSBcdTk5OTZcdTU0MkZcdTVCODlcdTg4QzVcdTU0MTFcdTVCRkNcdTcyQjZcdTYwMDEodjUuMSkgLS0tLSAqL1xyXG4gIGNvbnN0IHdpemFyZEZpbGUgPSAoKTogc3RyaW5nID0+IGpvaW4oYXBwLmdldFBhdGgoJ3VzZXJEYXRhJyksICd3aXphcmQuanNvbicpO1xyXG4gIGFzeW5jIGZ1bmN0aW9uIGxvYWRXaXphcmRTdGF0ZSgpOiBQcm9taXNlPHsgZG9uZTogYm9vbGVhbjsgY2hvaWNlOiBzdHJpbmcgfT4ge1xyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3QgdiA9IEpTT04ucGFyc2UoYXdhaXQgcmVhZEZpbGUod2l6YXJkRmlsZSgpLCAndXRmOCcpKSBhcyB7IGRvbmU/OiB1bmtub3duOyBjaG9pY2U/OiB1bmtub3duIH07XHJcbiAgICAgIHJldHVybiB7IGRvbmU6IHYuZG9uZSA9PT0gdHJ1ZSwgY2hvaWNlOiB0eXBlb2Ygdi5jaG9pY2UgPT09ICdzdHJpbmcnID8gdi5jaG9pY2UgOiAnJyB9O1xyXG4gICAgfSBjYXRjaCB7IHJldHVybiB7IGRvbmU6IGZhbHNlLCBjaG9pY2U6ICcnIH07IH1cclxuICB9XHJcbiAgYXN5bmMgZnVuY3Rpb24gc2F2ZVdpemFyZFN0YXRlKGNob2ljZTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBhd2FpdCB3cml0ZUZpbGUod2l6YXJkRmlsZSgpLCBKU09OLnN0cmluZ2lmeSh7IGRvbmU6IHRydWUsIGNob2ljZSB9LCBudWxsLCAyKSwgJ3V0ZjgnKS5jYXRjaCgoKSA9PiB1bmRlZmluZWQpO1xyXG4gIH1cclxuICAvKiogXHU1NDExXHU1QkZDXHU4MUVBXHU1MkE4XHU1RjM5XHU1MUZBXHU2MjkxXHU1MjM2Olx1NkQ0Qlx1OEJENS9cdTVGMDBcdTUzRDFcdTczQUZcdTU4ODNcdTRFMERcdTVGMzkoVUlWRVJJRlkvU05BUFNIT1QvUkVOREVSX1RFU1QvXHJcbiAgICogIERPTVBST0JFL1NFQ1VSSVRZX1RFU1QvRkFLRS9kZXYpO0hNSF9ERVNLVE9QX1dJWkFSRF9GT1JDRT0xIFx1NUYzQVx1NTIzNlx1NUYzOShcdTlBOENcdTY1MzYpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gd2l6YXJkU3VwcHJlc3NlZCgpOiBib29sZWFuIHtcclxuICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9XSVpBUkRfRk9SQ0UgPT09ICcxJykgcmV0dXJuIGZhbHNlO1xyXG4gICAgcmV0dXJuIGlzRGV2XHJcbiAgICAgIHx8IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZID09PSAnMSdcclxuICAgICAgfHwgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfU05BUFNIT1QgIT09IHVuZGVmaW5lZFxyXG4gICAgICB8fCBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9WSVNSRUcgPT09ICcxJ1xyXG4gICAgICB8fCBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9SRU5ERVJfVEVTVCA9PT0gJzEnXHJcbiAgICAgIHx8IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX0RPTVBST0JFID09PSAnMSdcclxuICAgICAgfHwgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfU0VDVVJJVFlfVEVTVCA9PT0gJzEnXHJcbiAgICAgIHx8IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX0ZBS0UgPT09ICcxJztcclxuICB9XHJcblxyXG4gIC8qKiBcdTUzRDFcdTczQjBcdTk4N0FcdTVFOEY6XHU2NjNFXHU1RjBGXHU4OTg2XHU3NkQ2KFx1NTQyQlx1NTQxMVx1NUJGQ1x1OTAwOVx1NjJFOTpcdTU5MTZcdTkwRThcdTUxNjVcdTUzRTMvXHU1MTg1XHU3RjZFXHU4REVGXHU1Rjg0L1x1NkYxNFx1NzkzQSk+IFx1NTE4NVx1N0Y2RVx1NUYwMFx1NTE3M1xyXG4gICAgIChITUhfREVTS1RPUF9CVU5ETEVEPTEpPiBcdTU5MTZcdTkwRThcdTUzRDFcdTczQjAoZGV2IFx1NzZGOFx1OTBCQlx1NEVEM1x1NUU5MyAvIHdoZXJlIGhtaCAvIG5wbSBcdTUxNjhcdTVDNDAgL1xyXG4gICAgIFx1NTQxMVx1NUJGQ1x1NUI4OVx1ODhDNVx1NzZFRVx1NUY1NSAvIFx1NkU5MFx1NzgwMVx1NEY0RFx1N0Y2RSk+IFx1NTE4NVx1N0Y2RVx1NTE1Q1x1NUU5NVx1MzAwMlx1NTkxNlx1OTBFOFx1NEYxOFx1NTE0OD1cdTgwMDFcdTc1MjhcdTYyMzdcdTdFRTdcdTdFRURcdTc1MjhcdTgxRUFcdTVERjFcdTg4QzVcdTc2ODRcdTcyNDhcdTY3MkM7XHJcbiAgICAgXHU1MTg1XHU3RjZFPVx1NjVCMFx1NjczQVx1NTY2OFx1ODhDNVx1NUI4Q1x1NzZGNFx1OEZERVx1NzcxRlx1NUI5RVx1NTE4NVx1NjgzOFx1MzAwMkhNSF9ERVNLVE9QX0ZBS0U9MSBcdTYyMTYgcnVudGltZS5qc29uIGRlbW89dHJ1ZVxyXG4gICAgIChcdTU0MTFcdTVCRkNcIlx1NkYxNFx1NzkzQVx1NkEyMVx1NUYwRlwiXHU5MDA5XHU2MkU5LFx1NjMwMVx1NEU0NSlcdThGREJcdTZGMTRcdTc5M0FcdTMwMDIgKi9cclxuICBhc3luYyBmdW5jdGlvbiBzdGFydEhvc3QoKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCByZXBvUm9vdCA9IGpvaW4oaGVyZSwgJy4uJywgJy4uJywgJy4uJywgJy4uJyk7IC8vIGFwcHMvZGVza3RvcC9kaXN0LWVsZWN0cm9uL21haW4gXHUyMTkyIHJlcG8gcm9vdFxyXG4gICAgY29uc3QgcGFja2FnZWQgPSBhcHAuaXNQYWNrYWdlZDtcclxuICAgIGNvbnN0IGNmZyA9IGF3YWl0IGxvYWRSdW50aW1lQ29uZmlnKCk7XHJcbiAgICBjb25zdCBmb3JjZUZha2UgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9GQUtFID09PSAnMScgfHwgY2ZnLmRlbW87XHJcbiAgICBjb25zdCBmb3JjZUJ1bmRsZWQgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9CVU5ETEVEID09PSAnMSc7XHJcbiAgICBjb25zdCBvdmVycmlkZSA9IGNmZy5lbnRyeTtcclxuICAgIGNvbnN0IGFkamFjZW50ID0gam9pbihyZXBvUm9vdCwgJy4uJywgJ2htaGFybmVzcycsICdwYWNrYWdlcycsICd3ZWInLCAnc3JjJywgJ2Rlc2t0b3AtaG9zdC50cycpO1xyXG4gICAgY29uc3QgYnVuZGxlZCA9IGJ1bmRsZWRSdW50aW1lUGF0aChyZXBvUm9vdCk7XHJcbiAgICBjb25zdCBidW5kbGVkUmVhZHkgPSBleGlzdHNTeW5jKGJ1bmRsZWQpO1xyXG4gICAgLy8gXHU4OUUzXHU2NzkwKFx1N0VEM1x1Njc5Q1x1NUY1Mlx1NEUwMDpvdmVycmlkZT1idW5kbGVkIFx1OERFRlx1NUY4NFx1MjE5Mlx1NTE4NVx1N0Y2RTtcdTZFOTBcdTc4MDEgLnRzIFx1OTcwMCB0c3g7XHJcbiAgICAvLyBucG0gXHU1Qjg5XHU4OEM1IC5qcyBcdTdGMTZcdThCRDFcdTRFQTdcdTcyNjlcdTc2RjRcdThERDE7YnVuZGxlZD1cdTgxRUFcdTUzMDVcdTU0MkIgY2pzIFx1NzZGNFx1OEREMSlcclxuICAgIGxldCBlbnRyeSA9ICcnO1xyXG4gICAgdXNlQnVuZGxlZFJ1bnRpbWUgPSBmYWxzZTtcclxuICAgIGlmIChmb3JjZUZha2UpIHtcclxuICAgICAgLy8gXHU2RjE0XHU3OTNBXHU2QTIxXHU1RjBGXHJcbiAgICB9IGVsc2UgaWYgKG92ZXJyaWRlICE9PSAnJykge1xyXG4gICAgICBlbnRyeSA9IG92ZXJyaWRlO1xyXG4gICAgICBpZiAob3ZlcnJpZGUgPT09IGJ1bmRsZWQpIHVzZUJ1bmRsZWRSdW50aW1lID0gdHJ1ZTsgLy8gXHU1NDExXHU1QkZDXHU5MDA5XCJcdTUxODVcdTdGNkVcdTdDQkVcdTdCODBcdTUxODVcdTY4MzhcIlx1NzY4NFx1NjMwMVx1NEU0NVx1NUY2Mlx1NjAwMVxyXG4gICAgfSBlbHNlIGlmIChmb3JjZUJ1bmRsZWQpIHtcclxuICAgICAgaWYgKGJ1bmRsZWRSZWFkeSkgeyBlbnRyeSA9IGJ1bmRsZWQ7IHVzZUJ1bmRsZWRSdW50aW1lID0gdHJ1ZTsgfVxyXG4gICAgICBlbHNlIGxvZ0luZm8oJ2hvc3QnLCAnSE1IX0RFU0tUT1BfQlVORExFRD0xIFx1NEY0Nlx1NTE4NVx1N0Y2RSBydW50aW1lIFx1N0YzQVx1NTkzMShcdTUxNDhcdThERDEgc2NyaXB0cy9idW5kbGUtcnVudGltZS5tanMpJyk7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICBlbnRyeSA9IHBhY2thZ2VkID8gZGV0ZWN0UmVhbEVudHJ5KCkgOiAoZXhpc3RzU3luYyhhZGphY2VudCkgPyBhZGphY2VudCA6IGRldGVjdFJlYWxFbnRyeSgpKTtcclxuICAgICAgaWYgKGVudHJ5ID09PSAnJyAmJiBidW5kbGVkUmVhZHkpIHsgZW50cnkgPSBidW5kbGVkOyB1c2VCdW5kbGVkUnVudGltZSA9IHRydWU7IH1cclxuICAgIH1cclxuICAgIHJ1bnRpbWVFbnRyeSA9IGVudHJ5O1xyXG4gICAgY29uc3QgdXNlUmVhbCA9IGVudHJ5ICE9PSAnJyAmJiAodXNlQnVuZGxlZFJ1bnRpbWUgfHwgZXhpc3RzU3luYyhlbnRyeSkpO1xyXG4gICAgYnJpZGdlID0ge1xyXG4gICAgICAuLi5icmlkZ2UsXHJcbiAgICAgIG1vZGU6IHVzZVJlYWwgPyAncmVhbCcgOiAnZmFrZScsXHJcbiAgICAgIHJ1bnRpbWVFbnRyeTogdXNlUmVhbCA/ICh1c2VCdW5kbGVkUnVudGltZSA/IGAke2VudHJ5fSAoYnVuZGxlZClgIDogZW50cnkpIDogbnVsbCxcclxuICAgIH07XHJcbiAgICBsZXQgc3BlYzogeyBjb21tYW5kOiBzdHJpbmc7IGFyZ3M6IHN0cmluZ1tdOyBlbnY6IFJlY29yZDxzdHJpbmcsIHN0cmluZz47IGN3ZD86IHN0cmluZyB9O1xyXG4gICAgaWYgKHVzZUJ1bmRsZWRSdW50aW1lKSB7XHJcbiAgICAgIHNwZWMgPSB7XHJcbiAgICAgICAgY29tbWFuZDogcHJvY2Vzcy5leGVjUGF0aCxcclxuICAgICAgICBhcmdzOiBbZW50cnldLCAvLyBcdTgxRUFcdTUzMDVcdTU0MkJcdTUzNTVcdTY1ODdcdTRFRjY6ZWxlY3Ryb24tYXMtbm9kZSBcdTc2RjRcdThERDEsXHU2NUUwIHRzeCBcdTY1RTAgcmVwb1xyXG4gICAgICAgIGVudjogeyBFTEVDVFJPTl9SVU5fQVNfTk9ERTogJzEnIH0sXHJcbiAgICAgIH07XHJcbiAgICB9IGVsc2UgaWYgKHVzZVJlYWwgJiYgZW50cnkuZW5kc1dpdGgoJy5qcycpKSB7XHJcbiAgICAgIHNwZWMgPSB7XHJcbiAgICAgICAgY29tbWFuZDogcHJvY2Vzcy5leGVjUGF0aCxcclxuICAgICAgICBhcmdzOiBbZW50cnldLCAvLyBucG0gXHU1Qjg5XHU4OEM1XHU3Njg0XHU3RjE2XHU4QkQxXHU0RUE3XHU3MjY5OkVTTSBcdTRGOURcdThENTZcdTYzMDlcdTY1ODdcdTRFRjZcdTRGNERcdTdGNkVcdTg5RTNcdTY3OTAsXHU3NkY0XHU4REQxXHU1MzczXHU1M0VGXHJcbiAgICAgICAgY3dkOiBkaXJuYW1lKGVudHJ5KSxcclxuICAgICAgICBlbnY6IHsgRUxFQ1RST05fUlVOX0FTX05PREU6ICcxJyB9LFxyXG4gICAgICB9O1xyXG4gICAgfSBlbHNlIGlmICh1c2VSZWFsKSB7XHJcbiAgICAgIGNvbnN0IHJlcG8gPSByZXBvUm9vdE9mKGVudHJ5KTtcclxuICAgICAgc3BlYyA9IHtcclxuICAgICAgICBjb21tYW5kOiBwcm9jZXNzLmV4ZWNQYXRoLFxyXG4gICAgICAgIGFyZ3M6IFsnLS1pbXBvcnQnLCAndHN4JywgZW50cnldLFxyXG4gICAgICAgIGN3ZDogcmVwbywgLy8gYmFyZSAndHN4JyBcdTRFMEUgd29ya3NwYWNlIFx1NEY5RFx1OEQ1Nlx1OTBGRFx1NEVDRSByZXBvIFx1NzY4NCBub2RlX21vZHVsZXMgXHU4OUUzXHU2NzkwXHJcbiAgICAgICAgZW52OiB7IEVMRUNUUk9OX1JVTl9BU19OT0RFOiAnMScgfSxcclxuICAgICAgfTtcclxuICAgIH0gZWxzZSBpZiAocGFja2FnZWQpIHtcclxuICAgICAgc3BlYyA9IHtcclxuICAgICAgICBjb21tYW5kOiBwcm9jZXNzLmV4ZWNQYXRoLFxyXG4gICAgICAgIGFyZ3M6IFtqb2luKHByb2Nlc3MucmVzb3VyY2VzUGF0aCwgJ2Zha2UtaG9zdC5janMnKV0sXHJcbiAgICAgICAgZW52OiB7IEVMRUNUUk9OX1JVTl9BU19OT0RFOiAnMScgfSxcclxuICAgICAgfTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgIHNwZWMgPSB7XHJcbiAgICAgICAgY29tbWFuZDogcHJvY2Vzcy5leGVjUGF0aCxcclxuICAgICAgICAvLyBcdTc2RjRcdTYzQTVcdThENzBcdTUzMDVcdTc3MUZcdTVCOUVcdThERUZcdTVGODQobm9kZV9tb2R1bGVzIFx1OTFDQ1x1NzY4NCB3b3Jrc3BhY2UganVuY3Rpb24gXHU0RjFBXHU4OEFCIEVTTVxyXG4gICAgICAgIC8vIHJlYWxwYXRoIFx1NTMxNixcdTVCRkNcdTgxRjQgZmFrZS1ob3N0IFx1NzY4NCBhcmd2WzFdL2ltcG9ydC5tZXRhLnVybCBcdTUzMzlcdTkxNERcdTU5MzFcdTY1NDgpXHJcbiAgICAgICAgYXJnczogWyctLWltcG9ydCcsICd0c3gnLCBqb2luKHJlcG9Sb290LCAncGFja2FnZXMnLCAnaG9zdC1hZGFwdGVyJywgJ3NyYycsICdmYWtlLWhvc3QudHMnKV0sXHJcbiAgICAgICAgZW52OiB7IEVMRUNUUk9OX1JVTl9BU19OT0RFOiAnMScgfSxcclxuICAgICAgfTtcclxuICAgIH1cclxuICAgIHN1cGVydmlzb3IgPSBuZXcgRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yKHNwZWMsIHtcclxuICAgICAgb25TdGF0ZUNoYW5nZTogYnJvYWRjYXN0SG9zdFN0YXRlLFxyXG4gICAgICAvLyBcdTk5OTZcdTZCMjFcdTU0MkZcdTUyQThcdTRFMEUgY3Jhc2ggXHU4MUVBXHU2MTA4XHU1NDBFXHU3Njg0XHU5MUNEXHU1NDJGXHU5MEZEXHU0RjFBXHU4RDcwXHU4RkQ5XHU5MUNDOlx1N0FFRlx1NTNFMy90b2tlbiBcdTkwRkRcdTY2MkZcdTY1QjBcdTc2ODQsXHJcbiAgICAgIC8vIFx1OTFDRFx1NUVGQVx1Njg2NVx1NUJBMlx1NjIzN1x1N0FFRlx1NUU3Nlx1OTFDRFx1NjVCMFx1OEJBMlx1OTYwNSBTU0UocmVuZGVyZXIgXHU3Njg0IEV2ZW50U3RvcmUgXHU5NzYwIGV2ZW50SWQgXHU1M0JCXHU5MUNEKVxyXG4gICAgICBvblJlYWR5OiAoZXApID0+IHtcclxuICAgICAgICBjbGllbnQgPSBuZXcgRGVza3RvcEhvc3RDbGllbnQoYGh0dHA6Ly8xMjcuMC4wLjE6JHtlcC5wb3J0fWAsIGVwLnRva2VuKTtcclxuICAgICAgICBzc2VBYm9ydD8uYWJvcnQoKTtcclxuICAgICAgICBzc2VBYm9ydCA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcclxuICAgICAgICBsYXN0RXZlbnRJZCA9ICcnO1xyXG4gICAgICAgIHZvaWQgcHVtcEV2ZW50cygpO1xyXG4gICAgICAgIGxvZ0luZm8oJ2hvc3QnLCBgYnJpZGdlIHJlYWR5IG9uIDEyNy4wLjAuMToke2VwLnBvcnR9IChydW50aW1lICR7ZXAudmVyc2lvbn0sIG1vZGUgJHticmlkZ2UubW9kZX0ke3VzZVJlYWwgPyBgLCBlbnRyeT0ke3J1bnRpbWVFbnRyeX0ke3VzZUJ1bmRsZWRSdW50aW1lID8gJyBbYnVuZGxlZF0nIDogJyd9YCA6ICcnfSlgKTtcclxuICAgICAgfSxcclxuICAgIH0pO1xyXG4gICAgdHJ5IHtcclxuICAgICAgYXdhaXQgc3VwZXJ2aXNvci5zdGFydCgpO1xyXG4gICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgIGNvbnN0IGRldGFpbCA9ICgoKSA9PiB7IHRyeSB7IHJldHVybiBKU09OLnN0cmluZ2lmeShlcnIpOyB9IGNhdGNoIHsgcmV0dXJuIFN0cmluZyhlcnIpOyB9IH0pKCkuc2xpY2UoMCwgNDAwKTtcclxuICAgICAgYnJpZGdlID0geyAuLi5icmlkZ2UsIGhvc3RTdGF0ZTogJ2ZhaWxlZCcsIGxhc3RFcnJvcjogZGV0YWlsIH07XHJcbiAgICAgIGxvZ0luZm8oJ2hvc3QnLCBgc3RhcnQgZmFpbGVkOiAke2RldGFpbH1gKTtcclxuICAgIH1cclxuICB9XHJcblxyXG4gIC8qIC0tLS0gSVBDIFx1NzY3RFx1NTQwRFx1NTM1NSArIHNlbmRlciBcdTY4MjFcdTlBOEMgLS0tLSAqL1xyXG4gIGNvbnN0IGFsbG93ZWRPcmlnaW5zID0gbmV3IFNldDxzdHJpbmc+KFxyXG4gICAgaXNEZXYgJiYgcmVuZGVyZXJEZXZVcmxcclxuICAgICAgPyBbcmVuZGVyZXJEZXZVcmxdXHJcbiAgICAgIDogW3BhdGhUb0ZpbGVVUkwoam9pbihoZXJlLCAnLi4nLCAnLi4nLCAnZGlzdC1yZW5kZXJlcicsICdpbmRleC5odG1sJykpLmhyZWZdLFxyXG4gICk7XHJcblxyXG4gIGZ1bmN0aW9uIHNlbmRlclRydXN0ZWQoc2VuZGVyRnJhbWU6IEVsZWN0cm9uLldlYkZyYW1lTWFpbiB8IG51bGwgfCB1bmRlZmluZWQpOiBib29sZWFuIHtcclxuICAgIGlmIChzZW5kZXJGcmFtZSA9PT0gbnVsbCB8fCBzZW5kZXJGcmFtZSA9PT0gdW5kZWZpbmVkKSByZXR1cm4gZmFsc2U7XHJcbiAgICBsZXQgdG9wOiBFbGVjdHJvbi5XZWJGcmFtZU1haW4gfCBudWxsID0gc2VuZGVyRnJhbWU7XHJcbiAgICB3aGlsZSAodG9wPy5wYXJlbnQgIT09IG51bGwgJiYgdG9wPy5wYXJlbnQgIT09IHVuZGVmaW5lZCkgdG9wID0gdG9wLnBhcmVudDtcclxuICAgIGNvbnN0IHVybCA9IHRvcD8udXJsID8/ICcnO1xyXG4gICAgZm9yIChjb25zdCBvcmlnaW4gb2YgYWxsb3dlZE9yaWdpbnMpIHtcclxuICAgICAgaWYgKHVybCA9PT0gb3JpZ2luIHx8IHVybC5zdGFydHNXaXRoKGAke29yaWdpbn0vYCkgfHwgdXJsLnN0YXJ0c1dpdGgoYCR7b3JpZ2lufT9gKSkgcmV0dXJuIHRydWU7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gZmFsc2U7XHJcbiAgfVxyXG5cclxuICAvKiogXHU5NzAwXHU4OTgxIGhvc3QgXHU1QzMxXHU3RUVBXHU3Njg0IElQQyBoYW5kbGVyIFx1NTE2Q1x1NTE3MVx1NThGMzpcdTY3MkFcdTVDMzFcdTdFRUFcdThGRDRcdTU2REVcdTdFRDNcdTY3ODRcdTUzMTZcdTk1MTlcdThCRUZcdTMwMDIgKi9cclxuICBmdW5jdGlvbiBob3N0Q2FsbDxUPihldmVudDogRWxlY3Ryb24uSXBjTWFpbkludm9rZUV2ZW50LCBmbjogKGM6IERlc2t0b3BIb3N0Q2xpZW50KSA9PiBQcm9taXNlPFQ+KTogUHJvbWlzZTxUIHwgeyBlcnJvcjogc3RyaW5nOyBjb2RlOiBzdHJpbmcgfT4ge1xyXG4gICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH0pO1xyXG4gICAgaWYgKGNsaWVudCA9PT0gbnVsbCB8fCBicmlkZ2UuaG9zdFN0YXRlICE9PSAncmVhZHknKSB7XHJcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogYGhvc3Qgbm90IHJlYWR5ICgke2JyaWRnZS5ob3N0U3RhdGV9KWAsIGNvZGU6ICdIT1NUX05PVF9SRUFEWScgfSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gZm4oY2xpZW50KS5jYXRjaCgoZXJyOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IGRldGFpbCA9ICgoKSA9PiB7IHRyeSB7IHJldHVybiBKU09OLnN0cmluZ2lmeShlcnIpOyB9IGNhdGNoIHsgcmV0dXJuIFN0cmluZyhlcnIpOyB9IH0pKCkuc2xpY2UoMCwgMzAwKTtcclxuICAgICAgcmV0dXJuIHsgZXJyb3I6IGRldGFpbCwgY29kZTogJ0JSSURHRV9FUlJPUicgfTtcclxuICAgIH0pO1xyXG4gIH1cclxuXHJcbiAgZnVuY3Rpb24gcmVnaXN0ZXJJcGMoKTogdm9pZCB7XHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmdldC1zdGF0ZScsIChldmVudCkgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInIH07XHJcbiAgICAgIHJldHVybiB7IC4uLmJyaWRnZSwgZHJvcHBlZEZyYW1lcyB9O1xyXG4gICAgfSk7XHJcblxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpzZXNzaW9ucycsIChldmVudCkgPT5cclxuICAgICAgaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248eyBzZXNzaW9uczogQXJyYXk8eyBpZDogc3RyaW5nOyB0aXRsZTogc3RyaW5nOyB0YXNrOiBzdHJpbmc7IG91dGNvbWU6IHN0cmluZzsgdHVybnM6IG51bWJlcjsgdG9vbFVzZXM6IG51bWJlcjsgdGltZTogc3RyaW5nOyBjd2Q6IHN0cmluZzsgY3JlYXRlZEF0OiBzdHJpbmc7IHVwZGF0ZWRBdDogc3RyaW5nIH0+IH0+KCcvYXBpL3Nlc3Npb25zP2xpbWl0PTEwMCcpKSk7XHJcblxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpzZW5kLXRhc2snLCAoZXZlbnQsIHRleHQ6IHVua25vd24sIHNlc3Npb25JZDogdW5rbm93biwgbW9kZTogdW5rbm93biwgYXR0YWNobWVudHM6IHVua25vd24sIGltYWdlczogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCB0YXNrID0gdHlwZW9mIHRleHQgPT09ICdzdHJpbmcnID8gdGV4dC5zbGljZSgwLCAyMF8wMDApIDogJyc7XHJcbiAgICAgIGNvbnN0IHNpZCA9IHR5cGVvZiBzZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gc2Vzc2lvbklkLnNsaWNlKDAsIDgwKSA6ICcnO1xyXG4gICAgICBjb25zdCBtID0gbW9kZSA9PT0gJ2F1dG8nIHx8IG1vZGUgPT09ICd5b2xvJyA/IG1vZGUgOiAnYXNrJztcclxuICAgICAgLy8gXHU5NjQ0XHU0RUY2Olx1NTQwRVx1N0FFRlx1NjM4OFx1Njc0MyBEVE8gXHU3Njg0XHU3RUREXHU1QkY5XHU4REVGXHU1Rjg0KEAgXHU5MDA5XHU2MkU5XHU1NjY4L1x1RDgzRFx1RENDRSBcdTRFMEFcdTRGMjBcdTUzRUFcdTY3NjVcdTgxRUFcdTY3MkNcdTU3MzBcdTY1ODdcdTRFRjZcdTdDRkJcdTdFREYpXHJcbiAgICAgIGNvbnN0IGF0dHMgPSBBcnJheS5pc0FycmF5KGF0dGFjaG1lbnRzKSA/IGF0dGFjaG1lbnRzLmZpbHRlcigoYSk6IGEgaXMgc3RyaW5nID0+IHR5cGVvZiBhID09PSAnc3RyaW5nJykuc2xpY2UoMCwgMTApIDogW107XHJcbiAgICAgIC8vIFx1NTZGRVx1NzI0NzpydW50aW1lIHZpc2lvbiBcdTk0RkVcdTUzNEZcdThCQUUge25hbWUsIGRhdGFVcmx9IGJhc2U2NChcdTIyNjQzIFx1NUYyMCBcdTIyNjQ2TUIscmVuZGVyZXIgXHU3NTFGXHU2MjEwKVxyXG4gICAgICBjb25zdCBpbWdzID0gQXJyYXkuaXNBcnJheShpbWFnZXMpXHJcbiAgICAgICAgPyBpbWFnZXNcclxuICAgICAgICAgICAgLmZpbHRlcigoaW0pOiBpbSBpcyB7IG5hbWU6IHN0cmluZzsgZGF0YVVybDogc3RyaW5nIH0gPT5cclxuICAgICAgICAgICAgICB0eXBlb2YgaW0gPT09ICdvYmplY3QnICYmIGltICE9PSBudWxsICYmIHR5cGVvZiAoaW0gYXMgeyBuYW1lPzogdW5rbm93biB9KS5uYW1lID09PSAnc3RyaW5nJyAmJiB0eXBlb2YgKGltIGFzIHsgZGF0YVVybD86IHVua25vd24gfSkuZGF0YVVybCA9PT0gJ3N0cmluZycpXHJcbiAgICAgICAgICAgIC5zbGljZSgwLCAzKVxyXG4gICAgICAgICAgICAubWFwKChpbSkgPT4gKHsgbmFtZTogaW0ubmFtZS5zbGljZSgwLCAxMjApLCBkYXRhVXJsOiBpbS5kYXRhVXJsLnNsaWNlKDAsIDhfNTAwXzAwMCkgfSkpXHJcbiAgICAgICAgOiBbXTtcclxuICAgICAgaWYgKHRhc2sgPT09ICcnIHx8IHNpZCA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBvazogZmFsc2UsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbjsgcnVuSWQ/OiBzdHJpbmcgfT4oJy9hcGkvdGFzaycsIHsgdGV4dDogdGFzaywgc2Vzc2lvbklkOiBzaWQsIG1vZGU6IG0sIGF0dGFjaG1lbnRzOiBhdHRzLCBpbWFnZXM6IGltZ3MgfSkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBcdTZBMjFcdTU3OEJcdTUyMDdcdTYzNjIocnVudGltZSBQT1NUIC9hcGkvbW9kZWw6XHU1MjA3IGNoYXQgXHU4REVGXHU3NTMxLGNvbmZpZyBcdTUzNzNcdTY1RjZcdTc1MUZcdTY1NDgpIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6bW9kZWwtc2V0JywgKGV2ZW50LCBuYW1lOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IG4gPSB0eXBlb2YgbmFtZSA9PT0gJ3N0cmluZycgPyBuYW1lLnRyaW0oKS5zbGljZSgwLCA4MCkgOiAnJztcclxuICAgICAgaWYgKG4gPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICduYW1lIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcclxuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuOyBtb2RlbD86IHN0cmluZyB9PignL2FwaS9tb2RlbCcsIHsgbmFtZTogbiB9KSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIFx1NUU5NFx1NzUyOFx1NTE4NVx1NjZGNFx1NjVCMChHaXRIdWIgUmVsZWFzZXM7XHU4MUVBXHU3ODE0XHU5NkY2XHU0RjlEXHU4RDU2XHU2NkY0XHU2NUIwXHU1NjY4KSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmNoZWNrLXVwZGF0ZScsIGFzeW5jIChldmVudCkgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICByZXR1cm4gY2hlY2tGb3JVcGRhdGVzKCk7XHJcbiAgICB9KTtcclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6YXBwbHktdXBkYXRlJywgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGlmIChpbnN0YWxsZXJQYXRoID09PSBudWxsKSByZXR1cm4geyBlcnJvcjogJ25vIGluc3RhbGxlciBkb3dubG9hZGVkJywgY29kZTogJ0hPU1RfTk9UX1JFQURZJyB9O1xyXG4gICAgICBhcHBseVVwZGF0ZSgpO1xyXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSB9O1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBcdTY4MDdcdTk4OThcdTY4MEZcdTRFM0JcdTk4OThcdTU0MENcdTZCNjUoXHU2RDQ1XHU4MjcyXHU2QTIxXHU1RjBGXHU0RTBEXHU1MThEXHU2NzA5XHU5RUQxXHU2NzYxKSsgXHUyNjMwIFx1NEUzQlx1ODNEQ1x1NTM1NSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmNocm9tZS10aGVtZScsIChldmVudCwgZGFyazogdW5rbm93bikgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBhcHBseUNocm9tZShkYXJrID09PSB0cnVlKTtcclxuICAgICAgcmV0dXJuIHsgb2s6IHRydWUgfTtcclxuICAgIH0pO1xyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpwb3B1cC1tYWluLW1lbnUnLCAoZXZlbnQpID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgcG9wdXBNYWluTWVudSgpO1xyXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSB9O1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBcdTYyNEJcdTY3M0FcdThGRENcdTdBMEJcdTYzQTdcdTUyMzYoNzc4OCB3ZWIgXHU1Qjg4XHU2MkE0O1x1NzUyOFx1NjIzN1x1NjYzRVx1NUYwRlx1NTQyRlx1NTJBOCxBRFItMDA1IFx1NEUwRFx1OUVEOFx1OEJBNFx1NUYwMCBMQU4pIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cmVtb3RlLXdlYi1zdGF0dXMnLCBhc3luYyAoZXZlbnQpID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgY29uc3QgcCA9IGF3YWl0IHByb2JlV2ViUmVtb3RlKCk7XHJcbiAgICAgIHJldHVybiB7IHVwOiBwLnVwLCB2ZXJzaW9uOiBwLnZlcnNpb24sIGxhbklwOiBsYW5JcE9mKCksIHBvcnQ6IFdFQl9QT1JULCBhdmFpbGFibGU6IGNsaUVudHJ5T2YoKSAhPT0gJycsIGF1dG9zdGFydDogd2ViQXV0b3N0YXJ0SW5zdGFsbGVkKCkgfTtcclxuICAgIH0pO1xyXG4gICAgLy8gLS0tLSBcdTVGMDBcdTY3M0FcdTgxRUFcdTU0MkYoMC4yMy4zNyB3ZWIgaW5zdGFsbC1kYWVtb24vdW5pbnN0YWxsLWRhZW1vbjtcdTc2N0JcdTVGNTVcdTUzNzNcdTVCODhcdTYyQTRcdTU3MjhcdTdFQkYpIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cmVtb3RlLXdlYi1hdXRvc3RhcnQnLCBhc3luYyAoZXZlbnQsIGVuYWJsZWQ6IHVua25vd24pID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgaWYgKGNsaUVudHJ5T2YoKSA9PT0gJycpIHJldHVybiB7IGVycm9yOiAnbm8gaG1oYXJuZXNzIHJ1bnRpbWUgZGV0ZWN0ZWQnLCBjb2RlOiAnSE9TVF9OT1RfUkVBRFknIH07XHJcbiAgICAgIHJ1bkNsaShbJ3dlYicsIGVuYWJsZWQgPT09IHRydWUgPyAnaW5zdGFsbC1kYWVtb24nIDogJ3VuaW5zdGFsbC1kYWVtb24nXSk7XHJcbiAgICAgIC8vIGluc3RhbGwtZGFlbW9uIFx1N0FDQlx1NTM3M1x1NjJDOVx1OEQ3N1x1NUI4OFx1NjJBNDpcdThGNkVcdThCRTJcdTc4NkVcdThCQTQ7dW5pbnN0YWxsIFx1NTM3M1x1NjVGNlx1NzUxRlx1NjU0OFxyXG4gICAgICBpZiAoZW5hYmxlZCA9PT0gdHJ1ZSkge1xyXG4gICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgNTA7IGkrKykge1xyXG4gICAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgNTAwKSk7XHJcbiAgICAgICAgICBpZiAoKGF3YWl0IHByb2JlV2ViUmVtb3RlKCkpLnVwKSByZXR1cm4geyBvazogdHJ1ZSwgYXV0b3N0YXJ0OiB3ZWJBdXRvc3RhcnRJbnN0YWxsZWQoKSB9O1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4geyBlcnJvcjogJ2RhZW1vbiBkaWQgbm90IGNvbWUgdXAgd2l0aGluIDI1cycsIGNvZGU6ICdSVU5USU1FX0NSQVNIRUQnIH07XHJcbiAgICAgIH1cclxuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGF1dG9zdGFydDogd2ViQXV0b3N0YXJ0SW5zdGFsbGVkKCkgfTtcclxuICAgIH0pO1xyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpyZW1vdGUtd2ViLXN0YXJ0JywgYXN5bmMgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGlmIChjbGlFbnRyeU9mKCkgPT09ICcnKSByZXR1cm4geyBlcnJvcjogJ25vIGhtaGFybmVzcyBydW50aW1lIGRldGVjdGVkJywgY29kZTogJ0hPU1RfTk9UX1JFQURZJyB9O1xyXG4gICAgICBpZiAoKGF3YWl0IHByb2JlV2ViUmVtb3RlKCkpLnVwKSB7XHJcbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGFscmVhZHk6IHRydWUsIGxhblVybDogYGh0dHA6Ly8ke2xhbklwT2YoKSB8fCAnMTI3LjAuMC4xJ306JHtXRUJfUE9SVH1gIH07XHJcbiAgICAgIH1cclxuICAgICAgcnVuQ2xpKFsnd2ViJywgJ3N0YXJ0JywgJy0tZXhwb3N1cmU9bGFuJ10pO1xyXG4gICAgICAvLyBcdTVCODhcdTYyQTRcdThGREJcdTdBMEJcdTUxQjdcdTU0MkZcdTUyQTgodHN4IFx1N0YxNlx1OEJEMVx1NjU3NFx1NTk1NyBDTEkpOlx1OEY2RVx1OEJFMiAyNXNcclxuICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCA1MDsgaSsrKSB7XHJcbiAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgNTAwKSk7XHJcbiAgICAgICAgaWYgKChhd2FpdCBwcm9iZVdlYlJlbW90ZSgpKS51cCkge1xyXG4gICAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGxhblVybDogYGh0dHA6Ly8ke2xhbklwT2YoKSB8fCAnMTI3LjAuMC4xJ306JHtXRUJfUE9SVH1gIH07XHJcbiAgICAgICAgfVxyXG4gICAgICB9XHJcbiAgICAgIHJldHVybiB7IGVycm9yOiAnd2ViIGRhZW1vbiBkaWQgbm90IGNvbWUgdXAgd2l0aGluIDI1cyAoc2VlIEhNSF9IT01FL3dlYi5sb2cpJywgY29kZTogJ1JVTlRJTUVfQ1JBU0hFRCcgfTtcclxuICAgIH0pO1xyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpyZW1vdGUtd2ViLXN0b3AnLCBhc3luYyAoZXZlbnQpID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgcnVuQ2xpKFsnd2ViJywgJ3N0b3AnXSk7XHJcbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgMjA7IGkrKykge1xyXG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDQwMCkpO1xyXG4gICAgICAgIGlmICghKGF3YWl0IHByb2JlV2ViUmVtb3RlKCkpLnVwKSByZXR1cm4geyBvazogdHJ1ZSB9O1xyXG4gICAgICB9XHJcbiAgICAgIGNvbnN0IHN0aWxsID0gKGF3YWl0IHByb2JlV2ViUmVtb3RlKCkpLnVwO1xyXG4gICAgICByZXR1cm4gc3RpbGwgPyB7IGVycm9yOiAnc3RpbGwgcnVubmluZycsIGNvZGU6ICdCUklER0VfRVJST1InIH0gOiB7IG9rOiB0cnVlIH07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIFx1RDgzRFx1RENDRSBcdTY1ODdcdTRFRjZcdTRFMEFcdTRGMjAoXHU2NzJDXHU1NzMwXHU1OTFBXHU5MDA5O3J1bnRpbWUgXHU2ODIxXHU5QThDIGluc2lkZVdzLFx1NURFNVx1NEY1Q1x1NTMzQVx1NTkxNlx1NjU4N1x1NEVGNlx1NEYxQVx1ODhBQiA0MDApIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cGljay1maWxlcycsIGFzeW5jIChldmVudCwgdGl0bGU6IHVua25vd24pID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgY29uc3Qgd2luID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkuZmluZCgodykgPT4gIXcuaXNEZXN0cm95ZWQoKSk7XHJcbiAgICAgIGlmICh3aW4gPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgZXJyb3I6ICdubyB3aW5kb3cnLCBjb2RlOiAnQlJJREdFX0VSUk9SJyB9O1xyXG4gICAgICBjb25zdCByID0gYXdhaXQgZGlhbG9nLnNob3dPcGVuRGlhbG9nKHdpbiwge1xyXG4gICAgICAgIHRpdGxlOiB0eXBlb2YgdGl0bGUgPT09ICdzdHJpbmcnICYmIHRpdGxlICE9PSAnJyA/IHRpdGxlLnNsaWNlKDAsIDEyMCkgOiAnXHU5MDA5XHU2MkU5XHU4OTgxXHU5NjQ0XHU1MkEwXHU3Njg0XHU2NTg3XHU0RUY2KFx1NTNFRlx1NTkxQVx1OTAwOSknLFxyXG4gICAgICAgIHByb3BlcnRpZXM6IFsnb3BlbkZpbGUnLCAnbXVsdGlTZWxlY3Rpb25zJ10sXHJcbiAgICAgIH0pO1xyXG4gICAgICBpZiAoci5jYW5jZWxlZCB8fCByLmZpbGVQYXRocy5sZW5ndGggPT09IDApIHJldHVybiB7IG9rOiBmYWxzZSwgY2FuY2VsZWQ6IHRydWUgfTtcclxuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHBhdGhzOiByLmZpbGVQYXRocy5zbGljZSgwLCAxMCkgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gXHVEODNEXHVEQ0MxIFx1NzZFRVx1NUY1NVx1OTAwOVx1NjJFOShcdTVERTVcdTRGNUNcdTUzM0FcdTZERkJcdTUyQTBcdTc2ODRcdTZENEZcdTg5QzhcdTYzMDlcdTk0QUU7XHU1MzlGXHU3NTFGIGNob29zZXIpIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cGljay1kaXJlY3RvcnknLCBhc3luYyAoZXZlbnQsIHRpdGxlOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IHdpbiA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmZpbmQoKHcpID0+ICF3LmlzRGVzdHJveWVkKCkpO1xyXG4gICAgICBpZiAod2luID09PSB1bmRlZmluZWQpIHJldHVybiB7IGVycm9yOiAnbm8gd2luZG93JywgY29kZTogJ0JSSURHRV9FUlJPUicgfTtcclxuICAgICAgY29uc3QgciA9IGF3YWl0IGRpYWxvZy5zaG93T3BlbkRpYWxvZyh3aW4sIHtcclxuICAgICAgICB0aXRsZTogdHlwZW9mIHRpdGxlID09PSAnc3RyaW5nJyAmJiB0aXRsZSAhPT0gJycgPyB0aXRsZS5zbGljZSgwLCAxMjApIDogJ1x1OTAwOVx1NjJFOVx1NjU4N1x1NEVGNlx1NTkzOScsXHJcbiAgICAgICAgcHJvcGVydGllczogWydvcGVuRGlyZWN0b3J5J10sXHJcbiAgICAgIH0pO1xyXG4gICAgICBpZiAoci5jYW5jZWxlZCB8fCByLmZpbGVQYXRoc1swXSA9PT0gdW5kZWZpbmVkKSByZXR1cm4geyBvazogZmFsc2UsIGNhbmNlbGVkOiB0cnVlIH07XHJcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBwYXRoOiByLmZpbGVQYXRoc1swXSB9O1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBAIFx1OTY0NFx1NEVGNjpcdTVERTVcdTRGNUNcdTUzM0FcdTY1ODdcdTRFRjZcdTY0MUNcdTdEMjIocnVudGltZSBcdTYzODhcdTY3NDNcdTc2ODRcdThERUZcdTVGODRcdTY3NjVcdTZFOTApIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6ZnMtc2VhcmNoJywgKGV2ZW50LCBxOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IHF1ZXJ5ID0gdHlwZW9mIHEgPT09ICdzdHJpbmcnID8gcS5zbGljZSgwLCAyMDApIDogJyc7XHJcbiAgICAgIGlmIChxdWVyeSA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyByZXN1bHRzOiBbXSB9KTtcclxuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPHsgcmVzdWx0czogQXJyYXk8eyByZWw6IHN0cmluZzsgcGF0aDogc3RyaW5nIH0+IH0+KGAvYXBpL2ZzL3NlYXJjaD9xPSR7ZW5jb2RlVVJJQ29tcG9uZW50KHF1ZXJ5KX1gKSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmFwcHJvdmUnLCAoZXZlbnQsIGdyYW50ZWQ6IHVua25vd24sIHNlc3Npb25JZDogdW5rbm93bikgPT5cclxuICAgICAgaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvYXBwcm92ZScsIHtcclxuICAgICAgICBncmFudGVkOiBncmFudGVkID09PSB0cnVlLFxyXG4gICAgICAgIHNlc3Npb25JZDogdHlwZW9mIHNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBzZXNzaW9uSWQuc2xpY2UoMCwgODApIDogJycsXHJcbiAgICAgIH0pKSk7XHJcblxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTppbnRlcnJ1cHQnLCAoZXZlbnQsIHNlc3Npb25JZDogdW5rbm93bikgPT5cclxuICAgICAgaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvaW50ZXJydXB0Jywge1xyXG4gICAgICAgIHNlc3Npb25JZDogdHlwZW9mIHNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBzZXNzaW9uSWQuc2xpY2UoMCwgODApIDogJycsXHJcbiAgICAgIH0pKSk7XHJcblxyXG4gICAgLy8gLS0tLSBNNDpcdTVERTVcdTRGNUNcdTUzM0FcdTY1ODdcdTRFRjZcdTk3NjIoXHU4REVGXHU1Rjg0XHU2Mzg4XHU2NzQzXHU1NzI4IHJ1bnRpbWU6aW5zaWRlV3MgXHU2ODIxXHU5QThDKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmZzLWxpc3QnLCAoZXZlbnQsIHBhdGg6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3QgcCA9IHR5cGVvZiBwYXRoID09PSAnc3RyaW5nJyA/IHBhdGguc2xpY2UoMCwgMTAwMCkgOiAnJztcclxuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPFJlY29yZDxzdHJpbmcsIHVua25vd24+PihgL2FwaS9mcz9maWxlcz0xJHtwICE9PSAnJyA/IGAmcGF0aD0ke2VuY29kZVVSSUNvbXBvbmVudChwKX1gIDogJyd9YCkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpmcy1yZWFkJywgKGV2ZW50LCBwYXRoOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IHAgPSB0eXBlb2YgcGF0aCA9PT0gJ3N0cmluZycgPyBwYXRoLnNsaWNlKDAsIDEwMDApIDogJyc7XHJcbiAgICAgIGlmIChwID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAncGF0aCByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oYC9hcGkvZnMvcmVhZD9wYXRoPSR7ZW5jb2RlVVJJQ29tcG9uZW50KHApfWApKTtcclxuICAgIH0pO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6aW5qZWN0JywgKGV2ZW50LCB0ZXh0OiB1bmtub3duLCBzZXNzaW9uSWQ6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3QgdCA9IHR5cGVvZiB0ZXh0ID09PSAnc3RyaW5nJyA/IHRleHQuc2xpY2UoMCwgMjBfMDAwKSA6ICcnO1xyXG4gICAgICBjb25zdCBzaWQgPSB0eXBlb2Ygc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IHNlc3Npb25JZC5zbGljZSgwLCA4MCkgOiAnJztcclxuICAgICAgaWYgKHQgPT09ICcnIHx8IHNpZCA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBvazogZmFsc2UsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PignL2FwaS9pbmplY3QnLCB7IHRleHQ6IHQsIHNlc3Npb25JZDogc2lkIH0pKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gXHU0RjFBXHU4QkREXHU1QkZDXHU1MUZBKGV4cG9ydC5tZCBcdTIxOTIgXHU0RkREXHU1QjU4XHU1QkY5XHU4QkREXHU2ODQ2O1x1NjU4N1x1NEVGNlx1NTE5OVx1NTE2NVx1NTNFQVx1NTcyOCBtYWluKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmV4cG9ydC1zZXNzaW9uJywgYXN5bmMgKGV2ZW50LCBpZDogdW5rbm93biwgdGl0bGU6IHVua25vd24pID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIGlkID09PSAnc3RyaW5nJyA/IGlkLnJlcGxhY2UoL1teYS16QS1aMC05XzouQC1dL2csICcnKS5zbGljZSgwLCA4MCkgOiAnJztcclxuICAgICAgaWYgKHNpZCA9PT0gJycpIHJldHVybiB7IGVycm9yOiAnaWQgcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH07XHJcbiAgICAgIGlmIChjbGllbnQgPT09IG51bGwgfHwgYnJpZGdlLmhvc3RTdGF0ZSAhPT0gJ3JlYWR5JykgcmV0dXJuIHsgZXJyb3I6IGBob3N0IG5vdCByZWFkeSAoJHticmlkZ2UuaG9zdFN0YXRlfSlgLCBjb2RlOiAnSE9TVF9OT1RfUkVBRFknIH07XHJcbiAgICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgbWQgPSBhd2FpdCBjbGllbnQuZ2V0VGV4dChgL2FwaS9zZXNzaW9ucy8ke2VuY29kZVVSSUNvbXBvbmVudChzaWQpfS9leHBvcnQubWRgKTtcclxuICAgICAgICBjb25zdCB3aW4gPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5maW5kKCh3KSA9PiAhdy5pc0Rlc3Ryb3llZCgpKTtcclxuICAgICAgICBpZiAod2luID09PSB1bmRlZmluZWQpIHJldHVybiB7IGVycm9yOiAnbm8gd2luZG93JywgY29kZTogJ0JSSURHRV9FUlJPUicgfTtcclxuICAgICAgICBjb25zdCByID0gYXdhaXQgZGlhbG9nLnNob3dTYXZlRGlhbG9nKHdpbiwge1xyXG4gICAgICAgICAgdGl0bGU6IHR5cGVvZiB0aXRsZSA9PT0gJ3N0cmluZycgJiYgdGl0bGUgIT09ICcnID8gdGl0bGUuc2xpY2UoMCwgODApIDogJ1x1NUJGQ1x1NTFGQVx1NEYxQVx1OEJERCcsXHJcbiAgICAgICAgICBkZWZhdWx0UGF0aDogYGhtaC0ke3NpZH0ubWRgLFxyXG4gICAgICAgICAgZmlsdGVyczogW3sgbmFtZTogJ01hcmtkb3duJywgZXh0ZW5zaW9uczogWydtZCddIH1dLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIGlmIChyLmNhbmNlbGVkIHx8IHIuZmlsZVBhdGggPT09IHVuZGVmaW5lZCB8fCByLmZpbGVQYXRoID09PSAnJykgcmV0dXJuIHsgb2s6IGZhbHNlLCBjYW5jZWxlZDogdHJ1ZSB9O1xyXG4gICAgICAgIGF3YWl0IHdyaXRlRmlsZShyLmZpbGVQYXRoLCBtZCwgJ3V0ZjgnKTtcclxuICAgICAgICBsb2dJbmZvKCdleHBvcnQnLCBgc2Vzc2lvbiAke3NpZH0gXHUyMTkyICR7ci5maWxlUGF0aH1gKTtcclxuICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgcGF0aDogci5maWxlUGF0aCB9O1xyXG4gICAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgICBjb25zdCBkZXRhaWwgPSAoKCkgPT4geyB0cnkgeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkoZXJyKTsgfSBjYXRjaCB7IHJldHVybiBTdHJpbmcoZXJyKTsgfSB9KSgpLnNsaWNlKDAsIDMwMCk7XHJcbiAgICAgICAgcmV0dXJuIHsgZXJyb3I6IGRldGFpbCwgY29kZTogJ0JSSURHRV9FUlJPUicgfTtcclxuICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBcdTVCQTFcdTYyNzlcdTZBMjFcdTVGMEZcdThCRkJcdTUxOTkoXHU2NzQzXHU1QTAxXHU1NzI4IHJ1bnRpbWUgY29uZmlnO1x1NTIwN1x1NjM2Mlx1NUZDNVx1OTg3Qlx1NjYzRVx1NUYwRikgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTphcHByb3ZhbC1nZXQnLCAoZXZlbnQpID0+XHJcbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPHsgc2V0dGluZ3M/OiB7IGFwcHJvdmFsPzogc3RyaW5nIH0gfT4oJy9hcGkvc3RhdGUnKSkpO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6YXBwcm92YWwtc2V0JywgKGV2ZW50LCBtb2RlOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IG0gPSBtb2RlID09PSAnYXV0bycgPyAnYXV0bycgOiBtb2RlID09PSAnYXNrJyA/ICdhc2snIDogJyc7XHJcbiAgICAgIGlmIChtID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAnbW9kZSBtdXN0IGJlIGFza3xhdXRvJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcclxuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KCcvYXBpL2NvbmZpZycsIHsgYXBwcm92YWw6IG0gfSkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBobWhhcm5lc3MgcnVudGltZSBcdThGREVcdTYzQTUoXHU4MUVBXHU1MkE4XHU1M0QxXHU3M0IwICsgXHU2MjRCXHU1MkE4XHU4OTg2XHU3NkQ2ICsgXHU3MEVEXHU1MjA3XHU2MzYyKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnJ1bnRpbWUtaW5mbycsIGFzeW5jIChldmVudCkgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBjb25zdCBkID0gZGV0ZWN0RXh0ZXJuYWxSdW50aW1lKCk7XHJcbiAgICAgIGNvbnN0IGNmZyA9IGF3YWl0IGxvYWRSdW50aW1lQ29uZmlnKCk7XHJcbiAgICAgIHJldHVybiB7XHJcbiAgICAgICAgbW9kZTogYnJpZGdlLm1vZGUsXHJcbiAgICAgICAgcnVudGltZUVudHJ5OiBicmlkZ2UucnVudGltZUVudHJ5LFxyXG4gICAgICAgIG92ZXJyaWRlOiBjZmcuZW50cnksXHJcbiAgICAgICAgZGVtbzogY2ZnLmRlbW8sXHJcbiAgICAgICAgZGV0ZWN0ZWQ6IGQuZW50cnksXHJcbiAgICAgICAgZGV0ZWN0ZWRWZXJzaW9uOiBkLnZlcnNpb24sXHJcbiAgICAgICAgZGV0ZWN0ZWRTb3VyY2U6IGQuc291cmNlLFxyXG4gICAgICB9O1xyXG4gICAgfSk7XHJcblxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpicm93c2UtcnVudGltZScsIGFzeW5jIChldmVudCwgdGl0bGU6IHVua25vd24pID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgY29uc3Qgd2luID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkuZmluZCgodykgPT4gIXcuaXNEZXN0cm95ZWQoKSk7XHJcbiAgICAgIGlmICh3aW4gPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgZXJyb3I6ICdubyB3aW5kb3cnLCBjb2RlOiAnQlJJREdFX0VSUk9SJyB9O1xyXG4gICAgICBjb25zdCByID0gYXdhaXQgZGlhbG9nLnNob3dPcGVuRGlhbG9nKHdpbiwge1xyXG4gICAgICAgIHRpdGxlOiB0eXBlb2YgdGl0bGUgPT09ICdzdHJpbmcnICYmIHRpdGxlICE9PSAnJyA/IHRpdGxlLnNsaWNlKDAsIDEyMCkgOiAnXHU5MDA5XHU2MkU5IGhtaGFybmVzcyBcdTc2ODQgZGVza3RvcC1ob3N0IFx1NTE2NVx1NTNFMycsXHJcbiAgICAgICAgcHJvcGVydGllczogWydvcGVuRmlsZSddLFxyXG4gICAgICAgIGZpbHRlcnM6IFt7IG5hbWU6ICdkZXNrdG9wLWhvc3QnLCBleHRlbnNpb25zOiBbJ3RzJywgJ2pzJ10gfV0sXHJcbiAgICAgIH0pO1xyXG4gICAgICBpZiAoci5jYW5jZWxlZCB8fCByLmZpbGVQYXRoc1swXSA9PT0gdW5kZWZpbmVkKSByZXR1cm4geyBvazogZmFsc2UsIGNhbmNlbGVkOiB0cnVlIH07XHJcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBlbnRyeTogci5maWxlUGF0aHNbMF0gfTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qKiBcdThCQkVcdTdGNkUvXHU2RTA1XHU5NjY0XHU2MjRCXHU1MkE4XHU1MTY1XHU1M0UzXHU1NDBFXHU3MEVEXHU5MUNEXHU1NDJGIGhvc3QoXHU3QTdBXHU0RTMyPVx1NTZERVx1NTIzMFx1ODFFQVx1NTJBOFx1NTNEMVx1NzNCMClcdTMwMDIgKi9cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6c2V0LXJ1bnRpbWUnLCBhc3luYyAoZXZlbnQsIGVudHJ5OiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IGUgPSB0eXBlb2YgZW50cnkgPT09ICdzdHJpbmcnID8gZW50cnkudHJpbSgpIDogJyc7XHJcbiAgICAgIGlmIChlICE9PSAnJyAmJiAoIWlzQWJzb2x1dGUoZSkgfHwgIWV4aXN0c1N5bmMoZSkpKSB7XHJcbiAgICAgICAgcmV0dXJuIHsgZXJyb3I6ICdcdTUxNjVcdTUzRTNcdTVGQzVcdTk4N0JcdTY2MkZcdTVCNThcdTU3MjhcdTc2ODRcdTdFRERcdTVCRjlcdThERUZcdTVGODQoZGVza3RvcC1ob3N0LnRzKScsIGNvZGU6ICdCQURfUkVRVUVTVCcgfTtcclxuICAgICAgfVxyXG4gICAgICBhd2FpdCBzYXZlUnVudGltZUVudHJ5T3ZlcnJpZGUoZSk7XHJcbiAgICAgIC8vIFx1NzBFRFx1NTIwN1x1NjM2MjpcdTUxNDhcdTRGMThcdTk2QzVcdTUwNUNcdTYzODlcdTVGNTNcdTUyNEQgaG9zdCxcdTUxOERcdTYzMDlcdTY1QjBcdTkxNERcdTdGNkVcdTYyQzlcdThENzdcclxuICAgICAgc3NlQWJvcnQ/LmFib3J0KCk7XHJcbiAgICAgIGlmIChzdXBlcnZpc29yICE9PSBudWxsKSBhd2FpdCBzdXBlcnZpc29yLnN0b3AoKTtcclxuICAgICAgYXdhaXQgc3RhcnRIb3N0KCk7XHJcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBtb2RlOiBicmlkZ2UubW9kZSB9O1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSB2NS4xIFx1OTk5Nlx1NTQyRlx1NUI4OVx1ODhDNVx1NTQxMVx1NUJGQzpcdTY3MkNcdTY3M0FcdTY4QzBcdTZENEIgLyBcdTRFMEJcdThGN0RcdTVCODlcdTg4QzUoXHU4RkRCXHU1RUE2XHU0RThCXHU0RUY2KSAvIFx1NTQxMVx1NUJGQ1x1NzJCNlx1NjAwMSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmRldGVjdC1ydW50aW1lJywgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IGluZm8gPSBidW5kbGVkUnVudGltZUluZm8oKTtcclxuICAgICAgLy8gVUlWRVJJRlkgXHU1NDExXHU1QkZDXHU2QjY1XHU3Njg0XCJcdTRGMkFcdTkwMjBcdTY3MkFcdTkxNERcdTdGNkVcdTYwMDFcIjpmYWtlIFx1NkEyMVx1NUYwRlx1NEUwQlx1NjA1Mlx1NjJBNVx1NjcyQVx1NjhDMFx1NkQ0QlxyXG4gICAgICAvLyAoXHU3NzFGXHU1QjlFXHU2OEMwXHU2RDRCXHU4REVGXHU1Rjg0XHU3NTMxIHJlYWwgXHU1M0Q4XHU0RjUzXHU5QThDXHU2NTM2LFx1ODlDMSBldmlkZW5jZS9zZXR1cC13aXphcmQvKVx1MzAwMlxyXG4gICAgICAvLyBVSVZFUklGWV9GQUtFX0RFVEVDVF9GT1VORD0xKHVpdmVyaWZ5IFx1N0E4NFx1NUM0Rlx1NTczQVx1NjY2Rlx1OEZEMFx1ODg0Q1x1NEUyRFx1NTJBOFx1NjAwMVx1N0Y2RVx1NEY0RCk6XHJcbiAgICAgIC8vIFx1NEYyQVx1OTAyMFwiXHU2OEMwXHU2RDRCXHU1MjMwXHU1REYyXHU4OEM1XCIsXHU4QkE5XHU1NDExXHU1QkZDXHU1MUZBXHU3M0IwXHU2OEMwXHU2RDRCXHU5ODc1XHU0RTA5XHU5MDA5XHU5ODc5IFx1MjE5MiBcdTUzNTVcdTUxRkJcdTUyNERcdThGREIgXHUyMTkyIFx1OTAwOVx1NjJFOVx1OTg3NVx1MzAwMlxyXG4gICAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfV0laQVJEID09PSAnZmFrZScgJiYgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfRkFLRSA9PT0gJzEnKSB7XHJcbiAgICAgICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX0ZBS0VfREVURUNUX0ZPVU5EID09PSAnMScpIHtcclxuICAgICAgICAgIHJldHVybiB7IGZvdW5kOiB0cnVlLCB2ZXJzaW9uOiAnMC4wLjAtdmVyaWZ5JywgZW50cnk6ICd2ZXJpZnk6Ly9mYWtlLWVudHJ5Jywgc291cmNlOiAndmVyaWZ5JywgYnVuZGxlZDogaW5mbywgbnBtOiBucG1PblBhdGgoKSB9O1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4geyBmb3VuZDogZmFsc2UsIHZlcnNpb246ICcnLCBlbnRyeTogJycsIHNvdXJjZTogJycsIGJ1bmRsZWQ6IGluZm8sIG5wbTogbnBtT25QYXRoKCkgfTtcclxuICAgICAgfVxyXG4gICAgICBjb25zdCBkID0gZGV0ZWN0RXh0ZXJuYWxSdW50aW1lKCk7XHJcbiAgICAgIHJldHVybiB7IGZvdW5kOiBkLmVudHJ5ICE9PSAnJywgdmVyc2lvbjogZC52ZXJzaW9uLCBlbnRyeTogZC5lbnRyeSwgc291cmNlOiBkLnNvdXJjZSwgYnVuZGxlZDogaW5mbywgbnBtOiBucG1PblBhdGgoKSB9O1xyXG4gICAgfSk7XHJcblxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTppbnN0YWxsLWNsaScsIChldmVudCwgb3B0czogdW5rbm93bikgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBjb25zdCBvID0gKG9wdHMgPz8ge30pIGFzIHsgZm9yY2VUZ3o/OiB1bmtub3duOyBtaXJyb3JGaXJzdD86IHVua25vd24gfTtcclxuICAgICAgLy8gVUlWRVJJRlkgZmFrZSBcdTU0MTFcdTVCRkM6XHU4MUVBXHU1MkE4XHU1Qjg5XHU4OEM1XHU4REVGXHU1Rjg0XHU4RDcwXHU2QTIxXHU2MkRGXHU4RkRCXHU1RUE2KFx1NEUwRFx1NzhCMFx1NzhDMVx1NzZEOC9cdTdGNTFcdTdFREMvXHU0RTBEXHU3MEVEXHU1MjA3XHU2MzYyKSxcclxuICAgICAgLy8gXHU0RTE0XHU0RTBEXHU1M0QxIGRvbmVcdTIwMTRcdTIwMTRcdTlBOENcdTY1MzZcdTg5ODFcdTU3MjhcdTVCODlcdTg4QzVcdTk4NzVcdTcwQjlcIlx1NjUzOVx1NzUyOFx1NTE4NVx1N0Y2RVwiXHU1MjA3XHU2MzYyXHU5NEZFXHU2M0E1XHUzMDAyXHJcbiAgICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9XSVpBUkQgPT09ICdmYWtlJyAmJiBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9GQUtFID09PSAnMScpIHtcclxuICAgICAgICBjb25zdCBzZW5kU2ltID0gKHA6IEluc3RhbGxQcm9ncmVzcyk6IHZvaWQgPT4ge1xyXG4gICAgICAgICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XHJcbiAgICAgICAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ2luc3RhbGw6cHJvZ3Jlc3MnLCBwKTtcclxuICAgICAgICAgIH1cclxuICAgICAgICB9O1xyXG4gICAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcclxuICAgICAgICAgIHNlbmRTaW0oeyBwaGFzZTogJ2NoZWNrJywgdGV4dDogJ1x1NjhDMFx1NjdFNSBucG1cdTIwMjYodmVyaWZ5IFx1NkEyMVx1NjJERiknIH0pO1xyXG4gICAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgNDAwKSk7XHJcbiAgICAgICAgICBzZW5kU2ltKHsgcGhhc2U6ICducG0nLCB0ZXh0OiAnbnBtIGluc3RhbGwgQGhtaGFybmVzcy9jbGkgXHUyMTkyIH4vLmhtaGFybmVzcy1nbG9iYWwodmVyaWZ5IFx1NkEyMVx1NjJERixcdTRFMERcdTg0M0RcdTc2RDgpJyB9KTtcclxuICAgICAgICB9KSgpO1xyXG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCB0ZXN0OiB0cnVlIH07XHJcbiAgICAgIH1cclxuICAgICAgcmV0dXJuIHN0YXJ0Q2xpSW5zdGFsbChcclxuICAgICAgICB7XHJcbiAgICAgICAgICBzZW5kUHJvZ3Jlc3M6IChwOiBJbnN0YWxsUHJvZ3Jlc3MpOiB2b2lkID0+IHtcclxuICAgICAgICAgICAgbG9nSW5mbygnaW5zdGFsbCcsIGAke3AucGhhc2V9JHtwLnBjdCAhPT0gdW5kZWZpbmVkID8gYCAke3AucGN0fSVgIDogJyd9ICR7cC50ZXh0fWApO1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcclxuICAgICAgICAgICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCdpbnN0YWxsOnByb2dyZXNzJywgcCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgIH0sXHJcbiAgICAgICAgICBsb2c6IChtOiBzdHJpbmcpOiB2b2lkID0+IHsgbG9nSW5mbygnaW5zdGFsbCcsIG0pOyB9LFxyXG4gICAgICAgICAgLy8gXHU1Qjg5XHU4OEM1XHU2MjEwXHU1MjlGXHU1MzczXHU2MzAxXHU0RTQ1XHU1MzE2XHU1RTc2XHU3MEVEXHU1MjA3XHU2MzYyKFx1NTQxMVx1NUJGQ1x1OTY4Rlx1NTQwRVx1NjUzNlx1NUMzRTtcdTRFMkRcdTkwMTRcdTUzRDZcdTZEODhcdTRFNUZcdTVERjJcdTc1MUZcdTY1NDgpXHJcbiAgICAgICAgICBvbkluc3RhbGxlZDogKGVudHJ5OiBzdHJpbmcpOiB2b2lkID0+IHtcclxuICAgICAgICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgICAgICAgIGF3YWl0IHNhdmVSdW50aW1lQ29uZmlnKHsgZW50cnksIGRlbW86IGZhbHNlIH0pO1xyXG4gICAgICAgICAgICAgIHNzZUFib3J0Py5hYm9ydCgpO1xyXG4gICAgICAgICAgICAgIGlmIChzdXBlcnZpc29yICE9PSBudWxsKSBhd2FpdCBzdXBlcnZpc29yLnN0b3AoKTtcclxuICAgICAgICAgICAgICBhd2FpdCBzdGFydEhvc3QoKTtcclxuICAgICAgICAgICAgfSkoKTtcclxuICAgICAgICAgIH0sXHJcbiAgICAgICAgfSxcclxuICAgICAgICB7XHJcbiAgICAgICAgICBmb3JjZVRnejogby5mb3JjZVRneiA9PT0gdHJ1ZSxcclxuICAgICAgICAgIG1pcnJvckZpcnN0OiBvLm1pcnJvckZpcnN0ID09PSAnbnBtbWlycm9yJyA/ICducG1taXJyb3InIDogby5taXJyb3JGaXJzdCA9PT0gJ25wbWpzJyA/ICducG1qcycgOiB1bmRlZmluZWQsXHJcbiAgICAgICAgfSxcclxuICAgICAgKTtcclxuICAgIH0pO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6Z2V0LXdpemFyZCcsIGFzeW5jIChldmVudCkgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBjb25zdCB2YXJpYW50ID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfV0laQVJEO1xyXG4gICAgICBpZiAodmFyaWFudCAhPT0gdW5kZWZpbmVkICYmIHZhcmlhbnQgIT09ICcnKSB7XHJcbiAgICAgICAgLy8gXHU5QThDXHU2NTM2XHU2Nzg0XHU5MDIwOlx1NUYzQVx1NTIzNlx1NTQxMVx1NUJGQ1x1NTNFRlx1ODlDMVx1NEUxNFx1ODlDNlx1NEUzQVx1NjcyQVx1OTE0RFx1N0Y2RShcdTUzRUZcdTkxQ0RcdTU5MERcdThERDEpO3BlcnNpc3RlZD1cdTc3MUZcdTVCOUVcdTg0M0RcdTc2RDhcclxuICAgICAgICAvLyBcdTcyQjZcdTYwMDEoXHU1NDExXHU1QkZDXHU2QjY1XHU2NUFEXHU4QTAwXCJcdTkwMDlcdTYyRTlcdTYzMDFcdTRFNDVcIlx1NzUyOCxcdTRFMERcdTVGNzFcdTU0Q0QgVUkgXHU1MjI0XHU1QjlBKVxyXG4gICAgICAgIGNvbnN0IHcgPSBhd2FpdCBsb2FkV2l6YXJkU3RhdGUoKTtcclxuICAgICAgICByZXR1cm4geyBkb25lOiBmYWxzZSwgY2hvaWNlOiAnJywgc3VwcHJlc3NlZDogZmFsc2UsIHBlcnNpc3RlZDogeyBkb25lOiB3LmRvbmUsIGNob2ljZTogdy5jaG9pY2UgfSB9O1xyXG4gICAgICB9XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCBsb2FkV2l6YXJkU3RhdGUoKTtcclxuICAgICAgY29uc3QgY2ZnID0gYXdhaXQgbG9hZFJ1bnRpbWVDb25maWcoKTtcclxuICAgICAgLy8gXHU1REYyXHU5MTREXHU3RjZFXHU4RkM3IHJ1bnRpbWUoXHU2MjRCXHU1MkE4XHU1MTY1XHU1M0UzL1x1NTQxMVx1NUJGQ1x1OTAwOVx1NjJFOS9cdTZGMTRcdTc5M0EpXHU4OUM2XHU1NDBDXHU1REYyXHU1QjhDXHU2MjEwXHU5OTk2XHU1NDJGXHJcbiAgICAgIHJldHVybiB7IGRvbmU6IHcuZG9uZSB8fCBjZmcuZW50cnkgIT09ICcnIHx8IGNmZy5kZW1vLCBjaG9pY2U6IHcuY2hvaWNlLCBzdXBwcmVzc2VkOiB3aXphcmRTdXBwcmVzc2VkKCkgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qKiBcdTU0MTFcdTVCRkNcdTY1MzZcdTVDM0U6XHU2MzAxXHU0RTQ1XHU1MzE2XHU5MDA5XHU2MkU5XHU1RTc2XHU1RTk0XHU3NTI4KGV4dGVybmFsL2J1bmRsZWRcdTIxOTJcdTUxNjVcdTUzRTNcdTg5ODZcdTc2RDY7ZGVtb1x1MjE5Mlx1NjMwMVx1NEU0NVx1NkYxNFx1NzkzQTtcclxuICAgICAqICBpbnN0YWxsXHUyMTkyXHU1MTY1XHU1M0UzXHU1REYyXHU3NTMxXHU1Qjg5XHU4OEM1XHU1NjY4XHU2MzAxXHU0RTQ1XHU1MzE2LFx1NTNFQVx1OEJCMFx1NzJCNlx1NjAwMSlcdTMwMDJmYWtlL1x1NkQ0Qlx1OEJENVx1NzNBRlx1NTg4M1x1NTNFQVx1OEJCMFx1NzJCNlx1NjAwMVx1MzAwMiAqL1xyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTp3aXphcmQtY29tcGxldGUnLCBhc3luYyAoZXZlbnQsIGNob2ljZTogdW5rbm93biwgZW50cnk6IHVua25vd24pID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgY29uc3QgYyA9IGNob2ljZSA9PT0gJ2V4dGVybmFsJyB8fCBjaG9pY2UgPT09ICdpbnN0YWxsJyB8fCBjaG9pY2UgPT09ICdidW5kbGVkJyB8fCBjaG9pY2UgPT09ICdkZW1vJyA/IGNob2ljZSA6ICcnO1xyXG4gICAgICBpZiAoYyA9PT0gJycpIHJldHVybiB7IGVycm9yOiAnY2hvaWNlIG11c3QgYmUgZXh0ZXJuYWx8aW5zdGFsbHxidW5kbGVkfGRlbW8nLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH07XHJcbiAgICAgIGNvbnN0IGUgPSB0eXBlb2YgZW50cnkgPT09ICdzdHJpbmcnID8gZW50cnkgOiAnJztcclxuICAgICAgYXdhaXQgc2F2ZVdpemFyZFN0YXRlKGMpO1xyXG4gICAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfRkFLRSA9PT0gJzEnKSByZXR1cm4geyBvazogdHJ1ZSwgbW9kZTogYnJpZGdlLm1vZGUsIHRlc3Q6IHRydWUgfTtcclxuICAgICAgY29uc3QgcmVwb1Jvb3QgPSBqb2luKGhlcmUsICcuLicsICcuLicsICcuLicsICcuLicpO1xyXG4gICAgICBpZiAoYyA9PT0gJ2V4dGVybmFsJyB8fCBjID09PSAnYnVuZGxlZCcpIHtcclxuICAgICAgICBjb25zdCB0YXJnZXQgPSBjID09PSAnYnVuZGxlZCcgPyBidW5kbGVkUnVudGltZVBhdGgocmVwb1Jvb3QpIDogZTtcclxuICAgICAgICBpZiAodGFyZ2V0ID09PSAnJyB8fCAhaXNBYnNvbHV0ZSh0YXJnZXQpIHx8ICFleGlzdHNTeW5jKHRhcmdldCkpIHtcclxuICAgICAgICAgIHJldHVybiB7IGVycm9yOiAncnVudGltZSBcdTUxNjVcdTUzRTNcdTRFMERcdTVCNThcdTU3MjgnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH07XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGF3YWl0IHNhdmVSdW50aW1lQ29uZmlnKHsgZW50cnk6IHRhcmdldCwgZGVtbzogZmFsc2UgfSk7XHJcbiAgICAgIH0gZWxzZSBpZiAoYyA9PT0gJ2RlbW8nKSB7XHJcbiAgICAgICAgYXdhaXQgc2F2ZVJ1bnRpbWVDb25maWcoeyBlbnRyeTogJycsIGRlbW86IHRydWUgfSk7XHJcbiAgICAgIH1cclxuICAgICAgaWYgKGMgIT09ICdpbnN0YWxsJykge1xyXG4gICAgICAgIC8vIGluc3RhbGw6XHU1Qjg5XHU4OEM1XHU1NjY4XHU1REYyXHU1NzI4IG9uSW5zdGFsbGVkIFx1NjMwMVx1NEU0NVx1NTMxNlx1NUU3Nlx1NzBFRFx1NTIwN1x1NjM2MixcdThGRDlcdTkxQ0NcdTRFMERcdTUxOERcdTkxQ0RcdTU0MkZcclxuICAgICAgICBzc2VBYm9ydD8uYWJvcnQoKTtcclxuICAgICAgICBpZiAoc3VwZXJ2aXNvciAhPT0gbnVsbCkgYXdhaXQgc3VwZXJ2aXNvci5zdG9wKCk7XHJcbiAgICAgICAgYXdhaXQgc3RhcnRIb3N0KCk7XHJcbiAgICAgIH1cclxuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIG1vZGU6IGJyaWRnZS5tb2RlIH07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIFByb3ZpZGVyIFx1OEJCRVx1N0Y2RSgwMyBcdTAwQTdcdTRFMDM6a2V5IFx1NTNFQVx1NTFGQSBoYXNLZXkvXHU2NzJCXHU1NkRCXHU0RjREO1x1NEZERFx1NUI1OFx1NzZGNFx1NTE5OSBydW50aW1lKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnByb3ZpZGVycycsIChldmVudCkgPT5cclxuICAgICAgaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248eyBwcm92aWRlcnNEZXRhaWw/OiBBcnJheTx7IG5hbWU6IHN0cmluZzsgbW9kZWw6IHN0cmluZzsgYmFzZVVybDogc3RyaW5nOyBoYXNLZXk6IGJvb2xlYW47IGtleVRhaWw/OiBzdHJpbmcgfT47IG1vZGVsPzogc3RyaW5nIH0+KCcvYXBpL3N0YXRlJykpKTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnByb3ZpZGVyLXNhdmUnLCAoZXZlbnQsIHByb3ZpZGVyOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IHAgPSBwcm92aWRlciBhcyB7IG5hbWU/OiB1bmtub3duOyBiYXNlVXJsPzogdW5rbm93bjsgbW9kZWw/OiB1bmtub3duOyBhcGlLZXk/OiB1bmtub3duIH07XHJcbiAgICAgIGNvbnN0IG5hbWUgPSB0eXBlb2YgcD8ubmFtZSA9PT0gJ3N0cmluZycgPyBwLm5hbWUuc2xpY2UoMCwgODApIDogJyc7XHJcbiAgICAgIGNvbnN0IGJhc2VVcmwgPSB0eXBlb2YgcD8uYmFzZVVybCA9PT0gJ3N0cmluZycgPyBwLmJhc2VVcmwuc2xpY2UoMCwgMzAwKSA6ICcnO1xyXG4gICAgICBjb25zdCBtb2RlbCA9IHR5cGVvZiBwPy5tb2RlbCA9PT0gJ3N0cmluZycgPyBwLm1vZGVsLnNsaWNlKDAsIDEyMCkgOiAnJztcclxuICAgICAgaWYgKG5hbWUgPT09ICcnIHx8IGJhc2VVcmwgPT09ICcnIHx8IG1vZGVsID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAnbmFtZS9iYXNlVXJsL21vZGVsIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcclxuICAgICAgY29uc3QgYm9keTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7IG5hbWUsIGJhc2VVcmwsIG1vZGVsIH07XHJcbiAgICAgIC8vIGFwaUtleSBcdTUzRUFcdTU3MjhcdTY2M0VcdTVGMEZcdThGOTNcdTUxNjVcdTY1RjZcdTRFMEFcdTRGMjAsXHU3RUREXHU0RTBEXHU1NkRFXHU2NjNFKHJlbmRlcmVyIFx1ODg2OFx1NTM1NVx1NjNEMFx1NEVBNFx1NTQwRVx1NTM3M1x1NkUwNVx1N0E3QSlcclxuICAgICAgaWYgKHR5cGVvZiBwPy5hcGlLZXkgPT09ICdzdHJpbmcnICYmIHAuYXBpS2V5ICE9PSAnJykgYm9keS5hcGlLZXkgPSBwLmFwaUtleS5zbGljZSgwLCAzMDApO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvcHJvdmlkZXJzJywgYm9keSkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBcdTVERTVcdTRGNUNcdTUzM0EoMDMgXHUwMEE3XHU1MTZEO1x1NTIwN1x1NjM2Mlx1OEJFRFx1NEU0OVx1NEUwRSB3ZWIgXHU3NkY4XHU1NDBDOnJ1bnRpbWUgXHU1MzU1XHU5MDA5IGN3ZCkgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTp3b3Jrc3BhY2VzJywgKGV2ZW50KSA9PlxyXG4gICAgICBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjx7IGN1cnJlbnQ6IHN0cmluZzsgaXRlbXM6IEFycmF5PHsgaWQ6IHN0cmluZzsgbmFtZTogc3RyaW5nOyBwYXRoOiBzdHJpbmcgfT4gfT4oJy9hcGkvd29ya3NwYWNlcycpKSk7XHJcblxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTp3b3Jrc3BhY2UtdXNlJywgKGV2ZW50LCBpZDogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCB3aWQgPSB0eXBlb2YgaWQgPT09ICdzdHJpbmcnID8gaWQuc2xpY2UoMCwgNjApIDogJyc7XHJcbiAgICAgIGlmICh3aWQgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICdpZCByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PignL2FwaS93b3Jrc3BhY2VzL3VzZScsIHsgaWQ6IHdpZCB9KSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOndvcmtzcGFjZS1hZGQnLCAoZXZlbnQsIG5hbWU6IHVua25vd24sIHBhdGg6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3QgbiA9IHR5cGVvZiBuYW1lID09PSAnc3RyaW5nJyA/IG5hbWUuc2xpY2UoMCwgMTIwKSA6ICcnO1xyXG4gICAgICBjb25zdCBwID0gdHlwZW9mIHBhdGggPT09ICdzdHJpbmcnID8gcGF0aC5zbGljZSgwLCAxMDAwKSA6ICcnO1xyXG4gICAgICBpZiAocCA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ3BhdGggcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvd29ya3NwYWNlcycsIHsgbmFtZTogbiA9PT0gJycgPyB1bmRlZmluZWQgOiBuLCBwYXRoOiBwIH0pKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gXHU0RjFBXHU4QkREXHU1RjUyXHU2ODYzL1x1NTIyMFx1OTY2NChcdTc5RkJcdTUxNjUgYXJjaGl2ZS90cmFzaCxcdTUzRUZcdTYwNjJcdTU5MEQ7cnVudGltZSBcdTY3NDNcdTVBMDEpIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6c2Vzc2lvbi1vcCcsIChldmVudCwgaWQ6IHVua25vd24sIG9wOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IHNpZCA9IHR5cGVvZiBpZCA9PT0gJ3N0cmluZycgPyBpZC5yZXBsYWNlKC9bXmEtekEtWjAtOV86LkAtXS9nLCAnJykuc2xpY2UoMCwgODApIDogJyc7XHJcbiAgICAgIGNvbnN0IG8gPSBvcCA9PT0gJ2FyY2hpdmUnIHx8IG9wID09PSAnZGVsZXRlJyA/IG9wIDogJyc7XHJcbiAgICAgIGlmIChzaWQgPT09ICcnIHx8IG8gPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICdpZCBhbmQgb3AoYXJjaGl2ZXxkZWxldGUpIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcclxuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KGAvYXBpL3Nlc3Npb25zLyR7ZW5jb2RlVVJJQ29tcG9uZW50KHNpZCl9LyR7b31gLCB7fSkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBNNDpEaWZmIFx1OTc2Mlx1Njc3RihcdTUzRUFcdThCRkIgZ2l0IFx1NTNEOFx1NjZGNDtcdTYzODhcdTY3NDNcdTU3MjggcnVudGltZSkgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpkaWZmJywgKGV2ZW50LCBzZXNzaW9uSWQ6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIHNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBzZXNzaW9uSWQuc2xpY2UoMCwgODApIDogJyc7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oYC9hcGkvZGlmZiR7c2lkICE9PSAnJyA/IGA/c2Vzc2lvbklkPSR7ZW5jb2RlVVJJQ29tcG9uZW50KHNpZCl9YCA6ICcnfWApKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gTTU6XHU4QkE0XHU3N0U1XHU3MkI2XHU2MDAxKFx1N0VEM1x1Njc4NFx1NTMxNlx1NEU4Qlx1NUI5RTtcdTdGM0FcdTY1NzBcdTYzNkVcdTVCNTdcdTZCQjVcdTc1MzEgVUkgXHU2NjNFXHU3OTNBXCJcdTY1RTBcdTY1NzBcdTYzNkVcIikgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpjb2duaXRpdmUnLCAoZXZlbnQpID0+XHJcbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPFJlY29yZDxzdHJpbmcsIHVua25vd24+PignL2FwaS9jb2duaXRpdmUnKSkpO1xyXG5cclxuICAgIC8vIC0tLS0gXHU1Mzg2XHU1M0YyXHU0RjFBXHU4QkREXHU5ODg0XHU4OUM4KFx1NjcwMFx1NTQwRSA4MCBcdTY3NjEsXHU2QkNGXHU2NzYxIDUwMCBcdTVCNTc7cnVudGltZSBcdTY3NDNcdTVBMDFcdTY1NzBcdTYzNkUpIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6c2Vzc2lvbi1wcmV2aWV3JywgKGV2ZW50LCBpZDogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBzaWQgPSB0eXBlb2YgaWQgPT09ICdzdHJpbmcnID8gaWQucmVwbGFjZSgvW15hLXpBLVowLTlfOi5ALV0vZywgJycpLnNsaWNlKDAsIDgwKSA6ICcnO1xyXG4gICAgICBpZiAoc2lkID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAnaWQgcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KGAvYXBpL3Nlc3Npb25zLyR7ZW5jb2RlVVJJQ29tcG9uZW50KHNpZCl9YCkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpzdG9wLWhvc3QnLCAoZXZlbnQpID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJyB9O1xyXG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgc3NlQWJvcnQ/LmFib3J0KCk7XHJcbiAgICAgICAgYXdhaXQgc3VwZXJ2aXNvcj8uc3RvcCgpO1xyXG4gICAgICAgIGFwcC5xdWl0KCk7XHJcbiAgICAgIH0pKCk7XHJcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlIH07XHJcbiAgICB9KTtcclxuICB9XHJcblxyXG4gIC8qIC0tLS0gXHU3QTk3XHU1M0UzXHU0RTBFXHU1Qjg5XHU1MTY4XHU3QjU2XHU3NTY1IC0tLS0gKi9cclxuICAvLyAwMyBcdTAwQTdcdTRFMDM6RGVza3RvcCBcdTY3MkNcdTU3MzBcdTUzRUFcdTVCNTggVUkgXHU1MDRGXHU1OTdEL1x1N0E5N1x1NTNFM1x1NzJCNlx1NjAwMSh1c2VyRGF0YS93aW5kb3ctc3RhdGUuanNvbilcclxuICBjb25zdCB3aW5kb3dTdGF0ZUZpbGUgPSAoKTogc3RyaW5nID0+IGpvaW4oYXBwLmdldFBhdGgoJ3VzZXJEYXRhJyksICd3aW5kb3ctc3RhdGUuanNvbicpO1xyXG4gIGFzeW5jIGZ1bmN0aW9uIGxvYWRCb3VuZHMoKTogUHJvbWlzZTx7IHdpZHRoOiBudW1iZXI7IGhlaWdodDogbnVtYmVyOyB4PzogbnVtYmVyOyB5PzogbnVtYmVyIH0gfCBudWxsPiB7XHJcbiAgICB0cnkge1xyXG4gICAgICByZXR1cm4gSlNPTi5wYXJzZShhd2FpdCByZWFkRmlsZSh3aW5kb3dTdGF0ZUZpbGUoKSwgJ3V0ZjgnKSkgYXMgeyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlcjsgeD86IG51bWJlcjsgeT86IG51bWJlciB9O1xyXG4gICAgfSBjYXRjaCB7IHJldHVybiBudWxsOyB9XHJcbiAgfVxyXG4gIGFzeW5jIGZ1bmN0aW9uIHNhdmVCb3VuZHMod2luOiBCcm93c2VyV2luZG93KTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICB0cnkgeyBhd2FpdCB3cml0ZUZpbGUod2luZG93U3RhdGVGaWxlKCksIEpTT04uc3RyaW5naWZ5KHdpbi5nZXRCb3VuZHMoKSksICd1dGY4Jyk7IH0gY2F0Y2ggeyAvKiBiZXN0IGVmZm9ydCAqLyB9XHJcbiAgfVxyXG5cclxuICBhc3luYyBmdW5jdGlvbiBjcmVhdGVXaW5kb3coKTogUHJvbWlzZTxCcm93c2VyV2luZG93IHwgbnVsbD4ge1xyXG4gICAgY29uc3Qgc2F2ZWQgPSBhd2FpdCBsb2FkQm91bmRzKCk7XHJcbiAgICBjb25zdCB3aW4gPSBuZXcgQnJvd3NlcldpbmRvdyh7XHJcbiAgICAgIHdpZHRoOiBzYXZlZD8ud2lkdGggPz8gMTQ0MCxcclxuICAgICAgaGVpZ2h0OiBzYXZlZD8uaGVpZ2h0ID8/IDkwMCxcclxuICAgICAgLi4uKHNhdmVkPy54ICE9PSB1bmRlZmluZWQgJiYgc2F2ZWQ/LnkgIT09IHVuZGVmaW5lZCA/IHsgeDogc2F2ZWQueCwgeTogc2F2ZWQueSB9IDoge30pLFxyXG4gICAgICAvLyBISUcgXHU5NjM2XHU2QkI1MigxMS1BKTpcdTdBODRcdTdBOTdcdTRFMEJcdTk2NTAgNTYwKDA0IFx1NTNGN1x1ODlDNFx1NjgzQztcdTUzOUYgOTYwIFx1NEY3RiBcdTIyNjQ4MjBweCBcdTYyQkRcdTVDNDlcdTY1QURcdTcwQjlcdTRFMERcdTUzRUZcdThGQkUpO1xyXG4gICAgICAvLyBVSVZFUklGWSBcdTdBODRcdTVDNEZcdTlBOENcdTY1MzYoMTEtQix3aXphcmQgMzYwXHUwMEQ3NjQwIFx1NTE2OFx1NTE0M1x1N0QyMFx1NTNFRlx1OEZCRSlcdTk3MDBcdTRFMzRcdTY1RjZcdTY1M0VcdTVCQkRcdTUyMzAgMzIwXHUwMEQ3MzYwXHUzMDAyXHJcbiAgICAgIG1pbldpZHRoOiBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWSA9PT0gJzEnID8gMzIwIDogNTYwLFxyXG4gICAgICBtaW5IZWlnaHQ6IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZID09PSAnMScgPyAzNjAgOiA2MDAsXHJcbiAgICAgIHNob3c6IGZhbHNlLFxyXG4gICAgICBiYWNrZ3JvdW5kQ29sb3I6ICcjZjlmYWZiJywgLy8gdjQgRFNIOlx1NkQ0NVx1ODI3Mlx1OUVEOFx1OEJBNChiZy1iYXNlKSxcdTkwN0ZcdTUxNERcdTZERjFcdTgyNzJcdTk1RUFcdTVDNEZcclxuICAgICAgdGl0bGU6ICdITUggRGVza3RvcCcsXHJcbiAgICAgIC8vIFx1OTY5MFx1ODVDRlx1NUYwRlx1NjgwN1x1OTg5OFx1NjgwRjpcdTUzOUZcdTc1MUZcdTdBOTdcdTUzRTNcdTYzQTdcdTUyMzYob3ZlcmxheSBcdTYzRDBcdTRGOUIpK1x1OTg5Q1x1ODI3Mlx1OTY4Rlx1NEUzQlx1OTg5OChyZW5kZXJlciBcdTdFQ0ZcclxuICAgICAgLy8gY2hyb21lLXRoZW1lIFx1NTQwQ1x1NkI2NSlcdTIwMTRcdTIwMTRcdTY4MzlcdTZDQkJcdTRFQUVcdTgyNzJcdTZBMjFcdTVGMEZcdTk4NzZcdTkwRThcdTlFRDFcdTY3NjE7XHU4M0RDXHU1MzU1XHU2ODBGIGF1dG9IaWRlKEFsdCBcdTU0N0NcdTUxRkEpXHUzMDAyXHJcbiAgICAgIHRpdGxlQmFyU3R5bGU6ICdoaWRkZW4nLFxyXG4gICAgICAvLyBISUcgXHU5NjM2XHU2QkI1MjozNlx1MjE5MjQ0LFx1NEUwRSByZW5kZXJlciAudGl0bGViYXIgXHU5QUQ4XHU1RUE2XHU0RTAwXHU4MUY0KFx1NEUwRFx1NEUwMFx1ODFGNFx1NEYxQVx1OTczMlx1NTFGQS9cdTkwNkVcdTRGNEYgOHB4KVxyXG4gICAgICB0aXRsZUJhck92ZXJsYXk6IHsgLi4uY2hyb21lRm9yKG5hdGl2ZVRoZW1lLnNob3VsZFVzZURhcmtDb2xvcnMpLCBoZWlnaHQ6IDQ0IH0sXHJcbiAgICAgIGF1dG9IaWRlTWVudUJhcjogdHJ1ZSxcclxuICAgICAgd2ViUHJlZmVyZW5jZXM6IHtcclxuICAgICAgICBwcmVsb2FkOiBwcmVsb2FkUGF0aCxcclxuICAgICAgICBjb250ZXh0SXNvbGF0aW9uOiB0cnVlLFxyXG4gICAgICAgIHNhbmRib3g6IHRydWUsXHJcbiAgICAgICAgbm9kZUludGVncmF0aW9uOiBmYWxzZSxcclxuICAgICAgICBub2RlSW50ZWdyYXRpb25JbldvcmtlcjogZmFsc2UsXHJcbiAgICAgICAgd2ViU2VjdXJpdHk6IHRydWUsXHJcbiAgICAgICAgc3BlbGxjaGVjazogZmFsc2UsXHJcbiAgICAgICAgZGV2VG9vbHM6IGlzRGV2LFxyXG4gICAgICB9LFxyXG4gICAgfSk7XHJcbiAgICB3aW4ub25jZSgncmVhZHktdG8tc2hvdycsICgpID0+IHdpbi5zaG93KCkpO1xyXG4gICAgd2luLm9uKCdjbG9zZScsICgpID0+IHsgdm9pZCBzYXZlQm91bmRzKHdpbik7IH0pO1xyXG5cclxuICAgIC8vIFx1NTNFQVx1NTE0MVx1OEJCOFx1NTJBMFx1OEY3RFx1NjIxMVx1NEVFQ1x1ODFFQVx1NURGMVx1NzY4NCByZW5kZXJlcjtcdTRFRkJcdTRGNTVcdTVCRkNcdTgyMkEvXHU2NUIwXHU3QTk3XHU1M0UzXHU0RTAwXHU1RjhCXHU2MkQyXHU3RUREXHJcbiAgICB3aW4ud2ViQ29udGVudHMuc2V0V2luZG93T3BlbkhhbmRsZXIoKHsgdXJsIH0pID0+IHtcclxuICAgICAgaWYgKC9eaHR0cHM/OlxcL1xcLy8udGVzdCh1cmwpKSB2b2lkIHNoZWxsLm9wZW5FeHRlcm5hbCh1cmwpO1xyXG4gICAgICByZXR1cm4geyBhY3Rpb246ICdkZW55JyB9O1xyXG4gICAgfSk7XHJcbiAgICB3aW4ud2ViQ29udGVudHMub24oJ3dpbGwtbmF2aWdhdGUnLCAoZSwgdXJsKSA9PiB7XHJcbiAgICAgIGNvbnN0IG9rID0gWy4uLmFsbG93ZWRPcmlnaW5zXS5zb21lKChvKSA9PiB1cmwgPT09IG8gfHwgdXJsLnN0YXJ0c1dpdGgoYCR7b30vYCkgfHwgdXJsLnN0YXJ0c1dpdGgoYCR7b30/YCkpO1xyXG4gICAgICBpZiAoIW9rKSB7XHJcbiAgICAgICAgbG9nSW5mbygnbmF2JywgYGJsb2NrZWQgbmF2aWdhdGlvbiB0byAke3VybC5zbGljZSgwLCAxMjApfWApO1xyXG4gICAgICAgIGUucHJldmVudERlZmF1bHQoKTtcclxuICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgaWYgKGlzRGV2ICYmIHJlbmRlcmVyRGV2VXJsKSB7XHJcbiAgICAgIHZvaWQgd2luLmxvYWRVUkwocmVuZGVyZXJEZXZVcmwpO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgdm9pZCB3aW4ubG9hZEZpbGUoam9pbihoZXJlLCAnLi4nLCAnLi4nLCAnZGlzdC1yZW5kZXJlcicsICdpbmRleC5odG1sJykpO1xyXG4gICAgfVxyXG4gICAgLy8gXHU5ODc1XHU5NzYyXHU1MkEwXHU4RjdEXHU1QjhDXHU5MUNEXHU2NEFEXHU1RjUzXHU1MjREIGhvc3QgXHU3MkI2XHU2MDAxOnJlYWR5IFx1NUU3Rlx1NjRBRFx1ODJFNVx1NjVFOVx1NEU4RSByZW5kZXJlciBcdThCQTJcdTk2MDVcdTUzNzNcdTRFMjJcdTU5MzEsXHJcbiAgICAvLyByZW5kZXJlciBcdTc2ODQgZ2V0LXN0YXRlIFx1NUZFQlx1NzE2NyArIFx1OEZEOVx1OTFDQ1x1NzY4NFx1OTFDRFx1NjRBRFx1NTNDQ1x1NEZERFx1OTY2OShcdTU5MUFcdTdBOTdcdTUzRTMvXHU5MUNEXHU4RjdEXHU1NzNBXHU2NjZGXHU0RTVGXHU4OTg2XHU3NkQ2KVx1MzAwMlxyXG4gICAgd2luLndlYkNvbnRlbnRzLm9uY2UoJ2RpZC1maW5pc2gtbG9hZCcsICgpID0+IHtcclxuICAgICAgaWYgKCF3aW4uaXNEZXN0cm95ZWQoKSkge1xyXG4gICAgICAgIHdpbi53ZWJDb250ZW50cy5zZW5kKCdicmlkZ2U6aG9zdC1zdGF0ZScsIGJyaWRnZS5ob3N0U3RhdGUsIHsgcmVzdGFydENvdW50OiAwIH0pO1xyXG4gICAgICB9XHJcbiAgICB9KTtcclxuICAgIHJldHVybiB3aW47XHJcbiAgfVxyXG5cclxuICBhcHAud2hlblJlYWR5KCkudGhlbigoKSA9PiB7XHJcbiAgICAvLyBVSVZFUklGWTpmYWtlIFx1NkEyMVx1NUYwRlx1OUE4Q1x1NjUzNlx1OTg3Qlx1NTcyOCBzdGFydEhvc3QgXHU4QkZCIGVudiBcdTRFNEJcdTUyNERcdTVGM0FcdTUyMzYgZmFrZTtWSVNSRUcoXHU4OUM2XHU4OUM5XHU1NkRFXHU1RjUyKVx1NTQwQ1x1ODlDNFx1NTIxOVxyXG4gICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1ZJU1JFRyA9PT0gJzEnIHx8IChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWSA9PT0gJzEnICYmIHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX01PREUgIT09ICdyZWFsJykpIHtcclxuICAgICAgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfRkFLRSA9ICcxJztcclxuICAgIH1cclxuICAgIC8vIFdpbmRvd3MgXHU5MDFBXHU3N0U1XHU1RjUyXHU1QzVFKFx1NTQyNlx1NTIxOVx1NjYzRVx1NzkzQVx1NEUzQSBlbGVjdHJvbi5leGUpXHJcbiAgICBhcHAuc2V0QXBwVXNlck1vZGVsSWQoJ2Rldi5obWguZGVza3RvcCcpO1xyXG4gICAgc2V0dXBUcmF5KCk7XHJcbiAgICBidWlsZEFwcE1lbnUoKTtcclxuICAgIC8vIFx1NTQyRlx1NTJBOCAzMHMgXHU1NDBFXHU5NzU5XHU5RUQ4XHU2OEMwXHU2N0U1XHU2NkY0XHU2NUIwKFx1NjcwOVx1NjVCMFx1NzI0OFx1NEVDNVx1NTQwRVx1NTNGMFx1NEUwQlx1OEY3RCxcdTRFMERcdTYyNTNcdTYyNzA7XHU3NTI4XHU2MjM3XHU3RUNGIFx1MjYzMCBcdTgzRENcdTUzNTVcdTUxQjNcdTVCOUFcdTg4QzUpXHJcbiAgICBpZiAoYXBwLmlzUGFja2FnZWQpIHNldFRpbWVvdXQoKCkgPT4geyB2b2lkIGNoZWNrRm9yVXBkYXRlcygpOyB9LCAzMF8wMDApO1xyXG4gICAgLy8gQ1NQKGRldiBcdTRFMEUgcHJvZCBcdTRFMERcdTU0MEM7cHJvZCBcdTRFMERcdTUxNDFcdThCQjhcdTRFRkJcdTRGNTVcdThGRENcdTdBMEJcdTZFOTApXHJcbiAgICBjb25zdCBjc3AgPSBpc0RldlxyXG4gICAgICA/IFtcclxuICAgICAgICAgIFwiZGVmYXVsdC1zcmMgJ3NlbGYnXCIsXHJcbiAgICAgICAgICBgc2NyaXB0LXNyYyAnc2VsZicgJHtyZW5kZXJlckRldlVybH1gLFxyXG4gICAgICAgICAgXCJzdHlsZS1zcmMgJ3NlbGYnICd1bnNhZmUtaW5saW5lJ1wiLFxyXG4gICAgICAgICAgYGNvbm5lY3Qtc3JjICdzZWxmJyAke3JlbmRlcmVyRGV2VXJsfSB3czovLzEyNy4wLjAuMToqYCxcclxuICAgICAgICAgIFwiaW1nLXNyYyAnc2VsZicgZGF0YTpcIixcclxuICAgICAgICAgIFwiZm9udC1zcmMgJ3NlbGYnIGRhdGE6XCIsXHJcbiAgICAgICAgXS5qb2luKCc7ICcpXHJcbiAgICAgIDogXCJkZWZhdWx0LXNyYyAnc2VsZic7IHNjcmlwdC1zcmMgJ3NlbGYnOyBzdHlsZS1zcmMgJ3NlbGYnICd1bnNhZmUtaW5saW5lJzsgaW1nLXNyYyAnc2VsZicgZGF0YTo7IGZvbnQtc3JjICdzZWxmJyBkYXRhOlwiO1xyXG4gICAgc2Vzc2lvbi5kZWZhdWx0U2Vzc2lvbi53ZWJSZXF1ZXN0Lm9uSGVhZGVyc1JlY2VpdmVkKChkZXRhaWxzLCBjYWxsYmFjaykgPT4ge1xyXG4gICAgICBjYWxsYmFjayh7XHJcbiAgICAgICAgcmVzcG9uc2VIZWFkZXJzOiB7XHJcbiAgICAgICAgICAuLi5kZXRhaWxzLnJlc3BvbnNlSGVhZGVycyxcclxuICAgICAgICAgICdDb250ZW50LVNlY3VyaXR5LVBvbGljeSc6IFtjc3BdLFxyXG4gICAgICAgIH0sXHJcbiAgICAgIH0pO1xyXG4gICAgfSk7XHJcblxyXG4gICAgcmVnaXN0ZXJJcGMoKTtcclxuICAgIC8vIGNyZWF0ZVdpbmRvdyBcdTY2MkYgYXN5bmMoYm91bmRzIFx1NjA2Mlx1NTkwRCk7XHU1Qjg5XHU1MTY4XHU4MUVBXHU2RDRCL1x1NkUzMlx1NjdEM1x1ODFFQVx1NjhDMFx1NTcyOFx1N0E5N1x1NTNFM1x1NUMzMVx1N0VFQVx1NTQwRVx1NjMwMlx1OEY3RFxyXG4gICAgdm9pZCBjcmVhdGVXaW5kb3coKS50aGVuKCh3aW4pID0+IHtcclxuICAgICAgaWYgKHdpbiA9PT0gbnVsbCkgcmV0dXJuO1xyXG4gICAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRlkgPT09ICcxJykgYXR0YWNoVWlWZXJpZnkod2luKTtcclxuICAgICAgLy8gXHU4OUM2XHU4OUM5XHU1NkRFXHU1RjUyXHU2MjJBXHU1NkZFXHU5NEE5XHU1QjUwOkhNSF9ERVNLVE9QX1ZJU1JFRz0xLFx1Nzg2RVx1NUI5QVx1NjAyN1x1ODlDNlx1NTNFM1x1NjIyQVx1NTZGRVx1NTQwRVx1OTAwMFx1NTFGQShzY3JpcHRzL3Zpc3VhbC1yZWdyZXNzaW9uLm1qcyBcdTlBNzFcdTUyQTgpXHJcbiAgICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9WSVNSRUcgPT09ICcxJykgYXR0YWNoVmlzdWFsUmVncmVzc2lvbih3aW4pO1xyXG4gICAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfU0VDVVJJVFlfVEVTVCA9PT0gJzEnKSB7XHJcbiAgICAgICAgd2luLndlYkNvbnRlbnRzLm9uY2UoJ2RpZC1maW5pc2gtbG9hZCcsICgpID0+IHtcclxuICAgICAgICAgIHZvaWQgc2VjdXJpdHlTZWxmVGVzdCh3aW4pO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICB9XHJcbiAgICAgIC8vIFVJIFx1NjIyQVx1NTZGRVx1OTRBOVx1NUI1MDpITUhfREVTS1RPUF9TTkFQU0hPVD08ZmlsZS5wbmc+IFx1NTcyOFx1NzU0Q1x1OTc2Mlx1NUMzMVx1N0VFQVx1NTQwRVx1NjIyQVx1NTZGRVx1OTAwMFx1NTFGQVxyXG4gICAgICAvLyAoXHU4OEM1XHU2NzNBXHU4QkNBXHU2NUFEXHU3NTI4Olx1NEVCMlx1NzczQ1x1NzcwQlx1NkUzMlx1NjdEM1x1N0VEM1x1Njc5QyxcdTgwMENcdTRFMERcdTY2MkZcdTUzRUFcdTY1NzAgcm9vdCBcdTVCNTBcdTgyODJcdTcwQjkpXHUzMDAyXHJcbiAgICAgIGNvbnN0IHNuYXAgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9TTkFQU0hPVDtcclxuICAgICAgaWYgKHNuYXAgIT09IHVuZGVmaW5lZCAmJiBzbmFwICE9PSAnJykge1xyXG4gICAgICAgIHdpbi53ZWJDb250ZW50cy5vbmNlKCdkaWQtZmluaXNoLWxvYWQnLCAoKSA9PiB7XHJcbiAgICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHtcclxuICAgICAgICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBpbWcgPSBhd2FpdCB3aW4ud2ViQ29udGVudHMuY2FwdHVyZVBhZ2UoKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHsgd3JpdGVGaWxlOiB3ZiB9ID0gYXdhaXQgaW1wb3J0KCdub2RlOmZzL3Byb21pc2VzJyk7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCB3ZihzbmFwLCBpbWcudG9QTkcoKSk7XHJcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgU05BUFNIT1Qgb2sgJHtzbmFwfSAke2ltZy5nZXRTaXplKCkud2lkdGh9eCR7aW1nLmdldFNpemUoKS5oZWlnaHR9YCk7XHJcbiAgICAgICAgICAgICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgU05BUFNIT1QgZXJyb3IgJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApfWApO1xyXG4gICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICBjb25zdCBhcHAyID0gYXBwO1xyXG4gICAgICAgICAgICAgIHNldFRpbWVvdXQoKCkgPT4gYXBwMi5leGl0KDApLCA1MDApO1xyXG4gICAgICAgICAgICB9KSgpO1xyXG4gICAgICAgICAgfSwgTnVtYmVyKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NOQVBTSE9UX0RFTEFZX01TID8/IDEyXzAwMCkpO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICB9XHJcbiAgICAgIC8vIERPTSBcdTdFRDNcdTY3ODRcdTYzQTJcdTk0ODg6SE1IX0RFU0tUT1BfRE9NUFJPQkU9MSBcdThGOTNcdTUxRkFcdTUxNzNcdTk1MkVcdTUxNDNcdTdEMjBcdTc2ODQgYm94L2Rpc3BsYXkvY2hpbGRyZW4sXHJcbiAgICAgIC8vIFx1NTE4RFx1OTAwMFx1NTFGQShcdThCQ0FcdTY1QURcIlJlYWN0IFx1NjMwMlx1OEY3RFx1NEU4Nlx1NEY0Nlx1NjdEMFx1NTc1NyBVSSBcdTRFMERcdTUzRUZcdTg5QzFcIlx1OEZEOVx1N0M3Qlx1OTVFRVx1OTg5ODtcdTYyMkFcdTU2RkVcdTRFNEJcdTU5MTZcdTc2ODRcdTc4NkNcdThCQzFcdTYzNkUpXHUzMDAyXHJcbiAgICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9ET01QUk9CRSA9PT0gJzEnKSB7XHJcbiAgICAgICAgd2luLndlYkNvbnRlbnRzLm9uY2UoJ2RpZC1maW5pc2gtbG9hZCcsICgpID0+IHtcclxuICAgICAgICAgIHNldFRpbWVvdXQoKCkgPT4ge1xyXG4gICAgICAgICAgICB2b2lkIChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHIgPSAoYXdhaXQgd2luLndlYkNvbnRlbnRzLmV4ZWN1dGVKYXZhU2NyaXB0KGAoZnVuY3Rpb24oKXtcclxuICAgICAgICAgICAgICAgICAgdmFyIHBpY2sgPSBmdW5jdGlvbihzZWwpe1xyXG4gICAgICAgICAgICAgICAgICAgIHZhciBlbHMgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKHNlbCk7XHJcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGVscywgMCwgNCkubWFwKGZ1bmN0aW9uKGVsKXtcclxuICAgICAgICAgICAgICAgICAgICAgIHZhciBjcyA9IGdldENvbXB1dGVkU3R5bGUoZWwpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgdmFyIGIgPSBlbC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcclxuICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB7IGNsczogKGVsLmNsYXNzTmFtZXx8JycpLnRvU3RyaW5nKCkuc2xpY2UoMCw4MCksIHRhZzogZWwudGFnTmFtZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgZGlzcGxheTogY3MuZGlzcGxheSwgdmlzOiBjcy52aXNpYmlsaXR5LCBvcGFjaXR5OiBjcy5vcGFjaXR5LFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBwb3M6IGNzLnBvc2l0aW9uLCB6OiBjcy56SW5kZXgsIG92ZXJmbG93OiBjcy5vdmVyZmxvdyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgeDogTWF0aC5yb3VuZChiLngpLCB5OiBNYXRoLnJvdW5kKGIueSksIHc6IE1hdGgucm91bmQoYi53aWR0aCksIGg6IE1hdGgucm91bmQoYi5oZWlnaHQpLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB0ZXh0OiAoZWwuaW5uZXJUZXh0fHwnJykucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDYwKSB9O1xyXG4gICAgICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgICB9O1xyXG4gICAgICAgICAgICAgICAgICB2YXIgc2VscyA9IFsnaHRtbCcsJ2JvZHknLCcjcm9vdCcsJy5hcHAtc2hlbGwnLCcuc2lkZWJhcicsJy53b3Jrc3BhY2UnLCcudG9wYmFyJywnLnN0cmVhbScsJy5lbXB0eS1oaW50JywnLmNvbXBvc2VyJywnLmNvbXBvc2VyLXJvdycsJy5jb21wb3NlciB0ZXh0YXJlYScsJy5jb21wb3Nlci1zaWRlJywnLmF0dC1waWNrZXInLCcuYXR0LWNoaXBzJywnLnNpZGVwYW5lbCcsJy5ydW50aW1lLWd1aWRlJywnLm92ZXJsYXknLCcudHVybicsJy5jYXJkJ107XHJcbiAgICAgICAgICAgICAgICAgIHZhciBvdXQgPSB7fTtcclxuICAgICAgICAgICAgICAgICAgc2Vscy5mb3JFYWNoKGZ1bmN0aW9uKHMpeyB0cnkgeyBvdXRbc10gPSBwaWNrKHMpOyB9IGNhdGNoKGUpeyBvdXRbc10gPSBbe2VycjogU3RyaW5nKGUpLnNsaWNlKDAsODApfV07IH0gfSk7XHJcbiAgICAgICAgICAgICAgICAgIG91dC5fX21ldGEgPSB7XHJcbiAgICAgICAgICAgICAgICAgICAgc3R5bGVTaGVldHM6IGRvY3VtZW50LnN0eWxlU2hlZXRzLmxlbmd0aCxcclxuICAgICAgICAgICAgICAgICAgICBzaGVldDBydWxlczogKGRvY3VtZW50LnN0eWxlU2hlZXRzWzBdICYmIGRvY3VtZW50LnN0eWxlU2hlZXRzWzBdLmNzc1J1bGVzKSA/IGRvY3VtZW50LnN0eWxlU2hlZXRzWzBdLmNzc1J1bGVzLmxlbmd0aCA6IC0xLFxyXG4gICAgICAgICAgICAgICAgICAgIHJvb3RDaGlsZHJlbjogZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Jvb3QnKSA/IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyb290JykuY2hpbGRyZW4ubGVuZ3RoIDogLTEsXHJcbiAgICAgICAgICAgICAgICAgICAgYm9keUNoaWxkcmVuOiBkb2N1bWVudC5ib2R5LmNoaWxkcmVuLmxlbmd0aCxcclxuICAgICAgICAgICAgICAgICAgICBpbm5lckhUTUxMZW46IGRvY3VtZW50LmJvZHkuaW5uZXJIVE1MLmxlbmd0aCxcclxuICAgICAgICAgICAgICAgICAgICB2aWV3cG9ydDogd2luZG93LmlubmVyV2lkdGggKyAneCcgKyB3aW5kb3cuaW5uZXJIZWlnaHRcclxuICAgICAgICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KG91dCk7XHJcbiAgICAgICAgICAgICAgICB9KSgpYCwgdHJ1ZSkpIGFzIHN0cmluZztcclxuICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBET01QUk9CRSAke3J9YCk7XHJcbiAgICAgICAgICAgICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgRE9NUFJPQkUgZXJyb3IgJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAyMDApfWApO1xyXG4gICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICBhcHAuZXhpdCgwKTtcclxuICAgICAgICAgICAgfSkoKTtcclxuICAgICAgICAgIH0sIE51bWJlcihwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9ET01QUk9CRV9ERUxBWV9NUyA/PyA5XzAwMCkpO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICB9XHJcbiAgICAgIC8vIFx1NkUzMlx1NjdEM1x1ODFFQVx1NjhDMCgyMDI2LTEwLTEwIFx1ODhDNVx1NjczQVx1OUVEMVx1NUM0Rlx1NjU1OVx1OEJBRDpicmlkZ2UgcmVhZHkgXHUyMjYwIFx1NzU0Q1x1OTc2Mlx1NkUzMlx1NjdEM1x1NEU4NilcdTMwMDJcclxuICAgICAgLy8gI3Jvb3QgXHU1NzI4IFJlYWN0IFx1NjMwMlx1OEY3RFx1NTQwRVx1NUZDNVx1NjcwOVx1NUI1MFx1ODI4Mlx1NzBCOTtcdTdBN0EgPSBcdThENDRcdTZFOTBcdThERUZcdTVGODQvQ1NQL1x1ODExQVx1NjcyQ1x1NTJBMFx1OEY3RFx1NTc0Rlx1NEU4Nlx1MzAwMlxyXG4gICAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfUkVOREVSX1RFU1QgPT09ICcxJykge1xyXG4gICAgICAgIHdpbi53ZWJDb250ZW50cy5vbmNlKCdkaWQtZmluaXNoLWxvYWQnLCAoKSA9PiB7XHJcbiAgICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHtcclxuICAgICAgICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBuID0gKGF3YWl0IHdpbi53ZWJDb250ZW50cy5leGVjdXRlSmF2YVNjcmlwdChcclxuICAgICAgICAgICAgICAgICAgJ2RvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwicm9vdFwiKSA/IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwicm9vdFwiKS5jaGlsZHJlbi5sZW5ndGggOiAtMScsIHRydWUsXHJcbiAgICAgICAgICAgICAgICApKSBhcyBudW1iZXI7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBvayA9IG4gPiAwO1xyXG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYFJFTkRFUi1URVNUICR7b2sgPyAnb2snIDogJ0VNUFRZJ30gcm9vdENoaWxkcmVuPSR7bn1gKTtcclxuICAgICAgICAgICAgICAgIGFwcC5leGl0KG9rID8gMCA6IDEpO1xyXG4gICAgICAgICAgICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYFJFTkRFUi1URVNUIEVSUk9SICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTIwKX1gKTtcclxuICAgICAgICAgICAgICAgIGFwcC5leGl0KDEpO1xyXG4gICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfSkoKTtcclxuICAgICAgICAgIH0sIDJfNTAwKTtcclxuICAgICAgICB9KTtcclxuICAgICAgfVxyXG4gICAgfSk7XHJcbiAgICB2b2lkIHN0YXJ0SG9zdCgpO1xyXG5cclxuICAgIGFwcC5vbignYWN0aXZhdGUnLCAoKSA9PiB7XHJcbiAgICAgIGlmIChCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5sZW5ndGggPT09IDApIHZvaWQgY3JlYXRlV2luZG93KCk7XHJcbiAgICB9KTtcclxuICB9KTtcclxuXHJcbiAgYXN5bmMgZnVuY3Rpb24gc2VjdXJpdHlTZWxmVGVzdCh3aW46IEJyb3dzZXJXaW5kb3cpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IHJlc3VsdHM6IEFycmF5PFtzdHJpbmcsIGJvb2xlYW4sIHN0cmluZ10+ID0gW107XHJcbiAgICBjb25zdCBjaGVjayA9IGFzeW5jIChuYW1lOiBzdHJpbmcsIHByb2JlOiAoKSA9PiBQcm9taXNlPFtib29sZWFuLCBzdHJpbmddPik6IFByb21pc2U8dm9pZD4gPT4ge1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IFtvaywgZGV0YWlsXSA9IGF3YWl0IHByb2JlKCk7XHJcbiAgICAgICAgcmVzdWx0cy5wdXNoKFtuYW1lLCBvaywgZGV0YWlsXSk7XHJcbiAgICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICAgIHJlc3VsdHMucHVzaChbbmFtZSwgZmFsc2UsIFN0cmluZyhlcnIpLnNsaWNlKDAsIDEyMCldKTtcclxuICAgICAgfVxyXG4gICAgfTtcclxuICAgIGNvbnN0IGpzID0gKGNvZGU6IHN0cmluZyk6IFByb21pc2U8dW5rbm93bj4gPT4gd2luLndlYkNvbnRlbnRzLmV4ZWN1dGVKYXZhU2NyaXB0KGNvZGUsIHRydWUpO1xyXG5cclxuICAgIGF3YWl0IGNoZWNrKCdyZW5kZXJlciBcdTY1RTBcdTUzRUZcdTc1MjhcdTc2ODQgcHJvY2Vzcy9yZXF1aXJlKHNhbmRib3ggXHU3NTFGXHU2NTQ4KScsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgciA9IChhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XHJcbiAgICAgICAgdmFyIHQgPSBmdW5jdGlvbihmKXsgdHJ5IHsgdmFyIHYgPSBmKCk7IHJldHVybiAodiA9PT0gdW5kZWZpbmVkIHx8IHYgPT09IG51bGwpID8gJ3VuYXZhaWxhYmxlJyA6IHR5cGVvZiB2OyB9IGNhdGNoKGUpeyByZXR1cm4gJ2Jsb2NrZWQnOyB9IH07XHJcbiAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KFt0KGZ1bmN0aW9uKCl7cmV0dXJuIHByb2Nlc3N9KSwgdChmdW5jdGlvbigpe3JldHVybiByZXF1aXJlfSksIHQoZnVuY3Rpb24oKXtyZXR1cm4gZ2xvYmFsVGhpcy5wcm9jZXNzfSldKTtcclxuICAgICAgfSkoKWApKSBhcyBzdHJpbmc7XHJcbiAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocikgYXMgc3RyaW5nW107XHJcbiAgICAgIGNvbnN0IHAgPSBwYXJzZWRbMF0gPz8gJ3Vua25vd24nO1xyXG4gICAgICBjb25zdCByZXEgPSBwYXJzZWRbMV0gPz8gJ3Vua25vd24nO1xyXG4gICAgICBjb25zdCBzYWZlID0gKHY6IHN0cmluZyk6IGJvb2xlYW4gPT4gdiA9PT0gJ3VuYXZhaWxhYmxlJyB8fCB2ID09PSAnYmxvY2tlZCc7XHJcbiAgICAgIHJldHVybiBbc2FmZShwKSAmJiBzYWZlKHJlcSksIGBwcm9jZXNzPSR7cH0gcmVxdWlyZT0ke3JlcX1gXTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgY2hlY2soJ3dpbmRvdy5obWggXHU1M0VBXHU2NzA5XHU3NjdEXHU1NDBEXHU1MzU1XHU2NUI5XHU2Q0Q1KFx1NjVFMCBpcGNSZW5kZXJlci9cdTk4OURcdTU5MTZcdTk3NjIpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKCdPYmplY3Qua2V5cyh3aW5kb3cuaG1oIHx8IHt9KS5zb3J0KCkuam9pbihcIixcIiknKSkgYXMgc3RyaW5nO1xyXG4gICAgICBjb25zdCBhbGxvdyA9IFsnYXBwbHlVcGRhdGUnLCAnYXBwcm92ZScsICdhcHByb3ZhbEdldCcsICdhcHByb3ZhbFNldCcsICdicm93c2VSdW50aW1lJywgJ2NoZWNrVXBkYXRlJywgJ2Nocm9tZVRoZW1lJywgJ2NvZ25pdGl2ZScsICdkZXRlY3RSdW50aW1lJywgJ2RpZmYnLCAnZXhwb3J0U2Vzc2lvbicsICdmc0xpc3QnLCAnZnNSZWFkJywgJ2ZzU2VhcmNoJywgJ2dldFN0YXRlJywgJ2dldFdpemFyZCcsICdpbmplY3QnLCAnaW5zdGFsbENsaScsICdpbnRlcnJ1cHQnLCAnbW9kZWxTZXQnLCAnb25FdmVudEJhdGNoZXMnLCAnb25Ib3N0U3RhdGUnLCAnb25JbnN0YWxsUHJvZ3Jlc3MnLCAnb25NZW51QWN0aW9uJywgJ29uU3RyZWFtQ2h1bmtzJywgJ29uVXBkYXRlU3RhdGUnLCAncGlja0RpcmVjdG9yeScsICdwaWNrRmlsZXMnLCAncG9wdXBNYWluTWVudScsICdwcm92aWRlclNhdmUnLCAncHJvdmlkZXJzJywgJ3JlbW90ZVdlYkF1dG9zdGFydCcsICdyZW1vdGVXZWJTdGFydCcsICdyZW1vdGVXZWJTdGF0dXMnLCAncmVtb3RlV2ViU3RvcCcsICdydW50aW1lSW5mbycsICdzZW5kVGFzaycsICdzZXNzaW9uT3AnLCAnc2Vzc2lvblByZXZpZXcnLCAnc2Vzc2lvbnMnLCAnc2V0UnVudGltZScsICdzdG9wSG9zdCcsICd3aXphcmRDb21wbGV0ZScsICd3b3Jrc3BhY2VzJywgJ3dvcmtzcGFjZUFkZCcsICd3b3Jrc3BhY2VVc2UnXTtcclxuICAgICAgY29uc3QgZ290ID0gciA9PT0gJycgPyBbXSA6IHIuc3BsaXQoJywnKTtcclxuICAgICAgY29uc3QgdW5leHBlY3RlZCA9IGdvdC5maWx0ZXIoKGspID0+ICFhbGxvdy5pbmNsdWRlcyhrKSk7XHJcbiAgICAgIHJldHVybiBbdW5leHBlY3RlZC5sZW5ndGggPT09IDAsIGBrZXlzPSR7cn1gXTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgY2hlY2soJ1x1NTkxNlx1OTBFOFx1NUJGQ1x1ODIyQVx1ODhBQlx1NjJFNlx1NjIyQShVUkwgXHU0RTBEXHU1M0Q4KScsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgYmVmb3JlID0gd2luLndlYkNvbnRlbnRzLmdldFVSTCgpO1xyXG4gICAgICBhd2FpdCBqcygnbG9jYXRpb24uaHJlZiA9IFwiaHR0cHM6Ly9leGFtcGxlLmludmFsaWQveFwiOyBcIm5vb3BcIicpLmNhdGNoKCgpID0+ICdub29wJyk7XHJcbiAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyMikgPT4gc2V0VGltZW91dChyMiwgMV8yMDApKTtcclxuICAgICAgY29uc3QgYWZ0ZXIgPSB3aW4ud2ViQ29udGVudHMuZ2V0VVJMKCk7XHJcbiAgICAgIHJldHVybiBbYWZ0ZXIgPT09IGJlZm9yZSwgYCR7YmVmb3JlfSBcdTIxOTIgJHthZnRlcn1gXTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgY2hlY2soJ3dpbmRvdy5vcGVuIFx1ODhBQlx1NjJEMlx1N0VERChcdThGRDRcdTU2REUgbnVsbCBcdTRFMTRcdTY1RTBcdTY1QjBcdTdBOTdcdTUzRTMpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCBiZWZvcmUgPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5sZW5ndGg7XHJcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoJ1N0cmluZyh3aW5kb3cub3BlbihcImh0dHBzOi8vZXhhbXBsZS5pbnZhbGlkXCIpKScpKSBhcyBzdHJpbmc7XHJcbiAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyMikgPT4gc2V0VGltZW91dChyMiwgNDAwKSk7XHJcbiAgICAgIGNvbnN0IGFmdGVyID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkubGVuZ3RoO1xyXG4gICAgICByZXR1cm4gW3IgPT09ICdudWxsJyAmJiBhZnRlciA9PT0gYmVmb3JlLCBgb3BlbigpPSR7cn0gd2luZG93cz0ke2JlZm9yZX1cdTIxOTIke2FmdGVyfWBdO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBjaGVjaygnQ1NQIFx1NUI1OFx1NTcyOChtZXRhIFx1NkNFOFx1NTE2NVx1NjIxNlx1NTRDRFx1NUU5NFx1NTkzNCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IG1ldGEgPSAoYXdhaXQganMoJ0Jvb2xlYW4oZG9jdW1lbnQucXVlcnlTZWxlY3RvcihcIm1ldGFbaHR0cC1lcXVpdj1cXCdDb250ZW50LVNlY3VyaXR5LVBvbGljeVxcJ11cIikpJykpIGFzIGJvb2xlYW47XHJcbiAgICAgIGNvbnN0IGhlYWRlckNzcCA9IGlzRGV2ID8gJ2RldjogaGVhZGVyIENTUCBcdTc1MzEgb25IZWFkZXJzUmVjZWl2ZWQgXHU2Q0U4XHU1MTY1KFx1NEUwRFx1OTAwMlx1NzUyOCBtZXRhIFx1NjVBRFx1OEEwMCknIDogJ3Byb2QnO1xyXG4gICAgICByZXR1cm4gW21ldGEgfHwgaXNEZXYsIGBtZXRhPSR7bWV0YX0gJHtoZWFkZXJDc3B9YF07XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IGNoZWNrKCdicmlkZ2U6Z2V0LXN0YXRlIFx1NkI2M1x1NUUzOFx1OEZENFx1NTZERShob3N0IFx1Njg2NVx1NTNFRlx1NzUyOCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoJ3dpbmRvdy5obWguZ2V0U3RhdGUoKS50aGVuKHMgPT4gSlNPTi5zdHJpbmdpZnkocykpLmNhdGNoKGUgPT4gXCJFUlI6XCIrZSknKSkgYXMgc3RyaW5nO1xyXG4gICAgICByZXR1cm4gW3Iuc3RhcnRzV2l0aCgneycpICYmIHIuaW5jbHVkZXMoJ2hvc3RTdGF0ZScpLCByLnNsaWNlKDAsIDgwKV07XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IGNoZWNrKCdYU1M6XHU2MDc2XHU2MTBGXHU0RUZCXHU1MkExXHU2NTg3XHU2NzJDXHU1M0VBXHU0RUU1XHU2NTg3XHU2NzJDXHU2RTMyXHU2N0QzKFx1NEUwRFx1NjI2N1x1ODg0QyknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHBheWxvYWQgPSAnPGltZyBzcmM9eCBvbmVycm9yPVwid2luZG93Ll9feHNzPTFcIj48c2NyaXB0PndpbmRvdy5fX3hzcz0yPFxcL3NjcmlwdD5cIiZcXCcnO1xyXG4gICAgICBjb25zdCBzZW5kUiA9IChhd2FpdCBqcyhgd2luZG93LmhtaC5zZW5kVGFzaygke0pTT04uc3RyaW5naWZ5KHBheWxvYWQpfSwgJ3NlYy14c3MtMScsICdhdXRvJykudGhlbihyPT5KU09OLnN0cmluZ2lmeShyKSkuY2F0Y2goZT0+J0VSUjonK2UpYCkpIGFzIHN0cmluZztcclxuICAgICAgaWYgKCFzZW5kUi5pbmNsdWRlcygnXCJva1wiOnRydWUnKSkgcmV0dXJuIFtmYWxzZSwgYHNlbmRUYXNrIFx1NjcyQVx1NTNEN1x1NzQwNjogJHtzZW5kUi5zbGljZSgwLCA4MCl9YF07XHJcbiAgICAgIC8vIGZha2UgaG9zdCBlY2hvIFx1NTZERVx1Njc2NVx1NTQwRVx1N0VDRiBSZWFjdCBcdTZFMzJcdTY3RDMoXHU3NTI4XHU2MjM3XHU2RDg4XHU2MDZGICsgXHU1MkE5XHU2MjRCIGVjaG8gXHU1M0NDXHU4REVGXHU1Rjg0KVxyXG4gICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocjIpID0+IHNldFRpbWVvdXQocjIsIDNfMDAwKSk7XHJcbiAgICAgIGNvbnN0IHByb2JlID0gKGF3YWl0IGpzKGBKU09OLnN0cmluZ2lmeSh7XHJcbiAgICAgICAgeHNzRmxhZzogdHlwZW9mIHdpbmRvdy5fX3hzcyxcclxuICAgICAgICBpbWdDb3VudDogZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnaW1nW3NyYz1cInhcIl0nKS5sZW5ndGgsXHJcbiAgICAgICAgc2NyaXB0UmFuOiBkb2N1bWVudC5ib2R5LmlubmVyVGV4dC5pbmRleE9mKCd3aW5kb3cuX194c3M9MicpID49IDBcclxuICAgICAgfSlgKSkgYXMgc3RyaW5nO1xyXG4gICAgICBjb25zdCBwID0gSlNPTi5wYXJzZShwcm9iZSkgYXMgeyB4c3NGbGFnOiBzdHJpbmc7IGltZ0NvdW50OiBudW1iZXI7IHNjcmlwdFJhbjogYm9vbGVhbiB9O1xyXG4gICAgICByZXR1cm4gW3AueHNzRmxhZyA9PT0gJ3VuZGVmaW5lZCcgJiYgcC5pbWdDb3VudCA9PT0gMCwgYHhzc0ZsYWc9JHtwLnhzc0ZsYWd9IGltZz0ke3AuaW1nQ291bnR9YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICBsZXQgZmFpbGVkID0gMDtcclxuICAgIGZvciAoY29uc3QgW25hbWUsIG9rLCBkZXRhaWxdIG9mIHJlc3VsdHMpIHtcclxuICAgICAgY29uc29sZS5sb2coYFNFQ1VSSVRZLVRFU1QgJHtvayA/ICdQQVNTJyA6ICdGQUlMJ30gfCAke25hbWV9IHwgJHtyZWRhY3QoZGV0YWlsKX1gKTtcclxuICAgICAgaWYgKCFvaykgZmFpbGVkICs9IDE7XHJcbiAgICB9XHJcbiAgICBjb25zb2xlLmxvZyhgU0VDVVJJVFktVEVTVCBTVU1NQVJZIHBhc3M9JHtyZXN1bHRzLmxlbmd0aCAtIGZhaWxlZH0vJHtyZXN1bHRzLmxlbmd0aH1gKTtcclxuICAgIGFwcC5leGl0KGZhaWxlZCA9PT0gMCA/IDAgOiAxKTtcclxuICB9XHJcblxyXG4gIC8vIFx1OTAwMFx1NTFGQTpcdTRGMThcdTk2QzVcdTUwNUNcdTZCNjJcdTgxRUFcdTVERjEgc3Bhd24gXHU3Njg0IGhvc3Qoc2h1dGRvd24gXHU3QUVGXHU3MEI5IFx1MjE5MiBcdTUxNUNcdTVFOTVcdTUzRUEga2lsbCBcdTgxRUFcdTVERjFcdTc2ODRcdTUzRTVcdTY3QzQpXHJcbiAgYXBwLm9uKCdiZWZvcmUtcXVpdCcsIChlKSA9PiB7XHJcbiAgICBpZiAoc3VwZXJ2aXNvciAhPT0gbnVsbCAmJiBzdXBlcnZpc29yLnN0YXRlICE9PSAnc3RvcHBlZCcpIHtcclxuICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xyXG4gICAgICBzc2VBYm9ydD8uYWJvcnQoKTtcclxuICAgICAgdm9pZCBzdXBlcnZpc29yLnN0b3AoKS5maW5hbGx5KCgpID0+IGFwcC5xdWl0KCkpO1xyXG4gICAgfVxyXG4gIH0pO1xyXG4gIGFwcC5vbignd2luZG93LWFsbC1jbG9zZWQnLCAoKSA9PiB7XHJcbiAgICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSAhPT0gJ2RhcndpbicpIGFwcC5xdWl0KCk7XHJcbiAgfSk7XHJcbn1cclxuIiwgIi8qKlxyXG4gKiBEZXNrdG9wUnVudGltZVN1cGVydmlzb3IgXHUyMDE0IGhtaGFybmVzcyBob3N0IFx1OEZEQlx1N0EwQlx1NzY4NFx1NzUxRlx1NTQ3RFx1NTQ2OFx1NjcxRlx1NzJCNlx1NjAwMVx1NjczQShBRFItMDAzKVx1MzAwMlxyXG4gKlxyXG4gKiBcdTVCODlcdTUxNjhcdTRFMERcdTUzRDhcdTkxQ0Y6XHJcbiAqICAtIFx1NTNFQVx1N0VEMVx1NUI5QS9cdTYzQTJcdTZENEIgMTI3LjAuMC4xO2hvc3QgXHU0RjdGXHU3NTI4XHU2NENEXHU0RjVDXHU3Q0ZCXHU3RURGXHU1MjA2XHU5MTREXHU3QUVGXHU1M0UzKHBvcnQgMCksXHU1QjlFXHU5NjQ1XHU3QUVGXHU1M0UzXHJcbiAqICAgIFx1NzUzMSBob3N0IFx1NzY4NCBzdGRvdXQgXHU1RjE1XHU1QkZDXHU4ODRDXHU1NkRFXHU0RjIwKEhvc3RSZWFkeUxpbmUpXHUzMDAyXHJcbiAqICAtIFx1OUFEOFx1NzFCNSB0b2tlbiBcdTUzRUFcdTkwMUFcdThGQzdcdTVCNTBcdThGREJcdTdBMEJcdTczQUZcdTU4ODNcdTUzRDhcdTkxQ0ZcdTRGMjBcdTkwMTIsXHU3RUREXHU0RTBEXHU4RkRCIFVSTC9cdTY1RTVcdTVGRDcvSVBDIFx1NjYwRVx1NjU4N1x1OEQxRlx1OEY3RFx1MzAwMlxyXG4gKiAgLSBcdTUzRUFcdTUwNUNcdTZCNjJcdTY3MkMgc3VwZXJ2aXNvciBzcGF3biBcdTc2ODRcdThGREJcdTdBMEJcdTUzRTVcdTY3QzQ7XHU3RUREXHU0RTBEXHU2MzA5XHU4RkRCXHU3QTBCXHU1NDBEIGtpbGxcdTMwMDJcclxuICogIC0gaG9zdCBjcmFzaCBcdTU0MEVcdTY3MDlcdTk2NTBcdTkxQ0RcdTU0MkY7XHU5MUNEXHU1NDJGXHU0RTBEXHU5MUNEXHU2NTNFXHU0RUZCXHU0RjU1XHU3NTI4XHU2MjM3XHU1MkE4XHU0RjVDKFx1OTc1RVx1NUU0Mlx1N0I0OVx1NTJBOFx1NEY1Q1x1NzUzMVx1NzUyOFx1NjIzN1x1Nzg2RVx1OEJBNClcdTMwMDJcclxuICovXHJcbmltcG9ydCB7IHNwYXduLCB0eXBlIENoaWxkUHJvY2VzcyB9IGZyb20gJ25vZGU6Y2hpbGRfcHJvY2Vzcyc7XHJcbmltcG9ydCB7IGNyZWF0ZUludGVyZmFjZSB9IGZyb20gJ25vZGU6cmVhZGxpbmUnO1xyXG5pbXBvcnQgeyByYW5kb21CeXRlcyB9IGZyb20gJ25vZGU6Y3J5cHRvJztcclxuaW1wb3J0IHsgZGVza3RvcEVycm9yLCBpc0Rlc2t0b3BFcnJvciwgdHlwZSBEZXNrdG9wRXJyb3IgfSBmcm9tICdAaG1oLWRlc2t0b3AvY29udHJhY3RzJztcclxuXHJcbmV4cG9ydCB0eXBlIEhvc3RTdGF0ZSA9XHJcbiAgfCAnc3RvcHBlZCdcclxuICB8ICdzdGFydGluZydcclxuICB8ICdyZWFkeSdcclxuICB8ICdkaXNjb25uZWN0ZWQnXHJcbiAgfCAncmVzdGFydGluZydcclxuICB8ICdzdG9wcGluZydcclxuICB8ICdmYWlsZWQnO1xyXG5cclxuZXhwb3J0IGludGVyZmFjZSBIb3N0U3BlYyB7XHJcbiAgLyoqIFx1NTNFRlx1NjI2N1x1ODg0Q1x1NjU4N1x1NEVGNihcdTkwMUFcdTVFMzggcHJvY2Vzcy5leGVjUGF0aClcdTMwMDIgKi9cclxuICBjb21tYW5kOiBzdHJpbmc7XHJcbiAgYXJnczogc3RyaW5nW107XHJcbiAgY3dkPzogc3RyaW5nO1xyXG4gIC8qKiBcdTk4OURcdTU5MTZcdTczQUZcdTU4ODNcdTUzRDhcdTkxQ0YoXHU0RjFBXHU0RTBFIHByb2Nlc3MuZW52IFx1NTQwOFx1NUU3NilcdTMwMDIgKi9cclxuICBlbnY/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xyXG59XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIFN1cGVydmlzb3JPcHRpb25zIHtcclxuICAvKiogXHU2NzFGXHU2NzFCIGhvc3QgXHU2ODIxXHU5QThDXHU3Njg0IGJlYXJlciB0b2tlbjtcdTRFMERcdTRGMjBcdTUyMTlcdTZCQ0ZcdTZCMjEgc3RhcnQgXHU3NTFGXHU2MjEwXHU5QUQ4XHU3MUI1XHU5NjhGXHU2NzNBXHU1MDNDXHUzMDAyICovXHJcbiAgdG9rZW4/OiBzdHJpbmc7XHJcbiAgbWF4UmVzdGFydHM/OiBudW1iZXI7XHJcbiAgc3RhcnRUaW1lb3V0TXM/OiBudW1iZXI7XHJcbiAgZ3JhY2VmdWxTaHV0ZG93bk1zPzogbnVtYmVyO1xyXG4gIG9uU3RhdGVDaGFuZ2U/KHN0YXRlOiBIb3N0U3RhdGUsIGluZm86IHsgcmVzdGFydENvdW50OiBudW1iZXI7IGxhc3RFcnJvcj86IHN0cmluZyB9KTogdm9pZDtcclxuICAvKiogXHU2QkNGXHU2QjIxIGhvc3QgXHU1QzMxXHU3RUVBKFx1NTQyQiBjcmFzaCBcdTgxRUFcdTYxMDhcdTU0MEVcdTc2ODRcdTkxQ0RcdTU0MkYpXHU5MEZEXHU0RjFBXHU4OUU2XHU1M0QxLFx1NjQzQVx1NUUyNlx1N0FFRlx1NzBCOShcdTU0MkIgdG9rZW4sXHJcbiAgICogIFx1NEVDNVx1NEY5Qlx1NTQwQ1x1NEZFMVx1NEVGQlx1NTdERlx1NzY4NFx1NUJCRlx1NEUzQlx1OEZEQlx1N0EwQlx1OTFDRFx1NUVGQVx1Njg2NVx1NUJBMlx1NjIzN1x1N0FFRjtcdTRFMERcdTg5ODFcdThERThcdThGREIgcmVuZGVyZXIpXHUzMDAyICovXHJcbiAgb25SZWFkeT8oZW5kcG9pbnQ6IEhvc3RFbmRwb2ludCk6IHZvaWQ7XHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgSG9zdEVuZHBvaW50IHtcclxuICBwb3J0OiBudW1iZXI7XHJcbiAgdmVyc2lvbjogc3RyaW5nO1xyXG4gIHRva2VuOiBzdHJpbmc7XHJcbn1cclxuXHJcbi8qKiBIb3N0UmVhZHlMaW5lIFx1NzY4NFx1N0M3Qlx1NTc4Qlx1NUI4OFx1NTM2Qlx1NEVDRSBjb250cmFjdHMgXHU1RjE1XHU1MTY1LFx1OTA3Rlx1NTE0RFx1NTNDQ1x1NUI5RVx1NzNCMFx1MzAwMiAqL1xyXG5pbXBvcnQgeyBpc0hvc3RSZWFkeUxpbmUgfSBmcm9tICdAaG1oLWRlc2t0b3AvY29udHJhY3RzJztcclxuXHJcbi8vIDQ1czpobWhhcm5lc3MgXHU3NzFGXHU1QjlFXHU1MTY1XHU1M0UzXHU3RUNGIHRzeCBcdTUxQjdcdTdGMTZcdThCRDFcdTY1NzRcdTU5NTcgQ0xJLFx1NjczQVx1NTY2OFx1OUFEOFx1OEQxRlx1OEY3RFx1NjVGNlx1NTNFRlx1OEQ4NSAyMHNcclxuLy8gKDIwMjYtMTAtMTEgXHU4RkRFXHU3RUVEXHU5QThDXHU2NTM2XHU0RTJEXHU5NUY0XHU2QjQ3XHU2MDI3IEhPU1RfTk9UX1JFQURZIFx1NzY4NFx1NjgzOVx1NTZFMDtcdTdBN0FcdTk1RjJcdTVCOUVcdTZENEIgNnMpXHUzMDAyXHJcbmNvbnN0IERFRkFVTFRfU1RBUlRfVElNRU9VVF9NUyA9IDQ1XzAwMDtcclxuY29uc3QgREVGQVVMVF9NQVhfUkVTVEFSVFMgPSAzO1xyXG5jb25zdCBERUZBVUxUX0dSQUNFRlVMX01TID0gNV8wMDA7XHJcblxyXG5leHBvcnQgY2xhc3MgRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yIHtcclxuICBwcml2YXRlIGNoaWxkOiBDaGlsZFByb2Nlc3MgfCBudWxsID0gbnVsbDtcclxuICBwcml2YXRlIF9zdGF0ZTogSG9zdFN0YXRlID0gJ3N0b3BwZWQnO1xyXG4gIHByaXZhdGUgcmVzdGFydENvdW50ID0gMDtcclxuICBwcml2YXRlIGxhc3RFcnJvciA9ICcnO1xyXG4gIHByaXZhdGUgc3RvcHBpbmcgPSBmYWxzZTtcclxuICBwcml2YXRlIHJlYWRvbmx5IHRva2VuOiBzdHJpbmc7XHJcbiAgcHJpdmF0ZSByZWFkb25seSBvcHRzOiBSZXF1aXJlZDxQaWNrPFN1cGVydmlzb3JPcHRpb25zLCAnbWF4UmVzdGFydHMnIHwgJ3N0YXJ0VGltZW91dE1zJyB8ICdncmFjZWZ1bFNodXRkb3duTXMnPj4gJiBTdXBlcnZpc29yT3B0aW9ucztcclxuICBwcml2YXRlIGV4aXRXYWl0ZXJzOiBBcnJheTwoKSA9PiB2b2lkPiA9IFtdO1xyXG5cclxuICBjb25zdHJ1Y3RvcihcclxuICAgIHByaXZhdGUgcmVhZG9ubHkgc3BlYzogSG9zdFNwZWMsXHJcbiAgICBvcHRzOiBTdXBlcnZpc29yT3B0aW9ucyA9IHt9LFxyXG4gICkge1xyXG4gICAgdGhpcy50b2tlbiA9IG9wdHMudG9rZW4gPz8gcmFuZG9tQnl0ZXMoMzIpLnRvU3RyaW5nKCdiYXNlNjR1cmwnKTtcclxuICAgIHRoaXMub3B0cyA9IHtcclxuICAgICAgbWF4UmVzdGFydHM6IG9wdHMubWF4UmVzdGFydHMgPz8gREVGQVVMVF9NQVhfUkVTVEFSVFMsXHJcbiAgICAgIHN0YXJ0VGltZW91dE1zOiBvcHRzLnN0YXJ0VGltZW91dE1zID8/IERFRkFVTFRfU1RBUlRfVElNRU9VVF9NUyxcclxuICAgICAgZ3JhY2VmdWxTaHV0ZG93bk1zOiBvcHRzLmdyYWNlZnVsU2h1dGRvd25NcyA/PyBERUZBVUxUX0dSQUNFRlVMX01TLFxyXG4gICAgICAuLi5vcHRzLFxyXG4gICAgfTtcclxuICB9XHJcblxyXG4gIGdldCBzdGF0ZSgpOiBIb3N0U3RhdGUge1xyXG4gICAgcmV0dXJuIHRoaXMuX3N0YXRlO1xyXG4gIH1cclxuXHJcbiAgZ2V0IHJlc3RhcnRzVXNlZCgpOiBudW1iZXIge1xyXG4gICAgcmV0dXJuIHRoaXMucmVzdGFydENvdW50O1xyXG4gIH1cclxuXHJcbiAgcHJpdmF0ZSBzZXRTdGF0ZShzOiBIb3N0U3RhdGUsIGVycj86IHN0cmluZyk6IHZvaWQge1xyXG4gICAgdGhpcy5fc3RhdGUgPSBzO1xyXG4gICAgaWYgKGVyciAhPT0gdW5kZWZpbmVkKSB0aGlzLmxhc3RFcnJvciA9IGVycjtcclxuICAgIGNvbnN0IGluZm86IHsgcmVzdGFydENvdW50OiBudW1iZXI7IGxhc3RFcnJvcj86IHN0cmluZyB9ID0geyByZXN0YXJ0Q291bnQ6IHRoaXMucmVzdGFydENvdW50IH07XHJcbiAgICBpZiAodGhpcy5sYXN0RXJyb3IgIT09ICcnKSBpbmZvLmxhc3RFcnJvciA9IHRoaXMubGFzdEVycm9yO1xyXG4gICAgdGhpcy5vcHRzLm9uU3RhdGVDaGFuZ2U/LihzLCBpbmZvKTtcclxuICB9XHJcblxyXG4gIC8qKiBcdTU0MkZcdTUyQTggaG9zdCBcdTVFNzZcdTdCNDlcdTVGODUgcmVhZHkoXHU1RjE1XHU1QkZDXHU4ODRDICsgXHU1RTI2IHRva2VuIFx1NzY4NFx1NTA2NVx1NUVCN1x1NjNBMlx1NkQ0QilcdTMwMDIgKi9cclxuICBhc3luYyBzdGFydCgpOiBQcm9taXNlPEhvc3RFbmRwb2ludD4ge1xyXG4gICAgaWYgKHRoaXMuX3N0YXRlID09PSAncmVhZHknIHx8IHRoaXMuX3N0YXRlID09PSAnc3RhcnRpbmcnKSB7XHJcbiAgICAgIHRocm93IGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgc3VwZXJ2aXNvciBhbHJlYWR5ICR7dGhpcy5fc3RhdGV9YCk7XHJcbiAgICB9XHJcbiAgICB0aGlzLnJlc3RhcnRDb3VudCA9IDA7XHJcbiAgICB0aGlzLnN0b3BwaW5nID0gZmFsc2U7XHJcbiAgICByZXR1cm4gdGhpcy5sYXVuY2goKTtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgYXN5bmMgbGF1bmNoKCk6IFByb21pc2U8SG9zdEVuZHBvaW50PiB7XHJcbiAgICB0aGlzLnNldFN0YXRlKCdzdGFydGluZycpO1xyXG4gICAgY29uc3QgY2hpbGQgPSBzcGF3bih0aGlzLnNwZWMuY29tbWFuZCwgdGhpcy5zcGVjLmFyZ3MsIHtcclxuICAgICAgY3dkOiB0aGlzLnNwZWMuY3dkLFxyXG4gICAgICBlbnY6IHtcclxuICAgICAgICAuLi5wcm9jZXNzLmVudixcclxuICAgICAgICAuLi50aGlzLnNwZWMuZW52LFxyXG4gICAgICAgIEhNSF9ERVNLVE9QX1RPS0VOOiB0aGlzLnRva2VuLFxyXG4gICAgICB9LFxyXG4gICAgICBzdGRpbzogWydpZ25vcmUnLCAncGlwZScsICdwaXBlJ10sXHJcbiAgICAgIHdpbmRvd3NIaWRlOiB0cnVlLFxyXG4gICAgfSk7XHJcbiAgICB0aGlzLmNoaWxkID0gY2hpbGQ7XHJcblxyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3QgZW5kcG9pbnQgPSBhd2FpdCB0aGlzLmF3YWl0UmVhZHkoY2hpbGQpO1xyXG4gICAgICB0aGlzLmN1cnJlbnRFbmRwb2ludCA9IHsgcG9ydDogZW5kcG9pbnQucG9ydCwgdmVyc2lvbjogZW5kcG9pbnQudmVyc2lvbiB9O1xyXG4gICAgICB0aGlzLnNldFN0YXRlKCdyZWFkeScpO1xyXG4gICAgICB0aGlzLm9wdHMub25SZWFkeT8uKGVuZHBvaW50KTtcclxuICAgICAgLy8gcmVhZHkgXHU0RTRCXHU1NDBFXHU4RkRCXHU3QTBCXHU2QjdCXHU0RUExID0gXHU2MTBGXHU1OTE2XHU5MDAwXHU1MUZBIFx1MjE5MiBcdTY3MDlcdTk2NTBcdTkxQ0RcdTU0MkZcclxuICAgICAgY2hpbGQub25jZSgnZXhpdCcsICgpID0+IHtcclxuICAgICAgICB0aGlzLmV4aXRXYWl0ZXJzLmZvckVhY2goKHcpID0+IHcoKSk7XHJcbiAgICAgICAgdGhpcy5leGl0V2FpdGVycyA9IFtdO1xyXG4gICAgICAgIHRoaXMub25VbmV4cGVjdGVkRXhpdCgpO1xyXG4gICAgICB9KTtcclxuICAgICAgcmV0dXJuIGVuZHBvaW50O1xyXG4gICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgIGlmICghY2hpbGQua2lsbGVkKSBjaGlsZC5raWxsKCk7XHJcbiAgICAgIGlmICh0aGlzLmNoaWxkID09PSBjaGlsZCkgdGhpcy5jaGlsZCA9IG51bGw7XHJcbiAgICAgIHRocm93IGVycjtcclxuICAgIH1cclxuICB9XHJcblxyXG4gIC8qKiBcdTRFQ0Ugc3Rkb3V0IFx1NjI3RSBIb3N0UmVhZHlMaW5lLFx1NzEzNlx1NTQwRVx1NTA2NVx1NUVCN1x1NjNBMlx1NkQ0Qlx1MzAwMiAqL1xyXG4gIHByaXZhdGUgYXdhaXRSZWFkeShjaGlsZDogQ2hpbGRQcm9jZXNzKTogUHJvbWlzZTxIb3N0RW5kcG9pbnQ+IHtcclxuICAgIHJldHVybiBuZXcgUHJvbWlzZTxIb3N0RW5kcG9pbnQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcclxuICAgICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHtcclxuICAgICAgICByZWplY3QoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBob3N0IGRpZCBub3Qgc2lnbmFsIHJlYWR5IHdpdGhpbiAke3RoaXMub3B0cy5zdGFydFRpbWVvdXRNc31tc2AsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xyXG4gICAgICB9LCB0aGlzLm9wdHMuc3RhcnRUaW1lb3V0TXMpO1xyXG5cclxuICAgICAgY29uc3QgZG9uZSA9IChmbjogKCkgPT4gdm9pZCk6IHZvaWQgPT4ge1xyXG4gICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XHJcbiAgICAgICAgZm4oKTtcclxuICAgICAgfTtcclxuXHJcbiAgICAgIGlmICghY2hpbGQuc3Rkb3V0KSB7XHJcbiAgICAgICAgZG9uZSgoKSA9PiByZWplY3QoZGVza3RvcEVycm9yKCdSVU5USU1FX0NSQVNIRUQnLCAnaG9zdCBzcGF3bmVkIHdpdGhvdXQgc3Rkb3V0IHBpcGUnKSkpO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgICAgfVxyXG5cclxuICAgICAgY29uc3QgcmwgPSBjcmVhdGVJbnRlcmZhY2UoeyBpbnB1dDogY2hpbGQuc3Rkb3V0IH0pO1xyXG4gICAgICBjb25zdCBvbkxpbmUgPSAobGluZTogc3RyaW5nKTogdm9pZCA9PiB7XHJcbiAgICAgICAgbGV0IHBhcnNlZDogdW5rbm93bjtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgcGFyc2VkID0gSlNPTi5wYXJzZShsaW5lKTtcclxuICAgICAgICB9IGNhdGNoIHtcclxuICAgICAgICAgIHJldHVybjsgLy8gaG9zdCBcdTc2ODRcdTY2NkVcdTkwMUFcdTY1RTVcdTVGRDdcdTg4NEMsXHU1RkZEXHU3NTY1XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChpc0hvc3RSZWFkeUxpbmUocGFyc2VkKSkge1xyXG4gICAgICAgICAgcmwuY2xvc2UoKTtcclxuICAgICAgICAgIHZvaWQgdGhpcy5wcm9iZUFuZFJlbWVtYmVyKHBhcnNlZC5wb3J0LCBwYXJzZWQudmVyc2lvbilcclxuICAgICAgICAgICAgLnRoZW4oKGVuZHBvaW50KSA9PiBkb25lKCgpID0+IHJlc29sdmUoZW5kcG9pbnQpKSlcclxuICAgICAgICAgICAgLmNhdGNoKChlcnI6IHVua25vd24pID0+IGRvbmUoKCkgPT4gcmVqZWN0KGVycikpKTtcclxuICAgICAgICB9XHJcbiAgICAgIH07XHJcbiAgICAgIHJsLm9uKCdsaW5lJywgb25MaW5lKTtcclxuXHJcbiAgICAgIGNoaWxkLm9uY2UoJ2V4aXQnLCAoY29kZSkgPT4ge1xyXG4gICAgICAgIGRvbmUoKCkgPT4gcmVqZWN0KGRlc2t0b3BFcnJvcignUlVOVElNRV9DUkFTSEVEJywgYGhvc3QgZXhpdGVkIGR1cmluZyBzdGFydHVwIChjb2RlICR7Y29kZSA/PyAnbnVsbCd9KWAsIHsgcmV0cnlhYmxlOiBmYWxzZSwgcmVjb3ZlcnlBY3Rpb246ICdPUEVOX0xPR1MnIH0pKSk7XHJcbiAgICAgIH0pO1xyXG4gICAgfSk7XHJcbiAgfVxyXG5cclxuICAvKiogXHU1RTI2IHRva2VuIFx1NzY4NFx1NTA2NVx1NUVCN1x1NjNBMlx1NkQ0QjpHRVQgL2FwaS9zdGF0ZVx1MzAwMjQwMSBcdTIxOTIgQVVUSF9GQUlMRUQoXHU0RTBEXHU5MUNEXHU4QkQ1KVx1MzAwMiAqL1xyXG4gIHByaXZhdGUgYXN5bmMgcHJvYmUocG9ydDogbnVtYmVyLCB2ZXJzaW9uOiBzdHJpbmcpOiBQcm9taXNlPEhvc3RFbmRwb2ludD4ge1xyXG4gICAgbGV0IHJlczogUmVzcG9uc2U7XHJcbiAgICB0cnkge1xyXG4gICAgICByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2FwaS9zdGF0ZWAsIHtcclxuICAgICAgICBoZWFkZXJzOiB7ICd4LWhtaC1rZXknOiB0aGlzLnRva2VuIH0sXHJcbiAgICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDNfMDAwKSxcclxuICAgICAgfSk7XHJcbiAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgdGhyb3cgZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBoZWFsdGggcHJvYmUgZmFpbGVkOiAke1N0cmluZyhlcnIpLnNsaWNlKDAsIDE2MCl9YCwgeyByZXRyeWFibGU6IHRydWUgfSk7XHJcbiAgICB9XHJcbiAgICBpZiAocmVzLnN0YXR1cyA9PT0gNDAxIHx8IHJlcy5zdGF0dXMgPT09IDQwMykge1xyXG4gICAgICB0aHJvdyBkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgYGhvc3QgcmVqZWN0ZWQgdGhlIHNlc3Npb24gdG9rZW4gKEhUVFAgJHtyZXMuc3RhdHVzfSlgLCB7IHJldHJ5YWJsZTogZmFsc2UsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KTtcclxuICAgIH1cclxuICAgIGlmICghcmVzLm9rKSB7XHJcbiAgICAgIHRocm93IGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgaGVhbHRoIHByb2JlIEhUVFAgJHtyZXMuc3RhdHVzfWAsIHsgcmV0cnlhYmxlOiB0cnVlIH0pO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHsgcG9ydCwgdmVyc2lvbiwgdG9rZW46IHRoaXMudG9rZW4gfTtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgb25VbmV4cGVjdGVkRXhpdCgpOiB2b2lkIHtcclxuICAgIGlmICh0aGlzLnN0b3BwaW5nIHx8IHRoaXMuX3N0YXRlID09PSAnc3RvcHBlZCcgfHwgdGhpcy5fc3RhdGUgPT09ICdzdG9wcGluZycpIHJldHVybjtcclxuICAgIHRoaXMuY2hpbGQgPSBudWxsO1xyXG4gICAgaWYgKHRoaXMucmVzdGFydENvdW50IDwgdGhpcy5vcHRzLm1heFJlc3RhcnRzKSB7XHJcbiAgICAgIHRoaXMucmVzdGFydENvdW50ICs9IDE7XHJcbiAgICAgIHRoaXMuc2V0U3RhdGUoJ3Jlc3RhcnRpbmcnKTtcclxuICAgICAgdm9pZCB0aGlzLmxhdW5jaCgpLmNhdGNoKCgpID0+IHtcclxuICAgICAgICAvLyBcdTkxQ0RcdTU0MkZcdTVDMURcdThCRDVcdTU5MzFcdThEMjUoXHU1NDJGXHU1MkE4XHU1MzczXHU1RDI5L1x1OEQ4NVx1NjVGNi9cdTYyRDJcdThCQTQpOlx1N0VFN1x1N0VFRFx1NkQ4OFx1ODAxN1x1OTFDRFx1NTQyRlx1NkIyMVx1NjU3MFx1NzZGNFx1NTIzMFx1NjUzRVx1NUYwM1xyXG4gICAgICAgIHRoaXMucmV0cnlPckZhaWwoKTtcclxuICAgICAgfSk7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICB0aGlzLnNldFN0YXRlKCdmYWlsZWQnLCBgaG9zdCBleGl0ZWQgdW5leHBlY3RlZGx5ICR7dGhpcy5yZXN0YXJ0Q291bnQgKyAxfSB0aW1lczsgZ2l2aW5nIHVwYCk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICBwcml2YXRlIHJldHJ5T3JGYWlsKCk6IHZvaWQge1xyXG4gICAgaWYgKHRoaXMuc3RvcHBpbmcgfHwgdGhpcy5fc3RhdGUgPT09ICdzdG9wcGVkJyB8fCB0aGlzLl9zdGF0ZSA9PT0gJ3N0b3BwaW5nJykgcmV0dXJuO1xyXG4gICAgaWYgKHRoaXMucmVzdGFydENvdW50IDwgdGhpcy5vcHRzLm1heFJlc3RhcnRzKSB7XHJcbiAgICAgIHRoaXMucmVzdGFydENvdW50ICs9IDE7XHJcbiAgICAgIHRoaXMuc2V0U3RhdGUoJ3Jlc3RhcnRpbmcnKTtcclxuICAgICAgdm9pZCB0aGlzLmxhdW5jaCgpLmNhdGNoKCgpID0+IHRoaXMucmV0cnlPckZhaWwoKSk7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICB0aGlzLnNldFN0YXRlKCdmYWlsZWQnLCBgaG9zdCBmYWlsZWQgdG8gc3RheSB1cCBhZnRlciAke3RoaXMucmVzdGFydENvdW50fSByZXN0YXJ0IGF0dGVtcHRzYCk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvKiogXHU0RjE4XHU5NkM1XHU1MDVDXHU2QjYyOlx1NTE0OCBIVFRQIHNodXRkb3duLFx1OEQ4NVx1NjVGNlx1NjI0RFx1NUJGOVx1NjcyQ1x1OEZEQlx1N0EwQlx1NTNFNVx1NjdDNCBraWxsXHUzMDAyICovXHJcbiAgYXN5bmMgc3RvcCgpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIHRoaXMuc3RvcHBpbmcgPSB0cnVlO1xyXG4gICAgaWYgKHRoaXMuX3N0YXRlID09PSAnc3RvcHBlZCcpIHJldHVybjtcclxuICAgIHRoaXMuc2V0U3RhdGUoJ3N0b3BwaW5nJyk7XHJcbiAgICBjb25zdCBjaGlsZCA9IHRoaXMuY2hpbGQ7XHJcbiAgICB0aGlzLmNoaWxkID0gbnVsbDtcclxuICAgIHRoaXMuY3VycmVudEVuZHBvaW50ID0gbnVsbDtcclxuICAgIGlmICghY2hpbGQpIHtcclxuICAgICAgdGhpcy5zZXRTdGF0ZSgnc3RvcHBlZCcpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCBleGl0ZWQgPSBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4ge1xyXG4gICAgICBpZiAoY2hpbGQuZXhpdENvZGUgIT09IG51bGwgfHwgY2hpbGQuc2lnbmFsQ29kZSAhPT0gbnVsbCkgcmVzb2x2ZSgpO1xyXG4gICAgICBlbHNlIHtcclxuICAgICAgICBjb25zdCB3ID0gKCk6IHZvaWQgPT4gcmVzb2x2ZSgpO1xyXG4gICAgICAgIHRoaXMuZXhpdFdhaXRlcnMucHVzaCh3KTtcclxuICAgICAgICBjaGlsZC5vbmNlKCdleGl0Jywgdyk7XHJcbiAgICAgIH1cclxuICAgIH0pO1xyXG4gICAgLy8gXHU1REYyXHU3N0U1XHU3QUVGXHU1M0UzXHU2MjREXHU1QzFEXHU4QkQ1IEhUVFAgXHU0RjE4XHU5NkM1XHU1MTczXHU5NUVEO1x1NjcyQVx1NzdFNVx1N0FFRlx1NTNFM1x1NzZGNFx1NjNBNVx1OEQ3MCBraWxsIFx1NTE1Q1x1NUU5NVxyXG4gICAgaWYgKHRoaXMubGFzdEVuZHBvaW50ICE9PSBudWxsKSB7XHJcbiAgICAgIHRyeSB7XHJcbiAgICAgICAgYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHt0aGlzLmxhc3RFbmRwb2ludH0vYXBpL2Rlc2t0b3Avc2h1dGRvd25gLCB7XHJcbiAgICAgICAgICBtZXRob2Q6ICdQT1NUJyxcclxuICAgICAgICAgIGhlYWRlcnM6IHsgJ3gtaG1oLWtleSc6IHRoaXMudG9rZW4gfSxcclxuICAgICAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCgxXzAwMCksXHJcbiAgICAgICAgfSk7XHJcbiAgICAgIH0gY2F0Y2gge1xyXG4gICAgICAgIC8vIGhvc3QgXHU1REYyXHU2QjdCXHU2MjE2XHU0RTBEXHU1RTk0XHU3QjU0Olx1OEQ3MCBraWxsIFx1NTE1Q1x1NUU5NVxyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgICBjb25zdCBncmFjZWZ1bCA9IGF3YWl0IFByb21pc2UucmFjZShbXHJcbiAgICAgIGV4aXRlZC50aGVuKCgpID0+IHRydWUpLFxyXG4gICAgICBuZXcgUHJvbWlzZTxib29sZWFuPigocmVzb2x2ZSkgPT4gc2V0VGltZW91dCgoKSA9PiByZXNvbHZlKGZhbHNlKSwgdGhpcy5vcHRzLmdyYWNlZnVsU2h1dGRvd25NcykpLFxyXG4gICAgXSk7XHJcbiAgICBpZiAoIWdyYWNlZnVsICYmIGNoaWxkLmV4aXRDb2RlID09PSBudWxsICYmIGNoaWxkLnNpZ25hbENvZGUgPT09IG51bGwpIHtcclxuICAgICAgY2hpbGQua2lsbCgpOyAvLyBcdTUzRUFcdTY3NDBcdTgxRUFcdTVERjFcdTYzMDFcdTY3MDlcdTc2ODRcdTUzRTVcdTY3QzQsXHU3RUREXHU0RTBEXHU2MzA5XHU4RkRCXHU3QTBCXHU1NDBEXHJcbiAgICB9XHJcbiAgICBhd2FpdCBleGl0ZWQuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcclxuICAgIHRoaXMuc2V0U3RhdGUoJ3N0b3BwZWQnKTtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgbGFzdEVuZHBvaW50OiBudW1iZXIgfCBudWxsID0gbnVsbDtcclxuICBwcml2YXRlIGN1cnJlbnRFbmRwb2ludDogeyBwb3J0OiBudW1iZXI7IHZlcnNpb246IHN0cmluZyB9IHwgbnVsbCA9IG51bGw7XHJcblxyXG4gIC8qKiBcdTVGNTNcdTUyNEQgaG9zdCBcdTdBRUZcdTcwQjkocmVhZHkgXHU1NDBFXHU2NzA5XHU1MDNDO1x1NEUwRFx1NTQyQiB0b2tlbilcdTMwMDIgKi9cclxuICBnZXQgZW5kcG9pbnQoKTogeyBwb3J0OiBudW1iZXI7IHZlcnNpb246IHN0cmluZyB9IHwgbnVsbCB7XHJcbiAgICByZXR1cm4gdGhpcy5jdXJyZW50RW5kcG9pbnQ7XHJcbiAgfVxyXG5cclxuICAvKiogXHU2M0EyXHU2RDRCXHU2MjEwXHU1MjlGXHU1NDBFXHU4QkIwXHU0RjRGXHU3QUVGXHU1M0UzLFx1NEY5QiBzdG9wKCkgXHU3Njg0XHU0RjE4XHU5NkM1XHU1MTczXHU5NUVEXHU0RjdGXHU3NTI4XHUzMDAyICovXHJcbiAgcHJpdmF0ZSBhc3luYyBwcm9iZUFuZFJlbWVtYmVyKHBvcnQ6IG51bWJlciwgdmVyc2lvbjogc3RyaW5nKTogUHJvbWlzZTxIb3N0RW5kcG9pbnQ+IHtcclxuICAgIGNvbnN0IGVwID0gYXdhaXQgdGhpcy5wcm9iZShwb3J0LCB2ZXJzaW9uKTtcclxuICAgIHRoaXMubGFzdEVuZHBvaW50ID0gZXAucG9ydDtcclxuICAgIHJldHVybiBlcDtcclxuICB9XHJcbn1cclxuXHJcbi8qKiBcdTYyOEFcdTY3MkFcdTc3RTVcdTk1MTlcdThCRUZcdTg5QzRcdTdFQTZcdTRFM0EgRGVza3RvcEVycm9yKFx1NURGMlx1NjYyRlx1NTIxOVx1NTM5Rlx1NjgzN1x1OEZENFx1NTZERSlcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHRvRGVza3RvcEVycm9yKGVycjogdW5rbm93bik6IERlc2t0b3BFcnJvciB7XHJcbiAgaWYgKGlzRGVza3RvcEVycm9yKGVycikpIHJldHVybiBlcnI7XHJcbiAgY29uc3QgbWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcclxuICByZXR1cm4gZGVza3RvcEVycm9yKCdSVU5USU1FX0NSQVNIRUQnLCBtZXNzYWdlLnNsaWNlKDAsIDMwMCksIHsgcmV0cnlhYmxlOiBmYWxzZSB9KTtcclxufVxyXG4iLCAiLyoqXHJcbiAqIEBobWgtZGVza3RvcC9jb250cmFjdHMgXHUyMDE0IFx1NEU4Qlx1NEVGNlx1NEZFMVx1NUMwMShcdTVGMDBcdTUzRDFcdThCQTFcdTUyMTJcdTY1ODdcdTY4NjMgMDQgXHUwMEE3XHU0RTA5KVxyXG4gKlxyXG4gKiBcdTRFMDBcdTY3NjEgVUkgXHU0RThCXHU0RUY2XHU3Njg0XHU1NTJGXHU0RTAwXHU1RjYyXHU3MkI2XHUzMDAyXHU1MjREXHU3QUVGIHJlZHVjZXIgXHU1RkM1XHU5ODdCXHU2MzA5IHNlc3Npb25JZC9ydW5JZC9zZXEgXHU1OTA0XHU3NDA2O1xyXG4gKiBcdTkxQ0RcdTU5MEQgZXZlbnRJZCBcdTVFNDJcdTdCNDlcdTRFMjJcdTVGMDM7c2VxIFx1N0YzQVx1NTNFM1x1ODlFNlx1NTNEMVx1ODg2NVx1NjJDOTtcdTk3NUVcdTVFNDJcdTdCNDlcdTUyQThcdTRGNUNcdTRFMERcdTc1MzEgU1NFIFx1ODFFQVx1NTJBOFx1OTFDRFx1NTNEMVx1MzAwMlxyXG4gKi9cclxuXHJcbmltcG9ydCB0eXBlIHsgQXJ0aWZhY3RSZWYgfSBmcm9tICcuL2R0by50cyc7XHJcbmltcG9ydCB0eXBlIHsgRGVza3RvcEVycm9yIH0gZnJvbSAnLi9lcnJvci50cyc7XHJcblxyXG4vKiogXHU0RThCXHU0RUY2XHU3OUNEXHU3QzdCKFx1NTIyNFx1NTIyQlx1OTUyRSlcdTMwMDJcdTY1QjBcdTU4OUUga2luZCA9IHNjaGVtYVZlcnNpb24gXHU1MzQ3XHU3RUE3LFx1NEUwRFx1NTE0MVx1OEJCOFx1OTc1OVx1OUVEOFx1NjI2OVx1Njc5QVx1NEUzRVx1MzAwMiAqL1xyXG5leHBvcnQgY29uc3QgRVZFTlRfS0lORFMgPSBbXHJcbiAgJ3J1bi5zdGFydGVkJyxcclxuICAncGxhbi51cGRhdGVkJyxcclxuICAndG9vbC5zdGFydGVkJyxcclxuICAndG9vbC5jb21wbGV0ZWQnLFxyXG4gICdhcHByb3ZhbC5yZXF1aXJlZCcsXHJcbiAgJ3ZlcmlmaWNhdGlvbi51cGRhdGVkJyxcclxuICAnYXJ0aWZhY3QuY3JlYXRlZCcsXHJcbiAgJ3J1bi5jb21wbGV0ZWQnLFxyXG4gICdydW4uZmFpbGVkJyxcclxuXSBhcyBjb25zdDtcclxuXHJcbmV4cG9ydCB0eXBlIEV2ZW50S2luZCA9ICh0eXBlb2YgRVZFTlRfS0lORFMpW251bWJlcl07XHJcblxyXG5leHBvcnQgY29uc3QgRVZFTlRfU0NIRU1BX1ZFUlNJT04gPSAxO1xyXG5leHBvcnQgdHlwZSBFdmVudFNjaGVtYVZlcnNpb24gPSAxO1xyXG5cclxuLyoqIFNTRSBcdTZENDFcdTRFMEFcdTc2ODRcdTZCQ0ZcdTRFMDBcdTY3NjFcdTRFOEJcdTRFRjZcdTMwMDIgKi9cclxuZXhwb3J0IGludGVyZmFjZSBFdmVudEVudmVsb3BlPFQgPSB1bmtub3duPiB7XHJcbiAgc2NoZW1hVmVyc2lvbjogRXZlbnRTY2hlbWFWZXJzaW9uO1xyXG4gIC8qKiBcdTUxNjhcdTVDNDBcdTU1MkZcdTRFMDA7XHU5MUNEXHU4RkRFL1x1ODg2NVx1NjJDOVx1NTQwRVx1OTFDRFx1NTkwRFx1NTFGQVx1NzNCMFx1NjVGNlx1NjNBNVx1NjUzNlx1NjVCOVx1NUU0Mlx1N0I0OVx1NEUyMlx1NUYwM1x1MzAwMiAqL1xyXG4gIGV2ZW50SWQ6IHN0cmluZztcclxuICBzZXNzaW9uSWQ6IHN0cmluZztcclxuICBydW5JZDogc3RyaW5nO1xyXG4gIC8qKiBcdTRGMUFcdThCRERcdTUxODVcdTUzNTVcdThDMDNcdTkwMTJcdTU4OUU7XHU3RjNBXHU1M0UzXHU2MTBGXHU1NDczXHU3NzQwXHU0RTIyXHU0RThCXHU0RUY2LFx1OTcwMFx1ODk4MVx1ODg2NVx1NjJDOVx1MzAwMiAqL1xyXG4gIHNlcTogbnVtYmVyO1xyXG4gIC8qKiBSRkMzMzM5XHUzMDAyICovXHJcbiAgb2NjdXJyZWRBdDogc3RyaW5nO1xyXG4gIGtpbmQ6IEV2ZW50S2luZDtcclxuICBwYXlsb2FkOiBUO1xyXG59XHJcblxyXG4vKiogcnVuLnN0YXJ0ZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cclxuZXhwb3J0IGludGVyZmFjZSBSdW5TdGFydGVkUGF5bG9hZCB7XHJcbiAgdGFzazogc3RyaW5nO1xyXG4gIG1vZGU6ICdhc2snIHwgJ2F1dG8nIHwgJ3lvbG8nO1xyXG59XHJcblxyXG4vKiogcGxhbi51cGRhdGVkIFx1NzY4NCBwYXlsb2FkKFx1OEJBMVx1NTIxMlx1NkI2NVx1OUFBNFx1NTIxN1x1ODg2OCxcdTY3NjVcdTgxRUEgcnVudGltZSBcdTc2ODRcdTdFRDNcdTY3ODRcdTUzMTZcdThCQTFcdTUyMTIsXHU0RTBEXHU2NjJGIGNoYWluLW9mLXRob3VnaHQpXHUzMDAyICovXHJcbmV4cG9ydCBpbnRlcmZhY2UgUGxhblVwZGF0ZWRQYXlsb2FkIHtcclxuICBzdGVwczogQXJyYXk8eyB0aXRsZTogc3RyaW5nOyBzdGF0dXM6ICdwZW5kaW5nJyB8ICdhY3RpdmUnIHwgJ2RvbmUnIHwgJ2ZhaWxlZCcgfT47XHJcbn1cclxuXHJcbi8qKiB0b29sLnN0YXJ0ZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cclxuZXhwb3J0IGludGVyZmFjZSBUb29sU3RhcnRlZFBheWxvYWQge1xyXG4gIG5hbWU6IHN0cmluZztcclxuICAvKiogXHU1M0MyXHU2NTcwXHU0RUU1XHU2NTg3XHU2NzJDXHU1NDQ4XHU3M0IwLFx1NkUzMlx1NjdEM1x1N0FFRlx1NkMzOFx1NEUwRCBldmFsO1x1NTkyN1x1NUJGOVx1OEM2MVx1NzUzMSBydW50aW1lIFx1NjIyQVx1NjVBRFx1MzAwMiAqL1xyXG4gIGFyZ3NQcmV2aWV3OiBzdHJpbmc7XHJcbn1cclxuXHJcbi8qKiB0b29sLmNvbXBsZXRlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xyXG5leHBvcnQgaW50ZXJmYWNlIFRvb2xDb21wbGV0ZWRQYXlsb2FkIHtcclxuICBuYW1lOiBzdHJpbmc7XHJcbiAgaXNFcnJvcjogYm9vbGVhbjtcclxuICBvdXRwdXRQcmV2aWV3OiBzdHJpbmc7XHJcbn1cclxuXHJcbi8qKiBhcHByb3ZhbC5yZXF1aXJlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMlx1NUJBMVx1NjI3OVx1Njc0M1x1NUEwMVx1NTcyOCBydW50aW1lIFx1NTQwRVx1N0FFRjtVSSBcdTUzRUFcdTY2MkZcdThGNkNcdThGRjBcdTMwMDIgKi9cclxuZXhwb3J0IGludGVyZmFjZSBBcHByb3ZhbFJlcXVpcmVkUGF5bG9hZCB7XHJcbiAgYXBwcm92YWxJZDogc3RyaW5nO1xyXG4gIHRvb2w6IHN0cmluZztcclxuICBhcmdzUHJldmlldzogc3RyaW5nO1xyXG4gIC8qKiBcdTVGNzFcdTU0Q0RcdTgzMDNcdTU2RjQvXHU5OENFXHU5NjY5XHU3Njg0XHU0RUJBXHU3QzdCXHU1M0VGXHU4QkZCXHU4QkY0XHU2NjBFLFx1NzUzMSBydW50aW1lIFx1NzUxRlx1NjIxMFx1MzAwMiAqL1xyXG4gIHJpc2s6IHN0cmluZztcclxufVxyXG5cclxuLyoqIHZlcmlmaWNhdGlvbi51cGRhdGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXHJcbmV4cG9ydCBpbnRlcmZhY2UgVmVyaWZpY2F0aW9uVXBkYXRlZFBheWxvYWQge1xyXG4gIHN1bW1hcnk6IHN0cmluZztcclxuICBwYXNzZWQ6IGJvb2xlYW4gfCBudWxsOyAvLyBudWxsID0gXHU2NzJBXHU3N0U1L1x1OEZEQlx1ODg0Q1x1NEUyRChORUVEUy1EQVRBIFx1NjVGNlx1NEUwRFx1NTA0N1x1NTg2QilcclxufVxyXG5cclxuLyoqIGFydGlmYWN0LmNyZWF0ZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cclxuZXhwb3J0IGludGVyZmFjZSBBcnRpZmFjdENyZWF0ZWRQYXlsb2FkIHtcclxuICBhcnRpZmFjdDogQXJ0aWZhY3RSZWY7XHJcbn1cclxuXHJcbi8qKiBydW4uY29tcGxldGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXHJcbmV4cG9ydCBpbnRlcmZhY2UgUnVuQ29tcGxldGVkUGF5bG9hZCB7XHJcbiAgdGV4dDogc3RyaW5nO1xyXG4gIHR1cm5zOiBudW1iZXI7XHJcbiAgdG9vbFVzZXM6IG51bWJlcjtcclxuICB1c2FnZT86IHsgcHJvbXB0VG9rZW5zOiBudW1iZXI7IGNvbXBsZXRpb25Ub2tlbnM6IG51bWJlciB9O1xyXG59XHJcblxyXG4vKiogcnVuLmZhaWxlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xyXG5leHBvcnQgaW50ZXJmYWNlIFJ1bkZhaWxlZFBheWxvYWQge1xyXG4gIGVycm9yOiBEZXNrdG9wRXJyb3I7XHJcbn1cclxuIiwgIi8qKlxyXG4gKiBAaG1oLWRlc2t0b3AvY29udHJhY3RzIFx1MjAxNCBcdTdFRDNcdTY3ODRcdTUzMTZcdTY4NENcdTk3NjJcdTk1MTlcdThCRUYoXHU1RjAwXHU1M0QxXHU4QkExXHU1MjEyXHU2NTg3XHU2ODYzIDA0IFx1MDBBN1x1NEUwOSlcdTMwMDJcclxuICpcclxuICogaG9zdC1ub3QtcmVhZHkgLyBhdXRoLWZhaWxlZCAvIHN0YWxlLXZlcnNpb24gLyBydW50aW1lLWNyYXNoZWQgL1xyXG4gKiBwb3J0LWJpbmQtZmFpbGVkIC8gc2NoZW1hLW1pc21hdGNoIFx1NUZDNVx1OTg3Qlx1NjYyRlx1N0VEM1x1Njc4NFx1NTMxNlx1OTUxOVx1OEJFRlx1NzgwMSxcdTVFNzZcdTYzRDBcdTRGOUJcdTRFMEJcdTRFMDBcdTZCNjVcdTUyQThcdTRGNUNcdTMwMDJcclxuICogbWVzc2FnZSBcdTY2MkZcdTdFQUZcdTY1ODdcdTY3MkMsXHU2RTMyXHU2N0QzXHU3QUVGXHU2QzM4XHU0RTBEXHU2MjhBXHU1QjgzXHU1RjUzIEhUTUxcdTMwMDJcclxuICovXHJcbmV4cG9ydCBjb25zdCBFUlJPUl9DT0RFUyA9IFtcclxuICAnSE9TVF9OT1RfUkVBRFknLFxyXG4gICdBVVRIX0ZBSUxFRCcsXHJcbiAgJ1JVTlRJTUVfQ1JBU0hFRCcsXHJcbiAgJ1BPUlRfQklORF9GQUlMRUQnLFxyXG4gICdTVEFMRV9WRVJTSU9OJyxcclxuICAnU0NIRU1BX01JU01BVENIJyxcclxuXSBhcyBjb25zdDtcclxuXHJcbmV4cG9ydCB0eXBlIEVycm9yQ29kZSA9ICh0eXBlb2YgRVJST1JfQ09ERVMpW251bWJlcl07XHJcblxyXG5leHBvcnQgY29uc3QgUkVDT1ZFUllfQUNUSU9OUyA9IFsnUkVDT05ORUNUJywgJ1JFU1VNRScsICdFWFBPUlQnLCAnT1BFTl9MT0dTJ10gYXMgY29uc3Q7XHJcbmV4cG9ydCB0eXBlIFJlY292ZXJ5QWN0aW9uID0gKHR5cGVvZiBSRUNPVkVSWV9BQ1RJT05TKVtudW1iZXJdO1xyXG5cclxuZXhwb3J0IGludGVyZmFjZSBEZXNrdG9wRXJyb3Ige1xyXG4gIGNvZGU6IEVycm9yQ29kZTtcclxuICAvKiogXHU3RUFGXHU2NTg3XHU2NzJDLFx1NkMzOFx1NEUwRFx1NEZFMVx1NEVGQlx1NEUzQSBIVE1MXHUzMDAyICovXHJcbiAgbWVzc2FnZTogc3RyaW5nO1xyXG4gIHJldHJ5YWJsZTogYm9vbGVhbjtcclxuICBzZXNzaW9uSWQ/OiBzdHJpbmc7XHJcbiAgcnVuSWQ/OiBzdHJpbmc7XHJcbiAgcmVjb3ZlcnlBY3Rpb24/OiBSZWNvdmVyeUFjdGlvbjtcclxufVxyXG5cclxuLyoqIFx1Njc4NFx1OTAyMFx1NEUwMFx1NEUyQSBEZXNrdG9wRXJyb3IoZXhhY3RPcHRpb25hbFByb3BlcnR5VHlwZXMgXHU1M0NCXHU1OTdEKVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gZGVza3RvcEVycm9yKFxyXG4gIGNvZGU6IEVycm9yQ29kZSxcclxuICBtZXNzYWdlOiBzdHJpbmcsXHJcbiAgb3B0czogeyByZXRyeWFibGU/OiBib29sZWFuOyBzZXNzaW9uSWQ/OiBzdHJpbmc7IHJ1bklkPzogc3RyaW5nOyByZWNvdmVyeUFjdGlvbj86IFJlY292ZXJ5QWN0aW9uIH0gPSB7fSxcclxuKTogRGVza3RvcEVycm9yIHtcclxuICBjb25zdCBlOiBEZXNrdG9wRXJyb3IgPSB7IGNvZGUsIG1lc3NhZ2UsIHJldHJ5YWJsZTogb3B0cy5yZXRyeWFibGUgPT09IHRydWUgfTtcclxuICBpZiAob3B0cy5zZXNzaW9uSWQgIT09IHVuZGVmaW5lZCkgZS5zZXNzaW9uSWQgPSBvcHRzLnNlc3Npb25JZDtcclxuICBpZiAob3B0cy5ydW5JZCAhPT0gdW5kZWZpbmVkKSBlLnJ1bklkID0gb3B0cy5ydW5JZDtcclxuICBpZiAob3B0cy5yZWNvdmVyeUFjdGlvbiAhPT0gdW5kZWZpbmVkKSBlLnJlY292ZXJ5QWN0aW9uID0gb3B0cy5yZWNvdmVyeUFjdGlvbjtcclxuICByZXR1cm4gZTtcclxufVxyXG4iLCAiLyoqXHJcbiAqIEBobWgtZGVza3RvcC9jb250cmFjdHMgXHUyMDE0IHJ1bnRpbWUgXHU2ODIxXHU5QThDKGd1YXJkcylcdTMwMDJcclxuICpcclxuICogXHU2QkNGXHU0RTJBXHU4REU4XHU0RkUxXHU0RUZCXHU4RkI5XHU3NTRDXHU3Njg0XHU2NTcwXHU2MzZFKHJ1bnRpbWVcdTIxOTJyZW5kZXJlclx1MzAwMWhvc3RcdTIxOTJtYWluKVx1OEZEQlx1NTE2NVx1NTI0RFx1NTE0OFx1OEZDNyBndWFyZDtcclxuICogXHU2ODIxXHU5QThDXHU1OTMxXHU4RDI1XHU3Njg0XHU2NTcwXHU2MzZFXHU2MzA5IFNDSEVNQV9NSVNNQVRDSCBcdTdFRDNcdTY3ODRcdTUzMTZcdTk1MTlcdThCRUZcdTU5MDRcdTc0MDYsXHU0RTBEXHU5NzU5XHU5RUQ4XHU2M0E1XHU1M0Q3XHUzMDAyXHJcbiAqIFx1NjI0Qlx1NTE5OVx1NUI4OFx1NTM2Qlx1ODAwQ1x1NEUwRFx1NjYyRlx1NUYxNVx1N0IyQ1x1NEUwOVx1NjVCOSBzY2hlbWEgXHU1RTkzOlx1NTk1MVx1N0VBNlx1OTc2Mlx1NUMwRixcdTk2RjZcdTRGOURcdThENTZcdTY1ODdcdTUzMTYoaG1oYXJuZXNzIFx1NTQwQ1x1NkU5MClcdTMwMDJcclxuICovXHJcbmltcG9ydCB7XHJcbiAgRVZFTlRfS0lORFMsXHJcbiAgRVZFTlRfU0NIRU1BX1ZFUlNJT04sXHJcbiAgdHlwZSBFdmVudEVudmVsb3BlLFxyXG4gIHR5cGUgRXZlbnRLaW5kLFxyXG59IGZyb20gJy4vZXZlbnQudHMnO1xyXG5pbXBvcnQgeyBFUlJPUl9DT0RFUywgUkVDT1ZFUllfQUNUSU9OUywgdHlwZSBEZXNrdG9wRXJyb3IgfSBmcm9tICcuL2Vycm9yLnRzJztcclxuaW1wb3J0IHsgUlVOX1NUQVRVU0VTLCB0eXBlIFJ1blN0YXR1cyB9IGZyb20gJy4vZHRvLnRzJztcclxuXHJcbmNvbnN0IGlzUmVjb3JkID0gKHY6IHVua25vd24pOiB2IGlzIFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0+XHJcbiAgdHlwZW9mIHYgPT09ICdvYmplY3QnICYmIHYgIT09IG51bGwgJiYgIUFycmF5LmlzQXJyYXkodik7XHJcblxyXG5jb25zdCBpc05vbkVtcHR5U3RyaW5nID0gKHY6IHVua25vd24pOiB2IGlzIHN0cmluZyA9PiB0eXBlb2YgdiA9PT0gJ3N0cmluZycgJiYgdi5sZW5ndGggPiAwO1xyXG5cclxuY29uc3QgaXNSZmMzMzM5ID0gKHY6IHN0cmluZyk6IGJvb2xlYW4gPT4ge1xyXG4gIGNvbnN0IHQgPSBEYXRlLnBhcnNlKHYpO1xyXG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUodCkgJiYgL1xcZHs0fS1cXGR7Mn0tXFxkezJ9VC8udGVzdCh2KTtcclxufTtcclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpc0V2ZW50RW52ZWxvcGUodjogdW5rbm93bik6IHYgaXMgRXZlbnRFbnZlbG9wZSB7XHJcbiAgaWYgKCFpc1JlY29yZCh2KSkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICh2LnNjaGVtYVZlcnNpb24gIT09IEVWRU5UX1NDSEVNQV9WRVJTSU9OKSByZXR1cm4gZmFsc2U7XHJcbiAgaWYgKCFpc05vbkVtcHR5U3RyaW5nKHYuZXZlbnRJZCkpIHJldHVybiBmYWxzZTtcclxuICBpZiAoIWlzTm9uRW1wdHlTdHJpbmcodi5zZXNzaW9uSWQpKSByZXR1cm4gZmFsc2U7XHJcbiAgaWYgKCFpc05vbkVtcHR5U3RyaW5nKHYucnVuSWQpKSByZXR1cm4gZmFsc2U7XHJcbiAgaWYgKHR5cGVvZiB2LnNlcSAhPT0gJ251bWJlcicgfHwgIU51bWJlci5pc0ludGVnZXIodi5zZXEpIHx8IHYuc2VxIDwgMCkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICghaXNOb25FbXB0eVN0cmluZyh2Lm9jY3VycmVkQXQpIHx8ICFpc1JmYzMzMzkodi5vY2N1cnJlZEF0KSkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICghRVZFTlRfS0lORFMuaW5jbHVkZXModi5raW5kIGFzIEV2ZW50S2luZCkpIHJldHVybiBmYWxzZTtcclxuICByZXR1cm4gaXNSZWNvcmQodi5wYXlsb2FkKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGlzRGVza3RvcEVycm9yKHY6IHVua25vd24pOiB2IGlzIERlc2t0b3BFcnJvciB7XHJcbiAgaWYgKCFpc1JlY29yZCh2KSkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICghRVJST1JfQ09ERVMuaW5jbHVkZXModi5jb2RlIGFzIG5ldmVyKSkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICh0eXBlb2Ygdi5tZXNzYWdlICE9PSAnc3RyaW5nJykgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICh0eXBlb2Ygdi5yZXRyeWFibGUgIT09ICdib29sZWFuJykgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICh2LnNlc3Npb25JZCAhPT0gdW5kZWZpbmVkICYmICFpc05vbkVtcHR5U3RyaW5nKHYuc2Vzc2lvbklkKSkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICh2LnJ1bklkICE9PSB1bmRlZmluZWQgJiYgIWlzTm9uRW1wdHlTdHJpbmcodi5ydW5JZCkpIHJldHVybiBmYWxzZTtcclxuICBpZiAodi5yZWNvdmVyeUFjdGlvbiAhPT0gdW5kZWZpbmVkICYmICFSRUNPVkVSWV9BQ1RJT05TLmluY2x1ZGVzKHYucmVjb3ZlcnlBY3Rpb24gYXMgbmV2ZXIpKSByZXR1cm4gZmFsc2U7XHJcbiAgcmV0dXJuIHRydWU7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpc1J1blN0YXR1cyh2OiB1bmtub3duKTogdiBpcyBSdW5TdGF0dXMge1xyXG4gIHJldHVybiB0eXBlb2YgdiA9PT0gJ3N0cmluZycgJiYgUlVOX1NUQVRVU0VTLmluY2x1ZGVzKHYgYXMgUnVuU3RhdHVzKTtcclxufVxyXG5cclxuLyoqIEhvc3QgXHU1RjE1XHU1QkZDXHU4ODRDKHN0ZG91dCBcdTdCMkNcdTRFMDBcdTg4NEMpXHUzMDAyICovXHJcbmV4cG9ydCBmdW5jdGlvbiBpc0hvc3RSZWFkeUxpbmUodjogdW5rbm93bik6IHYgaXMgeyBobWhEZXNrdG9wSG9zdFJlYWR5OiB0cnVlOyBwb3J0OiBudW1iZXI7IHZlcnNpb246IHN0cmluZyB9IHtcclxuICBpZiAoIWlzUmVjb3JkKHYpKSByZXR1cm4gZmFsc2U7XHJcbiAgaWYgKHYuaG1oRGVza3RvcEhvc3RSZWFkeSAhPT0gdHJ1ZSkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICh0eXBlb2Ygdi5wb3J0ICE9PSAnbnVtYmVyJyB8fCAhTnVtYmVyLmlzSW50ZWdlcih2LnBvcnQpIHx8IHYucG9ydCA8PSAwIHx8IHYucG9ydCA+IDY1NTM1KSByZXR1cm4gZmFsc2U7XHJcbiAgcmV0dXJuIGlzTm9uRW1wdHlTdHJpbmcodi52ZXJzaW9uKTtcclxufVxyXG4iLCAiLyoqXHJcbiAqIERlc2t0b3BIb3N0Q2xpZW50IFx1MjAxNCBcdTVCRjkgaG1oIGhvc3QgXHU3Njg0IEhUVFArU1NFIFx1NUJBMlx1NjIzN1x1N0FFRlx1MzAwMlxyXG4gKlxyXG4gKiAtIFx1NkJDRlx1NEUyQSBIVFRQIFx1OEJGN1x1NkM0Mlx1ODFFQVx1NTJBOFx1NUUyNiBYLUhtaC1LZXkodG9rZW4gXHU0RTBEXHU4RkRCIFVSTCk7XHJcbiAqIC0gXHU3RUQzXHU2Nzg0XHU1MzE2XHU5NTE5XHU4QkVGKHJlcy5ib2R5IFx1OTFDQ1x1NzY4NCBEZXNrdG9wRXJyb3IgXHU1RjYyXHU3MkI2XHU2MjE2IEhUVFAgXHU3MkI2XHU2MDAxKVx1ODlDNFx1N0VBNlx1NjIxMFx1NUYwMlx1NUUzOFx1NjI5Qlx1NTFGQTtcclxuICogLSBTU0UgXHU3NTI4IGZldGNoIFx1NkQ0MVx1NjI0Qlx1NTE5OVx1ODlFM1x1Njc5MChpZC9ldmVudC9kYXRhIFx1NUUyNyksXHU2NTJGXHU2MzAxIExhc3QtRXZlbnQtSUQgXHU4ODY1XHU2MkM5XHU5MUNEXHU4RkRFXHUzMDAyXHJcbiAqL1xyXG5pbXBvcnQgeyBkZXNrdG9wRXJyb3IsIGlzRGVza3RvcEVycm9yLCBpc0V2ZW50RW52ZWxvcGUsIHR5cGUgRGVza3RvcEVycm9yLCB0eXBlIEV2ZW50RW52ZWxvcGUgfSBmcm9tICdAaG1oLWRlc2t0b3AvY29udHJhY3RzJztcclxuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gJ25vZGU6Y3J5cHRvJztcclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgU3NlRnJhbWUge1xyXG4gIGlkPzogc3RyaW5nO1xyXG4gIGV2ZW50OiBzdHJpbmc7XHJcbiAgZGF0YTogc3RyaW5nO1xyXG59XHJcblxyXG4vKiogXHU4OUUzXHU2NzkwXHU0RTAwXHU2QkI1IFNTRSBcdTY1ODdcdTY3MkNcdTRFM0FcdTVFMjcoXHU0RTBEXHU1NDJCXHU4REU4IGNodW5rIFx1NzY4NFx1N0YxM1x1NTFCMlx1OTAzQlx1OEY5MSxcdTdFQUZcdTUxRkRcdTY1NzBcdTRGQkZcdTRFOEVcdTZENEJcdThCRDUpXHUzMDAyICovXHJcbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVNzZUNodW5rKGNodW5rOiBzdHJpbmcpOiBTc2VGcmFtZVtdIHtcclxuICBjb25zdCBmcmFtZXM6IFNzZUZyYW1lW10gPSBbXTtcclxuICBmb3IgKGNvbnN0IGJsb2NrIG9mIGNodW5rLnNwbGl0KC9cXG5cXG4vKSkge1xyXG4gICAgaWYgKCFibG9jay50cmltKCkpIGNvbnRpbnVlO1xyXG4gICAgbGV0IGlkOiBzdHJpbmcgfCB1bmRlZmluZWQ7XHJcbiAgICBsZXQgZXZlbnQgPSAnbWVzc2FnZSc7XHJcbiAgICBjb25zdCBkYXRhTGluZXM6IHN0cmluZ1tdID0gW107XHJcbiAgICBsZXQgc2F3RmllbGQgPSBmYWxzZTtcclxuICAgIGZvciAoY29uc3QgbGluZSBvZiBibG9jay5zcGxpdCgnXFxuJykpIHtcclxuICAgICAgaWYgKGxpbmUuc3RhcnRzV2l0aCgnOicpKSBjb250aW51ZTsgLy8gXHU2Q0U4XHU5MUNBL1x1NUZDM1x1OERGM1xyXG4gICAgICBpZiAobGluZS5zdGFydHNXaXRoKCdpZDonKSkgeyBpZCA9IGxpbmUuc2xpY2UoMykudHJpbSgpOyBzYXdGaWVsZCA9IHRydWU7IH1cclxuICAgICAgZWxzZSBpZiAobGluZS5zdGFydHNXaXRoKCdldmVudDonKSkgeyBldmVudCA9IGxpbmUuc2xpY2UoNikudHJpbSgpOyBzYXdGaWVsZCA9IHRydWU7IH1cclxuICAgICAgZWxzZSBpZiAobGluZS5zdGFydHNXaXRoKCdkYXRhOicpKSB7IGRhdGFMaW5lcy5wdXNoKGxpbmUuc2xpY2UoNSkucmVwbGFjZSgvXiAvLCAnJykpOyBzYXdGaWVsZCA9IHRydWU7IH1cclxuICAgIH1cclxuICAgIGlmICghc2F3RmllbGQpIGNvbnRpbnVlOyAvLyBcdTdFQUZcdTZDRThcdTkxQ0EvXHU1RkMzXHU4REYzXHU1NzU3XHU0RTBEXHU0RUE3XHU3NTFGXHU1RTI3XHJcbiAgICBmcmFtZXMucHVzaCh7IC4uLihpZCAhPT0gdW5kZWZpbmVkID8geyBpZCB9IDoge30pLCBldmVudCwgZGF0YTogZGF0YUxpbmVzLmpvaW4oJ1xcbicpIH0pO1xyXG4gIH1cclxuICByZXR1cm4gZnJhbWVzO1xyXG59XHJcblxyXG4vKiogXHU0RUNFIFNTRSBcdTVFMjdcdTY1NzBcdTYzNkVcdTRFMkRcdTg5RTNcdTUxRkFcdTU0MDhcdTZDRDUgRXZlbnRFbnZlbG9wZTtcdTRFMERcdTU0MDhcdTZDRDVcdTc2ODRcdThGRDRcdTU2REUgbnVsbChTQ0hFTUFfTUlTTUFUQ0ggXHU3NTMxXHU4QzAzXHU3NTI4XHU2NUI5XHU4QkExXHU2NTcwKVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gZW52ZWxvcGVGcm9tRnJhbWUoZnJhbWU6IFNzZUZyYW1lKTogRXZlbnRFbnZlbG9wZSB8IG51bGwge1xyXG4gIGlmIChmcmFtZS5ldmVudCAhPT0gJ2htaCcpIHJldHVybiBudWxsOyAvLyBcdTYyMTFcdTRFRUNcdTc2ODRcdTRFOEJcdTRFRjZcdTRGRTFcdTVDMDFcdTdFREZcdTRFMDBcdThENzAgZXZlbnQ6IGhtaFxyXG4gIHRyeSB7XHJcbiAgICBjb25zdCBwYXJzZWQ6IHVua25vd24gPSBKU09OLnBhcnNlKGZyYW1lLmRhdGEpO1xyXG4gICAgcmV0dXJuIGlzRXZlbnRFbnZlbG9wZShwYXJzZWQpID8gcGFyc2VkIDogbnVsbDtcclxuICB9IGNhdGNoIHtcclxuICAgIHJldHVybiBudWxsO1xyXG4gIH1cclxufVxyXG5cclxuZXhwb3J0IGNsYXNzIERlc2t0b3BIdHRwRXJyb3IgZXh0ZW5kcyBFcnJvciB7XHJcbiAgY29uc3RydWN0b3IocHVibGljIHJlYWRvbmx5IGRldGFpbDogRGVza3RvcEVycm9yKSB7XHJcbiAgICBzdXBlcihkZXRhaWwubWVzc2FnZSk7XHJcbiAgfVxyXG59XHJcblxyXG5leHBvcnQgY2xhc3MgRGVza3RvcEhvc3RDbGllbnQge1xyXG4gIGNvbnN0cnVjdG9yKFxyXG4gICAgcHJpdmF0ZSByZWFkb25seSBiYXNlVXJsOiBzdHJpbmcsXHJcbiAgICBwcml2YXRlIHJlYWRvbmx5IHRva2VuOiBzdHJpbmcsXHJcbiAgKSB7fVxyXG5cclxuICBwcml2YXRlIGhlYWRlcnMoZXh0cmE6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fSk6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4ge1xyXG4gICAgcmV0dXJuIHsgJ3gtaG1oLWtleSc6IHRoaXMudG9rZW4sIC4uLmV4dHJhIH07XHJcbiAgfVxyXG5cclxuICBhc3luYyBnZXRKc29uPFQ+KHBhdGg6IHN0cmluZywgdGltZW91dE1zID0gNV8wMDApOiBQcm9taXNlPFQ+IHtcclxuICAgIGxldCByZXM6IFJlc3BvbnNlO1xyXG4gICAgdHJ5IHtcclxuICAgICAgcmVzID0gYXdhaXQgZmV0Y2goYCR7dGhpcy5iYXNlVXJsfSR7cGF0aH1gLCB7IGhlYWRlcnM6IHRoaXMuaGVhZGVycygpLCBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQodGltZW91dE1zKSB9KTtcclxuICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYHJlcXVlc3QgZmFpbGVkOiAke1N0cmluZyhlcnIpLnNsaWNlKDAsIDE2MCl9YCwgeyByZXRyeWFibGU6IHRydWUsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gdGhpcy5wYXJzZVJlc3BvbnNlPFQ+KHJlcyk7XHJcbiAgfVxyXG5cclxuICAvKiogXHU2MkM5XHU1M0Q2XHU3RUFGXHU2NTg3XHU2NzJDXHU3QUVGXHU3MEI5KFx1NTk4MiAvYXBpL3Nlc3Npb25zLzppZC9leHBvcnQubWQpXHUzMDAyICovXHJcbiAgYXN5bmMgZ2V0VGV4dChwYXRoOiBzdHJpbmcsIHRpbWVvdXRNcyA9IDEwXzAwMCk6IFByb21pc2U8c3RyaW5nPiB7XHJcbiAgICBsZXQgcmVzOiBSZXNwb25zZTtcclxuICAgIHRyeSB7XHJcbiAgICAgIHJlcyA9IGF3YWl0IGZldGNoKGAke3RoaXMuYmFzZVVybH0ke3BhdGh9YCwgeyBoZWFkZXJzOiB0aGlzLmhlYWRlcnMoKSwgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KHRpbWVvdXRNcykgfSk7XHJcbiAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGByZXF1ZXN0IGZhaWxlZDogJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxNjApfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSB8fCByZXMuc3RhdHVzID09PSA0MDMpIHtcclxuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdBVVRIX0ZBSUxFRCcsIGBob3N0IHJlamVjdGVkIHRoZSBzZXNzaW9uIHRva2VuIChIVFRQICR7cmVzLnN0YXR1c30pYCwgeyByZXRyeWFibGU6IGZhbHNlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xyXG4gICAgfVxyXG4gICAgaWYgKCFyZXMub2spIHtcclxuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBIVFRQICR7cmVzLnN0YXR1c31gLCB7IHJldHJ5YWJsZTogcmVzLnN0YXR1cyA+PSA1MDAgfSkpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHJlcy50ZXh0KCk7XHJcbiAgfVxyXG5cclxuICAvKiogXHU2QkNGXHU0RTJBXHU1RTI2XHU1MjZGXHU0RjVDXHU3NTI4XHU3Njg0IFBPU1QgXHU4MUVBXHU1MkE4XHU2NDNBXHU1RTI2XHU1RTQyXHU3QjQ5XHU5NTJFKDAzIFx1MDBBN1x1NTZEQlx1OTYzMlx1OTFDRFx1NjUzRTpcdThCRjdcdTZDNDJcdTRGN0ZcdTc1MjggaWRlbXBvdGVuY3lLZXk7XHJcbiAgICogIHJ1bnRpbWUgXHU0RkE3XHU3N0VEXHU2NzFGXHU1MTdDXHU1QkI5XHU1RkZEXHU3NTY1LFx1NTM0Rlx1OEJBRVx1NTE0OFx1ODg0Q1x1MjAxNFx1MjAxNFx1OTFDRFx1OEJENVx1NTNFRlx1NTFFRFx1OTUyRVx1NTNCQlx1OTFDRCxcdTRFMERcdTc2RjJcdTc2RUVcdTkxQ0RcdTY1M0UpXHUzMDAyICovXHJcbiAgYXN5bmMgcG9zdEpzb248VD4ocGF0aDogc3RyaW5nLCBib2R5OiB1bmtub3duLCB0aW1lb3V0TXMgPSAxMF8wMDApOiBQcm9taXNlPFQ+IHtcclxuICAgIGxldCByZXM6IFJlc3BvbnNlO1xyXG4gICAgdHJ5IHtcclxuICAgICAgcmVzID0gYXdhaXQgZmV0Y2goYCR7dGhpcy5iYXNlVXJsfSR7cGF0aH1gLCB7XHJcbiAgICAgICAgbWV0aG9kOiAnUE9TVCcsXHJcbiAgICAgICAgaGVhZGVyczogdGhpcy5oZWFkZXJzKHtcclxuICAgICAgICAgICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsXHJcbiAgICAgICAgICAneC1pZGVtcG90ZW5jeS1rZXknOiByYW5kb21VVUlEKCksXHJcbiAgICAgICAgfSksXHJcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoYm9keSksXHJcbiAgICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KHRpbWVvdXRNcyksXHJcbiAgICAgIH0pO1xyXG4gICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgcmVxdWVzdCBmYWlsZWQ6ICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTYwKX1gLCB7IHJldHJ5YWJsZTogdHJ1ZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcclxuICAgIH1cclxuICAgIHJldHVybiB0aGlzLnBhcnNlUmVzcG9uc2U8VD4ocmVzKTtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgYXN5bmMgcGFyc2VSZXNwb25zZTxUPihyZXM6IFJlc3BvbnNlKTogUHJvbWlzZTxUPiB7XHJcbiAgICBpZiAocmVzLnN0YXR1cyA9PT0gNDAxIHx8IHJlcy5zdGF0dXMgPT09IDQwMykge1xyXG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgYGhvc3QgcmVqZWN0ZWQgdGhlIHNlc3Npb24gdG9rZW4gKEhUVFAgJHtyZXMuc3RhdHVzfSlgLCB7IHJldHJ5YWJsZTogZmFsc2UsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XHJcbiAgICB9XHJcbiAgICBjb25zdCB0ZXh0ID0gYXdhaXQgcmVzLnRleHQoKTtcclxuICAgIGxldCBwYXJzZWQ6IHVua25vd24gPSBudWxsO1xyXG4gICAgdHJ5IHtcclxuICAgICAgcGFyc2VkID0gdGV4dCA/IEpTT04ucGFyc2UodGV4dCkgOiBudWxsO1xyXG4gICAgfSBjYXRjaCB7XHJcbiAgICAgIHBhcnNlZCA9IG51bGw7XHJcbiAgICB9XHJcbiAgICBpZiAoIXJlcy5vaykge1xyXG4gICAgICBpZiAoaXNEZXNrdG9wRXJyb3IocGFyc2VkKSkgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IocGFyc2VkKTtcclxuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBIVFRQICR7cmVzLnN0YXR1c306ICR7dGV4dC5zbGljZSgwLCAxNjApfWAsIHsgcmV0cnlhYmxlOiByZXMuc3RhdHVzID49IDUwMCB9KSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gcGFyc2VkIGFzIFQ7XHJcbiAgfVxyXG5cclxuICAvKipcclxuICAgKiBcdThCQTJcdTk2MDVcdTUxNjhcdTkwRTggU1NFIFx1NUUyNyhcdTU0MkJcdTk3NUVcdTRGRTFcdTVDMDFcdTRFOEJcdTRFRjY6ZGVsdGEvbGluZSBcdTdCNDlcdTlBRDhcdTk4OTFcdTZENDEpXHUzMDAyXHU0RkUxXHU1QzAxXHU3NTMxXHU4QzAzXHU3NTI4XHU2NUI5XHJcbiAgICogXHU3NTI4IGVudmVsb3BlRnJvbUZyYW1lIFx1ODFFQVx1ODg0Q1x1NTIwNlx1NkQ0MTtcdTY1QURcdTdFQkZcdTkxQ0RcdThGREVcdThCRURcdTRFNDlcdTU0MEMgZXZlbnRzKClcdTMwMDJcclxuICAgKi9cclxuICBhc3luYyAqcmF3RXZlbnRzKGxhc3RFdmVudElkPzogc3RyaW5nLCBzaWduYWw/OiBBYm9ydFNpZ25hbCk6IEFzeW5jR2VuZXJhdG9yPFNzZUZyYW1lPiB7XHJcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgJHt0aGlzLmJhc2VVcmx9L2FwaS9ldmVudHNgLCB7XHJcbiAgICAgIGhlYWRlcnM6IHRoaXMuaGVhZGVycyh7XHJcbiAgICAgICAgYWNjZXB0OiAndGV4dC9ldmVudC1zdHJlYW0nLFxyXG4gICAgICAgIC4uLihsYXN0RXZlbnRJZCAhPT0gdW5kZWZpbmVkID8geyAnbGFzdC1ldmVudC1pZCc6IGxhc3RFdmVudElkIH0gOiB7fSksXHJcbiAgICAgIH0pLFxyXG4gICAgICAuLi4oc2lnbmFsICE9PSB1bmRlZmluZWQgPyB7IHNpZ25hbCB9IDoge30pLFxyXG4gICAgfSk7XHJcbiAgICBpZiAocmVzLnN0YXR1cyA9PT0gNDAxIHx8IHJlcy5zdGF0dXMgPT09IDQwMykge1xyXG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgYGhvc3QgcmVqZWN0ZWQgdGhlIHNlc3Npb24gdG9rZW4gKEhUVFAgJHtyZXMuc3RhdHVzfSlgLCB7IHJldHJ5YWJsZTogZmFsc2UsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XHJcbiAgICB9XHJcbiAgICBpZiAoIXJlcy5vayB8fCByZXMuYm9keSA9PT0gbnVsbCkge1xyXG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYFNTRSBIVFRQICR7cmVzLnN0YXR1c31gLCB7IHJldHJ5YWJsZTogdHJ1ZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHJlYWRlciA9IHJlcy5ib2R5LmdldFJlYWRlcigpO1xyXG4gICAgY29uc3QgZGVjb2RlciA9IG5ldyBUZXh0RGVjb2RlcigpO1xyXG4gICAgbGV0IGJ1ZmZlciA9ICcnO1xyXG4gICAgZm9yICg7Oykge1xyXG4gICAgICBjb25zdCB7IGRvbmUsIHZhbHVlIH0gPSBhd2FpdCByZWFkZXIucmVhZCgpO1xyXG4gICAgICBpZiAoZG9uZSkgcmV0dXJuO1xyXG4gICAgICBidWZmZXIgKz0gZGVjb2Rlci5kZWNvZGUodmFsdWUsIHsgc3RyZWFtOiB0cnVlIH0pO1xyXG4gICAgICBsZXQgaWR4OiBudW1iZXI7XHJcbiAgICAgIHdoaWxlICgoaWR4ID0gYnVmZmVyLmluZGV4T2YoJ1xcblxcbicpKSAhPT0gLTEpIHtcclxuICAgICAgICBjb25zdCBibG9jayA9IGJ1ZmZlci5zbGljZSgwLCBpZHgpO1xyXG4gICAgICAgIGJ1ZmZlciA9IGJ1ZmZlci5zbGljZShpZHggKyAyKTtcclxuICAgICAgICBmb3IgKGNvbnN0IGZyYW1lIG9mIHBhcnNlU3NlQ2h1bmsoYmxvY2spKSB5aWVsZCBmcmFtZTtcclxuICAgICAgfVxyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgLyoqXHJcbiAgICogXHU4QkEyXHU5NjA1IFNTRSBcdTRFOEJcdTRFRjZcdTZENDEoYXN5bmMgaXRlcmF0b3IpXHUzMDAyXHU2NUFEXHU3RUJGXHU3NTMxXHU4QzAzXHU3NTI4XHU2NUI5XHU5MUNEXHU4RkRFO1x1OTFDRFx1OEZERVx1NjVGNlx1NjI4QVx1NjcwMFx1NTQwRVxyXG4gICAqIFx1NjUzNlx1NTIzMFx1NzY4NCBldmVudElkIFx1NEYyMFx1NTE2NSBsYXN0RXZlbnRJZCxob3N0IFx1N0FFRlx1NEVDRVx1OTFDRFx1NjUzRVx1NzNBRlx1ODg2NVx1NTNEMVx1MzAwMlxyXG4gICAqL1xyXG4gIGFzeW5jICpldmVudHMobGFzdEV2ZW50SWQ/OiBzdHJpbmcsIHNpZ25hbD86IEFib3J0U2lnbmFsKTogQXN5bmNHZW5lcmF0b3I8RXZlbnRFbnZlbG9wZT4ge1xyXG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYCR7dGhpcy5iYXNlVXJsfS9hcGkvZXZlbnRzYCwge1xyXG4gICAgICBoZWFkZXJzOiB0aGlzLmhlYWRlcnMoe1xyXG4gICAgICAgIGFjY2VwdDogJ3RleHQvZXZlbnQtc3RyZWFtJyxcclxuICAgICAgICAuLi4obGFzdEV2ZW50SWQgIT09IHVuZGVmaW5lZCA/IHsgJ2xhc3QtZXZlbnQtaWQnOiBsYXN0RXZlbnRJZCB9IDoge30pLFxyXG4gICAgICB9KSxcclxuICAgICAgLi4uKHNpZ25hbCAhPT0gdW5kZWZpbmVkID8geyBzaWduYWwgfSA6IHt9KSxcclxuICAgIH0pO1xyXG4gICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSB8fCByZXMuc3RhdHVzID09PSA0MDMpIHtcclxuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdBVVRIX0ZBSUxFRCcsIGBob3N0IHJlamVjdGVkIHRoZSBzZXNzaW9uIHRva2VuIChIVFRQICR7cmVzLnN0YXR1c30pYCwgeyByZXRyeWFibGU6IGZhbHNlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xyXG4gICAgfVxyXG4gICAgaWYgKCFyZXMub2sgfHwgIXJlcy5ib2R5KSB7XHJcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgU1NFIEhUVFAgJHtyZXMuc3RhdHVzfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgcmVhZGVyID0gcmVzLmJvZHkuZ2V0UmVhZGVyKCk7XHJcbiAgICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKCk7XHJcbiAgICBsZXQgYnVmZmVyID0gJyc7XHJcbiAgICBmb3IgKDs7KSB7XHJcbiAgICAgIGNvbnN0IHsgZG9uZSwgdmFsdWUgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XHJcbiAgICAgIGlmIChkb25lKSByZXR1cm47XHJcbiAgICAgIGJ1ZmZlciArPSBkZWNvZGVyLmRlY29kZSh2YWx1ZSwgeyBzdHJlYW06IHRydWUgfSk7XHJcbiAgICAgIC8vIFx1NEVFNVx1N0E3QVx1ODg0Q1x1NTIwNlx1NUUyNztcdTRGRERcdTc1NTlcdTRFMERcdTVCOENcdTY1NzRcdTc2ODRcdTVDM0VcdTkwRThcclxuICAgICAgbGV0IGlkeDogbnVtYmVyO1xyXG4gICAgICB3aGlsZSAoKGlkeCA9IGJ1ZmZlci5pbmRleE9mKCdcXG5cXG4nKSkgIT09IC0xKSB7XHJcbiAgICAgICAgY29uc3QgYmxvY2sgPSBidWZmZXIuc2xpY2UoMCwgaWR4KTtcclxuICAgICAgICBidWZmZXIgPSBidWZmZXIuc2xpY2UoaWR4ICsgMik7XHJcbiAgICAgICAgZm9yIChjb25zdCBmcmFtZSBvZiBwYXJzZVNzZUNodW5rKGJsb2NrKSkge1xyXG4gICAgICAgICAgY29uc3QgZW52ID0gZW52ZWxvcGVGcm9tRnJhbWUoZnJhbWUpO1xyXG4gICAgICAgICAgaWYgKGVudiAhPT0gbnVsbCkgeWllbGQgZW52O1xyXG4gICAgICAgIH1cclxuICAgICAgfVxyXG4gICAgfVxyXG4gIH1cclxufVxyXG4iLCAiLyoqXHJcbiAqIGZha2UgaG9zdCBcdTIwMTQgaG1oYXJuZXNzIHJ1bnRpbWUgXHU3Njg0XHU2RDRCXHU4QkQ1XHU2NkZGXHU4RUFCKE1hc3RlclByb21wdCBcdTk2MzZcdTZCQjUgRC9FOlxyXG4gKiBcIlx1NTE0OFx1NEY3Rlx1NzUyOCBmYWtlIGhvc3QgXHU3RjE2XHU1MTk5XHU3MkI2XHU2MDAxXHU2NzNBXHU2RDRCXHU4QkQ1LFx1NTE4RFx1NjNBNVx1NzcxRlx1NUI5RSBBUElcIjtcdTk2MzZcdTZCQjUgRSBcdTc2ODRcdTRGMUFcdThCRERcdTdFQjVcdTUyMDdcdTcyNDdcclxuICogZTJlIFx1NEU1Rlx1NTE0OFx1NTcyOCBmYWtlIFx1NUM0Mlx1OTVFRFx1NzNBRilcdTMwMDJcclxuICpcclxuICogXHU2ODRDXHU5NzYyIGhvc3QgXHU1NDA4XHU1NDBDOlxyXG4gKiAgLSBcdTUzRUFcdTdFRDEgMTI3LjAuMC4xLFx1N0FFRlx1NTNFMyBPUyBcdTUyMDZcdTkxNEQsXHU1QjlFXHU5NjQ1XHU3QUVGXHU1M0UzXHU1MTk5IHN0ZG91dCBcdTVGMTVcdTVCRkNcdTg4NEM7XHJcbiAqICAtIFx1NjI0MFx1NjcwOSAvYXBpLyogXHU4OTgxXHU2QzQyIFgtSG1oLUtleSA9PT0gSE1IX0RFU0tUT1BfVE9LRU4sXHU1NDI2XHU1MjE5IDQwMSArIERlc2t0b3BFcnJvcjtcclxuICogIC0gR0VUIC9hcGkvc3RhdGUgXHU1MDY1XHU1RUI3XHU2M0EyXHU2RDRCO0dFVCAvYXBpL2V2ZW50cyBTU0UoZXZlbnQ6IGhtaCBcdTRGRTFcdTVDMDFcdTZENDEgKyBcdTkxQ0RcdTY1M0VcdTczQUYpO1xyXG4gKiAgLSBQT1NUIC9hcGkvZGVza3RvcC9zaHV0ZG93biBcdTRGMThcdTk2QzVcdTkwMDBcdTUxRkFcdTMwMDJcclxuICpcclxuICogXHU5NjM2XHU2QkI1IEUgXHU2QTIxXHU2MkRGXHU5NzYyKFx1NEUwRSBobWhhcm5lc3MgZGVza3RvcCBcdTZBMjFcdTVGMEZcdTU0MENcdTVGNjIpOlxyXG4gKiAgLSBQT1NUIC9hcGkvdGFzayB7dGV4dCwgc2Vzc2lvbklkLCBtb2RlfTpcdTYzOTJcdTk2MUZcdTVFNzZcdTYzMDlcdTgxMUFcdTY3MkNcdTUzRDFcclxuICogICAgcnVuLnN0YXJ0ZWQgXHUyMTkyIHRvb2wuc3RhcnRlZC9jb21wbGV0ZWQgXHUyMTkyKG1vZGU9PT0nYXNrJyBcdTY1RjYpXHJcbiAqICAgIGFwcHJvdmFsLnJlcXVpcmVkKFx1N0I0OSAvYXBpL2FwcHJvdmUpXHUyMTkyIHJ1bi5jb21wbGV0ZWQ7XHJcbiAqICAtIFBPU1QgL2FwaS9hcHByb3ZlIHtncmFudGVkLCBzZXNzaW9uSWR9O1xyXG4gKiAgLSBQT1NUIC9hcGkvaW50ZXJydXB0IHtzZXNzaW9uSWR9O1xyXG4gKiAgLSBHRVQgL2FwaS9zZXNzaW9uc1x1MzAwMlxyXG4gKlxyXG4gKiBcdTZENEJcdThCRDVcdTk0QTlcdTVCNTA6RkFLRV9IT1NUX0RJRV9BRlRFUl9NUyAvIEZBS0VfSE9TVF9ESUVfQVRfQk9PVCAvXHJcbiAqIEZBS0VfSE9TVF9FWFBFQ1RfVE9LRU4gLyBGQUtFX0hPU1RfVEFTS19ERUxBWV9NUyAvIEZBS0VfSE9TVF9UQVNLX0ZBSUw9MVxyXG4gKiAoXHU0RUZCXHU1MkExXHU0RUU1IHJ1bi5mYWlsZWQgXHU3RUQzXHU2NzVGLFx1Njc4NFx1OTAyMFx1OTUxOVx1OEJFRlx1NjA2Mlx1NTkwRFx1NTczQVx1NjY2RilcdTMwMDJcclxuICovXHJcbmltcG9ydCB7IGNyZWF0ZVNlcnZlciwgdHlwZSBTZXJ2ZXJSZXNwb25zZSB9IGZyb20gJ25vZGU6aHR0cCc7XHJcbmltcG9ydCB7IHJhbmRvbVVVSUQgfSBmcm9tICdub2RlOmNyeXB0byc7XHJcbmltcG9ydCB7IHBhdGhUb0ZpbGVVUkwgfSBmcm9tICdub2RlOnVybCc7XHJcbmltcG9ydCB7IHJlYWxwYXRoU3luYyB9IGZyb20gJ25vZGU6ZnMnO1xyXG5pbXBvcnQgeyBFVkVOVF9TQ0hFTUFfVkVSU0lPTiwgZGVza3RvcEVycm9yLCB0eXBlIEV2ZW50RW52ZWxvcGUsIHR5cGUgRXZlbnRLaW5kIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyc7XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIEZha2VIb3N0SGFuZGxlIHtcclxuICBwb3J0OiBudW1iZXI7XHJcbiAgZW1pdChzZXNzaW9uSWQ6IHN0cmluZywgcnVuSWQ6IHN0cmluZywga2luZDogRXZlbnRLaW5kLCBwYXlsb2FkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IG51bWJlcjtcclxuICBjbG9zZSgpOiBQcm9taXNlPHZvaWQ+O1xyXG59XHJcblxyXG5pbnRlcmZhY2UgRmFrZVNlc3Npb24ge1xyXG4gIGlkOiBzdHJpbmc7XHJcbiAgY3JlYXRlZEF0OiBzdHJpbmc7XHJcbiAgdXBkYXRlZEF0OiBzdHJpbmc7XHJcbn1cclxuXHJcbmludGVyZmFjZSBQZW5kaW5nQXBwcm92YWwge1xyXG4gIHNlc3Npb25JZDogc3RyaW5nO1xyXG4gIGFwcHJvdmFsSWQ6IHN0cmluZztcclxuICByZXNvbHZlKGdyYW50ZWQ6IGJvb2xlYW4pOiB2b2lkO1xyXG59XHJcblxyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc3RhcnRGYWtlSG9zdChvcHRzOiB7IHRva2VuOiBzdHJpbmc7IHF1aWV0PzogYm9vbGVhbiB9KTogUHJvbWlzZTxGYWtlSG9zdEhhbmRsZT4ge1xyXG4gIGNvbnN0IHRva2VuID0gb3B0cy50b2tlbjtcclxuICAvLyBcdTZENEJcdThCRDVcdTk0QTlcdTVCNTA6RkFLRV9IT1NUX0VYUEVDVF9UT0tFTiBcdThCQTkgaG9zdCBcdTY4MjFcdTlBOENcdTRFMDBcdTRFMkFcdTRFMEUgSE1IX0RFU0tUT1BfVE9LRU5cclxuICAvLyBcdTRFMERcdTU0MENcdTc2ODRcdTUwM0MoXHU2Nzg0XHU5MDIwIEFVVEhfRkFJTEVEIFx1NTczQVx1NjY2RjtzdXBlcnZpc29yIFx1NjAzQlx1NjYyRlx1ODk4Nlx1NzZENiBITUhfREVTS1RPUF9UT0tFTilcclxuICBjb25zdCBleHBlY3RlZCA9IHByb2Nlc3MuZW52LkZBS0VfSE9TVF9FWFBFQ1RfVE9LRU4gPz8gdG9rZW47XHJcbiAgY29uc3QgdGFza0RlbGF5ID0gTnVtYmVyKHByb2Nlc3MuZW52LkZBS0VfSE9TVF9UQVNLX0RFTEFZX01TID8/IDMwKTtcclxuICBjb25zdCBmYWlsVGFza3MgPSBwcm9jZXNzLmVudi5GQUtFX0hPU1RfVEFTS19GQUlMID09PSAnMSc7XHJcblxyXG4gIGNvbnN0IHNzZUNsaWVudHMgPSBuZXcgU2V0PFNlcnZlclJlc3BvbnNlPigpO1xyXG4gIGNvbnN0IHNlcUJ5UnVuID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcclxuICAvLyBcdTkxQ0RcdTY1M0VcdTczQUY6XHU2NzAwXHU4RkQxIDIwMCBcdTVFMjcoTGFzdC1FdmVudC1JRCBcdTY1QURcdTdFQkZcdTg4NjVcdTYyQzkpLFx1NEUwRSBobWhhcm5lc3Mgd2ViIFx1NTQwQ1x1NkIzRVx1OEJFRFx1NEU0OVxyXG4gIGNvbnN0IHJpbmc6IEFycmF5PHsgaWQ6IG51bWJlcjsgZXZlbnQ6IHN0cmluZzsgZGF0YTogdW5rbm93biB9PiA9IFtdO1xyXG4gIGxldCByaW5nU2VxID0gMDtcclxuICBjb25zdCBzZXNzaW9ucyA9IG5ldyBNYXA8c3RyaW5nLCBGYWtlU2Vzc2lvbj4oKTtcclxuICBsZXQgcGVuZGluZzogUGVuZGluZ0FwcHJvdmFsIHwgbnVsbCA9IG51bGw7XHJcbiAgY29uc3QgcnVuVGltZXJzID0gbmV3IE1hcDxzdHJpbmcsIE5vZGVKUy5UaW1lb3V0PigpO1xyXG4gIC8vIFx1NURFNVx1NEY1Q1x1NTMzQS9Qcm92aWRlciBcdTcyQjZcdTYwMDEoXHU0RTBFIGhtaGFybmVzcyBcdTU0MENcdTVGNjJcdTc2ODRcdTY3MDBcdTVDMEZcdTZBMjFcdTYyREYpXHJcbiAgY29uc3QgZmFrZVdvcmtzcGFjZXMgPSB7XHJcbiAgICBjdXJyZW50OiAnd3MtZGVtbycsXHJcbiAgICBpdGVtczogW1xyXG4gICAgICB7IGlkOiAnd3MtZGVtbycsIG5hbWU6ICdkZW1vLXdvcmtzcGFjZScsIHBhdGg6ICdDOlxcXFxkZW1vJyB9LFxyXG4gICAgXSxcclxuICB9O1xyXG4gIGNvbnN0IGZha2VQcm92aWRlcnMgPSBuZXcgTWFwPHN0cmluZywgeyBiYXNlVXJsOiBzdHJpbmc7IG1vZGVsOiBzdHJpbmc7IGFwaUtleTogc3RyaW5nIH0+KFtcclxuICAgIFsnZGVtbycsIHsgYmFzZVVybDogJ2h0dHA6Ly8xMjcuMC4wLjE6OS92MScsIG1vZGVsOiAnZmFrZS1tJywgYXBpS2V5OiAnc2stZGVtby0xMjM0JyB9XSxcclxuICAgIFsnZGVtby12aXNpb24nLCB7IGJhc2VVcmw6ICdodHRwOi8vMTI3LjAuMC4xOjkvdjEnLCBtb2RlbDogJ2Zha2UtbS12aXNpb24nLCBhcGlLZXk6ICdzay1kZW1vLTU2NzgnIH1dLFxyXG4gIF0pO1xyXG4gIGxldCBmYWtlQ2hhdFByb3ZpZGVyID0gJ2RlbW8nO1xyXG5cclxuICBjb25zdCBlbWl0ID0gKHNlc3Npb25JZDogc3RyaW5nLCBydW5JZDogc3RyaW5nLCBraW5kOiBFdmVudEtpbmQsIHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogbnVtYmVyID0+IHtcclxuICAgIGNvbnN0IGtleSA9IGAke3Nlc3Npb25JZH1cXDAke3J1bklkfWA7XHJcbiAgICBjb25zdCBzZXEgPSAoc2VxQnlSdW4uZ2V0KGtleSkgPz8gMCkgKyAxO1xyXG4gICAgc2VxQnlSdW4uc2V0KGtleSwgc2VxKTtcclxuICAgIGNvbnN0IGVudjogRXZlbnRFbnZlbG9wZSA9IHtcclxuICAgICAgc2NoZW1hVmVyc2lvbjogRVZFTlRfU0NIRU1BX1ZFUlNJT04sXHJcbiAgICAgIGV2ZW50SWQ6IHJhbmRvbVVVSUQoKSxcclxuICAgICAgc2Vzc2lvbklkLFxyXG4gICAgICBydW5JZCxcclxuICAgICAgc2VxLFxyXG4gICAgICBvY2N1cnJlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXHJcbiAgICAgIGtpbmQsXHJcbiAgICAgIHBheWxvYWQsXHJcbiAgICB9O1xyXG4gICAgY29uc3QgaWQgPSArK3JpbmdTZXE7XHJcbiAgICByaW5nLnB1c2goeyBpZCwgZXZlbnQ6ICdobWgnLCBkYXRhOiBlbnYgfSk7XHJcbiAgICBpZiAocmluZy5sZW5ndGggPiAyMDApIHJpbmcuc3BsaWNlKDAsIHJpbmcubGVuZ3RoIC0gMjAwKTtcclxuICAgIGZvciAoY29uc3QgYyBvZiBzc2VDbGllbnRzKSB7XHJcbiAgICAgIGMud3JpdGUoYGlkOiAke2lkfVxcbmV2ZW50OiBobWhcXG5kYXRhOiAke0pTT04uc3RyaW5naWZ5KGVudil9XFxuXFxuYCk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gc2VxO1xyXG4gIH07XHJcblxyXG4gIGNvbnN0IHRvdWNoID0gKHNlc3Npb25JZDogc3RyaW5nKTogRmFrZVNlc3Npb24gPT4ge1xyXG4gICAgbGV0IHMgPSBzZXNzaW9ucy5nZXQoc2Vzc2lvbklkKTtcclxuICAgIGlmIChzID09PSB1bmRlZmluZWQpIHtcclxuICAgICAgcyA9IHsgaWQ6IHNlc3Npb25JZCwgY3JlYXRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksIHVwZGF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpIH07XHJcbiAgICAgIHNlc3Npb25zLnNldChzZXNzaW9uSWQsIHMpO1xyXG4gICAgfVxyXG4gICAgcy51cGRhdGVkQXQgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XHJcbiAgICByZXR1cm4gcztcclxuICB9O1xyXG5cclxuICAvKiogXHU2QTIxXHU2MkRGXHU0RTAwXHU2QjIxXHU0RUZCXHU1MkExOlx1NjI3OVx1NTFDNlx1NkEyMVx1NUYwRlx1NjMwMlx1OEQ3N1x1N0I0OVx1NUY4NSAvYXBpL2FwcHJvdmVcdTMwMDIgKi9cclxuICBjb25zdCBydW5UYXNrID0gKHNlc3Npb25JZDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcsIG1vZGU6IHN0cmluZyk6IHN0cmluZyA9PiB7XHJcbiAgICBjb25zdCBydW5JZCA9IGBydW4tJHtEYXRlLm5vdygpLnRvU3RyaW5nKDM2KX0tJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCA4KX1gO1xyXG4gICAgdG91Y2goc2Vzc2lvbklkKTtcclxuICAgIGNvbnN0IHN0ZXBzOiBBcnJheTwoKSA9PiB2b2lkPiA9IFtdO1xyXG4gICAgY29uc3Qgd2FpdCA9IChmbjogKCkgPT4gdm9pZCwgbXMgPSB0YXNrRGVsYXkpOiB2b2lkID0+IHtcclxuICAgICAgY29uc3QgdCA9IHNldFRpbWVvdXQoZm4sIG1zKTtcclxuICAgICAgcnVuVGltZXJzLnNldChgJHtzZXNzaW9uSWR9XFwwJHtydW5JZH1gLCB0KTtcclxuICAgIH07XHJcbiAgICBjb25zdCBjaGFpbiA9IChmbnM6IEFycmF5PCgpID0+IHZvaWQ+KTogdm9pZCA9PiB7XHJcbiAgICAgIGNvbnN0IFtmaXJzdCwgLi4ucmVzdF0gPSBmbnM7XHJcbiAgICAgIGlmIChmaXJzdCA9PT0gdW5kZWZpbmVkKSByZXR1cm47XHJcbiAgICAgIHdhaXQoKCkgPT4ge1xyXG4gICAgICAgIGZpcnN0KCk7XHJcbiAgICAgICAgY2hhaW4ocmVzdCk7XHJcbiAgICAgIH0pO1xyXG4gICAgfTtcclxuXHJcbiAgICBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICdydW4uc3RhcnRlZCcsIHsgdGFzazogdGV4dCwgbW9kZSB9KTtcclxuICAgIGlmIChmYWlsVGFza3MpIHtcclxuICAgICAgd2FpdCgoKSA9PiBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICdydW4uZmFpbGVkJywge1xyXG4gICAgICAgIGVycm9yOiB7IGNvZGU6ICdBVVRIX0ZBSUxFRCcsIG1lc3NhZ2U6ICdzaW11bGF0ZWQgcHJvdmlkZXIgYXV0aCBmYWlsdXJlJywgcmV0cnlhYmxlOiBmYWxzZSB9LFxyXG4gICAgICB9KSk7XHJcbiAgICAgIHJldHVybiBydW5JZDtcclxuICAgIH1cclxuXHJcbiAgICBjb25zdCBmaW5pc2hSdW4gPSAoYW5zd2VyOiBzdHJpbmcsIHRvb2xVc2VzOiBudW1iZXIpOiB2b2lkID0+IHtcclxuICAgICAgcnVuVGltZXJzLmRlbGV0ZShgJHtzZXNzaW9uSWR9XFwwJHtydW5JZH1gKTtcclxuICAgICAgLy8gXHU0RUE0XHU0RUQ4XHU3MjY5XHU1MTQ4XHU0RThFXHU3RUM4XHU2MDAxKFx1NEUwRSBobWhhcm5lc3MgZGVza3RvcCBcdTY4NjVcdTU0MENcdTVFOEY6YXJ0aWZhY3QuY3JlYXRlZCBcdTIxOTIgcnVuLmNvbXBsZXRlZClcclxuICAgICAgZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAnYXJ0aWZhY3QuY3JlYXRlZCcsIHtcclxuICAgICAgICBhcnRpZmFjdDogeyByZWxQYXRoOiAnb3V0LnR4dCcsIGtpbmQ6ICdmaWxlJywgdGl0bGU6ICdvdXQudHh0JyB9LFxyXG4gICAgICB9KTtcclxuICAgICAgZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAncnVuLmNvbXBsZXRlZCcsIHsgdGV4dDogYW5zd2VyLCB0dXJuczogMSwgdG9vbFVzZXMgfSk7XHJcbiAgICB9O1xyXG5cclxuICAgIGNvbnN0IHNjcmlwdGVkOiBBcnJheTwoKSA9PiB2b2lkPiA9IFtcclxuICAgICAgKCkgPT4gZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAndG9vbC5zdGFydGVkJywgeyBuYW1lOiAncmVhZF9maWxlJywgYXJnc1ByZXZpZXc6ICd7XCJwYXRoXCI6XCJSRUFETUUubWRcIn0nIH0pLFxyXG4gICAgICAoKSA9PiBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICd0b29sLmNvbXBsZXRlZCcsIHsgbmFtZTogJ3JlYWRfZmlsZScsIGlzRXJyb3I6IGZhbHNlLCBvdXRwdXRQcmV2aWV3OiAnIyBkZW1vJyB9KSxcclxuICAgIF07XHJcblxyXG4gICAgaWYgKG1vZGUgPT09ICdhc2snKSB7XHJcbiAgICAgIHNjcmlwdGVkLnB1c2goKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IGFwcHJvdmFsSWQgPSBgYXAtJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCA4KX1gO1xyXG4gICAgICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ2FwcHJvdmFsLnJlcXVpcmVkJywge1xyXG4gICAgICAgICAgYXBwcm92YWxJZCxcclxuICAgICAgICAgIHRvb2w6ICd3cml0ZV9maWxlJyxcclxuICAgICAgICAgIGFyZ3NQcmV2aWV3OiAne1wicGF0aFwiOlwib3V0LnR4dFwiLFwiY29udGVudFwiOlwiaGlcIn0nLFxyXG4gICAgICAgICAgcmlzazogJ1x1NTE5OVx1NTE2NVx1NURFNVx1NEY1Q1x1NTMzQVx1NjU4N1x1NEVGNiBvdXQudHh0KFx1NkEyMVx1NjJERiknLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHBlbmRpbmcgPSB7XHJcbiAgICAgICAgICBzZXNzaW9uSWQsXHJcbiAgICAgICAgICBhcHByb3ZhbElkLFxyXG4gICAgICAgICAgcmVzb2x2ZTogKGdyYW50ZWQpID0+IHtcclxuICAgICAgICAgICAgcGVuZGluZyA9IG51bGw7XHJcbiAgICAgICAgICAgIGlmIChncmFudGVkKSB7XHJcbiAgICAgICAgICAgICAgZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAndG9vbC5zdGFydGVkJywgeyBuYW1lOiAnd3JpdGVfZmlsZScsIGFyZ3NQcmV2aWV3OiAne1wicGF0aFwiOlwib3V0LnR4dFwifScgfSk7XHJcbiAgICAgICAgICAgICAgd2FpdCgoKSA9PiBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICd0b29sLmNvbXBsZXRlZCcsIHsgbmFtZTogJ3dyaXRlX2ZpbGUnLCBpc0Vycm9yOiBmYWxzZSwgb3V0cHV0UHJldmlldzogJ3dyb3RlIDIgYnl0ZXMnIH0pKTtcclxuICAgICAgICAgICAgICB3YWl0KCgpID0+IGZpbmlzaFJ1bihgZWNobzogJHt0ZXh0fShcdTVERjJcdTYyNjdcdTg4NENcdTUxOTlcdTUxNjUpYCwgMyksIHRhc2tEZWxheSAqIDIpO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgIGZpbmlzaFJ1bihgZWNobzogJHt0ZXh0fShcdTVCQTFcdTYyNzlcdTg4QUJcdTYyRDJcdTdFREQsXHU2NzJBXHU2MjY3XHU4ODRDXHU1MTk5XHU1MTY1KWAsIDEpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICB9LFxyXG4gICAgICAgIH07XHJcbiAgICAgIH0pO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgc2NyaXB0ZWQucHVzaCgoKSA9PiBmaW5pc2hSdW4oYGVjaG86ICR7dGV4dH1gLCAxKSk7XHJcbiAgICB9XHJcbiAgICBjaGFpbihzY3JpcHRlZCk7XHJcbiAgICByZXR1cm4gcnVuSWQ7XHJcbiAgfTtcclxuXHJcbiAgY29uc3Qgc2VydmVyID0gY3JlYXRlU2VydmVyKChyZXEsIHJlcykgPT4ge1xyXG4gICAgY29uc3QgdXJsID0gbmV3IFVSTChyZXEudXJsID8/ICcvJywgJ2h0dHA6Ly8xMjcuMC4wLjEnKTtcclxuICAgIGNvbnN0IGF1dGhvcml6ZWQgPSByZXEuaGVhZGVyc1sneC1obWgta2V5J10gPT09IGV4cGVjdGVkO1xyXG4gICAgY29uc3QgZGVueSA9ICgpOiB2b2lkID0+IHtcclxuICAgICAgcmVzLndyaXRlSGVhZCg0MDEsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgJ21pc3Npbmcgb3IgaW52YWxpZCB4LWhtaC1rZXknLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcclxuICAgIH07XHJcblxyXG4gICAgY29uc3QgcmVhZEJvZHkgPSAoKTogUHJvbWlzZTxzdHJpbmc+ID0+XHJcbiAgICAgIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XHJcbiAgICAgICAgbGV0IGIgPSAnJztcclxuICAgICAgICByZXEub24oJ2RhdGEnLCAoYzogQnVmZmVyKSA9PiB7IGIgKz0gYy50b1N0cmluZygpOyB9KTtcclxuICAgICAgICByZXEub24oJ2VuZCcsICgpID0+IHJlc29sdmUoYikpO1xyXG4gICAgICB9KTtcclxuXHJcbiAgICBpZiAodXJsLnBhdGhuYW1lID09PSAnL2FwaS9ldmVudHMnKSB7XHJcbiAgICAgIGlmICghYXV0aG9yaXplZCkgeyBkZW55KCk7IHJldHVybjsgfVxyXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ3RleHQvZXZlbnQtc3RyZWFtJywgJ2NhY2hlLWNvbnRyb2wnOiAnbm8tY2FjaGUnLCBjb25uZWN0aW9uOiAna2VlcC1hbGl2ZScgfSk7XHJcbiAgICAgIHJlcy5mbHVzaEhlYWRlcnM/LigpO1xyXG4gICAgICBzc2VDbGllbnRzLmFkZChyZXMpO1xyXG4gICAgICAvLyBcdTY1QURcdTdFQkZcdTg4NjVcdTYyQzk6TGFzdC1FdmVudC1JRCBcdTRFNEJcdTUyNERcdTc2ODRcdTVFMjdcdTVERjJcdTU3MjhcdTVCQTJcdTYyMzdcdTdBRUYsXHU5MUNEXHU1M0QxXHU1MTc2XHU1NDBFXHU3Njg0XHU3M0FGXHU1RjYyXHU3RjEzXHU1MUIyXHJcbiAgICAgIGNvbnN0IGxhc3RJZCA9IE51bWJlcihyZXEuaGVhZGVyc1snbGFzdC1ldmVudC1pZCddID8/IDApO1xyXG4gICAgICBpZiAoTnVtYmVyLmlzRmluaXRlKGxhc3RJZCkgJiYgbGFzdElkID4gMCkge1xyXG4gICAgICAgIGZvciAoY29uc3QgZSBvZiByaW5nKSB7XHJcbiAgICAgICAgICBpZiAoZS5pZCA+IGxhc3RJZCkgcmVzLndyaXRlKGBpZDogJHtlLmlkfVxcbmV2ZW50OiAke2UuZXZlbnR9XFxuZGF0YTogJHtKU09OLnN0cmluZ2lmeShlLmRhdGEpfVxcblxcbmApO1xyXG4gICAgICAgIH1cclxuICAgICAgfVxyXG4gICAgICByZXEub24oJ2Nsb3NlJywgKCkgPT4gc3NlQ2xpZW50cy5kZWxldGUocmVzKSk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmICghYXV0aG9yaXplZCkgeyBkZW55KCk7IHJldHVybjsgfVxyXG5cclxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3N0YXRlJykge1xyXG4gICAgICAvLyBwcm92aWRlcnNEZXRhaWw6XHU0RTBFIGhtaGFybmVzcyBcdTU0MENcdTVGNjJcdTIwMTRcdTIwMTRrZXkgXHU1M0VBXHU1MUZBIGhhc0tleS9cdTY3MkJcdTU2REJcdTRGNEQsXHU2QzM4XHU0RTBEXHU2NjBFXHU2NTg3XHJcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xyXG4gICAgICAgIGRhZW1vblZlcnNpb246ICdmYWtlLTAuMC4wJywgZGVza3RvcDogdHJ1ZSwgbW9kZWw6IGZha2VQcm92aWRlcnMuZ2V0KGZha2VDaGF0UHJvdmlkZXIpPy5tb2RlbCA/PyAnZmFrZS1tb2RlbCcsXHJcbiAgICAgICAgY2hhdFByb3ZpZGVyOiBmYWtlQ2hhdFByb3ZpZGVyLCBsb2NhbGU6ICd6aCcsXHJcbiAgICAgICAgYnVzeVNlc3Npb25zOiBbLi4uc2Vzc2lvbnMua2V5cygpXS5zbGljZSgwLCAyKSxcclxuICAgICAgICBhcHByb3ZhbFBlbmRpbmc6IHBlbmRpbmcgIT09IG51bGwsXHJcbiAgICAgICAgc2V0dGluZ3M6IHsgYXBwcm92YWw6ICdhc2snIH0sXHJcbiAgICAgICAgd29ya3NwYWNlOiBmYWtlV29ya3NwYWNlcy5pdGVtcy5maW5kKCh3KSA9PiB3LmlkID09PSBmYWtlV29ya3NwYWNlcy5jdXJyZW50KSA/PyBudWxsLFxyXG4gICAgICAgIHByb3ZpZGVyc0RldGFpbDogWy4uLmZha2VQcm92aWRlcnMuZW50cmllcygpXS5tYXAoKFtuYW1lLCBwXSkgPT4gKHtcclxuICAgICAgICAgIG5hbWUsIG1vZGVsOiBwLm1vZGVsLCBiYXNlVXJsOiBwLmJhc2VVcmwsXHJcbiAgICAgICAgICBoYXNLZXk6IHAuYXBpS2V5ICE9PSAnJyxcclxuICAgICAgICAgIGtleVRhaWw6IHAuYXBpS2V5Lmxlbmd0aCA+PSA0ID8gcC5hcGlLZXkuc2xpY2UoLTQpIDogdW5kZWZpbmVkLFxyXG4gICAgICAgICAgcHVycG9zZXM6IFsnY2hhdCddLFxyXG4gICAgICAgIH0pKSxcclxuICAgICAgfSkpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZGVza3RvcC9zaHV0ZG93bicpIHtcclxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlIH0pKTtcclxuICAgICAgc2VydmVyLmNsb3NlKCgpID0+IHByb2Nlc3MuZXhpdCgwKSk7XHJcbiAgICAgIHNldFRpbWVvdXQoKCkgPT4gcHJvY2Vzcy5leGl0KDApLCAxXzAwMCkudW5yZWYoKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2Zha2UvZGllJykge1xyXG4gICAgICAvLyBcdTZENEJcdThCRDVcdTk0QTlcdTVCNTA6XHU2QTIxXHU2MkRGIGhvc3QgXHU1RDI5XHU2RTgzKFx1NTE0OFx1NUU5NFx1N0I1NFx1NTE4RFx1OTAwMFx1NTFGQSxcdTRGRERcdThCQzFcdTU0Q0RcdTVFOTRcdTVERjJcdTUzRDFcdTUxRkEpXHJcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSB9KSk7XHJcbiAgICAgIHNldFRpbWVvdXQoKCkgPT4gcHJvY2Vzcy5leGl0KDEpLCA1MCk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9tb2RlbCcpIHtcclxuICAgICAgLy8gXHU2QTIxXHU1NzhCXHU1MjA3XHU2MzYyKFx1NEUwRSBobWhhcm5lc3MgL2FwaS9tb2RlbCBcdTU0MENcdTVGNjI6XHU1MjA3IGNoYXQgXHU4REVGXHU3NTMxKVxyXG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoKGF3YWl0IHJlYWRCb2R5KCkpIHx8ICd7fScpIGFzIHsgbmFtZT86IHVua25vd24gfTtcclxuICAgICAgICBjb25zdCBuYW1lID0gdHlwZW9mIGJvZHkubmFtZSA9PT0gJ3N0cmluZycgPyBib2R5Lm5hbWUudHJpbSgpIDogJyc7XHJcbiAgICAgICAgaWYgKCFmYWtlUHJvdmlkZXJzLmhhcyhuYW1lKSkge1xyXG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAncHJvdmlkZXIgbm90IGZvdW5kJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XHJcbiAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGZha2VDaGF0UHJvdmlkZXIgPSBuYW1lO1xyXG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlLCBtb2RlbDogZmFrZVByb3ZpZGVycy5nZXQobmFtZSk/Lm1vZGVsIH0pKTtcclxuICAgICAgfSkoKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3Rhc2snKSB7XHJcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoKGF3YWl0IHJlYWRCb2R5KCkpIHx8ICd7fScpIGFzIHsgdGV4dD86IHVua25vd247IHNlc3Npb25JZD86IHVua25vd247IG1vZGU/OiB1bmtub3duOyBhdHRhY2htZW50cz86IHVua25vd247IGltYWdlcz86IHVua25vd24gfTtcclxuICAgICAgICAgIGNvbnN0IHRleHQgPSB0eXBlb2YgYm9keS50ZXh0ID09PSAnc3RyaW5nJyA/IGJvZHkudGV4dCA6ICcnO1xyXG4gICAgICAgICAgY29uc3Qgc2Vzc2lvbklkID0gdHlwZW9mIGJvZHkuc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IGJvZHkuc2Vzc2lvbklkIDogYHdlYi0ke0RhdGUubm93KCkudG9TdHJpbmcoMzYpfWA7XHJcbiAgICAgICAgICBjb25zdCBtb2RlID0gYm9keS5tb2RlID09PSAnYXNrJyB8fCBib2R5Lm1vZGUgPT09ICdhdXRvJyB8fCBib2R5Lm1vZGUgPT09ICd5b2xvJyA/IGJvZHkubW9kZSA6ICdhc2snO1xyXG4gICAgICAgICAgY29uc3QgYXR0YWNobWVudHMgPSBBcnJheS5pc0FycmF5KGJvZHkuYXR0YWNobWVudHMpID8gYm9keS5hdHRhY2htZW50cy5maWx0ZXIoKGEpOiBhIGlzIHN0cmluZyA9PiB0eXBlb2YgYSA9PT0gJ3N0cmluZycpIDogW107XHJcbiAgICAgICAgICAvLyBcdTU2RkVcdTcyNDdcdTk2NDRcdTRFRjY6XHU0RTBFIGhtaGFybmVzcyB2aXNpb24gXHU1MzRGXHU4QkFFXHU1NDBDXHU1RjYyKHtuYW1lLGRhdGFVcmx9KTtmYWtlIFx1NjgyMVx1OUE4Q1x1NUY2Mlx1NzJCNlx1NTM3M1x1NjUzNlxyXG4gICAgICAgICAgY29uc3QgaW1hZ2VzID0gQXJyYXkuaXNBcnJheShib2R5LmltYWdlcylcclxuICAgICAgICAgICAgPyBib2R5LmltYWdlcy5maWx0ZXIoKGltKTogaW0gaXMgeyBuYW1lOiBzdHJpbmc7IGRhdGFVcmw6IHN0cmluZyB9ID0+IHtcclxuICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgaW0gIT09ICdvYmplY3QnIHx8IGltID09PSBudWxsKSByZXR1cm4gZmFsc2U7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBvID0gaW0gYXMgeyBuYW1lPzogdW5rbm93bjsgZGF0YVVybD86IHVua25vd24gfTtcclxuICAgICAgICAgICAgICAgIHJldHVybiB0eXBlb2Ygby5uYW1lID09PSAnc3RyaW5nJyAmJiB0eXBlb2Ygby5kYXRhVXJsID09PSAnc3RyaW5nJyAmJiBvLmRhdGFVcmwuc3RhcnRzV2l0aCgnZGF0YTppbWFnZS8nKTtcclxuICAgICAgICAgICAgICB9KVxyXG4gICAgICAgICAgICA6IFtdO1xyXG4gICAgICAgICAgaWYgKCF0ZXh0KSB7XHJcbiAgICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAndGV4dCByZXF1aXJlZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgICAvLyBcdTRFMEUgaG1oYXJuZXNzIFx1NTQwQ1x1OEJFRFx1NEU0OTpcdTU0MDhcdTZDRDVcdTk2NDRcdTRFRjZcdTRFRTUgW3JlZmVyZW5jZWQgZmlsZXNdIFx1NTI0RFx1N0YwMFx1NUU3Nlx1NTE2NVx1NEVGQlx1NTJBMVx1NjU4N1x1NjcyQztcclxuICAgICAgICAgIC8vIFx1NTZGRVx1NzI0N1x1NEVFNSBbaW1hZ2VzXSBcdTUyNERcdTdGMDBcdTY4MDdcdTZDRThcdTVGMjBcdTY1NzAodmlzaW9uIFx1NjNDRlx1OEZGMFx1OTRGRVx1NTcyOFx1NzcxRlx1NUI5RSBydW50aW1lIFx1OTFDQ1x1NTNEMVx1NzUxRilcclxuICAgICAgICAgIGNvbnN0IGNvbXBvc2VkID0gYXR0YWNobWVudHMubGVuZ3RoID4gMFxyXG4gICAgICAgICAgICA/IGBbcmVmZXJlbmNlZCBmaWxlc11cXG4ke2F0dGFjaG1lbnRzLm1hcCgoYSkgPT4gYC0gJHthLnNwbGl0KC9bXFxcXC9dLykucG9wKCl9YCkuam9pbignXFxuJyl9XFxuXFxuJHt0ZXh0fWBcclxuICAgICAgICAgICAgOiB0ZXh0O1xyXG4gICAgICAgICAgY29uc3Qgd2l0aEltYWdlcyA9IGltYWdlcy5sZW5ndGggPiAwID8gYFtpbWFnZXM6ICR7aW1hZ2VzLmxlbmd0aH1dXFxuJHtjb21wb3NlZH1gIDogY29tcG9zZWQ7XHJcbiAgICAgICAgICBjb25zdCBydW5JZCA9IHJ1blRhc2soc2Vzc2lvbklkLCB3aXRoSW1hZ2VzLCBtb2RlKTtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIHJ1bklkLCBpbWFnZXM6IGltYWdlcy5sZW5ndGggfSkpO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCBTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcclxuICAgICAgICB9XHJcbiAgICAgIH0pKCk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9hcHByb3ZlJykge1xyXG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoKGF3YWl0IHJlYWRCb2R5KCkpIHx8ICd7fScpIGFzIHsgZ3JhbnRlZD86IHVua25vd247IHNlc3Npb25JZD86IHVua25vd24gfTtcclxuICAgICAgICBjb25zdCBzaWQgPSB0eXBlb2YgYm9keS5zZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gYm9keS5zZXNzaW9uSWQgOiAnJztcclxuICAgICAgICBpZiAocGVuZGluZyA9PT0gbnVsbCB8fCAoc2lkICE9PSAnJyAmJiBwZW5kaW5nLnNlc3Npb25JZCAhPT0gc2lkKSkge1xyXG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnbm8gYXBwcm92YWwgcGVuZGluZycsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xyXG4gICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBwID0gcGVuZGluZztcclxuICAgICAgICBwZW5kaW5nID0gbnVsbDtcclxuICAgICAgICBwLnJlc29sdmUoYm9keS5ncmFudGVkID09PSB0cnVlKTtcclxuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgZ3JhbnRlZDogYm9keS5ncmFudGVkID09PSB0cnVlIH0pKTtcclxuICAgICAgfSkoKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUuc3RhcnRzV2l0aCgnL2FwaS9zZXNzaW9ucy8nKSAmJiAodXJsLnBhdGhuYW1lLmVuZHNXaXRoKCcvYXJjaGl2ZScpIHx8IHVybC5wYXRobmFtZS5lbmRzV2l0aCgnL2RlbGV0ZScpKSkge1xyXG4gICAgICAvLyBcdTRGMUFcdThCRERcdTVGNTJcdTY4NjMvXHU1MjIwXHU5NjY0KGhtaGFybmVzcyBcdTU0MENcdTVGNjI6XHU3OUZCXHU1MTY1IGFyY2hpdmUvdHJhc2gsXHU1M0VGXHU2MDYyXHU1OTBELFx1NEUwRFx1Nzg2Q1x1NTIyMClcclxuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHBhcnRzID0gdXJsLnBhdGhuYW1lLnNsaWNlKCcvYXBpL3Nlc3Npb25zLycubGVuZ3RoKS5zcGxpdCgnLycpO1xyXG4gICAgICAgIGNvbnN0IG9wID0gcGFydHNbMV0gPz8gJyc7XHJcbiAgICAgICAgY29uc3Qgb2lkID0gZGVjb2RlVVJJQ29tcG9uZW50KHBhcnRzWzBdID8/ICcnKS5yZXBsYWNlKC9bXmEtekEtWjAtOV86LkAtXS9nLCAnJyk7XHJcbiAgICAgICAgaWYgKG9pZCA9PT0gJycgfHwgKG9wICE9PSAnYXJjaGl2ZScgJiYgb3AgIT09ICdkZWxldGUnKSkge1xyXG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnYmFkIG9wJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XHJcbiAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICghc2Vzc2lvbnMuaGFzKG9pZCkpIHtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3Nlc3Npb24gbm90IGZvdW5kJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XHJcbiAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHNlc3Npb25zLmRlbGV0ZShvaWQpO1xyXG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlIH0pKTtcclxuICAgICAgfSkoKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2luamVjdCcpIHtcclxuICAgICAgLy8gXHU4RkQwXHU4ODRDXHU0RTJEXHU2Q0U4XHU1MTY1KFx1NEUwRSBobWhhcm5lc3MgL2FwaS9pbmplY3QgXHU1NDBDXHU1RjYyO2Zha2UgXHU1M0VBXHU1NkRFXHU2MjY3KVxyXG4gICAgICB2b2lkIHJlYWRCb2R5KCk7XHJcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSB9KSk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9pbnRlcnJ1cHQnKSB7XHJcbiAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKCcnKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjsgLy8gaW50ZXJydXB0IFx1NjVFMCBib2R5IFx1OEJFRFx1NEU0OVxyXG4gICAgICB2b2lkIGJvZHk7XHJcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSB9KSk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3Nlc3Npb25zJykge1xyXG4gICAgICBjb25zdCBsaXN0ID0gWy4uLnNlc3Npb25zLnZhbHVlcygpXS5tYXAoKHMpID0+ICh7XHJcbiAgICAgICAgaWQ6IHMuaWQsIHRpdGxlOiAnJywgdGFzazogJycsIG91dGNvbWU6ICdvaycsIHR1cm5zOiAxLCB0b29sVXNlczogMSxcclxuICAgICAgICB0aW1lOiBzLnVwZGF0ZWRBdCwgY3dkOiAnQzpcXFxcZGVtbycsIGJyYW5jaDogJycsIGNyZWF0ZWRBdDogcy5jcmVhdGVkQXQsIHVwZGF0ZWRBdDogcy51cGRhdGVkQXQsXHJcbiAgICAgIH0pKTtcclxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IHNlc3Npb25zOiBsaXN0LCBuZXh0Q3Vyc29yOiBudWxsIH0pKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZS5zdGFydHNXaXRoKCcvYXBpL3Nlc3Npb25zLycpKSB7XHJcbiAgICAgIGNvbnN0IHNlZyA9IGRlY29kZVVSSUNvbXBvbmVudCh1cmwucGF0aG5hbWUuc2xpY2UoJy9hcGkvc2Vzc2lvbnMvJy5sZW5ndGgpKTtcclxuICAgICAgLy8gXHU1QkZDXHU1MUZBKFx1NEUwRSBobWhhcm5lc3MgL2FwaS9zZXNzaW9ucy86aWQvZXhwb3J0Lm1kIFx1NTQwQ1x1NUY2Mjp0ZXh0L21hcmtkb3duIFx1NEUwQlx1OEY3RClcclxuICAgICAgY29uc3QgZXhwb3J0TWF0Y2ggPSAvXiguKilcXC9leHBvcnRcXC5tZCQvLmV4ZWMoc2VnKSA/PyAvXiguKilcXC5leHBvcnRcXC5tZCQvLmV4ZWMoc2VnKTtcclxuICAgICAgaWYgKGV4cG9ydE1hdGNoICE9PSBudWxsICYmIGV4cG9ydE1hdGNoWzFdICE9PSB1bmRlZmluZWQgJiYgZXhwb3J0TWF0Y2hbMV0gIT09ICcnKSB7XHJcbiAgICAgICAgY29uc3QgZWlkID0gZXhwb3J0TWF0Y2hbMV0ucmVwbGFjZSgvW15hLXpBLVowLTlfOi5ALV0vZywgJycpO1xyXG4gICAgICAgIGNvbnN0IGVzID0gc2Vzc2lvbnMuZ2V0KGVpZCk7XHJcbiAgICAgICAgaWYgKGVzID09PSB1bmRlZmluZWQpIHtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3Nlc3Npb24gbm90IGZvdW5kJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XHJcbiAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAndGV4dC9tYXJrZG93bjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgcmVzLmVuZChgIyBobWhhcm5lc3MgXHU0RjFBXHU4QkREXHU1QkZDXHU1MUZBKGZha2UpXFxuXFxuLSBcdTRGMUFcdThCREQ6JHtlaWR9XFxuXFxuIyMgXHU3NTI4XHU2MjM3XFxuXFxuXHU0RTRCXHU1MjREXHU3Njg0XHU0RUZCXHU1MkExKGZha2UgXHU5ODg0XHU4OUM4KVxcblxcbiMjIFx1NTJBOVx1NjI0Qlxcblxcblx1OEZEOVx1NjYyRlx1NUJGQ1x1NTFGQVx1NzY4NFx1NTZERVx1NTkwRFx1OTg4NFx1ODlDOChmYWtlKVx1MzAwMlxcbmApO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgICAgfVxyXG4gICAgICAvLyBcdTRGMUFcdThCRERcdTk4ODRcdTg5QzgoXHU0RTBFIGhtaGFybmVzcyBHRVQgL2FwaS9zZXNzaW9ucy86aWQgXHU1NDBDXHU1RjYyOlx1NjcwMFx1NTQwRSA4MCBcdTY3NjEsXHU2QkNGXHU2NzYxIDUwMCBcdTVCNTcpXHJcbiAgICAgIGNvbnN0IGlkID0gc2VnLnJlcGxhY2UoL1teYS16QS1aMC05XzouQC1dL2csICcnKTtcclxuICAgICAgY29uc3QgcyA9IHNlc3Npb25zLmdldChpZCk7XHJcbiAgICAgIGlmIChzID09PSB1bmRlZmluZWQpIHtcclxuICAgICAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnc2Vzc2lvbiBub3QgZm91bmQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcclxuICAgICAgICByZXR1cm47XHJcbiAgICAgIH1cclxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XHJcbiAgICAgICAgaWQsIG1vZGVsOiAnZmFrZS1tb2RlbCcsIGN3ZDogJ0M6XFxcXGRlbW8nLFxyXG4gICAgICAgIG1lc3NhZ2VzOiBbXHJcbiAgICAgICAgICB7IHJvbGU6ICd1c2VyJywgdGV4dDogJ1x1NEU0Qlx1NTI0RFx1NzY4NFx1NEVGQlx1NTJBMShmYWtlIFx1OTg4NFx1ODlDOCknLCB0b29sczogW10gfSxcclxuICAgICAgICAgIHsgcm9sZTogJ2Fzc2lzdGFudCcsIHRleHQ6ICdcdThGRDlcdTY2MkZcdTUzODZcdTUzRjJcdTRGMUFcdThCRERcdTc2ODRcdTU2REVcdTU5MERcdTk4ODRcdTg5QzgoZmFrZSlcdTMwMDInLCB0b29sczogWydyZWFkX2ZpbGUnXSB9LFxyXG4gICAgICAgIF0sXHJcbiAgICAgIH0pKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZnMnKSB7XHJcbiAgICAgIC8vIFx1NzZFRVx1NUY1NVx1NkQ0Rlx1ODlDOChcdTRFMEUgaG1oYXJuZXNzIFx1NTQwQ1x1NUY2MjpwYXRoIFx1NzcwMVx1NzU2NT1cdTY4Mzk7ZmlsZXM9MSBcdTk2NDRcdTVFMjZcdTY1ODdcdTRFRjZcdTUyMTdcdTg4NjgpXHJcbiAgICAgIGNvbnN0IHEgPSB1cmwuc2VhcmNoUGFyYW1zLmdldCgncGF0aCcpID8/ICcnO1xyXG4gICAgICBjb25zdCB3aXRoRmlsZXMgPSB1cmwuc2VhcmNoUGFyYW1zLmdldCgnZmlsZXMnKSA9PT0gJzEnO1xyXG4gICAgICBpZiAocSA9PT0gJycpIHtcclxuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xyXG4gICAgICAgICAgcGF0aDogJycsIHNlZ21lbnRzOiBbXSwgcGFyZW50OiAnJyxcclxuICAgICAgICAgIGRpcnM6IFt7IG5hbWU6ICdkZW1vLXdvcmtzcGFjZScsIHBhdGg6ICdDOlxcXFxkZW1vJyB9XSxcclxuICAgICAgICAgIC4uLih3aXRoRmlsZXMgPyB7IGZpbGVzOiBbXSB9IDoge30pLFxyXG4gICAgICAgIH0pKTtcclxuICAgICAgICByZXR1cm47XHJcbiAgICAgIH1cclxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XHJcbiAgICAgICAgcGF0aDogcSwgc2VnbWVudHM6IFt7IG5hbWU6IHEuc3BsaXQoL1tcXFxcL10vKS5maWx0ZXIoQm9vbGVhbikucG9wKCkgPz8gcSwgcGF0aDogcSB9XSwgcGFyZW50OiAnJyxcclxuICAgICAgICBkaXJzOiBbeyBuYW1lOiAnc3JjJywgcGF0aDogYCR7cS5yZXBsYWNlKC9bXFxcXC9dJC8sICcnKX1cXFxcc3JjYCB9XSxcclxuICAgICAgICAuLi4od2l0aEZpbGVzID8geyBmaWxlczogW1xyXG4gICAgICAgICAgeyBuYW1lOiAnUkVBRE1FLm1kJywgcGF0aDogYCR7cS5yZXBsYWNlKC9bXFxcXC9dJC8sICcnKX1cXFxcUkVBRE1FLm1kYCwgcmVsOiAnUkVBRE1FLm1kJyB9LFxyXG4gICAgICAgICAgeyBuYW1lOiAncGFja2FnZS5qc29uJywgcGF0aDogYCR7cS5yZXBsYWNlKC9bXFxcXC9dJC8sICcnKX1cXFxccGFja2FnZS5qc29uYCwgcmVsOiAncGFja2FnZS5qc29uJyB9LFxyXG4gICAgICAgIF0gfSA6IHt9KSxcclxuICAgICAgfSkpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9mcy9yZWFkJykge1xyXG4gICAgICAvLyBcdTY1ODdcdTRFRjZcdTk4ODRcdTg5QzgoNjRLQiBcdTRFMEFcdTk2NTBcdThCRURcdTRFNDk7ZmFrZSBcdThGRDRcdTU2REVcdTU2RkFcdTVCOUFcdTY1ODdcdTY3MkMpXHJcbiAgICAgIGNvbnN0IHAgPSB1cmwuc2VhcmNoUGFyYW1zLmdldCgncGF0aCcpID8/ICcnO1xyXG4gICAgICBpZiAocCA9PT0gJycpIHtcclxuICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAncGF0aCByZXF1aXJlZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgICAgfVxyXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcclxuICAgICAgICBwYXRoOiBwLCByZWw6IHAuc3BsaXQoL1tcXFxcL10vKS5wb3AoKSA/PyBwLCBzaXplOiA0MixcclxuICAgICAgICB0ZXh0OiAnIyBkZW1vIHdvcmtzcGFjZVxcblxcblx1OEZEOVx1NjYyRiBmYWtlIGhvc3QgXHU3Njg0XHU2NTg3XHU0RUY2XHU5ODg0XHU4OUM4XHU1MTg1XHU1QkI5XHUzMDAyXFxuJyxcclxuICAgICAgfSkpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9kaWZmJykge1xyXG4gICAgICAvLyBEaWZmIFx1OTc2Mlx1Njc3RihcdTRFMEUgaG1oYXJuZXNzIC9hcGkvZGlmZiBcdTU0MENcdTVGNjI7ZmFrZSBcdThGRDRcdTU2REVcdTU2RkFcdTVCOUFcdTVDMEZcdTUzRDhcdTY2RjRcdTk2QzYpXHJcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xyXG4gICAgICAgIGdpdDogdHJ1ZSwgY3dkOiAnQzpcXFxcZGVtbycsXHJcbiAgICAgICAgY2hhbmdlZDogW1xyXG4gICAgICAgICAgeyBzdGF0ZTogJ00nLCBwYXRoOiAnc3JjL2FwcC50cycgfSxcclxuICAgICAgICAgIHsgc3RhdGU6ICdBJywgcGF0aDogJ2RvY3Mvbm90ZXMubWQnIH0sXHJcbiAgICAgICAgXSxcclxuICAgICAgICBzdGF0OiAnIHNyYy9hcHAudHMgICAgICB8IDEyICsrKysrKystLS1cXG4gZG9jcy9ub3Rlcy5tZCAgIHwgIDQgKysrK1xcbiAyIGZpbGVzIGNoYW5nZWQsIDE2IGluc2VydGlvbnMoKyksIDMgZGVsZXRpb25zKC0pJyxcclxuICAgICAgfSkpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS93b3Jrc3BhY2VzJykge1xyXG4gICAgICAvLyBcdTVERTVcdTRGNUNcdTUzM0EoXHU0RTBFIGhtaGFybmVzcyBcdTU0MENcdTVGNjI6Y3VycmVudCArIGl0ZW1zKVxyXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcclxuICAgICAgICBjdXJyZW50OiBmYWtlV29ya3NwYWNlcy5jdXJyZW50LFxyXG4gICAgICAgIGl0ZW1zOiBmYWtlV29ya3NwYWNlcy5pdGVtcyxcclxuICAgICAgfSkpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvd29ya3NwYWNlcycpIHtcclxuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7IG5hbWU/OiB1bmtub3duOyBwYXRoPzogdW5rbm93biB9O1xyXG4gICAgICAgIGNvbnN0IHBhdGggPSB0eXBlb2YgYm9keS5wYXRoID09PSAnc3RyaW5nJyA/IGJvZHkucGF0aCA6ICcnO1xyXG4gICAgICAgIGNvbnN0IG5hbWUgPSB0eXBlb2YgYm9keS5uYW1lID09PSAnc3RyaW5nJyAmJiBib2R5Lm5hbWUgIT09ICcnID8gYm9keS5uYW1lIDogKHBhdGguc3BsaXQoL1tcXFxcL10vKS5maWx0ZXIoQm9vbGVhbikucG9wKCkgPz8gJycpO1xyXG4gICAgICAgIGlmIChwYXRoID09PSAnJyB8fCBuYW1lID09PSAnJykge1xyXG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnYWJzb2x1dGUgcGF0aCBhbmQgbmFtZSByZXF1aXJlZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xyXG4gICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoZmFrZVdvcmtzcGFjZXMuaXRlbXMuc29tZSgodykgPT4gdy5wYXRoLnRvTG93ZXJDYXNlKCkgPT09IHBhdGgudG9Mb3dlckNhc2UoKSkpIHtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA5LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3dvcmtzcGFjZSBhbHJlYWR5IHJlZ2lzdGVyZWQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcclxuICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgaXRlbSA9IHsgaWQ6IGB3cy0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDgpfWAsIG5hbWUsIHBhdGggfTtcclxuICAgICAgICBmYWtlV29ya3NwYWNlcy5pdGVtcy5wdXNoKGl0ZW0pO1xyXG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlLCBjdXJyZW50OiBmYWtlV29ya3NwYWNlcy5jdXJyZW50LCBpdGVtczogZmFrZVdvcmtzcGFjZXMuaXRlbXMgfSkpO1xyXG4gICAgICB9KSgpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvd29ya3NwYWNlcy91c2UnKSB7XHJcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgoYXdhaXQgcmVhZEJvZHkoKSkgfHwgJ3t9JykgYXMgeyBpZD86IHVua25vd24gfTtcclxuICAgICAgICBjb25zdCBoaXQgPSBmYWtlV29ya3NwYWNlcy5pdGVtcy5maW5kKCh3KSA9PiB3LmlkID09PSBib2R5LmlkKTtcclxuICAgICAgICBpZiAoaGl0ID09PSB1bmRlZmluZWQpIHtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3dvcmtzcGFjZSBub3QgZm91bmQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcclxuICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgZmFrZVdvcmtzcGFjZXMuY3VycmVudCA9IGhpdC5pZDtcclxuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgY3VycmVudDogZmFrZVdvcmtzcGFjZXMuY3VycmVudCwgaXRlbXM6IGZha2VXb3Jrc3BhY2VzLml0ZW1zIH0pKTtcclxuICAgICAgfSkoKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3Byb3ZpZGVycycpIHtcclxuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7IG5hbWU/OiB1bmtub3duOyBiYXNlVXJsPzogdW5rbm93bjsgbW9kZWw/OiB1bmtub3duOyBhcGlLZXk/OiB1bmtub3duIH07XHJcbiAgICAgICAgY29uc3QgbmFtZSA9IHR5cGVvZiBib2R5Lm5hbWUgPT09ICdzdHJpbmcnID8gYm9keS5uYW1lLnRyaW0oKSA6ICcnO1xyXG4gICAgICAgIGNvbnN0IGJhc2VVcmwgPSB0eXBlb2YgYm9keS5iYXNlVXJsID09PSAnc3RyaW5nJyA/IGJvZHkuYmFzZVVybC50cmltKCkgOiAnJztcclxuICAgICAgICBjb25zdCBtb2RlbCA9IHR5cGVvZiBib2R5Lm1vZGVsID09PSAnc3RyaW5nJyA/IGJvZHkubW9kZWwudHJpbSgpIDogJyc7XHJcbiAgICAgICAgaWYgKG5hbWUgPT09ICcnIHx8IGJhc2VVcmwgPT09ICcnIHx8IG1vZGVsID09PSAnJykge1xyXG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnbmFtZSwgYmFzZVVybCBhbmQgbW9kZWwgYXJlIHJlcXVpcmVkJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XHJcbiAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGZha2VQcm92aWRlcnMuc2V0KG5hbWUsIHsgYmFzZVVybCwgbW9kZWwsIGFwaUtleTogdHlwZW9mIGJvZHkuYXBpS2V5ID09PSAnc3RyaW5nJyA/IGJvZHkuYXBpS2V5IDogJycgfSk7XHJcbiAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIG5hbWUgfSkpO1xyXG4gICAgICB9KSgpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9mcy9zZWFyY2gnKSB7XHJcbiAgICAgIC8vIFx1NURFNVx1NEY1Q1x1NTMzQVx1NjU4N1x1NEVGNlx1NjQxQ1x1N0QyMihcdTRFMEUgaG1oYXJuZXNzIFx1NTQwQ1x1NUY2MjpAXHU5NjQ0XHU0RUY2XHU5MDA5XHU2MkU5XHU1NjY4XHU3Njg0XHU2NTcwXHU2MzZFXHU2RTkwKVxyXG4gICAgICBjb25zdCBxID0gKHVybC5zZWFyY2hQYXJhbXMuZ2V0KCdxJykgPz8gJycpLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xyXG4gICAgICBjb25zdCBhbGwgPSBbXHJcbiAgICAgICAgeyByZWw6ICdSRUFETUUubWQnLCBwYXRoOiAnQzpcXFxcZGVtb1xcXFxSRUFETUUubWQnLCBraW5kOiAnZmlsZScgfSxcclxuICAgICAgICB7IHJlbDogJ3NyYy9hcHAudHMnLCBwYXRoOiAnQzpcXFxcZGVtb1xcXFxzcmNcXFxcYXBwLnRzJywga2luZDogJ2ZpbGUnIH0sXHJcbiAgICAgICAgeyByZWw6ICdkb2NzL25vdGVzLm1kJywgcGF0aDogJ0M6XFxcXGRlbW9cXFxcZG9jc1xcXFxub3Rlcy5tZCcsIGtpbmQ6ICdmaWxlJyB9LFxyXG4gICAgICBdO1xyXG4gICAgICBjb25zdCBoaXRzID0gcSA9PT0gJycgPyBhbGwgOiBhbGwuZmlsdGVyKChmKSA9PiBmLnJlbC50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHEpKTtcclxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IHJlc3VsdHM6IGhpdHMuc2xpY2UoMCwgMjApLCB0cnVuY2F0ZWQ6IGZhbHNlLCB0b3RhbDogaGl0cy5sZW5ndGggfSkpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9jb2duaXRpdmUnKSB7XHJcbiAgICAgIC8vIFx1OEJBNFx1NzdFNVx1NzJCNlx1NjAwMShcdTRFMEUgaG1oYXJuZXNzIGNvZ25pdGl2ZVN0YXR1cyBcdTU0MENcdTVGNjJcdTVCNTBcdTk2QzY7XHU3RjNBXHU2NTcwXHU2MzZFXHU2NjNFXHU1RjBGIG51bGwpXHJcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xyXG4gICAgICAgIG1lbW9yeTogeyBsYXllcnM6IDMsIGVudHJpZXM6IDEyLCBjb250cmFkaWN0aW9uczogMCB9LFxyXG4gICAgICAgIHRyYWplY3RvcmllczogNyxcclxuICAgICAgICBhdWRpdEV2ZW50czogMjEsXHJcbiAgICAgICAgd29ybGRNb2RlbDogeyB2ZXJzaW9uOiA0LCBiZWxpZWZzOiA5LCB0cnVzdGVkOiA1LCBicmllcjogMC4zMSB9LFxyXG4gICAgICAgIGNhbGlicmF0aW9uOiB7IHByZWRpY3Rpb25zOiA0NiwgcmVsaWFiaWxpdHk6IDAuNzIgfSxcclxuICAgICAgfSkpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZmFrZS9lbWl0Jykge1xyXG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7XHJcbiAgICAgICAgICAgIHNlc3Npb25JZDogc3RyaW5nOyBydW5JZDogc3RyaW5nOyBraW5kOiBFdmVudEtpbmQ7IHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xyXG4gICAgICAgICAgfTtcclxuICAgICAgICAgIGNvbnN0IHNlcSA9IGVtaXQoYm9keS5zZXNzaW9uSWQsIGJvZHkucnVuSWQsIGJvZHkua2luZCwgYm9keS5wYXlsb2FkKTtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIHNlcSB9KSk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsIFN0cmluZyhlcnIpLnNsaWNlKDAsIDEyMCksIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xyXG4gICAgICAgIH1cclxuICAgICAgfSkoKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCBgbm8gcm91dGUgJHtyZXEubWV0aG9kfSAke3VybC5wYXRobmFtZX1gLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcclxuICB9KTtcclxuXHJcbiAgYXdhaXQgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xyXG4gICAgc2VydmVyLm9uY2UoJ2Vycm9yJywgcmVqZWN0KTtcclxuICAgIHNlcnZlci5saXN0ZW4oMCwgJzEyNy4wLjAuMScsICgpID0+IHJlc29sdmUoKSk7XHJcbiAgfSk7XHJcbiAgY29uc3QgYWRkcmVzcyA9IHNlcnZlci5hZGRyZXNzKCk7XHJcbiAgaWYgKGFkZHJlc3MgPT09IG51bGwgfHwgdHlwZW9mIGFkZHJlc3MgIT09ICdvYmplY3QnKSB0aHJvdyBuZXcgRXJyb3IoJ2Zha2UgaG9zdDogbm8gcG9ydCcpO1xyXG4gIGNvbnN0IHBvcnQgPSBhZGRyZXNzLnBvcnQ7XHJcblxyXG4gIGlmICghb3B0cy5xdWlldCkge1xyXG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7SlNPTi5zdHJpbmdpZnkoeyBobWhEZXNrdG9wSG9zdFJlYWR5OiB0cnVlLCBwb3J0LCB2ZXJzaW9uOiAnZmFrZS0wLjAuMCcgfSl9XFxuYCk7XHJcbiAgfVxyXG4gIGNvbnN0IGRpZUFmdGVyID0gTnVtYmVyKHByb2Nlc3MuZW52LkZBS0VfSE9TVF9ESUVfQUZURVJfTVMgPz8gMCk7XHJcbiAgaWYgKE51bWJlci5pc0Zpbml0ZShkaWVBZnRlcikgJiYgZGllQWZ0ZXIgPiAwKSB7XHJcbiAgICBzZXRUaW1lb3V0KCgpID0+IHByb2Nlc3MuZXhpdCgxKSwgZGllQWZ0ZXIpLnVucmVmKCk7XHJcbiAgfVxyXG5cclxuICAvLyBjbG9zZSgpOiBcdTUxNDhcdTY1QURcdTVGMDBcdTUxNjhcdTkwRTggU1NFIFx1OEZERVx1NjNBNShcdTVCODNcdTRFRUNcdTZDMzhcdTRFMERcdTgxRUFcdTcxMzZcdTUxNzNcdTk1RUQpLFx1NTQyNlx1NTIxOSBzZXJ2ZXIuY2xvc2VcclxuICAvLyBcdTRGMUFcdTRFMDBcdTc2RjRcdTdCNDlcdTZEM0JcdThEQzNcdThGREVcdTYzQTUsXHU2RDRCXHU4QkQ1XHU4RkRCXHU3QTBCXHU2MzAyXHU2QjdCXHUzMDAyXHJcbiAgY29uc3QgY2xvc2UgPSAoKTogUHJvbWlzZTx2b2lkPiA9PlxyXG4gICAgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUpID0+IHtcclxuICAgICAgZm9yIChjb25zdCBjIG9mIHNzZUNsaWVudHMpIHtcclxuICAgICAgICB0cnkgeyBjLmVuZCgpOyBjLmRlc3Ryb3koKTsgfSBjYXRjaCB7IC8qIGFscmVhZHkgZ29uZSAqLyB9XHJcbiAgICAgIH1cclxuICAgICAgc3NlQ2xpZW50cy5jbGVhcigpO1xyXG4gICAgICBzZXJ2ZXIuY2xvc2UoKCkgPT4gcmVzb2x2ZSgpKTtcclxuICAgICAgc2V0VGltZW91dCgoKSA9PiByZXNvbHZlKCksIDFfMDAwKS51bnJlZigpO1xyXG4gICAgfSk7XHJcblxyXG4gIHJldHVybiB7IHBvcnQsIGVtaXQsIGNsb3NlIH07XHJcbn1cclxuXHJcbi8vIFx1NzZGNFx1NjNBNVx1OEZEMFx1ODg0QyhzdXBlcnZpc29yIHNwYXduIFx1NzY4NFx1NUI1MFx1OEZEQlx1N0EwQlx1NUY2Mlx1NjAwMSlcdTMwMDJyZWFscGF0aCBcdTZCRDRcdThGODM6bnBtIHdvcmtzcGFjZVxyXG4vLyBqdW5jdGlvbiAvIFx1NTkyN1x1NUMwRlx1NTE5OVx1NURFRVx1NUYwMlx1OTBGRFx1NEUwRFx1ODBGRFx1OEJBOVx1OEZEOVx1NEUyQVx1NjhDMFx1NkQ0Qlx1NTkzMVx1NjI0QihcdTU5MzFcdTYyNEI9XHU5NzU5XHU5RUQ4XHU5MDAwXHU1MUZBIGNvZGUgMCxcdTk2QkVcdTY3RTUpXHUzMDAyXHJcbi8vIGNqcyBidW5kbGUoZXNidWlsZCxcdTYyNTNcdTUzMDVcdTRFQTdcdTU0QzEpXHU0RTBCIF9fZmlsZW5hbWUgXHU1QjU4XHU1NzI4O0VTTSh0c3gvXHU2RTkwXHU3ODAxKVx1NzUyOCBpbXBvcnQubWV0YVx1MzAwMlxyXG5jb25zdCBzZWxmVXJsOiBzdHJpbmcgPSB0eXBlb2YgX19maWxlbmFtZSA9PT0gJ3N0cmluZydcclxuICA/IHBhdGhUb0ZpbGVVUkwocmVhbHBhdGhTeW5jKF9fZmlsZW5hbWUpKS5ocmVmXHJcbiAgOiBpbXBvcnQubWV0YS51cmw7XHJcbmNvbnN0IGludm9rZWRBc1NjcmlwdCA9ICgoKSA9PiB7XHJcbiAgaWYgKHByb2Nlc3MuYXJndlsxXSA9PT0gdW5kZWZpbmVkKSByZXR1cm4gZmFsc2U7XHJcbiAgdHJ5IHtcclxuICAgIHJldHVybiBzZWxmVXJsID09PSBwYXRoVG9GaWxlVVJMKHJlYWxwYXRoU3luYyhwcm9jZXNzLmFyZ3ZbMV0pKS5ocmVmO1xyXG4gIH0gY2F0Y2gge1xyXG4gICAgcmV0dXJuIGZhbHNlO1xyXG4gIH1cclxufSkoKTtcclxuaWYgKGludm9rZWRBc1NjcmlwdCkge1xyXG4gIGNvbnN0IHRva2VuID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVE9LRU4gPz8gJyc7XHJcbiAgLy8gRkFLRV9IT1NUX0RJRV9BVF9CT09UPTE6XHU1RjE1XHU1QkZDXHU4ODRDXHU4RjkzXHU1MUZBXHU1MjREXHU1MzczXHU2QjdCKFx1Njc4NFx1OTAyMFx1NTQyRlx1NTJBOFx1NjcxRiBSVU5USU1FX0NSQVNIRUQpXHJcbiAgaWYgKHByb2Nlc3MuZW52LkZBS0VfSE9TVF9ESUVfQVRfQk9PVCA9PT0gJzEnKSB7XHJcbiAgICBwcm9jZXNzLmV4aXQoMSk7XHJcbiAgfVxyXG4gIGNvbnN0IHNsb3cgPSBOdW1iZXIocHJvY2Vzcy5lbnYuRkFLRV9IT1NUX1NMT1dfQUZURVIgPz8gMCk7XHJcbiAgY29uc3QgYm9vdCA9ICgpOiB2b2lkID0+IHtcclxuICAgIHZvaWQgc3RhcnRGYWtlSG9zdCh7IHRva2VuIH0pLmNhdGNoKChlcnIpID0+IHtcclxuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYGZha2UtaG9zdCBmYWlsZWQ6ICR7U3RyaW5nKGVycil9XFxuYCk7XHJcbiAgICAgIHByb2Nlc3MuZXhpdCgxKTtcclxuICAgIH0pO1xyXG4gIH07XHJcbiAgaWYgKE51bWJlci5pc0Zpbml0ZShzbG93KSAmJiBzbG93ID4gMCkgc2V0VGltZW91dChib290LCBzbG93KTtcclxuICBlbHNlIGJvb3QoKTtcclxufVxyXG4iLCAiLyoqXHJcbiAqIFVJVkVSSUZZIFx1OTRBOVx1NUI1MCBcdTIwMTRcdTIwMTQgXHU5MDEwXHU1MjlGXHU4MEZEXHU3NzFGXHU1QjlFIFVJIFx1OUE3MVx1NTJBOFx1OUE4Q1x1NjUzNigyMDI2LTEwLTEwIFx1NzUyOFx1NjIzN1x1NjMwN1x1NEVFNDpcclxuICogXCJcdTVCRjlcdTZCQ0ZcdTRFMDBcdTRFMkFcdTUyOUZcdTgwRkQsXHU2QkNGXHU0RTAwXHU0RTJBXHU0RTFBXHU1MkExXHU2RDQxXHU3QTBCXHU1MTY4XHU5NzYyXHU3Njg0XHU5QThDXHU2NTM2XCIpXHUzMDAyXHJcbiAqXHJcbiAqIFx1NzZGNFx1NjNBNVx1NUJGOVx1NkUzMlx1NjdEM1x1NTQwRVx1NzY4NCBET00gXHU2NUFEXHU4QTAwKFx1NUUwM1x1NUM0MFx1NTFFMFx1NEY1NS9cdTUzRUZcdTg5QzFcdTYwMjcpLFx1NUU3Nlx1NzUyOFx1NTM5Rlx1NzUxRlx1NEU4Qlx1NEVGNlx1OUE3MVx1NTJBOCBSZWFjdFxyXG4gKiAoXHU1M0Q3XHU2M0E3XHU4RjkzXHU1MTY1XHU3NTI4XHU1MzlGXHU1NzhCIHNldHRlciArIGlucHV0IFx1NEU4Qlx1NEVGNjtcdTYzMDlcdTk0QUUgY2xpY2s7XHU5NTJFXHU3NkQ4XHU4RDcwIHdpbmRvd1xyXG4gKiBrZXlkb3duKVx1MzAwMmZha2UgXHU2QTIxXHU1RjBGXHU4REQxXHU1QjhDXHU2NTc0XHU0RUZCXHU1MkExXHU5NEZFKFx1NTNEMVx1OTAwMVx1MjE5Mlx1NURFNVx1NTE3N1x1MjE5Mlx1NUJBMVx1NjI3OVx1MjE5Mlx1NEVBNFx1NEVEOFx1NzI2OVx1MjE5Mlx1NkM0N1x1NjAzQik7XHJcbiAqIHJlYWwgXHU2QTIxXHU1RjBGXHU1M0VBXHU4REQxXHU1M0VBXHU4QkZCXHU1QjUwXHU5NkM2KFx1NEUwRFx1NTJBOFx1NzcxRlx1NUI5RVx1NEYxQVx1OEJERFx1MzAwMVx1NEUwRFx1NzBFNyB0b2tlbilcdTMwMDJcclxuICogXHU2QkNGXHU2QjY1XHU4RjkzXHU1MUZBIGBVSVZFUklGWSBQQVNTfEZBSUwgbmFtZSB8IGRldGFpbGAsXHU3RUQzXHU1QzNFIFNVTU1BUlksZXhpdCBjb2RlXHUzMDAyXHJcbiAqL1xyXG5pbXBvcnQgeyBhcHAsIHR5cGUgQnJvd3NlcldpbmRvdyB9IGZyb20gJ2VsZWN0cm9uJztcclxuaW1wb3J0IHsgbWtkaXIsIHdyaXRlRmlsZSB9IGZyb20gJ25vZGU6ZnMvcHJvbWlzZXMnO1xyXG5pbXBvcnQgeyBqb2luIH0gZnJvbSAnbm9kZTpwYXRoJztcclxuXHJcbmNvbnN0IHNsZWVwID0gKG1zOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+ID0+IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIG1zKSk7XHJcblxyXG5hc3luYyBmdW5jdGlvbiBydW5VaVZlcmlmeSh3aW46IEJyb3dzZXJXaW5kb3csIG1vZGU6ICdmYWtlJyB8ICdyZWFsJyk6IFByb21pc2U8dm9pZD4ge1xyXG4gIGNvbnN0IHNob3RzID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfU0hPVFMgPz8gam9pbihhcHAuZ2V0UGF0aCgndGVtcCcpLCAnaG1oLXVpdmVyaWZ5Jyk7XHJcbiAgYXdhaXQgbWtkaXIoc2hvdHMsIHsgcmVjdXJzaXZlOiB0cnVlIH0pLmNhdGNoKCgpID0+IHVuZGVmaW5lZCk7XHJcbiAgY29uc3QgcmVzdWx0czogQXJyYXk8W3N0cmluZywgYm9vbGVhbiwgc3RyaW5nXT4gPSBbXTtcclxuICBsZXQgc2hvdElkeCA9IDA7XHJcblxyXG4gIGNvbnN0IGpzID0gPFQ+KGNvZGU6IHN0cmluZyk6IFByb21pc2U8VD4gPT4gd2luLndlYkNvbnRlbnRzLmV4ZWN1dGVKYXZhU2NyaXB0KGNvZGUsIHRydWUpIGFzIFByb21pc2U8VD47XHJcbiAgY29uc3Qgc3RlcCA9IGFzeW5jIChuYW1lOiBzdHJpbmcsIGZuOiAoKSA9PiBQcm9taXNlPFtib29sZWFuLCBzdHJpbmddPik6IFByb21pc2U8dm9pZD4gPT4ge1xyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3QgW29rLCBkZXRhaWxdID0gYXdhaXQgZm4oKTtcclxuICAgICAgcmVzdWx0cy5wdXNoKFtuYW1lLCBvaywgZGV0YWlsXSk7XHJcbiAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgY29uc3QgZGV0YWlsID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgJiYgZXJyLnN0YWNrICE9PSB1bmRlZmluZWQgPyBlcnIuc3RhY2sgOiBTdHJpbmcoZXJyKTtcclxuICAgICAgcmVzdWx0cy5wdXNoKFtuYW1lLCBmYWxzZSwgZGV0YWlsLnNsaWNlKDAsIDMwMCldKTtcclxuICAgIH1cclxuICAgIGNvbnN0IGxhc3QgPSByZXN1bHRzW3Jlc3VsdHMubGVuZ3RoIC0gMV0hO1xyXG4gICAgY29uc29sZS5sb2coYFVJVkVSSUZZICR7bGFzdFsxXSA/ICdQQVNTJyA6ICdGQUlMJ30gfCAke2xhc3RbMF19IHwgJHtsYXN0WzJdfWApO1xyXG4gIH07XHJcbiAgLyoqIFx1OEY2RVx1OEJFMlx1NzZGNFx1NTIzMCBwcmVkaWNhdGVDb2RlIFx1OEZENFx1NTZERSB7b2s6dHJ1ZSwuLi59IFx1NjIxNlx1OEQ4NVx1NjVGNihcdThGRDRcdTU2REVcdTY3MDBcdTU0MEVcdTc2ODQgZGV0YWlsKVx1MzAwMiAqL1xyXG4gIGNvbnN0IHdhaXRGb3IgPSBhc3luYyAobGFiZWw6IHN0cmluZywgcHJlZGljYXRlQ29kZTogc3RyaW5nLCB0aW1lb3V0TXM6IG51bWJlcik6IFByb21pc2U8W2Jvb2xlYW4sIHN0cmluZ10+ID0+IHtcclxuICAgIGNvbnN0IHN0YXJ0ZWQgPSBEYXRlLm5vdygpO1xyXG4gICAgZm9yICg7Oykge1xyXG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdHJ5IHsgcmV0dXJuIEpTT04uc3RyaW5naWZ5KChmdW5jdGlvbigpeyAke3ByZWRpY2F0ZUNvZGV9IH0pKCkpOyB9IGNhdGNoKGUpeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe29rOmZhbHNlLCBkZXRhaWw6U3RyaW5nKGUpLnNsaWNlKDAsMTIwKX0pOyB9IH0pKClgKSkgYXMgc3RyaW5nO1xyXG4gICAgICBsZXQgcGFyc2VkOiB7IG9rPzogYm9vbGVhbjsgZGV0YWlsPzogc3RyaW5nIH07XHJcbiAgICAgIHRyeSB7IHBhcnNlZCA9IEpTT04ucGFyc2UocikgYXMgeyBvaz86IGJvb2xlYW47IGRldGFpbD86IHN0cmluZyB9OyB9IGNhdGNoIHsgcGFyc2VkID0geyBvazogZmFsc2UsIGRldGFpbDogU3RyaW5nKHIpLnNsaWNlKDAsIDEyMCkgfTsgfVxyXG4gICAgICBpZiAocGFyc2VkLm9rID09PSB0cnVlKSByZXR1cm4gW3RydWUsIFN0cmluZyhwYXJzZWQuZGV0YWlsID8/ICcnKV07XHJcbiAgICAgIGlmIChEYXRlLm5vdygpIC0gc3RhcnRlZCA+IHRpbWVvdXRNcykgcmV0dXJuIFtmYWxzZSwgYCR7bGFiZWx9OiAke1N0cmluZyhwYXJzZWQuZGV0YWlsID8/ICd0aW1lb3V0Jyl9YF07XHJcbiAgICAgIGF3YWl0IHNsZWVwKDI1MCk7XHJcbiAgICB9XHJcbiAgfTtcclxuICBjb25zdCBzaG90ID0gYXN5bmMgKGxhYmVsOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+ID0+IHtcclxuICAgIHNob3RJZHggKz0gMTtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IGltZyA9IGF3YWl0IHdpbi53ZWJDb250ZW50cy5jYXB0dXJlUGFnZSgpO1xyXG4gICAgICBhd2FpdCB3cml0ZUZpbGUoam9pbihzaG90cywgYCR7bW9kZX0tJHtTdHJpbmcoc2hvdElkeCkucGFkU3RhcnQoMiwgJzAnKX0tJHtsYWJlbH0ucG5nYCksIGltZy50b1BORygpKTtcclxuICAgIH0gY2F0Y2ggeyAvKiBcdTYyMkFcdTU2RkVcdTU5MzFcdThEMjVcdTRFMERcdTUyMjRcdTZCN0IgKi8gfVxyXG4gIH07XHJcblxyXG4gIC8qIC0tLS0gXHU1M0Q3XHU2M0E3XHU4RjkzXHU1MTY1KFJlYWN0Olx1NTM5Rlx1NTc4QiBzZXR0ZXIgXHU4OUU2XHU1M0QxIG9uQ2hhbmdlKSAtLS0tICovXHJcbiAgY29uc3QgdHlwZUludG8gPSAoc2VsOiBzdHJpbmcsIHRleHQ6IHN0cmluZyk6IFByb21pc2U8dW5rbm93bj4gPT5cclxuICAgIGpzKGAoZnVuY3Rpb24oKXtcclxuICAgICAgdmFyIGVsID0gZG9jdW1lbnQucXVlcnlTZWxlY3Rvcigke0pTT04uc3RyaW5naWZ5KHNlbCl9KTtcclxuICAgICAgaWYgKCFlbCkgcmV0dXJuICdOT0VMJztcclxuICAgICAgdmFyIHByb3RvID0gZWwudGFnTmFtZSA9PT0gJ1RFWFRBUkVBJyA/IEhUTUxUZXh0QXJlYUVsZW1lbnQucHJvdG90eXBlIDogSFRNTElucHV0RWxlbWVudC5wcm90b3R5cGU7XHJcbiAgICAgIE9iamVjdC5nZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IocHJvdG8sICd2YWx1ZScpLnNldC5jYWxsKGVsLCAke0pTT04uc3RyaW5naWZ5KHRleHQpfSk7XHJcbiAgICAgIGVsLmRpc3BhdGNoRXZlbnQobmV3IEV2ZW50KCdpbnB1dCcsIHsgYnViYmxlczogdHJ1ZSB9KSk7XHJcbiAgICAgIHJldHVybiAnT0snO1xyXG4gICAgfSkoKWApO1xyXG5cclxuICAvKiAtLS0tIFx1NTQyRlx1NTJBOFx1N0I0OVx1NUY4NTpSZWFjdCBcdTYzMDJcdThGN0QgKyBob3N0IFx1N0VGRlx1NzBCOShyZWFsIFx1NzY4NCBobWhhcm5lc3MgXHU1MUI3XHU1NDJGXHU1MkE4XHU4OTgxXHU3RjE2XHU4QkQxXHJcbiAgICAgXHU2NTc0XHU1OTU3IENMSSBcdTRGOURcdThENTYsXHU1M0VGXHU1MjMwIDMwcys7XHU0RTBEXHU3QjQ5XHU3RUZGXHU3MEI5XHU1QzMxXHU1RjAwXHU4REQxXHU0RjFBXHU1MTY4XHU5MEU4XHU4RDg1XHU2NUY2XHU4QkVGXHU2MkE1KSAtLS0tICovXHJcbiAgYXdhaXQgd2FpdEZvcignaG9zdCByZWFkeScsIGB2YXIgdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY29tcG9zZXIgdGV4dGFyZWEnKTsgcmV0dXJuIHtvazogISF0LCBkZXRhaWw6IHQgPyAnbW91bnRlZCcgOiAnbm8gY29tcG9zZXInfTtgLCAyMF8wMDApO1xyXG4gIGF3YWl0IHdhaXRGb3IoJ2hvc3QgZG90IG9uJywgYHZhciBkPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ob3N0LWRvdCcpOyByZXR1cm4ge29rOiAhIWQgJiYgZC5jbGFzc0xpc3QuY29udGFpbnMoJ29uJyksIGRldGFpbDogZCA/IGQuY2xhc3NOYW1lIDogJ25vIGRvdCd9O2AsIG1vZGUgPT09ICdyZWFsJyA/IDYwXzAwMCA6IDIwXzAwMCk7XHJcbiAgYXdhaXQgc2xlZXAoMV8yMDApOyAvLyBcdTRGMUFcdThCRERcdTUyMTdcdTg4NjgvXHU5ODc2XHU2ODBGXHU2NTcwXHU2MzZFXHU4NDNEXHU1NzMwXHJcblxyXG4gIC8qID09PT09PT09PT0gXHU5MDFBXHU3NTI4Olx1NUUwM1x1NUM0MFx1NTFFMFx1NEY1NShcdTc1MjhcdTYyMzdcdTYyQTVcdTk2OUNcdTc2ODRcdTc2RjRcdTYzQTVcdTY1QURcdThBMDApID09PT09PT09PT0gKi9cclxuICBhd2FpdCBzdGVwKCdcdTVFMDNcdTVDNDA6XHU2ODA3XHU5ODk4XHU2ODBGK1x1NEUwOVx1NjgwRitjb21wb3NlciBcdTU3MjhcdTg5QzZcdTUzRTNcdTUxODUoXHU4RjkzXHU1MTY1XHU2ODQ2XHU1M0VGXHU4OUMxKScsIGFzeW5jICgpID0+IHtcclxuICAgIGNvbnN0IHIgPSAoYXdhaXQganMoYChmdW5jdGlvbigpe1xyXG4gICAgICB2YXIgcSA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IuYmluZChkb2N1bWVudCk7XHJcbiAgICAgIHZhciB0YiA9IHEoJy50aXRsZWJhcicpLCBzaGVsbCA9IHEoJy5hcHAtc2hlbGwnKSwgc2IgPSBxKCcuc2lkZWJhcicpLCB3cyA9IHEoJy53b3Jrc3BhY2UnKSwgdGEgPSBxKCcuY29tcG9zZXIgdGV4dGFyZWEnKTtcclxuICAgICAgdmFyIG1pc3NpbmcgPSBbIXRiICYmICd0aXRsZWJhcicsICFzaGVsbCAmJiAnc2hlbGwnLCAhc2IgJiYgJ3NpZGViYXInLCAhd3MgJiYgJ3dvcmtzcGFjZScsICF0YSAmJiAndGV4dGFyZWEnXS5maWx0ZXIoQm9vbGVhbikuam9pbignLCcpO1xyXG4gICAgICBpZiAobWlzc2luZyAhPT0gJycpIHJldHVybiBKU09OLnN0cmluZ2lmeSh7b2s6ZmFsc2UsIGRldGFpbDonbWlzc2luZzonK21pc3Npbmd9KTtcclxuICAgICAgdmFyIHIgPSB0YS5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKSwgdmggPSB3aW5kb3cuaW5uZXJIZWlnaHQsIHZ3ID0gd2luZG93LmlubmVyV2lkdGg7XHJcbiAgICAgIHZhciBoaW50ID0gcSgnLmVtcHR5LWhpbnQuYmlnJyk7IHZhciBociA9IGhpbnQgPyBoaW50LmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpIDogbnVsbDtcclxuICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHsgb2s6IHIuaGVpZ2h0ID4gMzAgJiYgci5ib3R0b20gPD0gdmggJiYgci53aWR0aCA+IDEwMCAmJiBociAhPT0gbnVsbCAmJiBoci50b3AgPj0gMCAmJiBoci5ib3R0b20gPD0gdmgsXHJcbiAgICAgICAgZGV0YWlsOiAndGV4dGFyZWEgeT0nK01hdGgucm91bmQoci55KSsnIGg9JytNYXRoLnJvdW5kKHIuaGVpZ2h0KSsnIGJvdHRvbT0nK01hdGgucm91bmQoci5ib3R0b20pKycgdmg9Jyt2aCsoaHIgPyAnIGhpbnQgeT0nK01hdGgucm91bmQoaHIueSkgOiAnIG5vLWhpbnQnKSB9KTtcclxuICAgIH0pKClgKSkgYXMgc3RyaW5nO1xyXG4gICAgY29uc3QgcCA9IEpTT04ucGFyc2UocikgYXMgeyBvazogYm9vbGVhbjsgZGV0YWlsOiBzdHJpbmcgfTtcclxuICAgIHJldHVybiBbcC5vayA9PT0gdHJ1ZSwgcC5kZXRhaWxdO1xyXG4gIH0pO1xyXG5cclxuICBpZiAobW9kZSA9PT0gJ2Zha2UnKSB7XHJcbiAgICAvKiA9PT09PT09PT09IGZha2UoXHU1NDExXHU1QkZDXHU2Nzg0XHU5MDIwLEhNSF9ERVNLVE9QX1VJVkVSSUZZX1dJWkFSRD1mYWtlKTpcclxuICAgICAgIFx1NEYyQVx1OTAyMFx1NjcyQVx1OTE0RFx1N0Y2RVx1NjAwMSBcdTIxOTIgXHU1NDExXHU1QkZDXHU1MUZBXHU3M0IwIFx1MjE5MiBcdTY4QzBcdTZENEIoXHU2NzJBXHU4OEM1KVx1MjE5MiBcdTkwMDlcdTYyRTkgXHUyMTkyIFx1NTE4NVx1N0Y2RSBcdTIxOTIgXHU4RkRFXHU0RTBBID09PT09PT09PT0gKi9cclxuICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9XSVpBUkQgPT09ICdmYWtlJykge1xyXG4gICAgICBhd2FpdCBzdGVwKCdcdTU0MTFcdTVCRkM6XHU5OTk2XHU1NDJGXHU1RjM5XHU1MUZBXHU2QjIyXHU4RkNFXHU5ODc1KFx1NUYwMFx1NTlDQlx1OTE0RFx1N0Y2RS9cdTZGMTRcdTc5M0FcdTUxNjVcdTUzRTMpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCd3aXphcmQgb3ZlcmxheScsIGB2YXIgbz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKTtcclxuICAgICAgICAgIHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTVGMDBcdTU5Q0JcdTkxNERcdTdGNkUnO30pO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogISFvICYmICEhYiwgZGV0YWlsOiBvID8gJ292ZXJsYXkrXHU1RjAwXHU1OUNCXHU5MTREXHU3RjZFJyA6ICdubyBvdmVybGF5J307YCwgMTJfMDAwKTtcclxuICAgICAgICBhd2FpdCBzaG90KCd3aXphcmQtd2VsY29tZScpO1xyXG4gICAgICAgIHJldHVybiB3O1xyXG4gICAgICB9KTtcclxuICAgICAgYXdhaXQgc3RlcCgnXHU1NDExXHU1QkZDOlx1NUYwMFx1NTlDQlx1OTE0RFx1N0Y2RVx1MjE5Mlx1NjhDMFx1NkQ0QihcdTRGMkFcdTkwMjBcdTY3MkFcdTg4QzUpXHUyMTkyXHU2NzJBXHU4OEM1XHU1MzczXHU4MUVBXHU1MkE4XHU1Qjg5XHU4OEM1XHU5ODc1KFx1OEJGNFx1NjYwRVx1NkEyQVx1NUU0NStcdTUyMDdcdTYzNjJcdTk0RkVcdTYzQTUpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NUYwMFx1NTlDQlx1OTE0RFx1N0Y2RSc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdhdXRvIGluc3RhbGwgcGFnZScsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtaW5zdGFsbCcpO1xyXG4gICAgICAgICAgaWYoIXApIHJldHVybiB7b2s6ZmFsc2UsIGRldGFpbDonbm90IG9uIGluc3RhbGwnfTtcclxuICAgICAgICAgIHZhciB0PXAudGV4dENvbnRlbnQ7XHJcbiAgICAgICAgICB2YXIgbm90ZT10LmluZGV4T2YoJ1x1NjcyQVx1NjhDMFx1NkQ0Qlx1NTIzMCBobWggQ0xJLFx1NURGMlx1ODFFQVx1NTJBOFx1NUYwMFx1NTlDQlx1NUI4OVx1ODhDNScpPj0wO1xyXG4gICAgICAgICAgdmFyIGwxPXQuaW5kZXhPZignXHU2NTM5XHU3NTI4XHU1MTg1XHU3RjZFXHU3Q0JFXHU3QjgwXHU1MTg1XHU2ODM4Jyk+PTAsIGwyPXQuaW5kZXhPZignXHU2RjE0XHU3OTNBXHU2QTIxXHU1RjBGJyk+PTA7XHJcbiAgICAgICAgICB2YXIgYmFyPSEhcC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLXByb2dyZXNzJyk7XHJcbiAgICAgICAgICB2YXIgc2VsPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1zZWxlY3QnKTtcclxuICAgICAgICAgIHJldHVybiB7b2s6IG5vdGUmJmwxJiZsMiYmYmFyJiYhc2VsLCBkZXRhaWw6ICdub3RlPScrbm90ZSsnIFx1NTE4NVx1N0Y2RVx1OTRGRVx1NjNBNT0nK2wxKycgXHU2RjE0XHU3OTNBXHU5NEZFXHU2M0E1PScrbDIrJyBiYXI9JytiYXIrJyBzZWxlY3RMZWFrPScrISFzZWx9O2AsIDEyXzAwMCk7XHJcbiAgICAgICAgYXdhaXQgc2hvdCgnd2l6YXJkLWF1dG8taW5zdGFsbCcpO1xyXG4gICAgICAgIHJldHVybiB3O1xyXG4gICAgICB9KTtcclxuICAgICAgYXdhaXQgc3RlcCgnXHU1NDExXHU1QkZDOlx1NkEyQVx1NUU0NVwiXHU2NTM5XHU3NTI4XHU1MTg1XHU3RjZFXHU3Q0JFXHU3QjgwXHU1MTg1XHU2ODM4XCJcdTIxOTJcdTkxNERcdTdGNkVcdThERjNcdThGQzdcdTIxOTJcdTVCOENcdTYyMTBcdTk4NzVcdTIxOTJcdTVGMDBcdTU5Q0JcdTRGN0ZcdTc1MjhcdTIxOTJcdTUxNzNcdTk1RURcdTRFMTRcdTVERjJcdThGREVcdTYzQTUnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtcGFnZS1pbnN0YWxsIC53aXphcmQtYWx0LWxpbmsnKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTY1MzlcdTc1MjhcdTUxODVcdTdGNkVcdTdDQkVcdTdCODBcdTUxODVcdTY4MzgnKT49MDt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgLy8gXHU5MTREXHU3RjZFXHU5ODc1OmZha2UgcHJvdmlkZXJzIFx1NURGMlx1NjcwOVx1NUJDNlx1OTRBNSBcdTIxOTIgXHU4MUVBXHU1MkE4XHU4REYzXHU4RkM3O1x1NTE1Q1x1NUU5NVx1NzBCOVwiXHU4REYzXHU4RkM3XCJcclxuICAgICAgICBhd2FpdCB3YWl0Rm9yKCdjb25maWcgb3IgZG9uZScsIGB2YXIgZD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtZG9uZScpO1xyXG4gICAgICAgICAgaWYoZCkgcmV0dXJuIHtvazp0cnVlLCBkZXRhaWw6J2RvbmUnfTtcclxuICAgICAgICAgIHZhciBjPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1jb25maWcnKTtcclxuICAgICAgICAgIGlmKGMpeyB2YXIgcz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdcdThERjNcdThGQzcnKT49MDt9KTsgaWYocykgcy5jbGljaygpOyB9XHJcbiAgICAgICAgICByZXR1cm4ge29rOmZhbHNlLCBkZXRhaWw6J3dhaXRpbmcnfTtgLCAxNV8wMDApO1xyXG4gICAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdkb25lIHBhZ2UnLCBgdmFyIGQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLWRvbmUnKTtcclxuICAgICAgICAgIHZhciB0PWQ/ZC50ZXh0Q29udGVudDonJztcclxuICAgICAgICAgIHJldHVybiB7b2s6ICEhZCAmJiB0LmluZGV4T2YoJ1x1NUMzMVx1N0VFQScpPj0wICYmIHQuaW5kZXhPZignXHU1MTcxXHU0RUFCJyk+PTAsIGRldGFpbDogdC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNjApfTtgLCA4XzAwMCk7XHJcbiAgICAgICAgYXdhaXQgc2hvdCgnd2l6YXJkLWRvbmUnKTtcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTVGMDBcdTU5Q0JcdTRGN0ZcdTc1MjgnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICBjb25zdCBjbG9zZWQgPSBhd2FpdCB3YWl0Rm9yKCd3aXphcmQgY2xvc2VkICsgY29ubmVjdGVkJywgYHJldHVybiB7b2s6ICFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKSAmJiAhIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ob3N0LWRvdC5vbicpLFxyXG4gICAgICAgICAgZGV0YWlsOiAnb3ZlcmxheT0nKyhkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKT8nb3Blbic6J2Nsb3NlZCcpKycgZG90PScrKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ob3N0LWRvdC5vbicpPydvbic6J29mZicpfTtgLCAxMF8wMDApO1xyXG4gICAgICAgIHJldHVybiBbd1swXSAmJiBjbG9zZWRbMF0sIGBkb25lOiAke3dbMV19OyAke2Nsb3NlZFsxXX1gXTtcclxuICAgICAgfSk7XHJcbiAgICB9XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1OTk5Nlx1OEREMVx1NUYxNVx1NUJGQ1x1NUM0MiA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTVGMTVcdTVCRkNcdTVDNDI6XHU2RjE0XHU3OTNBXHU2QTIxXHU1RjBGXHU2M0QwXHU3OTNBXHU1MUZBXHU3M0IwXHU1RTc2XHU1M0VGXHU1MTczXHU5NUVEJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignZ3VpZGUnLCBgdmFyIGc9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnJ1bnRpbWUtZ3VpZGUnKTsgcmV0dXJuIHtvazogISFnLCBkZXRhaWw6IGcgPyAnc2hvd24nIDogJ25vdCBzaG93bid9O2AsIDhfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpe1xyXG4gICAgICAgIHZhciBidG5zID0gW10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcucnVudGltZS1ndWlkZSBidXR0b24nKSk7XHJcbiAgICAgICAgdmFyIGIgPSBidG5zLmZpbmQoZnVuY3Rpb24oeCl7IHJldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1NkYxNFx1NzkzQScpID49IDA7IH0pO1xyXG4gICAgICAgIGlmIChiKSBiLmNsaWNrKCk7XHJcbiAgICAgIH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2d1aWRlIGdvbmUnLCBgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ydW50aW1lLWd1aWRlJyksIGRldGFpbDogZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnJ1bnRpbWUtZ3VpZGUnKSA/ICdzdGlsbCcgOiAnZGlzbWlzc2VkJ307YCwgNV8wMDApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NjVCMFx1NUVGQVx1NEYxQVx1OEJERChDdHJsK04pID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ0N0cmwrTiBcdTY1QjBcdTVFRkFcdTRGMUFcdThCREQsXHU4RjkzXHU1MTY1XHU2ODQ2XHU1M0VGXHU3NTI4JywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OiduJywgY3RybEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ3RleHRhcmVhIGVuYWJsZWQnLCBgdmFyIHQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNvbXBvc2VyIHRleHRhcmVhJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISF0ICYmIHQuZGlzYWJsZWQgPT09IGZhbHNlICYmICh0LnBsYWNlaG9sZGVyfHwnJykuaW5kZXhPZignXHU2M0NGXHU4RkYwXHU3NkVFXHU2ODA3JykgPj0gMCwgZGV0YWlsOiB0ID8gKCdkaXNhYmxlZD0nK3QuZGlzYWJsZWQrJyBwaD0nKyh0LnBsYWNlaG9sZGVyfHwnJykuc2xpY2UoMCwyMCkpIDogJ25vIHRhJ307YCwgNV8wMDApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NTNEMVx1OTAwMVx1NEVGQlx1NTJBMSBcdTIxOTIgXHU3NTI4XHU2MjM3XHU4RjZFXHU1MUZBXHU3M0IwKFx1NEUxNFx1NEVDNVx1NEUwMFx1Njc2MSxcdTUzQ0NcdTZEODhcdTYwNkZcdTU2REVcdTVGNTIpID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1OEY5M1x1NTE2NVx1NUU3Nlx1NTNEMVx1OTAwMVx1NEVGQlx1NTJBMSxcdTc1MjhcdTYyMzdcdTZEODhcdTYwNkZcdTRFMEFcdTVDNEZcdTRFMTRcdTRFMERcdTkxQ0RcdTU5MEQnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IHR5cGVJbnRvKCcuY29tcG9zZXIgdGV4dGFyZWEnLCAnXHU5QThDXHU2NTM2XHU0RUZCXHU1MkExOlx1NTE5OVx1NTE2NVx1NEUwMFx1NEUyQVx1NjU4N1x1NEVGNicpO1xyXG4gICAgICBhd2FpdCBzbGVlcCgyMDApO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XHJcbiAgICAgICAgdmFyIGJ0bnMgPSBbXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jb21wb3NlciBidXR0b24nKSk7XHJcbiAgICAgICAgdmFyIGIgPSBidG5zLmZpbmQoZnVuY3Rpb24oeCl7IHJldHVybiB4LnRleHRDb250ZW50LnRyaW0oKSA9PT0gJ1x1NTNEMVx1OTAwMSc7IH0pO1xyXG4gICAgICAgIGlmIChiKSBiLmNsaWNrKCk7XHJcbiAgICAgIH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2V4YWN0bHkgb25lIHVzZXIgdHVybicsIGB2YXIgdHM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudHVybi51c2VyJykpLmZpbHRlcihmdW5jdGlvbih4KXsgcmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU5QThDXHU2NTM2XHU0RUZCXHU1MkExJykgPj0gMDsgfSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogdHMubGVuZ3RoID09PSAxLCBkZXRhaWw6ICdjb3VudD0nK3RzLmxlbmd0aCsnIHRleHQ9JysodHNbMF0/dHNbMF0udGV4dENvbnRlbnQuc2xpY2UoMCwzMCk6J25vbmUnKX07YCwgOF8wMDApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NURFNVx1NTE3N1x1NTM2MShyZWFkX2ZpbGUgXHU1QjhDXHU2MjEwKSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTVERTVcdTUxNzdcdTYyOThcdTUzRTBcdTUzNjE6cmVhZF9maWxlIFx1NjI2N1x1ODg0Q1x1NUU3Nlx1NUI4Q1x1NjIxMCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3Rvb2wgY2FyZCcsIGB2YXIgYz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50b29sLWNhcmQnKSk7XHJcbiAgICAgICAgdmFyIGRvbmUgPSBjLmZpbHRlcihmdW5jdGlvbih4KXsgcmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZigncmVhZF9maWxlJykgPj0gMCAmJiB4LnRleHRDb250ZW50LmluZGV4T2YoJyMgZGVtbycpID49IDA7IH0pO1xyXG4gICAgICAgIHJldHVybiB7b2s6IGRvbmUubGVuZ3RoID49IDEsIGRldGFpbDogJ2NhcmRzPScrYy5sZW5ndGgrJyBkb25lPScrZG9uZS5sZW5ndGh9O2AsIDhfMDAwKTtcclxuICAgICAgcmV0dXJuIHc7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU1QkExXHU2Mjc5XHU3RUI1XHU1MjA3XHU3MjQ3KFx1NzUyOFx1NjIzN1x1NjJBNVx1OTY5Q1x1NjgzOFx1NUZDM1x1NEU0Qlx1NEUwMCkgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU1QkExXHU2Mjc5OmFwcHJvdmFsIFx1NTM2MVx1NTFGQVx1NzNCMChcdTdCNDlcdTVGODVcdTRFQkFcdTVERTVcdTYyNzlcdTUxQzYpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBzaG90KCdhcHByb3ZhbC1wZW5kaW5nJyk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdhcHByb3ZhbCBjYXJkJywgYHZhciBhPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5hcHByb3ZhbC1jYXJkJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFhICYmIGEudGV4dENvbnRlbnQuaW5kZXhPZignXHU5NzAwXHU4OTgxXHU1QkExXHU2Mjc5JykgPj0gMCwgZGV0YWlsOiBhID8gYS50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsIDYwKSA6ICdubyBhcHByb3ZhbCBjYXJkJ307YCwgOF8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdcdTVCQTFcdTYyNzk6XHU3MEI5XHU2Mjc5XHU1MUM2IFx1MjE5MiBcdTRFRkJcdTUyQTFcdTdFRTdcdTdFRURcdTUyMzBcdTRFQTRcdTRFRDhcdTcyNjkrXHU2QzQ3XHU2MDNCJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XHJcbiAgICAgICAgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuYXBwcm92YWwtY2FyZCBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXsgcmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NjI3OVx1NTFDNic7IH0pO1xyXG4gICAgICAgIGlmIChiKSBiLmNsaWNrKCk7XHJcbiAgICAgIH0pKClgKTtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2FydGlmYWN0K3N1bScsIGB2YXIgYXJ0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5hcnRpZmFjdC1jYXJkJyk7XHJcbiAgICAgICAgdmFyIHN1bT1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudHVybi1zdW0nKTtcclxuICAgICAgICB2YXIgYXN0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnR1cm4nKSkuZmlsdGVyKGZ1bmN0aW9uKHgpeyByZXR1cm4geC5jbGFzc05hbWUuaW5kZXhPZigndXNlcicpPDAgJiYgeC50ZXh0Q29udGVudC5pbmRleE9mKCdlY2hvOicpPj0wOyB9KTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWFydCAmJiAhIXN1bSAmJiBhc3QubGVuZ3RoPj0xLCBkZXRhaWw6ICdhcnRpZmFjdD0nKyhhcnQ/YXJ0LnRleHRDb250ZW50LnNsaWNlKDAsMzApOidub25lJykrJyBzdW09Jysoc3VtP3N1bS50ZXh0Q29udGVudDonbm9uZScpKycgYW5zd2VyZWQ9Jythc3QubGVuZ3RofTtgLCAxMl8wMDApO1xyXG4gICAgICBhd2FpdCBzaG90KCdydW4tY29tcGxldGVkJyk7XHJcbiAgICAgIHJldHVybiB3O1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NTM4Nlx1NTNGMlx1NEYxQVx1OEJERFx1NTE4NVx1NUJCOShcdTc1MjhcdTYyMzdcdTYyQTVcdTk2OUNcIlx1NzcwQlx1NEUwRFx1NTIzMFx1NTE4NVx1NUJCOVwiKSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTcwQjlcdTUxRkJcdTUzODZcdTUzRjJcdTRGMUFcdThCREQgXHUyMTkyIHRyYW5zY3JpcHQgXHU1MTg1XHU1QkI5XHU1M0VGXHU4OUMxJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBpdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2Vzc2lvbi1pdGVtJyk7IGlmIChpdCkgaXQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignaGlzdG9yeSB0dXJucycsIGB2YXIgdHM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudHVybicpKTtcclxuICAgICAgICByZXR1cm4ge29rOiB0cy5sZW5ndGggPj0gMiwgZGV0YWlsOiAndHVybnM9Jyt0cy5sZW5ndGgrJyBmaXJzdD0nKyh0c1swXT90c1swXS50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNDApOidub25lJyl9O2AsIDhfMDAwKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTRFOTRcdTk4NzVcdTdCN0UgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnRG9jazpPdmVydmlldyBcdTY1NzBcdTYzNkVcdTg4NEMnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdPdmVydmlldyc7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignb3ZlcnZpZXcgcm93cycsIGB2YXIgcm93cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXJvdycpKTtcclxuICAgICAgICB2YXIgdmVyID0gcm93cy5maW5kKGZ1bmN0aW9uKHIpeyByZXR1cm4gci50ZXh0Q29udGVudC5pbmRleE9mKCdydW50aW1lIFx1NzI0OFx1NjcyQycpPj0wOyB9KTtcclxuICAgICAgICByZXR1cm4ge29rOiByb3dzLmxlbmd0aCA+PSA1ICYmICEhdmVyLCBkZXRhaWw6ICdyb3dzPScrcm93cy5sZW5ndGgrKHZlcj8nIHZlcj0nK3Zlci50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNDApOicnKX07YCwgNl8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdEb2NrOkZpbGVzIFx1NkQ0Rlx1ODlDOCtcdTY1ODdcdTRFRjZcdTk4ODRcdTg5QzgnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdcdTY1ODdcdTRFRjYnfHx4LnRleHRDb250ZW50PT09J0ZpbGVzJzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdmcyByb3dzJywgYHZhciByb3dzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5mcy1yb3cnKS5sZW5ndGg7XHJcbiAgICAgICAgcmV0dXJuIHtvazogcm93cyA+PSAxLCBkZXRhaWw6ICdyb3dzPScrcm93c307YCwgNl8wMDApO1xyXG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICAvLyBcdTY4MzlcdTc2RUVcdTVGNTVcdTUzRUFcdTY3MDlcdTVERTVcdTRGNUNcdTUzM0FcdTc2RUVcdTVGNTUoZmFrZSBcdTRFMEVcdTc3MUZcdTVCOUUgcnVudGltZSBcdTU0MENcdTVGNjIpOlx1NTE0OFx1OEZEQlx1NzZFRVx1NUY1NSxcdTUxOERcdTcwQjlcdTY1ODdcdTRFRjZcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgZD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5mcy1yb3cnKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdkZW1vLXdvcmtzcGFjZScpPj0wIHx8IHgudGV4dENvbnRlbnQuaW5kZXhPZignXHVEODNEXHVEQ0MxJyk+PTA7fSk7IGlmKGQpIGQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCB3MiA9IGF3YWl0IHdhaXRGb3IoJ2ZpbGUgcm93cycsIGB2YXIgcm93cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5mcy1yb3cnKSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogcm93cy5zb21lKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1JFQURNRScpPj0wO30pLCBkZXRhaWw6ICdyb3dzPScrcm93cy5sZW5ndGh9O2AsIDZfMDAwKTtcclxuICAgICAgaWYgKCF3MlswXSkgcmV0dXJuIHcyO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBmPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmZzLXJvdycpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1JFQURNRScpPj0wO30pOyBpZihmKSBmLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2ZpbGUgcHJldmlldycsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuZnMtcHJldmlldycpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhcCAmJiBwLnRleHRDb250ZW50LmluZGV4T2YoJ2RlbW8gd29ya3NwYWNlJykgPj0gMCwgZGV0YWlsOiBwID8gcC50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNDApIDogJ25vIHByZXZpZXcnfTtgLCA2XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ0RvY2s6RGlmZiBcdTUzRDhcdTY2RjRcdTg4NEMnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdcdTUzRDhcdTY2RjQnfHx4LnRleHRDb250ZW50PT09J0RpZmYnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2RpZmYgcm93cycsIGB2YXIgcm93cz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZGlmZi1yb3cnKS5sZW5ndGg7XHJcbiAgICAgICAgcmV0dXJuIHtvazogcm93cyA+PSAxLCBkZXRhaWw6ICdkaWZmIHJvd3M9Jytyb3dzfTtgLCA2XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ0RvY2s6RXZpZGVuY2UgXHU4QkE0XHU3N0U1XHU2NTcwXHU2MzZFJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nXHU4QkMxXHU2MzZFJ3x8eC50ZXh0Q29udGVudD09PSdFdmlkZW5jZSc7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignZXZpZGVuY2Ugcm93cycsIGB2YXIgcm93cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXJvdycpKTtcclxuICAgICAgICB2YXIgbWVtID0gcm93cy5maW5kKGZ1bmN0aW9uKHIpeyByZXR1cm4gci50ZXh0Q29udGVudC5pbmRleE9mKCdcdThCQjBcdTVGQzZcdTVDNDInKT49MCB8fCByLnRleHRDb250ZW50LmluZGV4T2YoJ01lbW9yeSBsYXllcnMnKT49MDsgfSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFtZW0gJiYgbWVtLnRleHRDb250ZW50LmluZGV4T2YoJzMnKSA+PSAwLCBkZXRhaWw6IG1lbSA/IG1lbS50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpIDogJ25vIG1lbW9yeSByb3cnfTtgLCA2XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ0RvY2s6TG9ncyBcdTk3NjJcdTY3N0YoXHU3QTdBXHU2MDAxXHU2M0QwXHU3OTNBKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J1x1NjVFNVx1NUZENyd8fHgudGV4dENvbnRlbnQ9PT0nTG9ncyc7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignbG9ncyBwYW5lJywgYHZhciBsPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5sb2dzLWxpc3QnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWwsIGRldGFpbDogbCA/ICgncm93cz0nK2wucXVlcnlTZWxlY3RvckFsbCgnLmxvZy1yb3cnKS5sZW5ndGgpIDogJ25vIGxvZ3MgbGlzdCd9O2AsIDVfMDAwKTtcclxuICAgICAgcmV0dXJuIHc7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6RG9jazpcdThGRENcdTdBMEJcdTk4NzVcdTdCN0UoXHU2MjRCXHU2NzNBXHU4RkRDXHU3QTBCXHU2M0E3XHU1MjM2XHU5NzYyXHU2NzdGK1x1NUYwMFx1NjczQVx1ODFFQVx1NTQyRlx1ODg0QykgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnRG9jazpcdThGRENcdTdBMEJcdTk4NzVcdTdCN0UoXHU2MjRCXHU2NzNBXHU4RkRDXHU3QTBCXHU2M0E3XHU1MjM2XHU5NzYyXHU2NzdGKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J1x1OEZEQ1x1N0EwQid8fHgudGV4dENvbnRlbnQ9PT0nUmVtb3RlJzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdyZW1vdGUgcGFuZScsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuZG9jay1ib2R5Jyk7XHJcbiAgICAgICAgdmFyIHQgPSBwID8gcC50ZXh0Q29udGVudCA6ICcnO1xyXG4gICAgICAgIHZhciBva1QgPSB0LmluZGV4T2YoJ1x1NjI0Qlx1NjczQVx1OEZEQ1x1N0EwQlx1NjNBN1x1NTIzNicpPj0wIHx8IHQuaW5kZXhPZignUGhvbmUgcmVtb3RlJyk+PTA7XHJcbiAgICAgICAgdmFyIG9rQSA9IHQuaW5kZXhPZignXHU1RjAwXHU2NzNBXHU4MUVBXHU1NDJGJyk+PTAgfHwgdC5pbmRleE9mKCdBdXRvc3RhcnQnKT49MDtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXAgJiYgb2tUICYmIG9rQSwgZGV0YWlsOiB0LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw2MCl9O2AsIDZfMDAwKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTY0MUNcdTdEMjJcdThGQzdcdTZFRTQgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU0RjFBXHU4QkREXHU2NDFDXHU3RDIyOlx1OEZDN1x1NkVFNFx1NzUxRlx1NjU0OCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgYmVmb3JlID0gKGF3YWl0IGpzKGBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoYCkpIGFzIG51bWJlcjtcclxuICAgICAgYXdhaXQgdHlwZUludG8oJy5zZXNzaW9uLXNlYXJjaCcsICd6enotXHU0RTBEXHU1QjU4XHU1NzI4XHU3Njg0XHU0RjFBXHU4QkREJyk7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdmaWx0ZXJlZCBlbXB0eScsIGB2YXIgbj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoO1xyXG4gICAgICAgIHJldHVybiB7b2s6IG4gPT09IDAsIGRldGFpbDogJ2FmdGVyPScrbn07YCwgNV8wMDApO1xyXG4gICAgICBhd2FpdCB0eXBlSW50bygnLnNlc3Npb24tc2VhcmNoJywgJycpO1xyXG4gICAgICBhd2FpdCBzbGVlcCg0MDApO1xyXG4gICAgICBjb25zdCBhZnRlciA9IChhd2FpdCBqcyhgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aGApKSBhcyBudW1iZXI7XHJcbiAgICAgIHJldHVybiBbd1swXSAmJiBhZnRlciA9PT0gYmVmb3JlLCBgJHt3WzFdfTsgXHU2MDYyXHU1OTBEXHU1NDBFICR7YWZ0ZXJ9PT09JHtiZWZvcmV9YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6Q3RybCtLIFx1NTQ3RFx1NEVFNFx1OTc2Mlx1Njc3RiA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdDdHJsK0sgXHU1NDdEXHU0RUU0XHU5NzYyXHU2NzdGOlx1NjI1M1x1NUYwMFx1NUU3Nlx1NjI2N1x1ODg0Q1x1NTQ3RFx1NEVFNCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleTonaycsIGN0cmxLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdjbWRrIG9wZW4nLCBgdmFyIGM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNtZGsnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWMsIGRldGFpbDogYyA/ICdvcGVuJyA6ICdub3Qgb3Blbid9O2AsIDVfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgaXQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY21kay1pdGVtJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU2NTg3XHU0RUY2Jyk+PTAgfHwgeC50ZXh0Q29udGVudC5pbmRleE9mKCdGaWxlcycpPj0wO30pOyBpZihpdCkgaXQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcigndGFiIHN3aXRjaGVkJywgYHZhciB0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5kb2NrLXRhYi5hY3RpdmUnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXQgJiYgKHQudGV4dENvbnRlbnQ9PT0nXHU2NTg3XHU0RUY2J3x8dC50ZXh0Q29udGVudD09PSdGaWxlcycpLCBkZXRhaWw6ICdhY3RpdmU9JysodD90LnRleHRDb250ZW50Oidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdThCQkVcdTdGNkVcdTk3NjJcdTY3N0YgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU4QkJFXHU3RjZFKEN0cmwrU2hpZnQrUCk6UHJvdmlkZXIgXHU4ODY4XHU1MzU1XHU1M0VGXHU4OUMxLEVzYyBcdTUxNzNcdTk1RUQnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J3AnLCBjdHJsS2V5OnRydWUsIHNoaWZ0S2V5OnRydWUsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignc2V0dGluZ3Mgb3BlbicsIGB2YXIgcz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kay5zZXR0aW5ncycpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhcyAmJiAhIXMucXVlcnlTZWxlY3RvcignLnByb3ZpZGVyLWZvcm0nKSwgZGV0YWlsOiBzID8gJ29wZW4rZm9ybScgOiAnbm90IG9wZW4nfTtgLCA1XzAwMCk7XHJcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J0VzY2FwZScsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignc2V0dGluZ3MgY2xvc2VkJywgYHJldHVybiB7b2s6ICFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kay1vdmVybGF5JyksIGRldGFpbDogJ2Nsb3NlZCd9O2AsIDVfMDAwKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTppMThuIFx1OEJFRFx1OEEwMFx1NTIwN1x1NjM2MiA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdThCRURcdThBMDBcdTUyMDdcdTYzNjI6XHU0RTJEXHU2NTg3IFx1MjE5MiBFbmdsaXNoIFx1MjE5MiBcdTYwNjJcdTU5MERcdTRFMkRcdTY1ODcnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J3AnLCBjdHJsS2V5OnRydWUsIHNoaWZ0S2V5OnRydWUsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignc2V0dGluZ3Mgb3BlbicsIGB2YXIgcz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kay5zZXR0aW5ncycpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhcywgZGV0YWlsOiBzID8gJ29wZW4nIDogJ25vdCBvcGVuJ307YCwgNV8wMDApO1xyXG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNtZGsuc2V0dGluZ3MgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J0VuZ2xpc2gnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgZW4gPSBhd2FpdCB3YWl0Rm9yKCdlbmdsaXNoIHNob3duJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyLWhlYWQgLmJ0bi5wcmltYXJ5Jyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFiICYmIGIudGV4dENvbnRlbnQgPT09ICcrIE5ldyBTZXNzaW9uJywgZGV0YWlsOiAnYnRuPScrKGI/Yi50ZXh0Q29udGVudDonbm9uZScpfTtgLCA1XzAwMCk7XHJcbiAgICAgIGF3YWl0IHNob3QoJ2VuZ2xpc2gnKTtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jbWRrLnNldHRpbmdzIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTRFMkRcdTY1ODcnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgemggPSBhd2FpdCB3YWl0Rm9yKCdjaGluZXNlIGJhY2snLCBgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXItaGVhZCAuYnRuLnByaW1hcnknKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWIgJiYgYi50ZXh0Q29udGVudCA9PT0gJysgXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREJywgZGV0YWlsOiAnYnRuPScrKGI/Yi50ZXh0Q29udGVudDonbm9uZScpfTtgLCA1XzAwMCk7XHJcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J0VzY2FwZScsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICByZXR1cm4gW2VuWzBdICYmIHpoWzBdLCBgZW46ICR7ZW5bMV19OyB6aDogJHt6aFsxXX1gXTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTVERTVcdTRGNUNcdTUzM0FcdTdCQTFcdTc0MDYoXHU1REU2XHU2ODBGXHU2ODBGXHU0RjREICsgXHU4M0RDXHU1MzU1ICsgXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREXHU5MDA5XHU1REU1XHU0RjVDXHU1MzNBKSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTVERTVcdTRGNUNcdTUzM0E6XHU1REU2XHU2ODBGXHU1REU1XHU0RjVDXHU1MzNBXHU2ODBGXHU1M0VGXHU4OUMxKFx1NUY1M1x1NTI0RFx1NURFNVx1NEY1Q1x1NTMzQVx1NTQwRCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCd3b3Jrc3BhY2UgYmFyJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53b3Jrc3BhY2UtYmFyJyk7XHJcbiAgICAgICAgdmFyIG4gPSBiID8gKGIucXVlcnlTZWxlY3RvcignLndzLWJhci1uYW1lJyl8fHt9KS50ZXh0Q29udGVudCA6ICcnO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYiAmJiAhIW4gJiYgbi5sZW5ndGggPiAwICYmIG4uaW5kZXhPZignXHU1MkEwXHU4RjdEJykgPCAwLCBkZXRhaWw6ICdiYXI9JysoYj8neWVzJzonbm8nKSsnIG5hbWU9JytufTtgLCA4XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ1x1NURFNVx1NEY1Q1x1NTMzQTpcdTgzRENcdTUzNTVcdTVGMzlcdTUxRkEsXHU1MjE3XHU4ODY4K1x1NUY1M1x1NTI0RFx1OUFEOFx1NEVBRStcdTZERkJcdTUyQTBcdTUxNjVcdTUzRTM7XHU1NzI4XHU2MzA3XHU1QjlBXHU1REU1XHU0RjVDXHU1MzNBXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53b3Jrc3BhY2UtYmFyJyk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignd3MgbWVudScsIGB2YXIgbT1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtbWVudScpO1xyXG4gICAgICAgIHZhciBpdGVtcyA9IG0gPyBtLnF1ZXJ5U2VsZWN0b3JBbGwoJy53cy1tZW51LWl0ZW0nKS5sZW5ndGggOiAwO1xyXG4gICAgICAgIHZhciBjdXIgPSBtID8gbS5xdWVyeVNlbGVjdG9yQWxsKCcud3MtbWVudS1pdGVtLmN1cnJlbnQnKS5sZW5ndGggOiAwO1xyXG4gICAgICAgIHZhciBhZGQgPSBtID8gKG0udGV4dENvbnRlbnQuaW5kZXhPZignXHU2REZCXHU1MkEwXHU1REU1XHU0RjVDXHU1MzNBJyk+PTAgfHwgbS50ZXh0Q29udGVudC5pbmRleE9mKCdBZGQgd29ya3NwYWNlJyk+PTApIDogZmFsc2U7XHJcbiAgICAgICAgcmV0dXJuIHtvazogaXRlbXMgPj0gMSAmJiBjdXIgPj0gMSAmJiBhZGQsIGRldGFpbDogJ2l0ZW1zPScraXRlbXMrJyBjdXJyZW50PScrY3VyKycgYWRkPScrYWRkfTtgLCA2XzAwMCk7XHJcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgIGF3YWl0IHNob3QoJ3dzLW1lbnUnKTtcclxuICAgICAgLy8gXHU3MEI5XHU3QjJDXHU0RTAwXHU0RTJBXHU1REU1XHU0RjVDXHU1MzNBXHU5ODc5ID0gXHU1NzI4XHU4QkU1XHU1REU1XHU0RjVDXHU1MzNBXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREKFx1ODNEQ1x1NTM1NVx1NTE3M1x1OTVFRFx1MzAwMWNvbXBvc2VyIFx1NTNFRlx1NzUyOClcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgaXQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLW1lbnUtaXRlbScpOyBpZihpdCkgaXQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBjbG9zZWQgPSBhd2FpdCB3YWl0Rm9yKCdtZW51IGNsb3NlZCArIHNlc3Npb24gYWN0aXZlJywgYHZhciB0YT1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY29tcG9zZXIgdGV4dGFyZWEnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLW1lbnUnKSAmJiAhIXRhICYmIHRhLmRpc2FibGVkID09PSBmYWxzZSwgZGV0YWlsOiAnbWVudT0nKyhkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtbWVudScpPydvcGVuJzonY2xvc2VkJykrJyB0YT0nKyh0YT90YS5kaXNhYmxlZDonbm9uZScpfTtgLCA2XzAwMCk7XHJcbiAgICAgIHJldHVybiBbY2xvc2VkWzBdLCBgJHt3WzFdfTsgJHtjbG9zZWRbMV19YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU0RjFBXHU4QkREXHU2MzA5XHU1REU1XHU0RjVDXHU1MzNBXHU1MjA2XHU3RUM0ICsgXHU1QzU1XHU1RjAwL1x1NjUzNlx1OEQ3NyA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTRGMUFcdThCRERcdTUyMDZcdTdFQzQ6XHU3RUM0XHU1OTM0XHU1MUZBXHU3M0IwKFx1NURFNVx1NEY1Q1x1NTMzQVx1NTQwRCtcdTY1NzBcdTkxQ0YpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignZ3JvdXAgaGVhZCcsIGB2YXIgaD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtZ3JvdXAtaGVhZCcpO1xyXG4gICAgICAgIHZhciBuID0gaCA/IChoLnF1ZXJ5U2VsZWN0b3IoJy53cy1ncm91cC1uYW1lJyl8fHt9KS50ZXh0Q29udGVudCA6ICcnO1xyXG4gICAgICAgIHZhciBjID0gaCA/IChoLnF1ZXJ5U2VsZWN0b3IoJy53cy1ncm91cC1jb3VudCcpfHx7fSkudGV4dENvbnRlbnQgOiAnJztcclxuICAgICAgICByZXR1cm4ge29rOiAhIWggJiYgbi5sZW5ndGggPiAwICYmIGMubGVuZ3RoID4gMCwgZGV0YWlsOiAnbmFtZT0nK24rJyBjb3VudD0nK2N9O2AsIDhfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnXHU0RjFBXHU4QkREXHU1MjA2XHU3RUM0Olx1NzBCOVx1NTFGQlx1N0VDNFx1NTkzNFx1NjUzNlx1OEQ3NyxcdTUxOERcdTcwQjlcdTVDNTVcdTVGMDBcdTYwNjJcdTU5MEQnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IGJlZm9yZSA9IChhd2FpdCBqcyhgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aGApKSBhcyBudW1iZXI7XHJcbiAgICAgIGlmIChiZWZvcmUgPT09IDApIHJldHVybiBbZmFsc2UsICdubyBzZXNzaW9ucyB0byBncm91cCddO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBoPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1ncm91cC1oZWFkJyk7IGlmKGgpIGguY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBjb2xsYXBzZWQgPSBhd2FpdCB3YWl0Rm9yKCdjb2xsYXBzZWQnLCBgdmFyIGc9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLWdyb3VwJyk7XHJcbiAgICAgICAgdmFyIGhpZGRlbiA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGggPCAke2JlZm9yZX07XHJcbiAgICAgICAgcmV0dXJuIHtvazogaGlkZGVuLCBkZXRhaWw6ICdpdGVtcz0nK2RvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGgrJyBiZWZvcmU9JHtiZWZvcmV9J307YCwgNV8wMDApO1xyXG4gICAgICBhd2FpdCBzaG90KCd3cy1ncm91cC1jb2xsYXBzZWQnKTtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgaD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtZ3JvdXAtaGVhZCcpOyBpZihoKSBoLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgZXhwYW5kZWQgPSBhd2FpdCB3YWl0Rm9yKCdleHBhbmRlZCBiYWNrJywgYHZhciBuPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGg7XHJcbiAgICAgICAgcmV0dXJuIHtvazogbiA+PSAke2JlZm9yZX0sIGRldGFpbDogJ2l0ZW1zPScrbn07YCwgNV8wMDApO1xyXG4gICAgICByZXR1cm4gW2NvbGxhcHNlZFswXSAmJiBleHBhbmRlZFswXSwgYGNvbGxhcHNlOiAke2NvbGxhcHNlZFsxXX07IGV4cGFuZDogJHtleHBhbmRlZFsxXX1gXTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTVGRUJcdTYzNzdcdTk1MkVcdTVFMkVcdTUyQTlcdTk3NjJcdTY3N0YoQ3RybCsvKSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTVGRUJcdTYzNzdcdTk1MkVcdTVFMkVcdTUyQTk6Q3RybCsvIFx1NjI1M1x1NUYwMCxFc2MgXHU1MTczXHU5NUVEJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OicvJywgY3RybEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3Nob3J0Y3V0cyBvcGVuJywgYHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrJyk7XHJcbiAgICAgICAgdmFyIHJvd3MgPSBzID8gcy5xdWVyeVNlbGVjdG9yQWxsKCcuc2hvcnRjdXQtcm93JykubGVuZ3RoIDogMDtcclxuICAgICAgICByZXR1cm4ge29rOiByb3dzID49IDUsIGRldGFpbDogJ3Jvd3M9Jytyb3dzfTtgLCA1XzAwMCk7XHJcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgIGF3YWl0IHNob3QoJ3Nob3J0Y3V0cycpO1xyXG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidFc2NhcGUnLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ3Nob3J0Y3V0cyBjbG9zZWQnLCBgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrLW92ZXJsYXknKSwgZGV0YWlsOiAnY2xvc2VkJ307YCwgNV8wMDApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NEZBN1x1NjgwRlx1NjUzNlx1N0YyOSArIFx1NzJCNlx1NjAwMVx1OEZDN1x1NkVFNCA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTRGQTdcdTY4MEZcdTY1MzZcdTdGMjk6XHUyMUU0IFx1NjUzNlx1OEQ3N1x1NURFNlx1NjgwRixcdTIxRTUgXHU1QzU1XHU1RjAwXHU2MDYyXHU1OTBEJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAvLyBISUcgUDMgXHU3RUM0MjpcdTIxRTQvXHUyMUU1IEVtb2ppIFx1NURGMlx1NjM2MiBTVkcgaWNvbixcdTYzMDlcdTk0QUVcdTRFRTUgYXJpYS1sYWJlbChcdTU0MkJcIlx1NEZBN1x1NjgwRlwiKVx1NUI5QVx1NEY0RFxyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcigndG9nZ2xlIGJ0bicsIGB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50b3BiYXIgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuICh4LmdldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcpfHwnJykuaW5kZXhPZignXHU0RkE3XHU2ODBGJyk+PTA7fSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFiLCBkZXRhaWw6ICdidG49JysoYj9iLmdldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcpOidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50b3BiYXIgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuICh4LmdldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcpfHwnJykuaW5kZXhPZignXHU0RkE3XHU2ODBGJyk+PTA7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBoaWRkZW4gPSBhd2FpdCB3YWl0Rm9yKCdzaWRlYmFyIGhpZGRlbicsIGB2YXIgc2I9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXInKTtcclxuICAgICAgICB2YXIgZ29uZSA9ICFzYiB8fCBnZXRDb21wdXRlZFN0eWxlKHNiKS5kaXNwbGF5ID09PSAnbm9uZSc7XHJcbiAgICAgICAgcmV0dXJuIHtvazogZ29uZSwgZGV0YWlsOiAnZGlzcGxheT0nKyhzYj9nZXRDb21wdXRlZFN0eWxlKHNiKS5kaXNwbGF5Oidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50b3BiYXIgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuICh4LmdldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcpfHwnJykuaW5kZXhPZignXHU0RkE3XHU2ODBGJyk+PTA7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBzaG93biA9IGF3YWl0IHdhaXRGb3IoJ3NpZGViYXIgYmFjaycsIGB2YXIgc2I9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXInKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXNiICYmIGdldENvbXB1dGVkU3R5bGUoc2IpLmRpc3BsYXkgIT09ICdub25lJywgZGV0YWlsOiAnZGlzcGxheT0nKyhzYj9nZXRDb21wdXRlZFN0eWxlKHNiKS5kaXNwbGF5Oidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgICAgcmV0dXJuIFtoaWRkZW5bMF0gJiYgc2hvd25bMF0sIGBoaWRlOiAke2hpZGRlblsxXX07IHNob3c6ICR7c2hvd25bMV19YF07XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ1x1NzJCNlx1NjAwMVx1OEZDN1x1NkVFNDpcdTRFMEJcdTYyQzlcdTUyMDdcdTYzNjJcdTUyMzBcIlx1OEZEMFx1ODg0Q1x1NEUyRFwiXHU0RTBEXHU1RDI5XHU2RTgzXHU1RTc2XHU2MDYyXHU1OTBEJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCBzZWwgPSBhd2FpdCB3YWl0Rm9yKCdmaWx0ZXIgc2VsZWN0JywgYHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zdGF0dXMtZmlsdGVyJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFzICYmIHMub3B0aW9ucy5sZW5ndGggPj0gNCwgZGV0YWlsOiAnb3B0aW9ucz0nKyhzP3Mub3B0aW9ucy5sZW5ndGg6MCl9O2AsIDVfMDAwKTtcclxuICAgICAgaWYgKCFzZWxbMF0pIHJldHVybiBzZWw7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnN0YXR1cy1maWx0ZXInKTsgcy52YWx1ZT0ncnVubmluZyc7IHMuZGlzcGF0Y2hFdmVudChuZXcgRXZlbnQoJ2NoYW5nZScse2J1YmJsZXM6dHJ1ZX0pKTsgfSkoKWApO1xyXG4gICAgICBhd2FpdCBzbGVlcCg1MDApO1xyXG4gICAgICBjb25zdCByMSA9IChhd2FpdCBqcyhgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aGApKSBhcyBudW1iZXI7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnN0YXR1cy1maWx0ZXInKTsgcy52YWx1ZT0nYWxsJzsgcy5kaXNwYXRjaEV2ZW50KG5ldyBFdmVudCgnY2hhbmdlJyx7YnViYmxlczp0cnVlfSkpOyB9KSgpYCk7XHJcbiAgICAgIGF3YWl0IHNsZWVwKDUwMCk7XHJcbiAgICAgIGNvbnN0IHIyID0gKGF3YWl0IGpzKGBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoYCkpIGFzIG51bWJlcjtcclxuICAgICAgcmV0dXJuIFtyMiA+PSByMSAmJiByMiA+PSAxLCBgcnVubmluZz0ke3IxfSBhbGw9JHtyMn1gXTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTZBMjFcdTU3OEJcdTkwMDlcdTYyRTlcdTU2NjgoXHU5ODc2XHU2ODBGXHU1MjA3XHU2MzYyIGNoYXQgXHU4REVGXHU3NTMxKSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTZBMjFcdTU3OEJcdTkwMDlcdTYyRTlcdTU2Njg6XHU5ODc2XHU2ODBGXHU4M0RDXHU1MzU1XHU1MjE3XHU1MUZBIHByb3ZpZGVycyBcdTVFNzZcdTUzRUZcdTUyMDdcdTYzNjInLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdtb2RlbCBidXR0b24nLCBgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnRvcGJhci1tb2RlbC5hcy1idXR0b24nKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWIgJiYgYi5kaXNhYmxlZCA9PT0gZmFsc2UsIGRldGFpbDogYiA/IGIudGV4dENvbnRlbnQgOiAnbm9uZSd9O2AsIDZfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudG9wYmFyLW1vZGVsLmFzLWJ1dHRvbicpOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgbSA9IGF3YWl0IHdhaXRGb3IoJ21vZGVsIG1lbnUnLCBgdmFyIG09ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLm1vZGVsLW1lbnUnKTtcclxuICAgICAgICB2YXIgaXRlbXMgPSBtID8gbS5xdWVyeVNlbGVjdG9yQWxsKCcud3MtbWVudS1pdGVtJykubGVuZ3RoIDogMDtcclxuICAgICAgICB2YXIgY3VyID0gbSA/IG0ucXVlcnlTZWxlY3RvckFsbCgnLndzLW1lbnUtaXRlbS5jdXJyZW50JykubGVuZ3RoIDogMDtcclxuICAgICAgICByZXR1cm4ge29rOiBpdGVtcyA+PSAyICYmIGN1ciA+PSAxLCBkZXRhaWw6ICdpdGVtcz0nK2l0ZW1zKycgY3VycmVudD0nK2N1cn07YCwgNV8wMDApO1xyXG4gICAgICBpZiAoIW1bMF0pIHJldHVybiBtO1xyXG4gICAgICBhd2FpdCBzaG90KCdtb2RlbC1tZW51Jyk7XHJcbiAgICAgIC8vIFx1NTIwN1x1NTIzMFx1N0IyQ1x1NEU4Q1x1NEUyQSBwcm92aWRlcihmYWtlOiBkZW1vLXZpc2lvbi9mYWtlLW0tdmlzaW9uKVxyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBpdHM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcubW9kZWwtbWVudSAud3MtbWVudS1pdGVtJykpOyB2YXIgaXQ9aXRzW2l0cy5sZW5ndGgtMV07IGlmKGl0KSBpdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdtb2RlbCBzd2l0Y2hlZCcsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudG9wYmFyLW1vZGVsLmFzLWJ1dHRvbicpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYiAmJiBiLnRleHRDb250ZW50LmluZGV4T2YoJ2Zha2UtbS12aXNpb24nKSA+PSAwLCBkZXRhaWw6ICdiYWRnZT0nKyhiP2IudGV4dENvbnRlbnQ6J25vbmUnKX07YCwgNl8wMDApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NEUzQlx1OTg5OChcdTZENDVcdTgyNzJcdTc1MUZcdTY1NDhcdTIxOTJcdTYwNjJcdTU5MERcdTZERjFcdTgyNzIpID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1NEUzQlx1OTg5ODpcdThCQkVcdTdGNkVcdTUyMDdcdTZENDVcdTgyNzJcdTc1MUZcdTY1NDgsXHU2MDYyXHU1OTBEXHU2REYxXHU4MjcyJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidwJywgY3RybEtleTp0cnVlLCBzaGlmdEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3NldHRpbmdzIG9wZW4nLCBgdmFyIHM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNtZGsuc2V0dGluZ3MnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXMsIGRldGFpbDogcyA/ICdvcGVuJyA6ICdub3Qgb3Blbid9O2AsIDVfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jbWRrLnNldHRpbmdzIC5zZWcgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NkQ0NVx1ODI3Mid8fHgudGV4dENvbnRlbnQudHJpbSgpPT09J0xpZ2h0Jzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IGxpZ2h0ID0gYXdhaXQgd2FpdEZvcignbGlnaHQgdGhlbWUnLCBgdmFyIGR0PWRvY3VtZW50LmRvY3VtZW50RWxlbWVudC5kYXRhc2V0LnRoZW1lO1xyXG4gICAgICAgIHZhciBiZyA9IGdldENvbXB1dGVkU3R5bGUoZG9jdW1lbnQuYm9keSkuYmFja2dyb3VuZENvbG9yO1xyXG4gICAgICAgIHZhciBtID0gL1xcXFxkKy9nOyB2YXIgbnVtcz0oYmcubWF0Y2gobSl8fFsnMCcsJzAnLCcwJ10pLm1hcChOdW1iZXIpO1xyXG4gICAgICAgIHJldHVybiB7b2s6IGR0PT09J2xpZ2h0JyAmJiBudW1zWzBdPjIwMCAmJiBudW1zWzFdPjIwMCAmJiBudW1zWzJdPjIwMCwgZGV0YWlsOiAndGhlbWU9JytkdCsnIGJnPScrYmd9O2AsIDVfMDAwKTtcclxuICAgICAgYXdhaXQgc2hvdCgnbGlnaHQtdGhlbWUnKTtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jbWRrLnNldHRpbmdzIC5zZWcgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NkRGMVx1ODI3Mid8fHgudGV4dENvbnRlbnQudHJpbSgpPT09J0RhcmsnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgZGFyayA9IGF3YWl0IHdhaXRGb3IoJ2RhcmsgYmFjaycsIGByZXR1cm4ge29rOiBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuZGF0YXNldC50aGVtZT09PSdkYXJrJywgZGV0YWlsOiAndGhlbWU9Jytkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuZGF0YXNldC50aGVtZX07YCwgNV8wMDApO1xyXG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidFc2NhcGUnLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgcmV0dXJuIFtsaWdodFswXSAmJiBkYXJrWzBdLCBgbGlnaHQ6ICR7bGlnaHRbMV19OyBkYXJrOiAke2RhcmtbMV19YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU5ODc2XHU2ODBGIFx1NEUyRC9FTiBcdTVGRUJcdTYzNzdcdTUyMDdcdTYzNjIoXHU1M0VGXHU1M0QxXHU3M0IwXHU2MDI3KSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTk4NzZcdTY4MEZcdTVGRUJcdTYzNzdcdTUyMDdcdTYzNjI6XHU0RTJEL0VOIFx1NEUwMFx1OTUyRVx1NTIwN1x1NjM2MicsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2xhbmcgc2VnJywgYHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5sYW5nLXNlZycpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhcyAmJiBzLnF1ZXJ5U2VsZWN0b3JBbGwoJ2J1dHRvbicpLmxlbmd0aCA9PT0gMiwgZGV0YWlsOiBzID8gJ3ByZXNlbnQnIDogJ2Fic2VudCd9O2AsIDVfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5sYW5nLXNlZyBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nRU4nO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgZW4gPSBhd2FpdCB3YWl0Rm9yKCdlbmdsaXNoJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyLWhlYWQgLmJ0bi5wcmltYXJ5Jyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFiICYmIGIudGV4dENvbnRlbnQgPT09ICcrIE5ldyBTZXNzaW9uJywgZGV0YWlsOiAnYnRuPScrKGI/Yi50ZXh0Q29udGVudDonbm9uZScpfTtgLCA1XzAwMCk7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcubGFuZy1zZWcgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NEUyRCc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCB6aCA9IGF3YWl0IHdhaXRGb3IoJ2NoaW5lc2UgYmFjaycsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhci1oZWFkIC5idG4ucHJpbWFyeScpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYiAmJiBiLnRleHRDb250ZW50ID09PSAnKyBcdTY1QjBcdTVFRkFcdTRGMUFcdThCREQnLCBkZXRhaWw6ICdidG49JysoYj9iLnRleHRDb250ZW50Oidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgICAgcmV0dXJuIFtlblswXSAmJiB6aFswXSwgYGVuOiAke2VuWzFdfTsgemg6ICR7emhbMV19YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU3Qzk4XHU4RDM0XHU1NkZFXHU3MjQ3IFx1MjE5MiBcdTdGMjlcdTc1NjVcdTU2RkUgY2hpcCBcdTIxOTIgXHU1M0QxXHU5MDAxIFx1MjE5MiBydW50aW1lIFx1NjUzNlx1NTIzMCA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTdDOThcdThEMzRcdTU2RkVcdTcyNDc6XHU3RjI5XHU3NTY1XHU1NkZFIGNoaXAgKyBcdTUzRDFcdTkwMDFcdTU0MEUgcnVudGltZSBcdTY1MzZcdTUyMzBcdTU2RkVcdTcyNDcnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIC8vIFx1NjVCMFx1NUVGQVx1NEYxQVx1OEJERFx1Nzg2RVx1NEZERCBjb21wb3NlciBcdTUzRUZcdTc1MjhcclxuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleTonbicsIGN0cmxLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XHJcbiAgICAgIGF3YWl0IHNsZWVwKDMwMCk7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXtcclxuICAgICAgICB2YXIgdGEgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY29tcG9zZXIgdGV4dGFyZWEnKTtcclxuICAgICAgICBpZiAoIXRhKSByZXR1cm47XHJcbiAgICAgICAgdmFyIGMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdjYW52YXMnKTtcclxuICAgICAgICBjLndpZHRoID0gODsgYy5oZWlnaHQgPSA4O1xyXG4gICAgICAgIHZhciBjdHggPSBjLmdldENvbnRleHQoJzJkJyk7XHJcbiAgICAgICAgY3R4LmZpbGxTdHlsZSA9ICcjM2Y5NjUwJzsgY3R4LmZpbGxSZWN0KDAsIDAsIDgsIDgpO1xyXG4gICAgICAgIGMudG9CbG9iKGZ1bmN0aW9uKGJsb2Ipe1xyXG4gICAgICAgICAgdmFyIGR0ID0gbmV3IERhdGFUcmFuc2ZlcigpO1xyXG4gICAgICAgICAgZHQuaXRlbXMuYWRkKG5ldyBGaWxlKFtibG9iXSwgJ3Bhc3RlZC5wbmcnLCB7dHlwZTogJ2ltYWdlL3BuZyd9KSk7XHJcbiAgICAgICAgICB0YS5kaXNwYXRjaEV2ZW50KG5ldyBDbGlwYm9hcmRFdmVudCgncGFzdGUnLCB7Y2xpcGJvYXJkRGF0YTogZHQsIGJ1YmJsZXM6IHRydWUsIGNhbmNlbGFibGU6IHRydWV9KSk7XHJcbiAgICAgICAgfSwgJ2ltYWdlL3BuZycpO1xyXG4gICAgICB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IGNoaXAgPSBhd2FpdCB3YWl0Rm9yKCdpbWFnZSBjaGlwJywgYHZhciBuPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5hdHQtY2hpcC5pbWcnKS5sZW5ndGg7XHJcbiAgICAgICAgcmV0dXJuIHtvazogbiA+PSAxLCBkZXRhaWw6ICdpbWcgY2hpcHM9JytufTtgLCA2XzAwMCk7XHJcbiAgICAgIGlmICghY2hpcFswXSkgcmV0dXJuIGNoaXA7XHJcbiAgICAgIGF3YWl0IHR5cGVJbnRvKCcuY29tcG9zZXIgdGV4dGFyZWEnLCAnXHU3NzBCXHU4RkQ5XHU1RjIwXHU1NkZFJyk7XHJcbiAgICAgIGF3YWl0IHNsZWVwKDIwMCk7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY29tcG9zZXIgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NTNEMVx1OTAwMSc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBkb25lID0gYXdhaXQgd2FpdEZvcignaW1hZ2Ugc2VudCcsIGBcclxuICAgICAgICB2YXIgYXAgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuYXBwcm92YWwtY2FyZCBidXR0b24nKTtcclxuICAgICAgICBpZiAoYXAgJiYgYXAudGV4dENvbnRlbnQudHJpbSgpLmluZGV4T2YoJ1x1NjI3OVx1NTFDNicpPj0wKSBhcC5jbGljaygpO1xyXG4gICAgICAgIHZhciB0cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50dXJuJykpO1xyXG4gICAgICAgIHZhciBoaXQgPSB0cy5maWx0ZXIoZnVuY3Rpb24oeCl7IHJldHVybiB4LmNsYXNzTmFtZS5pbmRleE9mKCd1c2VyJyk8MCAmJiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1tpbWFnZXM6IDFdJykgPj0gMDsgfSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogaGl0Lmxlbmd0aCA+PSAxLCBkZXRhaWw6ICdydW50aW1lLWVjaG8td2l0aC1pbWFnZT0nK2hpdC5sZW5ndGh9O1xyXG4gICAgICBgLCAxNV8wMDApO1xyXG4gICAgICBhd2FpdCBzaG90KCdwYXN0ZWQtaW1hZ2UnKTtcclxuICAgICAgcmV0dXJuIGRvbmU7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHVEODNEXHVEQ0NFIFx1NEUwQVx1NEYyMC9cdUQ4M0RcdURDQzEgXHU2RDRGXHU4OUM4XHU2MzA5XHU5NEFFXHU1QzMxXHU0RjREID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1OTY0NFx1NEVGNlx1NEUwRVx1NzZFRVx1NUY1NVx1NTE2NVx1NTNFMzpcdUQ4M0RcdURDQ0UgXHU0RTBBXHU0RjIwICsgXHVEODNEXHVEQ0MxIFx1NkQ0Rlx1ODlDOFx1NjMwOVx1OTRBRVx1NUI1OFx1NTcyOCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgciA9IChhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XHJcbiAgICAgICAgdmFyIHVwID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNvbXBvc2VyIGJ1dHRvblthcmlhLWxhYmVsKj1cIlx1NEUwQVx1NEYyMFwiXSwgLmNvbXBvc2VyIGJ1dHRvblthcmlhLWxhYmVsKj1cIlVwbG9hZFwiXScpO1xyXG4gICAgICAgIHZhciBiciA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1waWNrZXIgYnV0dG9uJyk7XHJcbiAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHt1cDogISF1cCwgYnJvd3NlOiAhIWJyfSk7XHJcbiAgICAgIH0pKClgKSkgYXMgc3RyaW5nO1xyXG4gICAgICBjb25zdCBwID0gSlNPTi5wYXJzZShyKSBhcyB7IHVwOiBib29sZWFuOyBicm93c2U6IGJvb2xlYW4gfTtcclxuICAgICAgcmV0dXJuIFtwLnVwICYmIHAuYnJvd3NlLCBgXHVEODNEXHVEQ0NFPSR7cC51cH0gXHVEODNEXHVEQ0MxPSR7cC5icm93c2V9YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6QCBcdTk2NDRcdTRFRjZcdTkwMDlcdTYyRTlcdTU2NjggPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnQCBcdTk2NDRcdTRFRjY6XHU5MDA5XHU2MkU5XHU1NjY4XHU1MUZBXHU3M0IwXHU1RTc2XHU1M0VGXHU5MDA5XHU2NTg3XHU0RUY2JywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNvbXBvc2VyIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdAJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdhdHQgcGlja2VyJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5hdHQtcGlja2VyJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFwLCBkZXRhaWw6IHAgPyAnb3BlbicgOiAnbm90IG9wZW4nfTtgLCA1XzAwMCk7XHJcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgIGF3YWl0IHR5cGVJbnRvKCcuYXR0LXBpY2tlciBpbnB1dCcsICdyZWFkJyk7XHJcbiAgICAgIGNvbnN0IHcyID0gYXdhaXQgd2FpdEZvcignYXR0IHJlc3VsdHMnLCBgdmFyIHI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmF0dC1yZXN1bHRzIC5mcy1yb3cnKS5sZW5ndGg7XHJcbiAgICAgICAgcmV0dXJuIHtvazogciA+PSAxLCBkZXRhaWw6ICdyZXN1bHRzPScrcn07YCwgNl8wMDApO1xyXG4gICAgICBpZiAoIXcyWzBdKSByZXR1cm4gdzI7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGY9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmF0dC1yZXN1bHRzIC5mcy1yb3cnKTsgaWYoZikgZi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdhdHQgY2hpcCcsIGB2YXIgYz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuYXR0LWNoaXAnKS5sZW5ndGg7XHJcbiAgICAgICAgcmV0dXJuIHtvazogYyA+PSAxLCBkZXRhaWw6ICdjaGlwcz0nK2N9O2AsIDVfMDAwKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZShcdTU0MTFcdTVCRkNcdTY3ODRcdTkwMjApOlx1OEJCRVx1N0Y2RVx1MzAwQ1x1OTFDRFx1NjVCMFx1OTE0RFx1N0Y2RVx1MzAwRFx1OTFDRFx1NTE2NSArIFx1OTAwOVx1NjJFOVx1NjMwMVx1NEU0NSA9PT09PT09PT09ICovXHJcbiAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfV0laQVJEID09PSAnZmFrZScpIHtcclxuICAgICAgYXdhaXQgc3RlcCgnXHU1NDExXHU1QkZDOlx1OEJCRVx1N0Y2RVx1MzAwQ1x1OTFDRFx1NjVCMFx1OTE0RFx1N0Y2RVx1MzAwRFx1OTFDRFx1NTE2NSArIFx1OTAwOVx1NjJFOVx1NjMwMVx1NEU0NSh3aXphcmQuanNvbiknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleToncCcsIGN0cmxLZXk6dHJ1ZSwgc2hpZnRLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XHJcbiAgICAgICAgY29uc3Qgb3BlbiA9IGF3YWl0IHdhaXRGb3IoJ3NldHRpbmdzIG9wZW4nLCBgdmFyIHM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNtZGsuc2V0dGluZ3MnKTtcclxuICAgICAgICAgIHJldHVybiB7b2s6ICEhcywgZGV0YWlsOiBzID8gJ29wZW4nIDogJ2Nsb3NlZCd9O2AsIDVfMDAwKTtcclxuICAgICAgICBpZiAoIW9wZW5bMF0pIHJldHVybiBvcGVuO1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY21kay5zZXR0aW5ncyBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTkxQ0RcdTY1QjBcdTkxNERcdTdGNkUnKT49MDt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgY29uc3Qgc2hvd24gPSBhd2FpdCB3YWl0Rm9yKCd3aXphcmQgcmVvcGVuZWQnLCBgcmV0dXJuIHtvazogISFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKSxcclxuICAgICAgICAgIGRldGFpbDogZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1vdmVybGF5JykgPyAnb3BlbicgOiAnY2xvc2VkJ307YCwgNV8wMDApO1xyXG4gICAgICAgIGlmICghc2hvd25bMF0pIHJldHVybiBzaG93bjtcclxuICAgICAgICBhd2FpdCBzaG90KCd3aXphcmQtcmVlbnRyeScpO1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NTNENlx1NkQ4OCc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgIGNvbnN0IGNsb3NlZCA9IGF3YWl0IHdhaXRGb3IoJ3dpemFyZCBjbG9zZWQnLCBgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3ZlcmxheScpLCBkZXRhaWw6ICdjbG9zZWQnfTtgLCA1XzAwMCk7XHJcbiAgICAgICAgY29uc3Qgc3QgPSAoYXdhaXQganMoYHdpbmRvdy5obWguZ2V0V2l6YXJkKCkudGhlbihmdW5jdGlvbihyKXtyZXR1cm4gSlNPTi5zdHJpbmdpZnkocik7fSlgKSkgYXMgc3RyaW5nO1xyXG4gICAgICAgIGNvbnN0IHAgPSBKU09OLnBhcnNlKHN0KSBhcyB7IHBlcnNpc3RlZD86IHsgZG9uZT86IGJvb2xlYW47IGNob2ljZT86IHN0cmluZyB9IH07XHJcbiAgICAgICAgY29uc3QgcGVyc2lzdGVkID0gcC5wZXJzaXN0ZWQ/LmRvbmUgPT09IHRydWUgJiYgcC5wZXJzaXN0ZWQ/LmNob2ljZSA9PT0gJ2J1bmRsZWQnO1xyXG4gICAgICAgIHJldHVybiBbY2xvc2VkWzBdICYmIHBlcnNpc3RlZCwgYGNsb3NlZD0ke2Nsb3NlZFswXX0gcGVyc2lzdGVkPSR7SlNPTi5zdHJpbmdpZnkocC5wZXJzaXN0ZWQgPz8gbnVsbCl9YF07XHJcbiAgICAgIH0pO1xyXG5cclxuICAgICAgLyogPT09PT09PT09PSBmYWtlKFx1NTQxMVx1NUJGQ1x1Njc4NFx1OTAyMCk6XHU3QTg0XHU1QzRGIDM2MFx1MDBENzY0MCBcdTUxNjhcdTUxNDNcdTdEMjBcdTUzRUZcdThGQkUgKyBcdTUzNTVcdTUxRkJcdTkwMDlcdTk4NzlcdTUzNzNcdTUyNERcdThGREIgPT09PT09PT09PVxyXG4gICAgICAgICBcdTc1MjhcdTYyMzdcdTYyNEJcdTY3M0FcdTVCOUVcdTZENEJcdTc1REJcdTcwQjk6XHU3QTg0XHU4OUM2XHU1M0UzXHU0RTBCXHU5MDA5XHU5ODc5L1x1NjMwOVx1OTRBRVx1ODhBQlx1ODhDMVx1NTIwN1x1NzBCOVx1NEUwRFx1NTIzMFx1MzAwMlx1NEYyQVx1OTAyMFwiXHU2OEMwXHU2RDRCXHU1MjMwXHU1REYyXHU4OEM1XCJcclxuICAgICAgICAgKFx1NEUzQlx1OEZEQlx1N0EwQiBlbnYgXHU1MzczXHU2NUY2XHU4QkZCKVx1OEJBOVx1NTQxMVx1NUJGQ1x1NTFGQVx1NzNCMFx1NEUwOVx1OTAwOVx1OTg3OVx1OERFRlx1NUY4NCxcdTdGMjlcdTUyMzAgMzYwXHUwMEQ3NjQwIFx1NTQwRVx1OTAxMFx1NEUyQVxyXG4gICAgICAgICBlbGVtZW50RnJvbVBvaW50IFx1NjVBRFx1OEEwMChcdTRFMERcdTY2MkZcdTg4QUJcdTg4QzFcdTUyMDcpO1x1NTE4RFx1OUE4Q1x1OEJDMVx1NTM1NVx1NTFGQlx1NTI0RFx1OEZEQlx1NEUwRVx1NTNENlx1NkQ4OFx1MzAwMiAqL1xyXG4gICAgICBhd2FpdCBzdGVwKCdcdTU0MTFcdTVCRkM6XHU3QTg0XHU1QzRGIDM2MFx1MDBENzY0MFx1MjAxNFx1MjAxNFx1NEUwOVx1OTAwOVx1OTg3OShcdTU0MkIgbm90ZSBcdTY1NzRcdTY4MEYpXHU0RTBFXHU2MzA5XHU5NEFFXHU1MTY4XHU5MEU4XHU1M0VGXHU1NDdEXHU0RTJEK1x1NTM1NVx1NTFGQlx1NTM3M1x1NTI0RFx1OEZEQicsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9GQUtFX0RFVEVDVF9GT1VORCA9ICcxJztcclxuICAgICAgICBjb25zdCBzaXplMCA9IHdpbi5nZXRTaXplKCk7XHJcbiAgICAgICAgY29uc3QgdzAgPSBzaXplMFswXSA/PyAxMjgwO1xyXG4gICAgICAgIGNvbnN0IGgwID0gc2l6ZTBbMV0gPz8gODAwO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidwJywgY3RybEtleTp0cnVlLCBzaGlmdEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgICAgIGNvbnN0IG9wZW4gPSBhd2FpdCB3YWl0Rm9yKCdzZXR0aW5ncyBvcGVuJywgYHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrLnNldHRpbmdzJyk7IHJldHVybiB7b2s6ICEhcywgZGV0YWlsOiBzID8gJ29wZW4nIDogJ2Nsb3NlZCd9O2AsIDVfMDAwKTtcclxuICAgICAgICAgIGlmICghb3BlblswXSkgcmV0dXJuIG9wZW47XHJcbiAgICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNtZGsuc2V0dGluZ3MgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU5MUNEXHU2NUIwXHU5MTREXHU3RjZFJyk+PTA7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgICAgY29uc3Qgc2hvd24gPSBhd2FpdCB3YWl0Rm9yKCd3aXphcmQgcmVvcGVuZWQnLCBgcmV0dXJuIHtvazogISFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKSwgZGV0YWlsOiBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKSA/ICdvcGVuJyA6ICdjbG9zZWQnfTtgLCA1XzAwMCk7XHJcbiAgICAgICAgICBpZiAoIXNob3duWzBdKSByZXR1cm4gc2hvd247XHJcbiAgICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTVGMDBcdTU5Q0JcdTkxNERcdTdGNkUnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICAgIGNvbnN0IGRldGVjdFBhZ2UgPSBhd2FpdCB3YWl0Rm9yKCdkZXRlY3QgZm91bmQgcGFnZSgzIG9wdGlvbnMpJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1kZXRlY3QnKTtcclxuICAgICAgICAgICAgdmFyIG9wdHM9cD9wLnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3B0JykubGVuZ3RoOjA7XHJcbiAgICAgICAgICAgIHJldHVybiB7b2s6ICEhcCAmJiBvcHRzPT09MywgZGV0YWlsOiAnb3B0cz0nK29wdHN9O2AsIDEyXzAwMCk7XHJcbiAgICAgICAgICBpZiAoIWRldGVjdFBhZ2VbMF0pIHJldHVybiBkZXRlY3RQYWdlO1xyXG4gICAgICAgICAgLy8gXHU1MzU1XHU1MUZCXHU5MDA5XHU5ODc5XHU1MzczXHU1MjREXHU4RkRCOlx1NzBCOVwiXHU0RUNEXHU4OTgxXHU0RTBCXHU4RjdEXHU2NUIwXHU3MjQ4XCJcdTVFOTRcdTc2RjRcdTYzQTVcdTg0M0RcdTUyMzBcdTkwMDlcdTYyRTlcdTk4NzUoXHU2NUUwXHU5NzAwXHU1MThEXHU3MEI5XCJcdTRFMEJcdTRFMDBcdTZCNjVcIilcclxuICAgICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIG89W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW9wdCcpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1NEVDRFx1ODk4MVx1NEUwQlx1OEY3RFx1NjVCMFx1NzI0OCcpPj0wO30pOyBpZihvKSBvLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICAgIGNvbnN0IHNlbGVjdFBhZ2UgPSBhd2FpdCB3YWl0Rm9yKCdzZWxlY3QgcGFnZSB2aWEgc2luZ2xlIGNsaWNrJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1zZWxlY3QnKTtcclxuICAgICAgICAgICAgcmV0dXJuIHtvazogISFwICYmIHAucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vcHQnKS5sZW5ndGg9PT0zLCBkZXRhaWw6IHAgPyAnc2VsZWN0JyA6ICdub3Qgc2VsZWN0J307YCwgNl8wMDApO1xyXG4gICAgICAgICAgaWYgKCFzZWxlY3RQYWdlWzBdKSByZXR1cm4gW2ZhbHNlLCBgXHU1MzU1XHU1MUZCXHU5MDA5XHU5ODc5XHU2NzJBXHU1MjREXHU4RkRCXHU1MjMwXHU5MDA5XHU2MkU5XHU5ODc1OiAke3NlbGVjdFBhZ2VbMV19YF07XHJcbiAgICAgICAgICAvLyBcdTdGMjlcdTUyMzAgMzYwXHUwMEQ3NjQwKG1pbldpZHRoIFx1NURGMlx1NTcyOCBVSVZFUklGWSBcdTRFMEJcdTY1M0VcdTVCQkQpLFx1NjVBRFx1OEEwMFx1NTE2OFx1OTBFOFx1NTNFRlx1NTQ3RFx1NEUyRFxyXG4gICAgICAgICAgd2luLnNldFNpemUoMzYwLCA2NDApO1xyXG4gICAgICAgICAgYXdhaXQgc2xlZXAoNTAwKTtcclxuICAgICAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoYChmdW5jdGlvbigpe1xyXG4gICAgICAgICAgICBmdW5jdGlvbiBoaXQoZWwpeyBlbC5zY3JvbGxJbnRvVmlldyh7YmxvY2s6J25lYXJlc3QnfSk7IHZhciByPWVsLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xyXG4gICAgICAgICAgICAgIHZhciB4PXIubGVmdCtyLndpZHRoLzIsIHk9ci50b3Arci5oZWlnaHQvMjtcclxuICAgICAgICAgICAgICB2YXIgZT1kb2N1bWVudC5lbGVtZW50RnJvbVBvaW50KHgseSk7XHJcbiAgICAgICAgICAgICAgcmV0dXJuICEhKGUgJiYgKGU9PT1lbCB8fCBlbC5jb250YWlucyhlKSkpOyB9XHJcbiAgICAgICAgICAgIHZhciBjYXJkPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1zZWxlY3QnKTtcclxuICAgICAgICAgICAgdmFyIG9wdHM9W10uc2xpY2UuY2FsbChjYXJkLnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3B0JykpO1xyXG4gICAgICAgICAgICB2YXIgb3B0SGl0PW9wdHMubWFwKGhpdCk7XHJcbiAgICAgICAgICAgIHZhciBub3Rlcz1bXS5zbGljZS5jYWxsKGNhcmQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vcHQtbm90ZScpKTtcclxuICAgICAgICAgICAgdmFyIG5vdGVIaXQ9bm90ZXMubWFwKGZ1bmN0aW9uKG4peyBuLnNjcm9sbEludG9WaWV3KHtibG9jazonbmVhcmVzdCd9KTsgdmFyIHI9bi5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcclxuICAgICAgICAgICAgICB2YXIgZT1kb2N1bWVudC5lbGVtZW50RnJvbVBvaW50KHIubGVmdCtyLndpZHRoLzIsIHIudG9wK01hdGgubWluKHIuaGVpZ2h0LzIsIDgpKTtcclxuICAgICAgICAgICAgICByZXR1cm4gISEoZSAmJiBvcHRzLnNvbWUoZnVuY3Rpb24obyl7IHJldHVybiBlPT09byB8fCBvLmNvbnRhaW5zKGUpOyB9KSk7IH0pO1xyXG4gICAgICAgICAgICB2YXIgYWN0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1zZWxlY3QgLndpemFyZC1hY3Rpb25zIC5idG4ucHJpbWFyeScpO1xyXG4gICAgICAgICAgICB2YXIgZm9vdGVyPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1mb290ZXIgYnV0dG9uJykpO1xyXG4gICAgICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe3Z3OiB3aW5kb3cuaW5uZXJXaWR0aCwgdmg6IHdpbmRvdy5pbm5lckhlaWdodCwgb3B0czogb3B0cy5sZW5ndGgsXHJcbiAgICAgICAgICAgICAgb3B0SGl0OiBvcHRIaXQsIG5vdGVIaXQ6IG5vdGVIaXQsIGFjdEhpdDogYWN0ID8gaGl0KGFjdCkgOiBmYWxzZSwgZnRIaXQ6IGZvb3Rlci5tYXAoaGl0KX0pO1xyXG4gICAgICAgICAgfSkoKWApKSBhcyBzdHJpbmc7XHJcbiAgICAgICAgICBjb25zdCBxID0gSlNPTi5wYXJzZShyKSBhcyB7IHZ3OiBudW1iZXI7IHZoOiBudW1iZXI7IG9wdHM6IG51bWJlcjsgb3B0SGl0OiBib29sZWFuW107IG5vdGVIaXQ6IGJvb2xlYW5bXTsgYWN0SGl0OiBib29sZWFuOyBmdEhpdDogYm9vbGVhbltdIH07XHJcbiAgICAgICAgICBhd2FpdCBzaG90KCd3aXphcmQtbmFycm93LTM2MC1zZWxlY3QnKTtcclxuICAgICAgICAgIGNvbnN0IG5hcnJvd09rID0gcS5vcHRzID09PSAzICYmIHEudncgPD0gMzgwICYmIHEub3B0SGl0LmV2ZXJ5KEJvb2xlYW4pICYmIHEubm90ZUhpdC5ldmVyeShCb29sZWFuKSAmJiBxLmFjdEhpdCAmJiBxLmZ0SGl0LmV2ZXJ5KEJvb2xlYW4pO1xyXG4gICAgICAgICAgLy8gXHU3QTg0XHU1QzRGXHU0RTBCXHU1MzU1XHU1MUZCXHU5MDA5XHU5ODc5XHUyNDYwID0gXHU5MDA5XHU0RTJEXHU1RTc2XHU1MjREXHU4RkRCXHU1MjMwXHU1Qjg5XHU4OEM1XHU5ODc1KHZlcmlmeSBcdTZBMjFcdTYyREZcdThGREJcdTVFQTYsXHU0RTBEXHU4NDNEXHU3NkQ4KVxyXG4gICAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgbz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3B0JykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU0RTBCXHU4RjdEXHU1Qjg5XHU4OEM1XHU1QjhDXHU2NTc0IGhtaCBDTEknKT49MDt9KTsgaWYobykgby5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgICBjb25zdCBhZHYgPSBhd2FpdCB3YWl0Rm9yKCdpbnN0YWxsIHBhZ2UgdmlhIHNpbmdsZSBjbGljaycsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtaW5zdGFsbCcpO1xyXG4gICAgICAgICAgICByZXR1cm4ge29rOiAhIXAsIGRldGFpbDogcCA/ICdpbnN0YWxsaW5nJyA6ICdub3Qgc2hvd24nfTtgLCA2XzAwMCk7XHJcbiAgICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTUzRDZcdTZEODgnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICAgIGNvbnN0IGNsb3NlZE5hcnJvdyA9IGF3YWl0IHdhaXRGb3IoJ3dpemFyZCBjbG9zZWQgYXQgMzYwcHgnLCBgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3ZlcmxheScpLCBkZXRhaWw6ICdjbG9zZWQnfTtgLCA1XzAwMCk7XHJcbiAgICAgICAgICByZXR1cm4gW25hcnJvd09rICYmIGFkdlswXSAmJiBjbG9zZWROYXJyb3dbMF0sXHJcbiAgICAgICAgICAgIGB2cD0ke3Eudnd9eCR7cS52aH0gb3B0cz0ke3Eub3B0c30gb3B0SGl0PVske3Eub3B0SGl0LmpvaW4oJywnKX1dIG5vdGVIaXQ9WyR7cS5ub3RlSGl0LmpvaW4oJywnKX1dIFx1NEUzQlx1NjMwOVx1OTRBRT0ke3EuYWN0SGl0fSBmb290ZXI9WyR7cS5mdEhpdC5qb2luKCcsJyl9XTsgXHU1MzU1XHU1MUZCXHU1MjREXHU4RkRCOiAke2FkdlsxXX07IFx1N0E4NFx1NUM0Rlx1NTNENlx1NkQ4ODogJHtjbG9zZWROYXJyb3dbMV19YF07XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgIHdpbi5zZXRTaXplKHcwLCBoMCk7XHJcbiAgICAgICAgICBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9GQUtFX0RFVEVDVF9GT1VORCA9IHVuZGVmaW5lZDtcclxuICAgICAgICB9XHJcbiAgICAgIH0pO1xyXG4gICAgfVxyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpISUcgXHU5NjM2XHU2QkI1MiBcdTIwMTRcdTIwMTQgXHU3QTg0XHU3QTk3XHU2MkJEXHU1QzQ5ICsgXHU2ODA3XHU5ODk4XHU2ODBGIDQ0cHgvZHJhZyBcdTUzM0EgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU3QTg0XHU3QTk3XHU2MkJEXHU1QzQ5Ojc2MHB4IFx1NEZBN1x1NjgwRlx1NTNFRlx1OEZCRVx1NTNFRlx1NTE3MyhcdTkwNkVcdTdGNjlcdTcwQjlcdTUxRkIgKyBFc2MpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICB0cnkgeyB3aW4uc2V0TWluaW11bVNpemUoNTYwLCA2MDApOyB3aW4uc2V0Qm91bmRzKHsgd2lkdGg6IDc2MCwgaGVpZ2h0OiA3MDAgfSk7IH0gY2F0Y2ggeyAvKiBiZXN0IGVmZm9ydCAqLyB9XHJcbiAgICAgIGNvbnN0IGlzTmFycm93ID0gYXdhaXQgd2FpdEZvcignbWF0Y2hNZWRpYSA4MjAnLCBgcmV0dXJuIHtvazogd2luZG93Lm1hdGNoTWVkaWEoJyhtYXgtd2lkdGg6IDgyMHB4KScpLm1hdGNoZXMsIGRldGFpbDogJ2l3PScgKyB3aW5kb3cuaW5uZXJXaWR0aH07YCwgNV8wMDApO1xyXG4gICAgICBpZiAoIWlzTmFycm93WzBdKSByZXR1cm4gaXNOYXJyb3c7XHJcbiAgICAgIC8vIFx1N0I0OSBSZWFjdCBcdTYzMDlcdTdBODRcdTdBOTdcdTkxQ0RcdTZFMzJcdTY3RDNcdTUxRkFcdTYyQkRcdTVDNDlcdTYzMDlcdTk0QUUoYXJpYS1sYWJlbCBcdTYzNjJcdTYyMTBcIlx1NjJCRFx1NUM0OVwiXHU2NTg3XHU2ODQ4KVx1NTE4RFx1NzBCOVx1MjAxNFx1MjAxNENTUyBcdTY1QURcdTcwQjlcdTUzNzNcdTY1RjYsXHJcbiAgICAgIC8vIFJlYWN0IHN0YXRlIFx1NjcwOVx1NkJFQlx1NzlEMlx1N0VBN1x1NUVGNlx1OEZERixcdTc2RjJcdTcwQjlcdTRGMUFcdTg0M0RcdTU3MjhcdTY1RTdcdTc2ODRcIlx1NjUzNlx1OEQ3N1x1NEZBN1x1NjgwRlwiXHU0RTBBXHJcbiAgICAgIGNvbnN0IGJ0biA9IGF3YWl0IHdhaXRGb3IoJ2RyYXdlciBidXR0b24nLCBgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudG9wYmFyIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiAoeC5nZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnKXx8JycpLmluZGV4T2YoJ1x1NjJCRFx1NUM0OScpPj0wO30pO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYiwgZGV0YWlsOiAnYnRuPScrKGI/Yi5nZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnKTonbm9uZScpfTtgLCA1XzAwMCk7XHJcbiAgICAgIGlmICghYnRuWzBdKSByZXR1cm4gYnRuO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnRvcGJhciBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4gKHguZ2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJyl8fCcnKS5pbmRleE9mKCdcdTYyQkRcdTVDNDknKT49MDt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IG9wZW5lZCA9IGF3YWl0IHdhaXRGb3IoJ2RyYXdlciBvcGVuJywgYHZhciBzYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhcicpLCBzYz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhci1zY3JpbScpO1xyXG4gICAgICAgIHZhciByPXNiP3NiLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOm51bGw7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFyICYmIHIueCA+PSAwICYmIHIueCA8IDQwICYmICEhc2MsIGRldGFpbDogJ3g9Jysocj9NYXRoLnJvdW5kKHIueCk6J25vbmUnKSsnIHNjcmltPScrKHNjPyd5ZXMnOidubycpfTtgLCA1XzAwMCk7XHJcbiAgICAgIGF3YWl0IHNob3QoJ2RyYXdlci1vcGVuJyk7XHJcbiAgICAgIC8vIFx1OTA2RVx1N0Y2OVx1NzBCOVx1NTFGQlx1NTE3M1x1OTVFRCBcdTIxOTIgXHU0RkE3XHU2ODBGXHU2RUQxXHU1MUZBKHggPCAwKSsgXHU5MDZFXHU3RjY5XHU2RDg4XHU1OTMxXHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHNjPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyLXNjcmltJyk7IGlmKHNjKSBzYy5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IGNsb3NlZCA9IGF3YWl0IHdhaXRGb3IoJ2RyYXdlciBjbG9zZWQgYnkgc2NyaW0nLCBgdmFyIHNiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyJyksIHNjPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyLXNjcmltJyk7XHJcbiAgICAgICAgdmFyIHI9c2I/c2IuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk6bnVsbDtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXIgJiYgci54IDwgMCAmJiAhc2MsIGRldGFpbDogJ3g9Jysocj9NYXRoLnJvdW5kKHIueCk6J25vbmUnKSsnIHNjcmltPScrKHNjPyd5ZXMnOidubycpfTtgLCA1XzAwMCk7XHJcbiAgICAgIC8vIEVzYyBcdTRFNUZcdTgwRkRcdTVGMDAvXHU1MTczXHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudG9wYmFyIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiAoeC5nZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnKXx8JycpLmluZGV4T2YoJ1x1NjJCRFx1NUM0OScpPj0wO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgYXdhaXQgd2FpdEZvcignZHJhd2VyIHJlb3BlbicsIGB2YXIgc2I9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXInKTsgdmFyIHI9c2I/c2IuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk6bnVsbDtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXIgJiYgci54ID49IDAgJiYgci54IDwgNDAsIGRldGFpbDogJ3g9Jysocj9NYXRoLnJvdW5kKHIueCk6J25vbmUnKX07YCwgNV8wMDApO1xyXG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidFc2NhcGUnLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgY29uc3QgZXNjQ2xvc2VkID0gYXdhaXQgd2FpdEZvcignZHJhd2VyIGNsb3NlZCBieSBFc2MnLCBgdmFyIHNiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyJyk7IHZhciByPXNiP3NiLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOm51bGw7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFyICYmIHIueCA8IDAsIGRldGFpbDogJ3g9Jysocj9NYXRoLnJvdW5kKHIueCk6J25vbmUnKX07YCwgNV8wMDApO1xyXG4gICAgICAvLyBcdTYwNjJcdTU5MERcdTVCQkRcdTdBOTc6XHU0RkE3XHU2ODBGXHU1NkRFXHU1MjMwIGdyaWQgXHU1MjE3KGRpc3BsYXkgXHU5NzVFIG5vbmUsXHU2QjYzXHU1RTM4XHU1MjE3XHU1RTAzXHU1QzQwKVxyXG4gICAgICB0cnkgeyB3aW4uc2V0Qm91bmRzKHsgd2lkdGg6IDEyODAsIGhlaWdodDogODAwIH0pOyB9IGNhdGNoIHsgLyogYmVzdCBlZmZvcnQgKi8gfVxyXG4gICAgICBhd2FpdCBzbGVlcCg0MDApO1xyXG4gICAgICBjb25zdCB3aWRlID0gYXdhaXQgd2FpdEZvcignd2lkZSByZXN0b3JlZCcsIGB2YXIgc2I9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXInKTsgdmFyIHI9c2I/c2IuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk6bnVsbDtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXIgJiYgci53aWR0aCA+IDIwMCAmJiBnZXRDb21wdXRlZFN0eWxlKHNiKS5kaXNwbGF5ICE9PSAnbm9uZScsIGRldGFpbDogJ3c9Jysocj9NYXRoLnJvdW5kKHIud2lkdGgpOidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgICAgcmV0dXJuIFtvcGVuZWRbMF0gJiYgY2xvc2VkWzBdICYmIGVzY0Nsb3NlZFswXSAmJiB3aWRlWzBdLCBgb3BlbjogJHtvcGVuZWRbMV19OyBzY3JpbS1jbG9zZTogJHtjbG9zZWRbMV19OyBlc2MtY2xvc2U6ICR7ZXNjQ2xvc2VkWzFdfTsgd2lkZTogJHt3aWRlWzFdfWBdO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdcdTY4MDdcdTk4OThcdTY4MEY6NDRweCArIGRyYWcgXHU1MzNBKFx1ODNEQ1x1NTM1NSBuby1kcmFnO292ZXJsYXkgXHU5QUQ4XHU1RUE2XHU0RTAwXHU4MUY0KScsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgciA9IChhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XHJcbiAgICAgICAgdmFyIHRiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy50aXRsZWJhcicpLCBtYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudGl0bGViYXItbWVudScpO1xyXG4gICAgICAgIGlmKCF0YiB8fCAhbWIpIHJldHVybiBKU09OLnN0cmluZ2lmeSh7b2s6ZmFsc2UsIGRldGFpbDonbWlzc2luZyB0aXRsZWJhci9tZW51J30pO1xyXG4gICAgICAgIHZhciBjcz1nZXRDb21wdXRlZFN0eWxlKHRiKSwgbXM9Z2V0Q29tcHV0ZWRTdHlsZShtYik7XHJcbiAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHsgb2s6IGNzLmhlaWdodCA9PT0gJzQ0cHgnICYmIGNzLndlYmtpdEFwcFJlZ2lvbiA9PT0gJ2RyYWcnICYmIG1zLndlYmtpdEFwcFJlZ2lvbiA9PT0gJ25vLWRyYWcnICYmIG1iLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpLmhlaWdodCA+PSAzNixcclxuICAgICAgICAgIGRldGFpbDogJ2g9Jytjcy5oZWlnaHQrJyByZWdpb249Jytjcy53ZWJraXRBcHBSZWdpb24rJyBtZW51LXJlZ2lvbj0nK21zLndlYmtpdEFwcFJlZ2lvbisnIG1lbnUtaD0nK01hdGgucm91bmQobWIuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCkuaGVpZ2h0KSB9KTtcclxuICAgICAgfSkoKWApKSBhcyBzdHJpbmc7XHJcbiAgICAgIGNvbnN0IHAgPSBKU09OLnBhcnNlKHIpIGFzIHsgb2s6IGJvb2xlYW47IGRldGFpbDogc3RyaW5nIH07XHJcbiAgICAgIC8vIFx1NEUzQlx1OEZEQlx1N0EwQlx1NEZBNzpcdTUzOUZcdTc1MUYgdGl0bGVCYXJPdmVybGF5IFx1OUFEOFx1NUVBNlx1OTg3Qlx1NTQwQ1x1NEUzQSA0NChXaW5kb3dzIFx1NjI0RFx1NjcwOSBvdmVybGF5O1x1NjVFN1x1N0M3Qlx1NTc4Qlx1N0YzQVx1NkI2NCBBUEksXHU1M0VGXHU5MDA5XHU4QzAzXHU3NTI4KVxyXG4gICAgICBsZXQgb3ZlcmxheSA9ICduL2EnO1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHByb2JlID0gd2luIGFzIHVua25vd24gYXMgeyBnZXRUaXRsZUJhck92ZXJsYXk/OiAoKSA9PiB7IGhlaWdodD86IG51bWJlciB9IHwgbnVsbCB9O1xyXG4gICAgICAgIGNvbnN0IG8gPSBwcm9iZS5nZXRUaXRsZUJhck92ZXJsYXk/LigpID8/IG51bGw7XHJcbiAgICAgICAgb3ZlcmxheSA9IG8gIT09IG51bGwgPyBTdHJpbmcoby5oZWlnaHQpIDogJ24vYSc7XHJcbiAgICAgIH0gY2F0Y2ggeyAvKiBcdTVFNzNcdTUzRjBcdTY1RTAgb3ZlcmxheSAqLyB9XHJcbiAgICAgIHJldHVybiBbcC5vayA9PT0gdHJ1ZSwgYCR7cC5kZXRhaWx9IG92ZXJsYXktaD0ke292ZXJsYXl9YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICBhd2FpdCBzaG90KCdmaW5hbCcpO1xyXG4gIH0gZWxzZSBpZiAoKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX1dJWkFSRCA/PyAnJykgIT09ICcnKSB7XHJcbiAgICAvKiA9PT09PT09PT09IHJlYWwoXHU1NDExXHU1QkZDXHU2Nzg0XHU5MDIwLFx1NEU5Mlx1NjVBNVx1NEU4RVx1NUUzOFx1ODlDNCByZWFsIFx1NkI2NVx1OUFBNCk6XHJcbiAgICAgICBXWjIgXHU2NzJDXHU2NzNBXHU3NzFGXHU1QjlFXHU2OEMwXHU2RDRCKFx1OUVEOFx1OEJBNFx1NTE3MVx1NEVBQlx1OTg3NSkvIFdaMyBcdTRFMEJcdThGN0RcdTVCODlcdTg4QzVcdTVCOUVcdTZENEIgPT09PT09PT09PSAqL1xyXG4gICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX1dJWkFSRCA9PT0gJ2RldGVjdCcpIHtcclxuICAgICAgYXdhaXQgc3RlcCgnXHU1NDExXHU1QkZDKFx1NzcxRlx1NUI5RSk6XHU2QjIyXHU4RkNFXHUyMTkyXHU2OEMwXHU2RDRCXHU1MjMwXHU2NzJDXHU2NzNBXHU1REYyXHU4OEM1IENMSShcdTlFRDhcdThCQTRcdTUxNzFcdTRFQUIsXHU1MkZFXHU5MDA5XHU2QjYzXHU3ODZFKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignd2l6YXJkIG92ZXJsYXknLCBgdmFyIG89ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1vdmVybGF5Jyk7XHJcbiAgICAgICAgICB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1RjAwXHU1OUNCXHU5MTREXHU3RjZFJzt9KTtcclxuICAgICAgICAgIHJldHVybiB7b2s6ICEhbyAmJiAhIWIsIGRldGFpbDogbyA/ICdvdmVybGF5K1x1NUYwMFx1NTlDQlx1OTE0RFx1N0Y2RScgOiAnbm8gb3ZlcmxheSd9O2AsIDEyXzAwMCk7XHJcbiAgICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgICBhd2FpdCBzaG90KCd3aXphcmQtcmVhbC13ZWxjb21lJyk7XHJcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1RjAwXHU1OUNCXHU5MTREXHU3RjZFJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgY29uc3QgZm91bmQgPSBhd2FpdCB3YWl0Rm9yKCdkZXRlY3QgZm91bmQnLCBgdmFyIHA9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLWRldGVjdCcpO1xyXG4gICAgICAgICAgaWYoIXApIHJldHVybiB7b2s6ZmFsc2UsIGRldGFpbDonZGV0ZWN0IHBhZ2Ugbm90IHNob3duJ307XHJcbiAgICAgICAgICB2YXIgdD1wLnRleHRDb250ZW50O1xyXG4gICAgICAgICAgdmFyIG9rMT10LmluZGV4T2YoJ1x1NjhDMFx1NkQ0Qlx1NTIzMFx1NURGMlx1NUI4OVx1ODhDNSBobWhhcm5lc3MgdicpPj0wO1xyXG4gICAgICAgICAgdmFyIG9rMj10LmluZGV4T2YoJ1x1OUVEOFx1OEJBNFx1NTE3MVx1NEVBQlx1NEY3Rlx1NzUyOFx1NUI4MyhcdTYzQThcdTgzNTApJyk+PTA7XHJcbiAgICAgICAgICB2YXIgcmFkaW89cC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW9wdC5vbicpO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogb2sxJiZvazImJiEhcmFkaW8sIGRldGFpbDogdC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsOTApfTtgLCAyMF8wMDApO1xyXG4gICAgICAgIGF3YWl0IHNob3QoJ3dpemFyZC1yZWFsLWRldGVjdCcpO1xyXG4gICAgICAgIHJldHVybiBmb3VuZDtcclxuICAgICAgfSk7XHJcbiAgICB9IGVsc2UgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX1dJWkFSRCA9PT0gJ2luc3RhbGwnKSB7XHJcbiAgICAgIGF3YWl0IHN0ZXAoJ1x1NTQxMVx1NUJGQyhcdTc3MUZcdTVCOUUpOlx1NjhDMFx1NkQ0Qlx1MjE5Mlx1NEVDRFx1ODk4MVx1NEUwQlx1OEY3RFx1NjVCMFx1NzI0OFx1MjE5Mlx1OTAwOVx1NjJFOVx1MjQ2MFx1MjE5Mlx1OEZEQlx1NTE2NVx1NUI4OVx1ODhDNVx1OTg3NScsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignd2l6YXJkIG92ZXJsYXknLCBgdmFyIG89ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1vdmVybGF5Jyk7XHJcbiAgICAgICAgICByZXR1cm4ge29rOiAhIW8sIGRldGFpbDogbyA/ICdvcGVuJyA6ICdjbG9zZWQnfTtgLCAxMl8wMDApO1xyXG4gICAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1RjAwXHU1OUNCXHU5MTREXHU3RjZFJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgY29uc3QgZm91bmQgPSBhd2FpdCB3YWl0Rm9yKCdkZXRlY3QgZm91bmQnLCBgdmFyIHA9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLWRldGVjdCcpO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogISFwICYmIHAudGV4dENvbnRlbnQuaW5kZXhPZignXHU2OEMwXHU2RDRCXHU1MjMwXHU1REYyXHU1Qjg5XHU4OEM1IGhtaGFybmVzcyB2Jyk+PTAsIGRldGFpbDogcCA/IHAudGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDYwKSA6ICdubyBkZXRlY3QgcGFnZSd9O2AsIDIwXzAwMCk7XHJcbiAgICAgICAgaWYgKCFmb3VuZFswXSkgcmV0dXJuIGZvdW5kO1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIG89W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW9wdCcpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1NEVDRFx1ODk4MVx1NEUwQlx1OEY3RFx1NjVCMFx1NzI0OCcpPj0wO30pOyBpZihvKSBvLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICBhd2FpdCBzbGVlcCgyMDApO1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NEUwQlx1NEUwMFx1NkI2NSc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgIGNvbnN0IHNlbCA9IGF3YWl0IHdhaXRGb3IoJ3NlbGVjdCBwYWdlIFx1MjQ2MCBvbicsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2Utc2VsZWN0Jyk7XHJcbiAgICAgICAgICB2YXIgb249cD9wLnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3B0Lm9uJyk6bnVsbDtcclxuICAgICAgICAgIHJldHVybiB7b2s6ICEhcCAmJiAhIW9uICYmIG9uLnRleHRDb250ZW50LmluZGV4T2YoJ1x1NEUwQlx1OEY3RFx1NUI4OVx1ODhDNVx1NUI4Q1x1NjU3NCBobWggQ0xJJyk+PTAsIGRldGFpbDogcCA/ICdzZWxlY3QgXHUyNDYwIG9uJyA6ICdubyBzZWxlY3QnfTtgLCA4XzAwMCk7XHJcbiAgICAgICAgaWYgKCFzZWxbMF0pIHJldHVybiBzZWw7XHJcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1RjAwXHU1OUNCXHU1Qjg5XHU4OEM1Jzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgcmV0dXJuIHdhaXRGb3IoJ2luc3RhbGwgcGFnZScsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtaW5zdGFsbCcpO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogISFwLCBkZXRhaWw6IHAgPyAnaW5zdGFsbGluZycgOiAnbm90IHNob3duJ307YCwgOF8wMDApO1xyXG4gICAgICB9KTtcclxuICAgICAgYXdhaXQgc3RlcCgnXHU1NDExXHU1QkZDKFx1NzcxRlx1NUI5RSk6XHU1Qjg5XHU4OEM1XHU4RkRCXHU1RUE2XHU1M0VGXHU4OUMxKFx1NkI2NVx1OUFBNFx1NjU4N1x1Njg0OC9cdTRFMEJcdThGN0RcdTc2N0VcdTUyMDZcdTZCRDRcdTZFREFcdTUyQTgpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdwcm9ncmVzcyB2aXNpYmxlJywgYHZhciBiYXI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1wcm9ncmVzcycpO1xyXG4gICAgICAgICAgdmFyIGxvZz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWluc3RhbGwtbG9nJyk7XHJcbiAgICAgICAgICB2YXIgbGluZXM9bG9nP2xvZy50ZXh0Q29udGVudC5zcGxpdCgnXFxcXG4nKS5maWx0ZXIoZnVuY3Rpb24oeCl7cmV0dXJuIHgudHJpbSgpIT09Jyc7fSk6W107XHJcbiAgICAgICAgICByZXR1cm4ge29rOiAhIWJhciAmJiBsaW5lcy5sZW5ndGg+PTEsIGRldGFpbDogJ2Jhcj0nKyhiYXI/J3knOiduJykrJyBsaW5lcz0nK2xpbmVzLmxlbmd0aCsobGluZXMubGVuZ3RoPjA/KCcgbGFzdD0nKyhsaW5lc1tsaW5lcy5sZW5ndGgtMV18fCcnKS5zbGljZSgwLDUwKSk6JycpfTtgLCA2MF8wMDApO1xyXG4gICAgICAgIGF3YWl0IHNob3QoJ3dpemFyZC1yZWFsLWluc3RhbGwnKTtcclxuICAgICAgICByZXR1cm4gdztcclxuICAgICAgfSk7XHJcbiAgICAgIGF3YWl0IHN0ZXAoJ1x1NTQxMVx1NUJGQyhcdTc3MUZcdTVCOUUpOlx1NUI4OVx1ODhDNVx1NUI4Q1x1NjIxMFx1MjE5Mlx1OTE0RFx1N0Y2RVx1OERGM1x1OEZDNyhcdTVERjJcdTY3MDlcdTVCQzZcdTk0QTUpXHUyMTkyXHU1QjhDXHU2MjEwXHU5ODc1XHUyMTkyXHU1RjAwXHU1OUNCXHU0RjdGXHU3NTI4XHUyMTkyXHU2NUIwIHJ1bnRpbWUgXHU4RkRFXHU2M0E1JywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIC8vIFx1NUI4OVx1ODhDNVx1NTE2OFx1N0EwQihucG0gXHU4OUUzXHU2NzkwK1x1NEUwQlx1OEY3RCtcdTg0M0RcdTc2RDg7XHU5NTVDXHU1MENGIG5wbW1pcnJvciBcdTkwMUFcdTVFMzggPDIgXHU1MjA2XHU5NDlGKSxcdTRFMEFcdTk2NTAgOCBcdTUyMDZcdTk0OUZcclxuICAgICAgICBhd2FpdCB3YWl0Rm9yKCdkb25lIHBhZ2UnLCBgdmFyIGQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLWRvbmUnKTtcclxuICAgICAgICAgIGlmKGQpIHJldHVybiB7b2s6dHJ1ZSwgZGV0YWlsOidkb25lJ307XHJcbiAgICAgICAgICB2YXIgYz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtY29uZmlnJyk7XHJcbiAgICAgICAgICBpZihjKXsgdmFyIHM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU4REYzXHU4RkM3Jyk+PTA7fSk7IGlmKHMpIHMuY2xpY2soKTsgfVxyXG4gICAgICAgICAgdmFyIGVycj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWVycm9yJyk7XHJcbiAgICAgICAgICBpZihlcnIpIHJldHVybiB7b2s6ZmFsc2UsIGRldGFpbDonaW5zdGFsbCBlcnJvcjogJytlcnIudGV4dENvbnRlbnQuc2xpY2UoMCw4MCl9O1xyXG4gICAgICAgICAgcmV0dXJuIHtvazpmYWxzZSwgZGV0YWlsOidpbnN0YWxsaW5nXHUyMDI2J307YCwgOCAqIDYwXzAwMCk7XHJcbiAgICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2RvbmUgcmVhZHkgdGV4dCcsIGB2YXIgZD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtZG9uZScpO1xyXG4gICAgICAgICAgdmFyIHQ9ZD9kLnRleHRDb250ZW50OicnO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogISFkICYmIHQuaW5kZXhPZignXHU1QzMxXHU3RUVBJyk+PTAsIGRldGFpbDogdC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNjApfTtgLCAxMF8wMDApO1xyXG4gICAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgICAgYXdhaXQgc2hvdCgnd2l6YXJkLXJlYWwtZG9uZScpO1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NUYwMFx1NTlDQlx1NEY3Rlx1NzUyOCc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgIGNvbnN0IGNvbm5lY3RlZCA9IGF3YWl0IHdhaXRGb3IoJ25ldyBydW50aW1lIGNvbm5lY3RlZCcsIGB2YXIgZG90PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ob3N0LWRvdC5vbicpO1xyXG4gICAgICAgICAgdmFyIGw9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmhvc3QtbGFiZWwnKTtcclxuICAgICAgICAgIHJldHVybiB7b2s6ICEhZG90ICYmICEhbCAmJiBsLnRleHRDb250ZW50LmluZGV4T2YoJ3J1bnRpbWUnKT49MCwgZGV0YWlsOiAnZG90PScrKGRvdD8nb24nOidvZmYnKSsnIGxhYmVsPScrKGw/bC50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNTApOidub25lJyl9O2AsIDYwXzAwMCk7XHJcbiAgICAgICAgY29uc3Qgc3QgPSAoYXdhaXQganMoYHdpbmRvdy5obWguZ2V0U3RhdGUoKS50aGVuKGZ1bmN0aW9uKHIpe3JldHVybiBKU09OLnN0cmluZ2lmeSh7bW9kZTpyLm1vZGUsIHJ1bnRpbWVFbnRyeTpyLnJ1bnRpbWVFbnRyeX0pO30pYCkpIGFzIHN0cmluZztcclxuICAgICAgICBjb25zdCBwID0gSlNPTi5wYXJzZShzdCkgYXMgeyBtb2RlPzogc3RyaW5nOyBydW50aW1lRW50cnk/OiBzdHJpbmcgfCBudWxsIH07XHJcbiAgICAgICAgY29uc3QgZW50cnlPayA9IChwLnJ1bnRpbWVFbnRyeSA/PyAnJykuaW5kZXhPZignLmhtaGFybmVzcy1nbG9iYWwnKSA+PSAwO1xyXG4gICAgICAgIGF3YWl0IHNob3QoJ3dpemFyZC1yZWFsLWZpbmFsJyk7XHJcbiAgICAgICAgcmV0dXJuIFtjb25uZWN0ZWRbMF0gJiYgZW50cnlPaywgYGNvbm5lY3RlZDogJHtjb25uZWN0ZWRbMV19OyBzdGF0ZT0ke3N0LnNsaWNlKDAsIDkwKX1gXTtcclxuICAgICAgfSk7XHJcbiAgICB9XHJcbiAgICBhd2FpdCBzaG90KCdmaW5hbCcpO1xyXG4gIH0gZWxzZSB7XHJcbiAgICAvKiA9PT09PT09PT09IHJlYWw6XHU1M0VBXHU4QkZCXHU1QjUwXHU5NkM2KFx1NEUwRFx1NTJBOFx1NzcxRlx1NUI5RVx1NEYxQVx1OEJERCkgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU5ODc2XHU2ODBGOnJ1bnRpbWUgXHU3MjQ4XHU2NzJDXHU0RTBFXHU3QUVGXHU1M0UzXHU1REYyXHU2NjNFXHU3OTNBKFx1OTc1RSA/KScsIGFzeW5jICgpID0+IHtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2hvc3QgbGFiZWwnLCBgdmFyIGw9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmhvc3QtbGFiZWwnKTtcclxuICAgICAgICB2YXIgdCA9IGwgPyBsLnRleHRDb250ZW50IDogJyc7XHJcbiAgICAgICAgcmV0dXJuIHtvazogdC5pbmRleE9mKCc/JykgPCAwICYmIHQuaW5kZXhPZigncnVudGltZScpID49IDAsIGRldGFpbDogdC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNjApfTtgLCAxNV8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdcdTRGMUFcdThCRERcdTUyMTdcdTg4Njg6XHU3NzFGXHU1QjlFXHU1Mzg2XHU1M0YyXHU1MkEwXHU4RjdEKFx1NjU3MFx1OTFDRj4wKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ3Nlc3Npb25zJywgYHZhciBuPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGg7XHJcbiAgICAgICAgcmV0dXJuIHtvazogbiA+IDAsIGRldGFpbDogJ3Nlc3Npb25zPScrbn07YCwgMTVfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnXHU3MEI5XHU1MUZCXHU1Mzg2XHU1M0YyXHU0RjFBXHU4QkREIFx1MjE5MiBcdTc3MUZcdTVCOUUgdHJhbnNjcmlwdCBcdTUxODVcdTVCQjlcdTUzRUZcdTg5QzEnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IG4gPSAoYXdhaXQganMoYGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGhgKSkgYXMgbnVtYmVyO1xyXG4gICAgICBpZiAobiA9PT0gMCkgcmV0dXJuIFtmYWxzZSwgJ25vIHNlc3Npb25zIHRvIGNsaWNrJ107XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGl0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zZXNzaW9uLWl0ZW0nKTsgaWYgKGl0KSBpdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdoaXN0b3J5IHR1cm5zJywgYHZhciB0cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50dXJuJykpO1xyXG4gICAgICAgIHJldHVybiB7b2s6IHRzLmxlbmd0aCA+PSAxLCBkZXRhaWw6ICd0dXJucz0nK3RzLmxlbmd0aCsnIGZpcnN0PScrKHRzWzBdP3RzWzBdLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw0MCk6J25vbmUnKX07YCwgMTVfMDAwKTtcclxuICAgICAgYXdhaXQgc2hvdCgncmVhbC1oaXN0b3J5Jyk7XHJcbiAgICAgIHJldHVybiB3O1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdEb2NrOk92ZXJ2aWV3IFx1NzcxRlx1NUI5RVx1NjU3MFx1NjM2RShydW50aW1lIFx1NzI0OFx1NjcyQ1x1OTc1RVx1NjVFMFx1NjU3MFx1NjM2RSknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdPdmVydmlldyc7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignb3ZlcnZpZXcnLCBgdmFyIHJvd3M9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay1yb3cnKSk7XHJcbiAgICAgICAgdmFyIHZlciA9IHJvd3MuZmluZChmdW5jdGlvbihyKXsgcmV0dXJuIHIudGV4dENvbnRlbnQuaW5kZXhPZigncnVudGltZSBcdTcyNDhcdTY3MkMnKT49MDsgfSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISF2ZXIgJiYgdmVyLnRleHRDb250ZW50LmluZGV4T2YoJ1x1NjVFMFx1NjU3MFx1NjM2RScpIDwgMCwgZGV0YWlsOiB2ZXIgPyB2ZXIudGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDUwKSA6ICdubyB2ZXIgcm93J307YCwgMTBfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnRG9jazpEaWZmIFx1NzcxRlx1NUI5RSBnaXQgXHU3MkI2XHU2MDAxKFx1OTc1RVx1NTJBMFx1OEY3RFx1NEUyRCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdcdTUzRDhcdTY2RjQnfHx4LnRleHRDb250ZW50PT09J0RpZmYnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2RpZmYnLCBgdmFyIHA9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmRpZmYtcGFuZScpO1xyXG4gICAgICAgIHZhciB0ID0gcCA/IHAudGV4dENvbnRlbnQgOiAnJztcclxuICAgICAgICByZXR1cm4ge29rOiAhIXAgJiYgdC5pbmRleE9mKCdcdTUyQTBcdThGN0RcdTRFMkQnKSA8IDAsIGRldGFpbDogdC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNjApfTtgLCAxNV8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdEb2NrOkV2aWRlbmNlIFx1NzcxRlx1NUI5RVx1OEJBNFx1NzdFNVx1NjU3MFx1NjM2RScsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J1x1OEJDMVx1NjM2RSd8fHgudGV4dENvbnRlbnQ9PT0nRXZpZGVuY2UnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2V2aWRlbmNlJywgYHZhciByb3dzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stcm93JykpO1xyXG4gICAgICAgIHZhciBtZW0gPSByb3dzLmZpbmQoZnVuY3Rpb24ocil7IHJldHVybiByLnRleHRDb250ZW50LmluZGV4T2YoJ1x1OEJCMFx1NUZDNlx1NUM0MicpPj0wIHx8IHIudGV4dENvbnRlbnQuaW5kZXhPZignTWVtb3J5IGxheWVycycpPj0wOyB9KTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIW1lbSAmJiBtZW0udGV4dENvbnRlbnQuaW5kZXhPZignXHUyMDI2JykgPCAwLCBkZXRhaWw6IG1lbSA/IG1lbS50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNTApIDogJ25vIHJvdyd9O2AsIDE1XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ1x1OTY0NFx1NEVGNlx1NEUwRVx1NzZFRVx1NUY1NVx1NTE2NVx1NTNFMzpcdUQ4M0RcdURDQ0UgXHU0RTBBXHU0RjIwICsgXHU5ODc2XHU2ODBGXHU0RTJEL0VOICsgXHVEODNEXHVEQ0MxIFx1NkQ0Rlx1ODlDOFx1NjMwOVx1OTRBRVx1NUI1OFx1NTcyOCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J1x1NjU4N1x1NEVGNid8fHgudGV4dENvbnRlbnQ9PT0nRmlsZXMnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgYXdhaXQgd2FpdEZvcignZmlsZXMgdGFiJywgYHZhciB0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5kb2NrLXRhYi5hY3RpdmUnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXQgJiYgKHQudGV4dENvbnRlbnQ9PT0nXHU2NTg3XHU0RUY2J3x8dC50ZXh0Q29udGVudD09PSdGaWxlcycpLCBkZXRhaWw6ICdhY3RpdmU9JysodD90LnRleHRDb250ZW50Oidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgICAgLy8gcmVhbCBcdTZBMjFcdTVGMEYgd29ya3NwYWNlcyBcdThCRjdcdTZDNDJcdThENzAgcnVudGltZShcdTUxQjdcdTU0MkZcdTUyQThcdTU0MEVcdTUzRUZcdTgwRkRcdTYzOTJcdTk2MUYpLFx1NjUzRVx1NUJCRFx1NTIzMCAxNXNcclxuICAgICAgY29uc3Qgd3MgPSBhd2FpdCB3YWl0Rm9yKCd3cyBwaWNrZXInLCBgdmFyIHc9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLXBpY2tlcicpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhdywgZGV0YWlsOiB3ID8gJ2xvYWRlZCcgOiAnd29ya3NwYWNlcyBub3QgbG9hZGVkIHlldCd9O2AsIG1vZGUgPT09ICdyZWFsJyA/IDE1XzAwMCA6IDZfMDAwKTtcclxuICAgICAgY29uc3QgciA9IChhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XHJcbiAgICAgICAgdmFyIHVwID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNvbXBvc2VyIGJ1dHRvblthcmlhLWxhYmVsKj1cIlx1NEUwQVx1NEYyMFwiXSwgLmNvbXBvc2VyIGJ1dHRvblthcmlhLWxhYmVsKj1cIlVwbG9hZFwiXScpO1xyXG4gICAgICAgIHZhciBsYW5nID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmxhbmctc2VnJyk7XHJcbiAgICAgICAgdmFyIGJyID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLXBpY2tlciBidXR0b24nKTtcclxuICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe3VwOiAhIXVwLCBsYW5nOiAhIWxhbmcsIGJyb3dzZTogISFicn0pO1xyXG4gICAgICB9KSgpYCkpIGFzIHN0cmluZztcclxuICAgICAgY29uc3QgcCA9IEpTT04ucGFyc2UocikgYXMgeyB1cDogYm9vbGVhbjsgbGFuZzogYm9vbGVhbjsgYnJvd3NlOiBib29sZWFuIH07XHJcbiAgICAgIHJldHVybiBbcC51cCAmJiBwLmxhbmcgJiYgcC5icm93c2UsIGBcdUQ4M0RcdURDQ0U9JHtwLnVwfSBcdTRFMkQvRU49JHtwLmxhbmd9IFx1RDgzRFx1RENDMT0ke3AuYnJvd3NlfTsgJHt3c1sxXX1gXTtcclxuICAgIH0pO1xyXG4gICAgLyogPT09PT09PT09PSByZWFsOlx1NzcxRlx1NUI5RVx1NEVGQlx1NTJBMVx1N0FFRlx1NTIzMFx1N0FFRlx1OTk5Nlx1OUE4QyhcdTUzRDFcdTc3RURcdTRFRkJcdTUyQTFcdTIxOTJcdTZBMjFcdTU3OEJcdTU2REVcdTU5MEQpID09PT09PT09PT1cclxuICAgICAgIFx1NzUyOFx1NjIzNyBnbG0tNS4zIFx1NURGMlx1OTE0RFx1N0Y2RTtcdTYzRDBcdTc5M0FcdThCQ0RcdTdFQTZcdTY3NUZcdTc2RjRcdTYzQTVcdTU2REVcdTU5MERcdTMwMDJcdTgyRTUgYWdlbnQgXHU4QkY3XHU2QzQyXHU1QkExXHU2Mjc5LFx1OEY2RVx1OEJFMlx1OTFDQ1xyXG4gICAgICAgXHU4MUVBXHU1MkE4XHU3MEI5XHU2Mjc5XHU1MUM2KFx1NjcwMFx1NTkxQVx1ODlDMVx1NTM2MVx1NTM3M1x1NzBCOSxcdTVFNDJcdTdCNDkpXHUzMDAyXHU4RDg1XHU2NUY2IDE1MHNcdTMwMDIgKi9cclxuICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9SRUFMX1RBU0sgPT09ICcxJykge1xyXG4gICAgICBhd2FpdCBzdGVwKCdcdTc3MUZcdTVCOUVcdTRFRkJcdTUyQTE6XHU1M0QxXHU5MDAxXHUyMTkyXHU2QTIxXHU1NzhCXHU1NkRFXHU1OTBEKFx1N0FFRlx1NTIzMFx1N0FFRlx1OTk5Nlx1OUE4QyknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleTonbicsIGN0cmxLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XHJcbiAgICAgICAgYXdhaXQgc2xlZXAoNDAwKTtcclxuICAgICAgICBhd2FpdCB0eXBlSW50bygnLmNvbXBvc2VyIHRleHRhcmVhJywgJ1x1OEJGN1x1NTNFQVx1NTZERVx1NTkwRFx1NEUyNFx1NEUyQVx1NUI1NzpcdTY1MzZcdTUyMzAoXHU2NzJDXHU2QjIxXHU5QThDXHU2NTM2XHU0RUZCXHU1MkExLFx1NEUwRFx1ODk4MVx1NEY3Rlx1NzUyOFx1NEVGQlx1NEY1NVx1NURFNVx1NTE3NyxcdTc2RjRcdTYzQTVcdTU2REVcdTU5MEQpJyk7XHJcbiAgICAgICAgYXdhaXQgc2xlZXAoMjAwKTtcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNvbXBvc2VyIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTUzRDFcdTkwMDEnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICBjb25zdCBzZW50ID0gYXdhaXQgd2FpdEZvcigndXNlciB0dXJuJywgYHZhciB0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy50dXJuLnVzZXInKTtcclxuICAgICAgICAgIHZhciBzID0gKHQgJiYgdC50ZXh0Q29udGVudCkgPyBTdHJpbmcodC50ZXh0Q29udGVudCkgOiAnJztcclxuICAgICAgICAgIHJldHVybiB7b2s6IHMuaW5kZXhPZignXHU2NTM2XHU1MjMwJyk+PTAgfHwgcy5pbmRleE9mKCdcdTlBOENcdTY1MzZcdTRFRkJcdTUyQTEnKT49MCwgZGV0YWlsOiBzLnNsaWNlKDAsMzApIHx8ICdub25lJ307YCwgMTBfMDAwKTtcclxuICAgICAgICBpZiAoIXNlbnRbMF0pIHJldHVybiBzZW50O1xyXG4gICAgICAgIGNvbnN0IHJlcGx5ID0gYXdhaXQgd2FpdEZvcignYXNzaXN0YW50IHJlcGx5JywgYFxyXG4gICAgICAgICAgdmFyIGFwID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmFwcHJvdmFsLWNhcmQgYnV0dG9uJyk7XHJcbiAgICAgICAgICBpZiAoYXAgJiYgYXAudGV4dENvbnRlbnQudHJpbSgpLmluZGV4T2YoJ1x1NjI3OVx1NTFDNicpPj0wKSBhcC5jbGljaygpO1xyXG4gICAgICAgICAgdmFyIHRzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnR1cm4nKSkuZmlsdGVyKGZ1bmN0aW9uKHgpeyByZXR1cm4geC5jbGFzc05hbWUuaW5kZXhPZigndXNlcicpPDAgJiYgeC5jbGFzc05hbWUuaW5kZXhPZignYXBwcm92YWwnKTwwICYmIHguY2xhc3NOYW1lLmluZGV4T2YoJ3N5c3RlbScpPDAgJiYgeC50ZXh0Q29udGVudC50cmltKCkubGVuZ3RoPjAgJiYgeC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTU2REVcdTU0MDgnKTwwOyB9KTtcclxuICAgICAgICAgIHZhciBzdW0gPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudHVybi1zdW0nKTtcclxuICAgICAgICAgIHJldHVybiB7b2s6IHRzLmxlbmd0aD49MSAmJiAhIXN1bSwgZGV0YWlsOiAnYXNzaXN0YW50PScrdHMubGVuZ3RoKycgc3VtPScrKHN1bT9zdW0udGV4dENvbnRlbnQ6J25vbmUnKSsnIGZpcnN0PScrKHRzWzBdP3RzWzBdLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw0MCk6J25vbmUnKX07XHJcbiAgICAgICAgYCwgMTUwXzAwMCk7XHJcbiAgICAgICAgYXdhaXQgc2hvdCgncmVhbC10YXNrJyk7XHJcbiAgICAgICAgcmV0dXJuIHJlcGx5O1xyXG4gICAgICB9KTtcclxuICAgIH1cclxuICAgIGF3YWl0IHN0ZXAoJ1x1NEYxQVx1OEJERFx1NTIwNlx1N0VDNDpcdTVERTZcdTY4MEZcdTYzMDlcdTVERTVcdTRGNUNcdTUzM0FcdTUyMDZcdTdFQzQoXHU3RUM0XHU1OTM0XHU1M0VGXHU4OUMxKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2dyb3VwIGhlYWQnLCBgdmFyIGg9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLWdyb3VwLWhlYWQnKTtcclxuICAgICAgICB2YXIgbiA9IGggPyAoaC5xdWVyeVNlbGVjdG9yKCcud3MtZ3JvdXAtbmFtZScpfHx7fSkudGV4dENvbnRlbnQgOiAnJztcclxuICAgICAgICByZXR1cm4ge29rOiAhIWggJiYgbi5sZW5ndGggPiAwLCBkZXRhaWw6ICduYW1lPScrbn07YCwgMTVfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnXHU1REU1XHU0RjVDXHU1MzNBOlx1NURFNlx1NjgwRlx1NURFNVx1NEY1Q1x1NTMzQVx1NjgwRlx1NTNFRlx1ODlDMShcdTc3MUZcdTVCOUVcdTVERTVcdTRGNUNcdTUzM0FcdTU0MEQpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignd29ya3NwYWNlIGJhcicsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud29ya3NwYWNlLWJhcicpO1xyXG4gICAgICAgIHZhciBuID0gYiA/IChiLnF1ZXJ5U2VsZWN0b3IoJy53cy1iYXItbmFtZScpfHx7fSkudGV4dENvbnRlbnQgOiAnJztcclxuICAgICAgICByZXR1cm4ge29rOiAhIWIgJiYgISFuICYmIG4ubGVuZ3RoID4gMCAmJiBuLmluZGV4T2YoJ1x1NTJBMFx1OEY3RCcpIDwgMCAmJiBuLmluZGV4T2YoJ0xvYWRpbmcnKSA8IDAsIGRldGFpbDogJ25hbWU9JytufTtgLCAxNV8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzaG90KCdmaW5hbCcpO1xyXG4gIH1cclxuXHJcbiAgY29uc3QgZmFpbGVkID0gcmVzdWx0cy5maWx0ZXIoKHIpID0+ICFyWzFdKS5sZW5ndGg7XHJcbiAgY29uc29sZS5sb2coYFVJVkVSSUZZIFNVTU1BUlkgcGFzcz0ke3Jlc3VsdHMubGVuZ3RoIC0gZmFpbGVkfS8ke3Jlc3VsdHMubGVuZ3RofSBtb2RlPSR7bW9kZX0gc2hvdHM9JHtzaG90c31gKTtcclxuICBhcHAuZXhpdChmYWlsZWQgPT09IDAgPyAwIDogMSk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBhdHRhY2hVaVZlcmlmeSh3aW46IEJyb3dzZXJXaW5kb3cpOiB2b2lkIHtcclxuICBjb25zdCBtb2RlID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfTU9ERSA9PT0gJ3JlYWwnID8gJ3JlYWwnIDogJ2Zha2UnO1xyXG4gIHdpbi53ZWJDb250ZW50cy5vbmNlKCdkaWQtZmluaXNoLWxvYWQnLCAoKSA9PiB7XHJcbiAgICAvLyBcdTdFRDkgaG9zdCBcdTU0MkZcdTUyQThcdTc1NTlcdTY1RjZcdTk1RjQ7XHU2QjY1XHU5QUE0XHU1MTg1XHU5MEU4XHU1NDA0XHU4MUVBXHU4RjZFXHU4QkUyXHU3QjQ5XHU1Rjg1XHJcbiAgICBzZXRUaW1lb3V0KCgpID0+IHsgdm9pZCBydW5VaVZlcmlmeSh3aW4sIG1vZGUpOyB9LCAzXzAwMCk7XHJcbiAgfSk7XHJcbn1cclxuIiwgIi8qKlxyXG4gKiBcdTg5QzZcdTg5QzlcdTU2REVcdTVGNTJcdTYyMkFcdTU2RkVcdTk0QTlcdTVCNTAgXHUyMDE0XHUyMDE0IFx1Nzg2RVx1NUI5QVx1NjAyN1x1ODlDNlx1NTNFM1x1NjIyQVx1NTZGRSxcdTRGOUIgc2NyaXB0cy92aXN1YWwtcmVncmVzc2lvbi5tanMgXHU1MDVBXHU1MENGXHU3RDIwIGRpZmZcdTMwMDJcclxuICpcclxuICogXHU0RTBFIHVpLXZlcmlmeSBcdTU0MENcdTY1Q0YoXHU5NkY2XHU3QjJDXHU0RTA5XHU2NUI5XHU0RjlEXHU4RDU2KSxcdTRGNDZcdTc2RUVcdTY4MDdcdTY2MkZcIlx1NTQwQ1x1NEUwMFx1OEY5M1x1NTE2NSBcdTIxOTIgXHU5MDEwXHU1QjU3XHU4MjgyXHU1M0VGXHU2QkQ0XHU3Njg0XHU1NkZFXCI6XHJcbiAqICAtIFx1N0E5N1x1NTNFM1x1NUY1Mlx1NEUwMCAxMjgwXHUwMEQ3ODAwO1x1NEUzQlx1OTg5OC9cdThCRURcdThBMDBcdTU2RkFcdTVCOUEobGlnaHQgKyBcdTVGNTNcdTUyNEQgbG9jYWxlIFx1OUVEOFx1OEJBNCxcdTUxOTkgbG9jYWxTdG9yYWdlIFx1NTQwRSByZWxvYWQpXHJcbiAqICAtIGZha2UgaG9zdChITUhfREVTS1RPUF9WSVNSRUc9MSBcdTY1RjYgbWFpbiBcdTVERjJcdTVGM0FcdTUyMzYgZmFrZSk6XHU3QTdBXHU0RjFBXHU4QkREL1x1NTZGQVx1NUI5QVx1NURFNVx1NEY1Q1x1NTMzQVx1NEUwRSBwcm92aWRlclxyXG4gKiAgLSBcdTRFMDlcdTg5QzZcdTUzRTM6bWFpbihcdTRGMUFcdThCRERcdTRFM0JcdTc1NENcdTk3NjJcdTdBN0FcdTYwMDEpLyBzZXR0aW5ncyhcdThCQkVcdTdGNkVcdTVGMzlcdTVDNDIpLyBkb2NrKEZpbGVzIFx1NkQ0Rlx1ODlDOClcclxuICogIC0gXHU1MkE4XHU2MDAxXHU1MzNBIG1hc2s6XHU1MkE4XHU2MDAxXHU3QUVGXHU1M0UzL1x1NjVGNlx1OTVGNFx1NjIzMy9cdThCQTFcdTY1NzBcdTdCNDlcdTUxNDNcdTdEMjBcdTYzMDkgYm91bmRpbmcgYm94IFx1OEJCMFx1NTE2NSBtZXRhLmpzb24sXHJcbiAqICAgIFx1NTBDRlx1N0QyMCBkaWZmIFx1NjVGNlx1OERGM1x1OEZDNyhcdTU3NTBcdTY4MDdcdTVERjJcdTYzMDkgY2FwdHVyZVBhZ2UgXHU1QjlFXHU5NjQ1XHU1QzNBXHU1QkY4IFx1MDBENyBkZXZpY2VQaXhlbFJhdGlvIFx1NjM2Mlx1N0I5NylcclxuICogIC0gSE1IX0RFU0tUT1BfVklTUkVHX01VVEFURT08dmlld3BvcnQ+Olx1NTcyOFx1OEJFNVx1ODlDNlx1NTNFM1x1NkNFOFx1NTE2NVx1NTZGQVx1NUI5QVx1ODI3Mlx1NTc1NyxcdTc1MjhcdTRFOEVcdTdCQTFcdTdFQkZcdTgxRUFcdTY4QzBcclxuICogICAgKGJhc2VsaW5lIFx1ODFFQVx1NkJENCAwIFx1NURFRVx1NUYwMiArIFx1NjU0NVx1NjEwRlx1NjUzOVx1NTJBOFx1NUZDNSBGQUlMLFx1OEJDMVx1NjYwRVx1OTYwOFx1NTAzQ1x1NEUwRSBkaWZmIFx1NTZGRVx1NzcxRlx1NUI5RVx1NURFNVx1NEY1QylcclxuICogZW52OkhNSF9ERVNLVE9QX1ZJU1JFRz0xKFx1NUYwMFx1NTE3MykvIEhNSF9ERVNLVE9QX1ZJU1JFR19PVVQ9PGRpcj4oXHU4RjkzXHU1MUZBXHU3NkVFXHU1RjU1KVxyXG4gKi9cclxuaW1wb3J0IHsgYXBwLCB0eXBlIEJyb3dzZXJXaW5kb3cgfSBmcm9tICdlbGVjdHJvbic7XHJcbmltcG9ydCB7IG1rZGlyLCB3cml0ZUZpbGUgfSBmcm9tICdub2RlOmZzL3Byb21pc2VzJztcclxuaW1wb3J0IHsgam9pbiB9IGZyb20gJ25vZGU6cGF0aCc7XHJcblxyXG5jb25zdCBzbGVlcCA9IChtczogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiA9PiBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCBtcykpO1xyXG5cclxuLyoqIFx1NTJBOFx1NjAwMVx1NTMzQVx1NTdERihcdTZCQ0ZcdTZCMjFcdThGRDBcdTg4NENcdTVGQzVcdTUzRDhcdTc2ODRcdTUxODVcdTVCQjkpXHUyMTkyIG1hc2sgXHU5MDA5XHU2MkU5XHU1NjY4O1x1OTc1OVx1NjAwMVx1N0VEM1x1Njc4NFx1NEUwRCBtYXNrLGRpZmYgXHU2MjREXHU2NzA5XHU2MTBGXHU0RTQ5ICovXHJcbmNvbnN0IE1BU0tfU0VMRUNUT1JTOiBBcnJheTx7IHNlbDogc3RyaW5nOyByZWFzb246IHN0cmluZyB9PiA9IFtcclxuICB7IHNlbDogJy5ob3N0LWxhYmVsJywgcmVhc29uOiAnaG9zdCBcdTdBRUZcdTUzRTMvXHU3MjQ4XHU2NzJDKGZha2UgaG9zdCBcdTZCQ0ZcdTZCMjFcdTk2OEZcdTY3M0FcdTdBRUZcdTUzRTMpJyB9LFxyXG4gIHsgc2VsOiAnLnNlc3Npb24tdGltZScsIHJlYXNvbjogJ1x1NEYxQVx1OEJERFx1NjVGNlx1OTVGNFx1NjIzMycgfSxcclxuICB7IHNlbDogJy50dXJuLXN1bScsIHJlYXNvbjogJ1x1NTZERVx1NTQwOC90b2tlbiBcdThCQTFcdTY1NzAnIH0sXHJcbl07XHJcblxyXG4vKiogXHU1NkZBXHU1QjlBXHU4OUM2XHU1M0UzOlx1ODk4Nlx1NzZENlx1NEUwOVx1NjgwRlx1NUUwM1x1NUM0MFx1NEUwRVx1NUU5NVx1OTBFOCBkb2NrIFx1NzY4NFx1NTIwNlx1NjUyRixcdTU0MENcdTY1RjZcdThGRENcdTc5QkIgODIwLzExMDAgXHU2NUFEXHU3MEI5ICovXHJcbmNvbnN0IFZJRVdQT1JUX1cgPSAxMjgwO1xyXG5jb25zdCBWSUVXUE9SVF9IID0gODAwO1xyXG5cclxuYXN5bmMgZnVuY3Rpb24gcnVuVmlzdWFsUmVncmVzc2lvbih3aW46IEJyb3dzZXJXaW5kb3cpOiBQcm9taXNlPHZvaWQ+IHtcclxuICBjb25zdCBvdXQgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9WSVNSRUdfT1VUID8/IGpvaW4oYXBwLmdldFBhdGgoJ3RlbXAnKSwgJ2htaC12aXNyZWcnKTtcclxuICBjb25zdCBtdXRhdGUgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9WSVNSRUdfTVVUQVRFID8/ICcnO1xyXG4gIGF3YWl0IG1rZGlyKG91dCwgeyByZWN1cnNpdmU6IHRydWUgfSkuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcclxuICBjb25zdCBqcyA9IDxUPihjb2RlOiBzdHJpbmcpOiBQcm9taXNlPFQ+ID0+IHdpbi53ZWJDb250ZW50cy5leGVjdXRlSmF2YVNjcmlwdChjb2RlLCB0cnVlKSBhcyBQcm9taXNlPFQ+O1xyXG4gIGNvbnN0IHdhaXRGb3IgPSBhc3luYyAobGFiZWw6IHN0cmluZywgcHJlZGljYXRlQ29kZTogc3RyaW5nLCB0aW1lb3V0TXM6IG51bWJlcik6IFByb21pc2U8dm9pZD4gPT4ge1xyXG4gICAgY29uc3Qgc3RhcnRlZCA9IERhdGUubm93KCk7XHJcbiAgICBmb3IgKDs7KSB7XHJcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoYChmdW5jdGlvbigpeyB0cnkgeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkoKGZ1bmN0aW9uKCl7ICR7cHJlZGljYXRlQ29kZX0gfSkoKSk7IH0gY2F0Y2goZSl7IHJldHVybiBKU09OLnN0cmluZ2lmeSh7b2s6ZmFsc2UsIGRldGFpbDpTdHJpbmcoZSkuc2xpY2UoMCwxMjApfSk7IH0gfSkoKWApKSBhcyBzdHJpbmc7XHJcbiAgICAgIGxldCBwYXJzZWQ6IHsgb2s/OiBib29sZWFuIH07XHJcbiAgICAgIHRyeSB7IHBhcnNlZCA9IEpTT04ucGFyc2UocikgYXMgeyBvaz86IGJvb2xlYW4gfTsgfSBjYXRjaCB7IHBhcnNlZCA9IHt9OyB9XHJcbiAgICAgIGlmIChwYXJzZWQub2sgPT09IHRydWUpIHJldHVybjtcclxuICAgICAgaWYgKERhdGUubm93KCkgLSBzdGFydGVkID4gdGltZW91dE1zKSB7XHJcbiAgICAgICAgY29uc29sZS5sb2coYFZJU1JFRy1DQVBUVVJFIEZBSUwgfCB3YWl0ICR7bGFiZWx9IHRpbWVvdXRgKTtcclxuICAgICAgICBhcHAuZXhpdCgxKTtcclxuICAgICAgICByZXR1cm47XHJcbiAgICAgIH1cclxuICAgICAgYXdhaXQgc2xlZXAoMjUwKTtcclxuICAgIH1cclxuICB9O1xyXG5cclxuICAvLyAwKSBcdTdBOTdcdTUzRTNcdTVGNTJcdTRFMDA6XHU1QzNBXHU1QkY4XHU1NkZBXHU1QjlBKFx1NEY0RFx1N0Y2RVx1NEZERFx1NjMwMVx1NzUyOFx1NjIzN1x1Njg0Q1x1OTc2Mlx1NEUwQVx1NzY4NCk7XHU0RTNCXHU5ODk4XHU2RDQ1XHU4MjcyICsgXHU0RTJEXHU2NTg3LFx1NTE5OVx1NTA0Rlx1NTk3RFx1NTQwRSByZWxvYWQgXHU3NTFGXHU2NTQ4XHJcbiAgdHJ5IHsgd2luLnNldEJvdW5kcyh7IHdpZHRoOiBWSUVXUE9SVF9XLCBoZWlnaHQ6IFZJRVdQT1JUX0ggfSk7IH0gY2F0Y2ggeyAvKiBcdTY3MDBcdTVDMEZcdTVDM0FcdTVCRjhcdTUxNUNcdTVFOTUgKi8gfVxyXG4gIGF3YWl0IHNsZWVwKDQwMCk7XHJcbiAgYXdhaXQganMoYChmdW5jdGlvbigpeyB0cnkgeyBsb2NhbFN0b3JhZ2Uuc2V0SXRlbSgnaG1oLnRoZW1lJywgJ2xpZ2h0Jyk7IGxvY2FsU3RvcmFnZS5zZXRJdGVtKCdobWgubG9jYWxlJywgJ3poJyk7IH0gY2F0Y2ggKGUpIHt9IHJldHVybiAnb2snOyB9KSgpYCk7XHJcbiAgd2luLndlYkNvbnRlbnRzLnJlbG9hZCgpO1xyXG4gIGF3YWl0IHdhaXRGb3IoJ21vdW50ZWQnLCBgdmFyIHQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNvbXBvc2VyIHRleHRhcmVhJyk7IHJldHVybiB7b2s6ICEhdCwgZGV0YWlsOiB0ID8gJ3VwJyA6ICdkb3duJ307YCwgMjBfMDAwKTtcclxuICBhd2FpdCB3YWl0Rm9yKCdob3N0IGRvdCBvbicsIGB2YXIgZD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuaG9zdC1kb3QnKTsgcmV0dXJuIHtvazogISFkICYmIGQuY2xhc3NMaXN0LmNvbnRhaW5zKCdvbicpLCBkZXRhaWw6IGQgPyBkLmNsYXNzTmFtZSA6ICdub25lJ307YCwgMzBfMDAwKTtcclxuICBhd2FpdCBzbGVlcCgxXzIwMCk7IC8vIFx1NEYxQVx1OEJERFx1NTIxN1x1ODg2OC9cdTk4NzZcdTY4MEZcdTY1NzBcdTYzNkVcdTg0M0RcdTU3MzBcclxuXHJcbiAgLy8gMSkgXHU1MTczXHU2Mzg5IGZha2UgXHU2RjE0XHU3OTNBXHU1RjE1XHU1QkZDXHU1QzQyKFx1OTA2RVx1N0Y2OVx1NUYzOVx1NUM0Mlx1NEUwRFx1NUM1RVx1NEU4RVx1ODhBQlx1NkQ0Qlx1ODlDNlx1NTNFMztcdTRFMERcdTRGOURcdThENTZcdTY1ODdcdTY4NDgsXHU2MzA5XHU3RUQzXHU2Nzg0XHU1M0Q2IGdob3N0IFx1NjMwOVx1OTRBRSlcclxuICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBnPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ydW50aW1lLWd1aWRlJyk7IGlmKCFnKSByZXR1cm4gJ25vLWd1aWRlJztcclxuICAgIHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ydW50aW1lLWd1aWRlLWFjdGlvbnMgLmJ0bi5naG9zdCcpOyBpZihiKSBiLmNsaWNrKCk7IHJldHVybiAnZGlzbWlzc2VkJzsgfSkoKWApO1xyXG4gIGF3YWl0IHdhaXRGb3IoJ2d1aWRlIGNsb3NlZCcsIGByZXR1cm4ge29rOiAhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnJ1bnRpbWUtZ3VpZGUnKSwgZGV0YWlsOiAnY2xvc2VkJ307YCwgNV8wMDApO1xyXG5cclxuICAvLyAyKSBcdTg5QzZcdTUzRTNcdTVFOEZcdTUyMTc6bWFpbihcdTdBN0FcdTYwMDFcdTRFM0JcdTc1NENcdTk3NjIpXHUyMTkyIHNldHRpbmdzKFx1OEJCRVx1N0Y2RVx1NUYzOVx1NUM0MilcdTIxOTIgZG9jayhGaWxlcyBcdTZENEZcdTg5QzgpXHJcbiAgY29uc3Qgdmlld3BvcnRzOiBBcnJheTx7IG5hbWU6IHN0cmluZzsgc2V0dXA6ICgpID0+IFByb21pc2U8dm9pZD4gfT4gPSBbXHJcbiAgICB7IG5hbWU6ICdtYWluJywgc2V0dXA6IGFzeW5jICgpID0+IHsgLyogXHU1NDJGXHU1MkE4XHU5RUQ4XHU4QkE0XHU2MDAxOlx1N0E3QVx1NEYxQVx1OEJERCArIE92ZXJ2aWV3IGRvY2sgKi8gfSB9LFxyXG4gICAge1xyXG4gICAgICBuYW1lOiAnc2V0dGluZ3MnLFxyXG4gICAgICBzZXR1cDogYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7IGtleTogJ3AnLCBjdHJsS2V5OiB0cnVlLCBzaGlmdEtleTogdHJ1ZSwgYnViYmxlczogdHJ1ZSB9KSk7IH0pKClgKTtcclxuICAgICAgICBhd2FpdCB3YWl0Rm9yKCdzZXR0aW5ncyBvcGVuJywgYHJldHVybiB7b2s6ICEhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNtZGsuc2V0dGluZ3MnKSwgZGV0YWlsOiAnb3Blbid9O2AsIDVfMDAwKTtcclxuICAgICAgfSxcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIG5hbWU6ICdkb2NrJyxcclxuICAgICAgc2V0dXA6IGFzeW5jICgpID0+IHtcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywgeyBrZXk6ICdFc2NhcGUnLCBidWJibGVzOiB0cnVlIH0pKTsgfSkoKWApO1xyXG4gICAgICAgIGF3YWl0IHdhaXRGb3IoJ3NldHRpbmdzIGNsb3NlZCcsIGByZXR1cm4ge29rOiAhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNtZGsuc2V0dGluZ3MnKSwgZGV0YWlsOiAnY2xvc2VkJ307YCwgNV8wMDApO1xyXG4gICAgICAgIC8vIEZpbGVzIHRhYjpcdTYzMDkgZG9jay10YWIgXHU5ODdBXHU1RThGXHU3QjJDIDIgXHU0RTJBKE92ZXJ2aWV3L0ZpbGVzL1x1MjAyNiksXHU5MDdGXHU1MTREXHU0RjlEXHU4RDU2XHU2NTg3XHU2ODQ4XHJcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKVsxXTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgYXdhaXQgd2FpdEZvcignZmlsZXMgcm93cycsIGB2YXIgcj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZnMtcm93Jyk7IHJldHVybiB7b2s6IHIubGVuZ3RoID49IDEsIGRldGFpbDogJ3Jvd3M9JyArIHIubGVuZ3RofTtgLCA1XzAwMCk7XHJcbiAgICAgIH0sXHJcbiAgICB9LFxyXG4gIF07XHJcblxyXG4gIGNvbnN0IG1ldGE6IHsgZ2VuZXJhdGVkQXQ6IHN0cmluZzsgd2luZG93OiB7IHdpZHRoOiBudW1iZXI7IGhlaWdodDogbnVtYmVyIH07IG11dGF0ZTogc3RyaW5nOyB2aWV3cG9ydHM6IEFycmF5PHsgbmFtZTogc3RyaW5nOyBmaWxlOiBzdHJpbmc7IHdpZHRoOiBudW1iZXI7IGhlaWdodDogbnVtYmVyOyBkcHI6IG51bWJlcjsgbWFza3M6IEFycmF5PHsgeDogbnVtYmVyOyB5OiBudW1iZXI7IHc6IG51bWJlcjsgaDogbnVtYmVyOyBmb3I6IHN0cmluZyB9PiB9PiB9ID0ge1xyXG4gICAgZ2VuZXJhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcclxuICAgIHdpbmRvdzogeyB3aWR0aDogVklFV1BPUlRfVywgaGVpZ2h0OiBWSUVXUE9SVF9IIH0sXHJcbiAgICBtdXRhdGUsXHJcbiAgICB2aWV3cG9ydHM6IFtdLFxyXG4gIH07XHJcbiAgZm9yIChjb25zdCB2IG9mIHZpZXdwb3J0cykge1xyXG4gICAgYXdhaXQgdi5zZXR1cCgpO1xyXG4gICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYT1kb2N1bWVudC5hY3RpdmVFbGVtZW50OyBpZihhICYmIGEuYmx1cikgYS5ibHVyKCk7IH0pKClgKTsgLy8gXHU1M0JCXHU3MTI2XHU3MEI5XHU3M0FGXHJcbiAgICBhd2FpdCBzbGVlcCg2MDApOyAvLyBcdThGQzdcdTZFMjFcdTRFMEVcdTZFMzJcdTY3RDNcdTdBMzNcdTVCOUFcclxuICAgIGlmIChtdXRhdGUgPT09IHYubmFtZSkge1xyXG4gICAgICAvLyBcdTdCQTFcdTdFQkZcdTgxRUFcdTY4QzA6XHU2Q0U4XHU1MTY1IDEyMFx1MDBENzkwIFx1NTZGQVx1NUI5QVx1N0VBMlx1NTc1NyhcdTdFQTYgMSUgXHU5NzYyXHU3OUVGLD4gMC41JSBcdTk2MDhcdTUwM0MsXHU1RTk0XHU1MjI0IEZBSUwpXHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGQ9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7IGQuc2V0QXR0cmlidXRlKCdkYXRhLXZpc3JlZy1tdXRhdGUnLCcxJyk7XHJcbiAgICAgICAgZC5zdHlsZS5jc3NUZXh0PSdwb3NpdGlvbjpmaXhlZDtsZWZ0OjU2MHB4O3RvcDozMDBweDt3aWR0aDoxMjBweDtoZWlnaHQ6OTBweDtiYWNrZ3JvdW5kOnJnYigyNTUsMCwwKTt6LWluZGV4Ojk5OTk7JztcclxuICAgICAgICBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKGQpOyB9KSgpYCk7XHJcbiAgICAgIGF3YWl0IHNsZWVwKDE1MCk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBpbWcgPSBhd2FpdCB3aW4ud2ViQ29udGVudHMuY2FwdHVyZVBhZ2UoKTtcclxuICAgIGNvbnN0IHNpemUgPSBpbWcuZ2V0U2l6ZSgpO1xyXG4gICAgLy8gXHU3QkExXHU3RUJGXHU4MUVBXHU2OEMwXHU3RUEyXHU1NzU3XHU1M0VBXHU1QzVFXHU0RThFXHU3NkVFXHU2ODA3XHU4OUM2XHU1M0UzOlx1NjIyQVx1NTZGRVx1NTQwRVx1N0FDQlx1NTM3M1x1NzlGQlx1OTY2NCxcdTRFMERcdTZDNjFcdTY3RDNcdTU0MEVcdTdFRURcdTg5QzZcdTUzRTNcclxuICAgIGlmIChtdXRhdGUgPT09IHYubmFtZSkge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBkPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLXZpc3JlZy1tdXRhdGVdJyk7IGlmKGQpIGQucmVtb3ZlKCk7IH0pKClgKTtcclxuICAgIH1cclxuICAgIGNvbnN0IGlubmVyVyA9IChhd2FpdCBqczxudW1iZXI+KCd3aW5kb3cuaW5uZXJXaWR0aCcpKSB8fCBzaXplLndpZHRoO1xyXG4gICAgY29uc3QgZHByID0gc2l6ZS53aWR0aCAvIGlubmVyVztcclxuICAgIGNvbnN0IG1hc2tzOiBBcnJheTx7IHg6IG51bWJlcjsgeTogbnVtYmVyOyB3OiBudW1iZXI7IGg6IG51bWJlcjsgZm9yOiBzdHJpbmcgfT4gPSBbXTtcclxuICAgIGZvciAoY29uc3QgbSBvZiBNQVNLX1NFTEVDVE9SUykge1xyXG4gICAgICBjb25zdCByZWN0cyA9IChhd2FpdCBqczxzdHJpbmc+KGAoZnVuY3Rpb24oKXsgcmV0dXJuIEpTT04uc3RyaW5naWZ5KFtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnJHttLnNlbH0nKSkubWFwKGZ1bmN0aW9uKGVsKXtcclxuICAgICAgICB2YXIgcj1lbC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTsgcmV0dXJuIHsgeDpyLngsIHk6ci55LCB3OnIud2lkdGgsIGg6ci5oZWlnaHQgfTtcclxuICAgICAgfSkuZmlsdGVyKGZ1bmN0aW9uKHIpeyByZXR1cm4gci53ID4gMCAmJiByLmggPiAwICYmIHIueSA+PSAwICYmIHIueSA8IHdpbmRvdy5pbm5lckhlaWdodDsgfSkpIH0pKClgKSk7XHJcbiAgICAgIGxldCBsaXN0OiBBcnJheTx7IHg6IG51bWJlcjsgeTogbnVtYmVyOyB3OiBudW1iZXI7IGg6IG51bWJlciB9PiA9IFtdO1xyXG4gICAgICB0cnkgeyBsaXN0ID0gSlNPTi5wYXJzZShyZWN0cykgYXMgdHlwZW9mIGxpc3Q7IH0gY2F0Y2ggeyAvKiBcdTdBN0EgKi8gfVxyXG4gICAgICBmb3IgKGNvbnN0IHIgb2YgbGlzdCkge1xyXG4gICAgICAgIG1hc2tzLnB1c2goeyB4OiBNYXRoLnJvdW5kKHIueCAqIGRwciksIHk6IE1hdGgucm91bmQoci55ICogZHByKSwgdzogTWF0aC5yb3VuZChyLncgKiBkcHIpLCBoOiBNYXRoLnJvdW5kKHIuaCAqIGRwciksIGZvcjogbS5yZWFzb24gfSk7XHJcbiAgICAgIH1cclxuICAgIH1cclxuICAgIGNvbnN0IGZpbGUgPSBgJHt2Lm5hbWV9LnBuZ2A7XHJcbiAgICBhd2FpdCB3cml0ZUZpbGUoam9pbihvdXQsIGZpbGUpLCBpbWcudG9QTkcoKSk7XHJcbiAgICBtZXRhLnZpZXdwb3J0cy5wdXNoKHsgbmFtZTogdi5uYW1lLCBmaWxlLCB3aWR0aDogc2l6ZS53aWR0aCwgaGVpZ2h0OiBzaXplLmhlaWdodCwgZHByOiBNYXRoLnJvdW5kKGRwciAqIDEwMCkgLyAxMDAsIG1hc2tzIH0pO1xyXG4gICAgY29uc29sZS5sb2coYFZJU1JFRy1DQVBUVVJFICR7di5uYW1lfSAke3NpemUud2lkdGh9eCR7c2l6ZS5oZWlnaHR9IG1hc2tzPSR7bWFza3MubGVuZ3RofSR7bXV0YXRlID09PSB2Lm5hbWUgPyAnIE1VVEFURUQnIDogJyd9YCk7XHJcbiAgfVxyXG4gIGF3YWl0IHdyaXRlRmlsZShqb2luKG91dCwgJ21ldGEuanNvbicpLCBKU09OLnN0cmluZ2lmeShtZXRhLCBudWxsLCAyKSk7XHJcbiAgY29uc29sZS5sb2coJ1ZJU1JFRy1DQVBUVVJFIERPTkUnKTtcclxuICBhcHAuZXhpdCgwKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGF0dGFjaFZpc3VhbFJlZ3Jlc3Npb24od2luOiBCcm93c2VyV2luZG93KTogdm9pZCB7XHJcbiAgd2luLndlYkNvbnRlbnRzLm9uY2UoJ2RpZC1maW5pc2gtbG9hZCcsICgpID0+IHtcclxuICAgIHNldFRpbWVvdXQoKCkgPT4geyB2b2lkIHJ1blZpc3VhbFJlZ3Jlc3Npb24od2luKTsgfSwgMV81MDApO1xyXG4gIH0pO1xyXG59XHJcbiIsICIvKipcclxuICogdjUuMSBcdTVCODlcdTg4QzVcdTU0MTFcdTVCRkMgXHUwMEI3IEBobWhhcm5lc3MvY2xpIFx1NUI4OVx1ODhDNVx1N0YxNlx1NjM5MihcdTRFM0JcdThGREJcdTdBMEIpXHUzMDAyXHJcbiAqXHJcbiAqIFx1NEUyNFx1Njc2MVx1OERFRlx1NUY4NChcdTYzRDBcdTc5M0FcdThCQ0QgdjUuMSBcdTU0MDhcdTU0MEMpOlxyXG4gKiAgLSBucG0gXHU1M0VGXHU3NTI4KFx1OUVEOFx1OEJBNCk6YG5wbSBpbnN0YWxsIC0tcHJlZml4ICVVU0VSUFJPRklMRSVcXC5obWhhcm5lc3MtZ2xvYmFsXHJcbiAqICAgIEBobWhhcm5lc3MvY2xpYCBcdTIwMTRcdTIwMTQgXHU1M0VBXHU1MTk5XHU3NTI4XHU2MjM3XHU3NkVFXHU1RjU1LFx1NEUwRFx1NzhCMFx1N0NGQlx1N0VERi9ucG0gXHU1MTY4XHU1QzQwO25wbSBcdTgxRUFcdTVFMjZcdTRGOURcdThENTZcdTg5RTNcdTY3OTAsXHJcbiAqICAgIFx1OEZEQlx1NUVBNlx1OEY2Q1x1NTNEMVx1NTE3Nlx1OEY5M1x1NTFGQVx1ODg0QyhcdTVCODlcdTg4QzVcdTZCNjVcdTlBQTRcdTY1ODdcdTY4NDgpXHUzMDAyXHJcbiAqICAtIFx1NjVFMCBucG0oXHU2MjE2XHU2NjNFXHU1RjBGXHU1RjNBXHU1MjM2KTpcdTgxRUFcdTc4MTQgdGd6IFx1NUI4OVx1ODhDNVx1NTY2OCBcdTIwMTRcdTIwMTQgXHU0RjlEXHU4RDU2XHU5NUVEXHU1MzA1XHU2NzY1XHU4MUVBXHJcbiAqICAgIEBobWgtZGVza3RvcC9jbGktaW5zdGFsbGVyKFx1N0VBRlx1OTAzQlx1OEY5MSxcdTVERjJcdTUzNTVcdTZENEIpLHRhcmJhbGwgXHU5MDEwXHU1MzA1XHU2RDQxXHU1RjBGXHU0RTBCXHU4RjdEXHJcbiAqICAgIChcdTc3MUZcdTVCNTdcdTgyODJcdThGREJcdTVFQTYgKyByZWdpc3RyeS5ucG1qcy5vcmdcdTIxOTJyZWdpc3RyeS5ucG1taXJyb3IuY29tIFx1OTU1Q1x1NTBDRlx1NTZERVx1OTAwMCxcclxuICogICAgXHU1OTBEXHU3NTI4IHY0IFx1NjZGNFx1NjVCMFx1NTY2OFx1NTZERVx1OTAwMFx1NjAxRFx1NjBGMyArIGludGVncml0eSBcdTY4MjFcdTlBOEMpLFx1N0NGQlx1N0VERiB0YXIuZXhlIFx1ODlFM1x1NTM4Qlx1NTIzMFxyXG4gKiAgICBub2RlX21vZHVsZXMgXHU2MjQxXHU1RTczXHU1RTAzXHU1QzQwXHUzMDAyXHJcbiAqIFx1OEZEQlx1NUVBNlx1NEUwMFx1NUY4Qlx1N0VDRiBpbnN0YWxsOnByb2dyZXNzIFx1NEU4Qlx1NEVGNlx1NjNBOCByZW5kZXJlcjtcdTYyMTBcdTUyOUZcdTU2REVcdThDMDMgb25JbnN0YWxsZWQoZW50cnkpXHJcbiAqIFx1NzUzMSBtYWluIFx1NjMwMVx1NEU0NVx1NTMxNiBydW50aW1lLmpzb24gXHU1RTc2XHU3MEVEXHU5MUNEXHU1NDJGIGhvc3RcdTMwMDJcclxuICovXHJcbmltcG9ydCB7IHNwYXduIH0gZnJvbSAnbm9kZTpjaGlsZF9wcm9jZXNzJztcclxuaW1wb3J0IHsgZXhpc3RzU3luYywgbWtkaXJTeW5jLCBybVN5bmMsIHJlbmFtZVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tICdub2RlOmZzJztcclxuaW1wb3J0IHsgaG9tZWRpciB9IGZyb20gJ25vZGU6b3MnO1xyXG5pbXBvcnQgeyBqb2luIH0gZnJvbSAnbm9kZTpwYXRoJztcclxuaW1wb3J0IHsgYnl0ZXNMYWJlbCwgaW50ZWdyaXR5T2ssIG1vZHVsZURpciwgcmVzb2x2ZUNsb3N1cmUsIHRhcmJhbGxNaXJyb3JzLCB0eXBlIFBhY2t1bWVudCwgdHlwZSBSZXNvbHZlZFBrZyB9IGZyb20gJ0BobWgtZGVza3RvcC9jbGktaW5zdGFsbGVyJztcclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgSW5zdGFsbFByb2dyZXNzIHtcclxuICBwaGFzZTogJ2NoZWNrJyB8ICdtZXRhJyB8ICdkb3dubG9hZCcgfCAnZXh0cmFjdCcgfCAnbnBtJyB8ICdkb25lJyB8ICdlcnJvcic7XHJcbiAgcGN0PzogbnVtYmVyO1xyXG4gIHRleHQ6IHN0cmluZztcclxuICBtaXJyb3I/OiBzdHJpbmc7XHJcbiAgZW50cnk/OiBzdHJpbmc7XHJcbiAgZXJyb3I/OiBzdHJpbmc7XHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgSW5zdGFsbE9wdGlvbnMge1xyXG4gIC8qKiBcdTVGM0FcdTUyMzZcdThENzBcdTgxRUFcdTc4MTQgdGd6IFx1OERFRlx1NUY4NChcdTZENEJcdThCRDUvXHU2NUUwIG5wbSBcdTczQUZcdTU4ODMpXHUzMDAyICovXHJcbiAgZm9yY2VUZ3o/OiBib29sZWFuIHwgdW5kZWZpbmVkO1xyXG4gIC8qKiBcdTk1NUNcdTUwQ0ZcdTRGMThcdTUxNDhcdTdFQTcoXHU2MzYyXHU2RTkwXHU2MzA5XHU5NEFFXHU3RkZCXHU4RjZDKVx1MzAwMiAqL1xyXG4gIG1pcnJvckZpcnN0PzogJ25wbWpzJyB8ICducG1taXJyb3InIHwgdW5kZWZpbmVkO1xyXG59XHJcblxyXG5leHBvcnQgY29uc3QgUkVHSVNUUklFUzogUmVjb3JkPCducG1qcycgfCAnbnBtbWlycm9yJywgc3RyaW5nPiA9IHtcclxuICBucG1qczogJ2h0dHBzOi8vcmVnaXN0cnkubnBtanMub3JnJyxcclxuICBucG1taXJyb3I6ICdodHRwczovL3JlZ2lzdHJ5Lm5wbW1pcnJvci5jb20nLFxyXG59O1xyXG5cclxuLyoqIFx1NUI4OVx1ODhDNVx1NjgzOVx1NzZFRVx1NUY1NShcdTc1MjhcdTYyMzdcdTc2RUVcdTVGNTUsXHU3RUREXHU0RTBEXHU1MTk5XHU3Q0ZCXHU3RURGL1x1NTE2OFx1NUM0MCBucG0pXHUzMDAyICovXHJcbmV4cG9ydCBmdW5jdGlvbiBpbnN0YWxsVGFyZ2V0KCk6IHN0cmluZyB7XHJcbiAgcmV0dXJuIGpvaW4oaG9tZWRpcigpLCAnLmhtaGFybmVzcy1nbG9iYWwnKTtcclxufVxyXG5cclxuLyoqIFx1NUI4OVx1ODhDNVx1NUI4Q1x1NjIxMFx1NTQwRVx1NzY4NCBkZXNrdG9wLWhvc3QgXHU1MTY1XHU1M0UzKG5wbSBcdTVENENcdTU5NTdcdTRFMEVcdTYzRDBcdTUzNDdcdTRFMjRcdTc5Q0RcdTVFMDNcdTVDNDBcdTkwRkRcdThCQTQpXHUzMDAyICovXHJcbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlSW5zdGFsbGVkRW50cnkodGFyZ2V0OiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gIGNvbnN0IG5lc3RlZCA9IGpvaW4odGFyZ2V0LCAnbm9kZV9tb2R1bGVzJywgJ0BobWhhcm5lc3MnLCAnY2xpJywgJ25vZGVfbW9kdWxlcycsICdAaG1oYXJuZXNzJywgJ3dlYicsICdkaXN0JywgJ2Rlc2t0b3AtaG9zdC5qcycpO1xyXG4gIGNvbnN0IGhvaXN0ZWQgPSBqb2luKHRhcmdldCwgJ25vZGVfbW9kdWxlcycsICdAaG1oYXJuZXNzJywgJ3dlYicsICdkaXN0JywgJ2Rlc2t0b3AtaG9zdC5qcycpO1xyXG4gIGlmIChleGlzdHNTeW5jKG5lc3RlZCkpIHJldHVybiBuZXN0ZWQ7XHJcbiAgaWYgKGV4aXN0c1N5bmMoaG9pc3RlZCkpIHJldHVybiBob2lzdGVkO1xyXG4gIHJldHVybiAnJztcclxufVxyXG5cclxuZXhwb3J0IGludGVyZmFjZSBJbnN0YWxsZXJIb3N0IHtcclxuICBzZW5kUHJvZ3Jlc3MocDogSW5zdGFsbFByb2dyZXNzKTogdm9pZDtcclxuICBsb2cobXNnOiBzdHJpbmcpOiB2b2lkO1xyXG4gIC8qKiBcdTVCODlcdTg4QzVcdTYyMTBcdTUyOUYoXHU1MTY1XHU1M0UzXHU1REYyXHU5QThDXHU4QkMxXHU1QjU4XHU1NzI4KVx1MjAxNFx1MjAxNCBtYWluIFx1NTcyOFx1NkI2NFx1NjMwMVx1NEU0NVx1NTMxNlx1NUU3Nlx1OTFDRFx1NTQyRiBob3N0XHUzMDAyICovXHJcbiAgb25JbnN0YWxsZWQoZW50cnk6IHN0cmluZywgdmlhOiAnbnBtJyB8ICd0Z3onKTogdm9pZDtcclxufVxyXG5cclxubGV0IHJ1bm5pbmcgPSBmYWxzZTtcclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpbnN0YWxsUnVubmluZygpOiBib29sZWFuIHtcclxuICByZXR1cm4gcnVubmluZztcclxufVxyXG5cclxuLyoqIFx1NTQyRlx1NTJBOFx1NUI4OVx1ODhDNShcdTU0MEVcdTUzRjBcdTYyNjdcdTg4NEM7XHU4RkRCXHU1RUE2L1x1N0VEM1x1Njc5Q1x1NTE2OFx1OTBFOFx1N0VDRlx1NEU4Qlx1NEVGNlx1NTZERVx1NkQ0MSxQcm9taXNlIFx1NTNFQVx1ODg2OFx1OEZCRVwiXHU1REYyXHU1M0Q3XHU3NDA2XCIpXHUzMDAyICovXHJcbmV4cG9ydCBmdW5jdGlvbiBzdGFydENsaUluc3RhbGwoaG9zdDogSW5zdGFsbGVySG9zdCwgb3B0czogSW5zdGFsbE9wdGlvbnMgPSB7fSk6IHsgb2s6IGJvb2xlYW47IGVycm9yPzogc3RyaW5nIH0ge1xyXG4gIGlmIChydW5uaW5nKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAnXHU1Qjg5XHU4OEM1XHU1REYyXHU1NzI4XHU4RkRCXHU4ODRDXHU0RTJEJyB9O1xyXG4gIHJ1bm5pbmcgPSB0cnVlO1xyXG4gIGNvbnN0IGZpbmlzaCA9IChwOiBJbnN0YWxsUHJvZ3Jlc3MpOiB2b2lkID0+IHtcclxuICAgIGhvc3Quc2VuZFByb2dyZXNzKHApO1xyXG4gICAgcnVubmluZyA9IGZhbHNlO1xyXG4gIH07XHJcbiAgY29uc3QgZmFpbCA9ICh0ZXh0OiBzdHJpbmcsIGVycjogdW5rbm93bik6IHZvaWQgPT4ge1xyXG4gICAgaG9zdC5sb2coYGluc3RhbGwgZmFpbGVkOiAke3RleHR9ICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTgwKX1gKTtcclxuICAgIGZpbmlzaCh7IHBoYXNlOiAnZXJyb3InLCB0ZXh0LCBlcnJvcjogYCR7dGV4dH06JHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxNjApfWAgfSk7XHJcbiAgfTtcclxuICB2b2lkIChhc3luYyAoKSA9PiB7XHJcbiAgICBjb25zdCB0YXJnZXQgPSBpbnN0YWxsVGFyZ2V0KCk7XHJcbiAgICB0cnkge1xyXG4gICAgICBta2RpclN5bmModGFyZ2V0LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcclxuICAgICAgY29uc3QgbnBtT2sgPSBvcHRzLmZvcmNlVGd6ID09PSB0cnVlID8gZmFsc2UgOiBhd2FpdCBwcm9iZU5wbShob3N0KTtcclxuICAgICAgaWYgKG5wbU9rKSBhd2FpdCBpbnN0YWxsVmlhTnBtKGhvc3QsIHRhcmdldCwgb3B0cyk7XHJcbiAgICAgIGVsc2UgYXdhaXQgaW5zdGFsbFZpYVRhcmJhbGxzKGhvc3QsIHRhcmdldCwgb3B0cyk7XHJcbiAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgZmFpbCgnXHU1Qjg5XHU4OEM1XHU1OTMxXHU4RDI1JywgZXJyKTtcclxuICAgIH1cclxuICB9KSgpO1xyXG4gIHJldHVybiB7IG9rOiB0cnVlIH07XHJcbn1cclxuXHJcbi8qIC0tLS0gbnBtIFx1NTNFRlx1NzUyOFx1NjAyNyhcdTZDRThcdTYxMEY6V2luZG93cyBcdTRFMEIgc3Bhd24oJ25wbScpIFx1NTNFRlx1ODg0QywnbnBtLmNtZCcgXHU1M0NEXHU4MDBDIEVJTlZBTCkgLS0tLSAqL1xyXG5hc3luYyBmdW5jdGlvbiBwcm9iZU5wbShob3N0OiBJbnN0YWxsZXJIb3N0KTogUHJvbWlzZTxib29sZWFuPiB7XHJcbiAgaG9zdC5zZW5kUHJvZ3Jlc3MoeyBwaGFzZTogJ2NoZWNrJywgdGV4dDogJ1x1NjhDMFx1NjdFNSBucG1cdTIwMjYnIH0pO1xyXG4gIGNvbnN0IG9rID0gYXdhaXQgbmV3IFByb21pc2U8Ym9vbGVhbj4oKHJlc29sdmUpID0+IHtcclxuICAgIGNvbnN0IGMgPSBzcGF3bignbnBtJywgWyctLXZlcnNpb24nXSwgeyB3aW5kb3dzSGlkZTogdHJ1ZSwgc3RkaW86ICdpZ25vcmUnIH0pO1xyXG4gICAgY29uc3QgdCA9IHNldFRpbWVvdXQoKCkgPT4geyB0cnkgeyBjLmtpbGwoKTsgfSBjYXRjaCB7IC8qIG5vb3AgKi8gfSByZXNvbHZlKGZhbHNlKTsgfSwgMTVfMDAwKTtcclxuICAgIGMub24oJ2Vycm9yJywgKCkgPT4geyBjbGVhclRpbWVvdXQodCk7IHJlc29sdmUoZmFsc2UpOyB9KTtcclxuICAgIGMub24oJ2V4aXQnLCAoY29kZSkgPT4geyBjbGVhclRpbWVvdXQodCk7IHJlc29sdmUoY29kZSA9PT0gMCk7IH0pO1xyXG4gIH0pO1xyXG4gIGhvc3QubG9nKGBucG0gJHtvayA/ICdhdmFpbGFibGUnIDogJ3VuYXZhaWxhYmxlJ30gXHUyMTkyICR7b2sgPyAnbnBtIHByZWZpeCcgOiAndGd6J30gcGF0aGApO1xyXG4gIHJldHVybiBvaztcclxufVxyXG5cclxuLyogLS0tLSBcdThERUZcdTVGODQgQTpucG0gLS1wcmVmaXgoXHU1Qjg5XHU4OEM1XHU2QjY1XHU5QUE0XHU2NTg3XHU2ODQ4ID0gbnBtIFx1OEY5M1x1NTFGQVx1ODg0QykgLS0tLSAqL1xyXG5hc3luYyBmdW5jdGlvbiBpbnN0YWxsVmlhTnBtKGhvc3Q6IEluc3RhbGxlckhvc3QsIHRhcmdldDogc3RyaW5nLCBvcHRzOiBJbnN0YWxsT3B0aW9ucyk6IFByb21pc2U8dm9pZD4ge1xyXG4gIGhvc3Quc2VuZFByb2dyZXNzKHsgcGhhc2U6ICducG0nLCB0ZXh0OiBgbnBtIGluc3RhbGwgQGhtaGFybmVzcy9jbGkgXHUyMTkyICR7dGFyZ2V0fShcdTRFQzVcdTc1MjhcdTYyMzdcdTc2RUVcdTVGNTUpYCB9KTtcclxuICBjb25zdCByZWdpc3RyeSA9IG9wdHMubWlycm9yRmlyc3QgPT09ICducG1taXJyb3InID8gWyctLXJlZ2lzdHJ5JywgUkVHSVNUUklFUy5ucG1taXJyb3JdIDogb3B0cy5taXJyb3JGaXJzdCA9PT0gJ25wbWpzJyA/IFsnLS1yZWdpc3RyeScsIFJFR0lTVFJJRVMubnBtanNdIDogW107XHJcbiAgY29uc3QgYXJncyA9IFsnaW5zdGFsbCcsICctLXByZWZpeCcsIHRhcmdldCwgJy0tbm8tYXVkaXQnLCAnLS1uby1mdW5kJywgJy0tbG9nbGV2ZWwnLCAnbm90aWNlJywgLi4ucmVnaXN0cnksICdAaG1oYXJuZXNzL2NsaUBsYXRlc3QnXTtcclxuICBjb25zdCBjb2RlID0gYXdhaXQgbmV3IFByb21pc2U8bnVtYmVyPigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XHJcbiAgICBjb25zdCBjID0gc3Bhd24oJ25wbScsIGFyZ3MsIHsgd2luZG93c0hpZGU6IHRydWUsIGN3ZDogaG9tZWRpcigpIH0pO1xyXG4gICAgbGV0IGxhc3QgPSAnJztcclxuICAgIGNvbnN0IG9uTGluZSA9IChkOiBCdWZmZXIpOiB2b2lkID0+IHtcclxuICAgICAgZm9yIChjb25zdCByYXcgb2YgZC50b1N0cmluZygpLnNwbGl0KC9cXHI/XFxuLykpIHtcclxuICAgICAgICBjb25zdCBsaW5lID0gcmF3LnJlcGxhY2UoL1tcXHUwMDAwLVxcdTAwMWZdL2csICcnKS50cmltKCkuc2xpY2UoMCwgMTgwKTtcclxuICAgICAgICBpZiAobGluZSA9PT0gJycgfHwgbGluZSA9PT0gbGFzdCkgY29udGludWU7XHJcbiAgICAgICAgbGFzdCA9IGxpbmU7XHJcbiAgICAgICAgaG9zdC5zZW5kUHJvZ3Jlc3MoeyBwaGFzZTogJ25wbScsIHRleHQ6IGxpbmUgfSk7XHJcbiAgICAgIH1cclxuICAgIH07XHJcbiAgICBjLnN0ZG91dD8ub24oJ2RhdGEnLCBvbkxpbmUpO1xyXG4gICAgYy5zdGRlcnI/Lm9uKCdkYXRhJywgb25MaW5lKTtcclxuICAgIGMub24oJ2Vycm9yJywgcmVqZWN0KTtcclxuICAgIGNvbnN0IGtpbGxlciA9IHNldFRpbWVvdXQoKCkgPT4geyB0cnkgeyBjLmtpbGwoKTsgfSBjYXRjaCB7IC8qIG5vb3AgKi8gfSByZWplY3QobmV3IEVycm9yKCducG0gXHU1Qjg5XHU4OEM1XHU4RDg1XHU2NUY2KDggXHU1MjA2XHU5NDlGKScpKTsgfSwgOCAqIDYwXzAwMCk7XHJcbiAgICBjLm9uKCdleGl0JywgKHgpID0+IHsgY2xlYXJUaW1lb3V0KGtpbGxlcik7IHJlc29sdmUoeCA/PyAxKTsgfSk7XHJcbiAgfSk7XHJcbiAgaWYgKGNvZGUgIT09IDApIHRocm93IG5ldyBFcnJvcihgbnBtIGluc3RhbGwgXHU5MDAwXHU1MUZBXHU3ODAxICR7Y29kZX1gKTtcclxuICBjb25zdCBlbnRyeSA9IHJlc29sdmVJbnN0YWxsZWRFbnRyeSh0YXJnZXQpO1xyXG4gIGlmIChlbnRyeSA9PT0gJycpIHRocm93IG5ldyBFcnJvcignbnBtIFx1NUI4OVx1ODhDNVx1NUI4Q1x1NjIxMFx1NEY0Nlx1NjcyQVx1NjI3RVx1NTIzMCBkZXNrdG9wLWhvc3QgXHU1MTY1XHU1M0UzJyk7XHJcbiAgd3JpdGVTdGFtcCh0YXJnZXQsICducG0nKTtcclxuICBmaW5pc2hJbnN0YWxsKGhvc3QsIGVudHJ5LCAnbnBtJyk7XHJcbn1cclxuXHJcbi8qIC0tLS0gXHU4REVGXHU1Rjg0IEI6XHU4MUVBXHU3ODE0IHRneihcdTc3MUZcdTRFMEJcdThGN0RcdThGREJcdTVFQTYgKyBcdTk1NUNcdTUwQ0ZcdTU2REVcdTkwMDAgKyBpbnRlZ3JpdHkgKyB0YXIgXHU4OUUzXHU1MzhCKSAtLS0tICovXHJcbmFzeW5jIGZ1bmN0aW9uIGluc3RhbGxWaWFUYXJiYWxscyhob3N0OiBJbnN0YWxsZXJIb3N0LCB0YXJnZXQ6IHN0cmluZywgb3B0czogSW5zdGFsbE9wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcclxuICBjb25zdCBvcmRlcjogQXJyYXk8J25wbWpzJyB8ICducG1taXJyb3InPiA9IG9wdHMubWlycm9yRmlyc3QgPT09ICducG1taXJyb3InID8gWyducG1taXJyb3InLCAnbnBtanMnXSA6IFsnbnBtanMnLCAnbnBtbWlycm9yJ107XHJcbiAgY29uc3QgbWlycm9ycyA9IG9yZGVyLm1hcCgoaykgPT4gUkVHSVNUUklFU1trXSk7XHJcbiAgaG9zdC5zZW5kUHJvZ3Jlc3MoeyBwaGFzZTogJ21ldGEnLCB0ZXh0OiAnXHU4OUUzXHU2NzkwXHU0RjlEXHU4RDU2XHU2RTA1XHU1MzU1KEBobWhhcm5lc3MvY2xpIFx1NTE2OFx1NUJCNilcdTIwMjYnIH0pO1xyXG5cclxuICBjb25zdCBwYWNrdW1lbnRzID0gbmV3IE1hcDxzdHJpbmcsIFBhY2t1bWVudD4oKTtcclxuICBjb25zdCBnZXRQYWNrdW1lbnQgPSBhc3luYyAobmFtZTogc3RyaW5nKTogUHJvbWlzZTxQYWNrdW1lbnQ+ID0+IHtcclxuICAgIGNvbnN0IGhpdCA9IHBhY2t1bWVudHMuZ2V0KG5hbWUpO1xyXG4gICAgaWYgKGhpdCAhPT0gdW5kZWZpbmVkKSByZXR1cm4gaGl0O1xyXG4gICAgbGV0IGxhc3RFcnIgPSAnJztcclxuICAgIGZvciAoY29uc3QgbSBvZiBtaXJyb3JzKSB7XHJcbiAgICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgciA9IGF3YWl0IGZldGNoKGAke219LyR7ZW5jb2RlVVJJQ29tcG9uZW50KG5hbWUpfWAsIHtcclxuICAgICAgICAgIGhlYWRlcnM6IHsgYWNjZXB0OiAnYXBwbGljYXRpb24vdm5kLm5wbS5pbnN0YWxsLXYxK2pzb24nIH0sXHJcbiAgICAgICAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoMjVfMDAwKSxcclxuICAgICAgICB9KTtcclxuICAgICAgICBpZiAoIXIub2spIHsgbGFzdEVyciA9IGBIVFRQICR7ci5zdGF0dXN9YDsgY29udGludWU7IH1cclxuICAgICAgICBjb25zdCBkb2MgPSAoYXdhaXQgci5qc29uKCkpIGFzIFBhY2t1bWVudDtcclxuICAgICAgICBpZiAoZG9jLnZlcnNpb25zID09PSB1bmRlZmluZWQpIHsgbGFzdEVyciA9ICdtYWxmb3JtZWQgcGFja3VtZW50JzsgY29udGludWU7IH1cclxuICAgICAgICBwYWNrdW1lbnRzLnNldChuYW1lLCBkb2MpO1xyXG4gICAgICAgIHJldHVybiBkb2M7XHJcbiAgICAgIH0gY2F0Y2ggKGVycikgeyBsYXN0RXJyID0gU3RyaW5nKGVycikuc2xpY2UoMCwgNjApOyB9XHJcbiAgICB9XHJcbiAgICB0aHJvdyBuZXcgRXJyb3IoYFx1ODNCN1x1NTNENiAke25hbWV9IFx1NTE0M1x1NjU3MFx1NjM2RVx1NTkzMVx1OEQyNShcdTUxNjhcdTkwRThcdTk1NUNcdTUwQ0Y6JHtsYXN0RXJyfSlgKTtcclxuICB9O1xyXG5cclxuICBjb25zdCBjbG9zdXJlID0gYXdhaXQgcmVzb2x2ZUNsb3N1cmUoeyBuYW1lOiAnQGhtaGFybmVzcy9jbGknLCBzcGVjOiAnbGF0ZXN0JyB9LCBnZXRQYWNrdW1lbnQpO1xyXG4gIGNvbnN0IHJvb3QgPSBjbG9zdXJlLmZpbmQoKHApID0+IHAubmFtZSA9PT0gJ0BobWhhcm5lc3MvY2xpJyk7XHJcbiAgaG9zdC5sb2coYGNsb3N1cmU6ICR7Y2xvc3VyZS5sZW5ndGh9IHBhY2thZ2VzIChyb290IEBobWhhcm5lc3MvY2xpQCR7cm9vdD8udmVyc2lvbiA/PyAnPyd9KWApO1xyXG4gIGhvc3Quc2VuZFByb2dyZXNzKHsgcGhhc2U6ICdtZXRhJywgdGV4dDogYFx1NEY5RFx1OEQ1Nlx1NkUwNVx1NTM1NVx1NUMzMVx1N0VFQToke2Nsb3N1cmUubGVuZ3RofSBcdTRFMkFcdTUzMDUoQGhtaGFybmVzcy9jbGlAJHtyb290Py52ZXJzaW9uID8/ICc/J30pYCB9KTtcclxuXHJcbiAgY29uc3Qgc3RhZ2luZyA9IGpvaW4odGFyZ2V0LCAnLnN0YWdpbmcnKTtcclxuICBybVN5bmMoc3RhZ2luZywgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xyXG4gIG1rZGlyU3luYyhzdGFnaW5nLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcclxuXHJcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBjbG9zdXJlLmxlbmd0aDsgaSsrKSB7XHJcbiAgICBjb25zdCBwa2cgPSBjbG9zdXJlW2ldITtcclxuICAgIGNvbnN0IHVybHMgPSB0YXJiYWxsTWlycm9ycyhwa2cudGFyYmFsbCwgbWlycm9ycyk7XHJcbiAgICBsZXQgYnVmOiBCdWZmZXIgfCBudWxsID0gbnVsbDtcclxuICAgIGxldCB1c2VkTWlycm9yID0gJyc7XHJcbiAgICBsZXQgbGFzdEVyciA9ICcnO1xyXG4gICAgZm9yIChjb25zdCB1IG9mIHVybHMpIHtcclxuICAgICAgdHJ5IHtcclxuICAgICAgICBjb25zdCByID0gYXdhaXQgZmV0Y2godSwgeyBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoMzAwXzAwMCkgfSk7XHJcbiAgICAgICAgaWYgKCFyLm9rKSB7IGxhc3RFcnIgPSBgSFRUUCAke3Iuc3RhdHVzfWA7IGNvbnRpbnVlOyB9XHJcbiAgICAgICAgY29uc3QgdG90YWwgPSBOdW1iZXIoci5oZWFkZXJzLmdldCgnY29udGVudC1sZW5ndGgnKSA/PyAnMCcpO1xyXG4gICAgICAgIGNvbnN0IHJlYWRlciA9IHIuYm9keT8uZ2V0UmVhZGVyKCk7XHJcbiAgICAgICAgaWYgKHJlYWRlciA9PT0gdW5kZWZpbmVkKSB0aHJvdyBuZXcgRXJyb3IoJ25vIGJvZHknKTtcclxuICAgICAgICBjb25zdCBjaHVua3M6IEJ1ZmZlcltdID0gW107XHJcbiAgICAgICAgbGV0IGdvdCA9IDA7XHJcbiAgICAgICAgbGV0IGxhc3RFbWl0ID0gMDtcclxuICAgICAgICBmb3IgKDs7KSB7XHJcbiAgICAgICAgICBjb25zdCB7IGRvbmUsIHZhbHVlIH0gPSBhd2FpdCByZWFkZXIucmVhZCgpO1xyXG4gICAgICAgICAgaWYgKGRvbmUgPT09IHRydWUpIGJyZWFrO1xyXG4gICAgICAgICAgY29uc3QgYiA9IEJ1ZmZlci5mcm9tKHZhbHVlKTtcclxuICAgICAgICAgIGNodW5rcy5wdXNoKGIpO1xyXG4gICAgICAgICAgZ290ICs9IGIubGVuZ3RoO1xyXG4gICAgICAgICAgaWYgKGdvdCAtIGxhc3RFbWl0ID4gMjU2ICogMTAyNCkge1xyXG4gICAgICAgICAgICBsYXN0RW1pdCA9IGdvdDtcclxuICAgICAgICAgICAgaG9zdC5zZW5kUHJvZ3Jlc3Moe1xyXG4gICAgICAgICAgICAgIHBoYXNlOiAnZG93bmxvYWQnLFxyXG4gICAgICAgICAgICAgIHBjdDogTWF0aC5yb3VuZCgoKGkgKyBNYXRoLm1pbihnb3QgLyAodG90YWwgfHwgZ290KSwgMSkpIC8gY2xvc3VyZS5sZW5ndGgpICogMTAwKSxcclxuICAgICAgICAgICAgICB0ZXh0OiBgXHU0RTBCXHU4RjdEICR7cGtnLm5hbWV9QCR7cGtnLnZlcnNpb259KCR7aSArIDF9LyR7Y2xvc3VyZS5sZW5ndGh9KVx1MDBCNyAke2J5dGVzTGFiZWwoZ290KX0ke3RvdGFsID4gMCA/IGAgLyAke2J5dGVzTGFiZWwodG90YWwpfWAgOiAnJ31gLFxyXG4gICAgICAgICAgICAgIG1pcnJvcjogbmV3IFVSTCh1KS5ob3N0LFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgYnVmID0gQnVmZmVyLmNvbmNhdChjaHVua3MpO1xyXG4gICAgICAgIGlmICghaW50ZWdyaXR5T2soYnVmLCBwa2cuaW50ZWdyaXR5KSkgeyBsYXN0RXJyID0gJ2ludGVncml0eSBcdTRFMERcdTUzMzlcdTkxNEQnOyBidWYgPSBudWxsOyBjb250aW51ZTsgfVxyXG4gICAgICAgIHVzZWRNaXJyb3IgPSBuZXcgVVJMKHUpLmhvc3Q7XHJcbiAgICAgICAgYnJlYWs7XHJcbiAgICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICAgIGxhc3RFcnIgPSBTdHJpbmcoZXJyKS5zbGljZSgwLCA2MCk7XHJcbiAgICAgIH1cclxuICAgIH1cclxuICAgIGlmIChidWYgPT09IG51bGwpIHRocm93IG5ldyBFcnJvcihgXHU0RTBCXHU4RjdEICR7cGtnLm5hbWV9IFx1NTkzMVx1OEQyNShcdTUxNjhcdTkwRThcdTk1NUNcdTUwQ0Y6JHtsYXN0RXJyfSlgKTtcclxuICAgIGNvbnN0IHRneiA9IGpvaW4oc3RhZ2luZywgYCR7aX0udGd6YCk7XHJcbiAgICB3cml0ZUZpbGVTeW5jKHRneiwgYnVmKTtcclxuICAgIGhvc3Quc2VuZFByb2dyZXNzKHtcclxuICAgICAgcGhhc2U6ICdkb3dubG9hZCcsXHJcbiAgICAgIHBjdDogTWF0aC5yb3VuZCgoKGkgKyAxKSAvIGNsb3N1cmUubGVuZ3RoKSAqIDEwMCksXHJcbiAgICAgIHRleHQ6IGBcdTRFMEJcdThGN0QgJHtwa2cubmFtZX1AJHtwa2cudmVyc2lvbn0gXHU1QjhDXHU2MjEwKCR7Ynl0ZXNMYWJlbChidWYubGVuZ3RoKX0sdmlhICR7dXNlZE1pcnJvcn0pYCxcclxuICAgICAgbWlycm9yOiB1c2VkTWlycm9yLFxyXG4gICAgfSk7XHJcbiAgfVxyXG5cclxuICBob3N0LnNlbmRQcm9ncmVzcyh7IHBoYXNlOiAnZXh0cmFjdCcsIHRleHQ6ICdcdTg5RTNcdTUzOEJcdTVFNzZcdTVFMDNcdTVDNDAgbm9kZV9tb2R1bGVzXHUyMDI2JyB9KTtcclxuICBmb3IgKGxldCBpID0gMDsgaSA8IGNsb3N1cmUubGVuZ3RoOyBpKyspIHtcclxuICAgIGNvbnN0IHBrZyA9IGNsb3N1cmVbaV0hO1xyXG4gICAgYXdhaXQgZXh0cmFjdFRneihqb2luKHN0YWdpbmcsIGAke2l9LnRnemApLCBzdGFnaW5nLCBwa2cpO1xyXG4gICAgaG9zdC5zZW5kUHJvZ3Jlc3MoeyBwaGFzZTogJ2V4dHJhY3QnLCBwY3Q6IE1hdGgucm91bmQoKChpICsgMSkgLyBjbG9zdXJlLmxlbmd0aCkgKiAxMDApLCB0ZXh0OiBgXHU4OUUzXHU1MzhCICR7cGtnLm5hbWV9KCR7aSArIDF9LyR7Y2xvc3VyZS5sZW5ndGh9KWAgfSk7XHJcbiAgfVxyXG4gIHJtU3luYyhzdGFnaW5nLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XHJcblxyXG4gIGNvbnN0IGVudHJ5ID0gcmVzb2x2ZUluc3RhbGxlZEVudHJ5KHRhcmdldCk7XHJcbiAgaWYgKGVudHJ5ID09PSAnJykgdGhyb3cgbmV3IEVycm9yKCd0Z3ogXHU1Qjg5XHU4OEM1XHU1QjhDXHU2MjEwXHU0RjQ2XHU2NzJBXHU2MjdFXHU1MjMwIGRlc2t0b3AtaG9zdCBcdTUxNjVcdTUzRTMnKTtcclxuICB3cml0ZVN0YW1wKHRhcmdldCwgJ3RneicpO1xyXG4gIGZpbmlzaEluc3RhbGwoaG9zdCwgZW50cnksICd0Z3onKTtcclxufVxyXG5cclxuLyoqIHRhci5leGUoV2luMTArIFx1ODFFQVx1NUUyNilcdTg5RTNcdTUzOEIgdGd6IFx1NTIzMCBleERpcixcdTUxOERcdTYyOEEgcGFja2FnZS8gXHU2MzJBXHU1MjMwIG5vZGVfbW9kdWxlcyBcdTVFMDNcdTVDNDBcdTMwMDIgKi9cclxuYXN5bmMgZnVuY3Rpb24gZXh0cmFjdFRneih0Z3o6IHN0cmluZywgc3RhZ2luZzogc3RyaW5nLCBwa2c6IFJlc29sdmVkUGtnKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgY29uc3QgZXhEaXIgPSBqb2luKHN0YWdpbmcsIGB4LSR7cGtnLm5hbWUucmVwbGFjZSgvW15cXHcuLV0vZywgJ18nKX1gKTtcclxuICBybVN5bmMoZXhEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcclxuICBta2RpclN5bmMoZXhEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xyXG4gIGNvbnN0IGNvZGUgPSBhd2FpdCBuZXcgUHJvbWlzZTxudW1iZXI+KChyZXNvbHZlLCByZWplY3QpID0+IHtcclxuICAgIGNvbnN0IGMgPSBzcGF3bigndGFyJywgWycteHpmJywgdGd6LCAnLUMnLCBleERpcl0sIHsgd2luZG93c0hpZGU6IHRydWUsIHN0ZGlvOiAnaWdub3JlJyB9KTtcclxuICAgIGMub24oJ2Vycm9yJywgcmVqZWN0KTtcclxuICAgIGMub24oJ2V4aXQnLCAoeCkgPT4gcmVzb2x2ZSh4ID8/IDEpKTtcclxuICB9KTtcclxuICBpZiAoY29kZSAhPT0gMCkgdGhyb3cgbmV3IEVycm9yKGB0YXIgXHU4OUUzXHU1MzhCICR7cGtnLm5hbWV9IFx1NTkzMVx1OEQyNShcdTkwMDBcdTUxRkFcdTc4MDEgJHtjb2RlfSlgKTtcclxuICBjb25zdCBkZXN0ID0gbW9kdWxlRGlyKGluc3RhbGxUYXJnZXQoKSwgcGtnLm5hbWUpO1xyXG4gIGNvbnN0IHBhcmVudCA9IGRlc3Quc2xpY2UoMCwgZGVzdC5sYXN0SW5kZXhPZignXFxcXCcpKTtcclxuICBta2RpclN5bmMocGFyZW50LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcclxuICBybVN5bmMoZGVzdCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xyXG4gIHJlbmFtZVN5bmMoam9pbihleERpciwgJ3BhY2thZ2UnKSwgZGVzdCk7XHJcbiAgcm1TeW5jKGV4RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XHJcbn1cclxuXHJcbi8qKiBcdTVCODlcdTg4QzVcdTYyMzMoXHU1NDExXHU1QkZDXHU1QjhDXHU2MjEwXHU5ODc1L1x1OEJCRVx1N0Y2RVx1OTc2Mlx1Njc3Rlx1NUM1NVx1NzkzQVx1NUI4OVx1ODhDNVx1NjVCOVx1NUYwRlx1NEUwRVx1NjVGNlx1OTVGNDtcdTRFMERcdTYyN0ZcdThGN0RcdThGRDBcdTg4NENcdTY1RjZcdTkwM0JcdThGOTEpXHUzMDAyICovXHJcbmZ1bmN0aW9uIHdyaXRlU3RhbXAodGFyZ2V0OiBzdHJpbmcsIHZpYTogJ25wbScgfCAndGd6Jyk6IHZvaWQge1xyXG4gIHRyeSB7XHJcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4odGFyZ2V0LCAnaW5zdGFsbGVkLWJ5LWhtaC1kZXNrdG9wLmpzb24nKSwgSlNPTi5zdHJpbmdpZnkoeyB2aWEsIGF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkgfSwgbnVsbCwgMiksICd1dGY4Jyk7XHJcbiAgfSBjYXRjaCB7IC8qIGJlc3QgZWZmb3J0ICovIH1cclxufVxyXG5cclxuZnVuY3Rpb24gZmluaXNoSW5zdGFsbChob3N0OiBJbnN0YWxsZXJIb3N0LCBlbnRyeTogc3RyaW5nLCB2aWE6ICducG0nIHwgJ3RneicpOiB2b2lkIHtcclxuICBob3N0LmxvZyhgaW5zdGFsbCBkb25lIHZpYSAke3ZpYX06ICR7ZW50cnl9YCk7XHJcbiAgaG9zdC5zZW5kUHJvZ3Jlc3MoeyBwaGFzZTogJ2RvbmUnLCB0ZXh0OiBgXHU1Qjg5XHU4OEM1XHU1QjhDXHU2MjEwKCR7dmlhfSlgLCBlbnRyeSB9KTtcclxuICBob3N0Lm9uSW5zdGFsbGVkKGVudHJ5LCB2aWEpO1xyXG4gIHJ1bm5pbmcgPSBmYWxzZTtcclxufVxyXG4iLCAiLyoqXHJcbiAqIEBobWhhcm5lc3MvY2xpIFx1NUI4OVx1ODhDNVx1NjgzOFx1NUZDMyhcdTdFQUZcdTkwM0JcdThGOTEsXHU5NkY2IElPIFx1MjAxNFx1MjAxNCBmZXRjaC9cdTg5RTNcdTUzOEIvXHU4NDNEXHU3NkQ4XHU1NzI4XHU0RTNCXHU4RkRCXHU3QTBCIGluc3RhbGxlciBcdTkxQ0MpXHUzMDAyXHJcbiAqXHJcbiAqIFx1ODA0Q1x1OEQyMyh2NS4xIFx1NUI4OVx1ODhDNVx1NTQxMVx1NUJGQyk6XHU3RUQ5XHU1QjlBIHJlZ2lzdHJ5IFx1NTE0M1x1NjU3MFx1NjM2RVx1ODNCN1x1NTNENlx1NTFGRFx1NjU3MCxcdTg5RTNcdTY3OTAgQGhtaGFybmVzcy9jbGkgXHU3Njg0XHJcbiAqIFx1NUI4Q1x1NjU3NFx1NEY5RFx1OEQ1Nlx1OTVFRFx1NTMwNShAaG1oYXJuZXNzLyogXHU1MTY4XHU1QkI2XHU0RTNBXHU3Q0JFXHU3ODZFXHU3MjQ4XHU2NzJDXHU0RTkyXHU5NDg5O1x1NTkxNlx1OTBFOFx1NEY5RFx1OEQ1NiBxcmNvZGUgXHU5NEZFXHU0RTNBIF4gXHU4MzAzXHU1NkY0KSxcclxuICogXHU0RUE3XHU1MUZBXCJcdTg4QzVcdTRFQzBcdTRFNDhcdTMwMDFcdTRFQ0VcdTU0RUFcdTRFOUJcdTk1NUNcdTUwQ0ZcdTRFMEJcdTMwMDFcdTg4QzVcdTUyMzBcdTU0RUFcIlx1NzY4NFx1Nzg2RVx1NUI5QVx1NjAyN1x1OEJBMVx1NTIxMlx1MzAwMlx1OEJCRVx1OEJBMVx1N0VBNlx1Njc1RjpcclxuICogIC0gXHU5NUVEXHU1MzA1XHU2MzA5XHU1MzA1XHU1NDBEXHU1M0JCXHU5MUNEKFx1OTRCQlx1NzdGM1x1NEY5RFx1OEQ1Nlx1NTNFQVx1ODhDNVx1NEUwMFx1NEVGRCxucG0gXHU4QkVEXHU0RTQ5KTtcclxuICogIC0gXHU4MzAzXHU1NkY0XHU4OUUzXHU2NzkwXHU1M0VBXHU2NTJGXHU2MzAxIG5wbSBcdTc1MUZcdTYwMDFcdTVCOUVcdTk2NDVcdTc1MjhcdTUyMzBcdTc2ODRcdTVGNjJcdTYwMDE6XHU3Q0JFXHU3ODZFIC8gbGF0ZXN0IC8gKiAvIF4gLyB+IC8gPj0sXHJcbiAqICAgIFx1NEUwRFx1NUYxNSBzZW12ZXIgXHU1RTkzKFx1OTZGNlx1NEY5RFx1OEQ1Nlx1NTM5Rlx1NTIxOSxcdTRFMEVcdTgxRUFcdTc4MTRcdTY2RjRcdTY1QjBcdTU2NjhcdTRFMDBcdTgxRjQpO1xyXG4gKiAgLSBvcHRpb25hbERlcGVuZGVuY2llcyBcdTRFMERcdTg4QzU6XHU5NUVEXHU1MzA1XHU1MTg1XHU1QjlFXHU5NjQ1XHU1OEYwXHU2NjBFXHU3Njg0IG9wdGlvbmFsIFx1NTc0N1x1NEUzQVx1NUU3M1x1NTNGMFx1NzI3OVx1NUI5QVxyXG4gKiAgICAoZnNldmVudHMgXHU3QjQ5KSx0Z3ogXHU4REVGXHU1Rjg0XHU0RTBEXHU4REQxXHU3NTFGXHU1NDdEXHU1NDY4XHU2NzFGXHU4MTFBXHU2NzJDLFx1ODhDNVx1NEU4Nlx1NEU1Rlx1NTNFQVx1NjYyRlx1NkI3Qlx1OTFDRFx1MzAwMlxyXG4gKi9cclxuaW1wb3J0IHsgY3JlYXRlSGFzaCB9IGZyb20gJ25vZGU6Y3J5cHRvJztcclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgUGtnVmVyc2lvbk1ldGEge1xyXG4gIHZlcnNpb246IHN0cmluZztcclxuICBkZXBlbmRlbmNpZXM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XHJcbiAgdGFyYmFsbDogc3RyaW5nO1xyXG4gIGludGVncml0eT86IHN0cmluZyB8IHVuZGVmaW5lZDtcclxufVxyXG5cclxuLyoqIHJlZ2lzdHJ5IHBhY2t1bWVudCBcdTc2ODRcdTY3MDBcdTVDMEZcdThCRkJcdTUzRDZcdTk3NjIoZGlzdC10YWdzICsgXHU1MTY4XHU3MjQ4XHU2NzJDXHU0RjlEXHU4RDU2L3RhcmJhbGwgXHU1MTQzXHU2NTcwXHU2MzZFKVx1MzAwMiAqL1xyXG5leHBvcnQgaW50ZXJmYWNlIFBhY2t1bWVudCB7XHJcbiAgJ2Rpc3QtdGFncyc6IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XHJcbiAgdmVyc2lvbnM6IFJlY29yZDxzdHJpbmcsIHsgZGVwZW5kZW5jaWVzPzogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB8IHVuZGVmaW5lZDsgZGlzdD86IHsgdGFyYmFsbD86IHN0cmluZzsgaW50ZWdyaXR5Pzogc3RyaW5nIHwgdW5kZWZpbmVkIH0gfCB1bmRlZmluZWQgfT47XHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgUmVzb2x2ZWRQa2cge1xyXG4gIG5hbWU6IHN0cmluZztcclxuICB2ZXJzaW9uOiBzdHJpbmc7XHJcbiAgLyoqIHJlZ2lzdHJ5IFx1NTM5Rlx1NTlDQlx1NTczMFx1NTc0MChcdTk1NUNcdTUwQ0ZcdTUyMTdcdTg4NjhcdTc1MzEgdGFyYmFsbE1pcnJvcnMgXHU2RDNFXHU3NTFGKVx1MzAwMiAqL1xyXG4gIHRhcmJhbGw6IHN0cmluZztcclxuICBpbnRlZ3JpdHk/OiBzdHJpbmcgfCB1bmRlZmluZWQ7XHJcbn1cclxuXHJcbi8qIC0tLS0gc2VtdmVyKFx1NjcwMFx1NUMwRlx1NUI5RVx1NzNCMDpcdTk1RURcdTUzMDVcdTUxODVcdTVCOUVcdTk2NDVcdTUxRkFcdTczQjBcdTc2ODRcdTVGNjJcdTYwMDEpIC0tLS0gKi9cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBjbXBTZW12ZXIoYTogc3RyaW5nLCBiOiBzdHJpbmcpOiBudW1iZXIge1xyXG4gIGNvbnN0IHBhID0gYS5yZXBsYWNlKC9edi8sICcnKS5zcGxpdCgnLScpWzBdIS5zcGxpdCgnLicpLm1hcChOdW1iZXIpO1xyXG4gIGNvbnN0IHBiID0gYi5yZXBsYWNlKC9edi8sICcnKS5zcGxpdCgnLScpWzBdIS5zcGxpdCgnLicpLm1hcChOdW1iZXIpO1xyXG4gIGZvciAobGV0IGkgPSAwOyBpIDwgMzsgaSsrKSB7XHJcbiAgICBjb25zdCB4ID0gcGFbaV0gPz8gMDtcclxuICAgIGNvbnN0IHkgPSBwYltpXSA/PyAwO1xyXG4gICAgaWYgKHggIT09IHkpIHJldHVybiB4IDwgeSA/IC0xIDogMTtcclxuICB9XHJcbiAgcmV0dXJuIDA7XHJcbn1cclxuXHJcbi8qKiByYW5nZSBcdTY2MkZcdTU0MjZcdTYzQTVcdTUzRDcgdmVyc2lvbihcdTY1MkZcdTYzMDEgXHU3Q0JFXHU3ODZFIC8gbGF0ZXN0IC8gKiAvIHggLyBeIC8gfiAvID49O1x1NEUwRFx1OEJDNlx1NTIyQlx1NTIxOSBmYWxzZSlcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHNhdGlzZmllcyhyYW5nZTogc3RyaW5nLCB2ZXJzaW9uOiBzdHJpbmcpOiBib29sZWFuIHtcclxuICBjb25zdCByID0gcmFuZ2UudHJpbSgpO1xyXG4gIGlmIChyID09PSAnJyB8fCByID09PSAnKicgfHwgciA9PT0gJ2xhdGVzdCcgfHwgciA9PT0gJ3gnKSByZXR1cm4gdHJ1ZTtcclxuICBpZiAociA9PT0gdmVyc2lvbikgcmV0dXJuIHRydWU7XHJcbiAgY29uc3QgYm91bmQgPSAvXihcXF58fnw+PT8pXFxzKihcXGQrKVxcLihcXGQrKVxcLihcXGQrKS8uZXhlYyhyKTtcclxuICBpZiAoYm91bmQgIT09IG51bGwpIHtcclxuICAgIGNvbnN0IG9wID0gYm91bmRbMV0hO1xyXG4gICAgY29uc3QgbWFqb3IgPSBOdW1iZXIoYm91bmRbMl0pO1xyXG4gICAgY29uc3QgbWlub3IgPSBOdW1iZXIoYm91bmRbM10pO1xyXG4gICAgY29uc3QgcGF0Y2ggPSBOdW1iZXIoYm91bmRbNF0pO1xyXG4gICAgY29uc3QgYyA9IGNtcFNlbXZlcih2ZXJzaW9uLCBgJHttYWpvcn0uJHttaW5vcn0uJHtwYXRjaH1gKTtcclxuICAgIGlmIChjIDwgMCkgcmV0dXJuIGZhbHNlO1xyXG4gICAgaWYgKG9wID09PSAnPj0nKSByZXR1cm4gdHJ1ZTsgLy8gJz49JyBcdTRFMEJcdTc1NENcdTUzNzNcdTUzRUY6XHU5NUVEXHU1MzA1XHU1MTg1XHU1M0VBXHU0RUU1ICc+PXgueS56IDx6JyBcdTU5MERcdTU0MDhcdTVGNjJcdTYwMDFcdTUxRkFcdTczQjAsXHU0RkREXHU1Qjg4XHU1M0Q2XHU0RTBCXHU3NTRDXHJcbiAgICBpZiAob3AgPT09ICd+JykgcmV0dXJuIGNtcFNlbXZlcih2ZXJzaW9uLCBgJHttYWpvcn0uJHttaW5vciArIDF9LjBgKSA8IDA7XHJcbiAgICAvLyAnXic6MC54IFx1NzI3OVx1NTIyNCgwLjIuMyBcdTUxNDFcdThCQjggMC4yLnopLFx1NTE3Nlx1NEY1OVx1OTUwMVx1NEUzQlx1NzI0OFx1NjcyQ1xyXG4gICAgaWYgKG1ham9yID09PSAwKSByZXR1cm4gbWlub3IgPT09IDAgPyBjbXBTZW12ZXIodmVyc2lvbiwgYDAuMC4ke3BhdGNoICsgMX1gKSA8IDAgOiBjbXBTZW12ZXIodmVyc2lvbiwgYDAuJHttaW5vciArIDF9LjBgKSA8IDA7XHJcbiAgICByZXR1cm4gY21wU2VtdmVyKHZlcnNpb24sIGAke21ham9yICsgMX0uMC4wYCkgPCAwO1xyXG4gIH1cclxuICByZXR1cm4gZmFsc2U7XHJcbn1cclxuXHJcbi8qKiBcdTRFQ0UgcGFja3VtZW50IFx1OTAwOVx1NTFGQSBzcGVjKFx1N0NCRVx1Nzg2RS9sYXRlc3QvXi9+LyopXHU2MzA3XHU1NDExXHU3Njg0XHU3MjQ4XHU2NzJDO1x1NjVFMFx1NTMzOVx1OTE0RFx1OEZENFx1NTZERSAnJ1x1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gcGlja1ZlcnNpb24oZG9jOiBQYWNrdW1lbnQsIHNwZWM6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgY29uc3QgcyA9IHNwZWMudHJpbSgpO1xyXG4gIGNvbnN0IHRhZyA9IHMgPT09ICcnIHx8IHMgPT09ICdsYXRlc3QnIHx8IHMgPT09ICcqJyA/IGRvY1snZGlzdC10YWdzJ10/LmxhdGVzdCA6IHVuZGVmaW5lZDtcclxuICBpZiAodGFnICE9PSB1bmRlZmluZWQgJiYgZG9jLnZlcnNpb25zW3RhZ10gIT09IHVuZGVmaW5lZCkgcmV0dXJuIHRhZztcclxuICBpZiAoZG9jLnZlcnNpb25zW3NdICE9PSB1bmRlZmluZWQpIHJldHVybiBzO1xyXG4gIGxldCBiZXN0ID0gJyc7XHJcbiAgZm9yIChjb25zdCB2IG9mIE9iamVjdC5rZXlzKGRvYy52ZXJzaW9ucykpIHtcclxuICAgIGlmIChzYXRpc2ZpZXMocywgdikgJiYgY21wU2VtdmVyKHYsIGJlc3QpID4gMCkgYmVzdCA9IHY7XHJcbiAgfVxyXG4gIHJldHVybiBiZXN0O1xyXG59XHJcblxyXG4vKiAtLS0tIFx1NEY5RFx1OEQ1Nlx1OTVFRFx1NTMwNSAtLS0tICovXHJcblxyXG4vKipcclxuICogXHU4OUUzXHU2NzkwIHJvb3QgXHU1M0NBXHU1MTc2XHU1MTY4XHU5MEU4XHU0RjIwXHU5MDEyXHU0RjlEXHU4RDU2KEJGUyxcdTYzMDlcdTUzMDVcdTU0MERcdTUzQkJcdTkxQ0RcdTUzRDZcdTk5OTZcdTRFMkFcdTg5RTNcdTY3OTBcdTdFRDNcdTY3OUMgXHUyMDE0XHUyMDE0IFx1NEUwRSBucG0gXHU2MjQxXHU1RTczXHJcbiAqIFx1NUUwM1x1NUM0MFx1NEUwMFx1ODFGNClcdTMwMDJnZXRQYWNrdW1lbnQgXHU3NTMxXHU4QzAzXHU3NTI4XHU2NUI5XHU2Q0U4XHU1MTY1KGZldGNoIFx1N0Y1MVx1N0VEQyAvIFx1NkQ0Qlx1OEJENVx1NkNFOFx1NTE2NVx1NUI1N1x1NTE3OClcdTMwMDJcclxuICogXHU0RUZCXHU0RTAwXHU0RjlEXHU4RDU2XHU2NUUwXHU2RUUxXHU4REIzXHU3MjQ4XHU2NzJDXHU2NUY2XHU2MjlCXHU5NTE5KFx1NUUyNlx1NTMwNVx1NTQwRFx1NEUwRSByYW5nZSxcdTk3NjJcdTU0MTFcdTVCODlcdTg4QzVcdTk4NzVcdTk1MTlcdThCRUZcdTY1ODdcdTY4NDgpXHUzMDAyXHJcbiAqL1xyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZUNsb3N1cmUoXHJcbiAgcm9vdDogeyBuYW1lOiBzdHJpbmc7IHNwZWM6IHN0cmluZyB9LFxyXG4gIGdldFBhY2t1bWVudDogKG5hbWU6IHN0cmluZykgPT4gUHJvbWlzZTxQYWNrdW1lbnQ+LFxyXG4pOiBQcm9taXNlPFJlc29sdmVkUGtnW10+IHtcclxuICBjb25zdCByZXNvbHZlZCA9IG5ldyBNYXA8c3RyaW5nLCBQa2dWZXJzaW9uTWV0YT4oKTtcclxuICBjb25zdCBxdWV1ZTogQXJyYXk8eyBuYW1lOiBzdHJpbmc7IHNwZWM6IHN0cmluZyB9PiA9IFtyb290XTtcclxuICB3aGlsZSAocXVldWUubGVuZ3RoID4gMCkge1xyXG4gICAgY29uc3QgeyBuYW1lLCBzcGVjIH0gPSBxdWV1ZS5zaGlmdCgpITtcclxuICAgIGlmIChyZXNvbHZlZC5oYXMobmFtZSkpIGNvbnRpbnVlOyAvLyBcdTVERjJcdTVCOUFcdTcyNDg6XHU1NDBFXHU3RUVEIHJhbmdlIFx1NUYxNVx1NzUyOFx1NEUwRFx1NTE4RFx1OTFDRFx1ODlFMyhucG0gXHU2MjQxXHU1RTczXHU4QkVEXHU0RTQ5KVxyXG4gICAgY29uc3QgZG9jID0gYXdhaXQgZ2V0UGFja3VtZW50KG5hbWUpO1xyXG4gICAgY29uc3QgdmVyc2lvbiA9IHBpY2tWZXJzaW9uKGRvYywgc3BlYyk7XHJcbiAgICBjb25zdCBtZXRhID0gdmVyc2lvbiAhPT0gJycgPyBkb2MudmVyc2lvbnNbdmVyc2lvbl0gOiB1bmRlZmluZWQ7XHJcbiAgICBpZiAobWV0YSA9PT0gdW5kZWZpbmVkIHx8IG1ldGEuZGlzdD8udGFyYmFsbCA9PT0gdW5kZWZpbmVkKSB7XHJcbiAgICAgIHRocm93IG5ldyBFcnJvcihgbm8gdmVyc2lvbiBvZiAke25hbWV9IHNhdGlzZmllcyAke3NwZWMgfHwgJ2xhdGVzdCd9YCk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBpdGVtOiBQa2dWZXJzaW9uTWV0YSA9IHtcclxuICAgICAgdmVyc2lvbixcclxuICAgICAgZGVwZW5kZW5jaWVzOiBtZXRhLmRlcGVuZGVuY2llcyA/PyB7fSxcclxuICAgICAgdGFyYmFsbDogbWV0YS5kaXN0LnRhcmJhbGwsXHJcbiAgICAgIGludGVncml0eTogbWV0YS5kaXN0LmludGVncml0eSxcclxuICAgIH07XHJcbiAgICByZXNvbHZlZC5zZXQobmFtZSwgaXRlbSk7XHJcbiAgICBmb3IgKGNvbnN0IFtkZXAsIHJhbmdlXSBvZiBPYmplY3QuZW50cmllcyhpdGVtLmRlcGVuZGVuY2llcykpIHtcclxuICAgICAgaWYgKCFyZXNvbHZlZC5oYXMoZGVwKSkgcXVldWUucHVzaCh7IG5hbWU6IGRlcCwgc3BlYzogcmFuZ2UgfSk7XHJcbiAgICB9XHJcbiAgfVxyXG4gIHJldHVybiBbLi4ucmVzb2x2ZWQuZW50cmllcygpXS5tYXAoKFtuYW1lLCBtXSkgPT4gKHsgbmFtZSwgdmVyc2lvbjogbS52ZXJzaW9uLCB0YXJiYWxsOiBtLnRhcmJhbGwsIGludGVncml0eTogbS5pbnRlZ3JpdHkgfSkpO1xyXG59XHJcblxyXG4vKiAtLS0tIFx1OTU1Q1x1NTBDRlx1NEUwRVx1NUUwM1x1NUM0MCAtLS0tICovXHJcblxyXG5jb25zdCBSRUdJU1RSWV9IT1NUUyA9IC9eKGh0dHBzPzpcXC9cXC9bXi9dKylcXC8oLiopJC87XHJcblxyXG4vKipcclxuICogdGFyYmFsbCBcdTc2ODRcdTk1NUNcdTUwQ0ZcdTUwMTlcdTkwMDkoXHU5ODdBXHU1RThGXHU1MzczXHU1NkRFXHU5MDAwXHU5ODdBXHU1RThGKTpcdTUzOUZcdTU5Q0JcdTU3MzBcdTU3NDAgXHUyMTkyIFx1NTQwNCByZWdpc3RyeSBcdTU0MENcdThERUZcdTVGODRcdTY1MzlcdTUxOTlcdTMwMDJcclxuICogcGFja3VtZW50IFx1OTFDQ1x1NzY4NCBkaXN0LnRhcmJhbGwgXHU2MDUyXHU2MzA3XHU1NDExXHU1M0QxXHU1RTAzXHU2RTkwKHJlZ2lzdHJ5Lm5wbWpzLm9yZyksXHU1NkZEXHU1MTg1XHU3RjUxXHU3RURDXHJcbiAqIFx1NEUwRFx1NTNFRlx1OEZCRVx1NjVGNlx1NjMwOSByZWdpc3RyeSBcdTUyMTdcdTg4NjhcdTY1MzlcdTUxOTkgaG9zdChcdThERUZcdTVGODRcdTRFMERcdTUzRDggXHUyMDE0XHUyMDE0IG5wbW1pcnJvciBcdTRFMEUgbnBtanMgXHU1NDBDXHU2Nzg0KVx1MzAwMlxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHRhcmJhbGxNaXJyb3JzKHRhcmJhbGw6IHN0cmluZywgcmVnaXN0cmllczogc3RyaW5nW10pOiBzdHJpbmdbXSB7XHJcbiAgY29uc3QgbSA9IFJFR0lTVFJZX0hPU1RTLmV4ZWModGFyYmFsbCk7XHJcbiAgY29uc3QgcGF0aCA9IG0/LlsyXSA/PyAnJztcclxuICBjb25zdCBvdXQgPSBbdGFyYmFsbF07XHJcbiAgZm9yIChjb25zdCByZWcgb2YgcmVnaXN0cmllcykge1xyXG4gICAgY29uc3QgYmFzZSA9IHJlZy5yZXBsYWNlKC9cXC8rJC8sICcnKTtcclxuICAgIGlmIChiYXNlID09PSBtPy5bMV0pIGNvbnRpbnVlO1xyXG4gICAgY29uc3QgdSA9IGAke2Jhc2V9LyR7cGF0aH1gO1xyXG4gICAgaWYgKCFvdXQuaW5jbHVkZXModSkpIG91dC5wdXNoKHUpO1xyXG4gIH1cclxuICByZXR1cm4gb3V0O1xyXG59XHJcblxyXG4vKiogXHU1MzA1XHU1NzI4IG5vZGVfbW9kdWxlcyBcdTRFMEJcdTc2ODRcdTc2RUVcdTY4MDdcdTc2RUVcdTVGNTUoc2NvcGVkIFx1NTMwNVx1NEZERFx1NjMwMSBAc2NvcGUvbmFtZSBcdTRFMjRcdTdFQTcpXHUzMDAyICovXHJcbmV4cG9ydCBmdW5jdGlvbiBtb2R1bGVEaXIocHJlZml4OiBzdHJpbmcsIG5hbWU6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgY29uc3QgcGFydHMgPSBuYW1lLnNwbGl0KCcvJykuZmlsdGVyKChwKSA9PiBwICE9PSAnJyAmJiBwICE9PSAnLicpO1xyXG4gIGlmIChuYW1lLnN0YXJ0c1dpdGgoJ0AnKSAmJiBwYXJ0cy5sZW5ndGggIT09IDIpIHRocm93IG5ldyBFcnJvcihgaW52YWxpZCBwYWNrYWdlIG5hbWU6ICR7bmFtZX1gKTtcclxuICBpZiAoIW5hbWUuc3RhcnRzV2l0aCgnQCcpICYmIHBhcnRzLmxlbmd0aCAhPT0gMSkgdGhyb3cgbmV3IEVycm9yKGBpbnZhbGlkIHBhY2thZ2UgbmFtZTogJHtuYW1lfWApO1xyXG4gIHJldHVybiBbLi4ucGFydHNdLnJlZHVjZSgoZGlyLCBwKSA9PiBgJHtkaXJ9XFxcXCR7cH1gLCBgJHtwcmVmaXh9XFxcXG5vZGVfbW9kdWxlc2ApO1xyXG59XHJcblxyXG4vKiAtLS0tIGludGVncml0eSAtLS0tICovXHJcblxyXG4vKiogbnBtIGRpc3QuaW50ZWdyaXR5KCdzaGE1MTItYmFzZTY0JykgXHU2ODIxXHU5QThDO1x1NEUwRFx1NTMzOVx1OTE0RFx1OEZENFx1NTZERSBmYWxzZShcdTY3MkFcdTc3RTVcdTdCOTdcdTZDRDVcdThGRDRcdTU2REUgdHJ1ZSBcdTY1M0VcdTg4NEMpXHUzMDAyICovXHJcbmV4cG9ydCBmdW5jdGlvbiBpbnRlZ3JpdHlPayhkYXRhOiBCdWZmZXIsIGludGVncml0eT86IHN0cmluZyk6IGJvb2xlYW4ge1xyXG4gIGlmIChpbnRlZ3JpdHkgPT09IHVuZGVmaW5lZCB8fCBpbnRlZ3JpdHkgPT09ICcnKSByZXR1cm4gdHJ1ZTtcclxuICBjb25zdCBtID0gL15zaGE1MTItKFtBLVphLXowLTkrLz1dKykkLy5leGVjKGludGVncml0eS50cmltKCkpO1xyXG4gIGlmIChtID09PSBudWxsKSByZXR1cm4gdHJ1ZTtcclxuICByZXR1cm4gY3JlYXRlSGFzaCgnc2hhNTEyJykudXBkYXRlKGRhdGEpLmRpZ2VzdCgnYmFzZTY0JykgPT09IG1bMV07XHJcbn1cclxuXHJcbi8qKiBcdTRFQkFcdTdDN0JcdTUzRUZcdThCRkJcdTVCNTdcdTgyODIoXHU1Qjg5XHU4OEM1XHU4RkRCXHU1RUE2XHU2NTg3XHU2ODQ4XHU3NTI4KVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gYnl0ZXNMYWJlbChuOiBudW1iZXIpOiBzdHJpbmcge1xyXG4gIGlmIChuIDwgMTAyNCkgcmV0dXJuIGAke259IEJgO1xyXG4gIGlmIChuIDwgMTAyNCAqIDEwMjQpIHJldHVybiBgJHsobiAvIDEwMjQpLnRvRml4ZWQoMCl9IEtCYDtcclxuICByZXR1cm4gYCR7KG4gLyAxMDI0IC8gMTAyNCkudG9GaXhlZCgxKX0gTUJgO1xyXG59XHJcbiIsICIvKipcbiAqIFx1NjZGNFx1NjVCMFx1NTY2OFx1OTAxQVx1OTA1M1x1N0VBRlx1OTAzQlx1OEY5MSgyMDI2LTEwLTI5IFx1NzUyOFx1NjIzN1x1NTNDRFx1OTk4OFx1NjgzOVx1NkNCQjpcdTU2RkRcdTUxODVcdTc1MjhcdTYyMzdcdTY1MzZcdTRFMERcdTUyMzBcdTY2RjRcdTY1QjBcdTYzQThcdTkwMDEpXHUzMDAyXG4gKlxuICogXHU4MENDXHU2NjZGOlx1NjhDMFx1NjdFNVx1OTAxQVx1OTA1M1x1NTM5Rlx1NjcyQ1x1NTNFQVx1OEQ3MCBhcGkuZ2l0aHViLmNvbSBcdTc2RjRcdThGREUoMTVzIFx1OEQ4NVx1NjVGNiksXHU1NkZEXHU1MTg1XHU2NUUwXHU0RUUzXHU3NDA2XHU3RjUxXHU3RURDXHU1RkM1XG4gKiBcdThEODVcdTY1RjYgXHUyMTkyIGNoZWNrIGZhaWxlZCBcdTIxOTIgXHU3NTI4XHU2MjM3XHU2QzM4XHU4RkRDXHU3NzBCXHU0RTBEXHU1MjMwXHU2NUIwXHU3MjQ4XHU2NzJDO1x1NEUwQlx1OEY3RFx1OTAxQVx1OTA1M1x1NTNDRFx1ODAwQ1x1NjcwOVx1OTU1Q1x1NTBDRlx1NTZERVx1OTAwMFx1OTRGRVx1MzAwMlxuICogXHU2NzJDXHU2QTIxXHU1NzU3XHU3RUQ5XHU1MUZBXHU0RTA5XHU2NzYxXHU3RUFGXHU4OUM0XHU1MjE5KG1haW4gXHU4RkRCXHU3QTBCXHU0RTBFIHNjcmlwdHMvc2ltLXVwZGF0ZXIubWpzIFx1NTE3MVx1NzUyOCxcdTUzNTVcdTZENEJcdTg5ODZcdTc2RDYpOlxuICogIDEpIFx1NjhDMFx1NjdFNVx1OTAxQVx1OTA1M1x1OTRGRTpcdTc2RjRcdThGREUoOHMsXHU1NkZEXHU1OTE2XHU3OUQyXHU4RkM3KVx1MjE5MiBnaC1wcm94eSBcdTIxOTIgZ2hmYXN0LFx1OTAxMFx1NEUyQVx1OEJENVx1NTIzMFx1NjJGRlx1NTIzMCBKU09OO1xuICogIDIpIFx1OTAxQVx1OTA1M1x1N0M5OFx1NjAyNzpcdTRFMEFcdTZCMjFcdTU0N0RcdTRFMkRcdTc2ODRcdTkwMUFcdTkwNTNcdTRGMThcdTUxNDgsXHU1OTMxXHU4RDI1XHU1MThEXHU1NkRFXHU5MDAwXHU1MTY4XHU5NEZFO1xuICogIDMpIFx1NEUwQlx1OEY3RFx1NTQwQ1x1NkU5MFx1NEYxOFx1NTE0ODpcdTRFMEVcdTU0N0RcdTRFMkRcdTc2ODRcdTY4QzBcdTY3RTVcdTkwMUFcdTkwNTNcdTU0MENcdTZFOTBcdTc2ODRcdTk1NUNcdTUwQ0ZcdTUxNDhcdThCRDUsXHU1MThEXHU3NkY0XHU4RkRFXHU0RTBFXHU1MTc2XHU0RjU5XHU5NTVDXHU1MENGXHUzMDAyXG4gKiBcdTY1RTAgZWxlY3Ryb24gXHU0RjlEXHU4RDU2KFx1NTNFRlx1ODhBQiBub2RlIC0taW1wb3J0IHRzeCBcdTc2ODRcdTZENEJcdThCRDUvXHU2QTIxXHU2MkRGXHU4MTFBXHU2NzJDXHU3NkY0XHU2M0E1IGltcG9ydClcdTMwMDJcbiAqL1xuXG5leHBvcnQgdHlwZSBVcGRhdGVDaGFubmVsSWQgPSAnZGlyZWN0JyB8ICdnaC1wcm94eScgfCAnZ2hmYXN0JztcblxuZXhwb3J0IGludGVyZmFjZSBDaGVja0NoYW5uZWwge1xuICBpZDogVXBkYXRlQ2hhbm5lbElkO1xuICAvKiogXHU4QkNBXHU2NUFEL1VJIFx1NjYzRVx1NzkzQVx1NTQwRChcdTk1MTlcdThCRUZcdTRGRTFcdTYwNkZcdTkxQ0NcdTkwMTBcdTkwMUFcdTkwNTNcdTUzRUZcdTg5QzEpXHUzMDAyICovXG4gIGxhYmVsOiBzdHJpbmc7XG4gIC8qKiBcdTUzNTVcdTkwMUFcdTkwNTNcdThEODVcdTY1RjY6XHU3NkY0XHU4RkRFIDhzKFx1NTZGRFx1NTkxNlx1NzlEMlx1OEZDN1x1MzAwMVx1NTZGRFx1NTE4NVx1NUZFQlx1OTAxRlx1OEJBOVx1NEY0RFx1OTU1Q1x1NTBDRiksXHU5NTVDXHU1MENGIDEwc1x1MzAwMiAqL1xuICB0aW1lb3V0TXM6IG51bWJlcjtcbiAgYXBpVXJsOiAocmVwbzogc3RyaW5nKSA9PiBzdHJpbmc7XG4gIC8qKiBcdTRFMEJcdThGN0RcdTk1NUNcdTUwQ0ZcdTUyNERcdTdGMDAoJycgPSBcdTc2RjRcdThGREUgYXNzZXQgdXJsKTtcdTk4N0JcdTU3MjggRE9XTkxPQURfTUlSUk9SX1BSRUZJWEVTIFx1NkUwNVx1NTM1NVx1NTE4NVx1MzAwMiAqL1xuICBkb3dubG9hZFByZWZpeDogc3RyaW5nO1xufVxuXG5jb25zdCBnaXRodWJMYXRlc3QgPSAocmVwbzogc3RyaW5nKTogc3RyaW5nID0+IGBodHRwczovL2FwaS5naXRodWIuY29tL3JlcG9zLyR7cmVwb30vcmVsZWFzZXMvbGF0ZXN0YDtcblxuLyoqIFx1NjhDMFx1NjdFNVx1OTAxQVx1OTA1M1x1OTRGRShcdTlFRDhcdThCQTRcdTk4N0FcdTVFOEYpXHUzMDAyICovXG5leHBvcnQgY29uc3QgQ0hFQ0tfQ0hBTk5FTFM6IHJlYWRvbmx5IENoZWNrQ2hhbm5lbFtdID0gW1xuICB7IGlkOiAnZGlyZWN0JywgbGFiZWw6ICdcdTc2RjRcdThGREUnLCB0aW1lb3V0TXM6IDhfMDAwLCBhcGlVcmw6IGdpdGh1YkxhdGVzdCwgZG93bmxvYWRQcmVmaXg6ICcnIH0sXG4gIHsgaWQ6ICdnaC1wcm94eScsIGxhYmVsOiAnZ2gtcHJveHknLCB0aW1lb3V0TXM6IDEwXzAwMCwgYXBpVXJsOiAocmVwbykgPT4gYGh0dHBzOi8vZ2gtcHJveHkuY29tLyR7Z2l0aHViTGF0ZXN0KHJlcG8pfWAsIGRvd25sb2FkUHJlZml4OiAnaHR0cHM6Ly9naC1wcm94eS5jb20vJyB9LFxuICB7IGlkOiAnZ2hmYXN0JywgbGFiZWw6ICdnaGZhc3QnLCB0aW1lb3V0TXM6IDEwXzAwMCwgYXBpVXJsOiAocmVwbykgPT4gYGh0dHBzOi8vZ2hmYXN0LnRvcC8ke2dpdGh1YkxhdGVzdChyZXBvKX1gLCBkb3dubG9hZFByZWZpeDogJ2h0dHBzOi8vZ2hmYXN0LnRvcC8nIH0sXG5dO1xuXG4vKiogXHU0RTBCXHU4RjdEXHU5NTVDXHU1MENGXHU1MTY4XHU2RTA1XHU1MzU1KFx1OUVEOFx1OEJBNFx1OTg3QVx1NUU4RjtnaHByb3h5LmNuIFx1NEVDNVx1NEUwQlx1OEY3RFx1NTE1Q1x1NUU5NSxcdTRFMERcdTUwNUFcdTY4QzBcdTY3RTVcdTkwMUFcdTkwNTMpXHUzMDAyICovXG5leHBvcnQgY29uc3QgRE9XTkxPQURfTUlSUk9SX1BSRUZJWEVTOiByZWFkb25seSBzdHJpbmdbXSA9IFsnJywgJ2h0dHBzOi8vZ2hmYXN0LnRvcC8nLCAnaHR0cHM6Ly9naC1wcm94eS5jb20vJywgJ2h0dHBzOi8vZ2hwcm94eS5jbi8nXTtcblxuLyoqIFx1NUI1OFx1NTBBOFx1NTAzQy9JUEMgXHU1MDNDXHU1RjUyXHU0RTAwOlx1NTQwOFx1NkNENVx1OTAxQVx1OTA1MyBpZCBcdTYyMTYgbnVsbChcdTdDOThcdTYwMjdcdTY1ODdcdTRFRjZcdTYzNUZcdTU3NEYvXHU2NUU3XHU3MjQ4XHU2NzJDXHU2QjhCXHU3NTU5XHU2NUY2XHU0RTBEXHU4MUY0XHU1NDdEKVx1MzAwMiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZUNoYW5uZWwodjogdW5rbm93bik6IFVwZGF0ZUNoYW5uZWxJZCB8IG51bGwge1xuICByZXR1cm4gdHlwZW9mIHYgPT09ICdzdHJpbmcnICYmIENIRUNLX0NIQU5ORUxTLnNvbWUoKGMpID0+IGMuaWQgPT09IHYpID8gKHYgYXMgVXBkYXRlQ2hhbm5lbElkKSA6IG51bGw7XG59XG5cbi8qKiBcdTdDOThcdTYwMjdcdTYzOTJcdTVFOEY6XHU0RTBBXHU2QjIxXHU1NDdEXHU0RTJEXHU5MDFBXHU5MDUzXHU0RjE4XHU1MTQ4LFx1NTE3Nlx1NEY1OVx1NEZERFx1NjMwMVx1OUVEOFx1OEJBNFx1OTRGRVx1NUU4RihcdTRFRkJcdTRFMDBcdTkwMUFcdTkwNTNcdTU5MzFcdThEMjVcdTRFQ0RcdTUzRUZcdTUxNjhcdTk0RkVcdTU2REVcdTkwMDApXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gb3JkZXJlZENoZWNrQ2hhbm5lbHMoc3RpY2t5OiB1bmtub3duKTogcmVhZG9ubHkgQ2hlY2tDaGFubmVsW10ge1xuICBjb25zdCBzID0gbm9ybWFsaXplQ2hhbm5lbChzdGlja3kpO1xuICBjb25zdCBmaXJzdCA9IHMgPT09IG51bGwgPyB1bmRlZmluZWQgOiBDSEVDS19DSEFOTkVMUy5maW5kKChjKSA9PiBjLmlkID09PSBzKTtcbiAgaWYgKGZpcnN0ID09PSB1bmRlZmluZWQpIHJldHVybiBDSEVDS19DSEFOTkVMUztcbiAgcmV0dXJuIFtmaXJzdCwgLi4uQ0hFQ0tfQ0hBTk5FTFMuZmlsdGVyKChjKSA9PiBjLmlkICE9PSBzKV07XG59XG5cbi8qKiBcdTRFMEJcdThGN0RcdTk1NUNcdTUwQ0ZcdTk4N0FcdTVFOEY6XHU1NDdEXHU0RTJEXHU2OEMwXHU2N0U1XHU5MDFBXHU5MDUzXHU3Njg0XHU1NDBDXHU2RTkwXHU5NTVDXHU1MENGXHU0RjE4XHU1MTQ4IFx1MjE5MiBcdTc2RjRcdThGREUgXHUyMTkyIFx1NTE3Nlx1NEY1OVx1OTU1Q1x1NTBDRihcdTUzQkJcdTkxQ0QsNCBcdTkwMUFcdTkwNTNcdTZFMDVcdTUzNTVcdTRGRERcdTc1NTkpXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gb3JkZXJlZERvd25sb2FkTWlycm9ycyhhc3NldFVybDogc3RyaW5nLCBjaGFubmVsOiB1bmtub3duKTogcmVhZG9ubHkgc3RyaW5nW10ge1xuICBjb25zdCBoaXQgPSBub3JtYWxpemVDaGFubmVsKGNoYW5uZWwpO1xuICBjb25zdCBwcmVmaXggPSBoaXQgPT09IG51bGwgPyAnJyA6IENIRUNLX0NIQU5ORUxTLmZpbmQoKGMpID0+IGMuaWQgPT09IGhpdCk/LmRvd25sb2FkUHJlZml4ID8/ICcnO1xuICBjb25zdCBwcmVmaXhlcyA9IFsuLi5uZXcgU2V0KFtwcmVmaXgsIC4uLkRPV05MT0FEX01JUlJPUl9QUkVGSVhFU10pXTtcbiAgcmV0dXJuIHByZWZpeGVzLm1hcCgocCkgPT4gKHAgPT09ICcnID8gYXNzZXRVcmwgOiBgJHtwfSR7YXNzZXRVcmx9YCkpO1xufVxuXG4vKiogXHU1MTY4XHU5MDFBXHU5MDUzXHU1OTMxXHU4RDI1XHU3Njg0XHU5NTE5XHU4QkVGXHU0RTMyOlx1OTAxMFx1OTAxQVx1OTA1M1x1NTIxN1x1NTFGQVx1NTM5Rlx1NTZFMChcdTdGNTFcdTdFRENcdThCQ0FcdTY1QURcdTc1Mjg7VUkgXHU2NkY0XHU2NUIwXHU5NzYyXHU2NzdGXHU3MTY3XHU1RTM4XHU2NjNFXHU3OTNBKVx1MzAwMiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN1bW1hcml6ZUNoZWNrRmFpbHVyZXMoZmFpbHVyZXM6IFJlYWRvbmx5QXJyYXk8eyBsYWJlbDogc3RyaW5nOyByZWFzb246IHN0cmluZyB9Pik6IHN0cmluZyB7XG4gIHJldHVybiBmYWlsdXJlcy5tYXAoKGYpID0+IGAke2YubGFiZWx9OiR7Zi5yZWFzb259YCkuam9pbignOyAnKTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICI7QUFjQSxTQUFTLE9BQUFBLE1BQUssZUFBZSxRQUFRLFNBQVMsU0FBUyxPQUFPLE1BQU0sY0FBYyxNQUFNLGFBQWEsbUJBQW1CO0FBQ3hILFNBQVMsUUFBQUMsT0FB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QUFRLEVBQUUsUUFBUSxFQUFFO0FBQUEsSUFDakcsQ0FBQztBQUVELFFBQUksU0FBUztBQUNiLGVBQVcsQ0FBQyxNQUFNLElBQUksTUFBTSxLQUFLLFNBQVM7QUFDeEMsY0FBUSxJQUFJLGlCQUFpQixLQUFLLFNBQVMsTUFBTSxNQUFNLElBQUksTUFBTSxPQUFPLE1BQU0sQ0FBQyxFQUFFO0FBQ2pGLFVBQUksQ0FBQyxHQUFJLFdBQVU7QUFBQSxJQUNyQjtBQUNBLFlBQVEsSUFBSSw4QkFBOEIsUUFBUSxTQUFTLE1BQU0sSUFBSSxRQUFRLE1BQU0sRUFBRTtBQUNyRixJQUFBQSxLQUFJLEtBQUssV0FBVyxJQUFJLElBQUksQ0FBQztBQUFBLEVBQy9CO0FBR0EsRUFBQUEsS0FBSSxHQUFHLGVBQWUsQ0FBQyxNQUFNO0FBQzNCLFFBQUksZUFBZSxRQUFRLFdBQVcsVUFBVSxXQUFXO0FBQ3pELFFBQUUsZUFBZTtBQUNqQixnQkFBVSxNQUFNO0FBQ2hCLFdBQUssV0FBVyxLQUFLLEVBQUUsUUFBUSxNQUFNQSxLQUFJLEtBQUssQ0FBQztBQUFBLElBQ2pEO0FBQUEsRUFDRixDQUFDO0FBQ0QsRUFBQUEsS0FBSSxHQUFHLHFCQUFxQixNQUFNO0FBQ2hDLFFBQUksUUFBUSxhQUFhLFNBQVUsQ0FBQUEsS0FBSSxLQUFLO0FBQUEsRUFDOUMsQ0FBQztBQUNIO0FBcjZDVztBQXlCQTtBQU9BO0FBZUE7QUE0QkE7QUEySEE7QUFtQkE7QUE0QkE7QUE0REE7QUFVQTtBQWdCQTtBQWdCQTtBQWVBO0FBMkVBO0FBT0E7QUFRQTtBQVdBO0FBa0VBO0FBS0E7QUFpQkE7QUFLQTtBQVlBO0FBb0JBO0FBb0hBO0FBWUE7QUFXQTsiLAogICJuYW1lcyI6IFsiYXBwIiwgImpvaW4iLCAiZXhpc3RzU3luYyIsICJyZWFscGF0aFN5bmMiLCAid3JpdGVGaWxlIiwgImhvbWVkaXIiLCAic3Bhd24iLCAicGF0aFRvRmlsZVVSTCIsICJyZXNvbHZlIiwgInJhbmRvbVVVSUQiLCAicmFuZG9tVVVJRCIsICJyZXNvbHZlIiwgImFwcCIsICJta2RpciIsICJ3cml0ZUZpbGUiLCAiam9pbiIsICJzbGVlcCIsICJzcGF3biIsICJqb2luIiwgImpvaW4iLCAicmVzb2x2ZSIsICJzcGF3biIsICJqb2luIiwgImpvaW4iLCAiYXBwIiwgInB1c2hFdmVudCIsICJub3RpZnlFdmVudCIsICJmb2N1c01haW5XaW5kb3ciLCAic2V0dXBUcmF5IiwgImFwcGx5Q2hyb21lIiwgImFwcGx5VXBkYXRlIiwgInNwYXduIiwgImJ1aWxkQXBwTWVudSIsICJwb3B1cE1haW5NZW51IiwgIndlYkF1dG9zdGFydEluc3RhbGxlZCIsICJleGlzdHNTeW5jIiwgImxhbklwT2YiLCAiY2xpRW50cnlPZiIsICJyZXBvUm9vdE9mIiwgInBrZ05hbWVBdCIsICJydW5DbGkiLCAiYnJvYWRjYXN0SG9zdFN0YXRlIiwgInBrZ1ZlcnNpb25BdCIsICJlbnRyeUZyb21DbGlEaXIiLCAiZGV0ZWN0RXh0ZXJuYWxSdW50aW1lIiwgInJlYWxwYXRoU3luYyIsICJob21lZGlyIiwgImRldGVjdFJlYWxFbnRyeSIsICJidW5kbGVkUnVudGltZVBhdGgiLCAiYnVuZGxlZFJ1bnRpbWVJbmZvIiwgIm5wbU9uUGF0aCIsICJ3aXphcmRTdXBwcmVzc2VkIiwgInNlbmRlclRydXN0ZWQiLCAiaG9zdENhbGwiLCAicmVnaXN0ZXJJcGMiLCAid3JpdGVGaWxlIiwgInciLCAicGF0aFRvRmlsZVVSTCIsICJhcHAyIl0KfQo=
