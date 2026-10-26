// apps/desktop/electron/main/index.ts
import { app as app2, BrowserWindow, dialog, ipcMain, session, shell, Tray, Notification, Menu, nativeImage, nativeTheme } from "electron";
import { join as join3, dirname, basename, isAbsolute, resolve } from "node:path";
import { existsSync as existsSync2, realpathSync as realpathSync2, readFileSync } from "node:fs";
import { writeFile as writeFile2, readFile } from "node:fs/promises";
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

// apps/desktop/electron/main/installer.ts
import { spawn as spawn2 } from "node:child_process";
import { existsSync, mkdirSync, rmSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as join2 } from "node:path";

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
  return join2(homedir(), ".hmharness-global");
}
function resolveInstalledEntry(target) {
  const nested = join2(target, "node_modules", "@hmharness", "cli", "node_modules", "@hmharness", "web", "dist", "desktop-host.js");
  const hoisted = join2(target, "node_modules", "@hmharness", "web", "dist", "desktop-host.js");
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
  const staging = join2(target, ".staging");
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
    const tgz = join2(staging, `${i}.tgz`);
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
    await extractTgz(join2(staging, `${i}.tgz`), staging, pkg);
    host.sendProgress({ phase: "extract", pct: Math.round((i + 1) / closure.length * 100), text: `\u89E3\u538B ${pkg.name}(${i + 1}/${closure.length})` });
  }
  rmSync(staging, { recursive: true, force: true });
  const entry = resolveInstalledEntry(target);
  if (entry === "") throw new Error("tgz \u5B89\u88C5\u5B8C\u6210\u4F46\u672A\u627E\u5230 desktop-host \u5165\u53E3");
  writeStamp(target, "tgz");
  finishInstall(host, entry, "tgz");
}
async function extractTgz(tgz, staging, pkg) {
  const exDir = join2(staging, `x-${pkg.name.replace(/[^\w.-]/g, "_")}`);
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
  renameSync(join2(exDir, "package"), dest);
  rmSync(exDir, { recursive: true, force: true });
}
function writeStamp(target, via) {
  try {
    writeFileSync(join2(target, "installed-by-hmh-desktop.json"), JSON.stringify({ via, at: (/* @__PURE__ */ new Date()).toISOString() }, null, 2), "utf8");
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
var preloadPath = join3(here, "../preload/index.cjs");
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
    const child = spawn3(`"${installerPath}" /S /D=${installDir}`, {
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
    const candidates = process.platform === "win32" ? [join3(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "hmharness-web-daemon.cmd")] : process.platform === "darwin" ? [join3(home, "Library", "LaunchAgents", "hmharness-web-daemon.plist")] : [join3(home, ".config", "systemd", "user", "hmharness-web-daemon.service")];
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
      const p = join3(repoRootOf2(runtimeEntry), "packages", "cli", "src", "main.ts");
      if (existsSync2(p)) return p;
    } catch {
    }
    let dir = dirname(runtimeEntry);
    for (let i = 0; i < 8; i++) {
      if (existsSync2(join3(dir, "dist", "main.js")) && pkgNameAt2(dir) === "@hmharness/cli") return join3(dir, "dist", "main.js");
      if (basename(dir) === "@hmharness" && existsSync2(join3(dir, "cli", "dist", "main.js"))) return join3(dir, "cli", "dist", "main.js");
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
      const v = JSON.parse(readFileSync(join3(dir, "package.json"), "utf8"));
      return typeof v.version === "string" ? v.version : "";
    } catch {
      return "";
    }
  }, pkgNameAt2 = function(dir) {
    try {
      const v = JSON.parse(readFileSync(join3(dir, "package.json"), "utf8"));
      return typeof v.name === "string" ? v.name : "";
    } catch {
      return "";
    }
  }, entryFromCliDir2 = function(cliDir) {
    const nested = join3(cliDir, "node_modules", "@hmharness", "web", "dist", "desktop-host.js");
    if (existsSync2(nested)) return nested;
    const hoisted = join3(dirname(cliDir), "web", "dist", "desktop-host.js");
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
          const linked = join3(binDir, "node_modules", "hmharness");
          if (existsSync2(linked)) whereRepos.add(realpathSync2(linked));
          const cli = join3(binDir, "node_modules", "@hmharness", "cli");
          if (existsSync2(cli)) whereClis.push(cli);
        } catch {
        }
      }
    } catch {
    }
    try {
      const out = execFileSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 6e3, windowsHide: true });
      const root = out.trim();
      const linked = join3(root, "hmharness");
      if (existsSync2(linked)) npmRepos.add(realpathSync2(linked));
      const cli = join3(root, "@hmharness", "cli");
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
      return { entry: wizardEntry, version: pkgVersionAt2(join3(installTarget(), "node_modules", "@hmharness", "cli")), source: "wizard-install" };
    }
    const repos = /* @__PURE__ */ new Set([...whereRepos, ...npmRepos]);
    const bases = ["C:\\", "D:\\", "E:\\", "F:\\", "G:\\", "H:\\", homedir2(), join3(homedir2(), "Developer")];
    for (const base of bases) {
      try {
        const p = resolve(base, "hmharness");
        if (existsSync2(p)) repos.add(p);
      } catch {
      }
    }
    for (const repo of repos) {
      const entry = join3(repo, "packages", "web", "src", "desktop-host.ts");
      if (existsSync2(entry) && existsSync2(join3(repo, "node_modules"))) {
        return { entry, version: pkgVersionAt2(repo), source: "source-repo" };
      }
    }
    return { entry: "", version: "", source: "" };
  }, detectRealEntry2 = function() {
    return detectExternalRuntime2().entry;
  }, repoRootOf2 = function(entry) {
    let dir = dirname(entry);
    for (let i = 0; i < 6; i++) {
      if (existsSync2(join3(dir, "package.json")) && existsSync2(join3(dir, "packages", "web"))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return dirname(entry);
  }, bundledRuntimePath2 = function(repoRoot) {
    return join3(app2.isPackaged ? process.resourcesPath : join3(repoRoot, "apps", "desktop", "resources"), "runtime", "runtime.cjs");
  }, bundledRuntimeInfo2 = function() {
    const repoRoot = join3(here, "..", "..", "..", "..");
    const p = bundledRuntimePath2(repoRoot);
    let version = "";
    try {
      const v = JSON.parse(readFileSync(join3(dirname(p), "package.json"), "utf8"));
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
    return isDev || process.env.HMH_DESKTOP_UIVERIFY === "1" || process.env.HMH_DESKTOP_SNAPSHOT !== void 0 || process.env.HMH_DESKTOP_RENDER_TEST === "1" || process.env.HMH_DESKTOP_DOMPROBE === "1" || process.env.HMH_DESKTOP_SECURITY_TEST === "1" || process.env.HMH_DESKTOP_FAKE === "1";
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
      const repoRoot = join3(here, "..", "..", "..", "..");
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
        app2.quit();
      })();
      return { ok: true };
    });
  };
  pushEvent = pushEvent2, focusMainWindow = focusMainWindow2, setupTray = setupTray2, notifyEvent = notifyEvent2, applyChrome = applyChrome2, applyUpdate = applyUpdate2, buildAppMenu = buildAppMenu2, popupMainMenu = popupMainMenu2, webAutostartInstalled = webAutostartInstalled2, lanIpOf = lanIpOf2, cliEntryOf = cliEntryOf2, runCli = runCli2, broadcastHostState = broadcastHostState2, pkgVersionAt = pkgVersionAt2, pkgNameAt = pkgNameAt2, entryFromCliDir = entryFromCliDir2, detectExternalRuntime = detectExternalRuntime2, detectRealEntry = detectRealEntry2, repoRootOf = repoRootOf2, bundledRuntimePath = bundledRuntimePath2, bundledRuntimeInfo = bundledRuntimeInfo2, npmOnPath = npmOnPath2, wizardSuppressed = wizardSuppressed2, senderTrusted = senderTrusted2, hostCall = hostCall2, registerIpc = registerIpc2;
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
      const dest = join3(app2.getPath("temp"), asset.name);
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
  const runtimeConfigFile = () => join3(app2.getPath("userData"), "runtime.json");
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
    await writeFile2(runtimeConfigFile(), JSON.stringify(cfg, null, 2), "utf8").catch(() => void 0);
  }
  async function loadRuntimeEntryOverride() {
    return (await loadRuntimeConfig()).entry;
  }
  async function saveRuntimeEntryOverride(entry) {
    await saveRuntimeConfig({ entry, demo: (await loadRuntimeConfig()).demo });
  }
  let runtimeEntry = "";
  let useBundledRuntime = false;
  const wizardFile = () => join3(app2.getPath("userData"), "wizard.json");
  async function loadWizardState() {
    try {
      const v = JSON.parse(await readFile(wizardFile(), "utf8"));
      return { done: v.done === true, choice: typeof v.choice === "string" ? v.choice : "" };
    } catch {
      return { done: false, choice: "" };
    }
  }
  async function saveWizardState(choice) {
    await writeFile2(wizardFile(), JSON.stringify({ done: true, choice }, null, 2), "utf8").catch(() => void 0);
  }
  async function startHost() {
    const repoRoot = join3(here, "..", "..", "..", "..");
    const packaged = app2.isPackaged;
    const cfg = await loadRuntimeConfig();
    const forceFake = process.env.HMH_DESKTOP_FAKE === "1" || cfg.demo;
    const forceBundled = process.env.HMH_DESKTOP_BUNDLED === "1";
    const override = cfg.entry;
    const adjacent = join3(repoRoot, "..", "hmharness", "packages", "web", "src", "desktop-host.ts");
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
        args: [join3(process.resourcesPath, "fake-host.cjs")],
        env: { ELECTRON_RUN_AS_NODE: "1" }
      };
    } else {
      spec = {
        command: process.execPath,
        // 直接走包真实路径(node_modules 里的 workspace junction 会被 ESM
        // realpath 化,导致 fake-host 的 argv[1]/import.meta.url 匹配失效)
        args: ["--import", "tsx", join3(repoRoot, "packages", "host-adapter", "src", "fake-host.ts")],
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
    isDev && rendererDevUrl ? [rendererDevUrl] : [pathToFileURL2(join3(here, "..", "..", "dist-renderer", "index.html")).href]
  );
  const windowStateFile = () => join3(app2.getPath("userData"), "window-state.json");
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
      void win.loadFile(join3(here, "..", "..", "dist-renderer", "index.html"));
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vZWxlY3Ryb24vbWFpbi9pbmRleC50cyIsICIuLi8uLi8uLi8uLi9wYWNrYWdlcy9ob3N0LWFkYXB0ZXIvc3JjL3N1cGVydmlzb3IudHMiLCAiLi4vLi4vLi4vLi4vcGFja2FnZXMvY29udHJhY3RzL3NyYy9ldmVudC50cyIsICIuLi8uLi8uLi8uLi9wYWNrYWdlcy9jb250cmFjdHMvc3JjL2Vycm9yLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2NvbnRyYWN0cy9zcmMvZ3VhcmRzLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2hvc3QtYWRhcHRlci9zcmMvY2xpZW50LnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2hvc3QtYWRhcHRlci9zcmMvZmFrZS1ob3N0LnRzIiwgIi4uLy4uL2VsZWN0cm9uL21haW4vdWl2ZXJpZnkudHMiLCAiLi4vLi4vZWxlY3Ryb24vbWFpbi9pbnN0YWxsZXIudHMiLCAiLi4vLi4vLi4vLi4vcGFja2FnZXMvY2xpLWluc3RhbGxlci9zcmMvaW5kZXgudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogSE1IIERlc2t0b3AgXHUyMDE0IEVsZWN0cm9uIFx1NEUzQlx1OEZEQlx1N0EwQihBRFItMDAxLzAwMy8wMDQpXHUzMDAyXG4gKlxuICogXHU1Qjg5XHU1MTY4XHU0RTBEXHU1M0Q4XHU5MUNGKFx1NUYwMFx1NTNEMVx1OEJBMVx1NTIxMiBNMCBcdTUxRkFcdTUzRTNcdTk1RTggKyBFbGVjdHJvbiBcdTVCOThcdTY1QjlcdTVCODlcdTUxNjhcdTZFMDVcdTUzNTUpOlxuICogIC0gcmVuZGVyZXI6Y29udGV4dElzb2xhdGlvbiArIHNhbmRib3ggKyBcdTc5ODEgbm9kZUludGVncmF0aW9uLFx1NEUyNVx1NjgzQyBDU1A7XG4gKiAgLSBcdTVCRkNcdTgyMkEvXHU2NUIwXHU3QTk3XHU1M0UzXHU0RTAwXHU1RjhCXHU2MkQyXHU3RUREKFx1NTNFQVx1NTJBMFx1OEY3RFx1NjIxMVx1NEVFQ1x1ODFFQVx1NURGMVx1NzY4NCByZW5kZXJlcik7XG4gKiAgLSBcdTZCQ0ZcdTY3NjEgSVBDIFx1NjgyMVx1OUE4QyBzZW5kZXIgXHU3Njg0XHU5ODc2XHU1QzQyIGZyYW1lIFVSTCBcdTVDNUVcdTRFOEVcdTY3MkNcdTVFOTRcdTc1MjgsXHU5MDFBXHU5MDUzXHU3NjdEXHU1NDBEXHU1MzU1O1xuICogIC0gaG9zdCB0b2tlbiBcdTUzRUFcdTVCNThcdTU3MjhcdTRFOEVcdTY3MkNcdThGREJcdTdBMEJcdTRFMEVcdTVCNTBcdThGREJcdTdBMEIgZW52LFx1NjVFNVx1NUZEN1x1OEY5M1x1NTFGQVx1NTI0RFx1NTE0OFx1ODEzMVx1NjU0RjtcbiAqICAtIFx1NTM1NVx1NUI5RVx1NEY4Qlx1OTUwMTtcdTkwMDBcdTUxRkFcdTY1RjZcdTUzRUFcdTUwNUNcdTZCNjJcdTgxRUFcdTVERjEgc3Bhd24gXHU3Njg0IGhvc3QoXHU0RjE4XHU5NkM1XHUyMTkyXHU1MTVDXHU1RTk1IGtpbGwpXHUzMDAyXG4gKlxuICogXHU5NjM2XHU2QkI1RSgyMDI2LTEwLTEwKTptYWluIFx1NjMwMVx1NjcwOSBEZXNrdG9wSG9zdENsaWVudCxTU0UgXHU0RkUxXHU1QzAxXHU2RDQxKGV2ZW50OiBobWgpXG4gKiBcdTdFQ0YgNTBtcyBcdTYyNzlcdTkxQ0ZcdTYzQThcdTdFRDkgcmVuZGVyZXI7c2VuZFRhc2svYXBwcm92ZS9pbnRlcnJ1cHQvc2Vzc2lvbnMgXHU1MTY4XHU5MEU4XHU4RjZDXHU1M0QxXG4gKiBcdTdFRDkgaG9zdCBcdTIwMTRcdTIwMTQgZmFrZSBcdTRFMEVcdTc3MUZcdTVCOUUgaG1oYXJuZXNzIGRlc2t0b3AtaG9zdCBcdThENzBcdTU0MENcdTRFMDBcdTY3NjFcdTRFRTNcdTc4MDFcdThERUZcdTVGODRcdTMwMDJcbiAqL1xuaW1wb3J0IHsgYXBwLCBCcm93c2VyV2luZG93LCBkaWFsb2csIGlwY01haW4sIHNlc3Npb24sIHNoZWxsLCBUcmF5LCBOb3RpZmljYXRpb24sIE1lbnUsIG5hdGl2ZUltYWdlLCBuYXRpdmVUaGVtZSB9IGZyb20gJ2VsZWN0cm9uJztcbmltcG9ydCB7IGpvaW4sIGRpcm5hbWUsIGJhc2VuYW1lLCBpc0Fic29sdXRlLCByZXNvbHZlIH0gZnJvbSAnbm9kZTpwYXRoJztcbmltcG9ydCB7IGV4aXN0c1N5bmMsIHJlYWxwYXRoU3luYywgcmVhZEZpbGVTeW5jIH0gZnJvbSAnbm9kZTpmcyc7XG5pbXBvcnQgeyB3cml0ZUZpbGUsIHJlYWRGaWxlIH0gZnJvbSAnbm9kZTpmcy9wcm9taXNlcyc7XG5pbXBvcnQgeyBob21lZGlyLCBuZXR3b3JrSW50ZXJmYWNlcyB9IGZyb20gJ25vZGU6b3MnO1xuaW1wb3J0IHsgZXhlY0ZpbGVTeW5jLCBzcGF3biB9IGZyb20gJ25vZGU6Y2hpbGRfcHJvY2Vzcyc7XG5pbXBvcnQgeyBwYXRoVG9GaWxlVVJMIH0gZnJvbSAnbm9kZTp1cmwnO1xuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gJ25vZGU6Y3J5cHRvJztcbmltcG9ydCB7IERlc2t0b3BSdW50aW1lU3VwZXJ2aXNvciwgRGVza3RvcEhvc3RDbGllbnQsIGVudmVsb3BlRnJvbUZyYW1lLCB0eXBlIEhvc3RTdGF0ZSB9IGZyb20gJ0BobWgtZGVza3RvcC9ob3N0LWFkYXB0ZXInO1xuaW1wb3J0IHsgaXNFdmVudEVudmVsb3BlLCB0eXBlIEV2ZW50RW52ZWxvcGUgfSBmcm9tICdAaG1oLWRlc2t0b3AvY29udHJhY3RzJztcbmltcG9ydCB7IGF0dGFjaFVpVmVyaWZ5IH0gZnJvbSAnLi91aXZlcmlmeS50cyc7XG5pbXBvcnQgeyBpbnN0YWxsVGFyZ2V0LCByZXNvbHZlSW5zdGFsbGVkRW50cnksIHN0YXJ0Q2xpSW5zdGFsbCwgdHlwZSBJbnN0YWxsUHJvZ3Jlc3MgfSBmcm9tICcuL2luc3RhbGxlci50cyc7XG5cbmNvbnN0IGhlcmUgPSBpbXBvcnQubWV0YS5kaXJuYW1lID8/ICcuJztcbmNvbnN0IGlzRGV2ID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfREVWID09PSAnMSc7XG5jb25zdCByZW5kZXJlckRldlVybCA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1JFTkRFUkVSX1VSTCA/PyAnJztcbmNvbnN0IHByZWxvYWRQYXRoID0gam9pbihoZXJlLCAnLi4vcHJlbG9hZC9pbmRleC5janMnKTtcblxuLyogLS0tLSBcdTY1RTVcdTVGRDdcdTgxMzFcdTY1NEY6dG9rZW4vYXV0aG9yaXphdGlvbiBcdTZDMzhcdTRFMERcdThGREJcdTYzQTdcdTUyMzZcdTUzRjAgLS0tLSAqL1xuY29uc3Qgc2VjcmV0czogc3RyaW5nW10gPSBbXTtcbmZ1bmN0aW9uIHJlZGFjdChzOiBzdHJpbmcpOiBzdHJpbmcge1xuICBsZXQgb3V0ID0gcztcbiAgZm9yIChjb25zdCBzZWMgb2Ygc2VjcmV0cykge1xuICAgIGlmIChzZWMubGVuZ3RoID49IDgpIG91dCA9IG91dC5zcGxpdChzZWMpLmpvaW4oJ1tyZWRhY3RlZF0nKTtcbiAgfVxuICByZXR1cm4gb3V0O1xufVxuZnVuY3Rpb24gbG9nSW5mbyh0YWc6IHN0cmluZywgbXNnOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc29sZS5sb2coYFtobWgtZGVza3RvcDoke3RhZ31dICR7cmVkYWN0KG1zZyl9YCk7XG59XG5cbi8qIC0tLS0gXHU1MzU1XHU1QjlFXHU0RjhCIC0tLS0gKi9cbmlmICghYXBwLnJlcXVlc3RTaW5nbGVJbnN0YW5jZUxvY2soKSkge1xuICBhcHAucXVpdCgpO1xufSBlbHNlIHtcbiAgYXBwLm9uKCdzZWNvbmQtaW5zdGFuY2UnLCAoKSA9PiB7XG4gICAgY29uc3Qgd2luID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKClbMF07XG4gICAgaWYgKHdpbikge1xuICAgICAgaWYgKHdpbi5pc01pbmltaXplZCgpKSB3aW4ucmVzdG9yZSgpO1xuICAgICAgd2luLmZvY3VzKCk7XG4gICAgfVxuICB9KTtcblxuICAvKiAtLS0tIGhvc3QgXHU3NkQxXHU3QkExICsgXHU2ODY1XHU1QkEyXHU2MjM3XHU3QUVGIC0tLS0gKi9cbiAgaW50ZXJmYWNlIEJyaWRnZVNuYXBzaG90IHtcbiAgICBob3N0U3RhdGU6IEhvc3RTdGF0ZTtcbiAgICBob3N0UG9ydDogbnVtYmVyIHwgbnVsbDtcbiAgICBob3N0VmVyc2lvbjogc3RyaW5nIHwgbnVsbDtcbiAgICBsYXN0RXJyb3I6IHN0cmluZyB8IG51bGw7XG4gICAgbW9kZTogJ2Zha2UnIHwgJ3JlYWwnO1xuICAgIHJ1bnRpbWVFbnRyeTogc3RyaW5nIHwgbnVsbDtcbiAgfVxuICBsZXQgc3VwZXJ2aXNvcjogRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yIHwgbnVsbCA9IG51bGw7XG4gIGxldCBjbGllbnQ6IERlc2t0b3BIb3N0Q2xpZW50IHwgbnVsbCA9IG51bGw7XG4gIGxldCBicmlkZ2U6IEJyaWRnZVNuYXBzaG90ID0geyBob3N0U3RhdGU6ICdzdG9wcGVkJywgaG9zdFBvcnQ6IG51bGwsIGhvc3RWZXJzaW9uOiBudWxsLCBsYXN0RXJyb3I6IG51bGwsIG1vZGU6ICdmYWtlJywgcnVudGltZUVudHJ5OiBudWxsIH07XG4gIC8qKiBcdTRFOEJcdTRFRjZcdTYyNzlcdTkxQ0ZcdTdGMTNcdTUxQjI6XHU5QUQ4XHU5ODkxIFNTRSBcdTRFMERcdTkwMTBcdTY3NjFcdThGQzcgSVBDLDUwbXMgXHU2Mjc5XHU5MUNGIGZsdXNoKFx1NkUzMlx1NjdEM1x1NEUwRFx1NTM2MSlcdTMwMDIgKi9cbiAgbGV0IGV2ZW50QnVmZmVyOiBFdmVudEVudmVsb3BlW10gPSBbXTtcbiAgbGV0IGZsdXNoVGltZXI6IE5vZGVKUy5UaW1lb3V0IHwgbnVsbCA9IG51bGw7XG4gIGxldCBzc2VBYm9ydDogQWJvcnRDb250cm9sbGVyIHwgbnVsbCA9IG51bGw7XG4gIGxldCBsYXN0RXZlbnRJZCA9ICcnO1xuICAvKiogXHU2NzJBXHU3N0U1L1x1NzU3OFx1NUY2Mlx1NEZFMVx1NUMwMVx1OEJBMVx1NjU3MChTQ0hFTUFfTUlTTUFUQ0ggXHU5NzYyXHU1NDExXHU4QkNBXHU2NUFELFx1NEUwRFx1NUQyOSlcdTMwMDIgKi9cbiAgbGV0IGRyb3BwZWRGcmFtZXMgPSAwO1xuXG4gIGZ1bmN0aW9uIHB1c2hFdmVudChlbnY6IEV2ZW50RW52ZWxvcGUpOiB2b2lkIHtcbiAgICBldmVudEJ1ZmZlci5wdXNoKGVudik7XG4gICAgaWYgKGV2ZW50QnVmZmVyLmxlbmd0aCA+IDJfMDAwKSBldmVudEJ1ZmZlci5zcGxpY2UoMCwgZXZlbnRCdWZmZXIubGVuZ3RoIC0gMl8wMDApO1xuICAgIGlmIChmbHVzaFRpbWVyID09PSBudWxsKSB7XG4gICAgICBmbHVzaFRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgIGZsdXNoVGltZXIgPSBudWxsO1xuICAgICAgICBjb25zdCBiYXRjaCA9IGV2ZW50QnVmZmVyO1xuICAgICAgICBldmVudEJ1ZmZlciA9IFtdO1xuICAgICAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcbiAgICAgICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCdicmlkZ2U6ZXZlbnQtYmF0Y2gnLCBiYXRjaCk7XG4gICAgICAgIH1cbiAgICAgIH0sIDUwKTtcbiAgICB9XG4gICAgbm90aWZ5RXZlbnQoZW52KTtcbiAgfVxuXG4gIC8qIC0tLS0gXHU3Q0ZCXHU3RURGXHU2MjU4XHU3NkQ4ICsgXHU5MDFBXHU3N0U1KDAzIFx1NTNGNyBcdTAwQTdcdTRFMDA6XHU2ODRDXHU5NzYyXHU0RUE3XHU1NEMxXHU5NzAwXHU4OTgxXHU3Q0ZCXHU3RURGXHU2MjU4XHU3NkQ4XHUzMDAxXHU5MDFBXHU3N0U1KSAtLS0tXG4gICAgIFx1NUJBMVx1NjI3OVx1N0I0OVx1NUY4NVx1NUZDNVx1OTg3Qlx1NjI1M1x1NjI3MChcdTc1MjhcdTYyMzdcdTVGQzVcdTk4N0JcdTUxQjNcdTdCNTYpO1x1NUI4Q1x1NjIxMC9cdTU5MzFcdThEMjVcdTRFQzVcdTU3MjhcdTdBOTdcdTUzRTNcdTU5MzFcdTcxMjZcdTY1RjZcdTYzRDBcdTkxOTJcdTMwMDIgKi9cbiAgY29uc3QgVFJBWV9JQ09OX0JBU0U2NCA9ICdpVkJPUncwS0dnb0FBQUFOU1VoRVVnQUFBQkFBQUFBUUNBWUFBQUFmOC85aEFBQUFSMGxFUVZSNG5HTmdRQVBTc29yLzhXRjA5VVJyeEdzUXFab3hESUVKNkRkK0IyTjBoYmpFTVd3bjFRQ3dJWVBUQUZ5WWZnWU1mQmlRWkFERkNZa3FTWm5pekVSSmRnWUFsTDVyc0RjMmFUY0FBQUFBU1VWT1JLNUNZSUk9JztcbiAgbGV0IHRyYXk6IFRyYXkgfCBudWxsID0gbnVsbDtcbiAgY29uc3Qgc2VuZE1lbnVBY3Rpb24gPSAoYTogc3RyaW5nKTogdm9pZCA9PiB7XG4gICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XG4gICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCdtZW51OmFjdGlvbicsIGEpO1xuICAgIH1cbiAgfTtcbiAgZnVuY3Rpb24gZm9jdXNNYWluV2luZG93KCk6IHZvaWQge1xuICAgIGNvbnN0IHdpbiA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmZpbmQoKHcpID0+ICF3LmlzRGVzdHJveWVkKCkpO1xuICAgIGlmICh3aW4gPT09IHVuZGVmaW5lZCkgcmV0dXJuO1xuICAgIGlmICh3aW4uaXNNaW5pbWl6ZWQoKSkgd2luLnJlc3RvcmUoKTtcbiAgICB3aW4uc2hvdygpO1xuICAgIHdpbi5mb2N1cygpO1xuICB9XG4gIGZ1bmN0aW9uIHNldHVwVHJheSgpOiB2b2lkIHtcbiAgICBpZiAodHJheSAhPT0gbnVsbCkgcmV0dXJuO1xuICAgIGNvbnN0IGljb24gPSBuYXRpdmVJbWFnZS5jcmVhdGVGcm9tRGF0YVVSTChgZGF0YTppbWFnZS9wbmc7YmFzZTY0LCR7VFJBWV9JQ09OX0JBU0U2NH1gKTtcbiAgICB0cmF5ID0gbmV3IFRyYXkoaWNvbik7XG4gICAgdHJheS5zZXRUb29sVGlwKCdITUggRGVza3RvcCcpO1xuICAgIHRyYXkub24oJ2NsaWNrJywgZm9jdXNNYWluV2luZG93KTtcbiAgICB0cmF5LnNldENvbnRleHRNZW51KE1lbnUuYnVpbGRGcm9tVGVtcGxhdGUoW1xuICAgICAgeyBsYWJlbDogJ1x1NjVCMFx1NUVGQVx1NEYxQVx1OEJERCcsIGNsaWNrOiAoKTogdm9pZCA9PiBzZW5kTWVudUFjdGlvbignbmV3LXNlc3Npb24nKSB9LFxuICAgICAgeyBsYWJlbDogJ1x1NjYzRVx1NzkzQVx1NEUzQlx1N0E5N1x1NTNFMycsIGNsaWNrOiBmb2N1c01haW5XaW5kb3cgfSxcbiAgICAgIHsgbGFiZWw6ICdcdTYyNEJcdTY3M0FcdThGRENcdTdBMEJcdTYzQTdcdTUyMzYnLCBjbGljazogKCk6IHZvaWQgPT4gc2VuZE1lbnVBY3Rpb24oJ29wZW4tcmVtb3RlJykgfSxcbiAgICAgIHsgbGFiZWw6ICdcdThCQkVcdTdGNkUnLCBjbGljazogKCk6IHZvaWQgPT4gc2VuZE1lbnVBY3Rpb24oJ29wZW4tc2V0dGluZ3MnKSB9LFxuICAgICAgeyB0eXBlOiAnc2VwYXJhdG9yJyB9LFxuICAgICAgeyBsYWJlbDogJ1x1OTAwMFx1NTFGQScsIGNsaWNrOiAoKTogdm9pZCA9PiB7IGFwcC5xdWl0KCk7IH0gfSxcbiAgICBdKSk7XG4gIH1cbiAgZnVuY3Rpb24gbm90aWZ5RXZlbnQoZW52OiBFdmVudEVudmVsb3BlKTogdm9pZCB7XG4gICAgLy8gXHU5QThDXHU2NTM2L1x1NjIyQVx1NTZGRS9cdTZFMzJcdTY3RDNcdTYzQTJcdTk0ODhcdTZBMjFcdTVGMEZcdTk3NTlcdTlFRDgoXHU0RTBEXHU1RjgwXHU3NTI4XHU2MjM3XHU2ODRDXHU5NzYyXHU1RjM5XHU2RDRCXHU4QkQ1XHU5MDFBXHU3N0U1KVxuICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWSA9PT0gJzEnIHx8IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NOQVBTSE9UICE9PSB1bmRlZmluZWQgfHwgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfUkVOREVSX1RFU1QgPT09ICcxJykgcmV0dXJuO1xuICAgIGlmICghTm90aWZpY2F0aW9uLmlzU3VwcG9ydGVkKCkpIHJldHVybjtcbiAgICBjb25zdCB3aW4gPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5maW5kKCh3KSA9PiAhdy5pc0Rlc3Ryb3llZCgpKTtcbiAgICBjb25zdCBmb2N1c2VkID0gd2luPy5pc0ZvY3VzZWQoKSA/PyBmYWxzZTtcbiAgICBjb25zdCBtayA9ICh0aXRsZTogc3RyaW5nLCBib2R5OiBzdHJpbmcpOiB2b2lkID0+IHtcbiAgICAgIGNvbnN0IG4gPSBuZXcgTm90aWZpY2F0aW9uKHsgdGl0bGUsIGJvZHksIGljb246IG5hdGl2ZUltYWdlLmNyZWF0ZUZyb21EYXRhVVJMKGBkYXRhOmltYWdlL3BuZztiYXNlNjQsJHtUUkFZX0lDT05fQkFTRTY0fWApIH0pO1xuICAgICAgbi5vbignY2xpY2snLCBmb2N1c01haW5XaW5kb3cpO1xuICAgICAgbi5zaG93KCk7XG4gICAgfTtcbiAgICBpZiAoZW52LmtpbmQgPT09ICdhcHByb3ZhbC5yZXF1aXJlZCcpIHtcbiAgICAgIGNvbnN0IHAgPSBlbnYucGF5bG9hZCBhcyB7IHRvb2w/OiBzdHJpbmcgfTtcbiAgICAgIG1rKCdITUggXHU5NzAwXHU4OTgxXHU1QkExXHU2Mjc5JywgYCR7U3RyaW5nKHAudG9vbCA/PyAnXHU2NENEXHU0RjVDJyl9IFx1N0I0OVx1NUY4NVx1NEY2MFx1NzY4NFx1NjI3OVx1NTFDNmApO1xuICAgIH0gZWxzZSBpZiAoZW52LmtpbmQgPT09ICdydW4uY29tcGxldGVkJyAmJiAhZm9jdXNlZCkge1xuICAgICAgbWsoJ0hNSCBcdTRFRkJcdTUyQTFcdTVCOENcdTYyMTAnLCBgXHU0RjFBXHU4QkREICR7ZW52LnNlc3Npb25JZH0gXHU3Njg0XHU0RUZCXHU1MkExXHU1REYyXHU1QjhDXHU2MjEwYCk7XG4gICAgfSBlbHNlIGlmIChlbnYua2luZCA9PT0gJ3J1bi5mYWlsZWQnICYmICFmb2N1c2VkKSB7XG4gICAgICBtaygnSE1IIFx1NEVGQlx1NTJBMVx1NTkzMVx1OEQyNScsIGBcdTRGMUFcdThCREQgJHtlbnYuc2Vzc2lvbklkfSBcdTc2ODRcdTRFRkJcdTUyQTFcdTU5MzFcdThEMjUsXHU3MEI5XHU1MUZCXHU2N0U1XHU3NzBCYCk7XG4gICAgfVxuICB9XG5cbiAgLyogLS0tLSBcdTgxRUFcdTVCOUFcdTRFNDlcdTY4MDdcdTk4OThcdTY4MEYoMjAyNi0xMC0xMSBcdTc1MjhcdTYyMzdcdTUzQ0RcdTk5ODg6XHU0RUFFXHU4MjcyXHU2QTIxXHU1RjBGXHU5ODc2XHU5MEU4XHU5RUQxXHU2NzYxPVx1NTM5Rlx1NzUxRlx1ODNEQ1x1NTM1NVx1NjgwRlxuICAgICBcdTRFMERcdThEREZcdTRFM0JcdTk4OTg7XHU4M0RDXHU1MzU1XHU0RTBFXHU4QkJFXHU3RjZFXHU5MUNEXHU1OTBEKSAtLS0tIFx1NjVCOVx1Njg0ODpcdTk2OTBcdTg1Q0ZcdTVGMEZcdTY4MDdcdTk4OThcdTY4MEYgKyB0aXRsZUJhck92ZXJsYXlcbiAgICAgKFx1OTg5Q1x1ODI3Mlx1OTY4Rlx1NEUzQlx1OTg5OCksXHU4M0RDXHU1MzU1XHU2ODBGIGF1dG9IaWRlKEFsdCBcdTU0N0NcdTUxRkEpXHU0RTE0XHU3Q0JFXHU3QjgwXHU0RTNBXHU3Q0ZCXHU3RURGXHU3RUE3XHU4MEZEXHU1MjlCO1xuICAgICBcdTVFMzhcdTc1MjhcdTUyQThcdTRGNUNcdThENzAgcmVuZGVyZXIgXHU2ODA3XHU5ODk4XHU2ODBGIFx1MjYzMCBcdTRFM0JcdTgzRENcdTUzNTUoXHU1NTJGXHU0RTAwXHU1MTY1XHU1M0UzKVx1MzAwMiAqL1xuICAvLyB2NCBEU0ggXHU4QkJFXHU4QkExXHU4QkVEXHU4QTAwOm92ZXJsYXkgXHU4MjcyXHU4RERGXHU5NjhGIHRpdGxlYmFyIFx1NzY4NCBiZy1sYXllci0xKFx1NkQ0NSAjZmZmL1x1NkRGMSAjMTYxODFkKVxuICBjb25zdCBjaHJvbWVGb3IgPSAoZGFyazogYm9vbGVhbik6IHsgY29sb3I6IHN0cmluZzsgc3ltYm9sQ29sb3I6IHN0cmluZyB9ID0+XG4gICAgZGFyayA/IHsgY29sb3I6ICcjMTYxODFkJywgc3ltYm9sQ29sb3I6ICcjZjVmNmY4JyB9IDogeyBjb2xvcjogJyNmZmZmZmYnLCBzeW1ib2xDb2xvcjogJyMwZjExMTUnIH07XG4gIGZ1bmN0aW9uIGFwcGx5Q2hyb21lKGRhcms6IGJvb2xlYW4pOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcbiAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB7XG4gICAgICAgIHRyeSB7IHcuc2V0VGl0bGVCYXJPdmVybGF5KGNocm9tZUZvcihkYXJrKSk7IH0gY2F0Y2ggeyAvKiBcdTRFQzUgV2luZG93cyBcdTY1MkZcdTYzMDEgKi8gfVxuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8qIC0tLS0gXHU1RTk0XHU3NTI4XHU1MTg1XHU2NkY0XHU2NUIwKDIwMjYtMTAtMjY6XHU4MUVBXHU3ODE0XHU4RjdCXHU5MUNGXHU2NkY0XHU2NUIwXHU1NjY4LFx1OTZGNlx1NEY5RFx1OEQ1NjtHaXRIdWIgUmVsZWFzZXMgXHU5MDFBXHU5MDUzKVxuICAgICBcdTZENDFcdTdBMEI6XHUyNjMwXCJcdTY4QzBcdTY3RTVcdTY2RjRcdTY1QjBcIlx1MjE5MiBmZXRjaCBsYXRlc3QgcmVsZWFzZSB0YWcgXHUyMTkyIFx1NkJENFx1NzI0OFx1NjcyQyBcdTIxOTIgXHU1NDBFXHU1M0YwXHU0RTBCXHU4RjdEIFNldHVwXG4gICAgIGV4ZSBcdTUyMzBcdTRFMzRcdTY1RjZcdTc2RUVcdTVGNTUgXHUyMTkyIFx1ODNEQ1x1NTM1NVx1NTNEOFwiXHU5MUNEXHU1NDJGXHU1RTc2XHU1Qjg5XHU4OEM1XHU2NkY0XHU2NUIwXCJcdTIxOTIgXHU5MDAwXHU1MUZBXHU1RTk0XHU3NTI4XHU1NDBFIE5TSVMgL1MgL0Q9XHU1MzlGXHU3NkVFXHU1RjU1XG4gICAgIFx1OTc1OVx1OUVEOFx1ODk4Nlx1NzZENlx1NUI4OVx1ODhDNShcdTRFMEJcdTZCMjFcdTU0MkZcdTUyQThcdTUzNzNcdTY1QjBcdTcyNDgpXHUzMDAyXHU2NUUwXHU3QjdFXHU1NDBEXHU4QkMxXHU0RTY2XHU5NjM2XHU2QkI1XHU1M0VGXHU3NTI4O1x1NkI2M1x1NUYwRlx1N0I3RVx1NTQwRFx1NTQwRVx1NTNFRlx1NTJBMFx1NjgyMVx1OUE4Q1x1MzAwMiAqL1xuICBjb25zdCBVUERBVEVfUkVQTyA9ICdzd3NnYmwvaG1oLWRlc2t0b3AnO1xuICBpbnRlcmZhY2UgVXBkYXRlU3RhdGUgeyBjaGVja2luZzogYm9vbGVhbjsgY3VycmVudFZlcnNpb246IHN0cmluZzsgbGF0ZXN0OiBzdHJpbmcgfCBudWxsOyBub3Rlczogc3RyaW5nOyBkb3dubG9hZGVkOiBib29sZWFuOyBlcnJvcjogc3RyaW5nIH1cbiAgbGV0IHVwZGF0ZVN0YXRlOiBVcGRhdGVTdGF0ZSA9IHsgY2hlY2tpbmc6IGZhbHNlLCBjdXJyZW50VmVyc2lvbjogYXBwLmdldFZlcnNpb24oKSwgbGF0ZXN0OiBudWxsLCBub3RlczogJycsIGRvd25sb2FkZWQ6IGZhbHNlLCBlcnJvcjogJycgfTtcbiAgbGV0IGluc3RhbGxlclBhdGg6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBjb25zdCBidW1wVXBkYXRlID0gKHBhdGNoOiBQYXJ0aWFsPFVwZGF0ZVN0YXRlPik6IHZvaWQgPT4ge1xuICAgIHVwZGF0ZVN0YXRlID0geyAuLi51cGRhdGVTdGF0ZSwgLi4ucGF0Y2ggfTtcbiAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcbiAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ3VwZGF0ZTpzdGF0ZScsIHVwZGF0ZVN0YXRlKTtcbiAgICB9XG4gIH07XG4gIGNvbnN0IGNtcFZlcnNpb24gPSAoYTogc3RyaW5nLCBiOiBzdHJpbmcpOiBudW1iZXIgPT4ge1xuICAgIGNvbnN0IHBhID0gYS5yZXBsYWNlKC9edi8sICcnKS5zcGxpdCgnLicpLm1hcChOdW1iZXIpO1xuICAgIGNvbnN0IHBiID0gYi5yZXBsYWNlKC9edi8sICcnKS5zcGxpdCgnLicpLm1hcChOdW1iZXIpO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgMzsgaSsrKSB7IGlmICgocGFbaV0gPz8gMCkgIT09IChwYltpXSA/PyAwKSkgcmV0dXJuIChwYVtpXSA/PyAwKSA8IChwYltpXSA/PyAwKSA/IC0xIDogMTsgfVxuICAgIHJldHVybiAwO1xuICB9O1xuICBhc3luYyBmdW5jdGlvbiBjaGVja0ZvclVwZGF0ZXMoKTogUHJvbWlzZTxVcGRhdGVTdGF0ZT4ge1xuICAgIGlmICh1cGRhdGVTdGF0ZS5jaGVja2luZyB8fCB1cGRhdGVTdGF0ZS5kb3dubG9hZGVkKSByZXR1cm4gdXBkYXRlU3RhdGU7XG4gICAgYnVtcFVwZGF0ZSh7IGNoZWNraW5nOiB0cnVlLCBlcnJvcjogJycgfSk7XG4gICAgbG9nSW5mbygndXBkYXRlJywgYGNoZWNraW5nXHUyMDI2IChjdXJyZW50IHYke2FwcC5nZXRWZXJzaW9uKCl9KWApO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCByID0gYXdhaXQgZmV0Y2goYGh0dHBzOi8vYXBpLmdpdGh1Yi5jb20vcmVwb3MvJHtVUERBVEVfUkVQT30vcmVsZWFzZXMvbGF0ZXN0YCwge1xuICAgICAgICBoZWFkZXJzOiB7ICd1c2VyLWFnZW50JzogJ2htaC1kZXNrdG9wLXVwZGF0ZXInIH0sXG4gICAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCgxNV8wMDApLFxuICAgICAgfSk7XG4gICAgICBpZiAoIXIub2spIHRocm93IG5ldyBFcnJvcihgR2l0SHViIEFQSSAke3Iuc3RhdHVzfWApO1xuICAgICAgY29uc3QgcmVsID0gKGF3YWl0IHIuanNvbigpKSBhcyB7IHRhZ19uYW1lPzogc3RyaW5nOyBib2R5Pzogc3RyaW5nOyBhc3NldHM/OiBBcnJheTx7IG5hbWU6IHN0cmluZzsgYnJvd3Nlcl9kb3dubG9hZF91cmw6IHN0cmluZzsgc2l6ZTogbnVtYmVyIH0+IH07XG4gICAgICBjb25zdCB0YWcgPSBTdHJpbmcocmVsLnRhZ19uYW1lID8/ICcnKTtcbiAgICAgIGxvZ0luZm8oJ3VwZGF0ZScsIGBsYXRlc3Q9JHt0YWd9IGFzc2V0cz0keyhyZWwuYXNzZXRzID8/IFtdKS5sZW5ndGh9YCk7XG4gICAgICBidW1wVXBkYXRlKHsgY2hlY2tpbmc6IGZhbHNlLCBsYXRlc3Q6IHRhZywgbm90ZXM6IFN0cmluZyhyZWwuYm9keSA/PyAnJykuc2xpY2UoMCwgNjAwKSB9KTtcbiAgICAgIC8vIFx1NjcwOVx1NjVCMFx1NzI0OFx1NEUxNFx1NjcyQVx1NEUwQlx1OEY3RFx1OEZDNyBcdTIxOTIgXHU1NDBFXHU1M0YwXHU0RTBCXHU4RjdEXHU1Qjg5XHU4OEM1XHU1MzA1XG4gICAgICBpZiAodGFnICE9PSAnJyAmJiBjbXBWZXJzaW9uKGFwcC5nZXRWZXJzaW9uKCksIHRhZykgPCAwICYmICF1cGRhdGVTdGF0ZS5kb3dubG9hZGVkKSB7XG4gICAgICAgIHZvaWQgZG93bmxvYWRJbnN0YWxsZXIocmVsLmFzc2V0cyA/PyBbXSk7XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBsb2dJbmZvKCd1cGRhdGUnLCBgY2hlY2sgZmFpbGVkOiAke1N0cmluZyhlcnIpLnNsaWNlKDAsIDE0MCl9YCk7XG4gICAgICBidW1wVXBkYXRlKHsgY2hlY2tpbmc6IGZhbHNlLCBlcnJvcjogU3RyaW5nKGVycikuc2xpY2UoMCwgMTIwKSB9KTtcbiAgICB9XG4gICAgcmV0dXJuIHVwZGF0ZVN0YXRlO1xuICB9XG4gIGFzeW5jIGZ1bmN0aW9uIGRvd25sb2FkSW5zdGFsbGVyKGFzc2V0czogQXJyYXk8eyBuYW1lOiBzdHJpbmc7IGJyb3dzZXJfZG93bmxvYWRfdXJsOiBzdHJpbmc7IHNpemU6IG51bWJlciB9Pik6IFByb21pc2U8dm9pZD4ge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBhc3NldCA9IGFzc2V0cy5maW5kKChhKSA9PiAvXkhNSC1EZXNrdG9wLVNldHVwLS4qXFwuZXhlJC9pLnRlc3QoYS5uYW1lKSkgPz8gYXNzZXRzLmZpbmQoKGEpID0+IGEubmFtZS5lbmRzV2l0aCgnLmV4ZScpKTtcbiAgICAgIGlmIChhc3NldCA9PT0gdW5kZWZpbmVkKSB7IGJ1bXBVcGRhdGUoeyBlcnJvcjogJ3JlbGVhc2UgXHU2NUUwXHU1Qjg5XHU4OEM1XHU1MzA1XHU4RDQ0XHU0RUE3JyB9KTsgcmV0dXJuOyB9XG4gICAgICBjb25zdCBkZXN0ID0gam9pbihhcHAuZ2V0UGF0aCgndGVtcCcpLCBhc3NldC5uYW1lKTtcbiAgICAgIC8vIGdpdGh1Yi5jb20gXHU3NkY0XHU4RkRFXHU1NzI4XHU5MEU4XHU1MjA2XHU3RjUxXHU3RURDXHU4RDg1XHU2NUY2IFx1MjE5MiBcdTk1NUNcdTUwQ0ZcdTU2REVcdTkwMDBcdTk0RkUoXHU1QjlFXHU2RDRCIGdoZmFzdC9naC1wcm94eSBcdTUzRUZcdTc1MjgpXG4gICAgICBjb25zdCBtaXJyb3JzID0gW1xuICAgICAgICBhc3NldC5icm93c2VyX2Rvd25sb2FkX3VybCxcbiAgICAgICAgYGh0dHBzOi8vZ2hmYXN0LnRvcC8ke2Fzc2V0LmJyb3dzZXJfZG93bmxvYWRfdXJsfWAsXG4gICAgICAgIGBodHRwczovL2doLXByb3h5LmNvbS8ke2Fzc2V0LmJyb3dzZXJfZG93bmxvYWRfdXJsfWAsXG4gICAgICAgIGBodHRwczovL2docHJveHkuY24vJHthc3NldC5icm93c2VyX2Rvd25sb2FkX3VybH1gLFxuICAgICAgXTtcbiAgICAgIGxldCBidWY6IEJ1ZmZlciB8IG51bGwgPSBudWxsO1xuICAgICAgbGV0IGxhc3RFcnIgPSAnJztcbiAgICAgIGZvciAoY29uc3QgdSBvZiBtaXJyb3JzKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgbG9nSW5mbygndXBkYXRlJywgYHRyeWluZyAke25ldyBVUkwodSkuaG9zdH1cdTIwMjZgKTtcbiAgICAgICAgICBjb25zdCByID0gYXdhaXQgZmV0Y2godSwgeyBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoNjAwXzAwMCkgfSk7XG4gICAgICAgICAgaWYgKCFyLm9rKSB7IGxhc3RFcnIgPSBgSFRUUCAke3Iuc3RhdHVzfWA7IGxvZ0luZm8oJ3VwZGF0ZScsIGBcdTIxOTIgSFRUUCAke3Iuc3RhdHVzfWApOyBjb250aW51ZTsgfVxuICAgICAgICAgIGJ1ZiA9IEJ1ZmZlci5mcm9tKGF3YWl0IHIuYXJyYXlCdWZmZXIoKSk7XG4gICAgICAgICAgaWYgKGJ1Zi5sZW5ndGggPiAxXzAwMF8wMDApIHsgbG9nSW5mbygndXBkYXRlJywgYFx1MjE5MiBvayAke01hdGgucm91bmQoYnVmLmxlbmd0aCAvIDFlNil9TUJgKTsgYnJlYWs7IH1cbiAgICAgICAgICBsYXN0RXJyID0gJ1x1NTE4NVx1NUJCOVx1NUYwMlx1NUUzOCc7IGJ1ZiA9IG51bGw7XG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgIGNvbnN0IGUgPSBlcnIgYXMgeyBjYXVzZT86IHsgY29kZT86IHVua25vd24gfSB9O1xuICAgICAgICAgIGxhc3RFcnIgPSBTdHJpbmcoZS5jYXVzZT8uY29kZSA/PyBlcnIpLnNsaWNlKDAsIDYwKTtcbiAgICAgICAgICBsb2dJbmZvKCd1cGRhdGUnLCBgXHUyMTkyIGZhaWwgJHtsYXN0RXJyfWApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBpZiAoYnVmID09PSBudWxsKSB0aHJvdyBuZXcgRXJyb3IoYFx1NTE2OFx1OTBFOFx1NEUwQlx1OEY3RFx1OTAxQVx1OTA1M1x1NTkzMVx1OEQyNSgke2xhc3RFcnJ9KWApO1xuICAgICAgY29uc3QgeyB3cml0ZUZpbGU6IHdmIH0gPSBhd2FpdCBpbXBvcnQoJ25vZGU6ZnMvcHJvbWlzZXMnKTtcbiAgICAgIGF3YWl0IHdmKGRlc3QsIGJ1Zik7XG4gICAgICBpbnN0YWxsZXJQYXRoID0gZGVzdDtcbiAgICAgIGJ1bXBVcGRhdGUoeyBkb3dubG9hZGVkOiB0cnVlIH0pO1xuICAgICAgbG9nSW5mbygndXBkYXRlJywgYFx1NURGMlx1NEUwQlx1OEY3RCAke2Fzc2V0Lm5hbWV9KCR7TWF0aC5yb3VuZChidWYubGVuZ3RoIC8gMWU2KX1NQikgXHUyMTkyICR7ZGVzdH1gKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGJ1bXBVcGRhdGUoeyBlcnJvcjogYFx1NEUwQlx1OEY3RFx1NTkzMVx1OEQyNTogJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApfWAgfSk7XG4gICAgfVxuICB9XG4gIGZ1bmN0aW9uIGFwcGx5VXBkYXRlKCk6IHZvaWQge1xuICAgIGlmIChpbnN0YWxsZXJQYXRoID09PSBudWxsKSByZXR1cm47XG4gICAgLy8gXHU5MDAwXHU1MUZBXHU1RjUzXHU1MjREXHU1RTk0XHU3NTI4XHU1NDBFXHU3NTMxXHU1Qjg5XHU4OEM1XHU1NjY4XHU5NzU5XHU5RUQ4XHU4OTg2XHU3NkQ2XHU1Qjg5XHU4OEM1KFx1ODhDNVx1NTZERVx1NTM5Rlx1NzZFRVx1NUY1NSlcdTMwMDJOU0lTIGFzc2lzdGVkIFx1ODlDNFx1NTIxOTpcbiAgICAvLyAvUyBcdTRFMTQgL0Q9cGF0aCBcdTVGQzVcdTk4N0JcdTY3MDBcdTU0MEVcdTRFMDBcdTRFMkFcdTUzQzJcdTY1NzBcdTMwMDFcdTUwM0NcdTRFMERcdTUyQTBcdTVGMTVcdTUzRjcoXHU1NDJCXHU3QTdBXHU2ODNDXHU0RTVGXHU0RTBEXHU1MkEwKVx1MjAxNFx1MjAxNG5vZGUgc3Bhd25cbiAgICAvLyBcdTlFRDhcdThCQTRcdTRGMUFcdTdFRDlcdTU0MkJcdTdBN0FcdTY4M0NcdTUzQzJcdTY1NzBcdTUyQTBcdTVGMTVcdTUzRjdcdTVCRkNcdTgxRjQgTlNJUyBcdTg5RTNcdTY3OTBcdTk1MTlcdThERUZcdTVGODQoXHU1QjlFXHU2RDRCXHU4OEM1XHU1NzRGXHU3NkVFXHU1RjU1KSxcdTY1NDVcdTc1MjhcbiAgICAvLyB3aW5kb3dzVmVyYmF0aW1Bcmd1bWVudHMgXHU1MzlGXHU2ODM3XHU0RjIwXHU5MDEyXHUzMDAyXG4gICAgY29uc3QgaW5zdGFsbERpciA9IGRpcm5hbWUocHJvY2Vzcy5leGVjUGF0aCk7XG4gICAgY29uc3QgY2hpbGQgPSBzcGF3bihgXCIke2luc3RhbGxlclBhdGh9XCIgL1MgL0Q9JHtpbnN0YWxsRGlyfWAsIHtcbiAgICAgIGRldGFjaGVkOiB0cnVlLFxuICAgICAgc3RkaW86ICdpZ25vcmUnLFxuICAgICAgd2luZG93c0hpZGU6IHRydWUsXG4gICAgICBzaGVsbDogZmFsc2UsXG4gICAgICB3aW5kb3dzVmVyYmF0aW1Bcmd1bWVudHM6IHRydWUsXG4gICAgfSk7XG4gICAgY2hpbGQudW5yZWYoKTtcbiAgICBsb2dJbmZvKCd1cGRhdGUnLCBgYXBwbHk6ICR7aW5zdGFsbGVyUGF0aH0gXHUyMTkyICR7aW5zdGFsbERpcn1gKTtcbiAgICBhcHAuZXhpdCgwKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGJ1aWxkQXBwTWVudSgpOiB2b2lkIHtcbiAgICAvLyBcdTdDQkVcdTdCODA6XHU1M0VBXHU0RkREXHU3NTU5IFVJIFx1NkNBMVx1NjcwOVx1NzY4NFx1N0NGQlx1N0VERlx1N0VBN1x1ODBGRFx1NTI5QihcdTUyNkFcdThEMzRcdTY3N0YvXHU3QTk3XHU1M0UzKTtcdTUxNzZcdTRGNTlcdTU1MkZcdTRFMDBcdTUxNjVcdTUzRTNcdTU3MjggVUlcdTMwMDJcbiAgICBjb25zdCB0ZW1wbGF0ZTogQXJyYXk8RWxlY3Ryb24uTWVudUl0ZW1Db25zdHJ1Y3Rvck9wdGlvbnM+ID0gW1xuICAgICAge1xuICAgICAgICBsYWJlbDogJ1x1N0YxNlx1OEY5MScsXG4gICAgICAgIHN1Ym1lbnU6IFtcbiAgICAgICAgICB7IHJvbGU6ICd1bmRvJywgbGFiZWw6ICdcdTY0QTRcdTk1MDAnIH0sXG4gICAgICAgICAgeyByb2xlOiAncmVkbycsIGxhYmVsOiAnXHU5MUNEXHU1MDVBJyB9LFxuICAgICAgICAgIHsgdHlwZTogJ3NlcGFyYXRvcicgfSxcbiAgICAgICAgICB7IHJvbGU6ICdjdXQnLCBsYWJlbDogJ1x1NTI2QVx1NTIwNycgfSxcbiAgICAgICAgICB7IHJvbGU6ICdjb3B5JywgbGFiZWw6ICdcdTU5MERcdTUyMzYnIH0sXG4gICAgICAgICAgeyByb2xlOiAncGFzdGUnLCBsYWJlbDogJ1x1N0M5OFx1OEQzNCcgfSxcbiAgICAgICAgICB7IHJvbGU6ICdzZWxlY3RBbGwnLCBsYWJlbDogJ1x1NTE2OFx1OTAwOScgfSxcbiAgICAgICAgXSxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIGxhYmVsOiAnXHU3QTk3XHU1M0UzJyxcbiAgICAgICAgc3VibWVudTogW1xuICAgICAgICAgIHsgcm9sZTogJ21pbmltaXplJywgbGFiZWw6ICdcdTY3MDBcdTVDMEZcdTUzMTYnIH0sXG4gICAgICAgICAgeyByb2xlOiAnem9vbScsIGxhYmVsOiAnXHU3RjI5XHU2NTNFJyB9LFxuICAgICAgICAgIHsgdHlwZTogJ3NlcGFyYXRvcicgfSxcbiAgICAgICAgICB7IHJvbGU6ICdjbG9zZScsIGxhYmVsOiAnXHU1MTczXHU5NUVEJyB9LFxuICAgICAgICBdLFxuICAgICAgfSxcbiAgICBdO1xuICAgIE1lbnUuc2V0QXBwbGljYXRpb25NZW51KE1lbnUuYnVpbGRGcm9tVGVtcGxhdGUodGVtcGxhdGUpKTtcbiAgfVxuICAvKiogXHU2ODA3XHU5ODk4XHU2ODBGIFx1MjYzMCBcdTRFM0JcdTgzRENcdTUzNTUoXHU1RTM4XHU3NTI4XHU1MkE4XHU0RjVDXHU3Njg0XHU1NTJGXHU0RTAwXHU1MTY1XHU1M0UzO1x1ODlDNlx1NTZGRVx1NjAwMVx1N0VDRiBtZW51OmFjdGlvbiBcdThGNkNcdTUzRDEpXHUzMDAyICovXG4gIGZ1bmN0aW9uIHBvcHVwTWFpbk1lbnUoKTogdm9pZCB7XG4gICAgY29uc3Qgc2VuZCA9IChhOiBzdHJpbmcpOiB2b2lkID0+IHtcbiAgICAgIGZvciAoY29uc3QgdyBvZiBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKSkge1xuICAgICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCdtZW51OmFjdGlvbicsIGEpO1xuICAgICAgfVxuICAgIH07XG4gICAgY29uc3Qgd2luID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkuZmluZCgodykgPT4gIXcuaXNEZXN0cm95ZWQoKSk7XG4gICAgaWYgKHdpbiA9PT0gdW5kZWZpbmVkKSByZXR1cm47XG4gICAgTWVudS5idWlsZEZyb21UZW1wbGF0ZShbXG4gICAgICB7IGxhYmVsOiAnXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREJywgYWNjZWxlcmF0b3I6ICdDbWRPckN0cmwrTicsIGNsaWNrOiAoKTogdm9pZCA9PiBzZW5kKCduZXctc2Vzc2lvbicpIH0sXG4gICAgICB7IGxhYmVsOiAnXHU4QkJFXHU3RjZFJywgYWNjZWxlcmF0b3I6ICdDbWRPckN0cmwrU2hpZnQrUCcsIGNsaWNrOiAoKTogdm9pZCA9PiBzZW5kKCdvcGVuLXNldHRpbmdzJykgfSxcbiAgICAgIHsgbGFiZWw6ICdcdTVGRUJcdTYzNzdcdTk1MkUnLCBhY2NlbGVyYXRvcjogJ0NtZE9yQ3RybCsvJywgY2xpY2s6ICgpOiB2b2lkID0+IHNlbmQoJ3Nob3J0Y3V0cycpIH0sXG4gICAgICB7IHR5cGU6ICdzZXBhcmF0b3InIH0sXG4gICAgICB7IGxhYmVsOiAnXHU2MjRCXHU2NzNBXHU4RkRDXHU3QTBCXHU2M0E3XHU1MjM2JywgY2xpY2s6ICgpOiB2b2lkID0+IHNlbmQoJ29wZW4tcmVtb3RlJykgfSxcbiAgICAgIHsgdHlwZTogJ3NlcGFyYXRvcicgfSxcbiAgICAgIHtcbiAgICAgICAgbGFiZWw6IHVwZGF0ZVN0YXRlLmRvd25sb2FkZWQgPyBgXHU5MUNEXHU1NDJGXHU1RTc2XHU1Qjg5XHU4OEM1XHU2NkY0XHU2NUIwKHYke3VwZGF0ZVN0YXRlLmxhdGVzdCA/PyAnPyd9KWAgOiAnXHU2OEMwXHU2N0U1XHU2NkY0XHU2NUIwXHUyMDI2JyxcbiAgICAgICAgY2xpY2s6ICgpOiB2b2lkID0+IHtcbiAgICAgICAgICBpZiAodXBkYXRlU3RhdGUuZG93bmxvYWRlZCkgeyBhcHBseVVwZGF0ZSgpOyByZXR1cm47IH1cbiAgICAgICAgICB2b2lkIGNoZWNrRm9yVXBkYXRlcygpLnRoZW4oKHN0KSA9PiB7XG4gICAgICAgICAgICBjb25zdCBuZXdlciA9IHN0LmxhdGVzdCAhPT0gbnVsbCAmJiBjbXBWZXJzaW9uKHN0LmN1cnJlbnRWZXJzaW9uLCBzdC5sYXRlc3QpIDwgMDtcbiAgICAgICAgICAgIGNvbnN0IGRldGFpbCA9IG5ld2VyID8gYCR7c3Qubm90ZXN9XFxuXFxuXHU1Qjg5XHU4OEM1XHU1MzA1XHU2QjYzXHU1NzI4XHU1NDBFXHU1M0YwXHU0RTBCXHU4RjdELFx1NUI4Q1x1NjIxMFx1NTQwRSBcdTI2MzAgXHU4M0RDXHU1MzU1XHU0RjFBXHU1MUZBXHU3M0IwXCJcdTkxQ0RcdTU0MkZcdTVFNzZcdTVCODlcdTg4QzVcdTY2RjRcdTY1QjBcIlx1MzAwMmAgOiAnJztcbiAgICAgICAgICAgIHZvaWQgZGlhbG9nLnNob3dNZXNzYWdlQm94KHdpbiwge1xuICAgICAgICAgICAgICB0eXBlOiAnaW5mbycsXG4gICAgICAgICAgICAgIHRpdGxlOiAnXHU2OEMwXHU2N0U1XHU2NkY0XHU2NUIwJyxcbiAgICAgICAgICAgICAgbWVzc2FnZTogbmV3ZXJcbiAgICAgICAgICAgICAgICA/IGBcdTUzRDFcdTczQjBcdTY1QjBcdTcyNDhcdTY3MkMgdiR7c3QubGF0ZXN0fSFgXG4gICAgICAgICAgICAgICAgOiAoc3QuZXJyb3IgIT09ICcnID8gYFx1NjhDMFx1NjdFNVx1NTkzMVx1OEQyNToke3N0LmVycm9yfWAgOiBgXHU1REYyXHU2NjJGXHU2NzAwXHU2NUIwXHU3MjQ4XHU2NzJDKHYke3N0LmN1cnJlbnRWZXJzaW9ufSlgKSxcbiAgICAgICAgICAgICAgZGV0YWlsLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfSk7XG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBsYWJlbDogJ1x1NTE3M1x1NEU4RSBITUggRGVza3RvcCcsXG4gICAgICAgIGNsaWNrOiAoKTogdm9pZCA9PiB7XG4gICAgICAgICAgdm9pZCBkaWFsb2cuc2hvd01lc3NhZ2VCb3god2luLCB7XG4gICAgICAgICAgICB0eXBlOiAnaW5mbycsXG4gICAgICAgICAgICB0aXRsZTogJ1x1NTE3M1x1NEU4RSBITUggRGVza3RvcCcsXG4gICAgICAgICAgICBtZXNzYWdlOiAnSE1IIERlc2t0b3AnLFxuICAgICAgICAgICAgZGV0YWlsOiBgXHU2NzJDXHU1NzMwXHU0RjE4XHU1MTQ4XHU3Njg0IEhNSCBBZ2VudCBcdTU2RkVcdTVGNjJcdTVERTVcdTRGNUNcdTUzRjAgdiR7YXBwLmdldFZlcnNpb24oKX1cXG5ydW50aW1lOiBobWhhcm5lc3MgJHticmlkZ2UuaG9zdFZlcnNpb24gPz8gJyhcdTY3MkFcdThGREVcdTYzQTUpJ30ke3VzZUJ1bmRsZWRSdW50aW1lID8gJyhcdTUxODVcdTdGNkUpJyA6ICcnfVxcblx1NkEyMVx1NUYwRjogJHticmlkZ2UubW9kZSA9PT0gJ3JlYWwnID8gKHVzZUJ1bmRsZWRSdW50aW1lID8gJ1x1NzcxRlx1NUI5RSBobWhhcm5lc3MoXHU1MTg1XHU3RjZFIHJ1bnRpbWUpJyA6ICdcdTc3MUZcdTVCOUUgaG1oYXJuZXNzKFx1NTkxNlx1OTBFOFx1NUI4OVx1ODhDNSknKSA6ICdcdTZGMTRcdTc5M0EoXHU1MDQ3XHU2NTcwXHU2MzZFKSd9XFxuXFxuXHU0RTBFIENMSSAvIFRVSSAvIFx1N0Y1MVx1OTg3NVx1NzI0OFx1NTE3MVx1NEVBQlx1NTQwQ1x1NEUwMCBITUhfSE9NRVx1MzAwMmAsXG4gICAgICAgICAgfSk7XG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAgeyBsYWJlbDogJ1x1OTAwMFx1NTFGQScsIHJvbGU6ICdxdWl0JyB9LFxuICAgIF0pLnBvcHVwKHsgd2luZG93OiB3aW4gfSk7XG4gIH1cblxuICAvKiAtLS0tIFx1NjI0Qlx1NjczQVx1OEZEQ1x1N0EwQlx1NjNBN1x1NTIzNigwMyBcdTUzRjc6V2ViIDc3ODggXHU2NjJGXHU2RDRGXHU4OUM4XHU1NjY4L1x1OEZEQ1x1N0EwQi9cdTYyNEJcdTY3M0FcdTUxNjVcdTUzRTMsQURSLTAwNTpcbiAgICAgRGVza3RvcCBcdTRFMERcdTlFRDhcdThCQTRcdTYyNTNcdTVGMDAgTEFOIFx1MjAxNFx1MjAxNCBcdThGRDlcdTkxQ0NcdTY2MkZcdTc1MjhcdTYyMzdcdTY2M0VcdTVGMEZcdTU0MkZcdTUyQThcdTc2ODRcdTUxNjVcdTUzRTMpIC0tLS0gKi9cbiAgY29uc3QgV0VCX1BPUlQgPSA3Nzg4O1xuICBhc3luYyBmdW5jdGlvbiBwcm9iZVdlYlJlbW90ZSgpOiBQcm9taXNlPHsgdXA6IGJvb2xlYW47IHZlcnNpb246IHN0cmluZyB9PiB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHIgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke1dFQl9QT1JUfS9hcGkvc3RhdGVgLCB7IHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCgxNTAwKSB9KTtcbiAgICAgIGlmICghci5vaykgcmV0dXJuIHsgdXA6IGZhbHNlLCB2ZXJzaW9uOiAnJyB9O1xuICAgICAgY29uc3QgZCA9IChhd2FpdCByLmpzb24oKSkgYXMgeyBkYWVtb25WZXJzaW9uPzogc3RyaW5nIH07XG4gICAgICByZXR1cm4geyB1cDogdHJ1ZSwgdmVyc2lvbjogU3RyaW5nKGQuZGFlbW9uVmVyc2lvbiA/PyAnJykgfTtcbiAgICB9IGNhdGNoIHsgcmV0dXJuIHsgdXA6IGZhbHNlLCB2ZXJzaW9uOiAnJyB9OyB9XG4gIH1cbiAgLyoqIFx1NUYwMFx1NjczQVx1ODFFQVx1NTQyRlx1NjYyRlx1NTQyNlx1NURGMlx1ODhDNShydW50aW1lIHdlYi1kYWVtb24gXHU3Njg0XHU1NDJGXHU1MkE4XHU5ODc5XHU2NTg3XHU0RUY2XHU1QjU4XHU1NzI4XHU2MDI3OzAuMjMuMzcgXHU2NUIwXHU4MEZEXHU1MjlCKVx1MzAwMiAqL1xuICBmdW5jdGlvbiB3ZWJBdXRvc3RhcnRJbnN0YWxsZWQoKTogYm9vbGVhbiB7XG4gICAgY29uc3QgaG9tZSA9IHByb2Nlc3MuZW52LkhPTUUgPz8gJyc7XG4gICAgY29uc3QgY2FuZGlkYXRlcyA9IHByb2Nlc3MucGxhdGZvcm0gPT09ICd3aW4zMidcbiAgICAgID8gW2pvaW4ocHJvY2Vzcy5lbnYuQVBQREFUQSA/PyAnJywgJ01pY3Jvc29mdCcsICdXaW5kb3dzJywgJ1N0YXJ0IE1lbnUnLCAnUHJvZ3JhbXMnLCAnU3RhcnR1cCcsICdobWhhcm5lc3Mtd2ViLWRhZW1vbi5jbWQnKV1cbiAgICAgIDogcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gJ2RhcndpbidcbiAgICAgICAgPyBbam9pbihob21lLCAnTGlicmFyeScsICdMYXVuY2hBZ2VudHMnLCAnaG1oYXJuZXNzLXdlYi1kYWVtb24ucGxpc3QnKV1cbiAgICAgICAgOiBbam9pbihob21lLCAnLmNvbmZpZycsICdzeXN0ZW1kJywgJ3VzZXInLCAnaG1oYXJuZXNzLXdlYi1kYWVtb24uc2VydmljZScpXTtcbiAgICByZXR1cm4gY2FuZGlkYXRlcy5zb21lKChwKSA9PiB7IHRyeSB7IHJldHVybiBleGlzdHNTeW5jKHApOyB9IGNhdGNoIHsgcmV0dXJuIGZhbHNlOyB9IH0pO1xuICB9XG4gIC8qKiBcdTYyNEJcdTY3M0FcdTUzRUZcdThERUZcdTc1MzFcdTc2ODQgTEFOIElQKFJGQzE5MTgsXHU2MzkyXHU5NjY0XHU4NjVBXHU2MkRGXHU3RjUxXHU1MzYxKVx1MzAwMiAqL1xuICBmdW5jdGlvbiBsYW5JcE9mKCk6IHN0cmluZyB7XG4gICAgY29uc3QgVklSVFVBTCA9IC92bXdhcmV8dmlydHVhbHxoeXBlci0/dnx2ZXRoZXJuZXR8d3NsfHRhaWxzY2FsZXxsb29wYmFja3xibHVldG9vdGh8dmJveHxkb2NrZXJ8dGFwLXxwc2V1ZG8vaTtcbiAgICBjb25zdCBpc1JmYzE5MTggPSAoYTogc3RyaW5nKTogYm9vbGVhbiA9PiAvXjEwXFwuLy50ZXN0KGEpIHx8IC9eMTkyXFwuMTY4XFwuLy50ZXN0KGEpIHx8IC9eMTcyXFwuKDFbNi05XXwyXFxkfDNbMDFdKVxcLi8udGVzdChhKTtcbiAgICBsZXQgbGFuSXAgPSAnJztcbiAgICBsZXQgZmFsbGJhY2sgPSAnJztcbiAgICBmb3IgKGNvbnN0IFtuYW1lLCBsaXN0XSBvZiBPYmplY3QuZW50cmllcyhuZXR3b3JrSW50ZXJmYWNlcygpKSkge1xuICAgICAgZm9yIChjb25zdCBuIG9mIGxpc3QgPz8gW10pIHtcbiAgICAgICAgaWYgKG4uZmFtaWx5ICE9PSAnSVB2NCcgfHwgbi5pbnRlcm5hbCB8fCAhaXNSZmMxOTE4KG4uYWRkcmVzcykpIGNvbnRpbnVlO1xuICAgICAgICBpZiAoIVZJUlRVQUwudGVzdChuYW1lKSkgbGFuSXAgPSBsYW5JcCB8fCBuLmFkZHJlc3M7XG4gICAgICAgIGVsc2UgZmFsbGJhY2sgPSBmYWxsYmFjayB8fCBuLmFkZHJlc3M7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBsYW5JcCB8fCBmYWxsYmFjaztcbiAgfVxuICAvKiogQ0xJIFx1NTE2NVx1NTNFMzpcdTZFOTBcdTc4MDEgcmVwbyBcdTVFMDNcdTVDNDAobWFpbi50cyxcdTdFQ0YgdHN4KVx1NjIxNiBucG0gXHU1Qjg5XHU4OEM1XHU1RTAzXHU1QzQwKGRpc3QvbWFpbi5qc1xuICAgKiAgXHU3NkY0XHU4REQxXHUyMDE0XHUyMDE0XHU0RUNFIHJ1bnRpbWUgXHU1MTY1XHU1M0UzXHU0RTBBXHU2RUFGXHU2MjdFIEBobWhhcm5lc3MvY2xpIFx1NTMwNTtcdTVENENcdTU5NTcvXHU2M0QwXHU1MzQ3L1x1NkU5MFx1NzgwMVx1NEUwOVx1NzlDRFx1NUUwM1x1NUM0MFx1OTAxQVx1NTQwMylcdTMwMDIgKi9cbiAgZnVuY3Rpb24gY2xpRW50cnlPZigpOiBzdHJpbmcge1xuICAgIGlmIChydW50aW1lRW50cnkgPT09ICcnIHx8IHJ1bnRpbWVFbnRyeSA9PT0gbnVsbCkgcmV0dXJuICcnO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBwID0gam9pbihyZXBvUm9vdE9mKHJ1bnRpbWVFbnRyeSksICdwYWNrYWdlcycsICdjbGknLCAnc3JjJywgJ21haW4udHMnKTtcbiAgICAgIGlmIChleGlzdHNTeW5jKHApKSByZXR1cm4gcDtcbiAgICB9IGNhdGNoIHsgLyogXHU5NzVFIHJlcG8gXHU1RTAzXHU1QzQwICovIH1cbiAgICBsZXQgZGlyID0gZGlybmFtZShydW50aW1lRW50cnkpO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgODsgaSsrKSB7XG4gICAgICBpZiAoZXhpc3RzU3luYyhqb2luKGRpciwgJ2Rpc3QnLCAnbWFpbi5qcycpKSAmJiBwa2dOYW1lQXQoZGlyKSA9PT0gJ0BobWhhcm5lc3MvY2xpJykgcmV0dXJuIGpvaW4oZGlyLCAnZGlzdCcsICdtYWluLmpzJyk7XG4gICAgICBpZiAoYmFzZW5hbWUoZGlyKSA9PT0gJ0BobWhhcm5lc3MnICYmIGV4aXN0c1N5bmMoam9pbihkaXIsICdjbGknLCAnZGlzdCcsICdtYWluLmpzJykpKSByZXR1cm4gam9pbihkaXIsICdjbGknLCAnZGlzdCcsICdtYWluLmpzJyk7XG4gICAgICBjb25zdCBwYXJlbnQgPSBkaXJuYW1lKGRpcik7XG4gICAgICBpZiAocGFyZW50ID09PSBkaXIpIGJyZWFrO1xuICAgICAgZGlyID0gcGFyZW50O1xuICAgIH1cbiAgICByZXR1cm4gJyc7XG4gIH1cbiAgZnVuY3Rpb24gcnVuQ2xpKGFyZ3M6IHN0cmluZ1tdKTogdm9pZCB7XG4gICAgY29uc3QgZW50cnkgPSBjbGlFbnRyeU9mKCk7XG4gICAgaWYgKGVudHJ5ID09PSAnJykgcmV0dXJuO1xuICAgIGNvbnN0IGlzVHMgPSBlbnRyeS5lbmRzV2l0aCgnLnRzJyk7XG4gICAgY29uc3QgcmVwbyA9IHJlcG9Sb290T2YocnVudGltZUVudHJ5ID8/IGVudHJ5KTtcbiAgICBjb25zdCBjaGlsZCA9IHNwYXduKHByb2Nlc3MuZXhlY1BhdGgsIGlzVHMgPyBbJy0taW1wb3J0JywgJ3RzeCcsIGVudHJ5LCAuLi5hcmdzXSA6IFtlbnRyeSwgLi4uYXJnc10sIHtcbiAgICAgIGN3ZDogaXNUcyA/IHJlcG8gOiBkaXJuYW1lKGVudHJ5KSxcbiAgICAgIGRldGFjaGVkOiB0cnVlLFxuICAgICAgc3RkaW86ICdpZ25vcmUnLFxuICAgICAgd2luZG93c0hpZGU6IHRydWUsXG4gICAgICBlbnY6IHsgRUxFQ1RST05fUlVOX0FTX05PREU6ICcxJyB9LFxuICAgIH0pO1xuICAgIGNoaWxkLnVucmVmKCk7XG4gIH1cblxuICBmdW5jdGlvbiBicm9hZGNhc3RIb3N0U3RhdGUoczogSG9zdFN0YXRlLCBpbmZvOiB7IHJlc3RhcnRDb3VudDogbnVtYmVyOyBsYXN0RXJyb3I/OiBzdHJpbmcgfSk6IHZvaWQge1xuICAgIGJyaWRnZSA9IHsgLi4uYnJpZGdlLCBob3N0U3RhdGU6IHMsIGhvc3RQb3J0OiBzdXBlcnZpc29yPy5lbmRwb2ludD8ucG9ydCA/PyBudWxsLCBob3N0VmVyc2lvbjogc3VwZXJ2aXNvcj8uZW5kcG9pbnQ/LnZlcnNpb24gPz8gbnVsbCB9O1xuICAgIGxvZ0luZm8oJ2hvc3QnLCBgc3RhdGU9JHtzfSR7aW5mby5sYXN0RXJyb3IgIT09IHVuZGVmaW5lZCA/IGAgZXJyPSR7aW5mby5sYXN0RXJyb3J9YCA6ICcnfWApO1xuICAgIGZvciAoY29uc3QgdyBvZiBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKSkge1xuICAgICAgaWYgKCF3LmlzRGVzdHJveWVkKCkpIHcud2ViQ29udGVudHMuc2VuZCgnYnJpZGdlOmhvc3Qtc3RhdGUnLCBzLCBpbmZvKTtcbiAgICB9XG4gIH1cblxuICAvKiogU1NFIFx1NkQ0MVx1OEJBMlx1OTYwNTpcdTRGRTFcdTVDMDEoZXZlbnQ6IGhtaClcdTYyNzlcdTkxQ0ZcdTYzQTggcmVuZGVyZXI7XHU5QUQ4XHU5ODkxIGRlbHRhL2xpbmUgXHU1MzlGXHU1RTI3XG4gICAqICBcdTRGNUNcdTRFM0FcdTZENDFcdTU3NTdcdThGNkNcdTUzRDEocmVuZGVyZXIgXHU2MkZDXHU2M0E1XHU1RjUzXHU1MjREIGFzc2lzdGFudCBcdTUzNjBcdTRGNEQpXHUzMDAyXHU2NUFEXHU3RUJGXHU4MUVBXHU1MkE4XHU5MUNEXHU4RkRFXHUzMDAyICovXG4gIGFzeW5jIGZ1bmN0aW9uIHB1bXBFdmVudHMoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKGNsaWVudCA9PT0gbnVsbCkgcmV0dXJuO1xuICAgIGZvciAoOzspIHtcbiAgICAgIGNvbnN0IGMgPSBjbGllbnQ7XG4gICAgICBpZiAoYyA9PT0gbnVsbCkgcmV0dXJuO1xuICAgICAgdHJ5IHtcbiAgICAgICAgZm9yIGF3YWl0IChjb25zdCBmcmFtZSBvZiBjLnJhd0V2ZW50cyhsYXN0RXZlbnRJZCA9PT0gJycgPyB1bmRlZmluZWQgOiBsYXN0RXZlbnRJZCwgc3NlQWJvcnQ/LnNpZ25hbCkpIHtcbiAgICAgICAgICBpZiAoZnJhbWUuZXZlbnQgPT09ICdobWgnKSB7XG4gICAgICAgICAgICBjb25zdCBlbnYgPSBlbnZlbG9wZUZyb21GcmFtZShmcmFtZSk7XG4gICAgICAgICAgICBpZiAoZW52ID09PSBudWxsKSB7XG4gICAgICAgICAgICAgIGRyb3BwZWRGcmFtZXMgKz0gMTtcbiAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBsYXN0RXZlbnRJZCA9IGVudi5ldmVudElkO1xuICAgICAgICAgICAgcHVzaEV2ZW50KGVudik7XG4gICAgICAgICAgfSBlbHNlIGlmIChmcmFtZS5ldmVudCA9PT0gJ2RlbHRhJyB8fCBmcmFtZS5ldmVudCA9PT0gJ2xpbmUnKSB7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICBjb25zdCBkID0gSlNPTi5wYXJzZShmcmFtZS5kYXRhKSBhcyB7IHNlc3Npb25JZD86IHN0cmluZzsgaz86IHN0cmluZzsgY2h1bms/OiBzdHJpbmc7IHRleHQ/OiBzdHJpbmcgfTtcbiAgICAgICAgICAgICAgY29uc3QgcGF5bG9hZCA9IGZyYW1lLmV2ZW50ID09PSAnZGVsdGEnXG4gICAgICAgICAgICAgICAgPyB7IHNlc3Npb25JZDogZC5zZXNzaW9uSWQgPz8gJycsIGtpbmQ6IGQuayA/PyAndGV4dCcsIGNodW5rOiBTdHJpbmcoZC5jaHVuayA/PyAnJykgfVxuICAgICAgICAgICAgICAgIDogeyBzZXNzaW9uSWQ6IGQuc2Vzc2lvbklkID8/ICcnLCBraW5kOiAnbGluZScsIGNodW5rOiBTdHJpbmcoZC50ZXh0ID8/ICcnKSB9O1xuICAgICAgICAgICAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcbiAgICAgICAgICAgICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCdicmlkZ2U6c3RyZWFtLWNodW5rJywgcGF5bG9hZCk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gY2F0Y2ggeyAvKiBtYWxmb3JtZWQgc3RyZWFtIGZyYW1lOiBza2lwICovIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuOyAvLyBcdTZENDFcdTZCNjNcdTVFMzhcdTdFRDNcdTY3NUYoaG9zdCBcdTUxNzNcdTk1RUQpXG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLy8gXHU2NUFEXHU3RUJGOlx1NzdFRFx1OTAwMFx1OTA3Rlx1NTQwRVx1OTFDRFx1OEZERShzdXBlcnZpc29yIFx1NTNFRlx1ODBGRFx1NkI2M1x1NTcyOFx1OTFDRFx1NTQyRiBob3N0KVxuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCAxXzAwMCkpO1xuICAgICAgICBpZiAoc3NlQWJvcnQ/LnNpZ25hbC5hYm9ydGVkKSByZXR1cm47XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLyogLS0tLSBobWhhcm5lc3MgcnVudGltZSBcdTgxRUFcdTUyQThcdTUzRDFcdTczQjAoMjAyNi0xMC0xMCBcdTc1MjhcdTYyMzdcdTVCOUFcdThDMDM6XHU4OEM1XHU4RkM3IGhtaGFybmVzcyBcdTc2ODRcbiAgICAgXHU2NzNBXHU1NjY4XHU5NkY2XHU5MTREXHU3RjZFXHU3NkY0XHU4RkRFLFx1NTkwRFx1NzUyOCBDTEkvVFVJL3dlYiA3Nzg4IFx1NzY4NFx1NTQwQ1x1NEUwMCBITUhfSE9NRVx1MjAxNFx1MjAxNGNvbmZpZy9wcm92aWRlcnMvXG4gICAgIFx1NEYxQVx1OEJERFx1NTM4Nlx1NTNGMlx1NTkyOVx1NzEzNlx1NTE3MVx1NEVBQilcdTMwMDJ2NS4xIFx1NTNEMVx1NzNCMFx1OTg3QVx1NUU4RjpcdTY2M0VcdTVGMEZcdTkxNERcdTdGNkUgPiB3aGVyZSBobWgoXHU2RTkwXHU3ODAxIGxpbmsgXHU0RTBFXG4gICAgIEBobWhhcm5lc3MvY2xpIG5wbSBcdTVCODlcdTg4QzVcdTRFMjRcdTc5Q0RcdTVFMDNcdTVDNDApPiBucG0gXHU1MTY4XHU1QzQwXHU2ODM5KFx1NTQwQyk+IFx1NTQxMVx1NUJGQ1x1NUI4OVx1ODhDNVx1NzZFRVx1NUY1NVxuICAgICB+Ly5obWhhcm5lc3MtZ2xvYmFsID4gXHU1RTM4XHU4OUMxXHU2RTkwXHU3ODAxXHU0RjREXHU3RjZFXHUzMDAyICovXG4gIGNvbnN0IHJ1bnRpbWVDb25maWdGaWxlID0gKCk6IHN0cmluZyA9PiBqb2luKGFwcC5nZXRQYXRoKCd1c2VyRGF0YScpLCAncnVudGltZS5qc29uJyk7XG4gIC8qKiBydW50aW1lLmpzb246eyBlbnRyeShcdTYyNEJcdTUyQTgvXHU1NDExXHU1QkZDXHU5MDA5XHU2MkU5XHU3Njg0XHU1MTY1XHU1M0UzKSwgZGVtbyhcdTYzMDFcdTRFNDVcdTZGMTRcdTc5M0FcdTZBMjFcdTVGMEYpIH1cdTMwMDIgKi9cbiAgYXN5bmMgZnVuY3Rpb24gbG9hZFJ1bnRpbWVDb25maWcoKTogUHJvbWlzZTx7IGVudHJ5OiBzdHJpbmc7IGRlbW86IGJvb2xlYW4gfT4ge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCB2ID0gSlNPTi5wYXJzZShhd2FpdCByZWFkRmlsZShydW50aW1lQ29uZmlnRmlsZSgpLCAndXRmOCcpKSBhcyB7IGVudHJ5PzogdW5rbm93bjsgZGVtbz86IHVua25vd24gfTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGVudHJ5OiB0eXBlb2Ygdi5lbnRyeSA9PT0gJ3N0cmluZycgJiYgdi5lbnRyeSAhPT0gJycgJiYgaXNBYnNvbHV0ZSh2LmVudHJ5KSA/IHYuZW50cnkgOiAnJyxcbiAgICAgICAgZGVtbzogdi5kZW1vID09PSB0cnVlLFxuICAgICAgfTtcbiAgICB9IGNhdGNoIHsgcmV0dXJuIHsgZW50cnk6ICcnLCBkZW1vOiBmYWxzZSB9OyB9XG4gIH1cbiAgYXN5bmMgZnVuY3Rpb24gc2F2ZVJ1bnRpbWVDb25maWcoY2ZnOiB7IGVudHJ5OiBzdHJpbmc7IGRlbW86IGJvb2xlYW4gfSk6IFByb21pc2U8dm9pZD4ge1xuICAgIGF3YWl0IHdyaXRlRmlsZShydW50aW1lQ29uZmlnRmlsZSgpLCBKU09OLnN0cmluZ2lmeShjZmcsIG51bGwsIDIpLCAndXRmOCcpLmNhdGNoKCgpID0+IHVuZGVmaW5lZCk7XG4gIH1cbiAgYXN5bmMgZnVuY3Rpb24gbG9hZFJ1bnRpbWVFbnRyeU92ZXJyaWRlKCk6IFByb21pc2U8c3RyaW5nPiB7XG4gICAgcmV0dXJuIChhd2FpdCBsb2FkUnVudGltZUNvbmZpZygpKS5lbnRyeTtcbiAgfVxuICBhc3luYyBmdW5jdGlvbiBzYXZlUnVudGltZUVudHJ5T3ZlcnJpZGUoZW50cnk6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICAgIGF3YWl0IHNhdmVSdW50aW1lQ29uZmlnKHsgZW50cnksIGRlbW86IChhd2FpdCBsb2FkUnVudGltZUNvbmZpZygpKS5kZW1vIH0pO1xuICB9XG5cbiAgaW50ZXJmYWNlIEV4dGVybmFsUnVudGltZSB7IGVudHJ5OiBzdHJpbmc7IHZlcnNpb246IHN0cmluZzsgc291cmNlOiBzdHJpbmcgfVxuXG4gIC8qKiBcdThCRkJcdTUzMDVcdTcyNDhcdTY3MkMocGFja2FnZS5qc29uIFx1NzY4NCB2ZXJzaW9uIFx1NUI1N1x1NkJCNTtcdTU5MzFcdThEMjVcdTdBN0FcdTRFMzIpXHUzMDAyICovXG4gIGZ1bmN0aW9uIHBrZ1ZlcnNpb25BdChkaXI6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHYgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKGRpciwgJ3BhY2thZ2UuanNvbicpLCAndXRmOCcpKSBhcyB7IHZlcnNpb24/OiB1bmtub3duIH07XG4gICAgICByZXR1cm4gdHlwZW9mIHYudmVyc2lvbiA9PT0gJ3N0cmluZycgPyB2LnZlcnNpb24gOiAnJztcbiAgICB9IGNhdGNoIHsgcmV0dXJuICcnOyB9XG4gIH1cbiAgLyoqIFx1OEJGQlx1NTMwNVx1NTQwRChcdTU0MENcdTRFMEE7QGhtaGFybmVzcy9jbGkgXHU1RTAzXHU1QzQwXHU4QkM2XHU1MjJCXHU3NTI4KVx1MzAwMiAqL1xuICBmdW5jdGlvbiBwa2dOYW1lQXQoZGlyOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCB2ID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoam9pbihkaXIsICdwYWNrYWdlLmpzb24nKSwgJ3V0ZjgnKSkgYXMgeyBuYW1lPzogdW5rbm93biB9O1xuICAgICAgcmV0dXJuIHR5cGVvZiB2Lm5hbWUgPT09ICdzdHJpbmcnID8gdi5uYW1lIDogJyc7XG4gICAgfSBjYXRjaCB7IHJldHVybiAnJzsgfVxuICB9XG5cbiAgLyoqIG5wbSBcdTVCODlcdTg4QzVcdTc2ODQgQGhtaGFybmVzcy9jbGkgXHUyMTkyIGRlc2t0b3AtaG9zdCBcdTdGMTZcdThCRDFcdTUxNjVcdTUzRTMoXHU1RDRDXHU1OTU3XHU0RTBFXHU2M0QwXHU1MzQ3XHU0RTI0XHU3OUNEXHU1RTAzXHU1QzQwKVx1MzAwMiAqL1xuICBmdW5jdGlvbiBlbnRyeUZyb21DbGlEaXIoY2xpRGlyOiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IG5lc3RlZCA9IGpvaW4oY2xpRGlyLCAnbm9kZV9tb2R1bGVzJywgJ0BobWhhcm5lc3MnLCAnd2ViJywgJ2Rpc3QnLCAnZGVza3RvcC1ob3N0LmpzJyk7XG4gICAgaWYgKGV4aXN0c1N5bmMobmVzdGVkKSkgcmV0dXJuIG5lc3RlZDtcbiAgICBjb25zdCBob2lzdGVkID0gam9pbihkaXJuYW1lKGNsaURpciksICd3ZWInLCAnZGlzdCcsICdkZXNrdG9wLWhvc3QuanMnKTtcbiAgICBpZiAoZXhpc3RzU3luYyhob2lzdGVkKSkgcmV0dXJuIGhvaXN0ZWQ7XG4gICAgcmV0dXJuICcnO1xuICB9XG5cbiAgLyoqIFx1NTkxNlx1OTBFOFx1NTNEMVx1NzNCMChcdTRGOUJcdTgxRUFcdTUyQThcdThGREVcdTYzQTVcdTRFMEVcdTU0MTFcdTVCRkNcdTY4QzBcdTZENEJcdTk4NzVcdTUxNzFcdTc1MjgpXHUzMDAyXHU0RjE4XHU1MTQ4XHU3RUE3OmVudiA+IHdoZXJlIGhtaCA+IG5wbVxuICAgKiAgXHU1MTY4XHU1QzQwXHU2ODM5ID4gXHU1NDExXHU1QkZDXHU1Qjg5XHU4OEM1XHU3NkVFXHU1RjU1IH4vLmhtaGFybmVzcy1nbG9iYWwgPiBcdTZFOTBcdTc4MDFcdTRFRDNcdTYyNkJcdTYzQ0Y7XHU1NDBDXHU0RTAwXHU1QzQyXHU1MTg1XG4gICAqICBcIlx1NURGMlx1ODhDNSBDTEkobnBtIFx1NUUwM1x1NUM0MClcIiBcdTUxNDhcdTRFOEUgXCJcdTZFOTBcdTc4MDEgcmVwbyBcdTVFMDNcdTVDNDBcIlx1MzAwMiAqL1xuICBmdW5jdGlvbiBkZXRlY3RFeHRlcm5hbFJ1bnRpbWUoKTogRXh0ZXJuYWxSdW50aW1lIHtcbiAgICAvLyAxKSBcdTczQUZcdTU4ODNcdTUzRDhcdTkxQ0ZcdTY2M0VcdTVGMEZcdTg5ODZcdTc2RDYoXHU5QUQ4XHU3RUE3XHU3NTI4XHU2MjM3KVxuICAgIGNvbnN0IGVudkVudHJ5ID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfUkVBTF9FTlRSWTtcbiAgICBpZiAoZW52RW50cnkgIT09IHVuZGVmaW5lZCAmJiBlbnZFbnRyeSAhPT0gJycgJiYgaXNBYnNvbHV0ZShlbnZFbnRyeSkpIHtcbiAgICAgIHJldHVybiB7IGVudHJ5OiBlbnZFbnRyeSwgdmVyc2lvbjogJycsIHNvdXJjZTogJ2VudicgfTtcbiAgICB9XG5cbiAgICBjb25zdCB3aGVyZVJlcG9zID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gICAgY29uc3Qgd2hlcmVDbGlzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGNvbnN0IG5wbVJlcG9zID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gICAgbGV0IG5wbUNsaSA9ICcnO1xuICAgIC8vIDIpIHdoZXJlIGhtaDpucG0gbGluayhcdTZFOTBcdTc4MDFcdTY4MzlcdTVFMDNcdTVDNDApXHU0RTBFIEBobWhhcm5lc3MvY2xpIG5wbSBcdTVCODlcdTg4QzVcdTVFMDNcdTVDNDBcbiAgICB0cnkge1xuICAgICAgY29uc3Qgb3V0ID0gZXhlY0ZpbGVTeW5jKCd3aGVyZScsIFsnaG1oJ10sIHsgZW5jb2Rpbmc6ICd1dGY4JywgdGltZW91dDogNF8wMDAsIHdpbmRvd3NIaWRlOiB0cnVlIH0pO1xuICAgICAgZm9yIChjb25zdCBsaW5lIG9mIG91dC5zcGxpdCgvXFxyP1xcbi8pKSB7XG4gICAgICAgIGNvbnN0IGJpbiA9IGxpbmUudHJpbSgpO1xuICAgICAgICBpZiAoYmluID09PSAnJykgY29udGludWU7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgYmluRGlyID0gZGlybmFtZShiaW4pO1xuICAgICAgICAgIGNvbnN0IGxpbmtlZCA9IGpvaW4oYmluRGlyLCAnbm9kZV9tb2R1bGVzJywgJ2htaGFybmVzcycpO1xuICAgICAgICAgIGlmIChleGlzdHNTeW5jKGxpbmtlZCkpIHdoZXJlUmVwb3MuYWRkKHJlYWxwYXRoU3luYyhsaW5rZWQpKTtcbiAgICAgICAgICBjb25zdCBjbGkgPSBqb2luKGJpbkRpciwgJ25vZGVfbW9kdWxlcycsICdAaG1oYXJuZXNzJywgJ2NsaScpO1xuICAgICAgICAgIGlmIChleGlzdHNTeW5jKGNsaSkpIHdoZXJlQ2xpcy5wdXNoKGNsaSk7XG4gICAgICAgIH0gY2F0Y2ggeyAvKiBiaW4gXHU1RTAzXHU1QzQwXHU0RTBEXHU3QjI2LFx1OERGM1x1OEZDNyAqLyB9XG4gICAgICB9XG4gICAgfSBjYXRjaCB7IC8qIGhtaCBcdTRFMERcdTU3MjggUEFUSCAqLyB9XG4gICAgLy8gMykgbnBtIFx1NTE2OFx1NUM0MFx1NjgzOShcdTRFMjRcdTc5Q0RcdTVFMDNcdTVDNDBcdTU0MEMgd2hlcmUpXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IG91dCA9IGV4ZWNGaWxlU3luYygnbnBtJywgWydyb290JywgJy1nJ10sIHsgZW5jb2Rpbmc6ICd1dGY4JywgdGltZW91dDogNl8wMDAsIHdpbmRvd3NIaWRlOiB0cnVlIH0pO1xuICAgICAgY29uc3Qgcm9vdCA9IG91dC50cmltKCk7XG4gICAgICBjb25zdCBsaW5rZWQgPSBqb2luKHJvb3QsICdobWhhcm5lc3MnKTtcbiAgICAgIGlmIChleGlzdHNTeW5jKGxpbmtlZCkpIG5wbVJlcG9zLmFkZChyZWFscGF0aFN5bmMobGlua2VkKSk7XG4gICAgICBjb25zdCBjbGkgPSBqb2luKHJvb3QsICdAaG1oYXJuZXNzJywgJ2NsaScpO1xuICAgICAgaWYgKGV4aXN0c1N5bmMoY2xpKSkgbnBtQ2xpID0gY2xpO1xuICAgIH0gY2F0Y2ggeyAvKiBucG0gXHU0RTBEXHU1M0VGXHU3NTI4ICovIH1cblxuICAgIC8vIFx1NURGMlx1ODhDNSBDTEkoQGhtaGFybmVzcy9jbGkgbnBtIFx1NUUwM1x1NUM0MDtkZXNrdG9wLWhvc3QgXHU0RTNBXHU3RjE2XHU4QkQxXHU0RUE3XHU3MjY5XHU1M0VGXHU3NkY0XHU4REQxKTpcbiAgICAvLyB3aGVyZShQQVRIIFx1NzcxRlx1NzZGOCk+IG5wbSBcdTUxNjhcdTVDNDBcdTY4MzkgPiBcdTU0MTFcdTVCRkNcdTVCODlcdTg4QzVcdTc2RUVcdTVGNTVcbiAgICBmb3IgKGNvbnN0IFtjbGksIHNvdXJjZV0gb2YgW1t3aGVyZUNsaXNbMF0gPz8gJycsICd3aGVyZS1obWgnXSwgW25wbUNsaSwgJ25wbS1nbG9iYWwnXV0gYXMgQXJyYXk8W3N0cmluZywgc3RyaW5nXT4pIHtcbiAgICAgIGlmIChjbGkgPT09ICcnKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IGVudHJ5ID0gZW50cnlGcm9tQ2xpRGlyKGNsaSk7XG4gICAgICBpZiAoZW50cnkgIT09ICcnKSByZXR1cm4geyBlbnRyeSwgdmVyc2lvbjogcGtnVmVyc2lvbkF0KGNsaSksIHNvdXJjZSB9O1xuICAgIH1cbiAgICBjb25zdCB3aXphcmRFbnRyeSA9IHJlc29sdmVJbnN0YWxsZWRFbnRyeShpbnN0YWxsVGFyZ2V0KCkpO1xuICAgIGlmICh3aXphcmRFbnRyeSAhPT0gJycpIHtcbiAgICAgIHJldHVybiB7IGVudHJ5OiB3aXphcmRFbnRyeSwgdmVyc2lvbjogcGtnVmVyc2lvbkF0KGpvaW4oaW5zdGFsbFRhcmdldCgpLCAnbm9kZV9tb2R1bGVzJywgJ0BobWhhcm5lc3MnLCAnY2xpJykpLCBzb3VyY2U6ICd3aXphcmQtaW5zdGFsbCcgfTtcbiAgICB9XG5cbiAgICAvLyBcdTZFOTBcdTc4MDEgcmVwbyBcdTVFMDNcdTVDNDAod2hlcmUgPiBucG0gXHU1MTY4XHU1QzQwID4gXHU1RTM4XHU4OUMxXHU2RTkwXHU3ODAxXHU0RjREXHU3RjZFO1x1NTQ3RFx1NEUyRFx1OTg3Qlx1NjcwOVx1NTE2NVx1NTNFM1x1NEUwRVx1NEY5RFx1OEQ1NilcbiAgICBjb25zdCByZXBvcyA9IG5ldyBTZXQ8c3RyaW5nPihbLi4ud2hlcmVSZXBvcywgLi4ubnBtUmVwb3NdKTtcbiAgICBjb25zdCBiYXNlcyA9IFsnQzpcXFxcJywgJ0Q6XFxcXCcsICdFOlxcXFwnLCAnRjpcXFxcJywgJ0c6XFxcXCcsICdIOlxcXFwnLCBob21lZGlyKCksIGpvaW4oaG9tZWRpcigpLCAnRGV2ZWxvcGVyJyldO1xuICAgIGZvciAoY29uc3QgYmFzZSBvZiBiYXNlcykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcCA9IHJlc29sdmUoYmFzZSwgJ2htaGFybmVzcycpO1xuICAgICAgICBpZiAoZXhpc3RzU3luYyhwKSkgcmVwb3MuYWRkKHApO1xuICAgICAgfSBjYXRjaCB7IC8qIFx1NzZEOFx1NEUwRFx1NUI1OFx1NTcyOCAqLyB9XG4gICAgfVxuICAgIGZvciAoY29uc3QgcmVwbyBvZiByZXBvcykge1xuICAgICAgY29uc3QgZW50cnkgPSBqb2luKHJlcG8sICdwYWNrYWdlcycsICd3ZWInLCAnc3JjJywgJ2Rlc2t0b3AtaG9zdC50cycpO1xuICAgICAgaWYgKGV4aXN0c1N5bmMoZW50cnkpICYmIGV4aXN0c1N5bmMoam9pbihyZXBvLCAnbm9kZV9tb2R1bGVzJykpKSB7XG4gICAgICAgIHJldHVybiB7IGVudHJ5LCB2ZXJzaW9uOiBwa2dWZXJzaW9uQXQocmVwbyksIHNvdXJjZTogJ3NvdXJjZS1yZXBvJyB9O1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4geyBlbnRyeTogJycsIHZlcnNpb246ICcnLCBzb3VyY2U6ICcnIH07XG4gIH1cblxuICBmdW5jdGlvbiBkZXRlY3RSZWFsRW50cnkoKTogc3RyaW5nIHtcbiAgICByZXR1cm4gZGV0ZWN0RXh0ZXJuYWxSdW50aW1lKCkuZW50cnk7XG4gIH1cblxuICAvKiogXHU4OUUzXHU2NzkwIHJ1bnRpbWUgXHU1MTY1XHU1M0UzXHU2MjQwXHU1QzVFXHU3Njg0IGhtaGFybmVzcyBcdTRFRDNcdTVFOTNcdTY4MzkocGFja2FnZXMvd2ViL3NyY3xkaXN0IFx1NEUwQVx1NkVBRilcdTMwMDIgKi9cbiAgZnVuY3Rpb24gcmVwb1Jvb3RPZihlbnRyeTogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBsZXQgZGlyID0gZGlybmFtZShlbnRyeSk7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCA2OyBpKyspIHtcbiAgICAgIGlmIChleGlzdHNTeW5jKGpvaW4oZGlyLCAncGFja2FnZS5qc29uJykpICYmIGV4aXN0c1N5bmMoam9pbihkaXIsICdwYWNrYWdlcycsICd3ZWInKSkpIHJldHVybiBkaXI7XG4gICAgICBjb25zdCBwYXJlbnQgPSBkaXJuYW1lKGRpcik7XG4gICAgICBpZiAocGFyZW50ID09PSBkaXIpIGJyZWFrO1xuICAgICAgZGlyID0gcGFyZW50O1xuICAgIH1cbiAgICByZXR1cm4gZGlybmFtZShlbnRyeSk7XG4gIH1cblxuICBsZXQgcnVudGltZUVudHJ5ID0gJyc7IC8vIFx1NUY1M1x1NTI0RFx1NUI5RVx1OTY0NVx1NEY3Rlx1NzUyOFx1NzY4NFx1NzcxRlx1NUI5RSBydW50aW1lIFx1NTE2NVx1NTNFMygnJz1cdTY3MkFcdTYzQTUpXG4gIGxldCB1c2VCdW5kbGVkUnVudGltZSA9IGZhbHNlOyAvLyB2NTpcdTY2MkZcdTU0MjZcdTU3MjhcdTc1MjhcdTUxODVcdTdGNkUgcnVudGltZShcdTUxNzNcdTRFOEUvXHU5NzYyXHU2NzdGXHU2ODA3XHU2Q0U4KVxuXG4gIC8qKiBcdTUxODVcdTdGNkUgcnVudGltZSh2NSBcdTVGMDBcdTdCQjFcdTUzNzNcdTc1MjgpOlx1NjI1M1x1NTMwNVx1NTQwRVx1OTY4RiBleHRyYVJlc291cmNlcyBcdTVFNzNcdTk0RkFcdTU3MjggcmVzb3VyY2VzLztcbiAgICAgZGV2IFx1NzUyOFx1NEVEM1x1NUU5M1x1NTE4NVx1Njc4NFx1NUVGQVx1NEVBN1x1NzI2OShzY3JpcHRzL2J1bmRsZS1ydW50aW1lLm1qcylcdTMwMDJcdTgxRUFcdTUzMDVcdTU0MkJcdTUzNTVcdTY1ODdcdTRFRjYsXHU2NUUwIHRzeFx1MzAwMVxuICAgICBcdTY1RTAgcmVwbyBub2RlX21vZHVsZXMgXHU0RjlEXHU4RDU2XHUzMDAyICovXG4gIGZ1bmN0aW9uIGJ1bmRsZWRSdW50aW1lUGF0aChyZXBvUm9vdDogc3RyaW5nKTogc3RyaW5nIHtcbiAgICByZXR1cm4gam9pbihhcHAuaXNQYWNrYWdlZCA/IHByb2Nlc3MucmVzb3VyY2VzUGF0aCA6IGpvaW4ocmVwb1Jvb3QsICdhcHBzJywgJ2Rlc2t0b3AnLCAncmVzb3VyY2VzJyksICdydW50aW1lJywgJ3J1bnRpbWUuY2pzJyk7XG4gIH1cblxuICAvKiogXHU1MTg1XHU3RjZFIHJ1bnRpbWUgXHU1MTQzXHU0RkUxXHU2MDZGKFx1NTQxMVx1NUJGQ1wiXHU1MTg1XHU3RjZFXHU3Q0JFXHU3QjgwXHU1MTg1XHU2ODM4XCJcdTkwMDlcdTk4NzlcdTc2ODRcdTcyNDhcdTY3MkNcdTY4MDdcdTZDRTgpXHUzMDAyICovXG4gIGZ1bmN0aW9uIGJ1bmRsZWRSdW50aW1lSW5mbygpOiB7IHJlYWR5OiBib29sZWFuOyB2ZXJzaW9uOiBzdHJpbmcgfSB7XG4gICAgY29uc3QgcmVwb1Jvb3QgPSBqb2luKGhlcmUsICcuLicsICcuLicsICcuLicsICcuLicpO1xuICAgIGNvbnN0IHAgPSBidW5kbGVkUnVudGltZVBhdGgocmVwb1Jvb3QpO1xuICAgIGxldCB2ZXJzaW9uID0gJyc7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHYgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKGRpcm5hbWUocCksICdwYWNrYWdlLmpzb24nKSwgJ3V0ZjgnKSkgYXMgeyB2ZXJzaW9uPzogdW5rbm93biB9O1xuICAgICAgdmVyc2lvbiA9IHR5cGVvZiB2LnZlcnNpb24gPT09ICdzdHJpbmcnID8gdi52ZXJzaW9uIDogJyc7XG4gICAgfSBjYXRjaCB7IC8qIFx1NTE0M1x1NjU3MFx1NjM2RVx1N0YzQVx1NTkzMVx1NTIxOVx1NTNFQVx1NjJBNSByZWFkeSAqLyB9XG4gICAgcmV0dXJuIHsgcmVhZHk6IGV4aXN0c1N5bmMocCksIHZlcnNpb24gfTtcbiAgfVxuXG4gIC8qKiBucG0gXHU2NjJGXHU1NDI2XHU1NzI4IFBBVEgoXHU1NDExXHU1QkZDXHU5MDA5XHU2MkU5XHU5ODc1IFx1MjQ2MCBcdTc2ODRcdTVCODlcdTg4QzVcdTY1QjlcdTVGMEZcdTY4MDdcdTZDRTg7d2hlcmUgXHU1RkVCXHU2M0EyLFx1NEUwRFx1NTA1QVx1NUI4Q1x1NjU3NFx1NjNBMlx1NkQ0QilcdTMwMDIgKi9cbiAgZnVuY3Rpb24gbnBtT25QYXRoKCk6IGJvb2xlYW4ge1xuICAgIHRyeSB7XG4gICAgICBleGVjRmlsZVN5bmMoJ3doZXJlJywgWyducG0nXSwgeyBlbmNvZGluZzogJ3V0ZjgnLCB0aW1lb3V0OiA0XzAwMCwgd2luZG93c0hpZGU6IHRydWUgfSk7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9IGNhdGNoIHsgcmV0dXJuIGZhbHNlOyB9XG4gIH1cblxuICAvKiAtLS0tIFx1OTk5Nlx1NTQyRlx1NUI4OVx1ODhDNVx1NTQxMVx1NUJGQ1x1NzJCNlx1NjAwMSh2NS4xKSAtLS0tICovXG4gIGNvbnN0IHdpemFyZEZpbGUgPSAoKTogc3RyaW5nID0+IGpvaW4oYXBwLmdldFBhdGgoJ3VzZXJEYXRhJyksICd3aXphcmQuanNvbicpO1xuICBhc3luYyBmdW5jdGlvbiBsb2FkV2l6YXJkU3RhdGUoKTogUHJvbWlzZTx7IGRvbmU6IGJvb2xlYW47IGNob2ljZTogc3RyaW5nIH0+IHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgdiA9IEpTT04ucGFyc2UoYXdhaXQgcmVhZEZpbGUod2l6YXJkRmlsZSgpLCAndXRmOCcpKSBhcyB7IGRvbmU/OiB1bmtub3duOyBjaG9pY2U/OiB1bmtub3duIH07XG4gICAgICByZXR1cm4geyBkb25lOiB2LmRvbmUgPT09IHRydWUsIGNob2ljZTogdHlwZW9mIHYuY2hvaWNlID09PSAnc3RyaW5nJyA/IHYuY2hvaWNlIDogJycgfTtcbiAgICB9IGNhdGNoIHsgcmV0dXJuIHsgZG9uZTogZmFsc2UsIGNob2ljZTogJycgfTsgfVxuICB9XG4gIGFzeW5jIGZ1bmN0aW9uIHNhdmVXaXphcmRTdGF0ZShjaG9pY2U6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICAgIGF3YWl0IHdyaXRlRmlsZSh3aXphcmRGaWxlKCksIEpTT04uc3RyaW5naWZ5KHsgZG9uZTogdHJ1ZSwgY2hvaWNlIH0sIG51bGwsIDIpLCAndXRmOCcpLmNhdGNoKCgpID0+IHVuZGVmaW5lZCk7XG4gIH1cbiAgLyoqIFx1NTQxMVx1NUJGQ1x1ODFFQVx1NTJBOFx1NUYzOVx1NTFGQVx1NjI5MVx1NTIzNjpcdTZENEJcdThCRDUvXHU1RjAwXHU1M0QxXHU3M0FGXHU1ODgzXHU0RTBEXHU1RjM5KFVJVkVSSUZZL1NOQVBTSE9UL1JFTkRFUl9URVNUL1xuICAgKiAgRE9NUFJPQkUvU0VDVVJJVFlfVEVTVC9GQUtFL2Rldik7SE1IX0RFU0tUT1BfV0laQVJEX0ZPUkNFPTEgXHU1RjNBXHU1MjM2XHU1RjM5KFx1OUE4Q1x1NjUzNilcdTMwMDIgKi9cbiAgZnVuY3Rpb24gd2l6YXJkU3VwcHJlc3NlZCgpOiBib29sZWFuIHtcbiAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfV0laQVJEX0ZPUkNFID09PSAnMScpIHJldHVybiBmYWxzZTtcbiAgICByZXR1cm4gaXNEZXZcbiAgICAgIHx8IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZID09PSAnMSdcbiAgICAgIHx8IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NOQVBTSE9UICE9PSB1bmRlZmluZWRcbiAgICAgIHx8IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1JFTkRFUl9URVNUID09PSAnMSdcbiAgICAgIHx8IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX0RPTVBST0JFID09PSAnMSdcbiAgICAgIHx8IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NFQ1VSSVRZX1RFU1QgPT09ICcxJ1xuICAgICAgfHwgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfRkFLRSA9PT0gJzEnO1xuICB9XG5cbiAgLyoqIFx1NTNEMVx1NzNCMFx1OTg3QVx1NUU4RjpcdTY2M0VcdTVGMEZcdTg5ODZcdTc2RDYoXHU1NDJCXHU1NDExXHU1QkZDXHU5MDA5XHU2MkU5Olx1NTkxNlx1OTBFOFx1NTE2NVx1NTNFMy9cdTUxODVcdTdGNkVcdThERUZcdTVGODQvXHU2RjE0XHU3OTNBKT4gXHU1MTg1XHU3RjZFXHU1RjAwXHU1MTczXG4gICAgIChITUhfREVTS1RPUF9CVU5ETEVEPTEpPiBcdTU5MTZcdTkwRThcdTUzRDFcdTczQjAoZGV2IFx1NzZGOFx1OTBCQlx1NEVEM1x1NUU5MyAvIHdoZXJlIGhtaCAvIG5wbSBcdTUxNjhcdTVDNDAgL1xuICAgICBcdTU0MTFcdTVCRkNcdTVCODlcdTg4QzVcdTc2RUVcdTVGNTUgLyBcdTZFOTBcdTc4MDFcdTRGNERcdTdGNkUpPiBcdTUxODVcdTdGNkVcdTUxNUNcdTVFOTVcdTMwMDJcdTU5MTZcdTkwRThcdTRGMThcdTUxNDg9XHU4MDAxXHU3NTI4XHU2MjM3XHU3RUU3XHU3RUVEXHU3NTI4XHU4MUVBXHU1REYxXHU4OEM1XHU3Njg0XHU3MjQ4XHU2NzJDO1xuICAgICBcdTUxODVcdTdGNkU9XHU2NUIwXHU2NzNBXHU1NjY4XHU4OEM1XHU1QjhDXHU3NkY0XHU4RkRFXHU3NzFGXHU1QjlFXHU1MTg1XHU2ODM4XHUzMDAySE1IX0RFU0tUT1BfRkFLRT0xIFx1NjIxNiBydW50aW1lLmpzb24gZGVtbz10cnVlXG4gICAgIChcdTU0MTFcdTVCRkNcIlx1NkYxNFx1NzkzQVx1NkEyMVx1NUYwRlwiXHU5MDA5XHU2MkU5LFx1NjMwMVx1NEU0NSlcdThGREJcdTZGMTRcdTc5M0FcdTMwMDIgKi9cbiAgYXN5bmMgZnVuY3Rpb24gc3RhcnRIb3N0KCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IHJlcG9Sb290ID0gam9pbihoZXJlLCAnLi4nLCAnLi4nLCAnLi4nLCAnLi4nKTsgLy8gYXBwcy9kZXNrdG9wL2Rpc3QtZWxlY3Ryb24vbWFpbiBcdTIxOTIgcmVwbyByb290XG4gICAgY29uc3QgcGFja2FnZWQgPSBhcHAuaXNQYWNrYWdlZDtcbiAgICBjb25zdCBjZmcgPSBhd2FpdCBsb2FkUnVudGltZUNvbmZpZygpO1xuICAgIGNvbnN0IGZvcmNlRmFrZSA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX0ZBS0UgPT09ICcxJyB8fCBjZmcuZGVtbztcbiAgICBjb25zdCBmb3JjZUJ1bmRsZWQgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9CVU5ETEVEID09PSAnMSc7XG4gICAgY29uc3Qgb3ZlcnJpZGUgPSBjZmcuZW50cnk7XG4gICAgY29uc3QgYWRqYWNlbnQgPSBqb2luKHJlcG9Sb290LCAnLi4nLCAnaG1oYXJuZXNzJywgJ3BhY2thZ2VzJywgJ3dlYicsICdzcmMnLCAnZGVza3RvcC1ob3N0LnRzJyk7XG4gICAgY29uc3QgYnVuZGxlZCA9IGJ1bmRsZWRSdW50aW1lUGF0aChyZXBvUm9vdCk7XG4gICAgY29uc3QgYnVuZGxlZFJlYWR5ID0gZXhpc3RzU3luYyhidW5kbGVkKTtcbiAgICAvLyBcdTg5RTNcdTY3OTAoXHU3RUQzXHU2NzlDXHU1RjUyXHU0RTAwOm92ZXJyaWRlPWJ1bmRsZWQgXHU4REVGXHU1Rjg0XHUyMTkyXHU1MTg1XHU3RjZFO1x1NkU5MFx1NzgwMSAudHMgXHU5NzAwIHRzeDtcbiAgICAvLyBucG0gXHU1Qjg5XHU4OEM1IC5qcyBcdTdGMTZcdThCRDFcdTRFQTdcdTcyNjlcdTc2RjRcdThERDE7YnVuZGxlZD1cdTgxRUFcdTUzMDVcdTU0MkIgY2pzIFx1NzZGNFx1OEREMSlcbiAgICBsZXQgZW50cnkgPSAnJztcbiAgICB1c2VCdW5kbGVkUnVudGltZSA9IGZhbHNlO1xuICAgIGlmIChmb3JjZUZha2UpIHtcbiAgICAgIC8vIFx1NkYxNFx1NzkzQVx1NkEyMVx1NUYwRlxuICAgIH0gZWxzZSBpZiAob3ZlcnJpZGUgIT09ICcnKSB7XG4gICAgICBlbnRyeSA9IG92ZXJyaWRlO1xuICAgICAgaWYgKG92ZXJyaWRlID09PSBidW5kbGVkKSB1c2VCdW5kbGVkUnVudGltZSA9IHRydWU7IC8vIFx1NTQxMVx1NUJGQ1x1OTAwOVwiXHU1MTg1XHU3RjZFXHU3Q0JFXHU3QjgwXHU1MTg1XHU2ODM4XCJcdTc2ODRcdTYzMDFcdTRFNDVcdTVGNjJcdTYwMDFcbiAgICB9IGVsc2UgaWYgKGZvcmNlQnVuZGxlZCkge1xuICAgICAgaWYgKGJ1bmRsZWRSZWFkeSkgeyBlbnRyeSA9IGJ1bmRsZWQ7IHVzZUJ1bmRsZWRSdW50aW1lID0gdHJ1ZTsgfVxuICAgICAgZWxzZSBsb2dJbmZvKCdob3N0JywgJ0hNSF9ERVNLVE9QX0JVTkRMRUQ9MSBcdTRGNDZcdTUxODVcdTdGNkUgcnVudGltZSBcdTdGM0FcdTU5MzEoXHU1MTQ4XHU4REQxIHNjcmlwdHMvYnVuZGxlLXJ1bnRpbWUubWpzKScpO1xuICAgIH0gZWxzZSB7XG4gICAgICBlbnRyeSA9IHBhY2thZ2VkID8gZGV0ZWN0UmVhbEVudHJ5KCkgOiAoZXhpc3RzU3luYyhhZGphY2VudCkgPyBhZGphY2VudCA6IGRldGVjdFJlYWxFbnRyeSgpKTtcbiAgICAgIGlmIChlbnRyeSA9PT0gJycgJiYgYnVuZGxlZFJlYWR5KSB7IGVudHJ5ID0gYnVuZGxlZDsgdXNlQnVuZGxlZFJ1bnRpbWUgPSB0cnVlOyB9XG4gICAgfVxuICAgIHJ1bnRpbWVFbnRyeSA9IGVudHJ5O1xuICAgIGNvbnN0IHVzZVJlYWwgPSBlbnRyeSAhPT0gJycgJiYgKHVzZUJ1bmRsZWRSdW50aW1lIHx8IGV4aXN0c1N5bmMoZW50cnkpKTtcbiAgICBicmlkZ2UgPSB7XG4gICAgICAuLi5icmlkZ2UsXG4gICAgICBtb2RlOiB1c2VSZWFsID8gJ3JlYWwnIDogJ2Zha2UnLFxuICAgICAgcnVudGltZUVudHJ5OiB1c2VSZWFsID8gKHVzZUJ1bmRsZWRSdW50aW1lID8gYCR7ZW50cnl9IChidW5kbGVkKWAgOiBlbnRyeSkgOiBudWxsLFxuICAgIH07XG4gICAgbGV0IHNwZWM6IHsgY29tbWFuZDogc3RyaW5nOyBhcmdzOiBzdHJpbmdbXTsgZW52OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+OyBjd2Q/OiBzdHJpbmcgfTtcbiAgICBpZiAodXNlQnVuZGxlZFJ1bnRpbWUpIHtcbiAgICAgIHNwZWMgPSB7XG4gICAgICAgIGNvbW1hbmQ6IHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgICAgIGFyZ3M6IFtlbnRyeV0sIC8vIFx1ODFFQVx1NTMwNVx1NTQyQlx1NTM1NVx1NjU4N1x1NEVGNjplbGVjdHJvbi1hcy1ub2RlIFx1NzZGNFx1OEREMSxcdTY1RTAgdHN4IFx1NjVFMCByZXBvXG4gICAgICAgIGVudjogeyBFTEVDVFJPTl9SVU5fQVNfTk9ERTogJzEnIH0sXG4gICAgICB9O1xuICAgIH0gZWxzZSBpZiAodXNlUmVhbCAmJiBlbnRyeS5lbmRzV2l0aCgnLmpzJykpIHtcbiAgICAgIHNwZWMgPSB7XG4gICAgICAgIGNvbW1hbmQ6IHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgICAgIGFyZ3M6IFtlbnRyeV0sIC8vIG5wbSBcdTVCODlcdTg4QzVcdTc2ODRcdTdGMTZcdThCRDFcdTRFQTdcdTcyNjk6RVNNIFx1NEY5RFx1OEQ1Nlx1NjMwOVx1NjU4N1x1NEVGNlx1NEY0RFx1N0Y2RVx1ODlFM1x1Njc5MCxcdTc2RjRcdThERDFcdTUzNzNcdTUzRUZcbiAgICAgICAgY3dkOiBkaXJuYW1lKGVudHJ5KSxcbiAgICAgICAgZW52OiB7IEVMRUNUUk9OX1JVTl9BU19OT0RFOiAnMScgfSxcbiAgICAgIH07XG4gICAgfSBlbHNlIGlmICh1c2VSZWFsKSB7XG4gICAgICBjb25zdCByZXBvID0gcmVwb1Jvb3RPZihlbnRyeSk7XG4gICAgICBzcGVjID0ge1xuICAgICAgICBjb21tYW5kOiBwcm9jZXNzLmV4ZWNQYXRoLFxuICAgICAgICBhcmdzOiBbJy0taW1wb3J0JywgJ3RzeCcsIGVudHJ5XSxcbiAgICAgICAgY3dkOiByZXBvLCAvLyBiYXJlICd0c3gnIFx1NEUwRSB3b3Jrc3BhY2UgXHU0RjlEXHU4RDU2XHU5MEZEXHU0RUNFIHJlcG8gXHU3Njg0IG5vZGVfbW9kdWxlcyBcdTg5RTNcdTY3OTBcbiAgICAgICAgZW52OiB7IEVMRUNUUk9OX1JVTl9BU19OT0RFOiAnMScgfSxcbiAgICAgIH07XG4gICAgfSBlbHNlIGlmIChwYWNrYWdlZCkge1xuICAgICAgc3BlYyA9IHtcbiAgICAgICAgY29tbWFuZDogcHJvY2Vzcy5leGVjUGF0aCxcbiAgICAgICAgYXJnczogW2pvaW4ocHJvY2Vzcy5yZXNvdXJjZXNQYXRoLCAnZmFrZS1ob3N0LmNqcycpXSxcbiAgICAgICAgZW52OiB7IEVMRUNUUk9OX1JVTl9BU19OT0RFOiAnMScgfSxcbiAgICAgIH07XG4gICAgfSBlbHNlIHtcbiAgICAgIHNwZWMgPSB7XG4gICAgICAgIGNvbW1hbmQ6IHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgICAgIC8vIFx1NzZGNFx1NjNBNVx1OEQ3MFx1NTMwNVx1NzcxRlx1NUI5RVx1OERFRlx1NUY4NChub2RlX21vZHVsZXMgXHU5MUNDXHU3Njg0IHdvcmtzcGFjZSBqdW5jdGlvbiBcdTRGMUFcdTg4QUIgRVNNXG4gICAgICAgIC8vIHJlYWxwYXRoIFx1NTMxNixcdTVCRkNcdTgxRjQgZmFrZS1ob3N0IFx1NzY4NCBhcmd2WzFdL2ltcG9ydC5tZXRhLnVybCBcdTUzMzlcdTkxNERcdTU5MzFcdTY1NDgpXG4gICAgICAgIGFyZ3M6IFsnLS1pbXBvcnQnLCAndHN4Jywgam9pbihyZXBvUm9vdCwgJ3BhY2thZ2VzJywgJ2hvc3QtYWRhcHRlcicsICdzcmMnLCAnZmFrZS1ob3N0LnRzJyldLFxuICAgICAgICBlbnY6IHsgRUxFQ1RST05fUlVOX0FTX05PREU6ICcxJyB9LFxuICAgICAgfTtcbiAgICB9XG4gICAgc3VwZXJ2aXNvciA9IG5ldyBEZXNrdG9wUnVudGltZVN1cGVydmlzb3Ioc3BlYywge1xuICAgICAgb25TdGF0ZUNoYW5nZTogYnJvYWRjYXN0SG9zdFN0YXRlLFxuICAgICAgLy8gXHU5OTk2XHU2QjIxXHU1NDJGXHU1MkE4XHU0RTBFIGNyYXNoIFx1ODFFQVx1NjEwOFx1NTQwRVx1NzY4NFx1OTFDRFx1NTQyRlx1OTBGRFx1NEYxQVx1OEQ3MFx1OEZEOVx1OTFDQzpcdTdBRUZcdTUzRTMvdG9rZW4gXHU5MEZEXHU2NjJGXHU2NUIwXHU3Njg0LFxuICAgICAgLy8gXHU5MUNEXHU1RUZBXHU2ODY1XHU1QkEyXHU2MjM3XHU3QUVGXHU1RTc2XHU5MUNEXHU2NUIwXHU4QkEyXHU5NjA1IFNTRShyZW5kZXJlciBcdTc2ODQgRXZlbnRTdG9yZSBcdTk3NjAgZXZlbnRJZCBcdTUzQkJcdTkxQ0QpXG4gICAgICBvblJlYWR5OiAoZXApID0+IHtcbiAgICAgICAgY2xpZW50ID0gbmV3IERlc2t0b3BIb3N0Q2xpZW50KGBodHRwOi8vMTI3LjAuMC4xOiR7ZXAucG9ydH1gLCBlcC50b2tlbik7XG4gICAgICAgIHNzZUFib3J0Py5hYm9ydCgpO1xuICAgICAgICBzc2VBYm9ydCA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgICAgICAgbGFzdEV2ZW50SWQgPSAnJztcbiAgICAgICAgdm9pZCBwdW1wRXZlbnRzKCk7XG4gICAgICAgIGxvZ0luZm8oJ2hvc3QnLCBgYnJpZGdlIHJlYWR5IG9uIDEyNy4wLjAuMToke2VwLnBvcnR9IChydW50aW1lICR7ZXAudmVyc2lvbn0sIG1vZGUgJHticmlkZ2UubW9kZX0ke3VzZVJlYWwgPyBgLCBlbnRyeT0ke3J1bnRpbWVFbnRyeX0ke3VzZUJ1bmRsZWRSdW50aW1lID8gJyBbYnVuZGxlZF0nIDogJyd9YCA6ICcnfSlgKTtcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IHN1cGVydmlzb3Iuc3RhcnQoKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGNvbnN0IGRldGFpbCA9ICgoKSA9PiB7IHRyeSB7IHJldHVybiBKU09OLnN0cmluZ2lmeShlcnIpOyB9IGNhdGNoIHsgcmV0dXJuIFN0cmluZyhlcnIpOyB9IH0pKCkuc2xpY2UoMCwgNDAwKTtcbiAgICAgIGJyaWRnZSA9IHsgLi4uYnJpZGdlLCBob3N0U3RhdGU6ICdmYWlsZWQnLCBsYXN0RXJyb3I6IGRldGFpbCB9O1xuICAgICAgbG9nSW5mbygnaG9zdCcsIGBzdGFydCBmYWlsZWQ6ICR7ZGV0YWlsfWApO1xuICAgIH1cbiAgfVxuXG4gIC8qIC0tLS0gSVBDIFx1NzY3RFx1NTQwRFx1NTM1NSArIHNlbmRlciBcdTY4MjFcdTlBOEMgLS0tLSAqL1xuICBjb25zdCBhbGxvd2VkT3JpZ2lucyA9IG5ldyBTZXQ8c3RyaW5nPihcbiAgICBpc0RldiAmJiByZW5kZXJlckRldlVybFxuICAgICAgPyBbcmVuZGVyZXJEZXZVcmxdXG4gICAgICA6IFtwYXRoVG9GaWxlVVJMKGpvaW4oaGVyZSwgJy4uJywgJy4uJywgJ2Rpc3QtcmVuZGVyZXInLCAnaW5kZXguaHRtbCcpKS5ocmVmXSxcbiAgKTtcblxuICBmdW5jdGlvbiBzZW5kZXJUcnVzdGVkKHNlbmRlckZyYW1lOiBFbGVjdHJvbi5XZWJGcmFtZU1haW4gfCBudWxsIHwgdW5kZWZpbmVkKTogYm9vbGVhbiB7XG4gICAgaWYgKHNlbmRlckZyYW1lID09PSBudWxsIHx8IHNlbmRlckZyYW1lID09PSB1bmRlZmluZWQpIHJldHVybiBmYWxzZTtcbiAgICBsZXQgdG9wOiBFbGVjdHJvbi5XZWJGcmFtZU1haW4gfCBudWxsID0gc2VuZGVyRnJhbWU7XG4gICAgd2hpbGUgKHRvcD8ucGFyZW50ICE9PSBudWxsICYmIHRvcD8ucGFyZW50ICE9PSB1bmRlZmluZWQpIHRvcCA9IHRvcC5wYXJlbnQ7XG4gICAgY29uc3QgdXJsID0gdG9wPy51cmwgPz8gJyc7XG4gICAgZm9yIChjb25zdCBvcmlnaW4gb2YgYWxsb3dlZE9yaWdpbnMpIHtcbiAgICAgIGlmICh1cmwgPT09IG9yaWdpbiB8fCB1cmwuc3RhcnRzV2l0aChgJHtvcmlnaW59L2ApIHx8IHVybC5zdGFydHNXaXRoKGAke29yaWdpbn0/YCkpIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICAvKiogXHU5NzAwXHU4OTgxIGhvc3QgXHU1QzMxXHU3RUVBXHU3Njg0IElQQyBoYW5kbGVyIFx1NTE2Q1x1NTE3MVx1NThGMzpcdTY3MkFcdTVDMzFcdTdFRUFcdThGRDRcdTU2REVcdTdFRDNcdTY3ODRcdTUzMTZcdTk1MTlcdThCRUZcdTMwMDIgKi9cbiAgZnVuY3Rpb24gaG9zdENhbGw8VD4oZXZlbnQ6IEVsZWN0cm9uLklwY01haW5JbnZva2VFdmVudCwgZm46IChjOiBEZXNrdG9wSG9zdENsaWVudCkgPT4gUHJvbWlzZTxUPik6IFByb21pc2U8VCB8IHsgZXJyb3I6IHN0cmluZzsgY29kZTogc3RyaW5nIH0+IHtcbiAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfSk7XG4gICAgaWYgKGNsaWVudCA9PT0gbnVsbCB8fCBicmlkZ2UuaG9zdFN0YXRlICE9PSAncmVhZHknKSB7XG4gICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6IGBob3N0IG5vdCByZWFkeSAoJHticmlkZ2UuaG9zdFN0YXRlfSlgLCBjb2RlOiAnSE9TVF9OT1RfUkVBRFknIH0pO1xuICAgIH1cbiAgICByZXR1cm4gZm4oY2xpZW50KS5jYXRjaCgoZXJyOiB1bmtub3duKSA9PiB7XG4gICAgICBjb25zdCBkZXRhaWwgPSAoKCkgPT4geyB0cnkgeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkoZXJyKTsgfSBjYXRjaCB7IHJldHVybiBTdHJpbmcoZXJyKTsgfSB9KSgpLnNsaWNlKDAsIDMwMCk7XG4gICAgICByZXR1cm4geyBlcnJvcjogZGV0YWlsLCBjb2RlOiAnQlJJREdFX0VSUk9SJyB9O1xuICAgIH0pO1xuICB9XG5cbiAgZnVuY3Rpb24gcmVnaXN0ZXJJcGMoKTogdm9pZCB7XG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpnZXQtc3RhdGUnLCAoZXZlbnQpID0+IHtcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicgfTtcbiAgICAgIHJldHVybiB7IC4uLmJyaWRnZSwgZHJvcHBlZEZyYW1lcyB9O1xuICAgIH0pO1xuXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpzZXNzaW9ucycsIChldmVudCkgPT5cbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPHsgc2Vzc2lvbnM6IEFycmF5PHsgaWQ6IHN0cmluZzsgdGl0bGU6IHN0cmluZzsgdGFzazogc3RyaW5nOyBvdXRjb21lOiBzdHJpbmc7IHR1cm5zOiBudW1iZXI7IHRvb2xVc2VzOiBudW1iZXI7IHRpbWU6IHN0cmluZzsgY3dkOiBzdHJpbmc7IGNyZWF0ZWRBdDogc3RyaW5nOyB1cGRhdGVkQXQ6IHN0cmluZyB9PiB9PignL2FwaS9zZXNzaW9ucz9saW1pdD0xMDAnKSkpO1xuXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpzZW5kLXRhc2snLCAoZXZlbnQsIHRleHQ6IHVua25vd24sIHNlc3Npb25JZDogdW5rbm93biwgbW9kZTogdW5rbm93biwgYXR0YWNobWVudHM6IHVua25vd24sIGltYWdlczogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3QgdGFzayA9IHR5cGVvZiB0ZXh0ID09PSAnc3RyaW5nJyA/IHRleHQuc2xpY2UoMCwgMjBfMDAwKSA6ICcnO1xuICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIHNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBzZXNzaW9uSWQuc2xpY2UoMCwgODApIDogJyc7XG4gICAgICBjb25zdCBtID0gbW9kZSA9PT0gJ2F1dG8nIHx8IG1vZGUgPT09ICd5b2xvJyA/IG1vZGUgOiAnYXNrJztcbiAgICAgIC8vIFx1OTY0NFx1NEVGNjpcdTU0MEVcdTdBRUZcdTYzODhcdTY3NDMgRFRPIFx1NzY4NFx1N0VERFx1NUJGOVx1OERFRlx1NUY4NChAIFx1OTAwOVx1NjJFOVx1NTY2OC9cdUQ4M0RcdURDQ0UgXHU0RTBBXHU0RjIwXHU1M0VBXHU2NzY1XHU4MUVBXHU2NzJDXHU1NzMwXHU2NTg3XHU0RUY2XHU3Q0ZCXHU3RURGKVxuICAgICAgY29uc3QgYXR0cyA9IEFycmF5LmlzQXJyYXkoYXR0YWNobWVudHMpID8gYXR0YWNobWVudHMuZmlsdGVyKChhKTogYSBpcyBzdHJpbmcgPT4gdHlwZW9mIGEgPT09ICdzdHJpbmcnKS5zbGljZSgwLCAxMCkgOiBbXTtcbiAgICAgIC8vIFx1NTZGRVx1NzI0NzpydW50aW1lIHZpc2lvbiBcdTk0RkVcdTUzNEZcdThCQUUge25hbWUsIGRhdGFVcmx9IGJhc2U2NChcdTIyNjQzIFx1NUYyMCBcdTIyNjQ2TUIscmVuZGVyZXIgXHU3NTFGXHU2MjEwKVxuICAgICAgY29uc3QgaW1ncyA9IEFycmF5LmlzQXJyYXkoaW1hZ2VzKVxuICAgICAgICA/IGltYWdlc1xuICAgICAgICAgICAgLmZpbHRlcigoaW0pOiBpbSBpcyB7IG5hbWU6IHN0cmluZzsgZGF0YVVybDogc3RyaW5nIH0gPT5cbiAgICAgICAgICAgICAgdHlwZW9mIGltID09PSAnb2JqZWN0JyAmJiBpbSAhPT0gbnVsbCAmJiB0eXBlb2YgKGltIGFzIHsgbmFtZT86IHVua25vd24gfSkubmFtZSA9PT0gJ3N0cmluZycgJiYgdHlwZW9mIChpbSBhcyB7IGRhdGFVcmw/OiB1bmtub3duIH0pLmRhdGFVcmwgPT09ICdzdHJpbmcnKVxuICAgICAgICAgICAgLnNsaWNlKDAsIDMpXG4gICAgICAgICAgICAubWFwKChpbSkgPT4gKHsgbmFtZTogaW0ubmFtZS5zbGljZSgwLCAxMjApLCBkYXRhVXJsOiBpbS5kYXRhVXJsLnNsaWNlKDAsIDhfNTAwXzAwMCkgfSkpXG4gICAgICAgIDogW107XG4gICAgICBpZiAodGFzayA9PT0gJycgfHwgc2lkID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IG9rOiBmYWxzZSwgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbjsgcnVuSWQ/OiBzdHJpbmcgfT4oJy9hcGkvdGFzaycsIHsgdGV4dDogdGFzaywgc2Vzc2lvbklkOiBzaWQsIG1vZGU6IG0sIGF0dGFjaG1lbnRzOiBhdHRzLCBpbWFnZXM6IGltZ3MgfSkpO1xuICAgIH0pO1xuXG4gICAgLy8gLS0tLSBcdTZBMjFcdTU3OEJcdTUyMDdcdTYzNjIocnVudGltZSBQT1NUIC9hcGkvbW9kZWw6XHU1MjA3IGNoYXQgXHU4REVGXHU3NTMxLGNvbmZpZyBcdTUzNzNcdTY1RjZcdTc1MUZcdTY1NDgpIC0tLS1cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOm1vZGVsLXNldCcsIChldmVudCwgbmFtZTogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3QgbiA9IHR5cGVvZiBuYW1lID09PSAnc3RyaW5nJyA/IG5hbWUudHJpbSgpLnNsaWNlKDAsIDgwKSA6ICcnO1xuICAgICAgaWYgKG4gPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICduYW1lIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbjsgbW9kZWw/OiBzdHJpbmcgfT4oJy9hcGkvbW9kZWwnLCB7IG5hbWU6IG4gfSkpO1xuICAgIH0pO1xuXG4gICAgLy8gLS0tLSBcdTVFOTRcdTc1MjhcdTUxODVcdTY2RjRcdTY1QjAoR2l0SHViIFJlbGVhc2VzO1x1ODFFQVx1NzgxNFx1OTZGNlx1NEY5RFx1OEQ1Nlx1NjZGNFx1NjVCMFx1NTY2OCkgLS0tLVxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6Y2hlY2stdXBkYXRlJywgYXN5bmMgKGV2ZW50KSA9PiB7XG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xuICAgICAgcmV0dXJuIGNoZWNrRm9yVXBkYXRlcygpO1xuICAgIH0pO1xuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6YXBwbHktdXBkYXRlJywgKGV2ZW50KSA9PiB7XG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xuICAgICAgaWYgKGluc3RhbGxlclBhdGggPT09IG51bGwpIHJldHVybiB7IGVycm9yOiAnbm8gaW5zdGFsbGVyIGRvd25sb2FkZWQnLCBjb2RlOiAnSE9TVF9OT1RfUkVBRFknIH07XG4gICAgICBhcHBseVVwZGF0ZSgpO1xuICAgICAgcmV0dXJuIHsgb2s6IHRydWUgfTtcbiAgICB9KTtcblxuICAgIC8vIC0tLS0gXHU2ODA3XHU5ODk4XHU2ODBGXHU0RTNCXHU5ODk4XHU1NDBDXHU2QjY1KFx1NkQ0NVx1ODI3Mlx1NkEyMVx1NUYwRlx1NEUwRFx1NTE4RFx1NjcwOVx1OUVEMVx1Njc2MSkrIFx1MjYzMCBcdTRFM0JcdTgzRENcdTUzNTUgLS0tLVxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6Y2hyb21lLXRoZW1lJywgKGV2ZW50LCBkYXJrOiB1bmtub3duKSA9PiB7XG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xuICAgICAgYXBwbHlDaHJvbWUoZGFyayA9PT0gdHJ1ZSk7XG4gICAgICByZXR1cm4geyBvazogdHJ1ZSB9O1xuICAgIH0pO1xuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cG9wdXAtbWFpbi1tZW51JywgKGV2ZW50KSA9PiB7XG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xuICAgICAgcG9wdXBNYWluTWVudSgpO1xuICAgICAgcmV0dXJuIHsgb2s6IHRydWUgfTtcbiAgICB9KTtcblxuICAgIC8vIC0tLS0gXHU2MjRCXHU2NzNBXHU4RkRDXHU3QTBCXHU2M0E3XHU1MjM2KDc3ODggd2ViIFx1NUI4OFx1NjJBNDtcdTc1MjhcdTYyMzdcdTY2M0VcdTVGMEZcdTU0MkZcdTUyQTgsQURSLTAwNSBcdTRFMERcdTlFRDhcdThCQTRcdTVGMDAgTEFOKSAtLS0tXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpyZW1vdGUtd2ViLXN0YXR1cycsIGFzeW5jIChldmVudCkgPT4ge1xuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcbiAgICAgIGNvbnN0IHAgPSBhd2FpdCBwcm9iZVdlYlJlbW90ZSgpO1xuICAgICAgcmV0dXJuIHsgdXA6IHAudXAsIHZlcnNpb246IHAudmVyc2lvbiwgbGFuSXA6IGxhbklwT2YoKSwgcG9ydDogV0VCX1BPUlQsIGF2YWlsYWJsZTogY2xpRW50cnlPZigpICE9PSAnJywgYXV0b3N0YXJ0OiB3ZWJBdXRvc3RhcnRJbnN0YWxsZWQoKSB9O1xuICAgIH0pO1xuICAgIC8vIC0tLS0gXHU1RjAwXHU2NzNBXHU4MUVBXHU1NDJGKDAuMjMuMzcgd2ViIGluc3RhbGwtZGFlbW9uL3VuaW5zdGFsbC1kYWVtb247XHU3NjdCXHU1RjU1XHU1MzczXHU1Qjg4XHU2MkE0XHU1NzI4XHU3RUJGKSAtLS0tXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpyZW1vdGUtd2ViLWF1dG9zdGFydCcsIGFzeW5jIChldmVudCwgZW5hYmxlZDogdW5rbm93bikgPT4ge1xuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcbiAgICAgIGlmIChjbGlFbnRyeU9mKCkgPT09ICcnKSByZXR1cm4geyBlcnJvcjogJ25vIGhtaGFybmVzcyBydW50aW1lIGRldGVjdGVkJywgY29kZTogJ0hPU1RfTk9UX1JFQURZJyB9O1xuICAgICAgcnVuQ2xpKFsnd2ViJywgZW5hYmxlZCA9PT0gdHJ1ZSA/ICdpbnN0YWxsLWRhZW1vbicgOiAndW5pbnN0YWxsLWRhZW1vbiddKTtcbiAgICAgIC8vIGluc3RhbGwtZGFlbW9uIFx1N0FDQlx1NTM3M1x1NjJDOVx1OEQ3N1x1NUI4OFx1NjJBNDpcdThGNkVcdThCRTJcdTc4NkVcdThCQTQ7dW5pbnN0YWxsIFx1NTM3M1x1NjVGNlx1NzUxRlx1NjU0OFxuICAgICAgaWYgKGVuYWJsZWQgPT09IHRydWUpIHtcbiAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCA1MDsgaSsrKSB7XG4gICAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgNTAwKSk7XG4gICAgICAgICAgaWYgKChhd2FpdCBwcm9iZVdlYlJlbW90ZSgpKS51cCkgcmV0dXJuIHsgb2s6IHRydWUsIGF1dG9zdGFydDogd2ViQXV0b3N0YXJ0SW5zdGFsbGVkKCkgfTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4geyBlcnJvcjogJ2RhZW1vbiBkaWQgbm90IGNvbWUgdXAgd2l0aGluIDI1cycsIGNvZGU6ICdSVU5USU1FX0NSQVNIRUQnIH07XG4gICAgICB9XG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgYXV0b3N0YXJ0OiB3ZWJBdXRvc3RhcnRJbnN0YWxsZWQoKSB9O1xuICAgIH0pO1xuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cmVtb3RlLXdlYi1zdGFydCcsIGFzeW5jIChldmVudCkgPT4ge1xuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcbiAgICAgIGlmIChjbGlFbnRyeU9mKCkgPT09ICcnKSByZXR1cm4geyBlcnJvcjogJ25vIGhtaGFybmVzcyBydW50aW1lIGRldGVjdGVkJywgY29kZTogJ0hPU1RfTk9UX1JFQURZJyB9O1xuICAgICAgaWYgKChhd2FpdCBwcm9iZVdlYlJlbW90ZSgpKS51cCkge1xuICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgYWxyZWFkeTogdHJ1ZSwgbGFuVXJsOiBgaHR0cDovLyR7bGFuSXBPZigpIHx8ICcxMjcuMC4wLjEnfToke1dFQl9QT1JUfWAgfTtcbiAgICAgIH1cbiAgICAgIHJ1bkNsaShbJ3dlYicsICdzdGFydCcsICctLWV4cG9zdXJlPWxhbiddKTtcbiAgICAgIC8vIFx1NUI4OFx1NjJBNFx1OEZEQlx1N0EwQlx1NTFCN1x1NTQyRlx1NTJBOCh0c3ggXHU3RjE2XHU4QkQxXHU2NTc0XHU1OTU3IENMSSk6XHU4RjZFXHU4QkUyIDI1c1xuICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCA1MDsgaSsrKSB7XG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDUwMCkpO1xuICAgICAgICBpZiAoKGF3YWl0IHByb2JlV2ViUmVtb3RlKCkpLnVwKSB7XG4gICAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGxhblVybDogYGh0dHA6Ly8ke2xhbklwT2YoKSB8fCAnMTI3LjAuMC4xJ306JHtXRUJfUE9SVH1gIH07XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIHJldHVybiB7IGVycm9yOiAnd2ViIGRhZW1vbiBkaWQgbm90IGNvbWUgdXAgd2l0aGluIDI1cyAoc2VlIEhNSF9IT01FL3dlYi5sb2cpJywgY29kZTogJ1JVTlRJTUVfQ1JBU0hFRCcgfTtcbiAgICB9KTtcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnJlbW90ZS13ZWItc3RvcCcsIGFzeW5jIChldmVudCkgPT4ge1xuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcbiAgICAgIHJ1bkNsaShbJ3dlYicsICdzdG9wJ10pO1xuICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCAyMDsgaSsrKSB7XG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDQwMCkpO1xuICAgICAgICBpZiAoIShhd2FpdCBwcm9iZVdlYlJlbW90ZSgpKS51cCkgcmV0dXJuIHsgb2s6IHRydWUgfTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHN0aWxsID0gKGF3YWl0IHByb2JlV2ViUmVtb3RlKCkpLnVwO1xuICAgICAgcmV0dXJuIHN0aWxsID8geyBlcnJvcjogJ3N0aWxsIHJ1bm5pbmcnLCBjb2RlOiAnQlJJREdFX0VSUk9SJyB9IDogeyBvazogdHJ1ZSB9O1xuICAgIH0pO1xuXG4gICAgLy8gLS0tLSBcdUQ4M0RcdURDQ0UgXHU2NTg3XHU0RUY2XHU0RTBBXHU0RjIwKFx1NjcyQ1x1NTczMFx1NTkxQVx1OTAwOTtydW50aW1lIFx1NjgyMVx1OUE4QyBpbnNpZGVXcyxcdTVERTVcdTRGNUNcdTUzM0FcdTU5MTZcdTY1ODdcdTRFRjZcdTRGMUFcdTg4QUIgNDAwKSAtLS0tXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpwaWNrLWZpbGVzJywgYXN5bmMgKGV2ZW50LCB0aXRsZTogdW5rbm93bikgPT4ge1xuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcbiAgICAgIGNvbnN0IHdpbiA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmZpbmQoKHcpID0+ICF3LmlzRGVzdHJveWVkKCkpO1xuICAgICAgaWYgKHdpbiA9PT0gdW5kZWZpbmVkKSByZXR1cm4geyBlcnJvcjogJ25vIHdpbmRvdycsIGNvZGU6ICdCUklER0VfRVJST1InIH07XG4gICAgICBjb25zdCByID0gYXdhaXQgZGlhbG9nLnNob3dPcGVuRGlhbG9nKHdpbiwge1xuICAgICAgICB0aXRsZTogdHlwZW9mIHRpdGxlID09PSAnc3RyaW5nJyAmJiB0aXRsZSAhPT0gJycgPyB0aXRsZS5zbGljZSgwLCAxMjApIDogJ1x1OTAwOVx1NjJFOVx1ODk4MVx1OTY0NFx1NTJBMFx1NzY4NFx1NjU4N1x1NEVGNihcdTUzRUZcdTU5MUFcdTkwMDkpJyxcbiAgICAgICAgcHJvcGVydGllczogWydvcGVuRmlsZScsICdtdWx0aVNlbGVjdGlvbnMnXSxcbiAgICAgIH0pO1xuICAgICAgaWYgKHIuY2FuY2VsZWQgfHwgci5maWxlUGF0aHMubGVuZ3RoID09PSAwKSByZXR1cm4geyBvazogZmFsc2UsIGNhbmNlbGVkOiB0cnVlIH07XG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgcGF0aHM6IHIuZmlsZVBhdGhzLnNsaWNlKDAsIDEwKSB9O1xuICAgIH0pO1xuXG4gICAgLy8gLS0tLSBcdUQ4M0RcdURDQzEgXHU3NkVFXHU1RjU1XHU5MDA5XHU2MkU5KFx1NURFNVx1NEY1Q1x1NTMzQVx1NkRGQlx1NTJBMFx1NzY4NFx1NkQ0Rlx1ODlDOFx1NjMwOVx1OTRBRTtcdTUzOUZcdTc1MUYgY2hvb3NlcikgLS0tLVxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cGljay1kaXJlY3RvcnknLCBhc3luYyAoZXZlbnQsIHRpdGxlOiB1bmtub3duKSA9PiB7XG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xuICAgICAgY29uc3Qgd2luID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkuZmluZCgodykgPT4gIXcuaXNEZXN0cm95ZWQoKSk7XG4gICAgICBpZiAod2luID09PSB1bmRlZmluZWQpIHJldHVybiB7IGVycm9yOiAnbm8gd2luZG93JywgY29kZTogJ0JSSURHRV9FUlJPUicgfTtcbiAgICAgIGNvbnN0IHIgPSBhd2FpdCBkaWFsb2cuc2hvd09wZW5EaWFsb2cod2luLCB7XG4gICAgICAgIHRpdGxlOiB0eXBlb2YgdGl0bGUgPT09ICdzdHJpbmcnICYmIHRpdGxlICE9PSAnJyA/IHRpdGxlLnNsaWNlKDAsIDEyMCkgOiAnXHU5MDA5XHU2MkU5XHU2NTg3XHU0RUY2XHU1OTM5JyxcbiAgICAgICAgcHJvcGVydGllczogWydvcGVuRGlyZWN0b3J5J10sXG4gICAgICB9KTtcbiAgICAgIGlmIChyLmNhbmNlbGVkIHx8IHIuZmlsZVBhdGhzWzBdID09PSB1bmRlZmluZWQpIHJldHVybiB7IG9rOiBmYWxzZSwgY2FuY2VsZWQ6IHRydWUgfTtcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBwYXRoOiByLmZpbGVQYXRoc1swXSB9O1xuICAgIH0pO1xuXG4gICAgLy8gLS0tLSBAIFx1OTY0NFx1NEVGNjpcdTVERTVcdTRGNUNcdTUzM0FcdTY1ODdcdTRFRjZcdTY0MUNcdTdEMjIocnVudGltZSBcdTYzODhcdTY3NDNcdTc2ODRcdThERUZcdTVGODRcdTY3NjVcdTZFOTApIC0tLS1cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmZzLXNlYXJjaCcsIChldmVudCwgcTogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3QgcXVlcnkgPSB0eXBlb2YgcSA9PT0gJ3N0cmluZycgPyBxLnNsaWNlKDAsIDIwMCkgOiAnJztcbiAgICAgIGlmIChxdWVyeSA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyByZXN1bHRzOiBbXSB9KTtcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjx7IHJlc3VsdHM6IEFycmF5PHsgcmVsOiBzdHJpbmc7IHBhdGg6IHN0cmluZyB9PiB9PihgL2FwaS9mcy9zZWFyY2g/cT0ke2VuY29kZVVSSUNvbXBvbmVudChxdWVyeSl9YCkpO1xuICAgIH0pO1xuXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTphcHByb3ZlJywgKGV2ZW50LCBncmFudGVkOiB1bmtub3duLCBzZXNzaW9uSWQ6IHVua25vd24pID0+XG4gICAgICBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PignL2FwaS9hcHByb3ZlJywge1xuICAgICAgICBncmFudGVkOiBncmFudGVkID09PSB0cnVlLFxuICAgICAgICBzZXNzaW9uSWQ6IHR5cGVvZiBzZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gc2Vzc2lvbklkLnNsaWNlKDAsIDgwKSA6ICcnLFxuICAgICAgfSkpKTtcblxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6aW50ZXJydXB0JywgKGV2ZW50LCBzZXNzaW9uSWQ6IHVua25vd24pID0+XG4gICAgICBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PignL2FwaS9pbnRlcnJ1cHQnLCB7XG4gICAgICAgIHNlc3Npb25JZDogdHlwZW9mIHNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBzZXNzaW9uSWQuc2xpY2UoMCwgODApIDogJycsXG4gICAgICB9KSkpO1xuXG4gICAgLy8gLS0tLSBNNDpcdTVERTVcdTRGNUNcdTUzM0FcdTY1ODdcdTRFRjZcdTk3NjIoXHU4REVGXHU1Rjg0XHU2Mzg4XHU2NzQzXHU1NzI4IHJ1bnRpbWU6aW5zaWRlV3MgXHU2ODIxXHU5QThDKSAtLS0tXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpmcy1saXN0JywgKGV2ZW50LCBwYXRoOiB1bmtub3duKSA9PiB7XG4gICAgICBjb25zdCBwID0gdHlwZW9mIHBhdGggPT09ICdzdHJpbmcnID8gcGF0aC5zbGljZSgwLCAxMDAwKSA6ICcnO1xuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPFJlY29yZDxzdHJpbmcsIHVua25vd24+PihgL2FwaS9mcz9maWxlcz0xJHtwICE9PSAnJyA/IGAmcGF0aD0ke2VuY29kZVVSSUNvbXBvbmVudChwKX1gIDogJyd9YCkpO1xuICAgIH0pO1xuXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpmcy1yZWFkJywgKGV2ZW50LCBwYXRoOiB1bmtub3duKSA9PiB7XG4gICAgICBjb25zdCBwID0gdHlwZW9mIHBhdGggPT09ICdzdHJpbmcnID8gcGF0aC5zbGljZSgwLCAxMDAwKSA6ICcnO1xuICAgICAgaWYgKHAgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICdwYXRoIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oYC9hcGkvZnMvcmVhZD9wYXRoPSR7ZW5jb2RlVVJJQ29tcG9uZW50KHApfWApKTtcbiAgICB9KTtcblxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6aW5qZWN0JywgKGV2ZW50LCB0ZXh0OiB1bmtub3duLCBzZXNzaW9uSWQ6IHVua25vd24pID0+IHtcbiAgICAgIGNvbnN0IHQgPSB0eXBlb2YgdGV4dCA9PT0gJ3N0cmluZycgPyB0ZXh0LnNsaWNlKDAsIDIwXzAwMCkgOiAnJztcbiAgICAgIGNvbnN0IHNpZCA9IHR5cGVvZiBzZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gc2Vzc2lvbklkLnNsaWNlKDAsIDgwKSA6ICcnO1xuICAgICAgaWYgKHQgPT09ICcnIHx8IHNpZCA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBvazogZmFsc2UsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvaW5qZWN0JywgeyB0ZXh0OiB0LCBzZXNzaW9uSWQ6IHNpZCB9KSk7XG4gICAgfSk7XG5cbiAgICAvLyAtLS0tIFx1NEYxQVx1OEJERFx1NUJGQ1x1NTFGQShleHBvcnQubWQgXHUyMTkyIFx1NEZERFx1NUI1OFx1NUJGOVx1OEJERFx1Njg0NjtcdTY1ODdcdTRFRjZcdTUxOTlcdTUxNjVcdTUzRUFcdTU3MjggbWFpbikgLS0tLVxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6ZXhwb3J0LXNlc3Npb24nLCBhc3luYyAoZXZlbnQsIGlkOiB1bmtub3duLCB0aXRsZTogdW5rbm93bikgPT4ge1xuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcbiAgICAgIGNvbnN0IHNpZCA9IHR5cGVvZiBpZCA9PT0gJ3N0cmluZycgPyBpZC5yZXBsYWNlKC9bXmEtekEtWjAtOV86LkAtXS9nLCAnJykuc2xpY2UoMCwgODApIDogJyc7XG4gICAgICBpZiAoc2lkID09PSAnJykgcmV0dXJuIHsgZXJyb3I6ICdpZCByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfTtcbiAgICAgIGlmIChjbGllbnQgPT09IG51bGwgfHwgYnJpZGdlLmhvc3RTdGF0ZSAhPT0gJ3JlYWR5JykgcmV0dXJuIHsgZXJyb3I6IGBob3N0IG5vdCByZWFkeSAoJHticmlkZ2UuaG9zdFN0YXRlfSlgLCBjb2RlOiAnSE9TVF9OT1RfUkVBRFknIH07XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBtZCA9IGF3YWl0IGNsaWVudC5nZXRUZXh0KGAvYXBpL3Nlc3Npb25zLyR7ZW5jb2RlVVJJQ29tcG9uZW50KHNpZCl9L2V4cG9ydC5tZGApO1xuICAgICAgICBjb25zdCB3aW4gPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5maW5kKCh3KSA9PiAhdy5pc0Rlc3Ryb3llZCgpKTtcbiAgICAgICAgaWYgKHdpbiA9PT0gdW5kZWZpbmVkKSByZXR1cm4geyBlcnJvcjogJ25vIHdpbmRvdycsIGNvZGU6ICdCUklER0VfRVJST1InIH07XG4gICAgICAgIGNvbnN0IHIgPSBhd2FpdCBkaWFsb2cuc2hvd1NhdmVEaWFsb2cod2luLCB7XG4gICAgICAgICAgdGl0bGU6IHR5cGVvZiB0aXRsZSA9PT0gJ3N0cmluZycgJiYgdGl0bGUgIT09ICcnID8gdGl0bGUuc2xpY2UoMCwgODApIDogJ1x1NUJGQ1x1NTFGQVx1NEYxQVx1OEJERCcsXG4gICAgICAgICAgZGVmYXVsdFBhdGg6IGBobWgtJHtzaWR9Lm1kYCxcbiAgICAgICAgICBmaWx0ZXJzOiBbeyBuYW1lOiAnTWFya2Rvd24nLCBleHRlbnNpb25zOiBbJ21kJ10gfV0sXG4gICAgICAgIH0pO1xuICAgICAgICBpZiAoci5jYW5jZWxlZCB8fCByLmZpbGVQYXRoID09PSB1bmRlZmluZWQgfHwgci5maWxlUGF0aCA9PT0gJycpIHJldHVybiB7IG9rOiBmYWxzZSwgY2FuY2VsZWQ6IHRydWUgfTtcbiAgICAgICAgYXdhaXQgd3JpdGVGaWxlKHIuZmlsZVBhdGgsIG1kLCAndXRmOCcpO1xuICAgICAgICBsb2dJbmZvKCdleHBvcnQnLCBgc2Vzc2lvbiAke3NpZH0gXHUyMTkyICR7ci5maWxlUGF0aH1gKTtcbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHBhdGg6IHIuZmlsZVBhdGggfTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBjb25zdCBkZXRhaWwgPSAoKCkgPT4geyB0cnkgeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkoZXJyKTsgfSBjYXRjaCB7IHJldHVybiBTdHJpbmcoZXJyKTsgfSB9KSgpLnNsaWNlKDAsIDMwMCk7XG4gICAgICAgIHJldHVybiB7IGVycm9yOiBkZXRhaWwsIGNvZGU6ICdCUklER0VfRVJST1InIH07XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICAvLyAtLS0tIFx1NUJBMVx1NjI3OVx1NkEyMVx1NUYwRlx1OEJGQlx1NTE5OShcdTY3NDNcdTVBMDFcdTU3MjggcnVudGltZSBjb25maWc7XHU1MjA3XHU2MzYyXHU1RkM1XHU5ODdCXHU2NjNFXHU1RjBGKSAtLS0tXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTphcHByb3ZhbC1nZXQnLCAoZXZlbnQpID0+XG4gICAgICBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjx7IHNldHRpbmdzPzogeyBhcHByb3ZhbD86IHN0cmluZyB9IH0+KCcvYXBpL3N0YXRlJykpKTtcblxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6YXBwcm92YWwtc2V0JywgKGV2ZW50LCBtb2RlOiB1bmtub3duKSA9PiB7XG4gICAgICBjb25zdCBtID0gbW9kZSA9PT0gJ2F1dG8nID8gJ2F1dG8nIDogbW9kZSA9PT0gJ2FzaycgPyAnYXNrJyA6ICcnO1xuICAgICAgaWYgKG0gPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICdtb2RlIG11c3QgYmUgYXNrfGF1dG8nLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KCcvYXBpL2NvbmZpZycsIHsgYXBwcm92YWw6IG0gfSkpO1xuICAgIH0pO1xuXG4gICAgLy8gLS0tLSBobWhhcm5lc3MgcnVudGltZSBcdThGREVcdTYzQTUoXHU4MUVBXHU1MkE4XHU1M0QxXHU3M0IwICsgXHU2MjRCXHU1MkE4XHU4OTg2XHU3NkQ2ICsgXHU3MEVEXHU1MjA3XHU2MzYyKSAtLS0tXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpydW50aW1lLWluZm8nLCBhc3luYyAoZXZlbnQpID0+IHtcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XG4gICAgICBjb25zdCBkID0gZGV0ZWN0RXh0ZXJuYWxSdW50aW1lKCk7XG4gICAgICBjb25zdCBjZmcgPSBhd2FpdCBsb2FkUnVudGltZUNvbmZpZygpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgbW9kZTogYnJpZGdlLm1vZGUsXG4gICAgICAgIHJ1bnRpbWVFbnRyeTogYnJpZGdlLnJ1bnRpbWVFbnRyeSxcbiAgICAgICAgb3ZlcnJpZGU6IGNmZy5lbnRyeSxcbiAgICAgICAgZGVtbzogY2ZnLmRlbW8sXG4gICAgICAgIGRldGVjdGVkOiBkLmVudHJ5LFxuICAgICAgICBkZXRlY3RlZFZlcnNpb246IGQudmVyc2lvbixcbiAgICAgICAgZGV0ZWN0ZWRTb3VyY2U6IGQuc291cmNlLFxuICAgICAgfTtcbiAgICB9KTtcblxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6YnJvd3NlLXJ1bnRpbWUnLCBhc3luYyAoZXZlbnQsIHRpdGxlOiB1bmtub3duKSA9PiB7XG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xuICAgICAgY29uc3Qgd2luID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkuZmluZCgodykgPT4gIXcuaXNEZXN0cm95ZWQoKSk7XG4gICAgICBpZiAod2luID09PSB1bmRlZmluZWQpIHJldHVybiB7IGVycm9yOiAnbm8gd2luZG93JywgY29kZTogJ0JSSURHRV9FUlJPUicgfTtcbiAgICAgIGNvbnN0IHIgPSBhd2FpdCBkaWFsb2cuc2hvd09wZW5EaWFsb2cod2luLCB7XG4gICAgICAgIHRpdGxlOiB0eXBlb2YgdGl0bGUgPT09ICdzdHJpbmcnICYmIHRpdGxlICE9PSAnJyA/IHRpdGxlLnNsaWNlKDAsIDEyMCkgOiAnXHU5MDA5XHU2MkU5IGhtaGFybmVzcyBcdTc2ODQgZGVza3RvcC1ob3N0IFx1NTE2NVx1NTNFMycsXG4gICAgICAgIHByb3BlcnRpZXM6IFsnb3BlbkZpbGUnXSxcbiAgICAgICAgZmlsdGVyczogW3sgbmFtZTogJ2Rlc2t0b3AtaG9zdCcsIGV4dGVuc2lvbnM6IFsndHMnLCAnanMnXSB9XSxcbiAgICAgIH0pO1xuICAgICAgaWYgKHIuY2FuY2VsZWQgfHwgci5maWxlUGF0aHNbMF0gPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBjYW5jZWxlZDogdHJ1ZSB9O1xuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGVudHJ5OiByLmZpbGVQYXRoc1swXSB9O1xuICAgIH0pO1xuXG4gICAgLyoqIFx1OEJCRVx1N0Y2RS9cdTZFMDVcdTk2NjRcdTYyNEJcdTUyQThcdTUxNjVcdTUzRTNcdTU0MEVcdTcwRURcdTkxQ0RcdTU0MkYgaG9zdChcdTdBN0FcdTRFMzI9XHU1NkRFXHU1MjMwXHU4MUVBXHU1MkE4XHU1M0QxXHU3M0IwKVx1MzAwMiAqL1xuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6c2V0LXJ1bnRpbWUnLCBhc3luYyAoZXZlbnQsIGVudHJ5OiB1bmtub3duKSA9PiB7XG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xuICAgICAgY29uc3QgZSA9IHR5cGVvZiBlbnRyeSA9PT0gJ3N0cmluZycgPyBlbnRyeS50cmltKCkgOiAnJztcbiAgICAgIGlmIChlICE9PSAnJyAmJiAoIWlzQWJzb2x1dGUoZSkgfHwgIWV4aXN0c1N5bmMoZSkpKSB7XG4gICAgICAgIHJldHVybiB7IGVycm9yOiAnXHU1MTY1XHU1M0UzXHU1RkM1XHU5ODdCXHU2NjJGXHU1QjU4XHU1NzI4XHU3Njg0XHU3RUREXHU1QkY5XHU4REVGXHU1Rjg0KGRlc2t0b3AtaG9zdC50cyknLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH07XG4gICAgICB9XG4gICAgICBhd2FpdCBzYXZlUnVudGltZUVudHJ5T3ZlcnJpZGUoZSk7XG4gICAgICAvLyBcdTcwRURcdTUyMDdcdTYzNjI6XHU1MTQ4XHU0RjE4XHU5NkM1XHU1MDVDXHU2Mzg5XHU1RjUzXHU1MjREIGhvc3QsXHU1MThEXHU2MzA5XHU2NUIwXHU5MTREXHU3RjZFXHU2MkM5XHU4RDc3XG4gICAgICBzc2VBYm9ydD8uYWJvcnQoKTtcbiAgICAgIGlmIChzdXBlcnZpc29yICE9PSBudWxsKSBhd2FpdCBzdXBlcnZpc29yLnN0b3AoKTtcbiAgICAgIGF3YWl0IHN0YXJ0SG9zdCgpO1xuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIG1vZGU6IGJyaWRnZS5tb2RlIH07XG4gICAgfSk7XG5cbiAgICAvLyAtLS0tIHY1LjEgXHU5OTk2XHU1NDJGXHU1Qjg5XHU4OEM1XHU1NDExXHU1QkZDOlx1NjcyQ1x1NjczQVx1NjhDMFx1NkQ0QiAvIFx1NEUwQlx1OEY3RFx1NUI4OVx1ODhDNShcdThGREJcdTVFQTZcdTRFOEJcdTRFRjYpIC8gXHU1NDExXHU1QkZDXHU3MkI2XHU2MDAxIC0tLS1cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmRldGVjdC1ydW50aW1lJywgKGV2ZW50KSA9PiB7XG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xuICAgICAgY29uc3QgaW5mbyA9IGJ1bmRsZWRSdW50aW1lSW5mbygpO1xuICAgICAgLy8gVUlWRVJJRlkgXHU1NDExXHU1QkZDXHU2QjY1XHU3Njg0XCJcdTRGMkFcdTkwMjBcdTY3MkFcdTkxNERcdTdGNkVcdTYwMDFcIjpmYWtlIFx1NkEyMVx1NUYwRlx1NEUwQlx1NjA1Mlx1NjJBNVx1NjcyQVx1NjhDMFx1NkQ0QlxuICAgICAgLy8gKFx1NzcxRlx1NUI5RVx1NjhDMFx1NkQ0Qlx1OERFRlx1NUY4NFx1NzUzMSByZWFsIFx1NTNEOFx1NEY1M1x1OUE4Q1x1NjUzNixcdTg5QzEgZXZpZGVuY2Uvc2V0dXAtd2l6YXJkLylcbiAgICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9XSVpBUkQgPT09ICdmYWtlJyAmJiBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9GQUtFID09PSAnMScpIHtcbiAgICAgICAgcmV0dXJuIHsgZm91bmQ6IGZhbHNlLCB2ZXJzaW9uOiAnJywgZW50cnk6ICcnLCBzb3VyY2U6ICcnLCBidW5kbGVkOiBpbmZvLCBucG06IG5wbU9uUGF0aCgpIH07XG4gICAgICB9XG4gICAgICBjb25zdCBkID0gZGV0ZWN0RXh0ZXJuYWxSdW50aW1lKCk7XG4gICAgICByZXR1cm4geyBmb3VuZDogZC5lbnRyeSAhPT0gJycsIHZlcnNpb246IGQudmVyc2lvbiwgZW50cnk6IGQuZW50cnksIHNvdXJjZTogZC5zb3VyY2UsIGJ1bmRsZWQ6IGluZm8sIG5wbTogbnBtT25QYXRoKCkgfTtcbiAgICB9KTtcblxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6aW5zdGFsbC1jbGknLCAoZXZlbnQsIG9wdHM6IHVua25vd24pID0+IHtcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XG4gICAgICBjb25zdCBvID0gKG9wdHMgPz8ge30pIGFzIHsgZm9yY2VUZ3o/OiB1bmtub3duOyBtaXJyb3JGaXJzdD86IHVua25vd24gfTtcbiAgICAgIHJldHVybiBzdGFydENsaUluc3RhbGwoXG4gICAgICAgIHtcbiAgICAgICAgICBzZW5kUHJvZ3Jlc3M6IChwOiBJbnN0YWxsUHJvZ3Jlc3MpOiB2b2lkID0+IHtcbiAgICAgICAgICAgIGxvZ0luZm8oJ2luc3RhbGwnLCBgJHtwLnBoYXNlfSR7cC5wY3QgIT09IHVuZGVmaW5lZCA/IGAgJHtwLnBjdH0lYCA6ICcnfSAke3AudGV4dH1gKTtcbiAgICAgICAgICAgIGZvciAoY29uc3QgdyBvZiBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKSkge1xuICAgICAgICAgICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCdpbnN0YWxsOnByb2dyZXNzJywgcCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSxcbiAgICAgICAgICBsb2c6IChtOiBzdHJpbmcpOiB2b2lkID0+IHsgbG9nSW5mbygnaW5zdGFsbCcsIG0pOyB9LFxuICAgICAgICAgIC8vIFx1NUI4OVx1ODhDNVx1NjIxMFx1NTI5Rlx1NTM3M1x1NjMwMVx1NEU0NVx1NTMxNlx1NUU3Nlx1NzBFRFx1NTIwN1x1NjM2MihcdTU0MTFcdTVCRkNcdTk2OEZcdTU0MEVcdTY1MzZcdTVDM0U7XHU0RTJEXHU5MDE0XHU1M0Q2XHU2RDg4XHU0RTVGXHU1REYyXHU3NTFGXHU2NTQ4KVxuICAgICAgICAgIG9uSW5zdGFsbGVkOiAoZW50cnk6IHN0cmluZyk6IHZvaWQgPT4ge1xuICAgICAgICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgICBhd2FpdCBzYXZlUnVudGltZUNvbmZpZyh7IGVudHJ5LCBkZW1vOiBmYWxzZSB9KTtcbiAgICAgICAgICAgICAgc3NlQWJvcnQ/LmFib3J0KCk7XG4gICAgICAgICAgICAgIGlmIChzdXBlcnZpc29yICE9PSBudWxsKSBhd2FpdCBzdXBlcnZpc29yLnN0b3AoKTtcbiAgICAgICAgICAgICAgYXdhaXQgc3RhcnRIb3N0KCk7XG4gICAgICAgICAgICB9KSgpO1xuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBmb3JjZVRnejogby5mb3JjZVRneiA9PT0gdHJ1ZSxcbiAgICAgICAgICBtaXJyb3JGaXJzdDogby5taXJyb3JGaXJzdCA9PT0gJ25wbW1pcnJvcicgPyAnbnBtbWlycm9yJyA6IG8ubWlycm9yRmlyc3QgPT09ICducG1qcycgPyAnbnBtanMnIDogdW5kZWZpbmVkLFxuICAgICAgICB9LFxuICAgICAgKTtcbiAgICB9KTtcblxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6Z2V0LXdpemFyZCcsIGFzeW5jIChldmVudCkgPT4ge1xuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcbiAgICAgIGNvbnN0IHZhcmlhbnQgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9XSVpBUkQ7XG4gICAgICBpZiAodmFyaWFudCAhPT0gdW5kZWZpbmVkICYmIHZhcmlhbnQgIT09ICcnKSB7XG4gICAgICAgIC8vIFx1OUE4Q1x1NjUzNlx1Njc4NFx1OTAyMDpcdTVGM0FcdTUyMzZcdTU0MTFcdTVCRkNcdTUzRUZcdTg5QzFcdTRFMTRcdTg5QzZcdTRFM0FcdTY3MkFcdTkxNERcdTdGNkUoXHU1M0VGXHU5MUNEXHU1OTBEXHU4REQxKTtwZXJzaXN0ZWQ9XHU3NzFGXHU1QjlFXHU4NDNEXHU3NkQ4XG4gICAgICAgIC8vIFx1NzJCNlx1NjAwMShcdTU0MTFcdTVCRkNcdTZCNjVcdTY1QURcdThBMDBcIlx1OTAwOVx1NjJFOVx1NjMwMVx1NEU0NVwiXHU3NTI4LFx1NEUwRFx1NUY3MVx1NTRDRCBVSSBcdTUyMjRcdTVCOUEpXG4gICAgICAgIGNvbnN0IHcgPSBhd2FpdCBsb2FkV2l6YXJkU3RhdGUoKTtcbiAgICAgICAgcmV0dXJuIHsgZG9uZTogZmFsc2UsIGNob2ljZTogJycsIHN1cHByZXNzZWQ6IGZhbHNlLCBwZXJzaXN0ZWQ6IHsgZG9uZTogdy5kb25lLCBjaG9pY2U6IHcuY2hvaWNlIH0gfTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHcgPSBhd2FpdCBsb2FkV2l6YXJkU3RhdGUoKTtcbiAgICAgIGNvbnN0IGNmZyA9IGF3YWl0IGxvYWRSdW50aW1lQ29uZmlnKCk7XG4gICAgICAvLyBcdTVERjJcdTkxNERcdTdGNkVcdThGQzcgcnVudGltZShcdTYyNEJcdTUyQThcdTUxNjVcdTUzRTMvXHU1NDExXHU1QkZDXHU5MDA5XHU2MkU5L1x1NkYxNFx1NzkzQSlcdTg5QzZcdTU0MENcdTVERjJcdTVCOENcdTYyMTBcdTk5OTZcdTU0MkZcbiAgICAgIHJldHVybiB7IGRvbmU6IHcuZG9uZSB8fCBjZmcuZW50cnkgIT09ICcnIHx8IGNmZy5kZW1vLCBjaG9pY2U6IHcuY2hvaWNlLCBzdXBwcmVzc2VkOiB3aXphcmRTdXBwcmVzc2VkKCkgfTtcbiAgICB9KTtcblxuICAgIC8qKiBcdTU0MTFcdTVCRkNcdTY1MzZcdTVDM0U6XHU2MzAxXHU0RTQ1XHU1MzE2XHU5MDA5XHU2MkU5XHU1RTc2XHU1RTk0XHU3NTI4KGV4dGVybmFsL2J1bmRsZWRcdTIxOTJcdTUxNjVcdTUzRTNcdTg5ODZcdTc2RDY7ZGVtb1x1MjE5Mlx1NjMwMVx1NEU0NVx1NkYxNFx1NzkzQTtcbiAgICAgKiAgaW5zdGFsbFx1MjE5Mlx1NTE2NVx1NTNFM1x1NURGMlx1NzUzMVx1NUI4OVx1ODhDNVx1NTY2OFx1NjMwMVx1NEU0NVx1NTMxNixcdTUzRUFcdThCQjBcdTcyQjZcdTYwMDEpXHUzMDAyZmFrZS9cdTZENEJcdThCRDVcdTczQUZcdTU4ODNcdTUzRUFcdThCQjBcdTcyQjZcdTYwMDFcdTMwMDIgKi9cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOndpemFyZC1jb21wbGV0ZScsIGFzeW5jIChldmVudCwgY2hvaWNlOiB1bmtub3duLCBlbnRyeTogdW5rbm93bikgPT4ge1xuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcbiAgICAgIGNvbnN0IGMgPSBjaG9pY2UgPT09ICdleHRlcm5hbCcgfHwgY2hvaWNlID09PSAnaW5zdGFsbCcgfHwgY2hvaWNlID09PSAnYnVuZGxlZCcgfHwgY2hvaWNlID09PSAnZGVtbycgPyBjaG9pY2UgOiAnJztcbiAgICAgIGlmIChjID09PSAnJykgcmV0dXJuIHsgZXJyb3I6ICdjaG9pY2UgbXVzdCBiZSBleHRlcm5hbHxpbnN0YWxsfGJ1bmRsZWR8ZGVtbycsIGNvZGU6ICdCQURfUkVRVUVTVCcgfTtcbiAgICAgIGNvbnN0IGUgPSB0eXBlb2YgZW50cnkgPT09ICdzdHJpbmcnID8gZW50cnkgOiAnJztcbiAgICAgIGF3YWl0IHNhdmVXaXphcmRTdGF0ZShjKTtcbiAgICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9GQUtFID09PSAnMScpIHJldHVybiB7IG9rOiB0cnVlLCBtb2RlOiBicmlkZ2UubW9kZSwgdGVzdDogdHJ1ZSB9O1xuICAgICAgY29uc3QgcmVwb1Jvb3QgPSBqb2luKGhlcmUsICcuLicsICcuLicsICcuLicsICcuLicpO1xuICAgICAgaWYgKGMgPT09ICdleHRlcm5hbCcgfHwgYyA9PT0gJ2J1bmRsZWQnKSB7XG4gICAgICAgIGNvbnN0IHRhcmdldCA9IGMgPT09ICdidW5kbGVkJyA/IGJ1bmRsZWRSdW50aW1lUGF0aChyZXBvUm9vdCkgOiBlO1xuICAgICAgICBpZiAodGFyZ2V0ID09PSAnJyB8fCAhaXNBYnNvbHV0ZSh0YXJnZXQpIHx8ICFleGlzdHNTeW5jKHRhcmdldCkpIHtcbiAgICAgICAgICByZXR1cm4geyBlcnJvcjogJ3J1bnRpbWUgXHU1MTY1XHU1M0UzXHU0RTBEXHU1QjU4XHU1NzI4JywgY29kZTogJ0JBRF9SRVFVRVNUJyB9O1xuICAgICAgICB9XG4gICAgICAgIGF3YWl0IHNhdmVSdW50aW1lQ29uZmlnKHsgZW50cnk6IHRhcmdldCwgZGVtbzogZmFsc2UgfSk7XG4gICAgICB9IGVsc2UgaWYgKGMgPT09ICdkZW1vJykge1xuICAgICAgICBhd2FpdCBzYXZlUnVudGltZUNvbmZpZyh7IGVudHJ5OiAnJywgZGVtbzogdHJ1ZSB9KTtcbiAgICAgIH1cbiAgICAgIGlmIChjICE9PSAnaW5zdGFsbCcpIHtcbiAgICAgICAgLy8gaW5zdGFsbDpcdTVCODlcdTg4QzVcdTU2NjhcdTVERjJcdTU3Mjggb25JbnN0YWxsZWQgXHU2MzAxXHU0RTQ1XHU1MzE2XHU1RTc2XHU3MEVEXHU1MjA3XHU2MzYyLFx1OEZEOVx1OTFDQ1x1NEUwRFx1NTE4RFx1OTFDRFx1NTQyRlxuICAgICAgICBzc2VBYm9ydD8uYWJvcnQoKTtcbiAgICAgICAgaWYgKHN1cGVydmlzb3IgIT09IG51bGwpIGF3YWl0IHN1cGVydmlzb3Iuc3RvcCgpO1xuICAgICAgICBhd2FpdCBzdGFydEhvc3QoKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBtb2RlOiBicmlkZ2UubW9kZSB9O1xuICAgIH0pO1xuXG4gICAgLy8gLS0tLSBQcm92aWRlciBcdThCQkVcdTdGNkUoMDMgXHUwMEE3XHU0RTAzOmtleSBcdTUzRUFcdTUxRkEgaGFzS2V5L1x1NjcyQlx1NTZEQlx1NEY0RDtcdTRGRERcdTVCNThcdTc2RjRcdTUxOTkgcnVudGltZSkgLS0tLVxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cHJvdmlkZXJzJywgKGV2ZW50KSA9PlxuICAgICAgaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248eyBwcm92aWRlcnNEZXRhaWw/OiBBcnJheTx7IG5hbWU6IHN0cmluZzsgbW9kZWw6IHN0cmluZzsgYmFzZVVybDogc3RyaW5nOyBoYXNLZXk6IGJvb2xlYW47IGtleVRhaWw/OiBzdHJpbmcgfT47IG1vZGVsPzogc3RyaW5nIH0+KCcvYXBpL3N0YXRlJykpKTtcblxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cHJvdmlkZXItc2F2ZScsIChldmVudCwgcHJvdmlkZXI6IHVua25vd24pID0+IHtcbiAgICAgIGNvbnN0IHAgPSBwcm92aWRlciBhcyB7IG5hbWU/OiB1bmtub3duOyBiYXNlVXJsPzogdW5rbm93bjsgbW9kZWw/OiB1bmtub3duOyBhcGlLZXk/OiB1bmtub3duIH07XG4gICAgICBjb25zdCBuYW1lID0gdHlwZW9mIHA/Lm5hbWUgPT09ICdzdHJpbmcnID8gcC5uYW1lLnNsaWNlKDAsIDgwKSA6ICcnO1xuICAgICAgY29uc3QgYmFzZVVybCA9IHR5cGVvZiBwPy5iYXNlVXJsID09PSAnc3RyaW5nJyA/IHAuYmFzZVVybC5zbGljZSgwLCAzMDApIDogJyc7XG4gICAgICBjb25zdCBtb2RlbCA9IHR5cGVvZiBwPy5tb2RlbCA9PT0gJ3N0cmluZycgPyBwLm1vZGVsLnNsaWNlKDAsIDEyMCkgOiAnJztcbiAgICAgIGlmIChuYW1lID09PSAnJyB8fCBiYXNlVXJsID09PSAnJyB8fCBtb2RlbCA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ25hbWUvYmFzZVVybC9tb2RlbCByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XG4gICAgICBjb25zdCBib2R5OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgbmFtZSwgYmFzZVVybCwgbW9kZWwgfTtcbiAgICAgIC8vIGFwaUtleSBcdTUzRUFcdTU3MjhcdTY2M0VcdTVGMEZcdThGOTNcdTUxNjVcdTY1RjZcdTRFMEFcdTRGMjAsXHU3RUREXHU0RTBEXHU1NkRFXHU2NjNFKHJlbmRlcmVyIFx1ODg2OFx1NTM1NVx1NjNEMFx1NEVBNFx1NTQwRVx1NTM3M1x1NkUwNVx1N0E3QSlcbiAgICAgIGlmICh0eXBlb2YgcD8uYXBpS2V5ID09PSAnc3RyaW5nJyAmJiBwLmFwaUtleSAhPT0gJycpIGJvZHkuYXBpS2V5ID0gcC5hcGlLZXkuc2xpY2UoMCwgMzAwKTtcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PignL2FwaS9wcm92aWRlcnMnLCBib2R5KSk7XG4gICAgfSk7XG5cbiAgICAvLyAtLS0tIFx1NURFNVx1NEY1Q1x1NTMzQSgwMyBcdTAwQTdcdTUxNkQ7XHU1MjA3XHU2MzYyXHU4QkVEXHU0RTQ5XHU0RTBFIHdlYiBcdTc2RjhcdTU0MEM6cnVudGltZSBcdTUzNTVcdTkwMDkgY3dkKSAtLS0tXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTp3b3Jrc3BhY2VzJywgKGV2ZW50KSA9PlxuICAgICAgaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248eyBjdXJyZW50OiBzdHJpbmc7IGl0ZW1zOiBBcnJheTx7IGlkOiBzdHJpbmc7IG5hbWU6IHN0cmluZzsgcGF0aDogc3RyaW5nIH0+IH0+KCcvYXBpL3dvcmtzcGFjZXMnKSkpO1xuXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTp3b3Jrc3BhY2UtdXNlJywgKGV2ZW50LCBpZDogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3Qgd2lkID0gdHlwZW9mIGlkID09PSAnc3RyaW5nJyA/IGlkLnNsaWNlKDAsIDYwKSA6ICcnO1xuICAgICAgaWYgKHdpZCA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ2lkIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PignL2FwaS93b3Jrc3BhY2VzL3VzZScsIHsgaWQ6IHdpZCB9KSk7XG4gICAgfSk7XG5cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOndvcmtzcGFjZS1hZGQnLCAoZXZlbnQsIG5hbWU6IHVua25vd24sIHBhdGg6IHVua25vd24pID0+IHtcbiAgICAgIGNvbnN0IG4gPSB0eXBlb2YgbmFtZSA9PT0gJ3N0cmluZycgPyBuYW1lLnNsaWNlKDAsIDEyMCkgOiAnJztcbiAgICAgIGNvbnN0IHAgPSB0eXBlb2YgcGF0aCA9PT0gJ3N0cmluZycgPyBwYXRoLnNsaWNlKDAsIDEwMDApIDogJyc7XG4gICAgICBpZiAocCA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ3BhdGggcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KCcvYXBpL3dvcmtzcGFjZXMnLCB7IG5hbWU6IG4gPT09ICcnID8gdW5kZWZpbmVkIDogbiwgcGF0aDogcCB9KSk7XG4gICAgfSk7XG5cbiAgICAvLyAtLS0tIFx1NEYxQVx1OEJERFx1NUY1Mlx1Njg2My9cdTUyMjBcdTk2NjQoXHU3OUZCXHU1MTY1IGFyY2hpdmUvdHJhc2gsXHU1M0VGXHU2MDYyXHU1OTBEO3J1bnRpbWUgXHU2NzQzXHU1QTAxKSAtLS0tXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpzZXNzaW9uLW9wJywgKGV2ZW50LCBpZDogdW5rbm93biwgb3A6IHVua25vd24pID0+IHtcbiAgICAgIGNvbnN0IHNpZCA9IHR5cGVvZiBpZCA9PT0gJ3N0cmluZycgPyBpZC5yZXBsYWNlKC9bXmEtekEtWjAtOV86LkAtXS9nLCAnJykuc2xpY2UoMCwgODApIDogJyc7XG4gICAgICBjb25zdCBvID0gb3AgPT09ICdhcmNoaXZlJyB8fCBvcCA9PT0gJ2RlbGV0ZScgPyBvcCA6ICcnO1xuICAgICAgaWYgKHNpZCA9PT0gJycgfHwgbyA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ2lkIGFuZCBvcChhcmNoaXZlfGRlbGV0ZSkgcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KGAvYXBpL3Nlc3Npb25zLyR7ZW5jb2RlVVJJQ29tcG9uZW50KHNpZCl9LyR7b31gLCB7fSkpO1xuICAgIH0pO1xuXG4gICAgLy8gLS0tLSBNNDpEaWZmIFx1OTc2Mlx1Njc3RihcdTUzRUFcdThCRkIgZ2l0IFx1NTNEOFx1NjZGNDtcdTYzODhcdTY3NDNcdTU3MjggcnVudGltZSkgLS0tLVxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6ZGlmZicsIChldmVudCwgc2Vzc2lvbklkOiB1bmtub3duKSA9PiB7XG4gICAgICBjb25zdCBzaWQgPSB0eXBlb2Ygc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IHNlc3Npb25JZC5zbGljZSgwLCA4MCkgOiAnJztcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oYC9hcGkvZGlmZiR7c2lkICE9PSAnJyA/IGA/c2Vzc2lvbklkPSR7ZW5jb2RlVVJJQ29tcG9uZW50KHNpZCl9YCA6ICcnfWApKTtcbiAgICB9KTtcblxuICAgIC8vIC0tLS0gTTU6XHU4QkE0XHU3N0U1XHU3MkI2XHU2MDAxKFx1N0VEM1x1Njc4NFx1NTMxNlx1NEU4Qlx1NUI5RTtcdTdGM0FcdTY1NzBcdTYzNkVcdTVCNTdcdTZCQjVcdTc1MzEgVUkgXHU2NjNFXHU3OTNBXCJcdTY1RTBcdTY1NzBcdTYzNkVcIikgLS0tLVxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6Y29nbml0aXZlJywgKGV2ZW50KSA9PlxuICAgICAgaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KCcvYXBpL2NvZ25pdGl2ZScpKSk7XG5cbiAgICAvLyAtLS0tIFx1NTM4Nlx1NTNGMlx1NEYxQVx1OEJERFx1OTg4NFx1ODlDOChcdTY3MDBcdTU0MEUgODAgXHU2NzYxLFx1NkJDRlx1Njc2MSA1MDAgXHU1QjU3O3J1bnRpbWUgXHU2NzQzXHU1QTAxXHU2NTcwXHU2MzZFKSAtLS0tXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpzZXNzaW9uLXByZXZpZXcnLCAoZXZlbnQsIGlkOiB1bmtub3duKSA9PiB7XG4gICAgICBjb25zdCBzaWQgPSB0eXBlb2YgaWQgPT09ICdzdHJpbmcnID8gaWQucmVwbGFjZSgvW15hLXpBLVowLTlfOi5ALV0vZywgJycpLnNsaWNlKDAsIDgwKSA6ICcnO1xuICAgICAgaWYgKHNpZCA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ2lkIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oYC9hcGkvc2Vzc2lvbnMvJHtlbmNvZGVVUklDb21wb25lbnQoc2lkKX1gKSk7XG4gICAgfSk7XG5cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnN0b3AtaG9zdCcsIChldmVudCkgPT4ge1xuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJyB9O1xuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xuICAgICAgICBzc2VBYm9ydD8uYWJvcnQoKTtcbiAgICAgICAgYXdhaXQgc3VwZXJ2aXNvcj8uc3RvcCgpO1xuICAgICAgICBhcHAucXVpdCgpO1xuICAgICAgfSkoKTtcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlIH07XG4gICAgfSk7XG4gIH1cblxuICAvKiAtLS0tIFx1N0E5N1x1NTNFM1x1NEUwRVx1NUI4OVx1NTE2OFx1N0I1Nlx1NzU2NSAtLS0tICovXG4gIC8vIDAzIFx1MDBBN1x1NEUwMzpEZXNrdG9wIFx1NjcyQ1x1NTczMFx1NTNFQVx1NUI1OCBVSSBcdTUwNEZcdTU5N0QvXHU3QTk3XHU1M0UzXHU3MkI2XHU2MDAxKHVzZXJEYXRhL3dpbmRvdy1zdGF0ZS5qc29uKVxuICBjb25zdCB3aW5kb3dTdGF0ZUZpbGUgPSAoKTogc3RyaW5nID0+IGpvaW4oYXBwLmdldFBhdGgoJ3VzZXJEYXRhJyksICd3aW5kb3ctc3RhdGUuanNvbicpO1xuICBhc3luYyBmdW5jdGlvbiBsb2FkQm91bmRzKCk6IFByb21pc2U8eyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlcjsgeD86IG51bWJlcjsgeT86IG51bWJlciB9IHwgbnVsbD4ge1xuICAgIHRyeSB7XG4gICAgICByZXR1cm4gSlNPTi5wYXJzZShhd2FpdCByZWFkRmlsZSh3aW5kb3dTdGF0ZUZpbGUoKSwgJ3V0ZjgnKSkgYXMgeyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlcjsgeD86IG51bWJlcjsgeT86IG51bWJlciB9O1xuICAgIH0gY2F0Y2ggeyByZXR1cm4gbnVsbDsgfVxuICB9XG4gIGFzeW5jIGZ1bmN0aW9uIHNhdmVCb3VuZHMod2luOiBCcm93c2VyV2luZG93KTogUHJvbWlzZTx2b2lkPiB7XG4gICAgdHJ5IHsgYXdhaXQgd3JpdGVGaWxlKHdpbmRvd1N0YXRlRmlsZSgpLCBKU09OLnN0cmluZ2lmeSh3aW4uZ2V0Qm91bmRzKCkpLCAndXRmOCcpOyB9IGNhdGNoIHsgLyogYmVzdCBlZmZvcnQgKi8gfVxuICB9XG5cbiAgYXN5bmMgZnVuY3Rpb24gY3JlYXRlV2luZG93KCk6IFByb21pc2U8QnJvd3NlcldpbmRvdyB8IG51bGw+IHtcbiAgICBjb25zdCBzYXZlZCA9IGF3YWl0IGxvYWRCb3VuZHMoKTtcbiAgICBjb25zdCB3aW4gPSBuZXcgQnJvd3NlcldpbmRvdyh7XG4gICAgICB3aWR0aDogc2F2ZWQ/LndpZHRoID8/IDE0NDAsXG4gICAgICBoZWlnaHQ6IHNhdmVkPy5oZWlnaHQgPz8gOTAwLFxuICAgICAgLi4uKHNhdmVkPy54ICE9PSB1bmRlZmluZWQgJiYgc2F2ZWQ/LnkgIT09IHVuZGVmaW5lZCA/IHsgeDogc2F2ZWQueCwgeTogc2F2ZWQueSB9IDoge30pLFxuICAgICAgbWluV2lkdGg6IDk2MCxcbiAgICAgIG1pbkhlaWdodDogNjAwLFxuICAgICAgc2hvdzogZmFsc2UsXG4gICAgICBiYWNrZ3JvdW5kQ29sb3I6ICcjZjlmYWZiJywgLy8gdjQgRFNIOlx1NkQ0NVx1ODI3Mlx1OUVEOFx1OEJBNChiZy1iYXNlKSxcdTkwN0ZcdTUxNERcdTZERjFcdTgyNzJcdTk1RUFcdTVDNEZcbiAgICAgIHRpdGxlOiAnSE1IIERlc2t0b3AnLFxuICAgICAgLy8gXHU5NjkwXHU4NUNGXHU1RjBGXHU2ODA3XHU5ODk4XHU2ODBGOlx1NTM5Rlx1NzUxRlx1N0E5N1x1NTNFM1x1NjNBN1x1NTIzNihvdmVybGF5IFx1NjNEMFx1NEY5QikrXHU5ODlDXHU4MjcyXHU5NjhGXHU0RTNCXHU5ODk4KHJlbmRlcmVyIFx1N0VDRlxuICAgICAgLy8gY2hyb21lLXRoZW1lIFx1NTQwQ1x1NkI2NSlcdTIwMTRcdTIwMTRcdTY4MzlcdTZDQkJcdTRFQUVcdTgyNzJcdTZBMjFcdTVGMEZcdTk4NzZcdTkwRThcdTlFRDFcdTY3NjE7XHU4M0RDXHU1MzU1XHU2ODBGIGF1dG9IaWRlKEFsdCBcdTU0N0NcdTUxRkEpXHUzMDAyXG4gICAgICB0aXRsZUJhclN0eWxlOiAnaGlkZGVuJyxcbiAgICAgIHRpdGxlQmFyT3ZlcmxheTogeyAuLi5jaHJvbWVGb3IobmF0aXZlVGhlbWUuc2hvdWxkVXNlRGFya0NvbG9ycyksIGhlaWdodDogMzYgfSxcbiAgICAgIGF1dG9IaWRlTWVudUJhcjogdHJ1ZSxcbiAgICAgIHdlYlByZWZlcmVuY2VzOiB7XG4gICAgICAgIHByZWxvYWQ6IHByZWxvYWRQYXRoLFxuICAgICAgICBjb250ZXh0SXNvbGF0aW9uOiB0cnVlLFxuICAgICAgICBzYW5kYm94OiB0cnVlLFxuICAgICAgICBub2RlSW50ZWdyYXRpb246IGZhbHNlLFxuICAgICAgICBub2RlSW50ZWdyYXRpb25JbldvcmtlcjogZmFsc2UsXG4gICAgICAgIHdlYlNlY3VyaXR5OiB0cnVlLFxuICAgICAgICBzcGVsbGNoZWNrOiBmYWxzZSxcbiAgICAgICAgZGV2VG9vbHM6IGlzRGV2LFxuICAgICAgfSxcbiAgICB9KTtcbiAgICB3aW4ub25jZSgncmVhZHktdG8tc2hvdycsICgpID0+IHdpbi5zaG93KCkpO1xuICAgIHdpbi5vbignY2xvc2UnLCAoKSA9PiB7IHZvaWQgc2F2ZUJvdW5kcyh3aW4pOyB9KTtcblxuICAgIC8vIFx1NTNFQVx1NTE0MVx1OEJCOFx1NTJBMFx1OEY3RFx1NjIxMVx1NEVFQ1x1ODFFQVx1NURGMVx1NzY4NCByZW5kZXJlcjtcdTRFRkJcdTRGNTVcdTVCRkNcdTgyMkEvXHU2NUIwXHU3QTk3XHU1M0UzXHU0RTAwXHU1RjhCXHU2MkQyXHU3RUREXG4gICAgd2luLndlYkNvbnRlbnRzLnNldFdpbmRvd09wZW5IYW5kbGVyKCh7IHVybCB9KSA9PiB7XG4gICAgICBpZiAoL15odHRwcz86XFwvXFwvLy50ZXN0KHVybCkpIHZvaWQgc2hlbGwub3BlbkV4dGVybmFsKHVybCk7XG4gICAgICByZXR1cm4geyBhY3Rpb246ICdkZW55JyB9O1xuICAgIH0pO1xuICAgIHdpbi53ZWJDb250ZW50cy5vbignd2lsbC1uYXZpZ2F0ZScsIChlLCB1cmwpID0+IHtcbiAgICAgIGNvbnN0IG9rID0gWy4uLmFsbG93ZWRPcmlnaW5zXS5zb21lKChvKSA9PiB1cmwgPT09IG8gfHwgdXJsLnN0YXJ0c1dpdGgoYCR7b30vYCkgfHwgdXJsLnN0YXJ0c1dpdGgoYCR7b30/YCkpO1xuICAgICAgaWYgKCFvaykge1xuICAgICAgICBsb2dJbmZvKCduYXYnLCBgYmxvY2tlZCBuYXZpZ2F0aW9uIHRvICR7dXJsLnNsaWNlKDAsIDEyMCl9YCk7XG4gICAgICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIGlmIChpc0RldiAmJiByZW5kZXJlckRldlVybCkge1xuICAgICAgdm9pZCB3aW4ubG9hZFVSTChyZW5kZXJlckRldlVybCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHZvaWQgd2luLmxvYWRGaWxlKGpvaW4oaGVyZSwgJy4uJywgJy4uJywgJ2Rpc3QtcmVuZGVyZXInLCAnaW5kZXguaHRtbCcpKTtcbiAgICB9XG4gICAgLy8gXHU5ODc1XHU5NzYyXHU1MkEwXHU4RjdEXHU1QjhDXHU5MUNEXHU2NEFEXHU1RjUzXHU1MjREIGhvc3QgXHU3MkI2XHU2MDAxOnJlYWR5IFx1NUU3Rlx1NjRBRFx1ODJFNVx1NjVFOVx1NEU4RSByZW5kZXJlciBcdThCQTJcdTk2MDVcdTUzNzNcdTRFMjJcdTU5MzEsXG4gICAgLy8gcmVuZGVyZXIgXHU3Njg0IGdldC1zdGF0ZSBcdTVGRUJcdTcxNjcgKyBcdThGRDlcdTkxQ0NcdTc2ODRcdTkxQ0RcdTY0QURcdTUzQ0NcdTRGRERcdTk2NjkoXHU1OTFBXHU3QTk3XHU1M0UzL1x1OTFDRFx1OEY3RFx1NTczQVx1NjY2Rlx1NEU1Rlx1ODk4Nlx1NzZENilcdTMwMDJcbiAgICB3aW4ud2ViQ29udGVudHMub25jZSgnZGlkLWZpbmlzaC1sb2FkJywgKCkgPT4ge1xuICAgICAgaWYgKCF3aW4uaXNEZXN0cm95ZWQoKSkge1xuICAgICAgICB3aW4ud2ViQ29udGVudHMuc2VuZCgnYnJpZGdlOmhvc3Qtc3RhdGUnLCBicmlkZ2UuaG9zdFN0YXRlLCB7IHJlc3RhcnRDb3VudDogMCB9KTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICByZXR1cm4gd2luO1xuICB9XG5cbiAgYXBwLndoZW5SZWFkeSgpLnRoZW4oKCkgPT4ge1xuICAgIC8vIFVJVkVSSUZZOmZha2UgXHU2QTIxXHU1RjBGXHU5QThDXHU2NTM2XHU5ODdCXHU1NzI4IHN0YXJ0SG9zdCBcdThCRkIgZW52IFx1NEU0Qlx1NTI0RFx1NUYzQVx1NTIzNiBmYWtlXG4gICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZID09PSAnMScgJiYgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfTU9ERSAhPT0gJ3JlYWwnKSB7XG4gICAgICBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9GQUtFID0gJzEnO1xuICAgIH1cbiAgICAvLyBXaW5kb3dzIFx1OTAxQVx1NzdFNVx1NUY1Mlx1NUM1RShcdTU0MjZcdTUyMTlcdTY2M0VcdTc5M0FcdTRFM0EgZWxlY3Ryb24uZXhlKVxuICAgIGFwcC5zZXRBcHBVc2VyTW9kZWxJZCgnZGV2LmhtaC5kZXNrdG9wJyk7XG4gICAgc2V0dXBUcmF5KCk7XG4gICAgYnVpbGRBcHBNZW51KCk7XG4gICAgLy8gXHU1NDJGXHU1MkE4IDMwcyBcdTU0MEVcdTk3NTlcdTlFRDhcdTY4QzBcdTY3RTVcdTY2RjRcdTY1QjAoXHU2NzA5XHU2NUIwXHU3MjQ4XHU0RUM1XHU1NDBFXHU1M0YwXHU0RTBCXHU4RjdELFx1NEUwRFx1NjI1M1x1NjI3MDtcdTc1MjhcdTYyMzdcdTdFQ0YgXHUyNjMwIFx1ODNEQ1x1NTM1NVx1NTFCM1x1NUI5QVx1ODhDNSlcbiAgICBpZiAoYXBwLmlzUGFja2FnZWQpIHNldFRpbWVvdXQoKCkgPT4geyB2b2lkIGNoZWNrRm9yVXBkYXRlcygpOyB9LCAzMF8wMDApO1xuICAgIC8vIENTUChkZXYgXHU0RTBFIHByb2QgXHU0RTBEXHU1NDBDO3Byb2QgXHU0RTBEXHU1MTQxXHU4QkI4XHU0RUZCXHU0RjU1XHU4RkRDXHU3QTBCXHU2RTkwKVxuICAgIGNvbnN0IGNzcCA9IGlzRGV2XG4gICAgICA/IFtcbiAgICAgICAgICBcImRlZmF1bHQtc3JjICdzZWxmJ1wiLFxuICAgICAgICAgIGBzY3JpcHQtc3JjICdzZWxmJyAke3JlbmRlcmVyRGV2VXJsfWAsXG4gICAgICAgICAgXCJzdHlsZS1zcmMgJ3NlbGYnICd1bnNhZmUtaW5saW5lJ1wiLFxuICAgICAgICAgIGBjb25uZWN0LXNyYyAnc2VsZicgJHtyZW5kZXJlckRldlVybH0gd3M6Ly8xMjcuMC4wLjE6KmAsXG4gICAgICAgICAgXCJpbWctc3JjICdzZWxmJyBkYXRhOlwiLFxuICAgICAgICAgIFwiZm9udC1zcmMgJ3NlbGYnIGRhdGE6XCIsXG4gICAgICAgIF0uam9pbignOyAnKVxuICAgICAgOiBcImRlZmF1bHQtc3JjICdzZWxmJzsgc2NyaXB0LXNyYyAnc2VsZic7IHN0eWxlLXNyYyAnc2VsZicgJ3Vuc2FmZS1pbmxpbmUnOyBpbWctc3JjICdzZWxmJyBkYXRhOjsgZm9udC1zcmMgJ3NlbGYnIGRhdGE6XCI7XG4gICAgc2Vzc2lvbi5kZWZhdWx0U2Vzc2lvbi53ZWJSZXF1ZXN0Lm9uSGVhZGVyc1JlY2VpdmVkKChkZXRhaWxzLCBjYWxsYmFjaykgPT4ge1xuICAgICAgY2FsbGJhY2soe1xuICAgICAgICByZXNwb25zZUhlYWRlcnM6IHtcbiAgICAgICAgICAuLi5kZXRhaWxzLnJlc3BvbnNlSGVhZGVycyxcbiAgICAgICAgICAnQ29udGVudC1TZWN1cml0eS1Qb2xpY3knOiBbY3NwXSxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgcmVnaXN0ZXJJcGMoKTtcbiAgICAvLyBjcmVhdGVXaW5kb3cgXHU2NjJGIGFzeW5jKGJvdW5kcyBcdTYwNjJcdTU5MEQpO1x1NUI4OVx1NTE2OFx1ODFFQVx1NkQ0Qi9cdTZFMzJcdTY3RDNcdTgxRUFcdTY4QzBcdTU3MjhcdTdBOTdcdTUzRTNcdTVDMzFcdTdFRUFcdTU0MEVcdTYzMDJcdThGN0RcbiAgICB2b2lkIGNyZWF0ZVdpbmRvdygpLnRoZW4oKHdpbikgPT4ge1xuICAgICAgaWYgKHdpbiA9PT0gbnVsbCkgcmV0dXJuO1xuICAgICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZID09PSAnMScpIGF0dGFjaFVpVmVyaWZ5KHdpbik7XG4gICAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfU0VDVVJJVFlfVEVTVCA9PT0gJzEnKSB7XG4gICAgICAgIHdpbi53ZWJDb250ZW50cy5vbmNlKCdkaWQtZmluaXNoLWxvYWQnLCAoKSA9PiB7XG4gICAgICAgICAgdm9pZCBzZWN1cml0eVNlbGZUZXN0KHdpbik7XG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgICAgLy8gVUkgXHU2MjJBXHU1NkZFXHU5NEE5XHU1QjUwOkhNSF9ERVNLVE9QX1NOQVBTSE9UPTxmaWxlLnBuZz4gXHU1NzI4XHU3NTRDXHU5NzYyXHU1QzMxXHU3RUVBXHU1NDBFXHU2MjJBXHU1NkZFXHU5MDAwXHU1MUZBXG4gICAgICAvLyAoXHU4OEM1XHU2NzNBXHU4QkNBXHU2NUFEXHU3NTI4Olx1NEVCMlx1NzczQ1x1NzcwQlx1NkUzMlx1NjdEM1x1N0VEM1x1Njc5QyxcdTgwMENcdTRFMERcdTY2MkZcdTUzRUFcdTY1NzAgcm9vdCBcdTVCNTBcdTgyODJcdTcwQjkpXHUzMDAyXG4gICAgICBjb25zdCBzbmFwID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfU05BUFNIT1Q7XG4gICAgICBpZiAoc25hcCAhPT0gdW5kZWZpbmVkICYmIHNuYXAgIT09ICcnKSB7XG4gICAgICAgIHdpbi53ZWJDb250ZW50cy5vbmNlKCdkaWQtZmluaXNoLWxvYWQnLCAoKSA9PiB7XG4gICAgICAgICAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgICAgICB2b2lkIChhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgY29uc3QgaW1nID0gYXdhaXQgd2luLndlYkNvbnRlbnRzLmNhcHR1cmVQYWdlKCk7XG4gICAgICAgICAgICAgICAgY29uc3QgeyB3cml0ZUZpbGU6IHdmIH0gPSBhd2FpdCBpbXBvcnQoJ25vZGU6ZnMvcHJvbWlzZXMnKTtcbiAgICAgICAgICAgICAgICBhd2FpdCB3ZihzbmFwLCBpbWcudG9QTkcoKSk7XG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYFNOQVBTSE9UIG9rICR7c25hcH0gJHtpbWcuZ2V0U2l6ZSgpLndpZHRofXgke2ltZy5nZXRTaXplKCkuaGVpZ2h0fWApO1xuICAgICAgICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgU05BUFNIT1QgZXJyb3IgJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApfWApO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIGNvbnN0IGFwcDIgPSBhcHA7XG4gICAgICAgICAgICAgIHNldFRpbWVvdXQoKCkgPT4gYXBwMi5leGl0KDApLCA1MDApO1xuICAgICAgICAgICAgfSkoKTtcbiAgICAgICAgICB9LCBOdW1iZXIocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfU05BUFNIT1RfREVMQVlfTVMgPz8gMTJfMDAwKSk7XG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgICAgLy8gRE9NIFx1N0VEM1x1Njc4NFx1NjNBMlx1OTQ4ODpITUhfREVTS1RPUF9ET01QUk9CRT0xIFx1OEY5M1x1NTFGQVx1NTE3M1x1OTUyRVx1NTE0M1x1N0QyMFx1NzY4NCBib3gvZGlzcGxheS9jaGlsZHJlbixcbiAgICAgIC8vIFx1NTE4RFx1OTAwMFx1NTFGQShcdThCQ0FcdTY1QURcIlJlYWN0IFx1NjMwMlx1OEY3RFx1NEU4Nlx1NEY0Nlx1NjdEMFx1NTc1NyBVSSBcdTRFMERcdTUzRUZcdTg5QzFcIlx1OEZEOVx1N0M3Qlx1OTVFRVx1OTg5ODtcdTYyMkFcdTU2RkVcdTRFNEJcdTU5MTZcdTc2ODRcdTc4NkNcdThCQzFcdTYzNkUpXHUzMDAyXG4gICAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfRE9NUFJPQkUgPT09ICcxJykge1xuICAgICAgICB3aW4ud2ViQ29udGVudHMub25jZSgnZGlkLWZpbmlzaC1sb2FkJywgKCkgPT4ge1xuICAgICAgICAgIHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGNvbnN0IHIgPSAoYXdhaXQgd2luLndlYkNvbnRlbnRzLmV4ZWN1dGVKYXZhU2NyaXB0KGAoZnVuY3Rpb24oKXtcbiAgICAgICAgICAgICAgICAgIHZhciBwaWNrID0gZnVuY3Rpb24oc2VsKXtcbiAgICAgICAgICAgICAgICAgICAgdmFyIGVscyA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoc2VsKTtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGVscywgMCwgNCkubWFwKGZ1bmN0aW9uKGVsKXtcbiAgICAgICAgICAgICAgICAgICAgICB2YXIgY3MgPSBnZXRDb21wdXRlZFN0eWxlKGVsKTtcbiAgICAgICAgICAgICAgICAgICAgICB2YXIgYiA9IGVsLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB7IGNsczogKGVsLmNsYXNzTmFtZXx8JycpLnRvU3RyaW5nKCkuc2xpY2UoMCw4MCksIHRhZzogZWwudGFnTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGRpc3BsYXk6IGNzLmRpc3BsYXksIHZpczogY3MudmlzaWJpbGl0eSwgb3BhY2l0eTogY3Mub3BhY2l0eSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHBvczogY3MucG9zaXRpb24sIHo6IGNzLnpJbmRleCwgb3ZlcmZsb3c6IGNzLm92ZXJmbG93LFxuICAgICAgICAgICAgICAgICAgICAgICAgeDogTWF0aC5yb3VuZChiLngpLCB5OiBNYXRoLnJvdW5kKGIueSksIHc6IE1hdGgucm91bmQoYi53aWR0aCksIGg6IE1hdGgucm91bmQoYi5oZWlnaHQpLFxuICAgICAgICAgICAgICAgICAgICAgICAgdGV4dDogKGVsLmlubmVyVGV4dHx8JycpLnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw2MCkgfTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgICAgdmFyIHNlbHMgPSBbJ2h0bWwnLCdib2R5JywnI3Jvb3QnLCcuYXBwLXNoZWxsJywnLnNpZGViYXInLCcud29ya3NwYWNlJywnLnRvcGJhcicsJy5zdHJlYW0nLCcuZW1wdHktaGludCcsJy5jb21wb3NlcicsJy5jb21wb3Nlci1yb3cnLCcuY29tcG9zZXIgdGV4dGFyZWEnLCcuY29tcG9zZXItc2lkZScsJy5hdHQtcGlja2VyJywnLmF0dC1jaGlwcycsJy5zaWRlcGFuZWwnLCcucnVudGltZS1ndWlkZScsJy5vdmVybGF5JywnLnR1cm4nLCcuY2FyZCddO1xuICAgICAgICAgICAgICAgICAgdmFyIG91dCA9IHt9O1xuICAgICAgICAgICAgICAgICAgc2Vscy5mb3JFYWNoKGZ1bmN0aW9uKHMpeyB0cnkgeyBvdXRbc10gPSBwaWNrKHMpOyB9IGNhdGNoKGUpeyBvdXRbc10gPSBbe2VycjogU3RyaW5nKGUpLnNsaWNlKDAsODApfV07IH0gfSk7XG4gICAgICAgICAgICAgICAgICBvdXQuX19tZXRhID0ge1xuICAgICAgICAgICAgICAgICAgICBzdHlsZVNoZWV0czogZG9jdW1lbnQuc3R5bGVTaGVldHMubGVuZ3RoLFxuICAgICAgICAgICAgICAgICAgICBzaGVldDBydWxlczogKGRvY3VtZW50LnN0eWxlU2hlZXRzWzBdICYmIGRvY3VtZW50LnN0eWxlU2hlZXRzWzBdLmNzc1J1bGVzKSA/IGRvY3VtZW50LnN0eWxlU2hlZXRzWzBdLmNzc1J1bGVzLmxlbmd0aCA6IC0xLFxuICAgICAgICAgICAgICAgICAgICByb290Q2hpbGRyZW46IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyb290JykgPyBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncm9vdCcpLmNoaWxkcmVuLmxlbmd0aCA6IC0xLFxuICAgICAgICAgICAgICAgICAgICBib2R5Q2hpbGRyZW46IGRvY3VtZW50LmJvZHkuY2hpbGRyZW4ubGVuZ3RoLFxuICAgICAgICAgICAgICAgICAgICBpbm5lckhUTUxMZW46IGRvY3VtZW50LmJvZHkuaW5uZXJIVE1MLmxlbmd0aCxcbiAgICAgICAgICAgICAgICAgICAgdmlld3BvcnQ6IHdpbmRvdy5pbm5lcldpZHRoICsgJ3gnICsgd2luZG93LmlubmVySGVpZ2h0XG4gICAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KG91dCk7XG4gICAgICAgICAgICAgICAgfSkoKWAsIHRydWUpKSBhcyBzdHJpbmc7XG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYERPTVBST0JFICR7cn1gKTtcbiAgICAgICAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYERPTVBST0JFIGVycm9yICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMjAwKX1gKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICBhcHAuZXhpdCgwKTtcbiAgICAgICAgICAgIH0pKCk7XG4gICAgICAgICAgfSwgTnVtYmVyKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX0RPTVBST0JFX0RFTEFZX01TID8/IDlfMDAwKSk7XG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgICAgLy8gXHU2RTMyXHU2N0QzXHU4MUVBXHU2OEMwKDIwMjYtMTAtMTAgXHU4OEM1XHU2NzNBXHU5RUQxXHU1QzRGXHU2NTU5XHU4QkFEOmJyaWRnZSByZWFkeSBcdTIyNjAgXHU3NTRDXHU5NzYyXHU2RTMyXHU2N0QzXHU0RTg2KVx1MzAwMlxuICAgICAgLy8gI3Jvb3QgXHU1NzI4IFJlYWN0IFx1NjMwMlx1OEY3RFx1NTQwRVx1NUZDNVx1NjcwOVx1NUI1MFx1ODI4Mlx1NzBCOTtcdTdBN0EgPSBcdThENDRcdTZFOTBcdThERUZcdTVGODQvQ1NQL1x1ODExQVx1NjcyQ1x1NTJBMFx1OEY3RFx1NTc0Rlx1NEU4Nlx1MzAwMlxuICAgICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1JFTkRFUl9URVNUID09PSAnMScpIHtcbiAgICAgICAgd2luLndlYkNvbnRlbnRzLm9uY2UoJ2RpZC1maW5pc2gtbG9hZCcsICgpID0+IHtcbiAgICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcbiAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBjb25zdCBuID0gKGF3YWl0IHdpbi53ZWJDb250ZW50cy5leGVjdXRlSmF2YVNjcmlwdChcbiAgICAgICAgICAgICAgICAgICdkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInJvb3RcIikgPyBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInJvb3RcIikuY2hpbGRyZW4ubGVuZ3RoIDogLTEnLCB0cnVlLFxuICAgICAgICAgICAgICAgICkpIGFzIG51bWJlcjtcbiAgICAgICAgICAgICAgICBjb25zdCBvayA9IG4gPiAwO1xuICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBSRU5ERVItVEVTVCAke29rID8gJ29rJyA6ICdFTVBUWSd9IHJvb3RDaGlsZHJlbj0ke259YCk7XG4gICAgICAgICAgICAgICAgYXBwLmV4aXQob2sgPyAwIDogMSk7XG4gICAgICAgICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBSRU5ERVItVEVTVCBFUlJPUiAke1N0cmluZyhlcnIpLnNsaWNlKDAsIDEyMCl9YCk7XG4gICAgICAgICAgICAgICAgYXBwLmV4aXQoMSk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pKCk7XG4gICAgICAgICAgfSwgMl81MDApO1xuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICB2b2lkIHN0YXJ0SG9zdCgpO1xuXG4gICAgYXBwLm9uKCdhY3RpdmF0ZScsICgpID0+IHtcbiAgICAgIGlmIChCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5sZW5ndGggPT09IDApIHZvaWQgY3JlYXRlV2luZG93KCk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIGFzeW5jIGZ1bmN0aW9uIHNlY3VyaXR5U2VsZlRlc3Qod2luOiBCcm93c2VyV2luZG93KTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgcmVzdWx0czogQXJyYXk8W3N0cmluZywgYm9vbGVhbiwgc3RyaW5nXT4gPSBbXTtcbiAgICBjb25zdCBjaGVjayA9IGFzeW5jIChuYW1lOiBzdHJpbmcsIHByb2JlOiAoKSA9PiBQcm9taXNlPFtib29sZWFuLCBzdHJpbmddPik6IFByb21pc2U8dm9pZD4gPT4ge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgW29rLCBkZXRhaWxdID0gYXdhaXQgcHJvYmUoKTtcbiAgICAgICAgcmVzdWx0cy5wdXNoKFtuYW1lLCBvaywgZGV0YWlsXSk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgcmVzdWx0cy5wdXNoKFtuYW1lLCBmYWxzZSwgU3RyaW5nKGVycikuc2xpY2UoMCwgMTIwKV0pO1xuICAgICAgfVxuICAgIH07XG4gICAgY29uc3QganMgPSAoY29kZTogc3RyaW5nKTogUHJvbWlzZTx1bmtub3duPiA9PiB3aW4ud2ViQ29udGVudHMuZXhlY3V0ZUphdmFTY3JpcHQoY29kZSwgdHJ1ZSk7XG5cbiAgICBhd2FpdCBjaGVjaygncmVuZGVyZXIgXHU2NUUwXHU1M0VGXHU3NTI4XHU3Njg0IHByb2Nlc3MvcmVxdWlyZShzYW5kYm94IFx1NzUxRlx1NjU0OCknLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKGAoZnVuY3Rpb24oKXtcbiAgICAgICAgdmFyIHQgPSBmdW5jdGlvbihmKXsgdHJ5IHsgdmFyIHYgPSBmKCk7IHJldHVybiAodiA9PT0gdW5kZWZpbmVkIHx8IHYgPT09IG51bGwpID8gJ3VuYXZhaWxhYmxlJyA6IHR5cGVvZiB2OyB9IGNhdGNoKGUpeyByZXR1cm4gJ2Jsb2NrZWQnOyB9IH07XG4gICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeShbdChmdW5jdGlvbigpe3JldHVybiBwcm9jZXNzfSksIHQoZnVuY3Rpb24oKXtyZXR1cm4gcmVxdWlyZX0pLCB0KGZ1bmN0aW9uKCl7cmV0dXJuIGdsb2JhbFRoaXMucHJvY2Vzc30pXSk7XG4gICAgICB9KSgpYCkpIGFzIHN0cmluZztcbiAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocikgYXMgc3RyaW5nW107XG4gICAgICBjb25zdCBwID0gcGFyc2VkWzBdID8/ICd1bmtub3duJztcbiAgICAgIGNvbnN0IHJlcSA9IHBhcnNlZFsxXSA/PyAndW5rbm93bic7XG4gICAgICBjb25zdCBzYWZlID0gKHY6IHN0cmluZyk6IGJvb2xlYW4gPT4gdiA9PT0gJ3VuYXZhaWxhYmxlJyB8fCB2ID09PSAnYmxvY2tlZCc7XG4gICAgICByZXR1cm4gW3NhZmUocCkgJiYgc2FmZShyZXEpLCBgcHJvY2Vzcz0ke3B9IHJlcXVpcmU9JHtyZXF9YF07XG4gICAgfSk7XG4gICAgYXdhaXQgY2hlY2soJ3dpbmRvdy5obWggXHU1M0VBXHU2NzA5XHU3NjdEXHU1NDBEXHU1MzU1XHU2NUI5XHU2Q0Q1KFx1NjVFMCBpcGNSZW5kZXJlci9cdTk4OURcdTU5MTZcdTk3NjIpJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgciA9IChhd2FpdCBqcygnT2JqZWN0LmtleXMod2luZG93LmhtaCB8fCB7fSkuc29ydCgpLmpvaW4oXCIsXCIpJykpIGFzIHN0cmluZztcbiAgICAgIGNvbnN0IGFsbG93ID0gWydhcHBseVVwZGF0ZScsICdhcHByb3ZlJywgJ2FwcHJvdmFsR2V0JywgJ2FwcHJvdmFsU2V0JywgJ2Jyb3dzZVJ1bnRpbWUnLCAnY2hlY2tVcGRhdGUnLCAnY2hyb21lVGhlbWUnLCAnY29nbml0aXZlJywgJ2RldGVjdFJ1bnRpbWUnLCAnZGlmZicsICdleHBvcnRTZXNzaW9uJywgJ2ZzTGlzdCcsICdmc1JlYWQnLCAnZnNTZWFyY2gnLCAnZ2V0U3RhdGUnLCAnZ2V0V2l6YXJkJywgJ2luamVjdCcsICdpbnN0YWxsQ2xpJywgJ2ludGVycnVwdCcsICdtb2RlbFNldCcsICdvbkV2ZW50QmF0Y2hlcycsICdvbkhvc3RTdGF0ZScsICdvbkluc3RhbGxQcm9ncmVzcycsICdvbk1lbnVBY3Rpb24nLCAnb25TdHJlYW1DaHVua3MnLCAnb25VcGRhdGVTdGF0ZScsICdwaWNrRGlyZWN0b3J5JywgJ3BpY2tGaWxlcycsICdwb3B1cE1haW5NZW51JywgJ3Byb3ZpZGVyU2F2ZScsICdwcm92aWRlcnMnLCAncmVtb3RlV2ViQXV0b3N0YXJ0JywgJ3JlbW90ZVdlYlN0YXJ0JywgJ3JlbW90ZVdlYlN0YXR1cycsICdyZW1vdGVXZWJTdG9wJywgJ3J1bnRpbWVJbmZvJywgJ3NlbmRUYXNrJywgJ3Nlc3Npb25PcCcsICdzZXNzaW9uUHJldmlldycsICdzZXNzaW9ucycsICdzZXRSdW50aW1lJywgJ3N0b3BIb3N0JywgJ3dpemFyZENvbXBsZXRlJywgJ3dvcmtzcGFjZXMnLCAnd29ya3NwYWNlQWRkJywgJ3dvcmtzcGFjZVVzZSddO1xuICAgICAgY29uc3QgZ290ID0gciA9PT0gJycgPyBbXSA6IHIuc3BsaXQoJywnKTtcbiAgICAgIGNvbnN0IHVuZXhwZWN0ZWQgPSBnb3QuZmlsdGVyKChrKSA9PiAhYWxsb3cuaW5jbHVkZXMoaykpO1xuICAgICAgcmV0dXJuIFt1bmV4cGVjdGVkLmxlbmd0aCA9PT0gMCwgYGtleXM9JHtyfWBdO1xuICAgIH0pO1xuICAgIGF3YWl0IGNoZWNrKCdcdTU5MTZcdTkwRThcdTVCRkNcdTgyMkFcdTg4QUJcdTYyRTZcdTYyMkEoVVJMIFx1NEUwRFx1NTNEOCknLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBiZWZvcmUgPSB3aW4ud2ViQ29udGVudHMuZ2V0VVJMKCk7XG4gICAgICBhd2FpdCBqcygnbG9jYXRpb24uaHJlZiA9IFwiaHR0cHM6Ly9leGFtcGxlLmludmFsaWQveFwiOyBcIm5vb3BcIicpLmNhdGNoKCgpID0+ICdub29wJyk7XG4gICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocjIpID0+IHNldFRpbWVvdXQocjIsIDFfMjAwKSk7XG4gICAgICBjb25zdCBhZnRlciA9IHdpbi53ZWJDb250ZW50cy5nZXRVUkwoKTtcbiAgICAgIHJldHVybiBbYWZ0ZXIgPT09IGJlZm9yZSwgYCR7YmVmb3JlfSBcdTIxOTIgJHthZnRlcn1gXTtcbiAgICB9KTtcbiAgICBhd2FpdCBjaGVjaygnd2luZG93Lm9wZW4gXHU4OEFCXHU2MkQyXHU3RUREKFx1OEZENFx1NTZERSBudWxsIFx1NEUxNFx1NjVFMFx1NjVCMFx1N0E5N1x1NTNFMyknLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBiZWZvcmUgPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5sZW5ndGg7XG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKCdTdHJpbmcod2luZG93Lm9wZW4oXCJodHRwczovL2V4YW1wbGUuaW52YWxpZFwiKSknKSkgYXMgc3RyaW5nO1xuICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHIyKSA9PiBzZXRUaW1lb3V0KHIyLCA0MDApKTtcbiAgICAgIGNvbnN0IGFmdGVyID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkubGVuZ3RoO1xuICAgICAgcmV0dXJuIFtyID09PSAnbnVsbCcgJiYgYWZ0ZXIgPT09IGJlZm9yZSwgYG9wZW4oKT0ke3J9IHdpbmRvd3M9JHtiZWZvcmV9XHUyMTkyJHthZnRlcn1gXTtcbiAgICB9KTtcbiAgICBhd2FpdCBjaGVjaygnQ1NQIFx1NUI1OFx1NTcyOChtZXRhIFx1NkNFOFx1NTE2NVx1NjIxNlx1NTRDRFx1NUU5NFx1NTkzNCknLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBtZXRhID0gKGF3YWl0IGpzKCdCb29sZWFuKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoXCJtZXRhW2h0dHAtZXF1aXY9XFwnQ29udGVudC1TZWN1cml0eS1Qb2xpY3lcXCddXCIpKScpKSBhcyBib29sZWFuO1xuICAgICAgY29uc3QgaGVhZGVyQ3NwID0gaXNEZXYgPyAnZGV2OiBoZWFkZXIgQ1NQIFx1NzUzMSBvbkhlYWRlcnNSZWNlaXZlZCBcdTZDRThcdTUxNjUoXHU0RTBEXHU5MDAyXHU3NTI4IG1ldGEgXHU2NUFEXHU4QTAwKScgOiAncHJvZCc7XG4gICAgICByZXR1cm4gW21ldGEgfHwgaXNEZXYsIGBtZXRhPSR7bWV0YX0gJHtoZWFkZXJDc3B9YF07XG4gICAgfSk7XG4gICAgYXdhaXQgY2hlY2soJ2JyaWRnZTpnZXQtc3RhdGUgXHU2QjYzXHU1RTM4XHU4RkQ0XHU1NkRFKGhvc3QgXHU2ODY1XHU1M0VGXHU3NTI4KScsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoJ3dpbmRvdy5obWguZ2V0U3RhdGUoKS50aGVuKHMgPT4gSlNPTi5zdHJpbmdpZnkocykpLmNhdGNoKGUgPT4gXCJFUlI6XCIrZSknKSkgYXMgc3RyaW5nO1xuICAgICAgcmV0dXJuIFtyLnN0YXJ0c1dpdGgoJ3snKSAmJiByLmluY2x1ZGVzKCdob3N0U3RhdGUnKSwgci5zbGljZSgwLCA4MCldO1xuICAgIH0pO1xuICAgIGF3YWl0IGNoZWNrKCdYU1M6XHU2MDc2XHU2MTBGXHU0RUZCXHU1MkExXHU2NTg3XHU2NzJDXHU1M0VBXHU0RUU1XHU2NTg3XHU2NzJDXHU2RTMyXHU2N0QzKFx1NEUwRFx1NjI2N1x1ODg0QyknLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBwYXlsb2FkID0gJzxpbWcgc3JjPXggb25lcnJvcj1cIndpbmRvdy5fX3hzcz0xXCI+PHNjcmlwdD53aW5kb3cuX194c3M9MjxcXC9zY3JpcHQ+XCImXFwnJztcbiAgICAgIGNvbnN0IHNlbmRSID0gKGF3YWl0IGpzKGB3aW5kb3cuaG1oLnNlbmRUYXNrKCR7SlNPTi5zdHJpbmdpZnkocGF5bG9hZCl9LCAnc2VjLXhzcy0xJywgJ2F1dG8nKS50aGVuKHI9PkpTT04uc3RyaW5naWZ5KHIpKS5jYXRjaChlPT4nRVJSOicrZSlgKSkgYXMgc3RyaW5nO1xuICAgICAgaWYgKCFzZW5kUi5pbmNsdWRlcygnXCJva1wiOnRydWUnKSkgcmV0dXJuIFtmYWxzZSwgYHNlbmRUYXNrIFx1NjcyQVx1NTNEN1x1NzQwNjogJHtzZW5kUi5zbGljZSgwLCA4MCl9YF07XG4gICAgICAvLyBmYWtlIGhvc3QgZWNobyBcdTU2REVcdTY3NjVcdTU0MEVcdTdFQ0YgUmVhY3QgXHU2RTMyXHU2N0QzKFx1NzUyOFx1NjIzN1x1NkQ4OFx1NjA2RiArIFx1NTJBOVx1NjI0QiBlY2hvIFx1NTNDQ1x1OERFRlx1NUY4NClcbiAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyMikgPT4gc2V0VGltZW91dChyMiwgM18wMDApKTtcbiAgICAgIGNvbnN0IHByb2JlID0gKGF3YWl0IGpzKGBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIHhzc0ZsYWc6IHR5cGVvZiB3aW5kb3cuX194c3MsXG4gICAgICAgIGltZ0NvdW50OiBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdpbWdbc3JjPVwieFwiXScpLmxlbmd0aCxcbiAgICAgICAgc2NyaXB0UmFuOiBkb2N1bWVudC5ib2R5LmlubmVyVGV4dC5pbmRleE9mKCd3aW5kb3cuX194c3M9MicpID49IDBcbiAgICAgIH0pYCkpIGFzIHN0cmluZztcbiAgICAgIGNvbnN0IHAgPSBKU09OLnBhcnNlKHByb2JlKSBhcyB7IHhzc0ZsYWc6IHN0cmluZzsgaW1nQ291bnQ6IG51bWJlcjsgc2NyaXB0UmFuOiBib29sZWFuIH07XG4gICAgICByZXR1cm4gW3AueHNzRmxhZyA9PT0gJ3VuZGVmaW5lZCcgJiYgcC5pbWdDb3VudCA9PT0gMCwgYHhzc0ZsYWc9JHtwLnhzc0ZsYWd9IGltZz0ke3AuaW1nQ291bnR9YF07XG4gICAgfSk7XG5cbiAgICBsZXQgZmFpbGVkID0gMDtcbiAgICBmb3IgKGNvbnN0IFtuYW1lLCBvaywgZGV0YWlsXSBvZiByZXN1bHRzKSB7XG4gICAgICBjb25zb2xlLmxvZyhgU0VDVVJJVFktVEVTVCAke29rID8gJ1BBU1MnIDogJ0ZBSUwnfSB8ICR7bmFtZX0gfCAke3JlZGFjdChkZXRhaWwpfWApO1xuICAgICAgaWYgKCFvaykgZmFpbGVkICs9IDE7XG4gICAgfVxuICAgIGNvbnNvbGUubG9nKGBTRUNVUklUWS1URVNUIFNVTU1BUlkgcGFzcz0ke3Jlc3VsdHMubGVuZ3RoIC0gZmFpbGVkfS8ke3Jlc3VsdHMubGVuZ3RofWApO1xuICAgIGFwcC5leGl0KGZhaWxlZCA9PT0gMCA/IDAgOiAxKTtcbiAgfVxuXG4gIC8vIFx1OTAwMFx1NTFGQTpcdTRGMThcdTk2QzVcdTUwNUNcdTZCNjJcdTgxRUFcdTVERjEgc3Bhd24gXHU3Njg0IGhvc3Qoc2h1dGRvd24gXHU3QUVGXHU3MEI5IFx1MjE5MiBcdTUxNUNcdTVFOTVcdTUzRUEga2lsbCBcdTgxRUFcdTVERjFcdTc2ODRcdTUzRTVcdTY3QzQpXG4gIGFwcC5vbignYmVmb3JlLXF1aXQnLCAoZSkgPT4ge1xuICAgIGlmIChzdXBlcnZpc29yICE9PSBudWxsICYmIHN1cGVydmlzb3Iuc3RhdGUgIT09ICdzdG9wcGVkJykge1xuICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgc3NlQWJvcnQ/LmFib3J0KCk7XG4gICAgICB2b2lkIHN1cGVydmlzb3Iuc3RvcCgpLmZpbmFsbHkoKCkgPT4gYXBwLnF1aXQoKSk7XG4gICAgfVxuICB9KTtcbiAgYXBwLm9uKCd3aW5kb3ctYWxsLWNsb3NlZCcsICgpID0+IHtcbiAgICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSAhPT0gJ2RhcndpbicpIGFwcC5xdWl0KCk7XG4gIH0pO1xufVxuIiwgIi8qKlxuICogRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yIFx1MjAxNCBobWhhcm5lc3MgaG9zdCBcdThGREJcdTdBMEJcdTc2ODRcdTc1MUZcdTU0N0RcdTU0NjhcdTY3MUZcdTcyQjZcdTYwMDFcdTY3M0EoQURSLTAwMylcdTMwMDJcbiAqXG4gKiBcdTVCODlcdTUxNjhcdTRFMERcdTUzRDhcdTkxQ0Y6XG4gKiAgLSBcdTUzRUFcdTdFRDFcdTVCOUEvXHU2M0EyXHU2RDRCIDEyNy4wLjAuMTtob3N0IFx1NEY3Rlx1NzUyOFx1NjRDRFx1NEY1Q1x1N0NGQlx1N0VERlx1NTIwNlx1OTE0RFx1N0FFRlx1NTNFMyhwb3J0IDApLFx1NUI5RVx1OTY0NVx1N0FFRlx1NTNFM1xuICogICAgXHU3NTMxIGhvc3QgXHU3Njg0IHN0ZG91dCBcdTVGMTVcdTVCRkNcdTg4NENcdTU2REVcdTRGMjAoSG9zdFJlYWR5TGluZSlcdTMwMDJcbiAqICAtIFx1OUFEOFx1NzFCNSB0b2tlbiBcdTUzRUFcdTkwMUFcdThGQzdcdTVCNTBcdThGREJcdTdBMEJcdTczQUZcdTU4ODNcdTUzRDhcdTkxQ0ZcdTRGMjBcdTkwMTIsXHU3RUREXHU0RTBEXHU4RkRCIFVSTC9cdTY1RTVcdTVGRDcvSVBDIFx1NjYwRVx1NjU4N1x1OEQxRlx1OEY3RFx1MzAwMlxuICogIC0gXHU1M0VBXHU1MDVDXHU2QjYyXHU2NzJDIHN1cGVydmlzb3Igc3Bhd24gXHU3Njg0XHU4RkRCXHU3QTBCXHU1M0U1XHU2N0M0O1x1N0VERFx1NEUwRFx1NjMwOVx1OEZEQlx1N0EwQlx1NTQwRCBraWxsXHUzMDAyXG4gKiAgLSBob3N0IGNyYXNoIFx1NTQwRVx1NjcwOVx1OTY1MFx1OTFDRFx1NTQyRjtcdTkxQ0RcdTU0MkZcdTRFMERcdTkxQ0RcdTY1M0VcdTRFRkJcdTRGNTVcdTc1MjhcdTYyMzdcdTUyQThcdTRGNUMoXHU5NzVFXHU1RTQyXHU3QjQ5XHU1MkE4XHU0RjVDXHU3NTMxXHU3NTI4XHU2MjM3XHU3ODZFXHU4QkE0KVx1MzAwMlxuICovXG5pbXBvcnQgeyBzcGF3biwgdHlwZSBDaGlsZFByb2Nlc3MgfSBmcm9tICdub2RlOmNoaWxkX3Byb2Nlc3MnO1xuaW1wb3J0IHsgY3JlYXRlSW50ZXJmYWNlIH0gZnJvbSAnbm9kZTpyZWFkbGluZSc7XG5pbXBvcnQgeyByYW5kb21CeXRlcyB9IGZyb20gJ25vZGU6Y3J5cHRvJztcbmltcG9ydCB7IGRlc2t0b3BFcnJvciwgaXNEZXNrdG9wRXJyb3IsIHR5cGUgRGVza3RvcEVycm9yIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyc7XG5cbmV4cG9ydCB0eXBlIEhvc3RTdGF0ZSA9XG4gIHwgJ3N0b3BwZWQnXG4gIHwgJ3N0YXJ0aW5nJ1xuICB8ICdyZWFkeSdcbiAgfCAnZGlzY29ubmVjdGVkJ1xuICB8ICdyZXN0YXJ0aW5nJ1xuICB8ICdzdG9wcGluZydcbiAgfCAnZmFpbGVkJztcblxuZXhwb3J0IGludGVyZmFjZSBIb3N0U3BlYyB7XG4gIC8qKiBcdTUzRUZcdTYyNjdcdTg4NENcdTY1ODdcdTRFRjYoXHU5MDFBXHU1RTM4IHByb2Nlc3MuZXhlY1BhdGgpXHUzMDAyICovXG4gIGNvbW1hbmQ6IHN0cmluZztcbiAgYXJnczogc3RyaW5nW107XG4gIGN3ZD86IHN0cmluZztcbiAgLyoqIFx1OTg5RFx1NTkxNlx1NzNBRlx1NTg4M1x1NTNEOFx1OTFDRihcdTRGMUFcdTRFMEUgcHJvY2Vzcy5lbnYgXHU1NDA4XHU1RTc2KVx1MzAwMiAqL1xuICBlbnY/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFN1cGVydmlzb3JPcHRpb25zIHtcbiAgLyoqIFx1NjcxRlx1NjcxQiBob3N0IFx1NjgyMVx1OUE4Q1x1NzY4NCBiZWFyZXIgdG9rZW47XHU0RTBEXHU0RjIwXHU1MjE5XHU2QkNGXHU2QjIxIHN0YXJ0IFx1NzUxRlx1NjIxMFx1OUFEOFx1NzFCNVx1OTY4Rlx1NjczQVx1NTAzQ1x1MzAwMiAqL1xuICB0b2tlbj86IHN0cmluZztcbiAgbWF4UmVzdGFydHM/OiBudW1iZXI7XG4gIHN0YXJ0VGltZW91dE1zPzogbnVtYmVyO1xuICBncmFjZWZ1bFNodXRkb3duTXM/OiBudW1iZXI7XG4gIG9uU3RhdGVDaGFuZ2U/KHN0YXRlOiBIb3N0U3RhdGUsIGluZm86IHsgcmVzdGFydENvdW50OiBudW1iZXI7IGxhc3RFcnJvcj86IHN0cmluZyB9KTogdm9pZDtcbiAgLyoqIFx1NkJDRlx1NkIyMSBob3N0IFx1NUMzMVx1N0VFQShcdTU0MkIgY3Jhc2ggXHU4MUVBXHU2MTA4XHU1NDBFXHU3Njg0XHU5MUNEXHU1NDJGKVx1OTBGRFx1NEYxQVx1ODlFNlx1NTNEMSxcdTY0M0FcdTVFMjZcdTdBRUZcdTcwQjkoXHU1NDJCIHRva2VuLFxuICAgKiAgXHU0RUM1XHU0RjlCXHU1NDBDXHU0RkUxXHU0RUZCXHU1N0RGXHU3Njg0XHU1QkJGXHU0RTNCXHU4RkRCXHU3QTBCXHU5MUNEXHU1RUZBXHU2ODY1XHU1QkEyXHU2MjM3XHU3QUVGO1x1NEUwRFx1ODk4MVx1OERFOFx1OEZEQiByZW5kZXJlcilcdTMwMDIgKi9cbiAgb25SZWFkeT8oZW5kcG9pbnQ6IEhvc3RFbmRwb2ludCk6IHZvaWQ7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgSG9zdEVuZHBvaW50IHtcbiAgcG9ydDogbnVtYmVyO1xuICB2ZXJzaW9uOiBzdHJpbmc7XG4gIHRva2VuOiBzdHJpbmc7XG59XG5cbi8qKiBIb3N0UmVhZHlMaW5lIFx1NzY4NFx1N0M3Qlx1NTc4Qlx1NUI4OFx1NTM2Qlx1NEVDRSBjb250cmFjdHMgXHU1RjE1XHU1MTY1LFx1OTA3Rlx1NTE0RFx1NTNDQ1x1NUI5RVx1NzNCMFx1MzAwMiAqL1xuaW1wb3J0IHsgaXNIb3N0UmVhZHlMaW5lIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyc7XG5cbi8vIDQ1czpobWhhcm5lc3MgXHU3NzFGXHU1QjlFXHU1MTY1XHU1M0UzXHU3RUNGIHRzeCBcdTUxQjdcdTdGMTZcdThCRDFcdTY1NzRcdTU5NTcgQ0xJLFx1NjczQVx1NTY2OFx1OUFEOFx1OEQxRlx1OEY3RFx1NjVGNlx1NTNFRlx1OEQ4NSAyMHNcbi8vICgyMDI2LTEwLTExIFx1OEZERVx1N0VFRFx1OUE4Q1x1NjUzNlx1NEUyRFx1OTVGNFx1NkI0N1x1NjAyNyBIT1NUX05PVF9SRUFEWSBcdTc2ODRcdTY4MzlcdTU2RTA7XHU3QTdBXHU5NUYyXHU1QjlFXHU2RDRCIDZzKVx1MzAwMlxuY29uc3QgREVGQVVMVF9TVEFSVF9USU1FT1VUX01TID0gNDVfMDAwO1xuY29uc3QgREVGQVVMVF9NQVhfUkVTVEFSVFMgPSAzO1xuY29uc3QgREVGQVVMVF9HUkFDRUZVTF9NUyA9IDVfMDAwO1xuXG5leHBvcnQgY2xhc3MgRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yIHtcbiAgcHJpdmF0ZSBjaGlsZDogQ2hpbGRQcm9jZXNzIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgX3N0YXRlOiBIb3N0U3RhdGUgPSAnc3RvcHBlZCc7XG4gIHByaXZhdGUgcmVzdGFydENvdW50ID0gMDtcbiAgcHJpdmF0ZSBsYXN0RXJyb3IgPSAnJztcbiAgcHJpdmF0ZSBzdG9wcGluZyA9IGZhbHNlO1xuICBwcml2YXRlIHJlYWRvbmx5IHRva2VuOiBzdHJpbmc7XG4gIHByaXZhdGUgcmVhZG9ubHkgb3B0czogUmVxdWlyZWQ8UGljazxTdXBlcnZpc29yT3B0aW9ucywgJ21heFJlc3RhcnRzJyB8ICdzdGFydFRpbWVvdXRNcycgfCAnZ3JhY2VmdWxTaHV0ZG93bk1zJz4+ICYgU3VwZXJ2aXNvck9wdGlvbnM7XG4gIHByaXZhdGUgZXhpdFdhaXRlcnM6IEFycmF5PCgpID0+IHZvaWQ+ID0gW107XG5cbiAgY29uc3RydWN0b3IoXG4gICAgcHJpdmF0ZSByZWFkb25seSBzcGVjOiBIb3N0U3BlYyxcbiAgICBvcHRzOiBTdXBlcnZpc29yT3B0aW9ucyA9IHt9LFxuICApIHtcbiAgICB0aGlzLnRva2VuID0gb3B0cy50b2tlbiA/PyByYW5kb21CeXRlcygzMikudG9TdHJpbmcoJ2Jhc2U2NHVybCcpO1xuICAgIHRoaXMub3B0cyA9IHtcbiAgICAgIG1heFJlc3RhcnRzOiBvcHRzLm1heFJlc3RhcnRzID8/IERFRkFVTFRfTUFYX1JFU1RBUlRTLFxuICAgICAgc3RhcnRUaW1lb3V0TXM6IG9wdHMuc3RhcnRUaW1lb3V0TXMgPz8gREVGQVVMVF9TVEFSVF9USU1FT1VUX01TLFxuICAgICAgZ3JhY2VmdWxTaHV0ZG93bk1zOiBvcHRzLmdyYWNlZnVsU2h1dGRvd25NcyA/PyBERUZBVUxUX0dSQUNFRlVMX01TLFxuICAgICAgLi4ub3B0cyxcbiAgICB9O1xuICB9XG5cbiAgZ2V0IHN0YXRlKCk6IEhvc3RTdGF0ZSB7XG4gICAgcmV0dXJuIHRoaXMuX3N0YXRlO1xuICB9XG5cbiAgZ2V0IHJlc3RhcnRzVXNlZCgpOiBudW1iZXIge1xuICAgIHJldHVybiB0aGlzLnJlc3RhcnRDb3VudDtcbiAgfVxuXG4gIHByaXZhdGUgc2V0U3RhdGUoczogSG9zdFN0YXRlLCBlcnI/OiBzdHJpbmcpOiB2b2lkIHtcbiAgICB0aGlzLl9zdGF0ZSA9IHM7XG4gICAgaWYgKGVyciAhPT0gdW5kZWZpbmVkKSB0aGlzLmxhc3RFcnJvciA9IGVycjtcbiAgICBjb25zdCBpbmZvOiB7IHJlc3RhcnRDb3VudDogbnVtYmVyOyBsYXN0RXJyb3I/OiBzdHJpbmcgfSA9IHsgcmVzdGFydENvdW50OiB0aGlzLnJlc3RhcnRDb3VudCB9O1xuICAgIGlmICh0aGlzLmxhc3RFcnJvciAhPT0gJycpIGluZm8ubGFzdEVycm9yID0gdGhpcy5sYXN0RXJyb3I7XG4gICAgdGhpcy5vcHRzLm9uU3RhdGVDaGFuZ2U/LihzLCBpbmZvKTtcbiAgfVxuXG4gIC8qKiBcdTU0MkZcdTUyQTggaG9zdCBcdTVFNzZcdTdCNDlcdTVGODUgcmVhZHkoXHU1RjE1XHU1QkZDXHU4ODRDICsgXHU1RTI2IHRva2VuIFx1NzY4NFx1NTA2NVx1NUVCN1x1NjNBMlx1NkQ0QilcdTMwMDIgKi9cbiAgYXN5bmMgc3RhcnQoKTogUHJvbWlzZTxIb3N0RW5kcG9pbnQ+IHtcbiAgICBpZiAodGhpcy5fc3RhdGUgPT09ICdyZWFkeScgfHwgdGhpcy5fc3RhdGUgPT09ICdzdGFydGluZycpIHtcbiAgICAgIHRocm93IGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgc3VwZXJ2aXNvciBhbHJlYWR5ICR7dGhpcy5fc3RhdGV9YCk7XG4gICAgfVxuICAgIHRoaXMucmVzdGFydENvdW50ID0gMDtcbiAgICB0aGlzLnN0b3BwaW5nID0gZmFsc2U7XG4gICAgcmV0dXJuIHRoaXMubGF1bmNoKCk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGxhdW5jaCgpOiBQcm9taXNlPEhvc3RFbmRwb2ludD4ge1xuICAgIHRoaXMuc2V0U3RhdGUoJ3N0YXJ0aW5nJyk7XG4gICAgY29uc3QgY2hpbGQgPSBzcGF3bih0aGlzLnNwZWMuY29tbWFuZCwgdGhpcy5zcGVjLmFyZ3MsIHtcbiAgICAgIGN3ZDogdGhpcy5zcGVjLmN3ZCxcbiAgICAgIGVudjoge1xuICAgICAgICAuLi5wcm9jZXNzLmVudixcbiAgICAgICAgLi4udGhpcy5zcGVjLmVudixcbiAgICAgICAgSE1IX0RFU0tUT1BfVE9LRU46IHRoaXMudG9rZW4sXG4gICAgICB9LFxuICAgICAgc3RkaW86IFsnaWdub3JlJywgJ3BpcGUnLCAncGlwZSddLFxuICAgICAgd2luZG93c0hpZGU6IHRydWUsXG4gICAgfSk7XG4gICAgdGhpcy5jaGlsZCA9IGNoaWxkO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGVuZHBvaW50ID0gYXdhaXQgdGhpcy5hd2FpdFJlYWR5KGNoaWxkKTtcbiAgICAgIHRoaXMuY3VycmVudEVuZHBvaW50ID0geyBwb3J0OiBlbmRwb2ludC5wb3J0LCB2ZXJzaW9uOiBlbmRwb2ludC52ZXJzaW9uIH07XG4gICAgICB0aGlzLnNldFN0YXRlKCdyZWFkeScpO1xuICAgICAgdGhpcy5vcHRzLm9uUmVhZHk/LihlbmRwb2ludCk7XG4gICAgICAvLyByZWFkeSBcdTRFNEJcdTU0MEVcdThGREJcdTdBMEJcdTZCN0JcdTRFQTEgPSBcdTYxMEZcdTU5MTZcdTkwMDBcdTUxRkEgXHUyMTkyIFx1NjcwOVx1OTY1MFx1OTFDRFx1NTQyRlxuICAgICAgY2hpbGQub25jZSgnZXhpdCcsICgpID0+IHtcbiAgICAgICAgdGhpcy5leGl0V2FpdGVycy5mb3JFYWNoKCh3KSA9PiB3KCkpO1xuICAgICAgICB0aGlzLmV4aXRXYWl0ZXJzID0gW107XG4gICAgICAgIHRoaXMub25VbmV4cGVjdGVkRXhpdCgpO1xuICAgICAgfSk7XG4gICAgICByZXR1cm4gZW5kcG9pbnQ7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBpZiAoIWNoaWxkLmtpbGxlZCkgY2hpbGQua2lsbCgpO1xuICAgICAgaWYgKHRoaXMuY2hpbGQgPT09IGNoaWxkKSB0aGlzLmNoaWxkID0gbnVsbDtcbiAgICAgIHRocm93IGVycjtcbiAgICB9XG4gIH1cblxuICAvKiogXHU0RUNFIHN0ZG91dCBcdTYyN0UgSG9zdFJlYWR5TGluZSxcdTcxMzZcdTU0MEVcdTUwNjVcdTVFQjdcdTYzQTJcdTZENEJcdTMwMDIgKi9cbiAgcHJpdmF0ZSBhd2FpdFJlYWR5KGNoaWxkOiBDaGlsZFByb2Nlc3MpOiBQcm9taXNlPEhvc3RFbmRwb2ludD4ge1xuICAgIHJldHVybiBuZXcgUHJvbWlzZTxIb3N0RW5kcG9pbnQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgIHJlamVjdChkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYGhvc3QgZGlkIG5vdCBzaWduYWwgcmVhZHkgd2l0aGluICR7dGhpcy5vcHRzLnN0YXJ0VGltZW91dE1zfW1zYCwgeyByZXRyeWFibGU6IHRydWUsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XG4gICAgICB9LCB0aGlzLm9wdHMuc3RhcnRUaW1lb3V0TXMpO1xuXG4gICAgICBjb25zdCBkb25lID0gKGZuOiAoKSA9PiB2b2lkKTogdm9pZCA9PiB7XG4gICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgIGZuKCk7XG4gICAgICB9O1xuXG4gICAgICBpZiAoIWNoaWxkLnN0ZG91dCkge1xuICAgICAgICBkb25lKCgpID0+IHJlamVjdChkZXNrdG9wRXJyb3IoJ1JVTlRJTUVfQ1JBU0hFRCcsICdob3N0IHNwYXduZWQgd2l0aG91dCBzdGRvdXQgcGlwZScpKSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgY29uc3QgcmwgPSBjcmVhdGVJbnRlcmZhY2UoeyBpbnB1dDogY2hpbGQuc3Rkb3V0IH0pO1xuICAgICAgY29uc3Qgb25MaW5lID0gKGxpbmU6IHN0cmluZyk6IHZvaWQgPT4ge1xuICAgICAgICBsZXQgcGFyc2VkOiB1bmtub3duO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHBhcnNlZCA9IEpTT04ucGFyc2UobGluZSk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIHJldHVybjsgLy8gaG9zdCBcdTc2ODRcdTY2NkVcdTkwMUFcdTY1RTVcdTVGRDdcdTg4NEMsXHU1RkZEXHU3NTY1XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGlzSG9zdFJlYWR5TGluZShwYXJzZWQpKSB7XG4gICAgICAgICAgcmwuY2xvc2UoKTtcbiAgICAgICAgICB2b2lkIHRoaXMucHJvYmVBbmRSZW1lbWJlcihwYXJzZWQucG9ydCwgcGFyc2VkLnZlcnNpb24pXG4gICAgICAgICAgICAudGhlbigoZW5kcG9pbnQpID0+IGRvbmUoKCkgPT4gcmVzb2x2ZShlbmRwb2ludCkpKVxuICAgICAgICAgICAgLmNhdGNoKChlcnI6IHVua25vd24pID0+IGRvbmUoKCkgPT4gcmVqZWN0KGVycikpKTtcbiAgICAgICAgfVxuICAgICAgfTtcbiAgICAgIHJsLm9uKCdsaW5lJywgb25MaW5lKTtcblxuICAgICAgY2hpbGQub25jZSgnZXhpdCcsIChjb2RlKSA9PiB7XG4gICAgICAgIGRvbmUoKCkgPT4gcmVqZWN0KGRlc2t0b3BFcnJvcignUlVOVElNRV9DUkFTSEVEJywgYGhvc3QgZXhpdGVkIGR1cmluZyBzdGFydHVwIChjb2RlICR7Y29kZSA/PyAnbnVsbCd9KWAsIHsgcmV0cnlhYmxlOiBmYWxzZSwgcmVjb3ZlcnlBY3Rpb246ICdPUEVOX0xPR1MnIH0pKSk7XG4gICAgICB9KTtcbiAgICB9KTtcbiAgfVxuXG4gIC8qKiBcdTVFMjYgdG9rZW4gXHU3Njg0XHU1MDY1XHU1RUI3XHU2M0EyXHU2RDRCOkdFVCAvYXBpL3N0YXRlXHUzMDAyNDAxIFx1MjE5MiBBVVRIX0ZBSUxFRChcdTRFMERcdTkxQ0RcdThCRDUpXHUzMDAyICovXG4gIHByaXZhdGUgYXN5bmMgcHJvYmUocG9ydDogbnVtYmVyLCB2ZXJzaW9uOiBzdHJpbmcpOiBQcm9taXNlPEhvc3RFbmRwb2ludD4ge1xuICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgIHRyeSB7XG4gICAgICByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2FwaS9zdGF0ZWAsIHtcbiAgICAgICAgaGVhZGVyczogeyAneC1obWgta2V5JzogdGhpcy50b2tlbiB9LFxuICAgICAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoM18wMDApLFxuICAgICAgfSk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICB0aHJvdyBkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYGhlYWx0aCBwcm9iZSBmYWlsZWQ6ICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTYwKX1gLCB7IHJldHJ5YWJsZTogdHJ1ZSB9KTtcbiAgICB9XG4gICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSB8fCByZXMuc3RhdHVzID09PSA0MDMpIHtcbiAgICAgIHRocm93IGRlc2t0b3BFcnJvcignQVVUSF9GQUlMRUQnLCBgaG9zdCByZWplY3RlZCB0aGUgc2Vzc2lvbiB0b2tlbiAoSFRUUCAke3Jlcy5zdGF0dXN9KWAsIHsgcmV0cnlhYmxlOiBmYWxzZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pO1xuICAgIH1cbiAgICBpZiAoIXJlcy5vaykge1xuICAgICAgdGhyb3cgZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBoZWFsdGggcHJvYmUgSFRUUCAke3Jlcy5zdGF0dXN9YCwgeyByZXRyeWFibGU6IHRydWUgfSk7XG4gICAgfVxuICAgIHJldHVybiB7IHBvcnQsIHZlcnNpb24sIHRva2VuOiB0aGlzLnRva2VuIH07XG4gIH1cblxuICBwcml2YXRlIG9uVW5leHBlY3RlZEV4aXQoKTogdm9pZCB7XG4gICAgaWYgKHRoaXMuc3RvcHBpbmcgfHwgdGhpcy5fc3RhdGUgPT09ICdzdG9wcGVkJyB8fCB0aGlzLl9zdGF0ZSA9PT0gJ3N0b3BwaW5nJykgcmV0dXJuO1xuICAgIHRoaXMuY2hpbGQgPSBudWxsO1xuICAgIGlmICh0aGlzLnJlc3RhcnRDb3VudCA8IHRoaXMub3B0cy5tYXhSZXN0YXJ0cykge1xuICAgICAgdGhpcy5yZXN0YXJ0Q291bnQgKz0gMTtcbiAgICAgIHRoaXMuc2V0U3RhdGUoJ3Jlc3RhcnRpbmcnKTtcbiAgICAgIHZvaWQgdGhpcy5sYXVuY2goKS5jYXRjaCgoKSA9PiB7XG4gICAgICAgIC8vIFx1OTFDRFx1NTQyRlx1NUMxRFx1OEJENVx1NTkzMVx1OEQyNShcdTU0MkZcdTUyQThcdTUzNzNcdTVEMjkvXHU4RDg1XHU2NUY2L1x1NjJEMlx1OEJBNCk6XHU3RUU3XHU3RUVEXHU2RDg4XHU4MDE3XHU5MUNEXHU1NDJGXHU2QjIxXHU2NTcwXHU3NkY0XHU1MjMwXHU2NTNFXHU1RjAzXG4gICAgICAgIHRoaXMucmV0cnlPckZhaWwoKTtcbiAgICAgIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLnNldFN0YXRlKCdmYWlsZWQnLCBgaG9zdCBleGl0ZWQgdW5leHBlY3RlZGx5ICR7dGhpcy5yZXN0YXJ0Q291bnQgKyAxfSB0aW1lczsgZ2l2aW5nIHVwYCk7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSByZXRyeU9yRmFpbCgpOiB2b2lkIHtcbiAgICBpZiAodGhpcy5zdG9wcGluZyB8fCB0aGlzLl9zdGF0ZSA9PT0gJ3N0b3BwZWQnIHx8IHRoaXMuX3N0YXRlID09PSAnc3RvcHBpbmcnKSByZXR1cm47XG4gICAgaWYgKHRoaXMucmVzdGFydENvdW50IDwgdGhpcy5vcHRzLm1heFJlc3RhcnRzKSB7XG4gICAgICB0aGlzLnJlc3RhcnRDb3VudCArPSAxO1xuICAgICAgdGhpcy5zZXRTdGF0ZSgncmVzdGFydGluZycpO1xuICAgICAgdm9pZCB0aGlzLmxhdW5jaCgpLmNhdGNoKCgpID0+IHRoaXMucmV0cnlPckZhaWwoKSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMuc2V0U3RhdGUoJ2ZhaWxlZCcsIGBob3N0IGZhaWxlZCB0byBzdGF5IHVwIGFmdGVyICR7dGhpcy5yZXN0YXJ0Q291bnR9IHJlc3RhcnQgYXR0ZW1wdHNgKTtcbiAgICB9XG4gIH1cblxuICAvKiogXHU0RjE4XHU5NkM1XHU1MDVDXHU2QjYyOlx1NTE0OCBIVFRQIHNodXRkb3duLFx1OEQ4NVx1NjVGNlx1NjI0RFx1NUJGOVx1NjcyQ1x1OEZEQlx1N0EwQlx1NTNFNVx1NjdDNCBraWxsXHUzMDAyICovXG4gIGFzeW5jIHN0b3AoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgdGhpcy5zdG9wcGluZyA9IHRydWU7XG4gICAgaWYgKHRoaXMuX3N0YXRlID09PSAnc3RvcHBlZCcpIHJldHVybjtcbiAgICB0aGlzLnNldFN0YXRlKCdzdG9wcGluZycpO1xuICAgIGNvbnN0IGNoaWxkID0gdGhpcy5jaGlsZDtcbiAgICB0aGlzLmNoaWxkID0gbnVsbDtcbiAgICB0aGlzLmN1cnJlbnRFbmRwb2ludCA9IG51bGw7XG4gICAgaWYgKCFjaGlsZCkge1xuICAgICAgdGhpcy5zZXRTdGF0ZSgnc3RvcHBlZCcpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBleGl0ZWQgPSBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4ge1xuICAgICAgaWYgKGNoaWxkLmV4aXRDb2RlICE9PSBudWxsIHx8IGNoaWxkLnNpZ25hbENvZGUgIT09IG51bGwpIHJlc29sdmUoKTtcbiAgICAgIGVsc2Uge1xuICAgICAgICBjb25zdCB3ID0gKCk6IHZvaWQgPT4gcmVzb2x2ZSgpO1xuICAgICAgICB0aGlzLmV4aXRXYWl0ZXJzLnB1c2godyk7XG4gICAgICAgIGNoaWxkLm9uY2UoJ2V4aXQnLCB3KTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICAvLyBcdTVERjJcdTc3RTVcdTdBRUZcdTUzRTNcdTYyNERcdTVDMURcdThCRDUgSFRUUCBcdTRGMThcdTk2QzVcdTUxNzNcdTk1RUQ7XHU2NzJBXHU3N0U1XHU3QUVGXHU1M0UzXHU3NkY0XHU2M0E1XHU4RDcwIGtpbGwgXHU1MTVDXHU1RTk1XG4gICAgaWYgKHRoaXMubGFzdEVuZHBvaW50ICE9PSBudWxsKSB7XG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3RoaXMubGFzdEVuZHBvaW50fS9hcGkvZGVza3RvcC9zaHV0ZG93bmAsIHtcbiAgICAgICAgICBtZXRob2Q6ICdQT1NUJyxcbiAgICAgICAgICBoZWFkZXJzOiB7ICd4LWhtaC1rZXknOiB0aGlzLnRva2VuIH0sXG4gICAgICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDFfMDAwKSxcbiAgICAgICAgfSk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLy8gaG9zdCBcdTVERjJcdTZCN0JcdTYyMTZcdTRFMERcdTVFOTRcdTdCNTQ6XHU4RDcwIGtpbGwgXHU1MTVDXHU1RTk1XG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IGdyYWNlZnVsID0gYXdhaXQgUHJvbWlzZS5yYWNlKFtcbiAgICAgIGV4aXRlZC50aGVuKCgpID0+IHRydWUpLFxuICAgICAgbmV3IFByb21pc2U8Ym9vbGVhbj4oKHJlc29sdmUpID0+IHNldFRpbWVvdXQoKCkgPT4gcmVzb2x2ZShmYWxzZSksIHRoaXMub3B0cy5ncmFjZWZ1bFNodXRkb3duTXMpKSxcbiAgICBdKTtcbiAgICBpZiAoIWdyYWNlZnVsICYmIGNoaWxkLmV4aXRDb2RlID09PSBudWxsICYmIGNoaWxkLnNpZ25hbENvZGUgPT09IG51bGwpIHtcbiAgICAgIGNoaWxkLmtpbGwoKTsgLy8gXHU1M0VBXHU2NzQwXHU4MUVBXHU1REYxXHU2MzAxXHU2NzA5XHU3Njg0XHU1M0U1XHU2N0M0LFx1N0VERFx1NEUwRFx1NjMwOVx1OEZEQlx1N0EwQlx1NTQwRFxuICAgIH1cbiAgICBhd2FpdCBleGl0ZWQuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcbiAgICB0aGlzLnNldFN0YXRlKCdzdG9wcGVkJyk7XG4gIH1cblxuICBwcml2YXRlIGxhc3RFbmRwb2ludDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgY3VycmVudEVuZHBvaW50OiB7IHBvcnQ6IG51bWJlcjsgdmVyc2lvbjogc3RyaW5nIH0gfCBudWxsID0gbnVsbDtcblxuICAvKiogXHU1RjUzXHU1MjREIGhvc3QgXHU3QUVGXHU3MEI5KHJlYWR5IFx1NTQwRVx1NjcwOVx1NTAzQztcdTRFMERcdTU0MkIgdG9rZW4pXHUzMDAyICovXG4gIGdldCBlbmRwb2ludCgpOiB7IHBvcnQ6IG51bWJlcjsgdmVyc2lvbjogc3RyaW5nIH0gfCBudWxsIHtcbiAgICByZXR1cm4gdGhpcy5jdXJyZW50RW5kcG9pbnQ7XG4gIH1cblxuICAvKiogXHU2M0EyXHU2RDRCXHU2MjEwXHU1MjlGXHU1NDBFXHU4QkIwXHU0RjRGXHU3QUVGXHU1M0UzLFx1NEY5QiBzdG9wKCkgXHU3Njg0XHU0RjE4XHU5NkM1XHU1MTczXHU5NUVEXHU0RjdGXHU3NTI4XHUzMDAyICovXG4gIHByaXZhdGUgYXN5bmMgcHJvYmVBbmRSZW1lbWJlcihwb3J0OiBudW1iZXIsIHZlcnNpb246IHN0cmluZyk6IFByb21pc2U8SG9zdEVuZHBvaW50PiB7XG4gICAgY29uc3QgZXAgPSBhd2FpdCB0aGlzLnByb2JlKHBvcnQsIHZlcnNpb24pO1xuICAgIHRoaXMubGFzdEVuZHBvaW50ID0gZXAucG9ydDtcbiAgICByZXR1cm4gZXA7XG4gIH1cbn1cblxuLyoqIFx1NjI4QVx1NjcyQVx1NzdFNVx1OTUxOVx1OEJFRlx1ODlDNFx1N0VBNlx1NEUzQSBEZXNrdG9wRXJyb3IoXHU1REYyXHU2NjJGXHU1MjE5XHU1MzlGXHU2ODM3XHU4RkQ0XHU1NkRFKVx1MzAwMiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRvRGVza3RvcEVycm9yKGVycjogdW5rbm93bik6IERlc2t0b3BFcnJvciB7XG4gIGlmIChpc0Rlc2t0b3BFcnJvcihlcnIpKSByZXR1cm4gZXJyO1xuICBjb25zdCBtZXNzYWdlID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICByZXR1cm4gZGVza3RvcEVycm9yKCdSVU5USU1FX0NSQVNIRUQnLCBtZXNzYWdlLnNsaWNlKDAsIDMwMCksIHsgcmV0cnlhYmxlOiBmYWxzZSB9KTtcbn1cbiIsICIvKipcbiAqIEBobWgtZGVza3RvcC9jb250cmFjdHMgXHUyMDE0IFx1NEU4Qlx1NEVGNlx1NEZFMVx1NUMwMShcdTVGMDBcdTUzRDFcdThCQTFcdTUyMTJcdTY1ODdcdTY4NjMgMDQgXHUwMEE3XHU0RTA5KVxuICpcbiAqIFx1NEUwMFx1Njc2MSBVSSBcdTRFOEJcdTRFRjZcdTc2ODRcdTU1MkZcdTRFMDBcdTVGNjJcdTcyQjZcdTMwMDJcdTUyNERcdTdBRUYgcmVkdWNlciBcdTVGQzVcdTk4N0JcdTYzMDkgc2Vzc2lvbklkL3J1bklkL3NlcSBcdTU5MDRcdTc0MDY7XG4gKiBcdTkxQ0RcdTU5MEQgZXZlbnRJZCBcdTVFNDJcdTdCNDlcdTRFMjJcdTVGMDM7c2VxIFx1N0YzQVx1NTNFM1x1ODlFNlx1NTNEMVx1ODg2NVx1NjJDOTtcdTk3NUVcdTVFNDJcdTdCNDlcdTUyQThcdTRGNUNcdTRFMERcdTc1MzEgU1NFIFx1ODFFQVx1NTJBOFx1OTFDRFx1NTNEMVx1MzAwMlxuICovXG5cbmltcG9ydCB0eXBlIHsgQXJ0aWZhY3RSZWYgfSBmcm9tICcuL2R0by50cyc7XG5pbXBvcnQgdHlwZSB7IERlc2t0b3BFcnJvciB9IGZyb20gJy4vZXJyb3IudHMnO1xuXG4vKiogXHU0RThCXHU0RUY2XHU3OUNEXHU3QzdCKFx1NTIyNFx1NTIyQlx1OTUyRSlcdTMwMDJcdTY1QjBcdTU4OUUga2luZCA9IHNjaGVtYVZlcnNpb24gXHU1MzQ3XHU3RUE3LFx1NEUwRFx1NTE0MVx1OEJCOFx1OTc1OVx1OUVEOFx1NjI2OVx1Njc5QVx1NEUzRVx1MzAwMiAqL1xuZXhwb3J0IGNvbnN0IEVWRU5UX0tJTkRTID0gW1xuICAncnVuLnN0YXJ0ZWQnLFxuICAncGxhbi51cGRhdGVkJyxcbiAgJ3Rvb2wuc3RhcnRlZCcsXG4gICd0b29sLmNvbXBsZXRlZCcsXG4gICdhcHByb3ZhbC5yZXF1aXJlZCcsXG4gICd2ZXJpZmljYXRpb24udXBkYXRlZCcsXG4gICdhcnRpZmFjdC5jcmVhdGVkJyxcbiAgJ3J1bi5jb21wbGV0ZWQnLFxuICAncnVuLmZhaWxlZCcsXG5dIGFzIGNvbnN0O1xuXG5leHBvcnQgdHlwZSBFdmVudEtpbmQgPSAodHlwZW9mIEVWRU5UX0tJTkRTKVtudW1iZXJdO1xuXG5leHBvcnQgY29uc3QgRVZFTlRfU0NIRU1BX1ZFUlNJT04gPSAxO1xuZXhwb3J0IHR5cGUgRXZlbnRTY2hlbWFWZXJzaW9uID0gMTtcblxuLyoqIFNTRSBcdTZENDFcdTRFMEFcdTc2ODRcdTZCQ0ZcdTRFMDBcdTY3NjFcdTRFOEJcdTRFRjZcdTMwMDIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgRXZlbnRFbnZlbG9wZTxUID0gdW5rbm93bj4ge1xuICBzY2hlbWFWZXJzaW9uOiBFdmVudFNjaGVtYVZlcnNpb247XG4gIC8qKiBcdTUxNjhcdTVDNDBcdTU1MkZcdTRFMDA7XHU5MUNEXHU4RkRFL1x1ODg2NVx1NjJDOVx1NTQwRVx1OTFDRFx1NTkwRFx1NTFGQVx1NzNCMFx1NjVGNlx1NjNBNVx1NjUzNlx1NjVCOVx1NUU0Mlx1N0I0OVx1NEUyMlx1NUYwM1x1MzAwMiAqL1xuICBldmVudElkOiBzdHJpbmc7XG4gIHNlc3Npb25JZDogc3RyaW5nO1xuICBydW5JZDogc3RyaW5nO1xuICAvKiogXHU0RjFBXHU4QkREXHU1MTg1XHU1MzU1XHU4QzAzXHU5MDEyXHU1ODlFO1x1N0YzQVx1NTNFM1x1NjEwRlx1NTQ3M1x1Nzc0MFx1NEUyMlx1NEU4Qlx1NEVGNixcdTk3MDBcdTg5ODFcdTg4NjVcdTYyQzlcdTMwMDIgKi9cbiAgc2VxOiBudW1iZXI7XG4gIC8qKiBSRkMzMzM5XHUzMDAyICovXG4gIG9jY3VycmVkQXQ6IHN0cmluZztcbiAga2luZDogRXZlbnRLaW5kO1xuICBwYXlsb2FkOiBUO1xufVxuXG4vKiogcnVuLnN0YXJ0ZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgUnVuU3RhcnRlZFBheWxvYWQge1xuICB0YXNrOiBzdHJpbmc7XG4gIG1vZGU6ICdhc2snIHwgJ2F1dG8nIHwgJ3lvbG8nO1xufVxuXG4vKiogcGxhbi51cGRhdGVkIFx1NzY4NCBwYXlsb2FkKFx1OEJBMVx1NTIxMlx1NkI2NVx1OUFBNFx1NTIxN1x1ODg2OCxcdTY3NjVcdTgxRUEgcnVudGltZSBcdTc2ODRcdTdFRDNcdTY3ODRcdTUzMTZcdThCQTFcdTUyMTIsXHU0RTBEXHU2NjJGIGNoYWluLW9mLXRob3VnaHQpXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIFBsYW5VcGRhdGVkUGF5bG9hZCB7XG4gIHN0ZXBzOiBBcnJheTx7IHRpdGxlOiBzdHJpbmc7IHN0YXR1czogJ3BlbmRpbmcnIHwgJ2FjdGl2ZScgfCAnZG9uZScgfCAnZmFpbGVkJyB9Pjtcbn1cblxuLyoqIHRvb2wuc3RhcnRlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBUb29sU3RhcnRlZFBheWxvYWQge1xuICBuYW1lOiBzdHJpbmc7XG4gIC8qKiBcdTUzQzJcdTY1NzBcdTRFRTVcdTY1ODdcdTY3MkNcdTU0NDhcdTczQjAsXHU2RTMyXHU2N0QzXHU3QUVGXHU2QzM4XHU0RTBEIGV2YWw7XHU1OTI3XHU1QkY5XHU4QzYxXHU3NTMxIHJ1bnRpbWUgXHU2MjJBXHU2NUFEXHUzMDAyICovXG4gIGFyZ3NQcmV2aWV3OiBzdHJpbmc7XG59XG5cbi8qKiB0b29sLmNvbXBsZXRlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBUb29sQ29tcGxldGVkUGF5bG9hZCB7XG4gIG5hbWU6IHN0cmluZztcbiAgaXNFcnJvcjogYm9vbGVhbjtcbiAgb3V0cHV0UHJldmlldzogc3RyaW5nO1xufVxuXG4vKiogYXBwcm92YWwucmVxdWlyZWQgXHU3Njg0IHBheWxvYWRcdTMwMDJcdTVCQTFcdTYyNzlcdTY3NDNcdTVBMDFcdTU3MjggcnVudGltZSBcdTU0MEVcdTdBRUY7VUkgXHU1M0VBXHU2NjJGXHU4RjZDXHU4RkYwXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcHJvdmFsUmVxdWlyZWRQYXlsb2FkIHtcbiAgYXBwcm92YWxJZDogc3RyaW5nO1xuICB0b29sOiBzdHJpbmc7XG4gIGFyZ3NQcmV2aWV3OiBzdHJpbmc7XG4gIC8qKiBcdTVGNzFcdTU0Q0RcdTgzMDNcdTU2RjQvXHU5OENFXHU5NjY5XHU3Njg0XHU0RUJBXHU3QzdCXHU1M0VGXHU4QkZCXHU4QkY0XHU2NjBFLFx1NzUzMSBydW50aW1lIFx1NzUxRlx1NjIxMFx1MzAwMiAqL1xuICByaXNrOiBzdHJpbmc7XG59XG5cbi8qKiB2ZXJpZmljYXRpb24udXBkYXRlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBWZXJpZmljYXRpb25VcGRhdGVkUGF5bG9hZCB7XG4gIHN1bW1hcnk6IHN0cmluZztcbiAgcGFzc2VkOiBib29sZWFuIHwgbnVsbDsgLy8gbnVsbCA9IFx1NjcyQVx1NzdFNS9cdThGREJcdTg4NENcdTRFMkQoTkVFRFMtREFUQSBcdTY1RjZcdTRFMERcdTUwNDdcdTU4NkIpXG59XG5cbi8qKiBhcnRpZmFjdC5jcmVhdGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIEFydGlmYWN0Q3JlYXRlZFBheWxvYWQge1xuICBhcnRpZmFjdDogQXJ0aWZhY3RSZWY7XG59XG5cbi8qKiBydW4uY29tcGxldGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIFJ1bkNvbXBsZXRlZFBheWxvYWQge1xuICB0ZXh0OiBzdHJpbmc7XG4gIHR1cm5zOiBudW1iZXI7XG4gIHRvb2xVc2VzOiBudW1iZXI7XG4gIHVzYWdlPzogeyBwcm9tcHRUb2tlbnM6IG51bWJlcjsgY29tcGxldGlvblRva2VuczogbnVtYmVyIH07XG59XG5cbi8qKiBydW4uZmFpbGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIFJ1bkZhaWxlZFBheWxvYWQge1xuICBlcnJvcjogRGVza3RvcEVycm9yO1xufVxuIiwgIi8qKlxuICogQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyBcdTIwMTQgXHU3RUQzXHU2Nzg0XHU1MzE2XHU2ODRDXHU5NzYyXHU5NTE5XHU4QkVGKFx1NUYwMFx1NTNEMVx1OEJBMVx1NTIxMlx1NjU4N1x1Njg2MyAwNCBcdTAwQTdcdTRFMDkpXHUzMDAyXG4gKlxuICogaG9zdC1ub3QtcmVhZHkgLyBhdXRoLWZhaWxlZCAvIHN0YWxlLXZlcnNpb24gLyBydW50aW1lLWNyYXNoZWQgL1xuICogcG9ydC1iaW5kLWZhaWxlZCAvIHNjaGVtYS1taXNtYXRjaCBcdTVGQzVcdTk4N0JcdTY2MkZcdTdFRDNcdTY3ODRcdTUzMTZcdTk1MTlcdThCRUZcdTc4MDEsXHU1RTc2XHU2M0QwXHU0RjlCXHU0RTBCXHU0RTAwXHU2QjY1XHU1MkE4XHU0RjVDXHUzMDAyXG4gKiBtZXNzYWdlIFx1NjYyRlx1N0VBRlx1NjU4N1x1NjcyQyxcdTZFMzJcdTY3RDNcdTdBRUZcdTZDMzhcdTRFMERcdTYyOEFcdTVCODNcdTVGNTMgSFRNTFx1MzAwMlxuICovXG5leHBvcnQgY29uc3QgRVJST1JfQ09ERVMgPSBbXG4gICdIT1NUX05PVF9SRUFEWScsXG4gICdBVVRIX0ZBSUxFRCcsXG4gICdSVU5USU1FX0NSQVNIRUQnLFxuICAnUE9SVF9CSU5EX0ZBSUxFRCcsXG4gICdTVEFMRV9WRVJTSU9OJyxcbiAgJ1NDSEVNQV9NSVNNQVRDSCcsXG5dIGFzIGNvbnN0O1xuXG5leHBvcnQgdHlwZSBFcnJvckNvZGUgPSAodHlwZW9mIEVSUk9SX0NPREVTKVtudW1iZXJdO1xuXG5leHBvcnQgY29uc3QgUkVDT1ZFUllfQUNUSU9OUyA9IFsnUkVDT05ORUNUJywgJ1JFU1VNRScsICdFWFBPUlQnLCAnT1BFTl9MT0dTJ10gYXMgY29uc3Q7XG5leHBvcnQgdHlwZSBSZWNvdmVyeUFjdGlvbiA9ICh0eXBlb2YgUkVDT1ZFUllfQUNUSU9OUylbbnVtYmVyXTtcblxuZXhwb3J0IGludGVyZmFjZSBEZXNrdG9wRXJyb3Ige1xuICBjb2RlOiBFcnJvckNvZGU7XG4gIC8qKiBcdTdFQUZcdTY1ODdcdTY3MkMsXHU2QzM4XHU0RTBEXHU0RkUxXHU0RUZCXHU0RTNBIEhUTUxcdTMwMDIgKi9cbiAgbWVzc2FnZTogc3RyaW5nO1xuICByZXRyeWFibGU6IGJvb2xlYW47XG4gIHNlc3Npb25JZD86IHN0cmluZztcbiAgcnVuSWQ/OiBzdHJpbmc7XG4gIHJlY292ZXJ5QWN0aW9uPzogUmVjb3ZlcnlBY3Rpb247XG59XG5cbi8qKiBcdTY3ODRcdTkwMjBcdTRFMDBcdTRFMkEgRGVza3RvcEVycm9yKGV4YWN0T3B0aW9uYWxQcm9wZXJ0eVR5cGVzIFx1NTNDQlx1NTk3RClcdTMwMDIgKi9cbmV4cG9ydCBmdW5jdGlvbiBkZXNrdG9wRXJyb3IoXG4gIGNvZGU6IEVycm9yQ29kZSxcbiAgbWVzc2FnZTogc3RyaW5nLFxuICBvcHRzOiB7IHJldHJ5YWJsZT86IGJvb2xlYW47IHNlc3Npb25JZD86IHN0cmluZzsgcnVuSWQ/OiBzdHJpbmc7IHJlY292ZXJ5QWN0aW9uPzogUmVjb3ZlcnlBY3Rpb24gfSA9IHt9LFxuKTogRGVza3RvcEVycm9yIHtcbiAgY29uc3QgZTogRGVza3RvcEVycm9yID0geyBjb2RlLCBtZXNzYWdlLCByZXRyeWFibGU6IG9wdHMucmV0cnlhYmxlID09PSB0cnVlIH07XG4gIGlmIChvcHRzLnNlc3Npb25JZCAhPT0gdW5kZWZpbmVkKSBlLnNlc3Npb25JZCA9IG9wdHMuc2Vzc2lvbklkO1xuICBpZiAob3B0cy5ydW5JZCAhPT0gdW5kZWZpbmVkKSBlLnJ1bklkID0gb3B0cy5ydW5JZDtcbiAgaWYgKG9wdHMucmVjb3ZlcnlBY3Rpb24gIT09IHVuZGVmaW5lZCkgZS5yZWNvdmVyeUFjdGlvbiA9IG9wdHMucmVjb3ZlcnlBY3Rpb247XG4gIHJldHVybiBlO1xufVxuIiwgIi8qKlxuICogQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyBcdTIwMTQgcnVudGltZSBcdTY4MjFcdTlBOEMoZ3VhcmRzKVx1MzAwMlxuICpcbiAqIFx1NkJDRlx1NEUyQVx1OERFOFx1NEZFMVx1NEVGQlx1OEZCOVx1NzU0Q1x1NzY4NFx1NjU3MFx1NjM2RShydW50aW1lXHUyMTkycmVuZGVyZXJcdTMwMDFob3N0XHUyMTkybWFpbilcdThGREJcdTUxNjVcdTUyNERcdTUxNDhcdThGQzcgZ3VhcmQ7XG4gKiBcdTY4MjFcdTlBOENcdTU5MzFcdThEMjVcdTc2ODRcdTY1NzBcdTYzNkVcdTYzMDkgU0NIRU1BX01JU01BVENIIFx1N0VEM1x1Njc4NFx1NTMxNlx1OTUxOVx1OEJFRlx1NTkwNFx1NzQwNixcdTRFMERcdTk3NTlcdTlFRDhcdTYzQTVcdTUzRDdcdTMwMDJcbiAqIFx1NjI0Qlx1NTE5OVx1NUI4OFx1NTM2Qlx1ODAwQ1x1NEUwRFx1NjYyRlx1NUYxNVx1N0IyQ1x1NEUwOVx1NjVCOSBzY2hlbWEgXHU1RTkzOlx1NTk1MVx1N0VBNlx1OTc2Mlx1NUMwRixcdTk2RjZcdTRGOURcdThENTZcdTY1ODdcdTUzMTYoaG1oYXJuZXNzIFx1NTQwQ1x1NkU5MClcdTMwMDJcbiAqL1xuaW1wb3J0IHtcbiAgRVZFTlRfS0lORFMsXG4gIEVWRU5UX1NDSEVNQV9WRVJTSU9OLFxuICB0eXBlIEV2ZW50RW52ZWxvcGUsXG4gIHR5cGUgRXZlbnRLaW5kLFxufSBmcm9tICcuL2V2ZW50LnRzJztcbmltcG9ydCB7IEVSUk9SX0NPREVTLCBSRUNPVkVSWV9BQ1RJT05TLCB0eXBlIERlc2t0b3BFcnJvciB9IGZyb20gJy4vZXJyb3IudHMnO1xuaW1wb3J0IHsgUlVOX1NUQVRVU0VTLCB0eXBlIFJ1blN0YXR1cyB9IGZyb20gJy4vZHRvLnRzJztcblxuY29uc3QgaXNSZWNvcmQgPSAodjogdW5rbm93bik6IHYgaXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPT5cbiAgdHlwZW9mIHYgPT09ICdvYmplY3QnICYmIHYgIT09IG51bGwgJiYgIUFycmF5LmlzQXJyYXkodik7XG5cbmNvbnN0IGlzTm9uRW1wdHlTdHJpbmcgPSAodjogdW5rbm93bik6IHYgaXMgc3RyaW5nID0+IHR5cGVvZiB2ID09PSAnc3RyaW5nJyAmJiB2Lmxlbmd0aCA+IDA7XG5cbmNvbnN0IGlzUmZjMzMzOSA9ICh2OiBzdHJpbmcpOiBib29sZWFuID0+IHtcbiAgY29uc3QgdCA9IERhdGUucGFyc2Uodik7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUodCkgJiYgL1xcZHs0fS1cXGR7Mn0tXFxkezJ9VC8udGVzdCh2KTtcbn07XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0V2ZW50RW52ZWxvcGUodjogdW5rbm93bik6IHYgaXMgRXZlbnRFbnZlbG9wZSB7XG4gIGlmICghaXNSZWNvcmQodikpIHJldHVybiBmYWxzZTtcbiAgaWYgKHYuc2NoZW1hVmVyc2lvbiAhPT0gRVZFTlRfU0NIRU1BX1ZFUlNJT04pIHJldHVybiBmYWxzZTtcbiAgaWYgKCFpc05vbkVtcHR5U3RyaW5nKHYuZXZlbnRJZCkpIHJldHVybiBmYWxzZTtcbiAgaWYgKCFpc05vbkVtcHR5U3RyaW5nKHYuc2Vzc2lvbklkKSkgcmV0dXJuIGZhbHNlO1xuICBpZiAoIWlzTm9uRW1wdHlTdHJpbmcodi5ydW5JZCkpIHJldHVybiBmYWxzZTtcbiAgaWYgKHR5cGVvZiB2LnNlcSAhPT0gJ251bWJlcicgfHwgIU51bWJlci5pc0ludGVnZXIodi5zZXEpIHx8IHYuc2VxIDwgMCkgcmV0dXJuIGZhbHNlO1xuICBpZiAoIWlzTm9uRW1wdHlTdHJpbmcodi5vY2N1cnJlZEF0KSB8fCAhaXNSZmMzMzM5KHYub2NjdXJyZWRBdCkpIHJldHVybiBmYWxzZTtcbiAgaWYgKCFFVkVOVF9LSU5EUy5pbmNsdWRlcyh2LmtpbmQgYXMgRXZlbnRLaW5kKSkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gaXNSZWNvcmQodi5wYXlsb2FkKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzRGVza3RvcEVycm9yKHY6IHVua25vd24pOiB2IGlzIERlc2t0b3BFcnJvciB7XG4gIGlmICghaXNSZWNvcmQodikpIHJldHVybiBmYWxzZTtcbiAgaWYgKCFFUlJPUl9DT0RFUy5pbmNsdWRlcyh2LmNvZGUgYXMgbmV2ZXIpKSByZXR1cm4gZmFsc2U7XG4gIGlmICh0eXBlb2Ygdi5tZXNzYWdlICE9PSAnc3RyaW5nJykgcmV0dXJuIGZhbHNlO1xuICBpZiAodHlwZW9mIHYucmV0cnlhYmxlICE9PSAnYm9vbGVhbicpIHJldHVybiBmYWxzZTtcbiAgaWYgKHYuc2Vzc2lvbklkICE9PSB1bmRlZmluZWQgJiYgIWlzTm9uRW1wdHlTdHJpbmcodi5zZXNzaW9uSWQpKSByZXR1cm4gZmFsc2U7XG4gIGlmICh2LnJ1bklkICE9PSB1bmRlZmluZWQgJiYgIWlzTm9uRW1wdHlTdHJpbmcodi5ydW5JZCkpIHJldHVybiBmYWxzZTtcbiAgaWYgKHYucmVjb3ZlcnlBY3Rpb24gIT09IHVuZGVmaW5lZCAmJiAhUkVDT1ZFUllfQUNUSU9OUy5pbmNsdWRlcyh2LnJlY292ZXJ5QWN0aW9uIGFzIG5ldmVyKSkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzUnVuU3RhdHVzKHY6IHVua25vd24pOiB2IGlzIFJ1blN0YXR1cyB7XG4gIHJldHVybiB0eXBlb2YgdiA9PT0gJ3N0cmluZycgJiYgUlVOX1NUQVRVU0VTLmluY2x1ZGVzKHYgYXMgUnVuU3RhdHVzKTtcbn1cblxuLyoqIEhvc3QgXHU1RjE1XHU1QkZDXHU4ODRDKHN0ZG91dCBcdTdCMkNcdTRFMDBcdTg4NEMpXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gaXNIb3N0UmVhZHlMaW5lKHY6IHVua25vd24pOiB2IGlzIHsgaG1oRGVza3RvcEhvc3RSZWFkeTogdHJ1ZTsgcG9ydDogbnVtYmVyOyB2ZXJzaW9uOiBzdHJpbmcgfSB7XG4gIGlmICghaXNSZWNvcmQodikpIHJldHVybiBmYWxzZTtcbiAgaWYgKHYuaG1oRGVza3RvcEhvc3RSZWFkeSAhPT0gdHJ1ZSkgcmV0dXJuIGZhbHNlO1xuICBpZiAodHlwZW9mIHYucG9ydCAhPT0gJ251bWJlcicgfHwgIU51bWJlci5pc0ludGVnZXIodi5wb3J0KSB8fCB2LnBvcnQgPD0gMCB8fCB2LnBvcnQgPiA2NTUzNSkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gaXNOb25FbXB0eVN0cmluZyh2LnZlcnNpb24pO1xufVxuIiwgIi8qKlxuICogRGVza3RvcEhvc3RDbGllbnQgXHUyMDE0IFx1NUJGOSBobWggaG9zdCBcdTc2ODQgSFRUUCtTU0UgXHU1QkEyXHU2MjM3XHU3QUVGXHUzMDAyXG4gKlxuICogLSBcdTZCQ0ZcdTRFMkEgSFRUUCBcdThCRjdcdTZDNDJcdTgxRUFcdTUyQThcdTVFMjYgWC1IbWgtS2V5KHRva2VuIFx1NEUwRFx1OEZEQiBVUkwpO1xuICogLSBcdTdFRDNcdTY3ODRcdTUzMTZcdTk1MTlcdThCRUYocmVzLmJvZHkgXHU5MUNDXHU3Njg0IERlc2t0b3BFcnJvciBcdTVGNjJcdTcyQjZcdTYyMTYgSFRUUCBcdTcyQjZcdTYwMDEpXHU4OUM0XHU3RUE2XHU2MjEwXHU1RjAyXHU1RTM4XHU2MjlCXHU1MUZBO1xuICogLSBTU0UgXHU3NTI4IGZldGNoIFx1NkQ0MVx1NjI0Qlx1NTE5OVx1ODlFM1x1Njc5MChpZC9ldmVudC9kYXRhIFx1NUUyNyksXHU2NTJGXHU2MzAxIExhc3QtRXZlbnQtSUQgXHU4ODY1XHU2MkM5XHU5MUNEXHU4RkRFXHUzMDAyXG4gKi9cbmltcG9ydCB7IGRlc2t0b3BFcnJvciwgaXNEZXNrdG9wRXJyb3IsIGlzRXZlbnRFbnZlbG9wZSwgdHlwZSBEZXNrdG9wRXJyb3IsIHR5cGUgRXZlbnRFbnZlbG9wZSB9IGZyb20gJ0BobWgtZGVza3RvcC9jb250cmFjdHMnO1xuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gJ25vZGU6Y3J5cHRvJztcblxuZXhwb3J0IGludGVyZmFjZSBTc2VGcmFtZSB7XG4gIGlkPzogc3RyaW5nO1xuICBldmVudDogc3RyaW5nO1xuICBkYXRhOiBzdHJpbmc7XG59XG5cbi8qKiBcdTg5RTNcdTY3OTBcdTRFMDBcdTZCQjUgU1NFIFx1NjU4N1x1NjcyQ1x1NEUzQVx1NUUyNyhcdTRFMERcdTU0MkJcdThERTggY2h1bmsgXHU3Njg0XHU3RjEzXHU1MUIyXHU5MDNCXHU4RjkxLFx1N0VBRlx1NTFGRFx1NjU3MFx1NEZCRlx1NEU4RVx1NkQ0Qlx1OEJENSlcdTMwMDIgKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVNzZUNodW5rKGNodW5rOiBzdHJpbmcpOiBTc2VGcmFtZVtdIHtcbiAgY29uc3QgZnJhbWVzOiBTc2VGcmFtZVtdID0gW107XG4gIGZvciAoY29uc3QgYmxvY2sgb2YgY2h1bmsuc3BsaXQoL1xcblxcbi8pKSB7XG4gICAgaWYgKCFibG9jay50cmltKCkpIGNvbnRpbnVlO1xuICAgIGxldCBpZDogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAgIGxldCBldmVudCA9ICdtZXNzYWdlJztcbiAgICBjb25zdCBkYXRhTGluZXM6IHN0cmluZ1tdID0gW107XG4gICAgbGV0IHNhd0ZpZWxkID0gZmFsc2U7XG4gICAgZm9yIChjb25zdCBsaW5lIG9mIGJsb2NrLnNwbGl0KCdcXG4nKSkge1xuICAgICAgaWYgKGxpbmUuc3RhcnRzV2l0aCgnOicpKSBjb250aW51ZTsgLy8gXHU2Q0U4XHU5MUNBL1x1NUZDM1x1OERGM1xuICAgICAgaWYgKGxpbmUuc3RhcnRzV2l0aCgnaWQ6JykpIHsgaWQgPSBsaW5lLnNsaWNlKDMpLnRyaW0oKTsgc2F3RmllbGQgPSB0cnVlOyB9XG4gICAgICBlbHNlIGlmIChsaW5lLnN0YXJ0c1dpdGgoJ2V2ZW50OicpKSB7IGV2ZW50ID0gbGluZS5zbGljZSg2KS50cmltKCk7IHNhd0ZpZWxkID0gdHJ1ZTsgfVxuICAgICAgZWxzZSBpZiAobGluZS5zdGFydHNXaXRoKCdkYXRhOicpKSB7IGRhdGFMaW5lcy5wdXNoKGxpbmUuc2xpY2UoNSkucmVwbGFjZSgvXiAvLCAnJykpOyBzYXdGaWVsZCA9IHRydWU7IH1cbiAgICB9XG4gICAgaWYgKCFzYXdGaWVsZCkgY29udGludWU7IC8vIFx1N0VBRlx1NkNFOFx1OTFDQS9cdTVGQzNcdThERjNcdTU3NTdcdTRFMERcdTRFQTdcdTc1MUZcdTVFMjdcbiAgICBmcmFtZXMucHVzaCh7IC4uLihpZCAhPT0gdW5kZWZpbmVkID8geyBpZCB9IDoge30pLCBldmVudCwgZGF0YTogZGF0YUxpbmVzLmpvaW4oJ1xcbicpIH0pO1xuICB9XG4gIHJldHVybiBmcmFtZXM7XG59XG5cbi8qKiBcdTRFQ0UgU1NFIFx1NUUyN1x1NjU3MFx1NjM2RVx1NEUyRFx1ODlFM1x1NTFGQVx1NTQwOFx1NkNENSBFdmVudEVudmVsb3BlO1x1NEUwRFx1NTQwOFx1NkNENVx1NzY4NFx1OEZENFx1NTZERSBudWxsKFNDSEVNQV9NSVNNQVRDSCBcdTc1MzFcdThDMDNcdTc1MjhcdTY1QjlcdThCQTFcdTY1NzApXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gZW52ZWxvcGVGcm9tRnJhbWUoZnJhbWU6IFNzZUZyYW1lKTogRXZlbnRFbnZlbG9wZSB8IG51bGwge1xuICBpZiAoZnJhbWUuZXZlbnQgIT09ICdobWgnKSByZXR1cm4gbnVsbDsgLy8gXHU2MjExXHU0RUVDXHU3Njg0XHU0RThCXHU0RUY2XHU0RkUxXHU1QzAxXHU3RURGXHU0RTAwXHU4RDcwIGV2ZW50OiBobWhcbiAgdHJ5IHtcbiAgICBjb25zdCBwYXJzZWQ6IHVua25vd24gPSBKU09OLnBhcnNlKGZyYW1lLmRhdGEpO1xuICAgIHJldHVybiBpc0V2ZW50RW52ZWxvcGUocGFyc2VkKSA/IHBhcnNlZCA6IG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbmV4cG9ydCBjbGFzcyBEZXNrdG9wSHR0cEVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICBjb25zdHJ1Y3RvcihwdWJsaWMgcmVhZG9ubHkgZGV0YWlsOiBEZXNrdG9wRXJyb3IpIHtcbiAgICBzdXBlcihkZXRhaWwubWVzc2FnZSk7XG4gIH1cbn1cblxuZXhwb3J0IGNsYXNzIERlc2t0b3BIb3N0Q2xpZW50IHtcbiAgY29uc3RydWN0b3IoXG4gICAgcHJpdmF0ZSByZWFkb25seSBiYXNlVXJsOiBzdHJpbmcsXG4gICAgcHJpdmF0ZSByZWFkb25seSB0b2tlbjogc3RyaW5nLFxuICApIHt9XG5cbiAgcHJpdmF0ZSBoZWFkZXJzKGV4dHJhOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge30pOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IHtcbiAgICByZXR1cm4geyAneC1obWgta2V5JzogdGhpcy50b2tlbiwgLi4uZXh0cmEgfTtcbiAgfVxuXG4gIGFzeW5jIGdldEpzb248VD4ocGF0aDogc3RyaW5nLCB0aW1lb3V0TXMgPSA1XzAwMCk6IFByb21pc2U8VD4ge1xuICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgIHRyeSB7XG4gICAgICByZXMgPSBhd2FpdCBmZXRjaChgJHt0aGlzLmJhc2VVcmx9JHtwYXRofWAsIHsgaGVhZGVyczogdGhpcy5oZWFkZXJzKCksIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCh0aW1lb3V0TXMpIH0pO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGByZXF1ZXN0IGZhaWxlZDogJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxNjApfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy5wYXJzZVJlc3BvbnNlPFQ+KHJlcyk7XG4gIH1cblxuICAvKiogXHU2MkM5XHU1M0Q2XHU3RUFGXHU2NTg3XHU2NzJDXHU3QUVGXHU3MEI5KFx1NTk4MiAvYXBpL3Nlc3Npb25zLzppZC9leHBvcnQubWQpXHUzMDAyICovXG4gIGFzeW5jIGdldFRleHQocGF0aDogc3RyaW5nLCB0aW1lb3V0TXMgPSAxMF8wMDApOiBQcm9taXNlPHN0cmluZz4ge1xuICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgIHRyeSB7XG4gICAgICByZXMgPSBhd2FpdCBmZXRjaChgJHt0aGlzLmJhc2VVcmx9JHtwYXRofWAsIHsgaGVhZGVyczogdGhpcy5oZWFkZXJzKCksIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCh0aW1lb3V0TXMpIH0pO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGByZXF1ZXN0IGZhaWxlZDogJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxNjApfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICBpZiAocmVzLnN0YXR1cyA9PT0gNDAxIHx8IHJlcy5zdGF0dXMgPT09IDQwMykge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdBVVRIX0ZBSUxFRCcsIGBob3N0IHJlamVjdGVkIHRoZSBzZXNzaW9uIHRva2VuIChIVFRQICR7cmVzLnN0YXR1c30pYCwgeyByZXRyeWFibGU6IGZhbHNlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICBpZiAoIXJlcy5vaykge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBIVFRQICR7cmVzLnN0YXR1c31gLCB7IHJldHJ5YWJsZTogcmVzLnN0YXR1cyA+PSA1MDAgfSkpO1xuICAgIH1cbiAgICByZXR1cm4gcmVzLnRleHQoKTtcbiAgfVxuXG4gIC8qKiBcdTZCQ0ZcdTRFMkFcdTVFMjZcdTUyNkZcdTRGNUNcdTc1MjhcdTc2ODQgUE9TVCBcdTgxRUFcdTUyQThcdTY0M0FcdTVFMjZcdTVFNDJcdTdCNDlcdTk1MkUoMDMgXHUwMEE3XHU1NkRCXHU5NjMyXHU5MUNEXHU2NTNFOlx1OEJGN1x1NkM0Mlx1NEY3Rlx1NzUyOCBpZGVtcG90ZW5jeUtleTtcbiAgICogIHJ1bnRpbWUgXHU0RkE3XHU3N0VEXHU2NzFGXHU1MTdDXHU1QkI5XHU1RkZEXHU3NTY1LFx1NTM0Rlx1OEJBRVx1NTE0OFx1ODg0Q1x1MjAxNFx1MjAxNFx1OTFDRFx1OEJENVx1NTNFRlx1NTFFRFx1OTUyRVx1NTNCQlx1OTFDRCxcdTRFMERcdTc2RjJcdTc2RUVcdTkxQ0RcdTY1M0UpXHUzMDAyICovXG4gIGFzeW5jIHBvc3RKc29uPFQ+KHBhdGg6IHN0cmluZywgYm9keTogdW5rbm93biwgdGltZW91dE1zID0gMTBfMDAwKTogUHJvbWlzZTxUPiB7XG4gICAgbGV0IHJlczogUmVzcG9uc2U7XG4gICAgdHJ5IHtcbiAgICAgIHJlcyA9IGF3YWl0IGZldGNoKGAke3RoaXMuYmFzZVVybH0ke3BhdGh9YCwge1xuICAgICAgICBtZXRob2Q6ICdQT1NUJyxcbiAgICAgICAgaGVhZGVyczogdGhpcy5oZWFkZXJzKHtcbiAgICAgICAgICAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgICAgICAgICd4LWlkZW1wb3RlbmN5LWtleSc6IHJhbmRvbVVVSUQoKSxcbiAgICAgICAgfSksXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpLFxuICAgICAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQodGltZW91dE1zKSxcbiAgICAgIH0pO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGByZXF1ZXN0IGZhaWxlZDogJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxNjApfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy5wYXJzZVJlc3BvbnNlPFQ+KHJlcyk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHBhcnNlUmVzcG9uc2U8VD4ocmVzOiBSZXNwb25zZSk6IFByb21pc2U8VD4ge1xuICAgIGlmIChyZXMuc3RhdHVzID09PSA0MDEgfHwgcmVzLnN0YXR1cyA9PT0gNDAzKSB7XG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgYGhvc3QgcmVqZWN0ZWQgdGhlIHNlc3Npb24gdG9rZW4gKEhUVFAgJHtyZXMuc3RhdHVzfSlgLCB7IHJldHJ5YWJsZTogZmFsc2UsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XG4gICAgfVxuICAgIGNvbnN0IHRleHQgPSBhd2FpdCByZXMudGV4dCgpO1xuICAgIGxldCBwYXJzZWQ6IHVua25vd24gPSBudWxsO1xuICAgIHRyeSB7XG4gICAgICBwYXJzZWQgPSB0ZXh0ID8gSlNPTi5wYXJzZSh0ZXh0KSA6IG51bGw7XG4gICAgfSBjYXRjaCB7XG4gICAgICBwYXJzZWQgPSBudWxsO1xuICAgIH1cbiAgICBpZiAoIXJlcy5vaykge1xuICAgICAgaWYgKGlzRGVza3RvcEVycm9yKHBhcnNlZCkpIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKHBhcnNlZCk7XG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYEhUVFAgJHtyZXMuc3RhdHVzfTogJHt0ZXh0LnNsaWNlKDAsIDE2MCl9YCwgeyByZXRyeWFibGU6IHJlcy5zdGF0dXMgPj0gNTAwIH0pKTtcbiAgICB9XG4gICAgcmV0dXJuIHBhcnNlZCBhcyBUO1xuICB9XG5cbiAgLyoqXG4gICAqIFx1OEJBMlx1OTYwNVx1NTE2OFx1OTBFOCBTU0UgXHU1RTI3KFx1NTQyQlx1OTc1RVx1NEZFMVx1NUMwMVx1NEU4Qlx1NEVGNjpkZWx0YS9saW5lIFx1N0I0OVx1OUFEOFx1OTg5MVx1NkQ0MSlcdTMwMDJcdTRGRTFcdTVDMDFcdTc1MzFcdThDMDNcdTc1MjhcdTY1QjlcbiAgICogXHU3NTI4IGVudmVsb3BlRnJvbUZyYW1lIFx1ODFFQVx1ODg0Q1x1NTIwNlx1NkQ0MTtcdTY1QURcdTdFQkZcdTkxQ0RcdThGREVcdThCRURcdTRFNDlcdTU0MEMgZXZlbnRzKClcdTMwMDJcbiAgICovXG4gIGFzeW5jICpyYXdFdmVudHMobGFzdEV2ZW50SWQ/OiBzdHJpbmcsIHNpZ25hbD86IEFib3J0U2lnbmFsKTogQXN5bmNHZW5lcmF0b3I8U3NlRnJhbWU+IHtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgJHt0aGlzLmJhc2VVcmx9L2FwaS9ldmVudHNgLCB7XG4gICAgICBoZWFkZXJzOiB0aGlzLmhlYWRlcnMoe1xuICAgICAgICBhY2NlcHQ6ICd0ZXh0L2V2ZW50LXN0cmVhbScsXG4gICAgICAgIC4uLihsYXN0RXZlbnRJZCAhPT0gdW5kZWZpbmVkID8geyAnbGFzdC1ldmVudC1pZCc6IGxhc3RFdmVudElkIH0gOiB7fSksXG4gICAgICB9KSxcbiAgICAgIC4uLihzaWduYWwgIT09IHVuZGVmaW5lZCA/IHsgc2lnbmFsIH0gOiB7fSksXG4gICAgfSk7XG4gICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSB8fCByZXMuc3RhdHVzID09PSA0MDMpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignQVVUSF9GQUlMRUQnLCBgaG9zdCByZWplY3RlZCB0aGUgc2Vzc2lvbiB0b2tlbiAoSFRUUCAke3Jlcy5zdGF0dXN9KWAsIHsgcmV0cnlhYmxlOiBmYWxzZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcbiAgICB9XG4gICAgaWYgKCFyZXMub2sgfHwgcmVzLmJvZHkgPT09IG51bGwpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgU1NFIEhUVFAgJHtyZXMuc3RhdHVzfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICBjb25zdCByZWFkZXIgPSByZXMuYm9keS5nZXRSZWFkZXIoKTtcbiAgICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKCk7XG4gICAgbGV0IGJ1ZmZlciA9ICcnO1xuICAgIGZvciAoOzspIHtcbiAgICAgIGNvbnN0IHsgZG9uZSwgdmFsdWUgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICBpZiAoZG9uZSkgcmV0dXJuO1xuICAgICAgYnVmZmVyICs9IGRlY29kZXIuZGVjb2RlKHZhbHVlLCB7IHN0cmVhbTogdHJ1ZSB9KTtcbiAgICAgIGxldCBpZHg6IG51bWJlcjtcbiAgICAgIHdoaWxlICgoaWR4ID0gYnVmZmVyLmluZGV4T2YoJ1xcblxcbicpKSAhPT0gLTEpIHtcbiAgICAgICAgY29uc3QgYmxvY2sgPSBidWZmZXIuc2xpY2UoMCwgaWR4KTtcbiAgICAgICAgYnVmZmVyID0gYnVmZmVyLnNsaWNlKGlkeCArIDIpO1xuICAgICAgICBmb3IgKGNvbnN0IGZyYW1lIG9mIHBhcnNlU3NlQ2h1bmsoYmxvY2spKSB5aWVsZCBmcmFtZTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogXHU4QkEyXHU5NjA1IFNTRSBcdTRFOEJcdTRFRjZcdTZENDEoYXN5bmMgaXRlcmF0b3IpXHUzMDAyXHU2NUFEXHU3RUJGXHU3NTMxXHU4QzAzXHU3NTI4XHU2NUI5XHU5MUNEXHU4RkRFO1x1OTFDRFx1OEZERVx1NjVGNlx1NjI4QVx1NjcwMFx1NTQwRVxuICAgKiBcdTY1MzZcdTUyMzBcdTc2ODQgZXZlbnRJZCBcdTRGMjBcdTUxNjUgbGFzdEV2ZW50SWQsaG9zdCBcdTdBRUZcdTRFQ0VcdTkxQ0RcdTY1M0VcdTczQUZcdTg4NjVcdTUzRDFcdTMwMDJcbiAgICovXG4gIGFzeW5jICpldmVudHMobGFzdEV2ZW50SWQ/OiBzdHJpbmcsIHNpZ25hbD86IEFib3J0U2lnbmFsKTogQXN5bmNHZW5lcmF0b3I8RXZlbnRFbnZlbG9wZT4ge1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGAke3RoaXMuYmFzZVVybH0vYXBpL2V2ZW50c2AsIHtcbiAgICAgIGhlYWRlcnM6IHRoaXMuaGVhZGVycyh7XG4gICAgICAgIGFjY2VwdDogJ3RleHQvZXZlbnQtc3RyZWFtJyxcbiAgICAgICAgLi4uKGxhc3RFdmVudElkICE9PSB1bmRlZmluZWQgPyB7ICdsYXN0LWV2ZW50LWlkJzogbGFzdEV2ZW50SWQgfSA6IHt9KSxcbiAgICAgIH0pLFxuICAgICAgLi4uKHNpZ25hbCAhPT0gdW5kZWZpbmVkID8geyBzaWduYWwgfSA6IHt9KSxcbiAgICB9KTtcbiAgICBpZiAocmVzLnN0YXR1cyA9PT0gNDAxIHx8IHJlcy5zdGF0dXMgPT09IDQwMykge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdBVVRIX0ZBSUxFRCcsIGBob3N0IHJlamVjdGVkIHRoZSBzZXNzaW9uIHRva2VuIChIVFRQICR7cmVzLnN0YXR1c30pYCwgeyByZXRyeWFibGU6IGZhbHNlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICBpZiAoIXJlcy5vayB8fCAhcmVzLmJvZHkpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgU1NFIEhUVFAgJHtyZXMuc3RhdHVzfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICBjb25zdCByZWFkZXIgPSByZXMuYm9keS5nZXRSZWFkZXIoKTtcbiAgICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKCk7XG4gICAgbGV0IGJ1ZmZlciA9ICcnO1xuICAgIGZvciAoOzspIHtcbiAgICAgIGNvbnN0IHsgZG9uZSwgdmFsdWUgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICBpZiAoZG9uZSkgcmV0dXJuO1xuICAgICAgYnVmZmVyICs9IGRlY29kZXIuZGVjb2RlKHZhbHVlLCB7IHN0cmVhbTogdHJ1ZSB9KTtcbiAgICAgIC8vIFx1NEVFNVx1N0E3QVx1ODg0Q1x1NTIwNlx1NUUyNztcdTRGRERcdTc1NTlcdTRFMERcdTVCOENcdTY1NzRcdTc2ODRcdTVDM0VcdTkwRThcbiAgICAgIGxldCBpZHg6IG51bWJlcjtcbiAgICAgIHdoaWxlICgoaWR4ID0gYnVmZmVyLmluZGV4T2YoJ1xcblxcbicpKSAhPT0gLTEpIHtcbiAgICAgICAgY29uc3QgYmxvY2sgPSBidWZmZXIuc2xpY2UoMCwgaWR4KTtcbiAgICAgICAgYnVmZmVyID0gYnVmZmVyLnNsaWNlKGlkeCArIDIpO1xuICAgICAgICBmb3IgKGNvbnN0IGZyYW1lIG9mIHBhcnNlU3NlQ2h1bmsoYmxvY2spKSB7XG4gICAgICAgICAgY29uc3QgZW52ID0gZW52ZWxvcGVGcm9tRnJhbWUoZnJhbWUpO1xuICAgICAgICAgIGlmIChlbnYgIT09IG51bGwpIHlpZWxkIGVudjtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxufVxuIiwgIi8qKlxuICogZmFrZSBob3N0IFx1MjAxNCBobWhhcm5lc3MgcnVudGltZSBcdTc2ODRcdTZENEJcdThCRDVcdTY2RkZcdThFQUIoTWFzdGVyUHJvbXB0IFx1OTYzNlx1NkJCNSBEL0U6XG4gKiBcIlx1NTE0OFx1NEY3Rlx1NzUyOCBmYWtlIGhvc3QgXHU3RjE2XHU1MTk5XHU3MkI2XHU2MDAxXHU2NzNBXHU2RDRCXHU4QkQ1LFx1NTE4RFx1NjNBNVx1NzcxRlx1NUI5RSBBUElcIjtcdTk2MzZcdTZCQjUgRSBcdTc2ODRcdTRGMUFcdThCRERcdTdFQjVcdTUyMDdcdTcyNDdcbiAqIGUyZSBcdTRFNUZcdTUxNDhcdTU3MjggZmFrZSBcdTVDNDJcdTk1RURcdTczQUYpXHUzMDAyXG4gKlxuICogXHU2ODRDXHU5NzYyIGhvc3QgXHU1NDA4XHU1NDBDOlxuICogIC0gXHU1M0VBXHU3RUQxIDEyNy4wLjAuMSxcdTdBRUZcdTUzRTMgT1MgXHU1MjA2XHU5MTRELFx1NUI5RVx1OTY0NVx1N0FFRlx1NTNFM1x1NTE5OSBzdGRvdXQgXHU1RjE1XHU1QkZDXHU4ODRDO1xuICogIC0gXHU2MjQwXHU2NzA5IC9hcGkvKiBcdTg5ODFcdTZDNDIgWC1IbWgtS2V5ID09PSBITUhfREVTS1RPUF9UT0tFTixcdTU0MjZcdTUyMTkgNDAxICsgRGVza3RvcEVycm9yO1xuICogIC0gR0VUIC9hcGkvc3RhdGUgXHU1MDY1XHU1RUI3XHU2M0EyXHU2RDRCO0dFVCAvYXBpL2V2ZW50cyBTU0UoZXZlbnQ6IGhtaCBcdTRGRTFcdTVDMDFcdTZENDEgKyBcdTkxQ0RcdTY1M0VcdTczQUYpO1xuICogIC0gUE9TVCAvYXBpL2Rlc2t0b3Avc2h1dGRvd24gXHU0RjE4XHU5NkM1XHU5MDAwXHU1MUZBXHUzMDAyXG4gKlxuICogXHU5NjM2XHU2QkI1IEUgXHU2QTIxXHU2MkRGXHU5NzYyKFx1NEUwRSBobWhhcm5lc3MgZGVza3RvcCBcdTZBMjFcdTVGMEZcdTU0MENcdTVGNjIpOlxuICogIC0gUE9TVCAvYXBpL3Rhc2sge3RleHQsIHNlc3Npb25JZCwgbW9kZX06XHU2MzkyXHU5NjFGXHU1RTc2XHU2MzA5XHU4MTFBXHU2NzJDXHU1M0QxXG4gKiAgICBydW4uc3RhcnRlZCBcdTIxOTIgdG9vbC5zdGFydGVkL2NvbXBsZXRlZCBcdTIxOTIobW9kZT09PSdhc2snIFx1NjVGNilcbiAqICAgIGFwcHJvdmFsLnJlcXVpcmVkKFx1N0I0OSAvYXBpL2FwcHJvdmUpXHUyMTkyIHJ1bi5jb21wbGV0ZWQ7XG4gKiAgLSBQT1NUIC9hcGkvYXBwcm92ZSB7Z3JhbnRlZCwgc2Vzc2lvbklkfTtcbiAqICAtIFBPU1QgL2FwaS9pbnRlcnJ1cHQge3Nlc3Npb25JZH07XG4gKiAgLSBHRVQgL2FwaS9zZXNzaW9uc1x1MzAwMlxuICpcbiAqIFx1NkQ0Qlx1OEJENVx1OTRBOVx1NUI1MDpGQUtFX0hPU1RfRElFX0FGVEVSX01TIC8gRkFLRV9IT1NUX0RJRV9BVF9CT09UIC9cbiAqIEZBS0VfSE9TVF9FWFBFQ1RfVE9LRU4gLyBGQUtFX0hPU1RfVEFTS19ERUxBWV9NUyAvIEZBS0VfSE9TVF9UQVNLX0ZBSUw9MVxuICogKFx1NEVGQlx1NTJBMVx1NEVFNSBydW4uZmFpbGVkIFx1N0VEM1x1Njc1RixcdTY3ODRcdTkwMjBcdTk1MTlcdThCRUZcdTYwNjJcdTU5MERcdTU3M0FcdTY2NkYpXHUzMDAyXG4gKi9cbmltcG9ydCB7IGNyZWF0ZVNlcnZlciwgdHlwZSBTZXJ2ZXJSZXNwb25zZSB9IGZyb20gJ25vZGU6aHR0cCc7XG5pbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSAnbm9kZTpjcnlwdG8nO1xuaW1wb3J0IHsgcGF0aFRvRmlsZVVSTCB9IGZyb20gJ25vZGU6dXJsJztcbmltcG9ydCB7IHJlYWxwYXRoU3luYyB9IGZyb20gJ25vZGU6ZnMnO1xuaW1wb3J0IHsgRVZFTlRfU0NIRU1BX1ZFUlNJT04sIGRlc2t0b3BFcnJvciwgdHlwZSBFdmVudEVudmVsb3BlLCB0eXBlIEV2ZW50S2luZCB9IGZyb20gJ0BobWgtZGVza3RvcC9jb250cmFjdHMnO1xuXG5leHBvcnQgaW50ZXJmYWNlIEZha2VIb3N0SGFuZGxlIHtcbiAgcG9ydDogbnVtYmVyO1xuICBlbWl0KHNlc3Npb25JZDogc3RyaW5nLCBydW5JZDogc3RyaW5nLCBraW5kOiBFdmVudEtpbmQsIHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogbnVtYmVyO1xuICBjbG9zZSgpOiBQcm9taXNlPHZvaWQ+O1xufVxuXG5pbnRlcmZhY2UgRmFrZVNlc3Npb24ge1xuICBpZDogc3RyaW5nO1xuICBjcmVhdGVkQXQ6IHN0cmluZztcbiAgdXBkYXRlZEF0OiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBQZW5kaW5nQXBwcm92YWwge1xuICBzZXNzaW9uSWQ6IHN0cmluZztcbiAgYXBwcm92YWxJZDogc3RyaW5nO1xuICByZXNvbHZlKGdyYW50ZWQ6IGJvb2xlYW4pOiB2b2lkO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc3RhcnRGYWtlSG9zdChvcHRzOiB7IHRva2VuOiBzdHJpbmc7IHF1aWV0PzogYm9vbGVhbiB9KTogUHJvbWlzZTxGYWtlSG9zdEhhbmRsZT4ge1xuICBjb25zdCB0b2tlbiA9IG9wdHMudG9rZW47XG4gIC8vIFx1NkQ0Qlx1OEJENVx1OTRBOVx1NUI1MDpGQUtFX0hPU1RfRVhQRUNUX1RPS0VOIFx1OEJBOSBob3N0IFx1NjgyMVx1OUE4Q1x1NEUwMFx1NEUyQVx1NEUwRSBITUhfREVTS1RPUF9UT0tFTlxuICAvLyBcdTRFMERcdTU0MENcdTc2ODRcdTUwM0MoXHU2Nzg0XHU5MDIwIEFVVEhfRkFJTEVEIFx1NTczQVx1NjY2RjtzdXBlcnZpc29yIFx1NjAzQlx1NjYyRlx1ODk4Nlx1NzZENiBITUhfREVTS1RPUF9UT0tFTilcbiAgY29uc3QgZXhwZWN0ZWQgPSBwcm9jZXNzLmVudi5GQUtFX0hPU1RfRVhQRUNUX1RPS0VOID8/IHRva2VuO1xuICBjb25zdCB0YXNrRGVsYXkgPSBOdW1iZXIocHJvY2Vzcy5lbnYuRkFLRV9IT1NUX1RBU0tfREVMQVlfTVMgPz8gMzApO1xuICBjb25zdCBmYWlsVGFza3MgPSBwcm9jZXNzLmVudi5GQUtFX0hPU1RfVEFTS19GQUlMID09PSAnMSc7XG5cbiAgY29uc3Qgc3NlQ2xpZW50cyA9IG5ldyBTZXQ8U2VydmVyUmVzcG9uc2U+KCk7XG4gIGNvbnN0IHNlcUJ5UnVuID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgLy8gXHU5MUNEXHU2NTNFXHU3M0FGOlx1NjcwMFx1OEZEMSAyMDAgXHU1RTI3KExhc3QtRXZlbnQtSUQgXHU2NUFEXHU3RUJGXHU4ODY1XHU2MkM5KSxcdTRFMEUgaG1oYXJuZXNzIHdlYiBcdTU0MENcdTZCM0VcdThCRURcdTRFNDlcbiAgY29uc3QgcmluZzogQXJyYXk8eyBpZDogbnVtYmVyOyBldmVudDogc3RyaW5nOyBkYXRhOiB1bmtub3duIH0+ID0gW107XG4gIGxldCByaW5nU2VxID0gMDtcbiAgY29uc3Qgc2Vzc2lvbnMgPSBuZXcgTWFwPHN0cmluZywgRmFrZVNlc3Npb24+KCk7XG4gIGxldCBwZW5kaW5nOiBQZW5kaW5nQXBwcm92YWwgfCBudWxsID0gbnVsbDtcbiAgY29uc3QgcnVuVGltZXJzID0gbmV3IE1hcDxzdHJpbmcsIE5vZGVKUy5UaW1lb3V0PigpO1xuICAvLyBcdTVERTVcdTRGNUNcdTUzM0EvUHJvdmlkZXIgXHU3MkI2XHU2MDAxKFx1NEUwRSBobWhhcm5lc3MgXHU1NDBDXHU1RjYyXHU3Njg0XHU2NzAwXHU1QzBGXHU2QTIxXHU2MkRGKVxuICBjb25zdCBmYWtlV29ya3NwYWNlcyA9IHtcbiAgICBjdXJyZW50OiAnd3MtZGVtbycsXG4gICAgaXRlbXM6IFtcbiAgICAgIHsgaWQ6ICd3cy1kZW1vJywgbmFtZTogJ2RlbW8td29ya3NwYWNlJywgcGF0aDogJ0M6XFxcXGRlbW8nIH0sXG4gICAgXSxcbiAgfTtcbiAgY29uc3QgZmFrZVByb3ZpZGVycyA9IG5ldyBNYXA8c3RyaW5nLCB7IGJhc2VVcmw6IHN0cmluZzsgbW9kZWw6IHN0cmluZzsgYXBpS2V5OiBzdHJpbmcgfT4oW1xuICAgIFsnZGVtbycsIHsgYmFzZVVybDogJ2h0dHA6Ly8xMjcuMC4wLjE6OS92MScsIG1vZGVsOiAnZmFrZS1tJywgYXBpS2V5OiAnc2stZGVtby0xMjM0JyB9XSxcbiAgICBbJ2RlbW8tdmlzaW9uJywgeyBiYXNlVXJsOiAnaHR0cDovLzEyNy4wLjAuMTo5L3YxJywgbW9kZWw6ICdmYWtlLW0tdmlzaW9uJywgYXBpS2V5OiAnc2stZGVtby01Njc4JyB9XSxcbiAgXSk7XG4gIGxldCBmYWtlQ2hhdFByb3ZpZGVyID0gJ2RlbW8nO1xuXG4gIGNvbnN0IGVtaXQgPSAoc2Vzc2lvbklkOiBzdHJpbmcsIHJ1bklkOiBzdHJpbmcsIGtpbmQ6IEV2ZW50S2luZCwgcGF5bG9hZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBudW1iZXIgPT4ge1xuICAgIGNvbnN0IGtleSA9IGAke3Nlc3Npb25JZH1cXDAke3J1bklkfWA7XG4gICAgY29uc3Qgc2VxID0gKHNlcUJ5UnVuLmdldChrZXkpID8/IDApICsgMTtcbiAgICBzZXFCeVJ1bi5zZXQoa2V5LCBzZXEpO1xuICAgIGNvbnN0IGVudjogRXZlbnRFbnZlbG9wZSA9IHtcbiAgICAgIHNjaGVtYVZlcnNpb246IEVWRU5UX1NDSEVNQV9WRVJTSU9OLFxuICAgICAgZXZlbnRJZDogcmFuZG9tVVVJRCgpLFxuICAgICAgc2Vzc2lvbklkLFxuICAgICAgcnVuSWQsXG4gICAgICBzZXEsXG4gICAgICBvY2N1cnJlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICBraW5kLFxuICAgICAgcGF5bG9hZCxcbiAgICB9O1xuICAgIGNvbnN0IGlkID0gKytyaW5nU2VxO1xuICAgIHJpbmcucHVzaCh7IGlkLCBldmVudDogJ2htaCcsIGRhdGE6IGVudiB9KTtcbiAgICBpZiAocmluZy5sZW5ndGggPiAyMDApIHJpbmcuc3BsaWNlKDAsIHJpbmcubGVuZ3RoIC0gMjAwKTtcbiAgICBmb3IgKGNvbnN0IGMgb2Ygc3NlQ2xpZW50cykge1xuICAgICAgYy53cml0ZShgaWQ6ICR7aWR9XFxuZXZlbnQ6IGhtaFxcbmRhdGE6ICR7SlNPTi5zdHJpbmdpZnkoZW52KX1cXG5cXG5gKTtcbiAgICB9XG4gICAgcmV0dXJuIHNlcTtcbiAgfTtcblxuICBjb25zdCB0b3VjaCA9IChzZXNzaW9uSWQ6IHN0cmluZyk6IEZha2VTZXNzaW9uID0+IHtcbiAgICBsZXQgcyA9IHNlc3Npb25zLmdldChzZXNzaW9uSWQpO1xuICAgIGlmIChzID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHMgPSB7IGlkOiBzZXNzaW9uSWQsIGNyZWF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLCB1cGRhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSB9O1xuICAgICAgc2Vzc2lvbnMuc2V0KHNlc3Npb25JZCwgcyk7XG4gICAgfVxuICAgIHMudXBkYXRlZEF0ID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuICAgIHJldHVybiBzO1xuICB9O1xuXG4gIC8qKiBcdTZBMjFcdTYyREZcdTRFMDBcdTZCMjFcdTRFRkJcdTUyQTE6XHU2Mjc5XHU1MUM2XHU2QTIxXHU1RjBGXHU2MzAyXHU4RDc3XHU3QjQ5XHU1Rjg1IC9hcGkvYXBwcm92ZVx1MzAwMiAqL1xuICBjb25zdCBydW5UYXNrID0gKHNlc3Npb25JZDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcsIG1vZGU6IHN0cmluZyk6IHN0cmluZyA9PiB7XG4gICAgY29uc3QgcnVuSWQgPSBgcnVuLSR7RGF0ZS5ub3coKS50b1N0cmluZygzNil9LSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMiwgOCl9YDtcbiAgICB0b3VjaChzZXNzaW9uSWQpO1xuICAgIGNvbnN0IHN0ZXBzOiBBcnJheTwoKSA9PiB2b2lkPiA9IFtdO1xuICAgIGNvbnN0IHdhaXQgPSAoZm46ICgpID0+IHZvaWQsIG1zID0gdGFza0RlbGF5KTogdm9pZCA9PiB7XG4gICAgICBjb25zdCB0ID0gc2V0VGltZW91dChmbiwgbXMpO1xuICAgICAgcnVuVGltZXJzLnNldChgJHtzZXNzaW9uSWR9XFwwJHtydW5JZH1gLCB0KTtcbiAgICB9O1xuICAgIGNvbnN0IGNoYWluID0gKGZuczogQXJyYXk8KCkgPT4gdm9pZD4pOiB2b2lkID0+IHtcbiAgICAgIGNvbnN0IFtmaXJzdCwgLi4ucmVzdF0gPSBmbnM7XG4gICAgICBpZiAoZmlyc3QgPT09IHVuZGVmaW5lZCkgcmV0dXJuO1xuICAgICAgd2FpdCgoKSA9PiB7XG4gICAgICAgIGZpcnN0KCk7XG4gICAgICAgIGNoYWluKHJlc3QpO1xuICAgICAgfSk7XG4gICAgfTtcblxuICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ3J1bi5zdGFydGVkJywgeyB0YXNrOiB0ZXh0LCBtb2RlIH0pO1xuICAgIGlmIChmYWlsVGFza3MpIHtcbiAgICAgIHdhaXQoKCkgPT4gZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAncnVuLmZhaWxlZCcsIHtcbiAgICAgICAgZXJyb3I6IHsgY29kZTogJ0FVVEhfRkFJTEVEJywgbWVzc2FnZTogJ3NpbXVsYXRlZCBwcm92aWRlciBhdXRoIGZhaWx1cmUnLCByZXRyeWFibGU6IGZhbHNlIH0sXG4gICAgICB9KSk7XG4gICAgICByZXR1cm4gcnVuSWQ7XG4gICAgfVxuXG4gICAgY29uc3QgZmluaXNoUnVuID0gKGFuc3dlcjogc3RyaW5nLCB0b29sVXNlczogbnVtYmVyKTogdm9pZCA9PiB7XG4gICAgICBydW5UaW1lcnMuZGVsZXRlKGAke3Nlc3Npb25JZH1cXDAke3J1bklkfWApO1xuICAgICAgLy8gXHU0RUE0XHU0RUQ4XHU3MjY5XHU1MTQ4XHU0RThFXHU3RUM4XHU2MDAxKFx1NEUwRSBobWhhcm5lc3MgZGVza3RvcCBcdTY4NjVcdTU0MENcdTVFOEY6YXJ0aWZhY3QuY3JlYXRlZCBcdTIxOTIgcnVuLmNvbXBsZXRlZClcbiAgICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ2FydGlmYWN0LmNyZWF0ZWQnLCB7XG4gICAgICAgIGFydGlmYWN0OiB7IHJlbFBhdGg6ICdvdXQudHh0Jywga2luZDogJ2ZpbGUnLCB0aXRsZTogJ291dC50eHQnIH0sXG4gICAgICB9KTtcbiAgICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ3J1bi5jb21wbGV0ZWQnLCB7IHRleHQ6IGFuc3dlciwgdHVybnM6IDEsIHRvb2xVc2VzIH0pO1xuICAgIH07XG5cbiAgICBjb25zdCBzY3JpcHRlZDogQXJyYXk8KCkgPT4gdm9pZD4gPSBbXG4gICAgICAoKSA9PiBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICd0b29sLnN0YXJ0ZWQnLCB7IG5hbWU6ICdyZWFkX2ZpbGUnLCBhcmdzUHJldmlldzogJ3tcInBhdGhcIjpcIlJFQURNRS5tZFwifScgfSksXG4gICAgICAoKSA9PiBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICd0b29sLmNvbXBsZXRlZCcsIHsgbmFtZTogJ3JlYWRfZmlsZScsIGlzRXJyb3I6IGZhbHNlLCBvdXRwdXRQcmV2aWV3OiAnIyBkZW1vJyB9KSxcbiAgICBdO1xuXG4gICAgaWYgKG1vZGUgPT09ICdhc2snKSB7XG4gICAgICBzY3JpcHRlZC5wdXNoKCgpID0+IHtcbiAgICAgICAgY29uc3QgYXBwcm92YWxJZCA9IGBhcC0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDgpfWA7XG4gICAgICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ2FwcHJvdmFsLnJlcXVpcmVkJywge1xuICAgICAgICAgIGFwcHJvdmFsSWQsXG4gICAgICAgICAgdG9vbDogJ3dyaXRlX2ZpbGUnLFxuICAgICAgICAgIGFyZ3NQcmV2aWV3OiAne1wicGF0aFwiOlwib3V0LnR4dFwiLFwiY29udGVudFwiOlwiaGlcIn0nLFxuICAgICAgICAgIHJpc2s6ICdcdTUxOTlcdTUxNjVcdTVERTVcdTRGNUNcdTUzM0FcdTY1ODdcdTRFRjYgb3V0LnR4dChcdTZBMjFcdTYyREYpJyxcbiAgICAgICAgfSk7XG4gICAgICAgIHBlbmRpbmcgPSB7XG4gICAgICAgICAgc2Vzc2lvbklkLFxuICAgICAgICAgIGFwcHJvdmFsSWQsXG4gICAgICAgICAgcmVzb2x2ZTogKGdyYW50ZWQpID0+IHtcbiAgICAgICAgICAgIHBlbmRpbmcgPSBudWxsO1xuICAgICAgICAgICAgaWYgKGdyYW50ZWQpIHtcbiAgICAgICAgICAgICAgZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAndG9vbC5zdGFydGVkJywgeyBuYW1lOiAnd3JpdGVfZmlsZScsIGFyZ3NQcmV2aWV3OiAne1wicGF0aFwiOlwib3V0LnR4dFwifScgfSk7XG4gICAgICAgICAgICAgIHdhaXQoKCkgPT4gZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAndG9vbC5jb21wbGV0ZWQnLCB7IG5hbWU6ICd3cml0ZV9maWxlJywgaXNFcnJvcjogZmFsc2UsIG91dHB1dFByZXZpZXc6ICd3cm90ZSAyIGJ5dGVzJyB9KSk7XG4gICAgICAgICAgICAgIHdhaXQoKCkgPT4gZmluaXNoUnVuKGBlY2hvOiAke3RleHR9KFx1NURGMlx1NjI2N1x1ODg0Q1x1NTE5OVx1NTE2NSlgLCAzKSwgdGFza0RlbGF5ICogMik7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICBmaW5pc2hSdW4oYGVjaG86ICR7dGV4dH0oXHU1QkExXHU2Mjc5XHU4OEFCXHU2MkQyXHU3RURELFx1NjcyQVx1NjI2N1x1ODg0Q1x1NTE5OVx1NTE2NSlgLCAxKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9LFxuICAgICAgICB9O1xuICAgICAgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHNjcmlwdGVkLnB1c2goKCkgPT4gZmluaXNoUnVuKGBlY2hvOiAke3RleHR9YCwgMSkpO1xuICAgIH1cbiAgICBjaGFpbihzY3JpcHRlZCk7XG4gICAgcmV0dXJuIHJ1bklkO1xuICB9O1xuXG4gIGNvbnN0IHNlcnZlciA9IGNyZWF0ZVNlcnZlcigocmVxLCByZXMpID0+IHtcbiAgICBjb25zdCB1cmwgPSBuZXcgVVJMKHJlcS51cmwgPz8gJy8nLCAnaHR0cDovLzEyNy4wLjAuMScpO1xuICAgIGNvbnN0IGF1dGhvcml6ZWQgPSByZXEuaGVhZGVyc1sneC1obWgta2V5J10gPT09IGV4cGVjdGVkO1xuICAgIGNvbnN0IGRlbnkgPSAoKTogdm9pZCA9PiB7XG4gICAgICByZXMud3JpdGVIZWFkKDQwMSwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgJ21pc3Npbmcgb3IgaW52YWxpZCB4LWhtaC1rZXknLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICB9O1xuXG4gICAgY29uc3QgcmVhZEJvZHkgPSAoKTogUHJvbWlzZTxzdHJpbmc+ID0+XG4gICAgICBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xuICAgICAgICBsZXQgYiA9ICcnO1xuICAgICAgICByZXEub24oJ2RhdGEnLCAoYzogQnVmZmVyKSA9PiB7IGIgKz0gYy50b1N0cmluZygpOyB9KTtcbiAgICAgICAgcmVxLm9uKCdlbmQnLCAoKSA9PiByZXNvbHZlKGIpKTtcbiAgICAgIH0pO1xuXG4gICAgaWYgKHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZXZlbnRzJykge1xuICAgICAgaWYgKCFhdXRob3JpemVkKSB7IGRlbnkoKTsgcmV0dXJuOyB9XG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ3RleHQvZXZlbnQtc3RyZWFtJywgJ2NhY2hlLWNvbnRyb2wnOiAnbm8tY2FjaGUnLCBjb25uZWN0aW9uOiAna2VlcC1hbGl2ZScgfSk7XG4gICAgICByZXMuZmx1c2hIZWFkZXJzPy4oKTtcbiAgICAgIHNzZUNsaWVudHMuYWRkKHJlcyk7XG4gICAgICAvLyBcdTY1QURcdTdFQkZcdTg4NjVcdTYyQzk6TGFzdC1FdmVudC1JRCBcdTRFNEJcdTUyNERcdTc2ODRcdTVFMjdcdTVERjJcdTU3MjhcdTVCQTJcdTYyMzdcdTdBRUYsXHU5MUNEXHU1M0QxXHU1MTc2XHU1NDBFXHU3Njg0XHU3M0FGXHU1RjYyXHU3RjEzXHU1MUIyXG4gICAgICBjb25zdCBsYXN0SWQgPSBOdW1iZXIocmVxLmhlYWRlcnNbJ2xhc3QtZXZlbnQtaWQnXSA/PyAwKTtcbiAgICAgIGlmIChOdW1iZXIuaXNGaW5pdGUobGFzdElkKSAmJiBsYXN0SWQgPiAwKSB7XG4gICAgICAgIGZvciAoY29uc3QgZSBvZiByaW5nKSB7XG4gICAgICAgICAgaWYgKGUuaWQgPiBsYXN0SWQpIHJlcy53cml0ZShgaWQ6ICR7ZS5pZH1cXG5ldmVudDogJHtlLmV2ZW50fVxcbmRhdGE6ICR7SlNPTi5zdHJpbmdpZnkoZS5kYXRhKX1cXG5cXG5gKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmVxLm9uKCdjbG9zZScsICgpID0+IHNzZUNsaWVudHMuZGVsZXRlKHJlcykpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAoIWF1dGhvcml6ZWQpIHsgZGVueSgpOyByZXR1cm47IH1cblxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3N0YXRlJykge1xuICAgICAgLy8gcHJvdmlkZXJzRGV0YWlsOlx1NEUwRSBobWhhcm5lc3MgXHU1NDBDXHU1RjYyXHUyMDE0XHUyMDE0a2V5IFx1NTNFQVx1NTFGQSBoYXNLZXkvXHU2NzJCXHU1NkRCXHU0RjRELFx1NkMzOFx1NEUwRFx1NjYwRVx1NjU4N1xuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBkYWVtb25WZXJzaW9uOiAnZmFrZS0wLjAuMCcsIGRlc2t0b3A6IHRydWUsIG1vZGVsOiBmYWtlUHJvdmlkZXJzLmdldChmYWtlQ2hhdFByb3ZpZGVyKT8ubW9kZWwgPz8gJ2Zha2UtbW9kZWwnLFxuICAgICAgICBjaGF0UHJvdmlkZXI6IGZha2VDaGF0UHJvdmlkZXIsIGxvY2FsZTogJ3poJyxcbiAgICAgICAgYnVzeVNlc3Npb25zOiBbLi4uc2Vzc2lvbnMua2V5cygpXS5zbGljZSgwLCAyKSxcbiAgICAgICAgYXBwcm92YWxQZW5kaW5nOiBwZW5kaW5nICE9PSBudWxsLFxuICAgICAgICBzZXR0aW5nczogeyBhcHByb3ZhbDogJ2FzaycgfSxcbiAgICAgICAgd29ya3NwYWNlOiBmYWtlV29ya3NwYWNlcy5pdGVtcy5maW5kKCh3KSA9PiB3LmlkID09PSBmYWtlV29ya3NwYWNlcy5jdXJyZW50KSA/PyBudWxsLFxuICAgICAgICBwcm92aWRlcnNEZXRhaWw6IFsuLi5mYWtlUHJvdmlkZXJzLmVudHJpZXMoKV0ubWFwKChbbmFtZSwgcF0pID0+ICh7XG4gICAgICAgICAgbmFtZSwgbW9kZWw6IHAubW9kZWwsIGJhc2VVcmw6IHAuYmFzZVVybCxcbiAgICAgICAgICBoYXNLZXk6IHAuYXBpS2V5ICE9PSAnJyxcbiAgICAgICAgICBrZXlUYWlsOiBwLmFwaUtleS5sZW5ndGggPj0gNCA/IHAuYXBpS2V5LnNsaWNlKC00KSA6IHVuZGVmaW5lZCxcbiAgICAgICAgICBwdXJwb3NlczogWydjaGF0J10sXG4gICAgICAgIH0pKSxcbiAgICAgIH0pKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2Rlc2t0b3Avc2h1dGRvd24nKSB7XG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlIH0pKTtcbiAgICAgIHNlcnZlci5jbG9zZSgoKSA9PiBwcm9jZXNzLmV4aXQoMCkpO1xuICAgICAgc2V0VGltZW91dCgoKSA9PiBwcm9jZXNzLmV4aXQoMCksIDFfMDAwKS51bnJlZigpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZmFrZS9kaWUnKSB7XG4gICAgICAvLyBcdTZENEJcdThCRDVcdTk0QTlcdTVCNTA6XHU2QTIxXHU2MkRGIGhvc3QgXHU1RDI5XHU2RTgzKFx1NTE0OFx1NUU5NFx1N0I1NFx1NTE4RFx1OTAwMFx1NTFGQSxcdTRGRERcdThCQzFcdTU0Q0RcdTVFOTRcdTVERjJcdTUzRDFcdTUxRkEpXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlIH0pKTtcbiAgICAgIHNldFRpbWVvdXQoKCkgPT4gcHJvY2Vzcy5leGl0KDEpLCA1MCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9tb2RlbCcpIHtcbiAgICAgIC8vIFx1NkEyMVx1NTc4Qlx1NTIwN1x1NjM2MihcdTRFMEUgaG1oYXJuZXNzIC9hcGkvbW9kZWwgXHU1NDBDXHU1RjYyOlx1NTIwNyBjaGF0IFx1OERFRlx1NzUzMSlcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoKGF3YWl0IHJlYWRCb2R5KCkpIHx8ICd7fScpIGFzIHsgbmFtZT86IHVua25vd24gfTtcbiAgICAgICAgY29uc3QgbmFtZSA9IHR5cGVvZiBib2R5Lm5hbWUgPT09ICdzdHJpbmcnID8gYm9keS5uYW1lLnRyaW0oKSA6ICcnO1xuICAgICAgICBpZiAoIWZha2VQcm92aWRlcnMuaGFzKG5hbWUpKSB7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3Byb3ZpZGVyIG5vdCBmb3VuZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBmYWtlQ2hhdFByb3ZpZGVyID0gbmFtZTtcbiAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlLCBtb2RlbDogZmFrZVByb3ZpZGVycy5nZXQobmFtZSk/Lm1vZGVsIH0pKTtcbiAgICAgIH0pKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS90YXNrJykge1xuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7IHRleHQ/OiB1bmtub3duOyBzZXNzaW9uSWQ/OiB1bmtub3duOyBtb2RlPzogdW5rbm93bjsgYXR0YWNobWVudHM/OiB1bmtub3duOyBpbWFnZXM/OiB1bmtub3duIH07XG4gICAgICAgICAgY29uc3QgdGV4dCA9IHR5cGVvZiBib2R5LnRleHQgPT09ICdzdHJpbmcnID8gYm9keS50ZXh0IDogJyc7XG4gICAgICAgICAgY29uc3Qgc2Vzc2lvbklkID0gdHlwZW9mIGJvZHkuc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IGJvZHkuc2Vzc2lvbklkIDogYHdlYi0ke0RhdGUubm93KCkudG9TdHJpbmcoMzYpfWA7XG4gICAgICAgICAgY29uc3QgbW9kZSA9IGJvZHkubW9kZSA9PT0gJ2FzaycgfHwgYm9keS5tb2RlID09PSAnYXV0bycgfHwgYm9keS5tb2RlID09PSAneW9sbycgPyBib2R5Lm1vZGUgOiAnYXNrJztcbiAgICAgICAgICBjb25zdCBhdHRhY2htZW50cyA9IEFycmF5LmlzQXJyYXkoYm9keS5hdHRhY2htZW50cykgPyBib2R5LmF0dGFjaG1lbnRzLmZpbHRlcigoYSk6IGEgaXMgc3RyaW5nID0+IHR5cGVvZiBhID09PSAnc3RyaW5nJykgOiBbXTtcbiAgICAgICAgICAvLyBcdTU2RkVcdTcyNDdcdTk2NDRcdTRFRjY6XHU0RTBFIGhtaGFybmVzcyB2aXNpb24gXHU1MzRGXHU4QkFFXHU1NDBDXHU1RjYyKHtuYW1lLGRhdGFVcmx9KTtmYWtlIFx1NjgyMVx1OUE4Q1x1NUY2Mlx1NzJCNlx1NTM3M1x1NjUzNlxuICAgICAgICAgIGNvbnN0IGltYWdlcyA9IEFycmF5LmlzQXJyYXkoYm9keS5pbWFnZXMpXG4gICAgICAgICAgICA/IGJvZHkuaW1hZ2VzLmZpbHRlcigoaW0pOiBpbSBpcyB7IG5hbWU6IHN0cmluZzsgZGF0YVVybDogc3RyaW5nIH0gPT4ge1xuICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgaW0gIT09ICdvYmplY3QnIHx8IGltID09PSBudWxsKSByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICAgICAgY29uc3QgbyA9IGltIGFzIHsgbmFtZT86IHVua25vd247IGRhdGFVcmw/OiB1bmtub3duIH07XG4gICAgICAgICAgICAgICAgcmV0dXJuIHR5cGVvZiBvLm5hbWUgPT09ICdzdHJpbmcnICYmIHR5cGVvZiBvLmRhdGFVcmwgPT09ICdzdHJpbmcnICYmIG8uZGF0YVVybC5zdGFydHNXaXRoKCdkYXRhOmltYWdlLycpO1xuICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgOiBbXTtcbiAgICAgICAgICBpZiAoIXRleHQpIHtcbiAgICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3RleHQgcmVxdWlyZWQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8gXHU0RTBFIGhtaGFybmVzcyBcdTU0MENcdThCRURcdTRFNDk6XHU1NDA4XHU2Q0Q1XHU5NjQ0XHU0RUY2XHU0RUU1IFtyZWZlcmVuY2VkIGZpbGVzXSBcdTUyNERcdTdGMDBcdTVFNzZcdTUxNjVcdTRFRkJcdTUyQTFcdTY1ODdcdTY3MkM7XG4gICAgICAgICAgLy8gXHU1NkZFXHU3MjQ3XHU0RUU1IFtpbWFnZXNdIFx1NTI0RFx1N0YwMFx1NjgwN1x1NkNFOFx1NUYyMFx1NjU3MCh2aXNpb24gXHU2M0NGXHU4RkYwXHU5NEZFXHU1NzI4XHU3NzFGXHU1QjlFIHJ1bnRpbWUgXHU5MUNDXHU1M0QxXHU3NTFGKVxuICAgICAgICAgIGNvbnN0IGNvbXBvc2VkID0gYXR0YWNobWVudHMubGVuZ3RoID4gMFxuICAgICAgICAgICAgPyBgW3JlZmVyZW5jZWQgZmlsZXNdXFxuJHthdHRhY2htZW50cy5tYXAoKGEpID0+IGAtICR7YS5zcGxpdCgvW1xcXFwvXS8pLnBvcCgpfWApLmpvaW4oJ1xcbicpfVxcblxcbiR7dGV4dH1gXG4gICAgICAgICAgICA6IHRleHQ7XG4gICAgICAgICAgY29uc3Qgd2l0aEltYWdlcyA9IGltYWdlcy5sZW5ndGggPiAwID8gYFtpbWFnZXM6ICR7aW1hZ2VzLmxlbmd0aH1dXFxuJHtjb21wb3NlZH1gIDogY29tcG9zZWQ7XG4gICAgICAgICAgY29uc3QgcnVuSWQgPSBydW5UYXNrKHNlc3Npb25JZCwgd2l0aEltYWdlcywgbW9kZSk7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIHJ1bklkLCBpbWFnZXM6IGltYWdlcy5sZW5ndGggfSkpO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCBTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgfVxuICAgICAgfSkoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2FwcHJvdmUnKSB7XG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7IGdyYW50ZWQ/OiB1bmtub3duOyBzZXNzaW9uSWQ/OiB1bmtub3duIH07XG4gICAgICAgIGNvbnN0IHNpZCA9IHR5cGVvZiBib2R5LnNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBib2R5LnNlc3Npb25JZCA6ICcnO1xuICAgICAgICBpZiAocGVuZGluZyA9PT0gbnVsbCB8fCAoc2lkICE9PSAnJyAmJiBwZW5kaW5nLnNlc3Npb25JZCAhPT0gc2lkKSkge1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICdubyBhcHByb3ZhbCBwZW5kaW5nJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHAgPSBwZW5kaW5nO1xuICAgICAgICBwZW5kaW5nID0gbnVsbDtcbiAgICAgICAgcC5yZXNvbHZlKGJvZHkuZ3JhbnRlZCA9PT0gdHJ1ZSk7XG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgZ3JhbnRlZDogYm9keS5ncmFudGVkID09PSB0cnVlIH0pKTtcbiAgICAgIH0pKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lLnN0YXJ0c1dpdGgoJy9hcGkvc2Vzc2lvbnMvJykgJiYgKHVybC5wYXRobmFtZS5lbmRzV2l0aCgnL2FyY2hpdmUnKSB8fCB1cmwucGF0aG5hbWUuZW5kc1dpdGgoJy9kZWxldGUnKSkpIHtcbiAgICAgIC8vIFx1NEYxQVx1OEJERFx1NUY1Mlx1Njg2My9cdTUyMjBcdTk2NjQoaG1oYXJuZXNzIFx1NTQwQ1x1NUY2MjpcdTc5RkJcdTUxNjUgYXJjaGl2ZS90cmFzaCxcdTUzRUZcdTYwNjJcdTU5MEQsXHU0RTBEXHU3ODZDXHU1MjIwKVxuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCBwYXJ0cyA9IHVybC5wYXRobmFtZS5zbGljZSgnL2FwaS9zZXNzaW9ucy8nLmxlbmd0aCkuc3BsaXQoJy8nKTtcbiAgICAgICAgY29uc3Qgb3AgPSBwYXJ0c1sxXSA/PyAnJztcbiAgICAgICAgY29uc3Qgb2lkID0gZGVjb2RlVVJJQ29tcG9uZW50KHBhcnRzWzBdID8/ICcnKS5yZXBsYWNlKC9bXmEtekEtWjAtOV86LkAtXS9nLCAnJyk7XG4gICAgICAgIGlmIChvaWQgPT09ICcnIHx8IChvcCAhPT0gJ2FyY2hpdmUnICYmIG9wICE9PSAnZGVsZXRlJykpIHtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnYmFkIG9wJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGlmICghc2Vzc2lvbnMuaGFzKG9pZCkpIHtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnc2Vzc2lvbiBub3QgZm91bmQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgc2Vzc2lvbnMuZGVsZXRlKG9pZCk7XG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSB9KSk7XG4gICAgICB9KSgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvaW5qZWN0Jykge1xuICAgICAgLy8gXHU4RkQwXHU4ODRDXHU0RTJEXHU2Q0U4XHU1MTY1KFx1NEUwRSBobWhhcm5lc3MgL2FwaS9pbmplY3QgXHU1NDBDXHU1RjYyO2Zha2UgXHU1M0VBXHU1NkRFXHU2MjY3KVxuICAgICAgdm9pZCByZWFkQm9keSgpO1xuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9pbnRlcnJ1cHQnKSB7XG4gICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgnJykgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47IC8vIGludGVycnVwdCBcdTY1RTAgYm9keSBcdThCRURcdTRFNDlcbiAgICAgIHZvaWQgYm9keTtcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUgfSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9zZXNzaW9ucycpIHtcbiAgICAgIGNvbnN0IGxpc3QgPSBbLi4uc2Vzc2lvbnMudmFsdWVzKCldLm1hcCgocykgPT4gKHtcbiAgICAgICAgaWQ6IHMuaWQsIHRpdGxlOiAnJywgdGFzazogJycsIG91dGNvbWU6ICdvaycsIHR1cm5zOiAxLCB0b29sVXNlczogMSxcbiAgICAgICAgdGltZTogcy51cGRhdGVkQXQsIGN3ZDogJ0M6XFxcXGRlbW8nLCBicmFuY2g6ICcnLCBjcmVhdGVkQXQ6IHMuY3JlYXRlZEF0LCB1cGRhdGVkQXQ6IHMudXBkYXRlZEF0LFxuICAgICAgfSkpO1xuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBzZXNzaW9uczogbGlzdCwgbmV4dEN1cnNvcjogbnVsbCB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUuc3RhcnRzV2l0aCgnL2FwaS9zZXNzaW9ucy8nKSkge1xuICAgICAgY29uc3Qgc2VnID0gZGVjb2RlVVJJQ29tcG9uZW50KHVybC5wYXRobmFtZS5zbGljZSgnL2FwaS9zZXNzaW9ucy8nLmxlbmd0aCkpO1xuICAgICAgLy8gXHU1QkZDXHU1MUZBKFx1NEUwRSBobWhhcm5lc3MgL2FwaS9zZXNzaW9ucy86aWQvZXhwb3J0Lm1kIFx1NTQwQ1x1NUY2Mjp0ZXh0L21hcmtkb3duIFx1NEUwQlx1OEY3RClcbiAgICAgIGNvbnN0IGV4cG9ydE1hdGNoID0gL14oLiopXFwvZXhwb3J0XFwubWQkLy5leGVjKHNlZykgPz8gL14oLiopXFwuZXhwb3J0XFwubWQkLy5leGVjKHNlZyk7XG4gICAgICBpZiAoZXhwb3J0TWF0Y2ggIT09IG51bGwgJiYgZXhwb3J0TWF0Y2hbMV0gIT09IHVuZGVmaW5lZCAmJiBleHBvcnRNYXRjaFsxXSAhPT0gJycpIHtcbiAgICAgICAgY29uc3QgZWlkID0gZXhwb3J0TWF0Y2hbMV0ucmVwbGFjZSgvW15hLXpBLVowLTlfOi5ALV0vZywgJycpO1xuICAgICAgICBjb25zdCBlcyA9IHNlc3Npb25zLmdldChlaWQpO1xuICAgICAgICBpZiAoZXMgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICdzZXNzaW9uIG5vdCBmb3VuZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ3RleHQvbWFya2Rvd247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICByZXMuZW5kKGAjIGhtaGFybmVzcyBcdTRGMUFcdThCRERcdTVCRkNcdTUxRkEoZmFrZSlcXG5cXG4tIFx1NEYxQVx1OEJERDoke2VpZH1cXG5cXG4jIyBcdTc1MjhcdTYyMzdcXG5cXG5cdTRFNEJcdTUyNERcdTc2ODRcdTRFRkJcdTUyQTEoZmFrZSBcdTk4ODRcdTg5QzgpXFxuXFxuIyMgXHU1MkE5XHU2MjRCXFxuXFxuXHU4RkQ5XHU2NjJGXHU1QkZDXHU1MUZBXHU3Njg0XHU1NkRFXHU1OTBEXHU5ODg0XHU4OUM4KGZha2UpXHUzMDAyXFxuYCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIC8vIFx1NEYxQVx1OEJERFx1OTg4NFx1ODlDOChcdTRFMEUgaG1oYXJuZXNzIEdFVCAvYXBpL3Nlc3Npb25zLzppZCBcdTU0MENcdTVGNjI6XHU2NzAwXHU1NDBFIDgwIFx1Njc2MSxcdTZCQ0ZcdTY3NjEgNTAwIFx1NUI1NylcbiAgICAgIGNvbnN0IGlkID0gc2VnLnJlcGxhY2UoL1teYS16QS1aMC05XzouQC1dL2csICcnKTtcbiAgICAgIGNvbnN0IHMgPSBzZXNzaW9ucy5nZXQoaWQpO1xuICAgICAgaWYgKHMgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3Nlc3Npb24gbm90IGZvdW5kJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgaWQsIG1vZGVsOiAnZmFrZS1tb2RlbCcsIGN3ZDogJ0M6XFxcXGRlbW8nLFxuICAgICAgICBtZXNzYWdlczogW1xuICAgICAgICAgIHsgcm9sZTogJ3VzZXInLCB0ZXh0OiAnXHU0RTRCXHU1MjREXHU3Njg0XHU0RUZCXHU1MkExKGZha2UgXHU5ODg0XHU4OUM4KScsIHRvb2xzOiBbXSB9LFxuICAgICAgICAgIHsgcm9sZTogJ2Fzc2lzdGFudCcsIHRleHQ6ICdcdThGRDlcdTY2MkZcdTUzODZcdTUzRjJcdTRGMUFcdThCRERcdTc2ODRcdTU2REVcdTU5MERcdTk4ODRcdTg5QzgoZmFrZSlcdTMwMDInLCB0b29sczogWydyZWFkX2ZpbGUnXSB9LFxuICAgICAgICBdLFxuICAgICAgfSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9mcycpIHtcbiAgICAgIC8vIFx1NzZFRVx1NUY1NVx1NkQ0Rlx1ODlDOChcdTRFMEUgaG1oYXJuZXNzIFx1NTQwQ1x1NUY2MjpwYXRoIFx1NzcwMVx1NzU2NT1cdTY4Mzk7ZmlsZXM9MSBcdTk2NDRcdTVFMjZcdTY1ODdcdTRFRjZcdTUyMTdcdTg4NjgpXG4gICAgICBjb25zdCBxID0gdXJsLnNlYXJjaFBhcmFtcy5nZXQoJ3BhdGgnKSA/PyAnJztcbiAgICAgIGNvbnN0IHdpdGhGaWxlcyA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KCdmaWxlcycpID09PSAnMSc7XG4gICAgICBpZiAocSA9PT0gJycpIHtcbiAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgcGF0aDogJycsIHNlZ21lbnRzOiBbXSwgcGFyZW50OiAnJyxcbiAgICAgICAgICBkaXJzOiBbeyBuYW1lOiAnZGVtby13b3Jrc3BhY2UnLCBwYXRoOiAnQzpcXFxcZGVtbycgfV0sXG4gICAgICAgICAgLi4uKHdpdGhGaWxlcyA/IHsgZmlsZXM6IFtdIH0gOiB7fSksXG4gICAgICAgIH0pKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBwYXRoOiBxLCBzZWdtZW50czogW3sgbmFtZTogcS5zcGxpdCgvW1xcXFwvXS8pLmZpbHRlcihCb29sZWFuKS5wb3AoKSA/PyBxLCBwYXRoOiBxIH1dLCBwYXJlbnQ6ICcnLFxuICAgICAgICBkaXJzOiBbeyBuYW1lOiAnc3JjJywgcGF0aDogYCR7cS5yZXBsYWNlKC9bXFxcXC9dJC8sICcnKX1cXFxcc3JjYCB9XSxcbiAgICAgICAgLi4uKHdpdGhGaWxlcyA/IHsgZmlsZXM6IFtcbiAgICAgICAgICB7IG5hbWU6ICdSRUFETUUubWQnLCBwYXRoOiBgJHtxLnJlcGxhY2UoL1tcXFxcL10kLywgJycpfVxcXFxSRUFETUUubWRgLCByZWw6ICdSRUFETUUubWQnIH0sXG4gICAgICAgICAgeyBuYW1lOiAncGFja2FnZS5qc29uJywgcGF0aDogYCR7cS5yZXBsYWNlKC9bXFxcXC9dJC8sICcnKX1cXFxccGFja2FnZS5qc29uYCwgcmVsOiAncGFja2FnZS5qc29uJyB9LFxuICAgICAgICBdIH0gOiB7fSksXG4gICAgICB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2ZzL3JlYWQnKSB7XG4gICAgICAvLyBcdTY1ODdcdTRFRjZcdTk4ODRcdTg5QzgoNjRLQiBcdTRFMEFcdTk2NTBcdThCRURcdTRFNDk7ZmFrZSBcdThGRDRcdTU2REVcdTU2RkFcdTVCOUFcdTY1ODdcdTY3MkMpXG4gICAgICBjb25zdCBwID0gdXJsLnNlYXJjaFBhcmFtcy5nZXQoJ3BhdGgnKSA/PyAnJztcbiAgICAgIGlmIChwID09PSAnJykge1xuICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3BhdGggcmVxdWlyZWQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBwYXRoOiBwLCByZWw6IHAuc3BsaXQoL1tcXFxcL10vKS5wb3AoKSA/PyBwLCBzaXplOiA0MixcbiAgICAgICAgdGV4dDogJyMgZGVtbyB3b3Jrc3BhY2VcXG5cXG5cdThGRDlcdTY2MkYgZmFrZSBob3N0IFx1NzY4NFx1NjU4N1x1NEVGNlx1OTg4NFx1ODlDOFx1NTE4NVx1NUJCOVx1MzAwMlxcbicsXG4gICAgICB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2RpZmYnKSB7XG4gICAgICAvLyBEaWZmIFx1OTc2Mlx1Njc3RihcdTRFMEUgaG1oYXJuZXNzIC9hcGkvZGlmZiBcdTU0MENcdTVGNjI7ZmFrZSBcdThGRDRcdTU2REVcdTU2RkFcdTVCOUFcdTVDMEZcdTUzRDhcdTY2RjRcdTk2QzYpXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIGdpdDogdHJ1ZSwgY3dkOiAnQzpcXFxcZGVtbycsXG4gICAgICAgIGNoYW5nZWQ6IFtcbiAgICAgICAgICB7IHN0YXRlOiAnTScsIHBhdGg6ICdzcmMvYXBwLnRzJyB9LFxuICAgICAgICAgIHsgc3RhdGU6ICdBJywgcGF0aDogJ2RvY3Mvbm90ZXMubWQnIH0sXG4gICAgICAgIF0sXG4gICAgICAgIHN0YXQ6ICcgc3JjL2FwcC50cyAgICAgIHwgMTIgKysrKysrKy0tLVxcbiBkb2NzL25vdGVzLm1kICAgfCAgNCArKysrXFxuIDIgZmlsZXMgY2hhbmdlZCwgMTYgaW5zZXJ0aW9ucygrKSwgMyBkZWxldGlvbnMoLSknLFxuICAgICAgfSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS93b3Jrc3BhY2VzJykge1xuICAgICAgLy8gXHU1REU1XHU0RjVDXHU1MzNBKFx1NEUwRSBobWhhcm5lc3MgXHU1NDBDXHU1RjYyOmN1cnJlbnQgKyBpdGVtcylcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgY3VycmVudDogZmFrZVdvcmtzcGFjZXMuY3VycmVudCxcbiAgICAgICAgaXRlbXM6IGZha2VXb3Jrc3BhY2VzLml0ZW1zLFxuICAgICAgfSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvd29ya3NwYWNlcycpIHtcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoKGF3YWl0IHJlYWRCb2R5KCkpIHx8ICd7fScpIGFzIHsgbmFtZT86IHVua25vd247IHBhdGg/OiB1bmtub3duIH07XG4gICAgICAgIGNvbnN0IHBhdGggPSB0eXBlb2YgYm9keS5wYXRoID09PSAnc3RyaW5nJyA/IGJvZHkucGF0aCA6ICcnO1xuICAgICAgICBjb25zdCBuYW1lID0gdHlwZW9mIGJvZHkubmFtZSA9PT0gJ3N0cmluZycgJiYgYm9keS5uYW1lICE9PSAnJyA/IGJvZHkubmFtZSA6IChwYXRoLnNwbGl0KC9bXFxcXC9dLykuZmlsdGVyKEJvb2xlYW4pLnBvcCgpID8/ICcnKTtcbiAgICAgICAgaWYgKHBhdGggPT09ICcnIHx8IG5hbWUgPT09ICcnKSB7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ2Fic29sdXRlIHBhdGggYW5kIG5hbWUgcmVxdWlyZWQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGZha2VXb3Jrc3BhY2VzLml0ZW1zLnNvbWUoKHcpID0+IHcucGF0aC50b0xvd2VyQ2FzZSgpID09PSBwYXRoLnRvTG93ZXJDYXNlKCkpKSB7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDksIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3dvcmtzcGFjZSBhbHJlYWR5IHJlZ2lzdGVyZWQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgaXRlbSA9IHsgaWQ6IGB3cy0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDgpfWAsIG5hbWUsIHBhdGggfTtcbiAgICAgICAgZmFrZVdvcmtzcGFjZXMuaXRlbXMucHVzaChpdGVtKTtcbiAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlLCBjdXJyZW50OiBmYWtlV29ya3NwYWNlcy5jdXJyZW50LCBpdGVtczogZmFrZVdvcmtzcGFjZXMuaXRlbXMgfSkpO1xuICAgICAgfSkoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3dvcmtzcGFjZXMvdXNlJykge1xuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgoYXdhaXQgcmVhZEJvZHkoKSkgfHwgJ3t9JykgYXMgeyBpZD86IHVua25vd24gfTtcbiAgICAgICAgY29uc3QgaGl0ID0gZmFrZVdvcmtzcGFjZXMuaXRlbXMuZmluZCgodykgPT4gdy5pZCA9PT0gYm9keS5pZCk7XG4gICAgICAgIGlmIChoaXQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICd3b3Jrc3BhY2Ugbm90IGZvdW5kJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGZha2VXb3Jrc3BhY2VzLmN1cnJlbnQgPSBoaXQuaWQ7XG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgY3VycmVudDogZmFrZVdvcmtzcGFjZXMuY3VycmVudCwgaXRlbXM6IGZha2VXb3Jrc3BhY2VzLml0ZW1zIH0pKTtcbiAgICAgIH0pKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9wcm92aWRlcnMnKSB7XG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7IG5hbWU/OiB1bmtub3duOyBiYXNlVXJsPzogdW5rbm93bjsgbW9kZWw/OiB1bmtub3duOyBhcGlLZXk/OiB1bmtub3duIH07XG4gICAgICAgIGNvbnN0IG5hbWUgPSB0eXBlb2YgYm9keS5uYW1lID09PSAnc3RyaW5nJyA/IGJvZHkubmFtZS50cmltKCkgOiAnJztcbiAgICAgICAgY29uc3QgYmFzZVVybCA9IHR5cGVvZiBib2R5LmJhc2VVcmwgPT09ICdzdHJpbmcnID8gYm9keS5iYXNlVXJsLnRyaW0oKSA6ICcnO1xuICAgICAgICBjb25zdCBtb2RlbCA9IHR5cGVvZiBib2R5Lm1vZGVsID09PSAnc3RyaW5nJyA/IGJvZHkubW9kZWwudHJpbSgpIDogJyc7XG4gICAgICAgIGlmIChuYW1lID09PSAnJyB8fCBiYXNlVXJsID09PSAnJyB8fCBtb2RlbCA9PT0gJycpIHtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnbmFtZSwgYmFzZVVybCBhbmQgbW9kZWwgYXJlIHJlcXVpcmVkJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGZha2VQcm92aWRlcnMuc2V0KG5hbWUsIHsgYmFzZVVybCwgbW9kZWwsIGFwaUtleTogdHlwZW9mIGJvZHkuYXBpS2V5ID09PSAnc3RyaW5nJyA/IGJvZHkuYXBpS2V5IDogJycgfSk7XG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgbmFtZSB9KSk7XG4gICAgICB9KSgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9mcy9zZWFyY2gnKSB7XG4gICAgICAvLyBcdTVERTVcdTRGNUNcdTUzM0FcdTY1ODdcdTRFRjZcdTY0MUNcdTdEMjIoXHU0RTBFIGhtaGFybmVzcyBcdTU0MENcdTVGNjI6QFx1OTY0NFx1NEVGNlx1OTAwOVx1NjJFOVx1NTY2OFx1NzY4NFx1NjU3MFx1NjM2RVx1NkU5MClcbiAgICAgIGNvbnN0IHEgPSAodXJsLnNlYXJjaFBhcmFtcy5nZXQoJ3EnKSA/PyAnJykudHJpbSgpLnRvTG93ZXJDYXNlKCk7XG4gICAgICBjb25zdCBhbGwgPSBbXG4gICAgICAgIHsgcmVsOiAnUkVBRE1FLm1kJywgcGF0aDogJ0M6XFxcXGRlbW9cXFxcUkVBRE1FLm1kJywga2luZDogJ2ZpbGUnIH0sXG4gICAgICAgIHsgcmVsOiAnc3JjL2FwcC50cycsIHBhdGg6ICdDOlxcXFxkZW1vXFxcXHNyY1xcXFxhcHAudHMnLCBraW5kOiAnZmlsZScgfSxcbiAgICAgICAgeyByZWw6ICdkb2NzL25vdGVzLm1kJywgcGF0aDogJ0M6XFxcXGRlbW9cXFxcZG9jc1xcXFxub3Rlcy5tZCcsIGtpbmQ6ICdmaWxlJyB9LFxuICAgICAgXTtcbiAgICAgIGNvbnN0IGhpdHMgPSBxID09PSAnJyA/IGFsbCA6IGFsbC5maWx0ZXIoKGYpID0+IGYucmVsLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMocSkpO1xuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyByZXN1bHRzOiBoaXRzLnNsaWNlKDAsIDIwKSwgdHJ1bmNhdGVkOiBmYWxzZSwgdG90YWw6IGhpdHMubGVuZ3RoIH0pKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvY29nbml0aXZlJykge1xuICAgICAgLy8gXHU4QkE0XHU3N0U1XHU3MkI2XHU2MDAxKFx1NEUwRSBobWhhcm5lc3MgY29nbml0aXZlU3RhdHVzIFx1NTQwQ1x1NUY2Mlx1NUI1MFx1OTZDNjtcdTdGM0FcdTY1NzBcdTYzNkVcdTY2M0VcdTVGMEYgbnVsbClcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgbWVtb3J5OiB7IGxheWVyczogMywgZW50cmllczogMTIsIGNvbnRyYWRpY3Rpb25zOiAwIH0sXG4gICAgICAgIHRyYWplY3RvcmllczogNyxcbiAgICAgICAgYXVkaXRFdmVudHM6IDIxLFxuICAgICAgICB3b3JsZE1vZGVsOiB7IHZlcnNpb246IDQsIGJlbGllZnM6IDksIHRydXN0ZWQ6IDUsIGJyaWVyOiAwLjMxIH0sXG4gICAgICAgIGNhbGlicmF0aW9uOiB7IHByZWRpY3Rpb25zOiA0NiwgcmVsaWFiaWxpdHk6IDAuNzIgfSxcbiAgICAgIH0pKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2Zha2UvZW1pdCcpIHtcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgoYXdhaXQgcmVhZEJvZHkoKSkgfHwgJ3t9JykgYXMge1xuICAgICAgICAgICAgc2Vzc2lvbklkOiBzdHJpbmc7IHJ1bklkOiBzdHJpbmc7IGtpbmQ6IEV2ZW50S2luZDsgcGF5bG9hZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICAgICAgfTtcbiAgICAgICAgICBjb25zdCBzZXEgPSBlbWl0KGJvZHkuc2Vzc2lvbklkLCBib2R5LnJ1bklkLCBib2R5LmtpbmQsIGJvZHkucGF5bG9hZCk7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIHNlcSB9KSk7XG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsIFN0cmluZyhlcnIpLnNsaWNlKDAsIDEyMCksIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICB9XG4gICAgICB9KSgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCBgbm8gcm91dGUgJHtyZXEubWV0aG9kfSAke3VybC5wYXRobmFtZX1gLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgfSk7XG5cbiAgYXdhaXQgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgIHNlcnZlci5vbmNlKCdlcnJvcicsIHJlamVjdCk7XG4gICAgc2VydmVyLmxpc3RlbigwLCAnMTI3LjAuMC4xJywgKCkgPT4gcmVzb2x2ZSgpKTtcbiAgfSk7XG4gIGNvbnN0IGFkZHJlc3MgPSBzZXJ2ZXIuYWRkcmVzcygpO1xuICBpZiAoYWRkcmVzcyA9PT0gbnVsbCB8fCB0eXBlb2YgYWRkcmVzcyAhPT0gJ29iamVjdCcpIHRocm93IG5ldyBFcnJvcignZmFrZSBob3N0OiBubyBwb3J0Jyk7XG4gIGNvbnN0IHBvcnQgPSBhZGRyZXNzLnBvcnQ7XG5cbiAgaWYgKCFvcHRzLnF1aWV0KSB7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7SlNPTi5zdHJpbmdpZnkoeyBobWhEZXNrdG9wSG9zdFJlYWR5OiB0cnVlLCBwb3J0LCB2ZXJzaW9uOiAnZmFrZS0wLjAuMCcgfSl9XFxuYCk7XG4gIH1cbiAgY29uc3QgZGllQWZ0ZXIgPSBOdW1iZXIocHJvY2Vzcy5lbnYuRkFLRV9IT1NUX0RJRV9BRlRFUl9NUyA/PyAwKTtcbiAgaWYgKE51bWJlci5pc0Zpbml0ZShkaWVBZnRlcikgJiYgZGllQWZ0ZXIgPiAwKSB7XG4gICAgc2V0VGltZW91dCgoKSA9PiBwcm9jZXNzLmV4aXQoMSksIGRpZUFmdGVyKS51bnJlZigpO1xuICB9XG5cbiAgLy8gY2xvc2UoKTogXHU1MTQ4XHU2NUFEXHU1RjAwXHU1MTY4XHU5MEU4IFNTRSBcdThGREVcdTYzQTUoXHU1QjgzXHU0RUVDXHU2QzM4XHU0RTBEXHU4MUVBXHU3MTM2XHU1MTczXHU5NUVEKSxcdTU0MjZcdTUyMTkgc2VydmVyLmNsb3NlXG4gIC8vIFx1NEYxQVx1NEUwMFx1NzZGNFx1N0I0OVx1NkQzQlx1OERDM1x1OEZERVx1NjNBNSxcdTZENEJcdThCRDVcdThGREJcdTdBMEJcdTYzMDJcdTZCN0JcdTMwMDJcbiAgY29uc3QgY2xvc2UgPSAoKTogUHJvbWlzZTx2b2lkPiA9PlxuICAgIG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlKSA9PiB7XG4gICAgICBmb3IgKGNvbnN0IGMgb2Ygc3NlQ2xpZW50cykge1xuICAgICAgICB0cnkgeyBjLmVuZCgpOyBjLmRlc3Ryb3koKTsgfSBjYXRjaCB7IC8qIGFscmVhZHkgZ29uZSAqLyB9XG4gICAgICB9XG4gICAgICBzc2VDbGllbnRzLmNsZWFyKCk7XG4gICAgICBzZXJ2ZXIuY2xvc2UoKCkgPT4gcmVzb2x2ZSgpKTtcbiAgICAgIHNldFRpbWVvdXQoKCkgPT4gcmVzb2x2ZSgpLCAxXzAwMCkudW5yZWYoKTtcbiAgICB9KTtcblxuICByZXR1cm4geyBwb3J0LCBlbWl0LCBjbG9zZSB9O1xufVxuXG4vLyBcdTc2RjRcdTYzQTVcdThGRDBcdTg4NEMoc3VwZXJ2aXNvciBzcGF3biBcdTc2ODRcdTVCNTBcdThGREJcdTdBMEJcdTVGNjJcdTYwMDEpXHUzMDAycmVhbHBhdGggXHU2QkQ0XHU4RjgzOm5wbSB3b3Jrc3BhY2Vcbi8vIGp1bmN0aW9uIC8gXHU1OTI3XHU1QzBGXHU1MTk5XHU1REVFXHU1RjAyXHU5MEZEXHU0RTBEXHU4MEZEXHU4QkE5XHU4RkQ5XHU0RTJBXHU2OEMwXHU2RDRCXHU1OTMxXHU2MjRCKFx1NTkzMVx1NjI0Qj1cdTk3NTlcdTlFRDhcdTkwMDBcdTUxRkEgY29kZSAwLFx1OTZCRVx1NjdFNSlcdTMwMDJcbi8vIGNqcyBidW5kbGUoZXNidWlsZCxcdTYyNTNcdTUzMDVcdTRFQTdcdTU0QzEpXHU0RTBCIF9fZmlsZW5hbWUgXHU1QjU4XHU1NzI4O0VTTSh0c3gvXHU2RTkwXHU3ODAxKVx1NzUyOCBpbXBvcnQubWV0YVx1MzAwMlxuY29uc3Qgc2VsZlVybDogc3RyaW5nID0gdHlwZW9mIF9fZmlsZW5hbWUgPT09ICdzdHJpbmcnXG4gID8gcGF0aFRvRmlsZVVSTChyZWFscGF0aFN5bmMoX19maWxlbmFtZSkpLmhyZWZcbiAgOiBpbXBvcnQubWV0YS51cmw7XG5jb25zdCBpbnZva2VkQXNTY3JpcHQgPSAoKCkgPT4ge1xuICBpZiAocHJvY2Vzcy5hcmd2WzFdID09PSB1bmRlZmluZWQpIHJldHVybiBmYWxzZTtcbiAgdHJ5IHtcbiAgICByZXR1cm4gc2VsZlVybCA9PT0gcGF0aFRvRmlsZVVSTChyZWFscGF0aFN5bmMocHJvY2Vzcy5hcmd2WzFdKSkuaHJlZjtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59KSgpO1xuaWYgKGludm9rZWRBc1NjcmlwdCkge1xuICBjb25zdCB0b2tlbiA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1RPS0VOID8/ICcnO1xuICAvLyBGQUtFX0hPU1RfRElFX0FUX0JPT1Q9MTpcdTVGMTVcdTVCRkNcdTg4NENcdThGOTNcdTUxRkFcdTUyNERcdTUzNzNcdTZCN0IoXHU2Nzg0XHU5MDIwXHU1NDJGXHU1MkE4XHU2NzFGIFJVTlRJTUVfQ1JBU0hFRClcbiAgaWYgKHByb2Nlc3MuZW52LkZBS0VfSE9TVF9ESUVfQVRfQk9PVCA9PT0gJzEnKSB7XG4gICAgcHJvY2Vzcy5leGl0KDEpO1xuICB9XG4gIGNvbnN0IHNsb3cgPSBOdW1iZXIocHJvY2Vzcy5lbnYuRkFLRV9IT1NUX1NMT1dfQUZURVIgPz8gMCk7XG4gIGNvbnN0IGJvb3QgPSAoKTogdm9pZCA9PiB7XG4gICAgdm9pZCBzdGFydEZha2VIb3N0KHsgdG9rZW4gfSkuY2F0Y2goKGVycikgPT4ge1xuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYGZha2UtaG9zdCBmYWlsZWQ6ICR7U3RyaW5nKGVycil9XFxuYCk7XG4gICAgICBwcm9jZXNzLmV4aXQoMSk7XG4gICAgfSk7XG4gIH07XG4gIGlmIChOdW1iZXIuaXNGaW5pdGUoc2xvdykgJiYgc2xvdyA+IDApIHNldFRpbWVvdXQoYm9vdCwgc2xvdyk7XG4gIGVsc2UgYm9vdCgpO1xufVxuIiwgIi8qKlxuICogVUlWRVJJRlkgXHU5NEE5XHU1QjUwIFx1MjAxNFx1MjAxNCBcdTkwMTBcdTUyOUZcdTgwRkRcdTc3MUZcdTVCOUUgVUkgXHU5QTcxXHU1MkE4XHU5QThDXHU2NTM2KDIwMjYtMTAtMTAgXHU3NTI4XHU2MjM3XHU2MzA3XHU0RUU0OlxuICogXCJcdTVCRjlcdTZCQ0ZcdTRFMDBcdTRFMkFcdTUyOUZcdTgwRkQsXHU2QkNGXHU0RTAwXHU0RTJBXHU0RTFBXHU1MkExXHU2RDQxXHU3QTBCXHU1MTY4XHU5NzYyXHU3Njg0XHU5QThDXHU2NTM2XCIpXHUzMDAyXG4gKlxuICogXHU3NkY0XHU2M0E1XHU1QkY5XHU2RTMyXHU2N0QzXHU1NDBFXHU3Njg0IERPTSBcdTY1QURcdThBMDAoXHU1RTAzXHU1QzQwXHU1MUUwXHU0RjU1L1x1NTNFRlx1ODlDMVx1NjAyNyksXHU1RTc2XHU3NTI4XHU1MzlGXHU3NTFGXHU0RThCXHU0RUY2XHU5QTcxXHU1MkE4IFJlYWN0XG4gKiAoXHU1M0Q3XHU2M0E3XHU4RjkzXHU1MTY1XHU3NTI4XHU1MzlGXHU1NzhCIHNldHRlciArIGlucHV0IFx1NEU4Qlx1NEVGNjtcdTYzMDlcdTk0QUUgY2xpY2s7XHU5NTJFXHU3NkQ4XHU4RDcwIHdpbmRvd1xuICoga2V5ZG93bilcdTMwMDJmYWtlIFx1NkEyMVx1NUYwRlx1OEREMVx1NUI4Q1x1NjU3NFx1NEVGQlx1NTJBMVx1OTRGRShcdTUzRDFcdTkwMDFcdTIxOTJcdTVERTVcdTUxNzdcdTIxOTJcdTVCQTFcdTYyNzlcdTIxOTJcdTRFQTRcdTRFRDhcdTcyNjlcdTIxOTJcdTZDNDdcdTYwM0IpO1xuICogcmVhbCBcdTZBMjFcdTVGMEZcdTUzRUFcdThERDFcdTUzRUFcdThCRkJcdTVCNTBcdTk2QzYoXHU0RTBEXHU1MkE4XHU3NzFGXHU1QjlFXHU0RjFBXHU4QkREXHUzMDAxXHU0RTBEXHU3MEU3IHRva2VuKVx1MzAwMlxuICogXHU2QkNGXHU2QjY1XHU4RjkzXHU1MUZBIGBVSVZFUklGWSBQQVNTfEZBSUwgbmFtZSB8IGRldGFpbGAsXHU3RUQzXHU1QzNFIFNVTU1BUlksZXhpdCBjb2RlXHUzMDAyXG4gKi9cbmltcG9ydCB7IGFwcCwgdHlwZSBCcm93c2VyV2luZG93IH0gZnJvbSAnZWxlY3Ryb24nO1xuaW1wb3J0IHsgbWtkaXIsIHdyaXRlRmlsZSB9IGZyb20gJ25vZGU6ZnMvcHJvbWlzZXMnO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gJ25vZGU6cGF0aCc7XG5cbmNvbnN0IHNsZWVwID0gKG1zOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+ID0+IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIG1zKSk7XG5cbmFzeW5jIGZ1bmN0aW9uIHJ1blVpVmVyaWZ5KHdpbjogQnJvd3NlcldpbmRvdywgbW9kZTogJ2Zha2UnIHwgJ3JlYWwnKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHNob3RzID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfU0hPVFMgPz8gam9pbihhcHAuZ2V0UGF0aCgndGVtcCcpLCAnaG1oLXVpdmVyaWZ5Jyk7XG4gIGF3YWl0IG1rZGlyKHNob3RzLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KS5jYXRjaCgoKSA9PiB1bmRlZmluZWQpO1xuICBjb25zdCByZXN1bHRzOiBBcnJheTxbc3RyaW5nLCBib29sZWFuLCBzdHJpbmddPiA9IFtdO1xuICBsZXQgc2hvdElkeCA9IDA7XG5cbiAgY29uc3QganMgPSA8VD4oY29kZTogc3RyaW5nKTogUHJvbWlzZTxUPiA9PiB3aW4ud2ViQ29udGVudHMuZXhlY3V0ZUphdmFTY3JpcHQoY29kZSwgdHJ1ZSkgYXMgUHJvbWlzZTxUPjtcbiAgY29uc3Qgc3RlcCA9IGFzeW5jIChuYW1lOiBzdHJpbmcsIGZuOiAoKSA9PiBQcm9taXNlPFtib29sZWFuLCBzdHJpbmddPik6IFByb21pc2U8dm9pZD4gPT4ge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBbb2ssIGRldGFpbF0gPSBhd2FpdCBmbigpO1xuICAgICAgcmVzdWx0cy5wdXNoKFtuYW1lLCBvaywgZGV0YWlsXSk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBjb25zdCBkZXRhaWwgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciAmJiBlcnIuc3RhY2sgIT09IHVuZGVmaW5lZCA/IGVyci5zdGFjayA6IFN0cmluZyhlcnIpO1xuICAgICAgcmVzdWx0cy5wdXNoKFtuYW1lLCBmYWxzZSwgZGV0YWlsLnNsaWNlKDAsIDMwMCldKTtcbiAgICB9XG4gICAgY29uc3QgbGFzdCA9IHJlc3VsdHNbcmVzdWx0cy5sZW5ndGggLSAxXSE7XG4gICAgY29uc29sZS5sb2coYFVJVkVSSUZZICR7bGFzdFsxXSA/ICdQQVNTJyA6ICdGQUlMJ30gfCAke2xhc3RbMF19IHwgJHtsYXN0WzJdfWApO1xuICB9O1xuICAvKiogXHU4RjZFXHU4QkUyXHU3NkY0XHU1MjMwIHByZWRpY2F0ZUNvZGUgXHU4RkQ0XHU1NkRFIHtvazp0cnVlLC4uLn0gXHU2MjE2XHU4RDg1XHU2NUY2KFx1OEZENFx1NTZERVx1NjcwMFx1NTQwRVx1NzY4NCBkZXRhaWwpXHUzMDAyICovXG4gIGNvbnN0IHdhaXRGb3IgPSBhc3luYyAobGFiZWw6IHN0cmluZywgcHJlZGljYXRlQ29kZTogc3RyaW5nLCB0aW1lb3V0TXM6IG51bWJlcik6IFByb21pc2U8W2Jvb2xlYW4sIHN0cmluZ10+ID0+IHtcbiAgICBjb25zdCBzdGFydGVkID0gRGF0ZS5ub3coKTtcbiAgICBmb3IgKDs7KSB7XG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdHJ5IHsgcmV0dXJuIEpTT04uc3RyaW5naWZ5KChmdW5jdGlvbigpeyAke3ByZWRpY2F0ZUNvZGV9IH0pKCkpOyB9IGNhdGNoKGUpeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe29rOmZhbHNlLCBkZXRhaWw6U3RyaW5nKGUpLnNsaWNlKDAsMTIwKX0pOyB9IH0pKClgKSkgYXMgc3RyaW5nO1xuICAgICAgbGV0IHBhcnNlZDogeyBvaz86IGJvb2xlYW47IGRldGFpbD86IHN0cmluZyB9O1xuICAgICAgdHJ5IHsgcGFyc2VkID0gSlNPTi5wYXJzZShyKSBhcyB7IG9rPzogYm9vbGVhbjsgZGV0YWlsPzogc3RyaW5nIH07IH0gY2F0Y2ggeyBwYXJzZWQgPSB7IG9rOiBmYWxzZSwgZGV0YWlsOiBTdHJpbmcocikuc2xpY2UoMCwgMTIwKSB9OyB9XG4gICAgICBpZiAocGFyc2VkLm9rID09PSB0cnVlKSByZXR1cm4gW3RydWUsIFN0cmluZyhwYXJzZWQuZGV0YWlsID8/ICcnKV07XG4gICAgICBpZiAoRGF0ZS5ub3coKSAtIHN0YXJ0ZWQgPiB0aW1lb3V0TXMpIHJldHVybiBbZmFsc2UsIGAke2xhYmVsfTogJHtTdHJpbmcocGFyc2VkLmRldGFpbCA/PyAndGltZW91dCcpfWBdO1xuICAgICAgYXdhaXQgc2xlZXAoMjUwKTtcbiAgICB9XG4gIH07XG4gIGNvbnN0IHNob3QgPSBhc3luYyAobGFiZWw6IHN0cmluZyk6IFByb21pc2U8dm9pZD4gPT4ge1xuICAgIHNob3RJZHggKz0gMTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgaW1nID0gYXdhaXQgd2luLndlYkNvbnRlbnRzLmNhcHR1cmVQYWdlKCk7XG4gICAgICBhd2FpdCB3cml0ZUZpbGUoam9pbihzaG90cywgYCR7bW9kZX0tJHtTdHJpbmcoc2hvdElkeCkucGFkU3RhcnQoMiwgJzAnKX0tJHtsYWJlbH0ucG5nYCksIGltZy50b1BORygpKTtcbiAgICB9IGNhdGNoIHsgLyogXHU2MjJBXHU1NkZFXHU1OTMxXHU4RDI1XHU0RTBEXHU1MjI0XHU2QjdCICovIH1cbiAgfTtcblxuICAvKiAtLS0tIFx1NTNEN1x1NjNBN1x1OEY5M1x1NTE2NShSZWFjdDpcdTUzOUZcdTU3OEIgc2V0dGVyIFx1ODlFNlx1NTNEMSBvbkNoYW5nZSkgLS0tLSAqL1xuICBjb25zdCB0eXBlSW50byA9IChzZWw6IHN0cmluZywgdGV4dDogc3RyaW5nKTogUHJvbWlzZTx1bmtub3duPiA9PlxuICAgIGpzKGAoZnVuY3Rpb24oKXtcbiAgICAgIHZhciBlbCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJHtKU09OLnN0cmluZ2lmeShzZWwpfSk7XG4gICAgICBpZiAoIWVsKSByZXR1cm4gJ05PRUwnO1xuICAgICAgdmFyIHByb3RvID0gZWwudGFnTmFtZSA9PT0gJ1RFWFRBUkVBJyA/IEhUTUxUZXh0QXJlYUVsZW1lbnQucHJvdG90eXBlIDogSFRNTElucHV0RWxlbWVudC5wcm90b3R5cGU7XG4gICAgICBPYmplY3QuZ2V0T3duUHJvcGVydHlEZXNjcmlwdG9yKHByb3RvLCAndmFsdWUnKS5zZXQuY2FsbChlbCwgJHtKU09OLnN0cmluZ2lmeSh0ZXh0KX0pO1xuICAgICAgZWwuZGlzcGF0Y2hFdmVudChuZXcgRXZlbnQoJ2lucHV0JywgeyBidWJibGVzOiB0cnVlIH0pKTtcbiAgICAgIHJldHVybiAnT0snO1xuICAgIH0pKClgKTtcblxuICAvKiAtLS0tIFx1NTQyRlx1NTJBOFx1N0I0OVx1NUY4NTpSZWFjdCBcdTYzMDJcdThGN0QgKyBob3N0IFx1N0VGRlx1NzBCOShyZWFsIFx1NzY4NCBobWhhcm5lc3MgXHU1MUI3XHU1NDJGXHU1MkE4XHU4OTgxXHU3RjE2XHU4QkQxXG4gICAgIFx1NjU3NFx1NTk1NyBDTEkgXHU0RjlEXHU4RDU2LFx1NTNFRlx1NTIzMCAzMHMrO1x1NEUwRFx1N0I0OVx1N0VGRlx1NzBCOVx1NUMzMVx1NUYwMFx1OEREMVx1NEYxQVx1NTE2OFx1OTBFOFx1OEQ4NVx1NjVGNlx1OEJFRlx1NjJBNSkgLS0tLSAqL1xuICBhd2FpdCB3YWl0Rm9yKCdob3N0IHJlYWR5JywgYHZhciB0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jb21wb3NlciB0ZXh0YXJlYScpOyByZXR1cm4ge29rOiAhIXQsIGRldGFpbDogdCA/ICdtb3VudGVkJyA6ICdubyBjb21wb3Nlcid9O2AsIDIwXzAwMCk7XG4gIGF3YWl0IHdhaXRGb3IoJ2hvc3QgZG90IG9uJywgYHZhciBkPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ob3N0LWRvdCcpOyByZXR1cm4ge29rOiAhIWQgJiYgZC5jbGFzc0xpc3QuY29udGFpbnMoJ29uJyksIGRldGFpbDogZCA/IGQuY2xhc3NOYW1lIDogJ25vIGRvdCd9O2AsIG1vZGUgPT09ICdyZWFsJyA/IDYwXzAwMCA6IDIwXzAwMCk7XG4gIGF3YWl0IHNsZWVwKDFfMjAwKTsgLy8gXHU0RjFBXHU4QkREXHU1MjE3XHU4ODY4L1x1OTg3Nlx1NjgwRlx1NjU3MFx1NjM2RVx1ODQzRFx1NTczMFxuXG4gIC8qID09PT09PT09PT0gXHU5MDFBXHU3NTI4Olx1NUUwM1x1NUM0MFx1NTFFMFx1NEY1NShcdTc1MjhcdTYyMzdcdTYyQTVcdTk2OUNcdTc2ODRcdTc2RjRcdTYzQTVcdTY1QURcdThBMDApID09PT09PT09PT0gKi9cbiAgYXdhaXQgc3RlcCgnXHU1RTAzXHU1QzQwOlx1NjgwN1x1OTg5OFx1NjgwRitcdTRFMDlcdTY4MEYrY29tcG9zZXIgXHU1NzI4XHU4OUM2XHU1M0UzXHU1MTg1KFx1OEY5M1x1NTE2NVx1Njg0Nlx1NTNFRlx1ODlDMSknLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgciA9IChhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XG4gICAgICB2YXIgcSA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IuYmluZChkb2N1bWVudCk7XG4gICAgICB2YXIgdGIgPSBxKCcudGl0bGViYXInKSwgc2hlbGwgPSBxKCcuYXBwLXNoZWxsJyksIHNiID0gcSgnLnNpZGViYXInKSwgd3MgPSBxKCcud29ya3NwYWNlJyksIHRhID0gcSgnLmNvbXBvc2VyIHRleHRhcmVhJyk7XG4gICAgICB2YXIgbWlzc2luZyA9IFshdGIgJiYgJ3RpdGxlYmFyJywgIXNoZWxsICYmICdzaGVsbCcsICFzYiAmJiAnc2lkZWJhcicsICF3cyAmJiAnd29ya3NwYWNlJywgIXRhICYmICd0ZXh0YXJlYSddLmZpbHRlcihCb29sZWFuKS5qb2luKCcsJyk7XG4gICAgICBpZiAobWlzc2luZyAhPT0gJycpIHJldHVybiBKU09OLnN0cmluZ2lmeSh7b2s6ZmFsc2UsIGRldGFpbDonbWlzc2luZzonK21pc3Npbmd9KTtcbiAgICAgIHZhciByID0gdGEuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCksIHZoID0gd2luZG93LmlubmVySGVpZ2h0LCB2dyA9IHdpbmRvdy5pbm5lcldpZHRoO1xuICAgICAgdmFyIGhpbnQgPSBxKCcuZW1wdHktaGludC5iaWcnKTsgdmFyIGhyID0gaGludCA/IGhpbnQuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCkgOiBudWxsO1xuICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHsgb2s6IHIuaGVpZ2h0ID4gMzAgJiYgci5ib3R0b20gPD0gdmggJiYgci53aWR0aCA+IDEwMCAmJiBociAhPT0gbnVsbCAmJiBoci50b3AgPj0gMCAmJiBoci5ib3R0b20gPD0gdmgsXG4gICAgICAgIGRldGFpbDogJ3RleHRhcmVhIHk9JytNYXRoLnJvdW5kKHIueSkrJyBoPScrTWF0aC5yb3VuZChyLmhlaWdodCkrJyBib3R0b209JytNYXRoLnJvdW5kKHIuYm90dG9tKSsnIHZoPScrdmgrKGhyID8gJyBoaW50IHk9JytNYXRoLnJvdW5kKGhyLnkpIDogJyBuby1oaW50JykgfSk7XG4gICAgfSkoKWApKSBhcyBzdHJpbmc7XG4gICAgY29uc3QgcCA9IEpTT04ucGFyc2UocikgYXMgeyBvazogYm9vbGVhbjsgZGV0YWlsOiBzdHJpbmcgfTtcbiAgICByZXR1cm4gW3Aub2sgPT09IHRydWUsIHAuZGV0YWlsXTtcbiAgfSk7XG5cbiAgaWYgKG1vZGUgPT09ICdmYWtlJykge1xuICAgIC8qID09PT09PT09PT0gZmFrZShcdTU0MTFcdTVCRkNcdTY3ODRcdTkwMjAsSE1IX0RFU0tUT1BfVUlWRVJJRllfV0laQVJEPWZha2UpOlxuICAgICAgIFx1NEYyQVx1OTAyMFx1NjcyQVx1OTE0RFx1N0Y2RVx1NjAwMSBcdTIxOTIgXHU1NDExXHU1QkZDXHU1MUZBXHU3M0IwIFx1MjE5MiBcdTY4QzBcdTZENEIoXHU2NzJBXHU4OEM1KVx1MjE5MiBcdTkwMDlcdTYyRTkgXHUyMTkyIFx1NTE4NVx1N0Y2RSBcdTIxOTIgXHU4RkRFXHU0RTBBID09PT09PT09PT0gKi9cbiAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfV0laQVJEID09PSAnZmFrZScpIHtcbiAgICAgIGF3YWl0IHN0ZXAoJ1x1NTQxMVx1NUJGQzpcdTk5OTZcdTU0MkZcdTVGMzlcdTUxRkFcdTZCMjJcdThGQ0VcdTk4NzUoXHU1RjAwXHU1OUNCXHU5MTREXHU3RjZFL1x1NkYxNFx1NzkzQVx1NTE2NVx1NTNFMyknLCBhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCd3aXphcmQgb3ZlcmxheScsIGB2YXIgbz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKTtcbiAgICAgICAgICB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1RjAwXHU1OUNCXHU5MTREXHU3RjZFJzt9KTtcbiAgICAgICAgICByZXR1cm4ge29rOiAhIW8gJiYgISFiLCBkZXRhaWw6IG8gPyAnb3ZlcmxheStcdTVGMDBcdTU5Q0JcdTkxNERcdTdGNkUnIDogJ25vIG92ZXJsYXknfTtgLCAxMl8wMDApO1xuICAgICAgICBhd2FpdCBzaG90KCd3aXphcmQtd2VsY29tZScpO1xuICAgICAgICByZXR1cm4gdztcbiAgICAgIH0pO1xuICAgICAgYXdhaXQgc3RlcCgnXHU1NDExXHU1QkZDOlx1NUYwMFx1NTlDQlx1OTE0RFx1N0Y2RVx1MjE5Mlx1NjhDMFx1NkQ0QihcdTRGMkFcdTkwMjBcdTY3MkFcdTg4QzUpXHUyMTkyXHU4MUVBXHU1MkE4XHU4RkRCXHU5MDA5XHU2MkU5XHU5ODc1KFx1NEUwOVx1OTAwOVx1NEUwMCtcdTUxNjhcdTVDNDBcdTkxNERcdTdGNkVcdTYzRDBcdTc5M0EpJywgYXN5bmMgKCkgPT4ge1xuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTVGMDBcdTU5Q0JcdTkxNERcdTdGNkUnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcbiAgICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3NlbGVjdCBwYWdlJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1zZWxlY3QnKTtcbiAgICAgICAgICBpZighcCkgcmV0dXJuIHtvazpmYWxzZSwgZGV0YWlsOidub3Qgb24gc2VsZWN0J307XG4gICAgICAgICAgdmFyIHQ9cC50ZXh0Q29udGVudDtcbiAgICAgICAgICB2YXIgbzE9dC5pbmRleE9mKCdcdTRFMEJcdThGN0RcdTVCODlcdTg4QzVcdTVCOENcdTY1NzQgaG1oIENMSScpPj0wLCBvMj10LmluZGV4T2YoJ1x1NEY3Rlx1NzUyOFx1NTE4NVx1N0Y2RVx1N0NCRVx1N0I4MFx1NTE4NVx1NjgzOCcpPj0wLCBvMz10LmluZGV4T2YoJ1x1OERGM1x1OEZDNyhcdTZGMTRcdTc5M0FcdTZBMjFcdTVGMEYpJyk+PTAsIG5vdGU9dC5pbmRleE9mKCcuaG1oYXJuZXNzJyk+PTA7XG4gICAgICAgICAgcmV0dXJuIHtvazogbzEmJm8yJiZvMyYmbm90ZSwgZGV0YWlsOiAnb3B0MT0nK28xKycgb3B0Mj0nK28yKycgb3B0Mz0nK28zKycgbm90ZT0nK25vdGV9O2AsIDEyXzAwMCk7XG4gICAgICAgIGF3YWl0IHNob3QoJ3dpemFyZC1zZWxlY3QnKTtcbiAgICAgICAgcmV0dXJuIHc7XG4gICAgICB9KTtcbiAgICAgIGF3YWl0IHN0ZXAoJ1x1NTQxMVx1NUJGQzpcdTkwMDlcdTUxODVcdTdGNkVcdTdDQkVcdTdCODBcdTUxODVcdTY4MzhcdTIxOTJcdTkxNERcdTdGNkVcdThERjNcdThGQzdcdTIxOTJcdTVCOENcdTYyMTBcdTk4NzVcdTIxOTJcdTVGMDBcdTU5Q0JcdTRGN0ZcdTc1MjhcdTIxOTJcdTUxNzNcdTk1RURcdTRFMTRcdTVERjJcdThGREVcdTYzQTUnLCBhc3luYyAoKSA9PiB7XG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIG89W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW9wdCcpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1NEY3Rlx1NzUyOFx1NTE4NVx1N0Y2RVx1N0NCRVx1N0I4MFx1NTE4NVx1NjgzOCcpPj0wO30pOyBpZihvKSBvLmNsaWNrKCk7IH0pKClgKTtcbiAgICAgICAgYXdhaXQgc2xlZXAoMzAwKTtcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU0RTBCXHU0RTAwXHU2QjY1J3x8eC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1RjAwXHU1OUNCXHU1Qjg5XHU4OEM1Jzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XG4gICAgICAgIC8vIFx1OTE0RFx1N0Y2RVx1OTg3NTpmYWtlIHByb3ZpZGVycyBcdTVERjJcdTY3MDlcdTVCQzZcdTk0QTUgXHUyMTkyIFx1ODFFQVx1NTJBOFx1OERGM1x1OEZDNztcdTUxNUNcdTVFOTVcdTcwQjlcIlx1OERGM1x1OEZDN1wiXG4gICAgICAgIGF3YWl0IHdhaXRGb3IoJ2NvbmZpZyBvciBkb25lJywgYHZhciBkPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1kb25lJyk7XG4gICAgICAgICAgaWYoZCkgcmV0dXJuIHtvazp0cnVlLCBkZXRhaWw6J2RvbmUnfTtcbiAgICAgICAgICB2YXIgYz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtY29uZmlnJyk7XG4gICAgICAgICAgaWYoYyl7IHZhciBzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1OERGM1x1OEZDNycpPj0wO30pOyBpZihzKSBzLmNsaWNrKCk7IH1cbiAgICAgICAgICByZXR1cm4ge29rOmZhbHNlLCBkZXRhaWw6J3dhaXRpbmcnfTtgLCAxNV8wMDApO1xuICAgICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignZG9uZSBwYWdlJywgYHZhciBkPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1kb25lJyk7XG4gICAgICAgICAgdmFyIHQ9ZD9kLnRleHRDb250ZW50OicnO1xuICAgICAgICAgIHJldHVybiB7b2s6ICEhZCAmJiB0LmluZGV4T2YoJ1x1NUMzMVx1N0VFQScpPj0wICYmIHQuaW5kZXhPZignXHU1MTcxXHU0RUFCJyk+PTAsIGRldGFpbDogdC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNjApfTtgLCA4XzAwMCk7XG4gICAgICAgIGF3YWl0IHNob3QoJ3dpemFyZC1kb25lJyk7XG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NUYwMFx1NTlDQlx1NEY3Rlx1NzUyOCc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xuICAgICAgICBjb25zdCBjbG9zZWQgPSBhd2FpdCB3YWl0Rm9yKCd3aXphcmQgY2xvc2VkICsgY29ubmVjdGVkJywgYHJldHVybiB7b2s6ICFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKSAmJiAhIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ob3N0LWRvdC5vbicpLFxuICAgICAgICAgIGRldGFpbDogJ292ZXJsYXk9JysoZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1vdmVybGF5Jyk/J29wZW4nOidjbG9zZWQnKSsnIGRvdD0nKyhkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuaG9zdC1kb3Qub24nKT8nb24nOidvZmYnKX07YCwgMTBfMDAwKTtcbiAgICAgICAgcmV0dXJuIFt3WzBdICYmIGNsb3NlZFswXSwgYGRvbmU6ICR7d1sxXX07ICR7Y2xvc2VkWzFdfWBdO1xuICAgICAgfSk7XG4gICAgfVxuXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1OTk5Nlx1OEREMVx1NUYxNVx1NUJGQ1x1NUM0MiA9PT09PT09PT09ICovXG4gICAgYXdhaXQgc3RlcCgnXHU1RjE1XHU1QkZDXHU1QzQyOlx1NkYxNFx1NzkzQVx1NkEyMVx1NUYwRlx1NjNEMFx1NzkzQVx1NTFGQVx1NzNCMFx1NUU3Nlx1NTNFRlx1NTE3M1x1OTVFRCcsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdndWlkZScsIGB2YXIgZz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcucnVudGltZS1ndWlkZScpOyByZXR1cm4ge29rOiAhIWcsIGRldGFpbDogZyA/ICdzaG93bicgOiAnbm90IHNob3duJ307YCwgOF8wMDApO1xuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXtcbiAgICAgICAgdmFyIGJ0bnMgPSBbXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5ydW50aW1lLWd1aWRlIGJ1dHRvbicpKTtcbiAgICAgICAgdmFyIGIgPSBidG5zLmZpbmQoZnVuY3Rpb24oeCl7IHJldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1NkYxNFx1NzkzQScpID49IDA7IH0pO1xuICAgICAgICBpZiAoYikgYi5jbGljaygpO1xuICAgICAgfSkoKWApO1xuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2d1aWRlIGdvbmUnLCBgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ydW50aW1lLWd1aWRlJyksIGRldGFpbDogZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnJ1bnRpbWUtZ3VpZGUnKSA/ICdzdGlsbCcgOiAnZGlzbWlzc2VkJ307YCwgNV8wMDApO1xuICAgIH0pO1xuXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NjVCMFx1NUVGQVx1NEYxQVx1OEJERChDdHJsK04pID09PT09PT09PT0gKi9cbiAgICBhd2FpdCBzdGVwKCdDdHJsK04gXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkRELFx1OEY5M1x1NTE2NVx1Njg0Nlx1NTNFRlx1NzUyOCcsIGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J24nLCBjdHJsS2V5OnRydWUsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xuICAgICAgcmV0dXJuIHdhaXRGb3IoJ3RleHRhcmVhIGVuYWJsZWQnLCBgdmFyIHQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNvbXBvc2VyIHRleHRhcmVhJyk7XG4gICAgICAgIHJldHVybiB7b2s6ICEhdCAmJiB0LmRpc2FibGVkID09PSBmYWxzZSAmJiAodC5wbGFjZWhvbGRlcnx8JycpLmluZGV4T2YoJ1x1NjNDRlx1OEZGMFx1NzZFRVx1NjgwNycpID49IDAsIGRldGFpbDogdCA/ICgnZGlzYWJsZWQ9Jyt0LmRpc2FibGVkKycgcGg9JysodC5wbGFjZWhvbGRlcnx8JycpLnNsaWNlKDAsMjApKSA6ICdubyB0YSd9O2AsIDVfMDAwKTtcbiAgICB9KTtcblxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTUzRDFcdTkwMDFcdTRFRkJcdTUyQTEgXHUyMTkyIFx1NzUyOFx1NjIzN1x1OEY2RVx1NTFGQVx1NzNCMChcdTRFMTRcdTRFQzVcdTRFMDBcdTY3NjEsXHU1M0NDXHU2RDg4XHU2MDZGXHU1NkRFXHU1RjUyKSA9PT09PT09PT09ICovXG4gICAgYXdhaXQgc3RlcCgnXHU4RjkzXHU1MTY1XHU1RTc2XHU1M0QxXHU5MDAxXHU0RUZCXHU1MkExLFx1NzUyOFx1NjIzN1x1NkQ4OFx1NjA2Rlx1NEUwQVx1NUM0Rlx1NEUxNFx1NEUwRFx1OTFDRFx1NTkwRCcsIGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IHR5cGVJbnRvKCcuY29tcG9zZXIgdGV4dGFyZWEnLCAnXHU5QThDXHU2NTM2XHU0RUZCXHU1MkExOlx1NTE5OVx1NTE2NVx1NEUwMFx1NEUyQVx1NjU4N1x1NEVGNicpO1xuICAgICAgYXdhaXQgc2xlZXAoMjAwKTtcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXtcbiAgICAgICAgdmFyIGJ0bnMgPSBbXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jb21wb3NlciBidXR0b24nKSk7XG4gICAgICAgIHZhciBiID0gYnRucy5maW5kKGZ1bmN0aW9uKHgpeyByZXR1cm4geC50ZXh0Q29udGVudC50cmltKCkgPT09ICdcdTUzRDFcdTkwMDEnOyB9KTtcbiAgICAgICAgaWYgKGIpIGIuY2xpY2soKTtcbiAgICAgIH0pKClgKTtcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdleGFjdGx5IG9uZSB1c2VyIHR1cm4nLCBgdmFyIHRzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnR1cm4udXNlcicpKS5maWx0ZXIoZnVuY3Rpb24oeCl7IHJldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1OUE4Q1x1NjUzNlx1NEVGQlx1NTJBMScpID49IDA7IH0pO1xuICAgICAgICByZXR1cm4ge29rOiB0cy5sZW5ndGggPT09IDEsIGRldGFpbDogJ2NvdW50PScrdHMubGVuZ3RoKycgdGV4dD0nKyh0c1swXT90c1swXS50ZXh0Q29udGVudC5zbGljZSgwLDMwKTonbm9uZScpfTtgLCA4XzAwMCk7XG4gICAgfSk7XG5cbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU1REU1XHU1MTc3XHU1MzYxKHJlYWRfZmlsZSBcdTVCOENcdTYyMTApID09PT09PT09PT0gKi9cbiAgICBhd2FpdCBzdGVwKCdcdTVERTVcdTUxNzdcdTYyOThcdTUzRTBcdTUzNjE6cmVhZF9maWxlIFx1NjI2N1x1ODg0Q1x1NUU3Nlx1NUI4Q1x1NjIxMCcsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCd0b29sIGNhcmQnLCBgdmFyIGM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudG9vbC1jYXJkJykpO1xuICAgICAgICB2YXIgZG9uZSA9IGMuZmlsdGVyKGZ1bmN0aW9uKHgpeyByZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdyZWFkX2ZpbGUnKSA+PSAwICYmIHgudGV4dENvbnRlbnQuaW5kZXhPZignIyBkZW1vJykgPj0gMDsgfSk7XG4gICAgICAgIHJldHVybiB7b2s6IGRvbmUubGVuZ3RoID49IDEsIGRldGFpbDogJ2NhcmRzPScrYy5sZW5ndGgrJyBkb25lPScrZG9uZS5sZW5ndGh9O2AsIDhfMDAwKTtcbiAgICAgIHJldHVybiB3O1xuICAgIH0pO1xuXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NUJBMVx1NjI3OVx1N0VCNVx1NTIwN1x1NzI0NyhcdTc1MjhcdTYyMzdcdTYyQTVcdTk2OUNcdTY4MzhcdTVGQzNcdTRFNEJcdTRFMDApID09PT09PT09PT0gKi9cbiAgICBhd2FpdCBzdGVwKCdcdTVCQTFcdTYyNzk6YXBwcm92YWwgXHU1MzYxXHU1MUZBXHU3M0IwKFx1N0I0OVx1NUY4NVx1NEVCQVx1NURFNVx1NjI3OVx1NTFDNiknLCBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBzaG90KCdhcHByb3ZhbC1wZW5kaW5nJyk7XG4gICAgICByZXR1cm4gd2FpdEZvcignYXBwcm92YWwgY2FyZCcsIGB2YXIgYT1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuYXBwcm92YWwtY2FyZCcpO1xuICAgICAgICByZXR1cm4ge29rOiAhIWEgJiYgYS50ZXh0Q29udGVudC5pbmRleE9mKCdcdTk3MDBcdTg5ODFcdTVCQTFcdTYyNzknKSA+PSAwLCBkZXRhaWw6IGEgPyBhLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCwgNjApIDogJ25vIGFwcHJvdmFsIGNhcmQnfTtgLCA4XzAwMCk7XG4gICAgfSk7XG4gICAgYXdhaXQgc3RlcCgnXHU1QkExXHU2Mjc5Olx1NzBCOVx1NjI3OVx1NTFDNiBcdTIxOTIgXHU0RUZCXHU1MkExXHU3RUU3XHU3RUVEXHU1MjMwXHU0RUE0XHU0RUQ4XHU3MjY5K1x1NkM0N1x1NjAzQicsIGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXtcbiAgICAgICAgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuYXBwcm92YWwtY2FyZCBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXsgcmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NjI3OVx1NTFDNic7IH0pO1xuICAgICAgICBpZiAoYikgYi5jbGljaygpO1xuICAgICAgfSkoKWApO1xuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2FydGlmYWN0K3N1bScsIGB2YXIgYXJ0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5hcnRpZmFjdC1jYXJkJyk7XG4gICAgICAgIHZhciBzdW09ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnR1cm4tc3VtJyk7XG4gICAgICAgIHZhciBhc3Q9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudHVybicpKS5maWx0ZXIoZnVuY3Rpb24oeCl7IHJldHVybiB4LmNsYXNzTmFtZS5pbmRleE9mKCd1c2VyJyk8MCAmJiB4LnRleHRDb250ZW50LmluZGV4T2YoJ2VjaG86Jyk+PTA7IH0pO1xuICAgICAgICByZXR1cm4ge29rOiAhIWFydCAmJiAhIXN1bSAmJiBhc3QubGVuZ3RoPj0xLCBkZXRhaWw6ICdhcnRpZmFjdD0nKyhhcnQ/YXJ0LnRleHRDb250ZW50LnNsaWNlKDAsMzApOidub25lJykrJyBzdW09Jysoc3VtP3N1bS50ZXh0Q29udGVudDonbm9uZScpKycgYW5zd2VyZWQ9Jythc3QubGVuZ3RofTtgLCAxMl8wMDApO1xuICAgICAgYXdhaXQgc2hvdCgncnVuLWNvbXBsZXRlZCcpO1xuICAgICAgcmV0dXJuIHc7XG4gICAgfSk7XG5cbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU1Mzg2XHU1M0YyXHU0RjFBXHU4QkREXHU1MTg1XHU1QkI5KFx1NzUyOFx1NjIzN1x1NjJBNVx1OTY5Q1wiXHU3NzBCXHU0RTBEXHU1MjMwXHU1MTg1XHU1QkI5XCIpID09PT09PT09PT0gKi9cbiAgICBhd2FpdCBzdGVwKCdcdTcwQjlcdTUxRkJcdTUzODZcdTUzRjJcdTRGMUFcdThCREQgXHUyMTkyIHRyYW5zY3JpcHQgXHU1MTg1XHU1QkI5XHU1M0VGXHU4OUMxJywgYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgaXQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNlc3Npb24taXRlbScpOyBpZiAoaXQpIGl0LmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdoaXN0b3J5IHR1cm5zJywgYHZhciB0cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50dXJuJykpO1xuICAgICAgICByZXR1cm4ge29rOiB0cy5sZW5ndGggPj0gMiwgZGV0YWlsOiAndHVybnM9Jyt0cy5sZW5ndGgrJyBmaXJzdD0nKyh0c1swXT90c1swXS50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNDApOidub25lJyl9O2AsIDhfMDAwKTtcbiAgICB9KTtcblxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTRFOTRcdTk4NzVcdTdCN0UgPT09PT09PT09PSAqL1xuICAgIGF3YWl0IHN0ZXAoJ0RvY2s6T3ZlcnZpZXcgXHU2NTcwXHU2MzZFXHU4ODRDJywgYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J092ZXJ2aWV3Jzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XG4gICAgICByZXR1cm4gd2FpdEZvcignb3ZlcnZpZXcgcm93cycsIGB2YXIgcm93cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXJvdycpKTtcbiAgICAgICAgdmFyIHZlciA9IHJvd3MuZmluZChmdW5jdGlvbihyKXsgcmV0dXJuIHIudGV4dENvbnRlbnQuaW5kZXhPZigncnVudGltZSBcdTcyNDhcdTY3MkMnKT49MDsgfSk7XG4gICAgICAgIHJldHVybiB7b2s6IHJvd3MubGVuZ3RoID49IDUgJiYgISF2ZXIsIGRldGFpbDogJ3Jvd3M9Jytyb3dzLmxlbmd0aCsodmVyPycgdmVyPScrdmVyLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw0MCk6JycpfTtgLCA2XzAwMCk7XG4gICAgfSk7XG4gICAgYXdhaXQgc3RlcCgnRG9jazpGaWxlcyBcdTZENEZcdTg5QzgrXHU2NTg3XHU0RUY2XHU5ODg0XHU4OUM4JywgYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J1x1NjU4N1x1NEVGNid8fHgudGV4dENvbnRlbnQ9PT0nRmlsZXMnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdmcyByb3dzJywgYHZhciByb3dzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5mcy1yb3cnKS5sZW5ndGg7XG4gICAgICAgIHJldHVybiB7b2s6IHJvd3MgPj0gMSwgZGV0YWlsOiAncm93cz0nK3Jvd3N9O2AsIDZfMDAwKTtcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XG4gICAgICAvLyBcdTY4MzlcdTc2RUVcdTVGNTVcdTUzRUFcdTY3MDlcdTVERTVcdTRGNUNcdTUzM0FcdTc2RUVcdTVGNTUoZmFrZSBcdTRFMEVcdTc3MUZcdTVCOUUgcnVudGltZSBcdTU0MENcdTVGNjIpOlx1NTE0OFx1OEZEQlx1NzZFRVx1NUY1NSxcdTUxOERcdTcwQjlcdTY1ODdcdTRFRjZcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZnMtcm93JykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignZGVtby13b3Jrc3BhY2UnKT49MCB8fCB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1RDgzRFx1RENDMScpPj0wO30pOyBpZihkKSBkLmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIGNvbnN0IHcyID0gYXdhaXQgd2FpdEZvcignZmlsZSByb3dzJywgYHZhciByb3dzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmZzLXJvdycpKTtcbiAgICAgICAgcmV0dXJuIHtvazogcm93cy5zb21lKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1JFQURNRScpPj0wO30pLCBkZXRhaWw6ICdyb3dzPScrcm93cy5sZW5ndGh9O2AsIDZfMDAwKTtcbiAgICAgIGlmICghdzJbMF0pIHJldHVybiB3MjtcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGY9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZnMtcm93JykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignUkVBRE1FJyk+PTA7fSk7IGlmKGYpIGYuY2xpY2soKTsgfSkoKWApO1xuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2ZpbGUgcHJldmlldycsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuZnMtcHJldmlldycpO1xuICAgICAgICByZXR1cm4ge29rOiAhIXAgJiYgcC50ZXh0Q29udGVudC5pbmRleE9mKCdkZW1vIHdvcmtzcGFjZScpID49IDAsIGRldGFpbDogcCA/IHAudGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDQwKSA6ICdubyBwcmV2aWV3J307YCwgNl8wMDApO1xuICAgIH0pO1xuICAgIGF3YWl0IHN0ZXAoJ0RvY2s6RGlmZiBcdTUzRDhcdTY2RjRcdTg4NEMnLCBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nXHU1M0Q4XHU2NkY0J3x8eC50ZXh0Q29udGVudD09PSdEaWZmJzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XG4gICAgICByZXR1cm4gd2FpdEZvcignZGlmZiByb3dzJywgYHZhciByb3dzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kaWZmLXJvdycpLmxlbmd0aDtcbiAgICAgICAgcmV0dXJuIHtvazogcm93cyA+PSAxLCBkZXRhaWw6ICdkaWZmIHJvd3M9Jytyb3dzfTtgLCA2XzAwMCk7XG4gICAgfSk7XG4gICAgYXdhaXQgc3RlcCgnRG9jazpFdmlkZW5jZSBcdThCQTRcdTc3RTVcdTY1NzBcdTYzNkUnLCBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nXHU4QkMxXHU2MzZFJ3x8eC50ZXh0Q29udGVudD09PSdFdmlkZW5jZSc7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2V2aWRlbmNlIHJvd3MnLCBgdmFyIHJvd3M9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay1yb3cnKSk7XG4gICAgICAgIHZhciBtZW0gPSByb3dzLmZpbmQoZnVuY3Rpb24ocil7IHJldHVybiByLnRleHRDb250ZW50LmluZGV4T2YoJ1x1OEJCMFx1NUZDNlx1NUM0MicpPj0wIHx8IHIudGV4dENvbnRlbnQuaW5kZXhPZignTWVtb3J5IGxheWVycycpPj0wOyB9KTtcbiAgICAgICAgcmV0dXJuIHtvazogISFtZW0gJiYgbWVtLnRleHRDb250ZW50LmluZGV4T2YoJzMnKSA+PSAwLCBkZXRhaWw6IG1lbSA/IG1lbS50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpIDogJ25vIG1lbW9yeSByb3cnfTtgLCA2XzAwMCk7XG4gICAgfSk7XG4gICAgYXdhaXQgc3RlcCgnRG9jazpMb2dzIFx1OTc2Mlx1Njc3RihcdTdBN0FcdTYwMDFcdTYzRDBcdTc5M0EpJywgYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J1x1NjVFNVx1NUZENyd8fHgudGV4dENvbnRlbnQ9PT0nTG9ncyc7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2xvZ3MgcGFuZScsIGB2YXIgbD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcubG9ncy1saXN0Jyk7XG4gICAgICAgIHJldHVybiB7b2s6ICEhbCwgZGV0YWlsOiBsID8gKCdyb3dzPScrbC5xdWVyeVNlbGVjdG9yQWxsKCcubG9nLXJvdycpLmxlbmd0aCkgOiAnbm8gbG9ncyBsaXN0J307YCwgNV8wMDApO1xuICAgICAgcmV0dXJuIHc7XG4gICAgfSk7XG5cbiAgICAvKiA9PT09PT09PT09IGZha2U6RG9jazpcdThGRENcdTdBMEJcdTk4NzVcdTdCN0UoXHU2MjRCXHU2NzNBXHU4RkRDXHU3QTBCXHU2M0E3XHU1MjM2XHU5NzYyXHU2NzdGK1x1NUYwMFx1NjczQVx1ODFFQVx1NTQyRlx1ODg0QykgPT09PT09PT09PSAqL1xuICAgIGF3YWl0IHN0ZXAoJ0RvY2s6XHU4RkRDXHU3QTBCXHU5ODc1XHU3QjdFKFx1NjI0Qlx1NjczQVx1OEZEQ1x1N0EwQlx1NjNBN1x1NTIzNlx1OTc2Mlx1Njc3RiknLCBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nXHU4RkRDXHU3QTBCJ3x8eC50ZXh0Q29udGVudD09PSdSZW1vdGUnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdyZW1vdGUgcGFuZScsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuZG9jay1ib2R5Jyk7XG4gICAgICAgIHZhciB0ID0gcCA/IHAudGV4dENvbnRlbnQgOiAnJztcbiAgICAgICAgdmFyIG9rVCA9IHQuaW5kZXhPZignXHU2MjRCXHU2NzNBXHU4RkRDXHU3QTBCXHU2M0E3XHU1MjM2Jyk+PTAgfHwgdC5pbmRleE9mKCdQaG9uZSByZW1vdGUnKT49MDtcbiAgICAgICAgdmFyIG9rQSA9IHQuaW5kZXhPZignXHU1RjAwXHU2NzNBXHU4MUVBXHU1NDJGJyk+PTAgfHwgdC5pbmRleE9mKCdBdXRvc3RhcnQnKT49MDtcbiAgICAgICAgcmV0dXJuIHtvazogISFwICYmIG9rVCAmJiBva0EsIGRldGFpbDogdC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNjApfTtgLCA2XzAwMCk7XG4gICAgfSk7XG5cbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU2NDFDXHU3RDIyXHU4RkM3XHU2RUU0ID09PT09PT09PT0gKi9cbiAgICBhd2FpdCBzdGVwKCdcdTRGMUFcdThCRERcdTY0MUNcdTdEMjI6XHU4RkM3XHU2RUU0XHU3NTFGXHU2NTQ4JywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgYmVmb3JlID0gKGF3YWl0IGpzKGBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoYCkpIGFzIG51bWJlcjtcbiAgICAgIGF3YWl0IHR5cGVJbnRvKCcuc2Vzc2lvbi1zZWFyY2gnLCAnenp6LVx1NEUwRFx1NUI1OFx1NTcyOFx1NzY4NFx1NEYxQVx1OEJERCcpO1xuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2ZpbHRlcmVkIGVtcHR5JywgYHZhciBuPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGg7XG4gICAgICAgIHJldHVybiB7b2s6IG4gPT09IDAsIGRldGFpbDogJ2FmdGVyPScrbn07YCwgNV8wMDApO1xuICAgICAgYXdhaXQgdHlwZUludG8oJy5zZXNzaW9uLXNlYXJjaCcsICcnKTtcbiAgICAgIGF3YWl0IHNsZWVwKDQwMCk7XG4gICAgICBjb25zdCBhZnRlciA9IChhd2FpdCBqcyhgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aGApKSBhcyBudW1iZXI7XG4gICAgICByZXR1cm4gW3dbMF0gJiYgYWZ0ZXIgPT09IGJlZm9yZSwgYCR7d1sxXX07IFx1NjA2Mlx1NTkwRFx1NTQwRSAke2FmdGVyfT09PSR7YmVmb3JlfWBdO1xuICAgIH0pO1xuXG4gICAgLyogPT09PT09PT09PSBmYWtlOkN0cmwrSyBcdTU0N0RcdTRFRTRcdTk3NjJcdTY3N0YgPT09PT09PT09PSAqL1xuICAgIGF3YWl0IHN0ZXAoJ0N0cmwrSyBcdTU0N0RcdTRFRTRcdTk3NjJcdTY3N0Y6XHU2MjUzXHU1RjAwXHU1RTc2XHU2MjY3XHU4ODRDXHU1NDdEXHU0RUU0JywgYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleTonaycsIGN0cmxLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignY21kayBvcGVuJywgYHZhciBjPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrJyk7XG4gICAgICAgIHJldHVybiB7b2s6ICEhYywgZGV0YWlsOiBjID8gJ29wZW4nIDogJ25vdCBvcGVuJ307YCwgNV8wMDApO1xuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGl0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNtZGstaXRlbScpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1NjU4N1x1NEVGNicpPj0wIHx8IHgudGV4dENvbnRlbnQuaW5kZXhPZignRmlsZXMnKT49MDt9KTsgaWYoaXQpIGl0LmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIHJldHVybiB3YWl0Rm9yKCd0YWIgc3dpdGNoZWQnLCBgdmFyIHQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmRvY2stdGFiLmFjdGl2ZScpO1xuICAgICAgICByZXR1cm4ge29rOiAhIXQgJiYgKHQudGV4dENvbnRlbnQ9PT0nXHU2NTg3XHU0RUY2J3x8dC50ZXh0Q29udGVudD09PSdGaWxlcycpLCBkZXRhaWw6ICdhY3RpdmU9JysodD90LnRleHRDb250ZW50Oidub25lJyl9O2AsIDVfMDAwKTtcbiAgICB9KTtcblxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdThCQkVcdTdGNkVcdTk3NjJcdTY3N0YgPT09PT09PT09PSAqL1xuICAgIGF3YWl0IHN0ZXAoJ1x1OEJCRVx1N0Y2RShDdHJsK1NoaWZ0K1ApOlByb3ZpZGVyIFx1ODg2OFx1NTM1NVx1NTNFRlx1ODlDMSxFc2MgXHU1MTczXHU5NUVEJywgYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleToncCcsIGN0cmxLZXk6dHJ1ZSwgc2hpZnRLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignc2V0dGluZ3Mgb3BlbicsIGB2YXIgcz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kay5zZXR0aW5ncycpO1xuICAgICAgICByZXR1cm4ge29rOiAhIXMgJiYgISFzLnF1ZXJ5U2VsZWN0b3IoJy5wcm92aWRlci1mb3JtJyksIGRldGFpbDogcyA/ICdvcGVuK2Zvcm0nIDogJ25vdCBvcGVuJ307YCwgNV8wMDApO1xuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J0VzY2FwZScsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xuICAgICAgcmV0dXJuIHdhaXRGb3IoJ3NldHRpbmdzIGNsb3NlZCcsIGByZXR1cm4ge29rOiAhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNtZGstb3ZlcmxheScpLCBkZXRhaWw6ICdjbG9zZWQnfTtgLCA1XzAwMCk7XG4gICAgfSk7XG5cbiAgICAvKiA9PT09PT09PT09IGZha2U6aTE4biBcdThCRURcdThBMDBcdTUyMDdcdTYzNjIgPT09PT09PT09PSAqL1xuICAgIGF3YWl0IHN0ZXAoJ1x1OEJFRFx1OEEwMFx1NTIwN1x1NjM2MjpcdTRFMkRcdTY1ODcgXHUyMTkyIEVuZ2xpc2ggXHUyMTkyIFx1NjA2Mlx1NTkwRFx1NEUyRFx1NjU4NycsIGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J3AnLCBjdHJsS2V5OnRydWUsIHNoaWZ0S2V5OnRydWUsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3NldHRpbmdzIG9wZW4nLCBgdmFyIHM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNtZGsuc2V0dGluZ3MnKTtcbiAgICAgICAgcmV0dXJuIHtvazogISFzLCBkZXRhaWw6IHMgPyAnb3BlbicgOiAnbm90IG9wZW4nfTtgLCA1XzAwMCk7XG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jbWRrLnNldHRpbmdzIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdFbmdsaXNoJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XG4gICAgICBjb25zdCBlbiA9IGF3YWl0IHdhaXRGb3IoJ2VuZ2xpc2ggc2hvd24nLCBgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXItaGVhZCAuYnRuLnByaW1hcnknKTtcbiAgICAgICAgcmV0dXJuIHtvazogISFiICYmIGIudGV4dENvbnRlbnQgPT09ICcrIE5ldyBTZXNzaW9uJywgZGV0YWlsOiAnYnRuPScrKGI/Yi50ZXh0Q29udGVudDonbm9uZScpfTtgLCA1XzAwMCk7XG4gICAgICBhd2FpdCBzaG90KCdlbmdsaXNoJyk7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNtZGsuc2V0dGluZ3MgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NEUyRFx1NjU4Nyc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xuICAgICAgY29uc3QgemggPSBhd2FpdCB3YWl0Rm9yKCdjaGluZXNlIGJhY2snLCBgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXItaGVhZCAuYnRuLnByaW1hcnknKTtcbiAgICAgICAgcmV0dXJuIHtvazogISFiICYmIGIudGV4dENvbnRlbnQgPT09ICcrIFx1NjVCMFx1NUVGQVx1NEYxQVx1OEJERCcsIGRldGFpbDogJ2J0bj0nKyhiP2IudGV4dENvbnRlbnQ6J25vbmUnKX07YCwgNV8wMDApO1xuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleTonRXNjYXBlJywgYnViYmxlczp0cnVlfSkpYCk7XG4gICAgICByZXR1cm4gW2VuWzBdICYmIHpoWzBdLCBgZW46ICR7ZW5bMV19OyB6aDogJHt6aFsxXX1gXTtcbiAgICB9KTtcblxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTVERTVcdTRGNUNcdTUzM0FcdTdCQTFcdTc0MDYoXHU1REU2XHU2ODBGXHU2ODBGXHU0RjREICsgXHU4M0RDXHU1MzU1ICsgXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREXHU5MDA5XHU1REU1XHU0RjVDXHU1MzNBKSA9PT09PT09PT09ICovXG4gICAgYXdhaXQgc3RlcCgnXHU1REU1XHU0RjVDXHU1MzNBOlx1NURFNlx1NjgwRlx1NURFNVx1NEY1Q1x1NTMzQVx1NjgwRlx1NTNFRlx1ODlDMShcdTVGNTNcdTUyNERcdTVERTVcdTRGNUNcdTUzM0FcdTU0MEQpJywgYXN5bmMgKCkgPT4ge1xuICAgICAgcmV0dXJuIHdhaXRGb3IoJ3dvcmtzcGFjZSBiYXInLCBgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndvcmtzcGFjZS1iYXInKTtcbiAgICAgICAgdmFyIG4gPSBiID8gKGIucXVlcnlTZWxlY3RvcignLndzLWJhci1uYW1lJyl8fHt9KS50ZXh0Q29udGVudCA6ICcnO1xuICAgICAgICByZXR1cm4ge29rOiAhIWIgJiYgISFuICYmIG4ubGVuZ3RoID4gMCAmJiBuLmluZGV4T2YoJ1x1NTJBMFx1OEY3RCcpIDwgMCwgZGV0YWlsOiAnYmFyPScrKGI/J3llcyc6J25vJykrJyBuYW1lPScrbn07YCwgOF8wMDApO1xuICAgIH0pO1xuICAgIGF3YWl0IHN0ZXAoJ1x1NURFNVx1NEY1Q1x1NTMzQTpcdTgzRENcdTUzNTVcdTVGMzlcdTUxRkEsXHU1MjE3XHU4ODY4K1x1NUY1M1x1NTI0RFx1OUFEOFx1NEVBRStcdTZERkJcdTUyQTBcdTUxNjVcdTUzRTM7XHU1NzI4XHU2MzA3XHU1QjlBXHU1REU1XHU0RjVDXHU1MzNBXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREJywgYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud29ya3NwYWNlLWJhcicpOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCd3cyBtZW51JywgYHZhciBtPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1tZW51Jyk7XG4gICAgICAgIHZhciBpdGVtcyA9IG0gPyBtLnF1ZXJ5U2VsZWN0b3JBbGwoJy53cy1tZW51LWl0ZW0nKS5sZW5ndGggOiAwO1xuICAgICAgICB2YXIgY3VyID0gbSA/IG0ucXVlcnlTZWxlY3RvckFsbCgnLndzLW1lbnUtaXRlbS5jdXJyZW50JykubGVuZ3RoIDogMDtcbiAgICAgICAgdmFyIGFkZCA9IG0gPyAobS50ZXh0Q29udGVudC5pbmRleE9mKCdcdTZERkJcdTUyQTBcdTVERTVcdTRGNUNcdTUzM0EnKT49MCB8fCBtLnRleHRDb250ZW50LmluZGV4T2YoJ0FkZCB3b3Jrc3BhY2UnKT49MCkgOiBmYWxzZTtcbiAgICAgICAgcmV0dXJuIHtvazogaXRlbXMgPj0gMSAmJiBjdXIgPj0gMSAmJiBhZGQsIGRldGFpbDogJ2l0ZW1zPScraXRlbXMrJyBjdXJyZW50PScrY3VyKycgYWRkPScrYWRkfTtgLCA2XzAwMCk7XG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xuICAgICAgYXdhaXQgc2hvdCgnd3MtbWVudScpO1xuICAgICAgLy8gXHU3MEI5XHU3QjJDXHU0RTAwXHU0RTJBXHU1REU1XHU0RjVDXHU1MzNBXHU5ODc5ID0gXHU1NzI4XHU4QkU1XHU1REU1XHU0RjVDXHU1MzNBXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREKFx1ODNEQ1x1NTM1NVx1NTE3M1x1OTVFRFx1MzAwMWNvbXBvc2VyIFx1NTNFRlx1NzUyOClcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGl0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1tZW51LWl0ZW0nKTsgaWYoaXQpIGl0LmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIGNvbnN0IGNsb3NlZCA9IGF3YWl0IHdhaXRGb3IoJ21lbnUgY2xvc2VkICsgc2Vzc2lvbiBhY3RpdmUnLCBgdmFyIHRhPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jb21wb3NlciB0ZXh0YXJlYScpO1xuICAgICAgICByZXR1cm4ge29rOiAhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLW1lbnUnKSAmJiAhIXRhICYmIHRhLmRpc2FibGVkID09PSBmYWxzZSwgZGV0YWlsOiAnbWVudT0nKyhkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtbWVudScpPydvcGVuJzonY2xvc2VkJykrJyB0YT0nKyh0YT90YS5kaXNhYmxlZDonbm9uZScpfTtgLCA2XzAwMCk7XG4gICAgICByZXR1cm4gW2Nsb3NlZFswXSwgYCR7d1sxXX07ICR7Y2xvc2VkWzFdfWBdO1xuICAgIH0pO1xuXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NEYxQVx1OEJERFx1NjMwOVx1NURFNVx1NEY1Q1x1NTMzQVx1NTIwNlx1N0VDNCArIFx1NUM1NVx1NUYwMC9cdTY1MzZcdThENzcgPT09PT09PT09PSAqL1xuICAgIGF3YWl0IHN0ZXAoJ1x1NEYxQVx1OEJERFx1NTIwNlx1N0VDNDpcdTdFQzRcdTU5MzRcdTUxRkFcdTczQjAoXHU1REU1XHU0RjVDXHU1MzNBXHU1NDBEK1x1NjU3MFx1OTFDRiknLCBhc3luYyAoKSA9PiB7XG4gICAgICByZXR1cm4gd2FpdEZvcignZ3JvdXAgaGVhZCcsIGB2YXIgaD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtZ3JvdXAtaGVhZCcpO1xuICAgICAgICB2YXIgbiA9IGggPyAoaC5xdWVyeVNlbGVjdG9yKCcud3MtZ3JvdXAtbmFtZScpfHx7fSkudGV4dENvbnRlbnQgOiAnJztcbiAgICAgICAgdmFyIGMgPSBoID8gKGgucXVlcnlTZWxlY3RvcignLndzLWdyb3VwLWNvdW50Jyl8fHt9KS50ZXh0Q29udGVudCA6ICcnO1xuICAgICAgICByZXR1cm4ge29rOiAhIWggJiYgbi5sZW5ndGggPiAwICYmIGMubGVuZ3RoID4gMCwgZGV0YWlsOiAnbmFtZT0nK24rJyBjb3VudD0nK2N9O2AsIDhfMDAwKTtcbiAgICB9KTtcbiAgICBhd2FpdCBzdGVwKCdcdTRGMUFcdThCRERcdTUyMDZcdTdFQzQ6XHU3MEI5XHU1MUZCXHU3RUM0XHU1OTM0XHU2NTM2XHU4RDc3LFx1NTE4RFx1NzBCOVx1NUM1NVx1NUYwMFx1NjA2Mlx1NTkwRCcsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IGJlZm9yZSA9IChhd2FpdCBqcyhgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aGApKSBhcyBudW1iZXI7XG4gICAgICBpZiAoYmVmb3JlID09PSAwKSByZXR1cm4gW2ZhbHNlLCAnbm8gc2Vzc2lvbnMgdG8gZ3JvdXAnXTtcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGg9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLWdyb3VwLWhlYWQnKTsgaWYoaCkgaC5jbGljaygpOyB9KSgpYCk7XG4gICAgICBjb25zdCBjb2xsYXBzZWQgPSBhd2FpdCB3YWl0Rm9yKCdjb2xsYXBzZWQnLCBgdmFyIGc9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLWdyb3VwJyk7XG4gICAgICAgIHZhciBoaWRkZW4gPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoIDwgJHtiZWZvcmV9O1xuICAgICAgICByZXR1cm4ge29rOiBoaWRkZW4sIGRldGFpbDogJ2l0ZW1zPScrZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aCsnIGJlZm9yZT0ke2JlZm9yZX0nfTtgLCA1XzAwMCk7XG4gICAgICBhd2FpdCBzaG90KCd3cy1ncm91cC1jb2xsYXBzZWQnKTtcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGg9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLWdyb3VwLWhlYWQnKTsgaWYoaCkgaC5jbGljaygpOyB9KSgpYCk7XG4gICAgICBjb25zdCBleHBhbmRlZCA9IGF3YWl0IHdhaXRGb3IoJ2V4cGFuZGVkIGJhY2snLCBgdmFyIG49ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aDtcbiAgICAgICAgcmV0dXJuIHtvazogbiA+PSAke2JlZm9yZX0sIGRldGFpbDogJ2l0ZW1zPScrbn07YCwgNV8wMDApO1xuICAgICAgcmV0dXJuIFtjb2xsYXBzZWRbMF0gJiYgZXhwYW5kZWRbMF0sIGBjb2xsYXBzZTogJHtjb2xsYXBzZWRbMV19OyBleHBhbmQ6ICR7ZXhwYW5kZWRbMV19YF07XG4gICAgfSk7XG5cbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU1RkVCXHU2Mzc3XHU5NTJFXHU1RTJFXHU1MkE5XHU5NzYyXHU2NzdGKEN0cmwrLykgPT09PT09PT09PSAqL1xuICAgIGF3YWl0IHN0ZXAoJ1x1NUZFQlx1NjM3N1x1OTUyRVx1NUUyRVx1NTJBOTpDdHJsKy8gXHU2MjUzXHU1RjAwLEVzYyBcdTUxNzNcdTk1RUQnLCBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OicvJywgY3RybEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdzaG9ydGN1dHMgb3BlbicsIGB2YXIgcz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kaycpO1xuICAgICAgICB2YXIgcm93cyA9IHMgPyBzLnF1ZXJ5U2VsZWN0b3JBbGwoJy5zaG9ydGN1dC1yb3cnKS5sZW5ndGggOiAwO1xuICAgICAgICByZXR1cm4ge29rOiByb3dzID49IDUsIGRldGFpbDogJ3Jvd3M9Jytyb3dzfTtgLCA1XzAwMCk7XG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xuICAgICAgYXdhaXQgc2hvdCgnc2hvcnRjdXRzJyk7XG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidFc2NhcGUnLCBidWJibGVzOnRydWV9KSlgKTtcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdzaG9ydGN1dHMgY2xvc2VkJywgYHJldHVybiB7b2s6ICFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kay1vdmVybGF5JyksIGRldGFpbDogJ2Nsb3NlZCd9O2AsIDVfMDAwKTtcbiAgICB9KTtcblxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTRGQTdcdTY4MEZcdTY1MzZcdTdGMjkgKyBcdTcyQjZcdTYwMDFcdThGQzdcdTZFRTQgPT09PT09PT09PSAqL1xuICAgIGF3YWl0IHN0ZXAoJ1x1NEZBN1x1NjgwRlx1NjUzNlx1N0YyOTpcdTIxRTQgXHU2NTM2XHU4RDc3XHU1REU2XHU2ODBGLFx1MjFFNSBcdTVDNTVcdTVGMDBcdTYwNjJcdTU5MEQnLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcigndG9nZ2xlIGJ0bicsIGB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50b3BiYXIgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1MjFFNCd8fHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1MjFFNSc7fSk7XG4gICAgICAgIHJldHVybiB7b2s6ICEhYiwgZGV0YWlsOiAnYnRuPScrKGI/Yi50ZXh0Q29udGVudC50cmltKCk6J25vbmUnKX07YCwgNV8wMDApO1xuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudG9wYmFyIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTIxRTQnfHx4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTIxRTUnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIGNvbnN0IGhpZGRlbiA9IGF3YWl0IHdhaXRGb3IoJ3NpZGViYXIgaGlkZGVuJywgYHZhciBzYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhcicpO1xuICAgICAgICB2YXIgZ29uZSA9ICFzYiB8fCBnZXRDb21wdXRlZFN0eWxlKHNiKS5kaXNwbGF5ID09PSAnbm9uZSc7XG4gICAgICAgIHJldHVybiB7b2s6IGdvbmUsIGRldGFpbDogJ2Rpc3BsYXk9Jysoc2I/Z2V0Q29tcHV0ZWRTdHlsZShzYikuZGlzcGxheTonbm9uZScpfTtgLCA1XzAwMCk7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnRvcGJhciBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHUyMUU0J3x8eC50ZXh0Q29udGVudC50cmltKCk9PT0nXHUyMUU1Jzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XG4gICAgICBjb25zdCBzaG93biA9IGF3YWl0IHdhaXRGb3IoJ3NpZGViYXIgYmFjaycsIGB2YXIgc2I9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXInKTtcbiAgICAgICAgcmV0dXJuIHtvazogISFzYiAmJiBnZXRDb21wdXRlZFN0eWxlKHNiKS5kaXNwbGF5ICE9PSAnbm9uZScsIGRldGFpbDogJ2Rpc3BsYXk9Jysoc2I/Z2V0Q29tcHV0ZWRTdHlsZShzYikuZGlzcGxheTonbm9uZScpfTtgLCA1XzAwMCk7XG4gICAgICByZXR1cm4gW2hpZGRlblswXSAmJiBzaG93blswXSwgYGhpZGU6ICR7aGlkZGVuWzFdfTsgc2hvdzogJHtzaG93blsxXX1gXTtcbiAgICB9KTtcbiAgICBhd2FpdCBzdGVwKCdcdTcyQjZcdTYwMDFcdThGQzdcdTZFRTQ6XHU0RTBCXHU2MkM5XHU1MjA3XHU2MzYyXHU1MjMwXCJcdThGRDBcdTg4NENcdTRFMkRcIlx1NEUwRFx1NUQyOVx1NkU4M1x1NUU3Nlx1NjA2Mlx1NTkwRCcsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHNlbCA9IGF3YWl0IHdhaXRGb3IoJ2ZpbHRlciBzZWxlY3QnLCBgdmFyIHM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnN0YXR1cy1maWx0ZXInKTtcbiAgICAgICAgcmV0dXJuIHtvazogISFzICYmIHMub3B0aW9ucy5sZW5ndGggPj0gNCwgZGV0YWlsOiAnb3B0aW9ucz0nKyhzP3Mub3B0aW9ucy5sZW5ndGg6MCl9O2AsIDVfMDAwKTtcbiAgICAgIGlmICghc2VsWzBdKSByZXR1cm4gc2VsO1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgcz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc3RhdHVzLWZpbHRlcicpOyBzLnZhbHVlPSdydW5uaW5nJzsgcy5kaXNwYXRjaEV2ZW50KG5ldyBFdmVudCgnY2hhbmdlJyx7YnViYmxlczp0cnVlfSkpOyB9KSgpYCk7XG4gICAgICBhd2FpdCBzbGVlcCg1MDApO1xuICAgICAgY29uc3QgcjEgPSAoYXdhaXQganMoYGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGhgKSkgYXMgbnVtYmVyO1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgcz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc3RhdHVzLWZpbHRlcicpOyBzLnZhbHVlPSdhbGwnOyBzLmRpc3BhdGNoRXZlbnQobmV3IEV2ZW50KCdjaGFuZ2UnLHtidWJibGVzOnRydWV9KSk7IH0pKClgKTtcbiAgICAgIGF3YWl0IHNsZWVwKDUwMCk7XG4gICAgICBjb25zdCByMiA9IChhd2FpdCBqcyhgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aGApKSBhcyBudW1iZXI7XG4gICAgICByZXR1cm4gW3IyID49IHIxICYmIHIyID49IDEsIGBydW5uaW5nPSR7cjF9IGFsbD0ke3IyfWBdO1xuICAgIH0pO1xuXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NkEyMVx1NTc4Qlx1OTAwOVx1NjJFOVx1NTY2OChcdTk4NzZcdTY4MEZcdTUyMDdcdTYzNjIgY2hhdCBcdThERUZcdTc1MzEpID09PT09PT09PT0gKi9cbiAgICBhd2FpdCBzdGVwKCdcdTZBMjFcdTU3OEJcdTkwMDlcdTYyRTlcdTU2Njg6XHU5ODc2XHU2ODBGXHU4M0RDXHU1MzU1XHU1MjE3XHU1MUZBIHByb3ZpZGVycyBcdTVFNzZcdTUzRUZcdTUyMDdcdTYzNjInLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignbW9kZWwgYnV0dG9uJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy50b3BiYXItbW9kZWwuYXMtYnV0dG9uJyk7XG4gICAgICAgIHJldHVybiB7b2s6ICEhYiAmJiBiLmRpc2FibGVkID09PSBmYWxzZSwgZGV0YWlsOiBiID8gYi50ZXh0Q29udGVudCA6ICdub25lJ307YCwgNl8wMDApO1xuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnRvcGJhci1tb2RlbC5hcy1idXR0b24nKTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XG4gICAgICBjb25zdCBtID0gYXdhaXQgd2FpdEZvcignbW9kZWwgbWVudScsIGB2YXIgbT1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcubW9kZWwtbWVudScpO1xuICAgICAgICB2YXIgaXRlbXMgPSBtID8gbS5xdWVyeVNlbGVjdG9yQWxsKCcud3MtbWVudS1pdGVtJykubGVuZ3RoIDogMDtcbiAgICAgICAgdmFyIGN1ciA9IG0gPyBtLnF1ZXJ5U2VsZWN0b3JBbGwoJy53cy1tZW51LWl0ZW0uY3VycmVudCcpLmxlbmd0aCA6IDA7XG4gICAgICAgIHJldHVybiB7b2s6IGl0ZW1zID49IDIgJiYgY3VyID49IDEsIGRldGFpbDogJ2l0ZW1zPScraXRlbXMrJyBjdXJyZW50PScrY3VyfTtgLCA1XzAwMCk7XG4gICAgICBpZiAoIW1bMF0pIHJldHVybiBtO1xuICAgICAgYXdhaXQgc2hvdCgnbW9kZWwtbWVudScpO1xuICAgICAgLy8gXHU1MjA3XHU1MjMwXHU3QjJDXHU0RThDXHU0RTJBIHByb3ZpZGVyKGZha2U6IGRlbW8tdmlzaW9uL2Zha2UtbS12aXNpb24pXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBpdHM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcubW9kZWwtbWVudSAud3MtbWVudS1pdGVtJykpOyB2YXIgaXQ9aXRzW2l0cy5sZW5ndGgtMV07IGlmKGl0KSBpdC5jbGljaygpOyB9KSgpYCk7XG4gICAgICByZXR1cm4gd2FpdEZvcignbW9kZWwgc3dpdGNoZWQnLCBgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnRvcGJhci1tb2RlbC5hcy1idXR0b24nKTtcbiAgICAgICAgcmV0dXJuIHtvazogISFiICYmIGIudGV4dENvbnRlbnQuaW5kZXhPZignZmFrZS1tLXZpc2lvbicpID49IDAsIGRldGFpbDogJ2JhZGdlPScrKGI/Yi50ZXh0Q29udGVudDonbm9uZScpfTtgLCA2XzAwMCk7XG4gICAgfSk7XG5cbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU0RTNCXHU5ODk4KFx1NkQ0NVx1ODI3Mlx1NzUxRlx1NjU0OFx1MjE5Mlx1NjA2Mlx1NTkwRFx1NkRGMVx1ODI3MikgPT09PT09PT09PSAqL1xuICAgIGF3YWl0IHN0ZXAoJ1x1NEUzQlx1OTg5ODpcdThCQkVcdTdGNkVcdTUyMDdcdTZENDVcdTgyNzJcdTc1MUZcdTY1NDgsXHU2MDYyXHU1OTBEXHU2REYxXHU4MjcyJywgYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleToncCcsIGN0cmxLZXk6dHJ1ZSwgc2hpZnRLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignc2V0dGluZ3Mgb3BlbicsIGB2YXIgcz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kay5zZXR0aW5ncycpO1xuICAgICAgICByZXR1cm4ge29rOiAhIXMsIGRldGFpbDogcyA/ICdvcGVuJyA6ICdub3Qgb3Blbid9O2AsIDVfMDAwKTtcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNtZGsuc2V0dGluZ3MgLnNlZyBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU2RDQ1XHU4MjcyJ3x8eC50ZXh0Q29udGVudC50cmltKCk9PT0nTGlnaHQnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIGNvbnN0IGxpZ2h0ID0gYXdhaXQgd2FpdEZvcignbGlnaHQgdGhlbWUnLCBgdmFyIGR0PWRvY3VtZW50LmRvY3VtZW50RWxlbWVudC5kYXRhc2V0LnRoZW1lO1xuICAgICAgICB2YXIgYmcgPSBnZXRDb21wdXRlZFN0eWxlKGRvY3VtZW50LmJvZHkpLmJhY2tncm91bmRDb2xvcjtcbiAgICAgICAgdmFyIG0gPSAvXFxcXGQrL2c7IHZhciBudW1zPShiZy5tYXRjaChtKXx8WycwJywnMCcsJzAnXSkubWFwKE51bWJlcik7XG4gICAgICAgIHJldHVybiB7b2s6IGR0PT09J2xpZ2h0JyAmJiBudW1zWzBdPjIwMCAmJiBudW1zWzFdPjIwMCAmJiBudW1zWzJdPjIwMCwgZGV0YWlsOiAndGhlbWU9JytkdCsnIGJnPScrYmd9O2AsIDVfMDAwKTtcbiAgICAgIGF3YWl0IHNob3QoJ2xpZ2h0LXRoZW1lJyk7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNtZGsuc2V0dGluZ3MgLnNlZyBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU2REYxXHU4MjcyJ3x8eC50ZXh0Q29udGVudC50cmltKCk9PT0nRGFyayc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xuICAgICAgY29uc3QgZGFyayA9IGF3YWl0IHdhaXRGb3IoJ2RhcmsgYmFjaycsIGByZXR1cm4ge29rOiBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuZGF0YXNldC50aGVtZT09PSdkYXJrJywgZGV0YWlsOiAndGhlbWU9Jytkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuZGF0YXNldC50aGVtZX07YCwgNV8wMDApO1xuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleTonRXNjYXBlJywgYnViYmxlczp0cnVlfSkpYCk7XG4gICAgICByZXR1cm4gW2xpZ2h0WzBdICYmIGRhcmtbMF0sIGBsaWdodDogJHtsaWdodFsxXX07IGRhcms6ICR7ZGFya1sxXX1gXTtcbiAgICB9KTtcblxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTk4NzZcdTY4MEYgXHU0RTJEL0VOIFx1NUZFQlx1NjM3N1x1NTIwN1x1NjM2MihcdTUzRUZcdTUzRDFcdTczQjBcdTYwMjcpID09PT09PT09PT0gKi9cbiAgICBhd2FpdCBzdGVwKCdcdTk4NzZcdTY4MEZcdTVGRUJcdTYzNzdcdTUyMDdcdTYzNjI6XHU0RTJEL0VOIFx1NEUwMFx1OTUyRVx1NTIwN1x1NjM2MicsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdsYW5nIHNlZycsIGB2YXIgcz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcubGFuZy1zZWcnKTtcbiAgICAgICAgcmV0dXJuIHtvazogISFzICYmIHMucXVlcnlTZWxlY3RvckFsbCgnYnV0dG9uJykubGVuZ3RoID09PSAyLCBkZXRhaWw6IHMgPyAncHJlc2VudCcgOiAnYWJzZW50J307YCwgNV8wMDApO1xuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcubGFuZy1zZWcgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J0VOJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XG4gICAgICBjb25zdCBlbiA9IGF3YWl0IHdhaXRGb3IoJ2VuZ2xpc2gnLCBgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXItaGVhZCAuYnRuLnByaW1hcnknKTtcbiAgICAgICAgcmV0dXJuIHtvazogISFiICYmIGIudGV4dENvbnRlbnQgPT09ICcrIE5ldyBTZXNzaW9uJywgZGV0YWlsOiAnYnRuPScrKGI/Yi50ZXh0Q29udGVudDonbm9uZScpfTtgLCA1XzAwMCk7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmxhbmctc2VnIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTRFMkQnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIGNvbnN0IHpoID0gYXdhaXQgd2FpdEZvcignY2hpbmVzZSBiYWNrJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyLWhlYWQgLmJ0bi5wcmltYXJ5Jyk7XG4gICAgICAgIHJldHVybiB7b2s6ICEhYiAmJiBiLnRleHRDb250ZW50ID09PSAnKyBcdTY1QjBcdTVFRkFcdTRGMUFcdThCREQnLCBkZXRhaWw6ICdidG49JysoYj9iLnRleHRDb250ZW50Oidub25lJyl9O2AsIDVfMDAwKTtcbiAgICAgIHJldHVybiBbZW5bMF0gJiYgemhbMF0sIGBlbjogJHtlblsxXX07IHpoOiAke3poWzFdfWBdO1xuICAgIH0pO1xuXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1N0M5OFx1OEQzNFx1NTZGRVx1NzI0NyBcdTIxOTIgXHU3RjI5XHU3NTY1XHU1NkZFIGNoaXAgXHUyMTkyIFx1NTNEMVx1OTAwMSBcdTIxOTIgcnVudGltZSBcdTY1MzZcdTUyMzAgPT09PT09PT09PSAqL1xuICAgIGF3YWl0IHN0ZXAoJ1x1N0M5OFx1OEQzNFx1NTZGRVx1NzI0NzpcdTdGMjlcdTc1NjVcdTU2RkUgY2hpcCArIFx1NTNEMVx1OTAwMVx1NTQwRSBydW50aW1lIFx1NjUzNlx1NTIzMFx1NTZGRVx1NzI0NycsIGFzeW5jICgpID0+IHtcbiAgICAgIC8vIFx1NjVCMFx1NUVGQVx1NEYxQVx1OEJERFx1Nzg2RVx1NEZERCBjb21wb3NlciBcdTUzRUZcdTc1MjhcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J24nLCBjdHJsS2V5OnRydWUsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xuICAgICAgYXdhaXQgc2xlZXAoMzAwKTtcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXtcbiAgICAgICAgdmFyIHRhID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNvbXBvc2VyIHRleHRhcmVhJyk7XG4gICAgICAgIGlmICghdGEpIHJldHVybjtcbiAgICAgICAgdmFyIGMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdjYW52YXMnKTtcbiAgICAgICAgYy53aWR0aCA9IDg7IGMuaGVpZ2h0ID0gODtcbiAgICAgICAgdmFyIGN0eCA9IGMuZ2V0Q29udGV4dCgnMmQnKTtcbiAgICAgICAgY3R4LmZpbGxTdHlsZSA9ICcjM2Y5NjUwJzsgY3R4LmZpbGxSZWN0KDAsIDAsIDgsIDgpO1xuICAgICAgICBjLnRvQmxvYihmdW5jdGlvbihibG9iKXtcbiAgICAgICAgICB2YXIgZHQgPSBuZXcgRGF0YVRyYW5zZmVyKCk7XG4gICAgICAgICAgZHQuaXRlbXMuYWRkKG5ldyBGaWxlKFtibG9iXSwgJ3Bhc3RlZC5wbmcnLCB7dHlwZTogJ2ltYWdlL3BuZyd9KSk7XG4gICAgICAgICAgdGEuZGlzcGF0Y2hFdmVudChuZXcgQ2xpcGJvYXJkRXZlbnQoJ3Bhc3RlJywge2NsaXBib2FyZERhdGE6IGR0LCBidWJibGVzOiB0cnVlLCBjYW5jZWxhYmxlOiB0cnVlfSkpO1xuICAgICAgICB9LCAnaW1hZ2UvcG5nJyk7XG4gICAgICB9KSgpYCk7XG4gICAgICBjb25zdCBjaGlwID0gYXdhaXQgd2FpdEZvcignaW1hZ2UgY2hpcCcsIGB2YXIgbj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuYXR0LWNoaXAuaW1nJykubGVuZ3RoO1xuICAgICAgICByZXR1cm4ge29rOiBuID49IDEsIGRldGFpbDogJ2ltZyBjaGlwcz0nK259O2AsIDZfMDAwKTtcbiAgICAgIGlmICghY2hpcFswXSkgcmV0dXJuIGNoaXA7XG4gICAgICBhd2FpdCB0eXBlSW50bygnLmNvbXBvc2VyIHRleHRhcmVhJywgJ1x1NzcwQlx1OEZEOVx1NUYyMFx1NTZGRScpO1xuICAgICAgYXdhaXQgc2xlZXAoMjAwKTtcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY29tcG9zZXIgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NTNEMVx1OTAwMSc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xuICAgICAgY29uc3QgZG9uZSA9IGF3YWl0IHdhaXRGb3IoJ2ltYWdlIHNlbnQnLCBgXG4gICAgICAgIHZhciBhcCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5hcHByb3ZhbC1jYXJkIGJ1dHRvbicpO1xuICAgICAgICBpZiAoYXAgJiYgYXAudGV4dENvbnRlbnQudHJpbSgpLmluZGV4T2YoJ1x1NjI3OVx1NTFDNicpPj0wKSBhcC5jbGljaygpO1xuICAgICAgICB2YXIgdHM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudHVybicpKTtcbiAgICAgICAgdmFyIGhpdCA9IHRzLmZpbHRlcihmdW5jdGlvbih4KXsgcmV0dXJuIHguY2xhc3NOYW1lLmluZGV4T2YoJ3VzZXInKTwwICYmIHgudGV4dENvbnRlbnQuaW5kZXhPZignW2ltYWdlczogMV0nKSA+PSAwOyB9KTtcbiAgICAgICAgcmV0dXJuIHtvazogaGl0Lmxlbmd0aCA+PSAxLCBkZXRhaWw6ICdydW50aW1lLWVjaG8td2l0aC1pbWFnZT0nK2hpdC5sZW5ndGh9O1xuICAgICAgYCwgMTVfMDAwKTtcbiAgICAgIGF3YWl0IHNob3QoJ3Bhc3RlZC1pbWFnZScpO1xuICAgICAgcmV0dXJuIGRvbmU7XG4gICAgfSk7XG5cbiAgICAvKiA9PT09PT09PT09IGZha2U6XHVEODNEXHVEQ0NFIFx1NEUwQVx1NEYyMC9cdUQ4M0RcdURDQzEgXHU2RDRGXHU4OUM4XHU2MzA5XHU5NEFFXHU1QzMxXHU0RjREID09PT09PT09PT0gKi9cbiAgICBhd2FpdCBzdGVwKCdcdTk2NDRcdTRFRjZcdTRFMEVcdTc2RUVcdTVGNTVcdTUxNjVcdTUzRTM6XHVEODNEXHVEQ0NFIFx1NEUwQVx1NEYyMCArIFx1RDgzRFx1RENDMSBcdTZENEZcdTg5QzhcdTYzMDlcdTk0QUVcdTVCNThcdTU3MjgnLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKGAoZnVuY3Rpb24oKXtcbiAgICAgICAgdmFyIHVwID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNvbXBvc2VyIGJ1dHRvblthcmlhLWxhYmVsKj1cIlx1NEUwQVx1NEYyMFwiXSwgLmNvbXBvc2VyIGJ1dHRvblthcmlhLWxhYmVsKj1cIlVwbG9hZFwiXScpO1xuICAgICAgICB2YXIgYnIgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtcGlja2VyIGJ1dHRvbicpO1xuICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe3VwOiAhIXVwLCBicm93c2U6ICEhYnJ9KTtcbiAgICAgIH0pKClgKSkgYXMgc3RyaW5nO1xuICAgICAgY29uc3QgcCA9IEpTT04ucGFyc2UocikgYXMgeyB1cDogYm9vbGVhbjsgYnJvd3NlOiBib29sZWFuIH07XG4gICAgICByZXR1cm4gW3AudXAgJiYgcC5icm93c2UsIGBcdUQ4M0RcdURDQ0U9JHtwLnVwfSBcdUQ4M0RcdURDQzE9JHtwLmJyb3dzZX1gXTtcbiAgICB9KTtcblxuICAgIC8qID09PT09PT09PT0gZmFrZTpAIFx1OTY0NFx1NEVGNlx1OTAwOVx1NjJFOVx1NTY2OCA9PT09PT09PT09ICovXG4gICAgYXdhaXQgc3RlcCgnQCBcdTk2NDRcdTRFRjY6XHU5MDA5XHU2MkU5XHU1NjY4XHU1MUZBXHU3M0IwXHU1RTc2XHU1M0VGXHU5MDA5XHU2NTg3XHU0RUY2JywgYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jb21wb3NlciBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nQCc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2F0dCBwaWNrZXInLCBgdmFyIHA9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmF0dC1waWNrZXInKTtcbiAgICAgICAgcmV0dXJuIHtvazogISFwLCBkZXRhaWw6IHAgPyAnb3BlbicgOiAnbm90IG9wZW4nfTtgLCA1XzAwMCk7XG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xuICAgICAgYXdhaXQgdHlwZUludG8oJy5hdHQtcGlja2VyIGlucHV0JywgJ3JlYWQnKTtcbiAgICAgIGNvbnN0IHcyID0gYXdhaXQgd2FpdEZvcignYXR0IHJlc3VsdHMnLCBgdmFyIHI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmF0dC1yZXN1bHRzIC5mcy1yb3cnKS5sZW5ndGg7XG4gICAgICAgIHJldHVybiB7b2s6IHIgPj0gMSwgZGV0YWlsOiAncmVzdWx0cz0nK3J9O2AsIDZfMDAwKTtcbiAgICAgIGlmICghdzJbMF0pIHJldHVybiB3MjtcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGY9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmF0dC1yZXN1bHRzIC5mcy1yb3cnKTsgaWYoZikgZi5jbGljaygpOyB9KSgpYCk7XG4gICAgICByZXR1cm4gd2FpdEZvcignYXR0IGNoaXAnLCBgdmFyIGM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmF0dC1jaGlwJykubGVuZ3RoO1xuICAgICAgICByZXR1cm4ge29rOiBjID49IDEsIGRldGFpbDogJ2NoaXBzPScrY307YCwgNV8wMDApO1xuICAgIH0pO1xuXG4gICAgLyogPT09PT09PT09PSBmYWtlKFx1NTQxMVx1NUJGQ1x1Njc4NFx1OTAyMCk6XHU4QkJFXHU3RjZFXHUzMDBDXHU5MUNEXHU2NUIwXHU5MTREXHU3RjZFXHUzMDBEXHU5MUNEXHU1MTY1ICsgXHU5MDA5XHU2MkU5XHU2MzAxXHU0RTQ1ID09PT09PT09PT0gKi9cbiAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfV0laQVJEID09PSAnZmFrZScpIHtcbiAgICAgIGF3YWl0IHN0ZXAoJ1x1NTQxMVx1NUJGQzpcdThCQkVcdTdGNkVcdTMwMENcdTkxQ0RcdTY1QjBcdTkxNERcdTdGNkVcdTMwMERcdTkxQ0RcdTUxNjUgKyBcdTkwMDlcdTYyRTlcdTYzMDFcdTRFNDUod2l6YXJkLmpzb24pJywgYXN5bmMgKCkgPT4ge1xuICAgICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidwJywgY3RybEtleTp0cnVlLCBzaGlmdEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcbiAgICAgICAgY29uc3Qgb3BlbiA9IGF3YWl0IHdhaXRGb3IoJ3NldHRpbmdzIG9wZW4nLCBgdmFyIHM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNtZGsuc2V0dGluZ3MnKTtcbiAgICAgICAgICByZXR1cm4ge29rOiAhIXMsIGRldGFpbDogcyA/ICdvcGVuJyA6ICdjbG9zZWQnfTtgLCA1XzAwMCk7XG4gICAgICAgIGlmICghb3BlblswXSkgcmV0dXJuIG9wZW47XG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY21kay5zZXR0aW5ncyBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTkxQ0RcdTY1QjBcdTkxNERcdTdGNkUnKT49MDt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XG4gICAgICAgIGNvbnN0IHNob3duID0gYXdhaXQgd2FpdEZvcignd2l6YXJkIHJlb3BlbmVkJywgYHJldHVybiB7b2s6ICEhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1vdmVybGF5JyksXG4gICAgICAgICAgZGV0YWlsOiBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKSA/ICdvcGVuJyA6ICdjbG9zZWQnfTtgLCA1XzAwMCk7XG4gICAgICAgIGlmICghc2hvd25bMF0pIHJldHVybiBzaG93bjtcbiAgICAgICAgYXdhaXQgc2hvdCgnd2l6YXJkLXJlZW50cnknKTtcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1M0Q2XHU2RDg4Jzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XG4gICAgICAgIGNvbnN0IGNsb3NlZCA9IGF3YWl0IHdhaXRGb3IoJ3dpemFyZCBjbG9zZWQnLCBgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3ZlcmxheScpLCBkZXRhaWw6ICdjbG9zZWQnfTtgLCA1XzAwMCk7XG4gICAgICAgIGNvbnN0IHN0ID0gKGF3YWl0IGpzKGB3aW5kb3cuaG1oLmdldFdpemFyZCgpLnRoZW4oZnVuY3Rpb24ocil7cmV0dXJuIEpTT04uc3RyaW5naWZ5KHIpO30pYCkpIGFzIHN0cmluZztcbiAgICAgICAgY29uc3QgcCA9IEpTT04ucGFyc2Uoc3QpIGFzIHsgcGVyc2lzdGVkPzogeyBkb25lPzogYm9vbGVhbjsgY2hvaWNlPzogc3RyaW5nIH0gfTtcbiAgICAgICAgY29uc3QgcGVyc2lzdGVkID0gcC5wZXJzaXN0ZWQ/LmRvbmUgPT09IHRydWUgJiYgcC5wZXJzaXN0ZWQ/LmNob2ljZSA9PT0gJ2J1bmRsZWQnO1xuICAgICAgICByZXR1cm4gW2Nsb3NlZFswXSAmJiBwZXJzaXN0ZWQsIGBjbG9zZWQ9JHtjbG9zZWRbMF19IHBlcnNpc3RlZD0ke0pTT04uc3RyaW5naWZ5KHAucGVyc2lzdGVkID8/IG51bGwpfWBdO1xuICAgICAgfSk7XG4gICAgfVxuXG4gICAgYXdhaXQgc2hvdCgnZmluYWwnKTtcbiAgfSBlbHNlIGlmICgocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfV0laQVJEID8/ICcnKSAhPT0gJycpIHtcbiAgICAvKiA9PT09PT09PT09IHJlYWwoXHU1NDExXHU1QkZDXHU2Nzg0XHU5MDIwLFx1NEU5Mlx1NjVBNVx1NEU4RVx1NUUzOFx1ODlDNCByZWFsIFx1NkI2NVx1OUFBNCk6XG4gICAgICAgV1oyIFx1NjcyQ1x1NjczQVx1NzcxRlx1NUI5RVx1NjhDMFx1NkQ0QihcdTlFRDhcdThCQTRcdTUxNzFcdTRFQUJcdTk4NzUpLyBXWjMgXHU0RTBCXHU4RjdEXHU1Qjg5XHU4OEM1XHU1QjlFXHU2RDRCID09PT09PT09PT0gKi9cbiAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfV0laQVJEID09PSAnZGV0ZWN0Jykge1xuICAgICAgYXdhaXQgc3RlcCgnXHU1NDExXHU1QkZDKFx1NzcxRlx1NUI5RSk6XHU2QjIyXHU4RkNFXHUyMTkyXHU2OEMwXHU2RDRCXHU1MjMwXHU2NzJDXHU2NzNBXHU1REYyXHU4OEM1IENMSShcdTlFRDhcdThCQTRcdTUxNzFcdTRFQUIsXHU1MkZFXHU5MDA5XHU2QjYzXHU3ODZFKScsIGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3dpemFyZCBvdmVybGF5JywgYHZhciBvPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3ZlcmxheScpO1xuICAgICAgICAgIHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTVGMDBcdTU5Q0JcdTkxNERcdTdGNkUnO30pO1xuICAgICAgICAgIHJldHVybiB7b2s6ICEhbyAmJiAhIWIsIGRldGFpbDogbyA/ICdvdmVybGF5K1x1NUYwMFx1NTlDQlx1OTE0RFx1N0Y2RScgOiAnbm8gb3ZlcmxheSd9O2AsIDEyXzAwMCk7XG4gICAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XG4gICAgICAgIGF3YWl0IHNob3QoJ3dpemFyZC1yZWFsLXdlbGNvbWUnKTtcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1RjAwXHU1OUNCXHU5MTREXHU3RjZFJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XG4gICAgICAgIGNvbnN0IGZvdW5kID0gYXdhaXQgd2FpdEZvcignZGV0ZWN0IGZvdW5kJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1kZXRlY3QnKTtcbiAgICAgICAgICBpZighcCkgcmV0dXJuIHtvazpmYWxzZSwgZGV0YWlsOidkZXRlY3QgcGFnZSBub3Qgc2hvd24nfTtcbiAgICAgICAgICB2YXIgdD1wLnRleHRDb250ZW50O1xuICAgICAgICAgIHZhciBvazE9dC5pbmRleE9mKCdcdTY4QzBcdTZENEJcdTUyMzBcdTVERjJcdTVCODlcdTg4QzUgaG1oYXJuZXNzIHYnKT49MDtcbiAgICAgICAgICB2YXIgb2syPXQuaW5kZXhPZignXHU5RUQ4XHU4QkE0XHU1MTcxXHU0RUFCXHU0RjdGXHU3NTI4XHU1QjgzKFx1NjNBOFx1ODM1MCknKT49MDtcbiAgICAgICAgICB2YXIgcmFkaW89cC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW9wdC5vbicpO1xuICAgICAgICAgIHJldHVybiB7b2s6IG9rMSYmb2syJiYhIXJhZGlvLCBkZXRhaWw6IHQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDkwKX07YCwgMjBfMDAwKTtcbiAgICAgICAgYXdhaXQgc2hvdCgnd2l6YXJkLXJlYWwtZGV0ZWN0Jyk7XG4gICAgICAgIHJldHVybiBmb3VuZDtcbiAgICAgIH0pO1xuICAgIH0gZWxzZSBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfV0laQVJEID09PSAnaW5zdGFsbCcpIHtcbiAgICAgIGF3YWl0IHN0ZXAoJ1x1NTQxMVx1NUJGQyhcdTc3MUZcdTVCOUUpOlx1NjhDMFx1NkQ0Qlx1MjE5Mlx1NEVDRFx1ODk4MVx1NEUwQlx1OEY3RFx1NjVCMFx1NzI0OFx1MjE5Mlx1OTAwOVx1NjJFOVx1MjQ2MFx1MjE5Mlx1OEZEQlx1NTE2NVx1NUI4OVx1ODhDNVx1OTg3NScsIGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3dpemFyZCBvdmVybGF5JywgYHZhciBvPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3ZlcmxheScpO1xuICAgICAgICAgIHJldHVybiB7b2s6ICEhbywgZGV0YWlsOiBvID8gJ29wZW4nIDogJ2Nsb3NlZCd9O2AsIDEyXzAwMCk7XG4gICAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NUYwMFx1NTlDQlx1OTE0RFx1N0Y2RSc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xuICAgICAgICBjb25zdCBmb3VuZCA9IGF3YWl0IHdhaXRGb3IoJ2RldGVjdCBmb3VuZCcsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtZGV0ZWN0Jyk7XG4gICAgICAgICAgcmV0dXJuIHtvazogISFwICYmIHAudGV4dENvbnRlbnQuaW5kZXhPZignXHU2OEMwXHU2RDRCXHU1MjMwXHU1REYyXHU1Qjg5XHU4OEM1IGhtaGFybmVzcyB2Jyk+PTAsIGRldGFpbDogcCA/IHAudGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDYwKSA6ICdubyBkZXRlY3QgcGFnZSd9O2AsIDIwXzAwMCk7XG4gICAgICAgIGlmICghZm91bmRbMF0pIHJldHVybiBmb3VuZDtcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgbz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3B0JykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU0RUNEXHU4OTgxXHU0RTBCXHU4RjdEXHU2NUIwXHU3MjQ4Jyk+PTA7fSk7IGlmKG8pIG8uY2xpY2soKTsgfSkoKWApO1xuICAgICAgICBhd2FpdCBzbGVlcCgyMDApO1xuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTRFMEJcdTRFMDBcdTZCNjUnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcbiAgICAgICAgY29uc3Qgc2VsID0gYXdhaXQgd2FpdEZvcignc2VsZWN0IHBhZ2UgXHUyNDYwIG9uJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1zZWxlY3QnKTtcbiAgICAgICAgICB2YXIgb249cD9wLnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3B0Lm9uJyk6bnVsbDtcbiAgICAgICAgICByZXR1cm4ge29rOiAhIXAgJiYgISFvbiAmJiBvbi50ZXh0Q29udGVudC5pbmRleE9mKCdcdTRFMEJcdThGN0RcdTVCODlcdTg4QzVcdTVCOENcdTY1NzQgaG1oIENMSScpPj0wLCBkZXRhaWw6IHAgPyAnc2VsZWN0IFx1MjQ2MCBvbicgOiAnbm8gc2VsZWN0J307YCwgOF8wMDApO1xuICAgICAgICBpZiAoIXNlbFswXSkgcmV0dXJuIHNlbDtcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1RjAwXHU1OUNCXHU1Qjg5XHU4OEM1Jzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XG4gICAgICAgIHJldHVybiB3YWl0Rm9yKCdpbnN0YWxsIHBhZ2UnLCBgdmFyIHA9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLWluc3RhbGwnKTtcbiAgICAgICAgICByZXR1cm4ge29rOiAhIXAsIGRldGFpbDogcCA/ICdpbnN0YWxsaW5nJyA6ICdub3Qgc2hvd24nfTtgLCA4XzAwMCk7XG4gICAgICB9KTtcbiAgICAgIGF3YWl0IHN0ZXAoJ1x1NTQxMVx1NUJGQyhcdTc3MUZcdTVCOUUpOlx1NUI4OVx1ODhDNVx1OEZEQlx1NUVBNlx1NTNFRlx1ODlDMShcdTZCNjVcdTlBQTRcdTY1ODdcdTY4NDgvXHU0RTBCXHU4RjdEXHU3NjdFXHU1MjA2XHU2QkQ0XHU2RURBXHU1MkE4KScsIGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3Byb2dyZXNzIHZpc2libGUnLCBgdmFyIGJhcj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLXByb2dyZXNzJyk7XG4gICAgICAgICAgdmFyIGxvZz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWluc3RhbGwtbG9nJyk7XG4gICAgICAgICAgdmFyIGxpbmVzPWxvZz9sb2cudGV4dENvbnRlbnQuc3BsaXQoJ1xcXFxuJykuZmlsdGVyKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRyaW0oKSE9PScnO30pOltdO1xuICAgICAgICAgIHJldHVybiB7b2s6ICEhYmFyICYmIGxpbmVzLmxlbmd0aD49MSwgZGV0YWlsOiAnYmFyPScrKGJhcj8neSc6J24nKSsnIGxpbmVzPScrbGluZXMubGVuZ3RoKyhsaW5lcy5sZW5ndGg+MD8oJyBsYXN0PScrKGxpbmVzW2xpbmVzLmxlbmd0aC0xXXx8JycpLnNsaWNlKDAsNTApKTonJyl9O2AsIDYwXzAwMCk7XG4gICAgICAgIGF3YWl0IHNob3QoJ3dpemFyZC1yZWFsLWluc3RhbGwnKTtcbiAgICAgICAgcmV0dXJuIHc7XG4gICAgICB9KTtcbiAgICAgIGF3YWl0IHN0ZXAoJ1x1NTQxMVx1NUJGQyhcdTc3MUZcdTVCOUUpOlx1NUI4OVx1ODhDNVx1NUI4Q1x1NjIxMFx1MjE5Mlx1OTE0RFx1N0Y2RVx1OERGM1x1OEZDNyhcdTVERjJcdTY3MDlcdTVCQzZcdTk0QTUpXHUyMTkyXHU1QjhDXHU2MjEwXHU5ODc1XHUyMTkyXHU1RjAwXHU1OUNCXHU0RjdGXHU3NTI4XHUyMTkyXHU2NUIwIHJ1bnRpbWUgXHU4RkRFXHU2M0E1JywgYXN5bmMgKCkgPT4ge1xuICAgICAgICAvLyBcdTVCODlcdTg4QzVcdTUxNjhcdTdBMEIobnBtIFx1ODlFM1x1Njc5MCtcdTRFMEJcdThGN0QrXHU4NDNEXHU3NkQ4O1x1OTU1Q1x1NTBDRiBucG1taXJyb3IgXHU5MDFBXHU1RTM4IDwyIFx1NTIwNlx1OTQ5RiksXHU0RTBBXHU5NjUwIDggXHU1MjA2XHU5NDlGXG4gICAgICAgIGF3YWl0IHdhaXRGb3IoJ2RvbmUgcGFnZScsIGB2YXIgZD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtZG9uZScpO1xuICAgICAgICAgIGlmKGQpIHJldHVybiB7b2s6dHJ1ZSwgZGV0YWlsOidkb25lJ307XG4gICAgICAgICAgdmFyIGM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLWNvbmZpZycpO1xuICAgICAgICAgIGlmKGMpeyB2YXIgcz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdcdThERjNcdThGQzcnKT49MDt9KTsgaWYocykgcy5jbGljaygpOyB9XG4gICAgICAgICAgdmFyIGVycj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWVycm9yJyk7XG4gICAgICAgICAgaWYoZXJyKSByZXR1cm4ge29rOmZhbHNlLCBkZXRhaWw6J2luc3RhbGwgZXJyb3I6ICcrZXJyLnRleHRDb250ZW50LnNsaWNlKDAsODApfTtcbiAgICAgICAgICByZXR1cm4ge29rOmZhbHNlLCBkZXRhaWw6J2luc3RhbGxpbmdcdTIwMjYnfTtgLCA4ICogNjBfMDAwKTtcbiAgICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2RvbmUgcmVhZHkgdGV4dCcsIGB2YXIgZD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtZG9uZScpO1xuICAgICAgICAgIHZhciB0PWQ/ZC50ZXh0Q29udGVudDonJztcbiAgICAgICAgICByZXR1cm4ge29rOiAhIWQgJiYgdC5pbmRleE9mKCdcdTVDMzFcdTdFRUEnKT49MCwgZGV0YWlsOiB0LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw2MCl9O2AsIDEwXzAwMCk7XG4gICAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XG4gICAgICAgIGF3YWl0IHNob3QoJ3dpemFyZC1yZWFsLWRvbmUnKTtcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1RjAwXHU1OUNCXHU0RjdGXHU3NTI4Jzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XG4gICAgICAgIGNvbnN0IGNvbm5lY3RlZCA9IGF3YWl0IHdhaXRGb3IoJ25ldyBydW50aW1lIGNvbm5lY3RlZCcsIGB2YXIgZG90PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ob3N0LWRvdC5vbicpO1xuICAgICAgICAgIHZhciBsPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ob3N0LWxhYmVsJyk7XG4gICAgICAgICAgcmV0dXJuIHtvazogISFkb3QgJiYgISFsICYmIGwudGV4dENvbnRlbnQuaW5kZXhPZigncnVudGltZScpPj0wLCBkZXRhaWw6ICdkb3Q9JysoZG90Pydvbic6J29mZicpKycgbGFiZWw9JysobD9sLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw1MCk6J25vbmUnKX07YCwgNjBfMDAwKTtcbiAgICAgICAgY29uc3Qgc3QgPSAoYXdhaXQganMoYHdpbmRvdy5obWguZ2V0U3RhdGUoKS50aGVuKGZ1bmN0aW9uKHIpe3JldHVybiBKU09OLnN0cmluZ2lmeSh7bW9kZTpyLm1vZGUsIHJ1bnRpbWVFbnRyeTpyLnJ1bnRpbWVFbnRyeX0pO30pYCkpIGFzIHN0cmluZztcbiAgICAgICAgY29uc3QgcCA9IEpTT04ucGFyc2Uoc3QpIGFzIHsgbW9kZT86IHN0cmluZzsgcnVudGltZUVudHJ5Pzogc3RyaW5nIHwgbnVsbCB9O1xuICAgICAgICBjb25zdCBlbnRyeU9rID0gKHAucnVudGltZUVudHJ5ID8/ICcnKS5pbmRleE9mKCcuaG1oYXJuZXNzLWdsb2JhbCcpID49IDA7XG4gICAgICAgIGF3YWl0IHNob3QoJ3dpemFyZC1yZWFsLWZpbmFsJyk7XG4gICAgICAgIHJldHVybiBbY29ubmVjdGVkWzBdICYmIGVudHJ5T2ssIGBjb25uZWN0ZWQ6ICR7Y29ubmVjdGVkWzFdfTsgc3RhdGU9JHtzdC5zbGljZSgwLCA5MCl9YF07XG4gICAgICB9KTtcbiAgICB9XG4gICAgYXdhaXQgc2hvdCgnZmluYWwnKTtcbiAgfSBlbHNlIHtcbiAgICAvKiA9PT09PT09PT09IHJlYWw6XHU1M0VBXHU4QkZCXHU1QjUwXHU5NkM2KFx1NEUwRFx1NTJBOFx1NzcxRlx1NUI5RVx1NEYxQVx1OEJERCkgPT09PT09PT09PSAqL1xuICAgIGF3YWl0IHN0ZXAoJ1x1OTg3Nlx1NjgwRjpydW50aW1lIFx1NzI0OFx1NjcyQ1x1NEUwRVx1N0FFRlx1NTNFM1x1NURGMlx1NjYzRVx1NzkzQShcdTk3NUUgPyknLCBhc3luYyAoKSA9PiB7XG4gICAgICByZXR1cm4gd2FpdEZvcignaG9zdCBsYWJlbCcsIGB2YXIgbD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuaG9zdC1sYWJlbCcpO1xuICAgICAgICB2YXIgdCA9IGwgPyBsLnRleHRDb250ZW50IDogJyc7XG4gICAgICAgIHJldHVybiB7b2s6IHQuaW5kZXhPZignPycpIDwgMCAmJiB0LmluZGV4T2YoJ3J1bnRpbWUnKSA+PSAwLCBkZXRhaWw6IHQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDYwKX07YCwgMTVfMDAwKTtcbiAgICB9KTtcbiAgICBhd2FpdCBzdGVwKCdcdTRGMUFcdThCRERcdTUyMTdcdTg4Njg6XHU3NzFGXHU1QjlFXHU1Mzg2XHU1M0YyXHU1MkEwXHU4RjdEKFx1NjU3MFx1OTFDRj4wKScsIGFzeW5jICgpID0+IHtcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdzZXNzaW9ucycsIGB2YXIgbj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoO1xuICAgICAgICByZXR1cm4ge29rOiBuID4gMCwgZGV0YWlsOiAnc2Vzc2lvbnM9JytufTtgLCAxNV8wMDApO1xuICAgIH0pO1xuICAgIGF3YWl0IHN0ZXAoJ1x1NzBCOVx1NTFGQlx1NTM4Nlx1NTNGMlx1NEYxQVx1OEJERCBcdTIxOTIgXHU3NzFGXHU1QjlFIHRyYW5zY3JpcHQgXHU1MTg1XHU1QkI5XHU1M0VGXHU4OUMxJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgbiA9IChhd2FpdCBqcyhgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aGApKSBhcyBudW1iZXI7XG4gICAgICBpZiAobiA9PT0gMCkgcmV0dXJuIFtmYWxzZSwgJ25vIHNlc3Npb25zIHRvIGNsaWNrJ107XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBpdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2Vzc2lvbi1pdGVtJyk7IGlmIChpdCkgaXQuY2xpY2soKTsgfSkoKWApO1xuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2hpc3RvcnkgdHVybnMnLCBgdmFyIHRzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnR1cm4nKSk7XG4gICAgICAgIHJldHVybiB7b2s6IHRzLmxlbmd0aCA+PSAxLCBkZXRhaWw6ICd0dXJucz0nK3RzLmxlbmd0aCsnIGZpcnN0PScrKHRzWzBdP3RzWzBdLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw0MCk6J25vbmUnKX07YCwgMTVfMDAwKTtcbiAgICAgIGF3YWl0IHNob3QoJ3JlYWwtaGlzdG9yeScpO1xuICAgICAgcmV0dXJuIHc7XG4gICAgfSk7XG4gICAgYXdhaXQgc3RlcCgnRG9jazpPdmVydmlldyBcdTc3MUZcdTVCOUVcdTY1NzBcdTYzNkUocnVudGltZSBcdTcyNDhcdTY3MkNcdTk3NUVcdTY1RTBcdTY1NzBcdTYzNkUpJywgYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J092ZXJ2aWV3Jzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XG4gICAgICByZXR1cm4gd2FpdEZvcignb3ZlcnZpZXcnLCBgdmFyIHJvd3M9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay1yb3cnKSk7XG4gICAgICAgIHZhciB2ZXIgPSByb3dzLmZpbmQoZnVuY3Rpb24ocil7IHJldHVybiByLnRleHRDb250ZW50LmluZGV4T2YoJ3J1bnRpbWUgXHU3MjQ4XHU2NzJDJyk+PTA7IH0pO1xuICAgICAgICByZXR1cm4ge29rOiAhIXZlciAmJiB2ZXIudGV4dENvbnRlbnQuaW5kZXhPZignXHU2NUUwXHU2NTcwXHU2MzZFJykgPCAwLCBkZXRhaWw6IHZlciA/IHZlci50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNTApIDogJ25vIHZlciByb3cnfTtgLCAxMF8wMDApO1xuICAgIH0pO1xuICAgIGF3YWl0IHN0ZXAoJ0RvY2s6RGlmZiBcdTc3MUZcdTVCOUUgZ2l0IFx1NzJCNlx1NjAwMShcdTk3NUVcdTUyQTBcdThGN0RcdTRFMkQpJywgYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J1x1NTNEOFx1NjZGNCd8fHgudGV4dENvbnRlbnQ9PT0nRGlmZic7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2RpZmYnLCBgdmFyIHA9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmRpZmYtcGFuZScpO1xuICAgICAgICB2YXIgdCA9IHAgPyBwLnRleHRDb250ZW50IDogJyc7XG4gICAgICAgIHJldHVybiB7b2s6ICEhcCAmJiB0LmluZGV4T2YoJ1x1NTJBMFx1OEY3RFx1NEUyRCcpIDwgMCwgZGV0YWlsOiB0LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw2MCl9O2AsIDE1XzAwMCk7XG4gICAgfSk7XG4gICAgYXdhaXQgc3RlcCgnRG9jazpFdmlkZW5jZSBcdTc3MUZcdTVCOUVcdThCQTRcdTc3RTVcdTY1NzBcdTYzNkUnLCBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nXHU4QkMxXHU2MzZFJ3x8eC50ZXh0Q29udGVudD09PSdFdmlkZW5jZSc7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2V2aWRlbmNlJywgYHZhciByb3dzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stcm93JykpO1xuICAgICAgICB2YXIgbWVtID0gcm93cy5maW5kKGZ1bmN0aW9uKHIpeyByZXR1cm4gci50ZXh0Q29udGVudC5pbmRleE9mKCdcdThCQjBcdTVGQzZcdTVDNDInKT49MCB8fCByLnRleHRDb250ZW50LmluZGV4T2YoJ01lbW9yeSBsYXllcnMnKT49MDsgfSk7XG4gICAgICAgIHJldHVybiB7b2s6ICEhbWVtICYmIG1lbS50ZXh0Q29udGVudC5pbmRleE9mKCdcdTIwMjYnKSA8IDAsIGRldGFpbDogbWVtID8gbWVtLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw1MCkgOiAnbm8gcm93J307YCwgMTVfMDAwKTtcbiAgICB9KTtcbiAgICBhd2FpdCBzdGVwKCdcdTk2NDRcdTRFRjZcdTRFMEVcdTc2RUVcdTVGNTVcdTUxNjVcdTUzRTM6XHVEODNEXHVEQ0NFIFx1NEUwQVx1NEYyMCArIFx1OTg3Nlx1NjgwRlx1NEUyRC9FTiArIFx1RDgzRFx1RENDMSBcdTZENEZcdTg5QzhcdTYzMDlcdTk0QUVcdTVCNThcdTU3MjgnLCBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nXHU2NTg3XHU0RUY2J3x8eC50ZXh0Q29udGVudD09PSdGaWxlcyc7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xuICAgICAgYXdhaXQgd2FpdEZvcignZmlsZXMgdGFiJywgYHZhciB0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5kb2NrLXRhYi5hY3RpdmUnKTtcbiAgICAgICAgcmV0dXJuIHtvazogISF0ICYmICh0LnRleHRDb250ZW50PT09J1x1NjU4N1x1NEVGNid8fHQudGV4dENvbnRlbnQ9PT0nRmlsZXMnKSwgZGV0YWlsOiAnYWN0aXZlPScrKHQ/dC50ZXh0Q29udGVudDonbm9uZScpfTtgLCA1XzAwMCk7XG4gICAgICAvLyByZWFsIFx1NkEyMVx1NUYwRiB3b3Jrc3BhY2VzIFx1OEJGN1x1NkM0Mlx1OEQ3MCBydW50aW1lKFx1NTFCN1x1NTQyRlx1NTJBOFx1NTQwRVx1NTNFRlx1ODBGRFx1NjM5Mlx1OTYxRiksXHU2NTNFXHU1QkJEXHU1MjMwIDE1c1xuICAgICAgY29uc3Qgd3MgPSBhd2FpdCB3YWl0Rm9yKCd3cyBwaWNrZXInLCBgdmFyIHc9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLXBpY2tlcicpO1xuICAgICAgICByZXR1cm4ge29rOiAhIXcsIGRldGFpbDogdyA/ICdsb2FkZWQnIDogJ3dvcmtzcGFjZXMgbm90IGxvYWRlZCB5ZXQnfTtgLCBtb2RlID09PSAncmVhbCcgPyAxNV8wMDAgOiA2XzAwMCk7XG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKGAoZnVuY3Rpb24oKXtcbiAgICAgICAgdmFyIHVwID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNvbXBvc2VyIGJ1dHRvblthcmlhLWxhYmVsKj1cIlx1NEUwQVx1NEYyMFwiXSwgLmNvbXBvc2VyIGJ1dHRvblthcmlhLWxhYmVsKj1cIlVwbG9hZFwiXScpO1xuICAgICAgICB2YXIgbGFuZyA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5sYW5nLXNlZycpO1xuICAgICAgICB2YXIgYnIgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtcGlja2VyIGJ1dHRvbicpO1xuICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe3VwOiAhIXVwLCBsYW5nOiAhIWxhbmcsIGJyb3dzZTogISFicn0pO1xuICAgICAgfSkoKWApKSBhcyBzdHJpbmc7XG4gICAgICBjb25zdCBwID0gSlNPTi5wYXJzZShyKSBhcyB7IHVwOiBib29sZWFuOyBsYW5nOiBib29sZWFuOyBicm93c2U6IGJvb2xlYW4gfTtcbiAgICAgIHJldHVybiBbcC51cCAmJiBwLmxhbmcgJiYgcC5icm93c2UsIGBcdUQ4M0RcdURDQ0U9JHtwLnVwfSBcdTRFMkQvRU49JHtwLmxhbmd9IFx1RDgzRFx1RENDMT0ke3AuYnJvd3NlfTsgJHt3c1sxXX1gXTtcbiAgICB9KTtcbiAgICAvKiA9PT09PT09PT09IHJlYWw6XHU3NzFGXHU1QjlFXHU0RUZCXHU1MkExXHU3QUVGXHU1MjMwXHU3QUVGXHU5OTk2XHU5QThDKFx1NTNEMVx1NzdFRFx1NEVGQlx1NTJBMVx1MjE5Mlx1NkEyMVx1NTc4Qlx1NTZERVx1NTkwRCkgPT09PT09PT09PVxuICAgICAgIFx1NzUyOFx1NjIzNyBnbG0tNS4zIFx1NURGMlx1OTE0RFx1N0Y2RTtcdTYzRDBcdTc5M0FcdThCQ0RcdTdFQTZcdTY3NUZcdTc2RjRcdTYzQTVcdTU2REVcdTU5MERcdTMwMDJcdTgyRTUgYWdlbnQgXHU4QkY3XHU2QzQyXHU1QkExXHU2Mjc5LFx1OEY2RVx1OEJFMlx1OTFDQ1xuICAgICAgIFx1ODFFQVx1NTJBOFx1NzBCOVx1NjI3OVx1NTFDNihcdTY3MDBcdTU5MUFcdTg5QzFcdTUzNjFcdTUzNzNcdTcwQjksXHU1RTQyXHU3QjQ5KVx1MzAwMlx1OEQ4NVx1NjVGNiAxNTBzXHUzMDAyICovXG4gICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX1JFQUxfVEFTSyA9PT0gJzEnKSB7XG4gICAgICBhd2FpdCBzdGVwKCdcdTc3MUZcdTVCOUVcdTRFRkJcdTUyQTE6XHU1M0QxXHU5MDAxXHUyMTkyXHU2QTIxXHU1NzhCXHU1NkRFXHU1OTBEKFx1N0FFRlx1NTIzMFx1N0FFRlx1OTk5Nlx1OUE4QyknLCBhc3luYyAoKSA9PiB7XG4gICAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J24nLCBjdHJsS2V5OnRydWUsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xuICAgICAgICBhd2FpdCBzbGVlcCg0MDApO1xuICAgICAgICBhd2FpdCB0eXBlSW50bygnLmNvbXBvc2VyIHRleHRhcmVhJywgJ1x1OEJGN1x1NTNFQVx1NTZERVx1NTkwRFx1NEUyNFx1NEUyQVx1NUI1NzpcdTY1MzZcdTUyMzAoXHU2NzJDXHU2QjIxXHU5QThDXHU2NTM2XHU0RUZCXHU1MkExLFx1NEUwRFx1ODk4MVx1NEY3Rlx1NzUyOFx1NEVGQlx1NEY1NVx1NURFNVx1NTE3NyxcdTc2RjRcdTYzQTVcdTU2REVcdTU5MEQpJyk7XG4gICAgICAgIGF3YWl0IHNsZWVwKDIwMCk7XG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY29tcG9zZXIgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NTNEMVx1OTAwMSc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xuICAgICAgICBjb25zdCBzZW50ID0gYXdhaXQgd2FpdEZvcigndXNlciB0dXJuJywgYHZhciB0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy50dXJuLnVzZXInKTtcbiAgICAgICAgICB2YXIgcyA9ICh0ICYmIHQudGV4dENvbnRlbnQpID8gU3RyaW5nKHQudGV4dENvbnRlbnQpIDogJyc7XG4gICAgICAgICAgcmV0dXJuIHtvazogcy5pbmRleE9mKCdcdTY1MzZcdTUyMzAnKT49MCB8fCBzLmluZGV4T2YoJ1x1OUE4Q1x1NjUzNlx1NEVGQlx1NTJBMScpPj0wLCBkZXRhaWw6IHMuc2xpY2UoMCwzMCkgfHwgJ25vbmUnfTtgLCAxMF8wMDApO1xuICAgICAgICBpZiAoIXNlbnRbMF0pIHJldHVybiBzZW50O1xuICAgICAgICBjb25zdCByZXBseSA9IGF3YWl0IHdhaXRGb3IoJ2Fzc2lzdGFudCByZXBseScsIGBcbiAgICAgICAgICB2YXIgYXAgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuYXBwcm92YWwtY2FyZCBidXR0b24nKTtcbiAgICAgICAgICBpZiAoYXAgJiYgYXAudGV4dENvbnRlbnQudHJpbSgpLmluZGV4T2YoJ1x1NjI3OVx1NTFDNicpPj0wKSBhcC5jbGljaygpO1xuICAgICAgICAgIHZhciB0cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50dXJuJykpLmZpbHRlcihmdW5jdGlvbih4KXsgcmV0dXJuIHguY2xhc3NOYW1lLmluZGV4T2YoJ3VzZXInKTwwICYmIHguY2xhc3NOYW1lLmluZGV4T2YoJ2FwcHJvdmFsJyk8MCAmJiB4LmNsYXNzTmFtZS5pbmRleE9mKCdzeXN0ZW0nKTwwICYmIHgudGV4dENvbnRlbnQudHJpbSgpLmxlbmd0aD4wICYmIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU1NkRFXHU1NDA4Jyk8MDsgfSk7XG4gICAgICAgICAgdmFyIHN1bSA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy50dXJuLXN1bScpO1xuICAgICAgICAgIHJldHVybiB7b2s6IHRzLmxlbmd0aD49MSAmJiAhIXN1bSwgZGV0YWlsOiAnYXNzaXN0YW50PScrdHMubGVuZ3RoKycgc3VtPScrKHN1bT9zdW0udGV4dENvbnRlbnQ6J25vbmUnKSsnIGZpcnN0PScrKHRzWzBdP3RzWzBdLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw0MCk6J25vbmUnKX07XG4gICAgICAgIGAsIDE1MF8wMDApO1xuICAgICAgICBhd2FpdCBzaG90KCdyZWFsLXRhc2snKTtcbiAgICAgICAgcmV0dXJuIHJlcGx5O1xuICAgICAgfSk7XG4gICAgfVxuICAgIGF3YWl0IHN0ZXAoJ1x1NEYxQVx1OEJERFx1NTIwNlx1N0VDNDpcdTVERTZcdTY4MEZcdTYzMDlcdTVERTVcdTRGNUNcdTUzM0FcdTUyMDZcdTdFQzQoXHU3RUM0XHU1OTM0XHU1M0VGXHU4OUMxKScsIGFzeW5jICgpID0+IHtcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdncm91cCBoZWFkJywgYHZhciBoPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1ncm91cC1oZWFkJyk7XG4gICAgICAgIHZhciBuID0gaCA/IChoLnF1ZXJ5U2VsZWN0b3IoJy53cy1ncm91cC1uYW1lJyl8fHt9KS50ZXh0Q29udGVudCA6ICcnO1xuICAgICAgICByZXR1cm4ge29rOiAhIWggJiYgbi5sZW5ndGggPiAwLCBkZXRhaWw6ICduYW1lPScrbn07YCwgMTVfMDAwKTtcbiAgICB9KTtcbiAgICBhd2FpdCBzdGVwKCdcdTVERTVcdTRGNUNcdTUzM0E6XHU1REU2XHU2ODBGXHU1REU1XHU0RjVDXHU1MzNBXHU2ODBGXHU1M0VGXHU4OUMxKFx1NzcxRlx1NUI5RVx1NURFNVx1NEY1Q1x1NTMzQVx1NTQwRCknLCBhc3luYyAoKSA9PiB7XG4gICAgICByZXR1cm4gd2FpdEZvcignd29ya3NwYWNlIGJhcicsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud29ya3NwYWNlLWJhcicpO1xuICAgICAgICB2YXIgbiA9IGIgPyAoYi5xdWVyeVNlbGVjdG9yKCcud3MtYmFyLW5hbWUnKXx8e30pLnRleHRDb250ZW50IDogJyc7XG4gICAgICAgIHJldHVybiB7b2s6ICEhYiAmJiAhIW4gJiYgbi5sZW5ndGggPiAwICYmIG4uaW5kZXhPZignXHU1MkEwXHU4RjdEJykgPCAwICYmIG4uaW5kZXhPZignTG9hZGluZycpIDwgMCwgZGV0YWlsOiAnbmFtZT0nK259O2AsIDE1XzAwMCk7XG4gICAgfSk7XG4gICAgYXdhaXQgc2hvdCgnZmluYWwnKTtcbiAgfVxuXG4gIGNvbnN0IGZhaWxlZCA9IHJlc3VsdHMuZmlsdGVyKChyKSA9PiAhclsxXSkubGVuZ3RoO1xuICBjb25zb2xlLmxvZyhgVUlWRVJJRlkgU1VNTUFSWSBwYXNzPSR7cmVzdWx0cy5sZW5ndGggLSBmYWlsZWR9LyR7cmVzdWx0cy5sZW5ndGh9IG1vZGU9JHttb2RlfSBzaG90cz0ke3Nob3RzfWApO1xuICBhcHAuZXhpdChmYWlsZWQgPT09IDAgPyAwIDogMSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhdHRhY2hVaVZlcmlmeSh3aW46IEJyb3dzZXJXaW5kb3cpOiB2b2lkIHtcbiAgY29uc3QgbW9kZSA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX01PREUgPT09ICdyZWFsJyA/ICdyZWFsJyA6ICdmYWtlJztcbiAgd2luLndlYkNvbnRlbnRzLm9uY2UoJ2RpZC1maW5pc2gtbG9hZCcsICgpID0+IHtcbiAgICAvLyBcdTdFRDkgaG9zdCBcdTU0MkZcdTUyQThcdTc1NTlcdTY1RjZcdTk1RjQ7XHU2QjY1XHU5QUE0XHU1MTg1XHU5MEU4XHU1NDA0XHU4MUVBXHU4RjZFXHU4QkUyXHU3QjQ5XHU1Rjg1XG4gICAgc2V0VGltZW91dCgoKSA9PiB7IHZvaWQgcnVuVWlWZXJpZnkod2luLCBtb2RlKTsgfSwgM18wMDApO1xuICB9KTtcbn1cbiIsICIvKipcbiAqIHY1LjEgXHU1Qjg5XHU4OEM1XHU1NDExXHU1QkZDIFx1MDBCNyBAaG1oYXJuZXNzL2NsaSBcdTVCODlcdTg4QzVcdTdGMTZcdTYzOTIoXHU0RTNCXHU4RkRCXHU3QTBCKVx1MzAwMlxuICpcbiAqIFx1NEUyNFx1Njc2MVx1OERFRlx1NUY4NChcdTYzRDBcdTc5M0FcdThCQ0QgdjUuMSBcdTU0MDhcdTU0MEMpOlxuICogIC0gbnBtIFx1NTNFRlx1NzUyOChcdTlFRDhcdThCQTQpOmBucG0gaW5zdGFsbCAtLXByZWZpeCAlVVNFUlBST0ZJTEUlXFwuaG1oYXJuZXNzLWdsb2JhbFxuICogICAgQGhtaGFybmVzcy9jbGlgIFx1MjAxNFx1MjAxNCBcdTUzRUFcdTUxOTlcdTc1MjhcdTYyMzdcdTc2RUVcdTVGNTUsXHU0RTBEXHU3OEIwXHU3Q0ZCXHU3RURGL25wbSBcdTUxNjhcdTVDNDA7bnBtIFx1ODFFQVx1NUUyNlx1NEY5RFx1OEQ1Nlx1ODlFM1x1Njc5MCxcbiAqICAgIFx1OEZEQlx1NUVBNlx1OEY2Q1x1NTNEMVx1NTE3Nlx1OEY5M1x1NTFGQVx1ODg0QyhcdTVCODlcdTg4QzVcdTZCNjVcdTlBQTRcdTY1ODdcdTY4NDgpXHUzMDAyXG4gKiAgLSBcdTY1RTAgbnBtKFx1NjIxNlx1NjYzRVx1NUYwRlx1NUYzQVx1NTIzNik6XHU4MUVBXHU3ODE0IHRneiBcdTVCODlcdTg4QzVcdTU2NjggXHUyMDE0XHUyMDE0IFx1NEY5RFx1OEQ1Nlx1OTVFRFx1NTMwNVx1Njc2NVx1ODFFQVxuICogICAgQGhtaC1kZXNrdG9wL2NsaS1pbnN0YWxsZXIoXHU3RUFGXHU5MDNCXHU4RjkxLFx1NURGMlx1NTM1NVx1NkQ0QiksdGFyYmFsbCBcdTkwMTBcdTUzMDVcdTZENDFcdTVGMEZcdTRFMEJcdThGN0RcbiAqICAgIChcdTc3MUZcdTVCNTdcdTgyODJcdThGREJcdTVFQTYgKyByZWdpc3RyeS5ucG1qcy5vcmdcdTIxOTJyZWdpc3RyeS5ucG1taXJyb3IuY29tIFx1OTU1Q1x1NTBDRlx1NTZERVx1OTAwMCxcbiAqICAgIFx1NTkwRFx1NzUyOCB2NCBcdTY2RjRcdTY1QjBcdTU2NjhcdTU2REVcdTkwMDBcdTYwMURcdTYwRjMgKyBpbnRlZ3JpdHkgXHU2ODIxXHU5QThDKSxcdTdDRkJcdTdFREYgdGFyLmV4ZSBcdTg5RTNcdTUzOEJcdTUyMzBcbiAqICAgIG5vZGVfbW9kdWxlcyBcdTYyNDFcdTVFNzNcdTVFMDNcdTVDNDBcdTMwMDJcbiAqIFx1OEZEQlx1NUVBNlx1NEUwMFx1NUY4Qlx1N0VDRiBpbnN0YWxsOnByb2dyZXNzIFx1NEU4Qlx1NEVGNlx1NjNBOCByZW5kZXJlcjtcdTYyMTBcdTUyOUZcdTU2REVcdThDMDMgb25JbnN0YWxsZWQoZW50cnkpXG4gKiBcdTc1MzEgbWFpbiBcdTYzMDFcdTRFNDVcdTUzMTYgcnVudGltZS5qc29uIFx1NUU3Nlx1NzBFRFx1OTFDRFx1NTQyRiBob3N0XHUzMDAyXG4gKi9cbmltcG9ydCB7IHNwYXduIH0gZnJvbSAnbm9kZTpjaGlsZF9wcm9jZXNzJztcbmltcG9ydCB7IGV4aXN0c1N5bmMsIG1rZGlyU3luYywgcm1TeW5jLCByZW5hbWVTeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSAnbm9kZTpmcyc7XG5pbXBvcnQgeyBob21lZGlyIH0gZnJvbSAnbm9kZTpvcyc7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSAnbm9kZTpwYXRoJztcbmltcG9ydCB7IGJ5dGVzTGFiZWwsIGludGVncml0eU9rLCBtb2R1bGVEaXIsIHJlc29sdmVDbG9zdXJlLCB0YXJiYWxsTWlycm9ycywgdHlwZSBQYWNrdW1lbnQsIHR5cGUgUmVzb2x2ZWRQa2cgfSBmcm9tICdAaG1oLWRlc2t0b3AvY2xpLWluc3RhbGxlcic7XG5cbmV4cG9ydCBpbnRlcmZhY2UgSW5zdGFsbFByb2dyZXNzIHtcbiAgcGhhc2U6ICdjaGVjaycgfCAnbWV0YScgfCAnZG93bmxvYWQnIHwgJ2V4dHJhY3QnIHwgJ25wbScgfCAnZG9uZScgfCAnZXJyb3InO1xuICBwY3Q/OiBudW1iZXI7XG4gIHRleHQ6IHN0cmluZztcbiAgbWlycm9yPzogc3RyaW5nO1xuICBlbnRyeT86IHN0cmluZztcbiAgZXJyb3I/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgSW5zdGFsbE9wdGlvbnMge1xuICAvKiogXHU1RjNBXHU1MjM2XHU4RDcwXHU4MUVBXHU3ODE0IHRneiBcdThERUZcdTVGODQoXHU2RDRCXHU4QkQ1L1x1NjVFMCBucG0gXHU3M0FGXHU1ODgzKVx1MzAwMiAqL1xuICBmb3JjZVRnej86IGJvb2xlYW4gfCB1bmRlZmluZWQ7XG4gIC8qKiBcdTk1NUNcdTUwQ0ZcdTRGMThcdTUxNDhcdTdFQTcoXHU2MzYyXHU2RTkwXHU2MzA5XHU5NEFFXHU3RkZCXHU4RjZDKVx1MzAwMiAqL1xuICBtaXJyb3JGaXJzdD86ICducG1qcycgfCAnbnBtbWlycm9yJyB8IHVuZGVmaW5lZDtcbn1cblxuZXhwb3J0IGNvbnN0IFJFR0lTVFJJRVM6IFJlY29yZDwnbnBtanMnIHwgJ25wbW1pcnJvcicsIHN0cmluZz4gPSB7XG4gIG5wbWpzOiAnaHR0cHM6Ly9yZWdpc3RyeS5ucG1qcy5vcmcnLFxuICBucG1taXJyb3I6ICdodHRwczovL3JlZ2lzdHJ5Lm5wbW1pcnJvci5jb20nLFxufTtcblxuLyoqIFx1NUI4OVx1ODhDNVx1NjgzOVx1NzZFRVx1NUY1NShcdTc1MjhcdTYyMzdcdTc2RUVcdTVGNTUsXHU3RUREXHU0RTBEXHU1MTk5XHU3Q0ZCXHU3RURGL1x1NTE2OFx1NUM0MCBucG0pXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gaW5zdGFsbFRhcmdldCgpOiBzdHJpbmcge1xuICByZXR1cm4gam9pbihob21lZGlyKCksICcuaG1oYXJuZXNzLWdsb2JhbCcpO1xufVxuXG4vKiogXHU1Qjg5XHU4OEM1XHU1QjhDXHU2MjEwXHU1NDBFXHU3Njg0IGRlc2t0b3AtaG9zdCBcdTUxNjVcdTUzRTMobnBtIFx1NUQ0Q1x1NTk1N1x1NEUwRVx1NjNEMFx1NTM0N1x1NEUyNFx1NzlDRFx1NUUwM1x1NUM0MFx1OTBGRFx1OEJBNClcdTMwMDIgKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlSW5zdGFsbGVkRW50cnkodGFyZ2V0OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBuZXN0ZWQgPSBqb2luKHRhcmdldCwgJ25vZGVfbW9kdWxlcycsICdAaG1oYXJuZXNzJywgJ2NsaScsICdub2RlX21vZHVsZXMnLCAnQGhtaGFybmVzcycsICd3ZWInLCAnZGlzdCcsICdkZXNrdG9wLWhvc3QuanMnKTtcbiAgY29uc3QgaG9pc3RlZCA9IGpvaW4odGFyZ2V0LCAnbm9kZV9tb2R1bGVzJywgJ0BobWhhcm5lc3MnLCAnd2ViJywgJ2Rpc3QnLCAnZGVza3RvcC1ob3N0LmpzJyk7XG4gIGlmIChleGlzdHNTeW5jKG5lc3RlZCkpIHJldHVybiBuZXN0ZWQ7XG4gIGlmIChleGlzdHNTeW5jKGhvaXN0ZWQpKSByZXR1cm4gaG9pc3RlZDtcbiAgcmV0dXJuICcnO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEluc3RhbGxlckhvc3Qge1xuICBzZW5kUHJvZ3Jlc3MocDogSW5zdGFsbFByb2dyZXNzKTogdm9pZDtcbiAgbG9nKG1zZzogc3RyaW5nKTogdm9pZDtcbiAgLyoqIFx1NUI4OVx1ODhDNVx1NjIxMFx1NTI5RihcdTUxNjVcdTUzRTNcdTVERjJcdTlBOENcdThCQzFcdTVCNThcdTU3MjgpXHUyMDE0XHUyMDE0IG1haW4gXHU1NzI4XHU2QjY0XHU2MzAxXHU0RTQ1XHU1MzE2XHU1RTc2XHU5MUNEXHU1NDJGIGhvc3RcdTMwMDIgKi9cbiAgb25JbnN0YWxsZWQoZW50cnk6IHN0cmluZywgdmlhOiAnbnBtJyB8ICd0Z3onKTogdm9pZDtcbn1cblxubGV0IHJ1bm5pbmcgPSBmYWxzZTtcblxuZXhwb3J0IGZ1bmN0aW9uIGluc3RhbGxSdW5uaW5nKCk6IGJvb2xlYW4ge1xuICByZXR1cm4gcnVubmluZztcbn1cblxuLyoqIFx1NTQyRlx1NTJBOFx1NUI4OVx1ODhDNShcdTU0MEVcdTUzRjBcdTYyNjdcdTg4NEM7XHU4RkRCXHU1RUE2L1x1N0VEM1x1Njc5Q1x1NTE2OFx1OTBFOFx1N0VDRlx1NEU4Qlx1NEVGNlx1NTZERVx1NkQ0MSxQcm9taXNlIFx1NTNFQVx1ODg2OFx1OEZCRVwiXHU1REYyXHU1M0Q3XHU3NDA2XCIpXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gc3RhcnRDbGlJbnN0YWxsKGhvc3Q6IEluc3RhbGxlckhvc3QsIG9wdHM6IEluc3RhbGxPcHRpb25zID0ge30pOiB7IG9rOiBib29sZWFuOyBlcnJvcj86IHN0cmluZyB9IHtcbiAgaWYgKHJ1bm5pbmcpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICdcdTVCODlcdTg4QzVcdTVERjJcdTU3MjhcdThGREJcdTg4NENcdTRFMkQnIH07XG4gIHJ1bm5pbmcgPSB0cnVlO1xuICBjb25zdCBmaW5pc2ggPSAocDogSW5zdGFsbFByb2dyZXNzKTogdm9pZCA9PiB7XG4gICAgaG9zdC5zZW5kUHJvZ3Jlc3MocCk7XG4gICAgcnVubmluZyA9IGZhbHNlO1xuICB9O1xuICBjb25zdCBmYWlsID0gKHRleHQ6IHN0cmluZywgZXJyOiB1bmtub3duKTogdm9pZCA9PiB7XG4gICAgaG9zdC5sb2coYGluc3RhbGwgZmFpbGVkOiAke3RleHR9ICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTgwKX1gKTtcbiAgICBmaW5pc2goeyBwaGFzZTogJ2Vycm9yJywgdGV4dCwgZXJyb3I6IGAke3RleHR9OiR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTYwKX1gIH0pO1xuICB9O1xuICB2b2lkIChhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgdGFyZ2V0ID0gaW5zdGFsbFRhcmdldCgpO1xuICAgIHRyeSB7XG4gICAgICBta2RpclN5bmModGFyZ2V0LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIGNvbnN0IG5wbU9rID0gb3B0cy5mb3JjZVRneiA9PT0gdHJ1ZSA/IGZhbHNlIDogYXdhaXQgcHJvYmVOcG0oaG9zdCk7XG4gICAgICBpZiAobnBtT2spIGF3YWl0IGluc3RhbGxWaWFOcG0oaG9zdCwgdGFyZ2V0LCBvcHRzKTtcbiAgICAgIGVsc2UgYXdhaXQgaW5zdGFsbFZpYVRhcmJhbGxzKGhvc3QsIHRhcmdldCwgb3B0cyk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBmYWlsKCdcdTVCODlcdTg4QzVcdTU5MzFcdThEMjUnLCBlcnIpO1xuICAgIH1cbiAgfSkoKTtcbiAgcmV0dXJuIHsgb2s6IHRydWUgfTtcbn1cblxuLyogLS0tLSBucG0gXHU1M0VGXHU3NTI4XHU2MDI3KFx1NkNFOFx1NjEwRjpXaW5kb3dzIFx1NEUwQiBzcGF3bignbnBtJykgXHU1M0VGXHU4ODRDLCducG0uY21kJyBcdTUzQ0RcdTgwMEMgRUlOVkFMKSAtLS0tICovXG5hc3luYyBmdW5jdGlvbiBwcm9iZU5wbShob3N0OiBJbnN0YWxsZXJIb3N0KTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGhvc3Quc2VuZFByb2dyZXNzKHsgcGhhc2U6ICdjaGVjaycsIHRleHQ6ICdcdTY4QzBcdTY3RTUgbnBtXHUyMDI2JyB9KTtcbiAgY29uc3Qgb2sgPSBhd2FpdCBuZXcgUHJvbWlzZTxib29sZWFuPigocmVzb2x2ZSkgPT4ge1xuICAgIGNvbnN0IGMgPSBzcGF3bignbnBtJywgWyctLXZlcnNpb24nXSwgeyB3aW5kb3dzSGlkZTogdHJ1ZSwgc3RkaW86ICdpZ25vcmUnIH0pO1xuICAgIGNvbnN0IHQgPSBzZXRUaW1lb3V0KCgpID0+IHsgdHJ5IHsgYy5raWxsKCk7IH0gY2F0Y2ggeyAvKiBub29wICovIH0gcmVzb2x2ZShmYWxzZSk7IH0sIDE1XzAwMCk7XG4gICAgYy5vbignZXJyb3InLCAoKSA9PiB7IGNsZWFyVGltZW91dCh0KTsgcmVzb2x2ZShmYWxzZSk7IH0pO1xuICAgIGMub24oJ2V4aXQnLCAoY29kZSkgPT4geyBjbGVhclRpbWVvdXQodCk7IHJlc29sdmUoY29kZSA9PT0gMCk7IH0pO1xuICB9KTtcbiAgaG9zdC5sb2coYG5wbSAke29rID8gJ2F2YWlsYWJsZScgOiAndW5hdmFpbGFibGUnfSBcdTIxOTIgJHtvayA/ICducG0gcHJlZml4JyA6ICd0Z3onfSBwYXRoYCk7XG4gIHJldHVybiBvaztcbn1cblxuLyogLS0tLSBcdThERUZcdTVGODQgQTpucG0gLS1wcmVmaXgoXHU1Qjg5XHU4OEM1XHU2QjY1XHU5QUE0XHU2NTg3XHU2ODQ4ID0gbnBtIFx1OEY5M1x1NTFGQVx1ODg0QykgLS0tLSAqL1xuYXN5bmMgZnVuY3Rpb24gaW5zdGFsbFZpYU5wbShob3N0OiBJbnN0YWxsZXJIb3N0LCB0YXJnZXQ6IHN0cmluZywgb3B0czogSW5zdGFsbE9wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgaG9zdC5zZW5kUHJvZ3Jlc3MoeyBwaGFzZTogJ25wbScsIHRleHQ6IGBucG0gaW5zdGFsbCBAaG1oYXJuZXNzL2NsaSBcdTIxOTIgJHt0YXJnZXR9KFx1NEVDNVx1NzUyOFx1NjIzN1x1NzZFRVx1NUY1NSlgIH0pO1xuICBjb25zdCByZWdpc3RyeSA9IG9wdHMubWlycm9yRmlyc3QgPT09ICducG1taXJyb3InID8gWyctLXJlZ2lzdHJ5JywgUkVHSVNUUklFUy5ucG1taXJyb3JdIDogb3B0cy5taXJyb3JGaXJzdCA9PT0gJ25wbWpzJyA/IFsnLS1yZWdpc3RyeScsIFJFR0lTVFJJRVMubnBtanNdIDogW107XG4gIGNvbnN0IGFyZ3MgPSBbJ2luc3RhbGwnLCAnLS1wcmVmaXgnLCB0YXJnZXQsICctLW5vLWF1ZGl0JywgJy0tbm8tZnVuZCcsICctLWxvZ2xldmVsJywgJ25vdGljZScsIC4uLnJlZ2lzdHJ5LCAnQGhtaGFybmVzcy9jbGlAbGF0ZXN0J107XG4gIGNvbnN0IGNvZGUgPSBhd2FpdCBuZXcgUHJvbWlzZTxudW1iZXI+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICBjb25zdCBjID0gc3Bhd24oJ25wbScsIGFyZ3MsIHsgd2luZG93c0hpZGU6IHRydWUsIGN3ZDogaG9tZWRpcigpIH0pO1xuICAgIGxldCBsYXN0ID0gJyc7XG4gICAgY29uc3Qgb25MaW5lID0gKGQ6IEJ1ZmZlcik6IHZvaWQgPT4ge1xuICAgICAgZm9yIChjb25zdCByYXcgb2YgZC50b1N0cmluZygpLnNwbGl0KC9cXHI/XFxuLykpIHtcbiAgICAgICAgY29uc3QgbGluZSA9IHJhdy5yZXBsYWNlKC9bXFx1MDAwMC1cXHUwMDFmXS9nLCAnJykudHJpbSgpLnNsaWNlKDAsIDE4MCk7XG4gICAgICAgIGlmIChsaW5lID09PSAnJyB8fCBsaW5lID09PSBsYXN0KSBjb250aW51ZTtcbiAgICAgICAgbGFzdCA9IGxpbmU7XG4gICAgICAgIGhvc3Quc2VuZFByb2dyZXNzKHsgcGhhc2U6ICducG0nLCB0ZXh0OiBsaW5lIH0pO1xuICAgICAgfVxuICAgIH07XG4gICAgYy5zdGRvdXQ/Lm9uKCdkYXRhJywgb25MaW5lKTtcbiAgICBjLnN0ZGVycj8ub24oJ2RhdGEnLCBvbkxpbmUpO1xuICAgIGMub24oJ2Vycm9yJywgcmVqZWN0KTtcbiAgICBjb25zdCBraWxsZXIgPSBzZXRUaW1lb3V0KCgpID0+IHsgdHJ5IHsgYy5raWxsKCk7IH0gY2F0Y2ggeyAvKiBub29wICovIH0gcmVqZWN0KG5ldyBFcnJvcignbnBtIFx1NUI4OVx1ODhDNVx1OEQ4NVx1NjVGNig4IFx1NTIwNlx1OTQ5RiknKSk7IH0sIDggKiA2MF8wMDApO1xuICAgIGMub24oJ2V4aXQnLCAoeCkgPT4geyBjbGVhclRpbWVvdXQoa2lsbGVyKTsgcmVzb2x2ZSh4ID8/IDEpOyB9KTtcbiAgfSk7XG4gIGlmIChjb2RlICE9PSAwKSB0aHJvdyBuZXcgRXJyb3IoYG5wbSBpbnN0YWxsIFx1OTAwMFx1NTFGQVx1NzgwMSAke2NvZGV9YCk7XG4gIGNvbnN0IGVudHJ5ID0gcmVzb2x2ZUluc3RhbGxlZEVudHJ5KHRhcmdldCk7XG4gIGlmIChlbnRyeSA9PT0gJycpIHRocm93IG5ldyBFcnJvcignbnBtIFx1NUI4OVx1ODhDNVx1NUI4Q1x1NjIxMFx1NEY0Nlx1NjcyQVx1NjI3RVx1NTIzMCBkZXNrdG9wLWhvc3QgXHU1MTY1XHU1M0UzJyk7XG4gIHdyaXRlU3RhbXAodGFyZ2V0LCAnbnBtJyk7XG4gIGZpbmlzaEluc3RhbGwoaG9zdCwgZW50cnksICducG0nKTtcbn1cblxuLyogLS0tLSBcdThERUZcdTVGODQgQjpcdTgxRUFcdTc4MTQgdGd6KFx1NzcxRlx1NEUwQlx1OEY3RFx1OEZEQlx1NUVBNiArIFx1OTU1Q1x1NTBDRlx1NTZERVx1OTAwMCArIGludGVncml0eSArIHRhciBcdTg5RTNcdTUzOEIpIC0tLS0gKi9cbmFzeW5jIGZ1bmN0aW9uIGluc3RhbGxWaWFUYXJiYWxscyhob3N0OiBJbnN0YWxsZXJIb3N0LCB0YXJnZXQ6IHN0cmluZywgb3B0czogSW5zdGFsbE9wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3Qgb3JkZXI6IEFycmF5PCducG1qcycgfCAnbnBtbWlycm9yJz4gPSBvcHRzLm1pcnJvckZpcnN0ID09PSAnbnBtbWlycm9yJyA/IFsnbnBtbWlycm9yJywgJ25wbWpzJ10gOiBbJ25wbWpzJywgJ25wbW1pcnJvciddO1xuICBjb25zdCBtaXJyb3JzID0gb3JkZXIubWFwKChrKSA9PiBSRUdJU1RSSUVTW2tdKTtcbiAgaG9zdC5zZW5kUHJvZ3Jlc3MoeyBwaGFzZTogJ21ldGEnLCB0ZXh0OiAnXHU4OUUzXHU2NzkwXHU0RjlEXHU4RDU2XHU2RTA1XHU1MzU1KEBobWhhcm5lc3MvY2xpIFx1NTE2OFx1NUJCNilcdTIwMjYnIH0pO1xuXG4gIGNvbnN0IHBhY2t1bWVudHMgPSBuZXcgTWFwPHN0cmluZywgUGFja3VtZW50PigpO1xuICBjb25zdCBnZXRQYWNrdW1lbnQgPSBhc3luYyAobmFtZTogc3RyaW5nKTogUHJvbWlzZTxQYWNrdW1lbnQ+ID0+IHtcbiAgICBjb25zdCBoaXQgPSBwYWNrdW1lbnRzLmdldChuYW1lKTtcbiAgICBpZiAoaGl0ICE9PSB1bmRlZmluZWQpIHJldHVybiBoaXQ7XG4gICAgbGV0IGxhc3RFcnIgPSAnJztcbiAgICBmb3IgKGNvbnN0IG0gb2YgbWlycm9ycykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgciA9IGF3YWl0IGZldGNoKGAke219LyR7ZW5jb2RlVVJJQ29tcG9uZW50KG5hbWUpfWAsIHtcbiAgICAgICAgICBoZWFkZXJzOiB7IGFjY2VwdDogJ2FwcGxpY2F0aW9uL3ZuZC5ucG0uaW5zdGFsbC12MStqc29uJyB9LFxuICAgICAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCgyNV8wMDApLFxuICAgICAgICB9KTtcbiAgICAgICAgaWYgKCFyLm9rKSB7IGxhc3RFcnIgPSBgSFRUUCAke3Iuc3RhdHVzfWA7IGNvbnRpbnVlOyB9XG4gICAgICAgIGNvbnN0IGRvYyA9IChhd2FpdCByLmpzb24oKSkgYXMgUGFja3VtZW50O1xuICAgICAgICBpZiAoZG9jLnZlcnNpb25zID09PSB1bmRlZmluZWQpIHsgbGFzdEVyciA9ICdtYWxmb3JtZWQgcGFja3VtZW50JzsgY29udGludWU7IH1cbiAgICAgICAgcGFja3VtZW50cy5zZXQobmFtZSwgZG9jKTtcbiAgICAgICAgcmV0dXJuIGRvYztcbiAgICAgIH0gY2F0Y2ggKGVycikgeyBsYXN0RXJyID0gU3RyaW5nKGVycikuc2xpY2UoMCwgNjApOyB9XG4gICAgfVxuICAgIHRocm93IG5ldyBFcnJvcihgXHU4M0I3XHU1M0Q2ICR7bmFtZX0gXHU1MTQzXHU2NTcwXHU2MzZFXHU1OTMxXHU4RDI1KFx1NTE2OFx1OTBFOFx1OTU1Q1x1NTBDRjoke2xhc3RFcnJ9KWApO1xuICB9O1xuXG4gIGNvbnN0IGNsb3N1cmUgPSBhd2FpdCByZXNvbHZlQ2xvc3VyZSh7IG5hbWU6ICdAaG1oYXJuZXNzL2NsaScsIHNwZWM6ICdsYXRlc3QnIH0sIGdldFBhY2t1bWVudCk7XG4gIGNvbnN0IHJvb3QgPSBjbG9zdXJlLmZpbmQoKHApID0+IHAubmFtZSA9PT0gJ0BobWhhcm5lc3MvY2xpJyk7XG4gIGhvc3QubG9nKGBjbG9zdXJlOiAke2Nsb3N1cmUubGVuZ3RofSBwYWNrYWdlcyAocm9vdCBAaG1oYXJuZXNzL2NsaUAke3Jvb3Q/LnZlcnNpb24gPz8gJz8nfSlgKTtcbiAgaG9zdC5zZW5kUHJvZ3Jlc3MoeyBwaGFzZTogJ21ldGEnLCB0ZXh0OiBgXHU0RjlEXHU4RDU2XHU2RTA1XHU1MzU1XHU1QzMxXHU3RUVBOiR7Y2xvc3VyZS5sZW5ndGh9IFx1NEUyQVx1NTMwNShAaG1oYXJuZXNzL2NsaUAke3Jvb3Q/LnZlcnNpb24gPz8gJz8nfSlgIH0pO1xuXG4gIGNvbnN0IHN0YWdpbmcgPSBqb2luKHRhcmdldCwgJy5zdGFnaW5nJyk7XG4gIHJtU3luYyhzdGFnaW5nLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIG1rZGlyU3luYyhzdGFnaW5nLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICBmb3IgKGxldCBpID0gMDsgaSA8IGNsb3N1cmUubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBwa2cgPSBjbG9zdXJlW2ldITtcbiAgICBjb25zdCB1cmxzID0gdGFyYmFsbE1pcnJvcnMocGtnLnRhcmJhbGwsIG1pcnJvcnMpO1xuICAgIGxldCBidWY6IEJ1ZmZlciB8IG51bGwgPSBudWxsO1xuICAgIGxldCB1c2VkTWlycm9yID0gJyc7XG4gICAgbGV0IGxhc3RFcnIgPSAnJztcbiAgICBmb3IgKGNvbnN0IHUgb2YgdXJscykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgciA9IGF3YWl0IGZldGNoKHUsIHsgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDMwMF8wMDApIH0pO1xuICAgICAgICBpZiAoIXIub2spIHsgbGFzdEVyciA9IGBIVFRQICR7ci5zdGF0dXN9YDsgY29udGludWU7IH1cbiAgICAgICAgY29uc3QgdG90YWwgPSBOdW1iZXIoci5oZWFkZXJzLmdldCgnY29udGVudC1sZW5ndGgnKSA/PyAnMCcpO1xuICAgICAgICBjb25zdCByZWFkZXIgPSByLmJvZHk/LmdldFJlYWRlcigpO1xuICAgICAgICBpZiAocmVhZGVyID09PSB1bmRlZmluZWQpIHRocm93IG5ldyBFcnJvcignbm8gYm9keScpO1xuICAgICAgICBjb25zdCBjaHVua3M6IEJ1ZmZlcltdID0gW107XG4gICAgICAgIGxldCBnb3QgPSAwO1xuICAgICAgICBsZXQgbGFzdEVtaXQgPSAwO1xuICAgICAgICBmb3IgKDs7KSB7XG4gICAgICAgICAgY29uc3QgeyBkb25lLCB2YWx1ZSB9ID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcbiAgICAgICAgICBpZiAoZG9uZSA9PT0gdHJ1ZSkgYnJlYWs7XG4gICAgICAgICAgY29uc3QgYiA9IEJ1ZmZlci5mcm9tKHZhbHVlKTtcbiAgICAgICAgICBjaHVua3MucHVzaChiKTtcbiAgICAgICAgICBnb3QgKz0gYi5sZW5ndGg7XG4gICAgICAgICAgaWYgKGdvdCAtIGxhc3RFbWl0ID4gMjU2ICogMTAyNCkge1xuICAgICAgICAgICAgbGFzdEVtaXQgPSBnb3Q7XG4gICAgICAgICAgICBob3N0LnNlbmRQcm9ncmVzcyh7XG4gICAgICAgICAgICAgIHBoYXNlOiAnZG93bmxvYWQnLFxuICAgICAgICAgICAgICBwY3Q6IE1hdGgucm91bmQoKChpICsgTWF0aC5taW4oZ290IC8gKHRvdGFsIHx8IGdvdCksIDEpKSAvIGNsb3N1cmUubGVuZ3RoKSAqIDEwMCksXG4gICAgICAgICAgICAgIHRleHQ6IGBcdTRFMEJcdThGN0QgJHtwa2cubmFtZX1AJHtwa2cudmVyc2lvbn0oJHtpICsgMX0vJHtjbG9zdXJlLmxlbmd0aH0pXHUwMEI3ICR7Ynl0ZXNMYWJlbChnb3QpfSR7dG90YWwgPiAwID8gYCAvICR7Ynl0ZXNMYWJlbCh0b3RhbCl9YCA6ICcnfWAsXG4gICAgICAgICAgICAgIG1pcnJvcjogbmV3IFVSTCh1KS5ob3N0LFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGJ1ZiA9IEJ1ZmZlci5jb25jYXQoY2h1bmtzKTtcbiAgICAgICAgaWYgKCFpbnRlZ3JpdHlPayhidWYsIHBrZy5pbnRlZ3JpdHkpKSB7IGxhc3RFcnIgPSAnaW50ZWdyaXR5IFx1NEUwRFx1NTMzOVx1OTE0RCc7IGJ1ZiA9IG51bGw7IGNvbnRpbnVlOyB9XG4gICAgICAgIHVzZWRNaXJyb3IgPSBuZXcgVVJMKHUpLmhvc3Q7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGxhc3RFcnIgPSBTdHJpbmcoZXJyKS5zbGljZSgwLCA2MCk7XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChidWYgPT09IG51bGwpIHRocm93IG5ldyBFcnJvcihgXHU0RTBCXHU4RjdEICR7cGtnLm5hbWV9IFx1NTkzMVx1OEQyNShcdTUxNjhcdTkwRThcdTk1NUNcdTUwQ0Y6JHtsYXN0RXJyfSlgKTtcbiAgICBjb25zdCB0Z3ogPSBqb2luKHN0YWdpbmcsIGAke2l9LnRnemApO1xuICAgIHdyaXRlRmlsZVN5bmModGd6LCBidWYpO1xuICAgIGhvc3Quc2VuZFByb2dyZXNzKHtcbiAgICAgIHBoYXNlOiAnZG93bmxvYWQnLFxuICAgICAgcGN0OiBNYXRoLnJvdW5kKCgoaSArIDEpIC8gY2xvc3VyZS5sZW5ndGgpICogMTAwKSxcbiAgICAgIHRleHQ6IGBcdTRFMEJcdThGN0QgJHtwa2cubmFtZX1AJHtwa2cudmVyc2lvbn0gXHU1QjhDXHU2MjEwKCR7Ynl0ZXNMYWJlbChidWYubGVuZ3RoKX0sdmlhICR7dXNlZE1pcnJvcn0pYCxcbiAgICAgIG1pcnJvcjogdXNlZE1pcnJvcixcbiAgICB9KTtcbiAgfVxuXG4gIGhvc3Quc2VuZFByb2dyZXNzKHsgcGhhc2U6ICdleHRyYWN0JywgdGV4dDogJ1x1ODlFM1x1NTM4Qlx1NUU3Nlx1NUUwM1x1NUM0MCBub2RlX21vZHVsZXNcdTIwMjYnIH0pO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGNsb3N1cmUubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBwa2cgPSBjbG9zdXJlW2ldITtcbiAgICBhd2FpdCBleHRyYWN0VGd6KGpvaW4oc3RhZ2luZywgYCR7aX0udGd6YCksIHN0YWdpbmcsIHBrZyk7XG4gICAgaG9zdC5zZW5kUHJvZ3Jlc3MoeyBwaGFzZTogJ2V4dHJhY3QnLCBwY3Q6IE1hdGgucm91bmQoKChpICsgMSkgLyBjbG9zdXJlLmxlbmd0aCkgKiAxMDApLCB0ZXh0OiBgXHU4OUUzXHU1MzhCICR7cGtnLm5hbWV9KCR7aSArIDF9LyR7Y2xvc3VyZS5sZW5ndGh9KWAgfSk7XG4gIH1cbiAgcm1TeW5jKHN0YWdpbmcsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcblxuICBjb25zdCBlbnRyeSA9IHJlc29sdmVJbnN0YWxsZWRFbnRyeSh0YXJnZXQpO1xuICBpZiAoZW50cnkgPT09ICcnKSB0aHJvdyBuZXcgRXJyb3IoJ3RneiBcdTVCODlcdTg4QzVcdTVCOENcdTYyMTBcdTRGNDZcdTY3MkFcdTYyN0VcdTUyMzAgZGVza3RvcC1ob3N0IFx1NTE2NVx1NTNFMycpO1xuICB3cml0ZVN0YW1wKHRhcmdldCwgJ3RneicpO1xuICBmaW5pc2hJbnN0YWxsKGhvc3QsIGVudHJ5LCAndGd6Jyk7XG59XG5cbi8qKiB0YXIuZXhlKFdpbjEwKyBcdTgxRUFcdTVFMjYpXHU4OUUzXHU1MzhCIHRneiBcdTUyMzAgZXhEaXIsXHU1MThEXHU2MjhBIHBhY2thZ2UvIFx1NjMyQVx1NTIzMCBub2RlX21vZHVsZXMgXHU1RTAzXHU1QzQwXHUzMDAyICovXG5hc3luYyBmdW5jdGlvbiBleHRyYWN0VGd6KHRnejogc3RyaW5nLCBzdGFnaW5nOiBzdHJpbmcsIHBrZzogUmVzb2x2ZWRQa2cpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgZXhEaXIgPSBqb2luKHN0YWdpbmcsIGB4LSR7cGtnLm5hbWUucmVwbGFjZSgvW15cXHcuLV0vZywgJ18nKX1gKTtcbiAgcm1TeW5jKGV4RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIG1rZGlyU3luYyhleERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGNvbnN0IGNvZGUgPSBhd2FpdCBuZXcgUHJvbWlzZTxudW1iZXI+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICBjb25zdCBjID0gc3Bhd24oJ3RhcicsIFsnLXh6ZicsIHRneiwgJy1DJywgZXhEaXJdLCB7IHdpbmRvd3NIaWRlOiB0cnVlLCBzdGRpbzogJ2lnbm9yZScgfSk7XG4gICAgYy5vbignZXJyb3InLCByZWplY3QpO1xuICAgIGMub24oJ2V4aXQnLCAoeCkgPT4gcmVzb2x2ZSh4ID8/IDEpKTtcbiAgfSk7XG4gIGlmIChjb2RlICE9PSAwKSB0aHJvdyBuZXcgRXJyb3IoYHRhciBcdTg5RTNcdTUzOEIgJHtwa2cubmFtZX0gXHU1OTMxXHU4RDI1KFx1OTAwMFx1NTFGQVx1NzgwMSAke2NvZGV9KWApO1xuICBjb25zdCBkZXN0ID0gbW9kdWxlRGlyKGluc3RhbGxUYXJnZXQoKSwgcGtnLm5hbWUpO1xuICBjb25zdCBwYXJlbnQgPSBkZXN0LnNsaWNlKDAsIGRlc3QubGFzdEluZGV4T2YoJ1xcXFwnKSk7XG4gIG1rZGlyU3luYyhwYXJlbnQsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBybVN5bmMoZGVzdCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICByZW5hbWVTeW5jKGpvaW4oZXhEaXIsICdwYWNrYWdlJyksIGRlc3QpO1xuICBybVN5bmMoZXhEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbn1cblxuLyoqIFx1NUI4OVx1ODhDNVx1NjIzMyhcdTU0MTFcdTVCRkNcdTVCOENcdTYyMTBcdTk4NzUvXHU4QkJFXHU3RjZFXHU5NzYyXHU2NzdGXHU1QzU1XHU3OTNBXHU1Qjg5XHU4OEM1XHU2NUI5XHU1RjBGXHU0RTBFXHU2NUY2XHU5NUY0O1x1NEUwRFx1NjI3Rlx1OEY3RFx1OEZEMFx1ODg0Q1x1NjVGNlx1OTAzQlx1OEY5MSlcdTMwMDIgKi9cbmZ1bmN0aW9uIHdyaXRlU3RhbXAodGFyZ2V0OiBzdHJpbmcsIHZpYTogJ25wbScgfCAndGd6Jyk6IHZvaWQge1xuICB0cnkge1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbih0YXJnZXQsICdpbnN0YWxsZWQtYnktaG1oLWRlc2t0b3AuanNvbicpLCBKU09OLnN0cmluZ2lmeSh7IHZpYSwgYXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSB9LCBudWxsLCAyKSwgJ3V0ZjgnKTtcbiAgfSBjYXRjaCB7IC8qIGJlc3QgZWZmb3J0ICovIH1cbn1cblxuZnVuY3Rpb24gZmluaXNoSW5zdGFsbChob3N0OiBJbnN0YWxsZXJIb3N0LCBlbnRyeTogc3RyaW5nLCB2aWE6ICducG0nIHwgJ3RneicpOiB2b2lkIHtcbiAgaG9zdC5sb2coYGluc3RhbGwgZG9uZSB2aWEgJHt2aWF9OiAke2VudHJ5fWApO1xuICBob3N0LnNlbmRQcm9ncmVzcyh7IHBoYXNlOiAnZG9uZScsIHRleHQ6IGBcdTVCODlcdTg4QzVcdTVCOENcdTYyMTAoJHt2aWF9KWAsIGVudHJ5IH0pO1xuICBob3N0Lm9uSW5zdGFsbGVkKGVudHJ5LCB2aWEpO1xuICBydW5uaW5nID0gZmFsc2U7XG59XG4iLCAiLyoqXG4gKiBAaG1oYXJuZXNzL2NsaSBcdTVCODlcdTg4QzVcdTY4MzhcdTVGQzMoXHU3RUFGXHU5MDNCXHU4RjkxLFx1OTZGNiBJTyBcdTIwMTRcdTIwMTQgZmV0Y2gvXHU4OUUzXHU1MzhCL1x1ODQzRFx1NzZEOFx1NTcyOFx1NEUzQlx1OEZEQlx1N0EwQiBpbnN0YWxsZXIgXHU5MUNDKVx1MzAwMlxuICpcbiAqIFx1ODA0Q1x1OEQyMyh2NS4xIFx1NUI4OVx1ODhDNVx1NTQxMVx1NUJGQyk6XHU3RUQ5XHU1QjlBIHJlZ2lzdHJ5IFx1NTE0M1x1NjU3MFx1NjM2RVx1ODNCN1x1NTNENlx1NTFGRFx1NjU3MCxcdTg5RTNcdTY3OTAgQGhtaGFybmVzcy9jbGkgXHU3Njg0XG4gKiBcdTVCOENcdTY1NzRcdTRGOURcdThENTZcdTk1RURcdTUzMDUoQGhtaGFybmVzcy8qIFx1NTE2OFx1NUJCNlx1NEUzQVx1N0NCRVx1Nzg2RVx1NzI0OFx1NjcyQ1x1NEU5Mlx1OTQ4OTtcdTU5MTZcdTkwRThcdTRGOURcdThENTYgcXJjb2RlIFx1OTRGRVx1NEUzQSBeIFx1ODMwM1x1NTZGNCksXG4gKiBcdTRFQTdcdTUxRkFcIlx1ODhDNVx1NEVDMFx1NEU0OFx1MzAwMVx1NEVDRVx1NTRFQVx1NEU5Qlx1OTU1Q1x1NTBDRlx1NEUwQlx1MzAwMVx1ODhDNVx1NTIzMFx1NTRFQVwiXHU3Njg0XHU3ODZFXHU1QjlBXHU2MDI3XHU4QkExXHU1MjEyXHUzMDAyXHU4QkJFXHU4QkExXHU3RUE2XHU2NzVGOlxuICogIC0gXHU5NUVEXHU1MzA1XHU2MzA5XHU1MzA1XHU1NDBEXHU1M0JCXHU5MUNEKFx1OTRCQlx1NzdGM1x1NEY5RFx1OEQ1Nlx1NTNFQVx1ODhDNVx1NEUwMFx1NEVGRCxucG0gXHU4QkVEXHU0RTQ5KTtcbiAqICAtIFx1ODMwM1x1NTZGNFx1ODlFM1x1Njc5MFx1NTNFQVx1NjUyRlx1NjMwMSBucG0gXHU3NTFGXHU2MDAxXHU1QjlFXHU5NjQ1XHU3NTI4XHU1MjMwXHU3Njg0XHU1RjYyXHU2MDAxOlx1N0NCRVx1Nzg2RSAvIGxhdGVzdCAvICogLyBeIC8gfiAvID49LFxuICogICAgXHU0RTBEXHU1RjE1IHNlbXZlciBcdTVFOTMoXHU5NkY2XHU0RjlEXHU4RDU2XHU1MzlGXHU1MjE5LFx1NEUwRVx1ODFFQVx1NzgxNFx1NjZGNFx1NjVCMFx1NTY2OFx1NEUwMFx1ODFGNCk7XG4gKiAgLSBvcHRpb25hbERlcGVuZGVuY2llcyBcdTRFMERcdTg4QzU6XHU5NUVEXHU1MzA1XHU1MTg1XHU1QjlFXHU5NjQ1XHU1OEYwXHU2NjBFXHU3Njg0IG9wdGlvbmFsIFx1NTc0N1x1NEUzQVx1NUU3M1x1NTNGMFx1NzI3OVx1NUI5QVxuICogICAgKGZzZXZlbnRzIFx1N0I0OSksdGd6IFx1OERFRlx1NUY4NFx1NEUwRFx1OEREMVx1NzUxRlx1NTQ3RFx1NTQ2OFx1NjcxRlx1ODExQVx1NjcyQyxcdTg4QzVcdTRFODZcdTRFNUZcdTUzRUFcdTY2MkZcdTZCN0JcdTkxQ0RcdTMwMDJcbiAqL1xuaW1wb3J0IHsgY3JlYXRlSGFzaCB9IGZyb20gJ25vZGU6Y3J5cHRvJztcblxuZXhwb3J0IGludGVyZmFjZSBQa2dWZXJzaW9uTWV0YSB7XG4gIHZlcnNpb246IHN0cmluZztcbiAgZGVwZW5kZW5jaWVzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuICB0YXJiYWxsOiBzdHJpbmc7XG4gIGludGVncml0eT86IHN0cmluZyB8IHVuZGVmaW5lZDtcbn1cblxuLyoqIHJlZ2lzdHJ5IHBhY2t1bWVudCBcdTc2ODRcdTY3MDBcdTVDMEZcdThCRkJcdTUzRDZcdTk3NjIoZGlzdC10YWdzICsgXHU1MTY4XHU3MjQ4XHU2NzJDXHU0RjlEXHU4RDU2L3RhcmJhbGwgXHU1MTQzXHU2NTcwXHU2MzZFKVx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBQYWNrdW1lbnQge1xuICAnZGlzdC10YWdzJzogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcbiAgdmVyc2lvbnM6IFJlY29yZDxzdHJpbmcsIHsgZGVwZW5kZW5jaWVzPzogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB8IHVuZGVmaW5lZDsgZGlzdD86IHsgdGFyYmFsbD86IHN0cmluZzsgaW50ZWdyaXR5Pzogc3RyaW5nIHwgdW5kZWZpbmVkIH0gfCB1bmRlZmluZWQgfT47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUmVzb2x2ZWRQa2cge1xuICBuYW1lOiBzdHJpbmc7XG4gIHZlcnNpb246IHN0cmluZztcbiAgLyoqIHJlZ2lzdHJ5IFx1NTM5Rlx1NTlDQlx1NTczMFx1NTc0MChcdTk1NUNcdTUwQ0ZcdTUyMTdcdTg4NjhcdTc1MzEgdGFyYmFsbE1pcnJvcnMgXHU2RDNFXHU3NTFGKVx1MzAwMiAqL1xuICB0YXJiYWxsOiBzdHJpbmc7XG4gIGludGVncml0eT86IHN0cmluZyB8IHVuZGVmaW5lZDtcbn1cblxuLyogLS0tLSBzZW12ZXIoXHU2NzAwXHU1QzBGXHU1QjlFXHU3M0IwOlx1OTVFRFx1NTMwNVx1NTE4NVx1NUI5RVx1OTY0NVx1NTFGQVx1NzNCMFx1NzY4NFx1NUY2Mlx1NjAwMSkgLS0tLSAqL1xuXG5leHBvcnQgZnVuY3Rpb24gY21wU2VtdmVyKGE6IHN0cmluZywgYjogc3RyaW5nKTogbnVtYmVyIHtcbiAgY29uc3QgcGEgPSBhLnJlcGxhY2UoL152LywgJycpLnNwbGl0KCctJylbMF0hLnNwbGl0KCcuJykubWFwKE51bWJlcik7XG4gIGNvbnN0IHBiID0gYi5yZXBsYWNlKC9edi8sICcnKS5zcGxpdCgnLScpWzBdIS5zcGxpdCgnLicpLm1hcChOdW1iZXIpO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IDM7IGkrKykge1xuICAgIGNvbnN0IHggPSBwYVtpXSA/PyAwO1xuICAgIGNvbnN0IHkgPSBwYltpXSA/PyAwO1xuICAgIGlmICh4ICE9PSB5KSByZXR1cm4geCA8IHkgPyAtMSA6IDE7XG4gIH1cbiAgcmV0dXJuIDA7XG59XG5cbi8qKiByYW5nZSBcdTY2MkZcdTU0MjZcdTYzQTVcdTUzRDcgdmVyc2lvbihcdTY1MkZcdTYzMDEgXHU3Q0JFXHU3ODZFIC8gbGF0ZXN0IC8gKiAvIHggLyBeIC8gfiAvID49O1x1NEUwRFx1OEJDNlx1NTIyQlx1NTIxOSBmYWxzZSlcdTMwMDIgKi9cbmV4cG9ydCBmdW5jdGlvbiBzYXRpc2ZpZXMocmFuZ2U6IHN0cmluZywgdmVyc2lvbjogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IHIgPSByYW5nZS50cmltKCk7XG4gIGlmIChyID09PSAnJyB8fCByID09PSAnKicgfHwgciA9PT0gJ2xhdGVzdCcgfHwgciA9PT0gJ3gnKSByZXR1cm4gdHJ1ZTtcbiAgaWYgKHIgPT09IHZlcnNpb24pIHJldHVybiB0cnVlO1xuICBjb25zdCBib3VuZCA9IC9eKFxcXnx+fD49PylcXHMqKFxcZCspXFwuKFxcZCspXFwuKFxcZCspLy5leGVjKHIpO1xuICBpZiAoYm91bmQgIT09IG51bGwpIHtcbiAgICBjb25zdCBvcCA9IGJvdW5kWzFdITtcbiAgICBjb25zdCBtYWpvciA9IE51bWJlcihib3VuZFsyXSk7XG4gICAgY29uc3QgbWlub3IgPSBOdW1iZXIoYm91bmRbM10pO1xuICAgIGNvbnN0IHBhdGNoID0gTnVtYmVyKGJvdW5kWzRdKTtcbiAgICBjb25zdCBjID0gY21wU2VtdmVyKHZlcnNpb24sIGAke21ham9yfS4ke21pbm9yfS4ke3BhdGNofWApO1xuICAgIGlmIChjIDwgMCkgcmV0dXJuIGZhbHNlO1xuICAgIGlmIChvcCA9PT0gJz49JykgcmV0dXJuIHRydWU7IC8vICc+PScgXHU0RTBCXHU3NTRDXHU1MzczXHU1M0VGOlx1OTVFRFx1NTMwNVx1NTE4NVx1NTNFQVx1NEVFNSAnPj14LnkueiA8eicgXHU1OTBEXHU1NDA4XHU1RjYyXHU2MDAxXHU1MUZBXHU3M0IwLFx1NEZERFx1NUI4OFx1NTNENlx1NEUwQlx1NzU0Q1xuICAgIGlmIChvcCA9PT0gJ34nKSByZXR1cm4gY21wU2VtdmVyKHZlcnNpb24sIGAke21ham9yfS4ke21pbm9yICsgMX0uMGApIDwgMDtcbiAgICAvLyAnXic6MC54IFx1NzI3OVx1NTIyNCgwLjIuMyBcdTUxNDFcdThCQjggMC4yLnopLFx1NTE3Nlx1NEY1OVx1OTUwMVx1NEUzQlx1NzI0OFx1NjcyQ1xuICAgIGlmIChtYWpvciA9PT0gMCkgcmV0dXJuIG1pbm9yID09PSAwID8gY21wU2VtdmVyKHZlcnNpb24sIGAwLjAuJHtwYXRjaCArIDF9YCkgPCAwIDogY21wU2VtdmVyKHZlcnNpb24sIGAwLiR7bWlub3IgKyAxfS4wYCkgPCAwO1xuICAgIHJldHVybiBjbXBTZW12ZXIodmVyc2lvbiwgYCR7bWFqb3IgKyAxfS4wLjBgKSA8IDA7XG4gIH1cbiAgcmV0dXJuIGZhbHNlO1xufVxuXG4vKiogXHU0RUNFIHBhY2t1bWVudCBcdTkwMDlcdTUxRkEgc3BlYyhcdTdDQkVcdTc4NkUvbGF0ZXN0L14vfi8qKVx1NjMwN1x1NTQxMVx1NzY4NFx1NzI0OFx1NjcyQztcdTY1RTBcdTUzMzlcdTkxNERcdThGRDRcdTU2REUgJydcdTMwMDIgKi9cbmV4cG9ydCBmdW5jdGlvbiBwaWNrVmVyc2lvbihkb2M6IFBhY2t1bWVudCwgc3BlYzogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgcyA9IHNwZWMudHJpbSgpO1xuICBjb25zdCB0YWcgPSBzID09PSAnJyB8fCBzID09PSAnbGF0ZXN0JyB8fCBzID09PSAnKicgPyBkb2NbJ2Rpc3QtdGFncyddPy5sYXRlc3QgOiB1bmRlZmluZWQ7XG4gIGlmICh0YWcgIT09IHVuZGVmaW5lZCAmJiBkb2MudmVyc2lvbnNbdGFnXSAhPT0gdW5kZWZpbmVkKSByZXR1cm4gdGFnO1xuICBpZiAoZG9jLnZlcnNpb25zW3NdICE9PSB1bmRlZmluZWQpIHJldHVybiBzO1xuICBsZXQgYmVzdCA9ICcnO1xuICBmb3IgKGNvbnN0IHYgb2YgT2JqZWN0LmtleXMoZG9jLnZlcnNpb25zKSkge1xuICAgIGlmIChzYXRpc2ZpZXMocywgdikgJiYgY21wU2VtdmVyKHYsIGJlc3QpID4gMCkgYmVzdCA9IHY7XG4gIH1cbiAgcmV0dXJuIGJlc3Q7XG59XG5cbi8qIC0tLS0gXHU0RjlEXHU4RDU2XHU5NUVEXHU1MzA1IC0tLS0gKi9cblxuLyoqXG4gKiBcdTg5RTNcdTY3OTAgcm9vdCBcdTUzQ0FcdTUxNzZcdTUxNjhcdTkwRThcdTRGMjBcdTkwMTJcdTRGOURcdThENTYoQkZTLFx1NjMwOVx1NTMwNVx1NTQwRFx1NTNCQlx1OTFDRFx1NTNENlx1OTk5Nlx1NEUyQVx1ODlFM1x1Njc5MFx1N0VEM1x1Njc5QyBcdTIwMTRcdTIwMTQgXHU0RTBFIG5wbSBcdTYyNDFcdTVFNzNcbiAqIFx1NUUwM1x1NUM0MFx1NEUwMFx1ODFGNClcdTMwMDJnZXRQYWNrdW1lbnQgXHU3NTMxXHU4QzAzXHU3NTI4XHU2NUI5XHU2Q0U4XHU1MTY1KGZldGNoIFx1N0Y1MVx1N0VEQyAvIFx1NkQ0Qlx1OEJENVx1NkNFOFx1NTE2NVx1NUI1N1x1NTE3OClcdTMwMDJcbiAqIFx1NEVGQlx1NEUwMFx1NEY5RFx1OEQ1Nlx1NjVFMFx1NkVFMVx1OERCM1x1NzI0OFx1NjcyQ1x1NjVGNlx1NjI5Qlx1OTUxOShcdTVFMjZcdTUzMDVcdTU0MERcdTRFMEUgcmFuZ2UsXHU5NzYyXHU1NDExXHU1Qjg5XHU4OEM1XHU5ODc1XHU5NTE5XHU4QkVGXHU2NTg3XHU2ODQ4KVx1MzAwMlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZUNsb3N1cmUoXG4gIHJvb3Q6IHsgbmFtZTogc3RyaW5nOyBzcGVjOiBzdHJpbmcgfSxcbiAgZ2V0UGFja3VtZW50OiAobmFtZTogc3RyaW5nKSA9PiBQcm9taXNlPFBhY2t1bWVudD4sXG4pOiBQcm9taXNlPFJlc29sdmVkUGtnW10+IHtcbiAgY29uc3QgcmVzb2x2ZWQgPSBuZXcgTWFwPHN0cmluZywgUGtnVmVyc2lvbk1ldGE+KCk7XG4gIGNvbnN0IHF1ZXVlOiBBcnJheTx7IG5hbWU6IHN0cmluZzsgc3BlYzogc3RyaW5nIH0+ID0gW3Jvb3RdO1xuICB3aGlsZSAocXVldWUubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IHsgbmFtZSwgc3BlYyB9ID0gcXVldWUuc2hpZnQoKSE7XG4gICAgaWYgKHJlc29sdmVkLmhhcyhuYW1lKSkgY29udGludWU7IC8vIFx1NURGMlx1NUI5QVx1NzI0ODpcdTU0MEVcdTdFRUQgcmFuZ2UgXHU1RjE1XHU3NTI4XHU0RTBEXHU1MThEXHU5MUNEXHU4OUUzKG5wbSBcdTYyNDFcdTVFNzNcdThCRURcdTRFNDkpXG4gICAgY29uc3QgZG9jID0gYXdhaXQgZ2V0UGFja3VtZW50KG5hbWUpO1xuICAgIGNvbnN0IHZlcnNpb24gPSBwaWNrVmVyc2lvbihkb2MsIHNwZWMpO1xuICAgIGNvbnN0IG1ldGEgPSB2ZXJzaW9uICE9PSAnJyA/IGRvYy52ZXJzaW9uc1t2ZXJzaW9uXSA6IHVuZGVmaW5lZDtcbiAgICBpZiAobWV0YSA9PT0gdW5kZWZpbmVkIHx8IG1ldGEuZGlzdD8udGFyYmFsbCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYG5vIHZlcnNpb24gb2YgJHtuYW1lfSBzYXRpc2ZpZXMgJHtzcGVjIHx8ICdsYXRlc3QnfWApO1xuICAgIH1cbiAgICBjb25zdCBpdGVtOiBQa2dWZXJzaW9uTWV0YSA9IHtcbiAgICAgIHZlcnNpb24sXG4gICAgICBkZXBlbmRlbmNpZXM6IG1ldGEuZGVwZW5kZW5jaWVzID8/IHt9LFxuICAgICAgdGFyYmFsbDogbWV0YS5kaXN0LnRhcmJhbGwsXG4gICAgICBpbnRlZ3JpdHk6IG1ldGEuZGlzdC5pbnRlZ3JpdHksXG4gICAgfTtcbiAgICByZXNvbHZlZC5zZXQobmFtZSwgaXRlbSk7XG4gICAgZm9yIChjb25zdCBbZGVwLCByYW5nZV0gb2YgT2JqZWN0LmVudHJpZXMoaXRlbS5kZXBlbmRlbmNpZXMpKSB7XG4gICAgICBpZiAoIXJlc29sdmVkLmhhcyhkZXApKSBxdWV1ZS5wdXNoKHsgbmFtZTogZGVwLCBzcGVjOiByYW5nZSB9KTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIFsuLi5yZXNvbHZlZC5lbnRyaWVzKCldLm1hcCgoW25hbWUsIG1dKSA9PiAoeyBuYW1lLCB2ZXJzaW9uOiBtLnZlcnNpb24sIHRhcmJhbGw6IG0udGFyYmFsbCwgaW50ZWdyaXR5OiBtLmludGVncml0eSB9KSk7XG59XG5cbi8qIC0tLS0gXHU5NTVDXHU1MENGXHU0RTBFXHU1RTAzXHU1QzQwIC0tLS0gKi9cblxuY29uc3QgUkVHSVNUUllfSE9TVFMgPSAvXihodHRwcz86XFwvXFwvW14vXSspXFwvKC4qKSQvO1xuXG4vKipcbiAqIHRhcmJhbGwgXHU3Njg0XHU5NTVDXHU1MENGXHU1MDE5XHU5MDA5KFx1OTg3QVx1NUU4Rlx1NTM3M1x1NTZERVx1OTAwMFx1OTg3QVx1NUU4Rik6XHU1MzlGXHU1OUNCXHU1NzMwXHU1NzQwIFx1MjE5MiBcdTU0MDQgcmVnaXN0cnkgXHU1NDBDXHU4REVGXHU1Rjg0XHU2NTM5XHU1MTk5XHUzMDAyXG4gKiBwYWNrdW1lbnQgXHU5MUNDXHU3Njg0IGRpc3QudGFyYmFsbCBcdTYwNTJcdTYzMDdcdTU0MTFcdTUzRDFcdTVFMDNcdTZFOTAocmVnaXN0cnkubnBtanMub3JnKSxcdTU2RkRcdTUxODVcdTdGNTFcdTdFRENcbiAqIFx1NEUwRFx1NTNFRlx1OEZCRVx1NjVGNlx1NjMwOSByZWdpc3RyeSBcdTUyMTdcdTg4NjhcdTY1MzlcdTUxOTkgaG9zdChcdThERUZcdTVGODRcdTRFMERcdTUzRDggXHUyMDE0XHUyMDE0IG5wbW1pcnJvciBcdTRFMEUgbnBtanMgXHU1NDBDXHU2Nzg0KVx1MzAwMlxuICovXG5leHBvcnQgZnVuY3Rpb24gdGFyYmFsbE1pcnJvcnModGFyYmFsbDogc3RyaW5nLCByZWdpc3RyaWVzOiBzdHJpbmdbXSk6IHN0cmluZ1tdIHtcbiAgY29uc3QgbSA9IFJFR0lTVFJZX0hPU1RTLmV4ZWModGFyYmFsbCk7XG4gIGNvbnN0IHBhdGggPSBtPy5bMl0gPz8gJyc7XG4gIGNvbnN0IG91dCA9IFt0YXJiYWxsXTtcbiAgZm9yIChjb25zdCByZWcgb2YgcmVnaXN0cmllcykge1xuICAgIGNvbnN0IGJhc2UgPSByZWcucmVwbGFjZSgvXFwvKyQvLCAnJyk7XG4gICAgaWYgKGJhc2UgPT09IG0/LlsxXSkgY29udGludWU7XG4gICAgY29uc3QgdSA9IGAke2Jhc2V9LyR7cGF0aH1gO1xuICAgIGlmICghb3V0LmluY2x1ZGVzKHUpKSBvdXQucHVzaCh1KTtcbiAgfVxuICByZXR1cm4gb3V0O1xufVxuXG4vKiogXHU1MzA1XHU1NzI4IG5vZGVfbW9kdWxlcyBcdTRFMEJcdTc2ODRcdTc2RUVcdTY4MDdcdTc2RUVcdTVGNTUoc2NvcGVkIFx1NTMwNVx1NEZERFx1NjMwMSBAc2NvcGUvbmFtZSBcdTRFMjRcdTdFQTcpXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gbW9kdWxlRGlyKHByZWZpeDogc3RyaW5nLCBuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBwYXJ0cyA9IG5hbWUuc3BsaXQoJy8nKS5maWx0ZXIoKHApID0+IHAgIT09ICcnICYmIHAgIT09ICcuJyk7XG4gIGlmIChuYW1lLnN0YXJ0c1dpdGgoJ0AnKSAmJiBwYXJ0cy5sZW5ndGggIT09IDIpIHRocm93IG5ldyBFcnJvcihgaW52YWxpZCBwYWNrYWdlIG5hbWU6ICR7bmFtZX1gKTtcbiAgaWYgKCFuYW1lLnN0YXJ0c1dpdGgoJ0AnKSAmJiBwYXJ0cy5sZW5ndGggIT09IDEpIHRocm93IG5ldyBFcnJvcihgaW52YWxpZCBwYWNrYWdlIG5hbWU6ICR7bmFtZX1gKTtcbiAgcmV0dXJuIFsuLi5wYXJ0c10ucmVkdWNlKChkaXIsIHApID0+IGAke2Rpcn1cXFxcJHtwfWAsIGAke3ByZWZpeH1cXFxcbm9kZV9tb2R1bGVzYCk7XG59XG5cbi8qIC0tLS0gaW50ZWdyaXR5IC0tLS0gKi9cblxuLyoqIG5wbSBkaXN0LmludGVncml0eSgnc2hhNTEyLWJhc2U2NCcpIFx1NjgyMVx1OUE4QztcdTRFMERcdTUzMzlcdTkxNERcdThGRDRcdTU2REUgZmFsc2UoXHU2NzJBXHU3N0U1XHU3Qjk3XHU2Q0Q1XHU4RkQ0XHU1NkRFIHRydWUgXHU2NTNFXHU4ODRDKVx1MzAwMiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGludGVncml0eU9rKGRhdGE6IEJ1ZmZlciwgaW50ZWdyaXR5Pzogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGlmIChpbnRlZ3JpdHkgPT09IHVuZGVmaW5lZCB8fCBpbnRlZ3JpdHkgPT09ICcnKSByZXR1cm4gdHJ1ZTtcbiAgY29uc3QgbSA9IC9ec2hhNTEyLShbQS1aYS16MC05Ky89XSspJC8uZXhlYyhpbnRlZ3JpdHkudHJpbSgpKTtcbiAgaWYgKG0gPT09IG51bGwpIHJldHVybiB0cnVlO1xuICByZXR1cm4gY3JlYXRlSGFzaCgnc2hhNTEyJykudXBkYXRlKGRhdGEpLmRpZ2VzdCgnYmFzZTY0JykgPT09IG1bMV07XG59XG5cbi8qKiBcdTRFQkFcdTdDN0JcdTUzRUZcdThCRkJcdTVCNTdcdTgyODIoXHU1Qjg5XHU4OEM1XHU4RkRCXHU1RUE2XHU2NTg3XHU2ODQ4XHU3NTI4KVx1MzAwMiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJ5dGVzTGFiZWwobjogbnVtYmVyKTogc3RyaW5nIHtcbiAgaWYgKG4gPCAxMDI0KSByZXR1cm4gYCR7bn0gQmA7XG4gIGlmIChuIDwgMTAyNCAqIDEwMjQpIHJldHVybiBgJHsobiAvIDEwMjQpLnRvRml4ZWQoMCl9IEtCYDtcbiAgcmV0dXJuIGAkeyhuIC8gMTAyNCAvIDEwMjQpLnRvRml4ZWQoMSl9IE1CYDtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICI7QUFjQSxTQUFTLE9BQUFBLE1BQUssZUFBZSxRQUFRLFNBQVMsU0FBUyxPQUFPLE1B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QUFZQTtBQW9CQTtBQW1IQTtBQVlBO0FBV0E7IiwKICAibmFtZXMiOiBbImFwcCIsICJqb2luIiwgImV4aXN0c1N5bmMiLCAicmVhbHBhdGhTeW5jIiwgIndyaXRlRmlsZSIsICJob21lZGlyIiwgInNwYXduIiwgInBhdGhUb0ZpbGVVUkwiLCAicmVzb2x2ZSIsICJyYW5kb21VVUlEIiwgInJhbmRvbVVVSUQiLCAicmVzb2x2ZSIsICJzcGF3biIsICJqb2luIiwgImpvaW4iLCAicmVzb2x2ZSIsICJzcGF3biIsICJqb2luIiwgImpvaW4iLCAiYXBwIiwgInB1c2hFdmVudCIsICJub3RpZnlFdmVudCIsICJmb2N1c01haW5XaW5kb3ciLCAic2V0dXBUcmF5IiwgImFwcGx5Q2hyb21lIiwgImFwcGx5VXBkYXRlIiwgInNwYXduIiwgImJ1aWxkQXBwTWVudSIsICJwb3B1cE1haW5NZW51IiwgIndlYkF1dG9zdGFydEluc3RhbGxlZCIsICJleGlzdHNTeW5jIiwgImxhbklwT2YiLCAiY2xpRW50cnlPZiIsICJyZXBvUm9vdE9mIiwgInBrZ05hbWVBdCIsICJydW5DbGkiLCAiYnJvYWRjYXN0SG9zdFN0YXRlIiwgInBrZ1ZlcnNpb25BdCIsICJlbnRyeUZyb21DbGlEaXIiLCAiZGV0ZWN0RXh0ZXJuYWxSdW50aW1lIiwgInJlYWxwYXRoU3luYyIsICJob21lZGlyIiwgImRldGVjdFJlYWxFbnRyeSIsICJidW5kbGVkUnVudGltZVBhdGgiLCAiYnVuZGxlZFJ1bnRpbWVJbmZvIiwgIm5wbU9uUGF0aCIsICJ3aXphcmRTdXBwcmVzc2VkIiwgInNlbmRlclRydXN0ZWQiLCAiaG9zdENhbGwiLCAicmVnaXN0ZXJJcGMiLCAid3JpdGVGaWxlIiwgInciLCAicGF0aFRvRmlsZVVSTCIsICJhcHAyIl0KfQo=
