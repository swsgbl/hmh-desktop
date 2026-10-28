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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vZWxlY3Ryb24vbWFpbi9pbmRleC50cyIsICIuLi8uLi8uLi8uLi9wYWNrYWdlcy9ob3N0LWFkYXB0ZXIvc3JjL3N1cGVydmlzb3IudHMiLCAiLi4vLi4vLi4vLi4vcGFja2FnZXMvY29udHJhY3RzL3NyYy9ldmVudC50cyIsICIuLi8uLi8uLi8uLi9wYWNrYWdlcy9jb250cmFjdHMvc3JjL2Vycm9yLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2NvbnRyYWN0cy9zcmMvZ3VhcmRzLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2hvc3QtYWRhcHRlci9zcmMvY2xpZW50LnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2hvc3QtYWRhcHRlci9zcmMvZmFrZS1ob3N0LnRzIiwgIi4uLy4uL2VsZWN0cm9uL21haW4vdWl2ZXJpZnkudHMiLCAiLi4vLi4vZWxlY3Ryb24vbWFpbi9pbnN0YWxsZXIudHMiLCAiLi4vLi4vLi4vLi4vcGFja2FnZXMvY2xpLWluc3RhbGxlci9zcmMvaW5kZXgudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxyXG4gKiBITUggRGVza3RvcCBcdTIwMTQgRWxlY3Ryb24gXHU0RTNCXHU4RkRCXHU3QTBCKEFEUi0wMDEvMDAzLzAwNClcdTMwMDJcclxuICpcclxuICogXHU1Qjg5XHU1MTY4XHU0RTBEXHU1M0Q4XHU5MUNGKFx1NUYwMFx1NTNEMVx1OEJBMVx1NTIxMiBNMCBcdTUxRkFcdTUzRTNcdTk1RTggKyBFbGVjdHJvbiBcdTVCOThcdTY1QjlcdTVCODlcdTUxNjhcdTZFMDVcdTUzNTUpOlxyXG4gKiAgLSByZW5kZXJlcjpjb250ZXh0SXNvbGF0aW9uICsgc2FuZGJveCArIFx1Nzk4MSBub2RlSW50ZWdyYXRpb24sXHU0RTI1XHU2ODNDIENTUDtcclxuICogIC0gXHU1QkZDXHU4MjJBL1x1NjVCMFx1N0E5N1x1NTNFM1x1NEUwMFx1NUY4Qlx1NjJEMlx1N0VERChcdTUzRUFcdTUyQTBcdThGN0RcdTYyMTFcdTRFRUNcdTgxRUFcdTVERjFcdTc2ODQgcmVuZGVyZXIpO1xyXG4gKiAgLSBcdTZCQ0ZcdTY3NjEgSVBDIFx1NjgyMVx1OUE4QyBzZW5kZXIgXHU3Njg0XHU5ODc2XHU1QzQyIGZyYW1lIFVSTCBcdTVDNUVcdTRFOEVcdTY3MkNcdTVFOTRcdTc1MjgsXHU5MDFBXHU5MDUzXHU3NjdEXHU1NDBEXHU1MzU1O1xyXG4gKiAgLSBob3N0IHRva2VuIFx1NTNFQVx1NUI1OFx1NTcyOFx1NEU4RVx1NjcyQ1x1OEZEQlx1N0EwQlx1NEUwRVx1NUI1MFx1OEZEQlx1N0EwQiBlbnYsXHU2NUU1XHU1RkQ3XHU4RjkzXHU1MUZBXHU1MjREXHU1MTQ4XHU4MTMxXHU2NTRGO1xyXG4gKiAgLSBcdTUzNTVcdTVCOUVcdTRGOEJcdTk1MDE7XHU5MDAwXHU1MUZBXHU2NUY2XHU1M0VBXHU1MDVDXHU2QjYyXHU4MUVBXHU1REYxIHNwYXduIFx1NzY4NCBob3N0KFx1NEYxOFx1OTZDNVx1MjE5Mlx1NTE1Q1x1NUU5NSBraWxsKVx1MzAwMlxyXG4gKlxyXG4gKiBcdTk2MzZcdTZCQjVFKDIwMjYtMTAtMTApOm1haW4gXHU2MzAxXHU2NzA5IERlc2t0b3BIb3N0Q2xpZW50LFNTRSBcdTRGRTFcdTVDMDFcdTZENDEoZXZlbnQ6IGhtaClcclxuICogXHU3RUNGIDUwbXMgXHU2Mjc5XHU5MUNGXHU2M0E4XHU3RUQ5IHJlbmRlcmVyO3NlbmRUYXNrL2FwcHJvdmUvaW50ZXJydXB0L3Nlc3Npb25zIFx1NTE2OFx1OTBFOFx1OEY2Q1x1NTNEMVxyXG4gKiBcdTdFRDkgaG9zdCBcdTIwMTRcdTIwMTQgZmFrZSBcdTRFMEVcdTc3MUZcdTVCOUUgaG1oYXJuZXNzIGRlc2t0b3AtaG9zdCBcdThENzBcdTU0MENcdTRFMDBcdTY3NjFcdTRFRTNcdTc4MDFcdThERUZcdTVGODRcdTMwMDJcclxuICovXHJcbmltcG9ydCB7IGFwcCwgQnJvd3NlcldpbmRvdywgZGlhbG9nLCBpcGNNYWluLCBzZXNzaW9uLCBzaGVsbCwgVHJheSwgTm90aWZpY2F0aW9uLCBNZW51LCBuYXRpdmVJbWFnZSwgbmF0aXZlVGhlbWUgfSBmcm9tICdlbGVjdHJvbic7XHJcbmltcG9ydCB7IGpvaW4sIGRpcm5hbWUsIGJhc2VuYW1lLCBpc0Fic29sdXRlLCByZXNvbHZlIH0gZnJvbSAnbm9kZTpwYXRoJztcclxuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhbHBhdGhTeW5jLCByZWFkRmlsZVN5bmMgfSBmcm9tICdub2RlOmZzJztcclxuaW1wb3J0IHsgd3JpdGVGaWxlLCByZWFkRmlsZSB9IGZyb20gJ25vZGU6ZnMvcHJvbWlzZXMnO1xyXG5pbXBvcnQgeyBob21lZGlyLCBuZXR3b3JrSW50ZXJmYWNlcyB9IGZyb20gJ25vZGU6b3MnO1xyXG5pbXBvcnQgeyBleGVjRmlsZVN5bmMsIHNwYXduIH0gZnJvbSAnbm9kZTpjaGlsZF9wcm9jZXNzJztcclxuaW1wb3J0IHsgcGF0aFRvRmlsZVVSTCB9IGZyb20gJ25vZGU6dXJsJztcclxuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gJ25vZGU6Y3J5cHRvJztcclxuaW1wb3J0IHsgRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yLCBEZXNrdG9wSG9zdENsaWVudCwgZW52ZWxvcGVGcm9tRnJhbWUsIHR5cGUgSG9zdFN0YXRlIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2hvc3QtYWRhcHRlcic7XHJcbmltcG9ydCB7IGlzRXZlbnRFbnZlbG9wZSwgdHlwZSBFdmVudEVudmVsb3BlIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyc7XHJcbmltcG9ydCB7IGF0dGFjaFVpVmVyaWZ5IH0gZnJvbSAnLi91aXZlcmlmeS50cyc7XHJcbmltcG9ydCB7IGluc3RhbGxUYXJnZXQsIHJlc29sdmVJbnN0YWxsZWRFbnRyeSwgc3RhcnRDbGlJbnN0YWxsLCB0eXBlIEluc3RhbGxQcm9ncmVzcyB9IGZyb20gJy4vaW5zdGFsbGVyLnRzJztcclxuXHJcbmNvbnN0IGhlcmUgPSBpbXBvcnQubWV0YS5kaXJuYW1lID8/ICcuJztcclxuY29uc3QgaXNEZXYgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9ERVYgPT09ICcxJztcclxuY29uc3QgcmVuZGVyZXJEZXZVcmwgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9SRU5ERVJFUl9VUkwgPz8gJyc7XHJcbmNvbnN0IHByZWxvYWRQYXRoID0gam9pbihoZXJlLCAnLi4vcHJlbG9hZC9pbmRleC5janMnKTtcclxuXHJcbi8qIC0tLS0gXHU2NUU1XHU1RkQ3XHU4MTMxXHU2NTRGOnRva2VuL2F1dGhvcml6YXRpb24gXHU2QzM4XHU0RTBEXHU4RkRCXHU2M0E3XHU1MjM2XHU1M0YwIC0tLS0gKi9cclxuY29uc3Qgc2VjcmV0czogc3RyaW5nW10gPSBbXTtcclxuZnVuY3Rpb24gcmVkYWN0KHM6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgbGV0IG91dCA9IHM7XHJcbiAgZm9yIChjb25zdCBzZWMgb2Ygc2VjcmV0cykge1xyXG4gICAgaWYgKHNlYy5sZW5ndGggPj0gOCkgb3V0ID0gb3V0LnNwbGl0KHNlYykuam9pbignW3JlZGFjdGVkXScpO1xyXG4gIH1cclxuICByZXR1cm4gb3V0O1xyXG59XHJcbmZ1bmN0aW9uIGxvZ0luZm8odGFnOiBzdHJpbmcsIG1zZzogc3RyaW5nKTogdm9pZCB7XHJcbiAgY29uc29sZS5sb2coYFtobWgtZGVza3RvcDoke3RhZ31dICR7cmVkYWN0KG1zZyl9YCk7XHJcbn1cclxuXHJcbi8qIC0tLS0gXHU1MzU1XHU1QjlFXHU0RjhCIC0tLS0gKi9cclxuaWYgKCFhcHAucmVxdWVzdFNpbmdsZUluc3RhbmNlTG9jaygpKSB7XHJcbiAgYXBwLnF1aXQoKTtcclxufSBlbHNlIHtcclxuICBhcHAub24oJ3NlY29uZC1pbnN0YW5jZScsICgpID0+IHtcclxuICAgIGNvbnN0IHdpbiA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpWzBdO1xyXG4gICAgaWYgKHdpbikge1xyXG4gICAgICBpZiAod2luLmlzTWluaW1pemVkKCkpIHdpbi5yZXN0b3JlKCk7XHJcbiAgICAgIHdpbi5mb2N1cygpO1xyXG4gICAgfVxyXG4gIH0pO1xyXG5cclxuICAvKiAtLS0tIGhvc3QgXHU3NkQxXHU3QkExICsgXHU2ODY1XHU1QkEyXHU2MjM3XHU3QUVGIC0tLS0gKi9cclxuICBpbnRlcmZhY2UgQnJpZGdlU25hcHNob3Qge1xyXG4gICAgaG9zdFN0YXRlOiBIb3N0U3RhdGU7XHJcbiAgICBob3N0UG9ydDogbnVtYmVyIHwgbnVsbDtcclxuICAgIGhvc3RWZXJzaW9uOiBzdHJpbmcgfCBudWxsO1xyXG4gICAgbGFzdEVycm9yOiBzdHJpbmcgfCBudWxsO1xyXG4gICAgbW9kZTogJ2Zha2UnIHwgJ3JlYWwnO1xyXG4gICAgcnVudGltZUVudHJ5OiBzdHJpbmcgfCBudWxsO1xyXG4gIH1cclxuICBsZXQgc3VwZXJ2aXNvcjogRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yIHwgbnVsbCA9IG51bGw7XHJcbiAgbGV0IGNsaWVudDogRGVza3RvcEhvc3RDbGllbnQgfCBudWxsID0gbnVsbDtcclxuICBsZXQgYnJpZGdlOiBCcmlkZ2VTbmFwc2hvdCA9IHsgaG9zdFN0YXRlOiAnc3RvcHBlZCcsIGhvc3RQb3J0OiBudWxsLCBob3N0VmVyc2lvbjogbnVsbCwgbGFzdEVycm9yOiBudWxsLCBtb2RlOiAnZmFrZScsIHJ1bnRpbWVFbnRyeTogbnVsbCB9O1xyXG4gIC8qKiBcdTRFOEJcdTRFRjZcdTYyNzlcdTkxQ0ZcdTdGMTNcdTUxQjI6XHU5QUQ4XHU5ODkxIFNTRSBcdTRFMERcdTkwMTBcdTY3NjFcdThGQzcgSVBDLDUwbXMgXHU2Mjc5XHU5MUNGIGZsdXNoKFx1NkUzMlx1NjdEM1x1NEUwRFx1NTM2MSlcdTMwMDIgKi9cclxuICBsZXQgZXZlbnRCdWZmZXI6IEV2ZW50RW52ZWxvcGVbXSA9IFtdO1xyXG4gIGxldCBmbHVzaFRpbWVyOiBOb2RlSlMuVGltZW91dCB8IG51bGwgPSBudWxsO1xyXG4gIGxldCBzc2VBYm9ydDogQWJvcnRDb250cm9sbGVyIHwgbnVsbCA9IG51bGw7XHJcbiAgbGV0IGxhc3RFdmVudElkID0gJyc7XHJcbiAgLyoqIFx1NjcyQVx1NzdFNS9cdTc1NzhcdTVGNjJcdTRGRTFcdTVDMDFcdThCQTFcdTY1NzAoU0NIRU1BX01JU01BVENIIFx1OTc2Mlx1NTQxMVx1OEJDQVx1NjVBRCxcdTRFMERcdTVEMjkpXHUzMDAyICovXHJcbiAgbGV0IGRyb3BwZWRGcmFtZXMgPSAwO1xyXG5cclxuICBmdW5jdGlvbiBwdXNoRXZlbnQoZW52OiBFdmVudEVudmVsb3BlKTogdm9pZCB7XHJcbiAgICBldmVudEJ1ZmZlci5wdXNoKGVudik7XHJcbiAgICBpZiAoZXZlbnRCdWZmZXIubGVuZ3RoID4gMl8wMDApIGV2ZW50QnVmZmVyLnNwbGljZSgwLCBldmVudEJ1ZmZlci5sZW5ndGggLSAyXzAwMCk7XHJcbiAgICBpZiAoZmx1c2hUaW1lciA9PT0gbnVsbCkge1xyXG4gICAgICBmbHVzaFRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XHJcbiAgICAgICAgZmx1c2hUaW1lciA9IG51bGw7XHJcbiAgICAgICAgY29uc3QgYmF0Y2ggPSBldmVudEJ1ZmZlcjtcclxuICAgICAgICBldmVudEJ1ZmZlciA9IFtdO1xyXG4gICAgICAgIGZvciAoY29uc3QgdyBvZiBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKSkge1xyXG4gICAgICAgICAgaWYgKCF3LmlzRGVzdHJveWVkKCkpIHcud2ViQ29udGVudHMuc2VuZCgnYnJpZGdlOmV2ZW50LWJhdGNoJywgYmF0Y2gpO1xyXG4gICAgICAgIH1cclxuICAgICAgfSwgNTApO1xyXG4gICAgfVxyXG4gICAgbm90aWZ5RXZlbnQoZW52KTtcclxuICB9XHJcblxyXG4gIC8qIC0tLS0gXHU3Q0ZCXHU3RURGXHU2MjU4XHU3NkQ4ICsgXHU5MDFBXHU3N0U1KDAzIFx1NTNGNyBcdTAwQTdcdTRFMDA6XHU2ODRDXHU5NzYyXHU0RUE3XHU1NEMxXHU5NzAwXHU4OTgxXHU3Q0ZCXHU3RURGXHU2MjU4XHU3NkQ4XHUzMDAxXHU5MDFBXHU3N0U1KSAtLS0tXHJcbiAgICAgXHU1QkExXHU2Mjc5XHU3QjQ5XHU1Rjg1XHU1RkM1XHU5ODdCXHU2MjUzXHU2MjcwKFx1NzUyOFx1NjIzN1x1NUZDNVx1OTg3Qlx1NTFCM1x1N0I1Nik7XHU1QjhDXHU2MjEwL1x1NTkzMVx1OEQyNVx1NEVDNVx1NTcyOFx1N0E5N1x1NTNFM1x1NTkzMVx1NzEyNlx1NjVGNlx1NjNEMFx1OTE5Mlx1MzAwMiAqL1xyXG4gIGNvbnN0IFRSQVlfSUNPTl9CQVNFNjQgPSAnaVZCT1J3MEtHZ29BQUFBTlNVaEVVZ0FBQUJBQUFBQVFDQVlBQUFBZjgvOWhBQUFBUjBsRVFWUjRuR05nUUFQU3Nvci84V0YwOVVScnhHc1FxWm94RElFSjZEZCtCMk4waGJqRU1Xd24xUUN3SVlQVEFGeVlmZ1lNZkJpUVpBREZDWWtxU1puaXpFUkpkZ1lBbEw1cnNEYzJhVGNBQUFBQVNVVk9SSzVDWUlJPSc7XHJcbiAgbGV0IHRyYXk6IFRyYXkgfCBudWxsID0gbnVsbDtcclxuICBjb25zdCBzZW5kTWVudUFjdGlvbiA9IChhOiBzdHJpbmcpOiB2b2lkID0+IHtcclxuICAgIGZvciAoY29uc3QgdyBvZiBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKSkge1xyXG4gICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCdtZW51OmFjdGlvbicsIGEpO1xyXG4gICAgfVxyXG4gIH07XHJcbiAgZnVuY3Rpb24gZm9jdXNNYWluV2luZG93KCk6IHZvaWQge1xyXG4gICAgY29uc3Qgd2luID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkuZmluZCgodykgPT4gIXcuaXNEZXN0cm95ZWQoKSk7XHJcbiAgICBpZiAod2luID09PSB1bmRlZmluZWQpIHJldHVybjtcclxuICAgIGlmICh3aW4uaXNNaW5pbWl6ZWQoKSkgd2luLnJlc3RvcmUoKTtcclxuICAgIHdpbi5zaG93KCk7XHJcbiAgICB3aW4uZm9jdXMoKTtcclxuICB9XHJcbiAgZnVuY3Rpb24gc2V0dXBUcmF5KCk6IHZvaWQge1xyXG4gICAgaWYgKHRyYXkgIT09IG51bGwpIHJldHVybjtcclxuICAgIGNvbnN0IGljb24gPSBuYXRpdmVJbWFnZS5jcmVhdGVGcm9tRGF0YVVSTChgZGF0YTppbWFnZS9wbmc7YmFzZTY0LCR7VFJBWV9JQ09OX0JBU0U2NH1gKTtcclxuICAgIHRyYXkgPSBuZXcgVHJheShpY29uKTtcclxuICAgIHRyYXkuc2V0VG9vbFRpcCgnSE1IIERlc2t0b3AnKTtcclxuICAgIHRyYXkub24oJ2NsaWNrJywgZm9jdXNNYWluV2luZG93KTtcclxuICAgIHRyYXkuc2V0Q29udGV4dE1lbnUoTWVudS5idWlsZEZyb21UZW1wbGF0ZShbXHJcbiAgICAgIHsgbGFiZWw6ICdcdTY1QjBcdTVFRkFcdTRGMUFcdThCREQnLCBjbGljazogKCk6IHZvaWQgPT4gc2VuZE1lbnVBY3Rpb24oJ25ldy1zZXNzaW9uJykgfSxcclxuICAgICAgeyBsYWJlbDogJ1x1NjYzRVx1NzkzQVx1NEUzQlx1N0E5N1x1NTNFMycsIGNsaWNrOiBmb2N1c01haW5XaW5kb3cgfSxcclxuICAgICAgeyBsYWJlbDogJ1x1NjI0Qlx1NjczQVx1OEZEQ1x1N0EwQlx1NjNBN1x1NTIzNicsIGNsaWNrOiAoKTogdm9pZCA9PiBzZW5kTWVudUFjdGlvbignb3Blbi1yZW1vdGUnKSB9LFxyXG4gICAgICB7IGxhYmVsOiAnXHU4QkJFXHU3RjZFJywgY2xpY2s6ICgpOiB2b2lkID0+IHNlbmRNZW51QWN0aW9uKCdvcGVuLXNldHRpbmdzJykgfSxcclxuICAgICAgeyB0eXBlOiAnc2VwYXJhdG9yJyB9LFxyXG4gICAgICB7IGxhYmVsOiAnXHU5MDAwXHU1MUZBJywgY2xpY2s6ICgpOiB2b2lkID0+IHsgYXBwLnF1aXQoKTsgfSB9LFxyXG4gICAgXSkpO1xyXG4gIH1cclxuICBmdW5jdGlvbiBub3RpZnlFdmVudChlbnY6IEV2ZW50RW52ZWxvcGUpOiB2b2lkIHtcclxuICAgIC8vIFx1OUE4Q1x1NjUzNi9cdTYyMkFcdTU2RkUvXHU2RTMyXHU2N0QzXHU2M0EyXHU5NDg4XHU2QTIxXHU1RjBGXHU5NzU5XHU5RUQ4KFx1NEUwRFx1NUY4MFx1NzUyOFx1NjIzN1x1Njg0Q1x1OTc2Mlx1NUYzOVx1NkQ0Qlx1OEJENVx1OTAxQVx1NzdFNSlcclxuICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWSA9PT0gJzEnIHx8IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NOQVBTSE9UICE9PSB1bmRlZmluZWQgfHwgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfUkVOREVSX1RFU1QgPT09ICcxJykgcmV0dXJuO1xyXG4gICAgaWYgKCFOb3RpZmljYXRpb24uaXNTdXBwb3J0ZWQoKSkgcmV0dXJuO1xyXG4gICAgY29uc3Qgd2luID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkuZmluZCgodykgPT4gIXcuaXNEZXN0cm95ZWQoKSk7XHJcbiAgICBjb25zdCBmb2N1c2VkID0gd2luPy5pc0ZvY3VzZWQoKSA/PyBmYWxzZTtcclxuICAgIGNvbnN0IG1rID0gKHRpdGxlOiBzdHJpbmcsIGJvZHk6IHN0cmluZyk6IHZvaWQgPT4ge1xyXG4gICAgICBjb25zdCBuID0gbmV3IE5vdGlmaWNhdGlvbih7IHRpdGxlLCBib2R5LCBpY29uOiBuYXRpdmVJbWFnZS5jcmVhdGVGcm9tRGF0YVVSTChgZGF0YTppbWFnZS9wbmc7YmFzZTY0LCR7VFJBWV9JQ09OX0JBU0U2NH1gKSB9KTtcclxuICAgICAgbi5vbignY2xpY2snLCBmb2N1c01haW5XaW5kb3cpO1xyXG4gICAgICBuLnNob3coKTtcclxuICAgIH07XHJcbiAgICBpZiAoZW52LmtpbmQgPT09ICdhcHByb3ZhbC5yZXF1aXJlZCcpIHtcclxuICAgICAgY29uc3QgcCA9IGVudi5wYXlsb2FkIGFzIHsgdG9vbD86IHN0cmluZyB9O1xyXG4gICAgICBtaygnSE1IIFx1OTcwMFx1ODk4MVx1NUJBMVx1NjI3OScsIGAke1N0cmluZyhwLnRvb2wgPz8gJ1x1NjRDRFx1NEY1QycpfSBcdTdCNDlcdTVGODVcdTRGNjBcdTc2ODRcdTYyNzlcdTUxQzZgKTtcclxuICAgIH0gZWxzZSBpZiAoZW52LmtpbmQgPT09ICdydW4uY29tcGxldGVkJyAmJiAhZm9jdXNlZCkge1xyXG4gICAgICBtaygnSE1IIFx1NEVGQlx1NTJBMVx1NUI4Q1x1NjIxMCcsIGBcdTRGMUFcdThCREQgJHtlbnYuc2Vzc2lvbklkfSBcdTc2ODRcdTRFRkJcdTUyQTFcdTVERjJcdTVCOENcdTYyMTBgKTtcclxuICAgIH0gZWxzZSBpZiAoZW52LmtpbmQgPT09ICdydW4uZmFpbGVkJyAmJiAhZm9jdXNlZCkge1xyXG4gICAgICBtaygnSE1IIFx1NEVGQlx1NTJBMVx1NTkzMVx1OEQyNScsIGBcdTRGMUFcdThCREQgJHtlbnYuc2Vzc2lvbklkfSBcdTc2ODRcdTRFRkJcdTUyQTFcdTU5MzFcdThEMjUsXHU3MEI5XHU1MUZCXHU2N0U1XHU3NzBCYCk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvKiAtLS0tIFx1ODFFQVx1NUI5QVx1NEU0OVx1NjgwN1x1OTg5OFx1NjgwRigyMDI2LTEwLTExIFx1NzUyOFx1NjIzN1x1NTNDRFx1OTk4ODpcdTRFQUVcdTgyNzJcdTZBMjFcdTVGMEZcdTk4NzZcdTkwRThcdTlFRDFcdTY3NjE9XHU1MzlGXHU3NTFGXHU4M0RDXHU1MzU1XHU2ODBGXHJcbiAgICAgXHU0RTBEXHU4RERGXHU0RTNCXHU5ODk4O1x1ODNEQ1x1NTM1NVx1NEUwRVx1OEJCRVx1N0Y2RVx1OTFDRFx1NTkwRCkgLS0tLSBcdTY1QjlcdTY4NDg6XHU5NjkwXHU4NUNGXHU1RjBGXHU2ODA3XHU5ODk4XHU2ODBGICsgdGl0bGVCYXJPdmVybGF5XHJcbiAgICAgKFx1OTg5Q1x1ODI3Mlx1OTY4Rlx1NEUzQlx1OTg5OCksXHU4M0RDXHU1MzU1XHU2ODBGIGF1dG9IaWRlKEFsdCBcdTU0N0NcdTUxRkEpXHU0RTE0XHU3Q0JFXHU3QjgwXHU0RTNBXHU3Q0ZCXHU3RURGXHU3RUE3XHU4MEZEXHU1MjlCO1xyXG4gICAgIFx1NUUzOFx1NzUyOFx1NTJBOFx1NEY1Q1x1OEQ3MCByZW5kZXJlciBcdTY4MDdcdTk4OThcdTY4MEYgXHUyNjMwIFx1NEUzQlx1ODNEQ1x1NTM1NShcdTU1MkZcdTRFMDBcdTUxNjVcdTUzRTMpXHUzMDAyICovXHJcbiAgLy8gdjQgRFNIIFx1OEJCRVx1OEJBMVx1OEJFRFx1OEEwMDpvdmVybGF5IFx1ODI3Mlx1OERERlx1OTY4RiB0aXRsZWJhciBcdTc2ODQgYmctbGF5ZXItMShcdTZENDUgI2ZmZi9cdTZERjEgIzE2MTgxZClcclxuICBjb25zdCBjaHJvbWVGb3IgPSAoZGFyazogYm9vbGVhbik6IHsgY29sb3I6IHN0cmluZzsgc3ltYm9sQ29sb3I6IHN0cmluZyB9ID0+XHJcbiAgICBkYXJrID8geyBjb2xvcjogJyMxNjE4MWQnLCBzeW1ib2xDb2xvcjogJyNmNWY2ZjgnIH0gOiB7IGNvbG9yOiAnI2ZmZmZmZicsIHN5bWJvbENvbG9yOiAnIzBmMTExNScgfTtcclxuICBmdW5jdGlvbiBhcHBseUNocm9tZShkYXJrOiBib29sZWFuKTogdm9pZCB7XHJcbiAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcclxuICAgICAgaWYgKCF3LmlzRGVzdHJveWVkKCkpIHtcclxuICAgICAgICB0cnkgeyB3LnNldFRpdGxlQmFyT3ZlcmxheShjaHJvbWVGb3IoZGFyaykpOyB9IGNhdGNoIHsgLyogXHU0RUM1IFdpbmRvd3MgXHU2NTJGXHU2MzAxICovIH1cclxuICAgICAgfVxyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgLyogLS0tLSBcdTVFOTRcdTc1MjhcdTUxODVcdTY2RjRcdTY1QjAoMjAyNi0xMC0yNjpcdTgxRUFcdTc4MTRcdThGN0JcdTkxQ0ZcdTY2RjRcdTY1QjBcdTU2NjgsXHU5NkY2XHU0RjlEXHU4RDU2O0dpdEh1YiBSZWxlYXNlcyBcdTkwMUFcdTkwNTMpXHJcbiAgICAgXHU2RDQxXHU3QTBCOlx1MjYzMFwiXHU2OEMwXHU2N0U1XHU2NkY0XHU2NUIwXCJcdTIxOTIgZmV0Y2ggbGF0ZXN0IHJlbGVhc2UgdGFnIFx1MjE5MiBcdTZCRDRcdTcyNDhcdTY3MkMgXHUyMTkyIFx1NTQwRVx1NTNGMFx1NEUwQlx1OEY3RCBTZXR1cFxyXG4gICAgIGV4ZSBcdTUyMzBcdTRFMzRcdTY1RjZcdTc2RUVcdTVGNTUgXHUyMTkyIFx1ODNEQ1x1NTM1NVx1NTNEOFwiXHU5MUNEXHU1NDJGXHU1RTc2XHU1Qjg5XHU4OEM1XHU2NkY0XHU2NUIwXCJcdTIxOTIgXHU5MDAwXHU1MUZBXHU1RTk0XHU3NTI4XHU1NDBFIE5TSVMgL1MgL0Q9XHU1MzlGXHU3NkVFXHU1RjU1XHJcbiAgICAgXHU5NzU5XHU5RUQ4XHU4OTg2XHU3NkQ2XHU1Qjg5XHU4OEM1KFx1NEUwQlx1NkIyMVx1NTQyRlx1NTJBOFx1NTM3M1x1NjVCMFx1NzI0OClcdTMwMDJcdTY1RTBcdTdCN0VcdTU0MERcdThCQzFcdTRFNjZcdTk2MzZcdTZCQjVcdTUzRUZcdTc1Mjg7XHU2QjYzXHU1RjBGXHU3QjdFXHU1NDBEXHU1NDBFXHU1M0VGXHU1MkEwXHU2ODIxXHU5QThDXHUzMDAyICovXHJcbiAgY29uc3QgVVBEQVRFX1JFUE8gPSAnc3dzZ2JsL2htaC1kZXNrdG9wJztcclxuICBpbnRlcmZhY2UgVXBkYXRlU3RhdGUgeyBjaGVja2luZzogYm9vbGVhbjsgY3VycmVudFZlcnNpb246IHN0cmluZzsgbGF0ZXN0OiBzdHJpbmcgfCBudWxsOyBub3Rlczogc3RyaW5nOyBkb3dubG9hZGVkOiBib29sZWFuOyBlcnJvcjogc3RyaW5nIH1cclxuICBsZXQgdXBkYXRlU3RhdGU6IFVwZGF0ZVN0YXRlID0geyBjaGVja2luZzogZmFsc2UsIGN1cnJlbnRWZXJzaW9uOiBhcHAuZ2V0VmVyc2lvbigpLCBsYXRlc3Q6IG51bGwsIG5vdGVzOiAnJywgZG93bmxvYWRlZDogZmFsc2UsIGVycm9yOiAnJyB9O1xyXG4gIGxldCBpbnN0YWxsZXJQYXRoOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcclxuICBjb25zdCBidW1wVXBkYXRlID0gKHBhdGNoOiBQYXJ0aWFsPFVwZGF0ZVN0YXRlPik6IHZvaWQgPT4ge1xyXG4gICAgdXBkYXRlU3RhdGUgPSB7IC4uLnVwZGF0ZVN0YXRlLCAuLi5wYXRjaCB9O1xyXG4gICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XHJcbiAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ3VwZGF0ZTpzdGF0ZScsIHVwZGF0ZVN0YXRlKTtcclxuICAgIH1cclxuICB9O1xyXG4gIGNvbnN0IGNtcFZlcnNpb24gPSAoYTogc3RyaW5nLCBiOiBzdHJpbmcpOiBudW1iZXIgPT4ge1xyXG4gICAgY29uc3QgcGEgPSBhLnJlcGxhY2UoL152LywgJycpLnNwbGl0KCcuJykubWFwKE51bWJlcik7XHJcbiAgICBjb25zdCBwYiA9IGIucmVwbGFjZSgvXnYvLCAnJykuc3BsaXQoJy4nKS5tYXAoTnVtYmVyKTtcclxuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgMzsgaSsrKSB7IGlmICgocGFbaV0gPz8gMCkgIT09IChwYltpXSA/PyAwKSkgcmV0dXJuIChwYVtpXSA/PyAwKSA8IChwYltpXSA/PyAwKSA/IC0xIDogMTsgfVxyXG4gICAgcmV0dXJuIDA7XHJcbiAgfTtcclxuICBhc3luYyBmdW5jdGlvbiBjaGVja0ZvclVwZGF0ZXMoKTogUHJvbWlzZTxVcGRhdGVTdGF0ZT4ge1xyXG4gICAgaWYgKHVwZGF0ZVN0YXRlLmNoZWNraW5nIHx8IHVwZGF0ZVN0YXRlLmRvd25sb2FkZWQpIHJldHVybiB1cGRhdGVTdGF0ZTtcclxuICAgIGJ1bXBVcGRhdGUoeyBjaGVja2luZzogdHJ1ZSwgZXJyb3I6ICcnIH0pO1xyXG4gICAgbG9nSW5mbygndXBkYXRlJywgYGNoZWNraW5nXHUyMDI2IChjdXJyZW50IHYke2FwcC5nZXRWZXJzaW9uKCl9KWApO1xyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3QgciA9IGF3YWl0IGZldGNoKGBodHRwczovL2FwaS5naXRodWIuY29tL3JlcG9zLyR7VVBEQVRFX1JFUE99L3JlbGVhc2VzL2xhdGVzdGAsIHtcclxuICAgICAgICBoZWFkZXJzOiB7ICd1c2VyLWFnZW50JzogJ2htaC1kZXNrdG9wLXVwZGF0ZXInIH0sXHJcbiAgICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDE1XzAwMCksXHJcbiAgICAgIH0pO1xyXG4gICAgICBpZiAoIXIub2spIHRocm93IG5ldyBFcnJvcihgR2l0SHViIEFQSSAke3Iuc3RhdHVzfWApO1xyXG4gICAgICBjb25zdCByZWwgPSAoYXdhaXQgci5qc29uKCkpIGFzIHsgdGFnX25hbWU/OiBzdHJpbmc7IGJvZHk/OiBzdHJpbmc7IGFzc2V0cz86IEFycmF5PHsgbmFtZTogc3RyaW5nOyBicm93c2VyX2Rvd25sb2FkX3VybDogc3RyaW5nOyBzaXplOiBudW1iZXIgfT4gfTtcclxuICAgICAgY29uc3QgdGFnID0gU3RyaW5nKHJlbC50YWdfbmFtZSA/PyAnJyk7XHJcbiAgICAgIGxvZ0luZm8oJ3VwZGF0ZScsIGBsYXRlc3Q9JHt0YWd9IGFzc2V0cz0keyhyZWwuYXNzZXRzID8/IFtdKS5sZW5ndGh9YCk7XHJcbiAgICAgIGJ1bXBVcGRhdGUoeyBjaGVja2luZzogZmFsc2UsIGxhdGVzdDogdGFnLCBub3RlczogU3RyaW5nKHJlbC5ib2R5ID8/ICcnKS5zbGljZSgwLCA2MDApIH0pO1xyXG4gICAgICAvLyBcdTY3MDlcdTY1QjBcdTcyNDhcdTRFMTRcdTY3MkFcdTRFMEJcdThGN0RcdThGQzcgXHUyMTkyIFx1NTQwRVx1NTNGMFx1NEUwQlx1OEY3RFx1NUI4OVx1ODhDNVx1NTMwNVxyXG4gICAgICBpZiAodGFnICE9PSAnJyAmJiBjbXBWZXJzaW9uKGFwcC5nZXRWZXJzaW9uKCksIHRhZykgPCAwICYmICF1cGRhdGVTdGF0ZS5kb3dubG9hZGVkKSB7XHJcbiAgICAgICAgdm9pZCBkb3dubG9hZEluc3RhbGxlcihyZWwuYXNzZXRzID8/IFtdKTtcclxuICAgICAgfVxyXG4gICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgIGxvZ0luZm8oJ3VwZGF0ZScsIGBjaGVjayBmYWlsZWQ6ICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTQwKX1gKTtcclxuICAgICAgYnVtcFVwZGF0ZSh7IGNoZWNraW5nOiBmYWxzZSwgZXJyb3I6IFN0cmluZyhlcnIpLnNsaWNlKDAsIDEyMCkgfSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gdXBkYXRlU3RhdGU7XHJcbiAgfVxyXG4gIGFzeW5jIGZ1bmN0aW9uIGRvd25sb2FkSW5zdGFsbGVyKGFzc2V0czogQXJyYXk8eyBuYW1lOiBzdHJpbmc7IGJyb3dzZXJfZG93bmxvYWRfdXJsOiBzdHJpbmc7IHNpemU6IG51bWJlciB9Pik6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3QgYXNzZXQgPSBhc3NldHMuZmluZCgoYSkgPT4gL15ITUgtRGVza3RvcC1TZXR1cC0uKlxcLmV4ZSQvaS50ZXN0KGEubmFtZSkpID8/IGFzc2V0cy5maW5kKChhKSA9PiBhLm5hbWUuZW5kc1dpdGgoJy5leGUnKSk7XHJcbiAgICAgIGlmIChhc3NldCA9PT0gdW5kZWZpbmVkKSB7IGJ1bXBVcGRhdGUoeyBlcnJvcjogJ3JlbGVhc2UgXHU2NUUwXHU1Qjg5XHU4OEM1XHU1MzA1XHU4RDQ0XHU0RUE3JyB9KTsgcmV0dXJuOyB9XHJcbiAgICAgIGNvbnN0IGRlc3QgPSBqb2luKGFwcC5nZXRQYXRoKCd0ZW1wJyksIGFzc2V0Lm5hbWUpO1xyXG4gICAgICAvLyBnaXRodWIuY29tIFx1NzZGNFx1OEZERVx1NTcyOFx1OTBFOFx1NTIwNlx1N0Y1MVx1N0VEQ1x1OEQ4NVx1NjVGNiBcdTIxOTIgXHU5NTVDXHU1MENGXHU1NkRFXHU5MDAwXHU5NEZFKFx1NUI5RVx1NkQ0QiBnaGZhc3QvZ2gtcHJveHkgXHU1M0VGXHU3NTI4KVxyXG4gICAgICBjb25zdCBtaXJyb3JzID0gW1xyXG4gICAgICAgIGFzc2V0LmJyb3dzZXJfZG93bmxvYWRfdXJsLFxyXG4gICAgICAgIGBodHRwczovL2doZmFzdC50b3AvJHthc3NldC5icm93c2VyX2Rvd25sb2FkX3VybH1gLFxyXG4gICAgICAgIGBodHRwczovL2doLXByb3h5LmNvbS8ke2Fzc2V0LmJyb3dzZXJfZG93bmxvYWRfdXJsfWAsXHJcbiAgICAgICAgYGh0dHBzOi8vZ2hwcm94eS5jbi8ke2Fzc2V0LmJyb3dzZXJfZG93bmxvYWRfdXJsfWAsXHJcbiAgICAgIF07XHJcbiAgICAgIGxldCBidWY6IEJ1ZmZlciB8IG51bGwgPSBudWxsO1xyXG4gICAgICBsZXQgbGFzdEVyciA9ICcnO1xyXG4gICAgICBmb3IgKGNvbnN0IHUgb2YgbWlycm9ycykge1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICBsb2dJbmZvKCd1cGRhdGUnLCBgdHJ5aW5nICR7bmV3IFVSTCh1KS5ob3N0fVx1MjAyNmApO1xyXG4gICAgICAgICAgY29uc3QgciA9IGF3YWl0IGZldGNoKHUsIHsgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDYwMF8wMDApIH0pO1xyXG4gICAgICAgICAgaWYgKCFyLm9rKSB7IGxhc3RFcnIgPSBgSFRUUCAke3Iuc3RhdHVzfWA7IGxvZ0luZm8oJ3VwZGF0ZScsIGBcdTIxOTIgSFRUUCAke3Iuc3RhdHVzfWApOyBjb250aW51ZTsgfVxyXG4gICAgICAgICAgYnVmID0gQnVmZmVyLmZyb20oYXdhaXQgci5hcnJheUJ1ZmZlcigpKTtcclxuICAgICAgICAgIGlmIChidWYubGVuZ3RoID4gMV8wMDBfMDAwKSB7IGxvZ0luZm8oJ3VwZGF0ZScsIGBcdTIxOTIgb2sgJHtNYXRoLnJvdW5kKGJ1Zi5sZW5ndGggLyAxZTYpfU1CYCk7IGJyZWFrOyB9XHJcbiAgICAgICAgICBsYXN0RXJyID0gJ1x1NTE4NVx1NUJCOVx1NUYwMlx1NUUzOCc7IGJ1ZiA9IG51bGw7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgICBjb25zdCBlID0gZXJyIGFzIHsgY2F1c2U/OiB7IGNvZGU/OiB1bmtub3duIH0gfTtcclxuICAgICAgICAgIGxhc3RFcnIgPSBTdHJpbmcoZS5jYXVzZT8uY29kZSA/PyBlcnIpLnNsaWNlKDAsIDYwKTtcclxuICAgICAgICAgIGxvZ0luZm8oJ3VwZGF0ZScsIGBcdTIxOTIgZmFpbCAke2xhc3RFcnJ9YCk7XHJcbiAgICAgICAgfVxyXG4gICAgICB9XHJcbiAgICAgIGlmIChidWYgPT09IG51bGwpIHRocm93IG5ldyBFcnJvcihgXHU1MTY4XHU5MEU4XHU0RTBCXHU4RjdEXHU5MDFBXHU5MDUzXHU1OTMxXHU4RDI1KCR7bGFzdEVycn0pYCk7XHJcbiAgICAgIGNvbnN0IHsgd3JpdGVGaWxlOiB3ZiB9ID0gYXdhaXQgaW1wb3J0KCdub2RlOmZzL3Byb21pc2VzJyk7XHJcbiAgICAgIGF3YWl0IHdmKGRlc3QsIGJ1Zik7XHJcbiAgICAgIGluc3RhbGxlclBhdGggPSBkZXN0O1xyXG4gICAgICBidW1wVXBkYXRlKHsgZG93bmxvYWRlZDogdHJ1ZSB9KTtcclxuICAgICAgbG9nSW5mbygndXBkYXRlJywgYFx1NURGMlx1NEUwQlx1OEY3RCAke2Fzc2V0Lm5hbWV9KCR7TWF0aC5yb3VuZChidWYubGVuZ3RoIC8gMWU2KX1NQikgXHUyMTkyICR7ZGVzdH1gKTtcclxuICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICBidW1wVXBkYXRlKHsgZXJyb3I6IGBcdTRFMEJcdThGN0RcdTU5MzFcdThEMjU6ICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTIwKX1gIH0pO1xyXG4gICAgfVxyXG4gIH1cclxuICBmdW5jdGlvbiBhcHBseVVwZGF0ZSgpOiB2b2lkIHtcclxuICAgIGlmIChpbnN0YWxsZXJQYXRoID09PSBudWxsKSByZXR1cm47XHJcbiAgICAvLyBcdTkwMDBcdTUxRkFcdTVGNTNcdTUyNERcdTVFOTRcdTc1MjhcdTU0MEVcdTc1MzFcdTVCODlcdTg4QzVcdTU2NjhcdTk3NTlcdTlFRDhcdTg5ODZcdTc2RDZcdTVCODlcdTg4QzUoXHU4OEM1XHU1NkRFXHU1MzlGXHU3NkVFXHU1RjU1KVx1MzAwMk5TSVMgYXNzaXN0ZWQgXHU4OUM0XHU1MjE5OlxyXG4gICAgLy8gL1MgXHU0RTE0IC9EPXBhdGggXHU1RkM1XHU5ODdCXHU2NzAwXHU1NDBFXHU0RTAwXHU0RTJBXHU1M0MyXHU2NTcwXHUzMDAxXHU1MDNDXHU0RTBEXHU1MkEwXHU1RjE1XHU1M0Y3KFx1NTQyQlx1N0E3QVx1NjgzQ1x1NEU1Rlx1NEUwRFx1NTJBMClcdTIwMTRcdTIwMTRub2RlIHNwYXduXHJcbiAgICAvLyBcdTlFRDhcdThCQTRcdTRGMUFcdTdFRDlcdTU0MkJcdTdBN0FcdTY4M0NcdTUzQzJcdTY1NzBcdTUyQTBcdTVGMTVcdTUzRjdcdTVCRkNcdTgxRjQgTlNJUyBcdTg5RTNcdTY3OTBcdTk1MTlcdThERUZcdTVGODQoXHU1QjlFXHU2RDRCXHU4OEM1XHU1NzRGXHU3NkVFXHU1RjU1KSxcdTY1NDVcdTc1MjhcclxuICAgIC8vIHdpbmRvd3NWZXJiYXRpbUFyZ3VtZW50cyBcdTUzOUZcdTY4MzdcdTRGMjBcdTkwMTJcdTMwMDJcclxuICAgIGNvbnN0IGluc3RhbGxEaXIgPSBkaXJuYW1lKHByb2Nlc3MuZXhlY1BhdGgpO1xyXG4gICAgY29uc3QgY2hpbGQgPSBzcGF3bihgXCIke2luc3RhbGxlclBhdGh9XCIgL1MgL0Q9JHtpbnN0YWxsRGlyfWAsIHtcclxuICAgICAgZGV0YWNoZWQ6IHRydWUsXHJcbiAgICAgIHN0ZGlvOiAnaWdub3JlJyxcclxuICAgICAgd2luZG93c0hpZGU6IHRydWUsXHJcbiAgICAgIHNoZWxsOiBmYWxzZSxcclxuICAgICAgd2luZG93c1ZlcmJhdGltQXJndW1lbnRzOiB0cnVlLFxyXG4gICAgfSk7XHJcbiAgICBjaGlsZC51bnJlZigpO1xyXG4gICAgbG9nSW5mbygndXBkYXRlJywgYGFwcGx5OiAke2luc3RhbGxlclBhdGh9IFx1MjE5MiAke2luc3RhbGxEaXJ9YCk7XHJcbiAgICBhcHAuZXhpdCgwKTtcclxuICB9XHJcblxyXG4gIGZ1bmN0aW9uIGJ1aWxkQXBwTWVudSgpOiB2b2lkIHtcclxuICAgIC8vIFx1N0NCRVx1N0I4MDpcdTUzRUFcdTRGRERcdTc1NTkgVUkgXHU2Q0ExXHU2NzA5XHU3Njg0XHU3Q0ZCXHU3RURGXHU3RUE3XHU4MEZEXHU1MjlCKFx1NTI2QVx1OEQzNFx1Njc3Ri9cdTdBOTdcdTUzRTMpO1x1NTE3Nlx1NEY1OVx1NTUyRlx1NEUwMFx1NTE2NVx1NTNFM1x1NTcyOCBVSVx1MzAwMlxyXG4gICAgY29uc3QgdGVtcGxhdGU6IEFycmF5PEVsZWN0cm9uLk1lbnVJdGVtQ29uc3RydWN0b3JPcHRpb25zPiA9IFtcclxuICAgICAge1xyXG4gICAgICAgIGxhYmVsOiAnXHU3RjE2XHU4RjkxJyxcclxuICAgICAgICBzdWJtZW51OiBbXHJcbiAgICAgICAgICB7IHJvbGU6ICd1bmRvJywgbGFiZWw6ICdcdTY0QTRcdTk1MDAnIH0sXHJcbiAgICAgICAgICB7IHJvbGU6ICdyZWRvJywgbGFiZWw6ICdcdTkxQ0RcdTUwNUEnIH0sXHJcbiAgICAgICAgICB7IHR5cGU6ICdzZXBhcmF0b3InIH0sXHJcbiAgICAgICAgICB7IHJvbGU6ICdjdXQnLCBsYWJlbDogJ1x1NTI2QVx1NTIwNycgfSxcclxuICAgICAgICAgIHsgcm9sZTogJ2NvcHknLCBsYWJlbDogJ1x1NTkwRFx1NTIzNicgfSxcclxuICAgICAgICAgIHsgcm9sZTogJ3Bhc3RlJywgbGFiZWw6ICdcdTdDOThcdThEMzQnIH0sXHJcbiAgICAgICAgICB7IHJvbGU6ICdzZWxlY3RBbGwnLCBsYWJlbDogJ1x1NTE2OFx1OTAwOScgfSxcclxuICAgICAgICBdLFxyXG4gICAgICB9LFxyXG4gICAgICB7XHJcbiAgICAgICAgbGFiZWw6ICdcdTdBOTdcdTUzRTMnLFxyXG4gICAgICAgIHN1Ym1lbnU6IFtcclxuICAgICAgICAgIHsgcm9sZTogJ21pbmltaXplJywgbGFiZWw6ICdcdTY3MDBcdTVDMEZcdTUzMTYnIH0sXHJcbiAgICAgICAgICB7IHJvbGU6ICd6b29tJywgbGFiZWw6ICdcdTdGMjlcdTY1M0UnIH0sXHJcbiAgICAgICAgICB7IHR5cGU6ICdzZXBhcmF0b3InIH0sXHJcbiAgICAgICAgICB7IHJvbGU6ICdjbG9zZScsIGxhYmVsOiAnXHU1MTczXHU5NUVEJyB9LFxyXG4gICAgICAgIF0sXHJcbiAgICAgIH0sXHJcbiAgICBdO1xyXG4gICAgTWVudS5zZXRBcHBsaWNhdGlvbk1lbnUoTWVudS5idWlsZEZyb21UZW1wbGF0ZSh0ZW1wbGF0ZSkpO1xyXG4gIH1cclxuICAvKiogXHU2ODA3XHU5ODk4XHU2ODBGIFx1MjYzMCBcdTRFM0JcdTgzRENcdTUzNTUoXHU1RTM4XHU3NTI4XHU1MkE4XHU0RjVDXHU3Njg0XHU1NTJGXHU0RTAwXHU1MTY1XHU1M0UzO1x1ODlDNlx1NTZGRVx1NjAwMVx1N0VDRiBtZW51OmFjdGlvbiBcdThGNkNcdTUzRDEpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gcG9wdXBNYWluTWVudSgpOiB2b2lkIHtcclxuICAgIGNvbnN0IHNlbmQgPSAoYTogc3RyaW5nKTogdm9pZCA9PiB7XHJcbiAgICAgIGZvciAoY29uc3QgdyBvZiBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKSkge1xyXG4gICAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ21lbnU6YWN0aW9uJywgYSk7XHJcbiAgICAgIH1cclxuICAgIH07XHJcbiAgICBjb25zdCB3aW4gPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5maW5kKCh3KSA9PiAhdy5pc0Rlc3Ryb3llZCgpKTtcclxuICAgIGlmICh3aW4gPT09IHVuZGVmaW5lZCkgcmV0dXJuO1xyXG4gICAgTWVudS5idWlsZEZyb21UZW1wbGF0ZShbXHJcbiAgICAgIHsgbGFiZWw6ICdcdTY1QjBcdTVFRkFcdTRGMUFcdThCREQnLCBhY2NlbGVyYXRvcjogJ0NtZE9yQ3RybCtOJywgY2xpY2s6ICgpOiB2b2lkID0+IHNlbmQoJ25ldy1zZXNzaW9uJykgfSxcclxuICAgICAgeyBsYWJlbDogJ1x1OEJCRVx1N0Y2RScsIGFjY2VsZXJhdG9yOiAnQ21kT3JDdHJsK1NoaWZ0K1AnLCBjbGljazogKCk6IHZvaWQgPT4gc2VuZCgnb3Blbi1zZXR0aW5ncycpIH0sXHJcbiAgICAgIHsgbGFiZWw6ICdcdTVGRUJcdTYzNzdcdTk1MkUnLCBhY2NlbGVyYXRvcjogJ0NtZE9yQ3RybCsvJywgY2xpY2s6ICgpOiB2b2lkID0+IHNlbmQoJ3Nob3J0Y3V0cycpIH0sXHJcbiAgICAgIHsgdHlwZTogJ3NlcGFyYXRvcicgfSxcclxuICAgICAgeyBsYWJlbDogJ1x1NjI0Qlx1NjczQVx1OEZEQ1x1N0EwQlx1NjNBN1x1NTIzNicsIGNsaWNrOiAoKTogdm9pZCA9PiBzZW5kKCdvcGVuLXJlbW90ZScpIH0sXHJcbiAgICAgIHsgdHlwZTogJ3NlcGFyYXRvcicgfSxcclxuICAgICAge1xyXG4gICAgICAgIGxhYmVsOiB1cGRhdGVTdGF0ZS5kb3dubG9hZGVkID8gYFx1OTFDRFx1NTQyRlx1NUU3Nlx1NUI4OVx1ODhDNVx1NjZGNFx1NjVCMCh2JHt1cGRhdGVTdGF0ZS5sYXRlc3QgPz8gJz8nfSlgIDogJ1x1NjhDMFx1NjdFNVx1NjZGNFx1NjVCMFx1MjAyNicsXHJcbiAgICAgICAgY2xpY2s6ICgpOiB2b2lkID0+IHtcclxuICAgICAgICAgIGlmICh1cGRhdGVTdGF0ZS5kb3dubG9hZGVkKSB7IGFwcGx5VXBkYXRlKCk7IHJldHVybjsgfVxyXG4gICAgICAgICAgdm9pZCBjaGVja0ZvclVwZGF0ZXMoKS50aGVuKChzdCkgPT4ge1xyXG4gICAgICAgICAgICBjb25zdCBuZXdlciA9IHN0LmxhdGVzdCAhPT0gbnVsbCAmJiBjbXBWZXJzaW9uKHN0LmN1cnJlbnRWZXJzaW9uLCBzdC5sYXRlc3QpIDwgMDtcclxuICAgICAgICAgICAgY29uc3QgZGV0YWlsID0gbmV3ZXIgPyBgJHtzdC5ub3Rlc31cXG5cXG5cdTVCODlcdTg4QzVcdTUzMDVcdTZCNjNcdTU3MjhcdTU0MEVcdTUzRjBcdTRFMEJcdThGN0QsXHU1QjhDXHU2MjEwXHU1NDBFIFx1MjYzMCBcdTgzRENcdTUzNTVcdTRGMUFcdTUxRkFcdTczQjBcIlx1OTFDRFx1NTQyRlx1NUU3Nlx1NUI4OVx1ODhDNVx1NjZGNFx1NjVCMFwiXHUzMDAyYCA6ICcnO1xyXG4gICAgICAgICAgICB2b2lkIGRpYWxvZy5zaG93TWVzc2FnZUJveCh3aW4sIHtcclxuICAgICAgICAgICAgICB0eXBlOiAnaW5mbycsXHJcbiAgICAgICAgICAgICAgdGl0bGU6ICdcdTY4QzBcdTY3RTVcdTY2RjRcdTY1QjAnLFxyXG4gICAgICAgICAgICAgIG1lc3NhZ2U6IG5ld2VyXHJcbiAgICAgICAgICAgICAgICA/IGBcdTUzRDFcdTczQjBcdTY1QjBcdTcyNDhcdTY3MkMgdiR7c3QubGF0ZXN0fSFgXHJcbiAgICAgICAgICAgICAgICA6IChzdC5lcnJvciAhPT0gJycgPyBgXHU2OEMwXHU2N0U1XHU1OTMxXHU4RDI1OiR7c3QuZXJyb3J9YCA6IGBcdTVERjJcdTY2MkZcdTY3MDBcdTY1QjBcdTcyNDhcdTY3MkModiR7c3QuY3VycmVudFZlcnNpb259KWApLFxyXG4gICAgICAgICAgICAgIGRldGFpbCxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICB9KTtcclxuICAgICAgICB9LFxyXG4gICAgICB9LFxyXG4gICAgICB7XHJcbiAgICAgICAgbGFiZWw6ICdcdTUxNzNcdTRFOEUgSE1IIERlc2t0b3AnLFxyXG4gICAgICAgIGNsaWNrOiAoKTogdm9pZCA9PiB7XHJcbiAgICAgICAgICB2b2lkIGRpYWxvZy5zaG93TWVzc2FnZUJveCh3aW4sIHtcclxuICAgICAgICAgICAgdHlwZTogJ2luZm8nLFxyXG4gICAgICAgICAgICB0aXRsZTogJ1x1NTE3M1x1NEU4RSBITUggRGVza3RvcCcsXHJcbiAgICAgICAgICAgIG1lc3NhZ2U6ICdITUggRGVza3RvcCcsXHJcbiAgICAgICAgICAgIGRldGFpbDogYFx1NjcyQ1x1NTczMFx1NEYxOFx1NTE0OFx1NzY4NCBITUggQWdlbnQgXHU1NkZFXHU1RjYyXHU1REU1XHU0RjVDXHU1M0YwIHYke2FwcC5nZXRWZXJzaW9uKCl9XFxucnVudGltZTogaG1oYXJuZXNzICR7YnJpZGdlLmhvc3RWZXJzaW9uID8/ICcoXHU2NzJBXHU4RkRFXHU2M0E1KSd9JHt1c2VCdW5kbGVkUnVudGltZSA/ICcoXHU1MTg1XHU3RjZFKScgOiAnJ31cXG5cdTZBMjFcdTVGMEY6ICR7YnJpZGdlLm1vZGUgPT09ICdyZWFsJyA/ICh1c2VCdW5kbGVkUnVudGltZSA/ICdcdTc3MUZcdTVCOUUgaG1oYXJuZXNzKFx1NTE4NVx1N0Y2RSBydW50aW1lKScgOiAnXHU3NzFGXHU1QjlFIGhtaGFybmVzcyhcdTU5MTZcdTkwRThcdTVCODlcdTg4QzUpJykgOiAnXHU2RjE0XHU3OTNBKFx1NTA0N1x1NjU3MFx1NjM2RSknfVxcblxcblx1NEUwRSBDTEkgLyBUVUkgLyBcdTdGNTFcdTk4NzVcdTcyNDhcdTUxNzFcdTRFQUJcdTU0MENcdTRFMDAgSE1IX0hPTUVcdTMwMDJgLFxyXG4gICAgICAgICAgfSk7XHJcbiAgICAgICAgfSxcclxuICAgICAgfSxcclxuICAgICAgeyBsYWJlbDogJ1x1OTAwMFx1NTFGQScsIHJvbGU6ICdxdWl0JyB9LFxyXG4gICAgXSkucG9wdXAoeyB3aW5kb3c6IHdpbiB9KTtcclxuICB9XHJcblxyXG4gIC8qIC0tLS0gXHU2MjRCXHU2NzNBXHU4RkRDXHU3QTBCXHU2M0E3XHU1MjM2KDAzIFx1NTNGNzpXZWIgNzc4OCBcdTY2MkZcdTZENEZcdTg5QzhcdTU2NjgvXHU4RkRDXHU3QTBCL1x1NjI0Qlx1NjczQVx1NTE2NVx1NTNFMyxBRFItMDA1OlxyXG4gICAgIERlc2t0b3AgXHU0RTBEXHU5RUQ4XHU4QkE0XHU2MjUzXHU1RjAwIExBTiBcdTIwMTRcdTIwMTQgXHU4RkQ5XHU5MUNDXHU2NjJGXHU3NTI4XHU2MjM3XHU2NjNFXHU1RjBGXHU1NDJGXHU1MkE4XHU3Njg0XHU1MTY1XHU1M0UzKSAtLS0tICovXHJcbiAgY29uc3QgV0VCX1BPUlQgPSA3Nzg4O1xyXG4gIGFzeW5jIGZ1bmN0aW9uIHByb2JlV2ViUmVtb3RlKCk6IFByb21pc2U8eyB1cDogYm9vbGVhbjsgdmVyc2lvbjogc3RyaW5nIH0+IHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHIgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke1dFQl9QT1JUfS9hcGkvc3RhdGVgLCB7IHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCgxNTAwKSB9KTtcclxuICAgICAgaWYgKCFyLm9rKSByZXR1cm4geyB1cDogZmFsc2UsIHZlcnNpb246ICcnIH07XHJcbiAgICAgIGNvbnN0IGQgPSAoYXdhaXQgci5qc29uKCkpIGFzIHsgZGFlbW9uVmVyc2lvbj86IHN0cmluZyB9O1xyXG4gICAgICByZXR1cm4geyB1cDogdHJ1ZSwgdmVyc2lvbjogU3RyaW5nKGQuZGFlbW9uVmVyc2lvbiA/PyAnJykgfTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4geyB1cDogZmFsc2UsIHZlcnNpb246ICcnIH07IH1cclxuICB9XHJcbiAgLyoqIFx1NUYwMFx1NjczQVx1ODFFQVx1NTQyRlx1NjYyRlx1NTQyNlx1NURGMlx1ODhDNShydW50aW1lIHdlYi1kYWVtb24gXHU3Njg0XHU1NDJGXHU1MkE4XHU5ODc5XHU2NTg3XHU0RUY2XHU1QjU4XHU1NzI4XHU2MDI3OzAuMjMuMzcgXHU2NUIwXHU4MEZEXHU1MjlCKVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIHdlYkF1dG9zdGFydEluc3RhbGxlZCgpOiBib29sZWFuIHtcclxuICAgIGNvbnN0IGhvbWUgPSBwcm9jZXNzLmVudi5IT01FID8/ICcnO1xyXG4gICAgY29uc3QgY2FuZGlkYXRlcyA9IHByb2Nlc3MucGxhdGZvcm0gPT09ICd3aW4zMidcclxuICAgICAgPyBbam9pbihwcm9jZXNzLmVudi5BUFBEQVRBID8/ICcnLCAnTWljcm9zb2Z0JywgJ1dpbmRvd3MnLCAnU3RhcnQgTWVudScsICdQcm9ncmFtcycsICdTdGFydHVwJywgJ2htaGFybmVzcy13ZWItZGFlbW9uLmNtZCcpXVxyXG4gICAgICA6IHByb2Nlc3MucGxhdGZvcm0gPT09ICdkYXJ3aW4nXHJcbiAgICAgICAgPyBbam9pbihob21lLCAnTGlicmFyeScsICdMYXVuY2hBZ2VudHMnLCAnaG1oYXJuZXNzLXdlYi1kYWVtb24ucGxpc3QnKV1cclxuICAgICAgICA6IFtqb2luKGhvbWUsICcuY29uZmlnJywgJ3N5c3RlbWQnLCAndXNlcicsICdobWhhcm5lc3Mtd2ViLWRhZW1vbi5zZXJ2aWNlJyldO1xyXG4gICAgcmV0dXJuIGNhbmRpZGF0ZXMuc29tZSgocCkgPT4geyB0cnkgeyByZXR1cm4gZXhpc3RzU3luYyhwKTsgfSBjYXRjaCB7IHJldHVybiBmYWxzZTsgfSB9KTtcclxuICB9XHJcbiAgLyoqIFx1NjI0Qlx1NjczQVx1NTNFRlx1OERFRlx1NzUzMVx1NzY4NCBMQU4gSVAoUkZDMTkxOCxcdTYzOTJcdTk2NjRcdTg2NUFcdTYyREZcdTdGNTFcdTUzNjEpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gbGFuSXBPZigpOiBzdHJpbmcge1xyXG4gICAgY29uc3QgVklSVFVBTCA9IC92bXdhcmV8dmlydHVhbHxoeXBlci0/dnx2ZXRoZXJuZXR8d3NsfHRhaWxzY2FsZXxsb29wYmFja3xibHVldG9vdGh8dmJveHxkb2NrZXJ8dGFwLXxwc2V1ZG8vaTtcclxuICAgIGNvbnN0IGlzUmZjMTkxOCA9IChhOiBzdHJpbmcpOiBib29sZWFuID0+IC9eMTBcXC4vLnRlc3QoYSkgfHwgL14xOTJcXC4xNjhcXC4vLnRlc3QoYSkgfHwgL14xNzJcXC4oMVs2LTldfDJcXGR8M1swMV0pXFwuLy50ZXN0KGEpO1xyXG4gICAgbGV0IGxhbklwID0gJyc7XHJcbiAgICBsZXQgZmFsbGJhY2sgPSAnJztcclxuICAgIGZvciAoY29uc3QgW25hbWUsIGxpc3RdIG9mIE9iamVjdC5lbnRyaWVzKG5ldHdvcmtJbnRlcmZhY2VzKCkpKSB7XHJcbiAgICAgIGZvciAoY29uc3QgbiBvZiBsaXN0ID8/IFtdKSB7XHJcbiAgICAgICAgaWYgKG4uZmFtaWx5ICE9PSAnSVB2NCcgfHwgbi5pbnRlcm5hbCB8fCAhaXNSZmMxOTE4KG4uYWRkcmVzcykpIGNvbnRpbnVlO1xyXG4gICAgICAgIGlmICghVklSVFVBTC50ZXN0KG5hbWUpKSBsYW5JcCA9IGxhbklwIHx8IG4uYWRkcmVzcztcclxuICAgICAgICBlbHNlIGZhbGxiYWNrID0gZmFsbGJhY2sgfHwgbi5hZGRyZXNzO1xyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gbGFuSXAgfHwgZmFsbGJhY2s7XHJcbiAgfVxyXG4gIC8qKiBDTEkgXHU1MTY1XHU1M0UzOlx1NkU5MFx1NzgwMSByZXBvIFx1NUUwM1x1NUM0MChtYWluLnRzLFx1N0VDRiB0c3gpXHU2MjE2IG5wbSBcdTVCODlcdTg4QzVcdTVFMDNcdTVDNDAoZGlzdC9tYWluLmpzXHJcbiAgICogIFx1NzZGNFx1OEREMVx1MjAxNFx1MjAxNFx1NEVDRSBydW50aW1lIFx1NTE2NVx1NTNFM1x1NEUwQVx1NkVBRlx1NjI3RSBAaG1oYXJuZXNzL2NsaSBcdTUzMDU7XHU1RDRDXHU1OTU3L1x1NjNEMFx1NTM0Ny9cdTZFOTBcdTc4MDFcdTRFMDlcdTc5Q0RcdTVFMDNcdTVDNDBcdTkwMUFcdTU0MDMpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gY2xpRW50cnlPZigpOiBzdHJpbmcge1xyXG4gICAgaWYgKHJ1bnRpbWVFbnRyeSA9PT0gJycgfHwgcnVudGltZUVudHJ5ID09PSBudWxsKSByZXR1cm4gJyc7XHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCBwID0gam9pbihyZXBvUm9vdE9mKHJ1bnRpbWVFbnRyeSksICdwYWNrYWdlcycsICdjbGknLCAnc3JjJywgJ21haW4udHMnKTtcclxuICAgICAgaWYgKGV4aXN0c1N5bmMocCkpIHJldHVybiBwO1xyXG4gICAgfSBjYXRjaCB7IC8qIFx1OTc1RSByZXBvIFx1NUUwM1x1NUM0MCAqLyB9XHJcbiAgICBsZXQgZGlyID0gZGlybmFtZShydW50aW1lRW50cnkpO1xyXG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCA4OyBpKyspIHtcclxuICAgICAgaWYgKGV4aXN0c1N5bmMoam9pbihkaXIsICdkaXN0JywgJ21haW4uanMnKSkgJiYgcGtnTmFtZUF0KGRpcikgPT09ICdAaG1oYXJuZXNzL2NsaScpIHJldHVybiBqb2luKGRpciwgJ2Rpc3QnLCAnbWFpbi5qcycpO1xyXG4gICAgICBpZiAoYmFzZW5hbWUoZGlyKSA9PT0gJ0BobWhhcm5lc3MnICYmIGV4aXN0c1N5bmMoam9pbihkaXIsICdjbGknLCAnZGlzdCcsICdtYWluLmpzJykpKSByZXR1cm4gam9pbihkaXIsICdjbGknLCAnZGlzdCcsICdtYWluLmpzJyk7XHJcbiAgICAgIGNvbnN0IHBhcmVudCA9IGRpcm5hbWUoZGlyKTtcclxuICAgICAgaWYgKHBhcmVudCA9PT0gZGlyKSBicmVhaztcclxuICAgICAgZGlyID0gcGFyZW50O1xyXG4gICAgfVxyXG4gICAgcmV0dXJuICcnO1xyXG4gIH1cclxuICBmdW5jdGlvbiBydW5DbGkoYXJnczogc3RyaW5nW10pOiB2b2lkIHtcclxuICAgIGNvbnN0IGVudHJ5ID0gY2xpRW50cnlPZigpO1xyXG4gICAgaWYgKGVudHJ5ID09PSAnJykgcmV0dXJuO1xyXG4gICAgY29uc3QgaXNUcyA9IGVudHJ5LmVuZHNXaXRoKCcudHMnKTtcclxuICAgIGNvbnN0IHJlcG8gPSByZXBvUm9vdE9mKHJ1bnRpbWVFbnRyeSA/PyBlbnRyeSk7XHJcbiAgICBjb25zdCBjaGlsZCA9IHNwYXduKHByb2Nlc3MuZXhlY1BhdGgsIGlzVHMgPyBbJy0taW1wb3J0JywgJ3RzeCcsIGVudHJ5LCAuLi5hcmdzXSA6IFtlbnRyeSwgLi4uYXJnc10sIHtcclxuICAgICAgY3dkOiBpc1RzID8gcmVwbyA6IGRpcm5hbWUoZW50cnkpLFxyXG4gICAgICBkZXRhY2hlZDogdHJ1ZSxcclxuICAgICAgc3RkaW86ICdpZ25vcmUnLFxyXG4gICAgICB3aW5kb3dzSGlkZTogdHJ1ZSxcclxuICAgICAgZW52OiB7IEVMRUNUUk9OX1JVTl9BU19OT0RFOiAnMScgfSxcclxuICAgIH0pO1xyXG4gICAgY2hpbGQudW5yZWYoKTtcclxuICB9XHJcblxyXG4gIGZ1bmN0aW9uIGJyb2FkY2FzdEhvc3RTdGF0ZShzOiBIb3N0U3RhdGUsIGluZm86IHsgcmVzdGFydENvdW50OiBudW1iZXI7IGxhc3RFcnJvcj86IHN0cmluZyB9KTogdm9pZCB7XHJcbiAgICBicmlkZ2UgPSB7IC4uLmJyaWRnZSwgaG9zdFN0YXRlOiBzLCBob3N0UG9ydDogc3VwZXJ2aXNvcj8uZW5kcG9pbnQ/LnBvcnQgPz8gbnVsbCwgaG9zdFZlcnNpb246IHN1cGVydmlzb3I/LmVuZHBvaW50Py52ZXJzaW9uID8/IG51bGwgfTtcclxuICAgIGxvZ0luZm8oJ2hvc3QnLCBgc3RhdGU9JHtzfSR7aW5mby5sYXN0RXJyb3IgIT09IHVuZGVmaW5lZCA/IGAgZXJyPSR7aW5mby5sYXN0RXJyb3J9YCA6ICcnfWApO1xyXG4gICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XHJcbiAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ2JyaWRnZTpob3N0LXN0YXRlJywgcywgaW5mbyk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvKiogU1NFIFx1NkQ0MVx1OEJBMlx1OTYwNTpcdTRGRTFcdTVDMDEoZXZlbnQ6IGhtaClcdTYyNzlcdTkxQ0ZcdTYzQTggcmVuZGVyZXI7XHU5QUQ4XHU5ODkxIGRlbHRhL2xpbmUgXHU1MzlGXHU1RTI3XHJcbiAgICogIFx1NEY1Q1x1NEUzQVx1NkQ0MVx1NTc1N1x1OEY2Q1x1NTNEMShyZW5kZXJlciBcdTYyRkNcdTYzQTVcdTVGNTNcdTUyNEQgYXNzaXN0YW50IFx1NTM2MFx1NEY0RClcdTMwMDJcdTY1QURcdTdFQkZcdTgxRUFcdTUyQThcdTkxQ0RcdThGREVcdTMwMDIgKi9cclxuICBhc3luYyBmdW5jdGlvbiBwdW1wRXZlbnRzKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgaWYgKGNsaWVudCA9PT0gbnVsbCkgcmV0dXJuO1xyXG4gICAgZm9yICg7Oykge1xyXG4gICAgICBjb25zdCBjID0gY2xpZW50O1xyXG4gICAgICBpZiAoYyA9PT0gbnVsbCkgcmV0dXJuO1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGZvciBhd2FpdCAoY29uc3QgZnJhbWUgb2YgYy5yYXdFdmVudHMobGFzdEV2ZW50SWQgPT09ICcnID8gdW5kZWZpbmVkIDogbGFzdEV2ZW50SWQsIHNzZUFib3J0Py5zaWduYWwpKSB7XHJcbiAgICAgICAgICBpZiAoZnJhbWUuZXZlbnQgPT09ICdobWgnKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGVudiA9IGVudmVsb3BlRnJvbUZyYW1lKGZyYW1lKTtcclxuICAgICAgICAgICAgaWYgKGVudiA9PT0gbnVsbCkge1xyXG4gICAgICAgICAgICAgIGRyb3BwZWRGcmFtZXMgKz0gMTtcclxuICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBsYXN0RXZlbnRJZCA9IGVudi5ldmVudElkO1xyXG4gICAgICAgICAgICBwdXNoRXZlbnQoZW52KTtcclxuICAgICAgICAgIH0gZWxzZSBpZiAoZnJhbWUuZXZlbnQgPT09ICdkZWx0YScgfHwgZnJhbWUuZXZlbnQgPT09ICdsaW5lJykge1xyXG4gICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgIGNvbnN0IGQgPSBKU09OLnBhcnNlKGZyYW1lLmRhdGEpIGFzIHsgc2Vzc2lvbklkPzogc3RyaW5nOyBrPzogc3RyaW5nOyBjaHVuaz86IHN0cmluZzsgdGV4dD86IHN0cmluZyB9O1xyXG4gICAgICAgICAgICAgIGNvbnN0IHBheWxvYWQgPSBmcmFtZS5ldmVudCA9PT0gJ2RlbHRhJ1xyXG4gICAgICAgICAgICAgICAgPyB7IHNlc3Npb25JZDogZC5zZXNzaW9uSWQgPz8gJycsIGtpbmQ6IGQuayA/PyAndGV4dCcsIGNodW5rOiBTdHJpbmcoZC5jaHVuayA/PyAnJykgfVxyXG4gICAgICAgICAgICAgICAgOiB7IHNlc3Npb25JZDogZC5zZXNzaW9uSWQgPz8gJycsIGtpbmQ6ICdsaW5lJywgY2h1bms6IFN0cmluZyhkLnRleHQgPz8gJycpIH07XHJcbiAgICAgICAgICAgICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XHJcbiAgICAgICAgICAgICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCdicmlkZ2U6c3RyZWFtLWNodW5rJywgcGF5bG9hZCk7XHJcbiAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9IGNhdGNoIHsgLyogbWFsZm9ybWVkIHN0cmVhbSBmcmFtZTogc2tpcCAqLyB9XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybjsgLy8gXHU2RDQxXHU2QjYzXHU1RTM4XHU3RUQzXHU2NzVGKGhvc3QgXHU1MTczXHU5NUVEKVxyXG4gICAgICB9IGNhdGNoIHtcclxuICAgICAgICAvLyBcdTY1QURcdTdFQkY6XHU3N0VEXHU5MDAwXHU5MDdGXHU1NDBFXHU5MUNEXHU4RkRFKHN1cGVydmlzb3IgXHU1M0VGXHU4MEZEXHU2QjYzXHU1NzI4XHU5MUNEXHU1NDJGIGhvc3QpXHJcbiAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgMV8wMDApKTtcclxuICAgICAgICBpZiAoc3NlQWJvcnQ/LnNpZ25hbC5hYm9ydGVkKSByZXR1cm47XHJcbiAgICAgIH1cclxuICAgIH1cclxuICB9XHJcblxyXG4gIC8qIC0tLS0gaG1oYXJuZXNzIHJ1bnRpbWUgXHU4MUVBXHU1MkE4XHU1M0QxXHU3M0IwKDIwMjYtMTAtMTAgXHU3NTI4XHU2MjM3XHU1QjlBXHU4QzAzOlx1ODhDNVx1OEZDNyBobWhhcm5lc3MgXHU3Njg0XHJcbiAgICAgXHU2NzNBXHU1NjY4XHU5NkY2XHU5MTREXHU3RjZFXHU3NkY0XHU4RkRFLFx1NTkwRFx1NzUyOCBDTEkvVFVJL3dlYiA3Nzg4IFx1NzY4NFx1NTQwQ1x1NEUwMCBITUhfSE9NRVx1MjAxNFx1MjAxNGNvbmZpZy9wcm92aWRlcnMvXHJcbiAgICAgXHU0RjFBXHU4QkREXHU1Mzg2XHU1M0YyXHU1OTI5XHU3MTM2XHU1MTcxXHU0RUFCKVx1MzAwMnY1LjEgXHU1M0QxXHU3M0IwXHU5ODdBXHU1RThGOlx1NjYzRVx1NUYwRlx1OTE0RFx1N0Y2RSA+IHdoZXJlIGhtaChcdTZFOTBcdTc4MDEgbGluayBcdTRFMEVcclxuICAgICBAaG1oYXJuZXNzL2NsaSBucG0gXHU1Qjg5XHU4OEM1XHU0RTI0XHU3OUNEXHU1RTAzXHU1QzQwKT4gbnBtIFx1NTE2OFx1NUM0MFx1NjgzOShcdTU0MEMpPiBcdTU0MTFcdTVCRkNcdTVCODlcdTg4QzVcdTc2RUVcdTVGNTVcclxuICAgICB+Ly5obWhhcm5lc3MtZ2xvYmFsID4gXHU1RTM4XHU4OUMxXHU2RTkwXHU3ODAxXHU0RjREXHU3RjZFXHUzMDAyICovXHJcbiAgY29uc3QgcnVudGltZUNvbmZpZ0ZpbGUgPSAoKTogc3RyaW5nID0+IGpvaW4oYXBwLmdldFBhdGgoJ3VzZXJEYXRhJyksICdydW50aW1lLmpzb24nKTtcclxuICAvKiogcnVudGltZS5qc29uOnsgZW50cnkoXHU2MjRCXHU1MkE4L1x1NTQxMVx1NUJGQ1x1OTAwOVx1NjJFOVx1NzY4NFx1NTE2NVx1NTNFMyksIGRlbW8oXHU2MzAxXHU0RTQ1XHU2RjE0XHU3OTNBXHU2QTIxXHU1RjBGKSB9XHUzMDAyICovXHJcbiAgYXN5bmMgZnVuY3Rpb24gbG9hZFJ1bnRpbWVDb25maWcoKTogUHJvbWlzZTx7IGVudHJ5OiBzdHJpbmc7IGRlbW86IGJvb2xlYW4gfT4ge1xyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3QgdiA9IEpTT04ucGFyc2UoYXdhaXQgcmVhZEZpbGUocnVudGltZUNvbmZpZ0ZpbGUoKSwgJ3V0ZjgnKSkgYXMgeyBlbnRyeT86IHVua25vd247IGRlbW8/OiB1bmtub3duIH07XHJcbiAgICAgIHJldHVybiB7XHJcbiAgICAgICAgZW50cnk6IHR5cGVvZiB2LmVudHJ5ID09PSAnc3RyaW5nJyAmJiB2LmVudHJ5ICE9PSAnJyAmJiBpc0Fic29sdXRlKHYuZW50cnkpID8gdi5lbnRyeSA6ICcnLFxyXG4gICAgICAgIGRlbW86IHYuZGVtbyA9PT0gdHJ1ZSxcclxuICAgICAgfTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4geyBlbnRyeTogJycsIGRlbW86IGZhbHNlIH07IH1cclxuICB9XHJcbiAgYXN5bmMgZnVuY3Rpb24gc2F2ZVJ1bnRpbWVDb25maWcoY2ZnOiB7IGVudHJ5OiBzdHJpbmc7IGRlbW86IGJvb2xlYW4gfSk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgYXdhaXQgd3JpdGVGaWxlKHJ1bnRpbWVDb25maWdGaWxlKCksIEpTT04uc3RyaW5naWZ5KGNmZywgbnVsbCwgMiksICd1dGY4JykuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcclxuICB9XHJcbiAgYXN5bmMgZnVuY3Rpb24gbG9hZFJ1bnRpbWVFbnRyeU92ZXJyaWRlKCk6IFByb21pc2U8c3RyaW5nPiB7XHJcbiAgICByZXR1cm4gKGF3YWl0IGxvYWRSdW50aW1lQ29uZmlnKCkpLmVudHJ5O1xyXG4gIH1cclxuICBhc3luYyBmdW5jdGlvbiBzYXZlUnVudGltZUVudHJ5T3ZlcnJpZGUoZW50cnk6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgYXdhaXQgc2F2ZVJ1bnRpbWVDb25maWcoeyBlbnRyeSwgZGVtbzogKGF3YWl0IGxvYWRSdW50aW1lQ29uZmlnKCkpLmRlbW8gfSk7XHJcbiAgfVxyXG5cclxuICBpbnRlcmZhY2UgRXh0ZXJuYWxSdW50aW1lIHsgZW50cnk6IHN0cmluZzsgdmVyc2lvbjogc3RyaW5nOyBzb3VyY2U6IHN0cmluZyB9XHJcblxyXG4gIC8qKiBcdThCRkJcdTUzMDVcdTcyNDhcdTY3MkMocGFja2FnZS5qc29uIFx1NzY4NCB2ZXJzaW9uIFx1NUI1N1x1NkJCNTtcdTU5MzFcdThEMjVcdTdBN0FcdTRFMzIpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gcGtnVmVyc2lvbkF0KGRpcjogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHYgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKGRpciwgJ3BhY2thZ2UuanNvbicpLCAndXRmOCcpKSBhcyB7IHZlcnNpb24/OiB1bmtub3duIH07XHJcbiAgICAgIHJldHVybiB0eXBlb2Ygdi52ZXJzaW9uID09PSAnc3RyaW5nJyA/IHYudmVyc2lvbiA6ICcnO1xyXG4gICAgfSBjYXRjaCB7IHJldHVybiAnJzsgfVxyXG4gIH1cclxuICAvKiogXHU4QkZCXHU1MzA1XHU1NDBEKFx1NTQwQ1x1NEUwQTtAaG1oYXJuZXNzL2NsaSBcdTVFMDNcdTVDNDBcdThCQzZcdTUyMkJcdTc1MjgpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gcGtnTmFtZUF0KGRpcjogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHYgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKGRpciwgJ3BhY2thZ2UuanNvbicpLCAndXRmOCcpKSBhcyB7IG5hbWU/OiB1bmtub3duIH07XHJcbiAgICAgIHJldHVybiB0eXBlb2Ygdi5uYW1lID09PSAnc3RyaW5nJyA/IHYubmFtZSA6ICcnO1xyXG4gICAgfSBjYXRjaCB7IHJldHVybiAnJzsgfVxyXG4gIH1cclxuXHJcbiAgLyoqIG5wbSBcdTVCODlcdTg4QzVcdTc2ODQgQGhtaGFybmVzcy9jbGkgXHUyMTkyIGRlc2t0b3AtaG9zdCBcdTdGMTZcdThCRDFcdTUxNjVcdTUzRTMoXHU1RDRDXHU1OTU3XHU0RTBFXHU2M0QwXHU1MzQ3XHU0RTI0XHU3OUNEXHU1RTAzXHU1QzQwKVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIGVudHJ5RnJvbUNsaURpcihjbGlEaXI6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICBjb25zdCBuZXN0ZWQgPSBqb2luKGNsaURpciwgJ25vZGVfbW9kdWxlcycsICdAaG1oYXJuZXNzJywgJ3dlYicsICdkaXN0JywgJ2Rlc2t0b3AtaG9zdC5qcycpO1xyXG4gICAgaWYgKGV4aXN0c1N5bmMobmVzdGVkKSkgcmV0dXJuIG5lc3RlZDtcclxuICAgIGNvbnN0IGhvaXN0ZWQgPSBqb2luKGRpcm5hbWUoY2xpRGlyKSwgJ3dlYicsICdkaXN0JywgJ2Rlc2t0b3AtaG9zdC5qcycpO1xyXG4gICAgaWYgKGV4aXN0c1N5bmMoaG9pc3RlZCkpIHJldHVybiBob2lzdGVkO1xyXG4gICAgcmV0dXJuICcnO1xyXG4gIH1cclxuXHJcbiAgLyoqIFx1NTkxNlx1OTBFOFx1NTNEMVx1NzNCMChcdTRGOUJcdTgxRUFcdTUyQThcdThGREVcdTYzQTVcdTRFMEVcdTU0MTFcdTVCRkNcdTY4QzBcdTZENEJcdTk4NzVcdTUxNzFcdTc1MjgpXHUzMDAyXHU0RjE4XHU1MTQ4XHU3RUE3OmVudiA+IHdoZXJlIGhtaCA+IG5wbVxyXG4gICAqICBcdTUxNjhcdTVDNDBcdTY4MzkgPiBcdTU0MTFcdTVCRkNcdTVCODlcdTg4QzVcdTc2RUVcdTVGNTUgfi8uaG1oYXJuZXNzLWdsb2JhbCA+IFx1NkU5MFx1NzgwMVx1NEVEM1x1NjI2Qlx1NjNDRjtcdTU0MENcdTRFMDBcdTVDNDJcdTUxODVcclxuICAgKiAgXCJcdTVERjJcdTg4QzUgQ0xJKG5wbSBcdTVFMDNcdTVDNDApXCIgXHU1MTQ4XHU0RThFIFwiXHU2RTkwXHU3ODAxIHJlcG8gXHU1RTAzXHU1QzQwXCJcdTMwMDIgKi9cclxuICBmdW5jdGlvbiBkZXRlY3RFeHRlcm5hbFJ1bnRpbWUoKTogRXh0ZXJuYWxSdW50aW1lIHtcclxuICAgIC8vIDEpIFx1NzNBRlx1NTg4M1x1NTNEOFx1OTFDRlx1NjYzRVx1NUYwRlx1ODk4Nlx1NzZENihcdTlBRDhcdTdFQTdcdTc1MjhcdTYyMzcpXHJcbiAgICBjb25zdCBlbnZFbnRyeSA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1JFQUxfRU5UUlk7XHJcbiAgICBpZiAoZW52RW50cnkgIT09IHVuZGVmaW5lZCAmJiBlbnZFbnRyeSAhPT0gJycgJiYgaXNBYnNvbHV0ZShlbnZFbnRyeSkpIHtcclxuICAgICAgcmV0dXJuIHsgZW50cnk6IGVudkVudHJ5LCB2ZXJzaW9uOiAnJywgc291cmNlOiAnZW52JyB9O1xyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IHdoZXJlUmVwb3MgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgIGNvbnN0IHdoZXJlQ2xpczogc3RyaW5nW10gPSBbXTtcclxuICAgIGNvbnN0IG5wbVJlcG9zID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICBsZXQgbnBtQ2xpID0gJyc7XHJcbiAgICAvLyAyKSB3aGVyZSBobWg6bnBtIGxpbmsoXHU2RTkwXHU3ODAxXHU2ODM5XHU1RTAzXHU1QzQwKVx1NEUwRSBAaG1oYXJuZXNzL2NsaSBucG0gXHU1Qjg5XHU4OEM1XHU1RTAzXHU1QzQwXHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCBvdXQgPSBleGVjRmlsZVN5bmMoJ3doZXJlJywgWydobWgnXSwgeyBlbmNvZGluZzogJ3V0ZjgnLCB0aW1lb3V0OiA0XzAwMCwgd2luZG93c0hpZGU6IHRydWUgfSk7XHJcbiAgICAgIGZvciAoY29uc3QgbGluZSBvZiBvdXQuc3BsaXQoL1xccj9cXG4vKSkge1xyXG4gICAgICAgIGNvbnN0IGJpbiA9IGxpbmUudHJpbSgpO1xyXG4gICAgICAgIGlmIChiaW4gPT09ICcnKSBjb250aW51ZTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgY29uc3QgYmluRGlyID0gZGlybmFtZShiaW4pO1xyXG4gICAgICAgICAgY29uc3QgbGlua2VkID0gam9pbihiaW5EaXIsICdub2RlX21vZHVsZXMnLCAnaG1oYXJuZXNzJyk7XHJcbiAgICAgICAgICBpZiAoZXhpc3RzU3luYyhsaW5rZWQpKSB3aGVyZVJlcG9zLmFkZChyZWFscGF0aFN5bmMobGlua2VkKSk7XHJcbiAgICAgICAgICBjb25zdCBjbGkgPSBqb2luKGJpbkRpciwgJ25vZGVfbW9kdWxlcycsICdAaG1oYXJuZXNzJywgJ2NsaScpO1xyXG4gICAgICAgICAgaWYgKGV4aXN0c1N5bmMoY2xpKSkgd2hlcmVDbGlzLnB1c2goY2xpKTtcclxuICAgICAgICB9IGNhdGNoIHsgLyogYmluIFx1NUUwM1x1NUM0MFx1NEUwRFx1N0IyNixcdThERjNcdThGQzcgKi8gfVxyXG4gICAgICB9XHJcbiAgICB9IGNhdGNoIHsgLyogaG1oIFx1NEUwRFx1NTcyOCBQQVRIICovIH1cclxuICAgIC8vIDMpIG5wbSBcdTUxNjhcdTVDNDBcdTY4MzkoXHU0RTI0XHU3OUNEXHU1RTAzXHU1QzQwXHU1NDBDIHdoZXJlKVxyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3Qgb3V0ID0gZXhlY0ZpbGVTeW5jKCducG0nLCBbJ3Jvb3QnLCAnLWcnXSwgeyBlbmNvZGluZzogJ3V0ZjgnLCB0aW1lb3V0OiA2XzAwMCwgd2luZG93c0hpZGU6IHRydWUgfSk7XHJcbiAgICAgIGNvbnN0IHJvb3QgPSBvdXQudHJpbSgpO1xyXG4gICAgICBjb25zdCBsaW5rZWQgPSBqb2luKHJvb3QsICdobWhhcm5lc3MnKTtcclxuICAgICAgaWYgKGV4aXN0c1N5bmMobGlua2VkKSkgbnBtUmVwb3MuYWRkKHJlYWxwYXRoU3luYyhsaW5rZWQpKTtcclxuICAgICAgY29uc3QgY2xpID0gam9pbihyb290LCAnQGhtaGFybmVzcycsICdjbGknKTtcclxuICAgICAgaWYgKGV4aXN0c1N5bmMoY2xpKSkgbnBtQ2xpID0gY2xpO1xyXG4gICAgfSBjYXRjaCB7IC8qIG5wbSBcdTRFMERcdTUzRUZcdTc1MjggKi8gfVxyXG5cclxuICAgIC8vIFx1NURGMlx1ODhDNSBDTEkoQGhtaGFybmVzcy9jbGkgbnBtIFx1NUUwM1x1NUM0MDtkZXNrdG9wLWhvc3QgXHU0RTNBXHU3RjE2XHU4QkQxXHU0RUE3XHU3MjY5XHU1M0VGXHU3NkY0XHU4REQxKTpcclxuICAgIC8vIHdoZXJlKFBBVEggXHU3NzFGXHU3NkY4KT4gbnBtIFx1NTE2OFx1NUM0MFx1NjgzOSA+IFx1NTQxMVx1NUJGQ1x1NUI4OVx1ODhDNVx1NzZFRVx1NUY1NVxyXG4gICAgZm9yIChjb25zdCBbY2xpLCBzb3VyY2VdIG9mIFtbd2hlcmVDbGlzWzBdID8/ICcnLCAnd2hlcmUtaG1oJ10sIFtucG1DbGksICducG0tZ2xvYmFsJ11dIGFzIEFycmF5PFtzdHJpbmcsIHN0cmluZ10+KSB7XHJcbiAgICAgIGlmIChjbGkgPT09ICcnKSBjb250aW51ZTtcclxuICAgICAgY29uc3QgZW50cnkgPSBlbnRyeUZyb21DbGlEaXIoY2xpKTtcclxuICAgICAgaWYgKGVudHJ5ICE9PSAnJykgcmV0dXJuIHsgZW50cnksIHZlcnNpb246IHBrZ1ZlcnNpb25BdChjbGkpLCBzb3VyY2UgfTtcclxuICAgIH1cclxuICAgIGNvbnN0IHdpemFyZEVudHJ5ID0gcmVzb2x2ZUluc3RhbGxlZEVudHJ5KGluc3RhbGxUYXJnZXQoKSk7XHJcbiAgICBpZiAod2l6YXJkRW50cnkgIT09ICcnKSB7XHJcbiAgICAgIHJldHVybiB7IGVudHJ5OiB3aXphcmRFbnRyeSwgdmVyc2lvbjogcGtnVmVyc2lvbkF0KGpvaW4oaW5zdGFsbFRhcmdldCgpLCAnbm9kZV9tb2R1bGVzJywgJ0BobWhhcm5lc3MnLCAnY2xpJykpLCBzb3VyY2U6ICd3aXphcmQtaW5zdGFsbCcgfTtcclxuICAgIH1cclxuXHJcbiAgICAvLyBcdTZFOTBcdTc4MDEgcmVwbyBcdTVFMDNcdTVDNDAod2hlcmUgPiBucG0gXHU1MTY4XHU1QzQwID4gXHU1RTM4XHU4OUMxXHU2RTkwXHU3ODAxXHU0RjREXHU3RjZFO1x1NTQ3RFx1NEUyRFx1OTg3Qlx1NjcwOVx1NTE2NVx1NTNFM1x1NEUwRVx1NEY5RFx1OEQ1NilcclxuICAgIGNvbnN0IHJlcG9zID0gbmV3IFNldDxzdHJpbmc+KFsuLi53aGVyZVJlcG9zLCAuLi5ucG1SZXBvc10pO1xyXG4gICAgY29uc3QgYmFzZXMgPSBbJ0M6XFxcXCcsICdEOlxcXFwnLCAnRTpcXFxcJywgJ0Y6XFxcXCcsICdHOlxcXFwnLCAnSDpcXFxcJywgaG9tZWRpcigpLCBqb2luKGhvbWVkaXIoKSwgJ0RldmVsb3BlcicpXTtcclxuICAgIGZvciAoY29uc3QgYmFzZSBvZiBiYXNlcykge1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHAgPSByZXNvbHZlKGJhc2UsICdobWhhcm5lc3MnKTtcclxuICAgICAgICBpZiAoZXhpc3RzU3luYyhwKSkgcmVwb3MuYWRkKHApO1xyXG4gICAgICB9IGNhdGNoIHsgLyogXHU3NkQ4XHU0RTBEXHU1QjU4XHU1NzI4ICovIH1cclxuICAgIH1cclxuICAgIGZvciAoY29uc3QgcmVwbyBvZiByZXBvcykge1xyXG4gICAgICBjb25zdCBlbnRyeSA9IGpvaW4ocmVwbywgJ3BhY2thZ2VzJywgJ3dlYicsICdzcmMnLCAnZGVza3RvcC1ob3N0LnRzJyk7XHJcbiAgICAgIGlmIChleGlzdHNTeW5jKGVudHJ5KSAmJiBleGlzdHNTeW5jKGpvaW4ocmVwbywgJ25vZGVfbW9kdWxlcycpKSkge1xyXG4gICAgICAgIHJldHVybiB7IGVudHJ5LCB2ZXJzaW9uOiBwa2dWZXJzaW9uQXQocmVwbyksIHNvdXJjZTogJ3NvdXJjZS1yZXBvJyB9O1xyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4geyBlbnRyeTogJycsIHZlcnNpb246ICcnLCBzb3VyY2U6ICcnIH07XHJcbiAgfVxyXG5cclxuICBmdW5jdGlvbiBkZXRlY3RSZWFsRW50cnkoKTogc3RyaW5nIHtcclxuICAgIHJldHVybiBkZXRlY3RFeHRlcm5hbFJ1bnRpbWUoKS5lbnRyeTtcclxuICB9XHJcblxyXG4gIC8qKiBcdTg5RTNcdTY3OTAgcnVudGltZSBcdTUxNjVcdTUzRTNcdTYyNDBcdTVDNUVcdTc2ODQgaG1oYXJuZXNzIFx1NEVEM1x1NUU5M1x1NjgzOShwYWNrYWdlcy93ZWIvc3JjfGRpc3QgXHU0RTBBXHU2RUFGKVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIHJlcG9Sb290T2YoZW50cnk6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICBsZXQgZGlyID0gZGlybmFtZShlbnRyeSk7XHJcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IDY7IGkrKykge1xyXG4gICAgICBpZiAoZXhpc3RzU3luYyhqb2luKGRpciwgJ3BhY2thZ2UuanNvbicpKSAmJiBleGlzdHNTeW5jKGpvaW4oZGlyLCAncGFja2FnZXMnLCAnd2ViJykpKSByZXR1cm4gZGlyO1xyXG4gICAgICBjb25zdCBwYXJlbnQgPSBkaXJuYW1lKGRpcik7XHJcbiAgICAgIGlmIChwYXJlbnQgPT09IGRpcikgYnJlYWs7XHJcbiAgICAgIGRpciA9IHBhcmVudDtcclxuICAgIH1cclxuICAgIHJldHVybiBkaXJuYW1lKGVudHJ5KTtcclxuICB9XHJcblxyXG4gIGxldCBydW50aW1lRW50cnkgPSAnJzsgLy8gXHU1RjUzXHU1MjREXHU1QjlFXHU5NjQ1XHU0RjdGXHU3NTI4XHU3Njg0XHU3NzFGXHU1QjlFIHJ1bnRpbWUgXHU1MTY1XHU1M0UzKCcnPVx1NjcyQVx1NjNBNSlcclxuICBsZXQgdXNlQnVuZGxlZFJ1bnRpbWUgPSBmYWxzZTsgLy8gdjU6XHU2NjJGXHU1NDI2XHU1NzI4XHU3NTI4XHU1MTg1XHU3RjZFIHJ1bnRpbWUoXHU1MTczXHU0RThFL1x1OTc2Mlx1Njc3Rlx1NjgwN1x1NkNFOClcclxuXHJcbiAgLyoqIFx1NTE4NVx1N0Y2RSBydW50aW1lKHY1IFx1NUYwMFx1N0JCMVx1NTM3M1x1NzUyOCk6XHU2MjUzXHU1MzA1XHU1NDBFXHU5NjhGIGV4dHJhUmVzb3VyY2VzIFx1NUU3M1x1OTRGQVx1NTcyOCByZXNvdXJjZXMvO1xyXG4gICAgIGRldiBcdTc1MjhcdTRFRDNcdTVFOTNcdTUxODVcdTY3ODRcdTVFRkFcdTRFQTdcdTcyNjkoc2NyaXB0cy9idW5kbGUtcnVudGltZS5tanMpXHUzMDAyXHU4MUVBXHU1MzA1XHU1NDJCXHU1MzU1XHU2NTg3XHU0RUY2LFx1NjVFMCB0c3hcdTMwMDFcclxuICAgICBcdTY1RTAgcmVwbyBub2RlX21vZHVsZXMgXHU0RjlEXHU4RDU2XHUzMDAyICovXHJcbiAgZnVuY3Rpb24gYnVuZGxlZFJ1bnRpbWVQYXRoKHJlcG9Sb290OiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIGpvaW4oYXBwLmlzUGFja2FnZWQgPyBwcm9jZXNzLnJlc291cmNlc1BhdGggOiBqb2luKHJlcG9Sb290LCAnYXBwcycsICdkZXNrdG9wJywgJ3Jlc291cmNlcycpLCAncnVudGltZScsICdydW50aW1lLmNqcycpO1xyXG4gIH1cclxuXHJcbiAgLyoqIFx1NTE4NVx1N0Y2RSBydW50aW1lIFx1NTE0M1x1NEZFMVx1NjA2RihcdTU0MTFcdTVCRkNcIlx1NTE4NVx1N0Y2RVx1N0NCRVx1N0I4MFx1NTE4NVx1NjgzOFwiXHU5MDA5XHU5ODc5XHU3Njg0XHU3MjQ4XHU2NzJDXHU2ODA3XHU2Q0U4KVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIGJ1bmRsZWRSdW50aW1lSW5mbygpOiB7IHJlYWR5OiBib29sZWFuOyB2ZXJzaW9uOiBzdHJpbmcgfSB7XHJcbiAgICBjb25zdCByZXBvUm9vdCA9IGpvaW4oaGVyZSwgJy4uJywgJy4uJywgJy4uJywgJy4uJyk7XHJcbiAgICBjb25zdCBwID0gYnVuZGxlZFJ1bnRpbWVQYXRoKHJlcG9Sb290KTtcclxuICAgIGxldCB2ZXJzaW9uID0gJyc7XHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCB2ID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoam9pbihkaXJuYW1lKHApLCAncGFja2FnZS5qc29uJyksICd1dGY4JykpIGFzIHsgdmVyc2lvbj86IHVua25vd24gfTtcclxuICAgICAgdmVyc2lvbiA9IHR5cGVvZiB2LnZlcnNpb24gPT09ICdzdHJpbmcnID8gdi52ZXJzaW9uIDogJyc7XHJcbiAgICB9IGNhdGNoIHsgLyogXHU1MTQzXHU2NTcwXHU2MzZFXHU3RjNBXHU1OTMxXHU1MjE5XHU1M0VBXHU2MkE1IHJlYWR5ICovIH1cclxuICAgIHJldHVybiB7IHJlYWR5OiBleGlzdHNTeW5jKHApLCB2ZXJzaW9uIH07XHJcbiAgfVxyXG5cclxuICAvKiogbnBtIFx1NjYyRlx1NTQyNlx1NTcyOCBQQVRIKFx1NTQxMVx1NUJGQ1x1OTAwOVx1NjJFOVx1OTg3NSBcdTI0NjAgXHU3Njg0XHU1Qjg5XHU4OEM1XHU2NUI5XHU1RjBGXHU2ODA3XHU2Q0U4O3doZXJlIFx1NUZFQlx1NjNBMixcdTRFMERcdTUwNUFcdTVCOENcdTY1NzRcdTYzQTJcdTZENEIpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gbnBtT25QYXRoKCk6IGJvb2xlYW4ge1xyXG4gICAgdHJ5IHtcclxuICAgICAgZXhlY0ZpbGVTeW5jKCd3aGVyZScsIFsnbnBtJ10sIHsgZW5jb2Rpbmc6ICd1dGY4JywgdGltZW91dDogNF8wMDAsIHdpbmRvd3NIaWRlOiB0cnVlIH0pO1xyXG4gICAgICByZXR1cm4gdHJ1ZTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4gZmFsc2U7IH1cclxuICB9XHJcblxyXG4gIC8qIC0tLS0gXHU5OTk2XHU1NDJGXHU1Qjg5XHU4OEM1XHU1NDExXHU1QkZDXHU3MkI2XHU2MDAxKHY1LjEpIC0tLS0gKi9cclxuICBjb25zdCB3aXphcmRGaWxlID0gKCk6IHN0cmluZyA9PiBqb2luKGFwcC5nZXRQYXRoKCd1c2VyRGF0YScpLCAnd2l6YXJkLmpzb24nKTtcclxuICBhc3luYyBmdW5jdGlvbiBsb2FkV2l6YXJkU3RhdGUoKTogUHJvbWlzZTx7IGRvbmU6IGJvb2xlYW47IGNob2ljZTogc3RyaW5nIH0+IHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHYgPSBKU09OLnBhcnNlKGF3YWl0IHJlYWRGaWxlKHdpemFyZEZpbGUoKSwgJ3V0ZjgnKSkgYXMgeyBkb25lPzogdW5rbm93bjsgY2hvaWNlPzogdW5rbm93biB9O1xyXG4gICAgICByZXR1cm4geyBkb25lOiB2LmRvbmUgPT09IHRydWUsIGNob2ljZTogdHlwZW9mIHYuY2hvaWNlID09PSAnc3RyaW5nJyA/IHYuY2hvaWNlIDogJycgfTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4geyBkb25lOiBmYWxzZSwgY2hvaWNlOiAnJyB9OyB9XHJcbiAgfVxyXG4gIGFzeW5jIGZ1bmN0aW9uIHNhdmVXaXphcmRTdGF0ZShjaG9pY2U6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgYXdhaXQgd3JpdGVGaWxlKHdpemFyZEZpbGUoKSwgSlNPTi5zdHJpbmdpZnkoeyBkb25lOiB0cnVlLCBjaG9pY2UgfSwgbnVsbCwgMiksICd1dGY4JykuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcclxuICB9XHJcbiAgLyoqIFx1NTQxMVx1NUJGQ1x1ODFFQVx1NTJBOFx1NUYzOVx1NTFGQVx1NjI5MVx1NTIzNjpcdTZENEJcdThCRDUvXHU1RjAwXHU1M0QxXHU3M0FGXHU1ODgzXHU0RTBEXHU1RjM5KFVJVkVSSUZZL1NOQVBTSE9UL1JFTkRFUl9URVNUL1xyXG4gICAqICBET01QUk9CRS9TRUNVUklUWV9URVNUL0ZBS0UvZGV2KTtITUhfREVTS1RPUF9XSVpBUkRfRk9SQ0U9MSBcdTVGM0FcdTUyMzZcdTVGMzkoXHU5QThDXHU2NTM2KVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIHdpemFyZFN1cHByZXNzZWQoKTogYm9vbGVhbiB7XHJcbiAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfV0laQVJEX0ZPUkNFID09PSAnMScpIHJldHVybiBmYWxzZTtcclxuICAgIHJldHVybiBpc0RldlxyXG4gICAgICB8fCBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWSA9PT0gJzEnXHJcbiAgICAgIHx8IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NOQVBTSE9UICE9PSB1bmRlZmluZWRcclxuICAgICAgfHwgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfUkVOREVSX1RFU1QgPT09ICcxJ1xyXG4gICAgICB8fCBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9ET01QUk9CRSA9PT0gJzEnXHJcbiAgICAgIHx8IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NFQ1VSSVRZX1RFU1QgPT09ICcxJ1xyXG4gICAgICB8fCBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9GQUtFID09PSAnMSc7XHJcbiAgfVxyXG5cclxuICAvKiogXHU1M0QxXHU3M0IwXHU5ODdBXHU1RThGOlx1NjYzRVx1NUYwRlx1ODk4Nlx1NzZENihcdTU0MkJcdTU0MTFcdTVCRkNcdTkwMDlcdTYyRTk6XHU1OTE2XHU5MEU4XHU1MTY1XHU1M0UzL1x1NTE4NVx1N0Y2RVx1OERFRlx1NUY4NC9cdTZGMTRcdTc5M0EpPiBcdTUxODVcdTdGNkVcdTVGMDBcdTUxNzNcclxuICAgICAoSE1IX0RFU0tUT1BfQlVORExFRD0xKT4gXHU1OTE2XHU5MEU4XHU1M0QxXHU3M0IwKGRldiBcdTc2RjhcdTkwQkJcdTRFRDNcdTVFOTMgLyB3aGVyZSBobWggLyBucG0gXHU1MTY4XHU1QzQwIC9cclxuICAgICBcdTU0MTFcdTVCRkNcdTVCODlcdTg4QzVcdTc2RUVcdTVGNTUgLyBcdTZFOTBcdTc4MDFcdTRGNERcdTdGNkUpPiBcdTUxODVcdTdGNkVcdTUxNUNcdTVFOTVcdTMwMDJcdTU5MTZcdTkwRThcdTRGMThcdTUxNDg9XHU4MDAxXHU3NTI4XHU2MjM3XHU3RUU3XHU3RUVEXHU3NTI4XHU4MUVBXHU1REYxXHU4OEM1XHU3Njg0XHU3MjQ4XHU2NzJDO1xyXG4gICAgIFx1NTE4NVx1N0Y2RT1cdTY1QjBcdTY3M0FcdTU2NjhcdTg4QzVcdTVCOENcdTc2RjRcdThGREVcdTc3MUZcdTVCOUVcdTUxODVcdTY4MzhcdTMwMDJITUhfREVTS1RPUF9GQUtFPTEgXHU2MjE2IHJ1bnRpbWUuanNvbiBkZW1vPXRydWVcclxuICAgICAoXHU1NDExXHU1QkZDXCJcdTZGMTRcdTc5M0FcdTZBMjFcdTVGMEZcIlx1OTAwOVx1NjJFOSxcdTYzMDFcdTRFNDUpXHU4RkRCXHU2RjE0XHU3OTNBXHUzMDAyICovXHJcbiAgYXN5bmMgZnVuY3Rpb24gc3RhcnRIb3N0KCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3QgcmVwb1Jvb3QgPSBqb2luKGhlcmUsICcuLicsICcuLicsICcuLicsICcuLicpOyAvLyBhcHBzL2Rlc2t0b3AvZGlzdC1lbGVjdHJvbi9tYWluIFx1MjE5MiByZXBvIHJvb3RcclxuICAgIGNvbnN0IHBhY2thZ2VkID0gYXBwLmlzUGFja2FnZWQ7XHJcbiAgICBjb25zdCBjZmcgPSBhd2FpdCBsb2FkUnVudGltZUNvbmZpZygpO1xyXG4gICAgY29uc3QgZm9yY2VGYWtlID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfRkFLRSA9PT0gJzEnIHx8IGNmZy5kZW1vO1xyXG4gICAgY29uc3QgZm9yY2VCdW5kbGVkID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfQlVORExFRCA9PT0gJzEnO1xyXG4gICAgY29uc3Qgb3ZlcnJpZGUgPSBjZmcuZW50cnk7XHJcbiAgICBjb25zdCBhZGphY2VudCA9IGpvaW4ocmVwb1Jvb3QsICcuLicsICdobWhhcm5lc3MnLCAncGFja2FnZXMnLCAnd2ViJywgJ3NyYycsICdkZXNrdG9wLWhvc3QudHMnKTtcclxuICAgIGNvbnN0IGJ1bmRsZWQgPSBidW5kbGVkUnVudGltZVBhdGgocmVwb1Jvb3QpO1xyXG4gICAgY29uc3QgYnVuZGxlZFJlYWR5ID0gZXhpc3RzU3luYyhidW5kbGVkKTtcclxuICAgIC8vIFx1ODlFM1x1Njc5MChcdTdFRDNcdTY3OUNcdTVGNTJcdTRFMDA6b3ZlcnJpZGU9YnVuZGxlZCBcdThERUZcdTVGODRcdTIxOTJcdTUxODVcdTdGNkU7XHU2RTkwXHU3ODAxIC50cyBcdTk3MDAgdHN4O1xyXG4gICAgLy8gbnBtIFx1NUI4OVx1ODhDNSAuanMgXHU3RjE2XHU4QkQxXHU0RUE3XHU3MjY5XHU3NkY0XHU4REQxO2J1bmRsZWQ9XHU4MUVBXHU1MzA1XHU1NDJCIGNqcyBcdTc2RjRcdThERDEpXHJcbiAgICBsZXQgZW50cnkgPSAnJztcclxuICAgIHVzZUJ1bmRsZWRSdW50aW1lID0gZmFsc2U7XHJcbiAgICBpZiAoZm9yY2VGYWtlKSB7XHJcbiAgICAgIC8vIFx1NkYxNFx1NzkzQVx1NkEyMVx1NUYwRlxyXG4gICAgfSBlbHNlIGlmIChvdmVycmlkZSAhPT0gJycpIHtcclxuICAgICAgZW50cnkgPSBvdmVycmlkZTtcclxuICAgICAgaWYgKG92ZXJyaWRlID09PSBidW5kbGVkKSB1c2VCdW5kbGVkUnVudGltZSA9IHRydWU7IC8vIFx1NTQxMVx1NUJGQ1x1OTAwOVwiXHU1MTg1XHU3RjZFXHU3Q0JFXHU3QjgwXHU1MTg1XHU2ODM4XCJcdTc2ODRcdTYzMDFcdTRFNDVcdTVGNjJcdTYwMDFcclxuICAgIH0gZWxzZSBpZiAoZm9yY2VCdW5kbGVkKSB7XHJcbiAgICAgIGlmIChidW5kbGVkUmVhZHkpIHsgZW50cnkgPSBidW5kbGVkOyB1c2VCdW5kbGVkUnVudGltZSA9IHRydWU7IH1cclxuICAgICAgZWxzZSBsb2dJbmZvKCdob3N0JywgJ0hNSF9ERVNLVE9QX0JVTkRMRUQ9MSBcdTRGNDZcdTUxODVcdTdGNkUgcnVudGltZSBcdTdGM0FcdTU5MzEoXHU1MTQ4XHU4REQxIHNjcmlwdHMvYnVuZGxlLXJ1bnRpbWUubWpzKScpO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgZW50cnkgPSBwYWNrYWdlZCA/IGRldGVjdFJlYWxFbnRyeSgpIDogKGV4aXN0c1N5bmMoYWRqYWNlbnQpID8gYWRqYWNlbnQgOiBkZXRlY3RSZWFsRW50cnkoKSk7XHJcbiAgICAgIGlmIChlbnRyeSA9PT0gJycgJiYgYnVuZGxlZFJlYWR5KSB7IGVudHJ5ID0gYnVuZGxlZDsgdXNlQnVuZGxlZFJ1bnRpbWUgPSB0cnVlOyB9XHJcbiAgICB9XHJcbiAgICBydW50aW1lRW50cnkgPSBlbnRyeTtcclxuICAgIGNvbnN0IHVzZVJlYWwgPSBlbnRyeSAhPT0gJycgJiYgKHVzZUJ1bmRsZWRSdW50aW1lIHx8IGV4aXN0c1N5bmMoZW50cnkpKTtcclxuICAgIGJyaWRnZSA9IHtcclxuICAgICAgLi4uYnJpZGdlLFxyXG4gICAgICBtb2RlOiB1c2VSZWFsID8gJ3JlYWwnIDogJ2Zha2UnLFxyXG4gICAgICBydW50aW1lRW50cnk6IHVzZVJlYWwgPyAodXNlQnVuZGxlZFJ1bnRpbWUgPyBgJHtlbnRyeX0gKGJ1bmRsZWQpYCA6IGVudHJ5KSA6IG51bGwsXHJcbiAgICB9O1xyXG4gICAgbGV0IHNwZWM6IHsgY29tbWFuZDogc3RyaW5nOyBhcmdzOiBzdHJpbmdbXTsgZW52OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+OyBjd2Q/OiBzdHJpbmcgfTtcclxuICAgIGlmICh1c2VCdW5kbGVkUnVudGltZSkge1xyXG4gICAgICBzcGVjID0ge1xyXG4gICAgICAgIGNvbW1hbmQ6IHByb2Nlc3MuZXhlY1BhdGgsXHJcbiAgICAgICAgYXJnczogW2VudHJ5XSwgLy8gXHU4MUVBXHU1MzA1XHU1NDJCXHU1MzU1XHU2NTg3XHU0RUY2OmVsZWN0cm9uLWFzLW5vZGUgXHU3NkY0XHU4REQxLFx1NjVFMCB0c3ggXHU2NUUwIHJlcG9cclxuICAgICAgICBlbnY6IHsgRUxFQ1RST05fUlVOX0FTX05PREU6ICcxJyB9LFxyXG4gICAgICB9O1xyXG4gICAgfSBlbHNlIGlmICh1c2VSZWFsICYmIGVudHJ5LmVuZHNXaXRoKCcuanMnKSkge1xyXG4gICAgICBzcGVjID0ge1xyXG4gICAgICAgIGNvbW1hbmQ6IHByb2Nlc3MuZXhlY1BhdGgsXHJcbiAgICAgICAgYXJnczogW2VudHJ5XSwgLy8gbnBtIFx1NUI4OVx1ODhDNVx1NzY4NFx1N0YxNlx1OEJEMVx1NEVBN1x1NzI2OTpFU00gXHU0RjlEXHU4RDU2XHU2MzA5XHU2NTg3XHU0RUY2XHU0RjREXHU3RjZFXHU4OUUzXHU2NzkwLFx1NzZGNFx1OEREMVx1NTM3M1x1NTNFRlxyXG4gICAgICAgIGN3ZDogZGlybmFtZShlbnRyeSksXHJcbiAgICAgICAgZW52OiB7IEVMRUNUUk9OX1JVTl9BU19OT0RFOiAnMScgfSxcclxuICAgICAgfTtcclxuICAgIH0gZWxzZSBpZiAodXNlUmVhbCkge1xyXG4gICAgICBjb25zdCByZXBvID0gcmVwb1Jvb3RPZihlbnRyeSk7XHJcbiAgICAgIHNwZWMgPSB7XHJcbiAgICAgICAgY29tbWFuZDogcHJvY2Vzcy5leGVjUGF0aCxcclxuICAgICAgICBhcmdzOiBbJy0taW1wb3J0JywgJ3RzeCcsIGVudHJ5XSxcclxuICAgICAgICBjd2Q6IHJlcG8sIC8vIGJhcmUgJ3RzeCcgXHU0RTBFIHdvcmtzcGFjZSBcdTRGOURcdThENTZcdTkwRkRcdTRFQ0UgcmVwbyBcdTc2ODQgbm9kZV9tb2R1bGVzIFx1ODlFM1x1Njc5MFxyXG4gICAgICAgIGVudjogeyBFTEVDVFJPTl9SVU5fQVNfTk9ERTogJzEnIH0sXHJcbiAgICAgIH07XHJcbiAgICB9IGVsc2UgaWYgKHBhY2thZ2VkKSB7XHJcbiAgICAgIHNwZWMgPSB7XHJcbiAgICAgICAgY29tbWFuZDogcHJvY2Vzcy5leGVjUGF0aCxcclxuICAgICAgICBhcmdzOiBbam9pbihwcm9jZXNzLnJlc291cmNlc1BhdGgsICdmYWtlLWhvc3QuY2pzJyldLFxyXG4gICAgICAgIGVudjogeyBFTEVDVFJPTl9SVU5fQVNfTk9ERTogJzEnIH0sXHJcbiAgICAgIH07XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICBzcGVjID0ge1xyXG4gICAgICAgIGNvbW1hbmQ6IHByb2Nlc3MuZXhlY1BhdGgsXHJcbiAgICAgICAgLy8gXHU3NkY0XHU2M0E1XHU4RDcwXHU1MzA1XHU3NzFGXHU1QjlFXHU4REVGXHU1Rjg0KG5vZGVfbW9kdWxlcyBcdTkxQ0NcdTc2ODQgd29ya3NwYWNlIGp1bmN0aW9uIFx1NEYxQVx1ODhBQiBFU01cclxuICAgICAgICAvLyByZWFscGF0aCBcdTUzMTYsXHU1QkZDXHU4MUY0IGZha2UtaG9zdCBcdTc2ODQgYXJndlsxXS9pbXBvcnQubWV0YS51cmwgXHU1MzM5XHU5MTREXHU1OTMxXHU2NTQ4KVxyXG4gICAgICAgIGFyZ3M6IFsnLS1pbXBvcnQnLCAndHN4Jywgam9pbihyZXBvUm9vdCwgJ3BhY2thZ2VzJywgJ2hvc3QtYWRhcHRlcicsICdzcmMnLCAnZmFrZS1ob3N0LnRzJyldLFxyXG4gICAgICAgIGVudjogeyBFTEVDVFJPTl9SVU5fQVNfTk9ERTogJzEnIH0sXHJcbiAgICAgIH07XHJcbiAgICB9XHJcbiAgICBzdXBlcnZpc29yID0gbmV3IERlc2t0b3BSdW50aW1lU3VwZXJ2aXNvcihzcGVjLCB7XHJcbiAgICAgIG9uU3RhdGVDaGFuZ2U6IGJyb2FkY2FzdEhvc3RTdGF0ZSxcclxuICAgICAgLy8gXHU5OTk2XHU2QjIxXHU1NDJGXHU1MkE4XHU0RTBFIGNyYXNoIFx1ODFFQVx1NjEwOFx1NTQwRVx1NzY4NFx1OTFDRFx1NTQyRlx1OTBGRFx1NEYxQVx1OEQ3MFx1OEZEOVx1OTFDQzpcdTdBRUZcdTUzRTMvdG9rZW4gXHU5MEZEXHU2NjJGXHU2NUIwXHU3Njg0LFxyXG4gICAgICAvLyBcdTkxQ0RcdTVFRkFcdTY4NjVcdTVCQTJcdTYyMzdcdTdBRUZcdTVFNzZcdTkxQ0RcdTY1QjBcdThCQTJcdTk2MDUgU1NFKHJlbmRlcmVyIFx1NzY4NCBFdmVudFN0b3JlIFx1OTc2MCBldmVudElkIFx1NTNCQlx1OTFDRClcclxuICAgICAgb25SZWFkeTogKGVwKSA9PiB7XHJcbiAgICAgICAgY2xpZW50ID0gbmV3IERlc2t0b3BIb3N0Q2xpZW50KGBodHRwOi8vMTI3LjAuMC4xOiR7ZXAucG9ydH1gLCBlcC50b2tlbik7XHJcbiAgICAgICAgc3NlQWJvcnQ/LmFib3J0KCk7XHJcbiAgICAgICAgc3NlQWJvcnQgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XHJcbiAgICAgICAgbGFzdEV2ZW50SWQgPSAnJztcclxuICAgICAgICB2b2lkIHB1bXBFdmVudHMoKTtcclxuICAgICAgICBsb2dJbmZvKCdob3N0JywgYGJyaWRnZSByZWFkeSBvbiAxMjcuMC4wLjE6JHtlcC5wb3J0fSAocnVudGltZSAke2VwLnZlcnNpb259LCBtb2RlICR7YnJpZGdlLm1vZGV9JHt1c2VSZWFsID8gYCwgZW50cnk9JHtydW50aW1lRW50cnl9JHt1c2VCdW5kbGVkUnVudGltZSA/ICcgW2J1bmRsZWRdJyA6ICcnfWAgOiAnJ30pYCk7XHJcbiAgICAgIH0sXHJcbiAgICB9KTtcclxuICAgIHRyeSB7XHJcbiAgICAgIGF3YWl0IHN1cGVydmlzb3Iuc3RhcnQoKTtcclxuICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICBjb25zdCBkZXRhaWwgPSAoKCkgPT4geyB0cnkgeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkoZXJyKTsgfSBjYXRjaCB7IHJldHVybiBTdHJpbmcoZXJyKTsgfSB9KSgpLnNsaWNlKDAsIDQwMCk7XHJcbiAgICAgIGJyaWRnZSA9IHsgLi4uYnJpZGdlLCBob3N0U3RhdGU6ICdmYWlsZWQnLCBsYXN0RXJyb3I6IGRldGFpbCB9O1xyXG4gICAgICBsb2dJbmZvKCdob3N0JywgYHN0YXJ0IGZhaWxlZDogJHtkZXRhaWx9YCk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvKiAtLS0tIElQQyBcdTc2N0RcdTU0MERcdTUzNTUgKyBzZW5kZXIgXHU2ODIxXHU5QThDIC0tLS0gKi9cclxuICBjb25zdCBhbGxvd2VkT3JpZ2lucyA9IG5ldyBTZXQ8c3RyaW5nPihcclxuICAgIGlzRGV2ICYmIHJlbmRlcmVyRGV2VXJsXHJcbiAgICAgID8gW3JlbmRlcmVyRGV2VXJsXVxyXG4gICAgICA6IFtwYXRoVG9GaWxlVVJMKGpvaW4oaGVyZSwgJy4uJywgJy4uJywgJ2Rpc3QtcmVuZGVyZXInLCAnaW5kZXguaHRtbCcpKS5ocmVmXSxcclxuICApO1xyXG5cclxuICBmdW5jdGlvbiBzZW5kZXJUcnVzdGVkKHNlbmRlckZyYW1lOiBFbGVjdHJvbi5XZWJGcmFtZU1haW4gfCBudWxsIHwgdW5kZWZpbmVkKTogYm9vbGVhbiB7XHJcbiAgICBpZiAoc2VuZGVyRnJhbWUgPT09IG51bGwgfHwgc2VuZGVyRnJhbWUgPT09IHVuZGVmaW5lZCkgcmV0dXJuIGZhbHNlO1xyXG4gICAgbGV0IHRvcDogRWxlY3Ryb24uV2ViRnJhbWVNYWluIHwgbnVsbCA9IHNlbmRlckZyYW1lO1xyXG4gICAgd2hpbGUgKHRvcD8ucGFyZW50ICE9PSBudWxsICYmIHRvcD8ucGFyZW50ICE9PSB1bmRlZmluZWQpIHRvcCA9IHRvcC5wYXJlbnQ7XHJcbiAgICBjb25zdCB1cmwgPSB0b3A/LnVybCA/PyAnJztcclxuICAgIGZvciAoY29uc3Qgb3JpZ2luIG9mIGFsbG93ZWRPcmlnaW5zKSB7XHJcbiAgICAgIGlmICh1cmwgPT09IG9yaWdpbiB8fCB1cmwuc3RhcnRzV2l0aChgJHtvcmlnaW59L2ApIHx8IHVybC5zdGFydHNXaXRoKGAke29yaWdpbn0/YCkpIHJldHVybiB0cnVlO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGZhbHNlO1xyXG4gIH1cclxuXHJcbiAgLyoqIFx1OTcwMFx1ODk4MSBob3N0IFx1NUMzMVx1N0VFQVx1NzY4NCBJUEMgaGFuZGxlciBcdTUxNkNcdTUxNzFcdTU4RjM6XHU2NzJBXHU1QzMxXHU3RUVBXHU4RkQ0XHU1NkRFXHU3RUQzXHU2Nzg0XHU1MzE2XHU5NTE5XHU4QkVGXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gaG9zdENhbGw8VD4oZXZlbnQ6IEVsZWN0cm9uLklwY01haW5JbnZva2VFdmVudCwgZm46IChjOiBEZXNrdG9wSG9zdENsaWVudCkgPT4gUHJvbWlzZTxUPik6IFByb21pc2U8VCB8IHsgZXJyb3I6IHN0cmluZzsgY29kZTogc3RyaW5nIH0+IHtcclxuICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9KTtcclxuICAgIGlmIChjbGllbnQgPT09IG51bGwgfHwgYnJpZGdlLmhvc3RTdGF0ZSAhPT0gJ3JlYWR5Jykge1xyXG4gICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6IGBob3N0IG5vdCByZWFkeSAoJHticmlkZ2UuaG9zdFN0YXRlfSlgLCBjb2RlOiAnSE9TVF9OT1RfUkVBRFknIH0pO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGZuKGNsaWVudCkuY2F0Y2goKGVycjogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBkZXRhaWwgPSAoKCkgPT4geyB0cnkgeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkoZXJyKTsgfSBjYXRjaCB7IHJldHVybiBTdHJpbmcoZXJyKTsgfSB9KSgpLnNsaWNlKDAsIDMwMCk7XHJcbiAgICAgIHJldHVybiB7IGVycm9yOiBkZXRhaWwsIGNvZGU6ICdCUklER0VfRVJST1InIH07XHJcbiAgICB9KTtcclxuICB9XHJcblxyXG4gIGZ1bmN0aW9uIHJlZ2lzdGVySXBjKCk6IHZvaWQge1xyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpnZXQtc3RhdGUnLCAoZXZlbnQpID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJyB9O1xyXG4gICAgICByZXR1cm4geyAuLi5icmlkZ2UsIGRyb3BwZWRGcmFtZXMgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6c2Vzc2lvbnMnLCAoZXZlbnQpID0+XHJcbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPHsgc2Vzc2lvbnM6IEFycmF5PHsgaWQ6IHN0cmluZzsgdGl0bGU6IHN0cmluZzsgdGFzazogc3RyaW5nOyBvdXRjb21lOiBzdHJpbmc7IHR1cm5zOiBudW1iZXI7IHRvb2xVc2VzOiBudW1iZXI7IHRpbWU6IHN0cmluZzsgY3dkOiBzdHJpbmc7IGNyZWF0ZWRBdDogc3RyaW5nOyB1cGRhdGVkQXQ6IHN0cmluZyB9PiB9PignL2FwaS9zZXNzaW9ucz9saW1pdD0xMDAnKSkpO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6c2VuZC10YXNrJywgKGV2ZW50LCB0ZXh0OiB1bmtub3duLCBzZXNzaW9uSWQ6IHVua25vd24sIG1vZGU6IHVua25vd24sIGF0dGFjaG1lbnRzOiB1bmtub3duLCBpbWFnZXM6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3QgdGFzayA9IHR5cGVvZiB0ZXh0ID09PSAnc3RyaW5nJyA/IHRleHQuc2xpY2UoMCwgMjBfMDAwKSA6ICcnO1xyXG4gICAgICBjb25zdCBzaWQgPSB0eXBlb2Ygc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IHNlc3Npb25JZC5zbGljZSgwLCA4MCkgOiAnJztcclxuICAgICAgY29uc3QgbSA9IG1vZGUgPT09ICdhdXRvJyB8fCBtb2RlID09PSAneW9sbycgPyBtb2RlIDogJ2Fzayc7XHJcbiAgICAgIC8vIFx1OTY0NFx1NEVGNjpcdTU0MEVcdTdBRUZcdTYzODhcdTY3NDMgRFRPIFx1NzY4NFx1N0VERFx1NUJGOVx1OERFRlx1NUY4NChAIFx1OTAwOVx1NjJFOVx1NTY2OC9cdUQ4M0RcdURDQ0UgXHU0RTBBXHU0RjIwXHU1M0VBXHU2NzY1XHU4MUVBXHU2NzJDXHU1NzMwXHU2NTg3XHU0RUY2XHU3Q0ZCXHU3RURGKVxyXG4gICAgICBjb25zdCBhdHRzID0gQXJyYXkuaXNBcnJheShhdHRhY2htZW50cykgPyBhdHRhY2htZW50cy5maWx0ZXIoKGEpOiBhIGlzIHN0cmluZyA9PiB0eXBlb2YgYSA9PT0gJ3N0cmluZycpLnNsaWNlKDAsIDEwKSA6IFtdO1xyXG4gICAgICAvLyBcdTU2RkVcdTcyNDc6cnVudGltZSB2aXNpb24gXHU5NEZFXHU1MzRGXHU4QkFFIHtuYW1lLCBkYXRhVXJsfSBiYXNlNjQoXHUyMjY0MyBcdTVGMjAgXHUyMjY0Nk1CLHJlbmRlcmVyIFx1NzUxRlx1NjIxMClcclxuICAgICAgY29uc3QgaW1ncyA9IEFycmF5LmlzQXJyYXkoaW1hZ2VzKVxyXG4gICAgICAgID8gaW1hZ2VzXHJcbiAgICAgICAgICAgIC5maWx0ZXIoKGltKTogaW0gaXMgeyBuYW1lOiBzdHJpbmc7IGRhdGFVcmw6IHN0cmluZyB9ID0+XHJcbiAgICAgICAgICAgICAgdHlwZW9mIGltID09PSAnb2JqZWN0JyAmJiBpbSAhPT0gbnVsbCAmJiB0eXBlb2YgKGltIGFzIHsgbmFtZT86IHVua25vd24gfSkubmFtZSA9PT0gJ3N0cmluZycgJiYgdHlwZW9mIChpbSBhcyB7IGRhdGFVcmw/OiB1bmtub3duIH0pLmRhdGFVcmwgPT09ICdzdHJpbmcnKVxyXG4gICAgICAgICAgICAuc2xpY2UoMCwgMylcclxuICAgICAgICAgICAgLm1hcCgoaW0pID0+ICh7IG5hbWU6IGltLm5hbWUuc2xpY2UoMCwgMTIwKSwgZGF0YVVybDogaW0uZGF0YVVybC5zbGljZSgwLCA4XzUwMF8wMDApIH0pKVxyXG4gICAgICAgIDogW107XHJcbiAgICAgIGlmICh0YXNrID09PSAnJyB8fCBzaWQgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgb2s6IGZhbHNlLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW47IHJ1bklkPzogc3RyaW5nIH0+KCcvYXBpL3Rhc2snLCB7IHRleHQ6IHRhc2ssIHNlc3Npb25JZDogc2lkLCBtb2RlOiBtLCBhdHRhY2htZW50czogYXR0cywgaW1hZ2VzOiBpbWdzIH0pKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gXHU2QTIxXHU1NzhCXHU1MjA3XHU2MzYyKHJ1bnRpbWUgUE9TVCAvYXBpL21vZGVsOlx1NTIwNyBjaGF0IFx1OERFRlx1NzUzMSxjb25maWcgXHU1MzczXHU2NUY2XHU3NTFGXHU2NTQ4KSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOm1vZGVsLXNldCcsIChldmVudCwgbmFtZTogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBuID0gdHlwZW9mIG5hbWUgPT09ICdzdHJpbmcnID8gbmFtZS50cmltKCkuc2xpY2UoMCwgODApIDogJyc7XHJcbiAgICAgIGlmIChuID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAnbmFtZSByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbjsgbW9kZWw/OiBzdHJpbmcgfT4oJy9hcGkvbW9kZWwnLCB7IG5hbWU6IG4gfSkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBcdTVFOTRcdTc1MjhcdTUxODVcdTY2RjRcdTY1QjAoR2l0SHViIFJlbGVhc2VzO1x1ODFFQVx1NzgxNFx1OTZGNlx1NEY5RFx1OEQ1Nlx1NjZGNFx1NjVCMFx1NTY2OCkgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpjaGVjay11cGRhdGUnLCBhc3luYyAoZXZlbnQpID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgcmV0dXJuIGNoZWNrRm9yVXBkYXRlcygpO1xyXG4gICAgfSk7XHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmFwcGx5LXVwZGF0ZScsIChldmVudCkgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBpZiAoaW5zdGFsbGVyUGF0aCA9PT0gbnVsbCkgcmV0dXJuIHsgZXJyb3I6ICdubyBpbnN0YWxsZXIgZG93bmxvYWRlZCcsIGNvZGU6ICdIT1NUX05PVF9SRUFEWScgfTtcclxuICAgICAgYXBwbHlVcGRhdGUoKTtcclxuICAgICAgcmV0dXJuIHsgb2s6IHRydWUgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gXHU2ODA3XHU5ODk4XHU2ODBGXHU0RTNCXHU5ODk4XHU1NDBDXHU2QjY1KFx1NkQ0NVx1ODI3Mlx1NkEyMVx1NUYwRlx1NEUwRFx1NTE4RFx1NjcwOVx1OUVEMVx1Njc2MSkrIFx1MjYzMCBcdTRFM0JcdTgzRENcdTUzNTUgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpjaHJvbWUtdGhlbWUnLCAoZXZlbnQsIGRhcms6IHVua25vd24pID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgYXBwbHlDaHJvbWUoZGFyayA9PT0gdHJ1ZSk7XHJcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlIH07XHJcbiAgICB9KTtcclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cG9wdXAtbWFpbi1tZW51JywgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIHBvcHVwTWFpbk1lbnUoKTtcclxuICAgICAgcmV0dXJuIHsgb2s6IHRydWUgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gXHU2MjRCXHU2NzNBXHU4RkRDXHU3QTBCXHU2M0E3XHU1MjM2KDc3ODggd2ViIFx1NUI4OFx1NjJBNDtcdTc1MjhcdTYyMzdcdTY2M0VcdTVGMEZcdTU0MkZcdTUyQTgsQURSLTAwNSBcdTRFMERcdTlFRDhcdThCQTRcdTVGMDAgTEFOKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnJlbW90ZS13ZWItc3RhdHVzJywgYXN5bmMgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IHAgPSBhd2FpdCBwcm9iZVdlYlJlbW90ZSgpO1xyXG4gICAgICByZXR1cm4geyB1cDogcC51cCwgdmVyc2lvbjogcC52ZXJzaW9uLCBsYW5JcDogbGFuSXBPZigpLCBwb3J0OiBXRUJfUE9SVCwgYXZhaWxhYmxlOiBjbGlFbnRyeU9mKCkgIT09ICcnLCBhdXRvc3RhcnQ6IHdlYkF1dG9zdGFydEluc3RhbGxlZCgpIH07XHJcbiAgICB9KTtcclxuICAgIC8vIC0tLS0gXHU1RjAwXHU2NzNBXHU4MUVBXHU1NDJGKDAuMjMuMzcgd2ViIGluc3RhbGwtZGFlbW9uL3VuaW5zdGFsbC1kYWVtb247XHU3NjdCXHU1RjU1XHU1MzczXHU1Qjg4XHU2MkE0XHU1NzI4XHU3RUJGKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnJlbW90ZS13ZWItYXV0b3N0YXJ0JywgYXN5bmMgKGV2ZW50LCBlbmFibGVkOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGlmIChjbGlFbnRyeU9mKCkgPT09ICcnKSByZXR1cm4geyBlcnJvcjogJ25vIGhtaGFybmVzcyBydW50aW1lIGRldGVjdGVkJywgY29kZTogJ0hPU1RfTk9UX1JFQURZJyB9O1xyXG4gICAgICBydW5DbGkoWyd3ZWInLCBlbmFibGVkID09PSB0cnVlID8gJ2luc3RhbGwtZGFlbW9uJyA6ICd1bmluc3RhbGwtZGFlbW9uJ10pO1xyXG4gICAgICAvLyBpbnN0YWxsLWRhZW1vbiBcdTdBQ0JcdTUzNzNcdTYyQzlcdThENzdcdTVCODhcdTYyQTQ6XHU4RjZFXHU4QkUyXHU3ODZFXHU4QkE0O3VuaW5zdGFsbCBcdTUzNzNcdTY1RjZcdTc1MUZcdTY1NDhcclxuICAgICAgaWYgKGVuYWJsZWQgPT09IHRydWUpIHtcclxuICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IDUwOyBpKyspIHtcclxuICAgICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDUwMCkpO1xyXG4gICAgICAgICAgaWYgKChhd2FpdCBwcm9iZVdlYlJlbW90ZSgpKS51cCkgcmV0dXJuIHsgb2s6IHRydWUsIGF1dG9zdGFydDogd2ViQXV0b3N0YXJ0SW5zdGFsbGVkKCkgfTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHsgZXJyb3I6ICdkYWVtb24gZGlkIG5vdCBjb21lIHVwIHdpdGhpbiAyNXMnLCBjb2RlOiAnUlVOVElNRV9DUkFTSEVEJyB9O1xyXG4gICAgICB9XHJcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBhdXRvc3RhcnQ6IHdlYkF1dG9zdGFydEluc3RhbGxlZCgpIH07XHJcbiAgICB9KTtcclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cmVtb3RlLXdlYi1zdGFydCcsIGFzeW5jIChldmVudCkgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBpZiAoY2xpRW50cnlPZigpID09PSAnJykgcmV0dXJuIHsgZXJyb3I6ICdubyBobWhhcm5lc3MgcnVudGltZSBkZXRlY3RlZCcsIGNvZGU6ICdIT1NUX05PVF9SRUFEWScgfTtcclxuICAgICAgaWYgKChhd2FpdCBwcm9iZVdlYlJlbW90ZSgpKS51cCkge1xyXG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBhbHJlYWR5OiB0cnVlLCBsYW5Vcmw6IGBodHRwOi8vJHtsYW5JcE9mKCkgfHwgJzEyNy4wLjAuMSd9OiR7V0VCX1BPUlR9YCB9O1xyXG4gICAgICB9XHJcbiAgICAgIHJ1bkNsaShbJ3dlYicsICdzdGFydCcsICctLWV4cG9zdXJlPWxhbiddKTtcclxuICAgICAgLy8gXHU1Qjg4XHU2MkE0XHU4RkRCXHU3QTBCXHU1MUI3XHU1NDJGXHU1MkE4KHRzeCBcdTdGMTZcdThCRDFcdTY1NzRcdTU5NTcgQ0xJKTpcdThGNkVcdThCRTIgMjVzXHJcbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgNTA7IGkrKykge1xyXG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDUwMCkpO1xyXG4gICAgICAgIGlmICgoYXdhaXQgcHJvYmVXZWJSZW1vdGUoKSkudXApIHtcclxuICAgICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBsYW5Vcmw6IGBodHRwOi8vJHtsYW5JcE9mKCkgfHwgJzEyNy4wLjAuMSd9OiR7V0VCX1BPUlR9YCB9O1xyXG4gICAgICAgIH1cclxuICAgICAgfVxyXG4gICAgICByZXR1cm4geyBlcnJvcjogJ3dlYiBkYWVtb24gZGlkIG5vdCBjb21lIHVwIHdpdGhpbiAyNXMgKHNlZSBITUhfSE9NRS93ZWIubG9nKScsIGNvZGU6ICdSVU5USU1FX0NSQVNIRUQnIH07XHJcbiAgICB9KTtcclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cmVtb3RlLXdlYi1zdG9wJywgYXN5bmMgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIHJ1bkNsaShbJ3dlYicsICdzdG9wJ10pO1xyXG4gICAgICBmb3IgKGxldCBpID0gMDsgaSA8IDIwOyBpKyspIHtcclxuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCA0MDApKTtcclxuICAgICAgICBpZiAoIShhd2FpdCBwcm9iZVdlYlJlbW90ZSgpKS51cCkgcmV0dXJuIHsgb2s6IHRydWUgfTtcclxuICAgICAgfVxyXG4gICAgICBjb25zdCBzdGlsbCA9IChhd2FpdCBwcm9iZVdlYlJlbW90ZSgpKS51cDtcclxuICAgICAgcmV0dXJuIHN0aWxsID8geyBlcnJvcjogJ3N0aWxsIHJ1bm5pbmcnLCBjb2RlOiAnQlJJREdFX0VSUk9SJyB9IDogeyBvazogdHJ1ZSB9O1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBcdUQ4M0RcdURDQ0UgXHU2NTg3XHU0RUY2XHU0RTBBXHU0RjIwKFx1NjcyQ1x1NTczMFx1NTkxQVx1OTAwOTtydW50aW1lIFx1NjgyMVx1OUE4QyBpbnNpZGVXcyxcdTVERTVcdTRGNUNcdTUzM0FcdTU5MTZcdTY1ODdcdTRFRjZcdTRGMUFcdTg4QUIgNDAwKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnBpY2stZmlsZXMnLCBhc3luYyAoZXZlbnQsIHRpdGxlOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IHdpbiA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmZpbmQoKHcpID0+ICF3LmlzRGVzdHJveWVkKCkpO1xyXG4gICAgICBpZiAod2luID09PSB1bmRlZmluZWQpIHJldHVybiB7IGVycm9yOiAnbm8gd2luZG93JywgY29kZTogJ0JSSURHRV9FUlJPUicgfTtcclxuICAgICAgY29uc3QgciA9IGF3YWl0IGRpYWxvZy5zaG93T3BlbkRpYWxvZyh3aW4sIHtcclxuICAgICAgICB0aXRsZTogdHlwZW9mIHRpdGxlID09PSAnc3RyaW5nJyAmJiB0aXRsZSAhPT0gJycgPyB0aXRsZS5zbGljZSgwLCAxMjApIDogJ1x1OTAwOVx1NjJFOVx1ODk4MVx1OTY0NFx1NTJBMFx1NzY4NFx1NjU4N1x1NEVGNihcdTUzRUZcdTU5MUFcdTkwMDkpJyxcclxuICAgICAgICBwcm9wZXJ0aWVzOiBbJ29wZW5GaWxlJywgJ211bHRpU2VsZWN0aW9ucyddLFxyXG4gICAgICB9KTtcclxuICAgICAgaWYgKHIuY2FuY2VsZWQgfHwgci5maWxlUGF0aHMubGVuZ3RoID09PSAwKSByZXR1cm4geyBvazogZmFsc2UsIGNhbmNlbGVkOiB0cnVlIH07XHJcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBwYXRoczogci5maWxlUGF0aHMuc2xpY2UoMCwgMTApIH07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIFx1RDgzRFx1RENDMSBcdTc2RUVcdTVGNTVcdTkwMDlcdTYyRTkoXHU1REU1XHU0RjVDXHU1MzNBXHU2REZCXHU1MkEwXHU3Njg0XHU2RDRGXHU4OUM4XHU2MzA5XHU5NEFFO1x1NTM5Rlx1NzUxRiBjaG9vc2VyKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnBpY2stZGlyZWN0b3J5JywgYXN5bmMgKGV2ZW50LCB0aXRsZTogdW5rbm93bikgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBjb25zdCB3aW4gPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5maW5kKCh3KSA9PiAhdy5pc0Rlc3Ryb3llZCgpKTtcclxuICAgICAgaWYgKHdpbiA9PT0gdW5kZWZpbmVkKSByZXR1cm4geyBlcnJvcjogJ25vIHdpbmRvdycsIGNvZGU6ICdCUklER0VfRVJST1InIH07XHJcbiAgICAgIGNvbnN0IHIgPSBhd2FpdCBkaWFsb2cuc2hvd09wZW5EaWFsb2cod2luLCB7XHJcbiAgICAgICAgdGl0bGU6IHR5cGVvZiB0aXRsZSA9PT0gJ3N0cmluZycgJiYgdGl0bGUgIT09ICcnID8gdGl0bGUuc2xpY2UoMCwgMTIwKSA6ICdcdTkwMDlcdTYyRTlcdTY1ODdcdTRFRjZcdTU5MzknLFxyXG4gICAgICAgIHByb3BlcnRpZXM6IFsnb3BlbkRpcmVjdG9yeSddLFxyXG4gICAgICB9KTtcclxuICAgICAgaWYgKHIuY2FuY2VsZWQgfHwgci5maWxlUGF0aHNbMF0gPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBjYW5jZWxlZDogdHJ1ZSB9O1xyXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgcGF0aDogci5maWxlUGF0aHNbMF0gfTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gQCBcdTk2NDRcdTRFRjY6XHU1REU1XHU0RjVDXHU1MzNBXHU2NTg3XHU0RUY2XHU2NDFDXHU3RDIyKHJ1bnRpbWUgXHU2Mzg4XHU2NzQzXHU3Njg0XHU4REVGXHU1Rjg0XHU2NzY1XHU2RTkwKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmZzLXNlYXJjaCcsIChldmVudCwgcTogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBxdWVyeSA9IHR5cGVvZiBxID09PSAnc3RyaW5nJyA/IHEuc2xpY2UoMCwgMjAwKSA6ICcnO1xyXG4gICAgICBpZiAocXVlcnkgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgcmVzdWx0czogW10gfSk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjx7IHJlc3VsdHM6IEFycmF5PHsgcmVsOiBzdHJpbmc7IHBhdGg6IHN0cmluZyB9PiB9PihgL2FwaS9mcy9zZWFyY2g/cT0ke2VuY29kZVVSSUNvbXBvbmVudChxdWVyeSl9YCkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTphcHByb3ZlJywgKGV2ZW50LCBncmFudGVkOiB1bmtub3duLCBzZXNzaW9uSWQ6IHVua25vd24pID0+XHJcbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KCcvYXBpL2FwcHJvdmUnLCB7XHJcbiAgICAgICAgZ3JhbnRlZDogZ3JhbnRlZCA9PT0gdHJ1ZSxcclxuICAgICAgICBzZXNzaW9uSWQ6IHR5cGVvZiBzZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gc2Vzc2lvbklkLnNsaWNlKDAsIDgwKSA6ICcnLFxyXG4gICAgICB9KSkpO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6aW50ZXJydXB0JywgKGV2ZW50LCBzZXNzaW9uSWQ6IHVua25vd24pID0+XHJcbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KCcvYXBpL2ludGVycnVwdCcsIHtcclxuICAgICAgICBzZXNzaW9uSWQ6IHR5cGVvZiBzZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gc2Vzc2lvbklkLnNsaWNlKDAsIDgwKSA6ICcnLFxyXG4gICAgICB9KSkpO1xyXG5cclxuICAgIC8vIC0tLS0gTTQ6XHU1REU1XHU0RjVDXHU1MzNBXHU2NTg3XHU0RUY2XHU5NzYyKFx1OERFRlx1NUY4NFx1NjM4OFx1Njc0M1x1NTcyOCBydW50aW1lOmluc2lkZVdzIFx1NjgyMVx1OUE4QykgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpmcy1saXN0JywgKGV2ZW50LCBwYXRoOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IHAgPSB0eXBlb2YgcGF0aCA9PT0gJ3N0cmluZycgPyBwYXRoLnNsaWNlKDAsIDEwMDApIDogJyc7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oYC9hcGkvZnM/ZmlsZXM9MSR7cCAhPT0gJycgPyBgJnBhdGg9JHtlbmNvZGVVUklDb21wb25lbnQocCl9YCA6ICcnfWApKTtcclxuICAgIH0pO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6ZnMtcmVhZCcsIChldmVudCwgcGF0aDogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBwID0gdHlwZW9mIHBhdGggPT09ICdzdHJpbmcnID8gcGF0aC5zbGljZSgwLCAxMDAwKSA6ICcnO1xyXG4gICAgICBpZiAocCA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ3BhdGggcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KGAvYXBpL2ZzL3JlYWQ/cGF0aD0ke2VuY29kZVVSSUNvbXBvbmVudChwKX1gKSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmluamVjdCcsIChldmVudCwgdGV4dDogdW5rbm93biwgc2Vzc2lvbklkOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IHQgPSB0eXBlb2YgdGV4dCA9PT0gJ3N0cmluZycgPyB0ZXh0LnNsaWNlKDAsIDIwXzAwMCkgOiAnJztcclxuICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIHNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBzZXNzaW9uSWQuc2xpY2UoMCwgODApIDogJyc7XHJcbiAgICAgIGlmICh0ID09PSAnJyB8fCBzaWQgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgb2s6IGZhbHNlLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvaW5qZWN0JywgeyB0ZXh0OiB0LCBzZXNzaW9uSWQ6IHNpZCB9KSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIFx1NEYxQVx1OEJERFx1NUJGQ1x1NTFGQShleHBvcnQubWQgXHUyMTkyIFx1NEZERFx1NUI1OFx1NUJGOVx1OEJERFx1Njg0NjtcdTY1ODdcdTRFRjZcdTUxOTlcdTUxNjVcdTUzRUFcdTU3MjggbWFpbikgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpleHBvcnQtc2Vzc2lvbicsIGFzeW5jIChldmVudCwgaWQ6IHVua25vd24sIHRpdGxlOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IHNpZCA9IHR5cGVvZiBpZCA9PT0gJ3N0cmluZycgPyBpZC5yZXBsYWNlKC9bXmEtekEtWjAtOV86LkAtXS9nLCAnJykuc2xpY2UoMCwgODApIDogJyc7XHJcbiAgICAgIGlmIChzaWQgPT09ICcnKSByZXR1cm4geyBlcnJvcjogJ2lkIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9O1xyXG4gICAgICBpZiAoY2xpZW50ID09PSBudWxsIHx8IGJyaWRnZS5ob3N0U3RhdGUgIT09ICdyZWFkeScpIHJldHVybiB7IGVycm9yOiBgaG9zdCBub3QgcmVhZHkgKCR7YnJpZGdlLmhvc3RTdGF0ZX0pYCwgY29kZTogJ0hPU1RfTk9UX1JFQURZJyB9O1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IG1kID0gYXdhaXQgY2xpZW50LmdldFRleHQoYC9hcGkvc2Vzc2lvbnMvJHtlbmNvZGVVUklDb21wb25lbnQoc2lkKX0vZXhwb3J0Lm1kYCk7XHJcbiAgICAgICAgY29uc3Qgd2luID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkuZmluZCgodykgPT4gIXcuaXNEZXN0cm95ZWQoKSk7XHJcbiAgICAgICAgaWYgKHdpbiA9PT0gdW5kZWZpbmVkKSByZXR1cm4geyBlcnJvcjogJ25vIHdpbmRvdycsIGNvZGU6ICdCUklER0VfRVJST1InIH07XHJcbiAgICAgICAgY29uc3QgciA9IGF3YWl0IGRpYWxvZy5zaG93U2F2ZURpYWxvZyh3aW4sIHtcclxuICAgICAgICAgIHRpdGxlOiB0eXBlb2YgdGl0bGUgPT09ICdzdHJpbmcnICYmIHRpdGxlICE9PSAnJyA/IHRpdGxlLnNsaWNlKDAsIDgwKSA6ICdcdTVCRkNcdTUxRkFcdTRGMUFcdThCREQnLFxyXG4gICAgICAgICAgZGVmYXVsdFBhdGg6IGBobWgtJHtzaWR9Lm1kYCxcclxuICAgICAgICAgIGZpbHRlcnM6IFt7IG5hbWU6ICdNYXJrZG93bicsIGV4dGVuc2lvbnM6IFsnbWQnXSB9XSxcclxuICAgICAgICB9KTtcclxuICAgICAgICBpZiAoci5jYW5jZWxlZCB8fCByLmZpbGVQYXRoID09PSB1bmRlZmluZWQgfHwgci5maWxlUGF0aCA9PT0gJycpIHJldHVybiB7IG9rOiBmYWxzZSwgY2FuY2VsZWQ6IHRydWUgfTtcclxuICAgICAgICBhd2FpdCB3cml0ZUZpbGUoci5maWxlUGF0aCwgbWQsICd1dGY4Jyk7XHJcbiAgICAgICAgbG9nSW5mbygnZXhwb3J0JywgYHNlc3Npb24gJHtzaWR9IFx1MjE5MiAke3IuZmlsZVBhdGh9YCk7XHJcbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHBhdGg6IHIuZmlsZVBhdGggfTtcclxuICAgICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgY29uc3QgZGV0YWlsID0gKCgpID0+IHsgdHJ5IHsgcmV0dXJuIEpTT04uc3RyaW5naWZ5KGVycik7IH0gY2F0Y2ggeyByZXR1cm4gU3RyaW5nKGVycik7IH0gfSkoKS5zbGljZSgwLCAzMDApO1xyXG4gICAgICAgIHJldHVybiB7IGVycm9yOiBkZXRhaWwsIGNvZGU6ICdCUklER0VfRVJST1InIH07XHJcbiAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gXHU1QkExXHU2Mjc5XHU2QTIxXHU1RjBGXHU4QkZCXHU1MTk5KFx1Njc0M1x1NUEwMVx1NTcyOCBydW50aW1lIGNvbmZpZztcdTUyMDdcdTYzNjJcdTVGQzVcdTk4N0JcdTY2M0VcdTVGMEYpIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6YXBwcm92YWwtZ2V0JywgKGV2ZW50KSA9PlxyXG4gICAgICBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjx7IHNldHRpbmdzPzogeyBhcHByb3ZhbD86IHN0cmluZyB9IH0+KCcvYXBpL3N0YXRlJykpKTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmFwcHJvdmFsLXNldCcsIChldmVudCwgbW9kZTogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBtID0gbW9kZSA9PT0gJ2F1dG8nID8gJ2F1dG8nIDogbW9kZSA9PT0gJ2FzaycgPyAnYXNrJyA6ICcnO1xyXG4gICAgICBpZiAobSA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ21vZGUgbXVzdCBiZSBhc2t8YXV0bycsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PignL2FwaS9jb25maWcnLCB7IGFwcHJvdmFsOiBtIH0pKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gaG1oYXJuZXNzIHJ1bnRpbWUgXHU4RkRFXHU2M0E1KFx1ODFFQVx1NTJBOFx1NTNEMVx1NzNCMCArIFx1NjI0Qlx1NTJBOFx1ODk4Nlx1NzZENiArIFx1NzBFRFx1NTIwN1x1NjM2MikgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpydW50aW1lLWluZm8nLCBhc3luYyAoZXZlbnQpID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgY29uc3QgZCA9IGRldGVjdEV4dGVybmFsUnVudGltZSgpO1xyXG4gICAgICBjb25zdCBjZmcgPSBhd2FpdCBsb2FkUnVudGltZUNvbmZpZygpO1xyXG4gICAgICByZXR1cm4ge1xyXG4gICAgICAgIG1vZGU6IGJyaWRnZS5tb2RlLFxyXG4gICAgICAgIHJ1bnRpbWVFbnRyeTogYnJpZGdlLnJ1bnRpbWVFbnRyeSxcclxuICAgICAgICBvdmVycmlkZTogY2ZnLmVudHJ5LFxyXG4gICAgICAgIGRlbW86IGNmZy5kZW1vLFxyXG4gICAgICAgIGRldGVjdGVkOiBkLmVudHJ5LFxyXG4gICAgICAgIGRldGVjdGVkVmVyc2lvbjogZC52ZXJzaW9uLFxyXG4gICAgICAgIGRldGVjdGVkU291cmNlOiBkLnNvdXJjZSxcclxuICAgICAgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6YnJvd3NlLXJ1bnRpbWUnLCBhc3luYyAoZXZlbnQsIHRpdGxlOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IHdpbiA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmZpbmQoKHcpID0+ICF3LmlzRGVzdHJveWVkKCkpO1xyXG4gICAgICBpZiAod2luID09PSB1bmRlZmluZWQpIHJldHVybiB7IGVycm9yOiAnbm8gd2luZG93JywgY29kZTogJ0JSSURHRV9FUlJPUicgfTtcclxuICAgICAgY29uc3QgciA9IGF3YWl0IGRpYWxvZy5zaG93T3BlbkRpYWxvZyh3aW4sIHtcclxuICAgICAgICB0aXRsZTogdHlwZW9mIHRpdGxlID09PSAnc3RyaW5nJyAmJiB0aXRsZSAhPT0gJycgPyB0aXRsZS5zbGljZSgwLCAxMjApIDogJ1x1OTAwOVx1NjJFOSBobWhhcm5lc3MgXHU3Njg0IGRlc2t0b3AtaG9zdCBcdTUxNjVcdTUzRTMnLFxyXG4gICAgICAgIHByb3BlcnRpZXM6IFsnb3BlbkZpbGUnXSxcclxuICAgICAgICBmaWx0ZXJzOiBbeyBuYW1lOiAnZGVza3RvcC1ob3N0JywgZXh0ZW5zaW9uczogWyd0cycsICdqcyddIH1dLFxyXG4gICAgICB9KTtcclxuICAgICAgaWYgKHIuY2FuY2VsZWQgfHwgci5maWxlUGF0aHNbMF0gPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBjYW5jZWxlZDogdHJ1ZSB9O1xyXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgZW50cnk6IHIuZmlsZVBhdGhzWzBdIH07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiogXHU4QkJFXHU3RjZFL1x1NkUwNVx1OTY2NFx1NjI0Qlx1NTJBOFx1NTE2NVx1NTNFM1x1NTQwRVx1NzBFRFx1OTFDRFx1NTQyRiBob3N0KFx1N0E3QVx1NEUzMj1cdTU2REVcdTUyMzBcdTgxRUFcdTUyQThcdTUzRDFcdTczQjApXHUzMDAyICovXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnNldC1ydW50aW1lJywgYXN5bmMgKGV2ZW50LCBlbnRyeTogdW5rbm93bikgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBjb25zdCBlID0gdHlwZW9mIGVudHJ5ID09PSAnc3RyaW5nJyA/IGVudHJ5LnRyaW0oKSA6ICcnO1xyXG4gICAgICBpZiAoZSAhPT0gJycgJiYgKCFpc0Fic29sdXRlKGUpIHx8ICFleGlzdHNTeW5jKGUpKSkge1xyXG4gICAgICAgIHJldHVybiB7IGVycm9yOiAnXHU1MTY1XHU1M0UzXHU1RkM1XHU5ODdCXHU2NjJGXHU1QjU4XHU1NzI4XHU3Njg0XHU3RUREXHU1QkY5XHU4REVGXHU1Rjg0KGRlc2t0b3AtaG9zdC50cyknLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH07XHJcbiAgICAgIH1cclxuICAgICAgYXdhaXQgc2F2ZVJ1bnRpbWVFbnRyeU92ZXJyaWRlKGUpO1xyXG4gICAgICAvLyBcdTcwRURcdTUyMDdcdTYzNjI6XHU1MTQ4XHU0RjE4XHU5NkM1XHU1MDVDXHU2Mzg5XHU1RjUzXHU1MjREIGhvc3QsXHU1MThEXHU2MzA5XHU2NUIwXHU5MTREXHU3RjZFXHU2MkM5XHU4RDc3XHJcbiAgICAgIHNzZUFib3J0Py5hYm9ydCgpO1xyXG4gICAgICBpZiAoc3VwZXJ2aXNvciAhPT0gbnVsbCkgYXdhaXQgc3VwZXJ2aXNvci5zdG9wKCk7XHJcbiAgICAgIGF3YWl0IHN0YXJ0SG9zdCgpO1xyXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgbW9kZTogYnJpZGdlLm1vZGUgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gdjUuMSBcdTk5OTZcdTU0MkZcdTVCODlcdTg4QzVcdTU0MTFcdTVCRkM6XHU2NzJDXHU2NzNBXHU2OEMwXHU2RDRCIC8gXHU0RTBCXHU4RjdEXHU1Qjg5XHU4OEM1KFx1OEZEQlx1NUVBNlx1NEU4Qlx1NEVGNikgLyBcdTU0MTFcdTVCRkNcdTcyQjZcdTYwMDEgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpkZXRlY3QtcnVudGltZScsIChldmVudCkgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBjb25zdCBpbmZvID0gYnVuZGxlZFJ1bnRpbWVJbmZvKCk7XHJcbiAgICAgIC8vIFVJVkVSSUZZIFx1NTQxMVx1NUJGQ1x1NkI2NVx1NzY4NFwiXHU0RjJBXHU5MDIwXHU2NzJBXHU5MTREXHU3RjZFXHU2MDAxXCI6ZmFrZSBcdTZBMjFcdTVGMEZcdTRFMEJcdTYwNTJcdTYyQTVcdTY3MkFcdTY4QzBcdTZENEJcclxuICAgICAgLy8gKFx1NzcxRlx1NUI5RVx1NjhDMFx1NkQ0Qlx1OERFRlx1NUY4NFx1NzUzMSByZWFsIFx1NTNEOFx1NEY1M1x1OUE4Q1x1NjUzNixcdTg5QzEgZXZpZGVuY2Uvc2V0dXAtd2l6YXJkLylcclxuICAgICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX1dJWkFSRCA9PT0gJ2Zha2UnICYmIHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX0ZBS0UgPT09ICcxJykge1xyXG4gICAgICAgIHJldHVybiB7IGZvdW5kOiBmYWxzZSwgdmVyc2lvbjogJycsIGVudHJ5OiAnJywgc291cmNlOiAnJywgYnVuZGxlZDogaW5mbywgbnBtOiBucG1PblBhdGgoKSB9O1xyXG4gICAgICB9XHJcbiAgICAgIGNvbnN0IGQgPSBkZXRlY3RFeHRlcm5hbFJ1bnRpbWUoKTtcclxuICAgICAgcmV0dXJuIHsgZm91bmQ6IGQuZW50cnkgIT09ICcnLCB2ZXJzaW9uOiBkLnZlcnNpb24sIGVudHJ5OiBkLmVudHJ5LCBzb3VyY2U6IGQuc291cmNlLCBidW5kbGVkOiBpbmZvLCBucG06IG5wbU9uUGF0aCgpIH07XHJcbiAgICB9KTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmluc3RhbGwtY2xpJywgKGV2ZW50LCBvcHRzOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IG8gPSAob3B0cyA/PyB7fSkgYXMgeyBmb3JjZVRnej86IHVua25vd247IG1pcnJvckZpcnN0PzogdW5rbm93biB9O1xyXG4gICAgICByZXR1cm4gc3RhcnRDbGlJbnN0YWxsKFxyXG4gICAgICAgIHtcclxuICAgICAgICAgIHNlbmRQcm9ncmVzczogKHA6IEluc3RhbGxQcm9ncmVzcyk6IHZvaWQgPT4ge1xyXG4gICAgICAgICAgICBsb2dJbmZvKCdpbnN0YWxsJywgYCR7cC5waGFzZX0ke3AucGN0ICE9PSB1bmRlZmluZWQgPyBgICR7cC5wY3R9JWAgOiAnJ30gJHtwLnRleHR9YCk7XHJcbiAgICAgICAgICAgIGZvciAoY29uc3QgdyBvZiBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKSkge1xyXG4gICAgICAgICAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ2luc3RhbGw6cHJvZ3Jlc3MnLCBwKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgfSxcclxuICAgICAgICAgIGxvZzogKG06IHN0cmluZyk6IHZvaWQgPT4geyBsb2dJbmZvKCdpbnN0YWxsJywgbSk7IH0sXHJcbiAgICAgICAgICAvLyBcdTVCODlcdTg4QzVcdTYyMTBcdTUyOUZcdTUzNzNcdTYzMDFcdTRFNDVcdTUzMTZcdTVFNzZcdTcwRURcdTUyMDdcdTYzNjIoXHU1NDExXHU1QkZDXHU5NjhGXHU1NDBFXHU2NTM2XHU1QzNFO1x1NEUyRFx1OTAxNFx1NTNENlx1NkQ4OFx1NEU1Rlx1NURGMlx1NzUxRlx1NjU0OClcclxuICAgICAgICAgIG9uSW5zdGFsbGVkOiAoZW50cnk6IHN0cmluZyk6IHZvaWQgPT4ge1xyXG4gICAgICAgICAgICB2b2lkIChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgICAgICAgYXdhaXQgc2F2ZVJ1bnRpbWVDb25maWcoeyBlbnRyeSwgZGVtbzogZmFsc2UgfSk7XHJcbiAgICAgICAgICAgICAgc3NlQWJvcnQ/LmFib3J0KCk7XHJcbiAgICAgICAgICAgICAgaWYgKHN1cGVydmlzb3IgIT09IG51bGwpIGF3YWl0IHN1cGVydmlzb3Iuc3RvcCgpO1xyXG4gICAgICAgICAgICAgIGF3YWl0IHN0YXJ0SG9zdCgpO1xyXG4gICAgICAgICAgICB9KSgpO1xyXG4gICAgICAgICAgfSxcclxuICAgICAgICB9LFxyXG4gICAgICAgIHtcclxuICAgICAgICAgIGZvcmNlVGd6OiBvLmZvcmNlVGd6ID09PSB0cnVlLFxyXG4gICAgICAgICAgbWlycm9yRmlyc3Q6IG8ubWlycm9yRmlyc3QgPT09ICducG1taXJyb3InID8gJ25wbW1pcnJvcicgOiBvLm1pcnJvckZpcnN0ID09PSAnbnBtanMnID8gJ25wbWpzJyA6IHVuZGVmaW5lZCxcclxuICAgICAgICB9LFxyXG4gICAgICApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpnZXQtd2l6YXJkJywgYXN5bmMgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IHZhcmlhbnQgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9XSVpBUkQ7XHJcbiAgICAgIGlmICh2YXJpYW50ICE9PSB1bmRlZmluZWQgJiYgdmFyaWFudCAhPT0gJycpIHtcclxuICAgICAgICAvLyBcdTlBOENcdTY1MzZcdTY3ODRcdTkwMjA6XHU1RjNBXHU1MjM2XHU1NDExXHU1QkZDXHU1M0VGXHU4OUMxXHU0RTE0XHU4OUM2XHU0RTNBXHU2NzJBXHU5MTREXHU3RjZFKFx1NTNFRlx1OTFDRFx1NTkwRFx1OEREMSk7cGVyc2lzdGVkPVx1NzcxRlx1NUI5RVx1ODQzRFx1NzZEOFxyXG4gICAgICAgIC8vIFx1NzJCNlx1NjAwMShcdTU0MTFcdTVCRkNcdTZCNjVcdTY1QURcdThBMDBcIlx1OTAwOVx1NjJFOVx1NjMwMVx1NEU0NVwiXHU3NTI4LFx1NEUwRFx1NUY3MVx1NTRDRCBVSSBcdTUyMjRcdTVCOUEpXHJcbiAgICAgICAgY29uc3QgdyA9IGF3YWl0IGxvYWRXaXphcmRTdGF0ZSgpO1xyXG4gICAgICAgIHJldHVybiB7IGRvbmU6IGZhbHNlLCBjaG9pY2U6ICcnLCBzdXBwcmVzc2VkOiBmYWxzZSwgcGVyc2lzdGVkOiB7IGRvbmU6IHcuZG9uZSwgY2hvaWNlOiB3LmNob2ljZSB9IH07XHJcbiAgICAgIH1cclxuICAgICAgY29uc3QgdyA9IGF3YWl0IGxvYWRXaXphcmRTdGF0ZSgpO1xyXG4gICAgICBjb25zdCBjZmcgPSBhd2FpdCBsb2FkUnVudGltZUNvbmZpZygpO1xyXG4gICAgICAvLyBcdTVERjJcdTkxNERcdTdGNkVcdThGQzcgcnVudGltZShcdTYyNEJcdTUyQThcdTUxNjVcdTUzRTMvXHU1NDExXHU1QkZDXHU5MDA5XHU2MkU5L1x1NkYxNFx1NzkzQSlcdTg5QzZcdTU0MENcdTVERjJcdTVCOENcdTYyMTBcdTk5OTZcdTU0MkZcclxuICAgICAgcmV0dXJuIHsgZG9uZTogdy5kb25lIHx8IGNmZy5lbnRyeSAhPT0gJycgfHwgY2ZnLmRlbW8sIGNob2ljZTogdy5jaG9pY2UsIHN1cHByZXNzZWQ6IHdpemFyZFN1cHByZXNzZWQoKSB9O1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyoqIFx1NTQxMVx1NUJGQ1x1NjUzNlx1NUMzRTpcdTYzMDFcdTRFNDVcdTUzMTZcdTkwMDlcdTYyRTlcdTVFNzZcdTVFOTRcdTc1MjgoZXh0ZXJuYWwvYnVuZGxlZFx1MjE5Mlx1NTE2NVx1NTNFM1x1ODk4Nlx1NzZENjtkZW1vXHUyMTkyXHU2MzAxXHU0RTQ1XHU2RjE0XHU3OTNBO1xyXG4gICAgICogIGluc3RhbGxcdTIxOTJcdTUxNjVcdTUzRTNcdTVERjJcdTc1MzFcdTVCODlcdTg4QzVcdTU2NjhcdTYzMDFcdTRFNDVcdTUzMTYsXHU1M0VBXHU4QkIwXHU3MkI2XHU2MDAxKVx1MzAwMmZha2UvXHU2RDRCXHU4QkQ1XHU3M0FGXHU1ODgzXHU1M0VBXHU4QkIwXHU3MkI2XHU2MDAxXHUzMDAyICovXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOndpemFyZC1jb21wbGV0ZScsIGFzeW5jIChldmVudCwgY2hvaWNlOiB1bmtub3duLCBlbnRyeTogdW5rbm93bikgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBjb25zdCBjID0gY2hvaWNlID09PSAnZXh0ZXJuYWwnIHx8IGNob2ljZSA9PT0gJ2luc3RhbGwnIHx8IGNob2ljZSA9PT0gJ2J1bmRsZWQnIHx8IGNob2ljZSA9PT0gJ2RlbW8nID8gY2hvaWNlIDogJyc7XHJcbiAgICAgIGlmIChjID09PSAnJykgcmV0dXJuIHsgZXJyb3I6ICdjaG9pY2UgbXVzdCBiZSBleHRlcm5hbHxpbnN0YWxsfGJ1bmRsZWR8ZGVtbycsIGNvZGU6ICdCQURfUkVRVUVTVCcgfTtcclxuICAgICAgY29uc3QgZSA9IHR5cGVvZiBlbnRyeSA9PT0gJ3N0cmluZycgPyBlbnRyeSA6ICcnO1xyXG4gICAgICBhd2FpdCBzYXZlV2l6YXJkU3RhdGUoYyk7XHJcbiAgICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9GQUtFID09PSAnMScpIHJldHVybiB7IG9rOiB0cnVlLCBtb2RlOiBicmlkZ2UubW9kZSwgdGVzdDogdHJ1ZSB9O1xyXG4gICAgICBjb25zdCByZXBvUm9vdCA9IGpvaW4oaGVyZSwgJy4uJywgJy4uJywgJy4uJywgJy4uJyk7XHJcbiAgICAgIGlmIChjID09PSAnZXh0ZXJuYWwnIHx8IGMgPT09ICdidW5kbGVkJykge1xyXG4gICAgICAgIGNvbnN0IHRhcmdldCA9IGMgPT09ICdidW5kbGVkJyA/IGJ1bmRsZWRSdW50aW1lUGF0aChyZXBvUm9vdCkgOiBlO1xyXG4gICAgICAgIGlmICh0YXJnZXQgPT09ICcnIHx8ICFpc0Fic29sdXRlKHRhcmdldCkgfHwgIWV4aXN0c1N5bmModGFyZ2V0KSkge1xyXG4gICAgICAgICAgcmV0dXJuIHsgZXJyb3I6ICdydW50aW1lIFx1NTE2NVx1NTNFM1x1NEUwRFx1NUI1OFx1NTcyOCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfTtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgc2F2ZVJ1bnRpbWVDb25maWcoeyBlbnRyeTogdGFyZ2V0LCBkZW1vOiBmYWxzZSB9KTtcclxuICAgICAgfSBlbHNlIGlmIChjID09PSAnZGVtbycpIHtcclxuICAgICAgICBhd2FpdCBzYXZlUnVudGltZUNvbmZpZyh7IGVudHJ5OiAnJywgZGVtbzogdHJ1ZSB9KTtcclxuICAgICAgfVxyXG4gICAgICBpZiAoYyAhPT0gJ2luc3RhbGwnKSB7XHJcbiAgICAgICAgLy8gaW5zdGFsbDpcdTVCODlcdTg4QzVcdTU2NjhcdTVERjJcdTU3Mjggb25JbnN0YWxsZWQgXHU2MzAxXHU0RTQ1XHU1MzE2XHU1RTc2XHU3MEVEXHU1MjA3XHU2MzYyLFx1OEZEOVx1OTFDQ1x1NEUwRFx1NTE4RFx1OTFDRFx1NTQyRlxyXG4gICAgICAgIHNzZUFib3J0Py5hYm9ydCgpO1xyXG4gICAgICAgIGlmIChzdXBlcnZpc29yICE9PSBudWxsKSBhd2FpdCBzdXBlcnZpc29yLnN0b3AoKTtcclxuICAgICAgICBhd2FpdCBzdGFydEhvc3QoKTtcclxuICAgICAgfVxyXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgbW9kZTogYnJpZGdlLm1vZGUgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gUHJvdmlkZXIgXHU4QkJFXHU3RjZFKDAzIFx1MDBBN1x1NEUwMzprZXkgXHU1M0VBXHU1MUZBIGhhc0tleS9cdTY3MkJcdTU2REJcdTRGNEQ7XHU0RkREXHU1QjU4XHU3NkY0XHU1MTk5IHJ1bnRpbWUpIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cHJvdmlkZXJzJywgKGV2ZW50KSA9PlxyXG4gICAgICBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjx7IHByb3ZpZGVyc0RldGFpbD86IEFycmF5PHsgbmFtZTogc3RyaW5nOyBtb2RlbDogc3RyaW5nOyBiYXNlVXJsOiBzdHJpbmc7IGhhc0tleTogYm9vbGVhbjsga2V5VGFpbD86IHN0cmluZyB9PjsgbW9kZWw/OiBzdHJpbmcgfT4oJy9hcGkvc3RhdGUnKSkpO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cHJvdmlkZXItc2F2ZScsIChldmVudCwgcHJvdmlkZXI6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3QgcCA9IHByb3ZpZGVyIGFzIHsgbmFtZT86IHVua25vd247IGJhc2VVcmw/OiB1bmtub3duOyBtb2RlbD86IHVua25vd247IGFwaUtleT86IHVua25vd24gfTtcclxuICAgICAgY29uc3QgbmFtZSA9IHR5cGVvZiBwPy5uYW1lID09PSAnc3RyaW5nJyA/IHAubmFtZS5zbGljZSgwLCA4MCkgOiAnJztcclxuICAgICAgY29uc3QgYmFzZVVybCA9IHR5cGVvZiBwPy5iYXNlVXJsID09PSAnc3RyaW5nJyA/IHAuYmFzZVVybC5zbGljZSgwLCAzMDApIDogJyc7XHJcbiAgICAgIGNvbnN0IG1vZGVsID0gdHlwZW9mIHA/Lm1vZGVsID09PSAnc3RyaW5nJyA/IHAubW9kZWwuc2xpY2UoMCwgMTIwKSA6ICcnO1xyXG4gICAgICBpZiAobmFtZSA9PT0gJycgfHwgYmFzZVVybCA9PT0gJycgfHwgbW9kZWwgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICduYW1lL2Jhc2VVcmwvbW9kZWwgcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xyXG4gICAgICBjb25zdCBib2R5OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgbmFtZSwgYmFzZVVybCwgbW9kZWwgfTtcclxuICAgICAgLy8gYXBpS2V5IFx1NTNFQVx1NTcyOFx1NjYzRVx1NUYwRlx1OEY5M1x1NTE2NVx1NjVGNlx1NEUwQVx1NEYyMCxcdTdFRERcdTRFMERcdTU2REVcdTY2M0UocmVuZGVyZXIgXHU4ODY4XHU1MzU1XHU2M0QwXHU0RUE0XHU1NDBFXHU1MzczXHU2RTA1XHU3QTdBKVxyXG4gICAgICBpZiAodHlwZW9mIHA/LmFwaUtleSA9PT0gJ3N0cmluZycgJiYgcC5hcGlLZXkgIT09ICcnKSBib2R5LmFwaUtleSA9IHAuYXBpS2V5LnNsaWNlKDAsIDMwMCk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PignL2FwaS9wcm92aWRlcnMnLCBib2R5KSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIFx1NURFNVx1NEY1Q1x1NTMzQSgwMyBcdTAwQTdcdTUxNkQ7XHU1MjA3XHU2MzYyXHU4QkVEXHU0RTQ5XHU0RTBFIHdlYiBcdTc2RjhcdTU0MEM6cnVudGltZSBcdTUzNTVcdTkwMDkgY3dkKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOndvcmtzcGFjZXMnLCAoZXZlbnQpID0+XHJcbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPHsgY3VycmVudDogc3RyaW5nOyBpdGVtczogQXJyYXk8eyBpZDogc3RyaW5nOyBuYW1lOiBzdHJpbmc7IHBhdGg6IHN0cmluZyB9PiB9PignL2FwaS93b3Jrc3BhY2VzJykpKTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOndvcmtzcGFjZS11c2UnLCAoZXZlbnQsIGlkOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IHdpZCA9IHR5cGVvZiBpZCA9PT0gJ3N0cmluZycgPyBpZC5zbGljZSgwLCA2MCkgOiAnJztcclxuICAgICAgaWYgKHdpZCA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ2lkIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcclxuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KCcvYXBpL3dvcmtzcGFjZXMvdXNlJywgeyBpZDogd2lkIH0pKTtcclxuICAgIH0pO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6d29ya3NwYWNlLWFkZCcsIChldmVudCwgbmFtZTogdW5rbm93biwgcGF0aDogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBuID0gdHlwZW9mIG5hbWUgPT09ICdzdHJpbmcnID8gbmFtZS5zbGljZSgwLCAxMjApIDogJyc7XHJcbiAgICAgIGNvbnN0IHAgPSB0eXBlb2YgcGF0aCA9PT0gJ3N0cmluZycgPyBwYXRoLnNsaWNlKDAsIDEwMDApIDogJyc7XHJcbiAgICAgIGlmIChwID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAncGF0aCByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PignL2FwaS93b3Jrc3BhY2VzJywgeyBuYW1lOiBuID09PSAnJyA/IHVuZGVmaW5lZCA6IG4sIHBhdGg6IHAgfSkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBcdTRGMUFcdThCRERcdTVGNTJcdTY4NjMvXHU1MjIwXHU5NjY0KFx1NzlGQlx1NTE2NSBhcmNoaXZlL3RyYXNoLFx1NTNFRlx1NjA2Mlx1NTkwRDtydW50aW1lIFx1Njc0M1x1NUEwMSkgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpzZXNzaW9uLW9wJywgKGV2ZW50LCBpZDogdW5rbm93biwgb3A6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIGlkID09PSAnc3RyaW5nJyA/IGlkLnJlcGxhY2UoL1teYS16QS1aMC05XzouQC1dL2csICcnKS5zbGljZSgwLCA4MCkgOiAnJztcclxuICAgICAgY29uc3QgbyA9IG9wID09PSAnYXJjaGl2ZScgfHwgb3AgPT09ICdkZWxldGUnID8gb3AgOiAnJztcclxuICAgICAgaWYgKHNpZCA9PT0gJycgfHwgbyA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ2lkIGFuZCBvcChhcmNoaXZlfGRlbGV0ZSkgcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oYC9hcGkvc2Vzc2lvbnMvJHtlbmNvZGVVUklDb21wb25lbnQoc2lkKX0vJHtvfWAsIHt9KSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIE00OkRpZmYgXHU5NzYyXHU2NzdGKFx1NTNFQVx1OEJGQiBnaXQgXHU1M0Q4XHU2NkY0O1x1NjM4OFx1Njc0M1x1NTcyOCBydW50aW1lKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmRpZmYnLCAoZXZlbnQsIHNlc3Npb25JZDogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBzaWQgPSB0eXBlb2Ygc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IHNlc3Npb25JZC5zbGljZSgwLCA4MCkgOiAnJztcclxuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPFJlY29yZDxzdHJpbmcsIHVua25vd24+PihgL2FwaS9kaWZmJHtzaWQgIT09ICcnID8gYD9zZXNzaW9uSWQ9JHtlbmNvZGVVUklDb21wb25lbnQoc2lkKX1gIDogJyd9YCkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBNNTpcdThCQTRcdTc3RTVcdTcyQjZcdTYwMDEoXHU3RUQzXHU2Nzg0XHU1MzE2XHU0RThCXHU1QjlFO1x1N0YzQVx1NjU3MFx1NjM2RVx1NUI1N1x1NkJCNVx1NzUzMSBVSSBcdTY2M0VcdTc5M0FcIlx1NjVFMFx1NjU3MFx1NjM2RVwiKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmNvZ25pdGl2ZScsIChldmVudCkgPT5cclxuICAgICAgaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KCcvYXBpL2NvZ25pdGl2ZScpKSk7XHJcblxyXG4gICAgLy8gLS0tLSBcdTUzODZcdTUzRjJcdTRGMUFcdThCRERcdTk4ODRcdTg5QzgoXHU2NzAwXHU1NDBFIDgwIFx1Njc2MSxcdTZCQ0ZcdTY3NjEgNTAwIFx1NUI1NztydW50aW1lIFx1Njc0M1x1NUEwMVx1NjU3MFx1NjM2RSkgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpzZXNzaW9uLXByZXZpZXcnLCAoZXZlbnQsIGlkOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IHNpZCA9IHR5cGVvZiBpZCA9PT0gJ3N0cmluZycgPyBpZC5yZXBsYWNlKC9bXmEtekEtWjAtOV86LkAtXS9nLCAnJykuc2xpY2UoMCwgODApIDogJyc7XHJcbiAgICAgIGlmIChzaWQgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICdpZCByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oYC9hcGkvc2Vzc2lvbnMvJHtlbmNvZGVVUklDb21wb25lbnQoc2lkKX1gKSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnN0b3AtaG9zdCcsIChldmVudCkgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInIH07XHJcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcclxuICAgICAgICBzc2VBYm9ydD8uYWJvcnQoKTtcclxuICAgICAgICBhd2FpdCBzdXBlcnZpc29yPy5zdG9wKCk7XHJcbiAgICAgICAgYXBwLnF1aXQoKTtcclxuICAgICAgfSkoKTtcclxuICAgICAgcmV0dXJuIHsgb2s6IHRydWUgfTtcclxuICAgIH0pO1xyXG4gIH1cclxuXHJcbiAgLyogLS0tLSBcdTdBOTdcdTUzRTNcdTRFMEVcdTVCODlcdTUxNjhcdTdCNTZcdTc1NjUgLS0tLSAqL1xyXG4gIC8vIDAzIFx1MDBBN1x1NEUwMzpEZXNrdG9wIFx1NjcyQ1x1NTczMFx1NTNFQVx1NUI1OCBVSSBcdTUwNEZcdTU5N0QvXHU3QTk3XHU1M0UzXHU3MkI2XHU2MDAxKHVzZXJEYXRhL3dpbmRvdy1zdGF0ZS5qc29uKVxyXG4gIGNvbnN0IHdpbmRvd1N0YXRlRmlsZSA9ICgpOiBzdHJpbmcgPT4gam9pbihhcHAuZ2V0UGF0aCgndXNlckRhdGEnKSwgJ3dpbmRvdy1zdGF0ZS5qc29uJyk7XHJcbiAgYXN5bmMgZnVuY3Rpb24gbG9hZEJvdW5kcygpOiBQcm9taXNlPHsgd2lkdGg6IG51bWJlcjsgaGVpZ2h0OiBudW1iZXI7IHg/OiBudW1iZXI7IHk/OiBudW1iZXIgfSB8IG51bGw+IHtcclxuICAgIHRyeSB7XHJcbiAgICAgIHJldHVybiBKU09OLnBhcnNlKGF3YWl0IHJlYWRGaWxlKHdpbmRvd1N0YXRlRmlsZSgpLCAndXRmOCcpKSBhcyB7IHdpZHRoOiBudW1iZXI7IGhlaWdodDogbnVtYmVyOyB4PzogbnVtYmVyOyB5PzogbnVtYmVyIH07XHJcbiAgICB9IGNhdGNoIHsgcmV0dXJuIG51bGw7IH1cclxuICB9XHJcbiAgYXN5bmMgZnVuY3Rpb24gc2F2ZUJvdW5kcyh3aW46IEJyb3dzZXJXaW5kb3cpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIHRyeSB7IGF3YWl0IHdyaXRlRmlsZSh3aW5kb3dTdGF0ZUZpbGUoKSwgSlNPTi5zdHJpbmdpZnkod2luLmdldEJvdW5kcygpKSwgJ3V0ZjgnKTsgfSBjYXRjaCB7IC8qIGJlc3QgZWZmb3J0ICovIH1cclxuICB9XHJcblxyXG4gIGFzeW5jIGZ1bmN0aW9uIGNyZWF0ZVdpbmRvdygpOiBQcm9taXNlPEJyb3dzZXJXaW5kb3cgfCBudWxsPiB7XHJcbiAgICBjb25zdCBzYXZlZCA9IGF3YWl0IGxvYWRCb3VuZHMoKTtcclxuICAgIGNvbnN0IHdpbiA9IG5ldyBCcm93c2VyV2luZG93KHtcclxuICAgICAgd2lkdGg6IHNhdmVkPy53aWR0aCA/PyAxNDQwLFxyXG4gICAgICBoZWlnaHQ6IHNhdmVkPy5oZWlnaHQgPz8gOTAwLFxyXG4gICAgICAuLi4oc2F2ZWQ/LnggIT09IHVuZGVmaW5lZCAmJiBzYXZlZD8ueSAhPT0gdW5kZWZpbmVkID8geyB4OiBzYXZlZC54LCB5OiBzYXZlZC55IH0gOiB7fSksXHJcbiAgICAgIG1pbldpZHRoOiA5NjAsXHJcbiAgICAgIG1pbkhlaWdodDogNjAwLFxyXG4gICAgICBzaG93OiBmYWxzZSxcclxuICAgICAgYmFja2dyb3VuZENvbG9yOiAnI2Y5ZmFmYicsIC8vIHY0IERTSDpcdTZENDVcdTgyNzJcdTlFRDhcdThCQTQoYmctYmFzZSksXHU5MDdGXHU1MTREXHU2REYxXHU4MjcyXHU5NUVBXHU1QzRGXHJcbiAgICAgIHRpdGxlOiAnSE1IIERlc2t0b3AnLFxyXG4gICAgICAvLyBcdTk2OTBcdTg1Q0ZcdTVGMEZcdTY4MDdcdTk4OThcdTY4MEY6XHU1MzlGXHU3NTFGXHU3QTk3XHU1M0UzXHU2M0E3XHU1MjM2KG92ZXJsYXkgXHU2M0QwXHU0RjlCKStcdTk4OUNcdTgyNzJcdTk2OEZcdTRFM0JcdTk4OTgocmVuZGVyZXIgXHU3RUNGXHJcbiAgICAgIC8vIGNocm9tZS10aGVtZSBcdTU0MENcdTZCNjUpXHUyMDE0XHUyMDE0XHU2ODM5XHU2Q0JCXHU0RUFFXHU4MjcyXHU2QTIxXHU1RjBGXHU5ODc2XHU5MEU4XHU5RUQxXHU2NzYxO1x1ODNEQ1x1NTM1NVx1NjgwRiBhdXRvSGlkZShBbHQgXHU1NDdDXHU1MUZBKVx1MzAwMlxyXG4gICAgICB0aXRsZUJhclN0eWxlOiAnaGlkZGVuJyxcclxuICAgICAgdGl0bGVCYXJPdmVybGF5OiB7IC4uLmNocm9tZUZvcihuYXRpdmVUaGVtZS5zaG91bGRVc2VEYXJrQ29sb3JzKSwgaGVpZ2h0OiAzNiB9LFxyXG4gICAgICBhdXRvSGlkZU1lbnVCYXI6IHRydWUsXHJcbiAgICAgIHdlYlByZWZlcmVuY2VzOiB7XHJcbiAgICAgICAgcHJlbG9hZDogcHJlbG9hZFBhdGgsXHJcbiAgICAgICAgY29udGV4dElzb2xhdGlvbjogdHJ1ZSxcclxuICAgICAgICBzYW5kYm94OiB0cnVlLFxyXG4gICAgICAgIG5vZGVJbnRlZ3JhdGlvbjogZmFsc2UsXHJcbiAgICAgICAgbm9kZUludGVncmF0aW9uSW5Xb3JrZXI6IGZhbHNlLFxyXG4gICAgICAgIHdlYlNlY3VyaXR5OiB0cnVlLFxyXG4gICAgICAgIHNwZWxsY2hlY2s6IGZhbHNlLFxyXG4gICAgICAgIGRldlRvb2xzOiBpc0RldixcclxuICAgICAgfSxcclxuICAgIH0pO1xyXG4gICAgd2luLm9uY2UoJ3JlYWR5LXRvLXNob3cnLCAoKSA9PiB3aW4uc2hvdygpKTtcclxuICAgIHdpbi5vbignY2xvc2UnLCAoKSA9PiB7IHZvaWQgc2F2ZUJvdW5kcyh3aW4pOyB9KTtcclxuXHJcbiAgICAvLyBcdTUzRUFcdTUxNDFcdThCQjhcdTUyQTBcdThGN0RcdTYyMTFcdTRFRUNcdTgxRUFcdTVERjFcdTc2ODQgcmVuZGVyZXI7XHU0RUZCXHU0RjU1XHU1QkZDXHU4MjJBL1x1NjVCMFx1N0E5N1x1NTNFM1x1NEUwMFx1NUY4Qlx1NjJEMlx1N0VERFxyXG4gICAgd2luLndlYkNvbnRlbnRzLnNldFdpbmRvd09wZW5IYW5kbGVyKCh7IHVybCB9KSA9PiB7XHJcbiAgICAgIGlmICgvXmh0dHBzPzpcXC9cXC8vLnRlc3QodXJsKSkgdm9pZCBzaGVsbC5vcGVuRXh0ZXJuYWwodXJsKTtcclxuICAgICAgcmV0dXJuIHsgYWN0aW9uOiAnZGVueScgfTtcclxuICAgIH0pO1xyXG4gICAgd2luLndlYkNvbnRlbnRzLm9uKCd3aWxsLW5hdmlnYXRlJywgKGUsIHVybCkgPT4ge1xyXG4gICAgICBjb25zdCBvayA9IFsuLi5hbGxvd2VkT3JpZ2luc10uc29tZSgobykgPT4gdXJsID09PSBvIHx8IHVybC5zdGFydHNXaXRoKGAke299L2ApIHx8IHVybC5zdGFydHNXaXRoKGAke299P2ApKTtcclxuICAgICAgaWYgKCFvaykge1xyXG4gICAgICAgIGxvZ0luZm8oJ25hdicsIGBibG9ja2VkIG5hdmlnYXRpb24gdG8gJHt1cmwuc2xpY2UoMCwgMTIwKX1gKTtcclxuICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7XHJcbiAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIGlmIChpc0RldiAmJiByZW5kZXJlckRldlVybCkge1xyXG4gICAgICB2b2lkIHdpbi5sb2FkVVJMKHJlbmRlcmVyRGV2VXJsKTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgIHZvaWQgd2luLmxvYWRGaWxlKGpvaW4oaGVyZSwgJy4uJywgJy4uJywgJ2Rpc3QtcmVuZGVyZXInLCAnaW5kZXguaHRtbCcpKTtcclxuICAgIH1cclxuICAgIC8vIFx1OTg3NVx1OTc2Mlx1NTJBMFx1OEY3RFx1NUI4Q1x1OTFDRFx1NjRBRFx1NUY1M1x1NTI0RCBob3N0IFx1NzJCNlx1NjAwMTpyZWFkeSBcdTVFN0ZcdTY0QURcdTgyRTVcdTY1RTlcdTRFOEUgcmVuZGVyZXIgXHU4QkEyXHU5NjA1XHU1MzczXHU0RTIyXHU1OTMxLFxyXG4gICAgLy8gcmVuZGVyZXIgXHU3Njg0IGdldC1zdGF0ZSBcdTVGRUJcdTcxNjcgKyBcdThGRDlcdTkxQ0NcdTc2ODRcdTkxQ0RcdTY0QURcdTUzQ0NcdTRGRERcdTk2NjkoXHU1OTFBXHU3QTk3XHU1M0UzL1x1OTFDRFx1OEY3RFx1NTczQVx1NjY2Rlx1NEU1Rlx1ODk4Nlx1NzZENilcdTMwMDJcclxuICAgIHdpbi53ZWJDb250ZW50cy5vbmNlKCdkaWQtZmluaXNoLWxvYWQnLCAoKSA9PiB7XHJcbiAgICAgIGlmICghd2luLmlzRGVzdHJveWVkKCkpIHtcclxuICAgICAgICB3aW4ud2ViQ29udGVudHMuc2VuZCgnYnJpZGdlOmhvc3Qtc3RhdGUnLCBicmlkZ2UuaG9zdFN0YXRlLCB7IHJlc3RhcnRDb3VudDogMCB9KTtcclxuICAgICAgfVxyXG4gICAgfSk7XHJcbiAgICByZXR1cm4gd2luO1xyXG4gIH1cclxuXHJcbiAgYXBwLndoZW5SZWFkeSgpLnRoZW4oKCkgPT4ge1xyXG4gICAgLy8gVUlWRVJJRlk6ZmFrZSBcdTZBMjFcdTVGMEZcdTlBOENcdTY1MzZcdTk4N0JcdTU3Mjggc3RhcnRIb3N0IFx1OEJGQiBlbnYgXHU0RTRCXHU1MjREXHU1RjNBXHU1MjM2IGZha2VcclxuICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWSA9PT0gJzEnICYmIHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX01PREUgIT09ICdyZWFsJykge1xyXG4gICAgICBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9GQUtFID0gJzEnO1xyXG4gICAgfVxyXG4gICAgLy8gV2luZG93cyBcdTkwMUFcdTc3RTVcdTVGNTJcdTVDNUUoXHU1NDI2XHU1MjE5XHU2NjNFXHU3OTNBXHU0RTNBIGVsZWN0cm9uLmV4ZSlcclxuICAgIGFwcC5zZXRBcHBVc2VyTW9kZWxJZCgnZGV2LmhtaC5kZXNrdG9wJyk7XHJcbiAgICBzZXR1cFRyYXkoKTtcclxuICAgIGJ1aWxkQXBwTWVudSgpO1xyXG4gICAgLy8gXHU1NDJGXHU1MkE4IDMwcyBcdTU0MEVcdTk3NTlcdTlFRDhcdTY4QzBcdTY3RTVcdTY2RjRcdTY1QjAoXHU2NzA5XHU2NUIwXHU3MjQ4XHU0RUM1XHU1NDBFXHU1M0YwXHU0RTBCXHU4RjdELFx1NEUwRFx1NjI1M1x1NjI3MDtcdTc1MjhcdTYyMzdcdTdFQ0YgXHUyNjMwIFx1ODNEQ1x1NTM1NVx1NTFCM1x1NUI5QVx1ODhDNSlcclxuICAgIGlmIChhcHAuaXNQYWNrYWdlZCkgc2V0VGltZW91dCgoKSA9PiB7IHZvaWQgY2hlY2tGb3JVcGRhdGVzKCk7IH0sIDMwXzAwMCk7XHJcbiAgICAvLyBDU1AoZGV2IFx1NEUwRSBwcm9kIFx1NEUwRFx1NTQwQztwcm9kIFx1NEUwRFx1NTE0MVx1OEJCOFx1NEVGQlx1NEY1NVx1OEZEQ1x1N0EwQlx1NkU5MClcclxuICAgIGNvbnN0IGNzcCA9IGlzRGV2XHJcbiAgICAgID8gW1xyXG4gICAgICAgICAgXCJkZWZhdWx0LXNyYyAnc2VsZidcIixcclxuICAgICAgICAgIGBzY3JpcHQtc3JjICdzZWxmJyAke3JlbmRlcmVyRGV2VXJsfWAsXHJcbiAgICAgICAgICBcInN0eWxlLXNyYyAnc2VsZicgJ3Vuc2FmZS1pbmxpbmUnXCIsXHJcbiAgICAgICAgICBgY29ubmVjdC1zcmMgJ3NlbGYnICR7cmVuZGVyZXJEZXZVcmx9IHdzOi8vMTI3LjAuMC4xOipgLFxyXG4gICAgICAgICAgXCJpbWctc3JjICdzZWxmJyBkYXRhOlwiLFxyXG4gICAgICAgICAgXCJmb250LXNyYyAnc2VsZicgZGF0YTpcIixcclxuICAgICAgICBdLmpvaW4oJzsgJylcclxuICAgICAgOiBcImRlZmF1bHQtc3JjICdzZWxmJzsgc2NyaXB0LXNyYyAnc2VsZic7IHN0eWxlLXNyYyAnc2VsZicgJ3Vuc2FmZS1pbmxpbmUnOyBpbWctc3JjICdzZWxmJyBkYXRhOjsgZm9udC1zcmMgJ3NlbGYnIGRhdGE6XCI7XHJcbiAgICBzZXNzaW9uLmRlZmF1bHRTZXNzaW9uLndlYlJlcXVlc3Qub25IZWFkZXJzUmVjZWl2ZWQoKGRldGFpbHMsIGNhbGxiYWNrKSA9PiB7XHJcbiAgICAgIGNhbGxiYWNrKHtcclxuICAgICAgICByZXNwb25zZUhlYWRlcnM6IHtcclxuICAgICAgICAgIC4uLmRldGFpbHMucmVzcG9uc2VIZWFkZXJzLFxyXG4gICAgICAgICAgJ0NvbnRlbnQtU2VjdXJpdHktUG9saWN5JzogW2NzcF0sXHJcbiAgICAgICAgfSxcclxuICAgICAgfSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICByZWdpc3RlcklwYygpO1xyXG4gICAgLy8gY3JlYXRlV2luZG93IFx1NjYyRiBhc3luYyhib3VuZHMgXHU2MDYyXHU1OTBEKTtcdTVCODlcdTUxNjhcdTgxRUFcdTZENEIvXHU2RTMyXHU2N0QzXHU4MUVBXHU2OEMwXHU1NzI4XHU3QTk3XHU1M0UzXHU1QzMxXHU3RUVBXHU1NDBFXHU2MzAyXHU4RjdEXHJcbiAgICB2b2lkIGNyZWF0ZVdpbmRvdygpLnRoZW4oKHdpbikgPT4ge1xyXG4gICAgICBpZiAod2luID09PSBudWxsKSByZXR1cm47XHJcbiAgICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWSA9PT0gJzEnKSBhdHRhY2hVaVZlcmlmeSh3aW4pO1xyXG4gICAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfU0VDVVJJVFlfVEVTVCA9PT0gJzEnKSB7XHJcbiAgICAgICAgd2luLndlYkNvbnRlbnRzLm9uY2UoJ2RpZC1maW5pc2gtbG9hZCcsICgpID0+IHtcclxuICAgICAgICAgIHZvaWQgc2VjdXJpdHlTZWxmVGVzdCh3aW4pO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICB9XHJcbiAgICAgIC8vIFVJIFx1NjIyQVx1NTZGRVx1OTRBOVx1NUI1MDpITUhfREVTS1RPUF9TTkFQU0hPVD08ZmlsZS5wbmc+IFx1NTcyOFx1NzU0Q1x1OTc2Mlx1NUMzMVx1N0VFQVx1NTQwRVx1NjIyQVx1NTZGRVx1OTAwMFx1NTFGQVxyXG4gICAgICAvLyAoXHU4OEM1XHU2NzNBXHU4QkNBXHU2NUFEXHU3NTI4Olx1NEVCMlx1NzczQ1x1NzcwQlx1NkUzMlx1NjdEM1x1N0VEM1x1Njc5QyxcdTgwMENcdTRFMERcdTY2MkZcdTUzRUFcdTY1NzAgcm9vdCBcdTVCNTBcdTgyODJcdTcwQjkpXHUzMDAyXHJcbiAgICAgIGNvbnN0IHNuYXAgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9TTkFQU0hPVDtcclxuICAgICAgaWYgKHNuYXAgIT09IHVuZGVmaW5lZCAmJiBzbmFwICE9PSAnJykge1xyXG4gICAgICAgIHdpbi53ZWJDb250ZW50cy5vbmNlKCdkaWQtZmluaXNoLWxvYWQnLCAoKSA9PiB7XHJcbiAgICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHtcclxuICAgICAgICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBpbWcgPSBhd2FpdCB3aW4ud2ViQ29udGVudHMuY2FwdHVyZVBhZ2UoKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHsgd3JpdGVGaWxlOiB3ZiB9ID0gYXdhaXQgaW1wb3J0KCdub2RlOmZzL3Byb21pc2VzJyk7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCB3ZihzbmFwLCBpbWcudG9QTkcoKSk7XHJcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgU05BUFNIT1Qgb2sgJHtzbmFwfSAke2ltZy5nZXRTaXplKCkud2lkdGh9eCR7aW1nLmdldFNpemUoKS5oZWlnaHR9YCk7XHJcbiAgICAgICAgICAgICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgU05BUFNIT1QgZXJyb3IgJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApfWApO1xyXG4gICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICBjb25zdCBhcHAyID0gYXBwO1xyXG4gICAgICAgICAgICAgIHNldFRpbWVvdXQoKCkgPT4gYXBwMi5leGl0KDApLCA1MDApO1xyXG4gICAgICAgICAgICB9KSgpO1xyXG4gICAgICAgICAgfSwgTnVtYmVyKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NOQVBTSE9UX0RFTEFZX01TID8/IDEyXzAwMCkpO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICB9XHJcbiAgICAgIC8vIERPTSBcdTdFRDNcdTY3ODRcdTYzQTJcdTk0ODg6SE1IX0RFU0tUT1BfRE9NUFJPQkU9MSBcdThGOTNcdTUxRkFcdTUxNzNcdTk1MkVcdTUxNDNcdTdEMjBcdTc2ODQgYm94L2Rpc3BsYXkvY2hpbGRyZW4sXHJcbiAgICAgIC8vIFx1NTE4RFx1OTAwMFx1NTFGQShcdThCQ0FcdTY1QURcIlJlYWN0IFx1NjMwMlx1OEY3RFx1NEU4Nlx1NEY0Nlx1NjdEMFx1NTc1NyBVSSBcdTRFMERcdTUzRUZcdTg5QzFcIlx1OEZEOVx1N0M3Qlx1OTVFRVx1OTg5ODtcdTYyMkFcdTU2RkVcdTRFNEJcdTU5MTZcdTc2ODRcdTc4NkNcdThCQzFcdTYzNkUpXHUzMDAyXHJcbiAgICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9ET01QUk9CRSA9PT0gJzEnKSB7XHJcbiAgICAgICAgd2luLndlYkNvbnRlbnRzLm9uY2UoJ2RpZC1maW5pc2gtbG9hZCcsICgpID0+IHtcclxuICAgICAgICAgIHNldFRpbWVvdXQoKCkgPT4ge1xyXG4gICAgICAgICAgICB2b2lkIChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHIgPSAoYXdhaXQgd2luLndlYkNvbnRlbnRzLmV4ZWN1dGVKYXZhU2NyaXB0KGAoZnVuY3Rpb24oKXtcclxuICAgICAgICAgICAgICAgICAgdmFyIHBpY2sgPSBmdW5jdGlvbihzZWwpe1xyXG4gICAgICAgICAgICAgICAgICAgIHZhciBlbHMgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKHNlbCk7XHJcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGVscywgMCwgNCkubWFwKGZ1bmN0aW9uKGVsKXtcclxuICAgICAgICAgICAgICAgICAgICAgIHZhciBjcyA9IGdldENvbXB1dGVkU3R5bGUoZWwpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgdmFyIGIgPSBlbC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcclxuICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB7IGNsczogKGVsLmNsYXNzTmFtZXx8JycpLnRvU3RyaW5nKCkuc2xpY2UoMCw4MCksIHRhZzogZWwudGFnTmFtZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgZGlzcGxheTogY3MuZGlzcGxheSwgdmlzOiBjcy52aXNpYmlsaXR5LCBvcGFjaXR5OiBjcy5vcGFjaXR5LFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBwb3M6IGNzLnBvc2l0aW9uLCB6OiBjcy56SW5kZXgsIG92ZXJmbG93OiBjcy5vdmVyZmxvdyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgeDogTWF0aC5yb3VuZChiLngpLCB5OiBNYXRoLnJvdW5kKGIueSksIHc6IE1hdGgucm91bmQoYi53aWR0aCksIGg6IE1hdGgucm91bmQoYi5oZWlnaHQpLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB0ZXh0OiAoZWwuaW5uZXJUZXh0fHwnJykucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDYwKSB9O1xyXG4gICAgICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgICB9O1xyXG4gICAgICAgICAgICAgICAgICB2YXIgc2VscyA9IFsnaHRtbCcsJ2JvZHknLCcjcm9vdCcsJy5hcHAtc2hlbGwnLCcuc2lkZWJhcicsJy53b3Jrc3BhY2UnLCcudG9wYmFyJywnLnN0cmVhbScsJy5lbXB0eS1oaW50JywnLmNvbXBvc2VyJywnLmNvbXBvc2VyLXJvdycsJy5jb21wb3NlciB0ZXh0YXJlYScsJy5jb21wb3Nlci1zaWRlJywnLmF0dC1waWNrZXInLCcuYXR0LWNoaXBzJywnLnNpZGVwYW5lbCcsJy5ydW50aW1lLWd1aWRlJywnLm92ZXJsYXknLCcudHVybicsJy5jYXJkJ107XHJcbiAgICAgICAgICAgICAgICAgIHZhciBvdXQgPSB7fTtcclxuICAgICAgICAgICAgICAgICAgc2Vscy5mb3JFYWNoKGZ1bmN0aW9uKHMpeyB0cnkgeyBvdXRbc10gPSBwaWNrKHMpOyB9IGNhdGNoKGUpeyBvdXRbc10gPSBbe2VycjogU3RyaW5nKGUpLnNsaWNlKDAsODApfV07IH0gfSk7XHJcbiAgICAgICAgICAgICAgICAgIG91dC5fX21ldGEgPSB7XHJcbiAgICAgICAgICAgICAgICAgICAgc3R5bGVTaGVldHM6IGRvY3VtZW50LnN0eWxlU2hlZXRzLmxlbmd0aCxcclxuICAgICAgICAgICAgICAgICAgICBzaGVldDBydWxlczogKGRvY3VtZW50LnN0eWxlU2hlZXRzWzBdICYmIGRvY3VtZW50LnN0eWxlU2hlZXRzWzBdLmNzc1J1bGVzKSA/IGRvY3VtZW50LnN0eWxlU2hlZXRzWzBdLmNzc1J1bGVzLmxlbmd0aCA6IC0xLFxyXG4gICAgICAgICAgICAgICAgICAgIHJvb3RDaGlsZHJlbjogZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Jvb3QnKSA/IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyb290JykuY2hpbGRyZW4ubGVuZ3RoIDogLTEsXHJcbiAgICAgICAgICAgICAgICAgICAgYm9keUNoaWxkcmVuOiBkb2N1bWVudC5ib2R5LmNoaWxkcmVuLmxlbmd0aCxcclxuICAgICAgICAgICAgICAgICAgICBpbm5lckhUTUxMZW46IGRvY3VtZW50LmJvZHkuaW5uZXJIVE1MLmxlbmd0aCxcclxuICAgICAgICAgICAgICAgICAgICB2aWV3cG9ydDogd2luZG93LmlubmVyV2lkdGggKyAneCcgKyB3aW5kb3cuaW5uZXJIZWlnaHRcclxuICAgICAgICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KG91dCk7XHJcbiAgICAgICAgICAgICAgICB9KSgpYCwgdHJ1ZSkpIGFzIHN0cmluZztcclxuICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBET01QUk9CRSAke3J9YCk7XHJcbiAgICAgICAgICAgICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgRE9NUFJPQkUgZXJyb3IgJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAyMDApfWApO1xyXG4gICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICBhcHAuZXhpdCgwKTtcclxuICAgICAgICAgICAgfSkoKTtcclxuICAgICAgICAgIH0sIE51bWJlcihwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9ET01QUk9CRV9ERUxBWV9NUyA/PyA5XzAwMCkpO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICB9XHJcbiAgICAgIC8vIFx1NkUzMlx1NjdEM1x1ODFFQVx1NjhDMCgyMDI2LTEwLTEwIFx1ODhDNVx1NjczQVx1OUVEMVx1NUM0Rlx1NjU1OVx1OEJBRDpicmlkZ2UgcmVhZHkgXHUyMjYwIFx1NzU0Q1x1OTc2Mlx1NkUzMlx1NjdEM1x1NEU4NilcdTMwMDJcclxuICAgICAgLy8gI3Jvb3QgXHU1NzI4IFJlYWN0IFx1NjMwMlx1OEY3RFx1NTQwRVx1NUZDNVx1NjcwOVx1NUI1MFx1ODI4Mlx1NzBCOTtcdTdBN0EgPSBcdThENDRcdTZFOTBcdThERUZcdTVGODQvQ1NQL1x1ODExQVx1NjcyQ1x1NTJBMFx1OEY3RFx1NTc0Rlx1NEU4Nlx1MzAwMlxyXG4gICAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfUkVOREVSX1RFU1QgPT09ICcxJykge1xyXG4gICAgICAgIHdpbi53ZWJDb250ZW50cy5vbmNlKCdkaWQtZmluaXNoLWxvYWQnLCAoKSA9PiB7XHJcbiAgICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHtcclxuICAgICAgICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBuID0gKGF3YWl0IHdpbi53ZWJDb250ZW50cy5leGVjdXRlSmF2YVNjcmlwdChcclxuICAgICAgICAgICAgICAgICAgJ2RvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwicm9vdFwiKSA/IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwicm9vdFwiKS5jaGlsZHJlbi5sZW5ndGggOiAtMScsIHRydWUsXHJcbiAgICAgICAgICAgICAgICApKSBhcyBudW1iZXI7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBvayA9IG4gPiAwO1xyXG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYFJFTkRFUi1URVNUICR7b2sgPyAnb2snIDogJ0VNUFRZJ30gcm9vdENoaWxkcmVuPSR7bn1gKTtcclxuICAgICAgICAgICAgICAgIGFwcC5leGl0KG9rID8gMCA6IDEpO1xyXG4gICAgICAgICAgICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYFJFTkRFUi1URVNUIEVSUk9SICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTIwKX1gKTtcclxuICAgICAgICAgICAgICAgIGFwcC5leGl0KDEpO1xyXG4gICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfSkoKTtcclxuICAgICAgICAgIH0sIDJfNTAwKTtcclxuICAgICAgICB9KTtcclxuICAgICAgfVxyXG4gICAgfSk7XHJcbiAgICB2b2lkIHN0YXJ0SG9zdCgpO1xyXG5cclxuICAgIGFwcC5vbignYWN0aXZhdGUnLCAoKSA9PiB7XHJcbiAgICAgIGlmIChCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5sZW5ndGggPT09IDApIHZvaWQgY3JlYXRlV2luZG93KCk7XHJcbiAgICB9KTtcclxuICB9KTtcclxuXHJcbiAgYXN5bmMgZnVuY3Rpb24gc2VjdXJpdHlTZWxmVGVzdCh3aW46IEJyb3dzZXJXaW5kb3cpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IHJlc3VsdHM6IEFycmF5PFtzdHJpbmcsIGJvb2xlYW4sIHN0cmluZ10+ID0gW107XHJcbiAgICBjb25zdCBjaGVjayA9IGFzeW5jIChuYW1lOiBzdHJpbmcsIHByb2JlOiAoKSA9PiBQcm9taXNlPFtib29sZWFuLCBzdHJpbmddPik6IFByb21pc2U8dm9pZD4gPT4ge1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IFtvaywgZGV0YWlsXSA9IGF3YWl0IHByb2JlKCk7XHJcbiAgICAgICAgcmVzdWx0cy5wdXNoKFtuYW1lLCBvaywgZGV0YWlsXSk7XHJcbiAgICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICAgIHJlc3VsdHMucHVzaChbbmFtZSwgZmFsc2UsIFN0cmluZyhlcnIpLnNsaWNlKDAsIDEyMCldKTtcclxuICAgICAgfVxyXG4gICAgfTtcclxuICAgIGNvbnN0IGpzID0gKGNvZGU6IHN0cmluZyk6IFByb21pc2U8dW5rbm93bj4gPT4gd2luLndlYkNvbnRlbnRzLmV4ZWN1dGVKYXZhU2NyaXB0KGNvZGUsIHRydWUpO1xyXG5cclxuICAgIGF3YWl0IGNoZWNrKCdyZW5kZXJlciBcdTY1RTBcdTUzRUZcdTc1MjhcdTc2ODQgcHJvY2Vzcy9yZXF1aXJlKHNhbmRib3ggXHU3NTFGXHU2NTQ4KScsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgciA9IChhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XHJcbiAgICAgICAgdmFyIHQgPSBmdW5jdGlvbihmKXsgdHJ5IHsgdmFyIHYgPSBmKCk7IHJldHVybiAodiA9PT0gdW5kZWZpbmVkIHx8IHYgPT09IG51bGwpID8gJ3VuYXZhaWxhYmxlJyA6IHR5cGVvZiB2OyB9IGNhdGNoKGUpeyByZXR1cm4gJ2Jsb2NrZWQnOyB9IH07XHJcbiAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KFt0KGZ1bmN0aW9uKCl7cmV0dXJuIHByb2Nlc3N9KSwgdChmdW5jdGlvbigpe3JldHVybiByZXF1aXJlfSksIHQoZnVuY3Rpb24oKXtyZXR1cm4gZ2xvYmFsVGhpcy5wcm9jZXNzfSldKTtcclxuICAgICAgfSkoKWApKSBhcyBzdHJpbmc7XHJcbiAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocikgYXMgc3RyaW5nW107XHJcbiAgICAgIGNvbnN0IHAgPSBwYXJzZWRbMF0gPz8gJ3Vua25vd24nO1xyXG4gICAgICBjb25zdCByZXEgPSBwYXJzZWRbMV0gPz8gJ3Vua25vd24nO1xyXG4gICAgICBjb25zdCBzYWZlID0gKHY6IHN0cmluZyk6IGJvb2xlYW4gPT4gdiA9PT0gJ3VuYXZhaWxhYmxlJyB8fCB2ID09PSAnYmxvY2tlZCc7XHJcbiAgICAgIHJldHVybiBbc2FmZShwKSAmJiBzYWZlKHJlcSksIGBwcm9jZXNzPSR7cH0gcmVxdWlyZT0ke3JlcX1gXTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgY2hlY2soJ3dpbmRvdy5obWggXHU1M0VBXHU2NzA5XHU3NjdEXHU1NDBEXHU1MzU1XHU2NUI5XHU2Q0Q1KFx1NjVFMCBpcGNSZW5kZXJlci9cdTk4OURcdTU5MTZcdTk3NjIpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKCdPYmplY3Qua2V5cyh3aW5kb3cuaG1oIHx8IHt9KS5zb3J0KCkuam9pbihcIixcIiknKSkgYXMgc3RyaW5nO1xyXG4gICAgICBjb25zdCBhbGxvdyA9IFsnYXBwbHlVcGRhdGUnLCAnYXBwcm92ZScsICdhcHByb3ZhbEdldCcsICdhcHByb3ZhbFNldCcsICdicm93c2VSdW50aW1lJywgJ2NoZWNrVXBkYXRlJywgJ2Nocm9tZVRoZW1lJywgJ2NvZ25pdGl2ZScsICdkZXRlY3RSdW50aW1lJywgJ2RpZmYnLCAnZXhwb3J0U2Vzc2lvbicsICdmc0xpc3QnLCAnZnNSZWFkJywgJ2ZzU2VhcmNoJywgJ2dldFN0YXRlJywgJ2dldFdpemFyZCcsICdpbmplY3QnLCAnaW5zdGFsbENsaScsICdpbnRlcnJ1cHQnLCAnbW9kZWxTZXQnLCAnb25FdmVudEJhdGNoZXMnLCAnb25Ib3N0U3RhdGUnLCAnb25JbnN0YWxsUHJvZ3Jlc3MnLCAnb25NZW51QWN0aW9uJywgJ29uU3RyZWFtQ2h1bmtzJywgJ29uVXBkYXRlU3RhdGUnLCAncGlja0RpcmVjdG9yeScsICdwaWNrRmlsZXMnLCAncG9wdXBNYWluTWVudScsICdwcm92aWRlclNhdmUnLCAncHJvdmlkZXJzJywgJ3JlbW90ZVdlYkF1dG9zdGFydCcsICdyZW1vdGVXZWJTdGFydCcsICdyZW1vdGVXZWJTdGF0dXMnLCAncmVtb3RlV2ViU3RvcCcsICdydW50aW1lSW5mbycsICdzZW5kVGFzaycsICdzZXNzaW9uT3AnLCAnc2Vzc2lvblByZXZpZXcnLCAnc2Vzc2lvbnMnLCAnc2V0UnVudGltZScsICdzdG9wSG9zdCcsICd3aXphcmRDb21wbGV0ZScsICd3b3Jrc3BhY2VzJywgJ3dvcmtzcGFjZUFkZCcsICd3b3Jrc3BhY2VVc2UnXTtcclxuICAgICAgY29uc3QgZ290ID0gciA9PT0gJycgPyBbXSA6IHIuc3BsaXQoJywnKTtcclxuICAgICAgY29uc3QgdW5leHBlY3RlZCA9IGdvdC5maWx0ZXIoKGspID0+ICFhbGxvdy5pbmNsdWRlcyhrKSk7XHJcbiAgICAgIHJldHVybiBbdW5leHBlY3RlZC5sZW5ndGggPT09IDAsIGBrZXlzPSR7cn1gXTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgY2hlY2soJ1x1NTkxNlx1OTBFOFx1NUJGQ1x1ODIyQVx1ODhBQlx1NjJFNlx1NjIyQShVUkwgXHU0RTBEXHU1M0Q4KScsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgYmVmb3JlID0gd2luLndlYkNvbnRlbnRzLmdldFVSTCgpO1xyXG4gICAgICBhd2FpdCBqcygnbG9jYXRpb24uaHJlZiA9IFwiaHR0cHM6Ly9leGFtcGxlLmludmFsaWQveFwiOyBcIm5vb3BcIicpLmNhdGNoKCgpID0+ICdub29wJyk7XHJcbiAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyMikgPT4gc2V0VGltZW91dChyMiwgMV8yMDApKTtcclxuICAgICAgY29uc3QgYWZ0ZXIgPSB3aW4ud2ViQ29udGVudHMuZ2V0VVJMKCk7XHJcbiAgICAgIHJldHVybiBbYWZ0ZXIgPT09IGJlZm9yZSwgYCR7YmVmb3JlfSBcdTIxOTIgJHthZnRlcn1gXTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgY2hlY2soJ3dpbmRvdy5vcGVuIFx1ODhBQlx1NjJEMlx1N0VERChcdThGRDRcdTU2REUgbnVsbCBcdTRFMTRcdTY1RTBcdTY1QjBcdTdBOTdcdTUzRTMpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCBiZWZvcmUgPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5sZW5ndGg7XHJcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoJ1N0cmluZyh3aW5kb3cub3BlbihcImh0dHBzOi8vZXhhbXBsZS5pbnZhbGlkXCIpKScpKSBhcyBzdHJpbmc7XHJcbiAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyMikgPT4gc2V0VGltZW91dChyMiwgNDAwKSk7XHJcbiAgICAgIGNvbnN0IGFmdGVyID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkubGVuZ3RoO1xyXG4gICAgICByZXR1cm4gW3IgPT09ICdudWxsJyAmJiBhZnRlciA9PT0gYmVmb3JlLCBgb3BlbigpPSR7cn0gd2luZG93cz0ke2JlZm9yZX1cdTIxOTIke2FmdGVyfWBdO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBjaGVjaygnQ1NQIFx1NUI1OFx1NTcyOChtZXRhIFx1NkNFOFx1NTE2NVx1NjIxNlx1NTRDRFx1NUU5NFx1NTkzNCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IG1ldGEgPSAoYXdhaXQganMoJ0Jvb2xlYW4oZG9jdW1lbnQucXVlcnlTZWxlY3RvcihcIm1ldGFbaHR0cC1lcXVpdj1cXCdDb250ZW50LVNlY3VyaXR5LVBvbGljeVxcJ11cIikpJykpIGFzIGJvb2xlYW47XHJcbiAgICAgIGNvbnN0IGhlYWRlckNzcCA9IGlzRGV2ID8gJ2RldjogaGVhZGVyIENTUCBcdTc1MzEgb25IZWFkZXJzUmVjZWl2ZWQgXHU2Q0U4XHU1MTY1KFx1NEUwRFx1OTAwMlx1NzUyOCBtZXRhIFx1NjVBRFx1OEEwMCknIDogJ3Byb2QnO1xyXG4gICAgICByZXR1cm4gW21ldGEgfHwgaXNEZXYsIGBtZXRhPSR7bWV0YX0gJHtoZWFkZXJDc3B9YF07XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IGNoZWNrKCdicmlkZ2U6Z2V0LXN0YXRlIFx1NkI2M1x1NUUzOFx1OEZENFx1NTZERShob3N0IFx1Njg2NVx1NTNFRlx1NzUyOCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoJ3dpbmRvdy5obWguZ2V0U3RhdGUoKS50aGVuKHMgPT4gSlNPTi5zdHJpbmdpZnkocykpLmNhdGNoKGUgPT4gXCJFUlI6XCIrZSknKSkgYXMgc3RyaW5nO1xyXG4gICAgICByZXR1cm4gW3Iuc3RhcnRzV2l0aCgneycpICYmIHIuaW5jbHVkZXMoJ2hvc3RTdGF0ZScpLCByLnNsaWNlKDAsIDgwKV07XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IGNoZWNrKCdYU1M6XHU2MDc2XHU2MTBGXHU0RUZCXHU1MkExXHU2NTg3XHU2NzJDXHU1M0VBXHU0RUU1XHU2NTg3XHU2NzJDXHU2RTMyXHU2N0QzKFx1NEUwRFx1NjI2N1x1ODg0QyknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHBheWxvYWQgPSAnPGltZyBzcmM9eCBvbmVycm9yPVwid2luZG93Ll9feHNzPTFcIj48c2NyaXB0PndpbmRvdy5fX3hzcz0yPFxcL3NjcmlwdD5cIiZcXCcnO1xyXG4gICAgICBjb25zdCBzZW5kUiA9IChhd2FpdCBqcyhgd2luZG93LmhtaC5zZW5kVGFzaygke0pTT04uc3RyaW5naWZ5KHBheWxvYWQpfSwgJ3NlYy14c3MtMScsICdhdXRvJykudGhlbihyPT5KU09OLnN0cmluZ2lmeShyKSkuY2F0Y2goZT0+J0VSUjonK2UpYCkpIGFzIHN0cmluZztcclxuICAgICAgaWYgKCFzZW5kUi5pbmNsdWRlcygnXCJva1wiOnRydWUnKSkgcmV0dXJuIFtmYWxzZSwgYHNlbmRUYXNrIFx1NjcyQVx1NTNEN1x1NzQwNjogJHtzZW5kUi5zbGljZSgwLCA4MCl9YF07XHJcbiAgICAgIC8vIGZha2UgaG9zdCBlY2hvIFx1NTZERVx1Njc2NVx1NTQwRVx1N0VDRiBSZWFjdCBcdTZFMzJcdTY3RDMoXHU3NTI4XHU2MjM3XHU2RDg4XHU2MDZGICsgXHU1MkE5XHU2MjRCIGVjaG8gXHU1M0NDXHU4REVGXHU1Rjg0KVxyXG4gICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocjIpID0+IHNldFRpbWVvdXQocjIsIDNfMDAwKSk7XHJcbiAgICAgIGNvbnN0IHByb2JlID0gKGF3YWl0IGpzKGBKU09OLnN0cmluZ2lmeSh7XHJcbiAgICAgICAgeHNzRmxhZzogdHlwZW9mIHdpbmRvdy5fX3hzcyxcclxuICAgICAgICBpbWdDb3VudDogZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnaW1nW3NyYz1cInhcIl0nKS5sZW5ndGgsXHJcbiAgICAgICAgc2NyaXB0UmFuOiBkb2N1bWVudC5ib2R5LmlubmVyVGV4dC5pbmRleE9mKCd3aW5kb3cuX194c3M9MicpID49IDBcclxuICAgICAgfSlgKSkgYXMgc3RyaW5nO1xyXG4gICAgICBjb25zdCBwID0gSlNPTi5wYXJzZShwcm9iZSkgYXMgeyB4c3NGbGFnOiBzdHJpbmc7IGltZ0NvdW50OiBudW1iZXI7IHNjcmlwdFJhbjogYm9vbGVhbiB9O1xyXG4gICAgICByZXR1cm4gW3AueHNzRmxhZyA9PT0gJ3VuZGVmaW5lZCcgJiYgcC5pbWdDb3VudCA9PT0gMCwgYHhzc0ZsYWc9JHtwLnhzc0ZsYWd9IGltZz0ke3AuaW1nQ291bnR9YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICBsZXQgZmFpbGVkID0gMDtcclxuICAgIGZvciAoY29uc3QgW25hbWUsIG9rLCBkZXRhaWxdIG9mIHJlc3VsdHMpIHtcclxuICAgICAgY29uc29sZS5sb2coYFNFQ1VSSVRZLVRFU1QgJHtvayA/ICdQQVNTJyA6ICdGQUlMJ30gfCAke25hbWV9IHwgJHtyZWRhY3QoZGV0YWlsKX1gKTtcclxuICAgICAgaWYgKCFvaykgZmFpbGVkICs9IDE7XHJcbiAgICB9XHJcbiAgICBjb25zb2xlLmxvZyhgU0VDVVJJVFktVEVTVCBTVU1NQVJZIHBhc3M9JHtyZXN1bHRzLmxlbmd0aCAtIGZhaWxlZH0vJHtyZXN1bHRzLmxlbmd0aH1gKTtcclxuICAgIGFwcC5leGl0KGZhaWxlZCA9PT0gMCA/IDAgOiAxKTtcclxuICB9XHJcblxyXG4gIC8vIFx1OTAwMFx1NTFGQTpcdTRGMThcdTk2QzVcdTUwNUNcdTZCNjJcdTgxRUFcdTVERjEgc3Bhd24gXHU3Njg0IGhvc3Qoc2h1dGRvd24gXHU3QUVGXHU3MEI5IFx1MjE5MiBcdTUxNUNcdTVFOTVcdTUzRUEga2lsbCBcdTgxRUFcdTVERjFcdTc2ODRcdTUzRTVcdTY3QzQpXHJcbiAgYXBwLm9uKCdiZWZvcmUtcXVpdCcsIChlKSA9PiB7XHJcbiAgICBpZiAoc3VwZXJ2aXNvciAhPT0gbnVsbCAmJiBzdXBlcnZpc29yLnN0YXRlICE9PSAnc3RvcHBlZCcpIHtcclxuICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xyXG4gICAgICBzc2VBYm9ydD8uYWJvcnQoKTtcclxuICAgICAgdm9pZCBzdXBlcnZpc29yLnN0b3AoKS5maW5hbGx5KCgpID0+IGFwcC5xdWl0KCkpO1xyXG4gICAgfVxyXG4gIH0pO1xyXG4gIGFwcC5vbignd2luZG93LWFsbC1jbG9zZWQnLCAoKSA9PiB7XHJcbiAgICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSAhPT0gJ2RhcndpbicpIGFwcC5xdWl0KCk7XHJcbiAgfSk7XHJcbn1cclxuIiwgIi8qKlxyXG4gKiBEZXNrdG9wUnVudGltZVN1cGVydmlzb3IgXHUyMDE0IGhtaGFybmVzcyBob3N0IFx1OEZEQlx1N0EwQlx1NzY4NFx1NzUxRlx1NTQ3RFx1NTQ2OFx1NjcxRlx1NzJCNlx1NjAwMVx1NjczQShBRFItMDAzKVx1MzAwMlxyXG4gKlxyXG4gKiBcdTVCODlcdTUxNjhcdTRFMERcdTUzRDhcdTkxQ0Y6XHJcbiAqICAtIFx1NTNFQVx1N0VEMVx1NUI5QS9cdTYzQTJcdTZENEIgMTI3LjAuMC4xO2hvc3QgXHU0RjdGXHU3NTI4XHU2NENEXHU0RjVDXHU3Q0ZCXHU3RURGXHU1MjA2XHU5MTREXHU3QUVGXHU1M0UzKHBvcnQgMCksXHU1QjlFXHU5NjQ1XHU3QUVGXHU1M0UzXHJcbiAqICAgIFx1NzUzMSBob3N0IFx1NzY4NCBzdGRvdXQgXHU1RjE1XHU1QkZDXHU4ODRDXHU1NkRFXHU0RjIwKEhvc3RSZWFkeUxpbmUpXHUzMDAyXHJcbiAqICAtIFx1OUFEOFx1NzFCNSB0b2tlbiBcdTUzRUFcdTkwMUFcdThGQzdcdTVCNTBcdThGREJcdTdBMEJcdTczQUZcdTU4ODNcdTUzRDhcdTkxQ0ZcdTRGMjBcdTkwMTIsXHU3RUREXHU0RTBEXHU4RkRCIFVSTC9cdTY1RTVcdTVGRDcvSVBDIFx1NjYwRVx1NjU4N1x1OEQxRlx1OEY3RFx1MzAwMlxyXG4gKiAgLSBcdTUzRUFcdTUwNUNcdTZCNjJcdTY3MkMgc3VwZXJ2aXNvciBzcGF3biBcdTc2ODRcdThGREJcdTdBMEJcdTUzRTVcdTY3QzQ7XHU3RUREXHU0RTBEXHU2MzA5XHU4RkRCXHU3QTBCXHU1NDBEIGtpbGxcdTMwMDJcclxuICogIC0gaG9zdCBjcmFzaCBcdTU0MEVcdTY3MDlcdTk2NTBcdTkxQ0RcdTU0MkY7XHU5MUNEXHU1NDJGXHU0RTBEXHU5MUNEXHU2NTNFXHU0RUZCXHU0RjU1XHU3NTI4XHU2MjM3XHU1MkE4XHU0RjVDKFx1OTc1RVx1NUU0Mlx1N0I0OVx1NTJBOFx1NEY1Q1x1NzUzMVx1NzUyOFx1NjIzN1x1Nzg2RVx1OEJBNClcdTMwMDJcclxuICovXHJcbmltcG9ydCB7IHNwYXduLCB0eXBlIENoaWxkUHJvY2VzcyB9IGZyb20gJ25vZGU6Y2hpbGRfcHJvY2Vzcyc7XHJcbmltcG9ydCB7IGNyZWF0ZUludGVyZmFjZSB9IGZyb20gJ25vZGU6cmVhZGxpbmUnO1xyXG5pbXBvcnQgeyByYW5kb21CeXRlcyB9IGZyb20gJ25vZGU6Y3J5cHRvJztcclxuaW1wb3J0IHsgZGVza3RvcEVycm9yLCBpc0Rlc2t0b3BFcnJvciwgdHlwZSBEZXNrdG9wRXJyb3IgfSBmcm9tICdAaG1oLWRlc2t0b3AvY29udHJhY3RzJztcclxuXHJcbmV4cG9ydCB0eXBlIEhvc3RTdGF0ZSA9XHJcbiAgfCAnc3RvcHBlZCdcclxuICB8ICdzdGFydGluZydcclxuICB8ICdyZWFkeSdcclxuICB8ICdkaXNjb25uZWN0ZWQnXHJcbiAgfCAncmVzdGFydGluZydcclxuICB8ICdzdG9wcGluZydcclxuICB8ICdmYWlsZWQnO1xyXG5cclxuZXhwb3J0IGludGVyZmFjZSBIb3N0U3BlYyB7XHJcbiAgLyoqIFx1NTNFRlx1NjI2N1x1ODg0Q1x1NjU4N1x1NEVGNihcdTkwMUFcdTVFMzggcHJvY2Vzcy5leGVjUGF0aClcdTMwMDIgKi9cclxuICBjb21tYW5kOiBzdHJpbmc7XHJcbiAgYXJnczogc3RyaW5nW107XHJcbiAgY3dkPzogc3RyaW5nO1xyXG4gIC8qKiBcdTk4OURcdTU5MTZcdTczQUZcdTU4ODNcdTUzRDhcdTkxQ0YoXHU0RjFBXHU0RTBFIHByb2Nlc3MuZW52IFx1NTQwOFx1NUU3NilcdTMwMDIgKi9cclxuICBlbnY/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xyXG59XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIFN1cGVydmlzb3JPcHRpb25zIHtcclxuICAvKiogXHU2NzFGXHU2NzFCIGhvc3QgXHU2ODIxXHU5QThDXHU3Njg0IGJlYXJlciB0b2tlbjtcdTRFMERcdTRGMjBcdTUyMTlcdTZCQ0ZcdTZCMjEgc3RhcnQgXHU3NTFGXHU2MjEwXHU5QUQ4XHU3MUI1XHU5NjhGXHU2NzNBXHU1MDNDXHUzMDAyICovXHJcbiAgdG9rZW4/OiBzdHJpbmc7XHJcbiAgbWF4UmVzdGFydHM/OiBudW1iZXI7XHJcbiAgc3RhcnRUaW1lb3V0TXM/OiBudW1iZXI7XHJcbiAgZ3JhY2VmdWxTaHV0ZG93bk1zPzogbnVtYmVyO1xyXG4gIG9uU3RhdGVDaGFuZ2U/KHN0YXRlOiBIb3N0U3RhdGUsIGluZm86IHsgcmVzdGFydENvdW50OiBudW1iZXI7IGxhc3RFcnJvcj86IHN0cmluZyB9KTogdm9pZDtcclxuICAvKiogXHU2QkNGXHU2QjIxIGhvc3QgXHU1QzMxXHU3RUVBKFx1NTQyQiBjcmFzaCBcdTgxRUFcdTYxMDhcdTU0MEVcdTc2ODRcdTkxQ0RcdTU0MkYpXHU5MEZEXHU0RjFBXHU4OUU2XHU1M0QxLFx1NjQzQVx1NUUyNlx1N0FFRlx1NzBCOShcdTU0MkIgdG9rZW4sXHJcbiAgICogIFx1NEVDNVx1NEY5Qlx1NTQwQ1x1NEZFMVx1NEVGQlx1NTdERlx1NzY4NFx1NUJCRlx1NEUzQlx1OEZEQlx1N0EwQlx1OTFDRFx1NUVGQVx1Njg2NVx1NUJBMlx1NjIzN1x1N0FFRjtcdTRFMERcdTg5ODFcdThERThcdThGREIgcmVuZGVyZXIpXHUzMDAyICovXHJcbiAgb25SZWFkeT8oZW5kcG9pbnQ6IEhvc3RFbmRwb2ludCk6IHZvaWQ7XHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgSG9zdEVuZHBvaW50IHtcclxuICBwb3J0OiBudW1iZXI7XHJcbiAgdmVyc2lvbjogc3RyaW5nO1xyXG4gIHRva2VuOiBzdHJpbmc7XHJcbn1cclxuXHJcbi8qKiBIb3N0UmVhZHlMaW5lIFx1NzY4NFx1N0M3Qlx1NTc4Qlx1NUI4OFx1NTM2Qlx1NEVDRSBjb250cmFjdHMgXHU1RjE1XHU1MTY1LFx1OTA3Rlx1NTE0RFx1NTNDQ1x1NUI5RVx1NzNCMFx1MzAwMiAqL1xyXG5pbXBvcnQgeyBpc0hvc3RSZWFkeUxpbmUgfSBmcm9tICdAaG1oLWRlc2t0b3AvY29udHJhY3RzJztcclxuXHJcbi8vIDQ1czpobWhhcm5lc3MgXHU3NzFGXHU1QjlFXHU1MTY1XHU1M0UzXHU3RUNGIHRzeCBcdTUxQjdcdTdGMTZcdThCRDFcdTY1NzRcdTU5NTcgQ0xJLFx1NjczQVx1NTY2OFx1OUFEOFx1OEQxRlx1OEY3RFx1NjVGNlx1NTNFRlx1OEQ4NSAyMHNcclxuLy8gKDIwMjYtMTAtMTEgXHU4RkRFXHU3RUVEXHU5QThDXHU2NTM2XHU0RTJEXHU5NUY0XHU2QjQ3XHU2MDI3IEhPU1RfTk9UX1JFQURZIFx1NzY4NFx1NjgzOVx1NTZFMDtcdTdBN0FcdTk1RjJcdTVCOUVcdTZENEIgNnMpXHUzMDAyXHJcbmNvbnN0IERFRkFVTFRfU1RBUlRfVElNRU9VVF9NUyA9IDQ1XzAwMDtcclxuY29uc3QgREVGQVVMVF9NQVhfUkVTVEFSVFMgPSAzO1xyXG5jb25zdCBERUZBVUxUX0dSQUNFRlVMX01TID0gNV8wMDA7XHJcblxyXG5leHBvcnQgY2xhc3MgRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yIHtcclxuICBwcml2YXRlIGNoaWxkOiBDaGlsZFByb2Nlc3MgfCBudWxsID0gbnVsbDtcclxuICBwcml2YXRlIF9zdGF0ZTogSG9zdFN0YXRlID0gJ3N0b3BwZWQnO1xyXG4gIHByaXZhdGUgcmVzdGFydENvdW50ID0gMDtcclxuICBwcml2YXRlIGxhc3RFcnJvciA9ICcnO1xyXG4gIHByaXZhdGUgc3RvcHBpbmcgPSBmYWxzZTtcclxuICBwcml2YXRlIHJlYWRvbmx5IHRva2VuOiBzdHJpbmc7XHJcbiAgcHJpdmF0ZSByZWFkb25seSBvcHRzOiBSZXF1aXJlZDxQaWNrPFN1cGVydmlzb3JPcHRpb25zLCAnbWF4UmVzdGFydHMnIHwgJ3N0YXJ0VGltZW91dE1zJyB8ICdncmFjZWZ1bFNodXRkb3duTXMnPj4gJiBTdXBlcnZpc29yT3B0aW9ucztcclxuICBwcml2YXRlIGV4aXRXYWl0ZXJzOiBBcnJheTwoKSA9PiB2b2lkPiA9IFtdO1xyXG5cclxuICBjb25zdHJ1Y3RvcihcclxuICAgIHByaXZhdGUgcmVhZG9ubHkgc3BlYzogSG9zdFNwZWMsXHJcbiAgICBvcHRzOiBTdXBlcnZpc29yT3B0aW9ucyA9IHt9LFxyXG4gICkge1xyXG4gICAgdGhpcy50b2tlbiA9IG9wdHMudG9rZW4gPz8gcmFuZG9tQnl0ZXMoMzIpLnRvU3RyaW5nKCdiYXNlNjR1cmwnKTtcclxuICAgIHRoaXMub3B0cyA9IHtcclxuICAgICAgbWF4UmVzdGFydHM6IG9wdHMubWF4UmVzdGFydHMgPz8gREVGQVVMVF9NQVhfUkVTVEFSVFMsXHJcbiAgICAgIHN0YXJ0VGltZW91dE1zOiBvcHRzLnN0YXJ0VGltZW91dE1zID8/IERFRkFVTFRfU1RBUlRfVElNRU9VVF9NUyxcclxuICAgICAgZ3JhY2VmdWxTaHV0ZG93bk1zOiBvcHRzLmdyYWNlZnVsU2h1dGRvd25NcyA/PyBERUZBVUxUX0dSQUNFRlVMX01TLFxyXG4gICAgICAuLi5vcHRzLFxyXG4gICAgfTtcclxuICB9XHJcblxyXG4gIGdldCBzdGF0ZSgpOiBIb3N0U3RhdGUge1xyXG4gICAgcmV0dXJuIHRoaXMuX3N0YXRlO1xyXG4gIH1cclxuXHJcbiAgZ2V0IHJlc3RhcnRzVXNlZCgpOiBudW1iZXIge1xyXG4gICAgcmV0dXJuIHRoaXMucmVzdGFydENvdW50O1xyXG4gIH1cclxuXHJcbiAgcHJpdmF0ZSBzZXRTdGF0ZShzOiBIb3N0U3RhdGUsIGVycj86IHN0cmluZyk6IHZvaWQge1xyXG4gICAgdGhpcy5fc3RhdGUgPSBzO1xyXG4gICAgaWYgKGVyciAhPT0gdW5kZWZpbmVkKSB0aGlzLmxhc3RFcnJvciA9IGVycjtcclxuICAgIGNvbnN0IGluZm86IHsgcmVzdGFydENvdW50OiBudW1iZXI7IGxhc3RFcnJvcj86IHN0cmluZyB9ID0geyByZXN0YXJ0Q291bnQ6IHRoaXMucmVzdGFydENvdW50IH07XHJcbiAgICBpZiAodGhpcy5sYXN0RXJyb3IgIT09ICcnKSBpbmZvLmxhc3RFcnJvciA9IHRoaXMubGFzdEVycm9yO1xyXG4gICAgdGhpcy5vcHRzLm9uU3RhdGVDaGFuZ2U/LihzLCBpbmZvKTtcclxuICB9XHJcblxyXG4gIC8qKiBcdTU0MkZcdTUyQTggaG9zdCBcdTVFNzZcdTdCNDlcdTVGODUgcmVhZHkoXHU1RjE1XHU1QkZDXHU4ODRDICsgXHU1RTI2IHRva2VuIFx1NzY4NFx1NTA2NVx1NUVCN1x1NjNBMlx1NkQ0QilcdTMwMDIgKi9cclxuICBhc3luYyBzdGFydCgpOiBQcm9taXNlPEhvc3RFbmRwb2ludD4ge1xyXG4gICAgaWYgKHRoaXMuX3N0YXRlID09PSAncmVhZHknIHx8IHRoaXMuX3N0YXRlID09PSAnc3RhcnRpbmcnKSB7XHJcbiAgICAgIHRocm93IGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgc3VwZXJ2aXNvciBhbHJlYWR5ICR7dGhpcy5fc3RhdGV9YCk7XHJcbiAgICB9XHJcbiAgICB0aGlzLnJlc3RhcnRDb3VudCA9IDA7XHJcbiAgICB0aGlzLnN0b3BwaW5nID0gZmFsc2U7XHJcbiAgICByZXR1cm4gdGhpcy5sYXVuY2goKTtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgYXN5bmMgbGF1bmNoKCk6IFByb21pc2U8SG9zdEVuZHBvaW50PiB7XHJcbiAgICB0aGlzLnNldFN0YXRlKCdzdGFydGluZycpO1xyXG4gICAgY29uc3QgY2hpbGQgPSBzcGF3bih0aGlzLnNwZWMuY29tbWFuZCwgdGhpcy5zcGVjLmFyZ3MsIHtcclxuICAgICAgY3dkOiB0aGlzLnNwZWMuY3dkLFxyXG4gICAgICBlbnY6IHtcclxuICAgICAgICAuLi5wcm9jZXNzLmVudixcclxuICAgICAgICAuLi50aGlzLnNwZWMuZW52LFxyXG4gICAgICAgIEhNSF9ERVNLVE9QX1RPS0VOOiB0aGlzLnRva2VuLFxyXG4gICAgICB9LFxyXG4gICAgICBzdGRpbzogWydpZ25vcmUnLCAncGlwZScsICdwaXBlJ10sXHJcbiAgICAgIHdpbmRvd3NIaWRlOiB0cnVlLFxyXG4gICAgfSk7XHJcbiAgICB0aGlzLmNoaWxkID0gY2hpbGQ7XHJcblxyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3QgZW5kcG9pbnQgPSBhd2FpdCB0aGlzLmF3YWl0UmVhZHkoY2hpbGQpO1xyXG4gICAgICB0aGlzLmN1cnJlbnRFbmRwb2ludCA9IHsgcG9ydDogZW5kcG9pbnQucG9ydCwgdmVyc2lvbjogZW5kcG9pbnQudmVyc2lvbiB9O1xyXG4gICAgICB0aGlzLnNldFN0YXRlKCdyZWFkeScpO1xyXG4gICAgICB0aGlzLm9wdHMub25SZWFkeT8uKGVuZHBvaW50KTtcclxuICAgICAgLy8gcmVhZHkgXHU0RTRCXHU1NDBFXHU4RkRCXHU3QTBCXHU2QjdCXHU0RUExID0gXHU2MTBGXHU1OTE2XHU5MDAwXHU1MUZBIFx1MjE5MiBcdTY3MDlcdTk2NTBcdTkxQ0RcdTU0MkZcclxuICAgICAgY2hpbGQub25jZSgnZXhpdCcsICgpID0+IHtcclxuICAgICAgICB0aGlzLmV4aXRXYWl0ZXJzLmZvckVhY2goKHcpID0+IHcoKSk7XHJcbiAgICAgICAgdGhpcy5leGl0V2FpdGVycyA9IFtdO1xyXG4gICAgICAgIHRoaXMub25VbmV4cGVjdGVkRXhpdCgpO1xyXG4gICAgICB9KTtcclxuICAgICAgcmV0dXJuIGVuZHBvaW50O1xyXG4gICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgIGlmICghY2hpbGQua2lsbGVkKSBjaGlsZC5raWxsKCk7XHJcbiAgICAgIGlmICh0aGlzLmNoaWxkID09PSBjaGlsZCkgdGhpcy5jaGlsZCA9IG51bGw7XHJcbiAgICAgIHRocm93IGVycjtcclxuICAgIH1cclxuICB9XHJcblxyXG4gIC8qKiBcdTRFQ0Ugc3Rkb3V0IFx1NjI3RSBIb3N0UmVhZHlMaW5lLFx1NzEzNlx1NTQwRVx1NTA2NVx1NUVCN1x1NjNBMlx1NkQ0Qlx1MzAwMiAqL1xyXG4gIHByaXZhdGUgYXdhaXRSZWFkeShjaGlsZDogQ2hpbGRQcm9jZXNzKTogUHJvbWlzZTxIb3N0RW5kcG9pbnQ+IHtcclxuICAgIHJldHVybiBuZXcgUHJvbWlzZTxIb3N0RW5kcG9pbnQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcclxuICAgICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHtcclxuICAgICAgICByZWplY3QoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBob3N0IGRpZCBub3Qgc2lnbmFsIHJlYWR5IHdpdGhpbiAke3RoaXMub3B0cy5zdGFydFRpbWVvdXRNc31tc2AsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xyXG4gICAgICB9LCB0aGlzLm9wdHMuc3RhcnRUaW1lb3V0TXMpO1xyXG5cclxuICAgICAgY29uc3QgZG9uZSA9IChmbjogKCkgPT4gdm9pZCk6IHZvaWQgPT4ge1xyXG4gICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XHJcbiAgICAgICAgZm4oKTtcclxuICAgICAgfTtcclxuXHJcbiAgICAgIGlmICghY2hpbGQuc3Rkb3V0KSB7XHJcbiAgICAgICAgZG9uZSgoKSA9PiByZWplY3QoZGVza3RvcEVycm9yKCdSVU5USU1FX0NSQVNIRUQnLCAnaG9zdCBzcGF3bmVkIHdpdGhvdXQgc3Rkb3V0IHBpcGUnKSkpO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgICAgfVxyXG5cclxuICAgICAgY29uc3QgcmwgPSBjcmVhdGVJbnRlcmZhY2UoeyBpbnB1dDogY2hpbGQuc3Rkb3V0IH0pO1xyXG4gICAgICBjb25zdCBvbkxpbmUgPSAobGluZTogc3RyaW5nKTogdm9pZCA9PiB7XHJcbiAgICAgICAgbGV0IHBhcnNlZDogdW5rbm93bjtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgcGFyc2VkID0gSlNPTi5wYXJzZShsaW5lKTtcclxuICAgICAgICB9IGNhdGNoIHtcclxuICAgICAgICAgIHJldHVybjsgLy8gaG9zdCBcdTc2ODRcdTY2NkVcdTkwMUFcdTY1RTVcdTVGRDdcdTg4NEMsXHU1RkZEXHU3NTY1XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChpc0hvc3RSZWFkeUxpbmUocGFyc2VkKSkge1xyXG4gICAgICAgICAgcmwuY2xvc2UoKTtcclxuICAgICAgICAgIHZvaWQgdGhpcy5wcm9iZUFuZFJlbWVtYmVyKHBhcnNlZC5wb3J0LCBwYXJzZWQudmVyc2lvbilcclxuICAgICAgICAgICAgLnRoZW4oKGVuZHBvaW50KSA9PiBkb25lKCgpID0+IHJlc29sdmUoZW5kcG9pbnQpKSlcclxuICAgICAgICAgICAgLmNhdGNoKChlcnI6IHVua25vd24pID0+IGRvbmUoKCkgPT4gcmVqZWN0KGVycikpKTtcclxuICAgICAgICB9XHJcbiAgICAgIH07XHJcbiAgICAgIHJsLm9uKCdsaW5lJywgb25MaW5lKTtcclxuXHJcbiAgICAgIGNoaWxkLm9uY2UoJ2V4aXQnLCAoY29kZSkgPT4ge1xyXG4gICAgICAgIGRvbmUoKCkgPT4gcmVqZWN0KGRlc2t0b3BFcnJvcignUlVOVElNRV9DUkFTSEVEJywgYGhvc3QgZXhpdGVkIGR1cmluZyBzdGFydHVwIChjb2RlICR7Y29kZSA/PyAnbnVsbCd9KWAsIHsgcmV0cnlhYmxlOiBmYWxzZSwgcmVjb3ZlcnlBY3Rpb246ICdPUEVOX0xPR1MnIH0pKSk7XHJcbiAgICAgIH0pO1xyXG4gICAgfSk7XHJcbiAgfVxyXG5cclxuICAvKiogXHU1RTI2IHRva2VuIFx1NzY4NFx1NTA2NVx1NUVCN1x1NjNBMlx1NkQ0QjpHRVQgL2FwaS9zdGF0ZVx1MzAwMjQwMSBcdTIxOTIgQVVUSF9GQUlMRUQoXHU0RTBEXHU5MUNEXHU4QkQ1KVx1MzAwMiAqL1xyXG4gIHByaXZhdGUgYXN5bmMgcHJvYmUocG9ydDogbnVtYmVyLCB2ZXJzaW9uOiBzdHJpbmcpOiBQcm9taXNlPEhvc3RFbmRwb2ludD4ge1xyXG4gICAgbGV0IHJlczogUmVzcG9uc2U7XHJcbiAgICB0cnkge1xyXG4gICAgICByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2FwaS9zdGF0ZWAsIHtcclxuICAgICAgICBoZWFkZXJzOiB7ICd4LWhtaC1rZXknOiB0aGlzLnRva2VuIH0sXHJcbiAgICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDNfMDAwKSxcclxuICAgICAgfSk7XHJcbiAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgdGhyb3cgZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBoZWFsdGggcHJvYmUgZmFpbGVkOiAke1N0cmluZyhlcnIpLnNsaWNlKDAsIDE2MCl9YCwgeyByZXRyeWFibGU6IHRydWUgfSk7XHJcbiAgICB9XHJcbiAgICBpZiAocmVzLnN0YXR1cyA9PT0gNDAxIHx8IHJlcy5zdGF0dXMgPT09IDQwMykge1xyXG4gICAgICB0aHJvdyBkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgYGhvc3QgcmVqZWN0ZWQgdGhlIHNlc3Npb24gdG9rZW4gKEhUVFAgJHtyZXMuc3RhdHVzfSlgLCB7IHJldHJ5YWJsZTogZmFsc2UsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KTtcclxuICAgIH1cclxuICAgIGlmICghcmVzLm9rKSB7XHJcbiAgICAgIHRocm93IGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgaGVhbHRoIHByb2JlIEhUVFAgJHtyZXMuc3RhdHVzfWAsIHsgcmV0cnlhYmxlOiB0cnVlIH0pO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHsgcG9ydCwgdmVyc2lvbiwgdG9rZW46IHRoaXMudG9rZW4gfTtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgb25VbmV4cGVjdGVkRXhpdCgpOiB2b2lkIHtcclxuICAgIGlmICh0aGlzLnN0b3BwaW5nIHx8IHRoaXMuX3N0YXRlID09PSAnc3RvcHBlZCcgfHwgdGhpcy5fc3RhdGUgPT09ICdzdG9wcGluZycpIHJldHVybjtcclxuICAgIHRoaXMuY2hpbGQgPSBudWxsO1xyXG4gICAgaWYgKHRoaXMucmVzdGFydENvdW50IDwgdGhpcy5vcHRzLm1heFJlc3RhcnRzKSB7XHJcbiAgICAgIHRoaXMucmVzdGFydENvdW50ICs9IDE7XHJcbiAgICAgIHRoaXMuc2V0U3RhdGUoJ3Jlc3RhcnRpbmcnKTtcclxuICAgICAgdm9pZCB0aGlzLmxhdW5jaCgpLmNhdGNoKCgpID0+IHtcclxuICAgICAgICAvLyBcdTkxQ0RcdTU0MkZcdTVDMURcdThCRDVcdTU5MzFcdThEMjUoXHU1NDJGXHU1MkE4XHU1MzczXHU1RDI5L1x1OEQ4NVx1NjVGNi9cdTYyRDJcdThCQTQpOlx1N0VFN1x1N0VFRFx1NkQ4OFx1ODAxN1x1OTFDRFx1NTQyRlx1NkIyMVx1NjU3MFx1NzZGNFx1NTIzMFx1NjUzRVx1NUYwM1xyXG4gICAgICAgIHRoaXMucmV0cnlPckZhaWwoKTtcclxuICAgICAgfSk7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICB0aGlzLnNldFN0YXRlKCdmYWlsZWQnLCBgaG9zdCBleGl0ZWQgdW5leHBlY3RlZGx5ICR7dGhpcy5yZXN0YXJ0Q291bnQgKyAxfSB0aW1lczsgZ2l2aW5nIHVwYCk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICBwcml2YXRlIHJldHJ5T3JGYWlsKCk6IHZvaWQge1xyXG4gICAgaWYgKHRoaXMuc3RvcHBpbmcgfHwgdGhpcy5fc3RhdGUgPT09ICdzdG9wcGVkJyB8fCB0aGlzLl9zdGF0ZSA9PT0gJ3N0b3BwaW5nJykgcmV0dXJuO1xyXG4gICAgaWYgKHRoaXMucmVzdGFydENvdW50IDwgdGhpcy5vcHRzLm1heFJlc3RhcnRzKSB7XHJcbiAgICAgIHRoaXMucmVzdGFydENvdW50ICs9IDE7XHJcbiAgICAgIHRoaXMuc2V0U3RhdGUoJ3Jlc3RhcnRpbmcnKTtcclxuICAgICAgdm9pZCB0aGlzLmxhdW5jaCgpLmNhdGNoKCgpID0+IHRoaXMucmV0cnlPckZhaWwoKSk7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICB0aGlzLnNldFN0YXRlKCdmYWlsZWQnLCBgaG9zdCBmYWlsZWQgdG8gc3RheSB1cCBhZnRlciAke3RoaXMucmVzdGFydENvdW50fSByZXN0YXJ0IGF0dGVtcHRzYCk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvKiogXHU0RjE4XHU5NkM1XHU1MDVDXHU2QjYyOlx1NTE0OCBIVFRQIHNodXRkb3duLFx1OEQ4NVx1NjVGNlx1NjI0RFx1NUJGOVx1NjcyQ1x1OEZEQlx1N0EwQlx1NTNFNVx1NjdDNCBraWxsXHUzMDAyICovXHJcbiAgYXN5bmMgc3RvcCgpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIHRoaXMuc3RvcHBpbmcgPSB0cnVlO1xyXG4gICAgaWYgKHRoaXMuX3N0YXRlID09PSAnc3RvcHBlZCcpIHJldHVybjtcclxuICAgIHRoaXMuc2V0U3RhdGUoJ3N0b3BwaW5nJyk7XHJcbiAgICBjb25zdCBjaGlsZCA9IHRoaXMuY2hpbGQ7XHJcbiAgICB0aGlzLmNoaWxkID0gbnVsbDtcclxuICAgIHRoaXMuY3VycmVudEVuZHBvaW50ID0gbnVsbDtcclxuICAgIGlmICghY2hpbGQpIHtcclxuICAgICAgdGhpcy5zZXRTdGF0ZSgnc3RvcHBlZCcpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCBleGl0ZWQgPSBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4ge1xyXG4gICAgICBpZiAoY2hpbGQuZXhpdENvZGUgIT09IG51bGwgfHwgY2hpbGQuc2lnbmFsQ29kZSAhPT0gbnVsbCkgcmVzb2x2ZSgpO1xyXG4gICAgICBlbHNlIHtcclxuICAgICAgICBjb25zdCB3ID0gKCk6IHZvaWQgPT4gcmVzb2x2ZSgpO1xyXG4gICAgICAgIHRoaXMuZXhpdFdhaXRlcnMucHVzaCh3KTtcclxuICAgICAgICBjaGlsZC5vbmNlKCdleGl0Jywgdyk7XHJcbiAgICAgIH1cclxuICAgIH0pO1xyXG4gICAgLy8gXHU1REYyXHU3N0U1XHU3QUVGXHU1M0UzXHU2MjREXHU1QzFEXHU4QkQ1IEhUVFAgXHU0RjE4XHU5NkM1XHU1MTczXHU5NUVEO1x1NjcyQVx1NzdFNVx1N0FFRlx1NTNFM1x1NzZGNFx1NjNBNVx1OEQ3MCBraWxsIFx1NTE1Q1x1NUU5NVxyXG4gICAgaWYgKHRoaXMubGFzdEVuZHBvaW50ICE9PSBudWxsKSB7XHJcbiAgICAgIHRyeSB7XHJcbiAgICAgICAgYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHt0aGlzLmxhc3RFbmRwb2ludH0vYXBpL2Rlc2t0b3Avc2h1dGRvd25gLCB7XHJcbiAgICAgICAgICBtZXRob2Q6ICdQT1NUJyxcclxuICAgICAgICAgIGhlYWRlcnM6IHsgJ3gtaG1oLWtleSc6IHRoaXMudG9rZW4gfSxcclxuICAgICAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCgxXzAwMCksXHJcbiAgICAgICAgfSk7XHJcbiAgICAgIH0gY2F0Y2gge1xyXG4gICAgICAgIC8vIGhvc3QgXHU1REYyXHU2QjdCXHU2MjE2XHU0RTBEXHU1RTk0XHU3QjU0Olx1OEQ3MCBraWxsIFx1NTE1Q1x1NUU5NVxyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgICBjb25zdCBncmFjZWZ1bCA9IGF3YWl0IFByb21pc2UucmFjZShbXHJcbiAgICAgIGV4aXRlZC50aGVuKCgpID0+IHRydWUpLFxyXG4gICAgICBuZXcgUHJvbWlzZTxib29sZWFuPigocmVzb2x2ZSkgPT4gc2V0VGltZW91dCgoKSA9PiByZXNvbHZlKGZhbHNlKSwgdGhpcy5vcHRzLmdyYWNlZnVsU2h1dGRvd25NcykpLFxyXG4gICAgXSk7XHJcbiAgICBpZiAoIWdyYWNlZnVsICYmIGNoaWxkLmV4aXRDb2RlID09PSBudWxsICYmIGNoaWxkLnNpZ25hbENvZGUgPT09IG51bGwpIHtcclxuICAgICAgY2hpbGQua2lsbCgpOyAvLyBcdTUzRUFcdTY3NDBcdTgxRUFcdTVERjFcdTYzMDFcdTY3MDlcdTc2ODRcdTUzRTVcdTY3QzQsXHU3RUREXHU0RTBEXHU2MzA5XHU4RkRCXHU3QTBCXHU1NDBEXHJcbiAgICB9XHJcbiAgICBhd2FpdCBleGl0ZWQuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcclxuICAgIHRoaXMuc2V0U3RhdGUoJ3N0b3BwZWQnKTtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgbGFzdEVuZHBvaW50OiBudW1iZXIgfCBudWxsID0gbnVsbDtcclxuICBwcml2YXRlIGN1cnJlbnRFbmRwb2ludDogeyBwb3J0OiBudW1iZXI7IHZlcnNpb246IHN0cmluZyB9IHwgbnVsbCA9IG51bGw7XHJcblxyXG4gIC8qKiBcdTVGNTNcdTUyNEQgaG9zdCBcdTdBRUZcdTcwQjkocmVhZHkgXHU1NDBFXHU2NzA5XHU1MDNDO1x1NEUwRFx1NTQyQiB0b2tlbilcdTMwMDIgKi9cclxuICBnZXQgZW5kcG9pbnQoKTogeyBwb3J0OiBudW1iZXI7IHZlcnNpb246IHN0cmluZyB9IHwgbnVsbCB7XHJcbiAgICByZXR1cm4gdGhpcy5jdXJyZW50RW5kcG9pbnQ7XHJcbiAgfVxyXG5cclxuICAvKiogXHU2M0EyXHU2RDRCXHU2MjEwXHU1MjlGXHU1NDBFXHU4QkIwXHU0RjRGXHU3QUVGXHU1M0UzLFx1NEY5QiBzdG9wKCkgXHU3Njg0XHU0RjE4XHU5NkM1XHU1MTczXHU5NUVEXHU0RjdGXHU3NTI4XHUzMDAyICovXHJcbiAgcHJpdmF0ZSBhc3luYyBwcm9iZUFuZFJlbWVtYmVyKHBvcnQ6IG51bWJlciwgdmVyc2lvbjogc3RyaW5nKTogUHJvbWlzZTxIb3N0RW5kcG9pbnQ+IHtcclxuICAgIGNvbnN0IGVwID0gYXdhaXQgdGhpcy5wcm9iZShwb3J0LCB2ZXJzaW9uKTtcclxuICAgIHRoaXMubGFzdEVuZHBvaW50ID0gZXAucG9ydDtcclxuICAgIHJldHVybiBlcDtcclxuICB9XHJcbn1cclxuXHJcbi8qKiBcdTYyOEFcdTY3MkFcdTc3RTVcdTk1MTlcdThCRUZcdTg5QzRcdTdFQTZcdTRFM0EgRGVza3RvcEVycm9yKFx1NURGMlx1NjYyRlx1NTIxOVx1NTM5Rlx1NjgzN1x1OEZENFx1NTZERSlcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHRvRGVza3RvcEVycm9yKGVycjogdW5rbm93bik6IERlc2t0b3BFcnJvciB7XHJcbiAgaWYgKGlzRGVza3RvcEVycm9yKGVycikpIHJldHVybiBlcnI7XHJcbiAgY29uc3QgbWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcclxuICByZXR1cm4gZGVza3RvcEVycm9yKCdSVU5USU1FX0NSQVNIRUQnLCBtZXNzYWdlLnNsaWNlKDAsIDMwMCksIHsgcmV0cnlhYmxlOiBmYWxzZSB9KTtcclxufVxyXG4iLCAiLyoqXHJcbiAqIEBobWgtZGVza3RvcC9jb250cmFjdHMgXHUyMDE0IFx1NEU4Qlx1NEVGNlx1NEZFMVx1NUMwMShcdTVGMDBcdTUzRDFcdThCQTFcdTUyMTJcdTY1ODdcdTY4NjMgMDQgXHUwMEE3XHU0RTA5KVxyXG4gKlxyXG4gKiBcdTRFMDBcdTY3NjEgVUkgXHU0RThCXHU0RUY2XHU3Njg0XHU1NTJGXHU0RTAwXHU1RjYyXHU3MkI2XHUzMDAyXHU1MjREXHU3QUVGIHJlZHVjZXIgXHU1RkM1XHU5ODdCXHU2MzA5IHNlc3Npb25JZC9ydW5JZC9zZXEgXHU1OTA0XHU3NDA2O1xyXG4gKiBcdTkxQ0RcdTU5MEQgZXZlbnRJZCBcdTVFNDJcdTdCNDlcdTRFMjJcdTVGMDM7c2VxIFx1N0YzQVx1NTNFM1x1ODlFNlx1NTNEMVx1ODg2NVx1NjJDOTtcdTk3NUVcdTVFNDJcdTdCNDlcdTUyQThcdTRGNUNcdTRFMERcdTc1MzEgU1NFIFx1ODFFQVx1NTJBOFx1OTFDRFx1NTNEMVx1MzAwMlxyXG4gKi9cclxuXHJcbmltcG9ydCB0eXBlIHsgQXJ0aWZhY3RSZWYgfSBmcm9tICcuL2R0by50cyc7XHJcbmltcG9ydCB0eXBlIHsgRGVza3RvcEVycm9yIH0gZnJvbSAnLi9lcnJvci50cyc7XHJcblxyXG4vKiogXHU0RThCXHU0RUY2XHU3OUNEXHU3QzdCKFx1NTIyNFx1NTIyQlx1OTUyRSlcdTMwMDJcdTY1QjBcdTU4OUUga2luZCA9IHNjaGVtYVZlcnNpb24gXHU1MzQ3XHU3RUE3LFx1NEUwRFx1NTE0MVx1OEJCOFx1OTc1OVx1OUVEOFx1NjI2OVx1Njc5QVx1NEUzRVx1MzAwMiAqL1xyXG5leHBvcnQgY29uc3QgRVZFTlRfS0lORFMgPSBbXHJcbiAgJ3J1bi5zdGFydGVkJyxcclxuICAncGxhbi51cGRhdGVkJyxcclxuICAndG9vbC5zdGFydGVkJyxcclxuICAndG9vbC5jb21wbGV0ZWQnLFxyXG4gICdhcHByb3ZhbC5yZXF1aXJlZCcsXHJcbiAgJ3ZlcmlmaWNhdGlvbi51cGRhdGVkJyxcclxuICAnYXJ0aWZhY3QuY3JlYXRlZCcsXHJcbiAgJ3J1bi5jb21wbGV0ZWQnLFxyXG4gICdydW4uZmFpbGVkJyxcclxuXSBhcyBjb25zdDtcclxuXHJcbmV4cG9ydCB0eXBlIEV2ZW50S2luZCA9ICh0eXBlb2YgRVZFTlRfS0lORFMpW251bWJlcl07XHJcblxyXG5leHBvcnQgY29uc3QgRVZFTlRfU0NIRU1BX1ZFUlNJT04gPSAxO1xyXG5leHBvcnQgdHlwZSBFdmVudFNjaGVtYVZlcnNpb24gPSAxO1xyXG5cclxuLyoqIFNTRSBcdTZENDFcdTRFMEFcdTc2ODRcdTZCQ0ZcdTRFMDBcdTY3NjFcdTRFOEJcdTRFRjZcdTMwMDIgKi9cclxuZXhwb3J0IGludGVyZmFjZSBFdmVudEVudmVsb3BlPFQgPSB1bmtub3duPiB7XHJcbiAgc2NoZW1hVmVyc2lvbjogRXZlbnRTY2hlbWFWZXJzaW9uO1xyXG4gIC8qKiBcdTUxNjhcdTVDNDBcdTU1MkZcdTRFMDA7XHU5MUNEXHU4RkRFL1x1ODg2NVx1NjJDOVx1NTQwRVx1OTFDRFx1NTkwRFx1NTFGQVx1NzNCMFx1NjVGNlx1NjNBNVx1NjUzNlx1NjVCOVx1NUU0Mlx1N0I0OVx1NEUyMlx1NUYwM1x1MzAwMiAqL1xyXG4gIGV2ZW50SWQ6IHN0cmluZztcclxuICBzZXNzaW9uSWQ6IHN0cmluZztcclxuICBydW5JZDogc3RyaW5nO1xyXG4gIC8qKiBcdTRGMUFcdThCRERcdTUxODVcdTUzNTVcdThDMDNcdTkwMTJcdTU4OUU7XHU3RjNBXHU1M0UzXHU2MTBGXHU1NDczXHU3NzQwXHU0RTIyXHU0RThCXHU0RUY2LFx1OTcwMFx1ODk4MVx1ODg2NVx1NjJDOVx1MzAwMiAqL1xyXG4gIHNlcTogbnVtYmVyO1xyXG4gIC8qKiBSRkMzMzM5XHUzMDAyICovXHJcbiAgb2NjdXJyZWRBdDogc3RyaW5nO1xyXG4gIGtpbmQ6IEV2ZW50S2luZDtcclxuICBwYXlsb2FkOiBUO1xyXG59XHJcblxyXG4vKiogcnVuLnN0YXJ0ZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cclxuZXhwb3J0IGludGVyZmFjZSBSdW5TdGFydGVkUGF5bG9hZCB7XHJcbiAgdGFzazogc3RyaW5nO1xyXG4gIG1vZGU6ICdhc2snIHwgJ2F1dG8nIHwgJ3lvbG8nO1xyXG59XHJcblxyXG4vKiogcGxhbi51cGRhdGVkIFx1NzY4NCBwYXlsb2FkKFx1OEJBMVx1NTIxMlx1NkI2NVx1OUFBNFx1NTIxN1x1ODg2OCxcdTY3NjVcdTgxRUEgcnVudGltZSBcdTc2ODRcdTdFRDNcdTY3ODRcdTUzMTZcdThCQTFcdTUyMTIsXHU0RTBEXHU2NjJGIGNoYWluLW9mLXRob3VnaHQpXHUzMDAyICovXHJcbmV4cG9ydCBpbnRlcmZhY2UgUGxhblVwZGF0ZWRQYXlsb2FkIHtcclxuICBzdGVwczogQXJyYXk8eyB0aXRsZTogc3RyaW5nOyBzdGF0dXM6ICdwZW5kaW5nJyB8ICdhY3RpdmUnIHwgJ2RvbmUnIHwgJ2ZhaWxlZCcgfT47XHJcbn1cclxuXHJcbi8qKiB0b29sLnN0YXJ0ZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cclxuZXhwb3J0IGludGVyZmFjZSBUb29sU3RhcnRlZFBheWxvYWQge1xyXG4gIG5hbWU6IHN0cmluZztcclxuICAvKiogXHU1M0MyXHU2NTcwXHU0RUU1XHU2NTg3XHU2NzJDXHU1NDQ4XHU3M0IwLFx1NkUzMlx1NjdEM1x1N0FFRlx1NkMzOFx1NEUwRCBldmFsO1x1NTkyN1x1NUJGOVx1OEM2MVx1NzUzMSBydW50aW1lIFx1NjIyQVx1NjVBRFx1MzAwMiAqL1xyXG4gIGFyZ3NQcmV2aWV3OiBzdHJpbmc7XHJcbn1cclxuXHJcbi8qKiB0b29sLmNvbXBsZXRlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xyXG5leHBvcnQgaW50ZXJmYWNlIFRvb2xDb21wbGV0ZWRQYXlsb2FkIHtcclxuICBuYW1lOiBzdHJpbmc7XHJcbiAgaXNFcnJvcjogYm9vbGVhbjtcclxuICBvdXRwdXRQcmV2aWV3OiBzdHJpbmc7XHJcbn1cclxuXHJcbi8qKiBhcHByb3ZhbC5yZXF1aXJlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMlx1NUJBMVx1NjI3OVx1Njc0M1x1NUEwMVx1NTcyOCBydW50aW1lIFx1NTQwRVx1N0FFRjtVSSBcdTUzRUFcdTY2MkZcdThGNkNcdThGRjBcdTMwMDIgKi9cclxuZXhwb3J0IGludGVyZmFjZSBBcHByb3ZhbFJlcXVpcmVkUGF5bG9hZCB7XHJcbiAgYXBwcm92YWxJZDogc3RyaW5nO1xyXG4gIHRvb2w6IHN0cmluZztcclxuICBhcmdzUHJldmlldzogc3RyaW5nO1xyXG4gIC8qKiBcdTVGNzFcdTU0Q0RcdTgzMDNcdTU2RjQvXHU5OENFXHU5NjY5XHU3Njg0XHU0RUJBXHU3QzdCXHU1M0VGXHU4QkZCXHU4QkY0XHU2NjBFLFx1NzUzMSBydW50aW1lIFx1NzUxRlx1NjIxMFx1MzAwMiAqL1xyXG4gIHJpc2s6IHN0cmluZztcclxufVxyXG5cclxuLyoqIHZlcmlmaWNhdGlvbi51cGRhdGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXHJcbmV4cG9ydCBpbnRlcmZhY2UgVmVyaWZpY2F0aW9uVXBkYXRlZFBheWxvYWQge1xyXG4gIHN1bW1hcnk6IHN0cmluZztcclxuICBwYXNzZWQ6IGJvb2xlYW4gfCBudWxsOyAvLyBudWxsID0gXHU2NzJBXHU3N0U1L1x1OEZEQlx1ODg0Q1x1NEUyRChORUVEUy1EQVRBIFx1NjVGNlx1NEUwRFx1NTA0N1x1NTg2QilcclxufVxyXG5cclxuLyoqIGFydGlmYWN0LmNyZWF0ZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cclxuZXhwb3J0IGludGVyZmFjZSBBcnRpZmFjdENyZWF0ZWRQYXlsb2FkIHtcclxuICBhcnRpZmFjdDogQXJ0aWZhY3RSZWY7XHJcbn1cclxuXHJcbi8qKiBydW4uY29tcGxldGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXHJcbmV4cG9ydCBpbnRlcmZhY2UgUnVuQ29tcGxldGVkUGF5bG9hZCB7XHJcbiAgdGV4dDogc3RyaW5nO1xyXG4gIHR1cm5zOiBudW1iZXI7XHJcbiAgdG9vbFVzZXM6IG51bWJlcjtcclxuICB1c2FnZT86IHsgcHJvbXB0VG9rZW5zOiBudW1iZXI7IGNvbXBsZXRpb25Ub2tlbnM6IG51bWJlciB9O1xyXG59XHJcblxyXG4vKiogcnVuLmZhaWxlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xyXG5leHBvcnQgaW50ZXJmYWNlIFJ1bkZhaWxlZFBheWxvYWQge1xyXG4gIGVycm9yOiBEZXNrdG9wRXJyb3I7XHJcbn1cclxuIiwgIi8qKlxyXG4gKiBAaG1oLWRlc2t0b3AvY29udHJhY3RzIFx1MjAxNCBcdTdFRDNcdTY3ODRcdTUzMTZcdTY4NENcdTk3NjJcdTk1MTlcdThCRUYoXHU1RjAwXHU1M0QxXHU4QkExXHU1MjEyXHU2NTg3XHU2ODYzIDA0IFx1MDBBN1x1NEUwOSlcdTMwMDJcclxuICpcclxuICogaG9zdC1ub3QtcmVhZHkgLyBhdXRoLWZhaWxlZCAvIHN0YWxlLXZlcnNpb24gLyBydW50aW1lLWNyYXNoZWQgL1xyXG4gKiBwb3J0LWJpbmQtZmFpbGVkIC8gc2NoZW1hLW1pc21hdGNoIFx1NUZDNVx1OTg3Qlx1NjYyRlx1N0VEM1x1Njc4NFx1NTMxNlx1OTUxOVx1OEJFRlx1NzgwMSxcdTVFNzZcdTYzRDBcdTRGOUJcdTRFMEJcdTRFMDBcdTZCNjVcdTUyQThcdTRGNUNcdTMwMDJcclxuICogbWVzc2FnZSBcdTY2MkZcdTdFQUZcdTY1ODdcdTY3MkMsXHU2RTMyXHU2N0QzXHU3QUVGXHU2QzM4XHU0RTBEXHU2MjhBXHU1QjgzXHU1RjUzIEhUTUxcdTMwMDJcclxuICovXHJcbmV4cG9ydCBjb25zdCBFUlJPUl9DT0RFUyA9IFtcclxuICAnSE9TVF9OT1RfUkVBRFknLFxyXG4gICdBVVRIX0ZBSUxFRCcsXHJcbiAgJ1JVTlRJTUVfQ1JBU0hFRCcsXHJcbiAgJ1BPUlRfQklORF9GQUlMRUQnLFxyXG4gICdTVEFMRV9WRVJTSU9OJyxcclxuICAnU0NIRU1BX01JU01BVENIJyxcclxuXSBhcyBjb25zdDtcclxuXHJcbmV4cG9ydCB0eXBlIEVycm9yQ29kZSA9ICh0eXBlb2YgRVJST1JfQ09ERVMpW251bWJlcl07XHJcblxyXG5leHBvcnQgY29uc3QgUkVDT1ZFUllfQUNUSU9OUyA9IFsnUkVDT05ORUNUJywgJ1JFU1VNRScsICdFWFBPUlQnLCAnT1BFTl9MT0dTJ10gYXMgY29uc3Q7XHJcbmV4cG9ydCB0eXBlIFJlY292ZXJ5QWN0aW9uID0gKHR5cGVvZiBSRUNPVkVSWV9BQ1RJT05TKVtudW1iZXJdO1xyXG5cclxuZXhwb3J0IGludGVyZmFjZSBEZXNrdG9wRXJyb3Ige1xyXG4gIGNvZGU6IEVycm9yQ29kZTtcclxuICAvKiogXHU3RUFGXHU2NTg3XHU2NzJDLFx1NkMzOFx1NEUwRFx1NEZFMVx1NEVGQlx1NEUzQSBIVE1MXHUzMDAyICovXHJcbiAgbWVzc2FnZTogc3RyaW5nO1xyXG4gIHJldHJ5YWJsZTogYm9vbGVhbjtcclxuICBzZXNzaW9uSWQ/OiBzdHJpbmc7XHJcbiAgcnVuSWQ/OiBzdHJpbmc7XHJcbiAgcmVjb3ZlcnlBY3Rpb24/OiBSZWNvdmVyeUFjdGlvbjtcclxufVxyXG5cclxuLyoqIFx1Njc4NFx1OTAyMFx1NEUwMFx1NEUyQSBEZXNrdG9wRXJyb3IoZXhhY3RPcHRpb25hbFByb3BlcnR5VHlwZXMgXHU1M0NCXHU1OTdEKVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gZGVza3RvcEVycm9yKFxyXG4gIGNvZGU6IEVycm9yQ29kZSxcclxuICBtZXNzYWdlOiBzdHJpbmcsXHJcbiAgb3B0czogeyByZXRyeWFibGU/OiBib29sZWFuOyBzZXNzaW9uSWQ/OiBzdHJpbmc7IHJ1bklkPzogc3RyaW5nOyByZWNvdmVyeUFjdGlvbj86IFJlY292ZXJ5QWN0aW9uIH0gPSB7fSxcclxuKTogRGVza3RvcEVycm9yIHtcclxuICBjb25zdCBlOiBEZXNrdG9wRXJyb3IgPSB7IGNvZGUsIG1lc3NhZ2UsIHJldHJ5YWJsZTogb3B0cy5yZXRyeWFibGUgPT09IHRydWUgfTtcclxuICBpZiAob3B0cy5zZXNzaW9uSWQgIT09IHVuZGVmaW5lZCkgZS5zZXNzaW9uSWQgPSBvcHRzLnNlc3Npb25JZDtcclxuICBpZiAob3B0cy5ydW5JZCAhPT0gdW5kZWZpbmVkKSBlLnJ1bklkID0gb3B0cy5ydW5JZDtcclxuICBpZiAob3B0cy5yZWNvdmVyeUFjdGlvbiAhPT0gdW5kZWZpbmVkKSBlLnJlY292ZXJ5QWN0aW9uID0gb3B0cy5yZWNvdmVyeUFjdGlvbjtcclxuICByZXR1cm4gZTtcclxufVxyXG4iLCAiLyoqXHJcbiAqIEBobWgtZGVza3RvcC9jb250cmFjdHMgXHUyMDE0IHJ1bnRpbWUgXHU2ODIxXHU5QThDKGd1YXJkcylcdTMwMDJcclxuICpcclxuICogXHU2QkNGXHU0RTJBXHU4REU4XHU0RkUxXHU0RUZCXHU4RkI5XHU3NTRDXHU3Njg0XHU2NTcwXHU2MzZFKHJ1bnRpbWVcdTIxOTJyZW5kZXJlclx1MzAwMWhvc3RcdTIxOTJtYWluKVx1OEZEQlx1NTE2NVx1NTI0RFx1NTE0OFx1OEZDNyBndWFyZDtcclxuICogXHU2ODIxXHU5QThDXHU1OTMxXHU4RDI1XHU3Njg0XHU2NTcwXHU2MzZFXHU2MzA5IFNDSEVNQV9NSVNNQVRDSCBcdTdFRDNcdTY3ODRcdTUzMTZcdTk1MTlcdThCRUZcdTU5MDRcdTc0MDYsXHU0RTBEXHU5NzU5XHU5RUQ4XHU2M0E1XHU1M0Q3XHUzMDAyXHJcbiAqIFx1NjI0Qlx1NTE5OVx1NUI4OFx1NTM2Qlx1ODAwQ1x1NEUwRFx1NjYyRlx1NUYxNVx1N0IyQ1x1NEUwOVx1NjVCOSBzY2hlbWEgXHU1RTkzOlx1NTk1MVx1N0VBNlx1OTc2Mlx1NUMwRixcdTk2RjZcdTRGOURcdThENTZcdTY1ODdcdTUzMTYoaG1oYXJuZXNzIFx1NTQwQ1x1NkU5MClcdTMwMDJcclxuICovXHJcbmltcG9ydCB7XHJcbiAgRVZFTlRfS0lORFMsXHJcbiAgRVZFTlRfU0NIRU1BX1ZFUlNJT04sXHJcbiAgdHlwZSBFdmVudEVudmVsb3BlLFxyXG4gIHR5cGUgRXZlbnRLaW5kLFxyXG59IGZyb20gJy4vZXZlbnQudHMnO1xyXG5pbXBvcnQgeyBFUlJPUl9DT0RFUywgUkVDT1ZFUllfQUNUSU9OUywgdHlwZSBEZXNrdG9wRXJyb3IgfSBmcm9tICcuL2Vycm9yLnRzJztcclxuaW1wb3J0IHsgUlVOX1NUQVRVU0VTLCB0eXBlIFJ1blN0YXR1cyB9IGZyb20gJy4vZHRvLnRzJztcclxuXHJcbmNvbnN0IGlzUmVjb3JkID0gKHY6IHVua25vd24pOiB2IGlzIFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0+XHJcbiAgdHlwZW9mIHYgPT09ICdvYmplY3QnICYmIHYgIT09IG51bGwgJiYgIUFycmF5LmlzQXJyYXkodik7XHJcblxyXG5jb25zdCBpc05vbkVtcHR5U3RyaW5nID0gKHY6IHVua25vd24pOiB2IGlzIHN0cmluZyA9PiB0eXBlb2YgdiA9PT0gJ3N0cmluZycgJiYgdi5sZW5ndGggPiAwO1xyXG5cclxuY29uc3QgaXNSZmMzMzM5ID0gKHY6IHN0cmluZyk6IGJvb2xlYW4gPT4ge1xyXG4gIGNvbnN0IHQgPSBEYXRlLnBhcnNlKHYpO1xyXG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUodCkgJiYgL1xcZHs0fS1cXGR7Mn0tXFxkezJ9VC8udGVzdCh2KTtcclxufTtcclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpc0V2ZW50RW52ZWxvcGUodjogdW5rbm93bik6IHYgaXMgRXZlbnRFbnZlbG9wZSB7XHJcbiAgaWYgKCFpc1JlY29yZCh2KSkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICh2LnNjaGVtYVZlcnNpb24gIT09IEVWRU5UX1NDSEVNQV9WRVJTSU9OKSByZXR1cm4gZmFsc2U7XHJcbiAgaWYgKCFpc05vbkVtcHR5U3RyaW5nKHYuZXZlbnRJZCkpIHJldHVybiBmYWxzZTtcclxuICBpZiAoIWlzTm9uRW1wdHlTdHJpbmcodi5zZXNzaW9uSWQpKSByZXR1cm4gZmFsc2U7XHJcbiAgaWYgKCFpc05vbkVtcHR5U3RyaW5nKHYucnVuSWQpKSByZXR1cm4gZmFsc2U7XHJcbiAgaWYgKHR5cGVvZiB2LnNlcSAhPT0gJ251bWJlcicgfHwgIU51bWJlci5pc0ludGVnZXIodi5zZXEpIHx8IHYuc2VxIDwgMCkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICghaXNOb25FbXB0eVN0cmluZyh2Lm9jY3VycmVkQXQpIHx8ICFpc1JmYzMzMzkodi5vY2N1cnJlZEF0KSkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICghRVZFTlRfS0lORFMuaW5jbHVkZXModi5raW5kIGFzIEV2ZW50S2luZCkpIHJldHVybiBmYWxzZTtcclxuICByZXR1cm4gaXNSZWNvcmQodi5wYXlsb2FkKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGlzRGVza3RvcEVycm9yKHY6IHVua25vd24pOiB2IGlzIERlc2t0b3BFcnJvciB7XHJcbiAgaWYgKCFpc1JlY29yZCh2KSkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICghRVJST1JfQ09ERVMuaW5jbHVkZXModi5jb2RlIGFzIG5ldmVyKSkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICh0eXBlb2Ygdi5tZXNzYWdlICE9PSAnc3RyaW5nJykgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICh0eXBlb2Ygdi5yZXRyeWFibGUgIT09ICdib29sZWFuJykgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICh2LnNlc3Npb25JZCAhPT0gdW5kZWZpbmVkICYmICFpc05vbkVtcHR5U3RyaW5nKHYuc2Vzc2lvbklkKSkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICh2LnJ1bklkICE9PSB1bmRlZmluZWQgJiYgIWlzTm9uRW1wdHlTdHJpbmcodi5ydW5JZCkpIHJldHVybiBmYWxzZTtcclxuICBpZiAodi5yZWNvdmVyeUFjdGlvbiAhPT0gdW5kZWZpbmVkICYmICFSRUNPVkVSWV9BQ1RJT05TLmluY2x1ZGVzKHYucmVjb3ZlcnlBY3Rpb24gYXMgbmV2ZXIpKSByZXR1cm4gZmFsc2U7XHJcbiAgcmV0dXJuIHRydWU7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpc1J1blN0YXR1cyh2OiB1bmtub3duKTogdiBpcyBSdW5TdGF0dXMge1xyXG4gIHJldHVybiB0eXBlb2YgdiA9PT0gJ3N0cmluZycgJiYgUlVOX1NUQVRVU0VTLmluY2x1ZGVzKHYgYXMgUnVuU3RhdHVzKTtcclxufVxyXG5cclxuLyoqIEhvc3QgXHU1RjE1XHU1QkZDXHU4ODRDKHN0ZG91dCBcdTdCMkNcdTRFMDBcdTg4NEMpXHUzMDAyICovXHJcbmV4cG9ydCBmdW5jdGlvbiBpc0hvc3RSZWFkeUxpbmUodjogdW5rbm93bik6IHYgaXMgeyBobWhEZXNrdG9wSG9zdFJlYWR5OiB0cnVlOyBwb3J0OiBudW1iZXI7IHZlcnNpb246IHN0cmluZyB9IHtcclxuICBpZiAoIWlzUmVjb3JkKHYpKSByZXR1cm4gZmFsc2U7XHJcbiAgaWYgKHYuaG1oRGVza3RvcEhvc3RSZWFkeSAhPT0gdHJ1ZSkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICh0eXBlb2Ygdi5wb3J0ICE9PSAnbnVtYmVyJyB8fCAhTnVtYmVyLmlzSW50ZWdlcih2LnBvcnQpIHx8IHYucG9ydCA8PSAwIHx8IHYucG9ydCA+IDY1NTM1KSByZXR1cm4gZmFsc2U7XHJcbiAgcmV0dXJuIGlzTm9uRW1wdHlTdHJpbmcodi52ZXJzaW9uKTtcclxufVxyXG4iLCAiLyoqXHJcbiAqIERlc2t0b3BIb3N0Q2xpZW50IFx1MjAxNCBcdTVCRjkgaG1oIGhvc3QgXHU3Njg0IEhUVFArU1NFIFx1NUJBMlx1NjIzN1x1N0FFRlx1MzAwMlxyXG4gKlxyXG4gKiAtIFx1NkJDRlx1NEUyQSBIVFRQIFx1OEJGN1x1NkM0Mlx1ODFFQVx1NTJBOFx1NUUyNiBYLUhtaC1LZXkodG9rZW4gXHU0RTBEXHU4RkRCIFVSTCk7XHJcbiAqIC0gXHU3RUQzXHU2Nzg0XHU1MzE2XHU5NTE5XHU4QkVGKHJlcy5ib2R5IFx1OTFDQ1x1NzY4NCBEZXNrdG9wRXJyb3IgXHU1RjYyXHU3MkI2XHU2MjE2IEhUVFAgXHU3MkI2XHU2MDAxKVx1ODlDNFx1N0VBNlx1NjIxMFx1NUYwMlx1NUUzOFx1NjI5Qlx1NTFGQTtcclxuICogLSBTU0UgXHU3NTI4IGZldGNoIFx1NkQ0MVx1NjI0Qlx1NTE5OVx1ODlFM1x1Njc5MChpZC9ldmVudC9kYXRhIFx1NUUyNyksXHU2NTJGXHU2MzAxIExhc3QtRXZlbnQtSUQgXHU4ODY1XHU2MkM5XHU5MUNEXHU4RkRFXHUzMDAyXHJcbiAqL1xyXG5pbXBvcnQgeyBkZXNrdG9wRXJyb3IsIGlzRGVza3RvcEVycm9yLCBpc0V2ZW50RW52ZWxvcGUsIHR5cGUgRGVza3RvcEVycm9yLCB0eXBlIEV2ZW50RW52ZWxvcGUgfSBmcm9tICdAaG1oLWRlc2t0b3AvY29udHJhY3RzJztcclxuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gJ25vZGU6Y3J5cHRvJztcclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgU3NlRnJhbWUge1xyXG4gIGlkPzogc3RyaW5nO1xyXG4gIGV2ZW50OiBzdHJpbmc7XHJcbiAgZGF0YTogc3RyaW5nO1xyXG59XHJcblxyXG4vKiogXHU4OUUzXHU2NzkwXHU0RTAwXHU2QkI1IFNTRSBcdTY1ODdcdTY3MkNcdTRFM0FcdTVFMjcoXHU0RTBEXHU1NDJCXHU4REU4IGNodW5rIFx1NzY4NFx1N0YxM1x1NTFCMlx1OTAzQlx1OEY5MSxcdTdFQUZcdTUxRkRcdTY1NzBcdTRGQkZcdTRFOEVcdTZENEJcdThCRDUpXHUzMDAyICovXHJcbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVNzZUNodW5rKGNodW5rOiBzdHJpbmcpOiBTc2VGcmFtZVtdIHtcclxuICBjb25zdCBmcmFtZXM6IFNzZUZyYW1lW10gPSBbXTtcclxuICBmb3IgKGNvbnN0IGJsb2NrIG9mIGNodW5rLnNwbGl0KC9cXG5cXG4vKSkge1xyXG4gICAgaWYgKCFibG9jay50cmltKCkpIGNvbnRpbnVlO1xyXG4gICAgbGV0IGlkOiBzdHJpbmcgfCB1bmRlZmluZWQ7XHJcbiAgICBsZXQgZXZlbnQgPSAnbWVzc2FnZSc7XHJcbiAgICBjb25zdCBkYXRhTGluZXM6IHN0cmluZ1tdID0gW107XHJcbiAgICBsZXQgc2F3RmllbGQgPSBmYWxzZTtcclxuICAgIGZvciAoY29uc3QgbGluZSBvZiBibG9jay5zcGxpdCgnXFxuJykpIHtcclxuICAgICAgaWYgKGxpbmUuc3RhcnRzV2l0aCgnOicpKSBjb250aW51ZTsgLy8gXHU2Q0U4XHU5MUNBL1x1NUZDM1x1OERGM1xyXG4gICAgICBpZiAobGluZS5zdGFydHNXaXRoKCdpZDonKSkgeyBpZCA9IGxpbmUuc2xpY2UoMykudHJpbSgpOyBzYXdGaWVsZCA9IHRydWU7IH1cclxuICAgICAgZWxzZSBpZiAobGluZS5zdGFydHNXaXRoKCdldmVudDonKSkgeyBldmVudCA9IGxpbmUuc2xpY2UoNikudHJpbSgpOyBzYXdGaWVsZCA9IHRydWU7IH1cclxuICAgICAgZWxzZSBpZiAobGluZS5zdGFydHNXaXRoKCdkYXRhOicpKSB7IGRhdGFMaW5lcy5wdXNoKGxpbmUuc2xpY2UoNSkucmVwbGFjZSgvXiAvLCAnJykpOyBzYXdGaWVsZCA9IHRydWU7IH1cclxuICAgIH1cclxuICAgIGlmICghc2F3RmllbGQpIGNvbnRpbnVlOyAvLyBcdTdFQUZcdTZDRThcdTkxQ0EvXHU1RkMzXHU4REYzXHU1NzU3XHU0RTBEXHU0RUE3XHU3NTFGXHU1RTI3XHJcbiAgICBmcmFtZXMucHVzaCh7IC4uLihpZCAhPT0gdW5kZWZpbmVkID8geyBpZCB9IDoge30pLCBldmVudCwgZGF0YTogZGF0YUxpbmVzLmpvaW4oJ1xcbicpIH0pO1xyXG4gIH1cclxuICByZXR1cm4gZnJhbWVzO1xyXG59XHJcblxyXG4vKiogXHU0RUNFIFNTRSBcdTVFMjdcdTY1NzBcdTYzNkVcdTRFMkRcdTg5RTNcdTUxRkFcdTU0MDhcdTZDRDUgRXZlbnRFbnZlbG9wZTtcdTRFMERcdTU0MDhcdTZDRDVcdTc2ODRcdThGRDRcdTU2REUgbnVsbChTQ0hFTUFfTUlTTUFUQ0ggXHU3NTMxXHU4QzAzXHU3NTI4XHU2NUI5XHU4QkExXHU2NTcwKVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gZW52ZWxvcGVGcm9tRnJhbWUoZnJhbWU6IFNzZUZyYW1lKTogRXZlbnRFbnZlbG9wZSB8IG51bGwge1xyXG4gIGlmIChmcmFtZS5ldmVudCAhPT0gJ2htaCcpIHJldHVybiBudWxsOyAvLyBcdTYyMTFcdTRFRUNcdTc2ODRcdTRFOEJcdTRFRjZcdTRGRTFcdTVDMDFcdTdFREZcdTRFMDBcdThENzAgZXZlbnQ6IGhtaFxyXG4gIHRyeSB7XHJcbiAgICBjb25zdCBwYXJzZWQ6IHVua25vd24gPSBKU09OLnBhcnNlKGZyYW1lLmRhdGEpO1xyXG4gICAgcmV0dXJuIGlzRXZlbnRFbnZlbG9wZShwYXJzZWQpID8gcGFyc2VkIDogbnVsbDtcclxuICB9IGNhdGNoIHtcclxuICAgIHJldHVybiBudWxsO1xyXG4gIH1cclxufVxyXG5cclxuZXhwb3J0IGNsYXNzIERlc2t0b3BIdHRwRXJyb3IgZXh0ZW5kcyBFcnJvciB7XHJcbiAgY29uc3RydWN0b3IocHVibGljIHJlYWRvbmx5IGRldGFpbDogRGVza3RvcEVycm9yKSB7XHJcbiAgICBzdXBlcihkZXRhaWwubWVzc2FnZSk7XHJcbiAgfVxyXG59XHJcblxyXG5leHBvcnQgY2xhc3MgRGVza3RvcEhvc3RDbGllbnQge1xyXG4gIGNvbnN0cnVjdG9yKFxyXG4gICAgcHJpdmF0ZSByZWFkb25seSBiYXNlVXJsOiBzdHJpbmcsXHJcbiAgICBwcml2YXRlIHJlYWRvbmx5IHRva2VuOiBzdHJpbmcsXHJcbiAgKSB7fVxyXG5cclxuICBwcml2YXRlIGhlYWRlcnMoZXh0cmE6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fSk6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4ge1xyXG4gICAgcmV0dXJuIHsgJ3gtaG1oLWtleSc6IHRoaXMudG9rZW4sIC4uLmV4dHJhIH07XHJcbiAgfVxyXG5cclxuICBhc3luYyBnZXRKc29uPFQ+KHBhdGg6IHN0cmluZywgdGltZW91dE1zID0gNV8wMDApOiBQcm9taXNlPFQ+IHtcclxuICAgIGxldCByZXM6IFJlc3BvbnNlO1xyXG4gICAgdHJ5IHtcclxuICAgICAgcmVzID0gYXdhaXQgZmV0Y2goYCR7dGhpcy5iYXNlVXJsfSR7cGF0aH1gLCB7IGhlYWRlcnM6IHRoaXMuaGVhZGVycygpLCBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQodGltZW91dE1zKSB9KTtcclxuICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYHJlcXVlc3QgZmFpbGVkOiAke1N0cmluZyhlcnIpLnNsaWNlKDAsIDE2MCl9YCwgeyByZXRyeWFibGU6IHRydWUsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gdGhpcy5wYXJzZVJlc3BvbnNlPFQ+KHJlcyk7XHJcbiAgfVxyXG5cclxuICAvKiogXHU2MkM5XHU1M0Q2XHU3RUFGXHU2NTg3XHU2NzJDXHU3QUVGXHU3MEI5KFx1NTk4MiAvYXBpL3Nlc3Npb25zLzppZC9leHBvcnQubWQpXHUzMDAyICovXHJcbiAgYXN5bmMgZ2V0VGV4dChwYXRoOiBzdHJpbmcsIHRpbWVvdXRNcyA9IDEwXzAwMCk6IFByb21pc2U8c3RyaW5nPiB7XHJcbiAgICBsZXQgcmVzOiBSZXNwb25zZTtcclxuICAgIHRyeSB7XHJcbiAgICAgIHJlcyA9IGF3YWl0IGZldGNoKGAke3RoaXMuYmFzZVVybH0ke3BhdGh9YCwgeyBoZWFkZXJzOiB0aGlzLmhlYWRlcnMoKSwgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KHRpbWVvdXRNcykgfSk7XHJcbiAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGByZXF1ZXN0IGZhaWxlZDogJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxNjApfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSB8fCByZXMuc3RhdHVzID09PSA0MDMpIHtcclxuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdBVVRIX0ZBSUxFRCcsIGBob3N0IHJlamVjdGVkIHRoZSBzZXNzaW9uIHRva2VuIChIVFRQICR7cmVzLnN0YXR1c30pYCwgeyByZXRyeWFibGU6IGZhbHNlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xyXG4gICAgfVxyXG4gICAgaWYgKCFyZXMub2spIHtcclxuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBIVFRQICR7cmVzLnN0YXR1c31gLCB7IHJldHJ5YWJsZTogcmVzLnN0YXR1cyA+PSA1MDAgfSkpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHJlcy50ZXh0KCk7XHJcbiAgfVxyXG5cclxuICAvKiogXHU2QkNGXHU0RTJBXHU1RTI2XHU1MjZGXHU0RjVDXHU3NTI4XHU3Njg0IFBPU1QgXHU4MUVBXHU1MkE4XHU2NDNBXHU1RTI2XHU1RTQyXHU3QjQ5XHU5NTJFKDAzIFx1MDBBN1x1NTZEQlx1OTYzMlx1OTFDRFx1NjUzRTpcdThCRjdcdTZDNDJcdTRGN0ZcdTc1MjggaWRlbXBvdGVuY3lLZXk7XHJcbiAgICogIHJ1bnRpbWUgXHU0RkE3XHU3N0VEXHU2NzFGXHU1MTdDXHU1QkI5XHU1RkZEXHU3NTY1LFx1NTM0Rlx1OEJBRVx1NTE0OFx1ODg0Q1x1MjAxNFx1MjAxNFx1OTFDRFx1OEJENVx1NTNFRlx1NTFFRFx1OTUyRVx1NTNCQlx1OTFDRCxcdTRFMERcdTc2RjJcdTc2RUVcdTkxQ0RcdTY1M0UpXHUzMDAyICovXHJcbiAgYXN5bmMgcG9zdEpzb248VD4ocGF0aDogc3RyaW5nLCBib2R5OiB1bmtub3duLCB0aW1lb3V0TXMgPSAxMF8wMDApOiBQcm9taXNlPFQ+IHtcclxuICAgIGxldCByZXM6IFJlc3BvbnNlO1xyXG4gICAgdHJ5IHtcclxuICAgICAgcmVzID0gYXdhaXQgZmV0Y2goYCR7dGhpcy5iYXNlVXJsfSR7cGF0aH1gLCB7XHJcbiAgICAgICAgbWV0aG9kOiAnUE9TVCcsXHJcbiAgICAgICAgaGVhZGVyczogdGhpcy5oZWFkZXJzKHtcclxuICAgICAgICAgICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsXHJcbiAgICAgICAgICAneC1pZGVtcG90ZW5jeS1rZXknOiByYW5kb21VVUlEKCksXHJcbiAgICAgICAgfSksXHJcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoYm9keSksXHJcbiAgICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KHRpbWVvdXRNcyksXHJcbiAgICAgIH0pO1xyXG4gICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgcmVxdWVzdCBmYWlsZWQ6ICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTYwKX1gLCB7IHJldHJ5YWJsZTogdHJ1ZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcclxuICAgIH1cclxuICAgIHJldHVybiB0aGlzLnBhcnNlUmVzcG9uc2U8VD4ocmVzKTtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgYXN5bmMgcGFyc2VSZXNwb25zZTxUPihyZXM6IFJlc3BvbnNlKTogUHJvbWlzZTxUPiB7XHJcbiAgICBpZiAocmVzLnN0YXR1cyA9PT0gNDAxIHx8IHJlcy5zdGF0dXMgPT09IDQwMykge1xyXG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgYGhvc3QgcmVqZWN0ZWQgdGhlIHNlc3Npb24gdG9rZW4gKEhUVFAgJHtyZXMuc3RhdHVzfSlgLCB7IHJldHJ5YWJsZTogZmFsc2UsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XHJcbiAgICB9XHJcbiAgICBjb25zdCB0ZXh0ID0gYXdhaXQgcmVzLnRleHQoKTtcclxuICAgIGxldCBwYXJzZWQ6IHVua25vd24gPSBudWxsO1xyXG4gICAgdHJ5IHtcclxuICAgICAgcGFyc2VkID0gdGV4dCA/IEpTT04ucGFyc2UodGV4dCkgOiBudWxsO1xyXG4gICAgfSBjYXRjaCB7XHJcbiAgICAgIHBhcnNlZCA9IG51bGw7XHJcbiAgICB9XHJcbiAgICBpZiAoIXJlcy5vaykge1xyXG4gICAgICBpZiAoaXNEZXNrdG9wRXJyb3IocGFyc2VkKSkgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IocGFyc2VkKTtcclxuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBIVFRQICR7cmVzLnN0YXR1c306ICR7dGV4dC5zbGljZSgwLCAxNjApfWAsIHsgcmV0cnlhYmxlOiByZXMuc3RhdHVzID49IDUwMCB9KSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gcGFyc2VkIGFzIFQ7XHJcbiAgfVxyXG5cclxuICAvKipcclxuICAgKiBcdThCQTJcdTk2MDVcdTUxNjhcdTkwRTggU1NFIFx1NUUyNyhcdTU0MkJcdTk3NUVcdTRGRTFcdTVDMDFcdTRFOEJcdTRFRjY6ZGVsdGEvbGluZSBcdTdCNDlcdTlBRDhcdTk4OTFcdTZENDEpXHUzMDAyXHU0RkUxXHU1QzAxXHU3NTMxXHU4QzAzXHU3NTI4XHU2NUI5XHJcbiAgICogXHU3NTI4IGVudmVsb3BlRnJvbUZyYW1lIFx1ODFFQVx1ODg0Q1x1NTIwNlx1NkQ0MTtcdTY1QURcdTdFQkZcdTkxQ0RcdThGREVcdThCRURcdTRFNDlcdTU0MEMgZXZlbnRzKClcdTMwMDJcclxuICAgKi9cclxuICBhc3luYyAqcmF3RXZlbnRzKGxhc3RFdmVudElkPzogc3RyaW5nLCBzaWduYWw/OiBBYm9ydFNpZ25hbCk6IEFzeW5jR2VuZXJhdG9yPFNzZUZyYW1lPiB7XHJcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgJHt0aGlzLmJhc2VVcmx9L2FwaS9ldmVudHNgLCB7XHJcbiAgICAgIGhlYWRlcnM6IHRoaXMuaGVhZGVycyh7XHJcbiAgICAgICAgYWNjZXB0OiAndGV4dC9ldmVudC1zdHJlYW0nLFxyXG4gICAgICAgIC4uLihsYXN0RXZlbnRJZCAhPT0gdW5kZWZpbmVkID8geyAnbGFzdC1ldmVudC1pZCc6IGxhc3RFdmVudElkIH0gOiB7fSksXHJcbiAgICAgIH0pLFxyXG4gICAgICAuLi4oc2lnbmFsICE9PSB1bmRlZmluZWQgPyB7IHNpZ25hbCB9IDoge30pLFxyXG4gICAgfSk7XHJcbiAgICBpZiAocmVzLnN0YXR1cyA9PT0gNDAxIHx8IHJlcy5zdGF0dXMgPT09IDQwMykge1xyXG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgYGhvc3QgcmVqZWN0ZWQgdGhlIHNlc3Npb24gdG9rZW4gKEhUVFAgJHtyZXMuc3RhdHVzfSlgLCB7IHJldHJ5YWJsZTogZmFsc2UsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XHJcbiAgICB9XHJcbiAgICBpZiAoIXJlcy5vayB8fCByZXMuYm9keSA9PT0gbnVsbCkge1xyXG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYFNTRSBIVFRQICR7cmVzLnN0YXR1c31gLCB7IHJldHJ5YWJsZTogdHJ1ZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHJlYWRlciA9IHJlcy5ib2R5LmdldFJlYWRlcigpO1xyXG4gICAgY29uc3QgZGVjb2RlciA9IG5ldyBUZXh0RGVjb2RlcigpO1xyXG4gICAgbGV0IGJ1ZmZlciA9ICcnO1xyXG4gICAgZm9yICg7Oykge1xyXG4gICAgICBjb25zdCB7IGRvbmUsIHZhbHVlIH0gPSBhd2FpdCByZWFkZXIucmVhZCgpO1xyXG4gICAgICBpZiAoZG9uZSkgcmV0dXJuO1xyXG4gICAgICBidWZmZXIgKz0gZGVjb2Rlci5kZWNvZGUodmFsdWUsIHsgc3RyZWFtOiB0cnVlIH0pO1xyXG4gICAgICBsZXQgaWR4OiBudW1iZXI7XHJcbiAgICAgIHdoaWxlICgoaWR4ID0gYnVmZmVyLmluZGV4T2YoJ1xcblxcbicpKSAhPT0gLTEpIHtcclxuICAgICAgICBjb25zdCBibG9jayA9IGJ1ZmZlci5zbGljZSgwLCBpZHgpO1xyXG4gICAgICAgIGJ1ZmZlciA9IGJ1ZmZlci5zbGljZShpZHggKyAyKTtcclxuICAgICAgICBmb3IgKGNvbnN0IGZyYW1lIG9mIHBhcnNlU3NlQ2h1bmsoYmxvY2spKSB5aWVsZCBmcmFtZTtcclxuICAgICAgfVxyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgLyoqXHJcbiAgICogXHU4QkEyXHU5NjA1IFNTRSBcdTRFOEJcdTRFRjZcdTZENDEoYXN5bmMgaXRlcmF0b3IpXHUzMDAyXHU2NUFEXHU3RUJGXHU3NTMxXHU4QzAzXHU3NTI4XHU2NUI5XHU5MUNEXHU4RkRFO1x1OTFDRFx1OEZERVx1NjVGNlx1NjI4QVx1NjcwMFx1NTQwRVxyXG4gICAqIFx1NjUzNlx1NTIzMFx1NzY4NCBldmVudElkIFx1NEYyMFx1NTE2NSBsYXN0RXZlbnRJZCxob3N0IFx1N0FFRlx1NEVDRVx1OTFDRFx1NjUzRVx1NzNBRlx1ODg2NVx1NTNEMVx1MzAwMlxyXG4gICAqL1xyXG4gIGFzeW5jICpldmVudHMobGFzdEV2ZW50SWQ/OiBzdHJpbmcsIHNpZ25hbD86IEFib3J0U2lnbmFsKTogQXN5bmNHZW5lcmF0b3I8RXZlbnRFbnZlbG9wZT4ge1xyXG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYCR7dGhpcy5iYXNlVXJsfS9hcGkvZXZlbnRzYCwge1xyXG4gICAgICBoZWFkZXJzOiB0aGlzLmhlYWRlcnMoe1xyXG4gICAgICAgIGFjY2VwdDogJ3RleHQvZXZlbnQtc3RyZWFtJyxcclxuICAgICAgICAuLi4obGFzdEV2ZW50SWQgIT09IHVuZGVmaW5lZCA/IHsgJ2xhc3QtZXZlbnQtaWQnOiBsYXN0RXZlbnRJZCB9IDoge30pLFxyXG4gICAgICB9KSxcclxuICAgICAgLi4uKHNpZ25hbCAhPT0gdW5kZWZpbmVkID8geyBzaWduYWwgfSA6IHt9KSxcclxuICAgIH0pO1xyXG4gICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSB8fCByZXMuc3RhdHVzID09PSA0MDMpIHtcclxuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdBVVRIX0ZBSUxFRCcsIGBob3N0IHJlamVjdGVkIHRoZSBzZXNzaW9uIHRva2VuIChIVFRQICR7cmVzLnN0YXR1c30pYCwgeyByZXRyeWFibGU6IGZhbHNlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xyXG4gICAgfVxyXG4gICAgaWYgKCFyZXMub2sgfHwgIXJlcy5ib2R5KSB7XHJcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgU1NFIEhUVFAgJHtyZXMuc3RhdHVzfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgcmVhZGVyID0gcmVzLmJvZHkuZ2V0UmVhZGVyKCk7XHJcbiAgICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKCk7XHJcbiAgICBsZXQgYnVmZmVyID0gJyc7XHJcbiAgICBmb3IgKDs7KSB7XHJcbiAgICAgIGNvbnN0IHsgZG9uZSwgdmFsdWUgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XHJcbiAgICAgIGlmIChkb25lKSByZXR1cm47XHJcbiAgICAgIGJ1ZmZlciArPSBkZWNvZGVyLmRlY29kZSh2YWx1ZSwgeyBzdHJlYW06IHRydWUgfSk7XHJcbiAgICAgIC8vIFx1NEVFNVx1N0E3QVx1ODg0Q1x1NTIwNlx1NUUyNztcdTRGRERcdTc1NTlcdTRFMERcdTVCOENcdTY1NzRcdTc2ODRcdTVDM0VcdTkwRThcclxuICAgICAgbGV0IGlkeDogbnVtYmVyO1xyXG4gICAgICB3aGlsZSAoKGlkeCA9IGJ1ZmZlci5pbmRleE9mKCdcXG5cXG4nKSkgIT09IC0xKSB7XHJcbiAgICAgICAgY29uc3QgYmxvY2sgPSBidWZmZXIuc2xpY2UoMCwgaWR4KTtcclxuICAgICAgICBidWZmZXIgPSBidWZmZXIuc2xpY2UoaWR4ICsgMik7XHJcbiAgICAgICAgZm9yIChjb25zdCBmcmFtZSBvZiBwYXJzZVNzZUNodW5rKGJsb2NrKSkge1xyXG4gICAgICAgICAgY29uc3QgZW52ID0gZW52ZWxvcGVGcm9tRnJhbWUoZnJhbWUpO1xyXG4gICAgICAgICAgaWYgKGVudiAhPT0gbnVsbCkgeWllbGQgZW52O1xyXG4gICAgICAgIH1cclxuICAgICAgfVxyXG4gICAgfVxyXG4gIH1cclxufVxyXG4iLCAiLyoqXHJcbiAqIGZha2UgaG9zdCBcdTIwMTQgaG1oYXJuZXNzIHJ1bnRpbWUgXHU3Njg0XHU2RDRCXHU4QkQ1XHU2NkZGXHU4RUFCKE1hc3RlclByb21wdCBcdTk2MzZcdTZCQjUgRC9FOlxyXG4gKiBcIlx1NTE0OFx1NEY3Rlx1NzUyOCBmYWtlIGhvc3QgXHU3RjE2XHU1MTk5XHU3MkI2XHU2MDAxXHU2NzNBXHU2RDRCXHU4QkQ1LFx1NTE4RFx1NjNBNVx1NzcxRlx1NUI5RSBBUElcIjtcdTk2MzZcdTZCQjUgRSBcdTc2ODRcdTRGMUFcdThCRERcdTdFQjVcdTUyMDdcdTcyNDdcclxuICogZTJlIFx1NEU1Rlx1NTE0OFx1NTcyOCBmYWtlIFx1NUM0Mlx1OTVFRFx1NzNBRilcdTMwMDJcclxuICpcclxuICogXHU2ODRDXHU5NzYyIGhvc3QgXHU1NDA4XHU1NDBDOlxyXG4gKiAgLSBcdTUzRUFcdTdFRDEgMTI3LjAuMC4xLFx1N0FFRlx1NTNFMyBPUyBcdTUyMDZcdTkxNEQsXHU1QjlFXHU5NjQ1XHU3QUVGXHU1M0UzXHU1MTk5IHN0ZG91dCBcdTVGMTVcdTVCRkNcdTg4NEM7XHJcbiAqICAtIFx1NjI0MFx1NjcwOSAvYXBpLyogXHU4OTgxXHU2QzQyIFgtSG1oLUtleSA9PT0gSE1IX0RFU0tUT1BfVE9LRU4sXHU1NDI2XHU1MjE5IDQwMSArIERlc2t0b3BFcnJvcjtcclxuICogIC0gR0VUIC9hcGkvc3RhdGUgXHU1MDY1XHU1RUI3XHU2M0EyXHU2RDRCO0dFVCAvYXBpL2V2ZW50cyBTU0UoZXZlbnQ6IGhtaCBcdTRGRTFcdTVDMDFcdTZENDEgKyBcdTkxQ0RcdTY1M0VcdTczQUYpO1xyXG4gKiAgLSBQT1NUIC9hcGkvZGVza3RvcC9zaHV0ZG93biBcdTRGMThcdTk2QzVcdTkwMDBcdTUxRkFcdTMwMDJcclxuICpcclxuICogXHU5NjM2XHU2QkI1IEUgXHU2QTIxXHU2MkRGXHU5NzYyKFx1NEUwRSBobWhhcm5lc3MgZGVza3RvcCBcdTZBMjFcdTVGMEZcdTU0MENcdTVGNjIpOlxyXG4gKiAgLSBQT1NUIC9hcGkvdGFzayB7dGV4dCwgc2Vzc2lvbklkLCBtb2RlfTpcdTYzOTJcdTk2MUZcdTVFNzZcdTYzMDlcdTgxMUFcdTY3MkNcdTUzRDFcclxuICogICAgcnVuLnN0YXJ0ZWQgXHUyMTkyIHRvb2wuc3RhcnRlZC9jb21wbGV0ZWQgXHUyMTkyKG1vZGU9PT0nYXNrJyBcdTY1RjYpXHJcbiAqICAgIGFwcHJvdmFsLnJlcXVpcmVkKFx1N0I0OSAvYXBpL2FwcHJvdmUpXHUyMTkyIHJ1bi5jb21wbGV0ZWQ7XHJcbiAqICAtIFBPU1QgL2FwaS9hcHByb3ZlIHtncmFudGVkLCBzZXNzaW9uSWR9O1xyXG4gKiAgLSBQT1NUIC9hcGkvaW50ZXJydXB0IHtzZXNzaW9uSWR9O1xyXG4gKiAgLSBHRVQgL2FwaS9zZXNzaW9uc1x1MzAwMlxyXG4gKlxyXG4gKiBcdTZENEJcdThCRDVcdTk0QTlcdTVCNTA6RkFLRV9IT1NUX0RJRV9BRlRFUl9NUyAvIEZBS0VfSE9TVF9ESUVfQVRfQk9PVCAvXHJcbiAqIEZBS0VfSE9TVF9FWFBFQ1RfVE9LRU4gLyBGQUtFX0hPU1RfVEFTS19ERUxBWV9NUyAvIEZBS0VfSE9TVF9UQVNLX0ZBSUw9MVxyXG4gKiAoXHU0RUZCXHU1MkExXHU0RUU1IHJ1bi5mYWlsZWQgXHU3RUQzXHU2NzVGLFx1Njc4NFx1OTAyMFx1OTUxOVx1OEJFRlx1NjA2Mlx1NTkwRFx1NTczQVx1NjY2RilcdTMwMDJcclxuICovXHJcbmltcG9ydCB7IGNyZWF0ZVNlcnZlciwgdHlwZSBTZXJ2ZXJSZXNwb25zZSB9IGZyb20gJ25vZGU6aHR0cCc7XHJcbmltcG9ydCB7IHJhbmRvbVVVSUQgfSBmcm9tICdub2RlOmNyeXB0byc7XHJcbmltcG9ydCB7IHBhdGhUb0ZpbGVVUkwgfSBmcm9tICdub2RlOnVybCc7XHJcbmltcG9ydCB7IHJlYWxwYXRoU3luYyB9IGZyb20gJ25vZGU6ZnMnO1xyXG5pbXBvcnQgeyBFVkVOVF9TQ0hFTUFfVkVSU0lPTiwgZGVza3RvcEVycm9yLCB0eXBlIEV2ZW50RW52ZWxvcGUsIHR5cGUgRXZlbnRLaW5kIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyc7XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIEZha2VIb3N0SGFuZGxlIHtcclxuICBwb3J0OiBudW1iZXI7XHJcbiAgZW1pdChzZXNzaW9uSWQ6IHN0cmluZywgcnVuSWQ6IHN0cmluZywga2luZDogRXZlbnRLaW5kLCBwYXlsb2FkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IG51bWJlcjtcclxuICBjbG9zZSgpOiBQcm9taXNlPHZvaWQ+O1xyXG59XHJcblxyXG5pbnRlcmZhY2UgRmFrZVNlc3Npb24ge1xyXG4gIGlkOiBzdHJpbmc7XHJcbiAgY3JlYXRlZEF0OiBzdHJpbmc7XHJcbiAgdXBkYXRlZEF0OiBzdHJpbmc7XHJcbn1cclxuXHJcbmludGVyZmFjZSBQZW5kaW5nQXBwcm92YWwge1xyXG4gIHNlc3Npb25JZDogc3RyaW5nO1xyXG4gIGFwcHJvdmFsSWQ6IHN0cmluZztcclxuICByZXNvbHZlKGdyYW50ZWQ6IGJvb2xlYW4pOiB2b2lkO1xyXG59XHJcblxyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc3RhcnRGYWtlSG9zdChvcHRzOiB7IHRva2VuOiBzdHJpbmc7IHF1aWV0PzogYm9vbGVhbiB9KTogUHJvbWlzZTxGYWtlSG9zdEhhbmRsZT4ge1xyXG4gIGNvbnN0IHRva2VuID0gb3B0cy50b2tlbjtcclxuICAvLyBcdTZENEJcdThCRDVcdTk0QTlcdTVCNTA6RkFLRV9IT1NUX0VYUEVDVF9UT0tFTiBcdThCQTkgaG9zdCBcdTY4MjFcdTlBOENcdTRFMDBcdTRFMkFcdTRFMEUgSE1IX0RFU0tUT1BfVE9LRU5cclxuICAvLyBcdTRFMERcdTU0MENcdTc2ODRcdTUwM0MoXHU2Nzg0XHU5MDIwIEFVVEhfRkFJTEVEIFx1NTczQVx1NjY2RjtzdXBlcnZpc29yIFx1NjAzQlx1NjYyRlx1ODk4Nlx1NzZENiBITUhfREVTS1RPUF9UT0tFTilcclxuICBjb25zdCBleHBlY3RlZCA9IHByb2Nlc3MuZW52LkZBS0VfSE9TVF9FWFBFQ1RfVE9LRU4gPz8gdG9rZW47XHJcbiAgY29uc3QgdGFza0RlbGF5ID0gTnVtYmVyKHByb2Nlc3MuZW52LkZBS0VfSE9TVF9UQVNLX0RFTEFZX01TID8/IDMwKTtcclxuICBjb25zdCBmYWlsVGFza3MgPSBwcm9jZXNzLmVudi5GQUtFX0hPU1RfVEFTS19GQUlMID09PSAnMSc7XHJcblxyXG4gIGNvbnN0IHNzZUNsaWVudHMgPSBuZXcgU2V0PFNlcnZlclJlc3BvbnNlPigpO1xyXG4gIGNvbnN0IHNlcUJ5UnVuID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcclxuICAvLyBcdTkxQ0RcdTY1M0VcdTczQUY6XHU2NzAwXHU4RkQxIDIwMCBcdTVFMjcoTGFzdC1FdmVudC1JRCBcdTY1QURcdTdFQkZcdTg4NjVcdTYyQzkpLFx1NEUwRSBobWhhcm5lc3Mgd2ViIFx1NTQwQ1x1NkIzRVx1OEJFRFx1NEU0OVxyXG4gIGNvbnN0IHJpbmc6IEFycmF5PHsgaWQ6IG51bWJlcjsgZXZlbnQ6IHN0cmluZzsgZGF0YTogdW5rbm93biB9PiA9IFtdO1xyXG4gIGxldCByaW5nU2VxID0gMDtcclxuICBjb25zdCBzZXNzaW9ucyA9IG5ldyBNYXA8c3RyaW5nLCBGYWtlU2Vzc2lvbj4oKTtcclxuICBsZXQgcGVuZGluZzogUGVuZGluZ0FwcHJvdmFsIHwgbnVsbCA9IG51bGw7XHJcbiAgY29uc3QgcnVuVGltZXJzID0gbmV3IE1hcDxzdHJpbmcsIE5vZGVKUy5UaW1lb3V0PigpO1xyXG4gIC8vIFx1NURFNVx1NEY1Q1x1NTMzQS9Qcm92aWRlciBcdTcyQjZcdTYwMDEoXHU0RTBFIGhtaGFybmVzcyBcdTU0MENcdTVGNjJcdTc2ODRcdTY3MDBcdTVDMEZcdTZBMjFcdTYyREYpXHJcbiAgY29uc3QgZmFrZVdvcmtzcGFjZXMgPSB7XHJcbiAgICBjdXJyZW50OiAnd3MtZGVtbycsXHJcbiAgICBpdGVtczogW1xyXG4gICAgICB7IGlkOiAnd3MtZGVtbycsIG5hbWU6ICdkZW1vLXdvcmtzcGFjZScsIHBhdGg6ICdDOlxcXFxkZW1vJyB9LFxyXG4gICAgXSxcclxuICB9O1xyXG4gIGNvbnN0IGZha2VQcm92aWRlcnMgPSBuZXcgTWFwPHN0cmluZywgeyBiYXNlVXJsOiBzdHJpbmc7IG1vZGVsOiBzdHJpbmc7IGFwaUtleTogc3RyaW5nIH0+KFtcclxuICAgIFsnZGVtbycsIHsgYmFzZVVybDogJ2h0dHA6Ly8xMjcuMC4wLjE6OS92MScsIG1vZGVsOiAnZmFrZS1tJywgYXBpS2V5OiAnc2stZGVtby0xMjM0JyB9XSxcclxuICAgIFsnZGVtby12aXNpb24nLCB7IGJhc2VVcmw6ICdodHRwOi8vMTI3LjAuMC4xOjkvdjEnLCBtb2RlbDogJ2Zha2UtbS12aXNpb24nLCBhcGlLZXk6ICdzay1kZW1vLTU2NzgnIH1dLFxyXG4gIF0pO1xyXG4gIGxldCBmYWtlQ2hhdFByb3ZpZGVyID0gJ2RlbW8nO1xyXG5cclxuICBjb25zdCBlbWl0ID0gKHNlc3Npb25JZDogc3RyaW5nLCBydW5JZDogc3RyaW5nLCBraW5kOiBFdmVudEtpbmQsIHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogbnVtYmVyID0+IHtcclxuICAgIGNvbnN0IGtleSA9IGAke3Nlc3Npb25JZH1cXDAke3J1bklkfWA7XHJcbiAgICBjb25zdCBzZXEgPSAoc2VxQnlSdW4uZ2V0KGtleSkgPz8gMCkgKyAxO1xyXG4gICAgc2VxQnlSdW4uc2V0KGtleSwgc2VxKTtcclxuICAgIGNvbnN0IGVudjogRXZlbnRFbnZlbG9wZSA9IHtcclxuICAgICAgc2NoZW1hVmVyc2lvbjogRVZFTlRfU0NIRU1BX1ZFUlNJT04sXHJcbiAgICAgIGV2ZW50SWQ6IHJhbmRvbVVVSUQoKSxcclxuICAgICAgc2Vzc2lvbklkLFxyXG4gICAgICBydW5JZCxcclxuICAgICAgc2VxLFxyXG4gICAgICBvY2N1cnJlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXHJcbiAgICAgIGtpbmQsXHJcbiAgICAgIHBheWxvYWQsXHJcbiAgICB9O1xyXG4gICAgY29uc3QgaWQgPSArK3JpbmdTZXE7XHJcbiAgICByaW5nLnB1c2goeyBpZCwgZXZlbnQ6ICdobWgnLCBkYXRhOiBlbnYgfSk7XHJcbiAgICBpZiAocmluZy5sZW5ndGggPiAyMDApIHJpbmcuc3BsaWNlKDAsIHJpbmcubGVuZ3RoIC0gMjAwKTtcclxuICAgIGZvciAoY29uc3QgYyBvZiBzc2VDbGllbnRzKSB7XHJcbiAgICAgIGMud3JpdGUoYGlkOiAke2lkfVxcbmV2ZW50OiBobWhcXG5kYXRhOiAke0pTT04uc3RyaW5naWZ5KGVudil9XFxuXFxuYCk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gc2VxO1xyXG4gIH07XHJcblxyXG4gIGNvbnN0IHRvdWNoID0gKHNlc3Npb25JZDogc3RyaW5nKTogRmFrZVNlc3Npb24gPT4ge1xyXG4gICAgbGV0IHMgPSBzZXNzaW9ucy5nZXQoc2Vzc2lvbklkKTtcclxuICAgIGlmIChzID09PSB1bmRlZmluZWQpIHtcclxuICAgICAgcyA9IHsgaWQ6IHNlc3Npb25JZCwgY3JlYXRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksIHVwZGF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpIH07XHJcbiAgICAgIHNlc3Npb25zLnNldChzZXNzaW9uSWQsIHMpO1xyXG4gICAgfVxyXG4gICAgcy51cGRhdGVkQXQgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XHJcbiAgICByZXR1cm4gcztcclxuICB9O1xyXG5cclxuICAvKiogXHU2QTIxXHU2MkRGXHU0RTAwXHU2QjIxXHU0RUZCXHU1MkExOlx1NjI3OVx1NTFDNlx1NkEyMVx1NUYwRlx1NjMwMlx1OEQ3N1x1N0I0OVx1NUY4NSAvYXBpL2FwcHJvdmVcdTMwMDIgKi9cclxuICBjb25zdCBydW5UYXNrID0gKHNlc3Npb25JZDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcsIG1vZGU6IHN0cmluZyk6IHN0cmluZyA9PiB7XHJcbiAgICBjb25zdCBydW5JZCA9IGBydW4tJHtEYXRlLm5vdygpLnRvU3RyaW5nKDM2KX0tJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCA4KX1gO1xyXG4gICAgdG91Y2goc2Vzc2lvbklkKTtcclxuICAgIGNvbnN0IHN0ZXBzOiBBcnJheTwoKSA9PiB2b2lkPiA9IFtdO1xyXG4gICAgY29uc3Qgd2FpdCA9IChmbjogKCkgPT4gdm9pZCwgbXMgPSB0YXNrRGVsYXkpOiB2b2lkID0+IHtcclxuICAgICAgY29uc3QgdCA9IHNldFRpbWVvdXQoZm4sIG1zKTtcclxuICAgICAgcnVuVGltZXJzLnNldChgJHtzZXNzaW9uSWR9XFwwJHtydW5JZH1gLCB0KTtcclxuICAgIH07XHJcbiAgICBjb25zdCBjaGFpbiA9IChmbnM6IEFycmF5PCgpID0+IHZvaWQ+KTogdm9pZCA9PiB7XHJcbiAgICAgIGNvbnN0IFtmaXJzdCwgLi4ucmVzdF0gPSBmbnM7XHJcbiAgICAgIGlmIChmaXJzdCA9PT0gdW5kZWZpbmVkKSByZXR1cm47XHJcbiAgICAgIHdhaXQoKCkgPT4ge1xyXG4gICAgICAgIGZpcnN0KCk7XHJcbiAgICAgICAgY2hhaW4ocmVzdCk7XHJcbiAgICAgIH0pO1xyXG4gICAgfTtcclxuXHJcbiAgICBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICdydW4uc3RhcnRlZCcsIHsgdGFzazogdGV4dCwgbW9kZSB9KTtcclxuICAgIGlmIChmYWlsVGFza3MpIHtcclxuICAgICAgd2FpdCgoKSA9PiBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICdydW4uZmFpbGVkJywge1xyXG4gICAgICAgIGVycm9yOiB7IGNvZGU6ICdBVVRIX0ZBSUxFRCcsIG1lc3NhZ2U6ICdzaW11bGF0ZWQgcHJvdmlkZXIgYXV0aCBmYWlsdXJlJywgcmV0cnlhYmxlOiBmYWxzZSB9LFxyXG4gICAgICB9KSk7XHJcbiAgICAgIHJldHVybiBydW5JZDtcclxuICAgIH1cclxuXHJcbiAgICBjb25zdCBmaW5pc2hSdW4gPSAoYW5zd2VyOiBzdHJpbmcsIHRvb2xVc2VzOiBudW1iZXIpOiB2b2lkID0+IHtcclxuICAgICAgcnVuVGltZXJzLmRlbGV0ZShgJHtzZXNzaW9uSWR9XFwwJHtydW5JZH1gKTtcclxuICAgICAgLy8gXHU0RUE0XHU0RUQ4XHU3MjY5XHU1MTQ4XHU0RThFXHU3RUM4XHU2MDAxKFx1NEUwRSBobWhhcm5lc3MgZGVza3RvcCBcdTY4NjVcdTU0MENcdTVFOEY6YXJ0aWZhY3QuY3JlYXRlZCBcdTIxOTIgcnVuLmNvbXBsZXRlZClcclxuICAgICAgZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAnYXJ0aWZhY3QuY3JlYXRlZCcsIHtcclxuICAgICAgICBhcnRpZmFjdDogeyByZWxQYXRoOiAnb3V0LnR4dCcsIGtpbmQ6ICdmaWxlJywgdGl0bGU6ICdvdXQudHh0JyB9LFxyXG4gICAgICB9KTtcclxuICAgICAgZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAncnVuLmNvbXBsZXRlZCcsIHsgdGV4dDogYW5zd2VyLCB0dXJuczogMSwgdG9vbFVzZXMgfSk7XHJcbiAgICB9O1xyXG5cclxuICAgIGNvbnN0IHNjcmlwdGVkOiBBcnJheTwoKSA9PiB2b2lkPiA9IFtcclxuICAgICAgKCkgPT4gZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAndG9vbC5zdGFydGVkJywgeyBuYW1lOiAncmVhZF9maWxlJywgYXJnc1ByZXZpZXc6ICd7XCJwYXRoXCI6XCJSRUFETUUubWRcIn0nIH0pLFxyXG4gICAgICAoKSA9PiBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICd0b29sLmNvbXBsZXRlZCcsIHsgbmFtZTogJ3JlYWRfZmlsZScsIGlzRXJyb3I6IGZhbHNlLCBvdXRwdXRQcmV2aWV3OiAnIyBkZW1vJyB9KSxcclxuICAgIF07XHJcblxyXG4gICAgaWYgKG1vZGUgPT09ICdhc2snKSB7XHJcbiAgICAgIHNjcmlwdGVkLnB1c2goKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IGFwcHJvdmFsSWQgPSBgYXAtJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCA4KX1gO1xyXG4gICAgICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ2FwcHJvdmFsLnJlcXVpcmVkJywge1xyXG4gICAgICAgICAgYXBwcm92YWxJZCxcclxuICAgICAgICAgIHRvb2w6ICd3cml0ZV9maWxlJyxcclxuICAgICAgICAgIGFyZ3NQcmV2aWV3OiAne1wicGF0aFwiOlwib3V0LnR4dFwiLFwiY29udGVudFwiOlwiaGlcIn0nLFxyXG4gICAgICAgICAgcmlzazogJ1x1NTE5OVx1NTE2NVx1NURFNVx1NEY1Q1x1NTMzQVx1NjU4N1x1NEVGNiBvdXQudHh0KFx1NkEyMVx1NjJERiknLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHBlbmRpbmcgPSB7XHJcbiAgICAgICAgICBzZXNzaW9uSWQsXHJcbiAgICAgICAgICBhcHByb3ZhbElkLFxyXG4gICAgICAgICAgcmVzb2x2ZTogKGdyYW50ZWQpID0+IHtcclxuICAgICAgICAgICAgcGVuZGluZyA9IG51bGw7XHJcbiAgICAgICAgICAgIGlmIChncmFudGVkKSB7XHJcbiAgICAgICAgICAgICAgZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAndG9vbC5zdGFydGVkJywgeyBuYW1lOiAnd3JpdGVfZmlsZScsIGFyZ3NQcmV2aWV3OiAne1wicGF0aFwiOlwib3V0LnR4dFwifScgfSk7XHJcbiAgICAgICAgICAgICAgd2FpdCgoKSA9PiBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICd0b29sLmNvbXBsZXRlZCcsIHsgbmFtZTogJ3dyaXRlX2ZpbGUnLCBpc0Vycm9yOiBmYWxzZSwgb3V0cHV0UHJldmlldzogJ3dyb3RlIDIgYnl0ZXMnIH0pKTtcclxuICAgICAgICAgICAgICB3YWl0KCgpID0+IGZpbmlzaFJ1bihgZWNobzogJHt0ZXh0fShcdTVERjJcdTYyNjdcdTg4NENcdTUxOTlcdTUxNjUpYCwgMyksIHRhc2tEZWxheSAqIDIpO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgIGZpbmlzaFJ1bihgZWNobzogJHt0ZXh0fShcdTVCQTFcdTYyNzlcdTg4QUJcdTYyRDJcdTdFREQsXHU2NzJBXHU2MjY3XHU4ODRDXHU1MTk5XHU1MTY1KWAsIDEpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICB9LFxyXG4gICAgICAgIH07XHJcbiAgICAgIH0pO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgc2NyaXB0ZWQucHVzaCgoKSA9PiBmaW5pc2hSdW4oYGVjaG86ICR7dGV4dH1gLCAxKSk7XHJcbiAgICB9XHJcbiAgICBjaGFpbihzY3JpcHRlZCk7XHJcbiAgICByZXR1cm4gcnVuSWQ7XHJcbiAgfTtcclxuXHJcbiAgY29uc3Qgc2VydmVyID0gY3JlYXRlU2VydmVyKChyZXEsIHJlcykgPT4ge1xyXG4gICAgY29uc3QgdXJsID0gbmV3IFVSTChyZXEudXJsID8/ICcvJywgJ2h0dHA6Ly8xMjcuMC4wLjEnKTtcclxuICAgIGNvbnN0IGF1dGhvcml6ZWQgPSByZXEuaGVhZGVyc1sneC1obWgta2V5J10gPT09IGV4cGVjdGVkO1xyXG4gICAgY29uc3QgZGVueSA9ICgpOiB2b2lkID0+IHtcclxuICAgICAgcmVzLndyaXRlSGVhZCg0MDEsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgJ21pc3Npbmcgb3IgaW52YWxpZCB4LWhtaC1rZXknLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcclxuICAgIH07XHJcblxyXG4gICAgY29uc3QgcmVhZEJvZHkgPSAoKTogUHJvbWlzZTxzdHJpbmc+ID0+XHJcbiAgICAgIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XHJcbiAgICAgICAgbGV0IGIgPSAnJztcclxuICAgICAgICByZXEub24oJ2RhdGEnLCAoYzogQnVmZmVyKSA9PiB7IGIgKz0gYy50b1N0cmluZygpOyB9KTtcclxuICAgICAgICByZXEub24oJ2VuZCcsICgpID0+IHJlc29sdmUoYikpO1xyXG4gICAgICB9KTtcclxuXHJcbiAgICBpZiAodXJsLnBhdGhuYW1lID09PSAnL2FwaS9ldmVudHMnKSB7XHJcbiAgICAgIGlmICghYXV0aG9yaXplZCkgeyBkZW55KCk7IHJldHVybjsgfVxyXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ3RleHQvZXZlbnQtc3RyZWFtJywgJ2NhY2hlLWNvbnRyb2wnOiAnbm8tY2FjaGUnLCBjb25uZWN0aW9uOiAna2VlcC1hbGl2ZScgfSk7XHJcbiAgICAgIHJlcy5mbHVzaEhlYWRlcnM/LigpO1xyXG4gICAgICBzc2VDbGllbnRzLmFkZChyZXMpO1xyXG4gICAgICAvLyBcdTY1QURcdTdFQkZcdTg4NjVcdTYyQzk6TGFzdC1FdmVudC1JRCBcdTRFNEJcdTUyNERcdTc2ODRcdTVFMjdcdTVERjJcdTU3MjhcdTVCQTJcdTYyMzdcdTdBRUYsXHU5MUNEXHU1M0QxXHU1MTc2XHU1NDBFXHU3Njg0XHU3M0FGXHU1RjYyXHU3RjEzXHU1MUIyXHJcbiAgICAgIGNvbnN0IGxhc3RJZCA9IE51bWJlcihyZXEuaGVhZGVyc1snbGFzdC1ldmVudC1pZCddID8/IDApO1xyXG4gICAgICBpZiAoTnVtYmVyLmlzRmluaXRlKGxhc3RJZCkgJiYgbGFzdElkID4gMCkge1xyXG4gICAgICAgIGZvciAoY29uc3QgZSBvZiByaW5nKSB7XHJcbiAgICAgICAgICBpZiAoZS5pZCA+IGxhc3RJZCkgcmVzLndyaXRlKGBpZDogJHtlLmlkfVxcbmV2ZW50OiAke2UuZXZlbnR9XFxuZGF0YTogJHtKU09OLnN0cmluZ2lmeShlLmRhdGEpfVxcblxcbmApO1xyXG4gICAgICAgIH1cclxuICAgICAgfVxyXG4gICAgICByZXEub24oJ2Nsb3NlJywgKCkgPT4gc3NlQ2xpZW50cy5kZWxldGUocmVzKSk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmICghYXV0aG9yaXplZCkgeyBkZW55KCk7IHJldHVybjsgfVxyXG5cclxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3N0YXRlJykge1xyXG4gICAgICAvLyBwcm92aWRlcnNEZXRhaWw6XHU0RTBFIGhtaGFybmVzcyBcdTU0MENcdTVGNjJcdTIwMTRcdTIwMTRrZXkgXHU1M0VBXHU1MUZBIGhhc0tleS9cdTY3MkJcdTU2REJcdTRGNEQsXHU2QzM4XHU0RTBEXHU2NjBFXHU2NTg3XHJcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xyXG4gICAgICAgIGRhZW1vblZlcnNpb246ICdmYWtlLTAuMC4wJywgZGVza3RvcDogdHJ1ZSwgbW9kZWw6IGZha2VQcm92aWRlcnMuZ2V0KGZha2VDaGF0UHJvdmlkZXIpPy5tb2RlbCA/PyAnZmFrZS1tb2RlbCcsXHJcbiAgICAgICAgY2hhdFByb3ZpZGVyOiBmYWtlQ2hhdFByb3ZpZGVyLCBsb2NhbGU6ICd6aCcsXHJcbiAgICAgICAgYnVzeVNlc3Npb25zOiBbLi4uc2Vzc2lvbnMua2V5cygpXS5zbGljZSgwLCAyKSxcclxuICAgICAgICBhcHByb3ZhbFBlbmRpbmc6IHBlbmRpbmcgIT09IG51bGwsXHJcbiAgICAgICAgc2V0dGluZ3M6IHsgYXBwcm92YWw6ICdhc2snIH0sXHJcbiAgICAgICAgd29ya3NwYWNlOiBmYWtlV29ya3NwYWNlcy5pdGVtcy5maW5kKCh3KSA9PiB3LmlkID09PSBmYWtlV29ya3NwYWNlcy5jdXJyZW50KSA/PyBudWxsLFxyXG4gICAgICAgIHByb3ZpZGVyc0RldGFpbDogWy4uLmZha2VQcm92aWRlcnMuZW50cmllcygpXS5tYXAoKFtuYW1lLCBwXSkgPT4gKHtcclxuICAgICAgICAgIG5hbWUsIG1vZGVsOiBwLm1vZGVsLCBiYXNlVXJsOiBwLmJhc2VVcmwsXHJcbiAgICAgICAgICBoYXNLZXk6IHAuYXBpS2V5ICE9PSAnJyxcclxuICAgICAgICAgIGtleVRhaWw6IHAuYXBpS2V5Lmxlbmd0aCA+PSA0ID8gcC5hcGlLZXkuc2xpY2UoLTQpIDogdW5kZWZpbmVkLFxyXG4gICAgICAgICAgcHVycG9zZXM6IFsnY2hhdCddLFxyXG4gICAgICAgIH0pKSxcclxuICAgICAgfSkpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZGVza3RvcC9zaHV0ZG93bicpIHtcclxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlIH0pKTtcclxuICAgICAgc2VydmVyLmNsb3NlKCgpID0+IHByb2Nlc3MuZXhpdCgwKSk7XHJcbiAgICAgIHNldFRpbWVvdXQoKCkgPT4gcHJvY2Vzcy5leGl0KDApLCAxXzAwMCkudW5yZWYoKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2Zha2UvZGllJykge1xyXG4gICAgICAvLyBcdTZENEJcdThCRDVcdTk0QTlcdTVCNTA6XHU2QTIxXHU2MkRGIGhvc3QgXHU1RDI5XHU2RTgzKFx1NTE0OFx1NUU5NFx1N0I1NFx1NTE4RFx1OTAwMFx1NTFGQSxcdTRGRERcdThCQzFcdTU0Q0RcdTVFOTRcdTVERjJcdTUzRDFcdTUxRkEpXHJcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSB9KSk7XHJcbiAgICAgIHNldFRpbWVvdXQoKCkgPT4gcHJvY2Vzcy5leGl0KDEpLCA1MCk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9tb2RlbCcpIHtcclxuICAgICAgLy8gXHU2QTIxXHU1NzhCXHU1MjA3XHU2MzYyKFx1NEUwRSBobWhhcm5lc3MgL2FwaS9tb2RlbCBcdTU0MENcdTVGNjI6XHU1MjA3IGNoYXQgXHU4REVGXHU3NTMxKVxyXG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoKGF3YWl0IHJlYWRCb2R5KCkpIHx8ICd7fScpIGFzIHsgbmFtZT86IHVua25vd24gfTtcclxuICAgICAgICBjb25zdCBuYW1lID0gdHlwZW9mIGJvZHkubmFtZSA9PT0gJ3N0cmluZycgPyBib2R5Lm5hbWUudHJpbSgpIDogJyc7XHJcbiAgICAgICAgaWYgKCFmYWtlUHJvdmlkZXJzLmhhcyhuYW1lKSkge1xyXG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAncHJvdmlkZXIgbm90IGZvdW5kJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XHJcbiAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGZha2VDaGF0UHJvdmlkZXIgPSBuYW1lO1xyXG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlLCBtb2RlbDogZmFrZVByb3ZpZGVycy5nZXQobmFtZSk/Lm1vZGVsIH0pKTtcclxuICAgICAgfSkoKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3Rhc2snKSB7XHJcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoKGF3YWl0IHJlYWRCb2R5KCkpIHx8ICd7fScpIGFzIHsgdGV4dD86IHVua25vd247IHNlc3Npb25JZD86IHVua25vd247IG1vZGU/OiB1bmtub3duOyBhdHRhY2htZW50cz86IHVua25vd247IGltYWdlcz86IHVua25vd24gfTtcclxuICAgICAgICAgIGNvbnN0IHRleHQgPSB0eXBlb2YgYm9keS50ZXh0ID09PSAnc3RyaW5nJyA/IGJvZHkudGV4dCA6ICcnO1xyXG4gICAgICAgICAgY29uc3Qgc2Vzc2lvbklkID0gdHlwZW9mIGJvZHkuc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IGJvZHkuc2Vzc2lvbklkIDogYHdlYi0ke0RhdGUubm93KCkudG9TdHJpbmcoMzYpfWA7XHJcbiAgICAgICAgICBjb25zdCBtb2RlID0gYm9keS5tb2RlID09PSAnYXNrJyB8fCBib2R5Lm1vZGUgPT09ICdhdXRvJyB8fCBib2R5Lm1vZGUgPT09ICd5b2xvJyA/IGJvZHkubW9kZSA6ICdhc2snO1xyXG4gICAgICAgICAgY29uc3QgYXR0YWNobWVudHMgPSBBcnJheS5pc0FycmF5KGJvZHkuYXR0YWNobWVudHMpID8gYm9keS5hdHRhY2htZW50cy5maWx0ZXIoKGEpOiBhIGlzIHN0cmluZyA9PiB0eXBlb2YgYSA9PT0gJ3N0cmluZycpIDogW107XHJcbiAgICAgICAgICAvLyBcdTU2RkVcdTcyNDdcdTk2NDRcdTRFRjY6XHU0RTBFIGhtaGFybmVzcyB2aXNpb24gXHU1MzRGXHU4QkFFXHU1NDBDXHU1RjYyKHtuYW1lLGRhdGFVcmx9KTtmYWtlIFx1NjgyMVx1OUE4Q1x1NUY2Mlx1NzJCNlx1NTM3M1x1NjUzNlxyXG4gICAgICAgICAgY29uc3QgaW1hZ2VzID0gQXJyYXkuaXNBcnJheShib2R5LmltYWdlcylcclxuICAgICAgICAgICAgPyBib2R5LmltYWdlcy5maWx0ZXIoKGltKTogaW0gaXMgeyBuYW1lOiBzdHJpbmc7IGRhdGFVcmw6IHN0cmluZyB9ID0+IHtcclxuICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgaW0gIT09ICdvYmplY3QnIHx8IGltID09PSBudWxsKSByZXR1cm4gZmFsc2U7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBvID0gaW0gYXMgeyBuYW1lPzogdW5rbm93bjsgZGF0YVVybD86IHVua25vd24gfTtcclxuICAgICAgICAgICAgICAgIHJldHVybiB0eXBlb2Ygby5uYW1lID09PSAnc3RyaW5nJyAmJiB0eXBlb2Ygby5kYXRhVXJsID09PSAnc3RyaW5nJyAmJiBvLmRhdGFVcmwuc3RhcnRzV2l0aCgnZGF0YTppbWFnZS8nKTtcclxuICAgICAgICAgICAgICB9KVxyXG4gICAgICAgICAgICA6IFtdO1xyXG4gICAgICAgICAgaWYgKCF0ZXh0KSB7XHJcbiAgICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAndGV4dCByZXF1aXJlZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgICAvLyBcdTRFMEUgaG1oYXJuZXNzIFx1NTQwQ1x1OEJFRFx1NEU0OTpcdTU0MDhcdTZDRDVcdTk2NDRcdTRFRjZcdTRFRTUgW3JlZmVyZW5jZWQgZmlsZXNdIFx1NTI0RFx1N0YwMFx1NUU3Nlx1NTE2NVx1NEVGQlx1NTJBMVx1NjU4N1x1NjcyQztcclxuICAgICAgICAgIC8vIFx1NTZGRVx1NzI0N1x1NEVFNSBbaW1hZ2VzXSBcdTUyNERcdTdGMDBcdTY4MDdcdTZDRThcdTVGMjBcdTY1NzAodmlzaW9uIFx1NjNDRlx1OEZGMFx1OTRGRVx1NTcyOFx1NzcxRlx1NUI5RSBydW50aW1lIFx1OTFDQ1x1NTNEMVx1NzUxRilcclxuICAgICAgICAgIGNvbnN0IGNvbXBvc2VkID0gYXR0YWNobWVudHMubGVuZ3RoID4gMFxyXG4gICAgICAgICAgICA/IGBbcmVmZXJlbmNlZCBmaWxlc11cXG4ke2F0dGFjaG1lbnRzLm1hcCgoYSkgPT4gYC0gJHthLnNwbGl0KC9bXFxcXC9dLykucG9wKCl9YCkuam9pbignXFxuJyl9XFxuXFxuJHt0ZXh0fWBcclxuICAgICAgICAgICAgOiB0ZXh0O1xyXG4gICAgICAgICAgY29uc3Qgd2l0aEltYWdlcyA9IGltYWdlcy5sZW5ndGggPiAwID8gYFtpbWFnZXM6ICR7aW1hZ2VzLmxlbmd0aH1dXFxuJHtjb21wb3NlZH1gIDogY29tcG9zZWQ7XHJcbiAgICAgICAgICBjb25zdCBydW5JZCA9IHJ1blRhc2soc2Vzc2lvbklkLCB3aXRoSW1hZ2VzLCBtb2RlKTtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIHJ1bklkLCBpbWFnZXM6IGltYWdlcy5sZW5ndGggfSkpO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCBTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcclxuICAgICAgICB9XHJcbiAgICAgIH0pKCk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9hcHByb3ZlJykge1xyXG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoKGF3YWl0IHJlYWRCb2R5KCkpIHx8ICd7fScpIGFzIHsgZ3JhbnRlZD86IHVua25vd247IHNlc3Npb25JZD86IHVua25vd24gfTtcclxuICAgICAgICBjb25zdCBzaWQgPSB0eXBlb2YgYm9keS5zZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gYm9keS5zZXNzaW9uSWQgOiAnJztcclxuICAgICAgICBpZiAocGVuZGluZyA9PT0gbnVsbCB8fCAoc2lkICE9PSAnJyAmJiBwZW5kaW5nLnNlc3Npb25JZCAhPT0gc2lkKSkge1xyXG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnbm8gYXBwcm92YWwgcGVuZGluZycsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xyXG4gICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBwID0gcGVuZGluZztcclxuICAgICAgICBwZW5kaW5nID0gbnVsbDtcclxuICAgICAgICBwLnJlc29sdmUoYm9keS5ncmFudGVkID09PSB0cnVlKTtcclxuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgZ3JhbnRlZDogYm9keS5ncmFudGVkID09PSB0cnVlIH0pKTtcclxuICAgICAgfSkoKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUuc3RhcnRzV2l0aCgnL2FwaS9zZXNzaW9ucy8nKSAmJiAodXJsLnBhdGhuYW1lLmVuZHNXaXRoKCcvYXJjaGl2ZScpIHx8IHVybC5wYXRobmFtZS5lbmRzV2l0aCgnL2RlbGV0ZScpKSkge1xyXG4gICAgICAvLyBcdTRGMUFcdThCRERcdTVGNTJcdTY4NjMvXHU1MjIwXHU5NjY0KGhtaGFybmVzcyBcdTU0MENcdTVGNjI6XHU3OUZCXHU1MTY1IGFyY2hpdmUvdHJhc2gsXHU1M0VGXHU2MDYyXHU1OTBELFx1NEUwRFx1Nzg2Q1x1NTIyMClcclxuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHBhcnRzID0gdXJsLnBhdGhuYW1lLnNsaWNlKCcvYXBpL3Nlc3Npb25zLycubGVuZ3RoKS5zcGxpdCgnLycpO1xyXG4gICAgICAgIGNvbnN0IG9wID0gcGFydHNbMV0gPz8gJyc7XHJcbiAgICAgICAgY29uc3Qgb2lkID0gZGVjb2RlVVJJQ29tcG9uZW50KHBhcnRzWzBdID8/ICcnKS5yZXBsYWNlKC9bXmEtekEtWjAtOV86LkAtXS9nLCAnJyk7XHJcbiAgICAgICAgaWYgKG9pZCA9PT0gJycgfHwgKG9wICE9PSAnYXJjaGl2ZScgJiYgb3AgIT09ICdkZWxldGUnKSkge1xyXG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnYmFkIG9wJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XHJcbiAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICghc2Vzc2lvbnMuaGFzKG9pZCkpIHtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3Nlc3Npb24gbm90IGZvdW5kJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XHJcbiAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHNlc3Npb25zLmRlbGV0ZShvaWQpO1xyXG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlIH0pKTtcclxuICAgICAgfSkoKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2luamVjdCcpIHtcclxuICAgICAgLy8gXHU4RkQwXHU4ODRDXHU0RTJEXHU2Q0U4XHU1MTY1KFx1NEUwRSBobWhhcm5lc3MgL2FwaS9pbmplY3QgXHU1NDBDXHU1RjYyO2Zha2UgXHU1M0VBXHU1NkRFXHU2MjY3KVxyXG4gICAgICB2b2lkIHJlYWRCb2R5KCk7XHJcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSB9KSk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9pbnRlcnJ1cHQnKSB7XHJcbiAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKCcnKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjsgLy8gaW50ZXJydXB0IFx1NjVFMCBib2R5IFx1OEJFRFx1NEU0OVxyXG4gICAgICB2b2lkIGJvZHk7XHJcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSB9KSk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3Nlc3Npb25zJykge1xyXG4gICAgICBjb25zdCBsaXN0ID0gWy4uLnNlc3Npb25zLnZhbHVlcygpXS5tYXAoKHMpID0+ICh7XHJcbiAgICAgICAgaWQ6IHMuaWQsIHRpdGxlOiAnJywgdGFzazogJycsIG91dGNvbWU6ICdvaycsIHR1cm5zOiAxLCB0b29sVXNlczogMSxcclxuICAgICAgICB0aW1lOiBzLnVwZGF0ZWRBdCwgY3dkOiAnQzpcXFxcZGVtbycsIGJyYW5jaDogJycsIGNyZWF0ZWRBdDogcy5jcmVhdGVkQXQsIHVwZGF0ZWRBdDogcy51cGRhdGVkQXQsXHJcbiAgICAgIH0pKTtcclxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IHNlc3Npb25zOiBsaXN0LCBuZXh0Q3Vyc29yOiBudWxsIH0pKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZS5zdGFydHNXaXRoKCcvYXBpL3Nlc3Npb25zLycpKSB7XHJcbiAgICAgIGNvbnN0IHNlZyA9IGRlY29kZVVSSUNvbXBvbmVudCh1cmwucGF0aG5hbWUuc2xpY2UoJy9hcGkvc2Vzc2lvbnMvJy5sZW5ndGgpKTtcclxuICAgICAgLy8gXHU1QkZDXHU1MUZBKFx1NEUwRSBobWhhcm5lc3MgL2FwaS9zZXNzaW9ucy86aWQvZXhwb3J0Lm1kIFx1NTQwQ1x1NUY2Mjp0ZXh0L21hcmtkb3duIFx1NEUwQlx1OEY3RClcclxuICAgICAgY29uc3QgZXhwb3J0TWF0Y2ggPSAvXiguKilcXC9leHBvcnRcXC5tZCQvLmV4ZWMoc2VnKSA/PyAvXiguKilcXC5leHBvcnRcXC5tZCQvLmV4ZWMoc2VnKTtcclxuICAgICAgaWYgKGV4cG9ydE1hdGNoICE9PSBudWxsICYmIGV4cG9ydE1hdGNoWzFdICE9PSB1bmRlZmluZWQgJiYgZXhwb3J0TWF0Y2hbMV0gIT09ICcnKSB7XHJcbiAgICAgICAgY29uc3QgZWlkID0gZXhwb3J0TWF0Y2hbMV0ucmVwbGFjZSgvW15hLXpBLVowLTlfOi5ALV0vZywgJycpO1xyXG4gICAgICAgIGNvbnN0IGVzID0gc2Vzc2lvbnMuZ2V0KGVpZCk7XHJcbiAgICAgICAgaWYgKGVzID09PSB1bmRlZmluZWQpIHtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3Nlc3Npb24gbm90IGZvdW5kJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XHJcbiAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAndGV4dC9tYXJrZG93bjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgcmVzLmVuZChgIyBobWhhcm5lc3MgXHU0RjFBXHU4QkREXHU1QkZDXHU1MUZBKGZha2UpXFxuXFxuLSBcdTRGMUFcdThCREQ6JHtlaWR9XFxuXFxuIyMgXHU3NTI4XHU2MjM3XFxuXFxuXHU0RTRCXHU1MjREXHU3Njg0XHU0RUZCXHU1MkExKGZha2UgXHU5ODg0XHU4OUM4KVxcblxcbiMjIFx1NTJBOVx1NjI0Qlxcblxcblx1OEZEOVx1NjYyRlx1NUJGQ1x1NTFGQVx1NzY4NFx1NTZERVx1NTkwRFx1OTg4NFx1ODlDOChmYWtlKVx1MzAwMlxcbmApO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgICAgfVxyXG4gICAgICAvLyBcdTRGMUFcdThCRERcdTk4ODRcdTg5QzgoXHU0RTBFIGhtaGFybmVzcyBHRVQgL2FwaS9zZXNzaW9ucy86aWQgXHU1NDBDXHU1RjYyOlx1NjcwMFx1NTQwRSA4MCBcdTY3NjEsXHU2QkNGXHU2NzYxIDUwMCBcdTVCNTcpXHJcbiAgICAgIGNvbnN0IGlkID0gc2VnLnJlcGxhY2UoL1teYS16QS1aMC05XzouQC1dL2csICcnKTtcclxuICAgICAgY29uc3QgcyA9IHNlc3Npb25zLmdldChpZCk7XHJcbiAgICAgIGlmIChzID09PSB1bmRlZmluZWQpIHtcclxuICAgICAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnc2Vzc2lvbiBub3QgZm91bmQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcclxuICAgICAgICByZXR1cm47XHJcbiAgICAgIH1cclxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XHJcbiAgICAgICAgaWQsIG1vZGVsOiAnZmFrZS1tb2RlbCcsIGN3ZDogJ0M6XFxcXGRlbW8nLFxyXG4gICAgICAgIG1lc3NhZ2VzOiBbXHJcbiAgICAgICAgICB7IHJvbGU6ICd1c2VyJywgdGV4dDogJ1x1NEU0Qlx1NTI0RFx1NzY4NFx1NEVGQlx1NTJBMShmYWtlIFx1OTg4NFx1ODlDOCknLCB0b29sczogW10gfSxcclxuICAgICAgICAgIHsgcm9sZTogJ2Fzc2lzdGFudCcsIHRleHQ6ICdcdThGRDlcdTY2MkZcdTUzODZcdTUzRjJcdTRGMUFcdThCRERcdTc2ODRcdTU2REVcdTU5MERcdTk4ODRcdTg5QzgoZmFrZSlcdTMwMDInLCB0b29sczogWydyZWFkX2ZpbGUnXSB9LFxyXG4gICAgICAgIF0sXHJcbiAgICAgIH0pKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZnMnKSB7XHJcbiAgICAgIC8vIFx1NzZFRVx1NUY1NVx1NkQ0Rlx1ODlDOChcdTRFMEUgaG1oYXJuZXNzIFx1NTQwQ1x1NUY2MjpwYXRoIFx1NzcwMVx1NzU2NT1cdTY4Mzk7ZmlsZXM9MSBcdTk2NDRcdTVFMjZcdTY1ODdcdTRFRjZcdTUyMTdcdTg4NjgpXHJcbiAgICAgIGNvbnN0IHEgPSB1cmwuc2VhcmNoUGFyYW1zLmdldCgncGF0aCcpID8/ICcnO1xyXG4gICAgICBjb25zdCB3aXRoRmlsZXMgPSB1cmwuc2VhcmNoUGFyYW1zLmdldCgnZmlsZXMnKSA9PT0gJzEnO1xyXG4gICAgICBpZiAocSA9PT0gJycpIHtcclxuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xyXG4gICAgICAgICAgcGF0aDogJycsIHNlZ21lbnRzOiBbXSwgcGFyZW50OiAnJyxcclxuICAgICAgICAgIGRpcnM6IFt7IG5hbWU6ICdkZW1vLXdvcmtzcGFjZScsIHBhdGg6ICdDOlxcXFxkZW1vJyB9XSxcclxuICAgICAgICAgIC4uLih3aXRoRmlsZXMgPyB7IGZpbGVzOiBbXSB9IDoge30pLFxyXG4gICAgICAgIH0pKTtcclxuICAgICAgICByZXR1cm47XHJcbiAgICAgIH1cclxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XHJcbiAgICAgICAgcGF0aDogcSwgc2VnbWVudHM6IFt7IG5hbWU6IHEuc3BsaXQoL1tcXFxcL10vKS5maWx0ZXIoQm9vbGVhbikucG9wKCkgPz8gcSwgcGF0aDogcSB9XSwgcGFyZW50OiAnJyxcclxuICAgICAgICBkaXJzOiBbeyBuYW1lOiAnc3JjJywgcGF0aDogYCR7cS5yZXBsYWNlKC9bXFxcXC9dJC8sICcnKX1cXFxcc3JjYCB9XSxcclxuICAgICAgICAuLi4od2l0aEZpbGVzID8geyBmaWxlczogW1xyXG4gICAgICAgICAgeyBuYW1lOiAnUkVBRE1FLm1kJywgcGF0aDogYCR7cS5yZXBsYWNlKC9bXFxcXC9dJC8sICcnKX1cXFxcUkVBRE1FLm1kYCwgcmVsOiAnUkVBRE1FLm1kJyB9LFxyXG4gICAgICAgICAgeyBuYW1lOiAncGFja2FnZS5qc29uJywgcGF0aDogYCR7cS5yZXBsYWNlKC9bXFxcXC9dJC8sICcnKX1cXFxccGFja2FnZS5qc29uYCwgcmVsOiAncGFja2FnZS5qc29uJyB9LFxyXG4gICAgICAgIF0gfSA6IHt9KSxcclxuICAgICAgfSkpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9mcy9yZWFkJykge1xyXG4gICAgICAvLyBcdTY1ODdcdTRFRjZcdTk4ODRcdTg5QzgoNjRLQiBcdTRFMEFcdTk2NTBcdThCRURcdTRFNDk7ZmFrZSBcdThGRDRcdTU2REVcdTU2RkFcdTVCOUFcdTY1ODdcdTY3MkMpXHJcbiAgICAgIGNvbnN0IHAgPSB1cmwuc2VhcmNoUGFyYW1zLmdldCgncGF0aCcpID8/ICcnO1xyXG4gICAgICBpZiAocCA9PT0gJycpIHtcclxuICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAncGF0aCByZXF1aXJlZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgICAgfVxyXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcclxuICAgICAgICBwYXRoOiBwLCByZWw6IHAuc3BsaXQoL1tcXFxcL10vKS5wb3AoKSA/PyBwLCBzaXplOiA0MixcclxuICAgICAgICB0ZXh0OiAnIyBkZW1vIHdvcmtzcGFjZVxcblxcblx1OEZEOVx1NjYyRiBmYWtlIGhvc3QgXHU3Njg0XHU2NTg3XHU0RUY2XHU5ODg0XHU4OUM4XHU1MTg1XHU1QkI5XHUzMDAyXFxuJyxcclxuICAgICAgfSkpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9kaWZmJykge1xyXG4gICAgICAvLyBEaWZmIFx1OTc2Mlx1Njc3RihcdTRFMEUgaG1oYXJuZXNzIC9hcGkvZGlmZiBcdTU0MENcdTVGNjI7ZmFrZSBcdThGRDRcdTU2REVcdTU2RkFcdTVCOUFcdTVDMEZcdTUzRDhcdTY2RjRcdTk2QzYpXHJcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xyXG4gICAgICAgIGdpdDogdHJ1ZSwgY3dkOiAnQzpcXFxcZGVtbycsXHJcbiAgICAgICAgY2hhbmdlZDogW1xyXG4gICAgICAgICAgeyBzdGF0ZTogJ00nLCBwYXRoOiAnc3JjL2FwcC50cycgfSxcclxuICAgICAgICAgIHsgc3RhdGU6ICdBJywgcGF0aDogJ2RvY3Mvbm90ZXMubWQnIH0sXHJcbiAgICAgICAgXSxcclxuICAgICAgICBzdGF0OiAnIHNyYy9hcHAudHMgICAgICB8IDEyICsrKysrKystLS1cXG4gZG9jcy9ub3Rlcy5tZCAgIHwgIDQgKysrK1xcbiAyIGZpbGVzIGNoYW5nZWQsIDE2IGluc2VydGlvbnMoKyksIDMgZGVsZXRpb25zKC0pJyxcclxuICAgICAgfSkpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS93b3Jrc3BhY2VzJykge1xyXG4gICAgICAvLyBcdTVERTVcdTRGNUNcdTUzM0EoXHU0RTBFIGhtaGFybmVzcyBcdTU0MENcdTVGNjI6Y3VycmVudCArIGl0ZW1zKVxyXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcclxuICAgICAgICBjdXJyZW50OiBmYWtlV29ya3NwYWNlcy5jdXJyZW50LFxyXG4gICAgICAgIGl0ZW1zOiBmYWtlV29ya3NwYWNlcy5pdGVtcyxcclxuICAgICAgfSkpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvd29ya3NwYWNlcycpIHtcclxuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7IG5hbWU/OiB1bmtub3duOyBwYXRoPzogdW5rbm93biB9O1xyXG4gICAgICAgIGNvbnN0IHBhdGggPSB0eXBlb2YgYm9keS5wYXRoID09PSAnc3RyaW5nJyA/IGJvZHkucGF0aCA6ICcnO1xyXG4gICAgICAgIGNvbnN0IG5hbWUgPSB0eXBlb2YgYm9keS5uYW1lID09PSAnc3RyaW5nJyAmJiBib2R5Lm5hbWUgIT09ICcnID8gYm9keS5uYW1lIDogKHBhdGguc3BsaXQoL1tcXFxcL10vKS5maWx0ZXIoQm9vbGVhbikucG9wKCkgPz8gJycpO1xyXG4gICAgICAgIGlmIChwYXRoID09PSAnJyB8fCBuYW1lID09PSAnJykge1xyXG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnYWJzb2x1dGUgcGF0aCBhbmQgbmFtZSByZXF1aXJlZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xyXG4gICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoZmFrZVdvcmtzcGFjZXMuaXRlbXMuc29tZSgodykgPT4gdy5wYXRoLnRvTG93ZXJDYXNlKCkgPT09IHBhdGgudG9Mb3dlckNhc2UoKSkpIHtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA5LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3dvcmtzcGFjZSBhbHJlYWR5IHJlZ2lzdGVyZWQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcclxuICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgaXRlbSA9IHsgaWQ6IGB3cy0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDgpfWAsIG5hbWUsIHBhdGggfTtcclxuICAgICAgICBmYWtlV29ya3NwYWNlcy5pdGVtcy5wdXNoKGl0ZW0pO1xyXG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlLCBjdXJyZW50OiBmYWtlV29ya3NwYWNlcy5jdXJyZW50LCBpdGVtczogZmFrZVdvcmtzcGFjZXMuaXRlbXMgfSkpO1xyXG4gICAgICB9KSgpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvd29ya3NwYWNlcy91c2UnKSB7XHJcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgoYXdhaXQgcmVhZEJvZHkoKSkgfHwgJ3t9JykgYXMgeyBpZD86IHVua25vd24gfTtcclxuICAgICAgICBjb25zdCBoaXQgPSBmYWtlV29ya3NwYWNlcy5pdGVtcy5maW5kKCh3KSA9PiB3LmlkID09PSBib2R5LmlkKTtcclxuICAgICAgICBpZiAoaGl0ID09PSB1bmRlZmluZWQpIHtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3dvcmtzcGFjZSBub3QgZm91bmQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcclxuICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgZmFrZVdvcmtzcGFjZXMuY3VycmVudCA9IGhpdC5pZDtcclxuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgY3VycmVudDogZmFrZVdvcmtzcGFjZXMuY3VycmVudCwgaXRlbXM6IGZha2VXb3Jrc3BhY2VzLml0ZW1zIH0pKTtcclxuICAgICAgfSkoKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3Byb3ZpZGVycycpIHtcclxuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7IG5hbWU/OiB1bmtub3duOyBiYXNlVXJsPzogdW5rbm93bjsgbW9kZWw/OiB1bmtub3duOyBhcGlLZXk/OiB1bmtub3duIH07XHJcbiAgICAgICAgY29uc3QgbmFtZSA9IHR5cGVvZiBib2R5Lm5hbWUgPT09ICdzdHJpbmcnID8gYm9keS5uYW1lLnRyaW0oKSA6ICcnO1xyXG4gICAgICAgIGNvbnN0IGJhc2VVcmwgPSB0eXBlb2YgYm9keS5iYXNlVXJsID09PSAnc3RyaW5nJyA/IGJvZHkuYmFzZVVybC50cmltKCkgOiAnJztcclxuICAgICAgICBjb25zdCBtb2RlbCA9IHR5cGVvZiBib2R5Lm1vZGVsID09PSAnc3RyaW5nJyA/IGJvZHkubW9kZWwudHJpbSgpIDogJyc7XHJcbiAgICAgICAgaWYgKG5hbWUgPT09ICcnIHx8IGJhc2VVcmwgPT09ICcnIHx8IG1vZGVsID09PSAnJykge1xyXG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnbmFtZSwgYmFzZVVybCBhbmQgbW9kZWwgYXJlIHJlcXVpcmVkJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XHJcbiAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGZha2VQcm92aWRlcnMuc2V0KG5hbWUsIHsgYmFzZVVybCwgbW9kZWwsIGFwaUtleTogdHlwZW9mIGJvZHkuYXBpS2V5ID09PSAnc3RyaW5nJyA/IGJvZHkuYXBpS2V5IDogJycgfSk7XHJcbiAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIG5hbWUgfSkpO1xyXG4gICAgICB9KSgpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9mcy9zZWFyY2gnKSB7XHJcbiAgICAgIC8vIFx1NURFNVx1NEY1Q1x1NTMzQVx1NjU4N1x1NEVGNlx1NjQxQ1x1N0QyMihcdTRFMEUgaG1oYXJuZXNzIFx1NTQwQ1x1NUY2MjpAXHU5NjQ0XHU0RUY2XHU5MDA5XHU2MkU5XHU1NjY4XHU3Njg0XHU2NTcwXHU2MzZFXHU2RTkwKVxyXG4gICAgICBjb25zdCBxID0gKHVybC5zZWFyY2hQYXJhbXMuZ2V0KCdxJykgPz8gJycpLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xyXG4gICAgICBjb25zdCBhbGwgPSBbXHJcbiAgICAgICAgeyByZWw6ICdSRUFETUUubWQnLCBwYXRoOiAnQzpcXFxcZGVtb1xcXFxSRUFETUUubWQnLCBraW5kOiAnZmlsZScgfSxcclxuICAgICAgICB7IHJlbDogJ3NyYy9hcHAudHMnLCBwYXRoOiAnQzpcXFxcZGVtb1xcXFxzcmNcXFxcYXBwLnRzJywga2luZDogJ2ZpbGUnIH0sXHJcbiAgICAgICAgeyByZWw6ICdkb2NzL25vdGVzLm1kJywgcGF0aDogJ0M6XFxcXGRlbW9cXFxcZG9jc1xcXFxub3Rlcy5tZCcsIGtpbmQ6ICdmaWxlJyB9LFxyXG4gICAgICBdO1xyXG4gICAgICBjb25zdCBoaXRzID0gcSA9PT0gJycgPyBhbGwgOiBhbGwuZmlsdGVyKChmKSA9PiBmLnJlbC50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHEpKTtcclxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IHJlc3VsdHM6IGhpdHMuc2xpY2UoMCwgMjApLCB0cnVuY2F0ZWQ6IGZhbHNlLCB0b3RhbDogaGl0cy5sZW5ndGggfSkpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9jb2duaXRpdmUnKSB7XHJcbiAgICAgIC8vIFx1OEJBNFx1NzdFNVx1NzJCNlx1NjAwMShcdTRFMEUgaG1oYXJuZXNzIGNvZ25pdGl2ZVN0YXR1cyBcdTU0MENcdTVGNjJcdTVCNTBcdTk2QzY7XHU3RjNBXHU2NTcwXHU2MzZFXHU2NjNFXHU1RjBGIG51bGwpXHJcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xyXG4gICAgICAgIG1lbW9yeTogeyBsYXllcnM6IDMsIGVudHJpZXM6IDEyLCBjb250cmFkaWN0aW9uczogMCB9LFxyXG4gICAgICAgIHRyYWplY3RvcmllczogNyxcclxuICAgICAgICBhdWRpdEV2ZW50czogMjEsXHJcbiAgICAgICAgd29ybGRNb2RlbDogeyB2ZXJzaW9uOiA0LCBiZWxpZWZzOiA5LCB0cnVzdGVkOiA1LCBicmllcjogMC4zMSB9LFxyXG4gICAgICAgIGNhbGlicmF0aW9uOiB7IHByZWRpY3Rpb25zOiA0NiwgcmVsaWFiaWxpdHk6IDAuNzIgfSxcclxuICAgICAgfSkpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZmFrZS9lbWl0Jykge1xyXG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7XHJcbiAgICAgICAgICAgIHNlc3Npb25JZDogc3RyaW5nOyBydW5JZDogc3RyaW5nOyBraW5kOiBFdmVudEtpbmQ7IHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xyXG4gICAgICAgICAgfTtcclxuICAgICAgICAgIGNvbnN0IHNlcSA9IGVtaXQoYm9keS5zZXNzaW9uSWQsIGJvZHkucnVuSWQsIGJvZHkua2luZCwgYm9keS5wYXlsb2FkKTtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIHNlcSB9KSk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsIFN0cmluZyhlcnIpLnNsaWNlKDAsIDEyMCksIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xyXG4gICAgICAgIH1cclxuICAgICAgfSkoKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCBgbm8gcm91dGUgJHtyZXEubWV0aG9kfSAke3VybC5wYXRobmFtZX1gLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcclxuICB9KTtcclxuXHJcbiAgYXdhaXQgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xyXG4gICAgc2VydmVyLm9uY2UoJ2Vycm9yJywgcmVqZWN0KTtcclxuICAgIHNlcnZlci5saXN0ZW4oMCwgJzEyNy4wLjAuMScsICgpID0+IHJlc29sdmUoKSk7XHJcbiAgfSk7XHJcbiAgY29uc3QgYWRkcmVzcyA9IHNlcnZlci5hZGRyZXNzKCk7XHJcbiAgaWYgKGFkZHJlc3MgPT09IG51bGwgfHwgdHlwZW9mIGFkZHJlc3MgIT09ICdvYmplY3QnKSB0aHJvdyBuZXcgRXJyb3IoJ2Zha2UgaG9zdDogbm8gcG9ydCcpO1xyXG4gIGNvbnN0IHBvcnQgPSBhZGRyZXNzLnBvcnQ7XHJcblxyXG4gIGlmICghb3B0cy5xdWlldCkge1xyXG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7SlNPTi5zdHJpbmdpZnkoeyBobWhEZXNrdG9wSG9zdFJlYWR5OiB0cnVlLCBwb3J0LCB2ZXJzaW9uOiAnZmFrZS0wLjAuMCcgfSl9XFxuYCk7XHJcbiAgfVxyXG4gIGNvbnN0IGRpZUFmdGVyID0gTnVtYmVyKHByb2Nlc3MuZW52LkZBS0VfSE9TVF9ESUVfQUZURVJfTVMgPz8gMCk7XHJcbiAgaWYgKE51bWJlci5pc0Zpbml0ZShkaWVBZnRlcikgJiYgZGllQWZ0ZXIgPiAwKSB7XHJcbiAgICBzZXRUaW1lb3V0KCgpID0+IHByb2Nlc3MuZXhpdCgxKSwgZGllQWZ0ZXIpLnVucmVmKCk7XHJcbiAgfVxyXG5cclxuICAvLyBjbG9zZSgpOiBcdTUxNDhcdTY1QURcdTVGMDBcdTUxNjhcdTkwRTggU1NFIFx1OEZERVx1NjNBNShcdTVCODNcdTRFRUNcdTZDMzhcdTRFMERcdTgxRUFcdTcxMzZcdTUxNzNcdTk1RUQpLFx1NTQyNlx1NTIxOSBzZXJ2ZXIuY2xvc2VcclxuICAvLyBcdTRGMUFcdTRFMDBcdTc2RjRcdTdCNDlcdTZEM0JcdThEQzNcdThGREVcdTYzQTUsXHU2RDRCXHU4QkQ1XHU4RkRCXHU3QTBCXHU2MzAyXHU2QjdCXHUzMDAyXHJcbiAgY29uc3QgY2xvc2UgPSAoKTogUHJvbWlzZTx2b2lkPiA9PlxyXG4gICAgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUpID0+IHtcclxuICAgICAgZm9yIChjb25zdCBjIG9mIHNzZUNsaWVudHMpIHtcclxuICAgICAgICB0cnkgeyBjLmVuZCgpOyBjLmRlc3Ryb3koKTsgfSBjYXRjaCB7IC8qIGFscmVhZHkgZ29uZSAqLyB9XHJcbiAgICAgIH1cclxuICAgICAgc3NlQ2xpZW50cy5jbGVhcigpO1xyXG4gICAgICBzZXJ2ZXIuY2xvc2UoKCkgPT4gcmVzb2x2ZSgpKTtcclxuICAgICAgc2V0VGltZW91dCgoKSA9PiByZXNvbHZlKCksIDFfMDAwKS51bnJlZigpO1xyXG4gICAgfSk7XHJcblxyXG4gIHJldHVybiB7IHBvcnQsIGVtaXQsIGNsb3NlIH07XHJcbn1cclxuXHJcbi8vIFx1NzZGNFx1NjNBNVx1OEZEMFx1ODg0QyhzdXBlcnZpc29yIHNwYXduIFx1NzY4NFx1NUI1MFx1OEZEQlx1N0EwQlx1NUY2Mlx1NjAwMSlcdTMwMDJyZWFscGF0aCBcdTZCRDRcdThGODM6bnBtIHdvcmtzcGFjZVxyXG4vLyBqdW5jdGlvbiAvIFx1NTkyN1x1NUMwRlx1NTE5OVx1NURFRVx1NUYwMlx1OTBGRFx1NEUwRFx1ODBGRFx1OEJBOVx1OEZEOVx1NEUyQVx1NjhDMFx1NkQ0Qlx1NTkzMVx1NjI0QihcdTU5MzFcdTYyNEI9XHU5NzU5XHU5RUQ4XHU5MDAwXHU1MUZBIGNvZGUgMCxcdTk2QkVcdTY3RTUpXHUzMDAyXHJcbi8vIGNqcyBidW5kbGUoZXNidWlsZCxcdTYyNTNcdTUzMDVcdTRFQTdcdTU0QzEpXHU0RTBCIF9fZmlsZW5hbWUgXHU1QjU4XHU1NzI4O0VTTSh0c3gvXHU2RTkwXHU3ODAxKVx1NzUyOCBpbXBvcnQubWV0YVx1MzAwMlxyXG5jb25zdCBzZWxmVXJsOiBzdHJpbmcgPSB0eXBlb2YgX19maWxlbmFtZSA9PT0gJ3N0cmluZydcclxuICA/IHBhdGhUb0ZpbGVVUkwocmVhbHBhdGhTeW5jKF9fZmlsZW5hbWUpKS5ocmVmXHJcbiAgOiBpbXBvcnQubWV0YS51cmw7XHJcbmNvbnN0IGludm9rZWRBc1NjcmlwdCA9ICgoKSA9PiB7XHJcbiAgaWYgKHByb2Nlc3MuYXJndlsxXSA9PT0gdW5kZWZpbmVkKSByZXR1cm4gZmFsc2U7XHJcbiAgdHJ5IHtcclxuICAgIHJldHVybiBzZWxmVXJsID09PSBwYXRoVG9GaWxlVVJMKHJlYWxwYXRoU3luYyhwcm9jZXNzLmFyZ3ZbMV0pKS5ocmVmO1xyXG4gIH0gY2F0Y2gge1xyXG4gICAgcmV0dXJuIGZhbHNlO1xyXG4gIH1cclxufSkoKTtcclxuaWYgKGludm9rZWRBc1NjcmlwdCkge1xyXG4gIGNvbnN0IHRva2VuID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVE9LRU4gPz8gJyc7XHJcbiAgLy8gRkFLRV9IT1NUX0RJRV9BVF9CT09UPTE6XHU1RjE1XHU1QkZDXHU4ODRDXHU4RjkzXHU1MUZBXHU1MjREXHU1MzczXHU2QjdCKFx1Njc4NFx1OTAyMFx1NTQyRlx1NTJBOFx1NjcxRiBSVU5USU1FX0NSQVNIRUQpXHJcbiAgaWYgKHByb2Nlc3MuZW52LkZBS0VfSE9TVF9ESUVfQVRfQk9PVCA9PT0gJzEnKSB7XHJcbiAgICBwcm9jZXNzLmV4aXQoMSk7XHJcbiAgfVxyXG4gIGNvbnN0IHNsb3cgPSBOdW1iZXIocHJvY2Vzcy5lbnYuRkFLRV9IT1NUX1NMT1dfQUZURVIgPz8gMCk7XHJcbiAgY29uc3QgYm9vdCA9ICgpOiB2b2lkID0+IHtcclxuICAgIHZvaWQgc3RhcnRGYWtlSG9zdCh7IHRva2VuIH0pLmNhdGNoKChlcnIpID0+IHtcclxuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYGZha2UtaG9zdCBmYWlsZWQ6ICR7U3RyaW5nKGVycil9XFxuYCk7XHJcbiAgICAgIHByb2Nlc3MuZXhpdCgxKTtcclxuICAgIH0pO1xyXG4gIH07XHJcbiAgaWYgKE51bWJlci5pc0Zpbml0ZShzbG93KSAmJiBzbG93ID4gMCkgc2V0VGltZW91dChib290LCBzbG93KTtcclxuICBlbHNlIGJvb3QoKTtcclxufVxyXG4iLCAiLyoqXG4gKiBVSVZFUklGWSBcdTk0QTlcdTVCNTAgXHUyMDE0XHUyMDE0IFx1OTAxMFx1NTI5Rlx1ODBGRFx1NzcxRlx1NUI5RSBVSSBcdTlBNzFcdTUyQThcdTlBOENcdTY1MzYoMjAyNi0xMC0xMCBcdTc1MjhcdTYyMzdcdTYzMDdcdTRFRTQ6XG4gKiBcIlx1NUJGOVx1NkJDRlx1NEUwMFx1NEUyQVx1NTI5Rlx1ODBGRCxcdTZCQ0ZcdTRFMDBcdTRFMkFcdTRFMUFcdTUyQTFcdTZENDFcdTdBMEJcdTUxNjhcdTk3NjJcdTc2ODRcdTlBOENcdTY1MzZcIilcdTMwMDJcbiAqXG4gKiBcdTc2RjRcdTYzQTVcdTVCRjlcdTZFMzJcdTY3RDNcdTU0MEVcdTc2ODQgRE9NIFx1NjVBRFx1OEEwMChcdTVFMDNcdTVDNDBcdTUxRTBcdTRGNTUvXHU1M0VGXHU4OUMxXHU2MDI3KSxcdTVFNzZcdTc1MjhcdTUzOUZcdTc1MUZcdTRFOEJcdTRFRjZcdTlBNzFcdTUyQTggUmVhY3RcbiAqIChcdTUzRDdcdTYzQTdcdThGOTNcdTUxNjVcdTc1MjhcdTUzOUZcdTU3OEIgc2V0dGVyICsgaW5wdXQgXHU0RThCXHU0RUY2O1x1NjMwOVx1OTRBRSBjbGljaztcdTk1MkVcdTc2RDhcdThENzAgd2luZG93XG4gKiBrZXlkb3duKVx1MzAwMmZha2UgXHU2QTIxXHU1RjBGXHU4REQxXHU1QjhDXHU2NTc0XHU0RUZCXHU1MkExXHU5NEZFKFx1NTNEMVx1OTAwMVx1MjE5Mlx1NURFNVx1NTE3N1x1MjE5Mlx1NUJBMVx1NjI3OVx1MjE5Mlx1NEVBNFx1NEVEOFx1NzI2OVx1MjE5Mlx1NkM0N1x1NjAzQik7XG4gKiByZWFsIFx1NkEyMVx1NUYwRlx1NTNFQVx1OEREMVx1NTNFQVx1OEJGQlx1NUI1MFx1OTZDNihcdTRFMERcdTUyQThcdTc3MUZcdTVCOUVcdTRGMUFcdThCRERcdTMwMDFcdTRFMERcdTcwRTcgdG9rZW4pXHUzMDAyXG4gKiBcdTZCQ0ZcdTZCNjVcdThGOTNcdTUxRkEgYFVJVkVSSUZZIFBBU1N8RkFJTCBuYW1lIHwgZGV0YWlsYCxcdTdFRDNcdTVDM0UgU1VNTUFSWSxleGl0IGNvZGVcdTMwMDJcbiAqL1xuaW1wb3J0IHsgYXBwLCB0eXBlIEJyb3dzZXJXaW5kb3cgfSBmcm9tICdlbGVjdHJvbic7XG5pbXBvcnQgeyBta2Rpciwgd3JpdGVGaWxlIH0gZnJvbSAnbm9kZTpmcy9wcm9taXNlcyc7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSAnbm9kZTpwYXRoJztcblxuY29uc3Qgc2xlZXAgPSAobXM6IG51bWJlcik6IFByb21pc2U8dm9pZD4gPT4gbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgbXMpKTtcblxuYXN5bmMgZnVuY3Rpb24gcnVuVWlWZXJpZnkod2luOiBCcm93c2VyV2luZG93LCBtb2RlOiAnZmFrZScgfCAncmVhbCcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3Qgc2hvdHMgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9TSE9UUyA/PyBqb2luKGFwcC5nZXRQYXRoKCd0ZW1wJyksICdobWgtdWl2ZXJpZnknKTtcbiAgYXdhaXQgbWtkaXIoc2hvdHMsIHsgcmVjdXJzaXZlOiB0cnVlIH0pLmNhdGNoKCgpID0+IHVuZGVmaW5lZCk7XG4gIGNvbnN0IHJlc3VsdHM6IEFycmF5PFtzdHJpbmcsIGJvb2xlYW4sIHN0cmluZ10+ID0gW107XG4gIGxldCBzaG90SWR4ID0gMDtcblxuICBjb25zdCBqcyA9IDxUPihjb2RlOiBzdHJpbmcpOiBQcm9taXNlPFQ+ID0+IHdpbi53ZWJDb250ZW50cy5leGVjdXRlSmF2YVNjcmlwdChjb2RlLCB0cnVlKSBhcyBQcm9taXNlPFQ+O1xuICBjb25zdCBzdGVwID0gYXN5bmMgKG5hbWU6IHN0cmluZywgZm46ICgpID0+IFByb21pc2U8W2Jvb2xlYW4sIHN0cmluZ10+KTogUHJvbWlzZTx2b2lkPiA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IFtvaywgZGV0YWlsXSA9IGF3YWl0IGZuKCk7XG4gICAgICByZXN1bHRzLnB1c2goW25hbWUsIG9rLCBkZXRhaWxdKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGNvbnN0IGRldGFpbCA9IGVyciBpbnN0YW5jZW9mIEVycm9yICYmIGVyci5zdGFjayAhPT0gdW5kZWZpbmVkID8gZXJyLnN0YWNrIDogU3RyaW5nKGVycik7XG4gICAgICByZXN1bHRzLnB1c2goW25hbWUsIGZhbHNlLCBkZXRhaWwuc2xpY2UoMCwgMzAwKV0pO1xuICAgIH1cbiAgICBjb25zdCBsYXN0ID0gcmVzdWx0c1tyZXN1bHRzLmxlbmd0aCAtIDFdITtcbiAgICBjb25zb2xlLmxvZyhgVUlWRVJJRlkgJHtsYXN0WzFdID8gJ1BBU1MnIDogJ0ZBSUwnfSB8ICR7bGFzdFswXX0gfCAke2xhc3RbMl19YCk7XG4gIH07XG4gIC8qKiBcdThGNkVcdThCRTJcdTc2RjRcdTUyMzAgcHJlZGljYXRlQ29kZSBcdThGRDRcdTU2REUge29rOnRydWUsLi4ufSBcdTYyMTZcdThEODVcdTY1RjYoXHU4RkQ0XHU1NkRFXHU2NzAwXHU1NDBFXHU3Njg0IGRldGFpbClcdTMwMDIgKi9cbiAgY29uc3Qgd2FpdEZvciA9IGFzeW5jIChsYWJlbDogc3RyaW5nLCBwcmVkaWNhdGVDb2RlOiBzdHJpbmcsIHRpbWVvdXRNczogbnVtYmVyKTogUHJvbWlzZTxbYm9vbGVhbiwgc3RyaW5nXT4gPT4ge1xuICAgIGNvbnN0IHN0YXJ0ZWQgPSBEYXRlLm5vdygpO1xuICAgIGZvciAoOzspIHtcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoYChmdW5jdGlvbigpeyB0cnkgeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkoKGZ1bmN0aW9uKCl7ICR7cHJlZGljYXRlQ29kZX0gfSkoKSk7IH0gY2F0Y2goZSl7IHJldHVybiBKU09OLnN0cmluZ2lmeSh7b2s6ZmFsc2UsIGRldGFpbDpTdHJpbmcoZSkuc2xpY2UoMCwxMjApfSk7IH0gfSkoKWApKSBhcyBzdHJpbmc7XG4gICAgICBsZXQgcGFyc2VkOiB7IG9rPzogYm9vbGVhbjsgZGV0YWlsPzogc3RyaW5nIH07XG4gICAgICB0cnkgeyBwYXJzZWQgPSBKU09OLnBhcnNlKHIpIGFzIHsgb2s/OiBib29sZWFuOyBkZXRhaWw/OiBzdHJpbmcgfTsgfSBjYXRjaCB7IHBhcnNlZCA9IHsgb2s6IGZhbHNlLCBkZXRhaWw6IFN0cmluZyhyKS5zbGljZSgwLCAxMjApIH07IH1cbiAgICAgIGlmIChwYXJzZWQub2sgPT09IHRydWUpIHJldHVybiBbdHJ1ZSwgU3RyaW5nKHBhcnNlZC5kZXRhaWwgPz8gJycpXTtcbiAgICAgIGlmIChEYXRlLm5vdygpIC0gc3RhcnRlZCA+IHRpbWVvdXRNcykgcmV0dXJuIFtmYWxzZSwgYCR7bGFiZWx9OiAke1N0cmluZyhwYXJzZWQuZGV0YWlsID8/ICd0aW1lb3V0Jyl9YF07XG4gICAgICBhd2FpdCBzbGVlcCgyNTApO1xuICAgIH1cbiAgfTtcbiAgY29uc3Qgc2hvdCA9IGFzeW5jIChsYWJlbDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiA9PiB7XG4gICAgc2hvdElkeCArPSAxO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBpbWcgPSBhd2FpdCB3aW4ud2ViQ29udGVudHMuY2FwdHVyZVBhZ2UoKTtcbiAgICAgIGF3YWl0IHdyaXRlRmlsZShqb2luKHNob3RzLCBgJHttb2RlfS0ke1N0cmluZyhzaG90SWR4KS5wYWRTdGFydCgyLCAnMCcpfS0ke2xhYmVsfS5wbmdgKSwgaW1nLnRvUE5HKCkpO1xuICAgIH0gY2F0Y2ggeyAvKiBcdTYyMkFcdTU2RkVcdTU5MzFcdThEMjVcdTRFMERcdTUyMjRcdTZCN0IgKi8gfVxuICB9O1xuXG4gIC8qIC0tLS0gXHU1M0Q3XHU2M0E3XHU4RjkzXHU1MTY1KFJlYWN0Olx1NTM5Rlx1NTc4QiBzZXR0ZXIgXHU4OUU2XHU1M0QxIG9uQ2hhbmdlKSAtLS0tICovXG4gIGNvbnN0IHR5cGVJbnRvID0gKHNlbDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpOiBQcm9taXNlPHVua25vd24+ID0+XG4gICAganMoYChmdW5jdGlvbigpe1xuICAgICAgdmFyIGVsID0gZG9jdW1lbnQucXVlcnlTZWxlY3Rvcigke0pTT04uc3RyaW5naWZ5KHNlbCl9KTtcbiAgICAgIGlmICghZWwpIHJldHVybiAnTk9FTCc7XG4gICAgICB2YXIgcHJvdG8gPSBlbC50YWdOYW1lID09PSAnVEVYVEFSRUEnID8gSFRNTFRleHRBcmVhRWxlbWVudC5wcm90b3R5cGUgOiBIVE1MSW5wdXRFbGVtZW50LnByb3RvdHlwZTtcbiAgICAgIE9iamVjdC5nZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IocHJvdG8sICd2YWx1ZScpLnNldC5jYWxsKGVsLCAke0pTT04uc3RyaW5naWZ5KHRleHQpfSk7XG4gICAgICBlbC5kaXNwYXRjaEV2ZW50KG5ldyBFdmVudCgnaW5wdXQnLCB7IGJ1YmJsZXM6IHRydWUgfSkpO1xuICAgICAgcmV0dXJuICdPSyc7XG4gICAgfSkoKWApO1xuXG4gIC8qIC0tLS0gXHU1NDJGXHU1MkE4XHU3QjQ5XHU1Rjg1OlJlYWN0IFx1NjMwMlx1OEY3RCArIGhvc3QgXHU3RUZGXHU3MEI5KHJlYWwgXHU3Njg0IGhtaGFybmVzcyBcdTUxQjdcdTU0MkZcdTUyQThcdTg5ODFcdTdGMTZcdThCRDFcbiAgICAgXHU2NTc0XHU1OTU3IENMSSBcdTRGOURcdThENTYsXHU1M0VGXHU1MjMwIDMwcys7XHU0RTBEXHU3QjQ5XHU3RUZGXHU3MEI5XHU1QzMxXHU1RjAwXHU4REQxXHU0RjFBXHU1MTY4XHU5MEU4XHU4RDg1XHU2NUY2XHU4QkVGXHU2MkE1KSAtLS0tICovXG4gIGF3YWl0IHdhaXRGb3IoJ2hvc3QgcmVhZHknLCBgdmFyIHQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNvbXBvc2VyIHRleHRhcmVhJyk7IHJldHVybiB7b2s6ICEhdCwgZGV0YWlsOiB0ID8gJ21vdW50ZWQnIDogJ25vIGNvbXBvc2VyJ307YCwgMjBfMDAwKTtcbiAgYXdhaXQgd2FpdEZvcignaG9zdCBkb3Qgb24nLCBgdmFyIGQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmhvc3QtZG90Jyk7IHJldHVybiB7b2s6ICEhZCAmJiBkLmNsYXNzTGlzdC5jb250YWlucygnb24nKSwgZGV0YWlsOiBkID8gZC5jbGFzc05hbWUgOiAnbm8gZG90J307YCwgbW9kZSA9PT0gJ3JlYWwnID8gNjBfMDAwIDogMjBfMDAwKTtcbiAgYXdhaXQgc2xlZXAoMV8yMDApOyAvLyBcdTRGMUFcdThCRERcdTUyMTdcdTg4NjgvXHU5ODc2XHU2ODBGXHU2NTcwXHU2MzZFXHU4NDNEXHU1NzMwXG5cbiAgLyogPT09PT09PT09PSBcdTkwMUFcdTc1Mjg6XHU1RTAzXHU1QzQwXHU1MUUwXHU0RjU1KFx1NzUyOFx1NjIzN1x1NjJBNVx1OTY5Q1x1NzY4NFx1NzZGNFx1NjNBNVx1NjVBRFx1OEEwMCkgPT09PT09PT09PSAqL1xuICBhd2FpdCBzdGVwKCdcdTVFMDNcdTVDNDA6XHU2ODA3XHU5ODk4XHU2ODBGK1x1NEUwOVx1NjgwRitjb21wb3NlciBcdTU3MjhcdTg5QzZcdTUzRTNcdTUxODUoXHU4RjkzXHU1MTY1XHU2ODQ2XHU1M0VGXHU4OUMxKScsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCByID0gKGF3YWl0IGpzKGAoZnVuY3Rpb24oKXtcbiAgICAgIHZhciBxID0gZG9jdW1lbnQucXVlcnlTZWxlY3Rvci5iaW5kKGRvY3VtZW50KTtcbiAgICAgIHZhciB0YiA9IHEoJy50aXRsZWJhcicpLCBzaGVsbCA9IHEoJy5hcHAtc2hlbGwnKSwgc2IgPSBxKCcuc2lkZWJhcicpLCB3cyA9IHEoJy53b3Jrc3BhY2UnKSwgdGEgPSBxKCcuY29tcG9zZXIgdGV4dGFyZWEnKTtcbiAgICAgIHZhciBtaXNzaW5nID0gWyF0YiAmJiAndGl0bGViYXInLCAhc2hlbGwgJiYgJ3NoZWxsJywgIXNiICYmICdzaWRlYmFyJywgIXdzICYmICd3b3Jrc3BhY2UnLCAhdGEgJiYgJ3RleHRhcmVhJ10uZmlsdGVyKEJvb2xlYW4pLmpvaW4oJywnKTtcbiAgICAgIGlmIChtaXNzaW5nICE9PSAnJykgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHtvazpmYWxzZSwgZGV0YWlsOidtaXNzaW5nOicrbWlzc2luZ30pO1xuICAgICAgdmFyIHIgPSB0YS5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKSwgdmggPSB3aW5kb3cuaW5uZXJIZWlnaHQsIHZ3ID0gd2luZG93LmlubmVyV2lkdGg7XG4gICAgICB2YXIgaGludCA9IHEoJy5lbXB0eS1oaW50LmJpZycpOyB2YXIgaHIgPSBoaW50ID8gaGludC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKSA6IG51bGw7XG4gICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoeyBvazogci5oZWlnaHQgPiAzMCAmJiByLmJvdHRvbSA8PSB2aCAmJiByLndpZHRoID4gMTAwICYmIGhyICE9PSBudWxsICYmIGhyLnRvcCA+PSAwICYmIGhyLmJvdHRvbSA8PSB2aCxcbiAgICAgICAgZGV0YWlsOiAndGV4dGFyZWEgeT0nK01hdGgucm91bmQoci55KSsnIGg9JytNYXRoLnJvdW5kKHIuaGVpZ2h0KSsnIGJvdHRvbT0nK01hdGgucm91bmQoci5ib3R0b20pKycgdmg9Jyt2aCsoaHIgPyAnIGhpbnQgeT0nK01hdGgucm91bmQoaHIueSkgOiAnIG5vLWhpbnQnKSB9KTtcbiAgICB9KSgpYCkpIGFzIHN0cmluZztcbiAgICBjb25zdCBwID0gSlNPTi5wYXJzZShyKSBhcyB7IG9rOiBib29sZWFuOyBkZXRhaWw6IHN0cmluZyB9O1xuICAgIHJldHVybiBbcC5vayA9PT0gdHJ1ZSwgcC5kZXRhaWxdO1xuICB9KTtcblxuICBpZiAobW9kZSA9PT0gJ2Zha2UnKSB7XG4gICAgLyogPT09PT09PT09PSBmYWtlKFx1NTQxMVx1NUJGQ1x1Njc4NFx1OTAyMCxITUhfREVTS1RPUF9VSVZFUklGWV9XSVpBUkQ9ZmFrZSk6XG4gICAgICAgXHU0RjJBXHU5MDIwXHU2NzJBXHU5MTREXHU3RjZFXHU2MDAxIFx1MjE5MiBcdTU0MTFcdTVCRkNcdTUxRkFcdTczQjAgXHUyMTkyIFx1NjhDMFx1NkQ0QihcdTY3MkFcdTg4QzUpXHUyMTkyIFx1OTAwOVx1NjJFOSBcdTIxOTIgXHU1MTg1XHU3RjZFIFx1MjE5MiBcdThGREVcdTRFMEEgPT09PT09PT09PSAqL1xuICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9XSVpBUkQgPT09ICdmYWtlJykge1xuICAgICAgYXdhaXQgc3RlcCgnXHU1NDExXHU1QkZDOlx1OTk5Nlx1NTQyRlx1NUYzOVx1NTFGQVx1NkIyMlx1OEZDRVx1OTg3NShcdTVGMDBcdTU5Q0JcdTkxNERcdTdGNkUvXHU2RjE0XHU3OTNBXHU1MTY1XHU1M0UzKScsIGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3dpemFyZCBvdmVybGF5JywgYHZhciBvPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3ZlcmxheScpO1xuICAgICAgICAgIHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTVGMDBcdTU5Q0JcdTkxNERcdTdGNkUnO30pO1xuICAgICAgICAgIHJldHVybiB7b2s6ICEhbyAmJiAhIWIsIGRldGFpbDogbyA/ICdvdmVybGF5K1x1NUYwMFx1NTlDQlx1OTE0RFx1N0Y2RScgOiAnbm8gb3ZlcmxheSd9O2AsIDEyXzAwMCk7XG4gICAgICAgIGF3YWl0IHNob3QoJ3dpemFyZC13ZWxjb21lJyk7XG4gICAgICAgIHJldHVybiB3O1xuICAgICAgfSk7XG4gICAgICBhd2FpdCBzdGVwKCdcdTU0MTFcdTVCRkM6XHU1RjAwXHU1OUNCXHU5MTREXHU3RjZFXHUyMTkyXHU2OEMwXHU2RDRCKFx1NEYyQVx1OTAyMFx1NjcyQVx1ODhDNSlcdTIxOTJcdTgxRUFcdTUyQThcdThGREJcdTkwMDlcdTYyRTlcdTk4NzUoXHU0RTA5XHU5MDA5XHU0RTAwK1x1NTE2OFx1NUM0MFx1OTE0RFx1N0Y2RVx1NjNEMFx1NzkzQSknLCBhc3luYyAoKSA9PiB7XG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NUYwMFx1NTlDQlx1OTE0RFx1N0Y2RSc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xuICAgICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignc2VsZWN0IHBhZ2UnLCBgdmFyIHA9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLXNlbGVjdCcpO1xuICAgICAgICAgIGlmKCFwKSByZXR1cm4ge29rOmZhbHNlLCBkZXRhaWw6J25vdCBvbiBzZWxlY3QnfTtcbiAgICAgICAgICB2YXIgdD1wLnRleHRDb250ZW50O1xuICAgICAgICAgIHZhciBvMT10LmluZGV4T2YoJ1x1NEUwQlx1OEY3RFx1NUI4OVx1ODhDNVx1NUI4Q1x1NjU3NCBobWggQ0xJJyk+PTAsIG8yPXQuaW5kZXhPZignXHU0RjdGXHU3NTI4XHU1MTg1XHU3RjZFXHU3Q0JFXHU3QjgwXHU1MTg1XHU2ODM4Jyk+PTAsIG8zPXQuaW5kZXhPZignXHU4REYzXHU4RkM3KFx1NkYxNFx1NzkzQVx1NkEyMVx1NUYwRiknKT49MCwgbm90ZT10LmluZGV4T2YoJy5obWhhcm5lc3MnKT49MDtcbiAgICAgICAgICByZXR1cm4ge29rOiBvMSYmbzImJm8zJiZub3RlLCBkZXRhaWw6ICdvcHQxPScrbzErJyBvcHQyPScrbzIrJyBvcHQzPScrbzMrJyBub3RlPScrbm90ZX07YCwgMTJfMDAwKTtcbiAgICAgICAgYXdhaXQgc2hvdCgnd2l6YXJkLXNlbGVjdCcpO1xuICAgICAgICByZXR1cm4gdztcbiAgICAgIH0pO1xuICAgICAgYXdhaXQgc3RlcCgnXHU1NDExXHU1QkZDOlx1OTAwOVx1NTE4NVx1N0Y2RVx1N0NCRVx1N0I4MFx1NTE4NVx1NjgzOFx1MjE5Mlx1OTE0RFx1N0Y2RVx1OERGM1x1OEZDN1x1MjE5Mlx1NUI4Q1x1NjIxMFx1OTg3NVx1MjE5Mlx1NUYwMFx1NTlDQlx1NEY3Rlx1NzUyOFx1MjE5Mlx1NTE3M1x1OTVFRFx1NEUxNFx1NURGMlx1OEZERVx1NjNBNScsIGFzeW5jICgpID0+IHtcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgbz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3B0JykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU0RjdGXHU3NTI4XHU1MTg1XHU3RjZFXHU3Q0JFXHU3QjgwXHU1MTg1XHU2ODM4Jyk+PTA7fSk7IGlmKG8pIG8uY2xpY2soKTsgfSkoKWApO1xuICAgICAgICBhd2FpdCBzbGVlcCgzMDApO1xuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTRFMEJcdTRFMDBcdTZCNjUnfHx4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTVGMDBcdTU5Q0JcdTVCODlcdTg4QzUnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcbiAgICAgICAgLy8gXHU5MTREXHU3RjZFXHU5ODc1OmZha2UgcHJvdmlkZXJzIFx1NURGMlx1NjcwOVx1NUJDNlx1OTRBNSBcdTIxOTIgXHU4MUVBXHU1MkE4XHU4REYzXHU4RkM3O1x1NTE1Q1x1NUU5NVx1NzBCOVwiXHU4REYzXHU4RkM3XCJcbiAgICAgICAgYXdhaXQgd2FpdEZvcignY29uZmlnIG9yIGRvbmUnLCBgdmFyIGQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLWRvbmUnKTtcbiAgICAgICAgICBpZihkKSByZXR1cm4ge29rOnRydWUsIGRldGFpbDonZG9uZSd9O1xuICAgICAgICAgIHZhciBjPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1jb25maWcnKTtcbiAgICAgICAgICBpZihjKXsgdmFyIHM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU4REYzXHU4RkM3Jyk+PTA7fSk7IGlmKHMpIHMuY2xpY2soKTsgfVxuICAgICAgICAgIHJldHVybiB7b2s6ZmFsc2UsIGRldGFpbDond2FpdGluZyd9O2AsIDE1XzAwMCk7XG4gICAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdkb25lIHBhZ2UnLCBgdmFyIGQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLWRvbmUnKTtcbiAgICAgICAgICB2YXIgdD1kP2QudGV4dENvbnRlbnQ6Jyc7XG4gICAgICAgICAgcmV0dXJuIHtvazogISFkICYmIHQuaW5kZXhPZignXHU1QzMxXHU3RUVBJyk+PTAgJiYgdC5pbmRleE9mKCdcdTUxNzFcdTRFQUInKT49MCwgZGV0YWlsOiB0LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw2MCl9O2AsIDhfMDAwKTtcbiAgICAgICAgYXdhaXQgc2hvdCgnd2l6YXJkLWRvbmUnKTtcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1RjAwXHU1OUNCXHU0RjdGXHU3NTI4Jzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XG4gICAgICAgIGNvbnN0IGNsb3NlZCA9IGF3YWl0IHdhaXRGb3IoJ3dpemFyZCBjbG9zZWQgKyBjb25uZWN0ZWQnLCBgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3ZlcmxheScpICYmICEhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmhvc3QtZG90Lm9uJyksXG4gICAgICAgICAgZGV0YWlsOiAnb3ZlcmxheT0nKyhkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKT8nb3Blbic6J2Nsb3NlZCcpKycgZG90PScrKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ob3N0LWRvdC5vbicpPydvbic6J29mZicpfTtgLCAxMF8wMDApO1xuICAgICAgICByZXR1cm4gW3dbMF0gJiYgY2xvc2VkWzBdLCBgZG9uZTogJHt3WzFdfTsgJHtjbG9zZWRbMV19YF07XG4gICAgICB9KTtcbiAgICB9XG5cbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU5OTk2XHU4REQxXHU1RjE1XHU1QkZDXHU1QzQyID09PT09PT09PT0gKi9cbiAgICBhd2FpdCBzdGVwKCdcdTVGMTVcdTVCRkNcdTVDNDI6XHU2RjE0XHU3OTNBXHU2QTIxXHU1RjBGXHU2M0QwXHU3OTNBXHU1MUZBXHU3M0IwXHU1RTc2XHU1M0VGXHU1MTczXHU5NUVEJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2d1aWRlJywgYHZhciBnPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ydW50aW1lLWd1aWRlJyk7IHJldHVybiB7b2s6ICEhZywgZGV0YWlsOiBnID8gJ3Nob3duJyA6ICdub3Qgc2hvd24nfTtgLCA4XzAwMCk7XG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpe1xuICAgICAgICB2YXIgYnRucyA9IFtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnJ1bnRpbWUtZ3VpZGUgYnV0dG9uJykpO1xuICAgICAgICB2YXIgYiA9IGJ0bnMuZmluZChmdW5jdGlvbih4KXsgcmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU2RjE0XHU3OTNBJykgPj0gMDsgfSk7XG4gICAgICAgIGlmIChiKSBiLmNsaWNrKCk7XG4gICAgICB9KSgpYCk7XG4gICAgICByZXR1cm4gd2FpdEZvcignZ3VpZGUgZ29uZScsIGByZXR1cm4ge29rOiAhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnJ1bnRpbWUtZ3VpZGUnKSwgZGV0YWlsOiBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcucnVudGltZS1ndWlkZScpID8gJ3N0aWxsJyA6ICdkaXNtaXNzZWQnfTtgLCA1XzAwMCk7XG4gICAgfSk7XG5cbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREKEN0cmwrTikgPT09PT09PT09PSAqL1xuICAgIGF3YWl0IHN0ZXAoJ0N0cmwrTiBcdTY1QjBcdTVFRkFcdTRGMUFcdThCREQsXHU4RjkzXHU1MTY1XHU2ODQ2XHU1M0VGXHU3NTI4JywgYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleTonbicsIGN0cmxLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XG4gICAgICByZXR1cm4gd2FpdEZvcigndGV4dGFyZWEgZW5hYmxlZCcsIGB2YXIgdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY29tcG9zZXIgdGV4dGFyZWEnKTtcbiAgICAgICAgcmV0dXJuIHtvazogISF0ICYmIHQuZGlzYWJsZWQgPT09IGZhbHNlICYmICh0LnBsYWNlaG9sZGVyfHwnJykuaW5kZXhPZignXHU2M0NGXHU4RkYwXHU3NkVFXHU2ODA3JykgPj0gMCwgZGV0YWlsOiB0ID8gKCdkaXNhYmxlZD0nK3QuZGlzYWJsZWQrJyBwaD0nKyh0LnBsYWNlaG9sZGVyfHwnJykuc2xpY2UoMCwyMCkpIDogJ25vIHRhJ307YCwgNV8wMDApO1xuICAgIH0pO1xuXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NTNEMVx1OTAwMVx1NEVGQlx1NTJBMSBcdTIxOTIgXHU3NTI4XHU2MjM3XHU4RjZFXHU1MUZBXHU3M0IwKFx1NEUxNFx1NEVDNVx1NEUwMFx1Njc2MSxcdTUzQ0NcdTZEODhcdTYwNkZcdTU2REVcdTVGNTIpID09PT09PT09PT0gKi9cbiAgICBhd2FpdCBzdGVwKCdcdThGOTNcdTUxNjVcdTVFNzZcdTUzRDFcdTkwMDFcdTRFRkJcdTUyQTEsXHU3NTI4XHU2MjM3XHU2RDg4XHU2MDZGXHU0RTBBXHU1QzRGXHU0RTE0XHU0RTBEXHU5MUNEXHU1OTBEJywgYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQgdHlwZUludG8oJy5jb21wb3NlciB0ZXh0YXJlYScsICdcdTlBOENcdTY1MzZcdTRFRkJcdTUyQTE6XHU1MTk5XHU1MTY1XHU0RTAwXHU0RTJBXHU2NTg3XHU0RUY2Jyk7XG4gICAgICBhd2FpdCBzbGVlcCgyMDApO1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpe1xuICAgICAgICB2YXIgYnRucyA9IFtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNvbXBvc2VyIGJ1dHRvbicpKTtcbiAgICAgICAgdmFyIGIgPSBidG5zLmZpbmQoZnVuY3Rpb24oeCl7IHJldHVybiB4LnRleHRDb250ZW50LnRyaW0oKSA9PT0gJ1x1NTNEMVx1OTAwMSc7IH0pO1xuICAgICAgICBpZiAoYikgYi5jbGljaygpO1xuICAgICAgfSkoKWApO1xuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2V4YWN0bHkgb25lIHVzZXIgdHVybicsIGB2YXIgdHM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudHVybi51c2VyJykpLmZpbHRlcihmdW5jdGlvbih4KXsgcmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU5QThDXHU2NTM2XHU0RUZCXHU1MkExJykgPj0gMDsgfSk7XG4gICAgICAgIHJldHVybiB7b2s6IHRzLmxlbmd0aCA9PT0gMSwgZGV0YWlsOiAnY291bnQ9Jyt0cy5sZW5ndGgrJyB0ZXh0PScrKHRzWzBdP3RzWzBdLnRleHRDb250ZW50LnNsaWNlKDAsMzApOidub25lJyl9O2AsIDhfMDAwKTtcbiAgICB9KTtcblxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTVERTVcdTUxNzdcdTUzNjEocmVhZF9maWxlIFx1NUI4Q1x1NjIxMCkgPT09PT09PT09PSAqL1xuICAgIGF3YWl0IHN0ZXAoJ1x1NURFNVx1NTE3N1x1NjI5OFx1NTNFMFx1NTM2MTpyZWFkX2ZpbGUgXHU2MjY3XHU4ODRDXHU1RTc2XHU1QjhDXHU2MjEwJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3Rvb2wgY2FyZCcsIGB2YXIgYz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50b29sLWNhcmQnKSk7XG4gICAgICAgIHZhciBkb25lID0gYy5maWx0ZXIoZnVuY3Rpb24oeCl7IHJldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ3JlYWRfZmlsZScpID49IDAgJiYgeC50ZXh0Q29udGVudC5pbmRleE9mKCcjIGRlbW8nKSA+PSAwOyB9KTtcbiAgICAgICAgcmV0dXJuIHtvazogZG9uZS5sZW5ndGggPj0gMSwgZGV0YWlsOiAnY2FyZHM9JytjLmxlbmd0aCsnIGRvbmU9Jytkb25lLmxlbmd0aH07YCwgOF8wMDApO1xuICAgICAgcmV0dXJuIHc7XG4gICAgfSk7XG5cbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU1QkExXHU2Mjc5XHU3RUI1XHU1MjA3XHU3MjQ3KFx1NzUyOFx1NjIzN1x1NjJBNVx1OTY5Q1x1NjgzOFx1NUZDM1x1NEU0Qlx1NEUwMCkgPT09PT09PT09PSAqL1xuICAgIGF3YWl0IHN0ZXAoJ1x1NUJBMVx1NjI3OTphcHByb3ZhbCBcdTUzNjFcdTUxRkFcdTczQjAoXHU3QjQ5XHU1Rjg1XHU0RUJBXHU1REU1XHU2Mjc5XHU1MUM2KScsIGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IHNob3QoJ2FwcHJvdmFsLXBlbmRpbmcnKTtcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdhcHByb3ZhbCBjYXJkJywgYHZhciBhPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5hcHByb3ZhbC1jYXJkJyk7XG4gICAgICAgIHJldHVybiB7b2s6ICEhYSAmJiBhLnRleHRDb250ZW50LmluZGV4T2YoJ1x1OTcwMFx1ODk4MVx1NUJBMVx1NjI3OScpID49IDAsIGRldGFpbDogYSA/IGEudGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLCA2MCkgOiAnbm8gYXBwcm92YWwgY2FyZCd9O2AsIDhfMDAwKTtcbiAgICB9KTtcbiAgICBhd2FpdCBzdGVwKCdcdTVCQTFcdTYyNzk6XHU3MEI5XHU2Mjc5XHU1MUM2IFx1MjE5MiBcdTRFRkJcdTUyQTFcdTdFRTdcdTdFRURcdTUyMzBcdTRFQTRcdTRFRDhcdTcyNjkrXHU2QzQ3XHU2MDNCJywgYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpe1xuICAgICAgICB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5hcHByb3ZhbC1jYXJkIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpeyByZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU2Mjc5XHU1MUM2JzsgfSk7XG4gICAgICAgIGlmIChiKSBiLmNsaWNrKCk7XG4gICAgICB9KSgpYCk7XG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignYXJ0aWZhY3Qrc3VtJywgYHZhciBhcnQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmFydGlmYWN0LWNhcmQnKTtcbiAgICAgICAgdmFyIHN1bT1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudHVybi1zdW0nKTtcbiAgICAgICAgdmFyIGFzdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50dXJuJykpLmZpbHRlcihmdW5jdGlvbih4KXsgcmV0dXJuIHguY2xhc3NOYW1lLmluZGV4T2YoJ3VzZXInKTwwICYmIHgudGV4dENvbnRlbnQuaW5kZXhPZignZWNobzonKT49MDsgfSk7XG4gICAgICAgIHJldHVybiB7b2s6ICEhYXJ0ICYmICEhc3VtICYmIGFzdC5sZW5ndGg+PTEsIGRldGFpbDogJ2FydGlmYWN0PScrKGFydD9hcnQudGV4dENvbnRlbnQuc2xpY2UoMCwzMCk6J25vbmUnKSsnIHN1bT0nKyhzdW0/c3VtLnRleHRDb250ZW50Oidub25lJykrJyBhbnN3ZXJlZD0nK2FzdC5sZW5ndGh9O2AsIDEyXzAwMCk7XG4gICAgICBhd2FpdCBzaG90KCdydW4tY29tcGxldGVkJyk7XG4gICAgICByZXR1cm4gdztcbiAgICB9KTtcblxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTUzODZcdTUzRjJcdTRGMUFcdThCRERcdTUxODVcdTVCQjkoXHU3NTI4XHU2MjM3XHU2MkE1XHU5NjlDXCJcdTc3MEJcdTRFMERcdTUyMzBcdTUxODVcdTVCQjlcIikgPT09PT09PT09PSAqL1xuICAgIGF3YWl0IHN0ZXAoJ1x1NzBCOVx1NTFGQlx1NTM4Nlx1NTNGMlx1NEYxQVx1OEJERCBcdTIxOTIgdHJhbnNjcmlwdCBcdTUxODVcdTVCQjlcdTUzRUZcdTg5QzEnLCBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBpdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2Vzc2lvbi1pdGVtJyk7IGlmIChpdCkgaXQuY2xpY2soKTsgfSkoKWApO1xuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2hpc3RvcnkgdHVybnMnLCBgdmFyIHRzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnR1cm4nKSk7XG4gICAgICAgIHJldHVybiB7b2s6IHRzLmxlbmd0aCA+PSAyLCBkZXRhaWw6ICd0dXJucz0nK3RzLmxlbmd0aCsnIGZpcnN0PScrKHRzWzBdP3RzWzBdLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw0MCk6J25vbmUnKX07YCwgOF8wMDApO1xuICAgIH0pO1xuXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NEU5NFx1OTg3NVx1N0I3RSA9PT09PT09PT09ICovXG4gICAgYXdhaXQgc3RlcCgnRG9jazpPdmVydmlldyBcdTY1NzBcdTYzNkVcdTg4NEMnLCBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nT3ZlcnZpZXcnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdvdmVydmlldyByb3dzJywgYHZhciByb3dzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stcm93JykpO1xuICAgICAgICB2YXIgdmVyID0gcm93cy5maW5kKGZ1bmN0aW9uKHIpeyByZXR1cm4gci50ZXh0Q29udGVudC5pbmRleE9mKCdydW50aW1lIFx1NzI0OFx1NjcyQycpPj0wOyB9KTtcbiAgICAgICAgcmV0dXJuIHtvazogcm93cy5sZW5ndGggPj0gNSAmJiAhIXZlciwgZGV0YWlsOiAncm93cz0nK3Jvd3MubGVuZ3RoKyh2ZXI/JyB2ZXI9Jyt2ZXIudGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDQwKTonJyl9O2AsIDZfMDAwKTtcbiAgICB9KTtcbiAgICBhd2FpdCBzdGVwKCdEb2NrOkZpbGVzIFx1NkQ0Rlx1ODlDOCtcdTY1ODdcdTRFRjZcdTk4ODRcdTg5QzgnLCBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nXHU2NTg3XHU0RUY2J3x8eC50ZXh0Q29udGVudD09PSdGaWxlcyc7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2ZzIHJvd3MnLCBgdmFyIHJvd3M9ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmZzLXJvdycpLmxlbmd0aDtcbiAgICAgICAgcmV0dXJuIHtvazogcm93cyA+PSAxLCBkZXRhaWw6ICdyb3dzPScrcm93c307YCwgNl8wMDApO1xuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcbiAgICAgIC8vIFx1NjgzOVx1NzZFRVx1NUY1NVx1NTNFQVx1NjcwOVx1NURFNVx1NEY1Q1x1NTMzQVx1NzZFRVx1NUY1NShmYWtlIFx1NEUwRVx1NzcxRlx1NUI5RSBydW50aW1lIFx1NTQwQ1x1NUY2Mik6XHU1MTQ4XHU4RkRCXHU3NkVFXHU1RjU1LFx1NTE4RFx1NzBCOVx1NjU4N1x1NEVGNlxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgZD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5mcy1yb3cnKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdkZW1vLXdvcmtzcGFjZScpPj0wIHx8IHgudGV4dENvbnRlbnQuaW5kZXhPZignXHVEODNEXHVEQ0MxJyk+PTA7fSk7IGlmKGQpIGQuY2xpY2soKTsgfSkoKWApO1xuICAgICAgY29uc3QgdzIgPSBhd2FpdCB3YWl0Rm9yKCdmaWxlIHJvd3MnLCBgdmFyIHJvd3M9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZnMtcm93JykpO1xuICAgICAgICByZXR1cm4ge29rOiByb3dzLnNvbWUoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignUkVBRE1FJyk+PTA7fSksIGRldGFpbDogJ3Jvd3M9Jytyb3dzLmxlbmd0aH07YCwgNl8wMDApO1xuICAgICAgaWYgKCF3MlswXSkgcmV0dXJuIHcyO1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgZj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5mcy1yb3cnKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdSRUFETUUnKT49MDt9KTsgaWYoZikgZi5jbGljaygpOyB9KSgpYCk7XG4gICAgICByZXR1cm4gd2FpdEZvcignZmlsZSBwcmV2aWV3JywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5mcy1wcmV2aWV3Jyk7XG4gICAgICAgIHJldHVybiB7b2s6ICEhcCAmJiBwLnRleHRDb250ZW50LmluZGV4T2YoJ2RlbW8gd29ya3NwYWNlJykgPj0gMCwgZGV0YWlsOiBwID8gcC50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNDApIDogJ25vIHByZXZpZXcnfTtgLCA2XzAwMCk7XG4gICAgfSk7XG4gICAgYXdhaXQgc3RlcCgnRG9jazpEaWZmIFx1NTNEOFx1NjZGNFx1ODg0QycsIGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdcdTUzRDhcdTY2RjQnfHx4LnRleHRDb250ZW50PT09J0RpZmYnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdkaWZmIHJvd3MnLCBgdmFyIHJvd3M9ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRpZmYtcm93JykubGVuZ3RoO1xuICAgICAgICByZXR1cm4ge29rOiByb3dzID49IDEsIGRldGFpbDogJ2RpZmYgcm93cz0nK3Jvd3N9O2AsIDZfMDAwKTtcbiAgICB9KTtcbiAgICBhd2FpdCBzdGVwKCdEb2NrOkV2aWRlbmNlIFx1OEJBNFx1NzdFNVx1NjU3MFx1NjM2RScsIGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdcdThCQzFcdTYzNkUnfHx4LnRleHRDb250ZW50PT09J0V2aWRlbmNlJzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XG4gICAgICByZXR1cm4gd2FpdEZvcignZXZpZGVuY2Ugcm93cycsIGB2YXIgcm93cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXJvdycpKTtcbiAgICAgICAgdmFyIG1lbSA9IHJvd3MuZmluZChmdW5jdGlvbihyKXsgcmV0dXJuIHIudGV4dENvbnRlbnQuaW5kZXhPZignXHU4QkIwXHU1RkM2XHU1QzQyJyk+PTAgfHwgci50ZXh0Q29udGVudC5pbmRleE9mKCdNZW1vcnkgbGF5ZXJzJyk+PTA7IH0pO1xuICAgICAgICByZXR1cm4ge29rOiAhIW1lbSAmJiBtZW0udGV4dENvbnRlbnQuaW5kZXhPZignMycpID49IDAsIGRldGFpbDogbWVtID8gbWVtLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykgOiAnbm8gbWVtb3J5IHJvdyd9O2AsIDZfMDAwKTtcbiAgICB9KTtcbiAgICBhd2FpdCBzdGVwKCdEb2NrOkxvZ3MgXHU5NzYyXHU2NzdGKFx1N0E3QVx1NjAwMVx1NjNEMFx1NzkzQSknLCBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nXHU2NUU1XHU1RkQ3J3x8eC50ZXh0Q29udGVudD09PSdMb2dzJzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignbG9ncyBwYW5lJywgYHZhciBsPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5sb2dzLWxpc3QnKTtcbiAgICAgICAgcmV0dXJuIHtvazogISFsLCBkZXRhaWw6IGwgPyAoJ3Jvd3M9JytsLnF1ZXJ5U2VsZWN0b3JBbGwoJy5sb2ctcm93JykubGVuZ3RoKSA6ICdubyBsb2dzIGxpc3QnfTtgLCA1XzAwMCk7XG4gICAgICByZXR1cm4gdztcbiAgICB9KTtcblxuICAgIC8qID09PT09PT09PT0gZmFrZTpEb2NrOlx1OEZEQ1x1N0EwQlx1OTg3NVx1N0I3RShcdTYyNEJcdTY3M0FcdThGRENcdTdBMEJcdTYzQTdcdTUyMzZcdTk3NjJcdTY3N0YrXHU1RjAwXHU2NzNBXHU4MUVBXHU1NDJGXHU4ODRDKSA9PT09PT09PT09ICovXG4gICAgYXdhaXQgc3RlcCgnRG9jazpcdThGRENcdTdBMEJcdTk4NzVcdTdCN0UoXHU2MjRCXHU2NzNBXHU4RkRDXHU3QTBCXHU2M0E3XHU1MjM2XHU5NzYyXHU2NzdGKScsIGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdcdThGRENcdTdBMEInfHx4LnRleHRDb250ZW50PT09J1JlbW90ZSc7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xuICAgICAgcmV0dXJuIHdhaXRGb3IoJ3JlbW90ZSBwYW5lJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5kb2NrLWJvZHknKTtcbiAgICAgICAgdmFyIHQgPSBwID8gcC50ZXh0Q29udGVudCA6ICcnO1xuICAgICAgICB2YXIgb2tUID0gdC5pbmRleE9mKCdcdTYyNEJcdTY3M0FcdThGRENcdTdBMEJcdTYzQTdcdTUyMzYnKT49MCB8fCB0LmluZGV4T2YoJ1Bob25lIHJlbW90ZScpPj0wO1xuICAgICAgICB2YXIgb2tBID0gdC5pbmRleE9mKCdcdTVGMDBcdTY3M0FcdTgxRUFcdTU0MkYnKT49MCB8fCB0LmluZGV4T2YoJ0F1dG9zdGFydCcpPj0wO1xuICAgICAgICByZXR1cm4ge29rOiAhIXAgJiYgb2tUICYmIG9rQSwgZGV0YWlsOiB0LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw2MCl9O2AsIDZfMDAwKTtcbiAgICB9KTtcblxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTY0MUNcdTdEMjJcdThGQzdcdTZFRTQgPT09PT09PT09PSAqL1xuICAgIGF3YWl0IHN0ZXAoJ1x1NEYxQVx1OEJERFx1NjQxQ1x1N0QyMjpcdThGQzdcdTZFRTRcdTc1MUZcdTY1NDgnLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBiZWZvcmUgPSAoYXdhaXQganMoYGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGhgKSkgYXMgbnVtYmVyO1xuICAgICAgYXdhaXQgdHlwZUludG8oJy5zZXNzaW9uLXNlYXJjaCcsICd6enotXHU0RTBEXHU1QjU4XHU1NzI4XHU3Njg0XHU0RjFBXHU4QkREJyk7XG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignZmlsdGVyZWQgZW1wdHknLCBgdmFyIG49ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aDtcbiAgICAgICAgcmV0dXJuIHtvazogbiA9PT0gMCwgZGV0YWlsOiAnYWZ0ZXI9JytufTtgLCA1XzAwMCk7XG4gICAgICBhd2FpdCB0eXBlSW50bygnLnNlc3Npb24tc2VhcmNoJywgJycpO1xuICAgICAgYXdhaXQgc2xlZXAoNDAwKTtcbiAgICAgIGNvbnN0IGFmdGVyID0gKGF3YWl0IGpzKGBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoYCkpIGFzIG51bWJlcjtcbiAgICAgIHJldHVybiBbd1swXSAmJiBhZnRlciA9PT0gYmVmb3JlLCBgJHt3WzFdfTsgXHU2MDYyXHU1OTBEXHU1NDBFICR7YWZ0ZXJ9PT09JHtiZWZvcmV9YF07XG4gICAgfSk7XG5cbiAgICAvKiA9PT09PT09PT09IGZha2U6Q3RybCtLIFx1NTQ3RFx1NEVFNFx1OTc2Mlx1Njc3RiA9PT09PT09PT09ICovXG4gICAgYXdhaXQgc3RlcCgnQ3RybCtLIFx1NTQ3RFx1NEVFNFx1OTc2Mlx1Njc3RjpcdTYyNTNcdTVGMDBcdTVFNzZcdTYyNjdcdTg4NENcdTU0N0RcdTRFRTQnLCBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidrJywgY3RybEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdjbWRrIG9wZW4nLCBgdmFyIGM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNtZGsnKTtcbiAgICAgICAgcmV0dXJuIHtvazogISFjLCBkZXRhaWw6IGMgPyAnb3BlbicgOiAnbm90IG9wZW4nfTtgLCA1XzAwMCk7XG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgaXQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY21kay1pdGVtJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU2NTg3XHU0RUY2Jyk+PTAgfHwgeC50ZXh0Q29udGVudC5pbmRleE9mKCdGaWxlcycpPj0wO30pOyBpZihpdCkgaXQuY2xpY2soKTsgfSkoKWApO1xuICAgICAgcmV0dXJuIHdhaXRGb3IoJ3RhYiBzd2l0Y2hlZCcsIGB2YXIgdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuZG9jay10YWIuYWN0aXZlJyk7XG4gICAgICAgIHJldHVybiB7b2s6ICEhdCAmJiAodC50ZXh0Q29udGVudD09PSdcdTY1ODdcdTRFRjYnfHx0LnRleHRDb250ZW50PT09J0ZpbGVzJyksIGRldGFpbDogJ2FjdGl2ZT0nKyh0P3QudGV4dENvbnRlbnQ6J25vbmUnKX07YCwgNV8wMDApO1xuICAgIH0pO1xuXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1OEJCRVx1N0Y2RVx1OTc2Mlx1Njc3RiA9PT09PT09PT09ICovXG4gICAgYXdhaXQgc3RlcCgnXHU4QkJFXHU3RjZFKEN0cmwrU2hpZnQrUCk6UHJvdmlkZXIgXHU4ODY4XHU1MzU1XHU1M0VGXHU4OUMxLEVzYyBcdTUxNzNcdTk1RUQnLCBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidwJywgY3RybEtleTp0cnVlLCBzaGlmdEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdzZXR0aW5ncyBvcGVuJywgYHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrLnNldHRpbmdzJyk7XG4gICAgICAgIHJldHVybiB7b2s6ICEhcyAmJiAhIXMucXVlcnlTZWxlY3RvcignLnByb3ZpZGVyLWZvcm0nKSwgZGV0YWlsOiBzID8gJ29wZW4rZm9ybScgOiAnbm90IG9wZW4nfTtgLCA1XzAwMCk7XG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleTonRXNjYXBlJywgYnViYmxlczp0cnVlfSkpYCk7XG4gICAgICByZXR1cm4gd2FpdEZvcignc2V0dGluZ3MgY2xvc2VkJywgYHJldHVybiB7b2s6ICFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kay1vdmVybGF5JyksIGRldGFpbDogJ2Nsb3NlZCd9O2AsIDVfMDAwKTtcbiAgICB9KTtcblxuICAgIC8qID09PT09PT09PT0gZmFrZTppMThuIFx1OEJFRFx1OEEwMFx1NTIwN1x1NjM2MiA9PT09PT09PT09ICovXG4gICAgYXdhaXQgc3RlcCgnXHU4QkVEXHU4QTAwXHU1MjA3XHU2MzYyOlx1NEUyRFx1NjU4NyBcdTIxOTIgRW5nbGlzaCBcdTIxOTIgXHU2MDYyXHU1OTBEXHU0RTJEXHU2NTg3JywgYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleToncCcsIGN0cmxLZXk6dHJ1ZSwgc2hpZnRLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignc2V0dGluZ3Mgb3BlbicsIGB2YXIgcz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kay5zZXR0aW5ncycpO1xuICAgICAgICByZXR1cm4ge29rOiAhIXMsIGRldGFpbDogcyA/ICdvcGVuJyA6ICdub3Qgb3Blbid9O2AsIDVfMDAwKTtcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNtZGsuc2V0dGluZ3MgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J0VuZ2xpc2gnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIGNvbnN0IGVuID0gYXdhaXQgd2FpdEZvcignZW5nbGlzaCBzaG93bicsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhci1oZWFkIC5idG4ucHJpbWFyeScpO1xuICAgICAgICByZXR1cm4ge29rOiAhIWIgJiYgYi50ZXh0Q29udGVudCA9PT0gJysgTmV3IFNlc3Npb24nLCBkZXRhaWw6ICdidG49JysoYj9iLnRleHRDb250ZW50Oidub25lJyl9O2AsIDVfMDAwKTtcbiAgICAgIGF3YWl0IHNob3QoJ2VuZ2xpc2gnKTtcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY21kay5zZXR0aW5ncyBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU0RTJEXHU2NTg3Jzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XG4gICAgICBjb25zdCB6aCA9IGF3YWl0IHdhaXRGb3IoJ2NoaW5lc2UgYmFjaycsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhci1oZWFkIC5idG4ucHJpbWFyeScpO1xuICAgICAgICByZXR1cm4ge29rOiAhIWIgJiYgYi50ZXh0Q29udGVudCA9PT0gJysgXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREJywgZGV0YWlsOiAnYnRuPScrKGI/Yi50ZXh0Q29udGVudDonbm9uZScpfTtgLCA1XzAwMCk7XG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidFc2NhcGUnLCBidWJibGVzOnRydWV9KSlgKTtcbiAgICAgIHJldHVybiBbZW5bMF0gJiYgemhbMF0sIGBlbjogJHtlblsxXX07IHpoOiAke3poWzFdfWBdO1xuICAgIH0pO1xuXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NURFNVx1NEY1Q1x1NTMzQVx1N0JBMVx1NzQwNihcdTVERTZcdTY4MEZcdTY4MEZcdTRGNEQgKyBcdTgzRENcdTUzNTUgKyBcdTY1QjBcdTVFRkFcdTRGMUFcdThCRERcdTkwMDlcdTVERTVcdTRGNUNcdTUzM0EpID09PT09PT09PT0gKi9cbiAgICBhd2FpdCBzdGVwKCdcdTVERTVcdTRGNUNcdTUzM0E6XHU1REU2XHU2ODBGXHU1REU1XHU0RjVDXHU1MzNBXHU2ODBGXHU1M0VGXHU4OUMxKFx1NUY1M1x1NTI0RFx1NURFNVx1NEY1Q1x1NTMzQVx1NTQwRCknLCBhc3luYyAoKSA9PiB7XG4gICAgICByZXR1cm4gd2FpdEZvcignd29ya3NwYWNlIGJhcicsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud29ya3NwYWNlLWJhcicpO1xuICAgICAgICB2YXIgbiA9IGIgPyAoYi5xdWVyeVNlbGVjdG9yKCcud3MtYmFyLW5hbWUnKXx8e30pLnRleHRDb250ZW50IDogJyc7XG4gICAgICAgIHJldHVybiB7b2s6ICEhYiAmJiAhIW4gJiYgbi5sZW5ndGggPiAwICYmIG4uaW5kZXhPZignXHU1MkEwXHU4RjdEJykgPCAwLCBkZXRhaWw6ICdiYXI9JysoYj8neWVzJzonbm8nKSsnIG5hbWU9JytufTtgLCA4XzAwMCk7XG4gICAgfSk7XG4gICAgYXdhaXQgc3RlcCgnXHU1REU1XHU0RjVDXHU1MzNBOlx1ODNEQ1x1NTM1NVx1NUYzOVx1NTFGQSxcdTUyMTdcdTg4NjgrXHU1RjUzXHU1MjREXHU5QUQ4XHU0RUFFK1x1NkRGQlx1NTJBMFx1NTE2NVx1NTNFMztcdTU3MjhcdTYzMDdcdTVCOUFcdTVERTVcdTRGNUNcdTUzM0FcdTY1QjBcdTVFRkFcdTRGMUFcdThCREQnLCBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53b3Jrc3BhY2UtYmFyJyk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3dzIG1lbnUnLCBgdmFyIG09ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLW1lbnUnKTtcbiAgICAgICAgdmFyIGl0ZW1zID0gbSA/IG0ucXVlcnlTZWxlY3RvckFsbCgnLndzLW1lbnUtaXRlbScpLmxlbmd0aCA6IDA7XG4gICAgICAgIHZhciBjdXIgPSBtID8gbS5xdWVyeVNlbGVjdG9yQWxsKCcud3MtbWVudS1pdGVtLmN1cnJlbnQnKS5sZW5ndGggOiAwO1xuICAgICAgICB2YXIgYWRkID0gbSA/IChtLnRleHRDb250ZW50LmluZGV4T2YoJ1x1NkRGQlx1NTJBMFx1NURFNVx1NEY1Q1x1NTMzQScpPj0wIHx8IG0udGV4dENvbnRlbnQuaW5kZXhPZignQWRkIHdvcmtzcGFjZScpPj0wKSA6IGZhbHNlO1xuICAgICAgICByZXR1cm4ge29rOiBpdGVtcyA+PSAxICYmIGN1ciA+PSAxICYmIGFkZCwgZGV0YWlsOiAnaXRlbXM9JytpdGVtcysnIGN1cnJlbnQ9JytjdXIrJyBhZGQ9JythZGR9O2AsIDZfMDAwKTtcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XG4gICAgICBhd2FpdCBzaG90KCd3cy1tZW51Jyk7XG4gICAgICAvLyBcdTcwQjlcdTdCMkNcdTRFMDBcdTRFMkFcdTVERTVcdTRGNUNcdTUzM0FcdTk4NzkgPSBcdTU3MjhcdThCRTVcdTVERTVcdTRGNUNcdTUzM0FcdTY1QjBcdTVFRkFcdTRGMUFcdThCREQoXHU4M0RDXHU1MzU1XHU1MTczXHU5NUVEXHUzMDAxY29tcG9zZXIgXHU1M0VGXHU3NTI4KVxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgaXQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLW1lbnUtaXRlbScpOyBpZihpdCkgaXQuY2xpY2soKTsgfSkoKWApO1xuICAgICAgY29uc3QgY2xvc2VkID0gYXdhaXQgd2FpdEZvcignbWVudSBjbG9zZWQgKyBzZXNzaW9uIGFjdGl2ZScsIGB2YXIgdGE9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNvbXBvc2VyIHRleHRhcmVhJyk7XG4gICAgICAgIHJldHVybiB7b2s6ICFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtbWVudScpICYmICEhdGEgJiYgdGEuZGlzYWJsZWQgPT09IGZhbHNlLCBkZXRhaWw6ICdtZW51PScrKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1tZW51Jyk/J29wZW4nOidjbG9zZWQnKSsnIHRhPScrKHRhP3RhLmRpc2FibGVkOidub25lJyl9O2AsIDZfMDAwKTtcbiAgICAgIHJldHVybiBbY2xvc2VkWzBdLCBgJHt3WzFdfTsgJHtjbG9zZWRbMV19YF07XG4gICAgfSk7XG5cbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU0RjFBXHU4QkREXHU2MzA5XHU1REU1XHU0RjVDXHU1MzNBXHU1MjA2XHU3RUM0ICsgXHU1QzU1XHU1RjAwL1x1NjUzNlx1OEQ3NyA9PT09PT09PT09ICovXG4gICAgYXdhaXQgc3RlcCgnXHU0RjFBXHU4QkREXHU1MjA2XHU3RUM0Olx1N0VDNFx1NTkzNFx1NTFGQVx1NzNCMChcdTVERTVcdTRGNUNcdTUzM0FcdTU0MEQrXHU2NTcwXHU5MUNGKScsIGFzeW5jICgpID0+IHtcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdncm91cCBoZWFkJywgYHZhciBoPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1ncm91cC1oZWFkJyk7XG4gICAgICAgIHZhciBuID0gaCA/IChoLnF1ZXJ5U2VsZWN0b3IoJy53cy1ncm91cC1uYW1lJyl8fHt9KS50ZXh0Q29udGVudCA6ICcnO1xuICAgICAgICB2YXIgYyA9IGggPyAoaC5xdWVyeVNlbGVjdG9yKCcud3MtZ3JvdXAtY291bnQnKXx8e30pLnRleHRDb250ZW50IDogJyc7XG4gICAgICAgIHJldHVybiB7b2s6ICEhaCAmJiBuLmxlbmd0aCA+IDAgJiYgYy5sZW5ndGggPiAwLCBkZXRhaWw6ICduYW1lPScrbisnIGNvdW50PScrY307YCwgOF8wMDApO1xuICAgIH0pO1xuICAgIGF3YWl0IHN0ZXAoJ1x1NEYxQVx1OEJERFx1NTIwNlx1N0VDNDpcdTcwQjlcdTUxRkJcdTdFQzRcdTU5MzRcdTY1MzZcdThENzcsXHU1MThEXHU3MEI5XHU1QzU1XHU1RjAwXHU2MDYyXHU1OTBEJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgYmVmb3JlID0gKGF3YWl0IGpzKGBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoYCkpIGFzIG51bWJlcjtcbiAgICAgIGlmIChiZWZvcmUgPT09IDApIHJldHVybiBbZmFsc2UsICdubyBzZXNzaW9ucyB0byBncm91cCddO1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgaD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtZ3JvdXAtaGVhZCcpOyBpZihoKSBoLmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIGNvbnN0IGNvbGxhcHNlZCA9IGF3YWl0IHdhaXRGb3IoJ2NvbGxhcHNlZCcsIGB2YXIgZz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtZ3JvdXAnKTtcbiAgICAgICAgdmFyIGhpZGRlbiA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGggPCAke2JlZm9yZX07XG4gICAgICAgIHJldHVybiB7b2s6IGhpZGRlbiwgZGV0YWlsOiAnaXRlbXM9Jytkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoKycgYmVmb3JlPSR7YmVmb3JlfSd9O2AsIDVfMDAwKTtcbiAgICAgIGF3YWl0IHNob3QoJ3dzLWdyb3VwLWNvbGxhcHNlZCcpO1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgaD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtZ3JvdXAtaGVhZCcpOyBpZihoKSBoLmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIGNvbnN0IGV4cGFuZGVkID0gYXdhaXQgd2FpdEZvcignZXhwYW5kZWQgYmFjaycsIGB2YXIgbj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoO1xuICAgICAgICByZXR1cm4ge29rOiBuID49ICR7YmVmb3JlfSwgZGV0YWlsOiAnaXRlbXM9JytufTtgLCA1XzAwMCk7XG4gICAgICByZXR1cm4gW2NvbGxhcHNlZFswXSAmJiBleHBhbmRlZFswXSwgYGNvbGxhcHNlOiAke2NvbGxhcHNlZFsxXX07IGV4cGFuZDogJHtleHBhbmRlZFsxXX1gXTtcbiAgICB9KTtcblxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTVGRUJcdTYzNzdcdTk1MkVcdTVFMkVcdTUyQTlcdTk3NjJcdTY3N0YoQ3RybCsvKSA9PT09PT09PT09ICovXG4gICAgYXdhaXQgc3RlcCgnXHU1RkVCXHU2Mzc3XHU5NTJFXHU1RTJFXHU1MkE5OkN0cmwrLyBcdTYyNTNcdTVGMDAsRXNjIFx1NTE3M1x1OTVFRCcsIGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6Jy8nLCBjdHJsS2V5OnRydWUsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3Nob3J0Y3V0cyBvcGVuJywgYHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrJyk7XG4gICAgICAgIHZhciByb3dzID0gcyA/IHMucXVlcnlTZWxlY3RvckFsbCgnLnNob3J0Y3V0LXJvdycpLmxlbmd0aCA6IDA7XG4gICAgICAgIHJldHVybiB7b2s6IHJvd3MgPj0gNSwgZGV0YWlsOiAncm93cz0nK3Jvd3N9O2AsIDVfMDAwKTtcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XG4gICAgICBhd2FpdCBzaG90KCdzaG9ydGN1dHMnKTtcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J0VzY2FwZScsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xuICAgICAgcmV0dXJuIHdhaXRGb3IoJ3Nob3J0Y3V0cyBjbG9zZWQnLCBgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrLW92ZXJsYXknKSwgZGV0YWlsOiAnY2xvc2VkJ307YCwgNV8wMDApO1xuICAgIH0pO1xuXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NEZBN1x1NjgwRlx1NjUzNlx1N0YyOSArIFx1NzJCNlx1NjAwMVx1OEZDN1x1NkVFNCA9PT09PT09PT09ICovXG4gICAgYXdhaXQgc3RlcCgnXHU0RkE3XHU2ODBGXHU2NTM2XHU3RjI5Olx1MjFFNCBcdTY1MzZcdThENzdcdTVERTZcdTY4MEYsXHUyMUU1IFx1NUM1NVx1NUYwMFx1NjA2Mlx1NTkwRCcsIGFzeW5jICgpID0+IHtcbiAgICAgIC8vIEhJRyBQMyBcdTdFQzQyOlx1MjFFNC9cdTIxRTUgRW1vamkgXHU1REYyXHU2MzYyIFNWRyBpY29uLFx1NjMwOVx1OTRBRVx1NEVFNSBhcmlhLWxhYmVsKFx1NTQyQlwiXHU0RkE3XHU2ODBGXCIpXHU1QjlBXHU0RjREXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcigndG9nZ2xlIGJ0bicsIGB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50b3BiYXIgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuICh4LmdldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcpfHwnJykuaW5kZXhPZignXHU0RkE3XHU2ODBGJyk+PTA7fSk7XG4gICAgICAgIHJldHVybiB7b2s6ICEhYiwgZGV0YWlsOiAnYnRuPScrKGI/Yi5nZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnKTonbm9uZScpfTtgLCA1XzAwMCk7XG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50b3BiYXIgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuICh4LmdldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcpfHwnJykuaW5kZXhPZignXHU0RkE3XHU2ODBGJyk+PTA7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xuICAgICAgY29uc3QgaGlkZGVuID0gYXdhaXQgd2FpdEZvcignc2lkZWJhciBoaWRkZW4nLCBgdmFyIHNiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyJyk7XG4gICAgICAgIHZhciBnb25lID0gIXNiIHx8IGdldENvbXB1dGVkU3R5bGUoc2IpLmRpc3BsYXkgPT09ICdub25lJztcbiAgICAgICAgcmV0dXJuIHtvazogZ29uZSwgZGV0YWlsOiAnZGlzcGxheT0nKyhzYj9nZXRDb21wdXRlZFN0eWxlKHNiKS5kaXNwbGF5Oidub25lJyl9O2AsIDVfMDAwKTtcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudG9wYmFyIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiAoeC5nZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnKXx8JycpLmluZGV4T2YoJ1x1NEZBN1x1NjgwRicpPj0wO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIGNvbnN0IHNob3duID0gYXdhaXQgd2FpdEZvcignc2lkZWJhciBiYWNrJywgYHZhciBzYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhcicpO1xuICAgICAgICByZXR1cm4ge29rOiAhIXNiICYmIGdldENvbXB1dGVkU3R5bGUoc2IpLmRpc3BsYXkgIT09ICdub25lJywgZGV0YWlsOiAnZGlzcGxheT0nKyhzYj9nZXRDb21wdXRlZFN0eWxlKHNiKS5kaXNwbGF5Oidub25lJyl9O2AsIDVfMDAwKTtcbiAgICAgIHJldHVybiBbaGlkZGVuWzBdICYmIHNob3duWzBdLCBgaGlkZTogJHtoaWRkZW5bMV19OyBzaG93OiAke3Nob3duWzFdfWBdO1xuICAgIH0pO1xuICAgIGF3YWl0IHN0ZXAoJ1x1NzJCNlx1NjAwMVx1OEZDN1x1NkVFNDpcdTRFMEJcdTYyQzlcdTUyMDdcdTYzNjJcdTUyMzBcIlx1OEZEMFx1ODg0Q1x1NEUyRFwiXHU0RTBEXHU1RDI5XHU2RTgzXHU1RTc2XHU2MDYyXHU1OTBEJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3Qgc2VsID0gYXdhaXQgd2FpdEZvcignZmlsdGVyIHNlbGVjdCcsIGB2YXIgcz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc3RhdHVzLWZpbHRlcicpO1xuICAgICAgICByZXR1cm4ge29rOiAhIXMgJiYgcy5vcHRpb25zLmxlbmd0aCA+PSA0LCBkZXRhaWw6ICdvcHRpb25zPScrKHM/cy5vcHRpb25zLmxlbmd0aDowKX07YCwgNV8wMDApO1xuICAgICAgaWYgKCFzZWxbMF0pIHJldHVybiBzZWw7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zdGF0dXMtZmlsdGVyJyk7IHMudmFsdWU9J3J1bm5pbmcnOyBzLmRpc3BhdGNoRXZlbnQobmV3IEV2ZW50KCdjaGFuZ2UnLHtidWJibGVzOnRydWV9KSk7IH0pKClgKTtcbiAgICAgIGF3YWl0IHNsZWVwKDUwMCk7XG4gICAgICBjb25zdCByMSA9IChhd2FpdCBqcyhgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aGApKSBhcyBudW1iZXI7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zdGF0dXMtZmlsdGVyJyk7IHMudmFsdWU9J2FsbCc7IHMuZGlzcGF0Y2hFdmVudChuZXcgRXZlbnQoJ2NoYW5nZScse2J1YmJsZXM6dHJ1ZX0pKTsgfSkoKWApO1xuICAgICAgYXdhaXQgc2xlZXAoNTAwKTtcbiAgICAgIGNvbnN0IHIyID0gKGF3YWl0IGpzKGBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoYCkpIGFzIG51bWJlcjtcbiAgICAgIHJldHVybiBbcjIgPj0gcjEgJiYgcjIgPj0gMSwgYHJ1bm5pbmc9JHtyMX0gYWxsPSR7cjJ9YF07XG4gICAgfSk7XG5cbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU2QTIxXHU1NzhCXHU5MDA5XHU2MkU5XHU1NjY4KFx1OTg3Nlx1NjgwRlx1NTIwN1x1NjM2MiBjaGF0IFx1OERFRlx1NzUzMSkgPT09PT09PT09PSAqL1xuICAgIGF3YWl0IHN0ZXAoJ1x1NkEyMVx1NTc4Qlx1OTAwOVx1NjJFOVx1NTY2ODpcdTk4NzZcdTY4MEZcdTgzRENcdTUzNTVcdTUyMTdcdTUxRkEgcHJvdmlkZXJzIFx1NUU3Nlx1NTNFRlx1NTIwN1x1NjM2MicsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdtb2RlbCBidXR0b24nLCBgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnRvcGJhci1tb2RlbC5hcy1idXR0b24nKTtcbiAgICAgICAgcmV0dXJuIHtvazogISFiICYmIGIuZGlzYWJsZWQgPT09IGZhbHNlLCBkZXRhaWw6IGIgPyBiLnRleHRDb250ZW50IDogJ25vbmUnfTtgLCA2XzAwMCk7XG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudG9wYmFyLW1vZGVsLmFzLWJ1dHRvbicpOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIGNvbnN0IG0gPSBhd2FpdCB3YWl0Rm9yKCdtb2RlbCBtZW51JywgYHZhciBtPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5tb2RlbC1tZW51Jyk7XG4gICAgICAgIHZhciBpdGVtcyA9IG0gPyBtLnF1ZXJ5U2VsZWN0b3JBbGwoJy53cy1tZW51LWl0ZW0nKS5sZW5ndGggOiAwO1xuICAgICAgICB2YXIgY3VyID0gbSA/IG0ucXVlcnlTZWxlY3RvckFsbCgnLndzLW1lbnUtaXRlbS5jdXJyZW50JykubGVuZ3RoIDogMDtcbiAgICAgICAgcmV0dXJuIHtvazogaXRlbXMgPj0gMiAmJiBjdXIgPj0gMSwgZGV0YWlsOiAnaXRlbXM9JytpdGVtcysnIGN1cnJlbnQ9JytjdXJ9O2AsIDVfMDAwKTtcbiAgICAgIGlmICghbVswXSkgcmV0dXJuIG07XG4gICAgICBhd2FpdCBzaG90KCdtb2RlbC1tZW51Jyk7XG4gICAgICAvLyBcdTUyMDdcdTUyMzBcdTdCMkNcdTRFOENcdTRFMkEgcHJvdmlkZXIoZmFrZTogZGVtby12aXNpb24vZmFrZS1tLXZpc2lvbilcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGl0cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5tb2RlbC1tZW51IC53cy1tZW51LWl0ZW0nKSk7IHZhciBpdD1pdHNbaXRzLmxlbmd0aC0xXTsgaWYoaXQpIGl0LmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdtb2RlbCBzd2l0Y2hlZCcsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudG9wYmFyLW1vZGVsLmFzLWJ1dHRvbicpO1xuICAgICAgICByZXR1cm4ge29rOiAhIWIgJiYgYi50ZXh0Q29udGVudC5pbmRleE9mKCdmYWtlLW0tdmlzaW9uJykgPj0gMCwgZGV0YWlsOiAnYmFkZ2U9JysoYj9iLnRleHRDb250ZW50Oidub25lJyl9O2AsIDZfMDAwKTtcbiAgICB9KTtcblxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTRFM0JcdTk4OTgoXHU2RDQ1XHU4MjcyXHU3NTFGXHU2NTQ4XHUyMTkyXHU2MDYyXHU1OTBEXHU2REYxXHU4MjcyKSA9PT09PT09PT09ICovXG4gICAgYXdhaXQgc3RlcCgnXHU0RTNCXHU5ODk4Olx1OEJCRVx1N0Y2RVx1NTIwN1x1NkQ0NVx1ODI3Mlx1NzUxRlx1NjU0OCxcdTYwNjJcdTU5MERcdTZERjFcdTgyNzInLCBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidwJywgY3RybEtleTp0cnVlLCBzaGlmdEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdzZXR0aW5ncyBvcGVuJywgYHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrLnNldHRpbmdzJyk7XG4gICAgICAgIHJldHVybiB7b2s6ICEhcywgZGV0YWlsOiBzID8gJ29wZW4nIDogJ25vdCBvcGVuJ307YCwgNV8wMDApO1xuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY21kay5zZXR0aW5ncyAuc2VnIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTZENDVcdTgyNzInfHx4LnRleHRDb250ZW50LnRyaW0oKT09PSdMaWdodCc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xuICAgICAgY29uc3QgbGlnaHQgPSBhd2FpdCB3YWl0Rm9yKCdsaWdodCB0aGVtZScsIGB2YXIgZHQ9ZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LmRhdGFzZXQudGhlbWU7XG4gICAgICAgIHZhciBiZyA9IGdldENvbXB1dGVkU3R5bGUoZG9jdW1lbnQuYm9keSkuYmFja2dyb3VuZENvbG9yO1xuICAgICAgICB2YXIgbSA9IC9cXFxcZCsvZzsgdmFyIG51bXM9KGJnLm1hdGNoKG0pfHxbJzAnLCcwJywnMCddKS5tYXAoTnVtYmVyKTtcbiAgICAgICAgcmV0dXJuIHtvazogZHQ9PT0nbGlnaHQnICYmIG51bXNbMF0+MjAwICYmIG51bXNbMV0+MjAwICYmIG51bXNbMl0+MjAwLCBkZXRhaWw6ICd0aGVtZT0nK2R0KycgYmc9JytiZ307YCwgNV8wMDApO1xuICAgICAgYXdhaXQgc2hvdCgnbGlnaHQtdGhlbWUnKTtcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY21kay5zZXR0aW5ncyAuc2VnIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTZERjFcdTgyNzInfHx4LnRleHRDb250ZW50LnRyaW0oKT09PSdEYXJrJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XG4gICAgICBjb25zdCBkYXJrID0gYXdhaXQgd2FpdEZvcignZGFyayBiYWNrJywgYHJldHVybiB7b2s6IGRvY3VtZW50LmRvY3VtZW50RWxlbWVudC5kYXRhc2V0LnRoZW1lPT09J2RhcmsnLCBkZXRhaWw6ICd0aGVtZT0nK2RvY3VtZW50LmRvY3VtZW50RWxlbWVudC5kYXRhc2V0LnRoZW1lfTtgLCA1XzAwMCk7XG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidFc2NhcGUnLCBidWJibGVzOnRydWV9KSlgKTtcbiAgICAgIHJldHVybiBbbGlnaHRbMF0gJiYgZGFya1swXSwgYGxpZ2h0OiAke2xpZ2h0WzFdfTsgZGFyazogJHtkYXJrWzFdfWBdO1xuICAgIH0pO1xuXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1OTg3Nlx1NjgwRiBcdTRFMkQvRU4gXHU1RkVCXHU2Mzc3XHU1MjA3XHU2MzYyKFx1NTNFRlx1NTNEMVx1NzNCMFx1NjAyNykgPT09PT09PT09PSAqL1xuICAgIGF3YWl0IHN0ZXAoJ1x1OTg3Nlx1NjgwRlx1NUZFQlx1NjM3N1x1NTIwN1x1NjM2MjpcdTRFMkQvRU4gXHU0RTAwXHU5NTJFXHU1MjA3XHU2MzYyJywgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2xhbmcgc2VnJywgYHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5sYW5nLXNlZycpO1xuICAgICAgICByZXR1cm4ge29rOiAhIXMgJiYgcy5xdWVyeVNlbGVjdG9yQWxsKCdidXR0b24nKS5sZW5ndGggPT09IDIsIGRldGFpbDogcyA/ICdwcmVzZW50JyA6ICdhYnNlbnQnfTtgLCA1XzAwMCk7XG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5sYW5nLXNlZyBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nRU4nO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIGNvbnN0IGVuID0gYXdhaXQgd2FpdEZvcignZW5nbGlzaCcsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhci1oZWFkIC5idG4ucHJpbWFyeScpO1xuICAgICAgICByZXR1cm4ge29rOiAhIWIgJiYgYi50ZXh0Q29udGVudCA9PT0gJysgTmV3IFNlc3Npb24nLCBkZXRhaWw6ICdidG49JysoYj9iLnRleHRDb250ZW50Oidub25lJyl9O2AsIDVfMDAwKTtcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcubGFuZy1zZWcgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NEUyRCc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xuICAgICAgY29uc3QgemggPSBhd2FpdCB3YWl0Rm9yKCdjaGluZXNlIGJhY2snLCBgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXItaGVhZCAuYnRuLnByaW1hcnknKTtcbiAgICAgICAgcmV0dXJuIHtvazogISFiICYmIGIudGV4dENvbnRlbnQgPT09ICcrIFx1NjVCMFx1NUVGQVx1NEYxQVx1OEJERCcsIGRldGFpbDogJ2J0bj0nKyhiP2IudGV4dENvbnRlbnQ6J25vbmUnKX07YCwgNV8wMDApO1xuICAgICAgcmV0dXJuIFtlblswXSAmJiB6aFswXSwgYGVuOiAke2VuWzFdfTsgemg6ICR7emhbMV19YF07XG4gICAgfSk7XG5cbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU3Qzk4XHU4RDM0XHU1NkZFXHU3MjQ3IFx1MjE5MiBcdTdGMjlcdTc1NjVcdTU2RkUgY2hpcCBcdTIxOTIgXHU1M0QxXHU5MDAxIFx1MjE5MiBydW50aW1lIFx1NjUzNlx1NTIzMCA9PT09PT09PT09ICovXG4gICAgYXdhaXQgc3RlcCgnXHU3Qzk4XHU4RDM0XHU1NkZFXHU3MjQ3Olx1N0YyOVx1NzU2NVx1NTZGRSBjaGlwICsgXHU1M0QxXHU5MDAxXHU1NDBFIHJ1bnRpbWUgXHU2NTM2XHU1MjMwXHU1NkZFXHU3MjQ3JywgYXN5bmMgKCkgPT4ge1xuICAgICAgLy8gXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREXHU3ODZFXHU0RkREIGNvbXBvc2VyIFx1NTNFRlx1NzUyOFxuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleTonbicsIGN0cmxLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XG4gICAgICBhd2FpdCBzbGVlcCgzMDApO1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpe1xuICAgICAgICB2YXIgdGEgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY29tcG9zZXIgdGV4dGFyZWEnKTtcbiAgICAgICAgaWYgKCF0YSkgcmV0dXJuO1xuICAgICAgICB2YXIgYyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2NhbnZhcycpO1xuICAgICAgICBjLndpZHRoID0gODsgYy5oZWlnaHQgPSA4O1xuICAgICAgICB2YXIgY3R4ID0gYy5nZXRDb250ZXh0KCcyZCcpO1xuICAgICAgICBjdHguZmlsbFN0eWxlID0gJyMzZjk2NTAnOyBjdHguZmlsbFJlY3QoMCwgMCwgOCwgOCk7XG4gICAgICAgIGMudG9CbG9iKGZ1bmN0aW9uKGJsb2Ipe1xuICAgICAgICAgIHZhciBkdCA9IG5ldyBEYXRhVHJhbnNmZXIoKTtcbiAgICAgICAgICBkdC5pdGVtcy5hZGQobmV3IEZpbGUoW2Jsb2JdLCAncGFzdGVkLnBuZycsIHt0eXBlOiAnaW1hZ2UvcG5nJ30pKTtcbiAgICAgICAgICB0YS5kaXNwYXRjaEV2ZW50KG5ldyBDbGlwYm9hcmRFdmVudCgncGFzdGUnLCB7Y2xpcGJvYXJkRGF0YTogZHQsIGJ1YmJsZXM6IHRydWUsIGNhbmNlbGFibGU6IHRydWV9KSk7XG4gICAgICAgIH0sICdpbWFnZS9wbmcnKTtcbiAgICAgIH0pKClgKTtcbiAgICAgIGNvbnN0IGNoaXAgPSBhd2FpdCB3YWl0Rm9yKCdpbWFnZSBjaGlwJywgYHZhciBuPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5hdHQtY2hpcC5pbWcnKS5sZW5ndGg7XG4gICAgICAgIHJldHVybiB7b2s6IG4gPj0gMSwgZGV0YWlsOiAnaW1nIGNoaXBzPScrbn07YCwgNl8wMDApO1xuICAgICAgaWYgKCFjaGlwWzBdKSByZXR1cm4gY2hpcDtcbiAgICAgIGF3YWl0IHR5cGVJbnRvKCcuY29tcG9zZXIgdGV4dGFyZWEnLCAnXHU3NzBCXHU4RkQ5XHU1RjIwXHU1NkZFJyk7XG4gICAgICBhd2FpdCBzbGVlcCgyMDApO1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jb21wb3NlciBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1M0QxXHU5MDAxJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XG4gICAgICBjb25zdCBkb25lID0gYXdhaXQgd2FpdEZvcignaW1hZ2Ugc2VudCcsIGBcbiAgICAgICAgdmFyIGFwID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmFwcHJvdmFsLWNhcmQgYnV0dG9uJyk7XG4gICAgICAgIGlmIChhcCAmJiBhcC50ZXh0Q29udGVudC50cmltKCkuaW5kZXhPZignXHU2Mjc5XHU1MUM2Jyk+PTApIGFwLmNsaWNrKCk7XG4gICAgICAgIHZhciB0cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50dXJuJykpO1xuICAgICAgICB2YXIgaGl0ID0gdHMuZmlsdGVyKGZ1bmN0aW9uKHgpeyByZXR1cm4geC5jbGFzc05hbWUuaW5kZXhPZigndXNlcicpPDAgJiYgeC50ZXh0Q29udGVudC5pbmRleE9mKCdbaW1hZ2VzOiAxXScpID49IDA7IH0pO1xuICAgICAgICByZXR1cm4ge29rOiBoaXQubGVuZ3RoID49IDEsIGRldGFpbDogJ3J1bnRpbWUtZWNoby13aXRoLWltYWdlPScraGl0Lmxlbmd0aH07XG4gICAgICBgLCAxNV8wMDApO1xuICAgICAgYXdhaXQgc2hvdCgncGFzdGVkLWltYWdlJyk7XG4gICAgICByZXR1cm4gZG9uZTtcbiAgICB9KTtcblxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdUQ4M0RcdURDQ0UgXHU0RTBBXHU0RjIwL1x1RDgzRFx1RENDMSBcdTZENEZcdTg5QzhcdTYzMDlcdTk0QUVcdTVDMzFcdTRGNEQgPT09PT09PT09PSAqL1xuICAgIGF3YWl0IHN0ZXAoJ1x1OTY0NFx1NEVGNlx1NEUwRVx1NzZFRVx1NUY1NVx1NTE2NVx1NTNFMzpcdUQ4M0RcdURDQ0UgXHU0RTBBXHU0RjIwICsgXHVEODNEXHVEQ0MxIFx1NkQ0Rlx1ODlDOFx1NjMwOVx1OTRBRVx1NUI1OFx1NTcyOCcsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoYChmdW5jdGlvbigpe1xuICAgICAgICB2YXIgdXAgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY29tcG9zZXIgYnV0dG9uW2FyaWEtbGFiZWwqPVwiXHU0RTBBXHU0RjIwXCJdLCAuY29tcG9zZXIgYnV0dG9uW2FyaWEtbGFiZWwqPVwiVXBsb2FkXCJdJyk7XG4gICAgICAgIHZhciBiciA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1waWNrZXIgYnV0dG9uJyk7XG4gICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh7dXA6ICEhdXAsIGJyb3dzZTogISFicn0pO1xuICAgICAgfSkoKWApKSBhcyBzdHJpbmc7XG4gICAgICBjb25zdCBwID0gSlNPTi5wYXJzZShyKSBhcyB7IHVwOiBib29sZWFuOyBicm93c2U6IGJvb2xlYW4gfTtcbiAgICAgIHJldHVybiBbcC51cCAmJiBwLmJyb3dzZSwgYFx1RDgzRFx1RENDRT0ke3AudXB9IFx1RDgzRFx1RENDMT0ke3AuYnJvd3NlfWBdO1xuICAgIH0pO1xuXG4gICAgLyogPT09PT09PT09PSBmYWtlOkAgXHU5NjQ0XHU0RUY2XHU5MDA5XHU2MkU5XHU1NjY4ID09PT09PT09PT0gKi9cbiAgICBhd2FpdCBzdGVwKCdAIFx1OTY0NFx1NEVGNjpcdTkwMDlcdTYyRTlcdTU2NjhcdTUxRkFcdTczQjBcdTVFNzZcdTUzRUZcdTkwMDlcdTY1ODdcdTRFRjYnLCBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNvbXBvc2VyIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdAJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignYXR0IHBpY2tlcicsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuYXR0LXBpY2tlcicpO1xuICAgICAgICByZXR1cm4ge29rOiAhIXAsIGRldGFpbDogcCA/ICdvcGVuJyA6ICdub3Qgb3Blbid9O2AsIDVfMDAwKTtcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XG4gICAgICBhd2FpdCB0eXBlSW50bygnLmF0dC1waWNrZXIgaW5wdXQnLCAncmVhZCcpO1xuICAgICAgY29uc3QgdzIgPSBhd2FpdCB3YWl0Rm9yKCdhdHQgcmVzdWx0cycsIGB2YXIgcj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuYXR0LXJlc3VsdHMgLmZzLXJvdycpLmxlbmd0aDtcbiAgICAgICAgcmV0dXJuIHtvazogciA+PSAxLCBkZXRhaWw6ICdyZXN1bHRzPScrcn07YCwgNl8wMDApO1xuICAgICAgaWYgKCF3MlswXSkgcmV0dXJuIHcyO1xuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgZj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuYXR0LXJlc3VsdHMgLmZzLXJvdycpOyBpZihmKSBmLmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdhdHQgY2hpcCcsIGB2YXIgYz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuYXR0LWNoaXAnKS5sZW5ndGg7XG4gICAgICAgIHJldHVybiB7b2s6IGMgPj0gMSwgZGV0YWlsOiAnY2hpcHM9JytjfTtgLCA1XzAwMCk7XG4gICAgfSk7XG5cbiAgICAvKiA9PT09PT09PT09IGZha2UoXHU1NDExXHU1QkZDXHU2Nzg0XHU5MDIwKTpcdThCQkVcdTdGNkVcdTMwMENcdTkxQ0RcdTY1QjBcdTkxNERcdTdGNkVcdTMwMERcdTkxQ0RcdTUxNjUgKyBcdTkwMDlcdTYyRTlcdTYzMDFcdTRFNDUgPT09PT09PT09PSAqL1xuICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9XSVpBUkQgPT09ICdmYWtlJykge1xuICAgICAgYXdhaXQgc3RlcCgnXHU1NDExXHU1QkZDOlx1OEJCRVx1N0Y2RVx1MzAwQ1x1OTFDRFx1NjVCMFx1OTE0RFx1N0Y2RVx1MzAwRFx1OTFDRFx1NTE2NSArIFx1OTAwOVx1NjJFOVx1NjMwMVx1NEU0NSh3aXphcmQuanNvbiknLCBhc3luYyAoKSA9PiB7XG4gICAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J3AnLCBjdHJsS2V5OnRydWUsIHNoaWZ0S2V5OnRydWUsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xuICAgICAgICBjb25zdCBvcGVuID0gYXdhaXQgd2FpdEZvcignc2V0dGluZ3Mgb3BlbicsIGB2YXIgcz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kay5zZXR0aW5ncycpO1xuICAgICAgICAgIHJldHVybiB7b2s6ICEhcywgZGV0YWlsOiBzID8gJ29wZW4nIDogJ2Nsb3NlZCd9O2AsIDVfMDAwKTtcbiAgICAgICAgaWYgKCFvcGVuWzBdKSByZXR1cm4gb3BlbjtcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jbWRrLnNldHRpbmdzIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1OTFDRFx1NjVCMFx1OTE0RFx1N0Y2RScpPj0wO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcbiAgICAgICAgY29uc3Qgc2hvd24gPSBhd2FpdCB3YWl0Rm9yKCd3aXphcmQgcmVvcGVuZWQnLCBgcmV0dXJuIHtvazogISFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKSxcbiAgICAgICAgICBkZXRhaWw6IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3ZlcmxheScpID8gJ29wZW4nIDogJ2Nsb3NlZCd9O2AsIDVfMDAwKTtcbiAgICAgICAgaWYgKCFzaG93blswXSkgcmV0dXJuIHNob3duO1xuICAgICAgICBhd2FpdCBzaG90KCd3aXphcmQtcmVlbnRyeScpO1xuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTUzRDZcdTZEODgnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcbiAgICAgICAgY29uc3QgY2xvc2VkID0gYXdhaXQgd2FpdEZvcignd2l6YXJkIGNsb3NlZCcsIGByZXR1cm4ge29rOiAhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1vdmVybGF5JyksIGRldGFpbDogJ2Nsb3NlZCd9O2AsIDVfMDAwKTtcbiAgICAgICAgY29uc3Qgc3QgPSAoYXdhaXQganMoYHdpbmRvdy5obWguZ2V0V2l6YXJkKCkudGhlbihmdW5jdGlvbihyKXtyZXR1cm4gSlNPTi5zdHJpbmdpZnkocik7fSlgKSkgYXMgc3RyaW5nO1xuICAgICAgICBjb25zdCBwID0gSlNPTi5wYXJzZShzdCkgYXMgeyBwZXJzaXN0ZWQ/OiB7IGRvbmU/OiBib29sZWFuOyBjaG9pY2U/OiBzdHJpbmcgfSB9O1xuICAgICAgICBjb25zdCBwZXJzaXN0ZWQgPSBwLnBlcnNpc3RlZD8uZG9uZSA9PT0gdHJ1ZSAmJiBwLnBlcnNpc3RlZD8uY2hvaWNlID09PSAnYnVuZGxlZCc7XG4gICAgICAgIHJldHVybiBbY2xvc2VkWzBdICYmIHBlcnNpc3RlZCwgYGNsb3NlZD0ke2Nsb3NlZFswXX0gcGVyc2lzdGVkPSR7SlNPTi5zdHJpbmdpZnkocC5wZXJzaXN0ZWQgPz8gbnVsbCl9YF07XG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBhd2FpdCBzaG90KCdmaW5hbCcpO1xuICB9IGVsc2UgaWYgKChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9XSVpBUkQgPz8gJycpICE9PSAnJykge1xuICAgIC8qID09PT09PT09PT0gcmVhbChcdTU0MTFcdTVCRkNcdTY3ODRcdTkwMjAsXHU0RTkyXHU2NUE1XHU0RThFXHU1RTM4XHU4OUM0IHJlYWwgXHU2QjY1XHU5QUE0KTpcbiAgICAgICBXWjIgXHU2NzJDXHU2NzNBXHU3NzFGXHU1QjlFXHU2OEMwXHU2RDRCKFx1OUVEOFx1OEJBNFx1NTE3MVx1NEVBQlx1OTg3NSkvIFdaMyBcdTRFMEJcdThGN0RcdTVCODlcdTg4QzVcdTVCOUVcdTZENEIgPT09PT09PT09PSAqL1xuICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9XSVpBUkQgPT09ICdkZXRlY3QnKSB7XG4gICAgICBhd2FpdCBzdGVwKCdcdTU0MTFcdTVCRkMoXHU3NzFGXHU1QjlFKTpcdTZCMjJcdThGQ0VcdTIxOTJcdTY4QzBcdTZENEJcdTUyMzBcdTY3MkNcdTY3M0FcdTVERjJcdTg4QzUgQ0xJKFx1OUVEOFx1OEJBNFx1NTE3MVx1NEVBQixcdTUyRkVcdTkwMDlcdTZCNjNcdTc4NkUpJywgYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignd2l6YXJkIG92ZXJsYXknLCBgdmFyIG89ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1vdmVybGF5Jyk7XG4gICAgICAgICAgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NUYwMFx1NTlDQlx1OTE0RFx1N0Y2RSc7fSk7XG4gICAgICAgICAgcmV0dXJuIHtvazogISFvICYmICEhYiwgZGV0YWlsOiBvID8gJ292ZXJsYXkrXHU1RjAwXHU1OUNCXHU5MTREXHU3RjZFJyA6ICdubyBvdmVybGF5J307YCwgMTJfMDAwKTtcbiAgICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcbiAgICAgICAgYXdhaXQgc2hvdCgnd2l6YXJkLXJlYWwtd2VsY29tZScpO1xuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTVGMDBcdTU5Q0JcdTkxNERcdTdGNkUnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcbiAgICAgICAgY29uc3QgZm91bmQgPSBhd2FpdCB3YWl0Rm9yKCdkZXRlY3QgZm91bmQnLCBgdmFyIHA9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLWRldGVjdCcpO1xuICAgICAgICAgIGlmKCFwKSByZXR1cm4ge29rOmZhbHNlLCBkZXRhaWw6J2RldGVjdCBwYWdlIG5vdCBzaG93bid9O1xuICAgICAgICAgIHZhciB0PXAudGV4dENvbnRlbnQ7XG4gICAgICAgICAgdmFyIG9rMT10LmluZGV4T2YoJ1x1NjhDMFx1NkQ0Qlx1NTIzMFx1NURGMlx1NUI4OVx1ODhDNSBobWhhcm5lc3MgdicpPj0wO1xuICAgICAgICAgIHZhciBvazI9dC5pbmRleE9mKCdcdTlFRDhcdThCQTRcdTUxNzFcdTRFQUJcdTRGN0ZcdTc1MjhcdTVCODMoXHU2M0E4XHU4MzUwKScpPj0wO1xuICAgICAgICAgIHZhciByYWRpbz1wLnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3B0Lm9uJyk7XG4gICAgICAgICAgcmV0dXJuIHtvazogb2sxJiZvazImJiEhcmFkaW8sIGRldGFpbDogdC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsOTApfTtgLCAyMF8wMDApO1xuICAgICAgICBhd2FpdCBzaG90KCd3aXphcmQtcmVhbC1kZXRlY3QnKTtcbiAgICAgICAgcmV0dXJuIGZvdW5kO1xuICAgICAgfSk7XG4gICAgfSBlbHNlIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9XSVpBUkQgPT09ICdpbnN0YWxsJykge1xuICAgICAgYXdhaXQgc3RlcCgnXHU1NDExXHU1QkZDKFx1NzcxRlx1NUI5RSk6XHU2OEMwXHU2RDRCXHUyMTkyXHU0RUNEXHU4OTgxXHU0RTBCXHU4RjdEXHU2NUIwXHU3MjQ4XHUyMTkyXHU5MDA5XHU2MkU5XHUyNDYwXHUyMTkyXHU4RkRCXHU1MTY1XHU1Qjg5XHU4OEM1XHU5ODc1JywgYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignd2l6YXJkIG92ZXJsYXknLCBgdmFyIG89ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1vdmVybGF5Jyk7XG4gICAgICAgICAgcmV0dXJuIHtvazogISFvLCBkZXRhaWw6IG8gPyAnb3BlbicgOiAnY2xvc2VkJ307YCwgMTJfMDAwKTtcbiAgICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1RjAwXHU1OUNCXHU5MTREXHU3RjZFJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XG4gICAgICAgIGNvbnN0IGZvdW5kID0gYXdhaXQgd2FpdEZvcignZGV0ZWN0IGZvdW5kJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1kZXRlY3QnKTtcbiAgICAgICAgICByZXR1cm4ge29rOiAhIXAgJiYgcC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTY4QzBcdTZENEJcdTUyMzBcdTVERjJcdTVCODlcdTg4QzUgaG1oYXJuZXNzIHYnKT49MCwgZGV0YWlsOiBwID8gcC50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNjApIDogJ25vIGRldGVjdCBwYWdlJ307YCwgMjBfMDAwKTtcbiAgICAgICAgaWYgKCFmb3VuZFswXSkgcmV0dXJuIGZvdW5kO1xuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBvPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vcHQnKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTRFQ0RcdTg5ODFcdTRFMEJcdThGN0RcdTY1QjBcdTcyNDgnKT49MDt9KTsgaWYobykgby5jbGljaygpOyB9KSgpYCk7XG4gICAgICAgIGF3YWl0IHNsZWVwKDIwMCk7XG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NEUwQlx1NEUwMFx1NkI2NSc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xuICAgICAgICBjb25zdCBzZWwgPSBhd2FpdCB3YWl0Rm9yKCdzZWxlY3QgcGFnZSBcdTI0NjAgb24nLCBgdmFyIHA9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLXNlbGVjdCcpO1xuICAgICAgICAgIHZhciBvbj1wP3AucXVlcnlTZWxlY3RvcignLndpemFyZC1vcHQub24nKTpudWxsO1xuICAgICAgICAgIHJldHVybiB7b2s6ICEhcCAmJiAhIW9uICYmIG9uLnRleHRDb250ZW50LmluZGV4T2YoJ1x1NEUwQlx1OEY3RFx1NUI4OVx1ODhDNVx1NUI4Q1x1NjU3NCBobWggQ0xJJyk+PTAsIGRldGFpbDogcCA/ICdzZWxlY3QgXHUyNDYwIG9uJyA6ICdubyBzZWxlY3QnfTtgLCA4XzAwMCk7XG4gICAgICAgIGlmICghc2VsWzBdKSByZXR1cm4gc2VsO1xuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTVGMDBcdTU5Q0JcdTVCODlcdTg4QzUnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcbiAgICAgICAgcmV0dXJuIHdhaXRGb3IoJ2luc3RhbGwgcGFnZScsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtaW5zdGFsbCcpO1xuICAgICAgICAgIHJldHVybiB7b2s6ICEhcCwgZGV0YWlsOiBwID8gJ2luc3RhbGxpbmcnIDogJ25vdCBzaG93bid9O2AsIDhfMDAwKTtcbiAgICAgIH0pO1xuICAgICAgYXdhaXQgc3RlcCgnXHU1NDExXHU1QkZDKFx1NzcxRlx1NUI5RSk6XHU1Qjg5XHU4OEM1XHU4RkRCXHU1RUE2XHU1M0VGXHU4OUMxKFx1NkI2NVx1OUFBNFx1NjU4N1x1Njg0OC9cdTRFMEJcdThGN0RcdTc2N0VcdTUyMDZcdTZCRDRcdTZFREFcdTUyQTgpJywgYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcigncHJvZ3Jlc3MgdmlzaWJsZScsIGB2YXIgYmFyPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtcHJvZ3Jlc3MnKTtcbiAgICAgICAgICB2YXIgbG9nPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtaW5zdGFsbC1sb2cnKTtcbiAgICAgICAgICB2YXIgbGluZXM9bG9nP2xvZy50ZXh0Q29udGVudC5zcGxpdCgnXFxcXG4nKS5maWx0ZXIoZnVuY3Rpb24oeCl7cmV0dXJuIHgudHJpbSgpIT09Jyc7fSk6W107XG4gICAgICAgICAgcmV0dXJuIHtvazogISFiYXIgJiYgbGluZXMubGVuZ3RoPj0xLCBkZXRhaWw6ICdiYXI9JysoYmFyPyd5JzonbicpKycgbGluZXM9JytsaW5lcy5sZW5ndGgrKGxpbmVzLmxlbmd0aD4wPygnIGxhc3Q9JysobGluZXNbbGluZXMubGVuZ3RoLTFdfHwnJykuc2xpY2UoMCw1MCkpOicnKX07YCwgNjBfMDAwKTtcbiAgICAgICAgYXdhaXQgc2hvdCgnd2l6YXJkLXJlYWwtaW5zdGFsbCcpO1xuICAgICAgICByZXR1cm4gdztcbiAgICAgIH0pO1xuICAgICAgYXdhaXQgc3RlcCgnXHU1NDExXHU1QkZDKFx1NzcxRlx1NUI5RSk6XHU1Qjg5XHU4OEM1XHU1QjhDXHU2MjEwXHUyMTkyXHU5MTREXHU3RjZFXHU4REYzXHU4RkM3KFx1NURGMlx1NjcwOVx1NUJDNlx1OTRBNSlcdTIxOTJcdTVCOENcdTYyMTBcdTk4NzVcdTIxOTJcdTVGMDBcdTU5Q0JcdTRGN0ZcdTc1MjhcdTIxOTJcdTY1QjAgcnVudGltZSBcdThGREVcdTYzQTUnLCBhc3luYyAoKSA9PiB7XG4gICAgICAgIC8vIFx1NUI4OVx1ODhDNVx1NTE2OFx1N0EwQihucG0gXHU4OUUzXHU2NzkwK1x1NEUwQlx1OEY3RCtcdTg0M0RcdTc2RDg7XHU5NTVDXHU1MENGIG5wbW1pcnJvciBcdTkwMUFcdTVFMzggPDIgXHU1MjA2XHU5NDlGKSxcdTRFMEFcdTk2NTAgOCBcdTUyMDZcdTk0OUZcbiAgICAgICAgYXdhaXQgd2FpdEZvcignZG9uZSBwYWdlJywgYHZhciBkPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1kb25lJyk7XG4gICAgICAgICAgaWYoZCkgcmV0dXJuIHtvazp0cnVlLCBkZXRhaWw6J2RvbmUnfTtcbiAgICAgICAgICB2YXIgYz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtY29uZmlnJyk7XG4gICAgICAgICAgaWYoYyl7IHZhciBzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1OERGM1x1OEZDNycpPj0wO30pOyBpZihzKSBzLmNsaWNrKCk7IH1cbiAgICAgICAgICB2YXIgZXJyPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtZXJyb3InKTtcbiAgICAgICAgICBpZihlcnIpIHJldHVybiB7b2s6ZmFsc2UsIGRldGFpbDonaW5zdGFsbCBlcnJvcjogJytlcnIudGV4dENvbnRlbnQuc2xpY2UoMCw4MCl9O1xuICAgICAgICAgIHJldHVybiB7b2s6ZmFsc2UsIGRldGFpbDonaW5zdGFsbGluZ1x1MjAyNid9O2AsIDggKiA2MF8wMDApO1xuICAgICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignZG9uZSByZWFkeSB0ZXh0JywgYHZhciBkPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1kb25lJyk7XG4gICAgICAgICAgdmFyIHQ9ZD9kLnRleHRDb250ZW50OicnO1xuICAgICAgICAgIHJldHVybiB7b2s6ICEhZCAmJiB0LmluZGV4T2YoJ1x1NUMzMVx1N0VFQScpPj0wLCBkZXRhaWw6IHQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDYwKX07YCwgMTBfMDAwKTtcbiAgICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcbiAgICAgICAgYXdhaXQgc2hvdCgnd2l6YXJkLXJlYWwtZG9uZScpO1xuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTVGMDBcdTU5Q0JcdTRGN0ZcdTc1MjgnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcbiAgICAgICAgY29uc3QgY29ubmVjdGVkID0gYXdhaXQgd2FpdEZvcignbmV3IHJ1bnRpbWUgY29ubmVjdGVkJywgYHZhciBkb3Q9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmhvc3QtZG90Lm9uJyk7XG4gICAgICAgICAgdmFyIGw9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmhvc3QtbGFiZWwnKTtcbiAgICAgICAgICByZXR1cm4ge29rOiAhIWRvdCAmJiAhIWwgJiYgbC50ZXh0Q29udGVudC5pbmRleE9mKCdydW50aW1lJyk+PTAsIGRldGFpbDogJ2RvdD0nKyhkb3Q/J29uJzonb2ZmJykrJyBsYWJlbD0nKyhsP2wudGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDUwKTonbm9uZScpfTtgLCA2MF8wMDApO1xuICAgICAgICBjb25zdCBzdCA9IChhd2FpdCBqcyhgd2luZG93LmhtaC5nZXRTdGF0ZSgpLnRoZW4oZnVuY3Rpb24ocil7cmV0dXJuIEpTT04uc3RyaW5naWZ5KHttb2RlOnIubW9kZSwgcnVudGltZUVudHJ5OnIucnVudGltZUVudHJ5fSk7fSlgKSkgYXMgc3RyaW5nO1xuICAgICAgICBjb25zdCBwID0gSlNPTi5wYXJzZShzdCkgYXMgeyBtb2RlPzogc3RyaW5nOyBydW50aW1lRW50cnk/OiBzdHJpbmcgfCBudWxsIH07XG4gICAgICAgIGNvbnN0IGVudHJ5T2sgPSAocC5ydW50aW1lRW50cnkgPz8gJycpLmluZGV4T2YoJy5obWhhcm5lc3MtZ2xvYmFsJykgPj0gMDtcbiAgICAgICAgYXdhaXQgc2hvdCgnd2l6YXJkLXJlYWwtZmluYWwnKTtcbiAgICAgICAgcmV0dXJuIFtjb25uZWN0ZWRbMF0gJiYgZW50cnlPaywgYGNvbm5lY3RlZDogJHtjb25uZWN0ZWRbMV19OyBzdGF0ZT0ke3N0LnNsaWNlKDAsIDkwKX1gXTtcbiAgICAgIH0pO1xuICAgIH1cbiAgICBhd2FpdCBzaG90KCdmaW5hbCcpO1xuICB9IGVsc2Uge1xuICAgIC8qID09PT09PT09PT0gcmVhbDpcdTUzRUFcdThCRkJcdTVCNTBcdTk2QzYoXHU0RTBEXHU1MkE4XHU3NzFGXHU1QjlFXHU0RjFBXHU4QkREKSA9PT09PT09PT09ICovXG4gICAgYXdhaXQgc3RlcCgnXHU5ODc2XHU2ODBGOnJ1bnRpbWUgXHU3MjQ4XHU2NzJDXHU0RTBFXHU3QUVGXHU1M0UzXHU1REYyXHU2NjNFXHU3OTNBKFx1OTc1RSA/KScsIGFzeW5jICgpID0+IHtcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdob3N0IGxhYmVsJywgYHZhciBsPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ob3N0LWxhYmVsJyk7XG4gICAgICAgIHZhciB0ID0gbCA/IGwudGV4dENvbnRlbnQgOiAnJztcbiAgICAgICAgcmV0dXJuIHtvazogdC5pbmRleE9mKCc/JykgPCAwICYmIHQuaW5kZXhPZigncnVudGltZScpID49IDAsIGRldGFpbDogdC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNjApfTtgLCAxNV8wMDApO1xuICAgIH0pO1xuICAgIGF3YWl0IHN0ZXAoJ1x1NEYxQVx1OEJERFx1NTIxN1x1ODg2ODpcdTc3MUZcdTVCOUVcdTUzODZcdTUzRjJcdTUyQTBcdThGN0QoXHU2NTcwXHU5MUNGPjApJywgYXN5bmMgKCkgPT4ge1xuICAgICAgcmV0dXJuIHdhaXRGb3IoJ3Nlc3Npb25zJywgYHZhciBuPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGg7XG4gICAgICAgIHJldHVybiB7b2s6IG4gPiAwLCBkZXRhaWw6ICdzZXNzaW9ucz0nK259O2AsIDE1XzAwMCk7XG4gICAgfSk7XG4gICAgYXdhaXQgc3RlcCgnXHU3MEI5XHU1MUZCXHU1Mzg2XHU1M0YyXHU0RjFBXHU4QkREIFx1MjE5MiBcdTc3MUZcdTVCOUUgdHJhbnNjcmlwdCBcdTUxODVcdTVCQjlcdTUzRUZcdTg5QzEnLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBuID0gKGF3YWl0IGpzKGBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoYCkpIGFzIG51bWJlcjtcbiAgICAgIGlmIChuID09PSAwKSByZXR1cm4gW2ZhbHNlLCAnbm8gc2Vzc2lvbnMgdG8gY2xpY2snXTtcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGl0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zZXNzaW9uLWl0ZW0nKTsgaWYgKGl0KSBpdC5jbGljaygpOyB9KSgpYCk7XG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignaGlzdG9yeSB0dXJucycsIGB2YXIgdHM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudHVybicpKTtcbiAgICAgICAgcmV0dXJuIHtvazogdHMubGVuZ3RoID49IDEsIGRldGFpbDogJ3R1cm5zPScrdHMubGVuZ3RoKycgZmlyc3Q9JysodHNbMF0/dHNbMF0udGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDQwKTonbm9uZScpfTtgLCAxNV8wMDApO1xuICAgICAgYXdhaXQgc2hvdCgncmVhbC1oaXN0b3J5Jyk7XG4gICAgICByZXR1cm4gdztcbiAgICB9KTtcbiAgICBhd2FpdCBzdGVwKCdEb2NrOk92ZXJ2aWV3IFx1NzcxRlx1NUI5RVx1NjU3MFx1NjM2RShydW50aW1lIFx1NzI0OFx1NjcyQ1x1OTc1RVx1NjVFMFx1NjU3MFx1NjM2RSknLCBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nT3ZlcnZpZXcnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdvdmVydmlldycsIGB2YXIgcm93cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXJvdycpKTtcbiAgICAgICAgdmFyIHZlciA9IHJvd3MuZmluZChmdW5jdGlvbihyKXsgcmV0dXJuIHIudGV4dENvbnRlbnQuaW5kZXhPZigncnVudGltZSBcdTcyNDhcdTY3MkMnKT49MDsgfSk7XG4gICAgICAgIHJldHVybiB7b2s6ICEhdmVyICYmIHZlci50ZXh0Q29udGVudC5pbmRleE9mKCdcdTY1RTBcdTY1NzBcdTYzNkUnKSA8IDAsIGRldGFpbDogdmVyID8gdmVyLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw1MCkgOiAnbm8gdmVyIHJvdyd9O2AsIDEwXzAwMCk7XG4gICAgfSk7XG4gICAgYXdhaXQgc3RlcCgnRG9jazpEaWZmIFx1NzcxRlx1NUI5RSBnaXQgXHU3MkI2XHU2MDAxKFx1OTc1RVx1NTJBMFx1OEY3RFx1NEUyRCknLCBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nXHU1M0Q4XHU2NkY0J3x8eC50ZXh0Q29udGVudD09PSdEaWZmJzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XG4gICAgICByZXR1cm4gd2FpdEZvcignZGlmZicsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuZGlmZi1wYW5lJyk7XG4gICAgICAgIHZhciB0ID0gcCA/IHAudGV4dENvbnRlbnQgOiAnJztcbiAgICAgICAgcmV0dXJuIHtvazogISFwICYmIHQuaW5kZXhPZignXHU1MkEwXHU4RjdEXHU0RTJEJykgPCAwLCBkZXRhaWw6IHQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDYwKX07YCwgMTVfMDAwKTtcbiAgICB9KTtcbiAgICBhd2FpdCBzdGVwKCdEb2NrOkV2aWRlbmNlIFx1NzcxRlx1NUI5RVx1OEJBNFx1NzdFNVx1NjU3MFx1NjM2RScsIGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdcdThCQzFcdTYzNkUnfHx4LnRleHRDb250ZW50PT09J0V2aWRlbmNlJzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XG4gICAgICByZXR1cm4gd2FpdEZvcignZXZpZGVuY2UnLCBgdmFyIHJvd3M9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay1yb3cnKSk7XG4gICAgICAgIHZhciBtZW0gPSByb3dzLmZpbmQoZnVuY3Rpb24ocil7IHJldHVybiByLnRleHRDb250ZW50LmluZGV4T2YoJ1x1OEJCMFx1NUZDNlx1NUM0MicpPj0wIHx8IHIudGV4dENvbnRlbnQuaW5kZXhPZignTWVtb3J5IGxheWVycycpPj0wOyB9KTtcbiAgICAgICAgcmV0dXJuIHtvazogISFtZW0gJiYgbWVtLnRleHRDb250ZW50LmluZGV4T2YoJ1x1MjAyNicpIDwgMCwgZGV0YWlsOiBtZW0gPyBtZW0udGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDUwKSA6ICdubyByb3cnfTtgLCAxNV8wMDApO1xuICAgIH0pO1xuICAgIGF3YWl0IHN0ZXAoJ1x1OTY0NFx1NEVGNlx1NEUwRVx1NzZFRVx1NUY1NVx1NTE2NVx1NTNFMzpcdUQ4M0RcdURDQ0UgXHU0RTBBXHU0RjIwICsgXHU5ODc2XHU2ODBGXHU0RTJEL0VOICsgXHVEODNEXHVEQ0MxIFx1NkQ0Rlx1ODlDOFx1NjMwOVx1OTRBRVx1NUI1OFx1NTcyOCcsIGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdcdTY1ODdcdTRFRjYnfHx4LnRleHRDb250ZW50PT09J0ZpbGVzJzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XG4gICAgICBhd2FpdCB3YWl0Rm9yKCdmaWxlcyB0YWInLCBgdmFyIHQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmRvY2stdGFiLmFjdGl2ZScpO1xuICAgICAgICByZXR1cm4ge29rOiAhIXQgJiYgKHQudGV4dENvbnRlbnQ9PT0nXHU2NTg3XHU0RUY2J3x8dC50ZXh0Q29udGVudD09PSdGaWxlcycpLCBkZXRhaWw6ICdhY3RpdmU9JysodD90LnRleHRDb250ZW50Oidub25lJyl9O2AsIDVfMDAwKTtcbiAgICAgIC8vIHJlYWwgXHU2QTIxXHU1RjBGIHdvcmtzcGFjZXMgXHU4QkY3XHU2QzQyXHU4RDcwIHJ1bnRpbWUoXHU1MUI3XHU1NDJGXHU1MkE4XHU1NDBFXHU1M0VGXHU4MEZEXHU2MzkyXHU5NjFGKSxcdTY1M0VcdTVCQkRcdTUyMzAgMTVzXG4gICAgICBjb25zdCB3cyA9IGF3YWl0IHdhaXRGb3IoJ3dzIHBpY2tlcicsIGB2YXIgdz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtcGlja2VyJyk7XG4gICAgICAgIHJldHVybiB7b2s6ICEhdywgZGV0YWlsOiB3ID8gJ2xvYWRlZCcgOiAnd29ya3NwYWNlcyBub3QgbG9hZGVkIHlldCd9O2AsIG1vZGUgPT09ICdyZWFsJyA/IDE1XzAwMCA6IDZfMDAwKTtcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoYChmdW5jdGlvbigpe1xuICAgICAgICB2YXIgdXAgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY29tcG9zZXIgYnV0dG9uW2FyaWEtbGFiZWwqPVwiXHU0RTBBXHU0RjIwXCJdLCAuY29tcG9zZXIgYnV0dG9uW2FyaWEtbGFiZWwqPVwiVXBsb2FkXCJdJyk7XG4gICAgICAgIHZhciBsYW5nID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmxhbmctc2VnJyk7XG4gICAgICAgIHZhciBiciA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1waWNrZXIgYnV0dG9uJyk7XG4gICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh7dXA6ICEhdXAsIGxhbmc6ICEhbGFuZywgYnJvd3NlOiAhIWJyfSk7XG4gICAgICB9KSgpYCkpIGFzIHN0cmluZztcbiAgICAgIGNvbnN0IHAgPSBKU09OLnBhcnNlKHIpIGFzIHsgdXA6IGJvb2xlYW47IGxhbmc6IGJvb2xlYW47IGJyb3dzZTogYm9vbGVhbiB9O1xuICAgICAgcmV0dXJuIFtwLnVwICYmIHAubGFuZyAmJiBwLmJyb3dzZSwgYFx1RDgzRFx1RENDRT0ke3AudXB9IFx1NEUyRC9FTj0ke3AubGFuZ30gXHVEODNEXHVEQ0MxPSR7cC5icm93c2V9OyAke3dzWzFdfWBdO1xuICAgIH0pO1xuICAgIC8qID09PT09PT09PT0gcmVhbDpcdTc3MUZcdTVCOUVcdTRFRkJcdTUyQTFcdTdBRUZcdTUyMzBcdTdBRUZcdTk5OTZcdTlBOEMoXHU1M0QxXHU3N0VEXHU0RUZCXHU1MkExXHUyMTkyXHU2QTIxXHU1NzhCXHU1NkRFXHU1OTBEKSA9PT09PT09PT09XG4gICAgICAgXHU3NTI4XHU2MjM3IGdsbS01LjMgXHU1REYyXHU5MTREXHU3RjZFO1x1NjNEMFx1NzkzQVx1OEJDRFx1N0VBNlx1Njc1Rlx1NzZGNFx1NjNBNVx1NTZERVx1NTkwRFx1MzAwMlx1ODJFNSBhZ2VudCBcdThCRjdcdTZDNDJcdTVCQTFcdTYyNzksXHU4RjZFXHU4QkUyXHU5MUNDXG4gICAgICAgXHU4MUVBXHU1MkE4XHU3MEI5XHU2Mjc5XHU1MUM2KFx1NjcwMFx1NTkxQVx1ODlDMVx1NTM2MVx1NTM3M1x1NzBCOSxcdTVFNDJcdTdCNDkpXHUzMDAyXHU4RDg1XHU2NUY2IDE1MHNcdTMwMDIgKi9cbiAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfUkVBTF9UQVNLID09PSAnMScpIHtcbiAgICAgIGF3YWl0IHN0ZXAoJ1x1NzcxRlx1NUI5RVx1NEVGQlx1NTJBMTpcdTUzRDFcdTkwMDFcdTIxOTJcdTZBMjFcdTU3OEJcdTU2REVcdTU5MEQoXHU3QUVGXHU1MjMwXHU3QUVGXHU5OTk2XHU5QThDKScsIGFzeW5jICgpID0+IHtcbiAgICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleTonbicsIGN0cmxLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XG4gICAgICAgIGF3YWl0IHNsZWVwKDQwMCk7XG4gICAgICAgIGF3YWl0IHR5cGVJbnRvKCcuY29tcG9zZXIgdGV4dGFyZWEnLCAnXHU4QkY3XHU1M0VBXHU1NkRFXHU1OTBEXHU0RTI0XHU0RTJBXHU1QjU3Olx1NjUzNlx1NTIzMChcdTY3MkNcdTZCMjFcdTlBOENcdTY1MzZcdTRFRkJcdTUyQTEsXHU0RTBEXHU4OTgxXHU0RjdGXHU3NTI4XHU0RUZCXHU0RjU1XHU1REU1XHU1MTc3LFx1NzZGNFx1NjNBNVx1NTZERVx1NTkwRCknKTtcbiAgICAgICAgYXdhaXQgc2xlZXAoMjAwKTtcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jb21wb3NlciBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1M0QxXHU5MDAxJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XG4gICAgICAgIGNvbnN0IHNlbnQgPSBhd2FpdCB3YWl0Rm9yKCd1c2VyIHR1cm4nLCBgdmFyIHQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnR1cm4udXNlcicpO1xuICAgICAgICAgIHZhciBzID0gKHQgJiYgdC50ZXh0Q29udGVudCkgPyBTdHJpbmcodC50ZXh0Q29udGVudCkgOiAnJztcbiAgICAgICAgICByZXR1cm4ge29rOiBzLmluZGV4T2YoJ1x1NjUzNlx1NTIzMCcpPj0wIHx8IHMuaW5kZXhPZignXHU5QThDXHU2NTM2XHU0RUZCXHU1MkExJyk+PTAsIGRldGFpbDogcy5zbGljZSgwLDMwKSB8fCAnbm9uZSd9O2AsIDEwXzAwMCk7XG4gICAgICAgIGlmICghc2VudFswXSkgcmV0dXJuIHNlbnQ7XG4gICAgICAgIGNvbnN0IHJlcGx5ID0gYXdhaXQgd2FpdEZvcignYXNzaXN0YW50IHJlcGx5JywgYFxuICAgICAgICAgIHZhciBhcCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5hcHByb3ZhbC1jYXJkIGJ1dHRvbicpO1xuICAgICAgICAgIGlmIChhcCAmJiBhcC50ZXh0Q29udGVudC50cmltKCkuaW5kZXhPZignXHU2Mjc5XHU1MUM2Jyk+PTApIGFwLmNsaWNrKCk7XG4gICAgICAgICAgdmFyIHRzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnR1cm4nKSkuZmlsdGVyKGZ1bmN0aW9uKHgpeyByZXR1cm4geC5jbGFzc05hbWUuaW5kZXhPZigndXNlcicpPDAgJiYgeC5jbGFzc05hbWUuaW5kZXhPZignYXBwcm92YWwnKTwwICYmIHguY2xhc3NOYW1lLmluZGV4T2YoJ3N5c3RlbScpPDAgJiYgeC50ZXh0Q29udGVudC50cmltKCkubGVuZ3RoPjAgJiYgeC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTU2REVcdTU0MDgnKTwwOyB9KTtcbiAgICAgICAgICB2YXIgc3VtID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnR1cm4tc3VtJyk7XG4gICAgICAgICAgcmV0dXJuIHtvazogdHMubGVuZ3RoPj0xICYmICEhc3VtLCBkZXRhaWw6ICdhc3Npc3RhbnQ9Jyt0cy5sZW5ndGgrJyBzdW09Jysoc3VtP3N1bS50ZXh0Q29udGVudDonbm9uZScpKycgZmlyc3Q9JysodHNbMF0/dHNbMF0udGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDQwKTonbm9uZScpfTtcbiAgICAgICAgYCwgMTUwXzAwMCk7XG4gICAgICAgIGF3YWl0IHNob3QoJ3JlYWwtdGFzaycpO1xuICAgICAgICByZXR1cm4gcmVwbHk7XG4gICAgICB9KTtcbiAgICB9XG4gICAgYXdhaXQgc3RlcCgnXHU0RjFBXHU4QkREXHU1MjA2XHU3RUM0Olx1NURFNlx1NjgwRlx1NjMwOVx1NURFNVx1NEY1Q1x1NTMzQVx1NTIwNlx1N0VDNChcdTdFQzRcdTU5MzRcdTUzRUZcdTg5QzEpJywgYXN5bmMgKCkgPT4ge1xuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2dyb3VwIGhlYWQnLCBgdmFyIGg9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLWdyb3VwLWhlYWQnKTtcbiAgICAgICAgdmFyIG4gPSBoID8gKGgucXVlcnlTZWxlY3RvcignLndzLWdyb3VwLW5hbWUnKXx8e30pLnRleHRDb250ZW50IDogJyc7XG4gICAgICAgIHJldHVybiB7b2s6ICEhaCAmJiBuLmxlbmd0aCA+IDAsIGRldGFpbDogJ25hbWU9JytufTtgLCAxNV8wMDApO1xuICAgIH0pO1xuICAgIGF3YWl0IHN0ZXAoJ1x1NURFNVx1NEY1Q1x1NTMzQTpcdTVERTZcdTY4MEZcdTVERTVcdTRGNUNcdTUzM0FcdTY4MEZcdTUzRUZcdTg5QzEoXHU3NzFGXHU1QjlFXHU1REU1XHU0RjVDXHU1MzNBXHU1NDBEKScsIGFzeW5jICgpID0+IHtcbiAgICAgIHJldHVybiB3YWl0Rm9yKCd3b3Jrc3BhY2UgYmFyJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53b3Jrc3BhY2UtYmFyJyk7XG4gICAgICAgIHZhciBuID0gYiA/IChiLnF1ZXJ5U2VsZWN0b3IoJy53cy1iYXItbmFtZScpfHx7fSkudGV4dENvbnRlbnQgOiAnJztcbiAgICAgICAgcmV0dXJuIHtvazogISFiICYmICEhbiAmJiBuLmxlbmd0aCA+IDAgJiYgbi5pbmRleE9mKCdcdTUyQTBcdThGN0QnKSA8IDAgJiYgbi5pbmRleE9mKCdMb2FkaW5nJykgPCAwLCBkZXRhaWw6ICduYW1lPScrbn07YCwgMTVfMDAwKTtcbiAgICB9KTtcbiAgICBhd2FpdCBzaG90KCdmaW5hbCcpO1xuICB9XG5cbiAgY29uc3QgZmFpbGVkID0gcmVzdWx0cy5maWx0ZXIoKHIpID0+ICFyWzFdKS5sZW5ndGg7XG4gIGNvbnNvbGUubG9nKGBVSVZFUklGWSBTVU1NQVJZIHBhc3M9JHtyZXN1bHRzLmxlbmd0aCAtIGZhaWxlZH0vJHtyZXN1bHRzLmxlbmd0aH0gbW9kZT0ke21vZGV9IHNob3RzPSR7c2hvdHN9YCk7XG4gIGFwcC5leGl0KGZhaWxlZCA9PT0gMCA/IDAgOiAxKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGF0dGFjaFVpVmVyaWZ5KHdpbjogQnJvd3NlcldpbmRvdyk6IHZvaWQge1xuICBjb25zdCBtb2RlID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfTU9ERSA9PT0gJ3JlYWwnID8gJ3JlYWwnIDogJ2Zha2UnO1xuICB3aW4ud2ViQ29udGVudHMub25jZSgnZGlkLWZpbmlzaC1sb2FkJywgKCkgPT4ge1xuICAgIC8vIFx1N0VEOSBob3N0IFx1NTQyRlx1NTJBOFx1NzU1OVx1NjVGNlx1OTVGNDtcdTZCNjVcdTlBQTRcdTUxODVcdTkwRThcdTU0MDRcdTgxRUFcdThGNkVcdThCRTJcdTdCNDlcdTVGODVcbiAgICBzZXRUaW1lb3V0KCgpID0+IHsgdm9pZCBydW5VaVZlcmlmeSh3aW4sIG1vZGUpOyB9LCAzXzAwMCk7XG4gIH0pO1xufVxuIiwgIi8qKlxyXG4gKiB2NS4xIFx1NUI4OVx1ODhDNVx1NTQxMVx1NUJGQyBcdTAwQjcgQGhtaGFybmVzcy9jbGkgXHU1Qjg5XHU4OEM1XHU3RjE2XHU2MzkyKFx1NEUzQlx1OEZEQlx1N0EwQilcdTMwMDJcclxuICpcclxuICogXHU0RTI0XHU2NzYxXHU4REVGXHU1Rjg0KFx1NjNEMFx1NzkzQVx1OEJDRCB2NS4xIFx1NTQwOFx1NTQwQyk6XHJcbiAqICAtIG5wbSBcdTUzRUZcdTc1MjgoXHU5RUQ4XHU4QkE0KTpgbnBtIGluc3RhbGwgLS1wcmVmaXggJVVTRVJQUk9GSUxFJVxcLmhtaGFybmVzcy1nbG9iYWxcclxuICogICAgQGhtaGFybmVzcy9jbGlgIFx1MjAxNFx1MjAxNCBcdTUzRUFcdTUxOTlcdTc1MjhcdTYyMzdcdTc2RUVcdTVGNTUsXHU0RTBEXHU3OEIwXHU3Q0ZCXHU3RURGL25wbSBcdTUxNjhcdTVDNDA7bnBtIFx1ODFFQVx1NUUyNlx1NEY5RFx1OEQ1Nlx1ODlFM1x1Njc5MCxcclxuICogICAgXHU4RkRCXHU1RUE2XHU4RjZDXHU1M0QxXHU1MTc2XHU4RjkzXHU1MUZBXHU4ODRDKFx1NUI4OVx1ODhDNVx1NkI2NVx1OUFBNFx1NjU4N1x1Njg0OClcdTMwMDJcclxuICogIC0gXHU2NUUwIG5wbShcdTYyMTZcdTY2M0VcdTVGMEZcdTVGM0FcdTUyMzYpOlx1ODFFQVx1NzgxNCB0Z3ogXHU1Qjg5XHU4OEM1XHU1NjY4IFx1MjAxNFx1MjAxNCBcdTRGOURcdThENTZcdTk1RURcdTUzMDVcdTY3NjVcdTgxRUFcclxuICogICAgQGhtaC1kZXNrdG9wL2NsaS1pbnN0YWxsZXIoXHU3RUFGXHU5MDNCXHU4RjkxLFx1NURGMlx1NTM1NVx1NkQ0QiksdGFyYmFsbCBcdTkwMTBcdTUzMDVcdTZENDFcdTVGMEZcdTRFMEJcdThGN0RcclxuICogICAgKFx1NzcxRlx1NUI1N1x1ODI4Mlx1OEZEQlx1NUVBNiArIHJlZ2lzdHJ5Lm5wbWpzLm9yZ1x1MjE5MnJlZ2lzdHJ5Lm5wbW1pcnJvci5jb20gXHU5NTVDXHU1MENGXHU1NkRFXHU5MDAwLFxyXG4gKiAgICBcdTU5MERcdTc1MjggdjQgXHU2NkY0XHU2NUIwXHU1NjY4XHU1NkRFXHU5MDAwXHU2MDFEXHU2MEYzICsgaW50ZWdyaXR5IFx1NjgyMVx1OUE4QyksXHU3Q0ZCXHU3RURGIHRhci5leGUgXHU4OUUzXHU1MzhCXHU1MjMwXHJcbiAqICAgIG5vZGVfbW9kdWxlcyBcdTYyNDFcdTVFNzNcdTVFMDNcdTVDNDBcdTMwMDJcclxuICogXHU4RkRCXHU1RUE2XHU0RTAwXHU1RjhCXHU3RUNGIGluc3RhbGw6cHJvZ3Jlc3MgXHU0RThCXHU0RUY2XHU2M0E4IHJlbmRlcmVyO1x1NjIxMFx1NTI5Rlx1NTZERVx1OEMwMyBvbkluc3RhbGxlZChlbnRyeSlcclxuICogXHU3NTMxIG1haW4gXHU2MzAxXHU0RTQ1XHU1MzE2IHJ1bnRpbWUuanNvbiBcdTVFNzZcdTcwRURcdTkxQ0RcdTU0MkYgaG9zdFx1MzAwMlxyXG4gKi9cclxuaW1wb3J0IHsgc3Bhd24gfSBmcm9tICdub2RlOmNoaWxkX3Byb2Nlc3MnO1xyXG5pbXBvcnQgeyBleGlzdHNTeW5jLCBta2RpclN5bmMsIHJtU3luYywgcmVuYW1lU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gJ25vZGU6ZnMnO1xyXG5pbXBvcnQgeyBob21lZGlyIH0gZnJvbSAnbm9kZTpvcyc7XHJcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdub2RlOnBhdGgnO1xyXG5pbXBvcnQgeyBieXRlc0xhYmVsLCBpbnRlZ3JpdHlPaywgbW9kdWxlRGlyLCByZXNvbHZlQ2xvc3VyZSwgdGFyYmFsbE1pcnJvcnMsIHR5cGUgUGFja3VtZW50LCB0eXBlIFJlc29sdmVkUGtnIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2NsaS1pbnN0YWxsZXInO1xyXG5cclxuZXhwb3J0IGludGVyZmFjZSBJbnN0YWxsUHJvZ3Jlc3Mge1xyXG4gIHBoYXNlOiAnY2hlY2snIHwgJ21ldGEnIHwgJ2Rvd25sb2FkJyB8ICdleHRyYWN0JyB8ICducG0nIHwgJ2RvbmUnIHwgJ2Vycm9yJztcclxuICBwY3Q/OiBudW1iZXI7XHJcbiAgdGV4dDogc3RyaW5nO1xyXG4gIG1pcnJvcj86IHN0cmluZztcclxuICBlbnRyeT86IHN0cmluZztcclxuICBlcnJvcj86IHN0cmluZztcclxufVxyXG5cclxuZXhwb3J0IGludGVyZmFjZSBJbnN0YWxsT3B0aW9ucyB7XHJcbiAgLyoqIFx1NUYzQVx1NTIzNlx1OEQ3MFx1ODFFQVx1NzgxNCB0Z3ogXHU4REVGXHU1Rjg0KFx1NkQ0Qlx1OEJENS9cdTY1RTAgbnBtIFx1NzNBRlx1NTg4MylcdTMwMDIgKi9cclxuICBmb3JjZVRnej86IGJvb2xlYW4gfCB1bmRlZmluZWQ7XHJcbiAgLyoqIFx1OTU1Q1x1NTBDRlx1NEYxOFx1NTE0OFx1N0VBNyhcdTYzNjJcdTZFOTBcdTYzMDlcdTk0QUVcdTdGRkJcdThGNkMpXHUzMDAyICovXHJcbiAgbWlycm9yRmlyc3Q/OiAnbnBtanMnIHwgJ25wbW1pcnJvcicgfCB1bmRlZmluZWQ7XHJcbn1cclxuXHJcbmV4cG9ydCBjb25zdCBSRUdJU1RSSUVTOiBSZWNvcmQ8J25wbWpzJyB8ICducG1taXJyb3InLCBzdHJpbmc+ID0ge1xyXG4gIG5wbWpzOiAnaHR0cHM6Ly9yZWdpc3RyeS5ucG1qcy5vcmcnLFxyXG4gIG5wbW1pcnJvcjogJ2h0dHBzOi8vcmVnaXN0cnkubnBtbWlycm9yLmNvbScsXHJcbn07XHJcblxyXG4vKiogXHU1Qjg5XHU4OEM1XHU2ODM5XHU3NkVFXHU1RjU1KFx1NzUyOFx1NjIzN1x1NzZFRVx1NUY1NSxcdTdFRERcdTRFMERcdTUxOTlcdTdDRkJcdTdFREYvXHU1MTY4XHU1QzQwIG5wbSlcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGluc3RhbGxUYXJnZXQoKTogc3RyaW5nIHtcclxuICByZXR1cm4gam9pbihob21lZGlyKCksICcuaG1oYXJuZXNzLWdsb2JhbCcpO1xyXG59XHJcblxyXG4vKiogXHU1Qjg5XHU4OEM1XHU1QjhDXHU2MjEwXHU1NDBFXHU3Njg0IGRlc2t0b3AtaG9zdCBcdTUxNjVcdTUzRTMobnBtIFx1NUQ0Q1x1NTk1N1x1NEUwRVx1NjNEMFx1NTM0N1x1NEUyNFx1NzlDRFx1NUUwM1x1NUM0MFx1OTBGRFx1OEJBNClcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVJbnN0YWxsZWRFbnRyeSh0YXJnZXQ6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgY29uc3QgbmVzdGVkID0gam9pbih0YXJnZXQsICdub2RlX21vZHVsZXMnLCAnQGhtaGFybmVzcycsICdjbGknLCAnbm9kZV9tb2R1bGVzJywgJ0BobWhhcm5lc3MnLCAnd2ViJywgJ2Rpc3QnLCAnZGVza3RvcC1ob3N0LmpzJyk7XHJcbiAgY29uc3QgaG9pc3RlZCA9IGpvaW4odGFyZ2V0LCAnbm9kZV9tb2R1bGVzJywgJ0BobWhhcm5lc3MnLCAnd2ViJywgJ2Rpc3QnLCAnZGVza3RvcC1ob3N0LmpzJyk7XHJcbiAgaWYgKGV4aXN0c1N5bmMobmVzdGVkKSkgcmV0dXJuIG5lc3RlZDtcclxuICBpZiAoZXhpc3RzU3luYyhob2lzdGVkKSkgcmV0dXJuIGhvaXN0ZWQ7XHJcbiAgcmV0dXJuICcnO1xyXG59XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIEluc3RhbGxlckhvc3Qge1xyXG4gIHNlbmRQcm9ncmVzcyhwOiBJbnN0YWxsUHJvZ3Jlc3MpOiB2b2lkO1xyXG4gIGxvZyhtc2c6IHN0cmluZyk6IHZvaWQ7XHJcbiAgLyoqIFx1NUI4OVx1ODhDNVx1NjIxMFx1NTI5RihcdTUxNjVcdTUzRTNcdTVERjJcdTlBOENcdThCQzFcdTVCNThcdTU3MjgpXHUyMDE0XHUyMDE0IG1haW4gXHU1NzI4XHU2QjY0XHU2MzAxXHU0RTQ1XHU1MzE2XHU1RTc2XHU5MUNEXHU1NDJGIGhvc3RcdTMwMDIgKi9cclxuICBvbkluc3RhbGxlZChlbnRyeTogc3RyaW5nLCB2aWE6ICducG0nIHwgJ3RneicpOiB2b2lkO1xyXG59XHJcblxyXG5sZXQgcnVubmluZyA9IGZhbHNlO1xyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGluc3RhbGxSdW5uaW5nKCk6IGJvb2xlYW4ge1xyXG4gIHJldHVybiBydW5uaW5nO1xyXG59XHJcblxyXG4vKiogXHU1NDJGXHU1MkE4XHU1Qjg5XHU4OEM1KFx1NTQwRVx1NTNGMFx1NjI2N1x1ODg0QztcdThGREJcdTVFQTYvXHU3RUQzXHU2NzlDXHU1MTY4XHU5MEU4XHU3RUNGXHU0RThCXHU0RUY2XHU1NkRFXHU2RDQxLFByb21pc2UgXHU1M0VBXHU4ODY4XHU4RkJFXCJcdTVERjJcdTUzRDdcdTc0MDZcIilcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHN0YXJ0Q2xpSW5zdGFsbChob3N0OiBJbnN0YWxsZXJIb3N0LCBvcHRzOiBJbnN0YWxsT3B0aW9ucyA9IHt9KTogeyBvazogYm9vbGVhbjsgZXJyb3I/OiBzdHJpbmcgfSB7XHJcbiAgaWYgKHJ1bm5pbmcpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICdcdTVCODlcdTg4QzVcdTVERjJcdTU3MjhcdThGREJcdTg4NENcdTRFMkQnIH07XHJcbiAgcnVubmluZyA9IHRydWU7XHJcbiAgY29uc3QgZmluaXNoID0gKHA6IEluc3RhbGxQcm9ncmVzcyk6IHZvaWQgPT4ge1xyXG4gICAgaG9zdC5zZW5kUHJvZ3Jlc3MocCk7XHJcbiAgICBydW5uaW5nID0gZmFsc2U7XHJcbiAgfTtcclxuICBjb25zdCBmYWlsID0gKHRleHQ6IHN0cmluZywgZXJyOiB1bmtub3duKTogdm9pZCA9PiB7XHJcbiAgICBob3N0LmxvZyhgaW5zdGFsbCBmYWlsZWQ6ICR7dGV4dH0gJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxODApfWApO1xyXG4gICAgZmluaXNoKHsgcGhhc2U6ICdlcnJvcicsIHRleHQsIGVycm9yOiBgJHt0ZXh0fToke1N0cmluZyhlcnIpLnNsaWNlKDAsIDE2MCl9YCB9KTtcclxuICB9O1xyXG4gIHZvaWQgKGFzeW5jICgpID0+IHtcclxuICAgIGNvbnN0IHRhcmdldCA9IGluc3RhbGxUYXJnZXQoKTtcclxuICAgIHRyeSB7XHJcbiAgICAgIG1rZGlyU3luYyh0YXJnZXQsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xyXG4gICAgICBjb25zdCBucG1PayA9IG9wdHMuZm9yY2VUZ3ogPT09IHRydWUgPyBmYWxzZSA6IGF3YWl0IHByb2JlTnBtKGhvc3QpO1xyXG4gICAgICBpZiAobnBtT2spIGF3YWl0IGluc3RhbGxWaWFOcG0oaG9zdCwgdGFyZ2V0LCBvcHRzKTtcclxuICAgICAgZWxzZSBhd2FpdCBpbnN0YWxsVmlhVGFyYmFsbHMoaG9zdCwgdGFyZ2V0LCBvcHRzKTtcclxuICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICBmYWlsKCdcdTVCODlcdTg4QzVcdTU5MzFcdThEMjUnLCBlcnIpO1xyXG4gICAgfVxyXG4gIH0pKCk7XHJcbiAgcmV0dXJuIHsgb2s6IHRydWUgfTtcclxufVxyXG5cclxuLyogLS0tLSBucG0gXHU1M0VGXHU3NTI4XHU2MDI3KFx1NkNFOFx1NjEwRjpXaW5kb3dzIFx1NEUwQiBzcGF3bignbnBtJykgXHU1M0VGXHU4ODRDLCducG0uY21kJyBcdTUzQ0RcdTgwMEMgRUlOVkFMKSAtLS0tICovXHJcbmFzeW5jIGZ1bmN0aW9uIHByb2JlTnBtKGhvc3Q6IEluc3RhbGxlckhvc3QpOiBQcm9taXNlPGJvb2xlYW4+IHtcclxuICBob3N0LnNlbmRQcm9ncmVzcyh7IHBoYXNlOiAnY2hlY2snLCB0ZXh0OiAnXHU2OEMwXHU2N0U1IG5wbVx1MjAyNicgfSk7XHJcbiAgY29uc3Qgb2sgPSBhd2FpdCBuZXcgUHJvbWlzZTxib29sZWFuPigocmVzb2x2ZSkgPT4ge1xyXG4gICAgY29uc3QgYyA9IHNwYXduKCducG0nLCBbJy0tdmVyc2lvbiddLCB7IHdpbmRvd3NIaWRlOiB0cnVlLCBzdGRpbzogJ2lnbm9yZScgfSk7XHJcbiAgICBjb25zdCB0ID0gc2V0VGltZW91dCgoKSA9PiB7IHRyeSB7IGMua2lsbCgpOyB9IGNhdGNoIHsgLyogbm9vcCAqLyB9IHJlc29sdmUoZmFsc2UpOyB9LCAxNV8wMDApO1xyXG4gICAgYy5vbignZXJyb3InLCAoKSA9PiB7IGNsZWFyVGltZW91dCh0KTsgcmVzb2x2ZShmYWxzZSk7IH0pO1xyXG4gICAgYy5vbignZXhpdCcsIChjb2RlKSA9PiB7IGNsZWFyVGltZW91dCh0KTsgcmVzb2x2ZShjb2RlID09PSAwKTsgfSk7XHJcbiAgfSk7XHJcbiAgaG9zdC5sb2coYG5wbSAke29rID8gJ2F2YWlsYWJsZScgOiAndW5hdmFpbGFibGUnfSBcdTIxOTIgJHtvayA/ICducG0gcHJlZml4JyA6ICd0Z3onfSBwYXRoYCk7XHJcbiAgcmV0dXJuIG9rO1xyXG59XHJcblxyXG4vKiAtLS0tIFx1OERFRlx1NUY4NCBBOm5wbSAtLXByZWZpeChcdTVCODlcdTg4QzVcdTZCNjVcdTlBQTRcdTY1ODdcdTY4NDggPSBucG0gXHU4RjkzXHU1MUZBXHU4ODRDKSAtLS0tICovXHJcbmFzeW5jIGZ1bmN0aW9uIGluc3RhbGxWaWFOcG0oaG9zdDogSW5zdGFsbGVySG9zdCwgdGFyZ2V0OiBzdHJpbmcsIG9wdHM6IEluc3RhbGxPcHRpb25zKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgaG9zdC5zZW5kUHJvZ3Jlc3MoeyBwaGFzZTogJ25wbScsIHRleHQ6IGBucG0gaW5zdGFsbCBAaG1oYXJuZXNzL2NsaSBcdTIxOTIgJHt0YXJnZXR9KFx1NEVDNVx1NzUyOFx1NjIzN1x1NzZFRVx1NUY1NSlgIH0pO1xyXG4gIGNvbnN0IHJlZ2lzdHJ5ID0gb3B0cy5taXJyb3JGaXJzdCA9PT0gJ25wbW1pcnJvcicgPyBbJy0tcmVnaXN0cnknLCBSRUdJU1RSSUVTLm5wbW1pcnJvcl0gOiBvcHRzLm1pcnJvckZpcnN0ID09PSAnbnBtanMnID8gWyctLXJlZ2lzdHJ5JywgUkVHSVNUUklFUy5ucG1qc10gOiBbXTtcclxuICBjb25zdCBhcmdzID0gWydpbnN0YWxsJywgJy0tcHJlZml4JywgdGFyZ2V0LCAnLS1uby1hdWRpdCcsICctLW5vLWZ1bmQnLCAnLS1sb2dsZXZlbCcsICdub3RpY2UnLCAuLi5yZWdpc3RyeSwgJ0BobWhhcm5lc3MvY2xpQGxhdGVzdCddO1xyXG4gIGNvbnN0IGNvZGUgPSBhd2FpdCBuZXcgUHJvbWlzZTxudW1iZXI+KChyZXNvbHZlLCByZWplY3QpID0+IHtcclxuICAgIGNvbnN0IGMgPSBzcGF3bignbnBtJywgYXJncywgeyB3aW5kb3dzSGlkZTogdHJ1ZSwgY3dkOiBob21lZGlyKCkgfSk7XHJcbiAgICBsZXQgbGFzdCA9ICcnO1xyXG4gICAgY29uc3Qgb25MaW5lID0gKGQ6IEJ1ZmZlcik6IHZvaWQgPT4ge1xyXG4gICAgICBmb3IgKGNvbnN0IHJhdyBvZiBkLnRvU3RyaW5nKCkuc3BsaXQoL1xccj9cXG4vKSkge1xyXG4gICAgICAgIGNvbnN0IGxpbmUgPSByYXcucmVwbGFjZSgvW1xcdTAwMDAtXFx1MDAxZl0vZywgJycpLnRyaW0oKS5zbGljZSgwLCAxODApO1xyXG4gICAgICAgIGlmIChsaW5lID09PSAnJyB8fCBsaW5lID09PSBsYXN0KSBjb250aW51ZTtcclxuICAgICAgICBsYXN0ID0gbGluZTtcclxuICAgICAgICBob3N0LnNlbmRQcm9ncmVzcyh7IHBoYXNlOiAnbnBtJywgdGV4dDogbGluZSB9KTtcclxuICAgICAgfVxyXG4gICAgfTtcclxuICAgIGMuc3Rkb3V0Py5vbignZGF0YScsIG9uTGluZSk7XHJcbiAgICBjLnN0ZGVycj8ub24oJ2RhdGEnLCBvbkxpbmUpO1xyXG4gICAgYy5vbignZXJyb3InLCByZWplY3QpO1xyXG4gICAgY29uc3Qga2lsbGVyID0gc2V0VGltZW91dCgoKSA9PiB7IHRyeSB7IGMua2lsbCgpOyB9IGNhdGNoIHsgLyogbm9vcCAqLyB9IHJlamVjdChuZXcgRXJyb3IoJ25wbSBcdTVCODlcdTg4QzVcdThEODVcdTY1RjYoOCBcdTUyMDZcdTk0OUYpJykpOyB9LCA4ICogNjBfMDAwKTtcclxuICAgIGMub24oJ2V4aXQnLCAoeCkgPT4geyBjbGVhclRpbWVvdXQoa2lsbGVyKTsgcmVzb2x2ZSh4ID8/IDEpOyB9KTtcclxuICB9KTtcclxuICBpZiAoY29kZSAhPT0gMCkgdGhyb3cgbmV3IEVycm9yKGBucG0gaW5zdGFsbCBcdTkwMDBcdTUxRkFcdTc4MDEgJHtjb2RlfWApO1xyXG4gIGNvbnN0IGVudHJ5ID0gcmVzb2x2ZUluc3RhbGxlZEVudHJ5KHRhcmdldCk7XHJcbiAgaWYgKGVudHJ5ID09PSAnJykgdGhyb3cgbmV3IEVycm9yKCducG0gXHU1Qjg5XHU4OEM1XHU1QjhDXHU2MjEwXHU0RjQ2XHU2NzJBXHU2MjdFXHU1MjMwIGRlc2t0b3AtaG9zdCBcdTUxNjVcdTUzRTMnKTtcclxuICB3cml0ZVN0YW1wKHRhcmdldCwgJ25wbScpO1xyXG4gIGZpbmlzaEluc3RhbGwoaG9zdCwgZW50cnksICducG0nKTtcclxufVxyXG5cclxuLyogLS0tLSBcdThERUZcdTVGODQgQjpcdTgxRUFcdTc4MTQgdGd6KFx1NzcxRlx1NEUwQlx1OEY3RFx1OEZEQlx1NUVBNiArIFx1OTU1Q1x1NTBDRlx1NTZERVx1OTAwMCArIGludGVncml0eSArIHRhciBcdTg5RTNcdTUzOEIpIC0tLS0gKi9cclxuYXN5bmMgZnVuY3Rpb24gaW5zdGFsbFZpYVRhcmJhbGxzKGhvc3Q6IEluc3RhbGxlckhvc3QsIHRhcmdldDogc3RyaW5nLCBvcHRzOiBJbnN0YWxsT3B0aW9ucyk6IFByb21pc2U8dm9pZD4ge1xyXG4gIGNvbnN0IG9yZGVyOiBBcnJheTwnbnBtanMnIHwgJ25wbW1pcnJvcic+ID0gb3B0cy5taXJyb3JGaXJzdCA9PT0gJ25wbW1pcnJvcicgPyBbJ25wbW1pcnJvcicsICducG1qcyddIDogWyducG1qcycsICducG1taXJyb3InXTtcclxuICBjb25zdCBtaXJyb3JzID0gb3JkZXIubWFwKChrKSA9PiBSRUdJU1RSSUVTW2tdKTtcclxuICBob3N0LnNlbmRQcm9ncmVzcyh7IHBoYXNlOiAnbWV0YScsIHRleHQ6ICdcdTg5RTNcdTY3OTBcdTRGOURcdThENTZcdTZFMDVcdTUzNTUoQGhtaGFybmVzcy9jbGkgXHU1MTY4XHU1QkI2KVx1MjAyNicgfSk7XHJcblxyXG4gIGNvbnN0IHBhY2t1bWVudHMgPSBuZXcgTWFwPHN0cmluZywgUGFja3VtZW50PigpO1xyXG4gIGNvbnN0IGdldFBhY2t1bWVudCA9IGFzeW5jIChuYW1lOiBzdHJpbmcpOiBQcm9taXNlPFBhY2t1bWVudD4gPT4ge1xyXG4gICAgY29uc3QgaGl0ID0gcGFja3VtZW50cy5nZXQobmFtZSk7XHJcbiAgICBpZiAoaGl0ICE9PSB1bmRlZmluZWQpIHJldHVybiBoaXQ7XHJcbiAgICBsZXQgbGFzdEVyciA9ICcnO1xyXG4gICAgZm9yIChjb25zdCBtIG9mIG1pcnJvcnMpIHtcclxuICAgICAgdHJ5IHtcclxuICAgICAgICBjb25zdCByID0gYXdhaXQgZmV0Y2goYCR7bX0vJHtlbmNvZGVVUklDb21wb25lbnQobmFtZSl9YCwge1xyXG4gICAgICAgICAgaGVhZGVyczogeyBhY2NlcHQ6ICdhcHBsaWNhdGlvbi92bmQubnBtLmluc3RhbGwtdjEranNvbicgfSxcclxuICAgICAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCgyNV8wMDApLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIGlmICghci5vaykgeyBsYXN0RXJyID0gYEhUVFAgJHtyLnN0YXR1c31gOyBjb250aW51ZTsgfVxyXG4gICAgICAgIGNvbnN0IGRvYyA9IChhd2FpdCByLmpzb24oKSkgYXMgUGFja3VtZW50O1xyXG4gICAgICAgIGlmIChkb2MudmVyc2lvbnMgPT09IHVuZGVmaW5lZCkgeyBsYXN0RXJyID0gJ21hbGZvcm1lZCBwYWNrdW1lbnQnOyBjb250aW51ZTsgfVxyXG4gICAgICAgIHBhY2t1bWVudHMuc2V0KG5hbWUsIGRvYyk7XHJcbiAgICAgICAgcmV0dXJuIGRvYztcclxuICAgICAgfSBjYXRjaCAoZXJyKSB7IGxhc3RFcnIgPSBTdHJpbmcoZXJyKS5zbGljZSgwLCA2MCk7IH1cclxuICAgIH1cclxuICAgIHRocm93IG5ldyBFcnJvcihgXHU4M0I3XHU1M0Q2ICR7bmFtZX0gXHU1MTQzXHU2NTcwXHU2MzZFXHU1OTMxXHU4RDI1KFx1NTE2OFx1OTBFOFx1OTU1Q1x1NTBDRjoke2xhc3RFcnJ9KWApO1xyXG4gIH07XHJcblxyXG4gIGNvbnN0IGNsb3N1cmUgPSBhd2FpdCByZXNvbHZlQ2xvc3VyZSh7IG5hbWU6ICdAaG1oYXJuZXNzL2NsaScsIHNwZWM6ICdsYXRlc3QnIH0sIGdldFBhY2t1bWVudCk7XHJcbiAgY29uc3Qgcm9vdCA9IGNsb3N1cmUuZmluZCgocCkgPT4gcC5uYW1lID09PSAnQGhtaGFybmVzcy9jbGknKTtcclxuICBob3N0LmxvZyhgY2xvc3VyZTogJHtjbG9zdXJlLmxlbmd0aH0gcGFja2FnZXMgKHJvb3QgQGhtaGFybmVzcy9jbGlAJHtyb290Py52ZXJzaW9uID8/ICc/J30pYCk7XHJcbiAgaG9zdC5zZW5kUHJvZ3Jlc3MoeyBwaGFzZTogJ21ldGEnLCB0ZXh0OiBgXHU0RjlEXHU4RDU2XHU2RTA1XHU1MzU1XHU1QzMxXHU3RUVBOiR7Y2xvc3VyZS5sZW5ndGh9IFx1NEUyQVx1NTMwNShAaG1oYXJuZXNzL2NsaUAke3Jvb3Q/LnZlcnNpb24gPz8gJz8nfSlgIH0pO1xyXG5cclxuICBjb25zdCBzdGFnaW5nID0gam9pbih0YXJnZXQsICcuc3RhZ2luZycpO1xyXG4gIHJtU3luYyhzdGFnaW5nLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XHJcbiAgbWtkaXJTeW5jKHN0YWdpbmcsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xyXG5cclxuICBmb3IgKGxldCBpID0gMDsgaSA8IGNsb3N1cmUubGVuZ3RoOyBpKyspIHtcclxuICAgIGNvbnN0IHBrZyA9IGNsb3N1cmVbaV0hO1xyXG4gICAgY29uc3QgdXJscyA9IHRhcmJhbGxNaXJyb3JzKHBrZy50YXJiYWxsLCBtaXJyb3JzKTtcclxuICAgIGxldCBidWY6IEJ1ZmZlciB8IG51bGwgPSBudWxsO1xyXG4gICAgbGV0IHVzZWRNaXJyb3IgPSAnJztcclxuICAgIGxldCBsYXN0RXJyID0gJyc7XHJcbiAgICBmb3IgKGNvbnN0IHUgb2YgdXJscykge1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHIgPSBhd2FpdCBmZXRjaCh1LCB7IHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCgzMDBfMDAwKSB9KTtcclxuICAgICAgICBpZiAoIXIub2spIHsgbGFzdEVyciA9IGBIVFRQICR7ci5zdGF0dXN9YDsgY29udGludWU7IH1cclxuICAgICAgICBjb25zdCB0b3RhbCA9IE51bWJlcihyLmhlYWRlcnMuZ2V0KCdjb250ZW50LWxlbmd0aCcpID8/ICcwJyk7XHJcbiAgICAgICAgY29uc3QgcmVhZGVyID0gci5ib2R5Py5nZXRSZWFkZXIoKTtcclxuICAgICAgICBpZiAocmVhZGVyID09PSB1bmRlZmluZWQpIHRocm93IG5ldyBFcnJvcignbm8gYm9keScpO1xyXG4gICAgICAgIGNvbnN0IGNodW5rczogQnVmZmVyW10gPSBbXTtcclxuICAgICAgICBsZXQgZ290ID0gMDtcclxuICAgICAgICBsZXQgbGFzdEVtaXQgPSAwO1xyXG4gICAgICAgIGZvciAoOzspIHtcclxuICAgICAgICAgIGNvbnN0IHsgZG9uZSwgdmFsdWUgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XHJcbiAgICAgICAgICBpZiAoZG9uZSA9PT0gdHJ1ZSkgYnJlYWs7XHJcbiAgICAgICAgICBjb25zdCBiID0gQnVmZmVyLmZyb20odmFsdWUpO1xyXG4gICAgICAgICAgY2h1bmtzLnB1c2goYik7XHJcbiAgICAgICAgICBnb3QgKz0gYi5sZW5ndGg7XHJcbiAgICAgICAgICBpZiAoZ290IC0gbGFzdEVtaXQgPiAyNTYgKiAxMDI0KSB7XHJcbiAgICAgICAgICAgIGxhc3RFbWl0ID0gZ290O1xyXG4gICAgICAgICAgICBob3N0LnNlbmRQcm9ncmVzcyh7XHJcbiAgICAgICAgICAgICAgcGhhc2U6ICdkb3dubG9hZCcsXHJcbiAgICAgICAgICAgICAgcGN0OiBNYXRoLnJvdW5kKCgoaSArIE1hdGgubWluKGdvdCAvICh0b3RhbCB8fCBnb3QpLCAxKSkgLyBjbG9zdXJlLmxlbmd0aCkgKiAxMDApLFxyXG4gICAgICAgICAgICAgIHRleHQ6IGBcdTRFMEJcdThGN0QgJHtwa2cubmFtZX1AJHtwa2cudmVyc2lvbn0oJHtpICsgMX0vJHtjbG9zdXJlLmxlbmd0aH0pXHUwMEI3ICR7Ynl0ZXNMYWJlbChnb3QpfSR7dG90YWwgPiAwID8gYCAvICR7Ynl0ZXNMYWJlbCh0b3RhbCl9YCA6ICcnfWAsXHJcbiAgICAgICAgICAgICAgbWlycm9yOiBuZXcgVVJMKHUpLmhvc3QsXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgICAgICBidWYgPSBCdWZmZXIuY29uY2F0KGNodW5rcyk7XHJcbiAgICAgICAgaWYgKCFpbnRlZ3JpdHlPayhidWYsIHBrZy5pbnRlZ3JpdHkpKSB7IGxhc3RFcnIgPSAnaW50ZWdyaXR5IFx1NEUwRFx1NTMzOVx1OTE0RCc7IGJ1ZiA9IG51bGw7IGNvbnRpbnVlOyB9XHJcbiAgICAgICAgdXNlZE1pcnJvciA9IG5ldyBVUkwodSkuaG9zdDtcclxuICAgICAgICBicmVhaztcclxuICAgICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgbGFzdEVyciA9IFN0cmluZyhlcnIpLnNsaWNlKDAsIDYwKTtcclxuICAgICAgfVxyXG4gICAgfVxyXG4gICAgaWYgKGJ1ZiA9PT0gbnVsbCkgdGhyb3cgbmV3IEVycm9yKGBcdTRFMEJcdThGN0QgJHtwa2cubmFtZX0gXHU1OTMxXHU4RDI1KFx1NTE2OFx1OTBFOFx1OTU1Q1x1NTBDRjoke2xhc3RFcnJ9KWApO1xyXG4gICAgY29uc3QgdGd6ID0gam9pbihzdGFnaW5nLCBgJHtpfS50Z3pgKTtcclxuICAgIHdyaXRlRmlsZVN5bmModGd6LCBidWYpO1xyXG4gICAgaG9zdC5zZW5kUHJvZ3Jlc3Moe1xyXG4gICAgICBwaGFzZTogJ2Rvd25sb2FkJyxcclxuICAgICAgcGN0OiBNYXRoLnJvdW5kKCgoaSArIDEpIC8gY2xvc3VyZS5sZW5ndGgpICogMTAwKSxcclxuICAgICAgdGV4dDogYFx1NEUwQlx1OEY3RCAke3BrZy5uYW1lfUAke3BrZy52ZXJzaW9ufSBcdTVCOENcdTYyMTAoJHtieXRlc0xhYmVsKGJ1Zi5sZW5ndGgpfSx2aWEgJHt1c2VkTWlycm9yfSlgLFxyXG4gICAgICBtaXJyb3I6IHVzZWRNaXJyb3IsXHJcbiAgICB9KTtcclxuICB9XHJcblxyXG4gIGhvc3Quc2VuZFByb2dyZXNzKHsgcGhhc2U6ICdleHRyYWN0JywgdGV4dDogJ1x1ODlFM1x1NTM4Qlx1NUU3Nlx1NUUwM1x1NUM0MCBub2RlX21vZHVsZXNcdTIwMjYnIH0pO1xyXG4gIGZvciAobGV0IGkgPSAwOyBpIDwgY2xvc3VyZS5sZW5ndGg7IGkrKykge1xyXG4gICAgY29uc3QgcGtnID0gY2xvc3VyZVtpXSE7XHJcbiAgICBhd2FpdCBleHRyYWN0VGd6KGpvaW4oc3RhZ2luZywgYCR7aX0udGd6YCksIHN0YWdpbmcsIHBrZyk7XHJcbiAgICBob3N0LnNlbmRQcm9ncmVzcyh7IHBoYXNlOiAnZXh0cmFjdCcsIHBjdDogTWF0aC5yb3VuZCgoKGkgKyAxKSAvIGNsb3N1cmUubGVuZ3RoKSAqIDEwMCksIHRleHQ6IGBcdTg5RTNcdTUzOEIgJHtwa2cubmFtZX0oJHtpICsgMX0vJHtjbG9zdXJlLmxlbmd0aH0pYCB9KTtcclxuICB9XHJcbiAgcm1TeW5jKHN0YWdpbmcsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcclxuXHJcbiAgY29uc3QgZW50cnkgPSByZXNvbHZlSW5zdGFsbGVkRW50cnkodGFyZ2V0KTtcclxuICBpZiAoZW50cnkgPT09ICcnKSB0aHJvdyBuZXcgRXJyb3IoJ3RneiBcdTVCODlcdTg4QzVcdTVCOENcdTYyMTBcdTRGNDZcdTY3MkFcdTYyN0VcdTUyMzAgZGVza3RvcC1ob3N0IFx1NTE2NVx1NTNFMycpO1xyXG4gIHdyaXRlU3RhbXAodGFyZ2V0LCAndGd6Jyk7XHJcbiAgZmluaXNoSW5zdGFsbChob3N0LCBlbnRyeSwgJ3RneicpO1xyXG59XHJcblxyXG4vKiogdGFyLmV4ZShXaW4xMCsgXHU4MUVBXHU1RTI2KVx1ODlFM1x1NTM4QiB0Z3ogXHU1MjMwIGV4RGlyLFx1NTE4RFx1NjI4QSBwYWNrYWdlLyBcdTYzMkFcdTUyMzAgbm9kZV9tb2R1bGVzIFx1NUUwM1x1NUM0MFx1MzAwMiAqL1xyXG5hc3luYyBmdW5jdGlvbiBleHRyYWN0VGd6KHRnejogc3RyaW5nLCBzdGFnaW5nOiBzdHJpbmcsIHBrZzogUmVzb2x2ZWRQa2cpOiBQcm9taXNlPHZvaWQ+IHtcclxuICBjb25zdCBleERpciA9IGpvaW4oc3RhZ2luZywgYHgtJHtwa2cubmFtZS5yZXBsYWNlKC9bXlxcdy4tXS9nLCAnXycpfWApO1xyXG4gIHJtU3luYyhleERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xyXG4gIG1rZGlyU3luYyhleERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XHJcbiAgY29uc3QgY29kZSA9IGF3YWl0IG5ldyBQcm9taXNlPG51bWJlcj4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xyXG4gICAgY29uc3QgYyA9IHNwYXduKCd0YXInLCBbJy14emYnLCB0Z3osICctQycsIGV4RGlyXSwgeyB3aW5kb3dzSGlkZTogdHJ1ZSwgc3RkaW86ICdpZ25vcmUnIH0pO1xyXG4gICAgYy5vbignZXJyb3InLCByZWplY3QpO1xyXG4gICAgYy5vbignZXhpdCcsICh4KSA9PiByZXNvbHZlKHggPz8gMSkpO1xyXG4gIH0pO1xyXG4gIGlmIChjb2RlICE9PSAwKSB0aHJvdyBuZXcgRXJyb3IoYHRhciBcdTg5RTNcdTUzOEIgJHtwa2cubmFtZX0gXHU1OTMxXHU4RDI1KFx1OTAwMFx1NTFGQVx1NzgwMSAke2NvZGV9KWApO1xyXG4gIGNvbnN0IGRlc3QgPSBtb2R1bGVEaXIoaW5zdGFsbFRhcmdldCgpLCBwa2cubmFtZSk7XHJcbiAgY29uc3QgcGFyZW50ID0gZGVzdC5zbGljZSgwLCBkZXN0Lmxhc3RJbmRleE9mKCdcXFxcJykpO1xyXG4gIG1rZGlyU3luYyhwYXJlbnQsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xyXG4gIHJtU3luYyhkZXN0LCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XHJcbiAgcmVuYW1lU3luYyhqb2luKGV4RGlyLCAncGFja2FnZScpLCBkZXN0KTtcclxuICBybVN5bmMoZXhEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcclxufVxyXG5cclxuLyoqIFx1NUI4OVx1ODhDNVx1NjIzMyhcdTU0MTFcdTVCRkNcdTVCOENcdTYyMTBcdTk4NzUvXHU4QkJFXHU3RjZFXHU5NzYyXHU2NzdGXHU1QzU1XHU3OTNBXHU1Qjg5XHU4OEM1XHU2NUI5XHU1RjBGXHU0RTBFXHU2NUY2XHU5NUY0O1x1NEUwRFx1NjI3Rlx1OEY3RFx1OEZEMFx1ODg0Q1x1NjVGNlx1OTAzQlx1OEY5MSlcdTMwMDIgKi9cclxuZnVuY3Rpb24gd3JpdGVTdGFtcCh0YXJnZXQ6IHN0cmluZywgdmlhOiAnbnBtJyB8ICd0Z3onKTogdm9pZCB7XHJcbiAgdHJ5IHtcclxuICAgIHdyaXRlRmlsZVN5bmMoam9pbih0YXJnZXQsICdpbnN0YWxsZWQtYnktaG1oLWRlc2t0b3AuanNvbicpLCBKU09OLnN0cmluZ2lmeSh7IHZpYSwgYXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSB9LCBudWxsLCAyKSwgJ3V0ZjgnKTtcclxuICB9IGNhdGNoIHsgLyogYmVzdCBlZmZvcnQgKi8gfVxyXG59XHJcblxyXG5mdW5jdGlvbiBmaW5pc2hJbnN0YWxsKGhvc3Q6IEluc3RhbGxlckhvc3QsIGVudHJ5OiBzdHJpbmcsIHZpYTogJ25wbScgfCAndGd6Jyk6IHZvaWQge1xyXG4gIGhvc3QubG9nKGBpbnN0YWxsIGRvbmUgdmlhICR7dmlhfTogJHtlbnRyeX1gKTtcclxuICBob3N0LnNlbmRQcm9ncmVzcyh7IHBoYXNlOiAnZG9uZScsIHRleHQ6IGBcdTVCODlcdTg4QzVcdTVCOENcdTYyMTAoJHt2aWF9KWAsIGVudHJ5IH0pO1xyXG4gIGhvc3Qub25JbnN0YWxsZWQoZW50cnksIHZpYSk7XHJcbiAgcnVubmluZyA9IGZhbHNlO1xyXG59XHJcbiIsICIvKipcclxuICogQGhtaGFybmVzcy9jbGkgXHU1Qjg5XHU4OEM1XHU2ODM4XHU1RkMzKFx1N0VBRlx1OTAzQlx1OEY5MSxcdTk2RjYgSU8gXHUyMDE0XHUyMDE0IGZldGNoL1x1ODlFM1x1NTM4Qi9cdTg0M0RcdTc2RDhcdTU3MjhcdTRFM0JcdThGREJcdTdBMEIgaW5zdGFsbGVyIFx1OTFDQylcdTMwMDJcclxuICpcclxuICogXHU4MDRDXHU4RDIzKHY1LjEgXHU1Qjg5XHU4OEM1XHU1NDExXHU1QkZDKTpcdTdFRDlcdTVCOUEgcmVnaXN0cnkgXHU1MTQzXHU2NTcwXHU2MzZFXHU4M0I3XHU1M0Q2XHU1MUZEXHU2NTcwLFx1ODlFM1x1Njc5MCBAaG1oYXJuZXNzL2NsaSBcdTc2ODRcclxuICogXHU1QjhDXHU2NTc0XHU0RjlEXHU4RDU2XHU5NUVEXHU1MzA1KEBobWhhcm5lc3MvKiBcdTUxNjhcdTVCQjZcdTRFM0FcdTdDQkVcdTc4NkVcdTcyNDhcdTY3MkNcdTRFOTJcdTk0ODk7XHU1OTE2XHU5MEU4XHU0RjlEXHU4RDU2IHFyY29kZSBcdTk0RkVcdTRFM0EgXiBcdTgzMDNcdTU2RjQpLFxyXG4gKiBcdTRFQTdcdTUxRkFcIlx1ODhDNVx1NEVDMFx1NEU0OFx1MzAwMVx1NEVDRVx1NTRFQVx1NEU5Qlx1OTU1Q1x1NTBDRlx1NEUwQlx1MzAwMVx1ODhDNVx1NTIzMFx1NTRFQVwiXHU3Njg0XHU3ODZFXHU1QjlBXHU2MDI3XHU4QkExXHU1MjEyXHUzMDAyXHU4QkJFXHU4QkExXHU3RUE2XHU2NzVGOlxyXG4gKiAgLSBcdTk1RURcdTUzMDVcdTYzMDlcdTUzMDVcdTU0MERcdTUzQkJcdTkxQ0QoXHU5NEJCXHU3N0YzXHU0RjlEXHU4RDU2XHU1M0VBXHU4OEM1XHU0RTAwXHU0RUZELG5wbSBcdThCRURcdTRFNDkpO1xyXG4gKiAgLSBcdTgzMDNcdTU2RjRcdTg5RTNcdTY3OTBcdTUzRUFcdTY1MkZcdTYzMDEgbnBtIFx1NzUxRlx1NjAwMVx1NUI5RVx1OTY0NVx1NzUyOFx1NTIzMFx1NzY4NFx1NUY2Mlx1NjAwMTpcdTdDQkVcdTc4NkUgLyBsYXRlc3QgLyAqIC8gXiAvIH4gLyA+PSxcclxuICogICAgXHU0RTBEXHU1RjE1IHNlbXZlciBcdTVFOTMoXHU5NkY2XHU0RjlEXHU4RDU2XHU1MzlGXHU1MjE5LFx1NEUwRVx1ODFFQVx1NzgxNFx1NjZGNFx1NjVCMFx1NTY2OFx1NEUwMFx1ODFGNCk7XHJcbiAqICAtIG9wdGlvbmFsRGVwZW5kZW5jaWVzIFx1NEUwRFx1ODhDNTpcdTk1RURcdTUzMDVcdTUxODVcdTVCOUVcdTk2NDVcdTU4RjBcdTY2MEVcdTc2ODQgb3B0aW9uYWwgXHU1NzQ3XHU0RTNBXHU1RTczXHU1M0YwXHU3Mjc5XHU1QjlBXHJcbiAqICAgIChmc2V2ZW50cyBcdTdCNDkpLHRneiBcdThERUZcdTVGODRcdTRFMERcdThERDFcdTc1MUZcdTU0N0RcdTU0NjhcdTY3MUZcdTgxMUFcdTY3MkMsXHU4OEM1XHU0RTg2XHU0RTVGXHU1M0VBXHU2NjJGXHU2QjdCXHU5MUNEXHUzMDAyXHJcbiAqL1xyXG5pbXBvcnQgeyBjcmVhdGVIYXNoIH0gZnJvbSAnbm9kZTpjcnlwdG8nO1xyXG5cclxuZXhwb3J0IGludGVyZmFjZSBQa2dWZXJzaW9uTWV0YSB7XHJcbiAgdmVyc2lvbjogc3RyaW5nO1xyXG4gIGRlcGVuZGVuY2llczogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcclxuICB0YXJiYWxsOiBzdHJpbmc7XHJcbiAgaW50ZWdyaXR5Pzogc3RyaW5nIHwgdW5kZWZpbmVkO1xyXG59XHJcblxyXG4vKiogcmVnaXN0cnkgcGFja3VtZW50IFx1NzY4NFx1NjcwMFx1NUMwRlx1OEJGQlx1NTNENlx1OTc2MihkaXN0LXRhZ3MgKyBcdTUxNjhcdTcyNDhcdTY3MkNcdTRGOURcdThENTYvdGFyYmFsbCBcdTUxNDNcdTY1NzBcdTYzNkUpXHUzMDAyICovXHJcbmV4cG9ydCBpbnRlcmZhY2UgUGFja3VtZW50IHtcclxuICAnZGlzdC10YWdzJzogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcclxuICB2ZXJzaW9uczogUmVjb3JkPHN0cmluZywgeyBkZXBlbmRlbmNpZXM/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IHwgdW5kZWZpbmVkOyBkaXN0PzogeyB0YXJiYWxsPzogc3RyaW5nOyBpbnRlZ3JpdHk/OiBzdHJpbmcgfCB1bmRlZmluZWQgfSB8IHVuZGVmaW5lZCB9PjtcclxufVxyXG5cclxuZXhwb3J0IGludGVyZmFjZSBSZXNvbHZlZFBrZyB7XHJcbiAgbmFtZTogc3RyaW5nO1xyXG4gIHZlcnNpb246IHN0cmluZztcclxuICAvKiogcmVnaXN0cnkgXHU1MzlGXHU1OUNCXHU1NzMwXHU1NzQwKFx1OTU1Q1x1NTBDRlx1NTIxN1x1ODg2OFx1NzUzMSB0YXJiYWxsTWlycm9ycyBcdTZEM0VcdTc1MUYpXHUzMDAyICovXHJcbiAgdGFyYmFsbDogc3RyaW5nO1xyXG4gIGludGVncml0eT86IHN0cmluZyB8IHVuZGVmaW5lZDtcclxufVxyXG5cclxuLyogLS0tLSBzZW12ZXIoXHU2NzAwXHU1QzBGXHU1QjlFXHU3M0IwOlx1OTVFRFx1NTMwNVx1NTE4NVx1NUI5RVx1OTY0NVx1NTFGQVx1NzNCMFx1NzY4NFx1NUY2Mlx1NjAwMSkgLS0tLSAqL1xyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGNtcFNlbXZlcihhOiBzdHJpbmcsIGI6IHN0cmluZyk6IG51bWJlciB7XHJcbiAgY29uc3QgcGEgPSBhLnJlcGxhY2UoL152LywgJycpLnNwbGl0KCctJylbMF0hLnNwbGl0KCcuJykubWFwKE51bWJlcik7XHJcbiAgY29uc3QgcGIgPSBiLnJlcGxhY2UoL152LywgJycpLnNwbGl0KCctJylbMF0hLnNwbGl0KCcuJykubWFwKE51bWJlcik7XHJcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCAzOyBpKyspIHtcclxuICAgIGNvbnN0IHggPSBwYVtpXSA/PyAwO1xyXG4gICAgY29uc3QgeSA9IHBiW2ldID8/IDA7XHJcbiAgICBpZiAoeCAhPT0geSkgcmV0dXJuIHggPCB5ID8gLTEgOiAxO1xyXG4gIH1cclxuICByZXR1cm4gMDtcclxufVxyXG5cclxuLyoqIHJhbmdlIFx1NjYyRlx1NTQyNlx1NjNBNVx1NTNENyB2ZXJzaW9uKFx1NjUyRlx1NjMwMSBcdTdDQkVcdTc4NkUgLyBsYXRlc3QgLyAqIC8geCAvIF4gLyB+IC8gPj07XHU0RTBEXHU4QkM2XHU1MjJCXHU1MjE5IGZhbHNlKVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gc2F0aXNmaWVzKHJhbmdlOiBzdHJpbmcsIHZlcnNpb246IHN0cmluZyk6IGJvb2xlYW4ge1xyXG4gIGNvbnN0IHIgPSByYW5nZS50cmltKCk7XHJcbiAgaWYgKHIgPT09ICcnIHx8IHIgPT09ICcqJyB8fCByID09PSAnbGF0ZXN0JyB8fCByID09PSAneCcpIHJldHVybiB0cnVlO1xyXG4gIGlmIChyID09PSB2ZXJzaW9uKSByZXR1cm4gdHJ1ZTtcclxuICBjb25zdCBib3VuZCA9IC9eKFxcXnx+fD49PylcXHMqKFxcZCspXFwuKFxcZCspXFwuKFxcZCspLy5leGVjKHIpO1xyXG4gIGlmIChib3VuZCAhPT0gbnVsbCkge1xyXG4gICAgY29uc3Qgb3AgPSBib3VuZFsxXSE7XHJcbiAgICBjb25zdCBtYWpvciA9IE51bWJlcihib3VuZFsyXSk7XHJcbiAgICBjb25zdCBtaW5vciA9IE51bWJlcihib3VuZFszXSk7XHJcbiAgICBjb25zdCBwYXRjaCA9IE51bWJlcihib3VuZFs0XSk7XHJcbiAgICBjb25zdCBjID0gY21wU2VtdmVyKHZlcnNpb24sIGAke21ham9yfS4ke21pbm9yfS4ke3BhdGNofWApO1xyXG4gICAgaWYgKGMgPCAwKSByZXR1cm4gZmFsc2U7XHJcbiAgICBpZiAob3AgPT09ICc+PScpIHJldHVybiB0cnVlOyAvLyAnPj0nIFx1NEUwQlx1NzU0Q1x1NTM3M1x1NTNFRjpcdTk1RURcdTUzMDVcdTUxODVcdTUzRUFcdTRFRTUgJz49eC55LnogPHonIFx1NTkwRFx1NTQwOFx1NUY2Mlx1NjAwMVx1NTFGQVx1NzNCMCxcdTRGRERcdTVCODhcdTUzRDZcdTRFMEJcdTc1NENcclxuICAgIGlmIChvcCA9PT0gJ34nKSByZXR1cm4gY21wU2VtdmVyKHZlcnNpb24sIGAke21ham9yfS4ke21pbm9yICsgMX0uMGApIDwgMDtcclxuICAgIC8vICdeJzowLnggXHU3Mjc5XHU1MjI0KDAuMi4zIFx1NTE0MVx1OEJCOCAwLjIueiksXHU1MTc2XHU0RjU5XHU5NTAxXHU0RTNCXHU3MjQ4XHU2NzJDXHJcbiAgICBpZiAobWFqb3IgPT09IDApIHJldHVybiBtaW5vciA9PT0gMCA/IGNtcFNlbXZlcih2ZXJzaW9uLCBgMC4wLiR7cGF0Y2ggKyAxfWApIDwgMCA6IGNtcFNlbXZlcih2ZXJzaW9uLCBgMC4ke21pbm9yICsgMX0uMGApIDwgMDtcclxuICAgIHJldHVybiBjbXBTZW12ZXIodmVyc2lvbiwgYCR7bWFqb3IgKyAxfS4wLjBgKSA8IDA7XHJcbiAgfVxyXG4gIHJldHVybiBmYWxzZTtcclxufVxyXG5cclxuLyoqIFx1NEVDRSBwYWNrdW1lbnQgXHU5MDA5XHU1MUZBIHNwZWMoXHU3Q0JFXHU3ODZFL2xhdGVzdC9eL34vKilcdTYzMDdcdTU0MTFcdTc2ODRcdTcyNDhcdTY3MkM7XHU2NUUwXHU1MzM5XHU5MTREXHU4RkQ0XHU1NkRFICcnXHUzMDAyICovXHJcbmV4cG9ydCBmdW5jdGlvbiBwaWNrVmVyc2lvbihkb2M6IFBhY2t1bWVudCwgc3BlYzogc3RyaW5nKTogc3RyaW5nIHtcclxuICBjb25zdCBzID0gc3BlYy50cmltKCk7XHJcbiAgY29uc3QgdGFnID0gcyA9PT0gJycgfHwgcyA9PT0gJ2xhdGVzdCcgfHwgcyA9PT0gJyonID8gZG9jWydkaXN0LXRhZ3MnXT8ubGF0ZXN0IDogdW5kZWZpbmVkO1xyXG4gIGlmICh0YWcgIT09IHVuZGVmaW5lZCAmJiBkb2MudmVyc2lvbnNbdGFnXSAhPT0gdW5kZWZpbmVkKSByZXR1cm4gdGFnO1xyXG4gIGlmIChkb2MudmVyc2lvbnNbc10gIT09IHVuZGVmaW5lZCkgcmV0dXJuIHM7XHJcbiAgbGV0IGJlc3QgPSAnJztcclxuICBmb3IgKGNvbnN0IHYgb2YgT2JqZWN0LmtleXMoZG9jLnZlcnNpb25zKSkge1xyXG4gICAgaWYgKHNhdGlzZmllcyhzLCB2KSAmJiBjbXBTZW12ZXIodiwgYmVzdCkgPiAwKSBiZXN0ID0gdjtcclxuICB9XHJcbiAgcmV0dXJuIGJlc3Q7XHJcbn1cclxuXHJcbi8qIC0tLS0gXHU0RjlEXHU4RDU2XHU5NUVEXHU1MzA1IC0tLS0gKi9cclxuXHJcbi8qKlxyXG4gKiBcdTg5RTNcdTY3OTAgcm9vdCBcdTUzQ0FcdTUxNzZcdTUxNjhcdTkwRThcdTRGMjBcdTkwMTJcdTRGOURcdThENTYoQkZTLFx1NjMwOVx1NTMwNVx1NTQwRFx1NTNCQlx1OTFDRFx1NTNENlx1OTk5Nlx1NEUyQVx1ODlFM1x1Njc5MFx1N0VEM1x1Njc5QyBcdTIwMTRcdTIwMTQgXHU0RTBFIG5wbSBcdTYyNDFcdTVFNzNcclxuICogXHU1RTAzXHU1QzQwXHU0RTAwXHU4MUY0KVx1MzAwMmdldFBhY2t1bWVudCBcdTc1MzFcdThDMDNcdTc1MjhcdTY1QjlcdTZDRThcdTUxNjUoZmV0Y2ggXHU3RjUxXHU3RURDIC8gXHU2RDRCXHU4QkQ1XHU2Q0U4XHU1MTY1XHU1QjU3XHU1MTc4KVx1MzAwMlxyXG4gKiBcdTRFRkJcdTRFMDBcdTRGOURcdThENTZcdTY1RTBcdTZFRTFcdThEQjNcdTcyNDhcdTY3MkNcdTY1RjZcdTYyOUJcdTk1MTkoXHU1RTI2XHU1MzA1XHU1NDBEXHU0RTBFIHJhbmdlLFx1OTc2Mlx1NTQxMVx1NUI4OVx1ODhDNVx1OTg3NVx1OTUxOVx1OEJFRlx1NjU4N1x1Njg0OClcdTMwMDJcclxuICovXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZXNvbHZlQ2xvc3VyZShcclxuICByb290OiB7IG5hbWU6IHN0cmluZzsgc3BlYzogc3RyaW5nIH0sXHJcbiAgZ2V0UGFja3VtZW50OiAobmFtZTogc3RyaW5nKSA9PiBQcm9taXNlPFBhY2t1bWVudD4sXHJcbik6IFByb21pc2U8UmVzb2x2ZWRQa2dbXT4ge1xyXG4gIGNvbnN0IHJlc29sdmVkID0gbmV3IE1hcDxzdHJpbmcsIFBrZ1ZlcnNpb25NZXRhPigpO1xyXG4gIGNvbnN0IHF1ZXVlOiBBcnJheTx7IG5hbWU6IHN0cmluZzsgc3BlYzogc3RyaW5nIH0+ID0gW3Jvb3RdO1xyXG4gIHdoaWxlIChxdWV1ZS5sZW5ndGggPiAwKSB7XHJcbiAgICBjb25zdCB7IG5hbWUsIHNwZWMgfSA9IHF1ZXVlLnNoaWZ0KCkhO1xyXG4gICAgaWYgKHJlc29sdmVkLmhhcyhuYW1lKSkgY29udGludWU7IC8vIFx1NURGMlx1NUI5QVx1NzI0ODpcdTU0MEVcdTdFRUQgcmFuZ2UgXHU1RjE1XHU3NTI4XHU0RTBEXHU1MThEXHU5MUNEXHU4OUUzKG5wbSBcdTYyNDFcdTVFNzNcdThCRURcdTRFNDkpXHJcbiAgICBjb25zdCBkb2MgPSBhd2FpdCBnZXRQYWNrdW1lbnQobmFtZSk7XHJcbiAgICBjb25zdCB2ZXJzaW9uID0gcGlja1ZlcnNpb24oZG9jLCBzcGVjKTtcclxuICAgIGNvbnN0IG1ldGEgPSB2ZXJzaW9uICE9PSAnJyA/IGRvYy52ZXJzaW9uc1t2ZXJzaW9uXSA6IHVuZGVmaW5lZDtcclxuICAgIGlmIChtZXRhID09PSB1bmRlZmluZWQgfHwgbWV0YS5kaXN0Py50YXJiYWxsID09PSB1bmRlZmluZWQpIHtcclxuICAgICAgdGhyb3cgbmV3IEVycm9yKGBubyB2ZXJzaW9uIG9mICR7bmFtZX0gc2F0aXNmaWVzICR7c3BlYyB8fCAnbGF0ZXN0J31gKTtcclxuICAgIH1cclxuICAgIGNvbnN0IGl0ZW06IFBrZ1ZlcnNpb25NZXRhID0ge1xyXG4gICAgICB2ZXJzaW9uLFxyXG4gICAgICBkZXBlbmRlbmNpZXM6IG1ldGEuZGVwZW5kZW5jaWVzID8/IHt9LFxyXG4gICAgICB0YXJiYWxsOiBtZXRhLmRpc3QudGFyYmFsbCxcclxuICAgICAgaW50ZWdyaXR5OiBtZXRhLmRpc3QuaW50ZWdyaXR5LFxyXG4gICAgfTtcclxuICAgIHJlc29sdmVkLnNldChuYW1lLCBpdGVtKTtcclxuICAgIGZvciAoY29uc3QgW2RlcCwgcmFuZ2VdIG9mIE9iamVjdC5lbnRyaWVzKGl0ZW0uZGVwZW5kZW5jaWVzKSkge1xyXG4gICAgICBpZiAoIXJlc29sdmVkLmhhcyhkZXApKSBxdWV1ZS5wdXNoKHsgbmFtZTogZGVwLCBzcGVjOiByYW5nZSB9KTtcclxuICAgIH1cclxuICB9XHJcbiAgcmV0dXJuIFsuLi5yZXNvbHZlZC5lbnRyaWVzKCldLm1hcCgoW25hbWUsIG1dKSA9PiAoeyBuYW1lLCB2ZXJzaW9uOiBtLnZlcnNpb24sIHRhcmJhbGw6IG0udGFyYmFsbCwgaW50ZWdyaXR5OiBtLmludGVncml0eSB9KSk7XHJcbn1cclxuXHJcbi8qIC0tLS0gXHU5NTVDXHU1MENGXHU0RTBFXHU1RTAzXHU1QzQwIC0tLS0gKi9cclxuXHJcbmNvbnN0IFJFR0lTVFJZX0hPU1RTID0gL14oaHR0cHM/OlxcL1xcL1teL10rKVxcLyguKikkLztcclxuXHJcbi8qKlxyXG4gKiB0YXJiYWxsIFx1NzY4NFx1OTU1Q1x1NTBDRlx1NTAxOVx1OTAwOShcdTk4N0FcdTVFOEZcdTUzNzNcdTU2REVcdTkwMDBcdTk4N0FcdTVFOEYpOlx1NTM5Rlx1NTlDQlx1NTczMFx1NTc0MCBcdTIxOTIgXHU1NDA0IHJlZ2lzdHJ5IFx1NTQwQ1x1OERFRlx1NUY4NFx1NjUzOVx1NTE5OVx1MzAwMlxyXG4gKiBwYWNrdW1lbnQgXHU5MUNDXHU3Njg0IGRpc3QudGFyYmFsbCBcdTYwNTJcdTYzMDdcdTU0MTFcdTUzRDFcdTVFMDNcdTZFOTAocmVnaXN0cnkubnBtanMub3JnKSxcdTU2RkRcdTUxODVcdTdGNTFcdTdFRENcclxuICogXHU0RTBEXHU1M0VGXHU4RkJFXHU2NUY2XHU2MzA5IHJlZ2lzdHJ5IFx1NTIxN1x1ODg2OFx1NjUzOVx1NTE5OSBob3N0KFx1OERFRlx1NUY4NFx1NEUwRFx1NTNEOCBcdTIwMTRcdTIwMTQgbnBtbWlycm9yIFx1NEUwRSBucG1qcyBcdTU0MENcdTY3ODQpXHUzMDAyXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gdGFyYmFsbE1pcnJvcnModGFyYmFsbDogc3RyaW5nLCByZWdpc3RyaWVzOiBzdHJpbmdbXSk6IHN0cmluZ1tdIHtcclxuICBjb25zdCBtID0gUkVHSVNUUllfSE9TVFMuZXhlYyh0YXJiYWxsKTtcclxuICBjb25zdCBwYXRoID0gbT8uWzJdID8/ICcnO1xyXG4gIGNvbnN0IG91dCA9IFt0YXJiYWxsXTtcclxuICBmb3IgKGNvbnN0IHJlZyBvZiByZWdpc3RyaWVzKSB7XHJcbiAgICBjb25zdCBiYXNlID0gcmVnLnJlcGxhY2UoL1xcLyskLywgJycpO1xyXG4gICAgaWYgKGJhc2UgPT09IG0/LlsxXSkgY29udGludWU7XHJcbiAgICBjb25zdCB1ID0gYCR7YmFzZX0vJHtwYXRofWA7XHJcbiAgICBpZiAoIW91dC5pbmNsdWRlcyh1KSkgb3V0LnB1c2godSk7XHJcbiAgfVxyXG4gIHJldHVybiBvdXQ7XHJcbn1cclxuXHJcbi8qKiBcdTUzMDVcdTU3Mjggbm9kZV9tb2R1bGVzIFx1NEUwQlx1NzY4NFx1NzZFRVx1NjgwN1x1NzZFRVx1NUY1NShzY29wZWQgXHU1MzA1XHU0RkREXHU2MzAxIEBzY29wZS9uYW1lIFx1NEUyNFx1N0VBNylcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIG1vZHVsZURpcihwcmVmaXg6IHN0cmluZywgbmFtZTogc3RyaW5nKTogc3RyaW5nIHtcclxuICBjb25zdCBwYXJ0cyA9IG5hbWUuc3BsaXQoJy8nKS5maWx0ZXIoKHApID0+IHAgIT09ICcnICYmIHAgIT09ICcuJyk7XHJcbiAgaWYgKG5hbWUuc3RhcnRzV2l0aCgnQCcpICYmIHBhcnRzLmxlbmd0aCAhPT0gMikgdGhyb3cgbmV3IEVycm9yKGBpbnZhbGlkIHBhY2thZ2UgbmFtZTogJHtuYW1lfWApO1xyXG4gIGlmICghbmFtZS5zdGFydHNXaXRoKCdAJykgJiYgcGFydHMubGVuZ3RoICE9PSAxKSB0aHJvdyBuZXcgRXJyb3IoYGludmFsaWQgcGFja2FnZSBuYW1lOiAke25hbWV9YCk7XHJcbiAgcmV0dXJuIFsuLi5wYXJ0c10ucmVkdWNlKChkaXIsIHApID0+IGAke2Rpcn1cXFxcJHtwfWAsIGAke3ByZWZpeH1cXFxcbm9kZV9tb2R1bGVzYCk7XHJcbn1cclxuXHJcbi8qIC0tLS0gaW50ZWdyaXR5IC0tLS0gKi9cclxuXHJcbi8qKiBucG0gZGlzdC5pbnRlZ3JpdHkoJ3NoYTUxMi1iYXNlNjQnKSBcdTY4MjFcdTlBOEM7XHU0RTBEXHU1MzM5XHU5MTREXHU4RkQ0XHU1NkRFIGZhbHNlKFx1NjcyQVx1NzdFNVx1N0I5N1x1NkNENVx1OEZENFx1NTZERSB0cnVlIFx1NjUzRVx1ODg0QylcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGludGVncml0eU9rKGRhdGE6IEJ1ZmZlciwgaW50ZWdyaXR5Pzogc3RyaW5nKTogYm9vbGVhbiB7XHJcbiAgaWYgKGludGVncml0eSA9PT0gdW5kZWZpbmVkIHx8IGludGVncml0eSA9PT0gJycpIHJldHVybiB0cnVlO1xyXG4gIGNvbnN0IG0gPSAvXnNoYTUxMi0oW0EtWmEtejAtOSsvPV0rKSQvLmV4ZWMoaW50ZWdyaXR5LnRyaW0oKSk7XHJcbiAgaWYgKG0gPT09IG51bGwpIHJldHVybiB0cnVlO1xyXG4gIHJldHVybiBjcmVhdGVIYXNoKCdzaGE1MTInKS51cGRhdGUoZGF0YSkuZGlnZXN0KCdiYXNlNjQnKSA9PT0gbVsxXTtcclxufVxyXG5cclxuLyoqIFx1NEVCQVx1N0M3Qlx1NTNFRlx1OEJGQlx1NUI1N1x1ODI4MihcdTVCODlcdTg4QzVcdThGREJcdTVFQTZcdTY1ODdcdTY4NDhcdTc1MjgpXHUzMDAyICovXHJcbmV4cG9ydCBmdW5jdGlvbiBieXRlc0xhYmVsKG46IG51bWJlcik6IHN0cmluZyB7XHJcbiAgaWYgKG4gPCAxMDI0KSByZXR1cm4gYCR7bn0gQmA7XHJcbiAgaWYgKG4gPCAxMDI0ICogMTAyNCkgcmV0dXJuIGAkeyhuIC8gMTAyNCkudG9GaXhlZCgwKX0gS0JgO1xyXG4gIHJldHVybiBgJHsobiAvIDEwMjQgLyAxMDI0KS50b0ZpeGVkKDEpfSBNQmA7XHJcbn1cclxuIl0sCiAgIm1hcHBpbmdzIjogIjtBQWNBLFNBQVMsT0FBQUEsTUFBSyxlQUFlLFFBQVEsU0FBUyxTQUFTLE9BQU8sTUFBTSxjQUFjLE1BQU0sYUFBYSxtQkFBbUI7QUFDeEgsU0FBUyxRQUFBQyxPQUFNLFNBQVMsVUFBVSxZQUFZLGVBQWU7QUFDN0QsU0FBUyxjQUFBQyxhQUFZLGdCQUFBQyxlQUFjLG9CQUFvQjtBQUN2RCxTQUFTLGFBQUFDLFlBQVcsZ0JBQWdCO0FBQ3BDLFNBQVMsV0FBQUMsVUFBUyx5QkFBeUI7QUFDM0MsU0FBUyxjQUFjLFNBQUFDLGNBQWE7QUFDcEMsU0FBUyxpQkFBQUMsc0JBQXFCOzs7QUNWOUIsU0FBUyxhQUFnQztBQUN6QyxTQUFTLHVCQUF1QjtBQUNoQyxTQUFTLG1CQUFtQjs7O0FDRHJCLElBQU0sY0FBYztBQUFBLEVBQ3pCO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFDRjtBQUlPLElBQU0sdUJBQXVCOzs7QUNsQjdCLElBQU0sY0FBYztBQUFBLEVBQ3pCO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFDRjtBQUlPLElBQU0sbUJBQW1CLENBQUMsYUFBYSxVQUFVLFVBQVUsV0FBVztBQWN0RSxTQUFTLGFBQ2QsTUFDQSxTQUNBLE9BQXFHLENBQUMsR0FDeEY7QUFDZCxRQUFNLElBQWtCLEVBQUUsTUFBTSxTQUFTLFdBQVcsS0FBSyxjQUFjLEtBQUs7QUFDNUUsTUFBSSxLQUFLLGNBQWMsT0FBVyxHQUFFLFlBQVksS0FBSztBQUNyRCxNQUFJLEtBQUssVUFBVSxPQUFXLEdBQUUsUUFBUSxLQUFLO0FBQzdDLE1BQUksS0FBSyxtQkFBbUIsT0FBVyxHQUFFLGlCQUFpQixLQUFLO0FBQy9ELFNBQU87QUFDVDs7O0FDMUJBLElBQU0sV0FBVyxDQUFDLE1BQ2hCLE9BQU8sTUFBTSxZQUFZLE1BQU0sUUFBUSxDQUFDLE1BQU0sUUFBUSxDQUFDO0FBRXpELElBQU0sbUJBQW1CLENBQUMsTUFBNEIsT0FBTyxNQUFNLFlBQVksRUFBRSxTQUFTO0FBRTFGLElBQU0sWUFBWSxDQUFDLE1BQXVCO0FBQ3hDLFFBQU0sSUFBSSxLQUFLLE1BQU0sQ0FBQztBQUN0QixTQUFPLE9BQU8sU0FBUyxDQUFDLEtBQUsscUJBQXFCLEtBQUssQ0FBQztBQUMxRDtBQUVPLFNBQVMsZ0JBQWdCLEdBQWdDO0FBQzlELE1BQUksQ0FBQyxTQUFTLENBQUMsRUFBRyxRQUFPO0FBQ3pCLE1BQUksRUFBRSxrQkFBa0IscUJBQXNCLFFBQU87QUFDckQsTUFBSSxDQUFDLGlCQUFpQixFQUFFLE9BQU8sRUFBRyxRQUFPO0FBQ3pDLE1BQUksQ0FBQyxpQkFBaUIsRUFBRSxTQUFTLEVBQUcsUUFBTztBQUMzQyxNQUFJLENBQUMsaUJBQWlCLEVBQUUsS0FBSyxFQUFHLFFBQU87QUFDdkMsTUFBSSxPQUFPLEVBQUUsUUFBUSxZQUFZLENBQUMsT0FBTyxVQUFVLEVBQUUsR0FBRyxLQUFLLEVBQUUsTUFBTSxFQUFHLFFBQU87QUFDL0UsTUFBSSxDQUFDLGlCQUFpQixFQUFFLFVBQVUsS0FBSyxDQUFDLFVBQVUsRUFBRSxVQUFVLEVBQUcsUUFBTztBQUN4RSxNQUFJLENBQUMsWUFBWSxTQUFTLEVBQUUsSUFBaUIsRUFBRyxRQUFPO0FBQ3ZELFNBQU8sU0FBUyxFQUFFLE9BQU87QUFDM0I7QUFFTyxTQUFTLGVBQWUsR0FBK0I7QUFDNUQsTUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFHLFFBQU87QUFDekIsTUFBSSxDQUFDLFlBQVksU0FBUyxFQUFFLElBQWEsRUFBRyxRQUFPO0FBQ25ELE1BQUksT0FBTyxFQUFFLFlBQVksU0FBVSxRQUFPO0FBQzFDLE1BQUksT0FBTyxFQUFFLGNBQWMsVUFBVyxRQUFPO0FBQzdDLE1BQUksRUFBRSxjQUFjLFVBQWEsQ0FBQyxpQkFBaUIsRUFBRSxTQUFTLEVBQUcsUUFBTztBQUN4RSxNQUFJLEVBQUUsVUFBVSxVQUFhLENBQUMsaUJBQWlCLEVBQUUsS0FBSyxFQUFHLFFBQU87QUFDaEUsTUFBSSxFQUFFLG1CQUFtQixVQUFhLENBQUMsaUJBQWlCLFNBQVMsRUFBRSxjQUF1QixFQUFHLFFBQU87QUFDcEcsU0FBTztBQUNUO0FBT08sU0FBUyxnQkFBZ0IsR0FBK0U7QUFDN0csTUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFHLFFBQU87QUFDekIsTUFBSSxFQUFFLHdCQUF3QixLQUFNLFFBQU87QUFDM0MsTUFBSSxPQUFPLEVBQUUsU0FBUyxZQUFZLENBQUMsT0FBTyxVQUFVLEVBQUUsSUFBSSxLQUFLLEVBQUUsUUFBUSxLQUFLLEVBQUUsT0FBTyxNQUFPLFFBQU87QUFDckcsU0FBTyxpQkFBaUIsRUFBRSxPQUFPO0FBQ25DOzs7QUhIQSxJQUFNLDJCQUEyQjtBQUNqQyxJQUFNLHVCQUF1QjtBQUM3QixJQUFNLHNCQUFzQjtBQUVyQixJQUFNLDJCQUFOLE1BQStCO0FBQUEsRUFVcEMsWUFDbUIsTUFDakIsT0FBMEIsQ0FBQyxHQUMzQjtBQUZpQjtBQUdqQixTQUFLLFFBQVEsS0FBSyxTQUFTLFlBQVksRUFBRSxFQUFFLFNBQVMsV0FBVztBQUMvRCxTQUFLLE9BQU87QUFBQSxNQUNWLGFBQWEsS0FBSyxlQUFlO0FBQUEsTUFDakMsZ0JBQWdCLEtBQUssa0JBQWtCO0FBQUEsTUFDdkMsb0JBQW9CLEtBQUssc0JBQXNCO0FBQUEsTUFDL0MsR0FBRztBQUFBLElBQ0w7QUFBQSxFQUNGO0FBQUEsRUFWbUI7QUFBQSxFQVZYLFFBQTZCO0FBQUEsRUFDN0IsU0FBb0I7QUFBQSxFQUNwQixlQUFlO0FBQUEsRUFDZixZQUFZO0FBQUEsRUFDWixXQUFXO0FBQUEsRUFDRjtBQUFBLEVBQ0E7QUFBQSxFQUNULGNBQWlDLENBQUM7QUFBQSxFQWUxQyxJQUFJLFFBQW1CO0FBQ3JCLFdBQU8sS0FBSztBQUFBLEVBQ2Q7QUFBQSxFQUVBLElBQUksZUFBdUI7QUFDekIsV0FBTyxLQUFLO0FBQUEsRUFDZDtBQUFBLEVBRVEsU0FBUyxHQUFjLEtBQW9CO0FBQ2pELFNBQUssU0FBUztBQUNkLFFBQUksUUFBUSxPQUFXLE1BQUssWUFBWTtBQUN4QyxVQUFNLE9BQXFELEVBQUUsY0FBYyxLQUFLLGFBQWE7QUFDN0YsUUFBSSxLQUFLLGNBQWMsR0FBSSxNQUFLLFlBQVksS0FBSztBQUNqRCxTQUFLLEtBQUssZ0JBQWdCLEdBQUcsSUFBSTtBQUFBLEVBQ25DO0FBQUE7QUFBQSxFQUdBLE1BQU0sUUFBK0I7QUFDbkMsUUFBSSxLQUFLLFdBQVcsV0FBVyxLQUFLLFdBQVcsWUFBWTtBQUN6RCxZQUFNLGFBQWEsa0JBQWtCLHNCQUFzQixLQUFLLE1BQU0sRUFBRTtBQUFBLElBQzFFO0FBQ0EsU0FBSyxlQUFlO0FBQ3BCLFNBQUssV0FBVztBQUNoQixXQUFPLEtBQUssT0FBTztBQUFBLEVBQ3JCO0FBQUEsRUFFQSxNQUFjLFNBQWdDO0FBQzVDLFNBQUssU0FBUyxVQUFVO0FBQ3hCLFVBQU0sUUFBUSxNQUFNLEtBQUssS0FBSyxTQUFTLEtBQUssS0FBSyxNQUFNO0FBQUEsTUFDckQsS0FBSyxLQUFLLEtBQUs7QUFBQSxNQUNmLEtBQUs7QUFBQSxRQUNILEdBQUcsUUFBUTtBQUFBLFFBQ1gsR0FBRyxLQUFLLEtBQUs7QUFBQSxRQUNiLG1CQUFtQixLQUFLO0FBQUEsTUFDMUI7QUFBQSxNQUNBLE9BQU8sQ0FBQyxVQUFVLFFBQVEsTUFBTTtBQUFBLE1BQ2hDLGFBQWE7QUFBQSxJQUNmLENBQUM7QUFDRCxTQUFLLFFBQVE7QUFFYixRQUFJO0FBQ0YsWUFBTSxXQUFXLE1BQU0sS0FBSyxXQUFXLEtBQUs7QUFDNUMsV0FBSyxrQkFBa0IsRUFBRSxNQUFNLFNBQVMsTUFBTSxTQUFTLFNBQVMsUUFBUTtBQUN4RSxXQUFLLFNBQVMsT0FBTztBQUNyQixXQUFLLEtBQUssVUFBVSxRQUFRO0FBRTVCLFlBQU0sS0FBSyxRQUFRLE1BQU07QUFDdkIsYUFBSyxZQUFZLFFBQVEsQ0FBQyxNQUFNLEVBQUUsQ0FBQztBQUNuQyxhQUFLLGNBQWMsQ0FBQztBQUNwQixhQUFLLGlCQUFpQjtBQUFBLE1BQ3hCLENBQUM7QUFDRCxhQUFPO0FBQUEsSUFDVCxTQUFTLEtBQUs7QUFDWixVQUFJLENBQUMsTUFBTSxPQUFRLE9BQU0sS0FBSztBQUM5QixVQUFJLEtBQUssVUFBVSxNQUFPLE1BQUssUUFBUTtBQUN2QyxZQUFNO0FBQUEsSUFDUjtBQUFBLEVBQ0Y7QUFBQTtBQUFBLEVBR1EsV0FBVyxPQUE0QztBQUM3RCxXQUFPLElBQUksUUFBc0IsQ0FBQ0MsVUFBUyxXQUFXO0FBQ3BELFlBQU0sUUFBUSxXQUFXLE1BQU07QUFDN0IsZUFBTyxhQUFhLGtCQUFrQixvQ0FBb0MsS0FBSyxLQUFLLGNBQWMsTUFBTSxFQUFFLFdBQVcsTUFBTSxnQkFBZ0IsWUFBWSxDQUFDLENBQUM7QUFBQSxNQUMzSixHQUFHLEtBQUssS0FBSyxjQUFjO0FBRTNCLFlBQU0sT0FBTyxDQUFDLE9BQXlCO0FBQ3JDLHFCQUFhLEtBQUs7QUFDbEIsV0FBRztBQUFBLE1BQ0w7QUFFQSxVQUFJLENBQUMsTUFBTSxRQUFRO0FBQ2pCLGFBQUssTUFBTSxPQUFPLGFBQWEsbUJBQW1CLGtDQUFrQyxDQUFDLENBQUM7QUFDdEY7QUFBQSxNQUNGO0FBRUEsWUFBTSxLQUFLLGdCQUFnQixFQUFFLE9BQU8sTUFBTSxPQUFPLENBQUM7QUFDbEQsWUFBTSxTQUFTLENBQUMsU0FBdUI7QUFDckMsWUFBSTtBQUNKLFlBQUk7QUFDRixtQkFBUyxLQUFLLE1BQU0sSUFBSTtBQUFBLFFBQzFCLFFBQVE7QUFDTjtBQUFBLFFBQ0Y7QUFDQSxZQUFJLGdCQUFnQixNQUFNLEdBQUc7QUFDM0IsYUFBRyxNQUFNO0FBQ1QsZUFBSyxLQUFLLGlCQUFpQixPQUFPLE1BQU0sT0FBTyxPQUFPLEVBQ25ELEtBQUssQ0FBQyxhQUFhLEtBQUssTUFBTUEsU0FBUSxRQUFRLENBQUMsQ0FBQyxFQUNoRCxNQUFNLENBQUMsUUFBaUIsS0FBSyxNQUFNLE9BQU8sR0FBRyxDQUFDLENBQUM7QUFBQSxRQUNwRDtBQUFBLE1BQ0Y7QUFDQSxTQUFHLEdBQUcsUUFBUSxNQUFNO0FBRXBCLFlBQU0sS0FBSyxRQUFRLENBQUMsU0FBUztBQUMzQixhQUFLLE1BQU0sT0FBTyxhQUFhLG1CQUFtQixvQ0FBb0MsUUFBUSxNQUFNLEtBQUssRUFBRSxXQUFXLE9BQU8sZ0JBQWdCLFlBQVksQ0FBQyxDQUFDLENBQUM7QUFBQSxNQUM5SixDQUFDO0FBQUEsSUFDSCxDQUFDO0FBQUEsRUFDSDtBQUFBO0FBQUEsRUFHQSxNQUFjLE1BQU0sTUFBYyxTQUF3QztBQUN4RSxRQUFJO0FBQ0osUUFBSTtBQUNGLFlBQU0sTUFBTSxNQUFNLG9CQUFvQixJQUFJLGNBQWM7QUFBQSxRQUN0RCxTQUFTLEVBQUUsYUFBYSxLQUFLLE1BQU07QUFBQSxRQUNuQyxRQUFRLFlBQVksUUFBUSxHQUFLO0FBQUEsTUFDbkMsQ0FBQztBQUFBLElBQ0gsU0FBUyxLQUFLO0FBQ1osWUFBTSxhQUFhLGtCQUFrQix3QkFBd0IsT0FBTyxHQUFHLEVBQUUsTUFBTSxHQUFHLEdBQUcsQ0FBQyxJQUFJLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFBQSxJQUMvRztBQUNBLFFBQUksSUFBSSxXQUFXLE9BQU8sSUFBSSxXQUFXLEtBQUs7QUFDNUMsWUFBTSxhQUFhLGVBQWUseUNBQXlDLElBQUksTUFBTSxLQUFLLEVBQUUsV0FBVyxPQUFPLGdCQUFnQixZQUFZLENBQUM7QUFBQSxJQUM3STtBQUNBLFFBQUksQ0FBQyxJQUFJLElBQUk7QUFDWCxZQUFNLGFBQWEsa0JBQWtCLHFCQUFxQixJQUFJLE1BQU0sSUFBSSxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQUEsSUFDN0Y7QUFDQSxXQUFPLEVBQUUsTUFBTSxTQUFTLE9BQU8sS0FBSyxNQUFNO0FBQUEsRUFDNUM7QUFBQSxFQUVRLG1CQUF5QjtBQUMvQixRQUFJLEtBQUssWUFBWSxLQUFLLFdBQVcsYUFBYSxLQUFLLFdBQVcsV0FBWTtBQUM5RSxTQUFLLFFBQVE7QUFDYixRQUFJLEtBQUssZUFBZSxLQUFLLEtBQUssYUFBYTtBQUM3QyxXQUFLLGdCQUFnQjtBQUNyQixXQUFLLFNBQVMsWUFBWTtBQUMxQixXQUFLLEtBQUssT0FBTyxFQUFFLE1BQU0sTUFBTTtBQUU3QixhQUFLLFlBQVk7QUFBQSxNQUNuQixDQUFDO0FBQUEsSUFDSCxPQUFPO0FBQ0wsV0FBSyxTQUFTLFVBQVUsNEJBQTRCLEtBQUssZUFBZSxDQUFDLG1CQUFtQjtBQUFBLElBQzlGO0FBQUEsRUFDRjtBQUFBLEVBRVEsY0FBb0I7QUFDMUIsUUFBSSxLQUFLLFlBQVksS0FBSyxXQUFXLGFBQWEsS0FBSyxXQUFXLFdBQVk7QUFDOUUsUUFBSSxLQUFLLGVBQWUsS0FBSyxLQUFLLGFBQWE7QUFDN0MsV0FBSyxnQkFBZ0I7QUFDckIsV0FBSyxTQUFTLFlBQVk7QUFDMUIsV0FBSyxLQUFLLE9BQU8sRUFBRSxNQUFNLE1BQU0sS0FBSyxZQUFZLENBQUM7QUFBQSxJQUNuRCxPQUFPO0FBQ0wsV0FBSyxTQUFTLFVBQVUsZ0NBQWdDLEtBQUssWUFBWSxtQkFBbUI7QUFBQSxJQUM5RjtBQUFBLEVBQ0Y7QUFBQTtBQUFBLEVBR0EsTUFBTSxPQUFzQjtBQUMxQixTQUFLLFdBQVc7QUFDaEIsUUFBSSxLQUFLLFdBQVcsVUFBVztBQUMvQixTQUFLLFNBQVMsVUFBVTtBQUN4QixVQUFNLFFBQVEsS0FBSztBQUNuQixTQUFLLFFBQVE7QUFDYixTQUFLLGtCQUFrQjtBQUN2QixRQUFJLENBQUMsT0FBTztBQUNWLFdBQUssU0FBUyxTQUFTO0FBQ3ZCO0FBQUEsSUFDRjtBQUNBLFVBQU0sU0FBUyxJQUFJLFFBQWMsQ0FBQ0EsYUFBWTtBQUM1QyxVQUFJLE1BQU0sYUFBYSxRQUFRLE1BQU0sZUFBZSxLQUFNLENBQUFBLFNBQVE7QUFBQSxXQUM3RDtBQUNILGNBQU0sSUFBSSxNQUFZQSxTQUFRO0FBQzlCLGFBQUssWUFBWSxLQUFLLENBQUM7QUFDdkIsY0FBTSxLQUFLLFFBQVEsQ0FBQztBQUFBLE1BQ3RCO0FBQUEsSUFDRixDQUFDO0FBRUQsUUFBSSxLQUFLLGlCQUFpQixNQUFNO0FBQzlCLFVBQUk7QUFDRixjQUFNLE1BQU0sb0JBQW9CLEtBQUssWUFBWSx5QkFBeUI7QUFBQSxVQUN4RSxRQUFRO0FBQUEsVUFDUixTQUFTLEVBQUUsYUFBYSxLQUFLLE1BQU07QUFBQSxVQUNuQyxRQUFRLFlBQVksUUFBUSxHQUFLO0FBQUEsUUFDbkMsQ0FBQztBQUFBLE1BQ0gsUUFBUTtBQUFBLE1BRVI7QUFBQSxJQUNGO0FBQ0EsVUFBTSxXQUFXLE1BQU0sUUFBUSxLQUFLO0FBQUEsTUFDbEMsT0FBTyxLQUFLLE1BQU0sSUFBSTtBQUFBLE1BQ3RCLElBQUksUUFBaUIsQ0FBQ0EsYUFBWSxXQUFXLE1BQU1BLFNBQVEsS0FBSyxHQUFHLEtBQUssS0FBSyxrQkFBa0IsQ0FBQztBQUFBLElBQ2xHLENBQUM7QUFDRCxRQUFJLENBQUMsWUFBWSxNQUFNLGFBQWEsUUFBUSxNQUFNLGVBQWUsTUFBTTtBQUNyRSxZQUFNLEtBQUs7QUFBQSxJQUNiO0FBQ0EsVUFBTSxPQUFPLE1BQU0sTUFBTSxNQUFTO0FBQ2xDLFNBQUssU0FBUyxTQUFTO0FBQUEsRUFDekI7QUFBQSxFQUVRLGVBQThCO0FBQUEsRUFDOUIsa0JBQTREO0FBQUE7QUFBQSxFQUdwRSxJQUFJLFdBQXFEO0FBQ3ZELFdBQU8sS0FBSztBQUFBLEVBQ2Q7QUFBQTtBQUFBLEVBR0EsTUFBYyxpQkFBaUIsTUFBYyxTQUF3QztBQUNuRixVQUFNLEtBQUssTUFBTSxLQUFLLE1BQU0sTUFBTSxPQUFPO0FBQ3pDLFNBQUssZUFBZSxHQUFHO0FBQ3ZCLFdBQU87QUFBQSxFQUNUO0FBQ0Y7OztBSXJSQSxTQUFTLGtCQUFrQjtBQVNwQixTQUFTLGNBQWMsT0FBMkI7QUFDdkQsUUFBTSxTQUFxQixDQUFDO0FBQzVCLGFBQVcsU0FBUyxNQUFNLE1BQU0sTUFBTSxHQUFHO0FBQ3ZDLFFBQUksQ0FBQyxNQUFNLEtBQUssRUFBRztBQUNuQixRQUFJO0FBQ0osUUFBSSxRQUFRO0FBQ1osVUFBTSxZQUFzQixDQUFDO0FBQzdCLFFBQUksV0FBVztBQUNmLGVBQVcsUUFBUSxNQUFNLE1BQU0sSUFBSSxHQUFHO0FBQ3BDLFVBQUksS0FBSyxXQUFXLEdBQUcsRUFBRztBQUMxQixVQUFJLEtBQUssV0FBVyxLQUFLLEdBQUc7QUFBRSxhQUFLLEtBQUssTUFBTSxDQUFDLEVBQUUsS0FBSztBQUFHLG1CQUFXO0FBQUEsTUFBTSxXQUNqRSxLQUFLLFdBQVcsUUFBUSxHQUFHO0FBQUUsZ0JBQVEsS0FBSyxNQUFNLENBQUMsRUFBRSxLQUFLO0FBQUcsbUJBQVc7QUFBQSxNQUFNLFdBQzVFLEtBQUssV0FBVyxPQUFPLEdBQUc7QUFBRSxrQkFBVSxLQUFLLEtBQUssTUFBTSxDQUFDLEVBQUUsUUFBUSxNQUFNLEVBQUUsQ0FBQztBQUFHLG1CQUFXO0FBQUEsTUFBTTtBQUFBLElBQ3pHO0FBQ0EsUUFBSSxDQUFDLFNBQVU7QUFDZixXQUFPLEtBQUssRUFBRSxHQUFJLE9BQU8sU0FBWSxFQUFFLEdBQUcsSUFBSSxDQUFDLEdBQUksT0FBTyxNQUFNLFVBQVUsS0FBSyxJQUFJLEVBQUUsQ0FBQztBQUFBLEVBQ3hGO0FBQ0EsU0FBTztBQUNUO0FBR08sU0FBUyxrQkFBa0IsT0FBdUM7QUFDdkUsTUFBSSxNQUFNLFVBQVUsTUFBTyxRQUFPO0FBQ2xDLE1BQUk7QUFDRixVQUFNLFNBQWtCLEtBQUssTUFBTSxNQUFNLElBQUk7QUFDN0MsV0FBTyxnQkFBZ0IsTUFBTSxJQUFJLFNBQVM7QUFBQSxFQUM1QyxRQUFRO0FBQ04sV0FBTztBQUFBLEVBQ1Q7QUFDRjtBQUVPLElBQU0sbUJBQU4sY0FBK0IsTUFBTTtBQUFBLEVBQzFDLFlBQTRCLFFBQXNCO0FBQ2hELFVBQU0sT0FBTyxPQUFPO0FBRE07QUFBQSxFQUU1QjtBQUFBLEVBRjRCO0FBRzlCO0FBRU8sSUFBTSxvQkFBTixNQUF3QjtBQUFBLEVBQzdCLFlBQ21CLFNBQ0EsT0FDakI7QUFGaUI7QUFDQTtBQUFBLEVBQ2hCO0FBQUEsRUFGZ0I7QUFBQSxFQUNBO0FBQUEsRUFHWCxRQUFRLFFBQWdDLENBQUMsR0FBMkI7QUFDMUUsV0FBTyxFQUFFLGFBQWEsS0FBSyxPQUFPLEdBQUcsTUFBTTtBQUFBLEVBQzdDO0FBQUEsRUFFQSxNQUFNLFFBQVcsTUFBYyxZQUFZLEtBQW1CO0FBQzVELFFBQUk7QUFDSixRQUFJO0FBQ0YsWUFBTSxNQUFNLE1BQU0sR0FBRyxLQUFLLE9BQU8sR0FBRyxJQUFJLElBQUksRUFBRSxTQUFTLEtBQUssUUFBUSxHQUFHLFFBQVEsWUFBWSxRQUFRLFNBQVMsRUFBRSxDQUFDO0FBQUEsSUFDakgsU0FBUyxLQUFLO0FBQ1osWUFBTSxJQUFJLGlCQUFpQixhQUFhLGtCQUFrQixtQkFBbUIsT0FBTyxHQUFHLEVBQUUsTUFBTSxHQUFHLEdBQUcsQ0FBQyxJQUFJLEVBQUUsV0FBVyxNQUFNLGdCQUFnQixZQUFZLENBQUMsQ0FBQztBQUFBLElBQzdKO0FBQ0EsV0FBTyxLQUFLLGNBQWlCLEdBQUc7QUFBQSxFQUNsQztBQUFBO0FBQUEsRUFHQSxNQUFNLFFBQVEsTUFBYyxZQUFZLEtBQXlCO0FBQy9ELFFBQUk7QUFDSixRQUFJO0FBQ0YsWUFBTSxNQUFNLE1BQU0sR0FBRyxLQUFLLE9BQU8sR0FBRyxJQUFJLElBQUksRUFBRSxTQUFTLEtBQUssUUFBUSxHQUFHLFFBQVEsWUFBWSxRQUFRLFNBQVMsRUFBRSxDQUFDO0FBQUEsSUFDakgsU0FBUyxLQUFLO0FBQ1osWUFBTSxJQUFJLGlCQUFpQixhQUFhLGtCQUFrQixtQkFBbUIsT0FBTyxHQUFHLEVBQUUsTUFBTSxHQUFHLEdBQUcsQ0FBQyxJQUFJLEVBQUUsV0FBVyxNQUFNLGdCQUFnQixZQUFZLENBQUMsQ0FBQztBQUFBLElBQzdKO0FBQ0EsUUFBSSxJQUFJLFdBQVcsT0FBTyxJQUFJLFdBQVcsS0FBSztBQUM1QyxZQUFNLElBQUksaUJBQWlCLGFBQWEsZUFBZSx5Q0FBeUMsSUFBSSxNQUFNLEtBQUssRUFBRSxXQUFXLE9BQU8sZ0JBQWdCLFlBQVksQ0FBQyxDQUFDO0FBQUEsSUFDbks7QUFDQSxRQUFJLENBQUMsSUFBSSxJQUFJO0FBQ1gsWUFBTSxJQUFJLGlCQUFpQixhQUFhLGtCQUFrQixRQUFRLElBQUksTUFBTSxJQUFJLEVBQUUsV0FBVyxJQUFJLFVBQVUsSUFBSSxDQUFDLENBQUM7QUFBQSxJQUNuSDtBQUNBLFdBQU8sSUFBSSxLQUFLO0FBQUEsRUFDbEI7QUFBQTtBQUFBO0FBQUEsRUFJQSxNQUFNLFNBQVksTUFBYyxNQUFlLFlBQVksS0FBb0I7QUFDN0UsUUFBSTtBQUNKLFFBQUk7QUFDRixZQUFNLE1BQU0sTUFBTSxHQUFHLEtBQUssT0FBTyxHQUFHLElBQUksSUFBSTtBQUFBLFFBQzFDLFFBQVE7QUFBQSxRQUNSLFNBQVMsS0FBSyxRQUFRO0FBQUEsVUFDcEIsZ0JBQWdCO0FBQUEsVUFDaEIscUJBQXFCLFdBQVc7QUFBQSxRQUNsQyxDQUFDO0FBQUEsUUFDRCxNQUFNLEtBQUssVUFBVSxJQUFJO0FBQUEsUUFDekIsUUFBUSxZQUFZLFFBQVEsU0FBUztBQUFBLE1BQ3ZDLENBQUM7QUFBQSxJQUNILFNBQVMsS0FBSztBQUNaLFlBQU0sSUFBSSxpQkFBaUIsYUFBYSxrQkFBa0IsbUJBQW1CLE9BQU8sR0FBRyxFQUFFLE1BQU0sR0FBRyxHQUFHLENBQUMsSUFBSSxFQUFFLFdBQVcsTUFBTSxnQkFBZ0IsWUFBWSxDQUFDLENBQUM7QUFBQSxJQUM3SjtBQUNBLFdBQU8sS0FBSyxjQUFpQixHQUFHO0FBQUEsRUFDbEM7QUFBQSxFQUVBLE1BQWMsY0FBaUIsS0FBMkI7QUFDeEQsUUFBSSxJQUFJLFdBQVcsT0FBTyxJQUFJLFdBQVcsS0FBSztBQUM1QyxZQUFNLElBQUksaUJBQWlCLGFBQWEsZUFBZSx5Q0FBeUMsSUFBSSxNQUFNLEtBQUssRUFBRSxXQUFXLE9BQU8sZ0JBQWdCLFlBQVksQ0FBQyxDQUFDO0FBQUEsSUFDbks7QUFDQSxVQUFNLE9BQU8sTUFBTSxJQUFJLEtBQUs7QUFDNUIsUUFBSSxTQUFrQjtBQUN0QixRQUFJO0FBQ0YsZUFBUyxPQUFPLEtBQUssTUFBTSxJQUFJLElBQUk7QUFBQSxJQUNyQyxRQUFRO0FBQ04sZUFBUztBQUFBLElBQ1g7QUFDQSxRQUFJLENBQUMsSUFBSSxJQUFJO0FBQ1gsVUFBSSxlQUFlLE1BQU0sRUFBRyxPQUFNLElBQUksaUJBQWlCLE1BQU07QUFDN0QsWUFBTSxJQUFJLGlCQUFpQixhQUFhLGtCQUFrQixRQUFRLElBQUksTUFBTSxLQUFLLEtBQUssTUFBTSxHQUFHLEdBQUcsQ0FBQyxJQUFJLEVBQUUsV0FBVyxJQUFJLFVBQVUsSUFBSSxDQUFDLENBQUM7QUFBQSxJQUMxSTtBQUNBLFdBQU87QUFBQSxFQUNUO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxFQU1BLE9BQU8sVUFBVSxhQUFzQixRQUFnRDtBQUNyRixVQUFNLE1BQU0sTUFBTSxNQUFNLEdBQUcsS0FBSyxPQUFPLGVBQWU7QUFBQSxNQUNwRCxTQUFTLEtBQUssUUFBUTtBQUFBLFFBQ3BCLFFBQVE7QUFBQSxRQUNSLEdBQUksZ0JBQWdCLFNBQVksRUFBRSxpQkFBaUIsWUFBWSxJQUFJLENBQUM7QUFBQSxNQUN0RSxDQUFDO0FBQUEsTUFDRCxHQUFJLFdBQVcsU0FBWSxFQUFFLE9BQU8sSUFBSSxDQUFDO0FBQUEsSUFDM0MsQ0FBQztBQUNELFFBQUksSUFBSSxXQUFXLE9BQU8sSUFBSSxXQUFXLEtBQUs7QUFDNUMsWUFBTSxJQUFJLGlCQUFpQixhQUFhLGVBQWUseUNBQXlDLElBQUksTUFBTSxLQUFLLEVBQUUsV0FBVyxPQUFPLGdCQUFnQixZQUFZLENBQUMsQ0FBQztBQUFBLElBQ25LO0FBQ0EsUUFBSSxDQUFDLElBQUksTUFBTSxJQUFJLFNBQVMsTUFBTTtBQUNoQyxZQUFNLElBQUksaUJBQWlCLGFBQWEsa0JBQWtCLFlBQVksSUFBSSxNQUFNLElBQUksRUFBRSxXQUFXLE1BQU0sZ0JBQWdCLFlBQVksQ0FBQyxDQUFDO0FBQUEsSUFDdkk7QUFDQSxVQUFNLFNBQVMsSUFBSSxLQUFLLFVBQVU7QUFDbEMsVUFBTSxVQUFVLElBQUksWUFBWTtBQUNoQyxRQUFJLFNBQVM7QUFDYixlQUFTO0FBQ1AsWUFBTSxFQUFFLE1BQU0sTUFBTSxJQUFJLE1BQU0sT0FBTyxLQUFLO0FBQzFDLFVBQUksS0FBTTtBQUNWLGdCQUFVLFFBQVEsT0FBTyxPQUFPLEVBQUUsUUFBUSxLQUFLLENBQUM7QUFDaEQsVUFBSTtBQUNKLGNBQVEsTUFBTSxPQUFPLFFBQVEsTUFBTSxPQUFPLElBQUk7QUFDNUMsY0FBTSxRQUFRLE9BQU8sTUFBTSxHQUFHLEdBQUc7QUFDakMsaUJBQVMsT0FBTyxNQUFNLE1BQU0sQ0FBQztBQUM3QixtQkFBVyxTQUFTLGNBQWMsS0FBSyxFQUFHLE9BQU07QUFBQSxNQUNsRDtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxFQU1BLE9BQU8sT0FBTyxhQUFzQixRQUFxRDtBQUN2RixVQUFNLE1BQU0sTUFBTSxNQUFNLEdBQUcsS0FBSyxPQUFPLGVBQWU7QUFBQSxNQUNwRCxTQUFTLEtBQUssUUFBUTtBQUFBLFFBQ3BCLFFBQVE7QUFBQSxRQUNSLEdBQUksZ0JBQWdCLFNBQVksRUFBRSxpQkFBaUIsWUFBWSxJQUFJLENBQUM7QUFBQSxNQUN0RSxDQUFDO0FBQUEsTUFDRCxHQUFJLFdBQVcsU0FBWSxFQUFFLE9BQU8sSUFBSSxDQUFDO0FBQUEsSUFDM0MsQ0FBQztBQUNELFFBQUksSUFBSSxXQUFXLE9BQU8sSUFBSSxXQUFXLEtBQUs7QUFDNUMsWUFBTSxJQUFJLGlCQUFpQixhQUFhLGVBQWUseUNBQXlDLElBQUksTUFBTSxLQUFLLEVBQUUsV0FBVyxPQUFPLGdCQUFnQixZQUFZLENBQUMsQ0FBQztBQUFBLElBQ25LO0FBQ0EsUUFBSSxDQUFDLElBQUksTUFBTSxDQUFDLElBQUksTUFBTTtBQUN4QixZQUFNLElBQUksaUJBQWlCLGFBQWEsa0JBQWtCLFlBQVksSUFBSSxNQUFNLElBQUksRUFBRSxXQUFXLE1BQU0sZ0JBQWdCLFlBQVksQ0FBQyxDQUFDO0FBQUEsSUFDdkk7QUFDQSxVQUFNLFNBQVMsSUFBSSxLQUFLLFVBQVU7QUFDbEMsVUFBTSxVQUFVLElBQUksWUFBWTtBQUNoQyxRQUFJLFNBQVM7QUFDYixlQUFTO0FBQ1AsWUFBTSxFQUFFLE1BQU0sTUFBTSxJQUFJLE1BQU0sT0FBTyxLQUFLO0FBQzFDLFVBQUksS0FBTTtBQUNWLGdCQUFVLFFBQVEsT0FBTyxPQUFPLEVBQUUsUUFBUSxLQUFLLENBQUM7QUFFaEQsVUFBSTtBQUNKLGNBQVEsTUFBTSxPQUFPLFFBQVEsTUFBTSxPQUFPLElBQUk7QUFDNUMsY0FBTSxRQUFRLE9BQU8sTUFBTSxHQUFHLEdBQUc7QUFDakMsaUJBQVMsT0FBTyxNQUFNLE1BQU0sQ0FBQztBQUM3QixtQkFBVyxTQUFTLGNBQWMsS0FBSyxHQUFHO0FBQ3hDLGdCQUFNLE1BQU0sa0JBQWtCLEtBQUs7QUFDbkMsY0FBSSxRQUFRLEtBQU0sT0FBTTtBQUFBLFFBQzFCO0FBQUEsTUFDRjtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQ0Y7OztBQ2pMQSxTQUFTLG9CQUF5QztBQUNsRCxTQUFTLGNBQUFDLG1CQUFrQjtBQUMzQixTQUFTLHFCQUFxQjtBQUM5QixTQUFTLG9CQUFvQjtBQXFCN0IsZUFBc0IsY0FBYyxNQUFtRTtBQUNyRyxRQUFNLFFBQVEsS0FBSztBQUduQixRQUFNLFdBQVcsUUFBUSxJQUFJLDBCQUEwQjtBQUN2RCxRQUFNLFlBQVksT0FBTyxRQUFRLElBQUksMkJBQTJCLEVBQUU7QUFDbEUsUUFBTSxZQUFZLFFBQVEsSUFBSSx3QkFBd0I7QUFFdEQsUUFBTSxhQUFhLG9CQUFJLElBQW9CO0FBQzNDLFFBQU0sV0FBVyxvQkFBSSxJQUFvQjtBQUV6QyxRQUFNLE9BQTRELENBQUM7QUFDbkUsTUFBSSxVQUFVO0FBQ2QsUUFBTSxXQUFXLG9CQUFJLElBQXlCO0FBQzlDLE1BQUksVUFBa0M7QUFDdEMsUUFBTSxZQUFZLG9CQUFJLElBQTRCO0FBRWxELFFBQU0saUJBQWlCO0FBQUEsSUFDckIsU0FBUztBQUFBLElBQ1QsT0FBTztBQUFBLE1BQ0wsRUFBRSxJQUFJLFdBQVcsTUFBTSxrQkFBa0IsTUFBTSxXQUFXO0FBQUEsSUFDNUQ7QUFBQSxFQUNGO0FBQ0EsUUFBTSxnQkFBZ0Isb0JBQUksSUFBZ0U7QUFBQSxJQUN4RixDQUFDLFFBQVEsRUFBRSxTQUFTLHlCQUF5QixPQUFPLFVBQVUsUUFBUSxlQUFlLENBQUM7QUFBQSxJQUN0RixDQUFDLGVBQWUsRUFBRSxTQUFTLHlCQUF5QixPQUFPLGlCQUFpQixRQUFRLGVBQWUsQ0FBQztBQUFBLEVBQ3RHLENBQUM7QUFDRCxNQUFJLG1CQUFtQjtBQUV2QixRQUFNLE9BQU8sQ0FBQyxXQUFtQixPQUFlLE1BQWlCLFlBQTZDO0FBQzVHLFVBQU0sTUFBTSxHQUFHLFNBQVMsS0FBSyxLQUFLO0FBQ2xDLFVBQU0sT0FBTyxTQUFTLElBQUksR0FBRyxLQUFLLEtBQUs7QUFDdkMsYUFBUyxJQUFJLEtBQUssR0FBRztBQUNyQixVQUFNLE1BQXFCO0FBQUEsTUFDekIsZUFBZTtBQUFBLE1BQ2YsU0FBU0MsWUFBVztBQUFBLE1BQ3BCO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBLGFBQVksb0JBQUksS0FBSyxHQUFFLFlBQVk7QUFBQSxNQUNuQztBQUFBLE1BQ0E7QUFBQSxJQUNGO0FBQ0EsVUFBTSxLQUFLLEVBQUU7QUFDYixTQUFLLEtBQUssRUFBRSxJQUFJLE9BQU8sT0FBTyxNQUFNLElBQUksQ0FBQztBQUN6QyxRQUFJLEtBQUssU0FBUyxJQUFLLE1BQUssT0FBTyxHQUFHLEtBQUssU0FBUyxHQUFHO0FBQ3ZELGVBQVcsS0FBSyxZQUFZO0FBQzFCLFFBQUUsTUFBTSxPQUFPLEVBQUU7QUFBQTtBQUFBLFFBQXVCLEtBQUssVUFBVSxHQUFHLENBQUM7QUFBQTtBQUFBLENBQU07QUFBQSxJQUNuRTtBQUNBLFdBQU87QUFBQSxFQUNUO0FBRUEsUUFBTSxRQUFRLENBQUMsY0FBbUM7QUFDaEQsUUFBSSxJQUFJLFNBQVMsSUFBSSxTQUFTO0FBQzlCLFFBQUksTUFBTSxRQUFXO0FBQ25CLFVBQUksRUFBRSxJQUFJLFdBQVcsWUFBVyxvQkFBSSxLQUFLLEdBQUUsWUFBWSxHQUFHLFlBQVcsb0JBQUksS0FBSyxHQUFFLFlBQVksRUFBRTtBQUM5RixlQUFTLElBQUksV0FBVyxDQUFDO0FBQUEsSUFDM0I7QUFDQSxNQUFFLGFBQVksb0JBQUksS0FBSyxHQUFFLFlBQVk7QUFDckMsV0FBTztBQUFBLEVBQ1Q7QUFHQSxRQUFNLFVBQVUsQ0FBQyxXQUFtQixNQUFjLFNBQXlCO0FBQ3pFLFVBQU0sUUFBUSxPQUFPLEtBQUssSUFBSSxFQUFFLFNBQVMsRUFBRSxDQUFDLElBQUksS0FBSyxPQUFPLEVBQUUsU0FBUyxFQUFFLEVBQUUsTUFBTSxHQUFHLENBQUMsQ0FBQztBQUN0RixVQUFNLFNBQVM7QUFDZixVQUFNLFFBQTJCLENBQUM7QUFDbEMsVUFBTSxPQUFPLENBQUMsSUFBZ0IsS0FBSyxjQUFvQjtBQUNyRCxZQUFNLElBQUksV0FBVyxJQUFJLEVBQUU7QUFDM0IsZ0JBQVUsSUFBSSxHQUFHLFNBQVMsS0FBSyxLQUFLLElBQUksQ0FBQztBQUFBLElBQzNDO0FBQ0EsVUFBTSxRQUFRLENBQUMsUUFBaUM7QUFDOUMsWUFBTSxDQUFDLE9BQU8sR0FBRyxJQUFJLElBQUk7QUFDekIsVUFBSSxVQUFVLE9BQVc7QUFDekIsV0FBSyxNQUFNO0FBQ1QsY0FBTTtBQUNOLGNBQU0sSUFBSTtBQUFBLE1BQ1osQ0FBQztBQUFBLElBQ0g7QUFFQSxTQUFLLFdBQVcsT0FBTyxlQUFlLEVBQUUsTUFBTSxNQUFNLEtBQUssQ0FBQztBQUMxRCxRQUFJLFdBQVc7QUFDYixXQUFLLE1BQU0sS0FBSyxXQUFXLE9BQU8sY0FBYztBQUFBLFFBQzlDLE9BQU8sRUFBRSxNQUFNLGVBQWUsU0FBUyxtQ0FBbUMsV0FBVyxNQUFNO0FBQUEsTUFDN0YsQ0FBQyxDQUFDO0FBQ0YsYUFBTztBQUFBLElBQ1Q7QUFFQSxVQUFNLFlBQVksQ0FBQyxRQUFnQixhQUEyQjtBQUM1RCxnQkFBVSxPQUFPLEdBQUcsU0FBUyxLQUFLLEtBQUssRUFBRTtBQUV6QyxXQUFLLFdBQVcsT0FBTyxvQkFBb0I7QUFBQSxRQUN6QyxVQUFVLEVBQUUsU0FBUyxXQUFXLE1BQU0sUUFBUSxPQUFPLFVBQVU7QUFBQSxNQUNqRSxDQUFDO0FBQ0QsV0FBSyxXQUFXLE9BQU8saUJBQWlCLEVBQUUsTUFBTSxRQUFRLE9BQU8sR0FBRyxTQUFTLENBQUM7QUFBQSxJQUM5RTtBQUVBLFVBQU0sV0FBOEI7QUFBQSxNQUNsQyxNQUFNLEtBQUssV0FBVyxPQUFPLGdCQUFnQixFQUFFLE1BQU0sYUFBYSxhQUFhLHVCQUF1QixDQUFDO0FBQUEsTUFDdkcsTUFBTSxLQUFLLFdBQVcsT0FBTyxrQkFBa0IsRUFBRSxNQUFNLGFBQWEsU0FBUyxPQUFPLGVBQWUsU0FBUyxDQUFDO0FBQUEsSUFDL0c7QUFFQSxRQUFJLFNBQVMsT0FBTztBQUNsQixlQUFTLEtBQUssTUFBTTtBQUNsQixjQUFNLGFBQWEsTUFBTSxLQUFLLE9BQU8sRUFBRSxTQUFTLEVBQUUsRUFBRSxNQUFNLEdBQUcsQ0FBQyxDQUFDO0FBQy9ELGFBQUssV0FBVyxPQUFPLHFCQUFxQjtBQUFBLFVBQzFDO0FBQUEsVUFDQSxNQUFNO0FBQUEsVUFDTixhQUFhO0FBQUEsVUFDYixNQUFNO0FBQUEsUUFDUixDQUFDO0FBQ0Qsa0JBQVU7QUFBQSxVQUNSO0FBQUEsVUFDQTtBQUFBLFVBQ0EsU0FBUyxDQUFDLFlBQVk7QUFDcEIsc0JBQVU7QUFDVixnQkFBSSxTQUFTO0FBQ1gsbUJBQUssV0FBVyxPQUFPLGdCQUFnQixFQUFFLE1BQU0sY0FBYyxhQUFhLHFCQUFxQixDQUFDO0FBQ2hHLG1CQUFLLE1BQU0sS0FBSyxXQUFXLE9BQU8sa0JBQWtCLEVBQUUsTUFBTSxjQUFjLFNBQVMsT0FBTyxlQUFlLGdCQUFnQixDQUFDLENBQUM7QUFDM0gsbUJBQUssTUFBTSxVQUFVLFNBQVMsSUFBSSxvQ0FBVyxDQUFDLEdBQUcsWUFBWSxDQUFDO0FBQUEsWUFDaEUsT0FBTztBQUNMLHdCQUFVLFNBQVMsSUFBSSxtRUFBaUIsQ0FBQztBQUFBLFlBQzNDO0FBQUEsVUFDRjtBQUFBLFFBQ0Y7QUFBQSxNQUNGLENBQUM7QUFBQSxJQUNILE9BQU87QUFDTCxlQUFTLEtBQUssTUFBTSxVQUFVLFNBQVMsSUFBSSxJQUFJLENBQUMsQ0FBQztBQUFBLElBQ25EO0FBQ0EsVUFBTSxRQUFRO0FBQ2QsV0FBTztBQUFBLEVBQ1Q7QUFFQSxRQUFNLFNBQVMsYUFBYSxDQUFDLEtBQUssUUFBUTtBQUN4QyxVQUFNLE1BQU0sSUFBSSxJQUFJLElBQUksT0FBTyxLQUFLLGtCQUFrQjtBQUN0RCxVQUFNLGFBQWEsSUFBSSxRQUFRLFdBQVcsTUFBTTtBQUNoRCxVQUFNLE9BQU8sTUFBWTtBQUN2QixVQUFJLFVBQVUsS0FBSyxFQUFFLGdCQUFnQixrQ0FBa0MsQ0FBQztBQUN4RSxVQUFJLElBQUksS0FBSyxVQUFVLGFBQWEsZUFBZSxnQ0FBZ0MsRUFBRSxXQUFXLE1BQU0sQ0FBQyxDQUFDLENBQUM7QUFBQSxJQUMzRztBQUVBLFVBQU0sV0FBVyxNQUNmLElBQUksUUFBUSxDQUFDQyxhQUFZO0FBQ3ZCLFVBQUksSUFBSTtBQUNSLFVBQUksR0FBRyxRQUFRLENBQUMsTUFBYztBQUFFLGFBQUssRUFBRSxTQUFTO0FBQUEsTUFBRyxDQUFDO0FBQ3BELFVBQUksR0FBRyxPQUFPLE1BQU1BLFNBQVEsQ0FBQyxDQUFDO0FBQUEsSUFDaEMsQ0FBQztBQUVILFFBQUksSUFBSSxhQUFhLGVBQWU7QUFDbEMsVUFBSSxDQUFDLFlBQVk7QUFBRSxhQUFLO0FBQUc7QUFBQSxNQUFRO0FBQ25DLFVBQUksVUFBVSxLQUFLLEVBQUUsZ0JBQWdCLHFCQUFxQixpQkFBaUIsWUFBWSxZQUFZLGFBQWEsQ0FBQztBQUNqSCxVQUFJLGVBQWU7QUFDbkIsaUJBQVcsSUFBSSxHQUFHO0FBRWxCLFlBQU0sU0FBUyxPQUFPLElBQUksUUFBUSxlQUFlLEtBQUssQ0FBQztBQUN2RCxVQUFJLE9BQU8sU0FBUyxNQUFNLEtBQUssU0FBUyxHQUFHO0FBQ3pDLG1CQUFXLEtBQUssTUFBTTtBQUNwQixjQUFJLEVBQUUsS0FBSyxPQUFRLEtBQUksTUFBTSxPQUFPLEVBQUUsRUFBRTtBQUFBLFNBQVksRUFBRSxLQUFLO0FBQUEsUUFBVyxLQUFLLFVBQVUsRUFBRSxJQUFJLENBQUM7QUFBQTtBQUFBLENBQU07QUFBQSxRQUNwRztBQUFBLE1BQ0Y7QUFDQSxVQUFJLEdBQUcsU0FBUyxNQUFNLFdBQVcsT0FBTyxHQUFHLENBQUM7QUFDNUM7QUFBQSxJQUNGO0FBQ0EsUUFBSSxDQUFDLFlBQVk7QUFBRSxXQUFLO0FBQUc7QUFBQSxJQUFRO0FBRW5DLFFBQUksSUFBSSxXQUFXLFNBQVMsSUFBSSxhQUFhLGNBQWM7QUFFekQsVUFBSSxVQUFVLEtBQUssRUFBRSxnQkFBZ0Isa0NBQWtDLENBQUM7QUFDeEUsVUFBSSxJQUFJLEtBQUssVUFBVTtBQUFBLFFBQ3JCLGVBQWU7QUFBQSxRQUFjLFNBQVM7QUFBQSxRQUFNLE9BQU8sY0FBYyxJQUFJLGdCQUFnQixHQUFHLFNBQVM7QUFBQSxRQUNqRyxjQUFjO0FBQUEsUUFBa0IsUUFBUTtBQUFBLFFBQ3hDLGNBQWMsQ0FBQyxHQUFHLFNBQVMsS0FBSyxDQUFDLEVBQUUsTUFBTSxHQUFHLENBQUM7QUFBQSxRQUM3QyxpQkFBaUIsWUFBWTtBQUFBLFFBQzdCLFVBQVUsRUFBRSxVQUFVLE1BQU07QUFBQSxRQUM1QixXQUFXLGVBQWUsTUFBTSxLQUFLLENBQUMsTUFBTSxFQUFFLE9BQU8sZUFBZSxPQUFPLEtBQUs7QUFBQSxRQUNoRixpQkFBaUIsQ0FBQyxHQUFHLGNBQWMsUUFBUSxDQUFDLEVBQUUsSUFBSSxDQUFDLENBQUMsTUFBTSxDQUFDLE9BQU87QUFBQSxVQUNoRTtBQUFBLFVBQU0sT0FBTyxFQUFFO0FBQUEsVUFBTyxTQUFTLEVBQUU7QUFBQSxVQUNqQyxRQUFRLEVBQUUsV0FBVztBQUFBLFVBQ3JCLFNBQVMsRUFBRSxPQUFPLFVBQVUsSUFBSSxFQUFFLE9BQU8sTUFBTSxFQUFFLElBQUk7QUFBQSxVQUNyRCxVQUFVLENBQUMsTUFBTTtBQUFBLFFBQ25CLEVBQUU7QUFBQSxNQUNKLENBQUMsQ0FBQztBQUNGO0FBQUEsSUFDRjtBQUNBLFFBQUksSUFBSSxXQUFXLFVBQVUsSUFBSSxhQUFhLHlCQUF5QjtBQUNyRSxVQUFJLFVBQVUsS0FBSyxFQUFFLGdCQUFnQixrQ0FBa0MsQ0FBQztBQUN4RSxVQUFJLElBQUksS0FBSyxVQUFVLEVBQUUsSUFBSSxLQUFLLENBQUMsQ0FBQztBQUNwQyxhQUFPLE1BQU0sTUFBTSxRQUFRLEtBQUssQ0FBQyxDQUFDO0FBQ2xDLGlCQUFXLE1BQU0sUUFBUSxLQUFLLENBQUMsR0FBRyxHQUFLLEVBQUUsTUFBTTtBQUMvQztBQUFBLElBQ0Y7QUFDQSxRQUFJLElBQUksV0FBVyxVQUFVLElBQUksYUFBYSxpQkFBaUI7QUFFN0QsVUFBSSxVQUFVLEtBQUssRUFBRSxnQkFBZ0Isa0NBQWtDLENBQUM7QUFDeEUsVUFBSSxJQUFJLEtBQUssVUFBVSxFQUFFLElBQUksS0FBSyxDQUFDLENBQUM7QUFDcEMsaUJBQVcsTUFBTSxRQUFRLEtBQUssQ0FBQyxHQUFHLEVBQUU7QUFDcEM7QUFBQSxJQUNGO0FBQ0EsUUFBSSxJQUFJLFdBQVcsVUFBVSxJQUFJLGFBQWEsY0FBYztBQUUxRCxZQUFNLFlBQVk7QUFDaEIsY0FBTSxPQUFPLEtBQUssTUFBTyxNQUFNLFNBQVMsS0FBTSxJQUFJO0FBQ2xELGNBQU0sT0FBTyxPQUFPLEtBQUssU0FBUyxXQUFXLEtBQUssS0FBSyxLQUFLLElBQUk7QUFDaEUsWUFBSSxDQUFDLGNBQWMsSUFBSSxJQUFJLEdBQUc7QUFDNUIsY0FBSSxVQUFVLEtBQUssRUFBRSxnQkFBZ0Isa0NBQWtDLENBQUM7QUFDeEUsY0FBSSxJQUFJLEtBQUssVUFBVSxhQUFhLG1CQUFtQixzQkFBc0IsRUFBRSxXQUFXLE1BQU0sQ0FBQyxDQUFDLENBQUM7QUFDbkc7QUFBQSxRQUNGO0FBQ0EsMkJBQW1CO0FBQ25CLFlBQUksVUFBVSxLQUFLLEVBQUUsZ0JBQWdCLGtDQUFrQyxDQUFDO0FBQ3hFLFlBQUksSUFBSSxLQUFLLFVBQVUsRUFBRSxJQUFJLE1BQU0sT0FBTyxjQUFjLElBQUksSUFBSSxHQUFHLE1BQU0sQ0FBQyxDQUFDO0FBQUEsTUFDN0UsR0FBRztBQUNIO0FBQUEsSUFDRjtBQUNBLFFBQUksSUFBSSxXQUFXLFVBQVUsSUFBSSxhQUFhLGFBQWE7QUFDekQsWUFBTSxZQUFZO0FBQ2hCLFlBQUk7QUFDRixnQkFBTSxPQUFPLEtBQUssTUFBTyxNQUFNLFNBQVMsS0FBTSxJQUFJO0FBQ2xELGdCQUFNLE9BQU8sT0FBTyxLQUFLLFNBQVMsV0FBVyxLQUFLLE9BQU87QUFDekQsZ0JBQU0sWUFBWSxPQUFPLEtBQUssY0FBYyxXQUFXLEtBQUssWUFBWSxPQUFPLEtBQUssSUFBSSxFQUFFLFNBQVMsRUFBRSxDQUFDO0FBQ3RHLGdCQUFNLE9BQU8sS0FBSyxTQUFTLFNBQVMsS0FBSyxTQUFTLFVBQVUsS0FBSyxTQUFTLFNBQVMsS0FBSyxPQUFPO0FBQy9GLGdCQUFNLGNBQWMsTUFBTSxRQUFRLEtBQUssV0FBVyxJQUFJLEtBQUssWUFBWSxPQUFPLENBQUMsTUFBbUIsT0FBTyxNQUFNLFFBQVEsSUFBSSxDQUFDO0FBRTVILGdCQUFNLFNBQVMsTUFBTSxRQUFRLEtBQUssTUFBTSxJQUNwQyxLQUFLLE9BQU8sT0FBTyxDQUFDLE9BQWdEO0FBQ2xFLGdCQUFJLE9BQU8sT0FBTyxZQUFZLE9BQU8sS0FBTSxRQUFPO0FBQ2xELGtCQUFNLElBQUk7QUFDVixtQkFBTyxPQUFPLEVBQUUsU0FBUyxZQUFZLE9BQU8sRUFBRSxZQUFZLFlBQVksRUFBRSxRQUFRLFdBQVcsYUFBYTtBQUFBLFVBQzFHLENBQUMsSUFDRCxDQUFDO0FBQ0wsY0FBSSxDQUFDLE1BQU07QUFDVCxnQkFBSSxVQUFVLEtBQUssRUFBRSxnQkFBZ0Isa0NBQWtDLENBQUM7QUFDeEUsZ0JBQUksSUFBSSxLQUFLLFVBQVUsYUFBYSxtQkFBbUIsaUJBQWlCLEVBQUUsV0FBVyxNQUFNLENBQUMsQ0FBQyxDQUFDO0FBQzlGO0FBQUEsVUFDRjtBQUdBLGdCQUFNLFdBQVcsWUFBWSxTQUFTLElBQ2xDO0FBQUEsRUFBdUIsWUFBWSxJQUFJLENBQUMsTUFBTSxLQUFLLEVBQUUsTUFBTSxPQUFPLEVBQUUsSUFBSSxDQUFDLEVBQUUsRUFBRSxLQUFLLElBQUksQ0FBQztBQUFBO0FBQUEsRUFBTyxJQUFJLEtBQ2xHO0FBQ0osZ0JBQU0sYUFBYSxPQUFPLFNBQVMsSUFBSSxZQUFZLE9BQU8sTUFBTTtBQUFBLEVBQU0sUUFBUSxLQUFLO0FBQ25GLGdCQUFNLFFBQVEsUUFBUSxXQUFXLFlBQVksSUFBSTtBQUNqRCxjQUFJLFVBQVUsS0FBSyxFQUFFLGdCQUFnQixrQ0FBa0MsQ0FBQztBQUN4RSxjQUFJLElBQUksS0FBSyxVQUFVLEVBQUUsSUFBSSxNQUFNLE9BQU8sUUFBUSxPQUFPLE9BQU8sQ0FBQyxDQUFDO0FBQUEsUUFDcEUsU0FBUyxLQUFLO0FBQ1osY0FBSSxVQUFVLEtBQUssRUFBRSxnQkFBZ0Isa0NBQWtDLENBQUM7QUFDeEUsY0FBSSxJQUFJLEtBQUssVUFBVSxhQUFhLG1CQUFtQixPQUFPLEdBQUcsRUFBRSxNQUFNLEdBQUcsR0FBRyxHQUFHLEVBQUUsV0FBVyxNQUFNLENBQUMsQ0FBQyxDQUFDO0FBQUEsUUFDMUc7QUFBQSxNQUNGLEdBQUc7QUFDSDtBQUFBLElBQ0Y7QUFDQSxRQUFJLElBQUksV0FBVyxVQUFVLElBQUksYUFBYSxnQkFBZ0I7QUFDNUQsWUFBTSxZQUFZO0FBQ2hCLGNBQU0sT0FBTyxLQUFLLE1BQU8sTUFBTSxTQUFTLEtBQU0sSUFBSTtBQUNsRCxjQUFNLE1BQU0sT0FBTyxLQUFLLGNBQWMsV0FBVyxLQUFLLFlBQVk7QUFDbEUsWUFBSSxZQUFZLFFBQVMsUUFBUSxNQUFNLFFBQVEsY0FBYyxLQUFNO0FBQ2pFLGNBQUksVUFBVSxLQUFLLEVBQUUsZ0JBQWdCLGtDQUFrQyxDQUFDO0FBQ3hFLGNBQUksSUFBSSxLQUFLLFVBQVUsYUFBYSxtQkFBbUIsdUJBQXVCLEVBQUUsV0FBVyxNQUFNLENBQUMsQ0FBQyxDQUFDO0FBQ3BHO0FBQUEsUUFDRjtBQUNBLGNBQU0sSUFBSTtBQUNWLGtCQUFVO0FBQ1YsVUFBRSxRQUFRLEtBQUssWUFBWSxJQUFJO0FBQy9CLFlBQUksVUFBVSxLQUFLLEVBQUUsZ0JBQWdCLGtDQUFrQyxDQUFDO0FBQ3hFLFlBQUksSUFBSSxLQUFLLFVBQVUsRUFBRSxJQUFJLE1BQU0sU0FBUyxLQUFLLFlBQVksS0FBSyxDQUFDLENBQUM7QUFBQSxNQUN0RSxHQUFHO0FBQ0g7QUFBQSxJQUNGO0FBQ0EsUUFBSSxJQUFJLFdBQVcsVUFBVSxJQUFJLFNBQVMsV0FBVyxnQkFBZ0IsTUFBTSxJQUFJLFNBQVMsU0FBUyxVQUFVLEtBQUssSUFBSSxTQUFTLFNBQVMsU0FBUyxJQUFJO0FBRWpKLFlBQU0sWUFBWTtBQUNoQixjQUFNLFFBQVEsSUFBSSxTQUFTLE1BQU0saUJBQWlCLE1BQU0sRUFBRSxNQUFNLEdBQUc7QUFDbkUsY0FBTSxLQUFLLE1BQU0sQ0FBQyxLQUFLO0FBQ3ZCLGNBQU0sTUFBTSxtQkFBbUIsTUFBTSxDQUFDLEtBQUssRUFBRSxFQUFFLFFBQVEsc0JBQXNCLEVBQUU7QUFDL0UsWUFBSSxRQUFRLE1BQU8sT0FBTyxhQUFhLE9BQU8sVUFBVztBQUN2RCxjQUFJLFVBQVUsS0FBSyxFQUFFLGdCQUFnQixrQ0FBa0MsQ0FBQztBQUN4RSxjQUFJLElBQUksS0FBSyxVQUFVLGFBQWEsbUJBQW1CLFVBQVUsRUFBRSxXQUFXLE1BQU0sQ0FBQyxDQUFDLENBQUM7QUFDdkY7QUFBQSxRQUNGO0FBQ0EsWUFBSSxDQUFDLFNBQVMsSUFBSSxHQUFHLEdBQUc7QUFDdEIsY0FBSSxVQUFVLEtBQUssRUFBRSxnQkFBZ0Isa0NBQWtDLENBQUM7QUFDeEUsY0FBSSxJQUFJLEtBQUssVUFBVSxhQUFhLG1CQUFtQixxQkFBcUIsRUFBRSxXQUFXLE1BQU0sQ0FBQyxDQUFDLENBQUM7QUFDbEc7QUFBQSxRQUNGO0FBQ0EsaUJBQVMsT0FBTyxHQUFHO0FBQ25CLFlBQUksVUFBVSxLQUFLLEVBQUUsZ0JBQWdCLGtDQUFrQyxDQUFDO0FBQ3hFLFlBQUksSUFBSSxLQUFLLFVBQVUsRUFBRSxJQUFJLEtBQUssQ0FBQyxDQUFDO0FBQUEsTUFDdEMsR0FBRztBQUNIO0FBQUEsSUFDRjtBQUNBLFFBQUksSUFBSSxXQUFXLFVBQVUsSUFBSSxhQUFhLGVBQWU7QUFFM0QsV0FBSyxTQUFTO0FBQ2QsVUFBSSxVQUFVLEtBQUssRUFBRSxnQkFBZ0Isa0NBQWtDLENBQUM7QUFDeEUsVUFBSSxJQUFJLEtBQUssVUFBVSxFQUFFLElBQUksS0FBSyxDQUFDLENBQUM7QUFDcEM7QUFBQSxJQUNGO0FBQ0EsUUFBSSxJQUFJLFdBQVcsVUFBVSxJQUFJLGFBQWEsa0JBQWtCO0FBQzlELFlBQU0sT0FBTyxLQUFLLE1BQU0sRUFBRTtBQUMxQixXQUFLO0FBQ0wsVUFBSSxVQUFVLEtBQUssRUFBRSxnQkFBZ0Isa0NBQWtDLENBQUM7QUFDeEUsVUFBSSxJQUFJLEtBQUssVUFBVSxFQUFFLElBQUksS0FBSyxDQUFDLENBQUM7QUFDcEM7QUFBQSxJQUNGO0FBQ0EsUUFBSSxJQUFJLFdBQVcsU0FBUyxJQUFJLGFBQWEsaUJBQWlCO0FBQzVELFlBQU0sT0FBTyxDQUFDLEdBQUcsU0FBUyxPQUFPLENBQUMsRUFBRSxJQUFJLENBQUMsT0FBTztBQUFBLFFBQzlDLElBQUksRUFBRTtBQUFBLFFBQUksT0FBTztBQUFBLFFBQUksTUFBTTtBQUFBLFFBQUksU0FBUztBQUFBLFFBQU0sT0FBTztBQUFBLFFBQUcsVUFBVTtBQUFBLFFBQ2xFLE1BQU0sRUFBRTtBQUFBLFFBQVcsS0FBSztBQUFBLFFBQVksUUFBUTtBQUFBLFFBQUksV0FBVyxFQUFFO0FBQUEsUUFBVyxXQUFXLEVBQUU7QUFBQSxNQUN2RixFQUFFO0FBQ0YsVUFBSSxVQUFVLEtBQUssRUFBRSxnQkFBZ0Isa0NBQWtDLENBQUM7QUFDeEUsVUFBSSxJQUFJLEtBQUssVUFBVSxFQUFFLFVBQVUsTUFBTSxZQUFZLEtBQUssQ0FBQyxDQUFDO0FBQzVEO0FBQUEsSUFDRjtBQUNBLFFBQUksSUFBSSxXQUFXLFNBQVMsSUFBSSxTQUFTLFdBQVcsZ0JBQWdCLEdBQUc7QUFDckUsWUFBTSxNQUFNLG1CQUFtQixJQUFJLFNBQVMsTUFBTSxpQkFBaUIsTUFBTSxDQUFDO0FBRTFFLFlBQU0sY0FBYyxxQkFBcUIsS0FBSyxHQUFHLEtBQUsscUJBQXFCLEtBQUssR0FBRztBQUNuRixVQUFJLGdCQUFnQixRQUFRLFlBQVksQ0FBQyxNQUFNLFVBQWEsWUFBWSxDQUFDLE1BQU0sSUFBSTtBQUNqRixjQUFNLE1BQU0sWUFBWSxDQUFDLEVBQUUsUUFBUSxzQkFBc0IsRUFBRTtBQUMzRCxjQUFNLEtBQUssU0FBUyxJQUFJLEdBQUc7QUFDM0IsWUFBSSxPQUFPLFFBQVc7QUFDcEIsY0FBSSxVQUFVLEtBQUssRUFBRSxnQkFBZ0Isa0NBQWtDLENBQUM7QUFDeEUsY0FBSSxJQUFJLEtBQUssVUFBVSxhQUFhLG1CQUFtQixxQkFBcUIsRUFBRSxXQUFXLE1BQU0sQ0FBQyxDQUFDLENBQUM7QUFDbEc7QUFBQSxRQUNGO0FBQ0EsWUFBSSxVQUFVLEtBQUssRUFBRSxnQkFBZ0IsK0JBQStCLENBQUM7QUFDckUsWUFBSSxJQUFJO0FBQUE7QUFBQSxpQkFBa0MsR0FBRztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxDQUE0RDtBQUN6RztBQUFBLE1BQ0Y7QUFFQSxZQUFNLEtBQUssSUFBSSxRQUFRLHNCQUFzQixFQUFFO0FBQy9DLFlBQU0sSUFBSSxTQUFTLElBQUksRUFBRTtBQUN6QixVQUFJLE1BQU0sUUFBVztBQUNuQixZQUFJLFVBQVUsS0FBSyxFQUFFLGdCQUFnQixrQ0FBa0MsQ0FBQztBQUN4RSxZQUFJLElBQUksS0FBSyxVQUFVLGFBQWEsbUJBQW1CLHFCQUFxQixFQUFFLFdBQVcsTUFBTSxDQUFDLENBQUMsQ0FBQztBQUNsRztBQUFBLE1BQ0Y7QUFDQSxVQUFJLFVBQVUsS0FBSyxFQUFFLGdCQUFnQixrQ0FBa0MsQ0FBQztBQUN4RSxVQUFJLElBQUksS0FBSyxVQUFVO0FBQUEsUUFDckI7QUFBQSxRQUFJLE9BQU87QUFBQSxRQUFjLEtBQUs7QUFBQSxRQUM5QixVQUFVO0FBQUEsVUFDUixFQUFFLE1BQU0sUUFBUSxNQUFNLHFEQUFrQixPQUFPLENBQUMsRUFBRTtBQUFBLFVBQ2xELEVBQUUsTUFBTSxhQUFhLE1BQU0sa0ZBQXNCLE9BQU8sQ0FBQyxXQUFXLEVBQUU7QUFBQSxRQUN4RTtBQUFBLE1BQ0YsQ0FBQyxDQUFDO0FBQ0Y7QUFBQSxJQUNGO0FBQ0EsUUFBSSxJQUFJLFdBQVcsU0FBUyxJQUFJLGFBQWEsV0FBVztBQUV0RCxZQUFNLElBQUksSUFBSSxhQUFhLElBQUksTUFBTSxLQUFLO0FBQzFDLFlBQU0sWUFBWSxJQUFJLGFBQWEsSUFBSSxPQUFPLE1BQU07QUFDcEQsVUFBSSxNQUFNLElBQUk7QUFDWixZQUFJLFVBQVUsS0FBSyxFQUFFLGdCQUFnQixrQ0FBa0MsQ0FBQztBQUN4RSxZQUFJLElBQUksS0FBSyxVQUFVO0FBQUEsVUFDckIsTUFBTTtBQUFBLFVBQUksVUFBVSxDQUFDO0FBQUEsVUFBRyxRQUFRO0FBQUEsVUFDaEMsTUFBTSxDQUFDLEVBQUUsTUFBTSxrQkFBa0IsTUFBTSxXQUFXLENBQUM7QUFBQSxVQUNuRCxHQUFJLFlBQVksRUFBRSxPQUFPLENBQUMsRUFBRSxJQUFJLENBQUM7QUFBQSxRQUNuQyxDQUFDLENBQUM7QUFDRjtBQUFBLE1BQ0Y7QUFDQSxVQUFJLFVBQVUsS0FBSyxFQUFFLGdCQUFnQixrQ0FBa0MsQ0FBQztBQUN4RSxVQUFJLElBQUksS0FBSyxVQUFVO0FBQUEsUUFDckIsTUFBTTtBQUFBLFFBQUcsVUFBVSxDQUFDLEVBQUUsTUFBTSxFQUFFLE1BQU0sT0FBTyxFQUFFLE9BQU8sT0FBTyxFQUFFLElBQUksS0FBSyxHQUFHLE1BQU0sRUFBRSxDQUFDO0FBQUEsUUFBRyxRQUFRO0FBQUEsUUFDN0YsTUFBTSxDQUFDLEVBQUUsTUFBTSxPQUFPLE1BQU0sR0FBRyxFQUFFLFFBQVEsVUFBVSxFQUFFLENBQUMsUUFBUSxDQUFDO0FBQUEsUUFDL0QsR0FBSSxZQUFZLEVBQUUsT0FBTztBQUFBLFVBQ3ZCLEVBQUUsTUFBTSxhQUFhLE1BQU0sR0FBRyxFQUFFLFFBQVEsVUFBVSxFQUFFLENBQUMsZUFBZSxLQUFLLFlBQVk7QUFBQSxVQUNyRixFQUFFLE1BQU0sZ0JBQWdCLE1BQU0sR0FBRyxFQUFFLFFBQVEsVUFBVSxFQUFFLENBQUMsa0JBQWtCLEtBQUssZUFBZTtBQUFBLFFBQ2hHLEVBQUUsSUFBSSxDQUFDO0FBQUEsTUFDVCxDQUFDLENBQUM7QUFDRjtBQUFBLElBQ0Y7QUFDQSxRQUFJLElBQUksV0FBVyxTQUFTLElBQUksYUFBYSxnQkFBZ0I7QUFFM0QsWUFBTSxJQUFJLElBQUksYUFBYSxJQUFJLE1BQU0sS0FBSztBQUMxQyxVQUFJLE1BQU0sSUFBSTtBQUNaLFlBQUksVUFBVSxLQUFLLEVBQUUsZ0JBQWdCLGtDQUFrQyxDQUFDO0FBQ3hFLFlBQUksSUFBSSxLQUFLLFVBQVUsYUFBYSxtQkFBbUIsaUJBQWlCLEVBQUUsV0FBVyxNQUFNLENBQUMsQ0FBQyxDQUFDO0FBQzlGO0FBQUEsTUFDRjtBQUNBLFVBQUksVUFBVSxLQUFLLEVBQUUsZ0JBQWdCLGtDQUFrQyxDQUFDO0FBQ3hFLFVBQUksSUFBSSxLQUFLLFVBQVU7QUFBQSxRQUNyQixNQUFNO0FBQUEsUUFBRyxLQUFLLEVBQUUsTUFBTSxPQUFPLEVBQUUsSUFBSSxLQUFLO0FBQUEsUUFBRyxNQUFNO0FBQUEsUUFDakQsTUFBTTtBQUFBLE1BQ1IsQ0FBQyxDQUFDO0FBQ0Y7QUFBQSxJQUNGO0FBQ0EsUUFBSSxJQUFJLFdBQVcsU0FBUyxJQUFJLGFBQWEsYUFBYTtBQUV4RCxVQUFJLFVBQVUsS0FBSyxFQUFFLGdCQUFnQixrQ0FBa0MsQ0FBQztBQUN4RSxVQUFJLElBQUksS0FBSyxVQUFVO0FBQUEsUUFDckIsS0FBSztBQUFBLFFBQU0sS0FBSztBQUFBLFFBQ2hCLFNBQVM7QUFBQSxVQUNQLEVBQUUsT0FBTyxLQUFLLE1BQU0sYUFBYTtBQUFBLFVBQ2pDLEVBQUUsT0FBTyxLQUFLLE1BQU0sZ0JBQWdCO0FBQUEsUUFDdEM7QUFBQSxRQUNBLE1BQU07QUFBQSxNQUNSLENBQUMsQ0FBQztBQUNGO0FBQUEsSUFDRjtBQUNBLFFBQUksSUFBSSxXQUFXLFNBQVMsSUFBSSxhQUFhLG1CQUFtQjtBQUU5RCxVQUFJLFVBQVUsS0FBSyxFQUFFLGdCQUFnQixrQ0FBa0MsQ0FBQztBQUN4RSxVQUFJLElBQUksS0FBSyxVQUFVO0FBQUEsUUFDckIsU0FBUyxlQUFlO0FBQUEsUUFDeEIsT0FBTyxlQUFlO0FBQUEsTUFDeEIsQ0FBQyxDQUFDO0FBQ0Y7QUFBQSxJQUNGO0FBQ0EsUUFBSSxJQUFJLFdBQVcsVUFBVSxJQUFJLGFBQWEsbUJBQW1CO0FBQy9ELFlBQU0sWUFBWTtBQUNoQixjQUFNLE9BQU8sS0FBSyxNQUFPLE1BQU0sU0FBUyxLQUFNLElBQUk7QUFDbEQsY0FBTSxPQUFPLE9BQU8sS0FBSyxTQUFTLFdBQVcsS0FBSyxPQUFPO0FBQ3pELGNBQU0sT0FBTyxPQUFPLEtBQUssU0FBUyxZQUFZLEtBQUssU0FBUyxLQUFLLEtBQUssT0FBUSxLQUFLLE1BQU0sT0FBTyxFQUFFLE9BQU8sT0FBTyxFQUFFLElBQUksS0FBSztBQUMzSCxZQUFJLFNBQVMsTUFBTSxTQUFTLElBQUk7QUFDOUIsY0FBSSxVQUFVLEtBQUssRUFBRSxnQkFBZ0Isa0NBQWtDLENBQUM7QUFDeEUsY0FBSSxJQUFJLEtBQUssVUFBVSxhQUFhLG1CQUFtQixtQ0FBbUMsRUFBRSxXQUFXLE1BQU0sQ0FBQyxDQUFDLENBQUM7QUFDaEg7QUFBQSxRQUNGO0FBQ0EsWUFBSSxlQUFlLE1BQU0sS0FBSyxDQUFDLE1BQU0sRUFBRSxLQUFLLFlBQVksTUFBTSxLQUFLLFlBQVksQ0FBQyxHQUFHO0FBQ2pGLGNBQUksVUFBVSxLQUFLLEVBQUUsZ0JBQWdCLGtDQUFrQyxDQUFDO0FBQ3hFLGNBQUksSUFBSSxLQUFLLFVBQVUsYUFBYSxtQkFBbUIsZ0NBQWdDLEVBQUUsV0FBVyxNQUFNLENBQUMsQ0FBQyxDQUFDO0FBQzdHO0FBQUEsUUFDRjtBQUNBLGNBQU0sT0FBTyxFQUFFLElBQUksTUFBTSxLQUFLLE9BQU8sRUFBRSxTQUFTLEVBQUUsRUFBRSxNQUFNLEdBQUcsQ0FBQyxDQUFDLElBQUksTUFBTSxLQUFLO0FBQzlFLHVCQUFlLE1BQU0sS0FBSyxJQUFJO0FBQzlCLFlBQUksVUFBVSxLQUFLLEVBQUUsZ0JBQWdCLGtDQUFrQyxDQUFDO0FBQ3hFLFlBQUksSUFBSSxLQUFLLFVBQVUsRUFBRSxJQUFJLE1BQU0sU0FBUyxlQUFlLFNBQVMsT0FBTyxlQUFlLE1BQU0sQ0FBQyxDQUFDO0FBQUEsTUFDcEcsR0FBRztBQUNIO0FBQUEsSUFDRjtBQUNBLFFBQUksSUFBSSxXQUFXLFVBQVUsSUFBSSxhQUFhLHVCQUF1QjtBQUNuRSxZQUFNLFlBQVk7QUFDaEIsY0FBTSxPQUFPLEtBQUssTUFBTyxNQUFNLFNBQVMsS0FBTSxJQUFJO0FBQ2xELGNBQU0sTUFBTSxlQUFlLE1BQU0sS0FBSyxDQUFDLE1BQU0sRUFBRSxPQUFPLEtBQUssRUFBRTtBQUM3RCxZQUFJLFFBQVEsUUFBVztBQUNyQixjQUFJLFVBQVUsS0FBSyxFQUFFLGdCQUFnQixrQ0FBa0MsQ0FBQztBQUN4RSxjQUFJLElBQUksS0FBSyxVQUFVLGFBQWEsbUJBQW1CLHVCQUF1QixFQUFFLFdBQVcsTUFBTSxDQUFDLENBQUMsQ0FBQztBQUNwRztBQUFBLFFBQ0Y7QUFDQSx1QkFBZSxVQUFVLElBQUk7QUFDN0IsWUFBSSxVQUFVLEtBQUssRUFBRSxnQkFBZ0Isa0NBQWtDLENBQUM7QUFDeEUsWUFBSSxJQUFJLEtBQUssVUFBVSxFQUFFLElBQUksTUFBTSxTQUFTLGVBQWUsU0FBUyxPQUFPLGVBQWUsTUFBTSxDQUFDLENBQUM7QUFBQSxNQUNwRyxHQUFHO0FBQ0g7QUFBQSxJQUNGO0FBQ0EsUUFBSSxJQUFJLFdBQVcsVUFBVSxJQUFJLGFBQWEsa0JBQWtCO0FBQzlELFlBQU0sWUFBWTtBQUNoQixjQUFNLE9BQU8sS0FBSyxNQUFPLE1BQU0sU0FBUyxLQUFNLElBQUk7QUFDbEQsY0FBTSxPQUFPLE9BQU8sS0FBSyxTQUFTLFdBQVcsS0FBSyxLQUFLLEtBQUssSUFBSTtBQUNoRSxjQUFNLFVBQVUsT0FBTyxLQUFLLFlBQVksV0FBVyxLQUFLLFFBQVEsS0FBSyxJQUFJO0FBQ3pFLGNBQU0sUUFBUSxPQUFPLEtBQUssVUFBVSxXQUFXLEtBQUssTUFBTSxLQUFLLElBQUk7QUFDbkUsWUFBSSxTQUFTLE1BQU0sWUFBWSxNQUFNLFVBQVUsSUFBSTtBQUNqRCxjQUFJLFVBQVUsS0FBSyxFQUFFLGdCQUFnQixrQ0FBa0MsQ0FBQztBQUN4RSxjQUFJLElBQUksS0FBSyxVQUFVLGFBQWEsbUJBQW1CLHdDQUF3QyxFQUFFLFdBQVcsTUFBTSxDQUFDLENBQUMsQ0FBQztBQUNySDtBQUFBLFFBQ0Y7QUFDQSxzQkFBYyxJQUFJLE1BQU0sRUFBRSxTQUFTLE9BQU8sUUFBUSxPQUFPLEtBQUssV0FBVyxXQUFXLEtBQUssU0FBUyxHQUFHLENBQUM7QUFDdEcsWUFBSSxVQUFVLEtBQUssRUFBRSxnQkFBZ0Isa0NBQWtDLENBQUM7QUFDeEUsWUFBSSxJQUFJLEtBQUssVUFBVSxFQUFFLElBQUksTUFBTSxLQUFLLENBQUMsQ0FBQztBQUFBLE1BQzVDLEdBQUc7QUFDSDtBQUFBLElBQ0Y7QUFDQSxRQUFJLElBQUksV0FBVyxTQUFTLElBQUksYUFBYSxrQkFBa0I7QUFFN0QsWUFBTSxLQUFLLElBQUksYUFBYSxJQUFJLEdBQUcsS0FBSyxJQUFJLEtBQUssRUFBRSxZQUFZO0FBQy9ELFlBQU0sTUFBTTtBQUFBLFFBQ1YsRUFBRSxLQUFLLGFBQWEsTUFBTSx1QkFBdUIsTUFBTSxPQUFPO0FBQUEsUUFDOUQsRUFBRSxLQUFLLGNBQWMsTUFBTSx5QkFBeUIsTUFBTSxPQUFPO0FBQUEsUUFDakUsRUFBRSxLQUFLLGlCQUFpQixNQUFNLDRCQUE0QixNQUFNLE9BQU87QUFBQSxNQUN6RTtBQUNBLFlBQU0sT0FBTyxNQUFNLEtBQUssTUFBTSxJQUFJLE9BQU8sQ0FBQyxNQUFNLEVBQUUsSUFBSSxZQUFZLEVBQUUsU0FBUyxDQUFDLENBQUM7QUFDL0UsVUFBSSxVQUFVLEtBQUssRUFBRSxnQkFBZ0Isa0NBQWtDLENBQUM7QUFDeEUsVUFBSSxJQUFJLEtBQUssVUFBVSxFQUFFLFNBQVMsS0FBSyxNQUFNLEdBQUcsRUFBRSxHQUFHLFdBQVcsT0FBTyxPQUFPLEtBQUssT0FBTyxDQUFDLENBQUM7QUFDNUY7QUFBQSxJQUNGO0FBQ0EsUUFBSSxJQUFJLFdBQVcsU0FBUyxJQUFJLGFBQWEsa0JBQWtCO0FBRTdELFVBQUksVUFBVSxLQUFLLEVBQUUsZ0JBQWdCLGtDQUFrQyxDQUFDO0FBQ3hFLFVBQUksSUFBSSxLQUFLLFVBQVU7QUFBQSxRQUNyQixRQUFRLEVBQUUsUUFBUSxHQUFHLFNBQVMsSUFBSSxnQkFBZ0IsRUFBRTtBQUFBLFFBQ3BELGNBQWM7QUFBQSxRQUNkLGFBQWE7QUFBQSxRQUNiLFlBQVksRUFBRSxTQUFTLEdBQUcsU0FBUyxHQUFHLFNBQVMsR0FBRyxPQUFPLEtBQUs7QUFBQSxRQUM5RCxhQUFhLEVBQUUsYUFBYSxJQUFJLGFBQWEsS0FBSztBQUFBLE1BQ3BELENBQUMsQ0FBQztBQUNGO0FBQUEsSUFDRjtBQUNBLFFBQUksSUFBSSxXQUFXLFVBQVUsSUFBSSxhQUFhLGtCQUFrQjtBQUM5RCxZQUFNLFlBQVk7QUFDaEIsWUFBSTtBQUNGLGdCQUFNLE9BQU8sS0FBSyxNQUFPLE1BQU0sU0FBUyxLQUFNLElBQUk7QUFHbEQsZ0JBQU0sTUFBTSxLQUFLLEtBQUssV0FBVyxLQUFLLE9BQU8sS0FBSyxNQUFNLEtBQUssT0FBTztBQUNwRSxjQUFJLFVBQVUsS0FBSyxFQUFFLGdCQUFnQixrQ0FBa0MsQ0FBQztBQUN4RSxjQUFJLElBQUksS0FBSyxVQUFVLEVBQUUsSUFBSSxNQUFNLElBQUksQ0FBQyxDQUFDO0FBQUEsUUFDM0MsU0FBUyxLQUFLO0FBQ1osY0FBSSxVQUFVLEtBQUssRUFBRSxnQkFBZ0Isa0NBQWtDLENBQUM7QUFDeEUsY0FBSSxJQUFJLEtBQUssVUFBVSxhQUFhLG1CQUFtQixPQUFPLEdBQUcsRUFBRSxNQUFNLEdBQUcsR0FBRyxHQUFHLEVBQUUsV0FBVyxNQUFNLENBQUMsQ0FBQyxDQUFDO0FBQUEsUUFDMUc7QUFBQSxNQUNGLEdBQUc7QUFDSDtBQUFBLElBQ0Y7QUFDQSxRQUFJLFVBQVUsS0FBSyxFQUFFLGdCQUFnQixrQ0FBa0MsQ0FBQztBQUN4RSxRQUFJLElBQUksS0FBSyxVQUFVLGFBQWEsbUJBQW1CLFlBQVksSUFBSSxNQUFNLElBQUksSUFBSSxRQUFRLElBQUksRUFBRSxXQUFXLE1BQU0sQ0FBQyxDQUFDLENBQUM7QUFBQSxFQUN6SCxDQUFDO0FBRUQsUUFBTSxJQUFJLFFBQWMsQ0FBQ0EsVUFBUyxXQUFXO0FBQzNDLFdBQU8sS0FBSyxTQUFTLE1BQU07QUFDM0IsV0FBTyxPQUFPLEdBQUcsYUFBYSxNQUFNQSxTQUFRLENBQUM7QUFBQSxFQUMvQyxDQUFDO0FBQ0QsUUFBTSxVQUFVLE9BQU8sUUFBUTtBQUMvQixNQUFJLFlBQVksUUFBUSxPQUFPLFlBQVksU0FBVSxPQUFNLElBQUksTUFBTSxvQkFBb0I7QUFDekYsUUFBTSxPQUFPLFFBQVE7QUFFckIsTUFBSSxDQUFDLEtBQUssT0FBTztBQUNmLFlBQVEsT0FBTyxNQUFNLEdBQUcsS0FBSyxVQUFVLEVBQUUscUJBQXFCLE1BQU0sTUFBTSxTQUFTLGFBQWEsQ0FBQyxDQUFDO0FBQUEsQ0FBSTtBQUFBLEVBQ3hHO0FBQ0EsUUFBTSxXQUFXLE9BQU8sUUFBUSxJQUFJLDBCQUEwQixDQUFDO0FBQy9ELE1BQUksT0FBTyxTQUFTLFFBQVEsS0FBSyxXQUFXLEdBQUc7QUFDN0MsZUFBVyxNQUFNLFFBQVEsS0FBSyxDQUFDLEdBQUcsUUFBUSxFQUFFLE1BQU07QUFBQSxFQUNwRDtBQUlBLFFBQU0sUUFBUSxNQUNaLElBQUksUUFBYyxDQUFDQSxhQUFZO0FBQzdCLGVBQVcsS0FBSyxZQUFZO0FBQzFCLFVBQUk7QUFBRSxVQUFFLElBQUk7QUFBRyxVQUFFLFFBQVE7QUFBQSxNQUFHLFFBQVE7QUFBQSxNQUFxQjtBQUFBLElBQzNEO0FBQ0EsZUFBVyxNQUFNO0FBQ2pCLFdBQU8sTUFBTSxNQUFNQSxTQUFRLENBQUM7QUFDNUIsZUFBVyxNQUFNQSxTQUFRLEdBQUcsR0FBSyxFQUFFLE1BQU07QUFBQSxFQUMzQyxDQUFDO0FBRUgsU0FBTyxFQUFFLE1BQU0sTUFBTSxNQUFNO0FBQzdCO0FBS0EsSUFBTSxVQUFrQixPQUFPLGVBQWUsV0FDMUMsY0FBYyxhQUFhLFVBQVUsQ0FBQyxFQUFFLE9BQ3hDLFlBQVk7QUFDaEIsSUFBTSxtQkFBbUIsTUFBTTtBQUM3QixNQUFJLFFBQVEsS0FBSyxDQUFDLE1BQU0sT0FBVyxRQUFPO0FBQzFDLE1BQUk7QUFDRixXQUFPLFlBQVksY0FBYyxhQUFhLFFBQVEsS0FBSyxDQUFDLENBQUMsQ0FBQyxFQUFFO0FBQUEsRUFDbEUsUUFBUTtBQUNOLFdBQU87QUFBQSxFQUNUO0FBQ0YsR0FBRztBQUNILElBQUksaUJBQWlCO0FBQ25CLFFBQU0sUUFBUSxRQUFRLElBQUkscUJBQXFCO0FBRS9DLE1BQUksUUFBUSxJQUFJLDBCQUEwQixLQUFLO0FBQzdDLFlBQVEsS0FBSyxDQUFDO0FBQUEsRUFDaEI7QUFDQSxRQUFNLE9BQU8sT0FBTyxRQUFRLElBQUksd0JBQXdCLENBQUM7QUFDekQsUUFBTSxPQUFPLE1BQVk7QUFDdkIsU0FBSyxjQUFjLEVBQUUsTUFBTSxDQUFDLEVBQUUsTUFBTSxDQUFDLFFBQVE7QUFDM0MsY0FBUSxPQUFPLE1BQU0scUJBQXFCLE9BQU8sR0FBRyxDQUFDO0FBQUEsQ0FBSTtBQUN6RCxjQUFRLEtBQUssQ0FBQztBQUFBLElBQ2hCLENBQUM7QUFBQSxFQUNIO0FBQ0EsTUFBSSxPQUFPLFNBQVMsSUFBSSxLQUFLLE9BQU8sRUFBRyxZQUFXLE1BQU0sSUFBSTtBQUFBLE1BQ3ZELE1BQUs7QUFDWjs7O0FDNWxCQSxTQUFTLFdBQStCO0FBQ3hDLFNBQVMsT0FBTyxpQkFBaUI7QUFDakMsU0FBUyxZQUFZO0FBRXJCLElBQU0sUUFBUSxDQUFDLE9BQThCLElBQUksUUFBUSxDQUFDLE1BQU0sV0FBVyxHQUFHLEVBQUUsQ0FBQztBQUVqRixlQUFlLFlBQVksS0FBb0IsTUFBc0M7QUFDbkYsUUFBTSxRQUFRLFFBQVEsSUFBSSw4QkFBOEIsS0FBSyxJQUFJLFFBQVEsTUFBTSxHQUFHLGNBQWM7QUFDaEcsUUFBTSxNQUFNLE9BQU8sRUFBRSxXQUFXLEtBQUssQ0FBQyxFQUFFLE1BQU0sTUFBTSxNQUFTO0FBQzdELFFBQU0sVUFBNEMsQ0FBQztBQUNuRCxNQUFJLFVBQVU7QUFFZCxRQUFNLEtBQUssQ0FBSSxTQUE2QixJQUFJLFlBQVksa0JBQWtCLE1BQU0sSUFBSTtBQUN4RixRQUFNLE9BQU8sT0FBTyxNQUFjLE9BQXdEO0FBQ3hGLFFBQUk7QUFDRixZQUFNLENBQUMsSUFBSSxNQUFNLElBQUksTUFBTSxHQUFHO0FBQzlCLGNBQVEsS0FBSyxDQUFDLE1BQU0sSUFBSSxNQUFNLENBQUM7QUFBQSxJQUNqQyxTQUFTLEtBQUs7QUFDWixZQUFNLFNBQVMsZUFBZSxTQUFTLElBQUksVUFBVSxTQUFZLElBQUksUUFBUSxPQUFPLEdBQUc7QUFDdkYsY0FBUSxLQUFLLENBQUMsTUFBTSxPQUFPLE9BQU8sTUFBTSxHQUFHLEdBQUcsQ0FBQyxDQUFDO0FBQUEsSUFDbEQ7QUFDQSxVQUFNLE9BQU8sUUFBUSxRQUFRLFNBQVMsQ0FBQztBQUN2QyxZQUFRLElBQUksWUFBWSxLQUFLLENBQUMsSUFBSSxTQUFTLE1BQU0sTUFBTSxLQUFLLENBQUMsQ0FBQyxNQUFNLEtBQUssQ0FBQyxDQUFDLEVBQUU7QUFBQSxFQUMvRTtBQUVBLFFBQU0sVUFBVSxPQUFPLE9BQWUsZUFBdUIsY0FBa0Q7QUFDN0csVUFBTSxVQUFVLEtBQUssSUFBSTtBQUN6QixlQUFTO0FBQ1AsWUFBTSxJQUFLLE1BQU0sR0FBRyx5REFBeUQsYUFBYSw4RkFBOEY7QUFDeEwsVUFBSTtBQUNKLFVBQUk7QUFBRSxpQkFBUyxLQUFLLE1BQU0sQ0FBQztBQUFBLE1BQXdDLFFBQVE7QUFBRSxpQkFBUyxFQUFFLElBQUksT0FBTyxRQUFRLE9BQU8sQ0FBQyxFQUFFLE1BQU0sR0FBRyxHQUFHLEVBQUU7QUFBQSxNQUFHO0FBQ3RJLFVBQUksT0FBTyxPQUFPLEtBQU0sUUFBTyxDQUFDLE1BQU0sT0FBTyxPQUFPLFVBQVUsRUFBRSxDQUFDO0FBQ2pFLFVBQUksS0FBSyxJQUFJLElBQUksVUFBVSxVQUFXLFFBQU8sQ0FBQyxPQUFPLEdBQUcsS0FBSyxLQUFLLE9BQU8sT0FBTyxVQUFVLFNBQVMsQ0FBQyxFQUFFO0FBQ3RHLFlBQU0sTUFBTSxHQUFHO0FBQUEsSUFDakI7QUFBQSxFQUNGO0FBQ0EsUUFBTSxPQUFPLE9BQU8sVUFBaUM7QUFDbkQsZUFBVztBQUNYLFFBQUk7QUFDRixZQUFNLE1BQU0sTUFBTSxJQUFJLFlBQVksWUFBWTtBQUM5QyxZQUFNLFVBQVUsS0FBSyxPQUFPLEdBQUcsSUFBSSxJQUFJLE9BQU8sT0FBTyxFQUFFLFNBQVMsR0FBRyxHQUFHLENBQUMsSUFBSSxLQUFLLE1BQU0sR0FBRyxJQUFJLE1BQU0sQ0FBQztBQUFBLElBQ3RHLFFBQVE7QUFBQSxJQUFnQjtBQUFBLEVBQzFCO0FBR0EsUUFBTSxXQUFXLENBQUMsS0FBYSxTQUM3QixHQUFHO0FBQUEsd0NBQ2lDLEtBQUssVUFBVSxHQUFHLENBQUM7QUFBQTtBQUFBO0FBQUEscUVBR1UsS0FBSyxVQUFVLElBQUksQ0FBQztBQUFBO0FBQUE7QUFBQSxTQUdoRjtBQUlQLFFBQU0sUUFBUSxjQUFjLGdIQUFnSCxHQUFNO0FBQ2xKLFFBQU0sUUFBUSxlQUFlLGtJQUFrSSxTQUFTLFNBQVMsTUFBUyxHQUFNO0FBQ2hNLFFBQU0sTUFBTSxJQUFLO0FBR2pCLFFBQU0sS0FBSyxrSEFBa0MsWUFBWTtBQUN2RCxVQUFNLElBQUssTUFBTSxHQUFHO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLFNBU2Y7QUFDTCxVQUFNLElBQUksS0FBSyxNQUFNLENBQUM7QUFDdEIsV0FBTyxDQUFDLEVBQUUsT0FBTyxNQUFNLEVBQUUsTUFBTTtBQUFBLEVBQ2pDLENBQUM7QUFFRCxNQUFJLFNBQVMsUUFBUTtBQUduQixRQUFJLFFBQVEsSUFBSSxnQ0FBZ0MsUUFBUTtBQUN0RCxZQUFNLEtBQUssOEdBQXlCLFlBQVk7QUFDOUMsY0FBTSxJQUFJLE1BQU0sUUFBUSxrQkFBa0I7QUFBQTtBQUFBLG9HQUU4QixJQUFNO0FBQzlFLGNBQU0sS0FBSyxnQkFBZ0I7QUFDM0IsZUFBTztBQUFBLE1BQ1QsQ0FBQztBQUNELFlBQU0sS0FBSyx3TEFBdUMsWUFBWTtBQUM1RCxjQUFNLEdBQUcsMkxBQXVLO0FBQ2hMLGNBQU0sSUFBSSxNQUFNLFFBQVEsZUFBZTtBQUFBO0FBQUE7QUFBQTtBQUFBLHFHQUlzRCxJQUFNO0FBQ25HLGNBQU0sS0FBSyxlQUFlO0FBQzFCLGVBQU87QUFBQSxNQUNULENBQUM7QUFDRCxZQUFNLEtBQUsseUxBQW1DLFlBQVk7QUFDeEQsY0FBTSxHQUFHLDJNQUFtSztBQUM1SyxjQUFNLE1BQU0sR0FBRztBQUNmLGNBQU0sR0FBRyx3T0FBcU07QUFFOU0sY0FBTSxRQUFRLGtCQUFrQjtBQUFBO0FBQUE7QUFBQTtBQUFBLGlEQUlTLElBQU07QUFDL0MsY0FBTSxJQUFJLE1BQU0sUUFBUSxhQUFhO0FBQUE7QUFBQSwwSUFFeUUsR0FBSztBQUNuSCxjQUFNLEtBQUssYUFBYTtBQUN4QixjQUFNLEdBQUcsMkxBQXVLO0FBQ2hMLGNBQU0sU0FBUyxNQUFNLFFBQVEsNkJBQTZCO0FBQUEseUpBQ3VGLEdBQU07QUFDdkosZUFBTyxDQUFDLEVBQUUsQ0FBQyxLQUFLLE9BQU8sQ0FBQyxHQUFHLFNBQVMsRUFBRSxDQUFDLENBQUMsS0FBSyxPQUFPLENBQUMsQ0FBQyxFQUFFO0FBQUEsTUFDMUQsQ0FBQztBQUFBLElBQ0g7QUFHQSxVQUFNLEtBQUssK0ZBQW9CLFlBQVk7QUFDekMsWUFBTSxJQUFJLE1BQU0sUUFBUSxTQUFTLHdHQUF3RyxHQUFLO0FBQzlJLFVBQUksQ0FBQyxFQUFFLENBQUMsRUFBRyxRQUFPO0FBQ2xCLFlBQU0sR0FBRztBQUFBO0FBQUE7QUFBQTtBQUFBLFdBSUo7QUFDTCxhQUFPLFFBQVEsY0FBYyxxSUFBcUksR0FBSztBQUFBLElBQ3pLLENBQUM7QUFHRCxVQUFNLEtBQUssa0VBQXFCLFlBQVk7QUFDMUMsWUFBTSxHQUFHLDJGQUEyRjtBQUNwRyxhQUFPLFFBQVEsb0JBQW9CO0FBQUEsMk1BQzhJLEdBQUs7QUFBQSxJQUN4TCxDQUFDO0FBR0QsVUFBTSxLQUFLLDJHQUFzQixZQUFZO0FBQzNDLFlBQU0sU0FBUyxzQkFBc0IsK0RBQWE7QUFDbEQsWUFBTSxNQUFNLEdBQUc7QUFDZixZQUFNLEdBQUc7QUFBQTtBQUFBO0FBQUE7QUFBQSxXQUlKO0FBQ0wsYUFBTyxRQUFRLHlCQUF5QjtBQUFBLDBIQUM0RSxHQUFLO0FBQUEsSUFDM0gsQ0FBQztBQUdELFVBQU0sS0FBSywyRUFBeUIsWUFBWTtBQUM5QyxZQUFNLElBQUksTUFBTSxRQUFRLGFBQWE7QUFBQTtBQUFBLHlGQUU4QyxHQUFLO0FBQ3hGLGFBQU87QUFBQSxJQUNULENBQUM7QUFHRCxVQUFNLEtBQUssa0ZBQTJCLFlBQVk7QUFDaEQsWUFBTSxLQUFLLGtCQUFrQjtBQUM3QixhQUFPLFFBQVEsaUJBQWlCO0FBQUEsd0tBQzhHLEdBQUs7QUFBQSxJQUNySixDQUFDO0FBQ0QsVUFBTSxLQUFLLHdHQUF3QixZQUFZO0FBQzdDLFlBQU0sR0FBRztBQUFBO0FBQUE7QUFBQSxXQUdKO0FBQ0wsWUFBTSxJQUFJLE1BQU0sUUFBUSxnQkFBZ0I7QUFBQTtBQUFBO0FBQUEsbUxBR3FJLElBQU07QUFDbkwsWUFBTSxLQUFLLGVBQWU7QUFDMUIsYUFBTztBQUFBLElBQ1QsQ0FBQztBQUdELFVBQU0sS0FBSyxtRkFBNEIsWUFBWTtBQUNqRCxZQUFNLEdBQUcsdUZBQXVGO0FBQ2hHLGFBQU8sUUFBUSxpQkFBaUI7QUFBQSwrSUFDeUcsR0FBSztBQUFBLElBQ2hKLENBQUM7QUFHRCxVQUFNLEtBQUssb0NBQXFCLFlBQVk7QUFDMUMsWUFBTSxHQUFHLHVKQUF1SjtBQUNoSyxhQUFPLFFBQVEsaUJBQWlCO0FBQUE7QUFBQSxpSkFFMkcsR0FBSztBQUFBLElBQ2xKLENBQUM7QUFDRCxVQUFNLEtBQUssb0RBQXNCLFlBQVk7QUFDM0MsWUFBTSxHQUFHLG9MQUEwSztBQUNuTCxZQUFNLElBQUksTUFBTSxRQUFRLFdBQVc7QUFBQSx3REFDZSxHQUFLO0FBQ3ZELFVBQUksQ0FBQyxFQUFFLENBQUMsRUFBRyxRQUFPO0FBRWxCLFlBQU0sR0FBRyw4TUFBdU07QUFDaE4sWUFBTSxLQUFLLE1BQU0sUUFBUSxhQUFhO0FBQUEsd0hBQzRFLEdBQUs7QUFDdkgsVUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFHLFFBQU87QUFDbkIsWUFBTSxHQUFHLDZKQUE2SjtBQUN0SyxhQUFPLFFBQVEsZ0JBQWdCO0FBQUEsdUpBQ2tILEdBQUs7QUFBQSxJQUN4SixDQUFDO0FBQ0QsVUFBTSxLQUFLLGdDQUFpQixZQUFZO0FBQ3RDLFlBQU0sR0FBRyxtTEFBeUs7QUFDbEwsYUFBTyxRQUFRLGFBQWE7QUFBQSw2REFDMkIsR0FBSztBQUFBLElBQzlELENBQUM7QUFDRCxVQUFNLEtBQUssMENBQXNCLFlBQVk7QUFDM0MsWUFBTSxHQUFHLHVMQUE2SztBQUN0TCxhQUFPLFFBQVEsaUJBQWlCO0FBQUE7QUFBQSx5SUFFbUcsR0FBSztBQUFBLElBQzFJLENBQUM7QUFDRCxVQUFNLEtBQUssb0RBQXNCLFlBQVk7QUFDM0MsWUFBTSxHQUFHLG1MQUF5SztBQUNsTCxZQUFNLElBQUksTUFBTSxRQUFRLGFBQWE7QUFBQSwwR0FDK0QsR0FBSztBQUN6RyxhQUFPO0FBQUEsSUFDVCxDQUFDO0FBR0QsVUFBTSxLQUFLLG1GQUF1QixZQUFZO0FBQzVDLFlBQU0sR0FBRyxxTEFBMks7QUFDcEwsYUFBTyxRQUFRLGVBQWU7QUFBQTtBQUFBO0FBQUE7QUFBQSxzRkFJa0QsR0FBSztBQUFBLElBQ3ZGLENBQUM7QUFHRCxVQUFNLEtBQUsscURBQWEsWUFBWTtBQUNsQyxZQUFNLFNBQVUsTUFBTSxHQUFHLG1EQUFtRDtBQUM1RSxZQUFNLFNBQVMsbUJBQW1CLDBDQUFZO0FBQzlDLFlBQU0sSUFBSSxNQUFNLFFBQVEsa0JBQWtCO0FBQUEsb0RBQ0ksR0FBSztBQUNuRCxZQUFNLFNBQVMsbUJBQW1CLEVBQUU7QUFDcEMsWUFBTSxNQUFNLEdBQUc7QUFDZixZQUFNLFFBQVMsTUFBTSxHQUFHLG1EQUFtRDtBQUMzRSxhQUFPLENBQUMsRUFBRSxDQUFDLEtBQUssVUFBVSxRQUFRLEdBQUcsRUFBRSxDQUFDLENBQUMsd0JBQVMsS0FBSyxNQUFNLE1BQU0sRUFBRTtBQUFBLElBQ3ZFLENBQUM7QUFHRCxVQUFNLEtBQUssOEVBQXVCLFlBQVk7QUFDNUMsWUFBTSxHQUFHLDJGQUEyRjtBQUNwRyxZQUFNLElBQUksTUFBTSxRQUFRLGFBQWE7QUFBQSw2REFDa0IsR0FBSztBQUM1RCxVQUFJLENBQUMsRUFBRSxDQUFDLEVBQUcsUUFBTztBQUNsQixZQUFNLEdBQUcsOE1BQW9NO0FBQzdNLGFBQU8sUUFBUSxnQkFBZ0I7QUFBQSxxSUFDc0YsR0FBSztBQUFBLElBQzVILENBQUM7QUFHRCxVQUFNLEtBQUssaUZBQXlDLFlBQVk7QUFDOUQsWUFBTSxHQUFHLDBHQUEwRztBQUNuSCxZQUFNLElBQUksTUFBTSxRQUFRLGlCQUFpQjtBQUFBLHlHQUMwRCxHQUFLO0FBQ3hHLFVBQUksQ0FBQyxFQUFFLENBQUMsRUFBRyxRQUFPO0FBQ2xCLFlBQU0sR0FBRyxrRkFBa0Y7QUFDM0YsYUFBTyxRQUFRLG1CQUFtQiw0RUFBNEUsR0FBSztBQUFBLElBQ3JILENBQUM7QUFHRCxVQUFNLEtBQUssd0ZBQTRCLFlBQVk7QUFDakQsWUFBTSxHQUFHLDBHQUEwRztBQUNuSCxZQUFNLElBQUksTUFBTSxRQUFRLGlCQUFpQjtBQUFBLDZEQUNjLEdBQUs7QUFDNUQsVUFBSSxDQUFDLEVBQUUsQ0FBQyxFQUFHLFFBQU87QUFDbEIsWUFBTSxHQUFHLHlLQUF5SztBQUNsTCxZQUFNLEtBQUssTUFBTSxRQUFRLGlCQUFpQjtBQUFBLDBHQUMwRCxHQUFLO0FBQ3pHLFlBQU0sS0FBSyxTQUFTO0FBQ3BCLFlBQU0sR0FBRyw4S0FBb0s7QUFDN0ssWUFBTSxLQUFLLE1BQU0sUUFBUSxnQkFBZ0I7QUFBQSx1SEFDb0QsR0FBSztBQUNsRyxZQUFNLEdBQUcsa0ZBQWtGO0FBQzNGLGFBQU8sQ0FBQyxHQUFHLENBQUMsS0FBSyxHQUFHLENBQUMsR0FBRyxPQUFPLEdBQUcsQ0FBQyxDQUFDLFNBQVMsR0FBRyxDQUFDLENBQUMsRUFBRTtBQUFBLElBQ3RELENBQUM7QUFHRCxVQUFNLEtBQUssNkdBQXdCLFlBQVk7QUFDN0MsYUFBTyxRQUFRLGlCQUFpQjtBQUFBO0FBQUEsOEhBRThFLEdBQUs7QUFBQSxJQUNySCxDQUFDO0FBQ0QsVUFBTSxLQUFLLDJLQUFvQyxZQUFZO0FBQ3pELFlBQU0sR0FBRyxvRkFBb0Y7QUFDN0YsWUFBTSxJQUFJLE1BQU0sUUFBUSxXQUFXO0FBQUE7QUFBQTtBQUFBO0FBQUEsMEdBSWlFLEdBQUs7QUFDekcsVUFBSSxDQUFDLEVBQUUsQ0FBQyxFQUFHLFFBQU87QUFDbEIsWUFBTSxLQUFLLFNBQVM7QUFFcEIsWUFBTSxHQUFHLHNGQUFzRjtBQUMvRixZQUFNLFNBQVMsTUFBTSxRQUFRLGdDQUFnQztBQUFBLGtNQUMrSCxHQUFLO0FBQ2pNLGFBQU8sQ0FBQyxPQUFPLENBQUMsR0FBRyxHQUFHLEVBQUUsQ0FBQyxDQUFDLEtBQUssT0FBTyxDQUFDLENBQUMsRUFBRTtBQUFBLElBQzVDLENBQUM7QUFHRCxVQUFNLEtBQUssNEZBQXNCLFlBQVk7QUFDM0MsYUFBTyxRQUFRLGNBQWM7QUFBQTtBQUFBO0FBQUEsMkZBR3dELEdBQUs7QUFBQSxJQUM1RixDQUFDO0FBQ0QsVUFBTSxLQUFLLHNHQUFzQixZQUFZO0FBQzNDLFlBQU0sU0FBVSxNQUFNLEdBQUcsbURBQW1EO0FBQzVFLFVBQUksV0FBVyxFQUFHLFFBQU8sQ0FBQyxPQUFPLHNCQUFzQjtBQUN2RCxZQUFNLEdBQUcsb0ZBQW9GO0FBQzdGLFlBQU0sWUFBWSxNQUFNLFFBQVEsYUFBYTtBQUFBLDJFQUN3QixNQUFNO0FBQUEsMEdBQ3lCLE1BQU0sT0FBTyxHQUFLO0FBQ3RILFlBQU0sS0FBSyxvQkFBb0I7QUFDL0IsWUFBTSxHQUFHLG9GQUFvRjtBQUM3RixZQUFNLFdBQVcsTUFBTSxRQUFRLGlCQUFpQjtBQUFBLDJCQUMzQixNQUFNLDBCQUEwQixHQUFLO0FBQzFELGFBQU8sQ0FBQyxVQUFVLENBQUMsS0FBSyxTQUFTLENBQUMsR0FBRyxhQUFhLFVBQVUsQ0FBQyxDQUFDLGFBQWEsU0FBUyxDQUFDLENBQUMsRUFBRTtBQUFBLElBQzFGLENBQUM7QUFHRCxVQUFNLEtBQUssdUVBQTBCLFlBQVk7QUFDL0MsWUFBTSxHQUFHLDJGQUEyRjtBQUNwRyxZQUFNLElBQUksTUFBTSxRQUFRLGtCQUFrQjtBQUFBO0FBQUEsd0RBRVEsR0FBSztBQUN2RCxVQUFJLENBQUMsRUFBRSxDQUFDLEVBQUcsUUFBTztBQUNsQixZQUFNLEtBQUssV0FBVztBQUN0QixZQUFNLEdBQUcsa0ZBQWtGO0FBQzNGLGFBQU8sUUFBUSxvQkFBb0IsNEVBQTRFLEdBQUs7QUFBQSxJQUN0SCxDQUFDO0FBR0QsVUFBTSxLQUFLLDRGQUFzQixZQUFZO0FBRTNDLFlBQU0sSUFBSSxNQUFNLFFBQVEsY0FBYztBQUFBLG9GQUN3QyxHQUFLO0FBQ25GLFVBQUksQ0FBQyxFQUFFLENBQUMsRUFBRyxRQUFPO0FBQ2xCLFlBQU0sR0FBRywrTEFBcUw7QUFDOUwsWUFBTSxTQUFTLE1BQU0sUUFBUSxrQkFBa0I7QUFBQTtBQUFBLDBGQUVxQyxHQUFLO0FBQ3pGLFlBQU0sR0FBRywrTEFBcUw7QUFDOUwsWUFBTSxRQUFRLE1BQU0sUUFBUSxnQkFBZ0I7QUFBQSxxSUFDbUYsR0FBSztBQUNwSSxhQUFPLENBQUMsT0FBTyxDQUFDLEtBQUssTUFBTSxDQUFDLEdBQUcsU0FBUyxPQUFPLENBQUMsQ0FBQyxXQUFXLE1BQU0sQ0FBQyxDQUFDLEVBQUU7QUFBQSxJQUN4RSxDQUFDO0FBQ0QsVUFBTSxLQUFLLG1IQUF5QixZQUFZO0FBQzlDLFlBQU0sTUFBTSxNQUFNLFFBQVEsaUJBQWlCO0FBQUEsZ0dBQytDLEdBQUs7QUFDL0YsVUFBSSxDQUFDLElBQUksQ0FBQyxFQUFHLFFBQU87QUFDcEIsWUFBTSxHQUFHLDJJQUEySTtBQUNwSixZQUFNLE1BQU0sR0FBRztBQUNmLFlBQU0sS0FBTSxNQUFNLEdBQUcsbURBQW1EO0FBQ3hFLFlBQU0sR0FBRyx1SUFBdUk7QUFDaEosWUFBTSxNQUFNLEdBQUc7QUFDZixZQUFNLEtBQU0sTUFBTSxHQUFHLG1EQUFtRDtBQUN4RSxhQUFPLENBQUMsTUFBTSxNQUFNLE1BQU0sR0FBRyxXQUFXLEVBQUUsUUFBUSxFQUFFLEVBQUU7QUFBQSxJQUN4RCxDQUFDO0FBR0QsVUFBTSxLQUFLLDBHQUErQixZQUFZO0FBQ3BELFlBQU0sSUFBSSxNQUFNLFFBQVEsZ0JBQWdCO0FBQUEsd0ZBQzBDLEdBQUs7QUFDdkYsVUFBSSxDQUFDLEVBQUUsQ0FBQyxFQUFHLFFBQU87QUFDbEIsWUFBTSxHQUFHLDZGQUE2RjtBQUN0RyxZQUFNLElBQUksTUFBTSxRQUFRLGNBQWM7QUFBQTtBQUFBO0FBQUEsdUZBRzJDLEdBQUs7QUFDdEYsVUFBSSxDQUFDLEVBQUUsQ0FBQyxFQUFHLFFBQU87QUFDbEIsWUFBTSxLQUFLLFlBQVk7QUFFdkIsWUFBTSxHQUFHLCtJQUErSTtBQUN4SixhQUFPLFFBQVEsa0JBQWtCO0FBQUEsc0hBQytFLEdBQUs7QUFBQSxJQUN2SCxDQUFDO0FBR0QsVUFBTSxLQUFLLG9GQUFtQixZQUFZO0FBQ3hDLFlBQU0sR0FBRywwR0FBMEc7QUFDbkgsWUFBTSxJQUFJLE1BQU0sUUFBUSxpQkFBaUI7QUFBQSw2REFDYyxHQUFLO0FBQzVELFVBQUksQ0FBQyxFQUFFLENBQUMsRUFBRyxRQUFPO0FBQ2xCLFlBQU0sR0FBRyxtTkFBeU07QUFDbE4sWUFBTSxRQUFRLE1BQU0sUUFBUSxlQUFlO0FBQUE7QUFBQTtBQUFBLGlIQUdnRSxHQUFLO0FBQ2hILFlBQU0sS0FBSyxhQUFhO0FBQ3hCLFlBQU0sR0FBRyxrTkFBd007QUFDak4sWUFBTSxPQUFPLE1BQU0sUUFBUSxhQUFhLDBIQUEwSCxHQUFLO0FBQ3ZLLFlBQU0sR0FBRyxrRkFBa0Y7QUFDM0YsYUFBTyxDQUFDLE1BQU0sQ0FBQyxLQUFLLEtBQUssQ0FBQyxHQUFHLFVBQVUsTUFBTSxDQUFDLENBQUMsV0FBVyxLQUFLLENBQUMsQ0FBQyxFQUFFO0FBQUEsSUFDckUsQ0FBQztBQUdELFVBQU0sS0FBSywyRUFBb0IsWUFBWTtBQUN6QyxZQUFNLElBQUksTUFBTSxRQUFRLFlBQVk7QUFBQSwyR0FDaUUsR0FBSztBQUMxRyxVQUFJLENBQUMsRUFBRSxDQUFDLEVBQUcsUUFBTztBQUNsQixZQUFNLEdBQUcsK0pBQStKO0FBQ3hLLFlBQU0sS0FBSyxNQUFNLFFBQVEsV0FBVztBQUFBLDBHQUNnRSxHQUFLO0FBQ3pHLFlBQU0sR0FBRyxtS0FBOEo7QUFDdkssWUFBTSxLQUFLLE1BQU0sUUFBUSxnQkFBZ0I7QUFBQSx1SEFDb0QsR0FBSztBQUNsRyxhQUFPLENBQUMsR0FBRyxDQUFDLEtBQUssR0FBRyxDQUFDLEdBQUcsT0FBTyxHQUFHLENBQUMsQ0FBQyxTQUFTLEdBQUcsQ0FBQyxDQUFDLEVBQUU7QUFBQSxJQUN0RCxDQUFDO0FBR0QsVUFBTSxLQUFLLDBHQUFvQyxZQUFZO0FBRXpELFlBQU0sR0FBRywyRkFBMkY7QUFDcEcsWUFBTSxNQUFNLEdBQUc7QUFDZixZQUFNLEdBQUc7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsV0FZSjtBQUNMLFlBQU0sT0FBTyxNQUFNLFFBQVEsY0FBYztBQUFBLHVEQUNRLEdBQUs7QUFDdEQsVUFBSSxDQUFDLEtBQUssQ0FBQyxFQUFHLFFBQU87QUFDckIsWUFBTSxTQUFTLHNCQUFzQiwwQkFBTTtBQUMzQyxZQUFNLE1BQU0sR0FBRztBQUNmLFlBQU0sR0FBRyx5S0FBK0o7QUFDeEssWUFBTSxPQUFPLE1BQU0sUUFBUSxjQUFjO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLFNBTXRDLElBQU07QUFDVCxZQUFNLEtBQUssY0FBYztBQUN6QixhQUFPO0FBQUEsSUFDVCxDQUFDO0FBR0QsVUFBTSxLQUFLLHNIQUE2QixZQUFZO0FBQ2xELFlBQU0sSUFBSyxNQUFNLEdBQUc7QUFBQTtBQUFBO0FBQUE7QUFBQSxXQUlmO0FBQ0wsWUFBTSxJQUFJLEtBQUssTUFBTSxDQUFDO0FBQ3RCLGFBQU8sQ0FBQyxFQUFFLE1BQU0sRUFBRSxRQUFRLGFBQU0sRUFBRSxFQUFFLGNBQU8sRUFBRSxNQUFNLEVBQUU7QUFBQSxJQUN2RCxDQUFDO0FBR0QsVUFBTSxLQUFLLCtFQUFtQixZQUFZO0FBQ3hDLFlBQU0sR0FBRyw4SkFBOEo7QUFDdkssWUFBTSxJQUFJLE1BQU0sUUFBUSxjQUFjO0FBQUEsNkRBQ2lCLEdBQUs7QUFDNUQsVUFBSSxDQUFDLEVBQUUsQ0FBQyxFQUFHLFFBQU87QUFDbEIsWUFBTSxTQUFTLHFCQUFxQixNQUFNO0FBQzFDLFlBQU0sS0FBSyxNQUFNLFFBQVEsZUFBZTtBQUFBLHFEQUNPLEdBQUs7QUFDcEQsVUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFHLFFBQU87QUFDbkIsWUFBTSxHQUFHLDBGQUEwRjtBQUNuRyxhQUFPLFFBQVEsWUFBWTtBQUFBLG1EQUNrQixHQUFLO0FBQUEsSUFDcEQsQ0FBQztBQUdELFFBQUksUUFBUSxJQUFJLGdDQUFnQyxRQUFRO0FBQ3RELFlBQU0sS0FBSyxxSEFBcUMsWUFBWTtBQUMxRCxjQUFNLEdBQUcsMEdBQTBHO0FBQ25ILGNBQU0sT0FBTyxNQUFNLFFBQVEsaUJBQWlCO0FBQUEsNkRBQ1MsR0FBSztBQUMxRCxZQUFJLENBQUMsS0FBSyxDQUFDLEVBQUcsUUFBTztBQUNyQixjQUFNLEdBQUcsNkxBQXlLO0FBQ2xMLGNBQU0sUUFBUSxNQUFNLFFBQVEsbUJBQW1CO0FBQUEsb0ZBQzZCLEdBQUs7QUFDakYsWUFBSSxDQUFDLE1BQU0sQ0FBQyxFQUFHLFFBQU87QUFDdEIsY0FBTSxLQUFLLGdCQUFnQjtBQUMzQixjQUFNLEdBQUcsK0tBQXFLO0FBQzlLLGNBQU0sU0FBUyxNQUFNLFFBQVEsaUJBQWlCLDhFQUE4RSxHQUFLO0FBQ2pJLGNBQU0sS0FBTSxNQUFNLEdBQUcscUVBQXFFO0FBQzFGLGNBQU0sSUFBSSxLQUFLLE1BQU0sRUFBRTtBQUN2QixjQUFNLFlBQVksRUFBRSxXQUFXLFNBQVMsUUFBUSxFQUFFLFdBQVcsV0FBVztBQUN4RSxlQUFPLENBQUMsT0FBTyxDQUFDLEtBQUssV0FBVyxVQUFVLE9BQU8sQ0FBQyxDQUFDLGNBQWMsS0FBSyxVQUFVLEVBQUUsYUFBYSxJQUFJLENBQUMsRUFBRTtBQUFBLE1BQ3hHLENBQUM7QUFBQSxJQUNIO0FBRUEsVUFBTSxLQUFLLE9BQU87QUFBQSxFQUNwQixZQUFZLFFBQVEsSUFBSSwrQkFBK0IsUUFBUSxJQUFJO0FBR2pFLFFBQUksUUFBUSxJQUFJLGdDQUFnQyxVQUFVO0FBQ3hELFlBQU0sS0FBSyxrSkFBb0MsWUFBWTtBQUN6RCxjQUFNLElBQUksTUFBTSxRQUFRLGtCQUFrQjtBQUFBO0FBQUEsb0dBRThCLElBQU07QUFDOUUsWUFBSSxDQUFDLEVBQUUsQ0FBQyxFQUFHLFFBQU87QUFDbEIsY0FBTSxLQUFLLHFCQUFxQjtBQUNoQyxjQUFNLEdBQUcsMkxBQXVLO0FBQ2hMLGNBQU0sUUFBUSxNQUFNLFFBQVEsZ0JBQWdCO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLHdGQU1vQyxHQUFNO0FBQ3RGLGNBQU0sS0FBSyxvQkFBb0I7QUFDL0IsZUFBTztBQUFBLE1BQ1QsQ0FBQztBQUFBLElBQ0gsV0FBVyxRQUFRLElBQUksZ0NBQWdDLFdBQVc7QUFDaEUsWUFBTSxLQUFLLGlKQUE4QixZQUFZO0FBQ25ELGNBQU0sSUFBSSxNQUFNLFFBQVEsa0JBQWtCO0FBQUEsNkRBQ1csSUFBTTtBQUMzRCxZQUFJLENBQUMsRUFBRSxDQUFDLEVBQUcsUUFBTztBQUNsQixjQUFNLEdBQUcsMkxBQXVLO0FBQ2hMLGNBQU0sUUFBUSxNQUFNLFFBQVEsZ0JBQWdCO0FBQUEsNkxBQzJHLEdBQU07QUFDN0osWUFBSSxDQUFDLE1BQU0sQ0FBQyxFQUFHLFFBQU87QUFDdEIsY0FBTSxHQUFHLCtMQUFpSztBQUMxSyxjQUFNLE1BQU0sR0FBRztBQUNmLGNBQU0sR0FBRyxxTEFBc0s7QUFDL0ssY0FBTSxNQUFNLE1BQU0sUUFBUSx5QkFBb0I7QUFBQTtBQUFBLGlLQUV3RSxHQUFLO0FBQzNILFlBQUksQ0FBQyxJQUFJLENBQUMsRUFBRyxRQUFPO0FBQ3BCLGNBQU0sR0FBRywyTEFBdUs7QUFDaEwsZUFBTyxRQUFRLGdCQUFnQjtBQUFBLHNFQUMrQixHQUFLO0FBQUEsTUFDckUsQ0FBQztBQUNELFlBQU0sS0FBSyx3SUFBK0IsWUFBWTtBQUNwRCxjQUFNLElBQUksTUFBTSxRQUFRLG9CQUFvQjtBQUFBO0FBQUE7QUFBQSwrS0FHMkgsR0FBTTtBQUM3SyxjQUFNLEtBQUsscUJBQXFCO0FBQ2hDLGVBQU87QUFBQSxNQUNULENBQUM7QUFDRCxZQUFNLEtBQUssc01BQWdELFlBQVk7QUFFckUsY0FBTSxRQUFRLGFBQWE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsMERBTWtCLElBQUksR0FBTTtBQUN2RCxjQUFNLElBQUksTUFBTSxRQUFRLG1CQUFtQjtBQUFBO0FBQUEsMEdBRTZDLEdBQU07QUFDOUYsWUFBSSxDQUFDLEVBQUUsQ0FBQyxFQUFHLFFBQU87QUFDbEIsY0FBTSxLQUFLLGtCQUFrQjtBQUM3QixjQUFNLEdBQUcsMkxBQXVLO0FBQ2hMLGNBQU0sWUFBWSxNQUFNLFFBQVEseUJBQXlCO0FBQUE7QUFBQSxtTEFFa0gsR0FBTTtBQUNqTCxjQUFNLEtBQU0sTUFBTSxHQUFHLDZHQUE2RztBQUNsSSxjQUFNLElBQUksS0FBSyxNQUFNLEVBQUU7QUFDdkIsY0FBTSxXQUFXLEVBQUUsZ0JBQWdCLElBQUksUUFBUSxtQkFBbUIsS0FBSztBQUN2RSxjQUFNLEtBQUssbUJBQW1CO0FBQzlCLGVBQU8sQ0FBQyxVQUFVLENBQUMsS0FBSyxTQUFTLGNBQWMsVUFBVSxDQUFDLENBQUMsV0FBVyxHQUFHLE1BQU0sR0FBRyxFQUFFLENBQUMsRUFBRTtBQUFBLE1BQ3pGLENBQUM7QUFBQSxJQUNIO0FBQ0EsVUFBTSxLQUFLLE9BQU87QUFBQSxFQUNwQixPQUFPO0FBRUwsVUFBTSxLQUFLLG1GQUE0QixZQUFZO0FBQ2pELGFBQU8sUUFBUSxjQUFjO0FBQUE7QUFBQSxvSEFFaUYsSUFBTTtBQUFBLElBQ3RILENBQUM7QUFDRCxVQUFNLEtBQUssaUZBQXFCLFlBQVk7QUFDMUMsYUFBTyxRQUFRLFlBQVk7QUFBQSxxREFDb0IsSUFBTTtBQUFBLElBQ3ZELENBQUM7QUFDRCxVQUFNLEtBQUssZ0dBQStCLFlBQVk7QUFDcEQsWUFBTSxJQUFLLE1BQU0sR0FBRyxtREFBbUQ7QUFDdkUsVUFBSSxNQUFNLEVBQUcsUUFBTyxDQUFDLE9BQU8sc0JBQXNCO0FBQ2xELFlBQU0sR0FBRyx1RkFBdUY7QUFDaEcsWUFBTSxJQUFJLE1BQU0sUUFBUSxpQkFBaUI7QUFBQSwrSUFDZ0csSUFBTTtBQUMvSSxZQUFNLEtBQUssY0FBYztBQUN6QixhQUFPO0FBQUEsSUFDVCxDQUFDO0FBQ0QsVUFBTSxLQUFLLHdGQUFzQyxZQUFZO0FBQzNELFlBQU0sR0FBRyx1SkFBdUo7QUFDaEssYUFBTyxRQUFRLFlBQVk7QUFBQTtBQUFBLGtLQUVrSCxHQUFNO0FBQUEsSUFDckosQ0FBQztBQUNELFVBQU0sS0FBSyxxRUFBNkIsWUFBWTtBQUNsRCxZQUFNLEdBQUcsbUxBQXlLO0FBQ2xMLGFBQU8sUUFBUSxRQUFRO0FBQUE7QUFBQSwrR0FFbUUsSUFBTTtBQUFBLElBQ2xHLENBQUM7QUFDRCxVQUFNLEtBQUssc0RBQXdCLFlBQVk7QUFDN0MsWUFBTSxHQUFHLHVMQUE2SztBQUN0TCxhQUFPLFFBQVEsWUFBWTtBQUFBO0FBQUEsa0pBRTRHLElBQU07QUFBQSxJQUMvSSxDQUFDO0FBQ0QsVUFBTSxLQUFLLDhJQUFzQyxZQUFZO0FBQzNELFlBQU0sR0FBRyxvTEFBMEs7QUFDbkwsWUFBTSxRQUFRLGFBQWE7QUFBQSxxSUFDMEYsR0FBSztBQUUxSCxZQUFNLEtBQUssTUFBTSxRQUFRLGFBQWE7QUFBQSxnRkFDb0MsU0FBUyxTQUFTLE9BQVMsR0FBSztBQUMxRyxZQUFNLElBQUssTUFBTSxHQUFHO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxXQUtmO0FBQ0wsWUFBTSxJQUFJLEtBQUssTUFBTSxDQUFDO0FBQ3RCLGFBQU8sQ0FBQyxFQUFFLE1BQU0sRUFBRSxRQUFRLEVBQUUsUUFBUSxhQUFNLEVBQUUsRUFBRSxjQUFTLEVBQUUsSUFBSSxjQUFPLEVBQUUsTUFBTSxLQUFLLEdBQUcsQ0FBQyxDQUFDLEVBQUU7QUFBQSxJQUMxRixDQUFDO0FBSUQsUUFBSSxRQUFRLElBQUksbUNBQW1DLEtBQUs7QUFDdEQsWUFBTSxLQUFLLHVHQUF1QixZQUFZO0FBQzVDLGNBQU0sR0FBRywyRkFBMkY7QUFDcEcsY0FBTSxNQUFNLEdBQUc7QUFDZixjQUFNLFNBQVMsc0JBQXNCLHlLQUFrQztBQUN2RSxjQUFNLE1BQU0sR0FBRztBQUNmLGNBQU0sR0FBRyx5S0FBK0o7QUFDeEssY0FBTSxPQUFPLE1BQU0sUUFBUSxhQUFhO0FBQUE7QUFBQSxvSUFFc0QsR0FBTTtBQUNwRyxZQUFJLENBQUMsS0FBSyxDQUFDLEVBQUcsUUFBTztBQUNyQixjQUFNLFFBQVEsTUFBTSxRQUFRLG1CQUFtQjtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxXQU01QyxJQUFPO0FBQ1YsY0FBTSxLQUFLLFdBQVc7QUFDdEIsZUFBTztBQUFBLE1BQ1QsQ0FBQztBQUFBLElBQ0g7QUFDQSxVQUFNLEtBQUssdUdBQXVCLFlBQVk7QUFDNUMsYUFBTyxRQUFRLGNBQWM7QUFBQTtBQUFBLCtEQUU0QixJQUFNO0FBQUEsSUFDakUsQ0FBQztBQUNELFVBQU0sS0FBSyw2R0FBd0IsWUFBWTtBQUM3QyxhQUFPLFFBQVEsaUJBQWlCO0FBQUE7QUFBQSxtSUFFbUYsSUFBTTtBQUFBLElBQzNILENBQUM7QUFDRCxVQUFNLEtBQUssT0FBTztBQUFBLEVBQ3BCO0FBRUEsUUFBTSxTQUFTLFFBQVEsT0FBTyxDQUFDLE1BQU0sQ0FBQyxFQUFFLENBQUMsQ0FBQyxFQUFFO0FBQzVDLFVBQVEsSUFBSSx5QkFBeUIsUUFBUSxTQUFTLE1BQU0sSUFBSSxRQUFRLE1BQU0sU0FBUyxJQUFJLFVBQVUsS0FBSyxFQUFFO0FBQzVHLE1BQUksS0FBSyxXQUFXLElBQUksSUFBSSxDQUFDO0FBQy9CO0FBRU8sU0FBUyxlQUFlLEtBQTBCO0FBQ3ZELFFBQU0sT0FBTyxRQUFRLElBQUksOEJBQThCLFNBQVMsU0FBUztBQUN6RSxNQUFJLFlBQVksS0FBSyxtQkFBbUIsTUFBTTtBQUU1QyxlQUFXLE1BQU07QUFBRSxXQUFLLFlBQVksS0FBSyxJQUFJO0FBQUEsSUFBRyxHQUFHLEdBQUs7QUFBQSxFQUMxRCxDQUFDO0FBQ0g7OztBQ2pxQkEsU0FBUyxTQUFBQyxjQUFhO0FBQ3RCLFNBQVMsWUFBWSxXQUFXLFFBQVEsWUFBWSxxQkFBcUI7QUFDekUsU0FBUyxlQUFlO0FBQ3hCLFNBQVMsUUFBQUMsYUFBWTs7O0FDTnJCLFNBQVMsa0JBQWtCO0FBeUJwQixTQUFTLFVBQVUsR0FBVyxHQUFtQjtBQUN0RCxRQUFNLEtBQUssRUFBRSxRQUFRLE1BQU0sRUFBRSxFQUFFLE1BQU0sR0FBRyxFQUFFLENBQUMsRUFBRyxNQUFNLEdBQUcsRUFBRSxJQUFJLE1BQU07QUFDbkUsUUFBTSxLQUFLLEVBQUUsUUFBUSxNQUFNLEVBQUUsRUFBRSxNQUFNLEdBQUcsRUFBRSxDQUFDLEVBQUcsTUFBTSxHQUFHLEVBQUUsSUFBSSxNQUFNO0FBQ25FLFdBQVMsSUFBSSxHQUFHLElBQUksR0FBRyxLQUFLO0FBQzFCLFVBQU0sSUFBSSxHQUFHLENBQUMsS0FBSztBQUNuQixVQUFNLElBQUksR0FBRyxDQUFDLEtBQUs7QUFDbkIsUUFBSSxNQUFNLEVBQUcsUUFBTyxJQUFJLElBQUksS0FBSztBQUFBLEVBQ25DO0FBQ0EsU0FBTztBQUNUO0FBR08sU0FBUyxVQUFVLE9BQWUsU0FBMEI7QUFDakUsUUFBTSxJQUFJLE1BQU0sS0FBSztBQUNyQixNQUFJLE1BQU0sTUFBTSxNQUFNLE9BQU8sTUFBTSxZQUFZLE1BQU0sSUFBSyxRQUFPO0FBQ2pFLE1BQUksTUFBTSxRQUFTLFFBQU87QUFDMUIsUUFBTSxRQUFRLG9DQUFvQyxLQUFLLENBQUM7QUFDeEQsTUFBSSxVQUFVLE1BQU07QUFDbEIsVUFBTSxLQUFLLE1BQU0sQ0FBQztBQUNsQixVQUFNLFFBQVEsT0FBTyxNQUFNLENBQUMsQ0FBQztBQUM3QixVQUFNLFFBQVEsT0FBTyxNQUFNLENBQUMsQ0FBQztBQUM3QixVQUFNLFFBQVEsT0FBTyxNQUFNLENBQUMsQ0FBQztBQUM3QixVQUFNLElBQUksVUFBVSxTQUFTLEdBQUcsS0FBSyxJQUFJLEtBQUssSUFBSSxLQUFLLEVBQUU7QUFDekQsUUFBSSxJQUFJLEVBQUcsUUFBTztBQUNsQixRQUFJLE9BQU8sS0FBTSxRQUFPO0FBQ3hCLFFBQUksT0FBTyxJQUFLLFFBQU8sVUFBVSxTQUFTLEdBQUcsS0FBSyxJQUFJLFFBQVEsQ0FBQyxJQUFJLElBQUk7QUFFdkUsUUFBSSxVQUFVLEVBQUcsUUFBTyxVQUFVLElBQUksVUFBVSxTQUFTLE9BQU8sUUFBUSxDQUFDLEVBQUUsSUFBSSxJQUFJLFVBQVUsU0FBUyxLQUFLLFFBQVEsQ0FBQyxJQUFJLElBQUk7QUFDNUgsV0FBTyxVQUFVLFNBQVMsR0FBRyxRQUFRLENBQUMsTUFBTSxJQUFJO0FBQUEsRUFDbEQ7QUFDQSxTQUFPO0FBQ1Q7QUFHTyxTQUFTLFlBQVksS0FBZ0IsTUFBc0I7QUFDaEUsUUFBTSxJQUFJLEtBQUssS0FBSztBQUNwQixRQUFNLE1BQU0sTUFBTSxNQUFNLE1BQU0sWUFBWSxNQUFNLE1BQU0sSUFBSSxXQUFXLEdBQUcsU0FBUztBQUNqRixNQUFJLFFBQVEsVUFBYSxJQUFJLFNBQVMsR0FBRyxNQUFNLE9BQVcsUUFBTztBQUNqRSxNQUFJLElBQUksU0FBUyxDQUFDLE1BQU0sT0FBVyxRQUFPO0FBQzFDLE1BQUksT0FBTztBQUNYLGFBQVcsS0FBSyxPQUFPLEtBQUssSUFBSSxRQUFRLEdBQUc7QUFDekMsUUFBSSxVQUFVLEdBQUcsQ0FBQyxLQUFLLFVBQVUsR0FBRyxJQUFJLElBQUksRUFBRyxRQUFPO0FBQUEsRUFDeEQ7QUFDQSxTQUFPO0FBQ1Q7QUFTQSxlQUFzQixlQUNwQixNQUNBLGNBQ3dCO0FBQ3hCLFFBQU0sV0FBVyxvQkFBSSxJQUE0QjtBQUNqRCxRQUFNLFFBQStDLENBQUMsSUFBSTtBQUMxRCxTQUFPLE1BQU0sU0FBUyxHQUFHO0FBQ3ZCLFVBQU0sRUFBRSxNQUFNLEtBQUssSUFBSSxNQUFNLE1BQU07QUFDbkMsUUFBSSxTQUFTLElBQUksSUFBSSxFQUFHO0FBQ3hCLFVBQU0sTUFBTSxNQUFNLGFBQWEsSUFBSTtBQUNuQyxVQUFNLFVBQVUsWUFBWSxLQUFLLElBQUk7QUFDckMsVUFBTSxPQUFPLFlBQVksS0FBSyxJQUFJLFNBQVMsT0FBTyxJQUFJO0FBQ3RELFFBQUksU0FBUyxVQUFhLEtBQUssTUFBTSxZQUFZLFFBQVc7QUFDMUQsWUFBTSxJQUFJLE1BQU0saUJBQWlCLElBQUksY0FBYyxRQUFRLFFBQVEsRUFBRTtBQUFBLElBQ3ZFO0FBQ0EsVUFBTSxPQUF1QjtBQUFBLE1BQzNCO0FBQUEsTUFDQSxjQUFjLEtBQUssZ0JBQWdCLENBQUM7QUFBQSxNQUNwQyxTQUFTLEtBQUssS0FBSztBQUFBLE1BQ25CLFdBQVcsS0FBSyxLQUFLO0FBQUEsSUFDdkI7QUFDQSxhQUFTLElBQUksTUFBTSxJQUFJO0FBQ3ZCLGVBQVcsQ0FBQyxLQUFLLEtBQUssS0FBSyxPQUFPLFFBQVEsS0FBSyxZQUFZLEdBQUc7QUFDNUQsVUFBSSxDQUFDLFNBQVMsSUFBSSxHQUFHLEVBQUcsT0FBTSxLQUFLLEVBQUUsTUFBTSxLQUFLLE1BQU0sTUFBTSxDQUFDO0FBQUEsSUFDL0Q7QUFBQSxFQUNGO0FBQ0EsU0FBTyxDQUFDLEdBQUcsU0FBUyxRQUFRLENBQUMsRUFBRSxJQUFJLENBQUMsQ0FBQyxNQUFNLENBQUMsT0FBTyxFQUFFLE1BQU0sU0FBUyxFQUFFLFNBQVMsU0FBUyxFQUFFLFNBQVMsV0FBVyxFQUFFLFVBQVUsRUFBRTtBQUM5SDtBQUlBLElBQU0saUJBQWlCO0FBT2hCLFNBQVMsZUFBZSxTQUFpQixZQUFnQztBQUM5RSxRQUFNLElBQUksZUFBZSxLQUFLLE9BQU87QUFDckMsUUFBTSxPQUFPLElBQUksQ0FBQyxLQUFLO0FBQ3ZCLFFBQU0sTUFBTSxDQUFDLE9BQU87QUFDcEIsYUFBVyxPQUFPLFlBQVk7QUFDNUIsVUFBTSxPQUFPLElBQUksUUFBUSxRQUFRLEVBQUU7QUFDbkMsUUFBSSxTQUFTLElBQUksQ0FBQyxFQUFHO0FBQ3JCLFVBQU0sSUFBSSxHQUFHLElBQUksSUFBSSxJQUFJO0FBQ3pCLFFBQUksQ0FBQyxJQUFJLFNBQVMsQ0FBQyxFQUFHLEtBQUksS0FBSyxDQUFDO0FBQUEsRUFDbEM7QUFDQSxTQUFPO0FBQ1Q7QUFHTyxTQUFTLFVBQVUsUUFBZ0IsTUFBc0I7QUFDOUQsUUFBTSxRQUFRLEtBQUssTUFBTSxHQUFHLEVBQUUsT0FBTyxDQUFDLE1BQU0sTUFBTSxNQUFNLE1BQU0sR0FBRztBQUNqRSxNQUFJLEtBQUssV0FBVyxHQUFHLEtBQUssTUFBTSxXQUFXLEVBQUcsT0FBTSxJQUFJLE1BQU0seUJBQXlCLElBQUksRUFBRTtBQUMvRixNQUFJLENBQUMsS0FBSyxXQUFXLEdBQUcsS0FBSyxNQUFNLFdBQVcsRUFBRyxPQUFNLElBQUksTUFBTSx5QkFBeUIsSUFBSSxFQUFFO0FBQ2hHLFNBQU8sQ0FBQyxHQUFHLEtBQUssRUFBRSxPQUFPLENBQUMsS0FBSyxNQUFNLEdBQUcsR0FBRyxLQUFLLENBQUMsSUFBSSxHQUFHLE1BQU0sZ0JBQWdCO0FBQ2hGO0FBS08sU0FBUyxZQUFZLE1BQWMsV0FBNkI7QUFDckUsTUFBSSxjQUFjLFVBQWEsY0FBYyxHQUFJLFFBQU87QUFDeEQsUUFBTSxJQUFJLDZCQUE2QixLQUFLLFVBQVUsS0FBSyxDQUFDO0FBQzVELE1BQUksTUFBTSxLQUFNLFFBQU87QUFDdkIsU0FBTyxXQUFXLFFBQVEsRUFBRSxPQUFPLElBQUksRUFBRSxPQUFPLFFBQVEsTUFBTSxFQUFFLENBQUM7QUFDbkU7QUFHTyxTQUFTLFdBQVcsR0FBbUI7QUFDNUMsTUFBSSxJQUFJLEtBQU0sUUFBTyxHQUFHLENBQUM7QUFDekIsTUFBSSxJQUFJLE9BQU8sS0FBTSxRQUFPLElBQUksSUFBSSxNQUFNLFFBQVEsQ0FBQyxDQUFDO0FBQ3BELFNBQU8sSUFBSSxJQUFJLE9BQU8sTUFBTSxRQUFRLENBQUMsQ0FBQztBQUN4Qzs7O0FEL0hPLElBQU0sYUFBb0Q7QUFBQSxFQUMvRCxPQUFPO0FBQUEsRUFDUCxXQUFXO0FBQ2I7QUFHTyxTQUFTLGdCQUF3QjtBQUN0QyxTQUFPQyxNQUFLLFFBQVEsR0FBRyxtQkFBbUI7QUFDNUM7QUFHTyxTQUFTLHNCQUFzQixRQUF3QjtBQUM1RCxRQUFNLFNBQVNBLE1BQUssUUFBUSxnQkFBZ0IsY0FBYyxPQUFPLGdCQUFnQixjQUFjLE9BQU8sUUFBUSxpQkFBaUI7QUFDL0gsUUFBTSxVQUFVQSxNQUFLLFFBQVEsZ0JBQWdCLGNBQWMsT0FBTyxRQUFRLGlCQUFpQjtBQUMzRixNQUFJLFdBQVcsTUFBTSxFQUFHLFFBQU87QUFDL0IsTUFBSSxXQUFXLE9BQU8sRUFBRyxRQUFPO0FBQ2hDLFNBQU87QUFDVDtBQVNBLElBQUksVUFBVTtBQU9QLFNBQVMsZ0JBQWdCLE1BQXFCLE9BQXVCLENBQUMsR0FBb0M7QUFDL0csTUFBSSxRQUFTLFFBQU8sRUFBRSxJQUFJLE9BQU8sT0FBTyw2Q0FBVTtBQUNsRCxZQUFVO0FBQ1YsUUFBTSxTQUFTLENBQUMsTUFBNkI7QUFDM0MsU0FBSyxhQUFhLENBQUM7QUFDbkIsY0FBVTtBQUFBLEVBQ1o7QUFDQSxRQUFNLE9BQU8sQ0FBQyxNQUFjLFFBQXVCO0FBQ2pELFNBQUssSUFBSSxtQkFBbUIsSUFBSSxJQUFJLE9BQU8sR0FBRyxFQUFFLE1BQU0sR0FBRyxHQUFHLENBQUMsRUFBRTtBQUMvRCxXQUFPLEVBQUUsT0FBTyxTQUFTLE1BQU0sT0FBTyxHQUFHLElBQUksSUFBSSxPQUFPLEdBQUcsRUFBRSxNQUFNLEdBQUcsR0FBRyxDQUFDLEdBQUcsQ0FBQztBQUFBLEVBQ2hGO0FBQ0EsUUFBTSxZQUFZO0FBQ2hCLFVBQU0sU0FBUyxjQUFjO0FBQzdCLFFBQUk7QUFDRixnQkFBVSxRQUFRLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDckMsWUFBTSxRQUFRLEtBQUssYUFBYSxPQUFPLFFBQVEsTUFBTSxTQUFTLElBQUk7QUFDbEUsVUFBSSxNQUFPLE9BQU0sY0FBYyxNQUFNLFFBQVEsSUFBSTtBQUFBLFVBQzVDLE9BQU0sbUJBQW1CLE1BQU0sUUFBUSxJQUFJO0FBQUEsSUFDbEQsU0FBUyxLQUFLO0FBQ1osV0FBSyw0QkFBUSxHQUFHO0FBQUEsSUFDbEI7QUFBQSxFQUNGLEdBQUc7QUFDSCxTQUFPLEVBQUUsSUFBSSxLQUFLO0FBQ3BCO0FBR0EsZUFBZSxTQUFTLE1BQXVDO0FBQzdELE9BQUssYUFBYSxFQUFFLE9BQU8sU0FBUyxNQUFNLHlCQUFVLENBQUM7QUFDckQsUUFBTSxLQUFLLE1BQU0sSUFBSSxRQUFpQixDQUFDQyxhQUFZO0FBQ2pELFVBQU0sSUFBSUMsT0FBTSxPQUFPLENBQUMsV0FBVyxHQUFHLEVBQUUsYUFBYSxNQUFNLE9BQU8sU0FBUyxDQUFDO0FBQzVFLFVBQU0sSUFBSSxXQUFXLE1BQU07QUFBRSxVQUFJO0FBQUUsVUFBRSxLQUFLO0FBQUEsTUFBRyxRQUFRO0FBQUEsTUFBYTtBQUFFLE1BQUFELFNBQVEsS0FBSztBQUFBLElBQUcsR0FBRyxJQUFNO0FBQzdGLE1BQUUsR0FBRyxTQUFTLE1BQU07QUFBRSxtQkFBYSxDQUFDO0FBQUcsTUFBQUEsU0FBUSxLQUFLO0FBQUEsSUFBRyxDQUFDO0FBQ3hELE1BQUUsR0FBRyxRQUFRLENBQUMsU0FBUztBQUFFLG1CQUFhLENBQUM7QUFBRyxNQUFBQSxTQUFRLFNBQVMsQ0FBQztBQUFBLElBQUcsQ0FBQztBQUFBLEVBQ2xFLENBQUM7QUFDRCxPQUFLLElBQUksT0FBTyxLQUFLLGNBQWMsYUFBYSxXQUFNLEtBQUssZUFBZSxLQUFLLE9BQU87QUFDdEYsU0FBTztBQUNUO0FBR0EsZUFBZSxjQUFjLE1BQXFCLFFBQWdCLE1BQXFDO0FBQ3JHLE9BQUssYUFBYSxFQUFFLE9BQU8sT0FBTyxNQUFNLHFDQUFnQyxNQUFNLG1DQUFVLENBQUM7QUFDekYsUUFBTSxXQUFXLEtBQUssZ0JBQWdCLGNBQWMsQ0FBQyxjQUFjLFdBQVcsU0FBUyxJQUFJLEtBQUssZ0JBQWdCLFVBQVUsQ0FBQyxjQUFjLFdBQVcsS0FBSyxJQUFJLENBQUM7QUFDOUosUUFBTSxPQUFPLENBQUMsV0FBVyxZQUFZLFFBQVEsY0FBYyxhQUFhLGNBQWMsVUFBVSxHQUFHLFVBQVUsdUJBQXVCO0FBQ3BJLFFBQU0sT0FBTyxNQUFNLElBQUksUUFBZ0IsQ0FBQ0EsVUFBUyxXQUFXO0FBQzFELFVBQU0sSUFBSUMsT0FBTSxPQUFPLE1BQU0sRUFBRSxhQUFhLE1BQU0sS0FBSyxRQUFRLEVBQUUsQ0FBQztBQUNsRSxRQUFJLE9BQU87QUFDWCxVQUFNLFNBQVMsQ0FBQyxNQUFvQjtBQUNsQyxpQkFBVyxPQUFPLEVBQUUsU0FBUyxFQUFFLE1BQU0sT0FBTyxHQUFHO0FBQzdDLGNBQU0sT0FBTyxJQUFJLFFBQVEsb0JBQW9CLEVBQUUsRUFBRSxLQUFLLEVBQUUsTUFBTSxHQUFHLEdBQUc7QUFDcEUsWUFBSSxTQUFTLE1BQU0sU0FBUyxLQUFNO0FBQ2xDLGVBQU87QUFDUCxhQUFLLGFBQWEsRUFBRSxPQUFPLE9BQU8sTUFBTSxLQUFLLENBQUM7QUFBQSxNQUNoRDtBQUFBLElBQ0Y7QUFDQSxNQUFFLFFBQVEsR0FBRyxRQUFRLE1BQU07QUFDM0IsTUFBRSxRQUFRLEdBQUcsUUFBUSxNQUFNO0FBQzNCLE1BQUUsR0FBRyxTQUFTLE1BQU07QUFDcEIsVUFBTSxTQUFTLFdBQVcsTUFBTTtBQUFFLFVBQUk7QUFBRSxVQUFFLEtBQUs7QUFBQSxNQUFHLFFBQVE7QUFBQSxNQUFhO0FBQUUsYUFBTyxJQUFJLE1BQU0sOENBQWdCLENBQUM7QUFBQSxJQUFHLEdBQUcsSUFBSSxHQUFNO0FBQzNILE1BQUUsR0FBRyxRQUFRLENBQUMsTUFBTTtBQUFFLG1CQUFhLE1BQU07QUFBRyxNQUFBRCxTQUFRLEtBQUssQ0FBQztBQUFBLElBQUcsQ0FBQztBQUFBLEVBQ2hFLENBQUM7QUFDRCxNQUFJLFNBQVMsRUFBRyxPQUFNLElBQUksTUFBTSxrQ0FBbUIsSUFBSSxFQUFFO0FBQ3pELFFBQU0sUUFBUSxzQkFBc0IsTUFBTTtBQUMxQyxNQUFJLFVBQVUsR0FBSSxPQUFNLElBQUksTUFBTSxnRkFBOEI7QUFDaEUsYUFBVyxRQUFRLEtBQUs7QUFDeEIsZ0JBQWMsTUFBTSxPQUFPLEtBQUs7QUFDbEM7QUFHQSxlQUFlLG1CQUFtQixNQUFxQixRQUFnQixNQUFxQztBQUMxRyxRQUFNLFFBQXNDLEtBQUssZ0JBQWdCLGNBQWMsQ0FBQyxhQUFhLE9BQU8sSUFBSSxDQUFDLFNBQVMsV0FBVztBQUM3SCxRQUFNLFVBQVUsTUFBTSxJQUFJLENBQUMsTUFBTSxXQUFXLENBQUMsQ0FBQztBQUM5QyxPQUFLLGFBQWEsRUFBRSxPQUFPLFFBQVEsTUFBTSwwRUFBNkIsQ0FBQztBQUV2RSxRQUFNLGFBQWEsb0JBQUksSUFBdUI7QUFDOUMsUUFBTSxlQUFlLE9BQU8sU0FBcUM7QUFDL0QsVUFBTSxNQUFNLFdBQVcsSUFBSSxJQUFJO0FBQy9CLFFBQUksUUFBUSxPQUFXLFFBQU87QUFDOUIsUUFBSSxVQUFVO0FBQ2QsZUFBVyxLQUFLLFNBQVM7QUFDdkIsVUFBSTtBQUNGLGNBQU0sSUFBSSxNQUFNLE1BQU0sR0FBRyxDQUFDLElBQUksbUJBQW1CLElBQUksQ0FBQyxJQUFJO0FBQUEsVUFDeEQsU0FBUyxFQUFFLFFBQVEsc0NBQXNDO0FBQUEsVUFDekQsUUFBUSxZQUFZLFFBQVEsSUFBTTtBQUFBLFFBQ3BDLENBQUM7QUFDRCxZQUFJLENBQUMsRUFBRSxJQUFJO0FBQUUsb0JBQVUsUUFBUSxFQUFFLE1BQU07QUFBSTtBQUFBLFFBQVU7QUFDckQsY0FBTSxNQUFPLE1BQU0sRUFBRSxLQUFLO0FBQzFCLFlBQUksSUFBSSxhQUFhLFFBQVc7QUFBRSxvQkFBVTtBQUF1QjtBQUFBLFFBQVU7QUFDN0UsbUJBQVcsSUFBSSxNQUFNLEdBQUc7QUFDeEIsZUFBTztBQUFBLE1BQ1QsU0FBUyxLQUFLO0FBQUUsa0JBQVUsT0FBTyxHQUFHLEVBQUUsTUFBTSxHQUFHLEVBQUU7QUFBQSxNQUFHO0FBQUEsSUFDdEQ7QUFDQSxVQUFNLElBQUksTUFBTSxnQkFBTSxJQUFJLDREQUFlLE9BQU8sR0FBRztBQUFBLEVBQ3JEO0FBRUEsUUFBTSxVQUFVLE1BQU0sZUFBZSxFQUFFLE1BQU0sa0JBQWtCLE1BQU0sU0FBUyxHQUFHLFlBQVk7QUFDN0YsUUFBTSxPQUFPLFFBQVEsS0FBSyxDQUFDLE1BQU0sRUFBRSxTQUFTLGdCQUFnQjtBQUM1RCxPQUFLLElBQUksWUFBWSxRQUFRLE1BQU0sa0NBQWtDLE1BQU0sV0FBVyxHQUFHLEdBQUc7QUFDNUYsT0FBSyxhQUFhLEVBQUUsT0FBTyxRQUFRLE1BQU0sd0NBQVUsUUFBUSxNQUFNLGdDQUFzQixNQUFNLFdBQVcsR0FBRyxJQUFJLENBQUM7QUFFaEgsUUFBTSxVQUFVRSxNQUFLLFFBQVEsVUFBVTtBQUN2QyxTQUFPLFNBQVMsRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFDaEQsWUFBVSxTQUFTLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFFdEMsV0FBUyxJQUFJLEdBQUcsSUFBSSxRQUFRLFFBQVEsS0FBSztBQUN2QyxVQUFNLE1BQU0sUUFBUSxDQUFDO0FBQ3JCLFVBQU0sT0FBTyxlQUFlLElBQUksU0FBUyxPQUFPO0FBQ2hELFFBQUksTUFBcUI7QUFDekIsUUFBSSxhQUFhO0FBQ2pCLFFBQUksVUFBVTtBQUNkLGVBQVcsS0FBSyxNQUFNO0FBQ3BCLFVBQUk7QUFDRixjQUFNLElBQUksTUFBTSxNQUFNLEdBQUcsRUFBRSxRQUFRLFlBQVksUUFBUSxHQUFPLEVBQUUsQ0FBQztBQUNqRSxZQUFJLENBQUMsRUFBRSxJQUFJO0FBQUUsb0JBQVUsUUFBUSxFQUFFLE1BQU07QUFBSTtBQUFBLFFBQVU7QUFDckQsY0FBTSxRQUFRLE9BQU8sRUFBRSxRQUFRLElBQUksZ0JBQWdCLEtBQUssR0FBRztBQUMzRCxjQUFNLFNBQVMsRUFBRSxNQUFNLFVBQVU7QUFDakMsWUFBSSxXQUFXLE9BQVcsT0FBTSxJQUFJLE1BQU0sU0FBUztBQUNuRCxjQUFNLFNBQW1CLENBQUM7QUFDMUIsWUFBSSxNQUFNO0FBQ1YsWUFBSSxXQUFXO0FBQ2YsbUJBQVM7QUFDUCxnQkFBTSxFQUFFLE1BQU0sTUFBTSxJQUFJLE1BQU0sT0FBTyxLQUFLO0FBQzFDLGNBQUksU0FBUyxLQUFNO0FBQ25CLGdCQUFNLElBQUksT0FBTyxLQUFLLEtBQUs7QUFDM0IsaUJBQU8sS0FBSyxDQUFDO0FBQ2IsaUJBQU8sRUFBRTtBQUNULGNBQUksTUFBTSxXQUFXLE1BQU0sTUFBTTtBQUMvQix1QkFBVztBQUNYLGlCQUFLLGFBQWE7QUFBQSxjQUNoQixPQUFPO0FBQUEsY0FDUCxLQUFLLEtBQUssT0FBUSxJQUFJLEtBQUssSUFBSSxPQUFPLFNBQVMsTUFBTSxDQUFDLEtBQUssUUFBUSxTQUFVLEdBQUc7QUFBQSxjQUNoRixNQUFNLGdCQUFNLElBQUksSUFBSSxJQUFJLElBQUksT0FBTyxJQUFJLElBQUksQ0FBQyxJQUFJLFFBQVEsTUFBTSxTQUFNLFdBQVcsR0FBRyxDQUFDLEdBQUcsUUFBUSxJQUFJLE1BQU0sV0FBVyxLQUFLLENBQUMsS0FBSyxFQUFFO0FBQUEsY0FDaEksUUFBUSxJQUFJLElBQUksQ0FBQyxFQUFFO0FBQUEsWUFDckIsQ0FBQztBQUFBLFVBQ0g7QUFBQSxRQUNGO0FBQ0EsY0FBTSxPQUFPLE9BQU8sTUFBTTtBQUMxQixZQUFJLENBQUMsWUFBWSxLQUFLLElBQUksU0FBUyxHQUFHO0FBQUUsb0JBQVU7QUFBaUIsZ0JBQU07QUFBTTtBQUFBLFFBQVU7QUFDekYscUJBQWEsSUFBSSxJQUFJLENBQUMsRUFBRTtBQUN4QjtBQUFBLE1BQ0YsU0FBUyxLQUFLO0FBQ1osa0JBQVUsT0FBTyxHQUFHLEVBQUUsTUFBTSxHQUFHLEVBQUU7QUFBQSxNQUNuQztBQUFBLElBQ0Y7QUFDQSxRQUFJLFFBQVEsS0FBTSxPQUFNLElBQUksTUFBTSxnQkFBTSxJQUFJLElBQUksMENBQVksT0FBTyxHQUFHO0FBQ3RFLFVBQU0sTUFBTUEsTUFBSyxTQUFTLEdBQUcsQ0FBQyxNQUFNO0FBQ3BDLGtCQUFjLEtBQUssR0FBRztBQUN0QixTQUFLLGFBQWE7QUFBQSxNQUNoQixPQUFPO0FBQUEsTUFDUCxLQUFLLEtBQUssT0FBUSxJQUFJLEtBQUssUUFBUSxTQUFVLEdBQUc7QUFBQSxNQUNoRCxNQUFNLGdCQUFNLElBQUksSUFBSSxJQUFJLElBQUksT0FBTyxpQkFBTyxXQUFXLElBQUksTUFBTSxDQUFDLFFBQVEsVUFBVTtBQUFBLE1BQ2xGLFFBQVE7QUFBQSxJQUNWLENBQUM7QUFBQSxFQUNIO0FBRUEsT0FBSyxhQUFhLEVBQUUsT0FBTyxXQUFXLE1BQU0sb0RBQXNCLENBQUM7QUFDbkUsV0FBUyxJQUFJLEdBQUcsSUFBSSxRQUFRLFFBQVEsS0FBSztBQUN2QyxVQUFNLE1BQU0sUUFBUSxDQUFDO0FBQ3JCLFVBQU0sV0FBV0EsTUFBSyxTQUFTLEdBQUcsQ0FBQyxNQUFNLEdBQUcsU0FBUyxHQUFHO0FBQ3hELFNBQUssYUFBYSxFQUFFLE9BQU8sV0FBVyxLQUFLLEtBQUssT0FBUSxJQUFJLEtBQUssUUFBUSxTQUFVLEdBQUcsR0FBRyxNQUFNLGdCQUFNLElBQUksSUFBSSxJQUFJLElBQUksQ0FBQyxJQUFJLFFBQVEsTUFBTSxJQUFJLENBQUM7QUFBQSxFQUMvSTtBQUNBLFNBQU8sU0FBUyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUVoRCxRQUFNLFFBQVEsc0JBQXNCLE1BQU07QUFDMUMsTUFBSSxVQUFVLEdBQUksT0FBTSxJQUFJLE1BQU0sZ0ZBQThCO0FBQ2hFLGFBQVcsUUFBUSxLQUFLO0FBQ3hCLGdCQUFjLE1BQU0sT0FBTyxLQUFLO0FBQ2xDO0FBR0EsZUFBZSxXQUFXLEtBQWEsU0FBaUIsS0FBaUM7QUFDdkYsUUFBTSxRQUFRQSxNQUFLLFNBQVMsS0FBSyxJQUFJLEtBQUssUUFBUSxZQUFZLEdBQUcsQ0FBQyxFQUFFO0FBQ3BFLFNBQU8sT0FBTyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUM5QyxZQUFVLE9BQU8sRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNwQyxRQUFNLE9BQU8sTUFBTSxJQUFJLFFBQWdCLENBQUNGLFVBQVMsV0FBVztBQUMxRCxVQUFNLElBQUlDLE9BQU0sT0FBTyxDQUFDLFFBQVEsS0FBSyxNQUFNLEtBQUssR0FBRyxFQUFFLGFBQWEsTUFBTSxPQUFPLFNBQVMsQ0FBQztBQUN6RixNQUFFLEdBQUcsU0FBUyxNQUFNO0FBQ3BCLE1BQUUsR0FBRyxRQUFRLENBQUMsTUFBTUQsU0FBUSxLQUFLLENBQUMsQ0FBQztBQUFBLEVBQ3JDLENBQUM7QUFDRCxNQUFJLFNBQVMsRUFBRyxPQUFNLElBQUksTUFBTSxvQkFBVSxJQUFJLElBQUksb0NBQVcsSUFBSSxHQUFHO0FBQ3BFLFFBQU0sT0FBTyxVQUFVLGNBQWMsR0FBRyxJQUFJLElBQUk7QUFDaEQsUUFBTSxTQUFTLEtBQUssTUFBTSxHQUFHLEtBQUssWUFBWSxJQUFJLENBQUM7QUFDbkQsWUFBVSxRQUFRLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDckMsU0FBTyxNQUFNLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQzdDLGFBQVdFLE1BQUssT0FBTyxTQUFTLEdBQUcsSUFBSTtBQUN2QyxTQUFPLE9BQU8sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFDaEQ7QUFHQSxTQUFTLFdBQVcsUUFBZ0IsS0FBMEI7QUFDNUQsTUFBSTtBQUNGLGtCQUFjQSxNQUFLLFFBQVEsK0JBQStCLEdBQUcsS0FBSyxVQUFVLEVBQUUsS0FBSyxLQUFJLG9CQUFJLEtBQUssR0FBRSxZQUFZLEVBQUUsR0FBRyxNQUFNLENBQUMsR0FBRyxNQUFNO0FBQUEsRUFDckksUUFBUTtBQUFBLEVBQW9CO0FBQzlCO0FBRUEsU0FBUyxjQUFjLE1BQXFCLE9BQWUsS0FBMEI7QUFDbkYsT0FBSyxJQUFJLG9CQUFvQixHQUFHLEtBQUssS0FBSyxFQUFFO0FBQzVDLE9BQUssYUFBYSxFQUFFLE9BQU8sUUFBUSxNQUFNLDRCQUFRLEdBQUcsS0FBSyxNQUFNLENBQUM7QUFDaEUsT0FBSyxZQUFZLE9BQU8sR0FBRztBQUMzQixZQUFVO0FBQ1o7OztBUmxQQSxJQUFNLE9BQU8sWUFBWSxXQUFXO0FBQ3BDLElBQU0sUUFBUSxRQUFRLElBQUksb0JBQW9CO0FBQzlDLElBQU0saUJBQWlCLFFBQVEsSUFBSSw0QkFBNEI7QUFDL0QsSUFBTSxjQUFjQyxNQUFLLE1BQU0sc0JBQXNCO0FBR3JELElBQU0sVUFBb0IsQ0FBQztBQUMzQixTQUFTLE9BQU8sR0FBbUI7QUFDakMsTUFBSSxNQUFNO0FBQ1YsYUFBVyxPQUFPLFNBQVM7QUFDekIsUUFBSSxJQUFJLFVBQVUsRUFBRyxPQUFNLElBQUksTUFBTSxHQUFHLEVBQUUsS0FBSyxZQUFZO0FBQUEsRUFDN0Q7QUFDQSxTQUFPO0FBQ1Q7QUFDQSxTQUFTLFFBQVEsS0FBYSxLQUFtQjtBQUMvQyxVQUFRLElBQUksZ0JBQWdCLEdBQUcsS0FBSyxPQUFPLEdBQUcsQ0FBQyxFQUFFO0FBQ25EO0FBR0EsSUFBSSxDQUFDQyxLQUFJLDBCQUEwQixHQUFHO0FBQ3BDLEVBQUFBLEtBQUksS0FBSztBQUNYLE9BQU87QUE2QkwsTUFBU0MsYUFBVCxTQUFtQixLQUEwQjtBQUMzQyxnQkFBWSxLQUFLLEdBQUc7QUFDcEIsUUFBSSxZQUFZLFNBQVMsSUFBTyxhQUFZLE9BQU8sR0FBRyxZQUFZLFNBQVMsR0FBSztBQUNoRixRQUFJLGVBQWUsTUFBTTtBQUN2QixtQkFBYSxXQUFXLE1BQU07QUFDNUIscUJBQWE7QUFDYixjQUFNLFFBQVE7QUFDZCxzQkFBYyxDQUFDO0FBQ2YsbUJBQVcsS0FBSyxjQUFjLGNBQWMsR0FBRztBQUM3QyxjQUFJLENBQUMsRUFBRSxZQUFZLEVBQUcsR0FBRSxZQUFZLEtBQUssc0JBQXNCLEtBQUs7QUFBQSxRQUN0RTtBQUFBLE1BQ0YsR0FBRyxFQUFFO0FBQUEsSUFDUDtBQUNBLElBQUFDLGFBQVksR0FBRztBQUFBLEVBQ2pCLEdBV1NDLG1CQUFULFdBQWlDO0FBQy9CLFVBQU0sTUFBTSxjQUFjLGNBQWMsRUFBRSxLQUFLLENBQUMsTUFBTSxDQUFDLEVBQUUsWUFBWSxDQUFDO0FBQ3RFLFFBQUksUUFBUSxPQUFXO0FBQ3ZCLFFBQUksSUFBSSxZQUFZLEVBQUcsS0FBSSxRQUFRO0FBQ25DLFFBQUksS0FBSztBQUNULFFBQUksTUFBTTtBQUFBLEVBQ1osR0FDU0MsYUFBVCxXQUEyQjtBQUN6QixRQUFJLFNBQVMsS0FBTTtBQUNuQixVQUFNLE9BQU8sWUFBWSxrQkFBa0IseUJBQXlCLGdCQUFnQixFQUFFO0FBQ3RGLFdBQU8sSUFBSSxLQUFLLElBQUk7QUFDcEIsU0FBSyxXQUFXLGFBQWE7QUFDN0IsU0FBSyxHQUFHLFNBQVNELGdCQUFlO0FBQ2hDLFNBQUssZUFBZSxLQUFLLGtCQUFrQjtBQUFBLE1BQ3pDLEVBQUUsT0FBTyw0QkFBUSxPQUFPLE1BQVksZUFBZSxhQUFhLEVBQUU7QUFBQSxNQUNsRSxFQUFFLE9BQU8sa0NBQVMsT0FBT0EsaUJBQWdCO0FBQUEsTUFDekMsRUFBRSxPQUFPLHdDQUFVLE9BQU8sTUFBWSxlQUFlLGFBQWEsRUFBRTtBQUFBLE1BQ3BFLEVBQUUsT0FBTyxnQkFBTSxPQUFPLE1BQVksZUFBZSxlQUFlLEVBQUU7QUFBQSxNQUNsRSxFQUFFLE1BQU0sWUFBWTtBQUFBLE1BQ3BCLEVBQUUsT0FBTyxnQkFBTSxPQUFPLE1BQVk7QUFBRSxRQUFBSCxLQUFJLEtBQUs7QUFBQSxNQUFHLEVBQUU7QUFBQSxJQUNwRCxDQUFDLENBQUM7QUFBQSxFQUNKLEdBQ1NFLGVBQVQsU0FBcUIsS0FBMEI7QUFFN0MsUUFBSSxRQUFRLElBQUkseUJBQXlCLE9BQU8sUUFBUSxJQUFJLHlCQUF5QixVQUFhLFFBQVEsSUFBSSw0QkFBNEIsSUFBSztBQUMvSSxRQUFJLENBQUMsYUFBYSxZQUFZLEVBQUc7QUFDakMsVUFBTSxNQUFNLGNBQWMsY0FBYyxFQUFFLEtBQUssQ0FBQyxNQUFNLENBQUMsRUFBRSxZQUFZLENBQUM7QUFDdEUsVUFBTSxVQUFVLEtBQUssVUFBVSxLQUFLO0FBQ3BDLFVBQU0sS0FBSyxDQUFDLE9BQWUsU0FBdUI7QUFDaEQsWUFBTSxJQUFJLElBQUksYUFBYSxFQUFFLE9BQU8sTUFBTSxNQUFNLFlBQVksa0JBQWtCLHlCQUF5QixnQkFBZ0IsRUFBRSxFQUFFLENBQUM7QUFDNUgsUUFBRSxHQUFHLFNBQVNDLGdCQUFlO0FBQzdCLFFBQUUsS0FBSztBQUFBLElBQ1Q7QUFDQSxRQUFJLElBQUksU0FBUyxxQkFBcUI7QUFDcEMsWUFBTSxJQUFJLElBQUk7QUFDZCxTQUFHLGdDQUFZLEdBQUcsT0FBTyxFQUFFLFFBQVEsY0FBSSxDQUFDLHVDQUFTO0FBQUEsSUFDbkQsV0FBVyxJQUFJLFNBQVMsbUJBQW1CLENBQUMsU0FBUztBQUNuRCxTQUFHLGdDQUFZLGdCQUFNLElBQUksU0FBUyx1Q0FBUztBQUFBLElBQzdDLFdBQVcsSUFBSSxTQUFTLGdCQUFnQixDQUFDLFNBQVM7QUFDaEQsU0FBRyxnQ0FBWSxnQkFBTSxJQUFJLFNBQVMsMERBQWE7QUFBQSxJQUNqRDtBQUFBLEVBQ0YsR0FTU0UsZUFBVCxTQUFxQixNQUFxQjtBQUN4QyxlQUFXLEtBQUssY0FBYyxjQUFjLEdBQUc7QUFDN0MsVUFBSSxDQUFDLEVBQUUsWUFBWSxHQUFHO0FBQ3BCLFlBQUk7QUFBRSxZQUFFLG1CQUFtQixVQUFVLElBQUksQ0FBQztBQUFBLFFBQUcsUUFBUTtBQUFBLFFBQXFCO0FBQUEsTUFDNUU7QUFBQSxJQUNGO0FBQUEsRUFDRixHQW9GU0MsZUFBVCxXQUE2QjtBQUMzQixRQUFJLGtCQUFrQixLQUFNO0FBSzVCLFVBQU0sYUFBYSxRQUFRLFFBQVEsUUFBUTtBQUMzQyxVQUFNLFFBQVFDLE9BQU0sSUFBSSxhQUFhLFdBQVcsVUFBVSxJQUFJO0FBQUEsTUFDNUQsVUFBVTtBQUFBLE1BQ1YsT0FBTztBQUFBLE1BQ1AsYUFBYTtBQUFBLE1BQ2IsT0FBTztBQUFBLE1BQ1AsMEJBQTBCO0FBQUEsSUFDNUIsQ0FBQztBQUNELFVBQU0sTUFBTTtBQUNaLFlBQVEsVUFBVSxVQUFVLGFBQWEsV0FBTSxVQUFVLEVBQUU7QUFDM0QsSUFBQVAsS0FBSSxLQUFLLENBQUM7QUFBQSxFQUNaLEdBRVNRLGdCQUFULFdBQThCO0FBRTVCLFVBQU0sV0FBdUQ7QUFBQSxNQUMzRDtBQUFBLFFBQ0UsT0FBTztBQUFBLFFBQ1AsU0FBUztBQUFBLFVBQ1AsRUFBRSxNQUFNLFFBQVEsT0FBTyxlQUFLO0FBQUEsVUFDNUIsRUFBRSxNQUFNLFFBQVEsT0FBTyxlQUFLO0FBQUEsVUFDNUIsRUFBRSxNQUFNLFlBQVk7QUFBQSxVQUNwQixFQUFFLE1BQU0sT0FBTyxPQUFPLGVBQUs7QUFBQSxVQUMzQixFQUFFLE1BQU0sUUFBUSxPQUFPLGVBQUs7QUFBQSxVQUM1QixFQUFFLE1BQU0sU0FBUyxPQUFPLGVBQUs7QUFBQSxVQUM3QixFQUFFLE1BQU0sYUFBYSxPQUFPLGVBQUs7QUFBQSxRQUNuQztBQUFBLE1BQ0Y7QUFBQSxNQUNBO0FBQUEsUUFDRSxPQUFPO0FBQUEsUUFDUCxTQUFTO0FBQUEsVUFDUCxFQUFFLE1BQU0sWUFBWSxPQUFPLHFCQUFNO0FBQUEsVUFDakMsRUFBRSxNQUFNLFFBQVEsT0FBTyxlQUFLO0FBQUEsVUFDNUIsRUFBRSxNQUFNLFlBQVk7QUFBQSxVQUNwQixFQUFFLE1BQU0sU0FBUyxPQUFPLGVBQUs7QUFBQSxRQUMvQjtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBQ0EsU0FBSyxtQkFBbUIsS0FBSyxrQkFBa0IsUUFBUSxDQUFDO0FBQUEsRUFDMUQsR0FFU0MsaUJBQVQsV0FBK0I7QUFDN0IsVUFBTSxPQUFPLENBQUMsTUFBb0I7QUFDaEMsaUJBQVcsS0FBSyxjQUFjLGNBQWMsR0FBRztBQUM3QyxZQUFJLENBQUMsRUFBRSxZQUFZLEVBQUcsR0FBRSxZQUFZLEtBQUssZUFBZSxDQUFDO0FBQUEsTUFDM0Q7QUFBQSxJQUNGO0FBQ0EsVUFBTSxNQUFNLGNBQWMsY0FBYyxFQUFFLEtBQUssQ0FBQyxNQUFNLENBQUMsRUFBRSxZQUFZLENBQUM7QUFDdEUsUUFBSSxRQUFRLE9BQVc7QUFDdkIsU0FBSyxrQkFBa0I7QUFBQSxNQUNyQixFQUFFLE9BQU8sNEJBQVEsYUFBYSxlQUFlLE9BQU8sTUFBWSxLQUFLLGFBQWEsRUFBRTtBQUFBLE1BQ3BGLEVBQUUsT0FBTyxnQkFBTSxhQUFhLHFCQUFxQixPQUFPLE1BQVksS0FBSyxlQUFlLEVBQUU7QUFBQSxNQUMxRixFQUFFLE9BQU8sc0JBQU8sYUFBYSxlQUFlLE9BQU8sTUFBWSxLQUFLLFdBQVcsRUFBRTtBQUFBLE1BQ2pGLEVBQUUsTUFBTSxZQUFZO0FBQUEsTUFDcEIsRUFBRSxPQUFPLHdDQUFVLE9BQU8sTUFBWSxLQUFLLGFBQWEsRUFBRTtBQUFBLE1BQzFELEVBQUUsTUFBTSxZQUFZO0FBQUEsTUFDcEI7QUFBQSxRQUNFLE9BQU8sWUFBWSxhQUFhLCtDQUFZLFlBQVksVUFBVSxHQUFHLE1BQU07QUFBQSxRQUMzRSxPQUFPLE1BQVk7QUFDakIsY0FBSSxZQUFZLFlBQVk7QUFBRSxZQUFBSCxhQUFZO0FBQUc7QUFBQSxVQUFRO0FBQ3JELGVBQUssZ0JBQWdCLEVBQUUsS0FBSyxDQUFDLE9BQU87QUFDbEMsa0JBQU0sUUFBUSxHQUFHLFdBQVcsUUFBUSxXQUFXLEdBQUcsZ0JBQWdCLEdBQUcsTUFBTSxJQUFJO0FBQy9FLGtCQUFNLFNBQVMsUUFBUSxHQUFHLEdBQUcsS0FBSztBQUFBO0FBQUEscUtBQXdDO0FBQzFFLGlCQUFLLE9BQU8sZUFBZSxLQUFLO0FBQUEsY0FDOUIsTUFBTTtBQUFBLGNBQ04sT0FBTztBQUFBLGNBQ1AsU0FBUyxRQUNMLG1DQUFVLEdBQUcsTUFBTSxNQUNsQixHQUFHLFVBQVUsS0FBSyw0QkFBUSxHQUFHLEtBQUssS0FBSyx5Q0FBVyxHQUFHLGNBQWM7QUFBQSxjQUN4RTtBQUFBLFlBQ0YsQ0FBQztBQUFBLFVBQ0gsQ0FBQztBQUFBLFFBQ0g7QUFBQSxNQUNGO0FBQUEsTUFDQTtBQUFBLFFBQ0UsT0FBTztBQUFBLFFBQ1AsT0FBTyxNQUFZO0FBQ2pCLGVBQUssT0FBTyxlQUFlLEtBQUs7QUFBQSxZQUM5QixNQUFNO0FBQUEsWUFDTixPQUFPO0FBQUEsWUFDUCxTQUFTO0FBQUEsWUFDVCxRQUFRLDRFQUEwQk4sS0FBSSxXQUFXLENBQUM7QUFBQSxxQkFBd0IsT0FBTyxlQUFlLHNCQUFPLEdBQUcsb0JBQW9CLG1CQUFTLEVBQUU7QUFBQSxnQkFBUyxPQUFPLFNBQVMsU0FBVSxvQkFBb0IsaURBQTZCLHFEQUF3QixrQ0FBUztBQUFBO0FBQUE7QUFBQSxVQUNoUSxDQUFDO0FBQUEsUUFDSDtBQUFBLE1BQ0Y7QUFBQSxNQUNBLEVBQUUsT0FBTyxnQkFBTSxNQUFNLE9BQU87QUFBQSxJQUM5QixDQUFDLEVBQUUsTUFBTSxFQUFFLFFBQVEsSUFBSSxDQUFDO0FBQUEsRUFDMUIsR0FjU1UseUJBQVQsV0FBMEM7QUFDeEMsVUFBTSxPQUFPLFFBQVEsSUFBSSxRQUFRO0FBQ2pDLFVBQU0sYUFBYSxRQUFRLGFBQWEsVUFDcEMsQ0FBQ1gsTUFBSyxRQUFRLElBQUksV0FBVyxJQUFJLGFBQWEsV0FBVyxjQUFjLFlBQVksV0FBVywwQkFBMEIsQ0FBQyxJQUN6SCxRQUFRLGFBQWEsV0FDbkIsQ0FBQ0EsTUFBSyxNQUFNLFdBQVcsZ0JBQWdCLDRCQUE0QixDQUFDLElBQ3BFLENBQUNBLE1BQUssTUFBTSxXQUFXLFdBQVcsUUFBUSw4QkFBOEIsQ0FBQztBQUMvRSxXQUFPLFdBQVcsS0FBSyxDQUFDLE1BQU07QUFBRSxVQUFJO0FBQUUsZUFBT1ksWUFBVyxDQUFDO0FBQUEsTUFBRyxRQUFRO0FBQUUsZUFBTztBQUFBLE1BQU87QUFBQSxJQUFFLENBQUM7QUFBQSxFQUN6RixHQUVTQyxXQUFULFdBQTJCO0FBQ3pCLFVBQU0sVUFBVTtBQUNoQixVQUFNLFlBQVksQ0FBQyxNQUF1QixRQUFRLEtBQUssQ0FBQyxLQUFLLGNBQWMsS0FBSyxDQUFDLEtBQUssNkJBQTZCLEtBQUssQ0FBQztBQUN6SCxRQUFJLFFBQVE7QUFDWixRQUFJLFdBQVc7QUFDZixlQUFXLENBQUMsTUFBTSxJQUFJLEtBQUssT0FBTyxRQUFRLGtCQUFrQixDQUFDLEdBQUc7QUFDOUQsaUJBQVcsS0FBSyxRQUFRLENBQUMsR0FBRztBQUMxQixZQUFJLEVBQUUsV0FBVyxVQUFVLEVBQUUsWUFBWSxDQUFDLFVBQVUsRUFBRSxPQUFPLEVBQUc7QUFDaEUsWUFBSSxDQUFDLFFBQVEsS0FBSyxJQUFJLEVBQUcsU0FBUSxTQUFTLEVBQUU7QUFBQSxZQUN2QyxZQUFXLFlBQVksRUFBRTtBQUFBLE1BQ2hDO0FBQUEsSUFDRjtBQUNBLFdBQU8sU0FBUztBQUFBLEVBQ2xCLEdBR1NDLGNBQVQsV0FBOEI7QUFDNUIsUUFBSSxpQkFBaUIsTUFBTSxpQkFBaUIsS0FBTSxRQUFPO0FBQ3pELFFBQUk7QUFDRixZQUFNLElBQUlkLE1BQUtlLFlBQVcsWUFBWSxHQUFHLFlBQVksT0FBTyxPQUFPLFNBQVM7QUFDNUUsVUFBSUgsWUFBVyxDQUFDLEVBQUcsUUFBTztBQUFBLElBQzVCLFFBQVE7QUFBQSxJQUFrQjtBQUMxQixRQUFJLE1BQU0sUUFBUSxZQUFZO0FBQzlCLGFBQVMsSUFBSSxHQUFHLElBQUksR0FBRyxLQUFLO0FBQzFCLFVBQUlBLFlBQVdaLE1BQUssS0FBSyxRQUFRLFNBQVMsQ0FBQyxLQUFLZ0IsV0FBVSxHQUFHLE1BQU0saUJBQWtCLFFBQU9oQixNQUFLLEtBQUssUUFBUSxTQUFTO0FBQ3ZILFVBQUksU0FBUyxHQUFHLE1BQU0sZ0JBQWdCWSxZQUFXWixNQUFLLEtBQUssT0FBTyxRQUFRLFNBQVMsQ0FBQyxFQUFHLFFBQU9BLE1BQUssS0FBSyxPQUFPLFFBQVEsU0FBUztBQUNoSSxZQUFNLFNBQVMsUUFBUSxHQUFHO0FBQzFCLFVBQUksV0FBVyxJQUFLO0FBQ3BCLFlBQU07QUFBQSxJQUNSO0FBQ0EsV0FBTztBQUFBLEVBQ1QsR0FDU2lCLFVBQVQsU0FBZ0IsTUFBc0I7QUFDcEMsVUFBTSxRQUFRSCxZQUFXO0FBQ3pCLFFBQUksVUFBVSxHQUFJO0FBQ2xCLFVBQU0sT0FBTyxNQUFNLFNBQVMsS0FBSztBQUNqQyxVQUFNLE9BQU9DLFlBQVcsZ0JBQWdCLEtBQUs7QUFDN0MsVUFBTSxRQUFRUCxPQUFNLFFBQVEsVUFBVSxPQUFPLENBQUMsWUFBWSxPQUFPLE9BQU8sR0FBRyxJQUFJLElBQUksQ0FBQyxPQUFPLEdBQUcsSUFBSSxHQUFHO0FBQUEsTUFDbkcsS0FBSyxPQUFPLE9BQU8sUUFBUSxLQUFLO0FBQUEsTUFDaEMsVUFBVTtBQUFBLE1BQ1YsT0FBTztBQUFBLE1BQ1AsYUFBYTtBQUFBLE1BQ2IsS0FBSyxFQUFFLHNCQUFzQixJQUFJO0FBQUEsSUFDbkMsQ0FBQztBQUNELFVBQU0sTUFBTTtBQUFBLEVBQ2QsR0FFU1Usc0JBQVQsU0FBNEIsR0FBYyxNQUEwRDtBQUNsRyxhQUFTLEVBQUUsR0FBRyxRQUFRLFdBQVcsR0FBRyxVQUFVLFlBQVksVUFBVSxRQUFRLE1BQU0sYUFBYSxZQUFZLFVBQVUsV0FBVyxLQUFLO0FBQ3JJLFlBQVEsUUFBUSxTQUFTLENBQUMsR0FBRyxLQUFLLGNBQWMsU0FBWSxRQUFRLEtBQUssU0FBUyxLQUFLLEVBQUUsRUFBRTtBQUMzRixlQUFXLEtBQUssY0FBYyxjQUFjLEdBQUc7QUFDN0MsVUFBSSxDQUFDLEVBQUUsWUFBWSxFQUFHLEdBQUUsWUFBWSxLQUFLLHFCQUFxQixHQUFHLElBQUk7QUFBQSxJQUN2RTtBQUFBLEVBQ0YsR0FxRVNDLGdCQUFULFNBQXNCLEtBQXFCO0FBQ3pDLFFBQUk7QUFDRixZQUFNLElBQUksS0FBSyxNQUFNLGFBQWFuQixNQUFLLEtBQUssY0FBYyxHQUFHLE1BQU0sQ0FBQztBQUNwRSxhQUFPLE9BQU8sRUFBRSxZQUFZLFdBQVcsRUFBRSxVQUFVO0FBQUEsSUFDckQsUUFBUTtBQUFFLGFBQU87QUFBQSxJQUFJO0FBQUEsRUFDdkIsR0FFU2dCLGFBQVQsU0FBbUIsS0FBcUI7QUFDdEMsUUFBSTtBQUNGLFlBQU0sSUFBSSxLQUFLLE1BQU0sYUFBYWhCLE1BQUssS0FBSyxjQUFjLEdBQUcsTUFBTSxDQUFDO0FBQ3BFLGFBQU8sT0FBTyxFQUFFLFNBQVMsV0FBVyxFQUFFLE9BQU87QUFBQSxJQUMvQyxRQUFRO0FBQUUsYUFBTztBQUFBLElBQUk7QUFBQSxFQUN2QixHQUdTb0IsbUJBQVQsU0FBeUIsUUFBd0I7QUFDL0MsVUFBTSxTQUFTcEIsTUFBSyxRQUFRLGdCQUFnQixjQUFjLE9BQU8sUUFBUSxpQkFBaUI7QUFDMUYsUUFBSVksWUFBVyxNQUFNLEVBQUcsUUFBTztBQUMvQixVQUFNLFVBQVVaLE1BQUssUUFBUSxNQUFNLEdBQUcsT0FBTyxRQUFRLGlCQUFpQjtBQUN0RSxRQUFJWSxZQUFXLE9BQU8sRUFBRyxRQUFPO0FBQ2hDLFdBQU87QUFBQSxFQUNULEdBS1NTLHlCQUFULFdBQWtEO0FBRWhELFVBQU0sV0FBVyxRQUFRLElBQUk7QUFDN0IsUUFBSSxhQUFhLFVBQWEsYUFBYSxNQUFNLFdBQVcsUUFBUSxHQUFHO0FBQ3JFLGFBQU8sRUFBRSxPQUFPLFVBQVUsU0FBUyxJQUFJLFFBQVEsTUFBTTtBQUFBLElBQ3ZEO0FBRUEsVUFBTSxhQUFhLG9CQUFJLElBQVk7QUFDbkMsVUFBTSxZQUFzQixDQUFDO0FBQzdCLFVBQU0sV0FBVyxvQkFBSSxJQUFZO0FBQ2pDLFFBQUksU0FBUztBQUViLFFBQUk7QUFDRixZQUFNLE1BQU0sYUFBYSxTQUFTLENBQUMsS0FBSyxHQUFHLEVBQUUsVUFBVSxRQUFRLFNBQVMsS0FBTyxhQUFhLEtBQUssQ0FBQztBQUNsRyxpQkFBVyxRQUFRLElBQUksTUFBTSxPQUFPLEdBQUc7QUFDckMsY0FBTSxNQUFNLEtBQUssS0FBSztBQUN0QixZQUFJLFFBQVEsR0FBSTtBQUNoQixZQUFJO0FBQ0YsZ0JBQU0sU0FBUyxRQUFRLEdBQUc7QUFDMUIsZ0JBQU0sU0FBU3JCLE1BQUssUUFBUSxnQkFBZ0IsV0FBVztBQUN2RCxjQUFJWSxZQUFXLE1BQU0sRUFBRyxZQUFXLElBQUlVLGNBQWEsTUFBTSxDQUFDO0FBQzNELGdCQUFNLE1BQU10QixNQUFLLFFBQVEsZ0JBQWdCLGNBQWMsS0FBSztBQUM1RCxjQUFJWSxZQUFXLEdBQUcsRUFBRyxXQUFVLEtBQUssR0FBRztBQUFBLFFBQ3pDLFFBQVE7QUFBQSxRQUFvQjtBQUFBLE1BQzlCO0FBQUEsSUFDRixRQUFRO0FBQUEsSUFBb0I7QUFFNUIsUUFBSTtBQUNGLFlBQU0sTUFBTSxhQUFhLE9BQU8sQ0FBQyxRQUFRLElBQUksR0FBRyxFQUFFLFVBQVUsUUFBUSxTQUFTLEtBQU8sYUFBYSxLQUFLLENBQUM7QUFDdkcsWUFBTSxPQUFPLElBQUksS0FBSztBQUN0QixZQUFNLFNBQVNaLE1BQUssTUFBTSxXQUFXO0FBQ3JDLFVBQUlZLFlBQVcsTUFBTSxFQUFHLFVBQVMsSUFBSVUsY0FBYSxNQUFNLENBQUM7QUFDekQsWUFBTSxNQUFNdEIsTUFBSyxNQUFNLGNBQWMsS0FBSztBQUMxQyxVQUFJWSxZQUFXLEdBQUcsRUFBRyxVQUFTO0FBQUEsSUFDaEMsUUFBUTtBQUFBLElBQWdCO0FBSXhCLGVBQVcsQ0FBQyxLQUFLLE1BQU0sS0FBSyxDQUFDLENBQUMsVUFBVSxDQUFDLEtBQUssSUFBSSxXQUFXLEdBQUcsQ0FBQyxRQUFRLFlBQVksQ0FBQyxHQUE4QjtBQUNsSCxVQUFJLFFBQVEsR0FBSTtBQUNoQixZQUFNLFFBQVFRLGlCQUFnQixHQUFHO0FBQ2pDLFVBQUksVUFBVSxHQUFJLFFBQU8sRUFBRSxPQUFPLFNBQVNELGNBQWEsR0FBRyxHQUFHLE9BQU87QUFBQSxJQUN2RTtBQUNBLFVBQU0sY0FBYyxzQkFBc0IsY0FBYyxDQUFDO0FBQ3pELFFBQUksZ0JBQWdCLElBQUk7QUFDdEIsYUFBTyxFQUFFLE9BQU8sYUFBYSxTQUFTQSxjQUFhbkIsTUFBSyxjQUFjLEdBQUcsZ0JBQWdCLGNBQWMsS0FBSyxDQUFDLEdBQUcsUUFBUSxpQkFBaUI7QUFBQSxJQUMzSTtBQUdBLFVBQU0sUUFBUSxvQkFBSSxJQUFZLENBQUMsR0FBRyxZQUFZLEdBQUcsUUFBUSxDQUFDO0FBQzFELFVBQU0sUUFBUSxDQUFDLFFBQVEsUUFBUSxRQUFRLFFBQVEsUUFBUSxRQUFRdUIsU0FBUSxHQUFHdkIsTUFBS3VCLFNBQVEsR0FBRyxXQUFXLENBQUM7QUFDdEcsZUFBVyxRQUFRLE9BQU87QUFDeEIsVUFBSTtBQUNGLGNBQU0sSUFBSSxRQUFRLE1BQU0sV0FBVztBQUNuQyxZQUFJWCxZQUFXLENBQUMsRUFBRyxPQUFNLElBQUksQ0FBQztBQUFBLE1BQ2hDLFFBQVE7QUFBQSxNQUFhO0FBQUEsSUFDdkI7QUFDQSxlQUFXLFFBQVEsT0FBTztBQUN4QixZQUFNLFFBQVFaLE1BQUssTUFBTSxZQUFZLE9BQU8sT0FBTyxpQkFBaUI7QUFDcEUsVUFBSVksWUFBVyxLQUFLLEtBQUtBLFlBQVdaLE1BQUssTUFBTSxjQUFjLENBQUMsR0FBRztBQUMvRCxlQUFPLEVBQUUsT0FBTyxTQUFTbUIsY0FBYSxJQUFJLEdBQUcsUUFBUSxjQUFjO0FBQUEsTUFDckU7QUFBQSxJQUNGO0FBQ0EsV0FBTyxFQUFFLE9BQU8sSUFBSSxTQUFTLElBQUksUUFBUSxHQUFHO0FBQUEsRUFDOUMsR0FFU0ssbUJBQVQsV0FBbUM7QUFDakMsV0FBT0gsdUJBQXNCLEVBQUU7QUFBQSxFQUNqQyxHQUdTTixjQUFULFNBQW9CLE9BQXVCO0FBQ3pDLFFBQUksTUFBTSxRQUFRLEtBQUs7QUFDdkIsYUFBUyxJQUFJLEdBQUcsSUFBSSxHQUFHLEtBQUs7QUFDMUIsVUFBSUgsWUFBV1osTUFBSyxLQUFLLGNBQWMsQ0FBQyxLQUFLWSxZQUFXWixNQUFLLEtBQUssWUFBWSxLQUFLLENBQUMsRUFBRyxRQUFPO0FBQzlGLFlBQU0sU0FBUyxRQUFRLEdBQUc7QUFDMUIsVUFBSSxXQUFXLElBQUs7QUFDcEIsWUFBTTtBQUFBLElBQ1I7QUFDQSxXQUFPLFFBQVEsS0FBSztBQUFBLEVBQ3RCLEdBUVN5QixzQkFBVCxTQUE0QixVQUEwQjtBQUNwRCxXQUFPekIsTUFBS0MsS0FBSSxhQUFhLFFBQVEsZ0JBQWdCRCxNQUFLLFVBQVUsUUFBUSxXQUFXLFdBQVcsR0FBRyxXQUFXLGFBQWE7QUFBQSxFQUMvSCxHQUdTMEIsc0JBQVQsV0FBbUU7QUFDakUsVUFBTSxXQUFXMUIsTUFBSyxNQUFNLE1BQU0sTUFBTSxNQUFNLElBQUk7QUFDbEQsVUFBTSxJQUFJeUIsb0JBQW1CLFFBQVE7QUFDckMsUUFBSSxVQUFVO0FBQ2QsUUFBSTtBQUNGLFlBQU0sSUFBSSxLQUFLLE1BQU0sYUFBYXpCLE1BQUssUUFBUSxDQUFDLEdBQUcsY0FBYyxHQUFHLE1BQU0sQ0FBQztBQUMzRSxnQkFBVSxPQUFPLEVBQUUsWUFBWSxXQUFXLEVBQUUsVUFBVTtBQUFBLElBQ3hELFFBQVE7QUFBQSxJQUF1QjtBQUMvQixXQUFPLEVBQUUsT0FBT1ksWUFBVyxDQUFDLEdBQUcsUUFBUTtBQUFBLEVBQ3pDLEdBR1NlLGFBQVQsV0FBOEI7QUFDNUIsUUFBSTtBQUNGLG1CQUFhLFNBQVMsQ0FBQyxLQUFLLEdBQUcsRUFBRSxVQUFVLFFBQVEsU0FBUyxLQUFPLGFBQWEsS0FBSyxDQUFDO0FBQ3RGLGFBQU87QUFBQSxJQUNULFFBQVE7QUFBRSxhQUFPO0FBQUEsSUFBTztBQUFBLEVBQzFCLEdBZVNDLG9CQUFULFdBQXFDO0FBQ25DLFFBQUksUUFBUSxJQUFJLDZCQUE2QixJQUFLLFFBQU87QUFDekQsV0FBTyxTQUNGLFFBQVEsSUFBSSx5QkFBeUIsT0FDckMsUUFBUSxJQUFJLHlCQUF5QixVQUNyQyxRQUFRLElBQUksNEJBQTRCLE9BQ3hDLFFBQVEsSUFBSSx5QkFBeUIsT0FDckMsUUFBUSxJQUFJLDhCQUE4QixPQUMxQyxRQUFRLElBQUkscUJBQXFCO0FBQUEsRUFDeEMsR0EwR1NDLGlCQUFULFNBQXVCLGFBQWdFO0FBQ3JGLFFBQUksZ0JBQWdCLFFBQVEsZ0JBQWdCLE9BQVcsUUFBTztBQUM5RCxRQUFJLE1BQW9DO0FBQ3hDLFdBQU8sS0FBSyxXQUFXLFFBQVEsS0FBSyxXQUFXLE9BQVcsT0FBTSxJQUFJO0FBQ3BFLFVBQU0sTUFBTSxLQUFLLE9BQU87QUFDeEIsZUFBVyxVQUFVLGdCQUFnQjtBQUNuQyxVQUFJLFFBQVEsVUFBVSxJQUFJLFdBQVcsR0FBRyxNQUFNLEdBQUcsS0FBSyxJQUFJLFdBQVcsR0FBRyxNQUFNLEdBQUcsRUFBRyxRQUFPO0FBQUEsSUFDN0Y7QUFDQSxXQUFPO0FBQUEsRUFDVCxHQUdTQyxZQUFULFNBQXFCLE9BQW9DLElBQXdGO0FBQy9JLFFBQUksQ0FBQ0QsZUFBYyxNQUFNLFdBQVcsRUFBRyxRQUFPLFFBQVEsUUFBUSxFQUFFLE9BQU8sb0JBQW9CLE1BQU0sWUFBWSxDQUFDO0FBQzlHLFFBQUksV0FBVyxRQUFRLE9BQU8sY0FBYyxTQUFTO0FBQ25ELGFBQU8sUUFBUSxRQUFRLEVBQUUsT0FBTyxtQkFBbUIsT0FBTyxTQUFTLEtBQUssTUFBTSxpQkFBaUIsQ0FBQztBQUFBLElBQ2xHO0FBQ0EsV0FBTyxHQUFHLE1BQU0sRUFBRSxNQUFNLENBQUMsUUFBaUI7QUFDeEMsWUFBTSxVQUFVLE1BQU07QUFBRSxZQUFJO0FBQUUsaUJBQU8sS0FBSyxVQUFVLEdBQUc7QUFBQSxRQUFHLFFBQVE7QUFBRSxpQkFBTyxPQUFPLEdBQUc7QUFBQSxRQUFHO0FBQUEsTUFBRSxHQUFHLEVBQUUsTUFBTSxHQUFHLEdBQUc7QUFDM0csYUFBTyxFQUFFLE9BQU8sUUFBUSxNQUFNLGVBQWU7QUFBQSxJQUMvQyxDQUFDO0FBQUEsRUFDSCxHQUVTRSxlQUFULFdBQTZCO0FBQzNCLFlBQVEsT0FBTyxvQkFBb0IsQ0FBQyxVQUFVO0FBQzVDLFVBQUksQ0FBQ0YsZUFBYyxNQUFNLFdBQVcsRUFBRyxRQUFPLEVBQUUsT0FBTyxtQkFBbUI7QUFDMUUsYUFBTyxFQUFFLEdBQUcsUUFBUSxjQUFjO0FBQUEsSUFDcEMsQ0FBQztBQUVELFlBQVEsT0FBTyxtQkFBbUIsQ0FBQyxVQUNqQ0MsVUFBUyxPQUFPLENBQUMsTUFBTSxFQUFFLFFBQTZMLHlCQUF5QixDQUFDLENBQUM7QUFFblAsWUFBUSxPQUFPLG9CQUFvQixDQUFDLE9BQU8sTUFBZSxXQUFvQixNQUFlLGFBQXNCLFdBQW9CO0FBQ3JJLFlBQU0sT0FBTyxPQUFPLFNBQVMsV0FBVyxLQUFLLE1BQU0sR0FBRyxHQUFNLElBQUk7QUFDaEUsWUFBTSxNQUFNLE9BQU8sY0FBYyxXQUFXLFVBQVUsTUFBTSxHQUFHLEVBQUUsSUFBSTtBQUNyRSxZQUFNLElBQUksU0FBUyxVQUFVLFNBQVMsU0FBUyxPQUFPO0FBRXRELFlBQU0sT0FBTyxNQUFNLFFBQVEsV0FBVyxJQUFJLFlBQVksT0FBTyxDQUFDLE1BQW1CLE9BQU8sTUFBTSxRQUFRLEVBQUUsTUFBTSxHQUFHLEVBQUUsSUFBSSxDQUFDO0FBRXhILFlBQU0sT0FBTyxNQUFNLFFBQVEsTUFBTSxJQUM3QixPQUNHLE9BQU8sQ0FBQyxPQUNQLE9BQU8sT0FBTyxZQUFZLE9BQU8sUUFBUSxPQUFRLEdBQTBCLFNBQVMsWUFBWSxPQUFRLEdBQTZCLFlBQVksUUFBUSxFQUMxSixNQUFNLEdBQUcsQ0FBQyxFQUNWLElBQUksQ0FBQyxRQUFRLEVBQUUsTUFBTSxHQUFHLEtBQUssTUFBTSxHQUFHLEdBQUcsR0FBRyxTQUFTLEdBQUcsUUFBUSxNQUFNLEdBQUcsSUFBUyxFQUFFLEVBQUUsSUFDekYsQ0FBQztBQUNMLFVBQUksU0FBUyxNQUFNLFFBQVEsR0FBSSxRQUFPLFFBQVEsUUFBUSxFQUFFLElBQUksT0FBTyxNQUFNLGNBQWMsQ0FBQztBQUN4RixhQUFPQSxVQUFTLE9BQU8sQ0FBQyxNQUFNLEVBQUUsU0FBMEMsYUFBYSxFQUFFLE1BQU0sTUFBTSxXQUFXLEtBQUssTUFBTSxHQUFHLGFBQWEsTUFBTSxRQUFRLEtBQUssQ0FBQyxDQUFDO0FBQUEsSUFDbEssQ0FBQztBQUdELFlBQVEsT0FBTyxvQkFBb0IsQ0FBQyxPQUFPLFNBQWtCO0FBQzNELFlBQU0sSUFBSSxPQUFPLFNBQVMsV0FBVyxLQUFLLEtBQUssRUFBRSxNQUFNLEdBQUcsRUFBRSxJQUFJO0FBQ2hFLFVBQUksTUFBTSxHQUFJLFFBQU8sUUFBUSxRQUFRLEVBQUUsT0FBTyxpQkFBaUIsTUFBTSxjQUFjLENBQUM7QUFDcEYsYUFBT0EsVUFBUyxPQUFPLENBQUMsTUFBTSxFQUFFLFNBQTBDLGNBQWMsRUFBRSxNQUFNLEVBQUUsQ0FBQyxDQUFDO0FBQUEsSUFDdEcsQ0FBQztBQUdELFlBQVEsT0FBTyx1QkFBdUIsT0FBTyxVQUFVO0FBQ3JELFVBQUksQ0FBQ0QsZUFBYyxNQUFNLFdBQVcsRUFBRyxRQUFPLEVBQUUsT0FBTyxvQkFBb0IsTUFBTSxZQUFZO0FBQzdGLGFBQU8sZ0JBQWdCO0FBQUEsSUFDekIsQ0FBQztBQUNELFlBQVEsT0FBTyx1QkFBdUIsQ0FBQyxVQUFVO0FBQy9DLFVBQUksQ0FBQ0EsZUFBYyxNQUFNLFdBQVcsRUFBRyxRQUFPLEVBQUUsT0FBTyxvQkFBb0IsTUFBTSxZQUFZO0FBQzdGLFVBQUksa0JBQWtCLEtBQU0sUUFBTyxFQUFFLE9BQU8sMkJBQTJCLE1BQU0saUJBQWlCO0FBQzlGLE1BQUF0QixhQUFZO0FBQ1osYUFBTyxFQUFFLElBQUksS0FBSztBQUFBLElBQ3BCLENBQUM7QUFHRCxZQUFRLE9BQU8sdUJBQXVCLENBQUMsT0FBTyxTQUFrQjtBQUM5RCxVQUFJLENBQUNzQixlQUFjLE1BQU0sV0FBVyxFQUFHLFFBQU8sRUFBRSxPQUFPLG9CQUFvQixNQUFNLFlBQVk7QUFDN0YsTUFBQXZCLGFBQVksU0FBUyxJQUFJO0FBQ3pCLGFBQU8sRUFBRSxJQUFJLEtBQUs7QUFBQSxJQUNwQixDQUFDO0FBQ0QsWUFBUSxPQUFPLDBCQUEwQixDQUFDLFVBQVU7QUFDbEQsVUFBSSxDQUFDdUIsZUFBYyxNQUFNLFdBQVcsRUFBRyxRQUFPLEVBQUUsT0FBTyxvQkFBb0IsTUFBTSxZQUFZO0FBQzdGLE1BQUFuQixlQUFjO0FBQ2QsYUFBTyxFQUFFLElBQUksS0FBSztBQUFBLElBQ3BCLENBQUM7QUFHRCxZQUFRLE9BQU8sNEJBQTRCLE9BQU8sVUFBVTtBQUMxRCxVQUFJLENBQUNtQixlQUFjLE1BQU0sV0FBVyxFQUFHLFFBQU8sRUFBRSxPQUFPLG9CQUFvQixNQUFNLFlBQVk7QUFDN0YsWUFBTSxJQUFJLE1BQU0sZUFBZTtBQUMvQixhQUFPLEVBQUUsSUFBSSxFQUFFLElBQUksU0FBUyxFQUFFLFNBQVMsT0FBT2hCLFNBQVEsR0FBRyxNQUFNLFVBQVUsV0FBV0MsWUFBVyxNQUFNLElBQUksV0FBV0gsdUJBQXNCLEVBQUU7QUFBQSxJQUM5SSxDQUFDO0FBRUQsWUFBUSxPQUFPLCtCQUErQixPQUFPLE9BQU8sWUFBcUI7QUFDL0UsVUFBSSxDQUFDa0IsZUFBYyxNQUFNLFdBQVcsRUFBRyxRQUFPLEVBQUUsT0FBTyxvQkFBb0IsTUFBTSxZQUFZO0FBQzdGLFVBQUlmLFlBQVcsTUFBTSxHQUFJLFFBQU8sRUFBRSxPQUFPLGlDQUFpQyxNQUFNLGlCQUFpQjtBQUNqRyxNQUFBRyxRQUFPLENBQUMsT0FBTyxZQUFZLE9BQU8sbUJBQW1CLGtCQUFrQixDQUFDO0FBRXhFLFVBQUksWUFBWSxNQUFNO0FBQ3BCLGlCQUFTLElBQUksR0FBRyxJQUFJLElBQUksS0FBSztBQUMzQixnQkFBTSxJQUFJLFFBQVEsQ0FBQyxNQUFNLFdBQVcsR0FBRyxHQUFHLENBQUM7QUFDM0MsZUFBSyxNQUFNLGVBQWUsR0FBRyxHQUFJLFFBQU8sRUFBRSxJQUFJLE1BQU0sV0FBV04sdUJBQXNCLEVBQUU7QUFBQSxRQUN6RjtBQUNBLGVBQU8sRUFBRSxPQUFPLHFDQUFxQyxNQUFNLGtCQUFrQjtBQUFBLE1BQy9FO0FBQ0EsYUFBTyxFQUFFLElBQUksTUFBTSxXQUFXQSx1QkFBc0IsRUFBRTtBQUFBLElBQ3hELENBQUM7QUFDRCxZQUFRLE9BQU8sMkJBQTJCLE9BQU8sVUFBVTtBQUN6RCxVQUFJLENBQUNrQixlQUFjLE1BQU0sV0FBVyxFQUFHLFFBQU8sRUFBRSxPQUFPLG9CQUFvQixNQUFNLFlBQVk7QUFDN0YsVUFBSWYsWUFBVyxNQUFNLEdBQUksUUFBTyxFQUFFLE9BQU8saUNBQWlDLE1BQU0saUJBQWlCO0FBQ2pHLFdBQUssTUFBTSxlQUFlLEdBQUcsSUFBSTtBQUMvQixlQUFPLEVBQUUsSUFBSSxNQUFNLFNBQVMsTUFBTSxRQUFRLFVBQVVELFNBQVEsS0FBSyxXQUFXLElBQUksUUFBUSxHQUFHO0FBQUEsTUFDN0Y7QUFDQSxNQUFBSSxRQUFPLENBQUMsT0FBTyxTQUFTLGdCQUFnQixDQUFDO0FBRXpDLGVBQVMsSUFBSSxHQUFHLElBQUksSUFBSSxLQUFLO0FBQzNCLGNBQU0sSUFBSSxRQUFRLENBQUMsTUFBTSxXQUFXLEdBQUcsR0FBRyxDQUFDO0FBQzNDLGFBQUssTUFBTSxlQUFlLEdBQUcsSUFBSTtBQUMvQixpQkFBTyxFQUFFLElBQUksTUFBTSxRQUFRLFVBQVVKLFNBQVEsS0FBSyxXQUFXLElBQUksUUFBUSxHQUFHO0FBQUEsUUFDOUU7QUFBQSxNQUNGO0FBQ0EsYUFBTyxFQUFFLE9BQU8sZ0VBQWdFLE1BQU0sa0JBQWtCO0FBQUEsSUFDMUcsQ0FBQztBQUNELFlBQVEsT0FBTywwQkFBMEIsT0FBTyxVQUFVO0FBQ3hELFVBQUksQ0FBQ2dCLGVBQWMsTUFBTSxXQUFXLEVBQUcsUUFBTyxFQUFFLE9BQU8sb0JBQW9CLE1BQU0sWUFBWTtBQUM3RixNQUFBWixRQUFPLENBQUMsT0FBTyxNQUFNLENBQUM7QUFDdEIsZUFBUyxJQUFJLEdBQUcsSUFBSSxJQUFJLEtBQUs7QUFDM0IsY0FBTSxJQUFJLFFBQVEsQ0FBQyxNQUFNLFdBQVcsR0FBRyxHQUFHLENBQUM7QUFDM0MsWUFBSSxFQUFFLE1BQU0sZUFBZSxHQUFHLEdBQUksUUFBTyxFQUFFLElBQUksS0FBSztBQUFBLE1BQ3REO0FBQ0EsWUFBTSxTQUFTLE1BQU0sZUFBZSxHQUFHO0FBQ3ZDLGFBQU8sUUFBUSxFQUFFLE9BQU8saUJBQWlCLE1BQU0sZUFBZSxJQUFJLEVBQUUsSUFBSSxLQUFLO0FBQUEsSUFDL0UsQ0FBQztBQUdELFlBQVEsT0FBTyxxQkFBcUIsT0FBTyxPQUFPLFVBQW1CO0FBQ25FLFVBQUksQ0FBQ1ksZUFBYyxNQUFNLFdBQVcsRUFBRyxRQUFPLEVBQUUsT0FBTyxvQkFBb0IsTUFBTSxZQUFZO0FBQzdGLFlBQU0sTUFBTSxjQUFjLGNBQWMsRUFBRSxLQUFLLENBQUMsTUFBTSxDQUFDLEVBQUUsWUFBWSxDQUFDO0FBQ3RFLFVBQUksUUFBUSxPQUFXLFFBQU8sRUFBRSxPQUFPLGFBQWEsTUFBTSxlQUFlO0FBQ3pFLFlBQU0sSUFBSSxNQUFNLE9BQU8sZUFBZSxLQUFLO0FBQUEsUUFDekMsT0FBTyxPQUFPLFVBQVUsWUFBWSxVQUFVLEtBQUssTUFBTSxNQUFNLEdBQUcsR0FBRyxJQUFJO0FBQUEsUUFDekUsWUFBWSxDQUFDLFlBQVksaUJBQWlCO0FBQUEsTUFDNUMsQ0FBQztBQUNELFVBQUksRUFBRSxZQUFZLEVBQUUsVUFBVSxXQUFXLEVBQUcsUUFBTyxFQUFFLElBQUksT0FBTyxVQUFVLEtBQUs7QUFDL0UsYUFBTyxFQUFFLElBQUksTUFBTSxPQUFPLEVBQUUsVUFBVSxNQUFNLEdBQUcsRUFBRSxFQUFFO0FBQUEsSUFDckQsQ0FBQztBQUdELFlBQVEsT0FBTyx5QkFBeUIsT0FBTyxPQUFPLFVBQW1CO0FBQ3ZFLFVBQUksQ0FBQ0EsZUFBYyxNQUFNLFdBQVcsRUFBRyxRQUFPLEVBQUUsT0FBTyxvQkFBb0IsTUFBTSxZQUFZO0FBQzdGLFlBQU0sTUFBTSxjQUFjLGNBQWMsRUFBRSxLQUFLLENBQUMsTUFBTSxDQUFDLEVBQUUsWUFBWSxDQUFDO0FBQ3RFLFVBQUksUUFBUSxPQUFXLFFBQU8sRUFBRSxPQUFPLGFBQWEsTUFBTSxlQUFlO0FBQ3pFLFlBQU0sSUFBSSxNQUFNLE9BQU8sZUFBZSxLQUFLO0FBQUEsUUFDekMsT0FBTyxPQUFPLFVBQVUsWUFBWSxVQUFVLEtBQUssTUFBTSxNQUFNLEdBQUcsR0FBRyxJQUFJO0FBQUEsUUFDekUsWUFBWSxDQUFDLGVBQWU7QUFBQSxNQUM5QixDQUFDO0FBQ0QsVUFBSSxFQUFFLFlBQVksRUFBRSxVQUFVLENBQUMsTUFBTSxPQUFXLFFBQU8sRUFBRSxJQUFJLE9BQU8sVUFBVSxLQUFLO0FBQ25GLGFBQU8sRUFBRSxJQUFJLE1BQU0sTUFBTSxFQUFFLFVBQVUsQ0FBQyxFQUFFO0FBQUEsSUFDMUMsQ0FBQztBQUdELFlBQVEsT0FBTyxvQkFBb0IsQ0FBQyxPQUFPLE1BQWU7QUFDeEQsWUFBTSxRQUFRLE9BQU8sTUFBTSxXQUFXLEVBQUUsTUFBTSxHQUFHLEdBQUcsSUFBSTtBQUN4RCxVQUFJLFVBQVUsR0FBSSxRQUFPLFFBQVEsUUFBUSxFQUFFLFNBQVMsQ0FBQyxFQUFFLENBQUM7QUFDeEQsYUFBT0MsVUFBUyxPQUFPLENBQUMsTUFBTSxFQUFFLFFBQTJELG9CQUFvQixtQkFBbUIsS0FBSyxDQUFDLEVBQUUsQ0FBQztBQUFBLElBQzdJLENBQUM7QUFFRCxZQUFRLE9BQU8sa0JBQWtCLENBQUMsT0FBTyxTQUFrQixjQUN6REEsVUFBUyxPQUFPLENBQUMsTUFBTSxFQUFFLFNBQTBCLGdCQUFnQjtBQUFBLE1BQ2pFLFNBQVMsWUFBWTtBQUFBLE1BQ3JCLFdBQVcsT0FBTyxjQUFjLFdBQVcsVUFBVSxNQUFNLEdBQUcsRUFBRSxJQUFJO0FBQUEsSUFDdEUsQ0FBQyxDQUFDLENBQUM7QUFFTCxZQUFRLE9BQU8sb0JBQW9CLENBQUMsT0FBTyxjQUN6Q0EsVUFBUyxPQUFPLENBQUMsTUFBTSxFQUFFLFNBQTBCLGtCQUFrQjtBQUFBLE1BQ25FLFdBQVcsT0FBTyxjQUFjLFdBQVcsVUFBVSxNQUFNLEdBQUcsRUFBRSxJQUFJO0FBQUEsSUFDdEUsQ0FBQyxDQUFDLENBQUM7QUFHTCxZQUFRLE9BQU8sa0JBQWtCLENBQUMsT0FBTyxTQUFrQjtBQUN6RCxZQUFNLElBQUksT0FBTyxTQUFTLFdBQVcsS0FBSyxNQUFNLEdBQUcsR0FBSSxJQUFJO0FBQzNELGFBQU9BLFVBQVMsT0FBTyxDQUFDLE1BQU0sRUFBRSxRQUFpQyxrQkFBa0IsTUFBTSxLQUFLLFNBQVMsbUJBQW1CLENBQUMsQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDO0FBQUEsSUFDeEksQ0FBQztBQUVELFlBQVEsT0FBTyxrQkFBa0IsQ0FBQyxPQUFPLFNBQWtCO0FBQ3pELFlBQU0sSUFBSSxPQUFPLFNBQVMsV0FBVyxLQUFLLE1BQU0sR0FBRyxHQUFJLElBQUk7QUFDM0QsVUFBSSxNQUFNLEdBQUksUUFBTyxRQUFRLFFBQVEsRUFBRSxPQUFPLGlCQUFpQixNQUFNLGNBQWMsQ0FBQztBQUNwRixhQUFPQSxVQUFTLE9BQU8sQ0FBQyxNQUFNLEVBQUUsUUFBaUMscUJBQXFCLG1CQUFtQixDQUFDLENBQUMsRUFBRSxDQUFDO0FBQUEsSUFDaEgsQ0FBQztBQUVELFlBQVEsT0FBTyxpQkFBaUIsQ0FBQyxPQUFPLE1BQWUsY0FBdUI7QUFDNUUsWUFBTSxJQUFJLE9BQU8sU0FBUyxXQUFXLEtBQUssTUFBTSxHQUFHLEdBQU0sSUFBSTtBQUM3RCxZQUFNLE1BQU0sT0FBTyxjQUFjLFdBQVcsVUFBVSxNQUFNLEdBQUcsRUFBRSxJQUFJO0FBQ3JFLFVBQUksTUFBTSxNQUFNLFFBQVEsR0FBSSxRQUFPLFFBQVEsUUFBUSxFQUFFLElBQUksT0FBTyxNQUFNLGNBQWMsQ0FBQztBQUNyRixhQUFPQSxVQUFTLE9BQU8sQ0FBQyxNQUFNLEVBQUUsU0FBMEIsZUFBZSxFQUFFLE1BQU0sR0FBRyxXQUFXLElBQUksQ0FBQyxDQUFDO0FBQUEsSUFDdkcsQ0FBQztBQUdELFlBQVEsT0FBTyx5QkFBeUIsT0FBTyxPQUFPLElBQWEsVUFBbUI7QUFDcEYsVUFBSSxDQUFDRCxlQUFjLE1BQU0sV0FBVyxFQUFHLFFBQU8sRUFBRSxPQUFPLG9CQUFvQixNQUFNLFlBQVk7QUFDN0YsWUFBTSxNQUFNLE9BQU8sT0FBTyxXQUFXLEdBQUcsUUFBUSxzQkFBc0IsRUFBRSxFQUFFLE1BQU0sR0FBRyxFQUFFLElBQUk7QUFDekYsVUFBSSxRQUFRLEdBQUksUUFBTyxFQUFFLE9BQU8sZUFBZSxNQUFNLGNBQWM7QUFDbkUsVUFBSSxXQUFXLFFBQVEsT0FBTyxjQUFjLFFBQVMsUUFBTyxFQUFFLE9BQU8sbUJBQW1CLE9BQU8sU0FBUyxLQUFLLE1BQU0saUJBQWlCO0FBQ3BJLFVBQUk7QUFDRixjQUFNLEtBQUssTUFBTSxPQUFPLFFBQVEsaUJBQWlCLG1CQUFtQixHQUFHLENBQUMsWUFBWTtBQUNwRixjQUFNLE1BQU0sY0FBYyxjQUFjLEVBQUUsS0FBSyxDQUFDLE1BQU0sQ0FBQyxFQUFFLFlBQVksQ0FBQztBQUN0RSxZQUFJLFFBQVEsT0FBVyxRQUFPLEVBQUUsT0FBTyxhQUFhLE1BQU0sZUFBZTtBQUN6RSxjQUFNLElBQUksTUFBTSxPQUFPLGVBQWUsS0FBSztBQUFBLFVBQ3pDLE9BQU8sT0FBTyxVQUFVLFlBQVksVUFBVSxLQUFLLE1BQU0sTUFBTSxHQUFHLEVBQUUsSUFBSTtBQUFBLFVBQ3hFLGFBQWEsT0FBTyxHQUFHO0FBQUEsVUFDdkIsU0FBUyxDQUFDLEVBQUUsTUFBTSxZQUFZLFlBQVksQ0FBQyxJQUFJLEVBQUUsQ0FBQztBQUFBLFFBQ3BELENBQUM7QUFDRCxZQUFJLEVBQUUsWUFBWSxFQUFFLGFBQWEsVUFBYSxFQUFFLGFBQWEsR0FBSSxRQUFPLEVBQUUsSUFBSSxPQUFPLFVBQVUsS0FBSztBQUNwRyxjQUFNRyxXQUFVLEVBQUUsVUFBVSxJQUFJLE1BQU07QUFDdEMsZ0JBQVEsVUFBVSxXQUFXLEdBQUcsV0FBTSxFQUFFLFFBQVEsRUFBRTtBQUNsRCxlQUFPLEVBQUUsSUFBSSxNQUFNLE1BQU0sRUFBRSxTQUFTO0FBQUEsTUFDdEMsU0FBUyxLQUFLO0FBQ1osY0FBTSxVQUFVLE1BQU07QUFBRSxjQUFJO0FBQUUsbUJBQU8sS0FBSyxVQUFVLEdBQUc7QUFBQSxVQUFHLFFBQVE7QUFBRSxtQkFBTyxPQUFPLEdBQUc7QUFBQSxVQUFHO0FBQUEsUUFBRSxHQUFHLEVBQUUsTUFBTSxHQUFHLEdBQUc7QUFDM0csZUFBTyxFQUFFLE9BQU8sUUFBUSxNQUFNLGVBQWU7QUFBQSxNQUMvQztBQUFBLElBQ0YsQ0FBQztBQUdELFlBQVEsT0FBTyx1QkFBdUIsQ0FBQyxVQUNyQ0YsVUFBUyxPQUFPLENBQUMsTUFBTSxFQUFFLFFBQThDLFlBQVksQ0FBQyxDQUFDO0FBRXZGLFlBQVEsT0FBTyx1QkFBdUIsQ0FBQyxPQUFPLFNBQWtCO0FBQzlELFlBQU0sSUFBSSxTQUFTLFNBQVMsU0FBUyxTQUFTLFFBQVEsUUFBUTtBQUM5RCxVQUFJLE1BQU0sR0FBSSxRQUFPLFFBQVEsUUFBUSxFQUFFLE9BQU8seUJBQXlCLE1BQU0sY0FBYyxDQUFDO0FBQzVGLGFBQU9BLFVBQVMsT0FBTyxDQUFDLE1BQU0sRUFBRSxTQUEwQixlQUFlLEVBQUUsVUFBVSxFQUFFLENBQUMsQ0FBQztBQUFBLElBQzNGLENBQUM7QUFHRCxZQUFRLE9BQU8sdUJBQXVCLE9BQU8sVUFBVTtBQUNyRCxVQUFJLENBQUNELGVBQWMsTUFBTSxXQUFXLEVBQUcsUUFBTyxFQUFFLE9BQU8sb0JBQW9CLE1BQU0sWUFBWTtBQUM3RixZQUFNLElBQUlSLHVCQUFzQjtBQUNoQyxZQUFNLE1BQU0sTUFBTSxrQkFBa0I7QUFDcEMsYUFBTztBQUFBLFFBQ0wsTUFBTSxPQUFPO0FBQUEsUUFDYixjQUFjLE9BQU87QUFBQSxRQUNyQixVQUFVLElBQUk7QUFBQSxRQUNkLE1BQU0sSUFBSTtBQUFBLFFBQ1YsVUFBVSxFQUFFO0FBQUEsUUFDWixpQkFBaUIsRUFBRTtBQUFBLFFBQ25CLGdCQUFnQixFQUFFO0FBQUEsTUFDcEI7QUFBQSxJQUNGLENBQUM7QUFFRCxZQUFRLE9BQU8seUJBQXlCLE9BQU8sT0FBTyxVQUFtQjtBQUN2RSxVQUFJLENBQUNRLGVBQWMsTUFBTSxXQUFXLEVBQUcsUUFBTyxFQUFFLE9BQU8sb0JBQW9CLE1BQU0sWUFBWTtBQUM3RixZQUFNLE1BQU0sY0FBYyxjQUFjLEVBQUUsS0FBSyxDQUFDLE1BQU0sQ0FBQyxFQUFFLFlBQVksQ0FBQztBQUN0RSxVQUFJLFFBQVEsT0FBVyxRQUFPLEVBQUUsT0FBTyxhQUFhLE1BQU0sZUFBZTtBQUN6RSxZQUFNLElBQUksTUFBTSxPQUFPLGVBQWUsS0FBSztBQUFBLFFBQ3pDLE9BQU8sT0FBTyxVQUFVLFlBQVksVUFBVSxLQUFLLE1BQU0sTUFBTSxHQUFHLEdBQUcsSUFBSTtBQUFBLFFBQ3pFLFlBQVksQ0FBQyxVQUFVO0FBQUEsUUFDdkIsU0FBUyxDQUFDLEVBQUUsTUFBTSxnQkFBZ0IsWUFBWSxDQUFDLE1BQU0sSUFBSSxFQUFFLENBQUM7QUFBQSxNQUM5RCxDQUFDO0FBQ0QsVUFBSSxFQUFFLFlBQVksRUFBRSxVQUFVLENBQUMsTUFBTSxPQUFXLFFBQU8sRUFBRSxJQUFJLE9BQU8sVUFBVSxLQUFLO0FBQ25GLGFBQU8sRUFBRSxJQUFJLE1BQU0sT0FBTyxFQUFFLFVBQVUsQ0FBQyxFQUFFO0FBQUEsSUFDM0MsQ0FBQztBQUdELFlBQVEsT0FBTyxzQkFBc0IsT0FBTyxPQUFPLFVBQW1CO0FBQ3BFLFVBQUksQ0FBQ0EsZUFBYyxNQUFNLFdBQVcsRUFBRyxRQUFPLEVBQUUsT0FBTyxvQkFBb0IsTUFBTSxZQUFZO0FBQzdGLFlBQU0sSUFBSSxPQUFPLFVBQVUsV0FBVyxNQUFNLEtBQUssSUFBSTtBQUNyRCxVQUFJLE1BQU0sT0FBTyxDQUFDLFdBQVcsQ0FBQyxLQUFLLENBQUNqQixZQUFXLENBQUMsSUFBSTtBQUNsRCxlQUFPLEVBQUUsT0FBTyw2RkFBaUMsTUFBTSxjQUFjO0FBQUEsTUFDdkU7QUFDQSxZQUFNLHlCQUF5QixDQUFDO0FBRWhDLGdCQUFVLE1BQU07QUFDaEIsVUFBSSxlQUFlLEtBQU0sT0FBTSxXQUFXLEtBQUs7QUFDL0MsWUFBTSxVQUFVO0FBQ2hCLGFBQU8sRUFBRSxJQUFJLE1BQU0sTUFBTSxPQUFPLEtBQUs7QUFBQSxJQUN2QyxDQUFDO0FBR0QsWUFBUSxPQUFPLHlCQUF5QixDQUFDLFVBQVU7QUFDakQsVUFBSSxDQUFDaUIsZUFBYyxNQUFNLFdBQVcsRUFBRyxRQUFPLEVBQUUsT0FBTyxvQkFBb0IsTUFBTSxZQUFZO0FBQzdGLFlBQU0sT0FBT0gsb0JBQW1CO0FBR2hDLFVBQUksUUFBUSxJQUFJLGdDQUFnQyxVQUFVLFFBQVEsSUFBSSxxQkFBcUIsS0FBSztBQUM5RixlQUFPLEVBQUUsT0FBTyxPQUFPLFNBQVMsSUFBSSxPQUFPLElBQUksUUFBUSxJQUFJLFNBQVMsTUFBTSxLQUFLQyxXQUFVLEVBQUU7QUFBQSxNQUM3RjtBQUNBLFlBQU0sSUFBSU4sdUJBQXNCO0FBQ2hDLGFBQU8sRUFBRSxPQUFPLEVBQUUsVUFBVSxJQUFJLFNBQVMsRUFBRSxTQUFTLE9BQU8sRUFBRSxPQUFPLFFBQVEsRUFBRSxRQUFRLFNBQVMsTUFBTSxLQUFLTSxXQUFVLEVBQUU7QUFBQSxJQUN4SCxDQUFDO0FBRUQsWUFBUSxPQUFPLHNCQUFzQixDQUFDLE9BQU8sU0FBa0I7QUFDN0QsVUFBSSxDQUFDRSxlQUFjLE1BQU0sV0FBVyxFQUFHLFFBQU8sRUFBRSxPQUFPLG9CQUFvQixNQUFNLFlBQVk7QUFDN0YsWUFBTSxJQUFLLFFBQVEsQ0FBQztBQUNwQixhQUFPO0FBQUEsUUFDTDtBQUFBLFVBQ0UsY0FBYyxDQUFDLE1BQTZCO0FBQzFDLG9CQUFRLFdBQVcsR0FBRyxFQUFFLEtBQUssR0FBRyxFQUFFLFFBQVEsU0FBWSxJQUFJLEVBQUUsR0FBRyxNQUFNLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRTtBQUNuRix1QkFBVyxLQUFLLGNBQWMsY0FBYyxHQUFHO0FBQzdDLGtCQUFJLENBQUMsRUFBRSxZQUFZLEVBQUcsR0FBRSxZQUFZLEtBQUssb0JBQW9CLENBQUM7QUFBQSxZQUNoRTtBQUFBLFVBQ0Y7QUFBQSxVQUNBLEtBQUssQ0FBQyxNQUFvQjtBQUFFLG9CQUFRLFdBQVcsQ0FBQztBQUFBLFVBQUc7QUFBQTtBQUFBLFVBRW5ELGFBQWEsQ0FBQyxVQUF3QjtBQUNwQyxrQkFBTSxZQUFZO0FBQ2hCLG9CQUFNLGtCQUFrQixFQUFFLE9BQU8sTUFBTSxNQUFNLENBQUM7QUFDOUMsd0JBQVUsTUFBTTtBQUNoQixrQkFBSSxlQUFlLEtBQU0sT0FBTSxXQUFXLEtBQUs7QUFDL0Msb0JBQU0sVUFBVTtBQUFBLFlBQ2xCLEdBQUc7QUFBQSxVQUNMO0FBQUEsUUFDRjtBQUFBLFFBQ0E7QUFBQSxVQUNFLFVBQVUsRUFBRSxhQUFhO0FBQUEsVUFDekIsYUFBYSxFQUFFLGdCQUFnQixjQUFjLGNBQWMsRUFBRSxnQkFBZ0IsVUFBVSxVQUFVO0FBQUEsUUFDbkc7QUFBQSxNQUNGO0FBQUEsSUFDRixDQUFDO0FBRUQsWUFBUSxPQUFPLHFCQUFxQixPQUFPLFVBQVU7QUFDbkQsVUFBSSxDQUFDQSxlQUFjLE1BQU0sV0FBVyxFQUFHLFFBQU8sRUFBRSxPQUFPLG9CQUFvQixNQUFNLFlBQVk7QUFDN0YsWUFBTSxVQUFVLFFBQVEsSUFBSTtBQUM1QixVQUFJLFlBQVksVUFBYSxZQUFZLElBQUk7QUFHM0MsY0FBTUksS0FBSSxNQUFNLGdCQUFnQjtBQUNoQyxlQUFPLEVBQUUsTUFBTSxPQUFPLFFBQVEsSUFBSSxZQUFZLE9BQU8sV0FBVyxFQUFFLE1BQU1BLEdBQUUsTUFBTSxRQUFRQSxHQUFFLE9BQU8sRUFBRTtBQUFBLE1BQ3JHO0FBQ0EsWUFBTSxJQUFJLE1BQU0sZ0JBQWdCO0FBQ2hDLFlBQU0sTUFBTSxNQUFNLGtCQUFrQjtBQUVwQyxhQUFPLEVBQUUsTUFBTSxFQUFFLFFBQVEsSUFBSSxVQUFVLE1BQU0sSUFBSSxNQUFNLFFBQVEsRUFBRSxRQUFRLFlBQVlMLGtCQUFpQixFQUFFO0FBQUEsSUFDMUcsQ0FBQztBQUlELFlBQVEsT0FBTywwQkFBMEIsT0FBTyxPQUFPLFFBQWlCLFVBQW1CO0FBQ3pGLFVBQUksQ0FBQ0MsZUFBYyxNQUFNLFdBQVcsRUFBRyxRQUFPLEVBQUUsT0FBTyxvQkFBb0IsTUFBTSxZQUFZO0FBQzdGLFlBQU0sSUFBSSxXQUFXLGNBQWMsV0FBVyxhQUFhLFdBQVcsYUFBYSxXQUFXLFNBQVMsU0FBUztBQUNoSCxVQUFJLE1BQU0sR0FBSSxRQUFPLEVBQUUsT0FBTyxnREFBZ0QsTUFBTSxjQUFjO0FBQ2xHLFlBQU0sSUFBSSxPQUFPLFVBQVUsV0FBVyxRQUFRO0FBQzlDLFlBQU0sZ0JBQWdCLENBQUM7QUFDdkIsVUFBSSxRQUFRLElBQUkscUJBQXFCLElBQUssUUFBTyxFQUFFLElBQUksTUFBTSxNQUFNLE9BQU8sTUFBTSxNQUFNLEtBQUs7QUFDM0YsWUFBTSxXQUFXN0IsTUFBSyxNQUFNLE1BQU0sTUFBTSxNQUFNLElBQUk7QUFDbEQsVUFBSSxNQUFNLGNBQWMsTUFBTSxXQUFXO0FBQ3ZDLGNBQU0sU0FBUyxNQUFNLFlBQVl5QixvQkFBbUIsUUFBUSxJQUFJO0FBQ2hFLFlBQUksV0FBVyxNQUFNLENBQUMsV0FBVyxNQUFNLEtBQUssQ0FBQ2IsWUFBVyxNQUFNLEdBQUc7QUFDL0QsaUJBQU8sRUFBRSxPQUFPLDBDQUFpQixNQUFNLGNBQWM7QUFBQSxRQUN2RDtBQUNBLGNBQU0sa0JBQWtCLEVBQUUsT0FBTyxRQUFRLE1BQU0sTUFBTSxDQUFDO0FBQUEsTUFDeEQsV0FBVyxNQUFNLFFBQVE7QUFDdkIsY0FBTSxrQkFBa0IsRUFBRSxPQUFPLElBQUksTUFBTSxLQUFLLENBQUM7QUFBQSxNQUNuRDtBQUNBLFVBQUksTUFBTSxXQUFXO0FBRW5CLGtCQUFVLE1BQU07QUFDaEIsWUFBSSxlQUFlLEtBQU0sT0FBTSxXQUFXLEtBQUs7QUFDL0MsY0FBTSxVQUFVO0FBQUEsTUFDbEI7QUFDQSxhQUFPLEVBQUUsSUFBSSxNQUFNLE1BQU0sT0FBTyxLQUFLO0FBQUEsSUFDdkMsQ0FBQztBQUdELFlBQVEsT0FBTyxvQkFBb0IsQ0FBQyxVQUNsQ2tCLFVBQVMsT0FBTyxDQUFDLE1BQU0sRUFBRSxRQUEwSSxZQUFZLENBQUMsQ0FBQztBQUVuTCxZQUFRLE9BQU8sd0JBQXdCLENBQUMsT0FBTyxhQUFzQjtBQUNuRSxZQUFNLElBQUk7QUFDVixZQUFNLE9BQU8sT0FBTyxHQUFHLFNBQVMsV0FBVyxFQUFFLEtBQUssTUFBTSxHQUFHLEVBQUUsSUFBSTtBQUNqRSxZQUFNLFVBQVUsT0FBTyxHQUFHLFlBQVksV0FBVyxFQUFFLFFBQVEsTUFBTSxHQUFHLEdBQUcsSUFBSTtBQUMzRSxZQUFNLFFBQVEsT0FBTyxHQUFHLFVBQVUsV0FBVyxFQUFFLE1BQU0sTUFBTSxHQUFHLEdBQUcsSUFBSTtBQUNyRSxVQUFJLFNBQVMsTUFBTSxZQUFZLE1BQU0sVUFBVSxHQUFJLFFBQU8sUUFBUSxRQUFRLEVBQUUsT0FBTywrQkFBK0IsTUFBTSxjQUFjLENBQUM7QUFDdkksWUFBTSxPQUFnQyxFQUFFLE1BQU0sU0FBUyxNQUFNO0FBRTdELFVBQUksT0FBTyxHQUFHLFdBQVcsWUFBWSxFQUFFLFdBQVcsR0FBSSxNQUFLLFNBQVMsRUFBRSxPQUFPLE1BQU0sR0FBRyxHQUFHO0FBQ3pGLGFBQU9BLFVBQVMsT0FBTyxDQUFDLE1BQU0sRUFBRSxTQUEwQixrQkFBa0IsSUFBSSxDQUFDO0FBQUEsSUFDbkYsQ0FBQztBQUdELFlBQVEsT0FBTyxxQkFBcUIsQ0FBQyxVQUNuQ0EsVUFBUyxPQUFPLENBQUMsTUFBTSxFQUFFLFFBQXVGLGlCQUFpQixDQUFDLENBQUM7QUFFckksWUFBUSxPQUFPLHdCQUF3QixDQUFDLE9BQU8sT0FBZ0I7QUFDN0QsWUFBTSxNQUFNLE9BQU8sT0FBTyxXQUFXLEdBQUcsTUFBTSxHQUFHLEVBQUUsSUFBSTtBQUN2RCxVQUFJLFFBQVEsR0FBSSxRQUFPLFFBQVEsUUFBUSxFQUFFLE9BQU8sZUFBZSxNQUFNLGNBQWMsQ0FBQztBQUNwRixhQUFPQSxVQUFTLE9BQU8sQ0FBQyxNQUFNLEVBQUUsU0FBMEIsdUJBQXVCLEVBQUUsSUFBSSxJQUFJLENBQUMsQ0FBQztBQUFBLElBQy9GLENBQUM7QUFFRCxZQUFRLE9BQU8sd0JBQXdCLENBQUMsT0FBTyxNQUFlLFNBQWtCO0FBQzlFLFlBQU0sSUFBSSxPQUFPLFNBQVMsV0FBVyxLQUFLLE1BQU0sR0FBRyxHQUFHLElBQUk7QUFDMUQsWUFBTSxJQUFJLE9BQU8sU0FBUyxXQUFXLEtBQUssTUFBTSxHQUFHLEdBQUksSUFBSTtBQUMzRCxVQUFJLE1BQU0sR0FBSSxRQUFPLFFBQVEsUUFBUSxFQUFFLE9BQU8saUJBQWlCLE1BQU0sY0FBYyxDQUFDO0FBQ3BGLGFBQU9BLFVBQVMsT0FBTyxDQUFDLE1BQU0sRUFBRSxTQUEwQixtQkFBbUIsRUFBRSxNQUFNLE1BQU0sS0FBSyxTQUFZLEdBQUcsTUFBTSxFQUFFLENBQUMsQ0FBQztBQUFBLElBQzNILENBQUM7QUFHRCxZQUFRLE9BQU8scUJBQXFCLENBQUMsT0FBTyxJQUFhLE9BQWdCO0FBQ3ZFLFlBQU0sTUFBTSxPQUFPLE9BQU8sV0FBVyxHQUFHLFFBQVEsc0JBQXNCLEVBQUUsRUFBRSxNQUFNLEdBQUcsRUFBRSxJQUFJO0FBQ3pGLFlBQU0sSUFBSSxPQUFPLGFBQWEsT0FBTyxXQUFXLEtBQUs7QUFDckQsVUFBSSxRQUFRLE1BQU0sTUFBTSxHQUFJLFFBQU8sUUFBUSxRQUFRLEVBQUUsT0FBTyxzQ0FBc0MsTUFBTSxjQUFjLENBQUM7QUFDdkgsYUFBT0EsVUFBUyxPQUFPLENBQUMsTUFBTSxFQUFFLFNBQTBCLGlCQUFpQixtQkFBbUIsR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDO0FBQUEsSUFDaEgsQ0FBQztBQUdELFlBQVEsT0FBTyxlQUFlLENBQUMsT0FBTyxjQUF1QjtBQUMzRCxZQUFNLE1BQU0sT0FBTyxjQUFjLFdBQVcsVUFBVSxNQUFNLEdBQUcsRUFBRSxJQUFJO0FBQ3JFLGFBQU9BLFVBQVMsT0FBTyxDQUFDLE1BQU0sRUFBRSxRQUFpQyxZQUFZLFFBQVEsS0FBSyxjQUFjLG1CQUFtQixHQUFHLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQztBQUFBLElBQzNJLENBQUM7QUFHRCxZQUFRLE9BQU8sb0JBQW9CLENBQUMsVUFDbENBLFVBQVMsT0FBTyxDQUFDLE1BQU0sRUFBRSxRQUFpQyxnQkFBZ0IsQ0FBQyxDQUFDO0FBRzlFLFlBQVEsT0FBTywwQkFBMEIsQ0FBQyxPQUFPLE9BQWdCO0FBQy9ELFlBQU0sTUFBTSxPQUFPLE9BQU8sV0FBVyxHQUFHLFFBQVEsc0JBQXNCLEVBQUUsRUFBRSxNQUFNLEdBQUcsRUFBRSxJQUFJO0FBQ3pGLFVBQUksUUFBUSxHQUFJLFFBQU8sUUFBUSxRQUFRLEVBQUUsT0FBTyxlQUFlLE1BQU0sY0FBYyxDQUFDO0FBQ3BGLGFBQU9BLFVBQVMsT0FBTyxDQUFDLE1BQU0sRUFBRSxRQUFpQyxpQkFBaUIsbUJBQW1CLEdBQUcsQ0FBQyxFQUFFLENBQUM7QUFBQSxJQUM5RyxDQUFDO0FBRUQsWUFBUSxPQUFPLG9CQUFvQixDQUFDLFVBQVU7QUFDNUMsVUFBSSxDQUFDRCxlQUFjLE1BQU0sV0FBVyxFQUFHLFFBQU8sRUFBRSxPQUFPLG1CQUFtQjtBQUMxRSxZQUFNLFlBQVk7QUFDaEIsa0JBQVUsTUFBTTtBQUNoQixjQUFNLFlBQVksS0FBSztBQUN2QixRQUFBNUIsS0FBSSxLQUFLO0FBQUEsTUFDWCxHQUFHO0FBQ0gsYUFBTyxFQUFFLElBQUksS0FBSztBQUFBLElBQ3BCLENBQUM7QUFBQSxFQUNIO0FBcmtDUyxjQUFBQyxZQXlCQSxrQkFBQUUsa0JBT0EsWUFBQUMsWUFlQSxjQUFBRixjQTRCQSxjQUFBRyxjQTBGQSxjQUFBQyxjQW1CQSxlQUFBRSxlQTRCQSxnQkFBQUMsZ0JBNERBLHdCQUFBQyx3QkFVQSxVQUFBRSxVQWdCQSxhQUFBQyxhQWdCQSxTQUFBRyxTQWVBLHFCQUFBQyxxQkEyRUEsZUFBQUMsZUFPQSxZQUFBSCxZQVFBLGtCQUFBSSxrQkFXQSx3QkFBQUMsd0JBa0VBLGtCQUFBRyxrQkFLQSxhQUFBVCxhQWlCQSxxQkFBQVUscUJBS0EscUJBQUFDLHFCQVlBLFlBQUFDLFlBb0JBLG1CQUFBQyxtQkFtSEEsZ0JBQUFDLGdCQVlBLFdBQUFDLFdBV0EsY0FBQUM7QUFqdEJULEVBQUE5QixLQUFJLEdBQUcsbUJBQW1CLE1BQU07QUFDOUIsVUFBTSxNQUFNLGNBQWMsY0FBYyxFQUFFLENBQUM7QUFDM0MsUUFBSSxLQUFLO0FBQ1AsVUFBSSxJQUFJLFlBQVksRUFBRyxLQUFJLFFBQVE7QUFDbkMsVUFBSSxNQUFNO0FBQUEsSUFDWjtBQUFBLEVBQ0YsQ0FBQztBQVdELE1BQUksYUFBOEM7QUFDbEQsTUFBSSxTQUFtQztBQUN2QyxNQUFJLFNBQXlCLEVBQUUsV0FBVyxXQUFXLFVBQVUsTUFBTSxhQUFhLE1BQU0sV0FBVyxNQUFNLE1BQU0sUUFBUSxjQUFjLEtBQUs7QUFFMUksTUFBSSxjQUErQixDQUFDO0FBQ3BDLE1BQUksYUFBb0M7QUFDeEMsTUFBSSxXQUFtQztBQUN2QyxNQUFJLGNBQWM7QUFFbEIsTUFBSSxnQkFBZ0I7QUFvQnBCLFFBQU0sbUJBQW1CO0FBQ3pCLE1BQUksT0FBb0I7QUFDeEIsUUFBTSxpQkFBaUIsQ0FBQyxNQUFvQjtBQUMxQyxlQUFXLEtBQUssY0FBYyxjQUFjLEdBQUc7QUFDN0MsVUFBSSxDQUFDLEVBQUUsWUFBWSxFQUFHLEdBQUUsWUFBWSxLQUFLLGVBQWUsQ0FBQztBQUFBLElBQzNEO0FBQUEsRUFDRjtBQWlEQSxRQUFNLFlBQVksQ0FBQyxTQUNqQixPQUFPLEVBQUUsT0FBTyxXQUFXLGFBQWEsVUFBVSxJQUFJLEVBQUUsT0FBTyxXQUFXLGFBQWEsVUFBVTtBQWFuRyxRQUFNLGNBQWM7QUFFcEIsTUFBSSxjQUEyQixFQUFFLFVBQVUsT0FBTyxnQkFBZ0JBLEtBQUksV0FBVyxHQUFHLFFBQVEsTUFBTSxPQUFPLElBQUksWUFBWSxPQUFPLE9BQU8sR0FBRztBQUMxSSxNQUFJLGdCQUErQjtBQUNuQyxRQUFNLGFBQWEsQ0FBQyxVQUFzQztBQUN4RCxrQkFBYyxFQUFFLEdBQUcsYUFBYSxHQUFHLE1BQU07QUFDekMsZUFBVyxLQUFLLGNBQWMsY0FBYyxHQUFHO0FBQzdDLFVBQUksQ0FBQyxFQUFFLFlBQVksRUFBRyxHQUFFLFlBQVksS0FBSyxnQkFBZ0IsV0FBVztBQUFBLElBQ3RFO0FBQUEsRUFDRjtBQUNBLFFBQU0sYUFBYSxDQUFDLEdBQVcsTUFBc0I7QUFDbkQsVUFBTSxLQUFLLEVBQUUsUUFBUSxNQUFNLEVBQUUsRUFBRSxNQUFNLEdBQUcsRUFBRSxJQUFJLE1BQU07QUFDcEQsVUFBTSxLQUFLLEVBQUUsUUFBUSxNQUFNLEVBQUUsRUFBRSxNQUFNLEdBQUcsRUFBRSxJQUFJLE1BQU07QUFDcEQsYUFBUyxJQUFJLEdBQUcsSUFBSSxHQUFHLEtBQUs7QUFBRSxXQUFLLEdBQUcsQ0FBQyxLQUFLLFFBQVEsR0FBRyxDQUFDLEtBQUssR0FBSSxTQUFRLEdBQUcsQ0FBQyxLQUFLLE1BQU0sR0FBRyxDQUFDLEtBQUssS0FBSyxLQUFLO0FBQUEsSUFBRztBQUM5RyxXQUFPO0FBQUEsRUFDVDtBQUNBLGlCQUFlLGtCQUF3QztBQUNyRCxRQUFJLFlBQVksWUFBWSxZQUFZLFdBQVksUUFBTztBQUMzRCxlQUFXLEVBQUUsVUFBVSxNQUFNLE9BQU8sR0FBRyxDQUFDO0FBQ3hDLFlBQVEsVUFBVSw0QkFBdUJBLEtBQUksV0FBVyxDQUFDLEdBQUc7QUFDNUQsUUFBSTtBQUNGLFlBQU0sSUFBSSxNQUFNLE1BQU0sZ0NBQWdDLFdBQVcsb0JBQW9CO0FBQUEsUUFDbkYsU0FBUyxFQUFFLGNBQWMsc0JBQXNCO0FBQUEsUUFDL0MsUUFBUSxZQUFZLFFBQVEsSUFBTTtBQUFBLE1BQ3BDLENBQUM7QUFDRCxVQUFJLENBQUMsRUFBRSxHQUFJLE9BQU0sSUFBSSxNQUFNLGNBQWMsRUFBRSxNQUFNLEVBQUU7QUFDbkQsWUFBTSxNQUFPLE1BQU0sRUFBRSxLQUFLO0FBQzFCLFlBQU0sTUFBTSxPQUFPLElBQUksWUFBWSxFQUFFO0FBQ3JDLGNBQVEsVUFBVSxVQUFVLEdBQUcsWUFBWSxJQUFJLFVBQVUsQ0FBQyxHQUFHLE1BQU0sRUFBRTtBQUNyRSxpQkFBVyxFQUFFLFVBQVUsT0FBTyxRQUFRLEtBQUssT0FBTyxPQUFPLElBQUksUUFBUSxFQUFFLEVBQUUsTUFBTSxHQUFHLEdBQUcsRUFBRSxDQUFDO0FBRXhGLFVBQUksUUFBUSxNQUFNLFdBQVdBLEtBQUksV0FBVyxHQUFHLEdBQUcsSUFBSSxLQUFLLENBQUMsWUFBWSxZQUFZO0FBQ2xGLGFBQUssa0JBQWtCLElBQUksVUFBVSxDQUFDLENBQUM7QUFBQSxNQUN6QztBQUFBLElBQ0YsU0FBUyxLQUFLO0FBQ1osY0FBUSxVQUFVLGlCQUFpQixPQUFPLEdBQUcsRUFBRSxNQUFNLEdBQUcsR0FBRyxDQUFDLEVBQUU7QUFDOUQsaUJBQVcsRUFBRSxVQUFVLE9BQU8sT0FBTyxPQUFPLEdBQUcsRUFBRSxNQUFNLEdBQUcsR0FBRyxFQUFFLENBQUM7QUFBQSxJQUNsRTtBQUNBLFdBQU87QUFBQSxFQUNUO0FBQ0EsaUJBQWUsa0JBQWtCLFFBQTRGO0FBQzNILFFBQUk7QUFDRixZQUFNLFFBQVEsT0FBTyxLQUFLLENBQUMsTUFBTSwrQkFBK0IsS0FBSyxFQUFFLElBQUksQ0FBQyxLQUFLLE9BQU8sS0FBSyxDQUFDLE1BQU0sRUFBRSxLQUFLLFNBQVMsTUFBTSxDQUFDO0FBQzNILFVBQUksVUFBVSxRQUFXO0FBQUUsbUJBQVcsRUFBRSxPQUFPLCtDQUFpQixDQUFDO0FBQUc7QUFBQSxNQUFRO0FBQzVFLFlBQU0sT0FBT0QsTUFBS0MsS0FBSSxRQUFRLE1BQU0sR0FBRyxNQUFNLElBQUk7QUFFakQsWUFBTSxVQUFVO0FBQUEsUUFDZCxNQUFNO0FBQUEsUUFDTixzQkFBc0IsTUFBTSxvQkFBb0I7QUFBQSxRQUNoRCx3QkFBd0IsTUFBTSxvQkFBb0I7QUFBQSxRQUNsRCxzQkFBc0IsTUFBTSxvQkFBb0I7QUFBQSxNQUNsRDtBQUNBLFVBQUksTUFBcUI7QUFDekIsVUFBSSxVQUFVO0FBQ2QsaUJBQVcsS0FBSyxTQUFTO0FBQ3ZCLFlBQUk7QUFDRixrQkFBUSxVQUFVLFVBQVUsSUFBSSxJQUFJLENBQUMsRUFBRSxJQUFJLFFBQUc7QUFDOUMsZ0JBQU0sSUFBSSxNQUFNLE1BQU0sR0FBRyxFQUFFLFFBQVEsWUFBWSxRQUFRLEdBQU8sRUFBRSxDQUFDO0FBQ2pFLGNBQUksQ0FBQyxFQUFFLElBQUk7QUFBRSxzQkFBVSxRQUFRLEVBQUUsTUFBTTtBQUFJLG9CQUFRLFVBQVUsZUFBVSxFQUFFLE1BQU0sRUFBRTtBQUFHO0FBQUEsVUFBVTtBQUM5RixnQkFBTSxPQUFPLEtBQUssTUFBTSxFQUFFLFlBQVksQ0FBQztBQUN2QyxjQUFJLElBQUksU0FBUyxLQUFXO0FBQUUsb0JBQVEsVUFBVSxhQUFRLEtBQUssTUFBTSxJQUFJLFNBQVMsR0FBRyxDQUFDLElBQUk7QUFBRztBQUFBLFVBQU87QUFDbEcsb0JBQVU7QUFBUSxnQkFBTTtBQUFBLFFBQzFCLFNBQVMsS0FBSztBQUNaLGdCQUFNLElBQUk7QUFDVixvQkFBVSxPQUFPLEVBQUUsT0FBTyxRQUFRLEdBQUcsRUFBRSxNQUFNLEdBQUcsRUFBRTtBQUNsRCxrQkFBUSxVQUFVLGVBQVUsT0FBTyxFQUFFO0FBQUEsUUFDdkM7QUFBQSxNQUNGO0FBQ0EsVUFBSSxRQUFRLEtBQU0sT0FBTSxJQUFJLE1BQU0sb0RBQVksT0FBTyxHQUFHO0FBQ3hELFlBQU0sRUFBRSxXQUFXLEdBQUcsSUFBSSxNQUFNLE9BQU8sa0JBQWtCO0FBQ3pELFlBQU0sR0FBRyxNQUFNLEdBQUc7QUFDbEIsc0JBQWdCO0FBQ2hCLGlCQUFXLEVBQUUsWUFBWSxLQUFLLENBQUM7QUFDL0IsY0FBUSxVQUFVLHNCQUFPLE1BQU0sSUFBSSxJQUFJLEtBQUssTUFBTSxJQUFJLFNBQVMsR0FBRyxDQUFDLGNBQVMsSUFBSSxFQUFFO0FBQUEsSUFDcEYsU0FBUyxLQUFLO0FBQ1osaUJBQVcsRUFBRSxPQUFPLDZCQUFTLE9BQU8sR0FBRyxFQUFFLE1BQU0sR0FBRyxHQUFHLENBQUMsR0FBRyxDQUFDO0FBQUEsSUFDNUQ7QUFBQSxFQUNGO0FBa0dBLFFBQU0sV0FBVztBQUNqQixpQkFBZSxpQkFBNEQ7QUFDekUsUUFBSTtBQUNGLFlBQU0sSUFBSSxNQUFNLE1BQU0sb0JBQW9CLFFBQVEsY0FBYyxFQUFFLFFBQVEsWUFBWSxRQUFRLElBQUksRUFBRSxDQUFDO0FBQ3JHLFVBQUksQ0FBQyxFQUFFLEdBQUksUUFBTyxFQUFFLElBQUksT0FBTyxTQUFTLEdBQUc7QUFDM0MsWUFBTSxJQUFLLE1BQU0sRUFBRSxLQUFLO0FBQ3hCLGFBQU8sRUFBRSxJQUFJLE1BQU0sU0FBUyxPQUFPLEVBQUUsaUJBQWlCLEVBQUUsRUFBRTtBQUFBLElBQzVELFFBQVE7QUFBRSxhQUFPLEVBQUUsSUFBSSxPQUFPLFNBQVMsR0FBRztBQUFBLElBQUc7QUFBQSxFQUMvQztBQXFFQSxpQkFBZSxhQUE0QjtBQUN6QyxRQUFJLFdBQVcsS0FBTTtBQUNyQixlQUFTO0FBQ1AsWUFBTSxJQUFJO0FBQ1YsVUFBSSxNQUFNLEtBQU07QUFDaEIsVUFBSTtBQUNGLHlCQUFpQixTQUFTLEVBQUUsVUFBVSxnQkFBZ0IsS0FBSyxTQUFZLGFBQWEsVUFBVSxNQUFNLEdBQUc7QUFDckcsY0FBSSxNQUFNLFVBQVUsT0FBTztBQUN6QixrQkFBTSxNQUFNLGtCQUFrQixLQUFLO0FBQ25DLGdCQUFJLFFBQVEsTUFBTTtBQUNoQiwrQkFBaUI7QUFDakI7QUFBQSxZQUNGO0FBQ0EsMEJBQWMsSUFBSTtBQUNsQixZQUFBQyxXQUFVLEdBQUc7QUFBQSxVQUNmLFdBQVcsTUFBTSxVQUFVLFdBQVcsTUFBTSxVQUFVLFFBQVE7QUFDNUQsZ0JBQUk7QUFDRixvQkFBTSxJQUFJLEtBQUssTUFBTSxNQUFNLElBQUk7QUFDL0Isb0JBQU0sVUFBVSxNQUFNLFVBQVUsVUFDNUIsRUFBRSxXQUFXLEVBQUUsYUFBYSxJQUFJLE1BQU0sRUFBRSxLQUFLLFFBQVEsT0FBTyxPQUFPLEVBQUUsU0FBUyxFQUFFLEVBQUUsSUFDbEYsRUFBRSxXQUFXLEVBQUUsYUFBYSxJQUFJLE1BQU0sUUFBUSxPQUFPLE9BQU8sRUFBRSxRQUFRLEVBQUUsRUFBRTtBQUM5RSx5QkFBVyxLQUFLLGNBQWMsY0FBYyxHQUFHO0FBQzdDLG9CQUFJLENBQUMsRUFBRSxZQUFZLEVBQUcsR0FBRSxZQUFZLEtBQUssdUJBQXVCLE9BQU87QUFBQSxjQUN6RTtBQUFBLFlBQ0YsUUFBUTtBQUFBLFlBQXFDO0FBQUEsVUFDL0M7QUFBQSxRQUNGO0FBQ0E7QUFBQSxNQUNGLFFBQVE7QUFFTixjQUFNLElBQUksUUFBUSxDQUFDLE1BQU0sV0FBVyxHQUFHLEdBQUssQ0FBQztBQUM3QyxZQUFJLFVBQVUsT0FBTyxRQUFTO0FBQUEsTUFDaEM7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQU9BLFFBQU0sb0JBQW9CLE1BQWNGLE1BQUtDLEtBQUksUUFBUSxVQUFVLEdBQUcsY0FBYztBQUVwRixpQkFBZSxvQkFBK0Q7QUFDNUUsUUFBSTtBQUNGLFlBQU0sSUFBSSxLQUFLLE1BQU0sTUFBTSxTQUFTLGtCQUFrQixHQUFHLE1BQU0sQ0FBQztBQUNoRSxhQUFPO0FBQUEsUUFDTCxPQUFPLE9BQU8sRUFBRSxVQUFVLFlBQVksRUFBRSxVQUFVLE1BQU0sV0FBVyxFQUFFLEtBQUssSUFBSSxFQUFFLFFBQVE7QUFBQSxRQUN4RixNQUFNLEVBQUUsU0FBUztBQUFBLE1BQ25CO0FBQUEsSUFDRixRQUFRO0FBQUUsYUFBTyxFQUFFLE9BQU8sSUFBSSxNQUFNLE1BQU07QUFBQSxJQUFHO0FBQUEsRUFDL0M7QUFDQSxpQkFBZSxrQkFBa0IsS0FBc0Q7QUFDckYsVUFBTStCLFdBQVUsa0JBQWtCLEdBQUcsS0FBSyxVQUFVLEtBQUssTUFBTSxDQUFDLEdBQUcsTUFBTSxFQUFFLE1BQU0sTUFBTSxNQUFTO0FBQUEsRUFDbEc7QUFDQSxpQkFBZSwyQkFBNEM7QUFDekQsWUFBUSxNQUFNLGtCQUFrQixHQUFHO0FBQUEsRUFDckM7QUFDQSxpQkFBZSx5QkFBeUIsT0FBOEI7QUFDcEUsVUFBTSxrQkFBa0IsRUFBRSxPQUFPLE9BQU8sTUFBTSxrQkFBa0IsR0FBRyxLQUFLLENBQUM7QUFBQSxFQUMzRTtBQWlIQSxNQUFJLGVBQWU7QUFDbkIsTUFBSSxvQkFBb0I7QUE4QnhCLFFBQU0sYUFBYSxNQUFjaEMsTUFBS0MsS0FBSSxRQUFRLFVBQVUsR0FBRyxhQUFhO0FBQzVFLGlCQUFlLGtCQUE4RDtBQUMzRSxRQUFJO0FBQ0YsWUFBTSxJQUFJLEtBQUssTUFBTSxNQUFNLFNBQVMsV0FBVyxHQUFHLE1BQU0sQ0FBQztBQUN6RCxhQUFPLEVBQUUsTUFBTSxFQUFFLFNBQVMsTUFBTSxRQUFRLE9BQU8sRUFBRSxXQUFXLFdBQVcsRUFBRSxTQUFTLEdBQUc7QUFBQSxJQUN2RixRQUFRO0FBQUUsYUFBTyxFQUFFLE1BQU0sT0FBTyxRQUFRLEdBQUc7QUFBQSxJQUFHO0FBQUEsRUFDaEQ7QUFDQSxpQkFBZSxnQkFBZ0IsUUFBK0I7QUFDNUQsVUFBTStCLFdBQVUsV0FBVyxHQUFHLEtBQUssVUFBVSxFQUFFLE1BQU0sTUFBTSxPQUFPLEdBQUcsTUFBTSxDQUFDLEdBQUcsTUFBTSxFQUFFLE1BQU0sTUFBTSxNQUFTO0FBQUEsRUFDOUc7QUFtQkEsaUJBQWUsWUFBMkI7QUFDeEMsVUFBTSxXQUFXaEMsTUFBSyxNQUFNLE1BQU0sTUFBTSxNQUFNLElBQUk7QUFDbEQsVUFBTSxXQUFXQyxLQUFJO0FBQ3JCLFVBQU0sTUFBTSxNQUFNLGtCQUFrQjtBQUNwQyxVQUFNLFlBQVksUUFBUSxJQUFJLHFCQUFxQixPQUFPLElBQUk7QUFDOUQsVUFBTSxlQUFlLFFBQVEsSUFBSSx3QkFBd0I7QUFDekQsVUFBTSxXQUFXLElBQUk7QUFDckIsVUFBTSxXQUFXRCxNQUFLLFVBQVUsTUFBTSxhQUFhLFlBQVksT0FBTyxPQUFPLGlCQUFpQjtBQUM5RixVQUFNLFVBQVV5QixvQkFBbUIsUUFBUTtBQUMzQyxVQUFNLGVBQWViLFlBQVcsT0FBTztBQUd2QyxRQUFJLFFBQVE7QUFDWix3QkFBb0I7QUFDcEIsUUFBSSxXQUFXO0FBQUEsSUFFZixXQUFXLGFBQWEsSUFBSTtBQUMxQixjQUFRO0FBQ1IsVUFBSSxhQUFhLFFBQVMscUJBQW9CO0FBQUEsSUFDaEQsV0FBVyxjQUFjO0FBQ3ZCLFVBQUksY0FBYztBQUFFLGdCQUFRO0FBQVMsNEJBQW9CO0FBQUEsTUFBTSxNQUMxRCxTQUFRLFFBQVEsd0dBQXFFO0FBQUEsSUFDNUYsT0FBTztBQUNMLGNBQVEsV0FBV1ksaUJBQWdCLElBQUtaLFlBQVcsUUFBUSxJQUFJLFdBQVdZLGlCQUFnQjtBQUMxRixVQUFJLFVBQVUsTUFBTSxjQUFjO0FBQUUsZ0JBQVE7QUFBUyw0QkFBb0I7QUFBQSxNQUFNO0FBQUEsSUFDakY7QUFDQSxtQkFBZTtBQUNmLFVBQU0sVUFBVSxVQUFVLE9BQU8scUJBQXFCWixZQUFXLEtBQUs7QUFDdEUsYUFBUztBQUFBLE1BQ1AsR0FBRztBQUFBLE1BQ0gsTUFBTSxVQUFVLFNBQVM7QUFBQSxNQUN6QixjQUFjLFVBQVcsb0JBQW9CLEdBQUcsS0FBSyxlQUFlLFFBQVM7QUFBQSxJQUMvRTtBQUNBLFFBQUk7QUFDSixRQUFJLG1CQUFtQjtBQUNyQixhQUFPO0FBQUEsUUFDTCxTQUFTLFFBQVE7QUFBQSxRQUNqQixNQUFNLENBQUMsS0FBSztBQUFBO0FBQUEsUUFDWixLQUFLLEVBQUUsc0JBQXNCLElBQUk7QUFBQSxNQUNuQztBQUFBLElBQ0YsV0FBVyxXQUFXLE1BQU0sU0FBUyxLQUFLLEdBQUc7QUFDM0MsYUFBTztBQUFBLFFBQ0wsU0FBUyxRQUFRO0FBQUEsUUFDakIsTUFBTSxDQUFDLEtBQUs7QUFBQTtBQUFBLFFBQ1osS0FBSyxRQUFRLEtBQUs7QUFBQSxRQUNsQixLQUFLLEVBQUUsc0JBQXNCLElBQUk7QUFBQSxNQUNuQztBQUFBLElBQ0YsV0FBVyxTQUFTO0FBQ2xCLFlBQU0sT0FBT0csWUFBVyxLQUFLO0FBQzdCLGFBQU87QUFBQSxRQUNMLFNBQVMsUUFBUTtBQUFBLFFBQ2pCLE1BQU0sQ0FBQyxZQUFZLE9BQU8sS0FBSztBQUFBLFFBQy9CLEtBQUs7QUFBQTtBQUFBLFFBQ0wsS0FBSyxFQUFFLHNCQUFzQixJQUFJO0FBQUEsTUFDbkM7QUFBQSxJQUNGLFdBQVcsVUFBVTtBQUNuQixhQUFPO0FBQUEsUUFDTCxTQUFTLFFBQVE7QUFBQSxRQUNqQixNQUFNLENBQUNmLE1BQUssUUFBUSxlQUFlLGVBQWUsQ0FBQztBQUFBLFFBQ25ELEtBQUssRUFBRSxzQkFBc0IsSUFBSTtBQUFBLE1BQ25DO0FBQUEsSUFDRixPQUFPO0FBQ0wsYUFBTztBQUFBLFFBQ0wsU0FBUyxRQUFRO0FBQUE7QUFBQTtBQUFBLFFBR2pCLE1BQU0sQ0FBQyxZQUFZLE9BQU9BLE1BQUssVUFBVSxZQUFZLGdCQUFnQixPQUFPLGNBQWMsQ0FBQztBQUFBLFFBQzNGLEtBQUssRUFBRSxzQkFBc0IsSUFBSTtBQUFBLE1BQ25DO0FBQUEsSUFDRjtBQUNBLGlCQUFhLElBQUkseUJBQXlCLE1BQU07QUFBQSxNQUM5QyxlQUFla0I7QUFBQTtBQUFBO0FBQUEsTUFHZixTQUFTLENBQUMsT0FBTztBQUNmLGlCQUFTLElBQUksa0JBQWtCLG9CQUFvQixHQUFHLElBQUksSUFBSSxHQUFHLEtBQUs7QUFDdEUsa0JBQVUsTUFBTTtBQUNoQixtQkFBVyxJQUFJLGdCQUFnQjtBQUMvQixzQkFBYztBQUNkLGFBQUssV0FBVztBQUNoQixnQkFBUSxRQUFRLDZCQUE2QixHQUFHLElBQUksYUFBYSxHQUFHLE9BQU8sVUFBVSxPQUFPLElBQUksR0FBRyxVQUFVLFdBQVcsWUFBWSxHQUFHLG9CQUFvQixlQUFlLEVBQUUsS0FBSyxFQUFFLEdBQUc7QUFBQSxNQUN4TDtBQUFBLElBQ0YsQ0FBQztBQUNELFFBQUk7QUFDRixZQUFNLFdBQVcsTUFBTTtBQUFBLElBQ3pCLFNBQVMsS0FBSztBQUNaLFlBQU0sVUFBVSxNQUFNO0FBQUUsWUFBSTtBQUFFLGlCQUFPLEtBQUssVUFBVSxHQUFHO0FBQUEsUUFBRyxRQUFRO0FBQUUsaUJBQU8sT0FBTyxHQUFHO0FBQUEsUUFBRztBQUFBLE1BQUUsR0FBRyxFQUFFLE1BQU0sR0FBRyxHQUFHO0FBQzNHLGVBQVMsRUFBRSxHQUFHLFFBQVEsV0FBVyxVQUFVLFdBQVcsT0FBTztBQUM3RCxjQUFRLFFBQVEsaUJBQWlCLE1BQU0sRUFBRTtBQUFBLElBQzNDO0FBQUEsRUFDRjtBQUdBLFFBQU0saUJBQWlCLElBQUk7QUFBQSxJQUN6QixTQUFTLGlCQUNMLENBQUMsY0FBYyxJQUNmLENBQUNnQixlQUFjbEMsTUFBSyxNQUFNLE1BQU0sTUFBTSxpQkFBaUIsWUFBWSxDQUFDLEVBQUUsSUFBSTtBQUFBLEVBQ2hGO0FBNmFBLFFBQU0sa0JBQWtCLE1BQWNBLE1BQUtDLEtBQUksUUFBUSxVQUFVLEdBQUcsbUJBQW1CO0FBQ3ZGLGlCQUFlLGFBQXdGO0FBQ3JHLFFBQUk7QUFDRixhQUFPLEtBQUssTUFBTSxNQUFNLFNBQVMsZ0JBQWdCLEdBQUcsTUFBTSxDQUFDO0FBQUEsSUFDN0QsUUFBUTtBQUFFLGFBQU87QUFBQSxJQUFNO0FBQUEsRUFDekI7QUFDQSxpQkFBZSxXQUFXLEtBQW1DO0FBQzNELFFBQUk7QUFBRSxZQUFNK0IsV0FBVSxnQkFBZ0IsR0FBRyxLQUFLLFVBQVUsSUFBSSxVQUFVLENBQUMsR0FBRyxNQUFNO0FBQUEsSUFBRyxRQUFRO0FBQUEsSUFBb0I7QUFBQSxFQUNqSDtBQUVBLGlCQUFlLGVBQThDO0FBQzNELFVBQU0sUUFBUSxNQUFNLFdBQVc7QUFDL0IsVUFBTSxNQUFNLElBQUksY0FBYztBQUFBLE1BQzVCLE9BQU8sT0FBTyxTQUFTO0FBQUEsTUFDdkIsUUFBUSxPQUFPLFVBQVU7QUFBQSxNQUN6QixHQUFJLE9BQU8sTUFBTSxVQUFhLE9BQU8sTUFBTSxTQUFZLEVBQUUsR0FBRyxNQUFNLEdBQUcsR0FBRyxNQUFNLEVBQUUsSUFBSSxDQUFDO0FBQUEsTUFDckYsVUFBVTtBQUFBLE1BQ1YsV0FBVztBQUFBLE1BQ1gsTUFBTTtBQUFBLE1BQ04saUJBQWlCO0FBQUE7QUFBQSxNQUNqQixPQUFPO0FBQUE7QUFBQTtBQUFBLE1BR1AsZUFBZTtBQUFBLE1BQ2YsaUJBQWlCLEVBQUUsR0FBRyxVQUFVLFlBQVksbUJBQW1CLEdBQUcsUUFBUSxHQUFHO0FBQUEsTUFDN0UsaUJBQWlCO0FBQUEsTUFDakIsZ0JBQWdCO0FBQUEsUUFDZCxTQUFTO0FBQUEsUUFDVCxrQkFBa0I7QUFBQSxRQUNsQixTQUFTO0FBQUEsUUFDVCxpQkFBaUI7QUFBQSxRQUNqQix5QkFBeUI7QUFBQSxRQUN6QixhQUFhO0FBQUEsUUFDYixZQUFZO0FBQUEsUUFDWixVQUFVO0FBQUEsTUFDWjtBQUFBLElBQ0YsQ0FBQztBQUNELFFBQUksS0FBSyxpQkFBaUIsTUFBTSxJQUFJLEtBQUssQ0FBQztBQUMxQyxRQUFJLEdBQUcsU0FBUyxNQUFNO0FBQUUsV0FBSyxXQUFXLEdBQUc7QUFBQSxJQUFHLENBQUM7QUFHL0MsUUFBSSxZQUFZLHFCQUFxQixDQUFDLEVBQUUsSUFBSSxNQUFNO0FBQ2hELFVBQUksZUFBZSxLQUFLLEdBQUcsRUFBRyxNQUFLLE1BQU0sYUFBYSxHQUFHO0FBQ3pELGFBQU8sRUFBRSxRQUFRLE9BQU87QUFBQSxJQUMxQixDQUFDO0FBQ0QsUUFBSSxZQUFZLEdBQUcsaUJBQWlCLENBQUMsR0FBRyxRQUFRO0FBQzlDLFlBQU0sS0FBSyxDQUFDLEdBQUcsY0FBYyxFQUFFLEtBQUssQ0FBQyxNQUFNLFFBQVEsS0FBSyxJQUFJLFdBQVcsR0FBRyxDQUFDLEdBQUcsS0FBSyxJQUFJLFdBQVcsR0FBRyxDQUFDLEdBQUcsQ0FBQztBQUMxRyxVQUFJLENBQUMsSUFBSTtBQUNQLGdCQUFRLE9BQU8seUJBQXlCLElBQUksTUFBTSxHQUFHLEdBQUcsQ0FBQyxFQUFFO0FBQzNELFVBQUUsZUFBZTtBQUFBLE1BQ25CO0FBQUEsSUFDRixDQUFDO0FBRUQsUUFBSSxTQUFTLGdCQUFnQjtBQUMzQixXQUFLLElBQUksUUFBUSxjQUFjO0FBQUEsSUFDakMsT0FBTztBQUNMLFdBQUssSUFBSSxTQUFTaEMsTUFBSyxNQUFNLE1BQU0sTUFBTSxpQkFBaUIsWUFBWSxDQUFDO0FBQUEsSUFDekU7QUFHQSxRQUFJLFlBQVksS0FBSyxtQkFBbUIsTUFBTTtBQUM1QyxVQUFJLENBQUMsSUFBSSxZQUFZLEdBQUc7QUFDdEIsWUFBSSxZQUFZLEtBQUsscUJBQXFCLE9BQU8sV0FBVyxFQUFFLGNBQWMsRUFBRSxDQUFDO0FBQUEsTUFDakY7QUFBQSxJQUNGLENBQUM7QUFDRCxXQUFPO0FBQUEsRUFDVDtBQUVBLEVBQUFDLEtBQUksVUFBVSxFQUFFLEtBQUssTUFBTTtBQUV6QixRQUFJLFFBQVEsSUFBSSx5QkFBeUIsT0FBTyxRQUFRLElBQUksOEJBQThCLFFBQVE7QUFDaEcsY0FBUSxJQUFJLG1CQUFtQjtBQUFBLElBQ2pDO0FBRUEsSUFBQUEsS0FBSSxrQkFBa0IsaUJBQWlCO0FBQ3ZDLElBQUFJLFdBQVU7QUFDVixJQUFBSSxjQUFhO0FBRWIsUUFBSVIsS0FBSSxXQUFZLFlBQVcsTUFBTTtBQUFFLFdBQUssZ0JBQWdCO0FBQUEsSUFBRyxHQUFHLEdBQU07QUFFeEUsVUFBTSxNQUFNLFFBQ1I7QUFBQSxNQUNFO0FBQUEsTUFDQSxxQkFBcUIsY0FBYztBQUFBLE1BQ25DO0FBQUEsTUFDQSxzQkFBc0IsY0FBYztBQUFBLE1BQ3BDO0FBQUEsTUFDQTtBQUFBLElBQ0YsRUFBRSxLQUFLLElBQUksSUFDWDtBQUNKLFlBQVEsZUFBZSxXQUFXLGtCQUFrQixDQUFDLFNBQVMsYUFBYTtBQUN6RSxlQUFTO0FBQUEsUUFDUCxpQkFBaUI7QUFBQSxVQUNmLEdBQUcsUUFBUTtBQUFBLFVBQ1gsMkJBQTJCLENBQUMsR0FBRztBQUFBLFFBQ2pDO0FBQUEsTUFDRixDQUFDO0FBQUEsSUFDSCxDQUFDO0FBRUQsSUFBQThCLGFBQVk7QUFFWixTQUFLLGFBQWEsRUFBRSxLQUFLLENBQUMsUUFBUTtBQUNoQyxVQUFJLFFBQVEsS0FBTTtBQUNsQixVQUFJLFFBQVEsSUFBSSx5QkFBeUIsSUFBSyxnQkFBZSxHQUFHO0FBQ2hFLFVBQUksUUFBUSxJQUFJLDhCQUE4QixLQUFLO0FBQ2pELFlBQUksWUFBWSxLQUFLLG1CQUFtQixNQUFNO0FBQzVDLGVBQUssaUJBQWlCLEdBQUc7QUFBQSxRQUMzQixDQUFDO0FBQUEsTUFDSDtBQUdBLFlBQU0sT0FBTyxRQUFRLElBQUk7QUFDekIsVUFBSSxTQUFTLFVBQWEsU0FBUyxJQUFJO0FBQ3JDLFlBQUksWUFBWSxLQUFLLG1CQUFtQixNQUFNO0FBQzVDLHFCQUFXLE1BQU07QUFDZixrQkFBTSxZQUFZO0FBQ2hCLGtCQUFJO0FBQ0Ysc0JBQU0sTUFBTSxNQUFNLElBQUksWUFBWSxZQUFZO0FBQzlDLHNCQUFNLEVBQUUsV0FBVyxHQUFHLElBQUksTUFBTSxPQUFPLGtCQUFrQjtBQUN6RCxzQkFBTSxHQUFHLE1BQU0sSUFBSSxNQUFNLENBQUM7QUFDMUIsd0JBQVEsSUFBSSxlQUFlLElBQUksSUFBSSxJQUFJLFFBQVEsRUFBRSxLQUFLLElBQUksSUFBSSxRQUFRLEVBQUUsTUFBTSxFQUFFO0FBQUEsY0FDbEYsU0FBUyxLQUFLO0FBQ1osd0JBQVEsSUFBSSxrQkFBa0IsT0FBTyxHQUFHLEVBQUUsTUFBTSxHQUFHLEdBQUcsQ0FBQyxFQUFFO0FBQUEsY0FDM0Q7QUFDQSxvQkFBTUksUUFBT2xDO0FBQ2IseUJBQVcsTUFBTWtDLE1BQUssS0FBSyxDQUFDLEdBQUcsR0FBRztBQUFBLFlBQ3BDLEdBQUc7QUFBQSxVQUNMLEdBQUcsT0FBTyxRQUFRLElBQUksaUNBQWlDLElBQU0sQ0FBQztBQUFBLFFBQ2hFLENBQUM7QUFBQSxNQUNIO0FBR0EsVUFBSSxRQUFRLElBQUkseUJBQXlCLEtBQUs7QUFDNUMsWUFBSSxZQUFZLEtBQUssbUJBQW1CLE1BQU07QUFDNUMscUJBQVcsTUFBTTtBQUNmLGtCQUFNLFlBQVk7QUFDaEIsa0JBQUk7QUFDRixzQkFBTSxJQUFLLE1BQU0sSUFBSSxZQUFZLGtCQUFrQjtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLHVCQXlCNUMsSUFBSTtBQUNYLHdCQUFRLElBQUksWUFBWSxDQUFDLEVBQUU7QUFBQSxjQUM3QixTQUFTLEtBQUs7QUFDWix3QkFBUSxJQUFJLGtCQUFrQixPQUFPLEdBQUcsRUFBRSxNQUFNLEdBQUcsR0FBRyxDQUFDLEVBQUU7QUFBQSxjQUMzRDtBQUNBLGNBQUFsQyxLQUFJLEtBQUssQ0FBQztBQUFBLFlBQ1osR0FBRztBQUFBLFVBQ0wsR0FBRyxPQUFPLFFBQVEsSUFBSSxpQ0FBaUMsR0FBSyxDQUFDO0FBQUEsUUFDL0QsQ0FBQztBQUFBLE1BQ0g7QUFHQSxVQUFJLFFBQVEsSUFBSSw0QkFBNEIsS0FBSztBQUMvQyxZQUFJLFlBQVksS0FBSyxtQkFBbUIsTUFBTTtBQUM1QyxxQkFBVyxNQUFNO0FBQ2Ysa0JBQU0sWUFBWTtBQUNoQixrQkFBSTtBQUNGLHNCQUFNLElBQUssTUFBTSxJQUFJLFlBQVk7QUFBQSxrQkFDL0I7QUFBQSxrQkFBMEY7QUFBQSxnQkFDNUY7QUFDQSxzQkFBTSxLQUFLLElBQUk7QUFDZix3QkFBUSxJQUFJLGVBQWUsS0FBSyxPQUFPLE9BQU8saUJBQWlCLENBQUMsRUFBRTtBQUNsRSxnQkFBQUEsS0FBSSxLQUFLLEtBQUssSUFBSSxDQUFDO0FBQUEsY0FDckIsU0FBUyxLQUFLO0FBQ1osd0JBQVEsSUFBSSxxQkFBcUIsT0FBTyxHQUFHLEVBQUUsTUFBTSxHQUFHLEdBQUcsQ0FBQyxFQUFFO0FBQzVELGdCQUFBQSxLQUFJLEtBQUssQ0FBQztBQUFBLGNBQ1o7QUFBQSxZQUNGLEdBQUc7QUFBQSxVQUNMLEdBQUcsSUFBSztBQUFBLFFBQ1YsQ0FBQztBQUFBLE1BQ0g7QUFBQSxJQUNGLENBQUM7QUFDRCxTQUFLLFVBQVU7QUFFZixJQUFBQSxLQUFJLEdBQUcsWUFBWSxNQUFNO0FBQ3ZCLFVBQUksY0FBYyxjQUFjLEVBQUUsV0FBVyxFQUFHLE1BQUssYUFBYTtBQUFBLElBQ3BFLENBQUM7QUFBQSxFQUNILENBQUM7QUFFRCxpQkFBZSxpQkFBaUIsS0FBbUM7QUFDakUsVUFBTSxVQUE0QyxDQUFDO0FBQ25ELFVBQU0sUUFBUSxPQUFPLE1BQWMsVUFBMkQ7QUFDNUYsVUFBSTtBQUNGLGNBQU0sQ0FBQyxJQUFJLE1BQU0sSUFBSSxNQUFNLE1BQU07QUFDakMsZ0JBQVEsS0FBSyxDQUFDLE1BQU0sSUFBSSxNQUFNLENBQUM7QUFBQSxNQUNqQyxTQUFTLEtBQUs7QUFDWixnQkFBUSxLQUFLLENBQUMsTUFBTSxPQUFPLE9BQU8sR0FBRyxFQUFFLE1BQU0sR0FBRyxHQUFHLENBQUMsQ0FBQztBQUFBLE1BQ3ZEO0FBQUEsSUFDRjtBQUNBLFVBQU0sS0FBSyxDQUFDLFNBQW1DLElBQUksWUFBWSxrQkFBa0IsTUFBTSxJQUFJO0FBRTNGLFVBQU0sTUFBTSwyRUFBNkMsWUFBWTtBQUNuRSxZQUFNLElBQUssTUFBTSxHQUFHO0FBQUE7QUFBQTtBQUFBLFdBR2Y7QUFDTCxZQUFNLFNBQVMsS0FBSyxNQUFNLENBQUM7QUFDM0IsWUFBTSxJQUFJLE9BQU8sQ0FBQyxLQUFLO0FBQ3ZCLFlBQU0sTUFBTSxPQUFPLENBQUMsS0FBSztBQUN6QixZQUFNLE9BQU8sQ0FBQyxNQUF1QixNQUFNLGlCQUFpQixNQUFNO0FBQ2xFLGFBQU8sQ0FBQyxLQUFLLENBQUMsS0FBSyxLQUFLLEdBQUcsR0FBRyxXQUFXLENBQUMsWUFBWSxHQUFHLEVBQUU7QUFBQSxJQUM3RCxDQUFDO0FBQ0QsVUFBTSxNQUFNLGdHQUF5QyxZQUFZO0FBQy9ELFlBQU0sSUFBSyxNQUFNLEdBQUcsZ0RBQWdEO0FBQ3BFLFlBQU0sUUFBUSxDQUFDLGVBQWUsV0FBVyxlQUFlLGVBQWUsaUJBQWlCLGVBQWUsZUFBZSxhQUFhLGlCQUFpQixRQUFRLGlCQUFpQixVQUFVLFVBQVUsWUFBWSxZQUFZLGFBQWEsVUFBVSxjQUFjLGFBQWEsWUFBWSxrQkFBa0IsZUFBZSxxQkFBcUIsZ0JBQWdCLGtCQUFrQixpQkFBaUIsaUJBQWlCLGFBQWEsaUJBQWlCLGdCQUFnQixhQUFhLHNCQUFzQixrQkFBa0IsbUJBQW1CLGlCQUFpQixlQUFlLFlBQVksYUFBYSxrQkFBa0IsWUFBWSxjQUFjLFlBQVksa0JBQWtCLGNBQWMsZ0JBQWdCLGNBQWM7QUFDdHJCLFlBQU0sTUFBTSxNQUFNLEtBQUssQ0FBQyxJQUFJLEVBQUUsTUFBTSxHQUFHO0FBQ3ZDLFlBQU0sYUFBYSxJQUFJLE9BQU8sQ0FBQyxNQUFNLENBQUMsTUFBTSxTQUFTLENBQUMsQ0FBQztBQUN2RCxhQUFPLENBQUMsV0FBVyxXQUFXLEdBQUcsUUFBUSxDQUFDLEVBQUU7QUFBQSxJQUM5QyxDQUFDO0FBQ0QsVUFBTSxNQUFNLGdFQUFtQixZQUFZO0FBQ3pDLFlBQU0sU0FBUyxJQUFJLFlBQVksT0FBTztBQUN0QyxZQUFNLEdBQUcscURBQXFELEVBQUUsTUFBTSxNQUFNLE1BQU07QUFDbEYsWUFBTSxJQUFJLFFBQVEsQ0FBQyxPQUFPLFdBQVcsSUFBSSxJQUFLLENBQUM7QUFDL0MsWUFBTSxRQUFRLElBQUksWUFBWSxPQUFPO0FBQ3JDLGFBQU8sQ0FBQyxVQUFVLFFBQVEsR0FBRyxNQUFNLFdBQU0sS0FBSyxFQUFFO0FBQUEsSUFDbEQsQ0FBQztBQUNELFVBQU0sTUFBTSxvRkFBa0MsWUFBWTtBQUN4RCxZQUFNLFNBQVMsY0FBYyxjQUFjLEVBQUU7QUFDN0MsWUFBTSxJQUFLLE1BQU0sR0FBRyxnREFBZ0Q7QUFDcEUsWUFBTSxJQUFJLFFBQVEsQ0FBQyxPQUFPLFdBQVcsSUFBSSxHQUFHLENBQUM7QUFDN0MsWUFBTSxRQUFRLGNBQWMsY0FBYyxFQUFFO0FBQzVDLGFBQU8sQ0FBQyxNQUFNLFVBQVUsVUFBVSxRQUFRLFVBQVUsQ0FBQyxZQUFZLE1BQU0sU0FBSSxLQUFLLEVBQUU7QUFBQSxJQUNwRixDQUFDO0FBQ0QsVUFBTSxNQUFNLCtEQUF1QixZQUFZO0FBQzdDLFlBQU0sT0FBUSxNQUFNLEdBQUcsK0VBQWlGO0FBQ3hHLFlBQU0sWUFBWSxRQUFRLGdHQUF3RDtBQUNsRixhQUFPLENBQUMsUUFBUSxPQUFPLFFBQVEsSUFBSSxJQUFJLFNBQVMsRUFBRTtBQUFBLElBQ3BELENBQUM7QUFDRCxVQUFNLE1BQU0sc0VBQW1DLFlBQVk7QUFDekQsWUFBTSxJQUFLLE1BQU0sR0FBRyx5RUFBeUU7QUFDN0YsYUFBTyxDQUFDLEVBQUUsV0FBVyxHQUFHLEtBQUssRUFBRSxTQUFTLFdBQVcsR0FBRyxFQUFFLE1BQU0sR0FBRyxFQUFFLENBQUM7QUFBQSxJQUN0RSxDQUFDO0FBQ0QsVUFBTSxNQUFNLG9HQUF5QixZQUFZO0FBQy9DLFlBQU0sVUFBVTtBQUNoQixZQUFNLFFBQVMsTUFBTSxHQUFHLHVCQUF1QixLQUFLLFVBQVUsT0FBTyxDQUFDLHNFQUFzRTtBQUM1SSxVQUFJLENBQUMsTUFBTSxTQUFTLFdBQVcsRUFBRyxRQUFPLENBQUMsT0FBTyxnQ0FBaUIsTUFBTSxNQUFNLEdBQUcsRUFBRSxDQUFDLEVBQUU7QUFFdEYsWUFBTSxJQUFJLFFBQVEsQ0FBQyxPQUFPLFdBQVcsSUFBSSxHQUFLLENBQUM7QUFDL0MsWUFBTSxRQUFTLE1BQU0sR0FBRztBQUFBO0FBQUE7QUFBQTtBQUFBLFNBSXJCO0FBQ0gsWUFBTSxJQUFJLEtBQUssTUFBTSxLQUFLO0FBQzFCLGFBQU8sQ0FBQyxFQUFFLFlBQVksZUFBZSxFQUFFLGFBQWEsR0FBRyxXQUFXLEVBQUUsT0FBTyxRQUFRLEVBQUUsUUFBUSxFQUFFO0FBQUEsSUFDakcsQ0FBQztBQUVELFFBQUksU0FBUztBQUNiLGVBQVcsQ0FBQyxNQUFNLElBQUksTUFBTSxLQUFLLFNBQVM7QUFDeEMsY0FBUSxJQUFJLGlCQUFpQixLQUFLLFNBQVMsTUFBTSxNQUFNLElBQUksTUFBTSxPQUFPLE1BQU0sQ0FBQyxFQUFFO0FBQ2pGLFVBQUksQ0FBQyxHQUFJLFdBQVU7QUFBQSxJQUNyQjtBQUNBLFlBQVEsSUFBSSw4QkFBOEIsUUFBUSxTQUFTLE1BQU0sSUFBSSxRQUFRLE1BQU0sRUFBRTtBQUNyRixJQUFBQSxLQUFJLEtBQUssV0FBVyxJQUFJLElBQUksQ0FBQztBQUFBLEVBQy9CO0FBR0EsRUFBQUEsS0FBSSxHQUFHLGVBQWUsQ0FBQyxNQUFNO0FBQzNCLFFBQUksZUFBZSxRQUFRLFdBQVcsVUFBVSxXQUFXO0FBQ3pELFFBQUUsZUFBZTtBQUNqQixnQkFBVSxNQUFNO0FBQ2hCLFdBQUssV0FBVyxLQUFLLEVBQUUsUUFBUSxNQUFNQSxLQUFJLEtBQUssQ0FBQztBQUFBLElBQ2pEO0FBQUEsRUFDRixDQUFDO0FBQ0QsRUFBQUEsS0FBSSxHQUFHLHFCQUFxQixNQUFNO0FBQ2hDLFFBQUksUUFBUSxhQUFhLFNBQVUsQ0FBQUEsS0FBSSxLQUFLO0FBQUEsRUFDOUMsQ0FBQztBQUNIO0FBMTJDVztBQXlCQTtBQU9BO0FBZUE7QUE0QkE7QUEwRkE7QUFtQkE7QUE0QkE7QUE0REE7QUFVQTtBQWdCQTtBQWdCQTtBQWVBO0FBMkVBO0FBT0E7QUFRQTtBQVdBO0FBa0VBO0FBS0E7QUFpQkE7QUFLQTtBQVlBO0FBb0JBO0FBbUhBO0FBWUE7QUFXQTsiLAogICJuYW1lcyI6IFsiYXBwIiwgImpvaW4iLCAiZXhpc3RzU3luYyIsICJyZWFscGF0aFN5bmMiLCAid3JpdGVGaWxlIiwgImhvbWVkaXIiLCAic3Bhd24iLCAicGF0aFRvRmlsZVVSTCIsICJyZXNvbHZlIiwgInJhbmRvbVVVSUQiLCAicmFuZG9tVVVJRCIsICJyZXNvbHZlIiwgInNwYXduIiwgImpvaW4iLCAiam9pbiIsICJyZXNvbHZlIiwgInNwYXduIiwgImpvaW4iLCAiam9pbiIsICJhcHAiLCAicHVzaEV2ZW50IiwgIm5vdGlmeUV2ZW50IiwgImZvY3VzTWFpbldpbmRvdyIsICJzZXR1cFRyYXkiLCAiYXBwbHlDaHJvbWUiLCAiYXBwbHlVcGRhdGUiLCAic3Bhd24iLCAiYnVpbGRBcHBNZW51IiwgInBvcHVwTWFpbk1lbnUiLCAid2ViQXV0b3N0YXJ0SW5zdGFsbGVkIiwgImV4aXN0c1N5bmMiLCAibGFuSXBPZiIsICJjbGlFbnRyeU9mIiwgInJlcG9Sb290T2YiLCAicGtnTmFtZUF0IiwgInJ1bkNsaSIsICJicm9hZGNhc3RIb3N0U3RhdGUiLCAicGtnVmVyc2lvbkF0IiwgImVudHJ5RnJvbUNsaURpciIsICJkZXRlY3RFeHRlcm5hbFJ1bnRpbWUiLCAicmVhbHBhdGhTeW5jIiwgImhvbWVkaXIiLCAiZGV0ZWN0UmVhbEVudHJ5IiwgImJ1bmRsZWRSdW50aW1lUGF0aCIsICJidW5kbGVkUnVudGltZUluZm8iLCAibnBtT25QYXRoIiwgIndpemFyZFN1cHByZXNzZWQiLCAic2VuZGVyVHJ1c3RlZCIsICJob3N0Q2FsbCIsICJyZWdpc3RlcklwYyIsICJ3cml0ZUZpbGUiLCAidyIsICJwYXRoVG9GaWxlVVJMIiwgImFwcDIiXQp9Cg==
