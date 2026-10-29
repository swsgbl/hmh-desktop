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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vZWxlY3Ryb24vbWFpbi9pbmRleC50cyIsICIuLi8uLi8uLi8uLi9wYWNrYWdlcy9ob3N0LWFkYXB0ZXIvc3JjL3N1cGVydmlzb3IudHMiLCAiLi4vLi4vLi4vLi4vcGFja2FnZXMvY29udHJhY3RzL3NyYy9ldmVudC50cyIsICIuLi8uLi8uLi8uLi9wYWNrYWdlcy9jb250cmFjdHMvc3JjL2Vycm9yLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2NvbnRyYWN0cy9zcmMvZ3VhcmRzLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2hvc3QtYWRhcHRlci9zcmMvY2xpZW50LnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2hvc3QtYWRhcHRlci9zcmMvZmFrZS1ob3N0LnRzIiwgIi4uLy4uL2VsZWN0cm9uL21haW4vdWl2ZXJpZnkudHMiLCAiLi4vLi4vZWxlY3Ryb24vbWFpbi92aXN1YWxyZWdyZXNzaW9uLnRzIiwgIi4uLy4uL2VsZWN0cm9uL21haW4vaW5zdGFsbGVyLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2NsaS1pbnN0YWxsZXIvc3JjL2luZGV4LnRzIiwgIi4uLy4uL2VsZWN0cm9uL21haW4vdXBkYXRlci1jaGFubmVscy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXHJcbiAqIEhNSCBEZXNrdG9wIFx1MjAxNCBFbGVjdHJvbiBcdTRFM0JcdThGREJcdTdBMEIoQURSLTAwMS8wMDMvMDA0KVx1MzAwMlxyXG4gKlxyXG4gKiBcdTVCODlcdTUxNjhcdTRFMERcdTUzRDhcdTkxQ0YoXHU1RjAwXHU1M0QxXHU4QkExXHU1MjEyIE0wIFx1NTFGQVx1NTNFM1x1OTVFOCArIEVsZWN0cm9uIFx1NUI5OFx1NjVCOVx1NUI4OVx1NTE2OFx1NkUwNVx1NTM1NSk6XHJcbiAqICAtIHJlbmRlcmVyOmNvbnRleHRJc29sYXRpb24gKyBzYW5kYm94ICsgXHU3OTgxIG5vZGVJbnRlZ3JhdGlvbixcdTRFMjVcdTY4M0MgQ1NQO1xyXG4gKiAgLSBcdTVCRkNcdTgyMkEvXHU2NUIwXHU3QTk3XHU1M0UzXHU0RTAwXHU1RjhCXHU2MkQyXHU3RUREKFx1NTNFQVx1NTJBMFx1OEY3RFx1NjIxMVx1NEVFQ1x1ODFFQVx1NURGMVx1NzY4NCByZW5kZXJlcik7XHJcbiAqICAtIFx1NkJDRlx1Njc2MSBJUEMgXHU2ODIxXHU5QThDIHNlbmRlciBcdTc2ODRcdTk4NzZcdTVDNDIgZnJhbWUgVVJMIFx1NUM1RVx1NEU4RVx1NjcyQ1x1NUU5NFx1NzUyOCxcdTkwMUFcdTkwNTNcdTc2N0RcdTU0MERcdTUzNTU7XHJcbiAqICAtIGhvc3QgdG9rZW4gXHU1M0VBXHU1QjU4XHU1NzI4XHU0RThFXHU2NzJDXHU4RkRCXHU3QTBCXHU0RTBFXHU1QjUwXHU4RkRCXHU3QTBCIGVudixcdTY1RTVcdTVGRDdcdThGOTNcdTUxRkFcdTUyNERcdTUxNDhcdTgxMzFcdTY1NEY7XHJcbiAqICAtIFx1NTM1NVx1NUI5RVx1NEY4Qlx1OTUwMTtcdTkwMDBcdTUxRkFcdTY1RjZcdTUzRUFcdTUwNUNcdTZCNjJcdTgxRUFcdTVERjEgc3Bhd24gXHU3Njg0IGhvc3QoXHU0RjE4XHU5NkM1XHUyMTkyXHU1MTVDXHU1RTk1IGtpbGwpXHUzMDAyXHJcbiAqXHJcbiAqIFx1OTYzNlx1NkJCNUUoMjAyNi0xMC0xMCk6bWFpbiBcdTYzMDFcdTY3MDkgRGVza3RvcEhvc3RDbGllbnQsU1NFIFx1NEZFMVx1NUMwMVx1NkQ0MShldmVudDogaG1oKVxyXG4gKiBcdTdFQ0YgNTBtcyBcdTYyNzlcdTkxQ0ZcdTYzQThcdTdFRDkgcmVuZGVyZXI7c2VuZFRhc2svYXBwcm92ZS9pbnRlcnJ1cHQvc2Vzc2lvbnMgXHU1MTY4XHU5MEU4XHU4RjZDXHU1M0QxXHJcbiAqIFx1N0VEOSBob3N0IFx1MjAxNFx1MjAxNCBmYWtlIFx1NEUwRVx1NzcxRlx1NUI5RSBobWhhcm5lc3MgZGVza3RvcC1ob3N0IFx1OEQ3MFx1NTQwQ1x1NEUwMFx1Njc2MVx1NEVFM1x1NzgwMVx1OERFRlx1NUY4NFx1MzAwMlxyXG4gKi9cclxuaW1wb3J0IHsgYXBwLCBCcm93c2VyV2luZG93LCBkaWFsb2csIGlwY01haW4sIHNlc3Npb24sIHNoZWxsLCBUcmF5LCBOb3RpZmljYXRpb24sIE1lbnUsIG5hdGl2ZUltYWdlLCBuYXRpdmVUaGVtZSB9IGZyb20gJ2VsZWN0cm9uJztcclxuaW1wb3J0IHsgam9pbiwgZGlybmFtZSwgYmFzZW5hbWUsIGlzQWJzb2x1dGUsIHJlc29sdmUgfSBmcm9tICdub2RlOnBhdGgnO1xyXG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFscGF0aFN5bmMsIHJlYWRGaWxlU3luYyB9IGZyb20gJ25vZGU6ZnMnO1xyXG5pbXBvcnQgeyB3cml0ZUZpbGUsIHJlYWRGaWxlIH0gZnJvbSAnbm9kZTpmcy9wcm9taXNlcyc7XHJcbmltcG9ydCB7IGhvbWVkaXIsIG5ldHdvcmtJbnRlcmZhY2VzIH0gZnJvbSAnbm9kZTpvcyc7XHJcbmltcG9ydCB7IGV4ZWNGaWxlU3luYywgc3Bhd24gfSBmcm9tICdub2RlOmNoaWxkX3Byb2Nlc3MnO1xyXG5pbXBvcnQgeyBwYXRoVG9GaWxlVVJMIH0gZnJvbSAnbm9kZTp1cmwnO1xyXG5pbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSAnbm9kZTpjcnlwdG8nO1xyXG5pbXBvcnQgeyBEZXNrdG9wUnVudGltZVN1cGVydmlzb3IsIERlc2t0b3BIb3N0Q2xpZW50LCBlbnZlbG9wZUZyb21GcmFtZSwgdHlwZSBIb3N0U3RhdGUgfSBmcm9tICdAaG1oLWRlc2t0b3AvaG9zdC1hZGFwdGVyJztcclxuaW1wb3J0IHsgaXNFdmVudEVudmVsb3BlLCB0eXBlIEV2ZW50RW52ZWxvcGUgfSBmcm9tICdAaG1oLWRlc2t0b3AvY29udHJhY3RzJztcclxuaW1wb3J0IHsgYXR0YWNoVWlWZXJpZnkgfSBmcm9tICcuL3VpdmVyaWZ5LnRzJztcclxuaW1wb3J0IHsgYXR0YWNoVmlzdWFsUmVncmVzc2lvbiB9IGZyb20gJy4vdmlzdWFscmVncmVzc2lvbi50cyc7XHJcbmltcG9ydCB7IGluc3RhbGxUYXJnZXQsIHJlc29sdmVJbnN0YWxsZWRFbnRyeSwgc3RhcnRDbGlJbnN0YWxsLCB0eXBlIEluc3RhbGxQcm9ncmVzcyB9IGZyb20gJy4vaW5zdGFsbGVyLnRzJztcclxuaW1wb3J0IHsgb3JkZXJlZENoZWNrQ2hhbm5lbHMsIG9yZGVyZWREb3dubG9hZE1pcnJvcnMsIG5vcm1hbGl6ZUNoYW5uZWwsIHN1bW1hcml6ZUNoZWNrRmFpbHVyZXMsIHR5cGUgVXBkYXRlQ2hhbm5lbElkIH0gZnJvbSAnLi91cGRhdGVyLWNoYW5uZWxzLnRzJztcclxuXHJcbmNvbnN0IGhlcmUgPSBpbXBvcnQubWV0YS5kaXJuYW1lID8/ICcuJztcclxuY29uc3QgaXNEZXYgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9ERVYgPT09ICcxJztcclxuY29uc3QgcmVuZGVyZXJEZXZVcmwgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9SRU5ERVJFUl9VUkwgPz8gJyc7XHJcbmNvbnN0IHByZWxvYWRQYXRoID0gam9pbihoZXJlLCAnLi4vcHJlbG9hZC9pbmRleC5janMnKTtcclxuXHJcbi8qIC0tLS0gXHU2NUU1XHU1RkQ3XHU4MTMxXHU2NTRGOnRva2VuL2F1dGhvcml6YXRpb24gXHU2QzM4XHU0RTBEXHU4RkRCXHU2M0E3XHU1MjM2XHU1M0YwIC0tLS0gKi9cclxuY29uc3Qgc2VjcmV0czogc3RyaW5nW10gPSBbXTtcclxuZnVuY3Rpb24gcmVkYWN0KHM6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgbGV0IG91dCA9IHM7XHJcbiAgZm9yIChjb25zdCBzZWMgb2Ygc2VjcmV0cykge1xyXG4gICAgaWYgKHNlYy5sZW5ndGggPj0gOCkgb3V0ID0gb3V0LnNwbGl0KHNlYykuam9pbignW3JlZGFjdGVkXScpO1xyXG4gIH1cclxuICByZXR1cm4gb3V0O1xyXG59XHJcbmZ1bmN0aW9uIGxvZ0luZm8odGFnOiBzdHJpbmcsIG1zZzogc3RyaW5nKTogdm9pZCB7XHJcbiAgY29uc29sZS5sb2coYFtobWgtZGVza3RvcDoke3RhZ31dICR7cmVkYWN0KG1zZyl9YCk7XHJcbn1cclxuXHJcbi8qIC0tLS0gXHU1MzU1XHU1QjlFXHU0RjhCIC0tLS0gKi9cclxuaWYgKCFhcHAucmVxdWVzdFNpbmdsZUluc3RhbmNlTG9jaygpKSB7XHJcbiAgYXBwLnF1aXQoKTtcclxufSBlbHNlIHtcclxuICBhcHAub24oJ3NlY29uZC1pbnN0YW5jZScsICgpID0+IHtcclxuICAgIGNvbnN0IHdpbiA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpWzBdO1xyXG4gICAgaWYgKHdpbikge1xyXG4gICAgICBpZiAod2luLmlzTWluaW1pemVkKCkpIHdpbi5yZXN0b3JlKCk7XHJcbiAgICAgIHdpbi5mb2N1cygpO1xyXG4gICAgfVxyXG4gIH0pO1xyXG5cclxuICAvKiAtLS0tIGhvc3QgXHU3NkQxXHU3QkExICsgXHU2ODY1XHU1QkEyXHU2MjM3XHU3QUVGIC0tLS0gKi9cclxuICBpbnRlcmZhY2UgQnJpZGdlU25hcHNob3Qge1xyXG4gICAgaG9zdFN0YXRlOiBIb3N0U3RhdGU7XHJcbiAgICBob3N0UG9ydDogbnVtYmVyIHwgbnVsbDtcclxuICAgIGhvc3RWZXJzaW9uOiBzdHJpbmcgfCBudWxsO1xyXG4gICAgbGFzdEVycm9yOiBzdHJpbmcgfCBudWxsO1xyXG4gICAgbW9kZTogJ2Zha2UnIHwgJ3JlYWwnO1xyXG4gICAgcnVudGltZUVudHJ5OiBzdHJpbmcgfCBudWxsO1xyXG4gIH1cclxuICBsZXQgc3VwZXJ2aXNvcjogRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yIHwgbnVsbCA9IG51bGw7XHJcbiAgbGV0IGNsaWVudDogRGVza3RvcEhvc3RDbGllbnQgfCBudWxsID0gbnVsbDtcclxuICBsZXQgYnJpZGdlOiBCcmlkZ2VTbmFwc2hvdCA9IHsgaG9zdFN0YXRlOiAnc3RvcHBlZCcsIGhvc3RQb3J0OiBudWxsLCBob3N0VmVyc2lvbjogbnVsbCwgbGFzdEVycm9yOiBudWxsLCBtb2RlOiAnZmFrZScsIHJ1bnRpbWVFbnRyeTogbnVsbCB9O1xyXG4gIC8qKiBcdTRFOEJcdTRFRjZcdTYyNzlcdTkxQ0ZcdTdGMTNcdTUxQjI6XHU5QUQ4XHU5ODkxIFNTRSBcdTRFMERcdTkwMTBcdTY3NjFcdThGQzcgSVBDLDUwbXMgXHU2Mjc5XHU5MUNGIGZsdXNoKFx1NkUzMlx1NjdEM1x1NEUwRFx1NTM2MSlcdTMwMDIgKi9cclxuICBsZXQgZXZlbnRCdWZmZXI6IEV2ZW50RW52ZWxvcGVbXSA9IFtdO1xyXG4gIGxldCBmbHVzaFRpbWVyOiBOb2RlSlMuVGltZW91dCB8IG51bGwgPSBudWxsO1xyXG4gIGxldCBzc2VBYm9ydDogQWJvcnRDb250cm9sbGVyIHwgbnVsbCA9IG51bGw7XHJcbiAgbGV0IGxhc3RFdmVudElkID0gJyc7XHJcbiAgLyoqIFx1NjcyQVx1NzdFNS9cdTc1NzhcdTVGNjJcdTRGRTFcdTVDMDFcdThCQTFcdTY1NzAoU0NIRU1BX01JU01BVENIIFx1OTc2Mlx1NTQxMVx1OEJDQVx1NjVBRCxcdTRFMERcdTVEMjkpXHUzMDAyICovXHJcbiAgbGV0IGRyb3BwZWRGcmFtZXMgPSAwO1xyXG5cclxuICBmdW5jdGlvbiBwdXNoRXZlbnQoZW52OiBFdmVudEVudmVsb3BlKTogdm9pZCB7XHJcbiAgICBldmVudEJ1ZmZlci5wdXNoKGVudik7XHJcbiAgICBpZiAoZXZlbnRCdWZmZXIubGVuZ3RoID4gMl8wMDApIGV2ZW50QnVmZmVyLnNwbGljZSgwLCBldmVudEJ1ZmZlci5sZW5ndGggLSAyXzAwMCk7XHJcbiAgICBpZiAoZmx1c2hUaW1lciA9PT0gbnVsbCkge1xyXG4gICAgICBmbHVzaFRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XHJcbiAgICAgICAgZmx1c2hUaW1lciA9IG51bGw7XHJcbiAgICAgICAgY29uc3QgYmF0Y2ggPSBldmVudEJ1ZmZlcjtcclxuICAgICAgICBldmVudEJ1ZmZlciA9IFtdO1xyXG4gICAgICAgIGZvciAoY29uc3QgdyBvZiBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKSkge1xyXG4gICAgICAgICAgaWYgKCF3LmlzRGVzdHJveWVkKCkpIHcud2ViQ29udGVudHMuc2VuZCgnYnJpZGdlOmV2ZW50LWJhdGNoJywgYmF0Y2gpO1xyXG4gICAgICAgIH1cclxuICAgICAgfSwgNTApO1xyXG4gICAgfVxyXG4gICAgbm90aWZ5RXZlbnQoZW52KTtcclxuICB9XHJcblxyXG4gIC8qIC0tLS0gXHU3Q0ZCXHU3RURGXHU2MjU4XHU3NkQ4ICsgXHU5MDFBXHU3N0U1KDAzIFx1NTNGNyBcdTAwQTdcdTRFMDA6XHU2ODRDXHU5NzYyXHU0RUE3XHU1NEMxXHU5NzAwXHU4OTgxXHU3Q0ZCXHU3RURGXHU2MjU4XHU3NkQ4XHUzMDAxXHU5MDFBXHU3N0U1KSAtLS0tXHJcbiAgICAgXHU1QkExXHU2Mjc5XHU3QjQ5XHU1Rjg1XHU1RkM1XHU5ODdCXHU2MjUzXHU2MjcwKFx1NzUyOFx1NjIzN1x1NUZDNVx1OTg3Qlx1NTFCM1x1N0I1Nik7XHU1QjhDXHU2MjEwL1x1NTkzMVx1OEQyNVx1NEVDNVx1NTcyOFx1N0E5N1x1NTNFM1x1NTkzMVx1NzEyNlx1NjVGNlx1NjNEMFx1OTE5Mlx1MzAwMiAqL1xyXG4gIGNvbnN0IFRSQVlfSUNPTl9CQVNFNjQgPSAnaVZCT1J3MEtHZ29BQUFBTlNVaEVVZ0FBQUJBQUFBQVFDQVlBQUFBZjgvOWhBQUFBUjBsRVFWUjRuR05nUUFQU3Nvci84V0YwOVVScnhHc1FxWm94RElFSjZEZCtCMk4waGJqRU1Xd24xUUN3SVlQVEFGeVlmZ1lNZkJpUVpBREZDWWtxU1puaXpFUkpkZ1lBbEw1cnNEYzJhVGNBQUFBQVNVVk9SSzVDWUlJPSc7XHJcbiAgbGV0IHRyYXk6IFRyYXkgfCBudWxsID0gbnVsbDtcclxuICBjb25zdCBzZW5kTWVudUFjdGlvbiA9IChhOiBzdHJpbmcpOiB2b2lkID0+IHtcclxuICAgIGZvciAoY29uc3QgdyBvZiBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKSkge1xyXG4gICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCdtZW51OmFjdGlvbicsIGEpO1xyXG4gICAgfVxyXG4gIH07XHJcbiAgZnVuY3Rpb24gZm9jdXNNYWluV2luZG93KCk6IHZvaWQge1xyXG4gICAgY29uc3Qgd2luID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkuZmluZCgodykgPT4gIXcuaXNEZXN0cm95ZWQoKSk7XHJcbiAgICBpZiAod2luID09PSB1bmRlZmluZWQpIHJldHVybjtcclxuICAgIGlmICh3aW4uaXNNaW5pbWl6ZWQoKSkgd2luLnJlc3RvcmUoKTtcclxuICAgIHdpbi5zaG93KCk7XHJcbiAgICB3aW4uZm9jdXMoKTtcclxuICB9XHJcbiAgZnVuY3Rpb24gc2V0dXBUcmF5KCk6IHZvaWQge1xyXG4gICAgaWYgKHRyYXkgIT09IG51bGwpIHJldHVybjtcclxuICAgIGNvbnN0IGljb24gPSBuYXRpdmVJbWFnZS5jcmVhdGVGcm9tRGF0YVVSTChgZGF0YTppbWFnZS9wbmc7YmFzZTY0LCR7VFJBWV9JQ09OX0JBU0U2NH1gKTtcclxuICAgIHRyYXkgPSBuZXcgVHJheShpY29uKTtcclxuICAgIHRyYXkuc2V0VG9vbFRpcCgnSE1IIERlc2t0b3AnKTtcclxuICAgIHRyYXkub24oJ2NsaWNrJywgZm9jdXNNYWluV2luZG93KTtcclxuICAgIHRyYXkuc2V0Q29udGV4dE1lbnUoTWVudS5idWlsZEZyb21UZW1wbGF0ZShbXHJcbiAgICAgIHsgbGFiZWw6ICdcdTY1QjBcdTVFRkFcdTRGMUFcdThCREQnLCBjbGljazogKCk6IHZvaWQgPT4gc2VuZE1lbnVBY3Rpb24oJ25ldy1zZXNzaW9uJykgfSxcclxuICAgICAgeyBsYWJlbDogJ1x1NjYzRVx1NzkzQVx1NEUzQlx1N0E5N1x1NTNFMycsIGNsaWNrOiBmb2N1c01haW5XaW5kb3cgfSxcclxuICAgICAgeyBsYWJlbDogJ1x1NjI0Qlx1NjczQVx1OEZEQ1x1N0EwQlx1NjNBN1x1NTIzNicsIGNsaWNrOiAoKTogdm9pZCA9PiBzZW5kTWVudUFjdGlvbignb3Blbi1yZW1vdGUnKSB9LFxyXG4gICAgICB7IGxhYmVsOiAnXHU4QkJFXHU3RjZFJywgY2xpY2s6ICgpOiB2b2lkID0+IHNlbmRNZW51QWN0aW9uKCdvcGVuLXNldHRpbmdzJykgfSxcclxuICAgICAgeyB0eXBlOiAnc2VwYXJhdG9yJyB9LFxyXG4gICAgICB7IGxhYmVsOiAnXHU5MDAwXHU1MUZBJywgY2xpY2s6ICgpOiB2b2lkID0+IHsgYXBwLnF1aXQoKTsgfSB9LFxyXG4gICAgXSkpO1xyXG4gIH1cclxuICBmdW5jdGlvbiBub3RpZnlFdmVudChlbnY6IEV2ZW50RW52ZWxvcGUpOiB2b2lkIHtcclxuICAgIC8vIFx1OUE4Q1x1NjUzNi9cdTYyMkFcdTU2RkUvXHU2RTMyXHU2N0QzXHU2M0EyXHU5NDg4L1x1ODlDNlx1ODlDOVx1NTZERVx1NUY1Mlx1NkEyMVx1NUYwRlx1OTc1OVx1OUVEOChcdTRFMERcdTVGODBcdTc1MjhcdTYyMzdcdTY4NENcdTk3NjJcdTVGMzlcdTZENEJcdThCRDVcdTkwMUFcdTc3RTUpXHJcbiAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRlkgPT09ICcxJyB8fCBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9TTkFQU0hPVCAhPT0gdW5kZWZpbmVkIHx8IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1JFTkRFUl9URVNUID09PSAnMScgfHwgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVklTUkVHID09PSAnMScpIHJldHVybjtcclxuICAgIGlmICghTm90aWZpY2F0aW9uLmlzU3VwcG9ydGVkKCkpIHJldHVybjtcclxuICAgIGNvbnN0IHdpbiA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmZpbmQoKHcpID0+ICF3LmlzRGVzdHJveWVkKCkpO1xyXG4gICAgY29uc3QgZm9jdXNlZCA9IHdpbj8uaXNGb2N1c2VkKCkgPz8gZmFsc2U7XHJcbiAgICBjb25zdCBtayA9ICh0aXRsZTogc3RyaW5nLCBib2R5OiBzdHJpbmcpOiB2b2lkID0+IHtcclxuICAgICAgY29uc3QgbiA9IG5ldyBOb3RpZmljYXRpb24oeyB0aXRsZSwgYm9keSwgaWNvbjogbmF0aXZlSW1hZ2UuY3JlYXRlRnJvbURhdGFVUkwoYGRhdGE6aW1hZ2UvcG5nO2Jhc2U2NCwke1RSQVlfSUNPTl9CQVNFNjR9YCkgfSk7XHJcbiAgICAgIG4ub24oJ2NsaWNrJywgZm9jdXNNYWluV2luZG93KTtcclxuICAgICAgbi5zaG93KCk7XHJcbiAgICB9O1xyXG4gICAgaWYgKGVudi5raW5kID09PSAnYXBwcm92YWwucmVxdWlyZWQnKSB7XHJcbiAgICAgIGNvbnN0IHAgPSBlbnYucGF5bG9hZCBhcyB7IHRvb2w/OiBzdHJpbmcgfTtcclxuICAgICAgbWsoJ0hNSCBcdTk3MDBcdTg5ODFcdTVCQTFcdTYyNzknLCBgJHtTdHJpbmcocC50b29sID8/ICdcdTY0Q0RcdTRGNUMnKX0gXHU3QjQ5XHU1Rjg1XHU0RjYwXHU3Njg0XHU2Mjc5XHU1MUM2YCk7XHJcbiAgICB9IGVsc2UgaWYgKGVudi5raW5kID09PSAncnVuLmNvbXBsZXRlZCcgJiYgIWZvY3VzZWQpIHtcclxuICAgICAgbWsoJ0hNSCBcdTRFRkJcdTUyQTFcdTVCOENcdTYyMTAnLCBgXHU0RjFBXHU4QkREICR7ZW52LnNlc3Npb25JZH0gXHU3Njg0XHU0RUZCXHU1MkExXHU1REYyXHU1QjhDXHU2MjEwYCk7XHJcbiAgICB9IGVsc2UgaWYgKGVudi5raW5kID09PSAncnVuLmZhaWxlZCcgJiYgIWZvY3VzZWQpIHtcclxuICAgICAgbWsoJ0hNSCBcdTRFRkJcdTUyQTFcdTU5MzFcdThEMjUnLCBgXHU0RjFBXHU4QkREICR7ZW52LnNlc3Npb25JZH0gXHU3Njg0XHU0RUZCXHU1MkExXHU1OTMxXHU4RDI1LFx1NzBCOVx1NTFGQlx1NjdFNVx1NzcwQmApO1xyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgLyogLS0tLSBcdTgxRUFcdTVCOUFcdTRFNDlcdTY4MDdcdTk4OThcdTY4MEYoMjAyNi0xMC0xMSBcdTc1MjhcdTYyMzdcdTUzQ0RcdTk5ODg6XHU0RUFFXHU4MjcyXHU2QTIxXHU1RjBGXHU5ODc2XHU5MEU4XHU5RUQxXHU2NzYxPVx1NTM5Rlx1NzUxRlx1ODNEQ1x1NTM1NVx1NjgwRlxyXG4gICAgIFx1NEUwRFx1OERERlx1NEUzQlx1OTg5ODtcdTgzRENcdTUzNTVcdTRFMEVcdThCQkVcdTdGNkVcdTkxQ0RcdTU5MEQpIC0tLS0gXHU2NUI5XHU2ODQ4Olx1OTY5MFx1ODVDRlx1NUYwRlx1NjgwN1x1OTg5OFx1NjgwRiArIHRpdGxlQmFyT3ZlcmxheVxyXG4gICAgIChcdTk4OUNcdTgyNzJcdTk2OEZcdTRFM0JcdTk4OTgpLFx1ODNEQ1x1NTM1NVx1NjgwRiBhdXRvSGlkZShBbHQgXHU1NDdDXHU1MUZBKVx1NEUxNFx1N0NCRVx1N0I4MFx1NEUzQVx1N0NGQlx1N0VERlx1N0VBN1x1ODBGRFx1NTI5QjtcclxuICAgICBcdTVFMzhcdTc1MjhcdTUyQThcdTRGNUNcdThENzAgcmVuZGVyZXIgXHU2ODA3XHU5ODk4XHU2ODBGIFx1MjYzMCBcdTRFM0JcdTgzRENcdTUzNTUoXHU1NTJGXHU0RTAwXHU1MTY1XHU1M0UzKVx1MzAwMiAqL1xyXG4gIC8vIHY0IERTSCBcdThCQkVcdThCQTFcdThCRURcdThBMDA6b3ZlcmxheSBcdTgyNzJcdThEREZcdTk2OEYgdGl0bGViYXIgXHU3Njg0IGJnLWxheWVyLTEoXHU2RDQ1ICNmZmYvXHU2REYxICMxNjE4MWQpXHJcbiAgY29uc3QgY2hyb21lRm9yID0gKGRhcms6IGJvb2xlYW4pOiB7IGNvbG9yOiBzdHJpbmc7IHN5bWJvbENvbG9yOiBzdHJpbmcgfSA9PlxyXG4gICAgZGFyayA/IHsgY29sb3I6ICcjMTYxODFkJywgc3ltYm9sQ29sb3I6ICcjZjVmNmY4JyB9IDogeyBjb2xvcjogJyNmZmZmZmYnLCBzeW1ib2xDb2xvcjogJyMwZjExMTUnIH07XHJcbiAgZnVuY3Rpb24gYXBwbHlDaHJvbWUoZGFyazogYm9vbGVhbik6IHZvaWQge1xyXG4gICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XHJcbiAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB7XHJcbiAgICAgICAgdHJ5IHsgdy5zZXRUaXRsZUJhck92ZXJsYXkoY2hyb21lRm9yKGRhcmspKTsgfSBjYXRjaCB7IC8qIFx1NEVDNSBXaW5kb3dzIFx1NjUyRlx1NjMwMSAqLyB9XHJcbiAgICAgIH1cclxuICAgIH1cclxuICB9XHJcblxyXG4gIC8qIC0tLS0gXHU1RTk0XHU3NTI4XHU1MTg1XHU2NkY0XHU2NUIwKDIwMjYtMTAtMjY6XHU4MUVBXHU3ODE0XHU4RjdCXHU5MUNGXHU2NkY0XHU2NUIwXHU1NjY4LFx1OTZGNlx1NEY5RFx1OEQ1NjtHaXRIdWIgUmVsZWFzZXMgXHU5MDFBXHU5MDUzKVxyXG4gICAgIFx1NkQ0MVx1N0EwQjpcdTI2MzBcIlx1NjhDMFx1NjdFNVx1NjZGNFx1NjVCMFwiXHUyMTkyIGZldGNoIGxhdGVzdCByZWxlYXNlIHRhZyBcdTIxOTIgXHU2QkQ0XHU3MjQ4XHU2NzJDIFx1MjE5MiBcdTU0MEVcdTUzRjBcdTRFMEJcdThGN0QgU2V0dXBcclxuICAgICBleGUgXHU1MjMwXHU0RTM0XHU2NUY2XHU3NkVFXHU1RjU1IFx1MjE5MiBcdTgzRENcdTUzNTVcdTUzRDhcIlx1OTFDRFx1NTQyRlx1NUU3Nlx1NUI4OVx1ODhDNVx1NjZGNFx1NjVCMFwiXHUyMTkyIFx1OTAwMFx1NTFGQVx1NUU5NFx1NzUyOFx1NTQwRSBOU0lTIC9TIC9EPVx1NTM5Rlx1NzZFRVx1NUY1NVxyXG4gICAgIFx1OTc1OVx1OUVEOFx1ODk4Nlx1NzZENlx1NUI4OVx1ODhDNShcdTRFMEJcdTZCMjFcdTU0MkZcdTUyQThcdTUzNzNcdTY1QjBcdTcyNDgpXHUzMDAyXHU2NUUwXHU3QjdFXHU1NDBEXHU4QkMxXHU0RTY2XHU5NjM2XHU2QkI1XHU1M0VGXHU3NTI4O1x1NkI2M1x1NUYwRlx1N0I3RVx1NTQwRFx1NTQwRVx1NTNFRlx1NTJBMFx1NjgyMVx1OUE4Q1x1MzAwMlxyXG4gICAgIDIwMjYtMTAtMjkgXHU1M0NDXHU5MDFBXHU5MDUzXHU2ODM5XHU0RkVFKFx1NzUyOFx1NjIzN1x1NTZGRFx1NTE4NVx1NjUzNlx1NEUwRFx1NTIzMFx1NjNBOFx1OTAwMSk6XHU2OEMwXHU2N0U1XHU5MDFBXHU5MDUzXHU5NTVDXHU1MENGXHU1NkRFXHU5MDAwXHU5NEZFXHJcbiAgICAgKFx1NzZGNFx1OEZERSA4cyBcdTIxOTIgZ2gtcHJveHkgXHUyMTkyIGdoZmFzdCxcdTg5QzRcdTUyMTlcdTg5QzEgdXBkYXRlci1jaGFubmVscy50cykrIFx1NTQ3RFx1NEUyRFx1OTAxQVx1OTA1M1xyXG4gICAgIFx1N0M5OFx1NjAyN1x1OEJCMFx1NUZDNiArIFx1NEUwQlx1OEY3RFx1OTU1Q1x1NTBDRlx1NEUwRVx1NjhDMFx1NjdFNVx1OTAxQVx1OTA1M1x1NTQwQ1x1NkU5MFx1NEYxOFx1NTE0OFx1MzAwMiAqL1xyXG4gIGNvbnN0IFVQREFURV9SRVBPID0gJ3N3c2dibC9obWgtZGVza3RvcCc7XHJcbiAgaW50ZXJmYWNlIFVwZGF0ZVN0YXRlIHsgY2hlY2tpbmc6IGJvb2xlYW47IGN1cnJlbnRWZXJzaW9uOiBzdHJpbmc7IGxhdGVzdDogc3RyaW5nIHwgbnVsbDsgbm90ZXM6IHN0cmluZzsgZG93bmxvYWRlZDogYm9vbGVhbjsgZXJyb3I6IHN0cmluZzsgY2hhbm5lbDogc3RyaW5nIH1cclxuICBsZXQgdXBkYXRlU3RhdGU6IFVwZGF0ZVN0YXRlID0geyBjaGVja2luZzogZmFsc2UsIGN1cnJlbnRWZXJzaW9uOiBhcHAuZ2V0VmVyc2lvbigpLCBsYXRlc3Q6IG51bGwsIG5vdGVzOiAnJywgZG93bmxvYWRlZDogZmFsc2UsIGVycm9yOiAnJywgY2hhbm5lbDogJycgfTtcclxuICBsZXQgaW5zdGFsbGVyUGF0aDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XHJcbiAgY29uc3QgYnVtcFVwZGF0ZSA9IChwYXRjaDogUGFydGlhbDxVcGRhdGVTdGF0ZT4pOiB2b2lkID0+IHtcclxuICAgIHVwZGF0ZVN0YXRlID0geyAuLi51cGRhdGVTdGF0ZSwgLi4ucGF0Y2ggfTtcclxuICAgIGZvciAoY29uc3QgdyBvZiBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKSkge1xyXG4gICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCd1cGRhdGU6c3RhdGUnLCB1cGRhdGVTdGF0ZSk7XHJcbiAgICB9XHJcbiAgfTtcclxuICBjb25zdCBjbXBWZXJzaW9uID0gKGE6IHN0cmluZywgYjogc3RyaW5nKTogbnVtYmVyID0+IHtcclxuICAgIGNvbnN0IHBhID0gYS5yZXBsYWNlKC9edi8sICcnKS5zcGxpdCgnLicpLm1hcChOdW1iZXIpO1xyXG4gICAgY29uc3QgcGIgPSBiLnJlcGxhY2UoL152LywgJycpLnNwbGl0KCcuJykubWFwKE51bWJlcik7XHJcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IDM7IGkrKykgeyBpZiAoKHBhW2ldID8/IDApICE9PSAocGJbaV0gPz8gMCkpIHJldHVybiAocGFbaV0gPz8gMCkgPCAocGJbaV0gPz8gMCkgPyAtMSA6IDE7IH1cclxuICAgIHJldHVybiAwO1xyXG4gIH07XHJcbiAgLyoqIFx1OTAxQVx1OTA1M1x1N0M5OFx1NjAyNzpcdTRFMEFcdTZCMjFcdTYyMTBcdTUyOUZcdTU0N0RcdTRFMkRcdTc2ODRcdTY4QzBcdTY3RTVcdTkwMUFcdTkwNTModXNlckRhdGEvdXBkYXRlLWNoYW5uZWwuanNvbixcdTRFMEUgcnVudGltZS5qc29uIFx1NTQwQ1x1NkEyMVx1NUYwRilcdTMwMDIgKi9cclxuICBjb25zdCB1cGRhdGVDaGFubmVsRmlsZSA9ICgpOiBzdHJpbmcgPT4gam9pbihhcHAuZ2V0UGF0aCgndXNlckRhdGEnKSwgJ3VwZGF0ZS1jaGFubmVsLmpzb24nKTtcclxuICBhc3luYyBmdW5jdGlvbiBsb2FkU3RpY2t5Q2hhbm5lbCgpOiBQcm9taXNlPFVwZGF0ZUNoYW5uZWxJZCB8IG51bGw+IHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHYgPSBKU09OLnBhcnNlKGF3YWl0IHJlYWRGaWxlKHVwZGF0ZUNoYW5uZWxGaWxlKCksICd1dGY4JykpIGFzIHsgY2hhbm5lbD86IHVua25vd24gfTtcclxuICAgICAgcmV0dXJuIG5vcm1hbGl6ZUNoYW5uZWwodi5jaGFubmVsKTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4gbnVsbDsgfVxyXG4gIH1cclxuICBhc3luYyBmdW5jdGlvbiBzYXZlU3RpY2t5Q2hhbm5lbChpZDogVXBkYXRlQ2hhbm5lbElkKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBhd2FpdCB3cml0ZUZpbGUodXBkYXRlQ2hhbm5lbEZpbGUoKSwgSlNPTi5zdHJpbmdpZnkoeyBjaGFubmVsOiBpZCB9LCBudWxsLCAyKSwgJ3V0ZjgnKS5jYXRjaCgoKSA9PiB1bmRlZmluZWQpO1xyXG4gIH1cclxuICB0eXBlIExhdGVzdFJlbGVhc2UgPSB7IHRhZ19uYW1lPzogc3RyaW5nOyBib2R5Pzogc3RyaW5nOyBhc3NldHM/OiBBcnJheTx7IG5hbWU6IHN0cmluZzsgYnJvd3Nlcl9kb3dubG9hZF91cmw6IHN0cmluZzsgc2l6ZTogbnVtYmVyIH0+IH07XHJcbiAgYXN5bmMgZnVuY3Rpb24gY2hlY2tGb3JVcGRhdGVzKCk6IFByb21pc2U8VXBkYXRlU3RhdGU+IHtcclxuICAgIGlmICh1cGRhdGVTdGF0ZS5jaGVja2luZyB8fCB1cGRhdGVTdGF0ZS5kb3dubG9hZGVkKSByZXR1cm4gdXBkYXRlU3RhdGU7XHJcbiAgICBidW1wVXBkYXRlKHsgY2hlY2tpbmc6IHRydWUsIGVycm9yOiAnJyB9KTtcclxuICAgIGxvZ0luZm8oJ3VwZGF0ZScsIGBjaGVja2luZ1x1MjAyNiAoY3VycmVudCB2JHthcHAuZ2V0VmVyc2lvbigpfSlgKTtcclxuICAgIGNvbnN0IGZhaWx1cmVzOiBBcnJheTx7IGxhYmVsOiBzdHJpbmc7IHJlYXNvbjogc3RyaW5nIH0+ID0gW107XHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCBzdGlja3kgPSBhd2FpdCBsb2FkU3RpY2t5Q2hhbm5lbCgpO1xyXG4gICAgICBjb25zdCBjaGFubmVscyA9IG9yZGVyZWRDaGVja0NoYW5uZWxzKHN0aWNreSA/PyB1bmRlZmluZWQpO1xyXG4gICAgICBmb3IgKGNvbnN0IGNoIG9mIGNoYW5uZWxzKSB7XHJcbiAgICAgICAgbGV0IHJlbDogTGF0ZXN0UmVsZWFzZSB8IG51bGwgPSBudWxsO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICBjb25zdCByID0gYXdhaXQgZmV0Y2goY2guYXBpVXJsKFVQREFURV9SRVBPKSwge1xyXG4gICAgICAgICAgICBoZWFkZXJzOiB7ICd1c2VyLWFnZW50JzogJ2htaC1kZXNrdG9wLXVwZGF0ZXInIH0sXHJcbiAgICAgICAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dChjaC50aW1lb3V0TXMpLFxyXG4gICAgICAgICAgfSk7XHJcbiAgICAgICAgICBpZiAoIXIub2spIHsgZmFpbHVyZXMucHVzaCh7IGxhYmVsOiBjaC5sYWJlbCwgcmVhc29uOiBgSFRUUCAke3Iuc3RhdHVzfWAgfSk7IGxvZ0luZm8oJ3VwZGF0ZScsIGAke2NoLmxhYmVsfSBcdTIxOTIgSFRUUCAke3Iuc3RhdHVzfWApOyBjb250aW51ZTsgfVxyXG4gICAgICAgICAgLy8gXHU5NTVDXHU1MENGXHU1M0VGXHU4MEZEXHU1NkRFIDIwMCBcdTRGNDZcdTUxODVcdTVCQjlcdTk3NUUgSlNPTihIVE1MIFx1OTUxOVx1OEJFRlx1OTg3NSk6ci5qc29uKCkgXHU2MjlCXHU5NTE5XHU2MjE2IHRhZyBcdTdGM0FcdTU5MzFcdTkwRkRcdTYzMDlcdTY3MkNcdTkwMUFcdTkwNTNcdTU5MzFcdThEMjVcdTU2REVcdTkwMDBcclxuICAgICAgICAgIHJlbCA9IChhd2FpdCByLmpzb24oKSkgYXMgTGF0ZXN0UmVsZWFzZTtcclxuICAgICAgICAgIGlmICh0eXBlb2YgcmVsPy50YWdfbmFtZSAhPT0gJ3N0cmluZycgfHwgcmVsLnRhZ19uYW1lID09PSAnJykgeyBmYWlsdXJlcy5wdXNoKHsgbGFiZWw6IGNoLmxhYmVsLCByZWFzb246ICdcdTU0Q0RcdTVFOTRcdTY1RTAgdGFnX25hbWUnIH0pOyBsb2dJbmZvKCd1cGRhdGUnLCBgJHtjaC5sYWJlbH0gXHUyMTkyIFx1NjVFMCB0YWdfbmFtZWApOyBjb250aW51ZTsgfVxyXG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICAgICAgY29uc3QgZSA9IGVyciBhcyB7IGNhdXNlPzogeyBjb2RlPzogdW5rbm93biB9IH07XHJcbiAgICAgICAgICBjb25zdCByZWFzb24gPSBlcnIgaW5zdGFuY2VvZiBFcnJvciAmJiBlcnIubmFtZSA9PT0gJ1RpbWVvdXRFcnJvcidcclxuICAgICAgICAgICAgPyBgXHU4RDg1XHU2NUY2KCR7TWF0aC5yb3VuZChjaC50aW1lb3V0TXMgLyAxMDAwKX1zKWBcclxuICAgICAgICAgICAgOiBTdHJpbmcoZS5jYXVzZT8uY29kZSA/PyBlcnIpLnNsaWNlKDAsIDYwKTtcclxuICAgICAgICAgIGZhaWx1cmVzLnB1c2goeyBsYWJlbDogY2gubGFiZWwsIHJlYXNvbiB9KTtcclxuICAgICAgICAgIGxvZ0luZm8oJ3VwZGF0ZScsIGAke2NoLmxhYmVsfSBcdTIxOTIgZmFpbCAke3JlYXNvbn1gKTtcclxuICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCB0YWcgPSBTdHJpbmcocmVsLnRhZ19uYW1lKTtcclxuICAgICAgICBsb2dJbmZvKCd1cGRhdGUnLCBgbGF0ZXN0PSR7dGFnfSBhc3NldHM9JHsocmVsLmFzc2V0cyA/PyBbXSkubGVuZ3RofSB2aWEgJHtjaC5sYWJlbH0ke3N0aWNreSA9PT0gY2guaWQgPyAnKHN0aWNreSknIDogJyd9YCk7XHJcbiAgICAgICAgYXdhaXQgc2F2ZVN0aWNreUNoYW5uZWwoY2guaWQpOyAvLyBcdTdDOThcdTYwMjc6XHU0RTBCXHU2QjIxXHU1MTQ4XHU4QkQ1XHU2NzJDXHU5MDFBXHU5MDUzXHJcbiAgICAgICAgYnVtcFVwZGF0ZSh7IGNoZWNraW5nOiBmYWxzZSwgbGF0ZXN0OiB0YWcsIG5vdGVzOiBTdHJpbmcocmVsLmJvZHkgPz8gJycpLnNsaWNlKDAsIDYwMCksIGNoYW5uZWw6IGNoLmlkIH0pO1xyXG4gICAgICAgIC8vIFx1NjcwOVx1NjVCMFx1NzI0OFx1NEUxNFx1NjcyQVx1NEUwQlx1OEY3RFx1OEZDNyBcdTIxOTIgXHU1NDBFXHU1M0YwXHU0RTBCXHU4RjdEXHU1Qjg5XHU4OEM1XHU1MzA1XHJcbiAgICAgICAgaWYgKGNtcFZlcnNpb24oYXBwLmdldFZlcnNpb24oKSwgdGFnKSA8IDAgJiYgIXVwZGF0ZVN0YXRlLmRvd25sb2FkZWQpIHtcclxuICAgICAgICAgIHZvaWQgZG93bmxvYWRJbnN0YWxsZXIocmVsLmFzc2V0cyA/PyBbXSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiB1cGRhdGVTdGF0ZTtcclxuICAgICAgfVxyXG4gICAgICBjb25zdCBzdW1tYXJ5ID0gc3VtbWFyaXplQ2hlY2tGYWlsdXJlcyhmYWlsdXJlcyk7XHJcbiAgICAgIGxvZ0luZm8oJ3VwZGF0ZScsIGBjaGVjayBmYWlsZWQ6IGFsbCBjaGFubmVscyAoJHtzdW1tYXJ5fSlgKTtcclxuICAgICAgYnVtcFVwZGF0ZSh7IGNoZWNraW5nOiBmYWxzZSwgZXJyb3I6IGBcdTUxNjhcdTkwRThcdTY4QzBcdTY3RTVcdTkwMUFcdTkwNTNcdTU5MzFcdThEMjUoJHtzdW1tYXJ5fSlgLnNsaWNlKDAsIDIwMCkgfSk7XHJcbiAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgbG9nSW5mbygndXBkYXRlJywgYGNoZWNrIGZhaWxlZDogJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxNDApfWApO1xyXG4gICAgICBidW1wVXBkYXRlKHsgY2hlY2tpbmc6IGZhbHNlLCBlcnJvcjogU3RyaW5nKGVycikuc2xpY2UoMCwgMTIwKSB9KTtcclxuICAgIH1cclxuICAgIHJldHVybiB1cGRhdGVTdGF0ZTtcclxuICB9XHJcbiAgYXN5bmMgZnVuY3Rpb24gZG93bmxvYWRJbnN0YWxsZXIoYXNzZXRzOiBBcnJheTx7IG5hbWU6IHN0cmluZzsgYnJvd3Nlcl9kb3dubG9hZF91cmw6IHN0cmluZzsgc2l6ZTogbnVtYmVyIH0+KTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCBhc3NldCA9IGFzc2V0cy5maW5kKChhKSA9PiAvXkhNSC1EZXNrdG9wLVNldHVwLS4qXFwuZXhlJC9pLnRlc3QoYS5uYW1lKSkgPz8gYXNzZXRzLmZpbmQoKGEpID0+IGEubmFtZS5lbmRzV2l0aCgnLmV4ZScpKTtcclxuICAgICAgaWYgKGFzc2V0ID09PSB1bmRlZmluZWQpIHsgYnVtcFVwZGF0ZSh7IGVycm9yOiAncmVsZWFzZSBcdTY1RTBcdTVCODlcdTg4QzVcdTUzMDVcdThENDRcdTRFQTcnIH0pOyByZXR1cm47IH1cclxuICAgICAgY29uc3QgZGVzdCA9IGpvaW4oYXBwLmdldFBhdGgoJ3RlbXAnKSwgYXNzZXQubmFtZSk7XHJcbiAgICAgIC8vIFx1OTU1Q1x1NTBDRlx1NTZERVx1OTAwMFx1OTRGRSArIFx1NTQwQ1x1NkU5MFx1NEYxOFx1NTE0ODpcdTY4QzBcdTY3RTVcdTU0N0RcdTRFMkRcdTc2ODRcdTkwMUFcdTkwNTNcdTYzOTJcdTY3MDBcdTUyNEQoXHU4OUM0XHU1MjE5XHU4OUMxIHVwZGF0ZXItY2hhbm5lbHMudHMpXHJcbiAgICAgIGNvbnN0IG1pcnJvcnMgPSBvcmRlcmVkRG93bmxvYWRNaXJyb3JzKGFzc2V0LmJyb3dzZXJfZG93bmxvYWRfdXJsLCB1cGRhdGVTdGF0ZS5jaGFubmVsKTtcclxuICAgICAgbGV0IGJ1ZjogQnVmZmVyIHwgbnVsbCA9IG51bGw7XHJcbiAgICAgIGxldCBsYXN0RXJyID0gJyc7XHJcbiAgICAgIGZvciAoY29uc3QgdSBvZiBtaXJyb3JzKSB7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgIGxvZ0luZm8oJ3VwZGF0ZScsIGB0cnlpbmcgJHtuZXcgVVJMKHUpLmhvc3R9XHUyMDI2YCk7XHJcbiAgICAgICAgICBjb25zdCByID0gYXdhaXQgZmV0Y2godSwgeyBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoNjAwXzAwMCkgfSk7XHJcbiAgICAgICAgICBpZiAoIXIub2spIHsgbGFzdEVyciA9IGBIVFRQICR7ci5zdGF0dXN9YDsgbG9nSW5mbygndXBkYXRlJywgYFx1MjE5MiBIVFRQICR7ci5zdGF0dXN9YCk7IGNvbnRpbnVlOyB9XHJcbiAgICAgICAgICBidWYgPSBCdWZmZXIuZnJvbShhd2FpdCByLmFycmF5QnVmZmVyKCkpO1xyXG4gICAgICAgICAgaWYgKGJ1Zi5sZW5ndGggPiAxXzAwMF8wMDApIHsgbG9nSW5mbygndXBkYXRlJywgYFx1MjE5MiBvayAke01hdGgucm91bmQoYnVmLmxlbmd0aCAvIDFlNil9TUJgKTsgYnJlYWs7IH1cclxuICAgICAgICAgIGxhc3RFcnIgPSAnXHU1MTg1XHU1QkI5XHU1RjAyXHU1RTM4JzsgYnVmID0gbnVsbDtcclxuICAgICAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgICAgIGNvbnN0IGUgPSBlcnIgYXMgeyBjYXVzZT86IHsgY29kZT86IHVua25vd24gfSB9O1xyXG4gICAgICAgICAgbGFzdEVyciA9IFN0cmluZyhlLmNhdXNlPy5jb2RlID8/IGVycikuc2xpY2UoMCwgNjApO1xyXG4gICAgICAgICAgbG9nSW5mbygndXBkYXRlJywgYFx1MjE5MiBmYWlsICR7bGFzdEVycn1gKTtcclxuICAgICAgICB9XHJcbiAgICAgIH1cclxuICAgICAgaWYgKGJ1ZiA9PT0gbnVsbCkgdGhyb3cgbmV3IEVycm9yKGBcdTUxNjhcdTkwRThcdTRFMEJcdThGN0RcdTkwMUFcdTkwNTNcdTU5MzFcdThEMjUoJHtsYXN0RXJyfSlgKTtcclxuICAgICAgY29uc3QgeyB3cml0ZUZpbGU6IHdmIH0gPSBhd2FpdCBpbXBvcnQoJ25vZGU6ZnMvcHJvbWlzZXMnKTtcclxuICAgICAgYXdhaXQgd2YoZGVzdCwgYnVmKTtcclxuICAgICAgaW5zdGFsbGVyUGF0aCA9IGRlc3Q7XHJcbiAgICAgIGJ1bXBVcGRhdGUoeyBkb3dubG9hZGVkOiB0cnVlIH0pO1xyXG4gICAgICBsb2dJbmZvKCd1cGRhdGUnLCBgXHU1REYyXHU0RTBCXHU4RjdEICR7YXNzZXQubmFtZX0oJHtNYXRoLnJvdW5kKGJ1Zi5sZW5ndGggLyAxZTYpfU1CKSBcdTIxOTIgJHtkZXN0fWApO1xyXG4gICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgIGJ1bXBVcGRhdGUoeyBlcnJvcjogYFx1NEUwQlx1OEY3RFx1NTkzMVx1OEQyNTogJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApfWAgfSk7XHJcbiAgICB9XHJcbiAgfVxyXG4gIGZ1bmN0aW9uIGFwcGx5VXBkYXRlKCk6IHZvaWQge1xyXG4gICAgaWYgKGluc3RhbGxlclBhdGggPT09IG51bGwpIHJldHVybjtcclxuICAgIC8vIFx1OTAwMFx1NTFGQVx1NUY1M1x1NTI0RFx1NUU5NFx1NzUyOFx1NTQwRVx1NzUzMVx1NUI4OVx1ODhDNVx1NTY2OFx1OTc1OVx1OUVEOFx1ODk4Nlx1NzZENlx1NUI4OVx1ODhDNShcdTg4QzVcdTU2REVcdTUzOUZcdTc2RUVcdTVGNTUpXHUzMDAyTlNJUyBhc3Npc3RlZCBcdTg5QzRcdTUyMTk6XHJcbiAgICAvLyAvUyBcdTRFMTQgL0Q9cGF0aCBcdTVGQzVcdTk4N0JcdTY3MDBcdTU0MEVcdTRFMDBcdTRFMkFcdTUzQzJcdTY1NzBcdTMwMDFcdTUwM0NcdTRFMERcdTUyQTBcdTVGMTVcdTUzRjcoXHU1NDJCXHU3QTdBXHU2ODNDXHU0RTVGXHU0RTBEXHU1MkEwKVx1MjAxNFx1MjAxNG5vZGUgc3Bhd25cclxuICAgIC8vIFx1OUVEOFx1OEJBNFx1NEYxQVx1N0VEOVx1NTQyQlx1N0E3QVx1NjgzQ1x1NTNDMlx1NjU3MFx1NTJBMFx1NUYxNVx1NTNGN1x1NUJGQ1x1ODFGNCBOU0lTIFx1ODlFM1x1Njc5MFx1OTUxOVx1OERFRlx1NUY4NChcdTVCOUVcdTZENEJcdTg4QzVcdTU3NEZcdTc2RUVcdTVGNTUpLFx1NjU0NVx1NzUyOFxyXG4gICAgLy8gd2luZG93c1ZlcmJhdGltQXJndW1lbnRzIFx1NTM5Rlx1NjgzN1x1NEYyMFx1OTAxMlx1MzAwMlxyXG4gICAgY29uc3QgaW5zdGFsbERpciA9IGRpcm5hbWUocHJvY2Vzcy5leGVjUGF0aCk7XHJcbiAgICBjb25zdCBjaGlsZCA9IHNwYXduKGBcIiR7aW5zdGFsbGVyUGF0aH1cIiAvUyAvRD0ke2luc3RhbGxEaXJ9YCwge1xyXG4gICAgICBkZXRhY2hlZDogdHJ1ZSxcclxuICAgICAgc3RkaW86ICdpZ25vcmUnLFxyXG4gICAgICB3aW5kb3dzSGlkZTogdHJ1ZSxcclxuICAgICAgc2hlbGw6IGZhbHNlLFxyXG4gICAgICB3aW5kb3dzVmVyYmF0aW1Bcmd1bWVudHM6IHRydWUsXHJcbiAgICB9KTtcclxuICAgIGNoaWxkLnVucmVmKCk7XHJcbiAgICBsb2dJbmZvKCd1cGRhdGUnLCBgYXBwbHk6ICR7aW5zdGFsbGVyUGF0aH0gXHUyMTkyICR7aW5zdGFsbERpcn1gKTtcclxuICAgIGFwcC5leGl0KDApO1xyXG4gIH1cclxuXHJcbiAgZnVuY3Rpb24gYnVpbGRBcHBNZW51KCk6IHZvaWQge1xyXG4gICAgLy8gXHU3Q0JFXHU3QjgwOlx1NTNFQVx1NEZERFx1NzU1OSBVSSBcdTZDQTFcdTY3MDlcdTc2ODRcdTdDRkJcdTdFREZcdTdFQTdcdTgwRkRcdTUyOUIoXHU1MjZBXHU4RDM0XHU2NzdGL1x1N0E5N1x1NTNFMyk7XHU1MTc2XHU0RjU5XHU1NTJGXHU0RTAwXHU1MTY1XHU1M0UzXHU1NzI4IFVJXHUzMDAyXHJcbiAgICBjb25zdCB0ZW1wbGF0ZTogQXJyYXk8RWxlY3Ryb24uTWVudUl0ZW1Db25zdHJ1Y3Rvck9wdGlvbnM+ID0gW1xyXG4gICAgICB7XHJcbiAgICAgICAgbGFiZWw6ICdcdTdGMTZcdThGOTEnLFxyXG4gICAgICAgIHN1Ym1lbnU6IFtcclxuICAgICAgICAgIHsgcm9sZTogJ3VuZG8nLCBsYWJlbDogJ1x1NjRBNFx1OTUwMCcgfSxcclxuICAgICAgICAgIHsgcm9sZTogJ3JlZG8nLCBsYWJlbDogJ1x1OTFDRFx1NTA1QScgfSxcclxuICAgICAgICAgIHsgdHlwZTogJ3NlcGFyYXRvcicgfSxcclxuICAgICAgICAgIHsgcm9sZTogJ2N1dCcsIGxhYmVsOiAnXHU1MjZBXHU1MjA3JyB9LFxyXG4gICAgICAgICAgeyByb2xlOiAnY29weScsIGxhYmVsOiAnXHU1OTBEXHU1MjM2JyB9LFxyXG4gICAgICAgICAgeyByb2xlOiAncGFzdGUnLCBsYWJlbDogJ1x1N0M5OFx1OEQzNCcgfSxcclxuICAgICAgICAgIHsgcm9sZTogJ3NlbGVjdEFsbCcsIGxhYmVsOiAnXHU1MTY4XHU5MDA5JyB9LFxyXG4gICAgICAgIF0sXHJcbiAgICAgIH0sXHJcbiAgICAgIHtcclxuICAgICAgICBsYWJlbDogJ1x1N0E5N1x1NTNFMycsXHJcbiAgICAgICAgc3VibWVudTogW1xyXG4gICAgICAgICAgeyByb2xlOiAnbWluaW1pemUnLCBsYWJlbDogJ1x1NjcwMFx1NUMwRlx1NTMxNicgfSxcclxuICAgICAgICAgIHsgcm9sZTogJ3pvb20nLCBsYWJlbDogJ1x1N0YyOVx1NjUzRScgfSxcclxuICAgICAgICAgIHsgdHlwZTogJ3NlcGFyYXRvcicgfSxcclxuICAgICAgICAgIHsgcm9sZTogJ2Nsb3NlJywgbGFiZWw6ICdcdTUxNzNcdTk1RUQnIH0sXHJcbiAgICAgICAgXSxcclxuICAgICAgfSxcclxuICAgIF07XHJcbiAgICBNZW51LnNldEFwcGxpY2F0aW9uTWVudShNZW51LmJ1aWxkRnJvbVRlbXBsYXRlKHRlbXBsYXRlKSk7XHJcbiAgfVxyXG4gIC8qKiBcdTY4MDdcdTk4OThcdTY4MEYgXHUyNjMwIFx1NEUzQlx1ODNEQ1x1NTM1NShcdTVFMzhcdTc1MjhcdTUyQThcdTRGNUNcdTc2ODRcdTU1MkZcdTRFMDBcdTUxNjVcdTUzRTM7XHU4OUM2XHU1NkZFXHU2MDAxXHU3RUNGIG1lbnU6YWN0aW9uIFx1OEY2Q1x1NTNEMSlcdTMwMDIgKi9cclxuICBmdW5jdGlvbiBwb3B1cE1haW5NZW51KCk6IHZvaWQge1xyXG4gICAgY29uc3Qgc2VuZCA9IChhOiBzdHJpbmcpOiB2b2lkID0+IHtcclxuICAgICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XHJcbiAgICAgICAgaWYgKCF3LmlzRGVzdHJveWVkKCkpIHcud2ViQ29udGVudHMuc2VuZCgnbWVudTphY3Rpb24nLCBhKTtcclxuICAgICAgfVxyXG4gICAgfTtcclxuICAgIGNvbnN0IHdpbiA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmZpbmQoKHcpID0+ICF3LmlzRGVzdHJveWVkKCkpO1xyXG4gICAgaWYgKHdpbiA9PT0gdW5kZWZpbmVkKSByZXR1cm47XHJcbiAgICBNZW51LmJ1aWxkRnJvbVRlbXBsYXRlKFtcclxuICAgICAgeyBsYWJlbDogJ1x1NjVCMFx1NUVGQVx1NEYxQVx1OEJERCcsIGFjY2VsZXJhdG9yOiAnQ21kT3JDdHJsK04nLCBjbGljazogKCk6IHZvaWQgPT4gc2VuZCgnbmV3LXNlc3Npb24nKSB9LFxyXG4gICAgICB7IGxhYmVsOiAnXHU4QkJFXHU3RjZFJywgYWNjZWxlcmF0b3I6ICdDbWRPckN0cmwrU2hpZnQrUCcsIGNsaWNrOiAoKTogdm9pZCA9PiBzZW5kKCdvcGVuLXNldHRpbmdzJykgfSxcclxuICAgICAgeyBsYWJlbDogJ1x1NUZFQlx1NjM3N1x1OTUyRScsIGFjY2VsZXJhdG9yOiAnQ21kT3JDdHJsKy8nLCBjbGljazogKCk6IHZvaWQgPT4gc2VuZCgnc2hvcnRjdXRzJykgfSxcclxuICAgICAgeyB0eXBlOiAnc2VwYXJhdG9yJyB9LFxyXG4gICAgICB7IGxhYmVsOiAnXHU2MjRCXHU2NzNBXHU4RkRDXHU3QTBCXHU2M0E3XHU1MjM2JywgY2xpY2s6ICgpOiB2b2lkID0+IHNlbmQoJ29wZW4tcmVtb3RlJykgfSxcclxuICAgICAgeyB0eXBlOiAnc2VwYXJhdG9yJyB9LFxyXG4gICAgICB7XHJcbiAgICAgICAgbGFiZWw6IHVwZGF0ZVN0YXRlLmRvd25sb2FkZWQgPyBgXHU5MUNEXHU1NDJGXHU1RTc2XHU1Qjg5XHU4OEM1XHU2NkY0XHU2NUIwKHYke3VwZGF0ZVN0YXRlLmxhdGVzdCA/PyAnPyd9KWAgOiAnXHU2OEMwXHU2N0U1XHU2NkY0XHU2NUIwXHUyMDI2JyxcclxuICAgICAgICBjbGljazogKCk6IHZvaWQgPT4ge1xyXG4gICAgICAgICAgaWYgKHVwZGF0ZVN0YXRlLmRvd25sb2FkZWQpIHsgYXBwbHlVcGRhdGUoKTsgcmV0dXJuOyB9XHJcbiAgICAgICAgICB2b2lkIGNoZWNrRm9yVXBkYXRlcygpLnRoZW4oKHN0KSA9PiB7XHJcbiAgICAgICAgICAgIGNvbnN0IG5ld2VyID0gc3QubGF0ZXN0ICE9PSBudWxsICYmIGNtcFZlcnNpb24oc3QuY3VycmVudFZlcnNpb24sIHN0LmxhdGVzdCkgPCAwO1xyXG4gICAgICAgICAgICBjb25zdCBkZXRhaWwgPSBuZXdlciA/IGAke3N0Lm5vdGVzfVxcblxcblx1NUI4OVx1ODhDNVx1NTMwNVx1NkI2M1x1NTcyOFx1NTQwRVx1NTNGMFx1NEUwQlx1OEY3RCxcdTVCOENcdTYyMTBcdTU0MEUgXHUyNjMwIFx1ODNEQ1x1NTM1NVx1NEYxQVx1NTFGQVx1NzNCMFwiXHU5MUNEXHU1NDJGXHU1RTc2XHU1Qjg5XHU4OEM1XHU2NkY0XHU2NUIwXCJcdTMwMDJgIDogJyc7XHJcbiAgICAgICAgICAgIHZvaWQgZGlhbG9nLnNob3dNZXNzYWdlQm94KHdpbiwge1xyXG4gICAgICAgICAgICAgIHR5cGU6ICdpbmZvJyxcclxuICAgICAgICAgICAgICB0aXRsZTogJ1x1NjhDMFx1NjdFNVx1NjZGNFx1NjVCMCcsXHJcbiAgICAgICAgICAgICAgbWVzc2FnZTogbmV3ZXJcclxuICAgICAgICAgICAgICAgID8gYFx1NTNEMVx1NzNCMFx1NjVCMFx1NzI0OFx1NjcyQyB2JHtzdC5sYXRlc3R9IWBcclxuICAgICAgICAgICAgICAgIDogKHN0LmVycm9yICE9PSAnJyA/IGBcdTY4QzBcdTY3RTVcdTU5MzFcdThEMjU6JHtzdC5lcnJvcn1gIDogYFx1NURGMlx1NjYyRlx1NjcwMFx1NjVCMFx1NzI0OFx1NjcyQyh2JHtzdC5jdXJyZW50VmVyc2lvbn0pYCksXHJcbiAgICAgICAgICAgICAgZGV0YWlsLFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgIH0pO1xyXG4gICAgICAgIH0sXHJcbiAgICAgIH0sXHJcbiAgICAgIHtcclxuICAgICAgICBsYWJlbDogJ1x1NTE3M1x1NEU4RSBITUggRGVza3RvcCcsXHJcbiAgICAgICAgY2xpY2s6ICgpOiB2b2lkID0+IHtcclxuICAgICAgICAgIHZvaWQgZGlhbG9nLnNob3dNZXNzYWdlQm94KHdpbiwge1xyXG4gICAgICAgICAgICB0eXBlOiAnaW5mbycsXHJcbiAgICAgICAgICAgIHRpdGxlOiAnXHU1MTczXHU0RThFIEhNSCBEZXNrdG9wJyxcclxuICAgICAgICAgICAgbWVzc2FnZTogJ0hNSCBEZXNrdG9wJyxcclxuICAgICAgICAgICAgZGV0YWlsOiBgYXBwIHYke2FwcC5nZXRWZXJzaW9uKCl9IFx1MDBCNyBcdTY2RjRcdTY1QjBcdTkwMUFcdTkwNTM6JHt1cGRhdGVTdGF0ZS5jaGFubmVsIHx8ICctJ31cXG5ydW50aW1lOiBobWhhcm5lc3MgJHticmlkZ2UuaG9zdFZlcnNpb24gPz8gJyhcdTY3MkFcdThGREVcdTYzQTUpJ30ke3VzZUJ1bmRsZWRSdW50aW1lID8gJyhcdTUxODVcdTdGNkUpJyA6ICcnfVxcblx1NkEyMVx1NUYwRjogJHticmlkZ2UubW9kZSA9PT0gJ3JlYWwnID8gKHVzZUJ1bmRsZWRSdW50aW1lID8gJ1x1NzcxRlx1NUI5RSBobWhhcm5lc3MoXHU1MTg1XHU3RjZFIHJ1bnRpbWUpJyA6ICdcdTc3MUZcdTVCOUUgaG1oYXJuZXNzKFx1NTkxNlx1OTBFOFx1NUI4OVx1ODhDNSknKSA6ICdcdTZGMTRcdTc5M0EoXHU1MDQ3XHU2NTcwXHU2MzZFKSd9XFxuXFxuXHU0RTBFIENMSSAvIFRVSSAvIFx1N0Y1MVx1OTg3NVx1NzI0OFx1NTE3MVx1NEVBQlx1NTQwQ1x1NEUwMCBITUhfSE9NRVx1MzAwMmAsXHJcbiAgICAgICAgICB9KTtcclxuICAgICAgICB9LFxyXG4gICAgICB9LFxyXG4gICAgICB7IGxhYmVsOiAnXHU5MDAwXHU1MUZBJywgcm9sZTogJ3F1aXQnIH0sXHJcbiAgICBdKS5wb3B1cCh7IHdpbmRvdzogd2luIH0pO1xyXG4gIH1cclxuXHJcbiAgLyogLS0tLSBcdTYyNEJcdTY3M0FcdThGRENcdTdBMEJcdTYzQTdcdTUyMzYoMDMgXHU1M0Y3OldlYiA3Nzg4IFx1NjYyRlx1NkQ0Rlx1ODlDOFx1NTY2OC9cdThGRENcdTdBMEIvXHU2MjRCXHU2NzNBXHU1MTY1XHU1M0UzLEFEUi0wMDU6XHJcbiAgICAgRGVza3RvcCBcdTRFMERcdTlFRDhcdThCQTRcdTYyNTNcdTVGMDAgTEFOIFx1MjAxNFx1MjAxNCBcdThGRDlcdTkxQ0NcdTY2MkZcdTc1MjhcdTYyMzdcdTY2M0VcdTVGMEZcdTU0MkZcdTUyQThcdTc2ODRcdTUxNjVcdTUzRTMpIC0tLS0gKi9cclxuICBjb25zdCBXRUJfUE9SVCA9IDc3ODg7XHJcbiAgYXN5bmMgZnVuY3Rpb24gcHJvYmVXZWJSZW1vdGUoKTogUHJvbWlzZTx7IHVwOiBib29sZWFuOyB2ZXJzaW9uOiBzdHJpbmcgfT4ge1xyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3QgciA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7V0VCX1BPUlR9L2FwaS9zdGF0ZWAsIHsgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDE1MDApIH0pO1xyXG4gICAgICBpZiAoIXIub2spIHJldHVybiB7IHVwOiBmYWxzZSwgdmVyc2lvbjogJycgfTtcclxuICAgICAgY29uc3QgZCA9IChhd2FpdCByLmpzb24oKSkgYXMgeyBkYWVtb25WZXJzaW9uPzogc3RyaW5nIH07XHJcbiAgICAgIHJldHVybiB7IHVwOiB0cnVlLCB2ZXJzaW9uOiBTdHJpbmcoZC5kYWVtb25WZXJzaW9uID8/ICcnKSB9O1xyXG4gICAgfSBjYXRjaCB7IHJldHVybiB7IHVwOiBmYWxzZSwgdmVyc2lvbjogJycgfTsgfVxyXG4gIH1cclxuICAvKiogXHU1RjAwXHU2NzNBXHU4MUVBXHU1NDJGXHU2NjJGXHU1NDI2XHU1REYyXHU4OEM1KHJ1bnRpbWUgd2ViLWRhZW1vbiBcdTc2ODRcdTU0MkZcdTUyQThcdTk4NzlcdTY1ODdcdTRFRjZcdTVCNThcdTU3MjhcdTYwMjc7MC4yMy4zNyBcdTY1QjBcdTgwRkRcdTUyOUIpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gd2ViQXV0b3N0YXJ0SW5zdGFsbGVkKCk6IGJvb2xlYW4ge1xyXG4gICAgY29uc3QgaG9tZSA9IHByb2Nlc3MuZW52LkhPTUUgPz8gJyc7XHJcbiAgICBjb25zdCBjYW5kaWRhdGVzID0gcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gJ3dpbjMyJ1xyXG4gICAgICA/IFtqb2luKHByb2Nlc3MuZW52LkFQUERBVEEgPz8gJycsICdNaWNyb3NvZnQnLCAnV2luZG93cycsICdTdGFydCBNZW51JywgJ1Byb2dyYW1zJywgJ1N0YXJ0dXAnLCAnaG1oYXJuZXNzLXdlYi1kYWVtb24uY21kJyldXHJcbiAgICAgIDogcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gJ2RhcndpbidcclxuICAgICAgICA/IFtqb2luKGhvbWUsICdMaWJyYXJ5JywgJ0xhdW5jaEFnZW50cycsICdobWhhcm5lc3Mtd2ViLWRhZW1vbi5wbGlzdCcpXVxyXG4gICAgICAgIDogW2pvaW4oaG9tZSwgJy5jb25maWcnLCAnc3lzdGVtZCcsICd1c2VyJywgJ2htaGFybmVzcy13ZWItZGFlbW9uLnNlcnZpY2UnKV07XHJcbiAgICByZXR1cm4gY2FuZGlkYXRlcy5zb21lKChwKSA9PiB7IHRyeSB7IHJldHVybiBleGlzdHNTeW5jKHApOyB9IGNhdGNoIHsgcmV0dXJuIGZhbHNlOyB9IH0pO1xyXG4gIH1cclxuICAvKiogXHU2MjRCXHU2NzNBXHU1M0VGXHU4REVGXHU3NTMxXHU3Njg0IExBTiBJUChSRkMxOTE4LFx1NjM5Mlx1OTY2NFx1ODY1QVx1NjJERlx1N0Y1MVx1NTM2MSlcdTMwMDIgKi9cclxuICBmdW5jdGlvbiBsYW5JcE9mKCk6IHN0cmluZyB7XHJcbiAgICBjb25zdCBWSVJUVUFMID0gL3Ztd2FyZXx2aXJ0dWFsfGh5cGVyLT92fHZldGhlcm5ldHx3c2x8dGFpbHNjYWxlfGxvb3BiYWNrfGJsdWV0b290aHx2Ym94fGRvY2tlcnx0YXAtfHBzZXVkby9pO1xyXG4gICAgY29uc3QgaXNSZmMxOTE4ID0gKGE6IHN0cmluZyk6IGJvb2xlYW4gPT4gL14xMFxcLi8udGVzdChhKSB8fCAvXjE5MlxcLjE2OFxcLi8udGVzdChhKSB8fCAvXjE3MlxcLigxWzYtOV18MlxcZHwzWzAxXSlcXC4vLnRlc3QoYSk7XHJcbiAgICBsZXQgbGFuSXAgPSAnJztcclxuICAgIGxldCBmYWxsYmFjayA9ICcnO1xyXG4gICAgZm9yIChjb25zdCBbbmFtZSwgbGlzdF0gb2YgT2JqZWN0LmVudHJpZXMobmV0d29ya0ludGVyZmFjZXMoKSkpIHtcclxuICAgICAgZm9yIChjb25zdCBuIG9mIGxpc3QgPz8gW10pIHtcclxuICAgICAgICBpZiAobi5mYW1pbHkgIT09ICdJUHY0JyB8fCBuLmludGVybmFsIHx8ICFpc1JmYzE5MTgobi5hZGRyZXNzKSkgY29udGludWU7XHJcbiAgICAgICAgaWYgKCFWSVJUVUFMLnRlc3QobmFtZSkpIGxhbklwID0gbGFuSXAgfHwgbi5hZGRyZXNzO1xyXG4gICAgICAgIGVsc2UgZmFsbGJhY2sgPSBmYWxsYmFjayB8fCBuLmFkZHJlc3M7XHJcbiAgICAgIH1cclxuICAgIH1cclxuICAgIHJldHVybiBsYW5JcCB8fCBmYWxsYmFjaztcclxuICB9XHJcbiAgLyoqIENMSSBcdTUxNjVcdTUzRTM6XHU2RTkwXHU3ODAxIHJlcG8gXHU1RTAzXHU1QzQwKG1haW4udHMsXHU3RUNGIHRzeClcdTYyMTYgbnBtIFx1NUI4OVx1ODhDNVx1NUUwM1x1NUM0MChkaXN0L21haW4uanNcclxuICAgKiAgXHU3NkY0XHU4REQxXHUyMDE0XHUyMDE0XHU0RUNFIHJ1bnRpbWUgXHU1MTY1XHU1M0UzXHU0RTBBXHU2RUFGXHU2MjdFIEBobWhhcm5lc3MvY2xpIFx1NTMwNTtcdTVENENcdTU5NTcvXHU2M0QwXHU1MzQ3L1x1NkU5MFx1NzgwMVx1NEUwOVx1NzlDRFx1NUUwM1x1NUM0MFx1OTAxQVx1NTQwMylcdTMwMDIgKi9cclxuICBmdW5jdGlvbiBjbGlFbnRyeU9mKCk6IHN0cmluZyB7XHJcbiAgICBpZiAocnVudGltZUVudHJ5ID09PSAnJyB8fCBydW50aW1lRW50cnkgPT09IG51bGwpIHJldHVybiAnJztcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHAgPSBqb2luKHJlcG9Sb290T2YocnVudGltZUVudHJ5KSwgJ3BhY2thZ2VzJywgJ2NsaScsICdzcmMnLCAnbWFpbi50cycpO1xyXG4gICAgICBpZiAoZXhpc3RzU3luYyhwKSkgcmV0dXJuIHA7XHJcbiAgICB9IGNhdGNoIHsgLyogXHU5NzVFIHJlcG8gXHU1RTAzXHU1QzQwICovIH1cclxuICAgIGxldCBkaXIgPSBkaXJuYW1lKHJ1bnRpbWVFbnRyeSk7XHJcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IDg7IGkrKykge1xyXG4gICAgICBpZiAoZXhpc3RzU3luYyhqb2luKGRpciwgJ2Rpc3QnLCAnbWFpbi5qcycpKSAmJiBwa2dOYW1lQXQoZGlyKSA9PT0gJ0BobWhhcm5lc3MvY2xpJykgcmV0dXJuIGpvaW4oZGlyLCAnZGlzdCcsICdtYWluLmpzJyk7XHJcbiAgICAgIGlmIChiYXNlbmFtZShkaXIpID09PSAnQGhtaGFybmVzcycgJiYgZXhpc3RzU3luYyhqb2luKGRpciwgJ2NsaScsICdkaXN0JywgJ21haW4uanMnKSkpIHJldHVybiBqb2luKGRpciwgJ2NsaScsICdkaXN0JywgJ21haW4uanMnKTtcclxuICAgICAgY29uc3QgcGFyZW50ID0gZGlybmFtZShkaXIpO1xyXG4gICAgICBpZiAocGFyZW50ID09PSBkaXIpIGJyZWFrO1xyXG4gICAgICBkaXIgPSBwYXJlbnQ7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gJyc7XHJcbiAgfVxyXG4gIGZ1bmN0aW9uIHJ1bkNsaShhcmdzOiBzdHJpbmdbXSk6IHZvaWQge1xyXG4gICAgY29uc3QgZW50cnkgPSBjbGlFbnRyeU9mKCk7XHJcbiAgICBpZiAoZW50cnkgPT09ICcnKSByZXR1cm47XHJcbiAgICBjb25zdCBpc1RzID0gZW50cnkuZW5kc1dpdGgoJy50cycpO1xyXG4gICAgY29uc3QgcmVwbyA9IHJlcG9Sb290T2YocnVudGltZUVudHJ5ID8/IGVudHJ5KTtcclxuICAgIGNvbnN0IGNoaWxkID0gc3Bhd24ocHJvY2Vzcy5leGVjUGF0aCwgaXNUcyA/IFsnLS1pbXBvcnQnLCAndHN4JywgZW50cnksIC4uLmFyZ3NdIDogW2VudHJ5LCAuLi5hcmdzXSwge1xyXG4gICAgICBjd2Q6IGlzVHMgPyByZXBvIDogZGlybmFtZShlbnRyeSksXHJcbiAgICAgIGRldGFjaGVkOiB0cnVlLFxyXG4gICAgICBzdGRpbzogJ2lnbm9yZScsXHJcbiAgICAgIHdpbmRvd3NIaWRlOiB0cnVlLFxyXG4gICAgICBlbnY6IHsgRUxFQ1RST05fUlVOX0FTX05PREU6ICcxJyB9LFxyXG4gICAgfSk7XHJcbiAgICBjaGlsZC51bnJlZigpO1xyXG4gIH1cclxuXHJcbiAgZnVuY3Rpb24gYnJvYWRjYXN0SG9zdFN0YXRlKHM6IEhvc3RTdGF0ZSwgaW5mbzogeyByZXN0YXJ0Q291bnQ6IG51bWJlcjsgbGFzdEVycm9yPzogc3RyaW5nIH0pOiB2b2lkIHtcclxuICAgIGJyaWRnZSA9IHsgLi4uYnJpZGdlLCBob3N0U3RhdGU6IHMsIGhvc3RQb3J0OiBzdXBlcnZpc29yPy5lbmRwb2ludD8ucG9ydCA/PyBudWxsLCBob3N0VmVyc2lvbjogc3VwZXJ2aXNvcj8uZW5kcG9pbnQ/LnZlcnNpb24gPz8gbnVsbCB9O1xyXG4gICAgbG9nSW5mbygnaG9zdCcsIGBzdGF0ZT0ke3N9JHtpbmZvLmxhc3RFcnJvciAhPT0gdW5kZWZpbmVkID8gYCBlcnI9JHtpbmZvLmxhc3RFcnJvcn1gIDogJyd9YCk7XHJcbiAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcclxuICAgICAgaWYgKCF3LmlzRGVzdHJveWVkKCkpIHcud2ViQ29udGVudHMuc2VuZCgnYnJpZGdlOmhvc3Qtc3RhdGUnLCBzLCBpbmZvKTtcclxuICAgIH1cclxuICB9XHJcblxyXG4gIC8qKiBTU0UgXHU2RDQxXHU4QkEyXHU5NjA1Olx1NEZFMVx1NUMwMShldmVudDogaG1oKVx1NjI3OVx1OTFDRlx1NjNBOCByZW5kZXJlcjtcdTlBRDhcdTk4OTEgZGVsdGEvbGluZSBcdTUzOUZcdTVFMjdcclxuICAgKiAgXHU0RjVDXHU0RTNBXHU2RDQxXHU1NzU3XHU4RjZDXHU1M0QxKHJlbmRlcmVyIFx1NjJGQ1x1NjNBNVx1NUY1M1x1NTI0RCBhc3Npc3RhbnQgXHU1MzYwXHU0RjREKVx1MzAwMlx1NjVBRFx1N0VCRlx1ODFFQVx1NTJBOFx1OTFDRFx1OEZERVx1MzAwMiAqL1xyXG4gIGFzeW5jIGZ1bmN0aW9uIHB1bXBFdmVudHMoKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBpZiAoY2xpZW50ID09PSBudWxsKSByZXR1cm47XHJcbiAgICBmb3IgKDs7KSB7XHJcbiAgICAgIGNvbnN0IGMgPSBjbGllbnQ7XHJcbiAgICAgIGlmIChjID09PSBudWxsKSByZXR1cm47XHJcbiAgICAgIHRyeSB7XHJcbiAgICAgICAgZm9yIGF3YWl0IChjb25zdCBmcmFtZSBvZiBjLnJhd0V2ZW50cyhsYXN0RXZlbnRJZCA9PT0gJycgPyB1bmRlZmluZWQgOiBsYXN0RXZlbnRJZCwgc3NlQWJvcnQ/LnNpZ25hbCkpIHtcclxuICAgICAgICAgIGlmIChmcmFtZS5ldmVudCA9PT0gJ2htaCcpIHtcclxuICAgICAgICAgICAgY29uc3QgZW52ID0gZW52ZWxvcGVGcm9tRnJhbWUoZnJhbWUpO1xyXG4gICAgICAgICAgICBpZiAoZW52ID09PSBudWxsKSB7XHJcbiAgICAgICAgICAgICAgZHJvcHBlZEZyYW1lcyArPSAxO1xyXG4gICAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGxhc3RFdmVudElkID0gZW52LmV2ZW50SWQ7XHJcbiAgICAgICAgICAgIHB1c2hFdmVudChlbnYpO1xyXG4gICAgICAgICAgfSBlbHNlIGlmIChmcmFtZS5ldmVudCA9PT0gJ2RlbHRhJyB8fCBmcmFtZS5ldmVudCA9PT0gJ2xpbmUnKSB7XHJcbiAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgY29uc3QgZCA9IEpTT04ucGFyc2UoZnJhbWUuZGF0YSkgYXMgeyBzZXNzaW9uSWQ/OiBzdHJpbmc7IGs/OiBzdHJpbmc7IGNodW5rPzogc3RyaW5nOyB0ZXh0Pzogc3RyaW5nIH07XHJcbiAgICAgICAgICAgICAgY29uc3QgcGF5bG9hZCA9IGZyYW1lLmV2ZW50ID09PSAnZGVsdGEnXHJcbiAgICAgICAgICAgICAgICA/IHsgc2Vzc2lvbklkOiBkLnNlc3Npb25JZCA/PyAnJywga2luZDogZC5rID8/ICd0ZXh0JywgY2h1bms6IFN0cmluZyhkLmNodW5rID8/ICcnKSB9XHJcbiAgICAgICAgICAgICAgICA6IHsgc2Vzc2lvbklkOiBkLnNlc3Npb25JZCA/PyAnJywga2luZDogJ2xpbmUnLCBjaHVuazogU3RyaW5nKGQudGV4dCA/PyAnJykgfTtcclxuICAgICAgICAgICAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcclxuICAgICAgICAgICAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ2JyaWRnZTpzdHJlYW0tY2h1bmsnLCBwYXlsb2FkKTtcclxuICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH0gY2F0Y2ggeyAvKiBtYWxmb3JtZWQgc3RyZWFtIGZyYW1lOiBza2lwICovIH1cclxuICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuOyAvLyBcdTZENDFcdTZCNjNcdTVFMzhcdTdFRDNcdTY3NUYoaG9zdCBcdTUxNzNcdTk1RUQpXHJcbiAgICAgIH0gY2F0Y2gge1xyXG4gICAgICAgIC8vIFx1NjVBRFx1N0VCRjpcdTc3RURcdTkwMDBcdTkwN0ZcdTU0MEVcdTkxQ0RcdThGREUoc3VwZXJ2aXNvciBcdTUzRUZcdTgwRkRcdTZCNjNcdTU3MjhcdTkxQ0RcdTU0MkYgaG9zdClcclxuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCAxXzAwMCkpO1xyXG4gICAgICAgIGlmIChzc2VBYm9ydD8uc2lnbmFsLmFib3J0ZWQpIHJldHVybjtcclxuICAgICAgfVxyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgLyogLS0tLSBobWhhcm5lc3MgcnVudGltZSBcdTgxRUFcdTUyQThcdTUzRDFcdTczQjAoMjAyNi0xMC0xMCBcdTc1MjhcdTYyMzdcdTVCOUFcdThDMDM6XHU4OEM1XHU4RkM3IGhtaGFybmVzcyBcdTc2ODRcclxuICAgICBcdTY3M0FcdTU2NjhcdTk2RjZcdTkxNERcdTdGNkVcdTc2RjRcdThGREUsXHU1OTBEXHU3NTI4IENMSS9UVUkvd2ViIDc3ODggXHU3Njg0XHU1NDBDXHU0RTAwIEhNSF9IT01FXHUyMDE0XHUyMDE0Y29uZmlnL3Byb3ZpZGVycy9cclxuICAgICBcdTRGMUFcdThCRERcdTUzODZcdTUzRjJcdTU5MjlcdTcxMzZcdTUxNzFcdTRFQUIpXHUzMDAydjUuMSBcdTUzRDFcdTczQjBcdTk4N0FcdTVFOEY6XHU2NjNFXHU1RjBGXHU5MTREXHU3RjZFID4gd2hlcmUgaG1oKFx1NkU5MFx1NzgwMSBsaW5rIFx1NEUwRVxyXG4gICAgIEBobWhhcm5lc3MvY2xpIG5wbSBcdTVCODlcdTg4QzVcdTRFMjRcdTc5Q0RcdTVFMDNcdTVDNDApPiBucG0gXHU1MTY4XHU1QzQwXHU2ODM5KFx1NTQwQyk+IFx1NTQxMVx1NUJGQ1x1NUI4OVx1ODhDNVx1NzZFRVx1NUY1NVxyXG4gICAgIH4vLmhtaGFybmVzcy1nbG9iYWwgPiBcdTVFMzhcdTg5QzFcdTZFOTBcdTc4MDFcdTRGNERcdTdGNkVcdTMwMDIgKi9cclxuICBjb25zdCBydW50aW1lQ29uZmlnRmlsZSA9ICgpOiBzdHJpbmcgPT4gam9pbihhcHAuZ2V0UGF0aCgndXNlckRhdGEnKSwgJ3J1bnRpbWUuanNvbicpO1xyXG4gIC8qKiBydW50aW1lLmpzb246eyBlbnRyeShcdTYyNEJcdTUyQTgvXHU1NDExXHU1QkZDXHU5MDA5XHU2MkU5XHU3Njg0XHU1MTY1XHU1M0UzKSwgZGVtbyhcdTYzMDFcdTRFNDVcdTZGMTRcdTc5M0FcdTZBMjFcdTVGMEYpIH1cdTMwMDIgKi9cclxuICBhc3luYyBmdW5jdGlvbiBsb2FkUnVudGltZUNvbmZpZygpOiBQcm9taXNlPHsgZW50cnk6IHN0cmluZzsgZGVtbzogYm9vbGVhbiB9PiB7XHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCB2ID0gSlNPTi5wYXJzZShhd2FpdCByZWFkRmlsZShydW50aW1lQ29uZmlnRmlsZSgpLCAndXRmOCcpKSBhcyB7IGVudHJ5PzogdW5rbm93bjsgZGVtbz86IHVua25vd24gfTtcclxuICAgICAgcmV0dXJuIHtcclxuICAgICAgICBlbnRyeTogdHlwZW9mIHYuZW50cnkgPT09ICdzdHJpbmcnICYmIHYuZW50cnkgIT09ICcnICYmIGlzQWJzb2x1dGUodi5lbnRyeSkgPyB2LmVudHJ5IDogJycsXHJcbiAgICAgICAgZGVtbzogdi5kZW1vID09PSB0cnVlLFxyXG4gICAgICB9O1xyXG4gICAgfSBjYXRjaCB7IHJldHVybiB7IGVudHJ5OiAnJywgZGVtbzogZmFsc2UgfTsgfVxyXG4gIH1cclxuICBhc3luYyBmdW5jdGlvbiBzYXZlUnVudGltZUNvbmZpZyhjZmc6IHsgZW50cnk6IHN0cmluZzsgZGVtbzogYm9vbGVhbiB9KTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBhd2FpdCB3cml0ZUZpbGUocnVudGltZUNvbmZpZ0ZpbGUoKSwgSlNPTi5zdHJpbmdpZnkoY2ZnLCBudWxsLCAyKSwgJ3V0ZjgnKS5jYXRjaCgoKSA9PiB1bmRlZmluZWQpO1xyXG4gIH1cclxuICBhc3luYyBmdW5jdGlvbiBsb2FkUnVudGltZUVudHJ5T3ZlcnJpZGUoKTogUHJvbWlzZTxzdHJpbmc+IHtcclxuICAgIHJldHVybiAoYXdhaXQgbG9hZFJ1bnRpbWVDb25maWcoKSkuZW50cnk7XHJcbiAgfVxyXG4gIGFzeW5jIGZ1bmN0aW9uIHNhdmVSdW50aW1lRW50cnlPdmVycmlkZShlbnRyeTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBhd2FpdCBzYXZlUnVudGltZUNvbmZpZyh7IGVudHJ5LCBkZW1vOiAoYXdhaXQgbG9hZFJ1bnRpbWVDb25maWcoKSkuZGVtbyB9KTtcclxuICB9XHJcblxyXG4gIGludGVyZmFjZSBFeHRlcm5hbFJ1bnRpbWUgeyBlbnRyeTogc3RyaW5nOyB2ZXJzaW9uOiBzdHJpbmc7IHNvdXJjZTogc3RyaW5nIH1cclxuXHJcbiAgLyoqIFx1OEJGQlx1NTMwNVx1NzI0OFx1NjcyQyhwYWNrYWdlLmpzb24gXHU3Njg0IHZlcnNpb24gXHU1QjU3XHU2QkI1O1x1NTkzMVx1OEQyNVx1N0E3QVx1NEUzMilcdTMwMDIgKi9cclxuICBmdW5jdGlvbiBwa2dWZXJzaW9uQXQoZGlyOiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3QgdiA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGpvaW4oZGlyLCAncGFja2FnZS5qc29uJyksICd1dGY4JykpIGFzIHsgdmVyc2lvbj86IHVua25vd24gfTtcclxuICAgICAgcmV0dXJuIHR5cGVvZiB2LnZlcnNpb24gPT09ICdzdHJpbmcnID8gdi52ZXJzaW9uIDogJyc7XHJcbiAgICB9IGNhdGNoIHsgcmV0dXJuICcnOyB9XHJcbiAgfVxyXG4gIC8qKiBcdThCRkJcdTUzMDVcdTU0MEQoXHU1NDBDXHU0RTBBO0BobWhhcm5lc3MvY2xpIFx1NUUwM1x1NUM0MFx1OEJDNlx1NTIyQlx1NzUyOClcdTMwMDIgKi9cclxuICBmdW5jdGlvbiBwa2dOYW1lQXQoZGlyOiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3QgdiA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGpvaW4oZGlyLCAncGFja2FnZS5qc29uJyksICd1dGY4JykpIGFzIHsgbmFtZT86IHVua25vd24gfTtcclxuICAgICAgcmV0dXJuIHR5cGVvZiB2Lm5hbWUgPT09ICdzdHJpbmcnID8gdi5uYW1lIDogJyc7XHJcbiAgICB9IGNhdGNoIHsgcmV0dXJuICcnOyB9XHJcbiAgfVxyXG5cclxuICAvKiogbnBtIFx1NUI4OVx1ODhDNVx1NzY4NCBAaG1oYXJuZXNzL2NsaSBcdTIxOTIgZGVza3RvcC1ob3N0IFx1N0YxNlx1OEJEMVx1NTE2NVx1NTNFMyhcdTVENENcdTU5NTdcdTRFMEVcdTYzRDBcdTUzNDdcdTRFMjRcdTc5Q0RcdTVFMDNcdTVDNDApXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gZW50cnlGcm9tQ2xpRGlyKGNsaURpcjogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIGNvbnN0IG5lc3RlZCA9IGpvaW4oY2xpRGlyLCAnbm9kZV9tb2R1bGVzJywgJ0BobWhhcm5lc3MnLCAnd2ViJywgJ2Rpc3QnLCAnZGVza3RvcC1ob3N0LmpzJyk7XHJcbiAgICBpZiAoZXhpc3RzU3luYyhuZXN0ZWQpKSByZXR1cm4gbmVzdGVkO1xyXG4gICAgY29uc3QgaG9pc3RlZCA9IGpvaW4oZGlybmFtZShjbGlEaXIpLCAnd2ViJywgJ2Rpc3QnLCAnZGVza3RvcC1ob3N0LmpzJyk7XHJcbiAgICBpZiAoZXhpc3RzU3luYyhob2lzdGVkKSkgcmV0dXJuIGhvaXN0ZWQ7XHJcbiAgICByZXR1cm4gJyc7XHJcbiAgfVxyXG5cclxuICAvKiogXHU1OTE2XHU5MEU4XHU1M0QxXHU3M0IwKFx1NEY5Qlx1ODFFQVx1NTJBOFx1OEZERVx1NjNBNVx1NEUwRVx1NTQxMVx1NUJGQ1x1NjhDMFx1NkQ0Qlx1OTg3NVx1NTE3MVx1NzUyOClcdTMwMDJcdTRGMThcdTUxNDhcdTdFQTc6ZW52ID4gd2hlcmUgaG1oID4gbnBtXHJcbiAgICogIFx1NTE2OFx1NUM0MFx1NjgzOSA+IFx1NTQxMVx1NUJGQ1x1NUI4OVx1ODhDNVx1NzZFRVx1NUY1NSB+Ly5obWhhcm5lc3MtZ2xvYmFsID4gXHU2RTkwXHU3ODAxXHU0RUQzXHU2MjZCXHU2M0NGO1x1NTQwQ1x1NEUwMFx1NUM0Mlx1NTE4NVxyXG4gICAqICBcIlx1NURGMlx1ODhDNSBDTEkobnBtIFx1NUUwM1x1NUM0MClcIiBcdTUxNDhcdTRFOEUgXCJcdTZFOTBcdTc4MDEgcmVwbyBcdTVFMDNcdTVDNDBcIlx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIGRldGVjdEV4dGVybmFsUnVudGltZSgpOiBFeHRlcm5hbFJ1bnRpbWUge1xyXG4gICAgLy8gMSkgXHU3M0FGXHU1ODgzXHU1M0Q4XHU5MUNGXHU2NjNFXHU1RjBGXHU4OTg2XHU3NkQ2KFx1OUFEOFx1N0VBN1x1NzUyOFx1NjIzNylcclxuICAgIGNvbnN0IGVudkVudHJ5ID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfUkVBTF9FTlRSWTtcclxuICAgIGlmIChlbnZFbnRyeSAhPT0gdW5kZWZpbmVkICYmIGVudkVudHJ5ICE9PSAnJyAmJiBpc0Fic29sdXRlKGVudkVudHJ5KSkge1xyXG4gICAgICByZXR1cm4geyBlbnRyeTogZW52RW50cnksIHZlcnNpb246ICcnLCBzb3VyY2U6ICdlbnYnIH07XHJcbiAgICB9XHJcblxyXG4gICAgY29uc3Qgd2hlcmVSZXBvcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xyXG4gICAgY29uc3Qgd2hlcmVDbGlzOiBzdHJpbmdbXSA9IFtdO1xyXG4gICAgY29uc3QgbnBtUmVwb3MgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgIGxldCBucG1DbGkgPSAnJztcclxuICAgIC8vIDIpIHdoZXJlIGhtaDpucG0gbGluayhcdTZFOTBcdTc4MDFcdTY4MzlcdTVFMDNcdTVDNDApXHU0RTBFIEBobWhhcm5lc3MvY2xpIG5wbSBcdTVCODlcdTg4QzVcdTVFMDNcdTVDNDBcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IG91dCA9IGV4ZWNGaWxlU3luYygnd2hlcmUnLCBbJ2htaCddLCB7IGVuY29kaW5nOiAndXRmOCcsIHRpbWVvdXQ6IDRfMDAwLCB3aW5kb3dzSGlkZTogdHJ1ZSB9KTtcclxuICAgICAgZm9yIChjb25zdCBsaW5lIG9mIG91dC5zcGxpdCgvXFxyP1xcbi8pKSB7XHJcbiAgICAgICAgY29uc3QgYmluID0gbGluZS50cmltKCk7XHJcbiAgICAgICAgaWYgKGJpbiA9PT0gJycpIGNvbnRpbnVlO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICBjb25zdCBiaW5EaXIgPSBkaXJuYW1lKGJpbik7XHJcbiAgICAgICAgICBjb25zdCBsaW5rZWQgPSBqb2luKGJpbkRpciwgJ25vZGVfbW9kdWxlcycsICdobWhhcm5lc3MnKTtcclxuICAgICAgICAgIGlmIChleGlzdHNTeW5jKGxpbmtlZCkpIHdoZXJlUmVwb3MuYWRkKHJlYWxwYXRoU3luYyhsaW5rZWQpKTtcclxuICAgICAgICAgIGNvbnN0IGNsaSA9IGpvaW4oYmluRGlyLCAnbm9kZV9tb2R1bGVzJywgJ0BobWhhcm5lc3MnLCAnY2xpJyk7XHJcbiAgICAgICAgICBpZiAoZXhpc3RzU3luYyhjbGkpKSB3aGVyZUNsaXMucHVzaChjbGkpO1xyXG4gICAgICAgIH0gY2F0Y2ggeyAvKiBiaW4gXHU1RTAzXHU1QzQwXHU0RTBEXHU3QjI2LFx1OERGM1x1OEZDNyAqLyB9XHJcbiAgICAgIH1cclxuICAgIH0gY2F0Y2ggeyAvKiBobWggXHU0RTBEXHU1NzI4IFBBVEggKi8gfVxyXG4gICAgLy8gMykgbnBtIFx1NTE2OFx1NUM0MFx1NjgzOShcdTRFMjRcdTc5Q0RcdTVFMDNcdTVDNDBcdTU0MEMgd2hlcmUpXHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCBvdXQgPSBleGVjRmlsZVN5bmMoJ25wbScsIFsncm9vdCcsICctZyddLCB7IGVuY29kaW5nOiAndXRmOCcsIHRpbWVvdXQ6IDZfMDAwLCB3aW5kb3dzSGlkZTogdHJ1ZSB9KTtcclxuICAgICAgY29uc3Qgcm9vdCA9IG91dC50cmltKCk7XHJcbiAgICAgIGNvbnN0IGxpbmtlZCA9IGpvaW4ocm9vdCwgJ2htaGFybmVzcycpO1xyXG4gICAgICBpZiAoZXhpc3RzU3luYyhsaW5rZWQpKSBucG1SZXBvcy5hZGQocmVhbHBhdGhTeW5jKGxpbmtlZCkpO1xyXG4gICAgICBjb25zdCBjbGkgPSBqb2luKHJvb3QsICdAaG1oYXJuZXNzJywgJ2NsaScpO1xyXG4gICAgICBpZiAoZXhpc3RzU3luYyhjbGkpKSBucG1DbGkgPSBjbGk7XHJcbiAgICB9IGNhdGNoIHsgLyogbnBtIFx1NEUwRFx1NTNFRlx1NzUyOCAqLyB9XHJcblxyXG4gICAgLy8gXHU1REYyXHU4OEM1IENMSShAaG1oYXJuZXNzL2NsaSBucG0gXHU1RTAzXHU1QzQwO2Rlc2t0b3AtaG9zdCBcdTRFM0FcdTdGMTZcdThCRDFcdTRFQTdcdTcyNjlcdTUzRUZcdTc2RjRcdThERDEpOlxyXG4gICAgLy8gd2hlcmUoUEFUSCBcdTc3MUZcdTc2RjgpPiBucG0gXHU1MTY4XHU1QzQwXHU2ODM5ID4gXHU1NDExXHU1QkZDXHU1Qjg5XHU4OEM1XHU3NkVFXHU1RjU1XHJcbiAgICBmb3IgKGNvbnN0IFtjbGksIHNvdXJjZV0gb2YgW1t3aGVyZUNsaXNbMF0gPz8gJycsICd3aGVyZS1obWgnXSwgW25wbUNsaSwgJ25wbS1nbG9iYWwnXV0gYXMgQXJyYXk8W3N0cmluZywgc3RyaW5nXT4pIHtcclxuICAgICAgaWYgKGNsaSA9PT0gJycpIGNvbnRpbnVlO1xyXG4gICAgICBjb25zdCBlbnRyeSA9IGVudHJ5RnJvbUNsaURpcihjbGkpO1xyXG4gICAgICBpZiAoZW50cnkgIT09ICcnKSByZXR1cm4geyBlbnRyeSwgdmVyc2lvbjogcGtnVmVyc2lvbkF0KGNsaSksIHNvdXJjZSB9O1xyXG4gICAgfVxyXG4gICAgY29uc3Qgd2l6YXJkRW50cnkgPSByZXNvbHZlSW5zdGFsbGVkRW50cnkoaW5zdGFsbFRhcmdldCgpKTtcclxuICAgIGlmICh3aXphcmRFbnRyeSAhPT0gJycpIHtcclxuICAgICAgcmV0dXJuIHsgZW50cnk6IHdpemFyZEVudHJ5LCB2ZXJzaW9uOiBwa2dWZXJzaW9uQXQoam9pbihpbnN0YWxsVGFyZ2V0KCksICdub2RlX21vZHVsZXMnLCAnQGhtaGFybmVzcycsICdjbGknKSksIHNvdXJjZTogJ3dpemFyZC1pbnN0YWxsJyB9O1xyXG4gICAgfVxyXG5cclxuICAgIC8vIFx1NkU5MFx1NzgwMSByZXBvIFx1NUUwM1x1NUM0MCh3aGVyZSA+IG5wbSBcdTUxNjhcdTVDNDAgPiBcdTVFMzhcdTg5QzFcdTZFOTBcdTc4MDFcdTRGNERcdTdGNkU7XHU1NDdEXHU0RTJEXHU5ODdCXHU2NzA5XHU1MTY1XHU1M0UzXHU0RTBFXHU0RjlEXHU4RDU2KVxyXG4gICAgY29uc3QgcmVwb3MgPSBuZXcgU2V0PHN0cmluZz4oWy4uLndoZXJlUmVwb3MsIC4uLm5wbVJlcG9zXSk7XHJcbiAgICBjb25zdCBiYXNlcyA9IFsnQzpcXFxcJywgJ0Q6XFxcXCcsICdFOlxcXFwnLCAnRjpcXFxcJywgJ0c6XFxcXCcsICdIOlxcXFwnLCBob21lZGlyKCksIGpvaW4oaG9tZWRpcigpLCAnRGV2ZWxvcGVyJyldO1xyXG4gICAgZm9yIChjb25zdCBiYXNlIG9mIGJhc2VzKSB7XHJcbiAgICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgcCA9IHJlc29sdmUoYmFzZSwgJ2htaGFybmVzcycpO1xyXG4gICAgICAgIGlmIChleGlzdHNTeW5jKHApKSByZXBvcy5hZGQocCk7XHJcbiAgICAgIH0gY2F0Y2ggeyAvKiBcdTc2RDhcdTRFMERcdTVCNThcdTU3MjggKi8gfVxyXG4gICAgfVxyXG4gICAgZm9yIChjb25zdCByZXBvIG9mIHJlcG9zKSB7XHJcbiAgICAgIGNvbnN0IGVudHJ5ID0gam9pbihyZXBvLCAncGFja2FnZXMnLCAnd2ViJywgJ3NyYycsICdkZXNrdG9wLWhvc3QudHMnKTtcclxuICAgICAgaWYgKGV4aXN0c1N5bmMoZW50cnkpICYmIGV4aXN0c1N5bmMoam9pbihyZXBvLCAnbm9kZV9tb2R1bGVzJykpKSB7XHJcbiAgICAgICAgcmV0dXJuIHsgZW50cnksIHZlcnNpb246IHBrZ1ZlcnNpb25BdChyZXBvKSwgc291cmNlOiAnc291cmNlLXJlcG8nIH07XHJcbiAgICAgIH1cclxuICAgIH1cclxuICAgIHJldHVybiB7IGVudHJ5OiAnJywgdmVyc2lvbjogJycsIHNvdXJjZTogJycgfTtcclxuICB9XHJcblxyXG4gIGZ1bmN0aW9uIGRldGVjdFJlYWxFbnRyeSgpOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIGRldGVjdEV4dGVybmFsUnVudGltZSgpLmVudHJ5O1xyXG4gIH1cclxuXHJcbiAgLyoqIFx1ODlFM1x1Njc5MCBydW50aW1lIFx1NTE2NVx1NTNFM1x1NjI0MFx1NUM1RVx1NzY4NCBobWhhcm5lc3MgXHU0RUQzXHU1RTkzXHU2ODM5KHBhY2thZ2VzL3dlYi9zcmN8ZGlzdCBcdTRFMEFcdTZFQUYpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gcmVwb1Jvb3RPZihlbnRyeTogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIGxldCBkaXIgPSBkaXJuYW1lKGVudHJ5KTtcclxuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgNjsgaSsrKSB7XHJcbiAgICAgIGlmIChleGlzdHNTeW5jKGpvaW4oZGlyLCAncGFja2FnZS5qc29uJykpICYmIGV4aXN0c1N5bmMoam9pbihkaXIsICdwYWNrYWdlcycsICd3ZWInKSkpIHJldHVybiBkaXI7XHJcbiAgICAgIGNvbnN0IHBhcmVudCA9IGRpcm5hbWUoZGlyKTtcclxuICAgICAgaWYgKHBhcmVudCA9PT0gZGlyKSBicmVhaztcclxuICAgICAgZGlyID0gcGFyZW50O1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGRpcm5hbWUoZW50cnkpO1xyXG4gIH1cclxuXHJcbiAgbGV0IHJ1bnRpbWVFbnRyeSA9ICcnOyAvLyBcdTVGNTNcdTUyNERcdTVCOUVcdTk2NDVcdTRGN0ZcdTc1MjhcdTc2ODRcdTc3MUZcdTVCOUUgcnVudGltZSBcdTUxNjVcdTUzRTMoJyc9XHU2NzJBXHU2M0E1KVxyXG4gIGxldCB1c2VCdW5kbGVkUnVudGltZSA9IGZhbHNlOyAvLyB2NTpcdTY2MkZcdTU0MjZcdTU3MjhcdTc1MjhcdTUxODVcdTdGNkUgcnVudGltZShcdTUxNzNcdTRFOEUvXHU5NzYyXHU2NzdGXHU2ODA3XHU2Q0U4KVxyXG5cclxuICAvKiogXHU1MTg1XHU3RjZFIHJ1bnRpbWUodjUgXHU1RjAwXHU3QkIxXHU1MzczXHU3NTI4KTpcdTYyNTNcdTUzMDVcdTU0MEVcdTk2OEYgZXh0cmFSZXNvdXJjZXMgXHU1RTczXHU5NEZBXHU1NzI4IHJlc291cmNlcy87XHJcbiAgICAgZGV2IFx1NzUyOFx1NEVEM1x1NUU5M1x1NTE4NVx1Njc4NFx1NUVGQVx1NEVBN1x1NzI2OShzY3JpcHRzL2J1bmRsZS1ydW50aW1lLm1qcylcdTMwMDJcdTgxRUFcdTUzMDVcdTU0MkJcdTUzNTVcdTY1ODdcdTRFRjYsXHU2NUUwIHRzeFx1MzAwMVxyXG4gICAgIFx1NjVFMCByZXBvIG5vZGVfbW9kdWxlcyBcdTRGOURcdThENTZcdTMwMDIgKi9cclxuICBmdW5jdGlvbiBidW5kbGVkUnVudGltZVBhdGgocmVwb1Jvb3Q6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICByZXR1cm4gam9pbihhcHAuaXNQYWNrYWdlZCA/IHByb2Nlc3MucmVzb3VyY2VzUGF0aCA6IGpvaW4ocmVwb1Jvb3QsICdhcHBzJywgJ2Rlc2t0b3AnLCAncmVzb3VyY2VzJyksICdydW50aW1lJywgJ3J1bnRpbWUuY2pzJyk7XHJcbiAgfVxyXG5cclxuICAvKiogXHU1MTg1XHU3RjZFIHJ1bnRpbWUgXHU1MTQzXHU0RkUxXHU2MDZGKFx1NTQxMVx1NUJGQ1wiXHU1MTg1XHU3RjZFXHU3Q0JFXHU3QjgwXHU1MTg1XHU2ODM4XCJcdTkwMDlcdTk4NzlcdTc2ODRcdTcyNDhcdTY3MkNcdTY4MDdcdTZDRTgpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gYnVuZGxlZFJ1bnRpbWVJbmZvKCk6IHsgcmVhZHk6IGJvb2xlYW47IHZlcnNpb246IHN0cmluZyB9IHtcclxuICAgIGNvbnN0IHJlcG9Sb290ID0gam9pbihoZXJlLCAnLi4nLCAnLi4nLCAnLi4nLCAnLi4nKTtcclxuICAgIGNvbnN0IHAgPSBidW5kbGVkUnVudGltZVBhdGgocmVwb1Jvb3QpO1xyXG4gICAgbGV0IHZlcnNpb24gPSAnJztcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHYgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKGRpcm5hbWUocCksICdwYWNrYWdlLmpzb24nKSwgJ3V0ZjgnKSkgYXMgeyB2ZXJzaW9uPzogdW5rbm93biB9O1xyXG4gICAgICB2ZXJzaW9uID0gdHlwZW9mIHYudmVyc2lvbiA9PT0gJ3N0cmluZycgPyB2LnZlcnNpb24gOiAnJztcclxuICAgIH0gY2F0Y2ggeyAvKiBcdTUxNDNcdTY1NzBcdTYzNkVcdTdGM0FcdTU5MzFcdTUyMTlcdTUzRUFcdTYyQTUgcmVhZHkgKi8gfVxyXG4gICAgcmV0dXJuIHsgcmVhZHk6IGV4aXN0c1N5bmMocCksIHZlcnNpb24gfTtcclxuICB9XHJcblxyXG4gIC8qKiBucG0gXHU2NjJGXHU1NDI2XHU1NzI4IFBBVEgoXHU1NDExXHU1QkZDXHU5MDA5XHU2MkU5XHU5ODc1IFx1MjQ2MCBcdTc2ODRcdTVCODlcdTg4QzVcdTY1QjlcdTVGMEZcdTY4MDdcdTZDRTg7d2hlcmUgXHU1RkVCXHU2M0EyLFx1NEUwRFx1NTA1QVx1NUI4Q1x1NjU3NFx1NjNBMlx1NkQ0QilcdTMwMDIgKi9cclxuICBmdW5jdGlvbiBucG1PblBhdGgoKTogYm9vbGVhbiB7XHJcbiAgICB0cnkge1xyXG4gICAgICBleGVjRmlsZVN5bmMoJ3doZXJlJywgWyducG0nXSwgeyBlbmNvZGluZzogJ3V0ZjgnLCB0aW1lb3V0OiA0XzAwMCwgd2luZG93c0hpZGU6IHRydWUgfSk7XHJcbiAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgfSBjYXRjaCB7IHJldHVybiBmYWxzZTsgfVxyXG4gIH1cclxuXHJcbiAgLyogLS0tLSBcdTk5OTZcdTU0MkZcdTVCODlcdTg4QzVcdTU0MTFcdTVCRkNcdTcyQjZcdTYwMDEodjUuMSkgLS0tLSAqL1xyXG4gIGNvbnN0IHdpemFyZEZpbGUgPSAoKTogc3RyaW5nID0+IGpvaW4oYXBwLmdldFBhdGgoJ3VzZXJEYXRhJyksICd3aXphcmQuanNvbicpO1xyXG4gIGFzeW5jIGZ1bmN0aW9uIGxvYWRXaXphcmRTdGF0ZSgpOiBQcm9taXNlPHsgZG9uZTogYm9vbGVhbjsgY2hvaWNlOiBzdHJpbmcgfT4ge1xyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3QgdiA9IEpTT04ucGFyc2UoYXdhaXQgcmVhZEZpbGUod2l6YXJkRmlsZSgpLCAndXRmOCcpKSBhcyB7IGRvbmU/OiB1bmtub3duOyBjaG9pY2U/OiB1bmtub3duIH07XHJcbiAgICAgIHJldHVybiB7IGRvbmU6IHYuZG9uZSA9PT0gdHJ1ZSwgY2hvaWNlOiB0eXBlb2Ygdi5jaG9pY2UgPT09ICdzdHJpbmcnID8gdi5jaG9pY2UgOiAnJyB9O1xyXG4gICAgfSBjYXRjaCB7IHJldHVybiB7IGRvbmU6IGZhbHNlLCBjaG9pY2U6ICcnIH07IH1cclxuICB9XHJcbiAgYXN5bmMgZnVuY3Rpb24gc2F2ZVdpemFyZFN0YXRlKGNob2ljZTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBhd2FpdCB3cml0ZUZpbGUod2l6YXJkRmlsZSgpLCBKU09OLnN0cmluZ2lmeSh7IGRvbmU6IHRydWUsIGNob2ljZSB9LCBudWxsLCAyKSwgJ3V0ZjgnKS5jYXRjaCgoKSA9PiB1bmRlZmluZWQpO1xyXG4gIH1cclxuICAvKiogXHU1NDExXHU1QkZDXHU4MUVBXHU1MkE4XHU1RjM5XHU1MUZBXHU2MjkxXHU1MjM2Olx1NkQ0Qlx1OEJENS9cdTVGMDBcdTUzRDFcdTczQUZcdTU4ODNcdTRFMERcdTVGMzkoVUlWRVJJRlkvU05BUFNIT1QvUkVOREVSX1RFU1QvXHJcbiAgICogIERPTVBST0JFL1NFQ1VSSVRZX1RFU1QvRkFLRS9kZXYpO0hNSF9ERVNLVE9QX1dJWkFSRF9GT1JDRT0xIFx1NUYzQVx1NTIzNlx1NUYzOShcdTlBOENcdTY1MzYpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gd2l6YXJkU3VwcHJlc3NlZCgpOiBib29sZWFuIHtcclxuICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9XSVpBUkRfRk9SQ0UgPT09ICcxJykgcmV0dXJuIGZhbHNlO1xyXG4gICAgcmV0dXJuIGlzRGV2XHJcbiAgICAgIHx8IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZID09PSAnMSdcclxuICAgICAgfHwgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfU05BUFNIT1QgIT09IHVuZGVmaW5lZFxyXG4gICAgICB8fCBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9WSVNSRUcgPT09ICcxJ1xyXG4gICAgICB8fCBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9SRU5ERVJfVEVTVCA9PT0gJzEnXHJcbiAgICAgIHx8IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX0RPTVBST0JFID09PSAnMSdcclxuICAgICAgfHwgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfU0VDVVJJVFlfVEVTVCA9PT0gJzEnXHJcbiAgICAgIHx8IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX0ZBS0UgPT09ICcxJztcclxuICB9XHJcblxyXG4gIC8qKiBcdTUzRDFcdTczQjBcdTk4N0FcdTVFOEY6XHU2NjNFXHU1RjBGXHU4OTg2XHU3NkQ2KFx1NTQyQlx1NTQxMVx1NUJGQ1x1OTAwOVx1NjJFOTpcdTU5MTZcdTkwRThcdTUxNjVcdTUzRTMvXHU1MTg1XHU3RjZFXHU4REVGXHU1Rjg0L1x1NkYxNFx1NzkzQSk+IFx1NTE4NVx1N0Y2RVx1NUYwMFx1NTE3M1xyXG4gICAgIChITUhfREVTS1RPUF9CVU5ETEVEPTEpPiBcdTU5MTZcdTkwRThcdTUzRDFcdTczQjAoZGV2IFx1NzZGOFx1OTBCQlx1NEVEM1x1NUU5MyAvIHdoZXJlIGhtaCAvIG5wbSBcdTUxNjhcdTVDNDAgL1xyXG4gICAgIFx1NTQxMVx1NUJGQ1x1NUI4OVx1ODhDNVx1NzZFRVx1NUY1NSAvIFx1NkU5MFx1NzgwMVx1NEY0RFx1N0Y2RSk+IFx1NTE4NVx1N0Y2RVx1NTE1Q1x1NUU5NVx1MzAwMlx1NTkxNlx1OTBFOFx1NEYxOFx1NTE0OD1cdTgwMDFcdTc1MjhcdTYyMzdcdTdFRTdcdTdFRURcdTc1MjhcdTgxRUFcdTVERjFcdTg4QzVcdTc2ODRcdTcyNDhcdTY3MkM7XHJcbiAgICAgXHU1MTg1XHU3RjZFPVx1NjVCMFx1NjczQVx1NTY2OFx1ODhDNVx1NUI4Q1x1NzZGNFx1OEZERVx1NzcxRlx1NUI5RVx1NTE4NVx1NjgzOFx1MzAwMkhNSF9ERVNLVE9QX0ZBS0U9MSBcdTYyMTYgcnVudGltZS5qc29uIGRlbW89dHJ1ZVxyXG4gICAgIChcdTU0MTFcdTVCRkNcIlx1NkYxNFx1NzkzQVx1NkEyMVx1NUYwRlwiXHU5MDA5XHU2MkU5LFx1NjMwMVx1NEU0NSlcdThGREJcdTZGMTRcdTc5M0FcdTMwMDIgKi9cclxuICBhc3luYyBmdW5jdGlvbiBzdGFydEhvc3QoKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCByZXBvUm9vdCA9IGpvaW4oaGVyZSwgJy4uJywgJy4uJywgJy4uJywgJy4uJyk7IC8vIGFwcHMvZGVza3RvcC9kaXN0LWVsZWN0cm9uL21haW4gXHUyMTkyIHJlcG8gcm9vdFxyXG4gICAgY29uc3QgcGFja2FnZWQgPSBhcHAuaXNQYWNrYWdlZDtcclxuICAgIGNvbnN0IGNmZyA9IGF3YWl0IGxvYWRSdW50aW1lQ29uZmlnKCk7XHJcbiAgICBjb25zdCBmb3JjZUZha2UgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9GQUtFID09PSAnMScgfHwgY2ZnLmRlbW87XHJcbiAgICBjb25zdCBmb3JjZUJ1bmRsZWQgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9CVU5ETEVEID09PSAnMSc7XHJcbiAgICBjb25zdCBvdmVycmlkZSA9IGNmZy5lbnRyeTtcclxuICAgIGNvbnN0IGFkamFjZW50ID0gam9pbihyZXBvUm9vdCwgJy4uJywgJ2htaGFybmVzcycsICdwYWNrYWdlcycsICd3ZWInLCAnc3JjJywgJ2Rlc2t0b3AtaG9zdC50cycpO1xyXG4gICAgY29uc3QgYnVuZGxlZCA9IGJ1bmRsZWRSdW50aW1lUGF0aChyZXBvUm9vdCk7XHJcbiAgICBjb25zdCBidW5kbGVkUmVhZHkgPSBleGlzdHNTeW5jKGJ1bmRsZWQpO1xyXG4gICAgLy8gXHU4OUUzXHU2NzkwKFx1N0VEM1x1Njc5Q1x1NUY1Mlx1NEUwMDpvdmVycmlkZT1idW5kbGVkIFx1OERFRlx1NUY4NFx1MjE5Mlx1NTE4NVx1N0Y2RTtcdTZFOTBcdTc4MDEgLnRzIFx1OTcwMCB0c3g7XHJcbiAgICAvLyBucG0gXHU1Qjg5XHU4OEM1IC5qcyBcdTdGMTZcdThCRDFcdTRFQTdcdTcyNjlcdTc2RjRcdThERDE7YnVuZGxlZD1cdTgxRUFcdTUzMDVcdTU0MkIgY2pzIFx1NzZGNFx1OEREMSlcclxuICAgIGxldCBlbnRyeSA9ICcnO1xyXG4gICAgdXNlQnVuZGxlZFJ1bnRpbWUgPSBmYWxzZTtcclxuICAgIGlmIChmb3JjZUZha2UpIHtcclxuICAgICAgLy8gXHU2RjE0XHU3OTNBXHU2QTIxXHU1RjBGXHJcbiAgICB9IGVsc2UgaWYgKG92ZXJyaWRlICE9PSAnJykge1xyXG4gICAgICBlbnRyeSA9IG92ZXJyaWRlO1xyXG4gICAgICBpZiAob3ZlcnJpZGUgPT09IGJ1bmRsZWQpIHVzZUJ1bmRsZWRSdW50aW1lID0gdHJ1ZTsgLy8gXHU1NDExXHU1QkZDXHU5MDA5XCJcdTUxODVcdTdGNkVcdTdDQkVcdTdCODBcdTUxODVcdTY4MzhcIlx1NzY4NFx1NjMwMVx1NEU0NVx1NUY2Mlx1NjAwMVxyXG4gICAgfSBlbHNlIGlmIChmb3JjZUJ1bmRsZWQpIHtcclxuICAgICAgaWYgKGJ1bmRsZWRSZWFkeSkgeyBlbnRyeSA9IGJ1bmRsZWQ7IHVzZUJ1bmRsZWRSdW50aW1lID0gdHJ1ZTsgfVxyXG4gICAgICBlbHNlIGxvZ0luZm8oJ2hvc3QnLCAnSE1IX0RFU0tUT1BfQlVORExFRD0xIFx1NEY0Nlx1NTE4NVx1N0Y2RSBydW50aW1lIFx1N0YzQVx1NTkzMShcdTUxNDhcdThERDEgc2NyaXB0cy9idW5kbGUtcnVudGltZS5tanMpJyk7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICBlbnRyeSA9IHBhY2thZ2VkID8gZGV0ZWN0UmVhbEVudHJ5KCkgOiAoZXhpc3RzU3luYyhhZGphY2VudCkgPyBhZGphY2VudCA6IGRldGVjdFJlYWxFbnRyeSgpKTtcclxuICAgICAgaWYgKGVudHJ5ID09PSAnJyAmJiBidW5kbGVkUmVhZHkpIHsgZW50cnkgPSBidW5kbGVkOyB1c2VCdW5kbGVkUnVudGltZSA9IHRydWU7IH1cclxuICAgIH1cclxuICAgIHJ1bnRpbWVFbnRyeSA9IGVudHJ5O1xyXG4gICAgY29uc3QgdXNlUmVhbCA9IGVudHJ5ICE9PSAnJyAmJiAodXNlQnVuZGxlZFJ1bnRpbWUgfHwgZXhpc3RzU3luYyhlbnRyeSkpO1xyXG4gICAgYnJpZGdlID0ge1xyXG4gICAgICAuLi5icmlkZ2UsXHJcbiAgICAgIG1vZGU6IHVzZVJlYWwgPyAncmVhbCcgOiAnZmFrZScsXHJcbiAgICAgIHJ1bnRpbWVFbnRyeTogdXNlUmVhbCA/ICh1c2VCdW5kbGVkUnVudGltZSA/IGAke2VudHJ5fSAoYnVuZGxlZClgIDogZW50cnkpIDogbnVsbCxcclxuICAgIH07XHJcbiAgICBsZXQgc3BlYzogeyBjb21tYW5kOiBzdHJpbmc7IGFyZ3M6IHN0cmluZ1tdOyBlbnY6IFJlY29yZDxzdHJpbmcsIHN0cmluZz47IGN3ZD86IHN0cmluZyB9O1xyXG4gICAgaWYgKHVzZUJ1bmRsZWRSdW50aW1lKSB7XHJcbiAgICAgIHNwZWMgPSB7XHJcbiAgICAgICAgY29tbWFuZDogcHJvY2Vzcy5leGVjUGF0aCxcclxuICAgICAgICBhcmdzOiBbZW50cnldLCAvLyBcdTgxRUFcdTUzMDVcdTU0MkJcdTUzNTVcdTY1ODdcdTRFRjY6ZWxlY3Ryb24tYXMtbm9kZSBcdTc2RjRcdThERDEsXHU2NUUwIHRzeCBcdTY1RTAgcmVwb1xyXG4gICAgICAgIGVudjogeyBFTEVDVFJPTl9SVU5fQVNfTk9ERTogJzEnIH0sXHJcbiAgICAgIH07XHJcbiAgICB9IGVsc2UgaWYgKHVzZVJlYWwgJiYgZW50cnkuZW5kc1dpdGgoJy5qcycpKSB7XHJcbiAgICAgIHNwZWMgPSB7XHJcbiAgICAgICAgY29tbWFuZDogcHJvY2Vzcy5leGVjUGF0aCxcclxuICAgICAgICBhcmdzOiBbZW50cnldLCAvLyBucG0gXHU1Qjg5XHU4OEM1XHU3Njg0XHU3RjE2XHU4QkQxXHU0RUE3XHU3MjY5OkVTTSBcdTRGOURcdThENTZcdTYzMDlcdTY1ODdcdTRFRjZcdTRGNERcdTdGNkVcdTg5RTNcdTY3OTAsXHU3NkY0XHU4REQxXHU1MzczXHU1M0VGXHJcbiAgICAgICAgY3dkOiBkaXJuYW1lKGVudHJ5KSxcclxuICAgICAgICBlbnY6IHsgRUxFQ1RST05fUlVOX0FTX05PREU6ICcxJyB9LFxyXG4gICAgICB9O1xyXG4gICAgfSBlbHNlIGlmICh1c2VSZWFsKSB7XHJcbiAgICAgIGNvbnN0IHJlcG8gPSByZXBvUm9vdE9mKGVudHJ5KTtcclxuICAgICAgc3BlYyA9IHtcclxuICAgICAgICBjb21tYW5kOiBwcm9jZXNzLmV4ZWNQYXRoLFxyXG4gICAgICAgIGFyZ3M6IFsnLS1pbXBvcnQnLCAndHN4JywgZW50cnldLFxyXG4gICAgICAgIGN3ZDogcmVwbywgLy8gYmFyZSAndHN4JyBcdTRFMEUgd29ya3NwYWNlIFx1NEY5RFx1OEQ1Nlx1OTBGRFx1NEVDRSByZXBvIFx1NzY4NCBub2RlX21vZHVsZXMgXHU4OUUzXHU2NzkwXHJcbiAgICAgICAgZW52OiB7IEVMRUNUUk9OX1JVTl9BU19OT0RFOiAnMScgfSxcclxuICAgICAgfTtcclxuICAgIH0gZWxzZSBpZiAocGFja2FnZWQpIHtcclxuICAgICAgc3BlYyA9IHtcclxuICAgICAgICBjb21tYW5kOiBwcm9jZXNzLmV4ZWNQYXRoLFxyXG4gICAgICAgIGFyZ3M6IFtqb2luKHByb2Nlc3MucmVzb3VyY2VzUGF0aCwgJ2Zha2UtaG9zdC5janMnKV0sXHJcbiAgICAgICAgZW52OiB7IEVMRUNUUk9OX1JVTl9BU19OT0RFOiAnMScgfSxcclxuICAgICAgfTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgIHNwZWMgPSB7XHJcbiAgICAgICAgY29tbWFuZDogcHJvY2Vzcy5leGVjUGF0aCxcclxuICAgICAgICAvLyBcdTc2RjRcdTYzQTVcdThENzBcdTUzMDVcdTc3MUZcdTVCOUVcdThERUZcdTVGODQobm9kZV9tb2R1bGVzIFx1OTFDQ1x1NzY4NCB3b3Jrc3BhY2UganVuY3Rpb24gXHU0RjFBXHU4OEFCIEVTTVxyXG4gICAgICAgIC8vIHJlYWxwYXRoIFx1NTMxNixcdTVCRkNcdTgxRjQgZmFrZS1ob3N0IFx1NzY4NCBhcmd2WzFdL2ltcG9ydC5tZXRhLnVybCBcdTUzMzlcdTkxNERcdTU5MzFcdTY1NDgpXHJcbiAgICAgICAgYXJnczogWyctLWltcG9ydCcsICd0c3gnLCBqb2luKHJlcG9Sb290LCAncGFja2FnZXMnLCAnaG9zdC1hZGFwdGVyJywgJ3NyYycsICdmYWtlLWhvc3QudHMnKV0sXHJcbiAgICAgICAgZW52OiB7IEVMRUNUUk9OX1JVTl9BU19OT0RFOiAnMScgfSxcclxuICAgICAgfTtcclxuICAgIH1cclxuICAgIHN1cGVydmlzb3IgPSBuZXcgRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yKHNwZWMsIHtcclxuICAgICAgb25TdGF0ZUNoYW5nZTogYnJvYWRjYXN0SG9zdFN0YXRlLFxyXG4gICAgICAvLyBcdTk5OTZcdTZCMjFcdTU0MkZcdTUyQThcdTRFMEUgY3Jhc2ggXHU4MUVBXHU2MTA4XHU1NDBFXHU3Njg0XHU5MUNEXHU1NDJGXHU5MEZEXHU0RjFBXHU4RDcwXHU4RkQ5XHU5MUNDOlx1N0FFRlx1NTNFMy90b2tlbiBcdTkwRkRcdTY2MkZcdTY1QjBcdTc2ODQsXHJcbiAgICAgIC8vIFx1OTFDRFx1NUVGQVx1Njg2NVx1NUJBMlx1NjIzN1x1N0FFRlx1NUU3Nlx1OTFDRFx1NjVCMFx1OEJBMlx1OTYwNSBTU0UocmVuZGVyZXIgXHU3Njg0IEV2ZW50U3RvcmUgXHU5NzYwIGV2ZW50SWQgXHU1M0JCXHU5MUNEKVxyXG4gICAgICBvblJlYWR5OiAoZXApID0+IHtcclxuICAgICAgICBjbGllbnQgPSBuZXcgRGVza3RvcEhvc3RDbGllbnQoYGh0dHA6Ly8xMjcuMC4wLjE6JHtlcC5wb3J0fWAsIGVwLnRva2VuKTtcclxuICAgICAgICBzc2VBYm9ydD8uYWJvcnQoKTtcclxuICAgICAgICBzc2VBYm9ydCA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcclxuICAgICAgICBsYXN0RXZlbnRJZCA9ICcnO1xyXG4gICAgICAgIHZvaWQgcHVtcEV2ZW50cygpO1xyXG4gICAgICAgIGxvZ0luZm8oJ2hvc3QnLCBgYnJpZGdlIHJlYWR5IG9uIDEyNy4wLjAuMToke2VwLnBvcnR9IChydW50aW1lICR7ZXAudmVyc2lvbn0sIG1vZGUgJHticmlkZ2UubW9kZX0ke3VzZVJlYWwgPyBgLCBlbnRyeT0ke3J1bnRpbWVFbnRyeX0ke3VzZUJ1bmRsZWRSdW50aW1lID8gJyBbYnVuZGxlZF0nIDogJyd9YCA6ICcnfSlgKTtcclxuICAgICAgfSxcclxuICAgIH0pO1xyXG4gICAgdHJ5IHtcclxuICAgICAgYXdhaXQgc3VwZXJ2aXNvci5zdGFydCgpO1xyXG4gICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgIGNvbnN0IGRldGFpbCA9ICgoKSA9PiB7IHRyeSB7IHJldHVybiBKU09OLnN0cmluZ2lmeShlcnIpOyB9IGNhdGNoIHsgcmV0dXJuIFN0cmluZyhlcnIpOyB9IH0pKCkuc2xpY2UoMCwgNDAwKTtcclxuICAgICAgYnJpZGdlID0geyAuLi5icmlkZ2UsIGhvc3RTdGF0ZTogJ2ZhaWxlZCcsIGxhc3RFcnJvcjogZGV0YWlsIH07XHJcbiAgICAgIGxvZ0luZm8oJ2hvc3QnLCBgc3RhcnQgZmFpbGVkOiAke2RldGFpbH1gKTtcclxuICAgIH1cclxuICB9XHJcblxyXG4gIC8qIC0tLS0gSVBDIFx1NzY3RFx1NTQwRFx1NTM1NSArIHNlbmRlciBcdTY4MjFcdTlBOEMgLS0tLSAqL1xyXG4gIGNvbnN0IGFsbG93ZWRPcmlnaW5zID0gbmV3IFNldDxzdHJpbmc+KFxyXG4gICAgaXNEZXYgJiYgcmVuZGVyZXJEZXZVcmxcclxuICAgICAgPyBbcmVuZGVyZXJEZXZVcmxdXHJcbiAgICAgIDogW3BhdGhUb0ZpbGVVUkwoam9pbihoZXJlLCAnLi4nLCAnLi4nLCAnZGlzdC1yZW5kZXJlcicsICdpbmRleC5odG1sJykpLmhyZWZdLFxyXG4gICk7XHJcblxyXG4gIGZ1bmN0aW9uIHNlbmRlclRydXN0ZWQoc2VuZGVyRnJhbWU6IEVsZWN0cm9uLldlYkZyYW1lTWFpbiB8IG51bGwgfCB1bmRlZmluZWQpOiBib29sZWFuIHtcclxuICAgIGlmIChzZW5kZXJGcmFtZSA9PT0gbnVsbCB8fCBzZW5kZXJGcmFtZSA9PT0gdW5kZWZpbmVkKSByZXR1cm4gZmFsc2U7XHJcbiAgICBsZXQgdG9wOiBFbGVjdHJvbi5XZWJGcmFtZU1haW4gfCBudWxsID0gc2VuZGVyRnJhbWU7XHJcbiAgICB3aGlsZSAodG9wPy5wYXJlbnQgIT09IG51bGwgJiYgdG9wPy5wYXJlbnQgIT09IHVuZGVmaW5lZCkgdG9wID0gdG9wLnBhcmVudDtcclxuICAgIGNvbnN0IHVybCA9IHRvcD8udXJsID8/ICcnO1xyXG4gICAgZm9yIChjb25zdCBvcmlnaW4gb2YgYWxsb3dlZE9yaWdpbnMpIHtcclxuICAgICAgaWYgKHVybCA9PT0gb3JpZ2luIHx8IHVybC5zdGFydHNXaXRoKGAke29yaWdpbn0vYCkgfHwgdXJsLnN0YXJ0c1dpdGgoYCR7b3JpZ2lufT9gKSkgcmV0dXJuIHRydWU7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gZmFsc2U7XHJcbiAgfVxyXG5cclxuICAvKiogXHU5NzAwXHU4OTgxIGhvc3QgXHU1QzMxXHU3RUVBXHU3Njg0IElQQyBoYW5kbGVyIFx1NTE2Q1x1NTE3MVx1NThGMzpcdTY3MkFcdTVDMzFcdTdFRUFcdThGRDRcdTU2REVcdTdFRDNcdTY3ODRcdTUzMTZcdTk1MTlcdThCRUZcdTMwMDIgKi9cclxuICBmdW5jdGlvbiBob3N0Q2FsbDxUPihldmVudDogRWxlY3Ryb24uSXBjTWFpbkludm9rZUV2ZW50LCBmbjogKGM6IERlc2t0b3BIb3N0Q2xpZW50KSA9PiBQcm9taXNlPFQ+KTogUHJvbWlzZTxUIHwgeyBlcnJvcjogc3RyaW5nOyBjb2RlOiBzdHJpbmcgfT4ge1xyXG4gICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH0pO1xyXG4gICAgaWYgKGNsaWVudCA9PT0gbnVsbCB8fCBicmlkZ2UuaG9zdFN0YXRlICE9PSAncmVhZHknKSB7XHJcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogYGhvc3Qgbm90IHJlYWR5ICgke2JyaWRnZS5ob3N0U3RhdGV9KWAsIGNvZGU6ICdIT1NUX05PVF9SRUFEWScgfSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gZm4oY2xpZW50KS5jYXRjaCgoZXJyOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IGRldGFpbCA9ICgoKSA9PiB7IHRyeSB7IHJldHVybiBKU09OLnN0cmluZ2lmeShlcnIpOyB9IGNhdGNoIHsgcmV0dXJuIFN0cmluZyhlcnIpOyB9IH0pKCkuc2xpY2UoMCwgMzAwKTtcclxuICAgICAgcmV0dXJuIHsgZXJyb3I6IGRldGFpbCwgY29kZTogJ0JSSURHRV9FUlJPUicgfTtcclxuICAgIH0pO1xyXG4gIH1cclxuXHJcbiAgZnVuY3Rpb24gcmVnaXN0ZXJJcGMoKTogdm9pZCB7XHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmdldC1zdGF0ZScsIChldmVudCkgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInIH07XHJcbiAgICAgIHJldHVybiB7IC4uLmJyaWRnZSwgZHJvcHBlZEZyYW1lcyB9O1xyXG4gICAgfSk7XHJcblxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpzZXNzaW9ucycsIChldmVudCkgPT5cclxuICAgICAgaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248eyBzZXNzaW9uczogQXJyYXk8eyBpZDogc3RyaW5nOyB0aXRsZTogc3RyaW5nOyB0YXNrOiBzdHJpbmc7IG91dGNvbWU6IHN0cmluZzsgdHVybnM6IG51bWJlcjsgdG9vbFVzZXM6IG51bWJlcjsgdGltZTogc3RyaW5nOyBjd2Q6IHN0cmluZzsgY3JlYXRlZEF0OiBzdHJpbmc7IHVwZGF0ZWRBdDogc3RyaW5nIH0+IH0+KCcvYXBpL3Nlc3Npb25zP2xpbWl0PTEwMCcpKSk7XHJcblxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpzZW5kLXRhc2snLCAoZXZlbnQsIHRleHQ6IHVua25vd24sIHNlc3Npb25JZDogdW5rbm93biwgbW9kZTogdW5rbm93biwgYXR0YWNobWVudHM6IHVua25vd24sIGltYWdlczogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCB0YXNrID0gdHlwZW9mIHRleHQgPT09ICdzdHJpbmcnID8gdGV4dC5zbGljZSgwLCAyMF8wMDApIDogJyc7XHJcbiAgICAgIGNvbnN0IHNpZCA9IHR5cGVvZiBzZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gc2Vzc2lvbklkLnNsaWNlKDAsIDgwKSA6ICcnO1xyXG4gICAgICBjb25zdCBtID0gbW9kZSA9PT0gJ2F1dG8nIHx8IG1vZGUgPT09ICd5b2xvJyA/IG1vZGUgOiAnYXNrJztcclxuICAgICAgLy8gXHU5NjQ0XHU0RUY2Olx1NTQwRVx1N0FFRlx1NjM4OFx1Njc0MyBEVE8gXHU3Njg0XHU3RUREXHU1QkY5XHU4REVGXHU1Rjg0KEAgXHU5MDA5XHU2MkU5XHU1NjY4L1x1RDgzRFx1RENDRSBcdTRFMEFcdTRGMjBcdTUzRUFcdTY3NjVcdTgxRUFcdTY3MkNcdTU3MzBcdTY1ODdcdTRFRjZcdTdDRkJcdTdFREYpXHJcbiAgICAgIGNvbnN0IGF0dHMgPSBBcnJheS5pc0FycmF5KGF0dGFjaG1lbnRzKSA/IGF0dGFjaG1lbnRzLmZpbHRlcigoYSk6IGEgaXMgc3RyaW5nID0+IHR5cGVvZiBhID09PSAnc3RyaW5nJykuc2xpY2UoMCwgMTApIDogW107XHJcbiAgICAgIC8vIFx1NTZGRVx1NzI0NzpydW50aW1lIHZpc2lvbiBcdTk0RkVcdTUzNEZcdThCQUUge25hbWUsIGRhdGFVcmx9IGJhc2U2NChcdTIyNjQzIFx1NUYyMCBcdTIyNjQ2TUIscmVuZGVyZXIgXHU3NTFGXHU2MjEwKVxyXG4gICAgICBjb25zdCBpbWdzID0gQXJyYXkuaXNBcnJheShpbWFnZXMpXHJcbiAgICAgICAgPyBpbWFnZXNcclxuICAgICAgICAgICAgLmZpbHRlcigoaW0pOiBpbSBpcyB7IG5hbWU6IHN0cmluZzsgZGF0YVVybDogc3RyaW5nIH0gPT5cclxuICAgICAgICAgICAgICB0eXBlb2YgaW0gPT09ICdvYmplY3QnICYmIGltICE9PSBudWxsICYmIHR5cGVvZiAoaW0gYXMgeyBuYW1lPzogdW5rbm93biB9KS5uYW1lID09PSAnc3RyaW5nJyAmJiB0eXBlb2YgKGltIGFzIHsgZGF0YVVybD86IHVua25vd24gfSkuZGF0YVVybCA9PT0gJ3N0cmluZycpXHJcbiAgICAgICAgICAgIC5zbGljZSgwLCAzKVxyXG4gICAgICAgICAgICAubWFwKChpbSkgPT4gKHsgbmFtZTogaW0ubmFtZS5zbGljZSgwLCAxMjApLCBkYXRhVXJsOiBpbS5kYXRhVXJsLnNsaWNlKDAsIDhfNTAwXzAwMCkgfSkpXHJcbiAgICAgICAgOiBbXTtcclxuICAgICAgaWYgKHRhc2sgPT09ICcnIHx8IHNpZCA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBvazogZmFsc2UsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbjsgcnVuSWQ/OiBzdHJpbmcgfT4oJy9hcGkvdGFzaycsIHsgdGV4dDogdGFzaywgc2Vzc2lvbklkOiBzaWQsIG1vZGU6IG0sIGF0dGFjaG1lbnRzOiBhdHRzLCBpbWFnZXM6IGltZ3MgfSkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBcdTZBMjFcdTU3OEJcdTUyMDdcdTYzNjIocnVudGltZSBQT1NUIC9hcGkvbW9kZWw6XHU1MjA3IGNoYXQgXHU4REVGXHU3NTMxLGNvbmZpZyBcdTUzNzNcdTY1RjZcdTc1MUZcdTY1NDgpIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6bW9kZWwtc2V0JywgKGV2ZW50LCBuYW1lOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IG4gPSB0eXBlb2YgbmFtZSA9PT0gJ3N0cmluZycgPyBuYW1lLnRyaW0oKS5zbGljZSgwLCA4MCkgOiAnJztcclxuICAgICAgaWYgKG4gPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICduYW1lIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcclxuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuOyBtb2RlbD86IHN0cmluZyB9PignL2FwaS9tb2RlbCcsIHsgbmFtZTogbiB9KSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIFx1NUU5NFx1NzUyOFx1NTE4NVx1NjZGNFx1NjVCMChHaXRIdWIgUmVsZWFzZXM7XHU4MUVBXHU3ODE0XHU5NkY2XHU0RjlEXHU4RDU2XHU2NkY0XHU2NUIwXHU1NjY4KSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmNoZWNrLXVwZGF0ZScsIGFzeW5jIChldmVudCkgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICByZXR1cm4gY2hlY2tGb3JVcGRhdGVzKCk7XHJcbiAgICB9KTtcclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6YXBwbHktdXBkYXRlJywgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGlmIChpbnN0YWxsZXJQYXRoID09PSBudWxsKSByZXR1cm4geyBlcnJvcjogJ25vIGluc3RhbGxlciBkb3dubG9hZGVkJywgY29kZTogJ0hPU1RfTk9UX1JFQURZJyB9O1xyXG4gICAgICBhcHBseVVwZGF0ZSgpO1xyXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSB9O1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBcdTY4MDdcdTk4OThcdTY4MEZcdTRFM0JcdTk4OThcdTU0MENcdTZCNjUoXHU2RDQ1XHU4MjcyXHU2QTIxXHU1RjBGXHU0RTBEXHU1MThEXHU2NzA5XHU5RUQxXHU2NzYxKSsgXHUyNjMwIFx1NEUzQlx1ODNEQ1x1NTM1NSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmNocm9tZS10aGVtZScsIChldmVudCwgZGFyazogdW5rbm93bikgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBhcHBseUNocm9tZShkYXJrID09PSB0cnVlKTtcclxuICAgICAgcmV0dXJuIHsgb2s6IHRydWUgfTtcclxuICAgIH0pO1xyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpwb3B1cC1tYWluLW1lbnUnLCAoZXZlbnQpID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgcG9wdXBNYWluTWVudSgpO1xyXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSB9O1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBcdTYyNEJcdTY3M0FcdThGRENcdTdBMEJcdTYzQTdcdTUyMzYoNzc4OCB3ZWIgXHU1Qjg4XHU2MkE0O1x1NzUyOFx1NjIzN1x1NjYzRVx1NUYwRlx1NTQyRlx1NTJBOCxBRFItMDA1IFx1NEUwRFx1OUVEOFx1OEJBNFx1NUYwMCBMQU4pIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cmVtb3RlLXdlYi1zdGF0dXMnLCBhc3luYyAoZXZlbnQpID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgY29uc3QgcCA9IGF3YWl0IHByb2JlV2ViUmVtb3RlKCk7XHJcbiAgICAgIHJldHVybiB7IHVwOiBwLnVwLCB2ZXJzaW9uOiBwLnZlcnNpb24sIGxhbklwOiBsYW5JcE9mKCksIHBvcnQ6IFdFQl9QT1JULCBhdmFpbGFibGU6IGNsaUVudHJ5T2YoKSAhPT0gJycsIGF1dG9zdGFydDogd2ViQXV0b3N0YXJ0SW5zdGFsbGVkKCkgfTtcclxuICAgIH0pO1xyXG4gICAgLy8gLS0tLSBcdTVGMDBcdTY3M0FcdTgxRUFcdTU0MkYoMC4yMy4zNyB3ZWIgaW5zdGFsbC1kYWVtb24vdW5pbnN0YWxsLWRhZW1vbjtcdTc2N0JcdTVGNTVcdTUzNzNcdTVCODhcdTYyQTRcdTU3MjhcdTdFQkYpIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cmVtb3RlLXdlYi1hdXRvc3RhcnQnLCBhc3luYyAoZXZlbnQsIGVuYWJsZWQ6IHVua25vd24pID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgaWYgKGNsaUVudHJ5T2YoKSA9PT0gJycpIHJldHVybiB7IGVycm9yOiAnbm8gaG1oYXJuZXNzIHJ1bnRpbWUgZGV0ZWN0ZWQnLCBjb2RlOiAnSE9TVF9OT1RfUkVBRFknIH07XHJcbiAgICAgIHJ1bkNsaShbJ3dlYicsIGVuYWJsZWQgPT09IHRydWUgPyAnaW5zdGFsbC1kYWVtb24nIDogJ3VuaW5zdGFsbC1kYWVtb24nXSk7XHJcbiAgICAgIC8vIGluc3RhbGwtZGFlbW9uIFx1N0FDQlx1NTM3M1x1NjJDOVx1OEQ3N1x1NUI4OFx1NjJBNDpcdThGNkVcdThCRTJcdTc4NkVcdThCQTQ7dW5pbnN0YWxsIFx1NTM3M1x1NjVGNlx1NzUxRlx1NjU0OFxyXG4gICAgICBpZiAoZW5hYmxlZCA9PT0gdHJ1ZSkge1xyXG4gICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgNTA7IGkrKykge1xyXG4gICAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgNTAwKSk7XHJcbiAgICAgICAgICBpZiAoKGF3YWl0IHByb2JlV2ViUmVtb3RlKCkpLnVwKSByZXR1cm4geyBvazogdHJ1ZSwgYXV0b3N0YXJ0OiB3ZWJBdXRvc3RhcnRJbnN0YWxsZWQoKSB9O1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4geyBlcnJvcjogJ2RhZW1vbiBkaWQgbm90IGNvbWUgdXAgd2l0aGluIDI1cycsIGNvZGU6ICdSVU5USU1FX0NSQVNIRUQnIH07XHJcbiAgICAgIH1cclxuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGF1dG9zdGFydDogd2ViQXV0b3N0YXJ0SW5zdGFsbGVkKCkgfTtcclxuICAgIH0pO1xyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpyZW1vdGUtd2ViLXN0YXJ0JywgYXN5bmMgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGlmIChjbGlFbnRyeU9mKCkgPT09ICcnKSByZXR1cm4geyBlcnJvcjogJ25vIGhtaGFybmVzcyBydW50aW1lIGRldGVjdGVkJywgY29kZTogJ0hPU1RfTk9UX1JFQURZJyB9O1xyXG4gICAgICBpZiAoKGF3YWl0IHByb2JlV2ViUmVtb3RlKCkpLnVwKSB7XHJcbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGFscmVhZHk6IHRydWUsIGxhblVybDogYGh0dHA6Ly8ke2xhbklwT2YoKSB8fCAnMTI3LjAuMC4xJ306JHtXRUJfUE9SVH1gIH07XHJcbiAgICAgIH1cclxuICAgICAgcnVuQ2xpKFsnd2ViJywgJ3N0YXJ0JywgJy0tZXhwb3N1cmU9bGFuJ10pO1xyXG4gICAgICAvLyBcdTVCODhcdTYyQTRcdThGREJcdTdBMEJcdTUxQjdcdTU0MkZcdTUyQTgodHN4IFx1N0YxNlx1OEJEMVx1NjU3NFx1NTk1NyBDTEkpOlx1OEY2RVx1OEJFMiAyNXNcclxuICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCA1MDsgaSsrKSB7XHJcbiAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgNTAwKSk7XHJcbiAgICAgICAgaWYgKChhd2FpdCBwcm9iZVdlYlJlbW90ZSgpKS51cCkge1xyXG4gICAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGxhblVybDogYGh0dHA6Ly8ke2xhbklwT2YoKSB8fCAnMTI3LjAuMC4xJ306JHtXRUJfUE9SVH1gIH07XHJcbiAgICAgICAgfVxyXG4gICAgICB9XHJcbiAgICAgIHJldHVybiB7IGVycm9yOiAnd2ViIGRhZW1vbiBkaWQgbm90IGNvbWUgdXAgd2l0aGluIDI1cyAoc2VlIEhNSF9IT01FL3dlYi5sb2cpJywgY29kZTogJ1JVTlRJTUVfQ1JBU0hFRCcgfTtcclxuICAgIH0pO1xyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpyZW1vdGUtd2ViLXN0b3AnLCBhc3luYyAoZXZlbnQpID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgcnVuQ2xpKFsnd2ViJywgJ3N0b3AnXSk7XHJcbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgMjA7IGkrKykge1xyXG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDQwMCkpO1xyXG4gICAgICAgIGlmICghKGF3YWl0IHByb2JlV2ViUmVtb3RlKCkpLnVwKSByZXR1cm4geyBvazogdHJ1ZSB9O1xyXG4gICAgICB9XHJcbiAgICAgIGNvbnN0IHN0aWxsID0gKGF3YWl0IHByb2JlV2ViUmVtb3RlKCkpLnVwO1xyXG4gICAgICByZXR1cm4gc3RpbGwgPyB7IGVycm9yOiAnc3RpbGwgcnVubmluZycsIGNvZGU6ICdCUklER0VfRVJST1InIH0gOiB7IG9rOiB0cnVlIH07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIFx1RDgzRFx1RENDRSBcdTY1ODdcdTRFRjZcdTRFMEFcdTRGMjAoXHU2NzJDXHU1NzMwXHU1OTFBXHU5MDA5O3J1bnRpbWUgXHU2ODIxXHU5QThDIGluc2lkZVdzLFx1NURFNVx1NEY1Q1x1NTMzQVx1NTkxNlx1NjU4N1x1NEVGNlx1NEYxQVx1ODhBQiA0MDApIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cGljay1maWxlcycsIGFzeW5jIChldmVudCwgdGl0bGU6IHVua25vd24pID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgY29uc3Qgd2luID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkuZmluZCgodykgPT4gIXcuaXNEZXN0cm95ZWQoKSk7XHJcbiAgICAgIGlmICh3aW4gPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgZXJyb3I6ICdubyB3aW5kb3cnLCBjb2RlOiAnQlJJREdFX0VSUk9SJyB9O1xyXG4gICAgICBjb25zdCByID0gYXdhaXQgZGlhbG9nLnNob3dPcGVuRGlhbG9nKHdpbiwge1xyXG4gICAgICAgIHRpdGxlOiB0eXBlb2YgdGl0bGUgPT09ICdzdHJpbmcnICYmIHRpdGxlICE9PSAnJyA/IHRpdGxlLnNsaWNlKDAsIDEyMCkgOiAnXHU5MDA5XHU2MkU5XHU4OTgxXHU5NjQ0XHU1MkEwXHU3Njg0XHU2NTg3XHU0RUY2KFx1NTNFRlx1NTkxQVx1OTAwOSknLFxyXG4gICAgICAgIHByb3BlcnRpZXM6IFsnb3BlbkZpbGUnLCAnbXVsdGlTZWxlY3Rpb25zJ10sXHJcbiAgICAgIH0pO1xyXG4gICAgICBpZiAoci5jYW5jZWxlZCB8fCByLmZpbGVQYXRocy5sZW5ndGggPT09IDApIHJldHVybiB7IG9rOiBmYWxzZSwgY2FuY2VsZWQ6IHRydWUgfTtcclxuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHBhdGhzOiByLmZpbGVQYXRocy5zbGljZSgwLCAxMCkgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gXHVEODNEXHVEQ0MxIFx1NzZFRVx1NUY1NVx1OTAwOVx1NjJFOShcdTVERTVcdTRGNUNcdTUzM0FcdTZERkJcdTUyQTBcdTc2ODRcdTZENEZcdTg5QzhcdTYzMDlcdTk0QUU7XHU1MzlGXHU3NTFGIGNob29zZXIpIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cGljay1kaXJlY3RvcnknLCBhc3luYyAoZXZlbnQsIHRpdGxlOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IHdpbiA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmZpbmQoKHcpID0+ICF3LmlzRGVzdHJveWVkKCkpO1xyXG4gICAgICBpZiAod2luID09PSB1bmRlZmluZWQpIHJldHVybiB7IGVycm9yOiAnbm8gd2luZG93JywgY29kZTogJ0JSSURHRV9FUlJPUicgfTtcclxuICAgICAgY29uc3QgciA9IGF3YWl0IGRpYWxvZy5zaG93T3BlbkRpYWxvZyh3aW4sIHtcclxuICAgICAgICB0aXRsZTogdHlwZW9mIHRpdGxlID09PSAnc3RyaW5nJyAmJiB0aXRsZSAhPT0gJycgPyB0aXRsZS5zbGljZSgwLCAxMjApIDogJ1x1OTAwOVx1NjJFOVx1NjU4N1x1NEVGNlx1NTkzOScsXHJcbiAgICAgICAgcHJvcGVydGllczogWydvcGVuRGlyZWN0b3J5J10sXHJcbiAgICAgIH0pO1xyXG4gICAgICBpZiAoci5jYW5jZWxlZCB8fCByLmZpbGVQYXRoc1swXSA9PT0gdW5kZWZpbmVkKSByZXR1cm4geyBvazogZmFsc2UsIGNhbmNlbGVkOiB0cnVlIH07XHJcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBwYXRoOiByLmZpbGVQYXRoc1swXSB9O1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBAIFx1OTY0NFx1NEVGNjpcdTVERTVcdTRGNUNcdTUzM0FcdTY1ODdcdTRFRjZcdTY0MUNcdTdEMjIocnVudGltZSBcdTYzODhcdTY3NDNcdTc2ODRcdThERUZcdTVGODRcdTY3NjVcdTZFOTApIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6ZnMtc2VhcmNoJywgKGV2ZW50LCBxOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IHF1ZXJ5ID0gdHlwZW9mIHEgPT09ICdzdHJpbmcnID8gcS5zbGljZSgwLCAyMDApIDogJyc7XHJcbiAgICAgIGlmIChxdWVyeSA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyByZXN1bHRzOiBbXSB9KTtcclxuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPHsgcmVzdWx0czogQXJyYXk8eyByZWw6IHN0cmluZzsgcGF0aDogc3RyaW5nIH0+IH0+KGAvYXBpL2ZzL3NlYXJjaD9xPSR7ZW5jb2RlVVJJQ29tcG9uZW50KHF1ZXJ5KX1gKSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmFwcHJvdmUnLCAoZXZlbnQsIGdyYW50ZWQ6IHVua25vd24sIHNlc3Npb25JZDogdW5rbm93bikgPT5cclxuICAgICAgaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvYXBwcm92ZScsIHtcclxuICAgICAgICBncmFudGVkOiBncmFudGVkID09PSB0cnVlLFxyXG4gICAgICAgIHNlc3Npb25JZDogdHlwZW9mIHNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBzZXNzaW9uSWQuc2xpY2UoMCwgODApIDogJycsXHJcbiAgICAgIH0pKSk7XHJcblxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTppbnRlcnJ1cHQnLCAoZXZlbnQsIHNlc3Npb25JZDogdW5rbm93bikgPT5cclxuICAgICAgaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvaW50ZXJydXB0Jywge1xyXG4gICAgICAgIHNlc3Npb25JZDogdHlwZW9mIHNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBzZXNzaW9uSWQuc2xpY2UoMCwgODApIDogJycsXHJcbiAgICAgIH0pKSk7XHJcblxyXG4gICAgLy8gLS0tLSBNNDpcdTVERTVcdTRGNUNcdTUzM0FcdTY1ODdcdTRFRjZcdTk3NjIoXHU4REVGXHU1Rjg0XHU2Mzg4XHU2NzQzXHU1NzI4IHJ1bnRpbWU6aW5zaWRlV3MgXHU2ODIxXHU5QThDKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmZzLWxpc3QnLCAoZXZlbnQsIHBhdGg6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3QgcCA9IHR5cGVvZiBwYXRoID09PSAnc3RyaW5nJyA/IHBhdGguc2xpY2UoMCwgMTAwMCkgOiAnJztcclxuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPFJlY29yZDxzdHJpbmcsIHVua25vd24+PihgL2FwaS9mcz9maWxlcz0xJHtwICE9PSAnJyA/IGAmcGF0aD0ke2VuY29kZVVSSUNvbXBvbmVudChwKX1gIDogJyd9YCkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpmcy1yZWFkJywgKGV2ZW50LCBwYXRoOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IHAgPSB0eXBlb2YgcGF0aCA9PT0gJ3N0cmluZycgPyBwYXRoLnNsaWNlKDAsIDEwMDApIDogJyc7XHJcbiAgICAgIGlmIChwID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAncGF0aCByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oYC9hcGkvZnMvcmVhZD9wYXRoPSR7ZW5jb2RlVVJJQ29tcG9uZW50KHApfWApKTtcclxuICAgIH0pO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6aW5qZWN0JywgKGV2ZW50LCB0ZXh0OiB1bmtub3duLCBzZXNzaW9uSWQ6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3QgdCA9IHR5cGVvZiB0ZXh0ID09PSAnc3RyaW5nJyA/IHRleHQuc2xpY2UoMCwgMjBfMDAwKSA6ICcnO1xyXG4gICAgICBjb25zdCBzaWQgPSB0eXBlb2Ygc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IHNlc3Npb25JZC5zbGljZSgwLCA4MCkgOiAnJztcclxuICAgICAgaWYgKHQgPT09ICcnIHx8IHNpZCA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBvazogZmFsc2UsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PignL2FwaS9pbmplY3QnLCB7IHRleHQ6IHQsIHNlc3Npb25JZDogc2lkIH0pKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gXHU0RjFBXHU4QkREXHU1QkZDXHU1MUZBKGV4cG9ydC5tZCBcdTIxOTIgXHU0RkREXHU1QjU4XHU1QkY5XHU4QkREXHU2ODQ2O1x1NjU4N1x1NEVGNlx1NTE5OVx1NTE2NVx1NTNFQVx1NTcyOCBtYWluKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmV4cG9ydC1zZXNzaW9uJywgYXN5bmMgKGV2ZW50LCBpZDogdW5rbm93biwgdGl0bGU6IHVua25vd24pID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIGlkID09PSAnc3RyaW5nJyA/IGlkLnJlcGxhY2UoL1teYS16QS1aMC05XzouQC1dL2csICcnKS5zbGljZSgwLCA4MCkgOiAnJztcclxuICAgICAgaWYgKHNpZCA9PT0gJycpIHJldHVybiB7IGVycm9yOiAnaWQgcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH07XHJcbiAgICAgIGlmIChjbGllbnQgPT09IG51bGwgfHwgYnJpZGdlLmhvc3RTdGF0ZSAhPT0gJ3JlYWR5JykgcmV0dXJuIHsgZXJyb3I6IGBob3N0IG5vdCByZWFkeSAoJHticmlkZ2UuaG9zdFN0YXRlfSlgLCBjb2RlOiAnSE9TVF9OT1RfUkVBRFknIH07XHJcbiAgICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgbWQgPSBhd2FpdCBjbGllbnQuZ2V0VGV4dChgL2FwaS9zZXNzaW9ucy8ke2VuY29kZVVSSUNvbXBvbmVudChzaWQpfS9leHBvcnQubWRgKTtcclxuICAgICAgICBjb25zdCB3aW4gPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5maW5kKCh3KSA9PiAhdy5pc0Rlc3Ryb3llZCgpKTtcclxuICAgICAgICBpZiAod2luID09PSB1bmRlZmluZWQpIHJldHVybiB7IGVycm9yOiAnbm8gd2luZG93JywgY29kZTogJ0JSSURHRV9FUlJPUicgfTtcclxuICAgICAgICBjb25zdCByID0gYXdhaXQgZGlhbG9nLnNob3dTYXZlRGlhbG9nKHdpbiwge1xyXG4gICAgICAgICAgdGl0bGU6IHR5cGVvZiB0aXRsZSA9PT0gJ3N0cmluZycgJiYgdGl0bGUgIT09ICcnID8gdGl0bGUuc2xpY2UoMCwgODApIDogJ1x1NUJGQ1x1NTFGQVx1NEYxQVx1OEJERCcsXHJcbiAgICAgICAgICBkZWZhdWx0UGF0aDogYGhtaC0ke3NpZH0ubWRgLFxyXG4gICAgICAgICAgZmlsdGVyczogW3sgbmFtZTogJ01hcmtkb3duJywgZXh0ZW5zaW9uczogWydtZCddIH1dLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIGlmIChyLmNhbmNlbGVkIHx8IHIuZmlsZVBhdGggPT09IHVuZGVmaW5lZCB8fCByLmZpbGVQYXRoID09PSAnJykgcmV0dXJuIHsgb2s6IGZhbHNlLCBjYW5jZWxlZDogdHJ1ZSB9O1xyXG4gICAgICAgIGF3YWl0IHdyaXRlRmlsZShyLmZpbGVQYXRoLCBtZCwgJ3V0ZjgnKTtcclxuICAgICAgICBsb2dJbmZvKCdleHBvcnQnLCBgc2Vzc2lvbiAke3NpZH0gXHUyMTkyICR7ci5maWxlUGF0aH1gKTtcclxuICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgcGF0aDogci5maWxlUGF0aCB9O1xyXG4gICAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgICBjb25zdCBkZXRhaWwgPSAoKCkgPT4geyB0cnkgeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkoZXJyKTsgfSBjYXRjaCB7IHJldHVybiBTdHJpbmcoZXJyKTsgfSB9KSgpLnNsaWNlKDAsIDMwMCk7XHJcbiAgICAgICAgcmV0dXJuIHsgZXJyb3I6IGRldGFpbCwgY29kZTogJ0JSSURHRV9FUlJPUicgfTtcclxuICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBcdTVCQTFcdTYyNzlcdTZBMjFcdTVGMEZcdThCRkJcdTUxOTkoXHU2NzQzXHU1QTAxXHU1NzI4IHJ1bnRpbWUgY29uZmlnO1x1NTIwN1x1NjM2Mlx1NUZDNVx1OTg3Qlx1NjYzRVx1NUYwRikgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTphcHByb3ZhbC1nZXQnLCAoZXZlbnQpID0+XHJcbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPHsgc2V0dGluZ3M/OiB7IGFwcHJvdmFsPzogc3RyaW5nIH0gfT4oJy9hcGkvc3RhdGUnKSkpO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6YXBwcm92YWwtc2V0JywgKGV2ZW50LCBtb2RlOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IG0gPSBtb2RlID09PSAnYXV0bycgPyAnYXV0bycgOiBtb2RlID09PSAnYXNrJyA/ICdhc2snIDogJyc7XHJcbiAgICAgIGlmIChtID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAnbW9kZSBtdXN0IGJlIGFza3xhdXRvJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcclxuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KCcvYXBpL2NvbmZpZycsIHsgYXBwcm92YWw6IG0gfSkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBobWhhcm5lc3MgcnVudGltZSBcdThGREVcdTYzQTUoXHU4MUVBXHU1MkE4XHU1M0QxXHU3M0IwICsgXHU2MjRCXHU1MkE4XHU4OTg2XHU3NkQ2ICsgXHU3MEVEXHU1MjA3XHU2MzYyKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnJ1bnRpbWUtaW5mbycsIGFzeW5jIChldmVudCkgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBjb25zdCBkID0gZGV0ZWN0RXh0ZXJuYWxSdW50aW1lKCk7XHJcbiAgICAgIGNvbnN0IGNmZyA9IGF3YWl0IGxvYWRSdW50aW1lQ29uZmlnKCk7XHJcbiAgICAgIHJldHVybiB7XHJcbiAgICAgICAgbW9kZTogYnJpZGdlLm1vZGUsXHJcbiAgICAgICAgcnVudGltZUVudHJ5OiBicmlkZ2UucnVudGltZUVudHJ5LFxyXG4gICAgICAgIG92ZXJyaWRlOiBjZmcuZW50cnksXHJcbiAgICAgICAgZGVtbzogY2ZnLmRlbW8sXHJcbiAgICAgICAgZGV0ZWN0ZWQ6IGQuZW50cnksXHJcbiAgICAgICAgZGV0ZWN0ZWRWZXJzaW9uOiBkLnZlcnNpb24sXHJcbiAgICAgICAgZGV0ZWN0ZWRTb3VyY2U6IGQuc291cmNlLFxyXG4gICAgICB9O1xyXG4gICAgfSk7XHJcblxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpicm93c2UtcnVudGltZScsIGFzeW5jIChldmVudCwgdGl0bGU6IHVua25vd24pID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgY29uc3Qgd2luID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkuZmluZCgodykgPT4gIXcuaXNEZXN0cm95ZWQoKSk7XHJcbiAgICAgIGlmICh3aW4gPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgZXJyb3I6ICdubyB3aW5kb3cnLCBjb2RlOiAnQlJJREdFX0VSUk9SJyB9O1xyXG4gICAgICBjb25zdCByID0gYXdhaXQgZGlhbG9nLnNob3dPcGVuRGlhbG9nKHdpbiwge1xyXG4gICAgICAgIHRpdGxlOiB0eXBlb2YgdGl0bGUgPT09ICdzdHJpbmcnICYmIHRpdGxlICE9PSAnJyA/IHRpdGxlLnNsaWNlKDAsIDEyMCkgOiAnXHU5MDA5XHU2MkU5IGhtaGFybmVzcyBcdTc2ODQgZGVza3RvcC1ob3N0IFx1NTE2NVx1NTNFMycsXHJcbiAgICAgICAgcHJvcGVydGllczogWydvcGVuRmlsZSddLFxyXG4gICAgICAgIGZpbHRlcnM6IFt7IG5hbWU6ICdkZXNrdG9wLWhvc3QnLCBleHRlbnNpb25zOiBbJ3RzJywgJ2pzJ10gfV0sXHJcbiAgICAgIH0pO1xyXG4gICAgICBpZiAoci5jYW5jZWxlZCB8fCByLmZpbGVQYXRoc1swXSA9PT0gdW5kZWZpbmVkKSByZXR1cm4geyBvazogZmFsc2UsIGNhbmNlbGVkOiB0cnVlIH07XHJcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBlbnRyeTogci5maWxlUGF0aHNbMF0gfTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qKiBcdThCQkVcdTdGNkUvXHU2RTA1XHU5NjY0XHU2MjRCXHU1MkE4XHU1MTY1XHU1M0UzXHU1NDBFXHU3MEVEXHU5MUNEXHU1NDJGIGhvc3QoXHU3QTdBXHU0RTMyPVx1NTZERVx1NTIzMFx1ODFFQVx1NTJBOFx1NTNEMVx1NzNCMClcdTMwMDIgKi9cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6c2V0LXJ1bnRpbWUnLCBhc3luYyAoZXZlbnQsIGVudHJ5OiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IGUgPSB0eXBlb2YgZW50cnkgPT09ICdzdHJpbmcnID8gZW50cnkudHJpbSgpIDogJyc7XHJcbiAgICAgIGlmIChlICE9PSAnJyAmJiAoIWlzQWJzb2x1dGUoZSkgfHwgIWV4aXN0c1N5bmMoZSkpKSB7XHJcbiAgICAgICAgcmV0dXJuIHsgZXJyb3I6ICdcdTUxNjVcdTUzRTNcdTVGQzVcdTk4N0JcdTY2MkZcdTVCNThcdTU3MjhcdTc2ODRcdTdFRERcdTVCRjlcdThERUZcdTVGODQoZGVza3RvcC1ob3N0LnRzKScsIGNvZGU6ICdCQURfUkVRVUVTVCcgfTtcclxuICAgICAgfVxyXG4gICAgICBhd2FpdCBzYXZlUnVudGltZUVudHJ5T3ZlcnJpZGUoZSk7XHJcbiAgICAgIC8vIFx1NzBFRFx1NTIwN1x1NjM2MjpcdTUxNDhcdTRGMThcdTk2QzVcdTUwNUNcdTYzODlcdTVGNTNcdTUyNEQgaG9zdCxcdTUxOERcdTYzMDlcdTY1QjBcdTkxNERcdTdGNkVcdTYyQzlcdThENzdcclxuICAgICAgc3NlQWJvcnQ/LmFib3J0KCk7XHJcbiAgICAgIGlmIChzdXBlcnZpc29yICE9PSBudWxsKSBhd2FpdCBzdXBlcnZpc29yLnN0b3AoKTtcclxuICAgICAgYXdhaXQgc3RhcnRIb3N0KCk7XHJcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBtb2RlOiBicmlkZ2UubW9kZSB9O1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSB2NS4xIFx1OTk5Nlx1NTQyRlx1NUI4OVx1ODhDNVx1NTQxMVx1NUJGQzpcdTY3MkNcdTY3M0FcdTY4QzBcdTZENEIgLyBcdTRFMEJcdThGN0RcdTVCODlcdTg4QzUoXHU4RkRCXHU1RUE2XHU0RThCXHU0RUY2KSAvIFx1NTQxMVx1NUJGQ1x1NzJCNlx1NjAwMSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmRldGVjdC1ydW50aW1lJywgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IGluZm8gPSBidW5kbGVkUnVudGltZUluZm8oKTtcclxuICAgICAgLy8gVUlWRVJJRlkgXHU1NDExXHU1QkZDXHU2QjY1XHU3Njg0XCJcdTRGMkFcdTkwMjBcdTY3MkFcdTkxNERcdTdGNkVcdTYwMDFcIjpmYWtlIFx1NkEyMVx1NUYwRlx1NEUwQlx1NjA1Mlx1NjJBNVx1NjcyQVx1NjhDMFx1NkQ0QlxyXG4gICAgICAvLyAoXHU3NzFGXHU1QjlFXHU2OEMwXHU2RDRCXHU4REVGXHU1Rjg0XHU3NTMxIHJlYWwgXHU1M0Q4XHU0RjUzXHU5QThDXHU2NTM2LFx1ODlDMSBldmlkZW5jZS9zZXR1cC13aXphcmQvKVx1MzAwMlxyXG4gICAgICAvLyBVSVZFUklGWV9GQUtFX0RFVEVDVF9GT1VORD0xKHVpdmVyaWZ5IFx1N0E4NFx1NUM0Rlx1NTczQVx1NjY2Rlx1OEZEMFx1ODg0Q1x1NEUyRFx1NTJBOFx1NjAwMVx1N0Y2RVx1NEY0RCk6XHJcbiAgICAgIC8vIFx1NEYyQVx1OTAyMFwiXHU2OEMwXHU2RDRCXHU1MjMwXHU1REYyXHU4OEM1XCIsXHU4QkE5XHU1NDExXHU1QkZDXHU1MUZBXHU3M0IwXHU2OEMwXHU2RDRCXHU5ODc1XHU0RTA5XHU5MDA5XHU5ODc5IFx1MjE5MiBcdTUzNTVcdTUxRkJcdTUyNERcdThGREIgXHUyMTkyIFx1OTAwOVx1NjJFOVx1OTg3NVx1MzAwMlxyXG4gICAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfV0laQVJEID09PSAnZmFrZScgJiYgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfRkFLRSA9PT0gJzEnKSB7XHJcbiAgICAgICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX0ZBS0VfREVURUNUX0ZPVU5EID09PSAnMScpIHtcclxuICAgICAgICAgIHJldHVybiB7IGZvdW5kOiB0cnVlLCB2ZXJzaW9uOiAnMC4wLjAtdmVyaWZ5JywgZW50cnk6ICd2ZXJpZnk6Ly9mYWtlLWVudHJ5Jywgc291cmNlOiAndmVyaWZ5JywgYnVuZGxlZDogaW5mbywgbnBtOiBucG1PblBhdGgoKSB9O1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4geyBmb3VuZDogZmFsc2UsIHZlcnNpb246ICcnLCBlbnRyeTogJycsIHNvdXJjZTogJycsIGJ1bmRsZWQ6IGluZm8sIG5wbTogbnBtT25QYXRoKCkgfTtcclxuICAgICAgfVxyXG4gICAgICBjb25zdCBkID0gZGV0ZWN0RXh0ZXJuYWxSdW50aW1lKCk7XHJcbiAgICAgIHJldHVybiB7IGZvdW5kOiBkLmVudHJ5ICE9PSAnJywgdmVyc2lvbjogZC52ZXJzaW9uLCBlbnRyeTogZC5lbnRyeSwgc291cmNlOiBkLnNvdXJjZSwgYnVuZGxlZDogaW5mbywgbnBtOiBucG1PblBhdGgoKSB9O1xyXG4gICAgfSk7XHJcblxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTppbnN0YWxsLWNsaScsIChldmVudCwgb3B0czogdW5rbm93bikgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBjb25zdCBvID0gKG9wdHMgPz8ge30pIGFzIHsgZm9yY2VUZ3o/OiB1bmtub3duOyBtaXJyb3JGaXJzdD86IHVua25vd24gfTtcclxuICAgICAgLy8gVUlWRVJJRlkgZmFrZSBcdTU0MTFcdTVCRkM6XHU4MUVBXHU1MkE4XHU1Qjg5XHU4OEM1XHU4REVGXHU1Rjg0XHU4RDcwXHU2QTIxXHU2MkRGXHU4RkRCXHU1RUE2KFx1NEUwRFx1NzhCMFx1NzhDMVx1NzZEOC9cdTdGNTFcdTdFREMvXHU0RTBEXHU3MEVEXHU1MjA3XHU2MzYyKSxcclxuICAgICAgLy8gXHU0RTE0XHU0RTBEXHU1M0QxIGRvbmVcdTIwMTRcdTIwMTRcdTlBOENcdTY1MzZcdTg5ODFcdTU3MjhcdTVCODlcdTg4QzVcdTk4NzVcdTcwQjlcIlx1NjUzOVx1NzUyOFx1NTE4NVx1N0Y2RVwiXHU1MjA3XHU2MzYyXHU5NEZFXHU2M0E1XHUzMDAyXHJcbiAgICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9XSVpBUkQgPT09ICdmYWtlJyAmJiBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9GQUtFID09PSAnMScpIHtcclxuICAgICAgICBjb25zdCBzZW5kU2ltID0gKHA6IEluc3RhbGxQcm9ncmVzcyk6IHZvaWQgPT4ge1xyXG4gICAgICAgICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XHJcbiAgICAgICAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ2luc3RhbGw6cHJvZ3Jlc3MnLCBwKTtcclxuICAgICAgICAgIH1cclxuICAgICAgICB9O1xyXG4gICAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcclxuICAgICAgICAgIHNlbmRTaW0oeyBwaGFzZTogJ2NoZWNrJywgdGV4dDogJ1x1NjhDMFx1NjdFNSBucG1cdTIwMjYodmVyaWZ5IFx1NkEyMVx1NjJERiknIH0pO1xyXG4gICAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgNDAwKSk7XHJcbiAgICAgICAgICBzZW5kU2ltKHsgcGhhc2U6ICducG0nLCB0ZXh0OiAnbnBtIGluc3RhbGwgQGhtaGFybmVzcy9jbGkgXHUyMTkyIH4vLmhtaGFybmVzcy1nbG9iYWwodmVyaWZ5IFx1NkEyMVx1NjJERixcdTRFMERcdTg0M0RcdTc2RDgpJyB9KTtcclxuICAgICAgICB9KSgpO1xyXG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCB0ZXN0OiB0cnVlIH07XHJcbiAgICAgIH1cclxuICAgICAgcmV0dXJuIHN0YXJ0Q2xpSW5zdGFsbChcclxuICAgICAgICB7XHJcbiAgICAgICAgICBzZW5kUHJvZ3Jlc3M6IChwOiBJbnN0YWxsUHJvZ3Jlc3MpOiB2b2lkID0+IHtcclxuICAgICAgICAgICAgbG9nSW5mbygnaW5zdGFsbCcsIGAke3AucGhhc2V9JHtwLnBjdCAhPT0gdW5kZWZpbmVkID8gYCAke3AucGN0fSVgIDogJyd9ICR7cC50ZXh0fWApO1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcclxuICAgICAgICAgICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCdpbnN0YWxsOnByb2dyZXNzJywgcCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgIH0sXHJcbiAgICAgICAgICBsb2c6IChtOiBzdHJpbmcpOiB2b2lkID0+IHsgbG9nSW5mbygnaW5zdGFsbCcsIG0pOyB9LFxyXG4gICAgICAgICAgLy8gXHU1Qjg5XHU4OEM1XHU2MjEwXHU1MjlGXHU1MzczXHU2MzAxXHU0RTQ1XHU1MzE2XHU1RTc2XHU3MEVEXHU1MjA3XHU2MzYyKFx1NTQxMVx1NUJGQ1x1OTY4Rlx1NTQwRVx1NjUzNlx1NUMzRTtcdTRFMkRcdTkwMTRcdTUzRDZcdTZEODhcdTRFNUZcdTVERjJcdTc1MUZcdTY1NDgpXHJcbiAgICAgICAgICBvbkluc3RhbGxlZDogKGVudHJ5OiBzdHJpbmcpOiB2b2lkID0+IHtcclxuICAgICAgICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgICAgICAgIGF3YWl0IHNhdmVSdW50aW1lQ29uZmlnKHsgZW50cnksIGRlbW86IGZhbHNlIH0pO1xyXG4gICAgICAgICAgICAgIHNzZUFib3J0Py5hYm9ydCgpO1xyXG4gICAgICAgICAgICAgIGlmIChzdXBlcnZpc29yICE9PSBudWxsKSBhd2FpdCBzdXBlcnZpc29yLnN0b3AoKTtcclxuICAgICAgICAgICAgICBhd2FpdCBzdGFydEhvc3QoKTtcclxuICAgICAgICAgICAgfSkoKTtcclxuICAgICAgICAgIH0sXHJcbiAgICAgICAgfSxcclxuICAgICAgICB7XHJcbiAgICAgICAgICBmb3JjZVRnejogby5mb3JjZVRneiA9PT0gdHJ1ZSxcclxuICAgICAgICAgIG1pcnJvckZpcnN0OiBvLm1pcnJvckZpcnN0ID09PSAnbnBtbWlycm9yJyA/ICducG1taXJyb3InIDogby5taXJyb3JGaXJzdCA9PT0gJ25wbWpzJyA/ICducG1qcycgOiB1bmRlZmluZWQsXHJcbiAgICAgICAgfSxcclxuICAgICAgKTtcclxuICAgIH0pO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6Z2V0LXdpemFyZCcsIGFzeW5jIChldmVudCkgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBjb25zdCB2YXJpYW50ID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfV0laQVJEO1xyXG4gICAgICBpZiAodmFyaWFudCAhPT0gdW5kZWZpbmVkICYmIHZhcmlhbnQgIT09ICcnKSB7XHJcbiAgICAgICAgLy8gXHU5QThDXHU2NTM2XHU2Nzg0XHU5MDIwOlx1NUYzQVx1NTIzNlx1NTQxMVx1NUJGQ1x1NTNFRlx1ODlDMVx1NEUxNFx1ODlDNlx1NEUzQVx1NjcyQVx1OTE0RFx1N0Y2RShcdTUzRUZcdTkxQ0RcdTU5MERcdThERDEpO3BlcnNpc3RlZD1cdTc3MUZcdTVCOUVcdTg0M0RcdTc2RDhcclxuICAgICAgICAvLyBcdTcyQjZcdTYwMDEoXHU1NDExXHU1QkZDXHU2QjY1XHU2NUFEXHU4QTAwXCJcdTkwMDlcdTYyRTlcdTYzMDFcdTRFNDVcIlx1NzUyOCxcdTRFMERcdTVGNzFcdTU0Q0QgVUkgXHU1MjI0XHU1QjlBKVxyXG4gICAgICAgIGNvbnN0IHcgPSBhd2FpdCBsb2FkV2l6YXJkU3RhdGUoKTtcclxuICAgICAgICByZXR1cm4geyBkb25lOiBmYWxzZSwgY2hvaWNlOiAnJywgc3VwcHJlc3NlZDogZmFsc2UsIHBlcnNpc3RlZDogeyBkb25lOiB3LmRvbmUsIGNob2ljZTogdy5jaG9pY2UgfSB9O1xyXG4gICAgICB9XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCBsb2FkV2l6YXJkU3RhdGUoKTtcclxuICAgICAgY29uc3QgY2ZnID0gYXdhaXQgbG9hZFJ1bnRpbWVDb25maWcoKTtcclxuICAgICAgLy8gXHU1REYyXHU5MTREXHU3RjZFXHU4RkM3IHJ1bnRpbWUoXHU2MjRCXHU1MkE4XHU1MTY1XHU1M0UzL1x1NTQxMVx1NUJGQ1x1OTAwOVx1NjJFOS9cdTZGMTRcdTc5M0EpXHU4OUM2XHU1NDBDXHU1REYyXHU1QjhDXHU2MjEwXHU5OTk2XHU1NDJGXHJcbiAgICAgIHJldHVybiB7IGRvbmU6IHcuZG9uZSB8fCBjZmcuZW50cnkgIT09ICcnIHx8IGNmZy5kZW1vLCBjaG9pY2U6IHcuY2hvaWNlLCBzdXBwcmVzc2VkOiB3aXphcmRTdXBwcmVzc2VkKCkgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qKiBcdTU0MTFcdTVCRkNcdTY1MzZcdTVDM0U6XHU2MzAxXHU0RTQ1XHU1MzE2XHU5MDA5XHU2MkU5XHU1RTc2XHU1RTk0XHU3NTI4KGV4dGVybmFsL2J1bmRsZWRcdTIxOTJcdTUxNjVcdTUzRTNcdTg5ODZcdTc2RDY7ZGVtb1x1MjE5Mlx1NjMwMVx1NEU0NVx1NkYxNFx1NzkzQTtcclxuICAgICAqICBpbnN0YWxsXHUyMTkyXHU1MTY1XHU1M0UzXHU1REYyXHU3NTMxXHU1Qjg5XHU4OEM1XHU1NjY4XHU2MzAxXHU0RTQ1XHU1MzE2LFx1NTNFQVx1OEJCMFx1NzJCNlx1NjAwMSlcdTMwMDJmYWtlL1x1NkQ0Qlx1OEJENVx1NzNBRlx1NTg4M1x1NTNFQVx1OEJCMFx1NzJCNlx1NjAwMVx1MzAwMiAqL1xyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTp3aXphcmQtY29tcGxldGUnLCBhc3luYyAoZXZlbnQsIGNob2ljZTogdW5rbm93biwgZW50cnk6IHVua25vd24pID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgY29uc3QgYyA9IGNob2ljZSA9PT0gJ2V4dGVybmFsJyB8fCBjaG9pY2UgPT09ICdpbnN0YWxsJyB8fCBjaG9pY2UgPT09ICdidW5kbGVkJyB8fCBjaG9pY2UgPT09ICdkZW1vJyA/IGNob2ljZSA6ICcnO1xyXG4gICAgICBpZiAoYyA9PT0gJycpIHJldHVybiB7IGVycm9yOiAnY2hvaWNlIG11c3QgYmUgZXh0ZXJuYWx8aW5zdGFsbHxidW5kbGVkfGRlbW8nLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH07XHJcbiAgICAgIGNvbnN0IGUgPSB0eXBlb2YgZW50cnkgPT09ICdzdHJpbmcnID8gZW50cnkgOiAnJztcclxuICAgICAgYXdhaXQgc2F2ZVdpemFyZFN0YXRlKGMpO1xyXG4gICAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfRkFLRSA9PT0gJzEnKSByZXR1cm4geyBvazogdHJ1ZSwgbW9kZTogYnJpZGdlLm1vZGUsIHRlc3Q6IHRydWUgfTtcclxuICAgICAgY29uc3QgcmVwb1Jvb3QgPSBqb2luKGhlcmUsICcuLicsICcuLicsICcuLicsICcuLicpO1xyXG4gICAgICBpZiAoYyA9PT0gJ2V4dGVybmFsJyB8fCBjID09PSAnYnVuZGxlZCcpIHtcclxuICAgICAgICBjb25zdCB0YXJnZXQgPSBjID09PSAnYnVuZGxlZCcgPyBidW5kbGVkUnVudGltZVBhdGgocmVwb1Jvb3QpIDogZTtcclxuICAgICAgICBpZiAodGFyZ2V0ID09PSAnJyB8fCAhaXNBYnNvbHV0ZSh0YXJnZXQpIHx8ICFleGlzdHNTeW5jKHRhcmdldCkpIHtcclxuICAgICAgICAgIHJldHVybiB7IGVycm9yOiAncnVudGltZSBcdTUxNjVcdTUzRTNcdTRFMERcdTVCNThcdTU3MjgnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH07XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGF3YWl0IHNhdmVSdW50aW1lQ29uZmlnKHsgZW50cnk6IHRhcmdldCwgZGVtbzogZmFsc2UgfSk7XHJcbiAgICAgIH0gZWxzZSBpZiAoYyA9PT0gJ2RlbW8nKSB7XHJcbiAgICAgICAgYXdhaXQgc2F2ZVJ1bnRpbWVDb25maWcoeyBlbnRyeTogJycsIGRlbW86IHRydWUgfSk7XHJcbiAgICAgIH1cclxuICAgICAgaWYgKGMgIT09ICdpbnN0YWxsJykge1xyXG4gICAgICAgIC8vIGluc3RhbGw6XHU1Qjg5XHU4OEM1XHU1NjY4XHU1REYyXHU1NzI4IG9uSW5zdGFsbGVkIFx1NjMwMVx1NEU0NVx1NTMxNlx1NUU3Nlx1NzBFRFx1NTIwN1x1NjM2MixcdThGRDlcdTkxQ0NcdTRFMERcdTUxOERcdTkxQ0RcdTU0MkZcclxuICAgICAgICBzc2VBYm9ydD8uYWJvcnQoKTtcclxuICAgICAgICBpZiAoc3VwZXJ2aXNvciAhPT0gbnVsbCkgYXdhaXQgc3VwZXJ2aXNvci5zdG9wKCk7XHJcbiAgICAgICAgYXdhaXQgc3RhcnRIb3N0KCk7XHJcbiAgICAgIH1cclxuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIG1vZGU6IGJyaWRnZS5tb2RlIH07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIFByb3ZpZGVyIFx1OEJCRVx1N0Y2RSgwMyBcdTAwQTdcdTRFMDM6a2V5IFx1NTNFQVx1NTFGQSBoYXNLZXkvXHU2NzJCXHU1NkRCXHU0RjREO1x1NEZERFx1NUI1OFx1NzZGNFx1NTE5OSBydW50aW1lKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnByb3ZpZGVycycsIChldmVudCkgPT5cclxuICAgICAgaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248eyBwcm92aWRlcnNEZXRhaWw/OiBBcnJheTx7IG5hbWU6IHN0cmluZzsgbW9kZWw6IHN0cmluZzsgYmFzZVVybDogc3RyaW5nOyBoYXNLZXk6IGJvb2xlYW47IGtleVRhaWw/OiBzdHJpbmcgfT47IG1vZGVsPzogc3RyaW5nIH0+KCcvYXBpL3N0YXRlJykpKTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnByb3ZpZGVyLXNhdmUnLCAoZXZlbnQsIHByb3ZpZGVyOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IHAgPSBwcm92aWRlciBhcyB7IG5hbWU/OiB1bmtub3duOyBiYXNlVXJsPzogdW5rbm93bjsgbW9kZWw/OiB1bmtub3duOyBhcGlLZXk/OiB1bmtub3duIH07XHJcbiAgICAgIGNvbnN0IG5hbWUgPSB0eXBlb2YgcD8ubmFtZSA9PT0gJ3N0cmluZycgPyBwLm5hbWUuc2xpY2UoMCwgODApIDogJyc7XHJcbiAgICAgIGNvbnN0IGJhc2VVcmwgPSB0eXBlb2YgcD8uYmFzZVVybCA9PT0gJ3N0cmluZycgPyBwLmJhc2VVcmwuc2xpY2UoMCwgMzAwKSA6ICcnO1xyXG4gICAgICBjb25zdCBtb2RlbCA9IHR5cGVvZiBwPy5tb2RlbCA9PT0gJ3N0cmluZycgPyBwLm1vZGVsLnNsaWNlKDAsIDEyMCkgOiAnJztcclxuICAgICAgaWYgKG5hbWUgPT09ICcnIHx8IGJhc2VVcmwgPT09ICcnIHx8IG1vZGVsID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAnbmFtZS9iYXNlVXJsL21vZGVsIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcclxuICAgICAgY29uc3QgYm9keTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7IG5hbWUsIGJhc2VVcmwsIG1vZGVsIH07XHJcbiAgICAgIC8vIGFwaUtleSBcdTUzRUFcdTU3MjhcdTY2M0VcdTVGMEZcdThGOTNcdTUxNjVcdTY1RjZcdTRFMEFcdTRGMjAsXHU3RUREXHU0RTBEXHU1NkRFXHU2NjNFKHJlbmRlcmVyIFx1ODg2OFx1NTM1NVx1NjNEMFx1NEVBNFx1NTQwRVx1NTM3M1x1NkUwNVx1N0E3QSlcclxuICAgICAgaWYgKHR5cGVvZiBwPy5hcGlLZXkgPT09ICdzdHJpbmcnICYmIHAuYXBpS2V5ICE9PSAnJykgYm9keS5hcGlLZXkgPSBwLmFwaUtleS5zbGljZSgwLCAzMDApO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvcHJvdmlkZXJzJywgYm9keSkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBcdTVERTVcdTRGNUNcdTUzM0EoMDMgXHUwMEE3XHU1MTZEO1x1NTIwN1x1NjM2Mlx1OEJFRFx1NEU0OVx1NEUwRSB3ZWIgXHU3NkY4XHU1NDBDOnJ1bnRpbWUgXHU1MzU1XHU5MDA5IGN3ZCkgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTp3b3Jrc3BhY2VzJywgKGV2ZW50KSA9PlxyXG4gICAgICBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjx7IGN1cnJlbnQ6IHN0cmluZzsgaXRlbXM6IEFycmF5PHsgaWQ6IHN0cmluZzsgbmFtZTogc3RyaW5nOyBwYXRoOiBzdHJpbmcgfT4gfT4oJy9hcGkvd29ya3NwYWNlcycpKSk7XHJcblxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTp3b3Jrc3BhY2UtdXNlJywgKGV2ZW50LCBpZDogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCB3aWQgPSB0eXBlb2YgaWQgPT09ICdzdHJpbmcnID8gaWQuc2xpY2UoMCwgNjApIDogJyc7XHJcbiAgICAgIGlmICh3aWQgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICdpZCByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PignL2FwaS93b3Jrc3BhY2VzL3VzZScsIHsgaWQ6IHdpZCB9KSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOndvcmtzcGFjZS1hZGQnLCAoZXZlbnQsIG5hbWU6IHVua25vd24sIHBhdGg6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3QgbiA9IHR5cGVvZiBuYW1lID09PSAnc3RyaW5nJyA/IG5hbWUuc2xpY2UoMCwgMTIwKSA6ICcnO1xyXG4gICAgICBjb25zdCBwID0gdHlwZW9mIHBhdGggPT09ICdzdHJpbmcnID8gcGF0aC5zbGljZSgwLCAxMDAwKSA6ICcnO1xyXG4gICAgICBpZiAocCA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ3BhdGggcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvd29ya3NwYWNlcycsIHsgbmFtZTogbiA9PT0gJycgPyB1bmRlZmluZWQgOiBuLCBwYXRoOiBwIH0pKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gXHU0RjFBXHU4QkREXHU1RjUyXHU2ODYzL1x1NTIyMFx1OTY2NChcdTc5RkJcdTUxNjUgYXJjaGl2ZS90cmFzaCxcdTUzRUZcdTYwNjJcdTU5MEQ7cnVudGltZSBcdTY3NDNcdTVBMDEpIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6c2Vzc2lvbi1vcCcsIChldmVudCwgaWQ6IHVua25vd24sIG9wOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IHNpZCA9IHR5cGVvZiBpZCA9PT0gJ3N0cmluZycgPyBpZC5yZXBsYWNlKC9bXmEtekEtWjAtOV86LkAtXS9nLCAnJykuc2xpY2UoMCwgODApIDogJyc7XHJcbiAgICAgIGNvbnN0IG8gPSBvcCA9PT0gJ2FyY2hpdmUnIHx8IG9wID09PSAnZGVsZXRlJyA/IG9wIDogJyc7XHJcbiAgICAgIGlmIChzaWQgPT09ICcnIHx8IG8gPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICdpZCBhbmQgb3AoYXJjaGl2ZXxkZWxldGUpIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcclxuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KGAvYXBpL3Nlc3Npb25zLyR7ZW5jb2RlVVJJQ29tcG9uZW50KHNpZCl9LyR7b31gLCB7fSkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBNNDpEaWZmIFx1OTc2Mlx1Njc3RihcdTUzRUFcdThCRkIgZ2l0IFx1NTNEOFx1NjZGNDtcdTYzODhcdTY3NDNcdTU3MjggcnVudGltZSkgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpkaWZmJywgKGV2ZW50LCBzZXNzaW9uSWQ6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIHNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBzZXNzaW9uSWQuc2xpY2UoMCwgODApIDogJyc7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oYC9hcGkvZGlmZiR7c2lkICE9PSAnJyA/IGA/c2Vzc2lvbklkPSR7ZW5jb2RlVVJJQ29tcG9uZW50KHNpZCl9YCA6ICcnfWApKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gTTU6XHU4QkE0XHU3N0U1XHU3MkI2XHU2MDAxKFx1N0VEM1x1Njc4NFx1NTMxNlx1NEU4Qlx1NUI5RTtcdTdGM0FcdTY1NzBcdTYzNkVcdTVCNTdcdTZCQjVcdTc1MzEgVUkgXHU2NjNFXHU3OTNBXCJcdTY1RTBcdTY1NzBcdTYzNkVcIikgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpjb2duaXRpdmUnLCAoZXZlbnQpID0+XHJcbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPFJlY29yZDxzdHJpbmcsIHVua25vd24+PignL2FwaS9jb2duaXRpdmUnKSkpO1xyXG5cclxuICAgIC8vIC0tLS0gXHU1Mzg2XHU1M0YyXHU0RjFBXHU4QkREXHU5ODg0XHU4OUM4KFx1NjcwMFx1NTQwRSA4MCBcdTY3NjEsXHU2QkNGXHU2NzYxIDUwMCBcdTVCNTc7cnVudGltZSBcdTY3NDNcdTVBMDFcdTY1NzBcdTYzNkUpIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6c2Vzc2lvbi1wcmV2aWV3JywgKGV2ZW50LCBpZDogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBzaWQgPSB0eXBlb2YgaWQgPT09ICdzdHJpbmcnID8gaWQucmVwbGFjZSgvW15hLXpBLVowLTlfOi5ALV0vZywgJycpLnNsaWNlKDAsIDgwKSA6ICcnO1xyXG4gICAgICBpZiAoc2lkID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAnaWQgcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KGAvYXBpL3Nlc3Npb25zLyR7ZW5jb2RlVVJJQ29tcG9uZW50KHNpZCl9YCkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpzdG9wLWhvc3QnLCAoZXZlbnQpID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJyB9O1xyXG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgc3NlQWJvcnQ/LmFib3J0KCk7XHJcbiAgICAgICAgYXdhaXQgc3VwZXJ2aXNvcj8uc3RvcCgpO1xyXG4gICAgICAgIGFwcC5xdWl0KCk7XHJcbiAgICAgIH0pKCk7XHJcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlIH07XHJcbiAgICB9KTtcclxuICB9XHJcblxyXG4gIC8qIC0tLS0gXHU3QTk3XHU1M0UzXHU0RTBFXHU1Qjg5XHU1MTY4XHU3QjU2XHU3NTY1IC0tLS0gKi9cclxuICAvLyAwMyBcdTAwQTdcdTRFMDM6RGVza3RvcCBcdTY3MkNcdTU3MzBcdTUzRUFcdTVCNTggVUkgXHU1MDRGXHU1OTdEL1x1N0E5N1x1NTNFM1x1NzJCNlx1NjAwMSh1c2VyRGF0YS93aW5kb3ctc3RhdGUuanNvbilcclxuICBjb25zdCB3aW5kb3dTdGF0ZUZpbGUgPSAoKTogc3RyaW5nID0+IGpvaW4oYXBwLmdldFBhdGgoJ3VzZXJEYXRhJyksICd3aW5kb3ctc3RhdGUuanNvbicpO1xyXG4gIGFzeW5jIGZ1bmN0aW9uIGxvYWRCb3VuZHMoKTogUHJvbWlzZTx7IHdpZHRoOiBudW1iZXI7IGhlaWdodDogbnVtYmVyOyB4PzogbnVtYmVyOyB5PzogbnVtYmVyIH0gfCBudWxsPiB7XHJcbiAgICB0cnkge1xyXG4gICAgICByZXR1cm4gSlNPTi5wYXJzZShhd2FpdCByZWFkRmlsZSh3aW5kb3dTdGF0ZUZpbGUoKSwgJ3V0ZjgnKSkgYXMgeyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlcjsgeD86IG51bWJlcjsgeT86IG51bWJlciB9O1xyXG4gICAgfSBjYXRjaCB7IHJldHVybiBudWxsOyB9XHJcbiAgfVxyXG4gIGFzeW5jIGZ1bmN0aW9uIHNhdmVCb3VuZHMod2luOiBCcm93c2VyV2luZG93KTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICB0cnkgeyBhd2FpdCB3cml0ZUZpbGUod2luZG93U3RhdGVGaWxlKCksIEpTT04uc3RyaW5naWZ5KHdpbi5nZXRCb3VuZHMoKSksICd1dGY4Jyk7IH0gY2F0Y2ggeyAvKiBiZXN0IGVmZm9ydCAqLyB9XHJcbiAgfVxyXG5cclxuICBhc3luYyBmdW5jdGlvbiBjcmVhdGVXaW5kb3coKTogUHJvbWlzZTxCcm93c2VyV2luZG93IHwgbnVsbD4ge1xyXG4gICAgY29uc3Qgc2F2ZWQgPSBhd2FpdCBsb2FkQm91bmRzKCk7XHJcbiAgICBjb25zdCB3aW4gPSBuZXcgQnJvd3NlcldpbmRvdyh7XHJcbiAgICAgIHdpZHRoOiBzYXZlZD8ud2lkdGggPz8gMTQ0MCxcclxuICAgICAgaGVpZ2h0OiBzYXZlZD8uaGVpZ2h0ID8/IDkwMCxcclxuICAgICAgLi4uKHNhdmVkPy54ICE9PSB1bmRlZmluZWQgJiYgc2F2ZWQ/LnkgIT09IHVuZGVmaW5lZCA/IHsgeDogc2F2ZWQueCwgeTogc2F2ZWQueSB9IDoge30pLFxyXG4gICAgICAvLyBISUcgXHU5NjM2XHU2QkI1MigxMS1BKTpcdTdBODRcdTdBOTdcdTRFMEJcdTk2NTAgNTYwKDA0IFx1NTNGN1x1ODlDNFx1NjgzQztcdTUzOUYgOTYwIFx1NEY3RiBcdTIyNjQ4MjBweCBcdTYyQkRcdTVDNDlcdTY1QURcdTcwQjlcdTRFMERcdTUzRUZcdThGQkUpO1xyXG4gICAgICAvLyBVSVZFUklGWSBcdTdBODRcdTVDNEZcdTlBOENcdTY1MzYoMTEtQix3aXphcmQgMzYwXHUwMEQ3NjQwIFx1NTE2OFx1NTE0M1x1N0QyMFx1NTNFRlx1OEZCRSlcdTk3MDBcdTRFMzRcdTY1RjZcdTY1M0VcdTVCQkRcdTUyMzAgMzIwXHUwMEQ3MzYwXHUzMDAyXHJcbiAgICAgIG1pbldpZHRoOiBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWSA9PT0gJzEnID8gMzIwIDogNTYwLFxyXG4gICAgICBtaW5IZWlnaHQ6IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZID09PSAnMScgPyAzNjAgOiA2MDAsXHJcbiAgICAgIHNob3c6IGZhbHNlLFxyXG4gICAgICBiYWNrZ3JvdW5kQ29sb3I6ICcjZjlmYWZiJywgLy8gdjQgRFNIOlx1NkQ0NVx1ODI3Mlx1OUVEOFx1OEJBNChiZy1iYXNlKSxcdTkwN0ZcdTUxNERcdTZERjFcdTgyNzJcdTk1RUFcdTVDNEZcclxuICAgICAgdGl0bGU6ICdITUggRGVza3RvcCcsXHJcbiAgICAgIC8vIFx1OTY5MFx1ODVDRlx1NUYwRlx1NjgwN1x1OTg5OFx1NjgwRjpcdTUzOUZcdTc1MUZcdTdBOTdcdTUzRTNcdTYzQTdcdTUyMzYob3ZlcmxheSBcdTYzRDBcdTRGOUIpK1x1OTg5Q1x1ODI3Mlx1OTY4Rlx1NEUzQlx1OTg5OChyZW5kZXJlciBcdTdFQ0ZcclxuICAgICAgLy8gY2hyb21lLXRoZW1lIFx1NTQwQ1x1NkI2NSlcdTIwMTRcdTIwMTRcdTY4MzlcdTZDQkJcdTRFQUVcdTgyNzJcdTZBMjFcdTVGMEZcdTk4NzZcdTkwRThcdTlFRDFcdTY3NjE7XHU4M0RDXHU1MzU1XHU2ODBGIGF1dG9IaWRlKEFsdCBcdTU0N0NcdTUxRkEpXHUzMDAyXHJcbiAgICAgIHRpdGxlQmFyU3R5bGU6ICdoaWRkZW4nLFxyXG4gICAgICAvLyBISUcgXHU5NjM2XHU2QkI1MjozNlx1MjE5MjQ0LFx1NEUwRSByZW5kZXJlciAudGl0bGViYXIgXHU5QUQ4XHU1RUE2XHU0RTAwXHU4MUY0KFx1NEUwRFx1NEUwMFx1ODFGNFx1NEYxQVx1OTczMlx1NTFGQS9cdTkwNkVcdTRGNEYgOHB4KVxyXG4gICAgICB0aXRsZUJhck92ZXJsYXk6IHsgLi4uY2hyb21lRm9yKG5hdGl2ZVRoZW1lLnNob3VsZFVzZURhcmtDb2xvcnMpLCBoZWlnaHQ6IDQ0IH0sXHJcbiAgICAgIGF1dG9IaWRlTWVudUJhcjogdHJ1ZSxcclxuICAgICAgd2ViUHJlZmVyZW5jZXM6IHtcclxuICAgICAgICBwcmVsb2FkOiBwcmVsb2FkUGF0aCxcclxuICAgICAgICBjb250ZXh0SXNvbGF0aW9uOiB0cnVlLFxyXG4gICAgICAgIHNhbmRib3g6IHRydWUsXHJcbiAgICAgICAgbm9kZUludGVncmF0aW9uOiBmYWxzZSxcclxuICAgICAgICBub2RlSW50ZWdyYXRpb25JbldvcmtlcjogZmFsc2UsXHJcbiAgICAgICAgd2ViU2VjdXJpdHk6IHRydWUsXHJcbiAgICAgICAgc3BlbGxjaGVjazogZmFsc2UsXHJcbiAgICAgICAgZGV2VG9vbHM6IGlzRGV2LFxyXG4gICAgICB9LFxyXG4gICAgfSk7XHJcbiAgICB3aW4ub25jZSgncmVhZHktdG8tc2hvdycsICgpID0+IHdpbi5zaG93KCkpO1xyXG4gICAgd2luLm9uKCdjbG9zZScsICgpID0+IHsgdm9pZCBzYXZlQm91bmRzKHdpbik7IH0pO1xyXG5cclxuICAgIC8vIFx1NTNFQVx1NTE0MVx1OEJCOFx1NTJBMFx1OEY3RFx1NjIxMVx1NEVFQ1x1ODFFQVx1NURGMVx1NzY4NCByZW5kZXJlcjtcdTRFRkJcdTRGNTVcdTVCRkNcdTgyMkEvXHU2NUIwXHU3QTk3XHU1M0UzXHU0RTAwXHU1RjhCXHU2MkQyXHU3RUREXHJcbiAgICB3aW4ud2ViQ29udGVudHMuc2V0V2luZG93T3BlbkhhbmRsZXIoKHsgdXJsIH0pID0+IHtcclxuICAgICAgaWYgKC9eaHR0cHM/OlxcL1xcLy8udGVzdCh1cmwpKSB2b2lkIHNoZWxsLm9wZW5FeHRlcm5hbCh1cmwpO1xyXG4gICAgICByZXR1cm4geyBhY3Rpb246ICdkZW55JyB9O1xyXG4gICAgfSk7XHJcbiAgICB3aW4ud2ViQ29udGVudHMub24oJ3dpbGwtbmF2aWdhdGUnLCAoZSwgdXJsKSA9PiB7XHJcbiAgICAgIGNvbnN0IG9rID0gWy4uLmFsbG93ZWRPcmlnaW5zXS5zb21lKChvKSA9PiB1cmwgPT09IG8gfHwgdXJsLnN0YXJ0c1dpdGgoYCR7b30vYCkgfHwgdXJsLnN0YXJ0c1dpdGgoYCR7b30/YCkpO1xyXG4gICAgICBpZiAoIW9rKSB7XHJcbiAgICAgICAgbG9nSW5mbygnbmF2JywgYGJsb2NrZWQgbmF2aWdhdGlvbiB0byAke3VybC5zbGljZSgwLCAxMjApfWApO1xyXG4gICAgICAgIGUucHJldmVudERlZmF1bHQoKTtcclxuICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgaWYgKGlzRGV2ICYmIHJlbmRlcmVyRGV2VXJsKSB7XHJcbiAgICAgIHZvaWQgd2luLmxvYWRVUkwocmVuZGVyZXJEZXZVcmwpO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgdm9pZCB3aW4ubG9hZEZpbGUoam9pbihoZXJlLCAnLi4nLCAnLi4nLCAnZGlzdC1yZW5kZXJlcicsICdpbmRleC5odG1sJykpO1xyXG4gICAgfVxyXG4gICAgLy8gXHU5ODc1XHU5NzYyXHU1MkEwXHU4RjdEXHU1QjhDXHU5MUNEXHU2NEFEXHU1RjUzXHU1MjREIGhvc3QgXHU3MkI2XHU2MDAxOnJlYWR5IFx1NUU3Rlx1NjRBRFx1ODJFNVx1NjVFOVx1NEU4RSByZW5kZXJlciBcdThCQTJcdTk2MDVcdTUzNzNcdTRFMjJcdTU5MzEsXHJcbiAgICAvLyByZW5kZXJlciBcdTc2ODQgZ2V0LXN0YXRlIFx1NUZFQlx1NzE2NyArIFx1OEZEOVx1OTFDQ1x1NzY4NFx1OTFDRFx1NjRBRFx1NTNDQ1x1NEZERFx1OTY2OShcdTU5MUFcdTdBOTdcdTUzRTMvXHU5MUNEXHU4RjdEXHU1NzNBXHU2NjZGXHU0RTVGXHU4OTg2XHU3NkQ2KVx1MzAwMlxyXG4gICAgd2luLndlYkNvbnRlbnRzLm9uY2UoJ2RpZC1maW5pc2gtbG9hZCcsICgpID0+IHtcclxuICAgICAgaWYgKCF3aW4uaXNEZXN0cm95ZWQoKSkge1xyXG4gICAgICAgIHdpbi53ZWJDb250ZW50cy5zZW5kKCdicmlkZ2U6aG9zdC1zdGF0ZScsIGJyaWRnZS5ob3N0U3RhdGUsIHsgcmVzdGFydENvdW50OiAwIH0pO1xyXG4gICAgICB9XHJcbiAgICB9KTtcclxuICAgIHJldHVybiB3aW47XHJcbiAgfVxyXG5cclxuICBhcHAud2hlblJlYWR5KCkudGhlbigoKSA9PiB7XHJcbiAgICAvLyBVSVZFUklGWTpmYWtlIFx1NkEyMVx1NUYwRlx1OUE4Q1x1NjUzNlx1OTg3Qlx1NTcyOCBzdGFydEhvc3QgXHU4QkZCIGVudiBcdTRFNEJcdTUyNERcdTVGM0FcdTUyMzYgZmFrZTtWSVNSRUcoXHU4OUM2XHU4OUM5XHU1NkRFXHU1RjUyKVx1NTQwQ1x1ODlDNFx1NTIxOVxyXG4gICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1ZJU1JFRyA9PT0gJzEnIHx8IChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWSA9PT0gJzEnICYmIHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX01PREUgIT09ICdyZWFsJykpIHtcclxuICAgICAgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfRkFLRSA9ICcxJztcclxuICAgIH1cclxuICAgIC8vIFdpbmRvd3MgXHU5MDFBXHU3N0U1XHU1RjUyXHU1QzVFKFx1NTQyNlx1NTIxOVx1NjYzRVx1NzkzQVx1NEUzQSBlbGVjdHJvbi5leGUpXHJcbiAgICBhcHAuc2V0QXBwVXNlck1vZGVsSWQoJ2Rldi5obWguZGVza3RvcCcpO1xyXG4gICAgc2V0dXBUcmF5KCk7XHJcbiAgICBidWlsZEFwcE1lbnUoKTtcclxuICAgIC8vIFx1NTQyRlx1NTJBOCAzMHMgXHU1NDBFXHU5NzU5XHU5RUQ4XHU2OEMwXHU2N0U1XHU2NkY0XHU2NUIwKFx1NjcwOVx1NjVCMFx1NzI0OFx1NEVDNVx1NTQwRVx1NTNGMFx1NEUwQlx1OEY3RCxcdTRFMERcdTYyNTNcdTYyNzA7XHU3NTI4XHU2MjM3XHU3RUNGIFx1MjYzMCBcdTgzRENcdTUzNTVcdTUxQjNcdTVCOUFcdTg4QzUpXHJcbiAgICBpZiAoYXBwLmlzUGFja2FnZWQpIHNldFRpbWVvdXQoKCkgPT4geyB2b2lkIGNoZWNrRm9yVXBkYXRlcygpOyB9LCAzMF8wMDApO1xyXG4gICAgLy8gQ1NQKGRldiBcdTRFMEUgcHJvZCBcdTRFMERcdTU0MEM7cHJvZCBcdTRFMERcdTUxNDFcdThCQjhcdTRFRkJcdTRGNTVcdThGRENcdTdBMEJcdTZFOTApXHJcbiAgICBjb25zdCBjc3AgPSBpc0RldlxyXG4gICAgICA/IFtcclxuICAgICAgICAgIFwiZGVmYXVsdC1zcmMgJ3NlbGYnXCIsXHJcbiAgICAgICAgICBgc2NyaXB0LXNyYyAnc2VsZicgJHtyZW5kZXJlckRldlVybH1gLFxyXG4gICAgICAgICAgXCJzdHlsZS1zcmMgJ3NlbGYnICd1bnNhZmUtaW5saW5lJ1wiLFxyXG4gICAgICAgICAgYGNvbm5lY3Qtc3JjICdzZWxmJyAke3JlbmRlcmVyRGV2VXJsfSB3czovLzEyNy4wLjAuMToqYCxcclxuICAgICAgICAgIFwiaW1nLXNyYyAnc2VsZicgZGF0YTpcIixcclxuICAgICAgICAgIFwiZm9udC1zcmMgJ3NlbGYnIGRhdGE6XCIsXHJcbiAgICAgICAgXS5qb2luKCc7ICcpXHJcbiAgICAgIDogXCJkZWZhdWx0LXNyYyAnc2VsZic7IHNjcmlwdC1zcmMgJ3NlbGYnOyBzdHlsZS1zcmMgJ3NlbGYnICd1bnNhZmUtaW5saW5lJzsgaW1nLXNyYyAnc2VsZicgZGF0YTo7IGZvbnQtc3JjICdzZWxmJyBkYXRhOlwiO1xyXG4gICAgc2Vzc2lvbi5kZWZhdWx0U2Vzc2lvbi53ZWJSZXF1ZXN0Lm9uSGVhZGVyc1JlY2VpdmVkKChkZXRhaWxzLCBjYWxsYmFjaykgPT4ge1xyXG4gICAgICBjYWxsYmFjayh7XHJcbiAgICAgICAgcmVzcG9uc2VIZWFkZXJzOiB7XHJcbiAgICAgICAgICAuLi5kZXRhaWxzLnJlc3BvbnNlSGVhZGVycyxcclxuICAgICAgICAgICdDb250ZW50LVNlY3VyaXR5LVBvbGljeSc6IFtjc3BdLFxyXG4gICAgICAgIH0sXHJcbiAgICAgIH0pO1xyXG4gICAgfSk7XHJcblxyXG4gICAgcmVnaXN0ZXJJcGMoKTtcclxuICAgIC8vIGNyZWF0ZVdpbmRvdyBcdTY2MkYgYXN5bmMoYm91bmRzIFx1NjA2Mlx1NTkwRCk7XHU1Qjg5XHU1MTY4XHU4MUVBXHU2RDRCL1x1NkUzMlx1NjdEM1x1ODFFQVx1NjhDMFx1NTcyOFx1N0E5N1x1NTNFM1x1NUMzMVx1N0VFQVx1NTQwRVx1NjMwMlx1OEY3RFxyXG4gICAgdm9pZCBjcmVhdGVXaW5kb3coKS50aGVuKCh3aW4pID0+IHtcclxuICAgICAgaWYgKHdpbiA9PT0gbnVsbCkgcmV0dXJuO1xyXG4gICAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRlkgPT09ICcxJykgYXR0YWNoVWlWZXJpZnkod2luKTtcclxuICAgICAgLy8gXHU4OUM2XHU4OUM5XHU1NkRFXHU1RjUyXHU2MjJBXHU1NkZFXHU5NEE5XHU1QjUwOkhNSF9ERVNLVE9QX1ZJU1JFRz0xLFx1Nzg2RVx1NUI5QVx1NjAyN1x1ODlDNlx1NTNFM1x1NjIyQVx1NTZGRVx1NTQwRVx1OTAwMFx1NTFGQShzY3JpcHRzL3Zpc3VhbC1yZWdyZXNzaW9uLm1qcyBcdTlBNzFcdTUyQTgpXHJcbiAgICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9WSVNSRUcgPT09ICcxJykgYXR0YWNoVmlzdWFsUmVncmVzc2lvbih3aW4pO1xyXG4gICAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfU0VDVVJJVFlfVEVTVCA9PT0gJzEnKSB7XHJcbiAgICAgICAgd2luLndlYkNvbnRlbnRzLm9uY2UoJ2RpZC1maW5pc2gtbG9hZCcsICgpID0+IHtcclxuICAgICAgICAgIHZvaWQgc2VjdXJpdHlTZWxmVGVzdCh3aW4pO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICB9XHJcbiAgICAgIC8vIFVJIFx1NjIyQVx1NTZGRVx1OTRBOVx1NUI1MDpITUhfREVTS1RPUF9TTkFQU0hPVD08ZmlsZS5wbmc+IFx1NTcyOFx1NzU0Q1x1OTc2Mlx1NUMzMVx1N0VFQVx1NTQwRVx1NjIyQVx1NTZGRVx1OTAwMFx1NTFGQVxyXG4gICAgICAvLyAoXHU4OEM1XHU2NzNBXHU4QkNBXHU2NUFEXHU3NTI4Olx1NEVCMlx1NzczQ1x1NzcwQlx1NkUzMlx1NjdEM1x1N0VEM1x1Njc5QyxcdTgwMENcdTRFMERcdTY2MkZcdTUzRUFcdTY1NzAgcm9vdCBcdTVCNTBcdTgyODJcdTcwQjkpXHUzMDAyXHJcbiAgICAgIGNvbnN0IHNuYXAgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9TTkFQU0hPVDtcclxuICAgICAgaWYgKHNuYXAgIT09IHVuZGVmaW5lZCAmJiBzbmFwICE9PSAnJykge1xyXG4gICAgICAgIHdpbi53ZWJDb250ZW50cy5vbmNlKCdkaWQtZmluaXNoLWxvYWQnLCAoKSA9PiB7XHJcbiAgICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHtcclxuICAgICAgICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBpbWcgPSBhd2FpdCB3aW4ud2ViQ29udGVudHMuY2FwdHVyZVBhZ2UoKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHsgd3JpdGVGaWxlOiB3ZiB9ID0gYXdhaXQgaW1wb3J0KCdub2RlOmZzL3Byb21pc2VzJyk7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCB3ZihzbmFwLCBpbWcudG9QTkcoKSk7XHJcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgU05BUFNIT1Qgb2sgJHtzbmFwfSAke2ltZy5nZXRTaXplKCkud2lkdGh9eCR7aW1nLmdldFNpemUoKS5oZWlnaHR9YCk7XHJcbiAgICAgICAgICAgICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgU05BUFNIT1QgZXJyb3IgJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApfWApO1xyXG4gICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICBjb25zdCBhcHAyID0gYXBwO1xyXG4gICAgICAgICAgICAgIHNldFRpbWVvdXQoKCkgPT4gYXBwMi5leGl0KDApLCA1MDApO1xyXG4gICAgICAgICAgICB9KSgpO1xyXG4gICAgICAgICAgfSwgTnVtYmVyKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NOQVBTSE9UX0RFTEFZX01TID8/IDEyXzAwMCkpO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICB9XHJcbiAgICAgIC8vIERPTSBcdTdFRDNcdTY3ODRcdTYzQTJcdTk0ODg6SE1IX0RFU0tUT1BfRE9NUFJPQkU9MSBcdThGOTNcdTUxRkFcdTUxNzNcdTk1MkVcdTUxNDNcdTdEMjBcdTc2ODQgYm94L2Rpc3BsYXkvY2hpbGRyZW4sXHJcbiAgICAgIC8vIFx1NTE4RFx1OTAwMFx1NTFGQShcdThCQ0FcdTY1QURcIlJlYWN0IFx1NjMwMlx1OEY3RFx1NEU4Nlx1NEY0Nlx1NjdEMFx1NTc1NyBVSSBcdTRFMERcdTUzRUZcdTg5QzFcIlx1OEZEOVx1N0M3Qlx1OTVFRVx1OTg5ODtcdTYyMkFcdTU2RkVcdTRFNEJcdTU5MTZcdTc2ODRcdTc4NkNcdThCQzFcdTYzNkUpXHUzMDAyXHJcbiAgICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9ET01QUk9CRSA9PT0gJzEnKSB7XHJcbiAgICAgICAgd2luLndlYkNvbnRlbnRzLm9uY2UoJ2RpZC1maW5pc2gtbG9hZCcsICgpID0+IHtcclxuICAgICAgICAgIHNldFRpbWVvdXQoKCkgPT4ge1xyXG4gICAgICAgICAgICB2b2lkIChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHIgPSAoYXdhaXQgd2luLndlYkNvbnRlbnRzLmV4ZWN1dGVKYXZhU2NyaXB0KGAoZnVuY3Rpb24oKXtcclxuICAgICAgICAgICAgICAgICAgdmFyIHBpY2sgPSBmdW5jdGlvbihzZWwpe1xyXG4gICAgICAgICAgICAgICAgICAgIHZhciBlbHMgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKHNlbCk7XHJcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGVscywgMCwgNCkubWFwKGZ1bmN0aW9uKGVsKXtcclxuICAgICAgICAgICAgICAgICAgICAgIHZhciBjcyA9IGdldENvbXB1dGVkU3R5bGUoZWwpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgdmFyIGIgPSBlbC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcclxuICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB7IGNsczogKGVsLmNsYXNzTmFtZXx8JycpLnRvU3RyaW5nKCkuc2xpY2UoMCw4MCksIHRhZzogZWwudGFnTmFtZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgZGlzcGxheTogY3MuZGlzcGxheSwgdmlzOiBjcy52aXNpYmlsaXR5LCBvcGFjaXR5OiBjcy5vcGFjaXR5LFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBwb3M6IGNzLnBvc2l0aW9uLCB6OiBjcy56SW5kZXgsIG92ZXJmbG93OiBjcy5vdmVyZmxvdyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgeDogTWF0aC5yb3VuZChiLngpLCB5OiBNYXRoLnJvdW5kKGIueSksIHc6IE1hdGgucm91bmQoYi53aWR0aCksIGg6IE1hdGgucm91bmQoYi5oZWlnaHQpLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB0ZXh0OiAoZWwuaW5uZXJUZXh0fHwnJykucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDYwKSB9O1xyXG4gICAgICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgICB9O1xyXG4gICAgICAgICAgICAgICAgICB2YXIgc2VscyA9IFsnaHRtbCcsJ2JvZHknLCcjcm9vdCcsJy5hcHAtc2hlbGwnLCcuc2lkZWJhcicsJy53b3Jrc3BhY2UnLCcudG9wYmFyJywnLnN0cmVhbScsJy5lbXB0eS1oaW50JywnLmNvbXBvc2VyJywnLmNvbXBvc2VyLXJvdycsJy5jb21wb3NlciB0ZXh0YXJlYScsJy5jb21wb3Nlci1zaWRlJywnLmF0dC1waWNrZXInLCcuYXR0LWNoaXBzJywnLnNpZGVwYW5lbCcsJy5ydW50aW1lLWd1aWRlJywnLm92ZXJsYXknLCcudHVybicsJy5jYXJkJ107XHJcbiAgICAgICAgICAgICAgICAgIHZhciBvdXQgPSB7fTtcclxuICAgICAgICAgICAgICAgICAgc2Vscy5mb3JFYWNoKGZ1bmN0aW9uKHMpeyB0cnkgeyBvdXRbc10gPSBwaWNrKHMpOyB9IGNhdGNoKGUpeyBvdXRbc10gPSBbe2VycjogU3RyaW5nKGUpLnNsaWNlKDAsODApfV07IH0gfSk7XHJcbiAgICAgICAgICAgICAgICAgIG91dC5fX21ldGEgPSB7XHJcbiAgICAgICAgICAgICAgICAgICAgc3R5bGVTaGVldHM6IGRvY3VtZW50LnN0eWxlU2hlZXRzLmxlbmd0aCxcclxuICAgICAgICAgICAgICAgICAgICBzaGVldDBydWxlczogKGRvY3VtZW50LnN0eWxlU2hlZXRzWzBdICYmIGRvY3VtZW50LnN0eWxlU2hlZXRzWzBdLmNzc1J1bGVzKSA/IGRvY3VtZW50LnN0eWxlU2hlZXRzWzBdLmNzc1J1bGVzLmxlbmd0aCA6IC0xLFxyXG4gICAgICAgICAgICAgICAgICAgIHJvb3RDaGlsZHJlbjogZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Jvb3QnKSA/IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyb290JykuY2hpbGRyZW4ubGVuZ3RoIDogLTEsXHJcbiAgICAgICAgICAgICAgICAgICAgYm9keUNoaWxkcmVuOiBkb2N1bWVudC5ib2R5LmNoaWxkcmVuLmxlbmd0aCxcclxuICAgICAgICAgICAgICAgICAgICBpbm5lckhUTUxMZW46IGRvY3VtZW50LmJvZHkuaW5uZXJIVE1MLmxlbmd0aCxcclxuICAgICAgICAgICAgICAgICAgICB2aWV3cG9ydDogd2luZG93LmlubmVyV2lkdGggKyAneCcgKyB3aW5kb3cuaW5uZXJIZWlnaHRcclxuICAgICAgICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KG91dCk7XHJcbiAgICAgICAgICAgICAgICB9KSgpYCwgdHJ1ZSkpIGFzIHN0cmluZztcclxuICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBET01QUk9CRSAke3J9YCk7XHJcbiAgICAgICAgICAgICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgRE9NUFJPQkUgZXJyb3IgJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAyMDApfWApO1xyXG4gICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICBhcHAuZXhpdCgwKTtcclxuICAgICAgICAgICAgfSkoKTtcclxuICAgICAgICAgIH0sIE51bWJlcihwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9ET01QUk9CRV9ERUxBWV9NUyA/PyA5XzAwMCkpO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICB9XHJcbiAgICAgIC8vIFx1NkUzMlx1NjdEM1x1ODFFQVx1NjhDMCgyMDI2LTEwLTEwIFx1ODhDNVx1NjczQVx1OUVEMVx1NUM0Rlx1NjU1OVx1OEJBRDpicmlkZ2UgcmVhZHkgXHUyMjYwIFx1NzU0Q1x1OTc2Mlx1NkUzMlx1NjdEM1x1NEU4NilcdTMwMDJcclxuICAgICAgLy8gI3Jvb3QgXHU1NzI4IFJlYWN0IFx1NjMwMlx1OEY3RFx1NTQwRVx1NUZDNVx1NjcwOVx1NUI1MFx1ODI4Mlx1NzBCOTtcdTdBN0EgPSBcdThENDRcdTZFOTBcdThERUZcdTVGODQvQ1NQL1x1ODExQVx1NjcyQ1x1NTJBMFx1OEY3RFx1NTc0Rlx1NEU4Nlx1MzAwMlxyXG4gICAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfUkVOREVSX1RFU1QgPT09ICcxJykge1xyXG4gICAgICAgIHdpbi53ZWJDb250ZW50cy5vbmNlKCdkaWQtZmluaXNoLWxvYWQnLCAoKSA9PiB7XHJcbiAgICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHtcclxuICAgICAgICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBuID0gKGF3YWl0IHdpbi53ZWJDb250ZW50cy5leGVjdXRlSmF2YVNjcmlwdChcclxuICAgICAgICAgICAgICAgICAgJ2RvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwicm9vdFwiKSA/IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwicm9vdFwiKS5jaGlsZHJlbi5sZW5ndGggOiAtMScsIHRydWUsXHJcbiAgICAgICAgICAgICAgICApKSBhcyBudW1iZXI7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBvayA9IG4gPiAwO1xyXG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYFJFTkRFUi1URVNUICR7b2sgPyAnb2snIDogJ0VNUFRZJ30gcm9vdENoaWxkcmVuPSR7bn1gKTtcclxuICAgICAgICAgICAgICAgIGFwcC5leGl0KG9rID8gMCA6IDEpO1xyXG4gICAgICAgICAgICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYFJFTkRFUi1URVNUIEVSUk9SICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTIwKX1gKTtcclxuICAgICAgICAgICAgICAgIGFwcC5leGl0KDEpO1xyXG4gICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfSkoKTtcclxuICAgICAgICAgIH0sIDJfNTAwKTtcclxuICAgICAgICB9KTtcclxuICAgICAgfVxyXG4gICAgfSk7XHJcbiAgICB2b2lkIHN0YXJ0SG9zdCgpO1xyXG5cclxuICAgIGFwcC5vbignYWN0aXZhdGUnLCAoKSA9PiB7XHJcbiAgICAgIGlmIChCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5sZW5ndGggPT09IDApIHZvaWQgY3JlYXRlV2luZG93KCk7XHJcbiAgICB9KTtcclxuICB9KTtcclxuXHJcbiAgYXN5bmMgZnVuY3Rpb24gc2VjdXJpdHlTZWxmVGVzdCh3aW46IEJyb3dzZXJXaW5kb3cpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IHJlc3VsdHM6IEFycmF5PFtzdHJpbmcsIGJvb2xlYW4sIHN0cmluZ10+ID0gW107XHJcbiAgICBjb25zdCBjaGVjayA9IGFzeW5jIChuYW1lOiBzdHJpbmcsIHByb2JlOiAoKSA9PiBQcm9taXNlPFtib29sZWFuLCBzdHJpbmddPik6IFByb21pc2U8dm9pZD4gPT4ge1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IFtvaywgZGV0YWlsXSA9IGF3YWl0IHByb2JlKCk7XHJcbiAgICAgICAgcmVzdWx0cy5wdXNoKFtuYW1lLCBvaywgZGV0YWlsXSk7XHJcbiAgICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICAgIHJlc3VsdHMucHVzaChbbmFtZSwgZmFsc2UsIFN0cmluZyhlcnIpLnNsaWNlKDAsIDEyMCldKTtcclxuICAgICAgfVxyXG4gICAgfTtcclxuICAgIGNvbnN0IGpzID0gKGNvZGU6IHN0cmluZyk6IFByb21pc2U8dW5rbm93bj4gPT4gd2luLndlYkNvbnRlbnRzLmV4ZWN1dGVKYXZhU2NyaXB0KGNvZGUsIHRydWUpO1xyXG5cclxuICAgIGF3YWl0IGNoZWNrKCdyZW5kZXJlciBcdTY1RTBcdTUzRUZcdTc1MjhcdTc2ODQgcHJvY2Vzcy9yZXF1aXJlKHNhbmRib3ggXHU3NTFGXHU2NTQ4KScsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgciA9IChhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XHJcbiAgICAgICAgdmFyIHQgPSBmdW5jdGlvbihmKXsgdHJ5IHsgdmFyIHYgPSBmKCk7IHJldHVybiAodiA9PT0gdW5kZWZpbmVkIHx8IHYgPT09IG51bGwpID8gJ3VuYXZhaWxhYmxlJyA6IHR5cGVvZiB2OyB9IGNhdGNoKGUpeyByZXR1cm4gJ2Jsb2NrZWQnOyB9IH07XHJcbiAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KFt0KGZ1bmN0aW9uKCl7cmV0dXJuIHByb2Nlc3N9KSwgdChmdW5jdGlvbigpe3JldHVybiByZXF1aXJlfSksIHQoZnVuY3Rpb24oKXtyZXR1cm4gZ2xvYmFsVGhpcy5wcm9jZXNzfSldKTtcclxuICAgICAgfSkoKWApKSBhcyBzdHJpbmc7XHJcbiAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocikgYXMgc3RyaW5nW107XHJcbiAgICAgIGNvbnN0IHAgPSBwYXJzZWRbMF0gPz8gJ3Vua25vd24nO1xyXG4gICAgICBjb25zdCByZXEgPSBwYXJzZWRbMV0gPz8gJ3Vua25vd24nO1xyXG4gICAgICBjb25zdCBzYWZlID0gKHY6IHN0cmluZyk6IGJvb2xlYW4gPT4gdiA9PT0gJ3VuYXZhaWxhYmxlJyB8fCB2ID09PSAnYmxvY2tlZCc7XHJcbiAgICAgIHJldHVybiBbc2FmZShwKSAmJiBzYWZlKHJlcSksIGBwcm9jZXNzPSR7cH0gcmVxdWlyZT0ke3JlcX1gXTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgY2hlY2soJ3dpbmRvdy5obWggXHU1M0VBXHU2NzA5XHU3NjdEXHU1NDBEXHU1MzU1XHU2NUI5XHU2Q0Q1KFx1NjVFMCBpcGNSZW5kZXJlci9cdTk4OURcdTU5MTZcdTk3NjIpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKCdPYmplY3Qua2V5cyh3aW5kb3cuaG1oIHx8IHt9KS5zb3J0KCkuam9pbihcIixcIiknKSkgYXMgc3RyaW5nO1xyXG4gICAgICBjb25zdCBhbGxvdyA9IFsnYXBwbHlVcGRhdGUnLCAnYXBwcm92ZScsICdhcHByb3ZhbEdldCcsICdhcHByb3ZhbFNldCcsICdicm93c2VSdW50aW1lJywgJ2NoZWNrVXBkYXRlJywgJ2Nocm9tZVRoZW1lJywgJ2NvZ25pdGl2ZScsICdkZXRlY3RSdW50aW1lJywgJ2RpZmYnLCAnZXhwb3J0U2Vzc2lvbicsICdmc0xpc3QnLCAnZnNSZWFkJywgJ2ZzU2VhcmNoJywgJ2dldFN0YXRlJywgJ2dldFdpemFyZCcsICdpbmplY3QnLCAnaW5zdGFsbENsaScsICdpbnRlcnJ1cHQnLCAnbW9kZWxTZXQnLCAnb25FdmVudEJhdGNoZXMnLCAnb25Ib3N0U3RhdGUnLCAnb25JbnN0YWxsUHJvZ3Jlc3MnLCAnb25NZW51QWN0aW9uJywgJ29uU3RyZWFtQ2h1bmtzJywgJ29uVXBkYXRlU3RhdGUnLCAncGlja0RpcmVjdG9yeScsICdwaWNrRmlsZXMnLCAncG9wdXBNYWluTWVudScsICdwcm92aWRlclNhdmUnLCAncHJvdmlkZXJzJywgJ3JlbW90ZVdlYkF1dG9zdGFydCcsICdyZW1vdGVXZWJTdGFydCcsICdyZW1vdGVXZWJTdGF0dXMnLCAncmVtb3RlV2ViU3RvcCcsICdydW50aW1lSW5mbycsICdzZW5kVGFzaycsICdzZXNzaW9uT3AnLCAnc2Vzc2lvblByZXZpZXcnLCAnc2Vzc2lvbnMnLCAnc2V0UnVudGltZScsICdzdG9wSG9zdCcsICd3aXphcmRDb21wbGV0ZScsICd3b3Jrc3BhY2VzJywgJ3dvcmtzcGFjZUFkZCcsICd3b3Jrc3BhY2VVc2UnXTtcclxuICAgICAgY29uc3QgZ290ID0gciA9PT0gJycgPyBbXSA6IHIuc3BsaXQoJywnKTtcclxuICAgICAgY29uc3QgdW5leHBlY3RlZCA9IGdvdC5maWx0ZXIoKGspID0+ICFhbGxvdy5pbmNsdWRlcyhrKSk7XHJcbiAgICAgIHJldHVybiBbdW5leHBlY3RlZC5sZW5ndGggPT09IDAsIGBrZXlzPSR7cn1gXTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgY2hlY2soJ1x1NTkxNlx1OTBFOFx1NUJGQ1x1ODIyQVx1ODhBQlx1NjJFNlx1NjIyQShVUkwgXHU0RTBEXHU1M0Q4KScsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgYmVmb3JlID0gd2luLndlYkNvbnRlbnRzLmdldFVSTCgpO1xyXG4gICAgICBhd2FpdCBqcygnbG9jYXRpb24uaHJlZiA9IFwiaHR0cHM6Ly9leGFtcGxlLmludmFsaWQveFwiOyBcIm5vb3BcIicpLmNhdGNoKCgpID0+ICdub29wJyk7XHJcbiAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyMikgPT4gc2V0VGltZW91dChyMiwgMV8yMDApKTtcclxuICAgICAgY29uc3QgYWZ0ZXIgPSB3aW4ud2ViQ29udGVudHMuZ2V0VVJMKCk7XHJcbiAgICAgIHJldHVybiBbYWZ0ZXIgPT09IGJlZm9yZSwgYCR7YmVmb3JlfSBcdTIxOTIgJHthZnRlcn1gXTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgY2hlY2soJ3dpbmRvdy5vcGVuIFx1ODhBQlx1NjJEMlx1N0VERChcdThGRDRcdTU2REUgbnVsbCBcdTRFMTRcdTY1RTBcdTY1QjBcdTdBOTdcdTUzRTMpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCBiZWZvcmUgPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5sZW5ndGg7XHJcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoJ1N0cmluZyh3aW5kb3cub3BlbihcImh0dHBzOi8vZXhhbXBsZS5pbnZhbGlkXCIpKScpKSBhcyBzdHJpbmc7XHJcbiAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyMikgPT4gc2V0VGltZW91dChyMiwgNDAwKSk7XHJcbiAgICAgIGNvbnN0IGFmdGVyID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkubGVuZ3RoO1xyXG4gICAgICByZXR1cm4gW3IgPT09ICdudWxsJyAmJiBhZnRlciA9PT0gYmVmb3JlLCBgb3BlbigpPSR7cn0gd2luZG93cz0ke2JlZm9yZX1cdTIxOTIke2FmdGVyfWBdO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBjaGVjaygnQ1NQIFx1NUI1OFx1NTcyOChtZXRhIFx1NkNFOFx1NTE2NVx1NjIxNlx1NTRDRFx1NUU5NFx1NTkzNCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IG1ldGEgPSAoYXdhaXQganMoJ0Jvb2xlYW4oZG9jdW1lbnQucXVlcnlTZWxlY3RvcihcIm1ldGFbaHR0cC1lcXVpdj1cXCdDb250ZW50LVNlY3VyaXR5LVBvbGljeVxcJ11cIikpJykpIGFzIGJvb2xlYW47XHJcbiAgICAgIGNvbnN0IGhlYWRlckNzcCA9IGlzRGV2ID8gJ2RldjogaGVhZGVyIENTUCBcdTc1MzEgb25IZWFkZXJzUmVjZWl2ZWQgXHU2Q0U4XHU1MTY1KFx1NEUwRFx1OTAwMlx1NzUyOCBtZXRhIFx1NjVBRFx1OEEwMCknIDogJ3Byb2QnO1xyXG4gICAgICByZXR1cm4gW21ldGEgfHwgaXNEZXYsIGBtZXRhPSR7bWV0YX0gJHtoZWFkZXJDc3B9YF07XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IGNoZWNrKCdicmlkZ2U6Z2V0LXN0YXRlIFx1NkI2M1x1NUUzOFx1OEZENFx1NTZERShob3N0IFx1Njg2NVx1NTNFRlx1NzUyOCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoJ3dpbmRvdy5obWguZ2V0U3RhdGUoKS50aGVuKHMgPT4gSlNPTi5zdHJpbmdpZnkocykpLmNhdGNoKGUgPT4gXCJFUlI6XCIrZSknKSkgYXMgc3RyaW5nO1xyXG4gICAgICByZXR1cm4gW3Iuc3RhcnRzV2l0aCgneycpICYmIHIuaW5jbHVkZXMoJ2hvc3RTdGF0ZScpLCByLnNsaWNlKDAsIDgwKV07XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IGNoZWNrKCdYU1M6XHU2MDc2XHU2MTBGXHU0RUZCXHU1MkExXHU2NTg3XHU2NzJDXHU1M0VBXHU0RUU1XHU2NTg3XHU2NzJDXHU2RTMyXHU2N0QzKFx1NEUwRFx1NjI2N1x1ODg0QyknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHBheWxvYWQgPSAnPGltZyBzcmM9eCBvbmVycm9yPVwid2luZG93Ll9feHNzPTFcIj48c2NyaXB0PndpbmRvdy5fX3hzcz0yPFxcL3NjcmlwdD5cIiZcXCcnO1xyXG4gICAgICBjb25zdCBzZW5kUiA9IChhd2FpdCBqcyhgd2luZG93LmhtaC5zZW5kVGFzaygke0pTT04uc3RyaW5naWZ5KHBheWxvYWQpfSwgJ3NlYy14c3MtMScsICdhdXRvJykudGhlbihyPT5KU09OLnN0cmluZ2lmeShyKSkuY2F0Y2goZT0+J0VSUjonK2UpYCkpIGFzIHN0cmluZztcclxuICAgICAgaWYgKCFzZW5kUi5pbmNsdWRlcygnXCJva1wiOnRydWUnKSkgcmV0dXJuIFtmYWxzZSwgYHNlbmRUYXNrIFx1NjcyQVx1NTNEN1x1NzQwNjogJHtzZW5kUi5zbGljZSgwLCA4MCl9YF07XHJcbiAgICAgIC8vIGZha2UgaG9zdCBlY2hvIFx1NTZERVx1Njc2NVx1NTQwRVx1N0VDRiBSZWFjdCBcdTZFMzJcdTY3RDMoXHU3NTI4XHU2MjM3XHU2RDg4XHU2MDZGICsgXHU1MkE5XHU2MjRCIGVjaG8gXHU1M0NDXHU4REVGXHU1Rjg0KVxyXG4gICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocjIpID0+IHNldFRpbWVvdXQocjIsIDNfMDAwKSk7XHJcbiAgICAgIGNvbnN0IHByb2JlID0gKGF3YWl0IGpzKGBKU09OLnN0cmluZ2lmeSh7XHJcbiAgICAgICAgeHNzRmxhZzogdHlwZW9mIHdpbmRvdy5fX3hzcyxcclxuICAgICAgICBpbWdDb3VudDogZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnaW1nW3NyYz1cInhcIl0nKS5sZW5ndGgsXHJcbiAgICAgICAgc2NyaXB0UmFuOiBkb2N1bWVudC5ib2R5LmlubmVyVGV4dC5pbmRleE9mKCd3aW5kb3cuX194c3M9MicpID49IDBcclxuICAgICAgfSlgKSkgYXMgc3RyaW5nO1xyXG4gICAgICBjb25zdCBwID0gSlNPTi5wYXJzZShwcm9iZSkgYXMgeyB4c3NGbGFnOiBzdHJpbmc7IGltZ0NvdW50OiBudW1iZXI7IHNjcmlwdFJhbjogYm9vbGVhbiB9O1xyXG4gICAgICByZXR1cm4gW3AueHNzRmxhZyA9PT0gJ3VuZGVmaW5lZCcgJiYgcC5pbWdDb3VudCA9PT0gMCwgYHhzc0ZsYWc9JHtwLnhzc0ZsYWd9IGltZz0ke3AuaW1nQ291bnR9YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICBsZXQgZmFpbGVkID0gMDtcclxuICAgIGZvciAoY29uc3QgW25hbWUsIG9rLCBkZXRhaWxdIG9mIHJlc3VsdHMpIHtcclxuICAgICAgY29uc29sZS5sb2coYFNFQ1VSSVRZLVRFU1QgJHtvayA/ICdQQVNTJyA6ICdGQUlMJ30gfCAke25hbWV9IHwgJHtyZWRhY3QoZGV0YWlsKX1gKTtcclxuICAgICAgaWYgKCFvaykgZmFpbGVkICs9IDE7XHJcbiAgICB9XHJcbiAgICBjb25zb2xlLmxvZyhgU0VDVVJJVFktVEVTVCBTVU1NQVJZIHBhc3M9JHtyZXN1bHRzLmxlbmd0aCAtIGZhaWxlZH0vJHtyZXN1bHRzLmxlbmd0aH1gKTtcclxuICAgIGFwcC5leGl0KGZhaWxlZCA9PT0gMCA/IDAgOiAxKTtcclxuICB9XHJcblxyXG4gIC8vIFx1OTAwMFx1NTFGQTpcdTRGMThcdTk2QzVcdTUwNUNcdTZCNjJcdTgxRUFcdTVERjEgc3Bhd24gXHU3Njg0IGhvc3Qoc2h1dGRvd24gXHU3QUVGXHU3MEI5IFx1MjE5MiBcdTUxNUNcdTVFOTVcdTUzRUEga2lsbCBcdTgxRUFcdTVERjFcdTc2ODRcdTUzRTVcdTY3QzQpXHJcbiAgYXBwLm9uKCdiZWZvcmUtcXVpdCcsIChlKSA9PiB7XHJcbiAgICBpZiAoc3VwZXJ2aXNvciAhPT0gbnVsbCAmJiBzdXBlcnZpc29yLnN0YXRlICE9PSAnc3RvcHBlZCcpIHtcclxuICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xyXG4gICAgICBzc2VBYm9ydD8uYWJvcnQoKTtcclxuICAgICAgdm9pZCBzdXBlcnZpc29yLnN0b3AoKS5maW5hbGx5KCgpID0+IGFwcC5xdWl0KCkpO1xyXG4gICAgfVxyXG4gIH0pO1xyXG4gIGFwcC5vbignd2luZG93LWFsbC1jbG9zZWQnLCAoKSA9PiB7XHJcbiAgICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSAhPT0gJ2RhcndpbicpIGFwcC5xdWl0KCk7XHJcbiAgfSk7XHJcbn1cclxuIiwgIi8qKlxuICogRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yIFx1MjAxNCBobWhhcm5lc3MgaG9zdCBcdThGREJcdTdBMEJcdTc2ODRcdTc1MUZcdTU0N0RcdTU0NjhcdTY3MUZcdTcyQjZcdTYwMDFcdTY3M0EoQURSLTAwMylcdTMwMDJcbiAqXG4gKiBcdTVCODlcdTUxNjhcdTRFMERcdTUzRDhcdTkxQ0Y6XG4gKiAgLSBcdTUzRUFcdTdFRDFcdTVCOUEvXHU2M0EyXHU2RDRCIDEyNy4wLjAuMTtob3N0IFx1NEY3Rlx1NzUyOFx1NjRDRFx1NEY1Q1x1N0NGQlx1N0VERlx1NTIwNlx1OTE0RFx1N0FFRlx1NTNFMyhwb3J0IDApLFx1NUI5RVx1OTY0NVx1N0FFRlx1NTNFM1xuICogICAgXHU3NTMxIGhvc3QgXHU3Njg0IHN0ZG91dCBcdTVGMTVcdTVCRkNcdTg4NENcdTU2REVcdTRGMjAoSG9zdFJlYWR5TGluZSlcdTMwMDJcbiAqICAtIFx1OUFEOFx1NzFCNSB0b2tlbiBcdTUzRUFcdTkwMUFcdThGQzdcdTVCNTBcdThGREJcdTdBMEJcdTczQUZcdTU4ODNcdTUzRDhcdTkxQ0ZcdTRGMjBcdTkwMTIsXHU3RUREXHU0RTBEXHU4RkRCIFVSTC9cdTY1RTVcdTVGRDcvSVBDIFx1NjYwRVx1NjU4N1x1OEQxRlx1OEY3RFx1MzAwMlxuICogIC0gXHU1M0VBXHU1MDVDXHU2QjYyXHU2NzJDIHN1cGVydmlzb3Igc3Bhd24gXHU3Njg0XHU4RkRCXHU3QTBCXHU1M0U1XHU2N0M0O1x1N0VERFx1NEUwRFx1NjMwOVx1OEZEQlx1N0EwQlx1NTQwRCBraWxsXHUzMDAyXG4gKiAgLSBob3N0IGNyYXNoIFx1NTQwRVx1NjcwOVx1OTY1MFx1OTFDRFx1NTQyRjtcdTkxQ0RcdTU0MkZcdTRFMERcdTkxQ0RcdTY1M0VcdTRFRkJcdTRGNTVcdTc1MjhcdTYyMzdcdTUyQThcdTRGNUMoXHU5NzVFXHU1RTQyXHU3QjQ5XHU1MkE4XHU0RjVDXHU3NTMxXHU3NTI4XHU2MjM3XHU3ODZFXHU4QkE0KVx1MzAwMlxuICovXG5pbXBvcnQgeyBzcGF3biwgdHlwZSBDaGlsZFByb2Nlc3MgfSBmcm9tICdub2RlOmNoaWxkX3Byb2Nlc3MnO1xuaW1wb3J0IHsgY3JlYXRlSW50ZXJmYWNlIH0gZnJvbSAnbm9kZTpyZWFkbGluZSc7XG5pbXBvcnQgeyByYW5kb21CeXRlcyB9IGZyb20gJ25vZGU6Y3J5cHRvJztcbmltcG9ydCB7IGRlc2t0b3BFcnJvciwgaXNEZXNrdG9wRXJyb3IsIHR5cGUgRGVza3RvcEVycm9yIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyc7XG5cbmV4cG9ydCB0eXBlIEhvc3RTdGF0ZSA9XG4gIHwgJ3N0b3BwZWQnXG4gIHwgJ3N0YXJ0aW5nJ1xuICB8ICdyZWFkeSdcbiAgfCAnZGlzY29ubmVjdGVkJ1xuICB8ICdyZXN0YXJ0aW5nJ1xuICB8ICdzdG9wcGluZydcbiAgfCAnZmFpbGVkJztcblxuZXhwb3J0IGludGVyZmFjZSBIb3N0U3BlYyB7XG4gIC8qKiBcdTUzRUZcdTYyNjdcdTg4NENcdTY1ODdcdTRFRjYoXHU5MDFBXHU1RTM4IHByb2Nlc3MuZXhlY1BhdGgpXHUzMDAyICovXG4gIGNvbW1hbmQ6IHN0cmluZztcbiAgYXJnczogc3RyaW5nW107XG4gIGN3ZD86IHN0cmluZztcbiAgLyoqIFx1OTg5RFx1NTkxNlx1NzNBRlx1NTg4M1x1NTNEOFx1OTFDRihcdTRGMUFcdTRFMEUgcHJvY2Vzcy5lbnYgXHU1NDA4XHU1RTc2KVx1MzAwMiAqL1xuICBlbnY/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFN1cGVydmlzb3JPcHRpb25zIHtcbiAgLyoqIFx1NjcxRlx1NjcxQiBob3N0IFx1NjgyMVx1OUE4Q1x1NzY4NCBiZWFyZXIgdG9rZW47XHU0RTBEXHU0RjIwXHU1MjE5XHU2QkNGXHU2QjIxIHN0YXJ0IFx1NzUxRlx1NjIxMFx1OUFEOFx1NzFCNVx1OTY4Rlx1NjczQVx1NTAzQ1x1MzAwMiAqL1xuICB0b2tlbj86IHN0cmluZztcbiAgbWF4UmVzdGFydHM/OiBudW1iZXI7XG4gIHN0YXJ0VGltZW91dE1zPzogbnVtYmVyO1xuICBncmFjZWZ1bFNodXRkb3duTXM/OiBudW1iZXI7XG4gIG9uU3RhdGVDaGFuZ2U/KHN0YXRlOiBIb3N0U3RhdGUsIGluZm86IHsgcmVzdGFydENvdW50OiBudW1iZXI7IGxhc3RFcnJvcj86IHN0cmluZyB9KTogdm9pZDtcbiAgLyoqIFx1NkJDRlx1NkIyMSBob3N0IFx1NUMzMVx1N0VFQShcdTU0MkIgY3Jhc2ggXHU4MUVBXHU2MTA4XHU1NDBFXHU3Njg0XHU5MUNEXHU1NDJGKVx1OTBGRFx1NEYxQVx1ODlFNlx1NTNEMSxcdTY0M0FcdTVFMjZcdTdBRUZcdTcwQjkoXHU1NDJCIHRva2VuLFxuICAgKiAgXHU0RUM1XHU0RjlCXHU1NDBDXHU0RkUxXHU0RUZCXHU1N0RGXHU3Njg0XHU1QkJGXHU0RTNCXHU4RkRCXHU3QTBCXHU5MUNEXHU1RUZBXHU2ODY1XHU1QkEyXHU2MjM3XHU3QUVGO1x1NEUwRFx1ODk4MVx1OERFOFx1OEZEQiByZW5kZXJlcilcdTMwMDIgKi9cbiAgb25SZWFkeT8oZW5kcG9pbnQ6IEhvc3RFbmRwb2ludCk6IHZvaWQ7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgSG9zdEVuZHBvaW50IHtcbiAgcG9ydDogbnVtYmVyO1xuICB2ZXJzaW9uOiBzdHJpbmc7XG4gIHRva2VuOiBzdHJpbmc7XG59XG5cbi8qKiBIb3N0UmVhZHlMaW5lIFx1NzY4NFx1N0M3Qlx1NTc4Qlx1NUI4OFx1NTM2Qlx1NEVDRSBjb250cmFjdHMgXHU1RjE1XHU1MTY1LFx1OTA3Rlx1NTE0RFx1NTNDQ1x1NUI5RVx1NzNCMFx1MzAwMiAqL1xuaW1wb3J0IHsgaXNIb3N0UmVhZHlMaW5lIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyc7XG5cbi8vIDQ1czpobWhhcm5lc3MgXHU3NzFGXHU1QjlFXHU1MTY1XHU1M0UzXHU3RUNGIHRzeCBcdTUxQjdcdTdGMTZcdThCRDFcdTY1NzRcdTU5NTcgQ0xJLFx1NjczQVx1NTY2OFx1OUFEOFx1OEQxRlx1OEY3RFx1NjVGNlx1NTNFRlx1OEQ4NSAyMHNcbi8vICgyMDI2LTEwLTExIFx1OEZERVx1N0VFRFx1OUE4Q1x1NjUzNlx1NEUyRFx1OTVGNFx1NkI0N1x1NjAyNyBIT1NUX05PVF9SRUFEWSBcdTc2ODRcdTY4MzlcdTU2RTA7XHU3QTdBXHU5NUYyXHU1QjlFXHU2RDRCIDZzKVx1MzAwMlxuY29uc3QgREVGQVVMVF9TVEFSVF9USU1FT1VUX01TID0gNDVfMDAwO1xuY29uc3QgREVGQVVMVF9NQVhfUkVTVEFSVFMgPSAzO1xuY29uc3QgREVGQVVMVF9HUkFDRUZVTF9NUyA9IDVfMDAwO1xuXG5leHBvcnQgY2xhc3MgRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yIHtcbiAgcHJpdmF0ZSBjaGlsZDogQ2hpbGRQcm9jZXNzIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgX3N0YXRlOiBIb3N0U3RhdGUgPSAnc3RvcHBlZCc7XG4gIHByaXZhdGUgcmVzdGFydENvdW50ID0gMDtcbiAgcHJpdmF0ZSBsYXN0RXJyb3IgPSAnJztcbiAgcHJpdmF0ZSBzdG9wcGluZyA9IGZhbHNlO1xuICBwcml2YXRlIHJlYWRvbmx5IHRva2VuOiBzdHJpbmc7XG4gIHByaXZhdGUgcmVhZG9ubHkgb3B0czogUmVxdWlyZWQ8UGljazxTdXBlcnZpc29yT3B0aW9ucywgJ21heFJlc3RhcnRzJyB8ICdzdGFydFRpbWVvdXRNcycgfCAnZ3JhY2VmdWxTaHV0ZG93bk1zJz4+ICYgU3VwZXJ2aXNvck9wdGlvbnM7XG4gIHByaXZhdGUgZXhpdFdhaXRlcnM6IEFycmF5PCgpID0+IHZvaWQ+ID0gW107XG5cbiAgY29uc3RydWN0b3IoXG4gICAgcHJpdmF0ZSByZWFkb25seSBzcGVjOiBIb3N0U3BlYyxcbiAgICBvcHRzOiBTdXBlcnZpc29yT3B0aW9ucyA9IHt9LFxuICApIHtcbiAgICB0aGlzLnRva2VuID0gb3B0cy50b2tlbiA/PyByYW5kb21CeXRlcygzMikudG9TdHJpbmcoJ2Jhc2U2NHVybCcpO1xuICAgIHRoaXMub3B0cyA9IHtcbiAgICAgIG1heFJlc3RhcnRzOiBvcHRzLm1heFJlc3RhcnRzID8/IERFRkFVTFRfTUFYX1JFU1RBUlRTLFxuICAgICAgc3RhcnRUaW1lb3V0TXM6IG9wdHMuc3RhcnRUaW1lb3V0TXMgPz8gREVGQVVMVF9TVEFSVF9USU1FT1VUX01TLFxuICAgICAgZ3JhY2VmdWxTaHV0ZG93bk1zOiBvcHRzLmdyYWNlZnVsU2h1dGRvd25NcyA/PyBERUZBVUxUX0dSQUNFRlVMX01TLFxuICAgICAgLi4ub3B0cyxcbiAgICB9O1xuICB9XG5cbiAgZ2V0IHN0YXRlKCk6IEhvc3RTdGF0ZSB7XG4gICAgcmV0dXJuIHRoaXMuX3N0YXRlO1xuICB9XG5cbiAgZ2V0IHJlc3RhcnRzVXNlZCgpOiBudW1iZXIge1xuICAgIHJldHVybiB0aGlzLnJlc3RhcnRDb3VudDtcbiAgfVxuXG4gIHByaXZhdGUgc2V0U3RhdGUoczogSG9zdFN0YXRlLCBlcnI/OiBzdHJpbmcpOiB2b2lkIHtcbiAgICB0aGlzLl9zdGF0ZSA9IHM7XG4gICAgaWYgKGVyciAhPT0gdW5kZWZpbmVkKSB0aGlzLmxhc3RFcnJvciA9IGVycjtcbiAgICBjb25zdCBpbmZvOiB7IHJlc3RhcnRDb3VudDogbnVtYmVyOyBsYXN0RXJyb3I/OiBzdHJpbmcgfSA9IHsgcmVzdGFydENvdW50OiB0aGlzLnJlc3RhcnRDb3VudCB9O1xuICAgIGlmICh0aGlzLmxhc3RFcnJvciAhPT0gJycpIGluZm8ubGFzdEVycm9yID0gdGhpcy5sYXN0RXJyb3I7XG4gICAgdGhpcy5vcHRzLm9uU3RhdGVDaGFuZ2U/LihzLCBpbmZvKTtcbiAgfVxuXG4gIC8qKiBcdTU0MkZcdTUyQTggaG9zdCBcdTVFNzZcdTdCNDlcdTVGODUgcmVhZHkoXHU1RjE1XHU1QkZDXHU4ODRDICsgXHU1RTI2IHRva2VuIFx1NzY4NFx1NTA2NVx1NUVCN1x1NjNBMlx1NkQ0QilcdTMwMDIgKi9cbiAgYXN5bmMgc3RhcnQoKTogUHJvbWlzZTxIb3N0RW5kcG9pbnQ+IHtcbiAgICBpZiAodGhpcy5fc3RhdGUgPT09ICdyZWFkeScgfHwgdGhpcy5fc3RhdGUgPT09ICdzdGFydGluZycpIHtcbiAgICAgIHRocm93IGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgc3VwZXJ2aXNvciBhbHJlYWR5ICR7dGhpcy5fc3RhdGV9YCk7XG4gICAgfVxuICAgIHRoaXMucmVzdGFydENvdW50ID0gMDtcbiAgICB0aGlzLnN0b3BwaW5nID0gZmFsc2U7XG4gICAgcmV0dXJuIHRoaXMubGF1bmNoKCk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGxhdW5jaCgpOiBQcm9taXNlPEhvc3RFbmRwb2ludD4ge1xuICAgIHRoaXMuc2V0U3RhdGUoJ3N0YXJ0aW5nJyk7XG4gICAgY29uc3QgY2hpbGQgPSBzcGF3bih0aGlzLnNwZWMuY29tbWFuZCwgdGhpcy5zcGVjLmFyZ3MsIHtcbiAgICAgIGN3ZDogdGhpcy5zcGVjLmN3ZCxcbiAgICAgIGVudjoge1xuICAgICAgICAuLi5wcm9jZXNzLmVudixcbiAgICAgICAgLi4udGhpcy5zcGVjLmVudixcbiAgICAgICAgSE1IX0RFU0tUT1BfVE9LRU46IHRoaXMudG9rZW4sXG4gICAgICB9LFxuICAgICAgc3RkaW86IFsnaWdub3JlJywgJ3BpcGUnLCAncGlwZSddLFxuICAgICAgd2luZG93c0hpZGU6IHRydWUsXG4gICAgfSk7XG4gICAgdGhpcy5jaGlsZCA9IGNoaWxkO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGVuZHBvaW50ID0gYXdhaXQgdGhpcy5hd2FpdFJlYWR5KGNoaWxkKTtcbiAgICAgIHRoaXMuY3VycmVudEVuZHBvaW50ID0geyBwb3J0OiBlbmRwb2ludC5wb3J0LCB2ZXJzaW9uOiBlbmRwb2ludC52ZXJzaW9uIH07XG4gICAgICB0aGlzLnNldFN0YXRlKCdyZWFkeScpO1xuICAgICAgdGhpcy5vcHRzLm9uUmVhZHk/LihlbmRwb2ludCk7XG4gICAgICAvLyByZWFkeSBcdTRFNEJcdTU0MEVcdThGREJcdTdBMEJcdTZCN0JcdTRFQTEgPSBcdTYxMEZcdTU5MTZcdTkwMDBcdTUxRkEgXHUyMTkyIFx1NjcwOVx1OTY1MFx1OTFDRFx1NTQyRlxuICAgICAgY2hpbGQub25jZSgnZXhpdCcsICgpID0+IHtcbiAgICAgICAgdGhpcy5leGl0V2FpdGVycy5mb3JFYWNoKCh3KSA9PiB3KCkpO1xuICAgICAgICB0aGlzLmV4aXRXYWl0ZXJzID0gW107XG4gICAgICAgIHRoaXMub25VbmV4cGVjdGVkRXhpdCgpO1xuICAgICAgfSk7XG4gICAgICByZXR1cm4gZW5kcG9pbnQ7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBpZiAoIWNoaWxkLmtpbGxlZCkgY2hpbGQua2lsbCgpO1xuICAgICAgaWYgKHRoaXMuY2hpbGQgPT09IGNoaWxkKSB0aGlzLmNoaWxkID0gbnVsbDtcbiAgICAgIHRocm93IGVycjtcbiAgICB9XG4gIH1cblxuICAvKiogXHU0RUNFIHN0ZG91dCBcdTYyN0UgSG9zdFJlYWR5TGluZSxcdTcxMzZcdTU0MEVcdTUwNjVcdTVFQjdcdTYzQTJcdTZENEJcdTMwMDIgKi9cbiAgcHJpdmF0ZSBhd2FpdFJlYWR5KGNoaWxkOiBDaGlsZFByb2Nlc3MpOiBQcm9taXNlPEhvc3RFbmRwb2ludD4ge1xuICAgIHJldHVybiBuZXcgUHJvbWlzZTxIb3N0RW5kcG9pbnQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgIHJlamVjdChkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYGhvc3QgZGlkIG5vdCBzaWduYWwgcmVhZHkgd2l0aGluICR7dGhpcy5vcHRzLnN0YXJ0VGltZW91dE1zfW1zYCwgeyByZXRyeWFibGU6IHRydWUsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XG4gICAgICB9LCB0aGlzLm9wdHMuc3RhcnRUaW1lb3V0TXMpO1xuXG4gICAgICBjb25zdCBkb25lID0gKGZuOiAoKSA9PiB2b2lkKTogdm9pZCA9PiB7XG4gICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgIGZuKCk7XG4gICAgICB9O1xuXG4gICAgICBpZiAoIWNoaWxkLnN0ZG91dCkge1xuICAgICAgICBkb25lKCgpID0+IHJlamVjdChkZXNrdG9wRXJyb3IoJ1JVTlRJTUVfQ1JBU0hFRCcsICdob3N0IHNwYXduZWQgd2l0aG91dCBzdGRvdXQgcGlwZScpKSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgY29uc3QgcmwgPSBjcmVhdGVJbnRlcmZhY2UoeyBpbnB1dDogY2hpbGQuc3Rkb3V0IH0pO1xuICAgICAgY29uc3Qgb25MaW5lID0gKGxpbmU6IHN0cmluZyk6IHZvaWQgPT4ge1xuICAgICAgICBsZXQgcGFyc2VkOiB1bmtub3duO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHBhcnNlZCA9IEpTT04ucGFyc2UobGluZSk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIHJldHVybjsgLy8gaG9zdCBcdTc2ODRcdTY2NkVcdTkwMUFcdTY1RTVcdTVGRDdcdTg4NEMsXHU1RkZEXHU3NTY1XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGlzSG9zdFJlYWR5TGluZShwYXJzZWQpKSB7XG4gICAgICAgICAgcmwuY2xvc2UoKTtcbiAgICAgICAgICB2b2lkIHRoaXMucHJvYmVBbmRSZW1lbWJlcihwYXJzZWQucG9ydCwgcGFyc2VkLnZlcnNpb24pXG4gICAgICAgICAgICAudGhlbigoZW5kcG9pbnQpID0+IGRvbmUoKCkgPT4gcmVzb2x2ZShlbmRwb2ludCkpKVxuICAgICAgICAgICAgLmNhdGNoKChlcnI6IHVua25vd24pID0+IGRvbmUoKCkgPT4gcmVqZWN0KGVycikpKTtcbiAgICAgICAgfVxuICAgICAgfTtcbiAgICAgIHJsLm9uKCdsaW5lJywgb25MaW5lKTtcblxuICAgICAgY2hpbGQub25jZSgnZXhpdCcsIChjb2RlKSA9PiB7XG4gICAgICAgIGRvbmUoKCkgPT4gcmVqZWN0KGRlc2t0b3BFcnJvcignUlVOVElNRV9DUkFTSEVEJywgYGhvc3QgZXhpdGVkIGR1cmluZyBzdGFydHVwIChjb2RlICR7Y29kZSA/PyAnbnVsbCd9KWAsIHsgcmV0cnlhYmxlOiBmYWxzZSwgcmVjb3ZlcnlBY3Rpb246ICdPUEVOX0xPR1MnIH0pKSk7XG4gICAgICB9KTtcbiAgICB9KTtcbiAgfVxuXG4gIC8qKiBcdTVFMjYgdG9rZW4gXHU3Njg0XHU1MDY1XHU1RUI3XHU2M0EyXHU2RDRCOkdFVCAvYXBpL3N0YXRlXHUzMDAyNDAxIFx1MjE5MiBBVVRIX0ZBSUxFRChcdTRFMERcdTkxQ0RcdThCRDUpXHUzMDAyICovXG4gIHByaXZhdGUgYXN5bmMgcHJvYmUocG9ydDogbnVtYmVyLCB2ZXJzaW9uOiBzdHJpbmcpOiBQcm9taXNlPEhvc3RFbmRwb2ludD4ge1xuICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgIHRyeSB7XG4gICAgICByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2FwaS9zdGF0ZWAsIHtcbiAgICAgICAgaGVhZGVyczogeyAneC1obWgta2V5JzogdGhpcy50b2tlbiB9LFxuICAgICAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoM18wMDApLFxuICAgICAgfSk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICB0aHJvdyBkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYGhlYWx0aCBwcm9iZSBmYWlsZWQ6ICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTYwKX1gLCB7IHJldHJ5YWJsZTogdHJ1ZSB9KTtcbiAgICB9XG4gICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSB8fCByZXMuc3RhdHVzID09PSA0MDMpIHtcbiAgICAgIHRocm93IGRlc2t0b3BFcnJvcignQVVUSF9GQUlMRUQnLCBgaG9zdCByZWplY3RlZCB0aGUgc2Vzc2lvbiB0b2tlbiAoSFRUUCAke3Jlcy5zdGF0dXN9KWAsIHsgcmV0cnlhYmxlOiBmYWxzZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pO1xuICAgIH1cbiAgICBpZiAoIXJlcy5vaykge1xuICAgICAgdGhyb3cgZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBoZWFsdGggcHJvYmUgSFRUUCAke3Jlcy5zdGF0dXN9YCwgeyByZXRyeWFibGU6IHRydWUgfSk7XG4gICAgfVxuICAgIHJldHVybiB7IHBvcnQsIHZlcnNpb24sIHRva2VuOiB0aGlzLnRva2VuIH07XG4gIH1cblxuICBwcml2YXRlIG9uVW5leHBlY3RlZEV4aXQoKTogdm9pZCB7XG4gICAgaWYgKHRoaXMuc3RvcHBpbmcgfHwgdGhpcy5fc3RhdGUgPT09ICdzdG9wcGVkJyB8fCB0aGlzLl9zdGF0ZSA9PT0gJ3N0b3BwaW5nJykgcmV0dXJuO1xuICAgIHRoaXMuY2hpbGQgPSBudWxsO1xuICAgIGlmICh0aGlzLnJlc3RhcnRDb3VudCA8IHRoaXMub3B0cy5tYXhSZXN0YXJ0cykge1xuICAgICAgdGhpcy5yZXN0YXJ0Q291bnQgKz0gMTtcbiAgICAgIHRoaXMuc2V0U3RhdGUoJ3Jlc3RhcnRpbmcnKTtcbiAgICAgIHZvaWQgdGhpcy5sYXVuY2goKS5jYXRjaCgoKSA9PiB7XG4gICAgICAgIC8vIFx1OTFDRFx1NTQyRlx1NUMxRFx1OEJENVx1NTkzMVx1OEQyNShcdTU0MkZcdTUyQThcdTUzNzNcdTVEMjkvXHU4RDg1XHU2NUY2L1x1NjJEMlx1OEJBNCk6XHU3RUU3XHU3RUVEXHU2RDg4XHU4MDE3XHU5MUNEXHU1NDJGXHU2QjIxXHU2NTcwXHU3NkY0XHU1MjMwXHU2NTNFXHU1RjAzXG4gICAgICAgIHRoaXMucmV0cnlPckZhaWwoKTtcbiAgICAgIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLnNldFN0YXRlKCdmYWlsZWQnLCBgaG9zdCBleGl0ZWQgdW5leHBlY3RlZGx5ICR7dGhpcy5yZXN0YXJ0Q291bnQgKyAxfSB0aW1lczsgZ2l2aW5nIHVwYCk7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSByZXRyeU9yRmFpbCgpOiB2b2lkIHtcbiAgICBpZiAodGhpcy5zdG9wcGluZyB8fCB0aGlzLl9zdGF0ZSA9PT0gJ3N0b3BwZWQnIHx8IHRoaXMuX3N0YXRlID09PSAnc3RvcHBpbmcnKSByZXR1cm47XG4gICAgaWYgKHRoaXMucmVzdGFydENvdW50IDwgdGhpcy5vcHRzLm1heFJlc3RhcnRzKSB7XG4gICAgICB0aGlzLnJlc3RhcnRDb3VudCArPSAxO1xuICAgICAgdGhpcy5zZXRTdGF0ZSgncmVzdGFydGluZycpO1xuICAgICAgdm9pZCB0aGlzLmxhdW5jaCgpLmNhdGNoKCgpID0+IHRoaXMucmV0cnlPckZhaWwoKSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMuc2V0U3RhdGUoJ2ZhaWxlZCcsIGBob3N0IGZhaWxlZCB0byBzdGF5IHVwIGFmdGVyICR7dGhpcy5yZXN0YXJ0Q291bnR9IHJlc3RhcnQgYXR0ZW1wdHNgKTtcbiAgICB9XG4gIH1cblxuICAvKiogXHU0RjE4XHU5NkM1XHU1MDVDXHU2QjYyOlx1NTE0OCBIVFRQIHNodXRkb3duLFx1OEQ4NVx1NjVGNlx1NjI0RFx1NUJGOVx1NjcyQ1x1OEZEQlx1N0EwQlx1NTNFNVx1NjdDNCBraWxsXHUzMDAyICovXG4gIGFzeW5jIHN0b3AoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgdGhpcy5zdG9wcGluZyA9IHRydWU7XG4gICAgaWYgKHRoaXMuX3N0YXRlID09PSAnc3RvcHBlZCcpIHJldHVybjtcbiAgICB0aGlzLnNldFN0YXRlKCdzdG9wcGluZycpO1xuICAgIGNvbnN0IGNoaWxkID0gdGhpcy5jaGlsZDtcbiAgICB0aGlzLmNoaWxkID0gbnVsbDtcbiAgICB0aGlzLmN1cnJlbnRFbmRwb2ludCA9IG51bGw7XG4gICAgaWYgKCFjaGlsZCkge1xuICAgICAgdGhpcy5zZXRTdGF0ZSgnc3RvcHBlZCcpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBleGl0ZWQgPSBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4ge1xuICAgICAgaWYgKGNoaWxkLmV4aXRDb2RlICE9PSBudWxsIHx8IGNoaWxkLnNpZ25hbENvZGUgIT09IG51bGwpIHJlc29sdmUoKTtcbiAgICAgIGVsc2Uge1xuICAgICAgICBjb25zdCB3ID0gKCk6IHZvaWQgPT4gcmVzb2x2ZSgpO1xuICAgICAgICB0aGlzLmV4aXRXYWl0ZXJzLnB1c2godyk7XG4gICAgICAgIGNoaWxkLm9uY2UoJ2V4aXQnLCB3KTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICAvLyBcdTVERjJcdTc3RTVcdTdBRUZcdTUzRTNcdTYyNERcdTVDMURcdThCRDUgSFRUUCBcdTRGMThcdTk2QzVcdTUxNzNcdTk1RUQ7XHU2NzJBXHU3N0U1XHU3QUVGXHU1M0UzXHU3NkY0XHU2M0E1XHU4RDcwIGtpbGwgXHU1MTVDXHU1RTk1XG4gICAgaWYgKHRoaXMubGFzdEVuZHBvaW50ICE9PSBudWxsKSB7XG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3RoaXMubGFzdEVuZHBvaW50fS9hcGkvZGVza3RvcC9zaHV0ZG93bmAsIHtcbiAgICAgICAgICBtZXRob2Q6ICdQT1NUJyxcbiAgICAgICAgICBoZWFkZXJzOiB7ICd4LWhtaC1rZXknOiB0aGlzLnRva2VuIH0sXG4gICAgICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDFfMDAwKSxcbiAgICAgICAgfSk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLy8gaG9zdCBcdTVERjJcdTZCN0JcdTYyMTZcdTRFMERcdTVFOTRcdTdCNTQ6XHU4RDcwIGtpbGwgXHU1MTVDXHU1RTk1XG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IGdyYWNlZnVsID0gYXdhaXQgUHJvbWlzZS5yYWNlKFtcbiAgICAgIGV4aXRlZC50aGVuKCgpID0+IHRydWUpLFxuICAgICAgbmV3IFByb21pc2U8Ym9vbGVhbj4oKHJlc29sdmUpID0+IHNldFRpbWVvdXQoKCkgPT4gcmVzb2x2ZShmYWxzZSksIHRoaXMub3B0cy5ncmFjZWZ1bFNodXRkb3duTXMpKSxcbiAgICBdKTtcbiAgICBpZiAoIWdyYWNlZnVsICYmIGNoaWxkLmV4aXRDb2RlID09PSBudWxsICYmIGNoaWxkLnNpZ25hbENvZGUgPT09IG51bGwpIHtcbiAgICAgIGNoaWxkLmtpbGwoKTsgLy8gXHU1M0VBXHU2NzQwXHU4MUVBXHU1REYxXHU2MzAxXHU2NzA5XHU3Njg0XHU1M0U1XHU2N0M0LFx1N0VERFx1NEUwRFx1NjMwOVx1OEZEQlx1N0EwQlx1NTQwRFxuICAgIH1cbiAgICBhd2FpdCBleGl0ZWQuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcbiAgICB0aGlzLnNldFN0YXRlKCdzdG9wcGVkJyk7XG4gIH1cblxuICBwcml2YXRlIGxhc3RFbmRwb2ludDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgY3VycmVudEVuZHBvaW50OiB7IHBvcnQ6IG51bWJlcjsgdmVyc2lvbjogc3RyaW5nIH0gfCBudWxsID0gbnVsbDtcblxuICAvKiogXHU1RjUzXHU1MjREIGhvc3QgXHU3QUVGXHU3MEI5KHJlYWR5IFx1NTQwRVx1NjcwOVx1NTAzQztcdTRFMERcdTU0MkIgdG9rZW4pXHUzMDAyICovXG4gIGdldCBlbmRwb2ludCgpOiB7IHBvcnQ6IG51bWJlcjsgdmVyc2lvbjogc3RyaW5nIH0gfCBudWxsIHtcbiAgICByZXR1cm4gdGhpcy5jdXJyZW50RW5kcG9pbnQ7XG4gIH1cblxuICAvKiogXHU2M0EyXHU2RDRCXHU2MjEwXHU1MjlGXHU1NDBFXHU4QkIwXHU0RjRGXHU3QUVGXHU1M0UzLFx1NEY5QiBzdG9wKCkgXHU3Njg0XHU0RjE4XHU5NkM1XHU1MTczXHU5NUVEXHU0RjdGXHU3NTI4XHUzMDAyICovXG4gIHByaXZhdGUgYXN5bmMgcHJvYmVBbmRSZW1lbWJlcihwb3J0OiBudW1iZXIsIHZlcnNpb246IHN0cmluZyk6IFByb21pc2U8SG9zdEVuZHBvaW50PiB7XG4gICAgY29uc3QgZXAgPSBhd2FpdCB0aGlzLnByb2JlKHBvcnQsIHZlcnNpb24pO1xuICAgIHRoaXMubGFzdEVuZHBvaW50ID0gZXAucG9ydDtcbiAgICByZXR1cm4gZXA7XG4gIH1cbn1cblxuLyoqIFx1NjI4QVx1NjcyQVx1NzdFNVx1OTUxOVx1OEJFRlx1ODlDNFx1N0VBNlx1NEUzQSBEZXNrdG9wRXJyb3IoXHU1REYyXHU2NjJGXHU1MjE5XHU1MzlGXHU2ODM3XHU4RkQ0XHU1NkRFKVx1MzAwMiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRvRGVza3RvcEVycm9yKGVycjogdW5rbm93bik6IERlc2t0b3BFcnJvciB7XG4gIGlmIChpc0Rlc2t0b3BFcnJvcihlcnIpKSByZXR1cm4gZXJyO1xuICBjb25zdCBtZXNzYWdlID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICByZXR1cm4gZGVza3RvcEVycm9yKCdSVU5USU1FX0NSQVNIRUQnLCBtZXNzYWdlLnNsaWNlKDAsIDMwMCksIHsgcmV0cnlhYmxlOiBmYWxzZSB9KTtcbn1cbiIsICIvKipcbiAqIEBobWgtZGVza3RvcC9jb250cmFjdHMgXHUyMDE0IFx1NEU4Qlx1NEVGNlx1NEZFMVx1NUMwMShcdTVGMDBcdTUzRDFcdThCQTFcdTUyMTJcdTY1ODdcdTY4NjMgMDQgXHUwMEE3XHU0RTA5KVxuICpcbiAqIFx1NEUwMFx1Njc2MSBVSSBcdTRFOEJcdTRFRjZcdTc2ODRcdTU1MkZcdTRFMDBcdTVGNjJcdTcyQjZcdTMwMDJcdTUyNERcdTdBRUYgcmVkdWNlciBcdTVGQzVcdTk4N0JcdTYzMDkgc2Vzc2lvbklkL3J1bklkL3NlcSBcdTU5MDRcdTc0MDY7XG4gKiBcdTkxQ0RcdTU5MEQgZXZlbnRJZCBcdTVFNDJcdTdCNDlcdTRFMjJcdTVGMDM7c2VxIFx1N0YzQVx1NTNFM1x1ODlFNlx1NTNEMVx1ODg2NVx1NjJDOTtcdTk3NUVcdTVFNDJcdTdCNDlcdTUyQThcdTRGNUNcdTRFMERcdTc1MzEgU1NFIFx1ODFFQVx1NTJBOFx1OTFDRFx1NTNEMVx1MzAwMlxuICovXG5cbmltcG9ydCB0eXBlIHsgQXJ0aWZhY3RSZWYgfSBmcm9tICcuL2R0by50cyc7XG5pbXBvcnQgdHlwZSB7IERlc2t0b3BFcnJvciB9IGZyb20gJy4vZXJyb3IudHMnO1xuXG4vKiogXHU0RThCXHU0RUY2XHU3OUNEXHU3QzdCKFx1NTIyNFx1NTIyQlx1OTUyRSlcdTMwMDJcdTY1QjBcdTU4OUUga2luZCA9IHNjaGVtYVZlcnNpb24gXHU1MzQ3XHU3RUE3LFx1NEUwRFx1NTE0MVx1OEJCOFx1OTc1OVx1OUVEOFx1NjI2OVx1Njc5QVx1NEUzRVx1MzAwMiAqL1xuZXhwb3J0IGNvbnN0IEVWRU5UX0tJTkRTID0gW1xuICAncnVuLnN0YXJ0ZWQnLFxuICAncGxhbi51cGRhdGVkJyxcbiAgJ3Rvb2wuc3RhcnRlZCcsXG4gICd0b29sLmNvbXBsZXRlZCcsXG4gICdhcHByb3ZhbC5yZXF1aXJlZCcsXG4gICd2ZXJpZmljYXRpb24udXBkYXRlZCcsXG4gICdhcnRpZmFjdC5jcmVhdGVkJyxcbiAgJ3J1bi5jb21wbGV0ZWQnLFxuICAncnVuLmZhaWxlZCcsXG5dIGFzIGNvbnN0O1xuXG5leHBvcnQgdHlwZSBFdmVudEtpbmQgPSAodHlwZW9mIEVWRU5UX0tJTkRTKVtudW1iZXJdO1xuXG5leHBvcnQgY29uc3QgRVZFTlRfU0NIRU1BX1ZFUlNJT04gPSAxO1xuZXhwb3J0IHR5cGUgRXZlbnRTY2hlbWFWZXJzaW9uID0gMTtcblxuLyoqIFNTRSBcdTZENDFcdTRFMEFcdTc2ODRcdTZCQ0ZcdTRFMDBcdTY3NjFcdTRFOEJcdTRFRjZcdTMwMDIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgRXZlbnRFbnZlbG9wZTxUID0gdW5rbm93bj4ge1xuICBzY2hlbWFWZXJzaW9uOiBFdmVudFNjaGVtYVZlcnNpb247XG4gIC8qKiBcdTUxNjhcdTVDNDBcdTU1MkZcdTRFMDA7XHU5MUNEXHU4RkRFL1x1ODg2NVx1NjJDOVx1NTQwRVx1OTFDRFx1NTkwRFx1NTFGQVx1NzNCMFx1NjVGNlx1NjNBNVx1NjUzNlx1NjVCOVx1NUU0Mlx1N0I0OVx1NEUyMlx1NUYwM1x1MzAwMiAqL1xuICBldmVudElkOiBzdHJpbmc7XG4gIHNlc3Npb25JZDogc3RyaW5nO1xuICBydW5JZDogc3RyaW5nO1xuICAvKiogXHU0RjFBXHU4QkREXHU1MTg1XHU1MzU1XHU4QzAzXHU5MDEyXHU1ODlFO1x1N0YzQVx1NTNFM1x1NjEwRlx1NTQ3M1x1Nzc0MFx1NEUyMlx1NEU4Qlx1NEVGNixcdTk3MDBcdTg5ODFcdTg4NjVcdTYyQzlcdTMwMDIgKi9cbiAgc2VxOiBudW1iZXI7XG4gIC8qKiBSRkMzMzM5XHUzMDAyICovXG4gIG9jY3VycmVkQXQ6IHN0cmluZztcbiAga2luZDogRXZlbnRLaW5kO1xuICBwYXlsb2FkOiBUO1xufVxuXG4vKiogcnVuLnN0YXJ0ZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgUnVuU3RhcnRlZFBheWxvYWQge1xuICB0YXNrOiBzdHJpbmc7XG4gIG1vZGU6ICdhc2snIHwgJ2F1dG8nIHwgJ3lvbG8nO1xufVxuXG4vKiogcGxhbi51cGRhdGVkIFx1NzY4NCBwYXlsb2FkKFx1OEJBMVx1NTIxMlx1NkI2NVx1OUFBNFx1NTIxN1x1ODg2OCxcdTY3NjVcdTgxRUEgcnVudGltZSBcdTc2ODRcdTdFRDNcdTY3ODRcdTUzMTZcdThCQTFcdTUyMTIsXHU0RTBEXHU2NjJGIGNoYWluLW9mLXRob3VnaHQpXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIFBsYW5VcGRhdGVkUGF5bG9hZCB7XG4gIHN0ZXBzOiBBcnJheTx7IHRpdGxlOiBzdHJpbmc7IHN0YXR1czogJ3BlbmRpbmcnIHwgJ2FjdGl2ZScgfCAnZG9uZScgfCAnZmFpbGVkJyB9Pjtcbn1cblxuLyoqIHRvb2wuc3RhcnRlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBUb29sU3RhcnRlZFBheWxvYWQge1xuICBuYW1lOiBzdHJpbmc7XG4gIC8qKiBcdTUzQzJcdTY1NzBcdTRFRTVcdTY1ODdcdTY3MkNcdTU0NDhcdTczQjAsXHU2RTMyXHU2N0QzXHU3QUVGXHU2QzM4XHU0RTBEIGV2YWw7XHU1OTI3XHU1QkY5XHU4QzYxXHU3NTMxIHJ1bnRpbWUgXHU2MjJBXHU2NUFEXHUzMDAyICovXG4gIGFyZ3NQcmV2aWV3OiBzdHJpbmc7XG59XG5cbi8qKiB0b29sLmNvbXBsZXRlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBUb29sQ29tcGxldGVkUGF5bG9hZCB7XG4gIG5hbWU6IHN0cmluZztcbiAgaXNFcnJvcjogYm9vbGVhbjtcbiAgb3V0cHV0UHJldmlldzogc3RyaW5nO1xufVxuXG4vKiogYXBwcm92YWwucmVxdWlyZWQgXHU3Njg0IHBheWxvYWRcdTMwMDJcdTVCQTFcdTYyNzlcdTY3NDNcdTVBMDFcdTU3MjggcnVudGltZSBcdTU0MEVcdTdBRUY7VUkgXHU1M0VBXHU2NjJGXHU4RjZDXHU4RkYwXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcHJvdmFsUmVxdWlyZWRQYXlsb2FkIHtcbiAgYXBwcm92YWxJZDogc3RyaW5nO1xuICB0b29sOiBzdHJpbmc7XG4gIGFyZ3NQcmV2aWV3OiBzdHJpbmc7XG4gIC8qKiBcdTVGNzFcdTU0Q0RcdTgzMDNcdTU2RjQvXHU5OENFXHU5NjY5XHU3Njg0XHU0RUJBXHU3QzdCXHU1M0VGXHU4QkZCXHU4QkY0XHU2NjBFLFx1NzUzMSBydW50aW1lIFx1NzUxRlx1NjIxMFx1MzAwMiAqL1xuICByaXNrOiBzdHJpbmc7XG59XG5cbi8qKiB2ZXJpZmljYXRpb24udXBkYXRlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBWZXJpZmljYXRpb25VcGRhdGVkUGF5bG9hZCB7XG4gIHN1bW1hcnk6IHN0cmluZztcbiAgcGFzc2VkOiBib29sZWFuIHwgbnVsbDsgLy8gbnVsbCA9IFx1NjcyQVx1NzdFNS9cdThGREJcdTg4NENcdTRFMkQoTkVFRFMtREFUQSBcdTY1RjZcdTRFMERcdTUwNDdcdTU4NkIpXG59XG5cbi8qKiBhcnRpZmFjdC5jcmVhdGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIEFydGlmYWN0Q3JlYXRlZFBheWxvYWQge1xuICBhcnRpZmFjdDogQXJ0aWZhY3RSZWY7XG59XG5cbi8qKiBydW4uY29tcGxldGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIFJ1bkNvbXBsZXRlZFBheWxvYWQge1xuICB0ZXh0OiBzdHJpbmc7XG4gIHR1cm5zOiBudW1iZXI7XG4gIHRvb2xVc2VzOiBudW1iZXI7XG4gIHVzYWdlPzogeyBwcm9tcHRUb2tlbnM6IG51bWJlcjsgY29tcGxldGlvblRva2VuczogbnVtYmVyIH07XG59XG5cbi8qKiBydW4uZmFpbGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIFJ1bkZhaWxlZFBheWxvYWQge1xuICBlcnJvcjogRGVza3RvcEVycm9yO1xufVxuIiwgIi8qKlxuICogQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyBcdTIwMTQgXHU3RUQzXHU2Nzg0XHU1MzE2XHU2ODRDXHU5NzYyXHU5NTE5XHU4QkVGKFx1NUYwMFx1NTNEMVx1OEJBMVx1NTIxMlx1NjU4N1x1Njg2MyAwNCBcdTAwQTdcdTRFMDkpXHUzMDAyXG4gKlxuICogaG9zdC1ub3QtcmVhZHkgLyBhdXRoLWZhaWxlZCAvIHN0YWxlLXZlcnNpb24gLyBydW50aW1lLWNyYXNoZWQgL1xuICogcG9ydC1iaW5kLWZhaWxlZCAvIHNjaGVtYS1taXNtYXRjaCBcdTVGQzVcdTk4N0JcdTY2MkZcdTdFRDNcdTY3ODRcdTUzMTZcdTk1MTlcdThCRUZcdTc4MDEsXHU1RTc2XHU2M0QwXHU0RjlCXHU0RTBCXHU0RTAwXHU2QjY1XHU1MkE4XHU0RjVDXHUzMDAyXG4gKiBtZXNzYWdlIFx1NjYyRlx1N0VBRlx1NjU4N1x1NjcyQyxcdTZFMzJcdTY3RDNcdTdBRUZcdTZDMzhcdTRFMERcdTYyOEFcdTVCODNcdTVGNTMgSFRNTFx1MzAwMlxuICovXG5leHBvcnQgY29uc3QgRVJST1JfQ09ERVMgPSBbXG4gICdIT1NUX05PVF9SRUFEWScsXG4gICdBVVRIX0ZBSUxFRCcsXG4gICdSVU5USU1FX0NSQVNIRUQnLFxuICAnUE9SVF9CSU5EX0ZBSUxFRCcsXG4gICdTVEFMRV9WRVJTSU9OJyxcbiAgJ1NDSEVNQV9NSVNNQVRDSCcsXG5dIGFzIGNvbnN0O1xuXG5leHBvcnQgdHlwZSBFcnJvckNvZGUgPSAodHlwZW9mIEVSUk9SX0NPREVTKVtudW1iZXJdO1xuXG5leHBvcnQgY29uc3QgUkVDT1ZFUllfQUNUSU9OUyA9IFsnUkVDT05ORUNUJywgJ1JFU1VNRScsICdFWFBPUlQnLCAnT1BFTl9MT0dTJ10gYXMgY29uc3Q7XG5leHBvcnQgdHlwZSBSZWNvdmVyeUFjdGlvbiA9ICh0eXBlb2YgUkVDT1ZFUllfQUNUSU9OUylbbnVtYmVyXTtcblxuZXhwb3J0IGludGVyZmFjZSBEZXNrdG9wRXJyb3Ige1xuICBjb2RlOiBFcnJvckNvZGU7XG4gIC8qKiBcdTdFQUZcdTY1ODdcdTY3MkMsXHU2QzM4XHU0RTBEXHU0RkUxXHU0RUZCXHU0RTNBIEhUTUxcdTMwMDIgKi9cbiAgbWVzc2FnZTogc3RyaW5nO1xuICByZXRyeWFibGU6IGJvb2xlYW47XG4gIHNlc3Npb25JZD86IHN0cmluZztcbiAgcnVuSWQ/OiBzdHJpbmc7XG4gIHJlY292ZXJ5QWN0aW9uPzogUmVjb3ZlcnlBY3Rpb247XG59XG5cbi8qKiBcdTY3ODRcdTkwMjBcdTRFMDBcdTRFMkEgRGVza3RvcEVycm9yKGV4YWN0T3B0aW9uYWxQcm9wZXJ0eVR5cGVzIFx1NTNDQlx1NTk3RClcdTMwMDIgKi9cbmV4cG9ydCBmdW5jdGlvbiBkZXNrdG9wRXJyb3IoXG4gIGNvZGU6IEVycm9yQ29kZSxcbiAgbWVzc2FnZTogc3RyaW5nLFxuICBvcHRzOiB7IHJldHJ5YWJsZT86IGJvb2xlYW47IHNlc3Npb25JZD86IHN0cmluZzsgcnVuSWQ/OiBzdHJpbmc7IHJlY292ZXJ5QWN0aW9uPzogUmVjb3ZlcnlBY3Rpb24gfSA9IHt9LFxuKTogRGVza3RvcEVycm9yIHtcbiAgY29uc3QgZTogRGVza3RvcEVycm9yID0geyBjb2RlLCBtZXNzYWdlLCByZXRyeWFibGU6IG9wdHMucmV0cnlhYmxlID09PSB0cnVlIH07XG4gIGlmIChvcHRzLnNlc3Npb25JZCAhPT0gdW5kZWZpbmVkKSBlLnNlc3Npb25JZCA9IG9wdHMuc2Vzc2lvbklkO1xuICBpZiAob3B0cy5ydW5JZCAhPT0gdW5kZWZpbmVkKSBlLnJ1bklkID0gb3B0cy5ydW5JZDtcbiAgaWYgKG9wdHMucmVjb3ZlcnlBY3Rpb24gIT09IHVuZGVmaW5lZCkgZS5yZWNvdmVyeUFjdGlvbiA9IG9wdHMucmVjb3ZlcnlBY3Rpb247XG4gIHJldHVybiBlO1xufVxuIiwgIi8qKlxuICogQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyBcdTIwMTQgcnVudGltZSBcdTY4MjFcdTlBOEMoZ3VhcmRzKVx1MzAwMlxuICpcbiAqIFx1NkJDRlx1NEUyQVx1OERFOFx1NEZFMVx1NEVGQlx1OEZCOVx1NzU0Q1x1NzY4NFx1NjU3MFx1NjM2RShydW50aW1lXHUyMTkycmVuZGVyZXJcdTMwMDFob3N0XHUyMTkybWFpbilcdThGREJcdTUxNjVcdTUyNERcdTUxNDhcdThGQzcgZ3VhcmQ7XG4gKiBcdTY4MjFcdTlBOENcdTU5MzFcdThEMjVcdTc2ODRcdTY1NzBcdTYzNkVcdTYzMDkgU0NIRU1BX01JU01BVENIIFx1N0VEM1x1Njc4NFx1NTMxNlx1OTUxOVx1OEJFRlx1NTkwNFx1NzQwNixcdTRFMERcdTk3NTlcdTlFRDhcdTYzQTVcdTUzRDdcdTMwMDJcbiAqIFx1NjI0Qlx1NTE5OVx1NUI4OFx1NTM2Qlx1ODAwQ1x1NEUwRFx1NjYyRlx1NUYxNVx1N0IyQ1x1NEUwOVx1NjVCOSBzY2hlbWEgXHU1RTkzOlx1NTk1MVx1N0VBNlx1OTc2Mlx1NUMwRixcdTk2RjZcdTRGOURcdThENTZcdTY1ODdcdTUzMTYoaG1oYXJuZXNzIFx1NTQwQ1x1NkU5MClcdTMwMDJcbiAqL1xuaW1wb3J0IHtcbiAgRVZFTlRfS0lORFMsXG4gIEVWRU5UX1NDSEVNQV9WRVJTSU9OLFxuICB0eXBlIEV2ZW50RW52ZWxvcGUsXG4gIHR5cGUgRXZlbnRLaW5kLFxufSBmcm9tICcuL2V2ZW50LnRzJztcbmltcG9ydCB7IEVSUk9SX0NPREVTLCBSRUNPVkVSWV9BQ1RJT05TLCB0eXBlIERlc2t0b3BFcnJvciB9IGZyb20gJy4vZXJyb3IudHMnO1xuaW1wb3J0IHsgUlVOX1NUQVRVU0VTLCB0eXBlIFJ1blN0YXR1cyB9IGZyb20gJy4vZHRvLnRzJztcblxuY29uc3QgaXNSZWNvcmQgPSAodjogdW5rbm93bik6IHYgaXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPT5cbiAgdHlwZW9mIHYgPT09ICdvYmplY3QnICYmIHYgIT09IG51bGwgJiYgIUFycmF5LmlzQXJyYXkodik7XG5cbmNvbnN0IGlzTm9uRW1wdHlTdHJpbmcgPSAodjogdW5rbm93bik6IHYgaXMgc3RyaW5nID0+IHR5cGVvZiB2ID09PSAnc3RyaW5nJyAmJiB2Lmxlbmd0aCA+IDA7XG5cbmNvbnN0IGlzUmZjMzMzOSA9ICh2OiBzdHJpbmcpOiBib29sZWFuID0+IHtcbiAgY29uc3QgdCA9IERhdGUucGFyc2Uodik7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUodCkgJiYgL1xcZHs0fS1cXGR7Mn0tXFxkezJ9VC8udGVzdCh2KTtcbn07XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0V2ZW50RW52ZWxvcGUodjogdW5rbm93bik6IHYgaXMgRXZlbnRFbnZlbG9wZSB7XG4gIGlmICghaXNSZWNvcmQodikpIHJldHVybiBmYWxzZTtcbiAgaWYgKHYuc2NoZW1hVmVyc2lvbiAhPT0gRVZFTlRfU0NIRU1BX1ZFUlNJT04pIHJldHVybiBmYWxzZTtcbiAgaWYgKCFpc05vbkVtcHR5U3RyaW5nKHYuZXZlbnRJZCkpIHJldHVybiBmYWxzZTtcbiAgaWYgKCFpc05vbkVtcHR5U3RyaW5nKHYuc2Vzc2lvbklkKSkgcmV0dXJuIGZhbHNlO1xuICBpZiAoIWlzTm9uRW1wdHlTdHJpbmcodi5ydW5JZCkpIHJldHVybiBmYWxzZTtcbiAgaWYgKHR5cGVvZiB2LnNlcSAhPT0gJ251bWJlcicgfHwgIU51bWJlci5pc0ludGVnZXIodi5zZXEpIHx8IHYuc2VxIDwgMCkgcmV0dXJuIGZhbHNlO1xuICBpZiAoIWlzTm9uRW1wdHlTdHJpbmcodi5vY2N1cnJlZEF0KSB8fCAhaXNSZmMzMzM5KHYub2NjdXJyZWRBdCkpIHJldHVybiBmYWxzZTtcbiAgaWYgKCFFVkVOVF9LSU5EUy5pbmNsdWRlcyh2LmtpbmQgYXMgRXZlbnRLaW5kKSkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gaXNSZWNvcmQodi5wYXlsb2FkKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzRGVza3RvcEVycm9yKHY6IHVua25vd24pOiB2IGlzIERlc2t0b3BFcnJvciB7XG4gIGlmICghaXNSZWNvcmQodikpIHJldHVybiBmYWxzZTtcbiAgaWYgKCFFUlJPUl9DT0RFUy5pbmNsdWRlcyh2LmNvZGUgYXMgbmV2ZXIpKSByZXR1cm4gZmFsc2U7XG4gIGlmICh0eXBlb2Ygdi5tZXNzYWdlICE9PSAnc3RyaW5nJykgcmV0dXJuIGZhbHNlO1xuICBpZiAodHlwZW9mIHYucmV0cnlhYmxlICE9PSAnYm9vbGVhbicpIHJldHVybiBmYWxzZTtcbiAgaWYgKHYuc2Vzc2lvbklkICE9PSB1bmRlZmluZWQgJiYgIWlzTm9uRW1wdHlTdHJpbmcodi5zZXNzaW9uSWQpKSByZXR1cm4gZmFsc2U7XG4gIGlmICh2LnJ1bklkICE9PSB1bmRlZmluZWQgJiYgIWlzTm9uRW1wdHlTdHJpbmcodi5ydW5JZCkpIHJldHVybiBmYWxzZTtcbiAgaWYgKHYucmVjb3ZlcnlBY3Rpb24gIT09IHVuZGVmaW5lZCAmJiAhUkVDT1ZFUllfQUNUSU9OUy5pbmNsdWRlcyh2LnJlY292ZXJ5QWN0aW9uIGFzIG5ldmVyKSkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzUnVuU3RhdHVzKHY6IHVua25vd24pOiB2IGlzIFJ1blN0YXR1cyB7XG4gIHJldHVybiB0eXBlb2YgdiA9PT0gJ3N0cmluZycgJiYgUlVOX1NUQVRVU0VTLmluY2x1ZGVzKHYgYXMgUnVuU3RhdHVzKTtcbn1cblxuLyoqIEhvc3QgXHU1RjE1XHU1QkZDXHU4ODRDKHN0ZG91dCBcdTdCMkNcdTRFMDBcdTg4NEMpXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gaXNIb3N0UmVhZHlMaW5lKHY6IHVua25vd24pOiB2IGlzIHsgaG1oRGVza3RvcEhvc3RSZWFkeTogdHJ1ZTsgcG9ydDogbnVtYmVyOyB2ZXJzaW9uOiBzdHJpbmcgfSB7XG4gIGlmICghaXNSZWNvcmQodikpIHJldHVybiBmYWxzZTtcbiAgaWYgKHYuaG1oRGVza3RvcEhvc3RSZWFkeSAhPT0gdHJ1ZSkgcmV0dXJuIGZhbHNlO1xuICBpZiAodHlwZW9mIHYucG9ydCAhPT0gJ251bWJlcicgfHwgIU51bWJlci5pc0ludGVnZXIodi5wb3J0KSB8fCB2LnBvcnQgPD0gMCB8fCB2LnBvcnQgPiA2NTUzNSkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gaXNOb25FbXB0eVN0cmluZyh2LnZlcnNpb24pO1xufVxuIiwgIi8qKlxuICogRGVza3RvcEhvc3RDbGllbnQgXHUyMDE0IFx1NUJGOSBobWggaG9zdCBcdTc2ODQgSFRUUCtTU0UgXHU1QkEyXHU2MjM3XHU3QUVGXHUzMDAyXG4gKlxuICogLSBcdTZCQ0ZcdTRFMkEgSFRUUCBcdThCRjdcdTZDNDJcdTgxRUFcdTUyQThcdTVFMjYgWC1IbWgtS2V5KHRva2VuIFx1NEUwRFx1OEZEQiBVUkwpO1xuICogLSBcdTdFRDNcdTY3ODRcdTUzMTZcdTk1MTlcdThCRUYocmVzLmJvZHkgXHU5MUNDXHU3Njg0IERlc2t0b3BFcnJvciBcdTVGNjJcdTcyQjZcdTYyMTYgSFRUUCBcdTcyQjZcdTYwMDEpXHU4OUM0XHU3RUE2XHU2MjEwXHU1RjAyXHU1RTM4XHU2MjlCXHU1MUZBO1xuICogLSBTU0UgXHU3NTI4IGZldGNoIFx1NkQ0MVx1NjI0Qlx1NTE5OVx1ODlFM1x1Njc5MChpZC9ldmVudC9kYXRhIFx1NUUyNyksXHU2NTJGXHU2MzAxIExhc3QtRXZlbnQtSUQgXHU4ODY1XHU2MkM5XHU5MUNEXHU4RkRFXHUzMDAyXG4gKi9cbmltcG9ydCB7IGRlc2t0b3BFcnJvciwgaXNEZXNrdG9wRXJyb3IsIGlzRXZlbnRFbnZlbG9wZSwgdHlwZSBEZXNrdG9wRXJyb3IsIHR5cGUgRXZlbnRFbnZlbG9wZSB9IGZyb20gJ0BobWgtZGVza3RvcC9jb250cmFjdHMnO1xuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gJ25vZGU6Y3J5cHRvJztcblxuZXhwb3J0IGludGVyZmFjZSBTc2VGcmFtZSB7XG4gIGlkPzogc3RyaW5nO1xuICBldmVudDogc3RyaW5nO1xuICBkYXRhOiBzdHJpbmc7XG59XG5cbi8qKiBcdTg5RTNcdTY3OTBcdTRFMDBcdTZCQjUgU1NFIFx1NjU4N1x1NjcyQ1x1NEUzQVx1NUUyNyhcdTRFMERcdTU0MkJcdThERTggY2h1bmsgXHU3Njg0XHU3RjEzXHU1MUIyXHU5MDNCXHU4RjkxLFx1N0VBRlx1NTFGRFx1NjU3MFx1NEZCRlx1NEU4RVx1NkQ0Qlx1OEJENSlcdTMwMDIgKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVNzZUNodW5rKGNodW5rOiBzdHJpbmcpOiBTc2VGcmFtZVtdIHtcbiAgY29uc3QgZnJhbWVzOiBTc2VGcmFtZVtdID0gW107XG4gIGZvciAoY29uc3QgYmxvY2sgb2YgY2h1bmsuc3BsaXQoL1xcblxcbi8pKSB7XG4gICAgaWYgKCFibG9jay50cmltKCkpIGNvbnRpbnVlO1xuICAgIGxldCBpZDogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAgIGxldCBldmVudCA9ICdtZXNzYWdlJztcbiAgICBjb25zdCBkYXRhTGluZXM6IHN0cmluZ1tdID0gW107XG4gICAgbGV0IHNhd0ZpZWxkID0gZmFsc2U7XG4gICAgZm9yIChjb25zdCBsaW5lIG9mIGJsb2NrLnNwbGl0KCdcXG4nKSkge1xuICAgICAgaWYgKGxpbmUuc3RhcnRzV2l0aCgnOicpKSBjb250aW51ZTsgLy8gXHU2Q0U4XHU5MUNBL1x1NUZDM1x1OERGM1xuICAgICAgaWYgKGxpbmUuc3RhcnRzV2l0aCgnaWQ6JykpIHsgaWQgPSBsaW5lLnNsaWNlKDMpLnRyaW0oKTsgc2F3RmllbGQgPSB0cnVlOyB9XG4gICAgICBlbHNlIGlmIChsaW5lLnN0YXJ0c1dpdGgoJ2V2ZW50OicpKSB7IGV2ZW50ID0gbGluZS5zbGljZSg2KS50cmltKCk7IHNhd0ZpZWxkID0gdHJ1ZTsgfVxuICAgICAgZWxzZSBpZiAobGluZS5zdGFydHNXaXRoKCdkYXRhOicpKSB7IGRhdGFMaW5lcy5wdXNoKGxpbmUuc2xpY2UoNSkucmVwbGFjZSgvXiAvLCAnJykpOyBzYXdGaWVsZCA9IHRydWU7IH1cbiAgICB9XG4gICAgaWYgKCFzYXdGaWVsZCkgY29udGludWU7IC8vIFx1N0VBRlx1NkNFOFx1OTFDQS9cdTVGQzNcdThERjNcdTU3NTdcdTRFMERcdTRFQTdcdTc1MUZcdTVFMjdcbiAgICBmcmFtZXMucHVzaCh7IC4uLihpZCAhPT0gdW5kZWZpbmVkID8geyBpZCB9IDoge30pLCBldmVudCwgZGF0YTogZGF0YUxpbmVzLmpvaW4oJ1xcbicpIH0pO1xuICB9XG4gIHJldHVybiBmcmFtZXM7XG59XG5cbi8qKiBcdTRFQ0UgU1NFIFx1NUUyN1x1NjU3MFx1NjM2RVx1NEUyRFx1ODlFM1x1NTFGQVx1NTQwOFx1NkNENSBFdmVudEVudmVsb3BlO1x1NEUwRFx1NTQwOFx1NkNENVx1NzY4NFx1OEZENFx1NTZERSBudWxsKFNDSEVNQV9NSVNNQVRDSCBcdTc1MzFcdThDMDNcdTc1MjhcdTY1QjlcdThCQTFcdTY1NzApXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gZW52ZWxvcGVGcm9tRnJhbWUoZnJhbWU6IFNzZUZyYW1lKTogRXZlbnRFbnZlbG9wZSB8IG51bGwge1xuICBpZiAoZnJhbWUuZXZlbnQgIT09ICdobWgnKSByZXR1cm4gbnVsbDsgLy8gXHU2MjExXHU0RUVDXHU3Njg0XHU0RThCXHU0RUY2XHU0RkUxXHU1QzAxXHU3RURGXHU0RTAwXHU4RDcwIGV2ZW50OiBobWhcbiAgdHJ5IHtcbiAgICBjb25zdCBwYXJzZWQ6IHVua25vd24gPSBKU09OLnBhcnNlKGZyYW1lLmRhdGEpO1xuICAgIHJldHVybiBpc0V2ZW50RW52ZWxvcGUocGFyc2VkKSA/IHBhcnNlZCA6IG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbmV4cG9ydCBjbGFzcyBEZXNrdG9wSHR0cEVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICBjb25zdHJ1Y3RvcihwdWJsaWMgcmVhZG9ubHkgZGV0YWlsOiBEZXNrdG9wRXJyb3IpIHtcbiAgICBzdXBlcihkZXRhaWwubWVzc2FnZSk7XG4gIH1cbn1cblxuZXhwb3J0IGNsYXNzIERlc2t0b3BIb3N0Q2xpZW50IHtcbiAgY29uc3RydWN0b3IoXG4gICAgcHJpdmF0ZSByZWFkb25seSBiYXNlVXJsOiBzdHJpbmcsXG4gICAgcHJpdmF0ZSByZWFkb25seSB0b2tlbjogc3RyaW5nLFxuICApIHt9XG5cbiAgcHJpdmF0ZSBoZWFkZXJzKGV4dHJhOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge30pOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IHtcbiAgICByZXR1cm4geyAneC1obWgta2V5JzogdGhpcy50b2tlbiwgLi4uZXh0cmEgfTtcbiAgfVxuXG4gIGFzeW5jIGdldEpzb248VD4ocGF0aDogc3RyaW5nLCB0aW1lb3V0TXMgPSA1XzAwMCk6IFByb21pc2U8VD4ge1xuICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgIHRyeSB7XG4gICAgICByZXMgPSBhd2FpdCBmZXRjaChgJHt0aGlzLmJhc2VVcmx9JHtwYXRofWAsIHsgaGVhZGVyczogdGhpcy5oZWFkZXJzKCksIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCh0aW1lb3V0TXMpIH0pO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGByZXF1ZXN0IGZhaWxlZDogJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxNjApfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy5wYXJzZVJlc3BvbnNlPFQ+KHJlcyk7XG4gIH1cblxuICAvKiogXHU2MkM5XHU1M0Q2XHU3RUFGXHU2NTg3XHU2NzJDXHU3QUVGXHU3MEI5KFx1NTk4MiAvYXBpL3Nlc3Npb25zLzppZC9leHBvcnQubWQpXHUzMDAyICovXG4gIGFzeW5jIGdldFRleHQocGF0aDogc3RyaW5nLCB0aW1lb3V0TXMgPSAxMF8wMDApOiBQcm9taXNlPHN0cmluZz4ge1xuICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgIHRyeSB7XG4gICAgICByZXMgPSBhd2FpdCBmZXRjaChgJHt0aGlzLmJhc2VVcmx9JHtwYXRofWAsIHsgaGVhZGVyczogdGhpcy5oZWFkZXJzKCksIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCh0aW1lb3V0TXMpIH0pO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGByZXF1ZXN0IGZhaWxlZDogJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxNjApfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICBpZiAocmVzLnN0YXR1cyA9PT0gNDAxIHx8IHJlcy5zdGF0dXMgPT09IDQwMykge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdBVVRIX0ZBSUxFRCcsIGBob3N0IHJlamVjdGVkIHRoZSBzZXNzaW9uIHRva2VuIChIVFRQICR7cmVzLnN0YXR1c30pYCwgeyByZXRyeWFibGU6IGZhbHNlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICBpZiAoIXJlcy5vaykge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBIVFRQICR7cmVzLnN0YXR1c31gLCB7IHJldHJ5YWJsZTogcmVzLnN0YXR1cyA+PSA1MDAgfSkpO1xuICAgIH1cbiAgICByZXR1cm4gcmVzLnRleHQoKTtcbiAgfVxuXG4gIC8qKiBcdTZCQ0ZcdTRFMkFcdTVFMjZcdTUyNkZcdTRGNUNcdTc1MjhcdTc2ODQgUE9TVCBcdTgxRUFcdTUyQThcdTY0M0FcdTVFMjZcdTVFNDJcdTdCNDlcdTk1MkUoMDMgXHUwMEE3XHU1NkRCXHU5NjMyXHU5MUNEXHU2NTNFOlx1OEJGN1x1NkM0Mlx1NEY3Rlx1NzUyOCBpZGVtcG90ZW5jeUtleTtcbiAgICogIHJ1bnRpbWUgXHU0RkE3XHU3N0VEXHU2NzFGXHU1MTdDXHU1QkI5XHU1RkZEXHU3NTY1LFx1NTM0Rlx1OEJBRVx1NTE0OFx1ODg0Q1x1MjAxNFx1MjAxNFx1OTFDRFx1OEJENVx1NTNFRlx1NTFFRFx1OTUyRVx1NTNCQlx1OTFDRCxcdTRFMERcdTc2RjJcdTc2RUVcdTkxQ0RcdTY1M0UpXHUzMDAyICovXG4gIGFzeW5jIHBvc3RKc29uPFQ+KHBhdGg6IHN0cmluZywgYm9keTogdW5rbm93biwgdGltZW91dE1zID0gMTBfMDAwKTogUHJvbWlzZTxUPiB7XG4gICAgbGV0IHJlczogUmVzcG9uc2U7XG4gICAgdHJ5IHtcbiAgICAgIHJlcyA9IGF3YWl0IGZldGNoKGAke3RoaXMuYmFzZVVybH0ke3BhdGh9YCwge1xuICAgICAgICBtZXRob2Q6ICdQT1NUJyxcbiAgICAgICAgaGVhZGVyczogdGhpcy5oZWFkZXJzKHtcbiAgICAgICAgICAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgICAgICAgICd4LWlkZW1wb3RlbmN5LWtleSc6IHJhbmRvbVVVSUQoKSxcbiAgICAgICAgfSksXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpLFxuICAgICAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQodGltZW91dE1zKSxcbiAgICAgIH0pO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGByZXF1ZXN0IGZhaWxlZDogJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxNjApfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy5wYXJzZVJlc3BvbnNlPFQ+KHJlcyk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHBhcnNlUmVzcG9uc2U8VD4ocmVzOiBSZXNwb25zZSk6IFByb21pc2U8VD4ge1xuICAgIGlmIChyZXMuc3RhdHVzID09PSA0MDEgfHwgcmVzLnN0YXR1cyA9PT0gNDAzKSB7XG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgYGhvc3QgcmVqZWN0ZWQgdGhlIHNlc3Npb24gdG9rZW4gKEhUVFAgJHtyZXMuc3RhdHVzfSlgLCB7IHJldHJ5YWJsZTogZmFsc2UsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XG4gICAgfVxuICAgIGNvbnN0IHRleHQgPSBhd2FpdCByZXMudGV4dCgpO1xuICAgIGxldCBwYXJzZWQ6IHVua25vd24gPSBudWxsO1xuICAgIHRyeSB7XG4gICAgICBwYXJzZWQgPSB0ZXh0ID8gSlNPTi5wYXJzZSh0ZXh0KSA6IG51bGw7XG4gICAgfSBjYXRjaCB7XG4gICAgICBwYXJzZWQgPSBudWxsO1xuICAgIH1cbiAgICBpZiAoIXJlcy5vaykge1xuICAgICAgaWYgKGlzRGVza3RvcEVycm9yKHBhcnNlZCkpIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKHBhcnNlZCk7XG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYEhUVFAgJHtyZXMuc3RhdHVzfTogJHt0ZXh0LnNsaWNlKDAsIDE2MCl9YCwgeyByZXRyeWFibGU6IHJlcy5zdGF0dXMgPj0gNTAwIH0pKTtcbiAgICB9XG4gICAgcmV0dXJuIHBhcnNlZCBhcyBUO1xuICB9XG5cbiAgLyoqXG4gICAqIFx1OEJBMlx1OTYwNVx1NTE2OFx1OTBFOCBTU0UgXHU1RTI3KFx1NTQyQlx1OTc1RVx1NEZFMVx1NUMwMVx1NEU4Qlx1NEVGNjpkZWx0YS9saW5lIFx1N0I0OVx1OUFEOFx1OTg5MVx1NkQ0MSlcdTMwMDJcdTRGRTFcdTVDMDFcdTc1MzFcdThDMDNcdTc1MjhcdTY1QjlcbiAgICogXHU3NTI4IGVudmVsb3BlRnJvbUZyYW1lIFx1ODFFQVx1ODg0Q1x1NTIwNlx1NkQ0MTtcdTY1QURcdTdFQkZcdTkxQ0RcdThGREVcdThCRURcdTRFNDlcdTU0MEMgZXZlbnRzKClcdTMwMDJcbiAgICovXG4gIGFzeW5jICpyYXdFdmVudHMobGFzdEV2ZW50SWQ/OiBzdHJpbmcsIHNpZ25hbD86IEFib3J0U2lnbmFsKTogQXN5bmNHZW5lcmF0b3I8U3NlRnJhbWU+IHtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgJHt0aGlzLmJhc2VVcmx9L2FwaS9ldmVudHNgLCB7XG4gICAgICBoZWFkZXJzOiB0aGlzLmhlYWRlcnMoe1xuICAgICAgICBhY2NlcHQ6ICd0ZXh0L2V2ZW50LXN0cmVhbScsXG4gICAgICAgIC4uLihsYXN0RXZlbnRJZCAhPT0gdW5kZWZpbmVkID8geyAnbGFzdC1ldmVudC1pZCc6IGxhc3RFdmVudElkIH0gOiB7fSksXG4gICAgICB9KSxcbiAgICAgIC4uLihzaWduYWwgIT09IHVuZGVmaW5lZCA/IHsgc2lnbmFsIH0gOiB7fSksXG4gICAgfSk7XG4gICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSB8fCByZXMuc3RhdHVzID09PSA0MDMpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignQVVUSF9GQUlMRUQnLCBgaG9zdCByZWplY3RlZCB0aGUgc2Vzc2lvbiB0b2tlbiAoSFRUUCAke3Jlcy5zdGF0dXN9KWAsIHsgcmV0cnlhYmxlOiBmYWxzZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcbiAgICB9XG4gICAgaWYgKCFyZXMub2sgfHwgcmVzLmJvZHkgPT09IG51bGwpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgU1NFIEhUVFAgJHtyZXMuc3RhdHVzfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICBjb25zdCByZWFkZXIgPSByZXMuYm9keS5nZXRSZWFkZXIoKTtcbiAgICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKCk7XG4gICAgbGV0IGJ1ZmZlciA9ICcnO1xuICAgIGZvciAoOzspIHtcbiAgICAgIGNvbnN0IHsgZG9uZSwgdmFsdWUgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICBpZiAoZG9uZSkgcmV0dXJuO1xuICAgICAgYnVmZmVyICs9IGRlY29kZXIuZGVjb2RlKHZhbHVlLCB7IHN0cmVhbTogdHJ1ZSB9KTtcbiAgICAgIGxldCBpZHg6IG51bWJlcjtcbiAgICAgIHdoaWxlICgoaWR4ID0gYnVmZmVyLmluZGV4T2YoJ1xcblxcbicpKSAhPT0gLTEpIHtcbiAgICAgICAgY29uc3QgYmxvY2sgPSBidWZmZXIuc2xpY2UoMCwgaWR4KTtcbiAgICAgICAgYnVmZmVyID0gYnVmZmVyLnNsaWNlKGlkeCArIDIpO1xuICAgICAgICBmb3IgKGNvbnN0IGZyYW1lIG9mIHBhcnNlU3NlQ2h1bmsoYmxvY2spKSB5aWVsZCBmcmFtZTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogXHU4QkEyXHU5NjA1IFNTRSBcdTRFOEJcdTRFRjZcdTZENDEoYXN5bmMgaXRlcmF0b3IpXHUzMDAyXHU2NUFEXHU3RUJGXHU3NTMxXHU4QzAzXHU3NTI4XHU2NUI5XHU5MUNEXHU4RkRFO1x1OTFDRFx1OEZERVx1NjVGNlx1NjI4QVx1NjcwMFx1NTQwRVxuICAgKiBcdTY1MzZcdTUyMzBcdTc2ODQgZXZlbnRJZCBcdTRGMjBcdTUxNjUgbGFzdEV2ZW50SWQsaG9zdCBcdTdBRUZcdTRFQ0VcdTkxQ0RcdTY1M0VcdTczQUZcdTg4NjVcdTUzRDFcdTMwMDJcbiAgICovXG4gIGFzeW5jICpldmVudHMobGFzdEV2ZW50SWQ/OiBzdHJpbmcsIHNpZ25hbD86IEFib3J0U2lnbmFsKTogQXN5bmNHZW5lcmF0b3I8RXZlbnRFbnZlbG9wZT4ge1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGAke3RoaXMuYmFzZVVybH0vYXBpL2V2ZW50c2AsIHtcbiAgICAgIGhlYWRlcnM6IHRoaXMuaGVhZGVycyh7XG4gICAgICAgIGFjY2VwdDogJ3RleHQvZXZlbnQtc3RyZWFtJyxcbiAgICAgICAgLi4uKGxhc3RFdmVudElkICE9PSB1bmRlZmluZWQgPyB7ICdsYXN0LWV2ZW50LWlkJzogbGFzdEV2ZW50SWQgfSA6IHt9KSxcbiAgICAgIH0pLFxuICAgICAgLi4uKHNpZ25hbCAhPT0gdW5kZWZpbmVkID8geyBzaWduYWwgfSA6IHt9KSxcbiAgICB9KTtcbiAgICBpZiAocmVzLnN0YXR1cyA9PT0gNDAxIHx8IHJlcy5zdGF0dXMgPT09IDQwMykge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdBVVRIX0ZBSUxFRCcsIGBob3N0IHJlamVjdGVkIHRoZSBzZXNzaW9uIHRva2VuIChIVFRQICR7cmVzLnN0YXR1c30pYCwgeyByZXRyeWFibGU6IGZhbHNlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICBpZiAoIXJlcy5vayB8fCAhcmVzLmJvZHkpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgU1NFIEhUVFAgJHtyZXMuc3RhdHVzfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICBjb25zdCByZWFkZXIgPSByZXMuYm9keS5nZXRSZWFkZXIoKTtcbiAgICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKCk7XG4gICAgbGV0IGJ1ZmZlciA9ICcnO1xuICAgIGZvciAoOzspIHtcbiAgICAgIGNvbnN0IHsgZG9uZSwgdmFsdWUgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICBpZiAoZG9uZSkgcmV0dXJuO1xuICAgICAgYnVmZmVyICs9IGRlY29kZXIuZGVjb2RlKHZhbHVlLCB7IHN0cmVhbTogdHJ1ZSB9KTtcbiAgICAgIC8vIFx1NEVFNVx1N0E3QVx1ODg0Q1x1NTIwNlx1NUUyNztcdTRGRERcdTc1NTlcdTRFMERcdTVCOENcdTY1NzRcdTc2ODRcdTVDM0VcdTkwRThcbiAgICAgIGxldCBpZHg6IG51bWJlcjtcbiAgICAgIHdoaWxlICgoaWR4ID0gYnVmZmVyLmluZGV4T2YoJ1xcblxcbicpKSAhPT0gLTEpIHtcbiAgICAgICAgY29uc3QgYmxvY2sgPSBidWZmZXIuc2xpY2UoMCwgaWR4KTtcbiAgICAgICAgYnVmZmVyID0gYnVmZmVyLnNsaWNlKGlkeCArIDIpO1xuICAgICAgICBmb3IgKGNvbnN0IGZyYW1lIG9mIHBhcnNlU3NlQ2h1bmsoYmxvY2spKSB7XG4gICAgICAgICAgY29uc3QgZW52ID0gZW52ZWxvcGVGcm9tRnJhbWUoZnJhbWUpO1xuICAgICAgICAgIGlmIChlbnYgIT09IG51bGwpIHlpZWxkIGVudjtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxufVxuIiwgIi8qKlxuICogZmFrZSBob3N0IFx1MjAxNCBobWhhcm5lc3MgcnVudGltZSBcdTc2ODRcdTZENEJcdThCRDVcdTY2RkZcdThFQUIoTWFzdGVyUHJvbXB0IFx1OTYzNlx1NkJCNSBEL0U6XG4gKiBcIlx1NTE0OFx1NEY3Rlx1NzUyOCBmYWtlIGhvc3QgXHU3RjE2XHU1MTk5XHU3MkI2XHU2MDAxXHU2NzNBXHU2RDRCXHU4QkQ1LFx1NTE4RFx1NjNBNVx1NzcxRlx1NUI5RSBBUElcIjtcdTk2MzZcdTZCQjUgRSBcdTc2ODRcdTRGMUFcdThCRERcdTdFQjVcdTUyMDdcdTcyNDdcbiAqIGUyZSBcdTRFNUZcdTUxNDhcdTU3MjggZmFrZSBcdTVDNDJcdTk1RURcdTczQUYpXHUzMDAyXG4gKlxuICogXHU2ODRDXHU5NzYyIGhvc3QgXHU1NDA4XHU1NDBDOlxuICogIC0gXHU1M0VBXHU3RUQxIDEyNy4wLjAuMSxcdTdBRUZcdTUzRTMgT1MgXHU1MjA2XHU5MTRELFx1NUI5RVx1OTY0NVx1N0FFRlx1NTNFM1x1NTE5OSBzdGRvdXQgXHU1RjE1XHU1QkZDXHU4ODRDO1xuICogIC0gXHU2MjQwXHU2NzA5IC9hcGkvKiBcdTg5ODFcdTZDNDIgWC1IbWgtS2V5ID09PSBITUhfREVTS1RPUF9UT0tFTixcdTU0MjZcdTUyMTkgNDAxICsgRGVza3RvcEVycm9yO1xuICogIC0gR0VUIC9hcGkvc3RhdGUgXHU1MDY1XHU1RUI3XHU2M0EyXHU2RDRCO0dFVCAvYXBpL2V2ZW50cyBTU0UoZXZlbnQ6IGhtaCBcdTRGRTFcdTVDMDFcdTZENDEgKyBcdTkxQ0RcdTY1M0VcdTczQUYpO1xuICogIC0gUE9TVCAvYXBpL2Rlc2t0b3Avc2h1dGRvd24gXHU0RjE4XHU5NkM1XHU5MDAwXHU1MUZBXHUzMDAyXG4gKlxuICogXHU5NjM2XHU2QkI1IEUgXHU2QTIxXHU2MkRGXHU5NzYyKFx1NEUwRSBobWhhcm5lc3MgZGVza3RvcCBcdTZBMjFcdTVGMEZcdTU0MENcdTVGNjIpOlxuICogIC0gUE9TVCAvYXBpL3Rhc2sge3RleHQsIHNlc3Npb25JZCwgbW9kZX06XHU2MzkyXHU5NjFGXHU1RTc2XHU2MzA5XHU4MTFBXHU2NzJDXHU1M0QxXG4gKiAgICBydW4uc3RhcnRlZCBcdTIxOTIgdG9vbC5zdGFydGVkL2NvbXBsZXRlZCBcdTIxOTIobW9kZT09PSdhc2snIFx1NjVGNilcbiAqICAgIGFwcHJvdmFsLnJlcXVpcmVkKFx1N0I0OSAvYXBpL2FwcHJvdmUpXHUyMTkyIHJ1bi5jb21wbGV0ZWQ7XG4gKiAgLSBQT1NUIC9hcGkvYXBwcm92ZSB7Z3JhbnRlZCwgc2Vzc2lvbklkfTtcbiAqICAtIFBPU1QgL2FwaS9pbnRlcnJ1cHQge3Nlc3Npb25JZH07XG4gKiAgLSBHRVQgL2FwaS9zZXNzaW9uc1x1MzAwMlxuICpcbiAqIFx1NkQ0Qlx1OEJENVx1OTRBOVx1NUI1MDpGQUtFX0hPU1RfRElFX0FGVEVSX01TIC8gRkFLRV9IT1NUX0RJRV9BVF9CT09UIC9cbiAqIEZBS0VfSE9TVF9FWFBFQ1RfVE9LRU4gLyBGQUtFX0hPU1RfVEFTS19ERUxBWV9NUyAvIEZBS0VfSE9TVF9UQVNLX0ZBSUw9MVxuICogKFx1NEVGQlx1NTJBMVx1NEVFNSBydW4uZmFpbGVkIFx1N0VEM1x1Njc1RixcdTY3ODRcdTkwMjBcdTk1MTlcdThCRUZcdTYwNjJcdTU5MERcdTU3M0FcdTY2NkYpXHUzMDAyXG4gKi9cbmltcG9ydCB7IGNyZWF0ZVNlcnZlciwgdHlwZSBTZXJ2ZXJSZXNwb25zZSB9IGZyb20gJ25vZGU6aHR0cCc7XG5pbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSAnbm9kZTpjcnlwdG8nO1xuaW1wb3J0IHsgcGF0aFRvRmlsZVVSTCB9IGZyb20gJ25vZGU6dXJsJztcbmltcG9ydCB7IHJlYWxwYXRoU3luYyB9IGZyb20gJ25vZGU6ZnMnO1xuaW1wb3J0IHsgRVZFTlRfU0NIRU1BX1ZFUlNJT04sIGRlc2t0b3BFcnJvciwgdHlwZSBFdmVudEVudmVsb3BlLCB0eXBlIEV2ZW50S2luZCB9IGZyb20gJ0BobWgtZGVza3RvcC9jb250cmFjdHMnO1xuXG5leHBvcnQgaW50ZXJmYWNlIEZha2VIb3N0SGFuZGxlIHtcbiAgcG9ydDogbnVtYmVyO1xuICBlbWl0KHNlc3Npb25JZDogc3RyaW5nLCBydW5JZDogc3RyaW5nLCBraW5kOiBFdmVudEtpbmQsIHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogbnVtYmVyO1xuICBjbG9zZSgpOiBQcm9taXNlPHZvaWQ+O1xufVxuXG5pbnRlcmZhY2UgRmFrZVNlc3Npb24ge1xuICBpZDogc3RyaW5nO1xuICBjcmVhdGVkQXQ6IHN0cmluZztcbiAgdXBkYXRlZEF0OiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBQZW5kaW5nQXBwcm92YWwge1xuICBzZXNzaW9uSWQ6IHN0cmluZztcbiAgYXBwcm92YWxJZDogc3RyaW5nO1xuICByZXNvbHZlKGdyYW50ZWQ6IGJvb2xlYW4pOiB2b2lkO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc3RhcnRGYWtlSG9zdChvcHRzOiB7IHRva2VuOiBzdHJpbmc7IHF1aWV0PzogYm9vbGVhbiB9KTogUHJvbWlzZTxGYWtlSG9zdEhhbmRsZT4ge1xuICBjb25zdCB0b2tlbiA9IG9wdHMudG9rZW47XG4gIC8vIFx1NkQ0Qlx1OEJENVx1OTRBOVx1NUI1MDpGQUtFX0hPU1RfRVhQRUNUX1RPS0VOIFx1OEJBOSBob3N0IFx1NjgyMVx1OUE4Q1x1NEUwMFx1NEUyQVx1NEUwRSBITUhfREVTS1RPUF9UT0tFTlxuICAvLyBcdTRFMERcdTU0MENcdTc2ODRcdTUwM0MoXHU2Nzg0XHU5MDIwIEFVVEhfRkFJTEVEIFx1NTczQVx1NjY2RjtzdXBlcnZpc29yIFx1NjAzQlx1NjYyRlx1ODk4Nlx1NzZENiBITUhfREVTS1RPUF9UT0tFTilcbiAgY29uc3QgZXhwZWN0ZWQgPSBwcm9jZXNzLmVudi5GQUtFX0hPU1RfRVhQRUNUX1RPS0VOID8/IHRva2VuO1xuICBjb25zdCB0YXNrRGVsYXkgPSBOdW1iZXIocHJvY2Vzcy5lbnYuRkFLRV9IT1NUX1RBU0tfREVMQVlfTVMgPz8gMzApO1xuICBjb25zdCBmYWlsVGFza3MgPSBwcm9jZXNzLmVudi5GQUtFX0hPU1RfVEFTS19GQUlMID09PSAnMSc7XG5cbiAgY29uc3Qgc3NlQ2xpZW50cyA9IG5ldyBTZXQ8U2VydmVyUmVzcG9uc2U+KCk7XG4gIGNvbnN0IHNlcUJ5UnVuID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgLy8gXHU5MUNEXHU2NTNFXHU3M0FGOlx1NjcwMFx1OEZEMSAyMDAgXHU1RTI3KExhc3QtRXZlbnQtSUQgXHU2NUFEXHU3RUJGXHU4ODY1XHU2MkM5KSxcdTRFMEUgaG1oYXJuZXNzIHdlYiBcdTU0MENcdTZCM0VcdThCRURcdTRFNDlcbiAgY29uc3QgcmluZzogQXJyYXk8eyBpZDogbnVtYmVyOyBldmVudDogc3RyaW5nOyBkYXRhOiB1bmtub3duIH0+ID0gW107XG4gIGxldCByaW5nU2VxID0gMDtcbiAgY29uc3Qgc2Vzc2lvbnMgPSBuZXcgTWFwPHN0cmluZywgRmFrZVNlc3Npb24+KCk7XG4gIGxldCBwZW5kaW5nOiBQZW5kaW5nQXBwcm92YWwgfCBudWxsID0gbnVsbDtcbiAgY29uc3QgcnVuVGltZXJzID0gbmV3IE1hcDxzdHJpbmcsIE5vZGVKUy5UaW1lb3V0PigpO1xuICAvLyBcdTVERTVcdTRGNUNcdTUzM0EvUHJvdmlkZXIgXHU3MkI2XHU2MDAxKFx1NEUwRSBobWhhcm5lc3MgXHU1NDBDXHU1RjYyXHU3Njg0XHU2NzAwXHU1QzBGXHU2QTIxXHU2MkRGKVxuICBjb25zdCBmYWtlV29ya3NwYWNlcyA9IHtcbiAgICBjdXJyZW50OiAnd3MtZGVtbycsXG4gICAgaXRlbXM6IFtcbiAgICAgIHsgaWQ6ICd3cy1kZW1vJywgbmFtZTogJ2RlbW8td29ya3NwYWNlJywgcGF0aDogJ0M6XFxcXGRlbW8nIH0sXG4gICAgXSxcbiAgfTtcbiAgY29uc3QgZmFrZVByb3ZpZGVycyA9IG5ldyBNYXA8c3RyaW5nLCB7IGJhc2VVcmw6IHN0cmluZzsgbW9kZWw6IHN0cmluZzsgYXBpS2V5OiBzdHJpbmcgfT4oW1xuICAgIFsnZGVtbycsIHsgYmFzZVVybDogJ2h0dHA6Ly8xMjcuMC4wLjE6OS92MScsIG1vZGVsOiAnZmFrZS1tJywgYXBpS2V5OiAnc2stZGVtby0xMjM0JyB9XSxcbiAgICBbJ2RlbW8tdmlzaW9uJywgeyBiYXNlVXJsOiAnaHR0cDovLzEyNy4wLjAuMTo5L3YxJywgbW9kZWw6ICdmYWtlLW0tdmlzaW9uJywgYXBpS2V5OiAnc2stZGVtby01Njc4JyB9XSxcbiAgXSk7XG4gIGxldCBmYWtlQ2hhdFByb3ZpZGVyID0gJ2RlbW8nO1xuXG4gIGNvbnN0IGVtaXQgPSAoc2Vzc2lvbklkOiBzdHJpbmcsIHJ1bklkOiBzdHJpbmcsIGtpbmQ6IEV2ZW50S2luZCwgcGF5bG9hZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBudW1iZXIgPT4ge1xuICAgIGNvbnN0IGtleSA9IGAke3Nlc3Npb25JZH1cXDAke3J1bklkfWA7XG4gICAgY29uc3Qgc2VxID0gKHNlcUJ5UnVuLmdldChrZXkpID8/IDApICsgMTtcbiAgICBzZXFCeVJ1bi5zZXQoa2V5LCBzZXEpO1xuICAgIGNvbnN0IGVudjogRXZlbnRFbnZlbG9wZSA9IHtcbiAgICAgIHNjaGVtYVZlcnNpb246IEVWRU5UX1NDSEVNQV9WRVJTSU9OLFxuICAgICAgZXZlbnRJZDogcmFuZG9tVVVJRCgpLFxuICAgICAgc2Vzc2lvbklkLFxuICAgICAgcnVuSWQsXG4gICAgICBzZXEsXG4gICAgICBvY2N1cnJlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICBraW5kLFxuICAgICAgcGF5bG9hZCxcbiAgICB9O1xuICAgIGNvbnN0IGlkID0gKytyaW5nU2VxO1xuICAgIHJpbmcucHVzaCh7IGlkLCBldmVudDogJ2htaCcsIGRhdGE6IGVudiB9KTtcbiAgICBpZiAocmluZy5sZW5ndGggPiAyMDApIHJpbmcuc3BsaWNlKDAsIHJpbmcubGVuZ3RoIC0gMjAwKTtcbiAgICBmb3IgKGNvbnN0IGMgb2Ygc3NlQ2xpZW50cykge1xuICAgICAgYy53cml0ZShgaWQ6ICR7aWR9XFxuZXZlbnQ6IGhtaFxcbmRhdGE6ICR7SlNPTi5zdHJpbmdpZnkoZW52KX1cXG5cXG5gKTtcbiAgICB9XG4gICAgcmV0dXJuIHNlcTtcbiAgfTtcblxuICBjb25zdCB0b3VjaCA9IChzZXNzaW9uSWQ6IHN0cmluZyk6IEZha2VTZXNzaW9uID0+IHtcbiAgICBsZXQgcyA9IHNlc3Npb25zLmdldChzZXNzaW9uSWQpO1xuICAgIGlmIChzID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHMgPSB7IGlkOiBzZXNzaW9uSWQsIGNyZWF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLCB1cGRhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSB9O1xuICAgICAgc2Vzc2lvbnMuc2V0KHNlc3Npb25JZCwgcyk7XG4gICAgfVxuICAgIHMudXBkYXRlZEF0ID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuICAgIHJldHVybiBzO1xuICB9O1xuXG4gIC8qKiBcdTZBMjFcdTYyREZcdTRFMDBcdTZCMjFcdTRFRkJcdTUyQTE6XHU2Mjc5XHU1MUM2XHU2QTIxXHU1RjBGXHU2MzAyXHU4RDc3XHU3QjQ5XHU1Rjg1IC9hcGkvYXBwcm92ZVx1MzAwMiAqL1xuICBjb25zdCBydW5UYXNrID0gKHNlc3Npb25JZDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcsIG1vZGU6IHN0cmluZyk6IHN0cmluZyA9PiB7XG4gICAgY29uc3QgcnVuSWQgPSBgcnVuLSR7RGF0ZS5ub3coKS50b1N0cmluZygzNil9LSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMiwgOCl9YDtcbiAgICB0b3VjaChzZXNzaW9uSWQpO1xuICAgIGNvbnN0IHN0ZXBzOiBBcnJheTwoKSA9PiB2b2lkPiA9IFtdO1xuICAgIGNvbnN0IHdhaXQgPSAoZm46ICgpID0+IHZvaWQsIG1zID0gdGFza0RlbGF5KTogdm9pZCA9PiB7XG4gICAgICBjb25zdCB0ID0gc2V0VGltZW91dChmbiwgbXMpO1xuICAgICAgcnVuVGltZXJzLnNldChgJHtzZXNzaW9uSWR9XFwwJHtydW5JZH1gLCB0KTtcbiAgICB9O1xuICAgIGNvbnN0IGNoYWluID0gKGZuczogQXJyYXk8KCkgPT4gdm9pZD4pOiB2b2lkID0+IHtcbiAgICAgIGNvbnN0IFtmaXJzdCwgLi4ucmVzdF0gPSBmbnM7XG4gICAgICBpZiAoZmlyc3QgPT09IHVuZGVmaW5lZCkgcmV0dXJuO1xuICAgICAgd2FpdCgoKSA9PiB7XG4gICAgICAgIGZpcnN0KCk7XG4gICAgICAgIGNoYWluKHJlc3QpO1xuICAgICAgfSk7XG4gICAgfTtcblxuICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ3J1bi5zdGFydGVkJywgeyB0YXNrOiB0ZXh0LCBtb2RlIH0pO1xuICAgIGlmIChmYWlsVGFza3MpIHtcbiAgICAgIHdhaXQoKCkgPT4gZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAncnVuLmZhaWxlZCcsIHtcbiAgICAgICAgZXJyb3I6IHsgY29kZTogJ0FVVEhfRkFJTEVEJywgbWVzc2FnZTogJ3NpbXVsYXRlZCBwcm92aWRlciBhdXRoIGZhaWx1cmUnLCByZXRyeWFibGU6IGZhbHNlIH0sXG4gICAgICB9KSk7XG4gICAgICByZXR1cm4gcnVuSWQ7XG4gICAgfVxuXG4gICAgY29uc3QgZmluaXNoUnVuID0gKGFuc3dlcjogc3RyaW5nLCB0b29sVXNlczogbnVtYmVyKTogdm9pZCA9PiB7XG4gICAgICBydW5UaW1lcnMuZGVsZXRlKGAke3Nlc3Npb25JZH1cXDAke3J1bklkfWApO1xuICAgICAgLy8gXHU0RUE0XHU0RUQ4XHU3MjY5XHU1MTQ4XHU0RThFXHU3RUM4XHU2MDAxKFx1NEUwRSBobWhhcm5lc3MgZGVza3RvcCBcdTY4NjVcdTU0MENcdTVFOEY6YXJ0aWZhY3QuY3JlYXRlZCBcdTIxOTIgcnVuLmNvbXBsZXRlZClcbiAgICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ2FydGlmYWN0LmNyZWF0ZWQnLCB7XG4gICAgICAgIGFydGlmYWN0OiB7IHJlbFBhdGg6ICdvdXQudHh0Jywga2luZDogJ2ZpbGUnLCB0aXRsZTogJ291dC50eHQnIH0sXG4gICAgICB9KTtcbiAgICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ3J1bi5jb21wbGV0ZWQnLCB7IHRleHQ6IGFuc3dlciwgdHVybnM6IDEsIHRvb2xVc2VzIH0pO1xuICAgIH07XG5cbiAgICBjb25zdCBzY3JpcHRlZDogQXJyYXk8KCkgPT4gdm9pZD4gPSBbXG4gICAgICAoKSA9PiBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICd0b29sLnN0YXJ0ZWQnLCB7IG5hbWU6ICdyZWFkX2ZpbGUnLCBhcmdzUHJldmlldzogJ3tcInBhdGhcIjpcIlJFQURNRS5tZFwifScgfSksXG4gICAgICAoKSA9PiBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICd0b29sLmNvbXBsZXRlZCcsIHsgbmFtZTogJ3JlYWRfZmlsZScsIGlzRXJyb3I6IGZhbHNlLCBvdXRwdXRQcmV2aWV3OiAnIyBkZW1vJyB9KSxcbiAgICBdO1xuXG4gICAgaWYgKG1vZGUgPT09ICdhc2snKSB7XG4gICAgICBzY3JpcHRlZC5wdXNoKCgpID0+IHtcbiAgICAgICAgY29uc3QgYXBwcm92YWxJZCA9IGBhcC0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDgpfWA7XG4gICAgICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ2FwcHJvdmFsLnJlcXVpcmVkJywge1xuICAgICAgICAgIGFwcHJvdmFsSWQsXG4gICAgICAgICAgdG9vbDogJ3dyaXRlX2ZpbGUnLFxuICAgICAgICAgIGFyZ3NQcmV2aWV3OiAne1wicGF0aFwiOlwib3V0LnR4dFwiLFwiY29udGVudFwiOlwiaGlcIn0nLFxuICAgICAgICAgIHJpc2s6ICdcdTUxOTlcdTUxNjVcdTVERTVcdTRGNUNcdTUzM0FcdTY1ODdcdTRFRjYgb3V0LnR4dChcdTZBMjFcdTYyREYpJyxcbiAgICAgICAgfSk7XG4gICAgICAgIHBlbmRpbmcgPSB7XG4gICAgICAgICAgc2Vzc2lvbklkLFxuICAgICAgICAgIGFwcHJvdmFsSWQsXG4gICAgICAgICAgcmVzb2x2ZTogKGdyYW50ZWQpID0+IHtcbiAgICAgICAgICAgIHBlbmRpbmcgPSBudWxsO1xuICAgICAgICAgICAgaWYgKGdyYW50ZWQpIHtcbiAgICAgICAgICAgICAgZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAndG9vbC5zdGFydGVkJywgeyBuYW1lOiAnd3JpdGVfZmlsZScsIGFyZ3NQcmV2aWV3OiAne1wicGF0aFwiOlwib3V0LnR4dFwifScgfSk7XG4gICAgICAgICAgICAgIHdhaXQoKCkgPT4gZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAndG9vbC5jb21wbGV0ZWQnLCB7IG5hbWU6ICd3cml0ZV9maWxlJywgaXNFcnJvcjogZmFsc2UsIG91dHB1dFByZXZpZXc6ICd3cm90ZSAyIGJ5dGVzJyB9KSk7XG4gICAgICAgICAgICAgIHdhaXQoKCkgPT4gZmluaXNoUnVuKGBlY2hvOiAke3RleHR9KFx1NURGMlx1NjI2N1x1ODg0Q1x1NTE5OVx1NTE2NSlgLCAzKSwgdGFza0RlbGF5ICogMik7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICBmaW5pc2hSdW4oYGVjaG86ICR7dGV4dH0oXHU1QkExXHU2Mjc5XHU4OEFCXHU2MkQyXHU3RURELFx1NjcyQVx1NjI2N1x1ODg0Q1x1NTE5OVx1NTE2NSlgLCAxKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9LFxuICAgICAgICB9O1xuICAgICAgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHNjcmlwdGVkLnB1c2goKCkgPT4gZmluaXNoUnVuKGBlY2hvOiAke3RleHR9YCwgMSkpO1xuICAgIH1cbiAgICBjaGFpbihzY3JpcHRlZCk7XG4gICAgcmV0dXJuIHJ1bklkO1xuICB9O1xuXG4gIGNvbnN0IHNlcnZlciA9IGNyZWF0ZVNlcnZlcigocmVxLCByZXMpID0+IHtcbiAgICBjb25zdCB1cmwgPSBuZXcgVVJMKHJlcS51cmwgPz8gJy8nLCAnaHR0cDovLzEyNy4wLjAuMScpO1xuICAgIGNvbnN0IGF1dGhvcml6ZWQgPSByZXEuaGVhZGVyc1sneC1obWgta2V5J10gPT09IGV4cGVjdGVkO1xuICAgIGNvbnN0IGRlbnkgPSAoKTogdm9pZCA9PiB7XG4gICAgICByZXMud3JpdGVIZWFkKDQwMSwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgJ21pc3Npbmcgb3IgaW52YWxpZCB4LWhtaC1rZXknLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICB9O1xuXG4gICAgY29uc3QgcmVhZEJvZHkgPSAoKTogUHJvbWlzZTxzdHJpbmc+ID0+XG4gICAgICBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xuICAgICAgICBsZXQgYiA9ICcnO1xuICAgICAgICByZXEub24oJ2RhdGEnLCAoYzogQnVmZmVyKSA9PiB7IGIgKz0gYy50b1N0cmluZygpOyB9KTtcbiAgICAgICAgcmVxLm9uKCdlbmQnLCAoKSA9PiByZXNvbHZlKGIpKTtcbiAgICAgIH0pO1xuXG4gICAgaWYgKHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZXZlbnRzJykge1xuICAgICAgaWYgKCFhdXRob3JpemVkKSB7IGRlbnkoKTsgcmV0dXJuOyB9XG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ3RleHQvZXZlbnQtc3RyZWFtJywgJ2NhY2hlLWNvbnRyb2wnOiAnbm8tY2FjaGUnLCBjb25uZWN0aW9uOiAna2VlcC1hbGl2ZScgfSk7XG4gICAgICByZXMuZmx1c2hIZWFkZXJzPy4oKTtcbiAgICAgIHNzZUNsaWVudHMuYWRkKHJlcyk7XG4gICAgICAvLyBcdTY1QURcdTdFQkZcdTg4NjVcdTYyQzk6TGFzdC1FdmVudC1JRCBcdTRFNEJcdTUyNERcdTc2ODRcdTVFMjdcdTVERjJcdTU3MjhcdTVCQTJcdTYyMzdcdTdBRUYsXHU5MUNEXHU1M0QxXHU1MTc2XHU1NDBFXHU3Njg0XHU3M0FGXHU1RjYyXHU3RjEzXHU1MUIyXG4gICAgICBjb25zdCBsYXN0SWQgPSBOdW1iZXIocmVxLmhlYWRlcnNbJ2xhc3QtZXZlbnQtaWQnXSA/PyAwKTtcbiAgICAgIGlmIChOdW1iZXIuaXNGaW5pdGUobGFzdElkKSAmJiBsYXN0SWQgPiAwKSB7XG4gICAgICAgIGZvciAoY29uc3QgZSBvZiByaW5nKSB7XG4gICAgICAgICAgaWYgKGUuaWQgPiBsYXN0SWQpIHJlcy53cml0ZShgaWQ6ICR7ZS5pZH1cXG5ldmVudDogJHtlLmV2ZW50fVxcbmRhdGE6ICR7SlNPTi5zdHJpbmdpZnkoZS5kYXRhKX1cXG5cXG5gKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmVxLm9uKCdjbG9zZScsICgpID0+IHNzZUNsaWVudHMuZGVsZXRlKHJlcykpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAoIWF1dGhvcml6ZWQpIHsgZGVueSgpOyByZXR1cm47IH1cblxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3N0YXRlJykge1xuICAgICAgLy8gcHJvdmlkZXJzRGV0YWlsOlx1NEUwRSBobWhhcm5lc3MgXHU1NDBDXHU1RjYyXHUyMDE0XHUyMDE0a2V5IFx1NTNFQVx1NTFGQSBoYXNLZXkvXHU2NzJCXHU1NkRCXHU0RjRELFx1NkMzOFx1NEUwRFx1NjYwRVx1NjU4N1xuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBkYWVtb25WZXJzaW9uOiAnZmFrZS0wLjAuMCcsIGRlc2t0b3A6IHRydWUsIG1vZGVsOiBmYWtlUHJvdmlkZXJzLmdldChmYWtlQ2hhdFByb3ZpZGVyKT8ubW9kZWwgPz8gJ2Zha2UtbW9kZWwnLFxuICAgICAgICBjaGF0UHJvdmlkZXI6IGZha2VDaGF0UHJvdmlkZXIsIGxvY2FsZTogJ3poJyxcbiAgICAgICAgYnVzeVNlc3Npb25zOiBbLi4uc2Vzc2lvbnMua2V5cygpXS5zbGljZSgwLCAyKSxcbiAgICAgICAgYXBwcm92YWxQZW5kaW5nOiBwZW5kaW5nICE9PSBudWxsLFxuICAgICAgICBzZXR0aW5nczogeyBhcHByb3ZhbDogJ2FzaycgfSxcbiAgICAgICAgd29ya3NwYWNlOiBmYWtlV29ya3NwYWNlcy5pdGVtcy5maW5kKCh3KSA9PiB3LmlkID09PSBmYWtlV29ya3NwYWNlcy5jdXJyZW50KSA/PyBudWxsLFxuICAgICAgICBwcm92aWRlcnNEZXRhaWw6IFsuLi5mYWtlUHJvdmlkZXJzLmVudHJpZXMoKV0ubWFwKChbbmFtZSwgcF0pID0+ICh7XG4gICAgICAgICAgbmFtZSwgbW9kZWw6IHAubW9kZWwsIGJhc2VVcmw6IHAuYmFzZVVybCxcbiAgICAgICAgICBoYXNLZXk6IHAuYXBpS2V5ICE9PSAnJyxcbiAgICAgICAgICBrZXlUYWlsOiBwLmFwaUtleS5sZW5ndGggPj0gNCA/IHAuYXBpS2V5LnNsaWNlKC00KSA6IHVuZGVmaW5lZCxcbiAgICAgICAgICBwdXJwb3NlczogWydjaGF0J10sXG4gICAgICAgIH0pKSxcbiAgICAgIH0pKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2Rlc2t0b3Avc2h1dGRvd24nKSB7XG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlIH0pKTtcbiAgICAgIHNlcnZlci5jbG9zZSgoKSA9PiBwcm9jZXNzLmV4aXQoMCkpO1xuICAgICAgc2V0VGltZW91dCgoKSA9PiBwcm9jZXNzLmV4aXQoMCksIDFfMDAwKS51bnJlZigpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZmFrZS9kaWUnKSB7XG4gICAgICAvLyBcdTZENEJcdThCRDVcdTk0QTlcdTVCNTA6XHU2QTIxXHU2MkRGIGhvc3QgXHU1RDI5XHU2RTgzKFx1NTE0OFx1NUU5NFx1N0I1NFx1NTE4RFx1OTAwMFx1NTFGQSxcdTRGRERcdThCQzFcdTU0Q0RcdTVFOTRcdTVERjJcdTUzRDFcdTUxRkEpXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlIH0pKTtcbiAgICAgIHNldFRpbWVvdXQoKCkgPT4gcHJvY2Vzcy5leGl0KDEpLCA1MCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9tb2RlbCcpIHtcbiAgICAgIC8vIFx1NkEyMVx1NTc4Qlx1NTIwN1x1NjM2MihcdTRFMEUgaG1oYXJuZXNzIC9hcGkvbW9kZWwgXHU1NDBDXHU1RjYyOlx1NTIwNyBjaGF0IFx1OERFRlx1NzUzMSlcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoKGF3YWl0IHJlYWRCb2R5KCkpIHx8ICd7fScpIGFzIHsgbmFtZT86IHVua25vd24gfTtcbiAgICAgICAgY29uc3QgbmFtZSA9IHR5cGVvZiBib2R5Lm5hbWUgPT09ICdzdHJpbmcnID8gYm9keS5uYW1lLnRyaW0oKSA6ICcnO1xuICAgICAgICBpZiAoIWZha2VQcm92aWRlcnMuaGFzKG5hbWUpKSB7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3Byb3ZpZGVyIG5vdCBmb3VuZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBmYWtlQ2hhdFByb3ZpZGVyID0gbmFtZTtcbiAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlLCBtb2RlbDogZmFrZVByb3ZpZGVycy5nZXQobmFtZSk/Lm1vZGVsIH0pKTtcbiAgICAgIH0pKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS90YXNrJykge1xuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7IHRleHQ/OiB1bmtub3duOyBzZXNzaW9uSWQ/OiB1bmtub3duOyBtb2RlPzogdW5rbm93bjsgYXR0YWNobWVudHM/OiB1bmtub3duOyBpbWFnZXM/OiB1bmtub3duIH07XG4gICAgICAgICAgY29uc3QgdGV4dCA9IHR5cGVvZiBib2R5LnRleHQgPT09ICdzdHJpbmcnID8gYm9keS50ZXh0IDogJyc7XG4gICAgICAgICAgY29uc3Qgc2Vzc2lvbklkID0gdHlwZW9mIGJvZHkuc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IGJvZHkuc2Vzc2lvbklkIDogYHdlYi0ke0RhdGUubm93KCkudG9TdHJpbmcoMzYpfWA7XG4gICAgICAgICAgY29uc3QgbW9kZSA9IGJvZHkubW9kZSA9PT0gJ2FzaycgfHwgYm9keS5tb2RlID09PSAnYXV0bycgfHwgYm9keS5tb2RlID09PSAneW9sbycgPyBib2R5Lm1vZGUgOiAnYXNrJztcbiAgICAgICAgICBjb25zdCBhdHRhY2htZW50cyA9IEFycmF5LmlzQXJyYXkoYm9keS5hdHRhY2htZW50cykgPyBib2R5LmF0dGFjaG1lbnRzLmZpbHRlcigoYSk6IGEgaXMgc3RyaW5nID0+IHR5cGVvZiBhID09PSAnc3RyaW5nJykgOiBbXTtcbiAgICAgICAgICAvLyBcdTU2RkVcdTcyNDdcdTk2NDRcdTRFRjY6XHU0RTBFIGhtaGFybmVzcyB2aXNpb24gXHU1MzRGXHU4QkFFXHU1NDBDXHU1RjYyKHtuYW1lLGRhdGFVcmx9KTtmYWtlIFx1NjgyMVx1OUE4Q1x1NUY2Mlx1NzJCNlx1NTM3M1x1NjUzNlxuICAgICAgICAgIGNvbnN0IGltYWdlcyA9IEFycmF5LmlzQXJyYXkoYm9keS5pbWFnZXMpXG4gICAgICAgICAgICA/IGJvZHkuaW1hZ2VzLmZpbHRlcigoaW0pOiBpbSBpcyB7IG5hbWU6IHN0cmluZzsgZGF0YVVybDogc3RyaW5nIH0gPT4ge1xuICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgaW0gIT09ICdvYmplY3QnIHx8IGltID09PSBudWxsKSByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICAgICAgY29uc3QgbyA9IGltIGFzIHsgbmFtZT86IHVua25vd247IGRhdGFVcmw/OiB1bmtub3duIH07XG4gICAgICAgICAgICAgICAgcmV0dXJuIHR5cGVvZiBvLm5hbWUgPT09ICdzdHJpbmcnICYmIHR5cGVvZiBvLmRhdGFVcmwgPT09ICdzdHJpbmcnICYmIG8uZGF0YVVybC5zdGFydHNXaXRoKCdkYXRhOmltYWdlLycpO1xuICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgOiBbXTtcbiAgICAgICAgICBpZiAoIXRleHQpIHtcbiAgICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3RleHQgcmVxdWlyZWQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8gXHU0RTBFIGhtaGFybmVzcyBcdTU0MENcdThCRURcdTRFNDk6XHU1NDA4XHU2Q0Q1XHU5NjQ0XHU0RUY2XHU0RUU1IFtyZWZlcmVuY2VkIGZpbGVzXSBcdTUyNERcdTdGMDBcdTVFNzZcdTUxNjVcdTRFRkJcdTUyQTFcdTY1ODdcdTY3MkM7XG4gICAgICAgICAgLy8gXHU1NkZFXHU3MjQ3XHU0RUU1IFtpbWFnZXNdIFx1NTI0RFx1N0YwMFx1NjgwN1x1NkNFOFx1NUYyMFx1NjU3MCh2aXNpb24gXHU2M0NGXHU4RkYwXHU5NEZFXHU1NzI4XHU3NzFGXHU1QjlFIHJ1bnRpbWUgXHU5MUNDXHU1M0QxXHU3NTFGKVxuICAgICAgICAgIGNvbnN0IGNvbXBvc2VkID0gYXR0YWNobWVudHMubGVuZ3RoID4gMFxuICAgICAgICAgICAgPyBgW3JlZmVyZW5jZWQgZmlsZXNdXFxuJHthdHRhY2htZW50cy5tYXAoKGEpID0+IGAtICR7YS5zcGxpdCgvW1xcXFwvXS8pLnBvcCgpfWApLmpvaW4oJ1xcbicpfVxcblxcbiR7dGV4dH1gXG4gICAgICAgICAgICA6IHRleHQ7XG4gICAgICAgICAgY29uc3Qgd2l0aEltYWdlcyA9IGltYWdlcy5sZW5ndGggPiAwID8gYFtpbWFnZXM6ICR7aW1hZ2VzLmxlbmd0aH1dXFxuJHtjb21wb3NlZH1gIDogY29tcG9zZWQ7XG4gICAgICAgICAgY29uc3QgcnVuSWQgPSBydW5UYXNrKHNlc3Npb25JZCwgd2l0aEltYWdlcywgbW9kZSk7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIHJ1bklkLCBpbWFnZXM6IGltYWdlcy5sZW5ndGggfSkpO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCBTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgfVxuICAgICAgfSkoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2FwcHJvdmUnKSB7XG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7IGdyYW50ZWQ/OiB1bmtub3duOyBzZXNzaW9uSWQ/OiB1bmtub3duIH07XG4gICAgICAgIGNvbnN0IHNpZCA9IHR5cGVvZiBib2R5LnNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBib2R5LnNlc3Npb25JZCA6ICcnO1xuICAgICAgICBpZiAocGVuZGluZyA9PT0gbnVsbCB8fCAoc2lkICE9PSAnJyAmJiBwZW5kaW5nLnNlc3Npb25JZCAhPT0gc2lkKSkge1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICdubyBhcHByb3ZhbCBwZW5kaW5nJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHAgPSBwZW5kaW5nO1xuICAgICAgICBwZW5kaW5nID0gbnVsbDtcbiAgICAgICAgcC5yZXNvbHZlKGJvZHkuZ3JhbnRlZCA9PT0gdHJ1ZSk7XG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgZ3JhbnRlZDogYm9keS5ncmFudGVkID09PSB0cnVlIH0pKTtcbiAgICAgIH0pKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lLnN0YXJ0c1dpdGgoJy9hcGkvc2Vzc2lvbnMvJykgJiYgKHVybC5wYXRobmFtZS5lbmRzV2l0aCgnL2FyY2hpdmUnKSB8fCB1cmwucGF0aG5hbWUuZW5kc1dpdGgoJy9kZWxldGUnKSkpIHtcbiAgICAgIC8vIFx1NEYxQVx1OEJERFx1NUY1Mlx1Njg2My9cdTUyMjBcdTk2NjQoaG1oYXJuZXNzIFx1NTQwQ1x1NUY2MjpcdTc5RkJcdTUxNjUgYXJjaGl2ZS90cmFzaCxcdTUzRUZcdTYwNjJcdTU5MEQsXHU0RTBEXHU3ODZDXHU1MjIwKVxuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCBwYXJ0cyA9IHVybC5wYXRobmFtZS5zbGljZSgnL2FwaS9zZXNzaW9ucy8nLmxlbmd0aCkuc3BsaXQoJy8nKTtcbiAgICAgICAgY29uc3Qgb3AgPSBwYXJ0c1sxXSA/PyAnJztcbiAgICAgICAgY29uc3Qgb2lkID0gZGVjb2RlVVJJQ29tcG9uZW50KHBhcnRzWzBdID8/ICcnKS5yZXBsYWNlKC9bXmEtekEtWjAtOV86LkAtXS9nLCAnJyk7XG4gICAgICAgIGlmIChvaWQgPT09ICcnIHx8IChvcCAhPT0gJ2FyY2hpdmUnICYmIG9wICE9PSAnZGVsZXRlJykpIHtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnYmFkIG9wJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGlmICghc2Vzc2lvbnMuaGFzKG9pZCkpIHtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnc2Vzc2lvbiBub3QgZm91bmQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgc2Vzc2lvbnMuZGVsZXRlKG9pZCk7XG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSB9KSk7XG4gICAgICB9KSgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvaW5qZWN0Jykge1xuICAgICAgLy8gXHU4RkQwXHU4ODRDXHU0RTJEXHU2Q0U4XHU1MTY1KFx1NEUwRSBobWhhcm5lc3MgL2FwaS9pbmplY3QgXHU1NDBDXHU1RjYyO2Zha2UgXHU1M0VBXHU1NkRFXHU2MjY3KVxuICAgICAgdm9pZCByZWFkQm9keSgpO1xuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9pbnRlcnJ1cHQnKSB7XG4gICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgnJykgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47IC8vIGludGVycnVwdCBcdTY1RTAgYm9keSBcdThCRURcdTRFNDlcbiAgICAgIHZvaWQgYm9keTtcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUgfSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9zZXNzaW9ucycpIHtcbiAgICAgIGNvbnN0IGxpc3QgPSBbLi4uc2Vzc2lvbnMudmFsdWVzKCldLm1hcCgocykgPT4gKHtcbiAgICAgICAgaWQ6IHMuaWQsIHRpdGxlOiAnJywgdGFzazogJycsIG91dGNvbWU6ICdvaycsIHR1cm5zOiAxLCB0b29sVXNlczogMSxcbiAgICAgICAgdGltZTogcy51cGRhdGVkQXQsIGN3ZDogJ0M6XFxcXGRlbW8nLCBicmFuY2g6ICcnLCBjcmVhdGVkQXQ6IHMuY3JlYXRlZEF0LCB1cGRhdGVkQXQ6IHMudXBkYXRlZEF0LFxuICAgICAgfSkpO1xuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBzZXNzaW9uczogbGlzdCwgbmV4dEN1cnNvcjogbnVsbCB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUuc3RhcnRzV2l0aCgnL2FwaS9zZXNzaW9ucy8nKSkge1xuICAgICAgY29uc3Qgc2VnID0gZGVjb2RlVVJJQ29tcG9uZW50KHVybC5wYXRobmFtZS5zbGljZSgnL2FwaS9zZXNzaW9ucy8nLmxlbmd0aCkpO1xuICAgICAgLy8gXHU1QkZDXHU1MUZBKFx1NEUwRSBobWhhcm5lc3MgL2FwaS9zZXNzaW9ucy86aWQvZXhwb3J0Lm1kIFx1NTQwQ1x1NUY2Mjp0ZXh0L21hcmtkb3duIFx1NEUwQlx1OEY3RClcbiAgICAgIGNvbnN0IGV4cG9ydE1hdGNoID0gL14oLiopXFwvZXhwb3J0XFwubWQkLy5leGVjKHNlZykgPz8gL14oLiopXFwuZXhwb3J0XFwubWQkLy5leGVjKHNlZyk7XG4gICAgICBpZiAoZXhwb3J0TWF0Y2ggIT09IG51bGwgJiYgZXhwb3J0TWF0Y2hbMV0gIT09IHVuZGVmaW5lZCAmJiBleHBvcnRNYXRjaFsxXSAhPT0gJycpIHtcbiAgICAgICAgY29uc3QgZWlkID0gZXhwb3J0TWF0Y2hbMV0ucmVwbGFjZSgvW15hLXpBLVowLTlfOi5ALV0vZywgJycpO1xuICAgICAgICBjb25zdCBlcyA9IHNlc3Npb25zLmdldChlaWQpO1xuICAgICAgICBpZiAoZXMgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICdzZXNzaW9uIG5vdCBmb3VuZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ3RleHQvbWFya2Rvd247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICByZXMuZW5kKGAjIGhtaGFybmVzcyBcdTRGMUFcdThCRERcdTVCRkNcdTUxRkEoZmFrZSlcXG5cXG4tIFx1NEYxQVx1OEJERDoke2VpZH1cXG5cXG4jIyBcdTc1MjhcdTYyMzdcXG5cXG5cdTRFNEJcdTUyNERcdTc2ODRcdTRFRkJcdTUyQTEoZmFrZSBcdTk4ODRcdTg5QzgpXFxuXFxuIyMgXHU1MkE5XHU2MjRCXFxuXFxuXHU4RkQ5XHU2NjJGXHU1QkZDXHU1MUZBXHU3Njg0XHU1NkRFXHU1OTBEXHU5ODg0XHU4OUM4KGZha2UpXHUzMDAyXFxuYCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIC8vIFx1NEYxQVx1OEJERFx1OTg4NFx1ODlDOChcdTRFMEUgaG1oYXJuZXNzIEdFVCAvYXBpL3Nlc3Npb25zLzppZCBcdTU0MENcdTVGNjI6XHU2NzAwXHU1NDBFIDgwIFx1Njc2MSxcdTZCQ0ZcdTY3NjEgNTAwIFx1NUI1NylcbiAgICAgIGNvbnN0IGlkID0gc2VnLnJlcGxhY2UoL1teYS16QS1aMC05XzouQC1dL2csICcnKTtcbiAgICAgIGNvbnN0IHMgPSBzZXNzaW9ucy5nZXQoaWQpO1xuICAgICAgaWYgKHMgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3Nlc3Npb24gbm90IGZvdW5kJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgaWQsIG1vZGVsOiAnZmFrZS1tb2RlbCcsIGN3ZDogJ0M6XFxcXGRlbW8nLFxuICAgICAgICBtZXNzYWdlczogW1xuICAgICAgICAgIHsgcm9sZTogJ3VzZXInLCB0ZXh0OiAnXHU0RTRCXHU1MjREXHU3Njg0XHU0RUZCXHU1MkExKGZha2UgXHU5ODg0XHU4OUM4KScsIHRvb2xzOiBbXSB9LFxuICAgICAgICAgIHsgcm9sZTogJ2Fzc2lzdGFudCcsIHRleHQ6ICdcdThGRDlcdTY2MkZcdTUzODZcdTUzRjJcdTRGMUFcdThCRERcdTc2ODRcdTU2REVcdTU5MERcdTk4ODRcdTg5QzgoZmFrZSlcdTMwMDInLCB0b29sczogWydyZWFkX2ZpbGUnXSB9LFxuICAgICAgICBdLFxuICAgICAgfSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9mcycpIHtcbiAgICAgIC8vIFx1NzZFRVx1NUY1NVx1NkQ0Rlx1ODlDOChcdTRFMEUgaG1oYXJuZXNzIFx1NTQwQ1x1NUY2MjpwYXRoIFx1NzcwMVx1NzU2NT1cdTY4Mzk7ZmlsZXM9MSBcdTk2NDRcdTVFMjZcdTY1ODdcdTRFRjZcdTUyMTdcdTg4NjgpXG4gICAgICBjb25zdCBxID0gdXJsLnNlYXJjaFBhcmFtcy5nZXQoJ3BhdGgnKSA/PyAnJztcbiAgICAgIGNvbnN0IHdpdGhGaWxlcyA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KCdmaWxlcycpID09PSAnMSc7XG4gICAgICBpZiAocSA9PT0gJycpIHtcbiAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgcGF0aDogJycsIHNlZ21lbnRzOiBbXSwgcGFyZW50OiAnJyxcbiAgICAgICAgICBkaXJzOiBbeyBuYW1lOiAnZGVtby13b3Jrc3BhY2UnLCBwYXRoOiAnQzpcXFxcZGVtbycgfV0sXG4gICAgICAgICAgLi4uKHdpdGhGaWxlcyA/IHsgZmlsZXM6IFtdIH0gOiB7fSksXG4gICAgICAgIH0pKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBwYXRoOiBxLCBzZWdtZW50czogW3sgbmFtZTogcS5zcGxpdCgvW1xcXFwvXS8pLmZpbHRlcihCb29sZWFuKS5wb3AoKSA/PyBxLCBwYXRoOiBxIH1dLCBwYXJlbnQ6ICcnLFxuICAgICAgICBkaXJzOiBbeyBuYW1lOiAnc3JjJywgcGF0aDogYCR7cS5yZXBsYWNlKC9bXFxcXC9dJC8sICcnKX1cXFxcc3JjYCB9XSxcbiAgICAgICAgLi4uKHdpdGhGaWxlcyA/IHsgZmlsZXM6IFtcbiAgICAgICAgICB7IG5hbWU6ICdSRUFETUUubWQnLCBwYXRoOiBgJHtxLnJlcGxhY2UoL1tcXFxcL10kLywgJycpfVxcXFxSRUFETUUubWRgLCByZWw6ICdSRUFETUUubWQnIH0sXG4gICAgICAgICAgeyBuYW1lOiAncGFja2FnZS5qc29uJywgcGF0aDogYCR7cS5yZXBsYWNlKC9bXFxcXC9dJC8sICcnKX1cXFxccGFja2FnZS5qc29uYCwgcmVsOiAncGFja2FnZS5qc29uJyB9LFxuICAgICAgICBdIH0gOiB7fSksXG4gICAgICB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2ZzL3JlYWQnKSB7XG4gICAgICAvLyBcdTY1ODdcdTRFRjZcdTk4ODRcdTg5QzgoNjRLQiBcdTRFMEFcdTk2NTBcdThCRURcdTRFNDk7ZmFrZSBcdThGRDRcdTU2REVcdTU2RkFcdTVCOUFcdTY1ODdcdTY3MkMpXG4gICAgICBjb25zdCBwID0gdXJsLnNlYXJjaFBhcmFtcy5nZXQoJ3BhdGgnKSA/PyAnJztcbiAgICAgIGlmIChwID09PSAnJykge1xuICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3BhdGggcmVxdWlyZWQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBwYXRoOiBwLCByZWw6IHAuc3BsaXQoL1tcXFxcL10vKS5wb3AoKSA/PyBwLCBzaXplOiA0MixcbiAgICAgICAgdGV4dDogJyMgZGVtbyB3b3Jrc3BhY2VcXG5cXG5cdThGRDlcdTY2MkYgZmFrZSBob3N0IFx1NzY4NFx1NjU4N1x1NEVGNlx1OTg4NFx1ODlDOFx1NTE4NVx1NUJCOVx1MzAwMlxcbicsXG4gICAgICB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2RpZmYnKSB7XG4gICAgICAvLyBEaWZmIFx1OTc2Mlx1Njc3RihcdTRFMEUgaG1oYXJuZXNzIC9hcGkvZGlmZiBcdTU0MENcdTVGNjI7ZmFrZSBcdThGRDRcdTU2REVcdTU2RkFcdTVCOUFcdTVDMEZcdTUzRDhcdTY2RjRcdTk2QzYpXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIGdpdDogdHJ1ZSwgY3dkOiAnQzpcXFxcZGVtbycsXG4gICAgICAgIGNoYW5nZWQ6IFtcbiAgICAgICAgICB7IHN0YXRlOiAnTScsIHBhdGg6ICdzcmMvYXBwLnRzJyB9LFxuICAgICAgICAgIHsgc3RhdGU6ICdBJywgcGF0aDogJ2RvY3Mvbm90ZXMubWQnIH0sXG4gICAgICAgIF0sXG4gICAgICAgIHN0YXQ6ICcgc3JjL2FwcC50cyAgICAgIHwgMTIgKysrKysrKy0tLVxcbiBkb2NzL25vdGVzLm1kICAgfCAgNCArKysrXFxuIDIgZmlsZXMgY2hhbmdlZCwgMTYgaW5zZXJ0aW9ucygrKSwgMyBkZWxldGlvbnMoLSknLFxuICAgICAgfSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS93b3Jrc3BhY2VzJykge1xuICAgICAgLy8gXHU1REU1XHU0RjVDXHU1MzNBKFx1NEUwRSBobWhhcm5lc3MgXHU1NDBDXHU1RjYyOmN1cnJlbnQgKyBpdGVtcylcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgY3VycmVudDogZmFrZVdvcmtzcGFjZXMuY3VycmVudCxcbiAgICAgICAgaXRlbXM6IGZha2VXb3Jrc3BhY2VzLml0ZW1zLFxuICAgICAgfSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvd29ya3NwYWNlcycpIHtcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoKGF3YWl0IHJlYWRCb2R5KCkpIHx8ICd7fScpIGFzIHsgbmFtZT86IHVua25vd247IHBhdGg/OiB1bmtub3duIH07XG4gICAgICAgIGNvbnN0IHBhdGggPSB0eXBlb2YgYm9keS5wYXRoID09PSAnc3RyaW5nJyA/IGJvZHkucGF0aCA6ICcnO1xuICAgICAgICBjb25zdCBuYW1lID0gdHlwZW9mIGJvZHkubmFtZSA9PT0gJ3N0cmluZycgJiYgYm9keS5uYW1lICE9PSAnJyA/IGJvZHkubmFtZSA6IChwYXRoLnNwbGl0KC9bXFxcXC9dLykuZmlsdGVyKEJvb2xlYW4pLnBvcCgpID8/ICcnKTtcbiAgICAgICAgaWYgKHBhdGggPT09ICcnIHx8IG5hbWUgPT09ICcnKSB7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ2Fic29sdXRlIHBhdGggYW5kIG5hbWUgcmVxdWlyZWQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGZha2VXb3Jrc3BhY2VzLml0ZW1zLnNvbWUoKHcpID0+IHcucGF0aC50b0xvd2VyQ2FzZSgpID09PSBwYXRoLnRvTG93ZXJDYXNlKCkpKSB7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDksIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3dvcmtzcGFjZSBhbHJlYWR5IHJlZ2lzdGVyZWQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgaXRlbSA9IHsgaWQ6IGB3cy0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDgpfWAsIG5hbWUsIHBhdGggfTtcbiAgICAgICAgZmFrZVdvcmtzcGFjZXMuaXRlbXMucHVzaChpdGVtKTtcbiAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlLCBjdXJyZW50OiBmYWtlV29ya3NwYWNlcy5jdXJyZW50LCBpdGVtczogZmFrZVdvcmtzcGFjZXMuaXRlbXMgfSkpO1xuICAgICAgfSkoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3dvcmtzcGFjZXMvdXNlJykge1xuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgoYXdhaXQgcmVhZEJvZHkoKSkgfHwgJ3t9JykgYXMgeyBpZD86IHVua25vd24gfTtcbiAgICAgICAgY29uc3QgaGl0ID0gZmFrZVdvcmtzcGFjZXMuaXRlbXMuZmluZCgodykgPT4gdy5pZCA9PT0gYm9keS5pZCk7XG4gICAgICAgIGlmIChoaXQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICd3b3Jrc3BhY2Ugbm90IGZvdW5kJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGZha2VXb3Jrc3BhY2VzLmN1cnJlbnQgPSBoaXQuaWQ7XG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgY3VycmVudDogZmFrZVdvcmtzcGFjZXMuY3VycmVudCwgaXRlbXM6IGZha2VXb3Jrc3BhY2VzLml0ZW1zIH0pKTtcbiAgICAgIH0pKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9wcm92aWRlcnMnKSB7XG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7IG5hbWU/OiB1bmtub3duOyBiYXNlVXJsPzogdW5rbm93bjsgbW9kZWw/OiB1bmtub3duOyBhcGlLZXk/OiB1bmtub3duIH07XG4gICAgICAgIGNvbnN0IG5hbWUgPSB0eXBlb2YgYm9keS5uYW1lID09PSAnc3RyaW5nJyA/IGJvZHkubmFtZS50cmltKCkgOiAnJztcbiAgICAgICAgY29uc3QgYmFzZVVybCA9IHR5cGVvZiBib2R5LmJhc2VVcmwgPT09ICdzdHJpbmcnID8gYm9keS5iYXNlVXJsLnRyaW0oKSA6ICcnO1xuICAgICAgICBjb25zdCBtb2RlbCA9IHR5cGVvZiBib2R5Lm1vZGVsID09PSAnc3RyaW5nJyA/IGJvZHkubW9kZWwudHJpbSgpIDogJyc7XG4gICAgICAgIGlmIChuYW1lID09PSAnJyB8fCBiYXNlVXJsID09PSAnJyB8fCBtb2RlbCA9PT0gJycpIHtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnbmFtZSwgYmFzZVVybCBhbmQgbW9kZWwgYXJlIHJlcXVpcmVkJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGZha2VQcm92aWRlcnMuc2V0KG5hbWUsIHsgYmFzZVVybCwgbW9kZWwsIGFwaUtleTogdHlwZW9mIGJvZHkuYXBpS2V5ID09PSAnc3RyaW5nJyA/IGJvZHkuYXBpS2V5IDogJycgfSk7XG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgbmFtZSB9KSk7XG4gICAgICB9KSgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9mcy9zZWFyY2gnKSB7XG4gICAgICAvLyBcdTVERTVcdTRGNUNcdTUzM0FcdTY1ODdcdTRFRjZcdTY0MUNcdTdEMjIoXHU0RTBFIGhtaGFybmVzcyBcdTU0MENcdTVGNjI6QFx1OTY0NFx1NEVGNlx1OTAwOVx1NjJFOVx1NTY2OFx1NzY4NFx1NjU3MFx1NjM2RVx1NkU5MClcbiAgICAgIGNvbnN0IHEgPSAodXJsLnNlYXJjaFBhcmFtcy5nZXQoJ3EnKSA/PyAnJykudHJpbSgpLnRvTG93ZXJDYXNlKCk7XG4gICAgICBjb25zdCBhbGwgPSBbXG4gICAgICAgIHsgcmVsOiAnUkVBRE1FLm1kJywgcGF0aDogJ0M6XFxcXGRlbW9cXFxcUkVBRE1FLm1kJywga2luZDogJ2ZpbGUnIH0sXG4gICAgICAgIHsgcmVsOiAnc3JjL2FwcC50cycsIHBhdGg6ICdDOlxcXFxkZW1vXFxcXHNyY1xcXFxhcHAudHMnLCBraW5kOiAnZmlsZScgfSxcbiAgICAgICAgeyByZWw6ICdkb2NzL25vdGVzLm1kJywgcGF0aDogJ0M6XFxcXGRlbW9cXFxcZG9jc1xcXFxub3Rlcy5tZCcsIGtpbmQ6ICdmaWxlJyB9LFxuICAgICAgXTtcbiAgICAgIGNvbnN0IGhpdHMgPSBxID09PSAnJyA/IGFsbCA6IGFsbC5maWx0ZXIoKGYpID0+IGYucmVsLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMocSkpO1xuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyByZXN1bHRzOiBoaXRzLnNsaWNlKDAsIDIwKSwgdHJ1bmNhdGVkOiBmYWxzZSwgdG90YWw6IGhpdHMubGVuZ3RoIH0pKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvY29nbml0aXZlJykge1xuICAgICAgLy8gXHU4QkE0XHU3N0U1XHU3MkI2XHU2MDAxKFx1NEUwRSBobWhhcm5lc3MgY29nbml0aXZlU3RhdHVzIFx1NTQwQ1x1NUY2Mlx1NUI1MFx1OTZDNjtcdTdGM0FcdTY1NzBcdTYzNkVcdTY2M0VcdTVGMEYgbnVsbClcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgbWVtb3J5OiB7IGxheWVyczogMywgZW50cmllczogMTIsIGNvbnRyYWRpY3Rpb25zOiAwIH0sXG4gICAgICAgIHRyYWplY3RvcmllczogNyxcbiAgICAgICAgYXVkaXRFdmVudHM6IDIxLFxuICAgICAgICB3b3JsZE1vZGVsOiB7IHZlcnNpb246IDQsIGJlbGllZnM6IDksIHRydXN0ZWQ6IDUsIGJyaWVyOiAwLjMxIH0sXG4gICAgICAgIGNhbGlicmF0aW9uOiB7IHByZWRpY3Rpb25zOiA0NiwgcmVsaWFiaWxpdHk6IDAuNzIgfSxcbiAgICAgIH0pKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2Zha2UvZW1pdCcpIHtcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgoYXdhaXQgcmVhZEJvZHkoKSkgfHwgJ3t9JykgYXMge1xuICAgICAgICAgICAgc2Vzc2lvbklkOiBzdHJpbmc7IHJ1bklkOiBzdHJpbmc7IGtpbmQ6IEV2ZW50S2luZDsgcGF5bG9hZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICAgICAgfTtcbiAgICAgICAgICBjb25zdCBzZXEgPSBlbWl0KGJvZHkuc2Vzc2lvbklkLCBib2R5LnJ1bklkLCBib2R5LmtpbmQsIGJvZHkucGF5bG9hZCk7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIHNlcSB9KSk7XG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsIFN0cmluZyhlcnIpLnNsaWNlKDAsIDEyMCksIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICB9XG4gICAgICB9KSgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCBgbm8gcm91dGUgJHtyZXEubWV0aG9kfSAke3VybC5wYXRobmFtZX1gLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgfSk7XG5cbiAgYXdhaXQgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgIHNlcnZlci5vbmNlKCdlcnJvcicsIHJlamVjdCk7XG4gICAgc2VydmVyLmxpc3RlbigwLCAnMTI3LjAuMC4xJywgKCkgPT4gcmVzb2x2ZSgpKTtcbiAgfSk7XG4gIGNvbnN0IGFkZHJlc3MgPSBzZXJ2ZXIuYWRkcmVzcygpO1xuICBpZiAoYWRkcmVzcyA9PT0gbnVsbCB8fCB0eXBlb2YgYWRkcmVzcyAhPT0gJ29iamVjdCcpIHRocm93IG5ldyBFcnJvcignZmFrZSBob3N0OiBubyBwb3J0Jyk7XG4gIGNvbnN0IHBvcnQgPSBhZGRyZXNzLnBvcnQ7XG5cbiAgaWYgKCFvcHRzLnF1aWV0KSB7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7SlNPTi5zdHJpbmdpZnkoeyBobWhEZXNrdG9wSG9zdFJlYWR5OiB0cnVlLCBwb3J0LCB2ZXJzaW9uOiAnZmFrZS0wLjAuMCcgfSl9XFxuYCk7XG4gIH1cbiAgY29uc3QgZGllQWZ0ZXIgPSBOdW1iZXIocHJvY2Vzcy5lbnYuRkFLRV9IT1NUX0RJRV9BRlRFUl9NUyA/PyAwKTtcbiAgaWYgKE51bWJlci5pc0Zpbml0ZShkaWVBZnRlcikgJiYgZGllQWZ0ZXIgPiAwKSB7XG4gICAgc2V0VGltZW91dCgoKSA9PiBwcm9jZXNzLmV4aXQoMSksIGRpZUFmdGVyKS51bnJlZigpO1xuICB9XG5cbiAgLy8gY2xvc2UoKTogXHU1MTQ4XHU2NUFEXHU1RjAwXHU1MTY4XHU5MEU4IFNTRSBcdThGREVcdTYzQTUoXHU1QjgzXHU0RUVDXHU2QzM4XHU0RTBEXHU4MUVBXHU3MTM2XHU1MTczXHU5NUVEKSxcdTU0MjZcdTUyMTkgc2VydmVyLmNsb3NlXG4gIC8vIFx1NEYxQVx1NEUwMFx1NzZGNFx1N0I0OVx1NkQzQlx1OERDM1x1OEZERVx1NjNBNSxcdTZENEJcdThCRDVcdThGREJcdTdBMEJcdTYzMDJcdTZCN0JcdTMwMDJcbiAgY29uc3QgY2xvc2UgPSAoKTogUHJvbWlzZTx2b2lkPiA9PlxuICAgIG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlKSA9PiB7XG4gICAgICBmb3IgKGNvbnN0IGMgb2Ygc3NlQ2xpZW50cykge1xuICAgICAgICB0cnkgeyBjLmVuZCgpOyBjLmRlc3Ryb3koKTsgfSBjYXRjaCB7IC8qIGFscmVhZHkgZ29uZSAqLyB9XG4gICAgICB9XG4gICAgICBzc2VDbGllbnRzLmNsZWFyKCk7XG4gICAgICBzZXJ2ZXIuY2xvc2UoKCkgPT4gcmVzb2x2ZSgpKTtcbiAgICAgIHNldFRpbWVvdXQoKCkgPT4gcmVzb2x2ZSgpLCAxXzAwMCkudW5yZWYoKTtcbiAgICB9KTtcblxuICByZXR1cm4geyBwb3J0LCBlbWl0LCBjbG9zZSB9O1xufVxuXG4vLyBcdTc2RjRcdTYzQTVcdThGRDBcdTg4NEMoc3VwZXJ2aXNvciBzcGF3biBcdTc2ODRcdTVCNTBcdThGREJcdTdBMEJcdTVGNjJcdTYwMDEpXHUzMDAycmVhbHBhdGggXHU2QkQ0XHU4RjgzOm5wbSB3b3Jrc3BhY2Vcbi8vIGp1bmN0aW9uIC8gXHU1OTI3XHU1QzBGXHU1MTk5XHU1REVFXHU1RjAyXHU5MEZEXHU0RTBEXHU4MEZEXHU4QkE5XHU4RkQ5XHU0RTJBXHU2OEMwXHU2RDRCXHU1OTMxXHU2MjRCKFx1NTkzMVx1NjI0Qj1cdTk3NTlcdTlFRDhcdTkwMDBcdTUxRkEgY29kZSAwLFx1OTZCRVx1NjdFNSlcdTMwMDJcbi8vIGNqcyBidW5kbGUoZXNidWlsZCxcdTYyNTNcdTUzMDVcdTRFQTdcdTU0QzEpXHU0RTBCIF9fZmlsZW5hbWUgXHU1QjU4XHU1NzI4O0VTTSh0c3gvXHU2RTkwXHU3ODAxKVx1NzUyOCBpbXBvcnQubWV0YVx1MzAwMlxuY29uc3Qgc2VsZlVybDogc3RyaW5nID0gdHlwZW9mIF9fZmlsZW5hbWUgPT09ICdzdHJpbmcnXG4gID8gcGF0aFRvRmlsZVVSTChyZWFscGF0aFN5bmMoX19maWxlbmFtZSkpLmhyZWZcbiAgOiBpbXBvcnQubWV0YS51cmw7XG5jb25zdCBpbnZva2VkQXNTY3JpcHQgPSAoKCkgPT4ge1xuICBpZiAocHJvY2Vzcy5hcmd2WzFdID09PSB1bmRlZmluZWQpIHJldHVybiBmYWxzZTtcbiAgdHJ5IHtcbiAgICByZXR1cm4gc2VsZlVybCA9PT0gcGF0aFRvRmlsZVVSTChyZWFscGF0aFN5bmMocHJvY2Vzcy5hcmd2WzFdKSkuaHJlZjtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59KSgpO1xuaWYgKGludm9rZWRBc1NjcmlwdCkge1xuICBjb25zdCB0b2tlbiA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1RPS0VOID8/ICcnO1xuICAvLyBGQUtFX0hPU1RfRElFX0FUX0JPT1Q9MTpcdTVGMTVcdTVCRkNcdTg4NENcdThGOTNcdTUxRkFcdTUyNERcdTUzNzNcdTZCN0IoXHU2Nzg0XHU5MDIwXHU1NDJGXHU1MkE4XHU2NzFGIFJVTlRJTUVfQ1JBU0hFRClcbiAgaWYgKHByb2Nlc3MuZW52LkZBS0VfSE9TVF9ESUVfQVRfQk9PVCA9PT0gJzEnKSB7XG4gICAgcHJvY2Vzcy5leGl0KDEpO1xuICB9XG4gIGNvbnN0IHNsb3cgPSBOdW1iZXIocHJvY2Vzcy5lbnYuRkFLRV9IT1NUX1NMT1dfQUZURVIgPz8gMCk7XG4gIGNvbnN0IGJvb3QgPSAoKTogdm9pZCA9PiB7XG4gICAgdm9pZCBzdGFydEZha2VIb3N0KHsgdG9rZW4gfSkuY2F0Y2goKGVycikgPT4ge1xuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYGZha2UtaG9zdCBmYWlsZWQ6ICR7U3RyaW5nKGVycil9XFxuYCk7XG4gICAgICBwcm9jZXNzLmV4aXQoMSk7XG4gICAgfSk7XG4gIH07XG4gIGlmIChOdW1iZXIuaXNGaW5pdGUoc2xvdykgJiYgc2xvdyA+IDApIHNldFRpbWVvdXQoYm9vdCwgc2xvdyk7XG4gIGVsc2UgYm9vdCgpO1xufVxuIiwgIi8qKlxyXG4gKiBVSVZFUklGWSBcdTk0QTlcdTVCNTAgXHUyMDE0XHUyMDE0IFx1OTAxMFx1NTI5Rlx1ODBGRFx1NzcxRlx1NUI5RSBVSSBcdTlBNzFcdTUyQThcdTlBOENcdTY1MzYoMjAyNi0xMC0xMCBcdTc1MjhcdTYyMzdcdTYzMDdcdTRFRTQ6XHJcbiAqIFwiXHU1QkY5XHU2QkNGXHU0RTAwXHU0RTJBXHU1MjlGXHU4MEZELFx1NkJDRlx1NEUwMFx1NEUyQVx1NEUxQVx1NTJBMVx1NkQ0MVx1N0EwQlx1NTE2OFx1OTc2Mlx1NzY4NFx1OUE4Q1x1NjUzNlwiKVx1MzAwMlxyXG4gKlxyXG4gKiBcdTc2RjRcdTYzQTVcdTVCRjlcdTZFMzJcdTY3RDNcdTU0MEVcdTc2ODQgRE9NIFx1NjVBRFx1OEEwMChcdTVFMDNcdTVDNDBcdTUxRTBcdTRGNTUvXHU1M0VGXHU4OUMxXHU2MDI3KSxcdTVFNzZcdTc1MjhcdTUzOUZcdTc1MUZcdTRFOEJcdTRFRjZcdTlBNzFcdTUyQTggUmVhY3RcclxuICogKFx1NTNEN1x1NjNBN1x1OEY5M1x1NTE2NVx1NzUyOFx1NTM5Rlx1NTc4QiBzZXR0ZXIgKyBpbnB1dCBcdTRFOEJcdTRFRjY7XHU2MzA5XHU5NEFFIGNsaWNrO1x1OTUyRVx1NzZEOFx1OEQ3MCB3aW5kb3dcclxuICoga2V5ZG93bilcdTMwMDJmYWtlIFx1NkEyMVx1NUYwRlx1OEREMVx1NUI4Q1x1NjU3NFx1NEVGQlx1NTJBMVx1OTRGRShcdTUzRDFcdTkwMDFcdTIxOTJcdTVERTVcdTUxNzdcdTIxOTJcdTVCQTFcdTYyNzlcdTIxOTJcdTRFQTRcdTRFRDhcdTcyNjlcdTIxOTJcdTZDNDdcdTYwM0IpO1xyXG4gKiByZWFsIFx1NkEyMVx1NUYwRlx1NTNFQVx1OEREMVx1NTNFQVx1OEJGQlx1NUI1MFx1OTZDNihcdTRFMERcdTUyQThcdTc3MUZcdTVCOUVcdTRGMUFcdThCRERcdTMwMDFcdTRFMERcdTcwRTcgdG9rZW4pXHUzMDAyXHJcbiAqIFx1NkJDRlx1NkI2NVx1OEY5M1x1NTFGQSBgVUlWRVJJRlkgUEFTU3xGQUlMIG5hbWUgfCBkZXRhaWxgLFx1N0VEM1x1NUMzRSBTVU1NQVJZLGV4aXQgY29kZVx1MzAwMlxyXG4gKi9cclxuaW1wb3J0IHsgYXBwLCB0eXBlIEJyb3dzZXJXaW5kb3cgfSBmcm9tICdlbGVjdHJvbic7XHJcbmltcG9ydCB7IG1rZGlyLCB3cml0ZUZpbGUgfSBmcm9tICdub2RlOmZzL3Byb21pc2VzJztcclxuaW1wb3J0IHsgam9pbiB9IGZyb20gJ25vZGU6cGF0aCc7XHJcblxyXG5jb25zdCBzbGVlcCA9IChtczogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiA9PiBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCBtcykpO1xyXG5cclxuYXN5bmMgZnVuY3Rpb24gcnVuVWlWZXJpZnkod2luOiBCcm93c2VyV2luZG93LCBtb2RlOiAnZmFrZScgfCAncmVhbCcpOiBQcm9taXNlPHZvaWQ+IHtcclxuICBjb25zdCBzaG90cyA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX1NIT1RTID8/IGpvaW4oYXBwLmdldFBhdGgoJ3RlbXAnKSwgJ2htaC11aXZlcmlmeScpO1xyXG4gIGF3YWl0IG1rZGlyKHNob3RzLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KS5jYXRjaCgoKSA9PiB1bmRlZmluZWQpO1xyXG4gIGNvbnN0IHJlc3VsdHM6IEFycmF5PFtzdHJpbmcsIGJvb2xlYW4sIHN0cmluZ10+ID0gW107XHJcbiAgbGV0IHNob3RJZHggPSAwO1xyXG5cclxuICBjb25zdCBqcyA9IDxUPihjb2RlOiBzdHJpbmcpOiBQcm9taXNlPFQ+ID0+IHdpbi53ZWJDb250ZW50cy5leGVjdXRlSmF2YVNjcmlwdChjb2RlLCB0cnVlKSBhcyBQcm9taXNlPFQ+O1xyXG4gIGNvbnN0IHN0ZXAgPSBhc3luYyAobmFtZTogc3RyaW5nLCBmbjogKCkgPT4gUHJvbWlzZTxbYm9vbGVhbiwgc3RyaW5nXT4pOiBQcm9taXNlPHZvaWQ+ID0+IHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IFtvaywgZGV0YWlsXSA9IGF3YWl0IGZuKCk7XHJcbiAgICAgIHJlc3VsdHMucHVzaChbbmFtZSwgb2ssIGRldGFpbF0pO1xyXG4gICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgIGNvbnN0IGRldGFpbCA9IGVyciBpbnN0YW5jZW9mIEVycm9yICYmIGVyci5zdGFjayAhPT0gdW5kZWZpbmVkID8gZXJyLnN0YWNrIDogU3RyaW5nKGVycik7XHJcbiAgICAgIHJlc3VsdHMucHVzaChbbmFtZSwgZmFsc2UsIGRldGFpbC5zbGljZSgwLCAzMDApXSk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBsYXN0ID0gcmVzdWx0c1tyZXN1bHRzLmxlbmd0aCAtIDFdITtcclxuICAgIGNvbnNvbGUubG9nKGBVSVZFUklGWSAke2xhc3RbMV0gPyAnUEFTUycgOiAnRkFJTCd9IHwgJHtsYXN0WzBdfSB8ICR7bGFzdFsyXX1gKTtcclxuICB9O1xyXG4gIC8qKiBcdThGNkVcdThCRTJcdTc2RjRcdTUyMzAgcHJlZGljYXRlQ29kZSBcdThGRDRcdTU2REUge29rOnRydWUsLi4ufSBcdTYyMTZcdThEODVcdTY1RjYoXHU4RkQ0XHU1NkRFXHU2NzAwXHU1NDBFXHU3Njg0IGRldGFpbClcdTMwMDIgKi9cclxuICBjb25zdCB3YWl0Rm9yID0gYXN5bmMgKGxhYmVsOiBzdHJpbmcsIHByZWRpY2F0ZUNvZGU6IHN0cmluZywgdGltZW91dE1zOiBudW1iZXIpOiBQcm9taXNlPFtib29sZWFuLCBzdHJpbmddPiA9PiB7XHJcbiAgICBjb25zdCBzdGFydGVkID0gRGF0ZS5ub3coKTtcclxuICAgIGZvciAoOzspIHtcclxuICAgICAgY29uc3QgciA9IChhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHRyeSB7IHJldHVybiBKU09OLnN0cmluZ2lmeSgoZnVuY3Rpb24oKXsgJHtwcmVkaWNhdGVDb2RlfSB9KSgpKTsgfSBjYXRjaChlKXsgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHtvazpmYWxzZSwgZGV0YWlsOlN0cmluZyhlKS5zbGljZSgwLDEyMCl9KTsgfSB9KSgpYCkpIGFzIHN0cmluZztcclxuICAgICAgbGV0IHBhcnNlZDogeyBvaz86IGJvb2xlYW47IGRldGFpbD86IHN0cmluZyB9O1xyXG4gICAgICB0cnkgeyBwYXJzZWQgPSBKU09OLnBhcnNlKHIpIGFzIHsgb2s/OiBib29sZWFuOyBkZXRhaWw/OiBzdHJpbmcgfTsgfSBjYXRjaCB7IHBhcnNlZCA9IHsgb2s6IGZhbHNlLCBkZXRhaWw6IFN0cmluZyhyKS5zbGljZSgwLCAxMjApIH07IH1cclxuICAgICAgaWYgKHBhcnNlZC5vayA9PT0gdHJ1ZSkgcmV0dXJuIFt0cnVlLCBTdHJpbmcocGFyc2VkLmRldGFpbCA/PyAnJyldO1xyXG4gICAgICBpZiAoRGF0ZS5ub3coKSAtIHN0YXJ0ZWQgPiB0aW1lb3V0TXMpIHJldHVybiBbZmFsc2UsIGAke2xhYmVsfTogJHtTdHJpbmcocGFyc2VkLmRldGFpbCA/PyAndGltZW91dCcpfWBdO1xyXG4gICAgICBhd2FpdCBzbGVlcCgyNTApO1xyXG4gICAgfVxyXG4gIH07XHJcbiAgY29uc3Qgc2hvdCA9IGFzeW5jIChsYWJlbDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiA9PiB7XHJcbiAgICBzaG90SWR4ICs9IDE7XHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCBpbWcgPSBhd2FpdCB3aW4ud2ViQ29udGVudHMuY2FwdHVyZVBhZ2UoKTtcclxuICAgICAgYXdhaXQgd3JpdGVGaWxlKGpvaW4oc2hvdHMsIGAke21vZGV9LSR7U3RyaW5nKHNob3RJZHgpLnBhZFN0YXJ0KDIsICcwJyl9LSR7bGFiZWx9LnBuZ2ApLCBpbWcudG9QTkcoKSk7XHJcbiAgICB9IGNhdGNoIHsgLyogXHU2MjJBXHU1NkZFXHU1OTMxXHU4RDI1XHU0RTBEXHU1MjI0XHU2QjdCICovIH1cclxuICB9O1xyXG5cclxuICAvKiAtLS0tIFx1NTNEN1x1NjNBN1x1OEY5M1x1NTE2NShSZWFjdDpcdTUzOUZcdTU3OEIgc2V0dGVyIFx1ODlFNlx1NTNEMSBvbkNoYW5nZSkgLS0tLSAqL1xyXG4gIGNvbnN0IHR5cGVJbnRvID0gKHNlbDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpOiBQcm9taXNlPHVua25vd24+ID0+XHJcbiAgICBqcyhgKGZ1bmN0aW9uKCl7XHJcbiAgICAgIHZhciBlbCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJHtKU09OLnN0cmluZ2lmeShzZWwpfSk7XHJcbiAgICAgIGlmICghZWwpIHJldHVybiAnTk9FTCc7XHJcbiAgICAgIHZhciBwcm90byA9IGVsLnRhZ05hbWUgPT09ICdURVhUQVJFQScgPyBIVE1MVGV4dEFyZWFFbGVtZW50LnByb3RvdHlwZSA6IEhUTUxJbnB1dEVsZW1lbnQucHJvdG90eXBlO1xyXG4gICAgICBPYmplY3QuZ2V0T3duUHJvcGVydHlEZXNjcmlwdG9yKHByb3RvLCAndmFsdWUnKS5zZXQuY2FsbChlbCwgJHtKU09OLnN0cmluZ2lmeSh0ZXh0KX0pO1xyXG4gICAgICBlbC5kaXNwYXRjaEV2ZW50KG5ldyBFdmVudCgnaW5wdXQnLCB7IGJ1YmJsZXM6IHRydWUgfSkpO1xyXG4gICAgICByZXR1cm4gJ09LJztcclxuICAgIH0pKClgKTtcclxuXHJcbiAgLyogLS0tLSBcdTU0MkZcdTUyQThcdTdCNDlcdTVGODU6UmVhY3QgXHU2MzAyXHU4RjdEICsgaG9zdCBcdTdFRkZcdTcwQjkocmVhbCBcdTc2ODQgaG1oYXJuZXNzIFx1NTFCN1x1NTQyRlx1NTJBOFx1ODk4MVx1N0YxNlx1OEJEMVxyXG4gICAgIFx1NjU3NFx1NTk1NyBDTEkgXHU0RjlEXHU4RDU2LFx1NTNFRlx1NTIzMCAzMHMrO1x1NEUwRFx1N0I0OVx1N0VGRlx1NzBCOVx1NUMzMVx1NUYwMFx1OEREMVx1NEYxQVx1NTE2OFx1OTBFOFx1OEQ4NVx1NjVGNlx1OEJFRlx1NjJBNSkgLS0tLSAqL1xyXG4gIGF3YWl0IHdhaXRGb3IoJ2hvc3QgcmVhZHknLCBgdmFyIHQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNvbXBvc2VyIHRleHRhcmVhJyk7IHJldHVybiB7b2s6ICEhdCwgZGV0YWlsOiB0ID8gJ21vdW50ZWQnIDogJ25vIGNvbXBvc2VyJ307YCwgMjBfMDAwKTtcclxuICBhd2FpdCB3YWl0Rm9yKCdob3N0IGRvdCBvbicsIGB2YXIgZD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuaG9zdC1kb3QnKTsgcmV0dXJuIHtvazogISFkICYmIGQuY2xhc3NMaXN0LmNvbnRhaW5zKCdvbicpLCBkZXRhaWw6IGQgPyBkLmNsYXNzTmFtZSA6ICdubyBkb3QnfTtgLCBtb2RlID09PSAncmVhbCcgPyA2MF8wMDAgOiAyMF8wMDApO1xyXG4gIGF3YWl0IHNsZWVwKDFfMjAwKTsgLy8gXHU0RjFBXHU4QkREXHU1MjE3XHU4ODY4L1x1OTg3Nlx1NjgwRlx1NjU3MFx1NjM2RVx1ODQzRFx1NTczMFxyXG5cclxuICAvKiA9PT09PT09PT09IFx1OTAxQVx1NzUyODpcdTVFMDNcdTVDNDBcdTUxRTBcdTRGNTUoXHU3NTI4XHU2MjM3XHU2MkE1XHU5NjlDXHU3Njg0XHU3NkY0XHU2M0E1XHU2NUFEXHU4QTAwKSA9PT09PT09PT09ICovXHJcbiAgYXdhaXQgc3RlcCgnXHU1RTAzXHU1QzQwOlx1NjgwN1x1OTg5OFx1NjgwRitcdTRFMDlcdTY4MEYrY29tcG9zZXIgXHU1NzI4XHU4OUM2XHU1M0UzXHU1MTg1KFx1OEY5M1x1NTE2NVx1Njg0Nlx1NTNFRlx1ODlDMSknLCBhc3luYyAoKSA9PiB7XHJcbiAgICBjb25zdCByID0gKGF3YWl0IGpzKGAoZnVuY3Rpb24oKXtcclxuICAgICAgdmFyIHEgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yLmJpbmQoZG9jdW1lbnQpO1xyXG4gICAgICB2YXIgdGIgPSBxKCcudGl0bGViYXInKSwgc2hlbGwgPSBxKCcuYXBwLXNoZWxsJyksIHNiID0gcSgnLnNpZGViYXInKSwgd3MgPSBxKCcud29ya3NwYWNlJyksIHRhID0gcSgnLmNvbXBvc2VyIHRleHRhcmVhJyk7XHJcbiAgICAgIHZhciBtaXNzaW5nID0gWyF0YiAmJiAndGl0bGViYXInLCAhc2hlbGwgJiYgJ3NoZWxsJywgIXNiICYmICdzaWRlYmFyJywgIXdzICYmICd3b3Jrc3BhY2UnLCAhdGEgJiYgJ3RleHRhcmVhJ10uZmlsdGVyKEJvb2xlYW4pLmpvaW4oJywnKTtcclxuICAgICAgaWYgKG1pc3NpbmcgIT09ICcnKSByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe29rOmZhbHNlLCBkZXRhaWw6J21pc3Npbmc6JyttaXNzaW5nfSk7XHJcbiAgICAgIHZhciByID0gdGEuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCksIHZoID0gd2luZG93LmlubmVySGVpZ2h0LCB2dyA9IHdpbmRvdy5pbm5lcldpZHRoO1xyXG4gICAgICB2YXIgaGludCA9IHEoJy5lbXB0eS1oaW50LmJpZycpOyB2YXIgaHIgPSBoaW50ID8gaGludC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKSA6IG51bGw7XHJcbiAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh7IG9rOiByLmhlaWdodCA+IDMwICYmIHIuYm90dG9tIDw9IHZoICYmIHIud2lkdGggPiAxMDAgJiYgaHIgIT09IG51bGwgJiYgaHIudG9wID49IDAgJiYgaHIuYm90dG9tIDw9IHZoLFxyXG4gICAgICAgIGRldGFpbDogJ3RleHRhcmVhIHk9JytNYXRoLnJvdW5kKHIueSkrJyBoPScrTWF0aC5yb3VuZChyLmhlaWdodCkrJyBib3R0b209JytNYXRoLnJvdW5kKHIuYm90dG9tKSsnIHZoPScrdmgrKGhyID8gJyBoaW50IHk9JytNYXRoLnJvdW5kKGhyLnkpIDogJyBuby1oaW50JykgfSk7XHJcbiAgICB9KSgpYCkpIGFzIHN0cmluZztcclxuICAgIGNvbnN0IHAgPSBKU09OLnBhcnNlKHIpIGFzIHsgb2s6IGJvb2xlYW47IGRldGFpbDogc3RyaW5nIH07XHJcbiAgICByZXR1cm4gW3Aub2sgPT09IHRydWUsIHAuZGV0YWlsXTtcclxuICB9KTtcclxuXHJcbiAgaWYgKG1vZGUgPT09ICdmYWtlJykge1xyXG4gICAgLyogPT09PT09PT09PSBmYWtlKFx1NTQxMVx1NUJGQ1x1Njc4NFx1OTAyMCxITUhfREVTS1RPUF9VSVZFUklGWV9XSVpBUkQ9ZmFrZSk6XHJcbiAgICAgICBcdTRGMkFcdTkwMjBcdTY3MkFcdTkxNERcdTdGNkVcdTYwMDEgXHUyMTkyIFx1NTQxMVx1NUJGQ1x1NTFGQVx1NzNCMCBcdTIxOTIgXHU2OEMwXHU2RDRCKFx1NjcyQVx1ODhDNSlcdTIxOTIgXHU5MDA5XHU2MkU5IFx1MjE5MiBcdTUxODVcdTdGNkUgXHUyMTkyIFx1OEZERVx1NEUwQSA9PT09PT09PT09ICovXHJcbiAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfV0laQVJEID09PSAnZmFrZScpIHtcclxuICAgICAgYXdhaXQgc3RlcCgnXHU1NDExXHU1QkZDOlx1OTk5Nlx1NTQyRlx1NUYzOVx1NTFGQVx1NkIyMlx1OEZDRVx1OTg3NShcdTVGMDBcdTU5Q0JcdTkxNERcdTdGNkUvXHU2RjE0XHU3OTNBXHU1MTY1XHU1M0UzKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignd2l6YXJkIG92ZXJsYXknLCBgdmFyIG89ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1vdmVybGF5Jyk7XHJcbiAgICAgICAgICB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1RjAwXHU1OUNCXHU5MTREXHU3RjZFJzt9KTtcclxuICAgICAgICAgIHJldHVybiB7b2s6ICEhbyAmJiAhIWIsIGRldGFpbDogbyA/ICdvdmVybGF5K1x1NUYwMFx1NTlDQlx1OTE0RFx1N0Y2RScgOiAnbm8gb3ZlcmxheSd9O2AsIDEyXzAwMCk7XHJcbiAgICAgICAgYXdhaXQgc2hvdCgnd2l6YXJkLXdlbGNvbWUnKTtcclxuICAgICAgICByZXR1cm4gdztcclxuICAgICAgfSk7XHJcbiAgICAgIGF3YWl0IHN0ZXAoJ1x1NTQxMVx1NUJGQzpcdTVGMDBcdTU5Q0JcdTkxNERcdTdGNkVcdTIxOTJcdTY4QzBcdTZENEIoXHU0RjJBXHU5MDIwXHU2NzJBXHU4OEM1KVx1MjE5Mlx1NjcyQVx1ODhDNVx1NTM3M1x1ODFFQVx1NTJBOFx1NUI4OVx1ODhDNVx1OTg3NShcdThCRjRcdTY2MEVcdTZBMkFcdTVFNDUrXHU1MjA3XHU2MzYyXHU5NEZFXHU2M0E1KScsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTVGMDBcdTU5Q0JcdTkxNERcdTdGNkUnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignYXV0byBpbnN0YWxsIHBhZ2UnLCBgdmFyIHA9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLWluc3RhbGwnKTtcclxuICAgICAgICAgIGlmKCFwKSByZXR1cm4ge29rOmZhbHNlLCBkZXRhaWw6J25vdCBvbiBpbnN0YWxsJ307XHJcbiAgICAgICAgICB2YXIgdD1wLnRleHRDb250ZW50O1xyXG4gICAgICAgICAgdmFyIG5vdGU9dC5pbmRleE9mKCdcdTY3MkFcdTY4QzBcdTZENEJcdTUyMzAgaG1oIENMSSxcdTVERjJcdTgxRUFcdTUyQThcdTVGMDBcdTU5Q0JcdTVCODlcdTg4QzUnKT49MDtcclxuICAgICAgICAgIHZhciBsMT10LmluZGV4T2YoJ1x1NjUzOVx1NzUyOFx1NTE4NVx1N0Y2RVx1N0NCRVx1N0I4MFx1NTE4NVx1NjgzOCcpPj0wLCBsMj10LmluZGV4T2YoJ1x1NkYxNFx1NzkzQVx1NkEyMVx1NUYwRicpPj0wO1xyXG4gICAgICAgICAgdmFyIGJhcj0hIXAucXVlcnlTZWxlY3RvcignLndpemFyZC1wcm9ncmVzcycpO1xyXG4gICAgICAgICAgdmFyIHNlbD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2Utc2VsZWN0Jyk7XHJcbiAgICAgICAgICByZXR1cm4ge29rOiBub3RlJiZsMSYmbDImJmJhciYmIXNlbCwgZGV0YWlsOiAnbm90ZT0nK25vdGUrJyBcdTUxODVcdTdGNkVcdTk0RkVcdTYzQTU9JytsMSsnIFx1NkYxNFx1NzkzQVx1OTRGRVx1NjNBNT0nK2wyKycgYmFyPScrYmFyKycgc2VsZWN0TGVhaz0nKyEhc2VsfTtgLCAxMl8wMDApO1xyXG4gICAgICAgIGF3YWl0IHNob3QoJ3dpemFyZC1hdXRvLWluc3RhbGwnKTtcclxuICAgICAgICByZXR1cm4gdztcclxuICAgICAgfSk7XHJcbiAgICAgIGF3YWl0IHN0ZXAoJ1x1NTQxMVx1NUJGQzpcdTZBMkFcdTVFNDVcIlx1NjUzOVx1NzUyOFx1NTE4NVx1N0Y2RVx1N0NCRVx1N0I4MFx1NTE4NVx1NjgzOFwiXHUyMTkyXHU5MTREXHU3RjZFXHU4REYzXHU4RkM3XHUyMTkyXHU1QjhDXHU2MjEwXHU5ODc1XHUyMTkyXHU1RjAwXHU1OUNCXHU0RjdGXHU3NTI4XHUyMTkyXHU1MTczXHU5NUVEXHU0RTE0XHU1REYyXHU4RkRFXHU2M0E1JywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLXBhZ2UtaW5zdGFsbCAud2l6YXJkLWFsdC1saW5rJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU2NTM5XHU3NTI4XHU1MTg1XHU3RjZFXHU3Q0JFXHU3QjgwXHU1MTg1XHU2ODM4Jyk+PTA7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgIC8vIFx1OTE0RFx1N0Y2RVx1OTg3NTpmYWtlIHByb3ZpZGVycyBcdTVERjJcdTY3MDlcdTVCQzZcdTk0QTUgXHUyMTkyIFx1ODFFQVx1NTJBOFx1OERGM1x1OEZDNztcdTUxNUNcdTVFOTVcdTcwQjlcIlx1OERGM1x1OEZDN1wiXHJcbiAgICAgICAgYXdhaXQgd2FpdEZvcignY29uZmlnIG9yIGRvbmUnLCBgdmFyIGQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLWRvbmUnKTtcclxuICAgICAgICAgIGlmKGQpIHJldHVybiB7b2s6dHJ1ZSwgZGV0YWlsOidkb25lJ307XHJcbiAgICAgICAgICB2YXIgYz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtY29uZmlnJyk7XHJcbiAgICAgICAgICBpZihjKXsgdmFyIHM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU4REYzXHU4RkM3Jyk+PTA7fSk7IGlmKHMpIHMuY2xpY2soKTsgfVxyXG4gICAgICAgICAgcmV0dXJuIHtvazpmYWxzZSwgZGV0YWlsOid3YWl0aW5nJ307YCwgMTVfMDAwKTtcclxuICAgICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignZG9uZSBwYWdlJywgYHZhciBkPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1kb25lJyk7XHJcbiAgICAgICAgICB2YXIgdD1kP2QudGV4dENvbnRlbnQ6Jyc7XHJcbiAgICAgICAgICByZXR1cm4ge29rOiAhIWQgJiYgdC5pbmRleE9mKCdcdTVDMzFcdTdFRUEnKT49MCAmJiB0LmluZGV4T2YoJ1x1NTE3MVx1NEVBQicpPj0wLCBkZXRhaWw6IHQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDYwKX07YCwgOF8wMDApO1xyXG4gICAgICAgIGF3YWl0IHNob3QoJ3dpemFyZC1kb25lJyk7XHJcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1RjAwXHU1OUNCXHU0RjdGXHU3NTI4Jzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgY29uc3QgY2xvc2VkID0gYXdhaXQgd2FpdEZvcignd2l6YXJkIGNsb3NlZCArIGNvbm5lY3RlZCcsIGByZXR1cm4ge29rOiAhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1vdmVybGF5JykgJiYgISFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuaG9zdC1kb3Qub24nKSxcclxuICAgICAgICAgIGRldGFpbDogJ292ZXJsYXk9JysoZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1vdmVybGF5Jyk/J29wZW4nOidjbG9zZWQnKSsnIGRvdD0nKyhkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuaG9zdC1kb3Qub24nKT8nb24nOidvZmYnKX07YCwgMTBfMDAwKTtcclxuICAgICAgICByZXR1cm4gW3dbMF0gJiYgY2xvc2VkWzBdLCBgZG9uZTogJHt3WzFdfTsgJHtjbG9zZWRbMV19YF07XHJcbiAgICAgIH0pO1xyXG4gICAgfVxyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTk5OTZcdThERDFcdTVGMTVcdTVCRkNcdTVDNDIgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU1RjE1XHU1QkZDXHU1QzQyOlx1NkYxNFx1NzkzQVx1NkEyMVx1NUYwRlx1NjNEMFx1NzkzQVx1NTFGQVx1NzNCMFx1NUU3Nlx1NTNFRlx1NTE3M1x1OTVFRCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2d1aWRlJywgYHZhciBnPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ydW50aW1lLWd1aWRlJyk7IHJldHVybiB7b2s6ICEhZywgZGV0YWlsOiBnID8gJ3Nob3duJyA6ICdub3Qgc2hvd24nfTtgLCA4XzAwMCk7XHJcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXtcclxuICAgICAgICB2YXIgYnRucyA9IFtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnJ1bnRpbWUtZ3VpZGUgYnV0dG9uJykpO1xyXG4gICAgICAgIHZhciBiID0gYnRucy5maW5kKGZ1bmN0aW9uKHgpeyByZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTZGMTRcdTc5M0EnKSA+PSAwOyB9KTtcclxuICAgICAgICBpZiAoYikgYi5jbGljaygpO1xyXG4gICAgICB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdndWlkZSBnb25lJywgYHJldHVybiB7b2s6ICFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcucnVudGltZS1ndWlkZScpLCBkZXRhaWw6IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ydW50aW1lLWd1aWRlJykgPyAnc3RpbGwnIDogJ2Rpc21pc3NlZCd9O2AsIDVfMDAwKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTY1QjBcdTVFRkFcdTRGMUFcdThCREQoQ3RybCtOKSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdDdHJsK04gXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkRELFx1OEY5M1x1NTE2NVx1Njg0Nlx1NTNFRlx1NzUyOCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleTonbicsIGN0cmxLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCd0ZXh0YXJlYSBlbmFibGVkJywgYHZhciB0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jb21wb3NlciB0ZXh0YXJlYScpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhdCAmJiB0LmRpc2FibGVkID09PSBmYWxzZSAmJiAodC5wbGFjZWhvbGRlcnx8JycpLmluZGV4T2YoJ1x1NjNDRlx1OEZGMFx1NzZFRVx1NjgwNycpID49IDAsIGRldGFpbDogdCA/ICgnZGlzYWJsZWQ9Jyt0LmRpc2FibGVkKycgcGg9JysodC5wbGFjZWhvbGRlcnx8JycpLnNsaWNlKDAsMjApKSA6ICdubyB0YSd9O2AsIDVfMDAwKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTUzRDFcdTkwMDFcdTRFRkJcdTUyQTEgXHUyMTkyIFx1NzUyOFx1NjIzN1x1OEY2RVx1NTFGQVx1NzNCMChcdTRFMTRcdTRFQzVcdTRFMDBcdTY3NjEsXHU1M0NDXHU2RDg4XHU2MDZGXHU1NkRFXHU1RjUyKSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdThGOTNcdTUxNjVcdTVFNzZcdTUzRDFcdTkwMDFcdTRFRkJcdTUyQTEsXHU3NTI4XHU2MjM3XHU2RDg4XHU2MDZGXHU0RTBBXHU1QzRGXHU0RTE0XHU0RTBEXHU5MUNEXHU1OTBEJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCB0eXBlSW50bygnLmNvbXBvc2VyIHRleHRhcmVhJywgJ1x1OUE4Q1x1NjUzNlx1NEVGQlx1NTJBMTpcdTUxOTlcdTUxNjVcdTRFMDBcdTRFMkFcdTY1ODdcdTRFRjYnKTtcclxuICAgICAgYXdhaXQgc2xlZXAoMjAwKTtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpe1xyXG4gICAgICAgIHZhciBidG5zID0gW10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY29tcG9zZXIgYnV0dG9uJykpO1xyXG4gICAgICAgIHZhciBiID0gYnRucy5maW5kKGZ1bmN0aW9uKHgpeyByZXR1cm4geC50ZXh0Q29udGVudC50cmltKCkgPT09ICdcdTUzRDFcdTkwMDEnOyB9KTtcclxuICAgICAgICBpZiAoYikgYi5jbGljaygpO1xyXG4gICAgICB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdleGFjdGx5IG9uZSB1c2VyIHR1cm4nLCBgdmFyIHRzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnR1cm4udXNlcicpKS5maWx0ZXIoZnVuY3Rpb24oeCl7IHJldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1OUE4Q1x1NjUzNlx1NEVGQlx1NTJBMScpID49IDA7IH0pO1xyXG4gICAgICAgIHJldHVybiB7b2s6IHRzLmxlbmd0aCA9PT0gMSwgZGV0YWlsOiAnY291bnQ9Jyt0cy5sZW5ndGgrJyB0ZXh0PScrKHRzWzBdP3RzWzBdLnRleHRDb250ZW50LnNsaWNlKDAsMzApOidub25lJyl9O2AsIDhfMDAwKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTVERTVcdTUxNzdcdTUzNjEocmVhZF9maWxlIFx1NUI4Q1x1NjIxMCkgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU1REU1XHU1MTc3XHU2Mjk4XHU1M0UwXHU1MzYxOnJlYWRfZmlsZSBcdTYyNjdcdTg4NENcdTVFNzZcdTVCOENcdTYyMTAnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCd0b29sIGNhcmQnLCBgdmFyIGM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudG9vbC1jYXJkJykpO1xyXG4gICAgICAgIHZhciBkb25lID0gYy5maWx0ZXIoZnVuY3Rpb24oeCl7IHJldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ3JlYWRfZmlsZScpID49IDAgJiYgeC50ZXh0Q29udGVudC5pbmRleE9mKCcjIGRlbW8nKSA+PSAwOyB9KTtcclxuICAgICAgICByZXR1cm4ge29rOiBkb25lLmxlbmd0aCA+PSAxLCBkZXRhaWw6ICdjYXJkcz0nK2MubGVuZ3RoKycgZG9uZT0nK2RvbmUubGVuZ3RofTtgLCA4XzAwMCk7XHJcbiAgICAgIHJldHVybiB3O1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NUJBMVx1NjI3OVx1N0VCNVx1NTIwN1x1NzI0NyhcdTc1MjhcdTYyMzdcdTYyQTVcdTk2OUNcdTY4MzhcdTVGQzNcdTRFNEJcdTRFMDApID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1NUJBMVx1NjI3OTphcHByb3ZhbCBcdTUzNjFcdTUxRkFcdTczQjAoXHU3QjQ5XHU1Rjg1XHU0RUJBXHU1REU1XHU2Mjc5XHU1MUM2KScsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQgc2hvdCgnYXBwcm92YWwtcGVuZGluZycpO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignYXBwcm92YWwgY2FyZCcsIGB2YXIgYT1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuYXBwcm92YWwtY2FyZCcpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYSAmJiBhLnRleHRDb250ZW50LmluZGV4T2YoJ1x1OTcwMFx1ODk4MVx1NUJBMVx1NjI3OScpID49IDAsIGRldGFpbDogYSA/IGEudGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLCA2MCkgOiAnbm8gYXBwcm92YWwgY2FyZCd9O2AsIDhfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnXHU1QkExXHU2Mjc5Olx1NzBCOVx1NjI3OVx1NTFDNiBcdTIxOTIgXHU0RUZCXHU1MkExXHU3RUU3XHU3RUVEXHU1MjMwXHU0RUE0XHU0RUQ4XHU3MjY5K1x1NkM0N1x1NjAzQicsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpe1xyXG4gICAgICAgIHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmFwcHJvdmFsLWNhcmQgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7IHJldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTYyNzlcdTUxQzYnOyB9KTtcclxuICAgICAgICBpZiAoYikgYi5jbGljaygpO1xyXG4gICAgICB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdhcnRpZmFjdCtzdW0nLCBgdmFyIGFydD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuYXJ0aWZhY3QtY2FyZCcpO1xyXG4gICAgICAgIHZhciBzdW09ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnR1cm4tc3VtJyk7XHJcbiAgICAgICAgdmFyIGFzdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50dXJuJykpLmZpbHRlcihmdW5jdGlvbih4KXsgcmV0dXJuIHguY2xhc3NOYW1lLmluZGV4T2YoJ3VzZXInKTwwICYmIHgudGV4dENvbnRlbnQuaW5kZXhPZignZWNobzonKT49MDsgfSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFhcnQgJiYgISFzdW0gJiYgYXN0Lmxlbmd0aD49MSwgZGV0YWlsOiAnYXJ0aWZhY3Q9JysoYXJ0P2FydC50ZXh0Q29udGVudC5zbGljZSgwLDMwKTonbm9uZScpKycgc3VtPScrKHN1bT9zdW0udGV4dENvbnRlbnQ6J25vbmUnKSsnIGFuc3dlcmVkPScrYXN0Lmxlbmd0aH07YCwgMTJfMDAwKTtcclxuICAgICAgYXdhaXQgc2hvdCgncnVuLWNvbXBsZXRlZCcpO1xyXG4gICAgICByZXR1cm4gdztcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTUzODZcdTUzRjJcdTRGMUFcdThCRERcdTUxODVcdTVCQjkoXHU3NTI4XHU2MjM3XHU2MkE1XHU5NjlDXCJcdTc3MEJcdTRFMERcdTUyMzBcdTUxODVcdTVCQjlcIikgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU3MEI5XHU1MUZCXHU1Mzg2XHU1M0YyXHU0RjFBXHU4QkREIFx1MjE5MiB0cmFuc2NyaXB0IFx1NTE4NVx1NUJCOVx1NTNFRlx1ODlDMScsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgaXQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNlc3Npb24taXRlbScpOyBpZiAoaXQpIGl0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2hpc3RvcnkgdHVybnMnLCBgdmFyIHRzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnR1cm4nKSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogdHMubGVuZ3RoID49IDIsIGRldGFpbDogJ3R1cm5zPScrdHMubGVuZ3RoKycgZmlyc3Q9JysodHNbMF0/dHNbMF0udGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDQwKTonbm9uZScpfTtgLCA4XzAwMCk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU0RTk0XHU5ODc1XHU3QjdFID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ0RvY2s6T3ZlcnZpZXcgXHU2NTcwXHU2MzZFXHU4ODRDJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nT3ZlcnZpZXcnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ292ZXJ2aWV3IHJvd3MnLCBgdmFyIHJvd3M9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay1yb3cnKSk7XHJcbiAgICAgICAgdmFyIHZlciA9IHJvd3MuZmluZChmdW5jdGlvbihyKXsgcmV0dXJuIHIudGV4dENvbnRlbnQuaW5kZXhPZigncnVudGltZSBcdTcyNDhcdTY3MkMnKT49MDsgfSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogcm93cy5sZW5ndGggPj0gNSAmJiAhIXZlciwgZGV0YWlsOiAncm93cz0nK3Jvd3MubGVuZ3RoKyh2ZXI/JyB2ZXI9Jyt2ZXIudGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDQwKTonJyl9O2AsIDZfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnRG9jazpGaWxlcyBcdTZENEZcdTg5QzgrXHU2NTg3XHU0RUY2XHU5ODg0XHU4OUM4JywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nXHU2NTg3XHU0RUY2J3x8eC50ZXh0Q29udGVudD09PSdGaWxlcyc7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignZnMgcm93cycsIGB2YXIgcm93cz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZnMtcm93JykubGVuZ3RoO1xyXG4gICAgICAgIHJldHVybiB7b2s6IHJvd3MgPj0gMSwgZGV0YWlsOiAncm93cz0nK3Jvd3N9O2AsIDZfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgLy8gXHU2ODM5XHU3NkVFXHU1RjU1XHU1M0VBXHU2NzA5XHU1REU1XHU0RjVDXHU1MzNBXHU3NkVFXHU1RjU1KGZha2UgXHU0RTBFXHU3NzFGXHU1QjlFIHJ1bnRpbWUgXHU1NDBDXHU1RjYyKTpcdTUxNDhcdThGREJcdTc2RUVcdTVGNTUsXHU1MThEXHU3MEI5XHU2NTg3XHU0RUY2XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZnMtcm93JykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignZGVtby13b3Jrc3BhY2UnKT49MCB8fCB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1RDgzRFx1RENDMScpPj0wO30pOyBpZihkKSBkLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgdzIgPSBhd2FpdCB3YWl0Rm9yKCdmaWxlIHJvd3MnLCBgdmFyIHJvd3M9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZnMtcm93JykpO1xyXG4gICAgICAgIHJldHVybiB7b2s6IHJvd3Muc29tZShmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdSRUFETUUnKT49MDt9KSwgZGV0YWlsOiAncm93cz0nK3Jvd3MubGVuZ3RofTtgLCA2XzAwMCk7XHJcbiAgICAgIGlmICghdzJbMF0pIHJldHVybiB3MjtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgZj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5mcy1yb3cnKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdSRUFETUUnKT49MDt9KTsgaWYoZikgZi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdmaWxlIHByZXZpZXcnLCBgdmFyIHA9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmZzLXByZXZpZXcnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXAgJiYgcC50ZXh0Q29udGVudC5pbmRleE9mKCdkZW1vIHdvcmtzcGFjZScpID49IDAsIGRldGFpbDogcCA/IHAudGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDQwKSA6ICdubyBwcmV2aWV3J307YCwgNl8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdEb2NrOkRpZmYgXHU1M0Q4XHU2NkY0XHU4ODRDJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nXHU1M0Q4XHU2NkY0J3x8eC50ZXh0Q29udGVudD09PSdEaWZmJzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdkaWZmIHJvd3MnLCBgdmFyIHJvd3M9ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRpZmYtcm93JykubGVuZ3RoO1xyXG4gICAgICAgIHJldHVybiB7b2s6IHJvd3MgPj0gMSwgZGV0YWlsOiAnZGlmZiByb3dzPScrcm93c307YCwgNl8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdEb2NrOkV2aWRlbmNlIFx1OEJBNFx1NzdFNVx1NjU3MFx1NjM2RScsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J1x1OEJDMVx1NjM2RSd8fHgudGV4dENvbnRlbnQ9PT0nRXZpZGVuY2UnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2V2aWRlbmNlIHJvd3MnLCBgdmFyIHJvd3M9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay1yb3cnKSk7XHJcbiAgICAgICAgdmFyIG1lbSA9IHJvd3MuZmluZChmdW5jdGlvbihyKXsgcmV0dXJuIHIudGV4dENvbnRlbnQuaW5kZXhPZignXHU4QkIwXHU1RkM2XHU1QzQyJyk+PTAgfHwgci50ZXh0Q29udGVudC5pbmRleE9mKCdNZW1vcnkgbGF5ZXJzJyk+PTA7IH0pO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhbWVtICYmIG1lbS50ZXh0Q29udGVudC5pbmRleE9mKCczJykgPj0gMCwgZGV0YWlsOiBtZW0gPyBtZW0udGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKSA6ICdubyBtZW1vcnkgcm93J307YCwgNl8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdEb2NrOkxvZ3MgXHU5NzYyXHU2NzdGKFx1N0E3QVx1NjAwMVx1NjNEMFx1NzkzQSknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdcdTY1RTVcdTVGRDcnfHx4LnRleHRDb250ZW50PT09J0xvZ3MnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2xvZ3MgcGFuZScsIGB2YXIgbD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcubG9ncy1saXN0Jyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFsLCBkZXRhaWw6IGwgPyAoJ3Jvd3M9JytsLnF1ZXJ5U2VsZWN0b3JBbGwoJy5sb2ctcm93JykubGVuZ3RoKSA6ICdubyBsb2dzIGxpc3QnfTtgLCA1XzAwMCk7XHJcbiAgICAgIHJldHVybiB3O1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOkRvY2s6XHU4RkRDXHU3QTBCXHU5ODc1XHU3QjdFKFx1NjI0Qlx1NjczQVx1OEZEQ1x1N0EwQlx1NjNBN1x1NTIzNlx1OTc2Mlx1Njc3RitcdTVGMDBcdTY3M0FcdTgxRUFcdTU0MkZcdTg4NEMpID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ0RvY2s6XHU4RkRDXHU3QTBCXHU5ODc1XHU3QjdFKFx1NjI0Qlx1NjczQVx1OEZEQ1x1N0EwQlx1NjNBN1x1NTIzNlx1OTc2Mlx1Njc3RiknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdcdThGRENcdTdBMEInfHx4LnRleHRDb250ZW50PT09J1JlbW90ZSc7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcigncmVtb3RlIHBhbmUnLCBgdmFyIHA9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmRvY2stYm9keScpO1xyXG4gICAgICAgIHZhciB0ID0gcCA/IHAudGV4dENvbnRlbnQgOiAnJztcclxuICAgICAgICB2YXIgb2tUID0gdC5pbmRleE9mKCdcdTYyNEJcdTY3M0FcdThGRENcdTdBMEJcdTYzQTdcdTUyMzYnKT49MCB8fCB0LmluZGV4T2YoJ1Bob25lIHJlbW90ZScpPj0wO1xyXG4gICAgICAgIHZhciBva0EgPSB0LmluZGV4T2YoJ1x1NUYwMFx1NjczQVx1ODFFQVx1NTQyRicpPj0wIHx8IHQuaW5kZXhPZignQXV0b3N0YXJ0Jyk+PTA7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFwICYmIG9rVCAmJiBva0EsIGRldGFpbDogdC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNjApfTtgLCA2XzAwMCk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU2NDFDXHU3RDIyXHU4RkM3XHU2RUU0ID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1NEYxQVx1OEJERFx1NjQxQ1x1N0QyMjpcdThGQzdcdTZFRTRcdTc1MUZcdTY1NDgnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IGJlZm9yZSA9IChhd2FpdCBqcyhgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aGApKSBhcyBudW1iZXI7XHJcbiAgICAgIGF3YWl0IHR5cGVJbnRvKCcuc2Vzc2lvbi1zZWFyY2gnLCAnenp6LVx1NEUwRFx1NUI1OFx1NTcyOFx1NzY4NFx1NEYxQVx1OEJERCcpO1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignZmlsdGVyZWQgZW1wdHknLCBgdmFyIG49ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aDtcclxuICAgICAgICByZXR1cm4ge29rOiBuID09PSAwLCBkZXRhaWw6ICdhZnRlcj0nK259O2AsIDVfMDAwKTtcclxuICAgICAgYXdhaXQgdHlwZUludG8oJy5zZXNzaW9uLXNlYXJjaCcsICcnKTtcclxuICAgICAgYXdhaXQgc2xlZXAoNDAwKTtcclxuICAgICAgY29uc3QgYWZ0ZXIgPSAoYXdhaXQganMoYGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGhgKSkgYXMgbnVtYmVyO1xyXG4gICAgICByZXR1cm4gW3dbMF0gJiYgYWZ0ZXIgPT09IGJlZm9yZSwgYCR7d1sxXX07IFx1NjA2Mlx1NTkwRFx1NTQwRSAke2FmdGVyfT09PSR7YmVmb3JlfWBdO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOkN0cmwrSyBcdTU0N0RcdTRFRTRcdTk3NjJcdTY3N0YgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnQ3RybCtLIFx1NTQ3RFx1NEVFNFx1OTc2Mlx1Njc3RjpcdTYyNTNcdTVGMDBcdTVFNzZcdTYyNjdcdTg4NENcdTU0N0RcdTRFRTQnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J2snLCBjdHJsS2V5OnRydWUsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignY21kayBvcGVuJywgYHZhciBjPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFjLCBkZXRhaWw6IGMgPyAnb3BlbicgOiAnbm90IG9wZW4nfTtgLCA1XzAwMCk7XHJcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGl0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNtZGstaXRlbScpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1NjU4N1x1NEVGNicpPj0wIHx8IHgudGV4dENvbnRlbnQuaW5kZXhPZignRmlsZXMnKT49MDt9KTsgaWYoaXQpIGl0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ3RhYiBzd2l0Y2hlZCcsIGB2YXIgdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuZG9jay10YWIuYWN0aXZlJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISF0ICYmICh0LnRleHRDb250ZW50PT09J1x1NjU4N1x1NEVGNid8fHQudGV4dENvbnRlbnQ9PT0nRmlsZXMnKSwgZGV0YWlsOiAnYWN0aXZlPScrKHQ/dC50ZXh0Q29udGVudDonbm9uZScpfTtgLCA1XzAwMCk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU4QkJFXHU3RjZFXHU5NzYyXHU2NzdGID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1OEJCRVx1N0Y2RShDdHJsK1NoaWZ0K1ApOlByb3ZpZGVyIFx1ODg2OFx1NTM1NVx1NTNFRlx1ODlDMSxFc2MgXHU1MTczXHU5NUVEJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidwJywgY3RybEtleTp0cnVlLCBzaGlmdEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3NldHRpbmdzIG9wZW4nLCBgdmFyIHM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNtZGsuc2V0dGluZ3MnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXMgJiYgISFzLnF1ZXJ5U2VsZWN0b3IoJy5wcm92aWRlci1mb3JtJyksIGRldGFpbDogcyA/ICdvcGVuK2Zvcm0nIDogJ25vdCBvcGVuJ307YCwgNV8wMDApO1xyXG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidFc2NhcGUnLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ3NldHRpbmdzIGNsb3NlZCcsIGByZXR1cm4ge29rOiAhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNtZGstb3ZlcmxheScpLCBkZXRhaWw6ICdjbG9zZWQnfTtgLCA1XzAwMCk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6aTE4biBcdThCRURcdThBMDBcdTUyMDdcdTYzNjIgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU4QkVEXHU4QTAwXHU1MjA3XHU2MzYyOlx1NEUyRFx1NjU4NyBcdTIxOTIgRW5nbGlzaCBcdTIxOTIgXHU2MDYyXHU1OTBEXHU0RTJEXHU2NTg3JywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidwJywgY3RybEtleTp0cnVlLCBzaGlmdEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3NldHRpbmdzIG9wZW4nLCBgdmFyIHM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNtZGsuc2V0dGluZ3MnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXMsIGRldGFpbDogcyA/ICdvcGVuJyA6ICdub3Qgb3Blbid9O2AsIDVfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jbWRrLnNldHRpbmdzIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdFbmdsaXNoJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IGVuID0gYXdhaXQgd2FpdEZvcignZW5nbGlzaCBzaG93bicsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhci1oZWFkIC5idG4ucHJpbWFyeScpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYiAmJiBiLnRleHRDb250ZW50ID09PSAnKyBOZXcgU2Vzc2lvbicsIGRldGFpbDogJ2J0bj0nKyhiP2IudGV4dENvbnRlbnQ6J25vbmUnKX07YCwgNV8wMDApO1xyXG4gICAgICBhd2FpdCBzaG90KCdlbmdsaXNoJyk7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY21kay5zZXR0aW5ncyBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU0RTJEXHU2NTg3Jzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IHpoID0gYXdhaXQgd2FpdEZvcignY2hpbmVzZSBiYWNrJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyLWhlYWQgLmJ0bi5wcmltYXJ5Jyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFiICYmIGIudGV4dENvbnRlbnQgPT09ICcrIFx1NjVCMFx1NUVGQVx1NEYxQVx1OEJERCcsIGRldGFpbDogJ2J0bj0nKyhiP2IudGV4dENvbnRlbnQ6J25vbmUnKX07YCwgNV8wMDApO1xyXG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidFc2NhcGUnLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgcmV0dXJuIFtlblswXSAmJiB6aFswXSwgYGVuOiAke2VuWzFdfTsgemg6ICR7emhbMV19YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU1REU1XHU0RjVDXHU1MzNBXHU3QkExXHU3NDA2KFx1NURFNlx1NjgwRlx1NjgwRlx1NEY0RCArIFx1ODNEQ1x1NTM1NSArIFx1NjVCMFx1NUVGQVx1NEYxQVx1OEJERFx1OTAwOVx1NURFNVx1NEY1Q1x1NTMzQSkgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU1REU1XHU0RjVDXHU1MzNBOlx1NURFNlx1NjgwRlx1NURFNVx1NEY1Q1x1NTMzQVx1NjgwRlx1NTNFRlx1ODlDMShcdTVGNTNcdTUyNERcdTVERTVcdTRGNUNcdTUzM0FcdTU0MEQpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignd29ya3NwYWNlIGJhcicsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud29ya3NwYWNlLWJhcicpO1xyXG4gICAgICAgIHZhciBuID0gYiA/IChiLnF1ZXJ5U2VsZWN0b3IoJy53cy1iYXItbmFtZScpfHx7fSkudGV4dENvbnRlbnQgOiAnJztcclxuICAgICAgICByZXR1cm4ge29rOiAhIWIgJiYgISFuICYmIG4ubGVuZ3RoID4gMCAmJiBuLmluZGV4T2YoJ1x1NTJBMFx1OEY3RCcpIDwgMCwgZGV0YWlsOiAnYmFyPScrKGI/J3llcyc6J25vJykrJyBuYW1lPScrbn07YCwgOF8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdcdTVERTVcdTRGNUNcdTUzM0E6XHU4M0RDXHU1MzU1XHU1RjM5XHU1MUZBLFx1NTIxN1x1ODg2OCtcdTVGNTNcdTUyNERcdTlBRDhcdTRFQUUrXHU2REZCXHU1MkEwXHU1MTY1XHU1M0UzO1x1NTcyOFx1NjMwN1x1NUI5QVx1NURFNVx1NEY1Q1x1NTMzQVx1NjVCMFx1NUVGQVx1NEYxQVx1OEJERCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud29ya3NwYWNlLWJhcicpOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3dzIG1lbnUnLCBgdmFyIG09ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLW1lbnUnKTtcclxuICAgICAgICB2YXIgaXRlbXMgPSBtID8gbS5xdWVyeVNlbGVjdG9yQWxsKCcud3MtbWVudS1pdGVtJykubGVuZ3RoIDogMDtcclxuICAgICAgICB2YXIgY3VyID0gbSA/IG0ucXVlcnlTZWxlY3RvckFsbCgnLndzLW1lbnUtaXRlbS5jdXJyZW50JykubGVuZ3RoIDogMDtcclxuICAgICAgICB2YXIgYWRkID0gbSA/IChtLnRleHRDb250ZW50LmluZGV4T2YoJ1x1NkRGQlx1NTJBMFx1NURFNVx1NEY1Q1x1NTMzQScpPj0wIHx8IG0udGV4dENvbnRlbnQuaW5kZXhPZignQWRkIHdvcmtzcGFjZScpPj0wKSA6IGZhbHNlO1xyXG4gICAgICAgIHJldHVybiB7b2s6IGl0ZW1zID49IDEgJiYgY3VyID49IDEgJiYgYWRkLCBkZXRhaWw6ICdpdGVtcz0nK2l0ZW1zKycgY3VycmVudD0nK2N1cisnIGFkZD0nK2FkZH07YCwgNl8wMDApO1xyXG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICBhd2FpdCBzaG90KCd3cy1tZW51Jyk7XHJcbiAgICAgIC8vIFx1NzBCOVx1N0IyQ1x1NEUwMFx1NEUyQVx1NURFNVx1NEY1Q1x1NTMzQVx1OTg3OSA9IFx1NTcyOFx1OEJFNVx1NURFNVx1NEY1Q1x1NTMzQVx1NjVCMFx1NUVGQVx1NEYxQVx1OEJERChcdTgzRENcdTUzNTVcdTUxNzNcdTk1RURcdTMwMDFjb21wb3NlciBcdTUzRUZcdTc1MjgpXHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGl0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1tZW51LWl0ZW0nKTsgaWYoaXQpIGl0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgY2xvc2VkID0gYXdhaXQgd2FpdEZvcignbWVudSBjbG9zZWQgKyBzZXNzaW9uIGFjdGl2ZScsIGB2YXIgdGE9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNvbXBvc2VyIHRleHRhcmVhJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1tZW51JykgJiYgISF0YSAmJiB0YS5kaXNhYmxlZCA9PT0gZmFsc2UsIGRldGFpbDogJ21lbnU9JysoZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLW1lbnUnKT8nb3Blbic6J2Nsb3NlZCcpKycgdGE9JysodGE/dGEuZGlzYWJsZWQ6J25vbmUnKX07YCwgNl8wMDApO1xyXG4gICAgICByZXR1cm4gW2Nsb3NlZFswXSwgYCR7d1sxXX07ICR7Y2xvc2VkWzFdfWBdO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NEYxQVx1OEJERFx1NjMwOVx1NURFNVx1NEY1Q1x1NTMzQVx1NTIwNlx1N0VDNCArIFx1NUM1NVx1NUYwMC9cdTY1MzZcdThENzcgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU0RjFBXHU4QkREXHU1MjA2XHU3RUM0Olx1N0VDNFx1NTkzNFx1NTFGQVx1NzNCMChcdTVERTVcdTRGNUNcdTUzM0FcdTU0MEQrXHU2NTcwXHU5MUNGKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2dyb3VwIGhlYWQnLCBgdmFyIGg9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLWdyb3VwLWhlYWQnKTtcclxuICAgICAgICB2YXIgbiA9IGggPyAoaC5xdWVyeVNlbGVjdG9yKCcud3MtZ3JvdXAtbmFtZScpfHx7fSkudGV4dENvbnRlbnQgOiAnJztcclxuICAgICAgICB2YXIgYyA9IGggPyAoaC5xdWVyeVNlbGVjdG9yKCcud3MtZ3JvdXAtY291bnQnKXx8e30pLnRleHRDb250ZW50IDogJyc7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFoICYmIG4ubGVuZ3RoID4gMCAmJiBjLmxlbmd0aCA+IDAsIGRldGFpbDogJ25hbWU9JytuKycgY291bnQ9JytjfTtgLCA4XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ1x1NEYxQVx1OEJERFx1NTIwNlx1N0VDNDpcdTcwQjlcdTUxRkJcdTdFQzRcdTU5MzRcdTY1MzZcdThENzcsXHU1MThEXHU3MEI5XHU1QzU1XHU1RjAwXHU2MDYyXHU1OTBEJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCBiZWZvcmUgPSAoYXdhaXQganMoYGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGhgKSkgYXMgbnVtYmVyO1xyXG4gICAgICBpZiAoYmVmb3JlID09PSAwKSByZXR1cm4gW2ZhbHNlLCAnbm8gc2Vzc2lvbnMgdG8gZ3JvdXAnXTtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgaD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtZ3JvdXAtaGVhZCcpOyBpZihoKSBoLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgY29sbGFwc2VkID0gYXdhaXQgd2FpdEZvcignY29sbGFwc2VkJywgYHZhciBnPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1ncm91cCcpO1xyXG4gICAgICAgIHZhciBoaWRkZW4gPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoIDwgJHtiZWZvcmV9O1xyXG4gICAgICAgIHJldHVybiB7b2s6IGhpZGRlbiwgZGV0YWlsOiAnaXRlbXM9Jytkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoKycgYmVmb3JlPSR7YmVmb3JlfSd9O2AsIDVfMDAwKTtcclxuICAgICAgYXdhaXQgc2hvdCgnd3MtZ3JvdXAtY29sbGFwc2VkJyk7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGg9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLWdyb3VwLWhlYWQnKTsgaWYoaCkgaC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IGV4cGFuZGVkID0gYXdhaXQgd2FpdEZvcignZXhwYW5kZWQgYmFjaycsIGB2YXIgbj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoO1xyXG4gICAgICAgIHJldHVybiB7b2s6IG4gPj0gJHtiZWZvcmV9LCBkZXRhaWw6ICdpdGVtcz0nK259O2AsIDVfMDAwKTtcclxuICAgICAgcmV0dXJuIFtjb2xsYXBzZWRbMF0gJiYgZXhwYW5kZWRbMF0sIGBjb2xsYXBzZTogJHtjb2xsYXBzZWRbMV19OyBleHBhbmQ6ICR7ZXhwYW5kZWRbMV19YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU1RkVCXHU2Mzc3XHU5NTJFXHU1RTJFXHU1MkE5XHU5NzYyXHU2NzdGKEN0cmwrLykgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU1RkVCXHU2Mzc3XHU5NTJFXHU1RTJFXHU1MkE5OkN0cmwrLyBcdTYyNTNcdTVGMDAsRXNjIFx1NTE3M1x1OTVFRCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleTonLycsIGN0cmxLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdzaG9ydGN1dHMgb3BlbicsIGB2YXIgcz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kaycpO1xyXG4gICAgICAgIHZhciByb3dzID0gcyA/IHMucXVlcnlTZWxlY3RvckFsbCgnLnNob3J0Y3V0LXJvdycpLmxlbmd0aCA6IDA7XHJcbiAgICAgICAgcmV0dXJuIHtvazogcm93cyA+PSA1LCBkZXRhaWw6ICdyb3dzPScrcm93c307YCwgNV8wMDApO1xyXG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICBhd2FpdCBzaG90KCdzaG9ydGN1dHMnKTtcclxuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleTonRXNjYXBlJywgYnViYmxlczp0cnVlfSkpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdzaG9ydGN1dHMgY2xvc2VkJywgYHJldHVybiB7b2s6ICFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kay1vdmVybGF5JyksIGRldGFpbDogJ2Nsb3NlZCd9O2AsIDVfMDAwKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTRGQTdcdTY4MEZcdTY1MzZcdTdGMjkgKyBcdTcyQjZcdTYwMDFcdThGQzdcdTZFRTQgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU0RkE3XHU2ODBGXHU2NTM2XHU3RjI5Olx1MjFFNCBcdTY1MzZcdThENzdcdTVERTZcdTY4MEYsXHUyMUU1IFx1NUM1NVx1NUYwMFx1NjA2Mlx1NTkwRCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgLy8gSElHIFAzIFx1N0VDNDI6XHUyMUU0L1x1MjFFNSBFbW9qaSBcdTVERjJcdTYzNjIgU1ZHIGljb24sXHU2MzA5XHU5NEFFXHU0RUU1IGFyaWEtbGFiZWwoXHU1NDJCXCJcdTRGQTdcdTY4MEZcIilcdTVCOUFcdTRGNERcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3RvZ2dsZSBidG4nLCBgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudG9wYmFyIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiAoeC5nZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnKXx8JycpLmluZGV4T2YoJ1x1NEZBN1x1NjgwRicpPj0wO30pO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYiwgZGV0YWlsOiAnYnRuPScrKGI/Yi5nZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnKTonbm9uZScpfTtgLCA1XzAwMCk7XHJcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudG9wYmFyIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiAoeC5nZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnKXx8JycpLmluZGV4T2YoJ1x1NEZBN1x1NjgwRicpPj0wO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgaGlkZGVuID0gYXdhaXQgd2FpdEZvcignc2lkZWJhciBoaWRkZW4nLCBgdmFyIHNiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyJyk7XHJcbiAgICAgICAgdmFyIGdvbmUgPSAhc2IgfHwgZ2V0Q29tcHV0ZWRTdHlsZShzYikuZGlzcGxheSA9PT0gJ25vbmUnO1xyXG4gICAgICAgIHJldHVybiB7b2s6IGdvbmUsIGRldGFpbDogJ2Rpc3BsYXk9Jysoc2I/Z2V0Q29tcHV0ZWRTdHlsZShzYikuZGlzcGxheTonbm9uZScpfTtgLCA1XzAwMCk7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudG9wYmFyIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiAoeC5nZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnKXx8JycpLmluZGV4T2YoJ1x1NEZBN1x1NjgwRicpPj0wO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3Qgc2hvd24gPSBhd2FpdCB3YWl0Rm9yKCdzaWRlYmFyIGJhY2snLCBgdmFyIHNiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFzYiAmJiBnZXRDb21wdXRlZFN0eWxlKHNiKS5kaXNwbGF5ICE9PSAnbm9uZScsIGRldGFpbDogJ2Rpc3BsYXk9Jysoc2I/Z2V0Q29tcHV0ZWRTdHlsZShzYikuZGlzcGxheTonbm9uZScpfTtgLCA1XzAwMCk7XHJcbiAgICAgIHJldHVybiBbaGlkZGVuWzBdICYmIHNob3duWzBdLCBgaGlkZTogJHtoaWRkZW5bMV19OyBzaG93OiAke3Nob3duWzFdfWBdO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdcdTcyQjZcdTYwMDFcdThGQzdcdTZFRTQ6XHU0RTBCXHU2MkM5XHU1MjA3XHU2MzYyXHU1MjMwXCJcdThGRDBcdTg4NENcdTRFMkRcIlx1NEUwRFx1NUQyOVx1NkU4M1x1NUU3Nlx1NjA2Mlx1NTkwRCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3Qgc2VsID0gYXdhaXQgd2FpdEZvcignZmlsdGVyIHNlbGVjdCcsIGB2YXIgcz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc3RhdHVzLWZpbHRlcicpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhcyAmJiBzLm9wdGlvbnMubGVuZ3RoID49IDQsIGRldGFpbDogJ29wdGlvbnM9Jysocz9zLm9wdGlvbnMubGVuZ3RoOjApfTtgLCA1XzAwMCk7XHJcbiAgICAgIGlmICghc2VsWzBdKSByZXR1cm4gc2VsO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zdGF0dXMtZmlsdGVyJyk7IHMudmFsdWU9J3J1bm5pbmcnOyBzLmRpc3BhdGNoRXZlbnQobmV3IEV2ZW50KCdjaGFuZ2UnLHtidWJibGVzOnRydWV9KSk7IH0pKClgKTtcclxuICAgICAgYXdhaXQgc2xlZXAoNTAwKTtcclxuICAgICAgY29uc3QgcjEgPSAoYXdhaXQganMoYGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGhgKSkgYXMgbnVtYmVyO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zdGF0dXMtZmlsdGVyJyk7IHMudmFsdWU9J2FsbCc7IHMuZGlzcGF0Y2hFdmVudChuZXcgRXZlbnQoJ2NoYW5nZScse2J1YmJsZXM6dHJ1ZX0pKTsgfSkoKWApO1xyXG4gICAgICBhd2FpdCBzbGVlcCg1MDApO1xyXG4gICAgICBjb25zdCByMiA9IChhd2FpdCBqcyhgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aGApKSBhcyBudW1iZXI7XHJcbiAgICAgIHJldHVybiBbcjIgPj0gcjEgJiYgcjIgPj0gMSwgYHJ1bm5pbmc9JHtyMX0gYWxsPSR7cjJ9YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU2QTIxXHU1NzhCXHU5MDA5XHU2MkU5XHU1NjY4KFx1OTg3Nlx1NjgwRlx1NTIwN1x1NjM2MiBjaGF0IFx1OERFRlx1NzUzMSkgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU2QTIxXHU1NzhCXHU5MDA5XHU2MkU5XHU1NjY4Olx1OTg3Nlx1NjgwRlx1ODNEQ1x1NTM1NVx1NTIxN1x1NTFGQSBwcm92aWRlcnMgXHU1RTc2XHU1M0VGXHU1MjA3XHU2MzYyJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignbW9kZWwgYnV0dG9uJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy50b3BiYXItbW9kZWwuYXMtYnV0dG9uJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFiICYmIGIuZGlzYWJsZWQgPT09IGZhbHNlLCBkZXRhaWw6IGIgPyBiLnRleHRDb250ZW50IDogJ25vbmUnfTtgLCA2XzAwMCk7XHJcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnRvcGJhci1tb2RlbC5hcy1idXR0b24nKTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IG0gPSBhd2FpdCB3YWl0Rm9yKCdtb2RlbCBtZW51JywgYHZhciBtPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5tb2RlbC1tZW51Jyk7XHJcbiAgICAgICAgdmFyIGl0ZW1zID0gbSA/IG0ucXVlcnlTZWxlY3RvckFsbCgnLndzLW1lbnUtaXRlbScpLmxlbmd0aCA6IDA7XHJcbiAgICAgICAgdmFyIGN1ciA9IG0gPyBtLnF1ZXJ5U2VsZWN0b3JBbGwoJy53cy1tZW51LWl0ZW0uY3VycmVudCcpLmxlbmd0aCA6IDA7XHJcbiAgICAgICAgcmV0dXJuIHtvazogaXRlbXMgPj0gMiAmJiBjdXIgPj0gMSwgZGV0YWlsOiAnaXRlbXM9JytpdGVtcysnIGN1cnJlbnQ9JytjdXJ9O2AsIDVfMDAwKTtcclxuICAgICAgaWYgKCFtWzBdKSByZXR1cm4gbTtcclxuICAgICAgYXdhaXQgc2hvdCgnbW9kZWwtbWVudScpO1xyXG4gICAgICAvLyBcdTUyMDdcdTUyMzBcdTdCMkNcdTRFOENcdTRFMkEgcHJvdmlkZXIoZmFrZTogZGVtby12aXNpb24vZmFrZS1tLXZpc2lvbilcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgaXRzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLm1vZGVsLW1lbnUgLndzLW1lbnUtaXRlbScpKTsgdmFyIGl0PWl0c1tpdHMubGVuZ3RoLTFdOyBpZihpdCkgaXQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignbW9kZWwgc3dpdGNoZWQnLCBgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnRvcGJhci1tb2RlbC5hcy1idXR0b24nKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWIgJiYgYi50ZXh0Q29udGVudC5pbmRleE9mKCdmYWtlLW0tdmlzaW9uJykgPj0gMCwgZGV0YWlsOiAnYmFkZ2U9JysoYj9iLnRleHRDb250ZW50Oidub25lJyl9O2AsIDZfMDAwKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTRFM0JcdTk4OTgoXHU2RDQ1XHU4MjcyXHU3NTFGXHU2NTQ4XHUyMTkyXHU2MDYyXHU1OTBEXHU2REYxXHU4MjcyKSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTRFM0JcdTk4OTg6XHU4QkJFXHU3RjZFXHU1MjA3XHU2RDQ1XHU4MjcyXHU3NTFGXHU2NTQ4LFx1NjA2Mlx1NTkwRFx1NkRGMVx1ODI3MicsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleToncCcsIGN0cmxLZXk6dHJ1ZSwgc2hpZnRLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdzZXR0aW5ncyBvcGVuJywgYHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrLnNldHRpbmdzJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFzLCBkZXRhaWw6IHMgPyAnb3BlbicgOiAnbm90IG9wZW4nfTtgLCA1XzAwMCk7XHJcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY21kay5zZXR0aW5ncyAuc2VnIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTZENDVcdTgyNzInfHx4LnRleHRDb250ZW50LnRyaW0oKT09PSdMaWdodCc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBsaWdodCA9IGF3YWl0IHdhaXRGb3IoJ2xpZ2h0IHRoZW1lJywgYHZhciBkdD1kb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuZGF0YXNldC50aGVtZTtcclxuICAgICAgICB2YXIgYmcgPSBnZXRDb21wdXRlZFN0eWxlKGRvY3VtZW50LmJvZHkpLmJhY2tncm91bmRDb2xvcjtcclxuICAgICAgICB2YXIgbSA9IC9cXFxcZCsvZzsgdmFyIG51bXM9KGJnLm1hdGNoKG0pfHxbJzAnLCcwJywnMCddKS5tYXAoTnVtYmVyKTtcclxuICAgICAgICByZXR1cm4ge29rOiBkdD09PSdsaWdodCcgJiYgbnVtc1swXT4yMDAgJiYgbnVtc1sxXT4yMDAgJiYgbnVtc1syXT4yMDAsIGRldGFpbDogJ3RoZW1lPScrZHQrJyBiZz0nK2JnfTtgLCA1XzAwMCk7XHJcbiAgICAgIGF3YWl0IHNob3QoJ2xpZ2h0LXRoZW1lJyk7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY21kay5zZXR0aW5ncyAuc2VnIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTZERjFcdTgyNzInfHx4LnRleHRDb250ZW50LnRyaW0oKT09PSdEYXJrJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IGRhcmsgPSBhd2FpdCB3YWl0Rm9yKCdkYXJrIGJhY2snLCBgcmV0dXJuIHtvazogZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LmRhdGFzZXQudGhlbWU9PT0nZGFyaycsIGRldGFpbDogJ3RoZW1lPScrZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LmRhdGFzZXQudGhlbWV9O2AsIDVfMDAwKTtcclxuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleTonRXNjYXBlJywgYnViYmxlczp0cnVlfSkpYCk7XHJcbiAgICAgIHJldHVybiBbbGlnaHRbMF0gJiYgZGFya1swXSwgYGxpZ2h0OiAke2xpZ2h0WzFdfTsgZGFyazogJHtkYXJrWzFdfWBdO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1OTg3Nlx1NjgwRiBcdTRFMkQvRU4gXHU1RkVCXHU2Mzc3XHU1MjA3XHU2MzYyKFx1NTNFRlx1NTNEMVx1NzNCMFx1NjAyNykgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU5ODc2XHU2ODBGXHU1RkVCXHU2Mzc3XHU1MjA3XHU2MzYyOlx1NEUyRC9FTiBcdTRFMDBcdTk1MkVcdTUyMDdcdTYzNjInLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdsYW5nIHNlZycsIGB2YXIgcz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcubGFuZy1zZWcnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXMgJiYgcy5xdWVyeVNlbGVjdG9yQWxsKCdidXR0b24nKS5sZW5ndGggPT09IDIsIGRldGFpbDogcyA/ICdwcmVzZW50JyA6ICdhYnNlbnQnfTtgLCA1XzAwMCk7XHJcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcubGFuZy1zZWcgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J0VOJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IGVuID0gYXdhaXQgd2FpdEZvcignZW5nbGlzaCcsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhci1oZWFkIC5idG4ucHJpbWFyeScpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYiAmJiBiLnRleHRDb250ZW50ID09PSAnKyBOZXcgU2Vzc2lvbicsIGRldGFpbDogJ2J0bj0nKyhiP2IudGV4dENvbnRlbnQ6J25vbmUnKX07YCwgNV8wMDApO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmxhbmctc2VnIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTRFMkQnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgemggPSBhd2FpdCB3YWl0Rm9yKCdjaGluZXNlIGJhY2snLCBgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXItaGVhZCAuYnRuLnByaW1hcnknKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWIgJiYgYi50ZXh0Q29udGVudCA9PT0gJysgXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREJywgZGV0YWlsOiAnYnRuPScrKGI/Yi50ZXh0Q29udGVudDonbm9uZScpfTtgLCA1XzAwMCk7XHJcbiAgICAgIHJldHVybiBbZW5bMF0gJiYgemhbMF0sIGBlbjogJHtlblsxXX07IHpoOiAke3poWzFdfWBdO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1N0M5OFx1OEQzNFx1NTZGRVx1NzI0NyBcdTIxOTIgXHU3RjI5XHU3NTY1XHU1NkZFIGNoaXAgXHUyMTkyIFx1NTNEMVx1OTAwMSBcdTIxOTIgcnVudGltZSBcdTY1MzZcdTUyMzAgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU3Qzk4XHU4RDM0XHU1NkZFXHU3MjQ3Olx1N0YyOVx1NzU2NVx1NTZGRSBjaGlwICsgXHU1M0QxXHU5MDAxXHU1NDBFIHJ1bnRpbWUgXHU2NTM2XHU1MjMwXHU1NkZFXHU3MjQ3JywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAvLyBcdTY1QjBcdTVFRkFcdTRGMUFcdThCRERcdTc4NkVcdTRGREQgY29tcG9zZXIgXHU1M0VGXHU3NTI4XHJcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J24nLCBjdHJsS2V5OnRydWUsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICBhd2FpdCBzbGVlcCgzMDApO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XHJcbiAgICAgICAgdmFyIHRhID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNvbXBvc2VyIHRleHRhcmVhJyk7XHJcbiAgICAgICAgaWYgKCF0YSkgcmV0dXJuO1xyXG4gICAgICAgIHZhciBjID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnY2FudmFzJyk7XHJcbiAgICAgICAgYy53aWR0aCA9IDg7IGMuaGVpZ2h0ID0gODtcclxuICAgICAgICB2YXIgY3R4ID0gYy5nZXRDb250ZXh0KCcyZCcpO1xyXG4gICAgICAgIGN0eC5maWxsU3R5bGUgPSAnIzNmOTY1MCc7IGN0eC5maWxsUmVjdCgwLCAwLCA4LCA4KTtcclxuICAgICAgICBjLnRvQmxvYihmdW5jdGlvbihibG9iKXtcclxuICAgICAgICAgIHZhciBkdCA9IG5ldyBEYXRhVHJhbnNmZXIoKTtcclxuICAgICAgICAgIGR0Lml0ZW1zLmFkZChuZXcgRmlsZShbYmxvYl0sICdwYXN0ZWQucG5nJywge3R5cGU6ICdpbWFnZS9wbmcnfSkpO1xyXG4gICAgICAgICAgdGEuZGlzcGF0Y2hFdmVudChuZXcgQ2xpcGJvYXJkRXZlbnQoJ3Bhc3RlJywge2NsaXBib2FyZERhdGE6IGR0LCBidWJibGVzOiB0cnVlLCBjYW5jZWxhYmxlOiB0cnVlfSkpO1xyXG4gICAgICAgIH0sICdpbWFnZS9wbmcnKTtcclxuICAgICAgfSkoKWApO1xyXG4gICAgICBjb25zdCBjaGlwID0gYXdhaXQgd2FpdEZvcignaW1hZ2UgY2hpcCcsIGB2YXIgbj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuYXR0LWNoaXAuaW1nJykubGVuZ3RoO1xyXG4gICAgICAgIHJldHVybiB7b2s6IG4gPj0gMSwgZGV0YWlsOiAnaW1nIGNoaXBzPScrbn07YCwgNl8wMDApO1xyXG4gICAgICBpZiAoIWNoaXBbMF0pIHJldHVybiBjaGlwO1xyXG4gICAgICBhd2FpdCB0eXBlSW50bygnLmNvbXBvc2VyIHRleHRhcmVhJywgJ1x1NzcwQlx1OEZEOVx1NUYyMFx1NTZGRScpO1xyXG4gICAgICBhd2FpdCBzbGVlcCgyMDApO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNvbXBvc2VyIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTUzRDFcdTkwMDEnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgZG9uZSA9IGF3YWl0IHdhaXRGb3IoJ2ltYWdlIHNlbnQnLCBgXHJcbiAgICAgICAgdmFyIGFwID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmFwcHJvdmFsLWNhcmQgYnV0dG9uJyk7XHJcbiAgICAgICAgaWYgKGFwICYmIGFwLnRleHRDb250ZW50LnRyaW0oKS5pbmRleE9mKCdcdTYyNzlcdTUxQzYnKT49MCkgYXAuY2xpY2soKTtcclxuICAgICAgICB2YXIgdHM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudHVybicpKTtcclxuICAgICAgICB2YXIgaGl0ID0gdHMuZmlsdGVyKGZ1bmN0aW9uKHgpeyByZXR1cm4geC5jbGFzc05hbWUuaW5kZXhPZigndXNlcicpPDAgJiYgeC50ZXh0Q29udGVudC5pbmRleE9mKCdbaW1hZ2VzOiAxXScpID49IDA7IH0pO1xyXG4gICAgICAgIHJldHVybiB7b2s6IGhpdC5sZW5ndGggPj0gMSwgZGV0YWlsOiAncnVudGltZS1lY2hvLXdpdGgtaW1hZ2U9JytoaXQubGVuZ3RofTtcclxuICAgICAgYCwgMTVfMDAwKTtcclxuICAgICAgYXdhaXQgc2hvdCgncGFzdGVkLWltYWdlJyk7XHJcbiAgICAgIHJldHVybiBkb25lO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1RDgzRFx1RENDRSBcdTRFMEFcdTRGMjAvXHVEODNEXHVEQ0MxIFx1NkQ0Rlx1ODlDOFx1NjMwOVx1OTRBRVx1NUMzMVx1NEY0RCA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTk2NDRcdTRFRjZcdTRFMEVcdTc2RUVcdTVGNTVcdTUxNjVcdTUzRTM6XHVEODNEXHVEQ0NFIFx1NEUwQVx1NEYyMCArIFx1RDgzRFx1RENDMSBcdTZENEZcdTg5QzhcdTYzMDlcdTk0QUVcdTVCNThcdTU3MjgnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoYChmdW5jdGlvbigpe1xyXG4gICAgICAgIHZhciB1cCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jb21wb3NlciBidXR0b25bYXJpYS1sYWJlbCo9XCJcdTRFMEFcdTRGMjBcIl0sIC5jb21wb3NlciBidXR0b25bYXJpYS1sYWJlbCo9XCJVcGxvYWRcIl0nKTtcclxuICAgICAgICB2YXIgYnIgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtcGlja2VyIGJ1dHRvbicpO1xyXG4gICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh7dXA6ICEhdXAsIGJyb3dzZTogISFicn0pO1xyXG4gICAgICB9KSgpYCkpIGFzIHN0cmluZztcclxuICAgICAgY29uc3QgcCA9IEpTT04ucGFyc2UocikgYXMgeyB1cDogYm9vbGVhbjsgYnJvd3NlOiBib29sZWFuIH07XHJcbiAgICAgIHJldHVybiBbcC51cCAmJiBwLmJyb3dzZSwgYFx1RDgzRFx1RENDRT0ke3AudXB9IFx1RDgzRFx1RENDMT0ke3AuYnJvd3NlfWBdO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOkAgXHU5NjQ0XHU0RUY2XHU5MDA5XHU2MkU5XHU1NjY4ID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ0AgXHU5NjQ0XHU0RUY2Olx1OTAwOVx1NjJFOVx1NTY2OFx1NTFGQVx1NzNCMFx1NUU3Nlx1NTNFRlx1OTAwOVx1NjU4N1x1NEVGNicsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jb21wb3NlciBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nQCc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignYXR0IHBpY2tlcicsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuYXR0LXBpY2tlcicpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhcCwgZGV0YWlsOiBwID8gJ29wZW4nIDogJ25vdCBvcGVuJ307YCwgNV8wMDApO1xyXG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICBhd2FpdCB0eXBlSW50bygnLmF0dC1waWNrZXIgaW5wdXQnLCAncmVhZCcpO1xyXG4gICAgICBjb25zdCB3MiA9IGF3YWl0IHdhaXRGb3IoJ2F0dCByZXN1bHRzJywgYHZhciByPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5hdHQtcmVzdWx0cyAuZnMtcm93JykubGVuZ3RoO1xyXG4gICAgICAgIHJldHVybiB7b2s6IHIgPj0gMSwgZGV0YWlsOiAncmVzdWx0cz0nK3J9O2AsIDZfMDAwKTtcclxuICAgICAgaWYgKCF3MlswXSkgcmV0dXJuIHcyO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBmPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5hdHQtcmVzdWx0cyAuZnMtcm93Jyk7IGlmKGYpIGYuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignYXR0IGNoaXAnLCBgdmFyIGM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmF0dC1jaGlwJykubGVuZ3RoO1xyXG4gICAgICAgIHJldHVybiB7b2s6IGMgPj0gMSwgZGV0YWlsOiAnY2hpcHM9JytjfTtgLCA1XzAwMCk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2UoXHU1NDExXHU1QkZDXHU2Nzg0XHU5MDIwKTpcdThCQkVcdTdGNkVcdTMwMENcdTkxQ0RcdTY1QjBcdTkxNERcdTdGNkVcdTMwMERcdTkxQ0RcdTUxNjUgKyBcdTkwMDlcdTYyRTlcdTYzMDFcdTRFNDUgPT09PT09PT09PSAqL1xyXG4gICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX1dJWkFSRCA9PT0gJ2Zha2UnKSB7XHJcbiAgICAgIGF3YWl0IHN0ZXAoJ1x1NTQxMVx1NUJGQzpcdThCQkVcdTdGNkVcdTMwMENcdTkxQ0RcdTY1QjBcdTkxNERcdTdGNkVcdTMwMERcdTkxQ0RcdTUxNjUgKyBcdTkwMDlcdTYyRTlcdTYzMDFcdTRFNDUod2l6YXJkLmpzb24pJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J3AnLCBjdHJsS2V5OnRydWUsIHNoaWZ0S2V5OnRydWUsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICAgIGNvbnN0IG9wZW4gPSBhd2FpdCB3YWl0Rm9yKCdzZXR0aW5ncyBvcGVuJywgYHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrLnNldHRpbmdzJyk7XHJcbiAgICAgICAgICByZXR1cm4ge29rOiAhIXMsIGRldGFpbDogcyA/ICdvcGVuJyA6ICdjbG9zZWQnfTtgLCA1XzAwMCk7XHJcbiAgICAgICAgaWYgKCFvcGVuWzBdKSByZXR1cm4gb3BlbjtcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNtZGsuc2V0dGluZ3MgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU5MUNEXHU2NUIwXHU5MTREXHU3RjZFJyk+PTA7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgIGNvbnN0IHNob3duID0gYXdhaXQgd2FpdEZvcignd2l6YXJkIHJlb3BlbmVkJywgYHJldHVybiB7b2s6ICEhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1vdmVybGF5JyksXHJcbiAgICAgICAgICBkZXRhaWw6IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3ZlcmxheScpID8gJ29wZW4nIDogJ2Nsb3NlZCd9O2AsIDVfMDAwKTtcclxuICAgICAgICBpZiAoIXNob3duWzBdKSByZXR1cm4gc2hvd247XHJcbiAgICAgICAgYXdhaXQgc2hvdCgnd2l6YXJkLXJlZW50cnknKTtcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTUzRDZcdTZEODgnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICBjb25zdCBjbG9zZWQgPSBhd2FpdCB3YWl0Rm9yKCd3aXphcmQgY2xvc2VkJywgYHJldHVybiB7b2s6ICFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKSwgZGV0YWlsOiAnY2xvc2VkJ307YCwgNV8wMDApO1xyXG4gICAgICAgIGNvbnN0IHN0ID0gKGF3YWl0IGpzKGB3aW5kb3cuaG1oLmdldFdpemFyZCgpLnRoZW4oZnVuY3Rpb24ocil7cmV0dXJuIEpTT04uc3RyaW5naWZ5KHIpO30pYCkpIGFzIHN0cmluZztcclxuICAgICAgICBjb25zdCBwID0gSlNPTi5wYXJzZShzdCkgYXMgeyBwZXJzaXN0ZWQ/OiB7IGRvbmU/OiBib29sZWFuOyBjaG9pY2U/OiBzdHJpbmcgfSB9O1xyXG4gICAgICAgIGNvbnN0IHBlcnNpc3RlZCA9IHAucGVyc2lzdGVkPy5kb25lID09PSB0cnVlICYmIHAucGVyc2lzdGVkPy5jaG9pY2UgPT09ICdidW5kbGVkJztcclxuICAgICAgICByZXR1cm4gW2Nsb3NlZFswXSAmJiBwZXJzaXN0ZWQsIGBjbG9zZWQ9JHtjbG9zZWRbMF19IHBlcnNpc3RlZD0ke0pTT04uc3RyaW5naWZ5KHAucGVyc2lzdGVkID8/IG51bGwpfWBdO1xyXG4gICAgICB9KTtcclxuXHJcbiAgICAgIC8qID09PT09PT09PT0gZmFrZShcdTU0MTFcdTVCRkNcdTY3ODRcdTkwMjApOlx1N0E4NFx1NUM0RiAzNjBcdTAwRDc2NDAgXHU1MTY4XHU1MTQzXHU3RDIwXHU1M0VGXHU4RkJFICsgXHU1MzU1XHU1MUZCXHU5MDA5XHU5ODc5XHU1MzczXHU1MjREXHU4RkRCID09PT09PT09PT1cclxuICAgICAgICAgXHU3NTI4XHU2MjM3XHU2MjRCXHU2NzNBXHU1QjlFXHU2RDRCXHU3NURCXHU3MEI5Olx1N0E4NFx1ODlDNlx1NTNFM1x1NEUwQlx1OTAwOVx1OTg3OS9cdTYzMDlcdTk0QUVcdTg4QUJcdTg4QzFcdTUyMDdcdTcwQjlcdTRFMERcdTUyMzBcdTMwMDJcdTRGMkFcdTkwMjBcIlx1NjhDMFx1NkQ0Qlx1NTIzMFx1NURGMlx1ODhDNVwiXHJcbiAgICAgICAgIChcdTRFM0JcdThGREJcdTdBMEIgZW52IFx1NTM3M1x1NjVGNlx1OEJGQilcdThCQTlcdTU0MTFcdTVCRkNcdTUxRkFcdTczQjBcdTRFMDlcdTkwMDlcdTk4NzlcdThERUZcdTVGODQsXHU3RjI5XHU1MjMwIDM2MFx1MDBENzY0MCBcdTU0MEVcdTkwMTBcdTRFMkFcclxuICAgICAgICAgZWxlbWVudEZyb21Qb2ludCBcdTY1QURcdThBMDAoXHU0RTBEXHU2NjJGXHU4OEFCXHU4OEMxXHU1MjA3KTtcdTUxOERcdTlBOENcdThCQzFcdTUzNTVcdTUxRkJcdTUyNERcdThGREJcdTRFMEVcdTUzRDZcdTZEODhcdTMwMDIgKi9cclxuICAgICAgYXdhaXQgc3RlcCgnXHU1NDExXHU1QkZDOlx1N0E4NFx1NUM0RiAzNjBcdTAwRDc2NDBcdTIwMTRcdTIwMTRcdTRFMDlcdTkwMDlcdTk4NzkoXHU1NDJCIG5vdGUgXHU2NTc0XHU2ODBGKVx1NEUwRVx1NjMwOVx1OTRBRVx1NTE2OFx1OTBFOFx1NTNFRlx1NTQ3RFx1NEUyRCtcdTUzNTVcdTUxRkJcdTUzNzNcdTUyNERcdThGREInLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfRkFLRV9ERVRFQ1RfRk9VTkQgPSAnMSc7XHJcbiAgICAgICAgY29uc3Qgc2l6ZTAgPSB3aW4uZ2V0U2l6ZSgpO1xyXG4gICAgICAgIGNvbnN0IHcwID0gc2l6ZTBbMF0gPz8gMTI4MDtcclxuICAgICAgICBjb25zdCBoMCA9IHNpemUwWzFdID8/IDgwMDtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleToncCcsIGN0cmxLZXk6dHJ1ZSwgc2hpZnRLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XHJcbiAgICAgICAgICBjb25zdCBvcGVuID0gYXdhaXQgd2FpdEZvcignc2V0dGluZ3Mgb3BlbicsIGB2YXIgcz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kay5zZXR0aW5ncycpOyByZXR1cm4ge29rOiAhIXMsIGRldGFpbDogcyA/ICdvcGVuJyA6ICdjbG9zZWQnfTtgLCA1XzAwMCk7XHJcbiAgICAgICAgICBpZiAoIW9wZW5bMF0pIHJldHVybiBvcGVuO1xyXG4gICAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jbWRrLnNldHRpbmdzIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1OTFDRFx1NjVCMFx1OTE0RFx1N0Y2RScpPj0wO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICAgIGNvbnN0IHNob3duID0gYXdhaXQgd2FpdEZvcignd2l6YXJkIHJlb3BlbmVkJywgYHJldHVybiB7b2s6ICEhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1vdmVybGF5JyksIGRldGFpbDogZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1vdmVybGF5JykgPyAnb3BlbicgOiAnY2xvc2VkJ307YCwgNV8wMDApO1xyXG4gICAgICAgICAgaWYgKCFzaG93blswXSkgcmV0dXJuIHNob3duO1xyXG4gICAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1RjAwXHU1OUNCXHU5MTREXHU3RjZFJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgICBjb25zdCBkZXRlY3RQYWdlID0gYXdhaXQgd2FpdEZvcignZGV0ZWN0IGZvdW5kIHBhZ2UoMyBvcHRpb25zKScsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtZGV0ZWN0Jyk7XHJcbiAgICAgICAgICAgIHZhciBvcHRzPXA/cC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW9wdCcpLmxlbmd0aDowO1xyXG4gICAgICAgICAgICByZXR1cm4ge29rOiAhIXAgJiYgb3B0cz09PTMsIGRldGFpbDogJ29wdHM9JytvcHRzfTtgLCAxMl8wMDApO1xyXG4gICAgICAgICAgaWYgKCFkZXRlY3RQYWdlWzBdKSByZXR1cm4gZGV0ZWN0UGFnZTtcclxuICAgICAgICAgIC8vIFx1NTM1NVx1NTFGQlx1OTAwOVx1OTg3OVx1NTM3M1x1NTI0RFx1OEZEQjpcdTcwQjlcIlx1NEVDRFx1ODk4MVx1NEUwQlx1OEY3RFx1NjVCMFx1NzI0OFwiXHU1RTk0XHU3NkY0XHU2M0E1XHU4NDNEXHU1MjMwXHU5MDA5XHU2MkU5XHU5ODc1KFx1NjVFMFx1OTcwMFx1NTE4RFx1NzBCOVwiXHU0RTBCXHU0RTAwXHU2QjY1XCIpXHJcbiAgICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBvPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vcHQnKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTRFQ0RcdTg5ODFcdTRFMEJcdThGN0RcdTY1QjBcdTcyNDgnKT49MDt9KTsgaWYobykgby5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgICBjb25zdCBzZWxlY3RQYWdlID0gYXdhaXQgd2FpdEZvcignc2VsZWN0IHBhZ2UgdmlhIHNpbmdsZSBjbGljaycsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2Utc2VsZWN0Jyk7XHJcbiAgICAgICAgICAgIHJldHVybiB7b2s6ICEhcCAmJiBwLnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3B0JykubGVuZ3RoPT09MywgZGV0YWlsOiBwID8gJ3NlbGVjdCcgOiAnbm90IHNlbGVjdCd9O2AsIDZfMDAwKTtcclxuICAgICAgICAgIGlmICghc2VsZWN0UGFnZVswXSkgcmV0dXJuIFtmYWxzZSwgYFx1NTM1NVx1NTFGQlx1OTAwOVx1OTg3OVx1NjcyQVx1NTI0RFx1OEZEQlx1NTIzMFx1OTAwOVx1NjJFOVx1OTg3NTogJHtzZWxlY3RQYWdlWzFdfWBdO1xyXG4gICAgICAgICAgLy8gXHU3RjI5XHU1MjMwIDM2MFx1MDBENzY0MChtaW5XaWR0aCBcdTVERjJcdTU3MjggVUlWRVJJRlkgXHU0RTBCXHU2NTNFXHU1QkJEKSxcdTY1QURcdThBMDBcdTUxNjhcdTkwRThcdTUzRUZcdTU0N0RcdTRFMkRcclxuICAgICAgICAgIHdpbi5zZXRTaXplKDM2MCwgNjQwKTtcclxuICAgICAgICAgIGF3YWl0IHNsZWVwKDUwMCk7XHJcbiAgICAgICAgICBjb25zdCByID0gKGF3YWl0IGpzKGAoZnVuY3Rpb24oKXtcclxuICAgICAgICAgICAgZnVuY3Rpb24gaGl0KGVsKXsgZWwuc2Nyb2xsSW50b1ZpZXcoe2Jsb2NrOiduZWFyZXN0J30pOyB2YXIgcj1lbC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcclxuICAgICAgICAgICAgICB2YXIgeD1yLmxlZnQrci53aWR0aC8yLCB5PXIudG9wK3IuaGVpZ2h0LzI7XHJcbiAgICAgICAgICAgICAgdmFyIGU9ZG9jdW1lbnQuZWxlbWVudEZyb21Qb2ludCh4LHkpO1xyXG4gICAgICAgICAgICAgIHJldHVybiAhIShlICYmIChlPT09ZWwgfHwgZWwuY29udGFpbnMoZSkpKTsgfVxyXG4gICAgICAgICAgICB2YXIgY2FyZD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2Utc2VsZWN0Jyk7XHJcbiAgICAgICAgICAgIHZhciBvcHRzPVtdLnNsaWNlLmNhbGwoY2FyZC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW9wdCcpKTtcclxuICAgICAgICAgICAgdmFyIG9wdEhpdD1vcHRzLm1hcChoaXQpO1xyXG4gICAgICAgICAgICB2YXIgbm90ZXM9W10uc2xpY2UuY2FsbChjYXJkLnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3B0LW5vdGUnKSk7XHJcbiAgICAgICAgICAgIHZhciBub3RlSGl0PW5vdGVzLm1hcChmdW5jdGlvbihuKXsgbi5zY3JvbGxJbnRvVmlldyh7YmxvY2s6J25lYXJlc3QnfSk7IHZhciByPW4uZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XHJcbiAgICAgICAgICAgICAgdmFyIGU9ZG9jdW1lbnQuZWxlbWVudEZyb21Qb2ludChyLmxlZnQrci53aWR0aC8yLCByLnRvcCtNYXRoLm1pbihyLmhlaWdodC8yLCA4KSk7XHJcbiAgICAgICAgICAgICAgcmV0dXJuICEhKGUgJiYgb3B0cy5zb21lKGZ1bmN0aW9uKG8peyByZXR1cm4gZT09PW8gfHwgby5jb250YWlucyhlKTsgfSkpOyB9KTtcclxuICAgICAgICAgICAgdmFyIGFjdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2Utc2VsZWN0IC53aXphcmQtYWN0aW9ucyAuYnRuLnByaW1hcnknKTtcclxuICAgICAgICAgICAgdmFyIGZvb3Rlcj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtZm9vdGVyIGJ1dHRvbicpKTtcclxuICAgICAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHt2dzogd2luZG93LmlubmVyV2lkdGgsIHZoOiB3aW5kb3cuaW5uZXJIZWlnaHQsIG9wdHM6IG9wdHMubGVuZ3RoLFxyXG4gICAgICAgICAgICAgIG9wdEhpdDogb3B0SGl0LCBub3RlSGl0OiBub3RlSGl0LCBhY3RIaXQ6IGFjdCA/IGhpdChhY3QpIDogZmFsc2UsIGZ0SGl0OiBmb290ZXIubWFwKGhpdCl9KTtcclxuICAgICAgICAgIH0pKClgKSkgYXMgc3RyaW5nO1xyXG4gICAgICAgICAgY29uc3QgcSA9IEpTT04ucGFyc2UocikgYXMgeyB2dzogbnVtYmVyOyB2aDogbnVtYmVyOyBvcHRzOiBudW1iZXI7IG9wdEhpdDogYm9vbGVhbltdOyBub3RlSGl0OiBib29sZWFuW107IGFjdEhpdDogYm9vbGVhbjsgZnRIaXQ6IGJvb2xlYW5bXSB9O1xyXG4gICAgICAgICAgYXdhaXQgc2hvdCgnd2l6YXJkLW5hcnJvdy0zNjAtc2VsZWN0Jyk7XHJcbiAgICAgICAgICBjb25zdCBuYXJyb3dPayA9IHEub3B0cyA9PT0gMyAmJiBxLnZ3IDw9IDM4MCAmJiBxLm9wdEhpdC5ldmVyeShCb29sZWFuKSAmJiBxLm5vdGVIaXQuZXZlcnkoQm9vbGVhbikgJiYgcS5hY3RIaXQgJiYgcS5mdEhpdC5ldmVyeShCb29sZWFuKTtcclxuICAgICAgICAgIC8vIFx1N0E4NFx1NUM0Rlx1NEUwQlx1NTM1NVx1NTFGQlx1OTAwOVx1OTg3OVx1MjQ2MCA9IFx1OTAwOVx1NEUyRFx1NUU3Nlx1NTI0RFx1OEZEQlx1NTIzMFx1NUI4OVx1ODhDNVx1OTg3NSh2ZXJpZnkgXHU2QTIxXHU2MkRGXHU4RkRCXHU1RUE2LFx1NEUwRFx1ODQzRFx1NzZEOClcclxuICAgICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIG89W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW9wdCcpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1NEUwQlx1OEY3RFx1NUI4OVx1ODhDNVx1NUI4Q1x1NjU3NCBobWggQ0xJJyk+PTA7fSk7IGlmKG8pIG8uY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgICAgY29uc3QgYWR2ID0gYXdhaXQgd2FpdEZvcignaW5zdGFsbCBwYWdlIHZpYSBzaW5nbGUgY2xpY2snLCBgdmFyIHA9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLWluc3RhbGwnKTtcclxuICAgICAgICAgICAgcmV0dXJuIHtvazogISFwLCBkZXRhaWw6IHAgPyAnaW5zdGFsbGluZycgOiAnbm90IHNob3duJ307YCwgNl8wMDApO1xyXG4gICAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1M0Q2XHU2RDg4Jzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgICBjb25zdCBjbG9zZWROYXJyb3cgPSBhd2FpdCB3YWl0Rm9yKCd3aXphcmQgY2xvc2VkIGF0IDM2MHB4JywgYHJldHVybiB7b2s6ICFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKSwgZGV0YWlsOiAnY2xvc2VkJ307YCwgNV8wMDApO1xyXG4gICAgICAgICAgcmV0dXJuIFtuYXJyb3dPayAmJiBhZHZbMF0gJiYgY2xvc2VkTmFycm93WzBdLFxyXG4gICAgICAgICAgICBgdnA9JHtxLnZ3fXgke3Eudmh9IG9wdHM9JHtxLm9wdHN9IG9wdEhpdD1bJHtxLm9wdEhpdC5qb2luKCcsJyl9XSBub3RlSGl0PVske3Eubm90ZUhpdC5qb2luKCcsJyl9XSBcdTRFM0JcdTYzMDlcdTk0QUU9JHtxLmFjdEhpdH0gZm9vdGVyPVske3EuZnRIaXQuam9pbignLCcpfV07IFx1NTM1NVx1NTFGQlx1NTI0RFx1OEZEQjogJHthZHZbMV19OyBcdTdBODRcdTVDNEZcdTUzRDZcdTZEODg6ICR7Y2xvc2VkTmFycm93WzFdfWBdO1xyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICB3aW4uc2V0U2l6ZSh3MCwgaDApO1xyXG4gICAgICAgICAgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfRkFLRV9ERVRFQ1RfRk9VTkQgPSB1bmRlZmluZWQ7XHJcbiAgICAgICAgfVxyXG4gICAgICB9KTtcclxuICAgIH1cclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6SElHIFx1OTYzNlx1NkJCNTIgXHUyMDE0XHUyMDE0IFx1N0E4NFx1N0E5N1x1NjJCRFx1NUM0OSArIFx1NjgwN1x1OTg5OFx1NjgwRiA0NHB4L2RyYWcgXHU1MzNBID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1N0E4NFx1N0E5N1x1NjJCRFx1NUM0OTo3NjBweCBcdTRGQTdcdTY4MEZcdTUzRUZcdThGQkVcdTUzRUZcdTUxNzMoXHU5MDZFXHU3RjY5XHU3MEI5XHU1MUZCICsgRXNjKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgdHJ5IHsgd2luLnNldE1pbmltdW1TaXplKDU2MCwgNjAwKTsgd2luLnNldEJvdW5kcyh7IHdpZHRoOiA3NjAsIGhlaWdodDogNzAwIH0pOyB9IGNhdGNoIHsgLyogYmVzdCBlZmZvcnQgKi8gfVxyXG4gICAgICBjb25zdCBpc05hcnJvdyA9IGF3YWl0IHdhaXRGb3IoJ21hdGNoTWVkaWEgODIwJywgYHJldHVybiB7b2s6IHdpbmRvdy5tYXRjaE1lZGlhKCcobWF4LXdpZHRoOiA4MjBweCknKS5tYXRjaGVzLCBkZXRhaWw6ICdpdz0nICsgd2luZG93LmlubmVyV2lkdGh9O2AsIDVfMDAwKTtcclxuICAgICAgaWYgKCFpc05hcnJvd1swXSkgcmV0dXJuIGlzTmFycm93O1xyXG4gICAgICAvLyBcdTdCNDkgUmVhY3QgXHU2MzA5XHU3QTg0XHU3QTk3XHU5MUNEXHU2RTMyXHU2N0QzXHU1MUZBXHU2MkJEXHU1QzQ5XHU2MzA5XHU5NEFFKGFyaWEtbGFiZWwgXHU2MzYyXHU2MjEwXCJcdTYyQkRcdTVDNDlcIlx1NjU4N1x1Njg0OClcdTUxOERcdTcwQjlcdTIwMTRcdTIwMTRDU1MgXHU2NUFEXHU3MEI5XHU1MzczXHU2NUY2LFxyXG4gICAgICAvLyBSZWFjdCBzdGF0ZSBcdTY3MDlcdTZCRUJcdTc5RDJcdTdFQTdcdTVFRjZcdThGREYsXHU3NkYyXHU3MEI5XHU0RjFBXHU4NDNEXHU1NzI4XHU2NUU3XHU3Njg0XCJcdTY1MzZcdThENzdcdTRGQTdcdTY4MEZcIlx1NEUwQVxyXG4gICAgICBjb25zdCBidG4gPSBhd2FpdCB3YWl0Rm9yKCdkcmF3ZXIgYnV0dG9uJywgYHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnRvcGJhciBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4gKHguZ2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJyl8fCcnKS5pbmRleE9mKCdcdTYyQkRcdTVDNDknKT49MDt9KTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWIsIGRldGFpbDogJ2J0bj0nKyhiP2IuZ2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJyk6J25vbmUnKX07YCwgNV8wMDApO1xyXG4gICAgICBpZiAoIWJ0blswXSkgcmV0dXJuIGJ0bjtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50b3BiYXIgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuICh4LmdldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcpfHwnJykuaW5kZXhPZignXHU2MkJEXHU1QzQ5Jyk+PTA7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBvcGVuZWQgPSBhd2FpdCB3YWl0Rm9yKCdkcmF3ZXIgb3BlbicsIGB2YXIgc2I9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXInKSwgc2M9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXItc2NyaW0nKTtcclxuICAgICAgICB2YXIgcj1zYj9zYi5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTpudWxsO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhciAmJiByLnggPj0gMCAmJiByLnggPCA0MCAmJiAhIXNjLCBkZXRhaWw6ICd4PScrKHI/TWF0aC5yb3VuZChyLngpOidub25lJykrJyBzY3JpbT0nKyhzYz8neWVzJzonbm8nKX07YCwgNV8wMDApO1xyXG4gICAgICBhd2FpdCBzaG90KCdkcmF3ZXItb3BlbicpO1xyXG4gICAgICAvLyBcdTkwNkVcdTdGNjlcdTcwQjlcdTUxRkJcdTUxNzNcdTk1RUQgXHUyMTkyIFx1NEZBN1x1NjgwRlx1NkVEMVx1NTFGQSh4IDwgMCkrIFx1OTA2RVx1N0Y2OVx1NkQ4OFx1NTkzMVxyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBzYz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhci1zY3JpbScpOyBpZihzYykgc2MuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBjbG9zZWQgPSBhd2FpdCB3YWl0Rm9yKCdkcmF3ZXIgY2xvc2VkIGJ5IHNjcmltJywgYHZhciBzYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhcicpLCBzYz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhci1zY3JpbScpO1xyXG4gICAgICAgIHZhciByPXNiP3NiLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOm51bGw7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFyICYmIHIueCA8IDAgJiYgIXNjLCBkZXRhaWw6ICd4PScrKHI/TWF0aC5yb3VuZChyLngpOidub25lJykrJyBzY3JpbT0nKyhzYz8neWVzJzonbm8nKX07YCwgNV8wMDApO1xyXG4gICAgICAvLyBFc2MgXHU0RTVGXHU4MEZEXHU1RjAwL1x1NTE3M1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnRvcGJhciBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4gKHguZ2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJyl8fCcnKS5pbmRleE9mKCdcdTYyQkRcdTVDNDknKT49MDt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGF3YWl0IHdhaXRGb3IoJ2RyYXdlciByZW9wZW4nLCBgdmFyIHNiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyJyk7IHZhciByPXNiP3NiLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOm51bGw7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFyICYmIHIueCA+PSAwICYmIHIueCA8IDQwLCBkZXRhaWw6ICd4PScrKHI/TWF0aC5yb3VuZChyLngpOidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleTonRXNjYXBlJywgYnViYmxlczp0cnVlfSkpYCk7XHJcbiAgICAgIGNvbnN0IGVzY0Nsb3NlZCA9IGF3YWl0IHdhaXRGb3IoJ2RyYXdlciBjbG9zZWQgYnkgRXNjJywgYHZhciBzYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhcicpOyB2YXIgcj1zYj9zYi5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTpudWxsO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhciAmJiByLnggPCAwLCBkZXRhaWw6ICd4PScrKHI/TWF0aC5yb3VuZChyLngpOidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgICAgLy8gXHU2MDYyXHU1OTBEXHU1QkJEXHU3QTk3Olx1NEZBN1x1NjgwRlx1NTZERVx1NTIzMCBncmlkIFx1NTIxNyhkaXNwbGF5IFx1OTc1RSBub25lLFx1NkI2M1x1NUUzOFx1NTIxN1x1NUUwM1x1NUM0MClcclxuICAgICAgdHJ5IHsgd2luLnNldEJvdW5kcyh7IHdpZHRoOiAxMjgwLCBoZWlnaHQ6IDgwMCB9KTsgfSBjYXRjaCB7IC8qIGJlc3QgZWZmb3J0ICovIH1cclxuICAgICAgYXdhaXQgc2xlZXAoNDAwKTtcclxuICAgICAgY29uc3Qgd2lkZSA9IGF3YWl0IHdhaXRGb3IoJ3dpZGUgcmVzdG9yZWQnLCBgdmFyIHNiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyJyk7IHZhciByPXNiP3NiLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOm51bGw7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFyICYmIHIud2lkdGggPiAyMDAgJiYgZ2V0Q29tcHV0ZWRTdHlsZShzYikuZGlzcGxheSAhPT0gJ25vbmUnLCBkZXRhaWw6ICd3PScrKHI/TWF0aC5yb3VuZChyLndpZHRoKTonbm9uZScpfTtgLCA1XzAwMCk7XHJcbiAgICAgIHJldHVybiBbb3BlbmVkWzBdICYmIGNsb3NlZFswXSAmJiBlc2NDbG9zZWRbMF0gJiYgd2lkZVswXSwgYG9wZW46ICR7b3BlbmVkWzFdfTsgc2NyaW0tY2xvc2U6ICR7Y2xvc2VkWzFdfTsgZXNjLWNsb3NlOiAke2VzY0Nsb3NlZFsxXX07IHdpZGU6ICR7d2lkZVsxXX1gXTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnXHU2ODA3XHU5ODk4XHU2ODBGOjQ0cHggKyBkcmFnIFx1NTMzQShcdTgzRENcdTUzNTUgbm8tZHJhZztvdmVybGF5IFx1OUFEOFx1NUVBNlx1NEUwMFx1ODFGNCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoYChmdW5jdGlvbigpe1xyXG4gICAgICAgIHZhciB0Yj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudGl0bGViYXInKSwgbWI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnRpdGxlYmFyLW1lbnUnKTtcclxuICAgICAgICBpZighdGIgfHwgIW1iKSByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe29rOmZhbHNlLCBkZXRhaWw6J21pc3NpbmcgdGl0bGViYXIvbWVudSd9KTtcclxuICAgICAgICB2YXIgY3M9Z2V0Q29tcHV0ZWRTdHlsZSh0YiksIG1zPWdldENvbXB1dGVkU3R5bGUobWIpO1xyXG4gICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh7IG9rOiBjcy5oZWlnaHQgPT09ICc0NHB4JyAmJiBjcy53ZWJraXRBcHBSZWdpb24gPT09ICdkcmFnJyAmJiBtcy53ZWJraXRBcHBSZWdpb24gPT09ICduby1kcmFnJyAmJiBtYi5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKS5oZWlnaHQgPj0gMzYsXHJcbiAgICAgICAgICBkZXRhaWw6ICdoPScrY3MuaGVpZ2h0KycgcmVnaW9uPScrY3Mud2Via2l0QXBwUmVnaW9uKycgbWVudS1yZWdpb249Jyttcy53ZWJraXRBcHBSZWdpb24rJyBtZW51LWg9JytNYXRoLnJvdW5kKG1iLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpLmhlaWdodCkgfSk7XHJcbiAgICAgIH0pKClgKSkgYXMgc3RyaW5nO1xyXG4gICAgICBjb25zdCBwID0gSlNPTi5wYXJzZShyKSBhcyB7IG9rOiBib29sZWFuOyBkZXRhaWw6IHN0cmluZyB9O1xyXG4gICAgICAvLyBcdTRFM0JcdThGREJcdTdBMEJcdTRGQTc6XHU1MzlGXHU3NTFGIHRpdGxlQmFyT3ZlcmxheSBcdTlBRDhcdTVFQTZcdTk4N0JcdTU0MENcdTRFM0EgNDQoV2luZG93cyBcdTYyNERcdTY3MDkgb3ZlcmxheTtcdTY1RTdcdTdDN0JcdTU3OEJcdTdGM0FcdTZCNjQgQVBJLFx1NTNFRlx1OTAwOVx1OEMwM1x1NzUyOClcclxuICAgICAgbGV0IG92ZXJsYXkgPSAnbi9hJztcclxuICAgICAgdHJ5IHtcclxuICAgICAgICBjb25zdCBwcm9iZSA9IHdpbiBhcyB1bmtub3duIGFzIHsgZ2V0VGl0bGVCYXJPdmVybGF5PzogKCkgPT4geyBoZWlnaHQ/OiBudW1iZXIgfSB8IG51bGwgfTtcclxuICAgICAgICBjb25zdCBvID0gcHJvYmUuZ2V0VGl0bGVCYXJPdmVybGF5Py4oKSA/PyBudWxsO1xyXG4gICAgICAgIG92ZXJsYXkgPSBvICE9PSBudWxsID8gU3RyaW5nKG8uaGVpZ2h0KSA6ICduL2EnO1xyXG4gICAgICB9IGNhdGNoIHsgLyogXHU1RTczXHU1M0YwXHU2NUUwIG92ZXJsYXkgKi8gfVxyXG4gICAgICByZXR1cm4gW3Aub2sgPT09IHRydWUsIGAke3AuZGV0YWlsfSBvdmVybGF5LWg9JHtvdmVybGF5fWBdO1xyXG4gICAgfSk7XHJcblxyXG4gICAgYXdhaXQgc2hvdCgnZmluYWwnKTtcclxuICB9IGVsc2UgaWYgKChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9XSVpBUkQgPz8gJycpICE9PSAnJykge1xyXG4gICAgLyogPT09PT09PT09PSByZWFsKFx1NTQxMVx1NUJGQ1x1Njc4NFx1OTAyMCxcdTRFOTJcdTY1QTVcdTRFOEVcdTVFMzhcdTg5QzQgcmVhbCBcdTZCNjVcdTlBQTQpOlxyXG4gICAgICAgV1oyIFx1NjcyQ1x1NjczQVx1NzcxRlx1NUI5RVx1NjhDMFx1NkQ0QihcdTlFRDhcdThCQTRcdTUxNzFcdTRFQUJcdTk4NzUpLyBXWjMgXHU0RTBCXHU4RjdEXHU1Qjg5XHU4OEM1XHU1QjlFXHU2RDRCID09PT09PT09PT0gKi9cclxuICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9XSVpBUkQgPT09ICdkZXRlY3QnKSB7XHJcbiAgICAgIGF3YWl0IHN0ZXAoJ1x1NTQxMVx1NUJGQyhcdTc3MUZcdTVCOUUpOlx1NkIyMlx1OEZDRVx1MjE5Mlx1NjhDMFx1NkQ0Qlx1NTIzMFx1NjcyQ1x1NjczQVx1NURGMlx1ODhDNSBDTEkoXHU5RUQ4XHU4QkE0XHU1MTcxXHU0RUFCLFx1NTJGRVx1OTAwOVx1NkI2M1x1Nzg2RSknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3dpemFyZCBvdmVybGF5JywgYHZhciBvPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3ZlcmxheScpO1xyXG4gICAgICAgICAgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NUYwMFx1NTlDQlx1OTE0RFx1N0Y2RSc7fSk7XHJcbiAgICAgICAgICByZXR1cm4ge29rOiAhIW8gJiYgISFiLCBkZXRhaWw6IG8gPyAnb3ZlcmxheStcdTVGMDBcdTU5Q0JcdTkxNERcdTdGNkUnIDogJ25vIG92ZXJsYXknfTtgLCAxMl8wMDApO1xyXG4gICAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgICAgYXdhaXQgc2hvdCgnd2l6YXJkLXJlYWwtd2VsY29tZScpO1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NUYwMFx1NTlDQlx1OTE0RFx1N0Y2RSc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgIGNvbnN0IGZvdW5kID0gYXdhaXQgd2FpdEZvcignZGV0ZWN0IGZvdW5kJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1kZXRlY3QnKTtcclxuICAgICAgICAgIGlmKCFwKSByZXR1cm4ge29rOmZhbHNlLCBkZXRhaWw6J2RldGVjdCBwYWdlIG5vdCBzaG93bid9O1xyXG4gICAgICAgICAgdmFyIHQ9cC50ZXh0Q29udGVudDtcclxuICAgICAgICAgIHZhciBvazE9dC5pbmRleE9mKCdcdTY4QzBcdTZENEJcdTUyMzBcdTVERjJcdTVCODlcdTg4QzUgaG1oYXJuZXNzIHYnKT49MDtcclxuICAgICAgICAgIHZhciBvazI9dC5pbmRleE9mKCdcdTlFRDhcdThCQTRcdTUxNzFcdTRFQUJcdTRGN0ZcdTc1MjhcdTVCODMoXHU2M0E4XHU4MzUwKScpPj0wO1xyXG4gICAgICAgICAgdmFyIHJhZGlvPXAucXVlcnlTZWxlY3RvcignLndpemFyZC1vcHQub24nKTtcclxuICAgICAgICAgIHJldHVybiB7b2s6IG9rMSYmb2syJiYhIXJhZGlvLCBkZXRhaWw6IHQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDkwKX07YCwgMjBfMDAwKTtcclxuICAgICAgICBhd2FpdCBzaG90KCd3aXphcmQtcmVhbC1kZXRlY3QnKTtcclxuICAgICAgICByZXR1cm4gZm91bmQ7XHJcbiAgICAgIH0pO1xyXG4gICAgfSBlbHNlIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9XSVpBUkQgPT09ICdpbnN0YWxsJykge1xyXG4gICAgICBhd2FpdCBzdGVwKCdcdTU0MTFcdTVCRkMoXHU3NzFGXHU1QjlFKTpcdTY4QzBcdTZENEJcdTIxOTJcdTRFQ0RcdTg5ODFcdTRFMEJcdThGN0RcdTY1QjBcdTcyNDhcdTIxOTJcdTkwMDlcdTYyRTlcdTI0NjBcdTIxOTJcdThGREJcdTUxNjVcdTVCODlcdTg4QzVcdTk4NzUnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3dpemFyZCBvdmVybGF5JywgYHZhciBvPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3ZlcmxheScpO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogISFvLCBkZXRhaWw6IG8gPyAnb3BlbicgOiAnY2xvc2VkJ307YCwgMTJfMDAwKTtcclxuICAgICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NUYwMFx1NTlDQlx1OTE0RFx1N0Y2RSc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgIGNvbnN0IGZvdW5kID0gYXdhaXQgd2FpdEZvcignZGV0ZWN0IGZvdW5kJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1kZXRlY3QnKTtcclxuICAgICAgICAgIHJldHVybiB7b2s6ICEhcCAmJiBwLnRleHRDb250ZW50LmluZGV4T2YoJ1x1NjhDMFx1NkQ0Qlx1NTIzMFx1NURGMlx1NUI4OVx1ODhDNSBobWhhcm5lc3MgdicpPj0wLCBkZXRhaWw6IHAgPyBwLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw2MCkgOiAnbm8gZGV0ZWN0IHBhZ2UnfTtgLCAyMF8wMDApO1xyXG4gICAgICAgIGlmICghZm91bmRbMF0pIHJldHVybiBmb3VuZDtcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBvPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vcHQnKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTRFQ0RcdTg5ODFcdTRFMEJcdThGN0RcdTY1QjBcdTcyNDgnKT49MDt9KTsgaWYobykgby5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgYXdhaXQgc2xlZXAoMjAwKTtcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTRFMEJcdTRFMDBcdTZCNjUnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICBjb25zdCBzZWwgPSBhd2FpdCB3YWl0Rm9yKCdzZWxlY3QgcGFnZSBcdTI0NjAgb24nLCBgdmFyIHA9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLXNlbGVjdCcpO1xyXG4gICAgICAgICAgdmFyIG9uPXA/cC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW9wdC5vbicpOm51bGw7XHJcbiAgICAgICAgICByZXR1cm4ge29rOiAhIXAgJiYgISFvbiAmJiBvbi50ZXh0Q29udGVudC5pbmRleE9mKCdcdTRFMEJcdThGN0RcdTVCODlcdTg4QzVcdTVCOENcdTY1NzQgaG1oIENMSScpPj0wLCBkZXRhaWw6IHAgPyAnc2VsZWN0IFx1MjQ2MCBvbicgOiAnbm8gc2VsZWN0J307YCwgOF8wMDApO1xyXG4gICAgICAgIGlmICghc2VsWzBdKSByZXR1cm4gc2VsO1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NUYwMFx1NTlDQlx1NUI4OVx1ODhDNSc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgIHJldHVybiB3YWl0Rm9yKCdpbnN0YWxsIHBhZ2UnLCBgdmFyIHA9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLWluc3RhbGwnKTtcclxuICAgICAgICAgIHJldHVybiB7b2s6ICEhcCwgZGV0YWlsOiBwID8gJ2luc3RhbGxpbmcnIDogJ25vdCBzaG93bid9O2AsIDhfMDAwKTtcclxuICAgICAgfSk7XHJcbiAgICAgIGF3YWl0IHN0ZXAoJ1x1NTQxMVx1NUJGQyhcdTc3MUZcdTVCOUUpOlx1NUI4OVx1ODhDNVx1OEZEQlx1NUVBNlx1NTNFRlx1ODlDMShcdTZCNjVcdTlBQTRcdTY1ODdcdTY4NDgvXHU0RTBCXHU4RjdEXHU3NjdFXHU1MjA2XHU2QkQ0XHU2RURBXHU1MkE4KScsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcigncHJvZ3Jlc3MgdmlzaWJsZScsIGB2YXIgYmFyPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtcHJvZ3Jlc3MnKTtcclxuICAgICAgICAgIHZhciBsb2c9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1pbnN0YWxsLWxvZycpO1xyXG4gICAgICAgICAgdmFyIGxpbmVzPWxvZz9sb2cudGV4dENvbnRlbnQuc3BsaXQoJ1xcXFxuJykuZmlsdGVyKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRyaW0oKSE9PScnO30pOltdO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogISFiYXIgJiYgbGluZXMubGVuZ3RoPj0xLCBkZXRhaWw6ICdiYXI9JysoYmFyPyd5JzonbicpKycgbGluZXM9JytsaW5lcy5sZW5ndGgrKGxpbmVzLmxlbmd0aD4wPygnIGxhc3Q9JysobGluZXNbbGluZXMubGVuZ3RoLTFdfHwnJykuc2xpY2UoMCw1MCkpOicnKX07YCwgNjBfMDAwKTtcclxuICAgICAgICBhd2FpdCBzaG90KCd3aXphcmQtcmVhbC1pbnN0YWxsJyk7XHJcbiAgICAgICAgcmV0dXJuIHc7XHJcbiAgICAgIH0pO1xyXG4gICAgICBhd2FpdCBzdGVwKCdcdTU0MTFcdTVCRkMoXHU3NzFGXHU1QjlFKTpcdTVCODlcdTg4QzVcdTVCOENcdTYyMTBcdTIxOTJcdTkxNERcdTdGNkVcdThERjNcdThGQzcoXHU1REYyXHU2NzA5XHU1QkM2XHU5NEE1KVx1MjE5Mlx1NUI4Q1x1NjIxMFx1OTg3NVx1MjE5Mlx1NUYwMFx1NTlDQlx1NEY3Rlx1NzUyOFx1MjE5Mlx1NjVCMCBydW50aW1lIFx1OEZERVx1NjNBNScsIGFzeW5jICgpID0+IHtcclxuICAgICAgICAvLyBcdTVCODlcdTg4QzVcdTUxNjhcdTdBMEIobnBtIFx1ODlFM1x1Njc5MCtcdTRFMEJcdThGN0QrXHU4NDNEXHU3NkQ4O1x1OTU1Q1x1NTBDRiBucG1taXJyb3IgXHU5MDFBXHU1RTM4IDwyIFx1NTIwNlx1OTQ5RiksXHU0RTBBXHU5NjUwIDggXHU1MjA2XHU5NDlGXHJcbiAgICAgICAgYXdhaXQgd2FpdEZvcignZG9uZSBwYWdlJywgYHZhciBkPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1kb25lJyk7XHJcbiAgICAgICAgICBpZihkKSByZXR1cm4ge29rOnRydWUsIGRldGFpbDonZG9uZSd9O1xyXG4gICAgICAgICAgdmFyIGM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLWNvbmZpZycpO1xyXG4gICAgICAgICAgaWYoYyl7IHZhciBzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1OERGM1x1OEZDNycpPj0wO30pOyBpZihzKSBzLmNsaWNrKCk7IH1cclxuICAgICAgICAgIHZhciBlcnI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1lcnJvcicpO1xyXG4gICAgICAgICAgaWYoZXJyKSByZXR1cm4ge29rOmZhbHNlLCBkZXRhaWw6J2luc3RhbGwgZXJyb3I6ICcrZXJyLnRleHRDb250ZW50LnNsaWNlKDAsODApfTtcclxuICAgICAgICAgIHJldHVybiB7b2s6ZmFsc2UsIGRldGFpbDonaW5zdGFsbGluZ1x1MjAyNid9O2AsIDggKiA2MF8wMDApO1xyXG4gICAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdkb25lIHJlYWR5IHRleHQnLCBgdmFyIGQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLWRvbmUnKTtcclxuICAgICAgICAgIHZhciB0PWQ/ZC50ZXh0Q29udGVudDonJztcclxuICAgICAgICAgIHJldHVybiB7b2s6ICEhZCAmJiB0LmluZGV4T2YoJ1x1NUMzMVx1N0VFQScpPj0wLCBkZXRhaWw6IHQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDYwKX07YCwgMTBfMDAwKTtcclxuICAgICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICAgIGF3YWl0IHNob3QoJ3dpemFyZC1yZWFsLWRvbmUnKTtcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTVGMDBcdTU5Q0JcdTRGN0ZcdTc1MjgnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICBjb25zdCBjb25uZWN0ZWQgPSBhd2FpdCB3YWl0Rm9yKCduZXcgcnVudGltZSBjb25uZWN0ZWQnLCBgdmFyIGRvdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuaG9zdC1kb3Qub24nKTtcclxuICAgICAgICAgIHZhciBsPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ob3N0LWxhYmVsJyk7XHJcbiAgICAgICAgICByZXR1cm4ge29rOiAhIWRvdCAmJiAhIWwgJiYgbC50ZXh0Q29udGVudC5pbmRleE9mKCdydW50aW1lJyk+PTAsIGRldGFpbDogJ2RvdD0nKyhkb3Q/J29uJzonb2ZmJykrJyBsYWJlbD0nKyhsP2wudGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDUwKTonbm9uZScpfTtgLCA2MF8wMDApO1xyXG4gICAgICAgIGNvbnN0IHN0ID0gKGF3YWl0IGpzKGB3aW5kb3cuaG1oLmdldFN0YXRlKCkudGhlbihmdW5jdGlvbihyKXtyZXR1cm4gSlNPTi5zdHJpbmdpZnkoe21vZGU6ci5tb2RlLCBydW50aW1lRW50cnk6ci5ydW50aW1lRW50cnl9KTt9KWApKSBhcyBzdHJpbmc7XHJcbiAgICAgICAgY29uc3QgcCA9IEpTT04ucGFyc2Uoc3QpIGFzIHsgbW9kZT86IHN0cmluZzsgcnVudGltZUVudHJ5Pzogc3RyaW5nIHwgbnVsbCB9O1xyXG4gICAgICAgIGNvbnN0IGVudHJ5T2sgPSAocC5ydW50aW1lRW50cnkgPz8gJycpLmluZGV4T2YoJy5obWhhcm5lc3MtZ2xvYmFsJykgPj0gMDtcclxuICAgICAgICBhd2FpdCBzaG90KCd3aXphcmQtcmVhbC1maW5hbCcpO1xyXG4gICAgICAgIHJldHVybiBbY29ubmVjdGVkWzBdICYmIGVudHJ5T2ssIGBjb25uZWN0ZWQ6ICR7Y29ubmVjdGVkWzFdfTsgc3RhdGU9JHtzdC5zbGljZSgwLCA5MCl9YF07XHJcbiAgICAgIH0pO1xyXG4gICAgfVxyXG4gICAgYXdhaXQgc2hvdCgnZmluYWwnKTtcclxuICB9IGVsc2Uge1xyXG4gICAgLyogPT09PT09PT09PSByZWFsOlx1NTNFQVx1OEJGQlx1NUI1MFx1OTZDNihcdTRFMERcdTUyQThcdTc3MUZcdTVCOUVcdTRGMUFcdThCREQpID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1OTg3Nlx1NjgwRjpydW50aW1lIFx1NzI0OFx1NjcyQ1x1NEUwRVx1N0FFRlx1NTNFM1x1NURGMlx1NjYzRVx1NzkzQShcdTk3NUUgPyknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdob3N0IGxhYmVsJywgYHZhciBsPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ob3N0LWxhYmVsJyk7XHJcbiAgICAgICAgdmFyIHQgPSBsID8gbC50ZXh0Q29udGVudCA6ICcnO1xyXG4gICAgICAgIHJldHVybiB7b2s6IHQuaW5kZXhPZignPycpIDwgMCAmJiB0LmluZGV4T2YoJ3J1bnRpbWUnKSA+PSAwLCBkZXRhaWw6IHQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDYwKX07YCwgMTVfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnXHU0RjFBXHU4QkREXHU1MjE3XHU4ODY4Olx1NzcxRlx1NUI5RVx1NTM4Nlx1NTNGMlx1NTJBMFx1OEY3RChcdTY1NzBcdTkxQ0Y+MCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdzZXNzaW9ucycsIGB2YXIgbj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoO1xyXG4gICAgICAgIHJldHVybiB7b2s6IG4gPiAwLCBkZXRhaWw6ICdzZXNzaW9ucz0nK259O2AsIDE1XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ1x1NzBCOVx1NTFGQlx1NTM4Nlx1NTNGMlx1NEYxQVx1OEJERCBcdTIxOTIgXHU3NzFGXHU1QjlFIHRyYW5zY3JpcHQgXHU1MTg1XHU1QkI5XHU1M0VGXHU4OUMxJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCBuID0gKGF3YWl0IGpzKGBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoYCkpIGFzIG51bWJlcjtcclxuICAgICAgaWYgKG4gPT09IDApIHJldHVybiBbZmFsc2UsICdubyBzZXNzaW9ucyB0byBjbGljayddO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBpdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2Vzc2lvbi1pdGVtJyk7IGlmIChpdCkgaXQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignaGlzdG9yeSB0dXJucycsIGB2YXIgdHM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudHVybicpKTtcclxuICAgICAgICByZXR1cm4ge29rOiB0cy5sZW5ndGggPj0gMSwgZGV0YWlsOiAndHVybnM9Jyt0cy5sZW5ndGgrJyBmaXJzdD0nKyh0c1swXT90c1swXS50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNDApOidub25lJyl9O2AsIDE1XzAwMCk7XHJcbiAgICAgIGF3YWl0IHNob3QoJ3JlYWwtaGlzdG9yeScpO1xyXG4gICAgICByZXR1cm4gdztcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnRG9jazpPdmVydmlldyBcdTc3MUZcdTVCOUVcdTY1NzBcdTYzNkUocnVudGltZSBcdTcyNDhcdTY3MkNcdTk3NUVcdTY1RTBcdTY1NzBcdTYzNkUpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nT3ZlcnZpZXcnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ292ZXJ2aWV3JywgYHZhciByb3dzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stcm93JykpO1xyXG4gICAgICAgIHZhciB2ZXIgPSByb3dzLmZpbmQoZnVuY3Rpb24ocil7IHJldHVybiByLnRleHRDb250ZW50LmluZGV4T2YoJ3J1bnRpbWUgXHU3MjQ4XHU2NzJDJyk+PTA7IH0pO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhdmVyICYmIHZlci50ZXh0Q29udGVudC5pbmRleE9mKCdcdTY1RTBcdTY1NzBcdTYzNkUnKSA8IDAsIGRldGFpbDogdmVyID8gdmVyLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw1MCkgOiAnbm8gdmVyIHJvdyd9O2AsIDEwXzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ0RvY2s6RGlmZiBcdTc3MUZcdTVCOUUgZ2l0IFx1NzJCNlx1NjAwMShcdTk3NUVcdTUyQTBcdThGN0RcdTRFMkQpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nXHU1M0Q4XHU2NkY0J3x8eC50ZXh0Q29udGVudD09PSdEaWZmJzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdkaWZmJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5kaWZmLXBhbmUnKTtcclxuICAgICAgICB2YXIgdCA9IHAgPyBwLnRleHRDb250ZW50IDogJyc7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFwICYmIHQuaW5kZXhPZignXHU1MkEwXHU4RjdEXHU0RTJEJykgPCAwLCBkZXRhaWw6IHQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDYwKX07YCwgMTVfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnRG9jazpFdmlkZW5jZSBcdTc3MUZcdTVCOUVcdThCQTRcdTc3RTVcdTY1NzBcdTYzNkUnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdcdThCQzFcdTYzNkUnfHx4LnRleHRDb250ZW50PT09J0V2aWRlbmNlJzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdldmlkZW5jZScsIGB2YXIgcm93cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXJvdycpKTtcclxuICAgICAgICB2YXIgbWVtID0gcm93cy5maW5kKGZ1bmN0aW9uKHIpeyByZXR1cm4gci50ZXh0Q29udGVudC5pbmRleE9mKCdcdThCQjBcdTVGQzZcdTVDNDInKT49MCB8fCByLnRleHRDb250ZW50LmluZGV4T2YoJ01lbW9yeSBsYXllcnMnKT49MDsgfSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFtZW0gJiYgbWVtLnRleHRDb250ZW50LmluZGV4T2YoJ1x1MjAyNicpIDwgMCwgZGV0YWlsOiBtZW0gPyBtZW0udGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDUwKSA6ICdubyByb3cnfTtgLCAxNV8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdcdTk2NDRcdTRFRjZcdTRFMEVcdTc2RUVcdTVGNTVcdTUxNjVcdTUzRTM6XHVEODNEXHVEQ0NFIFx1NEUwQVx1NEYyMCArIFx1OTg3Nlx1NjgwRlx1NEUyRC9FTiArIFx1RDgzRFx1RENDMSBcdTZENEZcdTg5QzhcdTYzMDlcdTk0QUVcdTVCNThcdTU3MjgnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdcdTY1ODdcdTRFRjYnfHx4LnRleHRDb250ZW50PT09J0ZpbGVzJzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGF3YWl0IHdhaXRGb3IoJ2ZpbGVzIHRhYicsIGB2YXIgdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuZG9jay10YWIuYWN0aXZlJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISF0ICYmICh0LnRleHRDb250ZW50PT09J1x1NjU4N1x1NEVGNid8fHQudGV4dENvbnRlbnQ9PT0nRmlsZXMnKSwgZGV0YWlsOiAnYWN0aXZlPScrKHQ/dC50ZXh0Q29udGVudDonbm9uZScpfTtgLCA1XzAwMCk7XHJcbiAgICAgIC8vIHJlYWwgXHU2QTIxXHU1RjBGIHdvcmtzcGFjZXMgXHU4QkY3XHU2QzQyXHU4RDcwIHJ1bnRpbWUoXHU1MUI3XHU1NDJGXHU1MkE4XHU1NDBFXHU1M0VGXHU4MEZEXHU2MzkyXHU5NjFGKSxcdTY1M0VcdTVCQkRcdTUyMzAgMTVzXHJcbiAgICAgIGNvbnN0IHdzID0gYXdhaXQgd2FpdEZvcignd3MgcGlja2VyJywgYHZhciB3PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1waWNrZXInKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXcsIGRldGFpbDogdyA/ICdsb2FkZWQnIDogJ3dvcmtzcGFjZXMgbm90IGxvYWRlZCB5ZXQnfTtgLCBtb2RlID09PSAncmVhbCcgPyAxNV8wMDAgOiA2XzAwMCk7XHJcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoYChmdW5jdGlvbigpe1xyXG4gICAgICAgIHZhciB1cCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jb21wb3NlciBidXR0b25bYXJpYS1sYWJlbCo9XCJcdTRFMEFcdTRGMjBcIl0sIC5jb21wb3NlciBidXR0b25bYXJpYS1sYWJlbCo9XCJVcGxvYWRcIl0nKTtcclxuICAgICAgICB2YXIgbGFuZyA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5sYW5nLXNlZycpO1xyXG4gICAgICAgIHZhciBiciA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1waWNrZXIgYnV0dG9uJyk7XHJcbiAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHt1cDogISF1cCwgbGFuZzogISFsYW5nLCBicm93c2U6ICEhYnJ9KTtcclxuICAgICAgfSkoKWApKSBhcyBzdHJpbmc7XHJcbiAgICAgIGNvbnN0IHAgPSBKU09OLnBhcnNlKHIpIGFzIHsgdXA6IGJvb2xlYW47IGxhbmc6IGJvb2xlYW47IGJyb3dzZTogYm9vbGVhbiB9O1xyXG4gICAgICByZXR1cm4gW3AudXAgJiYgcC5sYW5nICYmIHAuYnJvd3NlLCBgXHVEODNEXHVEQ0NFPSR7cC51cH0gXHU0RTJEL0VOPSR7cC5sYW5nfSBcdUQ4M0RcdURDQzE9JHtwLmJyb3dzZX07ICR7d3NbMV19YF07XHJcbiAgICB9KTtcclxuICAgIC8qID09PT09PT09PT0gcmVhbDpcdTc3MUZcdTVCOUVcdTRFRkJcdTUyQTFcdTdBRUZcdTUyMzBcdTdBRUZcdTk5OTZcdTlBOEMoXHU1M0QxXHU3N0VEXHU0RUZCXHU1MkExXHUyMTkyXHU2QTIxXHU1NzhCXHU1NkRFXHU1OTBEKSA9PT09PT09PT09XHJcbiAgICAgICBcdTc1MjhcdTYyMzcgZ2xtLTUuMyBcdTVERjJcdTkxNERcdTdGNkU7XHU2M0QwXHU3OTNBXHU4QkNEXHU3RUE2XHU2NzVGXHU3NkY0XHU2M0E1XHU1NkRFXHU1OTBEXHUzMDAyXHU4MkU1IGFnZW50IFx1OEJGN1x1NkM0Mlx1NUJBMVx1NjI3OSxcdThGNkVcdThCRTJcdTkxQ0NcclxuICAgICAgIFx1ODFFQVx1NTJBOFx1NzBCOVx1NjI3OVx1NTFDNihcdTY3MDBcdTU5MUFcdTg5QzFcdTUzNjFcdTUzNzNcdTcwQjksXHU1RTQyXHU3QjQ5KVx1MzAwMlx1OEQ4NVx1NjVGNiAxNTBzXHUzMDAyICovXHJcbiAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfUkVBTF9UQVNLID09PSAnMScpIHtcclxuICAgICAgYXdhaXQgc3RlcCgnXHU3NzFGXHU1QjlFXHU0RUZCXHU1MkExOlx1NTNEMVx1OTAwMVx1MjE5Mlx1NkEyMVx1NTc4Qlx1NTZERVx1NTkwRChcdTdBRUZcdTUyMzBcdTdBRUZcdTk5OTZcdTlBOEMpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J24nLCBjdHJsS2V5OnRydWUsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICAgIGF3YWl0IHNsZWVwKDQwMCk7XHJcbiAgICAgICAgYXdhaXQgdHlwZUludG8oJy5jb21wb3NlciB0ZXh0YXJlYScsICdcdThCRjdcdTUzRUFcdTU2REVcdTU5MERcdTRFMjRcdTRFMkFcdTVCNTc6XHU2NTM2XHU1MjMwKFx1NjcyQ1x1NkIyMVx1OUE4Q1x1NjUzNlx1NEVGQlx1NTJBMSxcdTRFMERcdTg5ODFcdTRGN0ZcdTc1MjhcdTRFRkJcdTRGNTVcdTVERTVcdTUxNzcsXHU3NkY0XHU2M0E1XHU1NkRFXHU1OTBEKScpO1xyXG4gICAgICAgIGF3YWl0IHNsZWVwKDIwMCk7XHJcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jb21wb3NlciBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1M0QxXHU5MDAxJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgY29uc3Qgc2VudCA9IGF3YWl0IHdhaXRGb3IoJ3VzZXIgdHVybicsIGB2YXIgdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudHVybi51c2VyJyk7XHJcbiAgICAgICAgICB2YXIgcyA9ICh0ICYmIHQudGV4dENvbnRlbnQpID8gU3RyaW5nKHQudGV4dENvbnRlbnQpIDogJyc7XHJcbiAgICAgICAgICByZXR1cm4ge29rOiBzLmluZGV4T2YoJ1x1NjUzNlx1NTIzMCcpPj0wIHx8IHMuaW5kZXhPZignXHU5QThDXHU2NTM2XHU0RUZCXHU1MkExJyk+PTAsIGRldGFpbDogcy5zbGljZSgwLDMwKSB8fCAnbm9uZSd9O2AsIDEwXzAwMCk7XHJcbiAgICAgICAgaWYgKCFzZW50WzBdKSByZXR1cm4gc2VudDtcclxuICAgICAgICBjb25zdCByZXBseSA9IGF3YWl0IHdhaXRGb3IoJ2Fzc2lzdGFudCByZXBseScsIGBcclxuICAgICAgICAgIHZhciBhcCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5hcHByb3ZhbC1jYXJkIGJ1dHRvbicpO1xyXG4gICAgICAgICAgaWYgKGFwICYmIGFwLnRleHRDb250ZW50LnRyaW0oKS5pbmRleE9mKCdcdTYyNzlcdTUxQzYnKT49MCkgYXAuY2xpY2soKTtcclxuICAgICAgICAgIHZhciB0cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50dXJuJykpLmZpbHRlcihmdW5jdGlvbih4KXsgcmV0dXJuIHguY2xhc3NOYW1lLmluZGV4T2YoJ3VzZXInKTwwICYmIHguY2xhc3NOYW1lLmluZGV4T2YoJ2FwcHJvdmFsJyk8MCAmJiB4LmNsYXNzTmFtZS5pbmRleE9mKCdzeXN0ZW0nKTwwICYmIHgudGV4dENvbnRlbnQudHJpbSgpLmxlbmd0aD4wICYmIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU1NkRFXHU1NDA4Jyk8MDsgfSk7XHJcbiAgICAgICAgICB2YXIgc3VtID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnR1cm4tc3VtJyk7XHJcbiAgICAgICAgICByZXR1cm4ge29rOiB0cy5sZW5ndGg+PTEgJiYgISFzdW0sIGRldGFpbDogJ2Fzc2lzdGFudD0nK3RzLmxlbmd0aCsnIHN1bT0nKyhzdW0/c3VtLnRleHRDb250ZW50Oidub25lJykrJyBmaXJzdD0nKyh0c1swXT90c1swXS50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNDApOidub25lJyl9O1xyXG4gICAgICAgIGAsIDE1MF8wMDApO1xyXG4gICAgICAgIGF3YWl0IHNob3QoJ3JlYWwtdGFzaycpO1xyXG4gICAgICAgIHJldHVybiByZXBseTtcclxuICAgICAgfSk7XHJcbiAgICB9XHJcbiAgICBhd2FpdCBzdGVwKCdcdTRGMUFcdThCRERcdTUyMDZcdTdFQzQ6XHU1REU2XHU2ODBGXHU2MzA5XHU1REU1XHU0RjVDXHU1MzNBXHU1MjA2XHU3RUM0KFx1N0VDNFx1NTkzNFx1NTNFRlx1ODlDMSknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdncm91cCBoZWFkJywgYHZhciBoPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1ncm91cC1oZWFkJyk7XHJcbiAgICAgICAgdmFyIG4gPSBoID8gKGgucXVlcnlTZWxlY3RvcignLndzLWdyb3VwLW5hbWUnKXx8e30pLnRleHRDb250ZW50IDogJyc7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFoICYmIG4ubGVuZ3RoID4gMCwgZGV0YWlsOiAnbmFtZT0nK259O2AsIDE1XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ1x1NURFNVx1NEY1Q1x1NTMzQTpcdTVERTZcdTY4MEZcdTVERTVcdTRGNUNcdTUzM0FcdTY4MEZcdTUzRUZcdTg5QzEoXHU3NzFGXHU1QjlFXHU1REU1XHU0RjVDXHU1MzNBXHU1NDBEKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ3dvcmtzcGFjZSBiYXInLCBgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndvcmtzcGFjZS1iYXInKTtcclxuICAgICAgICB2YXIgbiA9IGIgPyAoYi5xdWVyeVNlbGVjdG9yKCcud3MtYmFyLW5hbWUnKXx8e30pLnRleHRDb250ZW50IDogJyc7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFiICYmICEhbiAmJiBuLmxlbmd0aCA+IDAgJiYgbi5pbmRleE9mKCdcdTUyQTBcdThGN0QnKSA8IDAgJiYgbi5pbmRleE9mKCdMb2FkaW5nJykgPCAwLCBkZXRhaWw6ICduYW1lPScrbn07YCwgMTVfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc2hvdCgnZmluYWwnKTtcclxuICB9XHJcblxyXG4gIGNvbnN0IGZhaWxlZCA9IHJlc3VsdHMuZmlsdGVyKChyKSA9PiAhclsxXSkubGVuZ3RoO1xyXG4gIGNvbnNvbGUubG9nKGBVSVZFUklGWSBTVU1NQVJZIHBhc3M9JHtyZXN1bHRzLmxlbmd0aCAtIGZhaWxlZH0vJHtyZXN1bHRzLmxlbmd0aH0gbW9kZT0ke21vZGV9IHNob3RzPSR7c2hvdHN9YCk7XHJcbiAgYXBwLmV4aXQoZmFpbGVkID09PSAwID8gMCA6IDEpO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gYXR0YWNoVWlWZXJpZnkod2luOiBCcm93c2VyV2luZG93KTogdm9pZCB7XHJcbiAgY29uc3QgbW9kZSA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX01PREUgPT09ICdyZWFsJyA/ICdyZWFsJyA6ICdmYWtlJztcclxuICB3aW4ud2ViQ29udGVudHMub25jZSgnZGlkLWZpbmlzaC1sb2FkJywgKCkgPT4ge1xyXG4gICAgLy8gXHU3RUQ5IGhvc3QgXHU1NDJGXHU1MkE4XHU3NTU5XHU2NUY2XHU5NUY0O1x1NkI2NVx1OUFBNFx1NTE4NVx1OTBFOFx1NTQwNFx1ODFFQVx1OEY2RVx1OEJFMlx1N0I0OVx1NUY4NVxyXG4gICAgc2V0VGltZW91dCgoKSA9PiB7IHZvaWQgcnVuVWlWZXJpZnkod2luLCBtb2RlKTsgfSwgM18wMDApO1xyXG4gIH0pO1xyXG59XHJcbiIsICIvKipcclxuICogXHU4OUM2XHU4OUM5XHU1NkRFXHU1RjUyXHU2MjJBXHU1NkZFXHU5NEE5XHU1QjUwIFx1MjAxNFx1MjAxNCBcdTc4NkVcdTVCOUFcdTYwMjdcdTg5QzZcdTUzRTNcdTYyMkFcdTU2RkUsXHU0RjlCIHNjcmlwdHMvdmlzdWFsLXJlZ3Jlc3Npb24ubWpzIFx1NTA1QVx1NTBDRlx1N0QyMCBkaWZmXHUzMDAyXHJcbiAqXHJcbiAqIFx1NEUwRSB1aS12ZXJpZnkgXHU1NDBDXHU2NUNGKFx1OTZGNlx1N0IyQ1x1NEUwOVx1NjVCOVx1NEY5RFx1OEQ1NiksXHU0RjQ2XHU3NkVFXHU2ODA3XHU2NjJGXCJcdTU0MENcdTRFMDBcdThGOTNcdTUxNjUgXHUyMTkyIFx1OTAxMFx1NUI1N1x1ODI4Mlx1NTNFRlx1NkJENFx1NzY4NFx1NTZGRVwiOlxyXG4gKiAgLSBcdTdBOTdcdTUzRTNcdTVGNTJcdTRFMDAgMTI4MFx1MDBENzgwMDtcdTRFM0JcdTk4OTgvXHU4QkVEXHU4QTAwXHU1NkZBXHU1QjlBKGxpZ2h0ICsgXHU1RjUzXHU1MjREIGxvY2FsZSBcdTlFRDhcdThCQTQsXHU1MTk5IGxvY2FsU3RvcmFnZSBcdTU0MEUgcmVsb2FkKVxyXG4gKiAgLSBmYWtlIGhvc3QoSE1IX0RFU0tUT1BfVklTUkVHPTEgXHU2NUY2IG1haW4gXHU1REYyXHU1RjNBXHU1MjM2IGZha2UpOlx1N0E3QVx1NEYxQVx1OEJERC9cdTU2RkFcdTVCOUFcdTVERTVcdTRGNUNcdTUzM0FcdTRFMEUgcHJvdmlkZXJcclxuICogIC0gXHU0RTA5XHU4OUM2XHU1M0UzOm1haW4oXHU0RjFBXHU4QkREXHU0RTNCXHU3NTRDXHU5NzYyXHU3QTdBXHU2MDAxKS8gc2V0dGluZ3MoXHU4QkJFXHU3RjZFXHU1RjM5XHU1QzQyKS8gZG9jayhGaWxlcyBcdTZENEZcdTg5QzgpXHJcbiAqICAtIFx1NTJBOFx1NjAwMVx1NTMzQSBtYXNrOlx1NTJBOFx1NjAwMVx1N0FFRlx1NTNFMy9cdTY1RjZcdTk1RjRcdTYyMzMvXHU4QkExXHU2NTcwXHU3QjQ5XHU1MTQzXHU3RDIwXHU2MzA5IGJvdW5kaW5nIGJveCBcdThCQjBcdTUxNjUgbWV0YS5qc29uLFxyXG4gKiAgICBcdTUwQ0ZcdTdEMjAgZGlmZiBcdTY1RjZcdThERjNcdThGQzcoXHU1NzUwXHU2ODA3XHU1REYyXHU2MzA5IGNhcHR1cmVQYWdlIFx1NUI5RVx1OTY0NVx1NUMzQVx1NUJGOCBcdTAwRDcgZGV2aWNlUGl4ZWxSYXRpbyBcdTYzNjJcdTdCOTcpXHJcbiAqICAtIEhNSF9ERVNLVE9QX1ZJU1JFR19NVVRBVEU9PHZpZXdwb3J0PjpcdTU3MjhcdThCRTVcdTg5QzZcdTUzRTNcdTZDRThcdTUxNjVcdTU2RkFcdTVCOUFcdTgyNzJcdTU3NTcsXHU3NTI4XHU0RThFXHU3QkExXHU3RUJGXHU4MUVBXHU2OEMwXHJcbiAqICAgIChiYXNlbGluZSBcdTgxRUFcdTZCRDQgMCBcdTVERUVcdTVGMDIgKyBcdTY1NDVcdTYxMEZcdTY1MzlcdTUyQThcdTVGQzUgRkFJTCxcdThCQzFcdTY2MEVcdTk2MDhcdTUwM0NcdTRFMEUgZGlmZiBcdTU2RkVcdTc3MUZcdTVCOUVcdTVERTVcdTRGNUMpXHJcbiAqIGVudjpITUhfREVTS1RPUF9WSVNSRUc9MShcdTVGMDBcdTUxNzMpLyBITUhfREVTS1RPUF9WSVNSRUdfT1VUPTxkaXI+KFx1OEY5M1x1NTFGQVx1NzZFRVx1NUY1NSlcclxuICovXHJcbmltcG9ydCB7IGFwcCwgdHlwZSBCcm93c2VyV2luZG93IH0gZnJvbSAnZWxlY3Ryb24nO1xyXG5pbXBvcnQgeyBta2Rpciwgd3JpdGVGaWxlIH0gZnJvbSAnbm9kZTpmcy9wcm9taXNlcyc7XHJcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdub2RlOnBhdGgnO1xyXG5cclxuY29uc3Qgc2xlZXAgPSAobXM6IG51bWJlcik6IFByb21pc2U8dm9pZD4gPT4gbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgbXMpKTtcclxuXHJcbi8qKiBcdTUyQThcdTYwMDFcdTUzM0FcdTU3REYoXHU2QkNGXHU2QjIxXHU4RkQwXHU4ODRDXHU1RkM1XHU1M0Q4XHU3Njg0XHU1MTg1XHU1QkI5KVx1MjE5MiBtYXNrIFx1OTAwOVx1NjJFOVx1NTY2ODtcdTk3NTlcdTYwMDFcdTdFRDNcdTY3ODRcdTRFMEQgbWFzayxkaWZmIFx1NjI0RFx1NjcwOVx1NjEwRlx1NEU0OSAqL1xyXG5jb25zdCBNQVNLX1NFTEVDVE9SUzogQXJyYXk8eyBzZWw6IHN0cmluZzsgcmVhc29uOiBzdHJpbmcgfT4gPSBbXHJcbiAgeyBzZWw6ICcuaG9zdC1sYWJlbCcsIHJlYXNvbjogJ2hvc3QgXHU3QUVGXHU1M0UzL1x1NzI0OFx1NjcyQyhmYWtlIGhvc3QgXHU2QkNGXHU2QjIxXHU5NjhGXHU2NzNBXHU3QUVGXHU1M0UzKScgfSxcclxuICB7IHNlbDogJy5zZXNzaW9uLXRpbWUnLCByZWFzb246ICdcdTRGMUFcdThCRERcdTY1RjZcdTk1RjRcdTYyMzMnIH0sXHJcbiAgeyBzZWw6ICcudHVybi1zdW0nLCByZWFzb246ICdcdTU2REVcdTU0MDgvdG9rZW4gXHU4QkExXHU2NTcwJyB9LFxyXG5dO1xyXG5cclxuLyoqIFx1NTZGQVx1NUI5QVx1ODlDNlx1NTNFMzpcdTg5ODZcdTc2RDZcdTRFMDlcdTY4MEZcdTVFMDNcdTVDNDBcdTRFMEVcdTVFOTVcdTkwRTggZG9jayBcdTc2ODRcdTUyMDZcdTY1MkYsXHU1NDBDXHU2NUY2XHU4RkRDXHU3OUJCIDgyMC8xMTAwIFx1NjVBRFx1NzBCOSAqL1xyXG5jb25zdCBWSUVXUE9SVF9XID0gMTI4MDtcclxuY29uc3QgVklFV1BPUlRfSCA9IDgwMDtcclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHJ1blZpc3VhbFJlZ3Jlc3Npb24od2luOiBCcm93c2VyV2luZG93KTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgY29uc3Qgb3V0ID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVklTUkVHX09VVCA/PyBqb2luKGFwcC5nZXRQYXRoKCd0ZW1wJyksICdobWgtdmlzcmVnJyk7XHJcbiAgY29uc3QgbXV0YXRlID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVklTUkVHX01VVEFURSA/PyAnJztcclxuICBhd2FpdCBta2RpcihvdXQsIHsgcmVjdXJzaXZlOiB0cnVlIH0pLmNhdGNoKCgpID0+IHVuZGVmaW5lZCk7XHJcbiAgY29uc3QganMgPSA8VD4oY29kZTogc3RyaW5nKTogUHJvbWlzZTxUPiA9PiB3aW4ud2ViQ29udGVudHMuZXhlY3V0ZUphdmFTY3JpcHQoY29kZSwgdHJ1ZSkgYXMgUHJvbWlzZTxUPjtcclxuICBjb25zdCB3YWl0Rm9yID0gYXN5bmMgKGxhYmVsOiBzdHJpbmcsIHByZWRpY2F0ZUNvZGU6IHN0cmluZywgdGltZW91dE1zOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+ID0+IHtcclxuICAgIGNvbnN0IHN0YXJ0ZWQgPSBEYXRlLm5vdygpO1xyXG4gICAgZm9yICg7Oykge1xyXG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdHJ5IHsgcmV0dXJuIEpTT04uc3RyaW5naWZ5KChmdW5jdGlvbigpeyAke3ByZWRpY2F0ZUNvZGV9IH0pKCkpOyB9IGNhdGNoKGUpeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe29rOmZhbHNlLCBkZXRhaWw6U3RyaW5nKGUpLnNsaWNlKDAsMTIwKX0pOyB9IH0pKClgKSkgYXMgc3RyaW5nO1xyXG4gICAgICBsZXQgcGFyc2VkOiB7IG9rPzogYm9vbGVhbiB9O1xyXG4gICAgICB0cnkgeyBwYXJzZWQgPSBKU09OLnBhcnNlKHIpIGFzIHsgb2s/OiBib29sZWFuIH07IH0gY2F0Y2ggeyBwYXJzZWQgPSB7fTsgfVxyXG4gICAgICBpZiAocGFyc2VkLm9rID09PSB0cnVlKSByZXR1cm47XHJcbiAgICAgIGlmIChEYXRlLm5vdygpIC0gc3RhcnRlZCA+IHRpbWVvdXRNcykge1xyXG4gICAgICAgIGNvbnNvbGUubG9nKGBWSVNSRUctQ0FQVFVSRSBGQUlMIHwgd2FpdCAke2xhYmVsfSB0aW1lb3V0YCk7XHJcbiAgICAgICAgYXBwLmV4aXQoMSk7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgICB9XHJcbiAgICAgIGF3YWl0IHNsZWVwKDI1MCk7XHJcbiAgICB9XHJcbiAgfTtcclxuXHJcbiAgLy8gMCkgXHU3QTk3XHU1M0UzXHU1RjUyXHU0RTAwOlx1NUMzQVx1NUJGOFx1NTZGQVx1NUI5QShcdTRGNERcdTdGNkVcdTRGRERcdTYzMDFcdTc1MjhcdTYyMzdcdTY4NENcdTk3NjJcdTRFMEFcdTc2ODQpO1x1NEUzQlx1OTg5OFx1NkQ0NVx1ODI3MiArIFx1NEUyRFx1NjU4NyxcdTUxOTlcdTUwNEZcdTU5N0RcdTU0MEUgcmVsb2FkIFx1NzUxRlx1NjU0OFxyXG4gIHRyeSB7IHdpbi5zZXRCb3VuZHMoeyB3aWR0aDogVklFV1BPUlRfVywgaGVpZ2h0OiBWSUVXUE9SVF9IIH0pOyB9IGNhdGNoIHsgLyogXHU2NzAwXHU1QzBGXHU1QzNBXHU1QkY4XHU1MTVDXHU1RTk1ICovIH1cclxuICBhd2FpdCBzbGVlcCg0MDApO1xyXG4gIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdHJ5IHsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oJ2htaC50aGVtZScsICdsaWdodCcpOyBsb2NhbFN0b3JhZ2Uuc2V0SXRlbSgnaG1oLmxvY2FsZScsICd6aCcpOyB9IGNhdGNoIChlKSB7fSByZXR1cm4gJ29rJzsgfSkoKWApO1xyXG4gIHdpbi53ZWJDb250ZW50cy5yZWxvYWQoKTtcclxuICBhd2FpdCB3YWl0Rm9yKCdtb3VudGVkJywgYHZhciB0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jb21wb3NlciB0ZXh0YXJlYScpOyByZXR1cm4ge29rOiAhIXQsIGRldGFpbDogdCA/ICd1cCcgOiAnZG93bid9O2AsIDIwXzAwMCk7XHJcbiAgYXdhaXQgd2FpdEZvcignaG9zdCBkb3Qgb24nLCBgdmFyIGQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmhvc3QtZG90Jyk7IHJldHVybiB7b2s6ICEhZCAmJiBkLmNsYXNzTGlzdC5jb250YWlucygnb24nKSwgZGV0YWlsOiBkID8gZC5jbGFzc05hbWUgOiAnbm9uZSd9O2AsIDMwXzAwMCk7XHJcbiAgYXdhaXQgc2xlZXAoMV8yMDApOyAvLyBcdTRGMUFcdThCRERcdTUyMTdcdTg4NjgvXHU5ODc2XHU2ODBGXHU2NTcwXHU2MzZFXHU4NDNEXHU1NzMwXHJcblxyXG4gIC8vIDEpIFx1NTE3M1x1NjM4OSBmYWtlIFx1NkYxNFx1NzkzQVx1NUYxNVx1NUJGQ1x1NUM0MihcdTkwNkVcdTdGNjlcdTVGMzlcdTVDNDJcdTRFMERcdTVDNUVcdTRFOEVcdTg4QUJcdTZENEJcdTg5QzZcdTUzRTM7XHU0RTBEXHU0RjlEXHU4RDU2XHU2NTg3XHU2ODQ4LFx1NjMwOVx1N0VEM1x1Njc4NFx1NTNENiBnaG9zdCBcdTYzMDlcdTk0QUUpXHJcbiAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgZz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcucnVudGltZS1ndWlkZScpOyBpZighZykgcmV0dXJuICduby1ndWlkZSc7XHJcbiAgICB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcucnVudGltZS1ndWlkZS1hY3Rpb25zIC5idG4uZ2hvc3QnKTsgaWYoYikgYi5jbGljaygpOyByZXR1cm4gJ2Rpc21pc3NlZCc7IH0pKClgKTtcclxuICBhd2FpdCB3YWl0Rm9yKCdndWlkZSBjbG9zZWQnLCBgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ydW50aW1lLWd1aWRlJyksIGRldGFpbDogJ2Nsb3NlZCd9O2AsIDVfMDAwKTtcclxuXHJcbiAgLy8gMikgXHU4OUM2XHU1M0UzXHU1RThGXHU1MjE3Om1haW4oXHU3QTdBXHU2MDAxXHU0RTNCXHU3NTRDXHU5NzYyKVx1MjE5MiBzZXR0aW5ncyhcdThCQkVcdTdGNkVcdTVGMzlcdTVDNDIpXHUyMTkyIGRvY2soRmlsZXMgXHU2RDRGXHU4OUM4KVxyXG4gIGNvbnN0IHZpZXdwb3J0czogQXJyYXk8eyBuYW1lOiBzdHJpbmc7IHNldHVwOiAoKSA9PiBQcm9taXNlPHZvaWQ+IH0+ID0gW1xyXG4gICAgeyBuYW1lOiAnbWFpbicsIHNldHVwOiBhc3luYyAoKSA9PiB7IC8qIFx1NTQyRlx1NTJBOFx1OUVEOFx1OEJBNFx1NjAwMTpcdTdBN0FcdTRGMUFcdThCREQgKyBPdmVydmlldyBkb2NrICovIH0gfSxcclxuICAgIHtcclxuICAgICAgbmFtZTogJ3NldHRpbmdzJyxcclxuICAgICAgc2V0dXA6IGFzeW5jICgpID0+IHtcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywgeyBrZXk6ICdwJywgY3RybEtleTogdHJ1ZSwgc2hpZnRLZXk6IHRydWUsIGJ1YmJsZXM6IHRydWUgfSkpOyB9KSgpYCk7XHJcbiAgICAgICAgYXdhaXQgd2FpdEZvcignc2V0dGluZ3Mgb3BlbicsIGByZXR1cm4ge29rOiAhIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrLnNldHRpbmdzJyksIGRldGFpbDogJ29wZW4nfTtgLCA1XzAwMCk7XHJcbiAgICAgIH0sXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBuYW1lOiAnZG9jaycsXHJcbiAgICAgIHNldHVwOiBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHsga2V5OiAnRXNjYXBlJywgYnViYmxlczogdHJ1ZSB9KSk7IH0pKClgKTtcclxuICAgICAgICBhd2FpdCB3YWl0Rm9yKCdzZXR0aW5ncyBjbG9zZWQnLCBgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrLnNldHRpbmdzJyksIGRldGFpbDogJ2Nsb3NlZCd9O2AsIDVfMDAwKTtcclxuICAgICAgICAvLyBGaWxlcyB0YWI6XHU2MzA5IGRvY2stdGFiIFx1OTg3QVx1NUU4Rlx1N0IyQyAyIFx1NEUyQShPdmVydmlldy9GaWxlcy9cdTIwMjYpLFx1OTA3Rlx1NTE0RFx1NEY5RFx1OEQ1Nlx1NjU4N1x1Njg0OFxyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJylbMV07IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgIGF3YWl0IHdhaXRGb3IoJ2ZpbGVzIHJvd3MnLCBgdmFyIHI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmZzLXJvdycpOyByZXR1cm4ge29rOiByLmxlbmd0aCA+PSAxLCBkZXRhaWw6ICdyb3dzPScgKyByLmxlbmd0aH07YCwgNV8wMDApO1xyXG4gICAgICB9LFxyXG4gICAgfSxcclxuICBdO1xyXG5cclxuICBjb25zdCBtZXRhOiB7IGdlbmVyYXRlZEF0OiBzdHJpbmc7IHdpbmRvdzogeyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlciB9OyBtdXRhdGU6IHN0cmluZzsgdmlld3BvcnRzOiBBcnJheTx7IG5hbWU6IHN0cmluZzsgZmlsZTogc3RyaW5nOyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlcjsgZHByOiBudW1iZXI7IG1hc2tzOiBBcnJheTx7IHg6IG51bWJlcjsgeTogbnVtYmVyOyB3OiBudW1iZXI7IGg6IG51bWJlcjsgZm9yOiBzdHJpbmcgfT4gfT4gfSA9IHtcclxuICAgIGdlbmVyYXRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXHJcbiAgICB3aW5kb3c6IHsgd2lkdGg6IFZJRVdQT1JUX1csIGhlaWdodDogVklFV1BPUlRfSCB9LFxyXG4gICAgbXV0YXRlLFxyXG4gICAgdmlld3BvcnRzOiBbXSxcclxuICB9O1xyXG4gIGZvciAoY29uc3QgdiBvZiB2aWV3cG9ydHMpIHtcclxuICAgIGF3YWl0IHYuc2V0dXAoKTtcclxuICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGE9ZG9jdW1lbnQuYWN0aXZlRWxlbWVudDsgaWYoYSAmJiBhLmJsdXIpIGEuYmx1cigpOyB9KSgpYCk7IC8vIFx1NTNCQlx1NzEyNlx1NzBCOVx1NzNBRlxyXG4gICAgYXdhaXQgc2xlZXAoNjAwKTsgLy8gXHU4RkM3XHU2RTIxXHU0RTBFXHU2RTMyXHU2N0QzXHU3QTMzXHU1QjlBXHJcbiAgICBpZiAobXV0YXRlID09PSB2Lm5hbWUpIHtcclxuICAgICAgLy8gXHU3QkExXHU3RUJGXHU4MUVBXHU2OEMwOlx1NkNFOFx1NTE2NSAxMjBcdTAwRDc5MCBcdTU2RkFcdTVCOUFcdTdFQTJcdTU3NTcoXHU3RUE2IDElIFx1OTc2Mlx1NzlFRiw+IDAuNSUgXHU5NjA4XHU1MDNDLFx1NUU5NFx1NTIyNCBGQUlMKVxyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBkPWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpOyBkLnNldEF0dHJpYnV0ZSgnZGF0YS12aXNyZWctbXV0YXRlJywnMScpO1xyXG4gICAgICAgIGQuc3R5bGUuY3NzVGV4dD0ncG9zaXRpb246Zml4ZWQ7bGVmdDo1NjBweDt0b3A6MzAwcHg7d2lkdGg6MTIwcHg7aGVpZ2h0OjkwcHg7YmFja2dyb3VuZDpyZ2IoMjU1LDAsMCk7ei1pbmRleDo5OTk5Oyc7XHJcbiAgICAgICAgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZChkKTsgfSkoKWApO1xyXG4gICAgICBhd2FpdCBzbGVlcCgxNTApO1xyXG4gICAgfVxyXG4gICAgY29uc3QgaW1nID0gYXdhaXQgd2luLndlYkNvbnRlbnRzLmNhcHR1cmVQYWdlKCk7XHJcbiAgICBjb25zdCBzaXplID0gaW1nLmdldFNpemUoKTtcclxuICAgIC8vIFx1N0JBMVx1N0VCRlx1ODFFQVx1NjhDMFx1N0VBMlx1NTc1N1x1NTNFQVx1NUM1RVx1NEU4RVx1NzZFRVx1NjgwN1x1ODlDNlx1NTNFMzpcdTYyMkFcdTU2RkVcdTU0MEVcdTdBQ0JcdTUzNzNcdTc5RkJcdTk2NjQsXHU0RTBEXHU2QzYxXHU2N0QzXHU1NDBFXHU3RUVEXHU4OUM2XHU1M0UzXHJcbiAgICBpZiAobXV0YXRlID09PSB2Lm5hbWUpIHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgZD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCdbZGF0YS12aXNyZWctbXV0YXRlXScpOyBpZihkKSBkLnJlbW92ZSgpOyB9KSgpYCk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBpbm5lclcgPSAoYXdhaXQganM8bnVtYmVyPignd2luZG93LmlubmVyV2lkdGgnKSkgfHwgc2l6ZS53aWR0aDtcclxuICAgIGNvbnN0IGRwciA9IHNpemUud2lkdGggLyBpbm5lclc7XHJcbiAgICBjb25zdCBtYXNrczogQXJyYXk8eyB4OiBudW1iZXI7IHk6IG51bWJlcjsgdzogbnVtYmVyOyBoOiBudW1iZXI7IGZvcjogc3RyaW5nIH0+ID0gW107XHJcbiAgICBmb3IgKGNvbnN0IG0gb2YgTUFTS19TRUxFQ1RPUlMpIHtcclxuICAgICAgY29uc3QgcmVjdHMgPSAoYXdhaXQganM8c3RyaW5nPihgKGZ1bmN0aW9uKCl7IHJldHVybiBKU09OLnN0cmluZ2lmeShbXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJyR7bS5zZWx9JykpLm1hcChmdW5jdGlvbihlbCl7XHJcbiAgICAgICAgdmFyIHI9ZWwuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7IHJldHVybiB7IHg6ci54LCB5OnIueSwgdzpyLndpZHRoLCBoOnIuaGVpZ2h0IH07XHJcbiAgICAgIH0pLmZpbHRlcihmdW5jdGlvbihyKXsgcmV0dXJuIHIudyA+IDAgJiYgci5oID4gMCAmJiByLnkgPj0gMCAmJiByLnkgPCB3aW5kb3cuaW5uZXJIZWlnaHQ7IH0pKSB9KSgpYCkpO1xyXG4gICAgICBsZXQgbGlzdDogQXJyYXk8eyB4OiBudW1iZXI7IHk6IG51bWJlcjsgdzogbnVtYmVyOyBoOiBudW1iZXIgfT4gPSBbXTtcclxuICAgICAgdHJ5IHsgbGlzdCA9IEpTT04ucGFyc2UocmVjdHMpIGFzIHR5cGVvZiBsaXN0OyB9IGNhdGNoIHsgLyogXHU3QTdBICovIH1cclxuICAgICAgZm9yIChjb25zdCByIG9mIGxpc3QpIHtcclxuICAgICAgICBtYXNrcy5wdXNoKHsgeDogTWF0aC5yb3VuZChyLnggKiBkcHIpLCB5OiBNYXRoLnJvdW5kKHIueSAqIGRwciksIHc6IE1hdGgucm91bmQoci53ICogZHByKSwgaDogTWF0aC5yb3VuZChyLmggKiBkcHIpLCBmb3I6IG0ucmVhc29uIH0pO1xyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgICBjb25zdCBmaWxlID0gYCR7di5uYW1lfS5wbmdgO1xyXG4gICAgYXdhaXQgd3JpdGVGaWxlKGpvaW4ob3V0LCBmaWxlKSwgaW1nLnRvUE5HKCkpO1xyXG4gICAgbWV0YS52aWV3cG9ydHMucHVzaCh7IG5hbWU6IHYubmFtZSwgZmlsZSwgd2lkdGg6IHNpemUud2lkdGgsIGhlaWdodDogc2l6ZS5oZWlnaHQsIGRwcjogTWF0aC5yb3VuZChkcHIgKiAxMDApIC8gMTAwLCBtYXNrcyB9KTtcclxuICAgIGNvbnNvbGUubG9nKGBWSVNSRUctQ0FQVFVSRSAke3YubmFtZX0gJHtzaXplLndpZHRofXgke3NpemUuaGVpZ2h0fSBtYXNrcz0ke21hc2tzLmxlbmd0aH0ke211dGF0ZSA9PT0gdi5uYW1lID8gJyBNVVRBVEVEJyA6ICcnfWApO1xyXG4gIH1cclxuICBhd2FpdCB3cml0ZUZpbGUoam9pbihvdXQsICdtZXRhLmpzb24nKSwgSlNPTi5zdHJpbmdpZnkobWV0YSwgbnVsbCwgMikpO1xyXG4gIGNvbnNvbGUubG9nKCdWSVNSRUctQ0FQVFVSRSBET05FJyk7XHJcbiAgYXBwLmV4aXQoMCk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBhdHRhY2hWaXN1YWxSZWdyZXNzaW9uKHdpbjogQnJvd3NlcldpbmRvdyk6IHZvaWQge1xyXG4gIHdpbi53ZWJDb250ZW50cy5vbmNlKCdkaWQtZmluaXNoLWxvYWQnLCAoKSA9PiB7XHJcbiAgICBzZXRUaW1lb3V0KCgpID0+IHsgdm9pZCBydW5WaXN1YWxSZWdyZXNzaW9uKHdpbik7IH0sIDFfNTAwKTtcclxuICB9KTtcclxufVxyXG4iLCAiLyoqXG4gKiB2NS4xIFx1NUI4OVx1ODhDNVx1NTQxMVx1NUJGQyBcdTAwQjcgQGhtaGFybmVzcy9jbGkgXHU1Qjg5XHU4OEM1XHU3RjE2XHU2MzkyKFx1NEUzQlx1OEZEQlx1N0EwQilcdTMwMDJcbiAqXG4gKiBcdTRFMjRcdTY3NjFcdThERUZcdTVGODQoXHU2M0QwXHU3OTNBXHU4QkNEIHY1LjEgXHU1NDA4XHU1NDBDKTpcbiAqICAtIG5wbSBcdTUzRUZcdTc1MjgoXHU5RUQ4XHU4QkE0KTpgbnBtIGluc3RhbGwgLS1wcmVmaXggJVVTRVJQUk9GSUxFJVxcLmhtaGFybmVzcy1nbG9iYWxcbiAqICAgIEBobWhhcm5lc3MvY2xpYCBcdTIwMTRcdTIwMTQgXHU1M0VBXHU1MTk5XHU3NTI4XHU2MjM3XHU3NkVFXHU1RjU1LFx1NEUwRFx1NzhCMFx1N0NGQlx1N0VERi9ucG0gXHU1MTY4XHU1QzQwO25wbSBcdTgxRUFcdTVFMjZcdTRGOURcdThENTZcdTg5RTNcdTY3OTAsXG4gKiAgICBcdThGREJcdTVFQTZcdThGNkNcdTUzRDFcdTUxNzZcdThGOTNcdTUxRkFcdTg4NEMoXHU1Qjg5XHU4OEM1XHU2QjY1XHU5QUE0XHU2NTg3XHU2ODQ4KVx1MzAwMlxuICogIC0gXHU2NUUwIG5wbShcdTYyMTZcdTY2M0VcdTVGMEZcdTVGM0FcdTUyMzYpOlx1ODFFQVx1NzgxNCB0Z3ogXHU1Qjg5XHU4OEM1XHU1NjY4IFx1MjAxNFx1MjAxNCBcdTRGOURcdThENTZcdTk1RURcdTUzMDVcdTY3NjVcdTgxRUFcbiAqICAgIEBobWgtZGVza3RvcC9jbGktaW5zdGFsbGVyKFx1N0VBRlx1OTAzQlx1OEY5MSxcdTVERjJcdTUzNTVcdTZENEIpLHRhcmJhbGwgXHU5MDEwXHU1MzA1XHU2RDQxXHU1RjBGXHU0RTBCXHU4RjdEXG4gKiAgICAoXHU3NzFGXHU1QjU3XHU4MjgyXHU4RkRCXHU1RUE2ICsgcmVnaXN0cnkubnBtanMub3JnXHUyMTkycmVnaXN0cnkubnBtbWlycm9yLmNvbSBcdTk1NUNcdTUwQ0ZcdTU2REVcdTkwMDAsXG4gKiAgICBcdTU5MERcdTc1MjggdjQgXHU2NkY0XHU2NUIwXHU1NjY4XHU1NkRFXHU5MDAwXHU2MDFEXHU2MEYzICsgaW50ZWdyaXR5IFx1NjgyMVx1OUE4QyksXHU3Q0ZCXHU3RURGIHRhci5leGUgXHU4OUUzXHU1MzhCXHU1MjMwXG4gKiAgICBub2RlX21vZHVsZXMgXHU2MjQxXHU1RTczXHU1RTAzXHU1QzQwXHUzMDAyXG4gKiBcdThGREJcdTVFQTZcdTRFMDBcdTVGOEJcdTdFQ0YgaW5zdGFsbDpwcm9ncmVzcyBcdTRFOEJcdTRFRjZcdTYzQTggcmVuZGVyZXI7XHU2MjEwXHU1MjlGXHU1NkRFXHU4QzAzIG9uSW5zdGFsbGVkKGVudHJ5KVxuICogXHU3NTMxIG1haW4gXHU2MzAxXHU0RTQ1XHU1MzE2IHJ1bnRpbWUuanNvbiBcdTVFNzZcdTcwRURcdTkxQ0RcdTU0MkYgaG9zdFx1MzAwMlxuICovXG5pbXBvcnQgeyBzcGF3biB9IGZyb20gJ25vZGU6Y2hpbGRfcHJvY2Vzcyc7XG5pbXBvcnQgeyBleGlzdHNTeW5jLCBta2RpclN5bmMsIHJtU3luYywgcmVuYW1lU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gJ25vZGU6ZnMnO1xuaW1wb3J0IHsgaG9tZWRpciB9IGZyb20gJ25vZGU6b3MnO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gJ25vZGU6cGF0aCc7XG5pbXBvcnQgeyBieXRlc0xhYmVsLCBpbnRlZ3JpdHlPaywgbW9kdWxlRGlyLCByZXNvbHZlQ2xvc3VyZSwgdGFyYmFsbE1pcnJvcnMsIHR5cGUgUGFja3VtZW50LCB0eXBlIFJlc29sdmVkUGtnIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2NsaS1pbnN0YWxsZXInO1xuXG5leHBvcnQgaW50ZXJmYWNlIEluc3RhbGxQcm9ncmVzcyB7XG4gIHBoYXNlOiAnY2hlY2snIHwgJ21ldGEnIHwgJ2Rvd25sb2FkJyB8ICdleHRyYWN0JyB8ICducG0nIHwgJ2RvbmUnIHwgJ2Vycm9yJztcbiAgcGN0PzogbnVtYmVyO1xuICB0ZXh0OiBzdHJpbmc7XG4gIG1pcnJvcj86IHN0cmluZztcbiAgZW50cnk/OiBzdHJpbmc7XG4gIGVycm9yPzogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEluc3RhbGxPcHRpb25zIHtcbiAgLyoqIFx1NUYzQVx1NTIzNlx1OEQ3MFx1ODFFQVx1NzgxNCB0Z3ogXHU4REVGXHU1Rjg0KFx1NkQ0Qlx1OEJENS9cdTY1RTAgbnBtIFx1NzNBRlx1NTg4MylcdTMwMDIgKi9cbiAgZm9yY2VUZ3o/OiBib29sZWFuIHwgdW5kZWZpbmVkO1xuICAvKiogXHU5NTVDXHU1MENGXHU0RjE4XHU1MTQ4XHU3RUE3KFx1NjM2Mlx1NkU5MFx1NjMwOVx1OTRBRVx1N0ZGQlx1OEY2QylcdTMwMDIgKi9cbiAgbWlycm9yRmlyc3Q/OiAnbnBtanMnIHwgJ25wbW1pcnJvcicgfCB1bmRlZmluZWQ7XG59XG5cbmV4cG9ydCBjb25zdCBSRUdJU1RSSUVTOiBSZWNvcmQ8J25wbWpzJyB8ICducG1taXJyb3InLCBzdHJpbmc+ID0ge1xuICBucG1qczogJ2h0dHBzOi8vcmVnaXN0cnkubnBtanMub3JnJyxcbiAgbnBtbWlycm9yOiAnaHR0cHM6Ly9yZWdpc3RyeS5ucG1taXJyb3IuY29tJyxcbn07XG5cbi8qKiBcdTVCODlcdTg4QzVcdTY4MzlcdTc2RUVcdTVGNTUoXHU3NTI4XHU2MjM3XHU3NkVFXHU1RjU1LFx1N0VERFx1NEUwRFx1NTE5OVx1N0NGQlx1N0VERi9cdTUxNjhcdTVDNDAgbnBtKVx1MzAwMiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGluc3RhbGxUYXJnZXQoKTogc3RyaW5nIHtcbiAgcmV0dXJuIGpvaW4oaG9tZWRpcigpLCAnLmhtaGFybmVzcy1nbG9iYWwnKTtcbn1cblxuLyoqIFx1NUI4OVx1ODhDNVx1NUI4Q1x1NjIxMFx1NTQwRVx1NzY4NCBkZXNrdG9wLWhvc3QgXHU1MTY1XHU1M0UzKG5wbSBcdTVENENcdTU5NTdcdTRFMEVcdTYzRDBcdTUzNDdcdTRFMjRcdTc5Q0RcdTVFMDNcdTVDNDBcdTkwRkRcdThCQTQpXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZUluc3RhbGxlZEVudHJ5KHRhcmdldDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgbmVzdGVkID0gam9pbih0YXJnZXQsICdub2RlX21vZHVsZXMnLCAnQGhtaGFybmVzcycsICdjbGknLCAnbm9kZV9tb2R1bGVzJywgJ0BobWhhcm5lc3MnLCAnd2ViJywgJ2Rpc3QnLCAnZGVza3RvcC1ob3N0LmpzJyk7XG4gIGNvbnN0IGhvaXN0ZWQgPSBqb2luKHRhcmdldCwgJ25vZGVfbW9kdWxlcycsICdAaG1oYXJuZXNzJywgJ3dlYicsICdkaXN0JywgJ2Rlc2t0b3AtaG9zdC5qcycpO1xuICBpZiAoZXhpc3RzU3luYyhuZXN0ZWQpKSByZXR1cm4gbmVzdGVkO1xuICBpZiAoZXhpc3RzU3luYyhob2lzdGVkKSkgcmV0dXJuIGhvaXN0ZWQ7XG4gIHJldHVybiAnJztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBJbnN0YWxsZXJIb3N0IHtcbiAgc2VuZFByb2dyZXNzKHA6IEluc3RhbGxQcm9ncmVzcyk6IHZvaWQ7XG4gIGxvZyhtc2c6IHN0cmluZyk6IHZvaWQ7XG4gIC8qKiBcdTVCODlcdTg4QzVcdTYyMTBcdTUyOUYoXHU1MTY1XHU1M0UzXHU1REYyXHU5QThDXHU4QkMxXHU1QjU4XHU1NzI4KVx1MjAxNFx1MjAxNCBtYWluIFx1NTcyOFx1NkI2NFx1NjMwMVx1NEU0NVx1NTMxNlx1NUU3Nlx1OTFDRFx1NTQyRiBob3N0XHUzMDAyICovXG4gIG9uSW5zdGFsbGVkKGVudHJ5OiBzdHJpbmcsIHZpYTogJ25wbScgfCAndGd6Jyk6IHZvaWQ7XG59XG5cbmxldCBydW5uaW5nID0gZmFsc2U7XG5cbmV4cG9ydCBmdW5jdGlvbiBpbnN0YWxsUnVubmluZygpOiBib29sZWFuIHtcbiAgcmV0dXJuIHJ1bm5pbmc7XG59XG5cbi8qKiBcdTU0MkZcdTUyQThcdTVCODlcdTg4QzUoXHU1NDBFXHU1M0YwXHU2MjY3XHU4ODRDO1x1OEZEQlx1NUVBNi9cdTdFRDNcdTY3OUNcdTUxNjhcdTkwRThcdTdFQ0ZcdTRFOEJcdTRFRjZcdTU2REVcdTZENDEsUHJvbWlzZSBcdTUzRUFcdTg4NjhcdThGQkVcIlx1NURGMlx1NTNEN1x1NzQwNlwiKVx1MzAwMiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN0YXJ0Q2xpSW5zdGFsbChob3N0OiBJbnN0YWxsZXJIb3N0LCBvcHRzOiBJbnN0YWxsT3B0aW9ucyA9IHt9KTogeyBvazogYm9vbGVhbjsgZXJyb3I/OiBzdHJpbmcgfSB7XG4gIGlmIChydW5uaW5nKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAnXHU1Qjg5XHU4OEM1XHU1REYyXHU1NzI4XHU4RkRCXHU4ODRDXHU0RTJEJyB9O1xuICBydW5uaW5nID0gdHJ1ZTtcbiAgY29uc3QgZmluaXNoID0gKHA6IEluc3RhbGxQcm9ncmVzcyk6IHZvaWQgPT4ge1xuICAgIGhvc3Quc2VuZFByb2dyZXNzKHApO1xuICAgIHJ1bm5pbmcgPSBmYWxzZTtcbiAgfTtcbiAgY29uc3QgZmFpbCA9ICh0ZXh0OiBzdHJpbmcsIGVycjogdW5rbm93bik6IHZvaWQgPT4ge1xuICAgIGhvc3QubG9nKGBpbnN0YWxsIGZhaWxlZDogJHt0ZXh0fSAke1N0cmluZyhlcnIpLnNsaWNlKDAsIDE4MCl9YCk7XG4gICAgZmluaXNoKHsgcGhhc2U6ICdlcnJvcicsIHRleHQsIGVycm9yOiBgJHt0ZXh0fToke1N0cmluZyhlcnIpLnNsaWNlKDAsIDE2MCl9YCB9KTtcbiAgfTtcbiAgdm9pZCAoYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHRhcmdldCA9IGluc3RhbGxUYXJnZXQoKTtcbiAgICB0cnkge1xuICAgICAgbWtkaXJTeW5jKHRhcmdldCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICBjb25zdCBucG1PayA9IG9wdHMuZm9yY2VUZ3ogPT09IHRydWUgPyBmYWxzZSA6IGF3YWl0IHByb2JlTnBtKGhvc3QpO1xuICAgICAgaWYgKG5wbU9rKSBhd2FpdCBpbnN0YWxsVmlhTnBtKGhvc3QsIHRhcmdldCwgb3B0cyk7XG4gICAgICBlbHNlIGF3YWl0IGluc3RhbGxWaWFUYXJiYWxscyhob3N0LCB0YXJnZXQsIG9wdHMpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgZmFpbCgnXHU1Qjg5XHU4OEM1XHU1OTMxXHU4RDI1JywgZXJyKTtcbiAgICB9XG4gIH0pKCk7XG4gIHJldHVybiB7IG9rOiB0cnVlIH07XG59XG5cbi8qIC0tLS0gbnBtIFx1NTNFRlx1NzUyOFx1NjAyNyhcdTZDRThcdTYxMEY6V2luZG93cyBcdTRFMEIgc3Bhd24oJ25wbScpIFx1NTNFRlx1ODg0QywnbnBtLmNtZCcgXHU1M0NEXHU4MDBDIEVJTlZBTCkgLS0tLSAqL1xuYXN5bmMgZnVuY3Rpb24gcHJvYmVOcG0oaG9zdDogSW5zdGFsbGVySG9zdCk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBob3N0LnNlbmRQcm9ncmVzcyh7IHBoYXNlOiAnY2hlY2snLCB0ZXh0OiAnXHU2OEMwXHU2N0U1IG5wbVx1MjAyNicgfSk7XG4gIGNvbnN0IG9rID0gYXdhaXQgbmV3IFByb21pc2U8Ym9vbGVhbj4oKHJlc29sdmUpID0+IHtcbiAgICBjb25zdCBjID0gc3Bhd24oJ25wbScsIFsnLS12ZXJzaW9uJ10sIHsgd2luZG93c0hpZGU6IHRydWUsIHN0ZGlvOiAnaWdub3JlJyB9KTtcbiAgICBjb25zdCB0ID0gc2V0VGltZW91dCgoKSA9PiB7IHRyeSB7IGMua2lsbCgpOyB9IGNhdGNoIHsgLyogbm9vcCAqLyB9IHJlc29sdmUoZmFsc2UpOyB9LCAxNV8wMDApO1xuICAgIGMub24oJ2Vycm9yJywgKCkgPT4geyBjbGVhclRpbWVvdXQodCk7IHJlc29sdmUoZmFsc2UpOyB9KTtcbiAgICBjLm9uKCdleGl0JywgKGNvZGUpID0+IHsgY2xlYXJUaW1lb3V0KHQpOyByZXNvbHZlKGNvZGUgPT09IDApOyB9KTtcbiAgfSk7XG4gIGhvc3QubG9nKGBucG0gJHtvayA/ICdhdmFpbGFibGUnIDogJ3VuYXZhaWxhYmxlJ30gXHUyMTkyICR7b2sgPyAnbnBtIHByZWZpeCcgOiAndGd6J30gcGF0aGApO1xuICByZXR1cm4gb2s7XG59XG5cbi8qIC0tLS0gXHU4REVGXHU1Rjg0IEE6bnBtIC0tcHJlZml4KFx1NUI4OVx1ODhDNVx1NkI2NVx1OUFBNFx1NjU4N1x1Njg0OCA9IG5wbSBcdThGOTNcdTUxRkFcdTg4NEMpIC0tLS0gKi9cbmFzeW5jIGZ1bmN0aW9uIGluc3RhbGxWaWFOcG0oaG9zdDogSW5zdGFsbGVySG9zdCwgdGFyZ2V0OiBzdHJpbmcsIG9wdHM6IEluc3RhbGxPcHRpb25zKTogUHJvbWlzZTx2b2lkPiB7XG4gIGhvc3Quc2VuZFByb2dyZXNzKHsgcGhhc2U6ICducG0nLCB0ZXh0OiBgbnBtIGluc3RhbGwgQGhtaGFybmVzcy9jbGkgXHUyMTkyICR7dGFyZ2V0fShcdTRFQzVcdTc1MjhcdTYyMzdcdTc2RUVcdTVGNTUpYCB9KTtcbiAgY29uc3QgcmVnaXN0cnkgPSBvcHRzLm1pcnJvckZpcnN0ID09PSAnbnBtbWlycm9yJyA/IFsnLS1yZWdpc3RyeScsIFJFR0lTVFJJRVMubnBtbWlycm9yXSA6IG9wdHMubWlycm9yRmlyc3QgPT09ICducG1qcycgPyBbJy0tcmVnaXN0cnknLCBSRUdJU1RSSUVTLm5wbWpzXSA6IFtdO1xuICBjb25zdCBhcmdzID0gWydpbnN0YWxsJywgJy0tcHJlZml4JywgdGFyZ2V0LCAnLS1uby1hdWRpdCcsICctLW5vLWZ1bmQnLCAnLS1sb2dsZXZlbCcsICdub3RpY2UnLCAuLi5yZWdpc3RyeSwgJ0BobWhhcm5lc3MvY2xpQGxhdGVzdCddO1xuICBjb25zdCBjb2RlID0gYXdhaXQgbmV3IFByb21pc2U8bnVtYmVyPigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgY29uc3QgYyA9IHNwYXduKCducG0nLCBhcmdzLCB7IHdpbmRvd3NIaWRlOiB0cnVlLCBjd2Q6IGhvbWVkaXIoKSB9KTtcbiAgICBsZXQgbGFzdCA9ICcnO1xuICAgIGNvbnN0IG9uTGluZSA9IChkOiBCdWZmZXIpOiB2b2lkID0+IHtcbiAgICAgIGZvciAoY29uc3QgcmF3IG9mIGQudG9TdHJpbmcoKS5zcGxpdCgvXFxyP1xcbi8pKSB7XG4gICAgICAgIGNvbnN0IGxpbmUgPSByYXcucmVwbGFjZSgvW1xcdTAwMDAtXFx1MDAxZl0vZywgJycpLnRyaW0oKS5zbGljZSgwLCAxODApO1xuICAgICAgICBpZiAobGluZSA9PT0gJycgfHwgbGluZSA9PT0gbGFzdCkgY29udGludWU7XG4gICAgICAgIGxhc3QgPSBsaW5lO1xuICAgICAgICBob3N0LnNlbmRQcm9ncmVzcyh7IHBoYXNlOiAnbnBtJywgdGV4dDogbGluZSB9KTtcbiAgICAgIH1cbiAgICB9O1xuICAgIGMuc3Rkb3V0Py5vbignZGF0YScsIG9uTGluZSk7XG4gICAgYy5zdGRlcnI/Lm9uKCdkYXRhJywgb25MaW5lKTtcbiAgICBjLm9uKCdlcnJvcicsIHJlamVjdCk7XG4gICAgY29uc3Qga2lsbGVyID0gc2V0VGltZW91dCgoKSA9PiB7IHRyeSB7IGMua2lsbCgpOyB9IGNhdGNoIHsgLyogbm9vcCAqLyB9IHJlamVjdChuZXcgRXJyb3IoJ25wbSBcdTVCODlcdTg4QzVcdThEODVcdTY1RjYoOCBcdTUyMDZcdTk0OUYpJykpOyB9LCA4ICogNjBfMDAwKTtcbiAgICBjLm9uKCdleGl0JywgKHgpID0+IHsgY2xlYXJUaW1lb3V0KGtpbGxlcik7IHJlc29sdmUoeCA/PyAxKTsgfSk7XG4gIH0pO1xuICBpZiAoY29kZSAhPT0gMCkgdGhyb3cgbmV3IEVycm9yKGBucG0gaW5zdGFsbCBcdTkwMDBcdTUxRkFcdTc4MDEgJHtjb2RlfWApO1xuICBjb25zdCBlbnRyeSA9IHJlc29sdmVJbnN0YWxsZWRFbnRyeSh0YXJnZXQpO1xuICBpZiAoZW50cnkgPT09ICcnKSB0aHJvdyBuZXcgRXJyb3IoJ25wbSBcdTVCODlcdTg4QzVcdTVCOENcdTYyMTBcdTRGNDZcdTY3MkFcdTYyN0VcdTUyMzAgZGVza3RvcC1ob3N0IFx1NTE2NVx1NTNFMycpO1xuICB3cml0ZVN0YW1wKHRhcmdldCwgJ25wbScpO1xuICBmaW5pc2hJbnN0YWxsKGhvc3QsIGVudHJ5LCAnbnBtJyk7XG59XG5cbi8qIC0tLS0gXHU4REVGXHU1Rjg0IEI6XHU4MUVBXHU3ODE0IHRneihcdTc3MUZcdTRFMEJcdThGN0RcdThGREJcdTVFQTYgKyBcdTk1NUNcdTUwQ0ZcdTU2REVcdTkwMDAgKyBpbnRlZ3JpdHkgKyB0YXIgXHU4OUUzXHU1MzhCKSAtLS0tICovXG5hc3luYyBmdW5jdGlvbiBpbnN0YWxsVmlhVGFyYmFsbHMoaG9zdDogSW5zdGFsbGVySG9zdCwgdGFyZ2V0OiBzdHJpbmcsIG9wdHM6IEluc3RhbGxPcHRpb25zKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IG9yZGVyOiBBcnJheTwnbnBtanMnIHwgJ25wbW1pcnJvcic+ID0gb3B0cy5taXJyb3JGaXJzdCA9PT0gJ25wbW1pcnJvcicgPyBbJ25wbW1pcnJvcicsICducG1qcyddIDogWyducG1qcycsICducG1taXJyb3InXTtcbiAgY29uc3QgbWlycm9ycyA9IG9yZGVyLm1hcCgoaykgPT4gUkVHSVNUUklFU1trXSk7XG4gIGhvc3Quc2VuZFByb2dyZXNzKHsgcGhhc2U6ICdtZXRhJywgdGV4dDogJ1x1ODlFM1x1Njc5MFx1NEY5RFx1OEQ1Nlx1NkUwNVx1NTM1NShAaG1oYXJuZXNzL2NsaSBcdTUxNjhcdTVCQjYpXHUyMDI2JyB9KTtcblxuICBjb25zdCBwYWNrdW1lbnRzID0gbmV3IE1hcDxzdHJpbmcsIFBhY2t1bWVudD4oKTtcbiAgY29uc3QgZ2V0UGFja3VtZW50ID0gYXN5bmMgKG5hbWU6IHN0cmluZyk6IFByb21pc2U8UGFja3VtZW50PiA9PiB7XG4gICAgY29uc3QgaGl0ID0gcGFja3VtZW50cy5nZXQobmFtZSk7XG4gICAgaWYgKGhpdCAhPT0gdW5kZWZpbmVkKSByZXR1cm4gaGl0O1xuICAgIGxldCBsYXN0RXJyID0gJyc7XG4gICAgZm9yIChjb25zdCBtIG9mIG1pcnJvcnMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHIgPSBhd2FpdCBmZXRjaChgJHttfS8ke2VuY29kZVVSSUNvbXBvbmVudChuYW1lKX1gLCB7XG4gICAgICAgICAgaGVhZGVyczogeyBhY2NlcHQ6ICdhcHBsaWNhdGlvbi92bmQubnBtLmluc3RhbGwtdjEranNvbicgfSxcbiAgICAgICAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoMjVfMDAwKSxcbiAgICAgICAgfSk7XG4gICAgICAgIGlmICghci5vaykgeyBsYXN0RXJyID0gYEhUVFAgJHtyLnN0YXR1c31gOyBjb250aW51ZTsgfVxuICAgICAgICBjb25zdCBkb2MgPSAoYXdhaXQgci5qc29uKCkpIGFzIFBhY2t1bWVudDtcbiAgICAgICAgaWYgKGRvYy52ZXJzaW9ucyA9PT0gdW5kZWZpbmVkKSB7IGxhc3RFcnIgPSAnbWFsZm9ybWVkIHBhY2t1bWVudCc7IGNvbnRpbnVlOyB9XG4gICAgICAgIHBhY2t1bWVudHMuc2V0KG5hbWUsIGRvYyk7XG4gICAgICAgIHJldHVybiBkb2M7XG4gICAgICB9IGNhdGNoIChlcnIpIHsgbGFzdEVyciA9IFN0cmluZyhlcnIpLnNsaWNlKDAsIDYwKTsgfVxuICAgIH1cbiAgICB0aHJvdyBuZXcgRXJyb3IoYFx1ODNCN1x1NTNENiAke25hbWV9IFx1NTE0M1x1NjU3MFx1NjM2RVx1NTkzMVx1OEQyNShcdTUxNjhcdTkwRThcdTk1NUNcdTUwQ0Y6JHtsYXN0RXJyfSlgKTtcbiAgfTtcblxuICBjb25zdCBjbG9zdXJlID0gYXdhaXQgcmVzb2x2ZUNsb3N1cmUoeyBuYW1lOiAnQGhtaGFybmVzcy9jbGknLCBzcGVjOiAnbGF0ZXN0JyB9LCBnZXRQYWNrdW1lbnQpO1xuICBjb25zdCByb290ID0gY2xvc3VyZS5maW5kKChwKSA9PiBwLm5hbWUgPT09ICdAaG1oYXJuZXNzL2NsaScpO1xuICBob3N0LmxvZyhgY2xvc3VyZTogJHtjbG9zdXJlLmxlbmd0aH0gcGFja2FnZXMgKHJvb3QgQGhtaGFybmVzcy9jbGlAJHtyb290Py52ZXJzaW9uID8/ICc/J30pYCk7XG4gIGhvc3Quc2VuZFByb2dyZXNzKHsgcGhhc2U6ICdtZXRhJywgdGV4dDogYFx1NEY5RFx1OEQ1Nlx1NkUwNVx1NTM1NVx1NUMzMVx1N0VFQToke2Nsb3N1cmUubGVuZ3RofSBcdTRFMkFcdTUzMDUoQGhtaGFybmVzcy9jbGlAJHtyb290Py52ZXJzaW9uID8/ICc/J30pYCB9KTtcblxuICBjb25zdCBzdGFnaW5nID0gam9pbih0YXJnZXQsICcuc3RhZ2luZycpO1xuICBybVN5bmMoc3RhZ2luZywgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICBta2RpclN5bmMoc3RhZ2luZywgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBjbG9zdXJlLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgcGtnID0gY2xvc3VyZVtpXSE7XG4gICAgY29uc3QgdXJscyA9IHRhcmJhbGxNaXJyb3JzKHBrZy50YXJiYWxsLCBtaXJyb3JzKTtcbiAgICBsZXQgYnVmOiBCdWZmZXIgfCBudWxsID0gbnVsbDtcbiAgICBsZXQgdXNlZE1pcnJvciA9ICcnO1xuICAgIGxldCBsYXN0RXJyID0gJyc7XG4gICAgZm9yIChjb25zdCB1IG9mIHVybHMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHIgPSBhd2FpdCBmZXRjaCh1LCB7IHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCgzMDBfMDAwKSB9KTtcbiAgICAgICAgaWYgKCFyLm9rKSB7IGxhc3RFcnIgPSBgSFRUUCAke3Iuc3RhdHVzfWA7IGNvbnRpbnVlOyB9XG4gICAgICAgIGNvbnN0IHRvdGFsID0gTnVtYmVyKHIuaGVhZGVycy5nZXQoJ2NvbnRlbnQtbGVuZ3RoJykgPz8gJzAnKTtcbiAgICAgICAgY29uc3QgcmVhZGVyID0gci5ib2R5Py5nZXRSZWFkZXIoKTtcbiAgICAgICAgaWYgKHJlYWRlciA9PT0gdW5kZWZpbmVkKSB0aHJvdyBuZXcgRXJyb3IoJ25vIGJvZHknKTtcbiAgICAgICAgY29uc3QgY2h1bmtzOiBCdWZmZXJbXSA9IFtdO1xuICAgICAgICBsZXQgZ290ID0gMDtcbiAgICAgICAgbGV0IGxhc3RFbWl0ID0gMDtcbiAgICAgICAgZm9yICg7Oykge1xuICAgICAgICAgIGNvbnN0IHsgZG9uZSwgdmFsdWUgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICAgICAgaWYgKGRvbmUgPT09IHRydWUpIGJyZWFrO1xuICAgICAgICAgIGNvbnN0IGIgPSBCdWZmZXIuZnJvbSh2YWx1ZSk7XG4gICAgICAgICAgY2h1bmtzLnB1c2goYik7XG4gICAgICAgICAgZ290ICs9IGIubGVuZ3RoO1xuICAgICAgICAgIGlmIChnb3QgLSBsYXN0RW1pdCA+IDI1NiAqIDEwMjQpIHtcbiAgICAgICAgICAgIGxhc3RFbWl0ID0gZ290O1xuICAgICAgICAgICAgaG9zdC5zZW5kUHJvZ3Jlc3Moe1xuICAgICAgICAgICAgICBwaGFzZTogJ2Rvd25sb2FkJyxcbiAgICAgICAgICAgICAgcGN0OiBNYXRoLnJvdW5kKCgoaSArIE1hdGgubWluKGdvdCAvICh0b3RhbCB8fCBnb3QpLCAxKSkgLyBjbG9zdXJlLmxlbmd0aCkgKiAxMDApLFxuICAgICAgICAgICAgICB0ZXh0OiBgXHU0RTBCXHU4RjdEICR7cGtnLm5hbWV9QCR7cGtnLnZlcnNpb259KCR7aSArIDF9LyR7Y2xvc3VyZS5sZW5ndGh9KVx1MDBCNyAke2J5dGVzTGFiZWwoZ290KX0ke3RvdGFsID4gMCA/IGAgLyAke2J5dGVzTGFiZWwodG90YWwpfWAgOiAnJ31gLFxuICAgICAgICAgICAgICBtaXJyb3I6IG5ldyBVUkwodSkuaG9zdCxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBidWYgPSBCdWZmZXIuY29uY2F0KGNodW5rcyk7XG4gICAgICAgIGlmICghaW50ZWdyaXR5T2soYnVmLCBwa2cuaW50ZWdyaXR5KSkgeyBsYXN0RXJyID0gJ2ludGVncml0eSBcdTRFMERcdTUzMzlcdTkxNEQnOyBidWYgPSBudWxsOyBjb250aW51ZTsgfVxuICAgICAgICB1c2VkTWlycm9yID0gbmV3IFVSTCh1KS5ob3N0O1xuICAgICAgICBicmVhaztcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBsYXN0RXJyID0gU3RyaW5nKGVycikuc2xpY2UoMCwgNjApO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAoYnVmID09PSBudWxsKSB0aHJvdyBuZXcgRXJyb3IoYFx1NEUwQlx1OEY3RCAke3BrZy5uYW1lfSBcdTU5MzFcdThEMjUoXHU1MTY4XHU5MEU4XHU5NTVDXHU1MENGOiR7bGFzdEVycn0pYCk7XG4gICAgY29uc3QgdGd6ID0gam9pbihzdGFnaW5nLCBgJHtpfS50Z3pgKTtcbiAgICB3cml0ZUZpbGVTeW5jKHRneiwgYnVmKTtcbiAgICBob3N0LnNlbmRQcm9ncmVzcyh7XG4gICAgICBwaGFzZTogJ2Rvd25sb2FkJyxcbiAgICAgIHBjdDogTWF0aC5yb3VuZCgoKGkgKyAxKSAvIGNsb3N1cmUubGVuZ3RoKSAqIDEwMCksXG4gICAgICB0ZXh0OiBgXHU0RTBCXHU4RjdEICR7cGtnLm5hbWV9QCR7cGtnLnZlcnNpb259IFx1NUI4Q1x1NjIxMCgke2J5dGVzTGFiZWwoYnVmLmxlbmd0aCl9LHZpYSAke3VzZWRNaXJyb3J9KWAsXG4gICAgICBtaXJyb3I6IHVzZWRNaXJyb3IsXG4gICAgfSk7XG4gIH1cblxuICBob3N0LnNlbmRQcm9ncmVzcyh7IHBoYXNlOiAnZXh0cmFjdCcsIHRleHQ6ICdcdTg5RTNcdTUzOEJcdTVFNzZcdTVFMDNcdTVDNDAgbm9kZV9tb2R1bGVzXHUyMDI2JyB9KTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBjbG9zdXJlLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgcGtnID0gY2xvc3VyZVtpXSE7XG4gICAgYXdhaXQgZXh0cmFjdFRneihqb2luKHN0YWdpbmcsIGAke2l9LnRnemApLCBzdGFnaW5nLCBwa2cpO1xuICAgIGhvc3Quc2VuZFByb2dyZXNzKHsgcGhhc2U6ICdleHRyYWN0JywgcGN0OiBNYXRoLnJvdW5kKCgoaSArIDEpIC8gY2xvc3VyZS5sZW5ndGgpICogMTAwKSwgdGV4dDogYFx1ODlFM1x1NTM4QiAke3BrZy5uYW1lfSgke2kgKyAxfS8ke2Nsb3N1cmUubGVuZ3RofSlgIH0pO1xuICB9XG4gIHJtU3luYyhzdGFnaW5nLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG5cbiAgY29uc3QgZW50cnkgPSByZXNvbHZlSW5zdGFsbGVkRW50cnkodGFyZ2V0KTtcbiAgaWYgKGVudHJ5ID09PSAnJykgdGhyb3cgbmV3IEVycm9yKCd0Z3ogXHU1Qjg5XHU4OEM1XHU1QjhDXHU2MjEwXHU0RjQ2XHU2NzJBXHU2MjdFXHU1MjMwIGRlc2t0b3AtaG9zdCBcdTUxNjVcdTUzRTMnKTtcbiAgd3JpdGVTdGFtcCh0YXJnZXQsICd0Z3onKTtcbiAgZmluaXNoSW5zdGFsbChob3N0LCBlbnRyeSwgJ3RneicpO1xufVxuXG4vKiogdGFyLmV4ZShXaW4xMCsgXHU4MUVBXHU1RTI2KVx1ODlFM1x1NTM4QiB0Z3ogXHU1MjMwIGV4RGlyLFx1NTE4RFx1NjI4QSBwYWNrYWdlLyBcdTYzMkFcdTUyMzAgbm9kZV9tb2R1bGVzIFx1NUUwM1x1NUM0MFx1MzAwMiAqL1xuYXN5bmMgZnVuY3Rpb24gZXh0cmFjdFRneih0Z3o6IHN0cmluZywgc3RhZ2luZzogc3RyaW5nLCBwa2c6IFJlc29sdmVkUGtnKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGV4RGlyID0gam9pbihzdGFnaW5nLCBgeC0ke3BrZy5uYW1lLnJlcGxhY2UoL1teXFx3Li1dL2csICdfJyl9YCk7XG4gIHJtU3luYyhleERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICBta2RpclN5bmMoZXhEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBjb25zdCBjb2RlID0gYXdhaXQgbmV3IFByb21pc2U8bnVtYmVyPigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgY29uc3QgYyA9IHNwYXduKCd0YXInLCBbJy14emYnLCB0Z3osICctQycsIGV4RGlyXSwgeyB3aW5kb3dzSGlkZTogdHJ1ZSwgc3RkaW86ICdpZ25vcmUnIH0pO1xuICAgIGMub24oJ2Vycm9yJywgcmVqZWN0KTtcbiAgICBjLm9uKCdleGl0JywgKHgpID0+IHJlc29sdmUoeCA/PyAxKSk7XG4gIH0pO1xuICBpZiAoY29kZSAhPT0gMCkgdGhyb3cgbmV3IEVycm9yKGB0YXIgXHU4OUUzXHU1MzhCICR7cGtnLm5hbWV9IFx1NTkzMVx1OEQyNShcdTkwMDBcdTUxRkFcdTc4MDEgJHtjb2RlfSlgKTtcbiAgY29uc3QgZGVzdCA9IG1vZHVsZURpcihpbnN0YWxsVGFyZ2V0KCksIHBrZy5uYW1lKTtcbiAgY29uc3QgcGFyZW50ID0gZGVzdC5zbGljZSgwLCBkZXN0Lmxhc3RJbmRleE9mKCdcXFxcJykpO1xuICBta2RpclN5bmMocGFyZW50LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgcm1TeW5jKGRlc3QsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgcmVuYW1lU3luYyhqb2luKGV4RGlyLCAncGFja2FnZScpLCBkZXN0KTtcbiAgcm1TeW5jKGV4RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG59XG5cbi8qKiBcdTVCODlcdTg4QzVcdTYyMzMoXHU1NDExXHU1QkZDXHU1QjhDXHU2MjEwXHU5ODc1L1x1OEJCRVx1N0Y2RVx1OTc2Mlx1Njc3Rlx1NUM1NVx1NzkzQVx1NUI4OVx1ODhDNVx1NjVCOVx1NUYwRlx1NEUwRVx1NjVGNlx1OTVGNDtcdTRFMERcdTYyN0ZcdThGN0RcdThGRDBcdTg4NENcdTY1RjZcdTkwM0JcdThGOTEpXHUzMDAyICovXG5mdW5jdGlvbiB3cml0ZVN0YW1wKHRhcmdldDogc3RyaW5nLCB2aWE6ICducG0nIHwgJ3RneicpOiB2b2lkIHtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4odGFyZ2V0LCAnaW5zdGFsbGVkLWJ5LWhtaC1kZXNrdG9wLmpzb24nKSwgSlNPTi5zdHJpbmdpZnkoeyB2aWEsIGF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkgfSwgbnVsbCwgMiksICd1dGY4Jyk7XG4gIH0gY2F0Y2ggeyAvKiBiZXN0IGVmZm9ydCAqLyB9XG59XG5cbmZ1bmN0aW9uIGZpbmlzaEluc3RhbGwoaG9zdDogSW5zdGFsbGVySG9zdCwgZW50cnk6IHN0cmluZywgdmlhOiAnbnBtJyB8ICd0Z3onKTogdm9pZCB7XG4gIGhvc3QubG9nKGBpbnN0YWxsIGRvbmUgdmlhICR7dmlhfTogJHtlbnRyeX1gKTtcbiAgaG9zdC5zZW5kUHJvZ3Jlc3MoeyBwaGFzZTogJ2RvbmUnLCB0ZXh0OiBgXHU1Qjg5XHU4OEM1XHU1QjhDXHU2MjEwKCR7dmlhfSlgLCBlbnRyeSB9KTtcbiAgaG9zdC5vbkluc3RhbGxlZChlbnRyeSwgdmlhKTtcbiAgcnVubmluZyA9IGZhbHNlO1xufVxuIiwgIi8qKlxuICogQGhtaGFybmVzcy9jbGkgXHU1Qjg5XHU4OEM1XHU2ODM4XHU1RkMzKFx1N0VBRlx1OTAzQlx1OEY5MSxcdTk2RjYgSU8gXHUyMDE0XHUyMDE0IGZldGNoL1x1ODlFM1x1NTM4Qi9cdTg0M0RcdTc2RDhcdTU3MjhcdTRFM0JcdThGREJcdTdBMEIgaW5zdGFsbGVyIFx1OTFDQylcdTMwMDJcbiAqXG4gKiBcdTgwNENcdThEMjModjUuMSBcdTVCODlcdTg4QzVcdTU0MTFcdTVCRkMpOlx1N0VEOVx1NUI5QSByZWdpc3RyeSBcdTUxNDNcdTY1NzBcdTYzNkVcdTgzQjdcdTUzRDZcdTUxRkRcdTY1NzAsXHU4OUUzXHU2NzkwIEBobWhhcm5lc3MvY2xpIFx1NzY4NFxuICogXHU1QjhDXHU2NTc0XHU0RjlEXHU4RDU2XHU5NUVEXHU1MzA1KEBobWhhcm5lc3MvKiBcdTUxNjhcdTVCQjZcdTRFM0FcdTdDQkVcdTc4NkVcdTcyNDhcdTY3MkNcdTRFOTJcdTk0ODk7XHU1OTE2XHU5MEU4XHU0RjlEXHU4RDU2IHFyY29kZSBcdTk0RkVcdTRFM0EgXiBcdTgzMDNcdTU2RjQpLFxuICogXHU0RUE3XHU1MUZBXCJcdTg4QzVcdTRFQzBcdTRFNDhcdTMwMDFcdTRFQ0VcdTU0RUFcdTRFOUJcdTk1NUNcdTUwQ0ZcdTRFMEJcdTMwMDFcdTg4QzVcdTUyMzBcdTU0RUFcIlx1NzY4NFx1Nzg2RVx1NUI5QVx1NjAyN1x1OEJBMVx1NTIxMlx1MzAwMlx1OEJCRVx1OEJBMVx1N0VBNlx1Njc1RjpcbiAqICAtIFx1OTVFRFx1NTMwNVx1NjMwOVx1NTMwNVx1NTQwRFx1NTNCQlx1OTFDRChcdTk0QkJcdTc3RjNcdTRGOURcdThENTZcdTUzRUFcdTg4QzVcdTRFMDBcdTRFRkQsbnBtIFx1OEJFRFx1NEU0OSk7XG4gKiAgLSBcdTgzMDNcdTU2RjRcdTg5RTNcdTY3OTBcdTUzRUFcdTY1MkZcdTYzMDEgbnBtIFx1NzUxRlx1NjAwMVx1NUI5RVx1OTY0NVx1NzUyOFx1NTIzMFx1NzY4NFx1NUY2Mlx1NjAwMTpcdTdDQkVcdTc4NkUgLyBsYXRlc3QgLyAqIC8gXiAvIH4gLyA+PSxcbiAqICAgIFx1NEUwRFx1NUYxNSBzZW12ZXIgXHU1RTkzKFx1OTZGNlx1NEY5RFx1OEQ1Nlx1NTM5Rlx1NTIxOSxcdTRFMEVcdTgxRUFcdTc4MTRcdTY2RjRcdTY1QjBcdTU2NjhcdTRFMDBcdTgxRjQpO1xuICogIC0gb3B0aW9uYWxEZXBlbmRlbmNpZXMgXHU0RTBEXHU4OEM1Olx1OTVFRFx1NTMwNVx1NTE4NVx1NUI5RVx1OTY0NVx1NThGMFx1NjYwRVx1NzY4NCBvcHRpb25hbCBcdTU3NDdcdTRFM0FcdTVFNzNcdTUzRjBcdTcyNzlcdTVCOUFcbiAqICAgIChmc2V2ZW50cyBcdTdCNDkpLHRneiBcdThERUZcdTVGODRcdTRFMERcdThERDFcdTc1MUZcdTU0N0RcdTU0NjhcdTY3MUZcdTgxMUFcdTY3MkMsXHU4OEM1XHU0RTg2XHU0RTVGXHU1M0VBXHU2NjJGXHU2QjdCXHU5MUNEXHUzMDAyXG4gKi9cbmltcG9ydCB7IGNyZWF0ZUhhc2ggfSBmcm9tICdub2RlOmNyeXB0byc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgUGtnVmVyc2lvbk1ldGEge1xuICB2ZXJzaW9uOiBzdHJpbmc7XG4gIGRlcGVuZGVuY2llczogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcbiAgdGFyYmFsbDogc3RyaW5nO1xuICBpbnRlZ3JpdHk/OiBzdHJpbmcgfCB1bmRlZmluZWQ7XG59XG5cbi8qKiByZWdpc3RyeSBwYWNrdW1lbnQgXHU3Njg0XHU2NzAwXHU1QzBGXHU4QkZCXHU1M0Q2XHU5NzYyKGRpc3QtdGFncyArIFx1NTE2OFx1NzI0OFx1NjcyQ1x1NEY5RFx1OEQ1Ni90YXJiYWxsIFx1NTE0M1x1NjU3MFx1NjM2RSlcdTMwMDIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgUGFja3VtZW50IHtcbiAgJ2Rpc3QtdGFncyc6IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG4gIHZlcnNpb25zOiBSZWNvcmQ8c3RyaW5nLCB7IGRlcGVuZGVuY2llcz86IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gfCB1bmRlZmluZWQ7IGRpc3Q/OiB7IHRhcmJhbGw/OiBzdHJpbmc7IGludGVncml0eT86IHN0cmluZyB8IHVuZGVmaW5lZCB9IHwgdW5kZWZpbmVkIH0+O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFJlc29sdmVkUGtnIHtcbiAgbmFtZTogc3RyaW5nO1xuICB2ZXJzaW9uOiBzdHJpbmc7XG4gIC8qKiByZWdpc3RyeSBcdTUzOUZcdTU5Q0JcdTU3MzBcdTU3NDAoXHU5NTVDXHU1MENGXHU1MjE3XHU4ODY4XHU3NTMxIHRhcmJhbGxNaXJyb3JzIFx1NkQzRVx1NzUxRilcdTMwMDIgKi9cbiAgdGFyYmFsbDogc3RyaW5nO1xuICBpbnRlZ3JpdHk/OiBzdHJpbmcgfCB1bmRlZmluZWQ7XG59XG5cbi8qIC0tLS0gc2VtdmVyKFx1NjcwMFx1NUMwRlx1NUI5RVx1NzNCMDpcdTk1RURcdTUzMDVcdTUxODVcdTVCOUVcdTk2NDVcdTUxRkFcdTczQjBcdTc2ODRcdTVGNjJcdTYwMDEpIC0tLS0gKi9cblxuZXhwb3J0IGZ1bmN0aW9uIGNtcFNlbXZlcihhOiBzdHJpbmcsIGI6IHN0cmluZyk6IG51bWJlciB7XG4gIGNvbnN0IHBhID0gYS5yZXBsYWNlKC9edi8sICcnKS5zcGxpdCgnLScpWzBdIS5zcGxpdCgnLicpLm1hcChOdW1iZXIpO1xuICBjb25zdCBwYiA9IGIucmVwbGFjZSgvXnYvLCAnJykuc3BsaXQoJy0nKVswXSEuc3BsaXQoJy4nKS5tYXAoTnVtYmVyKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCAzOyBpKyspIHtcbiAgICBjb25zdCB4ID0gcGFbaV0gPz8gMDtcbiAgICBjb25zdCB5ID0gcGJbaV0gPz8gMDtcbiAgICBpZiAoeCAhPT0geSkgcmV0dXJuIHggPCB5ID8gLTEgOiAxO1xuICB9XG4gIHJldHVybiAwO1xufVxuXG4vKiogcmFuZ2UgXHU2NjJGXHU1NDI2XHU2M0E1XHU1M0Q3IHZlcnNpb24oXHU2NTJGXHU2MzAxIFx1N0NCRVx1Nzg2RSAvIGxhdGVzdCAvICogLyB4IC8gXiAvIH4gLyA+PTtcdTRFMERcdThCQzZcdTUyMkJcdTUyMTkgZmFsc2UpXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gc2F0aXNmaWVzKHJhbmdlOiBzdHJpbmcsIHZlcnNpb246IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCByID0gcmFuZ2UudHJpbSgpO1xuICBpZiAociA9PT0gJycgfHwgciA9PT0gJyonIHx8IHIgPT09ICdsYXRlc3QnIHx8IHIgPT09ICd4JykgcmV0dXJuIHRydWU7XG4gIGlmIChyID09PSB2ZXJzaW9uKSByZXR1cm4gdHJ1ZTtcbiAgY29uc3QgYm91bmQgPSAvXihcXF58fnw+PT8pXFxzKihcXGQrKVxcLihcXGQrKVxcLihcXGQrKS8uZXhlYyhyKTtcbiAgaWYgKGJvdW5kICE9PSBudWxsKSB7XG4gICAgY29uc3Qgb3AgPSBib3VuZFsxXSE7XG4gICAgY29uc3QgbWFqb3IgPSBOdW1iZXIoYm91bmRbMl0pO1xuICAgIGNvbnN0IG1pbm9yID0gTnVtYmVyKGJvdW5kWzNdKTtcbiAgICBjb25zdCBwYXRjaCA9IE51bWJlcihib3VuZFs0XSk7XG4gICAgY29uc3QgYyA9IGNtcFNlbXZlcih2ZXJzaW9uLCBgJHttYWpvcn0uJHttaW5vcn0uJHtwYXRjaH1gKTtcbiAgICBpZiAoYyA8IDApIHJldHVybiBmYWxzZTtcbiAgICBpZiAob3AgPT09ICc+PScpIHJldHVybiB0cnVlOyAvLyAnPj0nIFx1NEUwQlx1NzU0Q1x1NTM3M1x1NTNFRjpcdTk1RURcdTUzMDVcdTUxODVcdTUzRUFcdTRFRTUgJz49eC55LnogPHonIFx1NTkwRFx1NTQwOFx1NUY2Mlx1NjAwMVx1NTFGQVx1NzNCMCxcdTRGRERcdTVCODhcdTUzRDZcdTRFMEJcdTc1NENcbiAgICBpZiAob3AgPT09ICd+JykgcmV0dXJuIGNtcFNlbXZlcih2ZXJzaW9uLCBgJHttYWpvcn0uJHttaW5vciArIDF9LjBgKSA8IDA7XG4gICAgLy8gJ14nOjAueCBcdTcyNzlcdTUyMjQoMC4yLjMgXHU1MTQxXHU4QkI4IDAuMi56KSxcdTUxNzZcdTRGNTlcdTk1MDFcdTRFM0JcdTcyNDhcdTY3MkNcbiAgICBpZiAobWFqb3IgPT09IDApIHJldHVybiBtaW5vciA9PT0gMCA/IGNtcFNlbXZlcih2ZXJzaW9uLCBgMC4wLiR7cGF0Y2ggKyAxfWApIDwgMCA6IGNtcFNlbXZlcih2ZXJzaW9uLCBgMC4ke21pbm9yICsgMX0uMGApIDwgMDtcbiAgICByZXR1cm4gY21wU2VtdmVyKHZlcnNpb24sIGAke21ham9yICsgMX0uMC4wYCkgPCAwO1xuICB9XG4gIHJldHVybiBmYWxzZTtcbn1cblxuLyoqIFx1NEVDRSBwYWNrdW1lbnQgXHU5MDA5XHU1MUZBIHNwZWMoXHU3Q0JFXHU3ODZFL2xhdGVzdC9eL34vKilcdTYzMDdcdTU0MTFcdTc2ODRcdTcyNDhcdTY3MkM7XHU2NUUwXHU1MzM5XHU5MTREXHU4RkQ0XHU1NkRFICcnXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gcGlja1ZlcnNpb24oZG9jOiBQYWNrdW1lbnQsIHNwZWM6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHMgPSBzcGVjLnRyaW0oKTtcbiAgY29uc3QgdGFnID0gcyA9PT0gJycgfHwgcyA9PT0gJ2xhdGVzdCcgfHwgcyA9PT0gJyonID8gZG9jWydkaXN0LXRhZ3MnXT8ubGF0ZXN0IDogdW5kZWZpbmVkO1xuICBpZiAodGFnICE9PSB1bmRlZmluZWQgJiYgZG9jLnZlcnNpb25zW3RhZ10gIT09IHVuZGVmaW5lZCkgcmV0dXJuIHRhZztcbiAgaWYgKGRvYy52ZXJzaW9uc1tzXSAhPT0gdW5kZWZpbmVkKSByZXR1cm4gcztcbiAgbGV0IGJlc3QgPSAnJztcbiAgZm9yIChjb25zdCB2IG9mIE9iamVjdC5rZXlzKGRvYy52ZXJzaW9ucykpIHtcbiAgICBpZiAoc2F0aXNmaWVzKHMsIHYpICYmIGNtcFNlbXZlcih2LCBiZXN0KSA+IDApIGJlc3QgPSB2O1xuICB9XG4gIHJldHVybiBiZXN0O1xufVxuXG4vKiAtLS0tIFx1NEY5RFx1OEQ1Nlx1OTVFRFx1NTMwNSAtLS0tICovXG5cbi8qKlxuICogXHU4OUUzXHU2NzkwIHJvb3QgXHU1M0NBXHU1MTc2XHU1MTY4XHU5MEU4XHU0RjIwXHU5MDEyXHU0RjlEXHU4RDU2KEJGUyxcdTYzMDlcdTUzMDVcdTU0MERcdTUzQkJcdTkxQ0RcdTUzRDZcdTk5OTZcdTRFMkFcdTg5RTNcdTY3OTBcdTdFRDNcdTY3OUMgXHUyMDE0XHUyMDE0IFx1NEUwRSBucG0gXHU2MjQxXHU1RTczXG4gKiBcdTVFMDNcdTVDNDBcdTRFMDBcdTgxRjQpXHUzMDAyZ2V0UGFja3VtZW50IFx1NzUzMVx1OEMwM1x1NzUyOFx1NjVCOVx1NkNFOFx1NTE2NShmZXRjaCBcdTdGNTFcdTdFREMgLyBcdTZENEJcdThCRDVcdTZDRThcdTUxNjVcdTVCNTdcdTUxNzgpXHUzMDAyXG4gKiBcdTRFRkJcdTRFMDBcdTRGOURcdThENTZcdTY1RTBcdTZFRTFcdThEQjNcdTcyNDhcdTY3MkNcdTY1RjZcdTYyOUJcdTk1MTkoXHU1RTI2XHU1MzA1XHU1NDBEXHU0RTBFIHJhbmdlLFx1OTc2Mlx1NTQxMVx1NUI4OVx1ODhDNVx1OTg3NVx1OTUxOVx1OEJFRlx1NjU4N1x1Njg0OClcdTMwMDJcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlc29sdmVDbG9zdXJlKFxuICByb290OiB7IG5hbWU6IHN0cmluZzsgc3BlYzogc3RyaW5nIH0sXG4gIGdldFBhY2t1bWVudDogKG5hbWU6IHN0cmluZykgPT4gUHJvbWlzZTxQYWNrdW1lbnQ+LFxuKTogUHJvbWlzZTxSZXNvbHZlZFBrZ1tdPiB7XG4gIGNvbnN0IHJlc29sdmVkID0gbmV3IE1hcDxzdHJpbmcsIFBrZ1ZlcnNpb25NZXRhPigpO1xuICBjb25zdCBxdWV1ZTogQXJyYXk8eyBuYW1lOiBzdHJpbmc7IHNwZWM6IHN0cmluZyB9PiA9IFtyb290XTtcbiAgd2hpbGUgKHF1ZXVlLmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCB7IG5hbWUsIHNwZWMgfSA9IHF1ZXVlLnNoaWZ0KCkhO1xuICAgIGlmIChyZXNvbHZlZC5oYXMobmFtZSkpIGNvbnRpbnVlOyAvLyBcdTVERjJcdTVCOUFcdTcyNDg6XHU1NDBFXHU3RUVEIHJhbmdlIFx1NUYxNVx1NzUyOFx1NEUwRFx1NTE4RFx1OTFDRFx1ODlFMyhucG0gXHU2MjQxXHU1RTczXHU4QkVEXHU0RTQ5KVxuICAgIGNvbnN0IGRvYyA9IGF3YWl0IGdldFBhY2t1bWVudChuYW1lKTtcbiAgICBjb25zdCB2ZXJzaW9uID0gcGlja1ZlcnNpb24oZG9jLCBzcGVjKTtcbiAgICBjb25zdCBtZXRhID0gdmVyc2lvbiAhPT0gJycgPyBkb2MudmVyc2lvbnNbdmVyc2lvbl0gOiB1bmRlZmluZWQ7XG4gICAgaWYgKG1ldGEgPT09IHVuZGVmaW5lZCB8fCBtZXRhLmRpc3Q/LnRhcmJhbGwgPT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBubyB2ZXJzaW9uIG9mICR7bmFtZX0gc2F0aXNmaWVzICR7c3BlYyB8fCAnbGF0ZXN0J31gKTtcbiAgICB9XG4gICAgY29uc3QgaXRlbTogUGtnVmVyc2lvbk1ldGEgPSB7XG4gICAgICB2ZXJzaW9uLFxuICAgICAgZGVwZW5kZW5jaWVzOiBtZXRhLmRlcGVuZGVuY2llcyA/PyB7fSxcbiAgICAgIHRhcmJhbGw6IG1ldGEuZGlzdC50YXJiYWxsLFxuICAgICAgaW50ZWdyaXR5OiBtZXRhLmRpc3QuaW50ZWdyaXR5LFxuICAgIH07XG4gICAgcmVzb2x2ZWQuc2V0KG5hbWUsIGl0ZW0pO1xuICAgIGZvciAoY29uc3QgW2RlcCwgcmFuZ2VdIG9mIE9iamVjdC5lbnRyaWVzKGl0ZW0uZGVwZW5kZW5jaWVzKSkge1xuICAgICAgaWYgKCFyZXNvbHZlZC5oYXMoZGVwKSkgcXVldWUucHVzaCh7IG5hbWU6IGRlcCwgc3BlYzogcmFuZ2UgfSk7XG4gICAgfVxuICB9XG4gIHJldHVybiBbLi4ucmVzb2x2ZWQuZW50cmllcygpXS5tYXAoKFtuYW1lLCBtXSkgPT4gKHsgbmFtZSwgdmVyc2lvbjogbS52ZXJzaW9uLCB0YXJiYWxsOiBtLnRhcmJhbGwsIGludGVncml0eTogbS5pbnRlZ3JpdHkgfSkpO1xufVxuXG4vKiAtLS0tIFx1OTU1Q1x1NTBDRlx1NEUwRVx1NUUwM1x1NUM0MCAtLS0tICovXG5cbmNvbnN0IFJFR0lTVFJZX0hPU1RTID0gL14oaHR0cHM/OlxcL1xcL1teL10rKVxcLyguKikkLztcblxuLyoqXG4gKiB0YXJiYWxsIFx1NzY4NFx1OTU1Q1x1NTBDRlx1NTAxOVx1OTAwOShcdTk4N0FcdTVFOEZcdTUzNzNcdTU2REVcdTkwMDBcdTk4N0FcdTVFOEYpOlx1NTM5Rlx1NTlDQlx1NTczMFx1NTc0MCBcdTIxOTIgXHU1NDA0IHJlZ2lzdHJ5IFx1NTQwQ1x1OERFRlx1NUY4NFx1NjUzOVx1NTE5OVx1MzAwMlxuICogcGFja3VtZW50IFx1OTFDQ1x1NzY4NCBkaXN0LnRhcmJhbGwgXHU2MDUyXHU2MzA3XHU1NDExXHU1M0QxXHU1RTAzXHU2RTkwKHJlZ2lzdHJ5Lm5wbWpzLm9yZyksXHU1NkZEXHU1MTg1XHU3RjUxXHU3RURDXG4gKiBcdTRFMERcdTUzRUZcdThGQkVcdTY1RjZcdTYzMDkgcmVnaXN0cnkgXHU1MjE3XHU4ODY4XHU2NTM5XHU1MTk5IGhvc3QoXHU4REVGXHU1Rjg0XHU0RTBEXHU1M0Q4IFx1MjAxNFx1MjAxNCBucG1taXJyb3IgXHU0RTBFIG5wbWpzIFx1NTQwQ1x1Njc4NClcdTMwMDJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRhcmJhbGxNaXJyb3JzKHRhcmJhbGw6IHN0cmluZywgcmVnaXN0cmllczogc3RyaW5nW10pOiBzdHJpbmdbXSB7XG4gIGNvbnN0IG0gPSBSRUdJU1RSWV9IT1NUUy5leGVjKHRhcmJhbGwpO1xuICBjb25zdCBwYXRoID0gbT8uWzJdID8/ICcnO1xuICBjb25zdCBvdXQgPSBbdGFyYmFsbF07XG4gIGZvciAoY29uc3QgcmVnIG9mIHJlZ2lzdHJpZXMpIHtcbiAgICBjb25zdCBiYXNlID0gcmVnLnJlcGxhY2UoL1xcLyskLywgJycpO1xuICAgIGlmIChiYXNlID09PSBtPy5bMV0pIGNvbnRpbnVlO1xuICAgIGNvbnN0IHUgPSBgJHtiYXNlfS8ke3BhdGh9YDtcbiAgICBpZiAoIW91dC5pbmNsdWRlcyh1KSkgb3V0LnB1c2godSk7XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuLyoqIFx1NTMwNVx1NTcyOCBub2RlX21vZHVsZXMgXHU0RTBCXHU3Njg0XHU3NkVFXHU2ODA3XHU3NkVFXHU1RjU1KHNjb3BlZCBcdTUzMDVcdTRGRERcdTYzMDEgQHNjb3BlL25hbWUgXHU0RTI0XHU3RUE3KVx1MzAwMiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG1vZHVsZURpcihwcmVmaXg6IHN0cmluZywgbmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgcGFydHMgPSBuYW1lLnNwbGl0KCcvJykuZmlsdGVyKChwKSA9PiBwICE9PSAnJyAmJiBwICE9PSAnLicpO1xuICBpZiAobmFtZS5zdGFydHNXaXRoKCdAJykgJiYgcGFydHMubGVuZ3RoICE9PSAyKSB0aHJvdyBuZXcgRXJyb3IoYGludmFsaWQgcGFja2FnZSBuYW1lOiAke25hbWV9YCk7XG4gIGlmICghbmFtZS5zdGFydHNXaXRoKCdAJykgJiYgcGFydHMubGVuZ3RoICE9PSAxKSB0aHJvdyBuZXcgRXJyb3IoYGludmFsaWQgcGFja2FnZSBuYW1lOiAke25hbWV9YCk7XG4gIHJldHVybiBbLi4ucGFydHNdLnJlZHVjZSgoZGlyLCBwKSA9PiBgJHtkaXJ9XFxcXCR7cH1gLCBgJHtwcmVmaXh9XFxcXG5vZGVfbW9kdWxlc2ApO1xufVxuXG4vKiAtLS0tIGludGVncml0eSAtLS0tICovXG5cbi8qKiBucG0gZGlzdC5pbnRlZ3JpdHkoJ3NoYTUxMi1iYXNlNjQnKSBcdTY4MjFcdTlBOEM7XHU0RTBEXHU1MzM5XHU5MTREXHU4RkQ0XHU1NkRFIGZhbHNlKFx1NjcyQVx1NzdFNVx1N0I5N1x1NkNENVx1OEZENFx1NTZERSB0cnVlIFx1NjUzRVx1ODg0QylcdTMwMDIgKi9cbmV4cG9ydCBmdW5jdGlvbiBpbnRlZ3JpdHlPayhkYXRhOiBCdWZmZXIsIGludGVncml0eT86IHN0cmluZyk6IGJvb2xlYW4ge1xuICBpZiAoaW50ZWdyaXR5ID09PSB1bmRlZmluZWQgfHwgaW50ZWdyaXR5ID09PSAnJykgcmV0dXJuIHRydWU7XG4gIGNvbnN0IG0gPSAvXnNoYTUxMi0oW0EtWmEtejAtOSsvPV0rKSQvLmV4ZWMoaW50ZWdyaXR5LnRyaW0oKSk7XG4gIGlmIChtID09PSBudWxsKSByZXR1cm4gdHJ1ZTtcbiAgcmV0dXJuIGNyZWF0ZUhhc2goJ3NoYTUxMicpLnVwZGF0ZShkYXRhKS5kaWdlc3QoJ2Jhc2U2NCcpID09PSBtWzFdO1xufVxuXG4vKiogXHU0RUJBXHU3QzdCXHU1M0VGXHU4QkZCXHU1QjU3XHU4MjgyKFx1NUI4OVx1ODhDNVx1OEZEQlx1NUVBNlx1NjU4N1x1Njg0OFx1NzUyOClcdTMwMDIgKi9cbmV4cG9ydCBmdW5jdGlvbiBieXRlc0xhYmVsKG46IG51bWJlcik6IHN0cmluZyB7XG4gIGlmIChuIDwgMTAyNCkgcmV0dXJuIGAke259IEJgO1xuICBpZiAobiA8IDEwMjQgKiAxMDI0KSByZXR1cm4gYCR7KG4gLyAxMDI0KS50b0ZpeGVkKDApfSBLQmA7XG4gIHJldHVybiBgJHsobiAvIDEwMjQgLyAxMDI0KS50b0ZpeGVkKDEpfSBNQmA7XG59XG4iLCAiLyoqXHJcbiAqIFx1NjZGNFx1NjVCMFx1NTY2OFx1OTAxQVx1OTA1M1x1N0VBRlx1OTAzQlx1OEY5MSgyMDI2LTEwLTI5IFx1NzUyOFx1NjIzN1x1NTNDRFx1OTk4OFx1NjgzOVx1NkNCQjpcdTU2RkRcdTUxODVcdTc1MjhcdTYyMzdcdTY1MzZcdTRFMERcdTUyMzBcdTY2RjRcdTY1QjBcdTYzQThcdTkwMDEpXHUzMDAyXHJcbiAqXHJcbiAqIFx1ODBDQ1x1NjY2RjpcdTY4QzBcdTY3RTVcdTkwMUFcdTkwNTNcdTUzOUZcdTY3MkNcdTUzRUFcdThENzAgYXBpLmdpdGh1Yi5jb20gXHU3NkY0XHU4RkRFKDE1cyBcdThEODVcdTY1RjYpLFx1NTZGRFx1NTE4NVx1NjVFMFx1NEVFM1x1NzQwNlx1N0Y1MVx1N0VEQ1x1NUZDNVxyXG4gKiBcdThEODVcdTY1RjYgXHUyMTkyIGNoZWNrIGZhaWxlZCBcdTIxOTIgXHU3NTI4XHU2MjM3XHU2QzM4XHU4RkRDXHU3NzBCXHU0RTBEXHU1MjMwXHU2NUIwXHU3MjQ4XHU2NzJDO1x1NEUwQlx1OEY3RFx1OTAxQVx1OTA1M1x1NTNDRFx1ODAwQ1x1NjcwOVx1OTU1Q1x1NTBDRlx1NTZERVx1OTAwMFx1OTRGRVx1MzAwMlxyXG4gKiBcdTY3MkNcdTZBMjFcdTU3NTdcdTdFRDlcdTUxRkFcdTRFMDlcdTY3NjFcdTdFQUZcdTg5QzRcdTUyMTkobWFpbiBcdThGREJcdTdBMEJcdTRFMEUgc2NyaXB0cy9zaW0tdXBkYXRlci5tanMgXHU1MTcxXHU3NTI4LFx1NTM1NVx1NkQ0Qlx1ODk4Nlx1NzZENik6XHJcbiAqICAxKSBcdTY4QzBcdTY3RTVcdTkwMUFcdTkwNTNcdTk0RkU6XHU3NkY0XHU4RkRFKDhzLFx1NTZGRFx1NTkxNlx1NzlEMlx1OEZDNylcdTIxOTIgZ2gtcHJveHkgXHUyMTkyIGdoZmFzdCxcdTkwMTBcdTRFMkFcdThCRDVcdTUyMzBcdTYyRkZcdTUyMzAgSlNPTjtcclxuICogIDIpIFx1OTAxQVx1OTA1M1x1N0M5OFx1NjAyNzpcdTRFMEFcdTZCMjFcdTU0N0RcdTRFMkRcdTc2ODRcdTkwMUFcdTkwNTNcdTRGMThcdTUxNDgsXHU1OTMxXHU4RDI1XHU1MThEXHU1NkRFXHU5MDAwXHU1MTY4XHU5NEZFO1xyXG4gKiAgMykgXHU0RTBCXHU4RjdEXHU1NDBDXHU2RTkwXHU0RjE4XHU1MTQ4Olx1NEUwRVx1NTQ3RFx1NEUyRFx1NzY4NFx1NjhDMFx1NjdFNVx1OTAxQVx1OTA1M1x1NTQwQ1x1NkU5MFx1NzY4NFx1OTU1Q1x1NTBDRlx1NTE0OFx1OEJENSxcdTUxOERcdTc2RjRcdThGREVcdTRFMEVcdTUxNzZcdTRGNTlcdTk1NUNcdTUwQ0ZcdTMwMDJcclxuICogXHU2NUUwIGVsZWN0cm9uIFx1NEY5RFx1OEQ1NihcdTUzRUZcdTg4QUIgbm9kZSAtLWltcG9ydCB0c3ggXHU3Njg0XHU2RDRCXHU4QkQ1L1x1NkEyMVx1NjJERlx1ODExQVx1NjcyQ1x1NzZGNFx1NjNBNSBpbXBvcnQpXHUzMDAyXHJcbiAqL1xyXG5cclxuZXhwb3J0IHR5cGUgVXBkYXRlQ2hhbm5lbElkID0gJ2RpcmVjdCcgfCAnZ2gtcHJveHknIHwgJ2doZmFzdCc7XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIENoZWNrQ2hhbm5lbCB7XHJcbiAgaWQ6IFVwZGF0ZUNoYW5uZWxJZDtcclxuICAvKiogXHU4QkNBXHU2NUFEL1VJIFx1NjYzRVx1NzkzQVx1NTQwRChcdTk1MTlcdThCRUZcdTRGRTFcdTYwNkZcdTkxQ0NcdTkwMTBcdTkwMUFcdTkwNTNcdTUzRUZcdTg5QzEpXHUzMDAyICovXHJcbiAgbGFiZWw6IHN0cmluZztcclxuICAvKiogXHU1MzU1XHU5MDFBXHU5MDUzXHU4RDg1XHU2NUY2Olx1NzZGNFx1OEZERSA4cyhcdTU2RkRcdTU5MTZcdTc5RDJcdThGQzdcdTMwMDFcdTU2RkRcdTUxODVcdTVGRUJcdTkwMUZcdThCQTlcdTRGNERcdTk1NUNcdTUwQ0YpLFx1OTU1Q1x1NTBDRiAxMHNcdTMwMDIgKi9cclxuICB0aW1lb3V0TXM6IG51bWJlcjtcclxuICBhcGlVcmw6IChyZXBvOiBzdHJpbmcpID0+IHN0cmluZztcclxuICAvKiogXHU0RTBCXHU4RjdEXHU5NTVDXHU1MENGXHU1MjREXHU3RjAwKCcnID0gXHU3NkY0XHU4RkRFIGFzc2V0IHVybCk7XHU5ODdCXHU1NzI4IERPV05MT0FEX01JUlJPUl9QUkVGSVhFUyBcdTZFMDVcdTUzNTVcdTUxODVcdTMwMDIgKi9cclxuICBkb3dubG9hZFByZWZpeDogc3RyaW5nO1xyXG59XHJcblxyXG5jb25zdCBnaXRodWJMYXRlc3QgPSAocmVwbzogc3RyaW5nKTogc3RyaW5nID0+IGBodHRwczovL2FwaS5naXRodWIuY29tL3JlcG9zLyR7cmVwb30vcmVsZWFzZXMvbGF0ZXN0YDtcclxuXHJcbi8qKiBcdTY4QzBcdTY3RTVcdTkwMUFcdTkwNTNcdTk0RkUoXHU5RUQ4XHU4QkE0XHU5ODdBXHU1RThGKVx1MzAwMiAqL1xyXG5leHBvcnQgY29uc3QgQ0hFQ0tfQ0hBTk5FTFM6IHJlYWRvbmx5IENoZWNrQ2hhbm5lbFtdID0gW1xyXG4gIHsgaWQ6ICdkaXJlY3QnLCBsYWJlbDogJ1x1NzZGNFx1OEZERScsIHRpbWVvdXRNczogOF8wMDAsIGFwaVVybDogZ2l0aHViTGF0ZXN0LCBkb3dubG9hZFByZWZpeDogJycgfSxcclxuICB7IGlkOiAnZ2gtcHJveHknLCBsYWJlbDogJ2doLXByb3h5JywgdGltZW91dE1zOiAxMF8wMDAsIGFwaVVybDogKHJlcG8pID0+IGBodHRwczovL2doLXByb3h5LmNvbS8ke2dpdGh1YkxhdGVzdChyZXBvKX1gLCBkb3dubG9hZFByZWZpeDogJ2h0dHBzOi8vZ2gtcHJveHkuY29tLycgfSxcclxuICB7IGlkOiAnZ2hmYXN0JywgbGFiZWw6ICdnaGZhc3QnLCB0aW1lb3V0TXM6IDEwXzAwMCwgYXBpVXJsOiAocmVwbykgPT4gYGh0dHBzOi8vZ2hmYXN0LnRvcC8ke2dpdGh1YkxhdGVzdChyZXBvKX1gLCBkb3dubG9hZFByZWZpeDogJ2h0dHBzOi8vZ2hmYXN0LnRvcC8nIH0sXHJcbl07XHJcblxyXG4vKiogXHU0RTBCXHU4RjdEXHU5NTVDXHU1MENGXHU1MTY4XHU2RTA1XHU1MzU1KFx1OUVEOFx1OEJBNFx1OTg3QVx1NUU4RjtnaHByb3h5LmNuIFx1NEVDNVx1NEUwQlx1OEY3RFx1NTE1Q1x1NUU5NSxcdTRFMERcdTUwNUFcdTY4QzBcdTY3RTVcdTkwMUFcdTkwNTMpXHUzMDAyICovXHJcbmV4cG9ydCBjb25zdCBET1dOTE9BRF9NSVJST1JfUFJFRklYRVM6IHJlYWRvbmx5IHN0cmluZ1tdID0gWycnLCAnaHR0cHM6Ly9naGZhc3QudG9wLycsICdodHRwczovL2doLXByb3h5LmNvbS8nLCAnaHR0cHM6Ly9naHByb3h5LmNuLyddO1xyXG5cclxuLyoqIFx1NUI1OFx1NTBBOFx1NTAzQy9JUEMgXHU1MDNDXHU1RjUyXHU0RTAwOlx1NTQwOFx1NkNENVx1OTAxQVx1OTA1MyBpZCBcdTYyMTYgbnVsbChcdTdDOThcdTYwMjdcdTY1ODdcdTRFRjZcdTYzNUZcdTU3NEYvXHU2NUU3XHU3MjQ4XHU2NzJDXHU2QjhCXHU3NTU5XHU2NUY2XHU0RTBEXHU4MUY0XHU1NDdEKVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplQ2hhbm5lbCh2OiB1bmtub3duKTogVXBkYXRlQ2hhbm5lbElkIHwgbnVsbCB7XHJcbiAgcmV0dXJuIHR5cGVvZiB2ID09PSAnc3RyaW5nJyAmJiBDSEVDS19DSEFOTkVMUy5zb21lKChjKSA9PiBjLmlkID09PSB2KSA/ICh2IGFzIFVwZGF0ZUNoYW5uZWxJZCkgOiBudWxsO1xyXG59XHJcblxyXG4vKiogXHU3Qzk4XHU2MDI3XHU2MzkyXHU1RThGOlx1NEUwQVx1NkIyMVx1NTQ3RFx1NEUyRFx1OTAxQVx1OTA1M1x1NEYxOFx1NTE0OCxcdTUxNzZcdTRGNTlcdTRGRERcdTYzMDFcdTlFRDhcdThCQTRcdTk0RkVcdTVFOEYoXHU0RUZCXHU0RTAwXHU5MDFBXHU5MDUzXHU1OTMxXHU4RDI1XHU0RUNEXHU1M0VGXHU1MTY4XHU5NEZFXHU1NkRFXHU5MDAwKVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gb3JkZXJlZENoZWNrQ2hhbm5lbHMoc3RpY2t5OiB1bmtub3duKTogcmVhZG9ubHkgQ2hlY2tDaGFubmVsW10ge1xyXG4gIGNvbnN0IHMgPSBub3JtYWxpemVDaGFubmVsKHN0aWNreSk7XHJcbiAgY29uc3QgZmlyc3QgPSBzID09PSBudWxsID8gdW5kZWZpbmVkIDogQ0hFQ0tfQ0hBTk5FTFMuZmluZCgoYykgPT4gYy5pZCA9PT0gcyk7XHJcbiAgaWYgKGZpcnN0ID09PSB1bmRlZmluZWQpIHJldHVybiBDSEVDS19DSEFOTkVMUztcclxuICByZXR1cm4gW2ZpcnN0LCAuLi5DSEVDS19DSEFOTkVMUy5maWx0ZXIoKGMpID0+IGMuaWQgIT09IHMpXTtcclxufVxyXG5cclxuLyoqIFx1NEUwQlx1OEY3RFx1OTU1Q1x1NTBDRlx1OTg3QVx1NUU4RjpcdTU0N0RcdTRFMkRcdTY4QzBcdTY3RTVcdTkwMUFcdTkwNTNcdTc2ODRcdTU0MENcdTZFOTBcdTk1NUNcdTUwQ0ZcdTRGMThcdTUxNDggXHUyMTkyIFx1NzZGNFx1OEZERSBcdTIxOTIgXHU1MTc2XHU0RjU5XHU5NTVDXHU1MENGKFx1NTNCQlx1OTFDRCw0IFx1OTAxQVx1OTA1M1x1NkUwNVx1NTM1NVx1NEZERFx1NzU1OSlcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIG9yZGVyZWREb3dubG9hZE1pcnJvcnMoYXNzZXRVcmw6IHN0cmluZywgY2hhbm5lbDogdW5rbm93bik6IHJlYWRvbmx5IHN0cmluZ1tdIHtcclxuICBjb25zdCBoaXQgPSBub3JtYWxpemVDaGFubmVsKGNoYW5uZWwpO1xyXG4gIGNvbnN0IHByZWZpeCA9IGhpdCA9PT0gbnVsbCA/ICcnIDogQ0hFQ0tfQ0hBTk5FTFMuZmluZCgoYykgPT4gYy5pZCA9PT0gaGl0KT8uZG93bmxvYWRQcmVmaXggPz8gJyc7XHJcbiAgY29uc3QgcHJlZml4ZXMgPSBbLi4ubmV3IFNldChbcHJlZml4LCAuLi5ET1dOTE9BRF9NSVJST1JfUFJFRklYRVNdKV07XHJcbiAgcmV0dXJuIHByZWZpeGVzLm1hcCgocCkgPT4gKHAgPT09ICcnID8gYXNzZXRVcmwgOiBgJHtwfSR7YXNzZXRVcmx9YCkpO1xyXG59XHJcblxyXG4vKiogXHU1MTY4XHU5MDFBXHU5MDUzXHU1OTMxXHU4RDI1XHU3Njg0XHU5NTE5XHU4QkVGXHU0RTMyOlx1OTAxMFx1OTAxQVx1OTA1M1x1NTIxN1x1NTFGQVx1NTM5Rlx1NTZFMChcdTdGNTFcdTdFRENcdThCQ0FcdTY1QURcdTc1Mjg7VUkgXHU2NkY0XHU2NUIwXHU5NzYyXHU2NzdGXHU3MTY3XHU1RTM4XHU2NjNFXHU3OTNBKVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gc3VtbWFyaXplQ2hlY2tGYWlsdXJlcyhmYWlsdXJlczogUmVhZG9ubHlBcnJheTx7IGxhYmVsOiBzdHJpbmc7IHJlYXNvbjogc3RyaW5nIH0+KTogc3RyaW5nIHtcclxuICByZXR1cm4gZmFpbHVyZXMubWFwKChmKSA9PiBgJHtmLmxhYmVsfToke2YucmVhc29ufWApLmpvaW4oJzsgJyk7XHJcbn1cclxuIl0sCiAgIm1hcHBpbmdzIjogIjtBQWNBLFNBQVMsT0FBQUEsTUFBSyxlQUFlLFFBQVEsU0FBUyxTQUFTLE9BQU8sTUFBTSxjQUFjLE1BQU0sYUFBYSxtQkFBbUI7QUFDeEgsU0FBUyxRQUFBQyxPQUFNLFNBQVMsVUFBVSxZQUFZLGVBQWU7QUFDN0QsU0FBUyxjQUFBQyxhQUFZLGdCQUFBQyxlQUFjLG9CQUFvQjtBQUN2RCxTQUFTLGFBQUFDLFlBQVcsZ0JBQWdCO0FBQ3BDLFNBQVMsV0FBQUMsVUFBUyx5QkFBeUI7QUFDM0MsU0FBUyxjQUFjLFNBQUFDLGNBQWE7QUFDcEMsU0FBUyxpQkFBQUMsc0JBQXFCOzs7QUNWOUIsU0FBUyxhQUFnQztBQUN6QyxTQUFTLHVCQUF1QjtBQUNoQyxTQUFTLG1CQUFtQjs7O0FDRHJCLElBQU0sY0FBYztBQUFBLEVBQ3pCO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFDRjtBQUlPLElBQU0sdUJBQXVCOzs7QUNsQjdCLElBQU0sY0FBYztBQUFBLEVBQ3pCO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFDRjtBQUlPLElBQU0sbUJBQW1CLENBQUMsYUFBYSxVQUFVLFVBQVUsV0FBVztBQWN0RSxTQUFTLGFBQ2QsTUFDQSxTQUNBLE9BQXFHLENBQUMsR0FDeEY7QUFDZCxRQUFNLElBQWtCLEVBQUUsTUFBTSxTQUFTLFdBQVcsS0FBSyxjQUFjLEtBQUs7QUFDNUUsTUFBSSxLQUFLLGNBQWMsT0FBVyxHQUFFLFlBQVksS0FBSztBQUNyRCxNQUFJLEtBQUssVUFBVSxPQUFXLEdBQUUsUUFBUSxLQUFLO0FBQzdDLE1B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QUFPQTtBQVFBO0FBV0E7QUFrRUE7QUFLQTtBQWlCQTtBQUtBO0FBWUE7QUFvQkE7QUFvSEE7QUFZQTtBQVdBOyIsCiAgIm5hbWVzIjogWyJhcHAiLCAiam9pbiIsICJleGlzdHNTeW5jIiwgInJlYWxwYXRoU3luYyIsICJ3cml0ZUZpbGUiLCAiaG9tZWRpciIsICJzcGF3biIsICJwYXRoVG9GaWxlVVJMIiwgInJlc29sdmUiLCAicmFuZG9tVVVJRCIsICJyYW5kb21VVUlEIiwgInJlc29sdmUiLCAiYXBwIiwgIm1rZGlyIiwgIndyaXRlRmlsZSIsICJqb2luIiwgInNsZWVwIiwgInNwYXduIiwgImpvaW4iLCAiam9pbiIsICJyZXNvbHZlIiwgInNwYXduIiwgImpvaW4iLCAiam9pbiIsICJhcHAiLCAicHVzaEV2ZW50IiwgIm5vdGlmeUV2ZW50IiwgImZvY3VzTWFpbldpbmRvdyIsICJzZXR1cFRyYXkiLCAiYXBwbHlDaHJvbWUiLCAiYXBwbHlVcGRhdGUiLCAic3Bhd24iLCAiYnVpbGRBcHBNZW51IiwgInBvcHVwTWFpbk1lbnUiLCAid2ViQXV0b3N0YXJ0SW5zdGFsbGVkIiwgImV4aXN0c1N5bmMiLCAibGFuSXBPZiIsICJjbGlFbnRyeU9mIiwgInJlcG9Sb290T2YiLCAicGtnTmFtZUF0IiwgInJ1bkNsaSIsICJicm9hZGNhc3RIb3N0U3RhdGUiLCAicGtnVmVyc2lvbkF0IiwgImVudHJ5RnJvbUNsaURpciIsICJkZXRlY3RFeHRlcm5hbFJ1bnRpbWUiLCAicmVhbHBhdGhTeW5jIiwgImhvbWVkaXIiLCAiZGV0ZWN0UmVhbEVudHJ5IiwgImJ1bmRsZWRSdW50aW1lUGF0aCIsICJidW5kbGVkUnVudGltZUluZm8iLCAibnBtT25QYXRoIiwgIndpemFyZFN1cHByZXNzZWQiLCAic2VuZGVyVHJ1c3RlZCIsICJob3N0Q2FsbCIsICJyZWdpc3RlcklwYyIsICJ3cml0ZUZpbGUiLCAidyIsICJwYXRoVG9GaWxlVVJMIiwgImFwcDIiXQp9Cg==
