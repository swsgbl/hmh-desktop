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
      await step("\u5411\u5BFC:\u5F00\u59CB\u914D\u7F6E\u2192\u68C0\u6D4B(\u4F2A\u9020\u672A\u88C5)\u2192\u81EA\u52A8\u8FDB\u9009\u62E9\u9875(\u4E09\u9009\u4E00+\u5168\u5C40\u914D\u7F6E\u63D0\u793A)", async () => {
        await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.wizard-overlay button')).find(function(x){return x.textContent.trim()==='\u5F00\u59CB\u914D\u7F6E';}); if(b) b.click(); })()`);
        const w = await waitFor("select page", `var p=document.querySelector('.wizard-card.wizard-page-select');
          if(!p) return {ok:false, detail:'not on select'};
          var t=p.textContent;
          var o1=t.indexOf('\u4E0B\u8F7D\u5B89\u88C5\u5B8C\u6574 hmh CLI')>=0, o2=t.indexOf('\u4F7F\u7528\u5185\u7F6E\u7CBE\u7B80\u5185\u6838')>=0, o3=t.indexOf('\u8DF3\u8FC7(\u6F14\u793A\u6A21\u5F0F)')>=0, note=t.indexOf('.hmharness')>=0;
          return {ok: o1&&o2&&o3&&note, detail: 'opt1='+o1+' opt2='+o2+' opt3='+o3+' note='+note};`, 12e3);
        await shot("wizard-select");
        return w;
      });
      await step("\u5411\u5BFC:\u9009\u5185\u7F6E\u7CBE\u7B80\u5185\u6838\u2192\u914D\u7F6E\u8DF3\u8FC7\u2192\u5B8C\u6210\u9875\u2192\u5F00\u59CB\u4F7F\u7528\u2192\u5173\u95ED\u4E14\u5DF2\u8FDE\u63A5", async () => {
        await js(`(function(){ var o=[].slice.call(document.querySelectorAll('.wizard-opt')).find(function(x){return x.textContent.indexOf('\u4F7F\u7528\u5185\u7F6E\u7CBE\u7B80\u5185\u6838')>=0;}); if(o) o.click(); })()`);
        await sleep(300);
        await js(`(function(){ var b=[].slice.call(document.querySelectorAll('.wizard-overlay button')).find(function(x){return x.textContent.trim()==='\u4E0B\u4E00\u6B65'||x.textContent.trim()==='\u5F00\u59CB\u5B89\u88C5';}); if(b) b.click(); })()`);
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
            detail: `\u672C\u5730\u4F18\u5148\u7684 HMH Agent \u56FE\u5F62\u5DE5\u4F5C\u53F0 v${app3.getVersion()}
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
        return { found: false, version: "", entry: "", source: "", bundled: info, npm: npmOnPath2() };
      }
      const d = detectExternalRuntime2();
      return { found: d.entry !== "", version: d.version, entry: d.entry, source: d.source, bundled: info, npm: npmOnPath2() };
    });
    ipcMain.handle("bridge:install-cli", (event, opts) => {
      if (!senderTrusted2(event.senderFrame)) return { error: "untrusted sender", code: "FORBIDDEN" };
      const o = opts ?? {};
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
  let updateState = { checking: false, currentVersion: app3.getVersion(), latest: null, notes: "", downloaded: false, error: "" };
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
    logInfo("update", `checking\u2026 (current v${app3.getVersion()})`);
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
      if (tag !== "" && cmpVersion(app3.getVersion(), tag) < 0 && !updateState.downloaded) {
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
      const dest = join4(app3.getPath("temp"), asset.name);
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
      minWidth: 560,
      // HIG 阶段2:04 号规格窄窗 ≥560;原 960 使 ≤820px 抽屉断点实际不可达
      minHeight: 600,
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vZWxlY3Ryb24vbWFpbi9pbmRleC50cyIsICIuLi8uLi8uLi8uLi9wYWNrYWdlcy9ob3N0LWFkYXB0ZXIvc3JjL3N1cGVydmlzb3IudHMiLCAiLi4vLi4vLi4vLi4vcGFja2FnZXMvY29udHJhY3RzL3NyYy9ldmVudC50cyIsICIuLi8uLi8uLi8uLi9wYWNrYWdlcy9jb250cmFjdHMvc3JjL2Vycm9yLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2NvbnRyYWN0cy9zcmMvZ3VhcmRzLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2hvc3QtYWRhcHRlci9zcmMvY2xpZW50LnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2hvc3QtYWRhcHRlci9zcmMvZmFrZS1ob3N0LnRzIiwgIi4uLy4uL2VsZWN0cm9uL21haW4vdWl2ZXJpZnkudHMiLCAiLi4vLi4vZWxlY3Ryb24vbWFpbi92aXN1YWxyZWdyZXNzaW9uLnRzIiwgIi4uLy4uL2VsZWN0cm9uL21haW4vaW5zdGFsbGVyLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2NsaS1pbnN0YWxsZXIvc3JjL2luZGV4LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcclxuICogSE1IIERlc2t0b3AgXHUyMDE0IEVsZWN0cm9uIFx1NEUzQlx1OEZEQlx1N0EwQihBRFItMDAxLzAwMy8wMDQpXHUzMDAyXHJcbiAqXHJcbiAqIFx1NUI4OVx1NTE2OFx1NEUwRFx1NTNEOFx1OTFDRihcdTVGMDBcdTUzRDFcdThCQTFcdTUyMTIgTTAgXHU1MUZBXHU1M0UzXHU5NUU4ICsgRWxlY3Ryb24gXHU1Qjk4XHU2NUI5XHU1Qjg5XHU1MTY4XHU2RTA1XHU1MzU1KTpcclxuICogIC0gcmVuZGVyZXI6Y29udGV4dElzb2xhdGlvbiArIHNhbmRib3ggKyBcdTc5ODEgbm9kZUludGVncmF0aW9uLFx1NEUyNVx1NjgzQyBDU1A7XHJcbiAqICAtIFx1NUJGQ1x1ODIyQS9cdTY1QjBcdTdBOTdcdTUzRTNcdTRFMDBcdTVGOEJcdTYyRDJcdTdFREQoXHU1M0VBXHU1MkEwXHU4RjdEXHU2MjExXHU0RUVDXHU4MUVBXHU1REYxXHU3Njg0IHJlbmRlcmVyKTtcclxuICogIC0gXHU2QkNGXHU2NzYxIElQQyBcdTY4MjFcdTlBOEMgc2VuZGVyIFx1NzY4NFx1OTg3Nlx1NUM0MiBmcmFtZSBVUkwgXHU1QzVFXHU0RThFXHU2NzJDXHU1RTk0XHU3NTI4LFx1OTAxQVx1OTA1M1x1NzY3RFx1NTQwRFx1NTM1NTtcclxuICogIC0gaG9zdCB0b2tlbiBcdTUzRUFcdTVCNThcdTU3MjhcdTRFOEVcdTY3MkNcdThGREJcdTdBMEJcdTRFMEVcdTVCNTBcdThGREJcdTdBMEIgZW52LFx1NjVFNVx1NUZEN1x1OEY5M1x1NTFGQVx1NTI0RFx1NTE0OFx1ODEzMVx1NjU0RjtcclxuICogIC0gXHU1MzU1XHU1QjlFXHU0RjhCXHU5NTAxO1x1OTAwMFx1NTFGQVx1NjVGNlx1NTNFQVx1NTA1Q1x1NkI2Mlx1ODFFQVx1NURGMSBzcGF3biBcdTc2ODQgaG9zdChcdTRGMThcdTk2QzVcdTIxOTJcdTUxNUNcdTVFOTUga2lsbClcdTMwMDJcclxuICpcclxuICogXHU5NjM2XHU2QkI1RSgyMDI2LTEwLTEwKTptYWluIFx1NjMwMVx1NjcwOSBEZXNrdG9wSG9zdENsaWVudCxTU0UgXHU0RkUxXHU1QzAxXHU2RDQxKGV2ZW50OiBobWgpXHJcbiAqIFx1N0VDRiA1MG1zIFx1NjI3OVx1OTFDRlx1NjNBOFx1N0VEOSByZW5kZXJlcjtzZW5kVGFzay9hcHByb3ZlL2ludGVycnVwdC9zZXNzaW9ucyBcdTUxNjhcdTkwRThcdThGNkNcdTUzRDFcclxuICogXHU3RUQ5IGhvc3QgXHUyMDE0XHUyMDE0IGZha2UgXHU0RTBFXHU3NzFGXHU1QjlFIGhtaGFybmVzcyBkZXNrdG9wLWhvc3QgXHU4RDcwXHU1NDBDXHU0RTAwXHU2NzYxXHU0RUUzXHU3ODAxXHU4REVGXHU1Rjg0XHUzMDAyXHJcbiAqL1xyXG5pbXBvcnQgeyBhcHAsIEJyb3dzZXJXaW5kb3csIGRpYWxvZywgaXBjTWFpbiwgc2Vzc2lvbiwgc2hlbGwsIFRyYXksIE5vdGlmaWNhdGlvbiwgTWVudSwgbmF0aXZlSW1hZ2UsIG5hdGl2ZVRoZW1lIH0gZnJvbSAnZWxlY3Ryb24nO1xyXG5pbXBvcnQgeyBqb2luLCBkaXJuYW1lLCBiYXNlbmFtZSwgaXNBYnNvbHV0ZSwgcmVzb2x2ZSB9IGZyb20gJ25vZGU6cGF0aCc7XHJcbmltcG9ydCB7IGV4aXN0c1N5bmMsIHJlYWxwYXRoU3luYywgcmVhZEZpbGVTeW5jIH0gZnJvbSAnbm9kZTpmcyc7XHJcbmltcG9ydCB7IHdyaXRlRmlsZSwgcmVhZEZpbGUgfSBmcm9tICdub2RlOmZzL3Byb21pc2VzJztcclxuaW1wb3J0IHsgaG9tZWRpciwgbmV0d29ya0ludGVyZmFjZXMgfSBmcm9tICdub2RlOm9zJztcclxuaW1wb3J0IHsgZXhlY0ZpbGVTeW5jLCBzcGF3biB9IGZyb20gJ25vZGU6Y2hpbGRfcHJvY2Vzcyc7XHJcbmltcG9ydCB7IHBhdGhUb0ZpbGVVUkwgfSBmcm9tICdub2RlOnVybCc7XHJcbmltcG9ydCB7IHJhbmRvbVVVSUQgfSBmcm9tICdub2RlOmNyeXB0byc7XHJcbmltcG9ydCB7IERlc2t0b3BSdW50aW1lU3VwZXJ2aXNvciwgRGVza3RvcEhvc3RDbGllbnQsIGVudmVsb3BlRnJvbUZyYW1lLCB0eXBlIEhvc3RTdGF0ZSB9IGZyb20gJ0BobWgtZGVza3RvcC9ob3N0LWFkYXB0ZXInO1xyXG5pbXBvcnQgeyBpc0V2ZW50RW52ZWxvcGUsIHR5cGUgRXZlbnRFbnZlbG9wZSB9IGZyb20gJ0BobWgtZGVza3RvcC9jb250cmFjdHMnO1xyXG5pbXBvcnQgeyBhdHRhY2hVaVZlcmlmeSB9IGZyb20gJy4vdWl2ZXJpZnkudHMnO1xyXG5pbXBvcnQgeyBhdHRhY2hWaXN1YWxSZWdyZXNzaW9uIH0gZnJvbSAnLi92aXN1YWxyZWdyZXNzaW9uLnRzJztcclxuaW1wb3J0IHsgaW5zdGFsbFRhcmdldCwgcmVzb2x2ZUluc3RhbGxlZEVudHJ5LCBzdGFydENsaUluc3RhbGwsIHR5cGUgSW5zdGFsbFByb2dyZXNzIH0gZnJvbSAnLi9pbnN0YWxsZXIudHMnO1xyXG5cclxuY29uc3QgaGVyZSA9IGltcG9ydC5tZXRhLmRpcm5hbWUgPz8gJy4nO1xyXG5jb25zdCBpc0RldiA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX0RFViA9PT0gJzEnO1xyXG5jb25zdCByZW5kZXJlckRldlVybCA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1JFTkRFUkVSX1VSTCA/PyAnJztcclxuY29uc3QgcHJlbG9hZFBhdGggPSBqb2luKGhlcmUsICcuLi9wcmVsb2FkL2luZGV4LmNqcycpO1xyXG5cclxuLyogLS0tLSBcdTY1RTVcdTVGRDdcdTgxMzFcdTY1NEY6dG9rZW4vYXV0aG9yaXphdGlvbiBcdTZDMzhcdTRFMERcdThGREJcdTYzQTdcdTUyMzZcdTUzRjAgLS0tLSAqL1xyXG5jb25zdCBzZWNyZXRzOiBzdHJpbmdbXSA9IFtdO1xyXG5mdW5jdGlvbiByZWRhY3Qoczogc3RyaW5nKTogc3RyaW5nIHtcclxuICBsZXQgb3V0ID0gcztcclxuICBmb3IgKGNvbnN0IHNlYyBvZiBzZWNyZXRzKSB7XHJcbiAgICBpZiAoc2VjLmxlbmd0aCA+PSA4KSBvdXQgPSBvdXQuc3BsaXQoc2VjKS5qb2luKCdbcmVkYWN0ZWRdJyk7XHJcbiAgfVxyXG4gIHJldHVybiBvdXQ7XHJcbn1cclxuZnVuY3Rpb24gbG9nSW5mbyh0YWc6IHN0cmluZywgbXNnOiBzdHJpbmcpOiB2b2lkIHtcclxuICBjb25zb2xlLmxvZyhgW2htaC1kZXNrdG9wOiR7dGFnfV0gJHtyZWRhY3QobXNnKX1gKTtcclxufVxyXG5cclxuLyogLS0tLSBcdTUzNTVcdTVCOUVcdTRGOEIgLS0tLSAqL1xyXG5pZiAoIWFwcC5yZXF1ZXN0U2luZ2xlSW5zdGFuY2VMb2NrKCkpIHtcclxuICBhcHAucXVpdCgpO1xyXG59IGVsc2Uge1xyXG4gIGFwcC5vbignc2Vjb25kLWluc3RhbmNlJywgKCkgPT4ge1xyXG4gICAgY29uc3Qgd2luID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKClbMF07XHJcbiAgICBpZiAod2luKSB7XHJcbiAgICAgIGlmICh3aW4uaXNNaW5pbWl6ZWQoKSkgd2luLnJlc3RvcmUoKTtcclxuICAgICAgd2luLmZvY3VzKCk7XHJcbiAgICB9XHJcbiAgfSk7XHJcblxyXG4gIC8qIC0tLS0gaG9zdCBcdTc2RDFcdTdCQTEgKyBcdTY4NjVcdTVCQTJcdTYyMzdcdTdBRUYgLS0tLSAqL1xyXG4gIGludGVyZmFjZSBCcmlkZ2VTbmFwc2hvdCB7XHJcbiAgICBob3N0U3RhdGU6IEhvc3RTdGF0ZTtcclxuICAgIGhvc3RQb3J0OiBudW1iZXIgfCBudWxsO1xyXG4gICAgaG9zdFZlcnNpb246IHN0cmluZyB8IG51bGw7XHJcbiAgICBsYXN0RXJyb3I6IHN0cmluZyB8IG51bGw7XHJcbiAgICBtb2RlOiAnZmFrZScgfCAncmVhbCc7XHJcbiAgICBydW50aW1lRW50cnk6IHN0cmluZyB8IG51bGw7XHJcbiAgfVxyXG4gIGxldCBzdXBlcnZpc29yOiBEZXNrdG9wUnVudGltZVN1cGVydmlzb3IgfCBudWxsID0gbnVsbDtcclxuICBsZXQgY2xpZW50OiBEZXNrdG9wSG9zdENsaWVudCB8IG51bGwgPSBudWxsO1xyXG4gIGxldCBicmlkZ2U6IEJyaWRnZVNuYXBzaG90ID0geyBob3N0U3RhdGU6ICdzdG9wcGVkJywgaG9zdFBvcnQ6IG51bGwsIGhvc3RWZXJzaW9uOiBudWxsLCBsYXN0RXJyb3I6IG51bGwsIG1vZGU6ICdmYWtlJywgcnVudGltZUVudHJ5OiBudWxsIH07XHJcbiAgLyoqIFx1NEU4Qlx1NEVGNlx1NjI3OVx1OTFDRlx1N0YxM1x1NTFCMjpcdTlBRDhcdTk4OTEgU1NFIFx1NEUwRFx1OTAxMFx1Njc2MVx1OEZDNyBJUEMsNTBtcyBcdTYyNzlcdTkxQ0YgZmx1c2goXHU2RTMyXHU2N0QzXHU0RTBEXHU1MzYxKVx1MzAwMiAqL1xyXG4gIGxldCBldmVudEJ1ZmZlcjogRXZlbnRFbnZlbG9wZVtdID0gW107XHJcbiAgbGV0IGZsdXNoVGltZXI6IE5vZGVKUy5UaW1lb3V0IHwgbnVsbCA9IG51bGw7XHJcbiAgbGV0IHNzZUFib3J0OiBBYm9ydENvbnRyb2xsZXIgfCBudWxsID0gbnVsbDtcclxuICBsZXQgbGFzdEV2ZW50SWQgPSAnJztcclxuICAvKiogXHU2NzJBXHU3N0U1L1x1NzU3OFx1NUY2Mlx1NEZFMVx1NUMwMVx1OEJBMVx1NjU3MChTQ0hFTUFfTUlTTUFUQ0ggXHU5NzYyXHU1NDExXHU4QkNBXHU2NUFELFx1NEUwRFx1NUQyOSlcdTMwMDIgKi9cclxuICBsZXQgZHJvcHBlZEZyYW1lcyA9IDA7XHJcblxyXG4gIGZ1bmN0aW9uIHB1c2hFdmVudChlbnY6IEV2ZW50RW52ZWxvcGUpOiB2b2lkIHtcclxuICAgIGV2ZW50QnVmZmVyLnB1c2goZW52KTtcclxuICAgIGlmIChldmVudEJ1ZmZlci5sZW5ndGggPiAyXzAwMCkgZXZlbnRCdWZmZXIuc3BsaWNlKDAsIGV2ZW50QnVmZmVyLmxlbmd0aCAtIDJfMDAwKTtcclxuICAgIGlmIChmbHVzaFRpbWVyID09PSBudWxsKSB7XHJcbiAgICAgIGZsdXNoVGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHtcclxuICAgICAgICBmbHVzaFRpbWVyID0gbnVsbDtcclxuICAgICAgICBjb25zdCBiYXRjaCA9IGV2ZW50QnVmZmVyO1xyXG4gICAgICAgIGV2ZW50QnVmZmVyID0gW107XHJcbiAgICAgICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XHJcbiAgICAgICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCdicmlkZ2U6ZXZlbnQtYmF0Y2gnLCBiYXRjaCk7XHJcbiAgICAgICAgfVxyXG4gICAgICB9LCA1MCk7XHJcbiAgICB9XHJcbiAgICBub3RpZnlFdmVudChlbnYpO1xyXG4gIH1cclxuXHJcbiAgLyogLS0tLSBcdTdDRkJcdTdFREZcdTYyNThcdTc2RDggKyBcdTkwMUFcdTc3RTUoMDMgXHU1M0Y3IFx1MDBBN1x1NEUwMDpcdTY4NENcdTk3NjJcdTRFQTdcdTU0QzFcdTk3MDBcdTg5ODFcdTdDRkJcdTdFREZcdTYyNThcdTc2RDhcdTMwMDFcdTkwMUFcdTc3RTUpIC0tLS1cclxuICAgICBcdTVCQTFcdTYyNzlcdTdCNDlcdTVGODVcdTVGQzVcdTk4N0JcdTYyNTNcdTYyNzAoXHU3NTI4XHU2MjM3XHU1RkM1XHU5ODdCXHU1MUIzXHU3QjU2KTtcdTVCOENcdTYyMTAvXHU1OTMxXHU4RDI1XHU0RUM1XHU1NzI4XHU3QTk3XHU1M0UzXHU1OTMxXHU3MTI2XHU2NUY2XHU2M0QwXHU5MTkyXHUzMDAyICovXHJcbiAgY29uc3QgVFJBWV9JQ09OX0JBU0U2NCA9ICdpVkJPUncwS0dnb0FBQUFOU1VoRVVnQUFBQkFBQUFBUUNBWUFBQUFmOC85aEFBQUFSMGxFUVZSNG5HTmdRQVBTc29yLzhXRjA5VVJyeEdzUXFab3hESUVKNkRkK0IyTjBoYmpFTVd3bjFRQ3dJWVBUQUZ5WWZnWU1mQmlRWkFERkNZa3FTWm5pekVSSmRnWUFsTDVyc0RjMmFUY0FBQUFBU1VWT1JLNUNZSUk9JztcclxuICBsZXQgdHJheTogVHJheSB8IG51bGwgPSBudWxsO1xyXG4gIGNvbnN0IHNlbmRNZW51QWN0aW9uID0gKGE6IHN0cmluZyk6IHZvaWQgPT4ge1xyXG4gICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XHJcbiAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ21lbnU6YWN0aW9uJywgYSk7XHJcbiAgICB9XHJcbiAgfTtcclxuICBmdW5jdGlvbiBmb2N1c01haW5XaW5kb3coKTogdm9pZCB7XHJcbiAgICBjb25zdCB3aW4gPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5maW5kKCh3KSA9PiAhdy5pc0Rlc3Ryb3llZCgpKTtcclxuICAgIGlmICh3aW4gPT09IHVuZGVmaW5lZCkgcmV0dXJuO1xyXG4gICAgaWYgKHdpbi5pc01pbmltaXplZCgpKSB3aW4ucmVzdG9yZSgpO1xyXG4gICAgd2luLnNob3coKTtcclxuICAgIHdpbi5mb2N1cygpO1xyXG4gIH1cclxuICBmdW5jdGlvbiBzZXR1cFRyYXkoKTogdm9pZCB7XHJcbiAgICBpZiAodHJheSAhPT0gbnVsbCkgcmV0dXJuO1xyXG4gICAgY29uc3QgaWNvbiA9IG5hdGl2ZUltYWdlLmNyZWF0ZUZyb21EYXRhVVJMKGBkYXRhOmltYWdlL3BuZztiYXNlNjQsJHtUUkFZX0lDT05fQkFTRTY0fWApO1xyXG4gICAgdHJheSA9IG5ldyBUcmF5KGljb24pO1xyXG4gICAgdHJheS5zZXRUb29sVGlwKCdITUggRGVza3RvcCcpO1xyXG4gICAgdHJheS5vbignY2xpY2snLCBmb2N1c01haW5XaW5kb3cpO1xyXG4gICAgdHJheS5zZXRDb250ZXh0TWVudShNZW51LmJ1aWxkRnJvbVRlbXBsYXRlKFtcclxuICAgICAgeyBsYWJlbDogJ1x1NjVCMFx1NUVGQVx1NEYxQVx1OEJERCcsIGNsaWNrOiAoKTogdm9pZCA9PiBzZW5kTWVudUFjdGlvbignbmV3LXNlc3Npb24nKSB9LFxyXG4gICAgICB7IGxhYmVsOiAnXHU2NjNFXHU3OTNBXHU0RTNCXHU3QTk3XHU1M0UzJywgY2xpY2s6IGZvY3VzTWFpbldpbmRvdyB9LFxyXG4gICAgICB7IGxhYmVsOiAnXHU2MjRCXHU2NzNBXHU4RkRDXHU3QTBCXHU2M0E3XHU1MjM2JywgY2xpY2s6ICgpOiB2b2lkID0+IHNlbmRNZW51QWN0aW9uKCdvcGVuLXJlbW90ZScpIH0sXHJcbiAgICAgIHsgbGFiZWw6ICdcdThCQkVcdTdGNkUnLCBjbGljazogKCk6IHZvaWQgPT4gc2VuZE1lbnVBY3Rpb24oJ29wZW4tc2V0dGluZ3MnKSB9LFxyXG4gICAgICB7IHR5cGU6ICdzZXBhcmF0b3InIH0sXHJcbiAgICAgIHsgbGFiZWw6ICdcdTkwMDBcdTUxRkEnLCBjbGljazogKCk6IHZvaWQgPT4geyBhcHAucXVpdCgpOyB9IH0sXHJcbiAgICBdKSk7XHJcbiAgfVxyXG4gIGZ1bmN0aW9uIG5vdGlmeUV2ZW50KGVudjogRXZlbnRFbnZlbG9wZSk6IHZvaWQge1xyXG4gICAgLy8gXHU5QThDXHU2NTM2L1x1NjIyQVx1NTZGRS9cdTZFMzJcdTY3RDNcdTYzQTJcdTk0ODgvXHU4OUM2XHU4OUM5XHU1NkRFXHU1RjUyXHU2QTIxXHU1RjBGXHU5NzU5XHU5RUQ4KFx1NEUwRFx1NUY4MFx1NzUyOFx1NjIzN1x1Njg0Q1x1OTc2Mlx1NUYzOVx1NkQ0Qlx1OEJENVx1OTAxQVx1NzdFNSlcclxuICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWSA9PT0gJzEnIHx8IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NOQVBTSE9UICE9PSB1bmRlZmluZWQgfHwgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfUkVOREVSX1RFU1QgPT09ICcxJyB8fCBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9WSVNSRUcgPT09ICcxJykgcmV0dXJuO1xyXG4gICAgaWYgKCFOb3RpZmljYXRpb24uaXNTdXBwb3J0ZWQoKSkgcmV0dXJuO1xyXG4gICAgY29uc3Qgd2luID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkuZmluZCgodykgPT4gIXcuaXNEZXN0cm95ZWQoKSk7XHJcbiAgICBjb25zdCBmb2N1c2VkID0gd2luPy5pc0ZvY3VzZWQoKSA/PyBmYWxzZTtcclxuICAgIGNvbnN0IG1rID0gKHRpdGxlOiBzdHJpbmcsIGJvZHk6IHN0cmluZyk6IHZvaWQgPT4ge1xyXG4gICAgICBjb25zdCBuID0gbmV3IE5vdGlmaWNhdGlvbih7IHRpdGxlLCBib2R5LCBpY29uOiBuYXRpdmVJbWFnZS5jcmVhdGVGcm9tRGF0YVVSTChgZGF0YTppbWFnZS9wbmc7YmFzZTY0LCR7VFJBWV9JQ09OX0JBU0U2NH1gKSB9KTtcclxuICAgICAgbi5vbignY2xpY2snLCBmb2N1c01haW5XaW5kb3cpO1xyXG4gICAgICBuLnNob3coKTtcclxuICAgIH07XHJcbiAgICBpZiAoZW52LmtpbmQgPT09ICdhcHByb3ZhbC5yZXF1aXJlZCcpIHtcclxuICAgICAgY29uc3QgcCA9IGVudi5wYXlsb2FkIGFzIHsgdG9vbD86IHN0cmluZyB9O1xyXG4gICAgICBtaygnSE1IIFx1OTcwMFx1ODk4MVx1NUJBMVx1NjI3OScsIGAke1N0cmluZyhwLnRvb2wgPz8gJ1x1NjRDRFx1NEY1QycpfSBcdTdCNDlcdTVGODVcdTRGNjBcdTc2ODRcdTYyNzlcdTUxQzZgKTtcclxuICAgIH0gZWxzZSBpZiAoZW52LmtpbmQgPT09ICdydW4uY29tcGxldGVkJyAmJiAhZm9jdXNlZCkge1xyXG4gICAgICBtaygnSE1IIFx1NEVGQlx1NTJBMVx1NUI4Q1x1NjIxMCcsIGBcdTRGMUFcdThCREQgJHtlbnYuc2Vzc2lvbklkfSBcdTc2ODRcdTRFRkJcdTUyQTFcdTVERjJcdTVCOENcdTYyMTBgKTtcclxuICAgIH0gZWxzZSBpZiAoZW52LmtpbmQgPT09ICdydW4uZmFpbGVkJyAmJiAhZm9jdXNlZCkge1xyXG4gICAgICBtaygnSE1IIFx1NEVGQlx1NTJBMVx1NTkzMVx1OEQyNScsIGBcdTRGMUFcdThCREQgJHtlbnYuc2Vzc2lvbklkfSBcdTc2ODRcdTRFRkJcdTUyQTFcdTU5MzFcdThEMjUsXHU3MEI5XHU1MUZCXHU2N0U1XHU3NzBCYCk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvKiAtLS0tIFx1ODFFQVx1NUI5QVx1NEU0OVx1NjgwN1x1OTg5OFx1NjgwRigyMDI2LTEwLTExIFx1NzUyOFx1NjIzN1x1NTNDRFx1OTk4ODpcdTRFQUVcdTgyNzJcdTZBMjFcdTVGMEZcdTk4NzZcdTkwRThcdTlFRDFcdTY3NjE9XHU1MzlGXHU3NTFGXHU4M0RDXHU1MzU1XHU2ODBGXHJcbiAgICAgXHU0RTBEXHU4RERGXHU0RTNCXHU5ODk4O1x1ODNEQ1x1NTM1NVx1NEUwRVx1OEJCRVx1N0Y2RVx1OTFDRFx1NTkwRCkgLS0tLSBcdTY1QjlcdTY4NDg6XHU5NjkwXHU4NUNGXHU1RjBGXHU2ODA3XHU5ODk4XHU2ODBGICsgdGl0bGVCYXJPdmVybGF5XHJcbiAgICAgKFx1OTg5Q1x1ODI3Mlx1OTY4Rlx1NEUzQlx1OTg5OCksXHU4M0RDXHU1MzU1XHU2ODBGIGF1dG9IaWRlKEFsdCBcdTU0N0NcdTUxRkEpXHU0RTE0XHU3Q0JFXHU3QjgwXHU0RTNBXHU3Q0ZCXHU3RURGXHU3RUE3XHU4MEZEXHU1MjlCO1xyXG4gICAgIFx1NUUzOFx1NzUyOFx1NTJBOFx1NEY1Q1x1OEQ3MCByZW5kZXJlciBcdTY4MDdcdTk4OThcdTY4MEYgXHUyNjMwIFx1NEUzQlx1ODNEQ1x1NTM1NShcdTU1MkZcdTRFMDBcdTUxNjVcdTUzRTMpXHUzMDAyICovXHJcbiAgLy8gdjQgRFNIIFx1OEJCRVx1OEJBMVx1OEJFRFx1OEEwMDpvdmVybGF5IFx1ODI3Mlx1OERERlx1OTY4RiB0aXRsZWJhciBcdTc2ODQgYmctbGF5ZXItMShcdTZENDUgI2ZmZi9cdTZERjEgIzE2MTgxZClcclxuICBjb25zdCBjaHJvbWVGb3IgPSAoZGFyazogYm9vbGVhbik6IHsgY29sb3I6IHN0cmluZzsgc3ltYm9sQ29sb3I6IHN0cmluZyB9ID0+XHJcbiAgICBkYXJrID8geyBjb2xvcjogJyMxNjE4MWQnLCBzeW1ib2xDb2xvcjogJyNmNWY2ZjgnIH0gOiB7IGNvbG9yOiAnI2ZmZmZmZicsIHN5bWJvbENvbG9yOiAnIzBmMTExNScgfTtcclxuICBmdW5jdGlvbiBhcHBseUNocm9tZShkYXJrOiBib29sZWFuKTogdm9pZCB7XHJcbiAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcclxuICAgICAgaWYgKCF3LmlzRGVzdHJveWVkKCkpIHtcclxuICAgICAgICB0cnkgeyB3LnNldFRpdGxlQmFyT3ZlcmxheShjaHJvbWVGb3IoZGFyaykpOyB9IGNhdGNoIHsgLyogXHU0RUM1IFdpbmRvd3MgXHU2NTJGXHU2MzAxICovIH1cclxuICAgICAgfVxyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgLyogLS0tLSBcdTVFOTRcdTc1MjhcdTUxODVcdTY2RjRcdTY1QjAoMjAyNi0xMC0yNjpcdTgxRUFcdTc4MTRcdThGN0JcdTkxQ0ZcdTY2RjRcdTY1QjBcdTU2NjgsXHU5NkY2XHU0RjlEXHU4RDU2O0dpdEh1YiBSZWxlYXNlcyBcdTkwMUFcdTkwNTMpXHJcbiAgICAgXHU2RDQxXHU3QTBCOlx1MjYzMFwiXHU2OEMwXHU2N0U1XHU2NkY0XHU2NUIwXCJcdTIxOTIgZmV0Y2ggbGF0ZXN0IHJlbGVhc2UgdGFnIFx1MjE5MiBcdTZCRDRcdTcyNDhcdTY3MkMgXHUyMTkyIFx1NTQwRVx1NTNGMFx1NEUwQlx1OEY3RCBTZXR1cFxyXG4gICAgIGV4ZSBcdTUyMzBcdTRFMzRcdTY1RjZcdTc2RUVcdTVGNTUgXHUyMTkyIFx1ODNEQ1x1NTM1NVx1NTNEOFwiXHU5MUNEXHU1NDJGXHU1RTc2XHU1Qjg5XHU4OEM1XHU2NkY0XHU2NUIwXCJcdTIxOTIgXHU5MDAwXHU1MUZBXHU1RTk0XHU3NTI4XHU1NDBFIE5TSVMgL1MgL0Q9XHU1MzlGXHU3NkVFXHU1RjU1XHJcbiAgICAgXHU5NzU5XHU5RUQ4XHU4OTg2XHU3NkQ2XHU1Qjg5XHU4OEM1KFx1NEUwQlx1NkIyMVx1NTQyRlx1NTJBOFx1NTM3M1x1NjVCMFx1NzI0OClcdTMwMDJcdTY1RTBcdTdCN0VcdTU0MERcdThCQzFcdTRFNjZcdTk2MzZcdTZCQjVcdTUzRUZcdTc1Mjg7XHU2QjYzXHU1RjBGXHU3QjdFXHU1NDBEXHU1NDBFXHU1M0VGXHU1MkEwXHU2ODIxXHU5QThDXHUzMDAyICovXHJcbiAgY29uc3QgVVBEQVRFX1JFUE8gPSAnc3dzZ2JsL2htaC1kZXNrdG9wJztcclxuICBpbnRlcmZhY2UgVXBkYXRlU3RhdGUgeyBjaGVja2luZzogYm9vbGVhbjsgY3VycmVudFZlcnNpb246IHN0cmluZzsgbGF0ZXN0OiBzdHJpbmcgfCBudWxsOyBub3Rlczogc3RyaW5nOyBkb3dubG9hZGVkOiBib29sZWFuOyBlcnJvcjogc3RyaW5nIH1cclxuICBsZXQgdXBkYXRlU3RhdGU6IFVwZGF0ZVN0YXRlID0geyBjaGVja2luZzogZmFsc2UsIGN1cnJlbnRWZXJzaW9uOiBhcHAuZ2V0VmVyc2lvbigpLCBsYXRlc3Q6IG51bGwsIG5vdGVzOiAnJywgZG93bmxvYWRlZDogZmFsc2UsIGVycm9yOiAnJyB9O1xyXG4gIGxldCBpbnN0YWxsZXJQYXRoOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcclxuICBjb25zdCBidW1wVXBkYXRlID0gKHBhdGNoOiBQYXJ0aWFsPFVwZGF0ZVN0YXRlPik6IHZvaWQgPT4ge1xyXG4gICAgdXBkYXRlU3RhdGUgPSB7IC4uLnVwZGF0ZVN0YXRlLCAuLi5wYXRjaCB9O1xyXG4gICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XHJcbiAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ3VwZGF0ZTpzdGF0ZScsIHVwZGF0ZVN0YXRlKTtcclxuICAgIH1cclxuICB9O1xyXG4gIGNvbnN0IGNtcFZlcnNpb24gPSAoYTogc3RyaW5nLCBiOiBzdHJpbmcpOiBudW1iZXIgPT4ge1xyXG4gICAgY29uc3QgcGEgPSBhLnJlcGxhY2UoL152LywgJycpLnNwbGl0KCcuJykubWFwKE51bWJlcik7XHJcbiAgICBjb25zdCBwYiA9IGIucmVwbGFjZSgvXnYvLCAnJykuc3BsaXQoJy4nKS5tYXAoTnVtYmVyKTtcclxuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgMzsgaSsrKSB7IGlmICgocGFbaV0gPz8gMCkgIT09IChwYltpXSA/PyAwKSkgcmV0dXJuIChwYVtpXSA/PyAwKSA8IChwYltpXSA/PyAwKSA/IC0xIDogMTsgfVxyXG4gICAgcmV0dXJuIDA7XHJcbiAgfTtcclxuICBhc3luYyBmdW5jdGlvbiBjaGVja0ZvclVwZGF0ZXMoKTogUHJvbWlzZTxVcGRhdGVTdGF0ZT4ge1xyXG4gICAgaWYgKHVwZGF0ZVN0YXRlLmNoZWNraW5nIHx8IHVwZGF0ZVN0YXRlLmRvd25sb2FkZWQpIHJldHVybiB1cGRhdGVTdGF0ZTtcclxuICAgIGJ1bXBVcGRhdGUoeyBjaGVja2luZzogdHJ1ZSwgZXJyb3I6ICcnIH0pO1xyXG4gICAgbG9nSW5mbygndXBkYXRlJywgYGNoZWNraW5nXHUyMDI2IChjdXJyZW50IHYke2FwcC5nZXRWZXJzaW9uKCl9KWApO1xyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3QgciA9IGF3YWl0IGZldGNoKGBodHRwczovL2FwaS5naXRodWIuY29tL3JlcG9zLyR7VVBEQVRFX1JFUE99L3JlbGVhc2VzL2xhdGVzdGAsIHtcclxuICAgICAgICBoZWFkZXJzOiB7ICd1c2VyLWFnZW50JzogJ2htaC1kZXNrdG9wLXVwZGF0ZXInIH0sXHJcbiAgICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDE1XzAwMCksXHJcbiAgICAgIH0pO1xyXG4gICAgICBpZiAoIXIub2spIHRocm93IG5ldyBFcnJvcihgR2l0SHViIEFQSSAke3Iuc3RhdHVzfWApO1xyXG4gICAgICBjb25zdCByZWwgPSAoYXdhaXQgci5qc29uKCkpIGFzIHsgdGFnX25hbWU/OiBzdHJpbmc7IGJvZHk/OiBzdHJpbmc7IGFzc2V0cz86IEFycmF5PHsgbmFtZTogc3RyaW5nOyBicm93c2VyX2Rvd25sb2FkX3VybDogc3RyaW5nOyBzaXplOiBudW1iZXIgfT4gfTtcclxuICAgICAgY29uc3QgdGFnID0gU3RyaW5nKHJlbC50YWdfbmFtZSA/PyAnJyk7XHJcbiAgICAgIGxvZ0luZm8oJ3VwZGF0ZScsIGBsYXRlc3Q9JHt0YWd9IGFzc2V0cz0keyhyZWwuYXNzZXRzID8/IFtdKS5sZW5ndGh9YCk7XHJcbiAgICAgIGJ1bXBVcGRhdGUoeyBjaGVja2luZzogZmFsc2UsIGxhdGVzdDogdGFnLCBub3RlczogU3RyaW5nKHJlbC5ib2R5ID8/ICcnKS5zbGljZSgwLCA2MDApIH0pO1xyXG4gICAgICAvLyBcdTY3MDlcdTY1QjBcdTcyNDhcdTRFMTRcdTY3MkFcdTRFMEJcdThGN0RcdThGQzcgXHUyMTkyIFx1NTQwRVx1NTNGMFx1NEUwQlx1OEY3RFx1NUI4OVx1ODhDNVx1NTMwNVxyXG4gICAgICBpZiAodGFnICE9PSAnJyAmJiBjbXBWZXJzaW9uKGFwcC5nZXRWZXJzaW9uKCksIHRhZykgPCAwICYmICF1cGRhdGVTdGF0ZS5kb3dubG9hZGVkKSB7XHJcbiAgICAgICAgdm9pZCBkb3dubG9hZEluc3RhbGxlcihyZWwuYXNzZXRzID8/IFtdKTtcclxuICAgICAgfVxyXG4gICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgIGxvZ0luZm8oJ3VwZGF0ZScsIGBjaGVjayBmYWlsZWQ6ICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTQwKX1gKTtcclxuICAgICAgYnVtcFVwZGF0ZSh7IGNoZWNraW5nOiBmYWxzZSwgZXJyb3I6IFN0cmluZyhlcnIpLnNsaWNlKDAsIDEyMCkgfSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gdXBkYXRlU3RhdGU7XHJcbiAgfVxyXG4gIGFzeW5jIGZ1bmN0aW9uIGRvd25sb2FkSW5zdGFsbGVyKGFzc2V0czogQXJyYXk8eyBuYW1lOiBzdHJpbmc7IGJyb3dzZXJfZG93bmxvYWRfdXJsOiBzdHJpbmc7IHNpemU6IG51bWJlciB9Pik6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3QgYXNzZXQgPSBhc3NldHMuZmluZCgoYSkgPT4gL15ITUgtRGVza3RvcC1TZXR1cC0uKlxcLmV4ZSQvaS50ZXN0KGEubmFtZSkpID8/IGFzc2V0cy5maW5kKChhKSA9PiBhLm5hbWUuZW5kc1dpdGgoJy5leGUnKSk7XHJcbiAgICAgIGlmIChhc3NldCA9PT0gdW5kZWZpbmVkKSB7IGJ1bXBVcGRhdGUoeyBlcnJvcjogJ3JlbGVhc2UgXHU2NUUwXHU1Qjg5XHU4OEM1XHU1MzA1XHU4RDQ0XHU0RUE3JyB9KTsgcmV0dXJuOyB9XHJcbiAgICAgIGNvbnN0IGRlc3QgPSBqb2luKGFwcC5nZXRQYXRoKCd0ZW1wJyksIGFzc2V0Lm5hbWUpO1xyXG4gICAgICAvLyBnaXRodWIuY29tIFx1NzZGNFx1OEZERVx1NTcyOFx1OTBFOFx1NTIwNlx1N0Y1MVx1N0VEQ1x1OEQ4NVx1NjVGNiBcdTIxOTIgXHU5NTVDXHU1MENGXHU1NkRFXHU5MDAwXHU5NEZFKFx1NUI5RVx1NkQ0QiBnaGZhc3QvZ2gtcHJveHkgXHU1M0VGXHU3NTI4KVxyXG4gICAgICBjb25zdCBtaXJyb3JzID0gW1xyXG4gICAgICAgIGFzc2V0LmJyb3dzZXJfZG93bmxvYWRfdXJsLFxyXG4gICAgICAgIGBodHRwczovL2doZmFzdC50b3AvJHthc3NldC5icm93c2VyX2Rvd25sb2FkX3VybH1gLFxyXG4gICAgICAgIGBodHRwczovL2doLXByb3h5LmNvbS8ke2Fzc2V0LmJyb3dzZXJfZG93bmxvYWRfdXJsfWAsXHJcbiAgICAgICAgYGh0dHBzOi8vZ2hwcm94eS5jbi8ke2Fzc2V0LmJyb3dzZXJfZG93bmxvYWRfdXJsfWAsXHJcbiAgICAgIF07XHJcbiAgICAgIGxldCBidWY6IEJ1ZmZlciB8IG51bGwgPSBudWxsO1xyXG4gICAgICBsZXQgbGFzdEVyciA9ICcnO1xyXG4gICAgICBmb3IgKGNvbnN0IHUgb2YgbWlycm9ycykge1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICBsb2dJbmZvKCd1cGRhdGUnLCBgdHJ5aW5nICR7bmV3IFVSTCh1KS5ob3N0fVx1MjAyNmApO1xyXG4gICAgICAgICAgY29uc3QgciA9IGF3YWl0IGZldGNoKHUsIHsgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDYwMF8wMDApIH0pO1xyXG4gICAgICAgICAgaWYgKCFyLm9rKSB7IGxhc3RFcnIgPSBgSFRUUCAke3Iuc3RhdHVzfWA7IGxvZ0luZm8oJ3VwZGF0ZScsIGBcdTIxOTIgSFRUUCAke3Iuc3RhdHVzfWApOyBjb250aW51ZTsgfVxyXG4gICAgICAgICAgYnVmID0gQnVmZmVyLmZyb20oYXdhaXQgci5hcnJheUJ1ZmZlcigpKTtcclxuICAgICAgICAgIGlmIChidWYubGVuZ3RoID4gMV8wMDBfMDAwKSB7IGxvZ0luZm8oJ3VwZGF0ZScsIGBcdTIxOTIgb2sgJHtNYXRoLnJvdW5kKGJ1Zi5sZW5ndGggLyAxZTYpfU1CYCk7IGJyZWFrOyB9XHJcbiAgICAgICAgICBsYXN0RXJyID0gJ1x1NTE4NVx1NUJCOVx1NUYwMlx1NUUzOCc7IGJ1ZiA9IG51bGw7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgICBjb25zdCBlID0gZXJyIGFzIHsgY2F1c2U/OiB7IGNvZGU/OiB1bmtub3duIH0gfTtcclxuICAgICAgICAgIGxhc3RFcnIgPSBTdHJpbmcoZS5jYXVzZT8uY29kZSA/PyBlcnIpLnNsaWNlKDAsIDYwKTtcclxuICAgICAgICAgIGxvZ0luZm8oJ3VwZGF0ZScsIGBcdTIxOTIgZmFpbCAke2xhc3RFcnJ9YCk7XHJcbiAgICAgICAgfVxyXG4gICAgICB9XHJcbiAgICAgIGlmIChidWYgPT09IG51bGwpIHRocm93IG5ldyBFcnJvcihgXHU1MTY4XHU5MEU4XHU0RTBCXHU4RjdEXHU5MDFBXHU5MDUzXHU1OTMxXHU4RDI1KCR7bGFzdEVycn0pYCk7XHJcbiAgICAgIGNvbnN0IHsgd3JpdGVGaWxlOiB3ZiB9ID0gYXdhaXQgaW1wb3J0KCdub2RlOmZzL3Byb21pc2VzJyk7XHJcbiAgICAgIGF3YWl0IHdmKGRlc3QsIGJ1Zik7XHJcbiAgICAgIGluc3RhbGxlclBhdGggPSBkZXN0O1xyXG4gICAgICBidW1wVXBkYXRlKHsgZG93bmxvYWRlZDogdHJ1ZSB9KTtcclxuICAgICAgbG9nSW5mbygndXBkYXRlJywgYFx1NURGMlx1NEUwQlx1OEY3RCAke2Fzc2V0Lm5hbWV9KCR7TWF0aC5yb3VuZChidWYubGVuZ3RoIC8gMWU2KX1NQikgXHUyMTkyICR7ZGVzdH1gKTtcclxuICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICBidW1wVXBkYXRlKHsgZXJyb3I6IGBcdTRFMEJcdThGN0RcdTU5MzFcdThEMjU6ICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTIwKX1gIH0pO1xyXG4gICAgfVxyXG4gIH1cclxuICBmdW5jdGlvbiBhcHBseVVwZGF0ZSgpOiB2b2lkIHtcclxuICAgIGlmIChpbnN0YWxsZXJQYXRoID09PSBudWxsKSByZXR1cm47XHJcbiAgICAvLyBcdTkwMDBcdTUxRkFcdTVGNTNcdTUyNERcdTVFOTRcdTc1MjhcdTU0MEVcdTc1MzFcdTVCODlcdTg4QzVcdTU2NjhcdTk3NTlcdTlFRDhcdTg5ODZcdTc2RDZcdTVCODlcdTg4QzUoXHU4OEM1XHU1NkRFXHU1MzlGXHU3NkVFXHU1RjU1KVx1MzAwMk5TSVMgYXNzaXN0ZWQgXHU4OUM0XHU1MjE5OlxyXG4gICAgLy8gL1MgXHU0RTE0IC9EPXBhdGggXHU1RkM1XHU5ODdCXHU2NzAwXHU1NDBFXHU0RTAwXHU0RTJBXHU1M0MyXHU2NTcwXHUzMDAxXHU1MDNDXHU0RTBEXHU1MkEwXHU1RjE1XHU1M0Y3KFx1NTQyQlx1N0E3QVx1NjgzQ1x1NEU1Rlx1NEUwRFx1NTJBMClcdTIwMTRcdTIwMTRub2RlIHNwYXduXHJcbiAgICAvLyBcdTlFRDhcdThCQTRcdTRGMUFcdTdFRDlcdTU0MkJcdTdBN0FcdTY4M0NcdTUzQzJcdTY1NzBcdTUyQTBcdTVGMTVcdTUzRjdcdTVCRkNcdTgxRjQgTlNJUyBcdTg5RTNcdTY3OTBcdTk1MTlcdThERUZcdTVGODQoXHU1QjlFXHU2RDRCXHU4OEM1XHU1NzRGXHU3NkVFXHU1RjU1KSxcdTY1NDVcdTc1MjhcclxuICAgIC8vIHdpbmRvd3NWZXJiYXRpbUFyZ3VtZW50cyBcdTUzOUZcdTY4MzdcdTRGMjBcdTkwMTJcdTMwMDJcclxuICAgIGNvbnN0IGluc3RhbGxEaXIgPSBkaXJuYW1lKHByb2Nlc3MuZXhlY1BhdGgpO1xyXG4gICAgY29uc3QgY2hpbGQgPSBzcGF3bihgXCIke2luc3RhbGxlclBhdGh9XCIgL1MgL0Q9JHtpbnN0YWxsRGlyfWAsIHtcclxuICAgICAgZGV0YWNoZWQ6IHRydWUsXHJcbiAgICAgIHN0ZGlvOiAnaWdub3JlJyxcclxuICAgICAgd2luZG93c0hpZGU6IHRydWUsXHJcbiAgICAgIHNoZWxsOiBmYWxzZSxcclxuICAgICAgd2luZG93c1ZlcmJhdGltQXJndW1lbnRzOiB0cnVlLFxyXG4gICAgfSk7XHJcbiAgICBjaGlsZC51bnJlZigpO1xyXG4gICAgbG9nSW5mbygndXBkYXRlJywgYGFwcGx5OiAke2luc3RhbGxlclBhdGh9IFx1MjE5MiAke2luc3RhbGxEaXJ9YCk7XHJcbiAgICBhcHAuZXhpdCgwKTtcclxuICB9XHJcblxyXG4gIGZ1bmN0aW9uIGJ1aWxkQXBwTWVudSgpOiB2b2lkIHtcclxuICAgIC8vIFx1N0NCRVx1N0I4MDpcdTUzRUFcdTRGRERcdTc1NTkgVUkgXHU2Q0ExXHU2NzA5XHU3Njg0XHU3Q0ZCXHU3RURGXHU3RUE3XHU4MEZEXHU1MjlCKFx1NTI2QVx1OEQzNFx1Njc3Ri9cdTdBOTdcdTUzRTMpO1x1NTE3Nlx1NEY1OVx1NTUyRlx1NEUwMFx1NTE2NVx1NTNFM1x1NTcyOCBVSVx1MzAwMlxyXG4gICAgY29uc3QgdGVtcGxhdGU6IEFycmF5PEVsZWN0cm9uLk1lbnVJdGVtQ29uc3RydWN0b3JPcHRpb25zPiA9IFtcclxuICAgICAge1xyXG4gICAgICAgIGxhYmVsOiAnXHU3RjE2XHU4RjkxJyxcclxuICAgICAgICBzdWJtZW51OiBbXHJcbiAgICAgICAgICB7IHJvbGU6ICd1bmRvJywgbGFiZWw6ICdcdTY0QTRcdTk1MDAnIH0sXHJcbiAgICAgICAgICB7IHJvbGU6ICdyZWRvJywgbGFiZWw6ICdcdTkxQ0RcdTUwNUEnIH0sXHJcbiAgICAgICAgICB7IHR5cGU6ICdzZXBhcmF0b3InIH0sXHJcbiAgICAgICAgICB7IHJvbGU6ICdjdXQnLCBsYWJlbDogJ1x1NTI2QVx1NTIwNycgfSxcclxuICAgICAgICAgIHsgcm9sZTogJ2NvcHknLCBsYWJlbDogJ1x1NTkwRFx1NTIzNicgfSxcclxuICAgICAgICAgIHsgcm9sZTogJ3Bhc3RlJywgbGFiZWw6ICdcdTdDOThcdThEMzQnIH0sXHJcbiAgICAgICAgICB7IHJvbGU6ICdzZWxlY3RBbGwnLCBsYWJlbDogJ1x1NTE2OFx1OTAwOScgfSxcclxuICAgICAgICBdLFxyXG4gICAgICB9LFxyXG4gICAgICB7XHJcbiAgICAgICAgbGFiZWw6ICdcdTdBOTdcdTUzRTMnLFxyXG4gICAgICAgIHN1Ym1lbnU6IFtcclxuICAgICAgICAgIHsgcm9sZTogJ21pbmltaXplJywgbGFiZWw6ICdcdTY3MDBcdTVDMEZcdTUzMTYnIH0sXHJcbiAgICAgICAgICB7IHJvbGU6ICd6b29tJywgbGFiZWw6ICdcdTdGMjlcdTY1M0UnIH0sXHJcbiAgICAgICAgICB7IHR5cGU6ICdzZXBhcmF0b3InIH0sXHJcbiAgICAgICAgICB7IHJvbGU6ICdjbG9zZScsIGxhYmVsOiAnXHU1MTczXHU5NUVEJyB9LFxyXG4gICAgICAgIF0sXHJcbiAgICAgIH0sXHJcbiAgICBdO1xyXG4gICAgTWVudS5zZXRBcHBsaWNhdGlvbk1lbnUoTWVudS5idWlsZEZyb21UZW1wbGF0ZSh0ZW1wbGF0ZSkpO1xyXG4gIH1cclxuICAvKiogXHU2ODA3XHU5ODk4XHU2ODBGIFx1MjYzMCBcdTRFM0JcdTgzRENcdTUzNTUoXHU1RTM4XHU3NTI4XHU1MkE4XHU0RjVDXHU3Njg0XHU1NTJGXHU0RTAwXHU1MTY1XHU1M0UzO1x1ODlDNlx1NTZGRVx1NjAwMVx1N0VDRiBtZW51OmFjdGlvbiBcdThGNkNcdTUzRDEpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gcG9wdXBNYWluTWVudSgpOiB2b2lkIHtcclxuICAgIGNvbnN0IHNlbmQgPSAoYTogc3RyaW5nKTogdm9pZCA9PiB7XHJcbiAgICAgIGZvciAoY29uc3QgdyBvZiBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKSkge1xyXG4gICAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ21lbnU6YWN0aW9uJywgYSk7XHJcbiAgICAgIH1cclxuICAgIH07XHJcbiAgICBjb25zdCB3aW4gPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5maW5kKCh3KSA9PiAhdy5pc0Rlc3Ryb3llZCgpKTtcclxuICAgIGlmICh3aW4gPT09IHVuZGVmaW5lZCkgcmV0dXJuO1xyXG4gICAgTWVudS5idWlsZEZyb21UZW1wbGF0ZShbXHJcbiAgICAgIHsgbGFiZWw6ICdcdTY1QjBcdTVFRkFcdTRGMUFcdThCREQnLCBhY2NlbGVyYXRvcjogJ0NtZE9yQ3RybCtOJywgY2xpY2s6ICgpOiB2b2lkID0+IHNlbmQoJ25ldy1zZXNzaW9uJykgfSxcclxuICAgICAgeyBsYWJlbDogJ1x1OEJCRVx1N0Y2RScsIGFjY2VsZXJhdG9yOiAnQ21kT3JDdHJsK1NoaWZ0K1AnLCBjbGljazogKCk6IHZvaWQgPT4gc2VuZCgnb3Blbi1zZXR0aW5ncycpIH0sXHJcbiAgICAgIHsgbGFiZWw6ICdcdTVGRUJcdTYzNzdcdTk1MkUnLCBhY2NlbGVyYXRvcjogJ0NtZE9yQ3RybCsvJywgY2xpY2s6ICgpOiB2b2lkID0+IHNlbmQoJ3Nob3J0Y3V0cycpIH0sXHJcbiAgICAgIHsgdHlwZTogJ3NlcGFyYXRvcicgfSxcclxuICAgICAgeyBsYWJlbDogJ1x1NjI0Qlx1NjczQVx1OEZEQ1x1N0EwQlx1NjNBN1x1NTIzNicsIGNsaWNrOiAoKTogdm9pZCA9PiBzZW5kKCdvcGVuLXJlbW90ZScpIH0sXHJcbiAgICAgIHsgdHlwZTogJ3NlcGFyYXRvcicgfSxcclxuICAgICAge1xyXG4gICAgICAgIGxhYmVsOiB1cGRhdGVTdGF0ZS5kb3dubG9hZGVkID8gYFx1OTFDRFx1NTQyRlx1NUU3Nlx1NUI4OVx1ODhDNVx1NjZGNFx1NjVCMCh2JHt1cGRhdGVTdGF0ZS5sYXRlc3QgPz8gJz8nfSlgIDogJ1x1NjhDMFx1NjdFNVx1NjZGNFx1NjVCMFx1MjAyNicsXHJcbiAgICAgICAgY2xpY2s6ICgpOiB2b2lkID0+IHtcclxuICAgICAgICAgIGlmICh1cGRhdGVTdGF0ZS5kb3dubG9hZGVkKSB7IGFwcGx5VXBkYXRlKCk7IHJldHVybjsgfVxyXG4gICAgICAgICAgdm9pZCBjaGVja0ZvclVwZGF0ZXMoKS50aGVuKChzdCkgPT4ge1xyXG4gICAgICAgICAgICBjb25zdCBuZXdlciA9IHN0LmxhdGVzdCAhPT0gbnVsbCAmJiBjbXBWZXJzaW9uKHN0LmN1cnJlbnRWZXJzaW9uLCBzdC5sYXRlc3QpIDwgMDtcclxuICAgICAgICAgICAgY29uc3QgZGV0YWlsID0gbmV3ZXIgPyBgJHtzdC5ub3Rlc31cXG5cXG5cdTVCODlcdTg4QzVcdTUzMDVcdTZCNjNcdTU3MjhcdTU0MEVcdTUzRjBcdTRFMEJcdThGN0QsXHU1QjhDXHU2MjEwXHU1NDBFIFx1MjYzMCBcdTgzRENcdTUzNTVcdTRGMUFcdTUxRkFcdTczQjBcIlx1OTFDRFx1NTQyRlx1NUU3Nlx1NUI4OVx1ODhDNVx1NjZGNFx1NjVCMFwiXHUzMDAyYCA6ICcnO1xyXG4gICAgICAgICAgICB2b2lkIGRpYWxvZy5zaG93TWVzc2FnZUJveCh3aW4sIHtcclxuICAgICAgICAgICAgICB0eXBlOiAnaW5mbycsXHJcbiAgICAgICAgICAgICAgdGl0bGU6ICdcdTY4QzBcdTY3RTVcdTY2RjRcdTY1QjAnLFxyXG4gICAgICAgICAgICAgIG1lc3NhZ2U6IG5ld2VyXHJcbiAgICAgICAgICAgICAgICA/IGBcdTUzRDFcdTczQjBcdTY1QjBcdTcyNDhcdTY3MkMgdiR7c3QubGF0ZXN0fSFgXHJcbiAgICAgICAgICAgICAgICA6IChzdC5lcnJvciAhPT0gJycgPyBgXHU2OEMwXHU2N0U1XHU1OTMxXHU4RDI1OiR7c3QuZXJyb3J9YCA6IGBcdTVERjJcdTY2MkZcdTY3MDBcdTY1QjBcdTcyNDhcdTY3MkModiR7c3QuY3VycmVudFZlcnNpb259KWApLFxyXG4gICAgICAgICAgICAgIGRldGFpbCxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICB9KTtcclxuICAgICAgICB9LFxyXG4gICAgICB9LFxyXG4gICAgICB7XHJcbiAgICAgICAgbGFiZWw6ICdcdTUxNzNcdTRFOEUgSE1IIERlc2t0b3AnLFxyXG4gICAgICAgIGNsaWNrOiAoKTogdm9pZCA9PiB7XHJcbiAgICAgICAgICB2b2lkIGRpYWxvZy5zaG93TWVzc2FnZUJveCh3aW4sIHtcclxuICAgICAgICAgICAgdHlwZTogJ2luZm8nLFxyXG4gICAgICAgICAgICB0aXRsZTogJ1x1NTE3M1x1NEU4RSBITUggRGVza3RvcCcsXHJcbiAgICAgICAgICAgIG1lc3NhZ2U6ICdITUggRGVza3RvcCcsXHJcbiAgICAgICAgICAgIGRldGFpbDogYFx1NjcyQ1x1NTczMFx1NEYxOFx1NTE0OFx1NzY4NCBITUggQWdlbnQgXHU1NkZFXHU1RjYyXHU1REU1XHU0RjVDXHU1M0YwIHYke2FwcC5nZXRWZXJzaW9uKCl9XFxucnVudGltZTogaG1oYXJuZXNzICR7YnJpZGdlLmhvc3RWZXJzaW9uID8/ICcoXHU2NzJBXHU4RkRFXHU2M0E1KSd9JHt1c2VCdW5kbGVkUnVudGltZSA/ICcoXHU1MTg1XHU3RjZFKScgOiAnJ31cXG5cdTZBMjFcdTVGMEY6ICR7YnJpZGdlLm1vZGUgPT09ICdyZWFsJyA/ICh1c2VCdW5kbGVkUnVudGltZSA/ICdcdTc3MUZcdTVCOUUgaG1oYXJuZXNzKFx1NTE4NVx1N0Y2RSBydW50aW1lKScgOiAnXHU3NzFGXHU1QjlFIGhtaGFybmVzcyhcdTU5MTZcdTkwRThcdTVCODlcdTg4QzUpJykgOiAnXHU2RjE0XHU3OTNBKFx1NTA0N1x1NjU3MFx1NjM2RSknfVxcblxcblx1NEUwRSBDTEkgLyBUVUkgLyBcdTdGNTFcdTk4NzVcdTcyNDhcdTUxNzFcdTRFQUJcdTU0MENcdTRFMDAgSE1IX0hPTUVcdTMwMDJgLFxyXG4gICAgICAgICAgfSk7XHJcbiAgICAgICAgfSxcclxuICAgICAgfSxcclxuICAgICAgeyBsYWJlbDogJ1x1OTAwMFx1NTFGQScsIHJvbGU6ICdxdWl0JyB9LFxyXG4gICAgXSkucG9wdXAoeyB3aW5kb3c6IHdpbiB9KTtcclxuICB9XHJcblxyXG4gIC8qIC0tLS0gXHU2MjRCXHU2NzNBXHU4RkRDXHU3QTBCXHU2M0E3XHU1MjM2KDAzIFx1NTNGNzpXZWIgNzc4OCBcdTY2MkZcdTZENEZcdTg5QzhcdTU2NjgvXHU4RkRDXHU3QTBCL1x1NjI0Qlx1NjczQVx1NTE2NVx1NTNFMyxBRFItMDA1OlxyXG4gICAgIERlc2t0b3AgXHU0RTBEXHU5RUQ4XHU4QkE0XHU2MjUzXHU1RjAwIExBTiBcdTIwMTRcdTIwMTQgXHU4RkQ5XHU5MUNDXHU2NjJGXHU3NTI4XHU2MjM3XHU2NjNFXHU1RjBGXHU1NDJGXHU1MkE4XHU3Njg0XHU1MTY1XHU1M0UzKSAtLS0tICovXHJcbiAgY29uc3QgV0VCX1BPUlQgPSA3Nzg4O1xyXG4gIGFzeW5jIGZ1bmN0aW9uIHByb2JlV2ViUmVtb3RlKCk6IFByb21pc2U8eyB1cDogYm9vbGVhbjsgdmVyc2lvbjogc3RyaW5nIH0+IHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHIgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke1dFQl9QT1JUfS9hcGkvc3RhdGVgLCB7IHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCgxNTAwKSB9KTtcclxuICAgICAgaWYgKCFyLm9rKSByZXR1cm4geyB1cDogZmFsc2UsIHZlcnNpb246ICcnIH07XHJcbiAgICAgIGNvbnN0IGQgPSAoYXdhaXQgci5qc29uKCkpIGFzIHsgZGFlbW9uVmVyc2lvbj86IHN0cmluZyB9O1xyXG4gICAgICByZXR1cm4geyB1cDogdHJ1ZSwgdmVyc2lvbjogU3RyaW5nKGQuZGFlbW9uVmVyc2lvbiA/PyAnJykgfTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4geyB1cDogZmFsc2UsIHZlcnNpb246ICcnIH07IH1cclxuICB9XHJcbiAgLyoqIFx1NUYwMFx1NjczQVx1ODFFQVx1NTQyRlx1NjYyRlx1NTQyNlx1NURGMlx1ODhDNShydW50aW1lIHdlYi1kYWVtb24gXHU3Njg0XHU1NDJGXHU1MkE4XHU5ODc5XHU2NTg3XHU0RUY2XHU1QjU4XHU1NzI4XHU2MDI3OzAuMjMuMzcgXHU2NUIwXHU4MEZEXHU1MjlCKVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIHdlYkF1dG9zdGFydEluc3RhbGxlZCgpOiBib29sZWFuIHtcclxuICAgIGNvbnN0IGhvbWUgPSBwcm9jZXNzLmVudi5IT01FID8/ICcnO1xyXG4gICAgY29uc3QgY2FuZGlkYXRlcyA9IHByb2Nlc3MucGxhdGZvcm0gPT09ICd3aW4zMidcclxuICAgICAgPyBbam9pbihwcm9jZXNzLmVudi5BUFBEQVRBID8/ICcnLCAnTWljcm9zb2Z0JywgJ1dpbmRvd3MnLCAnU3RhcnQgTWVudScsICdQcm9ncmFtcycsICdTdGFydHVwJywgJ2htaGFybmVzcy13ZWItZGFlbW9uLmNtZCcpXVxyXG4gICAgICA6IHByb2Nlc3MucGxhdGZvcm0gPT09ICdkYXJ3aW4nXHJcbiAgICAgICAgPyBbam9pbihob21lLCAnTGlicmFyeScsICdMYXVuY2hBZ2VudHMnLCAnaG1oYXJuZXNzLXdlYi1kYWVtb24ucGxpc3QnKV1cclxuICAgICAgICA6IFtqb2luKGhvbWUsICcuY29uZmlnJywgJ3N5c3RlbWQnLCAndXNlcicsICdobWhhcm5lc3Mtd2ViLWRhZW1vbi5zZXJ2aWNlJyldO1xyXG4gICAgcmV0dXJuIGNhbmRpZGF0ZXMuc29tZSgocCkgPT4geyB0cnkgeyByZXR1cm4gZXhpc3RzU3luYyhwKTsgfSBjYXRjaCB7IHJldHVybiBmYWxzZTsgfSB9KTtcclxuICB9XHJcbiAgLyoqIFx1NjI0Qlx1NjczQVx1NTNFRlx1OERFRlx1NzUzMVx1NzY4NCBMQU4gSVAoUkZDMTkxOCxcdTYzOTJcdTk2NjRcdTg2NUFcdTYyREZcdTdGNTFcdTUzNjEpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gbGFuSXBPZigpOiBzdHJpbmcge1xyXG4gICAgY29uc3QgVklSVFVBTCA9IC92bXdhcmV8dmlydHVhbHxoeXBlci0/dnx2ZXRoZXJuZXR8d3NsfHRhaWxzY2FsZXxsb29wYmFja3xibHVldG9vdGh8dmJveHxkb2NrZXJ8dGFwLXxwc2V1ZG8vaTtcclxuICAgIGNvbnN0IGlzUmZjMTkxOCA9IChhOiBzdHJpbmcpOiBib29sZWFuID0+IC9eMTBcXC4vLnRlc3QoYSkgfHwgL14xOTJcXC4xNjhcXC4vLnRlc3QoYSkgfHwgL14xNzJcXC4oMVs2LTldfDJcXGR8M1swMV0pXFwuLy50ZXN0KGEpO1xyXG4gICAgbGV0IGxhbklwID0gJyc7XHJcbiAgICBsZXQgZmFsbGJhY2sgPSAnJztcclxuICAgIGZvciAoY29uc3QgW25hbWUsIGxpc3RdIG9mIE9iamVjdC5lbnRyaWVzKG5ldHdvcmtJbnRlcmZhY2VzKCkpKSB7XHJcbiAgICAgIGZvciAoY29uc3QgbiBvZiBsaXN0ID8/IFtdKSB7XHJcbiAgICAgICAgaWYgKG4uZmFtaWx5ICE9PSAnSVB2NCcgfHwgbi5pbnRlcm5hbCB8fCAhaXNSZmMxOTE4KG4uYWRkcmVzcykpIGNvbnRpbnVlO1xyXG4gICAgICAgIGlmICghVklSVFVBTC50ZXN0KG5hbWUpKSBsYW5JcCA9IGxhbklwIHx8IG4uYWRkcmVzcztcclxuICAgICAgICBlbHNlIGZhbGxiYWNrID0gZmFsbGJhY2sgfHwgbi5hZGRyZXNzO1xyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gbGFuSXAgfHwgZmFsbGJhY2s7XHJcbiAgfVxyXG4gIC8qKiBDTEkgXHU1MTY1XHU1M0UzOlx1NkU5MFx1NzgwMSByZXBvIFx1NUUwM1x1NUM0MChtYWluLnRzLFx1N0VDRiB0c3gpXHU2MjE2IG5wbSBcdTVCODlcdTg4QzVcdTVFMDNcdTVDNDAoZGlzdC9tYWluLmpzXHJcbiAgICogIFx1NzZGNFx1OEREMVx1MjAxNFx1MjAxNFx1NEVDRSBydW50aW1lIFx1NTE2NVx1NTNFM1x1NEUwQVx1NkVBRlx1NjI3RSBAaG1oYXJuZXNzL2NsaSBcdTUzMDU7XHU1RDRDXHU1OTU3L1x1NjNEMFx1NTM0Ny9cdTZFOTBcdTc4MDFcdTRFMDlcdTc5Q0RcdTVFMDNcdTVDNDBcdTkwMUFcdTU0MDMpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gY2xpRW50cnlPZigpOiBzdHJpbmcge1xyXG4gICAgaWYgKHJ1bnRpbWVFbnRyeSA9PT0gJycgfHwgcnVudGltZUVudHJ5ID09PSBudWxsKSByZXR1cm4gJyc7XHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCBwID0gam9pbihyZXBvUm9vdE9mKHJ1bnRpbWVFbnRyeSksICdwYWNrYWdlcycsICdjbGknLCAnc3JjJywgJ21haW4udHMnKTtcclxuICAgICAgaWYgKGV4aXN0c1N5bmMocCkpIHJldHVybiBwO1xyXG4gICAgfSBjYXRjaCB7IC8qIFx1OTc1RSByZXBvIFx1NUUwM1x1NUM0MCAqLyB9XHJcbiAgICBsZXQgZGlyID0gZGlybmFtZShydW50aW1lRW50cnkpO1xyXG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCA4OyBpKyspIHtcclxuICAgICAgaWYgKGV4aXN0c1N5bmMoam9pbihkaXIsICdkaXN0JywgJ21haW4uanMnKSkgJiYgcGtnTmFtZUF0KGRpcikgPT09ICdAaG1oYXJuZXNzL2NsaScpIHJldHVybiBqb2luKGRpciwgJ2Rpc3QnLCAnbWFpbi5qcycpO1xyXG4gICAgICBpZiAoYmFzZW5hbWUoZGlyKSA9PT0gJ0BobWhhcm5lc3MnICYmIGV4aXN0c1N5bmMoam9pbihkaXIsICdjbGknLCAnZGlzdCcsICdtYWluLmpzJykpKSByZXR1cm4gam9pbihkaXIsICdjbGknLCAnZGlzdCcsICdtYWluLmpzJyk7XHJcbiAgICAgIGNvbnN0IHBhcmVudCA9IGRpcm5hbWUoZGlyKTtcclxuICAgICAgaWYgKHBhcmVudCA9PT0gZGlyKSBicmVhaztcclxuICAgICAgZGlyID0gcGFyZW50O1xyXG4gICAgfVxyXG4gICAgcmV0dXJuICcnO1xyXG4gIH1cclxuICBmdW5jdGlvbiBydW5DbGkoYXJnczogc3RyaW5nW10pOiB2b2lkIHtcclxuICAgIGNvbnN0IGVudHJ5ID0gY2xpRW50cnlPZigpO1xyXG4gICAgaWYgKGVudHJ5ID09PSAnJykgcmV0dXJuO1xyXG4gICAgY29uc3QgaXNUcyA9IGVudHJ5LmVuZHNXaXRoKCcudHMnKTtcclxuICAgIGNvbnN0IHJlcG8gPSByZXBvUm9vdE9mKHJ1bnRpbWVFbnRyeSA/PyBlbnRyeSk7XHJcbiAgICBjb25zdCBjaGlsZCA9IHNwYXduKHByb2Nlc3MuZXhlY1BhdGgsIGlzVHMgPyBbJy0taW1wb3J0JywgJ3RzeCcsIGVudHJ5LCAuLi5hcmdzXSA6IFtlbnRyeSwgLi4uYXJnc10sIHtcclxuICAgICAgY3dkOiBpc1RzID8gcmVwbyA6IGRpcm5hbWUoZW50cnkpLFxyXG4gICAgICBkZXRhY2hlZDogdHJ1ZSxcclxuICAgICAgc3RkaW86ICdpZ25vcmUnLFxyXG4gICAgICB3aW5kb3dzSGlkZTogdHJ1ZSxcclxuICAgICAgZW52OiB7IEVMRUNUUk9OX1JVTl9BU19OT0RFOiAnMScgfSxcclxuICAgIH0pO1xyXG4gICAgY2hpbGQudW5yZWYoKTtcclxuICB9XHJcblxyXG4gIGZ1bmN0aW9uIGJyb2FkY2FzdEhvc3RTdGF0ZShzOiBIb3N0U3RhdGUsIGluZm86IHsgcmVzdGFydENvdW50OiBudW1iZXI7IGxhc3RFcnJvcj86IHN0cmluZyB9KTogdm9pZCB7XHJcbiAgICBicmlkZ2UgPSB7IC4uLmJyaWRnZSwgaG9zdFN0YXRlOiBzLCBob3N0UG9ydDogc3VwZXJ2aXNvcj8uZW5kcG9pbnQ/LnBvcnQgPz8gbnVsbCwgaG9zdFZlcnNpb246IHN1cGVydmlzb3I/LmVuZHBvaW50Py52ZXJzaW9uID8/IG51bGwgfTtcclxuICAgIGxvZ0luZm8oJ2hvc3QnLCBgc3RhdGU9JHtzfSR7aW5mby5sYXN0RXJyb3IgIT09IHVuZGVmaW5lZCA/IGAgZXJyPSR7aW5mby5sYXN0RXJyb3J9YCA6ICcnfWApO1xyXG4gICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XHJcbiAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ2JyaWRnZTpob3N0LXN0YXRlJywgcywgaW5mbyk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvKiogU1NFIFx1NkQ0MVx1OEJBMlx1OTYwNTpcdTRGRTFcdTVDMDEoZXZlbnQ6IGhtaClcdTYyNzlcdTkxQ0ZcdTYzQTggcmVuZGVyZXI7XHU5QUQ4XHU5ODkxIGRlbHRhL2xpbmUgXHU1MzlGXHU1RTI3XHJcbiAgICogIFx1NEY1Q1x1NEUzQVx1NkQ0MVx1NTc1N1x1OEY2Q1x1NTNEMShyZW5kZXJlciBcdTYyRkNcdTYzQTVcdTVGNTNcdTUyNEQgYXNzaXN0YW50IFx1NTM2MFx1NEY0RClcdTMwMDJcdTY1QURcdTdFQkZcdTgxRUFcdTUyQThcdTkxQ0RcdThGREVcdTMwMDIgKi9cclxuICBhc3luYyBmdW5jdGlvbiBwdW1wRXZlbnRzKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgaWYgKGNsaWVudCA9PT0gbnVsbCkgcmV0dXJuO1xyXG4gICAgZm9yICg7Oykge1xyXG4gICAgICBjb25zdCBjID0gY2xpZW50O1xyXG4gICAgICBpZiAoYyA9PT0gbnVsbCkgcmV0dXJuO1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGZvciBhd2FpdCAoY29uc3QgZnJhbWUgb2YgYy5yYXdFdmVudHMobGFzdEV2ZW50SWQgPT09ICcnID8gdW5kZWZpbmVkIDogbGFzdEV2ZW50SWQsIHNzZUFib3J0Py5zaWduYWwpKSB7XHJcbiAgICAgICAgICBpZiAoZnJhbWUuZXZlbnQgPT09ICdobWgnKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGVudiA9IGVudmVsb3BlRnJvbUZyYW1lKGZyYW1lKTtcclxuICAgICAgICAgICAgaWYgKGVudiA9PT0gbnVsbCkge1xyXG4gICAgICAgICAgICAgIGRyb3BwZWRGcmFtZXMgKz0gMTtcclxuICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBsYXN0RXZlbnRJZCA9IGVudi5ldmVudElkO1xyXG4gICAgICAgICAgICBwdXNoRXZlbnQoZW52KTtcclxuICAgICAgICAgIH0gZWxzZSBpZiAoZnJhbWUuZXZlbnQgPT09ICdkZWx0YScgfHwgZnJhbWUuZXZlbnQgPT09ICdsaW5lJykge1xyXG4gICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgIGNvbnN0IGQgPSBKU09OLnBhcnNlKGZyYW1lLmRhdGEpIGFzIHsgc2Vzc2lvbklkPzogc3RyaW5nOyBrPzogc3RyaW5nOyBjaHVuaz86IHN0cmluZzsgdGV4dD86IHN0cmluZyB9O1xyXG4gICAgICAgICAgICAgIGNvbnN0IHBheWxvYWQgPSBmcmFtZS5ldmVudCA9PT0gJ2RlbHRhJ1xyXG4gICAgICAgICAgICAgICAgPyB7IHNlc3Npb25JZDogZC5zZXNzaW9uSWQgPz8gJycsIGtpbmQ6IGQuayA/PyAndGV4dCcsIGNodW5rOiBTdHJpbmcoZC5jaHVuayA/PyAnJykgfVxyXG4gICAgICAgICAgICAgICAgOiB7IHNlc3Npb25JZDogZC5zZXNzaW9uSWQgPz8gJycsIGtpbmQ6ICdsaW5lJywgY2h1bms6IFN0cmluZyhkLnRleHQgPz8gJycpIH07XHJcbiAgICAgICAgICAgICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XHJcbiAgICAgICAgICAgICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCdicmlkZ2U6c3RyZWFtLWNodW5rJywgcGF5bG9hZCk7XHJcbiAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9IGNhdGNoIHsgLyogbWFsZm9ybWVkIHN0cmVhbSBmcmFtZTogc2tpcCAqLyB9XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybjsgLy8gXHU2RDQxXHU2QjYzXHU1RTM4XHU3RUQzXHU2NzVGKGhvc3QgXHU1MTczXHU5NUVEKVxyXG4gICAgICB9IGNhdGNoIHtcclxuICAgICAgICAvLyBcdTY1QURcdTdFQkY6XHU3N0VEXHU5MDAwXHU5MDdGXHU1NDBFXHU5MUNEXHU4RkRFKHN1cGVydmlzb3IgXHU1M0VGXHU4MEZEXHU2QjYzXHU1NzI4XHU5MUNEXHU1NDJGIGhvc3QpXHJcbiAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgMV8wMDApKTtcclxuICAgICAgICBpZiAoc3NlQWJvcnQ/LnNpZ25hbC5hYm9ydGVkKSByZXR1cm47XHJcbiAgICAgIH1cclxuICAgIH1cclxuICB9XHJcblxyXG4gIC8qIC0tLS0gaG1oYXJuZXNzIHJ1bnRpbWUgXHU4MUVBXHU1MkE4XHU1M0QxXHU3M0IwKDIwMjYtMTAtMTAgXHU3NTI4XHU2MjM3XHU1QjlBXHU4QzAzOlx1ODhDNVx1OEZDNyBobWhhcm5lc3MgXHU3Njg0XHJcbiAgICAgXHU2NzNBXHU1NjY4XHU5NkY2XHU5MTREXHU3RjZFXHU3NkY0XHU4RkRFLFx1NTkwRFx1NzUyOCBDTEkvVFVJL3dlYiA3Nzg4IFx1NzY4NFx1NTQwQ1x1NEUwMCBITUhfSE9NRVx1MjAxNFx1MjAxNGNvbmZpZy9wcm92aWRlcnMvXHJcbiAgICAgXHU0RjFBXHU4QkREXHU1Mzg2XHU1M0YyXHU1OTI5XHU3MTM2XHU1MTcxXHU0RUFCKVx1MzAwMnY1LjEgXHU1M0QxXHU3M0IwXHU5ODdBXHU1RThGOlx1NjYzRVx1NUYwRlx1OTE0RFx1N0Y2RSA+IHdoZXJlIGhtaChcdTZFOTBcdTc4MDEgbGluayBcdTRFMEVcclxuICAgICBAaG1oYXJuZXNzL2NsaSBucG0gXHU1Qjg5XHU4OEM1XHU0RTI0XHU3OUNEXHU1RTAzXHU1QzQwKT4gbnBtIFx1NTE2OFx1NUM0MFx1NjgzOShcdTU0MEMpPiBcdTU0MTFcdTVCRkNcdTVCODlcdTg4QzVcdTc2RUVcdTVGNTVcclxuICAgICB+Ly5obWhhcm5lc3MtZ2xvYmFsID4gXHU1RTM4XHU4OUMxXHU2RTkwXHU3ODAxXHU0RjREXHU3RjZFXHUzMDAyICovXHJcbiAgY29uc3QgcnVudGltZUNvbmZpZ0ZpbGUgPSAoKTogc3RyaW5nID0+IGpvaW4oYXBwLmdldFBhdGgoJ3VzZXJEYXRhJyksICdydW50aW1lLmpzb24nKTtcclxuICAvKiogcnVudGltZS5qc29uOnsgZW50cnkoXHU2MjRCXHU1MkE4L1x1NTQxMVx1NUJGQ1x1OTAwOVx1NjJFOVx1NzY4NFx1NTE2NVx1NTNFMyksIGRlbW8oXHU2MzAxXHU0RTQ1XHU2RjE0XHU3OTNBXHU2QTIxXHU1RjBGKSB9XHUzMDAyICovXHJcbiAgYXN5bmMgZnVuY3Rpb24gbG9hZFJ1bnRpbWVDb25maWcoKTogUHJvbWlzZTx7IGVudHJ5OiBzdHJpbmc7IGRlbW86IGJvb2xlYW4gfT4ge1xyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3QgdiA9IEpTT04ucGFyc2UoYXdhaXQgcmVhZEZpbGUocnVudGltZUNvbmZpZ0ZpbGUoKSwgJ3V0ZjgnKSkgYXMgeyBlbnRyeT86IHVua25vd247IGRlbW8/OiB1bmtub3duIH07XHJcbiAgICAgIHJldHVybiB7XHJcbiAgICAgICAgZW50cnk6IHR5cGVvZiB2LmVudHJ5ID09PSAnc3RyaW5nJyAmJiB2LmVudHJ5ICE9PSAnJyAmJiBpc0Fic29sdXRlKHYuZW50cnkpID8gdi5lbnRyeSA6ICcnLFxyXG4gICAgICAgIGRlbW86IHYuZGVtbyA9PT0gdHJ1ZSxcclxuICAgICAgfTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4geyBlbnRyeTogJycsIGRlbW86IGZhbHNlIH07IH1cclxuICB9XHJcbiAgYXN5bmMgZnVuY3Rpb24gc2F2ZVJ1bnRpbWVDb25maWcoY2ZnOiB7IGVudHJ5OiBzdHJpbmc7IGRlbW86IGJvb2xlYW4gfSk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgYXdhaXQgd3JpdGVGaWxlKHJ1bnRpbWVDb25maWdGaWxlKCksIEpTT04uc3RyaW5naWZ5KGNmZywgbnVsbCwgMiksICd1dGY4JykuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcclxuICB9XHJcbiAgYXN5bmMgZnVuY3Rpb24gbG9hZFJ1bnRpbWVFbnRyeU92ZXJyaWRlKCk6IFByb21pc2U8c3RyaW5nPiB7XHJcbiAgICByZXR1cm4gKGF3YWl0IGxvYWRSdW50aW1lQ29uZmlnKCkpLmVudHJ5O1xyXG4gIH1cclxuICBhc3luYyBmdW5jdGlvbiBzYXZlUnVudGltZUVudHJ5T3ZlcnJpZGUoZW50cnk6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgYXdhaXQgc2F2ZVJ1bnRpbWVDb25maWcoeyBlbnRyeSwgZGVtbzogKGF3YWl0IGxvYWRSdW50aW1lQ29uZmlnKCkpLmRlbW8gfSk7XHJcbiAgfVxyXG5cclxuICBpbnRlcmZhY2UgRXh0ZXJuYWxSdW50aW1lIHsgZW50cnk6IHN0cmluZzsgdmVyc2lvbjogc3RyaW5nOyBzb3VyY2U6IHN0cmluZyB9XHJcblxyXG4gIC8qKiBcdThCRkJcdTUzMDVcdTcyNDhcdTY3MkMocGFja2FnZS5qc29uIFx1NzY4NCB2ZXJzaW9uIFx1NUI1N1x1NkJCNTtcdTU5MzFcdThEMjVcdTdBN0FcdTRFMzIpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gcGtnVmVyc2lvbkF0KGRpcjogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHYgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKGRpciwgJ3BhY2thZ2UuanNvbicpLCAndXRmOCcpKSBhcyB7IHZlcnNpb24/OiB1bmtub3duIH07XHJcbiAgICAgIHJldHVybiB0eXBlb2Ygdi52ZXJzaW9uID09PSAnc3RyaW5nJyA/IHYudmVyc2lvbiA6ICcnO1xyXG4gICAgfSBjYXRjaCB7IHJldHVybiAnJzsgfVxyXG4gIH1cclxuICAvKiogXHU4QkZCXHU1MzA1XHU1NDBEKFx1NTQwQ1x1NEUwQTtAaG1oYXJuZXNzL2NsaSBcdTVFMDNcdTVDNDBcdThCQzZcdTUyMkJcdTc1MjgpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gcGtnTmFtZUF0KGRpcjogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHYgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKGRpciwgJ3BhY2thZ2UuanNvbicpLCAndXRmOCcpKSBhcyB7IG5hbWU/OiB1bmtub3duIH07XHJcbiAgICAgIHJldHVybiB0eXBlb2Ygdi5uYW1lID09PSAnc3RyaW5nJyA/IHYubmFtZSA6ICcnO1xyXG4gICAgfSBjYXRjaCB7IHJldHVybiAnJzsgfVxyXG4gIH1cclxuXHJcbiAgLyoqIG5wbSBcdTVCODlcdTg4QzVcdTc2ODQgQGhtaGFybmVzcy9jbGkgXHUyMTkyIGRlc2t0b3AtaG9zdCBcdTdGMTZcdThCRDFcdTUxNjVcdTUzRTMoXHU1RDRDXHU1OTU3XHU0RTBFXHU2M0QwXHU1MzQ3XHU0RTI0XHU3OUNEXHU1RTAzXHU1QzQwKVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIGVudHJ5RnJvbUNsaURpcihjbGlEaXI6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICBjb25zdCBuZXN0ZWQgPSBqb2luKGNsaURpciwgJ25vZGVfbW9kdWxlcycsICdAaG1oYXJuZXNzJywgJ3dlYicsICdkaXN0JywgJ2Rlc2t0b3AtaG9zdC5qcycpO1xyXG4gICAgaWYgKGV4aXN0c1N5bmMobmVzdGVkKSkgcmV0dXJuIG5lc3RlZDtcclxuICAgIGNvbnN0IGhvaXN0ZWQgPSBqb2luKGRpcm5hbWUoY2xpRGlyKSwgJ3dlYicsICdkaXN0JywgJ2Rlc2t0b3AtaG9zdC5qcycpO1xyXG4gICAgaWYgKGV4aXN0c1N5bmMoaG9pc3RlZCkpIHJldHVybiBob2lzdGVkO1xyXG4gICAgcmV0dXJuICcnO1xyXG4gIH1cclxuXHJcbiAgLyoqIFx1NTkxNlx1OTBFOFx1NTNEMVx1NzNCMChcdTRGOUJcdTgxRUFcdTUyQThcdThGREVcdTYzQTVcdTRFMEVcdTU0MTFcdTVCRkNcdTY4QzBcdTZENEJcdTk4NzVcdTUxNzFcdTc1MjgpXHUzMDAyXHU0RjE4XHU1MTQ4XHU3RUE3OmVudiA+IHdoZXJlIGhtaCA+IG5wbVxyXG4gICAqICBcdTUxNjhcdTVDNDBcdTY4MzkgPiBcdTU0MTFcdTVCRkNcdTVCODlcdTg4QzVcdTc2RUVcdTVGNTUgfi8uaG1oYXJuZXNzLWdsb2JhbCA+IFx1NkU5MFx1NzgwMVx1NEVEM1x1NjI2Qlx1NjNDRjtcdTU0MENcdTRFMDBcdTVDNDJcdTUxODVcclxuICAgKiAgXCJcdTVERjJcdTg4QzUgQ0xJKG5wbSBcdTVFMDNcdTVDNDApXCIgXHU1MTQ4XHU0RThFIFwiXHU2RTkwXHU3ODAxIHJlcG8gXHU1RTAzXHU1QzQwXCJcdTMwMDIgKi9cclxuICBmdW5jdGlvbiBkZXRlY3RFeHRlcm5hbFJ1bnRpbWUoKTogRXh0ZXJuYWxSdW50aW1lIHtcclxuICAgIC8vIDEpIFx1NzNBRlx1NTg4M1x1NTNEOFx1OTFDRlx1NjYzRVx1NUYwRlx1ODk4Nlx1NzZENihcdTlBRDhcdTdFQTdcdTc1MjhcdTYyMzcpXHJcbiAgICBjb25zdCBlbnZFbnRyeSA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1JFQUxfRU5UUlk7XHJcbiAgICBpZiAoZW52RW50cnkgIT09IHVuZGVmaW5lZCAmJiBlbnZFbnRyeSAhPT0gJycgJiYgaXNBYnNvbHV0ZShlbnZFbnRyeSkpIHtcclxuICAgICAgcmV0dXJuIHsgZW50cnk6IGVudkVudHJ5LCB2ZXJzaW9uOiAnJywgc291cmNlOiAnZW52JyB9O1xyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IHdoZXJlUmVwb3MgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgIGNvbnN0IHdoZXJlQ2xpczogc3RyaW5nW10gPSBbXTtcclxuICAgIGNvbnN0IG5wbVJlcG9zID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICBsZXQgbnBtQ2xpID0gJyc7XHJcbiAgICAvLyAyKSB3aGVyZSBobWg6bnBtIGxpbmsoXHU2RTkwXHU3ODAxXHU2ODM5XHU1RTAzXHU1QzQwKVx1NEUwRSBAaG1oYXJuZXNzL2NsaSBucG0gXHU1Qjg5XHU4OEM1XHU1RTAzXHU1QzQwXHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCBvdXQgPSBleGVjRmlsZVN5bmMoJ3doZXJlJywgWydobWgnXSwgeyBlbmNvZGluZzogJ3V0ZjgnLCB0aW1lb3V0OiA0XzAwMCwgd2luZG93c0hpZGU6IHRydWUgfSk7XHJcbiAgICAgIGZvciAoY29uc3QgbGluZSBvZiBvdXQuc3BsaXQoL1xccj9cXG4vKSkge1xyXG4gICAgICAgIGNvbnN0IGJpbiA9IGxpbmUudHJpbSgpO1xyXG4gICAgICAgIGlmIChiaW4gPT09ICcnKSBjb250aW51ZTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgY29uc3QgYmluRGlyID0gZGlybmFtZShiaW4pO1xyXG4gICAgICAgICAgY29uc3QgbGlua2VkID0gam9pbihiaW5EaXIsICdub2RlX21vZHVsZXMnLCAnaG1oYXJuZXNzJyk7XHJcbiAgICAgICAgICBpZiAoZXhpc3RzU3luYyhsaW5rZWQpKSB3aGVyZVJlcG9zLmFkZChyZWFscGF0aFN5bmMobGlua2VkKSk7XHJcbiAgICAgICAgICBjb25zdCBjbGkgPSBqb2luKGJpbkRpciwgJ25vZGVfbW9kdWxlcycsICdAaG1oYXJuZXNzJywgJ2NsaScpO1xyXG4gICAgICAgICAgaWYgKGV4aXN0c1N5bmMoY2xpKSkgd2hlcmVDbGlzLnB1c2goY2xpKTtcclxuICAgICAgICB9IGNhdGNoIHsgLyogYmluIFx1NUUwM1x1NUM0MFx1NEUwRFx1N0IyNixcdThERjNcdThGQzcgKi8gfVxyXG4gICAgICB9XHJcbiAgICB9IGNhdGNoIHsgLyogaG1oIFx1NEUwRFx1NTcyOCBQQVRIICovIH1cclxuICAgIC8vIDMpIG5wbSBcdTUxNjhcdTVDNDBcdTY4MzkoXHU0RTI0XHU3OUNEXHU1RTAzXHU1QzQwXHU1NDBDIHdoZXJlKVxyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3Qgb3V0ID0gZXhlY0ZpbGVTeW5jKCducG0nLCBbJ3Jvb3QnLCAnLWcnXSwgeyBlbmNvZGluZzogJ3V0ZjgnLCB0aW1lb3V0OiA2XzAwMCwgd2luZG93c0hpZGU6IHRydWUgfSk7XHJcbiAgICAgIGNvbnN0IHJvb3QgPSBvdXQudHJpbSgpO1xyXG4gICAgICBjb25zdCBsaW5rZWQgPSBqb2luKHJvb3QsICdobWhhcm5lc3MnKTtcclxuICAgICAgaWYgKGV4aXN0c1N5bmMobGlua2VkKSkgbnBtUmVwb3MuYWRkKHJlYWxwYXRoU3luYyhsaW5rZWQpKTtcclxuICAgICAgY29uc3QgY2xpID0gam9pbihyb290LCAnQGhtaGFybmVzcycsICdjbGknKTtcclxuICAgICAgaWYgKGV4aXN0c1N5bmMoY2xpKSkgbnBtQ2xpID0gY2xpO1xyXG4gICAgfSBjYXRjaCB7IC8qIG5wbSBcdTRFMERcdTUzRUZcdTc1MjggKi8gfVxyXG5cclxuICAgIC8vIFx1NURGMlx1ODhDNSBDTEkoQGhtaGFybmVzcy9jbGkgbnBtIFx1NUUwM1x1NUM0MDtkZXNrdG9wLWhvc3QgXHU0RTNBXHU3RjE2XHU4QkQxXHU0RUE3XHU3MjY5XHU1M0VGXHU3NkY0XHU4REQxKTpcclxuICAgIC8vIHdoZXJlKFBBVEggXHU3NzFGXHU3NkY4KT4gbnBtIFx1NTE2OFx1NUM0MFx1NjgzOSA+IFx1NTQxMVx1NUJGQ1x1NUI4OVx1ODhDNVx1NzZFRVx1NUY1NVxyXG4gICAgZm9yIChjb25zdCBbY2xpLCBzb3VyY2VdIG9mIFtbd2hlcmVDbGlzWzBdID8/ICcnLCAnd2hlcmUtaG1oJ10sIFtucG1DbGksICducG0tZ2xvYmFsJ11dIGFzIEFycmF5PFtzdHJpbmcsIHN0cmluZ10+KSB7XHJcbiAgICAgIGlmIChjbGkgPT09ICcnKSBjb250aW51ZTtcclxuICAgICAgY29uc3QgZW50cnkgPSBlbnRyeUZyb21DbGlEaXIoY2xpKTtcclxuICAgICAgaWYgKGVudHJ5ICE9PSAnJykgcmV0dXJuIHsgZW50cnksIHZlcnNpb246IHBrZ1ZlcnNpb25BdChjbGkpLCBzb3VyY2UgfTtcclxuICAgIH1cclxuICAgIGNvbnN0IHdpemFyZEVudHJ5ID0gcmVzb2x2ZUluc3RhbGxlZEVudHJ5KGluc3RhbGxUYXJnZXQoKSk7XHJcbiAgICBpZiAod2l6YXJkRW50cnkgIT09ICcnKSB7XHJcbiAgICAgIHJldHVybiB7IGVudHJ5OiB3aXphcmRFbnRyeSwgdmVyc2lvbjogcGtnVmVyc2lvbkF0KGpvaW4oaW5zdGFsbFRhcmdldCgpLCAnbm9kZV9tb2R1bGVzJywgJ0BobWhhcm5lc3MnLCAnY2xpJykpLCBzb3VyY2U6ICd3aXphcmQtaW5zdGFsbCcgfTtcclxuICAgIH1cclxuXHJcbiAgICAvLyBcdTZFOTBcdTc4MDEgcmVwbyBcdTVFMDNcdTVDNDAod2hlcmUgPiBucG0gXHU1MTY4XHU1QzQwID4gXHU1RTM4XHU4OUMxXHU2RTkwXHU3ODAxXHU0RjREXHU3RjZFO1x1NTQ3RFx1NEUyRFx1OTg3Qlx1NjcwOVx1NTE2NVx1NTNFM1x1NEUwRVx1NEY5RFx1OEQ1NilcclxuICAgIGNvbnN0IHJlcG9zID0gbmV3IFNldDxzdHJpbmc+KFsuLi53aGVyZVJlcG9zLCAuLi5ucG1SZXBvc10pO1xyXG4gICAgY29uc3QgYmFzZXMgPSBbJ0M6XFxcXCcsICdEOlxcXFwnLCAnRTpcXFxcJywgJ0Y6XFxcXCcsICdHOlxcXFwnLCAnSDpcXFxcJywgaG9tZWRpcigpLCBqb2luKGhvbWVkaXIoKSwgJ0RldmVsb3BlcicpXTtcclxuICAgIGZvciAoY29uc3QgYmFzZSBvZiBiYXNlcykge1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHAgPSByZXNvbHZlKGJhc2UsICdobWhhcm5lc3MnKTtcclxuICAgICAgICBpZiAoZXhpc3RzU3luYyhwKSkgcmVwb3MuYWRkKHApO1xyXG4gICAgICB9IGNhdGNoIHsgLyogXHU3NkQ4XHU0RTBEXHU1QjU4XHU1NzI4ICovIH1cclxuICAgIH1cclxuICAgIGZvciAoY29uc3QgcmVwbyBvZiByZXBvcykge1xyXG4gICAgICBjb25zdCBlbnRyeSA9IGpvaW4ocmVwbywgJ3BhY2thZ2VzJywgJ3dlYicsICdzcmMnLCAnZGVza3RvcC1ob3N0LnRzJyk7XHJcbiAgICAgIGlmIChleGlzdHNTeW5jKGVudHJ5KSAmJiBleGlzdHNTeW5jKGpvaW4ocmVwbywgJ25vZGVfbW9kdWxlcycpKSkge1xyXG4gICAgICAgIHJldHVybiB7IGVudHJ5LCB2ZXJzaW9uOiBwa2dWZXJzaW9uQXQocmVwbyksIHNvdXJjZTogJ3NvdXJjZS1yZXBvJyB9O1xyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4geyBlbnRyeTogJycsIHZlcnNpb246ICcnLCBzb3VyY2U6ICcnIH07XHJcbiAgfVxyXG5cclxuICBmdW5jdGlvbiBkZXRlY3RSZWFsRW50cnkoKTogc3RyaW5nIHtcclxuICAgIHJldHVybiBkZXRlY3RFeHRlcm5hbFJ1bnRpbWUoKS5lbnRyeTtcclxuICB9XHJcblxyXG4gIC8qKiBcdTg5RTNcdTY3OTAgcnVudGltZSBcdTUxNjVcdTUzRTNcdTYyNDBcdTVDNUVcdTc2ODQgaG1oYXJuZXNzIFx1NEVEM1x1NUU5M1x1NjgzOShwYWNrYWdlcy93ZWIvc3JjfGRpc3QgXHU0RTBBXHU2RUFGKVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIHJlcG9Sb290T2YoZW50cnk6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICBsZXQgZGlyID0gZGlybmFtZShlbnRyeSk7XHJcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IDY7IGkrKykge1xyXG4gICAgICBpZiAoZXhpc3RzU3luYyhqb2luKGRpciwgJ3BhY2thZ2UuanNvbicpKSAmJiBleGlzdHNTeW5jKGpvaW4oZGlyLCAncGFja2FnZXMnLCAnd2ViJykpKSByZXR1cm4gZGlyO1xyXG4gICAgICBjb25zdCBwYXJlbnQgPSBkaXJuYW1lKGRpcik7XHJcbiAgICAgIGlmIChwYXJlbnQgPT09IGRpcikgYnJlYWs7XHJcbiAgICAgIGRpciA9IHBhcmVudDtcclxuICAgIH1cclxuICAgIHJldHVybiBkaXJuYW1lKGVudHJ5KTtcclxuICB9XHJcblxyXG4gIGxldCBydW50aW1lRW50cnkgPSAnJzsgLy8gXHU1RjUzXHU1MjREXHU1QjlFXHU5NjQ1XHU0RjdGXHU3NTI4XHU3Njg0XHU3NzFGXHU1QjlFIHJ1bnRpbWUgXHU1MTY1XHU1M0UzKCcnPVx1NjcyQVx1NjNBNSlcclxuICBsZXQgdXNlQnVuZGxlZFJ1bnRpbWUgPSBmYWxzZTsgLy8gdjU6XHU2NjJGXHU1NDI2XHU1NzI4XHU3NTI4XHU1MTg1XHU3RjZFIHJ1bnRpbWUoXHU1MTczXHU0RThFL1x1OTc2Mlx1Njc3Rlx1NjgwN1x1NkNFOClcclxuXHJcbiAgLyoqIFx1NTE4NVx1N0Y2RSBydW50aW1lKHY1IFx1NUYwMFx1N0JCMVx1NTM3M1x1NzUyOCk6XHU2MjUzXHU1MzA1XHU1NDBFXHU5NjhGIGV4dHJhUmVzb3VyY2VzIFx1NUU3M1x1OTRGQVx1NTcyOCByZXNvdXJjZXMvO1xyXG4gICAgIGRldiBcdTc1MjhcdTRFRDNcdTVFOTNcdTUxODVcdTY3ODRcdTVFRkFcdTRFQTdcdTcyNjkoc2NyaXB0cy9idW5kbGUtcnVudGltZS5tanMpXHUzMDAyXHU4MUVBXHU1MzA1XHU1NDJCXHU1MzU1XHU2NTg3XHU0RUY2LFx1NjVFMCB0c3hcdTMwMDFcclxuICAgICBcdTY1RTAgcmVwbyBub2RlX21vZHVsZXMgXHU0RjlEXHU4RDU2XHUzMDAyICovXHJcbiAgZnVuY3Rpb24gYnVuZGxlZFJ1bnRpbWVQYXRoKHJlcG9Sb290OiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIGpvaW4oYXBwLmlzUGFja2FnZWQgPyBwcm9jZXNzLnJlc291cmNlc1BhdGggOiBqb2luKHJlcG9Sb290LCAnYXBwcycsICdkZXNrdG9wJywgJ3Jlc291cmNlcycpLCAncnVudGltZScsICdydW50aW1lLmNqcycpO1xyXG4gIH1cclxuXHJcbiAgLyoqIFx1NTE4NVx1N0Y2RSBydW50aW1lIFx1NTE0M1x1NEZFMVx1NjA2RihcdTU0MTFcdTVCRkNcIlx1NTE4NVx1N0Y2RVx1N0NCRVx1N0I4MFx1NTE4NVx1NjgzOFwiXHU5MDA5XHU5ODc5XHU3Njg0XHU3MjQ4XHU2NzJDXHU2ODA3XHU2Q0U4KVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIGJ1bmRsZWRSdW50aW1lSW5mbygpOiB7IHJlYWR5OiBib29sZWFuOyB2ZXJzaW9uOiBzdHJpbmcgfSB7XHJcbiAgICBjb25zdCByZXBvUm9vdCA9IGpvaW4oaGVyZSwgJy4uJywgJy4uJywgJy4uJywgJy4uJyk7XHJcbiAgICBjb25zdCBwID0gYnVuZGxlZFJ1bnRpbWVQYXRoKHJlcG9Sb290KTtcclxuICAgIGxldCB2ZXJzaW9uID0gJyc7XHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCB2ID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoam9pbihkaXJuYW1lKHApLCAncGFja2FnZS5qc29uJyksICd1dGY4JykpIGFzIHsgdmVyc2lvbj86IHVua25vd24gfTtcclxuICAgICAgdmVyc2lvbiA9IHR5cGVvZiB2LnZlcnNpb24gPT09ICdzdHJpbmcnID8gdi52ZXJzaW9uIDogJyc7XHJcbiAgICB9IGNhdGNoIHsgLyogXHU1MTQzXHU2NTcwXHU2MzZFXHU3RjNBXHU1OTMxXHU1MjE5XHU1M0VBXHU2MkE1IHJlYWR5ICovIH1cclxuICAgIHJldHVybiB7IHJlYWR5OiBleGlzdHNTeW5jKHApLCB2ZXJzaW9uIH07XHJcbiAgfVxyXG5cclxuICAvKiogbnBtIFx1NjYyRlx1NTQyNlx1NTcyOCBQQVRIKFx1NTQxMVx1NUJGQ1x1OTAwOVx1NjJFOVx1OTg3NSBcdTI0NjAgXHU3Njg0XHU1Qjg5XHU4OEM1XHU2NUI5XHU1RjBGXHU2ODA3XHU2Q0U4O3doZXJlIFx1NUZFQlx1NjNBMixcdTRFMERcdTUwNUFcdTVCOENcdTY1NzRcdTYzQTJcdTZENEIpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gbnBtT25QYXRoKCk6IGJvb2xlYW4ge1xyXG4gICAgdHJ5IHtcclxuICAgICAgZXhlY0ZpbGVTeW5jKCd3aGVyZScsIFsnbnBtJ10sIHsgZW5jb2Rpbmc6ICd1dGY4JywgdGltZW91dDogNF8wMDAsIHdpbmRvd3NIaWRlOiB0cnVlIH0pO1xyXG4gICAgICByZXR1cm4gdHJ1ZTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4gZmFsc2U7IH1cclxuICB9XHJcblxyXG4gIC8qIC0tLS0gXHU5OTk2XHU1NDJGXHU1Qjg5XHU4OEM1XHU1NDExXHU1QkZDXHU3MkI2XHU2MDAxKHY1LjEpIC0tLS0gKi9cclxuICBjb25zdCB3aXphcmRGaWxlID0gKCk6IHN0cmluZyA9PiBqb2luKGFwcC5nZXRQYXRoKCd1c2VyRGF0YScpLCAnd2l6YXJkLmpzb24nKTtcclxuICBhc3luYyBmdW5jdGlvbiBsb2FkV2l6YXJkU3RhdGUoKTogUHJvbWlzZTx7IGRvbmU6IGJvb2xlYW47IGNob2ljZTogc3RyaW5nIH0+IHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHYgPSBKU09OLnBhcnNlKGF3YWl0IHJlYWRGaWxlKHdpemFyZEZpbGUoKSwgJ3V0ZjgnKSkgYXMgeyBkb25lPzogdW5rbm93bjsgY2hvaWNlPzogdW5rbm93biB9O1xyXG4gICAgICByZXR1cm4geyBkb25lOiB2LmRvbmUgPT09IHRydWUsIGNob2ljZTogdHlwZW9mIHYuY2hvaWNlID09PSAnc3RyaW5nJyA/IHYuY2hvaWNlIDogJycgfTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4geyBkb25lOiBmYWxzZSwgY2hvaWNlOiAnJyB9OyB9XHJcbiAgfVxyXG4gIGFzeW5jIGZ1bmN0aW9uIHNhdmVXaXphcmRTdGF0ZShjaG9pY2U6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgYXdhaXQgd3JpdGVGaWxlKHdpemFyZEZpbGUoKSwgSlNPTi5zdHJpbmdpZnkoeyBkb25lOiB0cnVlLCBjaG9pY2UgfSwgbnVsbCwgMiksICd1dGY4JykuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcclxuICB9XHJcbiAgLyoqIFx1NTQxMVx1NUJGQ1x1ODFFQVx1NTJBOFx1NUYzOVx1NTFGQVx1NjI5MVx1NTIzNjpcdTZENEJcdThCRDUvXHU1RjAwXHU1M0QxXHU3M0FGXHU1ODgzXHU0RTBEXHU1RjM5KFVJVkVSSUZZL1NOQVBTSE9UL1JFTkRFUl9URVNUL1xyXG4gICAqICBET01QUk9CRS9TRUNVUklUWV9URVNUL0ZBS0UvZGV2KTtITUhfREVTS1RPUF9XSVpBUkRfRk9SQ0U9MSBcdTVGM0FcdTUyMzZcdTVGMzkoXHU5QThDXHU2NTM2KVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIHdpemFyZFN1cHByZXNzZWQoKTogYm9vbGVhbiB7XHJcbiAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfV0laQVJEX0ZPUkNFID09PSAnMScpIHJldHVybiBmYWxzZTtcclxuICAgIHJldHVybiBpc0RldlxyXG4gICAgICB8fCBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWSA9PT0gJzEnXHJcbiAgICAgIHx8IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NOQVBTSE9UICE9PSB1bmRlZmluZWRcclxuICAgICAgfHwgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVklTUkVHID09PSAnMSdcclxuICAgICAgfHwgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfUkVOREVSX1RFU1QgPT09ICcxJ1xyXG4gICAgICB8fCBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9ET01QUk9CRSA9PT0gJzEnXHJcbiAgICAgIHx8IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NFQ1VSSVRZX1RFU1QgPT09ICcxJ1xyXG4gICAgICB8fCBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9GQUtFID09PSAnMSc7XHJcbiAgfVxyXG5cclxuICAvKiogXHU1M0QxXHU3M0IwXHU5ODdBXHU1RThGOlx1NjYzRVx1NUYwRlx1ODk4Nlx1NzZENihcdTU0MkJcdTU0MTFcdTVCRkNcdTkwMDlcdTYyRTk6XHU1OTE2XHU5MEU4XHU1MTY1XHU1M0UzL1x1NTE4NVx1N0Y2RVx1OERFRlx1NUY4NC9cdTZGMTRcdTc5M0EpPiBcdTUxODVcdTdGNkVcdTVGMDBcdTUxNzNcclxuICAgICAoSE1IX0RFU0tUT1BfQlVORExFRD0xKT4gXHU1OTE2XHU5MEU4XHU1M0QxXHU3M0IwKGRldiBcdTc2RjhcdTkwQkJcdTRFRDNcdTVFOTMgLyB3aGVyZSBobWggLyBucG0gXHU1MTY4XHU1QzQwIC9cclxuICAgICBcdTU0MTFcdTVCRkNcdTVCODlcdTg4QzVcdTc2RUVcdTVGNTUgLyBcdTZFOTBcdTc4MDFcdTRGNERcdTdGNkUpPiBcdTUxODVcdTdGNkVcdTUxNUNcdTVFOTVcdTMwMDJcdTU5MTZcdTkwRThcdTRGMThcdTUxNDg9XHU4MDAxXHU3NTI4XHU2MjM3XHU3RUU3XHU3RUVEXHU3NTI4XHU4MUVBXHU1REYxXHU4OEM1XHU3Njg0XHU3MjQ4XHU2NzJDO1xyXG4gICAgIFx1NTE4NVx1N0Y2RT1cdTY1QjBcdTY3M0FcdTU2NjhcdTg4QzVcdTVCOENcdTc2RjRcdThGREVcdTc3MUZcdTVCOUVcdTUxODVcdTY4MzhcdTMwMDJITUhfREVTS1RPUF9GQUtFPTEgXHU2MjE2IHJ1bnRpbWUuanNvbiBkZW1vPXRydWVcclxuICAgICAoXHU1NDExXHU1QkZDXCJcdTZGMTRcdTc5M0FcdTZBMjFcdTVGMEZcIlx1OTAwOVx1NjJFOSxcdTYzMDFcdTRFNDUpXHU4RkRCXHU2RjE0XHU3OTNBXHUzMDAyICovXHJcbiAgYXN5bmMgZnVuY3Rpb24gc3RhcnRIb3N0KCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3QgcmVwb1Jvb3QgPSBqb2luKGhlcmUsICcuLicsICcuLicsICcuLicsICcuLicpOyAvLyBhcHBzL2Rlc2t0b3AvZGlzdC1lbGVjdHJvbi9tYWluIFx1MjE5MiByZXBvIHJvb3RcclxuICAgIGNvbnN0IHBhY2thZ2VkID0gYXBwLmlzUGFja2FnZWQ7XHJcbiAgICBjb25zdCBjZmcgPSBhd2FpdCBsb2FkUnVudGltZUNvbmZpZygpO1xyXG4gICAgY29uc3QgZm9yY2VGYWtlID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfRkFLRSA9PT0gJzEnIHx8IGNmZy5kZW1vO1xyXG4gICAgY29uc3QgZm9yY2VCdW5kbGVkID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfQlVORExFRCA9PT0gJzEnO1xyXG4gICAgY29uc3Qgb3ZlcnJpZGUgPSBjZmcuZW50cnk7XHJcbiAgICBjb25zdCBhZGphY2VudCA9IGpvaW4ocmVwb1Jvb3QsICcuLicsICdobWhhcm5lc3MnLCAncGFja2FnZXMnLCAnd2ViJywgJ3NyYycsICdkZXNrdG9wLWhvc3QudHMnKTtcclxuICAgIGNvbnN0IGJ1bmRsZWQgPSBidW5kbGVkUnVudGltZVBhdGgocmVwb1Jvb3QpO1xyXG4gICAgY29uc3QgYnVuZGxlZFJlYWR5ID0gZXhpc3RzU3luYyhidW5kbGVkKTtcclxuICAgIC8vIFx1ODlFM1x1Njc5MChcdTdFRDNcdTY3OUNcdTVGNTJcdTRFMDA6b3ZlcnJpZGU9YnVuZGxlZCBcdThERUZcdTVGODRcdTIxOTJcdTUxODVcdTdGNkU7XHU2RTkwXHU3ODAxIC50cyBcdTk3MDAgdHN4O1xyXG4gICAgLy8gbnBtIFx1NUI4OVx1ODhDNSAuanMgXHU3RjE2XHU4QkQxXHU0RUE3XHU3MjY5XHU3NkY0XHU4REQxO2J1bmRsZWQ9XHU4MUVBXHU1MzA1XHU1NDJCIGNqcyBcdTc2RjRcdThERDEpXHJcbiAgICBsZXQgZW50cnkgPSAnJztcclxuICAgIHVzZUJ1bmRsZWRSdW50aW1lID0gZmFsc2U7XHJcbiAgICBpZiAoZm9yY2VGYWtlKSB7XHJcbiAgICAgIC8vIFx1NkYxNFx1NzkzQVx1NkEyMVx1NUYwRlxyXG4gICAgfSBlbHNlIGlmIChvdmVycmlkZSAhPT0gJycpIHtcclxuICAgICAgZW50cnkgPSBvdmVycmlkZTtcclxuICAgICAgaWYgKG92ZXJyaWRlID09PSBidW5kbGVkKSB1c2VCdW5kbGVkUnVudGltZSA9IHRydWU7IC8vIFx1NTQxMVx1NUJGQ1x1OTAwOVwiXHU1MTg1XHU3RjZFXHU3Q0JFXHU3QjgwXHU1MTg1XHU2ODM4XCJcdTc2ODRcdTYzMDFcdTRFNDVcdTVGNjJcdTYwMDFcclxuICAgIH0gZWxzZSBpZiAoZm9yY2VCdW5kbGVkKSB7XHJcbiAgICAgIGlmIChidW5kbGVkUmVhZHkpIHsgZW50cnkgPSBidW5kbGVkOyB1c2VCdW5kbGVkUnVudGltZSA9IHRydWU7IH1cclxuICAgICAgZWxzZSBsb2dJbmZvKCdob3N0JywgJ0hNSF9ERVNLVE9QX0JVTkRMRUQ9MSBcdTRGNDZcdTUxODVcdTdGNkUgcnVudGltZSBcdTdGM0FcdTU5MzEoXHU1MTQ4XHU4REQxIHNjcmlwdHMvYnVuZGxlLXJ1bnRpbWUubWpzKScpO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgZW50cnkgPSBwYWNrYWdlZCA/IGRldGVjdFJlYWxFbnRyeSgpIDogKGV4aXN0c1N5bmMoYWRqYWNlbnQpID8gYWRqYWNlbnQgOiBkZXRlY3RSZWFsRW50cnkoKSk7XHJcbiAgICAgIGlmIChlbnRyeSA9PT0gJycgJiYgYnVuZGxlZFJlYWR5KSB7IGVudHJ5ID0gYnVuZGxlZDsgdXNlQnVuZGxlZFJ1bnRpbWUgPSB0cnVlOyB9XHJcbiAgICB9XHJcbiAgICBydW50aW1lRW50cnkgPSBlbnRyeTtcclxuICAgIGNvbnN0IHVzZVJlYWwgPSBlbnRyeSAhPT0gJycgJiYgKHVzZUJ1bmRsZWRSdW50aW1lIHx8IGV4aXN0c1N5bmMoZW50cnkpKTtcclxuICAgIGJyaWRnZSA9IHtcclxuICAgICAgLi4uYnJpZGdlLFxyXG4gICAgICBtb2RlOiB1c2VSZWFsID8gJ3JlYWwnIDogJ2Zha2UnLFxyXG4gICAgICBydW50aW1lRW50cnk6IHVzZVJlYWwgPyAodXNlQnVuZGxlZFJ1bnRpbWUgPyBgJHtlbnRyeX0gKGJ1bmRsZWQpYCA6IGVudHJ5KSA6IG51bGwsXHJcbiAgICB9O1xyXG4gICAgbGV0IHNwZWM6IHsgY29tbWFuZDogc3RyaW5nOyBhcmdzOiBzdHJpbmdbXTsgZW52OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+OyBjd2Q/OiBzdHJpbmcgfTtcclxuICAgIGlmICh1c2VCdW5kbGVkUnVudGltZSkge1xyXG4gICAgICBzcGVjID0ge1xyXG4gICAgICAgIGNvbW1hbmQ6IHByb2Nlc3MuZXhlY1BhdGgsXHJcbiAgICAgICAgYXJnczogW2VudHJ5XSwgLy8gXHU4MUVBXHU1MzA1XHU1NDJCXHU1MzU1XHU2NTg3XHU0RUY2OmVsZWN0cm9uLWFzLW5vZGUgXHU3NkY0XHU4REQxLFx1NjVFMCB0c3ggXHU2NUUwIHJlcG9cclxuICAgICAgICBlbnY6IHsgRUxFQ1RST05fUlVOX0FTX05PREU6ICcxJyB9LFxyXG4gICAgICB9O1xyXG4gICAgfSBlbHNlIGlmICh1c2VSZWFsICYmIGVudHJ5LmVuZHNXaXRoKCcuanMnKSkge1xyXG4gICAgICBzcGVjID0ge1xyXG4gICAgICAgIGNvbW1hbmQ6IHByb2Nlc3MuZXhlY1BhdGgsXHJcbiAgICAgICAgYXJnczogW2VudHJ5XSwgLy8gbnBtIFx1NUI4OVx1ODhDNVx1NzY4NFx1N0YxNlx1OEJEMVx1NEVBN1x1NzI2OTpFU00gXHU0RjlEXHU4RDU2XHU2MzA5XHU2NTg3XHU0RUY2XHU0RjREXHU3RjZFXHU4OUUzXHU2NzkwLFx1NzZGNFx1OEREMVx1NTM3M1x1NTNFRlxyXG4gICAgICAgIGN3ZDogZGlybmFtZShlbnRyeSksXHJcbiAgICAgICAgZW52OiB7IEVMRUNUUk9OX1JVTl9BU19OT0RFOiAnMScgfSxcclxuICAgICAgfTtcclxuICAgIH0gZWxzZSBpZiAodXNlUmVhbCkge1xyXG4gICAgICBjb25zdCByZXBvID0gcmVwb1Jvb3RPZihlbnRyeSk7XHJcbiAgICAgIHNwZWMgPSB7XHJcbiAgICAgICAgY29tbWFuZDogcHJvY2Vzcy5leGVjUGF0aCxcclxuICAgICAgICBhcmdzOiBbJy0taW1wb3J0JywgJ3RzeCcsIGVudHJ5XSxcclxuICAgICAgICBjd2Q6IHJlcG8sIC8vIGJhcmUgJ3RzeCcgXHU0RTBFIHdvcmtzcGFjZSBcdTRGOURcdThENTZcdTkwRkRcdTRFQ0UgcmVwbyBcdTc2ODQgbm9kZV9tb2R1bGVzIFx1ODlFM1x1Njc5MFxyXG4gICAgICAgIGVudjogeyBFTEVDVFJPTl9SVU5fQVNfTk9ERTogJzEnIH0sXHJcbiAgICAgIH07XHJcbiAgICB9IGVsc2UgaWYgKHBhY2thZ2VkKSB7XHJcbiAgICAgIHNwZWMgPSB7XHJcbiAgICAgICAgY29tbWFuZDogcHJvY2Vzcy5leGVjUGF0aCxcclxuICAgICAgICBhcmdzOiBbam9pbihwcm9jZXNzLnJlc291cmNlc1BhdGgsICdmYWtlLWhvc3QuY2pzJyldLFxyXG4gICAgICAgIGVudjogeyBFTEVDVFJPTl9SVU5fQVNfTk9ERTogJzEnIH0sXHJcbiAgICAgIH07XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICBzcGVjID0ge1xyXG4gICAgICAgIGNvbW1hbmQ6IHByb2Nlc3MuZXhlY1BhdGgsXHJcbiAgICAgICAgLy8gXHU3NkY0XHU2M0E1XHU4RDcwXHU1MzA1XHU3NzFGXHU1QjlFXHU4REVGXHU1Rjg0KG5vZGVfbW9kdWxlcyBcdTkxQ0NcdTc2ODQgd29ya3NwYWNlIGp1bmN0aW9uIFx1NEYxQVx1ODhBQiBFU01cclxuICAgICAgICAvLyByZWFscGF0aCBcdTUzMTYsXHU1QkZDXHU4MUY0IGZha2UtaG9zdCBcdTc2ODQgYXJndlsxXS9pbXBvcnQubWV0YS51cmwgXHU1MzM5XHU5MTREXHU1OTMxXHU2NTQ4KVxyXG4gICAgICAgIGFyZ3M6IFsnLS1pbXBvcnQnLCAndHN4Jywgam9pbihyZXBvUm9vdCwgJ3BhY2thZ2VzJywgJ2hvc3QtYWRhcHRlcicsICdzcmMnLCAnZmFrZS1ob3N0LnRzJyldLFxyXG4gICAgICAgIGVudjogeyBFTEVDVFJPTl9SVU5fQVNfTk9ERTogJzEnIH0sXHJcbiAgICAgIH07XHJcbiAgICB9XHJcbiAgICBzdXBlcnZpc29yID0gbmV3IERlc2t0b3BSdW50aW1lU3VwZXJ2aXNvcihzcGVjLCB7XHJcbiAgICAgIG9uU3RhdGVDaGFuZ2U6IGJyb2FkY2FzdEhvc3RTdGF0ZSxcclxuICAgICAgLy8gXHU5OTk2XHU2QjIxXHU1NDJGXHU1MkE4XHU0RTBFIGNyYXNoIFx1ODFFQVx1NjEwOFx1NTQwRVx1NzY4NFx1OTFDRFx1NTQyRlx1OTBGRFx1NEYxQVx1OEQ3MFx1OEZEOVx1OTFDQzpcdTdBRUZcdTUzRTMvdG9rZW4gXHU5MEZEXHU2NjJGXHU2NUIwXHU3Njg0LFxyXG4gICAgICAvLyBcdTkxQ0RcdTVFRkFcdTY4NjVcdTVCQTJcdTYyMzdcdTdBRUZcdTVFNzZcdTkxQ0RcdTY1QjBcdThCQTJcdTk2MDUgU1NFKHJlbmRlcmVyIFx1NzY4NCBFdmVudFN0b3JlIFx1OTc2MCBldmVudElkIFx1NTNCQlx1OTFDRClcclxuICAgICAgb25SZWFkeTogKGVwKSA9PiB7XHJcbiAgICAgICAgY2xpZW50ID0gbmV3IERlc2t0b3BIb3N0Q2xpZW50KGBodHRwOi8vMTI3LjAuMC4xOiR7ZXAucG9ydH1gLCBlcC50b2tlbik7XHJcbiAgICAgICAgc3NlQWJvcnQ/LmFib3J0KCk7XHJcbiAgICAgICAgc3NlQWJvcnQgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XHJcbiAgICAgICAgbGFzdEV2ZW50SWQgPSAnJztcclxuICAgICAgICB2b2lkIHB1bXBFdmVudHMoKTtcclxuICAgICAgICBsb2dJbmZvKCdob3N0JywgYGJyaWRnZSByZWFkeSBvbiAxMjcuMC4wLjE6JHtlcC5wb3J0fSAocnVudGltZSAke2VwLnZlcnNpb259LCBtb2RlICR7YnJpZGdlLm1vZGV9JHt1c2VSZWFsID8gYCwgZW50cnk9JHtydW50aW1lRW50cnl9JHt1c2VCdW5kbGVkUnVudGltZSA/ICcgW2J1bmRsZWRdJyA6ICcnfWAgOiAnJ30pYCk7XHJcbiAgICAgIH0sXHJcbiAgICB9KTtcclxuICAgIHRyeSB7XHJcbiAgICAgIGF3YWl0IHN1cGVydmlzb3Iuc3RhcnQoKTtcclxuICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICBjb25zdCBkZXRhaWwgPSAoKCkgPT4geyB0cnkgeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkoZXJyKTsgfSBjYXRjaCB7IHJldHVybiBTdHJpbmcoZXJyKTsgfSB9KSgpLnNsaWNlKDAsIDQwMCk7XHJcbiAgICAgIGJyaWRnZSA9IHsgLi4uYnJpZGdlLCBob3N0U3RhdGU6ICdmYWlsZWQnLCBsYXN0RXJyb3I6IGRldGFpbCB9O1xyXG4gICAgICBsb2dJbmZvKCdob3N0JywgYHN0YXJ0IGZhaWxlZDogJHtkZXRhaWx9YCk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvKiAtLS0tIElQQyBcdTc2N0RcdTU0MERcdTUzNTUgKyBzZW5kZXIgXHU2ODIxXHU5QThDIC0tLS0gKi9cclxuICBjb25zdCBhbGxvd2VkT3JpZ2lucyA9IG5ldyBTZXQ8c3RyaW5nPihcclxuICAgIGlzRGV2ICYmIHJlbmRlcmVyRGV2VXJsXHJcbiAgICAgID8gW3JlbmRlcmVyRGV2VXJsXVxyXG4gICAgICA6IFtwYXRoVG9GaWxlVVJMKGpvaW4oaGVyZSwgJy4uJywgJy4uJywgJ2Rpc3QtcmVuZGVyZXInLCAnaW5kZXguaHRtbCcpKS5ocmVmXSxcclxuICApO1xyXG5cclxuICBmdW5jdGlvbiBzZW5kZXJUcnVzdGVkKHNlbmRlckZyYW1lOiBFbGVjdHJvbi5XZWJGcmFtZU1haW4gfCBudWxsIHwgdW5kZWZpbmVkKTogYm9vbGVhbiB7XHJcbiAgICBpZiAoc2VuZGVyRnJhbWUgPT09IG51bGwgfHwgc2VuZGVyRnJhbWUgPT09IHVuZGVmaW5lZCkgcmV0dXJuIGZhbHNlO1xyXG4gICAgbGV0IHRvcDogRWxlY3Ryb24uV2ViRnJhbWVNYWluIHwgbnVsbCA9IHNlbmRlckZyYW1lO1xyXG4gICAgd2hpbGUgKHRvcD8ucGFyZW50ICE9PSBudWxsICYmIHRvcD8ucGFyZW50ICE9PSB1bmRlZmluZWQpIHRvcCA9IHRvcC5wYXJlbnQ7XHJcbiAgICBjb25zdCB1cmwgPSB0b3A/LnVybCA/PyAnJztcclxuICAgIGZvciAoY29uc3Qgb3JpZ2luIG9mIGFsbG93ZWRPcmlnaW5zKSB7XHJcbiAgICAgIGlmICh1cmwgPT09IG9yaWdpbiB8fCB1cmwuc3RhcnRzV2l0aChgJHtvcmlnaW59L2ApIHx8IHVybC5zdGFydHNXaXRoKGAke29yaWdpbn0/YCkpIHJldHVybiB0cnVlO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGZhbHNlO1xyXG4gIH1cclxuXHJcbiAgLyoqIFx1OTcwMFx1ODk4MSBob3N0IFx1NUMzMVx1N0VFQVx1NzY4NCBJUEMgaGFuZGxlciBcdTUxNkNcdTUxNzFcdTU4RjM6XHU2NzJBXHU1QzMxXHU3RUVBXHU4RkQ0XHU1NkRFXHU3RUQzXHU2Nzg0XHU1MzE2XHU5NTE5XHU4QkVGXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gaG9zdENhbGw8VD4oZXZlbnQ6IEVsZWN0cm9uLklwY01haW5JbnZva2VFdmVudCwgZm46IChjOiBEZXNrdG9wSG9zdENsaWVudCkgPT4gUHJvbWlzZTxUPik6IFByb21pc2U8VCB8IHsgZXJyb3I6IHN0cmluZzsgY29kZTogc3RyaW5nIH0+IHtcclxuICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9KTtcclxuICAgIGlmIChjbGllbnQgPT09IG51bGwgfHwgYnJpZGdlLmhvc3RTdGF0ZSAhPT0gJ3JlYWR5Jykge1xyXG4gICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6IGBob3N0IG5vdCByZWFkeSAoJHticmlkZ2UuaG9zdFN0YXRlfSlgLCBjb2RlOiAnSE9TVF9OT1RfUkVBRFknIH0pO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGZuKGNsaWVudCkuY2F0Y2goKGVycjogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBkZXRhaWwgPSAoKCkgPT4geyB0cnkgeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkoZXJyKTsgfSBjYXRjaCB7IHJldHVybiBTdHJpbmcoZXJyKTsgfSB9KSgpLnNsaWNlKDAsIDMwMCk7XHJcbiAgICAgIHJldHVybiB7IGVycm9yOiBkZXRhaWwsIGNvZGU6ICdCUklER0VfRVJST1InIH07XHJcbiAgICB9KTtcclxuICB9XHJcblxyXG4gIGZ1bmN0aW9uIHJlZ2lzdGVySXBjKCk6IHZvaWQge1xyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpnZXQtc3RhdGUnLCAoZXZlbnQpID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJyB9O1xyXG4gICAgICByZXR1cm4geyAuLi5icmlkZ2UsIGRyb3BwZWRGcmFtZXMgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6c2Vzc2lvbnMnLCAoZXZlbnQpID0+XHJcbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPHsgc2Vzc2lvbnM6IEFycmF5PHsgaWQ6IHN0cmluZzsgdGl0bGU6IHN0cmluZzsgdGFzazogc3RyaW5nOyBvdXRjb21lOiBzdHJpbmc7IHR1cm5zOiBudW1iZXI7IHRvb2xVc2VzOiBudW1iZXI7IHRpbWU6IHN0cmluZzsgY3dkOiBzdHJpbmc7IGNyZWF0ZWRBdDogc3RyaW5nOyB1cGRhdGVkQXQ6IHN0cmluZyB9PiB9PignL2FwaS9zZXNzaW9ucz9saW1pdD0xMDAnKSkpO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6c2VuZC10YXNrJywgKGV2ZW50LCB0ZXh0OiB1bmtub3duLCBzZXNzaW9uSWQ6IHVua25vd24sIG1vZGU6IHVua25vd24sIGF0dGFjaG1lbnRzOiB1bmtub3duLCBpbWFnZXM6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3QgdGFzayA9IHR5cGVvZiB0ZXh0ID09PSAnc3RyaW5nJyA/IHRleHQuc2xpY2UoMCwgMjBfMDAwKSA6ICcnO1xyXG4gICAgICBjb25zdCBzaWQgPSB0eXBlb2Ygc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IHNlc3Npb25JZC5zbGljZSgwLCA4MCkgOiAnJztcclxuICAgICAgY29uc3QgbSA9IG1vZGUgPT09ICdhdXRvJyB8fCBtb2RlID09PSAneW9sbycgPyBtb2RlIDogJ2Fzayc7XHJcbiAgICAgIC8vIFx1OTY0NFx1NEVGNjpcdTU0MEVcdTdBRUZcdTYzODhcdTY3NDMgRFRPIFx1NzY4NFx1N0VERFx1NUJGOVx1OERFRlx1NUY4NChAIFx1OTAwOVx1NjJFOVx1NTY2OC9cdUQ4M0RcdURDQ0UgXHU0RTBBXHU0RjIwXHU1M0VBXHU2NzY1XHU4MUVBXHU2NzJDXHU1NzMwXHU2NTg3XHU0RUY2XHU3Q0ZCXHU3RURGKVxyXG4gICAgICBjb25zdCBhdHRzID0gQXJyYXkuaXNBcnJheShhdHRhY2htZW50cykgPyBhdHRhY2htZW50cy5maWx0ZXIoKGEpOiBhIGlzIHN0cmluZyA9PiB0eXBlb2YgYSA9PT0gJ3N0cmluZycpLnNsaWNlKDAsIDEwKSA6IFtdO1xyXG4gICAgICAvLyBcdTU2RkVcdTcyNDc6cnVudGltZSB2aXNpb24gXHU5NEZFXHU1MzRGXHU4QkFFIHtuYW1lLCBkYXRhVXJsfSBiYXNlNjQoXHUyMjY0MyBcdTVGMjAgXHUyMjY0Nk1CLHJlbmRlcmVyIFx1NzUxRlx1NjIxMClcclxuICAgICAgY29uc3QgaW1ncyA9IEFycmF5LmlzQXJyYXkoaW1hZ2VzKVxyXG4gICAgICAgID8gaW1hZ2VzXHJcbiAgICAgICAgICAgIC5maWx0ZXIoKGltKTogaW0gaXMgeyBuYW1lOiBzdHJpbmc7IGRhdGFVcmw6IHN0cmluZyB9ID0+XHJcbiAgICAgICAgICAgICAgdHlwZW9mIGltID09PSAnb2JqZWN0JyAmJiBpbSAhPT0gbnVsbCAmJiB0eXBlb2YgKGltIGFzIHsgbmFtZT86IHVua25vd24gfSkubmFtZSA9PT0gJ3N0cmluZycgJiYgdHlwZW9mIChpbSBhcyB7IGRhdGFVcmw/OiB1bmtub3duIH0pLmRhdGFVcmwgPT09ICdzdHJpbmcnKVxyXG4gICAgICAgICAgICAuc2xpY2UoMCwgMylcclxuICAgICAgICAgICAgLm1hcCgoaW0pID0+ICh7IG5hbWU6IGltLm5hbWUuc2xpY2UoMCwgMTIwKSwgZGF0YVVybDogaW0uZGF0YVVybC5zbGljZSgwLCA4XzUwMF8wMDApIH0pKVxyXG4gICAgICAgIDogW107XHJcbiAgICAgIGlmICh0YXNrID09PSAnJyB8fCBzaWQgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgb2s6IGZhbHNlLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW47IHJ1bklkPzogc3RyaW5nIH0+KCcvYXBpL3Rhc2snLCB7IHRleHQ6IHRhc2ssIHNlc3Npb25JZDogc2lkLCBtb2RlOiBtLCBhdHRhY2htZW50czogYXR0cywgaW1hZ2VzOiBpbWdzIH0pKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gXHU2QTIxXHU1NzhCXHU1MjA3XHU2MzYyKHJ1bnRpbWUgUE9TVCAvYXBpL21vZGVsOlx1NTIwNyBjaGF0IFx1OERFRlx1NzUzMSxjb25maWcgXHU1MzczXHU2NUY2XHU3NTFGXHU2NTQ4KSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOm1vZGVsLXNldCcsIChldmVudCwgbmFtZTogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBuID0gdHlwZW9mIG5hbWUgPT09ICdzdHJpbmcnID8gbmFtZS50cmltKCkuc2xpY2UoMCwgODApIDogJyc7XHJcbiAgICAgIGlmIChuID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAnbmFtZSByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbjsgbW9kZWw/OiBzdHJpbmcgfT4oJy9hcGkvbW9kZWwnLCB7IG5hbWU6IG4gfSkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBcdTVFOTRcdTc1MjhcdTUxODVcdTY2RjRcdTY1QjAoR2l0SHViIFJlbGVhc2VzO1x1ODFFQVx1NzgxNFx1OTZGNlx1NEY5RFx1OEQ1Nlx1NjZGNFx1NjVCMFx1NTY2OCkgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpjaGVjay11cGRhdGUnLCBhc3luYyAoZXZlbnQpID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgcmV0dXJuIGNoZWNrRm9yVXBkYXRlcygpO1xyXG4gICAgfSk7XHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmFwcGx5LXVwZGF0ZScsIChldmVudCkgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBpZiAoaW5zdGFsbGVyUGF0aCA9PT0gbnVsbCkgcmV0dXJuIHsgZXJyb3I6ICdubyBpbnN0YWxsZXIgZG93bmxvYWRlZCcsIGNvZGU6ICdIT1NUX05PVF9SRUFEWScgfTtcclxuICAgICAgYXBwbHlVcGRhdGUoKTtcclxuICAgICAgcmV0dXJuIHsgb2s6IHRydWUgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gXHU2ODA3XHU5ODk4XHU2ODBGXHU0RTNCXHU5ODk4XHU1NDBDXHU2QjY1KFx1NkQ0NVx1ODI3Mlx1NkEyMVx1NUYwRlx1NEUwRFx1NTE4RFx1NjcwOVx1OUVEMVx1Njc2MSkrIFx1MjYzMCBcdTRFM0JcdTgzRENcdTUzNTUgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpjaHJvbWUtdGhlbWUnLCAoZXZlbnQsIGRhcms6IHVua25vd24pID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgYXBwbHlDaHJvbWUoZGFyayA9PT0gdHJ1ZSk7XHJcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlIH07XHJcbiAgICB9KTtcclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cG9wdXAtbWFpbi1tZW51JywgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIHBvcHVwTWFpbk1lbnUoKTtcclxuICAgICAgcmV0dXJuIHsgb2s6IHRydWUgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gXHU2MjRCXHU2NzNBXHU4RkRDXHU3QTBCXHU2M0E3XHU1MjM2KDc3ODggd2ViIFx1NUI4OFx1NjJBNDtcdTc1MjhcdTYyMzdcdTY2M0VcdTVGMEZcdTU0MkZcdTUyQTgsQURSLTAwNSBcdTRFMERcdTlFRDhcdThCQTRcdTVGMDAgTEFOKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnJlbW90ZS13ZWItc3RhdHVzJywgYXN5bmMgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IHAgPSBhd2FpdCBwcm9iZVdlYlJlbW90ZSgpO1xyXG4gICAgICByZXR1cm4geyB1cDogcC51cCwgdmVyc2lvbjogcC52ZXJzaW9uLCBsYW5JcDogbGFuSXBPZigpLCBwb3J0OiBXRUJfUE9SVCwgYXZhaWxhYmxlOiBjbGlFbnRyeU9mKCkgIT09ICcnLCBhdXRvc3RhcnQ6IHdlYkF1dG9zdGFydEluc3RhbGxlZCgpIH07XHJcbiAgICB9KTtcclxuICAgIC8vIC0tLS0gXHU1RjAwXHU2NzNBXHU4MUVBXHU1NDJGKDAuMjMuMzcgd2ViIGluc3RhbGwtZGFlbW9uL3VuaW5zdGFsbC1kYWVtb247XHU3NjdCXHU1RjU1XHU1MzczXHU1Qjg4XHU2MkE0XHU1NzI4XHU3RUJGKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnJlbW90ZS13ZWItYXV0b3N0YXJ0JywgYXN5bmMgKGV2ZW50LCBlbmFibGVkOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGlmIChjbGlFbnRyeU9mKCkgPT09ICcnKSByZXR1cm4geyBlcnJvcjogJ25vIGhtaGFybmVzcyBydW50aW1lIGRldGVjdGVkJywgY29kZTogJ0hPU1RfTk9UX1JFQURZJyB9O1xyXG4gICAgICBydW5DbGkoWyd3ZWInLCBlbmFibGVkID09PSB0cnVlID8gJ2luc3RhbGwtZGFlbW9uJyA6ICd1bmluc3RhbGwtZGFlbW9uJ10pO1xyXG4gICAgICAvLyBpbnN0YWxsLWRhZW1vbiBcdTdBQ0JcdTUzNzNcdTYyQzlcdThENzdcdTVCODhcdTYyQTQ6XHU4RjZFXHU4QkUyXHU3ODZFXHU4QkE0O3VuaW5zdGFsbCBcdTUzNzNcdTY1RjZcdTc1MUZcdTY1NDhcclxuICAgICAgaWYgKGVuYWJsZWQgPT09IHRydWUpIHtcclxuICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IDUwOyBpKyspIHtcclxuICAgICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDUwMCkpO1xyXG4gICAgICAgICAgaWYgKChhd2FpdCBwcm9iZVdlYlJlbW90ZSgpKS51cCkgcmV0dXJuIHsgb2s6IHRydWUsIGF1dG9zdGFydDogd2ViQXV0b3N0YXJ0SW5zdGFsbGVkKCkgfTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHsgZXJyb3I6ICdkYWVtb24gZGlkIG5vdCBjb21lIHVwIHdpdGhpbiAyNXMnLCBjb2RlOiAnUlVOVElNRV9DUkFTSEVEJyB9O1xyXG4gICAgICB9XHJcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBhdXRvc3RhcnQ6IHdlYkF1dG9zdGFydEluc3RhbGxlZCgpIH07XHJcbiAgICB9KTtcclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cmVtb3RlLXdlYi1zdGFydCcsIGFzeW5jIChldmVudCkgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBpZiAoY2xpRW50cnlPZigpID09PSAnJykgcmV0dXJuIHsgZXJyb3I6ICdubyBobWhhcm5lc3MgcnVudGltZSBkZXRlY3RlZCcsIGNvZGU6ICdIT1NUX05PVF9SRUFEWScgfTtcclxuICAgICAgaWYgKChhd2FpdCBwcm9iZVdlYlJlbW90ZSgpKS51cCkge1xyXG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBhbHJlYWR5OiB0cnVlLCBsYW5Vcmw6IGBodHRwOi8vJHtsYW5JcE9mKCkgfHwgJzEyNy4wLjAuMSd9OiR7V0VCX1BPUlR9YCB9O1xyXG4gICAgICB9XHJcbiAgICAgIHJ1bkNsaShbJ3dlYicsICdzdGFydCcsICctLWV4cG9zdXJlPWxhbiddKTtcclxuICAgICAgLy8gXHU1Qjg4XHU2MkE0XHU4RkRCXHU3QTBCXHU1MUI3XHU1NDJGXHU1MkE4KHRzeCBcdTdGMTZcdThCRDFcdTY1NzRcdTU5NTcgQ0xJKTpcdThGNkVcdThCRTIgMjVzXHJcbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgNTA7IGkrKykge1xyXG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDUwMCkpO1xyXG4gICAgICAgIGlmICgoYXdhaXQgcHJvYmVXZWJSZW1vdGUoKSkudXApIHtcclxuICAgICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBsYW5Vcmw6IGBodHRwOi8vJHtsYW5JcE9mKCkgfHwgJzEyNy4wLjAuMSd9OiR7V0VCX1BPUlR9YCB9O1xyXG4gICAgICAgIH1cclxuICAgICAgfVxyXG4gICAgICByZXR1cm4geyBlcnJvcjogJ3dlYiBkYWVtb24gZGlkIG5vdCBjb21lIHVwIHdpdGhpbiAyNXMgKHNlZSBITUhfSE9NRS93ZWIubG9nKScsIGNvZGU6ICdSVU5USU1FX0NSQVNIRUQnIH07XHJcbiAgICB9KTtcclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cmVtb3RlLXdlYi1zdG9wJywgYXN5bmMgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIHJ1bkNsaShbJ3dlYicsICdzdG9wJ10pO1xyXG4gICAgICBmb3IgKGxldCBpID0gMDsgaSA8IDIwOyBpKyspIHtcclxuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCA0MDApKTtcclxuICAgICAgICBpZiAoIShhd2FpdCBwcm9iZVdlYlJlbW90ZSgpKS51cCkgcmV0dXJuIHsgb2s6IHRydWUgfTtcclxuICAgICAgfVxyXG4gICAgICBjb25zdCBzdGlsbCA9IChhd2FpdCBwcm9iZVdlYlJlbW90ZSgpKS51cDtcclxuICAgICAgcmV0dXJuIHN0aWxsID8geyBlcnJvcjogJ3N0aWxsIHJ1bm5pbmcnLCBjb2RlOiAnQlJJREdFX0VSUk9SJyB9IDogeyBvazogdHJ1ZSB9O1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBcdUQ4M0RcdURDQ0UgXHU2NTg3XHU0RUY2XHU0RTBBXHU0RjIwKFx1NjcyQ1x1NTczMFx1NTkxQVx1OTAwOTtydW50aW1lIFx1NjgyMVx1OUE4QyBpbnNpZGVXcyxcdTVERTVcdTRGNUNcdTUzM0FcdTU5MTZcdTY1ODdcdTRFRjZcdTRGMUFcdTg4QUIgNDAwKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnBpY2stZmlsZXMnLCBhc3luYyAoZXZlbnQsIHRpdGxlOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IHdpbiA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmZpbmQoKHcpID0+ICF3LmlzRGVzdHJveWVkKCkpO1xyXG4gICAgICBpZiAod2luID09PSB1bmRlZmluZWQpIHJldHVybiB7IGVycm9yOiAnbm8gd2luZG93JywgY29kZTogJ0JSSURHRV9FUlJPUicgfTtcclxuICAgICAgY29uc3QgciA9IGF3YWl0IGRpYWxvZy5zaG93T3BlbkRpYWxvZyh3aW4sIHtcclxuICAgICAgICB0aXRsZTogdHlwZW9mIHRpdGxlID09PSAnc3RyaW5nJyAmJiB0aXRsZSAhPT0gJycgPyB0aXRsZS5zbGljZSgwLCAxMjApIDogJ1x1OTAwOVx1NjJFOVx1ODk4MVx1OTY0NFx1NTJBMFx1NzY4NFx1NjU4N1x1NEVGNihcdTUzRUZcdTU5MUFcdTkwMDkpJyxcclxuICAgICAgICBwcm9wZXJ0aWVzOiBbJ29wZW5GaWxlJywgJ211bHRpU2VsZWN0aW9ucyddLFxyXG4gICAgICB9KTtcclxuICAgICAgaWYgKHIuY2FuY2VsZWQgfHwgci5maWxlUGF0aHMubGVuZ3RoID09PSAwKSByZXR1cm4geyBvazogZmFsc2UsIGNhbmNlbGVkOiB0cnVlIH07XHJcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBwYXRoczogci5maWxlUGF0aHMuc2xpY2UoMCwgMTApIH07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIFx1RDgzRFx1RENDMSBcdTc2RUVcdTVGNTVcdTkwMDlcdTYyRTkoXHU1REU1XHU0RjVDXHU1MzNBXHU2REZCXHU1MkEwXHU3Njg0XHU2RDRGXHU4OUM4XHU2MzA5XHU5NEFFO1x1NTM5Rlx1NzUxRiBjaG9vc2VyKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnBpY2stZGlyZWN0b3J5JywgYXN5bmMgKGV2ZW50LCB0aXRsZTogdW5rbm93bikgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBjb25zdCB3aW4gPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5maW5kKCh3KSA9PiAhdy5pc0Rlc3Ryb3llZCgpKTtcclxuICAgICAgaWYgKHdpbiA9PT0gdW5kZWZpbmVkKSByZXR1cm4geyBlcnJvcjogJ25vIHdpbmRvdycsIGNvZGU6ICdCUklER0VfRVJST1InIH07XHJcbiAgICAgIGNvbnN0IHIgPSBhd2FpdCBkaWFsb2cuc2hvd09wZW5EaWFsb2cod2luLCB7XHJcbiAgICAgICAgdGl0bGU6IHR5cGVvZiB0aXRsZSA9PT0gJ3N0cmluZycgJiYgdGl0bGUgIT09ICcnID8gdGl0bGUuc2xpY2UoMCwgMTIwKSA6ICdcdTkwMDlcdTYyRTlcdTY1ODdcdTRFRjZcdTU5MzknLFxyXG4gICAgICAgIHByb3BlcnRpZXM6IFsnb3BlbkRpcmVjdG9yeSddLFxyXG4gICAgICB9KTtcclxuICAgICAgaWYgKHIuY2FuY2VsZWQgfHwgci5maWxlUGF0aHNbMF0gPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBjYW5jZWxlZDogdHJ1ZSB9O1xyXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgcGF0aDogci5maWxlUGF0aHNbMF0gfTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gQCBcdTk2NDRcdTRFRjY6XHU1REU1XHU0RjVDXHU1MzNBXHU2NTg3XHU0RUY2XHU2NDFDXHU3RDIyKHJ1bnRpbWUgXHU2Mzg4XHU2NzQzXHU3Njg0XHU4REVGXHU1Rjg0XHU2NzY1XHU2RTkwKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmZzLXNlYXJjaCcsIChldmVudCwgcTogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBxdWVyeSA9IHR5cGVvZiBxID09PSAnc3RyaW5nJyA/IHEuc2xpY2UoMCwgMjAwKSA6ICcnO1xyXG4gICAgICBpZiAocXVlcnkgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgcmVzdWx0czogW10gfSk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjx7IHJlc3VsdHM6IEFycmF5PHsgcmVsOiBzdHJpbmc7IHBhdGg6IHN0cmluZyB9PiB9PihgL2FwaS9mcy9zZWFyY2g/cT0ke2VuY29kZVVSSUNvbXBvbmVudChxdWVyeSl9YCkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTphcHByb3ZlJywgKGV2ZW50LCBncmFudGVkOiB1bmtub3duLCBzZXNzaW9uSWQ6IHVua25vd24pID0+XHJcbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KCcvYXBpL2FwcHJvdmUnLCB7XHJcbiAgICAgICAgZ3JhbnRlZDogZ3JhbnRlZCA9PT0gdHJ1ZSxcclxuICAgICAgICBzZXNzaW9uSWQ6IHR5cGVvZiBzZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gc2Vzc2lvbklkLnNsaWNlKDAsIDgwKSA6ICcnLFxyXG4gICAgICB9KSkpO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6aW50ZXJydXB0JywgKGV2ZW50LCBzZXNzaW9uSWQ6IHVua25vd24pID0+XHJcbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KCcvYXBpL2ludGVycnVwdCcsIHtcclxuICAgICAgICBzZXNzaW9uSWQ6IHR5cGVvZiBzZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gc2Vzc2lvbklkLnNsaWNlKDAsIDgwKSA6ICcnLFxyXG4gICAgICB9KSkpO1xyXG5cclxuICAgIC8vIC0tLS0gTTQ6XHU1REU1XHU0RjVDXHU1MzNBXHU2NTg3XHU0RUY2XHU5NzYyKFx1OERFRlx1NUY4NFx1NjM4OFx1Njc0M1x1NTcyOCBydW50aW1lOmluc2lkZVdzIFx1NjgyMVx1OUE4QykgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpmcy1saXN0JywgKGV2ZW50LCBwYXRoOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IHAgPSB0eXBlb2YgcGF0aCA9PT0gJ3N0cmluZycgPyBwYXRoLnNsaWNlKDAsIDEwMDApIDogJyc7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oYC9hcGkvZnM/ZmlsZXM9MSR7cCAhPT0gJycgPyBgJnBhdGg9JHtlbmNvZGVVUklDb21wb25lbnQocCl9YCA6ICcnfWApKTtcclxuICAgIH0pO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6ZnMtcmVhZCcsIChldmVudCwgcGF0aDogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBwID0gdHlwZW9mIHBhdGggPT09ICdzdHJpbmcnID8gcGF0aC5zbGljZSgwLCAxMDAwKSA6ICcnO1xyXG4gICAgICBpZiAocCA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ3BhdGggcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KGAvYXBpL2ZzL3JlYWQ/cGF0aD0ke2VuY29kZVVSSUNvbXBvbmVudChwKX1gKSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmluamVjdCcsIChldmVudCwgdGV4dDogdW5rbm93biwgc2Vzc2lvbklkOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IHQgPSB0eXBlb2YgdGV4dCA9PT0gJ3N0cmluZycgPyB0ZXh0LnNsaWNlKDAsIDIwXzAwMCkgOiAnJztcclxuICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIHNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBzZXNzaW9uSWQuc2xpY2UoMCwgODApIDogJyc7XHJcbiAgICAgIGlmICh0ID09PSAnJyB8fCBzaWQgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgb2s6IGZhbHNlLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvaW5qZWN0JywgeyB0ZXh0OiB0LCBzZXNzaW9uSWQ6IHNpZCB9KSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIFx1NEYxQVx1OEJERFx1NUJGQ1x1NTFGQShleHBvcnQubWQgXHUyMTkyIFx1NEZERFx1NUI1OFx1NUJGOVx1OEJERFx1Njg0NjtcdTY1ODdcdTRFRjZcdTUxOTlcdTUxNjVcdTUzRUFcdTU3MjggbWFpbikgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpleHBvcnQtc2Vzc2lvbicsIGFzeW5jIChldmVudCwgaWQ6IHVua25vd24sIHRpdGxlOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IHNpZCA9IHR5cGVvZiBpZCA9PT0gJ3N0cmluZycgPyBpZC5yZXBsYWNlKC9bXmEtekEtWjAtOV86LkAtXS9nLCAnJykuc2xpY2UoMCwgODApIDogJyc7XHJcbiAgICAgIGlmIChzaWQgPT09ICcnKSByZXR1cm4geyBlcnJvcjogJ2lkIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9O1xyXG4gICAgICBpZiAoY2xpZW50ID09PSBudWxsIHx8IGJyaWRnZS5ob3N0U3RhdGUgIT09ICdyZWFkeScpIHJldHVybiB7IGVycm9yOiBgaG9zdCBub3QgcmVhZHkgKCR7YnJpZGdlLmhvc3RTdGF0ZX0pYCwgY29kZTogJ0hPU1RfTk9UX1JFQURZJyB9O1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IG1kID0gYXdhaXQgY2xpZW50LmdldFRleHQoYC9hcGkvc2Vzc2lvbnMvJHtlbmNvZGVVUklDb21wb25lbnQoc2lkKX0vZXhwb3J0Lm1kYCk7XHJcbiAgICAgICAgY29uc3Qgd2luID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkuZmluZCgodykgPT4gIXcuaXNEZXN0cm95ZWQoKSk7XHJcbiAgICAgICAgaWYgKHdpbiA9PT0gdW5kZWZpbmVkKSByZXR1cm4geyBlcnJvcjogJ25vIHdpbmRvdycsIGNvZGU6ICdCUklER0VfRVJST1InIH07XHJcbiAgICAgICAgY29uc3QgciA9IGF3YWl0IGRpYWxvZy5zaG93U2F2ZURpYWxvZyh3aW4sIHtcclxuICAgICAgICAgIHRpdGxlOiB0eXBlb2YgdGl0bGUgPT09ICdzdHJpbmcnICYmIHRpdGxlICE9PSAnJyA/IHRpdGxlLnNsaWNlKDAsIDgwKSA6ICdcdTVCRkNcdTUxRkFcdTRGMUFcdThCREQnLFxyXG4gICAgICAgICAgZGVmYXVsdFBhdGg6IGBobWgtJHtzaWR9Lm1kYCxcclxuICAgICAgICAgIGZpbHRlcnM6IFt7IG5hbWU6ICdNYXJrZG93bicsIGV4dGVuc2lvbnM6IFsnbWQnXSB9XSxcclxuICAgICAgICB9KTtcclxuICAgICAgICBpZiAoci5jYW5jZWxlZCB8fCByLmZpbGVQYXRoID09PSB1bmRlZmluZWQgfHwgci5maWxlUGF0aCA9PT0gJycpIHJldHVybiB7IG9rOiBmYWxzZSwgY2FuY2VsZWQ6IHRydWUgfTtcclxuICAgICAgICBhd2FpdCB3cml0ZUZpbGUoci5maWxlUGF0aCwgbWQsICd1dGY4Jyk7XHJcbiAgICAgICAgbG9nSW5mbygnZXhwb3J0JywgYHNlc3Npb24gJHtzaWR9IFx1MjE5MiAke3IuZmlsZVBhdGh9YCk7XHJcbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHBhdGg6IHIuZmlsZVBhdGggfTtcclxuICAgICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgY29uc3QgZGV0YWlsID0gKCgpID0+IHsgdHJ5IHsgcmV0dXJuIEpTT04uc3RyaW5naWZ5KGVycik7IH0gY2F0Y2ggeyByZXR1cm4gU3RyaW5nKGVycik7IH0gfSkoKS5zbGljZSgwLCAzMDApO1xyXG4gICAgICAgIHJldHVybiB7IGVycm9yOiBkZXRhaWwsIGNvZGU6ICdCUklER0VfRVJST1InIH07XHJcbiAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gXHU1QkExXHU2Mjc5XHU2QTIxXHU1RjBGXHU4QkZCXHU1MTk5KFx1Njc0M1x1NUEwMVx1NTcyOCBydW50aW1lIGNvbmZpZztcdTUyMDdcdTYzNjJcdTVGQzVcdTk4N0JcdTY2M0VcdTVGMEYpIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6YXBwcm92YWwtZ2V0JywgKGV2ZW50KSA9PlxyXG4gICAgICBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjx7IHNldHRpbmdzPzogeyBhcHByb3ZhbD86IHN0cmluZyB9IH0+KCcvYXBpL3N0YXRlJykpKTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmFwcHJvdmFsLXNldCcsIChldmVudCwgbW9kZTogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBtID0gbW9kZSA9PT0gJ2F1dG8nID8gJ2F1dG8nIDogbW9kZSA9PT0gJ2FzaycgPyAnYXNrJyA6ICcnO1xyXG4gICAgICBpZiAobSA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ21vZGUgbXVzdCBiZSBhc2t8YXV0bycsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PignL2FwaS9jb25maWcnLCB7IGFwcHJvdmFsOiBtIH0pKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gaG1oYXJuZXNzIHJ1bnRpbWUgXHU4RkRFXHU2M0E1KFx1ODFFQVx1NTJBOFx1NTNEMVx1NzNCMCArIFx1NjI0Qlx1NTJBOFx1ODk4Nlx1NzZENiArIFx1NzBFRFx1NTIwN1x1NjM2MikgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpydW50aW1lLWluZm8nLCBhc3luYyAoZXZlbnQpID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgY29uc3QgZCA9IGRldGVjdEV4dGVybmFsUnVudGltZSgpO1xyXG4gICAgICBjb25zdCBjZmcgPSBhd2FpdCBsb2FkUnVudGltZUNvbmZpZygpO1xyXG4gICAgICByZXR1cm4ge1xyXG4gICAgICAgIG1vZGU6IGJyaWRnZS5tb2RlLFxyXG4gICAgICAgIHJ1bnRpbWVFbnRyeTogYnJpZGdlLnJ1bnRpbWVFbnRyeSxcclxuICAgICAgICBvdmVycmlkZTogY2ZnLmVudHJ5LFxyXG4gICAgICAgIGRlbW86IGNmZy5kZW1vLFxyXG4gICAgICAgIGRldGVjdGVkOiBkLmVudHJ5LFxyXG4gICAgICAgIGRldGVjdGVkVmVyc2lvbjogZC52ZXJzaW9uLFxyXG4gICAgICAgIGRldGVjdGVkU291cmNlOiBkLnNvdXJjZSxcclxuICAgICAgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6YnJvd3NlLXJ1bnRpbWUnLCBhc3luYyAoZXZlbnQsIHRpdGxlOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IHdpbiA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmZpbmQoKHcpID0+ICF3LmlzRGVzdHJveWVkKCkpO1xyXG4gICAgICBpZiAod2luID09PSB1bmRlZmluZWQpIHJldHVybiB7IGVycm9yOiAnbm8gd2luZG93JywgY29kZTogJ0JSSURHRV9FUlJPUicgfTtcclxuICAgICAgY29uc3QgciA9IGF3YWl0IGRpYWxvZy5zaG93T3BlbkRpYWxvZyh3aW4sIHtcclxuICAgICAgICB0aXRsZTogdHlwZW9mIHRpdGxlID09PSAnc3RyaW5nJyAmJiB0aXRsZSAhPT0gJycgPyB0aXRsZS5zbGljZSgwLCAxMjApIDogJ1x1OTAwOVx1NjJFOSBobWhhcm5lc3MgXHU3Njg0IGRlc2t0b3AtaG9zdCBcdTUxNjVcdTUzRTMnLFxyXG4gICAgICAgIHByb3BlcnRpZXM6IFsnb3BlbkZpbGUnXSxcclxuICAgICAgICBmaWx0ZXJzOiBbeyBuYW1lOiAnZGVza3RvcC1ob3N0JywgZXh0ZW5zaW9uczogWyd0cycsICdqcyddIH1dLFxyXG4gICAgICB9KTtcclxuICAgICAgaWYgKHIuY2FuY2VsZWQgfHwgci5maWxlUGF0aHNbMF0gPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBjYW5jZWxlZDogdHJ1ZSB9O1xyXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgZW50cnk6IHIuZmlsZVBhdGhzWzBdIH07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiogXHU4QkJFXHU3RjZFL1x1NkUwNVx1OTY2NFx1NjI0Qlx1NTJBOFx1NTE2NVx1NTNFM1x1NTQwRVx1NzBFRFx1OTFDRFx1NTQyRiBob3N0KFx1N0E3QVx1NEUzMj1cdTU2REVcdTUyMzBcdTgxRUFcdTUyQThcdTUzRDFcdTczQjApXHUzMDAyICovXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnNldC1ydW50aW1lJywgYXN5bmMgKGV2ZW50LCBlbnRyeTogdW5rbm93bikgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBjb25zdCBlID0gdHlwZW9mIGVudHJ5ID09PSAnc3RyaW5nJyA/IGVudHJ5LnRyaW0oKSA6ICcnO1xyXG4gICAgICBpZiAoZSAhPT0gJycgJiYgKCFpc0Fic29sdXRlKGUpIHx8ICFleGlzdHNTeW5jKGUpKSkge1xyXG4gICAgICAgIHJldHVybiB7IGVycm9yOiAnXHU1MTY1XHU1M0UzXHU1RkM1XHU5ODdCXHU2NjJGXHU1QjU4XHU1NzI4XHU3Njg0XHU3RUREXHU1QkY5XHU4REVGXHU1Rjg0KGRlc2t0b3AtaG9zdC50cyknLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH07XHJcbiAgICAgIH1cclxuICAgICAgYXdhaXQgc2F2ZVJ1bnRpbWVFbnRyeU92ZXJyaWRlKGUpO1xyXG4gICAgICAvLyBcdTcwRURcdTUyMDdcdTYzNjI6XHU1MTQ4XHU0RjE4XHU5NkM1XHU1MDVDXHU2Mzg5XHU1RjUzXHU1MjREIGhvc3QsXHU1MThEXHU2MzA5XHU2NUIwXHU5MTREXHU3RjZFXHU2MkM5XHU4RDc3XHJcbiAgICAgIHNzZUFib3J0Py5hYm9ydCgpO1xyXG4gICAgICBpZiAoc3VwZXJ2aXNvciAhPT0gbnVsbCkgYXdhaXQgc3VwZXJ2aXNvci5zdG9wKCk7XHJcbiAgICAgIGF3YWl0IHN0YXJ0SG9zdCgpO1xyXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgbW9kZTogYnJpZGdlLm1vZGUgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gdjUuMSBcdTk5OTZcdTU0MkZcdTVCODlcdTg4QzVcdTU0MTFcdTVCRkM6XHU2NzJDXHU2NzNBXHU2OEMwXHU2RDRCIC8gXHU0RTBCXHU4RjdEXHU1Qjg5XHU4OEM1KFx1OEZEQlx1NUVBNlx1NEU4Qlx1NEVGNikgLyBcdTU0MTFcdTVCRkNcdTcyQjZcdTYwMDEgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpkZXRlY3QtcnVudGltZScsIChldmVudCkgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBjb25zdCBpbmZvID0gYnVuZGxlZFJ1bnRpbWVJbmZvKCk7XHJcbiAgICAgIC8vIFVJVkVSSUZZIFx1NTQxMVx1NUJGQ1x1NkI2NVx1NzY4NFwiXHU0RjJBXHU5MDIwXHU2NzJBXHU5MTREXHU3RjZFXHU2MDAxXCI6ZmFrZSBcdTZBMjFcdTVGMEZcdTRFMEJcdTYwNTJcdTYyQTVcdTY3MkFcdTY4QzBcdTZENEJcclxuICAgICAgLy8gKFx1NzcxRlx1NUI5RVx1NjhDMFx1NkQ0Qlx1OERFRlx1NUY4NFx1NzUzMSByZWFsIFx1NTNEOFx1NEY1M1x1OUE4Q1x1NjUzNixcdTg5QzEgZXZpZGVuY2Uvc2V0dXAtd2l6YXJkLylcclxuICAgICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX1dJWkFSRCA9PT0gJ2Zha2UnICYmIHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX0ZBS0UgPT09ICcxJykge1xyXG4gICAgICAgIHJldHVybiB7IGZvdW5kOiBmYWxzZSwgdmVyc2lvbjogJycsIGVudHJ5OiAnJywgc291cmNlOiAnJywgYnVuZGxlZDogaW5mbywgbnBtOiBucG1PblBhdGgoKSB9O1xyXG4gICAgICB9XHJcbiAgICAgIGNvbnN0IGQgPSBkZXRlY3RFeHRlcm5hbFJ1bnRpbWUoKTtcclxuICAgICAgcmV0dXJuIHsgZm91bmQ6IGQuZW50cnkgIT09ICcnLCB2ZXJzaW9uOiBkLnZlcnNpb24sIGVudHJ5OiBkLmVudHJ5LCBzb3VyY2U6IGQuc291cmNlLCBidW5kbGVkOiBpbmZvLCBucG06IG5wbU9uUGF0aCgpIH07XHJcbiAgICB9KTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmluc3RhbGwtY2xpJywgKGV2ZW50LCBvcHRzOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IG8gPSAob3B0cyA/PyB7fSkgYXMgeyBmb3JjZVRnej86IHVua25vd247IG1pcnJvckZpcnN0PzogdW5rbm93biB9O1xyXG4gICAgICByZXR1cm4gc3RhcnRDbGlJbnN0YWxsKFxyXG4gICAgICAgIHtcclxuICAgICAgICAgIHNlbmRQcm9ncmVzczogKHA6IEluc3RhbGxQcm9ncmVzcyk6IHZvaWQgPT4ge1xyXG4gICAgICAgICAgICBsb2dJbmZvKCdpbnN0YWxsJywgYCR7cC5waGFzZX0ke3AucGN0ICE9PSB1bmRlZmluZWQgPyBgICR7cC5wY3R9JWAgOiAnJ30gJHtwLnRleHR9YCk7XHJcbiAgICAgICAgICAgIGZvciAoY29uc3QgdyBvZiBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKSkge1xyXG4gICAgICAgICAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ2luc3RhbGw6cHJvZ3Jlc3MnLCBwKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgfSxcclxuICAgICAgICAgIGxvZzogKG06IHN0cmluZyk6IHZvaWQgPT4geyBsb2dJbmZvKCdpbnN0YWxsJywgbSk7IH0sXHJcbiAgICAgICAgICAvLyBcdTVCODlcdTg4QzVcdTYyMTBcdTUyOUZcdTUzNzNcdTYzMDFcdTRFNDVcdTUzMTZcdTVFNzZcdTcwRURcdTUyMDdcdTYzNjIoXHU1NDExXHU1QkZDXHU5NjhGXHU1NDBFXHU2NTM2XHU1QzNFO1x1NEUyRFx1OTAxNFx1NTNENlx1NkQ4OFx1NEU1Rlx1NURGMlx1NzUxRlx1NjU0OClcclxuICAgICAgICAgIG9uSW5zdGFsbGVkOiAoZW50cnk6IHN0cmluZyk6IHZvaWQgPT4ge1xyXG4gICAgICAgICAgICB2b2lkIChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgICAgICAgYXdhaXQgc2F2ZVJ1bnRpbWVDb25maWcoeyBlbnRyeSwgZGVtbzogZmFsc2UgfSk7XHJcbiAgICAgICAgICAgICAgc3NlQWJvcnQ/LmFib3J0KCk7XHJcbiAgICAgICAgICAgICAgaWYgKHN1cGVydmlzb3IgIT09IG51bGwpIGF3YWl0IHN1cGVydmlzb3Iuc3RvcCgpO1xyXG4gICAgICAgICAgICAgIGF3YWl0IHN0YXJ0SG9zdCgpO1xyXG4gICAgICAgICAgICB9KSgpO1xyXG4gICAgICAgICAgfSxcclxuICAgICAgICB9LFxyXG4gICAgICAgIHtcclxuICAgICAgICAgIGZvcmNlVGd6OiBvLmZvcmNlVGd6ID09PSB0cnVlLFxyXG4gICAgICAgICAgbWlycm9yRmlyc3Q6IG8ubWlycm9yRmlyc3QgPT09ICducG1taXJyb3InID8gJ25wbW1pcnJvcicgOiBvLm1pcnJvckZpcnN0ID09PSAnbnBtanMnID8gJ25wbWpzJyA6IHVuZGVmaW5lZCxcclxuICAgICAgICB9LFxyXG4gICAgICApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpnZXQtd2l6YXJkJywgYXN5bmMgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IHZhcmlhbnQgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9XSVpBUkQ7XHJcbiAgICAgIGlmICh2YXJpYW50ICE9PSB1bmRlZmluZWQgJiYgdmFyaWFudCAhPT0gJycpIHtcclxuICAgICAgICAvLyBcdTlBOENcdTY1MzZcdTY3ODRcdTkwMjA6XHU1RjNBXHU1MjM2XHU1NDExXHU1QkZDXHU1M0VGXHU4OUMxXHU0RTE0XHU4OUM2XHU0RTNBXHU2NzJBXHU5MTREXHU3RjZFKFx1NTNFRlx1OTFDRFx1NTkwRFx1OEREMSk7cGVyc2lzdGVkPVx1NzcxRlx1NUI5RVx1ODQzRFx1NzZEOFxyXG4gICAgICAgIC8vIFx1NzJCNlx1NjAwMShcdTU0MTFcdTVCRkNcdTZCNjVcdTY1QURcdThBMDBcIlx1OTAwOVx1NjJFOVx1NjMwMVx1NEU0NVwiXHU3NTI4LFx1NEUwRFx1NUY3MVx1NTRDRCBVSSBcdTUyMjRcdTVCOUEpXHJcbiAgICAgICAgY29uc3QgdyA9IGF3YWl0IGxvYWRXaXphcmRTdGF0ZSgpO1xyXG4gICAgICAgIHJldHVybiB7IGRvbmU6IGZhbHNlLCBjaG9pY2U6ICcnLCBzdXBwcmVzc2VkOiBmYWxzZSwgcGVyc2lzdGVkOiB7IGRvbmU6IHcuZG9uZSwgY2hvaWNlOiB3LmNob2ljZSB9IH07XHJcbiAgICAgIH1cclxuICAgICAgY29uc3QgdyA9IGF3YWl0IGxvYWRXaXphcmRTdGF0ZSgpO1xyXG4gICAgICBjb25zdCBjZmcgPSBhd2FpdCBsb2FkUnVudGltZUNvbmZpZygpO1xyXG4gICAgICAvLyBcdTVERjJcdTkxNERcdTdGNkVcdThGQzcgcnVudGltZShcdTYyNEJcdTUyQThcdTUxNjVcdTUzRTMvXHU1NDExXHU1QkZDXHU5MDA5XHU2MkU5L1x1NkYxNFx1NzkzQSlcdTg5QzZcdTU0MENcdTVERjJcdTVCOENcdTYyMTBcdTk5OTZcdTU0MkZcclxuICAgICAgcmV0dXJuIHsgZG9uZTogdy5kb25lIHx8IGNmZy5lbnRyeSAhPT0gJycgfHwgY2ZnLmRlbW8sIGNob2ljZTogdy5jaG9pY2UsIHN1cHByZXNzZWQ6IHdpemFyZFN1cHByZXNzZWQoKSB9O1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyoqIFx1NTQxMVx1NUJGQ1x1NjUzNlx1NUMzRTpcdTYzMDFcdTRFNDVcdTUzMTZcdTkwMDlcdTYyRTlcdTVFNzZcdTVFOTRcdTc1MjgoZXh0ZXJuYWwvYnVuZGxlZFx1MjE5Mlx1NTE2NVx1NTNFM1x1ODk4Nlx1NzZENjtkZW1vXHUyMTkyXHU2MzAxXHU0RTQ1XHU2RjE0XHU3OTNBO1xyXG4gICAgICogIGluc3RhbGxcdTIxOTJcdTUxNjVcdTUzRTNcdTVERjJcdTc1MzFcdTVCODlcdTg4QzVcdTU2NjhcdTYzMDFcdTRFNDVcdTUzMTYsXHU1M0VBXHU4QkIwXHU3MkI2XHU2MDAxKVx1MzAwMmZha2UvXHU2RDRCXHU4QkQ1XHU3M0FGXHU1ODgzXHU1M0VBXHU4QkIwXHU3MkI2XHU2MDAxXHUzMDAyICovXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOndpemFyZC1jb21wbGV0ZScsIGFzeW5jIChldmVudCwgY2hvaWNlOiB1bmtub3duLCBlbnRyeTogdW5rbm93bikgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBjb25zdCBjID0gY2hvaWNlID09PSAnZXh0ZXJuYWwnIHx8IGNob2ljZSA9PT0gJ2luc3RhbGwnIHx8IGNob2ljZSA9PT0gJ2J1bmRsZWQnIHx8IGNob2ljZSA9PT0gJ2RlbW8nID8gY2hvaWNlIDogJyc7XHJcbiAgICAgIGlmIChjID09PSAnJykgcmV0dXJuIHsgZXJyb3I6ICdjaG9pY2UgbXVzdCBiZSBleHRlcm5hbHxpbnN0YWxsfGJ1bmRsZWR8ZGVtbycsIGNvZGU6ICdCQURfUkVRVUVTVCcgfTtcclxuICAgICAgY29uc3QgZSA9IHR5cGVvZiBlbnRyeSA9PT0gJ3N0cmluZycgPyBlbnRyeSA6ICcnO1xyXG4gICAgICBhd2FpdCBzYXZlV2l6YXJkU3RhdGUoYyk7XHJcbiAgICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9GQUtFID09PSAnMScpIHJldHVybiB7IG9rOiB0cnVlLCBtb2RlOiBicmlkZ2UubW9kZSwgdGVzdDogdHJ1ZSB9O1xyXG4gICAgICBjb25zdCByZXBvUm9vdCA9IGpvaW4oaGVyZSwgJy4uJywgJy4uJywgJy4uJywgJy4uJyk7XHJcbiAgICAgIGlmIChjID09PSAnZXh0ZXJuYWwnIHx8IGMgPT09ICdidW5kbGVkJykge1xyXG4gICAgICAgIGNvbnN0IHRhcmdldCA9IGMgPT09ICdidW5kbGVkJyA/IGJ1bmRsZWRSdW50aW1lUGF0aChyZXBvUm9vdCkgOiBlO1xyXG4gICAgICAgIGlmICh0YXJnZXQgPT09ICcnIHx8ICFpc0Fic29sdXRlKHRhcmdldCkgfHwgIWV4aXN0c1N5bmModGFyZ2V0KSkge1xyXG4gICAgICAgICAgcmV0dXJuIHsgZXJyb3I6ICdydW50aW1lIFx1NTE2NVx1NTNFM1x1NEUwRFx1NUI1OFx1NTcyOCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfTtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgc2F2ZVJ1bnRpbWVDb25maWcoeyBlbnRyeTogdGFyZ2V0LCBkZW1vOiBmYWxzZSB9KTtcclxuICAgICAgfSBlbHNlIGlmIChjID09PSAnZGVtbycpIHtcclxuICAgICAgICBhd2FpdCBzYXZlUnVudGltZUNvbmZpZyh7IGVudHJ5OiAnJywgZGVtbzogdHJ1ZSB9KTtcclxuICAgICAgfVxyXG4gICAgICBpZiAoYyAhPT0gJ2luc3RhbGwnKSB7XHJcbiAgICAgICAgLy8gaW5zdGFsbDpcdTVCODlcdTg4QzVcdTU2NjhcdTVERjJcdTU3Mjggb25JbnN0YWxsZWQgXHU2MzAxXHU0RTQ1XHU1MzE2XHU1RTc2XHU3MEVEXHU1MjA3XHU2MzYyLFx1OEZEOVx1OTFDQ1x1NEUwRFx1NTE4RFx1OTFDRFx1NTQyRlxyXG4gICAgICAgIHNzZUFib3J0Py5hYm9ydCgpO1xyXG4gICAgICAgIGlmIChzdXBlcnZpc29yICE9PSBudWxsKSBhd2FpdCBzdXBlcnZpc29yLnN0b3AoKTtcclxuICAgICAgICBhd2FpdCBzdGFydEhvc3QoKTtcclxuICAgICAgfVxyXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgbW9kZTogYnJpZGdlLm1vZGUgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gUHJvdmlkZXIgXHU4QkJFXHU3RjZFKDAzIFx1MDBBN1x1NEUwMzprZXkgXHU1M0VBXHU1MUZBIGhhc0tleS9cdTY3MkJcdTU2REJcdTRGNEQ7XHU0RkREXHU1QjU4XHU3NkY0XHU1MTk5IHJ1bnRpbWUpIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cHJvdmlkZXJzJywgKGV2ZW50KSA9PlxyXG4gICAgICBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjx7IHByb3ZpZGVyc0RldGFpbD86IEFycmF5PHsgbmFtZTogc3RyaW5nOyBtb2RlbDogc3RyaW5nOyBiYXNlVXJsOiBzdHJpbmc7IGhhc0tleTogYm9vbGVhbjsga2V5VGFpbD86IHN0cmluZyB9PjsgbW9kZWw/OiBzdHJpbmcgfT4oJy9hcGkvc3RhdGUnKSkpO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cHJvdmlkZXItc2F2ZScsIChldmVudCwgcHJvdmlkZXI6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3QgcCA9IHByb3ZpZGVyIGFzIHsgbmFtZT86IHVua25vd247IGJhc2VVcmw/OiB1bmtub3duOyBtb2RlbD86IHVua25vd247IGFwaUtleT86IHVua25vd24gfTtcclxuICAgICAgY29uc3QgbmFtZSA9IHR5cGVvZiBwPy5uYW1lID09PSAnc3RyaW5nJyA/IHAubmFtZS5zbGljZSgwLCA4MCkgOiAnJztcclxuICAgICAgY29uc3QgYmFzZVVybCA9IHR5cGVvZiBwPy5iYXNlVXJsID09PSAnc3RyaW5nJyA/IHAuYmFzZVVybC5zbGljZSgwLCAzMDApIDogJyc7XHJcbiAgICAgIGNvbnN0IG1vZGVsID0gdHlwZW9mIHA/Lm1vZGVsID09PSAnc3RyaW5nJyA/IHAubW9kZWwuc2xpY2UoMCwgMTIwKSA6ICcnO1xyXG4gICAgICBpZiAobmFtZSA9PT0gJycgfHwgYmFzZVVybCA9PT0gJycgfHwgbW9kZWwgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICduYW1lL2Jhc2VVcmwvbW9kZWwgcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xyXG4gICAgICBjb25zdCBib2R5OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgbmFtZSwgYmFzZVVybCwgbW9kZWwgfTtcclxuICAgICAgLy8gYXBpS2V5IFx1NTNFQVx1NTcyOFx1NjYzRVx1NUYwRlx1OEY5M1x1NTE2NVx1NjVGNlx1NEUwQVx1NEYyMCxcdTdFRERcdTRFMERcdTU2REVcdTY2M0UocmVuZGVyZXIgXHU4ODY4XHU1MzU1XHU2M0QwXHU0RUE0XHU1NDBFXHU1MzczXHU2RTA1XHU3QTdBKVxyXG4gICAgICBpZiAodHlwZW9mIHA/LmFwaUtleSA9PT0gJ3N0cmluZycgJiYgcC5hcGlLZXkgIT09ICcnKSBib2R5LmFwaUtleSA9IHAuYXBpS2V5LnNsaWNlKDAsIDMwMCk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PignL2FwaS9wcm92aWRlcnMnLCBib2R5KSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIFx1NURFNVx1NEY1Q1x1NTMzQSgwMyBcdTAwQTdcdTUxNkQ7XHU1MjA3XHU2MzYyXHU4QkVEXHU0RTQ5XHU0RTBFIHdlYiBcdTc2RjhcdTU0MEM6cnVudGltZSBcdTUzNTVcdTkwMDkgY3dkKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOndvcmtzcGFjZXMnLCAoZXZlbnQpID0+XHJcbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPHsgY3VycmVudDogc3RyaW5nOyBpdGVtczogQXJyYXk8eyBpZDogc3RyaW5nOyBuYW1lOiBzdHJpbmc7IHBhdGg6IHN0cmluZyB9PiB9PignL2FwaS93b3Jrc3BhY2VzJykpKTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOndvcmtzcGFjZS11c2UnLCAoZXZlbnQsIGlkOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IHdpZCA9IHR5cGVvZiBpZCA9PT0gJ3N0cmluZycgPyBpZC5zbGljZSgwLCA2MCkgOiAnJztcclxuICAgICAgaWYgKHdpZCA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ2lkIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcclxuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KCcvYXBpL3dvcmtzcGFjZXMvdXNlJywgeyBpZDogd2lkIH0pKTtcclxuICAgIH0pO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6d29ya3NwYWNlLWFkZCcsIChldmVudCwgbmFtZTogdW5rbm93biwgcGF0aDogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBuID0gdHlwZW9mIG5hbWUgPT09ICdzdHJpbmcnID8gbmFtZS5zbGljZSgwLCAxMjApIDogJyc7XHJcbiAgICAgIGNvbnN0IHAgPSB0eXBlb2YgcGF0aCA9PT0gJ3N0cmluZycgPyBwYXRoLnNsaWNlKDAsIDEwMDApIDogJyc7XHJcbiAgICAgIGlmIChwID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAncGF0aCByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PignL2FwaS93b3Jrc3BhY2VzJywgeyBuYW1lOiBuID09PSAnJyA/IHVuZGVmaW5lZCA6IG4sIHBhdGg6IHAgfSkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBcdTRGMUFcdThCRERcdTVGNTJcdTY4NjMvXHU1MjIwXHU5NjY0KFx1NzlGQlx1NTE2NSBhcmNoaXZlL3RyYXNoLFx1NTNFRlx1NjA2Mlx1NTkwRDtydW50aW1lIFx1Njc0M1x1NUEwMSkgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpzZXNzaW9uLW9wJywgKGV2ZW50LCBpZDogdW5rbm93biwgb3A6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIGlkID09PSAnc3RyaW5nJyA/IGlkLnJlcGxhY2UoL1teYS16QS1aMC05XzouQC1dL2csICcnKS5zbGljZSgwLCA4MCkgOiAnJztcclxuICAgICAgY29uc3QgbyA9IG9wID09PSAnYXJjaGl2ZScgfHwgb3AgPT09ICdkZWxldGUnID8gb3AgOiAnJztcclxuICAgICAgaWYgKHNpZCA9PT0gJycgfHwgbyA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ2lkIGFuZCBvcChhcmNoaXZlfGRlbGV0ZSkgcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oYC9hcGkvc2Vzc2lvbnMvJHtlbmNvZGVVUklDb21wb25lbnQoc2lkKX0vJHtvfWAsIHt9KSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIE00OkRpZmYgXHU5NzYyXHU2NzdGKFx1NTNFQVx1OEJGQiBnaXQgXHU1M0Q4XHU2NkY0O1x1NjM4OFx1Njc0M1x1NTcyOCBydW50aW1lKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmRpZmYnLCAoZXZlbnQsIHNlc3Npb25JZDogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBzaWQgPSB0eXBlb2Ygc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IHNlc3Npb25JZC5zbGljZSgwLCA4MCkgOiAnJztcclxuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPFJlY29yZDxzdHJpbmcsIHVua25vd24+PihgL2FwaS9kaWZmJHtzaWQgIT09ICcnID8gYD9zZXNzaW9uSWQ9JHtlbmNvZGVVUklDb21wb25lbnQoc2lkKX1gIDogJyd9YCkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBNNTpcdThCQTRcdTc3RTVcdTcyQjZcdTYwMDEoXHU3RUQzXHU2Nzg0XHU1MzE2XHU0RThCXHU1QjlFO1x1N0YzQVx1NjU3MFx1NjM2RVx1NUI1N1x1NkJCNVx1NzUzMSBVSSBcdTY2M0VcdTc5M0FcIlx1NjVFMFx1NjU3MFx1NjM2RVwiKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmNvZ25pdGl2ZScsIChldmVudCkgPT5cclxuICAgICAgaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KCcvYXBpL2NvZ25pdGl2ZScpKSk7XHJcblxyXG4gICAgLy8gLS0tLSBcdTUzODZcdTUzRjJcdTRGMUFcdThCRERcdTk4ODRcdTg5QzgoXHU2NzAwXHU1NDBFIDgwIFx1Njc2MSxcdTZCQ0ZcdTY3NjEgNTAwIFx1NUI1NztydW50aW1lIFx1Njc0M1x1NUEwMVx1NjU3MFx1NjM2RSkgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpzZXNzaW9uLXByZXZpZXcnLCAoZXZlbnQsIGlkOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IHNpZCA9IHR5cGVvZiBpZCA9PT0gJ3N0cmluZycgPyBpZC5yZXBsYWNlKC9bXmEtekEtWjAtOV86LkAtXS9nLCAnJykuc2xpY2UoMCwgODApIDogJyc7XHJcbiAgICAgIGlmIChzaWQgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICdpZCByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oYC9hcGkvc2Vzc2lvbnMvJHtlbmNvZGVVUklDb21wb25lbnQoc2lkKX1gKSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnN0b3AtaG9zdCcsIChldmVudCkgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInIH07XHJcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcclxuICAgICAgICBzc2VBYm9ydD8uYWJvcnQoKTtcclxuICAgICAgICBhd2FpdCBzdXBlcnZpc29yPy5zdG9wKCk7XHJcbiAgICAgICAgYXBwLnF1aXQoKTtcclxuICAgICAgfSkoKTtcclxuICAgICAgcmV0dXJuIHsgb2s6IHRydWUgfTtcclxuICAgIH0pO1xyXG4gIH1cclxuXHJcbiAgLyogLS0tLSBcdTdBOTdcdTUzRTNcdTRFMEVcdTVCODlcdTUxNjhcdTdCNTZcdTc1NjUgLS0tLSAqL1xyXG4gIC8vIDAzIFx1MDBBN1x1NEUwMzpEZXNrdG9wIFx1NjcyQ1x1NTczMFx1NTNFQVx1NUI1OCBVSSBcdTUwNEZcdTU5N0QvXHU3QTk3XHU1M0UzXHU3MkI2XHU2MDAxKHVzZXJEYXRhL3dpbmRvdy1zdGF0ZS5qc29uKVxyXG4gIGNvbnN0IHdpbmRvd1N0YXRlRmlsZSA9ICgpOiBzdHJpbmcgPT4gam9pbihhcHAuZ2V0UGF0aCgndXNlckRhdGEnKSwgJ3dpbmRvdy1zdGF0ZS5qc29uJyk7XHJcbiAgYXN5bmMgZnVuY3Rpb24gbG9hZEJvdW5kcygpOiBQcm9taXNlPHsgd2lkdGg6IG51bWJlcjsgaGVpZ2h0OiBudW1iZXI7IHg/OiBudW1iZXI7IHk/OiBudW1iZXIgfSB8IG51bGw+IHtcclxuICAgIHRyeSB7XHJcbiAgICAgIHJldHVybiBKU09OLnBhcnNlKGF3YWl0IHJlYWRGaWxlKHdpbmRvd1N0YXRlRmlsZSgpLCAndXRmOCcpKSBhcyB7IHdpZHRoOiBudW1iZXI7IGhlaWdodDogbnVtYmVyOyB4PzogbnVtYmVyOyB5PzogbnVtYmVyIH07XHJcbiAgICB9IGNhdGNoIHsgcmV0dXJuIG51bGw7IH1cclxuICB9XHJcbiAgYXN5bmMgZnVuY3Rpb24gc2F2ZUJvdW5kcyh3aW46IEJyb3dzZXJXaW5kb3cpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIHRyeSB7IGF3YWl0IHdyaXRlRmlsZSh3aW5kb3dTdGF0ZUZpbGUoKSwgSlNPTi5zdHJpbmdpZnkod2luLmdldEJvdW5kcygpKSwgJ3V0ZjgnKTsgfSBjYXRjaCB7IC8qIGJlc3QgZWZmb3J0ICovIH1cclxuICB9XHJcblxyXG4gIGFzeW5jIGZ1bmN0aW9uIGNyZWF0ZVdpbmRvdygpOiBQcm9taXNlPEJyb3dzZXJXaW5kb3cgfCBudWxsPiB7XHJcbiAgICBjb25zdCBzYXZlZCA9IGF3YWl0IGxvYWRCb3VuZHMoKTtcclxuICAgIGNvbnN0IHdpbiA9IG5ldyBCcm93c2VyV2luZG93KHtcclxuICAgICAgd2lkdGg6IHNhdmVkPy53aWR0aCA/PyAxNDQwLFxyXG4gICAgICBoZWlnaHQ6IHNhdmVkPy5oZWlnaHQgPz8gOTAwLFxyXG4gICAgICAuLi4oc2F2ZWQ/LnggIT09IHVuZGVmaW5lZCAmJiBzYXZlZD8ueSAhPT0gdW5kZWZpbmVkID8geyB4OiBzYXZlZC54LCB5OiBzYXZlZC55IH0gOiB7fSksXHJcbiAgICAgIG1pbldpZHRoOiA1NjAsIC8vIEhJRyBcdTk2MzZcdTZCQjUyOjA0IFx1NTNGN1x1ODlDNFx1NjgzQ1x1N0E4NFx1N0E5NyBcdTIyNjU1NjA7XHU1MzlGIDk2MCBcdTRGN0YgXHUyMjY0ODIwcHggXHU2MkJEXHU1QzQ5XHU2NUFEXHU3MEI5XHU1QjlFXHU5NjQ1XHU0RTBEXHU1M0VGXHU4RkJFXHJcbiAgICAgIG1pbkhlaWdodDogNjAwLFxyXG4gICAgICBzaG93OiBmYWxzZSxcclxuICAgICAgYmFja2dyb3VuZENvbG9yOiAnI2Y5ZmFmYicsIC8vIHY0IERTSDpcdTZENDVcdTgyNzJcdTlFRDhcdThCQTQoYmctYmFzZSksXHU5MDdGXHU1MTREXHU2REYxXHU4MjcyXHU5NUVBXHU1QzRGXHJcbiAgICAgIHRpdGxlOiAnSE1IIERlc2t0b3AnLFxyXG4gICAgICAvLyBcdTk2OTBcdTg1Q0ZcdTVGMEZcdTY4MDdcdTk4OThcdTY4MEY6XHU1MzlGXHU3NTFGXHU3QTk3XHU1M0UzXHU2M0E3XHU1MjM2KG92ZXJsYXkgXHU2M0QwXHU0RjlCKStcdTk4OUNcdTgyNzJcdTk2OEZcdTRFM0JcdTk4OTgocmVuZGVyZXIgXHU3RUNGXHJcbiAgICAgIC8vIGNocm9tZS10aGVtZSBcdTU0MENcdTZCNjUpXHUyMDE0XHUyMDE0XHU2ODM5XHU2Q0JCXHU0RUFFXHU4MjcyXHU2QTIxXHU1RjBGXHU5ODc2XHU5MEU4XHU5RUQxXHU2NzYxO1x1ODNEQ1x1NTM1NVx1NjgwRiBhdXRvSGlkZShBbHQgXHU1NDdDXHU1MUZBKVx1MzAwMlxyXG4gICAgICB0aXRsZUJhclN0eWxlOiAnaGlkZGVuJyxcclxuICAgICAgLy8gSElHIFx1OTYzNlx1NkJCNTI6MzZcdTIxOTI0NCxcdTRFMEUgcmVuZGVyZXIgLnRpdGxlYmFyIFx1OUFEOFx1NUVBNlx1NEUwMFx1ODFGNChcdTRFMERcdTRFMDBcdTgxRjRcdTRGMUFcdTk3MzJcdTUxRkEvXHU5MDZFXHU0RjRGIDhweClcclxuICAgICAgdGl0bGVCYXJPdmVybGF5OiB7IC4uLmNocm9tZUZvcihuYXRpdmVUaGVtZS5zaG91bGRVc2VEYXJrQ29sb3JzKSwgaGVpZ2h0OiA0NCB9LFxyXG4gICAgICBhdXRvSGlkZU1lbnVCYXI6IHRydWUsXHJcbiAgICAgIHdlYlByZWZlcmVuY2VzOiB7XHJcbiAgICAgICAgcHJlbG9hZDogcHJlbG9hZFBhdGgsXHJcbiAgICAgICAgY29udGV4dElzb2xhdGlvbjogdHJ1ZSxcclxuICAgICAgICBzYW5kYm94OiB0cnVlLFxyXG4gICAgICAgIG5vZGVJbnRlZ3JhdGlvbjogZmFsc2UsXHJcbiAgICAgICAgbm9kZUludGVncmF0aW9uSW5Xb3JrZXI6IGZhbHNlLFxyXG4gICAgICAgIHdlYlNlY3VyaXR5OiB0cnVlLFxyXG4gICAgICAgIHNwZWxsY2hlY2s6IGZhbHNlLFxyXG4gICAgICAgIGRldlRvb2xzOiBpc0RldixcclxuICAgICAgfSxcclxuICAgIH0pO1xyXG4gICAgd2luLm9uY2UoJ3JlYWR5LXRvLXNob3cnLCAoKSA9PiB3aW4uc2hvdygpKTtcclxuICAgIHdpbi5vbignY2xvc2UnLCAoKSA9PiB7IHZvaWQgc2F2ZUJvdW5kcyh3aW4pOyB9KTtcclxuXHJcbiAgICAvLyBcdTUzRUFcdTUxNDFcdThCQjhcdTUyQTBcdThGN0RcdTYyMTFcdTRFRUNcdTgxRUFcdTVERjFcdTc2ODQgcmVuZGVyZXI7XHU0RUZCXHU0RjU1XHU1QkZDXHU4MjJBL1x1NjVCMFx1N0E5N1x1NTNFM1x1NEUwMFx1NUY4Qlx1NjJEMlx1N0VERFxyXG4gICAgd2luLndlYkNvbnRlbnRzLnNldFdpbmRvd09wZW5IYW5kbGVyKCh7IHVybCB9KSA9PiB7XHJcbiAgICAgIGlmICgvXmh0dHBzPzpcXC9cXC8vLnRlc3QodXJsKSkgdm9pZCBzaGVsbC5vcGVuRXh0ZXJuYWwodXJsKTtcclxuICAgICAgcmV0dXJuIHsgYWN0aW9uOiAnZGVueScgfTtcclxuICAgIH0pO1xyXG4gICAgd2luLndlYkNvbnRlbnRzLm9uKCd3aWxsLW5hdmlnYXRlJywgKGUsIHVybCkgPT4ge1xyXG4gICAgICBjb25zdCBvayA9IFsuLi5hbGxvd2VkT3JpZ2luc10uc29tZSgobykgPT4gdXJsID09PSBvIHx8IHVybC5zdGFydHNXaXRoKGAke299L2ApIHx8IHVybC5zdGFydHNXaXRoKGAke299P2ApKTtcclxuICAgICAgaWYgKCFvaykge1xyXG4gICAgICAgIGxvZ0luZm8oJ25hdicsIGBibG9ja2VkIG5hdmlnYXRpb24gdG8gJHt1cmwuc2xpY2UoMCwgMTIwKX1gKTtcclxuICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7XHJcbiAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIGlmIChpc0RldiAmJiByZW5kZXJlckRldlVybCkge1xyXG4gICAgICB2b2lkIHdpbi5sb2FkVVJMKHJlbmRlcmVyRGV2VXJsKTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgIHZvaWQgd2luLmxvYWRGaWxlKGpvaW4oaGVyZSwgJy4uJywgJy4uJywgJ2Rpc3QtcmVuZGVyZXInLCAnaW5kZXguaHRtbCcpKTtcclxuICAgIH1cclxuICAgIC8vIFx1OTg3NVx1OTc2Mlx1NTJBMFx1OEY3RFx1NUI4Q1x1OTFDRFx1NjRBRFx1NUY1M1x1NTI0RCBob3N0IFx1NzJCNlx1NjAwMTpyZWFkeSBcdTVFN0ZcdTY0QURcdTgyRTVcdTY1RTlcdTRFOEUgcmVuZGVyZXIgXHU4QkEyXHU5NjA1XHU1MzczXHU0RTIyXHU1OTMxLFxyXG4gICAgLy8gcmVuZGVyZXIgXHU3Njg0IGdldC1zdGF0ZSBcdTVGRUJcdTcxNjcgKyBcdThGRDlcdTkxQ0NcdTc2ODRcdTkxQ0RcdTY0QURcdTUzQ0NcdTRGRERcdTk2NjkoXHU1OTFBXHU3QTk3XHU1M0UzL1x1OTFDRFx1OEY3RFx1NTczQVx1NjY2Rlx1NEU1Rlx1ODk4Nlx1NzZENilcdTMwMDJcclxuICAgIHdpbi53ZWJDb250ZW50cy5vbmNlKCdkaWQtZmluaXNoLWxvYWQnLCAoKSA9PiB7XHJcbiAgICAgIGlmICghd2luLmlzRGVzdHJveWVkKCkpIHtcclxuICAgICAgICB3aW4ud2ViQ29udGVudHMuc2VuZCgnYnJpZGdlOmhvc3Qtc3RhdGUnLCBicmlkZ2UuaG9zdFN0YXRlLCB7IHJlc3RhcnRDb3VudDogMCB9KTtcclxuICAgICAgfVxyXG4gICAgfSk7XHJcbiAgICByZXR1cm4gd2luO1xyXG4gIH1cclxuXHJcbiAgYXBwLndoZW5SZWFkeSgpLnRoZW4oKCkgPT4ge1xyXG4gICAgLy8gVUlWRVJJRlk6ZmFrZSBcdTZBMjFcdTVGMEZcdTlBOENcdTY1MzZcdTk4N0JcdTU3Mjggc3RhcnRIb3N0IFx1OEJGQiBlbnYgXHU0RTRCXHU1MjREXHU1RjNBXHU1MjM2IGZha2U7VklTUkVHKFx1ODlDNlx1ODlDOVx1NTZERVx1NUY1MilcdTU0MENcdTg5QzRcdTUyMTlcclxuICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9WSVNSRUcgPT09ICcxJyB8fCAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRlkgPT09ICcxJyAmJiBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9NT0RFICE9PSAncmVhbCcpKSB7XHJcbiAgICAgIHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX0ZBS0UgPSAnMSc7XHJcbiAgICB9XHJcbiAgICAvLyBXaW5kb3dzIFx1OTAxQVx1NzdFNVx1NUY1Mlx1NUM1RShcdTU0MjZcdTUyMTlcdTY2M0VcdTc5M0FcdTRFM0EgZWxlY3Ryb24uZXhlKVxyXG4gICAgYXBwLnNldEFwcFVzZXJNb2RlbElkKCdkZXYuaG1oLmRlc2t0b3AnKTtcclxuICAgIHNldHVwVHJheSgpO1xyXG4gICAgYnVpbGRBcHBNZW51KCk7XHJcbiAgICAvLyBcdTU0MkZcdTUyQTggMzBzIFx1NTQwRVx1OTc1OVx1OUVEOFx1NjhDMFx1NjdFNVx1NjZGNFx1NjVCMChcdTY3MDlcdTY1QjBcdTcyNDhcdTRFQzVcdTU0MEVcdTUzRjBcdTRFMEJcdThGN0QsXHU0RTBEXHU2MjUzXHU2MjcwO1x1NzUyOFx1NjIzN1x1N0VDRiBcdTI2MzAgXHU4M0RDXHU1MzU1XHU1MUIzXHU1QjlBXHU4OEM1KVxyXG4gICAgaWYgKGFwcC5pc1BhY2thZ2VkKSBzZXRUaW1lb3V0KCgpID0+IHsgdm9pZCBjaGVja0ZvclVwZGF0ZXMoKTsgfSwgMzBfMDAwKTtcclxuICAgIC8vIENTUChkZXYgXHU0RTBFIHByb2QgXHU0RTBEXHU1NDBDO3Byb2QgXHU0RTBEXHU1MTQxXHU4QkI4XHU0RUZCXHU0RjU1XHU4RkRDXHU3QTBCXHU2RTkwKVxyXG4gICAgY29uc3QgY3NwID0gaXNEZXZcclxuICAgICAgPyBbXHJcbiAgICAgICAgICBcImRlZmF1bHQtc3JjICdzZWxmJ1wiLFxyXG4gICAgICAgICAgYHNjcmlwdC1zcmMgJ3NlbGYnICR7cmVuZGVyZXJEZXZVcmx9YCxcclxuICAgICAgICAgIFwic3R5bGUtc3JjICdzZWxmJyAndW5zYWZlLWlubGluZSdcIixcclxuICAgICAgICAgIGBjb25uZWN0LXNyYyAnc2VsZicgJHtyZW5kZXJlckRldlVybH0gd3M6Ly8xMjcuMC4wLjE6KmAsXHJcbiAgICAgICAgICBcImltZy1zcmMgJ3NlbGYnIGRhdGE6XCIsXHJcbiAgICAgICAgICBcImZvbnQtc3JjICdzZWxmJyBkYXRhOlwiLFxyXG4gICAgICAgIF0uam9pbignOyAnKVxyXG4gICAgICA6IFwiZGVmYXVsdC1zcmMgJ3NlbGYnOyBzY3JpcHQtc3JjICdzZWxmJzsgc3R5bGUtc3JjICdzZWxmJyAndW5zYWZlLWlubGluZSc7IGltZy1zcmMgJ3NlbGYnIGRhdGE6OyBmb250LXNyYyAnc2VsZicgZGF0YTpcIjtcclxuICAgIHNlc3Npb24uZGVmYXVsdFNlc3Npb24ud2ViUmVxdWVzdC5vbkhlYWRlcnNSZWNlaXZlZCgoZGV0YWlscywgY2FsbGJhY2spID0+IHtcclxuICAgICAgY2FsbGJhY2soe1xyXG4gICAgICAgIHJlc3BvbnNlSGVhZGVyczoge1xyXG4gICAgICAgICAgLi4uZGV0YWlscy5yZXNwb25zZUhlYWRlcnMsXHJcbiAgICAgICAgICAnQ29udGVudC1TZWN1cml0eS1Qb2xpY3knOiBbY3NwXSxcclxuICAgICAgICB9LFxyXG4gICAgICB9KTtcclxuICAgIH0pO1xyXG5cclxuICAgIHJlZ2lzdGVySXBjKCk7XHJcbiAgICAvLyBjcmVhdGVXaW5kb3cgXHU2NjJGIGFzeW5jKGJvdW5kcyBcdTYwNjJcdTU5MEQpO1x1NUI4OVx1NTE2OFx1ODFFQVx1NkQ0Qi9cdTZFMzJcdTY3RDNcdTgxRUFcdTY4QzBcdTU3MjhcdTdBOTdcdTUzRTNcdTVDMzFcdTdFRUFcdTU0MEVcdTYzMDJcdThGN0RcclxuICAgIHZvaWQgY3JlYXRlV2luZG93KCkudGhlbigod2luKSA9PiB7XHJcbiAgICAgIGlmICh3aW4gPT09IG51bGwpIHJldHVybjtcclxuICAgICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZID09PSAnMScpIGF0dGFjaFVpVmVyaWZ5KHdpbik7XHJcbiAgICAgIC8vIFx1ODlDNlx1ODlDOVx1NTZERVx1NUY1Mlx1NjIyQVx1NTZGRVx1OTRBOVx1NUI1MDpITUhfREVTS1RPUF9WSVNSRUc9MSxcdTc4NkVcdTVCOUFcdTYwMjdcdTg5QzZcdTUzRTNcdTYyMkFcdTU2RkVcdTU0MEVcdTkwMDBcdTUxRkEoc2NyaXB0cy92aXN1YWwtcmVncmVzc2lvbi5tanMgXHU5QTcxXHU1MkE4KVxyXG4gICAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVklTUkVHID09PSAnMScpIGF0dGFjaFZpc3VhbFJlZ3Jlc3Npb24od2luKTtcclxuICAgICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NFQ1VSSVRZX1RFU1QgPT09ICcxJykge1xyXG4gICAgICAgIHdpbi53ZWJDb250ZW50cy5vbmNlKCdkaWQtZmluaXNoLWxvYWQnLCAoKSA9PiB7XHJcbiAgICAgICAgICB2b2lkIHNlY3VyaXR5U2VsZlRlc3Qod2luKTtcclxuICAgICAgICB9KTtcclxuICAgICAgfVxyXG4gICAgICAvLyBVSSBcdTYyMkFcdTU2RkVcdTk0QTlcdTVCNTA6SE1IX0RFU0tUT1BfU05BUFNIT1Q9PGZpbGUucG5nPiBcdTU3MjhcdTc1NENcdTk3NjJcdTVDMzFcdTdFRUFcdTU0MEVcdTYyMkFcdTU2RkVcdTkwMDBcdTUxRkFcclxuICAgICAgLy8gKFx1ODhDNVx1NjczQVx1OEJDQVx1NjVBRFx1NzUyODpcdTRFQjJcdTc3M0NcdTc3MEJcdTZFMzJcdTY3RDNcdTdFRDNcdTY3OUMsXHU4MDBDXHU0RTBEXHU2NjJGXHU1M0VBXHU2NTcwIHJvb3QgXHU1QjUwXHU4MjgyXHU3MEI5KVx1MzAwMlxyXG4gICAgICBjb25zdCBzbmFwID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfU05BUFNIT1Q7XHJcbiAgICAgIGlmIChzbmFwICE9PSB1bmRlZmluZWQgJiYgc25hcCAhPT0gJycpIHtcclxuICAgICAgICB3aW4ud2ViQ29udGVudHMub25jZSgnZGlkLWZpbmlzaC1sb2FkJywgKCkgPT4ge1xyXG4gICAgICAgICAgc2V0VGltZW91dCgoKSA9PiB7XHJcbiAgICAgICAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcclxuICAgICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgaW1nID0gYXdhaXQgd2luLndlYkNvbnRlbnRzLmNhcHR1cmVQYWdlKCk7XHJcbiAgICAgICAgICAgICAgICBjb25zdCB7IHdyaXRlRmlsZTogd2YgfSA9IGF3YWl0IGltcG9ydCgnbm9kZTpmcy9wcm9taXNlcycpO1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgd2Yoc25hcCwgaW1nLnRvUE5HKCkpO1xyXG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYFNOQVBTSE9UIG9rICR7c25hcH0gJHtpbWcuZ2V0U2l6ZSgpLndpZHRofXgke2ltZy5nZXRTaXplKCkuaGVpZ2h0fWApO1xyXG4gICAgICAgICAgICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYFNOQVBTSE9UIGVycm9yICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTIwKX1gKTtcclxuICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgY29uc3QgYXBwMiA9IGFwcDtcclxuICAgICAgICAgICAgICBzZXRUaW1lb3V0KCgpID0+IGFwcDIuZXhpdCgwKSwgNTAwKTtcclxuICAgICAgICAgICAgfSkoKTtcclxuICAgICAgICAgIH0sIE51bWJlcihwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9TTkFQU0hPVF9ERUxBWV9NUyA/PyAxMl8wMDApKTtcclxuICAgICAgICB9KTtcclxuICAgICAgfVxyXG4gICAgICAvLyBET00gXHU3RUQzXHU2Nzg0XHU2M0EyXHU5NDg4OkhNSF9ERVNLVE9QX0RPTVBST0JFPTEgXHU4RjkzXHU1MUZBXHU1MTczXHU5NTJFXHU1MTQzXHU3RDIwXHU3Njg0IGJveC9kaXNwbGF5L2NoaWxkcmVuLFxyXG4gICAgICAvLyBcdTUxOERcdTkwMDBcdTUxRkEoXHU4QkNBXHU2NUFEXCJSZWFjdCBcdTYzMDJcdThGN0RcdTRFODZcdTRGNDZcdTY3RDBcdTU3NTcgVUkgXHU0RTBEXHU1M0VGXHU4OUMxXCJcdThGRDlcdTdDN0JcdTk1RUVcdTk4OTg7XHU2MjJBXHU1NkZFXHU0RTRCXHU1OTE2XHU3Njg0XHU3ODZDXHU4QkMxXHU2MzZFKVx1MzAwMlxyXG4gICAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfRE9NUFJPQkUgPT09ICcxJykge1xyXG4gICAgICAgIHdpbi53ZWJDb250ZW50cy5vbmNlKCdkaWQtZmluaXNoLWxvYWQnLCAoKSA9PiB7XHJcbiAgICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHtcclxuICAgICAgICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCByID0gKGF3YWl0IHdpbi53ZWJDb250ZW50cy5leGVjdXRlSmF2YVNjcmlwdChgKGZ1bmN0aW9uKCl7XHJcbiAgICAgICAgICAgICAgICAgIHZhciBwaWNrID0gZnVuY3Rpb24oc2VsKXtcclxuICAgICAgICAgICAgICAgICAgICB2YXIgZWxzID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbChzZWwpO1xyXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBBcnJheS5wcm90b3R5cGUuc2xpY2UuY2FsbChlbHMsIDAsIDQpLm1hcChmdW5jdGlvbihlbCl7XHJcbiAgICAgICAgICAgICAgICAgICAgICB2YXIgY3MgPSBnZXRDb21wdXRlZFN0eWxlKGVsKTtcclxuICAgICAgICAgICAgICAgICAgICAgIHZhciBiID0gZWwuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICByZXR1cm4geyBjbHM6IChlbC5jbGFzc05hbWV8fCcnKS50b1N0cmluZygpLnNsaWNlKDAsODApLCB0YWc6IGVsLnRhZ05hbWUsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGRpc3BsYXk6IGNzLmRpc3BsYXksIHZpczogY3MudmlzaWJpbGl0eSwgb3BhY2l0eTogY3Mub3BhY2l0eSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgcG9zOiBjcy5wb3NpdGlvbiwgejogY3MuekluZGV4LCBvdmVyZmxvdzogY3Mub3ZlcmZsb3csXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHg6IE1hdGgucm91bmQoYi54KSwgeTogTWF0aC5yb3VuZChiLnkpLCB3OiBNYXRoLnJvdW5kKGIud2lkdGgpLCBoOiBNYXRoLnJvdW5kKGIuaGVpZ2h0KSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgdGV4dDogKGVsLmlubmVyVGV4dHx8JycpLnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw2MCkgfTtcclxuICAgICAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgICAgICAgdmFyIHNlbHMgPSBbJ2h0bWwnLCdib2R5JywnI3Jvb3QnLCcuYXBwLXNoZWxsJywnLnNpZGViYXInLCcud29ya3NwYWNlJywnLnRvcGJhcicsJy5zdHJlYW0nLCcuZW1wdHktaGludCcsJy5jb21wb3NlcicsJy5jb21wb3Nlci1yb3cnLCcuY29tcG9zZXIgdGV4dGFyZWEnLCcuY29tcG9zZXItc2lkZScsJy5hdHQtcGlja2VyJywnLmF0dC1jaGlwcycsJy5zaWRlcGFuZWwnLCcucnVudGltZS1ndWlkZScsJy5vdmVybGF5JywnLnR1cm4nLCcuY2FyZCddO1xyXG4gICAgICAgICAgICAgICAgICB2YXIgb3V0ID0ge307XHJcbiAgICAgICAgICAgICAgICAgIHNlbHMuZm9yRWFjaChmdW5jdGlvbihzKXsgdHJ5IHsgb3V0W3NdID0gcGljayhzKTsgfSBjYXRjaChlKXsgb3V0W3NdID0gW3tlcnI6IFN0cmluZyhlKS5zbGljZSgwLDgwKX1dOyB9IH0pO1xyXG4gICAgICAgICAgICAgICAgICBvdXQuX19tZXRhID0ge1xyXG4gICAgICAgICAgICAgICAgICAgIHN0eWxlU2hlZXRzOiBkb2N1bWVudC5zdHlsZVNoZWV0cy5sZW5ndGgsXHJcbiAgICAgICAgICAgICAgICAgICAgc2hlZXQwcnVsZXM6IChkb2N1bWVudC5zdHlsZVNoZWV0c1swXSAmJiBkb2N1bWVudC5zdHlsZVNoZWV0c1swXS5jc3NSdWxlcykgPyBkb2N1bWVudC5zdHlsZVNoZWV0c1swXS5jc3NSdWxlcy5sZW5ndGggOiAtMSxcclxuICAgICAgICAgICAgICAgICAgICByb290Q2hpbGRyZW46IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyb290JykgPyBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncm9vdCcpLmNoaWxkcmVuLmxlbmd0aCA6IC0xLFxyXG4gICAgICAgICAgICAgICAgICAgIGJvZHlDaGlsZHJlbjogZG9jdW1lbnQuYm9keS5jaGlsZHJlbi5sZW5ndGgsXHJcbiAgICAgICAgICAgICAgICAgICAgaW5uZXJIVE1MTGVuOiBkb2N1bWVudC5ib2R5LmlubmVySFRNTC5sZW5ndGgsXHJcbiAgICAgICAgICAgICAgICAgICAgdmlld3BvcnQ6IHdpbmRvdy5pbm5lcldpZHRoICsgJ3gnICsgd2luZG93LmlubmVySGVpZ2h0XHJcbiAgICAgICAgICAgICAgICAgIH07XHJcbiAgICAgICAgICAgICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeShvdXQpO1xyXG4gICAgICAgICAgICAgICAgfSkoKWAsIHRydWUpKSBhcyBzdHJpbmc7XHJcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgRE9NUFJPQkUgJHtyfWApO1xyXG4gICAgICAgICAgICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYERPTVBST0JFIGVycm9yICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMjAwKX1gKTtcclxuICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgYXBwLmV4aXQoMCk7XHJcbiAgICAgICAgICAgIH0pKCk7XHJcbiAgICAgICAgICB9LCBOdW1iZXIocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfRE9NUFJPQkVfREVMQVlfTVMgPz8gOV8wMDApKTtcclxuICAgICAgICB9KTtcclxuICAgICAgfVxyXG4gICAgICAvLyBcdTZFMzJcdTY3RDNcdTgxRUFcdTY4QzAoMjAyNi0xMC0xMCBcdTg4QzVcdTY3M0FcdTlFRDFcdTVDNEZcdTY1NTlcdThCQUQ6YnJpZGdlIHJlYWR5IFx1MjI2MCBcdTc1NENcdTk3NjJcdTZFMzJcdTY3RDNcdTRFODYpXHUzMDAyXHJcbiAgICAgIC8vICNyb290IFx1NTcyOCBSZWFjdCBcdTYzMDJcdThGN0RcdTU0MEVcdTVGQzVcdTY3MDlcdTVCNTBcdTgyODJcdTcwQjk7XHU3QTdBID0gXHU4RDQ0XHU2RTkwXHU4REVGXHU1Rjg0L0NTUC9cdTgxMUFcdTY3MkNcdTUyQTBcdThGN0RcdTU3NEZcdTRFODZcdTMwMDJcclxuICAgICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1JFTkRFUl9URVNUID09PSAnMScpIHtcclxuICAgICAgICB3aW4ud2ViQ29udGVudHMub25jZSgnZGlkLWZpbmlzaC1sb2FkJywgKCkgPT4ge1xyXG4gICAgICAgICAgc2V0VGltZW91dCgoKSA9PiB7XHJcbiAgICAgICAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcclxuICAgICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgbiA9IChhd2FpdCB3aW4ud2ViQ29udGVudHMuZXhlY3V0ZUphdmFTY3JpcHQoXHJcbiAgICAgICAgICAgICAgICAgICdkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInJvb3RcIikgPyBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInJvb3RcIikuY2hpbGRyZW4ubGVuZ3RoIDogLTEnLCB0cnVlLFxyXG4gICAgICAgICAgICAgICAgKSkgYXMgbnVtYmVyO1xyXG4gICAgICAgICAgICAgICAgY29uc3Qgb2sgPSBuID4gMDtcclxuICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBSRU5ERVItVEVTVCAke29rID8gJ29rJyA6ICdFTVBUWSd9IHJvb3RDaGlsZHJlbj0ke259YCk7XHJcbiAgICAgICAgICAgICAgICBhcHAuZXhpdChvayA/IDAgOiAxKTtcclxuICAgICAgICAgICAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBSRU5ERVItVEVTVCBFUlJPUiAke1N0cmluZyhlcnIpLnNsaWNlKDAsIDEyMCl9YCk7XHJcbiAgICAgICAgICAgICAgICBhcHAuZXhpdCgxKTtcclxuICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH0pKCk7XHJcbiAgICAgICAgICB9LCAyXzUwMCk7XHJcbiAgICAgICAgfSk7XHJcbiAgICAgIH1cclxuICAgIH0pO1xyXG4gICAgdm9pZCBzdGFydEhvc3QoKTtcclxuXHJcbiAgICBhcHAub24oJ2FjdGl2YXRlJywgKCkgPT4ge1xyXG4gICAgICBpZiAoQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkubGVuZ3RoID09PSAwKSB2b2lkIGNyZWF0ZVdpbmRvdygpO1xyXG4gICAgfSk7XHJcbiAgfSk7XHJcblxyXG4gIGFzeW5jIGZ1bmN0aW9uIHNlY3VyaXR5U2VsZlRlc3Qod2luOiBCcm93c2VyV2luZG93KTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCByZXN1bHRzOiBBcnJheTxbc3RyaW5nLCBib29sZWFuLCBzdHJpbmddPiA9IFtdO1xyXG4gICAgY29uc3QgY2hlY2sgPSBhc3luYyAobmFtZTogc3RyaW5nLCBwcm9iZTogKCkgPT4gUHJvbWlzZTxbYm9vbGVhbiwgc3RyaW5nXT4pOiBQcm9taXNlPHZvaWQ+ID0+IHtcclxuICAgICAgdHJ5IHtcclxuICAgICAgICBjb25zdCBbb2ssIGRldGFpbF0gPSBhd2FpdCBwcm9iZSgpO1xyXG4gICAgICAgIHJlc3VsdHMucHVzaChbbmFtZSwgb2ssIGRldGFpbF0pO1xyXG4gICAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgICByZXN1bHRzLnB1c2goW25hbWUsIGZhbHNlLCBTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApXSk7XHJcbiAgICAgIH1cclxuICAgIH07XHJcbiAgICBjb25zdCBqcyA9IChjb2RlOiBzdHJpbmcpOiBQcm9taXNlPHVua25vd24+ID0+IHdpbi53ZWJDb250ZW50cy5leGVjdXRlSmF2YVNjcmlwdChjb2RlLCB0cnVlKTtcclxuXHJcbiAgICBhd2FpdCBjaGVjaygncmVuZGVyZXIgXHU2NUUwXHU1M0VGXHU3NTI4XHU3Njg0IHByb2Nlc3MvcmVxdWlyZShzYW5kYm94IFx1NzUxRlx1NjU0OCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoYChmdW5jdGlvbigpe1xyXG4gICAgICAgIHZhciB0ID0gZnVuY3Rpb24oZil7IHRyeSB7IHZhciB2ID0gZigpOyByZXR1cm4gKHYgPT09IHVuZGVmaW5lZCB8fCB2ID09PSBudWxsKSA/ICd1bmF2YWlsYWJsZScgOiB0eXBlb2YgdjsgfSBjYXRjaChlKXsgcmV0dXJuICdibG9ja2VkJzsgfSB9O1xyXG4gICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeShbdChmdW5jdGlvbigpe3JldHVybiBwcm9jZXNzfSksIHQoZnVuY3Rpb24oKXtyZXR1cm4gcmVxdWlyZX0pLCB0KGZ1bmN0aW9uKCl7cmV0dXJuIGdsb2JhbFRoaXMucHJvY2Vzc30pXSk7XHJcbiAgICAgIH0pKClgKSkgYXMgc3RyaW5nO1xyXG4gICAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHIpIGFzIHN0cmluZ1tdO1xyXG4gICAgICBjb25zdCBwID0gcGFyc2VkWzBdID8/ICd1bmtub3duJztcclxuICAgICAgY29uc3QgcmVxID0gcGFyc2VkWzFdID8/ICd1bmtub3duJztcclxuICAgICAgY29uc3Qgc2FmZSA9ICh2OiBzdHJpbmcpOiBib29sZWFuID0+IHYgPT09ICd1bmF2YWlsYWJsZScgfHwgdiA9PT0gJ2Jsb2NrZWQnO1xyXG4gICAgICByZXR1cm4gW3NhZmUocCkgJiYgc2FmZShyZXEpLCBgcHJvY2Vzcz0ke3B9IHJlcXVpcmU9JHtyZXF9YF07XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IGNoZWNrKCd3aW5kb3cuaG1oIFx1NTNFQVx1NjcwOVx1NzY3RFx1NTQwRFx1NTM1NVx1NjVCOVx1NkNENShcdTY1RTAgaXBjUmVuZGVyZXIvXHU5ODlEXHU1OTE2XHU5NzYyKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgciA9IChhd2FpdCBqcygnT2JqZWN0LmtleXMod2luZG93LmhtaCB8fCB7fSkuc29ydCgpLmpvaW4oXCIsXCIpJykpIGFzIHN0cmluZztcclxuICAgICAgY29uc3QgYWxsb3cgPSBbJ2FwcGx5VXBkYXRlJywgJ2FwcHJvdmUnLCAnYXBwcm92YWxHZXQnLCAnYXBwcm92YWxTZXQnLCAnYnJvd3NlUnVudGltZScsICdjaGVja1VwZGF0ZScsICdjaHJvbWVUaGVtZScsICdjb2duaXRpdmUnLCAnZGV0ZWN0UnVudGltZScsICdkaWZmJywgJ2V4cG9ydFNlc3Npb24nLCAnZnNMaXN0JywgJ2ZzUmVhZCcsICdmc1NlYXJjaCcsICdnZXRTdGF0ZScsICdnZXRXaXphcmQnLCAnaW5qZWN0JywgJ2luc3RhbGxDbGknLCAnaW50ZXJydXB0JywgJ21vZGVsU2V0JywgJ29uRXZlbnRCYXRjaGVzJywgJ29uSG9zdFN0YXRlJywgJ29uSW5zdGFsbFByb2dyZXNzJywgJ29uTWVudUFjdGlvbicsICdvblN0cmVhbUNodW5rcycsICdvblVwZGF0ZVN0YXRlJywgJ3BpY2tEaXJlY3RvcnknLCAncGlja0ZpbGVzJywgJ3BvcHVwTWFpbk1lbnUnLCAncHJvdmlkZXJTYXZlJywgJ3Byb3ZpZGVycycsICdyZW1vdGVXZWJBdXRvc3RhcnQnLCAncmVtb3RlV2ViU3RhcnQnLCAncmVtb3RlV2ViU3RhdHVzJywgJ3JlbW90ZVdlYlN0b3AnLCAncnVudGltZUluZm8nLCAnc2VuZFRhc2snLCAnc2Vzc2lvbk9wJywgJ3Nlc3Npb25QcmV2aWV3JywgJ3Nlc3Npb25zJywgJ3NldFJ1bnRpbWUnLCAnc3RvcEhvc3QnLCAnd2l6YXJkQ29tcGxldGUnLCAnd29ya3NwYWNlcycsICd3b3Jrc3BhY2VBZGQnLCAnd29ya3NwYWNlVXNlJ107XHJcbiAgICAgIGNvbnN0IGdvdCA9IHIgPT09ICcnID8gW10gOiByLnNwbGl0KCcsJyk7XHJcbiAgICAgIGNvbnN0IHVuZXhwZWN0ZWQgPSBnb3QuZmlsdGVyKChrKSA9PiAhYWxsb3cuaW5jbHVkZXMoaykpO1xyXG4gICAgICByZXR1cm4gW3VuZXhwZWN0ZWQubGVuZ3RoID09PSAwLCBga2V5cz0ke3J9YF07XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IGNoZWNrKCdcdTU5MTZcdTkwRThcdTVCRkNcdTgyMkFcdTg4QUJcdTYyRTZcdTYyMkEoVVJMIFx1NEUwRFx1NTNEOCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IGJlZm9yZSA9IHdpbi53ZWJDb250ZW50cy5nZXRVUkwoKTtcclxuICAgICAgYXdhaXQganMoJ2xvY2F0aW9uLmhyZWYgPSBcImh0dHBzOi8vZXhhbXBsZS5pbnZhbGlkL3hcIjsgXCJub29wXCInKS5jYXRjaCgoKSA9PiAnbm9vcCcpO1xyXG4gICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocjIpID0+IHNldFRpbWVvdXQocjIsIDFfMjAwKSk7XHJcbiAgICAgIGNvbnN0IGFmdGVyID0gd2luLndlYkNvbnRlbnRzLmdldFVSTCgpO1xyXG4gICAgICByZXR1cm4gW2FmdGVyID09PSBiZWZvcmUsIGAke2JlZm9yZX0gXHUyMTkyICR7YWZ0ZXJ9YF07XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IGNoZWNrKCd3aW5kb3cub3BlbiBcdTg4QUJcdTYyRDJcdTdFREQoXHU4RkQ0XHU1NkRFIG51bGwgXHU0RTE0XHU2NUUwXHU2NUIwXHU3QTk3XHU1M0UzKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgYmVmb3JlID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkubGVuZ3RoO1xyXG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKCdTdHJpbmcod2luZG93Lm9wZW4oXCJodHRwczovL2V4YW1wbGUuaW52YWxpZFwiKSknKSkgYXMgc3RyaW5nO1xyXG4gICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocjIpID0+IHNldFRpbWVvdXQocjIsIDQwMCkpO1xyXG4gICAgICBjb25zdCBhZnRlciA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmxlbmd0aDtcclxuICAgICAgcmV0dXJuIFtyID09PSAnbnVsbCcgJiYgYWZ0ZXIgPT09IGJlZm9yZSwgYG9wZW4oKT0ke3J9IHdpbmRvd3M9JHtiZWZvcmV9XHUyMTkyJHthZnRlcn1gXTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgY2hlY2soJ0NTUCBcdTVCNThcdTU3MjgobWV0YSBcdTZDRThcdTUxNjVcdTYyMTZcdTU0Q0RcdTVFOTRcdTU5MzQpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCBtZXRhID0gKGF3YWl0IGpzKCdCb29sZWFuKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoXCJtZXRhW2h0dHAtZXF1aXY9XFwnQ29udGVudC1TZWN1cml0eS1Qb2xpY3lcXCddXCIpKScpKSBhcyBib29sZWFuO1xyXG4gICAgICBjb25zdCBoZWFkZXJDc3AgPSBpc0RldiA/ICdkZXY6IGhlYWRlciBDU1AgXHU3NTMxIG9uSGVhZGVyc1JlY2VpdmVkIFx1NkNFOFx1NTE2NShcdTRFMERcdTkwMDJcdTc1MjggbWV0YSBcdTY1QURcdThBMDApJyA6ICdwcm9kJztcclxuICAgICAgcmV0dXJuIFttZXRhIHx8IGlzRGV2LCBgbWV0YT0ke21ldGF9ICR7aGVhZGVyQ3NwfWBdO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBjaGVjaygnYnJpZGdlOmdldC1zdGF0ZSBcdTZCNjNcdTVFMzhcdThGRDRcdTU2REUoaG9zdCBcdTY4NjVcdTUzRUZcdTc1MjgpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKCd3aW5kb3cuaG1oLmdldFN0YXRlKCkudGhlbihzID0+IEpTT04uc3RyaW5naWZ5KHMpKS5jYXRjaChlID0+IFwiRVJSOlwiK2UpJykpIGFzIHN0cmluZztcclxuICAgICAgcmV0dXJuIFtyLnN0YXJ0c1dpdGgoJ3snKSAmJiByLmluY2x1ZGVzKCdob3N0U3RhdGUnKSwgci5zbGljZSgwLCA4MCldO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBjaGVjaygnWFNTOlx1NjA3Nlx1NjEwRlx1NEVGQlx1NTJBMVx1NjU4N1x1NjcyQ1x1NTNFQVx1NEVFNVx1NjU4N1x1NjcyQ1x1NkUzMlx1NjdEMyhcdTRFMERcdTYyNjdcdTg4NEMpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCBwYXlsb2FkID0gJzxpbWcgc3JjPXggb25lcnJvcj1cIndpbmRvdy5fX3hzcz0xXCI+PHNjcmlwdD53aW5kb3cuX194c3M9MjxcXC9zY3JpcHQ+XCImXFwnJztcclxuICAgICAgY29uc3Qgc2VuZFIgPSAoYXdhaXQganMoYHdpbmRvdy5obWguc2VuZFRhc2soJHtKU09OLnN0cmluZ2lmeShwYXlsb2FkKX0sICdzZWMteHNzLTEnLCAnYXV0bycpLnRoZW4ocj0+SlNPTi5zdHJpbmdpZnkocikpLmNhdGNoKGU9PidFUlI6JytlKWApKSBhcyBzdHJpbmc7XHJcbiAgICAgIGlmICghc2VuZFIuaW5jbHVkZXMoJ1wib2tcIjp0cnVlJykpIHJldHVybiBbZmFsc2UsIGBzZW5kVGFzayBcdTY3MkFcdTUzRDdcdTc0MDY6ICR7c2VuZFIuc2xpY2UoMCwgODApfWBdO1xyXG4gICAgICAvLyBmYWtlIGhvc3QgZWNobyBcdTU2REVcdTY3NjVcdTU0MEVcdTdFQ0YgUmVhY3QgXHU2RTMyXHU2N0QzKFx1NzUyOFx1NjIzN1x1NkQ4OFx1NjA2RiArIFx1NTJBOVx1NjI0QiBlY2hvIFx1NTNDQ1x1OERFRlx1NUY4NClcclxuICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHIyKSA9PiBzZXRUaW1lb3V0KHIyLCAzXzAwMCkpO1xyXG4gICAgICBjb25zdCBwcm9iZSA9IChhd2FpdCBqcyhgSlNPTi5zdHJpbmdpZnkoe1xyXG4gICAgICAgIHhzc0ZsYWc6IHR5cGVvZiB3aW5kb3cuX194c3MsXHJcbiAgICAgICAgaW1nQ291bnQ6IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ2ltZ1tzcmM9XCJ4XCJdJykubGVuZ3RoLFxyXG4gICAgICAgIHNjcmlwdFJhbjogZG9jdW1lbnQuYm9keS5pbm5lclRleHQuaW5kZXhPZignd2luZG93Ll9feHNzPTInKSA+PSAwXHJcbiAgICAgIH0pYCkpIGFzIHN0cmluZztcclxuICAgICAgY29uc3QgcCA9IEpTT04ucGFyc2UocHJvYmUpIGFzIHsgeHNzRmxhZzogc3RyaW5nOyBpbWdDb3VudDogbnVtYmVyOyBzY3JpcHRSYW46IGJvb2xlYW4gfTtcclxuICAgICAgcmV0dXJuIFtwLnhzc0ZsYWcgPT09ICd1bmRlZmluZWQnICYmIHAuaW1nQ291bnQgPT09IDAsIGB4c3NGbGFnPSR7cC54c3NGbGFnfSBpbWc9JHtwLmltZ0NvdW50fWBdO1xyXG4gICAgfSk7XHJcblxyXG4gICAgbGV0IGZhaWxlZCA9IDA7XHJcbiAgICBmb3IgKGNvbnN0IFtuYW1lLCBvaywgZGV0YWlsXSBvZiByZXN1bHRzKSB7XHJcbiAgICAgIGNvbnNvbGUubG9nKGBTRUNVUklUWS1URVNUICR7b2sgPyAnUEFTUycgOiAnRkFJTCd9IHwgJHtuYW1lfSB8ICR7cmVkYWN0KGRldGFpbCl9YCk7XHJcbiAgICAgIGlmICghb2spIGZhaWxlZCArPSAxO1xyXG4gICAgfVxyXG4gICAgY29uc29sZS5sb2coYFNFQ1VSSVRZLVRFU1QgU1VNTUFSWSBwYXNzPSR7cmVzdWx0cy5sZW5ndGggLSBmYWlsZWR9LyR7cmVzdWx0cy5sZW5ndGh9YCk7XHJcbiAgICBhcHAuZXhpdChmYWlsZWQgPT09IDAgPyAwIDogMSk7XHJcbiAgfVxyXG5cclxuICAvLyBcdTkwMDBcdTUxRkE6XHU0RjE4XHU5NkM1XHU1MDVDXHU2QjYyXHU4MUVBXHU1REYxIHNwYXduIFx1NzY4NCBob3N0KHNodXRkb3duIFx1N0FFRlx1NzBCOSBcdTIxOTIgXHU1MTVDXHU1RTk1XHU1M0VBIGtpbGwgXHU4MUVBXHU1REYxXHU3Njg0XHU1M0U1XHU2N0M0KVxyXG4gIGFwcC5vbignYmVmb3JlLXF1aXQnLCAoZSkgPT4ge1xyXG4gICAgaWYgKHN1cGVydmlzb3IgIT09IG51bGwgJiYgc3VwZXJ2aXNvci5zdGF0ZSAhPT0gJ3N0b3BwZWQnKSB7XHJcbiAgICAgIGUucHJldmVudERlZmF1bHQoKTtcclxuICAgICAgc3NlQWJvcnQ/LmFib3J0KCk7XHJcbiAgICAgIHZvaWQgc3VwZXJ2aXNvci5zdG9wKCkuZmluYWxseSgoKSA9PiBhcHAucXVpdCgpKTtcclxuICAgIH1cclxuICB9KTtcclxuICBhcHAub24oJ3dpbmRvdy1hbGwtY2xvc2VkJywgKCkgPT4ge1xyXG4gICAgaWYgKHByb2Nlc3MucGxhdGZvcm0gIT09ICdkYXJ3aW4nKSBhcHAucXVpdCgpO1xyXG4gIH0pO1xyXG59XHJcbiIsICIvKipcclxuICogRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yIFx1MjAxNCBobWhhcm5lc3MgaG9zdCBcdThGREJcdTdBMEJcdTc2ODRcdTc1MUZcdTU0N0RcdTU0NjhcdTY3MUZcdTcyQjZcdTYwMDFcdTY3M0EoQURSLTAwMylcdTMwMDJcclxuICpcclxuICogXHU1Qjg5XHU1MTY4XHU0RTBEXHU1M0Q4XHU5MUNGOlxyXG4gKiAgLSBcdTUzRUFcdTdFRDFcdTVCOUEvXHU2M0EyXHU2RDRCIDEyNy4wLjAuMTtob3N0IFx1NEY3Rlx1NzUyOFx1NjRDRFx1NEY1Q1x1N0NGQlx1N0VERlx1NTIwNlx1OTE0RFx1N0FFRlx1NTNFMyhwb3J0IDApLFx1NUI5RVx1OTY0NVx1N0FFRlx1NTNFM1xyXG4gKiAgICBcdTc1MzEgaG9zdCBcdTc2ODQgc3Rkb3V0IFx1NUYxNVx1NUJGQ1x1ODg0Q1x1NTZERVx1NEYyMChIb3N0UmVhZHlMaW5lKVx1MzAwMlxyXG4gKiAgLSBcdTlBRDhcdTcxQjUgdG9rZW4gXHU1M0VBXHU5MDFBXHU4RkM3XHU1QjUwXHU4RkRCXHU3QTBCXHU3M0FGXHU1ODgzXHU1M0Q4XHU5MUNGXHU0RjIwXHU5MDEyLFx1N0VERFx1NEUwRFx1OEZEQiBVUkwvXHU2NUU1XHU1RkQ3L0lQQyBcdTY2MEVcdTY1ODdcdThEMUZcdThGN0RcdTMwMDJcclxuICogIC0gXHU1M0VBXHU1MDVDXHU2QjYyXHU2NzJDIHN1cGVydmlzb3Igc3Bhd24gXHU3Njg0XHU4RkRCXHU3QTBCXHU1M0U1XHU2N0M0O1x1N0VERFx1NEUwRFx1NjMwOVx1OEZEQlx1N0EwQlx1NTQwRCBraWxsXHUzMDAyXHJcbiAqICAtIGhvc3QgY3Jhc2ggXHU1NDBFXHU2NzA5XHU5NjUwXHU5MUNEXHU1NDJGO1x1OTFDRFx1NTQyRlx1NEUwRFx1OTFDRFx1NjUzRVx1NEVGQlx1NEY1NVx1NzUyOFx1NjIzN1x1NTJBOFx1NEY1QyhcdTk3NUVcdTVFNDJcdTdCNDlcdTUyQThcdTRGNUNcdTc1MzFcdTc1MjhcdTYyMzdcdTc4NkVcdThCQTQpXHUzMDAyXHJcbiAqL1xyXG5pbXBvcnQgeyBzcGF3biwgdHlwZSBDaGlsZFByb2Nlc3MgfSBmcm9tICdub2RlOmNoaWxkX3Byb2Nlc3MnO1xyXG5pbXBvcnQgeyBjcmVhdGVJbnRlcmZhY2UgfSBmcm9tICdub2RlOnJlYWRsaW5lJztcclxuaW1wb3J0IHsgcmFuZG9tQnl0ZXMgfSBmcm9tICdub2RlOmNyeXB0byc7XHJcbmltcG9ydCB7IGRlc2t0b3BFcnJvciwgaXNEZXNrdG9wRXJyb3IsIHR5cGUgRGVza3RvcEVycm9yIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyc7XHJcblxyXG5leHBvcnQgdHlwZSBIb3N0U3RhdGUgPVxyXG4gIHwgJ3N0b3BwZWQnXHJcbiAgfCAnc3RhcnRpbmcnXHJcbiAgfCAncmVhZHknXHJcbiAgfCAnZGlzY29ubmVjdGVkJ1xyXG4gIHwgJ3Jlc3RhcnRpbmcnXHJcbiAgfCAnc3RvcHBpbmcnXHJcbiAgfCAnZmFpbGVkJztcclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgSG9zdFNwZWMge1xyXG4gIC8qKiBcdTUzRUZcdTYyNjdcdTg4NENcdTY1ODdcdTRFRjYoXHU5MDFBXHU1RTM4IHByb2Nlc3MuZXhlY1BhdGgpXHUzMDAyICovXHJcbiAgY29tbWFuZDogc3RyaW5nO1xyXG4gIGFyZ3M6IHN0cmluZ1tdO1xyXG4gIGN3ZD86IHN0cmluZztcclxuICAvKiogXHU5ODlEXHU1OTE2XHU3M0FGXHU1ODgzXHU1M0Q4XHU5MUNGKFx1NEYxQVx1NEUwRSBwcm9jZXNzLmVudiBcdTU0MDhcdTVFNzYpXHUzMDAyICovXHJcbiAgZW52PzogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcclxufVxyXG5cclxuZXhwb3J0IGludGVyZmFjZSBTdXBlcnZpc29yT3B0aW9ucyB7XHJcbiAgLyoqIFx1NjcxRlx1NjcxQiBob3N0IFx1NjgyMVx1OUE4Q1x1NzY4NCBiZWFyZXIgdG9rZW47XHU0RTBEXHU0RjIwXHU1MjE5XHU2QkNGXHU2QjIxIHN0YXJ0IFx1NzUxRlx1NjIxMFx1OUFEOFx1NzFCNVx1OTY4Rlx1NjczQVx1NTAzQ1x1MzAwMiAqL1xyXG4gIHRva2VuPzogc3RyaW5nO1xyXG4gIG1heFJlc3RhcnRzPzogbnVtYmVyO1xyXG4gIHN0YXJ0VGltZW91dE1zPzogbnVtYmVyO1xyXG4gIGdyYWNlZnVsU2h1dGRvd25Ncz86IG51bWJlcjtcclxuICBvblN0YXRlQ2hhbmdlPyhzdGF0ZTogSG9zdFN0YXRlLCBpbmZvOiB7IHJlc3RhcnRDb3VudDogbnVtYmVyOyBsYXN0RXJyb3I/OiBzdHJpbmcgfSk6IHZvaWQ7XHJcbiAgLyoqIFx1NkJDRlx1NkIyMSBob3N0IFx1NUMzMVx1N0VFQShcdTU0MkIgY3Jhc2ggXHU4MUVBXHU2MTA4XHU1NDBFXHU3Njg0XHU5MUNEXHU1NDJGKVx1OTBGRFx1NEYxQVx1ODlFNlx1NTNEMSxcdTY0M0FcdTVFMjZcdTdBRUZcdTcwQjkoXHU1NDJCIHRva2VuLFxyXG4gICAqICBcdTRFQzVcdTRGOUJcdTU0MENcdTRGRTFcdTRFRkJcdTU3REZcdTc2ODRcdTVCQkZcdTRFM0JcdThGREJcdTdBMEJcdTkxQ0RcdTVFRkFcdTY4NjVcdTVCQTJcdTYyMzdcdTdBRUY7XHU0RTBEXHU4OTgxXHU4REU4XHU4RkRCIHJlbmRlcmVyKVx1MzAwMiAqL1xyXG4gIG9uUmVhZHk/KGVuZHBvaW50OiBIb3N0RW5kcG9pbnQpOiB2b2lkO1xyXG59XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIEhvc3RFbmRwb2ludCB7XHJcbiAgcG9ydDogbnVtYmVyO1xyXG4gIHZlcnNpb246IHN0cmluZztcclxuICB0b2tlbjogc3RyaW5nO1xyXG59XHJcblxyXG4vKiogSG9zdFJlYWR5TGluZSBcdTc2ODRcdTdDN0JcdTU3OEJcdTVCODhcdTUzNkJcdTRFQ0UgY29udHJhY3RzIFx1NUYxNVx1NTE2NSxcdTkwN0ZcdTUxNERcdTUzQ0NcdTVCOUVcdTczQjBcdTMwMDIgKi9cclxuaW1wb3J0IHsgaXNIb3N0UmVhZHlMaW5lIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyc7XHJcblxyXG4vLyA0NXM6aG1oYXJuZXNzIFx1NzcxRlx1NUI5RVx1NTE2NVx1NTNFM1x1N0VDRiB0c3ggXHU1MUI3XHU3RjE2XHU4QkQxXHU2NTc0XHU1OTU3IENMSSxcdTY3M0FcdTU2NjhcdTlBRDhcdThEMUZcdThGN0RcdTY1RjZcdTUzRUZcdThEODUgMjBzXHJcbi8vICgyMDI2LTEwLTExIFx1OEZERVx1N0VFRFx1OUE4Q1x1NjUzNlx1NEUyRFx1OTVGNFx1NkI0N1x1NjAyNyBIT1NUX05PVF9SRUFEWSBcdTc2ODRcdTY4MzlcdTU2RTA7XHU3QTdBXHU5NUYyXHU1QjlFXHU2RDRCIDZzKVx1MzAwMlxyXG5jb25zdCBERUZBVUxUX1NUQVJUX1RJTUVPVVRfTVMgPSA0NV8wMDA7XHJcbmNvbnN0IERFRkFVTFRfTUFYX1JFU1RBUlRTID0gMztcclxuY29uc3QgREVGQVVMVF9HUkFDRUZVTF9NUyA9IDVfMDAwO1xyXG5cclxuZXhwb3J0IGNsYXNzIERlc2t0b3BSdW50aW1lU3VwZXJ2aXNvciB7XHJcbiAgcHJpdmF0ZSBjaGlsZDogQ2hpbGRQcm9jZXNzIHwgbnVsbCA9IG51bGw7XHJcbiAgcHJpdmF0ZSBfc3RhdGU6IEhvc3RTdGF0ZSA9ICdzdG9wcGVkJztcclxuICBwcml2YXRlIHJlc3RhcnRDb3VudCA9IDA7XHJcbiAgcHJpdmF0ZSBsYXN0RXJyb3IgPSAnJztcclxuICBwcml2YXRlIHN0b3BwaW5nID0gZmFsc2U7XHJcbiAgcHJpdmF0ZSByZWFkb25seSB0b2tlbjogc3RyaW5nO1xyXG4gIHByaXZhdGUgcmVhZG9ubHkgb3B0czogUmVxdWlyZWQ8UGljazxTdXBlcnZpc29yT3B0aW9ucywgJ21heFJlc3RhcnRzJyB8ICdzdGFydFRpbWVvdXRNcycgfCAnZ3JhY2VmdWxTaHV0ZG93bk1zJz4+ICYgU3VwZXJ2aXNvck9wdGlvbnM7XHJcbiAgcHJpdmF0ZSBleGl0V2FpdGVyczogQXJyYXk8KCkgPT4gdm9pZD4gPSBbXTtcclxuXHJcbiAgY29uc3RydWN0b3IoXHJcbiAgICBwcml2YXRlIHJlYWRvbmx5IHNwZWM6IEhvc3RTcGVjLFxyXG4gICAgb3B0czogU3VwZXJ2aXNvck9wdGlvbnMgPSB7fSxcclxuICApIHtcclxuICAgIHRoaXMudG9rZW4gPSBvcHRzLnRva2VuID8/IHJhbmRvbUJ5dGVzKDMyKS50b1N0cmluZygnYmFzZTY0dXJsJyk7XHJcbiAgICB0aGlzLm9wdHMgPSB7XHJcbiAgICAgIG1heFJlc3RhcnRzOiBvcHRzLm1heFJlc3RhcnRzID8/IERFRkFVTFRfTUFYX1JFU1RBUlRTLFxyXG4gICAgICBzdGFydFRpbWVvdXRNczogb3B0cy5zdGFydFRpbWVvdXRNcyA/PyBERUZBVUxUX1NUQVJUX1RJTUVPVVRfTVMsXHJcbiAgICAgIGdyYWNlZnVsU2h1dGRvd25Nczogb3B0cy5ncmFjZWZ1bFNodXRkb3duTXMgPz8gREVGQVVMVF9HUkFDRUZVTF9NUyxcclxuICAgICAgLi4ub3B0cyxcclxuICAgIH07XHJcbiAgfVxyXG5cclxuICBnZXQgc3RhdGUoKTogSG9zdFN0YXRlIHtcclxuICAgIHJldHVybiB0aGlzLl9zdGF0ZTtcclxuICB9XHJcblxyXG4gIGdldCByZXN0YXJ0c1VzZWQoKTogbnVtYmVyIHtcclxuICAgIHJldHVybiB0aGlzLnJlc3RhcnRDb3VudDtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgc2V0U3RhdGUoczogSG9zdFN0YXRlLCBlcnI/OiBzdHJpbmcpOiB2b2lkIHtcclxuICAgIHRoaXMuX3N0YXRlID0gcztcclxuICAgIGlmIChlcnIgIT09IHVuZGVmaW5lZCkgdGhpcy5sYXN0RXJyb3IgPSBlcnI7XHJcbiAgICBjb25zdCBpbmZvOiB7IHJlc3RhcnRDb3VudDogbnVtYmVyOyBsYXN0RXJyb3I/OiBzdHJpbmcgfSA9IHsgcmVzdGFydENvdW50OiB0aGlzLnJlc3RhcnRDb3VudCB9O1xyXG4gICAgaWYgKHRoaXMubGFzdEVycm9yICE9PSAnJykgaW5mby5sYXN0RXJyb3IgPSB0aGlzLmxhc3RFcnJvcjtcclxuICAgIHRoaXMub3B0cy5vblN0YXRlQ2hhbmdlPy4ocywgaW5mbyk7XHJcbiAgfVxyXG5cclxuICAvKiogXHU1NDJGXHU1MkE4IGhvc3QgXHU1RTc2XHU3QjQ5XHU1Rjg1IHJlYWR5KFx1NUYxNVx1NUJGQ1x1ODg0QyArIFx1NUUyNiB0b2tlbiBcdTc2ODRcdTUwNjVcdTVFQjdcdTYzQTJcdTZENEIpXHUzMDAyICovXHJcbiAgYXN5bmMgc3RhcnQoKTogUHJvbWlzZTxIb3N0RW5kcG9pbnQ+IHtcclxuICAgIGlmICh0aGlzLl9zdGF0ZSA9PT0gJ3JlYWR5JyB8fCB0aGlzLl9zdGF0ZSA9PT0gJ3N0YXJ0aW5nJykge1xyXG4gICAgICB0aHJvdyBkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYHN1cGVydmlzb3IgYWxyZWFkeSAke3RoaXMuX3N0YXRlfWApO1xyXG4gICAgfVxyXG4gICAgdGhpcy5yZXN0YXJ0Q291bnQgPSAwO1xyXG4gICAgdGhpcy5zdG9wcGluZyA9IGZhbHNlO1xyXG4gICAgcmV0dXJuIHRoaXMubGF1bmNoKCk7XHJcbiAgfVxyXG5cclxuICBwcml2YXRlIGFzeW5jIGxhdW5jaCgpOiBQcm9taXNlPEhvc3RFbmRwb2ludD4ge1xyXG4gICAgdGhpcy5zZXRTdGF0ZSgnc3RhcnRpbmcnKTtcclxuICAgIGNvbnN0IGNoaWxkID0gc3Bhd24odGhpcy5zcGVjLmNvbW1hbmQsIHRoaXMuc3BlYy5hcmdzLCB7XHJcbiAgICAgIGN3ZDogdGhpcy5zcGVjLmN3ZCxcclxuICAgICAgZW52OiB7XHJcbiAgICAgICAgLi4ucHJvY2Vzcy5lbnYsXHJcbiAgICAgICAgLi4udGhpcy5zcGVjLmVudixcclxuICAgICAgICBITUhfREVTS1RPUF9UT0tFTjogdGhpcy50b2tlbixcclxuICAgICAgfSxcclxuICAgICAgc3RkaW86IFsnaWdub3JlJywgJ3BpcGUnLCAncGlwZSddLFxyXG4gICAgICB3aW5kb3dzSGlkZTogdHJ1ZSxcclxuICAgIH0pO1xyXG4gICAgdGhpcy5jaGlsZCA9IGNoaWxkO1xyXG5cclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IGVuZHBvaW50ID0gYXdhaXQgdGhpcy5hd2FpdFJlYWR5KGNoaWxkKTtcclxuICAgICAgdGhpcy5jdXJyZW50RW5kcG9pbnQgPSB7IHBvcnQ6IGVuZHBvaW50LnBvcnQsIHZlcnNpb246IGVuZHBvaW50LnZlcnNpb24gfTtcclxuICAgICAgdGhpcy5zZXRTdGF0ZSgncmVhZHknKTtcclxuICAgICAgdGhpcy5vcHRzLm9uUmVhZHk/LihlbmRwb2ludCk7XHJcbiAgICAgIC8vIHJlYWR5IFx1NEU0Qlx1NTQwRVx1OEZEQlx1N0EwQlx1NkI3Qlx1NEVBMSA9IFx1NjEwRlx1NTkxNlx1OTAwMFx1NTFGQSBcdTIxOTIgXHU2NzA5XHU5NjUwXHU5MUNEXHU1NDJGXHJcbiAgICAgIGNoaWxkLm9uY2UoJ2V4aXQnLCAoKSA9PiB7XHJcbiAgICAgICAgdGhpcy5leGl0V2FpdGVycy5mb3JFYWNoKCh3KSA9PiB3KCkpO1xyXG4gICAgICAgIHRoaXMuZXhpdFdhaXRlcnMgPSBbXTtcclxuICAgICAgICB0aGlzLm9uVW5leHBlY3RlZEV4aXQoKTtcclxuICAgICAgfSk7XHJcbiAgICAgIHJldHVybiBlbmRwb2ludDtcclxuICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICBpZiAoIWNoaWxkLmtpbGxlZCkgY2hpbGQua2lsbCgpO1xyXG4gICAgICBpZiAodGhpcy5jaGlsZCA9PT0gY2hpbGQpIHRoaXMuY2hpbGQgPSBudWxsO1xyXG4gICAgICB0aHJvdyBlcnI7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvKiogXHU0RUNFIHN0ZG91dCBcdTYyN0UgSG9zdFJlYWR5TGluZSxcdTcxMzZcdTU0MEVcdTUwNjVcdTVFQjdcdTYzQTJcdTZENEJcdTMwMDIgKi9cclxuICBwcml2YXRlIGF3YWl0UmVhZHkoY2hpbGQ6IENoaWxkUHJvY2Vzcyk6IFByb21pc2U8SG9zdEVuZHBvaW50PiB7XHJcbiAgICByZXR1cm4gbmV3IFByb21pc2U8SG9zdEVuZHBvaW50PigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XHJcbiAgICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XHJcbiAgICAgICAgcmVqZWN0KGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgaG9zdCBkaWQgbm90IHNpZ25hbCByZWFkeSB3aXRoaW4gJHt0aGlzLm9wdHMuc3RhcnRUaW1lb3V0TXN9bXNgLCB7IHJldHJ5YWJsZTogdHJ1ZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcclxuICAgICAgfSwgdGhpcy5vcHRzLnN0YXJ0VGltZW91dE1zKTtcclxuXHJcbiAgICAgIGNvbnN0IGRvbmUgPSAoZm46ICgpID0+IHZvaWQpOiB2b2lkID0+IHtcclxuICAgICAgICBjbGVhclRpbWVvdXQodGltZXIpO1xyXG4gICAgICAgIGZuKCk7XHJcbiAgICAgIH07XHJcblxyXG4gICAgICBpZiAoIWNoaWxkLnN0ZG91dCkge1xyXG4gICAgICAgIGRvbmUoKCkgPT4gcmVqZWN0KGRlc2t0b3BFcnJvcignUlVOVElNRV9DUkFTSEVEJywgJ2hvc3Qgc3Bhd25lZCB3aXRob3V0IHN0ZG91dCBwaXBlJykpKTtcclxuICAgICAgICByZXR1cm47XHJcbiAgICAgIH1cclxuXHJcbiAgICAgIGNvbnN0IHJsID0gY3JlYXRlSW50ZXJmYWNlKHsgaW5wdXQ6IGNoaWxkLnN0ZG91dCB9KTtcclxuICAgICAgY29uc3Qgb25MaW5lID0gKGxpbmU6IHN0cmluZyk6IHZvaWQgPT4ge1xyXG4gICAgICAgIGxldCBwYXJzZWQ6IHVua25vd247XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgIHBhcnNlZCA9IEpTT04ucGFyc2UobGluZSk7XHJcbiAgICAgICAgfSBjYXRjaCB7XHJcbiAgICAgICAgICByZXR1cm47IC8vIGhvc3QgXHU3Njg0XHU2NjZFXHU5MDFBXHU2NUU1XHU1RkQ3XHU4ODRDLFx1NUZGRFx1NzU2NVxyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoaXNIb3N0UmVhZHlMaW5lKHBhcnNlZCkpIHtcclxuICAgICAgICAgIHJsLmNsb3NlKCk7XHJcbiAgICAgICAgICB2b2lkIHRoaXMucHJvYmVBbmRSZW1lbWJlcihwYXJzZWQucG9ydCwgcGFyc2VkLnZlcnNpb24pXHJcbiAgICAgICAgICAgIC50aGVuKChlbmRwb2ludCkgPT4gZG9uZSgoKSA9PiByZXNvbHZlKGVuZHBvaW50KSkpXHJcbiAgICAgICAgICAgIC5jYXRjaCgoZXJyOiB1bmtub3duKSA9PiBkb25lKCgpID0+IHJlamVjdChlcnIpKSk7XHJcbiAgICAgICAgfVxyXG4gICAgICB9O1xyXG4gICAgICBybC5vbignbGluZScsIG9uTGluZSk7XHJcblxyXG4gICAgICBjaGlsZC5vbmNlKCdleGl0JywgKGNvZGUpID0+IHtcclxuICAgICAgICBkb25lKCgpID0+IHJlamVjdChkZXNrdG9wRXJyb3IoJ1JVTlRJTUVfQ1JBU0hFRCcsIGBob3N0IGV4aXRlZCBkdXJpbmcgc3RhcnR1cCAoY29kZSAke2NvZGUgPz8gJ251bGwnfSlgLCB7IHJldHJ5YWJsZTogZmFsc2UsIHJlY292ZXJ5QWN0aW9uOiAnT1BFTl9MT0dTJyB9KSkpO1xyXG4gICAgICB9KTtcclxuICAgIH0pO1xyXG4gIH1cclxuXHJcbiAgLyoqIFx1NUUyNiB0b2tlbiBcdTc2ODRcdTUwNjVcdTVFQjdcdTYzQTJcdTZENEI6R0VUIC9hcGkvc3RhdGVcdTMwMDI0MDEgXHUyMTkyIEFVVEhfRkFJTEVEKFx1NEUwRFx1OTFDRFx1OEJENSlcdTMwMDIgKi9cclxuICBwcml2YXRlIGFzeW5jIHByb2JlKHBvcnQ6IG51bWJlciwgdmVyc2lvbjogc3RyaW5nKTogUHJvbWlzZTxIb3N0RW5kcG9pbnQ+IHtcclxuICAgIGxldCByZXM6IFJlc3BvbnNlO1xyXG4gICAgdHJ5IHtcclxuICAgICAgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9hcGkvc3RhdGVgLCB7XHJcbiAgICAgICAgaGVhZGVyczogeyAneC1obWgta2V5JzogdGhpcy50b2tlbiB9LFxyXG4gICAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCgzXzAwMCksXHJcbiAgICAgIH0pO1xyXG4gICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgIHRocm93IGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgaGVhbHRoIHByb2JlIGZhaWxlZDogJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxNjApfWAsIHsgcmV0cnlhYmxlOiB0cnVlIH0pO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSB8fCByZXMuc3RhdHVzID09PSA0MDMpIHtcclxuICAgICAgdGhyb3cgZGVza3RvcEVycm9yKCdBVVRIX0ZBSUxFRCcsIGBob3N0IHJlamVjdGVkIHRoZSBzZXNzaW9uIHRva2VuIChIVFRQICR7cmVzLnN0YXR1c30pYCwgeyByZXRyeWFibGU6IGZhbHNlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSk7XHJcbiAgICB9XHJcbiAgICBpZiAoIXJlcy5vaykge1xyXG4gICAgICB0aHJvdyBkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYGhlYWx0aCBwcm9iZSBIVFRQICR7cmVzLnN0YXR1c31gLCB7IHJldHJ5YWJsZTogdHJ1ZSB9KTtcclxuICAgIH1cclxuICAgIHJldHVybiB7IHBvcnQsIHZlcnNpb24sIHRva2VuOiB0aGlzLnRva2VuIH07XHJcbiAgfVxyXG5cclxuICBwcml2YXRlIG9uVW5leHBlY3RlZEV4aXQoKTogdm9pZCB7XHJcbiAgICBpZiAodGhpcy5zdG9wcGluZyB8fCB0aGlzLl9zdGF0ZSA9PT0gJ3N0b3BwZWQnIHx8IHRoaXMuX3N0YXRlID09PSAnc3RvcHBpbmcnKSByZXR1cm47XHJcbiAgICB0aGlzLmNoaWxkID0gbnVsbDtcclxuICAgIGlmICh0aGlzLnJlc3RhcnRDb3VudCA8IHRoaXMub3B0cy5tYXhSZXN0YXJ0cykge1xyXG4gICAgICB0aGlzLnJlc3RhcnRDb3VudCArPSAxO1xyXG4gICAgICB0aGlzLnNldFN0YXRlKCdyZXN0YXJ0aW5nJyk7XHJcbiAgICAgIHZvaWQgdGhpcy5sYXVuY2goKS5jYXRjaCgoKSA9PiB7XHJcbiAgICAgICAgLy8gXHU5MUNEXHU1NDJGXHU1QzFEXHU4QkQ1XHU1OTMxXHU4RDI1KFx1NTQyRlx1NTJBOFx1NTM3M1x1NUQyOS9cdThEODVcdTY1RjYvXHU2MkQyXHU4QkE0KTpcdTdFRTdcdTdFRURcdTZEODhcdTgwMTdcdTkxQ0RcdTU0MkZcdTZCMjFcdTY1NzBcdTc2RjRcdTUyMzBcdTY1M0VcdTVGMDNcclxuICAgICAgICB0aGlzLnJldHJ5T3JGYWlsKCk7XHJcbiAgICAgIH0pO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgdGhpcy5zZXRTdGF0ZSgnZmFpbGVkJywgYGhvc3QgZXhpdGVkIHVuZXhwZWN0ZWRseSAke3RoaXMucmVzdGFydENvdW50ICsgMX0gdGltZXM7IGdpdmluZyB1cGApO1xyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgcHJpdmF0ZSByZXRyeU9yRmFpbCgpOiB2b2lkIHtcclxuICAgIGlmICh0aGlzLnN0b3BwaW5nIHx8IHRoaXMuX3N0YXRlID09PSAnc3RvcHBlZCcgfHwgdGhpcy5fc3RhdGUgPT09ICdzdG9wcGluZycpIHJldHVybjtcclxuICAgIGlmICh0aGlzLnJlc3RhcnRDb3VudCA8IHRoaXMub3B0cy5tYXhSZXN0YXJ0cykge1xyXG4gICAgICB0aGlzLnJlc3RhcnRDb3VudCArPSAxO1xyXG4gICAgICB0aGlzLnNldFN0YXRlKCdyZXN0YXJ0aW5nJyk7XHJcbiAgICAgIHZvaWQgdGhpcy5sYXVuY2goKS5jYXRjaCgoKSA9PiB0aGlzLnJldHJ5T3JGYWlsKCkpO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgdGhpcy5zZXRTdGF0ZSgnZmFpbGVkJywgYGhvc3QgZmFpbGVkIHRvIHN0YXkgdXAgYWZ0ZXIgJHt0aGlzLnJlc3RhcnRDb3VudH0gcmVzdGFydCBhdHRlbXB0c2ApO1xyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgLyoqIFx1NEYxOFx1OTZDNVx1NTA1Q1x1NkI2MjpcdTUxNDggSFRUUCBzaHV0ZG93bixcdThEODVcdTY1RjZcdTYyNERcdTVCRjlcdTY3MkNcdThGREJcdTdBMEJcdTUzRTVcdTY3QzQga2lsbFx1MzAwMiAqL1xyXG4gIGFzeW5jIHN0b3AoKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICB0aGlzLnN0b3BwaW5nID0gdHJ1ZTtcclxuICAgIGlmICh0aGlzLl9zdGF0ZSA9PT0gJ3N0b3BwZWQnKSByZXR1cm47XHJcbiAgICB0aGlzLnNldFN0YXRlKCdzdG9wcGluZycpO1xyXG4gICAgY29uc3QgY2hpbGQgPSB0aGlzLmNoaWxkO1xyXG4gICAgdGhpcy5jaGlsZCA9IG51bGw7XHJcbiAgICB0aGlzLmN1cnJlbnRFbmRwb2ludCA9IG51bGw7XHJcbiAgICBpZiAoIWNoaWxkKSB7XHJcbiAgICAgIHRoaXMuc2V0U3RhdGUoJ3N0b3BwZWQnKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3QgZXhpdGVkID0gbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUpID0+IHtcclxuICAgICAgaWYgKGNoaWxkLmV4aXRDb2RlICE9PSBudWxsIHx8IGNoaWxkLnNpZ25hbENvZGUgIT09IG51bGwpIHJlc29sdmUoKTtcclxuICAgICAgZWxzZSB7XHJcbiAgICAgICAgY29uc3QgdyA9ICgpOiB2b2lkID0+IHJlc29sdmUoKTtcclxuICAgICAgICB0aGlzLmV4aXRXYWl0ZXJzLnB1c2godyk7XHJcbiAgICAgICAgY2hpbGQub25jZSgnZXhpdCcsIHcpO1xyXG4gICAgICB9XHJcbiAgICB9KTtcclxuICAgIC8vIFx1NURGMlx1NzdFNVx1N0FFRlx1NTNFM1x1NjI0RFx1NUMxRFx1OEJENSBIVFRQIFx1NEYxOFx1OTZDNVx1NTE3M1x1OTVFRDtcdTY3MkFcdTc3RTVcdTdBRUZcdTUzRTNcdTc2RjRcdTYzQTVcdThENzAga2lsbCBcdTUxNUNcdTVFOTVcclxuICAgIGlmICh0aGlzLmxhc3RFbmRwb2ludCAhPT0gbnVsbCkge1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7dGhpcy5sYXN0RW5kcG9pbnR9L2FwaS9kZXNrdG9wL3NodXRkb3duYCwge1xyXG4gICAgICAgICAgbWV0aG9kOiAnUE9TVCcsXHJcbiAgICAgICAgICBoZWFkZXJzOiB7ICd4LWhtaC1rZXknOiB0aGlzLnRva2VuIH0sXHJcbiAgICAgICAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoMV8wMDApLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICB9IGNhdGNoIHtcclxuICAgICAgICAvLyBob3N0IFx1NURGMlx1NkI3Qlx1NjIxNlx1NEUwRFx1NUU5NFx1N0I1NDpcdThENzAga2lsbCBcdTUxNUNcdTVFOTVcclxuICAgICAgfVxyXG4gICAgfVxyXG4gICAgY29uc3QgZ3JhY2VmdWwgPSBhd2FpdCBQcm9taXNlLnJhY2UoW1xyXG4gICAgICBleGl0ZWQudGhlbigoKSA9PiB0cnVlKSxcclxuICAgICAgbmV3IFByb21pc2U8Ym9vbGVhbj4oKHJlc29sdmUpID0+IHNldFRpbWVvdXQoKCkgPT4gcmVzb2x2ZShmYWxzZSksIHRoaXMub3B0cy5ncmFjZWZ1bFNodXRkb3duTXMpKSxcclxuICAgIF0pO1xyXG4gICAgaWYgKCFncmFjZWZ1bCAmJiBjaGlsZC5leGl0Q29kZSA9PT0gbnVsbCAmJiBjaGlsZC5zaWduYWxDb2RlID09PSBudWxsKSB7XHJcbiAgICAgIGNoaWxkLmtpbGwoKTsgLy8gXHU1M0VBXHU2NzQwXHU4MUVBXHU1REYxXHU2MzAxXHU2NzA5XHU3Njg0XHU1M0U1XHU2N0M0LFx1N0VERFx1NEUwRFx1NjMwOVx1OEZEQlx1N0EwQlx1NTQwRFxyXG4gICAgfVxyXG4gICAgYXdhaXQgZXhpdGVkLmNhdGNoKCgpID0+IHVuZGVmaW5lZCk7XHJcbiAgICB0aGlzLnNldFN0YXRlKCdzdG9wcGVkJyk7XHJcbiAgfVxyXG5cclxuICBwcml2YXRlIGxhc3RFbmRwb2ludDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XHJcbiAgcHJpdmF0ZSBjdXJyZW50RW5kcG9pbnQ6IHsgcG9ydDogbnVtYmVyOyB2ZXJzaW9uOiBzdHJpbmcgfSB8IG51bGwgPSBudWxsO1xyXG5cclxuICAvKiogXHU1RjUzXHU1MjREIGhvc3QgXHU3QUVGXHU3MEI5KHJlYWR5IFx1NTQwRVx1NjcwOVx1NTAzQztcdTRFMERcdTU0MkIgdG9rZW4pXHUzMDAyICovXHJcbiAgZ2V0IGVuZHBvaW50KCk6IHsgcG9ydDogbnVtYmVyOyB2ZXJzaW9uOiBzdHJpbmcgfSB8IG51bGwge1xyXG4gICAgcmV0dXJuIHRoaXMuY3VycmVudEVuZHBvaW50O1xyXG4gIH1cclxuXHJcbiAgLyoqIFx1NjNBMlx1NkQ0Qlx1NjIxMFx1NTI5Rlx1NTQwRVx1OEJCMFx1NEY0Rlx1N0FFRlx1NTNFMyxcdTRGOUIgc3RvcCgpIFx1NzY4NFx1NEYxOFx1OTZDNVx1NTE3M1x1OTVFRFx1NEY3Rlx1NzUyOFx1MzAwMiAqL1xyXG4gIHByaXZhdGUgYXN5bmMgcHJvYmVBbmRSZW1lbWJlcihwb3J0OiBudW1iZXIsIHZlcnNpb246IHN0cmluZyk6IFByb21pc2U8SG9zdEVuZHBvaW50PiB7XHJcbiAgICBjb25zdCBlcCA9IGF3YWl0IHRoaXMucHJvYmUocG9ydCwgdmVyc2lvbik7XHJcbiAgICB0aGlzLmxhc3RFbmRwb2ludCA9IGVwLnBvcnQ7XHJcbiAgICByZXR1cm4gZXA7XHJcbiAgfVxyXG59XHJcblxyXG4vKiogXHU2MjhBXHU2NzJBXHU3N0U1XHU5NTE5XHU4QkVGXHU4OUM0XHU3RUE2XHU0RTNBIERlc2t0b3BFcnJvcihcdTVERjJcdTY2MkZcdTUyMTlcdTUzOUZcdTY4MzdcdThGRDRcdTU2REUpXHUzMDAyICovXHJcbmV4cG9ydCBmdW5jdGlvbiB0b0Rlc2t0b3BFcnJvcihlcnI6IHVua25vd24pOiBEZXNrdG9wRXJyb3Ige1xyXG4gIGlmIChpc0Rlc2t0b3BFcnJvcihlcnIpKSByZXR1cm4gZXJyO1xyXG4gIGNvbnN0IG1lc3NhZ2UgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XHJcbiAgcmV0dXJuIGRlc2t0b3BFcnJvcignUlVOVElNRV9DUkFTSEVEJywgbWVzc2FnZS5zbGljZSgwLCAzMDApLCB7IHJldHJ5YWJsZTogZmFsc2UgfSk7XHJcbn1cclxuIiwgIi8qKlxyXG4gKiBAaG1oLWRlc2t0b3AvY29udHJhY3RzIFx1MjAxNCBcdTRFOEJcdTRFRjZcdTRGRTFcdTVDMDEoXHU1RjAwXHU1M0QxXHU4QkExXHU1MjEyXHU2NTg3XHU2ODYzIDA0IFx1MDBBN1x1NEUwOSlcclxuICpcclxuICogXHU0RTAwXHU2NzYxIFVJIFx1NEU4Qlx1NEVGNlx1NzY4NFx1NTUyRlx1NEUwMFx1NUY2Mlx1NzJCNlx1MzAwMlx1NTI0RFx1N0FFRiByZWR1Y2VyIFx1NUZDNVx1OTg3Qlx1NjMwOSBzZXNzaW9uSWQvcnVuSWQvc2VxIFx1NTkwNFx1NzQwNjtcclxuICogXHU5MUNEXHU1OTBEIGV2ZW50SWQgXHU1RTQyXHU3QjQ5XHU0RTIyXHU1RjAzO3NlcSBcdTdGM0FcdTUzRTNcdTg5RTZcdTUzRDFcdTg4NjVcdTYyQzk7XHU5NzVFXHU1RTQyXHU3QjQ5XHU1MkE4XHU0RjVDXHU0RTBEXHU3NTMxIFNTRSBcdTgxRUFcdTUyQThcdTkxQ0RcdTUzRDFcdTMwMDJcclxuICovXHJcblxyXG5pbXBvcnQgdHlwZSB7IEFydGlmYWN0UmVmIH0gZnJvbSAnLi9kdG8udHMnO1xyXG5pbXBvcnQgdHlwZSB7IERlc2t0b3BFcnJvciB9IGZyb20gJy4vZXJyb3IudHMnO1xyXG5cclxuLyoqIFx1NEU4Qlx1NEVGNlx1NzlDRFx1N0M3QihcdTUyMjRcdTUyMkJcdTk1MkUpXHUzMDAyXHU2NUIwXHU1ODlFIGtpbmQgPSBzY2hlbWFWZXJzaW9uIFx1NTM0N1x1N0VBNyxcdTRFMERcdTUxNDFcdThCQjhcdTk3NTlcdTlFRDhcdTYyNjlcdTY3OUFcdTRFM0VcdTMwMDIgKi9cclxuZXhwb3J0IGNvbnN0IEVWRU5UX0tJTkRTID0gW1xyXG4gICdydW4uc3RhcnRlZCcsXHJcbiAgJ3BsYW4udXBkYXRlZCcsXHJcbiAgJ3Rvb2wuc3RhcnRlZCcsXHJcbiAgJ3Rvb2wuY29tcGxldGVkJyxcclxuICAnYXBwcm92YWwucmVxdWlyZWQnLFxyXG4gICd2ZXJpZmljYXRpb24udXBkYXRlZCcsXHJcbiAgJ2FydGlmYWN0LmNyZWF0ZWQnLFxyXG4gICdydW4uY29tcGxldGVkJyxcclxuICAncnVuLmZhaWxlZCcsXHJcbl0gYXMgY29uc3Q7XHJcblxyXG5leHBvcnQgdHlwZSBFdmVudEtpbmQgPSAodHlwZW9mIEVWRU5UX0tJTkRTKVtudW1iZXJdO1xyXG5cclxuZXhwb3J0IGNvbnN0IEVWRU5UX1NDSEVNQV9WRVJTSU9OID0gMTtcclxuZXhwb3J0IHR5cGUgRXZlbnRTY2hlbWFWZXJzaW9uID0gMTtcclxuXHJcbi8qKiBTU0UgXHU2RDQxXHU0RTBBXHU3Njg0XHU2QkNGXHU0RTAwXHU2NzYxXHU0RThCXHU0RUY2XHUzMDAyICovXHJcbmV4cG9ydCBpbnRlcmZhY2UgRXZlbnRFbnZlbG9wZTxUID0gdW5rbm93bj4ge1xyXG4gIHNjaGVtYVZlcnNpb246IEV2ZW50U2NoZW1hVmVyc2lvbjtcclxuICAvKiogXHU1MTY4XHU1QzQwXHU1NTJGXHU0RTAwO1x1OTFDRFx1OEZERS9cdTg4NjVcdTYyQzlcdTU0MEVcdTkxQ0RcdTU5MERcdTUxRkFcdTczQjBcdTY1RjZcdTYzQTVcdTY1MzZcdTY1QjlcdTVFNDJcdTdCNDlcdTRFMjJcdTVGMDNcdTMwMDIgKi9cclxuICBldmVudElkOiBzdHJpbmc7XHJcbiAgc2Vzc2lvbklkOiBzdHJpbmc7XHJcbiAgcnVuSWQ6IHN0cmluZztcclxuICAvKiogXHU0RjFBXHU4QkREXHU1MTg1XHU1MzU1XHU4QzAzXHU5MDEyXHU1ODlFO1x1N0YzQVx1NTNFM1x1NjEwRlx1NTQ3M1x1Nzc0MFx1NEUyMlx1NEU4Qlx1NEVGNixcdTk3MDBcdTg5ODFcdTg4NjVcdTYyQzlcdTMwMDIgKi9cclxuICBzZXE6IG51bWJlcjtcclxuICAvKiogUkZDMzMzOVx1MzAwMiAqL1xyXG4gIG9jY3VycmVkQXQ6IHN0cmluZztcclxuICBraW5kOiBFdmVudEtpbmQ7XHJcbiAgcGF5bG9hZDogVDtcclxufVxyXG5cclxuLyoqIHJ1bi5zdGFydGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXHJcbmV4cG9ydCBpbnRlcmZhY2UgUnVuU3RhcnRlZFBheWxvYWQge1xyXG4gIHRhc2s6IHN0cmluZztcclxuICBtb2RlOiAnYXNrJyB8ICdhdXRvJyB8ICd5b2xvJztcclxufVxyXG5cclxuLyoqIHBsYW4udXBkYXRlZCBcdTc2ODQgcGF5bG9hZChcdThCQTFcdTUyMTJcdTZCNjVcdTlBQTRcdTUyMTdcdTg4NjgsXHU2NzY1XHU4MUVBIHJ1bnRpbWUgXHU3Njg0XHU3RUQzXHU2Nzg0XHU1MzE2XHU4QkExXHU1MjEyLFx1NEUwRFx1NjYyRiBjaGFpbi1vZi10aG91Z2h0KVx1MzAwMiAqL1xyXG5leHBvcnQgaW50ZXJmYWNlIFBsYW5VcGRhdGVkUGF5bG9hZCB7XHJcbiAgc3RlcHM6IEFycmF5PHsgdGl0bGU6IHN0cmluZzsgc3RhdHVzOiAncGVuZGluZycgfCAnYWN0aXZlJyB8ICdkb25lJyB8ICdmYWlsZWQnIH0+O1xyXG59XHJcblxyXG4vKiogdG9vbC5zdGFydGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXHJcbmV4cG9ydCBpbnRlcmZhY2UgVG9vbFN0YXJ0ZWRQYXlsb2FkIHtcclxuICBuYW1lOiBzdHJpbmc7XHJcbiAgLyoqIFx1NTNDMlx1NjU3MFx1NEVFNVx1NjU4N1x1NjcyQ1x1NTQ0OFx1NzNCMCxcdTZFMzJcdTY3RDNcdTdBRUZcdTZDMzhcdTRFMEQgZXZhbDtcdTU5MjdcdTVCRjlcdThDNjFcdTc1MzEgcnVudGltZSBcdTYyMkFcdTY1QURcdTMwMDIgKi9cclxuICBhcmdzUHJldmlldzogc3RyaW5nO1xyXG59XHJcblxyXG4vKiogdG9vbC5jb21wbGV0ZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cclxuZXhwb3J0IGludGVyZmFjZSBUb29sQ29tcGxldGVkUGF5bG9hZCB7XHJcbiAgbmFtZTogc3RyaW5nO1xyXG4gIGlzRXJyb3I6IGJvb2xlYW47XHJcbiAgb3V0cHV0UHJldmlldzogc3RyaW5nO1xyXG59XHJcblxyXG4vKiogYXBwcm92YWwucmVxdWlyZWQgXHU3Njg0IHBheWxvYWRcdTMwMDJcdTVCQTFcdTYyNzlcdTY3NDNcdTVBMDFcdTU3MjggcnVudGltZSBcdTU0MEVcdTdBRUY7VUkgXHU1M0VBXHU2NjJGXHU4RjZDXHU4RkYwXHUzMDAyICovXHJcbmV4cG9ydCBpbnRlcmZhY2UgQXBwcm92YWxSZXF1aXJlZFBheWxvYWQge1xyXG4gIGFwcHJvdmFsSWQ6IHN0cmluZztcclxuICB0b29sOiBzdHJpbmc7XHJcbiAgYXJnc1ByZXZpZXc6IHN0cmluZztcclxuICAvKiogXHU1RjcxXHU1NENEXHU4MzAzXHU1NkY0L1x1OThDRVx1OTY2OVx1NzY4NFx1NEVCQVx1N0M3Qlx1NTNFRlx1OEJGQlx1OEJGNFx1NjYwRSxcdTc1MzEgcnVudGltZSBcdTc1MUZcdTYyMTBcdTMwMDIgKi9cclxuICByaXNrOiBzdHJpbmc7XHJcbn1cclxuXHJcbi8qKiB2ZXJpZmljYXRpb24udXBkYXRlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xyXG5leHBvcnQgaW50ZXJmYWNlIFZlcmlmaWNhdGlvblVwZGF0ZWRQYXlsb2FkIHtcclxuICBzdW1tYXJ5OiBzdHJpbmc7XHJcbiAgcGFzc2VkOiBib29sZWFuIHwgbnVsbDsgLy8gbnVsbCA9IFx1NjcyQVx1NzdFNS9cdThGREJcdTg4NENcdTRFMkQoTkVFRFMtREFUQSBcdTY1RjZcdTRFMERcdTUwNDdcdTU4NkIpXHJcbn1cclxuXHJcbi8qKiBhcnRpZmFjdC5jcmVhdGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXHJcbmV4cG9ydCBpbnRlcmZhY2UgQXJ0aWZhY3RDcmVhdGVkUGF5bG9hZCB7XHJcbiAgYXJ0aWZhY3Q6IEFydGlmYWN0UmVmO1xyXG59XHJcblxyXG4vKiogcnVuLmNvbXBsZXRlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xyXG5leHBvcnQgaW50ZXJmYWNlIFJ1bkNvbXBsZXRlZFBheWxvYWQge1xyXG4gIHRleHQ6IHN0cmluZztcclxuICB0dXJuczogbnVtYmVyO1xyXG4gIHRvb2xVc2VzOiBudW1iZXI7XHJcbiAgdXNhZ2U/OiB7IHByb21wdFRva2VuczogbnVtYmVyOyBjb21wbGV0aW9uVG9rZW5zOiBudW1iZXIgfTtcclxufVxyXG5cclxuLyoqIHJ1bi5mYWlsZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cclxuZXhwb3J0IGludGVyZmFjZSBSdW5GYWlsZWRQYXlsb2FkIHtcclxuICBlcnJvcjogRGVza3RvcEVycm9yO1xyXG59XHJcbiIsICIvKipcclxuICogQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyBcdTIwMTQgXHU3RUQzXHU2Nzg0XHU1MzE2XHU2ODRDXHU5NzYyXHU5NTE5XHU4QkVGKFx1NUYwMFx1NTNEMVx1OEJBMVx1NTIxMlx1NjU4N1x1Njg2MyAwNCBcdTAwQTdcdTRFMDkpXHUzMDAyXHJcbiAqXHJcbiAqIGhvc3Qtbm90LXJlYWR5IC8gYXV0aC1mYWlsZWQgLyBzdGFsZS12ZXJzaW9uIC8gcnVudGltZS1jcmFzaGVkIC9cclxuICogcG9ydC1iaW5kLWZhaWxlZCAvIHNjaGVtYS1taXNtYXRjaCBcdTVGQzVcdTk4N0JcdTY2MkZcdTdFRDNcdTY3ODRcdTUzMTZcdTk1MTlcdThCRUZcdTc4MDEsXHU1RTc2XHU2M0QwXHU0RjlCXHU0RTBCXHU0RTAwXHU2QjY1XHU1MkE4XHU0RjVDXHUzMDAyXHJcbiAqIG1lc3NhZ2UgXHU2NjJGXHU3RUFGXHU2NTg3XHU2NzJDLFx1NkUzMlx1NjdEM1x1N0FFRlx1NkMzOFx1NEUwRFx1NjI4QVx1NUI4M1x1NUY1MyBIVE1MXHUzMDAyXHJcbiAqL1xyXG5leHBvcnQgY29uc3QgRVJST1JfQ09ERVMgPSBbXHJcbiAgJ0hPU1RfTk9UX1JFQURZJyxcclxuICAnQVVUSF9GQUlMRUQnLFxyXG4gICdSVU5USU1FX0NSQVNIRUQnLFxyXG4gICdQT1JUX0JJTkRfRkFJTEVEJyxcclxuICAnU1RBTEVfVkVSU0lPTicsXHJcbiAgJ1NDSEVNQV9NSVNNQVRDSCcsXHJcbl0gYXMgY29uc3Q7XHJcblxyXG5leHBvcnQgdHlwZSBFcnJvckNvZGUgPSAodHlwZW9mIEVSUk9SX0NPREVTKVtudW1iZXJdO1xyXG5cclxuZXhwb3J0IGNvbnN0IFJFQ09WRVJZX0FDVElPTlMgPSBbJ1JFQ09OTkVDVCcsICdSRVNVTUUnLCAnRVhQT1JUJywgJ09QRU5fTE9HUyddIGFzIGNvbnN0O1xyXG5leHBvcnQgdHlwZSBSZWNvdmVyeUFjdGlvbiA9ICh0eXBlb2YgUkVDT1ZFUllfQUNUSU9OUylbbnVtYmVyXTtcclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgRGVza3RvcEVycm9yIHtcclxuICBjb2RlOiBFcnJvckNvZGU7XHJcbiAgLyoqIFx1N0VBRlx1NjU4N1x1NjcyQyxcdTZDMzhcdTRFMERcdTRGRTFcdTRFRkJcdTRFM0EgSFRNTFx1MzAwMiAqL1xyXG4gIG1lc3NhZ2U6IHN0cmluZztcclxuICByZXRyeWFibGU6IGJvb2xlYW47XHJcbiAgc2Vzc2lvbklkPzogc3RyaW5nO1xyXG4gIHJ1bklkPzogc3RyaW5nO1xyXG4gIHJlY292ZXJ5QWN0aW9uPzogUmVjb3ZlcnlBY3Rpb247XHJcbn1cclxuXHJcbi8qKiBcdTY3ODRcdTkwMjBcdTRFMDBcdTRFMkEgRGVza3RvcEVycm9yKGV4YWN0T3B0aW9uYWxQcm9wZXJ0eVR5cGVzIFx1NTNDQlx1NTk3RClcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGRlc2t0b3BFcnJvcihcclxuICBjb2RlOiBFcnJvckNvZGUsXHJcbiAgbWVzc2FnZTogc3RyaW5nLFxyXG4gIG9wdHM6IHsgcmV0cnlhYmxlPzogYm9vbGVhbjsgc2Vzc2lvbklkPzogc3RyaW5nOyBydW5JZD86IHN0cmluZzsgcmVjb3ZlcnlBY3Rpb24/OiBSZWNvdmVyeUFjdGlvbiB9ID0ge30sXHJcbik6IERlc2t0b3BFcnJvciB7XHJcbiAgY29uc3QgZTogRGVza3RvcEVycm9yID0geyBjb2RlLCBtZXNzYWdlLCByZXRyeWFibGU6IG9wdHMucmV0cnlhYmxlID09PSB0cnVlIH07XHJcbiAgaWYgKG9wdHMuc2Vzc2lvbklkICE9PSB1bmRlZmluZWQpIGUuc2Vzc2lvbklkID0gb3B0cy5zZXNzaW9uSWQ7XHJcbiAgaWYgKG9wdHMucnVuSWQgIT09IHVuZGVmaW5lZCkgZS5ydW5JZCA9IG9wdHMucnVuSWQ7XHJcbiAgaWYgKG9wdHMucmVjb3ZlcnlBY3Rpb24gIT09IHVuZGVmaW5lZCkgZS5yZWNvdmVyeUFjdGlvbiA9IG9wdHMucmVjb3ZlcnlBY3Rpb247XHJcbiAgcmV0dXJuIGU7XHJcbn1cclxuIiwgIi8qKlxyXG4gKiBAaG1oLWRlc2t0b3AvY29udHJhY3RzIFx1MjAxNCBydW50aW1lIFx1NjgyMVx1OUE4QyhndWFyZHMpXHUzMDAyXHJcbiAqXHJcbiAqIFx1NkJDRlx1NEUyQVx1OERFOFx1NEZFMVx1NEVGQlx1OEZCOVx1NzU0Q1x1NzY4NFx1NjU3MFx1NjM2RShydW50aW1lXHUyMTkycmVuZGVyZXJcdTMwMDFob3N0XHUyMTkybWFpbilcdThGREJcdTUxNjVcdTUyNERcdTUxNDhcdThGQzcgZ3VhcmQ7XHJcbiAqIFx1NjgyMVx1OUE4Q1x1NTkzMVx1OEQyNVx1NzY4NFx1NjU3MFx1NjM2RVx1NjMwOSBTQ0hFTUFfTUlTTUFUQ0ggXHU3RUQzXHU2Nzg0XHU1MzE2XHU5NTE5XHU4QkVGXHU1OTA0XHU3NDA2LFx1NEUwRFx1OTc1OVx1OUVEOFx1NjNBNVx1NTNEN1x1MzAwMlxyXG4gKiBcdTYyNEJcdTUxOTlcdTVCODhcdTUzNkJcdTgwMENcdTRFMERcdTY2MkZcdTVGMTVcdTdCMkNcdTRFMDlcdTY1Qjkgc2NoZW1hIFx1NUU5MzpcdTU5NTFcdTdFQTZcdTk3NjJcdTVDMEYsXHU5NkY2XHU0RjlEXHU4RDU2XHU2NTg3XHU1MzE2KGhtaGFybmVzcyBcdTU0MENcdTZFOTApXHUzMDAyXHJcbiAqL1xyXG5pbXBvcnQge1xyXG4gIEVWRU5UX0tJTkRTLFxyXG4gIEVWRU5UX1NDSEVNQV9WRVJTSU9OLFxyXG4gIHR5cGUgRXZlbnRFbnZlbG9wZSxcclxuICB0eXBlIEV2ZW50S2luZCxcclxufSBmcm9tICcuL2V2ZW50LnRzJztcclxuaW1wb3J0IHsgRVJST1JfQ09ERVMsIFJFQ09WRVJZX0FDVElPTlMsIHR5cGUgRGVza3RvcEVycm9yIH0gZnJvbSAnLi9lcnJvci50cyc7XHJcbmltcG9ydCB7IFJVTl9TVEFUVVNFUywgdHlwZSBSdW5TdGF0dXMgfSBmcm9tICcuL2R0by50cyc7XHJcblxyXG5jb25zdCBpc1JlY29yZCA9ICh2OiB1bmtub3duKTogdiBpcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9PlxyXG4gIHR5cGVvZiB2ID09PSAnb2JqZWN0JyAmJiB2ICE9PSBudWxsICYmICFBcnJheS5pc0FycmF5KHYpO1xyXG5cclxuY29uc3QgaXNOb25FbXB0eVN0cmluZyA9ICh2OiB1bmtub3duKTogdiBpcyBzdHJpbmcgPT4gdHlwZW9mIHYgPT09ICdzdHJpbmcnICYmIHYubGVuZ3RoID4gMDtcclxuXHJcbmNvbnN0IGlzUmZjMzMzOSA9ICh2OiBzdHJpbmcpOiBib29sZWFuID0+IHtcclxuICBjb25zdCB0ID0gRGF0ZS5wYXJzZSh2KTtcclxuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKHQpICYmIC9cXGR7NH0tXFxkezJ9LVxcZHsyfVQvLnRlc3Qodik7XHJcbn07XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gaXNFdmVudEVudmVsb3BlKHY6IHVua25vd24pOiB2IGlzIEV2ZW50RW52ZWxvcGUge1xyXG4gIGlmICghaXNSZWNvcmQodikpIHJldHVybiBmYWxzZTtcclxuICBpZiAodi5zY2hlbWFWZXJzaW9uICE9PSBFVkVOVF9TQ0hFTUFfVkVSU0lPTikgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICghaXNOb25FbXB0eVN0cmluZyh2LmV2ZW50SWQpKSByZXR1cm4gZmFsc2U7XHJcbiAgaWYgKCFpc05vbkVtcHR5U3RyaW5nKHYuc2Vzc2lvbklkKSkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICghaXNOb25FbXB0eVN0cmluZyh2LnJ1bklkKSkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICh0eXBlb2Ygdi5zZXEgIT09ICdudW1iZXInIHx8ICFOdW1iZXIuaXNJbnRlZ2VyKHYuc2VxKSB8fCB2LnNlcSA8IDApIHJldHVybiBmYWxzZTtcclxuICBpZiAoIWlzTm9uRW1wdHlTdHJpbmcodi5vY2N1cnJlZEF0KSB8fCAhaXNSZmMzMzM5KHYub2NjdXJyZWRBdCkpIHJldHVybiBmYWxzZTtcclxuICBpZiAoIUVWRU5UX0tJTkRTLmluY2x1ZGVzKHYua2luZCBhcyBFdmVudEtpbmQpKSByZXR1cm4gZmFsc2U7XHJcbiAgcmV0dXJuIGlzUmVjb3JkKHYucGF5bG9hZCk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpc0Rlc2t0b3BFcnJvcih2OiB1bmtub3duKTogdiBpcyBEZXNrdG9wRXJyb3Ige1xyXG4gIGlmICghaXNSZWNvcmQodikpIHJldHVybiBmYWxzZTtcclxuICBpZiAoIUVSUk9SX0NPREVTLmluY2x1ZGVzKHYuY29kZSBhcyBuZXZlcikpIHJldHVybiBmYWxzZTtcclxuICBpZiAodHlwZW9mIHYubWVzc2FnZSAhPT0gJ3N0cmluZycpIHJldHVybiBmYWxzZTtcclxuICBpZiAodHlwZW9mIHYucmV0cnlhYmxlICE9PSAnYm9vbGVhbicpIHJldHVybiBmYWxzZTtcclxuICBpZiAodi5zZXNzaW9uSWQgIT09IHVuZGVmaW5lZCAmJiAhaXNOb25FbXB0eVN0cmluZyh2LnNlc3Npb25JZCkpIHJldHVybiBmYWxzZTtcclxuICBpZiAodi5ydW5JZCAhPT0gdW5kZWZpbmVkICYmICFpc05vbkVtcHR5U3RyaW5nKHYucnVuSWQpKSByZXR1cm4gZmFsc2U7XHJcbiAgaWYgKHYucmVjb3ZlcnlBY3Rpb24gIT09IHVuZGVmaW5lZCAmJiAhUkVDT1ZFUllfQUNUSU9OUy5pbmNsdWRlcyh2LnJlY292ZXJ5QWN0aW9uIGFzIG5ldmVyKSkgcmV0dXJuIGZhbHNlO1xyXG4gIHJldHVybiB0cnVlO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gaXNSdW5TdGF0dXModjogdW5rbm93bik6IHYgaXMgUnVuU3RhdHVzIHtcclxuICByZXR1cm4gdHlwZW9mIHYgPT09ICdzdHJpbmcnICYmIFJVTl9TVEFUVVNFUy5pbmNsdWRlcyh2IGFzIFJ1blN0YXR1cyk7XHJcbn1cclxuXHJcbi8qKiBIb3N0IFx1NUYxNVx1NUJGQ1x1ODg0QyhzdGRvdXQgXHU3QjJDXHU0RTAwXHU4ODRDKVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gaXNIb3N0UmVhZHlMaW5lKHY6IHVua25vd24pOiB2IGlzIHsgaG1oRGVza3RvcEhvc3RSZWFkeTogdHJ1ZTsgcG9ydDogbnVtYmVyOyB2ZXJzaW9uOiBzdHJpbmcgfSB7XHJcbiAgaWYgKCFpc1JlY29yZCh2KSkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICh2LmhtaERlc2t0b3BIb3N0UmVhZHkgIT09IHRydWUpIHJldHVybiBmYWxzZTtcclxuICBpZiAodHlwZW9mIHYucG9ydCAhPT0gJ251bWJlcicgfHwgIU51bWJlci5pc0ludGVnZXIodi5wb3J0KSB8fCB2LnBvcnQgPD0gMCB8fCB2LnBvcnQgPiA2NTUzNSkgcmV0dXJuIGZhbHNlO1xyXG4gIHJldHVybiBpc05vbkVtcHR5U3RyaW5nKHYudmVyc2lvbik7XHJcbn1cclxuIiwgIi8qKlxyXG4gKiBEZXNrdG9wSG9zdENsaWVudCBcdTIwMTQgXHU1QkY5IGhtaCBob3N0IFx1NzY4NCBIVFRQK1NTRSBcdTVCQTJcdTYyMzdcdTdBRUZcdTMwMDJcclxuICpcclxuICogLSBcdTZCQ0ZcdTRFMkEgSFRUUCBcdThCRjdcdTZDNDJcdTgxRUFcdTUyQThcdTVFMjYgWC1IbWgtS2V5KHRva2VuIFx1NEUwRFx1OEZEQiBVUkwpO1xyXG4gKiAtIFx1N0VEM1x1Njc4NFx1NTMxNlx1OTUxOVx1OEJFRihyZXMuYm9keSBcdTkxQ0NcdTc2ODQgRGVza3RvcEVycm9yIFx1NUY2Mlx1NzJCNlx1NjIxNiBIVFRQIFx1NzJCNlx1NjAwMSlcdTg5QzRcdTdFQTZcdTYyMTBcdTVGMDJcdTVFMzhcdTYyOUJcdTUxRkE7XHJcbiAqIC0gU1NFIFx1NzUyOCBmZXRjaCBcdTZENDFcdTYyNEJcdTUxOTlcdTg5RTNcdTY3OTAoaWQvZXZlbnQvZGF0YSBcdTVFMjcpLFx1NjUyRlx1NjMwMSBMYXN0LUV2ZW50LUlEIFx1ODg2NVx1NjJDOVx1OTFDRFx1OEZERVx1MzAwMlxyXG4gKi9cclxuaW1wb3J0IHsgZGVza3RvcEVycm9yLCBpc0Rlc2t0b3BFcnJvciwgaXNFdmVudEVudmVsb3BlLCB0eXBlIERlc2t0b3BFcnJvciwgdHlwZSBFdmVudEVudmVsb3BlIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyc7XHJcbmltcG9ydCB7IHJhbmRvbVVVSUQgfSBmcm9tICdub2RlOmNyeXB0byc7XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIFNzZUZyYW1lIHtcclxuICBpZD86IHN0cmluZztcclxuICBldmVudDogc3RyaW5nO1xyXG4gIGRhdGE6IHN0cmluZztcclxufVxyXG5cclxuLyoqIFx1ODlFM1x1Njc5MFx1NEUwMFx1NkJCNSBTU0UgXHU2NTg3XHU2NzJDXHU0RTNBXHU1RTI3KFx1NEUwRFx1NTQyQlx1OERFOCBjaHVuayBcdTc2ODRcdTdGMTNcdTUxQjJcdTkwM0JcdThGOTEsXHU3RUFGXHU1MUZEXHU2NTcwXHU0RkJGXHU0RThFXHU2RDRCXHU4QkQ1KVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VTc2VDaHVuayhjaHVuazogc3RyaW5nKTogU3NlRnJhbWVbXSB7XHJcbiAgY29uc3QgZnJhbWVzOiBTc2VGcmFtZVtdID0gW107XHJcbiAgZm9yIChjb25zdCBibG9jayBvZiBjaHVuay5zcGxpdCgvXFxuXFxuLykpIHtcclxuICAgIGlmICghYmxvY2sudHJpbSgpKSBjb250aW51ZTtcclxuICAgIGxldCBpZDogc3RyaW5nIHwgdW5kZWZpbmVkO1xyXG4gICAgbGV0IGV2ZW50ID0gJ21lc3NhZ2UnO1xyXG4gICAgY29uc3QgZGF0YUxpbmVzOiBzdHJpbmdbXSA9IFtdO1xyXG4gICAgbGV0IHNhd0ZpZWxkID0gZmFsc2U7XHJcbiAgICBmb3IgKGNvbnN0IGxpbmUgb2YgYmxvY2suc3BsaXQoJ1xcbicpKSB7XHJcbiAgICAgIGlmIChsaW5lLnN0YXJ0c1dpdGgoJzonKSkgY29udGludWU7IC8vIFx1NkNFOFx1OTFDQS9cdTVGQzNcdThERjNcclxuICAgICAgaWYgKGxpbmUuc3RhcnRzV2l0aCgnaWQ6JykpIHsgaWQgPSBsaW5lLnNsaWNlKDMpLnRyaW0oKTsgc2F3RmllbGQgPSB0cnVlOyB9XHJcbiAgICAgIGVsc2UgaWYgKGxpbmUuc3RhcnRzV2l0aCgnZXZlbnQ6JykpIHsgZXZlbnQgPSBsaW5lLnNsaWNlKDYpLnRyaW0oKTsgc2F3RmllbGQgPSB0cnVlOyB9XHJcbiAgICAgIGVsc2UgaWYgKGxpbmUuc3RhcnRzV2l0aCgnZGF0YTonKSkgeyBkYXRhTGluZXMucHVzaChsaW5lLnNsaWNlKDUpLnJlcGxhY2UoL14gLywgJycpKTsgc2F3RmllbGQgPSB0cnVlOyB9XHJcbiAgICB9XHJcbiAgICBpZiAoIXNhd0ZpZWxkKSBjb250aW51ZTsgLy8gXHU3RUFGXHU2Q0U4XHU5MUNBL1x1NUZDM1x1OERGM1x1NTc1N1x1NEUwRFx1NEVBN1x1NzUxRlx1NUUyN1xyXG4gICAgZnJhbWVzLnB1c2goeyAuLi4oaWQgIT09IHVuZGVmaW5lZCA/IHsgaWQgfSA6IHt9KSwgZXZlbnQsIGRhdGE6IGRhdGFMaW5lcy5qb2luKCdcXG4nKSB9KTtcclxuICB9XHJcbiAgcmV0dXJuIGZyYW1lcztcclxufVxyXG5cclxuLyoqIFx1NEVDRSBTU0UgXHU1RTI3XHU2NTcwXHU2MzZFXHU0RTJEXHU4OUUzXHU1MUZBXHU1NDA4XHU2Q0Q1IEV2ZW50RW52ZWxvcGU7XHU0RTBEXHU1NDA4XHU2Q0Q1XHU3Njg0XHU4RkQ0XHU1NkRFIG51bGwoU0NIRU1BX01JU01BVENIIFx1NzUzMVx1OEMwM1x1NzUyOFx1NjVCOVx1OEJBMVx1NjU3MClcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGVudmVsb3BlRnJvbUZyYW1lKGZyYW1lOiBTc2VGcmFtZSk6IEV2ZW50RW52ZWxvcGUgfCBudWxsIHtcclxuICBpZiAoZnJhbWUuZXZlbnQgIT09ICdobWgnKSByZXR1cm4gbnVsbDsgLy8gXHU2MjExXHU0RUVDXHU3Njg0XHU0RThCXHU0RUY2XHU0RkUxXHU1QzAxXHU3RURGXHU0RTAwXHU4RDcwIGV2ZW50OiBobWhcclxuICB0cnkge1xyXG4gICAgY29uc3QgcGFyc2VkOiB1bmtub3duID0gSlNPTi5wYXJzZShmcmFtZS5kYXRhKTtcclxuICAgIHJldHVybiBpc0V2ZW50RW52ZWxvcGUocGFyc2VkKSA/IHBhcnNlZCA6IG51bGw7XHJcbiAgfSBjYXRjaCB7XHJcbiAgICByZXR1cm4gbnVsbDtcclxuICB9XHJcbn1cclxuXHJcbmV4cG9ydCBjbGFzcyBEZXNrdG9wSHR0cEVycm9yIGV4dGVuZHMgRXJyb3Ige1xyXG4gIGNvbnN0cnVjdG9yKHB1YmxpYyByZWFkb25seSBkZXRhaWw6IERlc2t0b3BFcnJvcikge1xyXG4gICAgc3VwZXIoZGV0YWlsLm1lc3NhZ2UpO1xyXG4gIH1cclxufVxyXG5cclxuZXhwb3J0IGNsYXNzIERlc2t0b3BIb3N0Q2xpZW50IHtcclxuICBjb25zdHJ1Y3RvcihcclxuICAgIHByaXZhdGUgcmVhZG9ubHkgYmFzZVVybDogc3RyaW5nLFxyXG4gICAgcHJpdmF0ZSByZWFkb25seSB0b2tlbjogc3RyaW5nLFxyXG4gICkge31cclxuXHJcbiAgcHJpdmF0ZSBoZWFkZXJzKGV4dHJhOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge30pOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IHtcclxuICAgIHJldHVybiB7ICd4LWhtaC1rZXknOiB0aGlzLnRva2VuLCAuLi5leHRyYSB9O1xyXG4gIH1cclxuXHJcbiAgYXN5bmMgZ2V0SnNvbjxUPihwYXRoOiBzdHJpbmcsIHRpbWVvdXRNcyA9IDVfMDAwKTogUHJvbWlzZTxUPiB7XHJcbiAgICBsZXQgcmVzOiBSZXNwb25zZTtcclxuICAgIHRyeSB7XHJcbiAgICAgIHJlcyA9IGF3YWl0IGZldGNoKGAke3RoaXMuYmFzZVVybH0ke3BhdGh9YCwgeyBoZWFkZXJzOiB0aGlzLmhlYWRlcnMoKSwgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KHRpbWVvdXRNcykgfSk7XHJcbiAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGByZXF1ZXN0IGZhaWxlZDogJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxNjApfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHRoaXMucGFyc2VSZXNwb25zZTxUPihyZXMpO1xyXG4gIH1cclxuXHJcbiAgLyoqIFx1NjJDOVx1NTNENlx1N0VBRlx1NjU4N1x1NjcyQ1x1N0FFRlx1NzBCOShcdTU5ODIgL2FwaS9zZXNzaW9ucy86aWQvZXhwb3J0Lm1kKVx1MzAwMiAqL1xyXG4gIGFzeW5jIGdldFRleHQocGF0aDogc3RyaW5nLCB0aW1lb3V0TXMgPSAxMF8wMDApOiBQcm9taXNlPHN0cmluZz4ge1xyXG4gICAgbGV0IHJlczogUmVzcG9uc2U7XHJcbiAgICB0cnkge1xyXG4gICAgICByZXMgPSBhd2FpdCBmZXRjaChgJHt0aGlzLmJhc2VVcmx9JHtwYXRofWAsIHsgaGVhZGVyczogdGhpcy5oZWFkZXJzKCksIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCh0aW1lb3V0TXMpIH0pO1xyXG4gICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgcmVxdWVzdCBmYWlsZWQ6ICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTYwKX1gLCB7IHJldHJ5YWJsZTogdHJ1ZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcclxuICAgIH1cclxuICAgIGlmIChyZXMuc3RhdHVzID09PSA0MDEgfHwgcmVzLnN0YXR1cyA9PT0gNDAzKSB7XHJcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignQVVUSF9GQUlMRUQnLCBgaG9zdCByZWplY3RlZCB0aGUgc2Vzc2lvbiB0b2tlbiAoSFRUUCAke3Jlcy5zdGF0dXN9KWAsIHsgcmV0cnlhYmxlOiBmYWxzZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcclxuICAgIH1cclxuICAgIGlmICghcmVzLm9rKSB7XHJcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgSFRUUCAke3Jlcy5zdGF0dXN9YCwgeyByZXRyeWFibGU6IHJlcy5zdGF0dXMgPj0gNTAwIH0pKTtcclxuICAgIH1cclxuICAgIHJldHVybiByZXMudGV4dCgpO1xyXG4gIH1cclxuXHJcbiAgLyoqIFx1NkJDRlx1NEUyQVx1NUUyNlx1NTI2Rlx1NEY1Q1x1NzUyOFx1NzY4NCBQT1NUIFx1ODFFQVx1NTJBOFx1NjQzQVx1NUUyNlx1NUU0Mlx1N0I0OVx1OTUyRSgwMyBcdTAwQTdcdTU2REJcdTk2MzJcdTkxQ0RcdTY1M0U6XHU4QkY3XHU2QzQyXHU0RjdGXHU3NTI4IGlkZW1wb3RlbmN5S2V5O1xyXG4gICAqICBydW50aW1lIFx1NEZBN1x1NzdFRFx1NjcxRlx1NTE3Q1x1NUJCOVx1NUZGRFx1NzU2NSxcdTUzNEZcdThCQUVcdTUxNDhcdTg4NENcdTIwMTRcdTIwMTRcdTkxQ0RcdThCRDVcdTUzRUZcdTUxRURcdTk1MkVcdTUzQkJcdTkxQ0QsXHU0RTBEXHU3NkYyXHU3NkVFXHU5MUNEXHU2NTNFKVx1MzAwMiAqL1xyXG4gIGFzeW5jIHBvc3RKc29uPFQ+KHBhdGg6IHN0cmluZywgYm9keTogdW5rbm93biwgdGltZW91dE1zID0gMTBfMDAwKTogUHJvbWlzZTxUPiB7XHJcbiAgICBsZXQgcmVzOiBSZXNwb25zZTtcclxuICAgIHRyeSB7XHJcbiAgICAgIHJlcyA9IGF3YWl0IGZldGNoKGAke3RoaXMuYmFzZVVybH0ke3BhdGh9YCwge1xyXG4gICAgICAgIG1ldGhvZDogJ1BPU1QnLFxyXG4gICAgICAgIGhlYWRlcnM6IHRoaXMuaGVhZGVycyh7XHJcbiAgICAgICAgICAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLFxyXG4gICAgICAgICAgJ3gtaWRlbXBvdGVuY3kta2V5JzogcmFuZG9tVVVJRCgpLFxyXG4gICAgICAgIH0pLFxyXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpLFxyXG4gICAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCh0aW1lb3V0TXMpLFxyXG4gICAgICB9KTtcclxuICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYHJlcXVlc3QgZmFpbGVkOiAke1N0cmluZyhlcnIpLnNsaWNlKDAsIDE2MCl9YCwgeyByZXRyeWFibGU6IHRydWUsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gdGhpcy5wYXJzZVJlc3BvbnNlPFQ+KHJlcyk7XHJcbiAgfVxyXG5cclxuICBwcml2YXRlIGFzeW5jIHBhcnNlUmVzcG9uc2U8VD4ocmVzOiBSZXNwb25zZSk6IFByb21pc2U8VD4ge1xyXG4gICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSB8fCByZXMuc3RhdHVzID09PSA0MDMpIHtcclxuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdBVVRIX0ZBSUxFRCcsIGBob3N0IHJlamVjdGVkIHRoZSBzZXNzaW9uIHRva2VuIChIVFRQICR7cmVzLnN0YXR1c30pYCwgeyByZXRyeWFibGU6IGZhbHNlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgdGV4dCA9IGF3YWl0IHJlcy50ZXh0KCk7XHJcbiAgICBsZXQgcGFyc2VkOiB1bmtub3duID0gbnVsbDtcclxuICAgIHRyeSB7XHJcbiAgICAgIHBhcnNlZCA9IHRleHQgPyBKU09OLnBhcnNlKHRleHQpIDogbnVsbDtcclxuICAgIH0gY2F0Y2gge1xyXG4gICAgICBwYXJzZWQgPSBudWxsO1xyXG4gICAgfVxyXG4gICAgaWYgKCFyZXMub2spIHtcclxuICAgICAgaWYgKGlzRGVza3RvcEVycm9yKHBhcnNlZCkpIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKHBhcnNlZCk7XHJcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgSFRUUCAke3Jlcy5zdGF0dXN9OiAke3RleHQuc2xpY2UoMCwgMTYwKX1gLCB7IHJldHJ5YWJsZTogcmVzLnN0YXR1cyA+PSA1MDAgfSkpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHBhcnNlZCBhcyBUO1xyXG4gIH1cclxuXHJcbiAgLyoqXHJcbiAgICogXHU4QkEyXHU5NjA1XHU1MTY4XHU5MEU4IFNTRSBcdTVFMjcoXHU1NDJCXHU5NzVFXHU0RkUxXHU1QzAxXHU0RThCXHU0RUY2OmRlbHRhL2xpbmUgXHU3QjQ5XHU5QUQ4XHU5ODkxXHU2RDQxKVx1MzAwMlx1NEZFMVx1NUMwMVx1NzUzMVx1OEMwM1x1NzUyOFx1NjVCOVxyXG4gICAqIFx1NzUyOCBlbnZlbG9wZUZyb21GcmFtZSBcdTgxRUFcdTg4NENcdTUyMDZcdTZENDE7XHU2NUFEXHU3RUJGXHU5MUNEXHU4RkRFXHU4QkVEXHU0RTQ5XHU1NDBDIGV2ZW50cygpXHUzMDAyXHJcbiAgICovXHJcbiAgYXN5bmMgKnJhd0V2ZW50cyhsYXN0RXZlbnRJZD86IHN0cmluZywgc2lnbmFsPzogQWJvcnRTaWduYWwpOiBBc3luY0dlbmVyYXRvcjxTc2VGcmFtZT4ge1xyXG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYCR7dGhpcy5iYXNlVXJsfS9hcGkvZXZlbnRzYCwge1xyXG4gICAgICBoZWFkZXJzOiB0aGlzLmhlYWRlcnMoe1xyXG4gICAgICAgIGFjY2VwdDogJ3RleHQvZXZlbnQtc3RyZWFtJyxcclxuICAgICAgICAuLi4obGFzdEV2ZW50SWQgIT09IHVuZGVmaW5lZCA/IHsgJ2xhc3QtZXZlbnQtaWQnOiBsYXN0RXZlbnRJZCB9IDoge30pLFxyXG4gICAgICB9KSxcclxuICAgICAgLi4uKHNpZ25hbCAhPT0gdW5kZWZpbmVkID8geyBzaWduYWwgfSA6IHt9KSxcclxuICAgIH0pO1xyXG4gICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSB8fCByZXMuc3RhdHVzID09PSA0MDMpIHtcclxuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdBVVRIX0ZBSUxFRCcsIGBob3N0IHJlamVjdGVkIHRoZSBzZXNzaW9uIHRva2VuIChIVFRQICR7cmVzLnN0YXR1c30pYCwgeyByZXRyeWFibGU6IGZhbHNlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xyXG4gICAgfVxyXG4gICAgaWYgKCFyZXMub2sgfHwgcmVzLmJvZHkgPT09IG51bGwpIHtcclxuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBTU0UgSFRUUCAke3Jlcy5zdGF0dXN9YCwgeyByZXRyeWFibGU6IHRydWUsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XHJcbiAgICB9XHJcbiAgICBjb25zdCByZWFkZXIgPSByZXMuYm9keS5nZXRSZWFkZXIoKTtcclxuICAgIGNvbnN0IGRlY29kZXIgPSBuZXcgVGV4dERlY29kZXIoKTtcclxuICAgIGxldCBidWZmZXIgPSAnJztcclxuICAgIGZvciAoOzspIHtcclxuICAgICAgY29uc3QgeyBkb25lLCB2YWx1ZSB9ID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcclxuICAgICAgaWYgKGRvbmUpIHJldHVybjtcclxuICAgICAgYnVmZmVyICs9IGRlY29kZXIuZGVjb2RlKHZhbHVlLCB7IHN0cmVhbTogdHJ1ZSB9KTtcclxuICAgICAgbGV0IGlkeDogbnVtYmVyO1xyXG4gICAgICB3aGlsZSAoKGlkeCA9IGJ1ZmZlci5pbmRleE9mKCdcXG5cXG4nKSkgIT09IC0xKSB7XHJcbiAgICAgICAgY29uc3QgYmxvY2sgPSBidWZmZXIuc2xpY2UoMCwgaWR4KTtcclxuICAgICAgICBidWZmZXIgPSBidWZmZXIuc2xpY2UoaWR4ICsgMik7XHJcbiAgICAgICAgZm9yIChjb25zdCBmcmFtZSBvZiBwYXJzZVNzZUNodW5rKGJsb2NrKSkgeWllbGQgZnJhbWU7XHJcbiAgICAgIH1cclxuICAgIH1cclxuICB9XHJcblxyXG4gIC8qKlxyXG4gICAqIFx1OEJBMlx1OTYwNSBTU0UgXHU0RThCXHU0RUY2XHU2RDQxKGFzeW5jIGl0ZXJhdG9yKVx1MzAwMlx1NjVBRFx1N0VCRlx1NzUzMVx1OEMwM1x1NzUyOFx1NjVCOVx1OTFDRFx1OEZERTtcdTkxQ0RcdThGREVcdTY1RjZcdTYyOEFcdTY3MDBcdTU0MEVcclxuICAgKiBcdTY1MzZcdTUyMzBcdTc2ODQgZXZlbnRJZCBcdTRGMjBcdTUxNjUgbGFzdEV2ZW50SWQsaG9zdCBcdTdBRUZcdTRFQ0VcdTkxQ0RcdTY1M0VcdTczQUZcdTg4NjVcdTUzRDFcdTMwMDJcclxuICAgKi9cclxuICBhc3luYyAqZXZlbnRzKGxhc3RFdmVudElkPzogc3RyaW5nLCBzaWduYWw/OiBBYm9ydFNpZ25hbCk6IEFzeW5jR2VuZXJhdG9yPEV2ZW50RW52ZWxvcGU+IHtcclxuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGAke3RoaXMuYmFzZVVybH0vYXBpL2V2ZW50c2AsIHtcclxuICAgICAgaGVhZGVyczogdGhpcy5oZWFkZXJzKHtcclxuICAgICAgICBhY2NlcHQ6ICd0ZXh0L2V2ZW50LXN0cmVhbScsXHJcbiAgICAgICAgLi4uKGxhc3RFdmVudElkICE9PSB1bmRlZmluZWQgPyB7ICdsYXN0LWV2ZW50LWlkJzogbGFzdEV2ZW50SWQgfSA6IHt9KSxcclxuICAgICAgfSksXHJcbiAgICAgIC4uLihzaWduYWwgIT09IHVuZGVmaW5lZCA/IHsgc2lnbmFsIH0gOiB7fSksXHJcbiAgICB9KTtcclxuICAgIGlmIChyZXMuc3RhdHVzID09PSA0MDEgfHwgcmVzLnN0YXR1cyA9PT0gNDAzKSB7XHJcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignQVVUSF9GQUlMRUQnLCBgaG9zdCByZWplY3RlZCB0aGUgc2Vzc2lvbiB0b2tlbiAoSFRUUCAke3Jlcy5zdGF0dXN9KWAsIHsgcmV0cnlhYmxlOiBmYWxzZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcclxuICAgIH1cclxuICAgIGlmICghcmVzLm9rIHx8ICFyZXMuYm9keSkge1xyXG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYFNTRSBIVFRQICR7cmVzLnN0YXR1c31gLCB7IHJldHJ5YWJsZTogdHJ1ZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHJlYWRlciA9IHJlcy5ib2R5LmdldFJlYWRlcigpO1xyXG4gICAgY29uc3QgZGVjb2RlciA9IG5ldyBUZXh0RGVjb2RlcigpO1xyXG4gICAgbGV0IGJ1ZmZlciA9ICcnO1xyXG4gICAgZm9yICg7Oykge1xyXG4gICAgICBjb25zdCB7IGRvbmUsIHZhbHVlIH0gPSBhd2FpdCByZWFkZXIucmVhZCgpO1xyXG4gICAgICBpZiAoZG9uZSkgcmV0dXJuO1xyXG4gICAgICBidWZmZXIgKz0gZGVjb2Rlci5kZWNvZGUodmFsdWUsIHsgc3RyZWFtOiB0cnVlIH0pO1xyXG4gICAgICAvLyBcdTRFRTVcdTdBN0FcdTg4NENcdTUyMDZcdTVFMjc7XHU0RkREXHU3NTU5XHU0RTBEXHU1QjhDXHU2NTc0XHU3Njg0XHU1QzNFXHU5MEU4XHJcbiAgICAgIGxldCBpZHg6IG51bWJlcjtcclxuICAgICAgd2hpbGUgKChpZHggPSBidWZmZXIuaW5kZXhPZignXFxuXFxuJykpICE9PSAtMSkge1xyXG4gICAgICAgIGNvbnN0IGJsb2NrID0gYnVmZmVyLnNsaWNlKDAsIGlkeCk7XHJcbiAgICAgICAgYnVmZmVyID0gYnVmZmVyLnNsaWNlKGlkeCArIDIpO1xyXG4gICAgICAgIGZvciAoY29uc3QgZnJhbWUgb2YgcGFyc2VTc2VDaHVuayhibG9jaykpIHtcclxuICAgICAgICAgIGNvbnN0IGVudiA9IGVudmVsb3BlRnJvbUZyYW1lKGZyYW1lKTtcclxuICAgICAgICAgIGlmIChlbnYgIT09IG51bGwpIHlpZWxkIGVudjtcclxuICAgICAgICB9XHJcbiAgICAgIH1cclxuICAgIH1cclxuICB9XHJcbn1cclxuIiwgIi8qKlxyXG4gKiBmYWtlIGhvc3QgXHUyMDE0IGhtaGFybmVzcyBydW50aW1lIFx1NzY4NFx1NkQ0Qlx1OEJENVx1NjZGRlx1OEVBQihNYXN0ZXJQcm9tcHQgXHU5NjM2XHU2QkI1IEQvRTpcclxuICogXCJcdTUxNDhcdTRGN0ZcdTc1MjggZmFrZSBob3N0IFx1N0YxNlx1NTE5OVx1NzJCNlx1NjAwMVx1NjczQVx1NkQ0Qlx1OEJENSxcdTUxOERcdTYzQTVcdTc3MUZcdTVCOUUgQVBJXCI7XHU5NjM2XHU2QkI1IEUgXHU3Njg0XHU0RjFBXHU4QkREXHU3RUI1XHU1MjA3XHU3MjQ3XHJcbiAqIGUyZSBcdTRFNUZcdTUxNDhcdTU3MjggZmFrZSBcdTVDNDJcdTk1RURcdTczQUYpXHUzMDAyXHJcbiAqXHJcbiAqIFx1Njg0Q1x1OTc2MiBob3N0IFx1NTQwOFx1NTQwQzpcclxuICogIC0gXHU1M0VBXHU3RUQxIDEyNy4wLjAuMSxcdTdBRUZcdTUzRTMgT1MgXHU1MjA2XHU5MTRELFx1NUI5RVx1OTY0NVx1N0FFRlx1NTNFM1x1NTE5OSBzdGRvdXQgXHU1RjE1XHU1QkZDXHU4ODRDO1xyXG4gKiAgLSBcdTYyNDBcdTY3MDkgL2FwaS8qIFx1ODk4MVx1NkM0MiBYLUhtaC1LZXkgPT09IEhNSF9ERVNLVE9QX1RPS0VOLFx1NTQyNlx1NTIxOSA0MDEgKyBEZXNrdG9wRXJyb3I7XHJcbiAqICAtIEdFVCAvYXBpL3N0YXRlIFx1NTA2NVx1NUVCN1x1NjNBMlx1NkQ0QjtHRVQgL2FwaS9ldmVudHMgU1NFKGV2ZW50OiBobWggXHU0RkUxXHU1QzAxXHU2RDQxICsgXHU5MUNEXHU2NTNFXHU3M0FGKTtcclxuICogIC0gUE9TVCAvYXBpL2Rlc2t0b3Avc2h1dGRvd24gXHU0RjE4XHU5NkM1XHU5MDAwXHU1MUZBXHUzMDAyXHJcbiAqXHJcbiAqIFx1OTYzNlx1NkJCNSBFIFx1NkEyMVx1NjJERlx1OTc2MihcdTRFMEUgaG1oYXJuZXNzIGRlc2t0b3AgXHU2QTIxXHU1RjBGXHU1NDBDXHU1RjYyKTpcclxuICogIC0gUE9TVCAvYXBpL3Rhc2sge3RleHQsIHNlc3Npb25JZCwgbW9kZX06XHU2MzkyXHU5NjFGXHU1RTc2XHU2MzA5XHU4MTFBXHU2NzJDXHU1M0QxXHJcbiAqICAgIHJ1bi5zdGFydGVkIFx1MjE5MiB0b29sLnN0YXJ0ZWQvY29tcGxldGVkIFx1MjE5Mihtb2RlPT09J2FzaycgXHU2NUY2KVxyXG4gKiAgICBhcHByb3ZhbC5yZXF1aXJlZChcdTdCNDkgL2FwaS9hcHByb3ZlKVx1MjE5MiBydW4uY29tcGxldGVkO1xyXG4gKiAgLSBQT1NUIC9hcGkvYXBwcm92ZSB7Z3JhbnRlZCwgc2Vzc2lvbklkfTtcclxuICogIC0gUE9TVCAvYXBpL2ludGVycnVwdCB7c2Vzc2lvbklkfTtcclxuICogIC0gR0VUIC9hcGkvc2Vzc2lvbnNcdTMwMDJcclxuICpcclxuICogXHU2RDRCXHU4QkQ1XHU5NEE5XHU1QjUwOkZBS0VfSE9TVF9ESUVfQUZURVJfTVMgLyBGQUtFX0hPU1RfRElFX0FUX0JPT1QgL1xyXG4gKiBGQUtFX0hPU1RfRVhQRUNUX1RPS0VOIC8gRkFLRV9IT1NUX1RBU0tfREVMQVlfTVMgLyBGQUtFX0hPU1RfVEFTS19GQUlMPTFcclxuICogKFx1NEVGQlx1NTJBMVx1NEVFNSBydW4uZmFpbGVkIFx1N0VEM1x1Njc1RixcdTY3ODRcdTkwMjBcdTk1MTlcdThCRUZcdTYwNjJcdTU5MERcdTU3M0FcdTY2NkYpXHUzMDAyXHJcbiAqL1xyXG5pbXBvcnQgeyBjcmVhdGVTZXJ2ZXIsIHR5cGUgU2VydmVyUmVzcG9uc2UgfSBmcm9tICdub2RlOmh0dHAnO1xyXG5pbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSAnbm9kZTpjcnlwdG8nO1xyXG5pbXBvcnQgeyBwYXRoVG9GaWxlVVJMIH0gZnJvbSAnbm9kZTp1cmwnO1xyXG5pbXBvcnQgeyByZWFscGF0aFN5bmMgfSBmcm9tICdub2RlOmZzJztcclxuaW1wb3J0IHsgRVZFTlRfU0NIRU1BX1ZFUlNJT04sIGRlc2t0b3BFcnJvciwgdHlwZSBFdmVudEVudmVsb3BlLCB0eXBlIEV2ZW50S2luZCB9IGZyb20gJ0BobWgtZGVza3RvcC9jb250cmFjdHMnO1xyXG5cclxuZXhwb3J0IGludGVyZmFjZSBGYWtlSG9zdEhhbmRsZSB7XHJcbiAgcG9ydDogbnVtYmVyO1xyXG4gIGVtaXQoc2Vzc2lvbklkOiBzdHJpbmcsIHJ1bklkOiBzdHJpbmcsIGtpbmQ6IEV2ZW50S2luZCwgcGF5bG9hZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBudW1iZXI7XHJcbiAgY2xvc2UoKTogUHJvbWlzZTx2b2lkPjtcclxufVxyXG5cclxuaW50ZXJmYWNlIEZha2VTZXNzaW9uIHtcclxuICBpZDogc3RyaW5nO1xyXG4gIGNyZWF0ZWRBdDogc3RyaW5nO1xyXG4gIHVwZGF0ZWRBdDogc3RyaW5nO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgUGVuZGluZ0FwcHJvdmFsIHtcclxuICBzZXNzaW9uSWQ6IHN0cmluZztcclxuICBhcHByb3ZhbElkOiBzdHJpbmc7XHJcbiAgcmVzb2x2ZShncmFudGVkOiBib29sZWFuKTogdm9pZDtcclxufVxyXG5cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHN0YXJ0RmFrZUhvc3Qob3B0czogeyB0b2tlbjogc3RyaW5nOyBxdWlldD86IGJvb2xlYW4gfSk6IFByb21pc2U8RmFrZUhvc3RIYW5kbGU+IHtcclxuICBjb25zdCB0b2tlbiA9IG9wdHMudG9rZW47XHJcbiAgLy8gXHU2RDRCXHU4QkQ1XHU5NEE5XHU1QjUwOkZBS0VfSE9TVF9FWFBFQ1RfVE9LRU4gXHU4QkE5IGhvc3QgXHU2ODIxXHU5QThDXHU0RTAwXHU0RTJBXHU0RTBFIEhNSF9ERVNLVE9QX1RPS0VOXHJcbiAgLy8gXHU0RTBEXHU1NDBDXHU3Njg0XHU1MDNDKFx1Njc4NFx1OTAyMCBBVVRIX0ZBSUxFRCBcdTU3M0FcdTY2NkY7c3VwZXJ2aXNvciBcdTYwM0JcdTY2MkZcdTg5ODZcdTc2RDYgSE1IX0RFU0tUT1BfVE9LRU4pXHJcbiAgY29uc3QgZXhwZWN0ZWQgPSBwcm9jZXNzLmVudi5GQUtFX0hPU1RfRVhQRUNUX1RPS0VOID8/IHRva2VuO1xyXG4gIGNvbnN0IHRhc2tEZWxheSA9IE51bWJlcihwcm9jZXNzLmVudi5GQUtFX0hPU1RfVEFTS19ERUxBWV9NUyA/PyAzMCk7XHJcbiAgY29uc3QgZmFpbFRhc2tzID0gcHJvY2Vzcy5lbnYuRkFLRV9IT1NUX1RBU0tfRkFJTCA9PT0gJzEnO1xyXG5cclxuICBjb25zdCBzc2VDbGllbnRzID0gbmV3IFNldDxTZXJ2ZXJSZXNwb25zZT4oKTtcclxuICBjb25zdCBzZXFCeVJ1biA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XHJcbiAgLy8gXHU5MUNEXHU2NTNFXHU3M0FGOlx1NjcwMFx1OEZEMSAyMDAgXHU1RTI3KExhc3QtRXZlbnQtSUQgXHU2NUFEXHU3RUJGXHU4ODY1XHU2MkM5KSxcdTRFMEUgaG1oYXJuZXNzIHdlYiBcdTU0MENcdTZCM0VcdThCRURcdTRFNDlcclxuICBjb25zdCByaW5nOiBBcnJheTx7IGlkOiBudW1iZXI7IGV2ZW50OiBzdHJpbmc7IGRhdGE6IHVua25vd24gfT4gPSBbXTtcclxuICBsZXQgcmluZ1NlcSA9IDA7XHJcbiAgY29uc3Qgc2Vzc2lvbnMgPSBuZXcgTWFwPHN0cmluZywgRmFrZVNlc3Npb24+KCk7XHJcbiAgbGV0IHBlbmRpbmc6IFBlbmRpbmdBcHByb3ZhbCB8IG51bGwgPSBudWxsO1xyXG4gIGNvbnN0IHJ1blRpbWVycyA9IG5ldyBNYXA8c3RyaW5nLCBOb2RlSlMuVGltZW91dD4oKTtcclxuICAvLyBcdTVERTVcdTRGNUNcdTUzM0EvUHJvdmlkZXIgXHU3MkI2XHU2MDAxKFx1NEUwRSBobWhhcm5lc3MgXHU1NDBDXHU1RjYyXHU3Njg0XHU2NzAwXHU1QzBGXHU2QTIxXHU2MkRGKVxyXG4gIGNvbnN0IGZha2VXb3Jrc3BhY2VzID0ge1xyXG4gICAgY3VycmVudDogJ3dzLWRlbW8nLFxyXG4gICAgaXRlbXM6IFtcclxuICAgICAgeyBpZDogJ3dzLWRlbW8nLCBuYW1lOiAnZGVtby13b3Jrc3BhY2UnLCBwYXRoOiAnQzpcXFxcZGVtbycgfSxcclxuICAgIF0sXHJcbiAgfTtcclxuICBjb25zdCBmYWtlUHJvdmlkZXJzID0gbmV3IE1hcDxzdHJpbmcsIHsgYmFzZVVybDogc3RyaW5nOyBtb2RlbDogc3RyaW5nOyBhcGlLZXk6IHN0cmluZyB9PihbXHJcbiAgICBbJ2RlbW8nLCB7IGJhc2VVcmw6ICdodHRwOi8vMTI3LjAuMC4xOjkvdjEnLCBtb2RlbDogJ2Zha2UtbScsIGFwaUtleTogJ3NrLWRlbW8tMTIzNCcgfV0sXHJcbiAgICBbJ2RlbW8tdmlzaW9uJywgeyBiYXNlVXJsOiAnaHR0cDovLzEyNy4wLjAuMTo5L3YxJywgbW9kZWw6ICdmYWtlLW0tdmlzaW9uJywgYXBpS2V5OiAnc2stZGVtby01Njc4JyB9XSxcclxuICBdKTtcclxuICBsZXQgZmFrZUNoYXRQcm92aWRlciA9ICdkZW1vJztcclxuXHJcbiAgY29uc3QgZW1pdCA9IChzZXNzaW9uSWQ6IHN0cmluZywgcnVuSWQ6IHN0cmluZywga2luZDogRXZlbnRLaW5kLCBwYXlsb2FkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IG51bWJlciA9PiB7XHJcbiAgICBjb25zdCBrZXkgPSBgJHtzZXNzaW9uSWR9XFwwJHtydW5JZH1gO1xyXG4gICAgY29uc3Qgc2VxID0gKHNlcUJ5UnVuLmdldChrZXkpID8/IDApICsgMTtcclxuICAgIHNlcUJ5UnVuLnNldChrZXksIHNlcSk7XHJcbiAgICBjb25zdCBlbnY6IEV2ZW50RW52ZWxvcGUgPSB7XHJcbiAgICAgIHNjaGVtYVZlcnNpb246IEVWRU5UX1NDSEVNQV9WRVJTSU9OLFxyXG4gICAgICBldmVudElkOiByYW5kb21VVUlEKCksXHJcbiAgICAgIHNlc3Npb25JZCxcclxuICAgICAgcnVuSWQsXHJcbiAgICAgIHNlcSxcclxuICAgICAgb2NjdXJyZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxyXG4gICAgICBraW5kLFxyXG4gICAgICBwYXlsb2FkLFxyXG4gICAgfTtcclxuICAgIGNvbnN0IGlkID0gKytyaW5nU2VxO1xyXG4gICAgcmluZy5wdXNoKHsgaWQsIGV2ZW50OiAnaG1oJywgZGF0YTogZW52IH0pO1xyXG4gICAgaWYgKHJpbmcubGVuZ3RoID4gMjAwKSByaW5nLnNwbGljZSgwLCByaW5nLmxlbmd0aCAtIDIwMCk7XHJcbiAgICBmb3IgKGNvbnN0IGMgb2Ygc3NlQ2xpZW50cykge1xyXG4gICAgICBjLndyaXRlKGBpZDogJHtpZH1cXG5ldmVudDogaG1oXFxuZGF0YTogJHtKU09OLnN0cmluZ2lmeShlbnYpfVxcblxcbmApO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHNlcTtcclxuICB9O1xyXG5cclxuICBjb25zdCB0b3VjaCA9IChzZXNzaW9uSWQ6IHN0cmluZyk6IEZha2VTZXNzaW9uID0+IHtcclxuICAgIGxldCBzID0gc2Vzc2lvbnMuZ2V0KHNlc3Npb25JZCk7XHJcbiAgICBpZiAocyA9PT0gdW5kZWZpbmVkKSB7XHJcbiAgICAgIHMgPSB7IGlkOiBzZXNzaW9uSWQsIGNyZWF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLCB1cGRhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSB9O1xyXG4gICAgICBzZXNzaW9ucy5zZXQoc2Vzc2lvbklkLCBzKTtcclxuICAgIH1cclxuICAgIHMudXBkYXRlZEF0ID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xyXG4gICAgcmV0dXJuIHM7XHJcbiAgfTtcclxuXHJcbiAgLyoqIFx1NkEyMVx1NjJERlx1NEUwMFx1NkIyMVx1NEVGQlx1NTJBMTpcdTYyNzlcdTUxQzZcdTZBMjFcdTVGMEZcdTYzMDJcdThENzdcdTdCNDlcdTVGODUgL2FwaS9hcHByb3ZlXHUzMDAyICovXHJcbiAgY29uc3QgcnVuVGFzayA9IChzZXNzaW9uSWQ6IHN0cmluZywgdGV4dDogc3RyaW5nLCBtb2RlOiBzdHJpbmcpOiBzdHJpbmcgPT4ge1xyXG4gICAgY29uc3QgcnVuSWQgPSBgcnVuLSR7RGF0ZS5ub3coKS50b1N0cmluZygzNil9LSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMiwgOCl9YDtcclxuICAgIHRvdWNoKHNlc3Npb25JZCk7XHJcbiAgICBjb25zdCBzdGVwczogQXJyYXk8KCkgPT4gdm9pZD4gPSBbXTtcclxuICAgIGNvbnN0IHdhaXQgPSAoZm46ICgpID0+IHZvaWQsIG1zID0gdGFza0RlbGF5KTogdm9pZCA9PiB7XHJcbiAgICAgIGNvbnN0IHQgPSBzZXRUaW1lb3V0KGZuLCBtcyk7XHJcbiAgICAgIHJ1blRpbWVycy5zZXQoYCR7c2Vzc2lvbklkfVxcMCR7cnVuSWR9YCwgdCk7XHJcbiAgICB9O1xyXG4gICAgY29uc3QgY2hhaW4gPSAoZm5zOiBBcnJheTwoKSA9PiB2b2lkPik6IHZvaWQgPT4ge1xyXG4gICAgICBjb25zdCBbZmlyc3QsIC4uLnJlc3RdID0gZm5zO1xyXG4gICAgICBpZiAoZmlyc3QgPT09IHVuZGVmaW5lZCkgcmV0dXJuO1xyXG4gICAgICB3YWl0KCgpID0+IHtcclxuICAgICAgICBmaXJzdCgpO1xyXG4gICAgICAgIGNoYWluKHJlc3QpO1xyXG4gICAgICB9KTtcclxuICAgIH07XHJcblxyXG4gICAgZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAncnVuLnN0YXJ0ZWQnLCB7IHRhc2s6IHRleHQsIG1vZGUgfSk7XHJcbiAgICBpZiAoZmFpbFRhc2tzKSB7XHJcbiAgICAgIHdhaXQoKCkgPT4gZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAncnVuLmZhaWxlZCcsIHtcclxuICAgICAgICBlcnJvcjogeyBjb2RlOiAnQVVUSF9GQUlMRUQnLCBtZXNzYWdlOiAnc2ltdWxhdGVkIHByb3ZpZGVyIGF1dGggZmFpbHVyZScsIHJldHJ5YWJsZTogZmFsc2UgfSxcclxuICAgICAgfSkpO1xyXG4gICAgICByZXR1cm4gcnVuSWQ7XHJcbiAgICB9XHJcblxyXG4gICAgY29uc3QgZmluaXNoUnVuID0gKGFuc3dlcjogc3RyaW5nLCB0b29sVXNlczogbnVtYmVyKTogdm9pZCA9PiB7XHJcbiAgICAgIHJ1blRpbWVycy5kZWxldGUoYCR7c2Vzc2lvbklkfVxcMCR7cnVuSWR9YCk7XHJcbiAgICAgIC8vIFx1NEVBNFx1NEVEOFx1NzI2OVx1NTE0OFx1NEU4RVx1N0VDOFx1NjAwMShcdTRFMEUgaG1oYXJuZXNzIGRlc2t0b3AgXHU2ODY1XHU1NDBDXHU1RThGOmFydGlmYWN0LmNyZWF0ZWQgXHUyMTkyIHJ1bi5jb21wbGV0ZWQpXHJcbiAgICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ2FydGlmYWN0LmNyZWF0ZWQnLCB7XHJcbiAgICAgICAgYXJ0aWZhY3Q6IHsgcmVsUGF0aDogJ291dC50eHQnLCBraW5kOiAnZmlsZScsIHRpdGxlOiAnb3V0LnR4dCcgfSxcclxuICAgICAgfSk7XHJcbiAgICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ3J1bi5jb21wbGV0ZWQnLCB7IHRleHQ6IGFuc3dlciwgdHVybnM6IDEsIHRvb2xVc2VzIH0pO1xyXG4gICAgfTtcclxuXHJcbiAgICBjb25zdCBzY3JpcHRlZDogQXJyYXk8KCkgPT4gdm9pZD4gPSBbXHJcbiAgICAgICgpID0+IGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ3Rvb2wuc3RhcnRlZCcsIHsgbmFtZTogJ3JlYWRfZmlsZScsIGFyZ3NQcmV2aWV3OiAne1wicGF0aFwiOlwiUkVBRE1FLm1kXCJ9JyB9KSxcclxuICAgICAgKCkgPT4gZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAndG9vbC5jb21wbGV0ZWQnLCB7IG5hbWU6ICdyZWFkX2ZpbGUnLCBpc0Vycm9yOiBmYWxzZSwgb3V0cHV0UHJldmlldzogJyMgZGVtbycgfSksXHJcbiAgICBdO1xyXG5cclxuICAgIGlmIChtb2RlID09PSAnYXNrJykge1xyXG4gICAgICBzY3JpcHRlZC5wdXNoKCgpID0+IHtcclxuICAgICAgICBjb25zdCBhcHByb3ZhbElkID0gYGFwLSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMiwgOCl9YDtcclxuICAgICAgICBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICdhcHByb3ZhbC5yZXF1aXJlZCcsIHtcclxuICAgICAgICAgIGFwcHJvdmFsSWQsXHJcbiAgICAgICAgICB0b29sOiAnd3JpdGVfZmlsZScsXHJcbiAgICAgICAgICBhcmdzUHJldmlldzogJ3tcInBhdGhcIjpcIm91dC50eHRcIixcImNvbnRlbnRcIjpcImhpXCJ9JyxcclxuICAgICAgICAgIHJpc2s6ICdcdTUxOTlcdTUxNjVcdTVERTVcdTRGNUNcdTUzM0FcdTY1ODdcdTRFRjYgb3V0LnR4dChcdTZBMjFcdTYyREYpJyxcclxuICAgICAgICB9KTtcclxuICAgICAgICBwZW5kaW5nID0ge1xyXG4gICAgICAgICAgc2Vzc2lvbklkLFxyXG4gICAgICAgICAgYXBwcm92YWxJZCxcclxuICAgICAgICAgIHJlc29sdmU6IChncmFudGVkKSA9PiB7XHJcbiAgICAgICAgICAgIHBlbmRpbmcgPSBudWxsO1xyXG4gICAgICAgICAgICBpZiAoZ3JhbnRlZCkge1xyXG4gICAgICAgICAgICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ3Rvb2wuc3RhcnRlZCcsIHsgbmFtZTogJ3dyaXRlX2ZpbGUnLCBhcmdzUHJldmlldzogJ3tcInBhdGhcIjpcIm91dC50eHRcIn0nIH0pO1xyXG4gICAgICAgICAgICAgIHdhaXQoKCkgPT4gZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAndG9vbC5jb21wbGV0ZWQnLCB7IG5hbWU6ICd3cml0ZV9maWxlJywgaXNFcnJvcjogZmFsc2UsIG91dHB1dFByZXZpZXc6ICd3cm90ZSAyIGJ5dGVzJyB9KSk7XHJcbiAgICAgICAgICAgICAgd2FpdCgoKSA9PiBmaW5pc2hSdW4oYGVjaG86ICR7dGV4dH0oXHU1REYyXHU2MjY3XHU4ODRDXHU1MTk5XHU1MTY1KWAsIDMpLCB0YXNrRGVsYXkgKiAyKTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICBmaW5pc2hSdW4oYGVjaG86ICR7dGV4dH0oXHU1QkExXHU2Mjc5XHU4OEFCXHU2MkQyXHU3RURELFx1NjcyQVx1NjI2N1x1ODg0Q1x1NTE5OVx1NTE2NSlgLCAxKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgfSxcclxuICAgICAgICB9O1xyXG4gICAgICB9KTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgIHNjcmlwdGVkLnB1c2goKCkgPT4gZmluaXNoUnVuKGBlY2hvOiAke3RleHR9YCwgMSkpO1xyXG4gICAgfVxyXG4gICAgY2hhaW4oc2NyaXB0ZWQpO1xyXG4gICAgcmV0dXJuIHJ1bklkO1xyXG4gIH07XHJcblxyXG4gIGNvbnN0IHNlcnZlciA9IGNyZWF0ZVNlcnZlcigocmVxLCByZXMpID0+IHtcclxuICAgIGNvbnN0IHVybCA9IG5ldyBVUkwocmVxLnVybCA/PyAnLycsICdodHRwOi8vMTI3LjAuMC4xJyk7XHJcbiAgICBjb25zdCBhdXRob3JpemVkID0gcmVxLmhlYWRlcnNbJ3gtaG1oLWtleSddID09PSBleHBlY3RlZDtcclxuICAgIGNvbnN0IGRlbnkgPSAoKTogdm9pZCA9PiB7XHJcbiAgICAgIHJlcy53cml0ZUhlYWQoNDAxLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdBVVRIX0ZBSUxFRCcsICdtaXNzaW5nIG9yIGludmFsaWQgeC1obWgta2V5JywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XHJcbiAgICB9O1xyXG5cclxuICAgIGNvbnN0IHJlYWRCb2R5ID0gKCk6IFByb21pc2U8c3RyaW5nPiA9PlxyXG4gICAgICBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xyXG4gICAgICAgIGxldCBiID0gJyc7XHJcbiAgICAgICAgcmVxLm9uKCdkYXRhJywgKGM6IEJ1ZmZlcikgPT4geyBiICs9IGMudG9TdHJpbmcoKTsgfSk7XHJcbiAgICAgICAgcmVxLm9uKCdlbmQnLCAoKSA9PiByZXNvbHZlKGIpKTtcclxuICAgICAgfSk7XHJcblxyXG4gICAgaWYgKHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZXZlbnRzJykge1xyXG4gICAgICBpZiAoIWF1dGhvcml6ZWQpIHsgZGVueSgpOyByZXR1cm47IH1cclxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICd0ZXh0L2V2ZW50LXN0cmVhbScsICdjYWNoZS1jb250cm9sJzogJ25vLWNhY2hlJywgY29ubmVjdGlvbjogJ2tlZXAtYWxpdmUnIH0pO1xyXG4gICAgICByZXMuZmx1c2hIZWFkZXJzPy4oKTtcclxuICAgICAgc3NlQ2xpZW50cy5hZGQocmVzKTtcclxuICAgICAgLy8gXHU2NUFEXHU3RUJGXHU4ODY1XHU2MkM5Okxhc3QtRXZlbnQtSUQgXHU0RTRCXHU1MjREXHU3Njg0XHU1RTI3XHU1REYyXHU1NzI4XHU1QkEyXHU2MjM3XHU3QUVGLFx1OTFDRFx1NTNEMVx1NTE3Nlx1NTQwRVx1NzY4NFx1NzNBRlx1NUY2Mlx1N0YxM1x1NTFCMlxyXG4gICAgICBjb25zdCBsYXN0SWQgPSBOdW1iZXIocmVxLmhlYWRlcnNbJ2xhc3QtZXZlbnQtaWQnXSA/PyAwKTtcclxuICAgICAgaWYgKE51bWJlci5pc0Zpbml0ZShsYXN0SWQpICYmIGxhc3RJZCA+IDApIHtcclxuICAgICAgICBmb3IgKGNvbnN0IGUgb2YgcmluZykge1xyXG4gICAgICAgICAgaWYgKGUuaWQgPiBsYXN0SWQpIHJlcy53cml0ZShgaWQ6ICR7ZS5pZH1cXG5ldmVudDogJHtlLmV2ZW50fVxcbmRhdGE6ICR7SlNPTi5zdHJpbmdpZnkoZS5kYXRhKX1cXG5cXG5gKTtcclxuICAgICAgICB9XHJcbiAgICAgIH1cclxuICAgICAgcmVxLm9uKCdjbG9zZScsICgpID0+IHNzZUNsaWVudHMuZGVsZXRlKHJlcykpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAoIWF1dGhvcml6ZWQpIHsgZGVueSgpOyByZXR1cm47IH1cclxuXHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9zdGF0ZScpIHtcclxuICAgICAgLy8gcHJvdmlkZXJzRGV0YWlsOlx1NEUwRSBobWhhcm5lc3MgXHU1NDBDXHU1RjYyXHUyMDE0XHUyMDE0a2V5IFx1NTNFQVx1NTFGQSBoYXNLZXkvXHU2NzJCXHU1NkRCXHU0RjRELFx1NkMzOFx1NEUwRFx1NjYwRVx1NjU4N1xyXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcclxuICAgICAgICBkYWVtb25WZXJzaW9uOiAnZmFrZS0wLjAuMCcsIGRlc2t0b3A6IHRydWUsIG1vZGVsOiBmYWtlUHJvdmlkZXJzLmdldChmYWtlQ2hhdFByb3ZpZGVyKT8ubW9kZWwgPz8gJ2Zha2UtbW9kZWwnLFxyXG4gICAgICAgIGNoYXRQcm92aWRlcjogZmFrZUNoYXRQcm92aWRlciwgbG9jYWxlOiAnemgnLFxyXG4gICAgICAgIGJ1c3lTZXNzaW9uczogWy4uLnNlc3Npb25zLmtleXMoKV0uc2xpY2UoMCwgMiksXHJcbiAgICAgICAgYXBwcm92YWxQZW5kaW5nOiBwZW5kaW5nICE9PSBudWxsLFxyXG4gICAgICAgIHNldHRpbmdzOiB7IGFwcHJvdmFsOiAnYXNrJyB9LFxyXG4gICAgICAgIHdvcmtzcGFjZTogZmFrZVdvcmtzcGFjZXMuaXRlbXMuZmluZCgodykgPT4gdy5pZCA9PT0gZmFrZVdvcmtzcGFjZXMuY3VycmVudCkgPz8gbnVsbCxcclxuICAgICAgICBwcm92aWRlcnNEZXRhaWw6IFsuLi5mYWtlUHJvdmlkZXJzLmVudHJpZXMoKV0ubWFwKChbbmFtZSwgcF0pID0+ICh7XHJcbiAgICAgICAgICBuYW1lLCBtb2RlbDogcC5tb2RlbCwgYmFzZVVybDogcC5iYXNlVXJsLFxyXG4gICAgICAgICAgaGFzS2V5OiBwLmFwaUtleSAhPT0gJycsXHJcbiAgICAgICAgICBrZXlUYWlsOiBwLmFwaUtleS5sZW5ndGggPj0gNCA/IHAuYXBpS2V5LnNsaWNlKC00KSA6IHVuZGVmaW5lZCxcclxuICAgICAgICAgIHB1cnBvc2VzOiBbJ2NoYXQnXSxcclxuICAgICAgICB9KSksXHJcbiAgICAgIH0pKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2Rlc2t0b3Avc2h1dGRvd24nKSB7XHJcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSB9KSk7XHJcbiAgICAgIHNlcnZlci5jbG9zZSgoKSA9PiBwcm9jZXNzLmV4aXQoMCkpO1xyXG4gICAgICBzZXRUaW1lb3V0KCgpID0+IHByb2Nlc3MuZXhpdCgwKSwgMV8wMDApLnVucmVmKCk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9mYWtlL2RpZScpIHtcclxuICAgICAgLy8gXHU2RDRCXHU4QkQ1XHU5NEE5XHU1QjUwOlx1NkEyMVx1NjJERiBob3N0IFx1NUQyOVx1NkU4MyhcdTUxNDhcdTVFOTRcdTdCNTRcdTUxOERcdTkwMDBcdTUxRkEsXHU0RkREXHU4QkMxXHU1NENEXHU1RTk0XHU1REYyXHU1M0QxXHU1MUZBKVxyXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUgfSkpO1xyXG4gICAgICBzZXRUaW1lb3V0KCgpID0+IHByb2Nlc3MuZXhpdCgxKSwgNTApO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvbW9kZWwnKSB7XHJcbiAgICAgIC8vIFx1NkEyMVx1NTc4Qlx1NTIwN1x1NjM2MihcdTRFMEUgaG1oYXJuZXNzIC9hcGkvbW9kZWwgXHU1NDBDXHU1RjYyOlx1NTIwNyBjaGF0IFx1OERFRlx1NzUzMSlcclxuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7IG5hbWU/OiB1bmtub3duIH07XHJcbiAgICAgICAgY29uc3QgbmFtZSA9IHR5cGVvZiBib2R5Lm5hbWUgPT09ICdzdHJpbmcnID8gYm9keS5uYW1lLnRyaW0oKSA6ICcnO1xyXG4gICAgICAgIGlmICghZmFrZVByb3ZpZGVycy5oYXMobmFtZSkpIHtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3Byb3ZpZGVyIG5vdCBmb3VuZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xyXG4gICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBmYWtlQ2hhdFByb3ZpZGVyID0gbmFtZTtcclxuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgbW9kZWw6IGZha2VQcm92aWRlcnMuZ2V0KG5hbWUpPy5tb2RlbCB9KSk7XHJcbiAgICAgIH0pKCk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS90YXNrJykge1xyXG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7IHRleHQ/OiB1bmtub3duOyBzZXNzaW9uSWQ/OiB1bmtub3duOyBtb2RlPzogdW5rbm93bjsgYXR0YWNobWVudHM/OiB1bmtub3duOyBpbWFnZXM/OiB1bmtub3duIH07XHJcbiAgICAgICAgICBjb25zdCB0ZXh0ID0gdHlwZW9mIGJvZHkudGV4dCA9PT0gJ3N0cmluZycgPyBib2R5LnRleHQgOiAnJztcclxuICAgICAgICAgIGNvbnN0IHNlc3Npb25JZCA9IHR5cGVvZiBib2R5LnNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBib2R5LnNlc3Npb25JZCA6IGB3ZWItJHtEYXRlLm5vdygpLnRvU3RyaW5nKDM2KX1gO1xyXG4gICAgICAgICAgY29uc3QgbW9kZSA9IGJvZHkubW9kZSA9PT0gJ2FzaycgfHwgYm9keS5tb2RlID09PSAnYXV0bycgfHwgYm9keS5tb2RlID09PSAneW9sbycgPyBib2R5Lm1vZGUgOiAnYXNrJztcclxuICAgICAgICAgIGNvbnN0IGF0dGFjaG1lbnRzID0gQXJyYXkuaXNBcnJheShib2R5LmF0dGFjaG1lbnRzKSA/IGJvZHkuYXR0YWNobWVudHMuZmlsdGVyKChhKTogYSBpcyBzdHJpbmcgPT4gdHlwZW9mIGEgPT09ICdzdHJpbmcnKSA6IFtdO1xyXG4gICAgICAgICAgLy8gXHU1NkZFXHU3MjQ3XHU5NjQ0XHU0RUY2Olx1NEUwRSBobWhhcm5lc3MgdmlzaW9uIFx1NTM0Rlx1OEJBRVx1NTQwQ1x1NUY2Mih7bmFtZSxkYXRhVXJsfSk7ZmFrZSBcdTY4MjFcdTlBOENcdTVGNjJcdTcyQjZcdTUzNzNcdTY1MzZcclxuICAgICAgICAgIGNvbnN0IGltYWdlcyA9IEFycmF5LmlzQXJyYXkoYm9keS5pbWFnZXMpXHJcbiAgICAgICAgICAgID8gYm9keS5pbWFnZXMuZmlsdGVyKChpbSk6IGltIGlzIHsgbmFtZTogc3RyaW5nOyBkYXRhVXJsOiBzdHJpbmcgfSA9PiB7XHJcbiAgICAgICAgICAgICAgICBpZiAodHlwZW9mIGltICE9PSAnb2JqZWN0JyB8fCBpbSA9PT0gbnVsbCkgcmV0dXJuIGZhbHNlO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgbyA9IGltIGFzIHsgbmFtZT86IHVua25vd247IGRhdGFVcmw/OiB1bmtub3duIH07XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gdHlwZW9mIG8ubmFtZSA9PT0gJ3N0cmluZycgJiYgdHlwZW9mIG8uZGF0YVVybCA9PT0gJ3N0cmluZycgJiYgby5kYXRhVXJsLnN0YXJ0c1dpdGgoJ2RhdGE6aW1hZ2UvJyk7XHJcbiAgICAgICAgICAgICAgfSlcclxuICAgICAgICAgICAgOiBbXTtcclxuICAgICAgICAgIGlmICghdGV4dCkge1xyXG4gICAgICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3RleHQgcmVxdWlyZWQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgfVxyXG4gICAgICAgICAgLy8gXHU0RTBFIGhtaGFybmVzcyBcdTU0MENcdThCRURcdTRFNDk6XHU1NDA4XHU2Q0Q1XHU5NjQ0XHU0RUY2XHU0RUU1IFtyZWZlcmVuY2VkIGZpbGVzXSBcdTUyNERcdTdGMDBcdTVFNzZcdTUxNjVcdTRFRkJcdTUyQTFcdTY1ODdcdTY3MkM7XHJcbiAgICAgICAgICAvLyBcdTU2RkVcdTcyNDdcdTRFRTUgW2ltYWdlc10gXHU1MjREXHU3RjAwXHU2ODA3XHU2Q0U4XHU1RjIwXHU2NTcwKHZpc2lvbiBcdTYzQ0ZcdThGRjBcdTk0RkVcdTU3MjhcdTc3MUZcdTVCOUUgcnVudGltZSBcdTkxQ0NcdTUzRDFcdTc1MUYpXHJcbiAgICAgICAgICBjb25zdCBjb21wb3NlZCA9IGF0dGFjaG1lbnRzLmxlbmd0aCA+IDBcclxuICAgICAgICAgICAgPyBgW3JlZmVyZW5jZWQgZmlsZXNdXFxuJHthdHRhY2htZW50cy5tYXAoKGEpID0+IGAtICR7YS5zcGxpdCgvW1xcXFwvXS8pLnBvcCgpfWApLmpvaW4oJ1xcbicpfVxcblxcbiR7dGV4dH1gXHJcbiAgICAgICAgICAgIDogdGV4dDtcclxuICAgICAgICAgIGNvbnN0IHdpdGhJbWFnZXMgPSBpbWFnZXMubGVuZ3RoID4gMCA/IGBbaW1hZ2VzOiAke2ltYWdlcy5sZW5ndGh9XVxcbiR7Y29tcG9zZWR9YCA6IGNvbXBvc2VkO1xyXG4gICAgICAgICAgY29uc3QgcnVuSWQgPSBydW5UYXNrKHNlc3Npb25JZCwgd2l0aEltYWdlcywgbW9kZSk7XHJcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlLCBydW5JZCwgaW1hZ2VzOiBpbWFnZXMubGVuZ3RoIH0pKTtcclxuICAgICAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgU3RyaW5nKGVycikuc2xpY2UoMCwgMTIwKSwgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XHJcbiAgICAgICAgfVxyXG4gICAgICB9KSgpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvYXBwcm92ZScpIHtcclxuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7IGdyYW50ZWQ/OiB1bmtub3duOyBzZXNzaW9uSWQ/OiB1bmtub3duIH07XHJcbiAgICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIGJvZHkuc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IGJvZHkuc2Vzc2lvbklkIDogJyc7XHJcbiAgICAgICAgaWYgKHBlbmRpbmcgPT09IG51bGwgfHwgKHNpZCAhPT0gJycgJiYgcGVuZGluZy5zZXNzaW9uSWQgIT09IHNpZCkpIHtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ25vIGFwcHJvdmFsIHBlbmRpbmcnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcclxuICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgcCA9IHBlbmRpbmc7XHJcbiAgICAgICAgcGVuZGluZyA9IG51bGw7XHJcbiAgICAgICAgcC5yZXNvbHZlKGJvZHkuZ3JhbnRlZCA9PT0gdHJ1ZSk7XHJcbiAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIGdyYW50ZWQ6IGJvZHkuZ3JhbnRlZCA9PT0gdHJ1ZSB9KSk7XHJcbiAgICAgIH0pKCk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lLnN0YXJ0c1dpdGgoJy9hcGkvc2Vzc2lvbnMvJykgJiYgKHVybC5wYXRobmFtZS5lbmRzV2l0aCgnL2FyY2hpdmUnKSB8fCB1cmwucGF0aG5hbWUuZW5kc1dpdGgoJy9kZWxldGUnKSkpIHtcclxuICAgICAgLy8gXHU0RjFBXHU4QkREXHU1RjUyXHU2ODYzL1x1NTIyMFx1OTY2NChobWhhcm5lc3MgXHU1NDBDXHU1RjYyOlx1NzlGQlx1NTE2NSBhcmNoaXZlL3RyYXNoLFx1NTNFRlx1NjA2Mlx1NTkwRCxcdTRFMERcdTc4NkNcdTUyMjApXHJcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCBwYXJ0cyA9IHVybC5wYXRobmFtZS5zbGljZSgnL2FwaS9zZXNzaW9ucy8nLmxlbmd0aCkuc3BsaXQoJy8nKTtcclxuICAgICAgICBjb25zdCBvcCA9IHBhcnRzWzFdID8/ICcnO1xyXG4gICAgICAgIGNvbnN0IG9pZCA9IGRlY29kZVVSSUNvbXBvbmVudChwYXJ0c1swXSA/PyAnJykucmVwbGFjZSgvW15hLXpBLVowLTlfOi5ALV0vZywgJycpO1xyXG4gICAgICAgIGlmIChvaWQgPT09ICcnIHx8IChvcCAhPT0gJ2FyY2hpdmUnICYmIG9wICE9PSAnZGVsZXRlJykpIHtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ2JhZCBvcCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xyXG4gICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoIXNlc3Npb25zLmhhcyhvaWQpKSB7XHJcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICdzZXNzaW9uIG5vdCBmb3VuZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xyXG4gICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBzZXNzaW9ucy5kZWxldGUob2lkKTtcclxuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSB9KSk7XHJcbiAgICAgIH0pKCk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9pbmplY3QnKSB7XHJcbiAgICAgIC8vIFx1OEZEMFx1ODg0Q1x1NEUyRFx1NkNFOFx1NTE2NShcdTRFMEUgaG1oYXJuZXNzIC9hcGkvaW5qZWN0IFx1NTQwQ1x1NUY2MjtmYWtlIFx1NTNFQVx1NTZERVx1NjI2NylcclxuICAgICAgdm9pZCByZWFkQm9keSgpO1xyXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUgfSkpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvaW50ZXJydXB0Jykge1xyXG4gICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgnJykgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47IC8vIGludGVycnVwdCBcdTY1RTAgYm9keSBcdThCRURcdTRFNDlcclxuICAgICAgdm9pZCBib2R5O1xyXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUgfSkpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9zZXNzaW9ucycpIHtcclxuICAgICAgY29uc3QgbGlzdCA9IFsuLi5zZXNzaW9ucy52YWx1ZXMoKV0ubWFwKChzKSA9PiAoe1xyXG4gICAgICAgIGlkOiBzLmlkLCB0aXRsZTogJycsIHRhc2s6ICcnLCBvdXRjb21lOiAnb2snLCB0dXJuczogMSwgdG9vbFVzZXM6IDEsXHJcbiAgICAgICAgdGltZTogcy51cGRhdGVkQXQsIGN3ZDogJ0M6XFxcXGRlbW8nLCBicmFuY2g6ICcnLCBjcmVhdGVkQXQ6IHMuY3JlYXRlZEF0LCB1cGRhdGVkQXQ6IHMudXBkYXRlZEF0LFxyXG4gICAgICB9KSk7XHJcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBzZXNzaW9uczogbGlzdCwgbmV4dEN1cnNvcjogbnVsbCB9KSk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUuc3RhcnRzV2l0aCgnL2FwaS9zZXNzaW9ucy8nKSkge1xyXG4gICAgICBjb25zdCBzZWcgPSBkZWNvZGVVUklDb21wb25lbnQodXJsLnBhdGhuYW1lLnNsaWNlKCcvYXBpL3Nlc3Npb25zLycubGVuZ3RoKSk7XHJcbiAgICAgIC8vIFx1NUJGQ1x1NTFGQShcdTRFMEUgaG1oYXJuZXNzIC9hcGkvc2Vzc2lvbnMvOmlkL2V4cG9ydC5tZCBcdTU0MENcdTVGNjI6dGV4dC9tYXJrZG93biBcdTRFMEJcdThGN0QpXHJcbiAgICAgIGNvbnN0IGV4cG9ydE1hdGNoID0gL14oLiopXFwvZXhwb3J0XFwubWQkLy5leGVjKHNlZykgPz8gL14oLiopXFwuZXhwb3J0XFwubWQkLy5leGVjKHNlZyk7XHJcbiAgICAgIGlmIChleHBvcnRNYXRjaCAhPT0gbnVsbCAmJiBleHBvcnRNYXRjaFsxXSAhPT0gdW5kZWZpbmVkICYmIGV4cG9ydE1hdGNoWzFdICE9PSAnJykge1xyXG4gICAgICAgIGNvbnN0IGVpZCA9IGV4cG9ydE1hdGNoWzFdLnJlcGxhY2UoL1teYS16QS1aMC05XzouQC1dL2csICcnKTtcclxuICAgICAgICBjb25zdCBlcyA9IHNlc3Npb25zLmdldChlaWQpO1xyXG4gICAgICAgIGlmIChlcyA9PT0gdW5kZWZpbmVkKSB7XHJcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICdzZXNzaW9uIG5vdCBmb3VuZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xyXG4gICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ3RleHQvbWFya2Rvd247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgIHJlcy5lbmQoYCMgaG1oYXJuZXNzIFx1NEYxQVx1OEJERFx1NUJGQ1x1NTFGQShmYWtlKVxcblxcbi0gXHU0RjFBXHU4QkREOiR7ZWlkfVxcblxcbiMjIFx1NzUyOFx1NjIzN1xcblxcblx1NEU0Qlx1NTI0RFx1NzY4NFx1NEVGQlx1NTJBMShmYWtlIFx1OTg4NFx1ODlDOClcXG5cXG4jIyBcdTUyQTlcdTYyNEJcXG5cXG5cdThGRDlcdTY2MkZcdTVCRkNcdTUxRkFcdTc2ODRcdTU2REVcdTU5MERcdTk4ODRcdTg5QzgoZmFrZSlcdTMwMDJcXG5gKTtcclxuICAgICAgICByZXR1cm47XHJcbiAgICAgIH1cclxuICAgICAgLy8gXHU0RjFBXHU4QkREXHU5ODg0XHU4OUM4KFx1NEUwRSBobWhhcm5lc3MgR0VUIC9hcGkvc2Vzc2lvbnMvOmlkIFx1NTQwQ1x1NUY2MjpcdTY3MDBcdTU0MEUgODAgXHU2NzYxLFx1NkJDRlx1Njc2MSA1MDAgXHU1QjU3KVxyXG4gICAgICBjb25zdCBpZCA9IHNlZy5yZXBsYWNlKC9bXmEtekEtWjAtOV86LkAtXS9nLCAnJyk7XHJcbiAgICAgIGNvbnN0IHMgPSBzZXNzaW9ucy5nZXQoaWQpO1xyXG4gICAgICBpZiAocyA9PT0gdW5kZWZpbmVkKSB7XHJcbiAgICAgICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3Nlc3Npb24gbm90IGZvdW5kJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgICB9XHJcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xyXG4gICAgICAgIGlkLCBtb2RlbDogJ2Zha2UtbW9kZWwnLCBjd2Q6ICdDOlxcXFxkZW1vJyxcclxuICAgICAgICBtZXNzYWdlczogW1xyXG4gICAgICAgICAgeyByb2xlOiAndXNlcicsIHRleHQ6ICdcdTRFNEJcdTUyNERcdTc2ODRcdTRFRkJcdTUyQTEoZmFrZSBcdTk4ODRcdTg5QzgpJywgdG9vbHM6IFtdIH0sXHJcbiAgICAgICAgICB7IHJvbGU6ICdhc3Npc3RhbnQnLCB0ZXh0OiAnXHU4RkQ5XHU2NjJGXHU1Mzg2XHU1M0YyXHU0RjFBXHU4QkREXHU3Njg0XHU1NkRFXHU1OTBEXHU5ODg0XHU4OUM4KGZha2UpXHUzMDAyJywgdG9vbHM6IFsncmVhZF9maWxlJ10gfSxcclxuICAgICAgICBdLFxyXG4gICAgICB9KSk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2ZzJykge1xyXG4gICAgICAvLyBcdTc2RUVcdTVGNTVcdTZENEZcdTg5QzgoXHU0RTBFIGhtaGFybmVzcyBcdTU0MENcdTVGNjI6cGF0aCBcdTc3MDFcdTc1NjU9XHU2ODM5O2ZpbGVzPTEgXHU5NjQ0XHU1RTI2XHU2NTg3XHU0RUY2XHU1MjE3XHU4ODY4KVxyXG4gICAgICBjb25zdCBxID0gdXJsLnNlYXJjaFBhcmFtcy5nZXQoJ3BhdGgnKSA/PyAnJztcclxuICAgICAgY29uc3Qgd2l0aEZpbGVzID0gdXJsLnNlYXJjaFBhcmFtcy5nZXQoJ2ZpbGVzJykgPT09ICcxJztcclxuICAgICAgaWYgKHEgPT09ICcnKSB7XHJcbiAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcclxuICAgICAgICAgIHBhdGg6ICcnLCBzZWdtZW50czogW10sIHBhcmVudDogJycsXHJcbiAgICAgICAgICBkaXJzOiBbeyBuYW1lOiAnZGVtby13b3Jrc3BhY2UnLCBwYXRoOiAnQzpcXFxcZGVtbycgfV0sXHJcbiAgICAgICAgICAuLi4od2l0aEZpbGVzID8geyBmaWxlczogW10gfSA6IHt9KSxcclxuICAgICAgICB9KSk7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgICB9XHJcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xyXG4gICAgICAgIHBhdGg6IHEsIHNlZ21lbnRzOiBbeyBuYW1lOiBxLnNwbGl0KC9bXFxcXC9dLykuZmlsdGVyKEJvb2xlYW4pLnBvcCgpID8/IHEsIHBhdGg6IHEgfV0sIHBhcmVudDogJycsXHJcbiAgICAgICAgZGlyczogW3sgbmFtZTogJ3NyYycsIHBhdGg6IGAke3EucmVwbGFjZSgvW1xcXFwvXSQvLCAnJyl9XFxcXHNyY2AgfV0sXHJcbiAgICAgICAgLi4uKHdpdGhGaWxlcyA/IHsgZmlsZXM6IFtcclxuICAgICAgICAgIHsgbmFtZTogJ1JFQURNRS5tZCcsIHBhdGg6IGAke3EucmVwbGFjZSgvW1xcXFwvXSQvLCAnJyl9XFxcXFJFQURNRS5tZGAsIHJlbDogJ1JFQURNRS5tZCcgfSxcclxuICAgICAgICAgIHsgbmFtZTogJ3BhY2thZ2UuanNvbicsIHBhdGg6IGAke3EucmVwbGFjZSgvW1xcXFwvXSQvLCAnJyl9XFxcXHBhY2thZ2UuanNvbmAsIHJlbDogJ3BhY2thZ2UuanNvbicgfSxcclxuICAgICAgICBdIH0gOiB7fSksXHJcbiAgICAgIH0pKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZnMvcmVhZCcpIHtcclxuICAgICAgLy8gXHU2NTg3XHU0RUY2XHU5ODg0XHU4OUM4KDY0S0IgXHU0RTBBXHU5NjUwXHU4QkVEXHU0RTQ5O2Zha2UgXHU4RkQ0XHU1NkRFXHU1NkZBXHU1QjlBXHU2NTg3XHU2NzJDKVxyXG4gICAgICBjb25zdCBwID0gdXJsLnNlYXJjaFBhcmFtcy5nZXQoJ3BhdGgnKSA/PyAnJztcclxuICAgICAgaWYgKHAgPT09ICcnKSB7XHJcbiAgICAgICAgcmVzLndyaXRlSGVhZCg0MDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3BhdGggcmVxdWlyZWQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcclxuICAgICAgICByZXR1cm47XHJcbiAgICAgIH1cclxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XHJcbiAgICAgICAgcGF0aDogcCwgcmVsOiBwLnNwbGl0KC9bXFxcXC9dLykucG9wKCkgPz8gcCwgc2l6ZTogNDIsXHJcbiAgICAgICAgdGV4dDogJyMgZGVtbyB3b3Jrc3BhY2VcXG5cXG5cdThGRDlcdTY2MkYgZmFrZSBob3N0IFx1NzY4NFx1NjU4N1x1NEVGNlx1OTg4NFx1ODlDOFx1NTE4NVx1NUJCOVx1MzAwMlxcbicsXHJcbiAgICAgIH0pKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZGlmZicpIHtcclxuICAgICAgLy8gRGlmZiBcdTk3NjJcdTY3N0YoXHU0RTBFIGhtaGFybmVzcyAvYXBpL2RpZmYgXHU1NDBDXHU1RjYyO2Zha2UgXHU4RkQ0XHU1NkRFXHU1NkZBXHU1QjlBXHU1QzBGXHU1M0Q4XHU2NkY0XHU5NkM2KVxyXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcclxuICAgICAgICBnaXQ6IHRydWUsIGN3ZDogJ0M6XFxcXGRlbW8nLFxyXG4gICAgICAgIGNoYW5nZWQ6IFtcclxuICAgICAgICAgIHsgc3RhdGU6ICdNJywgcGF0aDogJ3NyYy9hcHAudHMnIH0sXHJcbiAgICAgICAgICB7IHN0YXRlOiAnQScsIHBhdGg6ICdkb2NzL25vdGVzLm1kJyB9LFxyXG4gICAgICAgIF0sXHJcbiAgICAgICAgc3RhdDogJyBzcmMvYXBwLnRzICAgICAgfCAxMiArKysrKysrLS0tXFxuIGRvY3Mvbm90ZXMubWQgICB8ICA0ICsrKytcXG4gMiBmaWxlcyBjaGFuZ2VkLCAxNiBpbnNlcnRpb25zKCspLCAzIGRlbGV0aW9ucygtKScsXHJcbiAgICAgIH0pKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvd29ya3NwYWNlcycpIHtcclxuICAgICAgLy8gXHU1REU1XHU0RjVDXHU1MzNBKFx1NEUwRSBobWhhcm5lc3MgXHU1NDBDXHU1RjYyOmN1cnJlbnQgKyBpdGVtcylcclxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XHJcbiAgICAgICAgY3VycmVudDogZmFrZVdvcmtzcGFjZXMuY3VycmVudCxcclxuICAgICAgICBpdGVtczogZmFrZVdvcmtzcGFjZXMuaXRlbXMsXHJcbiAgICAgIH0pKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3dvcmtzcGFjZXMnKSB7XHJcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgoYXdhaXQgcmVhZEJvZHkoKSkgfHwgJ3t9JykgYXMgeyBuYW1lPzogdW5rbm93bjsgcGF0aD86IHVua25vd24gfTtcclxuICAgICAgICBjb25zdCBwYXRoID0gdHlwZW9mIGJvZHkucGF0aCA9PT0gJ3N0cmluZycgPyBib2R5LnBhdGggOiAnJztcclxuICAgICAgICBjb25zdCBuYW1lID0gdHlwZW9mIGJvZHkubmFtZSA9PT0gJ3N0cmluZycgJiYgYm9keS5uYW1lICE9PSAnJyA/IGJvZHkubmFtZSA6IChwYXRoLnNwbGl0KC9bXFxcXC9dLykuZmlsdGVyKEJvb2xlYW4pLnBvcCgpID8/ICcnKTtcclxuICAgICAgICBpZiAocGF0aCA9PT0gJycgfHwgbmFtZSA9PT0gJycpIHtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ2Fic29sdXRlIHBhdGggYW5kIG5hbWUgcmVxdWlyZWQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcclxuICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGZha2VXb3Jrc3BhY2VzLml0ZW1zLnNvbWUoKHcpID0+IHcucGF0aC50b0xvd2VyQ2FzZSgpID09PSBwYXRoLnRvTG93ZXJDYXNlKCkpKSB7XHJcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwOSwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICd3b3Jrc3BhY2UgYWxyZWFkeSByZWdpc3RlcmVkJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XHJcbiAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGl0ZW0gPSB7IGlkOiBgd3MtJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCA4KX1gLCBuYW1lLCBwYXRoIH07XHJcbiAgICAgICAgZmFrZVdvcmtzcGFjZXMuaXRlbXMucHVzaChpdGVtKTtcclxuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgY3VycmVudDogZmFrZVdvcmtzcGFjZXMuY3VycmVudCwgaXRlbXM6IGZha2VXb3Jrc3BhY2VzLml0ZW1zIH0pKTtcclxuICAgICAgfSkoKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3dvcmtzcGFjZXMvdXNlJykge1xyXG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoKGF3YWl0IHJlYWRCb2R5KCkpIHx8ICd7fScpIGFzIHsgaWQ/OiB1bmtub3duIH07XHJcbiAgICAgICAgY29uc3QgaGl0ID0gZmFrZVdvcmtzcGFjZXMuaXRlbXMuZmluZCgodykgPT4gdy5pZCA9PT0gYm9keS5pZCk7XHJcbiAgICAgICAgaWYgKGhpdCA9PT0gdW5kZWZpbmVkKSB7XHJcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICd3b3Jrc3BhY2Ugbm90IGZvdW5kJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XHJcbiAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGZha2VXb3Jrc3BhY2VzLmN1cnJlbnQgPSBoaXQuaWQ7XHJcbiAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIGN1cnJlbnQ6IGZha2VXb3Jrc3BhY2VzLmN1cnJlbnQsIGl0ZW1zOiBmYWtlV29ya3NwYWNlcy5pdGVtcyB9KSk7XHJcbiAgICAgIH0pKCk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9wcm92aWRlcnMnKSB7XHJcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgoYXdhaXQgcmVhZEJvZHkoKSkgfHwgJ3t9JykgYXMgeyBuYW1lPzogdW5rbm93bjsgYmFzZVVybD86IHVua25vd247IG1vZGVsPzogdW5rbm93bjsgYXBpS2V5PzogdW5rbm93biB9O1xyXG4gICAgICAgIGNvbnN0IG5hbWUgPSB0eXBlb2YgYm9keS5uYW1lID09PSAnc3RyaW5nJyA/IGJvZHkubmFtZS50cmltKCkgOiAnJztcclxuICAgICAgICBjb25zdCBiYXNlVXJsID0gdHlwZW9mIGJvZHkuYmFzZVVybCA9PT0gJ3N0cmluZycgPyBib2R5LmJhc2VVcmwudHJpbSgpIDogJyc7XHJcbiAgICAgICAgY29uc3QgbW9kZWwgPSB0eXBlb2YgYm9keS5tb2RlbCA9PT0gJ3N0cmluZycgPyBib2R5Lm1vZGVsLnRyaW0oKSA6ICcnO1xyXG4gICAgICAgIGlmIChuYW1lID09PSAnJyB8fCBiYXNlVXJsID09PSAnJyB8fCBtb2RlbCA9PT0gJycpIHtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ25hbWUsIGJhc2VVcmwgYW5kIG1vZGVsIGFyZSByZXF1aXJlZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xyXG4gICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBmYWtlUHJvdmlkZXJzLnNldChuYW1lLCB7IGJhc2VVcmwsIG1vZGVsLCBhcGlLZXk6IHR5cGVvZiBib2R5LmFwaUtleSA9PT0gJ3N0cmluZycgPyBib2R5LmFwaUtleSA6ICcnIH0pO1xyXG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlLCBuYW1lIH0pKTtcclxuICAgICAgfSkoKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZnMvc2VhcmNoJykge1xyXG4gICAgICAvLyBcdTVERTVcdTRGNUNcdTUzM0FcdTY1ODdcdTRFRjZcdTY0MUNcdTdEMjIoXHU0RTBFIGhtaGFybmVzcyBcdTU0MENcdTVGNjI6QFx1OTY0NFx1NEVGNlx1OTAwOVx1NjJFOVx1NTY2OFx1NzY4NFx1NjU3MFx1NjM2RVx1NkU5MClcclxuICAgICAgY29uc3QgcSA9ICh1cmwuc2VhcmNoUGFyYW1zLmdldCgncScpID8/ICcnKS50cmltKCkudG9Mb3dlckNhc2UoKTtcclxuICAgICAgY29uc3QgYWxsID0gW1xyXG4gICAgICAgIHsgcmVsOiAnUkVBRE1FLm1kJywgcGF0aDogJ0M6XFxcXGRlbW9cXFxcUkVBRE1FLm1kJywga2luZDogJ2ZpbGUnIH0sXHJcbiAgICAgICAgeyByZWw6ICdzcmMvYXBwLnRzJywgcGF0aDogJ0M6XFxcXGRlbW9cXFxcc3JjXFxcXGFwcC50cycsIGtpbmQ6ICdmaWxlJyB9LFxyXG4gICAgICAgIHsgcmVsOiAnZG9jcy9ub3Rlcy5tZCcsIHBhdGg6ICdDOlxcXFxkZW1vXFxcXGRvY3NcXFxcbm90ZXMubWQnLCBraW5kOiAnZmlsZScgfSxcclxuICAgICAgXTtcclxuICAgICAgY29uc3QgaGl0cyA9IHEgPT09ICcnID8gYWxsIDogYWxsLmZpbHRlcigoZikgPT4gZi5yZWwudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhxKSk7XHJcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyByZXN1bHRzOiBoaXRzLnNsaWNlKDAsIDIwKSwgdHJ1bmNhdGVkOiBmYWxzZSwgdG90YWw6IGhpdHMubGVuZ3RoIH0pKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvY29nbml0aXZlJykge1xyXG4gICAgICAvLyBcdThCQTRcdTc3RTVcdTcyQjZcdTYwMDEoXHU0RTBFIGhtaGFybmVzcyBjb2duaXRpdmVTdGF0dXMgXHU1NDBDXHU1RjYyXHU1QjUwXHU5NkM2O1x1N0YzQVx1NjU3MFx1NjM2RVx1NjYzRVx1NUYwRiBudWxsKVxyXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcclxuICAgICAgICBtZW1vcnk6IHsgbGF5ZXJzOiAzLCBlbnRyaWVzOiAxMiwgY29udHJhZGljdGlvbnM6IDAgfSxcclxuICAgICAgICB0cmFqZWN0b3JpZXM6IDcsXHJcbiAgICAgICAgYXVkaXRFdmVudHM6IDIxLFxyXG4gICAgICAgIHdvcmxkTW9kZWw6IHsgdmVyc2lvbjogNCwgYmVsaWVmczogOSwgdHJ1c3RlZDogNSwgYnJpZXI6IDAuMzEgfSxcclxuICAgICAgICBjYWxpYnJhdGlvbjogeyBwcmVkaWN0aW9uczogNDYsIHJlbGlhYmlsaXR5OiAwLjcyIH0sXHJcbiAgICAgIH0pKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2Zha2UvZW1pdCcpIHtcclxuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgoYXdhaXQgcmVhZEJvZHkoKSkgfHwgJ3t9JykgYXMge1xyXG4gICAgICAgICAgICBzZXNzaW9uSWQ6IHN0cmluZzsgcnVuSWQ6IHN0cmluZzsga2luZDogRXZlbnRLaW5kOyBwYXlsb2FkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcclxuICAgICAgICAgIH07XHJcbiAgICAgICAgICBjb25zdCBzZXEgPSBlbWl0KGJvZHkuc2Vzc2lvbklkLCBib2R5LnJ1bklkLCBib2R5LmtpbmQsIGJvZHkucGF5bG9hZCk7XHJcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlLCBzZXEgfSkpO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCBTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcclxuICAgICAgICB9XHJcbiAgICAgIH0pKCk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgYG5vIHJvdXRlICR7cmVxLm1ldGhvZH0gJHt1cmwucGF0aG5hbWV9YCwgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XHJcbiAgfSk7XHJcblxyXG4gIGF3YWl0IG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcclxuICAgIHNlcnZlci5vbmNlKCdlcnJvcicsIHJlamVjdCk7XHJcbiAgICBzZXJ2ZXIubGlzdGVuKDAsICcxMjcuMC4wLjEnLCAoKSA9PiByZXNvbHZlKCkpO1xyXG4gIH0pO1xyXG4gIGNvbnN0IGFkZHJlc3MgPSBzZXJ2ZXIuYWRkcmVzcygpO1xyXG4gIGlmIChhZGRyZXNzID09PSBudWxsIHx8IHR5cGVvZiBhZGRyZXNzICE9PSAnb2JqZWN0JykgdGhyb3cgbmV3IEVycm9yKCdmYWtlIGhvc3Q6IG5vIHBvcnQnKTtcclxuICBjb25zdCBwb3J0ID0gYWRkcmVzcy5wb3J0O1xyXG5cclxuICBpZiAoIW9wdHMucXVpZXQpIHtcclxuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KHsgaG1oRGVza3RvcEhvc3RSZWFkeTogdHJ1ZSwgcG9ydCwgdmVyc2lvbjogJ2Zha2UtMC4wLjAnIH0pfVxcbmApO1xyXG4gIH1cclxuICBjb25zdCBkaWVBZnRlciA9IE51bWJlcihwcm9jZXNzLmVudi5GQUtFX0hPU1RfRElFX0FGVEVSX01TID8/IDApO1xyXG4gIGlmIChOdW1iZXIuaXNGaW5pdGUoZGllQWZ0ZXIpICYmIGRpZUFmdGVyID4gMCkge1xyXG4gICAgc2V0VGltZW91dCgoKSA9PiBwcm9jZXNzLmV4aXQoMSksIGRpZUFmdGVyKS51bnJlZigpO1xyXG4gIH1cclxuXHJcbiAgLy8gY2xvc2UoKTogXHU1MTQ4XHU2NUFEXHU1RjAwXHU1MTY4XHU5MEU4IFNTRSBcdThGREVcdTYzQTUoXHU1QjgzXHU0RUVDXHU2QzM4XHU0RTBEXHU4MUVBXHU3MTM2XHU1MTczXHU5NUVEKSxcdTU0MjZcdTUyMTkgc2VydmVyLmNsb3NlXHJcbiAgLy8gXHU0RjFBXHU0RTAwXHU3NkY0XHU3QjQ5XHU2RDNCXHU4REMzXHU4RkRFXHU2M0E1LFx1NkQ0Qlx1OEJENVx1OEZEQlx1N0EwQlx1NjMwMlx1NkI3Qlx1MzAwMlxyXG4gIGNvbnN0IGNsb3NlID0gKCk6IFByb21pc2U8dm9pZD4gPT5cclxuICAgIG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlKSA9PiB7XHJcbiAgICAgIGZvciAoY29uc3QgYyBvZiBzc2VDbGllbnRzKSB7XHJcbiAgICAgICAgdHJ5IHsgYy5lbmQoKTsgYy5kZXN0cm95KCk7IH0gY2F0Y2ggeyAvKiBhbHJlYWR5IGdvbmUgKi8gfVxyXG4gICAgICB9XHJcbiAgICAgIHNzZUNsaWVudHMuY2xlYXIoKTtcclxuICAgICAgc2VydmVyLmNsb3NlKCgpID0+IHJlc29sdmUoKSk7XHJcbiAgICAgIHNldFRpbWVvdXQoKCkgPT4gcmVzb2x2ZSgpLCAxXzAwMCkudW5yZWYoKTtcclxuICAgIH0pO1xyXG5cclxuICByZXR1cm4geyBwb3J0LCBlbWl0LCBjbG9zZSB9O1xyXG59XHJcblxyXG4vLyBcdTc2RjRcdTYzQTVcdThGRDBcdTg4NEMoc3VwZXJ2aXNvciBzcGF3biBcdTc2ODRcdTVCNTBcdThGREJcdTdBMEJcdTVGNjJcdTYwMDEpXHUzMDAycmVhbHBhdGggXHU2QkQ0XHU4RjgzOm5wbSB3b3Jrc3BhY2VcclxuLy8ganVuY3Rpb24gLyBcdTU5MjdcdTVDMEZcdTUxOTlcdTVERUVcdTVGMDJcdTkwRkRcdTRFMERcdTgwRkRcdThCQTlcdThGRDlcdTRFMkFcdTY4QzBcdTZENEJcdTU5MzFcdTYyNEIoXHU1OTMxXHU2MjRCPVx1OTc1OVx1OUVEOFx1OTAwMFx1NTFGQSBjb2RlIDAsXHU5NkJFXHU2N0U1KVx1MzAwMlxyXG4vLyBjanMgYnVuZGxlKGVzYnVpbGQsXHU2MjUzXHU1MzA1XHU0RUE3XHU1NEMxKVx1NEUwQiBfX2ZpbGVuYW1lIFx1NUI1OFx1NTcyODtFU00odHN4L1x1NkU5MFx1NzgwMSlcdTc1MjggaW1wb3J0Lm1ldGFcdTMwMDJcclxuY29uc3Qgc2VsZlVybDogc3RyaW5nID0gdHlwZW9mIF9fZmlsZW5hbWUgPT09ICdzdHJpbmcnXHJcbiAgPyBwYXRoVG9GaWxlVVJMKHJlYWxwYXRoU3luYyhfX2ZpbGVuYW1lKSkuaHJlZlxyXG4gIDogaW1wb3J0Lm1ldGEudXJsO1xyXG5jb25zdCBpbnZva2VkQXNTY3JpcHQgPSAoKCkgPT4ge1xyXG4gIGlmIChwcm9jZXNzLmFyZ3ZbMV0gPT09IHVuZGVmaW5lZCkgcmV0dXJuIGZhbHNlO1xyXG4gIHRyeSB7XHJcbiAgICByZXR1cm4gc2VsZlVybCA9PT0gcGF0aFRvRmlsZVVSTChyZWFscGF0aFN5bmMocHJvY2Vzcy5hcmd2WzFdKSkuaHJlZjtcclxuICB9IGNhdGNoIHtcclxuICAgIHJldHVybiBmYWxzZTtcclxuICB9XHJcbn0pKCk7XHJcbmlmIChpbnZva2VkQXNTY3JpcHQpIHtcclxuICBjb25zdCB0b2tlbiA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1RPS0VOID8/ICcnO1xyXG4gIC8vIEZBS0VfSE9TVF9ESUVfQVRfQk9PVD0xOlx1NUYxNVx1NUJGQ1x1ODg0Q1x1OEY5M1x1NTFGQVx1NTI0RFx1NTM3M1x1NkI3QihcdTY3ODRcdTkwMjBcdTU0MkZcdTUyQThcdTY3MUYgUlVOVElNRV9DUkFTSEVEKVxyXG4gIGlmIChwcm9jZXNzLmVudi5GQUtFX0hPU1RfRElFX0FUX0JPT1QgPT09ICcxJykge1xyXG4gICAgcHJvY2Vzcy5leGl0KDEpO1xyXG4gIH1cclxuICBjb25zdCBzbG93ID0gTnVtYmVyKHByb2Nlc3MuZW52LkZBS0VfSE9TVF9TTE9XX0FGVEVSID8/IDApO1xyXG4gIGNvbnN0IGJvb3QgPSAoKTogdm9pZCA9PiB7XHJcbiAgICB2b2lkIHN0YXJ0RmFrZUhvc3QoeyB0b2tlbiB9KS5jYXRjaCgoZXJyKSA9PiB7XHJcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBmYWtlLWhvc3QgZmFpbGVkOiAke1N0cmluZyhlcnIpfVxcbmApO1xyXG4gICAgICBwcm9jZXNzLmV4aXQoMSk7XHJcbiAgICB9KTtcclxuICB9O1xyXG4gIGlmIChOdW1iZXIuaXNGaW5pdGUoc2xvdykgJiYgc2xvdyA+IDApIHNldFRpbWVvdXQoYm9vdCwgc2xvdyk7XHJcbiAgZWxzZSBib290KCk7XHJcbn1cclxuIiwgIi8qKlxyXG4gKiBVSVZFUklGWSBcdTk0QTlcdTVCNTAgXHUyMDE0XHUyMDE0IFx1OTAxMFx1NTI5Rlx1ODBGRFx1NzcxRlx1NUI5RSBVSSBcdTlBNzFcdTUyQThcdTlBOENcdTY1MzYoMjAyNi0xMC0xMCBcdTc1MjhcdTYyMzdcdTYzMDdcdTRFRTQ6XHJcbiAqIFwiXHU1QkY5XHU2QkNGXHU0RTAwXHU0RTJBXHU1MjlGXHU4MEZELFx1NkJDRlx1NEUwMFx1NEUyQVx1NEUxQVx1NTJBMVx1NkQ0MVx1N0EwQlx1NTE2OFx1OTc2Mlx1NzY4NFx1OUE4Q1x1NjUzNlwiKVx1MzAwMlxyXG4gKlxyXG4gKiBcdTc2RjRcdTYzQTVcdTVCRjlcdTZFMzJcdTY3RDNcdTU0MEVcdTc2ODQgRE9NIFx1NjVBRFx1OEEwMChcdTVFMDNcdTVDNDBcdTUxRTBcdTRGNTUvXHU1M0VGXHU4OUMxXHU2MDI3KSxcdTVFNzZcdTc1MjhcdTUzOUZcdTc1MUZcdTRFOEJcdTRFRjZcdTlBNzFcdTUyQTggUmVhY3RcclxuICogKFx1NTNEN1x1NjNBN1x1OEY5M1x1NTE2NVx1NzUyOFx1NTM5Rlx1NTc4QiBzZXR0ZXIgKyBpbnB1dCBcdTRFOEJcdTRFRjY7XHU2MzA5XHU5NEFFIGNsaWNrO1x1OTUyRVx1NzZEOFx1OEQ3MCB3aW5kb3dcclxuICoga2V5ZG93bilcdTMwMDJmYWtlIFx1NkEyMVx1NUYwRlx1OEREMVx1NUI4Q1x1NjU3NFx1NEVGQlx1NTJBMVx1OTRGRShcdTUzRDFcdTkwMDFcdTIxOTJcdTVERTVcdTUxNzdcdTIxOTJcdTVCQTFcdTYyNzlcdTIxOTJcdTRFQTRcdTRFRDhcdTcyNjlcdTIxOTJcdTZDNDdcdTYwM0IpO1xyXG4gKiByZWFsIFx1NkEyMVx1NUYwRlx1NTNFQVx1OEREMVx1NTNFQVx1OEJGQlx1NUI1MFx1OTZDNihcdTRFMERcdTUyQThcdTc3MUZcdTVCOUVcdTRGMUFcdThCRERcdTMwMDFcdTRFMERcdTcwRTcgdG9rZW4pXHUzMDAyXHJcbiAqIFx1NkJDRlx1NkI2NVx1OEY5M1x1NTFGQSBgVUlWRVJJRlkgUEFTU3xGQUlMIG5hbWUgfCBkZXRhaWxgLFx1N0VEM1x1NUMzRSBTVU1NQVJZLGV4aXQgY29kZVx1MzAwMlxyXG4gKi9cclxuaW1wb3J0IHsgYXBwLCB0eXBlIEJyb3dzZXJXaW5kb3cgfSBmcm9tICdlbGVjdHJvbic7XHJcbmltcG9ydCB7IG1rZGlyLCB3cml0ZUZpbGUgfSBmcm9tICdub2RlOmZzL3Byb21pc2VzJztcclxuaW1wb3J0IHsgam9pbiB9IGZyb20gJ25vZGU6cGF0aCc7XHJcblxyXG5jb25zdCBzbGVlcCA9IChtczogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiA9PiBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCBtcykpO1xyXG5cclxuYXN5bmMgZnVuY3Rpb24gcnVuVWlWZXJpZnkod2luOiBCcm93c2VyV2luZG93LCBtb2RlOiAnZmFrZScgfCAncmVhbCcpOiBQcm9taXNlPHZvaWQ+IHtcclxuICBjb25zdCBzaG90cyA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX1NIT1RTID8/IGpvaW4oYXBwLmdldFBhdGgoJ3RlbXAnKSwgJ2htaC11aXZlcmlmeScpO1xyXG4gIGF3YWl0IG1rZGlyKHNob3RzLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KS5jYXRjaCgoKSA9PiB1bmRlZmluZWQpO1xyXG4gIGNvbnN0IHJlc3VsdHM6IEFycmF5PFtzdHJpbmcsIGJvb2xlYW4sIHN0cmluZ10+ID0gW107XHJcbiAgbGV0IHNob3RJZHggPSAwO1xyXG5cclxuICBjb25zdCBqcyA9IDxUPihjb2RlOiBzdHJpbmcpOiBQcm9taXNlPFQ+ID0+IHdpbi53ZWJDb250ZW50cy5leGVjdXRlSmF2YVNjcmlwdChjb2RlLCB0cnVlKSBhcyBQcm9taXNlPFQ+O1xyXG4gIGNvbnN0IHN0ZXAgPSBhc3luYyAobmFtZTogc3RyaW5nLCBmbjogKCkgPT4gUHJvbWlzZTxbYm9vbGVhbiwgc3RyaW5nXT4pOiBQcm9taXNlPHZvaWQ+ID0+IHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IFtvaywgZGV0YWlsXSA9IGF3YWl0IGZuKCk7XHJcbiAgICAgIHJlc3VsdHMucHVzaChbbmFtZSwgb2ssIGRldGFpbF0pO1xyXG4gICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgIGNvbnN0IGRldGFpbCA9IGVyciBpbnN0YW5jZW9mIEVycm9yICYmIGVyci5zdGFjayAhPT0gdW5kZWZpbmVkID8gZXJyLnN0YWNrIDogU3RyaW5nKGVycik7XHJcbiAgICAgIHJlc3VsdHMucHVzaChbbmFtZSwgZmFsc2UsIGRldGFpbC5zbGljZSgwLCAzMDApXSk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBsYXN0ID0gcmVzdWx0c1tyZXN1bHRzLmxlbmd0aCAtIDFdITtcclxuICAgIGNvbnNvbGUubG9nKGBVSVZFUklGWSAke2xhc3RbMV0gPyAnUEFTUycgOiAnRkFJTCd9IHwgJHtsYXN0WzBdfSB8ICR7bGFzdFsyXX1gKTtcclxuICB9O1xyXG4gIC8qKiBcdThGNkVcdThCRTJcdTc2RjRcdTUyMzAgcHJlZGljYXRlQ29kZSBcdThGRDRcdTU2REUge29rOnRydWUsLi4ufSBcdTYyMTZcdThEODVcdTY1RjYoXHU4RkQ0XHU1NkRFXHU2NzAwXHU1NDBFXHU3Njg0IGRldGFpbClcdTMwMDIgKi9cclxuICBjb25zdCB3YWl0Rm9yID0gYXN5bmMgKGxhYmVsOiBzdHJpbmcsIHByZWRpY2F0ZUNvZGU6IHN0cmluZywgdGltZW91dE1zOiBudW1iZXIpOiBQcm9taXNlPFtib29sZWFuLCBzdHJpbmddPiA9PiB7XHJcbiAgICBjb25zdCBzdGFydGVkID0gRGF0ZS5ub3coKTtcclxuICAgIGZvciAoOzspIHtcclxuICAgICAgY29uc3QgciA9IChhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHRyeSB7IHJldHVybiBKU09OLnN0cmluZ2lmeSgoZnVuY3Rpb24oKXsgJHtwcmVkaWNhdGVDb2RlfSB9KSgpKTsgfSBjYXRjaChlKXsgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHtvazpmYWxzZSwgZGV0YWlsOlN0cmluZyhlKS5zbGljZSgwLDEyMCl9KTsgfSB9KSgpYCkpIGFzIHN0cmluZztcclxuICAgICAgbGV0IHBhcnNlZDogeyBvaz86IGJvb2xlYW47IGRldGFpbD86IHN0cmluZyB9O1xyXG4gICAgICB0cnkgeyBwYXJzZWQgPSBKU09OLnBhcnNlKHIpIGFzIHsgb2s/OiBib29sZWFuOyBkZXRhaWw/OiBzdHJpbmcgfTsgfSBjYXRjaCB7IHBhcnNlZCA9IHsgb2s6IGZhbHNlLCBkZXRhaWw6IFN0cmluZyhyKS5zbGljZSgwLCAxMjApIH07IH1cclxuICAgICAgaWYgKHBhcnNlZC5vayA9PT0gdHJ1ZSkgcmV0dXJuIFt0cnVlLCBTdHJpbmcocGFyc2VkLmRldGFpbCA/PyAnJyldO1xyXG4gICAgICBpZiAoRGF0ZS5ub3coKSAtIHN0YXJ0ZWQgPiB0aW1lb3V0TXMpIHJldHVybiBbZmFsc2UsIGAke2xhYmVsfTogJHtTdHJpbmcocGFyc2VkLmRldGFpbCA/PyAndGltZW91dCcpfWBdO1xyXG4gICAgICBhd2FpdCBzbGVlcCgyNTApO1xyXG4gICAgfVxyXG4gIH07XHJcbiAgY29uc3Qgc2hvdCA9IGFzeW5jIChsYWJlbDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiA9PiB7XHJcbiAgICBzaG90SWR4ICs9IDE7XHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCBpbWcgPSBhd2FpdCB3aW4ud2ViQ29udGVudHMuY2FwdHVyZVBhZ2UoKTtcclxuICAgICAgYXdhaXQgd3JpdGVGaWxlKGpvaW4oc2hvdHMsIGAke21vZGV9LSR7U3RyaW5nKHNob3RJZHgpLnBhZFN0YXJ0KDIsICcwJyl9LSR7bGFiZWx9LnBuZ2ApLCBpbWcudG9QTkcoKSk7XHJcbiAgICB9IGNhdGNoIHsgLyogXHU2MjJBXHU1NkZFXHU1OTMxXHU4RDI1XHU0RTBEXHU1MjI0XHU2QjdCICovIH1cclxuICB9O1xyXG5cclxuICAvKiAtLS0tIFx1NTNEN1x1NjNBN1x1OEY5M1x1NTE2NShSZWFjdDpcdTUzOUZcdTU3OEIgc2V0dGVyIFx1ODlFNlx1NTNEMSBvbkNoYW5nZSkgLS0tLSAqL1xyXG4gIGNvbnN0IHR5cGVJbnRvID0gKHNlbDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpOiBQcm9taXNlPHVua25vd24+ID0+XHJcbiAgICBqcyhgKGZ1bmN0aW9uKCl7XHJcbiAgICAgIHZhciBlbCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJHtKU09OLnN0cmluZ2lmeShzZWwpfSk7XHJcbiAgICAgIGlmICghZWwpIHJldHVybiAnTk9FTCc7XHJcbiAgICAgIHZhciBwcm90byA9IGVsLnRhZ05hbWUgPT09ICdURVhUQVJFQScgPyBIVE1MVGV4dEFyZWFFbGVtZW50LnByb3RvdHlwZSA6IEhUTUxJbnB1dEVsZW1lbnQucHJvdG90eXBlO1xyXG4gICAgICBPYmplY3QuZ2V0T3duUHJvcGVydHlEZXNjcmlwdG9yKHByb3RvLCAndmFsdWUnKS5zZXQuY2FsbChlbCwgJHtKU09OLnN0cmluZ2lmeSh0ZXh0KX0pO1xyXG4gICAgICBlbC5kaXNwYXRjaEV2ZW50KG5ldyBFdmVudCgnaW5wdXQnLCB7IGJ1YmJsZXM6IHRydWUgfSkpO1xyXG4gICAgICByZXR1cm4gJ09LJztcclxuICAgIH0pKClgKTtcclxuXHJcbiAgLyogLS0tLSBcdTU0MkZcdTUyQThcdTdCNDlcdTVGODU6UmVhY3QgXHU2MzAyXHU4RjdEICsgaG9zdCBcdTdFRkZcdTcwQjkocmVhbCBcdTc2ODQgaG1oYXJuZXNzIFx1NTFCN1x1NTQyRlx1NTJBOFx1ODk4MVx1N0YxNlx1OEJEMVxyXG4gICAgIFx1NjU3NFx1NTk1NyBDTEkgXHU0RjlEXHU4RDU2LFx1NTNFRlx1NTIzMCAzMHMrO1x1NEUwRFx1N0I0OVx1N0VGRlx1NzBCOVx1NUMzMVx1NUYwMFx1OEREMVx1NEYxQVx1NTE2OFx1OTBFOFx1OEQ4NVx1NjVGNlx1OEJFRlx1NjJBNSkgLS0tLSAqL1xyXG4gIGF3YWl0IHdhaXRGb3IoJ2hvc3QgcmVhZHknLCBgdmFyIHQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNvbXBvc2VyIHRleHRhcmVhJyk7IHJldHVybiB7b2s6ICEhdCwgZGV0YWlsOiB0ID8gJ21vdW50ZWQnIDogJ25vIGNvbXBvc2VyJ307YCwgMjBfMDAwKTtcclxuICBhd2FpdCB3YWl0Rm9yKCdob3N0IGRvdCBvbicsIGB2YXIgZD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuaG9zdC1kb3QnKTsgcmV0dXJuIHtvazogISFkICYmIGQuY2xhc3NMaXN0LmNvbnRhaW5zKCdvbicpLCBkZXRhaWw6IGQgPyBkLmNsYXNzTmFtZSA6ICdubyBkb3QnfTtgLCBtb2RlID09PSAncmVhbCcgPyA2MF8wMDAgOiAyMF8wMDApO1xyXG4gIGF3YWl0IHNsZWVwKDFfMjAwKTsgLy8gXHU0RjFBXHU4QkREXHU1MjE3XHU4ODY4L1x1OTg3Nlx1NjgwRlx1NjU3MFx1NjM2RVx1ODQzRFx1NTczMFxyXG5cclxuICAvKiA9PT09PT09PT09IFx1OTAxQVx1NzUyODpcdTVFMDNcdTVDNDBcdTUxRTBcdTRGNTUoXHU3NTI4XHU2MjM3XHU2MkE1XHU5NjlDXHU3Njg0XHU3NkY0XHU2M0E1XHU2NUFEXHU4QTAwKSA9PT09PT09PT09ICovXHJcbiAgYXdhaXQgc3RlcCgnXHU1RTAzXHU1QzQwOlx1NjgwN1x1OTg5OFx1NjgwRitcdTRFMDlcdTY4MEYrY29tcG9zZXIgXHU1NzI4XHU4OUM2XHU1M0UzXHU1MTg1KFx1OEY5M1x1NTE2NVx1Njg0Nlx1NTNFRlx1ODlDMSknLCBhc3luYyAoKSA9PiB7XHJcbiAgICBjb25zdCByID0gKGF3YWl0IGpzKGAoZnVuY3Rpb24oKXtcclxuICAgICAgdmFyIHEgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yLmJpbmQoZG9jdW1lbnQpO1xyXG4gICAgICB2YXIgdGIgPSBxKCcudGl0bGViYXInKSwgc2hlbGwgPSBxKCcuYXBwLXNoZWxsJyksIHNiID0gcSgnLnNpZGViYXInKSwgd3MgPSBxKCcud29ya3NwYWNlJyksIHRhID0gcSgnLmNvbXBvc2VyIHRleHRhcmVhJyk7XHJcbiAgICAgIHZhciBtaXNzaW5nID0gWyF0YiAmJiAndGl0bGViYXInLCAhc2hlbGwgJiYgJ3NoZWxsJywgIXNiICYmICdzaWRlYmFyJywgIXdzICYmICd3b3Jrc3BhY2UnLCAhdGEgJiYgJ3RleHRhcmVhJ10uZmlsdGVyKEJvb2xlYW4pLmpvaW4oJywnKTtcclxuICAgICAgaWYgKG1pc3NpbmcgIT09ICcnKSByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe29rOmZhbHNlLCBkZXRhaWw6J21pc3Npbmc6JyttaXNzaW5nfSk7XHJcbiAgICAgIHZhciByID0gdGEuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCksIHZoID0gd2luZG93LmlubmVySGVpZ2h0LCB2dyA9IHdpbmRvdy5pbm5lcldpZHRoO1xyXG4gICAgICB2YXIgaGludCA9IHEoJy5lbXB0eS1oaW50LmJpZycpOyB2YXIgaHIgPSBoaW50ID8gaGludC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKSA6IG51bGw7XHJcbiAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh7IG9rOiByLmhlaWdodCA+IDMwICYmIHIuYm90dG9tIDw9IHZoICYmIHIud2lkdGggPiAxMDAgJiYgaHIgIT09IG51bGwgJiYgaHIudG9wID49IDAgJiYgaHIuYm90dG9tIDw9IHZoLFxyXG4gICAgICAgIGRldGFpbDogJ3RleHRhcmVhIHk9JytNYXRoLnJvdW5kKHIueSkrJyBoPScrTWF0aC5yb3VuZChyLmhlaWdodCkrJyBib3R0b209JytNYXRoLnJvdW5kKHIuYm90dG9tKSsnIHZoPScrdmgrKGhyID8gJyBoaW50IHk9JytNYXRoLnJvdW5kKGhyLnkpIDogJyBuby1oaW50JykgfSk7XHJcbiAgICB9KSgpYCkpIGFzIHN0cmluZztcclxuICAgIGNvbnN0IHAgPSBKU09OLnBhcnNlKHIpIGFzIHsgb2s6IGJvb2xlYW47IGRldGFpbDogc3RyaW5nIH07XHJcbiAgICByZXR1cm4gW3Aub2sgPT09IHRydWUsIHAuZGV0YWlsXTtcclxuICB9KTtcclxuXHJcbiAgaWYgKG1vZGUgPT09ICdmYWtlJykge1xyXG4gICAgLyogPT09PT09PT09PSBmYWtlKFx1NTQxMVx1NUJGQ1x1Njc4NFx1OTAyMCxITUhfREVTS1RPUF9VSVZFUklGWV9XSVpBUkQ9ZmFrZSk6XHJcbiAgICAgICBcdTRGMkFcdTkwMjBcdTY3MkFcdTkxNERcdTdGNkVcdTYwMDEgXHUyMTkyIFx1NTQxMVx1NUJGQ1x1NTFGQVx1NzNCMCBcdTIxOTIgXHU2OEMwXHU2RDRCKFx1NjcyQVx1ODhDNSlcdTIxOTIgXHU5MDA5XHU2MkU5IFx1MjE5MiBcdTUxODVcdTdGNkUgXHUyMTkyIFx1OEZERVx1NEUwQSA9PT09PT09PT09ICovXHJcbiAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfV0laQVJEID09PSAnZmFrZScpIHtcclxuICAgICAgYXdhaXQgc3RlcCgnXHU1NDExXHU1QkZDOlx1OTk5Nlx1NTQyRlx1NUYzOVx1NTFGQVx1NkIyMlx1OEZDRVx1OTg3NShcdTVGMDBcdTU5Q0JcdTkxNERcdTdGNkUvXHU2RjE0XHU3OTNBXHU1MTY1XHU1M0UzKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignd2l6YXJkIG92ZXJsYXknLCBgdmFyIG89ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1vdmVybGF5Jyk7XHJcbiAgICAgICAgICB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1RjAwXHU1OUNCXHU5MTREXHU3RjZFJzt9KTtcclxuICAgICAgICAgIHJldHVybiB7b2s6ICEhbyAmJiAhIWIsIGRldGFpbDogbyA/ICdvdmVybGF5K1x1NUYwMFx1NTlDQlx1OTE0RFx1N0Y2RScgOiAnbm8gb3ZlcmxheSd9O2AsIDEyXzAwMCk7XHJcbiAgICAgICAgYXdhaXQgc2hvdCgnd2l6YXJkLXdlbGNvbWUnKTtcclxuICAgICAgICByZXR1cm4gdztcclxuICAgICAgfSk7XHJcbiAgICAgIGF3YWl0IHN0ZXAoJ1x1NTQxMVx1NUJGQzpcdTVGMDBcdTU5Q0JcdTkxNERcdTdGNkVcdTIxOTJcdTY4QzBcdTZENEIoXHU0RjJBXHU5MDIwXHU2NzJBXHU4OEM1KVx1MjE5Mlx1ODFFQVx1NTJBOFx1OEZEQlx1OTAwOVx1NjJFOVx1OTg3NShcdTRFMDlcdTkwMDlcdTRFMDArXHU1MTY4XHU1QzQwXHU5MTREXHU3RjZFXHU2M0QwXHU3OTNBKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTVGMDBcdTU5Q0JcdTkxNERcdTdGNkUnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignc2VsZWN0IHBhZ2UnLCBgdmFyIHA9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLXNlbGVjdCcpO1xyXG4gICAgICAgICAgaWYoIXApIHJldHVybiB7b2s6ZmFsc2UsIGRldGFpbDonbm90IG9uIHNlbGVjdCd9O1xyXG4gICAgICAgICAgdmFyIHQ9cC50ZXh0Q29udGVudDtcclxuICAgICAgICAgIHZhciBvMT10LmluZGV4T2YoJ1x1NEUwQlx1OEY3RFx1NUI4OVx1ODhDNVx1NUI4Q1x1NjU3NCBobWggQ0xJJyk+PTAsIG8yPXQuaW5kZXhPZignXHU0RjdGXHU3NTI4XHU1MTg1XHU3RjZFXHU3Q0JFXHU3QjgwXHU1MTg1XHU2ODM4Jyk+PTAsIG8zPXQuaW5kZXhPZignXHU4REYzXHU4RkM3KFx1NkYxNFx1NzkzQVx1NkEyMVx1NUYwRiknKT49MCwgbm90ZT10LmluZGV4T2YoJy5obWhhcm5lc3MnKT49MDtcclxuICAgICAgICAgIHJldHVybiB7b2s6IG8xJiZvMiYmbzMmJm5vdGUsIGRldGFpbDogJ29wdDE9JytvMSsnIG9wdDI9JytvMisnIG9wdDM9JytvMysnIG5vdGU9Jytub3RlfTtgLCAxMl8wMDApO1xyXG4gICAgICAgIGF3YWl0IHNob3QoJ3dpemFyZC1zZWxlY3QnKTtcclxuICAgICAgICByZXR1cm4gdztcclxuICAgICAgfSk7XHJcbiAgICAgIGF3YWl0IHN0ZXAoJ1x1NTQxMVx1NUJGQzpcdTkwMDlcdTUxODVcdTdGNkVcdTdDQkVcdTdCODBcdTUxODVcdTY4MzhcdTIxOTJcdTkxNERcdTdGNkVcdThERjNcdThGQzdcdTIxOTJcdTVCOENcdTYyMTBcdTk4NzVcdTIxOTJcdTVGMDBcdTU5Q0JcdTRGN0ZcdTc1MjhcdTIxOTJcdTUxNzNcdTk1RURcdTRFMTRcdTVERjJcdThGREVcdTYzQTUnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgbz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3B0JykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU0RjdGXHU3NTI4XHU1MTg1XHU3RjZFXHU3Q0JFXHU3QjgwXHU1MTg1XHU2ODM4Jyk+PTA7fSk7IGlmKG8pIG8uY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgIGF3YWl0IHNsZWVwKDMwMCk7XHJcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU0RTBCXHU0RTAwXHU2QjY1J3x8eC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1RjAwXHU1OUNCXHU1Qjg5XHU4OEM1Jzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgLy8gXHU5MTREXHU3RjZFXHU5ODc1OmZha2UgcHJvdmlkZXJzIFx1NURGMlx1NjcwOVx1NUJDNlx1OTRBNSBcdTIxOTIgXHU4MUVBXHU1MkE4XHU4REYzXHU4RkM3O1x1NTE1Q1x1NUU5NVx1NzBCOVwiXHU4REYzXHU4RkM3XCJcclxuICAgICAgICBhd2FpdCB3YWl0Rm9yKCdjb25maWcgb3IgZG9uZScsIGB2YXIgZD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtZG9uZScpO1xyXG4gICAgICAgICAgaWYoZCkgcmV0dXJuIHtvazp0cnVlLCBkZXRhaWw6J2RvbmUnfTtcclxuICAgICAgICAgIHZhciBjPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1jb25maWcnKTtcclxuICAgICAgICAgIGlmKGMpeyB2YXIgcz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdcdThERjNcdThGQzcnKT49MDt9KTsgaWYocykgcy5jbGljaygpOyB9XHJcbiAgICAgICAgICByZXR1cm4ge29rOmZhbHNlLCBkZXRhaWw6J3dhaXRpbmcnfTtgLCAxNV8wMDApO1xyXG4gICAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdkb25lIHBhZ2UnLCBgdmFyIGQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLWRvbmUnKTtcclxuICAgICAgICAgIHZhciB0PWQ/ZC50ZXh0Q29udGVudDonJztcclxuICAgICAgICAgIHJldHVybiB7b2s6ICEhZCAmJiB0LmluZGV4T2YoJ1x1NUMzMVx1N0VFQScpPj0wICYmIHQuaW5kZXhPZignXHU1MTcxXHU0RUFCJyk+PTAsIGRldGFpbDogdC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNjApfTtgLCA4XzAwMCk7XHJcbiAgICAgICAgYXdhaXQgc2hvdCgnd2l6YXJkLWRvbmUnKTtcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTVGMDBcdTU5Q0JcdTRGN0ZcdTc1MjgnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICBjb25zdCBjbG9zZWQgPSBhd2FpdCB3YWl0Rm9yKCd3aXphcmQgY2xvc2VkICsgY29ubmVjdGVkJywgYHJldHVybiB7b2s6ICFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKSAmJiAhIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ob3N0LWRvdC5vbicpLFxyXG4gICAgICAgICAgZGV0YWlsOiAnb3ZlcmxheT0nKyhkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKT8nb3Blbic6J2Nsb3NlZCcpKycgZG90PScrKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ob3N0LWRvdC5vbicpPydvbic6J29mZicpfTtgLCAxMF8wMDApO1xyXG4gICAgICAgIHJldHVybiBbd1swXSAmJiBjbG9zZWRbMF0sIGBkb25lOiAke3dbMV19OyAke2Nsb3NlZFsxXX1gXTtcclxuICAgICAgfSk7XHJcbiAgICB9XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1OTk5Nlx1OEREMVx1NUYxNVx1NUJGQ1x1NUM0MiA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTVGMTVcdTVCRkNcdTVDNDI6XHU2RjE0XHU3OTNBXHU2QTIxXHU1RjBGXHU2M0QwXHU3OTNBXHU1MUZBXHU3M0IwXHU1RTc2XHU1M0VGXHU1MTczXHU5NUVEJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignZ3VpZGUnLCBgdmFyIGc9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnJ1bnRpbWUtZ3VpZGUnKTsgcmV0dXJuIHtvazogISFnLCBkZXRhaWw6IGcgPyAnc2hvd24nIDogJ25vdCBzaG93bid9O2AsIDhfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpe1xyXG4gICAgICAgIHZhciBidG5zID0gW10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcucnVudGltZS1ndWlkZSBidXR0b24nKSk7XHJcbiAgICAgICAgdmFyIGIgPSBidG5zLmZpbmQoZnVuY3Rpb24oeCl7IHJldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1NkYxNFx1NzkzQScpID49IDA7IH0pO1xyXG4gICAgICAgIGlmIChiKSBiLmNsaWNrKCk7XHJcbiAgICAgIH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2d1aWRlIGdvbmUnLCBgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ydW50aW1lLWd1aWRlJyksIGRldGFpbDogZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnJ1bnRpbWUtZ3VpZGUnKSA/ICdzdGlsbCcgOiAnZGlzbWlzc2VkJ307YCwgNV8wMDApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NjVCMFx1NUVGQVx1NEYxQVx1OEJERChDdHJsK04pID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ0N0cmwrTiBcdTY1QjBcdTVFRkFcdTRGMUFcdThCREQsXHU4RjkzXHU1MTY1XHU2ODQ2XHU1M0VGXHU3NTI4JywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OiduJywgY3RybEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ3RleHRhcmVhIGVuYWJsZWQnLCBgdmFyIHQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNvbXBvc2VyIHRleHRhcmVhJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISF0ICYmIHQuZGlzYWJsZWQgPT09IGZhbHNlICYmICh0LnBsYWNlaG9sZGVyfHwnJykuaW5kZXhPZignXHU2M0NGXHU4RkYwXHU3NkVFXHU2ODA3JykgPj0gMCwgZGV0YWlsOiB0ID8gKCdkaXNhYmxlZD0nK3QuZGlzYWJsZWQrJyBwaD0nKyh0LnBsYWNlaG9sZGVyfHwnJykuc2xpY2UoMCwyMCkpIDogJ25vIHRhJ307YCwgNV8wMDApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NTNEMVx1OTAwMVx1NEVGQlx1NTJBMSBcdTIxOTIgXHU3NTI4XHU2MjM3XHU4RjZFXHU1MUZBXHU3M0IwKFx1NEUxNFx1NEVDNVx1NEUwMFx1Njc2MSxcdTUzQ0NcdTZEODhcdTYwNkZcdTU2REVcdTVGNTIpID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1OEY5M1x1NTE2NVx1NUU3Nlx1NTNEMVx1OTAwMVx1NEVGQlx1NTJBMSxcdTc1MjhcdTYyMzdcdTZEODhcdTYwNkZcdTRFMEFcdTVDNEZcdTRFMTRcdTRFMERcdTkxQ0RcdTU5MEQnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IHR5cGVJbnRvKCcuY29tcG9zZXIgdGV4dGFyZWEnLCAnXHU5QThDXHU2NTM2XHU0RUZCXHU1MkExOlx1NTE5OVx1NTE2NVx1NEUwMFx1NEUyQVx1NjU4N1x1NEVGNicpO1xyXG4gICAgICBhd2FpdCBzbGVlcCgyMDApO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XHJcbiAgICAgICAgdmFyIGJ0bnMgPSBbXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jb21wb3NlciBidXR0b24nKSk7XHJcbiAgICAgICAgdmFyIGIgPSBidG5zLmZpbmQoZnVuY3Rpb24oeCl7IHJldHVybiB4LnRleHRDb250ZW50LnRyaW0oKSA9PT0gJ1x1NTNEMVx1OTAwMSc7IH0pO1xyXG4gICAgICAgIGlmIChiKSBiLmNsaWNrKCk7XHJcbiAgICAgIH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2V4YWN0bHkgb25lIHVzZXIgdHVybicsIGB2YXIgdHM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudHVybi51c2VyJykpLmZpbHRlcihmdW5jdGlvbih4KXsgcmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU5QThDXHU2NTM2XHU0RUZCXHU1MkExJykgPj0gMDsgfSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogdHMubGVuZ3RoID09PSAxLCBkZXRhaWw6ICdjb3VudD0nK3RzLmxlbmd0aCsnIHRleHQ9JysodHNbMF0/dHNbMF0udGV4dENvbnRlbnQuc2xpY2UoMCwzMCk6J25vbmUnKX07YCwgOF8wMDApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NURFNVx1NTE3N1x1NTM2MShyZWFkX2ZpbGUgXHU1QjhDXHU2MjEwKSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTVERTVcdTUxNzdcdTYyOThcdTUzRTBcdTUzNjE6cmVhZF9maWxlIFx1NjI2N1x1ODg0Q1x1NUU3Nlx1NUI4Q1x1NjIxMCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3Rvb2wgY2FyZCcsIGB2YXIgYz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50b29sLWNhcmQnKSk7XHJcbiAgICAgICAgdmFyIGRvbmUgPSBjLmZpbHRlcihmdW5jdGlvbih4KXsgcmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZigncmVhZF9maWxlJykgPj0gMCAmJiB4LnRleHRDb250ZW50LmluZGV4T2YoJyMgZGVtbycpID49IDA7IH0pO1xyXG4gICAgICAgIHJldHVybiB7b2s6IGRvbmUubGVuZ3RoID49IDEsIGRldGFpbDogJ2NhcmRzPScrYy5sZW5ndGgrJyBkb25lPScrZG9uZS5sZW5ndGh9O2AsIDhfMDAwKTtcclxuICAgICAgcmV0dXJuIHc7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU1QkExXHU2Mjc5XHU3RUI1XHU1MjA3XHU3MjQ3KFx1NzUyOFx1NjIzN1x1NjJBNVx1OTY5Q1x1NjgzOFx1NUZDM1x1NEU0Qlx1NEUwMCkgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU1QkExXHU2Mjc5OmFwcHJvdmFsIFx1NTM2MVx1NTFGQVx1NzNCMChcdTdCNDlcdTVGODVcdTRFQkFcdTVERTVcdTYyNzlcdTUxQzYpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBzaG90KCdhcHByb3ZhbC1wZW5kaW5nJyk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdhcHByb3ZhbCBjYXJkJywgYHZhciBhPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5hcHByb3ZhbC1jYXJkJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFhICYmIGEudGV4dENvbnRlbnQuaW5kZXhPZignXHU5NzAwXHU4OTgxXHU1QkExXHU2Mjc5JykgPj0gMCwgZGV0YWlsOiBhID8gYS50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsIDYwKSA6ICdubyBhcHByb3ZhbCBjYXJkJ307YCwgOF8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdcdTVCQTFcdTYyNzk6XHU3MEI5XHU2Mjc5XHU1MUM2IFx1MjE5MiBcdTRFRkJcdTUyQTFcdTdFRTdcdTdFRURcdTUyMzBcdTRFQTRcdTRFRDhcdTcyNjkrXHU2QzQ3XHU2MDNCJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XHJcbiAgICAgICAgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuYXBwcm92YWwtY2FyZCBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXsgcmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NjI3OVx1NTFDNic7IH0pO1xyXG4gICAgICAgIGlmIChiKSBiLmNsaWNrKCk7XHJcbiAgICAgIH0pKClgKTtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2FydGlmYWN0K3N1bScsIGB2YXIgYXJ0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5hcnRpZmFjdC1jYXJkJyk7XHJcbiAgICAgICAgdmFyIHN1bT1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudHVybi1zdW0nKTtcclxuICAgICAgICB2YXIgYXN0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnR1cm4nKSkuZmlsdGVyKGZ1bmN0aW9uKHgpeyByZXR1cm4geC5jbGFzc05hbWUuaW5kZXhPZigndXNlcicpPDAgJiYgeC50ZXh0Q29udGVudC5pbmRleE9mKCdlY2hvOicpPj0wOyB9KTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWFydCAmJiAhIXN1bSAmJiBhc3QubGVuZ3RoPj0xLCBkZXRhaWw6ICdhcnRpZmFjdD0nKyhhcnQ/YXJ0LnRleHRDb250ZW50LnNsaWNlKDAsMzApOidub25lJykrJyBzdW09Jysoc3VtP3N1bS50ZXh0Q29udGVudDonbm9uZScpKycgYW5zd2VyZWQ9Jythc3QubGVuZ3RofTtgLCAxMl8wMDApO1xyXG4gICAgICBhd2FpdCBzaG90KCdydW4tY29tcGxldGVkJyk7XHJcbiAgICAgIHJldHVybiB3O1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NTM4Nlx1NTNGMlx1NEYxQVx1OEJERFx1NTE4NVx1NUJCOShcdTc1MjhcdTYyMzdcdTYyQTVcdTk2OUNcIlx1NzcwQlx1NEUwRFx1NTIzMFx1NTE4NVx1NUJCOVwiKSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTcwQjlcdTUxRkJcdTUzODZcdTUzRjJcdTRGMUFcdThCREQgXHUyMTkyIHRyYW5zY3JpcHQgXHU1MTg1XHU1QkI5XHU1M0VGXHU4OUMxJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBpdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2Vzc2lvbi1pdGVtJyk7IGlmIChpdCkgaXQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignaGlzdG9yeSB0dXJucycsIGB2YXIgdHM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudHVybicpKTtcclxuICAgICAgICByZXR1cm4ge29rOiB0cy5sZW5ndGggPj0gMiwgZGV0YWlsOiAndHVybnM9Jyt0cy5sZW5ndGgrJyBmaXJzdD0nKyh0c1swXT90c1swXS50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNDApOidub25lJyl9O2AsIDhfMDAwKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTRFOTRcdTk4NzVcdTdCN0UgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnRG9jazpPdmVydmlldyBcdTY1NzBcdTYzNkVcdTg4NEMnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdPdmVydmlldyc7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignb3ZlcnZpZXcgcm93cycsIGB2YXIgcm93cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXJvdycpKTtcclxuICAgICAgICB2YXIgdmVyID0gcm93cy5maW5kKGZ1bmN0aW9uKHIpeyByZXR1cm4gci50ZXh0Q29udGVudC5pbmRleE9mKCdydW50aW1lIFx1NzI0OFx1NjcyQycpPj0wOyB9KTtcclxuICAgICAgICByZXR1cm4ge29rOiByb3dzLmxlbmd0aCA+PSA1ICYmICEhdmVyLCBkZXRhaWw6ICdyb3dzPScrcm93cy5sZW5ndGgrKHZlcj8nIHZlcj0nK3Zlci50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNDApOicnKX07YCwgNl8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdEb2NrOkZpbGVzIFx1NkQ0Rlx1ODlDOCtcdTY1ODdcdTRFRjZcdTk4ODRcdTg5QzgnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdcdTY1ODdcdTRFRjYnfHx4LnRleHRDb250ZW50PT09J0ZpbGVzJzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdmcyByb3dzJywgYHZhciByb3dzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5mcy1yb3cnKS5sZW5ndGg7XHJcbiAgICAgICAgcmV0dXJuIHtvazogcm93cyA+PSAxLCBkZXRhaWw6ICdyb3dzPScrcm93c307YCwgNl8wMDApO1xyXG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICAvLyBcdTY4MzlcdTc2RUVcdTVGNTVcdTUzRUFcdTY3MDlcdTVERTVcdTRGNUNcdTUzM0FcdTc2RUVcdTVGNTUoZmFrZSBcdTRFMEVcdTc3MUZcdTVCOUUgcnVudGltZSBcdTU0MENcdTVGNjIpOlx1NTE0OFx1OEZEQlx1NzZFRVx1NUY1NSxcdTUxOERcdTcwQjlcdTY1ODdcdTRFRjZcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgZD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5mcy1yb3cnKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdkZW1vLXdvcmtzcGFjZScpPj0wIHx8IHgudGV4dENvbnRlbnQuaW5kZXhPZignXHVEODNEXHVEQ0MxJyk+PTA7fSk7IGlmKGQpIGQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCB3MiA9IGF3YWl0IHdhaXRGb3IoJ2ZpbGUgcm93cycsIGB2YXIgcm93cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5mcy1yb3cnKSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogcm93cy5zb21lKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1JFQURNRScpPj0wO30pLCBkZXRhaWw6ICdyb3dzPScrcm93cy5sZW5ndGh9O2AsIDZfMDAwKTtcclxuICAgICAgaWYgKCF3MlswXSkgcmV0dXJuIHcyO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBmPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmZzLXJvdycpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1JFQURNRScpPj0wO30pOyBpZihmKSBmLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2ZpbGUgcHJldmlldycsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuZnMtcHJldmlldycpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhcCAmJiBwLnRleHRDb250ZW50LmluZGV4T2YoJ2RlbW8gd29ya3NwYWNlJykgPj0gMCwgZGV0YWlsOiBwID8gcC50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNDApIDogJ25vIHByZXZpZXcnfTtgLCA2XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ0RvY2s6RGlmZiBcdTUzRDhcdTY2RjRcdTg4NEMnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdcdTUzRDhcdTY2RjQnfHx4LnRleHRDb250ZW50PT09J0RpZmYnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2RpZmYgcm93cycsIGB2YXIgcm93cz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZGlmZi1yb3cnKS5sZW5ndGg7XHJcbiAgICAgICAgcmV0dXJuIHtvazogcm93cyA+PSAxLCBkZXRhaWw6ICdkaWZmIHJvd3M9Jytyb3dzfTtgLCA2XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ0RvY2s6RXZpZGVuY2UgXHU4QkE0XHU3N0U1XHU2NTcwXHU2MzZFJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nXHU4QkMxXHU2MzZFJ3x8eC50ZXh0Q29udGVudD09PSdFdmlkZW5jZSc7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignZXZpZGVuY2Ugcm93cycsIGB2YXIgcm93cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXJvdycpKTtcclxuICAgICAgICB2YXIgbWVtID0gcm93cy5maW5kKGZ1bmN0aW9uKHIpeyByZXR1cm4gci50ZXh0Q29udGVudC5pbmRleE9mKCdcdThCQjBcdTVGQzZcdTVDNDInKT49MCB8fCByLnRleHRDb250ZW50LmluZGV4T2YoJ01lbW9yeSBsYXllcnMnKT49MDsgfSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFtZW0gJiYgbWVtLnRleHRDb250ZW50LmluZGV4T2YoJzMnKSA+PSAwLCBkZXRhaWw6IG1lbSA/IG1lbS50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpIDogJ25vIG1lbW9yeSByb3cnfTtgLCA2XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ0RvY2s6TG9ncyBcdTk3NjJcdTY3N0YoXHU3QTdBXHU2MDAxXHU2M0QwXHU3OTNBKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J1x1NjVFNVx1NUZENyd8fHgudGV4dENvbnRlbnQ9PT0nTG9ncyc7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignbG9ncyBwYW5lJywgYHZhciBsPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5sb2dzLWxpc3QnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWwsIGRldGFpbDogbCA/ICgncm93cz0nK2wucXVlcnlTZWxlY3RvckFsbCgnLmxvZy1yb3cnKS5sZW5ndGgpIDogJ25vIGxvZ3MgbGlzdCd9O2AsIDVfMDAwKTtcclxuICAgICAgcmV0dXJuIHc7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6RG9jazpcdThGRENcdTdBMEJcdTk4NzVcdTdCN0UoXHU2MjRCXHU2NzNBXHU4RkRDXHU3QTBCXHU2M0E3XHU1MjM2XHU5NzYyXHU2NzdGK1x1NUYwMFx1NjczQVx1ODFFQVx1NTQyRlx1ODg0QykgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnRG9jazpcdThGRENcdTdBMEJcdTk4NzVcdTdCN0UoXHU2MjRCXHU2NzNBXHU4RkRDXHU3QTBCXHU2M0E3XHU1MjM2XHU5NzYyXHU2NzdGKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J1x1OEZEQ1x1N0EwQid8fHgudGV4dENvbnRlbnQ9PT0nUmVtb3RlJzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdyZW1vdGUgcGFuZScsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuZG9jay1ib2R5Jyk7XHJcbiAgICAgICAgdmFyIHQgPSBwID8gcC50ZXh0Q29udGVudCA6ICcnO1xyXG4gICAgICAgIHZhciBva1QgPSB0LmluZGV4T2YoJ1x1NjI0Qlx1NjczQVx1OEZEQ1x1N0EwQlx1NjNBN1x1NTIzNicpPj0wIHx8IHQuaW5kZXhPZignUGhvbmUgcmVtb3RlJyk+PTA7XHJcbiAgICAgICAgdmFyIG9rQSA9IHQuaW5kZXhPZignXHU1RjAwXHU2NzNBXHU4MUVBXHU1NDJGJyk+PTAgfHwgdC5pbmRleE9mKCdBdXRvc3RhcnQnKT49MDtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXAgJiYgb2tUICYmIG9rQSwgZGV0YWlsOiB0LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw2MCl9O2AsIDZfMDAwKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTY0MUNcdTdEMjJcdThGQzdcdTZFRTQgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU0RjFBXHU4QkREXHU2NDFDXHU3RDIyOlx1OEZDN1x1NkVFNFx1NzUxRlx1NjU0OCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgYmVmb3JlID0gKGF3YWl0IGpzKGBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoYCkpIGFzIG51bWJlcjtcclxuICAgICAgYXdhaXQgdHlwZUludG8oJy5zZXNzaW9uLXNlYXJjaCcsICd6enotXHU0RTBEXHU1QjU4XHU1NzI4XHU3Njg0XHU0RjFBXHU4QkREJyk7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdmaWx0ZXJlZCBlbXB0eScsIGB2YXIgbj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoO1xyXG4gICAgICAgIHJldHVybiB7b2s6IG4gPT09IDAsIGRldGFpbDogJ2FmdGVyPScrbn07YCwgNV8wMDApO1xyXG4gICAgICBhd2FpdCB0eXBlSW50bygnLnNlc3Npb24tc2VhcmNoJywgJycpO1xyXG4gICAgICBhd2FpdCBzbGVlcCg0MDApO1xyXG4gICAgICBjb25zdCBhZnRlciA9IChhd2FpdCBqcyhgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aGApKSBhcyBudW1iZXI7XHJcbiAgICAgIHJldHVybiBbd1swXSAmJiBhZnRlciA9PT0gYmVmb3JlLCBgJHt3WzFdfTsgXHU2MDYyXHU1OTBEXHU1NDBFICR7YWZ0ZXJ9PT09JHtiZWZvcmV9YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6Q3RybCtLIFx1NTQ3RFx1NEVFNFx1OTc2Mlx1Njc3RiA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdDdHJsK0sgXHU1NDdEXHU0RUU0XHU5NzYyXHU2NzdGOlx1NjI1M1x1NUYwMFx1NUU3Nlx1NjI2N1x1ODg0Q1x1NTQ3RFx1NEVFNCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleTonaycsIGN0cmxLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdjbWRrIG9wZW4nLCBgdmFyIGM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNtZGsnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWMsIGRldGFpbDogYyA/ICdvcGVuJyA6ICdub3Qgb3Blbid9O2AsIDVfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgaXQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY21kay1pdGVtJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU2NTg3XHU0RUY2Jyk+PTAgfHwgeC50ZXh0Q29udGVudC5pbmRleE9mKCdGaWxlcycpPj0wO30pOyBpZihpdCkgaXQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcigndGFiIHN3aXRjaGVkJywgYHZhciB0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5kb2NrLXRhYi5hY3RpdmUnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXQgJiYgKHQudGV4dENvbnRlbnQ9PT0nXHU2NTg3XHU0RUY2J3x8dC50ZXh0Q29udGVudD09PSdGaWxlcycpLCBkZXRhaWw6ICdhY3RpdmU9JysodD90LnRleHRDb250ZW50Oidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdThCQkVcdTdGNkVcdTk3NjJcdTY3N0YgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU4QkJFXHU3RjZFKEN0cmwrU2hpZnQrUCk6UHJvdmlkZXIgXHU4ODY4XHU1MzU1XHU1M0VGXHU4OUMxLEVzYyBcdTUxNzNcdTk1RUQnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J3AnLCBjdHJsS2V5OnRydWUsIHNoaWZ0S2V5OnRydWUsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignc2V0dGluZ3Mgb3BlbicsIGB2YXIgcz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kay5zZXR0aW5ncycpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhcyAmJiAhIXMucXVlcnlTZWxlY3RvcignLnByb3ZpZGVyLWZvcm0nKSwgZGV0YWlsOiBzID8gJ29wZW4rZm9ybScgOiAnbm90IG9wZW4nfTtgLCA1XzAwMCk7XHJcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J0VzY2FwZScsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignc2V0dGluZ3MgY2xvc2VkJywgYHJldHVybiB7b2s6ICFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kay1vdmVybGF5JyksIGRldGFpbDogJ2Nsb3NlZCd9O2AsIDVfMDAwKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTppMThuIFx1OEJFRFx1OEEwMFx1NTIwN1x1NjM2MiA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdThCRURcdThBMDBcdTUyMDdcdTYzNjI6XHU0RTJEXHU2NTg3IFx1MjE5MiBFbmdsaXNoIFx1MjE5MiBcdTYwNjJcdTU5MERcdTRFMkRcdTY1ODcnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J3AnLCBjdHJsS2V5OnRydWUsIHNoaWZ0S2V5OnRydWUsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignc2V0dGluZ3Mgb3BlbicsIGB2YXIgcz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kay5zZXR0aW5ncycpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhcywgZGV0YWlsOiBzID8gJ29wZW4nIDogJ25vdCBvcGVuJ307YCwgNV8wMDApO1xyXG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNtZGsuc2V0dGluZ3MgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J0VuZ2xpc2gnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgZW4gPSBhd2FpdCB3YWl0Rm9yKCdlbmdsaXNoIHNob3duJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyLWhlYWQgLmJ0bi5wcmltYXJ5Jyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFiICYmIGIudGV4dENvbnRlbnQgPT09ICcrIE5ldyBTZXNzaW9uJywgZGV0YWlsOiAnYnRuPScrKGI/Yi50ZXh0Q29udGVudDonbm9uZScpfTtgLCA1XzAwMCk7XHJcbiAgICAgIGF3YWl0IHNob3QoJ2VuZ2xpc2gnKTtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jbWRrLnNldHRpbmdzIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTRFMkRcdTY1ODcnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgemggPSBhd2FpdCB3YWl0Rm9yKCdjaGluZXNlIGJhY2snLCBgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXItaGVhZCAuYnRuLnByaW1hcnknKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWIgJiYgYi50ZXh0Q29udGVudCA9PT0gJysgXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREJywgZGV0YWlsOiAnYnRuPScrKGI/Yi50ZXh0Q29udGVudDonbm9uZScpfTtgLCA1XzAwMCk7XHJcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J0VzY2FwZScsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICByZXR1cm4gW2VuWzBdICYmIHpoWzBdLCBgZW46ICR7ZW5bMV19OyB6aDogJHt6aFsxXX1gXTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTVERTVcdTRGNUNcdTUzM0FcdTdCQTFcdTc0MDYoXHU1REU2XHU2ODBGXHU2ODBGXHU0RjREICsgXHU4M0RDXHU1MzU1ICsgXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREXHU5MDA5XHU1REU1XHU0RjVDXHU1MzNBKSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTVERTVcdTRGNUNcdTUzM0E6XHU1REU2XHU2ODBGXHU1REU1XHU0RjVDXHU1MzNBXHU2ODBGXHU1M0VGXHU4OUMxKFx1NUY1M1x1NTI0RFx1NURFNVx1NEY1Q1x1NTMzQVx1NTQwRCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCd3b3Jrc3BhY2UgYmFyJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53b3Jrc3BhY2UtYmFyJyk7XHJcbiAgICAgICAgdmFyIG4gPSBiID8gKGIucXVlcnlTZWxlY3RvcignLndzLWJhci1uYW1lJyl8fHt9KS50ZXh0Q29udGVudCA6ICcnO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYiAmJiAhIW4gJiYgbi5sZW5ndGggPiAwICYmIG4uaW5kZXhPZignXHU1MkEwXHU4RjdEJykgPCAwLCBkZXRhaWw6ICdiYXI9JysoYj8neWVzJzonbm8nKSsnIG5hbWU9JytufTtgLCA4XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ1x1NURFNVx1NEY1Q1x1NTMzQTpcdTgzRENcdTUzNTVcdTVGMzlcdTUxRkEsXHU1MjE3XHU4ODY4K1x1NUY1M1x1NTI0RFx1OUFEOFx1NEVBRStcdTZERkJcdTUyQTBcdTUxNjVcdTUzRTM7XHU1NzI4XHU2MzA3XHU1QjlBXHU1REU1XHU0RjVDXHU1MzNBXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53b3Jrc3BhY2UtYmFyJyk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignd3MgbWVudScsIGB2YXIgbT1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtbWVudScpO1xyXG4gICAgICAgIHZhciBpdGVtcyA9IG0gPyBtLnF1ZXJ5U2VsZWN0b3JBbGwoJy53cy1tZW51LWl0ZW0nKS5sZW5ndGggOiAwO1xyXG4gICAgICAgIHZhciBjdXIgPSBtID8gbS5xdWVyeVNlbGVjdG9yQWxsKCcud3MtbWVudS1pdGVtLmN1cnJlbnQnKS5sZW5ndGggOiAwO1xyXG4gICAgICAgIHZhciBhZGQgPSBtID8gKG0udGV4dENvbnRlbnQuaW5kZXhPZignXHU2REZCXHU1MkEwXHU1REU1XHU0RjVDXHU1MzNBJyk+PTAgfHwgbS50ZXh0Q29udGVudC5pbmRleE9mKCdBZGQgd29ya3NwYWNlJyk+PTApIDogZmFsc2U7XHJcbiAgICAgICAgcmV0dXJuIHtvazogaXRlbXMgPj0gMSAmJiBjdXIgPj0gMSAmJiBhZGQsIGRldGFpbDogJ2l0ZW1zPScraXRlbXMrJyBjdXJyZW50PScrY3VyKycgYWRkPScrYWRkfTtgLCA2XzAwMCk7XHJcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgIGF3YWl0IHNob3QoJ3dzLW1lbnUnKTtcclxuICAgICAgLy8gXHU3MEI5XHU3QjJDXHU0RTAwXHU0RTJBXHU1REU1XHU0RjVDXHU1MzNBXHU5ODc5ID0gXHU1NzI4XHU4QkU1XHU1REU1XHU0RjVDXHU1MzNBXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREKFx1ODNEQ1x1NTM1NVx1NTE3M1x1OTVFRFx1MzAwMWNvbXBvc2VyIFx1NTNFRlx1NzUyOClcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgaXQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLW1lbnUtaXRlbScpOyBpZihpdCkgaXQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBjbG9zZWQgPSBhd2FpdCB3YWl0Rm9yKCdtZW51IGNsb3NlZCArIHNlc3Npb24gYWN0aXZlJywgYHZhciB0YT1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY29tcG9zZXIgdGV4dGFyZWEnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLW1lbnUnKSAmJiAhIXRhICYmIHRhLmRpc2FibGVkID09PSBmYWxzZSwgZGV0YWlsOiAnbWVudT0nKyhkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtbWVudScpPydvcGVuJzonY2xvc2VkJykrJyB0YT0nKyh0YT90YS5kaXNhYmxlZDonbm9uZScpfTtgLCA2XzAwMCk7XHJcbiAgICAgIHJldHVybiBbY2xvc2VkWzBdLCBgJHt3WzFdfTsgJHtjbG9zZWRbMV19YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU0RjFBXHU4QkREXHU2MzA5XHU1REU1XHU0RjVDXHU1MzNBXHU1MjA2XHU3RUM0ICsgXHU1QzU1XHU1RjAwL1x1NjUzNlx1OEQ3NyA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTRGMUFcdThCRERcdTUyMDZcdTdFQzQ6XHU3RUM0XHU1OTM0XHU1MUZBXHU3M0IwKFx1NURFNVx1NEY1Q1x1NTMzQVx1NTQwRCtcdTY1NzBcdTkxQ0YpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignZ3JvdXAgaGVhZCcsIGB2YXIgaD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtZ3JvdXAtaGVhZCcpO1xyXG4gICAgICAgIHZhciBuID0gaCA/IChoLnF1ZXJ5U2VsZWN0b3IoJy53cy1ncm91cC1uYW1lJyl8fHt9KS50ZXh0Q29udGVudCA6ICcnO1xyXG4gICAgICAgIHZhciBjID0gaCA/IChoLnF1ZXJ5U2VsZWN0b3IoJy53cy1ncm91cC1jb3VudCcpfHx7fSkudGV4dENvbnRlbnQgOiAnJztcclxuICAgICAgICByZXR1cm4ge29rOiAhIWggJiYgbi5sZW5ndGggPiAwICYmIGMubGVuZ3RoID4gMCwgZGV0YWlsOiAnbmFtZT0nK24rJyBjb3VudD0nK2N9O2AsIDhfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnXHU0RjFBXHU4QkREXHU1MjA2XHU3RUM0Olx1NzBCOVx1NTFGQlx1N0VDNFx1NTkzNFx1NjUzNlx1OEQ3NyxcdTUxOERcdTcwQjlcdTVDNTVcdTVGMDBcdTYwNjJcdTU5MEQnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IGJlZm9yZSA9IChhd2FpdCBqcyhgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aGApKSBhcyBudW1iZXI7XHJcbiAgICAgIGlmIChiZWZvcmUgPT09IDApIHJldHVybiBbZmFsc2UsICdubyBzZXNzaW9ucyB0byBncm91cCddO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBoPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1ncm91cC1oZWFkJyk7IGlmKGgpIGguY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBjb2xsYXBzZWQgPSBhd2FpdCB3YWl0Rm9yKCdjb2xsYXBzZWQnLCBgdmFyIGc9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLWdyb3VwJyk7XHJcbiAgICAgICAgdmFyIGhpZGRlbiA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGggPCAke2JlZm9yZX07XHJcbiAgICAgICAgcmV0dXJuIHtvazogaGlkZGVuLCBkZXRhaWw6ICdpdGVtcz0nK2RvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGgrJyBiZWZvcmU9JHtiZWZvcmV9J307YCwgNV8wMDApO1xyXG4gICAgICBhd2FpdCBzaG90KCd3cy1ncm91cC1jb2xsYXBzZWQnKTtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgaD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtZ3JvdXAtaGVhZCcpOyBpZihoKSBoLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgZXhwYW5kZWQgPSBhd2FpdCB3YWl0Rm9yKCdleHBhbmRlZCBiYWNrJywgYHZhciBuPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGg7XHJcbiAgICAgICAgcmV0dXJuIHtvazogbiA+PSAke2JlZm9yZX0sIGRldGFpbDogJ2l0ZW1zPScrbn07YCwgNV8wMDApO1xyXG4gICAgICByZXR1cm4gW2NvbGxhcHNlZFswXSAmJiBleHBhbmRlZFswXSwgYGNvbGxhcHNlOiAke2NvbGxhcHNlZFsxXX07IGV4cGFuZDogJHtleHBhbmRlZFsxXX1gXTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTVGRUJcdTYzNzdcdTk1MkVcdTVFMkVcdTUyQTlcdTk3NjJcdTY3N0YoQ3RybCsvKSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTVGRUJcdTYzNzdcdTk1MkVcdTVFMkVcdTUyQTk6Q3RybCsvIFx1NjI1M1x1NUYwMCxFc2MgXHU1MTczXHU5NUVEJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OicvJywgY3RybEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3Nob3J0Y3V0cyBvcGVuJywgYHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrJyk7XHJcbiAgICAgICAgdmFyIHJvd3MgPSBzID8gcy5xdWVyeVNlbGVjdG9yQWxsKCcuc2hvcnRjdXQtcm93JykubGVuZ3RoIDogMDtcclxuICAgICAgICByZXR1cm4ge29rOiByb3dzID49IDUsIGRldGFpbDogJ3Jvd3M9Jytyb3dzfTtgLCA1XzAwMCk7XHJcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgIGF3YWl0IHNob3QoJ3Nob3J0Y3V0cycpO1xyXG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidFc2NhcGUnLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ3Nob3J0Y3V0cyBjbG9zZWQnLCBgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrLW92ZXJsYXknKSwgZGV0YWlsOiAnY2xvc2VkJ307YCwgNV8wMDApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NEZBN1x1NjgwRlx1NjUzNlx1N0YyOSArIFx1NzJCNlx1NjAwMVx1OEZDN1x1NkVFNCA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTRGQTdcdTY4MEZcdTY1MzZcdTdGMjk6XHUyMUU0IFx1NjUzNlx1OEQ3N1x1NURFNlx1NjgwRixcdTIxRTUgXHU1QzU1XHU1RjAwXHU2MDYyXHU1OTBEJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAvLyBISUcgUDMgXHU3RUM0MjpcdTIxRTQvXHUyMUU1IEVtb2ppIFx1NURGMlx1NjM2MiBTVkcgaWNvbixcdTYzMDlcdTk0QUVcdTRFRTUgYXJpYS1sYWJlbChcdTU0MkJcIlx1NEZBN1x1NjgwRlwiKVx1NUI5QVx1NEY0RFxyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcigndG9nZ2xlIGJ0bicsIGB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50b3BiYXIgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuICh4LmdldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcpfHwnJykuaW5kZXhPZignXHU0RkE3XHU2ODBGJyk+PTA7fSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFiLCBkZXRhaWw6ICdidG49JysoYj9iLmdldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcpOidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50b3BiYXIgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuICh4LmdldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcpfHwnJykuaW5kZXhPZignXHU0RkE3XHU2ODBGJyk+PTA7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBoaWRkZW4gPSBhd2FpdCB3YWl0Rm9yKCdzaWRlYmFyIGhpZGRlbicsIGB2YXIgc2I9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXInKTtcclxuICAgICAgICB2YXIgZ29uZSA9ICFzYiB8fCBnZXRDb21wdXRlZFN0eWxlKHNiKS5kaXNwbGF5ID09PSAnbm9uZSc7XHJcbiAgICAgICAgcmV0dXJuIHtvazogZ29uZSwgZGV0YWlsOiAnZGlzcGxheT0nKyhzYj9nZXRDb21wdXRlZFN0eWxlKHNiKS5kaXNwbGF5Oidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50b3BiYXIgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuICh4LmdldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcpfHwnJykuaW5kZXhPZignXHU0RkE3XHU2ODBGJyk+PTA7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBzaG93biA9IGF3YWl0IHdhaXRGb3IoJ3NpZGViYXIgYmFjaycsIGB2YXIgc2I9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXInKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXNiICYmIGdldENvbXB1dGVkU3R5bGUoc2IpLmRpc3BsYXkgIT09ICdub25lJywgZGV0YWlsOiAnZGlzcGxheT0nKyhzYj9nZXRDb21wdXRlZFN0eWxlKHNiKS5kaXNwbGF5Oidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgICAgcmV0dXJuIFtoaWRkZW5bMF0gJiYgc2hvd25bMF0sIGBoaWRlOiAke2hpZGRlblsxXX07IHNob3c6ICR7c2hvd25bMV19YF07XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ1x1NzJCNlx1NjAwMVx1OEZDN1x1NkVFNDpcdTRFMEJcdTYyQzlcdTUyMDdcdTYzNjJcdTUyMzBcIlx1OEZEMFx1ODg0Q1x1NEUyRFwiXHU0RTBEXHU1RDI5XHU2RTgzXHU1RTc2XHU2MDYyXHU1OTBEJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCBzZWwgPSBhd2FpdCB3YWl0Rm9yKCdmaWx0ZXIgc2VsZWN0JywgYHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zdGF0dXMtZmlsdGVyJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFzICYmIHMub3B0aW9ucy5sZW5ndGggPj0gNCwgZGV0YWlsOiAnb3B0aW9ucz0nKyhzP3Mub3B0aW9ucy5sZW5ndGg6MCl9O2AsIDVfMDAwKTtcclxuICAgICAgaWYgKCFzZWxbMF0pIHJldHVybiBzZWw7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnN0YXR1cy1maWx0ZXInKTsgcy52YWx1ZT0ncnVubmluZyc7IHMuZGlzcGF0Y2hFdmVudChuZXcgRXZlbnQoJ2NoYW5nZScse2J1YmJsZXM6dHJ1ZX0pKTsgfSkoKWApO1xyXG4gICAgICBhd2FpdCBzbGVlcCg1MDApO1xyXG4gICAgICBjb25zdCByMSA9IChhd2FpdCBqcyhgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aGApKSBhcyBudW1iZXI7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnN0YXR1cy1maWx0ZXInKTsgcy52YWx1ZT0nYWxsJzsgcy5kaXNwYXRjaEV2ZW50KG5ldyBFdmVudCgnY2hhbmdlJyx7YnViYmxlczp0cnVlfSkpOyB9KSgpYCk7XHJcbiAgICAgIGF3YWl0IHNsZWVwKDUwMCk7XHJcbiAgICAgIGNvbnN0IHIyID0gKGF3YWl0IGpzKGBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoYCkpIGFzIG51bWJlcjtcclxuICAgICAgcmV0dXJuIFtyMiA+PSByMSAmJiByMiA+PSAxLCBgcnVubmluZz0ke3IxfSBhbGw9JHtyMn1gXTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTZBMjFcdTU3OEJcdTkwMDlcdTYyRTlcdTU2NjgoXHU5ODc2XHU2ODBGXHU1MjA3XHU2MzYyIGNoYXQgXHU4REVGXHU3NTMxKSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTZBMjFcdTU3OEJcdTkwMDlcdTYyRTlcdTU2Njg6XHU5ODc2XHU2ODBGXHU4M0RDXHU1MzU1XHU1MjE3XHU1MUZBIHByb3ZpZGVycyBcdTVFNzZcdTUzRUZcdTUyMDdcdTYzNjInLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdtb2RlbCBidXR0b24nLCBgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnRvcGJhci1tb2RlbC5hcy1idXR0b24nKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWIgJiYgYi5kaXNhYmxlZCA9PT0gZmFsc2UsIGRldGFpbDogYiA/IGIudGV4dENvbnRlbnQgOiAnbm9uZSd9O2AsIDZfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudG9wYmFyLW1vZGVsLmFzLWJ1dHRvbicpOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgbSA9IGF3YWl0IHdhaXRGb3IoJ21vZGVsIG1lbnUnLCBgdmFyIG09ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLm1vZGVsLW1lbnUnKTtcclxuICAgICAgICB2YXIgaXRlbXMgPSBtID8gbS5xdWVyeVNlbGVjdG9yQWxsKCcud3MtbWVudS1pdGVtJykubGVuZ3RoIDogMDtcclxuICAgICAgICB2YXIgY3VyID0gbSA/IG0ucXVlcnlTZWxlY3RvckFsbCgnLndzLW1lbnUtaXRlbS5jdXJyZW50JykubGVuZ3RoIDogMDtcclxuICAgICAgICByZXR1cm4ge29rOiBpdGVtcyA+PSAyICYmIGN1ciA+PSAxLCBkZXRhaWw6ICdpdGVtcz0nK2l0ZW1zKycgY3VycmVudD0nK2N1cn07YCwgNV8wMDApO1xyXG4gICAgICBpZiAoIW1bMF0pIHJldHVybiBtO1xyXG4gICAgICBhd2FpdCBzaG90KCdtb2RlbC1tZW51Jyk7XHJcbiAgICAgIC8vIFx1NTIwN1x1NTIzMFx1N0IyQ1x1NEU4Q1x1NEUyQSBwcm92aWRlcihmYWtlOiBkZW1vLXZpc2lvbi9mYWtlLW0tdmlzaW9uKVxyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBpdHM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcubW9kZWwtbWVudSAud3MtbWVudS1pdGVtJykpOyB2YXIgaXQ9aXRzW2l0cy5sZW5ndGgtMV07IGlmKGl0KSBpdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdtb2RlbCBzd2l0Y2hlZCcsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudG9wYmFyLW1vZGVsLmFzLWJ1dHRvbicpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYiAmJiBiLnRleHRDb250ZW50LmluZGV4T2YoJ2Zha2UtbS12aXNpb24nKSA+PSAwLCBkZXRhaWw6ICdiYWRnZT0nKyhiP2IudGV4dENvbnRlbnQ6J25vbmUnKX07YCwgNl8wMDApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NEUzQlx1OTg5OChcdTZENDVcdTgyNzJcdTc1MUZcdTY1NDhcdTIxOTJcdTYwNjJcdTU5MERcdTZERjFcdTgyNzIpID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1NEUzQlx1OTg5ODpcdThCQkVcdTdGNkVcdTUyMDdcdTZENDVcdTgyNzJcdTc1MUZcdTY1NDgsXHU2MDYyXHU1OTBEXHU2REYxXHU4MjcyJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidwJywgY3RybEtleTp0cnVlLCBzaGlmdEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3NldHRpbmdzIG9wZW4nLCBgdmFyIHM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNtZGsuc2V0dGluZ3MnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXMsIGRldGFpbDogcyA/ICdvcGVuJyA6ICdub3Qgb3Blbid9O2AsIDVfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jbWRrLnNldHRpbmdzIC5zZWcgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NkQ0NVx1ODI3Mid8fHgudGV4dENvbnRlbnQudHJpbSgpPT09J0xpZ2h0Jzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IGxpZ2h0ID0gYXdhaXQgd2FpdEZvcignbGlnaHQgdGhlbWUnLCBgdmFyIGR0PWRvY3VtZW50LmRvY3VtZW50RWxlbWVudC5kYXRhc2V0LnRoZW1lO1xyXG4gICAgICAgIHZhciBiZyA9IGdldENvbXB1dGVkU3R5bGUoZG9jdW1lbnQuYm9keSkuYmFja2dyb3VuZENvbG9yO1xyXG4gICAgICAgIHZhciBtID0gL1xcXFxkKy9nOyB2YXIgbnVtcz0oYmcubWF0Y2gobSl8fFsnMCcsJzAnLCcwJ10pLm1hcChOdW1iZXIpO1xyXG4gICAgICAgIHJldHVybiB7b2s6IGR0PT09J2xpZ2h0JyAmJiBudW1zWzBdPjIwMCAmJiBudW1zWzFdPjIwMCAmJiBudW1zWzJdPjIwMCwgZGV0YWlsOiAndGhlbWU9JytkdCsnIGJnPScrYmd9O2AsIDVfMDAwKTtcclxuICAgICAgYXdhaXQgc2hvdCgnbGlnaHQtdGhlbWUnKTtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jbWRrLnNldHRpbmdzIC5zZWcgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NkRGMVx1ODI3Mid8fHgudGV4dENvbnRlbnQudHJpbSgpPT09J0RhcmsnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgZGFyayA9IGF3YWl0IHdhaXRGb3IoJ2RhcmsgYmFjaycsIGByZXR1cm4ge29rOiBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuZGF0YXNldC50aGVtZT09PSdkYXJrJywgZGV0YWlsOiAndGhlbWU9Jytkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuZGF0YXNldC50aGVtZX07YCwgNV8wMDApO1xyXG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidFc2NhcGUnLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgcmV0dXJuIFtsaWdodFswXSAmJiBkYXJrWzBdLCBgbGlnaHQ6ICR7bGlnaHRbMV19OyBkYXJrOiAke2RhcmtbMV19YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU5ODc2XHU2ODBGIFx1NEUyRC9FTiBcdTVGRUJcdTYzNzdcdTUyMDdcdTYzNjIoXHU1M0VGXHU1M0QxXHU3M0IwXHU2MDI3KSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTk4NzZcdTY4MEZcdTVGRUJcdTYzNzdcdTUyMDdcdTYzNjI6XHU0RTJEL0VOIFx1NEUwMFx1OTUyRVx1NTIwN1x1NjM2MicsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2xhbmcgc2VnJywgYHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5sYW5nLXNlZycpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhcyAmJiBzLnF1ZXJ5U2VsZWN0b3JBbGwoJ2J1dHRvbicpLmxlbmd0aCA9PT0gMiwgZGV0YWlsOiBzID8gJ3ByZXNlbnQnIDogJ2Fic2VudCd9O2AsIDVfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5sYW5nLXNlZyBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nRU4nO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgZW4gPSBhd2FpdCB3YWl0Rm9yKCdlbmdsaXNoJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyLWhlYWQgLmJ0bi5wcmltYXJ5Jyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFiICYmIGIudGV4dENvbnRlbnQgPT09ICcrIE5ldyBTZXNzaW9uJywgZGV0YWlsOiAnYnRuPScrKGI/Yi50ZXh0Q29udGVudDonbm9uZScpfTtgLCA1XzAwMCk7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcubGFuZy1zZWcgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NEUyRCc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCB6aCA9IGF3YWl0IHdhaXRGb3IoJ2NoaW5lc2UgYmFjaycsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhci1oZWFkIC5idG4ucHJpbWFyeScpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYiAmJiBiLnRleHRDb250ZW50ID09PSAnKyBcdTY1QjBcdTVFRkFcdTRGMUFcdThCREQnLCBkZXRhaWw6ICdidG49JysoYj9iLnRleHRDb250ZW50Oidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgICAgcmV0dXJuIFtlblswXSAmJiB6aFswXSwgYGVuOiAke2VuWzFdfTsgemg6ICR7emhbMV19YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU3Qzk4XHU4RDM0XHU1NkZFXHU3MjQ3IFx1MjE5MiBcdTdGMjlcdTc1NjVcdTU2RkUgY2hpcCBcdTIxOTIgXHU1M0QxXHU5MDAxIFx1MjE5MiBydW50aW1lIFx1NjUzNlx1NTIzMCA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTdDOThcdThEMzRcdTU2RkVcdTcyNDc6XHU3RjI5XHU3NTY1XHU1NkZFIGNoaXAgKyBcdTUzRDFcdTkwMDFcdTU0MEUgcnVudGltZSBcdTY1MzZcdTUyMzBcdTU2RkVcdTcyNDcnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIC8vIFx1NjVCMFx1NUVGQVx1NEYxQVx1OEJERFx1Nzg2RVx1NEZERCBjb21wb3NlciBcdTUzRUZcdTc1MjhcclxuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleTonbicsIGN0cmxLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XHJcbiAgICAgIGF3YWl0IHNsZWVwKDMwMCk7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXtcclxuICAgICAgICB2YXIgdGEgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY29tcG9zZXIgdGV4dGFyZWEnKTtcclxuICAgICAgICBpZiAoIXRhKSByZXR1cm47XHJcbiAgICAgICAgdmFyIGMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdjYW52YXMnKTtcclxuICAgICAgICBjLndpZHRoID0gODsgYy5oZWlnaHQgPSA4O1xyXG4gICAgICAgIHZhciBjdHggPSBjLmdldENvbnRleHQoJzJkJyk7XHJcbiAgICAgICAgY3R4LmZpbGxTdHlsZSA9ICcjM2Y5NjUwJzsgY3R4LmZpbGxSZWN0KDAsIDAsIDgsIDgpO1xyXG4gICAgICAgIGMudG9CbG9iKGZ1bmN0aW9uKGJsb2Ipe1xyXG4gICAgICAgICAgdmFyIGR0ID0gbmV3IERhdGFUcmFuc2ZlcigpO1xyXG4gICAgICAgICAgZHQuaXRlbXMuYWRkKG5ldyBGaWxlKFtibG9iXSwgJ3Bhc3RlZC5wbmcnLCB7dHlwZTogJ2ltYWdlL3BuZyd9KSk7XHJcbiAgICAgICAgICB0YS5kaXNwYXRjaEV2ZW50KG5ldyBDbGlwYm9hcmRFdmVudCgncGFzdGUnLCB7Y2xpcGJvYXJkRGF0YTogZHQsIGJ1YmJsZXM6IHRydWUsIGNhbmNlbGFibGU6IHRydWV9KSk7XHJcbiAgICAgICAgfSwgJ2ltYWdlL3BuZycpO1xyXG4gICAgICB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IGNoaXAgPSBhd2FpdCB3YWl0Rm9yKCdpbWFnZSBjaGlwJywgYHZhciBuPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5hdHQtY2hpcC5pbWcnKS5sZW5ndGg7XHJcbiAgICAgICAgcmV0dXJuIHtvazogbiA+PSAxLCBkZXRhaWw6ICdpbWcgY2hpcHM9JytufTtgLCA2XzAwMCk7XHJcbiAgICAgIGlmICghY2hpcFswXSkgcmV0dXJuIGNoaXA7XHJcbiAgICAgIGF3YWl0IHR5cGVJbnRvKCcuY29tcG9zZXIgdGV4dGFyZWEnLCAnXHU3NzBCXHU4RkQ5XHU1RjIwXHU1NkZFJyk7XHJcbiAgICAgIGF3YWl0IHNsZWVwKDIwMCk7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY29tcG9zZXIgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NTNEMVx1OTAwMSc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBkb25lID0gYXdhaXQgd2FpdEZvcignaW1hZ2Ugc2VudCcsIGBcclxuICAgICAgICB2YXIgYXAgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuYXBwcm92YWwtY2FyZCBidXR0b24nKTtcclxuICAgICAgICBpZiAoYXAgJiYgYXAudGV4dENvbnRlbnQudHJpbSgpLmluZGV4T2YoJ1x1NjI3OVx1NTFDNicpPj0wKSBhcC5jbGljaygpO1xyXG4gICAgICAgIHZhciB0cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50dXJuJykpO1xyXG4gICAgICAgIHZhciBoaXQgPSB0cy5maWx0ZXIoZnVuY3Rpb24oeCl7IHJldHVybiB4LmNsYXNzTmFtZS5pbmRleE9mKCd1c2VyJyk8MCAmJiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1tpbWFnZXM6IDFdJykgPj0gMDsgfSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogaGl0Lmxlbmd0aCA+PSAxLCBkZXRhaWw6ICdydW50aW1lLWVjaG8td2l0aC1pbWFnZT0nK2hpdC5sZW5ndGh9O1xyXG4gICAgICBgLCAxNV8wMDApO1xyXG4gICAgICBhd2FpdCBzaG90KCdwYXN0ZWQtaW1hZ2UnKTtcclxuICAgICAgcmV0dXJuIGRvbmU7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHVEODNEXHVEQ0NFIFx1NEUwQVx1NEYyMC9cdUQ4M0RcdURDQzEgXHU2RDRGXHU4OUM4XHU2MzA5XHU5NEFFXHU1QzMxXHU0RjREID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1OTY0NFx1NEVGNlx1NEUwRVx1NzZFRVx1NUY1NVx1NTE2NVx1NTNFMzpcdUQ4M0RcdURDQ0UgXHU0RTBBXHU0RjIwICsgXHVEODNEXHVEQ0MxIFx1NkQ0Rlx1ODlDOFx1NjMwOVx1OTRBRVx1NUI1OFx1NTcyOCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgciA9IChhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XHJcbiAgICAgICAgdmFyIHVwID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNvbXBvc2VyIGJ1dHRvblthcmlhLWxhYmVsKj1cIlx1NEUwQVx1NEYyMFwiXSwgLmNvbXBvc2VyIGJ1dHRvblthcmlhLWxhYmVsKj1cIlVwbG9hZFwiXScpO1xyXG4gICAgICAgIHZhciBiciA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1waWNrZXIgYnV0dG9uJyk7XHJcbiAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHt1cDogISF1cCwgYnJvd3NlOiAhIWJyfSk7XHJcbiAgICAgIH0pKClgKSkgYXMgc3RyaW5nO1xyXG4gICAgICBjb25zdCBwID0gSlNPTi5wYXJzZShyKSBhcyB7IHVwOiBib29sZWFuOyBicm93c2U6IGJvb2xlYW4gfTtcclxuICAgICAgcmV0dXJuIFtwLnVwICYmIHAuYnJvd3NlLCBgXHVEODNEXHVEQ0NFPSR7cC51cH0gXHVEODNEXHVEQ0MxPSR7cC5icm93c2V9YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6QCBcdTk2NDRcdTRFRjZcdTkwMDlcdTYyRTlcdTU2NjggPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnQCBcdTk2NDRcdTRFRjY6XHU5MDA5XHU2MkU5XHU1NjY4XHU1MUZBXHU3M0IwXHU1RTc2XHU1M0VGXHU5MDA5XHU2NTg3XHU0RUY2JywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNvbXBvc2VyIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdAJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdhdHQgcGlja2VyJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5hdHQtcGlja2VyJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFwLCBkZXRhaWw6IHAgPyAnb3BlbicgOiAnbm90IG9wZW4nfTtgLCA1XzAwMCk7XHJcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgIGF3YWl0IHR5cGVJbnRvKCcuYXR0LXBpY2tlciBpbnB1dCcsICdyZWFkJyk7XHJcbiAgICAgIGNvbnN0IHcyID0gYXdhaXQgd2FpdEZvcignYXR0IHJlc3VsdHMnLCBgdmFyIHI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmF0dC1yZXN1bHRzIC5mcy1yb3cnKS5sZW5ndGg7XHJcbiAgICAgICAgcmV0dXJuIHtvazogciA+PSAxLCBkZXRhaWw6ICdyZXN1bHRzPScrcn07YCwgNl8wMDApO1xyXG4gICAgICBpZiAoIXcyWzBdKSByZXR1cm4gdzI7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGY9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmF0dC1yZXN1bHRzIC5mcy1yb3cnKTsgaWYoZikgZi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdhdHQgY2hpcCcsIGB2YXIgYz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuYXR0LWNoaXAnKS5sZW5ndGg7XHJcbiAgICAgICAgcmV0dXJuIHtvazogYyA+PSAxLCBkZXRhaWw6ICdjaGlwcz0nK2N9O2AsIDVfMDAwKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZShcdTU0MTFcdTVCRkNcdTY3ODRcdTkwMjApOlx1OEJCRVx1N0Y2RVx1MzAwQ1x1OTFDRFx1NjVCMFx1OTE0RFx1N0Y2RVx1MzAwRFx1OTFDRFx1NTE2NSArIFx1OTAwOVx1NjJFOVx1NjMwMVx1NEU0NSA9PT09PT09PT09ICovXHJcbiAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfV0laQVJEID09PSAnZmFrZScpIHtcclxuICAgICAgYXdhaXQgc3RlcCgnXHU1NDExXHU1QkZDOlx1OEJCRVx1N0Y2RVx1MzAwQ1x1OTFDRFx1NjVCMFx1OTE0RFx1N0Y2RVx1MzAwRFx1OTFDRFx1NTE2NSArIFx1OTAwOVx1NjJFOVx1NjMwMVx1NEU0NSh3aXphcmQuanNvbiknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleToncCcsIGN0cmxLZXk6dHJ1ZSwgc2hpZnRLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XHJcbiAgICAgICAgY29uc3Qgb3BlbiA9IGF3YWl0IHdhaXRGb3IoJ3NldHRpbmdzIG9wZW4nLCBgdmFyIHM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNtZGsuc2V0dGluZ3MnKTtcclxuICAgICAgICAgIHJldHVybiB7b2s6ICEhcywgZGV0YWlsOiBzID8gJ29wZW4nIDogJ2Nsb3NlZCd9O2AsIDVfMDAwKTtcclxuICAgICAgICBpZiAoIW9wZW5bMF0pIHJldHVybiBvcGVuO1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY21kay5zZXR0aW5ncyBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTkxQ0RcdTY1QjBcdTkxNERcdTdGNkUnKT49MDt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgY29uc3Qgc2hvd24gPSBhd2FpdCB3YWl0Rm9yKCd3aXphcmQgcmVvcGVuZWQnLCBgcmV0dXJuIHtvazogISFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKSxcclxuICAgICAgICAgIGRldGFpbDogZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1vdmVybGF5JykgPyAnb3BlbicgOiAnY2xvc2VkJ307YCwgNV8wMDApO1xyXG4gICAgICAgIGlmICghc2hvd25bMF0pIHJldHVybiBzaG93bjtcclxuICAgICAgICBhd2FpdCBzaG90KCd3aXphcmQtcmVlbnRyeScpO1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NTNENlx1NkQ4OCc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgIGNvbnN0IGNsb3NlZCA9IGF3YWl0IHdhaXRGb3IoJ3dpemFyZCBjbG9zZWQnLCBgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3ZlcmxheScpLCBkZXRhaWw6ICdjbG9zZWQnfTtgLCA1XzAwMCk7XHJcbiAgICAgICAgY29uc3Qgc3QgPSAoYXdhaXQganMoYHdpbmRvdy5obWguZ2V0V2l6YXJkKCkudGhlbihmdW5jdGlvbihyKXtyZXR1cm4gSlNPTi5zdHJpbmdpZnkocik7fSlgKSkgYXMgc3RyaW5nO1xyXG4gICAgICAgIGNvbnN0IHAgPSBKU09OLnBhcnNlKHN0KSBhcyB7IHBlcnNpc3RlZD86IHsgZG9uZT86IGJvb2xlYW47IGNob2ljZT86IHN0cmluZyB9IH07XHJcbiAgICAgICAgY29uc3QgcGVyc2lzdGVkID0gcC5wZXJzaXN0ZWQ/LmRvbmUgPT09IHRydWUgJiYgcC5wZXJzaXN0ZWQ/LmNob2ljZSA9PT0gJ2J1bmRsZWQnO1xyXG4gICAgICAgIHJldHVybiBbY2xvc2VkWzBdICYmIHBlcnNpc3RlZCwgYGNsb3NlZD0ke2Nsb3NlZFswXX0gcGVyc2lzdGVkPSR7SlNPTi5zdHJpbmdpZnkocC5wZXJzaXN0ZWQgPz8gbnVsbCl9YF07XHJcbiAgICAgIH0pO1xyXG4gICAgfVxyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpISUcgXHU5NjM2XHU2QkI1MiBcdTIwMTRcdTIwMTQgXHU3QTg0XHU3QTk3XHU2MkJEXHU1QzQ5ICsgXHU2ODA3XHU5ODk4XHU2ODBGIDQ0cHgvZHJhZyBcdTUzM0EgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU3QTg0XHU3QTk3XHU2MkJEXHU1QzQ5Ojc2MHB4IFx1NEZBN1x1NjgwRlx1NTNFRlx1OEZCRVx1NTNFRlx1NTE3MyhcdTkwNkVcdTdGNjlcdTcwQjlcdTUxRkIgKyBFc2MpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICB0cnkgeyB3aW4uc2V0TWluaW11bVNpemUoNTYwLCA2MDApOyB3aW4uc2V0Qm91bmRzKHsgd2lkdGg6IDc2MCwgaGVpZ2h0OiA3MDAgfSk7IH0gY2F0Y2ggeyAvKiBiZXN0IGVmZm9ydCAqLyB9XHJcbiAgICAgIGNvbnN0IGlzTmFycm93ID0gYXdhaXQgd2FpdEZvcignbWF0Y2hNZWRpYSA4MjAnLCBgcmV0dXJuIHtvazogd2luZG93Lm1hdGNoTWVkaWEoJyhtYXgtd2lkdGg6IDgyMHB4KScpLm1hdGNoZXMsIGRldGFpbDogJ2l3PScgKyB3aW5kb3cuaW5uZXJXaWR0aH07YCwgNV8wMDApO1xyXG4gICAgICBpZiAoIWlzTmFycm93WzBdKSByZXR1cm4gaXNOYXJyb3c7XHJcbiAgICAgIC8vIFx1N0I0OSBSZWFjdCBcdTYzMDlcdTdBODRcdTdBOTdcdTkxQ0RcdTZFMzJcdTY3RDNcdTUxRkFcdTYyQkRcdTVDNDlcdTYzMDlcdTk0QUUoYXJpYS1sYWJlbCBcdTYzNjJcdTYyMTBcIlx1NjJCRFx1NUM0OVwiXHU2NTg3XHU2ODQ4KVx1NTE4RFx1NzBCOVx1MjAxNFx1MjAxNENTUyBcdTY1QURcdTcwQjlcdTUzNzNcdTY1RjYsXHJcbiAgICAgIC8vIFJlYWN0IHN0YXRlIFx1NjcwOVx1NkJFQlx1NzlEMlx1N0VBN1x1NUVGNlx1OEZERixcdTc2RjJcdTcwQjlcdTRGMUFcdTg0M0RcdTU3MjhcdTY1RTdcdTc2ODRcIlx1NjUzNlx1OEQ3N1x1NEZBN1x1NjgwRlwiXHU0RTBBXHJcbiAgICAgIGNvbnN0IGJ0biA9IGF3YWl0IHdhaXRGb3IoJ2RyYXdlciBidXR0b24nLCBgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudG9wYmFyIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiAoeC5nZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnKXx8JycpLmluZGV4T2YoJ1x1NjJCRFx1NUM0OScpPj0wO30pO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYiwgZGV0YWlsOiAnYnRuPScrKGI/Yi5nZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnKTonbm9uZScpfTtgLCA1XzAwMCk7XHJcbiAgICAgIGlmICghYnRuWzBdKSByZXR1cm4gYnRuO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnRvcGJhciBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4gKHguZ2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJyl8fCcnKS5pbmRleE9mKCdcdTYyQkRcdTVDNDknKT49MDt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IG9wZW5lZCA9IGF3YWl0IHdhaXRGb3IoJ2RyYXdlciBvcGVuJywgYHZhciBzYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhcicpLCBzYz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhci1zY3JpbScpO1xyXG4gICAgICAgIHZhciByPXNiP3NiLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOm51bGw7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFyICYmIHIueCA+PSAwICYmIHIueCA8IDQwICYmICEhc2MsIGRldGFpbDogJ3g9Jysocj9NYXRoLnJvdW5kKHIueCk6J25vbmUnKSsnIHNjcmltPScrKHNjPyd5ZXMnOidubycpfTtgLCA1XzAwMCk7XHJcbiAgICAgIGF3YWl0IHNob3QoJ2RyYXdlci1vcGVuJyk7XHJcbiAgICAgIC8vIFx1OTA2RVx1N0Y2OVx1NzBCOVx1NTFGQlx1NTE3M1x1OTVFRCBcdTIxOTIgXHU0RkE3XHU2ODBGXHU2RUQxXHU1MUZBKHggPCAwKSsgXHU5MDZFXHU3RjY5XHU2RDg4XHU1OTMxXHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHNjPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyLXNjcmltJyk7IGlmKHNjKSBzYy5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IGNsb3NlZCA9IGF3YWl0IHdhaXRGb3IoJ2RyYXdlciBjbG9zZWQgYnkgc2NyaW0nLCBgdmFyIHNiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyJyksIHNjPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyLXNjcmltJyk7XHJcbiAgICAgICAgdmFyIHI9c2I/c2IuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk6bnVsbDtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXIgJiYgci54IDwgMCAmJiAhc2MsIGRldGFpbDogJ3g9Jysocj9NYXRoLnJvdW5kKHIueCk6J25vbmUnKSsnIHNjcmltPScrKHNjPyd5ZXMnOidubycpfTtgLCA1XzAwMCk7XHJcbiAgICAgIC8vIEVzYyBcdTRFNUZcdTgwRkRcdTVGMDAvXHU1MTczXHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudG9wYmFyIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiAoeC5nZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnKXx8JycpLmluZGV4T2YoJ1x1NjJCRFx1NUM0OScpPj0wO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgYXdhaXQgd2FpdEZvcignZHJhd2VyIHJlb3BlbicsIGB2YXIgc2I9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXInKTsgdmFyIHI9c2I/c2IuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk6bnVsbDtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXIgJiYgci54ID49IDAgJiYgci54IDwgNDAsIGRldGFpbDogJ3g9Jysocj9NYXRoLnJvdW5kKHIueCk6J25vbmUnKX07YCwgNV8wMDApO1xyXG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidFc2NhcGUnLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgY29uc3QgZXNjQ2xvc2VkID0gYXdhaXQgd2FpdEZvcignZHJhd2VyIGNsb3NlZCBieSBFc2MnLCBgdmFyIHNiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyJyk7IHZhciByPXNiP3NiLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOm51bGw7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFyICYmIHIueCA8IDAsIGRldGFpbDogJ3g9Jysocj9NYXRoLnJvdW5kKHIueCk6J25vbmUnKX07YCwgNV8wMDApO1xyXG4gICAgICAvLyBcdTYwNjJcdTU5MERcdTVCQkRcdTdBOTc6XHU0RkE3XHU2ODBGXHU1NkRFXHU1MjMwIGdyaWQgXHU1MjE3KGRpc3BsYXkgXHU5NzVFIG5vbmUsXHU2QjYzXHU1RTM4XHU1MjE3XHU1RTAzXHU1QzQwKVxyXG4gICAgICB0cnkgeyB3aW4uc2V0Qm91bmRzKHsgd2lkdGg6IDEyODAsIGhlaWdodDogODAwIH0pOyB9IGNhdGNoIHsgLyogYmVzdCBlZmZvcnQgKi8gfVxyXG4gICAgICBhd2FpdCBzbGVlcCg0MDApO1xyXG4gICAgICBjb25zdCB3aWRlID0gYXdhaXQgd2FpdEZvcignd2lkZSByZXN0b3JlZCcsIGB2YXIgc2I9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXInKTsgdmFyIHI9c2I/c2IuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk6bnVsbDtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXIgJiYgci53aWR0aCA+IDIwMCAmJiBnZXRDb21wdXRlZFN0eWxlKHNiKS5kaXNwbGF5ICE9PSAnbm9uZScsIGRldGFpbDogJ3c9Jysocj9NYXRoLnJvdW5kKHIud2lkdGgpOidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgICAgcmV0dXJuIFtvcGVuZWRbMF0gJiYgY2xvc2VkWzBdICYmIGVzY0Nsb3NlZFswXSAmJiB3aWRlWzBdLCBgb3BlbjogJHtvcGVuZWRbMV19OyBzY3JpbS1jbG9zZTogJHtjbG9zZWRbMV19OyBlc2MtY2xvc2U6ICR7ZXNjQ2xvc2VkWzFdfTsgd2lkZTogJHt3aWRlWzFdfWBdO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdcdTY4MDdcdTk4OThcdTY4MEY6NDRweCArIGRyYWcgXHU1MzNBKFx1ODNEQ1x1NTM1NSBuby1kcmFnO292ZXJsYXkgXHU5QUQ4XHU1RUE2XHU0RTAwXHU4MUY0KScsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgciA9IChhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XHJcbiAgICAgICAgdmFyIHRiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy50aXRsZWJhcicpLCBtYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudGl0bGViYXItbWVudScpO1xyXG4gICAgICAgIGlmKCF0YiB8fCAhbWIpIHJldHVybiBKU09OLnN0cmluZ2lmeSh7b2s6ZmFsc2UsIGRldGFpbDonbWlzc2luZyB0aXRsZWJhci9tZW51J30pO1xyXG4gICAgICAgIHZhciBjcz1nZXRDb21wdXRlZFN0eWxlKHRiKSwgbXM9Z2V0Q29tcHV0ZWRTdHlsZShtYik7XHJcbiAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHsgb2s6IGNzLmhlaWdodCA9PT0gJzQ0cHgnICYmIGNzLndlYmtpdEFwcFJlZ2lvbiA9PT0gJ2RyYWcnICYmIG1zLndlYmtpdEFwcFJlZ2lvbiA9PT0gJ25vLWRyYWcnICYmIG1iLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpLmhlaWdodCA+PSAzNixcclxuICAgICAgICAgIGRldGFpbDogJ2g9Jytjcy5oZWlnaHQrJyByZWdpb249Jytjcy53ZWJraXRBcHBSZWdpb24rJyBtZW51LXJlZ2lvbj0nK21zLndlYmtpdEFwcFJlZ2lvbisnIG1lbnUtaD0nK01hdGgucm91bmQobWIuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCkuaGVpZ2h0KSB9KTtcclxuICAgICAgfSkoKWApKSBhcyBzdHJpbmc7XHJcbiAgICAgIGNvbnN0IHAgPSBKU09OLnBhcnNlKHIpIGFzIHsgb2s6IGJvb2xlYW47IGRldGFpbDogc3RyaW5nIH07XHJcbiAgICAgIC8vIFx1NEUzQlx1OEZEQlx1N0EwQlx1NEZBNzpcdTUzOUZcdTc1MUYgdGl0bGVCYXJPdmVybGF5IFx1OUFEOFx1NUVBNlx1OTg3Qlx1NTQwQ1x1NEUzQSA0NChXaW5kb3dzIFx1NjI0RFx1NjcwOSBvdmVybGF5O1x1NjVFN1x1N0M3Qlx1NTc4Qlx1N0YzQVx1NkI2NCBBUEksXHU1M0VGXHU5MDA5XHU4QzAzXHU3NTI4KVxyXG4gICAgICBsZXQgb3ZlcmxheSA9ICduL2EnO1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHByb2JlID0gd2luIGFzIHVua25vd24gYXMgeyBnZXRUaXRsZUJhck92ZXJsYXk/OiAoKSA9PiB7IGhlaWdodD86IG51bWJlciB9IHwgbnVsbCB9O1xyXG4gICAgICAgIGNvbnN0IG8gPSBwcm9iZS5nZXRUaXRsZUJhck92ZXJsYXk/LigpID8/IG51bGw7XHJcbiAgICAgICAgb3ZlcmxheSA9IG8gIT09IG51bGwgPyBTdHJpbmcoby5oZWlnaHQpIDogJ24vYSc7XHJcbiAgICAgIH0gY2F0Y2ggeyAvKiBcdTVFNzNcdTUzRjBcdTY1RTAgb3ZlcmxheSAqLyB9XHJcbiAgICAgIHJldHVybiBbcC5vayA9PT0gdHJ1ZSwgYCR7cC5kZXRhaWx9IG92ZXJsYXktaD0ke292ZXJsYXl9YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICBhd2FpdCBzaG90KCdmaW5hbCcpO1xyXG4gIH0gZWxzZSBpZiAoKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX1dJWkFSRCA/PyAnJykgIT09ICcnKSB7XHJcbiAgICAvKiA9PT09PT09PT09IHJlYWwoXHU1NDExXHU1QkZDXHU2Nzg0XHU5MDIwLFx1NEU5Mlx1NjVBNVx1NEU4RVx1NUUzOFx1ODlDNCByZWFsIFx1NkI2NVx1OUFBNCk6XHJcbiAgICAgICBXWjIgXHU2NzJDXHU2NzNBXHU3NzFGXHU1QjlFXHU2OEMwXHU2RDRCKFx1OUVEOFx1OEJBNFx1NTE3MVx1NEVBQlx1OTg3NSkvIFdaMyBcdTRFMEJcdThGN0RcdTVCODlcdTg4QzVcdTVCOUVcdTZENEIgPT09PT09PT09PSAqL1xyXG4gICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX1dJWkFSRCA9PT0gJ2RldGVjdCcpIHtcclxuICAgICAgYXdhaXQgc3RlcCgnXHU1NDExXHU1QkZDKFx1NzcxRlx1NUI5RSk6XHU2QjIyXHU4RkNFXHUyMTkyXHU2OEMwXHU2RDRCXHU1MjMwXHU2NzJDXHU2NzNBXHU1REYyXHU4OEM1IENMSShcdTlFRDhcdThCQTRcdTUxNzFcdTRFQUIsXHU1MkZFXHU5MDA5XHU2QjYzXHU3ODZFKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignd2l6YXJkIG92ZXJsYXknLCBgdmFyIG89ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1vdmVybGF5Jyk7XHJcbiAgICAgICAgICB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1RjAwXHU1OUNCXHU5MTREXHU3RjZFJzt9KTtcclxuICAgICAgICAgIHJldHVybiB7b2s6ICEhbyAmJiAhIWIsIGRldGFpbDogbyA/ICdvdmVybGF5K1x1NUYwMFx1NTlDQlx1OTE0RFx1N0Y2RScgOiAnbm8gb3ZlcmxheSd9O2AsIDEyXzAwMCk7XHJcbiAgICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgICBhd2FpdCBzaG90KCd3aXphcmQtcmVhbC13ZWxjb21lJyk7XHJcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1RjAwXHU1OUNCXHU5MTREXHU3RjZFJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgY29uc3QgZm91bmQgPSBhd2FpdCB3YWl0Rm9yKCdkZXRlY3QgZm91bmQnLCBgdmFyIHA9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLWRldGVjdCcpO1xyXG4gICAgICAgICAgaWYoIXApIHJldHVybiB7b2s6ZmFsc2UsIGRldGFpbDonZGV0ZWN0IHBhZ2Ugbm90IHNob3duJ307XHJcbiAgICAgICAgICB2YXIgdD1wLnRleHRDb250ZW50O1xyXG4gICAgICAgICAgdmFyIG9rMT10LmluZGV4T2YoJ1x1NjhDMFx1NkQ0Qlx1NTIzMFx1NURGMlx1NUI4OVx1ODhDNSBobWhhcm5lc3MgdicpPj0wO1xyXG4gICAgICAgICAgdmFyIG9rMj10LmluZGV4T2YoJ1x1OUVEOFx1OEJBNFx1NTE3MVx1NEVBQlx1NEY3Rlx1NzUyOFx1NUI4MyhcdTYzQThcdTgzNTApJyk+PTA7XHJcbiAgICAgICAgICB2YXIgcmFkaW89cC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW9wdC5vbicpO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogb2sxJiZvazImJiEhcmFkaW8sIGRldGFpbDogdC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsOTApfTtgLCAyMF8wMDApO1xyXG4gICAgICAgIGF3YWl0IHNob3QoJ3dpemFyZC1yZWFsLWRldGVjdCcpO1xyXG4gICAgICAgIHJldHVybiBmb3VuZDtcclxuICAgICAgfSk7XHJcbiAgICB9IGVsc2UgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX1dJWkFSRCA9PT0gJ2luc3RhbGwnKSB7XHJcbiAgICAgIGF3YWl0IHN0ZXAoJ1x1NTQxMVx1NUJGQyhcdTc3MUZcdTVCOUUpOlx1NjhDMFx1NkQ0Qlx1MjE5Mlx1NEVDRFx1ODk4MVx1NEUwQlx1OEY3RFx1NjVCMFx1NzI0OFx1MjE5Mlx1OTAwOVx1NjJFOVx1MjQ2MFx1MjE5Mlx1OEZEQlx1NTE2NVx1NUI4OVx1ODhDNVx1OTg3NScsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignd2l6YXJkIG92ZXJsYXknLCBgdmFyIG89ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1vdmVybGF5Jyk7XHJcbiAgICAgICAgICByZXR1cm4ge29rOiAhIW8sIGRldGFpbDogbyA/ICdvcGVuJyA6ICdjbG9zZWQnfTtgLCAxMl8wMDApO1xyXG4gICAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1RjAwXHU1OUNCXHU5MTREXHU3RjZFJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgY29uc3QgZm91bmQgPSBhd2FpdCB3YWl0Rm9yKCdkZXRlY3QgZm91bmQnLCBgdmFyIHA9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLWRldGVjdCcpO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogISFwICYmIHAudGV4dENvbnRlbnQuaW5kZXhPZignXHU2OEMwXHU2RDRCXHU1MjMwXHU1REYyXHU1Qjg5XHU4OEM1IGhtaGFybmVzcyB2Jyk+PTAsIGRldGFpbDogcCA/IHAudGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDYwKSA6ICdubyBkZXRlY3QgcGFnZSd9O2AsIDIwXzAwMCk7XHJcbiAgICAgICAgaWYgKCFmb3VuZFswXSkgcmV0dXJuIGZvdW5kO1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIG89W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW9wdCcpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1NEVDRFx1ODk4MVx1NEUwQlx1OEY3RFx1NjVCMFx1NzI0OCcpPj0wO30pOyBpZihvKSBvLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICBhd2FpdCBzbGVlcCgyMDApO1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NEUwQlx1NEUwMFx1NkI2NSc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgIGNvbnN0IHNlbCA9IGF3YWl0IHdhaXRGb3IoJ3NlbGVjdCBwYWdlIFx1MjQ2MCBvbicsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2Utc2VsZWN0Jyk7XHJcbiAgICAgICAgICB2YXIgb249cD9wLnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3B0Lm9uJyk6bnVsbDtcclxuICAgICAgICAgIHJldHVybiB7b2s6ICEhcCAmJiAhIW9uICYmIG9uLnRleHRDb250ZW50LmluZGV4T2YoJ1x1NEUwQlx1OEY3RFx1NUI4OVx1ODhDNVx1NUI4Q1x1NjU3NCBobWggQ0xJJyk+PTAsIGRldGFpbDogcCA/ICdzZWxlY3QgXHUyNDYwIG9uJyA6ICdubyBzZWxlY3QnfTtgLCA4XzAwMCk7XHJcbiAgICAgICAgaWYgKCFzZWxbMF0pIHJldHVybiBzZWw7XHJcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1RjAwXHU1OUNCXHU1Qjg5XHU4OEM1Jzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgcmV0dXJuIHdhaXRGb3IoJ2luc3RhbGwgcGFnZScsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtaW5zdGFsbCcpO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogISFwLCBkZXRhaWw6IHAgPyAnaW5zdGFsbGluZycgOiAnbm90IHNob3duJ307YCwgOF8wMDApO1xyXG4gICAgICB9KTtcclxuICAgICAgYXdhaXQgc3RlcCgnXHU1NDExXHU1QkZDKFx1NzcxRlx1NUI5RSk6XHU1Qjg5XHU4OEM1XHU4RkRCXHU1RUE2XHU1M0VGXHU4OUMxKFx1NkI2NVx1OUFBNFx1NjU4N1x1Njg0OC9cdTRFMEJcdThGN0RcdTc2N0VcdTUyMDZcdTZCRDRcdTZFREFcdTUyQTgpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdwcm9ncmVzcyB2aXNpYmxlJywgYHZhciBiYXI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1wcm9ncmVzcycpO1xyXG4gICAgICAgICAgdmFyIGxvZz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWluc3RhbGwtbG9nJyk7XHJcbiAgICAgICAgICB2YXIgbGluZXM9bG9nP2xvZy50ZXh0Q29udGVudC5zcGxpdCgnXFxcXG4nKS5maWx0ZXIoZnVuY3Rpb24oeCl7cmV0dXJuIHgudHJpbSgpIT09Jyc7fSk6W107XHJcbiAgICAgICAgICByZXR1cm4ge29rOiAhIWJhciAmJiBsaW5lcy5sZW5ndGg+PTEsIGRldGFpbDogJ2Jhcj0nKyhiYXI/J3knOiduJykrJyBsaW5lcz0nK2xpbmVzLmxlbmd0aCsobGluZXMubGVuZ3RoPjA/KCcgbGFzdD0nKyhsaW5lc1tsaW5lcy5sZW5ndGgtMV18fCcnKS5zbGljZSgwLDUwKSk6JycpfTtgLCA2MF8wMDApO1xyXG4gICAgICAgIGF3YWl0IHNob3QoJ3dpemFyZC1yZWFsLWluc3RhbGwnKTtcclxuICAgICAgICByZXR1cm4gdztcclxuICAgICAgfSk7XHJcbiAgICAgIGF3YWl0IHN0ZXAoJ1x1NTQxMVx1NUJGQyhcdTc3MUZcdTVCOUUpOlx1NUI4OVx1ODhDNVx1NUI4Q1x1NjIxMFx1MjE5Mlx1OTE0RFx1N0Y2RVx1OERGM1x1OEZDNyhcdTVERjJcdTY3MDlcdTVCQzZcdTk0QTUpXHUyMTkyXHU1QjhDXHU2MjEwXHU5ODc1XHUyMTkyXHU1RjAwXHU1OUNCXHU0RjdGXHU3NTI4XHUyMTkyXHU2NUIwIHJ1bnRpbWUgXHU4RkRFXHU2M0E1JywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIC8vIFx1NUI4OVx1ODhDNVx1NTE2OFx1N0EwQihucG0gXHU4OUUzXHU2NzkwK1x1NEUwQlx1OEY3RCtcdTg0M0RcdTc2RDg7XHU5NTVDXHU1MENGIG5wbW1pcnJvciBcdTkwMUFcdTVFMzggPDIgXHU1MjA2XHU5NDlGKSxcdTRFMEFcdTk2NTAgOCBcdTUyMDZcdTk0OUZcclxuICAgICAgICBhd2FpdCB3YWl0Rm9yKCdkb25lIHBhZ2UnLCBgdmFyIGQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLWRvbmUnKTtcclxuICAgICAgICAgIGlmKGQpIHJldHVybiB7b2s6dHJ1ZSwgZGV0YWlsOidkb25lJ307XHJcbiAgICAgICAgICB2YXIgYz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtY29uZmlnJyk7XHJcbiAgICAgICAgICBpZihjKXsgdmFyIHM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU4REYzXHU4RkM3Jyk+PTA7fSk7IGlmKHMpIHMuY2xpY2soKTsgfVxyXG4gICAgICAgICAgdmFyIGVycj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWVycm9yJyk7XHJcbiAgICAgICAgICBpZihlcnIpIHJldHVybiB7b2s6ZmFsc2UsIGRldGFpbDonaW5zdGFsbCBlcnJvcjogJytlcnIudGV4dENvbnRlbnQuc2xpY2UoMCw4MCl9O1xyXG4gICAgICAgICAgcmV0dXJuIHtvazpmYWxzZSwgZGV0YWlsOidpbnN0YWxsaW5nXHUyMDI2J307YCwgOCAqIDYwXzAwMCk7XHJcbiAgICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2RvbmUgcmVhZHkgdGV4dCcsIGB2YXIgZD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtZG9uZScpO1xyXG4gICAgICAgICAgdmFyIHQ9ZD9kLnRleHRDb250ZW50OicnO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogISFkICYmIHQuaW5kZXhPZignXHU1QzMxXHU3RUVBJyk+PTAsIGRldGFpbDogdC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNjApfTtgLCAxMF8wMDApO1xyXG4gICAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgICAgYXdhaXQgc2hvdCgnd2l6YXJkLXJlYWwtZG9uZScpO1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NUYwMFx1NTlDQlx1NEY3Rlx1NzUyOCc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgIGNvbnN0IGNvbm5lY3RlZCA9IGF3YWl0IHdhaXRGb3IoJ25ldyBydW50aW1lIGNvbm5lY3RlZCcsIGB2YXIgZG90PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ob3N0LWRvdC5vbicpO1xyXG4gICAgICAgICAgdmFyIGw9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmhvc3QtbGFiZWwnKTtcclxuICAgICAgICAgIHJldHVybiB7b2s6ICEhZG90ICYmICEhbCAmJiBsLnRleHRDb250ZW50LmluZGV4T2YoJ3J1bnRpbWUnKT49MCwgZGV0YWlsOiAnZG90PScrKGRvdD8nb24nOidvZmYnKSsnIGxhYmVsPScrKGw/bC50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNTApOidub25lJyl9O2AsIDYwXzAwMCk7XHJcbiAgICAgICAgY29uc3Qgc3QgPSAoYXdhaXQganMoYHdpbmRvdy5obWguZ2V0U3RhdGUoKS50aGVuKGZ1bmN0aW9uKHIpe3JldHVybiBKU09OLnN0cmluZ2lmeSh7bW9kZTpyLm1vZGUsIHJ1bnRpbWVFbnRyeTpyLnJ1bnRpbWVFbnRyeX0pO30pYCkpIGFzIHN0cmluZztcclxuICAgICAgICBjb25zdCBwID0gSlNPTi5wYXJzZShzdCkgYXMgeyBtb2RlPzogc3RyaW5nOyBydW50aW1lRW50cnk/OiBzdHJpbmcgfCBudWxsIH07XHJcbiAgICAgICAgY29uc3QgZW50cnlPayA9IChwLnJ1bnRpbWVFbnRyeSA/PyAnJykuaW5kZXhPZignLmhtaGFybmVzcy1nbG9iYWwnKSA+PSAwO1xyXG4gICAgICAgIGF3YWl0IHNob3QoJ3dpemFyZC1yZWFsLWZpbmFsJyk7XHJcbiAgICAgICAgcmV0dXJuIFtjb25uZWN0ZWRbMF0gJiYgZW50cnlPaywgYGNvbm5lY3RlZDogJHtjb25uZWN0ZWRbMV19OyBzdGF0ZT0ke3N0LnNsaWNlKDAsIDkwKX1gXTtcclxuICAgICAgfSk7XHJcbiAgICB9XHJcbiAgICBhd2FpdCBzaG90KCdmaW5hbCcpO1xyXG4gIH0gZWxzZSB7XHJcbiAgICAvKiA9PT09PT09PT09IHJlYWw6XHU1M0VBXHU4QkZCXHU1QjUwXHU5NkM2KFx1NEUwRFx1NTJBOFx1NzcxRlx1NUI5RVx1NEYxQVx1OEJERCkgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU5ODc2XHU2ODBGOnJ1bnRpbWUgXHU3MjQ4XHU2NzJDXHU0RTBFXHU3QUVGXHU1M0UzXHU1REYyXHU2NjNFXHU3OTNBKFx1OTc1RSA/KScsIGFzeW5jICgpID0+IHtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2hvc3QgbGFiZWwnLCBgdmFyIGw9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmhvc3QtbGFiZWwnKTtcclxuICAgICAgICB2YXIgdCA9IGwgPyBsLnRleHRDb250ZW50IDogJyc7XHJcbiAgICAgICAgcmV0dXJuIHtvazogdC5pbmRleE9mKCc/JykgPCAwICYmIHQuaW5kZXhPZigncnVudGltZScpID49IDAsIGRldGFpbDogdC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNjApfTtgLCAxNV8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdcdTRGMUFcdThCRERcdTUyMTdcdTg4Njg6XHU3NzFGXHU1QjlFXHU1Mzg2XHU1M0YyXHU1MkEwXHU4RjdEKFx1NjU3MFx1OTFDRj4wKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ3Nlc3Npb25zJywgYHZhciBuPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGg7XHJcbiAgICAgICAgcmV0dXJuIHtvazogbiA+IDAsIGRldGFpbDogJ3Nlc3Npb25zPScrbn07YCwgMTVfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnXHU3MEI5XHU1MUZCXHU1Mzg2XHU1M0YyXHU0RjFBXHU4QkREIFx1MjE5MiBcdTc3MUZcdTVCOUUgdHJhbnNjcmlwdCBcdTUxODVcdTVCQjlcdTUzRUZcdTg5QzEnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IG4gPSAoYXdhaXQganMoYGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGhgKSkgYXMgbnVtYmVyO1xyXG4gICAgICBpZiAobiA9PT0gMCkgcmV0dXJuIFtmYWxzZSwgJ25vIHNlc3Npb25zIHRvIGNsaWNrJ107XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGl0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zZXNzaW9uLWl0ZW0nKTsgaWYgKGl0KSBpdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdoaXN0b3J5IHR1cm5zJywgYHZhciB0cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50dXJuJykpO1xyXG4gICAgICAgIHJldHVybiB7b2s6IHRzLmxlbmd0aCA+PSAxLCBkZXRhaWw6ICd0dXJucz0nK3RzLmxlbmd0aCsnIGZpcnN0PScrKHRzWzBdP3RzWzBdLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw0MCk6J25vbmUnKX07YCwgMTVfMDAwKTtcclxuICAgICAgYXdhaXQgc2hvdCgncmVhbC1oaXN0b3J5Jyk7XHJcbiAgICAgIHJldHVybiB3O1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdEb2NrOk92ZXJ2aWV3IFx1NzcxRlx1NUI5RVx1NjU3MFx1NjM2RShydW50aW1lIFx1NzI0OFx1NjcyQ1x1OTc1RVx1NjVFMFx1NjU3MFx1NjM2RSknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdPdmVydmlldyc7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignb3ZlcnZpZXcnLCBgdmFyIHJvd3M9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay1yb3cnKSk7XHJcbiAgICAgICAgdmFyIHZlciA9IHJvd3MuZmluZChmdW5jdGlvbihyKXsgcmV0dXJuIHIudGV4dENvbnRlbnQuaW5kZXhPZigncnVudGltZSBcdTcyNDhcdTY3MkMnKT49MDsgfSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISF2ZXIgJiYgdmVyLnRleHRDb250ZW50LmluZGV4T2YoJ1x1NjVFMFx1NjU3MFx1NjM2RScpIDwgMCwgZGV0YWlsOiB2ZXIgPyB2ZXIudGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDUwKSA6ICdubyB2ZXIgcm93J307YCwgMTBfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnRG9jazpEaWZmIFx1NzcxRlx1NUI5RSBnaXQgXHU3MkI2XHU2MDAxKFx1OTc1RVx1NTJBMFx1OEY3RFx1NEUyRCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdcdTUzRDhcdTY2RjQnfHx4LnRleHRDb250ZW50PT09J0RpZmYnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2RpZmYnLCBgdmFyIHA9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmRpZmYtcGFuZScpO1xyXG4gICAgICAgIHZhciB0ID0gcCA/IHAudGV4dENvbnRlbnQgOiAnJztcclxuICAgICAgICByZXR1cm4ge29rOiAhIXAgJiYgdC5pbmRleE9mKCdcdTUyQTBcdThGN0RcdTRFMkQnKSA8IDAsIGRldGFpbDogdC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNjApfTtgLCAxNV8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdEb2NrOkV2aWRlbmNlIFx1NzcxRlx1NUI5RVx1OEJBNFx1NzdFNVx1NjU3MFx1NjM2RScsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J1x1OEJDMVx1NjM2RSd8fHgudGV4dENvbnRlbnQ9PT0nRXZpZGVuY2UnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2V2aWRlbmNlJywgYHZhciByb3dzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stcm93JykpO1xyXG4gICAgICAgIHZhciBtZW0gPSByb3dzLmZpbmQoZnVuY3Rpb24ocil7IHJldHVybiByLnRleHRDb250ZW50LmluZGV4T2YoJ1x1OEJCMFx1NUZDNlx1NUM0MicpPj0wIHx8IHIudGV4dENvbnRlbnQuaW5kZXhPZignTWVtb3J5IGxheWVycycpPj0wOyB9KTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIW1lbSAmJiBtZW0udGV4dENvbnRlbnQuaW5kZXhPZignXHUyMDI2JykgPCAwLCBkZXRhaWw6IG1lbSA/IG1lbS50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNTApIDogJ25vIHJvdyd9O2AsIDE1XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ1x1OTY0NFx1NEVGNlx1NEUwRVx1NzZFRVx1NUY1NVx1NTE2NVx1NTNFMzpcdUQ4M0RcdURDQ0UgXHU0RTBBXHU0RjIwICsgXHU5ODc2XHU2ODBGXHU0RTJEL0VOICsgXHVEODNEXHVEQ0MxIFx1NkQ0Rlx1ODlDOFx1NjMwOVx1OTRBRVx1NUI1OFx1NTcyOCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J1x1NjU4N1x1NEVGNid8fHgudGV4dENvbnRlbnQ9PT0nRmlsZXMnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgYXdhaXQgd2FpdEZvcignZmlsZXMgdGFiJywgYHZhciB0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5kb2NrLXRhYi5hY3RpdmUnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXQgJiYgKHQudGV4dENvbnRlbnQ9PT0nXHU2NTg3XHU0RUY2J3x8dC50ZXh0Q29udGVudD09PSdGaWxlcycpLCBkZXRhaWw6ICdhY3RpdmU9JysodD90LnRleHRDb250ZW50Oidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgICAgLy8gcmVhbCBcdTZBMjFcdTVGMEYgd29ya3NwYWNlcyBcdThCRjdcdTZDNDJcdThENzAgcnVudGltZShcdTUxQjdcdTU0MkZcdTUyQThcdTU0MEVcdTUzRUZcdTgwRkRcdTYzOTJcdTk2MUYpLFx1NjUzRVx1NUJCRFx1NTIzMCAxNXNcclxuICAgICAgY29uc3Qgd3MgPSBhd2FpdCB3YWl0Rm9yKCd3cyBwaWNrZXInLCBgdmFyIHc9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLXBpY2tlcicpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhdywgZGV0YWlsOiB3ID8gJ2xvYWRlZCcgOiAnd29ya3NwYWNlcyBub3QgbG9hZGVkIHlldCd9O2AsIG1vZGUgPT09ICdyZWFsJyA/IDE1XzAwMCA6IDZfMDAwKTtcclxuICAgICAgY29uc3QgciA9IChhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XHJcbiAgICAgICAgdmFyIHVwID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNvbXBvc2VyIGJ1dHRvblthcmlhLWxhYmVsKj1cIlx1NEUwQVx1NEYyMFwiXSwgLmNvbXBvc2VyIGJ1dHRvblthcmlhLWxhYmVsKj1cIlVwbG9hZFwiXScpO1xyXG4gICAgICAgIHZhciBsYW5nID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmxhbmctc2VnJyk7XHJcbiAgICAgICAgdmFyIGJyID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLXBpY2tlciBidXR0b24nKTtcclxuICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe3VwOiAhIXVwLCBsYW5nOiAhIWxhbmcsIGJyb3dzZTogISFicn0pO1xyXG4gICAgICB9KSgpYCkpIGFzIHN0cmluZztcclxuICAgICAgY29uc3QgcCA9IEpTT04ucGFyc2UocikgYXMgeyB1cDogYm9vbGVhbjsgbGFuZzogYm9vbGVhbjsgYnJvd3NlOiBib29sZWFuIH07XHJcbiAgICAgIHJldHVybiBbcC51cCAmJiBwLmxhbmcgJiYgcC5icm93c2UsIGBcdUQ4M0RcdURDQ0U9JHtwLnVwfSBcdTRFMkQvRU49JHtwLmxhbmd9IFx1RDgzRFx1RENDMT0ke3AuYnJvd3NlfTsgJHt3c1sxXX1gXTtcclxuICAgIH0pO1xyXG4gICAgLyogPT09PT09PT09PSByZWFsOlx1NzcxRlx1NUI5RVx1NEVGQlx1NTJBMVx1N0FFRlx1NTIzMFx1N0FFRlx1OTk5Nlx1OUE4QyhcdTUzRDFcdTc3RURcdTRFRkJcdTUyQTFcdTIxOTJcdTZBMjFcdTU3OEJcdTU2REVcdTU5MEQpID09PT09PT09PT1cclxuICAgICAgIFx1NzUyOFx1NjIzNyBnbG0tNS4zIFx1NURGMlx1OTE0RFx1N0Y2RTtcdTYzRDBcdTc5M0FcdThCQ0RcdTdFQTZcdTY3NUZcdTc2RjRcdTYzQTVcdTU2REVcdTU5MERcdTMwMDJcdTgyRTUgYWdlbnQgXHU4QkY3XHU2QzQyXHU1QkExXHU2Mjc5LFx1OEY2RVx1OEJFMlx1OTFDQ1xyXG4gICAgICAgXHU4MUVBXHU1MkE4XHU3MEI5XHU2Mjc5XHU1MUM2KFx1NjcwMFx1NTkxQVx1ODlDMVx1NTM2MVx1NTM3M1x1NzBCOSxcdTVFNDJcdTdCNDkpXHUzMDAyXHU4RDg1XHU2NUY2IDE1MHNcdTMwMDIgKi9cclxuICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9SRUFMX1RBU0sgPT09ICcxJykge1xyXG4gICAgICBhd2FpdCBzdGVwKCdcdTc3MUZcdTVCOUVcdTRFRkJcdTUyQTE6XHU1M0QxXHU5MDAxXHUyMTkyXHU2QTIxXHU1NzhCXHU1NkRFXHU1OTBEKFx1N0FFRlx1NTIzMFx1N0FFRlx1OTk5Nlx1OUE4QyknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleTonbicsIGN0cmxLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XHJcbiAgICAgICAgYXdhaXQgc2xlZXAoNDAwKTtcclxuICAgICAgICBhd2FpdCB0eXBlSW50bygnLmNvbXBvc2VyIHRleHRhcmVhJywgJ1x1OEJGN1x1NTNFQVx1NTZERVx1NTkwRFx1NEUyNFx1NEUyQVx1NUI1NzpcdTY1MzZcdTUyMzAoXHU2NzJDXHU2QjIxXHU5QThDXHU2NTM2XHU0RUZCXHU1MkExLFx1NEUwRFx1ODk4MVx1NEY3Rlx1NzUyOFx1NEVGQlx1NEY1NVx1NURFNVx1NTE3NyxcdTc2RjRcdTYzQTVcdTU2REVcdTU5MEQpJyk7XHJcbiAgICAgICAgYXdhaXQgc2xlZXAoMjAwKTtcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNvbXBvc2VyIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTUzRDFcdTkwMDEnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICBjb25zdCBzZW50ID0gYXdhaXQgd2FpdEZvcigndXNlciB0dXJuJywgYHZhciB0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy50dXJuLnVzZXInKTtcclxuICAgICAgICAgIHZhciBzID0gKHQgJiYgdC50ZXh0Q29udGVudCkgPyBTdHJpbmcodC50ZXh0Q29udGVudCkgOiAnJztcclxuICAgICAgICAgIHJldHVybiB7b2s6IHMuaW5kZXhPZignXHU2NTM2XHU1MjMwJyk+PTAgfHwgcy5pbmRleE9mKCdcdTlBOENcdTY1MzZcdTRFRkJcdTUyQTEnKT49MCwgZGV0YWlsOiBzLnNsaWNlKDAsMzApIHx8ICdub25lJ307YCwgMTBfMDAwKTtcclxuICAgICAgICBpZiAoIXNlbnRbMF0pIHJldHVybiBzZW50O1xyXG4gICAgICAgIGNvbnN0IHJlcGx5ID0gYXdhaXQgd2FpdEZvcignYXNzaXN0YW50IHJlcGx5JywgYFxyXG4gICAgICAgICAgdmFyIGFwID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmFwcHJvdmFsLWNhcmQgYnV0dG9uJyk7XHJcbiAgICAgICAgICBpZiAoYXAgJiYgYXAudGV4dENvbnRlbnQudHJpbSgpLmluZGV4T2YoJ1x1NjI3OVx1NTFDNicpPj0wKSBhcC5jbGljaygpO1xyXG4gICAgICAgICAgdmFyIHRzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnR1cm4nKSkuZmlsdGVyKGZ1bmN0aW9uKHgpeyByZXR1cm4geC5jbGFzc05hbWUuaW5kZXhPZigndXNlcicpPDAgJiYgeC5jbGFzc05hbWUuaW5kZXhPZignYXBwcm92YWwnKTwwICYmIHguY2xhc3NOYW1lLmluZGV4T2YoJ3N5c3RlbScpPDAgJiYgeC50ZXh0Q29udGVudC50cmltKCkubGVuZ3RoPjAgJiYgeC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTU2REVcdTU0MDgnKTwwOyB9KTtcclxuICAgICAgICAgIHZhciBzdW0gPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudHVybi1zdW0nKTtcclxuICAgICAgICAgIHJldHVybiB7b2s6IHRzLmxlbmd0aD49MSAmJiAhIXN1bSwgZGV0YWlsOiAnYXNzaXN0YW50PScrdHMubGVuZ3RoKycgc3VtPScrKHN1bT9zdW0udGV4dENvbnRlbnQ6J25vbmUnKSsnIGZpcnN0PScrKHRzWzBdP3RzWzBdLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw0MCk6J25vbmUnKX07XHJcbiAgICAgICAgYCwgMTUwXzAwMCk7XHJcbiAgICAgICAgYXdhaXQgc2hvdCgncmVhbC10YXNrJyk7XHJcbiAgICAgICAgcmV0dXJuIHJlcGx5O1xyXG4gICAgICB9KTtcclxuICAgIH1cclxuICAgIGF3YWl0IHN0ZXAoJ1x1NEYxQVx1OEJERFx1NTIwNlx1N0VDNDpcdTVERTZcdTY4MEZcdTYzMDlcdTVERTVcdTRGNUNcdTUzM0FcdTUyMDZcdTdFQzQoXHU3RUM0XHU1OTM0XHU1M0VGXHU4OUMxKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2dyb3VwIGhlYWQnLCBgdmFyIGg9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLWdyb3VwLWhlYWQnKTtcclxuICAgICAgICB2YXIgbiA9IGggPyAoaC5xdWVyeVNlbGVjdG9yKCcud3MtZ3JvdXAtbmFtZScpfHx7fSkudGV4dENvbnRlbnQgOiAnJztcclxuICAgICAgICByZXR1cm4ge29rOiAhIWggJiYgbi5sZW5ndGggPiAwLCBkZXRhaWw6ICduYW1lPScrbn07YCwgMTVfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnXHU1REU1XHU0RjVDXHU1MzNBOlx1NURFNlx1NjgwRlx1NURFNVx1NEY1Q1x1NTMzQVx1NjgwRlx1NTNFRlx1ODlDMShcdTc3MUZcdTVCOUVcdTVERTVcdTRGNUNcdTUzM0FcdTU0MEQpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignd29ya3NwYWNlIGJhcicsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud29ya3NwYWNlLWJhcicpO1xyXG4gICAgICAgIHZhciBuID0gYiA/IChiLnF1ZXJ5U2VsZWN0b3IoJy53cy1iYXItbmFtZScpfHx7fSkudGV4dENvbnRlbnQgOiAnJztcclxuICAgICAgICByZXR1cm4ge29rOiAhIWIgJiYgISFuICYmIG4ubGVuZ3RoID4gMCAmJiBuLmluZGV4T2YoJ1x1NTJBMFx1OEY3RCcpIDwgMCAmJiBuLmluZGV4T2YoJ0xvYWRpbmcnKSA8IDAsIGRldGFpbDogJ25hbWU9JytufTtgLCAxNV8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzaG90KCdmaW5hbCcpO1xyXG4gIH1cclxuXHJcbiAgY29uc3QgZmFpbGVkID0gcmVzdWx0cy5maWx0ZXIoKHIpID0+ICFyWzFdKS5sZW5ndGg7XHJcbiAgY29uc29sZS5sb2coYFVJVkVSSUZZIFNVTU1BUlkgcGFzcz0ke3Jlc3VsdHMubGVuZ3RoIC0gZmFpbGVkfS8ke3Jlc3VsdHMubGVuZ3RofSBtb2RlPSR7bW9kZX0gc2hvdHM9JHtzaG90c31gKTtcclxuICBhcHAuZXhpdChmYWlsZWQgPT09IDAgPyAwIDogMSk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBhdHRhY2hVaVZlcmlmeSh3aW46IEJyb3dzZXJXaW5kb3cpOiB2b2lkIHtcclxuICBjb25zdCBtb2RlID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfTU9ERSA9PT0gJ3JlYWwnID8gJ3JlYWwnIDogJ2Zha2UnO1xyXG4gIHdpbi53ZWJDb250ZW50cy5vbmNlKCdkaWQtZmluaXNoLWxvYWQnLCAoKSA9PiB7XHJcbiAgICAvLyBcdTdFRDkgaG9zdCBcdTU0MkZcdTUyQThcdTc1NTlcdTY1RjZcdTk1RjQ7XHU2QjY1XHU5QUE0XHU1MTg1XHU5MEU4XHU1NDA0XHU4MUVBXHU4RjZFXHU4QkUyXHU3QjQ5XHU1Rjg1XHJcbiAgICBzZXRUaW1lb3V0KCgpID0+IHsgdm9pZCBydW5VaVZlcmlmeSh3aW4sIG1vZGUpOyB9LCAzXzAwMCk7XHJcbiAgfSk7XHJcbn1cclxuIiwgIi8qKlxuICogXHU4OUM2XHU4OUM5XHU1NkRFXHU1RjUyXHU2MjJBXHU1NkZFXHU5NEE5XHU1QjUwIFx1MjAxNFx1MjAxNCBcdTc4NkVcdTVCOUFcdTYwMjdcdTg5QzZcdTUzRTNcdTYyMkFcdTU2RkUsXHU0RjlCIHNjcmlwdHMvdmlzdWFsLXJlZ3Jlc3Npb24ubWpzIFx1NTA1QVx1NTBDRlx1N0QyMCBkaWZmXHUzMDAyXG4gKlxuICogXHU0RTBFIHVpLXZlcmlmeSBcdTU0MENcdTY1Q0YoXHU5NkY2XHU3QjJDXHU0RTA5XHU2NUI5XHU0RjlEXHU4RDU2KSxcdTRGNDZcdTc2RUVcdTY4MDdcdTY2MkZcIlx1NTQwQ1x1NEUwMFx1OEY5M1x1NTE2NSBcdTIxOTIgXHU5MDEwXHU1QjU3XHU4MjgyXHU1M0VGXHU2QkQ0XHU3Njg0XHU1NkZFXCI6XG4gKiAgLSBcdTdBOTdcdTUzRTNcdTVGNTJcdTRFMDAgMTI4MFx1MDBENzgwMDtcdTRFM0JcdTk4OTgvXHU4QkVEXHU4QTAwXHU1NkZBXHU1QjlBKGxpZ2h0ICsgXHU1RjUzXHU1MjREIGxvY2FsZSBcdTlFRDhcdThCQTQsXHU1MTk5IGxvY2FsU3RvcmFnZSBcdTU0MEUgcmVsb2FkKVxuICogIC0gZmFrZSBob3N0KEhNSF9ERVNLVE9QX1ZJU1JFRz0xIFx1NjVGNiBtYWluIFx1NURGMlx1NUYzQVx1NTIzNiBmYWtlKTpcdTdBN0FcdTRGMUFcdThCREQvXHU1NkZBXHU1QjlBXHU1REU1XHU0RjVDXHU1MzNBXHU0RTBFIHByb3ZpZGVyXG4gKiAgLSBcdTRFMDlcdTg5QzZcdTUzRTM6bWFpbihcdTRGMUFcdThCRERcdTRFM0JcdTc1NENcdTk3NjJcdTdBN0FcdTYwMDEpLyBzZXR0aW5ncyhcdThCQkVcdTdGNkVcdTVGMzlcdTVDNDIpLyBkb2NrKEZpbGVzIFx1NkQ0Rlx1ODlDOClcbiAqICAtIFx1NTJBOFx1NjAwMVx1NTMzQSBtYXNrOlx1NTJBOFx1NjAwMVx1N0FFRlx1NTNFMy9cdTY1RjZcdTk1RjRcdTYyMzMvXHU4QkExXHU2NTcwXHU3QjQ5XHU1MTQzXHU3RDIwXHU2MzA5IGJvdW5kaW5nIGJveCBcdThCQjBcdTUxNjUgbWV0YS5qc29uLFxuICogICAgXHU1MENGXHU3RDIwIGRpZmYgXHU2NUY2XHU4REYzXHU4RkM3KFx1NTc1MFx1NjgwN1x1NURGMlx1NjMwOSBjYXB0dXJlUGFnZSBcdTVCOUVcdTk2NDVcdTVDM0FcdTVCRjggXHUwMEQ3IGRldmljZVBpeGVsUmF0aW8gXHU2MzYyXHU3Qjk3KVxuICogIC0gSE1IX0RFU0tUT1BfVklTUkVHX01VVEFURT08dmlld3BvcnQ+Olx1NTcyOFx1OEJFNVx1ODlDNlx1NTNFM1x1NkNFOFx1NTE2NVx1NTZGQVx1NUI5QVx1ODI3Mlx1NTc1NyxcdTc1MjhcdTRFOEVcdTdCQTFcdTdFQkZcdTgxRUFcdTY4QzBcbiAqICAgIChiYXNlbGluZSBcdTgxRUFcdTZCRDQgMCBcdTVERUVcdTVGMDIgKyBcdTY1NDVcdTYxMEZcdTY1MzlcdTUyQThcdTVGQzUgRkFJTCxcdThCQzFcdTY2MEVcdTk2MDhcdTUwM0NcdTRFMEUgZGlmZiBcdTU2RkVcdTc3MUZcdTVCOUVcdTVERTVcdTRGNUMpXG4gKiBlbnY6SE1IX0RFU0tUT1BfVklTUkVHPTEoXHU1RjAwXHU1MTczKS8gSE1IX0RFU0tUT1BfVklTUkVHX09VVD08ZGlyPihcdThGOTNcdTUxRkFcdTc2RUVcdTVGNTUpXG4gKi9cbmltcG9ydCB7IGFwcCwgdHlwZSBCcm93c2VyV2luZG93IH0gZnJvbSAnZWxlY3Ryb24nO1xuaW1wb3J0IHsgbWtkaXIsIHdyaXRlRmlsZSB9IGZyb20gJ25vZGU6ZnMvcHJvbWlzZXMnO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gJ25vZGU6cGF0aCc7XG5cbmNvbnN0IHNsZWVwID0gKG1zOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+ID0+IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIG1zKSk7XG5cbi8qKiBcdTUyQThcdTYwMDFcdTUzM0FcdTU3REYoXHU2QkNGXHU2QjIxXHU4RkQwXHU4ODRDXHU1RkM1XHU1M0Q4XHU3Njg0XHU1MTg1XHU1QkI5KVx1MjE5MiBtYXNrIFx1OTAwOVx1NjJFOVx1NTY2ODtcdTk3NTlcdTYwMDFcdTdFRDNcdTY3ODRcdTRFMEQgbWFzayxkaWZmIFx1NjI0RFx1NjcwOVx1NjEwRlx1NEU0OSAqL1xuY29uc3QgTUFTS19TRUxFQ1RPUlM6IEFycmF5PHsgc2VsOiBzdHJpbmc7IHJlYXNvbjogc3RyaW5nIH0+ID0gW1xuICB7IHNlbDogJy5ob3N0LWxhYmVsJywgcmVhc29uOiAnaG9zdCBcdTdBRUZcdTUzRTMvXHU3MjQ4XHU2NzJDKGZha2UgaG9zdCBcdTZCQ0ZcdTZCMjFcdTk2OEZcdTY3M0FcdTdBRUZcdTUzRTMpJyB9LFxuICB7IHNlbDogJy5zZXNzaW9uLXRpbWUnLCByZWFzb246ICdcdTRGMUFcdThCRERcdTY1RjZcdTk1RjRcdTYyMzMnIH0sXG4gIHsgc2VsOiAnLnR1cm4tc3VtJywgcmVhc29uOiAnXHU1NkRFXHU1NDA4L3Rva2VuIFx1OEJBMVx1NjU3MCcgfSxcbl07XG5cbi8qKiBcdTU2RkFcdTVCOUFcdTg5QzZcdTUzRTM6XHU4OTg2XHU3NkQ2XHU0RTA5XHU2ODBGXHU1RTAzXHU1QzQwXHU0RTBFXHU1RTk1XHU5MEU4IGRvY2sgXHU3Njg0XHU1MjA2XHU2NTJGLFx1NTQwQ1x1NjVGNlx1OEZEQ1x1NzlCQiA4MjAvMTEwMCBcdTY1QURcdTcwQjkgKi9cbmNvbnN0IFZJRVdQT1JUX1cgPSAxMjgwO1xuY29uc3QgVklFV1BPUlRfSCA9IDgwMDtcblxuYXN5bmMgZnVuY3Rpb24gcnVuVmlzdWFsUmVncmVzc2lvbih3aW46IEJyb3dzZXJXaW5kb3cpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3Qgb3V0ID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVklTUkVHX09VVCA/PyBqb2luKGFwcC5nZXRQYXRoKCd0ZW1wJyksICdobWgtdmlzcmVnJyk7XG4gIGNvbnN0IG11dGF0ZSA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1ZJU1JFR19NVVRBVEUgPz8gJyc7XG4gIGF3YWl0IG1rZGlyKG91dCwgeyByZWN1cnNpdmU6IHRydWUgfSkuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcbiAgY29uc3QganMgPSA8VD4oY29kZTogc3RyaW5nKTogUHJvbWlzZTxUPiA9PiB3aW4ud2ViQ29udGVudHMuZXhlY3V0ZUphdmFTY3JpcHQoY29kZSwgdHJ1ZSkgYXMgUHJvbWlzZTxUPjtcbiAgY29uc3Qgd2FpdEZvciA9IGFzeW5jIChsYWJlbDogc3RyaW5nLCBwcmVkaWNhdGVDb2RlOiBzdHJpbmcsIHRpbWVvdXRNczogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiA9PiB7XG4gICAgY29uc3Qgc3RhcnRlZCA9IERhdGUubm93KCk7XG4gICAgZm9yICg7Oykge1xuICAgICAgY29uc3QgciA9IChhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHRyeSB7IHJldHVybiBKU09OLnN0cmluZ2lmeSgoZnVuY3Rpb24oKXsgJHtwcmVkaWNhdGVDb2RlfSB9KSgpKTsgfSBjYXRjaChlKXsgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHtvazpmYWxzZSwgZGV0YWlsOlN0cmluZyhlKS5zbGljZSgwLDEyMCl9KTsgfSB9KSgpYCkpIGFzIHN0cmluZztcbiAgICAgIGxldCBwYXJzZWQ6IHsgb2s/OiBib29sZWFuIH07XG4gICAgICB0cnkgeyBwYXJzZWQgPSBKU09OLnBhcnNlKHIpIGFzIHsgb2s/OiBib29sZWFuIH07IH0gY2F0Y2ggeyBwYXJzZWQgPSB7fTsgfVxuICAgICAgaWYgKHBhcnNlZC5vayA9PT0gdHJ1ZSkgcmV0dXJuO1xuICAgICAgaWYgKERhdGUubm93KCkgLSBzdGFydGVkID4gdGltZW91dE1zKSB7XG4gICAgICAgIGNvbnNvbGUubG9nKGBWSVNSRUctQ0FQVFVSRSBGQUlMIHwgd2FpdCAke2xhYmVsfSB0aW1lb3V0YCk7XG4gICAgICAgIGFwcC5leGl0KDEpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBhd2FpdCBzbGVlcCgyNTApO1xuICAgIH1cbiAgfTtcblxuICAvLyAwKSBcdTdBOTdcdTUzRTNcdTVGNTJcdTRFMDA6XHU1QzNBXHU1QkY4XHU1NkZBXHU1QjlBKFx1NEY0RFx1N0Y2RVx1NEZERFx1NjMwMVx1NzUyOFx1NjIzN1x1Njg0Q1x1OTc2Mlx1NEUwQVx1NzY4NCk7XHU0RTNCXHU5ODk4XHU2RDQ1XHU4MjcyICsgXHU0RTJEXHU2NTg3LFx1NTE5OVx1NTA0Rlx1NTk3RFx1NTQwRSByZWxvYWQgXHU3NTFGXHU2NTQ4XG4gIHRyeSB7IHdpbi5zZXRCb3VuZHMoeyB3aWR0aDogVklFV1BPUlRfVywgaGVpZ2h0OiBWSUVXUE9SVF9IIH0pOyB9IGNhdGNoIHsgLyogXHU2NzAwXHU1QzBGXHU1QzNBXHU1QkY4XHU1MTVDXHU1RTk1ICovIH1cbiAgYXdhaXQgc2xlZXAoNDAwKTtcbiAgYXdhaXQganMoYChmdW5jdGlvbigpeyB0cnkgeyBsb2NhbFN0b3JhZ2Uuc2V0SXRlbSgnaG1oLnRoZW1lJywgJ2xpZ2h0Jyk7IGxvY2FsU3RvcmFnZS5zZXRJdGVtKCdobWgubG9jYWxlJywgJ3poJyk7IH0gY2F0Y2ggKGUpIHt9IHJldHVybiAnb2snOyB9KSgpYCk7XG4gIHdpbi53ZWJDb250ZW50cy5yZWxvYWQoKTtcbiAgYXdhaXQgd2FpdEZvcignbW91bnRlZCcsIGB2YXIgdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY29tcG9zZXIgdGV4dGFyZWEnKTsgcmV0dXJuIHtvazogISF0LCBkZXRhaWw6IHQgPyAndXAnIDogJ2Rvd24nfTtgLCAyMF8wMDApO1xuICBhd2FpdCB3YWl0Rm9yKCdob3N0IGRvdCBvbicsIGB2YXIgZD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuaG9zdC1kb3QnKTsgcmV0dXJuIHtvazogISFkICYmIGQuY2xhc3NMaXN0LmNvbnRhaW5zKCdvbicpLCBkZXRhaWw6IGQgPyBkLmNsYXNzTmFtZSA6ICdub25lJ307YCwgMzBfMDAwKTtcbiAgYXdhaXQgc2xlZXAoMV8yMDApOyAvLyBcdTRGMUFcdThCRERcdTUyMTdcdTg4NjgvXHU5ODc2XHU2ODBGXHU2NTcwXHU2MzZFXHU4NDNEXHU1NzMwXG5cbiAgLy8gMSkgXHU1MTczXHU2Mzg5IGZha2UgXHU2RjE0XHU3OTNBXHU1RjE1XHU1QkZDXHU1QzQyKFx1OTA2RVx1N0Y2OVx1NUYzOVx1NUM0Mlx1NEUwRFx1NUM1RVx1NEU4RVx1ODhBQlx1NkQ0Qlx1ODlDNlx1NTNFMztcdTRFMERcdTRGOURcdThENTZcdTY1ODdcdTY4NDgsXHU2MzA5XHU3RUQzXHU2Nzg0XHU1M0Q2IGdob3N0IFx1NjMwOVx1OTRBRSlcbiAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgZz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcucnVudGltZS1ndWlkZScpOyBpZighZykgcmV0dXJuICduby1ndWlkZSc7XG4gICAgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnJ1bnRpbWUtZ3VpZGUtYWN0aW9ucyAuYnRuLmdob3N0Jyk7IGlmKGIpIGIuY2xpY2soKTsgcmV0dXJuICdkaXNtaXNzZWQnOyB9KSgpYCk7XG4gIGF3YWl0IHdhaXRGb3IoJ2d1aWRlIGNsb3NlZCcsIGByZXR1cm4ge29rOiAhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnJ1bnRpbWUtZ3VpZGUnKSwgZGV0YWlsOiAnY2xvc2VkJ307YCwgNV8wMDApO1xuXG4gIC8vIDIpIFx1ODlDNlx1NTNFM1x1NUU4Rlx1NTIxNzptYWluKFx1N0E3QVx1NjAwMVx1NEUzQlx1NzU0Q1x1OTc2MilcdTIxOTIgc2V0dGluZ3MoXHU4QkJFXHU3RjZFXHU1RjM5XHU1QzQyKVx1MjE5MiBkb2NrKEZpbGVzIFx1NkQ0Rlx1ODlDOClcbiAgY29uc3Qgdmlld3BvcnRzOiBBcnJheTx7IG5hbWU6IHN0cmluZzsgc2V0dXA6ICgpID0+IFByb21pc2U8dm9pZD4gfT4gPSBbXG4gICAgeyBuYW1lOiAnbWFpbicsIHNldHVwOiBhc3luYyAoKSA9PiB7IC8qIFx1NTQyRlx1NTJBOFx1OUVEOFx1OEJBNFx1NjAwMTpcdTdBN0FcdTRGMUFcdThCREQgKyBPdmVydmlldyBkb2NrICovIH0gfSxcbiAgICB7XG4gICAgICBuYW1lOiAnc2V0dGluZ3MnLFxuICAgICAgc2V0dXA6IGFzeW5jICgpID0+IHtcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHsga2V5OiAncCcsIGN0cmxLZXk6IHRydWUsIHNoaWZ0S2V5OiB0cnVlLCBidWJibGVzOiB0cnVlIH0pKTsgfSkoKWApO1xuICAgICAgICBhd2FpdCB3YWl0Rm9yKCdzZXR0aW5ncyBvcGVuJywgYHJldHVybiB7b2s6ICEhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNtZGsuc2V0dGluZ3MnKSwgZGV0YWlsOiAnb3Blbid9O2AsIDVfMDAwKTtcbiAgICAgIH0sXG4gICAgfSxcbiAgICB7XG4gICAgICBuYW1lOiAnZG9jaycsXG4gICAgICBzZXR1cDogYXN5bmMgKCkgPT4ge1xuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywgeyBrZXk6ICdFc2NhcGUnLCBidWJibGVzOiB0cnVlIH0pKTsgfSkoKWApO1xuICAgICAgICBhd2FpdCB3YWl0Rm9yKCdzZXR0aW5ncyBjbG9zZWQnLCBgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrLnNldHRpbmdzJyksIGRldGFpbDogJ2Nsb3NlZCd9O2AsIDVfMDAwKTtcbiAgICAgICAgLy8gRmlsZXMgdGFiOlx1NjMwOSBkb2NrLXRhYiBcdTk4N0FcdTVFOEZcdTdCMkMgMiBcdTRFMkEoT3ZlcnZpZXcvRmlsZXMvXHUyMDI2KSxcdTkwN0ZcdTUxNERcdTRGOURcdThENTZcdTY1ODdcdTY4NDhcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKVsxXTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XG4gICAgICAgIGF3YWl0IHdhaXRGb3IoJ2ZpbGVzIHJvd3MnLCBgdmFyIHI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmZzLXJvdycpOyByZXR1cm4ge29rOiByLmxlbmd0aCA+PSAxLCBkZXRhaWw6ICdyb3dzPScgKyByLmxlbmd0aH07YCwgNV8wMDApO1xuICAgICAgfSxcbiAgICB9LFxuICBdO1xuXG4gIGNvbnN0IG1ldGE6IHsgZ2VuZXJhdGVkQXQ6IHN0cmluZzsgd2luZG93OiB7IHdpZHRoOiBudW1iZXI7IGhlaWdodDogbnVtYmVyIH07IG11dGF0ZTogc3RyaW5nOyB2aWV3cG9ydHM6IEFycmF5PHsgbmFtZTogc3RyaW5nOyBmaWxlOiBzdHJpbmc7IHdpZHRoOiBudW1iZXI7IGhlaWdodDogbnVtYmVyOyBkcHI6IG51bWJlcjsgbWFza3M6IEFycmF5PHsgeDogbnVtYmVyOyB5OiBudW1iZXI7IHc6IG51bWJlcjsgaDogbnVtYmVyOyBmb3I6IHN0cmluZyB9PiB9PiB9ID0ge1xuICAgIGdlbmVyYXRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgd2luZG93OiB7IHdpZHRoOiBWSUVXUE9SVF9XLCBoZWlnaHQ6IFZJRVdQT1JUX0ggfSxcbiAgICBtdXRhdGUsXG4gICAgdmlld3BvcnRzOiBbXSxcbiAgfTtcbiAgZm9yIChjb25zdCB2IG9mIHZpZXdwb3J0cykge1xuICAgIGF3YWl0IHYuc2V0dXAoKTtcbiAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBhPWRvY3VtZW50LmFjdGl2ZUVsZW1lbnQ7IGlmKGEgJiYgYS5ibHVyKSBhLmJsdXIoKTsgfSkoKWApOyAvLyBcdTUzQkJcdTcxMjZcdTcwQjlcdTczQUZcbiAgICBhd2FpdCBzbGVlcCg2MDApOyAvLyBcdThGQzdcdTZFMjFcdTRFMEVcdTZFMzJcdTY3RDNcdTdBMzNcdTVCOUFcbiAgICBpZiAobXV0YXRlID09PSB2Lm5hbWUpIHtcbiAgICAgIC8vIFx1N0JBMVx1N0VCRlx1ODFFQVx1NjhDMDpcdTZDRThcdTUxNjUgMTIwXHUwMEQ3OTAgXHU1NkZBXHU1QjlBXHU3RUEyXHU1NzU3KFx1N0VBNiAxJSBcdTk3NjJcdTc5RUYsPiAwLjUlIFx1OTYwOFx1NTAzQyxcdTVFOTRcdTUyMjQgRkFJTClcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGQ9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7IGQuc2V0QXR0cmlidXRlKCdkYXRhLXZpc3JlZy1tdXRhdGUnLCcxJyk7XG4gICAgICAgIGQuc3R5bGUuY3NzVGV4dD0ncG9zaXRpb246Zml4ZWQ7bGVmdDo1NjBweDt0b3A6MzAwcHg7d2lkdGg6MTIwcHg7aGVpZ2h0OjkwcHg7YmFja2dyb3VuZDpyZ2IoMjU1LDAsMCk7ei1pbmRleDo5OTk5Oyc7XG4gICAgICAgIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQoZCk7IH0pKClgKTtcbiAgICAgIGF3YWl0IHNsZWVwKDE1MCk7XG4gICAgfVxuICAgIGNvbnN0IGltZyA9IGF3YWl0IHdpbi53ZWJDb250ZW50cy5jYXB0dXJlUGFnZSgpO1xuICAgIGNvbnN0IHNpemUgPSBpbWcuZ2V0U2l6ZSgpO1xuICAgIC8vIFx1N0JBMVx1N0VCRlx1ODFFQVx1NjhDMFx1N0VBMlx1NTc1N1x1NTNFQVx1NUM1RVx1NEU4RVx1NzZFRVx1NjgwN1x1ODlDNlx1NTNFMzpcdTYyMkFcdTU2RkVcdTU0MEVcdTdBQ0JcdTUzNzNcdTc5RkJcdTk2NjQsXHU0RTBEXHU2QzYxXHU2N0QzXHU1NDBFXHU3RUVEXHU4OUM2XHU1M0UzXG4gICAgaWYgKG11dGF0ZSA9PT0gdi5uYW1lKSB7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBkPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLXZpc3JlZy1tdXRhdGVdJyk7IGlmKGQpIGQucmVtb3ZlKCk7IH0pKClgKTtcbiAgICB9XG4gICAgY29uc3QgaW5uZXJXID0gKGF3YWl0IGpzPG51bWJlcj4oJ3dpbmRvdy5pbm5lcldpZHRoJykpIHx8IHNpemUud2lkdGg7XG4gICAgY29uc3QgZHByID0gc2l6ZS53aWR0aCAvIGlubmVyVztcbiAgICBjb25zdCBtYXNrczogQXJyYXk8eyB4OiBudW1iZXI7IHk6IG51bWJlcjsgdzogbnVtYmVyOyBoOiBudW1iZXI7IGZvcjogc3RyaW5nIH0+ID0gW107XG4gICAgZm9yIChjb25zdCBtIG9mIE1BU0tfU0VMRUNUT1JTKSB7XG4gICAgICBjb25zdCByZWN0cyA9IChhd2FpdCBqczxzdHJpbmc+KGAoZnVuY3Rpb24oKXsgcmV0dXJuIEpTT04uc3RyaW5naWZ5KFtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnJHttLnNlbH0nKSkubWFwKGZ1bmN0aW9uKGVsKXtcbiAgICAgICAgdmFyIHI9ZWwuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7IHJldHVybiB7IHg6ci54LCB5OnIueSwgdzpyLndpZHRoLCBoOnIuaGVpZ2h0IH07XG4gICAgICB9KS5maWx0ZXIoZnVuY3Rpb24ocil7IHJldHVybiByLncgPiAwICYmIHIuaCA+IDAgJiYgci55ID49IDAgJiYgci55IDwgd2luZG93LmlubmVySGVpZ2h0OyB9KSkgfSkoKWApKTtcbiAgICAgIGxldCBsaXN0OiBBcnJheTx7IHg6IG51bWJlcjsgeTogbnVtYmVyOyB3OiBudW1iZXI7IGg6IG51bWJlciB9PiA9IFtdO1xuICAgICAgdHJ5IHsgbGlzdCA9IEpTT04ucGFyc2UocmVjdHMpIGFzIHR5cGVvZiBsaXN0OyB9IGNhdGNoIHsgLyogXHU3QTdBICovIH1cbiAgICAgIGZvciAoY29uc3QgciBvZiBsaXN0KSB7XG4gICAgICAgIG1hc2tzLnB1c2goeyB4OiBNYXRoLnJvdW5kKHIueCAqIGRwciksIHk6IE1hdGgucm91bmQoci55ICogZHByKSwgdzogTWF0aC5yb3VuZChyLncgKiBkcHIpLCBoOiBNYXRoLnJvdW5kKHIuaCAqIGRwciksIGZvcjogbS5yZWFzb24gfSk7XG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IGZpbGUgPSBgJHt2Lm5hbWV9LnBuZ2A7XG4gICAgYXdhaXQgd3JpdGVGaWxlKGpvaW4ob3V0LCBmaWxlKSwgaW1nLnRvUE5HKCkpO1xuICAgIG1ldGEudmlld3BvcnRzLnB1c2goeyBuYW1lOiB2Lm5hbWUsIGZpbGUsIHdpZHRoOiBzaXplLndpZHRoLCBoZWlnaHQ6IHNpemUuaGVpZ2h0LCBkcHI6IE1hdGgucm91bmQoZHByICogMTAwKSAvIDEwMCwgbWFza3MgfSk7XG4gICAgY29uc29sZS5sb2coYFZJU1JFRy1DQVBUVVJFICR7di5uYW1lfSAke3NpemUud2lkdGh9eCR7c2l6ZS5oZWlnaHR9IG1hc2tzPSR7bWFza3MubGVuZ3RofSR7bXV0YXRlID09PSB2Lm5hbWUgPyAnIE1VVEFURUQnIDogJyd9YCk7XG4gIH1cbiAgYXdhaXQgd3JpdGVGaWxlKGpvaW4ob3V0LCAnbWV0YS5qc29uJyksIEpTT04uc3RyaW5naWZ5KG1ldGEsIG51bGwsIDIpKTtcbiAgY29uc29sZS5sb2coJ1ZJU1JFRy1DQVBUVVJFIERPTkUnKTtcbiAgYXBwLmV4aXQoMCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhdHRhY2hWaXN1YWxSZWdyZXNzaW9uKHdpbjogQnJvd3NlcldpbmRvdyk6IHZvaWQge1xuICB3aW4ud2ViQ29udGVudHMub25jZSgnZGlkLWZpbmlzaC1sb2FkJywgKCkgPT4ge1xuICAgIHNldFRpbWVvdXQoKCkgPT4geyB2b2lkIHJ1blZpc3VhbFJlZ3Jlc3Npb24od2luKTsgfSwgMV81MDApO1xuICB9KTtcbn1cbiIsICIvKipcclxuICogdjUuMSBcdTVCODlcdTg4QzVcdTU0MTFcdTVCRkMgXHUwMEI3IEBobWhhcm5lc3MvY2xpIFx1NUI4OVx1ODhDNVx1N0YxNlx1NjM5MihcdTRFM0JcdThGREJcdTdBMEIpXHUzMDAyXHJcbiAqXHJcbiAqIFx1NEUyNFx1Njc2MVx1OERFRlx1NUY4NChcdTYzRDBcdTc5M0FcdThCQ0QgdjUuMSBcdTU0MDhcdTU0MEMpOlxyXG4gKiAgLSBucG0gXHU1M0VGXHU3NTI4KFx1OUVEOFx1OEJBNCk6YG5wbSBpbnN0YWxsIC0tcHJlZml4ICVVU0VSUFJPRklMRSVcXC5obWhhcm5lc3MtZ2xvYmFsXHJcbiAqICAgIEBobWhhcm5lc3MvY2xpYCBcdTIwMTRcdTIwMTQgXHU1M0VBXHU1MTk5XHU3NTI4XHU2MjM3XHU3NkVFXHU1RjU1LFx1NEUwRFx1NzhCMFx1N0NGQlx1N0VERi9ucG0gXHU1MTY4XHU1QzQwO25wbSBcdTgxRUFcdTVFMjZcdTRGOURcdThENTZcdTg5RTNcdTY3OTAsXHJcbiAqICAgIFx1OEZEQlx1NUVBNlx1OEY2Q1x1NTNEMVx1NTE3Nlx1OEY5M1x1NTFGQVx1ODg0QyhcdTVCODlcdTg4QzVcdTZCNjVcdTlBQTRcdTY1ODdcdTY4NDgpXHUzMDAyXHJcbiAqICAtIFx1NjVFMCBucG0oXHU2MjE2XHU2NjNFXHU1RjBGXHU1RjNBXHU1MjM2KTpcdTgxRUFcdTc4MTQgdGd6IFx1NUI4OVx1ODhDNVx1NTY2OCBcdTIwMTRcdTIwMTQgXHU0RjlEXHU4RDU2XHU5NUVEXHU1MzA1XHU2NzY1XHU4MUVBXHJcbiAqICAgIEBobWgtZGVza3RvcC9jbGktaW5zdGFsbGVyKFx1N0VBRlx1OTAzQlx1OEY5MSxcdTVERjJcdTUzNTVcdTZENEIpLHRhcmJhbGwgXHU5MDEwXHU1MzA1XHU2RDQxXHU1RjBGXHU0RTBCXHU4RjdEXHJcbiAqICAgIChcdTc3MUZcdTVCNTdcdTgyODJcdThGREJcdTVFQTYgKyByZWdpc3RyeS5ucG1qcy5vcmdcdTIxOTJyZWdpc3RyeS5ucG1taXJyb3IuY29tIFx1OTU1Q1x1NTBDRlx1NTZERVx1OTAwMCxcclxuICogICAgXHU1OTBEXHU3NTI4IHY0IFx1NjZGNFx1NjVCMFx1NTY2OFx1NTZERVx1OTAwMFx1NjAxRFx1NjBGMyArIGludGVncml0eSBcdTY4MjFcdTlBOEMpLFx1N0NGQlx1N0VERiB0YXIuZXhlIFx1ODlFM1x1NTM4Qlx1NTIzMFxyXG4gKiAgICBub2RlX21vZHVsZXMgXHU2MjQxXHU1RTczXHU1RTAzXHU1QzQwXHUzMDAyXHJcbiAqIFx1OEZEQlx1NUVBNlx1NEUwMFx1NUY4Qlx1N0VDRiBpbnN0YWxsOnByb2dyZXNzIFx1NEU4Qlx1NEVGNlx1NjNBOCByZW5kZXJlcjtcdTYyMTBcdTUyOUZcdTU2REVcdThDMDMgb25JbnN0YWxsZWQoZW50cnkpXHJcbiAqIFx1NzUzMSBtYWluIFx1NjMwMVx1NEU0NVx1NTMxNiBydW50aW1lLmpzb24gXHU1RTc2XHU3MEVEXHU5MUNEXHU1NDJGIGhvc3RcdTMwMDJcclxuICovXHJcbmltcG9ydCB7IHNwYXduIH0gZnJvbSAnbm9kZTpjaGlsZF9wcm9jZXNzJztcclxuaW1wb3J0IHsgZXhpc3RzU3luYywgbWtkaXJTeW5jLCBybVN5bmMsIHJlbmFtZVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tICdub2RlOmZzJztcclxuaW1wb3J0IHsgaG9tZWRpciB9IGZyb20gJ25vZGU6b3MnO1xyXG5pbXBvcnQgeyBqb2luIH0gZnJvbSAnbm9kZTpwYXRoJztcclxuaW1wb3J0IHsgYnl0ZXNMYWJlbCwgaW50ZWdyaXR5T2ssIG1vZHVsZURpciwgcmVzb2x2ZUNsb3N1cmUsIHRhcmJhbGxNaXJyb3JzLCB0eXBlIFBhY2t1bWVudCwgdHlwZSBSZXNvbHZlZFBrZyB9IGZyb20gJ0BobWgtZGVza3RvcC9jbGktaW5zdGFsbGVyJztcclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgSW5zdGFsbFByb2dyZXNzIHtcclxuICBwaGFzZTogJ2NoZWNrJyB8ICdtZXRhJyB8ICdkb3dubG9hZCcgfCAnZXh0cmFjdCcgfCAnbnBtJyB8ICdkb25lJyB8ICdlcnJvcic7XHJcbiAgcGN0PzogbnVtYmVyO1xyXG4gIHRleHQ6IHN0cmluZztcclxuICBtaXJyb3I/OiBzdHJpbmc7XHJcbiAgZW50cnk/OiBzdHJpbmc7XHJcbiAgZXJyb3I/OiBzdHJpbmc7XHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgSW5zdGFsbE9wdGlvbnMge1xyXG4gIC8qKiBcdTVGM0FcdTUyMzZcdThENzBcdTgxRUFcdTc4MTQgdGd6IFx1OERFRlx1NUY4NChcdTZENEJcdThCRDUvXHU2NUUwIG5wbSBcdTczQUZcdTU4ODMpXHUzMDAyICovXHJcbiAgZm9yY2VUZ3o/OiBib29sZWFuIHwgdW5kZWZpbmVkO1xyXG4gIC8qKiBcdTk1NUNcdTUwQ0ZcdTRGMThcdTUxNDhcdTdFQTcoXHU2MzYyXHU2RTkwXHU2MzA5XHU5NEFFXHU3RkZCXHU4RjZDKVx1MzAwMiAqL1xyXG4gIG1pcnJvckZpcnN0PzogJ25wbWpzJyB8ICducG1taXJyb3InIHwgdW5kZWZpbmVkO1xyXG59XHJcblxyXG5leHBvcnQgY29uc3QgUkVHSVNUUklFUzogUmVjb3JkPCducG1qcycgfCAnbnBtbWlycm9yJywgc3RyaW5nPiA9IHtcclxuICBucG1qczogJ2h0dHBzOi8vcmVnaXN0cnkubnBtanMub3JnJyxcclxuICBucG1taXJyb3I6ICdodHRwczovL3JlZ2lzdHJ5Lm5wbW1pcnJvci5jb20nLFxyXG59O1xyXG5cclxuLyoqIFx1NUI4OVx1ODhDNVx1NjgzOVx1NzZFRVx1NUY1NShcdTc1MjhcdTYyMzdcdTc2RUVcdTVGNTUsXHU3RUREXHU0RTBEXHU1MTk5XHU3Q0ZCXHU3RURGL1x1NTE2OFx1NUM0MCBucG0pXHUzMDAyICovXHJcbmV4cG9ydCBmdW5jdGlvbiBpbnN0YWxsVGFyZ2V0KCk6IHN0cmluZyB7XHJcbiAgcmV0dXJuIGpvaW4oaG9tZWRpcigpLCAnLmhtaGFybmVzcy1nbG9iYWwnKTtcclxufVxyXG5cclxuLyoqIFx1NUI4OVx1ODhDNVx1NUI4Q1x1NjIxMFx1NTQwRVx1NzY4NCBkZXNrdG9wLWhvc3QgXHU1MTY1XHU1M0UzKG5wbSBcdTVENENcdTU5NTdcdTRFMEVcdTYzRDBcdTUzNDdcdTRFMjRcdTc5Q0RcdTVFMDNcdTVDNDBcdTkwRkRcdThCQTQpXHUzMDAyICovXHJcbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlSW5zdGFsbGVkRW50cnkodGFyZ2V0OiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gIGNvbnN0IG5lc3RlZCA9IGpvaW4odGFyZ2V0LCAnbm9kZV9tb2R1bGVzJywgJ0BobWhhcm5lc3MnLCAnY2xpJywgJ25vZGVfbW9kdWxlcycsICdAaG1oYXJuZXNzJywgJ3dlYicsICdkaXN0JywgJ2Rlc2t0b3AtaG9zdC5qcycpO1xyXG4gIGNvbnN0IGhvaXN0ZWQgPSBqb2luKHRhcmdldCwgJ25vZGVfbW9kdWxlcycsICdAaG1oYXJuZXNzJywgJ3dlYicsICdkaXN0JywgJ2Rlc2t0b3AtaG9zdC5qcycpO1xyXG4gIGlmIChleGlzdHNTeW5jKG5lc3RlZCkpIHJldHVybiBuZXN0ZWQ7XHJcbiAgaWYgKGV4aXN0c1N5bmMoaG9pc3RlZCkpIHJldHVybiBob2lzdGVkO1xyXG4gIHJldHVybiAnJztcclxufVxyXG5cclxuZXhwb3J0IGludGVyZmFjZSBJbnN0YWxsZXJIb3N0IHtcclxuICBzZW5kUHJvZ3Jlc3MocDogSW5zdGFsbFByb2dyZXNzKTogdm9pZDtcclxuICBsb2cobXNnOiBzdHJpbmcpOiB2b2lkO1xyXG4gIC8qKiBcdTVCODlcdTg4QzVcdTYyMTBcdTUyOUYoXHU1MTY1XHU1M0UzXHU1REYyXHU5QThDXHU4QkMxXHU1QjU4XHU1NzI4KVx1MjAxNFx1MjAxNCBtYWluIFx1NTcyOFx1NkI2NFx1NjMwMVx1NEU0NVx1NTMxNlx1NUU3Nlx1OTFDRFx1NTQyRiBob3N0XHUzMDAyICovXHJcbiAgb25JbnN0YWxsZWQoZW50cnk6IHN0cmluZywgdmlhOiAnbnBtJyB8ICd0Z3onKTogdm9pZDtcclxufVxyXG5cclxubGV0IHJ1bm5pbmcgPSBmYWxzZTtcclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpbnN0YWxsUnVubmluZygpOiBib29sZWFuIHtcclxuICByZXR1cm4gcnVubmluZztcclxufVxyXG5cclxuLyoqIFx1NTQyRlx1NTJBOFx1NUI4OVx1ODhDNShcdTU0MEVcdTUzRjBcdTYyNjdcdTg4NEM7XHU4RkRCXHU1RUE2L1x1N0VEM1x1Njc5Q1x1NTE2OFx1OTBFOFx1N0VDRlx1NEU4Qlx1NEVGNlx1NTZERVx1NkQ0MSxQcm9taXNlIFx1NTNFQVx1ODg2OFx1OEZCRVwiXHU1REYyXHU1M0Q3XHU3NDA2XCIpXHUzMDAyICovXHJcbmV4cG9ydCBmdW5jdGlvbiBzdGFydENsaUluc3RhbGwoaG9zdDogSW5zdGFsbGVySG9zdCwgb3B0czogSW5zdGFsbE9wdGlvbnMgPSB7fSk6IHsgb2s6IGJvb2xlYW47IGVycm9yPzogc3RyaW5nIH0ge1xyXG4gIGlmIChydW5uaW5nKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAnXHU1Qjg5XHU4OEM1XHU1REYyXHU1NzI4XHU4RkRCXHU4ODRDXHU0RTJEJyB9O1xyXG4gIHJ1bm5pbmcgPSB0cnVlO1xyXG4gIGNvbnN0IGZpbmlzaCA9IChwOiBJbnN0YWxsUHJvZ3Jlc3MpOiB2b2lkID0+IHtcclxuICAgIGhvc3Quc2VuZFByb2dyZXNzKHApO1xyXG4gICAgcnVubmluZyA9IGZhbHNlO1xyXG4gIH07XHJcbiAgY29uc3QgZmFpbCA9ICh0ZXh0OiBzdHJpbmcsIGVycjogdW5rbm93bik6IHZvaWQgPT4ge1xyXG4gICAgaG9zdC5sb2coYGluc3RhbGwgZmFpbGVkOiAke3RleHR9ICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTgwKX1gKTtcclxuICAgIGZpbmlzaCh7IHBoYXNlOiAnZXJyb3InLCB0ZXh0LCBlcnJvcjogYCR7dGV4dH06JHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxNjApfWAgfSk7XHJcbiAgfTtcclxuICB2b2lkIChhc3luYyAoKSA9PiB7XHJcbiAgICBjb25zdCB0YXJnZXQgPSBpbnN0YWxsVGFyZ2V0KCk7XHJcbiAgICB0cnkge1xyXG4gICAgICBta2RpclN5bmModGFyZ2V0LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcclxuICAgICAgY29uc3QgbnBtT2sgPSBvcHRzLmZvcmNlVGd6ID09PSB0cnVlID8gZmFsc2UgOiBhd2FpdCBwcm9iZU5wbShob3N0KTtcclxuICAgICAgaWYgKG5wbU9rKSBhd2FpdCBpbnN0YWxsVmlhTnBtKGhvc3QsIHRhcmdldCwgb3B0cyk7XHJcbiAgICAgIGVsc2UgYXdhaXQgaW5zdGFsbFZpYVRhcmJhbGxzKGhvc3QsIHRhcmdldCwgb3B0cyk7XHJcbiAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgZmFpbCgnXHU1Qjg5XHU4OEM1XHU1OTMxXHU4RDI1JywgZXJyKTtcclxuICAgIH1cclxuICB9KSgpO1xyXG4gIHJldHVybiB7IG9rOiB0cnVlIH07XHJcbn1cclxuXHJcbi8qIC0tLS0gbnBtIFx1NTNFRlx1NzUyOFx1NjAyNyhcdTZDRThcdTYxMEY6V2luZG93cyBcdTRFMEIgc3Bhd24oJ25wbScpIFx1NTNFRlx1ODg0QywnbnBtLmNtZCcgXHU1M0NEXHU4MDBDIEVJTlZBTCkgLS0tLSAqL1xyXG5hc3luYyBmdW5jdGlvbiBwcm9iZU5wbShob3N0OiBJbnN0YWxsZXJIb3N0KTogUHJvbWlzZTxib29sZWFuPiB7XHJcbiAgaG9zdC5zZW5kUHJvZ3Jlc3MoeyBwaGFzZTogJ2NoZWNrJywgdGV4dDogJ1x1NjhDMFx1NjdFNSBucG1cdTIwMjYnIH0pO1xyXG4gIGNvbnN0IG9rID0gYXdhaXQgbmV3IFByb21pc2U8Ym9vbGVhbj4oKHJlc29sdmUpID0+IHtcclxuICAgIGNvbnN0IGMgPSBzcGF3bignbnBtJywgWyctLXZlcnNpb24nXSwgeyB3aW5kb3dzSGlkZTogdHJ1ZSwgc3RkaW86ICdpZ25vcmUnIH0pO1xyXG4gICAgY29uc3QgdCA9IHNldFRpbWVvdXQoKCkgPT4geyB0cnkgeyBjLmtpbGwoKTsgfSBjYXRjaCB7IC8qIG5vb3AgKi8gfSByZXNvbHZlKGZhbHNlKTsgfSwgMTVfMDAwKTtcclxuICAgIGMub24oJ2Vycm9yJywgKCkgPT4geyBjbGVhclRpbWVvdXQodCk7IHJlc29sdmUoZmFsc2UpOyB9KTtcclxuICAgIGMub24oJ2V4aXQnLCAoY29kZSkgPT4geyBjbGVhclRpbWVvdXQodCk7IHJlc29sdmUoY29kZSA9PT0gMCk7IH0pO1xyXG4gIH0pO1xyXG4gIGhvc3QubG9nKGBucG0gJHtvayA/ICdhdmFpbGFibGUnIDogJ3VuYXZhaWxhYmxlJ30gXHUyMTkyICR7b2sgPyAnbnBtIHByZWZpeCcgOiAndGd6J30gcGF0aGApO1xyXG4gIHJldHVybiBvaztcclxufVxyXG5cclxuLyogLS0tLSBcdThERUZcdTVGODQgQTpucG0gLS1wcmVmaXgoXHU1Qjg5XHU4OEM1XHU2QjY1XHU5QUE0XHU2NTg3XHU2ODQ4ID0gbnBtIFx1OEY5M1x1NTFGQVx1ODg0QykgLS0tLSAqL1xyXG5hc3luYyBmdW5jdGlvbiBpbnN0YWxsVmlhTnBtKGhvc3Q6IEluc3RhbGxlckhvc3QsIHRhcmdldDogc3RyaW5nLCBvcHRzOiBJbnN0YWxsT3B0aW9ucyk6IFByb21pc2U8dm9pZD4ge1xyXG4gIGhvc3Quc2VuZFByb2dyZXNzKHsgcGhhc2U6ICducG0nLCB0ZXh0OiBgbnBtIGluc3RhbGwgQGhtaGFybmVzcy9jbGkgXHUyMTkyICR7dGFyZ2V0fShcdTRFQzVcdTc1MjhcdTYyMzdcdTc2RUVcdTVGNTUpYCB9KTtcclxuICBjb25zdCByZWdpc3RyeSA9IG9wdHMubWlycm9yRmlyc3QgPT09ICducG1taXJyb3InID8gWyctLXJlZ2lzdHJ5JywgUkVHSVNUUklFUy5ucG1taXJyb3JdIDogb3B0cy5taXJyb3JGaXJzdCA9PT0gJ25wbWpzJyA/IFsnLS1yZWdpc3RyeScsIFJFR0lTVFJJRVMubnBtanNdIDogW107XHJcbiAgY29uc3QgYXJncyA9IFsnaW5zdGFsbCcsICctLXByZWZpeCcsIHRhcmdldCwgJy0tbm8tYXVkaXQnLCAnLS1uby1mdW5kJywgJy0tbG9nbGV2ZWwnLCAnbm90aWNlJywgLi4ucmVnaXN0cnksICdAaG1oYXJuZXNzL2NsaUBsYXRlc3QnXTtcclxuICBjb25zdCBjb2RlID0gYXdhaXQgbmV3IFByb21pc2U8bnVtYmVyPigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XHJcbiAgICBjb25zdCBjID0gc3Bhd24oJ25wbScsIGFyZ3MsIHsgd2luZG93c0hpZGU6IHRydWUsIGN3ZDogaG9tZWRpcigpIH0pO1xyXG4gICAgbGV0IGxhc3QgPSAnJztcclxuICAgIGNvbnN0IG9uTGluZSA9IChkOiBCdWZmZXIpOiB2b2lkID0+IHtcclxuICAgICAgZm9yIChjb25zdCByYXcgb2YgZC50b1N0cmluZygpLnNwbGl0KC9cXHI/XFxuLykpIHtcclxuICAgICAgICBjb25zdCBsaW5lID0gcmF3LnJlcGxhY2UoL1tcXHUwMDAwLVxcdTAwMWZdL2csICcnKS50cmltKCkuc2xpY2UoMCwgMTgwKTtcclxuICAgICAgICBpZiAobGluZSA9PT0gJycgfHwgbGluZSA9PT0gbGFzdCkgY29udGludWU7XHJcbiAgICAgICAgbGFzdCA9IGxpbmU7XHJcbiAgICAgICAgaG9zdC5zZW5kUHJvZ3Jlc3MoeyBwaGFzZTogJ25wbScsIHRleHQ6IGxpbmUgfSk7XHJcbiAgICAgIH1cclxuICAgIH07XHJcbiAgICBjLnN0ZG91dD8ub24oJ2RhdGEnLCBvbkxpbmUpO1xyXG4gICAgYy5zdGRlcnI/Lm9uKCdkYXRhJywgb25MaW5lKTtcclxuICAgIGMub24oJ2Vycm9yJywgcmVqZWN0KTtcclxuICAgIGNvbnN0IGtpbGxlciA9IHNldFRpbWVvdXQoKCkgPT4geyB0cnkgeyBjLmtpbGwoKTsgfSBjYXRjaCB7IC8qIG5vb3AgKi8gfSByZWplY3QobmV3IEVycm9yKCducG0gXHU1Qjg5XHU4OEM1XHU4RDg1XHU2NUY2KDggXHU1MjA2XHU5NDlGKScpKTsgfSwgOCAqIDYwXzAwMCk7XHJcbiAgICBjLm9uKCdleGl0JywgKHgpID0+IHsgY2xlYXJUaW1lb3V0KGtpbGxlcik7IHJlc29sdmUoeCA/PyAxKTsgfSk7XHJcbiAgfSk7XHJcbiAgaWYgKGNvZGUgIT09IDApIHRocm93IG5ldyBFcnJvcihgbnBtIGluc3RhbGwgXHU5MDAwXHU1MUZBXHU3ODAxICR7Y29kZX1gKTtcclxuICBjb25zdCBlbnRyeSA9IHJlc29sdmVJbnN0YWxsZWRFbnRyeSh0YXJnZXQpO1xyXG4gIGlmIChlbnRyeSA9PT0gJycpIHRocm93IG5ldyBFcnJvcignbnBtIFx1NUI4OVx1ODhDNVx1NUI4Q1x1NjIxMFx1NEY0Nlx1NjcyQVx1NjI3RVx1NTIzMCBkZXNrdG9wLWhvc3QgXHU1MTY1XHU1M0UzJyk7XHJcbiAgd3JpdGVTdGFtcCh0YXJnZXQsICducG0nKTtcclxuICBmaW5pc2hJbnN0YWxsKGhvc3QsIGVudHJ5LCAnbnBtJyk7XHJcbn1cclxuXHJcbi8qIC0tLS0gXHU4REVGXHU1Rjg0IEI6XHU4MUVBXHU3ODE0IHRneihcdTc3MUZcdTRFMEJcdThGN0RcdThGREJcdTVFQTYgKyBcdTk1NUNcdTUwQ0ZcdTU2REVcdTkwMDAgKyBpbnRlZ3JpdHkgKyB0YXIgXHU4OUUzXHU1MzhCKSAtLS0tICovXHJcbmFzeW5jIGZ1bmN0aW9uIGluc3RhbGxWaWFUYXJiYWxscyhob3N0OiBJbnN0YWxsZXJIb3N0LCB0YXJnZXQ6IHN0cmluZywgb3B0czogSW5zdGFsbE9wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcclxuICBjb25zdCBvcmRlcjogQXJyYXk8J25wbWpzJyB8ICducG1taXJyb3InPiA9IG9wdHMubWlycm9yRmlyc3QgPT09ICducG1taXJyb3InID8gWyducG1taXJyb3InLCAnbnBtanMnXSA6IFsnbnBtanMnLCAnbnBtbWlycm9yJ107XHJcbiAgY29uc3QgbWlycm9ycyA9IG9yZGVyLm1hcCgoaykgPT4gUkVHSVNUUklFU1trXSk7XHJcbiAgaG9zdC5zZW5kUHJvZ3Jlc3MoeyBwaGFzZTogJ21ldGEnLCB0ZXh0OiAnXHU4OUUzXHU2NzkwXHU0RjlEXHU4RDU2XHU2RTA1XHU1MzU1KEBobWhhcm5lc3MvY2xpIFx1NTE2OFx1NUJCNilcdTIwMjYnIH0pO1xyXG5cclxuICBjb25zdCBwYWNrdW1lbnRzID0gbmV3IE1hcDxzdHJpbmcsIFBhY2t1bWVudD4oKTtcclxuICBjb25zdCBnZXRQYWNrdW1lbnQgPSBhc3luYyAobmFtZTogc3RyaW5nKTogUHJvbWlzZTxQYWNrdW1lbnQ+ID0+IHtcclxuICAgIGNvbnN0IGhpdCA9IHBhY2t1bWVudHMuZ2V0KG5hbWUpO1xyXG4gICAgaWYgKGhpdCAhPT0gdW5kZWZpbmVkKSByZXR1cm4gaGl0O1xyXG4gICAgbGV0IGxhc3RFcnIgPSAnJztcclxuICAgIGZvciAoY29uc3QgbSBvZiBtaXJyb3JzKSB7XHJcbiAgICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgciA9IGF3YWl0IGZldGNoKGAke219LyR7ZW5jb2RlVVJJQ29tcG9uZW50KG5hbWUpfWAsIHtcclxuICAgICAgICAgIGhlYWRlcnM6IHsgYWNjZXB0OiAnYXBwbGljYXRpb24vdm5kLm5wbS5pbnN0YWxsLXYxK2pzb24nIH0sXHJcbiAgICAgICAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoMjVfMDAwKSxcclxuICAgICAgICB9KTtcclxuICAgICAgICBpZiAoIXIub2spIHsgbGFzdEVyciA9IGBIVFRQICR7ci5zdGF0dXN9YDsgY29udGludWU7IH1cclxuICAgICAgICBjb25zdCBkb2MgPSAoYXdhaXQgci5qc29uKCkpIGFzIFBhY2t1bWVudDtcclxuICAgICAgICBpZiAoZG9jLnZlcnNpb25zID09PSB1bmRlZmluZWQpIHsgbGFzdEVyciA9ICdtYWxmb3JtZWQgcGFja3VtZW50JzsgY29udGludWU7IH1cclxuICAgICAgICBwYWNrdW1lbnRzLnNldChuYW1lLCBkb2MpO1xyXG4gICAgICAgIHJldHVybiBkb2M7XHJcbiAgICAgIH0gY2F0Y2ggKGVycikgeyBsYXN0RXJyID0gU3RyaW5nKGVycikuc2xpY2UoMCwgNjApOyB9XHJcbiAgICB9XHJcbiAgICB0aHJvdyBuZXcgRXJyb3IoYFx1ODNCN1x1NTNENiAke25hbWV9IFx1NTE0M1x1NjU3MFx1NjM2RVx1NTkzMVx1OEQyNShcdTUxNjhcdTkwRThcdTk1NUNcdTUwQ0Y6JHtsYXN0RXJyfSlgKTtcclxuICB9O1xyXG5cclxuICBjb25zdCBjbG9zdXJlID0gYXdhaXQgcmVzb2x2ZUNsb3N1cmUoeyBuYW1lOiAnQGhtaGFybmVzcy9jbGknLCBzcGVjOiAnbGF0ZXN0JyB9LCBnZXRQYWNrdW1lbnQpO1xyXG4gIGNvbnN0IHJvb3QgPSBjbG9zdXJlLmZpbmQoKHApID0+IHAubmFtZSA9PT0gJ0BobWhhcm5lc3MvY2xpJyk7XHJcbiAgaG9zdC5sb2coYGNsb3N1cmU6ICR7Y2xvc3VyZS5sZW5ndGh9IHBhY2thZ2VzIChyb290IEBobWhhcm5lc3MvY2xpQCR7cm9vdD8udmVyc2lvbiA/PyAnPyd9KWApO1xyXG4gIGhvc3Quc2VuZFByb2dyZXNzKHsgcGhhc2U6ICdtZXRhJywgdGV4dDogYFx1NEY5RFx1OEQ1Nlx1NkUwNVx1NTM1NVx1NUMzMVx1N0VFQToke2Nsb3N1cmUubGVuZ3RofSBcdTRFMkFcdTUzMDUoQGhtaGFybmVzcy9jbGlAJHtyb290Py52ZXJzaW9uID8/ICc/J30pYCB9KTtcclxuXHJcbiAgY29uc3Qgc3RhZ2luZyA9IGpvaW4odGFyZ2V0LCAnLnN0YWdpbmcnKTtcclxuICBybVN5bmMoc3RhZ2luZywgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xyXG4gIG1rZGlyU3luYyhzdGFnaW5nLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcclxuXHJcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBjbG9zdXJlLmxlbmd0aDsgaSsrKSB7XHJcbiAgICBjb25zdCBwa2cgPSBjbG9zdXJlW2ldITtcclxuICAgIGNvbnN0IHVybHMgPSB0YXJiYWxsTWlycm9ycyhwa2cudGFyYmFsbCwgbWlycm9ycyk7XHJcbiAgICBsZXQgYnVmOiBCdWZmZXIgfCBudWxsID0gbnVsbDtcclxuICAgIGxldCB1c2VkTWlycm9yID0gJyc7XHJcbiAgICBsZXQgbGFzdEVyciA9ICcnO1xyXG4gICAgZm9yIChjb25zdCB1IG9mIHVybHMpIHtcclxuICAgICAgdHJ5IHtcclxuICAgICAgICBjb25zdCByID0gYXdhaXQgZmV0Y2godSwgeyBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoMzAwXzAwMCkgfSk7XHJcbiAgICAgICAgaWYgKCFyLm9rKSB7IGxhc3RFcnIgPSBgSFRUUCAke3Iuc3RhdHVzfWA7IGNvbnRpbnVlOyB9XHJcbiAgICAgICAgY29uc3QgdG90YWwgPSBOdW1iZXIoci5oZWFkZXJzLmdldCgnY29udGVudC1sZW5ndGgnKSA/PyAnMCcpO1xyXG4gICAgICAgIGNvbnN0IHJlYWRlciA9IHIuYm9keT8uZ2V0UmVhZGVyKCk7XHJcbiAgICAgICAgaWYgKHJlYWRlciA9PT0gdW5kZWZpbmVkKSB0aHJvdyBuZXcgRXJyb3IoJ25vIGJvZHknKTtcclxuICAgICAgICBjb25zdCBjaHVua3M6IEJ1ZmZlcltdID0gW107XHJcbiAgICAgICAgbGV0IGdvdCA9IDA7XHJcbiAgICAgICAgbGV0IGxhc3RFbWl0ID0gMDtcclxuICAgICAgICBmb3IgKDs7KSB7XHJcbiAgICAgICAgICBjb25zdCB7IGRvbmUsIHZhbHVlIH0gPSBhd2FpdCByZWFkZXIucmVhZCgpO1xyXG4gICAgICAgICAgaWYgKGRvbmUgPT09IHRydWUpIGJyZWFrO1xyXG4gICAgICAgICAgY29uc3QgYiA9IEJ1ZmZlci5mcm9tKHZhbHVlKTtcclxuICAgICAgICAgIGNodW5rcy5wdXNoKGIpO1xyXG4gICAgICAgICAgZ290ICs9IGIubGVuZ3RoO1xyXG4gICAgICAgICAgaWYgKGdvdCAtIGxhc3RFbWl0ID4gMjU2ICogMTAyNCkge1xyXG4gICAgICAgICAgICBsYXN0RW1pdCA9IGdvdDtcclxuICAgICAgICAgICAgaG9zdC5zZW5kUHJvZ3Jlc3Moe1xyXG4gICAgICAgICAgICAgIHBoYXNlOiAnZG93bmxvYWQnLFxyXG4gICAgICAgICAgICAgIHBjdDogTWF0aC5yb3VuZCgoKGkgKyBNYXRoLm1pbihnb3QgLyAodG90YWwgfHwgZ290KSwgMSkpIC8gY2xvc3VyZS5sZW5ndGgpICogMTAwKSxcclxuICAgICAgICAgICAgICB0ZXh0OiBgXHU0RTBCXHU4RjdEICR7cGtnLm5hbWV9QCR7cGtnLnZlcnNpb259KCR7aSArIDF9LyR7Y2xvc3VyZS5sZW5ndGh9KVx1MDBCNyAke2J5dGVzTGFiZWwoZ290KX0ke3RvdGFsID4gMCA/IGAgLyAke2J5dGVzTGFiZWwodG90YWwpfWAgOiAnJ31gLFxyXG4gICAgICAgICAgICAgIG1pcnJvcjogbmV3IFVSTCh1KS5ob3N0LFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgYnVmID0gQnVmZmVyLmNvbmNhdChjaHVua3MpO1xyXG4gICAgICAgIGlmICghaW50ZWdyaXR5T2soYnVmLCBwa2cuaW50ZWdyaXR5KSkgeyBsYXN0RXJyID0gJ2ludGVncml0eSBcdTRFMERcdTUzMzlcdTkxNEQnOyBidWYgPSBudWxsOyBjb250aW51ZTsgfVxyXG4gICAgICAgIHVzZWRNaXJyb3IgPSBuZXcgVVJMKHUpLmhvc3Q7XHJcbiAgICAgICAgYnJlYWs7XHJcbiAgICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICAgIGxhc3RFcnIgPSBTdHJpbmcoZXJyKS5zbGljZSgwLCA2MCk7XHJcbiAgICAgIH1cclxuICAgIH1cclxuICAgIGlmIChidWYgPT09IG51bGwpIHRocm93IG5ldyBFcnJvcihgXHU0RTBCXHU4RjdEICR7cGtnLm5hbWV9IFx1NTkzMVx1OEQyNShcdTUxNjhcdTkwRThcdTk1NUNcdTUwQ0Y6JHtsYXN0RXJyfSlgKTtcclxuICAgIGNvbnN0IHRneiA9IGpvaW4oc3RhZ2luZywgYCR7aX0udGd6YCk7XHJcbiAgICB3cml0ZUZpbGVTeW5jKHRneiwgYnVmKTtcclxuICAgIGhvc3Quc2VuZFByb2dyZXNzKHtcclxuICAgICAgcGhhc2U6ICdkb3dubG9hZCcsXHJcbiAgICAgIHBjdDogTWF0aC5yb3VuZCgoKGkgKyAxKSAvIGNsb3N1cmUubGVuZ3RoKSAqIDEwMCksXHJcbiAgICAgIHRleHQ6IGBcdTRFMEJcdThGN0QgJHtwa2cubmFtZX1AJHtwa2cudmVyc2lvbn0gXHU1QjhDXHU2MjEwKCR7Ynl0ZXNMYWJlbChidWYubGVuZ3RoKX0sdmlhICR7dXNlZE1pcnJvcn0pYCxcclxuICAgICAgbWlycm9yOiB1c2VkTWlycm9yLFxyXG4gICAgfSk7XHJcbiAgfVxyXG5cclxuICBob3N0LnNlbmRQcm9ncmVzcyh7IHBoYXNlOiAnZXh0cmFjdCcsIHRleHQ6ICdcdTg5RTNcdTUzOEJcdTVFNzZcdTVFMDNcdTVDNDAgbm9kZV9tb2R1bGVzXHUyMDI2JyB9KTtcclxuICBmb3IgKGxldCBpID0gMDsgaSA8IGNsb3N1cmUubGVuZ3RoOyBpKyspIHtcclxuICAgIGNvbnN0IHBrZyA9IGNsb3N1cmVbaV0hO1xyXG4gICAgYXdhaXQgZXh0cmFjdFRneihqb2luKHN0YWdpbmcsIGAke2l9LnRnemApLCBzdGFnaW5nLCBwa2cpO1xyXG4gICAgaG9zdC5zZW5kUHJvZ3Jlc3MoeyBwaGFzZTogJ2V4dHJhY3QnLCBwY3Q6IE1hdGgucm91bmQoKChpICsgMSkgLyBjbG9zdXJlLmxlbmd0aCkgKiAxMDApLCB0ZXh0OiBgXHU4OUUzXHU1MzhCICR7cGtnLm5hbWV9KCR7aSArIDF9LyR7Y2xvc3VyZS5sZW5ndGh9KWAgfSk7XHJcbiAgfVxyXG4gIHJtU3luYyhzdGFnaW5nLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XHJcblxyXG4gIGNvbnN0IGVudHJ5ID0gcmVzb2x2ZUluc3RhbGxlZEVudHJ5KHRhcmdldCk7XHJcbiAgaWYgKGVudHJ5ID09PSAnJykgdGhyb3cgbmV3IEVycm9yKCd0Z3ogXHU1Qjg5XHU4OEM1XHU1QjhDXHU2MjEwXHU0RjQ2XHU2NzJBXHU2MjdFXHU1MjMwIGRlc2t0b3AtaG9zdCBcdTUxNjVcdTUzRTMnKTtcclxuICB3cml0ZVN0YW1wKHRhcmdldCwgJ3RneicpO1xyXG4gIGZpbmlzaEluc3RhbGwoaG9zdCwgZW50cnksICd0Z3onKTtcclxufVxyXG5cclxuLyoqIHRhci5leGUoV2luMTArIFx1ODFFQVx1NUUyNilcdTg5RTNcdTUzOEIgdGd6IFx1NTIzMCBleERpcixcdTUxOERcdTYyOEEgcGFja2FnZS8gXHU2MzJBXHU1MjMwIG5vZGVfbW9kdWxlcyBcdTVFMDNcdTVDNDBcdTMwMDIgKi9cclxuYXN5bmMgZnVuY3Rpb24gZXh0cmFjdFRneih0Z3o6IHN0cmluZywgc3RhZ2luZzogc3RyaW5nLCBwa2c6IFJlc29sdmVkUGtnKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgY29uc3QgZXhEaXIgPSBqb2luKHN0YWdpbmcsIGB4LSR7cGtnLm5hbWUucmVwbGFjZSgvW15cXHcuLV0vZywgJ18nKX1gKTtcclxuICBybVN5bmMoZXhEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcclxuICBta2RpclN5bmMoZXhEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xyXG4gIGNvbnN0IGNvZGUgPSBhd2FpdCBuZXcgUHJvbWlzZTxudW1iZXI+KChyZXNvbHZlLCByZWplY3QpID0+IHtcclxuICAgIGNvbnN0IGMgPSBzcGF3bigndGFyJywgWycteHpmJywgdGd6LCAnLUMnLCBleERpcl0sIHsgd2luZG93c0hpZGU6IHRydWUsIHN0ZGlvOiAnaWdub3JlJyB9KTtcclxuICAgIGMub24oJ2Vycm9yJywgcmVqZWN0KTtcclxuICAgIGMub24oJ2V4aXQnLCAoeCkgPT4gcmVzb2x2ZSh4ID8/IDEpKTtcclxuICB9KTtcclxuICBpZiAoY29kZSAhPT0gMCkgdGhyb3cgbmV3IEVycm9yKGB0YXIgXHU4OUUzXHU1MzhCICR7cGtnLm5hbWV9IFx1NTkzMVx1OEQyNShcdTkwMDBcdTUxRkFcdTc4MDEgJHtjb2RlfSlgKTtcclxuICBjb25zdCBkZXN0ID0gbW9kdWxlRGlyKGluc3RhbGxUYXJnZXQoKSwgcGtnLm5hbWUpO1xyXG4gIGNvbnN0IHBhcmVudCA9IGRlc3Quc2xpY2UoMCwgZGVzdC5sYXN0SW5kZXhPZignXFxcXCcpKTtcclxuICBta2RpclN5bmMocGFyZW50LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcclxuICBybVN5bmMoZGVzdCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xyXG4gIHJlbmFtZVN5bmMoam9pbihleERpciwgJ3BhY2thZ2UnKSwgZGVzdCk7XHJcbiAgcm1TeW5jKGV4RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XHJcbn1cclxuXHJcbi8qKiBcdTVCODlcdTg4QzVcdTYyMzMoXHU1NDExXHU1QkZDXHU1QjhDXHU2MjEwXHU5ODc1L1x1OEJCRVx1N0Y2RVx1OTc2Mlx1Njc3Rlx1NUM1NVx1NzkzQVx1NUI4OVx1ODhDNVx1NjVCOVx1NUYwRlx1NEUwRVx1NjVGNlx1OTVGNDtcdTRFMERcdTYyN0ZcdThGN0RcdThGRDBcdTg4NENcdTY1RjZcdTkwM0JcdThGOTEpXHUzMDAyICovXHJcbmZ1bmN0aW9uIHdyaXRlU3RhbXAodGFyZ2V0OiBzdHJpbmcsIHZpYTogJ25wbScgfCAndGd6Jyk6IHZvaWQge1xyXG4gIHRyeSB7XHJcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4odGFyZ2V0LCAnaW5zdGFsbGVkLWJ5LWhtaC1kZXNrdG9wLmpzb24nKSwgSlNPTi5zdHJpbmdpZnkoeyB2aWEsIGF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkgfSwgbnVsbCwgMiksICd1dGY4Jyk7XHJcbiAgfSBjYXRjaCB7IC8qIGJlc3QgZWZmb3J0ICovIH1cclxufVxyXG5cclxuZnVuY3Rpb24gZmluaXNoSW5zdGFsbChob3N0OiBJbnN0YWxsZXJIb3N0LCBlbnRyeTogc3RyaW5nLCB2aWE6ICducG0nIHwgJ3RneicpOiB2b2lkIHtcclxuICBob3N0LmxvZyhgaW5zdGFsbCBkb25lIHZpYSAke3ZpYX06ICR7ZW50cnl9YCk7XHJcbiAgaG9zdC5zZW5kUHJvZ3Jlc3MoeyBwaGFzZTogJ2RvbmUnLCB0ZXh0OiBgXHU1Qjg5XHU4OEM1XHU1QjhDXHU2MjEwKCR7dmlhfSlgLCBlbnRyeSB9KTtcclxuICBob3N0Lm9uSW5zdGFsbGVkKGVudHJ5LCB2aWEpO1xyXG4gIHJ1bm5pbmcgPSBmYWxzZTtcclxufVxyXG4iLCAiLyoqXHJcbiAqIEBobWhhcm5lc3MvY2xpIFx1NUI4OVx1ODhDNVx1NjgzOFx1NUZDMyhcdTdFQUZcdTkwM0JcdThGOTEsXHU5NkY2IElPIFx1MjAxNFx1MjAxNCBmZXRjaC9cdTg5RTNcdTUzOEIvXHU4NDNEXHU3NkQ4XHU1NzI4XHU0RTNCXHU4RkRCXHU3QTBCIGluc3RhbGxlciBcdTkxQ0MpXHUzMDAyXHJcbiAqXHJcbiAqIFx1ODA0Q1x1OEQyMyh2NS4xIFx1NUI4OVx1ODhDNVx1NTQxMVx1NUJGQyk6XHU3RUQ5XHU1QjlBIHJlZ2lzdHJ5IFx1NTE0M1x1NjU3MFx1NjM2RVx1ODNCN1x1NTNENlx1NTFGRFx1NjU3MCxcdTg5RTNcdTY3OTAgQGhtaGFybmVzcy9jbGkgXHU3Njg0XHJcbiAqIFx1NUI4Q1x1NjU3NFx1NEY5RFx1OEQ1Nlx1OTVFRFx1NTMwNShAaG1oYXJuZXNzLyogXHU1MTY4XHU1QkI2XHU0RTNBXHU3Q0JFXHU3ODZFXHU3MjQ4XHU2NzJDXHU0RTkyXHU5NDg5O1x1NTkxNlx1OTBFOFx1NEY5RFx1OEQ1NiBxcmNvZGUgXHU5NEZFXHU0RTNBIF4gXHU4MzAzXHU1NkY0KSxcclxuICogXHU0RUE3XHU1MUZBXCJcdTg4QzVcdTRFQzBcdTRFNDhcdTMwMDFcdTRFQ0VcdTU0RUFcdTRFOUJcdTk1NUNcdTUwQ0ZcdTRFMEJcdTMwMDFcdTg4QzVcdTUyMzBcdTU0RUFcIlx1NzY4NFx1Nzg2RVx1NUI5QVx1NjAyN1x1OEJBMVx1NTIxMlx1MzAwMlx1OEJCRVx1OEJBMVx1N0VBNlx1Njc1RjpcclxuICogIC0gXHU5NUVEXHU1MzA1XHU2MzA5XHU1MzA1XHU1NDBEXHU1M0JCXHU5MUNEKFx1OTRCQlx1NzdGM1x1NEY5RFx1OEQ1Nlx1NTNFQVx1ODhDNVx1NEUwMFx1NEVGRCxucG0gXHU4QkVEXHU0RTQ5KTtcclxuICogIC0gXHU4MzAzXHU1NkY0XHU4OUUzXHU2NzkwXHU1M0VBXHU2NTJGXHU2MzAxIG5wbSBcdTc1MUZcdTYwMDFcdTVCOUVcdTk2NDVcdTc1MjhcdTUyMzBcdTc2ODRcdTVGNjJcdTYwMDE6XHU3Q0JFXHU3ODZFIC8gbGF0ZXN0IC8gKiAvIF4gLyB+IC8gPj0sXHJcbiAqICAgIFx1NEUwRFx1NUYxNSBzZW12ZXIgXHU1RTkzKFx1OTZGNlx1NEY5RFx1OEQ1Nlx1NTM5Rlx1NTIxOSxcdTRFMEVcdTgxRUFcdTc4MTRcdTY2RjRcdTY1QjBcdTU2NjhcdTRFMDBcdTgxRjQpO1xyXG4gKiAgLSBvcHRpb25hbERlcGVuZGVuY2llcyBcdTRFMERcdTg4QzU6XHU5NUVEXHU1MzA1XHU1MTg1XHU1QjlFXHU5NjQ1XHU1OEYwXHU2NjBFXHU3Njg0IG9wdGlvbmFsIFx1NTc0N1x1NEUzQVx1NUU3M1x1NTNGMFx1NzI3OVx1NUI5QVxyXG4gKiAgICAoZnNldmVudHMgXHU3QjQ5KSx0Z3ogXHU4REVGXHU1Rjg0XHU0RTBEXHU4REQxXHU3NTFGXHU1NDdEXHU1NDY4XHU2NzFGXHU4MTFBXHU2NzJDLFx1ODhDNVx1NEU4Nlx1NEU1Rlx1NTNFQVx1NjYyRlx1NkI3Qlx1OTFDRFx1MzAwMlxyXG4gKi9cclxuaW1wb3J0IHsgY3JlYXRlSGFzaCB9IGZyb20gJ25vZGU6Y3J5cHRvJztcclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgUGtnVmVyc2lvbk1ldGEge1xyXG4gIHZlcnNpb246IHN0cmluZztcclxuICBkZXBlbmRlbmNpZXM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XHJcbiAgdGFyYmFsbDogc3RyaW5nO1xyXG4gIGludGVncml0eT86IHN0cmluZyB8IHVuZGVmaW5lZDtcclxufVxyXG5cclxuLyoqIHJlZ2lzdHJ5IHBhY2t1bWVudCBcdTc2ODRcdTY3MDBcdTVDMEZcdThCRkJcdTUzRDZcdTk3NjIoZGlzdC10YWdzICsgXHU1MTY4XHU3MjQ4XHU2NzJDXHU0RjlEXHU4RDU2L3RhcmJhbGwgXHU1MTQzXHU2NTcwXHU2MzZFKVx1MzAwMiAqL1xyXG5leHBvcnQgaW50ZXJmYWNlIFBhY2t1bWVudCB7XHJcbiAgJ2Rpc3QtdGFncyc6IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XHJcbiAgdmVyc2lvbnM6IFJlY29yZDxzdHJpbmcsIHsgZGVwZW5kZW5jaWVzPzogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB8IHVuZGVmaW5lZDsgZGlzdD86IHsgdGFyYmFsbD86IHN0cmluZzsgaW50ZWdyaXR5Pzogc3RyaW5nIHwgdW5kZWZpbmVkIH0gfCB1bmRlZmluZWQgfT47XHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgUmVzb2x2ZWRQa2cge1xyXG4gIG5hbWU6IHN0cmluZztcclxuICB2ZXJzaW9uOiBzdHJpbmc7XHJcbiAgLyoqIHJlZ2lzdHJ5IFx1NTM5Rlx1NTlDQlx1NTczMFx1NTc0MChcdTk1NUNcdTUwQ0ZcdTUyMTdcdTg4NjhcdTc1MzEgdGFyYmFsbE1pcnJvcnMgXHU2RDNFXHU3NTFGKVx1MzAwMiAqL1xyXG4gIHRhcmJhbGw6IHN0cmluZztcclxuICBpbnRlZ3JpdHk/OiBzdHJpbmcgfCB1bmRlZmluZWQ7XHJcbn1cclxuXHJcbi8qIC0tLS0gc2VtdmVyKFx1NjcwMFx1NUMwRlx1NUI5RVx1NzNCMDpcdTk1RURcdTUzMDVcdTUxODVcdTVCOUVcdTk2NDVcdTUxRkFcdTczQjBcdTc2ODRcdTVGNjJcdTYwMDEpIC0tLS0gKi9cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBjbXBTZW12ZXIoYTogc3RyaW5nLCBiOiBzdHJpbmcpOiBudW1iZXIge1xyXG4gIGNvbnN0IHBhID0gYS5yZXBsYWNlKC9edi8sICcnKS5zcGxpdCgnLScpWzBdIS5zcGxpdCgnLicpLm1hcChOdW1iZXIpO1xyXG4gIGNvbnN0IHBiID0gYi5yZXBsYWNlKC9edi8sICcnKS5zcGxpdCgnLScpWzBdIS5zcGxpdCgnLicpLm1hcChOdW1iZXIpO1xyXG4gIGZvciAobGV0IGkgPSAwOyBpIDwgMzsgaSsrKSB7XHJcbiAgICBjb25zdCB4ID0gcGFbaV0gPz8gMDtcclxuICAgIGNvbnN0IHkgPSBwYltpXSA/PyAwO1xyXG4gICAgaWYgKHggIT09IHkpIHJldHVybiB4IDwgeSA/IC0xIDogMTtcclxuICB9XHJcbiAgcmV0dXJuIDA7XHJcbn1cclxuXHJcbi8qKiByYW5nZSBcdTY2MkZcdTU0MjZcdTYzQTVcdTUzRDcgdmVyc2lvbihcdTY1MkZcdTYzMDEgXHU3Q0JFXHU3ODZFIC8gbGF0ZXN0IC8gKiAvIHggLyBeIC8gfiAvID49O1x1NEUwRFx1OEJDNlx1NTIyQlx1NTIxOSBmYWxzZSlcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHNhdGlzZmllcyhyYW5nZTogc3RyaW5nLCB2ZXJzaW9uOiBzdHJpbmcpOiBib29sZWFuIHtcclxuICBjb25zdCByID0gcmFuZ2UudHJpbSgpO1xyXG4gIGlmIChyID09PSAnJyB8fCByID09PSAnKicgfHwgciA9PT0gJ2xhdGVzdCcgfHwgciA9PT0gJ3gnKSByZXR1cm4gdHJ1ZTtcclxuICBpZiAociA9PT0gdmVyc2lvbikgcmV0dXJuIHRydWU7XHJcbiAgY29uc3QgYm91bmQgPSAvXihcXF58fnw+PT8pXFxzKihcXGQrKVxcLihcXGQrKVxcLihcXGQrKS8uZXhlYyhyKTtcclxuICBpZiAoYm91bmQgIT09IG51bGwpIHtcclxuICAgIGNvbnN0IG9wID0gYm91bmRbMV0hO1xyXG4gICAgY29uc3QgbWFqb3IgPSBOdW1iZXIoYm91bmRbMl0pO1xyXG4gICAgY29uc3QgbWlub3IgPSBOdW1iZXIoYm91bmRbM10pO1xyXG4gICAgY29uc3QgcGF0Y2ggPSBOdW1iZXIoYm91bmRbNF0pO1xyXG4gICAgY29uc3QgYyA9IGNtcFNlbXZlcih2ZXJzaW9uLCBgJHttYWpvcn0uJHttaW5vcn0uJHtwYXRjaH1gKTtcclxuICAgIGlmIChjIDwgMCkgcmV0dXJuIGZhbHNlO1xyXG4gICAgaWYgKG9wID09PSAnPj0nKSByZXR1cm4gdHJ1ZTsgLy8gJz49JyBcdTRFMEJcdTc1NENcdTUzNzNcdTUzRUY6XHU5NUVEXHU1MzA1XHU1MTg1XHU1M0VBXHU0RUU1ICc+PXgueS56IDx6JyBcdTU5MERcdTU0MDhcdTVGNjJcdTYwMDFcdTUxRkFcdTczQjAsXHU0RkREXHU1Qjg4XHU1M0Q2XHU0RTBCXHU3NTRDXHJcbiAgICBpZiAob3AgPT09ICd+JykgcmV0dXJuIGNtcFNlbXZlcih2ZXJzaW9uLCBgJHttYWpvcn0uJHttaW5vciArIDF9LjBgKSA8IDA7XHJcbiAgICAvLyAnXic6MC54IFx1NzI3OVx1NTIyNCgwLjIuMyBcdTUxNDFcdThCQjggMC4yLnopLFx1NTE3Nlx1NEY1OVx1OTUwMVx1NEUzQlx1NzI0OFx1NjcyQ1xyXG4gICAgaWYgKG1ham9yID09PSAwKSByZXR1cm4gbWlub3IgPT09IDAgPyBjbXBTZW12ZXIodmVyc2lvbiwgYDAuMC4ke3BhdGNoICsgMX1gKSA8IDAgOiBjbXBTZW12ZXIodmVyc2lvbiwgYDAuJHttaW5vciArIDF9LjBgKSA8IDA7XHJcbiAgICByZXR1cm4gY21wU2VtdmVyKHZlcnNpb24sIGAke21ham9yICsgMX0uMC4wYCkgPCAwO1xyXG4gIH1cclxuICByZXR1cm4gZmFsc2U7XHJcbn1cclxuXHJcbi8qKiBcdTRFQ0UgcGFja3VtZW50IFx1OTAwOVx1NTFGQSBzcGVjKFx1N0NCRVx1Nzg2RS9sYXRlc3QvXi9+LyopXHU2MzA3XHU1NDExXHU3Njg0XHU3MjQ4XHU2NzJDO1x1NjVFMFx1NTMzOVx1OTE0RFx1OEZENFx1NTZERSAnJ1x1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gcGlja1ZlcnNpb24oZG9jOiBQYWNrdW1lbnQsIHNwZWM6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgY29uc3QgcyA9IHNwZWMudHJpbSgpO1xyXG4gIGNvbnN0IHRhZyA9IHMgPT09ICcnIHx8IHMgPT09ICdsYXRlc3QnIHx8IHMgPT09ICcqJyA/IGRvY1snZGlzdC10YWdzJ10/LmxhdGVzdCA6IHVuZGVmaW5lZDtcclxuICBpZiAodGFnICE9PSB1bmRlZmluZWQgJiYgZG9jLnZlcnNpb25zW3RhZ10gIT09IHVuZGVmaW5lZCkgcmV0dXJuIHRhZztcclxuICBpZiAoZG9jLnZlcnNpb25zW3NdICE9PSB1bmRlZmluZWQpIHJldHVybiBzO1xyXG4gIGxldCBiZXN0ID0gJyc7XHJcbiAgZm9yIChjb25zdCB2IG9mIE9iamVjdC5rZXlzKGRvYy52ZXJzaW9ucykpIHtcclxuICAgIGlmIChzYXRpc2ZpZXMocywgdikgJiYgY21wU2VtdmVyKHYsIGJlc3QpID4gMCkgYmVzdCA9IHY7XHJcbiAgfVxyXG4gIHJldHVybiBiZXN0O1xyXG59XHJcblxyXG4vKiAtLS0tIFx1NEY5RFx1OEQ1Nlx1OTVFRFx1NTMwNSAtLS0tICovXHJcblxyXG4vKipcclxuICogXHU4OUUzXHU2NzkwIHJvb3QgXHU1M0NBXHU1MTc2XHU1MTY4XHU5MEU4XHU0RjIwXHU5MDEyXHU0RjlEXHU4RDU2KEJGUyxcdTYzMDlcdTUzMDVcdTU0MERcdTUzQkJcdTkxQ0RcdTUzRDZcdTk5OTZcdTRFMkFcdTg5RTNcdTY3OTBcdTdFRDNcdTY3OUMgXHUyMDE0XHUyMDE0IFx1NEUwRSBucG0gXHU2MjQxXHU1RTczXHJcbiAqIFx1NUUwM1x1NUM0MFx1NEUwMFx1ODFGNClcdTMwMDJnZXRQYWNrdW1lbnQgXHU3NTMxXHU4QzAzXHU3NTI4XHU2NUI5XHU2Q0U4XHU1MTY1KGZldGNoIFx1N0Y1MVx1N0VEQyAvIFx1NkQ0Qlx1OEJENVx1NkNFOFx1NTE2NVx1NUI1N1x1NTE3OClcdTMwMDJcclxuICogXHU0RUZCXHU0RTAwXHU0RjlEXHU4RDU2XHU2NUUwXHU2RUUxXHU4REIzXHU3MjQ4XHU2NzJDXHU2NUY2XHU2MjlCXHU5NTE5KFx1NUUyNlx1NTMwNVx1NTQwRFx1NEUwRSByYW5nZSxcdTk3NjJcdTU0MTFcdTVCODlcdTg4QzVcdTk4NzVcdTk1MTlcdThCRUZcdTY1ODdcdTY4NDgpXHUzMDAyXHJcbiAqL1xyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZUNsb3N1cmUoXHJcbiAgcm9vdDogeyBuYW1lOiBzdHJpbmc7IHNwZWM6IHN0cmluZyB9LFxyXG4gIGdldFBhY2t1bWVudDogKG5hbWU6IHN0cmluZykgPT4gUHJvbWlzZTxQYWNrdW1lbnQ+LFxyXG4pOiBQcm9taXNlPFJlc29sdmVkUGtnW10+IHtcclxuICBjb25zdCByZXNvbHZlZCA9IG5ldyBNYXA8c3RyaW5nLCBQa2dWZXJzaW9uTWV0YT4oKTtcclxuICBjb25zdCBxdWV1ZTogQXJyYXk8eyBuYW1lOiBzdHJpbmc7IHNwZWM6IHN0cmluZyB9PiA9IFtyb290XTtcclxuICB3aGlsZSAocXVldWUubGVuZ3RoID4gMCkge1xyXG4gICAgY29uc3QgeyBuYW1lLCBzcGVjIH0gPSBxdWV1ZS5zaGlmdCgpITtcclxuICAgIGlmIChyZXNvbHZlZC5oYXMobmFtZSkpIGNvbnRpbnVlOyAvLyBcdTVERjJcdTVCOUFcdTcyNDg6XHU1NDBFXHU3RUVEIHJhbmdlIFx1NUYxNVx1NzUyOFx1NEUwRFx1NTE4RFx1OTFDRFx1ODlFMyhucG0gXHU2MjQxXHU1RTczXHU4QkVEXHU0RTQ5KVxyXG4gICAgY29uc3QgZG9jID0gYXdhaXQgZ2V0UGFja3VtZW50KG5hbWUpO1xyXG4gICAgY29uc3QgdmVyc2lvbiA9IHBpY2tWZXJzaW9uKGRvYywgc3BlYyk7XHJcbiAgICBjb25zdCBtZXRhID0gdmVyc2lvbiAhPT0gJycgPyBkb2MudmVyc2lvbnNbdmVyc2lvbl0gOiB1bmRlZmluZWQ7XHJcbiAgICBpZiAobWV0YSA9PT0gdW5kZWZpbmVkIHx8IG1ldGEuZGlzdD8udGFyYmFsbCA9PT0gdW5kZWZpbmVkKSB7XHJcbiAgICAgIHRocm93IG5ldyBFcnJvcihgbm8gdmVyc2lvbiBvZiAke25hbWV9IHNhdGlzZmllcyAke3NwZWMgfHwgJ2xhdGVzdCd9YCk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBpdGVtOiBQa2dWZXJzaW9uTWV0YSA9IHtcclxuICAgICAgdmVyc2lvbixcclxuICAgICAgZGVwZW5kZW5jaWVzOiBtZXRhLmRlcGVuZGVuY2llcyA/PyB7fSxcclxuICAgICAgdGFyYmFsbDogbWV0YS5kaXN0LnRhcmJhbGwsXHJcbiAgICAgIGludGVncml0eTogbWV0YS5kaXN0LmludGVncml0eSxcclxuICAgIH07XHJcbiAgICByZXNvbHZlZC5zZXQobmFtZSwgaXRlbSk7XHJcbiAgICBmb3IgKGNvbnN0IFtkZXAsIHJhbmdlXSBvZiBPYmplY3QuZW50cmllcyhpdGVtLmRlcGVuZGVuY2llcykpIHtcclxuICAgICAgaWYgKCFyZXNvbHZlZC5oYXMoZGVwKSkgcXVldWUucHVzaCh7IG5hbWU6IGRlcCwgc3BlYzogcmFuZ2UgfSk7XHJcbiAgICB9XHJcbiAgfVxyXG4gIHJldHVybiBbLi4ucmVzb2x2ZWQuZW50cmllcygpXS5tYXAoKFtuYW1lLCBtXSkgPT4gKHsgbmFtZSwgdmVyc2lvbjogbS52ZXJzaW9uLCB0YXJiYWxsOiBtLnRhcmJhbGwsIGludGVncml0eTogbS5pbnRlZ3JpdHkgfSkpO1xyXG59XHJcblxyXG4vKiAtLS0tIFx1OTU1Q1x1NTBDRlx1NEUwRVx1NUUwM1x1NUM0MCAtLS0tICovXHJcblxyXG5jb25zdCBSRUdJU1RSWV9IT1NUUyA9IC9eKGh0dHBzPzpcXC9cXC9bXi9dKylcXC8oLiopJC87XHJcblxyXG4vKipcclxuICogdGFyYmFsbCBcdTc2ODRcdTk1NUNcdTUwQ0ZcdTUwMTlcdTkwMDkoXHU5ODdBXHU1RThGXHU1MzczXHU1NkRFXHU5MDAwXHU5ODdBXHU1RThGKTpcdTUzOUZcdTU5Q0JcdTU3MzBcdTU3NDAgXHUyMTkyIFx1NTQwNCByZWdpc3RyeSBcdTU0MENcdThERUZcdTVGODRcdTY1MzlcdTUxOTlcdTMwMDJcclxuICogcGFja3VtZW50IFx1OTFDQ1x1NzY4NCBkaXN0LnRhcmJhbGwgXHU2MDUyXHU2MzA3XHU1NDExXHU1M0QxXHU1RTAzXHU2RTkwKHJlZ2lzdHJ5Lm5wbWpzLm9yZyksXHU1NkZEXHU1MTg1XHU3RjUxXHU3RURDXHJcbiAqIFx1NEUwRFx1NTNFRlx1OEZCRVx1NjVGNlx1NjMwOSByZWdpc3RyeSBcdTUyMTdcdTg4NjhcdTY1MzlcdTUxOTkgaG9zdChcdThERUZcdTVGODRcdTRFMERcdTUzRDggXHUyMDE0XHUyMDE0IG5wbW1pcnJvciBcdTRFMEUgbnBtanMgXHU1NDBDXHU2Nzg0KVx1MzAwMlxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHRhcmJhbGxNaXJyb3JzKHRhcmJhbGw6IHN0cmluZywgcmVnaXN0cmllczogc3RyaW5nW10pOiBzdHJpbmdbXSB7XHJcbiAgY29uc3QgbSA9IFJFR0lTVFJZX0hPU1RTLmV4ZWModGFyYmFsbCk7XHJcbiAgY29uc3QgcGF0aCA9IG0/LlsyXSA/PyAnJztcclxuICBjb25zdCBvdXQgPSBbdGFyYmFsbF07XHJcbiAgZm9yIChjb25zdCByZWcgb2YgcmVnaXN0cmllcykge1xyXG4gICAgY29uc3QgYmFzZSA9IHJlZy5yZXBsYWNlKC9cXC8rJC8sICcnKTtcclxuICAgIGlmIChiYXNlID09PSBtPy5bMV0pIGNvbnRpbnVlO1xyXG4gICAgY29uc3QgdSA9IGAke2Jhc2V9LyR7cGF0aH1gO1xyXG4gICAgaWYgKCFvdXQuaW5jbHVkZXModSkpIG91dC5wdXNoKHUpO1xyXG4gIH1cclxuICByZXR1cm4gb3V0O1xyXG59XHJcblxyXG4vKiogXHU1MzA1XHU1NzI4IG5vZGVfbW9kdWxlcyBcdTRFMEJcdTc2ODRcdTc2RUVcdTY4MDdcdTc2RUVcdTVGNTUoc2NvcGVkIFx1NTMwNVx1NEZERFx1NjMwMSBAc2NvcGUvbmFtZSBcdTRFMjRcdTdFQTcpXHUzMDAyICovXHJcbmV4cG9ydCBmdW5jdGlvbiBtb2R1bGVEaXIocHJlZml4OiBzdHJpbmcsIG5hbWU6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgY29uc3QgcGFydHMgPSBuYW1lLnNwbGl0KCcvJykuZmlsdGVyKChwKSA9PiBwICE9PSAnJyAmJiBwICE9PSAnLicpO1xyXG4gIGlmIChuYW1lLnN0YXJ0c1dpdGgoJ0AnKSAmJiBwYXJ0cy5sZW5ndGggIT09IDIpIHRocm93IG5ldyBFcnJvcihgaW52YWxpZCBwYWNrYWdlIG5hbWU6ICR7bmFtZX1gKTtcclxuICBpZiAoIW5hbWUuc3RhcnRzV2l0aCgnQCcpICYmIHBhcnRzLmxlbmd0aCAhPT0gMSkgdGhyb3cgbmV3IEVycm9yKGBpbnZhbGlkIHBhY2thZ2UgbmFtZTogJHtuYW1lfWApO1xyXG4gIHJldHVybiBbLi4ucGFydHNdLnJlZHVjZSgoZGlyLCBwKSA9PiBgJHtkaXJ9XFxcXCR7cH1gLCBgJHtwcmVmaXh9XFxcXG5vZGVfbW9kdWxlc2ApO1xyXG59XHJcblxyXG4vKiAtLS0tIGludGVncml0eSAtLS0tICovXHJcblxyXG4vKiogbnBtIGRpc3QuaW50ZWdyaXR5KCdzaGE1MTItYmFzZTY0JykgXHU2ODIxXHU5QThDO1x1NEUwRFx1NTMzOVx1OTE0RFx1OEZENFx1NTZERSBmYWxzZShcdTY3MkFcdTc3RTVcdTdCOTdcdTZDRDVcdThGRDRcdTU2REUgdHJ1ZSBcdTY1M0VcdTg4NEMpXHUzMDAyICovXHJcbmV4cG9ydCBmdW5jdGlvbiBpbnRlZ3JpdHlPayhkYXRhOiBCdWZmZXIsIGludGVncml0eT86IHN0cmluZyk6IGJvb2xlYW4ge1xyXG4gIGlmIChpbnRlZ3JpdHkgPT09IHVuZGVmaW5lZCB8fCBpbnRlZ3JpdHkgPT09ICcnKSByZXR1cm4gdHJ1ZTtcclxuICBjb25zdCBtID0gL15zaGE1MTItKFtBLVphLXowLTkrLz1dKykkLy5leGVjKGludGVncml0eS50cmltKCkpO1xyXG4gIGlmIChtID09PSBudWxsKSByZXR1cm4gdHJ1ZTtcclxuICByZXR1cm4gY3JlYXRlSGFzaCgnc2hhNTEyJykudXBkYXRlKGRhdGEpLmRpZ2VzdCgnYmFzZTY0JykgPT09IG1bMV07XHJcbn1cclxuXHJcbi8qKiBcdTRFQkFcdTdDN0JcdTUzRUZcdThCRkJcdTVCNTdcdTgyODIoXHU1Qjg5XHU4OEM1XHU4RkRCXHU1RUE2XHU2NTg3XHU2ODQ4XHU3NTI4KVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gYnl0ZXNMYWJlbChuOiBudW1iZXIpOiBzdHJpbmcge1xyXG4gIGlmIChuIDwgMTAyNCkgcmV0dXJuIGAke259IEJgO1xyXG4gIGlmIChuIDwgMTAyNCAqIDEwMjQpIHJldHVybiBgJHsobiAvIDEwMjQpLnRvRml4ZWQoMCl9IEtCYDtcclxuICByZXR1cm4gYCR7KG4gLyAxMDI0IC8gMTAyNCkudG9GaXhlZCgxKX0gTUJgO1xyXG59XHJcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFjQSxTQUFTLE9BQUFBLE1BQUssZUFBZSxRQUFRLFNBQVMsU0FBUyxPQUFPLE1BQU0sY0FBYyxNQUFNLGFBQWEsbUJBQW1CO0FBQ3hILFNBQVMsUUFBQUMsT0FBTSxTQUFTLFVBQVUsWUFBWSxlQUFlO0FBQzdELFNBQVMsY0FBQUMsYUFBWSxnQkFBQUMsZUFBYyxvQkFBb0I7QUFDdkQsU0FBUyxhQUFBQyxZQUFXLGdCQUFnQjtBQUNwQyxTQUFTLFdBQUFDLFVBQVMseUJBQXlCO0FBQzNDLFNBQVMsY0FBYyxTQUFBQyxjQUFhO0FBQ3BDLFNBQVMsaUJBQUFDLHNCQUFxQjs7O0FDVjlCLFNBQVMsYUFBZ0M7QUFDekMsU0FBUyx1QkFBdUI7QUFDaEMsU0FBUyxtQkFBbUI7OztBQ0RyQixJQUFNLGNBQWM7QUFBQSxFQUN6QjtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQ0Y7QUFJTyxJQUFNLHVCQUF1Qjs7O0FDbEI3QixJQUFNLGNBQWM7QUFBQSxFQUN6QjtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVB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LEVBQUU7QUFDckYsSUFBQUEsS0FBSSxLQUFLLFdBQVcsSUFBSSxJQUFJLENBQUM7QUFBQSxFQUMvQjtBQUdBLEVBQUFBLEtBQUksR0FBRyxlQUFlLENBQUMsTUFBTTtBQUMzQixRQUFJLGVBQWUsUUFBUSxXQUFXLFVBQVUsV0FBVztBQUN6RCxRQUFFLGVBQWU7QUFDakIsZ0JBQVUsTUFBTTtBQUNoQixXQUFLLFdBQVcsS0FBSyxFQUFFLFFBQVEsTUFBTUEsS0FBSSxLQUFLLENBQUM7QUFBQSxJQUNqRDtBQUFBLEVBQ0YsQ0FBQztBQUNELEVBQUFBLEtBQUksR0FBRyxxQkFBcUIsTUFBTTtBQUNoQyxRQUFJLFFBQVEsYUFBYSxTQUFVLENBQUFBLEtBQUksS0FBSztBQUFBLEVBQzlDLENBQUM7QUFDSDtBQTkyQ1c7QUF5QkE7QUFPQTtBQWVBO0FBNEJBO0FBMEZBO0FBbUJBO0FBNEJBO0FBNERBO0FBVUE7QUFnQkE7QUFnQkE7QUFlQTtBQTJFQTtBQU9BO0FBUUE7QUFXQTtBQWtFQTtBQUtBO0FBaUJBO0FBS0E7QUFZQTtBQW9CQTtBQW9IQTtBQVlBO0FBV0E7IiwKICAibmFtZXMiOiBbImFwcCIsICJqb2luIiwgImV4aXN0c1N5bmMiLCAicmVhbHBhdGhTeW5jIiwgIndyaXRlRmlsZSIsICJob21lZGlyIiwgInNwYXduIiwgInBhdGhUb0ZpbGVVUkwiLCAicmVzb2x2ZSIsICJyYW5kb21VVUlEIiwgInJhbmRvbVVVSUQiLCAicmVzb2x2ZSIsICJhcHAiLCAibWtkaXIiLCAid3JpdGVGaWxlIiwgImpvaW4iLCAic2xlZXAiLCAic3Bhd24iLCAiam9pbiIsICJqb2luIiwgInJlc29sdmUiLCAic3Bhd24iLCAiam9pbiIsICJqb2luIiwgImFwcCIsICJwdXNoRXZlbnQiLCAibm90aWZ5RXZlbnQiLCAiZm9jdXNNYWluV2luZG93IiwgInNldHVwVHJheSIsICJhcHBseUNocm9tZSIsICJhcHBseVVwZGF0ZSIsICJzcGF3biIsICJidWlsZEFwcE1lbnUiLCAicG9wdXBNYWluTWVudSIsICJ3ZWJBdXRvc3RhcnRJbnN0YWxsZWQiLCAiZXhpc3RzU3luYyIsICJsYW5JcE9mIiwgImNsaUVudHJ5T2YiLCAicmVwb1Jvb3RPZiIsICJwa2dOYW1lQXQiLCAicnVuQ2xpIiwgImJyb2FkY2FzdEhvc3RTdGF0ZSIsICJwa2dWZXJzaW9uQXQiLCAiZW50cnlGcm9tQ2xpRGlyIiwgImRldGVjdEV4dGVybmFsUnVudGltZSIsICJyZWFscGF0aFN5bmMiLCAiaG9tZWRpciIsICJkZXRlY3RSZWFsRW50cnkiLCAiYnVuZGxlZFJ1bnRpbWVQYXRoIiwgImJ1bmRsZWRSdW50aW1lSW5mbyIsICJucG1PblBhdGgiLCAid2l6YXJkU3VwcHJlc3NlZCIsICJzZW5kZXJUcnVzdGVkIiwgImhvc3RDYWxsIiwgInJlZ2lzdGVySXBjIiwgIndyaXRlRmlsZSIsICJ3IiwgInBhdGhUb0ZpbGVVUkwiLCAiYXBwMiJdCn0K
