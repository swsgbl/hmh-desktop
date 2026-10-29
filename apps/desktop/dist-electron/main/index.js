// apps/desktop/electron/main/index.ts
import { app as app3, BrowserWindow, dialog, ipcMain, session, shell, Tray, Notification, Menu, nativeImage, nativeTheme } from "electron";
import { join as join4, dirname, basename, isAbsolute, resolve } from "node:path";
import { existsSync as existsSync2, realpathSync as realpathSync2, readFileSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { writeFile as writeFile3, readFile, stat, rename } from "node:fs/promises";
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
  const finish = () => {
    const failed = results.filter((r) => !r[1]).length;
    console.log(`UIVERIFY SUMMARY pass=${results.length - failed}/${results.length} mode=${mode} shots=${shots}`);
    app.exit(failed === 0 ? 0 : 1);
  };
  if (process.env.HMH_DESKTOP_UIVERIFY_UPDATE === "real") {
    await step("\u66F4\u65B0(\u771F\u5B9E):\u542F\u52A8 30s \u81EA\u52A8\u68C0\u67E5 \u2192 atomgit/\u955C\u50CF\u901A\u9053\u547D\u4E2D \u2192 \u540E\u53F0\u4E0B\u8F7D\u8FDB\u5EA6\u6A2A\u5E45\u51FA\u73B0", async () => {
      return waitFor("downloading or ready banner", `var b=document.querySelector('.update-banner');
        if(!b) return {ok:false, detail:'no banner yet'};
        var t=b.textContent.replace(/\\s+/g,' ');
        return {ok: true, detail: t.slice(0,90)};`, 15e4);
    });
    await shot("update-real-downloading");
    await step('\u66F4\u65B0(\u771F\u5B9E):112MB \u6D41\u5F0F\u4E0B\u8F7D\u5B8C\u6210 \u2192 "\u91CD\u542F\u66F4\u65B0"\u6A2A\u5E45\u5C31\u7EEA(\u4E0D\u70B9\u51FB,\u4E0D\u5B89\u88C5)', async () => {
      return waitFor("ready banner", `var b=document.querySelector('.update-banner');
        var btn=b?b.querySelector('.update-restart'):null;
        var links=b?b.querySelectorAll('a').length:-1;
        return {ok: !!btn && btn.disabled===false && links===0, detail: b ? b.textContent.replace(/\\s+/g,' ').slice(0,90) : 'no banner'};`, 9e5);
    });
    await shot("update-real-ready");
    await step("\u66F4\u65B0(\u771F\u5B9E):composer/\u4FA7\u680F\u4E0D\u53D7\u6A2A\u5E45\u6324\u538B(\u4EFB\u52A1\u533A\u53EF\u7528)", async () => {
      const r = await js(`(function(){
        var ta=document.querySelector('.composer textarea'), sb=document.querySelector('.sidebar');
        var tr=ta?ta.getBoundingClientRect():null;
        return JSON.stringify({ta: !!tr && tr.height>30 && tr.bottom<=window.innerHeight, sb: !!sb && getComputedStyle(sb).display!=='none'});
      })()`);
      const p = JSON.parse(r);
      return [p.ta && p.sb, `composer \u53EF\u7528=${p.ta} \u4FA7\u680F\u6B63\u5E38=${p.sb}`];
    });
    await shot("final");
    finish();
    return;
  }
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
    await step("\u66F4\u65B0\u6A2A\u5E45:\u68C0\u67E5\u4E2D\u9759\u9ED8\u65E0\u6A2A\u5E45 \u2192 \u4E0B\u8F7D\u4E2D\u8FDB\u5EA6\u53EF\u89C1(\u5B57\u8282/\u901F\u5EA6/\u8FDB\u5EA6\u6761)", async () => {
      const stBase = { checking: false, currentVersion: "0.2.9", latest: null, notes: "", downloaded: false, error: "", channel: "", progress: null };
      win.webContents.send("update:state", { ...stBase, checking: true });
      await sleep(400);
      const silent = await js(`!document.querySelector('.update-banner')`);
      win.webContents.send("update:state", { ...stBase, latest: "v0.3.0", channel: "atomgit(\u56FD\u5185)", progress: { received: 47e6, total: 112147199, speedBps: 21e5 } });
      const dl = await waitFor("downloading banner", `var b=document.querySelector('.update-banner');
        if(!b) return {ok:false, detail:'no banner'};
        var t=b.textContent.replace(/\\s+/g,' ');
        var bar=b.querySelector('.update-bar-fill');
        var w=bar?parseFloat(bar.style.width):0;
        return {ok: t.indexOf('v0.3.0')>=0 && t.indexOf('/')>=0 && t.indexOf('/s')>=0 && w>30 && w<=100, detail: 'text='+t.slice(0,70)+' barW='+w};`, 5e3);
      await shot("update-downloading");
      return [silent && dl[0], `checking \u9759\u9ED8=${silent}; ${dl[1]}`];
    });
    await step('\u66F4\u65B0\u6A2A\u5E45:\u5C31\u7EEA\u6001"\u91CD\u542F\u66F4\u65B0"\u53EF\u70B9\u3001\u65E0\u5916\u94FE\u5F15\u5BFC,apply \u89E6\u53D1 preload \u4E14\u8FDB\u7A0B\u5B58\u6D3B', async () => {
      win.webContents.send("update:state", { checking: false, currentVersion: "0.2.9", latest: "v0.3.0", notes: "", downloaded: true, error: "", channel: "atomgit(\u56FD\u5185)", progress: null });
      const ready = await waitFor("ready banner", `var b=document.querySelector('.update-banner');
        var btn=b?b.querySelector('.update-restart'):null;
        var links=b?b.querySelectorAll('a').length:-1;
        var noExt=b?(b.textContent.indexOf('\u4E0B\u8F7D\u9875')<0 && b.textContent.indexOf('http')<0):false;
        return {ok: !!b && !!btn && btn.disabled===false && links===0 && noExt, detail: 'btn='+(btn?btn.textContent:'none')+' links='+links+' noExt='+noExt};`, 5e3);
      await shot("update-ready");
      if (!ready[0]) return ready;
      const hasBridge = await js(`typeof window.hmh.applyUpdate === 'function' && typeof window.hmh.checkUpdate === 'function'`);
      await js(`(function(){ var b=document.querySelector('.update-banner .update-restart'); if(b) b.click(); })()`);
      await sleep(800);
      const alive = await js(`!!document.querySelector('.update-banner') && !!document.querySelector('.composer textarea')`);
      return [hasBridge && alive, `preload applyUpdate/checkUpdate=${hasBridge}; \u70B9\u51FB\u540E\u6A2A\u5E45\u4E0E composer \u5B58\u6D3B=${alive}`];
    });
    await step("\u66F4\u65B0\u6A2A\u5E45:\u5931\u8D25\u6001\u9519\u8BEF\u660E\u7EC6+\u91CD\u8BD5\u6D41\u8F6C,\u7A0D\u540E\u53EF\u5173\u95ED", async () => {
      win.webContents.send("update:state", { checking: false, currentVersion: "0.2.9", latest: null, notes: "", downloaded: false, error: "\u5168\u90E8\u68C0\u67E5\u901A\u9053\u5931\u8D25(\u76F4\u8FDE:\u8D85\u65F6(8s); atomgit(\u56FD\u5185):HTTP 502; gh-proxy:\u8D85\u65F6(10s))", channel: "", progress: null });
      const err = await waitFor("error banner", `var b=document.querySelector('.update-banner');
        var btn=b?b.querySelector('.update-retry'):null;
        return {ok: !!b && b.textContent.indexOf('\u66F4\u65B0\u68C0\u67E5\u5931\u8D25')>=0 && b.textContent.indexOf('atomgit')>=0 && !!btn && btn.disabled===false, detail: b ? b.textContent.replace(/\\s+/g,' ').slice(0,90) : 'no banner'};`, 5e3);
      await shot("update-error");
      if (!err[0]) return err;
      await js(`(function(){ var b=document.querySelector('.update-banner .update-retry'); if(b) b.click(); })()`);
      const toChecking = await waitFor("banner hidden on retry", `return {ok: !document.querySelector('.update-banner'), detail: document.querySelector('.update-banner') ? 'still' : 'hidden'};`, 5e3);
      win.webContents.send("update:state", { checking: false, currentVersion: "0.2.9", latest: "v0.3.0", notes: "", downloaded: true, error: "", channel: "atomgit(\u56FD\u5185)", progress: null });
      await waitFor("ready again", `return {ok: !!document.querySelector('.update-banner .update-restart'), detail: 'ready'};`, 5e3);
      await js(`(function(){ var bs=[].slice.call(document.querySelectorAll('.update-banner button')); var b=bs.find(function(x){return x.textContent.indexOf('\u7A0D\u540E')>=0;}); if(b) b.click(); })()`);
      const dismissed = await waitFor("banner dismissed", `return {ok: !document.querySelector('.update-banner'), detail: document.querySelector('.update-banner') ? 'still' : 'dismissed'};`, 5e3);
      return [toChecking[0] && dismissed[0], `\u91CD\u8BD5\u2192checking \u6536\u8D77=${toChecking[0]}; \u7A0D\u540E\u5173\u95ED=${dismissed[0]}`];
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
  finish();
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
  { id: "direct", label: "\u76F4\u8FDE", timeoutMs: 8e3, apiUrl: (r) => githubLatest(r.github), downloadPrefix: "" },
  { id: "atomgit", label: "atomgit(\u56FD\u5185)", timeoutMs: 1e4, apiUrl: (r) => `https://api.atomgit.com/api/v5/repos/${r.atomgit}/releases?per_page=5&direction=desc`, downloadPrefix: "" },
  { id: "gh-proxy", label: "gh-proxy", timeoutMs: 1e4, apiUrl: (r) => `https://gh-proxy.com/${githubLatest(r.github)}`, downloadPrefix: "https://gh-proxy.com/" },
  { id: "ghfast", label: "ghfast", timeoutMs: 1e4, apiUrl: (r) => `https://ghfast.top/${githubLatest(r.github)}`, downloadPrefix: "https://ghfast.top/" }
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
function cmpVersion(a, b) {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  }
  return 0;
}
function normalizeRelease(json) {
  let best = null;
  for (const rel of Array.isArray(json) ? json : [json]) {
    if (typeof rel !== "object" || rel === null) continue;
    const r = rel;
    if (typeof r.tag_name !== "string" || r.tag_name === "") continue;
    const assets = Array.isArray(r.assets) ? r.assets.flatMap((a) => {
      const x = a;
      return typeof x.name === "string" && typeof x.browser_download_url === "string" ? [{ name: x.name, browser_download_url: x.browser_download_url, size: typeof x.size === "number" ? x.size : 0 }] : [];
    }) : [];
    const cur = { tag_name: r.tag_name, body: typeof r.body === "string" ? r.body : "", assets };
    if (best === null || cmpVersion(cur.tag_name, best.tag_name) > 0) best = cur;
  }
  return best;
}
function pickInstallerAsset(assets) {
  return assets.find((a) => /^HMH-Desktop-Setup-.*\.exe$/i.test(a.name)) ?? assets.find((a) => a.name.toLowerCase().endsWith(".exe")) ?? null;
}
function atomgitApiDownloadUrl(repos, tag, assetName) {
  return `https://api.atomgit.com/api/v5/repos/${repos.atomgit}/releases/${tag}/attach_files/${encodeURIComponent(assetName)}/download`;
}
function downloadCandidates(input) {
  const { channel, tag, assetUrl, assetName, repos } = input;
  let onAtomgit = normalizeChannel(channel) === "atomgit";
  try {
    if (new URL(assetUrl).hostname === "atomgit.com") onAtomgit = true;
  } catch {
  }
  if (onAtomgit) {
    const githubAssetUrl = `https://github.com/${repos.github}/releases/download/${tag}/${assetName}`;
    return [.../* @__PURE__ */ new Set([assetUrl, atomgitApiDownloadUrl(repos, tag, assetName), ...orderedDownloadMirrors(githubAssetUrl, channel)])];
  }
  return orderedDownloadMirrors(assetUrl, channel);
}
function sizeMatches(metaSize, actualBytes) {
  return !(metaSize > 0) || metaSize === actualBytes;
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
    logInfo("update", `apply requested (installer=${installerPath === null ? "none" : basename(installerPath)})`);
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
            const newer = st.latest !== null && (cmpVersion(st.currentVersion, st.latest) < 0 || UPDATE_FORCE_TAG !== "");
            const detail = newer ? `${st.notes}

\u5B89\u88C5\u5305\u6B63\u5728\u540E\u53F0\u4E0B\u8F7D,\u5B8C\u6210\u540E\u9876\u90E8\u6A2A\u5E45\u4F1A\u51FA\u73B0"\u91CD\u542F\u66F4\u65B0"\u4E00\u952E\u5B89\u88C5(\u65E0\u9700\u6253\u5F00\u4E0B\u8F7D\u9875)\u3002` : "";
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
  const UPDATE_REPOS = {
    github: process.env.UPDATE_REPO ?? "swsgbl/hmh-desktop",
    atomgit: process.env.UPDATE_REPO_ATOMGIT ?? "hongfu/hmh-desktop"
  };
  const UPDATE_FORCE_TAG = process.env.HMH_DESKTOP_UPDATE_FORCE_TAG ?? "";
  let updateState = { checking: false, currentVersion: app3.getVersion(), latest: null, notes: "", downloaded: false, error: "", channel: "", progress: null };
  let installerPath = null;
  const bumpUpdate = (patch) => {
    updateState = { ...updateState, ...patch };
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send("update:state", updateState);
    }
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
    logInfo("update", `checking\u2026 (current v${app3.getVersion()})${UPDATE_FORCE_TAG !== "" ? ` force-tag=${UPDATE_FORCE_TAG}` : ""}`);
    const failures = [];
    try {
      const sticky = await loadStickyChannel();
      const channels = orderedCheckChannels(sticky ?? void 0);
      for (const ch of channels) {
        let rel = null;
        try {
          const r = await fetch(ch.apiUrl(UPDATE_REPOS), {
            headers: { "user-agent": "hmh-desktop-updater" },
            signal: AbortSignal.timeout(ch.timeoutMs)
          });
          if (!r.ok) {
            failures.push({ label: ch.label, reason: `HTTP ${r.status}` });
            logInfo("update", `${ch.label} \u2192 HTTP ${r.status}`);
            continue;
          }
          rel = normalizeRelease(await r.json());
          if (rel === null) {
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
        const tag = rel.tag_name;
        logInfo("update", `latest=${tag} assets=${(rel.assets ?? []).length} via ${ch.label}${sticky === ch.id ? "(sticky)" : ""}`);
        await saveStickyChannel(ch.id);
        bumpUpdate({ checking: false, latest: tag, notes: String(rel.body ?? "").slice(0, 600), channel: ch.id });
        if ((UPDATE_FORCE_TAG !== "" || cmpVersion(app3.getVersion(), tag) < 0) && !updateState.downloaded) {
          void downloadInstaller(rel.assets ?? [], tag);
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
  async function downloadInstaller(assets, tag) {
    try {
      const asset = pickInstallerAsset(assets);
      if (asset === null) {
        bumpUpdate({ error: "release \u65E0\u5B89\u88C5\u5305\u8D44\u4EA7" });
        return;
      }
      const dest = join4(app3.getPath("temp"), asset.name);
      try {
        const st = await stat(dest);
        if (sizeMatches(asset.size, st.size)) {
          installerPath = dest;
          bumpUpdate({ downloaded: true, progress: null });
          logInfo("update", `\u590D\u7528\u5DF2\u4E0B\u8F7D ${asset.name}(${Math.round(st.size / 1e6)}MB) \u2192 ${dest}`);
          return;
        }
      } catch {
      }
      const candidates = downloadCandidates({ channel: updateState.channel, tag, assetUrl: asset.browser_download_url, assetName: asset.name, repos: UPDATE_REPOS });
      let lastErr = "";
      for (const u of candidates) {
        try {
          logInfo("update", `trying ${new URL(u).host}\u2026`);
          const r = await fetch(u, { signal: AbortSignal.timeout(9e5) });
          if (!r.ok) {
            lastErr = `HTTP ${r.status}`;
            logInfo("update", `\u2192 HTTP ${r.status}`);
            continue;
          }
          if (r.body === null) {
            lastErr = "\u65E0\u54CD\u5E94\u4F53";
            continue;
          }
          const total = Number(r.headers.get("content-length") ?? 0) > 0 ? Number(r.headers.get("content-length")) : asset.size;
          const destTmp = `${dest}.part`;
          const out = createWriteStream(destTmp);
          let received = 0;
          let lastBump = 0;
          const t0 = Date.now();
          const reader = r.body.getReader();
          for (; ; ) {
            const { done, value } = await reader.read();
            if (done === true || value === void 0) break;
            received += value.byteLength;
            out.write(value);
            const now = Date.now();
            if (received === value.byteLength || now - lastBump > 400) {
              lastBump = now;
              bumpUpdate({ progress: { received, total, speedBps: Math.round(received / Math.max((now - t0) / 1e3, 0.1)) } });
            }
          }
          await new Promise((res, rej) => {
            out.end((err) => {
              if (err !== null && err !== void 0) rej(err);
              else res();
            });
          });
          if (received < 1e6) {
            lastErr = `\u5185\u5BB9\u5F02\u5E38(${received}B)`;
            logInfo("update", `\u2192 ${lastErr}`);
            continue;
          }
          if (!sizeMatches(asset.size, received)) {
            lastErr = `size \u4E0D\u7B26(\u5143\u6570\u636E ${asset.size}B / \u5B9E\u6536 ${received}B)`;
            logInfo("update", `\u2192 ${lastErr}`);
            continue;
          }
          await rename(destTmp, dest);
          installerPath = dest;
          bumpUpdate({ downloaded: true, progress: null });
          logInfo("update", `\u5DF2\u4E0B\u8F7D ${asset.name}(${Math.round(received / 1e6)}MB) \u2192 ${dest}`);
          return;
        } catch (err) {
          const e = err;
          lastErr = String(e.cause?.code ?? err).slice(0, 80);
          logInfo("update", `\u2192 fail ${lastErr}`);
          bumpUpdate({ progress: null });
        }
      }
      bumpUpdate({ error: `\u4E0B\u8F7D\u5931\u8D25:\u5168\u90E8\u4E0B\u8F7D\u901A\u9053\u5931\u8D25(${lastErr})`.slice(0, 160), progress: null });
    } catch (err) {
      bumpUpdate({ error: `\u4E0B\u8F7D\u5931\u8D25: ${String(err).slice(0, 120)}`, progress: null });
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
    setTimeout(() => {
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vZWxlY3Ryb24vbWFpbi9pbmRleC50cyIsICIuLi8uLi8uLi8uLi9wYWNrYWdlcy9ob3N0LWFkYXB0ZXIvc3JjL3N1cGVydmlzb3IudHMiLCAiLi4vLi4vLi4vLi4vcGFja2FnZXMvY29udHJhY3RzL3NyYy9ldmVudC50cyIsICIuLi8uLi8uLi8uLi9wYWNrYWdlcy9jb250cmFjdHMvc3JjL2Vycm9yLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2NvbnRyYWN0cy9zcmMvZ3VhcmRzLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2hvc3QtYWRhcHRlci9zcmMvY2xpZW50LnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2hvc3QtYWRhcHRlci9zcmMvZmFrZS1ob3N0LnRzIiwgIi4uLy4uL2VsZWN0cm9uL21haW4vdWl2ZXJpZnkudHMiLCAiLi4vLi4vZWxlY3Ryb24vbWFpbi92aXN1YWxyZWdyZXNzaW9uLnRzIiwgIi4uLy4uL2VsZWN0cm9uL21haW4vaW5zdGFsbGVyLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2NsaS1pbnN0YWxsZXIvc3JjL2luZGV4LnRzIiwgIi4uLy4uL2VsZWN0cm9uL21haW4vdXBkYXRlci1jaGFubmVscy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXHJcbiAqIEhNSCBEZXNrdG9wIFx1MjAxNCBFbGVjdHJvbiBcdTRFM0JcdThGREJcdTdBMEIoQURSLTAwMS8wMDMvMDA0KVx1MzAwMlxyXG4gKlxyXG4gKiBcdTVCODlcdTUxNjhcdTRFMERcdTUzRDhcdTkxQ0YoXHU1RjAwXHU1M0QxXHU4QkExXHU1MjEyIE0wIFx1NTFGQVx1NTNFM1x1OTVFOCArIEVsZWN0cm9uIFx1NUI5OFx1NjVCOVx1NUI4OVx1NTE2OFx1NkUwNVx1NTM1NSk6XHJcbiAqICAtIHJlbmRlcmVyOmNvbnRleHRJc29sYXRpb24gKyBzYW5kYm94ICsgXHU3OTgxIG5vZGVJbnRlZ3JhdGlvbixcdTRFMjVcdTY4M0MgQ1NQO1xyXG4gKiAgLSBcdTVCRkNcdTgyMkEvXHU2NUIwXHU3QTk3XHU1M0UzXHU0RTAwXHU1RjhCXHU2MkQyXHU3RUREKFx1NTNFQVx1NTJBMFx1OEY3RFx1NjIxMVx1NEVFQ1x1ODFFQVx1NURGMVx1NzY4NCByZW5kZXJlcik7XHJcbiAqICAtIFx1NkJDRlx1Njc2MSBJUEMgXHU2ODIxXHU5QThDIHNlbmRlciBcdTc2ODRcdTk4NzZcdTVDNDIgZnJhbWUgVVJMIFx1NUM1RVx1NEU4RVx1NjcyQ1x1NUU5NFx1NzUyOCxcdTkwMUFcdTkwNTNcdTc2N0RcdTU0MERcdTUzNTU7XHJcbiAqICAtIGhvc3QgdG9rZW4gXHU1M0VBXHU1QjU4XHU1NzI4XHU0RThFXHU2NzJDXHU4RkRCXHU3QTBCXHU0RTBFXHU1QjUwXHU4RkRCXHU3QTBCIGVudixcdTY1RTVcdTVGRDdcdThGOTNcdTUxRkFcdTUyNERcdTUxNDhcdTgxMzFcdTY1NEY7XHJcbiAqICAtIFx1NTM1NVx1NUI5RVx1NEY4Qlx1OTUwMTtcdTkwMDBcdTUxRkFcdTY1RjZcdTUzRUFcdTUwNUNcdTZCNjJcdTgxRUFcdTVERjEgc3Bhd24gXHU3Njg0IGhvc3QoXHU0RjE4XHU5NkM1XHUyMTkyXHU1MTVDXHU1RTk1IGtpbGwpXHUzMDAyXHJcbiAqXHJcbiAqIFx1OTYzNlx1NkJCNUUoMjAyNi0xMC0xMCk6bWFpbiBcdTYzMDFcdTY3MDkgRGVza3RvcEhvc3RDbGllbnQsU1NFIFx1NEZFMVx1NUMwMVx1NkQ0MShldmVudDogaG1oKVxyXG4gKiBcdTdFQ0YgNTBtcyBcdTYyNzlcdTkxQ0ZcdTYzQThcdTdFRDkgcmVuZGVyZXI7c2VuZFRhc2svYXBwcm92ZS9pbnRlcnJ1cHQvc2Vzc2lvbnMgXHU1MTY4XHU5MEU4XHU4RjZDXHU1M0QxXHJcbiAqIFx1N0VEOSBob3N0IFx1MjAxNFx1MjAxNCBmYWtlIFx1NEUwRVx1NzcxRlx1NUI5RSBobWhhcm5lc3MgZGVza3RvcC1ob3N0IFx1OEQ3MFx1NTQwQ1x1NEUwMFx1Njc2MVx1NEVFM1x1NzgwMVx1OERFRlx1NUY4NFx1MzAwMlxyXG4gKi9cclxuaW1wb3J0IHsgYXBwLCBCcm93c2VyV2luZG93LCBkaWFsb2csIGlwY01haW4sIHNlc3Npb24sIHNoZWxsLCBUcmF5LCBOb3RpZmljYXRpb24sIE1lbnUsIG5hdGl2ZUltYWdlLCBuYXRpdmVUaGVtZSB9IGZyb20gJ2VsZWN0cm9uJztcclxuaW1wb3J0IHsgam9pbiwgZGlybmFtZSwgYmFzZW5hbWUsIGlzQWJzb2x1dGUsIHJlc29sdmUgfSBmcm9tICdub2RlOnBhdGgnO1xyXG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFscGF0aFN5bmMsIHJlYWRGaWxlU3luYyB9IGZyb20gJ25vZGU6ZnMnO1xyXG5pbXBvcnQgeyBjcmVhdGVXcml0ZVN0cmVhbSB9IGZyb20gJ25vZGU6ZnMnO1xyXG5pbXBvcnQgeyB3cml0ZUZpbGUsIHJlYWRGaWxlLCBzdGF0LCByZW5hbWUgfSBmcm9tICdub2RlOmZzL3Byb21pc2VzJztcclxuaW1wb3J0IHsgaG9tZWRpciwgbmV0d29ya0ludGVyZmFjZXMgfSBmcm9tICdub2RlOm9zJztcclxuaW1wb3J0IHsgZXhlY0ZpbGVTeW5jLCBzcGF3biB9IGZyb20gJ25vZGU6Y2hpbGRfcHJvY2Vzcyc7XHJcbmltcG9ydCB7IHBhdGhUb0ZpbGVVUkwgfSBmcm9tICdub2RlOnVybCc7XHJcbmltcG9ydCB7IHJhbmRvbVVVSUQgfSBmcm9tICdub2RlOmNyeXB0byc7XHJcbmltcG9ydCB7IERlc2t0b3BSdW50aW1lU3VwZXJ2aXNvciwgRGVza3RvcEhvc3RDbGllbnQsIGVudmVsb3BlRnJvbUZyYW1lLCB0eXBlIEhvc3RTdGF0ZSB9IGZyb20gJ0BobWgtZGVza3RvcC9ob3N0LWFkYXB0ZXInO1xyXG5pbXBvcnQgeyBpc0V2ZW50RW52ZWxvcGUsIHR5cGUgRXZlbnRFbnZlbG9wZSB9IGZyb20gJ0BobWgtZGVza3RvcC9jb250cmFjdHMnO1xyXG5pbXBvcnQgeyBhdHRhY2hVaVZlcmlmeSB9IGZyb20gJy4vdWl2ZXJpZnkudHMnO1xyXG5pbXBvcnQgeyBhdHRhY2hWaXN1YWxSZWdyZXNzaW9uIH0gZnJvbSAnLi92aXN1YWxyZWdyZXNzaW9uLnRzJztcclxuaW1wb3J0IHsgaW5zdGFsbFRhcmdldCwgcmVzb2x2ZUluc3RhbGxlZEVudHJ5LCBzdGFydENsaUluc3RhbGwsIHR5cGUgSW5zdGFsbFByb2dyZXNzIH0gZnJvbSAnLi9pbnN0YWxsZXIudHMnO1xyXG5pbXBvcnQgeyBvcmRlcmVkQ2hlY2tDaGFubmVscywgZG93bmxvYWRDYW5kaWRhdGVzLCBub3JtYWxpemVDaGFubmVsLCBub3JtYWxpemVSZWxlYXNlLCBwaWNrSW5zdGFsbGVyQXNzZXQsIHNpemVNYXRjaGVzLCBzdW1tYXJpemVDaGVja0ZhaWx1cmVzLCBjbXBWZXJzaW9uLCB0eXBlIExhdGVzdFJlbGVhc2UsIHR5cGUgUmVsZWFzZUFzc2V0LCB0eXBlIFVwZGF0ZUNoYW5uZWxJZCwgdHlwZSBVcGRhdGVSZXBvcyB9IGZyb20gJy4vdXBkYXRlci1jaGFubmVscy50cyc7XHJcblxyXG5jb25zdCBoZXJlID0gaW1wb3J0Lm1ldGEuZGlybmFtZSA/PyAnLic7XHJcbmNvbnN0IGlzRGV2ID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfREVWID09PSAnMSc7XHJcbmNvbnN0IHJlbmRlcmVyRGV2VXJsID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfUkVOREVSRVJfVVJMID8/ICcnO1xyXG5jb25zdCBwcmVsb2FkUGF0aCA9IGpvaW4oaGVyZSwgJy4uL3ByZWxvYWQvaW5kZXguY2pzJyk7XHJcblxyXG4vKiAtLS0tIFx1NjVFNVx1NUZEN1x1ODEzMVx1NjU0Rjp0b2tlbi9hdXRob3JpemF0aW9uIFx1NkMzOFx1NEUwRFx1OEZEQlx1NjNBN1x1NTIzNlx1NTNGMCAtLS0tICovXHJcbmNvbnN0IHNlY3JldHM6IHN0cmluZ1tdID0gW107XHJcbmZ1bmN0aW9uIHJlZGFjdChzOiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gIGxldCBvdXQgPSBzO1xyXG4gIGZvciAoY29uc3Qgc2VjIG9mIHNlY3JldHMpIHtcclxuICAgIGlmIChzZWMubGVuZ3RoID49IDgpIG91dCA9IG91dC5zcGxpdChzZWMpLmpvaW4oJ1tyZWRhY3RlZF0nKTtcclxuICB9XHJcbiAgcmV0dXJuIG91dDtcclxufVxyXG5mdW5jdGlvbiBsb2dJbmZvKHRhZzogc3RyaW5nLCBtc2c6IHN0cmluZyk6IHZvaWQge1xyXG4gIGNvbnNvbGUubG9nKGBbaG1oLWRlc2t0b3A6JHt0YWd9XSAke3JlZGFjdChtc2cpfWApO1xyXG59XHJcblxyXG4vKiAtLS0tIFx1NTM1NVx1NUI5RVx1NEY4QiAtLS0tICovXHJcbmlmICghYXBwLnJlcXVlc3RTaW5nbGVJbnN0YW5jZUxvY2soKSkge1xyXG4gIGFwcC5xdWl0KCk7XHJcbn0gZWxzZSB7XHJcbiAgYXBwLm9uKCdzZWNvbmQtaW5zdGFuY2UnLCAoKSA9PiB7XHJcbiAgICBjb25zdCB3aW4gPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKVswXTtcclxuICAgIGlmICh3aW4pIHtcclxuICAgICAgaWYgKHdpbi5pc01pbmltaXplZCgpKSB3aW4ucmVzdG9yZSgpO1xyXG4gICAgICB3aW4uZm9jdXMoKTtcclxuICAgIH1cclxuICB9KTtcclxuXHJcbiAgLyogLS0tLSBob3N0IFx1NzZEMVx1N0JBMSArIFx1Njg2NVx1NUJBMlx1NjIzN1x1N0FFRiAtLS0tICovXHJcbiAgaW50ZXJmYWNlIEJyaWRnZVNuYXBzaG90IHtcclxuICAgIGhvc3RTdGF0ZTogSG9zdFN0YXRlO1xyXG4gICAgaG9zdFBvcnQ6IG51bWJlciB8IG51bGw7XHJcbiAgICBob3N0VmVyc2lvbjogc3RyaW5nIHwgbnVsbDtcclxuICAgIGxhc3RFcnJvcjogc3RyaW5nIHwgbnVsbDtcclxuICAgIG1vZGU6ICdmYWtlJyB8ICdyZWFsJztcclxuICAgIHJ1bnRpbWVFbnRyeTogc3RyaW5nIHwgbnVsbDtcclxuICB9XHJcbiAgbGV0IHN1cGVydmlzb3I6IERlc2t0b3BSdW50aW1lU3VwZXJ2aXNvciB8IG51bGwgPSBudWxsO1xyXG4gIGxldCBjbGllbnQ6IERlc2t0b3BIb3N0Q2xpZW50IHwgbnVsbCA9IG51bGw7XHJcbiAgbGV0IGJyaWRnZTogQnJpZGdlU25hcHNob3QgPSB7IGhvc3RTdGF0ZTogJ3N0b3BwZWQnLCBob3N0UG9ydDogbnVsbCwgaG9zdFZlcnNpb246IG51bGwsIGxhc3RFcnJvcjogbnVsbCwgbW9kZTogJ2Zha2UnLCBydW50aW1lRW50cnk6IG51bGwgfTtcclxuICAvKiogXHU0RThCXHU0RUY2XHU2Mjc5XHU5MUNGXHU3RjEzXHU1MUIyOlx1OUFEOFx1OTg5MSBTU0UgXHU0RTBEXHU5MDEwXHU2NzYxXHU4RkM3IElQQyw1MG1zIFx1NjI3OVx1OTFDRiBmbHVzaChcdTZFMzJcdTY3RDNcdTRFMERcdTUzNjEpXHUzMDAyICovXHJcbiAgbGV0IGV2ZW50QnVmZmVyOiBFdmVudEVudmVsb3BlW10gPSBbXTtcclxuICBsZXQgZmx1c2hUaW1lcjogTm9kZUpTLlRpbWVvdXQgfCBudWxsID0gbnVsbDtcclxuICBsZXQgc3NlQWJvcnQ6IEFib3J0Q29udHJvbGxlciB8IG51bGwgPSBudWxsO1xyXG4gIGxldCBsYXN0RXZlbnRJZCA9ICcnO1xyXG4gIC8qKiBcdTY3MkFcdTc3RTUvXHU3NTc4XHU1RjYyXHU0RkUxXHU1QzAxXHU4QkExXHU2NTcwKFNDSEVNQV9NSVNNQVRDSCBcdTk3NjJcdTU0MTFcdThCQ0FcdTY1QUQsXHU0RTBEXHU1RDI5KVx1MzAwMiAqL1xyXG4gIGxldCBkcm9wcGVkRnJhbWVzID0gMDtcclxuXHJcbiAgZnVuY3Rpb24gcHVzaEV2ZW50KGVudjogRXZlbnRFbnZlbG9wZSk6IHZvaWQge1xyXG4gICAgZXZlbnRCdWZmZXIucHVzaChlbnYpO1xyXG4gICAgaWYgKGV2ZW50QnVmZmVyLmxlbmd0aCA+IDJfMDAwKSBldmVudEJ1ZmZlci5zcGxpY2UoMCwgZXZlbnRCdWZmZXIubGVuZ3RoIC0gMl8wMDApO1xyXG4gICAgaWYgKGZsdXNoVGltZXIgPT09IG51bGwpIHtcclxuICAgICAgZmx1c2hUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xyXG4gICAgICAgIGZsdXNoVGltZXIgPSBudWxsO1xyXG4gICAgICAgIGNvbnN0IGJhdGNoID0gZXZlbnRCdWZmZXI7XHJcbiAgICAgICAgZXZlbnRCdWZmZXIgPSBbXTtcclxuICAgICAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcclxuICAgICAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ2JyaWRnZTpldmVudC1iYXRjaCcsIGJhdGNoKTtcclxuICAgICAgICB9XHJcbiAgICAgIH0sIDUwKTtcclxuICAgIH1cclxuICAgIG5vdGlmeUV2ZW50KGVudik7XHJcbiAgfVxyXG5cclxuICAvKiAtLS0tIFx1N0NGQlx1N0VERlx1NjI1OFx1NzZEOCArIFx1OTAxQVx1NzdFNSgwMyBcdTUzRjcgXHUwMEE3XHU0RTAwOlx1Njg0Q1x1OTc2Mlx1NEVBN1x1NTRDMVx1OTcwMFx1ODk4MVx1N0NGQlx1N0VERlx1NjI1OFx1NzZEOFx1MzAwMVx1OTAxQVx1NzdFNSkgLS0tLVxyXG4gICAgIFx1NUJBMVx1NjI3OVx1N0I0OVx1NUY4NVx1NUZDNVx1OTg3Qlx1NjI1M1x1NjI3MChcdTc1MjhcdTYyMzdcdTVGQzVcdTk4N0JcdTUxQjNcdTdCNTYpO1x1NUI4Q1x1NjIxMC9cdTU5MzFcdThEMjVcdTRFQzVcdTU3MjhcdTdBOTdcdTUzRTNcdTU5MzFcdTcxMjZcdTY1RjZcdTYzRDBcdTkxOTJcdTMwMDIgKi9cclxuICBjb25zdCBUUkFZX0lDT05fQkFTRTY0ID0gJ2lWQk9SdzBLR2dvQUFBQU5TVWhFVWdBQUFCQUFBQUFRQ0FZQUFBQWY4LzloQUFBQVIwbEVRVlI0bkdOZ1FBUFNzb3IvOFdGMDlVUnJ4R3NRcVpveERJRUo2RGQrQjJOMGhiakVNV3duMVFDd0lZUFRBRnlZZmdZTWZCaVFaQURGQ1lrcVNabml6RVJKZGdZQWxMNXJzRGMyYVRjQUFBQUFTVVZPUks1Q1lJST0nO1xyXG4gIGxldCB0cmF5OiBUcmF5IHwgbnVsbCA9IG51bGw7XHJcbiAgY29uc3Qgc2VuZE1lbnVBY3Rpb24gPSAoYTogc3RyaW5nKTogdm9pZCA9PiB7XHJcbiAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcclxuICAgICAgaWYgKCF3LmlzRGVzdHJveWVkKCkpIHcud2ViQ29udGVudHMuc2VuZCgnbWVudTphY3Rpb24nLCBhKTtcclxuICAgIH1cclxuICB9O1xyXG4gIGZ1bmN0aW9uIGZvY3VzTWFpbldpbmRvdygpOiB2b2lkIHtcclxuICAgIGNvbnN0IHdpbiA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmZpbmQoKHcpID0+ICF3LmlzRGVzdHJveWVkKCkpO1xyXG4gICAgaWYgKHdpbiA9PT0gdW5kZWZpbmVkKSByZXR1cm47XHJcbiAgICBpZiAod2luLmlzTWluaW1pemVkKCkpIHdpbi5yZXN0b3JlKCk7XHJcbiAgICB3aW4uc2hvdygpO1xyXG4gICAgd2luLmZvY3VzKCk7XHJcbiAgfVxyXG4gIGZ1bmN0aW9uIHNldHVwVHJheSgpOiB2b2lkIHtcclxuICAgIGlmICh0cmF5ICE9PSBudWxsKSByZXR1cm47XHJcbiAgICBjb25zdCBpY29uID0gbmF0aXZlSW1hZ2UuY3JlYXRlRnJvbURhdGFVUkwoYGRhdGE6aW1hZ2UvcG5nO2Jhc2U2NCwke1RSQVlfSUNPTl9CQVNFNjR9YCk7XHJcbiAgICB0cmF5ID0gbmV3IFRyYXkoaWNvbik7XHJcbiAgICB0cmF5LnNldFRvb2xUaXAoJ0hNSCBEZXNrdG9wJyk7XHJcbiAgICB0cmF5Lm9uKCdjbGljaycsIGZvY3VzTWFpbldpbmRvdyk7XHJcbiAgICB0cmF5LnNldENvbnRleHRNZW51KE1lbnUuYnVpbGRGcm9tVGVtcGxhdGUoW1xyXG4gICAgICB7IGxhYmVsOiAnXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREJywgY2xpY2s6ICgpOiB2b2lkID0+IHNlbmRNZW51QWN0aW9uKCduZXctc2Vzc2lvbicpIH0sXHJcbiAgICAgIHsgbGFiZWw6ICdcdTY2M0VcdTc5M0FcdTRFM0JcdTdBOTdcdTUzRTMnLCBjbGljazogZm9jdXNNYWluV2luZG93IH0sXHJcbiAgICAgIHsgbGFiZWw6ICdcdTYyNEJcdTY3M0FcdThGRENcdTdBMEJcdTYzQTdcdTUyMzYnLCBjbGljazogKCk6IHZvaWQgPT4gc2VuZE1lbnVBY3Rpb24oJ29wZW4tcmVtb3RlJykgfSxcclxuICAgICAgeyBsYWJlbDogJ1x1OEJCRVx1N0Y2RScsIGNsaWNrOiAoKTogdm9pZCA9PiBzZW5kTWVudUFjdGlvbignb3Blbi1zZXR0aW5ncycpIH0sXHJcbiAgICAgIHsgdHlwZTogJ3NlcGFyYXRvcicgfSxcclxuICAgICAgeyBsYWJlbDogJ1x1OTAwMFx1NTFGQScsIGNsaWNrOiAoKTogdm9pZCA9PiB7IGFwcC5xdWl0KCk7IH0gfSxcclxuICAgIF0pKTtcclxuICB9XHJcbiAgZnVuY3Rpb24gbm90aWZ5RXZlbnQoZW52OiBFdmVudEVudmVsb3BlKTogdm9pZCB7XHJcbiAgICAvLyBcdTlBOENcdTY1MzYvXHU2MjJBXHU1NkZFL1x1NkUzMlx1NjdEM1x1NjNBMlx1OTQ4OC9cdTg5QzZcdTg5QzlcdTU2REVcdTVGNTJcdTZBMjFcdTVGMEZcdTk3NTlcdTlFRDgoXHU0RTBEXHU1RjgwXHU3NTI4XHU2MjM3XHU2ODRDXHU5NzYyXHU1RjM5XHU2RDRCXHU4QkQ1XHU5MDFBXHU3N0U1KVxyXG4gICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZID09PSAnMScgfHwgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfU05BUFNIT1QgIT09IHVuZGVmaW5lZCB8fCBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9SRU5ERVJfVEVTVCA9PT0gJzEnIHx8IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1ZJU1JFRyA9PT0gJzEnKSByZXR1cm47XHJcbiAgICBpZiAoIU5vdGlmaWNhdGlvbi5pc1N1cHBvcnRlZCgpKSByZXR1cm47XHJcbiAgICBjb25zdCB3aW4gPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5maW5kKCh3KSA9PiAhdy5pc0Rlc3Ryb3llZCgpKTtcclxuICAgIGNvbnN0IGZvY3VzZWQgPSB3aW4/LmlzRm9jdXNlZCgpID8/IGZhbHNlO1xyXG4gICAgY29uc3QgbWsgPSAodGl0bGU6IHN0cmluZywgYm9keTogc3RyaW5nKTogdm9pZCA9PiB7XHJcbiAgICAgIGNvbnN0IG4gPSBuZXcgTm90aWZpY2F0aW9uKHsgdGl0bGUsIGJvZHksIGljb246IG5hdGl2ZUltYWdlLmNyZWF0ZUZyb21EYXRhVVJMKGBkYXRhOmltYWdlL3BuZztiYXNlNjQsJHtUUkFZX0lDT05fQkFTRTY0fWApIH0pO1xyXG4gICAgICBuLm9uKCdjbGljaycsIGZvY3VzTWFpbldpbmRvdyk7XHJcbiAgICAgIG4uc2hvdygpO1xyXG4gICAgfTtcclxuICAgIGlmIChlbnYua2luZCA9PT0gJ2FwcHJvdmFsLnJlcXVpcmVkJykge1xyXG4gICAgICBjb25zdCBwID0gZW52LnBheWxvYWQgYXMgeyB0b29sPzogc3RyaW5nIH07XHJcbiAgICAgIG1rKCdITUggXHU5NzAwXHU4OTgxXHU1QkExXHU2Mjc5JywgYCR7U3RyaW5nKHAudG9vbCA/PyAnXHU2NENEXHU0RjVDJyl9IFx1N0I0OVx1NUY4NVx1NEY2MFx1NzY4NFx1NjI3OVx1NTFDNmApO1xyXG4gICAgfSBlbHNlIGlmIChlbnYua2luZCA9PT0gJ3J1bi5jb21wbGV0ZWQnICYmICFmb2N1c2VkKSB7XHJcbiAgICAgIG1rKCdITUggXHU0RUZCXHU1MkExXHU1QjhDXHU2MjEwJywgYFx1NEYxQVx1OEJERCAke2Vudi5zZXNzaW9uSWR9IFx1NzY4NFx1NEVGQlx1NTJBMVx1NURGMlx1NUI4Q1x1NjIxMGApO1xyXG4gICAgfSBlbHNlIGlmIChlbnYua2luZCA9PT0gJ3J1bi5mYWlsZWQnICYmICFmb2N1c2VkKSB7XHJcbiAgICAgIG1rKCdITUggXHU0RUZCXHU1MkExXHU1OTMxXHU4RDI1JywgYFx1NEYxQVx1OEJERCAke2Vudi5zZXNzaW9uSWR9IFx1NzY4NFx1NEVGQlx1NTJBMVx1NTkzMVx1OEQyNSxcdTcwQjlcdTUxRkJcdTY3RTVcdTc3MEJgKTtcclxuICAgIH1cclxuICB9XHJcblxyXG4gIC8qIC0tLS0gXHU4MUVBXHU1QjlBXHU0RTQ5XHU2ODA3XHU5ODk4XHU2ODBGKDIwMjYtMTAtMTEgXHU3NTI4XHU2MjM3XHU1M0NEXHU5OTg4Olx1NEVBRVx1ODI3Mlx1NkEyMVx1NUYwRlx1OTg3Nlx1OTBFOFx1OUVEMVx1Njc2MT1cdTUzOUZcdTc1MUZcdTgzRENcdTUzNTVcdTY4MEZcclxuICAgICBcdTRFMERcdThEREZcdTRFM0JcdTk4OTg7XHU4M0RDXHU1MzU1XHU0RTBFXHU4QkJFXHU3RjZFXHU5MUNEXHU1OTBEKSAtLS0tIFx1NjVCOVx1Njg0ODpcdTk2OTBcdTg1Q0ZcdTVGMEZcdTY4MDdcdTk4OThcdTY4MEYgKyB0aXRsZUJhck92ZXJsYXlcclxuICAgICAoXHU5ODlDXHU4MjcyXHU5NjhGXHU0RTNCXHU5ODk4KSxcdTgzRENcdTUzNTVcdTY4MEYgYXV0b0hpZGUoQWx0IFx1NTQ3Q1x1NTFGQSlcdTRFMTRcdTdDQkVcdTdCODBcdTRFM0FcdTdDRkJcdTdFREZcdTdFQTdcdTgwRkRcdTUyOUI7XHJcbiAgICAgXHU1RTM4XHU3NTI4XHU1MkE4XHU0RjVDXHU4RDcwIHJlbmRlcmVyIFx1NjgwN1x1OTg5OFx1NjgwRiBcdTI2MzAgXHU0RTNCXHU4M0RDXHU1MzU1KFx1NTUyRlx1NEUwMFx1NTE2NVx1NTNFMylcdTMwMDIgKi9cclxuICAvLyB2NCBEU0ggXHU4QkJFXHU4QkExXHU4QkVEXHU4QTAwOm92ZXJsYXkgXHU4MjcyXHU4RERGXHU5NjhGIHRpdGxlYmFyIFx1NzY4NCBiZy1sYXllci0xKFx1NkQ0NSAjZmZmL1x1NkRGMSAjMTYxODFkKVxyXG4gIGNvbnN0IGNocm9tZUZvciA9IChkYXJrOiBib29sZWFuKTogeyBjb2xvcjogc3RyaW5nOyBzeW1ib2xDb2xvcjogc3RyaW5nIH0gPT5cclxuICAgIGRhcmsgPyB7IGNvbG9yOiAnIzE2MTgxZCcsIHN5bWJvbENvbG9yOiAnI2Y1ZjZmOCcgfSA6IHsgY29sb3I6ICcjZmZmZmZmJywgc3ltYm9sQ29sb3I6ICcjMGYxMTE1JyB9O1xyXG4gIGZ1bmN0aW9uIGFwcGx5Q2hyb21lKGRhcms6IGJvb2xlYW4pOiB2b2lkIHtcclxuICAgIGZvciAoY29uc3QgdyBvZiBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKSkge1xyXG4gICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkge1xyXG4gICAgICAgIHRyeSB7IHcuc2V0VGl0bGVCYXJPdmVybGF5KGNocm9tZUZvcihkYXJrKSk7IH0gY2F0Y2ggeyAvKiBcdTRFQzUgV2luZG93cyBcdTY1MkZcdTYzMDEgKi8gfVxyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvKiAtLS0tIFx1NUU5NFx1NzUyOFx1NTE4NVx1NjZGNFx1NjVCMCgyMDI2LTEwLTI2Olx1ODFFQVx1NzgxNFx1OEY3Qlx1OTFDRlx1NjZGNFx1NjVCMFx1NTY2OCxcdTk2RjZcdTRGOURcdThENTY7R2l0SHViIFJlbGVhc2VzIFx1OTAxQVx1OTA1MylcclxuICAgICBcdTZENDFcdTdBMEI6XHU1NDJGXHU1MkE4IDMwcyBcdTU0MEVcdTk3NTlcdTlFRDhcdTY4QzBcdTY3RTUgXHUyMTkyIGZldGNoIGxhdGVzdCByZWxlYXNlIHRhZyBcdTIxOTIgXHU2QkQ0XHU3MjQ4XHU2NzJDIFx1MjE5MiBcdTU0MEVcdTUzRjBcdTZENDFcdTVGMEZcclxuICAgICBcdTRFMEJcdThGN0QgU2V0dXAgZXhlIFx1NTIzMFx1NEUzNFx1NjVGNlx1NzZFRVx1NUY1NShcdThGREJcdTVFQTZcdTYzQThcdTkwMDEgcmVuZGVyZXIgXHU2QTJBXHU1RTQ1KVx1MjE5MlwiXHU5MUNEXHU1NDJGXHU2NkY0XHU2NUIwXCJcdTIxOTIgXHU5MDAwXHU1MUZBXHU1RTk0XHU3NTI4XHJcbiAgICAgXHU1NDBFIE5TSVMgL1MgL0Q9XHU1MzlGXHU3NkVFXHU1RjU1IFx1OTc1OVx1OUVEOFx1ODk4Nlx1NzZENlx1NUI4OVx1ODhDNShcdTRFMEJcdTZCMjFcdTU0MkZcdTUyQThcdTUzNzNcdTY1QjBcdTcyNDgpXHUyMDE0XHUyMDE0XHU1MTY4XHU3QTBCXHU0RTBEXHU4REYzXHU2RDRGXHU4OUM4XHU1NjY4XHUzMDAyXHJcbiAgICAgMjAyNi0xMC0yOSBcdTUzQ0NcdTkwMUFcdTkwNTNcdTY4MzlcdTRGRUUoXHU3NTI4XHU2MjM3XHU1NkZEXHU1MTg1XHU2NTM2XHU0RTBEXHU1MjMwXHU2M0E4XHU5MDAxKTpcdTY4QzBcdTY3RTVcdTkwMUFcdTkwNTNcdTk1NUNcdTUwQ0ZcdTU2REVcdTkwMDBcdTk0RkVcclxuICAgICAoXHU3NkY0XHU4RkRFIDhzIFx1MjE5MiBnaC1wcm94eSBcdTIxOTIgZ2hmYXN0KSsgXHU1NDdEXHU0RTJEXHU5MDFBXHU5MDUzXHU3Qzk4XHU2MDI3XHU4QkIwXHU1RkM2ICsgXHU0RTBCXHU4RjdEXHU1NDBDXHU2RTkwXHU0RjE4XHU1MTQ4XHUzMDAyXHJcbiAgICAgXHU1NDBDXHU2NUU1XHU0RUZCXHU1MkExIDEzLUM6YXRvbWdpdCBcdTU2RkRcdTUxODVcdTk5OTZcdTkwMDlcdTkwMUFcdTkwNTMoXHU5NEZFXHU3QjJDXHU0RThDXHU0RjRELFx1NTZGRFx1NTE4NVx1NzZGNFx1OEZERVx1NTMzRlx1NTQwRFx1NTNFRlx1OEJGQikrIFx1NkQ0MVx1NUYwRlxyXG4gICAgIFx1NEUwQlx1OEY3RFx1OEZEQlx1NUVBNiArIFx1NEUwQlx1OEY3RCBzaXplIFx1NjgyMVx1OUE4QyArIFwiXHU5MUNEXHU1NDJGXHU2NkY0XHU2NUIwXCJcdTk3NUVcdTZBMjFcdTYwMDFcdTZBMkFcdTVFNDUocmVuZGVyZXIpXHUzMDAyXHJcbiAgICAgXHU2NUNCXHU5NEFFOlVQREFURV9SRVBPIC8gVVBEQVRFX1JFUE9fQVRPTUdJVCBcdTg5ODZcdTc2RDZcdTUzQ0NcdTRFRDM7SE1IX0RFU0tUT1BfVVBEQVRFX0ZPUkNFX1RBR1xyXG4gICAgIFx1OTc1RVx1N0E3QSBcdTIxOTIgXHU2NUUwXHU4OUM2XHU3MjQ4XHU2NzJDXHU2QkQ0XHU4RjgzXHU1RjNBXHU1MjM2XHU4RDcwXHU2NkY0XHU2NUIwXHU2RDQxXHU3QTBCKFx1OUE4Q1x1NjUzNlx1NzUyOCxcdTRFMERcdTkxQ0RcdTYyNTNcdTUzMDUpXHUzMDAyICovXHJcbiAgY29uc3QgVVBEQVRFX1JFUE9TOiBVcGRhdGVSZXBvcyA9IHtcclxuICAgIGdpdGh1YjogcHJvY2Vzcy5lbnYuVVBEQVRFX1JFUE8gPz8gJ3N3c2dibC9obWgtZGVza3RvcCcsXHJcbiAgICBhdG9tZ2l0OiBwcm9jZXNzLmVudi5VUERBVEVfUkVQT19BVE9NR0lUID8/ICdob25nZnUvaG1oLWRlc2t0b3AnLFxyXG4gIH07XHJcbiAgY29uc3QgVVBEQVRFX0ZPUkNFX1RBRyA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VQREFURV9GT1JDRV9UQUcgPz8gJyc7XHJcbiAgaW50ZXJmYWNlIFVwZGF0ZVByb2dyZXNzIHsgcmVjZWl2ZWQ6IG51bWJlcjsgdG90YWw6IG51bWJlcjsgc3BlZWRCcHM6IG51bWJlciB9XHJcbiAgaW50ZXJmYWNlIFVwZGF0ZVN0YXRlIHsgY2hlY2tpbmc6IGJvb2xlYW47IGN1cnJlbnRWZXJzaW9uOiBzdHJpbmc7IGxhdGVzdDogc3RyaW5nIHwgbnVsbDsgbm90ZXM6IHN0cmluZzsgZG93bmxvYWRlZDogYm9vbGVhbjsgZXJyb3I6IHN0cmluZzsgY2hhbm5lbDogc3RyaW5nOyBwcm9ncmVzczogVXBkYXRlUHJvZ3Jlc3MgfCBudWxsIH1cclxuICBsZXQgdXBkYXRlU3RhdGU6IFVwZGF0ZVN0YXRlID0geyBjaGVja2luZzogZmFsc2UsIGN1cnJlbnRWZXJzaW9uOiBhcHAuZ2V0VmVyc2lvbigpLCBsYXRlc3Q6IG51bGwsIG5vdGVzOiAnJywgZG93bmxvYWRlZDogZmFsc2UsIGVycm9yOiAnJywgY2hhbm5lbDogJycsIHByb2dyZXNzOiBudWxsIH07XHJcbiAgbGV0IGluc3RhbGxlclBhdGg6IHN0cmluZyB8IG51bGwgPSBudWxsO1xyXG4gIGNvbnN0IGJ1bXBVcGRhdGUgPSAocGF0Y2g6IFBhcnRpYWw8VXBkYXRlU3RhdGU+KTogdm9pZCA9PiB7XHJcbiAgICB1cGRhdGVTdGF0ZSA9IHsgLi4udXBkYXRlU3RhdGUsIC4uLnBhdGNoIH07XHJcbiAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcclxuICAgICAgaWYgKCF3LmlzRGVzdHJveWVkKCkpIHcud2ViQ29udGVudHMuc2VuZCgndXBkYXRlOnN0YXRlJywgdXBkYXRlU3RhdGUpO1xyXG4gICAgfVxyXG4gIH07XHJcbiAgLyoqIFx1OTAxQVx1OTA1M1x1N0M5OFx1NjAyNzpcdTRFMEFcdTZCMjFcdTYyMTBcdTUyOUZcdTU0N0RcdTRFMkRcdTc2ODRcdTY4QzBcdTY3RTVcdTkwMUFcdTkwNTModXNlckRhdGEvdXBkYXRlLWNoYW5uZWwuanNvbixcdTRFMEUgcnVudGltZS5qc29uIFx1NTQwQ1x1NkEyMVx1NUYwRilcdTMwMDIgKi9cclxuICBjb25zdCB1cGRhdGVDaGFubmVsRmlsZSA9ICgpOiBzdHJpbmcgPT4gam9pbihhcHAuZ2V0UGF0aCgndXNlckRhdGEnKSwgJ3VwZGF0ZS1jaGFubmVsLmpzb24nKTtcclxuICBhc3luYyBmdW5jdGlvbiBsb2FkU3RpY2t5Q2hhbm5lbCgpOiBQcm9taXNlPFVwZGF0ZUNoYW5uZWxJZCB8IG51bGw+IHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHYgPSBKU09OLnBhcnNlKGF3YWl0IHJlYWRGaWxlKHVwZGF0ZUNoYW5uZWxGaWxlKCksICd1dGY4JykpIGFzIHsgY2hhbm5lbD86IHVua25vd24gfTtcclxuICAgICAgcmV0dXJuIG5vcm1hbGl6ZUNoYW5uZWwodi5jaGFubmVsKTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4gbnVsbDsgfVxyXG4gIH1cclxuICBhc3luYyBmdW5jdGlvbiBzYXZlU3RpY2t5Q2hhbm5lbChpZDogVXBkYXRlQ2hhbm5lbElkKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBhd2FpdCB3cml0ZUZpbGUodXBkYXRlQ2hhbm5lbEZpbGUoKSwgSlNPTi5zdHJpbmdpZnkoeyBjaGFubmVsOiBpZCB9LCBudWxsLCAyKSwgJ3V0ZjgnKS5jYXRjaCgoKSA9PiB1bmRlZmluZWQpO1xyXG4gIH1cclxuICBhc3luYyBmdW5jdGlvbiBjaGVja0ZvclVwZGF0ZXMoKTogUHJvbWlzZTxVcGRhdGVTdGF0ZT4ge1xyXG4gICAgaWYgKHVwZGF0ZVN0YXRlLmNoZWNraW5nIHx8IHVwZGF0ZVN0YXRlLmRvd25sb2FkZWQpIHJldHVybiB1cGRhdGVTdGF0ZTtcclxuICAgIGJ1bXBVcGRhdGUoeyBjaGVja2luZzogdHJ1ZSwgZXJyb3I6ICcnIH0pO1xyXG4gICAgbG9nSW5mbygndXBkYXRlJywgYGNoZWNraW5nXHUyMDI2IChjdXJyZW50IHYke2FwcC5nZXRWZXJzaW9uKCl9KSR7VVBEQVRFX0ZPUkNFX1RBRyAhPT0gJycgPyBgIGZvcmNlLXRhZz0ke1VQREFURV9GT1JDRV9UQUd9YCA6ICcnfWApO1xyXG4gICAgY29uc3QgZmFpbHVyZXM6IEFycmF5PHsgbGFiZWw6IHN0cmluZzsgcmVhc29uOiBzdHJpbmcgfT4gPSBbXTtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHN0aWNreSA9IGF3YWl0IGxvYWRTdGlja3lDaGFubmVsKCk7XHJcbiAgICAgIGNvbnN0IGNoYW5uZWxzID0gb3JkZXJlZENoZWNrQ2hhbm5lbHMoc3RpY2t5ID8/IHVuZGVmaW5lZCk7XHJcbiAgICAgIGZvciAoY29uc3QgY2ggb2YgY2hhbm5lbHMpIHtcclxuICAgICAgICBsZXQgcmVsOiBMYXRlc3RSZWxlYXNlIHwgbnVsbCA9IG51bGw7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgIGNvbnN0IHIgPSBhd2FpdCBmZXRjaChjaC5hcGlVcmwoVVBEQVRFX1JFUE9TKSwge1xyXG4gICAgICAgICAgICBoZWFkZXJzOiB7ICd1c2VyLWFnZW50JzogJ2htaC1kZXNrdG9wLXVwZGF0ZXInIH0sXHJcbiAgICAgICAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dChjaC50aW1lb3V0TXMpLFxyXG4gICAgICAgICAgfSk7XHJcbiAgICAgICAgICBpZiAoIXIub2spIHsgZmFpbHVyZXMucHVzaCh7IGxhYmVsOiBjaC5sYWJlbCwgcmVhc29uOiBgSFRUUCAke3Iuc3RhdHVzfWAgfSk7IGxvZ0luZm8oJ3VwZGF0ZScsIGAke2NoLmxhYmVsfSBcdTIxOTIgSFRUUCAke3Iuc3RhdHVzfWApOyBjb250aW51ZTsgfVxyXG4gICAgICAgICAgLy8gXHU5NTVDXHU1MENGXHU1M0VGXHU4MEZEXHU1NkRFIDIwMCBcdTRGNDZcdTUxODVcdTVCQjlcdTk3NUUgSlNPTihIVE1MIFx1OTUxOVx1OEJFRlx1OTg3NSk7R2l0SHViIFx1NTZERVx1NUJGOVx1OEM2MVx1MzAwMWF0b21naXRcclxuICAgICAgICAgIC8vIFx1NTZERVx1NjU3MFx1N0VDNFx1MjAxNFx1MjAxNG5vcm1hbGl6ZVJlbGVhc2UgXHU3RURGXHU0RTAwXHU1RjUyXHU0RTAwLFx1NUY2Mlx1NzJCNlx1NEUwRFx1NUJGOVx1NjMwOVx1NjcyQ1x1OTAxQVx1OTA1M1x1NTkzMVx1OEQyNVx1NTZERVx1OTAwMFxyXG4gICAgICAgICAgcmVsID0gbm9ybWFsaXplUmVsZWFzZShhd2FpdCByLmpzb24oKSk7XHJcbiAgICAgICAgICBpZiAocmVsID09PSBudWxsKSB7IGZhaWx1cmVzLnB1c2goeyBsYWJlbDogY2gubGFiZWwsIHJlYXNvbjogJ1x1NTRDRFx1NUU5NFx1NjVFMCB0YWdfbmFtZScgfSk7IGxvZ0luZm8oJ3VwZGF0ZScsIGAke2NoLmxhYmVsfSBcdTIxOTIgXHU2NUUwIHRhZ19uYW1lYCk7IGNvbnRpbnVlOyB9XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgICBjb25zdCBlID0gZXJyIGFzIHsgY2F1c2U/OiB7IGNvZGU/OiB1bmtub3duIH0gfTtcclxuICAgICAgICAgIGNvbnN0IHJlYXNvbiA9IGVyciBpbnN0YW5jZW9mIEVycm9yICYmIGVyci5uYW1lID09PSAnVGltZW91dEVycm9yJ1xyXG4gICAgICAgICAgICA/IGBcdThEODVcdTY1RjYoJHtNYXRoLnJvdW5kKGNoLnRpbWVvdXRNcyAvIDEwMDApfXMpYFxyXG4gICAgICAgICAgICA6IFN0cmluZyhlLmNhdXNlPy5jb2RlID8/IGVycikuc2xpY2UoMCwgNjApO1xyXG4gICAgICAgICAgZmFpbHVyZXMucHVzaCh7IGxhYmVsOiBjaC5sYWJlbCwgcmVhc29uIH0pO1xyXG4gICAgICAgICAgbG9nSW5mbygndXBkYXRlJywgYCR7Y2gubGFiZWx9IFx1MjE5MiBmYWlsICR7cmVhc29ufWApO1xyXG4gICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHRhZyA9IHJlbC50YWdfbmFtZTtcclxuICAgICAgICBsb2dJbmZvKCd1cGRhdGUnLCBgbGF0ZXN0PSR7dGFnfSBhc3NldHM9JHsocmVsLmFzc2V0cyA/PyBbXSkubGVuZ3RofSB2aWEgJHtjaC5sYWJlbH0ke3N0aWNreSA9PT0gY2guaWQgPyAnKHN0aWNreSknIDogJyd9YCk7XHJcbiAgICAgICAgYXdhaXQgc2F2ZVN0aWNreUNoYW5uZWwoY2guaWQpOyAvLyBcdTdDOThcdTYwMjc6XHU0RTBCXHU2QjIxXHU1MTQ4XHU4QkQ1XHU2NzJDXHU5MDFBXHU5MDUzXHJcbiAgICAgICAgYnVtcFVwZGF0ZSh7IGNoZWNraW5nOiBmYWxzZSwgbGF0ZXN0OiB0YWcsIG5vdGVzOiBTdHJpbmcocmVsLmJvZHkgPz8gJycpLnNsaWNlKDAsIDYwMCksIGNoYW5uZWw6IGNoLmlkIH0pO1xyXG4gICAgICAgIC8vIFx1NjcwOVx1NjVCMFx1NzI0OChcdTYyMTYgRk9SQ0VfVEFHIFx1OUE4Q1x1NjUzNlx1NjVDQlx1OTRBRSlcdTRFMTRcdTY3MkFcdTRFMEJcdThGN0RcdThGQzcgXHUyMTkyIFx1NTQwRVx1NTNGMFx1NEUwQlx1OEY3RFx1NUI4OVx1ODhDNVx1NTMwNVxyXG4gICAgICAgIGlmICgoVVBEQVRFX0ZPUkNFX1RBRyAhPT0gJycgfHwgY21wVmVyc2lvbihhcHAuZ2V0VmVyc2lvbigpLCB0YWcpIDwgMCkgJiYgIXVwZGF0ZVN0YXRlLmRvd25sb2FkZWQpIHtcclxuICAgICAgICAgIHZvaWQgZG93bmxvYWRJbnN0YWxsZXIocmVsLmFzc2V0cyA/PyBbXSwgdGFnKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHVwZGF0ZVN0YXRlO1xyXG4gICAgICB9XHJcbiAgICAgIGNvbnN0IHN1bW1hcnkgPSBzdW1tYXJpemVDaGVja0ZhaWx1cmVzKGZhaWx1cmVzKTtcclxuICAgICAgbG9nSW5mbygndXBkYXRlJywgYGNoZWNrIGZhaWxlZDogYWxsIGNoYW5uZWxzICgke3N1bW1hcnl9KWApO1xyXG4gICAgICBidW1wVXBkYXRlKHsgY2hlY2tpbmc6IGZhbHNlLCBlcnJvcjogYFx1NTE2OFx1OTBFOFx1NjhDMFx1NjdFNVx1OTAxQVx1OTA1M1x1NTkzMVx1OEQyNSgke3N1bW1hcnl9KWAuc2xpY2UoMCwgMjAwKSB9KTtcclxuICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICBsb2dJbmZvKCd1cGRhdGUnLCBgY2hlY2sgZmFpbGVkOiAke1N0cmluZyhlcnIpLnNsaWNlKDAsIDE0MCl9YCk7XHJcbiAgICAgIGJ1bXBVcGRhdGUoeyBjaGVja2luZzogZmFsc2UsIGVycm9yOiBTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApIH0pO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHVwZGF0ZVN0YXRlO1xyXG4gIH1cclxuICAvKiogXHU1NDBFXHU1M0YwXHU2RDQxXHU1RjBGXHU0RTBCXHU4RjdEXHU1Qjg5XHU4OEM1XHU1MzA1Olx1NTIwNlx1NTc1N1x1NTE5OVx1NzZEOCgxMTJNQiBcdTRFMERcdTUxOERcdTY1NzRcdTlBN0JcdTUxODVcdTVCNTgpLFx1OEZEQlx1NUVBNihcdTVERjJcdTRFMEJcdThGN0QvXHU2MDNCXHU1QjU3XHU4MjgyL1xyXG4gICAqICBcdTkwMUZcdTVFQTYpXHU3RUNGIHVwZGF0ZTpzdGF0ZSBcdTYzQTggcmVuZGVyZXIgXHU2QTJBXHU1RTQ1O1x1ODQzRFx1NzZEOFx1NTQwRVx1NjMwOVx1OEQ0NFx1NEVBN1x1NTE0M1x1NjU3MFx1NjM2RSBzaXplIFx1NjgyMVx1OUE4Q1x1MzAwMiAqL1xyXG4gIGFzeW5jIGZ1bmN0aW9uIGRvd25sb2FkSW5zdGFsbGVyKGFzc2V0czogcmVhZG9ubHkgUmVsZWFzZUFzc2V0W10sIHRhZzogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCBhc3NldCA9IHBpY2tJbnN0YWxsZXJBc3NldChhc3NldHMpO1xyXG4gICAgICBpZiAoYXNzZXQgPT09IG51bGwpIHsgYnVtcFVwZGF0ZSh7IGVycm9yOiAncmVsZWFzZSBcdTY1RTBcdTVCODlcdTg4QzVcdTUzMDVcdThENDRcdTRFQTcnIH0pOyByZXR1cm47IH1cclxuICAgICAgY29uc3QgZGVzdCA9IGpvaW4oYXBwLmdldFBhdGgoJ3RlbXAnKSwgYXNzZXQubmFtZSk7XHJcbiAgICAgIC8vIFx1NEUwQVx1NkIyMVx1NEYxQVx1OEJERFx1NURGMlx1NjI4QVx1NTQwQ1x1NzI0OFx1NjcyQ1x1NUI4OVx1ODhDNVx1NTMwNVx1NUI4Q1x1NjU3NFx1NEUwQlx1NTIzMFx1NEUzNFx1NjVGNlx1NzZFRVx1NUY1NShzaXplIFx1NUJGOVx1NUY5N1x1NEUwQSlcdTIxOTIgXHU3NkY0XHU2M0E1XHU1OTBEXHU3NTI4LFxyXG4gICAgICAvLyBcdTRFMERcdTUxOERcdTYyQzkgMTEyTUI7XHU4RkQ5XHU1QzMxXHU2NjJGXCJcdTc1MjhcdTYyMzdcdTVGRkRcdTc1NjVcdTZBMkFcdTVFNDVcdTdFRTdcdTdFRURcdTc1MjgsXHU0RTBCXHU2QjIxXHU1NDJGXHU1MkE4XHU0RUNEXHU0RTAwXHU5NTJFXHU1M0VGXHU4OEM1XCJcdTc2ODRcdTg0M0RcdTU3MzBcdTMwMDJcclxuICAgICAgdHJ5IHtcclxuICAgICAgICBjb25zdCBzdCA9IGF3YWl0IHN0YXQoZGVzdCk7XHJcbiAgICAgICAgaWYgKHNpemVNYXRjaGVzKGFzc2V0LnNpemUsIHN0LnNpemUpKSB7XHJcbiAgICAgICAgICBpbnN0YWxsZXJQYXRoID0gZGVzdDtcclxuICAgICAgICAgIGJ1bXBVcGRhdGUoeyBkb3dubG9hZGVkOiB0cnVlLCBwcm9ncmVzczogbnVsbCB9KTtcclxuICAgICAgICAgIGxvZ0luZm8oJ3VwZGF0ZScsIGBcdTU5MERcdTc1MjhcdTVERjJcdTRFMEJcdThGN0QgJHthc3NldC5uYW1lfSgke01hdGgucm91bmQoc3Quc2l6ZSAvIDFlNil9TUIpIFx1MjE5MiAke2Rlc3R9YCk7XHJcbiAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICB9IGNhdGNoIHsgLyogXHU0RTBEXHU1QjU4XHU1NzI4XHU1MjE5XHU2QjYzXHU1RTM4XHU0RTBCXHU4RjdEICovIH1cclxuICAgICAgLy8gXHU0RTBCXHU4RjdEXHU1MDE5XHU5MDA5XHU5NEZFOmF0b21naXQgXHU1NDdEXHU0RTJEIFx1MjE5MiBhdG9tZ2l0IFx1NzZGNFx1OTRGRS9BUEkgXHU3QUVGXHU3MEI5XHU0RjE4XHU1MTQ4LEdpdEh1YiBcdTRFM0JcdTRFRDNcdTk1NUNcdTUwQ0ZcdTUxNUNcdTVFOTVcclxuICAgICAgY29uc3QgY2FuZGlkYXRlcyA9IGRvd25sb2FkQ2FuZGlkYXRlcyh7IGNoYW5uZWw6IHVwZGF0ZVN0YXRlLmNoYW5uZWwsIHRhZywgYXNzZXRVcmw6IGFzc2V0LmJyb3dzZXJfZG93bmxvYWRfdXJsLCBhc3NldE5hbWU6IGFzc2V0Lm5hbWUsIHJlcG9zOiBVUERBVEVfUkVQT1MgfSk7XHJcbiAgICAgIGxldCBsYXN0RXJyID0gJyc7XHJcbiAgICAgIGZvciAoY29uc3QgdSBvZiBjYW5kaWRhdGVzKSB7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgIGxvZ0luZm8oJ3VwZGF0ZScsIGB0cnlpbmcgJHtuZXcgVVJMKHUpLmhvc3R9XHUyMDI2YCk7XHJcbiAgICAgICAgICBjb25zdCByID0gYXdhaXQgZmV0Y2godSwgeyBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoOTAwXzAwMCkgfSk7XHJcbiAgICAgICAgICBpZiAoIXIub2spIHsgbGFzdEVyciA9IGBIVFRQICR7ci5zdGF0dXN9YDsgbG9nSW5mbygndXBkYXRlJywgYFx1MjE5MiBIVFRQICR7ci5zdGF0dXN9YCk7IGNvbnRpbnVlOyB9XHJcbiAgICAgICAgICBpZiAoci5ib2R5ID09PSBudWxsKSB7IGxhc3RFcnIgPSAnXHU2NUUwXHU1NENEXHU1RTk0XHU0RjUzJzsgY29udGludWU7IH1cclxuICAgICAgICAgIGNvbnN0IHRvdGFsID0gTnVtYmVyKHIuaGVhZGVycy5nZXQoJ2NvbnRlbnQtbGVuZ3RoJykgPz8gMCkgPiAwID8gTnVtYmVyKHIuaGVhZGVycy5nZXQoJ2NvbnRlbnQtbGVuZ3RoJykpIDogYXNzZXQuc2l6ZTtcclxuICAgICAgICAgIGNvbnN0IGRlc3RUbXAgPSBgJHtkZXN0fS5wYXJ0YDtcclxuICAgICAgICAgIGNvbnN0IG91dCA9IGNyZWF0ZVdyaXRlU3RyZWFtKGRlc3RUbXApO1xyXG4gICAgICAgICAgbGV0IHJlY2VpdmVkID0gMDtcclxuICAgICAgICAgIGxldCBsYXN0QnVtcCA9IDA7XHJcbiAgICAgICAgICBjb25zdCB0MCA9IERhdGUubm93KCk7XHJcbiAgICAgICAgICBjb25zdCByZWFkZXIgPSByLmJvZHkuZ2V0UmVhZGVyKCk7XHJcbiAgICAgICAgICBmb3IgKDs7KSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHsgZG9uZSwgdmFsdWUgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XHJcbiAgICAgICAgICAgIGlmIChkb25lID09PSB0cnVlIHx8IHZhbHVlID09PSB1bmRlZmluZWQpIGJyZWFrO1xyXG4gICAgICAgICAgICByZWNlaXZlZCArPSB2YWx1ZS5ieXRlTGVuZ3RoO1xyXG4gICAgICAgICAgICBvdXQud3JpdGUodmFsdWUpO1xyXG4gICAgICAgICAgICAvLyBcdThGREJcdTVFQTZcdTgyODJcdTZENDE6XHUyMjY0IFx1NkJDRiA0MDBtcyBcdTRFMDBcdTVFMjcsSVBDIFx1NEUwRFx1NkQyQVx1NkNEQjtcdTk5OTZcdTU3NTdcdTdBQ0JcdTUzNzNcdTRFMEFcdTYyQTUoXHU2MDNCXHU1QjU3XHU4MjgyXHU1QzNEXHU1RkVCXHU1M0VGXHU4OUMxKVxyXG4gICAgICAgICAgICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xyXG4gICAgICAgICAgICBpZiAocmVjZWl2ZWQgPT09IHZhbHVlLmJ5dGVMZW5ndGggfHwgbm93IC0gbGFzdEJ1bXAgPiA0MDApIHtcclxuICAgICAgICAgICAgICBsYXN0QnVtcCA9IG5vdztcclxuICAgICAgICAgICAgICBidW1wVXBkYXRlKHsgcHJvZ3Jlc3M6IHsgcmVjZWl2ZWQsIHRvdGFsLCBzcGVlZEJwczogTWF0aC5yb3VuZChyZWNlaXZlZCAvIE1hdGgubWF4KChub3cgLSB0MCkgLyAxMDAwLCAwLjEpKSB9IH0pO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPigocmVzLCByZWopID0+IHsgb3V0LmVuZCgoZXJyPzogRXJyb3IgfCBudWxsKSA9PiB7IGlmIChlcnIgIT09IG51bGwgJiYgZXJyICE9PSB1bmRlZmluZWQpIHJlaihlcnIpOyBlbHNlIHJlcygpOyB9KTsgfSk7XHJcbiAgICAgICAgICBpZiAocmVjZWl2ZWQgPCAxXzAwMF8wMDApIHsgbGFzdEVyciA9IGBcdTUxODVcdTVCQjlcdTVGMDJcdTVFMzgoJHtyZWNlaXZlZH1CKWA7IGxvZ0luZm8oJ3VwZGF0ZScsIGBcdTIxOTIgJHtsYXN0RXJyfWApOyBjb250aW51ZTsgfVxyXG4gICAgICAgICAgaWYgKCFzaXplTWF0Y2hlcyhhc3NldC5zaXplLCByZWNlaXZlZCkpIHsgbGFzdEVyciA9IGBzaXplIFx1NEUwRFx1N0IyNihcdTUxNDNcdTY1NzBcdTYzNkUgJHthc3NldC5zaXplfUIgLyBcdTVCOUVcdTY1MzYgJHtyZWNlaXZlZH1CKWA7IGxvZ0luZm8oJ3VwZGF0ZScsIGBcdTIxOTIgJHtsYXN0RXJyfWApOyBjb250aW51ZTsgfVxyXG4gICAgICAgICAgYXdhaXQgcmVuYW1lKGRlc3RUbXAsIGRlc3QpO1xyXG4gICAgICAgICAgaW5zdGFsbGVyUGF0aCA9IGRlc3Q7XHJcbiAgICAgICAgICBidW1wVXBkYXRlKHsgZG93bmxvYWRlZDogdHJ1ZSwgcHJvZ3Jlc3M6IG51bGwgfSk7XHJcbiAgICAgICAgICBsb2dJbmZvKCd1cGRhdGUnLCBgXHU1REYyXHU0RTBCXHU4RjdEICR7YXNzZXQubmFtZX0oJHtNYXRoLnJvdW5kKHJlY2VpdmVkIC8gMWU2KX1NQikgXHUyMTkyICR7ZGVzdH1gKTtcclxuICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgICAgIGNvbnN0IGUgPSBlcnIgYXMgeyBjYXVzZT86IHsgY29kZT86IHVua25vd24gfSB9O1xyXG4gICAgICAgICAgbGFzdEVyciA9IFN0cmluZyhlLmNhdXNlPy5jb2RlID8/IGVycikuc2xpY2UoMCwgODApO1xyXG4gICAgICAgICAgbG9nSW5mbygndXBkYXRlJywgYFx1MjE5MiBmYWlsICR7bGFzdEVycn1gKTtcclxuICAgICAgICAgIGJ1bXBVcGRhdGUoeyBwcm9ncmVzczogbnVsbCB9KTtcclxuICAgICAgICB9XHJcbiAgICAgIH1cclxuICAgICAgYnVtcFVwZGF0ZSh7IGVycm9yOiBgXHU0RTBCXHU4RjdEXHU1OTMxXHU4RDI1Olx1NTE2OFx1OTBFOFx1NEUwQlx1OEY3RFx1OTAxQVx1OTA1M1x1NTkzMVx1OEQyNSgke2xhc3RFcnJ9KWAuc2xpY2UoMCwgMTYwKSwgcHJvZ3Jlc3M6IG51bGwgfSk7XHJcbiAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgYnVtcFVwZGF0ZSh7IGVycm9yOiBgXHU0RTBCXHU4RjdEXHU1OTMxXHU4RDI1OiAke1N0cmluZyhlcnIpLnNsaWNlKDAsIDEyMCl9YCwgcHJvZ3Jlc3M6IG51bGwgfSk7XHJcbiAgICB9XHJcbiAgfVxyXG4gIGZ1bmN0aW9uIGFwcGx5VXBkYXRlKCk6IHZvaWQge1xyXG4gICAgLy8gXHU5QThDXHU2NTM2XHU1M0VGXHU4OUMyXHU2RDRCOlx1NkJDRlx1NkIyMSBhcHBseSBcdThCRjdcdTZDNDJcdTkwRkRcdTc1NTlcdTY1RTVcdTVGRDcobW9jay9cdTY1RTBcdTVCODlcdTg4QzVcdTUzMDVcdTY1RjZcdTcwQjlcdTUxRkJcIlx1OTFDRFx1NTQyRlx1NjZGNFx1NjVCMFwiXHJcbiAgICAvLyBcdTRFMERcdTkwMDBcdTUxRkEsVUlWRVJJRlkgXHU2NUFEXHU4QTAwXCJcdTcwQjlcdTUxRkJcdTU0MEVcdThGREJcdTdBMEJcdTVCNThcdTZEM0JcIlx1OTE0RFx1NTQwOFx1OEZEOVx1ODg0Q1x1NjVFNVx1NUZEN1x1Njc4NFx1NjIxMFx1NUI4Q1x1NjU3NFx1OEJDMVx1NjM2RVx1OTRGRSlcdTMwMDJcclxuICAgIGxvZ0luZm8oJ3VwZGF0ZScsIGBhcHBseSByZXF1ZXN0ZWQgKGluc3RhbGxlcj0ke2luc3RhbGxlclBhdGggPT09IG51bGwgPyAnbm9uZScgOiBiYXNlbmFtZShpbnN0YWxsZXJQYXRoKX0pYCk7XHJcbiAgICBpZiAoaW5zdGFsbGVyUGF0aCA9PT0gbnVsbCkgcmV0dXJuO1xyXG4gICAgLy8gXHU5MDAwXHU1MUZBXHU1RjUzXHU1MjREXHU1RTk0XHU3NTI4XHU1NDBFXHU3NTMxXHU1Qjg5XHU4OEM1XHU1NjY4XHU5NzU5XHU5RUQ4XHU4OTg2XHU3NkQ2XHU1Qjg5XHU4OEM1KFx1ODhDNVx1NTZERVx1NTM5Rlx1NzZFRVx1NUY1NSlcdTMwMDJOU0lTIGFzc2lzdGVkIFx1ODlDNFx1NTIxOTpcclxuICAgIC8vIC9TIFx1NEUxNCAvRD1wYXRoIFx1NUZDNVx1OTg3Qlx1NjcwMFx1NTQwRVx1NEUwMFx1NEUyQVx1NTNDMlx1NjU3MFx1MzAwMVx1NTAzQ1x1NEUwRFx1NTJBMFx1NUYxNVx1NTNGNyhcdTU0MkJcdTdBN0FcdTY4M0NcdTRFNUZcdTRFMERcdTUyQTApXHUyMDE0XHUyMDE0bm9kZSBzcGF3blxyXG4gICAgLy8gXHU5RUQ4XHU4QkE0XHU0RjFBXHU3RUQ5XHU1NDJCXHU3QTdBXHU2ODNDXHU1M0MyXHU2NTcwXHU1MkEwXHU1RjE1XHU1M0Y3XHU1QkZDXHU4MUY0IE5TSVMgXHU4OUUzXHU2NzkwXHU5NTE5XHU4REVGXHU1Rjg0KFx1NUI5RVx1NkQ0Qlx1ODhDNVx1NTc0Rlx1NzZFRVx1NUY1NSksXHU2NTQ1XHU3NTI4XHJcbiAgICAvLyB3aW5kb3dzVmVyYmF0aW1Bcmd1bWVudHMgXHU1MzlGXHU2ODM3XHU0RjIwXHU5MDEyXHUzMDAyXHJcbiAgICBjb25zdCBpbnN0YWxsRGlyID0gZGlybmFtZShwcm9jZXNzLmV4ZWNQYXRoKTtcclxuICAgIGNvbnN0IGNoaWxkID0gc3Bhd24oYFwiJHtpbnN0YWxsZXJQYXRofVwiIC9TIC9EPSR7aW5zdGFsbERpcn1gLCB7XHJcbiAgICAgIGRldGFjaGVkOiB0cnVlLFxyXG4gICAgICBzdGRpbzogJ2lnbm9yZScsXHJcbiAgICAgIHdpbmRvd3NIaWRlOiB0cnVlLFxyXG4gICAgICBzaGVsbDogZmFsc2UsXHJcbiAgICAgIHdpbmRvd3NWZXJiYXRpbUFyZ3VtZW50czogdHJ1ZSxcclxuICAgIH0pO1xyXG4gICAgY2hpbGQudW5yZWYoKTtcclxuICAgIGxvZ0luZm8oJ3VwZGF0ZScsIGBhcHBseTogJHtpbnN0YWxsZXJQYXRofSBcdTIxOTIgJHtpbnN0YWxsRGlyfWApO1xyXG4gICAgYXBwLmV4aXQoMCk7XHJcbiAgfVxyXG5cclxuICBmdW5jdGlvbiBidWlsZEFwcE1lbnUoKTogdm9pZCB7XHJcbiAgICAvLyBcdTdDQkVcdTdCODA6XHU1M0VBXHU0RkREXHU3NTU5IFVJIFx1NkNBMVx1NjcwOVx1NzY4NFx1N0NGQlx1N0VERlx1N0VBN1x1ODBGRFx1NTI5QihcdTUyNkFcdThEMzRcdTY3N0YvXHU3QTk3XHU1M0UzKTtcdTUxNzZcdTRGNTlcdTU1MkZcdTRFMDBcdTUxNjVcdTUzRTNcdTU3MjggVUlcdTMwMDJcclxuICAgIGNvbnN0IHRlbXBsYXRlOiBBcnJheTxFbGVjdHJvbi5NZW51SXRlbUNvbnN0cnVjdG9yT3B0aW9ucz4gPSBbXHJcbiAgICAgIHtcclxuICAgICAgICBsYWJlbDogJ1x1N0YxNlx1OEY5MScsXHJcbiAgICAgICAgc3VibWVudTogW1xyXG4gICAgICAgICAgeyByb2xlOiAndW5kbycsIGxhYmVsOiAnXHU2NEE0XHU5NTAwJyB9LFxyXG4gICAgICAgICAgeyByb2xlOiAncmVkbycsIGxhYmVsOiAnXHU5MUNEXHU1MDVBJyB9LFxyXG4gICAgICAgICAgeyB0eXBlOiAnc2VwYXJhdG9yJyB9LFxyXG4gICAgICAgICAgeyByb2xlOiAnY3V0JywgbGFiZWw6ICdcdTUyNkFcdTUyMDcnIH0sXHJcbiAgICAgICAgICB7IHJvbGU6ICdjb3B5JywgbGFiZWw6ICdcdTU5MERcdTUyMzYnIH0sXHJcbiAgICAgICAgICB7IHJvbGU6ICdwYXN0ZScsIGxhYmVsOiAnXHU3Qzk4XHU4RDM0JyB9LFxyXG4gICAgICAgICAgeyByb2xlOiAnc2VsZWN0QWxsJywgbGFiZWw6ICdcdTUxNjhcdTkwMDknIH0sXHJcbiAgICAgICAgXSxcclxuICAgICAgfSxcclxuICAgICAge1xyXG4gICAgICAgIGxhYmVsOiAnXHU3QTk3XHU1M0UzJyxcclxuICAgICAgICBzdWJtZW51OiBbXHJcbiAgICAgICAgICB7IHJvbGU6ICdtaW5pbWl6ZScsIGxhYmVsOiAnXHU2NzAwXHU1QzBGXHU1MzE2JyB9LFxyXG4gICAgICAgICAgeyByb2xlOiAnem9vbScsIGxhYmVsOiAnXHU3RjI5XHU2NTNFJyB9LFxyXG4gICAgICAgICAgeyB0eXBlOiAnc2VwYXJhdG9yJyB9LFxyXG4gICAgICAgICAgeyByb2xlOiAnY2xvc2UnLCBsYWJlbDogJ1x1NTE3M1x1OTVFRCcgfSxcclxuICAgICAgICBdLFxyXG4gICAgICB9LFxyXG4gICAgXTtcclxuICAgIE1lbnUuc2V0QXBwbGljYXRpb25NZW51KE1lbnUuYnVpbGRGcm9tVGVtcGxhdGUodGVtcGxhdGUpKTtcclxuICB9XHJcbiAgLyoqIFx1NjgwN1x1OTg5OFx1NjgwRiBcdTI2MzAgXHU0RTNCXHU4M0RDXHU1MzU1KFx1NUUzOFx1NzUyOFx1NTJBOFx1NEY1Q1x1NzY4NFx1NTUyRlx1NEUwMFx1NTE2NVx1NTNFMztcdTg5QzZcdTU2RkVcdTYwMDFcdTdFQ0YgbWVudTphY3Rpb24gXHU4RjZDXHU1M0QxKVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIHBvcHVwTWFpbk1lbnUoKTogdm9pZCB7XHJcbiAgICBjb25zdCBzZW5kID0gKGE6IHN0cmluZyk6IHZvaWQgPT4ge1xyXG4gICAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcclxuICAgICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCdtZW51OmFjdGlvbicsIGEpO1xyXG4gICAgICB9XHJcbiAgICB9O1xyXG4gICAgY29uc3Qgd2luID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkuZmluZCgodykgPT4gIXcuaXNEZXN0cm95ZWQoKSk7XHJcbiAgICBpZiAod2luID09PSB1bmRlZmluZWQpIHJldHVybjtcclxuICAgIE1lbnUuYnVpbGRGcm9tVGVtcGxhdGUoW1xyXG4gICAgICB7IGxhYmVsOiAnXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREJywgYWNjZWxlcmF0b3I6ICdDbWRPckN0cmwrTicsIGNsaWNrOiAoKTogdm9pZCA9PiBzZW5kKCduZXctc2Vzc2lvbicpIH0sXHJcbiAgICAgIHsgbGFiZWw6ICdcdThCQkVcdTdGNkUnLCBhY2NlbGVyYXRvcjogJ0NtZE9yQ3RybCtTaGlmdCtQJywgY2xpY2s6ICgpOiB2b2lkID0+IHNlbmQoJ29wZW4tc2V0dGluZ3MnKSB9LFxyXG4gICAgICB7IGxhYmVsOiAnXHU1RkVCXHU2Mzc3XHU5NTJFJywgYWNjZWxlcmF0b3I6ICdDbWRPckN0cmwrLycsIGNsaWNrOiAoKTogdm9pZCA9PiBzZW5kKCdzaG9ydGN1dHMnKSB9LFxyXG4gICAgICB7IHR5cGU6ICdzZXBhcmF0b3InIH0sXHJcbiAgICAgIHsgbGFiZWw6ICdcdTYyNEJcdTY3M0FcdThGRENcdTdBMEJcdTYzQTdcdTUyMzYnLCBjbGljazogKCk6IHZvaWQgPT4gc2VuZCgnb3Blbi1yZW1vdGUnKSB9LFxyXG4gICAgICB7IHR5cGU6ICdzZXBhcmF0b3InIH0sXHJcbiAgICAgIHtcclxuICAgICAgICBsYWJlbDogdXBkYXRlU3RhdGUuZG93bmxvYWRlZCA/IGBcdTkxQ0RcdTU0MkZcdTVFNzZcdTVCODlcdTg4QzVcdTY2RjRcdTY1QjAodiR7dXBkYXRlU3RhdGUubGF0ZXN0ID8/ICc/J30pYCA6ICdcdTY4QzBcdTY3RTVcdTY2RjRcdTY1QjBcdTIwMjYnLFxyXG4gICAgICAgIGNsaWNrOiAoKTogdm9pZCA9PiB7XHJcbiAgICAgICAgICBpZiAodXBkYXRlU3RhdGUuZG93bmxvYWRlZCkgeyBhcHBseVVwZGF0ZSgpOyByZXR1cm47IH1cclxuICAgICAgICAgIHZvaWQgY2hlY2tGb3JVcGRhdGVzKCkudGhlbigoc3QpID0+IHtcclxuICAgICAgICAgICAgY29uc3QgbmV3ZXIgPSBzdC5sYXRlc3QgIT09IG51bGwgJiYgKGNtcFZlcnNpb24oc3QuY3VycmVudFZlcnNpb24sIHN0LmxhdGVzdCkgPCAwIHx8IFVQREFURV9GT1JDRV9UQUcgIT09ICcnKTtcclxuICAgICAgICAgICAgY29uc3QgZGV0YWlsID0gbmV3ZXIgPyBgJHtzdC5ub3Rlc31cXG5cXG5cdTVCODlcdTg4QzVcdTUzMDVcdTZCNjNcdTU3MjhcdTU0MEVcdTUzRjBcdTRFMEJcdThGN0QsXHU1QjhDXHU2MjEwXHU1NDBFXHU5ODc2XHU5MEU4XHU2QTJBXHU1RTQ1XHU0RjFBXHU1MUZBXHU3M0IwXCJcdTkxQ0RcdTU0MkZcdTY2RjRcdTY1QjBcIlx1NEUwMFx1OTUyRVx1NUI4OVx1ODhDNShcdTY1RTBcdTk3MDBcdTYyNTNcdTVGMDBcdTRFMEJcdThGN0RcdTk4NzUpXHUzMDAyYCA6ICcnO1xyXG4gICAgICAgICAgICB2b2lkIGRpYWxvZy5zaG93TWVzc2FnZUJveCh3aW4sIHtcclxuICAgICAgICAgICAgICB0eXBlOiAnaW5mbycsXHJcbiAgICAgICAgICAgICAgdGl0bGU6ICdcdTY4QzBcdTY3RTVcdTY2RjRcdTY1QjAnLFxyXG4gICAgICAgICAgICAgIG1lc3NhZ2U6IG5ld2VyXHJcbiAgICAgICAgICAgICAgICA/IGBcdTUzRDFcdTczQjBcdTY1QjBcdTcyNDhcdTY3MkMgdiR7c3QubGF0ZXN0fSFgXHJcbiAgICAgICAgICAgICAgICA6IChzdC5lcnJvciAhPT0gJycgPyBgXHU2OEMwXHU2N0U1XHU1OTMxXHU4RDI1OiR7c3QuZXJyb3J9YCA6IGBcdTVERjJcdTY2MkZcdTY3MDBcdTY1QjBcdTcyNDhcdTY3MkModiR7c3QuY3VycmVudFZlcnNpb259KWApLFxyXG4gICAgICAgICAgICAgIGRldGFpbCxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICB9KTtcclxuICAgICAgICB9LFxyXG4gICAgICB9LFxyXG4gICAgICB7XHJcbiAgICAgICAgbGFiZWw6ICdcdTUxNzNcdTRFOEUgSE1IIERlc2t0b3AnLFxyXG4gICAgICAgIGNsaWNrOiAoKTogdm9pZCA9PiB7XHJcbiAgICAgICAgICB2b2lkIGRpYWxvZy5zaG93TWVzc2FnZUJveCh3aW4sIHtcclxuICAgICAgICAgICAgdHlwZTogJ2luZm8nLFxyXG4gICAgICAgICAgICB0aXRsZTogJ1x1NTE3M1x1NEU4RSBITUggRGVza3RvcCcsXHJcbiAgICAgICAgICAgIG1lc3NhZ2U6ICdITUggRGVza3RvcCcsXHJcbiAgICAgICAgICAgIGRldGFpbDogYGFwcCB2JHthcHAuZ2V0VmVyc2lvbigpfSBcdTAwQjcgXHU2NkY0XHU2NUIwXHU5MDFBXHU5MDUzOiR7dXBkYXRlU3RhdGUuY2hhbm5lbCB8fCAnLSd9XFxucnVudGltZTogaG1oYXJuZXNzICR7YnJpZGdlLmhvc3RWZXJzaW9uID8/ICcoXHU2NzJBXHU4RkRFXHU2M0E1KSd9JHt1c2VCdW5kbGVkUnVudGltZSA/ICcoXHU1MTg1XHU3RjZFKScgOiAnJ31cXG5cdTZBMjFcdTVGMEY6ICR7YnJpZGdlLm1vZGUgPT09ICdyZWFsJyA/ICh1c2VCdW5kbGVkUnVudGltZSA/ICdcdTc3MUZcdTVCOUUgaG1oYXJuZXNzKFx1NTE4NVx1N0Y2RSBydW50aW1lKScgOiAnXHU3NzFGXHU1QjlFIGhtaGFybmVzcyhcdTU5MTZcdTkwRThcdTVCODlcdTg4QzUpJykgOiAnXHU2RjE0XHU3OTNBKFx1NTA0N1x1NjU3MFx1NjM2RSknfVxcblxcblx1NEUwRSBDTEkgLyBUVUkgLyBcdTdGNTFcdTk4NzVcdTcyNDhcdTUxNzFcdTRFQUJcdTU0MENcdTRFMDAgSE1IX0hPTUVcdTMwMDJgLFxyXG4gICAgICAgICAgfSk7XHJcbiAgICAgICAgfSxcclxuICAgICAgfSxcclxuICAgICAgeyBsYWJlbDogJ1x1OTAwMFx1NTFGQScsIHJvbGU6ICdxdWl0JyB9LFxyXG4gICAgXSkucG9wdXAoeyB3aW5kb3c6IHdpbiB9KTtcclxuICB9XHJcblxyXG4gIC8qIC0tLS0gXHU2MjRCXHU2NzNBXHU4RkRDXHU3QTBCXHU2M0E3XHU1MjM2KDAzIFx1NTNGNzpXZWIgNzc4OCBcdTY2MkZcdTZENEZcdTg5QzhcdTU2NjgvXHU4RkRDXHU3QTBCL1x1NjI0Qlx1NjczQVx1NTE2NVx1NTNFMyxBRFItMDA1OlxyXG4gICAgIERlc2t0b3AgXHU0RTBEXHU5RUQ4XHU4QkE0XHU2MjUzXHU1RjAwIExBTiBcdTIwMTRcdTIwMTQgXHU4RkQ5XHU5MUNDXHU2NjJGXHU3NTI4XHU2MjM3XHU2NjNFXHU1RjBGXHU1NDJGXHU1MkE4XHU3Njg0XHU1MTY1XHU1M0UzKSAtLS0tICovXHJcbiAgY29uc3QgV0VCX1BPUlQgPSA3Nzg4O1xyXG4gIGFzeW5jIGZ1bmN0aW9uIHByb2JlV2ViUmVtb3RlKCk6IFByb21pc2U8eyB1cDogYm9vbGVhbjsgdmVyc2lvbjogc3RyaW5nIH0+IHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHIgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke1dFQl9QT1JUfS9hcGkvc3RhdGVgLCB7IHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCgxNTAwKSB9KTtcclxuICAgICAgaWYgKCFyLm9rKSByZXR1cm4geyB1cDogZmFsc2UsIHZlcnNpb246ICcnIH07XHJcbiAgICAgIGNvbnN0IGQgPSAoYXdhaXQgci5qc29uKCkpIGFzIHsgZGFlbW9uVmVyc2lvbj86IHN0cmluZyB9O1xyXG4gICAgICByZXR1cm4geyB1cDogdHJ1ZSwgdmVyc2lvbjogU3RyaW5nKGQuZGFlbW9uVmVyc2lvbiA/PyAnJykgfTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4geyB1cDogZmFsc2UsIHZlcnNpb246ICcnIH07IH1cclxuICB9XHJcbiAgLyoqIFx1NUYwMFx1NjczQVx1ODFFQVx1NTQyRlx1NjYyRlx1NTQyNlx1NURGMlx1ODhDNShydW50aW1lIHdlYi1kYWVtb24gXHU3Njg0XHU1NDJGXHU1MkE4XHU5ODc5XHU2NTg3XHU0RUY2XHU1QjU4XHU1NzI4XHU2MDI3OzAuMjMuMzcgXHU2NUIwXHU4MEZEXHU1MjlCKVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIHdlYkF1dG9zdGFydEluc3RhbGxlZCgpOiBib29sZWFuIHtcclxuICAgIGNvbnN0IGhvbWUgPSBwcm9jZXNzLmVudi5IT01FID8/ICcnO1xyXG4gICAgY29uc3QgY2FuZGlkYXRlcyA9IHByb2Nlc3MucGxhdGZvcm0gPT09ICd3aW4zMidcclxuICAgICAgPyBbam9pbihwcm9jZXNzLmVudi5BUFBEQVRBID8/ICcnLCAnTWljcm9zb2Z0JywgJ1dpbmRvd3MnLCAnU3RhcnQgTWVudScsICdQcm9ncmFtcycsICdTdGFydHVwJywgJ2htaGFybmVzcy13ZWItZGFlbW9uLmNtZCcpXVxyXG4gICAgICA6IHByb2Nlc3MucGxhdGZvcm0gPT09ICdkYXJ3aW4nXHJcbiAgICAgICAgPyBbam9pbihob21lLCAnTGlicmFyeScsICdMYXVuY2hBZ2VudHMnLCAnaG1oYXJuZXNzLXdlYi1kYWVtb24ucGxpc3QnKV1cclxuICAgICAgICA6IFtqb2luKGhvbWUsICcuY29uZmlnJywgJ3N5c3RlbWQnLCAndXNlcicsICdobWhhcm5lc3Mtd2ViLWRhZW1vbi5zZXJ2aWNlJyldO1xyXG4gICAgcmV0dXJuIGNhbmRpZGF0ZXMuc29tZSgocCkgPT4geyB0cnkgeyByZXR1cm4gZXhpc3RzU3luYyhwKTsgfSBjYXRjaCB7IHJldHVybiBmYWxzZTsgfSB9KTtcclxuICB9XHJcbiAgLyoqIFx1NjI0Qlx1NjczQVx1NTNFRlx1OERFRlx1NzUzMVx1NzY4NCBMQU4gSVAoUkZDMTkxOCxcdTYzOTJcdTk2NjRcdTg2NUFcdTYyREZcdTdGNTFcdTUzNjEpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gbGFuSXBPZigpOiBzdHJpbmcge1xyXG4gICAgY29uc3QgVklSVFVBTCA9IC92bXdhcmV8dmlydHVhbHxoeXBlci0/dnx2ZXRoZXJuZXR8d3NsfHRhaWxzY2FsZXxsb29wYmFja3xibHVldG9vdGh8dmJveHxkb2NrZXJ8dGFwLXxwc2V1ZG8vaTtcclxuICAgIGNvbnN0IGlzUmZjMTkxOCA9IChhOiBzdHJpbmcpOiBib29sZWFuID0+IC9eMTBcXC4vLnRlc3QoYSkgfHwgL14xOTJcXC4xNjhcXC4vLnRlc3QoYSkgfHwgL14xNzJcXC4oMVs2LTldfDJcXGR8M1swMV0pXFwuLy50ZXN0KGEpO1xyXG4gICAgbGV0IGxhbklwID0gJyc7XHJcbiAgICBsZXQgZmFsbGJhY2sgPSAnJztcclxuICAgIGZvciAoY29uc3QgW25hbWUsIGxpc3RdIG9mIE9iamVjdC5lbnRyaWVzKG5ldHdvcmtJbnRlcmZhY2VzKCkpKSB7XHJcbiAgICAgIGZvciAoY29uc3QgbiBvZiBsaXN0ID8/IFtdKSB7XHJcbiAgICAgICAgaWYgKG4uZmFtaWx5ICE9PSAnSVB2NCcgfHwgbi5pbnRlcm5hbCB8fCAhaXNSZmMxOTE4KG4uYWRkcmVzcykpIGNvbnRpbnVlO1xyXG4gICAgICAgIGlmICghVklSVFVBTC50ZXN0KG5hbWUpKSBsYW5JcCA9IGxhbklwIHx8IG4uYWRkcmVzcztcclxuICAgICAgICBlbHNlIGZhbGxiYWNrID0gZmFsbGJhY2sgfHwgbi5hZGRyZXNzO1xyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gbGFuSXAgfHwgZmFsbGJhY2s7XHJcbiAgfVxyXG4gIC8qKiBDTEkgXHU1MTY1XHU1M0UzOlx1NkU5MFx1NzgwMSByZXBvIFx1NUUwM1x1NUM0MChtYWluLnRzLFx1N0VDRiB0c3gpXHU2MjE2IG5wbSBcdTVCODlcdTg4QzVcdTVFMDNcdTVDNDAoZGlzdC9tYWluLmpzXHJcbiAgICogIFx1NzZGNFx1OEREMVx1MjAxNFx1MjAxNFx1NEVDRSBydW50aW1lIFx1NTE2NVx1NTNFM1x1NEUwQVx1NkVBRlx1NjI3RSBAaG1oYXJuZXNzL2NsaSBcdTUzMDU7XHU1RDRDXHU1OTU3L1x1NjNEMFx1NTM0Ny9cdTZFOTBcdTc4MDFcdTRFMDlcdTc5Q0RcdTVFMDNcdTVDNDBcdTkwMUFcdTU0MDMpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gY2xpRW50cnlPZigpOiBzdHJpbmcge1xyXG4gICAgaWYgKHJ1bnRpbWVFbnRyeSA9PT0gJycgfHwgcnVudGltZUVudHJ5ID09PSBudWxsKSByZXR1cm4gJyc7XHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCBwID0gam9pbihyZXBvUm9vdE9mKHJ1bnRpbWVFbnRyeSksICdwYWNrYWdlcycsICdjbGknLCAnc3JjJywgJ21haW4udHMnKTtcclxuICAgICAgaWYgKGV4aXN0c1N5bmMocCkpIHJldHVybiBwO1xyXG4gICAgfSBjYXRjaCB7IC8qIFx1OTc1RSByZXBvIFx1NUUwM1x1NUM0MCAqLyB9XHJcbiAgICBsZXQgZGlyID0gZGlybmFtZShydW50aW1lRW50cnkpO1xyXG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCA4OyBpKyspIHtcclxuICAgICAgaWYgKGV4aXN0c1N5bmMoam9pbihkaXIsICdkaXN0JywgJ21haW4uanMnKSkgJiYgcGtnTmFtZUF0KGRpcikgPT09ICdAaG1oYXJuZXNzL2NsaScpIHJldHVybiBqb2luKGRpciwgJ2Rpc3QnLCAnbWFpbi5qcycpO1xyXG4gICAgICBpZiAoYmFzZW5hbWUoZGlyKSA9PT0gJ0BobWhhcm5lc3MnICYmIGV4aXN0c1N5bmMoam9pbihkaXIsICdjbGknLCAnZGlzdCcsICdtYWluLmpzJykpKSByZXR1cm4gam9pbihkaXIsICdjbGknLCAnZGlzdCcsICdtYWluLmpzJyk7XHJcbiAgICAgIGNvbnN0IHBhcmVudCA9IGRpcm5hbWUoZGlyKTtcclxuICAgICAgaWYgKHBhcmVudCA9PT0gZGlyKSBicmVhaztcclxuICAgICAgZGlyID0gcGFyZW50O1xyXG4gICAgfVxyXG4gICAgcmV0dXJuICcnO1xyXG4gIH1cclxuICBmdW5jdGlvbiBydW5DbGkoYXJnczogc3RyaW5nW10pOiB2b2lkIHtcclxuICAgIGNvbnN0IGVudHJ5ID0gY2xpRW50cnlPZigpO1xyXG4gICAgaWYgKGVudHJ5ID09PSAnJykgcmV0dXJuO1xyXG4gICAgY29uc3QgaXNUcyA9IGVudHJ5LmVuZHNXaXRoKCcudHMnKTtcclxuICAgIGNvbnN0IHJlcG8gPSByZXBvUm9vdE9mKHJ1bnRpbWVFbnRyeSA/PyBlbnRyeSk7XHJcbiAgICBjb25zdCBjaGlsZCA9IHNwYXduKHByb2Nlc3MuZXhlY1BhdGgsIGlzVHMgPyBbJy0taW1wb3J0JywgJ3RzeCcsIGVudHJ5LCAuLi5hcmdzXSA6IFtlbnRyeSwgLi4uYXJnc10sIHtcclxuICAgICAgY3dkOiBpc1RzID8gcmVwbyA6IGRpcm5hbWUoZW50cnkpLFxyXG4gICAgICBkZXRhY2hlZDogdHJ1ZSxcclxuICAgICAgc3RkaW86ICdpZ25vcmUnLFxyXG4gICAgICB3aW5kb3dzSGlkZTogdHJ1ZSxcclxuICAgICAgZW52OiB7IEVMRUNUUk9OX1JVTl9BU19OT0RFOiAnMScgfSxcclxuICAgIH0pO1xyXG4gICAgY2hpbGQudW5yZWYoKTtcclxuICB9XHJcblxyXG4gIGZ1bmN0aW9uIGJyb2FkY2FzdEhvc3RTdGF0ZShzOiBIb3N0U3RhdGUsIGluZm86IHsgcmVzdGFydENvdW50OiBudW1iZXI7IGxhc3RFcnJvcj86IHN0cmluZyB9KTogdm9pZCB7XHJcbiAgICBicmlkZ2UgPSB7IC4uLmJyaWRnZSwgaG9zdFN0YXRlOiBzLCBob3N0UG9ydDogc3VwZXJ2aXNvcj8uZW5kcG9pbnQ/LnBvcnQgPz8gbnVsbCwgaG9zdFZlcnNpb246IHN1cGVydmlzb3I/LmVuZHBvaW50Py52ZXJzaW9uID8/IG51bGwgfTtcclxuICAgIGxvZ0luZm8oJ2hvc3QnLCBgc3RhdGU9JHtzfSR7aW5mby5sYXN0RXJyb3IgIT09IHVuZGVmaW5lZCA/IGAgZXJyPSR7aW5mby5sYXN0RXJyb3J9YCA6ICcnfWApO1xyXG4gICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XHJcbiAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ2JyaWRnZTpob3N0LXN0YXRlJywgcywgaW5mbyk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvKiogU1NFIFx1NkQ0MVx1OEJBMlx1OTYwNTpcdTRGRTFcdTVDMDEoZXZlbnQ6IGhtaClcdTYyNzlcdTkxQ0ZcdTYzQTggcmVuZGVyZXI7XHU5QUQ4XHU5ODkxIGRlbHRhL2xpbmUgXHU1MzlGXHU1RTI3XHJcbiAgICogIFx1NEY1Q1x1NEUzQVx1NkQ0MVx1NTc1N1x1OEY2Q1x1NTNEMShyZW5kZXJlciBcdTYyRkNcdTYzQTVcdTVGNTNcdTUyNEQgYXNzaXN0YW50IFx1NTM2MFx1NEY0RClcdTMwMDJcdTY1QURcdTdFQkZcdTgxRUFcdTUyQThcdTkxQ0RcdThGREVcdTMwMDIgKi9cclxuICBhc3luYyBmdW5jdGlvbiBwdW1wRXZlbnRzKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgaWYgKGNsaWVudCA9PT0gbnVsbCkgcmV0dXJuO1xyXG4gICAgZm9yICg7Oykge1xyXG4gICAgICBjb25zdCBjID0gY2xpZW50O1xyXG4gICAgICBpZiAoYyA9PT0gbnVsbCkgcmV0dXJuO1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGZvciBhd2FpdCAoY29uc3QgZnJhbWUgb2YgYy5yYXdFdmVudHMobGFzdEV2ZW50SWQgPT09ICcnID8gdW5kZWZpbmVkIDogbGFzdEV2ZW50SWQsIHNzZUFib3J0Py5zaWduYWwpKSB7XHJcbiAgICAgICAgICBpZiAoZnJhbWUuZXZlbnQgPT09ICdobWgnKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGVudiA9IGVudmVsb3BlRnJvbUZyYW1lKGZyYW1lKTtcclxuICAgICAgICAgICAgaWYgKGVudiA9PT0gbnVsbCkge1xyXG4gICAgICAgICAgICAgIGRyb3BwZWRGcmFtZXMgKz0gMTtcclxuICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBsYXN0RXZlbnRJZCA9IGVudi5ldmVudElkO1xyXG4gICAgICAgICAgICBwdXNoRXZlbnQoZW52KTtcclxuICAgICAgICAgIH0gZWxzZSBpZiAoZnJhbWUuZXZlbnQgPT09ICdkZWx0YScgfHwgZnJhbWUuZXZlbnQgPT09ICdsaW5lJykge1xyXG4gICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgIGNvbnN0IGQgPSBKU09OLnBhcnNlKGZyYW1lLmRhdGEpIGFzIHsgc2Vzc2lvbklkPzogc3RyaW5nOyBrPzogc3RyaW5nOyBjaHVuaz86IHN0cmluZzsgdGV4dD86IHN0cmluZyB9O1xyXG4gICAgICAgICAgICAgIGNvbnN0IHBheWxvYWQgPSBmcmFtZS5ldmVudCA9PT0gJ2RlbHRhJ1xyXG4gICAgICAgICAgICAgICAgPyB7IHNlc3Npb25JZDogZC5zZXNzaW9uSWQgPz8gJycsIGtpbmQ6IGQuayA/PyAndGV4dCcsIGNodW5rOiBTdHJpbmcoZC5jaHVuayA/PyAnJykgfVxyXG4gICAgICAgICAgICAgICAgOiB7IHNlc3Npb25JZDogZC5zZXNzaW9uSWQgPz8gJycsIGtpbmQ6ICdsaW5lJywgY2h1bms6IFN0cmluZyhkLnRleHQgPz8gJycpIH07XHJcbiAgICAgICAgICAgICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XHJcbiAgICAgICAgICAgICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCdicmlkZ2U6c3RyZWFtLWNodW5rJywgcGF5bG9hZCk7XHJcbiAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9IGNhdGNoIHsgLyogbWFsZm9ybWVkIHN0cmVhbSBmcmFtZTogc2tpcCAqLyB9XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybjsgLy8gXHU2RDQxXHU2QjYzXHU1RTM4XHU3RUQzXHU2NzVGKGhvc3QgXHU1MTczXHU5NUVEKVxyXG4gICAgICB9IGNhdGNoIHtcclxuICAgICAgICAvLyBcdTY1QURcdTdFQkY6XHU3N0VEXHU5MDAwXHU5MDdGXHU1NDBFXHU5MUNEXHU4RkRFKHN1cGVydmlzb3IgXHU1M0VGXHU4MEZEXHU2QjYzXHU1NzI4XHU5MUNEXHU1NDJGIGhvc3QpXHJcbiAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgMV8wMDApKTtcclxuICAgICAgICBpZiAoc3NlQWJvcnQ/LnNpZ25hbC5hYm9ydGVkKSByZXR1cm47XHJcbiAgICAgIH1cclxuICAgIH1cclxuICB9XHJcblxyXG4gIC8qIC0tLS0gaG1oYXJuZXNzIHJ1bnRpbWUgXHU4MUVBXHU1MkE4XHU1M0QxXHU3M0IwKDIwMjYtMTAtMTAgXHU3NTI4XHU2MjM3XHU1QjlBXHU4QzAzOlx1ODhDNVx1OEZDNyBobWhhcm5lc3MgXHU3Njg0XHJcbiAgICAgXHU2NzNBXHU1NjY4XHU5NkY2XHU5MTREXHU3RjZFXHU3NkY0XHU4RkRFLFx1NTkwRFx1NzUyOCBDTEkvVFVJL3dlYiA3Nzg4IFx1NzY4NFx1NTQwQ1x1NEUwMCBITUhfSE9NRVx1MjAxNFx1MjAxNGNvbmZpZy9wcm92aWRlcnMvXHJcbiAgICAgXHU0RjFBXHU4QkREXHU1Mzg2XHU1M0YyXHU1OTI5XHU3MTM2XHU1MTcxXHU0RUFCKVx1MzAwMnY1LjEgXHU1M0QxXHU3M0IwXHU5ODdBXHU1RThGOlx1NjYzRVx1NUYwRlx1OTE0RFx1N0Y2RSA+IHdoZXJlIGhtaChcdTZFOTBcdTc4MDEgbGluayBcdTRFMEVcclxuICAgICBAaG1oYXJuZXNzL2NsaSBucG0gXHU1Qjg5XHU4OEM1XHU0RTI0XHU3OUNEXHU1RTAzXHU1QzQwKT4gbnBtIFx1NTE2OFx1NUM0MFx1NjgzOShcdTU0MEMpPiBcdTU0MTFcdTVCRkNcdTVCODlcdTg4QzVcdTc2RUVcdTVGNTVcclxuICAgICB+Ly5obWhhcm5lc3MtZ2xvYmFsID4gXHU1RTM4XHU4OUMxXHU2RTkwXHU3ODAxXHU0RjREXHU3RjZFXHUzMDAyICovXHJcbiAgY29uc3QgcnVudGltZUNvbmZpZ0ZpbGUgPSAoKTogc3RyaW5nID0+IGpvaW4oYXBwLmdldFBhdGgoJ3VzZXJEYXRhJyksICdydW50aW1lLmpzb24nKTtcclxuICAvKiogcnVudGltZS5qc29uOnsgZW50cnkoXHU2MjRCXHU1MkE4L1x1NTQxMVx1NUJGQ1x1OTAwOVx1NjJFOVx1NzY4NFx1NTE2NVx1NTNFMyksIGRlbW8oXHU2MzAxXHU0RTQ1XHU2RjE0XHU3OTNBXHU2QTIxXHU1RjBGKSB9XHUzMDAyICovXHJcbiAgYXN5bmMgZnVuY3Rpb24gbG9hZFJ1bnRpbWVDb25maWcoKTogUHJvbWlzZTx7IGVudHJ5OiBzdHJpbmc7IGRlbW86IGJvb2xlYW4gfT4ge1xyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3QgdiA9IEpTT04ucGFyc2UoYXdhaXQgcmVhZEZpbGUocnVudGltZUNvbmZpZ0ZpbGUoKSwgJ3V0ZjgnKSkgYXMgeyBlbnRyeT86IHVua25vd247IGRlbW8/OiB1bmtub3duIH07XHJcbiAgICAgIHJldHVybiB7XHJcbiAgICAgICAgZW50cnk6IHR5cGVvZiB2LmVudHJ5ID09PSAnc3RyaW5nJyAmJiB2LmVudHJ5ICE9PSAnJyAmJiBpc0Fic29sdXRlKHYuZW50cnkpID8gdi5lbnRyeSA6ICcnLFxyXG4gICAgICAgIGRlbW86IHYuZGVtbyA9PT0gdHJ1ZSxcclxuICAgICAgfTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4geyBlbnRyeTogJycsIGRlbW86IGZhbHNlIH07IH1cclxuICB9XHJcbiAgYXN5bmMgZnVuY3Rpb24gc2F2ZVJ1bnRpbWVDb25maWcoY2ZnOiB7IGVudHJ5OiBzdHJpbmc7IGRlbW86IGJvb2xlYW4gfSk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgYXdhaXQgd3JpdGVGaWxlKHJ1bnRpbWVDb25maWdGaWxlKCksIEpTT04uc3RyaW5naWZ5KGNmZywgbnVsbCwgMiksICd1dGY4JykuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcclxuICB9XHJcbiAgYXN5bmMgZnVuY3Rpb24gbG9hZFJ1bnRpbWVFbnRyeU92ZXJyaWRlKCk6IFByb21pc2U8c3RyaW5nPiB7XHJcbiAgICByZXR1cm4gKGF3YWl0IGxvYWRSdW50aW1lQ29uZmlnKCkpLmVudHJ5O1xyXG4gIH1cclxuICBhc3luYyBmdW5jdGlvbiBzYXZlUnVudGltZUVudHJ5T3ZlcnJpZGUoZW50cnk6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgYXdhaXQgc2F2ZVJ1bnRpbWVDb25maWcoeyBlbnRyeSwgZGVtbzogKGF3YWl0IGxvYWRSdW50aW1lQ29uZmlnKCkpLmRlbW8gfSk7XHJcbiAgfVxyXG5cclxuICBpbnRlcmZhY2UgRXh0ZXJuYWxSdW50aW1lIHsgZW50cnk6IHN0cmluZzsgdmVyc2lvbjogc3RyaW5nOyBzb3VyY2U6IHN0cmluZyB9XHJcblxyXG4gIC8qKiBcdThCRkJcdTUzMDVcdTcyNDhcdTY3MkMocGFja2FnZS5qc29uIFx1NzY4NCB2ZXJzaW9uIFx1NUI1N1x1NkJCNTtcdTU5MzFcdThEMjVcdTdBN0FcdTRFMzIpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gcGtnVmVyc2lvbkF0KGRpcjogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHYgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKGRpciwgJ3BhY2thZ2UuanNvbicpLCAndXRmOCcpKSBhcyB7IHZlcnNpb24/OiB1bmtub3duIH07XHJcbiAgICAgIHJldHVybiB0eXBlb2Ygdi52ZXJzaW9uID09PSAnc3RyaW5nJyA/IHYudmVyc2lvbiA6ICcnO1xyXG4gICAgfSBjYXRjaCB7IHJldHVybiAnJzsgfVxyXG4gIH1cclxuICAvKiogXHU4QkZCXHU1MzA1XHU1NDBEKFx1NTQwQ1x1NEUwQTtAaG1oYXJuZXNzL2NsaSBcdTVFMDNcdTVDNDBcdThCQzZcdTUyMkJcdTc1MjgpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gcGtnTmFtZUF0KGRpcjogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHYgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKGRpciwgJ3BhY2thZ2UuanNvbicpLCAndXRmOCcpKSBhcyB7IG5hbWU/OiB1bmtub3duIH07XHJcbiAgICAgIHJldHVybiB0eXBlb2Ygdi5uYW1lID09PSAnc3RyaW5nJyA/IHYubmFtZSA6ICcnO1xyXG4gICAgfSBjYXRjaCB7IHJldHVybiAnJzsgfVxyXG4gIH1cclxuXHJcbiAgLyoqIG5wbSBcdTVCODlcdTg4QzVcdTc2ODQgQGhtaGFybmVzcy9jbGkgXHUyMTkyIGRlc2t0b3AtaG9zdCBcdTdGMTZcdThCRDFcdTUxNjVcdTUzRTMoXHU1RDRDXHU1OTU3XHU0RTBFXHU2M0QwXHU1MzQ3XHU0RTI0XHU3OUNEXHU1RTAzXHU1QzQwKVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIGVudHJ5RnJvbUNsaURpcihjbGlEaXI6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICBjb25zdCBuZXN0ZWQgPSBqb2luKGNsaURpciwgJ25vZGVfbW9kdWxlcycsICdAaG1oYXJuZXNzJywgJ3dlYicsICdkaXN0JywgJ2Rlc2t0b3AtaG9zdC5qcycpO1xyXG4gICAgaWYgKGV4aXN0c1N5bmMobmVzdGVkKSkgcmV0dXJuIG5lc3RlZDtcclxuICAgIGNvbnN0IGhvaXN0ZWQgPSBqb2luKGRpcm5hbWUoY2xpRGlyKSwgJ3dlYicsICdkaXN0JywgJ2Rlc2t0b3AtaG9zdC5qcycpO1xyXG4gICAgaWYgKGV4aXN0c1N5bmMoaG9pc3RlZCkpIHJldHVybiBob2lzdGVkO1xyXG4gICAgcmV0dXJuICcnO1xyXG4gIH1cclxuXHJcbiAgLyoqIFx1NTkxNlx1OTBFOFx1NTNEMVx1NzNCMChcdTRGOUJcdTgxRUFcdTUyQThcdThGREVcdTYzQTVcdTRFMEVcdTU0MTFcdTVCRkNcdTY4QzBcdTZENEJcdTk4NzVcdTUxNzFcdTc1MjgpXHUzMDAyXHU0RjE4XHU1MTQ4XHU3RUE3OmVudiA+IHdoZXJlIGhtaCA+IG5wbVxyXG4gICAqICBcdTUxNjhcdTVDNDBcdTY4MzkgPiBcdTU0MTFcdTVCRkNcdTVCODlcdTg4QzVcdTc2RUVcdTVGNTUgfi8uaG1oYXJuZXNzLWdsb2JhbCA+IFx1NkU5MFx1NzgwMVx1NEVEM1x1NjI2Qlx1NjNDRjtcdTU0MENcdTRFMDBcdTVDNDJcdTUxODVcclxuICAgKiAgXCJcdTVERjJcdTg4QzUgQ0xJKG5wbSBcdTVFMDNcdTVDNDApXCIgXHU1MTQ4XHU0RThFIFwiXHU2RTkwXHU3ODAxIHJlcG8gXHU1RTAzXHU1QzQwXCJcdTMwMDIgKi9cclxuICBmdW5jdGlvbiBkZXRlY3RFeHRlcm5hbFJ1bnRpbWUoKTogRXh0ZXJuYWxSdW50aW1lIHtcclxuICAgIC8vIDEpIFx1NzNBRlx1NTg4M1x1NTNEOFx1OTFDRlx1NjYzRVx1NUYwRlx1ODk4Nlx1NzZENihcdTlBRDhcdTdFQTdcdTc1MjhcdTYyMzcpXHJcbiAgICBjb25zdCBlbnZFbnRyeSA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1JFQUxfRU5UUlk7XHJcbiAgICBpZiAoZW52RW50cnkgIT09IHVuZGVmaW5lZCAmJiBlbnZFbnRyeSAhPT0gJycgJiYgaXNBYnNvbHV0ZShlbnZFbnRyeSkpIHtcclxuICAgICAgcmV0dXJuIHsgZW50cnk6IGVudkVudHJ5LCB2ZXJzaW9uOiAnJywgc291cmNlOiAnZW52JyB9O1xyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IHdoZXJlUmVwb3MgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgIGNvbnN0IHdoZXJlQ2xpczogc3RyaW5nW10gPSBbXTtcclxuICAgIGNvbnN0IG5wbVJlcG9zID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICBsZXQgbnBtQ2xpID0gJyc7XHJcbiAgICAvLyAyKSB3aGVyZSBobWg6bnBtIGxpbmsoXHU2RTkwXHU3ODAxXHU2ODM5XHU1RTAzXHU1QzQwKVx1NEUwRSBAaG1oYXJuZXNzL2NsaSBucG0gXHU1Qjg5XHU4OEM1XHU1RTAzXHU1QzQwXHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCBvdXQgPSBleGVjRmlsZVN5bmMoJ3doZXJlJywgWydobWgnXSwgeyBlbmNvZGluZzogJ3V0ZjgnLCB0aW1lb3V0OiA0XzAwMCwgd2luZG93c0hpZGU6IHRydWUgfSk7XHJcbiAgICAgIGZvciAoY29uc3QgbGluZSBvZiBvdXQuc3BsaXQoL1xccj9cXG4vKSkge1xyXG4gICAgICAgIGNvbnN0IGJpbiA9IGxpbmUudHJpbSgpO1xyXG4gICAgICAgIGlmIChiaW4gPT09ICcnKSBjb250aW51ZTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgY29uc3QgYmluRGlyID0gZGlybmFtZShiaW4pO1xyXG4gICAgICAgICAgY29uc3QgbGlua2VkID0gam9pbihiaW5EaXIsICdub2RlX21vZHVsZXMnLCAnaG1oYXJuZXNzJyk7XHJcbiAgICAgICAgICBpZiAoZXhpc3RzU3luYyhsaW5rZWQpKSB3aGVyZVJlcG9zLmFkZChyZWFscGF0aFN5bmMobGlua2VkKSk7XHJcbiAgICAgICAgICBjb25zdCBjbGkgPSBqb2luKGJpbkRpciwgJ25vZGVfbW9kdWxlcycsICdAaG1oYXJuZXNzJywgJ2NsaScpO1xyXG4gICAgICAgICAgaWYgKGV4aXN0c1N5bmMoY2xpKSkgd2hlcmVDbGlzLnB1c2goY2xpKTtcclxuICAgICAgICB9IGNhdGNoIHsgLyogYmluIFx1NUUwM1x1NUM0MFx1NEUwRFx1N0IyNixcdThERjNcdThGQzcgKi8gfVxyXG4gICAgICB9XHJcbiAgICB9IGNhdGNoIHsgLyogaG1oIFx1NEUwRFx1NTcyOCBQQVRIICovIH1cclxuICAgIC8vIDMpIG5wbSBcdTUxNjhcdTVDNDBcdTY4MzkoXHU0RTI0XHU3OUNEXHU1RTAzXHU1QzQwXHU1NDBDIHdoZXJlKVxyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3Qgb3V0ID0gZXhlY0ZpbGVTeW5jKCducG0nLCBbJ3Jvb3QnLCAnLWcnXSwgeyBlbmNvZGluZzogJ3V0ZjgnLCB0aW1lb3V0OiA2XzAwMCwgd2luZG93c0hpZGU6IHRydWUgfSk7XHJcbiAgICAgIGNvbnN0IHJvb3QgPSBvdXQudHJpbSgpO1xyXG4gICAgICBjb25zdCBsaW5rZWQgPSBqb2luKHJvb3QsICdobWhhcm5lc3MnKTtcclxuICAgICAgaWYgKGV4aXN0c1N5bmMobGlua2VkKSkgbnBtUmVwb3MuYWRkKHJlYWxwYXRoU3luYyhsaW5rZWQpKTtcclxuICAgICAgY29uc3QgY2xpID0gam9pbihyb290LCAnQGhtaGFybmVzcycsICdjbGknKTtcclxuICAgICAgaWYgKGV4aXN0c1N5bmMoY2xpKSkgbnBtQ2xpID0gY2xpO1xyXG4gICAgfSBjYXRjaCB7IC8qIG5wbSBcdTRFMERcdTUzRUZcdTc1MjggKi8gfVxyXG5cclxuICAgIC8vIFx1NURGMlx1ODhDNSBDTEkoQGhtaGFybmVzcy9jbGkgbnBtIFx1NUUwM1x1NUM0MDtkZXNrdG9wLWhvc3QgXHU0RTNBXHU3RjE2XHU4QkQxXHU0RUE3XHU3MjY5XHU1M0VGXHU3NkY0XHU4REQxKTpcclxuICAgIC8vIHdoZXJlKFBBVEggXHU3NzFGXHU3NkY4KT4gbnBtIFx1NTE2OFx1NUM0MFx1NjgzOSA+IFx1NTQxMVx1NUJGQ1x1NUI4OVx1ODhDNVx1NzZFRVx1NUY1NVxyXG4gICAgZm9yIChjb25zdCBbY2xpLCBzb3VyY2VdIG9mIFtbd2hlcmVDbGlzWzBdID8/ICcnLCAnd2hlcmUtaG1oJ10sIFtucG1DbGksICducG0tZ2xvYmFsJ11dIGFzIEFycmF5PFtzdHJpbmcsIHN0cmluZ10+KSB7XHJcbiAgICAgIGlmIChjbGkgPT09ICcnKSBjb250aW51ZTtcclxuICAgICAgY29uc3QgZW50cnkgPSBlbnRyeUZyb21DbGlEaXIoY2xpKTtcclxuICAgICAgaWYgKGVudHJ5ICE9PSAnJykgcmV0dXJuIHsgZW50cnksIHZlcnNpb246IHBrZ1ZlcnNpb25BdChjbGkpLCBzb3VyY2UgfTtcclxuICAgIH1cclxuICAgIGNvbnN0IHdpemFyZEVudHJ5ID0gcmVzb2x2ZUluc3RhbGxlZEVudHJ5KGluc3RhbGxUYXJnZXQoKSk7XHJcbiAgICBpZiAod2l6YXJkRW50cnkgIT09ICcnKSB7XHJcbiAgICAgIHJldHVybiB7IGVudHJ5OiB3aXphcmRFbnRyeSwgdmVyc2lvbjogcGtnVmVyc2lvbkF0KGpvaW4oaW5zdGFsbFRhcmdldCgpLCAnbm9kZV9tb2R1bGVzJywgJ0BobWhhcm5lc3MnLCAnY2xpJykpLCBzb3VyY2U6ICd3aXphcmQtaW5zdGFsbCcgfTtcclxuICAgIH1cclxuXHJcbiAgICAvLyBcdTZFOTBcdTc4MDEgcmVwbyBcdTVFMDNcdTVDNDAod2hlcmUgPiBucG0gXHU1MTY4XHU1QzQwID4gXHU1RTM4XHU4OUMxXHU2RTkwXHU3ODAxXHU0RjREXHU3RjZFO1x1NTQ3RFx1NEUyRFx1OTg3Qlx1NjcwOVx1NTE2NVx1NTNFM1x1NEUwRVx1NEY5RFx1OEQ1NilcclxuICAgIGNvbnN0IHJlcG9zID0gbmV3IFNldDxzdHJpbmc+KFsuLi53aGVyZVJlcG9zLCAuLi5ucG1SZXBvc10pO1xyXG4gICAgY29uc3QgYmFzZXMgPSBbJ0M6XFxcXCcsICdEOlxcXFwnLCAnRTpcXFxcJywgJ0Y6XFxcXCcsICdHOlxcXFwnLCAnSDpcXFxcJywgaG9tZWRpcigpLCBqb2luKGhvbWVkaXIoKSwgJ0RldmVsb3BlcicpXTtcclxuICAgIGZvciAoY29uc3QgYmFzZSBvZiBiYXNlcykge1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHAgPSByZXNvbHZlKGJhc2UsICdobWhhcm5lc3MnKTtcclxuICAgICAgICBpZiAoZXhpc3RzU3luYyhwKSkgcmVwb3MuYWRkKHApO1xyXG4gICAgICB9IGNhdGNoIHsgLyogXHU3NkQ4XHU0RTBEXHU1QjU4XHU1NzI4ICovIH1cclxuICAgIH1cclxuICAgIGZvciAoY29uc3QgcmVwbyBvZiByZXBvcykge1xyXG4gICAgICBjb25zdCBlbnRyeSA9IGpvaW4ocmVwbywgJ3BhY2thZ2VzJywgJ3dlYicsICdzcmMnLCAnZGVza3RvcC1ob3N0LnRzJyk7XHJcbiAgICAgIGlmIChleGlzdHNTeW5jKGVudHJ5KSAmJiBleGlzdHNTeW5jKGpvaW4ocmVwbywgJ25vZGVfbW9kdWxlcycpKSkge1xyXG4gICAgICAgIHJldHVybiB7IGVudHJ5LCB2ZXJzaW9uOiBwa2dWZXJzaW9uQXQocmVwbyksIHNvdXJjZTogJ3NvdXJjZS1yZXBvJyB9O1xyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4geyBlbnRyeTogJycsIHZlcnNpb246ICcnLCBzb3VyY2U6ICcnIH07XHJcbiAgfVxyXG5cclxuICBmdW5jdGlvbiBkZXRlY3RSZWFsRW50cnkoKTogc3RyaW5nIHtcclxuICAgIHJldHVybiBkZXRlY3RFeHRlcm5hbFJ1bnRpbWUoKS5lbnRyeTtcclxuICB9XHJcblxyXG4gIC8qKiBcdTg5RTNcdTY3OTAgcnVudGltZSBcdTUxNjVcdTUzRTNcdTYyNDBcdTVDNUVcdTc2ODQgaG1oYXJuZXNzIFx1NEVEM1x1NUU5M1x1NjgzOShwYWNrYWdlcy93ZWIvc3JjfGRpc3QgXHU0RTBBXHU2RUFGKVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIHJlcG9Sb290T2YoZW50cnk6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICBsZXQgZGlyID0gZGlybmFtZShlbnRyeSk7XHJcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IDY7IGkrKykge1xyXG4gICAgICBpZiAoZXhpc3RzU3luYyhqb2luKGRpciwgJ3BhY2thZ2UuanNvbicpKSAmJiBleGlzdHNTeW5jKGpvaW4oZGlyLCAncGFja2FnZXMnLCAnd2ViJykpKSByZXR1cm4gZGlyO1xyXG4gICAgICBjb25zdCBwYXJlbnQgPSBkaXJuYW1lKGRpcik7XHJcbiAgICAgIGlmIChwYXJlbnQgPT09IGRpcikgYnJlYWs7XHJcbiAgICAgIGRpciA9IHBhcmVudDtcclxuICAgIH1cclxuICAgIHJldHVybiBkaXJuYW1lKGVudHJ5KTtcclxuICB9XHJcblxyXG4gIGxldCBydW50aW1lRW50cnkgPSAnJzsgLy8gXHU1RjUzXHU1MjREXHU1QjlFXHU5NjQ1XHU0RjdGXHU3NTI4XHU3Njg0XHU3NzFGXHU1QjlFIHJ1bnRpbWUgXHU1MTY1XHU1M0UzKCcnPVx1NjcyQVx1NjNBNSlcclxuICBsZXQgdXNlQnVuZGxlZFJ1bnRpbWUgPSBmYWxzZTsgLy8gdjU6XHU2NjJGXHU1NDI2XHU1NzI4XHU3NTI4XHU1MTg1XHU3RjZFIHJ1bnRpbWUoXHU1MTczXHU0RThFL1x1OTc2Mlx1Njc3Rlx1NjgwN1x1NkNFOClcclxuXHJcbiAgLyoqIFx1NTE4NVx1N0Y2RSBydW50aW1lKHY1IFx1NUYwMFx1N0JCMVx1NTM3M1x1NzUyOCk6XHU2MjUzXHU1MzA1XHU1NDBFXHU5NjhGIGV4dHJhUmVzb3VyY2VzIFx1NUU3M1x1OTRGQVx1NTcyOCByZXNvdXJjZXMvO1xyXG4gICAgIGRldiBcdTc1MjhcdTRFRDNcdTVFOTNcdTUxODVcdTY3ODRcdTVFRkFcdTRFQTdcdTcyNjkoc2NyaXB0cy9idW5kbGUtcnVudGltZS5tanMpXHUzMDAyXHU4MUVBXHU1MzA1XHU1NDJCXHU1MzU1XHU2NTg3XHU0RUY2LFx1NjVFMCB0c3hcdTMwMDFcclxuICAgICBcdTY1RTAgcmVwbyBub2RlX21vZHVsZXMgXHU0RjlEXHU4RDU2XHUzMDAyICovXHJcbiAgZnVuY3Rpb24gYnVuZGxlZFJ1bnRpbWVQYXRoKHJlcG9Sb290OiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIGpvaW4oYXBwLmlzUGFja2FnZWQgPyBwcm9jZXNzLnJlc291cmNlc1BhdGggOiBqb2luKHJlcG9Sb290LCAnYXBwcycsICdkZXNrdG9wJywgJ3Jlc291cmNlcycpLCAncnVudGltZScsICdydW50aW1lLmNqcycpO1xyXG4gIH1cclxuXHJcbiAgLyoqIFx1NTE4NVx1N0Y2RSBydW50aW1lIFx1NTE0M1x1NEZFMVx1NjA2RihcdTU0MTFcdTVCRkNcIlx1NTE4NVx1N0Y2RVx1N0NCRVx1N0I4MFx1NTE4NVx1NjgzOFwiXHU5MDA5XHU5ODc5XHU3Njg0XHU3MjQ4XHU2NzJDXHU2ODA3XHU2Q0U4KVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIGJ1bmRsZWRSdW50aW1lSW5mbygpOiB7IHJlYWR5OiBib29sZWFuOyB2ZXJzaW9uOiBzdHJpbmcgfSB7XHJcbiAgICBjb25zdCByZXBvUm9vdCA9IGpvaW4oaGVyZSwgJy4uJywgJy4uJywgJy4uJywgJy4uJyk7XHJcbiAgICBjb25zdCBwID0gYnVuZGxlZFJ1bnRpbWVQYXRoKHJlcG9Sb290KTtcclxuICAgIGxldCB2ZXJzaW9uID0gJyc7XHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCB2ID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoam9pbihkaXJuYW1lKHApLCAncGFja2FnZS5qc29uJyksICd1dGY4JykpIGFzIHsgdmVyc2lvbj86IHVua25vd24gfTtcclxuICAgICAgdmVyc2lvbiA9IHR5cGVvZiB2LnZlcnNpb24gPT09ICdzdHJpbmcnID8gdi52ZXJzaW9uIDogJyc7XHJcbiAgICB9IGNhdGNoIHsgLyogXHU1MTQzXHU2NTcwXHU2MzZFXHU3RjNBXHU1OTMxXHU1MjE5XHU1M0VBXHU2MkE1IHJlYWR5ICovIH1cclxuICAgIHJldHVybiB7IHJlYWR5OiBleGlzdHNTeW5jKHApLCB2ZXJzaW9uIH07XHJcbiAgfVxyXG5cclxuICAvKiogbnBtIFx1NjYyRlx1NTQyNlx1NTcyOCBQQVRIKFx1NTQxMVx1NUJGQ1x1OTAwOVx1NjJFOVx1OTg3NSBcdTI0NjAgXHU3Njg0XHU1Qjg5XHU4OEM1XHU2NUI5XHU1RjBGXHU2ODA3XHU2Q0U4O3doZXJlIFx1NUZFQlx1NjNBMixcdTRFMERcdTUwNUFcdTVCOENcdTY1NzRcdTYzQTJcdTZENEIpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gbnBtT25QYXRoKCk6IGJvb2xlYW4ge1xyXG4gICAgdHJ5IHtcclxuICAgICAgZXhlY0ZpbGVTeW5jKCd3aGVyZScsIFsnbnBtJ10sIHsgZW5jb2Rpbmc6ICd1dGY4JywgdGltZW91dDogNF8wMDAsIHdpbmRvd3NIaWRlOiB0cnVlIH0pO1xyXG4gICAgICByZXR1cm4gdHJ1ZTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4gZmFsc2U7IH1cclxuICB9XHJcblxyXG4gIC8qIC0tLS0gXHU5OTk2XHU1NDJGXHU1Qjg5XHU4OEM1XHU1NDExXHU1QkZDXHU3MkI2XHU2MDAxKHY1LjEpIC0tLS0gKi9cclxuICBjb25zdCB3aXphcmRGaWxlID0gKCk6IHN0cmluZyA9PiBqb2luKGFwcC5nZXRQYXRoKCd1c2VyRGF0YScpLCAnd2l6YXJkLmpzb24nKTtcclxuICBhc3luYyBmdW5jdGlvbiBsb2FkV2l6YXJkU3RhdGUoKTogUHJvbWlzZTx7IGRvbmU6IGJvb2xlYW47IGNob2ljZTogc3RyaW5nIH0+IHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHYgPSBKU09OLnBhcnNlKGF3YWl0IHJlYWRGaWxlKHdpemFyZEZpbGUoKSwgJ3V0ZjgnKSkgYXMgeyBkb25lPzogdW5rbm93bjsgY2hvaWNlPzogdW5rbm93biB9O1xyXG4gICAgICByZXR1cm4geyBkb25lOiB2LmRvbmUgPT09IHRydWUsIGNob2ljZTogdHlwZW9mIHYuY2hvaWNlID09PSAnc3RyaW5nJyA/IHYuY2hvaWNlIDogJycgfTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4geyBkb25lOiBmYWxzZSwgY2hvaWNlOiAnJyB9OyB9XHJcbiAgfVxyXG4gIGFzeW5jIGZ1bmN0aW9uIHNhdmVXaXphcmRTdGF0ZShjaG9pY2U6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgYXdhaXQgd3JpdGVGaWxlKHdpemFyZEZpbGUoKSwgSlNPTi5zdHJpbmdpZnkoeyBkb25lOiB0cnVlLCBjaG9pY2UgfSwgbnVsbCwgMiksICd1dGY4JykuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcclxuICB9XHJcbiAgLyoqIFx1NTQxMVx1NUJGQ1x1ODFFQVx1NTJBOFx1NUYzOVx1NTFGQVx1NjI5MVx1NTIzNjpcdTZENEJcdThCRDUvXHU1RjAwXHU1M0QxXHU3M0FGXHU1ODgzXHU0RTBEXHU1RjM5KFVJVkVSSUZZL1NOQVBTSE9UL1JFTkRFUl9URVNUL1xyXG4gICAqICBET01QUk9CRS9TRUNVUklUWV9URVNUL0ZBS0UvZGV2KTtITUhfREVTS1RPUF9XSVpBUkRfRk9SQ0U9MSBcdTVGM0FcdTUyMzZcdTVGMzkoXHU5QThDXHU2NTM2KVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIHdpemFyZFN1cHByZXNzZWQoKTogYm9vbGVhbiB7XHJcbiAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfV0laQVJEX0ZPUkNFID09PSAnMScpIHJldHVybiBmYWxzZTtcclxuICAgIHJldHVybiBpc0RldlxyXG4gICAgICB8fCBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWSA9PT0gJzEnXHJcbiAgICAgIHx8IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NOQVBTSE9UICE9PSB1bmRlZmluZWRcclxuICAgICAgfHwgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVklTUkVHID09PSAnMSdcclxuICAgICAgfHwgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfUkVOREVSX1RFU1QgPT09ICcxJ1xyXG4gICAgICB8fCBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9ET01QUk9CRSA9PT0gJzEnXHJcbiAgICAgIHx8IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NFQ1VSSVRZX1RFU1QgPT09ICcxJ1xyXG4gICAgICB8fCBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9GQUtFID09PSAnMSc7XHJcbiAgfVxyXG5cclxuICAvKiogXHU1M0QxXHU3M0IwXHU5ODdBXHU1RThGOlx1NjYzRVx1NUYwRlx1ODk4Nlx1NzZENihcdTU0MkJcdTU0MTFcdTVCRkNcdTkwMDlcdTYyRTk6XHU1OTE2XHU5MEU4XHU1MTY1XHU1M0UzL1x1NTE4NVx1N0Y2RVx1OERFRlx1NUY4NC9cdTZGMTRcdTc5M0EpPiBcdTUxODVcdTdGNkVcdTVGMDBcdTUxNzNcclxuICAgICAoSE1IX0RFU0tUT1BfQlVORExFRD0xKT4gXHU1OTE2XHU5MEU4XHU1M0QxXHU3M0IwKGRldiBcdTc2RjhcdTkwQkJcdTRFRDNcdTVFOTMgLyB3aGVyZSBobWggLyBucG0gXHU1MTY4XHU1QzQwIC9cclxuICAgICBcdTU0MTFcdTVCRkNcdTVCODlcdTg4QzVcdTc2RUVcdTVGNTUgLyBcdTZFOTBcdTc4MDFcdTRGNERcdTdGNkUpPiBcdTUxODVcdTdGNkVcdTUxNUNcdTVFOTVcdTMwMDJcdTU5MTZcdTkwRThcdTRGMThcdTUxNDg9XHU4MDAxXHU3NTI4XHU2MjM3XHU3RUU3XHU3RUVEXHU3NTI4XHU4MUVBXHU1REYxXHU4OEM1XHU3Njg0XHU3MjQ4XHU2NzJDO1xyXG4gICAgIFx1NTE4NVx1N0Y2RT1cdTY1QjBcdTY3M0FcdTU2NjhcdTg4QzVcdTVCOENcdTc2RjRcdThGREVcdTc3MUZcdTVCOUVcdTUxODVcdTY4MzhcdTMwMDJITUhfREVTS1RPUF9GQUtFPTEgXHU2MjE2IHJ1bnRpbWUuanNvbiBkZW1vPXRydWVcclxuICAgICAoXHU1NDExXHU1QkZDXCJcdTZGMTRcdTc5M0FcdTZBMjFcdTVGMEZcIlx1OTAwOVx1NjJFOSxcdTYzMDFcdTRFNDUpXHU4RkRCXHU2RjE0XHU3OTNBXHUzMDAyICovXHJcbiAgYXN5bmMgZnVuY3Rpb24gc3RhcnRIb3N0KCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3QgcmVwb1Jvb3QgPSBqb2luKGhlcmUsICcuLicsICcuLicsICcuLicsICcuLicpOyAvLyBhcHBzL2Rlc2t0b3AvZGlzdC1lbGVjdHJvbi9tYWluIFx1MjE5MiByZXBvIHJvb3RcclxuICAgIGNvbnN0IHBhY2thZ2VkID0gYXBwLmlzUGFja2FnZWQ7XHJcbiAgICBjb25zdCBjZmcgPSBhd2FpdCBsb2FkUnVudGltZUNvbmZpZygpO1xyXG4gICAgY29uc3QgZm9yY2VGYWtlID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfRkFLRSA9PT0gJzEnIHx8IGNmZy5kZW1vO1xyXG4gICAgY29uc3QgZm9yY2VCdW5kbGVkID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfQlVORExFRCA9PT0gJzEnO1xyXG4gICAgY29uc3Qgb3ZlcnJpZGUgPSBjZmcuZW50cnk7XHJcbiAgICBjb25zdCBhZGphY2VudCA9IGpvaW4ocmVwb1Jvb3QsICcuLicsICdobWhhcm5lc3MnLCAncGFja2FnZXMnLCAnd2ViJywgJ3NyYycsICdkZXNrdG9wLWhvc3QudHMnKTtcclxuICAgIGNvbnN0IGJ1bmRsZWQgPSBidW5kbGVkUnVudGltZVBhdGgocmVwb1Jvb3QpO1xyXG4gICAgY29uc3QgYnVuZGxlZFJlYWR5ID0gZXhpc3RzU3luYyhidW5kbGVkKTtcclxuICAgIC8vIFx1ODlFM1x1Njc5MChcdTdFRDNcdTY3OUNcdTVGNTJcdTRFMDA6b3ZlcnJpZGU9YnVuZGxlZCBcdThERUZcdTVGODRcdTIxOTJcdTUxODVcdTdGNkU7XHU2RTkwXHU3ODAxIC50cyBcdTk3MDAgdHN4O1xyXG4gICAgLy8gbnBtIFx1NUI4OVx1ODhDNSAuanMgXHU3RjE2XHU4QkQxXHU0RUE3XHU3MjY5XHU3NkY0XHU4REQxO2J1bmRsZWQ9XHU4MUVBXHU1MzA1XHU1NDJCIGNqcyBcdTc2RjRcdThERDEpXHJcbiAgICBsZXQgZW50cnkgPSAnJztcclxuICAgIHVzZUJ1bmRsZWRSdW50aW1lID0gZmFsc2U7XHJcbiAgICBpZiAoZm9yY2VGYWtlKSB7XHJcbiAgICAgIC8vIFx1NkYxNFx1NzkzQVx1NkEyMVx1NUYwRlxyXG4gICAgfSBlbHNlIGlmIChvdmVycmlkZSAhPT0gJycpIHtcclxuICAgICAgZW50cnkgPSBvdmVycmlkZTtcclxuICAgICAgaWYgKG92ZXJyaWRlID09PSBidW5kbGVkKSB1c2VCdW5kbGVkUnVudGltZSA9IHRydWU7IC8vIFx1NTQxMVx1NUJGQ1x1OTAwOVwiXHU1MTg1XHU3RjZFXHU3Q0JFXHU3QjgwXHU1MTg1XHU2ODM4XCJcdTc2ODRcdTYzMDFcdTRFNDVcdTVGNjJcdTYwMDFcclxuICAgIH0gZWxzZSBpZiAoZm9yY2VCdW5kbGVkKSB7XHJcbiAgICAgIGlmIChidW5kbGVkUmVhZHkpIHsgZW50cnkgPSBidW5kbGVkOyB1c2VCdW5kbGVkUnVudGltZSA9IHRydWU7IH1cclxuICAgICAgZWxzZSBsb2dJbmZvKCdob3N0JywgJ0hNSF9ERVNLVE9QX0JVTkRMRUQ9MSBcdTRGNDZcdTUxODVcdTdGNkUgcnVudGltZSBcdTdGM0FcdTU5MzEoXHU1MTQ4XHU4REQxIHNjcmlwdHMvYnVuZGxlLXJ1bnRpbWUubWpzKScpO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgZW50cnkgPSBwYWNrYWdlZCA/IGRldGVjdFJlYWxFbnRyeSgpIDogKGV4aXN0c1N5bmMoYWRqYWNlbnQpID8gYWRqYWNlbnQgOiBkZXRlY3RSZWFsRW50cnkoKSk7XHJcbiAgICAgIGlmIChlbnRyeSA9PT0gJycgJiYgYnVuZGxlZFJlYWR5KSB7IGVudHJ5ID0gYnVuZGxlZDsgdXNlQnVuZGxlZFJ1bnRpbWUgPSB0cnVlOyB9XHJcbiAgICB9XHJcbiAgICBydW50aW1lRW50cnkgPSBlbnRyeTtcclxuICAgIGNvbnN0IHVzZVJlYWwgPSBlbnRyeSAhPT0gJycgJiYgKHVzZUJ1bmRsZWRSdW50aW1lIHx8IGV4aXN0c1N5bmMoZW50cnkpKTtcclxuICAgIGJyaWRnZSA9IHtcclxuICAgICAgLi4uYnJpZGdlLFxyXG4gICAgICBtb2RlOiB1c2VSZWFsID8gJ3JlYWwnIDogJ2Zha2UnLFxyXG4gICAgICBydW50aW1lRW50cnk6IHVzZVJlYWwgPyAodXNlQnVuZGxlZFJ1bnRpbWUgPyBgJHtlbnRyeX0gKGJ1bmRsZWQpYCA6IGVudHJ5KSA6IG51bGwsXHJcbiAgICB9O1xyXG4gICAgbGV0IHNwZWM6IHsgY29tbWFuZDogc3RyaW5nOyBhcmdzOiBzdHJpbmdbXTsgZW52OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+OyBjd2Q/OiBzdHJpbmcgfTtcclxuICAgIGlmICh1c2VCdW5kbGVkUnVudGltZSkge1xyXG4gICAgICBzcGVjID0ge1xyXG4gICAgICAgIGNvbW1hbmQ6IHByb2Nlc3MuZXhlY1BhdGgsXHJcbiAgICAgICAgYXJnczogW2VudHJ5XSwgLy8gXHU4MUVBXHU1MzA1XHU1NDJCXHU1MzU1XHU2NTg3XHU0RUY2OmVsZWN0cm9uLWFzLW5vZGUgXHU3NkY0XHU4REQxLFx1NjVFMCB0c3ggXHU2NUUwIHJlcG9cclxuICAgICAgICBlbnY6IHsgRUxFQ1RST05fUlVOX0FTX05PREU6ICcxJyB9LFxyXG4gICAgICB9O1xyXG4gICAgfSBlbHNlIGlmICh1c2VSZWFsICYmIGVudHJ5LmVuZHNXaXRoKCcuanMnKSkge1xyXG4gICAgICBzcGVjID0ge1xyXG4gICAgICAgIGNvbW1hbmQ6IHByb2Nlc3MuZXhlY1BhdGgsXHJcbiAgICAgICAgYXJnczogW2VudHJ5XSwgLy8gbnBtIFx1NUI4OVx1ODhDNVx1NzY4NFx1N0YxNlx1OEJEMVx1NEVBN1x1NzI2OTpFU00gXHU0RjlEXHU4RDU2XHU2MzA5XHU2NTg3XHU0RUY2XHU0RjREXHU3RjZFXHU4OUUzXHU2NzkwLFx1NzZGNFx1OEREMVx1NTM3M1x1NTNFRlxyXG4gICAgICAgIGN3ZDogZGlybmFtZShlbnRyeSksXHJcbiAgICAgICAgZW52OiB7IEVMRUNUUk9OX1JVTl9BU19OT0RFOiAnMScgfSxcclxuICAgICAgfTtcclxuICAgIH0gZWxzZSBpZiAodXNlUmVhbCkge1xyXG4gICAgICBjb25zdCByZXBvID0gcmVwb1Jvb3RPZihlbnRyeSk7XHJcbiAgICAgIHNwZWMgPSB7XHJcbiAgICAgICAgY29tbWFuZDogcHJvY2Vzcy5leGVjUGF0aCxcclxuICAgICAgICBhcmdzOiBbJy0taW1wb3J0JywgJ3RzeCcsIGVudHJ5XSxcclxuICAgICAgICBjd2Q6IHJlcG8sIC8vIGJhcmUgJ3RzeCcgXHU0RTBFIHdvcmtzcGFjZSBcdTRGOURcdThENTZcdTkwRkRcdTRFQ0UgcmVwbyBcdTc2ODQgbm9kZV9tb2R1bGVzIFx1ODlFM1x1Njc5MFxyXG4gICAgICAgIGVudjogeyBFTEVDVFJPTl9SVU5fQVNfTk9ERTogJzEnIH0sXHJcbiAgICAgIH07XHJcbiAgICB9IGVsc2UgaWYgKHBhY2thZ2VkKSB7XHJcbiAgICAgIHNwZWMgPSB7XHJcbiAgICAgICAgY29tbWFuZDogcHJvY2Vzcy5leGVjUGF0aCxcclxuICAgICAgICBhcmdzOiBbam9pbihwcm9jZXNzLnJlc291cmNlc1BhdGgsICdmYWtlLWhvc3QuY2pzJyldLFxyXG4gICAgICAgIGVudjogeyBFTEVDVFJPTl9SVU5fQVNfTk9ERTogJzEnIH0sXHJcbiAgICAgIH07XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICBzcGVjID0ge1xyXG4gICAgICAgIGNvbW1hbmQ6IHByb2Nlc3MuZXhlY1BhdGgsXHJcbiAgICAgICAgLy8gXHU3NkY0XHU2M0E1XHU4RDcwXHU1MzA1XHU3NzFGXHU1QjlFXHU4REVGXHU1Rjg0KG5vZGVfbW9kdWxlcyBcdTkxQ0NcdTc2ODQgd29ya3NwYWNlIGp1bmN0aW9uIFx1NEYxQVx1ODhBQiBFU01cclxuICAgICAgICAvLyByZWFscGF0aCBcdTUzMTYsXHU1QkZDXHU4MUY0IGZha2UtaG9zdCBcdTc2ODQgYXJndlsxXS9pbXBvcnQubWV0YS51cmwgXHU1MzM5XHU5MTREXHU1OTMxXHU2NTQ4KVxyXG4gICAgICAgIGFyZ3M6IFsnLS1pbXBvcnQnLCAndHN4Jywgam9pbihyZXBvUm9vdCwgJ3BhY2thZ2VzJywgJ2hvc3QtYWRhcHRlcicsICdzcmMnLCAnZmFrZS1ob3N0LnRzJyldLFxyXG4gICAgICAgIGVudjogeyBFTEVDVFJPTl9SVU5fQVNfTk9ERTogJzEnIH0sXHJcbiAgICAgIH07XHJcbiAgICB9XHJcbiAgICBzdXBlcnZpc29yID0gbmV3IERlc2t0b3BSdW50aW1lU3VwZXJ2aXNvcihzcGVjLCB7XHJcbiAgICAgIG9uU3RhdGVDaGFuZ2U6IGJyb2FkY2FzdEhvc3RTdGF0ZSxcclxuICAgICAgLy8gXHU5OTk2XHU2QjIxXHU1NDJGXHU1MkE4XHU0RTBFIGNyYXNoIFx1ODFFQVx1NjEwOFx1NTQwRVx1NzY4NFx1OTFDRFx1NTQyRlx1OTBGRFx1NEYxQVx1OEQ3MFx1OEZEOVx1OTFDQzpcdTdBRUZcdTUzRTMvdG9rZW4gXHU5MEZEXHU2NjJGXHU2NUIwXHU3Njg0LFxyXG4gICAgICAvLyBcdTkxQ0RcdTVFRkFcdTY4NjVcdTVCQTJcdTYyMzdcdTdBRUZcdTVFNzZcdTkxQ0RcdTY1QjBcdThCQTJcdTk2MDUgU1NFKHJlbmRlcmVyIFx1NzY4NCBFdmVudFN0b3JlIFx1OTc2MCBldmVudElkIFx1NTNCQlx1OTFDRClcclxuICAgICAgb25SZWFkeTogKGVwKSA9PiB7XHJcbiAgICAgICAgY2xpZW50ID0gbmV3IERlc2t0b3BIb3N0Q2xpZW50KGBodHRwOi8vMTI3LjAuMC4xOiR7ZXAucG9ydH1gLCBlcC50b2tlbik7XHJcbiAgICAgICAgc3NlQWJvcnQ/LmFib3J0KCk7XHJcbiAgICAgICAgc3NlQWJvcnQgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XHJcbiAgICAgICAgbGFzdEV2ZW50SWQgPSAnJztcclxuICAgICAgICB2b2lkIHB1bXBFdmVudHMoKTtcclxuICAgICAgICBsb2dJbmZvKCdob3N0JywgYGJyaWRnZSByZWFkeSBvbiAxMjcuMC4wLjE6JHtlcC5wb3J0fSAocnVudGltZSAke2VwLnZlcnNpb259LCBtb2RlICR7YnJpZGdlLm1vZGV9JHt1c2VSZWFsID8gYCwgZW50cnk9JHtydW50aW1lRW50cnl9JHt1c2VCdW5kbGVkUnVudGltZSA/ICcgW2J1bmRsZWRdJyA6ICcnfWAgOiAnJ30pYCk7XHJcbiAgICAgIH0sXHJcbiAgICB9KTtcclxuICAgIHRyeSB7XHJcbiAgICAgIGF3YWl0IHN1cGVydmlzb3Iuc3RhcnQoKTtcclxuICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICBjb25zdCBkZXRhaWwgPSAoKCkgPT4geyB0cnkgeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkoZXJyKTsgfSBjYXRjaCB7IHJldHVybiBTdHJpbmcoZXJyKTsgfSB9KSgpLnNsaWNlKDAsIDQwMCk7XHJcbiAgICAgIGJyaWRnZSA9IHsgLi4uYnJpZGdlLCBob3N0U3RhdGU6ICdmYWlsZWQnLCBsYXN0RXJyb3I6IGRldGFpbCB9O1xyXG4gICAgICBsb2dJbmZvKCdob3N0JywgYHN0YXJ0IGZhaWxlZDogJHtkZXRhaWx9YCk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvKiAtLS0tIElQQyBcdTc2N0RcdTU0MERcdTUzNTUgKyBzZW5kZXIgXHU2ODIxXHU5QThDIC0tLS0gKi9cclxuICBjb25zdCBhbGxvd2VkT3JpZ2lucyA9IG5ldyBTZXQ8c3RyaW5nPihcclxuICAgIGlzRGV2ICYmIHJlbmRlcmVyRGV2VXJsXHJcbiAgICAgID8gW3JlbmRlcmVyRGV2VXJsXVxyXG4gICAgICA6IFtwYXRoVG9GaWxlVVJMKGpvaW4oaGVyZSwgJy4uJywgJy4uJywgJ2Rpc3QtcmVuZGVyZXInLCAnaW5kZXguaHRtbCcpKS5ocmVmXSxcclxuICApO1xyXG5cclxuICBmdW5jdGlvbiBzZW5kZXJUcnVzdGVkKHNlbmRlckZyYW1lOiBFbGVjdHJvbi5XZWJGcmFtZU1haW4gfCBudWxsIHwgdW5kZWZpbmVkKTogYm9vbGVhbiB7XHJcbiAgICBpZiAoc2VuZGVyRnJhbWUgPT09IG51bGwgfHwgc2VuZGVyRnJhbWUgPT09IHVuZGVmaW5lZCkgcmV0dXJuIGZhbHNlO1xyXG4gICAgbGV0IHRvcDogRWxlY3Ryb24uV2ViRnJhbWVNYWluIHwgbnVsbCA9IHNlbmRlckZyYW1lO1xyXG4gICAgd2hpbGUgKHRvcD8ucGFyZW50ICE9PSBudWxsICYmIHRvcD8ucGFyZW50ICE9PSB1bmRlZmluZWQpIHRvcCA9IHRvcC5wYXJlbnQ7XHJcbiAgICBjb25zdCB1cmwgPSB0b3A/LnVybCA/PyAnJztcclxuICAgIGZvciAoY29uc3Qgb3JpZ2luIG9mIGFsbG93ZWRPcmlnaW5zKSB7XHJcbiAgICAgIGlmICh1cmwgPT09IG9yaWdpbiB8fCB1cmwuc3RhcnRzV2l0aChgJHtvcmlnaW59L2ApIHx8IHVybC5zdGFydHNXaXRoKGAke29yaWdpbn0/YCkpIHJldHVybiB0cnVlO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGZhbHNlO1xyXG4gIH1cclxuXHJcbiAgLyoqIFx1OTcwMFx1ODk4MSBob3N0IFx1NUMzMVx1N0VFQVx1NzY4NCBJUEMgaGFuZGxlciBcdTUxNkNcdTUxNzFcdTU4RjM6XHU2NzJBXHU1QzMxXHU3RUVBXHU4RkQ0XHU1NkRFXHU3RUQzXHU2Nzg0XHU1MzE2XHU5NTE5XHU4QkVGXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gaG9zdENhbGw8VD4oZXZlbnQ6IEVsZWN0cm9uLklwY01haW5JbnZva2VFdmVudCwgZm46IChjOiBEZXNrdG9wSG9zdENsaWVudCkgPT4gUHJvbWlzZTxUPik6IFByb21pc2U8VCB8IHsgZXJyb3I6IHN0cmluZzsgY29kZTogc3RyaW5nIH0+IHtcclxuICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9KTtcclxuICAgIGlmIChjbGllbnQgPT09IG51bGwgfHwgYnJpZGdlLmhvc3RTdGF0ZSAhPT0gJ3JlYWR5Jykge1xyXG4gICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6IGBob3N0IG5vdCByZWFkeSAoJHticmlkZ2UuaG9zdFN0YXRlfSlgLCBjb2RlOiAnSE9TVF9OT1RfUkVBRFknIH0pO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGZuKGNsaWVudCkuY2F0Y2goKGVycjogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBkZXRhaWwgPSAoKCkgPT4geyB0cnkgeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkoZXJyKTsgfSBjYXRjaCB7IHJldHVybiBTdHJpbmcoZXJyKTsgfSB9KSgpLnNsaWNlKDAsIDMwMCk7XHJcbiAgICAgIHJldHVybiB7IGVycm9yOiBkZXRhaWwsIGNvZGU6ICdCUklER0VfRVJST1InIH07XHJcbiAgICB9KTtcclxuICB9XHJcblxyXG4gIGZ1bmN0aW9uIHJlZ2lzdGVySXBjKCk6IHZvaWQge1xyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpnZXQtc3RhdGUnLCAoZXZlbnQpID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJyB9O1xyXG4gICAgICByZXR1cm4geyAuLi5icmlkZ2UsIGRyb3BwZWRGcmFtZXMgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6c2Vzc2lvbnMnLCAoZXZlbnQpID0+XHJcbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPHsgc2Vzc2lvbnM6IEFycmF5PHsgaWQ6IHN0cmluZzsgdGl0bGU6IHN0cmluZzsgdGFzazogc3RyaW5nOyBvdXRjb21lOiBzdHJpbmc7IHR1cm5zOiBudW1iZXI7IHRvb2xVc2VzOiBudW1iZXI7IHRpbWU6IHN0cmluZzsgY3dkOiBzdHJpbmc7IGNyZWF0ZWRBdDogc3RyaW5nOyB1cGRhdGVkQXQ6IHN0cmluZyB9PiB9PignL2FwaS9zZXNzaW9ucz9saW1pdD0xMDAnKSkpO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6c2VuZC10YXNrJywgKGV2ZW50LCB0ZXh0OiB1bmtub3duLCBzZXNzaW9uSWQ6IHVua25vd24sIG1vZGU6IHVua25vd24sIGF0dGFjaG1lbnRzOiB1bmtub3duLCBpbWFnZXM6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3QgdGFzayA9IHR5cGVvZiB0ZXh0ID09PSAnc3RyaW5nJyA/IHRleHQuc2xpY2UoMCwgMjBfMDAwKSA6ICcnO1xyXG4gICAgICBjb25zdCBzaWQgPSB0eXBlb2Ygc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IHNlc3Npb25JZC5zbGljZSgwLCA4MCkgOiAnJztcclxuICAgICAgY29uc3QgbSA9IG1vZGUgPT09ICdhdXRvJyB8fCBtb2RlID09PSAneW9sbycgPyBtb2RlIDogJ2Fzayc7XHJcbiAgICAgIC8vIFx1OTY0NFx1NEVGNjpcdTU0MEVcdTdBRUZcdTYzODhcdTY3NDMgRFRPIFx1NzY4NFx1N0VERFx1NUJGOVx1OERFRlx1NUY4NChAIFx1OTAwOVx1NjJFOVx1NTY2OC9cdUQ4M0RcdURDQ0UgXHU0RTBBXHU0RjIwXHU1M0VBXHU2NzY1XHU4MUVBXHU2NzJDXHU1NzMwXHU2NTg3XHU0RUY2XHU3Q0ZCXHU3RURGKVxyXG4gICAgICBjb25zdCBhdHRzID0gQXJyYXkuaXNBcnJheShhdHRhY2htZW50cykgPyBhdHRhY2htZW50cy5maWx0ZXIoKGEpOiBhIGlzIHN0cmluZyA9PiB0eXBlb2YgYSA9PT0gJ3N0cmluZycpLnNsaWNlKDAsIDEwKSA6IFtdO1xyXG4gICAgICAvLyBcdTU2RkVcdTcyNDc6cnVudGltZSB2aXNpb24gXHU5NEZFXHU1MzRGXHU4QkFFIHtuYW1lLCBkYXRhVXJsfSBiYXNlNjQoXHUyMjY0MyBcdTVGMjAgXHUyMjY0Nk1CLHJlbmRlcmVyIFx1NzUxRlx1NjIxMClcclxuICAgICAgY29uc3QgaW1ncyA9IEFycmF5LmlzQXJyYXkoaW1hZ2VzKVxyXG4gICAgICAgID8gaW1hZ2VzXHJcbiAgICAgICAgICAgIC5maWx0ZXIoKGltKTogaW0gaXMgeyBuYW1lOiBzdHJpbmc7IGRhdGFVcmw6IHN0cmluZyB9ID0+XHJcbiAgICAgICAgICAgICAgdHlwZW9mIGltID09PSAnb2JqZWN0JyAmJiBpbSAhPT0gbnVsbCAmJiB0eXBlb2YgKGltIGFzIHsgbmFtZT86IHVua25vd24gfSkubmFtZSA9PT0gJ3N0cmluZycgJiYgdHlwZW9mIChpbSBhcyB7IGRhdGFVcmw/OiB1bmtub3duIH0pLmRhdGFVcmwgPT09ICdzdHJpbmcnKVxyXG4gICAgICAgICAgICAuc2xpY2UoMCwgMylcclxuICAgICAgICAgICAgLm1hcCgoaW0pID0+ICh7IG5hbWU6IGltLm5hbWUuc2xpY2UoMCwgMTIwKSwgZGF0YVVybDogaW0uZGF0YVVybC5zbGljZSgwLCA4XzUwMF8wMDApIH0pKVxyXG4gICAgICAgIDogW107XHJcbiAgICAgIGlmICh0YXNrID09PSAnJyB8fCBzaWQgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgb2s6IGZhbHNlLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW47IHJ1bklkPzogc3RyaW5nIH0+KCcvYXBpL3Rhc2snLCB7IHRleHQ6IHRhc2ssIHNlc3Npb25JZDogc2lkLCBtb2RlOiBtLCBhdHRhY2htZW50czogYXR0cywgaW1hZ2VzOiBpbWdzIH0pKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gXHU2QTIxXHU1NzhCXHU1MjA3XHU2MzYyKHJ1bnRpbWUgUE9TVCAvYXBpL21vZGVsOlx1NTIwNyBjaGF0IFx1OERFRlx1NzUzMSxjb25maWcgXHU1MzczXHU2NUY2XHU3NTFGXHU2NTQ4KSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOm1vZGVsLXNldCcsIChldmVudCwgbmFtZTogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBuID0gdHlwZW9mIG5hbWUgPT09ICdzdHJpbmcnID8gbmFtZS50cmltKCkuc2xpY2UoMCwgODApIDogJyc7XHJcbiAgICAgIGlmIChuID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAnbmFtZSByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbjsgbW9kZWw/OiBzdHJpbmcgfT4oJy9hcGkvbW9kZWwnLCB7IG5hbWU6IG4gfSkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBcdTVFOTRcdTc1MjhcdTUxODVcdTY2RjRcdTY1QjAoR2l0SHViIFJlbGVhc2VzO1x1ODFFQVx1NzgxNFx1OTZGNlx1NEY5RFx1OEQ1Nlx1NjZGNFx1NjVCMFx1NTY2OCkgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpjaGVjay11cGRhdGUnLCBhc3luYyAoZXZlbnQpID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgcmV0dXJuIGNoZWNrRm9yVXBkYXRlcygpO1xyXG4gICAgfSk7XHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmFwcGx5LXVwZGF0ZScsIChldmVudCkgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBpZiAoaW5zdGFsbGVyUGF0aCA9PT0gbnVsbCkgcmV0dXJuIHsgZXJyb3I6ICdubyBpbnN0YWxsZXIgZG93bmxvYWRlZCcsIGNvZGU6ICdIT1NUX05PVF9SRUFEWScgfTtcclxuICAgICAgYXBwbHlVcGRhdGUoKTtcclxuICAgICAgcmV0dXJuIHsgb2s6IHRydWUgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gXHU2ODA3XHU5ODk4XHU2ODBGXHU0RTNCXHU5ODk4XHU1NDBDXHU2QjY1KFx1NkQ0NVx1ODI3Mlx1NkEyMVx1NUYwRlx1NEUwRFx1NTE4RFx1NjcwOVx1OUVEMVx1Njc2MSkrIFx1MjYzMCBcdTRFM0JcdTgzRENcdTUzNTUgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpjaHJvbWUtdGhlbWUnLCAoZXZlbnQsIGRhcms6IHVua25vd24pID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgYXBwbHlDaHJvbWUoZGFyayA9PT0gdHJ1ZSk7XHJcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlIH07XHJcbiAgICB9KTtcclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cG9wdXAtbWFpbi1tZW51JywgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIHBvcHVwTWFpbk1lbnUoKTtcclxuICAgICAgcmV0dXJuIHsgb2s6IHRydWUgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gXHU2MjRCXHU2NzNBXHU4RkRDXHU3QTBCXHU2M0E3XHU1MjM2KDc3ODggd2ViIFx1NUI4OFx1NjJBNDtcdTc1MjhcdTYyMzdcdTY2M0VcdTVGMEZcdTU0MkZcdTUyQTgsQURSLTAwNSBcdTRFMERcdTlFRDhcdThCQTRcdTVGMDAgTEFOKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnJlbW90ZS13ZWItc3RhdHVzJywgYXN5bmMgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IHAgPSBhd2FpdCBwcm9iZVdlYlJlbW90ZSgpO1xyXG4gICAgICByZXR1cm4geyB1cDogcC51cCwgdmVyc2lvbjogcC52ZXJzaW9uLCBsYW5JcDogbGFuSXBPZigpLCBwb3J0OiBXRUJfUE9SVCwgYXZhaWxhYmxlOiBjbGlFbnRyeU9mKCkgIT09ICcnLCBhdXRvc3RhcnQ6IHdlYkF1dG9zdGFydEluc3RhbGxlZCgpIH07XHJcbiAgICB9KTtcclxuICAgIC8vIC0tLS0gXHU1RjAwXHU2NzNBXHU4MUVBXHU1NDJGKDAuMjMuMzcgd2ViIGluc3RhbGwtZGFlbW9uL3VuaW5zdGFsbC1kYWVtb247XHU3NjdCXHU1RjU1XHU1MzczXHU1Qjg4XHU2MkE0XHU1NzI4XHU3RUJGKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnJlbW90ZS13ZWItYXV0b3N0YXJ0JywgYXN5bmMgKGV2ZW50LCBlbmFibGVkOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGlmIChjbGlFbnRyeU9mKCkgPT09ICcnKSByZXR1cm4geyBlcnJvcjogJ25vIGhtaGFybmVzcyBydW50aW1lIGRldGVjdGVkJywgY29kZTogJ0hPU1RfTk9UX1JFQURZJyB9O1xyXG4gICAgICBydW5DbGkoWyd3ZWInLCBlbmFibGVkID09PSB0cnVlID8gJ2luc3RhbGwtZGFlbW9uJyA6ICd1bmluc3RhbGwtZGFlbW9uJ10pO1xyXG4gICAgICAvLyBpbnN0YWxsLWRhZW1vbiBcdTdBQ0JcdTUzNzNcdTYyQzlcdThENzdcdTVCODhcdTYyQTQ6XHU4RjZFXHU4QkUyXHU3ODZFXHU4QkE0O3VuaW5zdGFsbCBcdTUzNzNcdTY1RjZcdTc1MUZcdTY1NDhcclxuICAgICAgaWYgKGVuYWJsZWQgPT09IHRydWUpIHtcclxuICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IDUwOyBpKyspIHtcclxuICAgICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDUwMCkpO1xyXG4gICAgICAgICAgaWYgKChhd2FpdCBwcm9iZVdlYlJlbW90ZSgpKS51cCkgcmV0dXJuIHsgb2s6IHRydWUsIGF1dG9zdGFydDogd2ViQXV0b3N0YXJ0SW5zdGFsbGVkKCkgfTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHsgZXJyb3I6ICdkYWVtb24gZGlkIG5vdCBjb21lIHVwIHdpdGhpbiAyNXMnLCBjb2RlOiAnUlVOVElNRV9DUkFTSEVEJyB9O1xyXG4gICAgICB9XHJcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBhdXRvc3RhcnQ6IHdlYkF1dG9zdGFydEluc3RhbGxlZCgpIH07XHJcbiAgICB9KTtcclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cmVtb3RlLXdlYi1zdGFydCcsIGFzeW5jIChldmVudCkgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBpZiAoY2xpRW50cnlPZigpID09PSAnJykgcmV0dXJuIHsgZXJyb3I6ICdubyBobWhhcm5lc3MgcnVudGltZSBkZXRlY3RlZCcsIGNvZGU6ICdIT1NUX05PVF9SRUFEWScgfTtcclxuICAgICAgaWYgKChhd2FpdCBwcm9iZVdlYlJlbW90ZSgpKS51cCkge1xyXG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBhbHJlYWR5OiB0cnVlLCBsYW5Vcmw6IGBodHRwOi8vJHtsYW5JcE9mKCkgfHwgJzEyNy4wLjAuMSd9OiR7V0VCX1BPUlR9YCB9O1xyXG4gICAgICB9XHJcbiAgICAgIHJ1bkNsaShbJ3dlYicsICdzdGFydCcsICctLWV4cG9zdXJlPWxhbiddKTtcclxuICAgICAgLy8gXHU1Qjg4XHU2MkE0XHU4RkRCXHU3QTBCXHU1MUI3XHU1NDJGXHU1MkE4KHRzeCBcdTdGMTZcdThCRDFcdTY1NzRcdTU5NTcgQ0xJKTpcdThGNkVcdThCRTIgMjVzXHJcbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgNTA7IGkrKykge1xyXG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDUwMCkpO1xyXG4gICAgICAgIGlmICgoYXdhaXQgcHJvYmVXZWJSZW1vdGUoKSkudXApIHtcclxuICAgICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBsYW5Vcmw6IGBodHRwOi8vJHtsYW5JcE9mKCkgfHwgJzEyNy4wLjAuMSd9OiR7V0VCX1BPUlR9YCB9O1xyXG4gICAgICAgIH1cclxuICAgICAgfVxyXG4gICAgICByZXR1cm4geyBlcnJvcjogJ3dlYiBkYWVtb24gZGlkIG5vdCBjb21lIHVwIHdpdGhpbiAyNXMgKHNlZSBITUhfSE9NRS93ZWIubG9nKScsIGNvZGU6ICdSVU5USU1FX0NSQVNIRUQnIH07XHJcbiAgICB9KTtcclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cmVtb3RlLXdlYi1zdG9wJywgYXN5bmMgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIHJ1bkNsaShbJ3dlYicsICdzdG9wJ10pO1xyXG4gICAgICBmb3IgKGxldCBpID0gMDsgaSA8IDIwOyBpKyspIHtcclxuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCA0MDApKTtcclxuICAgICAgICBpZiAoIShhd2FpdCBwcm9iZVdlYlJlbW90ZSgpKS51cCkgcmV0dXJuIHsgb2s6IHRydWUgfTtcclxuICAgICAgfVxyXG4gICAgICBjb25zdCBzdGlsbCA9IChhd2FpdCBwcm9iZVdlYlJlbW90ZSgpKS51cDtcclxuICAgICAgcmV0dXJuIHN0aWxsID8geyBlcnJvcjogJ3N0aWxsIHJ1bm5pbmcnLCBjb2RlOiAnQlJJREdFX0VSUk9SJyB9IDogeyBvazogdHJ1ZSB9O1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBcdUQ4M0RcdURDQ0UgXHU2NTg3XHU0RUY2XHU0RTBBXHU0RjIwKFx1NjcyQ1x1NTczMFx1NTkxQVx1OTAwOTtydW50aW1lIFx1NjgyMVx1OUE4QyBpbnNpZGVXcyxcdTVERTVcdTRGNUNcdTUzM0FcdTU5MTZcdTY1ODdcdTRFRjZcdTRGMUFcdTg4QUIgNDAwKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnBpY2stZmlsZXMnLCBhc3luYyAoZXZlbnQsIHRpdGxlOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IHdpbiA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmZpbmQoKHcpID0+ICF3LmlzRGVzdHJveWVkKCkpO1xyXG4gICAgICBpZiAod2luID09PSB1bmRlZmluZWQpIHJldHVybiB7IGVycm9yOiAnbm8gd2luZG93JywgY29kZTogJ0JSSURHRV9FUlJPUicgfTtcclxuICAgICAgY29uc3QgciA9IGF3YWl0IGRpYWxvZy5zaG93T3BlbkRpYWxvZyh3aW4sIHtcclxuICAgICAgICB0aXRsZTogdHlwZW9mIHRpdGxlID09PSAnc3RyaW5nJyAmJiB0aXRsZSAhPT0gJycgPyB0aXRsZS5zbGljZSgwLCAxMjApIDogJ1x1OTAwOVx1NjJFOVx1ODk4MVx1OTY0NFx1NTJBMFx1NzY4NFx1NjU4N1x1NEVGNihcdTUzRUZcdTU5MUFcdTkwMDkpJyxcclxuICAgICAgICBwcm9wZXJ0aWVzOiBbJ29wZW5GaWxlJywgJ211bHRpU2VsZWN0aW9ucyddLFxyXG4gICAgICB9KTtcclxuICAgICAgaWYgKHIuY2FuY2VsZWQgfHwgci5maWxlUGF0aHMubGVuZ3RoID09PSAwKSByZXR1cm4geyBvazogZmFsc2UsIGNhbmNlbGVkOiB0cnVlIH07XHJcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBwYXRoczogci5maWxlUGF0aHMuc2xpY2UoMCwgMTApIH07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIFx1RDgzRFx1RENDMSBcdTc2RUVcdTVGNTVcdTkwMDlcdTYyRTkoXHU1REU1XHU0RjVDXHU1MzNBXHU2REZCXHU1MkEwXHU3Njg0XHU2RDRGXHU4OUM4XHU2MzA5XHU5NEFFO1x1NTM5Rlx1NzUxRiBjaG9vc2VyKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnBpY2stZGlyZWN0b3J5JywgYXN5bmMgKGV2ZW50LCB0aXRsZTogdW5rbm93bikgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBjb25zdCB3aW4gPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5maW5kKCh3KSA9PiAhdy5pc0Rlc3Ryb3llZCgpKTtcclxuICAgICAgaWYgKHdpbiA9PT0gdW5kZWZpbmVkKSByZXR1cm4geyBlcnJvcjogJ25vIHdpbmRvdycsIGNvZGU6ICdCUklER0VfRVJST1InIH07XHJcbiAgICAgIGNvbnN0IHIgPSBhd2FpdCBkaWFsb2cuc2hvd09wZW5EaWFsb2cod2luLCB7XHJcbiAgICAgICAgdGl0bGU6IHR5cGVvZiB0aXRsZSA9PT0gJ3N0cmluZycgJiYgdGl0bGUgIT09ICcnID8gdGl0bGUuc2xpY2UoMCwgMTIwKSA6ICdcdTkwMDlcdTYyRTlcdTY1ODdcdTRFRjZcdTU5MzknLFxyXG4gICAgICAgIHByb3BlcnRpZXM6IFsnb3BlbkRpcmVjdG9yeSddLFxyXG4gICAgICB9KTtcclxuICAgICAgaWYgKHIuY2FuY2VsZWQgfHwgci5maWxlUGF0aHNbMF0gPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBjYW5jZWxlZDogdHJ1ZSB9O1xyXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgcGF0aDogci5maWxlUGF0aHNbMF0gfTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gQCBcdTk2NDRcdTRFRjY6XHU1REU1XHU0RjVDXHU1MzNBXHU2NTg3XHU0RUY2XHU2NDFDXHU3RDIyKHJ1bnRpbWUgXHU2Mzg4XHU2NzQzXHU3Njg0XHU4REVGXHU1Rjg0XHU2NzY1XHU2RTkwKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmZzLXNlYXJjaCcsIChldmVudCwgcTogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBxdWVyeSA9IHR5cGVvZiBxID09PSAnc3RyaW5nJyA/IHEuc2xpY2UoMCwgMjAwKSA6ICcnO1xyXG4gICAgICBpZiAocXVlcnkgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgcmVzdWx0czogW10gfSk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjx7IHJlc3VsdHM6IEFycmF5PHsgcmVsOiBzdHJpbmc7IHBhdGg6IHN0cmluZyB9PiB9PihgL2FwaS9mcy9zZWFyY2g/cT0ke2VuY29kZVVSSUNvbXBvbmVudChxdWVyeSl9YCkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTphcHByb3ZlJywgKGV2ZW50LCBncmFudGVkOiB1bmtub3duLCBzZXNzaW9uSWQ6IHVua25vd24pID0+XHJcbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KCcvYXBpL2FwcHJvdmUnLCB7XHJcbiAgICAgICAgZ3JhbnRlZDogZ3JhbnRlZCA9PT0gdHJ1ZSxcclxuICAgICAgICBzZXNzaW9uSWQ6IHR5cGVvZiBzZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gc2Vzc2lvbklkLnNsaWNlKDAsIDgwKSA6ICcnLFxyXG4gICAgICB9KSkpO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6aW50ZXJydXB0JywgKGV2ZW50LCBzZXNzaW9uSWQ6IHVua25vd24pID0+XHJcbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KCcvYXBpL2ludGVycnVwdCcsIHtcclxuICAgICAgICBzZXNzaW9uSWQ6IHR5cGVvZiBzZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gc2Vzc2lvbklkLnNsaWNlKDAsIDgwKSA6ICcnLFxyXG4gICAgICB9KSkpO1xyXG5cclxuICAgIC8vIC0tLS0gTTQ6XHU1REU1XHU0RjVDXHU1MzNBXHU2NTg3XHU0RUY2XHU5NzYyKFx1OERFRlx1NUY4NFx1NjM4OFx1Njc0M1x1NTcyOCBydW50aW1lOmluc2lkZVdzIFx1NjgyMVx1OUE4QykgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpmcy1saXN0JywgKGV2ZW50LCBwYXRoOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IHAgPSB0eXBlb2YgcGF0aCA9PT0gJ3N0cmluZycgPyBwYXRoLnNsaWNlKDAsIDEwMDApIDogJyc7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oYC9hcGkvZnM/ZmlsZXM9MSR7cCAhPT0gJycgPyBgJnBhdGg9JHtlbmNvZGVVUklDb21wb25lbnQocCl9YCA6ICcnfWApKTtcclxuICAgIH0pO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6ZnMtcmVhZCcsIChldmVudCwgcGF0aDogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBwID0gdHlwZW9mIHBhdGggPT09ICdzdHJpbmcnID8gcGF0aC5zbGljZSgwLCAxMDAwKSA6ICcnO1xyXG4gICAgICBpZiAocCA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ3BhdGggcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KGAvYXBpL2ZzL3JlYWQ/cGF0aD0ke2VuY29kZVVSSUNvbXBvbmVudChwKX1gKSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmluamVjdCcsIChldmVudCwgdGV4dDogdW5rbm93biwgc2Vzc2lvbklkOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IHQgPSB0eXBlb2YgdGV4dCA9PT0gJ3N0cmluZycgPyB0ZXh0LnNsaWNlKDAsIDIwXzAwMCkgOiAnJztcclxuICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIHNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBzZXNzaW9uSWQuc2xpY2UoMCwgODApIDogJyc7XHJcbiAgICAgIGlmICh0ID09PSAnJyB8fCBzaWQgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgb2s6IGZhbHNlLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvaW5qZWN0JywgeyB0ZXh0OiB0LCBzZXNzaW9uSWQ6IHNpZCB9KSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIFx1NEYxQVx1OEJERFx1NUJGQ1x1NTFGQShleHBvcnQubWQgXHUyMTkyIFx1NEZERFx1NUI1OFx1NUJGOVx1OEJERFx1Njg0NjtcdTY1ODdcdTRFRjZcdTUxOTlcdTUxNjVcdTUzRUFcdTU3MjggbWFpbikgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpleHBvcnQtc2Vzc2lvbicsIGFzeW5jIChldmVudCwgaWQ6IHVua25vd24sIHRpdGxlOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IHNpZCA9IHR5cGVvZiBpZCA9PT0gJ3N0cmluZycgPyBpZC5yZXBsYWNlKC9bXmEtekEtWjAtOV86LkAtXS9nLCAnJykuc2xpY2UoMCwgODApIDogJyc7XHJcbiAgICAgIGlmIChzaWQgPT09ICcnKSByZXR1cm4geyBlcnJvcjogJ2lkIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9O1xyXG4gICAgICBpZiAoY2xpZW50ID09PSBudWxsIHx8IGJyaWRnZS5ob3N0U3RhdGUgIT09ICdyZWFkeScpIHJldHVybiB7IGVycm9yOiBgaG9zdCBub3QgcmVhZHkgKCR7YnJpZGdlLmhvc3RTdGF0ZX0pYCwgY29kZTogJ0hPU1RfTk9UX1JFQURZJyB9O1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IG1kID0gYXdhaXQgY2xpZW50LmdldFRleHQoYC9hcGkvc2Vzc2lvbnMvJHtlbmNvZGVVUklDb21wb25lbnQoc2lkKX0vZXhwb3J0Lm1kYCk7XHJcbiAgICAgICAgY29uc3Qgd2luID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkuZmluZCgodykgPT4gIXcuaXNEZXN0cm95ZWQoKSk7XHJcbiAgICAgICAgaWYgKHdpbiA9PT0gdW5kZWZpbmVkKSByZXR1cm4geyBlcnJvcjogJ25vIHdpbmRvdycsIGNvZGU6ICdCUklER0VfRVJST1InIH07XHJcbiAgICAgICAgY29uc3QgciA9IGF3YWl0IGRpYWxvZy5zaG93U2F2ZURpYWxvZyh3aW4sIHtcclxuICAgICAgICAgIHRpdGxlOiB0eXBlb2YgdGl0bGUgPT09ICdzdHJpbmcnICYmIHRpdGxlICE9PSAnJyA/IHRpdGxlLnNsaWNlKDAsIDgwKSA6ICdcdTVCRkNcdTUxRkFcdTRGMUFcdThCREQnLFxyXG4gICAgICAgICAgZGVmYXVsdFBhdGg6IGBobWgtJHtzaWR9Lm1kYCxcclxuICAgICAgICAgIGZpbHRlcnM6IFt7IG5hbWU6ICdNYXJrZG93bicsIGV4dGVuc2lvbnM6IFsnbWQnXSB9XSxcclxuICAgICAgICB9KTtcclxuICAgICAgICBpZiAoci5jYW5jZWxlZCB8fCByLmZpbGVQYXRoID09PSB1bmRlZmluZWQgfHwgci5maWxlUGF0aCA9PT0gJycpIHJldHVybiB7IG9rOiBmYWxzZSwgY2FuY2VsZWQ6IHRydWUgfTtcclxuICAgICAgICBhd2FpdCB3cml0ZUZpbGUoci5maWxlUGF0aCwgbWQsICd1dGY4Jyk7XHJcbiAgICAgICAgbG9nSW5mbygnZXhwb3J0JywgYHNlc3Npb24gJHtzaWR9IFx1MjE5MiAke3IuZmlsZVBhdGh9YCk7XHJcbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHBhdGg6IHIuZmlsZVBhdGggfTtcclxuICAgICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgY29uc3QgZGV0YWlsID0gKCgpID0+IHsgdHJ5IHsgcmV0dXJuIEpTT04uc3RyaW5naWZ5KGVycik7IH0gY2F0Y2ggeyByZXR1cm4gU3RyaW5nKGVycik7IH0gfSkoKS5zbGljZSgwLCAzMDApO1xyXG4gICAgICAgIHJldHVybiB7IGVycm9yOiBkZXRhaWwsIGNvZGU6ICdCUklER0VfRVJST1InIH07XHJcbiAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gXHU1QkExXHU2Mjc5XHU2QTIxXHU1RjBGXHU4QkZCXHU1MTk5KFx1Njc0M1x1NUEwMVx1NTcyOCBydW50aW1lIGNvbmZpZztcdTUyMDdcdTYzNjJcdTVGQzVcdTk4N0JcdTY2M0VcdTVGMEYpIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6YXBwcm92YWwtZ2V0JywgKGV2ZW50KSA9PlxyXG4gICAgICBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjx7IHNldHRpbmdzPzogeyBhcHByb3ZhbD86IHN0cmluZyB9IH0+KCcvYXBpL3N0YXRlJykpKTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmFwcHJvdmFsLXNldCcsIChldmVudCwgbW9kZTogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBtID0gbW9kZSA9PT0gJ2F1dG8nID8gJ2F1dG8nIDogbW9kZSA9PT0gJ2FzaycgPyAnYXNrJyA6ICcnO1xyXG4gICAgICBpZiAobSA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ21vZGUgbXVzdCBiZSBhc2t8YXV0bycsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PignL2FwaS9jb25maWcnLCB7IGFwcHJvdmFsOiBtIH0pKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gaG1oYXJuZXNzIHJ1bnRpbWUgXHU4RkRFXHU2M0E1KFx1ODFFQVx1NTJBOFx1NTNEMVx1NzNCMCArIFx1NjI0Qlx1NTJBOFx1ODk4Nlx1NzZENiArIFx1NzBFRFx1NTIwN1x1NjM2MikgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpydW50aW1lLWluZm8nLCBhc3luYyAoZXZlbnQpID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgY29uc3QgZCA9IGRldGVjdEV4dGVybmFsUnVudGltZSgpO1xyXG4gICAgICBjb25zdCBjZmcgPSBhd2FpdCBsb2FkUnVudGltZUNvbmZpZygpO1xyXG4gICAgICByZXR1cm4ge1xyXG4gICAgICAgIG1vZGU6IGJyaWRnZS5tb2RlLFxyXG4gICAgICAgIHJ1bnRpbWVFbnRyeTogYnJpZGdlLnJ1bnRpbWVFbnRyeSxcclxuICAgICAgICBvdmVycmlkZTogY2ZnLmVudHJ5LFxyXG4gICAgICAgIGRlbW86IGNmZy5kZW1vLFxyXG4gICAgICAgIGRldGVjdGVkOiBkLmVudHJ5LFxyXG4gICAgICAgIGRldGVjdGVkVmVyc2lvbjogZC52ZXJzaW9uLFxyXG4gICAgICAgIGRldGVjdGVkU291cmNlOiBkLnNvdXJjZSxcclxuICAgICAgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6YnJvd3NlLXJ1bnRpbWUnLCBhc3luYyAoZXZlbnQsIHRpdGxlOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IHdpbiA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmZpbmQoKHcpID0+ICF3LmlzRGVzdHJveWVkKCkpO1xyXG4gICAgICBpZiAod2luID09PSB1bmRlZmluZWQpIHJldHVybiB7IGVycm9yOiAnbm8gd2luZG93JywgY29kZTogJ0JSSURHRV9FUlJPUicgfTtcclxuICAgICAgY29uc3QgciA9IGF3YWl0IGRpYWxvZy5zaG93T3BlbkRpYWxvZyh3aW4sIHtcclxuICAgICAgICB0aXRsZTogdHlwZW9mIHRpdGxlID09PSAnc3RyaW5nJyAmJiB0aXRsZSAhPT0gJycgPyB0aXRsZS5zbGljZSgwLCAxMjApIDogJ1x1OTAwOVx1NjJFOSBobWhhcm5lc3MgXHU3Njg0IGRlc2t0b3AtaG9zdCBcdTUxNjVcdTUzRTMnLFxyXG4gICAgICAgIHByb3BlcnRpZXM6IFsnb3BlbkZpbGUnXSxcclxuICAgICAgICBmaWx0ZXJzOiBbeyBuYW1lOiAnZGVza3RvcC1ob3N0JywgZXh0ZW5zaW9uczogWyd0cycsICdqcyddIH1dLFxyXG4gICAgICB9KTtcclxuICAgICAgaWYgKHIuY2FuY2VsZWQgfHwgci5maWxlUGF0aHNbMF0gPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBjYW5jZWxlZDogdHJ1ZSB9O1xyXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgZW50cnk6IHIuZmlsZVBhdGhzWzBdIH07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiogXHU4QkJFXHU3RjZFL1x1NkUwNVx1OTY2NFx1NjI0Qlx1NTJBOFx1NTE2NVx1NTNFM1x1NTQwRVx1NzBFRFx1OTFDRFx1NTQyRiBob3N0KFx1N0E3QVx1NEUzMj1cdTU2REVcdTUyMzBcdTgxRUFcdTUyQThcdTUzRDFcdTczQjApXHUzMDAyICovXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnNldC1ydW50aW1lJywgYXN5bmMgKGV2ZW50LCBlbnRyeTogdW5rbm93bikgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBjb25zdCBlID0gdHlwZW9mIGVudHJ5ID09PSAnc3RyaW5nJyA/IGVudHJ5LnRyaW0oKSA6ICcnO1xyXG4gICAgICBpZiAoZSAhPT0gJycgJiYgKCFpc0Fic29sdXRlKGUpIHx8ICFleGlzdHNTeW5jKGUpKSkge1xyXG4gICAgICAgIHJldHVybiB7IGVycm9yOiAnXHU1MTY1XHU1M0UzXHU1RkM1XHU5ODdCXHU2NjJGXHU1QjU4XHU1NzI4XHU3Njg0XHU3RUREXHU1QkY5XHU4REVGXHU1Rjg0KGRlc2t0b3AtaG9zdC50cyknLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH07XHJcbiAgICAgIH1cclxuICAgICAgYXdhaXQgc2F2ZVJ1bnRpbWVFbnRyeU92ZXJyaWRlKGUpO1xyXG4gICAgICAvLyBcdTcwRURcdTUyMDdcdTYzNjI6XHU1MTQ4XHU0RjE4XHU5NkM1XHU1MDVDXHU2Mzg5XHU1RjUzXHU1MjREIGhvc3QsXHU1MThEXHU2MzA5XHU2NUIwXHU5MTREXHU3RjZFXHU2MkM5XHU4RDc3XHJcbiAgICAgIHNzZUFib3J0Py5hYm9ydCgpO1xyXG4gICAgICBpZiAoc3VwZXJ2aXNvciAhPT0gbnVsbCkgYXdhaXQgc3VwZXJ2aXNvci5zdG9wKCk7XHJcbiAgICAgIGF3YWl0IHN0YXJ0SG9zdCgpO1xyXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgbW9kZTogYnJpZGdlLm1vZGUgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gdjUuMSBcdTk5OTZcdTU0MkZcdTVCODlcdTg4QzVcdTU0MTFcdTVCRkM6XHU2NzJDXHU2NzNBXHU2OEMwXHU2RDRCIC8gXHU0RTBCXHU4RjdEXHU1Qjg5XHU4OEM1KFx1OEZEQlx1NUVBNlx1NEU4Qlx1NEVGNikgLyBcdTU0MTFcdTVCRkNcdTcyQjZcdTYwMDEgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpkZXRlY3QtcnVudGltZScsIChldmVudCkgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBjb25zdCBpbmZvID0gYnVuZGxlZFJ1bnRpbWVJbmZvKCk7XHJcbiAgICAgIC8vIFVJVkVSSUZZIFx1NTQxMVx1NUJGQ1x1NkI2NVx1NzY4NFwiXHU0RjJBXHU5MDIwXHU2NzJBXHU5MTREXHU3RjZFXHU2MDAxXCI6ZmFrZSBcdTZBMjFcdTVGMEZcdTRFMEJcdTYwNTJcdTYyQTVcdTY3MkFcdTY4QzBcdTZENEJcclxuICAgICAgLy8gKFx1NzcxRlx1NUI5RVx1NjhDMFx1NkQ0Qlx1OERFRlx1NUY4NFx1NzUzMSByZWFsIFx1NTNEOFx1NEY1M1x1OUE4Q1x1NjUzNixcdTg5QzEgZXZpZGVuY2Uvc2V0dXAtd2l6YXJkLylcdTMwMDJcclxuICAgICAgLy8gVUlWRVJJRllfRkFLRV9ERVRFQ1RfRk9VTkQ9MSh1aXZlcmlmeSBcdTdBODRcdTVDNEZcdTU3M0FcdTY2NkZcdThGRDBcdTg4NENcdTRFMkRcdTUyQThcdTYwMDFcdTdGNkVcdTRGNEQpOlxyXG4gICAgICAvLyBcdTRGMkFcdTkwMjBcIlx1NjhDMFx1NkQ0Qlx1NTIzMFx1NURGMlx1ODhDNVwiLFx1OEJBOVx1NTQxMVx1NUJGQ1x1NTFGQVx1NzNCMFx1NjhDMFx1NkQ0Qlx1OTg3NVx1NEUwOVx1OTAwOVx1OTg3OSBcdTIxOTIgXHU1MzU1XHU1MUZCXHU1MjREXHU4RkRCIFx1MjE5MiBcdTkwMDlcdTYyRTlcdTk4NzVcdTMwMDJcclxuICAgICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX1dJWkFSRCA9PT0gJ2Zha2UnICYmIHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX0ZBS0UgPT09ICcxJykge1xyXG4gICAgICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9GQUtFX0RFVEVDVF9GT1VORCA9PT0gJzEnKSB7XHJcbiAgICAgICAgICByZXR1cm4geyBmb3VuZDogdHJ1ZSwgdmVyc2lvbjogJzAuMC4wLXZlcmlmeScsIGVudHJ5OiAndmVyaWZ5Oi8vZmFrZS1lbnRyeScsIHNvdXJjZTogJ3ZlcmlmeScsIGJ1bmRsZWQ6IGluZm8sIG5wbTogbnBtT25QYXRoKCkgfTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHsgZm91bmQ6IGZhbHNlLCB2ZXJzaW9uOiAnJywgZW50cnk6ICcnLCBzb3VyY2U6ICcnLCBidW5kbGVkOiBpbmZvLCBucG06IG5wbU9uUGF0aCgpIH07XHJcbiAgICAgIH1cclxuICAgICAgY29uc3QgZCA9IGRldGVjdEV4dGVybmFsUnVudGltZSgpO1xyXG4gICAgICByZXR1cm4geyBmb3VuZDogZC5lbnRyeSAhPT0gJycsIHZlcnNpb246IGQudmVyc2lvbiwgZW50cnk6IGQuZW50cnksIHNvdXJjZTogZC5zb3VyY2UsIGJ1bmRsZWQ6IGluZm8sIG5wbTogbnBtT25QYXRoKCkgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6aW5zdGFsbC1jbGknLCAoZXZlbnQsIG9wdHM6IHVua25vd24pID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgY29uc3QgbyA9IChvcHRzID8/IHt9KSBhcyB7IGZvcmNlVGd6PzogdW5rbm93bjsgbWlycm9yRmlyc3Q/OiB1bmtub3duIH07XHJcbiAgICAgIC8vIFVJVkVSSUZZIGZha2UgXHU1NDExXHU1QkZDOlx1ODFFQVx1NTJBOFx1NUI4OVx1ODhDNVx1OERFRlx1NUY4NFx1OEQ3MFx1NkEyMVx1NjJERlx1OEZEQlx1NUVBNihcdTRFMERcdTc4QjBcdTc4QzFcdTc2RDgvXHU3RjUxXHU3RURDL1x1NEUwRFx1NzBFRFx1NTIwN1x1NjM2MiksXHJcbiAgICAgIC8vIFx1NEUxNFx1NEUwRFx1NTNEMSBkb25lXHUyMDE0XHUyMDE0XHU5QThDXHU2NTM2XHU4OTgxXHU1NzI4XHU1Qjg5XHU4OEM1XHU5ODc1XHU3MEI5XCJcdTY1MzlcdTc1MjhcdTUxODVcdTdGNkVcIlx1NTIwN1x1NjM2Mlx1OTRGRVx1NjNBNVx1MzAwMlxyXG4gICAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfV0laQVJEID09PSAnZmFrZScgJiYgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfRkFLRSA9PT0gJzEnKSB7XHJcbiAgICAgICAgY29uc3Qgc2VuZFNpbSA9IChwOiBJbnN0YWxsUHJvZ3Jlc3MpOiB2b2lkID0+IHtcclxuICAgICAgICAgIGZvciAoY29uc3QgdyBvZiBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKSkge1xyXG4gICAgICAgICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCdpbnN0YWxsOnByb2dyZXNzJywgcCk7XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgfTtcclxuICAgICAgICB2b2lkIChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgICBzZW5kU2ltKHsgcGhhc2U6ICdjaGVjaycsIHRleHQ6ICdcdTY4QzBcdTY3RTUgbnBtXHUyMDI2KHZlcmlmeSBcdTZBMjFcdTYyREYpJyB9KTtcclxuICAgICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDQwMCkpO1xyXG4gICAgICAgICAgc2VuZFNpbSh7IHBoYXNlOiAnbnBtJywgdGV4dDogJ25wbSBpbnN0YWxsIEBobWhhcm5lc3MvY2xpIFx1MjE5MiB+Ly5obWhhcm5lc3MtZ2xvYmFsKHZlcmlmeSBcdTZBMjFcdTYyREYsXHU0RTBEXHU4NDNEXHU3NkQ4KScgfSk7XHJcbiAgICAgICAgfSkoKTtcclxuICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgdGVzdDogdHJ1ZSB9O1xyXG4gICAgICB9XHJcbiAgICAgIHJldHVybiBzdGFydENsaUluc3RhbGwoXHJcbiAgICAgICAge1xyXG4gICAgICAgICAgc2VuZFByb2dyZXNzOiAocDogSW5zdGFsbFByb2dyZXNzKTogdm9pZCA9PiB7XHJcbiAgICAgICAgICAgIGxvZ0luZm8oJ2luc3RhbGwnLCBgJHtwLnBoYXNlfSR7cC5wY3QgIT09IHVuZGVmaW5lZCA/IGAgJHtwLnBjdH0lYCA6ICcnfSAke3AudGV4dH1gKTtcclxuICAgICAgICAgICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XHJcbiAgICAgICAgICAgICAgaWYgKCF3LmlzRGVzdHJveWVkKCkpIHcud2ViQ29udGVudHMuc2VuZCgnaW5zdGFsbDpwcm9ncmVzcycsIHApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICB9LFxyXG4gICAgICAgICAgbG9nOiAobTogc3RyaW5nKTogdm9pZCA9PiB7IGxvZ0luZm8oJ2luc3RhbGwnLCBtKTsgfSxcclxuICAgICAgICAgIC8vIFx1NUI4OVx1ODhDNVx1NjIxMFx1NTI5Rlx1NTM3M1x1NjMwMVx1NEU0NVx1NTMxNlx1NUU3Nlx1NzBFRFx1NTIwN1x1NjM2MihcdTU0MTFcdTVCRkNcdTk2OEZcdTU0MEVcdTY1MzZcdTVDM0U7XHU0RTJEXHU5MDE0XHU1M0Q2XHU2RDg4XHU0RTVGXHU1REYyXHU3NTFGXHU2NTQ4KVxyXG4gICAgICAgICAgb25JbnN0YWxsZWQ6IChlbnRyeTogc3RyaW5nKTogdm9pZCA9PiB7XHJcbiAgICAgICAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcclxuICAgICAgICAgICAgICBhd2FpdCBzYXZlUnVudGltZUNvbmZpZyh7IGVudHJ5LCBkZW1vOiBmYWxzZSB9KTtcclxuICAgICAgICAgICAgICBzc2VBYm9ydD8uYWJvcnQoKTtcclxuICAgICAgICAgICAgICBpZiAoc3VwZXJ2aXNvciAhPT0gbnVsbCkgYXdhaXQgc3VwZXJ2aXNvci5zdG9wKCk7XHJcbiAgICAgICAgICAgICAgYXdhaXQgc3RhcnRIb3N0KCk7XHJcbiAgICAgICAgICAgIH0pKCk7XHJcbiAgICAgICAgICB9LFxyXG4gICAgICAgIH0sXHJcbiAgICAgICAge1xyXG4gICAgICAgICAgZm9yY2VUZ3o6IG8uZm9yY2VUZ3ogPT09IHRydWUsXHJcbiAgICAgICAgICBtaXJyb3JGaXJzdDogby5taXJyb3JGaXJzdCA9PT0gJ25wbW1pcnJvcicgPyAnbnBtbWlycm9yJyA6IG8ubWlycm9yRmlyc3QgPT09ICducG1qcycgPyAnbnBtanMnIDogdW5kZWZpbmVkLFxyXG4gICAgICAgIH0sXHJcbiAgICAgICk7XHJcbiAgICB9KTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmdldC13aXphcmQnLCBhc3luYyAoZXZlbnQpID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgY29uc3QgdmFyaWFudCA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX1dJWkFSRDtcclxuICAgICAgaWYgKHZhcmlhbnQgIT09IHVuZGVmaW5lZCAmJiB2YXJpYW50ICE9PSAnJykge1xyXG4gICAgICAgIC8vIFx1OUE4Q1x1NjUzNlx1Njc4NFx1OTAyMDpcdTVGM0FcdTUyMzZcdTU0MTFcdTVCRkNcdTUzRUZcdTg5QzFcdTRFMTRcdTg5QzZcdTRFM0FcdTY3MkFcdTkxNERcdTdGNkUoXHU1M0VGXHU5MUNEXHU1OTBEXHU4REQxKTtwZXJzaXN0ZWQ9XHU3NzFGXHU1QjlFXHU4NDNEXHU3NkQ4XHJcbiAgICAgICAgLy8gXHU3MkI2XHU2MDAxKFx1NTQxMVx1NUJGQ1x1NkI2NVx1NjVBRFx1OEEwMFwiXHU5MDA5XHU2MkU5XHU2MzAxXHU0RTQ1XCJcdTc1MjgsXHU0RTBEXHU1RjcxXHU1NENEIFVJIFx1NTIyNFx1NUI5QSlcclxuICAgICAgICBjb25zdCB3ID0gYXdhaXQgbG9hZFdpemFyZFN0YXRlKCk7XHJcbiAgICAgICAgcmV0dXJuIHsgZG9uZTogZmFsc2UsIGNob2ljZTogJycsIHN1cHByZXNzZWQ6IGZhbHNlLCBwZXJzaXN0ZWQ6IHsgZG9uZTogdy5kb25lLCBjaG9pY2U6IHcuY2hvaWNlIH0gfTtcclxuICAgICAgfVxyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgbG9hZFdpemFyZFN0YXRlKCk7XHJcbiAgICAgIGNvbnN0IGNmZyA9IGF3YWl0IGxvYWRSdW50aW1lQ29uZmlnKCk7XHJcbiAgICAgIC8vIFx1NURGMlx1OTE0RFx1N0Y2RVx1OEZDNyBydW50aW1lKFx1NjI0Qlx1NTJBOFx1NTE2NVx1NTNFMy9cdTU0MTFcdTVCRkNcdTkwMDlcdTYyRTkvXHU2RjE0XHU3OTNBKVx1ODlDNlx1NTQwQ1x1NURGMlx1NUI4Q1x1NjIxMFx1OTk5Nlx1NTQyRlxyXG4gICAgICByZXR1cm4geyBkb25lOiB3LmRvbmUgfHwgY2ZnLmVudHJ5ICE9PSAnJyB8fCBjZmcuZGVtbywgY2hvaWNlOiB3LmNob2ljZSwgc3VwcHJlc3NlZDogd2l6YXJkU3VwcHJlc3NlZCgpIH07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiogXHU1NDExXHU1QkZDXHU2NTM2XHU1QzNFOlx1NjMwMVx1NEU0NVx1NTMxNlx1OTAwOVx1NjJFOVx1NUU3Nlx1NUU5NFx1NzUyOChleHRlcm5hbC9idW5kbGVkXHUyMTkyXHU1MTY1XHU1M0UzXHU4OTg2XHU3NkQ2O2RlbW9cdTIxOTJcdTYzMDFcdTRFNDVcdTZGMTRcdTc5M0E7XHJcbiAgICAgKiAgaW5zdGFsbFx1MjE5Mlx1NTE2NVx1NTNFM1x1NURGMlx1NzUzMVx1NUI4OVx1ODhDNVx1NTY2OFx1NjMwMVx1NEU0NVx1NTMxNixcdTUzRUFcdThCQjBcdTcyQjZcdTYwMDEpXHUzMDAyZmFrZS9cdTZENEJcdThCRDVcdTczQUZcdTU4ODNcdTUzRUFcdThCQjBcdTcyQjZcdTYwMDFcdTMwMDIgKi9cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6d2l6YXJkLWNvbXBsZXRlJywgYXN5bmMgKGV2ZW50LCBjaG9pY2U6IHVua25vd24sIGVudHJ5OiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IGMgPSBjaG9pY2UgPT09ICdleHRlcm5hbCcgfHwgY2hvaWNlID09PSAnaW5zdGFsbCcgfHwgY2hvaWNlID09PSAnYnVuZGxlZCcgfHwgY2hvaWNlID09PSAnZGVtbycgPyBjaG9pY2UgOiAnJztcclxuICAgICAgaWYgKGMgPT09ICcnKSByZXR1cm4geyBlcnJvcjogJ2Nob2ljZSBtdXN0IGJlIGV4dGVybmFsfGluc3RhbGx8YnVuZGxlZHxkZW1vJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9O1xyXG4gICAgICBjb25zdCBlID0gdHlwZW9mIGVudHJ5ID09PSAnc3RyaW5nJyA/IGVudHJ5IDogJyc7XHJcbiAgICAgIGF3YWl0IHNhdmVXaXphcmRTdGF0ZShjKTtcclxuICAgICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX0ZBS0UgPT09ICcxJykgcmV0dXJuIHsgb2s6IHRydWUsIG1vZGU6IGJyaWRnZS5tb2RlLCB0ZXN0OiB0cnVlIH07XHJcbiAgICAgIGNvbnN0IHJlcG9Sb290ID0gam9pbihoZXJlLCAnLi4nLCAnLi4nLCAnLi4nLCAnLi4nKTtcclxuICAgICAgaWYgKGMgPT09ICdleHRlcm5hbCcgfHwgYyA9PT0gJ2J1bmRsZWQnKSB7XHJcbiAgICAgICAgY29uc3QgdGFyZ2V0ID0gYyA9PT0gJ2J1bmRsZWQnID8gYnVuZGxlZFJ1bnRpbWVQYXRoKHJlcG9Sb290KSA6IGU7XHJcbiAgICAgICAgaWYgKHRhcmdldCA9PT0gJycgfHwgIWlzQWJzb2x1dGUodGFyZ2V0KSB8fCAhZXhpc3RzU3luYyh0YXJnZXQpKSB7XHJcbiAgICAgICAgICByZXR1cm4geyBlcnJvcjogJ3J1bnRpbWUgXHU1MTY1XHU1M0UzXHU0RTBEXHU1QjU4XHU1NzI4JywgY29kZTogJ0JBRF9SRVFVRVNUJyB9O1xyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCBzYXZlUnVudGltZUNvbmZpZyh7IGVudHJ5OiB0YXJnZXQsIGRlbW86IGZhbHNlIH0pO1xyXG4gICAgICB9IGVsc2UgaWYgKGMgPT09ICdkZW1vJykge1xyXG4gICAgICAgIGF3YWl0IHNhdmVSdW50aW1lQ29uZmlnKHsgZW50cnk6ICcnLCBkZW1vOiB0cnVlIH0pO1xyXG4gICAgICB9XHJcbiAgICAgIGlmIChjICE9PSAnaW5zdGFsbCcpIHtcclxuICAgICAgICAvLyBpbnN0YWxsOlx1NUI4OVx1ODhDNVx1NTY2OFx1NURGMlx1NTcyOCBvbkluc3RhbGxlZCBcdTYzMDFcdTRFNDVcdTUzMTZcdTVFNzZcdTcwRURcdTUyMDdcdTYzNjIsXHU4RkQ5XHU5MUNDXHU0RTBEXHU1MThEXHU5MUNEXHU1NDJGXHJcbiAgICAgICAgc3NlQWJvcnQ/LmFib3J0KCk7XHJcbiAgICAgICAgaWYgKHN1cGVydmlzb3IgIT09IG51bGwpIGF3YWl0IHN1cGVydmlzb3Iuc3RvcCgpO1xyXG4gICAgICAgIGF3YWl0IHN0YXJ0SG9zdCgpO1xyXG4gICAgICB9XHJcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBtb2RlOiBicmlkZ2UubW9kZSB9O1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBQcm92aWRlciBcdThCQkVcdTdGNkUoMDMgXHUwMEE3XHU0RTAzOmtleSBcdTUzRUFcdTUxRkEgaGFzS2V5L1x1NjcyQlx1NTZEQlx1NEY0RDtcdTRGRERcdTVCNThcdTc2RjRcdTUxOTkgcnVudGltZSkgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpwcm92aWRlcnMnLCAoZXZlbnQpID0+XHJcbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPHsgcHJvdmlkZXJzRGV0YWlsPzogQXJyYXk8eyBuYW1lOiBzdHJpbmc7IG1vZGVsOiBzdHJpbmc7IGJhc2VVcmw6IHN0cmluZzsgaGFzS2V5OiBib29sZWFuOyBrZXlUYWlsPzogc3RyaW5nIH0+OyBtb2RlbD86IHN0cmluZyB9PignL2FwaS9zdGF0ZScpKSk7XHJcblxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpwcm92aWRlci1zYXZlJywgKGV2ZW50LCBwcm92aWRlcjogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBwID0gcHJvdmlkZXIgYXMgeyBuYW1lPzogdW5rbm93bjsgYmFzZVVybD86IHVua25vd247IG1vZGVsPzogdW5rbm93bjsgYXBpS2V5PzogdW5rbm93biB9O1xyXG4gICAgICBjb25zdCBuYW1lID0gdHlwZW9mIHA/Lm5hbWUgPT09ICdzdHJpbmcnID8gcC5uYW1lLnNsaWNlKDAsIDgwKSA6ICcnO1xyXG4gICAgICBjb25zdCBiYXNlVXJsID0gdHlwZW9mIHA/LmJhc2VVcmwgPT09ICdzdHJpbmcnID8gcC5iYXNlVXJsLnNsaWNlKDAsIDMwMCkgOiAnJztcclxuICAgICAgY29uc3QgbW9kZWwgPSB0eXBlb2YgcD8ubW9kZWwgPT09ICdzdHJpbmcnID8gcC5tb2RlbC5zbGljZSgwLCAxMjApIDogJyc7XHJcbiAgICAgIGlmIChuYW1lID09PSAnJyB8fCBiYXNlVXJsID09PSAnJyB8fCBtb2RlbCA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ25hbWUvYmFzZVVybC9tb2RlbCByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XHJcbiAgICAgIGNvbnN0IGJvZHk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0geyBuYW1lLCBiYXNlVXJsLCBtb2RlbCB9O1xyXG4gICAgICAvLyBhcGlLZXkgXHU1M0VBXHU1NzI4XHU2NjNFXHU1RjBGXHU4RjkzXHU1MTY1XHU2NUY2XHU0RTBBXHU0RjIwLFx1N0VERFx1NEUwRFx1NTZERVx1NjYzRShyZW5kZXJlciBcdTg4NjhcdTUzNTVcdTYzRDBcdTRFQTRcdTU0MEVcdTUzNzNcdTZFMDVcdTdBN0EpXHJcbiAgICAgIGlmICh0eXBlb2YgcD8uYXBpS2V5ID09PSAnc3RyaW5nJyAmJiBwLmFwaUtleSAhPT0gJycpIGJvZHkuYXBpS2V5ID0gcC5hcGlLZXkuc2xpY2UoMCwgMzAwKTtcclxuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KCcvYXBpL3Byb3ZpZGVycycsIGJvZHkpKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gXHU1REU1XHU0RjVDXHU1MzNBKDAzIFx1MDBBN1x1NTE2RDtcdTUyMDdcdTYzNjJcdThCRURcdTRFNDlcdTRFMEUgd2ViIFx1NzZGOFx1NTQwQzpydW50aW1lIFx1NTM1NVx1OTAwOSBjd2QpIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6d29ya3NwYWNlcycsIChldmVudCkgPT5cclxuICAgICAgaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248eyBjdXJyZW50OiBzdHJpbmc7IGl0ZW1zOiBBcnJheTx7IGlkOiBzdHJpbmc7IG5hbWU6IHN0cmluZzsgcGF0aDogc3RyaW5nIH0+IH0+KCcvYXBpL3dvcmtzcGFjZXMnKSkpO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6d29ya3NwYWNlLXVzZScsIChldmVudCwgaWQ6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3Qgd2lkID0gdHlwZW9mIGlkID09PSAnc3RyaW5nJyA/IGlkLnNsaWNlKDAsIDYwKSA6ICcnO1xyXG4gICAgICBpZiAod2lkID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAnaWQgcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvd29ya3NwYWNlcy91c2UnLCB7IGlkOiB3aWQgfSkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTp3b3Jrc3BhY2UtYWRkJywgKGV2ZW50LCBuYW1lOiB1bmtub3duLCBwYXRoOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IG4gPSB0eXBlb2YgbmFtZSA9PT0gJ3N0cmluZycgPyBuYW1lLnNsaWNlKDAsIDEyMCkgOiAnJztcclxuICAgICAgY29uc3QgcCA9IHR5cGVvZiBwYXRoID09PSAnc3RyaW5nJyA/IHBhdGguc2xpY2UoMCwgMTAwMCkgOiAnJztcclxuICAgICAgaWYgKHAgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICdwYXRoIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcclxuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KCcvYXBpL3dvcmtzcGFjZXMnLCB7IG5hbWU6IG4gPT09ICcnID8gdW5kZWZpbmVkIDogbiwgcGF0aDogcCB9KSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIFx1NEYxQVx1OEJERFx1NUY1Mlx1Njg2My9cdTUyMjBcdTk2NjQoXHU3OUZCXHU1MTY1IGFyY2hpdmUvdHJhc2gsXHU1M0VGXHU2MDYyXHU1OTBEO3J1bnRpbWUgXHU2NzQzXHU1QTAxKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnNlc3Npb24tb3AnLCAoZXZlbnQsIGlkOiB1bmtub3duLCBvcDogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBzaWQgPSB0eXBlb2YgaWQgPT09ICdzdHJpbmcnID8gaWQucmVwbGFjZSgvW15hLXpBLVowLTlfOi5ALV0vZywgJycpLnNsaWNlKDAsIDgwKSA6ICcnO1xyXG4gICAgICBjb25zdCBvID0gb3AgPT09ICdhcmNoaXZlJyB8fCBvcCA9PT0gJ2RlbGV0ZScgPyBvcCA6ICcnO1xyXG4gICAgICBpZiAoc2lkID09PSAnJyB8fCBvID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAnaWQgYW5kIG9wKGFyY2hpdmV8ZGVsZXRlKSByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PihgL2FwaS9zZXNzaW9ucy8ke2VuY29kZVVSSUNvbXBvbmVudChzaWQpfS8ke299YCwge30pKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gTTQ6RGlmZiBcdTk3NjJcdTY3N0YoXHU1M0VBXHU4QkZCIGdpdCBcdTUzRDhcdTY2RjQ7XHU2Mzg4XHU2NzQzXHU1NzI4IHJ1bnRpbWUpIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6ZGlmZicsIChldmVudCwgc2Vzc2lvbklkOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IHNpZCA9IHR5cGVvZiBzZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gc2Vzc2lvbklkLnNsaWNlKDAsIDgwKSA6ICcnO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KGAvYXBpL2RpZmYke3NpZCAhPT0gJycgPyBgP3Nlc3Npb25JZD0ke2VuY29kZVVSSUNvbXBvbmVudChzaWQpfWAgOiAnJ31gKSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIE01Olx1OEJBNFx1NzdFNVx1NzJCNlx1NjAwMShcdTdFRDNcdTY3ODRcdTUzMTZcdTRFOEJcdTVCOUU7XHU3RjNBXHU2NTcwXHU2MzZFXHU1QjU3XHU2QkI1XHU3NTMxIFVJIFx1NjYzRVx1NzkzQVwiXHU2NUUwXHU2NTcwXHU2MzZFXCIpIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6Y29nbml0aXZlJywgKGV2ZW50KSA9PlxyXG4gICAgICBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oJy9hcGkvY29nbml0aXZlJykpKTtcclxuXHJcbiAgICAvLyAtLS0tIFx1NTM4Nlx1NTNGMlx1NEYxQVx1OEJERFx1OTg4NFx1ODlDOChcdTY3MDBcdTU0MEUgODAgXHU2NzYxLFx1NkJDRlx1Njc2MSA1MDAgXHU1QjU3O3J1bnRpbWUgXHU2NzQzXHU1QTAxXHU2NTcwXHU2MzZFKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnNlc3Npb24tcHJldmlldycsIChldmVudCwgaWQ6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIGlkID09PSAnc3RyaW5nJyA/IGlkLnJlcGxhY2UoL1teYS16QS1aMC05XzouQC1dL2csICcnKS5zbGljZSgwLCA4MCkgOiAnJztcclxuICAgICAgaWYgKHNpZCA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ2lkIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcclxuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPFJlY29yZDxzdHJpbmcsIHVua25vd24+PihgL2FwaS9zZXNzaW9ucy8ke2VuY29kZVVSSUNvbXBvbmVudChzaWQpfWApKTtcclxuICAgIH0pO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6c3RvcC1ob3N0JywgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicgfTtcclxuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIHNzZUFib3J0Py5hYm9ydCgpO1xyXG4gICAgICAgIGF3YWl0IHN1cGVydmlzb3I/LnN0b3AoKTtcclxuICAgICAgICBhcHAucXVpdCgpO1xyXG4gICAgICB9KSgpO1xyXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSB9O1xyXG4gICAgfSk7XHJcbiAgfVxyXG5cclxuICAvKiAtLS0tIFx1N0E5N1x1NTNFM1x1NEUwRVx1NUI4OVx1NTE2OFx1N0I1Nlx1NzU2NSAtLS0tICovXHJcbiAgLy8gMDMgXHUwMEE3XHU0RTAzOkRlc2t0b3AgXHU2NzJDXHU1NzMwXHU1M0VBXHU1QjU4IFVJIFx1NTA0Rlx1NTk3RC9cdTdBOTdcdTUzRTNcdTcyQjZcdTYwMDEodXNlckRhdGEvd2luZG93LXN0YXRlLmpzb24pXHJcbiAgY29uc3Qgd2luZG93U3RhdGVGaWxlID0gKCk6IHN0cmluZyA9PiBqb2luKGFwcC5nZXRQYXRoKCd1c2VyRGF0YScpLCAnd2luZG93LXN0YXRlLmpzb24nKTtcclxuICBhc3luYyBmdW5jdGlvbiBsb2FkQm91bmRzKCk6IFByb21pc2U8eyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlcjsgeD86IG51bWJlcjsgeT86IG51bWJlciB9IHwgbnVsbD4ge1xyXG4gICAgdHJ5IHtcclxuICAgICAgcmV0dXJuIEpTT04ucGFyc2UoYXdhaXQgcmVhZEZpbGUod2luZG93U3RhdGVGaWxlKCksICd1dGY4JykpIGFzIHsgd2lkdGg6IG51bWJlcjsgaGVpZ2h0OiBudW1iZXI7IHg/OiBudW1iZXI7IHk/OiBudW1iZXIgfTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4gbnVsbDsgfVxyXG4gIH1cclxuICBhc3luYyBmdW5jdGlvbiBzYXZlQm91bmRzKHdpbjogQnJvd3NlcldpbmRvdyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgdHJ5IHsgYXdhaXQgd3JpdGVGaWxlKHdpbmRvd1N0YXRlRmlsZSgpLCBKU09OLnN0cmluZ2lmeSh3aW4uZ2V0Qm91bmRzKCkpLCAndXRmOCcpOyB9IGNhdGNoIHsgLyogYmVzdCBlZmZvcnQgKi8gfVxyXG4gIH1cclxuXHJcbiAgYXN5bmMgZnVuY3Rpb24gY3JlYXRlV2luZG93KCk6IFByb21pc2U8QnJvd3NlcldpbmRvdyB8IG51bGw+IHtcclxuICAgIGNvbnN0IHNhdmVkID0gYXdhaXQgbG9hZEJvdW5kcygpO1xyXG4gICAgY29uc3Qgd2luID0gbmV3IEJyb3dzZXJXaW5kb3coe1xyXG4gICAgICB3aWR0aDogc2F2ZWQ/LndpZHRoID8/IDE0NDAsXHJcbiAgICAgIGhlaWdodDogc2F2ZWQ/LmhlaWdodCA/PyA5MDAsXHJcbiAgICAgIC4uLihzYXZlZD8ueCAhPT0gdW5kZWZpbmVkICYmIHNhdmVkPy55ICE9PSB1bmRlZmluZWQgPyB7IHg6IHNhdmVkLngsIHk6IHNhdmVkLnkgfSA6IHt9KSxcclxuICAgICAgLy8gSElHIFx1OTYzNlx1NkJCNTIoMTEtQSk6XHU3QTg0XHU3QTk3XHU0RTBCXHU5NjUwIDU2MCgwNCBcdTUzRjdcdTg5QzRcdTY4M0M7XHU1MzlGIDk2MCBcdTRGN0YgXHUyMjY0ODIwcHggXHU2MkJEXHU1QzQ5XHU2NUFEXHU3MEI5XHU0RTBEXHU1M0VGXHU4RkJFKTtcclxuICAgICAgLy8gVUlWRVJJRlkgXHU3QTg0XHU1QzRGXHU5QThDXHU2NTM2KDExLUIsd2l6YXJkIDM2MFx1MDBENzY0MCBcdTUxNjhcdTUxNDNcdTdEMjBcdTUzRUZcdThGQkUpXHU5NzAwXHU0RTM0XHU2NUY2XHU2NTNFXHU1QkJEXHU1MjMwIDMyMFx1MDBENzM2MFx1MzAwMlxyXG4gICAgICBtaW5XaWR0aDogcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRlkgPT09ICcxJyA/IDMyMCA6IDU2MCxcclxuICAgICAgbWluSGVpZ2h0OiBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWSA9PT0gJzEnID8gMzYwIDogNjAwLFxyXG4gICAgICBzaG93OiBmYWxzZSxcclxuICAgICAgYmFja2dyb3VuZENvbG9yOiAnI2Y5ZmFmYicsIC8vIHY0IERTSDpcdTZENDVcdTgyNzJcdTlFRDhcdThCQTQoYmctYmFzZSksXHU5MDdGXHU1MTREXHU2REYxXHU4MjcyXHU5NUVBXHU1QzRGXHJcbiAgICAgIHRpdGxlOiAnSE1IIERlc2t0b3AnLFxyXG4gICAgICAvLyBcdTk2OTBcdTg1Q0ZcdTVGMEZcdTY4MDdcdTk4OThcdTY4MEY6XHU1MzlGXHU3NTFGXHU3QTk3XHU1M0UzXHU2M0E3XHU1MjM2KG92ZXJsYXkgXHU2M0QwXHU0RjlCKStcdTk4OUNcdTgyNzJcdTk2OEZcdTRFM0JcdTk4OTgocmVuZGVyZXIgXHU3RUNGXHJcbiAgICAgIC8vIGNocm9tZS10aGVtZSBcdTU0MENcdTZCNjUpXHUyMDE0XHUyMDE0XHU2ODM5XHU2Q0JCXHU0RUFFXHU4MjcyXHU2QTIxXHU1RjBGXHU5ODc2XHU5MEU4XHU5RUQxXHU2NzYxO1x1ODNEQ1x1NTM1NVx1NjgwRiBhdXRvSGlkZShBbHQgXHU1NDdDXHU1MUZBKVx1MzAwMlxyXG4gICAgICB0aXRsZUJhclN0eWxlOiAnaGlkZGVuJyxcclxuICAgICAgLy8gSElHIFx1OTYzNlx1NkJCNTI6MzZcdTIxOTI0NCxcdTRFMEUgcmVuZGVyZXIgLnRpdGxlYmFyIFx1OUFEOFx1NUVBNlx1NEUwMFx1ODFGNChcdTRFMERcdTRFMDBcdTgxRjRcdTRGMUFcdTk3MzJcdTUxRkEvXHU5MDZFXHU0RjRGIDhweClcclxuICAgICAgdGl0bGVCYXJPdmVybGF5OiB7IC4uLmNocm9tZUZvcihuYXRpdmVUaGVtZS5zaG91bGRVc2VEYXJrQ29sb3JzKSwgaGVpZ2h0OiA0NCB9LFxyXG4gICAgICBhdXRvSGlkZU1lbnVCYXI6IHRydWUsXHJcbiAgICAgIHdlYlByZWZlcmVuY2VzOiB7XHJcbiAgICAgICAgcHJlbG9hZDogcHJlbG9hZFBhdGgsXHJcbiAgICAgICAgY29udGV4dElzb2xhdGlvbjogdHJ1ZSxcclxuICAgICAgICBzYW5kYm94OiB0cnVlLFxyXG4gICAgICAgIG5vZGVJbnRlZ3JhdGlvbjogZmFsc2UsXHJcbiAgICAgICAgbm9kZUludGVncmF0aW9uSW5Xb3JrZXI6IGZhbHNlLFxyXG4gICAgICAgIHdlYlNlY3VyaXR5OiB0cnVlLFxyXG4gICAgICAgIHNwZWxsY2hlY2s6IGZhbHNlLFxyXG4gICAgICAgIGRldlRvb2xzOiBpc0RldixcclxuICAgICAgfSxcclxuICAgIH0pO1xyXG4gICAgd2luLm9uY2UoJ3JlYWR5LXRvLXNob3cnLCAoKSA9PiB3aW4uc2hvdygpKTtcclxuICAgIHdpbi5vbignY2xvc2UnLCAoKSA9PiB7IHZvaWQgc2F2ZUJvdW5kcyh3aW4pOyB9KTtcclxuXHJcbiAgICAvLyBcdTUzRUFcdTUxNDFcdThCQjhcdTUyQTBcdThGN0RcdTYyMTFcdTRFRUNcdTgxRUFcdTVERjFcdTc2ODQgcmVuZGVyZXI7XHU0RUZCXHU0RjU1XHU1QkZDXHU4MjJBL1x1NjVCMFx1N0E5N1x1NTNFM1x1NEUwMFx1NUY4Qlx1NjJEMlx1N0VERFxyXG4gICAgd2luLndlYkNvbnRlbnRzLnNldFdpbmRvd09wZW5IYW5kbGVyKCh7IHVybCB9KSA9PiB7XHJcbiAgICAgIGlmICgvXmh0dHBzPzpcXC9cXC8vLnRlc3QodXJsKSkgdm9pZCBzaGVsbC5vcGVuRXh0ZXJuYWwodXJsKTtcclxuICAgICAgcmV0dXJuIHsgYWN0aW9uOiAnZGVueScgfTtcclxuICAgIH0pO1xyXG4gICAgd2luLndlYkNvbnRlbnRzLm9uKCd3aWxsLW5hdmlnYXRlJywgKGUsIHVybCkgPT4ge1xyXG4gICAgICBjb25zdCBvayA9IFsuLi5hbGxvd2VkT3JpZ2luc10uc29tZSgobykgPT4gdXJsID09PSBvIHx8IHVybC5zdGFydHNXaXRoKGAke299L2ApIHx8IHVybC5zdGFydHNXaXRoKGAke299P2ApKTtcclxuICAgICAgaWYgKCFvaykge1xyXG4gICAgICAgIGxvZ0luZm8oJ25hdicsIGBibG9ja2VkIG5hdmlnYXRpb24gdG8gJHt1cmwuc2xpY2UoMCwgMTIwKX1gKTtcclxuICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7XHJcbiAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIGlmIChpc0RldiAmJiByZW5kZXJlckRldlVybCkge1xyXG4gICAgICB2b2lkIHdpbi5sb2FkVVJMKHJlbmRlcmVyRGV2VXJsKTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgIHZvaWQgd2luLmxvYWRGaWxlKGpvaW4oaGVyZSwgJy4uJywgJy4uJywgJ2Rpc3QtcmVuZGVyZXInLCAnaW5kZXguaHRtbCcpKTtcclxuICAgIH1cclxuICAgIC8vIFx1OTg3NVx1OTc2Mlx1NTJBMFx1OEY3RFx1NUI4Q1x1OTFDRFx1NjRBRFx1NUY1M1x1NTI0RCBob3N0IFx1NzJCNlx1NjAwMTpyZWFkeSBcdTVFN0ZcdTY0QURcdTgyRTVcdTY1RTlcdTRFOEUgcmVuZGVyZXIgXHU4QkEyXHU5NjA1XHU1MzczXHU0RTIyXHU1OTMxLFxyXG4gICAgLy8gcmVuZGVyZXIgXHU3Njg0IGdldC1zdGF0ZSBcdTVGRUJcdTcxNjcgKyBcdThGRDlcdTkxQ0NcdTc2ODRcdTkxQ0RcdTY0QURcdTUzQ0NcdTRGRERcdTk2NjkoXHU1OTFBXHU3QTk3XHU1M0UzL1x1OTFDRFx1OEY3RFx1NTczQVx1NjY2Rlx1NEU1Rlx1ODk4Nlx1NzZENilcdTMwMDJcclxuICAgIHdpbi53ZWJDb250ZW50cy5vbmNlKCdkaWQtZmluaXNoLWxvYWQnLCAoKSA9PiB7XHJcbiAgICAgIGlmICghd2luLmlzRGVzdHJveWVkKCkpIHtcclxuICAgICAgICB3aW4ud2ViQ29udGVudHMuc2VuZCgnYnJpZGdlOmhvc3Qtc3RhdGUnLCBicmlkZ2UuaG9zdFN0YXRlLCB7IHJlc3RhcnRDb3VudDogMCB9KTtcclxuICAgICAgfVxyXG4gICAgfSk7XHJcbiAgICByZXR1cm4gd2luO1xyXG4gIH1cclxuXHJcbiAgYXBwLndoZW5SZWFkeSgpLnRoZW4oKCkgPT4ge1xyXG4gICAgLy8gVUlWRVJJRlk6ZmFrZSBcdTZBMjFcdTVGMEZcdTlBOENcdTY1MzZcdTk4N0JcdTU3Mjggc3RhcnRIb3N0IFx1OEJGQiBlbnYgXHU0RTRCXHU1MjREXHU1RjNBXHU1MjM2IGZha2U7VklTUkVHKFx1ODlDNlx1ODlDOVx1NTZERVx1NUY1MilcdTU0MENcdTg5QzRcdTUyMTlcclxuICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9WSVNSRUcgPT09ICcxJyB8fCAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRlkgPT09ICcxJyAmJiBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9NT0RFICE9PSAncmVhbCcpKSB7XHJcbiAgICAgIHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX0ZBS0UgPSAnMSc7XHJcbiAgICB9XHJcbiAgICAvLyBXaW5kb3dzIFx1OTAxQVx1NzdFNVx1NUY1Mlx1NUM1RShcdTU0MjZcdTUyMTlcdTY2M0VcdTc5M0FcdTRFM0EgZWxlY3Ryb24uZXhlKVxyXG4gICAgYXBwLnNldEFwcFVzZXJNb2RlbElkKCdkZXYuaG1oLmRlc2t0b3AnKTtcclxuICAgIHNldHVwVHJheSgpO1xyXG4gICAgYnVpbGRBcHBNZW51KCk7XHJcbiAgICAvLyBcdTU0MkZcdTUyQTggMzBzIFx1NTQwRVx1OTc1OVx1OUVEOFx1NjhDMFx1NjdFNVx1NjZGNFx1NjVCMChcdTY3MDlcdTY1QjBcdTcyNDhcdTRFQzVcdTU0MEVcdTUzRjBcdTRFMEJcdThGN0QsXHU0RTBEXHU2MjUzXHU2MjcwO1x1NTkzMVx1OEQyNVx1OTc1OVx1OUVEOCxcdTRFMEJcdTZCMjFcdTU0MkZcdTUyQThcdTUxOERcdThCRDUpXHUzMDAyXHJcbiAgICAvLyBkZXYgXHU0RTVGXHU2OEMwXHU2N0U1Olx1ODg0Q1x1NEUzQVx1NEUwRVx1NjI1M1x1NTMwNVx1NzI0OFx1NEUwMFx1ODFGNCxcdTRFMTQgRk9SQ0VfVEFHIFx1NjVDQlx1OTRBRVx1NEUwQiBkZXYgXHU1MzczXHU1M0VGXHU1MTY4XHU2RDQxXHU3QTBCXHU5QThDXHU2NTM2XHUzMDAyXHJcbiAgICBzZXRUaW1lb3V0KCgpID0+IHsgdm9pZCBjaGVja0ZvclVwZGF0ZXMoKTsgfSwgMzBfMDAwKTtcclxuICAgIC8vIENTUChkZXYgXHU0RTBFIHByb2QgXHU0RTBEXHU1NDBDO3Byb2QgXHU0RTBEXHU1MTQxXHU4QkI4XHU0RUZCXHU0RjU1XHU4RkRDXHU3QTBCXHU2RTkwKVxyXG4gICAgY29uc3QgY3NwID0gaXNEZXZcclxuICAgICAgPyBbXHJcbiAgICAgICAgICBcImRlZmF1bHQtc3JjICdzZWxmJ1wiLFxyXG4gICAgICAgICAgYHNjcmlwdC1zcmMgJ3NlbGYnICR7cmVuZGVyZXJEZXZVcmx9YCxcclxuICAgICAgICAgIFwic3R5bGUtc3JjICdzZWxmJyAndW5zYWZlLWlubGluZSdcIixcclxuICAgICAgICAgIGBjb25uZWN0LXNyYyAnc2VsZicgJHtyZW5kZXJlckRldlVybH0gd3M6Ly8xMjcuMC4wLjE6KmAsXHJcbiAgICAgICAgICBcImltZy1zcmMgJ3NlbGYnIGRhdGE6XCIsXHJcbiAgICAgICAgICBcImZvbnQtc3JjICdzZWxmJyBkYXRhOlwiLFxyXG4gICAgICAgIF0uam9pbignOyAnKVxyXG4gICAgICA6IFwiZGVmYXVsdC1zcmMgJ3NlbGYnOyBzY3JpcHQtc3JjICdzZWxmJzsgc3R5bGUtc3JjICdzZWxmJyAndW5zYWZlLWlubGluZSc7IGltZy1zcmMgJ3NlbGYnIGRhdGE6OyBmb250LXNyYyAnc2VsZicgZGF0YTpcIjtcclxuICAgIHNlc3Npb24uZGVmYXVsdFNlc3Npb24ud2ViUmVxdWVzdC5vbkhlYWRlcnNSZWNlaXZlZCgoZGV0YWlscywgY2FsbGJhY2spID0+IHtcclxuICAgICAgY2FsbGJhY2soe1xyXG4gICAgICAgIHJlc3BvbnNlSGVhZGVyczoge1xyXG4gICAgICAgICAgLi4uZGV0YWlscy5yZXNwb25zZUhlYWRlcnMsXHJcbiAgICAgICAgICAnQ29udGVudC1TZWN1cml0eS1Qb2xpY3knOiBbY3NwXSxcclxuICAgICAgICB9LFxyXG4gICAgICB9KTtcclxuICAgIH0pO1xyXG5cclxuICAgIHJlZ2lzdGVySXBjKCk7XHJcbiAgICAvLyBjcmVhdGVXaW5kb3cgXHU2NjJGIGFzeW5jKGJvdW5kcyBcdTYwNjJcdTU5MEQpO1x1NUI4OVx1NTE2OFx1ODFFQVx1NkQ0Qi9cdTZFMzJcdTY3RDNcdTgxRUFcdTY4QzBcdTU3MjhcdTdBOTdcdTUzRTNcdTVDMzFcdTdFRUFcdTU0MEVcdTYzMDJcdThGN0RcclxuICAgIHZvaWQgY3JlYXRlV2luZG93KCkudGhlbigod2luKSA9PiB7XHJcbiAgICAgIGlmICh3aW4gPT09IG51bGwpIHJldHVybjtcclxuICAgICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZID09PSAnMScpIGF0dGFjaFVpVmVyaWZ5KHdpbik7XHJcbiAgICAgIC8vIFx1ODlDNlx1ODlDOVx1NTZERVx1NUY1Mlx1NjIyQVx1NTZGRVx1OTRBOVx1NUI1MDpITUhfREVTS1RPUF9WSVNSRUc9MSxcdTc4NkVcdTVCOUFcdTYwMjdcdTg5QzZcdTUzRTNcdTYyMkFcdTU2RkVcdTU0MEVcdTkwMDBcdTUxRkEoc2NyaXB0cy92aXN1YWwtcmVncmVzc2lvbi5tanMgXHU5QTcxXHU1MkE4KVxyXG4gICAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVklTUkVHID09PSAnMScpIGF0dGFjaFZpc3VhbFJlZ3Jlc3Npb24od2luKTtcclxuICAgICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NFQ1VSSVRZX1RFU1QgPT09ICcxJykge1xyXG4gICAgICAgIHdpbi53ZWJDb250ZW50cy5vbmNlKCdkaWQtZmluaXNoLWxvYWQnLCAoKSA9PiB7XHJcbiAgICAgICAgICB2b2lkIHNlY3VyaXR5U2VsZlRlc3Qod2luKTtcclxuICAgICAgICB9KTtcclxuICAgICAgfVxyXG4gICAgICAvLyBVSSBcdTYyMkFcdTU2RkVcdTk0QTlcdTVCNTA6SE1IX0RFU0tUT1BfU05BUFNIT1Q9PGZpbGUucG5nPiBcdTU3MjhcdTc1NENcdTk3NjJcdTVDMzFcdTdFRUFcdTU0MEVcdTYyMkFcdTU2RkVcdTkwMDBcdTUxRkFcclxuICAgICAgLy8gKFx1ODhDNVx1NjczQVx1OEJDQVx1NjVBRFx1NzUyODpcdTRFQjJcdTc3M0NcdTc3MEJcdTZFMzJcdTY3RDNcdTdFRDNcdTY3OUMsXHU4MDBDXHU0RTBEXHU2NjJGXHU1M0VBXHU2NTcwIHJvb3QgXHU1QjUwXHU4MjgyXHU3MEI5KVx1MzAwMlxyXG4gICAgICBjb25zdCBzbmFwID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfU05BUFNIT1Q7XHJcbiAgICAgIGlmIChzbmFwICE9PSB1bmRlZmluZWQgJiYgc25hcCAhPT0gJycpIHtcclxuICAgICAgICB3aW4ud2ViQ29udGVudHMub25jZSgnZGlkLWZpbmlzaC1sb2FkJywgKCkgPT4ge1xyXG4gICAgICAgICAgc2V0VGltZW91dCgoKSA9PiB7XHJcbiAgICAgICAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcclxuICAgICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgaW1nID0gYXdhaXQgd2luLndlYkNvbnRlbnRzLmNhcHR1cmVQYWdlKCk7XHJcbiAgICAgICAgICAgICAgICBjb25zdCB7IHdyaXRlRmlsZTogd2YgfSA9IGF3YWl0IGltcG9ydCgnbm9kZTpmcy9wcm9taXNlcycpO1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgd2Yoc25hcCwgaW1nLnRvUE5HKCkpO1xyXG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYFNOQVBTSE9UIG9rICR7c25hcH0gJHtpbWcuZ2V0U2l6ZSgpLndpZHRofXgke2ltZy5nZXRTaXplKCkuaGVpZ2h0fWApO1xyXG4gICAgICAgICAgICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYFNOQVBTSE9UIGVycm9yICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTIwKX1gKTtcclxuICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgY29uc3QgYXBwMiA9IGFwcDtcclxuICAgICAgICAgICAgICBzZXRUaW1lb3V0KCgpID0+IGFwcDIuZXhpdCgwKSwgNTAwKTtcclxuICAgICAgICAgICAgfSkoKTtcclxuICAgICAgICAgIH0sIE51bWJlcihwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9TTkFQU0hPVF9ERUxBWV9NUyA/PyAxMl8wMDApKTtcclxuICAgICAgICB9KTtcclxuICAgICAgfVxyXG4gICAgICAvLyBET00gXHU3RUQzXHU2Nzg0XHU2M0EyXHU5NDg4OkhNSF9ERVNLVE9QX0RPTVBST0JFPTEgXHU4RjkzXHU1MUZBXHU1MTczXHU5NTJFXHU1MTQzXHU3RDIwXHU3Njg0IGJveC9kaXNwbGF5L2NoaWxkcmVuLFxyXG4gICAgICAvLyBcdTUxOERcdTkwMDBcdTUxRkEoXHU4QkNBXHU2NUFEXCJSZWFjdCBcdTYzMDJcdThGN0RcdTRFODZcdTRGNDZcdTY3RDBcdTU3NTcgVUkgXHU0RTBEXHU1M0VGXHU4OUMxXCJcdThGRDlcdTdDN0JcdTk1RUVcdTk4OTg7XHU2MjJBXHU1NkZFXHU0RTRCXHU1OTE2XHU3Njg0XHU3ODZDXHU4QkMxXHU2MzZFKVx1MzAwMlxyXG4gICAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfRE9NUFJPQkUgPT09ICcxJykge1xyXG4gICAgICAgIHdpbi53ZWJDb250ZW50cy5vbmNlKCdkaWQtZmluaXNoLWxvYWQnLCAoKSA9PiB7XHJcbiAgICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHtcclxuICAgICAgICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCByID0gKGF3YWl0IHdpbi53ZWJDb250ZW50cy5leGVjdXRlSmF2YVNjcmlwdChgKGZ1bmN0aW9uKCl7XHJcbiAgICAgICAgICAgICAgICAgIHZhciBwaWNrID0gZnVuY3Rpb24oc2VsKXtcclxuICAgICAgICAgICAgICAgICAgICB2YXIgZWxzID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbChzZWwpO1xyXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBBcnJheS5wcm90b3R5cGUuc2xpY2UuY2FsbChlbHMsIDAsIDQpLm1hcChmdW5jdGlvbihlbCl7XHJcbiAgICAgICAgICAgICAgICAgICAgICB2YXIgY3MgPSBnZXRDb21wdXRlZFN0eWxlKGVsKTtcclxuICAgICAgICAgICAgICAgICAgICAgIHZhciBiID0gZWwuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICByZXR1cm4geyBjbHM6IChlbC5jbGFzc05hbWV8fCcnKS50b1N0cmluZygpLnNsaWNlKDAsODApLCB0YWc6IGVsLnRhZ05hbWUsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGRpc3BsYXk6IGNzLmRpc3BsYXksIHZpczogY3MudmlzaWJpbGl0eSwgb3BhY2l0eTogY3Mub3BhY2l0eSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgcG9zOiBjcy5wb3NpdGlvbiwgejogY3MuekluZGV4LCBvdmVyZmxvdzogY3Mub3ZlcmZsb3csXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHg6IE1hdGgucm91bmQoYi54KSwgeTogTWF0aC5yb3VuZChiLnkpLCB3OiBNYXRoLnJvdW5kKGIud2lkdGgpLCBoOiBNYXRoLnJvdW5kKGIuaGVpZ2h0KSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgdGV4dDogKGVsLmlubmVyVGV4dHx8JycpLnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw2MCkgfTtcclxuICAgICAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgICAgICAgdmFyIHNlbHMgPSBbJ2h0bWwnLCdib2R5JywnI3Jvb3QnLCcuYXBwLXNoZWxsJywnLnNpZGViYXInLCcud29ya3NwYWNlJywnLnRvcGJhcicsJy5zdHJlYW0nLCcuZW1wdHktaGludCcsJy5jb21wb3NlcicsJy5jb21wb3Nlci1yb3cnLCcuY29tcG9zZXIgdGV4dGFyZWEnLCcuY29tcG9zZXItc2lkZScsJy5hdHQtcGlja2VyJywnLmF0dC1jaGlwcycsJy5zaWRlcGFuZWwnLCcucnVudGltZS1ndWlkZScsJy5vdmVybGF5JywnLnR1cm4nLCcuY2FyZCddO1xyXG4gICAgICAgICAgICAgICAgICB2YXIgb3V0ID0ge307XHJcbiAgICAgICAgICAgICAgICAgIHNlbHMuZm9yRWFjaChmdW5jdGlvbihzKXsgdHJ5IHsgb3V0W3NdID0gcGljayhzKTsgfSBjYXRjaChlKXsgb3V0W3NdID0gW3tlcnI6IFN0cmluZyhlKS5zbGljZSgwLDgwKX1dOyB9IH0pO1xyXG4gICAgICAgICAgICAgICAgICBvdXQuX19tZXRhID0ge1xyXG4gICAgICAgICAgICAgICAgICAgIHN0eWxlU2hlZXRzOiBkb2N1bWVudC5zdHlsZVNoZWV0cy5sZW5ndGgsXHJcbiAgICAgICAgICAgICAgICAgICAgc2hlZXQwcnVsZXM6IChkb2N1bWVudC5zdHlsZVNoZWV0c1swXSAmJiBkb2N1bWVudC5zdHlsZVNoZWV0c1swXS5jc3NSdWxlcykgPyBkb2N1bWVudC5zdHlsZVNoZWV0c1swXS5jc3NSdWxlcy5sZW5ndGggOiAtMSxcclxuICAgICAgICAgICAgICAgICAgICByb290Q2hpbGRyZW46IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyb290JykgPyBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncm9vdCcpLmNoaWxkcmVuLmxlbmd0aCA6IC0xLFxyXG4gICAgICAgICAgICAgICAgICAgIGJvZHlDaGlsZHJlbjogZG9jdW1lbnQuYm9keS5jaGlsZHJlbi5sZW5ndGgsXHJcbiAgICAgICAgICAgICAgICAgICAgaW5uZXJIVE1MTGVuOiBkb2N1bWVudC5ib2R5LmlubmVySFRNTC5sZW5ndGgsXHJcbiAgICAgICAgICAgICAgICAgICAgdmlld3BvcnQ6IHdpbmRvdy5pbm5lcldpZHRoICsgJ3gnICsgd2luZG93LmlubmVySGVpZ2h0XHJcbiAgICAgICAgICAgICAgICAgIH07XHJcbiAgICAgICAgICAgICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeShvdXQpO1xyXG4gICAgICAgICAgICAgICAgfSkoKWAsIHRydWUpKSBhcyBzdHJpbmc7XHJcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgRE9NUFJPQkUgJHtyfWApO1xyXG4gICAgICAgICAgICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYERPTVBST0JFIGVycm9yICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMjAwKX1gKTtcclxuICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgYXBwLmV4aXQoMCk7XHJcbiAgICAgICAgICAgIH0pKCk7XHJcbiAgICAgICAgICB9LCBOdW1iZXIocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfRE9NUFJPQkVfREVMQVlfTVMgPz8gOV8wMDApKTtcclxuICAgICAgICB9KTtcclxuICAgICAgfVxyXG4gICAgICAvLyBcdTZFMzJcdTY3RDNcdTgxRUFcdTY4QzAoMjAyNi0xMC0xMCBcdTg4QzVcdTY3M0FcdTlFRDFcdTVDNEZcdTY1NTlcdThCQUQ6YnJpZGdlIHJlYWR5IFx1MjI2MCBcdTc1NENcdTk3NjJcdTZFMzJcdTY3RDNcdTRFODYpXHUzMDAyXHJcbiAgICAgIC8vICNyb290IFx1NTcyOCBSZWFjdCBcdTYzMDJcdThGN0RcdTU0MEVcdTVGQzVcdTY3MDlcdTVCNTBcdTgyODJcdTcwQjk7XHU3QTdBID0gXHU4RDQ0XHU2RTkwXHU4REVGXHU1Rjg0L0NTUC9cdTgxMUFcdTY3MkNcdTUyQTBcdThGN0RcdTU3NEZcdTRFODZcdTMwMDJcclxuICAgICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1JFTkRFUl9URVNUID09PSAnMScpIHtcclxuICAgICAgICB3aW4ud2ViQ29udGVudHMub25jZSgnZGlkLWZpbmlzaC1sb2FkJywgKCkgPT4ge1xyXG4gICAgICAgICAgc2V0VGltZW91dCgoKSA9PiB7XHJcbiAgICAgICAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcclxuICAgICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgbiA9IChhd2FpdCB3aW4ud2ViQ29udGVudHMuZXhlY3V0ZUphdmFTY3JpcHQoXHJcbiAgICAgICAgICAgICAgICAgICdkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInJvb3RcIikgPyBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInJvb3RcIikuY2hpbGRyZW4ubGVuZ3RoIDogLTEnLCB0cnVlLFxyXG4gICAgICAgICAgICAgICAgKSkgYXMgbnVtYmVyO1xyXG4gICAgICAgICAgICAgICAgY29uc3Qgb2sgPSBuID4gMDtcclxuICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBSRU5ERVItVEVTVCAke29rID8gJ29rJyA6ICdFTVBUWSd9IHJvb3RDaGlsZHJlbj0ke259YCk7XHJcbiAgICAgICAgICAgICAgICBhcHAuZXhpdChvayA/IDAgOiAxKTtcclxuICAgICAgICAgICAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBSRU5ERVItVEVTVCBFUlJPUiAke1N0cmluZyhlcnIpLnNsaWNlKDAsIDEyMCl9YCk7XHJcbiAgICAgICAgICAgICAgICBhcHAuZXhpdCgxKTtcclxuICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH0pKCk7XHJcbiAgICAgICAgICB9LCAyXzUwMCk7XHJcbiAgICAgICAgfSk7XHJcbiAgICAgIH1cclxuICAgIH0pO1xyXG4gICAgdm9pZCBzdGFydEhvc3QoKTtcclxuXHJcbiAgICBhcHAub24oJ2FjdGl2YXRlJywgKCkgPT4ge1xyXG4gICAgICBpZiAoQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkubGVuZ3RoID09PSAwKSB2b2lkIGNyZWF0ZVdpbmRvdygpO1xyXG4gICAgfSk7XHJcbiAgfSk7XHJcblxyXG4gIGFzeW5jIGZ1bmN0aW9uIHNlY3VyaXR5U2VsZlRlc3Qod2luOiBCcm93c2VyV2luZG93KTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCByZXN1bHRzOiBBcnJheTxbc3RyaW5nLCBib29sZWFuLCBzdHJpbmddPiA9IFtdO1xyXG4gICAgY29uc3QgY2hlY2sgPSBhc3luYyAobmFtZTogc3RyaW5nLCBwcm9iZTogKCkgPT4gUHJvbWlzZTxbYm9vbGVhbiwgc3RyaW5nXT4pOiBQcm9taXNlPHZvaWQ+ID0+IHtcclxuICAgICAgdHJ5IHtcclxuICAgICAgICBjb25zdCBbb2ssIGRldGFpbF0gPSBhd2FpdCBwcm9iZSgpO1xyXG4gICAgICAgIHJlc3VsdHMucHVzaChbbmFtZSwgb2ssIGRldGFpbF0pO1xyXG4gICAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgICByZXN1bHRzLnB1c2goW25hbWUsIGZhbHNlLCBTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApXSk7XHJcbiAgICAgIH1cclxuICAgIH07XHJcbiAgICBjb25zdCBqcyA9IChjb2RlOiBzdHJpbmcpOiBQcm9taXNlPHVua25vd24+ID0+IHdpbi53ZWJDb250ZW50cy5leGVjdXRlSmF2YVNjcmlwdChjb2RlLCB0cnVlKTtcclxuXHJcbiAgICBhd2FpdCBjaGVjaygncmVuZGVyZXIgXHU2NUUwXHU1M0VGXHU3NTI4XHU3Njg0IHByb2Nlc3MvcmVxdWlyZShzYW5kYm94IFx1NzUxRlx1NjU0OCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoYChmdW5jdGlvbigpe1xyXG4gICAgICAgIHZhciB0ID0gZnVuY3Rpb24oZil7IHRyeSB7IHZhciB2ID0gZigpOyByZXR1cm4gKHYgPT09IHVuZGVmaW5lZCB8fCB2ID09PSBudWxsKSA/ICd1bmF2YWlsYWJsZScgOiB0eXBlb2YgdjsgfSBjYXRjaChlKXsgcmV0dXJuICdibG9ja2VkJzsgfSB9O1xyXG4gICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeShbdChmdW5jdGlvbigpe3JldHVybiBwcm9jZXNzfSksIHQoZnVuY3Rpb24oKXtyZXR1cm4gcmVxdWlyZX0pLCB0KGZ1bmN0aW9uKCl7cmV0dXJuIGdsb2JhbFRoaXMucHJvY2Vzc30pXSk7XHJcbiAgICAgIH0pKClgKSkgYXMgc3RyaW5nO1xyXG4gICAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHIpIGFzIHN0cmluZ1tdO1xyXG4gICAgICBjb25zdCBwID0gcGFyc2VkWzBdID8/ICd1bmtub3duJztcclxuICAgICAgY29uc3QgcmVxID0gcGFyc2VkWzFdID8/ICd1bmtub3duJztcclxuICAgICAgY29uc3Qgc2FmZSA9ICh2OiBzdHJpbmcpOiBib29sZWFuID0+IHYgPT09ICd1bmF2YWlsYWJsZScgfHwgdiA9PT0gJ2Jsb2NrZWQnO1xyXG4gICAgICByZXR1cm4gW3NhZmUocCkgJiYgc2FmZShyZXEpLCBgcHJvY2Vzcz0ke3B9IHJlcXVpcmU9JHtyZXF9YF07XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IGNoZWNrKCd3aW5kb3cuaG1oIFx1NTNFQVx1NjcwOVx1NzY3RFx1NTQwRFx1NTM1NVx1NjVCOVx1NkNENShcdTY1RTAgaXBjUmVuZGVyZXIvXHU5ODlEXHU1OTE2XHU5NzYyKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgciA9IChhd2FpdCBqcygnT2JqZWN0LmtleXMod2luZG93LmhtaCB8fCB7fSkuc29ydCgpLmpvaW4oXCIsXCIpJykpIGFzIHN0cmluZztcclxuICAgICAgY29uc3QgYWxsb3cgPSBbJ2FwcGx5VXBkYXRlJywgJ2FwcHJvdmUnLCAnYXBwcm92YWxHZXQnLCAnYXBwcm92YWxTZXQnLCAnYnJvd3NlUnVudGltZScsICdjaGVja1VwZGF0ZScsICdjaHJvbWVUaGVtZScsICdjb2duaXRpdmUnLCAnZGV0ZWN0UnVudGltZScsICdkaWZmJywgJ2V4cG9ydFNlc3Npb24nLCAnZnNMaXN0JywgJ2ZzUmVhZCcsICdmc1NlYXJjaCcsICdnZXRTdGF0ZScsICdnZXRXaXphcmQnLCAnaW5qZWN0JywgJ2luc3RhbGxDbGknLCAnaW50ZXJydXB0JywgJ21vZGVsU2V0JywgJ29uRXZlbnRCYXRjaGVzJywgJ29uSG9zdFN0YXRlJywgJ29uSW5zdGFsbFByb2dyZXNzJywgJ29uTWVudUFjdGlvbicsICdvblN0cmVhbUNodW5rcycsICdvblVwZGF0ZVN0YXRlJywgJ3BpY2tEaXJlY3RvcnknLCAncGlja0ZpbGVzJywgJ3BvcHVwTWFpbk1lbnUnLCAncHJvdmlkZXJTYXZlJywgJ3Byb3ZpZGVycycsICdyZW1vdGVXZWJBdXRvc3RhcnQnLCAncmVtb3RlV2ViU3RhcnQnLCAncmVtb3RlV2ViU3RhdHVzJywgJ3JlbW90ZVdlYlN0b3AnLCAncnVudGltZUluZm8nLCAnc2VuZFRhc2snLCAnc2Vzc2lvbk9wJywgJ3Nlc3Npb25QcmV2aWV3JywgJ3Nlc3Npb25zJywgJ3NldFJ1bnRpbWUnLCAnc3RvcEhvc3QnLCAnd2l6YXJkQ29tcGxldGUnLCAnd29ya3NwYWNlcycsICd3b3Jrc3BhY2VBZGQnLCAnd29ya3NwYWNlVXNlJ107XHJcbiAgICAgIGNvbnN0IGdvdCA9IHIgPT09ICcnID8gW10gOiByLnNwbGl0KCcsJyk7XHJcbiAgICAgIGNvbnN0IHVuZXhwZWN0ZWQgPSBnb3QuZmlsdGVyKChrKSA9PiAhYWxsb3cuaW5jbHVkZXMoaykpO1xyXG4gICAgICByZXR1cm4gW3VuZXhwZWN0ZWQubGVuZ3RoID09PSAwLCBga2V5cz0ke3J9YF07XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IGNoZWNrKCdcdTU5MTZcdTkwRThcdTVCRkNcdTgyMkFcdTg4QUJcdTYyRTZcdTYyMkEoVVJMIFx1NEUwRFx1NTNEOCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IGJlZm9yZSA9IHdpbi53ZWJDb250ZW50cy5nZXRVUkwoKTtcclxuICAgICAgYXdhaXQganMoJ2xvY2F0aW9uLmhyZWYgPSBcImh0dHBzOi8vZXhhbXBsZS5pbnZhbGlkL3hcIjsgXCJub29wXCInKS5jYXRjaCgoKSA9PiAnbm9vcCcpO1xyXG4gICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocjIpID0+IHNldFRpbWVvdXQocjIsIDFfMjAwKSk7XHJcbiAgICAgIGNvbnN0IGFmdGVyID0gd2luLndlYkNvbnRlbnRzLmdldFVSTCgpO1xyXG4gICAgICByZXR1cm4gW2FmdGVyID09PSBiZWZvcmUsIGAke2JlZm9yZX0gXHUyMTkyICR7YWZ0ZXJ9YF07XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IGNoZWNrKCd3aW5kb3cub3BlbiBcdTg4QUJcdTYyRDJcdTdFREQoXHU4RkQ0XHU1NkRFIG51bGwgXHU0RTE0XHU2NUUwXHU2NUIwXHU3QTk3XHU1M0UzKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgYmVmb3JlID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkubGVuZ3RoO1xyXG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKCdTdHJpbmcod2luZG93Lm9wZW4oXCJodHRwczovL2V4YW1wbGUuaW52YWxpZFwiKSknKSkgYXMgc3RyaW5nO1xyXG4gICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocjIpID0+IHNldFRpbWVvdXQocjIsIDQwMCkpO1xyXG4gICAgICBjb25zdCBhZnRlciA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmxlbmd0aDtcclxuICAgICAgcmV0dXJuIFtyID09PSAnbnVsbCcgJiYgYWZ0ZXIgPT09IGJlZm9yZSwgYG9wZW4oKT0ke3J9IHdpbmRvd3M9JHtiZWZvcmV9XHUyMTkyJHthZnRlcn1gXTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgY2hlY2soJ0NTUCBcdTVCNThcdTU3MjgobWV0YSBcdTZDRThcdTUxNjVcdTYyMTZcdTU0Q0RcdTVFOTRcdTU5MzQpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCBtZXRhID0gKGF3YWl0IGpzKCdCb29sZWFuKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoXCJtZXRhW2h0dHAtZXF1aXY9XFwnQ29udGVudC1TZWN1cml0eS1Qb2xpY3lcXCddXCIpKScpKSBhcyBib29sZWFuO1xyXG4gICAgICBjb25zdCBoZWFkZXJDc3AgPSBpc0RldiA/ICdkZXY6IGhlYWRlciBDU1AgXHU3NTMxIG9uSGVhZGVyc1JlY2VpdmVkIFx1NkNFOFx1NTE2NShcdTRFMERcdTkwMDJcdTc1MjggbWV0YSBcdTY1QURcdThBMDApJyA6ICdwcm9kJztcclxuICAgICAgcmV0dXJuIFttZXRhIHx8IGlzRGV2LCBgbWV0YT0ke21ldGF9ICR7aGVhZGVyQ3NwfWBdO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBjaGVjaygnYnJpZGdlOmdldC1zdGF0ZSBcdTZCNjNcdTVFMzhcdThGRDRcdTU2REUoaG9zdCBcdTY4NjVcdTUzRUZcdTc1MjgpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKCd3aW5kb3cuaG1oLmdldFN0YXRlKCkudGhlbihzID0+IEpTT04uc3RyaW5naWZ5KHMpKS5jYXRjaChlID0+IFwiRVJSOlwiK2UpJykpIGFzIHN0cmluZztcclxuICAgICAgcmV0dXJuIFtyLnN0YXJ0c1dpdGgoJ3snKSAmJiByLmluY2x1ZGVzKCdob3N0U3RhdGUnKSwgci5zbGljZSgwLCA4MCldO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBjaGVjaygnWFNTOlx1NjA3Nlx1NjEwRlx1NEVGQlx1NTJBMVx1NjU4N1x1NjcyQ1x1NTNFQVx1NEVFNVx1NjU4N1x1NjcyQ1x1NkUzMlx1NjdEMyhcdTRFMERcdTYyNjdcdTg4NEMpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCBwYXlsb2FkID0gJzxpbWcgc3JjPXggb25lcnJvcj1cIndpbmRvdy5fX3hzcz0xXCI+PHNjcmlwdD53aW5kb3cuX194c3M9MjxcXC9zY3JpcHQ+XCImXFwnJztcclxuICAgICAgY29uc3Qgc2VuZFIgPSAoYXdhaXQganMoYHdpbmRvdy5obWguc2VuZFRhc2soJHtKU09OLnN0cmluZ2lmeShwYXlsb2FkKX0sICdzZWMteHNzLTEnLCAnYXV0bycpLnRoZW4ocj0+SlNPTi5zdHJpbmdpZnkocikpLmNhdGNoKGU9PidFUlI6JytlKWApKSBhcyBzdHJpbmc7XHJcbiAgICAgIGlmICghc2VuZFIuaW5jbHVkZXMoJ1wib2tcIjp0cnVlJykpIHJldHVybiBbZmFsc2UsIGBzZW5kVGFzayBcdTY3MkFcdTUzRDdcdTc0MDY6ICR7c2VuZFIuc2xpY2UoMCwgODApfWBdO1xyXG4gICAgICAvLyBmYWtlIGhvc3QgZWNobyBcdTU2REVcdTY3NjVcdTU0MEVcdTdFQ0YgUmVhY3QgXHU2RTMyXHU2N0QzKFx1NzUyOFx1NjIzN1x1NkQ4OFx1NjA2RiArIFx1NTJBOVx1NjI0QiBlY2hvIFx1NTNDQ1x1OERFRlx1NUY4NClcclxuICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHIyKSA9PiBzZXRUaW1lb3V0KHIyLCAzXzAwMCkpO1xyXG4gICAgICBjb25zdCBwcm9iZSA9IChhd2FpdCBqcyhgSlNPTi5zdHJpbmdpZnkoe1xyXG4gICAgICAgIHhzc0ZsYWc6IHR5cGVvZiB3aW5kb3cuX194c3MsXHJcbiAgICAgICAgaW1nQ291bnQ6IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ2ltZ1tzcmM9XCJ4XCJdJykubGVuZ3RoLFxyXG4gICAgICAgIHNjcmlwdFJhbjogZG9jdW1lbnQuYm9keS5pbm5lclRleHQuaW5kZXhPZignd2luZG93Ll9feHNzPTInKSA+PSAwXHJcbiAgICAgIH0pYCkpIGFzIHN0cmluZztcclxuICAgICAgY29uc3QgcCA9IEpTT04ucGFyc2UocHJvYmUpIGFzIHsgeHNzRmxhZzogc3RyaW5nOyBpbWdDb3VudDogbnVtYmVyOyBzY3JpcHRSYW46IGJvb2xlYW4gfTtcclxuICAgICAgcmV0dXJuIFtwLnhzc0ZsYWcgPT09ICd1bmRlZmluZWQnICYmIHAuaW1nQ291bnQgPT09IDAsIGB4c3NGbGFnPSR7cC54c3NGbGFnfSBpbWc9JHtwLmltZ0NvdW50fWBdO1xyXG4gICAgfSk7XHJcblxyXG4gICAgbGV0IGZhaWxlZCA9IDA7XHJcbiAgICBmb3IgKGNvbnN0IFtuYW1lLCBvaywgZGV0YWlsXSBvZiByZXN1bHRzKSB7XHJcbiAgICAgIGNvbnNvbGUubG9nKGBTRUNVUklUWS1URVNUICR7b2sgPyAnUEFTUycgOiAnRkFJTCd9IHwgJHtuYW1lfSB8ICR7cmVkYWN0KGRldGFpbCl9YCk7XHJcbiAgICAgIGlmICghb2spIGZhaWxlZCArPSAxO1xyXG4gICAgfVxyXG4gICAgY29uc29sZS5sb2coYFNFQ1VSSVRZLVRFU1QgU1VNTUFSWSBwYXNzPSR7cmVzdWx0cy5sZW5ndGggLSBmYWlsZWR9LyR7cmVzdWx0cy5sZW5ndGh9YCk7XHJcbiAgICBhcHAuZXhpdChmYWlsZWQgPT09IDAgPyAwIDogMSk7XHJcbiAgfVxyXG5cclxuICAvLyBcdTkwMDBcdTUxRkE6XHU0RjE4XHU5NkM1XHU1MDVDXHU2QjYyXHU4MUVBXHU1REYxIHNwYXduIFx1NzY4NCBob3N0KHNodXRkb3duIFx1N0FFRlx1NzBCOSBcdTIxOTIgXHU1MTVDXHU1RTk1XHU1M0VBIGtpbGwgXHU4MUVBXHU1REYxXHU3Njg0XHU1M0U1XHU2N0M0KVxyXG4gIGFwcC5vbignYmVmb3JlLXF1aXQnLCAoZSkgPT4ge1xyXG4gICAgaWYgKHN1cGVydmlzb3IgIT09IG51bGwgJiYgc3VwZXJ2aXNvci5zdGF0ZSAhPT0gJ3N0b3BwZWQnKSB7XHJcbiAgICAgIGUucHJldmVudERlZmF1bHQoKTtcclxuICAgICAgc3NlQWJvcnQ/LmFib3J0KCk7XHJcbiAgICAgIHZvaWQgc3VwZXJ2aXNvci5zdG9wKCkuZmluYWxseSgoKSA9PiBhcHAucXVpdCgpKTtcclxuICAgIH1cclxuICB9KTtcclxuICBhcHAub24oJ3dpbmRvdy1hbGwtY2xvc2VkJywgKCkgPT4ge1xyXG4gICAgaWYgKHByb2Nlc3MucGxhdGZvcm0gIT09ICdkYXJ3aW4nKSBhcHAucXVpdCgpO1xyXG4gIH0pO1xyXG59XHJcbiIsICIvKipcbiAqIERlc2t0b3BSdW50aW1lU3VwZXJ2aXNvciBcdTIwMTQgaG1oYXJuZXNzIGhvc3QgXHU4RkRCXHU3QTBCXHU3Njg0XHU3NTFGXHU1NDdEXHU1NDY4XHU2NzFGXHU3MkI2XHU2MDAxXHU2NzNBKEFEUi0wMDMpXHUzMDAyXG4gKlxuICogXHU1Qjg5XHU1MTY4XHU0RTBEXHU1M0Q4XHU5MUNGOlxuICogIC0gXHU1M0VBXHU3RUQxXHU1QjlBL1x1NjNBMlx1NkQ0QiAxMjcuMC4wLjE7aG9zdCBcdTRGN0ZcdTc1MjhcdTY0Q0RcdTRGNUNcdTdDRkJcdTdFREZcdTUyMDZcdTkxNERcdTdBRUZcdTUzRTMocG9ydCAwKSxcdTVCOUVcdTk2NDVcdTdBRUZcdTUzRTNcbiAqICAgIFx1NzUzMSBob3N0IFx1NzY4NCBzdGRvdXQgXHU1RjE1XHU1QkZDXHU4ODRDXHU1NkRFXHU0RjIwKEhvc3RSZWFkeUxpbmUpXHUzMDAyXG4gKiAgLSBcdTlBRDhcdTcxQjUgdG9rZW4gXHU1M0VBXHU5MDFBXHU4RkM3XHU1QjUwXHU4RkRCXHU3QTBCXHU3M0FGXHU1ODgzXHU1M0Q4XHU5MUNGXHU0RjIwXHU5MDEyLFx1N0VERFx1NEUwRFx1OEZEQiBVUkwvXHU2NUU1XHU1RkQ3L0lQQyBcdTY2MEVcdTY1ODdcdThEMUZcdThGN0RcdTMwMDJcbiAqICAtIFx1NTNFQVx1NTA1Q1x1NkI2Mlx1NjcyQyBzdXBlcnZpc29yIHNwYXduIFx1NzY4NFx1OEZEQlx1N0EwQlx1NTNFNVx1NjdDNDtcdTdFRERcdTRFMERcdTYzMDlcdThGREJcdTdBMEJcdTU0MEQga2lsbFx1MzAwMlxuICogIC0gaG9zdCBjcmFzaCBcdTU0MEVcdTY3MDlcdTk2NTBcdTkxQ0RcdTU0MkY7XHU5MUNEXHU1NDJGXHU0RTBEXHU5MUNEXHU2NTNFXHU0RUZCXHU0RjU1XHU3NTI4XHU2MjM3XHU1MkE4XHU0RjVDKFx1OTc1RVx1NUU0Mlx1N0I0OVx1NTJBOFx1NEY1Q1x1NzUzMVx1NzUyOFx1NjIzN1x1Nzg2RVx1OEJBNClcdTMwMDJcbiAqL1xuaW1wb3J0IHsgc3Bhd24sIHR5cGUgQ2hpbGRQcm9jZXNzIH0gZnJvbSAnbm9kZTpjaGlsZF9wcm9jZXNzJztcbmltcG9ydCB7IGNyZWF0ZUludGVyZmFjZSB9IGZyb20gJ25vZGU6cmVhZGxpbmUnO1xuaW1wb3J0IHsgcmFuZG9tQnl0ZXMgfSBmcm9tICdub2RlOmNyeXB0byc7XG5pbXBvcnQgeyBkZXNrdG9wRXJyb3IsIGlzRGVza3RvcEVycm9yLCB0eXBlIERlc2t0b3BFcnJvciB9IGZyb20gJ0BobWgtZGVza3RvcC9jb250cmFjdHMnO1xuXG5leHBvcnQgdHlwZSBIb3N0U3RhdGUgPVxuICB8ICdzdG9wcGVkJ1xuICB8ICdzdGFydGluZydcbiAgfCAncmVhZHknXG4gIHwgJ2Rpc2Nvbm5lY3RlZCdcbiAgfCAncmVzdGFydGluZydcbiAgfCAnc3RvcHBpbmcnXG4gIHwgJ2ZhaWxlZCc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgSG9zdFNwZWMge1xuICAvKiogXHU1M0VGXHU2MjY3XHU4ODRDXHU2NTg3XHU0RUY2KFx1OTAxQVx1NUUzOCBwcm9jZXNzLmV4ZWNQYXRoKVx1MzAwMiAqL1xuICBjb21tYW5kOiBzdHJpbmc7XG4gIGFyZ3M6IHN0cmluZ1tdO1xuICBjd2Q/OiBzdHJpbmc7XG4gIC8qKiBcdTk4OURcdTU5MTZcdTczQUZcdTU4ODNcdTUzRDhcdTkxQ0YoXHU0RjFBXHU0RTBFIHByb2Nlc3MuZW52IFx1NTQwOFx1NUU3NilcdTMwMDIgKi9cbiAgZW52PzogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBTdXBlcnZpc29yT3B0aW9ucyB7XG4gIC8qKiBcdTY3MUZcdTY3MUIgaG9zdCBcdTY4MjFcdTlBOENcdTc2ODQgYmVhcmVyIHRva2VuO1x1NEUwRFx1NEYyMFx1NTIxOVx1NkJDRlx1NkIyMSBzdGFydCBcdTc1MUZcdTYyMTBcdTlBRDhcdTcxQjVcdTk2OEZcdTY3M0FcdTUwM0NcdTMwMDIgKi9cbiAgdG9rZW4/OiBzdHJpbmc7XG4gIG1heFJlc3RhcnRzPzogbnVtYmVyO1xuICBzdGFydFRpbWVvdXRNcz86IG51bWJlcjtcbiAgZ3JhY2VmdWxTaHV0ZG93bk1zPzogbnVtYmVyO1xuICBvblN0YXRlQ2hhbmdlPyhzdGF0ZTogSG9zdFN0YXRlLCBpbmZvOiB7IHJlc3RhcnRDb3VudDogbnVtYmVyOyBsYXN0RXJyb3I/OiBzdHJpbmcgfSk6IHZvaWQ7XG4gIC8qKiBcdTZCQ0ZcdTZCMjEgaG9zdCBcdTVDMzFcdTdFRUEoXHU1NDJCIGNyYXNoIFx1ODFFQVx1NjEwOFx1NTQwRVx1NzY4NFx1OTFDRFx1NTQyRilcdTkwRkRcdTRGMUFcdTg5RTZcdTUzRDEsXHU2NDNBXHU1RTI2XHU3QUVGXHU3MEI5KFx1NTQyQiB0b2tlbixcbiAgICogIFx1NEVDNVx1NEY5Qlx1NTQwQ1x1NEZFMVx1NEVGQlx1NTdERlx1NzY4NFx1NUJCRlx1NEUzQlx1OEZEQlx1N0EwQlx1OTFDRFx1NUVGQVx1Njg2NVx1NUJBMlx1NjIzN1x1N0FFRjtcdTRFMERcdTg5ODFcdThERThcdThGREIgcmVuZGVyZXIpXHUzMDAyICovXG4gIG9uUmVhZHk/KGVuZHBvaW50OiBIb3N0RW5kcG9pbnQpOiB2b2lkO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEhvc3RFbmRwb2ludCB7XG4gIHBvcnQ6IG51bWJlcjtcbiAgdmVyc2lvbjogc3RyaW5nO1xuICB0b2tlbjogc3RyaW5nO1xufVxuXG4vKiogSG9zdFJlYWR5TGluZSBcdTc2ODRcdTdDN0JcdTU3OEJcdTVCODhcdTUzNkJcdTRFQ0UgY29udHJhY3RzIFx1NUYxNVx1NTE2NSxcdTkwN0ZcdTUxNERcdTUzQ0NcdTVCOUVcdTczQjBcdTMwMDIgKi9cbmltcG9ydCB7IGlzSG9zdFJlYWR5TGluZSB9IGZyb20gJ0BobWgtZGVza3RvcC9jb250cmFjdHMnO1xuXG4vLyA0NXM6aG1oYXJuZXNzIFx1NzcxRlx1NUI5RVx1NTE2NVx1NTNFM1x1N0VDRiB0c3ggXHU1MUI3XHU3RjE2XHU4QkQxXHU2NTc0XHU1OTU3IENMSSxcdTY3M0FcdTU2NjhcdTlBRDhcdThEMUZcdThGN0RcdTY1RjZcdTUzRUZcdThEODUgMjBzXG4vLyAoMjAyNi0xMC0xMSBcdThGREVcdTdFRURcdTlBOENcdTY1MzZcdTRFMkRcdTk1RjRcdTZCNDdcdTYwMjcgSE9TVF9OT1RfUkVBRFkgXHU3Njg0XHU2ODM5XHU1NkUwO1x1N0E3QVx1OTVGMlx1NUI5RVx1NkQ0QiA2cylcdTMwMDJcbmNvbnN0IERFRkFVTFRfU1RBUlRfVElNRU9VVF9NUyA9IDQ1XzAwMDtcbmNvbnN0IERFRkFVTFRfTUFYX1JFU1RBUlRTID0gMztcbmNvbnN0IERFRkFVTFRfR1JBQ0VGVUxfTVMgPSA1XzAwMDtcblxuZXhwb3J0IGNsYXNzIERlc2t0b3BSdW50aW1lU3VwZXJ2aXNvciB7XG4gIHByaXZhdGUgY2hpbGQ6IENoaWxkUHJvY2VzcyB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIF9zdGF0ZTogSG9zdFN0YXRlID0gJ3N0b3BwZWQnO1xuICBwcml2YXRlIHJlc3RhcnRDb3VudCA9IDA7XG4gIHByaXZhdGUgbGFzdEVycm9yID0gJyc7XG4gIHByaXZhdGUgc3RvcHBpbmcgPSBmYWxzZTtcbiAgcHJpdmF0ZSByZWFkb25seSB0b2tlbjogc3RyaW5nO1xuICBwcml2YXRlIHJlYWRvbmx5IG9wdHM6IFJlcXVpcmVkPFBpY2s8U3VwZXJ2aXNvck9wdGlvbnMsICdtYXhSZXN0YXJ0cycgfCAnc3RhcnRUaW1lb3V0TXMnIHwgJ2dyYWNlZnVsU2h1dGRvd25Ncyc+PiAmIFN1cGVydmlzb3JPcHRpb25zO1xuICBwcml2YXRlIGV4aXRXYWl0ZXJzOiBBcnJheTwoKSA9PiB2b2lkPiA9IFtdO1xuXG4gIGNvbnN0cnVjdG9yKFxuICAgIHByaXZhdGUgcmVhZG9ubHkgc3BlYzogSG9zdFNwZWMsXG4gICAgb3B0czogU3VwZXJ2aXNvck9wdGlvbnMgPSB7fSxcbiAgKSB7XG4gICAgdGhpcy50b2tlbiA9IG9wdHMudG9rZW4gPz8gcmFuZG9tQnl0ZXMoMzIpLnRvU3RyaW5nKCdiYXNlNjR1cmwnKTtcbiAgICB0aGlzLm9wdHMgPSB7XG4gICAgICBtYXhSZXN0YXJ0czogb3B0cy5tYXhSZXN0YXJ0cyA/PyBERUZBVUxUX01BWF9SRVNUQVJUUyxcbiAgICAgIHN0YXJ0VGltZW91dE1zOiBvcHRzLnN0YXJ0VGltZW91dE1zID8/IERFRkFVTFRfU1RBUlRfVElNRU9VVF9NUyxcbiAgICAgIGdyYWNlZnVsU2h1dGRvd25Nczogb3B0cy5ncmFjZWZ1bFNodXRkb3duTXMgPz8gREVGQVVMVF9HUkFDRUZVTF9NUyxcbiAgICAgIC4uLm9wdHMsXG4gICAgfTtcbiAgfVxuXG4gIGdldCBzdGF0ZSgpOiBIb3N0U3RhdGUge1xuICAgIHJldHVybiB0aGlzLl9zdGF0ZTtcbiAgfVxuXG4gIGdldCByZXN0YXJ0c1VzZWQoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gdGhpcy5yZXN0YXJ0Q291bnQ7XG4gIH1cblxuICBwcml2YXRlIHNldFN0YXRlKHM6IEhvc3RTdGF0ZSwgZXJyPzogc3RyaW5nKTogdm9pZCB7XG4gICAgdGhpcy5fc3RhdGUgPSBzO1xuICAgIGlmIChlcnIgIT09IHVuZGVmaW5lZCkgdGhpcy5sYXN0RXJyb3IgPSBlcnI7XG4gICAgY29uc3QgaW5mbzogeyByZXN0YXJ0Q291bnQ6IG51bWJlcjsgbGFzdEVycm9yPzogc3RyaW5nIH0gPSB7IHJlc3RhcnRDb3VudDogdGhpcy5yZXN0YXJ0Q291bnQgfTtcbiAgICBpZiAodGhpcy5sYXN0RXJyb3IgIT09ICcnKSBpbmZvLmxhc3RFcnJvciA9IHRoaXMubGFzdEVycm9yO1xuICAgIHRoaXMub3B0cy5vblN0YXRlQ2hhbmdlPy4ocywgaW5mbyk7XG4gIH1cblxuICAvKiogXHU1NDJGXHU1MkE4IGhvc3QgXHU1RTc2XHU3QjQ5XHU1Rjg1IHJlYWR5KFx1NUYxNVx1NUJGQ1x1ODg0QyArIFx1NUUyNiB0b2tlbiBcdTc2ODRcdTUwNjVcdTVFQjdcdTYzQTJcdTZENEIpXHUzMDAyICovXG4gIGFzeW5jIHN0YXJ0KCk6IFByb21pc2U8SG9zdEVuZHBvaW50PiB7XG4gICAgaWYgKHRoaXMuX3N0YXRlID09PSAncmVhZHknIHx8IHRoaXMuX3N0YXRlID09PSAnc3RhcnRpbmcnKSB7XG4gICAgICB0aHJvdyBkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYHN1cGVydmlzb3IgYWxyZWFkeSAke3RoaXMuX3N0YXRlfWApO1xuICAgIH1cbiAgICB0aGlzLnJlc3RhcnRDb3VudCA9IDA7XG4gICAgdGhpcy5zdG9wcGluZyA9IGZhbHNlO1xuICAgIHJldHVybiB0aGlzLmxhdW5jaCgpO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBsYXVuY2goKTogUHJvbWlzZTxIb3N0RW5kcG9pbnQ+IHtcbiAgICB0aGlzLnNldFN0YXRlKCdzdGFydGluZycpO1xuICAgIGNvbnN0IGNoaWxkID0gc3Bhd24odGhpcy5zcGVjLmNvbW1hbmQsIHRoaXMuc3BlYy5hcmdzLCB7XG4gICAgICBjd2Q6IHRoaXMuc3BlYy5jd2QsXG4gICAgICBlbnY6IHtcbiAgICAgICAgLi4ucHJvY2Vzcy5lbnYsXG4gICAgICAgIC4uLnRoaXMuc3BlYy5lbnYsXG4gICAgICAgIEhNSF9ERVNLVE9QX1RPS0VOOiB0aGlzLnRva2VuLFxuICAgICAgfSxcbiAgICAgIHN0ZGlvOiBbJ2lnbm9yZScsICdwaXBlJywgJ3BpcGUnXSxcbiAgICAgIHdpbmRvd3NIaWRlOiB0cnVlLFxuICAgIH0pO1xuICAgIHRoaXMuY2hpbGQgPSBjaGlsZDtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCBlbmRwb2ludCA9IGF3YWl0IHRoaXMuYXdhaXRSZWFkeShjaGlsZCk7XG4gICAgICB0aGlzLmN1cnJlbnRFbmRwb2ludCA9IHsgcG9ydDogZW5kcG9pbnQucG9ydCwgdmVyc2lvbjogZW5kcG9pbnQudmVyc2lvbiB9O1xuICAgICAgdGhpcy5zZXRTdGF0ZSgncmVhZHknKTtcbiAgICAgIHRoaXMub3B0cy5vblJlYWR5Py4oZW5kcG9pbnQpO1xuICAgICAgLy8gcmVhZHkgXHU0RTRCXHU1NDBFXHU4RkRCXHU3QTBCXHU2QjdCXHU0RUExID0gXHU2MTBGXHU1OTE2XHU5MDAwXHU1MUZBIFx1MjE5MiBcdTY3MDlcdTk2NTBcdTkxQ0RcdTU0MkZcbiAgICAgIGNoaWxkLm9uY2UoJ2V4aXQnLCAoKSA9PiB7XG4gICAgICAgIHRoaXMuZXhpdFdhaXRlcnMuZm9yRWFjaCgodykgPT4gdygpKTtcbiAgICAgICAgdGhpcy5leGl0V2FpdGVycyA9IFtdO1xuICAgICAgICB0aGlzLm9uVW5leHBlY3RlZEV4aXQoKTtcbiAgICAgIH0pO1xuICAgICAgcmV0dXJuIGVuZHBvaW50O1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgaWYgKCFjaGlsZC5raWxsZWQpIGNoaWxkLmtpbGwoKTtcbiAgICAgIGlmICh0aGlzLmNoaWxkID09PSBjaGlsZCkgdGhpcy5jaGlsZCA9IG51bGw7XG4gICAgICB0aHJvdyBlcnI7XG4gICAgfVxuICB9XG5cbiAgLyoqIFx1NEVDRSBzdGRvdXQgXHU2MjdFIEhvc3RSZWFkeUxpbmUsXHU3MTM2XHU1NDBFXHU1MDY1XHU1RUI3XHU2M0EyXHU2RDRCXHUzMDAyICovXG4gIHByaXZhdGUgYXdhaXRSZWFkeShjaGlsZDogQ2hpbGRQcm9jZXNzKTogUHJvbWlzZTxIb3N0RW5kcG9pbnQ+IHtcbiAgICByZXR1cm4gbmV3IFByb21pc2U8SG9zdEVuZHBvaW50PigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICByZWplY3QoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBob3N0IGRpZCBub3Qgc2lnbmFsIHJlYWR5IHdpdGhpbiAke3RoaXMub3B0cy5zdGFydFRpbWVvdXRNc31tc2AsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgICAgfSwgdGhpcy5vcHRzLnN0YXJ0VGltZW91dE1zKTtcblxuICAgICAgY29uc3QgZG9uZSA9IChmbjogKCkgPT4gdm9pZCk6IHZvaWQgPT4ge1xuICAgICAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgICAgICBmbigpO1xuICAgICAgfTtcblxuICAgICAgaWYgKCFjaGlsZC5zdGRvdXQpIHtcbiAgICAgICAgZG9uZSgoKSA9PiByZWplY3QoZGVza3RvcEVycm9yKCdSVU5USU1FX0NSQVNIRUQnLCAnaG9zdCBzcGF3bmVkIHdpdGhvdXQgc3Rkb3V0IHBpcGUnKSkpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHJsID0gY3JlYXRlSW50ZXJmYWNlKHsgaW5wdXQ6IGNoaWxkLnN0ZG91dCB9KTtcbiAgICAgIGNvbnN0IG9uTGluZSA9IChsaW5lOiBzdHJpbmcpOiB2b2lkID0+IHtcbiAgICAgICAgbGV0IHBhcnNlZDogdW5rbm93bjtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBwYXJzZWQgPSBKU09OLnBhcnNlKGxpbmUpO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICByZXR1cm47IC8vIGhvc3QgXHU3Njg0XHU2NjZFXHU5MDFBXHU2NUU1XHU1RkQ3XHU4ODRDLFx1NUZGRFx1NzU2NVxuICAgICAgICB9XG4gICAgICAgIGlmIChpc0hvc3RSZWFkeUxpbmUocGFyc2VkKSkge1xuICAgICAgICAgIHJsLmNsb3NlKCk7XG4gICAgICAgICAgdm9pZCB0aGlzLnByb2JlQW5kUmVtZW1iZXIocGFyc2VkLnBvcnQsIHBhcnNlZC52ZXJzaW9uKVxuICAgICAgICAgICAgLnRoZW4oKGVuZHBvaW50KSA9PiBkb25lKCgpID0+IHJlc29sdmUoZW5kcG9pbnQpKSlcbiAgICAgICAgICAgIC5jYXRjaCgoZXJyOiB1bmtub3duKSA9PiBkb25lKCgpID0+IHJlamVjdChlcnIpKSk7XG4gICAgICAgIH1cbiAgICAgIH07XG4gICAgICBybC5vbignbGluZScsIG9uTGluZSk7XG5cbiAgICAgIGNoaWxkLm9uY2UoJ2V4aXQnLCAoY29kZSkgPT4ge1xuICAgICAgICBkb25lKCgpID0+IHJlamVjdChkZXNrdG9wRXJyb3IoJ1JVTlRJTUVfQ1JBU0hFRCcsIGBob3N0IGV4aXRlZCBkdXJpbmcgc3RhcnR1cCAoY29kZSAke2NvZGUgPz8gJ251bGwnfSlgLCB7IHJldHJ5YWJsZTogZmFsc2UsIHJlY292ZXJ5QWN0aW9uOiAnT1BFTl9MT0dTJyB9KSkpO1xuICAgICAgfSk7XG4gICAgfSk7XG4gIH1cblxuICAvKiogXHU1RTI2IHRva2VuIFx1NzY4NFx1NTA2NVx1NUVCN1x1NjNBMlx1NkQ0QjpHRVQgL2FwaS9zdGF0ZVx1MzAwMjQwMSBcdTIxOTIgQVVUSF9GQUlMRUQoXHU0RTBEXHU5MUNEXHU4QkQ1KVx1MzAwMiAqL1xuICBwcml2YXRlIGFzeW5jIHByb2JlKHBvcnQ6IG51bWJlciwgdmVyc2lvbjogc3RyaW5nKTogUHJvbWlzZTxIb3N0RW5kcG9pbnQ+IHtcbiAgICBsZXQgcmVzOiBSZXNwb25zZTtcbiAgICB0cnkge1xuICAgICAgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9hcGkvc3RhdGVgLCB7XG4gICAgICAgIGhlYWRlcnM6IHsgJ3gtaG1oLWtleSc6IHRoaXMudG9rZW4gfSxcbiAgICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDNfMDAwKSxcbiAgICAgIH0pO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgdGhyb3cgZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBoZWFsdGggcHJvYmUgZmFpbGVkOiAke1N0cmluZyhlcnIpLnNsaWNlKDAsIDE2MCl9YCwgeyByZXRyeWFibGU6IHRydWUgfSk7XG4gICAgfVxuICAgIGlmIChyZXMuc3RhdHVzID09PSA0MDEgfHwgcmVzLnN0YXR1cyA9PT0gNDAzKSB7XG4gICAgICB0aHJvdyBkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgYGhvc3QgcmVqZWN0ZWQgdGhlIHNlc3Npb24gdG9rZW4gKEhUVFAgJHtyZXMuc3RhdHVzfSlgLCB7IHJldHJ5YWJsZTogZmFsc2UsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KTtcbiAgICB9XG4gICAgaWYgKCFyZXMub2spIHtcbiAgICAgIHRocm93IGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgaGVhbHRoIHByb2JlIEhUVFAgJHtyZXMuc3RhdHVzfWAsIHsgcmV0cnlhYmxlOiB0cnVlIH0pO1xuICAgIH1cbiAgICByZXR1cm4geyBwb3J0LCB2ZXJzaW9uLCB0b2tlbjogdGhpcy50b2tlbiB9O1xuICB9XG5cbiAgcHJpdmF0ZSBvblVuZXhwZWN0ZWRFeGl0KCk6IHZvaWQge1xuICAgIGlmICh0aGlzLnN0b3BwaW5nIHx8IHRoaXMuX3N0YXRlID09PSAnc3RvcHBlZCcgfHwgdGhpcy5fc3RhdGUgPT09ICdzdG9wcGluZycpIHJldHVybjtcbiAgICB0aGlzLmNoaWxkID0gbnVsbDtcbiAgICBpZiAodGhpcy5yZXN0YXJ0Q291bnQgPCB0aGlzLm9wdHMubWF4UmVzdGFydHMpIHtcbiAgICAgIHRoaXMucmVzdGFydENvdW50ICs9IDE7XG4gICAgICB0aGlzLnNldFN0YXRlKCdyZXN0YXJ0aW5nJyk7XG4gICAgICB2b2lkIHRoaXMubGF1bmNoKCkuY2F0Y2goKCkgPT4ge1xuICAgICAgICAvLyBcdTkxQ0RcdTU0MkZcdTVDMURcdThCRDVcdTU5MzFcdThEMjUoXHU1NDJGXHU1MkE4XHU1MzczXHU1RDI5L1x1OEQ4NVx1NjVGNi9cdTYyRDJcdThCQTQpOlx1N0VFN1x1N0VFRFx1NkQ4OFx1ODAxN1x1OTFDRFx1NTQyRlx1NkIyMVx1NjU3MFx1NzZGNFx1NTIzMFx1NjUzRVx1NUYwM1xuICAgICAgICB0aGlzLnJldHJ5T3JGYWlsKCk7XG4gICAgICB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5zZXRTdGF0ZSgnZmFpbGVkJywgYGhvc3QgZXhpdGVkIHVuZXhwZWN0ZWRseSAke3RoaXMucmVzdGFydENvdW50ICsgMX0gdGltZXM7IGdpdmluZyB1cGApO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgcmV0cnlPckZhaWwoKTogdm9pZCB7XG4gICAgaWYgKHRoaXMuc3RvcHBpbmcgfHwgdGhpcy5fc3RhdGUgPT09ICdzdG9wcGVkJyB8fCB0aGlzLl9zdGF0ZSA9PT0gJ3N0b3BwaW5nJykgcmV0dXJuO1xuICAgIGlmICh0aGlzLnJlc3RhcnRDb3VudCA8IHRoaXMub3B0cy5tYXhSZXN0YXJ0cykge1xuICAgICAgdGhpcy5yZXN0YXJ0Q291bnQgKz0gMTtcbiAgICAgIHRoaXMuc2V0U3RhdGUoJ3Jlc3RhcnRpbmcnKTtcbiAgICAgIHZvaWQgdGhpcy5sYXVuY2goKS5jYXRjaCgoKSA9PiB0aGlzLnJldHJ5T3JGYWlsKCkpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLnNldFN0YXRlKCdmYWlsZWQnLCBgaG9zdCBmYWlsZWQgdG8gc3RheSB1cCBhZnRlciAke3RoaXMucmVzdGFydENvdW50fSByZXN0YXJ0IGF0dGVtcHRzYCk7XG4gICAgfVxuICB9XG5cbiAgLyoqIFx1NEYxOFx1OTZDNVx1NTA1Q1x1NkI2MjpcdTUxNDggSFRUUCBzaHV0ZG93bixcdThEODVcdTY1RjZcdTYyNERcdTVCRjlcdTY3MkNcdThGREJcdTdBMEJcdTUzRTVcdTY3QzQga2lsbFx1MzAwMiAqL1xuICBhc3luYyBzdG9wKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIHRoaXMuc3RvcHBpbmcgPSB0cnVlO1xuICAgIGlmICh0aGlzLl9zdGF0ZSA9PT0gJ3N0b3BwZWQnKSByZXR1cm47XG4gICAgdGhpcy5zZXRTdGF0ZSgnc3RvcHBpbmcnKTtcbiAgICBjb25zdCBjaGlsZCA9IHRoaXMuY2hpbGQ7XG4gICAgdGhpcy5jaGlsZCA9IG51bGw7XG4gICAgdGhpcy5jdXJyZW50RW5kcG9pbnQgPSBudWxsO1xuICAgIGlmICghY2hpbGQpIHtcbiAgICAgIHRoaXMuc2V0U3RhdGUoJ3N0b3BwZWQnKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgZXhpdGVkID0gbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUpID0+IHtcbiAgICAgIGlmIChjaGlsZC5leGl0Q29kZSAhPT0gbnVsbCB8fCBjaGlsZC5zaWduYWxDb2RlICE9PSBudWxsKSByZXNvbHZlKCk7XG4gICAgICBlbHNlIHtcbiAgICAgICAgY29uc3QgdyA9ICgpOiB2b2lkID0+IHJlc29sdmUoKTtcbiAgICAgICAgdGhpcy5leGl0V2FpdGVycy5wdXNoKHcpO1xuICAgICAgICBjaGlsZC5vbmNlKCdleGl0Jywgdyk7XG4gICAgICB9XG4gICAgfSk7XG4gICAgLy8gXHU1REYyXHU3N0U1XHU3QUVGXHU1M0UzXHU2MjREXHU1QzFEXHU4QkQ1IEhUVFAgXHU0RjE4XHU5NkM1XHU1MTczXHU5NUVEO1x1NjcyQVx1NzdFNVx1N0FFRlx1NTNFM1x1NzZGNFx1NjNBNVx1OEQ3MCBraWxsIFx1NTE1Q1x1NUU5NVxuICAgIGlmICh0aGlzLmxhc3RFbmRwb2ludCAhPT0gbnVsbCkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHt0aGlzLmxhc3RFbmRwb2ludH0vYXBpL2Rlc2t0b3Avc2h1dGRvd25gLCB7XG4gICAgICAgICAgbWV0aG9kOiAnUE9TVCcsXG4gICAgICAgICAgaGVhZGVyczogeyAneC1obWgta2V5JzogdGhpcy50b2tlbiB9LFxuICAgICAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCgxXzAwMCksXG4gICAgICAgIH0pO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8vIGhvc3QgXHU1REYyXHU2QjdCXHU2MjE2XHU0RTBEXHU1RTk0XHU3QjU0Olx1OEQ3MCBraWxsIFx1NTE1Q1x1NUU5NVxuICAgICAgfVxuICAgIH1cbiAgICBjb25zdCBncmFjZWZ1bCA9IGF3YWl0IFByb21pc2UucmFjZShbXG4gICAgICBleGl0ZWQudGhlbigoKSA9PiB0cnVlKSxcbiAgICAgIG5ldyBQcm9taXNlPGJvb2xlYW4+KChyZXNvbHZlKSA9PiBzZXRUaW1lb3V0KCgpID0+IHJlc29sdmUoZmFsc2UpLCB0aGlzLm9wdHMuZ3JhY2VmdWxTaHV0ZG93bk1zKSksXG4gICAgXSk7XG4gICAgaWYgKCFncmFjZWZ1bCAmJiBjaGlsZC5leGl0Q29kZSA9PT0gbnVsbCAmJiBjaGlsZC5zaWduYWxDb2RlID09PSBudWxsKSB7XG4gICAgICBjaGlsZC5raWxsKCk7IC8vIFx1NTNFQVx1Njc0MFx1ODFFQVx1NURGMVx1NjMwMVx1NjcwOVx1NzY4NFx1NTNFNVx1NjdDNCxcdTdFRERcdTRFMERcdTYzMDlcdThGREJcdTdBMEJcdTU0MERcbiAgICB9XG4gICAgYXdhaXQgZXhpdGVkLmNhdGNoKCgpID0+IHVuZGVmaW5lZCk7XG4gICAgdGhpcy5zZXRTdGF0ZSgnc3RvcHBlZCcpO1xuICB9XG5cbiAgcHJpdmF0ZSBsYXN0RW5kcG9pbnQ6IG51bWJlciB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIGN1cnJlbnRFbmRwb2ludDogeyBwb3J0OiBudW1iZXI7IHZlcnNpb246IHN0cmluZyB9IHwgbnVsbCA9IG51bGw7XG5cbiAgLyoqIFx1NUY1M1x1NTI0RCBob3N0IFx1N0FFRlx1NzBCOShyZWFkeSBcdTU0MEVcdTY3MDlcdTUwM0M7XHU0RTBEXHU1NDJCIHRva2VuKVx1MzAwMiAqL1xuICBnZXQgZW5kcG9pbnQoKTogeyBwb3J0OiBudW1iZXI7IHZlcnNpb246IHN0cmluZyB9IHwgbnVsbCB7XG4gICAgcmV0dXJuIHRoaXMuY3VycmVudEVuZHBvaW50O1xuICB9XG5cbiAgLyoqIFx1NjNBMlx1NkQ0Qlx1NjIxMFx1NTI5Rlx1NTQwRVx1OEJCMFx1NEY0Rlx1N0FFRlx1NTNFMyxcdTRGOUIgc3RvcCgpIFx1NzY4NFx1NEYxOFx1OTZDNVx1NTE3M1x1OTVFRFx1NEY3Rlx1NzUyOFx1MzAwMiAqL1xuICBwcml2YXRlIGFzeW5jIHByb2JlQW5kUmVtZW1iZXIocG9ydDogbnVtYmVyLCB2ZXJzaW9uOiBzdHJpbmcpOiBQcm9taXNlPEhvc3RFbmRwb2ludD4ge1xuICAgIGNvbnN0IGVwID0gYXdhaXQgdGhpcy5wcm9iZShwb3J0LCB2ZXJzaW9uKTtcbiAgICB0aGlzLmxhc3RFbmRwb2ludCA9IGVwLnBvcnQ7XG4gICAgcmV0dXJuIGVwO1xuICB9XG59XG5cbi8qKiBcdTYyOEFcdTY3MkFcdTc3RTVcdTk1MTlcdThCRUZcdTg5QzRcdTdFQTZcdTRFM0EgRGVza3RvcEVycm9yKFx1NURGMlx1NjYyRlx1NTIxOVx1NTM5Rlx1NjgzN1x1OEZENFx1NTZERSlcdTMwMDIgKi9cbmV4cG9ydCBmdW5jdGlvbiB0b0Rlc2t0b3BFcnJvcihlcnI6IHVua25vd24pOiBEZXNrdG9wRXJyb3Ige1xuICBpZiAoaXNEZXNrdG9wRXJyb3IoZXJyKSkgcmV0dXJuIGVycjtcbiAgY29uc3QgbWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgcmV0dXJuIGRlc2t0b3BFcnJvcignUlVOVElNRV9DUkFTSEVEJywgbWVzc2FnZS5zbGljZSgwLCAzMDApLCB7IHJldHJ5YWJsZTogZmFsc2UgfSk7XG59XG4iLCAiLyoqXG4gKiBAaG1oLWRlc2t0b3AvY29udHJhY3RzIFx1MjAxNCBcdTRFOEJcdTRFRjZcdTRGRTFcdTVDMDEoXHU1RjAwXHU1M0QxXHU4QkExXHU1MjEyXHU2NTg3XHU2ODYzIDA0IFx1MDBBN1x1NEUwOSlcbiAqXG4gKiBcdTRFMDBcdTY3NjEgVUkgXHU0RThCXHU0RUY2XHU3Njg0XHU1NTJGXHU0RTAwXHU1RjYyXHU3MkI2XHUzMDAyXHU1MjREXHU3QUVGIHJlZHVjZXIgXHU1RkM1XHU5ODdCXHU2MzA5IHNlc3Npb25JZC9ydW5JZC9zZXEgXHU1OTA0XHU3NDA2O1xuICogXHU5MUNEXHU1OTBEIGV2ZW50SWQgXHU1RTQyXHU3QjQ5XHU0RTIyXHU1RjAzO3NlcSBcdTdGM0FcdTUzRTNcdTg5RTZcdTUzRDFcdTg4NjVcdTYyQzk7XHU5NzVFXHU1RTQyXHU3QjQ5XHU1MkE4XHU0RjVDXHU0RTBEXHU3NTMxIFNTRSBcdTgxRUFcdTUyQThcdTkxQ0RcdTUzRDFcdTMwMDJcbiAqL1xuXG5pbXBvcnQgdHlwZSB7IEFydGlmYWN0UmVmIH0gZnJvbSAnLi9kdG8udHMnO1xuaW1wb3J0IHR5cGUgeyBEZXNrdG9wRXJyb3IgfSBmcm9tICcuL2Vycm9yLnRzJztcblxuLyoqIFx1NEU4Qlx1NEVGNlx1NzlDRFx1N0M3QihcdTUyMjRcdTUyMkJcdTk1MkUpXHUzMDAyXHU2NUIwXHU1ODlFIGtpbmQgPSBzY2hlbWFWZXJzaW9uIFx1NTM0N1x1N0VBNyxcdTRFMERcdTUxNDFcdThCQjhcdTk3NTlcdTlFRDhcdTYyNjlcdTY3OUFcdTRFM0VcdTMwMDIgKi9cbmV4cG9ydCBjb25zdCBFVkVOVF9LSU5EUyA9IFtcbiAgJ3J1bi5zdGFydGVkJyxcbiAgJ3BsYW4udXBkYXRlZCcsXG4gICd0b29sLnN0YXJ0ZWQnLFxuICAndG9vbC5jb21wbGV0ZWQnLFxuICAnYXBwcm92YWwucmVxdWlyZWQnLFxuICAndmVyaWZpY2F0aW9uLnVwZGF0ZWQnLFxuICAnYXJ0aWZhY3QuY3JlYXRlZCcsXG4gICdydW4uY29tcGxldGVkJyxcbiAgJ3J1bi5mYWlsZWQnLFxuXSBhcyBjb25zdDtcblxuZXhwb3J0IHR5cGUgRXZlbnRLaW5kID0gKHR5cGVvZiBFVkVOVF9LSU5EUylbbnVtYmVyXTtcblxuZXhwb3J0IGNvbnN0IEVWRU5UX1NDSEVNQV9WRVJTSU9OID0gMTtcbmV4cG9ydCB0eXBlIEV2ZW50U2NoZW1hVmVyc2lvbiA9IDE7XG5cbi8qKiBTU0UgXHU2RDQxXHU0RTBBXHU3Njg0XHU2QkNGXHU0RTAwXHU2NzYxXHU0RThCXHU0RUY2XHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIEV2ZW50RW52ZWxvcGU8VCA9IHVua25vd24+IHtcbiAgc2NoZW1hVmVyc2lvbjogRXZlbnRTY2hlbWFWZXJzaW9uO1xuICAvKiogXHU1MTY4XHU1QzQwXHU1NTJGXHU0RTAwO1x1OTFDRFx1OEZERS9cdTg4NjVcdTYyQzlcdTU0MEVcdTkxQ0RcdTU5MERcdTUxRkFcdTczQjBcdTY1RjZcdTYzQTVcdTY1MzZcdTY1QjlcdTVFNDJcdTdCNDlcdTRFMjJcdTVGMDNcdTMwMDIgKi9cbiAgZXZlbnRJZDogc3RyaW5nO1xuICBzZXNzaW9uSWQ6IHN0cmluZztcbiAgcnVuSWQ6IHN0cmluZztcbiAgLyoqIFx1NEYxQVx1OEJERFx1NTE4NVx1NTM1NVx1OEMwM1x1OTAxMlx1NTg5RTtcdTdGM0FcdTUzRTNcdTYxMEZcdTU0NzNcdTc3NDBcdTRFMjJcdTRFOEJcdTRFRjYsXHU5NzAwXHU4OTgxXHU4ODY1XHU2MkM5XHUzMDAyICovXG4gIHNlcTogbnVtYmVyO1xuICAvKiogUkZDMzMzOVx1MzAwMiAqL1xuICBvY2N1cnJlZEF0OiBzdHJpbmc7XG4gIGtpbmQ6IEV2ZW50S2luZDtcbiAgcGF5bG9hZDogVDtcbn1cblxuLyoqIHJ1bi5zdGFydGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIFJ1blN0YXJ0ZWRQYXlsb2FkIHtcbiAgdGFzazogc3RyaW5nO1xuICBtb2RlOiAnYXNrJyB8ICdhdXRvJyB8ICd5b2xvJztcbn1cblxuLyoqIHBsYW4udXBkYXRlZCBcdTc2ODQgcGF5bG9hZChcdThCQTFcdTUyMTJcdTZCNjVcdTlBQTRcdTUyMTdcdTg4NjgsXHU2NzY1XHU4MUVBIHJ1bnRpbWUgXHU3Njg0XHU3RUQzXHU2Nzg0XHU1MzE2XHU4QkExXHU1MjEyLFx1NEUwRFx1NjYyRiBjaGFpbi1vZi10aG91Z2h0KVx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBQbGFuVXBkYXRlZFBheWxvYWQge1xuICBzdGVwczogQXJyYXk8eyB0aXRsZTogc3RyaW5nOyBzdGF0dXM6ICdwZW5kaW5nJyB8ICdhY3RpdmUnIHwgJ2RvbmUnIHwgJ2ZhaWxlZCcgfT47XG59XG5cbi8qKiB0b29sLnN0YXJ0ZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgVG9vbFN0YXJ0ZWRQYXlsb2FkIHtcbiAgbmFtZTogc3RyaW5nO1xuICAvKiogXHU1M0MyXHU2NTcwXHU0RUU1XHU2NTg3XHU2NzJDXHU1NDQ4XHU3M0IwLFx1NkUzMlx1NjdEM1x1N0FFRlx1NkMzOFx1NEUwRCBldmFsO1x1NTkyN1x1NUJGOVx1OEM2MVx1NzUzMSBydW50aW1lIFx1NjIyQVx1NjVBRFx1MzAwMiAqL1xuICBhcmdzUHJldmlldzogc3RyaW5nO1xufVxuXG4vKiogdG9vbC5jb21wbGV0ZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgVG9vbENvbXBsZXRlZFBheWxvYWQge1xuICBuYW1lOiBzdHJpbmc7XG4gIGlzRXJyb3I6IGJvb2xlYW47XG4gIG91dHB1dFByZXZpZXc6IHN0cmluZztcbn1cblxuLyoqIGFwcHJvdmFsLnJlcXVpcmVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyXHU1QkExXHU2Mjc5XHU2NzQzXHU1QTAxXHU1NzI4IHJ1bnRpbWUgXHU1NDBFXHU3QUVGO1VJIFx1NTNFQVx1NjYyRlx1OEY2Q1x1OEZGMFx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHByb3ZhbFJlcXVpcmVkUGF5bG9hZCB7XG4gIGFwcHJvdmFsSWQ6IHN0cmluZztcbiAgdG9vbDogc3RyaW5nO1xuICBhcmdzUHJldmlldzogc3RyaW5nO1xuICAvKiogXHU1RjcxXHU1NENEXHU4MzAzXHU1NkY0L1x1OThDRVx1OTY2OVx1NzY4NFx1NEVCQVx1N0M3Qlx1NTNFRlx1OEJGQlx1OEJGNFx1NjYwRSxcdTc1MzEgcnVudGltZSBcdTc1MUZcdTYyMTBcdTMwMDIgKi9cbiAgcmlzazogc3RyaW5nO1xufVxuXG4vKiogdmVyaWZpY2F0aW9uLnVwZGF0ZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgVmVyaWZpY2F0aW9uVXBkYXRlZFBheWxvYWQge1xuICBzdW1tYXJ5OiBzdHJpbmc7XG4gIHBhc3NlZDogYm9vbGVhbiB8IG51bGw7IC8vIG51bGwgPSBcdTY3MkFcdTc3RTUvXHU4RkRCXHU4ODRDXHU0RTJEKE5FRURTLURBVEEgXHU2NUY2XHU0RTBEXHU1MDQ3XHU1ODZCKVxufVxuXG4vKiogYXJ0aWZhY3QuY3JlYXRlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcnRpZmFjdENyZWF0ZWRQYXlsb2FkIHtcbiAgYXJ0aWZhY3Q6IEFydGlmYWN0UmVmO1xufVxuXG4vKiogcnVuLmNvbXBsZXRlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBSdW5Db21wbGV0ZWRQYXlsb2FkIHtcbiAgdGV4dDogc3RyaW5nO1xuICB0dXJuczogbnVtYmVyO1xuICB0b29sVXNlczogbnVtYmVyO1xuICB1c2FnZT86IHsgcHJvbXB0VG9rZW5zOiBudW1iZXI7IGNvbXBsZXRpb25Ub2tlbnM6IG51bWJlciB9O1xufVxuXG4vKiogcnVuLmZhaWxlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBSdW5GYWlsZWRQYXlsb2FkIHtcbiAgZXJyb3I6IERlc2t0b3BFcnJvcjtcbn1cbiIsICIvKipcbiAqIEBobWgtZGVza3RvcC9jb250cmFjdHMgXHUyMDE0IFx1N0VEM1x1Njc4NFx1NTMxNlx1Njg0Q1x1OTc2Mlx1OTUxOVx1OEJFRihcdTVGMDBcdTUzRDFcdThCQTFcdTUyMTJcdTY1ODdcdTY4NjMgMDQgXHUwMEE3XHU0RTA5KVx1MzAwMlxuICpcbiAqIGhvc3Qtbm90LXJlYWR5IC8gYXV0aC1mYWlsZWQgLyBzdGFsZS12ZXJzaW9uIC8gcnVudGltZS1jcmFzaGVkIC9cbiAqIHBvcnQtYmluZC1mYWlsZWQgLyBzY2hlbWEtbWlzbWF0Y2ggXHU1RkM1XHU5ODdCXHU2NjJGXHU3RUQzXHU2Nzg0XHU1MzE2XHU5NTE5XHU4QkVGXHU3ODAxLFx1NUU3Nlx1NjNEMFx1NEY5Qlx1NEUwQlx1NEUwMFx1NkI2NVx1NTJBOFx1NEY1Q1x1MzAwMlxuICogbWVzc2FnZSBcdTY2MkZcdTdFQUZcdTY1ODdcdTY3MkMsXHU2RTMyXHU2N0QzXHU3QUVGXHU2QzM4XHU0RTBEXHU2MjhBXHU1QjgzXHU1RjUzIEhUTUxcdTMwMDJcbiAqL1xuZXhwb3J0IGNvbnN0IEVSUk9SX0NPREVTID0gW1xuICAnSE9TVF9OT1RfUkVBRFknLFxuICAnQVVUSF9GQUlMRUQnLFxuICAnUlVOVElNRV9DUkFTSEVEJyxcbiAgJ1BPUlRfQklORF9GQUlMRUQnLFxuICAnU1RBTEVfVkVSU0lPTicsXG4gICdTQ0hFTUFfTUlTTUFUQ0gnLFxuXSBhcyBjb25zdDtcblxuZXhwb3J0IHR5cGUgRXJyb3JDb2RlID0gKHR5cGVvZiBFUlJPUl9DT0RFUylbbnVtYmVyXTtcblxuZXhwb3J0IGNvbnN0IFJFQ09WRVJZX0FDVElPTlMgPSBbJ1JFQ09OTkVDVCcsICdSRVNVTUUnLCAnRVhQT1JUJywgJ09QRU5fTE9HUyddIGFzIGNvbnN0O1xuZXhwb3J0IHR5cGUgUmVjb3ZlcnlBY3Rpb24gPSAodHlwZW9mIFJFQ09WRVJZX0FDVElPTlMpW251bWJlcl07XG5cbmV4cG9ydCBpbnRlcmZhY2UgRGVza3RvcEVycm9yIHtcbiAgY29kZTogRXJyb3JDb2RlO1xuICAvKiogXHU3RUFGXHU2NTg3XHU2NzJDLFx1NkMzOFx1NEUwRFx1NEZFMVx1NEVGQlx1NEUzQSBIVE1MXHUzMDAyICovXG4gIG1lc3NhZ2U6IHN0cmluZztcbiAgcmV0cnlhYmxlOiBib29sZWFuO1xuICBzZXNzaW9uSWQ/OiBzdHJpbmc7XG4gIHJ1bklkPzogc3RyaW5nO1xuICByZWNvdmVyeUFjdGlvbj86IFJlY292ZXJ5QWN0aW9uO1xufVxuXG4vKiogXHU2Nzg0XHU5MDIwXHU0RTAwXHU0RTJBIERlc2t0b3BFcnJvcihleGFjdE9wdGlvbmFsUHJvcGVydHlUeXBlcyBcdTUzQ0JcdTU5N0QpXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gZGVza3RvcEVycm9yKFxuICBjb2RlOiBFcnJvckNvZGUsXG4gIG1lc3NhZ2U6IHN0cmluZyxcbiAgb3B0czogeyByZXRyeWFibGU/OiBib29sZWFuOyBzZXNzaW9uSWQ/OiBzdHJpbmc7IHJ1bklkPzogc3RyaW5nOyByZWNvdmVyeUFjdGlvbj86IFJlY292ZXJ5QWN0aW9uIH0gPSB7fSxcbik6IERlc2t0b3BFcnJvciB7XG4gIGNvbnN0IGU6IERlc2t0b3BFcnJvciA9IHsgY29kZSwgbWVzc2FnZSwgcmV0cnlhYmxlOiBvcHRzLnJldHJ5YWJsZSA9PT0gdHJ1ZSB9O1xuICBpZiAob3B0cy5zZXNzaW9uSWQgIT09IHVuZGVmaW5lZCkgZS5zZXNzaW9uSWQgPSBvcHRzLnNlc3Npb25JZDtcbiAgaWYgKG9wdHMucnVuSWQgIT09IHVuZGVmaW5lZCkgZS5ydW5JZCA9IG9wdHMucnVuSWQ7XG4gIGlmIChvcHRzLnJlY292ZXJ5QWN0aW9uICE9PSB1bmRlZmluZWQpIGUucmVjb3ZlcnlBY3Rpb24gPSBvcHRzLnJlY292ZXJ5QWN0aW9uO1xuICByZXR1cm4gZTtcbn1cbiIsICIvKipcbiAqIEBobWgtZGVza3RvcC9jb250cmFjdHMgXHUyMDE0IHJ1bnRpbWUgXHU2ODIxXHU5QThDKGd1YXJkcylcdTMwMDJcbiAqXG4gKiBcdTZCQ0ZcdTRFMkFcdThERThcdTRGRTFcdTRFRkJcdThGQjlcdTc1NENcdTc2ODRcdTY1NzBcdTYzNkUocnVudGltZVx1MjE5MnJlbmRlcmVyXHUzMDAxaG9zdFx1MjE5Mm1haW4pXHU4RkRCXHU1MTY1XHU1MjREXHU1MTQ4XHU4RkM3IGd1YXJkO1xuICogXHU2ODIxXHU5QThDXHU1OTMxXHU4RDI1XHU3Njg0XHU2NTcwXHU2MzZFXHU2MzA5IFNDSEVNQV9NSVNNQVRDSCBcdTdFRDNcdTY3ODRcdTUzMTZcdTk1MTlcdThCRUZcdTU5MDRcdTc0MDYsXHU0RTBEXHU5NzU5XHU5RUQ4XHU2M0E1XHU1M0Q3XHUzMDAyXG4gKiBcdTYyNEJcdTUxOTlcdTVCODhcdTUzNkJcdTgwMENcdTRFMERcdTY2MkZcdTVGMTVcdTdCMkNcdTRFMDlcdTY1Qjkgc2NoZW1hIFx1NUU5MzpcdTU5NTFcdTdFQTZcdTk3NjJcdTVDMEYsXHU5NkY2XHU0RjlEXHU4RDU2XHU2NTg3XHU1MzE2KGhtaGFybmVzcyBcdTU0MENcdTZFOTApXHUzMDAyXG4gKi9cbmltcG9ydCB7XG4gIEVWRU5UX0tJTkRTLFxuICBFVkVOVF9TQ0hFTUFfVkVSU0lPTixcbiAgdHlwZSBFdmVudEVudmVsb3BlLFxuICB0eXBlIEV2ZW50S2luZCxcbn0gZnJvbSAnLi9ldmVudC50cyc7XG5pbXBvcnQgeyBFUlJPUl9DT0RFUywgUkVDT1ZFUllfQUNUSU9OUywgdHlwZSBEZXNrdG9wRXJyb3IgfSBmcm9tICcuL2Vycm9yLnRzJztcbmltcG9ydCB7IFJVTl9TVEFUVVNFUywgdHlwZSBSdW5TdGF0dXMgfSBmcm9tICcuL2R0by50cyc7XG5cbmNvbnN0IGlzUmVjb3JkID0gKHY6IHVua25vd24pOiB2IGlzIFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0+XG4gIHR5cGVvZiB2ID09PSAnb2JqZWN0JyAmJiB2ICE9PSBudWxsICYmICFBcnJheS5pc0FycmF5KHYpO1xuXG5jb25zdCBpc05vbkVtcHR5U3RyaW5nID0gKHY6IHVua25vd24pOiB2IGlzIHN0cmluZyA9PiB0eXBlb2YgdiA9PT0gJ3N0cmluZycgJiYgdi5sZW5ndGggPiAwO1xuXG5jb25zdCBpc1JmYzMzMzkgPSAodjogc3RyaW5nKTogYm9vbGVhbiA9PiB7XG4gIGNvbnN0IHQgPSBEYXRlLnBhcnNlKHYpO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKHQpICYmIC9cXGR7NH0tXFxkezJ9LVxcZHsyfVQvLnRlc3Qodik7XG59O1xuXG5leHBvcnQgZnVuY3Rpb24gaXNFdmVudEVudmVsb3BlKHY6IHVua25vd24pOiB2IGlzIEV2ZW50RW52ZWxvcGUge1xuICBpZiAoIWlzUmVjb3JkKHYpKSByZXR1cm4gZmFsc2U7XG4gIGlmICh2LnNjaGVtYVZlcnNpb24gIT09IEVWRU5UX1NDSEVNQV9WRVJTSU9OKSByZXR1cm4gZmFsc2U7XG4gIGlmICghaXNOb25FbXB0eVN0cmluZyh2LmV2ZW50SWQpKSByZXR1cm4gZmFsc2U7XG4gIGlmICghaXNOb25FbXB0eVN0cmluZyh2LnNlc3Npb25JZCkpIHJldHVybiBmYWxzZTtcbiAgaWYgKCFpc05vbkVtcHR5U3RyaW5nKHYucnVuSWQpKSByZXR1cm4gZmFsc2U7XG4gIGlmICh0eXBlb2Ygdi5zZXEgIT09ICdudW1iZXInIHx8ICFOdW1iZXIuaXNJbnRlZ2VyKHYuc2VxKSB8fCB2LnNlcSA8IDApIHJldHVybiBmYWxzZTtcbiAgaWYgKCFpc05vbkVtcHR5U3RyaW5nKHYub2NjdXJyZWRBdCkgfHwgIWlzUmZjMzMzOSh2Lm9jY3VycmVkQXQpKSByZXR1cm4gZmFsc2U7XG4gIGlmICghRVZFTlRfS0lORFMuaW5jbHVkZXModi5raW5kIGFzIEV2ZW50S2luZCkpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIGlzUmVjb3JkKHYucGF5bG9hZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0Rlc2t0b3BFcnJvcih2OiB1bmtub3duKTogdiBpcyBEZXNrdG9wRXJyb3Ige1xuICBpZiAoIWlzUmVjb3JkKHYpKSByZXR1cm4gZmFsc2U7XG4gIGlmICghRVJST1JfQ09ERVMuaW5jbHVkZXModi5jb2RlIGFzIG5ldmVyKSkgcmV0dXJuIGZhbHNlO1xuICBpZiAodHlwZW9mIHYubWVzc2FnZSAhPT0gJ3N0cmluZycpIHJldHVybiBmYWxzZTtcbiAgaWYgKHR5cGVvZiB2LnJldHJ5YWJsZSAhPT0gJ2Jvb2xlYW4nKSByZXR1cm4gZmFsc2U7XG4gIGlmICh2LnNlc3Npb25JZCAhPT0gdW5kZWZpbmVkICYmICFpc05vbkVtcHR5U3RyaW5nKHYuc2Vzc2lvbklkKSkgcmV0dXJuIGZhbHNlO1xuICBpZiAodi5ydW5JZCAhPT0gdW5kZWZpbmVkICYmICFpc05vbkVtcHR5U3RyaW5nKHYucnVuSWQpKSByZXR1cm4gZmFsc2U7XG4gIGlmICh2LnJlY292ZXJ5QWN0aW9uICE9PSB1bmRlZmluZWQgJiYgIVJFQ09WRVJZX0FDVElPTlMuaW5jbHVkZXModi5yZWNvdmVyeUFjdGlvbiBhcyBuZXZlcikpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpc1J1blN0YXR1cyh2OiB1bmtub3duKTogdiBpcyBSdW5TdGF0dXMge1xuICByZXR1cm4gdHlwZW9mIHYgPT09ICdzdHJpbmcnICYmIFJVTl9TVEFUVVNFUy5pbmNsdWRlcyh2IGFzIFJ1blN0YXR1cyk7XG59XG5cbi8qKiBIb3N0IFx1NUYxNVx1NUJGQ1x1ODg0QyhzdGRvdXQgXHU3QjJDXHU0RTAwXHU4ODRDKVx1MzAwMiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzSG9zdFJlYWR5TGluZSh2OiB1bmtub3duKTogdiBpcyB7IGhtaERlc2t0b3BIb3N0UmVhZHk6IHRydWU7IHBvcnQ6IG51bWJlcjsgdmVyc2lvbjogc3RyaW5nIH0ge1xuICBpZiAoIWlzUmVjb3JkKHYpKSByZXR1cm4gZmFsc2U7XG4gIGlmICh2LmhtaERlc2t0b3BIb3N0UmVhZHkgIT09IHRydWUpIHJldHVybiBmYWxzZTtcbiAgaWYgKHR5cGVvZiB2LnBvcnQgIT09ICdudW1iZXInIHx8ICFOdW1iZXIuaXNJbnRlZ2VyKHYucG9ydCkgfHwgdi5wb3J0IDw9IDAgfHwgdi5wb3J0ID4gNjU1MzUpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIGlzTm9uRW1wdHlTdHJpbmcodi52ZXJzaW9uKTtcbn1cbiIsICIvKipcbiAqIERlc2t0b3BIb3N0Q2xpZW50IFx1MjAxNCBcdTVCRjkgaG1oIGhvc3QgXHU3Njg0IEhUVFArU1NFIFx1NUJBMlx1NjIzN1x1N0FFRlx1MzAwMlxuICpcbiAqIC0gXHU2QkNGXHU0RTJBIEhUVFAgXHU4QkY3XHU2QzQyXHU4MUVBXHU1MkE4XHU1RTI2IFgtSG1oLUtleSh0b2tlbiBcdTRFMERcdThGREIgVVJMKTtcbiAqIC0gXHU3RUQzXHU2Nzg0XHU1MzE2XHU5NTE5XHU4QkVGKHJlcy5ib2R5IFx1OTFDQ1x1NzY4NCBEZXNrdG9wRXJyb3IgXHU1RjYyXHU3MkI2XHU2MjE2IEhUVFAgXHU3MkI2XHU2MDAxKVx1ODlDNFx1N0VBNlx1NjIxMFx1NUYwMlx1NUUzOFx1NjI5Qlx1NTFGQTtcbiAqIC0gU1NFIFx1NzUyOCBmZXRjaCBcdTZENDFcdTYyNEJcdTUxOTlcdTg5RTNcdTY3OTAoaWQvZXZlbnQvZGF0YSBcdTVFMjcpLFx1NjUyRlx1NjMwMSBMYXN0LUV2ZW50LUlEIFx1ODg2NVx1NjJDOVx1OTFDRFx1OEZERVx1MzAwMlxuICovXG5pbXBvcnQgeyBkZXNrdG9wRXJyb3IsIGlzRGVza3RvcEVycm9yLCBpc0V2ZW50RW52ZWxvcGUsIHR5cGUgRGVza3RvcEVycm9yLCB0eXBlIEV2ZW50RW52ZWxvcGUgfSBmcm9tICdAaG1oLWRlc2t0b3AvY29udHJhY3RzJztcbmltcG9ydCB7IHJhbmRvbVVVSUQgfSBmcm9tICdub2RlOmNyeXB0byc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3NlRnJhbWUge1xuICBpZD86IHN0cmluZztcbiAgZXZlbnQ6IHN0cmluZztcbiAgZGF0YTogc3RyaW5nO1xufVxuXG4vKiogXHU4OUUzXHU2NzkwXHU0RTAwXHU2QkI1IFNTRSBcdTY1ODdcdTY3MkNcdTRFM0FcdTVFMjcoXHU0RTBEXHU1NDJCXHU4REU4IGNodW5rIFx1NzY4NFx1N0YxM1x1NTFCMlx1OTAzQlx1OEY5MSxcdTdFQUZcdTUxRkRcdTY1NzBcdTRGQkZcdTRFOEVcdTZENEJcdThCRDUpXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VTc2VDaHVuayhjaHVuazogc3RyaW5nKTogU3NlRnJhbWVbXSB7XG4gIGNvbnN0IGZyYW1lczogU3NlRnJhbWVbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGJsb2NrIG9mIGNodW5rLnNwbGl0KC9cXG5cXG4vKSkge1xuICAgIGlmICghYmxvY2sudHJpbSgpKSBjb250aW51ZTtcbiAgICBsZXQgaWQ6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICBsZXQgZXZlbnQgPSAnbWVzc2FnZSc7XG4gICAgY29uc3QgZGF0YUxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGxldCBzYXdGaWVsZCA9IGZhbHNlO1xuICAgIGZvciAoY29uc3QgbGluZSBvZiBibG9jay5zcGxpdCgnXFxuJykpIHtcbiAgICAgIGlmIChsaW5lLnN0YXJ0c1dpdGgoJzonKSkgY29udGludWU7IC8vIFx1NkNFOFx1OTFDQS9cdTVGQzNcdThERjNcbiAgICAgIGlmIChsaW5lLnN0YXJ0c1dpdGgoJ2lkOicpKSB7IGlkID0gbGluZS5zbGljZSgzKS50cmltKCk7IHNhd0ZpZWxkID0gdHJ1ZTsgfVxuICAgICAgZWxzZSBpZiAobGluZS5zdGFydHNXaXRoKCdldmVudDonKSkgeyBldmVudCA9IGxpbmUuc2xpY2UoNikudHJpbSgpOyBzYXdGaWVsZCA9IHRydWU7IH1cbiAgICAgIGVsc2UgaWYgKGxpbmUuc3RhcnRzV2l0aCgnZGF0YTonKSkgeyBkYXRhTGluZXMucHVzaChsaW5lLnNsaWNlKDUpLnJlcGxhY2UoL14gLywgJycpKTsgc2F3RmllbGQgPSB0cnVlOyB9XG4gICAgfVxuICAgIGlmICghc2F3RmllbGQpIGNvbnRpbnVlOyAvLyBcdTdFQUZcdTZDRThcdTkxQ0EvXHU1RkMzXHU4REYzXHU1NzU3XHU0RTBEXHU0RUE3XHU3NTFGXHU1RTI3XG4gICAgZnJhbWVzLnB1c2goeyAuLi4oaWQgIT09IHVuZGVmaW5lZCA/IHsgaWQgfSA6IHt9KSwgZXZlbnQsIGRhdGE6IGRhdGFMaW5lcy5qb2luKCdcXG4nKSB9KTtcbiAgfVxuICByZXR1cm4gZnJhbWVzO1xufVxuXG4vKiogXHU0RUNFIFNTRSBcdTVFMjdcdTY1NzBcdTYzNkVcdTRFMkRcdTg5RTNcdTUxRkFcdTU0MDhcdTZDRDUgRXZlbnRFbnZlbG9wZTtcdTRFMERcdTU0MDhcdTZDRDVcdTc2ODRcdThGRDRcdTU2REUgbnVsbChTQ0hFTUFfTUlTTUFUQ0ggXHU3NTMxXHU4QzAzXHU3NTI4XHU2NUI5XHU4QkExXHU2NTcwKVx1MzAwMiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVudmVsb3BlRnJvbUZyYW1lKGZyYW1lOiBTc2VGcmFtZSk6IEV2ZW50RW52ZWxvcGUgfCBudWxsIHtcbiAgaWYgKGZyYW1lLmV2ZW50ICE9PSAnaG1oJykgcmV0dXJuIG51bGw7IC8vIFx1NjIxMVx1NEVFQ1x1NzY4NFx1NEU4Qlx1NEVGNlx1NEZFMVx1NUMwMVx1N0VERlx1NEUwMFx1OEQ3MCBldmVudDogaG1oXG4gIHRyeSB7XG4gICAgY29uc3QgcGFyc2VkOiB1bmtub3duID0gSlNPTi5wYXJzZShmcmFtZS5kYXRhKTtcbiAgICByZXR1cm4gaXNFdmVudEVudmVsb3BlKHBhcnNlZCkgPyBwYXJzZWQgOiBudWxsO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5leHBvcnQgY2xhc3MgRGVza3RvcEh0dHBFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IocHVibGljIHJlYWRvbmx5IGRldGFpbDogRGVza3RvcEVycm9yKSB7XG4gICAgc3VwZXIoZGV0YWlsLm1lc3NhZ2UpO1xuICB9XG59XG5cbmV4cG9ydCBjbGFzcyBEZXNrdG9wSG9zdENsaWVudCB7XG4gIGNvbnN0cnVjdG9yKFxuICAgIHByaXZhdGUgcmVhZG9ubHkgYmFzZVVybDogc3RyaW5nLFxuICAgIHByaXZhdGUgcmVhZG9ubHkgdG9rZW46IHN0cmluZyxcbiAgKSB7fVxuXG4gIHByaXZhdGUgaGVhZGVycyhleHRyYTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9KTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB7XG4gICAgcmV0dXJuIHsgJ3gtaG1oLWtleSc6IHRoaXMudG9rZW4sIC4uLmV4dHJhIH07XG4gIH1cblxuICBhc3luYyBnZXRKc29uPFQ+KHBhdGg6IHN0cmluZywgdGltZW91dE1zID0gNV8wMDApOiBQcm9taXNlPFQ+IHtcbiAgICBsZXQgcmVzOiBSZXNwb25zZTtcbiAgICB0cnkge1xuICAgICAgcmVzID0gYXdhaXQgZmV0Y2goYCR7dGhpcy5iYXNlVXJsfSR7cGF0aH1gLCB7IGhlYWRlcnM6IHRoaXMuaGVhZGVycygpLCBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQodGltZW91dE1zKSB9KTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgcmVxdWVzdCBmYWlsZWQ6ICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTYwKX1gLCB7IHJldHJ5YWJsZTogdHJ1ZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcbiAgICB9XG4gICAgcmV0dXJuIHRoaXMucGFyc2VSZXNwb25zZTxUPihyZXMpO1xuICB9XG5cbiAgLyoqIFx1NjJDOVx1NTNENlx1N0VBRlx1NjU4N1x1NjcyQ1x1N0FFRlx1NzBCOShcdTU5ODIgL2FwaS9zZXNzaW9ucy86aWQvZXhwb3J0Lm1kKVx1MzAwMiAqL1xuICBhc3luYyBnZXRUZXh0KHBhdGg6IHN0cmluZywgdGltZW91dE1zID0gMTBfMDAwKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgICBsZXQgcmVzOiBSZXNwb25zZTtcbiAgICB0cnkge1xuICAgICAgcmVzID0gYXdhaXQgZmV0Y2goYCR7dGhpcy5iYXNlVXJsfSR7cGF0aH1gLCB7IGhlYWRlcnM6IHRoaXMuaGVhZGVycygpLCBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQodGltZW91dE1zKSB9KTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgcmVxdWVzdCBmYWlsZWQ6ICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTYwKX1gLCB7IHJldHJ5YWJsZTogdHJ1ZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcbiAgICB9XG4gICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSB8fCByZXMuc3RhdHVzID09PSA0MDMpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignQVVUSF9GQUlMRUQnLCBgaG9zdCByZWplY3RlZCB0aGUgc2Vzc2lvbiB0b2tlbiAoSFRUUCAke3Jlcy5zdGF0dXN9KWAsIHsgcmV0cnlhYmxlOiBmYWxzZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcbiAgICB9XG4gICAgaWYgKCFyZXMub2spIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgSFRUUCAke3Jlcy5zdGF0dXN9YCwgeyByZXRyeWFibGU6IHJlcy5zdGF0dXMgPj0gNTAwIH0pKTtcbiAgICB9XG4gICAgcmV0dXJuIHJlcy50ZXh0KCk7XG4gIH1cblxuICAvKiogXHU2QkNGXHU0RTJBXHU1RTI2XHU1MjZGXHU0RjVDXHU3NTI4XHU3Njg0IFBPU1QgXHU4MUVBXHU1MkE4XHU2NDNBXHU1RTI2XHU1RTQyXHU3QjQ5XHU5NTJFKDAzIFx1MDBBN1x1NTZEQlx1OTYzMlx1OTFDRFx1NjUzRTpcdThCRjdcdTZDNDJcdTRGN0ZcdTc1MjggaWRlbXBvdGVuY3lLZXk7XG4gICAqICBydW50aW1lIFx1NEZBN1x1NzdFRFx1NjcxRlx1NTE3Q1x1NUJCOVx1NUZGRFx1NzU2NSxcdTUzNEZcdThCQUVcdTUxNDhcdTg4NENcdTIwMTRcdTIwMTRcdTkxQ0RcdThCRDVcdTUzRUZcdTUxRURcdTk1MkVcdTUzQkJcdTkxQ0QsXHU0RTBEXHU3NkYyXHU3NkVFXHU5MUNEXHU2NTNFKVx1MzAwMiAqL1xuICBhc3luYyBwb3N0SnNvbjxUPihwYXRoOiBzdHJpbmcsIGJvZHk6IHVua25vd24sIHRpbWVvdXRNcyA9IDEwXzAwMCk6IFByb21pc2U8VD4ge1xuICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgIHRyeSB7XG4gICAgICByZXMgPSBhd2FpdCBmZXRjaChgJHt0aGlzLmJhc2VVcmx9JHtwYXRofWAsIHtcbiAgICAgICAgbWV0aG9kOiAnUE9TVCcsXG4gICAgICAgIGhlYWRlcnM6IHRoaXMuaGVhZGVycyh7XG4gICAgICAgICAgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICAgICAgICAneC1pZGVtcG90ZW5jeS1rZXknOiByYW5kb21VVUlEKCksXG4gICAgICAgIH0pLFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KSxcbiAgICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KHRpbWVvdXRNcyksXG4gICAgICB9KTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgcmVxdWVzdCBmYWlsZWQ6ICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTYwKX1gLCB7IHJldHJ5YWJsZTogdHJ1ZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcbiAgICB9XG4gICAgcmV0dXJuIHRoaXMucGFyc2VSZXNwb25zZTxUPihyZXMpO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBwYXJzZVJlc3BvbnNlPFQ+KHJlczogUmVzcG9uc2UpOiBQcm9taXNlPFQ+IHtcbiAgICBpZiAocmVzLnN0YXR1cyA9PT0gNDAxIHx8IHJlcy5zdGF0dXMgPT09IDQwMykge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdBVVRIX0ZBSUxFRCcsIGBob3N0IHJlamVjdGVkIHRoZSBzZXNzaW9uIHRva2VuIChIVFRQICR7cmVzLnN0YXR1c30pYCwgeyByZXRyeWFibGU6IGZhbHNlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICBjb25zdCB0ZXh0ID0gYXdhaXQgcmVzLnRleHQoKTtcbiAgICBsZXQgcGFyc2VkOiB1bmtub3duID0gbnVsbDtcbiAgICB0cnkge1xuICAgICAgcGFyc2VkID0gdGV4dCA/IEpTT04ucGFyc2UodGV4dCkgOiBudWxsO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcGFyc2VkID0gbnVsbDtcbiAgICB9XG4gICAgaWYgKCFyZXMub2spIHtcbiAgICAgIGlmIChpc0Rlc2t0b3BFcnJvcihwYXJzZWQpKSB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihwYXJzZWQpO1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBIVFRQICR7cmVzLnN0YXR1c306ICR7dGV4dC5zbGljZSgwLCAxNjApfWAsIHsgcmV0cnlhYmxlOiByZXMuc3RhdHVzID49IDUwMCB9KSk7XG4gICAgfVxuICAgIHJldHVybiBwYXJzZWQgYXMgVDtcbiAgfVxuXG4gIC8qKlxuICAgKiBcdThCQTJcdTk2MDVcdTUxNjhcdTkwRTggU1NFIFx1NUUyNyhcdTU0MkJcdTk3NUVcdTRGRTFcdTVDMDFcdTRFOEJcdTRFRjY6ZGVsdGEvbGluZSBcdTdCNDlcdTlBRDhcdTk4OTFcdTZENDEpXHUzMDAyXHU0RkUxXHU1QzAxXHU3NTMxXHU4QzAzXHU3NTI4XHU2NUI5XG4gICAqIFx1NzUyOCBlbnZlbG9wZUZyb21GcmFtZSBcdTgxRUFcdTg4NENcdTUyMDZcdTZENDE7XHU2NUFEXHU3RUJGXHU5MUNEXHU4RkRFXHU4QkVEXHU0RTQ5XHU1NDBDIGV2ZW50cygpXHUzMDAyXG4gICAqL1xuICBhc3luYyAqcmF3RXZlbnRzKGxhc3RFdmVudElkPzogc3RyaW5nLCBzaWduYWw/OiBBYm9ydFNpZ25hbCk6IEFzeW5jR2VuZXJhdG9yPFNzZUZyYW1lPiB7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYCR7dGhpcy5iYXNlVXJsfS9hcGkvZXZlbnRzYCwge1xuICAgICAgaGVhZGVyczogdGhpcy5oZWFkZXJzKHtcbiAgICAgICAgYWNjZXB0OiAndGV4dC9ldmVudC1zdHJlYW0nLFxuICAgICAgICAuLi4obGFzdEV2ZW50SWQgIT09IHVuZGVmaW5lZCA/IHsgJ2xhc3QtZXZlbnQtaWQnOiBsYXN0RXZlbnRJZCB9IDoge30pLFxuICAgICAgfSksXG4gICAgICAuLi4oc2lnbmFsICE9PSB1bmRlZmluZWQgPyB7IHNpZ25hbCB9IDoge30pLFxuICAgIH0pO1xuICAgIGlmIChyZXMuc3RhdHVzID09PSA0MDEgfHwgcmVzLnN0YXR1cyA9PT0gNDAzKSB7XG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgYGhvc3QgcmVqZWN0ZWQgdGhlIHNlc3Npb24gdG9rZW4gKEhUVFAgJHtyZXMuc3RhdHVzfSlgLCB7IHJldHJ5YWJsZTogZmFsc2UsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XG4gICAgfVxuICAgIGlmICghcmVzLm9rIHx8IHJlcy5ib2R5ID09PSBudWxsKSB7XG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYFNTRSBIVFRQICR7cmVzLnN0YXR1c31gLCB7IHJldHJ5YWJsZTogdHJ1ZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcbiAgICB9XG4gICAgY29uc3QgcmVhZGVyID0gcmVzLmJvZHkuZ2V0UmVhZGVyKCk7XG4gICAgY29uc3QgZGVjb2RlciA9IG5ldyBUZXh0RGVjb2RlcigpO1xuICAgIGxldCBidWZmZXIgPSAnJztcbiAgICBmb3IgKDs7KSB7XG4gICAgICBjb25zdCB7IGRvbmUsIHZhbHVlIH0gPSBhd2FpdCByZWFkZXIucmVhZCgpO1xuICAgICAgaWYgKGRvbmUpIHJldHVybjtcbiAgICAgIGJ1ZmZlciArPSBkZWNvZGVyLmRlY29kZSh2YWx1ZSwgeyBzdHJlYW06IHRydWUgfSk7XG4gICAgICBsZXQgaWR4OiBudW1iZXI7XG4gICAgICB3aGlsZSAoKGlkeCA9IGJ1ZmZlci5pbmRleE9mKCdcXG5cXG4nKSkgIT09IC0xKSB7XG4gICAgICAgIGNvbnN0IGJsb2NrID0gYnVmZmVyLnNsaWNlKDAsIGlkeCk7XG4gICAgICAgIGJ1ZmZlciA9IGJ1ZmZlci5zbGljZShpZHggKyAyKTtcbiAgICAgICAgZm9yIChjb25zdCBmcmFtZSBvZiBwYXJzZVNzZUNodW5rKGJsb2NrKSkgeWllbGQgZnJhbWU7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFx1OEJBMlx1OTYwNSBTU0UgXHU0RThCXHU0RUY2XHU2RDQxKGFzeW5jIGl0ZXJhdG9yKVx1MzAwMlx1NjVBRFx1N0VCRlx1NzUzMVx1OEMwM1x1NzUyOFx1NjVCOVx1OTFDRFx1OEZERTtcdTkxQ0RcdThGREVcdTY1RjZcdTYyOEFcdTY3MDBcdTU0MEVcbiAgICogXHU2NTM2XHU1MjMwXHU3Njg0IGV2ZW50SWQgXHU0RjIwXHU1MTY1IGxhc3RFdmVudElkLGhvc3QgXHU3QUVGXHU0RUNFXHU5MUNEXHU2NTNFXHU3M0FGXHU4ODY1XHU1M0QxXHUzMDAyXG4gICAqL1xuICBhc3luYyAqZXZlbnRzKGxhc3RFdmVudElkPzogc3RyaW5nLCBzaWduYWw/OiBBYm9ydFNpZ25hbCk6IEFzeW5jR2VuZXJhdG9yPEV2ZW50RW52ZWxvcGU+IHtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgJHt0aGlzLmJhc2VVcmx9L2FwaS9ldmVudHNgLCB7XG4gICAgICBoZWFkZXJzOiB0aGlzLmhlYWRlcnMoe1xuICAgICAgICBhY2NlcHQ6ICd0ZXh0L2V2ZW50LXN0cmVhbScsXG4gICAgICAgIC4uLihsYXN0RXZlbnRJZCAhPT0gdW5kZWZpbmVkID8geyAnbGFzdC1ldmVudC1pZCc6IGxhc3RFdmVudElkIH0gOiB7fSksXG4gICAgICB9KSxcbiAgICAgIC4uLihzaWduYWwgIT09IHVuZGVmaW5lZCA/IHsgc2lnbmFsIH0gOiB7fSksXG4gICAgfSk7XG4gICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSB8fCByZXMuc3RhdHVzID09PSA0MDMpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignQVVUSF9GQUlMRUQnLCBgaG9zdCByZWplY3RlZCB0aGUgc2Vzc2lvbiB0b2tlbiAoSFRUUCAke3Jlcy5zdGF0dXN9KWAsIHsgcmV0cnlhYmxlOiBmYWxzZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcbiAgICB9XG4gICAgaWYgKCFyZXMub2sgfHwgIXJlcy5ib2R5KSB7XG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYFNTRSBIVFRQICR7cmVzLnN0YXR1c31gLCB7IHJldHJ5YWJsZTogdHJ1ZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcbiAgICB9XG4gICAgY29uc3QgcmVhZGVyID0gcmVzLmJvZHkuZ2V0UmVhZGVyKCk7XG4gICAgY29uc3QgZGVjb2RlciA9IG5ldyBUZXh0RGVjb2RlcigpO1xuICAgIGxldCBidWZmZXIgPSAnJztcbiAgICBmb3IgKDs7KSB7XG4gICAgICBjb25zdCB7IGRvbmUsIHZhbHVlIH0gPSBhd2FpdCByZWFkZXIucmVhZCgpO1xuICAgICAgaWYgKGRvbmUpIHJldHVybjtcbiAgICAgIGJ1ZmZlciArPSBkZWNvZGVyLmRlY29kZSh2YWx1ZSwgeyBzdHJlYW06IHRydWUgfSk7XG4gICAgICAvLyBcdTRFRTVcdTdBN0FcdTg4NENcdTUyMDZcdTVFMjc7XHU0RkREXHU3NTU5XHU0RTBEXHU1QjhDXHU2NTc0XHU3Njg0XHU1QzNFXHU5MEU4XG4gICAgICBsZXQgaWR4OiBudW1iZXI7XG4gICAgICB3aGlsZSAoKGlkeCA9IGJ1ZmZlci5pbmRleE9mKCdcXG5cXG4nKSkgIT09IC0xKSB7XG4gICAgICAgIGNvbnN0IGJsb2NrID0gYnVmZmVyLnNsaWNlKDAsIGlkeCk7XG4gICAgICAgIGJ1ZmZlciA9IGJ1ZmZlci5zbGljZShpZHggKyAyKTtcbiAgICAgICAgZm9yIChjb25zdCBmcmFtZSBvZiBwYXJzZVNzZUNodW5rKGJsb2NrKSkge1xuICAgICAgICAgIGNvbnN0IGVudiA9IGVudmVsb3BlRnJvbUZyYW1lKGZyYW1lKTtcbiAgICAgICAgICBpZiAoZW52ICE9PSBudWxsKSB5aWVsZCBlbnY7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH1cbn1cbiIsICIvKipcbiAqIGZha2UgaG9zdCBcdTIwMTQgaG1oYXJuZXNzIHJ1bnRpbWUgXHU3Njg0XHU2RDRCXHU4QkQ1XHU2NkZGXHU4RUFCKE1hc3RlclByb21wdCBcdTk2MzZcdTZCQjUgRC9FOlxuICogXCJcdTUxNDhcdTRGN0ZcdTc1MjggZmFrZSBob3N0IFx1N0YxNlx1NTE5OVx1NzJCNlx1NjAwMVx1NjczQVx1NkQ0Qlx1OEJENSxcdTUxOERcdTYzQTVcdTc3MUZcdTVCOUUgQVBJXCI7XHU5NjM2XHU2QkI1IEUgXHU3Njg0XHU0RjFBXHU4QkREXHU3RUI1XHU1MjA3XHU3MjQ3XG4gKiBlMmUgXHU0RTVGXHU1MTQ4XHU1NzI4IGZha2UgXHU1QzQyXHU5NUVEXHU3M0FGKVx1MzAwMlxuICpcbiAqIFx1Njg0Q1x1OTc2MiBob3N0IFx1NTQwOFx1NTQwQzpcbiAqICAtIFx1NTNFQVx1N0VEMSAxMjcuMC4wLjEsXHU3QUVGXHU1M0UzIE9TIFx1NTIwNlx1OTE0RCxcdTVCOUVcdTk2NDVcdTdBRUZcdTUzRTNcdTUxOTkgc3Rkb3V0IFx1NUYxNVx1NUJGQ1x1ODg0QztcbiAqICAtIFx1NjI0MFx1NjcwOSAvYXBpLyogXHU4OTgxXHU2QzQyIFgtSG1oLUtleSA9PT0gSE1IX0RFU0tUT1BfVE9LRU4sXHU1NDI2XHU1MjE5IDQwMSArIERlc2t0b3BFcnJvcjtcbiAqICAtIEdFVCAvYXBpL3N0YXRlIFx1NTA2NVx1NUVCN1x1NjNBMlx1NkQ0QjtHRVQgL2FwaS9ldmVudHMgU1NFKGV2ZW50OiBobWggXHU0RkUxXHU1QzAxXHU2RDQxICsgXHU5MUNEXHU2NTNFXHU3M0FGKTtcbiAqICAtIFBPU1QgL2FwaS9kZXNrdG9wL3NodXRkb3duIFx1NEYxOFx1OTZDNVx1OTAwMFx1NTFGQVx1MzAwMlxuICpcbiAqIFx1OTYzNlx1NkJCNSBFIFx1NkEyMVx1NjJERlx1OTc2MihcdTRFMEUgaG1oYXJuZXNzIGRlc2t0b3AgXHU2QTIxXHU1RjBGXHU1NDBDXHU1RjYyKTpcbiAqICAtIFBPU1QgL2FwaS90YXNrIHt0ZXh0LCBzZXNzaW9uSWQsIG1vZGV9Olx1NjM5Mlx1OTYxRlx1NUU3Nlx1NjMwOVx1ODExQVx1NjcyQ1x1NTNEMVxuICogICAgcnVuLnN0YXJ0ZWQgXHUyMTkyIHRvb2wuc3RhcnRlZC9jb21wbGV0ZWQgXHUyMTkyKG1vZGU9PT0nYXNrJyBcdTY1RjYpXG4gKiAgICBhcHByb3ZhbC5yZXF1aXJlZChcdTdCNDkgL2FwaS9hcHByb3ZlKVx1MjE5MiBydW4uY29tcGxldGVkO1xuICogIC0gUE9TVCAvYXBpL2FwcHJvdmUge2dyYW50ZWQsIHNlc3Npb25JZH07XG4gKiAgLSBQT1NUIC9hcGkvaW50ZXJydXB0IHtzZXNzaW9uSWR9O1xuICogIC0gR0VUIC9hcGkvc2Vzc2lvbnNcdTMwMDJcbiAqXG4gKiBcdTZENEJcdThCRDVcdTk0QTlcdTVCNTA6RkFLRV9IT1NUX0RJRV9BRlRFUl9NUyAvIEZBS0VfSE9TVF9ESUVfQVRfQk9PVCAvXG4gKiBGQUtFX0hPU1RfRVhQRUNUX1RPS0VOIC8gRkFLRV9IT1NUX1RBU0tfREVMQVlfTVMgLyBGQUtFX0hPU1RfVEFTS19GQUlMPTFcbiAqIChcdTRFRkJcdTUyQTFcdTRFRTUgcnVuLmZhaWxlZCBcdTdFRDNcdTY3NUYsXHU2Nzg0XHU5MDIwXHU5NTE5XHU4QkVGXHU2MDYyXHU1OTBEXHU1NzNBXHU2NjZGKVx1MzAwMlxuICovXG5pbXBvcnQgeyBjcmVhdGVTZXJ2ZXIsIHR5cGUgU2VydmVyUmVzcG9uc2UgfSBmcm9tICdub2RlOmh0dHAnO1xuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gJ25vZGU6Y3J5cHRvJztcbmltcG9ydCB7IHBhdGhUb0ZpbGVVUkwgfSBmcm9tICdub2RlOnVybCc7XG5pbXBvcnQgeyByZWFscGF0aFN5bmMgfSBmcm9tICdub2RlOmZzJztcbmltcG9ydCB7IEVWRU5UX1NDSEVNQV9WRVJTSU9OLCBkZXNrdG9wRXJyb3IsIHR5cGUgRXZlbnRFbnZlbG9wZSwgdHlwZSBFdmVudEtpbmQgfSBmcm9tICdAaG1oLWRlc2t0b3AvY29udHJhY3RzJztcblxuZXhwb3J0IGludGVyZmFjZSBGYWtlSG9zdEhhbmRsZSB7XG4gIHBvcnQ6IG51bWJlcjtcbiAgZW1pdChzZXNzaW9uSWQ6IHN0cmluZywgcnVuSWQ6IHN0cmluZywga2luZDogRXZlbnRLaW5kLCBwYXlsb2FkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IG51bWJlcjtcbiAgY2xvc2UoKTogUHJvbWlzZTx2b2lkPjtcbn1cblxuaW50ZXJmYWNlIEZha2VTZXNzaW9uIHtcbiAgaWQ6IHN0cmluZztcbiAgY3JlYXRlZEF0OiBzdHJpbmc7XG4gIHVwZGF0ZWRBdDogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgUGVuZGluZ0FwcHJvdmFsIHtcbiAgc2Vzc2lvbklkOiBzdHJpbmc7XG4gIGFwcHJvdmFsSWQ6IHN0cmluZztcbiAgcmVzb2x2ZShncmFudGVkOiBib29sZWFuKTogdm9pZDtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHN0YXJ0RmFrZUhvc3Qob3B0czogeyB0b2tlbjogc3RyaW5nOyBxdWlldD86IGJvb2xlYW4gfSk6IFByb21pc2U8RmFrZUhvc3RIYW5kbGU+IHtcbiAgY29uc3QgdG9rZW4gPSBvcHRzLnRva2VuO1xuICAvLyBcdTZENEJcdThCRDVcdTk0QTlcdTVCNTA6RkFLRV9IT1NUX0VYUEVDVF9UT0tFTiBcdThCQTkgaG9zdCBcdTY4MjFcdTlBOENcdTRFMDBcdTRFMkFcdTRFMEUgSE1IX0RFU0tUT1BfVE9LRU5cbiAgLy8gXHU0RTBEXHU1NDBDXHU3Njg0XHU1MDNDKFx1Njc4NFx1OTAyMCBBVVRIX0ZBSUxFRCBcdTU3M0FcdTY2NkY7c3VwZXJ2aXNvciBcdTYwM0JcdTY2MkZcdTg5ODZcdTc2RDYgSE1IX0RFU0tUT1BfVE9LRU4pXG4gIGNvbnN0IGV4cGVjdGVkID0gcHJvY2Vzcy5lbnYuRkFLRV9IT1NUX0VYUEVDVF9UT0tFTiA/PyB0b2tlbjtcbiAgY29uc3QgdGFza0RlbGF5ID0gTnVtYmVyKHByb2Nlc3MuZW52LkZBS0VfSE9TVF9UQVNLX0RFTEFZX01TID8/IDMwKTtcbiAgY29uc3QgZmFpbFRhc2tzID0gcHJvY2Vzcy5lbnYuRkFLRV9IT1NUX1RBU0tfRkFJTCA9PT0gJzEnO1xuXG4gIGNvbnN0IHNzZUNsaWVudHMgPSBuZXcgU2V0PFNlcnZlclJlc3BvbnNlPigpO1xuICBjb25zdCBzZXFCeVJ1biA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG4gIC8vIFx1OTFDRFx1NjUzRVx1NzNBRjpcdTY3MDBcdThGRDEgMjAwIFx1NUUyNyhMYXN0LUV2ZW50LUlEIFx1NjVBRFx1N0VCRlx1ODg2NVx1NjJDOSksXHU0RTBFIGhtaGFybmVzcyB3ZWIgXHU1NDBDXHU2QjNFXHU4QkVEXHU0RTQ5XG4gIGNvbnN0IHJpbmc6IEFycmF5PHsgaWQ6IG51bWJlcjsgZXZlbnQ6IHN0cmluZzsgZGF0YTogdW5rbm93biB9PiA9IFtdO1xuICBsZXQgcmluZ1NlcSA9IDA7XG4gIGNvbnN0IHNlc3Npb25zID0gbmV3IE1hcDxzdHJpbmcsIEZha2VTZXNzaW9uPigpO1xuICBsZXQgcGVuZGluZzogUGVuZGluZ0FwcHJvdmFsIHwgbnVsbCA9IG51bGw7XG4gIGNvbnN0IHJ1blRpbWVycyA9IG5ldyBNYXA8c3RyaW5nLCBOb2RlSlMuVGltZW91dD4oKTtcbiAgLy8gXHU1REU1XHU0RjVDXHU1MzNBL1Byb3ZpZGVyIFx1NzJCNlx1NjAwMShcdTRFMEUgaG1oYXJuZXNzIFx1NTQwQ1x1NUY2Mlx1NzY4NFx1NjcwMFx1NUMwRlx1NkEyMVx1NjJERilcbiAgY29uc3QgZmFrZVdvcmtzcGFjZXMgPSB7XG4gICAgY3VycmVudDogJ3dzLWRlbW8nLFxuICAgIGl0ZW1zOiBbXG4gICAgICB7IGlkOiAnd3MtZGVtbycsIG5hbWU6ICdkZW1vLXdvcmtzcGFjZScsIHBhdGg6ICdDOlxcXFxkZW1vJyB9LFxuICAgIF0sXG4gIH07XG4gIGNvbnN0IGZha2VQcm92aWRlcnMgPSBuZXcgTWFwPHN0cmluZywgeyBiYXNlVXJsOiBzdHJpbmc7IG1vZGVsOiBzdHJpbmc7IGFwaUtleTogc3RyaW5nIH0+KFtcbiAgICBbJ2RlbW8nLCB7IGJhc2VVcmw6ICdodHRwOi8vMTI3LjAuMC4xOjkvdjEnLCBtb2RlbDogJ2Zha2UtbScsIGFwaUtleTogJ3NrLWRlbW8tMTIzNCcgfV0sXG4gICAgWydkZW1vLXZpc2lvbicsIHsgYmFzZVVybDogJ2h0dHA6Ly8xMjcuMC4wLjE6OS92MScsIG1vZGVsOiAnZmFrZS1tLXZpc2lvbicsIGFwaUtleTogJ3NrLWRlbW8tNTY3OCcgfV0sXG4gIF0pO1xuICBsZXQgZmFrZUNoYXRQcm92aWRlciA9ICdkZW1vJztcblxuICBjb25zdCBlbWl0ID0gKHNlc3Npb25JZDogc3RyaW5nLCBydW5JZDogc3RyaW5nLCBraW5kOiBFdmVudEtpbmQsIHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogbnVtYmVyID0+IHtcbiAgICBjb25zdCBrZXkgPSBgJHtzZXNzaW9uSWR9XFwwJHtydW5JZH1gO1xuICAgIGNvbnN0IHNlcSA9IChzZXFCeVJ1bi5nZXQoa2V5KSA/PyAwKSArIDE7XG4gICAgc2VxQnlSdW4uc2V0KGtleSwgc2VxKTtcbiAgICBjb25zdCBlbnY6IEV2ZW50RW52ZWxvcGUgPSB7XG4gICAgICBzY2hlbWFWZXJzaW9uOiBFVkVOVF9TQ0hFTUFfVkVSU0lPTixcbiAgICAgIGV2ZW50SWQ6IHJhbmRvbVVVSUQoKSxcbiAgICAgIHNlc3Npb25JZCxcbiAgICAgIHJ1bklkLFxuICAgICAgc2VxLFxuICAgICAgb2NjdXJyZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAga2luZCxcbiAgICAgIHBheWxvYWQsXG4gICAgfTtcbiAgICBjb25zdCBpZCA9ICsrcmluZ1NlcTtcbiAgICByaW5nLnB1c2goeyBpZCwgZXZlbnQ6ICdobWgnLCBkYXRhOiBlbnYgfSk7XG4gICAgaWYgKHJpbmcubGVuZ3RoID4gMjAwKSByaW5nLnNwbGljZSgwLCByaW5nLmxlbmd0aCAtIDIwMCk7XG4gICAgZm9yIChjb25zdCBjIG9mIHNzZUNsaWVudHMpIHtcbiAgICAgIGMud3JpdGUoYGlkOiAke2lkfVxcbmV2ZW50OiBobWhcXG5kYXRhOiAke0pTT04uc3RyaW5naWZ5KGVudil9XFxuXFxuYCk7XG4gICAgfVxuICAgIHJldHVybiBzZXE7XG4gIH07XG5cbiAgY29uc3QgdG91Y2ggPSAoc2Vzc2lvbklkOiBzdHJpbmcpOiBGYWtlU2Vzc2lvbiA9PiB7XG4gICAgbGV0IHMgPSBzZXNzaW9ucy5nZXQoc2Vzc2lvbklkKTtcbiAgICBpZiAocyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBzID0geyBpZDogc2Vzc2lvbklkLCBjcmVhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSwgdXBkYXRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkgfTtcbiAgICAgIHNlc3Npb25zLnNldChzZXNzaW9uSWQsIHMpO1xuICAgIH1cbiAgICBzLnVwZGF0ZWRBdCA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcbiAgICByZXR1cm4gcztcbiAgfTtcblxuICAvKiogXHU2QTIxXHU2MkRGXHU0RTAwXHU2QjIxXHU0RUZCXHU1MkExOlx1NjI3OVx1NTFDNlx1NkEyMVx1NUYwRlx1NjMwMlx1OEQ3N1x1N0I0OVx1NUY4NSAvYXBpL2FwcHJvdmVcdTMwMDIgKi9cbiAgY29uc3QgcnVuVGFzayA9IChzZXNzaW9uSWQ6IHN0cmluZywgdGV4dDogc3RyaW5nLCBtb2RlOiBzdHJpbmcpOiBzdHJpbmcgPT4ge1xuICAgIGNvbnN0IHJ1bklkID0gYHJ1bi0ke0RhdGUubm93KCkudG9TdHJpbmcoMzYpfS0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDgpfWA7XG4gICAgdG91Y2goc2Vzc2lvbklkKTtcbiAgICBjb25zdCBzdGVwczogQXJyYXk8KCkgPT4gdm9pZD4gPSBbXTtcbiAgICBjb25zdCB3YWl0ID0gKGZuOiAoKSA9PiB2b2lkLCBtcyA9IHRhc2tEZWxheSk6IHZvaWQgPT4ge1xuICAgICAgY29uc3QgdCA9IHNldFRpbWVvdXQoZm4sIG1zKTtcbiAgICAgIHJ1blRpbWVycy5zZXQoYCR7c2Vzc2lvbklkfVxcMCR7cnVuSWR9YCwgdCk7XG4gICAgfTtcbiAgICBjb25zdCBjaGFpbiA9IChmbnM6IEFycmF5PCgpID0+IHZvaWQ+KTogdm9pZCA9PiB7XG4gICAgICBjb25zdCBbZmlyc3QsIC4uLnJlc3RdID0gZm5zO1xuICAgICAgaWYgKGZpcnN0ID09PSB1bmRlZmluZWQpIHJldHVybjtcbiAgICAgIHdhaXQoKCkgPT4ge1xuICAgICAgICBmaXJzdCgpO1xuICAgICAgICBjaGFpbihyZXN0KTtcbiAgICAgIH0pO1xuICAgIH07XG5cbiAgICBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICdydW4uc3RhcnRlZCcsIHsgdGFzazogdGV4dCwgbW9kZSB9KTtcbiAgICBpZiAoZmFpbFRhc2tzKSB7XG4gICAgICB3YWl0KCgpID0+IGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ3J1bi5mYWlsZWQnLCB7XG4gICAgICAgIGVycm9yOiB7IGNvZGU6ICdBVVRIX0ZBSUxFRCcsIG1lc3NhZ2U6ICdzaW11bGF0ZWQgcHJvdmlkZXIgYXV0aCBmYWlsdXJlJywgcmV0cnlhYmxlOiBmYWxzZSB9LFxuICAgICAgfSkpO1xuICAgICAgcmV0dXJuIHJ1bklkO1xuICAgIH1cblxuICAgIGNvbnN0IGZpbmlzaFJ1biA9IChhbnN3ZXI6IHN0cmluZywgdG9vbFVzZXM6IG51bWJlcik6IHZvaWQgPT4ge1xuICAgICAgcnVuVGltZXJzLmRlbGV0ZShgJHtzZXNzaW9uSWR9XFwwJHtydW5JZH1gKTtcbiAgICAgIC8vIFx1NEVBNFx1NEVEOFx1NzI2OVx1NTE0OFx1NEU4RVx1N0VDOFx1NjAwMShcdTRFMEUgaG1oYXJuZXNzIGRlc2t0b3AgXHU2ODY1XHU1NDBDXHU1RThGOmFydGlmYWN0LmNyZWF0ZWQgXHUyMTkyIHJ1bi5jb21wbGV0ZWQpXG4gICAgICBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICdhcnRpZmFjdC5jcmVhdGVkJywge1xuICAgICAgICBhcnRpZmFjdDogeyByZWxQYXRoOiAnb3V0LnR4dCcsIGtpbmQ6ICdmaWxlJywgdGl0bGU6ICdvdXQudHh0JyB9LFxuICAgICAgfSk7XG4gICAgICBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICdydW4uY29tcGxldGVkJywgeyB0ZXh0OiBhbnN3ZXIsIHR1cm5zOiAxLCB0b29sVXNlcyB9KTtcbiAgICB9O1xuXG4gICAgY29uc3Qgc2NyaXB0ZWQ6IEFycmF5PCgpID0+IHZvaWQ+ID0gW1xuICAgICAgKCkgPT4gZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAndG9vbC5zdGFydGVkJywgeyBuYW1lOiAncmVhZF9maWxlJywgYXJnc1ByZXZpZXc6ICd7XCJwYXRoXCI6XCJSRUFETUUubWRcIn0nIH0pLFxuICAgICAgKCkgPT4gZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAndG9vbC5jb21wbGV0ZWQnLCB7IG5hbWU6ICdyZWFkX2ZpbGUnLCBpc0Vycm9yOiBmYWxzZSwgb3V0cHV0UHJldmlldzogJyMgZGVtbycgfSksXG4gICAgXTtcblxuICAgIGlmIChtb2RlID09PSAnYXNrJykge1xuICAgICAgc2NyaXB0ZWQucHVzaCgoKSA9PiB7XG4gICAgICAgIGNvbnN0IGFwcHJvdmFsSWQgPSBgYXAtJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCA4KX1gO1xuICAgICAgICBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICdhcHByb3ZhbC5yZXF1aXJlZCcsIHtcbiAgICAgICAgICBhcHByb3ZhbElkLFxuICAgICAgICAgIHRvb2w6ICd3cml0ZV9maWxlJyxcbiAgICAgICAgICBhcmdzUHJldmlldzogJ3tcInBhdGhcIjpcIm91dC50eHRcIixcImNvbnRlbnRcIjpcImhpXCJ9JyxcbiAgICAgICAgICByaXNrOiAnXHU1MTk5XHU1MTY1XHU1REU1XHU0RjVDXHU1MzNBXHU2NTg3XHU0RUY2IG91dC50eHQoXHU2QTIxXHU2MkRGKScsXG4gICAgICAgIH0pO1xuICAgICAgICBwZW5kaW5nID0ge1xuICAgICAgICAgIHNlc3Npb25JZCxcbiAgICAgICAgICBhcHByb3ZhbElkLFxuICAgICAgICAgIHJlc29sdmU6IChncmFudGVkKSA9PiB7XG4gICAgICAgICAgICBwZW5kaW5nID0gbnVsbDtcbiAgICAgICAgICAgIGlmIChncmFudGVkKSB7XG4gICAgICAgICAgICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ3Rvb2wuc3RhcnRlZCcsIHsgbmFtZTogJ3dyaXRlX2ZpbGUnLCBhcmdzUHJldmlldzogJ3tcInBhdGhcIjpcIm91dC50eHRcIn0nIH0pO1xuICAgICAgICAgICAgICB3YWl0KCgpID0+IGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ3Rvb2wuY29tcGxldGVkJywgeyBuYW1lOiAnd3JpdGVfZmlsZScsIGlzRXJyb3I6IGZhbHNlLCBvdXRwdXRQcmV2aWV3OiAnd3JvdGUgMiBieXRlcycgfSkpO1xuICAgICAgICAgICAgICB3YWl0KCgpID0+IGZpbmlzaFJ1bihgZWNobzogJHt0ZXh0fShcdTVERjJcdTYyNjdcdTg4NENcdTUxOTlcdTUxNjUpYCwgMyksIHRhc2tEZWxheSAqIDIpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgZmluaXNoUnVuKGBlY2hvOiAke3RleHR9KFx1NUJBMVx1NjI3OVx1ODhBQlx1NjJEMlx1N0VERCxcdTY3MkFcdTYyNjdcdTg4NENcdTUxOTlcdTUxNjUpYCwgMSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSxcbiAgICAgICAgfTtcbiAgICAgIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICBzY3JpcHRlZC5wdXNoKCgpID0+IGZpbmlzaFJ1bihgZWNobzogJHt0ZXh0fWAsIDEpKTtcbiAgICB9XG4gICAgY2hhaW4oc2NyaXB0ZWQpO1xuICAgIHJldHVybiBydW5JZDtcbiAgfTtcblxuICBjb25zdCBzZXJ2ZXIgPSBjcmVhdGVTZXJ2ZXIoKHJlcSwgcmVzKSA9PiB7XG4gICAgY29uc3QgdXJsID0gbmV3IFVSTChyZXEudXJsID8/ICcvJywgJ2h0dHA6Ly8xMjcuMC4wLjEnKTtcbiAgICBjb25zdCBhdXRob3JpemVkID0gcmVxLmhlYWRlcnNbJ3gtaG1oLWtleSddID09PSBleHBlY3RlZDtcbiAgICBjb25zdCBkZW55ID0gKCk6IHZvaWQgPT4ge1xuICAgICAgcmVzLndyaXRlSGVhZCg0MDEsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdBVVRIX0ZBSUxFRCcsICdtaXNzaW5nIG9yIGludmFsaWQgeC1obWgta2V5JywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgfTtcblxuICAgIGNvbnN0IHJlYWRCb2R5ID0gKCk6IFByb21pc2U8c3RyaW5nPiA9PlxuICAgICAgbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcbiAgICAgICAgbGV0IGIgPSAnJztcbiAgICAgICAgcmVxLm9uKCdkYXRhJywgKGM6IEJ1ZmZlcikgPT4geyBiICs9IGMudG9TdHJpbmcoKTsgfSk7XG4gICAgICAgIHJlcS5vbignZW5kJywgKCkgPT4gcmVzb2x2ZShiKSk7XG4gICAgICB9KTtcblxuICAgIGlmICh1cmwucGF0aG5hbWUgPT09ICcvYXBpL2V2ZW50cycpIHtcbiAgICAgIGlmICghYXV0aG9yaXplZCkgeyBkZW55KCk7IHJldHVybjsgfVxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICd0ZXh0L2V2ZW50LXN0cmVhbScsICdjYWNoZS1jb250cm9sJzogJ25vLWNhY2hlJywgY29ubmVjdGlvbjogJ2tlZXAtYWxpdmUnIH0pO1xuICAgICAgcmVzLmZsdXNoSGVhZGVycz8uKCk7XG4gICAgICBzc2VDbGllbnRzLmFkZChyZXMpO1xuICAgICAgLy8gXHU2NUFEXHU3RUJGXHU4ODY1XHU2MkM5Okxhc3QtRXZlbnQtSUQgXHU0RTRCXHU1MjREXHU3Njg0XHU1RTI3XHU1REYyXHU1NzI4XHU1QkEyXHU2MjM3XHU3QUVGLFx1OTFDRFx1NTNEMVx1NTE3Nlx1NTQwRVx1NzY4NFx1NzNBRlx1NUY2Mlx1N0YxM1x1NTFCMlxuICAgICAgY29uc3QgbGFzdElkID0gTnVtYmVyKHJlcS5oZWFkZXJzWydsYXN0LWV2ZW50LWlkJ10gPz8gMCk7XG4gICAgICBpZiAoTnVtYmVyLmlzRmluaXRlKGxhc3RJZCkgJiYgbGFzdElkID4gMCkge1xuICAgICAgICBmb3IgKGNvbnN0IGUgb2YgcmluZykge1xuICAgICAgICAgIGlmIChlLmlkID4gbGFzdElkKSByZXMud3JpdGUoYGlkOiAke2UuaWR9XFxuZXZlbnQ6ICR7ZS5ldmVudH1cXG5kYXRhOiAke0pTT04uc3RyaW5naWZ5KGUuZGF0YSl9XFxuXFxuYCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIHJlcS5vbignY2xvc2UnLCAoKSA9PiBzc2VDbGllbnRzLmRlbGV0ZShyZXMpKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKCFhdXRob3JpemVkKSB7IGRlbnkoKTsgcmV0dXJuOyB9XG5cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9zdGF0ZScpIHtcbiAgICAgIC8vIHByb3ZpZGVyc0RldGFpbDpcdTRFMEUgaG1oYXJuZXNzIFx1NTQwQ1x1NUY2Mlx1MjAxNFx1MjAxNGtleSBcdTUzRUFcdTUxRkEgaGFzS2V5L1x1NjcyQlx1NTZEQlx1NEY0RCxcdTZDMzhcdTRFMERcdTY2MEVcdTY1ODdcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgZGFlbW9uVmVyc2lvbjogJ2Zha2UtMC4wLjAnLCBkZXNrdG9wOiB0cnVlLCBtb2RlbDogZmFrZVByb3ZpZGVycy5nZXQoZmFrZUNoYXRQcm92aWRlcik/Lm1vZGVsID8/ICdmYWtlLW1vZGVsJyxcbiAgICAgICAgY2hhdFByb3ZpZGVyOiBmYWtlQ2hhdFByb3ZpZGVyLCBsb2NhbGU6ICd6aCcsXG4gICAgICAgIGJ1c3lTZXNzaW9uczogWy4uLnNlc3Npb25zLmtleXMoKV0uc2xpY2UoMCwgMiksXG4gICAgICAgIGFwcHJvdmFsUGVuZGluZzogcGVuZGluZyAhPT0gbnVsbCxcbiAgICAgICAgc2V0dGluZ3M6IHsgYXBwcm92YWw6ICdhc2snIH0sXG4gICAgICAgIHdvcmtzcGFjZTogZmFrZVdvcmtzcGFjZXMuaXRlbXMuZmluZCgodykgPT4gdy5pZCA9PT0gZmFrZVdvcmtzcGFjZXMuY3VycmVudCkgPz8gbnVsbCxcbiAgICAgICAgcHJvdmlkZXJzRGV0YWlsOiBbLi4uZmFrZVByb3ZpZGVycy5lbnRyaWVzKCldLm1hcCgoW25hbWUsIHBdKSA9PiAoe1xuICAgICAgICAgIG5hbWUsIG1vZGVsOiBwLm1vZGVsLCBiYXNlVXJsOiBwLmJhc2VVcmwsXG4gICAgICAgICAgaGFzS2V5OiBwLmFwaUtleSAhPT0gJycsXG4gICAgICAgICAga2V5VGFpbDogcC5hcGlLZXkubGVuZ3RoID49IDQgPyBwLmFwaUtleS5zbGljZSgtNCkgOiB1bmRlZmluZWQsXG4gICAgICAgICAgcHVycG9zZXM6IFsnY2hhdCddLFxuICAgICAgICB9KSksXG4gICAgICB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9kZXNrdG9wL3NodXRkb3duJykge1xuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSB9KSk7XG4gICAgICBzZXJ2ZXIuY2xvc2UoKCkgPT4gcHJvY2Vzcy5leGl0KDApKTtcbiAgICAgIHNldFRpbWVvdXQoKCkgPT4gcHJvY2Vzcy5leGl0KDApLCAxXzAwMCkudW5yZWYoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2Zha2UvZGllJykge1xuICAgICAgLy8gXHU2RDRCXHU4QkQ1XHU5NEE5XHU1QjUwOlx1NkEyMVx1NjJERiBob3N0IFx1NUQyOVx1NkU4MyhcdTUxNDhcdTVFOTRcdTdCNTRcdTUxOERcdTkwMDBcdTUxRkEsXHU0RkREXHU4QkMxXHU1NENEXHU1RTk0XHU1REYyXHU1M0QxXHU1MUZBKVxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSB9KSk7XG4gICAgICBzZXRUaW1lb3V0KCgpID0+IHByb2Nlc3MuZXhpdCgxKSwgNTApO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvbW9kZWwnKSB7XG4gICAgICAvLyBcdTZBMjFcdTU3OEJcdTUyMDdcdTYzNjIoXHU0RTBFIGhtaGFybmVzcyAvYXBpL21vZGVsIFx1NTQwQ1x1NUY2MjpcdTUyMDcgY2hhdCBcdThERUZcdTc1MzEpXG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7IG5hbWU/OiB1bmtub3duIH07XG4gICAgICAgIGNvbnN0IG5hbWUgPSB0eXBlb2YgYm9keS5uYW1lID09PSAnc3RyaW5nJyA/IGJvZHkubmFtZS50cmltKCkgOiAnJztcbiAgICAgICAgaWYgKCFmYWtlUHJvdmlkZXJzLmhhcyhuYW1lKSkge1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICdwcm92aWRlciBub3QgZm91bmQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgZmFrZUNoYXRQcm92aWRlciA9IG5hbWU7XG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgbW9kZWw6IGZha2VQcm92aWRlcnMuZ2V0KG5hbWUpPy5tb2RlbCB9KSk7XG4gICAgICB9KSgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvdGFzaycpIHtcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgoYXdhaXQgcmVhZEJvZHkoKSkgfHwgJ3t9JykgYXMgeyB0ZXh0PzogdW5rbm93bjsgc2Vzc2lvbklkPzogdW5rbm93bjsgbW9kZT86IHVua25vd247IGF0dGFjaG1lbnRzPzogdW5rbm93bjsgaW1hZ2VzPzogdW5rbm93biB9O1xuICAgICAgICAgIGNvbnN0IHRleHQgPSB0eXBlb2YgYm9keS50ZXh0ID09PSAnc3RyaW5nJyA/IGJvZHkudGV4dCA6ICcnO1xuICAgICAgICAgIGNvbnN0IHNlc3Npb25JZCA9IHR5cGVvZiBib2R5LnNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBib2R5LnNlc3Npb25JZCA6IGB3ZWItJHtEYXRlLm5vdygpLnRvU3RyaW5nKDM2KX1gO1xuICAgICAgICAgIGNvbnN0IG1vZGUgPSBib2R5Lm1vZGUgPT09ICdhc2snIHx8IGJvZHkubW9kZSA9PT0gJ2F1dG8nIHx8IGJvZHkubW9kZSA9PT0gJ3lvbG8nID8gYm9keS5tb2RlIDogJ2Fzayc7XG4gICAgICAgICAgY29uc3QgYXR0YWNobWVudHMgPSBBcnJheS5pc0FycmF5KGJvZHkuYXR0YWNobWVudHMpID8gYm9keS5hdHRhY2htZW50cy5maWx0ZXIoKGEpOiBhIGlzIHN0cmluZyA9PiB0eXBlb2YgYSA9PT0gJ3N0cmluZycpIDogW107XG4gICAgICAgICAgLy8gXHU1NkZFXHU3MjQ3XHU5NjQ0XHU0RUY2Olx1NEUwRSBobWhhcm5lc3MgdmlzaW9uIFx1NTM0Rlx1OEJBRVx1NTQwQ1x1NUY2Mih7bmFtZSxkYXRhVXJsfSk7ZmFrZSBcdTY4MjFcdTlBOENcdTVGNjJcdTcyQjZcdTUzNzNcdTY1MzZcbiAgICAgICAgICBjb25zdCBpbWFnZXMgPSBBcnJheS5pc0FycmF5KGJvZHkuaW1hZ2VzKVxuICAgICAgICAgICAgPyBib2R5LmltYWdlcy5maWx0ZXIoKGltKTogaW0gaXMgeyBuYW1lOiBzdHJpbmc7IGRhdGFVcmw6IHN0cmluZyB9ID0+IHtcbiAgICAgICAgICAgICAgICBpZiAodHlwZW9mIGltICE9PSAnb2JqZWN0JyB8fCBpbSA9PT0gbnVsbCkgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgICAgIGNvbnN0IG8gPSBpbSBhcyB7IG5hbWU/OiB1bmtub3duOyBkYXRhVXJsPzogdW5rbm93biB9O1xuICAgICAgICAgICAgICAgIHJldHVybiB0eXBlb2Ygby5uYW1lID09PSAnc3RyaW5nJyAmJiB0eXBlb2Ygby5kYXRhVXJsID09PSAnc3RyaW5nJyAmJiBvLmRhdGFVcmwuc3RhcnRzV2l0aCgnZGF0YTppbWFnZS8nKTtcbiAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgIDogW107XG4gICAgICAgICAgaWYgKCF0ZXh0KSB7XG4gICAgICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICd0ZXh0IHJlcXVpcmVkJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIFx1NEUwRSBobWhhcm5lc3MgXHU1NDBDXHU4QkVEXHU0RTQ5Olx1NTQwOFx1NkNENVx1OTY0NFx1NEVGNlx1NEVFNSBbcmVmZXJlbmNlZCBmaWxlc10gXHU1MjREXHU3RjAwXHU1RTc2XHU1MTY1XHU0RUZCXHU1MkExXHU2NTg3XHU2NzJDO1xuICAgICAgICAgIC8vIFx1NTZGRVx1NzI0N1x1NEVFNSBbaW1hZ2VzXSBcdTUyNERcdTdGMDBcdTY4MDdcdTZDRThcdTVGMjBcdTY1NzAodmlzaW9uIFx1NjNDRlx1OEZGMFx1OTRGRVx1NTcyOFx1NzcxRlx1NUI5RSBydW50aW1lIFx1OTFDQ1x1NTNEMVx1NzUxRilcbiAgICAgICAgICBjb25zdCBjb21wb3NlZCA9IGF0dGFjaG1lbnRzLmxlbmd0aCA+IDBcbiAgICAgICAgICAgID8gYFtyZWZlcmVuY2VkIGZpbGVzXVxcbiR7YXR0YWNobWVudHMubWFwKChhKSA9PiBgLSAke2Euc3BsaXQoL1tcXFxcL10vKS5wb3AoKX1gKS5qb2luKCdcXG4nKX1cXG5cXG4ke3RleHR9YFxuICAgICAgICAgICAgOiB0ZXh0O1xuICAgICAgICAgIGNvbnN0IHdpdGhJbWFnZXMgPSBpbWFnZXMubGVuZ3RoID4gMCA/IGBbaW1hZ2VzOiAke2ltYWdlcy5sZW5ndGh9XVxcbiR7Y29tcG9zZWR9YCA6IGNvbXBvc2VkO1xuICAgICAgICAgIGNvbnN0IHJ1bklkID0gcnVuVGFzayhzZXNzaW9uSWQsIHdpdGhJbWFnZXMsIG1vZGUpO1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlLCBydW5JZCwgaW1hZ2VzOiBpbWFnZXMubGVuZ3RoIH0pKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgU3RyaW5nKGVycikuc2xpY2UoMCwgMTIwKSwgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgIH1cbiAgICAgIH0pKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9hcHByb3ZlJykge1xuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgoYXdhaXQgcmVhZEJvZHkoKSkgfHwgJ3t9JykgYXMgeyBncmFudGVkPzogdW5rbm93bjsgc2Vzc2lvbklkPzogdW5rbm93biB9O1xuICAgICAgICBjb25zdCBzaWQgPSB0eXBlb2YgYm9keS5zZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gYm9keS5zZXNzaW9uSWQgOiAnJztcbiAgICAgICAgaWYgKHBlbmRpbmcgPT09IG51bGwgfHwgKHNpZCAhPT0gJycgJiYgcGVuZGluZy5zZXNzaW9uSWQgIT09IHNpZCkpIHtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnbm8gYXBwcm92YWwgcGVuZGluZycsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBwID0gcGVuZGluZztcbiAgICAgICAgcGVuZGluZyA9IG51bGw7XG4gICAgICAgIHAucmVzb2x2ZShib2R5LmdyYW50ZWQgPT09IHRydWUpO1xuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIGdyYW50ZWQ6IGJvZHkuZ3JhbnRlZCA9PT0gdHJ1ZSB9KSk7XG4gICAgICB9KSgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZS5zdGFydHNXaXRoKCcvYXBpL3Nlc3Npb25zLycpICYmICh1cmwucGF0aG5hbWUuZW5kc1dpdGgoJy9hcmNoaXZlJykgfHwgdXJsLnBhdGhuYW1lLmVuZHNXaXRoKCcvZGVsZXRlJykpKSB7XG4gICAgICAvLyBcdTRGMUFcdThCRERcdTVGNTJcdTY4NjMvXHU1MjIwXHU5NjY0KGhtaGFybmVzcyBcdTU0MENcdTVGNjI6XHU3OUZCXHU1MTY1IGFyY2hpdmUvdHJhc2gsXHU1M0VGXHU2MDYyXHU1OTBELFx1NEUwRFx1Nzg2Q1x1NTIyMClcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgcGFydHMgPSB1cmwucGF0aG5hbWUuc2xpY2UoJy9hcGkvc2Vzc2lvbnMvJy5sZW5ndGgpLnNwbGl0KCcvJyk7XG4gICAgICAgIGNvbnN0IG9wID0gcGFydHNbMV0gPz8gJyc7XG4gICAgICAgIGNvbnN0IG9pZCA9IGRlY29kZVVSSUNvbXBvbmVudChwYXJ0c1swXSA/PyAnJykucmVwbGFjZSgvW15hLXpBLVowLTlfOi5ALV0vZywgJycpO1xuICAgICAgICBpZiAob2lkID09PSAnJyB8fCAob3AgIT09ICdhcmNoaXZlJyAmJiBvcCAhPT0gJ2RlbGV0ZScpKSB7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ2JhZCBvcCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIXNlc3Npb25zLmhhcyhvaWQpKSB7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3Nlc3Npb24gbm90IGZvdW5kJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHNlc3Npb25zLmRlbGV0ZShvaWQpO1xuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUgfSkpO1xuICAgICAgfSkoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2luamVjdCcpIHtcbiAgICAgIC8vIFx1OEZEMFx1ODg0Q1x1NEUyRFx1NkNFOFx1NTE2NShcdTRFMEUgaG1oYXJuZXNzIC9hcGkvaW5qZWN0IFx1NTQwQ1x1NUY2MjtmYWtlIFx1NTNFQVx1NTZERVx1NjI2NylcbiAgICAgIHZvaWQgcmVhZEJvZHkoKTtcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUgfSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvaW50ZXJydXB0Jykge1xuICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoJycpIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+OyAvLyBpbnRlcnJ1cHQgXHU2NUUwIGJvZHkgXHU4QkVEXHU0RTQ5XG4gICAgICB2b2lkIGJvZHk7XG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlIH0pKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvc2Vzc2lvbnMnKSB7XG4gICAgICBjb25zdCBsaXN0ID0gWy4uLnNlc3Npb25zLnZhbHVlcygpXS5tYXAoKHMpID0+ICh7XG4gICAgICAgIGlkOiBzLmlkLCB0aXRsZTogJycsIHRhc2s6ICcnLCBvdXRjb21lOiAnb2snLCB0dXJuczogMSwgdG9vbFVzZXM6IDEsXG4gICAgICAgIHRpbWU6IHMudXBkYXRlZEF0LCBjd2Q6ICdDOlxcXFxkZW1vJywgYnJhbmNoOiAnJywgY3JlYXRlZEF0OiBzLmNyZWF0ZWRBdCwgdXBkYXRlZEF0OiBzLnVwZGF0ZWRBdCxcbiAgICAgIH0pKTtcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgc2Vzc2lvbnM6IGxpc3QsIG5leHRDdXJzb3I6IG51bGwgfSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lLnN0YXJ0c1dpdGgoJy9hcGkvc2Vzc2lvbnMvJykpIHtcbiAgICAgIGNvbnN0IHNlZyA9IGRlY29kZVVSSUNvbXBvbmVudCh1cmwucGF0aG5hbWUuc2xpY2UoJy9hcGkvc2Vzc2lvbnMvJy5sZW5ndGgpKTtcbiAgICAgIC8vIFx1NUJGQ1x1NTFGQShcdTRFMEUgaG1oYXJuZXNzIC9hcGkvc2Vzc2lvbnMvOmlkL2V4cG9ydC5tZCBcdTU0MENcdTVGNjI6dGV4dC9tYXJrZG93biBcdTRFMEJcdThGN0QpXG4gICAgICBjb25zdCBleHBvcnRNYXRjaCA9IC9eKC4qKVxcL2V4cG9ydFxcLm1kJC8uZXhlYyhzZWcpID8/IC9eKC4qKVxcLmV4cG9ydFxcLm1kJC8uZXhlYyhzZWcpO1xuICAgICAgaWYgKGV4cG9ydE1hdGNoICE9PSBudWxsICYmIGV4cG9ydE1hdGNoWzFdICE9PSB1bmRlZmluZWQgJiYgZXhwb3J0TWF0Y2hbMV0gIT09ICcnKSB7XG4gICAgICAgIGNvbnN0IGVpZCA9IGV4cG9ydE1hdGNoWzFdLnJlcGxhY2UoL1teYS16QS1aMC05XzouQC1dL2csICcnKTtcbiAgICAgICAgY29uc3QgZXMgPSBzZXNzaW9ucy5nZXQoZWlkKTtcbiAgICAgICAgaWYgKGVzID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnc2Vzc2lvbiBub3QgZm91bmQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICd0ZXh0L21hcmtkb3duOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgcmVzLmVuZChgIyBobWhhcm5lc3MgXHU0RjFBXHU4QkREXHU1QkZDXHU1MUZBKGZha2UpXFxuXFxuLSBcdTRGMUFcdThCREQ6JHtlaWR9XFxuXFxuIyMgXHU3NTI4XHU2MjM3XFxuXFxuXHU0RTRCXHU1MjREXHU3Njg0XHU0RUZCXHU1MkExKGZha2UgXHU5ODg0XHU4OUM4KVxcblxcbiMjIFx1NTJBOVx1NjI0Qlxcblxcblx1OEZEOVx1NjYyRlx1NUJGQ1x1NTFGQVx1NzY4NFx1NTZERVx1NTkwRFx1OTg4NFx1ODlDOChmYWtlKVx1MzAwMlxcbmApO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICAvLyBcdTRGMUFcdThCRERcdTk4ODRcdTg5QzgoXHU0RTBFIGhtaGFybmVzcyBHRVQgL2FwaS9zZXNzaW9ucy86aWQgXHU1NDBDXHU1RjYyOlx1NjcwMFx1NTQwRSA4MCBcdTY3NjEsXHU2QkNGXHU2NzYxIDUwMCBcdTVCNTcpXG4gICAgICBjb25zdCBpZCA9IHNlZy5yZXBsYWNlKC9bXmEtekEtWjAtOV86LkAtXS9nLCAnJyk7XG4gICAgICBjb25zdCBzID0gc2Vzc2lvbnMuZ2V0KGlkKTtcbiAgICAgIGlmIChzID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICdzZXNzaW9uIG5vdCBmb3VuZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIGlkLCBtb2RlbDogJ2Zha2UtbW9kZWwnLCBjd2Q6ICdDOlxcXFxkZW1vJyxcbiAgICAgICAgbWVzc2FnZXM6IFtcbiAgICAgICAgICB7IHJvbGU6ICd1c2VyJywgdGV4dDogJ1x1NEU0Qlx1NTI0RFx1NzY4NFx1NEVGQlx1NTJBMShmYWtlIFx1OTg4NFx1ODlDOCknLCB0b29sczogW10gfSxcbiAgICAgICAgICB7IHJvbGU6ICdhc3Npc3RhbnQnLCB0ZXh0OiAnXHU4RkQ5XHU2NjJGXHU1Mzg2XHU1M0YyXHU0RjFBXHU4QkREXHU3Njg0XHU1NkRFXHU1OTBEXHU5ODg0XHU4OUM4KGZha2UpXHUzMDAyJywgdG9vbHM6IFsncmVhZF9maWxlJ10gfSxcbiAgICAgICAgXSxcbiAgICAgIH0pKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZnMnKSB7XG4gICAgICAvLyBcdTc2RUVcdTVGNTVcdTZENEZcdTg5QzgoXHU0RTBFIGhtaGFybmVzcyBcdTU0MENcdTVGNjI6cGF0aCBcdTc3MDFcdTc1NjU9XHU2ODM5O2ZpbGVzPTEgXHU5NjQ0XHU1RTI2XHU2NTg3XHU0RUY2XHU1MjE3XHU4ODY4KVxuICAgICAgY29uc3QgcSA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KCdwYXRoJykgPz8gJyc7XG4gICAgICBjb25zdCB3aXRoRmlsZXMgPSB1cmwuc2VhcmNoUGFyYW1zLmdldCgnZmlsZXMnKSA9PT0gJzEnO1xuICAgICAgaWYgKHEgPT09ICcnKSB7XG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgIHBhdGg6ICcnLCBzZWdtZW50czogW10sIHBhcmVudDogJycsXG4gICAgICAgICAgZGlyczogW3sgbmFtZTogJ2RlbW8td29ya3NwYWNlJywgcGF0aDogJ0M6XFxcXGRlbW8nIH1dLFxuICAgICAgICAgIC4uLih3aXRoRmlsZXMgPyB7IGZpbGVzOiBbXSB9IDoge30pLFxuICAgICAgICB9KSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgcGF0aDogcSwgc2VnbWVudHM6IFt7IG5hbWU6IHEuc3BsaXQoL1tcXFxcL10vKS5maWx0ZXIoQm9vbGVhbikucG9wKCkgPz8gcSwgcGF0aDogcSB9XSwgcGFyZW50OiAnJyxcbiAgICAgICAgZGlyczogW3sgbmFtZTogJ3NyYycsIHBhdGg6IGAke3EucmVwbGFjZSgvW1xcXFwvXSQvLCAnJyl9XFxcXHNyY2AgfV0sXG4gICAgICAgIC4uLih3aXRoRmlsZXMgPyB7IGZpbGVzOiBbXG4gICAgICAgICAgeyBuYW1lOiAnUkVBRE1FLm1kJywgcGF0aDogYCR7cS5yZXBsYWNlKC9bXFxcXC9dJC8sICcnKX1cXFxcUkVBRE1FLm1kYCwgcmVsOiAnUkVBRE1FLm1kJyB9LFxuICAgICAgICAgIHsgbmFtZTogJ3BhY2thZ2UuanNvbicsIHBhdGg6IGAke3EucmVwbGFjZSgvW1xcXFwvXSQvLCAnJyl9XFxcXHBhY2thZ2UuanNvbmAsIHJlbDogJ3BhY2thZ2UuanNvbicgfSxcbiAgICAgICAgXSB9IDoge30pLFxuICAgICAgfSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9mcy9yZWFkJykge1xuICAgICAgLy8gXHU2NTg3XHU0RUY2XHU5ODg0XHU4OUM4KDY0S0IgXHU0RTBBXHU5NjUwXHU4QkVEXHU0RTQ5O2Zha2UgXHU4RkQ0XHU1NkRFXHU1NkZBXHU1QjlBXHU2NTg3XHU2NzJDKVxuICAgICAgY29uc3QgcCA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KCdwYXRoJykgPz8gJyc7XG4gICAgICBpZiAocCA9PT0gJycpIHtcbiAgICAgICAgcmVzLndyaXRlSGVhZCg0MDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICdwYXRoIHJlcXVpcmVkJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgcGF0aDogcCwgcmVsOiBwLnNwbGl0KC9bXFxcXC9dLykucG9wKCkgPz8gcCwgc2l6ZTogNDIsXG4gICAgICAgIHRleHQ6ICcjIGRlbW8gd29ya3NwYWNlXFxuXFxuXHU4RkQ5XHU2NjJGIGZha2UgaG9zdCBcdTc2ODRcdTY1ODdcdTRFRjZcdTk4ODRcdTg5QzhcdTUxODVcdTVCQjlcdTMwMDJcXG4nLFxuICAgICAgfSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9kaWZmJykge1xuICAgICAgLy8gRGlmZiBcdTk3NjJcdTY3N0YoXHU0RTBFIGhtaGFybmVzcyAvYXBpL2RpZmYgXHU1NDBDXHU1RjYyO2Zha2UgXHU4RkQ0XHU1NkRFXHU1NkZBXHU1QjlBXHU1QzBGXHU1M0Q4XHU2NkY0XHU5NkM2KVxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBnaXQ6IHRydWUsIGN3ZDogJ0M6XFxcXGRlbW8nLFxuICAgICAgICBjaGFuZ2VkOiBbXG4gICAgICAgICAgeyBzdGF0ZTogJ00nLCBwYXRoOiAnc3JjL2FwcC50cycgfSxcbiAgICAgICAgICB7IHN0YXRlOiAnQScsIHBhdGg6ICdkb2NzL25vdGVzLm1kJyB9LFxuICAgICAgICBdLFxuICAgICAgICBzdGF0OiAnIHNyYy9hcHAudHMgICAgICB8IDEyICsrKysrKystLS1cXG4gZG9jcy9ub3Rlcy5tZCAgIHwgIDQgKysrK1xcbiAyIGZpbGVzIGNoYW5nZWQsIDE2IGluc2VydGlvbnMoKyksIDMgZGVsZXRpb25zKC0pJyxcbiAgICAgIH0pKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvd29ya3NwYWNlcycpIHtcbiAgICAgIC8vIFx1NURFNVx1NEY1Q1x1NTMzQShcdTRFMEUgaG1oYXJuZXNzIFx1NTQwQ1x1NUY2MjpjdXJyZW50ICsgaXRlbXMpXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIGN1cnJlbnQ6IGZha2VXb3Jrc3BhY2VzLmN1cnJlbnQsXG4gICAgICAgIGl0ZW1zOiBmYWtlV29ya3NwYWNlcy5pdGVtcyxcbiAgICAgIH0pKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3dvcmtzcGFjZXMnKSB7XG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7IG5hbWU/OiB1bmtub3duOyBwYXRoPzogdW5rbm93biB9O1xuICAgICAgICBjb25zdCBwYXRoID0gdHlwZW9mIGJvZHkucGF0aCA9PT0gJ3N0cmluZycgPyBib2R5LnBhdGggOiAnJztcbiAgICAgICAgY29uc3QgbmFtZSA9IHR5cGVvZiBib2R5Lm5hbWUgPT09ICdzdHJpbmcnICYmIGJvZHkubmFtZSAhPT0gJycgPyBib2R5Lm5hbWUgOiAocGF0aC5zcGxpdCgvW1xcXFwvXS8pLmZpbHRlcihCb29sZWFuKS5wb3AoKSA/PyAnJyk7XG4gICAgICAgIGlmIChwYXRoID09PSAnJyB8fCBuYW1lID09PSAnJykge1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICdhYnNvbHV0ZSBwYXRoIGFuZCBuYW1lIHJlcXVpcmVkJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGlmIChmYWtlV29ya3NwYWNlcy5pdGVtcy5zb21lKCh3KSA9PiB3LnBhdGgudG9Mb3dlckNhc2UoKSA9PT0gcGF0aC50b0xvd2VyQ2FzZSgpKSkge1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA5LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICd3b3Jrc3BhY2UgYWxyZWFkeSByZWdpc3RlcmVkJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGl0ZW0gPSB7IGlkOiBgd3MtJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCA4KX1gLCBuYW1lLCBwYXRoIH07XG4gICAgICAgIGZha2VXb3Jrc3BhY2VzLml0ZW1zLnB1c2goaXRlbSk7XG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgY3VycmVudDogZmFrZVdvcmtzcGFjZXMuY3VycmVudCwgaXRlbXM6IGZha2VXb3Jrc3BhY2VzLml0ZW1zIH0pKTtcbiAgICAgIH0pKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS93b3Jrc3BhY2VzL3VzZScpIHtcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoKGF3YWl0IHJlYWRCb2R5KCkpIHx8ICd7fScpIGFzIHsgaWQ/OiB1bmtub3duIH07XG4gICAgICAgIGNvbnN0IGhpdCA9IGZha2VXb3Jrc3BhY2VzLml0ZW1zLmZpbmQoKHcpID0+IHcuaWQgPT09IGJvZHkuaWQpO1xuICAgICAgICBpZiAoaGl0ID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnd29ya3NwYWNlIG5vdCBmb3VuZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBmYWtlV29ya3NwYWNlcy5jdXJyZW50ID0gaGl0LmlkO1xuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIGN1cnJlbnQ6IGZha2VXb3Jrc3BhY2VzLmN1cnJlbnQsIGl0ZW1zOiBmYWtlV29ya3NwYWNlcy5pdGVtcyB9KSk7XG4gICAgICB9KSgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvcHJvdmlkZXJzJykge1xuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgoYXdhaXQgcmVhZEJvZHkoKSkgfHwgJ3t9JykgYXMgeyBuYW1lPzogdW5rbm93bjsgYmFzZVVybD86IHVua25vd247IG1vZGVsPzogdW5rbm93bjsgYXBpS2V5PzogdW5rbm93biB9O1xuICAgICAgICBjb25zdCBuYW1lID0gdHlwZW9mIGJvZHkubmFtZSA9PT0gJ3N0cmluZycgPyBib2R5Lm5hbWUudHJpbSgpIDogJyc7XG4gICAgICAgIGNvbnN0IGJhc2VVcmwgPSB0eXBlb2YgYm9keS5iYXNlVXJsID09PSAnc3RyaW5nJyA/IGJvZHkuYmFzZVVybC50cmltKCkgOiAnJztcbiAgICAgICAgY29uc3QgbW9kZWwgPSB0eXBlb2YgYm9keS5tb2RlbCA9PT0gJ3N0cmluZycgPyBib2R5Lm1vZGVsLnRyaW0oKSA6ICcnO1xuICAgICAgICBpZiAobmFtZSA9PT0gJycgfHwgYmFzZVVybCA9PT0gJycgfHwgbW9kZWwgPT09ICcnKSB7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ25hbWUsIGJhc2VVcmwgYW5kIG1vZGVsIGFyZSByZXF1aXJlZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBmYWtlUHJvdmlkZXJzLnNldChuYW1lLCB7IGJhc2VVcmwsIG1vZGVsLCBhcGlLZXk6IHR5cGVvZiBib2R5LmFwaUtleSA9PT0gJ3N0cmluZycgPyBib2R5LmFwaUtleSA6ICcnIH0pO1xuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIG5hbWUgfSkpO1xuICAgICAgfSkoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZnMvc2VhcmNoJykge1xuICAgICAgLy8gXHU1REU1XHU0RjVDXHU1MzNBXHU2NTg3XHU0RUY2XHU2NDFDXHU3RDIyKFx1NEUwRSBobWhhcm5lc3MgXHU1NDBDXHU1RjYyOkBcdTk2NDRcdTRFRjZcdTkwMDlcdTYyRTlcdTU2NjhcdTc2ODRcdTY1NzBcdTYzNkVcdTZFOTApXG4gICAgICBjb25zdCBxID0gKHVybC5zZWFyY2hQYXJhbXMuZ2V0KCdxJykgPz8gJycpLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuICAgICAgY29uc3QgYWxsID0gW1xuICAgICAgICB7IHJlbDogJ1JFQURNRS5tZCcsIHBhdGg6ICdDOlxcXFxkZW1vXFxcXFJFQURNRS5tZCcsIGtpbmQ6ICdmaWxlJyB9LFxuICAgICAgICB7IHJlbDogJ3NyYy9hcHAudHMnLCBwYXRoOiAnQzpcXFxcZGVtb1xcXFxzcmNcXFxcYXBwLnRzJywga2luZDogJ2ZpbGUnIH0sXG4gICAgICAgIHsgcmVsOiAnZG9jcy9ub3Rlcy5tZCcsIHBhdGg6ICdDOlxcXFxkZW1vXFxcXGRvY3NcXFxcbm90ZXMubWQnLCBraW5kOiAnZmlsZScgfSxcbiAgICAgIF07XG4gICAgICBjb25zdCBoaXRzID0gcSA9PT0gJycgPyBhbGwgOiBhbGwuZmlsdGVyKChmKSA9PiBmLnJlbC50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHEpKTtcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgcmVzdWx0czogaGl0cy5zbGljZSgwLCAyMCksIHRydW5jYXRlZDogZmFsc2UsIHRvdGFsOiBoaXRzLmxlbmd0aCB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2NvZ25pdGl2ZScpIHtcbiAgICAgIC8vIFx1OEJBNFx1NzdFNVx1NzJCNlx1NjAwMShcdTRFMEUgaG1oYXJuZXNzIGNvZ25pdGl2ZVN0YXR1cyBcdTU0MENcdTVGNjJcdTVCNTBcdTk2QzY7XHU3RjNBXHU2NTcwXHU2MzZFXHU2NjNFXHU1RjBGIG51bGwpXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIG1lbW9yeTogeyBsYXllcnM6IDMsIGVudHJpZXM6IDEyLCBjb250cmFkaWN0aW9uczogMCB9LFxuICAgICAgICB0cmFqZWN0b3JpZXM6IDcsXG4gICAgICAgIGF1ZGl0RXZlbnRzOiAyMSxcbiAgICAgICAgd29ybGRNb2RlbDogeyB2ZXJzaW9uOiA0LCBiZWxpZWZzOiA5LCB0cnVzdGVkOiA1LCBicmllcjogMC4zMSB9LFxuICAgICAgICBjYWxpYnJhdGlvbjogeyBwcmVkaWN0aW9uczogNDYsIHJlbGlhYmlsaXR5OiAwLjcyIH0sXG4gICAgICB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9mYWtlL2VtaXQnKSB7XG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoKGF3YWl0IHJlYWRCb2R5KCkpIHx8ICd7fScpIGFzIHtcbiAgICAgICAgICAgIHNlc3Npb25JZDogc3RyaW5nOyBydW5JZDogc3RyaW5nOyBraW5kOiBFdmVudEtpbmQ7IHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgICAgIH07XG4gICAgICAgICAgY29uc3Qgc2VxID0gZW1pdChib2R5LnNlc3Npb25JZCwgYm9keS5ydW5JZCwgYm9keS5raW5kLCBib2R5LnBheWxvYWQpO1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlLCBzZXEgfSkpO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCBTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgfVxuICAgICAgfSkoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgYG5vIHJvdXRlICR7cmVxLm1ldGhvZH0gJHt1cmwucGF0aG5hbWV9YCwgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gIH0pO1xuXG4gIGF3YWl0IG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICBzZXJ2ZXIub25jZSgnZXJyb3InLCByZWplY3QpO1xuICAgIHNlcnZlci5saXN0ZW4oMCwgJzEyNy4wLjAuMScsICgpID0+IHJlc29sdmUoKSk7XG4gIH0pO1xuICBjb25zdCBhZGRyZXNzID0gc2VydmVyLmFkZHJlc3MoKTtcbiAgaWYgKGFkZHJlc3MgPT09IG51bGwgfHwgdHlwZW9mIGFkZHJlc3MgIT09ICdvYmplY3QnKSB0aHJvdyBuZXcgRXJyb3IoJ2Zha2UgaG9zdDogbm8gcG9ydCcpO1xuICBjb25zdCBwb3J0ID0gYWRkcmVzcy5wb3J0O1xuXG4gIGlmICghb3B0cy5xdWlldCkge1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KHsgaG1oRGVza3RvcEhvc3RSZWFkeTogdHJ1ZSwgcG9ydCwgdmVyc2lvbjogJ2Zha2UtMC4wLjAnIH0pfVxcbmApO1xuICB9XG4gIGNvbnN0IGRpZUFmdGVyID0gTnVtYmVyKHByb2Nlc3MuZW52LkZBS0VfSE9TVF9ESUVfQUZURVJfTVMgPz8gMCk7XG4gIGlmIChOdW1iZXIuaXNGaW5pdGUoZGllQWZ0ZXIpICYmIGRpZUFmdGVyID4gMCkge1xuICAgIHNldFRpbWVvdXQoKCkgPT4gcHJvY2Vzcy5leGl0KDEpLCBkaWVBZnRlcikudW5yZWYoKTtcbiAgfVxuXG4gIC8vIGNsb3NlKCk6IFx1NTE0OFx1NjVBRFx1NUYwMFx1NTE2OFx1OTBFOCBTU0UgXHU4RkRFXHU2M0E1KFx1NUI4M1x1NEVFQ1x1NkMzOFx1NEUwRFx1ODFFQVx1NzEzNlx1NTE3M1x1OTVFRCksXHU1NDI2XHU1MjE5IHNlcnZlci5jbG9zZVxuICAvLyBcdTRGMUFcdTRFMDBcdTc2RjRcdTdCNDlcdTZEM0JcdThEQzNcdThGREVcdTYzQTUsXHU2RDRCXHU4QkQ1XHU4RkRCXHU3QTBCXHU2MzAyXHU2QjdCXHUzMDAyXG4gIGNvbnN0IGNsb3NlID0gKCk6IFByb21pc2U8dm9pZD4gPT5cbiAgICBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4ge1xuICAgICAgZm9yIChjb25zdCBjIG9mIHNzZUNsaWVudHMpIHtcbiAgICAgICAgdHJ5IHsgYy5lbmQoKTsgYy5kZXN0cm95KCk7IH0gY2F0Y2ggeyAvKiBhbHJlYWR5IGdvbmUgKi8gfVxuICAgICAgfVxuICAgICAgc3NlQ2xpZW50cy5jbGVhcigpO1xuICAgICAgc2VydmVyLmNsb3NlKCgpID0+IHJlc29sdmUoKSk7XG4gICAgICBzZXRUaW1lb3V0KCgpID0+IHJlc29sdmUoKSwgMV8wMDApLnVucmVmKCk7XG4gICAgfSk7XG5cbiAgcmV0dXJuIHsgcG9ydCwgZW1pdCwgY2xvc2UgfTtcbn1cblxuLy8gXHU3NkY0XHU2M0E1XHU4RkQwXHU4ODRDKHN1cGVydmlzb3Igc3Bhd24gXHU3Njg0XHU1QjUwXHU4RkRCXHU3QTBCXHU1RjYyXHU2MDAxKVx1MzAwMnJlYWxwYXRoIFx1NkJENFx1OEY4MzpucG0gd29ya3NwYWNlXG4vLyBqdW5jdGlvbiAvIFx1NTkyN1x1NUMwRlx1NTE5OVx1NURFRVx1NUYwMlx1OTBGRFx1NEUwRFx1ODBGRFx1OEJBOVx1OEZEOVx1NEUyQVx1NjhDMFx1NkQ0Qlx1NTkzMVx1NjI0QihcdTU5MzFcdTYyNEI9XHU5NzU5XHU5RUQ4XHU5MDAwXHU1MUZBIGNvZGUgMCxcdTk2QkVcdTY3RTUpXHUzMDAyXG4vLyBjanMgYnVuZGxlKGVzYnVpbGQsXHU2MjUzXHU1MzA1XHU0RUE3XHU1NEMxKVx1NEUwQiBfX2ZpbGVuYW1lIFx1NUI1OFx1NTcyODtFU00odHN4L1x1NkU5MFx1NzgwMSlcdTc1MjggaW1wb3J0Lm1ldGFcdTMwMDJcbmNvbnN0IHNlbGZVcmw6IHN0cmluZyA9IHR5cGVvZiBfX2ZpbGVuYW1lID09PSAnc3RyaW5nJ1xuICA/IHBhdGhUb0ZpbGVVUkwocmVhbHBhdGhTeW5jKF9fZmlsZW5hbWUpKS5ocmVmXG4gIDogaW1wb3J0Lm1ldGEudXJsO1xuY29uc3QgaW52b2tlZEFzU2NyaXB0ID0gKCgpID0+IHtcbiAgaWYgKHByb2Nlc3MuYXJndlsxXSA9PT0gdW5kZWZpbmVkKSByZXR1cm4gZmFsc2U7XG4gIHRyeSB7XG4gICAgcmV0dXJuIHNlbGZVcmwgPT09IHBhdGhUb0ZpbGVVUkwocmVhbHBhdGhTeW5jKHByb2Nlc3MuYXJndlsxXSkpLmhyZWY7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufSkoKTtcbmlmIChpbnZva2VkQXNTY3JpcHQpIHtcbiAgY29uc3QgdG9rZW4gPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9UT0tFTiA/PyAnJztcbiAgLy8gRkFLRV9IT1NUX0RJRV9BVF9CT09UPTE6XHU1RjE1XHU1QkZDXHU4ODRDXHU4RjkzXHU1MUZBXHU1MjREXHU1MzczXHU2QjdCKFx1Njc4NFx1OTAyMFx1NTQyRlx1NTJBOFx1NjcxRiBSVU5USU1FX0NSQVNIRUQpXG4gIGlmIChwcm9jZXNzLmVudi5GQUtFX0hPU1RfRElFX0FUX0JPT1QgPT09ICcxJykge1xuICAgIHByb2Nlc3MuZXhpdCgxKTtcbiAgfVxuICBjb25zdCBzbG93ID0gTnVtYmVyKHByb2Nlc3MuZW52LkZBS0VfSE9TVF9TTE9XX0FGVEVSID8/IDApO1xuICBjb25zdCBib290ID0gKCk6IHZvaWQgPT4ge1xuICAgIHZvaWQgc3RhcnRGYWtlSG9zdCh7IHRva2VuIH0pLmNhdGNoKChlcnIpID0+IHtcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBmYWtlLWhvc3QgZmFpbGVkOiAke1N0cmluZyhlcnIpfVxcbmApO1xuICAgICAgcHJvY2Vzcy5leGl0KDEpO1xuICAgIH0pO1xuICB9O1xuICBpZiAoTnVtYmVyLmlzRmluaXRlKHNsb3cpICYmIHNsb3cgPiAwKSBzZXRUaW1lb3V0KGJvb3QsIHNsb3cpO1xuICBlbHNlIGJvb3QoKTtcbn1cbiIsICIvKipcclxuICogVUlWRVJJRlkgXHU5NEE5XHU1QjUwIFx1MjAxNFx1MjAxNCBcdTkwMTBcdTUyOUZcdTgwRkRcdTc3MUZcdTVCOUUgVUkgXHU5QTcxXHU1MkE4XHU5QThDXHU2NTM2KDIwMjYtMTAtMTAgXHU3NTI4XHU2MjM3XHU2MzA3XHU0RUU0OlxyXG4gKiBcIlx1NUJGOVx1NkJDRlx1NEUwMFx1NEUyQVx1NTI5Rlx1ODBGRCxcdTZCQ0ZcdTRFMDBcdTRFMkFcdTRFMUFcdTUyQTFcdTZENDFcdTdBMEJcdTUxNjhcdTk3NjJcdTc2ODRcdTlBOENcdTY1MzZcIilcdTMwMDJcclxuICpcclxuICogXHU3NkY0XHU2M0E1XHU1QkY5XHU2RTMyXHU2N0QzXHU1NDBFXHU3Njg0IERPTSBcdTY1QURcdThBMDAoXHU1RTAzXHU1QzQwXHU1MUUwXHU0RjU1L1x1NTNFRlx1ODlDMVx1NjAyNyksXHU1RTc2XHU3NTI4XHU1MzlGXHU3NTFGXHU0RThCXHU0RUY2XHU5QTcxXHU1MkE4IFJlYWN0XHJcbiAqIChcdTUzRDdcdTYzQTdcdThGOTNcdTUxNjVcdTc1MjhcdTUzOUZcdTU3OEIgc2V0dGVyICsgaW5wdXQgXHU0RThCXHU0RUY2O1x1NjMwOVx1OTRBRSBjbGljaztcdTk1MkVcdTc2RDhcdThENzAgd2luZG93XHJcbiAqIGtleWRvd24pXHUzMDAyZmFrZSBcdTZBMjFcdTVGMEZcdThERDFcdTVCOENcdTY1NzRcdTRFRkJcdTUyQTFcdTk0RkUoXHU1M0QxXHU5MDAxXHUyMTkyXHU1REU1XHU1MTc3XHUyMTkyXHU1QkExXHU2Mjc5XHUyMTkyXHU0RUE0XHU0RUQ4XHU3MjY5XHUyMTkyXHU2QzQ3XHU2MDNCKTtcclxuICogcmVhbCBcdTZBMjFcdTVGMEZcdTUzRUFcdThERDFcdTUzRUFcdThCRkJcdTVCNTBcdTk2QzYoXHU0RTBEXHU1MkE4XHU3NzFGXHU1QjlFXHU0RjFBXHU4QkREXHUzMDAxXHU0RTBEXHU3MEU3IHRva2VuKVx1MzAwMlxyXG4gKiBcdTZCQ0ZcdTZCNjVcdThGOTNcdTUxRkEgYFVJVkVSSUZZIFBBU1N8RkFJTCBuYW1lIHwgZGV0YWlsYCxcdTdFRDNcdTVDM0UgU1VNTUFSWSxleGl0IGNvZGVcdTMwMDJcclxuICovXHJcbmltcG9ydCB7IGFwcCwgdHlwZSBCcm93c2VyV2luZG93IH0gZnJvbSAnZWxlY3Ryb24nO1xyXG5pbXBvcnQgeyBta2Rpciwgd3JpdGVGaWxlIH0gZnJvbSAnbm9kZTpmcy9wcm9taXNlcyc7XHJcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdub2RlOnBhdGgnO1xyXG5cclxuY29uc3Qgc2xlZXAgPSAobXM6IG51bWJlcik6IFByb21pc2U8dm9pZD4gPT4gbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgbXMpKTtcclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHJ1blVpVmVyaWZ5KHdpbjogQnJvd3NlcldpbmRvdywgbW9kZTogJ2Zha2UnIHwgJ3JlYWwnKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgY29uc3Qgc2hvdHMgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9TSE9UUyA/PyBqb2luKGFwcC5nZXRQYXRoKCd0ZW1wJyksICdobWgtdWl2ZXJpZnknKTtcclxuICBhd2FpdCBta2RpcihzaG90cywgeyByZWN1cnNpdmU6IHRydWUgfSkuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcclxuICBjb25zdCByZXN1bHRzOiBBcnJheTxbc3RyaW5nLCBib29sZWFuLCBzdHJpbmddPiA9IFtdO1xyXG4gIGxldCBzaG90SWR4ID0gMDtcclxuXHJcbiAgY29uc3QganMgPSA8VD4oY29kZTogc3RyaW5nKTogUHJvbWlzZTxUPiA9PiB3aW4ud2ViQ29udGVudHMuZXhlY3V0ZUphdmFTY3JpcHQoY29kZSwgdHJ1ZSkgYXMgUHJvbWlzZTxUPjtcclxuICBjb25zdCBzdGVwID0gYXN5bmMgKG5hbWU6IHN0cmluZywgZm46ICgpID0+IFByb21pc2U8W2Jvb2xlYW4sIHN0cmluZ10+KTogUHJvbWlzZTx2b2lkPiA9PiB7XHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCBbb2ssIGRldGFpbF0gPSBhd2FpdCBmbigpO1xyXG4gICAgICByZXN1bHRzLnB1c2goW25hbWUsIG9rLCBkZXRhaWxdKTtcclxuICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICBjb25zdCBkZXRhaWwgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciAmJiBlcnIuc3RhY2sgIT09IHVuZGVmaW5lZCA/IGVyci5zdGFjayA6IFN0cmluZyhlcnIpO1xyXG4gICAgICByZXN1bHRzLnB1c2goW25hbWUsIGZhbHNlLCBkZXRhaWwuc2xpY2UoMCwgMzAwKV0pO1xyXG4gICAgfVxyXG4gICAgY29uc3QgbGFzdCA9IHJlc3VsdHNbcmVzdWx0cy5sZW5ndGggLSAxXSE7XHJcbiAgICBjb25zb2xlLmxvZyhgVUlWRVJJRlkgJHtsYXN0WzFdID8gJ1BBU1MnIDogJ0ZBSUwnfSB8ICR7bGFzdFswXX0gfCAke2xhc3RbMl19YCk7XHJcbiAgfTtcclxuICAvKiogXHU4RjZFXHU4QkUyXHU3NkY0XHU1MjMwIHByZWRpY2F0ZUNvZGUgXHU4RkQ0XHU1NkRFIHtvazp0cnVlLC4uLn0gXHU2MjE2XHU4RDg1XHU2NUY2KFx1OEZENFx1NTZERVx1NjcwMFx1NTQwRVx1NzY4NCBkZXRhaWwpXHUzMDAyICovXHJcbiAgY29uc3Qgd2FpdEZvciA9IGFzeW5jIChsYWJlbDogc3RyaW5nLCBwcmVkaWNhdGVDb2RlOiBzdHJpbmcsIHRpbWVvdXRNczogbnVtYmVyKTogUHJvbWlzZTxbYm9vbGVhbiwgc3RyaW5nXT4gPT4ge1xyXG4gICAgY29uc3Qgc3RhcnRlZCA9IERhdGUubm93KCk7XHJcbiAgICBmb3IgKDs7KSB7XHJcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoYChmdW5jdGlvbigpeyB0cnkgeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkoKGZ1bmN0aW9uKCl7ICR7cHJlZGljYXRlQ29kZX0gfSkoKSk7IH0gY2F0Y2goZSl7IHJldHVybiBKU09OLnN0cmluZ2lmeSh7b2s6ZmFsc2UsIGRldGFpbDpTdHJpbmcoZSkuc2xpY2UoMCwxMjApfSk7IH0gfSkoKWApKSBhcyBzdHJpbmc7XHJcbiAgICAgIGxldCBwYXJzZWQ6IHsgb2s/OiBib29sZWFuOyBkZXRhaWw/OiBzdHJpbmcgfTtcclxuICAgICAgdHJ5IHsgcGFyc2VkID0gSlNPTi5wYXJzZShyKSBhcyB7IG9rPzogYm9vbGVhbjsgZGV0YWlsPzogc3RyaW5nIH07IH0gY2F0Y2ggeyBwYXJzZWQgPSB7IG9rOiBmYWxzZSwgZGV0YWlsOiBTdHJpbmcocikuc2xpY2UoMCwgMTIwKSB9OyB9XHJcbiAgICAgIGlmIChwYXJzZWQub2sgPT09IHRydWUpIHJldHVybiBbdHJ1ZSwgU3RyaW5nKHBhcnNlZC5kZXRhaWwgPz8gJycpXTtcclxuICAgICAgaWYgKERhdGUubm93KCkgLSBzdGFydGVkID4gdGltZW91dE1zKSByZXR1cm4gW2ZhbHNlLCBgJHtsYWJlbH06ICR7U3RyaW5nKHBhcnNlZC5kZXRhaWwgPz8gJ3RpbWVvdXQnKX1gXTtcclxuICAgICAgYXdhaXQgc2xlZXAoMjUwKTtcclxuICAgIH1cclxuICB9O1xyXG4gIGNvbnN0IHNob3QgPSBhc3luYyAobGFiZWw6IHN0cmluZyk6IFByb21pc2U8dm9pZD4gPT4ge1xyXG4gICAgc2hvdElkeCArPSAxO1xyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3QgaW1nID0gYXdhaXQgd2luLndlYkNvbnRlbnRzLmNhcHR1cmVQYWdlKCk7XHJcbiAgICAgIGF3YWl0IHdyaXRlRmlsZShqb2luKHNob3RzLCBgJHttb2RlfS0ke1N0cmluZyhzaG90SWR4KS5wYWRTdGFydCgyLCAnMCcpfS0ke2xhYmVsfS5wbmdgKSwgaW1nLnRvUE5HKCkpO1xyXG4gICAgfSBjYXRjaCB7IC8qIFx1NjIyQVx1NTZGRVx1NTkzMVx1OEQyNVx1NEUwRFx1NTIyNFx1NkI3QiAqLyB9XHJcbiAgfTtcclxuXHJcbiAgLyogLS0tLSBcdTUzRDdcdTYzQTdcdThGOTNcdTUxNjUoUmVhY3Q6XHU1MzlGXHU1NzhCIHNldHRlciBcdTg5RTZcdTUzRDEgb25DaGFuZ2UpIC0tLS0gKi9cclxuICBjb25zdCB0eXBlSW50byA9IChzZWw6IHN0cmluZywgdGV4dDogc3RyaW5nKTogUHJvbWlzZTx1bmtub3duPiA9PlxyXG4gICAganMoYChmdW5jdGlvbigpe1xyXG4gICAgICB2YXIgZWwgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCR7SlNPTi5zdHJpbmdpZnkoc2VsKX0pO1xyXG4gICAgICBpZiAoIWVsKSByZXR1cm4gJ05PRUwnO1xyXG4gICAgICB2YXIgcHJvdG8gPSBlbC50YWdOYW1lID09PSAnVEVYVEFSRUEnID8gSFRNTFRleHRBcmVhRWxlbWVudC5wcm90b3R5cGUgOiBIVE1MSW5wdXRFbGVtZW50LnByb3RvdHlwZTtcclxuICAgICAgT2JqZWN0LmdldE93blByb3BlcnR5RGVzY3JpcHRvcihwcm90bywgJ3ZhbHVlJykuc2V0LmNhbGwoZWwsICR7SlNPTi5zdHJpbmdpZnkodGV4dCl9KTtcclxuICAgICAgZWwuZGlzcGF0Y2hFdmVudChuZXcgRXZlbnQoJ2lucHV0JywgeyBidWJibGVzOiB0cnVlIH0pKTtcclxuICAgICAgcmV0dXJuICdPSyc7XHJcbiAgICB9KSgpYCk7XHJcblxyXG4gIC8qIC0tLS0gXHU1NDJGXHU1MkE4XHU3QjQ5XHU1Rjg1OlJlYWN0IFx1NjMwMlx1OEY3RCArIGhvc3QgXHU3RUZGXHU3MEI5KHJlYWwgXHU3Njg0IGhtaGFybmVzcyBcdTUxQjdcdTU0MkZcdTUyQThcdTg5ODFcdTdGMTZcdThCRDFcclxuICAgICBcdTY1NzRcdTU5NTcgQ0xJIFx1NEY5RFx1OEQ1NixcdTUzRUZcdTUyMzAgMzBzKztcdTRFMERcdTdCNDlcdTdFRkZcdTcwQjlcdTVDMzFcdTVGMDBcdThERDFcdTRGMUFcdTUxNjhcdTkwRThcdThEODVcdTY1RjZcdThCRUZcdTYyQTUpIC0tLS0gKi9cclxuICBhd2FpdCB3YWl0Rm9yKCdob3N0IHJlYWR5JywgYHZhciB0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jb21wb3NlciB0ZXh0YXJlYScpOyByZXR1cm4ge29rOiAhIXQsIGRldGFpbDogdCA/ICdtb3VudGVkJyA6ICdubyBjb21wb3Nlcid9O2AsIDIwXzAwMCk7XHJcbiAgYXdhaXQgd2FpdEZvcignaG9zdCBkb3Qgb24nLCBgdmFyIGQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmhvc3QtZG90Jyk7IHJldHVybiB7b2s6ICEhZCAmJiBkLmNsYXNzTGlzdC5jb250YWlucygnb24nKSwgZGV0YWlsOiBkID8gZC5jbGFzc05hbWUgOiAnbm8gZG90J307YCwgbW9kZSA9PT0gJ3JlYWwnID8gNjBfMDAwIDogMjBfMDAwKTtcclxuICBhd2FpdCBzbGVlcCgxXzIwMCk7IC8vIFx1NEYxQVx1OEJERFx1NTIxN1x1ODg2OC9cdTk4NzZcdTY4MEZcdTY1NzBcdTYzNkVcdTg0M0RcdTU3MzBcclxuXHJcbiAgLyoqIFx1N0VERlx1NEUwMFx1NjUzNlx1NUMzRTpTVU1NQVJZICsgXHU2MzA5XHU1OTMxXHU4RDI1XHU2NTcwXHU5MDAwXHU1MUZBXHUzMDAyICovXHJcbiAgY29uc3QgZmluaXNoID0gKCk6IHZvaWQgPT4ge1xyXG4gICAgY29uc3QgZmFpbGVkID0gcmVzdWx0cy5maWx0ZXIoKHIpID0+ICFyWzFdKS5sZW5ndGg7XHJcbiAgICBjb25zb2xlLmxvZyhgVUlWRVJJRlkgU1VNTUFSWSBwYXNzPSR7cmVzdWx0cy5sZW5ndGggLSBmYWlsZWR9LyR7cmVzdWx0cy5sZW5ndGh9IG1vZGU9JHttb2RlfSBzaG90cz0ke3Nob3RzfWApO1xyXG4gICAgYXBwLmV4aXQoZmFpbGVkID09PSAwID8gMCA6IDEpO1xyXG4gIH07XHJcblxyXG4gIC8qID09PT09PT09PT0gXHU0RTEzXHU3NTI4Olx1NzcxRlx1NUI5RVx1NjZGNFx1NjVCMFx1NTE2OFx1NkQ0MVx1N0EwQlx1OUE4Q1x1NjUzNihcdTRFRkJcdTUyQTEgMTMtQztcdTlBNzFcdTUyQThcdTU2NjggLS11cGRhdGUtcmVhbClcclxuICAgICBcdTUyNERcdTdGNkUgZW52OkhNSF9ERVNLVE9QX1VQREFURV9GT1JDRV9UQUcgXHU5NzVFXHU3QTdBKFx1NUYzQVx1NTIzNlx1ODlDNlx1NEUzQVx1NjcwOVx1NjZGNFx1NjVCMCxcdTVGNTNcdTUyNEQgMC4yLjlcclxuICAgICA9PSBsYXRlc3QgMC4yLjkgXHU0RUNEXHU4RDcwXHU0RTBCXHU4RjdEKVx1MzAwMlx1OEQ3MFx1NzcxRlx1NUI5RVx1NjhDMFx1NjdFNVx1OTRGRShkaXJlY3QgXHUyMTkyIGF0b21naXQgXHUyMTkyIFx1MjAyNilcdTIxOTIgXHU1NDBFXHU1M0YwXHJcbiAgICAgXHU2RDQxXHU1RjBGXHU0RTBCXHU4RjdEXHU3NzFGXHU1QjlFIFNldHVwKDExMk1CLGF0b21naXQgXHU4RDQ0XHU0RUE3KVx1MjE5MiBkb3dubG9hZGVkIFx1NkEyQVx1NUU0NVx1MzAwMlx1NTNFQVx1NjVBRFx1OEEwMFx1NUMzMVx1N0VFQSxcclxuICAgICBcdTdFRERcdTRFMERcdTcwQjlcdTUxRkJcIlx1OTFDRFx1NTQyRlx1NjZGNFx1NjVCMFwiKFx1OTA3Rlx1NTE0RFx1NjI4QVx1NUYwMFx1NTNEMVx1NjczQVx1NzY4NCBlbGVjdHJvbiBkaXN0IFx1ODhDNVx1NTc0RilcdTMwMDIgKi9cclxuICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfVVBEQVRFID09PSAncmVhbCcpIHtcclxuICAgIGF3YWl0IHN0ZXAoJ1x1NjZGNFx1NjVCMChcdTc3MUZcdTVCOUUpOlx1NTQyRlx1NTJBOCAzMHMgXHU4MUVBXHU1MkE4XHU2OEMwXHU2N0U1IFx1MjE5MiBhdG9tZ2l0L1x1OTU1Q1x1NTBDRlx1OTAxQVx1OTA1M1x1NTQ3RFx1NEUyRCBcdTIxOTIgXHU1NDBFXHU1M0YwXHU0RTBCXHU4RjdEXHU4RkRCXHU1RUE2XHU2QTJBXHU1RTQ1XHU1MUZBXHU3M0IwJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignZG93bmxvYWRpbmcgb3IgcmVhZHkgYmFubmVyJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy51cGRhdGUtYmFubmVyJyk7XHJcbiAgICAgICAgaWYoIWIpIHJldHVybiB7b2s6ZmFsc2UsIGRldGFpbDonbm8gYmFubmVyIHlldCd9O1xyXG4gICAgICAgIHZhciB0PWIudGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKTtcclxuICAgICAgICByZXR1cm4ge29rOiB0cnVlLCBkZXRhaWw6IHQuc2xpY2UoMCw5MCl9O2AsIDE1MF8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzaG90KCd1cGRhdGUtcmVhbC1kb3dubG9hZGluZycpO1xyXG4gICAgYXdhaXQgc3RlcCgnXHU2NkY0XHU2NUIwKFx1NzcxRlx1NUI5RSk6MTEyTUIgXHU2RDQxXHU1RjBGXHU0RTBCXHU4RjdEXHU1QjhDXHU2MjEwIFx1MjE5MiBcIlx1OTFDRFx1NTQyRlx1NjZGNFx1NjVCMFwiXHU2QTJBXHU1RTQ1XHU1QzMxXHU3RUVBKFx1NEUwRFx1NzBCOVx1NTFGQixcdTRFMERcdTVCODlcdTg4QzUpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICByZXR1cm4gd2FpdEZvcigncmVhZHkgYmFubmVyJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy51cGRhdGUtYmFubmVyJyk7XHJcbiAgICAgICAgdmFyIGJ0bj1iP2IucXVlcnlTZWxlY3RvcignLnVwZGF0ZS1yZXN0YXJ0Jyk6bnVsbDtcclxuICAgICAgICB2YXIgbGlua3M9Yj9iLnF1ZXJ5U2VsZWN0b3JBbGwoJ2EnKS5sZW5ndGg6LTE7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFidG4gJiYgYnRuLmRpc2FibGVkPT09ZmFsc2UgJiYgbGlua3M9PT0wLCBkZXRhaWw6IGIgPyBiLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw5MCkgOiAnbm8gYmFubmVyJ307YCwgOTAwXzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHNob3QoJ3VwZGF0ZS1yZWFsLXJlYWR5Jyk7XHJcbiAgICBhd2FpdCBzdGVwKCdcdTY2RjRcdTY1QjAoXHU3NzFGXHU1QjlFKTpjb21wb3Nlci9cdTRGQTdcdTY4MEZcdTRFMERcdTUzRDdcdTZBMkFcdTVFNDVcdTYzMjRcdTUzOEIoXHU0RUZCXHU1MkExXHU1MzNBXHU1M0VGXHU3NTI4KScsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgciA9IChhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XHJcbiAgICAgICAgdmFyIHRhPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jb21wb3NlciB0ZXh0YXJlYScpLCBzYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhcicpO1xyXG4gICAgICAgIHZhciB0cj10YT90YS5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTpudWxsO1xyXG4gICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh7dGE6ICEhdHIgJiYgdHIuaGVpZ2h0PjMwICYmIHRyLmJvdHRvbTw9d2luZG93LmlubmVySGVpZ2h0LCBzYjogISFzYiAmJiBnZXRDb21wdXRlZFN0eWxlKHNiKS5kaXNwbGF5IT09J25vbmUnfSk7XHJcbiAgICAgIH0pKClgKSkgYXMgc3RyaW5nO1xyXG4gICAgICBjb25zdCBwID0gSlNPTi5wYXJzZShyKSBhcyB7IHRhOiBib29sZWFuOyBzYjogYm9vbGVhbiB9O1xyXG4gICAgICByZXR1cm4gW3AudGEgJiYgcC5zYiwgYGNvbXBvc2VyIFx1NTNFRlx1NzUyOD0ke3AudGF9IFx1NEZBN1x1NjgwRlx1NkI2M1x1NUUzOD0ke3Auc2J9YF07XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHNob3QoJ2ZpbmFsJyk7XHJcbiAgICBmaW5pc2goKTtcclxuICAgIHJldHVybjtcclxuICB9XHJcblxyXG4gIC8qID09PT09PT09PT0gXHU5MDFBXHU3NTI4Olx1NUUwM1x1NUM0MFx1NTFFMFx1NEY1NShcdTc1MjhcdTYyMzdcdTYyQTVcdTk2OUNcdTc2ODRcdTc2RjRcdTYzQTVcdTY1QURcdThBMDApID09PT09PT09PT0gKi9cclxuICBhd2FpdCBzdGVwKCdcdTVFMDNcdTVDNDA6XHU2ODA3XHU5ODk4XHU2ODBGK1x1NEUwOVx1NjgwRitjb21wb3NlciBcdTU3MjhcdTg5QzZcdTUzRTNcdTUxODUoXHU4RjkzXHU1MTY1XHU2ODQ2XHU1M0VGXHU4OUMxKScsIGFzeW5jICgpID0+IHtcclxuICAgIGNvbnN0IHIgPSAoYXdhaXQganMoYChmdW5jdGlvbigpe1xyXG4gICAgICB2YXIgcSA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IuYmluZChkb2N1bWVudCk7XHJcbiAgICAgIHZhciB0YiA9IHEoJy50aXRsZWJhcicpLCBzaGVsbCA9IHEoJy5hcHAtc2hlbGwnKSwgc2IgPSBxKCcuc2lkZWJhcicpLCB3cyA9IHEoJy53b3Jrc3BhY2UnKSwgdGEgPSBxKCcuY29tcG9zZXIgdGV4dGFyZWEnKTtcclxuICAgICAgdmFyIG1pc3NpbmcgPSBbIXRiICYmICd0aXRsZWJhcicsICFzaGVsbCAmJiAnc2hlbGwnLCAhc2IgJiYgJ3NpZGViYXInLCAhd3MgJiYgJ3dvcmtzcGFjZScsICF0YSAmJiAndGV4dGFyZWEnXS5maWx0ZXIoQm9vbGVhbikuam9pbignLCcpO1xyXG4gICAgICBpZiAobWlzc2luZyAhPT0gJycpIHJldHVybiBKU09OLnN0cmluZ2lmeSh7b2s6ZmFsc2UsIGRldGFpbDonbWlzc2luZzonK21pc3Npbmd9KTtcclxuICAgICAgdmFyIHIgPSB0YS5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKSwgdmggPSB3aW5kb3cuaW5uZXJIZWlnaHQsIHZ3ID0gd2luZG93LmlubmVyV2lkdGg7XHJcbiAgICAgIHZhciBoaW50ID0gcSgnLmVtcHR5LWhpbnQuYmlnJyk7IHZhciBociA9IGhpbnQgPyBoaW50LmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpIDogbnVsbDtcclxuICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHsgb2s6IHIuaGVpZ2h0ID4gMzAgJiYgci5ib3R0b20gPD0gdmggJiYgci53aWR0aCA+IDEwMCAmJiBociAhPT0gbnVsbCAmJiBoci50b3AgPj0gMCAmJiBoci5ib3R0b20gPD0gdmgsXHJcbiAgICAgICAgZGV0YWlsOiAndGV4dGFyZWEgeT0nK01hdGgucm91bmQoci55KSsnIGg9JytNYXRoLnJvdW5kKHIuaGVpZ2h0KSsnIGJvdHRvbT0nK01hdGgucm91bmQoci5ib3R0b20pKycgdmg9Jyt2aCsoaHIgPyAnIGhpbnQgeT0nK01hdGgucm91bmQoaHIueSkgOiAnIG5vLWhpbnQnKSB9KTtcclxuICAgIH0pKClgKSkgYXMgc3RyaW5nO1xyXG4gICAgY29uc3QgcCA9IEpTT04ucGFyc2UocikgYXMgeyBvazogYm9vbGVhbjsgZGV0YWlsOiBzdHJpbmcgfTtcclxuICAgIHJldHVybiBbcC5vayA9PT0gdHJ1ZSwgcC5kZXRhaWxdO1xyXG4gIH0pO1xyXG5cclxuICBpZiAobW9kZSA9PT0gJ2Zha2UnKSB7XHJcbiAgICAvKiA9PT09PT09PT09IGZha2UoXHU1NDExXHU1QkZDXHU2Nzg0XHU5MDIwLEhNSF9ERVNLVE9QX1VJVkVSSUZZX1dJWkFSRD1mYWtlKTpcclxuICAgICAgIFx1NEYyQVx1OTAyMFx1NjcyQVx1OTE0RFx1N0Y2RVx1NjAwMSBcdTIxOTIgXHU1NDExXHU1QkZDXHU1MUZBXHU3M0IwIFx1MjE5MiBcdTY4QzBcdTZENEIoXHU2NzJBXHU4OEM1KVx1MjE5MiBcdTkwMDlcdTYyRTkgXHUyMTkyIFx1NTE4NVx1N0Y2RSBcdTIxOTIgXHU4RkRFXHU0RTBBID09PT09PT09PT0gKi9cclxuICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9XSVpBUkQgPT09ICdmYWtlJykge1xyXG4gICAgICBhd2FpdCBzdGVwKCdcdTU0MTFcdTVCRkM6XHU5OTk2XHU1NDJGXHU1RjM5XHU1MUZBXHU2QjIyXHU4RkNFXHU5ODc1KFx1NUYwMFx1NTlDQlx1OTE0RFx1N0Y2RS9cdTZGMTRcdTc5M0FcdTUxNjVcdTUzRTMpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCd3aXphcmQgb3ZlcmxheScsIGB2YXIgbz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKTtcclxuICAgICAgICAgIHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTVGMDBcdTU5Q0JcdTkxNERcdTdGNkUnO30pO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogISFvICYmICEhYiwgZGV0YWlsOiBvID8gJ292ZXJsYXkrXHU1RjAwXHU1OUNCXHU5MTREXHU3RjZFJyA6ICdubyBvdmVybGF5J307YCwgMTJfMDAwKTtcclxuICAgICAgICBhd2FpdCBzaG90KCd3aXphcmQtd2VsY29tZScpO1xyXG4gICAgICAgIHJldHVybiB3O1xyXG4gICAgICB9KTtcclxuICAgICAgYXdhaXQgc3RlcCgnXHU1NDExXHU1QkZDOlx1NUYwMFx1NTlDQlx1OTE0RFx1N0Y2RVx1MjE5Mlx1NjhDMFx1NkQ0QihcdTRGMkFcdTkwMjBcdTY3MkFcdTg4QzUpXHUyMTkyXHU2NzJBXHU4OEM1XHU1MzczXHU4MUVBXHU1MkE4XHU1Qjg5XHU4OEM1XHU5ODc1KFx1OEJGNFx1NjYwRVx1NkEyQVx1NUU0NStcdTUyMDdcdTYzNjJcdTk0RkVcdTYzQTUpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NUYwMFx1NTlDQlx1OTE0RFx1N0Y2RSc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdhdXRvIGluc3RhbGwgcGFnZScsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtaW5zdGFsbCcpO1xyXG4gICAgICAgICAgaWYoIXApIHJldHVybiB7b2s6ZmFsc2UsIGRldGFpbDonbm90IG9uIGluc3RhbGwnfTtcclxuICAgICAgICAgIHZhciB0PXAudGV4dENvbnRlbnQ7XHJcbiAgICAgICAgICB2YXIgbm90ZT10LmluZGV4T2YoJ1x1NjcyQVx1NjhDMFx1NkQ0Qlx1NTIzMCBobWggQ0xJLFx1NURGMlx1ODFFQVx1NTJBOFx1NUYwMFx1NTlDQlx1NUI4OVx1ODhDNScpPj0wO1xyXG4gICAgICAgICAgdmFyIGwxPXQuaW5kZXhPZignXHU2NTM5XHU3NTI4XHU1MTg1XHU3RjZFXHU3Q0JFXHU3QjgwXHU1MTg1XHU2ODM4Jyk+PTAsIGwyPXQuaW5kZXhPZignXHU2RjE0XHU3OTNBXHU2QTIxXHU1RjBGJyk+PTA7XHJcbiAgICAgICAgICB2YXIgYmFyPSEhcC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLXByb2dyZXNzJyk7XHJcbiAgICAgICAgICB2YXIgc2VsPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1zZWxlY3QnKTtcclxuICAgICAgICAgIHJldHVybiB7b2s6IG5vdGUmJmwxJiZsMiYmYmFyJiYhc2VsLCBkZXRhaWw6ICdub3RlPScrbm90ZSsnIFx1NTE4NVx1N0Y2RVx1OTRGRVx1NjNBNT0nK2wxKycgXHU2RjE0XHU3OTNBXHU5NEZFXHU2M0E1PScrbDIrJyBiYXI9JytiYXIrJyBzZWxlY3RMZWFrPScrISFzZWx9O2AsIDEyXzAwMCk7XHJcbiAgICAgICAgYXdhaXQgc2hvdCgnd2l6YXJkLWF1dG8taW5zdGFsbCcpO1xyXG4gICAgICAgIHJldHVybiB3O1xyXG4gICAgICB9KTtcclxuICAgICAgYXdhaXQgc3RlcCgnXHU1NDExXHU1QkZDOlx1NkEyQVx1NUU0NVwiXHU2NTM5XHU3NTI4XHU1MTg1XHU3RjZFXHU3Q0JFXHU3QjgwXHU1MTg1XHU2ODM4XCJcdTIxOTJcdTkxNERcdTdGNkVcdThERjNcdThGQzdcdTIxOTJcdTVCOENcdTYyMTBcdTk4NzVcdTIxOTJcdTVGMDBcdTU5Q0JcdTRGN0ZcdTc1MjhcdTIxOTJcdTUxNzNcdTk1RURcdTRFMTRcdTVERjJcdThGREVcdTYzQTUnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtcGFnZS1pbnN0YWxsIC53aXphcmQtYWx0LWxpbmsnKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTY1MzlcdTc1MjhcdTUxODVcdTdGNkVcdTdDQkVcdTdCODBcdTUxODVcdTY4MzgnKT49MDt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgLy8gXHU5MTREXHU3RjZFXHU5ODc1OmZha2UgcHJvdmlkZXJzIFx1NURGMlx1NjcwOVx1NUJDNlx1OTRBNSBcdTIxOTIgXHU4MUVBXHU1MkE4XHU4REYzXHU4RkM3O1x1NTE1Q1x1NUU5NVx1NzBCOVwiXHU4REYzXHU4RkM3XCJcclxuICAgICAgICBhd2FpdCB3YWl0Rm9yKCdjb25maWcgb3IgZG9uZScsIGB2YXIgZD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtZG9uZScpO1xyXG4gICAgICAgICAgaWYoZCkgcmV0dXJuIHtvazp0cnVlLCBkZXRhaWw6J2RvbmUnfTtcclxuICAgICAgICAgIHZhciBjPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1jb25maWcnKTtcclxuICAgICAgICAgIGlmKGMpeyB2YXIgcz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdcdThERjNcdThGQzcnKT49MDt9KTsgaWYocykgcy5jbGljaygpOyB9XHJcbiAgICAgICAgICByZXR1cm4ge29rOmZhbHNlLCBkZXRhaWw6J3dhaXRpbmcnfTtgLCAxNV8wMDApO1xyXG4gICAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdkb25lIHBhZ2UnLCBgdmFyIGQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLWRvbmUnKTtcclxuICAgICAgICAgIHZhciB0PWQ/ZC50ZXh0Q29udGVudDonJztcclxuICAgICAgICAgIHJldHVybiB7b2s6ICEhZCAmJiB0LmluZGV4T2YoJ1x1NUMzMVx1N0VFQScpPj0wICYmIHQuaW5kZXhPZignXHU1MTcxXHU0RUFCJyk+PTAsIGRldGFpbDogdC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNjApfTtgLCA4XzAwMCk7XHJcbiAgICAgICAgYXdhaXQgc2hvdCgnd2l6YXJkLWRvbmUnKTtcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTVGMDBcdTU5Q0JcdTRGN0ZcdTc1MjgnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICBjb25zdCBjbG9zZWQgPSBhd2FpdCB3YWl0Rm9yKCd3aXphcmQgY2xvc2VkICsgY29ubmVjdGVkJywgYHJldHVybiB7b2s6ICFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKSAmJiAhIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ob3N0LWRvdC5vbicpLFxyXG4gICAgICAgICAgZGV0YWlsOiAnb3ZlcmxheT0nKyhkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKT8nb3Blbic6J2Nsb3NlZCcpKycgZG90PScrKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ob3N0LWRvdC5vbicpPydvbic6J29mZicpfTtgLCAxMF8wMDApO1xyXG4gICAgICAgIHJldHVybiBbd1swXSAmJiBjbG9zZWRbMF0sIGBkb25lOiAke3dbMV19OyAke2Nsb3NlZFsxXX1gXTtcclxuICAgICAgfSk7XHJcbiAgICB9XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1OTk5Nlx1OEREMVx1NUYxNVx1NUJGQ1x1NUM0MiA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTVGMTVcdTVCRkNcdTVDNDI6XHU2RjE0XHU3OTNBXHU2QTIxXHU1RjBGXHU2M0QwXHU3OTNBXHU1MUZBXHU3M0IwXHU1RTc2XHU1M0VGXHU1MTczXHU5NUVEJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignZ3VpZGUnLCBgdmFyIGc9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnJ1bnRpbWUtZ3VpZGUnKTsgcmV0dXJuIHtvazogISFnLCBkZXRhaWw6IGcgPyAnc2hvd24nIDogJ25vdCBzaG93bid9O2AsIDhfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpe1xyXG4gICAgICAgIHZhciBidG5zID0gW10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcucnVudGltZS1ndWlkZSBidXR0b24nKSk7XHJcbiAgICAgICAgdmFyIGIgPSBidG5zLmZpbmQoZnVuY3Rpb24oeCl7IHJldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1NkYxNFx1NzkzQScpID49IDA7IH0pO1xyXG4gICAgICAgIGlmIChiKSBiLmNsaWNrKCk7XHJcbiAgICAgIH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2d1aWRlIGdvbmUnLCBgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ydW50aW1lLWd1aWRlJyksIGRldGFpbDogZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnJ1bnRpbWUtZ3VpZGUnKSA/ICdzdGlsbCcgOiAnZGlzbWlzc2VkJ307YCwgNV8wMDApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NjVCMFx1NUVGQVx1NEYxQVx1OEJERChDdHJsK04pID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ0N0cmwrTiBcdTY1QjBcdTVFRkFcdTRGMUFcdThCREQsXHU4RjkzXHU1MTY1XHU2ODQ2XHU1M0VGXHU3NTI4JywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OiduJywgY3RybEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ3RleHRhcmVhIGVuYWJsZWQnLCBgdmFyIHQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNvbXBvc2VyIHRleHRhcmVhJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISF0ICYmIHQuZGlzYWJsZWQgPT09IGZhbHNlICYmICh0LnBsYWNlaG9sZGVyfHwnJykuaW5kZXhPZignXHU2M0NGXHU4RkYwXHU3NkVFXHU2ODA3JykgPj0gMCwgZGV0YWlsOiB0ID8gKCdkaXNhYmxlZD0nK3QuZGlzYWJsZWQrJyBwaD0nKyh0LnBsYWNlaG9sZGVyfHwnJykuc2xpY2UoMCwyMCkpIDogJ25vIHRhJ307YCwgNV8wMDApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NTNEMVx1OTAwMVx1NEVGQlx1NTJBMSBcdTIxOTIgXHU3NTI4XHU2MjM3XHU4RjZFXHU1MUZBXHU3M0IwKFx1NEUxNFx1NEVDNVx1NEUwMFx1Njc2MSxcdTUzQ0NcdTZEODhcdTYwNkZcdTU2REVcdTVGNTIpID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1OEY5M1x1NTE2NVx1NUU3Nlx1NTNEMVx1OTAwMVx1NEVGQlx1NTJBMSxcdTc1MjhcdTYyMzdcdTZEODhcdTYwNkZcdTRFMEFcdTVDNEZcdTRFMTRcdTRFMERcdTkxQ0RcdTU5MEQnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IHR5cGVJbnRvKCcuY29tcG9zZXIgdGV4dGFyZWEnLCAnXHU5QThDXHU2NTM2XHU0RUZCXHU1MkExOlx1NTE5OVx1NTE2NVx1NEUwMFx1NEUyQVx1NjU4N1x1NEVGNicpO1xyXG4gICAgICBhd2FpdCBzbGVlcCgyMDApO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XHJcbiAgICAgICAgdmFyIGJ0bnMgPSBbXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jb21wb3NlciBidXR0b24nKSk7XHJcbiAgICAgICAgdmFyIGIgPSBidG5zLmZpbmQoZnVuY3Rpb24oeCl7IHJldHVybiB4LnRleHRDb250ZW50LnRyaW0oKSA9PT0gJ1x1NTNEMVx1OTAwMSc7IH0pO1xyXG4gICAgICAgIGlmIChiKSBiLmNsaWNrKCk7XHJcbiAgICAgIH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2V4YWN0bHkgb25lIHVzZXIgdHVybicsIGB2YXIgdHM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudHVybi51c2VyJykpLmZpbHRlcihmdW5jdGlvbih4KXsgcmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU5QThDXHU2NTM2XHU0RUZCXHU1MkExJykgPj0gMDsgfSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogdHMubGVuZ3RoID09PSAxLCBkZXRhaWw6ICdjb3VudD0nK3RzLmxlbmd0aCsnIHRleHQ9JysodHNbMF0/dHNbMF0udGV4dENvbnRlbnQuc2xpY2UoMCwzMCk6J25vbmUnKX07YCwgOF8wMDApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NURFNVx1NTE3N1x1NTM2MShyZWFkX2ZpbGUgXHU1QjhDXHU2MjEwKSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTVERTVcdTUxNzdcdTYyOThcdTUzRTBcdTUzNjE6cmVhZF9maWxlIFx1NjI2N1x1ODg0Q1x1NUU3Nlx1NUI4Q1x1NjIxMCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3Rvb2wgY2FyZCcsIGB2YXIgYz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50b29sLWNhcmQnKSk7XHJcbiAgICAgICAgdmFyIGRvbmUgPSBjLmZpbHRlcihmdW5jdGlvbih4KXsgcmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZigncmVhZF9maWxlJykgPj0gMCAmJiB4LnRleHRDb250ZW50LmluZGV4T2YoJyMgZGVtbycpID49IDA7IH0pO1xyXG4gICAgICAgIHJldHVybiB7b2s6IGRvbmUubGVuZ3RoID49IDEsIGRldGFpbDogJ2NhcmRzPScrYy5sZW5ndGgrJyBkb25lPScrZG9uZS5sZW5ndGh9O2AsIDhfMDAwKTtcclxuICAgICAgcmV0dXJuIHc7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU1QkExXHU2Mjc5XHU3RUI1XHU1MjA3XHU3MjQ3KFx1NzUyOFx1NjIzN1x1NjJBNVx1OTY5Q1x1NjgzOFx1NUZDM1x1NEU0Qlx1NEUwMCkgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU1QkExXHU2Mjc5OmFwcHJvdmFsIFx1NTM2MVx1NTFGQVx1NzNCMChcdTdCNDlcdTVGODVcdTRFQkFcdTVERTVcdTYyNzlcdTUxQzYpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBzaG90KCdhcHByb3ZhbC1wZW5kaW5nJyk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdhcHByb3ZhbCBjYXJkJywgYHZhciBhPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5hcHByb3ZhbC1jYXJkJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFhICYmIGEudGV4dENvbnRlbnQuaW5kZXhPZignXHU5NzAwXHU4OTgxXHU1QkExXHU2Mjc5JykgPj0gMCwgZGV0YWlsOiBhID8gYS50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsIDYwKSA6ICdubyBhcHByb3ZhbCBjYXJkJ307YCwgOF8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdcdTVCQTFcdTYyNzk6XHU3MEI5XHU2Mjc5XHU1MUM2IFx1MjE5MiBcdTRFRkJcdTUyQTFcdTdFRTdcdTdFRURcdTUyMzBcdTRFQTRcdTRFRDhcdTcyNjkrXHU2QzQ3XHU2MDNCJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XHJcbiAgICAgICAgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuYXBwcm92YWwtY2FyZCBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXsgcmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NjI3OVx1NTFDNic7IH0pO1xyXG4gICAgICAgIGlmIChiKSBiLmNsaWNrKCk7XHJcbiAgICAgIH0pKClgKTtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2FydGlmYWN0K3N1bScsIGB2YXIgYXJ0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5hcnRpZmFjdC1jYXJkJyk7XHJcbiAgICAgICAgdmFyIHN1bT1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudHVybi1zdW0nKTtcclxuICAgICAgICB2YXIgYXN0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnR1cm4nKSkuZmlsdGVyKGZ1bmN0aW9uKHgpeyByZXR1cm4geC5jbGFzc05hbWUuaW5kZXhPZigndXNlcicpPDAgJiYgeC50ZXh0Q29udGVudC5pbmRleE9mKCdlY2hvOicpPj0wOyB9KTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWFydCAmJiAhIXN1bSAmJiBhc3QubGVuZ3RoPj0xLCBkZXRhaWw6ICdhcnRpZmFjdD0nKyhhcnQ/YXJ0LnRleHRDb250ZW50LnNsaWNlKDAsMzApOidub25lJykrJyBzdW09Jysoc3VtP3N1bS50ZXh0Q29udGVudDonbm9uZScpKycgYW5zd2VyZWQ9Jythc3QubGVuZ3RofTtgLCAxMl8wMDApO1xyXG4gICAgICBhd2FpdCBzaG90KCdydW4tY29tcGxldGVkJyk7XHJcbiAgICAgIHJldHVybiB3O1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NTM4Nlx1NTNGMlx1NEYxQVx1OEJERFx1NTE4NVx1NUJCOShcdTc1MjhcdTYyMzdcdTYyQTVcdTk2OUNcIlx1NzcwQlx1NEUwRFx1NTIzMFx1NTE4NVx1NUJCOVwiKSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTcwQjlcdTUxRkJcdTUzODZcdTUzRjJcdTRGMUFcdThCREQgXHUyMTkyIHRyYW5zY3JpcHQgXHU1MTg1XHU1QkI5XHU1M0VGXHU4OUMxJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBpdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2Vzc2lvbi1pdGVtJyk7IGlmIChpdCkgaXQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignaGlzdG9yeSB0dXJucycsIGB2YXIgdHM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudHVybicpKTtcclxuICAgICAgICByZXR1cm4ge29rOiB0cy5sZW5ndGggPj0gMiwgZGV0YWlsOiAndHVybnM9Jyt0cy5sZW5ndGgrJyBmaXJzdD0nKyh0c1swXT90c1swXS50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNDApOidub25lJyl9O2AsIDhfMDAwKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTRFOTRcdTk4NzVcdTdCN0UgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnRG9jazpPdmVydmlldyBcdTY1NzBcdTYzNkVcdTg4NEMnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdPdmVydmlldyc7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignb3ZlcnZpZXcgcm93cycsIGB2YXIgcm93cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXJvdycpKTtcclxuICAgICAgICB2YXIgdmVyID0gcm93cy5maW5kKGZ1bmN0aW9uKHIpeyByZXR1cm4gci50ZXh0Q29udGVudC5pbmRleE9mKCdydW50aW1lIFx1NzI0OFx1NjcyQycpPj0wOyB9KTtcclxuICAgICAgICByZXR1cm4ge29rOiByb3dzLmxlbmd0aCA+PSA1ICYmICEhdmVyLCBkZXRhaWw6ICdyb3dzPScrcm93cy5sZW5ndGgrKHZlcj8nIHZlcj0nK3Zlci50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNDApOicnKX07YCwgNl8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdEb2NrOkZpbGVzIFx1NkQ0Rlx1ODlDOCtcdTY1ODdcdTRFRjZcdTk4ODRcdTg5QzgnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdcdTY1ODdcdTRFRjYnfHx4LnRleHRDb250ZW50PT09J0ZpbGVzJzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdmcyByb3dzJywgYHZhciByb3dzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5mcy1yb3cnKS5sZW5ndGg7XHJcbiAgICAgICAgcmV0dXJuIHtvazogcm93cyA+PSAxLCBkZXRhaWw6ICdyb3dzPScrcm93c307YCwgNl8wMDApO1xyXG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICAvLyBcdTY4MzlcdTc2RUVcdTVGNTVcdTUzRUFcdTY3MDlcdTVERTVcdTRGNUNcdTUzM0FcdTc2RUVcdTVGNTUoZmFrZSBcdTRFMEVcdTc3MUZcdTVCOUUgcnVudGltZSBcdTU0MENcdTVGNjIpOlx1NTE0OFx1OEZEQlx1NzZFRVx1NUY1NSxcdTUxOERcdTcwQjlcdTY1ODdcdTRFRjZcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgZD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5mcy1yb3cnKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdkZW1vLXdvcmtzcGFjZScpPj0wIHx8IHgudGV4dENvbnRlbnQuaW5kZXhPZignXHVEODNEXHVEQ0MxJyk+PTA7fSk7IGlmKGQpIGQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCB3MiA9IGF3YWl0IHdhaXRGb3IoJ2ZpbGUgcm93cycsIGB2YXIgcm93cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5mcy1yb3cnKSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogcm93cy5zb21lKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1JFQURNRScpPj0wO30pLCBkZXRhaWw6ICdyb3dzPScrcm93cy5sZW5ndGh9O2AsIDZfMDAwKTtcclxuICAgICAgaWYgKCF3MlswXSkgcmV0dXJuIHcyO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBmPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmZzLXJvdycpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1JFQURNRScpPj0wO30pOyBpZihmKSBmLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2ZpbGUgcHJldmlldycsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuZnMtcHJldmlldycpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhcCAmJiBwLnRleHRDb250ZW50LmluZGV4T2YoJ2RlbW8gd29ya3NwYWNlJykgPj0gMCwgZGV0YWlsOiBwID8gcC50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNDApIDogJ25vIHByZXZpZXcnfTtgLCA2XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ0RvY2s6RGlmZiBcdTUzRDhcdTY2RjRcdTg4NEMnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdcdTUzRDhcdTY2RjQnfHx4LnRleHRDb250ZW50PT09J0RpZmYnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2RpZmYgcm93cycsIGB2YXIgcm93cz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZGlmZi1yb3cnKS5sZW5ndGg7XHJcbiAgICAgICAgcmV0dXJuIHtvazogcm93cyA+PSAxLCBkZXRhaWw6ICdkaWZmIHJvd3M9Jytyb3dzfTtgLCA2XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ0RvY2s6RXZpZGVuY2UgXHU4QkE0XHU3N0U1XHU2NTcwXHU2MzZFJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nXHU4QkMxXHU2MzZFJ3x8eC50ZXh0Q29udGVudD09PSdFdmlkZW5jZSc7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignZXZpZGVuY2Ugcm93cycsIGB2YXIgcm93cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXJvdycpKTtcclxuICAgICAgICB2YXIgbWVtID0gcm93cy5maW5kKGZ1bmN0aW9uKHIpeyByZXR1cm4gci50ZXh0Q29udGVudC5pbmRleE9mKCdcdThCQjBcdTVGQzZcdTVDNDInKT49MCB8fCByLnRleHRDb250ZW50LmluZGV4T2YoJ01lbW9yeSBsYXllcnMnKT49MDsgfSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFtZW0gJiYgbWVtLnRleHRDb250ZW50LmluZGV4T2YoJzMnKSA+PSAwLCBkZXRhaWw6IG1lbSA/IG1lbS50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpIDogJ25vIG1lbW9yeSByb3cnfTtgLCA2XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ0RvY2s6TG9ncyBcdTk3NjJcdTY3N0YoXHU3QTdBXHU2MDAxXHU2M0QwXHU3OTNBKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J1x1NjVFNVx1NUZENyd8fHgudGV4dENvbnRlbnQ9PT0nTG9ncyc7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignbG9ncyBwYW5lJywgYHZhciBsPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5sb2dzLWxpc3QnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWwsIGRldGFpbDogbCA/ICgncm93cz0nK2wucXVlcnlTZWxlY3RvckFsbCgnLmxvZy1yb3cnKS5sZW5ndGgpIDogJ25vIGxvZ3MgbGlzdCd9O2AsIDVfMDAwKTtcclxuICAgICAgcmV0dXJuIHc7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6RG9jazpcdThGRENcdTdBMEJcdTk4NzVcdTdCN0UoXHU2MjRCXHU2NzNBXHU4RkRDXHU3QTBCXHU2M0E3XHU1MjM2XHU5NzYyXHU2NzdGK1x1NUYwMFx1NjczQVx1ODFFQVx1NTQyRlx1ODg0QykgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnRG9jazpcdThGRENcdTdBMEJcdTk4NzVcdTdCN0UoXHU2MjRCXHU2NzNBXHU4RkRDXHU3QTBCXHU2M0E3XHU1MjM2XHU5NzYyXHU2NzdGKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J1x1OEZEQ1x1N0EwQid8fHgudGV4dENvbnRlbnQ9PT0nUmVtb3RlJzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdyZW1vdGUgcGFuZScsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuZG9jay1ib2R5Jyk7XHJcbiAgICAgICAgdmFyIHQgPSBwID8gcC50ZXh0Q29udGVudCA6ICcnO1xyXG4gICAgICAgIHZhciBva1QgPSB0LmluZGV4T2YoJ1x1NjI0Qlx1NjczQVx1OEZEQ1x1N0EwQlx1NjNBN1x1NTIzNicpPj0wIHx8IHQuaW5kZXhPZignUGhvbmUgcmVtb3RlJyk+PTA7XHJcbiAgICAgICAgdmFyIG9rQSA9IHQuaW5kZXhPZignXHU1RjAwXHU2NzNBXHU4MUVBXHU1NDJGJyk+PTAgfHwgdC5pbmRleE9mKCdBdXRvc3RhcnQnKT49MDtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXAgJiYgb2tUICYmIG9rQSwgZGV0YWlsOiB0LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw2MCl9O2AsIDZfMDAwKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTY0MUNcdTdEMjJcdThGQzdcdTZFRTQgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU0RjFBXHU4QkREXHU2NDFDXHU3RDIyOlx1OEZDN1x1NkVFNFx1NzUxRlx1NjU0OCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgYmVmb3JlID0gKGF3YWl0IGpzKGBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoYCkpIGFzIG51bWJlcjtcclxuICAgICAgYXdhaXQgdHlwZUludG8oJy5zZXNzaW9uLXNlYXJjaCcsICd6enotXHU0RTBEXHU1QjU4XHU1NzI4XHU3Njg0XHU0RjFBXHU4QkREJyk7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdmaWx0ZXJlZCBlbXB0eScsIGB2YXIgbj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoO1xyXG4gICAgICAgIHJldHVybiB7b2s6IG4gPT09IDAsIGRldGFpbDogJ2FmdGVyPScrbn07YCwgNV8wMDApO1xyXG4gICAgICBhd2FpdCB0eXBlSW50bygnLnNlc3Npb24tc2VhcmNoJywgJycpO1xyXG4gICAgICBhd2FpdCBzbGVlcCg0MDApO1xyXG4gICAgICBjb25zdCBhZnRlciA9IChhd2FpdCBqcyhgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aGApKSBhcyBudW1iZXI7XHJcbiAgICAgIHJldHVybiBbd1swXSAmJiBhZnRlciA9PT0gYmVmb3JlLCBgJHt3WzFdfTsgXHU2MDYyXHU1OTBEXHU1NDBFICR7YWZ0ZXJ9PT09JHtiZWZvcmV9YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6Q3RybCtLIFx1NTQ3RFx1NEVFNFx1OTc2Mlx1Njc3RiA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdDdHJsK0sgXHU1NDdEXHU0RUU0XHU5NzYyXHU2NzdGOlx1NjI1M1x1NUYwMFx1NUU3Nlx1NjI2N1x1ODg0Q1x1NTQ3RFx1NEVFNCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleTonaycsIGN0cmxLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdjbWRrIG9wZW4nLCBgdmFyIGM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNtZGsnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWMsIGRldGFpbDogYyA/ICdvcGVuJyA6ICdub3Qgb3Blbid9O2AsIDVfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgaXQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY21kay1pdGVtJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU2NTg3XHU0RUY2Jyk+PTAgfHwgeC50ZXh0Q29udGVudC5pbmRleE9mKCdGaWxlcycpPj0wO30pOyBpZihpdCkgaXQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcigndGFiIHN3aXRjaGVkJywgYHZhciB0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5kb2NrLXRhYi5hY3RpdmUnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXQgJiYgKHQudGV4dENvbnRlbnQ9PT0nXHU2NTg3XHU0RUY2J3x8dC50ZXh0Q29udGVudD09PSdGaWxlcycpLCBkZXRhaWw6ICdhY3RpdmU9JysodD90LnRleHRDb250ZW50Oidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdThCQkVcdTdGNkVcdTk3NjJcdTY3N0YgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU4QkJFXHU3RjZFKEN0cmwrU2hpZnQrUCk6UHJvdmlkZXIgXHU4ODY4XHU1MzU1XHU1M0VGXHU4OUMxLEVzYyBcdTUxNzNcdTk1RUQnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J3AnLCBjdHJsS2V5OnRydWUsIHNoaWZ0S2V5OnRydWUsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignc2V0dGluZ3Mgb3BlbicsIGB2YXIgcz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kay5zZXR0aW5ncycpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhcyAmJiAhIXMucXVlcnlTZWxlY3RvcignLnByb3ZpZGVyLWZvcm0nKSwgZGV0YWlsOiBzID8gJ29wZW4rZm9ybScgOiAnbm90IG9wZW4nfTtgLCA1XzAwMCk7XHJcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J0VzY2FwZScsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignc2V0dGluZ3MgY2xvc2VkJywgYHJldHVybiB7b2s6ICFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kay1vdmVybGF5JyksIGRldGFpbDogJ2Nsb3NlZCd9O2AsIDVfMDAwKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTppMThuIFx1OEJFRFx1OEEwMFx1NTIwN1x1NjM2MiA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdThCRURcdThBMDBcdTUyMDdcdTYzNjI6XHU0RTJEXHU2NTg3IFx1MjE5MiBFbmdsaXNoIFx1MjE5MiBcdTYwNjJcdTU5MERcdTRFMkRcdTY1ODcnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J3AnLCBjdHJsS2V5OnRydWUsIHNoaWZ0S2V5OnRydWUsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignc2V0dGluZ3Mgb3BlbicsIGB2YXIgcz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kay5zZXR0aW5ncycpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhcywgZGV0YWlsOiBzID8gJ29wZW4nIDogJ25vdCBvcGVuJ307YCwgNV8wMDApO1xyXG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNtZGsuc2V0dGluZ3MgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J0VuZ2xpc2gnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgZW4gPSBhd2FpdCB3YWl0Rm9yKCdlbmdsaXNoIHNob3duJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyLWhlYWQgLmJ0bi5wcmltYXJ5Jyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFiICYmIGIudGV4dENvbnRlbnQgPT09ICcrIE5ldyBTZXNzaW9uJywgZGV0YWlsOiAnYnRuPScrKGI/Yi50ZXh0Q29udGVudDonbm9uZScpfTtgLCA1XzAwMCk7XHJcbiAgICAgIGF3YWl0IHNob3QoJ2VuZ2xpc2gnKTtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jbWRrLnNldHRpbmdzIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTRFMkRcdTY1ODcnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgemggPSBhd2FpdCB3YWl0Rm9yKCdjaGluZXNlIGJhY2snLCBgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXItaGVhZCAuYnRuLnByaW1hcnknKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWIgJiYgYi50ZXh0Q29udGVudCA9PT0gJysgXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREJywgZGV0YWlsOiAnYnRuPScrKGI/Yi50ZXh0Q29udGVudDonbm9uZScpfTtgLCA1XzAwMCk7XHJcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J0VzY2FwZScsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICByZXR1cm4gW2VuWzBdICYmIHpoWzBdLCBgZW46ICR7ZW5bMV19OyB6aDogJHt6aFsxXX1gXTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTVERTVcdTRGNUNcdTUzM0FcdTdCQTFcdTc0MDYoXHU1REU2XHU2ODBGXHU2ODBGXHU0RjREICsgXHU4M0RDXHU1MzU1ICsgXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREXHU5MDA5XHU1REU1XHU0RjVDXHU1MzNBKSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTVERTVcdTRGNUNcdTUzM0E6XHU1REU2XHU2ODBGXHU1REU1XHU0RjVDXHU1MzNBXHU2ODBGXHU1M0VGXHU4OUMxKFx1NUY1M1x1NTI0RFx1NURFNVx1NEY1Q1x1NTMzQVx1NTQwRCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCd3b3Jrc3BhY2UgYmFyJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53b3Jrc3BhY2UtYmFyJyk7XHJcbiAgICAgICAgdmFyIG4gPSBiID8gKGIucXVlcnlTZWxlY3RvcignLndzLWJhci1uYW1lJyl8fHt9KS50ZXh0Q29udGVudCA6ICcnO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYiAmJiAhIW4gJiYgbi5sZW5ndGggPiAwICYmIG4uaW5kZXhPZignXHU1MkEwXHU4RjdEJykgPCAwLCBkZXRhaWw6ICdiYXI9JysoYj8neWVzJzonbm8nKSsnIG5hbWU9JytufTtgLCA4XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ1x1NURFNVx1NEY1Q1x1NTMzQTpcdTgzRENcdTUzNTVcdTVGMzlcdTUxRkEsXHU1MjE3XHU4ODY4K1x1NUY1M1x1NTI0RFx1OUFEOFx1NEVBRStcdTZERkJcdTUyQTBcdTUxNjVcdTUzRTM7XHU1NzI4XHU2MzA3XHU1QjlBXHU1REU1XHU0RjVDXHU1MzNBXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53b3Jrc3BhY2UtYmFyJyk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignd3MgbWVudScsIGB2YXIgbT1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtbWVudScpO1xyXG4gICAgICAgIHZhciBpdGVtcyA9IG0gPyBtLnF1ZXJ5U2VsZWN0b3JBbGwoJy53cy1tZW51LWl0ZW0nKS5sZW5ndGggOiAwO1xyXG4gICAgICAgIHZhciBjdXIgPSBtID8gbS5xdWVyeVNlbGVjdG9yQWxsKCcud3MtbWVudS1pdGVtLmN1cnJlbnQnKS5sZW5ndGggOiAwO1xyXG4gICAgICAgIHZhciBhZGQgPSBtID8gKG0udGV4dENvbnRlbnQuaW5kZXhPZignXHU2REZCXHU1MkEwXHU1REU1XHU0RjVDXHU1MzNBJyk+PTAgfHwgbS50ZXh0Q29udGVudC5pbmRleE9mKCdBZGQgd29ya3NwYWNlJyk+PTApIDogZmFsc2U7XHJcbiAgICAgICAgcmV0dXJuIHtvazogaXRlbXMgPj0gMSAmJiBjdXIgPj0gMSAmJiBhZGQsIGRldGFpbDogJ2l0ZW1zPScraXRlbXMrJyBjdXJyZW50PScrY3VyKycgYWRkPScrYWRkfTtgLCA2XzAwMCk7XHJcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgIGF3YWl0IHNob3QoJ3dzLW1lbnUnKTtcclxuICAgICAgLy8gXHU3MEI5XHU3QjJDXHU0RTAwXHU0RTJBXHU1REU1XHU0RjVDXHU1MzNBXHU5ODc5ID0gXHU1NzI4XHU4QkU1XHU1REU1XHU0RjVDXHU1MzNBXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREKFx1ODNEQ1x1NTM1NVx1NTE3M1x1OTVFRFx1MzAwMWNvbXBvc2VyIFx1NTNFRlx1NzUyOClcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgaXQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLW1lbnUtaXRlbScpOyBpZihpdCkgaXQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBjbG9zZWQgPSBhd2FpdCB3YWl0Rm9yKCdtZW51IGNsb3NlZCArIHNlc3Npb24gYWN0aXZlJywgYHZhciB0YT1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY29tcG9zZXIgdGV4dGFyZWEnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLW1lbnUnKSAmJiAhIXRhICYmIHRhLmRpc2FibGVkID09PSBmYWxzZSwgZGV0YWlsOiAnbWVudT0nKyhkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtbWVudScpPydvcGVuJzonY2xvc2VkJykrJyB0YT0nKyh0YT90YS5kaXNhYmxlZDonbm9uZScpfTtgLCA2XzAwMCk7XHJcbiAgICAgIHJldHVybiBbY2xvc2VkWzBdLCBgJHt3WzFdfTsgJHtjbG9zZWRbMV19YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU0RjFBXHU4QkREXHU2MzA5XHU1REU1XHU0RjVDXHU1MzNBXHU1MjA2XHU3RUM0ICsgXHU1QzU1XHU1RjAwL1x1NjUzNlx1OEQ3NyA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTRGMUFcdThCRERcdTUyMDZcdTdFQzQ6XHU3RUM0XHU1OTM0XHU1MUZBXHU3M0IwKFx1NURFNVx1NEY1Q1x1NTMzQVx1NTQwRCtcdTY1NzBcdTkxQ0YpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignZ3JvdXAgaGVhZCcsIGB2YXIgaD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtZ3JvdXAtaGVhZCcpO1xyXG4gICAgICAgIHZhciBuID0gaCA/IChoLnF1ZXJ5U2VsZWN0b3IoJy53cy1ncm91cC1uYW1lJyl8fHt9KS50ZXh0Q29udGVudCA6ICcnO1xyXG4gICAgICAgIHZhciBjID0gaCA/IChoLnF1ZXJ5U2VsZWN0b3IoJy53cy1ncm91cC1jb3VudCcpfHx7fSkudGV4dENvbnRlbnQgOiAnJztcclxuICAgICAgICByZXR1cm4ge29rOiAhIWggJiYgbi5sZW5ndGggPiAwICYmIGMubGVuZ3RoID4gMCwgZGV0YWlsOiAnbmFtZT0nK24rJyBjb3VudD0nK2N9O2AsIDhfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnXHU0RjFBXHU4QkREXHU1MjA2XHU3RUM0Olx1NzBCOVx1NTFGQlx1N0VDNFx1NTkzNFx1NjUzNlx1OEQ3NyxcdTUxOERcdTcwQjlcdTVDNTVcdTVGMDBcdTYwNjJcdTU5MEQnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IGJlZm9yZSA9IChhd2FpdCBqcyhgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aGApKSBhcyBudW1iZXI7XHJcbiAgICAgIGlmIChiZWZvcmUgPT09IDApIHJldHVybiBbZmFsc2UsICdubyBzZXNzaW9ucyB0byBncm91cCddO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBoPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1ncm91cC1oZWFkJyk7IGlmKGgpIGguY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBjb2xsYXBzZWQgPSBhd2FpdCB3YWl0Rm9yKCdjb2xsYXBzZWQnLCBgdmFyIGc9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLWdyb3VwJyk7XHJcbiAgICAgICAgdmFyIGhpZGRlbiA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGggPCAke2JlZm9yZX07XHJcbiAgICAgICAgcmV0dXJuIHtvazogaGlkZGVuLCBkZXRhaWw6ICdpdGVtcz0nK2RvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGgrJyBiZWZvcmU9JHtiZWZvcmV9J307YCwgNV8wMDApO1xyXG4gICAgICBhd2FpdCBzaG90KCd3cy1ncm91cC1jb2xsYXBzZWQnKTtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgaD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtZ3JvdXAtaGVhZCcpOyBpZihoKSBoLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgZXhwYW5kZWQgPSBhd2FpdCB3YWl0Rm9yKCdleHBhbmRlZCBiYWNrJywgYHZhciBuPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGg7XHJcbiAgICAgICAgcmV0dXJuIHtvazogbiA+PSAke2JlZm9yZX0sIGRldGFpbDogJ2l0ZW1zPScrbn07YCwgNV8wMDApO1xyXG4gICAgICByZXR1cm4gW2NvbGxhcHNlZFswXSAmJiBleHBhbmRlZFswXSwgYGNvbGxhcHNlOiAke2NvbGxhcHNlZFsxXX07IGV4cGFuZDogJHtleHBhbmRlZFsxXX1gXTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTVGRUJcdTYzNzdcdTk1MkVcdTVFMkVcdTUyQTlcdTk3NjJcdTY3N0YoQ3RybCsvKSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTVGRUJcdTYzNzdcdTk1MkVcdTVFMkVcdTUyQTk6Q3RybCsvIFx1NjI1M1x1NUYwMCxFc2MgXHU1MTczXHU5NUVEJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OicvJywgY3RybEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3Nob3J0Y3V0cyBvcGVuJywgYHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrJyk7XHJcbiAgICAgICAgdmFyIHJvd3MgPSBzID8gcy5xdWVyeVNlbGVjdG9yQWxsKCcuc2hvcnRjdXQtcm93JykubGVuZ3RoIDogMDtcclxuICAgICAgICByZXR1cm4ge29rOiByb3dzID49IDUsIGRldGFpbDogJ3Jvd3M9Jytyb3dzfTtgLCA1XzAwMCk7XHJcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgIGF3YWl0IHNob3QoJ3Nob3J0Y3V0cycpO1xyXG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidFc2NhcGUnLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ3Nob3J0Y3V0cyBjbG9zZWQnLCBgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrLW92ZXJsYXknKSwgZGV0YWlsOiAnY2xvc2VkJ307YCwgNV8wMDApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NEZBN1x1NjgwRlx1NjUzNlx1N0YyOSArIFx1NzJCNlx1NjAwMVx1OEZDN1x1NkVFNCA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTRGQTdcdTY4MEZcdTY1MzZcdTdGMjk6XHUyMUU0IFx1NjUzNlx1OEQ3N1x1NURFNlx1NjgwRixcdTIxRTUgXHU1QzU1XHU1RjAwXHU2MDYyXHU1OTBEJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAvLyBISUcgUDMgXHU3RUM0MjpcdTIxRTQvXHUyMUU1IEVtb2ppIFx1NURGMlx1NjM2MiBTVkcgaWNvbixcdTYzMDlcdTk0QUVcdTRFRTUgYXJpYS1sYWJlbChcdTU0MkJcIlx1NEZBN1x1NjgwRlwiKVx1NUI5QVx1NEY0RFxyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcigndG9nZ2xlIGJ0bicsIGB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50b3BiYXIgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuICh4LmdldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcpfHwnJykuaW5kZXhPZignXHU0RkE3XHU2ODBGJyk+PTA7fSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFiLCBkZXRhaWw6ICdidG49JysoYj9iLmdldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcpOidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50b3BiYXIgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuICh4LmdldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcpfHwnJykuaW5kZXhPZignXHU0RkE3XHU2ODBGJyk+PTA7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBoaWRkZW4gPSBhd2FpdCB3YWl0Rm9yKCdzaWRlYmFyIGhpZGRlbicsIGB2YXIgc2I9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXInKTtcclxuICAgICAgICB2YXIgZ29uZSA9ICFzYiB8fCBnZXRDb21wdXRlZFN0eWxlKHNiKS5kaXNwbGF5ID09PSAnbm9uZSc7XHJcbiAgICAgICAgcmV0dXJuIHtvazogZ29uZSwgZGV0YWlsOiAnZGlzcGxheT0nKyhzYj9nZXRDb21wdXRlZFN0eWxlKHNiKS5kaXNwbGF5Oidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50b3BiYXIgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuICh4LmdldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcpfHwnJykuaW5kZXhPZignXHU0RkE3XHU2ODBGJyk+PTA7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBzaG93biA9IGF3YWl0IHdhaXRGb3IoJ3NpZGViYXIgYmFjaycsIGB2YXIgc2I9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXInKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXNiICYmIGdldENvbXB1dGVkU3R5bGUoc2IpLmRpc3BsYXkgIT09ICdub25lJywgZGV0YWlsOiAnZGlzcGxheT0nKyhzYj9nZXRDb21wdXRlZFN0eWxlKHNiKS5kaXNwbGF5Oidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgICAgcmV0dXJuIFtoaWRkZW5bMF0gJiYgc2hvd25bMF0sIGBoaWRlOiAke2hpZGRlblsxXX07IHNob3c6ICR7c2hvd25bMV19YF07XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ1x1NzJCNlx1NjAwMVx1OEZDN1x1NkVFNDpcdTRFMEJcdTYyQzlcdTUyMDdcdTYzNjJcdTUyMzBcIlx1OEZEMFx1ODg0Q1x1NEUyRFwiXHU0RTBEXHU1RDI5XHU2RTgzXHU1RTc2XHU2MDYyXHU1OTBEJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCBzZWwgPSBhd2FpdCB3YWl0Rm9yKCdmaWx0ZXIgc2VsZWN0JywgYHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zdGF0dXMtZmlsdGVyJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFzICYmIHMub3B0aW9ucy5sZW5ndGggPj0gNCwgZGV0YWlsOiAnb3B0aW9ucz0nKyhzP3Mub3B0aW9ucy5sZW5ndGg6MCl9O2AsIDVfMDAwKTtcclxuICAgICAgaWYgKCFzZWxbMF0pIHJldHVybiBzZWw7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnN0YXR1cy1maWx0ZXInKTsgcy52YWx1ZT0ncnVubmluZyc7IHMuZGlzcGF0Y2hFdmVudChuZXcgRXZlbnQoJ2NoYW5nZScse2J1YmJsZXM6dHJ1ZX0pKTsgfSkoKWApO1xyXG4gICAgICBhd2FpdCBzbGVlcCg1MDApO1xyXG4gICAgICBjb25zdCByMSA9IChhd2FpdCBqcyhgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aGApKSBhcyBudW1iZXI7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnN0YXR1cy1maWx0ZXInKTsgcy52YWx1ZT0nYWxsJzsgcy5kaXNwYXRjaEV2ZW50KG5ldyBFdmVudCgnY2hhbmdlJyx7YnViYmxlczp0cnVlfSkpOyB9KSgpYCk7XHJcbiAgICAgIGF3YWl0IHNsZWVwKDUwMCk7XHJcbiAgICAgIGNvbnN0IHIyID0gKGF3YWl0IGpzKGBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoYCkpIGFzIG51bWJlcjtcclxuICAgICAgcmV0dXJuIFtyMiA+PSByMSAmJiByMiA+PSAxLCBgcnVubmluZz0ke3IxfSBhbGw9JHtyMn1gXTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTZBMjFcdTU3OEJcdTkwMDlcdTYyRTlcdTU2NjgoXHU5ODc2XHU2ODBGXHU1MjA3XHU2MzYyIGNoYXQgXHU4REVGXHU3NTMxKSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTZBMjFcdTU3OEJcdTkwMDlcdTYyRTlcdTU2Njg6XHU5ODc2XHU2ODBGXHU4M0RDXHU1MzU1XHU1MjE3XHU1MUZBIHByb3ZpZGVycyBcdTVFNzZcdTUzRUZcdTUyMDdcdTYzNjInLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdtb2RlbCBidXR0b24nLCBgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnRvcGJhci1tb2RlbC5hcy1idXR0b24nKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWIgJiYgYi5kaXNhYmxlZCA9PT0gZmFsc2UsIGRldGFpbDogYiA/IGIudGV4dENvbnRlbnQgOiAnbm9uZSd9O2AsIDZfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudG9wYmFyLW1vZGVsLmFzLWJ1dHRvbicpOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgbSA9IGF3YWl0IHdhaXRGb3IoJ21vZGVsIG1lbnUnLCBgdmFyIG09ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLm1vZGVsLW1lbnUnKTtcclxuICAgICAgICB2YXIgaXRlbXMgPSBtID8gbS5xdWVyeVNlbGVjdG9yQWxsKCcud3MtbWVudS1pdGVtJykubGVuZ3RoIDogMDtcclxuICAgICAgICB2YXIgY3VyID0gbSA/IG0ucXVlcnlTZWxlY3RvckFsbCgnLndzLW1lbnUtaXRlbS5jdXJyZW50JykubGVuZ3RoIDogMDtcclxuICAgICAgICByZXR1cm4ge29rOiBpdGVtcyA+PSAyICYmIGN1ciA+PSAxLCBkZXRhaWw6ICdpdGVtcz0nK2l0ZW1zKycgY3VycmVudD0nK2N1cn07YCwgNV8wMDApO1xyXG4gICAgICBpZiAoIW1bMF0pIHJldHVybiBtO1xyXG4gICAgICBhd2FpdCBzaG90KCdtb2RlbC1tZW51Jyk7XHJcbiAgICAgIC8vIFx1NTIwN1x1NTIzMFx1N0IyQ1x1NEU4Q1x1NEUyQSBwcm92aWRlcihmYWtlOiBkZW1vLXZpc2lvbi9mYWtlLW0tdmlzaW9uKVxyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBpdHM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcubW9kZWwtbWVudSAud3MtbWVudS1pdGVtJykpOyB2YXIgaXQ9aXRzW2l0cy5sZW5ndGgtMV07IGlmKGl0KSBpdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdtb2RlbCBzd2l0Y2hlZCcsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudG9wYmFyLW1vZGVsLmFzLWJ1dHRvbicpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYiAmJiBiLnRleHRDb250ZW50LmluZGV4T2YoJ2Zha2UtbS12aXNpb24nKSA+PSAwLCBkZXRhaWw6ICdiYWRnZT0nKyhiP2IudGV4dENvbnRlbnQ6J25vbmUnKX07YCwgNl8wMDApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NEUzQlx1OTg5OChcdTZENDVcdTgyNzJcdTc1MUZcdTY1NDhcdTIxOTJcdTYwNjJcdTU5MERcdTZERjFcdTgyNzIpID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1NEUzQlx1OTg5ODpcdThCQkVcdTdGNkVcdTUyMDdcdTZENDVcdTgyNzJcdTc1MUZcdTY1NDgsXHU2MDYyXHU1OTBEXHU2REYxXHU4MjcyJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidwJywgY3RybEtleTp0cnVlLCBzaGlmdEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3NldHRpbmdzIG9wZW4nLCBgdmFyIHM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNtZGsuc2V0dGluZ3MnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXMsIGRldGFpbDogcyA/ICdvcGVuJyA6ICdub3Qgb3Blbid9O2AsIDVfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jbWRrLnNldHRpbmdzIC5zZWcgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NkQ0NVx1ODI3Mid8fHgudGV4dENvbnRlbnQudHJpbSgpPT09J0xpZ2h0Jzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IGxpZ2h0ID0gYXdhaXQgd2FpdEZvcignbGlnaHQgdGhlbWUnLCBgdmFyIGR0PWRvY3VtZW50LmRvY3VtZW50RWxlbWVudC5kYXRhc2V0LnRoZW1lO1xyXG4gICAgICAgIHZhciBiZyA9IGdldENvbXB1dGVkU3R5bGUoZG9jdW1lbnQuYm9keSkuYmFja2dyb3VuZENvbG9yO1xyXG4gICAgICAgIHZhciBtID0gL1xcXFxkKy9nOyB2YXIgbnVtcz0oYmcubWF0Y2gobSl8fFsnMCcsJzAnLCcwJ10pLm1hcChOdW1iZXIpO1xyXG4gICAgICAgIHJldHVybiB7b2s6IGR0PT09J2xpZ2h0JyAmJiBudW1zWzBdPjIwMCAmJiBudW1zWzFdPjIwMCAmJiBudW1zWzJdPjIwMCwgZGV0YWlsOiAndGhlbWU9JytkdCsnIGJnPScrYmd9O2AsIDVfMDAwKTtcclxuICAgICAgYXdhaXQgc2hvdCgnbGlnaHQtdGhlbWUnKTtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jbWRrLnNldHRpbmdzIC5zZWcgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NkRGMVx1ODI3Mid8fHgudGV4dENvbnRlbnQudHJpbSgpPT09J0RhcmsnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgZGFyayA9IGF3YWl0IHdhaXRGb3IoJ2RhcmsgYmFjaycsIGByZXR1cm4ge29rOiBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuZGF0YXNldC50aGVtZT09PSdkYXJrJywgZGV0YWlsOiAndGhlbWU9Jytkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuZGF0YXNldC50aGVtZX07YCwgNV8wMDApO1xyXG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidFc2NhcGUnLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgcmV0dXJuIFtsaWdodFswXSAmJiBkYXJrWzBdLCBgbGlnaHQ6ICR7bGlnaHRbMV19OyBkYXJrOiAke2RhcmtbMV19YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU5ODc2XHU2ODBGIFx1NEUyRC9FTiBcdTVGRUJcdTYzNzdcdTUyMDdcdTYzNjIoXHU1M0VGXHU1M0QxXHU3M0IwXHU2MDI3KSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTk4NzZcdTY4MEZcdTVGRUJcdTYzNzdcdTUyMDdcdTYzNjI6XHU0RTJEL0VOIFx1NEUwMFx1OTUyRVx1NTIwN1x1NjM2MicsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2xhbmcgc2VnJywgYHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5sYW5nLXNlZycpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhcyAmJiBzLnF1ZXJ5U2VsZWN0b3JBbGwoJ2J1dHRvbicpLmxlbmd0aCA9PT0gMiwgZGV0YWlsOiBzID8gJ3ByZXNlbnQnIDogJ2Fic2VudCd9O2AsIDVfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5sYW5nLXNlZyBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nRU4nO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgZW4gPSBhd2FpdCB3YWl0Rm9yKCdlbmdsaXNoJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyLWhlYWQgLmJ0bi5wcmltYXJ5Jyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFiICYmIGIudGV4dENvbnRlbnQgPT09ICcrIE5ldyBTZXNzaW9uJywgZGV0YWlsOiAnYnRuPScrKGI/Yi50ZXh0Q29udGVudDonbm9uZScpfTtgLCA1XzAwMCk7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcubGFuZy1zZWcgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NEUyRCc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCB6aCA9IGF3YWl0IHdhaXRGb3IoJ2NoaW5lc2UgYmFjaycsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhci1oZWFkIC5idG4ucHJpbWFyeScpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYiAmJiBiLnRleHRDb250ZW50ID09PSAnKyBcdTY1QjBcdTVFRkFcdTRGMUFcdThCREQnLCBkZXRhaWw6ICdidG49JysoYj9iLnRleHRDb250ZW50Oidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgICAgcmV0dXJuIFtlblswXSAmJiB6aFswXSwgYGVuOiAke2VuWzFdfTsgemg6ICR7emhbMV19YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU3Qzk4XHU4RDM0XHU1NkZFXHU3MjQ3IFx1MjE5MiBcdTdGMjlcdTc1NjVcdTU2RkUgY2hpcCBcdTIxOTIgXHU1M0QxXHU5MDAxIFx1MjE5MiBydW50aW1lIFx1NjUzNlx1NTIzMCA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTdDOThcdThEMzRcdTU2RkVcdTcyNDc6XHU3RjI5XHU3NTY1XHU1NkZFIGNoaXAgKyBcdTUzRDFcdTkwMDFcdTU0MEUgcnVudGltZSBcdTY1MzZcdTUyMzBcdTU2RkVcdTcyNDcnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIC8vIFx1NjVCMFx1NUVGQVx1NEYxQVx1OEJERFx1Nzg2RVx1NEZERCBjb21wb3NlciBcdTUzRUZcdTc1MjhcclxuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleTonbicsIGN0cmxLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XHJcbiAgICAgIGF3YWl0IHNsZWVwKDMwMCk7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXtcclxuICAgICAgICB2YXIgdGEgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY29tcG9zZXIgdGV4dGFyZWEnKTtcclxuICAgICAgICBpZiAoIXRhKSByZXR1cm47XHJcbiAgICAgICAgdmFyIGMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdjYW52YXMnKTtcclxuICAgICAgICBjLndpZHRoID0gODsgYy5oZWlnaHQgPSA4O1xyXG4gICAgICAgIHZhciBjdHggPSBjLmdldENvbnRleHQoJzJkJyk7XHJcbiAgICAgICAgY3R4LmZpbGxTdHlsZSA9ICcjM2Y5NjUwJzsgY3R4LmZpbGxSZWN0KDAsIDAsIDgsIDgpO1xyXG4gICAgICAgIGMudG9CbG9iKGZ1bmN0aW9uKGJsb2Ipe1xyXG4gICAgICAgICAgdmFyIGR0ID0gbmV3IERhdGFUcmFuc2ZlcigpO1xyXG4gICAgICAgICAgZHQuaXRlbXMuYWRkKG5ldyBGaWxlKFtibG9iXSwgJ3Bhc3RlZC5wbmcnLCB7dHlwZTogJ2ltYWdlL3BuZyd9KSk7XHJcbiAgICAgICAgICB0YS5kaXNwYXRjaEV2ZW50KG5ldyBDbGlwYm9hcmRFdmVudCgncGFzdGUnLCB7Y2xpcGJvYXJkRGF0YTogZHQsIGJ1YmJsZXM6IHRydWUsIGNhbmNlbGFibGU6IHRydWV9KSk7XHJcbiAgICAgICAgfSwgJ2ltYWdlL3BuZycpO1xyXG4gICAgICB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IGNoaXAgPSBhd2FpdCB3YWl0Rm9yKCdpbWFnZSBjaGlwJywgYHZhciBuPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5hdHQtY2hpcC5pbWcnKS5sZW5ndGg7XHJcbiAgICAgICAgcmV0dXJuIHtvazogbiA+PSAxLCBkZXRhaWw6ICdpbWcgY2hpcHM9JytufTtgLCA2XzAwMCk7XHJcbiAgICAgIGlmICghY2hpcFswXSkgcmV0dXJuIGNoaXA7XHJcbiAgICAgIGF3YWl0IHR5cGVJbnRvKCcuY29tcG9zZXIgdGV4dGFyZWEnLCAnXHU3NzBCXHU4RkQ5XHU1RjIwXHU1NkZFJyk7XHJcbiAgICAgIGF3YWl0IHNsZWVwKDIwMCk7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY29tcG9zZXIgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NTNEMVx1OTAwMSc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBkb25lID0gYXdhaXQgd2FpdEZvcignaW1hZ2Ugc2VudCcsIGBcclxuICAgICAgICB2YXIgYXAgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuYXBwcm92YWwtY2FyZCBidXR0b24nKTtcclxuICAgICAgICBpZiAoYXAgJiYgYXAudGV4dENvbnRlbnQudHJpbSgpLmluZGV4T2YoJ1x1NjI3OVx1NTFDNicpPj0wKSBhcC5jbGljaygpO1xyXG4gICAgICAgIHZhciB0cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50dXJuJykpO1xyXG4gICAgICAgIHZhciBoaXQgPSB0cy5maWx0ZXIoZnVuY3Rpb24oeCl7IHJldHVybiB4LmNsYXNzTmFtZS5pbmRleE9mKCd1c2VyJyk8MCAmJiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1tpbWFnZXM6IDFdJykgPj0gMDsgfSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogaGl0Lmxlbmd0aCA+PSAxLCBkZXRhaWw6ICdydW50aW1lLWVjaG8td2l0aC1pbWFnZT0nK2hpdC5sZW5ndGh9O1xyXG4gICAgICBgLCAxNV8wMDApO1xyXG4gICAgICBhd2FpdCBzaG90KCdwYXN0ZWQtaW1hZ2UnKTtcclxuICAgICAgcmV0dXJuIGRvbmU7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHVEODNEXHVEQ0NFIFx1NEUwQVx1NEYyMC9cdUQ4M0RcdURDQzEgXHU2RDRGXHU4OUM4XHU2MzA5XHU5NEFFXHU1QzMxXHU0RjREID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1OTY0NFx1NEVGNlx1NEUwRVx1NzZFRVx1NUY1NVx1NTE2NVx1NTNFMzpcdUQ4M0RcdURDQ0UgXHU0RTBBXHU0RjIwICsgXHVEODNEXHVEQ0MxIFx1NkQ0Rlx1ODlDOFx1NjMwOVx1OTRBRVx1NUI1OFx1NTcyOCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgciA9IChhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XHJcbiAgICAgICAgdmFyIHVwID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNvbXBvc2VyIGJ1dHRvblthcmlhLWxhYmVsKj1cIlx1NEUwQVx1NEYyMFwiXSwgLmNvbXBvc2VyIGJ1dHRvblthcmlhLWxhYmVsKj1cIlVwbG9hZFwiXScpO1xyXG4gICAgICAgIHZhciBiciA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1waWNrZXIgYnV0dG9uJyk7XHJcbiAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHt1cDogISF1cCwgYnJvd3NlOiAhIWJyfSk7XHJcbiAgICAgIH0pKClgKSkgYXMgc3RyaW5nO1xyXG4gICAgICBjb25zdCBwID0gSlNPTi5wYXJzZShyKSBhcyB7IHVwOiBib29sZWFuOyBicm93c2U6IGJvb2xlYW4gfTtcclxuICAgICAgcmV0dXJuIFtwLnVwICYmIHAuYnJvd3NlLCBgXHVEODNEXHVEQ0NFPSR7cC51cH0gXHVEODNEXHVEQ0MxPSR7cC5icm93c2V9YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6QCBcdTk2NDRcdTRFRjZcdTkwMDlcdTYyRTlcdTU2NjggPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnQCBcdTk2NDRcdTRFRjY6XHU5MDA5XHU2MkU5XHU1NjY4XHU1MUZBXHU3M0IwXHU1RTc2XHU1M0VGXHU5MDA5XHU2NTg3XHU0RUY2JywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNvbXBvc2VyIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdAJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdhdHQgcGlja2VyJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5hdHQtcGlja2VyJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFwLCBkZXRhaWw6IHAgPyAnb3BlbicgOiAnbm90IG9wZW4nfTtgLCA1XzAwMCk7XHJcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgIGF3YWl0IHR5cGVJbnRvKCcuYXR0LXBpY2tlciBpbnB1dCcsICdyZWFkJyk7XHJcbiAgICAgIGNvbnN0IHcyID0gYXdhaXQgd2FpdEZvcignYXR0IHJlc3VsdHMnLCBgdmFyIHI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmF0dC1yZXN1bHRzIC5mcy1yb3cnKS5sZW5ndGg7XHJcbiAgICAgICAgcmV0dXJuIHtvazogciA+PSAxLCBkZXRhaWw6ICdyZXN1bHRzPScrcn07YCwgNl8wMDApO1xyXG4gICAgICBpZiAoIXcyWzBdKSByZXR1cm4gdzI7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGY9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmF0dC1yZXN1bHRzIC5mcy1yb3cnKTsgaWYoZikgZi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdhdHQgY2hpcCcsIGB2YXIgYz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuYXR0LWNoaXAnKS5sZW5ndGg7XHJcbiAgICAgICAgcmV0dXJuIHtvazogYyA+PSAxLCBkZXRhaWw6ICdjaGlwcz0nK2N9O2AsIDVfMDAwKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZShcdTU0MTFcdTVCRkNcdTY3ODRcdTkwMjApOlx1OEJCRVx1N0Y2RVx1MzAwQ1x1OTFDRFx1NjVCMFx1OTE0RFx1N0Y2RVx1MzAwRFx1OTFDRFx1NTE2NSArIFx1OTAwOVx1NjJFOVx1NjMwMVx1NEU0NSA9PT09PT09PT09ICovXHJcbiAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfV0laQVJEID09PSAnZmFrZScpIHtcclxuICAgICAgYXdhaXQgc3RlcCgnXHU1NDExXHU1QkZDOlx1OEJCRVx1N0Y2RVx1MzAwQ1x1OTFDRFx1NjVCMFx1OTE0RFx1N0Y2RVx1MzAwRFx1OTFDRFx1NTE2NSArIFx1OTAwOVx1NjJFOVx1NjMwMVx1NEU0NSh3aXphcmQuanNvbiknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleToncCcsIGN0cmxLZXk6dHJ1ZSwgc2hpZnRLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XHJcbiAgICAgICAgY29uc3Qgb3BlbiA9IGF3YWl0IHdhaXRGb3IoJ3NldHRpbmdzIG9wZW4nLCBgdmFyIHM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNtZGsuc2V0dGluZ3MnKTtcclxuICAgICAgICAgIHJldHVybiB7b2s6ICEhcywgZGV0YWlsOiBzID8gJ29wZW4nIDogJ2Nsb3NlZCd9O2AsIDVfMDAwKTtcclxuICAgICAgICBpZiAoIW9wZW5bMF0pIHJldHVybiBvcGVuO1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY21kay5zZXR0aW5ncyBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTkxQ0RcdTY1QjBcdTkxNERcdTdGNkUnKT49MDt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgY29uc3Qgc2hvd24gPSBhd2FpdCB3YWl0Rm9yKCd3aXphcmQgcmVvcGVuZWQnLCBgcmV0dXJuIHtvazogISFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKSxcclxuICAgICAgICAgIGRldGFpbDogZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1vdmVybGF5JykgPyAnb3BlbicgOiAnY2xvc2VkJ307YCwgNV8wMDApO1xyXG4gICAgICAgIGlmICghc2hvd25bMF0pIHJldHVybiBzaG93bjtcclxuICAgICAgICBhd2FpdCBzaG90KCd3aXphcmQtcmVlbnRyeScpO1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NTNENlx1NkQ4OCc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgIGNvbnN0IGNsb3NlZCA9IGF3YWl0IHdhaXRGb3IoJ3dpemFyZCBjbG9zZWQnLCBgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3ZlcmxheScpLCBkZXRhaWw6ICdjbG9zZWQnfTtgLCA1XzAwMCk7XHJcbiAgICAgICAgY29uc3Qgc3QgPSAoYXdhaXQganMoYHdpbmRvdy5obWguZ2V0V2l6YXJkKCkudGhlbihmdW5jdGlvbihyKXtyZXR1cm4gSlNPTi5zdHJpbmdpZnkocik7fSlgKSkgYXMgc3RyaW5nO1xyXG4gICAgICAgIGNvbnN0IHAgPSBKU09OLnBhcnNlKHN0KSBhcyB7IHBlcnNpc3RlZD86IHsgZG9uZT86IGJvb2xlYW47IGNob2ljZT86IHN0cmluZyB9IH07XHJcbiAgICAgICAgY29uc3QgcGVyc2lzdGVkID0gcC5wZXJzaXN0ZWQ/LmRvbmUgPT09IHRydWUgJiYgcC5wZXJzaXN0ZWQ/LmNob2ljZSA9PT0gJ2J1bmRsZWQnO1xyXG4gICAgICAgIHJldHVybiBbY2xvc2VkWzBdICYmIHBlcnNpc3RlZCwgYGNsb3NlZD0ke2Nsb3NlZFswXX0gcGVyc2lzdGVkPSR7SlNPTi5zdHJpbmdpZnkocC5wZXJzaXN0ZWQgPz8gbnVsbCl9YF07XHJcbiAgICAgIH0pO1xyXG5cclxuICAgICAgLyogPT09PT09PT09PSBmYWtlKFx1NTQxMVx1NUJGQ1x1Njc4NFx1OTAyMCk6XHU3QTg0XHU1QzRGIDM2MFx1MDBENzY0MCBcdTUxNjhcdTUxNDNcdTdEMjBcdTUzRUZcdThGQkUgKyBcdTUzNTVcdTUxRkJcdTkwMDlcdTk4NzlcdTUzNzNcdTUyNERcdThGREIgPT09PT09PT09PVxyXG4gICAgICAgICBcdTc1MjhcdTYyMzdcdTYyNEJcdTY3M0FcdTVCOUVcdTZENEJcdTc1REJcdTcwQjk6XHU3QTg0XHU4OUM2XHU1M0UzXHU0RTBCXHU5MDA5XHU5ODc5L1x1NjMwOVx1OTRBRVx1ODhBQlx1ODhDMVx1NTIwN1x1NzBCOVx1NEUwRFx1NTIzMFx1MzAwMlx1NEYyQVx1OTAyMFwiXHU2OEMwXHU2RDRCXHU1MjMwXHU1REYyXHU4OEM1XCJcclxuICAgICAgICAgKFx1NEUzQlx1OEZEQlx1N0EwQiBlbnYgXHU1MzczXHU2NUY2XHU4QkZCKVx1OEJBOVx1NTQxMVx1NUJGQ1x1NTFGQVx1NzNCMFx1NEUwOVx1OTAwOVx1OTg3OVx1OERFRlx1NUY4NCxcdTdGMjlcdTUyMzAgMzYwXHUwMEQ3NjQwIFx1NTQwRVx1OTAxMFx1NEUyQVxyXG4gICAgICAgICBlbGVtZW50RnJvbVBvaW50IFx1NjVBRFx1OEEwMChcdTRFMERcdTY2MkZcdTg4QUJcdTg4QzFcdTUyMDcpO1x1NTE4RFx1OUE4Q1x1OEJDMVx1NTM1NVx1NTFGQlx1NTI0RFx1OEZEQlx1NEUwRVx1NTNENlx1NkQ4OFx1MzAwMiAqL1xyXG4gICAgICBhd2FpdCBzdGVwKCdcdTU0MTFcdTVCRkM6XHU3QTg0XHU1QzRGIDM2MFx1MDBENzY0MFx1MjAxNFx1MjAxNFx1NEUwOVx1OTAwOVx1OTg3OShcdTU0MkIgbm90ZSBcdTY1NzRcdTY4MEYpXHU0RTBFXHU2MzA5XHU5NEFFXHU1MTY4XHU5MEU4XHU1M0VGXHU1NDdEXHU0RTJEK1x1NTM1NVx1NTFGQlx1NTM3M1x1NTI0RFx1OEZEQicsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9GQUtFX0RFVEVDVF9GT1VORCA9ICcxJztcclxuICAgICAgICBjb25zdCBzaXplMCA9IHdpbi5nZXRTaXplKCk7XHJcbiAgICAgICAgY29uc3QgdzAgPSBzaXplMFswXSA/PyAxMjgwO1xyXG4gICAgICAgIGNvbnN0IGgwID0gc2l6ZTBbMV0gPz8gODAwO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidwJywgY3RybEtleTp0cnVlLCBzaGlmdEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgICAgIGNvbnN0IG9wZW4gPSBhd2FpdCB3YWl0Rm9yKCdzZXR0aW5ncyBvcGVuJywgYHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrLnNldHRpbmdzJyk7IHJldHVybiB7b2s6ICEhcywgZGV0YWlsOiBzID8gJ29wZW4nIDogJ2Nsb3NlZCd9O2AsIDVfMDAwKTtcclxuICAgICAgICAgIGlmICghb3BlblswXSkgcmV0dXJuIG9wZW47XHJcbiAgICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNtZGsuc2V0dGluZ3MgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU5MUNEXHU2NUIwXHU5MTREXHU3RjZFJyk+PTA7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgICAgY29uc3Qgc2hvd24gPSBhd2FpdCB3YWl0Rm9yKCd3aXphcmQgcmVvcGVuZWQnLCBgcmV0dXJuIHtvazogISFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKSwgZGV0YWlsOiBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKSA/ICdvcGVuJyA6ICdjbG9zZWQnfTtgLCA1XzAwMCk7XHJcbiAgICAgICAgICBpZiAoIXNob3duWzBdKSByZXR1cm4gc2hvd247XHJcbiAgICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTVGMDBcdTU5Q0JcdTkxNERcdTdGNkUnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICAgIGNvbnN0IGRldGVjdFBhZ2UgPSBhd2FpdCB3YWl0Rm9yKCdkZXRlY3QgZm91bmQgcGFnZSgzIG9wdGlvbnMpJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1kZXRlY3QnKTtcclxuICAgICAgICAgICAgdmFyIG9wdHM9cD9wLnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3B0JykubGVuZ3RoOjA7XHJcbiAgICAgICAgICAgIHJldHVybiB7b2s6ICEhcCAmJiBvcHRzPT09MywgZGV0YWlsOiAnb3B0cz0nK29wdHN9O2AsIDEyXzAwMCk7XHJcbiAgICAgICAgICBpZiAoIWRldGVjdFBhZ2VbMF0pIHJldHVybiBkZXRlY3RQYWdlO1xyXG4gICAgICAgICAgLy8gXHU1MzU1XHU1MUZCXHU5MDA5XHU5ODc5XHU1MzczXHU1MjREXHU4RkRCOlx1NzBCOVwiXHU0RUNEXHU4OTgxXHU0RTBCXHU4RjdEXHU2NUIwXHU3MjQ4XCJcdTVFOTRcdTc2RjRcdTYzQTVcdTg0M0RcdTUyMzBcdTkwMDlcdTYyRTlcdTk4NzUoXHU2NUUwXHU5NzAwXHU1MThEXHU3MEI5XCJcdTRFMEJcdTRFMDBcdTZCNjVcIilcclxuICAgICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIG89W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW9wdCcpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1NEVDRFx1ODk4MVx1NEUwQlx1OEY3RFx1NjVCMFx1NzI0OCcpPj0wO30pOyBpZihvKSBvLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICAgIGNvbnN0IHNlbGVjdFBhZ2UgPSBhd2FpdCB3YWl0Rm9yKCdzZWxlY3QgcGFnZSB2aWEgc2luZ2xlIGNsaWNrJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1zZWxlY3QnKTtcclxuICAgICAgICAgICAgcmV0dXJuIHtvazogISFwICYmIHAucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vcHQnKS5sZW5ndGg9PT0zLCBkZXRhaWw6IHAgPyAnc2VsZWN0JyA6ICdub3Qgc2VsZWN0J307YCwgNl8wMDApO1xyXG4gICAgICAgICAgaWYgKCFzZWxlY3RQYWdlWzBdKSByZXR1cm4gW2ZhbHNlLCBgXHU1MzU1XHU1MUZCXHU5MDA5XHU5ODc5XHU2NzJBXHU1MjREXHU4RkRCXHU1MjMwXHU5MDA5XHU2MkU5XHU5ODc1OiAke3NlbGVjdFBhZ2VbMV19YF07XHJcbiAgICAgICAgICAvLyBcdTdGMjlcdTUyMzAgMzYwXHUwMEQ3NjQwKG1pbldpZHRoIFx1NURGMlx1NTcyOCBVSVZFUklGWSBcdTRFMEJcdTY1M0VcdTVCQkQpLFx1NjVBRFx1OEEwMFx1NTE2OFx1OTBFOFx1NTNFRlx1NTQ3RFx1NEUyRFxyXG4gICAgICAgICAgd2luLnNldFNpemUoMzYwLCA2NDApO1xyXG4gICAgICAgICAgYXdhaXQgc2xlZXAoNTAwKTtcclxuICAgICAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoYChmdW5jdGlvbigpe1xyXG4gICAgICAgICAgICBmdW5jdGlvbiBoaXQoZWwpeyBlbC5zY3JvbGxJbnRvVmlldyh7YmxvY2s6J25lYXJlc3QnfSk7IHZhciByPWVsLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xyXG4gICAgICAgICAgICAgIHZhciB4PXIubGVmdCtyLndpZHRoLzIsIHk9ci50b3Arci5oZWlnaHQvMjtcclxuICAgICAgICAgICAgICB2YXIgZT1kb2N1bWVudC5lbGVtZW50RnJvbVBvaW50KHgseSk7XHJcbiAgICAgICAgICAgICAgcmV0dXJuICEhKGUgJiYgKGU9PT1lbCB8fCBlbC5jb250YWlucyhlKSkpOyB9XHJcbiAgICAgICAgICAgIHZhciBjYXJkPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1zZWxlY3QnKTtcclxuICAgICAgICAgICAgdmFyIG9wdHM9W10uc2xpY2UuY2FsbChjYXJkLnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3B0JykpO1xyXG4gICAgICAgICAgICB2YXIgb3B0SGl0PW9wdHMubWFwKGhpdCk7XHJcbiAgICAgICAgICAgIHZhciBub3Rlcz1bXS5zbGljZS5jYWxsKGNhcmQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vcHQtbm90ZScpKTtcclxuICAgICAgICAgICAgdmFyIG5vdGVIaXQ9bm90ZXMubWFwKGZ1bmN0aW9uKG4peyBuLnNjcm9sbEludG9WaWV3KHtibG9jazonbmVhcmVzdCd9KTsgdmFyIHI9bi5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcclxuICAgICAgICAgICAgICB2YXIgZT1kb2N1bWVudC5lbGVtZW50RnJvbVBvaW50KHIubGVmdCtyLndpZHRoLzIsIHIudG9wK01hdGgubWluKHIuaGVpZ2h0LzIsIDgpKTtcclxuICAgICAgICAgICAgICByZXR1cm4gISEoZSAmJiBvcHRzLnNvbWUoZnVuY3Rpb24obyl7IHJldHVybiBlPT09byB8fCBvLmNvbnRhaW5zKGUpOyB9KSk7IH0pO1xyXG4gICAgICAgICAgICB2YXIgYWN0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1zZWxlY3QgLndpemFyZC1hY3Rpb25zIC5idG4ucHJpbWFyeScpO1xyXG4gICAgICAgICAgICB2YXIgZm9vdGVyPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1mb290ZXIgYnV0dG9uJykpO1xyXG4gICAgICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe3Z3OiB3aW5kb3cuaW5uZXJXaWR0aCwgdmg6IHdpbmRvdy5pbm5lckhlaWdodCwgb3B0czogb3B0cy5sZW5ndGgsXHJcbiAgICAgICAgICAgICAgb3B0SGl0OiBvcHRIaXQsIG5vdGVIaXQ6IG5vdGVIaXQsIGFjdEhpdDogYWN0ID8gaGl0KGFjdCkgOiBmYWxzZSwgZnRIaXQ6IGZvb3Rlci5tYXAoaGl0KX0pO1xyXG4gICAgICAgICAgfSkoKWApKSBhcyBzdHJpbmc7XHJcbiAgICAgICAgICBjb25zdCBxID0gSlNPTi5wYXJzZShyKSBhcyB7IHZ3OiBudW1iZXI7IHZoOiBudW1iZXI7IG9wdHM6IG51bWJlcjsgb3B0SGl0OiBib29sZWFuW107IG5vdGVIaXQ6IGJvb2xlYW5bXTsgYWN0SGl0OiBib29sZWFuOyBmdEhpdDogYm9vbGVhbltdIH07XHJcbiAgICAgICAgICBhd2FpdCBzaG90KCd3aXphcmQtbmFycm93LTM2MC1zZWxlY3QnKTtcclxuICAgICAgICAgIGNvbnN0IG5hcnJvd09rID0gcS5vcHRzID09PSAzICYmIHEudncgPD0gMzgwICYmIHEub3B0SGl0LmV2ZXJ5KEJvb2xlYW4pICYmIHEubm90ZUhpdC5ldmVyeShCb29sZWFuKSAmJiBxLmFjdEhpdCAmJiBxLmZ0SGl0LmV2ZXJ5KEJvb2xlYW4pO1xyXG4gICAgICAgICAgLy8gXHU3QTg0XHU1QzRGXHU0RTBCXHU1MzU1XHU1MUZCXHU5MDA5XHU5ODc5XHUyNDYwID0gXHU5MDA5XHU0RTJEXHU1RTc2XHU1MjREXHU4RkRCXHU1MjMwXHU1Qjg5XHU4OEM1XHU5ODc1KHZlcmlmeSBcdTZBMjFcdTYyREZcdThGREJcdTVFQTYsXHU0RTBEXHU4NDNEXHU3NkQ4KVxyXG4gICAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgbz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3B0JykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU0RTBCXHU4RjdEXHU1Qjg5XHU4OEM1XHU1QjhDXHU2NTc0IGhtaCBDTEknKT49MDt9KTsgaWYobykgby5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgICBjb25zdCBhZHYgPSBhd2FpdCB3YWl0Rm9yKCdpbnN0YWxsIHBhZ2UgdmlhIHNpbmdsZSBjbGljaycsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtaW5zdGFsbCcpO1xyXG4gICAgICAgICAgICByZXR1cm4ge29rOiAhIXAsIGRldGFpbDogcCA/ICdpbnN0YWxsaW5nJyA6ICdub3Qgc2hvd24nfTtgLCA2XzAwMCk7XHJcbiAgICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTUzRDZcdTZEODgnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICAgIGNvbnN0IGNsb3NlZE5hcnJvdyA9IGF3YWl0IHdhaXRGb3IoJ3dpemFyZCBjbG9zZWQgYXQgMzYwcHgnLCBgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3ZlcmxheScpLCBkZXRhaWw6ICdjbG9zZWQnfTtgLCA1XzAwMCk7XHJcbiAgICAgICAgICByZXR1cm4gW25hcnJvd09rICYmIGFkdlswXSAmJiBjbG9zZWROYXJyb3dbMF0sXHJcbiAgICAgICAgICAgIGB2cD0ke3Eudnd9eCR7cS52aH0gb3B0cz0ke3Eub3B0c30gb3B0SGl0PVske3Eub3B0SGl0LmpvaW4oJywnKX1dIG5vdGVIaXQ9WyR7cS5ub3RlSGl0LmpvaW4oJywnKX1dIFx1NEUzQlx1NjMwOVx1OTRBRT0ke3EuYWN0SGl0fSBmb290ZXI9WyR7cS5mdEhpdC5qb2luKCcsJyl9XTsgXHU1MzU1XHU1MUZCXHU1MjREXHU4RkRCOiAke2FkdlsxXX07IFx1N0E4NFx1NUM0Rlx1NTNENlx1NkQ4ODogJHtjbG9zZWROYXJyb3dbMV19YF07XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgIHdpbi5zZXRTaXplKHcwLCBoMCk7XHJcbiAgICAgICAgICBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9GQUtFX0RFVEVDVF9GT1VORCA9IHVuZGVmaW5lZDtcclxuICAgICAgICB9XHJcbiAgICAgIH0pO1xyXG4gICAgfVxyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpISUcgXHU5NjM2XHU2QkI1MiBcdTIwMTRcdTIwMTQgXHU3QTg0XHU3QTk3XHU2MkJEXHU1QzQ5ICsgXHU2ODA3XHU5ODk4XHU2ODBGIDQ0cHgvZHJhZyBcdTUzM0EgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU3QTg0XHU3QTk3XHU2MkJEXHU1QzQ5Ojc2MHB4IFx1NEZBN1x1NjgwRlx1NTNFRlx1OEZCRVx1NTNFRlx1NTE3MyhcdTkwNkVcdTdGNjlcdTcwQjlcdTUxRkIgKyBFc2MpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICB0cnkgeyB3aW4uc2V0TWluaW11bVNpemUoNTYwLCA2MDApOyB3aW4uc2V0Qm91bmRzKHsgd2lkdGg6IDc2MCwgaGVpZ2h0OiA3MDAgfSk7IH0gY2F0Y2ggeyAvKiBiZXN0IGVmZm9ydCAqLyB9XHJcbiAgICAgIGNvbnN0IGlzTmFycm93ID0gYXdhaXQgd2FpdEZvcignbWF0Y2hNZWRpYSA4MjAnLCBgcmV0dXJuIHtvazogd2luZG93Lm1hdGNoTWVkaWEoJyhtYXgtd2lkdGg6IDgyMHB4KScpLm1hdGNoZXMsIGRldGFpbDogJ2l3PScgKyB3aW5kb3cuaW5uZXJXaWR0aH07YCwgNV8wMDApO1xyXG4gICAgICBpZiAoIWlzTmFycm93WzBdKSByZXR1cm4gaXNOYXJyb3c7XHJcbiAgICAgIC8vIFx1N0I0OSBSZWFjdCBcdTYzMDlcdTdBODRcdTdBOTdcdTkxQ0RcdTZFMzJcdTY3RDNcdTUxRkFcdTYyQkRcdTVDNDlcdTYzMDlcdTk0QUUoYXJpYS1sYWJlbCBcdTYzNjJcdTYyMTBcIlx1NjJCRFx1NUM0OVwiXHU2NTg3XHU2ODQ4KVx1NTE4RFx1NzBCOVx1MjAxNFx1MjAxNENTUyBcdTY1QURcdTcwQjlcdTUzNzNcdTY1RjYsXHJcbiAgICAgIC8vIFJlYWN0IHN0YXRlIFx1NjcwOVx1NkJFQlx1NzlEMlx1N0VBN1x1NUVGNlx1OEZERixcdTc2RjJcdTcwQjlcdTRGMUFcdTg0M0RcdTU3MjhcdTY1RTdcdTc2ODRcIlx1NjUzNlx1OEQ3N1x1NEZBN1x1NjgwRlwiXHU0RTBBXHJcbiAgICAgIGNvbnN0IGJ0biA9IGF3YWl0IHdhaXRGb3IoJ2RyYXdlciBidXR0b24nLCBgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudG9wYmFyIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiAoeC5nZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnKXx8JycpLmluZGV4T2YoJ1x1NjJCRFx1NUM0OScpPj0wO30pO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYiwgZGV0YWlsOiAnYnRuPScrKGI/Yi5nZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnKTonbm9uZScpfTtgLCA1XzAwMCk7XHJcbiAgICAgIGlmICghYnRuWzBdKSByZXR1cm4gYnRuO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnRvcGJhciBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4gKHguZ2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJyl8fCcnKS5pbmRleE9mKCdcdTYyQkRcdTVDNDknKT49MDt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IG9wZW5lZCA9IGF3YWl0IHdhaXRGb3IoJ2RyYXdlciBvcGVuJywgYHZhciBzYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhcicpLCBzYz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhci1zY3JpbScpO1xyXG4gICAgICAgIHZhciByPXNiP3NiLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOm51bGw7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFyICYmIHIueCA+PSAwICYmIHIueCA8IDQwICYmICEhc2MsIGRldGFpbDogJ3g9Jysocj9NYXRoLnJvdW5kKHIueCk6J25vbmUnKSsnIHNjcmltPScrKHNjPyd5ZXMnOidubycpfTtgLCA1XzAwMCk7XHJcbiAgICAgIGF3YWl0IHNob3QoJ2RyYXdlci1vcGVuJyk7XHJcbiAgICAgIC8vIFx1OTA2RVx1N0Y2OVx1NzBCOVx1NTFGQlx1NTE3M1x1OTVFRCBcdTIxOTIgXHU0RkE3XHU2ODBGXHU2RUQxXHU1MUZBKHggPCAwKSsgXHU5MDZFXHU3RjY5XHU2RDg4XHU1OTMxXHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHNjPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyLXNjcmltJyk7IGlmKHNjKSBzYy5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IGNsb3NlZCA9IGF3YWl0IHdhaXRGb3IoJ2RyYXdlciBjbG9zZWQgYnkgc2NyaW0nLCBgdmFyIHNiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyJyksIHNjPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyLXNjcmltJyk7XHJcbiAgICAgICAgdmFyIHI9c2I/c2IuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk6bnVsbDtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXIgJiYgci54IDwgMCAmJiAhc2MsIGRldGFpbDogJ3g9Jysocj9NYXRoLnJvdW5kKHIueCk6J25vbmUnKSsnIHNjcmltPScrKHNjPyd5ZXMnOidubycpfTtgLCA1XzAwMCk7XHJcbiAgICAgIC8vIEVzYyBcdTRFNUZcdTgwRkRcdTVGMDAvXHU1MTczXHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudG9wYmFyIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiAoeC5nZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnKXx8JycpLmluZGV4T2YoJ1x1NjJCRFx1NUM0OScpPj0wO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgYXdhaXQgd2FpdEZvcignZHJhd2VyIHJlb3BlbicsIGB2YXIgc2I9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXInKTsgdmFyIHI9c2I/c2IuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk6bnVsbDtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXIgJiYgci54ID49IDAgJiYgci54IDwgNDAsIGRldGFpbDogJ3g9Jysocj9NYXRoLnJvdW5kKHIueCk6J25vbmUnKX07YCwgNV8wMDApO1xyXG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidFc2NhcGUnLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgY29uc3QgZXNjQ2xvc2VkID0gYXdhaXQgd2FpdEZvcignZHJhd2VyIGNsb3NlZCBieSBFc2MnLCBgdmFyIHNiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyJyk7IHZhciByPXNiP3NiLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOm51bGw7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFyICYmIHIueCA8IDAsIGRldGFpbDogJ3g9Jysocj9NYXRoLnJvdW5kKHIueCk6J25vbmUnKX07YCwgNV8wMDApO1xyXG4gICAgICAvLyBcdTYwNjJcdTU5MERcdTVCQkRcdTdBOTc6XHU0RkE3XHU2ODBGXHU1NkRFXHU1MjMwIGdyaWQgXHU1MjE3KGRpc3BsYXkgXHU5NzVFIG5vbmUsXHU2QjYzXHU1RTM4XHU1MjE3XHU1RTAzXHU1QzQwKVxyXG4gICAgICB0cnkgeyB3aW4uc2V0Qm91bmRzKHsgd2lkdGg6IDEyODAsIGhlaWdodDogODAwIH0pOyB9IGNhdGNoIHsgLyogYmVzdCBlZmZvcnQgKi8gfVxyXG4gICAgICBhd2FpdCBzbGVlcCg0MDApO1xyXG4gICAgICBjb25zdCB3aWRlID0gYXdhaXQgd2FpdEZvcignd2lkZSByZXN0b3JlZCcsIGB2YXIgc2I9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXInKTsgdmFyIHI9c2I/c2IuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk6bnVsbDtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXIgJiYgci53aWR0aCA+IDIwMCAmJiBnZXRDb21wdXRlZFN0eWxlKHNiKS5kaXNwbGF5ICE9PSAnbm9uZScsIGRldGFpbDogJ3c9Jysocj9NYXRoLnJvdW5kKHIud2lkdGgpOidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgICAgcmV0dXJuIFtvcGVuZWRbMF0gJiYgY2xvc2VkWzBdICYmIGVzY0Nsb3NlZFswXSAmJiB3aWRlWzBdLCBgb3BlbjogJHtvcGVuZWRbMV19OyBzY3JpbS1jbG9zZTogJHtjbG9zZWRbMV19OyBlc2MtY2xvc2U6ICR7ZXNjQ2xvc2VkWzFdfTsgd2lkZTogJHt3aWRlWzFdfWBdO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdcdTY4MDdcdTk4OThcdTY4MEY6NDRweCArIGRyYWcgXHU1MzNBKFx1ODNEQ1x1NTM1NSBuby1kcmFnO292ZXJsYXkgXHU5QUQ4XHU1RUE2XHU0RTAwXHU4MUY0KScsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgciA9IChhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XHJcbiAgICAgICAgdmFyIHRiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy50aXRsZWJhcicpLCBtYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudGl0bGViYXItbWVudScpO1xyXG4gICAgICAgIGlmKCF0YiB8fCAhbWIpIHJldHVybiBKU09OLnN0cmluZ2lmeSh7b2s6ZmFsc2UsIGRldGFpbDonbWlzc2luZyB0aXRsZWJhci9tZW51J30pO1xyXG4gICAgICAgIHZhciBjcz1nZXRDb21wdXRlZFN0eWxlKHRiKSwgbXM9Z2V0Q29tcHV0ZWRTdHlsZShtYik7XHJcbiAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHsgb2s6IGNzLmhlaWdodCA9PT0gJzQ0cHgnICYmIGNzLndlYmtpdEFwcFJlZ2lvbiA9PT0gJ2RyYWcnICYmIG1zLndlYmtpdEFwcFJlZ2lvbiA9PT0gJ25vLWRyYWcnICYmIG1iLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpLmhlaWdodCA+PSAzNixcclxuICAgICAgICAgIGRldGFpbDogJ2g9Jytjcy5oZWlnaHQrJyByZWdpb249Jytjcy53ZWJraXRBcHBSZWdpb24rJyBtZW51LXJlZ2lvbj0nK21zLndlYmtpdEFwcFJlZ2lvbisnIG1lbnUtaD0nK01hdGgucm91bmQobWIuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCkuaGVpZ2h0KSB9KTtcclxuICAgICAgfSkoKWApKSBhcyBzdHJpbmc7XHJcbiAgICAgIGNvbnN0IHAgPSBKU09OLnBhcnNlKHIpIGFzIHsgb2s6IGJvb2xlYW47IGRldGFpbDogc3RyaW5nIH07XHJcbiAgICAgIC8vIFx1NEUzQlx1OEZEQlx1N0EwQlx1NEZBNzpcdTUzOUZcdTc1MUYgdGl0bGVCYXJPdmVybGF5IFx1OUFEOFx1NUVBNlx1OTg3Qlx1NTQwQ1x1NEUzQSA0NChXaW5kb3dzIFx1NjI0RFx1NjcwOSBvdmVybGF5O1x1NjVFN1x1N0M3Qlx1NTc4Qlx1N0YzQVx1NkI2NCBBUEksXHU1M0VGXHU5MDA5XHU4QzAzXHU3NTI4KVxyXG4gICAgICBsZXQgb3ZlcmxheSA9ICduL2EnO1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHByb2JlID0gd2luIGFzIHVua25vd24gYXMgeyBnZXRUaXRsZUJhck92ZXJsYXk/OiAoKSA9PiB7IGhlaWdodD86IG51bWJlciB9IHwgbnVsbCB9O1xyXG4gICAgICAgIGNvbnN0IG8gPSBwcm9iZS5nZXRUaXRsZUJhck92ZXJsYXk/LigpID8/IG51bGw7XHJcbiAgICAgICAgb3ZlcmxheSA9IG8gIT09IG51bGwgPyBTdHJpbmcoby5oZWlnaHQpIDogJ24vYSc7XHJcbiAgICAgIH0gY2F0Y2ggeyAvKiBcdTVFNzNcdTUzRjBcdTY1RTAgb3ZlcmxheSAqLyB9XHJcbiAgICAgIHJldHVybiBbcC5vayA9PT0gdHJ1ZSwgYCR7cC5kZXRhaWx9IG92ZXJsYXktaD0ke292ZXJsYXl9YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU2NkY0XHU2NUIwXHU2QTJBXHU1RTQ1KG1vY2sgdXBkYXRlOnN0YXRlIFx1NEUwOVx1NjAwMTtcdTRFRkJcdTUyQTEgMTMtQykgPT09PT09PT09PVxyXG4gICAgICAgXHU0RTNCXHU4RkRCXHU3QTBCXHU3NkY0XHU1M0QxIG1vY2sgXHU3MkI2XHU2MDAxOlx1NjhDMFx1NjdFNVx1NEUyRFx1OTc1OVx1OUVEOCBcdTIxOTIgXHU0RTBCXHU4RjdEXHU0RTJEKFx1OEZEQlx1NUVBNi9cdTkwMUZcdTVFQTYvXHU4RkRCXHU1RUE2XHU2NzYxKVx1MjE5MiBcdTVDMzFcdTdFRUFcclxuICAgICAgIChcIlx1OTFDRFx1NTQyRlx1NjZGNFx1NjVCMFwiXHU1M0VGXHU3MEI5XHUzMDAxXHU2NUUwXHU1OTE2XHU5NEZFXHUzMDAxYXBwbHkgXHU0RTBEXHU1RDI5KVx1MjE5MiBcdTU5MzFcdThEMjUoXHU5MUNEXHU4QkQ1XHU2RDQxXHU4RjZDICsgXHU3QTBEXHU1NDBFXHU1MTczXHU5NUVEKVx1MzAwMiAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU2NkY0XHU2NUIwXHU2QTJBXHU1RTQ1Olx1NjhDMFx1NjdFNVx1NEUyRFx1OTc1OVx1OUVEOFx1NjVFMFx1NkEyQVx1NUU0NSBcdTIxOTIgXHU0RTBCXHU4RjdEXHU0RTJEXHU4RkRCXHU1RUE2XHU1M0VGXHU4OUMxKFx1NUI1N1x1ODI4Mi9cdTkwMUZcdTVFQTYvXHU4RkRCXHU1RUE2XHU2NzYxKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3Qgc3RCYXNlID0geyBjaGVja2luZzogZmFsc2UsIGN1cnJlbnRWZXJzaW9uOiAnMC4yLjknLCBsYXRlc3Q6IG51bGwsIG5vdGVzOiAnJywgZG93bmxvYWRlZDogZmFsc2UsIGVycm9yOiAnJywgY2hhbm5lbDogJycsIHByb2dyZXNzOiBudWxsIH07XHJcbiAgICAgIC8vIGNoZWNraW5nIFx1NjAwMTpcdTk3NTlcdTlFRDhcdTY4QzBcdTY3RTUsXHU0RTBEXHU2MjUzXHU2MjcwXHU0RUZCXHU1MkExXHU1MzNBXHJcbiAgICAgIHdpbi53ZWJDb250ZW50cy5zZW5kKCd1cGRhdGU6c3RhdGUnLCB7IC4uLnN0QmFzZSwgY2hlY2tpbmc6IHRydWUgfSk7XHJcbiAgICAgIGF3YWl0IHNsZWVwKDQwMCk7XHJcbiAgICAgIGNvbnN0IHNpbGVudCA9IChhd2FpdCBqcyhgIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy51cGRhdGUtYmFubmVyJylgKSkgYXMgYm9vbGVhbjtcclxuICAgICAgLy8gXHU0RTBCXHU4RjdEXHU0RTJEOlx1NzI0OFx1NjcyQ1x1NTNGNyArIFx1NURGMlx1NEUwQlx1OEY3RC9cdTYwM0JcdTVCNTdcdTgyODIgKyBcdTkwMUZcdTVFQTYgKyBcdThGREJcdTVFQTZcdTY3NjFcdTVCQkRcdTVFQTZcclxuICAgICAgd2luLndlYkNvbnRlbnRzLnNlbmQoJ3VwZGF0ZTpzdGF0ZScsIHsgLi4uc3RCYXNlLCBsYXRlc3Q6ICd2MC4zLjAnLCBjaGFubmVsOiAnYXRvbWdpdChcdTU2RkRcdTUxODUpJywgcHJvZ3Jlc3M6IHsgcmVjZWl2ZWQ6IDQ3XzAwMF8wMDAsIHRvdGFsOiAxMTJfMTQ3XzE5OSwgc3BlZWRCcHM6IDJfMTAwXzAwMCB9IH0pO1xyXG4gICAgICBjb25zdCBkbCA9IGF3YWl0IHdhaXRGb3IoJ2Rvd25sb2FkaW5nIGJhbm5lcicsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudXBkYXRlLWJhbm5lcicpO1xyXG4gICAgICAgIGlmKCFiKSByZXR1cm4ge29rOmZhbHNlLCBkZXRhaWw6J25vIGJhbm5lcid9O1xyXG4gICAgICAgIHZhciB0PWIudGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKTtcclxuICAgICAgICB2YXIgYmFyPWIucXVlcnlTZWxlY3RvcignLnVwZGF0ZS1iYXItZmlsbCcpO1xyXG4gICAgICAgIHZhciB3PWJhcj9wYXJzZUZsb2F0KGJhci5zdHlsZS53aWR0aCk6MDtcclxuICAgICAgICByZXR1cm4ge29rOiB0LmluZGV4T2YoJ3YwLjMuMCcpPj0wICYmIHQuaW5kZXhPZignLycpPj0wICYmIHQuaW5kZXhPZignL3MnKT49MCAmJiB3PjMwICYmIHc8PTEwMCwgZGV0YWlsOiAndGV4dD0nK3Quc2xpY2UoMCw3MCkrJyBiYXJXPScrd307YCwgNV8wMDApO1xyXG4gICAgICBhd2FpdCBzaG90KCd1cGRhdGUtZG93bmxvYWRpbmcnKTtcclxuICAgICAgcmV0dXJuIFtzaWxlbnQgJiYgZGxbMF0sIGBjaGVja2luZyBcdTk3NTlcdTlFRDg9JHtzaWxlbnR9OyAke2RsWzFdfWBdO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdcdTY2RjRcdTY1QjBcdTZBMkFcdTVFNDU6XHU1QzMxXHU3RUVBXHU2MDAxXCJcdTkxQ0RcdTU0MkZcdTY2RjRcdTY1QjBcIlx1NTNFRlx1NzBCOVx1MzAwMVx1NjVFMFx1NTkxNlx1OTRGRVx1NUYxNVx1NUJGQyxhcHBseSBcdTg5RTZcdTUzRDEgcHJlbG9hZCBcdTRFMTRcdThGREJcdTdBMEJcdTVCNThcdTZEM0InLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIHdpbi53ZWJDb250ZW50cy5zZW5kKCd1cGRhdGU6c3RhdGUnLCB7IGNoZWNraW5nOiBmYWxzZSwgY3VycmVudFZlcnNpb246ICcwLjIuOScsIGxhdGVzdDogJ3YwLjMuMCcsIG5vdGVzOiAnJywgZG93bmxvYWRlZDogdHJ1ZSwgZXJyb3I6ICcnLCBjaGFubmVsOiAnYXRvbWdpdChcdTU2RkRcdTUxODUpJywgcHJvZ3Jlc3M6IG51bGwgfSk7XHJcbiAgICAgIGNvbnN0IHJlYWR5ID0gYXdhaXQgd2FpdEZvcigncmVhZHkgYmFubmVyJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy51cGRhdGUtYmFubmVyJyk7XHJcbiAgICAgICAgdmFyIGJ0bj1iP2IucXVlcnlTZWxlY3RvcignLnVwZGF0ZS1yZXN0YXJ0Jyk6bnVsbDtcclxuICAgICAgICB2YXIgbGlua3M9Yj9iLnF1ZXJ5U2VsZWN0b3JBbGwoJ2EnKS5sZW5ndGg6LTE7XHJcbiAgICAgICAgdmFyIG5vRXh0PWI/KGIudGV4dENvbnRlbnQuaW5kZXhPZignXHU0RTBCXHU4RjdEXHU5ODc1Jyk8MCAmJiBiLnRleHRDb250ZW50LmluZGV4T2YoJ2h0dHAnKTwwKTpmYWxzZTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWIgJiYgISFidG4gJiYgYnRuLmRpc2FibGVkPT09ZmFsc2UgJiYgbGlua3M9PT0wICYmIG5vRXh0LCBkZXRhaWw6ICdidG49JysoYnRuP2J0bi50ZXh0Q29udGVudDonbm9uZScpKycgbGlua3M9JytsaW5rcysnIG5vRXh0PScrbm9FeHR9O2AsIDVfMDAwKTtcclxuICAgICAgYXdhaXQgc2hvdCgndXBkYXRlLXJlYWR5Jyk7XHJcbiAgICAgIGlmICghcmVhZHlbMF0pIHJldHVybiByZWFkeTtcclxuICAgICAgLy8gcHJlbG9hZCBcdTY4NjVcdTU3MjggKyBcdTcwQjlcdTUxRkJcdTU0MEVcdThGREJcdTdBMEJcdTVCNThcdTZEM0IobW9jayBcdTY1RTBcdTVCODlcdTg4QzVcdTUzMDUgXHUyMTkyIGFwcGx5VXBkYXRlIG5vLW9wIFx1NEUwRFx1OTAwMFx1NTFGQTtcclxuICAgICAgLy8gXHU0RTNCXHU4RkRCXHU3QTBCXHU0RkE3XHU2NzA5IFwiYXBwbHkgcmVxdWVzdGVkXCIgXHU2NUU1XHU1RkQ3XHU4ODRDLFx1NzUzMVx1OUE3MVx1NTJBOFx1NTY2OFx1OEY5M1x1NTFGQVx1NEVCQVx1NUJBMSlcdTMwMDJcclxuICAgICAgY29uc3QgaGFzQnJpZGdlID0gKGF3YWl0IGpzKGB0eXBlb2Ygd2luZG93LmhtaC5hcHBseVVwZGF0ZSA9PT0gJ2Z1bmN0aW9uJyAmJiB0eXBlb2Ygd2luZG93LmhtaC5jaGVja1VwZGF0ZSA9PT0gJ2Z1bmN0aW9uJ2ApKSBhcyBib29sZWFuO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy51cGRhdGUtYmFubmVyIC51cGRhdGUtcmVzdGFydCcpOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgYXdhaXQgc2xlZXAoODAwKTtcclxuICAgICAgY29uc3QgYWxpdmUgPSAoYXdhaXQganMoYCEhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnVwZGF0ZS1iYW5uZXInKSAmJiAhIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jb21wb3NlciB0ZXh0YXJlYScpYCkpIGFzIGJvb2xlYW47XHJcbiAgICAgIHJldHVybiBbaGFzQnJpZGdlICYmIGFsaXZlLCBgcHJlbG9hZCBhcHBseVVwZGF0ZS9jaGVja1VwZGF0ZT0ke2hhc0JyaWRnZX07IFx1NzBCOVx1NTFGQlx1NTQwRVx1NkEyQVx1NUU0NVx1NEUwRSBjb21wb3NlciBcdTVCNThcdTZEM0I9JHthbGl2ZX1gXTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnXHU2NkY0XHU2NUIwXHU2QTJBXHU1RTQ1Olx1NTkzMVx1OEQyNVx1NjAwMVx1OTUxOVx1OEJFRlx1NjYwRVx1N0VDNitcdTkxQ0RcdThCRDVcdTZENDFcdThGNkMsXHU3QTBEXHU1NDBFXHU1M0VGXHU1MTczXHU5NUVEJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICB3aW4ud2ViQ29udGVudHMuc2VuZCgndXBkYXRlOnN0YXRlJywgeyBjaGVja2luZzogZmFsc2UsIGN1cnJlbnRWZXJzaW9uOiAnMC4yLjknLCBsYXRlc3Q6IG51bGwsIG5vdGVzOiAnJywgZG93bmxvYWRlZDogZmFsc2UsIGVycm9yOiAnXHU1MTY4XHU5MEU4XHU2OEMwXHU2N0U1XHU5MDFBXHU5MDUzXHU1OTMxXHU4RDI1KFx1NzZGNFx1OEZERTpcdThEODVcdTY1RjYoOHMpOyBhdG9tZ2l0KFx1NTZGRFx1NTE4NSk6SFRUUCA1MDI7IGdoLXByb3h5Olx1OEQ4NVx1NjVGNigxMHMpKScsIGNoYW5uZWw6ICcnLCBwcm9ncmVzczogbnVsbCB9KTtcclxuICAgICAgY29uc3QgZXJyID0gYXdhaXQgd2FpdEZvcignZXJyb3IgYmFubmVyJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy51cGRhdGUtYmFubmVyJyk7XHJcbiAgICAgICAgdmFyIGJ0bj1iP2IucXVlcnlTZWxlY3RvcignLnVwZGF0ZS1yZXRyeScpOm51bGw7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFiICYmIGIudGV4dENvbnRlbnQuaW5kZXhPZignXHU2NkY0XHU2NUIwXHU2OEMwXHU2N0U1XHU1OTMxXHU4RDI1Jyk+PTAgJiYgYi50ZXh0Q29udGVudC5pbmRleE9mKCdhdG9tZ2l0Jyk+PTAgJiYgISFidG4gJiYgYnRuLmRpc2FibGVkPT09ZmFsc2UsIGRldGFpbDogYiA/IGIudGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDkwKSA6ICdubyBiYW5uZXInfTtgLCA1XzAwMCk7XHJcbiAgICAgIGF3YWl0IHNob3QoJ3VwZGF0ZS1lcnJvcicpO1xyXG4gICAgICBpZiAoIWVyclswXSkgcmV0dXJuIGVycjtcclxuICAgICAgLy8gXHU3MEI5XHU5MUNEXHU4QkQ1IFx1MjE5MiBcdThGREJcdTUxNjUgY2hlY2tpbmcoXHU2QTJBXHU1RTQ1XHU2MzA5XHU3MkI2XHU2MDAxXHU2NzNBXHU2NTM2XHU4RDc3O1x1NzcxRlx1NUI5RSBjaGVja0ZvclVwZGF0ZXMgXHU1NzI4XHU1NDBFXHU1M0YwXHU4REQxLFx1NEUwRFx1NUY3MVx1NTRDRFx1NjcyQ1x1NkI2NSlcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudXBkYXRlLWJhbm5lciAudXBkYXRlLXJldHJ5Jyk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCB0b0NoZWNraW5nID0gYXdhaXQgd2FpdEZvcignYmFubmVyIGhpZGRlbiBvbiByZXRyeScsIGByZXR1cm4ge29rOiAhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnVwZGF0ZS1iYW5uZXInKSwgZGV0YWlsOiBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudXBkYXRlLWJhbm5lcicpID8gJ3N0aWxsJyA6ICdoaWRkZW4nfTtgLCA1XzAwMCk7XHJcbiAgICAgIC8vIFx1NjA2Mlx1NTkwRFx1NUMzMVx1N0VFQVx1NjAwMVx1OUE4Q1x1OEJDMVwiXHU3QTBEXHU1NDBFXCI6XHU3MEI5XHU1MUZCXHU1NDBFXHU2QTJBXHU1RTQ1XHU1MTczXHU5NUVEKFx1NEYxQVx1OEJERFx1NTE4NVx1OTc1OVx1OUVEOCxcdTRFMEJcdTZCMjFcdTU0MkZcdTUyQThcdTUxOERcdTYzRDBcdTkxOTIpXHJcbiAgICAgIHdpbi53ZWJDb250ZW50cy5zZW5kKCd1cGRhdGU6c3RhdGUnLCB7IGNoZWNraW5nOiBmYWxzZSwgY3VycmVudFZlcnNpb246ICcwLjIuOScsIGxhdGVzdDogJ3YwLjMuMCcsIG5vdGVzOiAnJywgZG93bmxvYWRlZDogdHJ1ZSwgZXJyb3I6ICcnLCBjaGFubmVsOiAnYXRvbWdpdChcdTU2RkRcdTUxODUpJywgcHJvZ3Jlc3M6IG51bGwgfSk7XHJcbiAgICAgIGF3YWl0IHdhaXRGb3IoJ3JlYWR5IGFnYWluJywgYHJldHVybiB7b2s6ICEhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnVwZGF0ZS1iYW5uZXIgLnVwZGF0ZS1yZXN0YXJ0JyksIGRldGFpbDogJ3JlYWR5J307YCwgNV8wMDApO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBicz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy51cGRhdGUtYmFubmVyIGJ1dHRvbicpKTsgdmFyIGI9YnMuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTdBMERcdTU0MEUnKT49MDt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IGRpc21pc3NlZCA9IGF3YWl0IHdhaXRGb3IoJ2Jhbm5lciBkaXNtaXNzZWQnLCBgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy51cGRhdGUtYmFubmVyJyksIGRldGFpbDogZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnVwZGF0ZS1iYW5uZXInKSA/ICdzdGlsbCcgOiAnZGlzbWlzc2VkJ307YCwgNV8wMDApO1xyXG4gICAgICByZXR1cm4gW3RvQ2hlY2tpbmdbMF0gJiYgZGlzbWlzc2VkWzBdLCBgXHU5MUNEXHU4QkQ1XHUyMTkyY2hlY2tpbmcgXHU2NTM2XHU4RDc3PSR7dG9DaGVja2luZ1swXX07IFx1N0EwRFx1NTQwRVx1NTE3M1x1OTVFRD0ke2Rpc21pc3NlZFswXX1gXTtcclxuICAgIH0pO1xyXG5cclxuICAgIGF3YWl0IHNob3QoJ2ZpbmFsJyk7XHJcbiAgfSBlbHNlIGlmICgocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfV0laQVJEID8/ICcnKSAhPT0gJycpIHtcclxuICAgIC8qID09PT09PT09PT0gcmVhbChcdTU0MTFcdTVCRkNcdTY3ODRcdTkwMjAsXHU0RTkyXHU2NUE1XHU0RThFXHU1RTM4XHU4OUM0IHJlYWwgXHU2QjY1XHU5QUE0KTpcclxuICAgICAgIFdaMiBcdTY3MkNcdTY3M0FcdTc3MUZcdTVCOUVcdTY4QzBcdTZENEIoXHU5RUQ4XHU4QkE0XHU1MTcxXHU0RUFCXHU5ODc1KS8gV1ozIFx1NEUwQlx1OEY3RFx1NUI4OVx1ODhDNVx1NUI5RVx1NkQ0QiA9PT09PT09PT09ICovXHJcbiAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfV0laQVJEID09PSAnZGV0ZWN0Jykge1xyXG4gICAgICBhd2FpdCBzdGVwKCdcdTU0MTFcdTVCRkMoXHU3NzFGXHU1QjlFKTpcdTZCMjJcdThGQ0VcdTIxOTJcdTY4QzBcdTZENEJcdTUyMzBcdTY3MkNcdTY3M0FcdTVERjJcdTg4QzUgQ0xJKFx1OUVEOFx1OEJBNFx1NTE3MVx1NEVBQixcdTUyRkVcdTkwMDlcdTZCNjNcdTc4NkUpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCd3aXphcmQgb3ZlcmxheScsIGB2YXIgbz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKTtcclxuICAgICAgICAgIHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTVGMDBcdTU5Q0JcdTkxNERcdTdGNkUnO30pO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogISFvICYmICEhYiwgZGV0YWlsOiBvID8gJ292ZXJsYXkrXHU1RjAwXHU1OUNCXHU5MTREXHU3RjZFJyA6ICdubyBvdmVybGF5J307YCwgMTJfMDAwKTtcclxuICAgICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICAgIGF3YWl0IHNob3QoJ3dpemFyZC1yZWFsLXdlbGNvbWUnKTtcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTVGMDBcdTU5Q0JcdTkxNERcdTdGNkUnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICBjb25zdCBmb3VuZCA9IGF3YWl0IHdhaXRGb3IoJ2RldGVjdCBmb3VuZCcsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtZGV0ZWN0Jyk7XHJcbiAgICAgICAgICBpZighcCkgcmV0dXJuIHtvazpmYWxzZSwgZGV0YWlsOidkZXRlY3QgcGFnZSBub3Qgc2hvd24nfTtcclxuICAgICAgICAgIHZhciB0PXAudGV4dENvbnRlbnQ7XHJcbiAgICAgICAgICB2YXIgb2sxPXQuaW5kZXhPZignXHU2OEMwXHU2RDRCXHU1MjMwXHU1REYyXHU1Qjg5XHU4OEM1IGhtaGFybmVzcyB2Jyk+PTA7XHJcbiAgICAgICAgICB2YXIgb2syPXQuaW5kZXhPZignXHU5RUQ4XHU4QkE0XHU1MTcxXHU0RUFCXHU0RjdGXHU3NTI4XHU1QjgzKFx1NjNBOFx1ODM1MCknKT49MDtcclxuICAgICAgICAgIHZhciByYWRpbz1wLnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3B0Lm9uJyk7XHJcbiAgICAgICAgICByZXR1cm4ge29rOiBvazEmJm9rMiYmISFyYWRpbywgZGV0YWlsOiB0LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw5MCl9O2AsIDIwXzAwMCk7XHJcbiAgICAgICAgYXdhaXQgc2hvdCgnd2l6YXJkLXJlYWwtZGV0ZWN0Jyk7XHJcbiAgICAgICAgcmV0dXJuIGZvdW5kO1xyXG4gICAgICB9KTtcclxuICAgIH0gZWxzZSBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfV0laQVJEID09PSAnaW5zdGFsbCcpIHtcclxuICAgICAgYXdhaXQgc3RlcCgnXHU1NDExXHU1QkZDKFx1NzcxRlx1NUI5RSk6XHU2OEMwXHU2RDRCXHUyMTkyXHU0RUNEXHU4OTgxXHU0RTBCXHU4RjdEXHU2NUIwXHU3MjQ4XHUyMTkyXHU5MDA5XHU2MkU5XHUyNDYwXHUyMTkyXHU4RkRCXHU1MTY1XHU1Qjg5XHU4OEM1XHU5ODc1JywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCd3aXphcmQgb3ZlcmxheScsIGB2YXIgbz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKTtcclxuICAgICAgICAgIHJldHVybiB7b2s6ICEhbywgZGV0YWlsOiBvID8gJ29wZW4nIDogJ2Nsb3NlZCd9O2AsIDEyXzAwMCk7XHJcbiAgICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTVGMDBcdTU5Q0JcdTkxNERcdTdGNkUnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICBjb25zdCBmb3VuZCA9IGF3YWl0IHdhaXRGb3IoJ2RldGVjdCBmb3VuZCcsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtZGV0ZWN0Jyk7XHJcbiAgICAgICAgICByZXR1cm4ge29rOiAhIXAgJiYgcC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTY4QzBcdTZENEJcdTUyMzBcdTVERjJcdTVCODlcdTg4QzUgaG1oYXJuZXNzIHYnKT49MCwgZGV0YWlsOiBwID8gcC50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNjApIDogJ25vIGRldGVjdCBwYWdlJ307YCwgMjBfMDAwKTtcclxuICAgICAgICBpZiAoIWZvdW5kWzBdKSByZXR1cm4gZm91bmQ7XHJcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgbz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3B0JykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU0RUNEXHU4OTgxXHU0RTBCXHU4RjdEXHU2NUIwXHU3MjQ4Jyk+PTA7fSk7IGlmKG8pIG8uY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgIGF3YWl0IHNsZWVwKDIwMCk7XHJcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU0RTBCXHU0RTAwXHU2QjY1Jzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgY29uc3Qgc2VsID0gYXdhaXQgd2FpdEZvcignc2VsZWN0IHBhZ2UgXHUyNDYwIG9uJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1zZWxlY3QnKTtcclxuICAgICAgICAgIHZhciBvbj1wP3AucXVlcnlTZWxlY3RvcignLndpemFyZC1vcHQub24nKTpudWxsO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogISFwICYmICEhb24gJiYgb24udGV4dENvbnRlbnQuaW5kZXhPZignXHU0RTBCXHU4RjdEXHU1Qjg5XHU4OEM1XHU1QjhDXHU2NTc0IGhtaCBDTEknKT49MCwgZGV0YWlsOiBwID8gJ3NlbGVjdCBcdTI0NjAgb24nIDogJ25vIHNlbGVjdCd9O2AsIDhfMDAwKTtcclxuICAgICAgICBpZiAoIXNlbFswXSkgcmV0dXJuIHNlbDtcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTVGMDBcdTU5Q0JcdTVCODlcdTg4QzUnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICByZXR1cm4gd2FpdEZvcignaW5zdGFsbCBwYWdlJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1pbnN0YWxsJyk7XHJcbiAgICAgICAgICByZXR1cm4ge29rOiAhIXAsIGRldGFpbDogcCA/ICdpbnN0YWxsaW5nJyA6ICdub3Qgc2hvd24nfTtgLCA4XzAwMCk7XHJcbiAgICAgIH0pO1xyXG4gICAgICBhd2FpdCBzdGVwKCdcdTU0MTFcdTVCRkMoXHU3NzFGXHU1QjlFKTpcdTVCODlcdTg4QzVcdThGREJcdTVFQTZcdTUzRUZcdTg5QzEoXHU2QjY1XHU5QUE0XHU2NTg3XHU2ODQ4L1x1NEUwQlx1OEY3RFx1NzY3RVx1NTIwNlx1NkJENFx1NkVEQVx1NTJBOCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3Byb2dyZXNzIHZpc2libGUnLCBgdmFyIGJhcj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLXByb2dyZXNzJyk7XHJcbiAgICAgICAgICB2YXIgbG9nPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtaW5zdGFsbC1sb2cnKTtcclxuICAgICAgICAgIHZhciBsaW5lcz1sb2c/bG9nLnRleHRDb250ZW50LnNwbGl0KCdcXFxcbicpLmZpbHRlcihmdW5jdGlvbih4KXtyZXR1cm4geC50cmltKCkhPT0nJzt9KTpbXTtcclxuICAgICAgICAgIHJldHVybiB7b2s6ICEhYmFyICYmIGxpbmVzLmxlbmd0aD49MSwgZGV0YWlsOiAnYmFyPScrKGJhcj8neSc6J24nKSsnIGxpbmVzPScrbGluZXMubGVuZ3RoKyhsaW5lcy5sZW5ndGg+MD8oJyBsYXN0PScrKGxpbmVzW2xpbmVzLmxlbmd0aC0xXXx8JycpLnNsaWNlKDAsNTApKTonJyl9O2AsIDYwXzAwMCk7XHJcbiAgICAgICAgYXdhaXQgc2hvdCgnd2l6YXJkLXJlYWwtaW5zdGFsbCcpO1xyXG4gICAgICAgIHJldHVybiB3O1xyXG4gICAgICB9KTtcclxuICAgICAgYXdhaXQgc3RlcCgnXHU1NDExXHU1QkZDKFx1NzcxRlx1NUI5RSk6XHU1Qjg5XHU4OEM1XHU1QjhDXHU2MjEwXHUyMTkyXHU5MTREXHU3RjZFXHU4REYzXHU4RkM3KFx1NURGMlx1NjcwOVx1NUJDNlx1OTRBNSlcdTIxOTJcdTVCOENcdTYyMTBcdTk4NzVcdTIxOTJcdTVGMDBcdTU5Q0JcdTRGN0ZcdTc1MjhcdTIxOTJcdTY1QjAgcnVudGltZSBcdThGREVcdTYzQTUnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgLy8gXHU1Qjg5XHU4OEM1XHU1MTY4XHU3QTBCKG5wbSBcdTg5RTNcdTY3OTArXHU0RTBCXHU4RjdEK1x1ODQzRFx1NzZEODtcdTk1NUNcdTUwQ0YgbnBtbWlycm9yIFx1OTAxQVx1NUUzOCA8MiBcdTUyMDZcdTk0OUYpLFx1NEUwQVx1OTY1MCA4IFx1NTIwNlx1OTQ5RlxyXG4gICAgICAgIGF3YWl0IHdhaXRGb3IoJ2RvbmUgcGFnZScsIGB2YXIgZD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtZG9uZScpO1xyXG4gICAgICAgICAgaWYoZCkgcmV0dXJuIHtvazp0cnVlLCBkZXRhaWw6J2RvbmUnfTtcclxuICAgICAgICAgIHZhciBjPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1jb25maWcnKTtcclxuICAgICAgICAgIGlmKGMpeyB2YXIgcz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdcdThERjNcdThGQzcnKT49MDt9KTsgaWYocykgcy5jbGljaygpOyB9XHJcbiAgICAgICAgICB2YXIgZXJyPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtZXJyb3InKTtcclxuICAgICAgICAgIGlmKGVycikgcmV0dXJuIHtvazpmYWxzZSwgZGV0YWlsOidpbnN0YWxsIGVycm9yOiAnK2Vyci50ZXh0Q29udGVudC5zbGljZSgwLDgwKX07XHJcbiAgICAgICAgICByZXR1cm4ge29rOmZhbHNlLCBkZXRhaWw6J2luc3RhbGxpbmdcdTIwMjYnfTtgLCA4ICogNjBfMDAwKTtcclxuICAgICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignZG9uZSByZWFkeSB0ZXh0JywgYHZhciBkPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1kb25lJyk7XHJcbiAgICAgICAgICB2YXIgdD1kP2QudGV4dENvbnRlbnQ6Jyc7XHJcbiAgICAgICAgICByZXR1cm4ge29rOiAhIWQgJiYgdC5pbmRleE9mKCdcdTVDMzFcdTdFRUEnKT49MCwgZGV0YWlsOiB0LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw2MCl9O2AsIDEwXzAwMCk7XHJcbiAgICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgICBhd2FpdCBzaG90KCd3aXphcmQtcmVhbC1kb25lJyk7XHJcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1RjAwXHU1OUNCXHU0RjdGXHU3NTI4Jzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgY29uc3QgY29ubmVjdGVkID0gYXdhaXQgd2FpdEZvcignbmV3IHJ1bnRpbWUgY29ubmVjdGVkJywgYHZhciBkb3Q9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmhvc3QtZG90Lm9uJyk7XHJcbiAgICAgICAgICB2YXIgbD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuaG9zdC1sYWJlbCcpO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogISFkb3QgJiYgISFsICYmIGwudGV4dENvbnRlbnQuaW5kZXhPZigncnVudGltZScpPj0wLCBkZXRhaWw6ICdkb3Q9JysoZG90Pydvbic6J29mZicpKycgbGFiZWw9JysobD9sLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw1MCk6J25vbmUnKX07YCwgNjBfMDAwKTtcclxuICAgICAgICBjb25zdCBzdCA9IChhd2FpdCBqcyhgd2luZG93LmhtaC5nZXRTdGF0ZSgpLnRoZW4oZnVuY3Rpb24ocil7cmV0dXJuIEpTT04uc3RyaW5naWZ5KHttb2RlOnIubW9kZSwgcnVudGltZUVudHJ5OnIucnVudGltZUVudHJ5fSk7fSlgKSkgYXMgc3RyaW5nO1xyXG4gICAgICAgIGNvbnN0IHAgPSBKU09OLnBhcnNlKHN0KSBhcyB7IG1vZGU/OiBzdHJpbmc7IHJ1bnRpbWVFbnRyeT86IHN0cmluZyB8IG51bGwgfTtcclxuICAgICAgICBjb25zdCBlbnRyeU9rID0gKHAucnVudGltZUVudHJ5ID8/ICcnKS5pbmRleE9mKCcuaG1oYXJuZXNzLWdsb2JhbCcpID49IDA7XHJcbiAgICAgICAgYXdhaXQgc2hvdCgnd2l6YXJkLXJlYWwtZmluYWwnKTtcclxuICAgICAgICByZXR1cm4gW2Nvbm5lY3RlZFswXSAmJiBlbnRyeU9rLCBgY29ubmVjdGVkOiAke2Nvbm5lY3RlZFsxXX07IHN0YXRlPSR7c3Quc2xpY2UoMCwgOTApfWBdO1xyXG4gICAgICB9KTtcclxuICAgIH1cclxuICAgIGF3YWl0IHNob3QoJ2ZpbmFsJyk7XHJcbiAgfSBlbHNlIHtcclxuICAgIC8qID09PT09PT09PT0gcmVhbDpcdTUzRUFcdThCRkJcdTVCNTBcdTk2QzYoXHU0RTBEXHU1MkE4XHU3NzFGXHU1QjlFXHU0RjFBXHU4QkREKSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTk4NzZcdTY4MEY6cnVudGltZSBcdTcyNDhcdTY3MkNcdTRFMEVcdTdBRUZcdTUzRTNcdTVERjJcdTY2M0VcdTc5M0EoXHU5NzVFID8pJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignaG9zdCBsYWJlbCcsIGB2YXIgbD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuaG9zdC1sYWJlbCcpO1xyXG4gICAgICAgIHZhciB0ID0gbCA/IGwudGV4dENvbnRlbnQgOiAnJztcclxuICAgICAgICByZXR1cm4ge29rOiB0LmluZGV4T2YoJz8nKSA8IDAgJiYgdC5pbmRleE9mKCdydW50aW1lJykgPj0gMCwgZGV0YWlsOiB0LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw2MCl9O2AsIDE1XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ1x1NEYxQVx1OEJERFx1NTIxN1x1ODg2ODpcdTc3MUZcdTVCOUVcdTUzODZcdTUzRjJcdTUyQTBcdThGN0QoXHU2NTcwXHU5MUNGPjApJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignc2Vzc2lvbnMnLCBgdmFyIG49ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aDtcclxuICAgICAgICByZXR1cm4ge29rOiBuID4gMCwgZGV0YWlsOiAnc2Vzc2lvbnM9JytufTtgLCAxNV8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdcdTcwQjlcdTUxRkJcdTUzODZcdTUzRjJcdTRGMUFcdThCREQgXHUyMTkyIFx1NzcxRlx1NUI5RSB0cmFuc2NyaXB0IFx1NTE4NVx1NUJCOVx1NTNFRlx1ODlDMScsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgbiA9IChhd2FpdCBqcyhgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aGApKSBhcyBudW1iZXI7XHJcbiAgICAgIGlmIChuID09PSAwKSByZXR1cm4gW2ZhbHNlLCAnbm8gc2Vzc2lvbnMgdG8gY2xpY2snXTtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgaXQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNlc3Npb24taXRlbScpOyBpZiAoaXQpIGl0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2hpc3RvcnkgdHVybnMnLCBgdmFyIHRzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnR1cm4nKSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogdHMubGVuZ3RoID49IDEsIGRldGFpbDogJ3R1cm5zPScrdHMubGVuZ3RoKycgZmlyc3Q9JysodHNbMF0/dHNbMF0udGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDQwKTonbm9uZScpfTtgLCAxNV8wMDApO1xyXG4gICAgICBhd2FpdCBzaG90KCdyZWFsLWhpc3RvcnknKTtcclxuICAgICAgcmV0dXJuIHc7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ0RvY2s6T3ZlcnZpZXcgXHU3NzFGXHU1QjlFXHU2NTcwXHU2MzZFKHJ1bnRpbWUgXHU3MjQ4XHU2NzJDXHU5NzVFXHU2NUUwXHU2NTcwXHU2MzZFKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J092ZXJ2aWV3Jzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdvdmVydmlldycsIGB2YXIgcm93cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXJvdycpKTtcclxuICAgICAgICB2YXIgdmVyID0gcm93cy5maW5kKGZ1bmN0aW9uKHIpeyByZXR1cm4gci50ZXh0Q29udGVudC5pbmRleE9mKCdydW50aW1lIFx1NzI0OFx1NjcyQycpPj0wOyB9KTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXZlciAmJiB2ZXIudGV4dENvbnRlbnQuaW5kZXhPZignXHU2NUUwXHU2NTcwXHU2MzZFJykgPCAwLCBkZXRhaWw6IHZlciA/IHZlci50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNTApIDogJ25vIHZlciByb3cnfTtgLCAxMF8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdEb2NrOkRpZmYgXHU3NzFGXHU1QjlFIGdpdCBcdTcyQjZcdTYwMDEoXHU5NzVFXHU1MkEwXHU4RjdEXHU0RTJEKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J1x1NTNEOFx1NjZGNCd8fHgudGV4dENvbnRlbnQ9PT0nRGlmZic7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignZGlmZicsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuZGlmZi1wYW5lJyk7XHJcbiAgICAgICAgdmFyIHQgPSBwID8gcC50ZXh0Q29udGVudCA6ICcnO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhcCAmJiB0LmluZGV4T2YoJ1x1NTJBMFx1OEY3RFx1NEUyRCcpIDwgMCwgZGV0YWlsOiB0LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw2MCl9O2AsIDE1XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ0RvY2s6RXZpZGVuY2UgXHU3NzFGXHU1QjlFXHU4QkE0XHU3N0U1XHU2NTcwXHU2MzZFJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nXHU4QkMxXHU2MzZFJ3x8eC50ZXh0Q29udGVudD09PSdFdmlkZW5jZSc7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignZXZpZGVuY2UnLCBgdmFyIHJvd3M9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay1yb3cnKSk7XHJcbiAgICAgICAgdmFyIG1lbSA9IHJvd3MuZmluZChmdW5jdGlvbihyKXsgcmV0dXJuIHIudGV4dENvbnRlbnQuaW5kZXhPZignXHU4QkIwXHU1RkM2XHU1QzQyJyk+PTAgfHwgci50ZXh0Q29udGVudC5pbmRleE9mKCdNZW1vcnkgbGF5ZXJzJyk+PTA7IH0pO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhbWVtICYmIG1lbS50ZXh0Q29udGVudC5pbmRleE9mKCdcdTIwMjYnKSA8IDAsIGRldGFpbDogbWVtID8gbWVtLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw1MCkgOiAnbm8gcm93J307YCwgMTVfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnXHU5NjQ0XHU0RUY2XHU0RTBFXHU3NkVFXHU1RjU1XHU1MTY1XHU1M0UzOlx1RDgzRFx1RENDRSBcdTRFMEFcdTRGMjAgKyBcdTk4NzZcdTY4MEZcdTRFMkQvRU4gKyBcdUQ4M0RcdURDQzEgXHU2RDRGXHU4OUM4XHU2MzA5XHU5NEFFXHU1QjU4XHU1NzI4JywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nXHU2NTg3XHU0RUY2J3x8eC50ZXh0Q29udGVudD09PSdGaWxlcyc7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBhd2FpdCB3YWl0Rm9yKCdmaWxlcyB0YWInLCBgdmFyIHQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmRvY2stdGFiLmFjdGl2ZScpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhdCAmJiAodC50ZXh0Q29udGVudD09PSdcdTY1ODdcdTRFRjYnfHx0LnRleHRDb250ZW50PT09J0ZpbGVzJyksIGRldGFpbDogJ2FjdGl2ZT0nKyh0P3QudGV4dENvbnRlbnQ6J25vbmUnKX07YCwgNV8wMDApO1xyXG4gICAgICAvLyByZWFsIFx1NkEyMVx1NUYwRiB3b3Jrc3BhY2VzIFx1OEJGN1x1NkM0Mlx1OEQ3MCBydW50aW1lKFx1NTFCN1x1NTQyRlx1NTJBOFx1NTQwRVx1NTNFRlx1ODBGRFx1NjM5Mlx1OTYxRiksXHU2NTNFXHU1QkJEXHU1MjMwIDE1c1xyXG4gICAgICBjb25zdCB3cyA9IGF3YWl0IHdhaXRGb3IoJ3dzIHBpY2tlcicsIGB2YXIgdz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtcGlja2VyJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISF3LCBkZXRhaWw6IHcgPyAnbG9hZGVkJyA6ICd3b3Jrc3BhY2VzIG5vdCBsb2FkZWQgeWV0J307YCwgbW9kZSA9PT0gJ3JlYWwnID8gMTVfMDAwIDogNl8wMDApO1xyXG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKGAoZnVuY3Rpb24oKXtcclxuICAgICAgICB2YXIgdXAgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY29tcG9zZXIgYnV0dG9uW2FyaWEtbGFiZWwqPVwiXHU0RTBBXHU0RjIwXCJdLCAuY29tcG9zZXIgYnV0dG9uW2FyaWEtbGFiZWwqPVwiVXBsb2FkXCJdJyk7XHJcbiAgICAgICAgdmFyIGxhbmcgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcubGFuZy1zZWcnKTtcclxuICAgICAgICB2YXIgYnIgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtcGlja2VyIGJ1dHRvbicpO1xyXG4gICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh7dXA6ICEhdXAsIGxhbmc6ICEhbGFuZywgYnJvd3NlOiAhIWJyfSk7XHJcbiAgICAgIH0pKClgKSkgYXMgc3RyaW5nO1xyXG4gICAgICBjb25zdCBwID0gSlNPTi5wYXJzZShyKSBhcyB7IHVwOiBib29sZWFuOyBsYW5nOiBib29sZWFuOyBicm93c2U6IGJvb2xlYW4gfTtcclxuICAgICAgcmV0dXJuIFtwLnVwICYmIHAubGFuZyAmJiBwLmJyb3dzZSwgYFx1RDgzRFx1RENDRT0ke3AudXB9IFx1NEUyRC9FTj0ke3AubGFuZ30gXHVEODNEXHVEQ0MxPSR7cC5icm93c2V9OyAke3dzWzFdfWBdO1xyXG4gICAgfSk7XHJcbiAgICAvKiA9PT09PT09PT09IHJlYWw6XHU3NzFGXHU1QjlFXHU0RUZCXHU1MkExXHU3QUVGXHU1MjMwXHU3QUVGXHU5OTk2XHU5QThDKFx1NTNEMVx1NzdFRFx1NEVGQlx1NTJBMVx1MjE5Mlx1NkEyMVx1NTc4Qlx1NTZERVx1NTkwRCkgPT09PT09PT09PVxyXG4gICAgICAgXHU3NTI4XHU2MjM3IGdsbS01LjMgXHU1REYyXHU5MTREXHU3RjZFO1x1NjNEMFx1NzkzQVx1OEJDRFx1N0VBNlx1Njc1Rlx1NzZGNFx1NjNBNVx1NTZERVx1NTkwRFx1MzAwMlx1ODJFNSBhZ2VudCBcdThCRjdcdTZDNDJcdTVCQTFcdTYyNzksXHU4RjZFXHU4QkUyXHU5MUNDXHJcbiAgICAgICBcdTgxRUFcdTUyQThcdTcwQjlcdTYyNzlcdTUxQzYoXHU2NzAwXHU1OTFBXHU4OUMxXHU1MzYxXHU1MzczXHU3MEI5LFx1NUU0Mlx1N0I0OSlcdTMwMDJcdThEODVcdTY1RjYgMTUwc1x1MzAwMiAqL1xyXG4gICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX1JFQUxfVEFTSyA9PT0gJzEnKSB7XHJcbiAgICAgIGF3YWl0IHN0ZXAoJ1x1NzcxRlx1NUI5RVx1NEVGQlx1NTJBMTpcdTUzRDFcdTkwMDFcdTIxOTJcdTZBMjFcdTU3OEJcdTU2REVcdTU5MEQoXHU3QUVGXHU1MjMwXHU3QUVGXHU5OTk2XHU5QThDKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OiduJywgY3RybEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgICBhd2FpdCBzbGVlcCg0MDApO1xyXG4gICAgICAgIGF3YWl0IHR5cGVJbnRvKCcuY29tcG9zZXIgdGV4dGFyZWEnLCAnXHU4QkY3XHU1M0VBXHU1NkRFXHU1OTBEXHU0RTI0XHU0RTJBXHU1QjU3Olx1NjUzNlx1NTIzMChcdTY3MkNcdTZCMjFcdTlBOENcdTY1MzZcdTRFRkJcdTUyQTEsXHU0RTBEXHU4OTgxXHU0RjdGXHU3NTI4XHU0RUZCXHU0RjU1XHU1REU1XHU1MTc3LFx1NzZGNFx1NjNBNVx1NTZERVx1NTkwRCknKTtcclxuICAgICAgICBhd2FpdCBzbGVlcCgyMDApO1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY29tcG9zZXIgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NTNEMVx1OTAwMSc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgIGNvbnN0IHNlbnQgPSBhd2FpdCB3YWl0Rm9yKCd1c2VyIHR1cm4nLCBgdmFyIHQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnR1cm4udXNlcicpO1xyXG4gICAgICAgICAgdmFyIHMgPSAodCAmJiB0LnRleHRDb250ZW50KSA/IFN0cmluZyh0LnRleHRDb250ZW50KSA6ICcnO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogcy5pbmRleE9mKCdcdTY1MzZcdTUyMzAnKT49MCB8fCBzLmluZGV4T2YoJ1x1OUE4Q1x1NjUzNlx1NEVGQlx1NTJBMScpPj0wLCBkZXRhaWw6IHMuc2xpY2UoMCwzMCkgfHwgJ25vbmUnfTtgLCAxMF8wMDApO1xyXG4gICAgICAgIGlmICghc2VudFswXSkgcmV0dXJuIHNlbnQ7XHJcbiAgICAgICAgY29uc3QgcmVwbHkgPSBhd2FpdCB3YWl0Rm9yKCdhc3Npc3RhbnQgcmVwbHknLCBgXHJcbiAgICAgICAgICB2YXIgYXAgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuYXBwcm92YWwtY2FyZCBidXR0b24nKTtcclxuICAgICAgICAgIGlmIChhcCAmJiBhcC50ZXh0Q29udGVudC50cmltKCkuaW5kZXhPZignXHU2Mjc5XHU1MUM2Jyk+PTApIGFwLmNsaWNrKCk7XHJcbiAgICAgICAgICB2YXIgdHM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudHVybicpKS5maWx0ZXIoZnVuY3Rpb24oeCl7IHJldHVybiB4LmNsYXNzTmFtZS5pbmRleE9mKCd1c2VyJyk8MCAmJiB4LmNsYXNzTmFtZS5pbmRleE9mKCdhcHByb3ZhbCcpPDAgJiYgeC5jbGFzc05hbWUuaW5kZXhPZignc3lzdGVtJyk8MCAmJiB4LnRleHRDb250ZW50LnRyaW0oKS5sZW5ndGg+MCAmJiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1NTZERVx1NTQwOCcpPDA7IH0pO1xyXG4gICAgICAgICAgdmFyIHN1bSA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy50dXJuLXN1bScpO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogdHMubGVuZ3RoPj0xICYmICEhc3VtLCBkZXRhaWw6ICdhc3Npc3RhbnQ9Jyt0cy5sZW5ndGgrJyBzdW09Jysoc3VtP3N1bS50ZXh0Q29udGVudDonbm9uZScpKycgZmlyc3Q9JysodHNbMF0/dHNbMF0udGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDQwKTonbm9uZScpfTtcclxuICAgICAgICBgLCAxNTBfMDAwKTtcclxuICAgICAgICBhd2FpdCBzaG90KCdyZWFsLXRhc2snKTtcclxuICAgICAgICByZXR1cm4gcmVwbHk7XHJcbiAgICAgIH0pO1xyXG4gICAgfVxyXG4gICAgYXdhaXQgc3RlcCgnXHU0RjFBXHU4QkREXHU1MjA2XHU3RUM0Olx1NURFNlx1NjgwRlx1NjMwOVx1NURFNVx1NEY1Q1x1NTMzQVx1NTIwNlx1N0VDNChcdTdFQzRcdTU5MzRcdTUzRUZcdTg5QzEpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignZ3JvdXAgaGVhZCcsIGB2YXIgaD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtZ3JvdXAtaGVhZCcpO1xyXG4gICAgICAgIHZhciBuID0gaCA/IChoLnF1ZXJ5U2VsZWN0b3IoJy53cy1ncm91cC1uYW1lJyl8fHt9KS50ZXh0Q29udGVudCA6ICcnO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhaCAmJiBuLmxlbmd0aCA+IDAsIGRldGFpbDogJ25hbWU9JytufTtgLCAxNV8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdcdTVERTVcdTRGNUNcdTUzM0E6XHU1REU2XHU2ODBGXHU1REU1XHU0RjVDXHU1MzNBXHU2ODBGXHU1M0VGXHU4OUMxKFx1NzcxRlx1NUI5RVx1NURFNVx1NEY1Q1x1NTMzQVx1NTQwRCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCd3b3Jrc3BhY2UgYmFyJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53b3Jrc3BhY2UtYmFyJyk7XHJcbiAgICAgICAgdmFyIG4gPSBiID8gKGIucXVlcnlTZWxlY3RvcignLndzLWJhci1uYW1lJyl8fHt9KS50ZXh0Q29udGVudCA6ICcnO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYiAmJiAhIW4gJiYgbi5sZW5ndGggPiAwICYmIG4uaW5kZXhPZignXHU1MkEwXHU4RjdEJykgPCAwICYmIG4uaW5kZXhPZignTG9hZGluZycpIDwgMCwgZGV0YWlsOiAnbmFtZT0nK259O2AsIDE1XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHNob3QoJ2ZpbmFsJyk7XHJcbiAgfVxyXG5cclxuICBmaW5pc2goKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGF0dGFjaFVpVmVyaWZ5KHdpbjogQnJvd3NlcldpbmRvdyk6IHZvaWQge1xyXG4gIGNvbnN0IG1vZGUgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9NT0RFID09PSAncmVhbCcgPyAncmVhbCcgOiAnZmFrZSc7XHJcbiAgd2luLndlYkNvbnRlbnRzLm9uY2UoJ2RpZC1maW5pc2gtbG9hZCcsICgpID0+IHtcclxuICAgIC8vIFx1N0VEOSBob3N0IFx1NTQyRlx1NTJBOFx1NzU1OVx1NjVGNlx1OTVGNDtcdTZCNjVcdTlBQTRcdTUxODVcdTkwRThcdTU0MDRcdTgxRUFcdThGNkVcdThCRTJcdTdCNDlcdTVGODVcclxuICAgIHNldFRpbWVvdXQoKCkgPT4geyB2b2lkIHJ1blVpVmVyaWZ5KHdpbiwgbW9kZSk7IH0sIDNfMDAwKTtcclxuICB9KTtcclxufVxyXG4iLCAiLyoqXHJcbiAqIFx1ODlDNlx1ODlDOVx1NTZERVx1NUY1Mlx1NjIyQVx1NTZGRVx1OTRBOVx1NUI1MCBcdTIwMTRcdTIwMTQgXHU3ODZFXHU1QjlBXHU2MDI3XHU4OUM2XHU1M0UzXHU2MjJBXHU1NkZFLFx1NEY5QiBzY3JpcHRzL3Zpc3VhbC1yZWdyZXNzaW9uLm1qcyBcdTUwNUFcdTUwQ0ZcdTdEMjAgZGlmZlx1MzAwMlxyXG4gKlxyXG4gKiBcdTRFMEUgdWktdmVyaWZ5IFx1NTQwQ1x1NjVDRihcdTk2RjZcdTdCMkNcdTRFMDlcdTY1QjlcdTRGOURcdThENTYpLFx1NEY0Nlx1NzZFRVx1NjgwN1x1NjYyRlwiXHU1NDBDXHU0RTAwXHU4RjkzXHU1MTY1IFx1MjE5MiBcdTkwMTBcdTVCNTdcdTgyODJcdTUzRUZcdTZCRDRcdTc2ODRcdTU2RkVcIjpcclxuICogIC0gXHU3QTk3XHU1M0UzXHU1RjUyXHU0RTAwIDEyODBcdTAwRDc4MDA7XHU0RTNCXHU5ODk4L1x1OEJFRFx1OEEwMFx1NTZGQVx1NUI5QShsaWdodCArIFx1NUY1M1x1NTI0RCBsb2NhbGUgXHU5RUQ4XHU4QkE0LFx1NTE5OSBsb2NhbFN0b3JhZ2UgXHU1NDBFIHJlbG9hZClcclxuICogIC0gZmFrZSBob3N0KEhNSF9ERVNLVE9QX1ZJU1JFRz0xIFx1NjVGNiBtYWluIFx1NURGMlx1NUYzQVx1NTIzNiBmYWtlKTpcdTdBN0FcdTRGMUFcdThCREQvXHU1NkZBXHU1QjlBXHU1REU1XHU0RjVDXHU1MzNBXHU0RTBFIHByb3ZpZGVyXHJcbiAqICAtIFx1NEUwOVx1ODlDNlx1NTNFMzptYWluKFx1NEYxQVx1OEJERFx1NEUzQlx1NzU0Q1x1OTc2Mlx1N0E3QVx1NjAwMSkvIHNldHRpbmdzKFx1OEJCRVx1N0Y2RVx1NUYzOVx1NUM0MikvIGRvY2soRmlsZXMgXHU2RDRGXHU4OUM4KVxyXG4gKiAgLSBcdTUyQThcdTYwMDFcdTUzM0EgbWFzazpcdTUyQThcdTYwMDFcdTdBRUZcdTUzRTMvXHU2NUY2XHU5NUY0XHU2MjMzL1x1OEJBMVx1NjU3MFx1N0I0OVx1NTE0M1x1N0QyMFx1NjMwOSBib3VuZGluZyBib3ggXHU4QkIwXHU1MTY1IG1ldGEuanNvbixcclxuICogICAgXHU1MENGXHU3RDIwIGRpZmYgXHU2NUY2XHU4REYzXHU4RkM3KFx1NTc1MFx1NjgwN1x1NURGMlx1NjMwOSBjYXB0dXJlUGFnZSBcdTVCOUVcdTk2NDVcdTVDM0FcdTVCRjggXHUwMEQ3IGRldmljZVBpeGVsUmF0aW8gXHU2MzYyXHU3Qjk3KVxyXG4gKiAgLSBITUhfREVTS1RPUF9WSVNSRUdfTVVUQVRFPTx2aWV3cG9ydD46XHU1NzI4XHU4QkU1XHU4OUM2XHU1M0UzXHU2Q0U4XHU1MTY1XHU1NkZBXHU1QjlBXHU4MjcyXHU1NzU3LFx1NzUyOFx1NEU4RVx1N0JBMVx1N0VCRlx1ODFFQVx1NjhDMFxyXG4gKiAgICAoYmFzZWxpbmUgXHU4MUVBXHU2QkQ0IDAgXHU1REVFXHU1RjAyICsgXHU2NTQ1XHU2MTBGXHU2NTM5XHU1MkE4XHU1RkM1IEZBSUwsXHU4QkMxXHU2NjBFXHU5NjA4XHU1MDNDXHU0RTBFIGRpZmYgXHU1NkZFXHU3NzFGXHU1QjlFXHU1REU1XHU0RjVDKVxyXG4gKiBlbnY6SE1IX0RFU0tUT1BfVklTUkVHPTEoXHU1RjAwXHU1MTczKS8gSE1IX0RFU0tUT1BfVklTUkVHX09VVD08ZGlyPihcdThGOTNcdTUxRkFcdTc2RUVcdTVGNTUpXHJcbiAqL1xyXG5pbXBvcnQgeyBhcHAsIHR5cGUgQnJvd3NlcldpbmRvdyB9IGZyb20gJ2VsZWN0cm9uJztcclxuaW1wb3J0IHsgbWtkaXIsIHdyaXRlRmlsZSB9IGZyb20gJ25vZGU6ZnMvcHJvbWlzZXMnO1xyXG5pbXBvcnQgeyBqb2luIH0gZnJvbSAnbm9kZTpwYXRoJztcclxuXHJcbmNvbnN0IHNsZWVwID0gKG1zOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+ID0+IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIG1zKSk7XHJcblxyXG4vKiogXHU1MkE4XHU2MDAxXHU1MzNBXHU1N0RGKFx1NkJDRlx1NkIyMVx1OEZEMFx1ODg0Q1x1NUZDNVx1NTNEOFx1NzY4NFx1NTE4NVx1NUJCOSlcdTIxOTIgbWFzayBcdTkwMDlcdTYyRTlcdTU2Njg7XHU5NzU5XHU2MDAxXHU3RUQzXHU2Nzg0XHU0RTBEIG1hc2ssZGlmZiBcdTYyNERcdTY3MDlcdTYxMEZcdTRFNDkgKi9cclxuY29uc3QgTUFTS19TRUxFQ1RPUlM6IEFycmF5PHsgc2VsOiBzdHJpbmc7IHJlYXNvbjogc3RyaW5nIH0+ID0gW1xyXG4gIHsgc2VsOiAnLmhvc3QtbGFiZWwnLCByZWFzb246ICdob3N0IFx1N0FFRlx1NTNFMy9cdTcyNDhcdTY3MkMoZmFrZSBob3N0IFx1NkJDRlx1NkIyMVx1OTY4Rlx1NjczQVx1N0FFRlx1NTNFMyknIH0sXHJcbiAgeyBzZWw6ICcuc2Vzc2lvbi10aW1lJywgcmVhc29uOiAnXHU0RjFBXHU4QkREXHU2NUY2XHU5NUY0XHU2MjMzJyB9LFxyXG4gIHsgc2VsOiAnLnR1cm4tc3VtJywgcmVhc29uOiAnXHU1NkRFXHU1NDA4L3Rva2VuIFx1OEJBMVx1NjU3MCcgfSxcclxuXTtcclxuXHJcbi8qKiBcdTU2RkFcdTVCOUFcdTg5QzZcdTUzRTM6XHU4OTg2XHU3NkQ2XHU0RTA5XHU2ODBGXHU1RTAzXHU1QzQwXHU0RTBFXHU1RTk1XHU5MEU4IGRvY2sgXHU3Njg0XHU1MjA2XHU2NTJGLFx1NTQwQ1x1NjVGNlx1OEZEQ1x1NzlCQiA4MjAvMTEwMCBcdTY1QURcdTcwQjkgKi9cclxuY29uc3QgVklFV1BPUlRfVyA9IDEyODA7XHJcbmNvbnN0IFZJRVdQT1JUX0ggPSA4MDA7XHJcblxyXG5hc3luYyBmdW5jdGlvbiBydW5WaXN1YWxSZWdyZXNzaW9uKHdpbjogQnJvd3NlcldpbmRvdyk6IFByb21pc2U8dm9pZD4ge1xyXG4gIGNvbnN0IG91dCA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1ZJU1JFR19PVVQgPz8gam9pbihhcHAuZ2V0UGF0aCgndGVtcCcpLCAnaG1oLXZpc3JlZycpO1xyXG4gIGNvbnN0IG11dGF0ZSA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1ZJU1JFR19NVVRBVEUgPz8gJyc7XHJcbiAgYXdhaXQgbWtkaXIob3V0LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KS5jYXRjaCgoKSA9PiB1bmRlZmluZWQpO1xyXG4gIGNvbnN0IGpzID0gPFQ+KGNvZGU6IHN0cmluZyk6IFByb21pc2U8VD4gPT4gd2luLndlYkNvbnRlbnRzLmV4ZWN1dGVKYXZhU2NyaXB0KGNvZGUsIHRydWUpIGFzIFByb21pc2U8VD47XHJcbiAgY29uc3Qgd2FpdEZvciA9IGFzeW5jIChsYWJlbDogc3RyaW5nLCBwcmVkaWNhdGVDb2RlOiBzdHJpbmcsIHRpbWVvdXRNczogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiA9PiB7XHJcbiAgICBjb25zdCBzdGFydGVkID0gRGF0ZS5ub3coKTtcclxuICAgIGZvciAoOzspIHtcclxuICAgICAgY29uc3QgciA9IChhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHRyeSB7IHJldHVybiBKU09OLnN0cmluZ2lmeSgoZnVuY3Rpb24oKXsgJHtwcmVkaWNhdGVDb2RlfSB9KSgpKTsgfSBjYXRjaChlKXsgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHtvazpmYWxzZSwgZGV0YWlsOlN0cmluZyhlKS5zbGljZSgwLDEyMCl9KTsgfSB9KSgpYCkpIGFzIHN0cmluZztcclxuICAgICAgbGV0IHBhcnNlZDogeyBvaz86IGJvb2xlYW4gfTtcclxuICAgICAgdHJ5IHsgcGFyc2VkID0gSlNPTi5wYXJzZShyKSBhcyB7IG9rPzogYm9vbGVhbiB9OyB9IGNhdGNoIHsgcGFyc2VkID0ge307IH1cclxuICAgICAgaWYgKHBhcnNlZC5vayA9PT0gdHJ1ZSkgcmV0dXJuO1xyXG4gICAgICBpZiAoRGF0ZS5ub3coKSAtIHN0YXJ0ZWQgPiB0aW1lb3V0TXMpIHtcclxuICAgICAgICBjb25zb2xlLmxvZyhgVklTUkVHLUNBUFRVUkUgRkFJTCB8IHdhaXQgJHtsYWJlbH0gdGltZW91dGApO1xyXG4gICAgICAgIGFwcC5leGl0KDEpO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgICAgfVxyXG4gICAgICBhd2FpdCBzbGVlcCgyNTApO1xyXG4gICAgfVxyXG4gIH07XHJcblxyXG4gIC8vIDApIFx1N0E5N1x1NTNFM1x1NUY1Mlx1NEUwMDpcdTVDM0FcdTVCRjhcdTU2RkFcdTVCOUEoXHU0RjREXHU3RjZFXHU0RkREXHU2MzAxXHU3NTI4XHU2MjM3XHU2ODRDXHU5NzYyXHU0RTBBXHU3Njg0KTtcdTRFM0JcdTk4OThcdTZENDVcdTgyNzIgKyBcdTRFMkRcdTY1ODcsXHU1MTk5XHU1MDRGXHU1OTdEXHU1NDBFIHJlbG9hZCBcdTc1MUZcdTY1NDhcclxuICB0cnkgeyB3aW4uc2V0Qm91bmRzKHsgd2lkdGg6IFZJRVdQT1JUX1csIGhlaWdodDogVklFV1BPUlRfSCB9KTsgfSBjYXRjaCB7IC8qIFx1NjcwMFx1NUMwRlx1NUMzQVx1NUJGOFx1NTE1Q1x1NUU5NSAqLyB9XHJcbiAgYXdhaXQgc2xlZXAoNDAwKTtcclxuICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHRyeSB7IGxvY2FsU3RvcmFnZS5zZXRJdGVtKCdobWgudGhlbWUnLCAnbGlnaHQnKTsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oJ2htaC5sb2NhbGUnLCAnemgnKTsgfSBjYXRjaCAoZSkge30gcmV0dXJuICdvayc7IH0pKClgKTtcclxuICB3aW4ud2ViQ29udGVudHMucmVsb2FkKCk7XHJcbiAgYXdhaXQgd2FpdEZvcignbW91bnRlZCcsIGB2YXIgdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY29tcG9zZXIgdGV4dGFyZWEnKTsgcmV0dXJuIHtvazogISF0LCBkZXRhaWw6IHQgPyAndXAnIDogJ2Rvd24nfTtgLCAyMF8wMDApO1xyXG4gIGF3YWl0IHdhaXRGb3IoJ2hvc3QgZG90IG9uJywgYHZhciBkPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ob3N0LWRvdCcpOyByZXR1cm4ge29rOiAhIWQgJiYgZC5jbGFzc0xpc3QuY29udGFpbnMoJ29uJyksIGRldGFpbDogZCA/IGQuY2xhc3NOYW1lIDogJ25vbmUnfTtgLCAzMF8wMDApO1xyXG4gIGF3YWl0IHNsZWVwKDFfMjAwKTsgLy8gXHU0RjFBXHU4QkREXHU1MjE3XHU4ODY4L1x1OTg3Nlx1NjgwRlx1NjU3MFx1NjM2RVx1ODQzRFx1NTczMFxyXG5cclxuICAvLyAxKSBcdTUxNzNcdTYzODkgZmFrZSBcdTZGMTRcdTc5M0FcdTVGMTVcdTVCRkNcdTVDNDIoXHU5MDZFXHU3RjY5XHU1RjM5XHU1QzQyXHU0RTBEXHU1QzVFXHU0RThFXHU4OEFCXHU2RDRCXHU4OUM2XHU1M0UzO1x1NEUwRFx1NEY5RFx1OEQ1Nlx1NjU4N1x1Njg0OCxcdTYzMDlcdTdFRDNcdTY3ODRcdTUzRDYgZ2hvc3QgXHU2MzA5XHU5NEFFKVxyXG4gIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGc9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnJ1bnRpbWUtZ3VpZGUnKTsgaWYoIWcpIHJldHVybiAnbm8tZ3VpZGUnO1xyXG4gICAgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnJ1bnRpbWUtZ3VpZGUtYWN0aW9ucyAuYnRuLmdob3N0Jyk7IGlmKGIpIGIuY2xpY2soKTsgcmV0dXJuICdkaXNtaXNzZWQnOyB9KSgpYCk7XHJcbiAgYXdhaXQgd2FpdEZvcignZ3VpZGUgY2xvc2VkJywgYHJldHVybiB7b2s6ICFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcucnVudGltZS1ndWlkZScpLCBkZXRhaWw6ICdjbG9zZWQnfTtgLCA1XzAwMCk7XHJcblxyXG4gIC8vIDIpIFx1ODlDNlx1NTNFM1x1NUU4Rlx1NTIxNzptYWluKFx1N0E3QVx1NjAwMVx1NEUzQlx1NzU0Q1x1OTc2MilcdTIxOTIgc2V0dGluZ3MoXHU4QkJFXHU3RjZFXHU1RjM5XHU1QzQyKVx1MjE5MiBkb2NrKEZpbGVzIFx1NkQ0Rlx1ODlDOClcclxuICBjb25zdCB2aWV3cG9ydHM6IEFycmF5PHsgbmFtZTogc3RyaW5nOyBzZXR1cDogKCkgPT4gUHJvbWlzZTx2b2lkPiB9PiA9IFtcclxuICAgIHsgbmFtZTogJ21haW4nLCBzZXR1cDogYXN5bmMgKCkgPT4geyAvKiBcdTU0MkZcdTUyQThcdTlFRDhcdThCQTRcdTYwMDE6XHU3QTdBXHU0RjFBXHU4QkREICsgT3ZlcnZpZXcgZG9jayAqLyB9IH0sXHJcbiAgICB7XHJcbiAgICAgIG5hbWU6ICdzZXR0aW5ncycsXHJcbiAgICAgIHNldHVwOiBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHsga2V5OiAncCcsIGN0cmxLZXk6IHRydWUsIHNoaWZ0S2V5OiB0cnVlLCBidWJibGVzOiB0cnVlIH0pKTsgfSkoKWApO1xyXG4gICAgICAgIGF3YWl0IHdhaXRGb3IoJ3NldHRpbmdzIG9wZW4nLCBgcmV0dXJuIHtvazogISFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kay5zZXR0aW5ncycpLCBkZXRhaWw6ICdvcGVuJ307YCwgNV8wMDApO1xyXG4gICAgICB9LFxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgbmFtZTogJ2RvY2snLFxyXG4gICAgICBzZXR1cDogYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7IGtleTogJ0VzY2FwZScsIGJ1YmJsZXM6IHRydWUgfSkpOyB9KSgpYCk7XHJcbiAgICAgICAgYXdhaXQgd2FpdEZvcignc2V0dGluZ3MgY2xvc2VkJywgYHJldHVybiB7b2s6ICFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kay5zZXR0aW5ncycpLCBkZXRhaWw6ICdjbG9zZWQnfTtgLCA1XzAwMCk7XHJcbiAgICAgICAgLy8gRmlsZXMgdGFiOlx1NjMwOSBkb2NrLXRhYiBcdTk4N0FcdTVFOEZcdTdCMkMgMiBcdTRFMkEoT3ZlcnZpZXcvRmlsZXMvXHUyMDI2KSxcdTkwN0ZcdTUxNERcdTRGOURcdThENTZcdTY1ODdcdTY4NDhcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpWzFdOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICBhd2FpdCB3YWl0Rm9yKCdmaWxlcyByb3dzJywgYHZhciByPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5mcy1yb3cnKTsgcmV0dXJuIHtvazogci5sZW5ndGggPj0gMSwgZGV0YWlsOiAncm93cz0nICsgci5sZW5ndGh9O2AsIDVfMDAwKTtcclxuICAgICAgfSxcclxuICAgIH0sXHJcbiAgXTtcclxuXHJcbiAgY29uc3QgbWV0YTogeyBnZW5lcmF0ZWRBdDogc3RyaW5nOyB3aW5kb3c6IHsgd2lkdGg6IG51bWJlcjsgaGVpZ2h0OiBudW1iZXIgfTsgbXV0YXRlOiBzdHJpbmc7IHZpZXdwb3J0czogQXJyYXk8eyBuYW1lOiBzdHJpbmc7IGZpbGU6IHN0cmluZzsgd2lkdGg6IG51bWJlcjsgaGVpZ2h0OiBudW1iZXI7IGRwcjogbnVtYmVyOyBtYXNrczogQXJyYXk8eyB4OiBudW1iZXI7IHk6IG51bWJlcjsgdzogbnVtYmVyOyBoOiBudW1iZXI7IGZvcjogc3RyaW5nIH0+IH0+IH0gPSB7XHJcbiAgICBnZW5lcmF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxyXG4gICAgd2luZG93OiB7IHdpZHRoOiBWSUVXUE9SVF9XLCBoZWlnaHQ6IFZJRVdQT1JUX0ggfSxcclxuICAgIG11dGF0ZSxcclxuICAgIHZpZXdwb3J0czogW10sXHJcbiAgfTtcclxuICBmb3IgKGNvbnN0IHYgb2Ygdmlld3BvcnRzKSB7XHJcbiAgICBhd2FpdCB2LnNldHVwKCk7XHJcbiAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBhPWRvY3VtZW50LmFjdGl2ZUVsZW1lbnQ7IGlmKGEgJiYgYS5ibHVyKSBhLmJsdXIoKTsgfSkoKWApOyAvLyBcdTUzQkJcdTcxMjZcdTcwQjlcdTczQUZcclxuICAgIGF3YWl0IHNsZWVwKDYwMCk7IC8vIFx1OEZDN1x1NkUyMVx1NEUwRVx1NkUzMlx1NjdEM1x1N0EzM1x1NUI5QVxyXG4gICAgaWYgKG11dGF0ZSA9PT0gdi5uYW1lKSB7XHJcbiAgICAgIC8vIFx1N0JBMVx1N0VCRlx1ODFFQVx1NjhDMDpcdTZDRThcdTUxNjUgMTIwXHUwMEQ3OTAgXHU1NkZBXHU1QjlBXHU3RUEyXHU1NzU3KFx1N0VBNiAxJSBcdTk3NjJcdTc5RUYsPiAwLjUlIFx1OTYwOFx1NTAzQyxcdTVFOTRcdTUyMjQgRkFJTClcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgZD1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTsgZC5zZXRBdHRyaWJ1dGUoJ2RhdGEtdmlzcmVnLW11dGF0ZScsJzEnKTtcclxuICAgICAgICBkLnN0eWxlLmNzc1RleHQ9J3Bvc2l0aW9uOmZpeGVkO2xlZnQ6NTYwcHg7dG9wOjMwMHB4O3dpZHRoOjEyMHB4O2hlaWdodDo5MHB4O2JhY2tncm91bmQ6cmdiKDI1NSwwLDApO3otaW5kZXg6OTk5OTsnO1xyXG4gICAgICAgIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQoZCk7IH0pKClgKTtcclxuICAgICAgYXdhaXQgc2xlZXAoMTUwKTtcclxuICAgIH1cclxuICAgIGNvbnN0IGltZyA9IGF3YWl0IHdpbi53ZWJDb250ZW50cy5jYXB0dXJlUGFnZSgpO1xyXG4gICAgY29uc3Qgc2l6ZSA9IGltZy5nZXRTaXplKCk7XHJcbiAgICAvLyBcdTdCQTFcdTdFQkZcdTgxRUFcdTY4QzBcdTdFQTJcdTU3NTdcdTUzRUFcdTVDNUVcdTRFOEVcdTc2RUVcdTY4MDdcdTg5QzZcdTUzRTM6XHU2MjJBXHU1NkZFXHU1NDBFXHU3QUNCXHU1MzczXHU3OUZCXHU5NjY0LFx1NEUwRFx1NkM2MVx1NjdEM1x1NTQwRVx1N0VFRFx1ODlDNlx1NTNFM1xyXG4gICAgaWYgKG11dGF0ZSA9PT0gdi5uYW1lKSB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignW2RhdGEtdmlzcmVnLW11dGF0ZV0nKTsgaWYoZCkgZC5yZW1vdmUoKTsgfSkoKWApO1xyXG4gICAgfVxyXG4gICAgY29uc3QgaW5uZXJXID0gKGF3YWl0IGpzPG51bWJlcj4oJ3dpbmRvdy5pbm5lcldpZHRoJykpIHx8IHNpemUud2lkdGg7XHJcbiAgICBjb25zdCBkcHIgPSBzaXplLndpZHRoIC8gaW5uZXJXO1xyXG4gICAgY29uc3QgbWFza3M6IEFycmF5PHsgeDogbnVtYmVyOyB5OiBudW1iZXI7IHc6IG51bWJlcjsgaDogbnVtYmVyOyBmb3I6IHN0cmluZyB9PiA9IFtdO1xyXG4gICAgZm9yIChjb25zdCBtIG9mIE1BU0tfU0VMRUNUT1JTKSB7XHJcbiAgICAgIGNvbnN0IHJlY3RzID0gKGF3YWl0IGpzPHN0cmluZz4oYChmdW5jdGlvbigpeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkoW10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcke20uc2VsfScpKS5tYXAoZnVuY3Rpb24oZWwpe1xyXG4gICAgICAgIHZhciByPWVsLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOyByZXR1cm4geyB4OnIueCwgeTpyLnksIHc6ci53aWR0aCwgaDpyLmhlaWdodCB9O1xyXG4gICAgICB9KS5maWx0ZXIoZnVuY3Rpb24ocil7IHJldHVybiByLncgPiAwICYmIHIuaCA+IDAgJiYgci55ID49IDAgJiYgci55IDwgd2luZG93LmlubmVySGVpZ2h0OyB9KSkgfSkoKWApKTtcclxuICAgICAgbGV0IGxpc3Q6IEFycmF5PHsgeDogbnVtYmVyOyB5OiBudW1iZXI7IHc6IG51bWJlcjsgaDogbnVtYmVyIH0+ID0gW107XHJcbiAgICAgIHRyeSB7IGxpc3QgPSBKU09OLnBhcnNlKHJlY3RzKSBhcyB0eXBlb2YgbGlzdDsgfSBjYXRjaCB7IC8qIFx1N0E3QSAqLyB9XHJcbiAgICAgIGZvciAoY29uc3QgciBvZiBsaXN0KSB7XHJcbiAgICAgICAgbWFza3MucHVzaCh7IHg6IE1hdGgucm91bmQoci54ICogZHByKSwgeTogTWF0aC5yb3VuZChyLnkgKiBkcHIpLCB3OiBNYXRoLnJvdW5kKHIudyAqIGRwciksIGg6IE1hdGgucm91bmQoci5oICogZHByKSwgZm9yOiBtLnJlYXNvbiB9KTtcclxuICAgICAgfVxyXG4gICAgfVxyXG4gICAgY29uc3QgZmlsZSA9IGAke3YubmFtZX0ucG5nYDtcclxuICAgIGF3YWl0IHdyaXRlRmlsZShqb2luKG91dCwgZmlsZSksIGltZy50b1BORygpKTtcclxuICAgIG1ldGEudmlld3BvcnRzLnB1c2goeyBuYW1lOiB2Lm5hbWUsIGZpbGUsIHdpZHRoOiBzaXplLndpZHRoLCBoZWlnaHQ6IHNpemUuaGVpZ2h0LCBkcHI6IE1hdGgucm91bmQoZHByICogMTAwKSAvIDEwMCwgbWFza3MgfSk7XHJcbiAgICBjb25zb2xlLmxvZyhgVklTUkVHLUNBUFRVUkUgJHt2Lm5hbWV9ICR7c2l6ZS53aWR0aH14JHtzaXplLmhlaWdodH0gbWFza3M9JHttYXNrcy5sZW5ndGh9JHttdXRhdGUgPT09IHYubmFtZSA/ICcgTVVUQVRFRCcgOiAnJ31gKTtcclxuICB9XHJcbiAgYXdhaXQgd3JpdGVGaWxlKGpvaW4ob3V0LCAnbWV0YS5qc29uJyksIEpTT04uc3RyaW5naWZ5KG1ldGEsIG51bGwsIDIpKTtcclxuICBjb25zb2xlLmxvZygnVklTUkVHLUNBUFRVUkUgRE9ORScpO1xyXG4gIGFwcC5leGl0KDApO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gYXR0YWNoVmlzdWFsUmVncmVzc2lvbih3aW46IEJyb3dzZXJXaW5kb3cpOiB2b2lkIHtcclxuICB3aW4ud2ViQ29udGVudHMub25jZSgnZGlkLWZpbmlzaC1sb2FkJywgKCkgPT4ge1xyXG4gICAgc2V0VGltZW91dCgoKSA9PiB7IHZvaWQgcnVuVmlzdWFsUmVncmVzc2lvbih3aW4pOyB9LCAxXzUwMCk7XHJcbiAgfSk7XHJcbn1cclxuIiwgIi8qKlxuICogdjUuMSBcdTVCODlcdTg4QzVcdTU0MTFcdTVCRkMgXHUwMEI3IEBobWhhcm5lc3MvY2xpIFx1NUI4OVx1ODhDNVx1N0YxNlx1NjM5MihcdTRFM0JcdThGREJcdTdBMEIpXHUzMDAyXG4gKlxuICogXHU0RTI0XHU2NzYxXHU4REVGXHU1Rjg0KFx1NjNEMFx1NzkzQVx1OEJDRCB2NS4xIFx1NTQwOFx1NTQwQyk6XG4gKiAgLSBucG0gXHU1M0VGXHU3NTI4KFx1OUVEOFx1OEJBNCk6YG5wbSBpbnN0YWxsIC0tcHJlZml4ICVVU0VSUFJPRklMRSVcXC5obWhhcm5lc3MtZ2xvYmFsXG4gKiAgICBAaG1oYXJuZXNzL2NsaWAgXHUyMDE0XHUyMDE0IFx1NTNFQVx1NTE5OVx1NzUyOFx1NjIzN1x1NzZFRVx1NUY1NSxcdTRFMERcdTc4QjBcdTdDRkJcdTdFREYvbnBtIFx1NTE2OFx1NUM0MDtucG0gXHU4MUVBXHU1RTI2XHU0RjlEXHU4RDU2XHU4OUUzXHU2NzkwLFxuICogICAgXHU4RkRCXHU1RUE2XHU4RjZDXHU1M0QxXHU1MTc2XHU4RjkzXHU1MUZBXHU4ODRDKFx1NUI4OVx1ODhDNVx1NkI2NVx1OUFBNFx1NjU4N1x1Njg0OClcdTMwMDJcbiAqICAtIFx1NjVFMCBucG0oXHU2MjE2XHU2NjNFXHU1RjBGXHU1RjNBXHU1MjM2KTpcdTgxRUFcdTc4MTQgdGd6IFx1NUI4OVx1ODhDNVx1NTY2OCBcdTIwMTRcdTIwMTQgXHU0RjlEXHU4RDU2XHU5NUVEXHU1MzA1XHU2NzY1XHU4MUVBXG4gKiAgICBAaG1oLWRlc2t0b3AvY2xpLWluc3RhbGxlcihcdTdFQUZcdTkwM0JcdThGOTEsXHU1REYyXHU1MzU1XHU2RDRCKSx0YXJiYWxsIFx1OTAxMFx1NTMwNVx1NkQ0MVx1NUYwRlx1NEUwQlx1OEY3RFxuICogICAgKFx1NzcxRlx1NUI1N1x1ODI4Mlx1OEZEQlx1NUVBNiArIHJlZ2lzdHJ5Lm5wbWpzLm9yZ1x1MjE5MnJlZ2lzdHJ5Lm5wbW1pcnJvci5jb20gXHU5NTVDXHU1MENGXHU1NkRFXHU5MDAwLFxuICogICAgXHU1OTBEXHU3NTI4IHY0IFx1NjZGNFx1NjVCMFx1NTY2OFx1NTZERVx1OTAwMFx1NjAxRFx1NjBGMyArIGludGVncml0eSBcdTY4MjFcdTlBOEMpLFx1N0NGQlx1N0VERiB0YXIuZXhlIFx1ODlFM1x1NTM4Qlx1NTIzMFxuICogICAgbm9kZV9tb2R1bGVzIFx1NjI0MVx1NUU3M1x1NUUwM1x1NUM0MFx1MzAwMlxuICogXHU4RkRCXHU1RUE2XHU0RTAwXHU1RjhCXHU3RUNGIGluc3RhbGw6cHJvZ3Jlc3MgXHU0RThCXHU0RUY2XHU2M0E4IHJlbmRlcmVyO1x1NjIxMFx1NTI5Rlx1NTZERVx1OEMwMyBvbkluc3RhbGxlZChlbnRyeSlcbiAqIFx1NzUzMSBtYWluIFx1NjMwMVx1NEU0NVx1NTMxNiBydW50aW1lLmpzb24gXHU1RTc2XHU3MEVEXHU5MUNEXHU1NDJGIGhvc3RcdTMwMDJcbiAqL1xuaW1wb3J0IHsgc3Bhd24gfSBmcm9tICdub2RlOmNoaWxkX3Byb2Nlc3MnO1xuaW1wb3J0IHsgZXhpc3RzU3luYywgbWtkaXJTeW5jLCBybVN5bmMsIHJlbmFtZVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tICdub2RlOmZzJztcbmltcG9ydCB7IGhvbWVkaXIgfSBmcm9tICdub2RlOm9zJztcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdub2RlOnBhdGgnO1xuaW1wb3J0IHsgYnl0ZXNMYWJlbCwgaW50ZWdyaXR5T2ssIG1vZHVsZURpciwgcmVzb2x2ZUNsb3N1cmUsIHRhcmJhbGxNaXJyb3JzLCB0eXBlIFBhY2t1bWVudCwgdHlwZSBSZXNvbHZlZFBrZyB9IGZyb20gJ0BobWgtZGVza3RvcC9jbGktaW5zdGFsbGVyJztcblxuZXhwb3J0IGludGVyZmFjZSBJbnN0YWxsUHJvZ3Jlc3Mge1xuICBwaGFzZTogJ2NoZWNrJyB8ICdtZXRhJyB8ICdkb3dubG9hZCcgfCAnZXh0cmFjdCcgfCAnbnBtJyB8ICdkb25lJyB8ICdlcnJvcic7XG4gIHBjdD86IG51bWJlcjtcbiAgdGV4dDogc3RyaW5nO1xuICBtaXJyb3I/OiBzdHJpbmc7XG4gIGVudHJ5Pzogc3RyaW5nO1xuICBlcnJvcj86IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBJbnN0YWxsT3B0aW9ucyB7XG4gIC8qKiBcdTVGM0FcdTUyMzZcdThENzBcdTgxRUFcdTc4MTQgdGd6IFx1OERFRlx1NUY4NChcdTZENEJcdThCRDUvXHU2NUUwIG5wbSBcdTczQUZcdTU4ODMpXHUzMDAyICovXG4gIGZvcmNlVGd6PzogYm9vbGVhbiB8IHVuZGVmaW5lZDtcbiAgLyoqIFx1OTU1Q1x1NTBDRlx1NEYxOFx1NTE0OFx1N0VBNyhcdTYzNjJcdTZFOTBcdTYzMDlcdTk0QUVcdTdGRkJcdThGNkMpXHUzMDAyICovXG4gIG1pcnJvckZpcnN0PzogJ25wbWpzJyB8ICducG1taXJyb3InIHwgdW5kZWZpbmVkO1xufVxuXG5leHBvcnQgY29uc3QgUkVHSVNUUklFUzogUmVjb3JkPCducG1qcycgfCAnbnBtbWlycm9yJywgc3RyaW5nPiA9IHtcbiAgbnBtanM6ICdodHRwczovL3JlZ2lzdHJ5Lm5wbWpzLm9yZycsXG4gIG5wbW1pcnJvcjogJ2h0dHBzOi8vcmVnaXN0cnkubnBtbWlycm9yLmNvbScsXG59O1xuXG4vKiogXHU1Qjg5XHU4OEM1XHU2ODM5XHU3NkVFXHU1RjU1KFx1NzUyOFx1NjIzN1x1NzZFRVx1NUY1NSxcdTdFRERcdTRFMERcdTUxOTlcdTdDRkJcdTdFREYvXHU1MTY4XHU1QzQwIG5wbSlcdTMwMDIgKi9cbmV4cG9ydCBmdW5jdGlvbiBpbnN0YWxsVGFyZ2V0KCk6IHN0cmluZyB7XG4gIHJldHVybiBqb2luKGhvbWVkaXIoKSwgJy5obWhhcm5lc3MtZ2xvYmFsJyk7XG59XG5cbi8qKiBcdTVCODlcdTg4QzVcdTVCOENcdTYyMTBcdTU0MEVcdTc2ODQgZGVza3RvcC1ob3N0IFx1NTE2NVx1NTNFMyhucG0gXHU1RDRDXHU1OTU3XHU0RTBFXHU2M0QwXHU1MzQ3XHU0RTI0XHU3OUNEXHU1RTAzXHU1QzQwXHU5MEZEXHU4QkE0KVx1MzAwMiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVJbnN0YWxsZWRFbnRyeSh0YXJnZXQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IG5lc3RlZCA9IGpvaW4odGFyZ2V0LCAnbm9kZV9tb2R1bGVzJywgJ0BobWhhcm5lc3MnLCAnY2xpJywgJ25vZGVfbW9kdWxlcycsICdAaG1oYXJuZXNzJywgJ3dlYicsICdkaXN0JywgJ2Rlc2t0b3AtaG9zdC5qcycpO1xuICBjb25zdCBob2lzdGVkID0gam9pbih0YXJnZXQsICdub2RlX21vZHVsZXMnLCAnQGhtaGFybmVzcycsICd3ZWInLCAnZGlzdCcsICdkZXNrdG9wLWhvc3QuanMnKTtcbiAgaWYgKGV4aXN0c1N5bmMobmVzdGVkKSkgcmV0dXJuIG5lc3RlZDtcbiAgaWYgKGV4aXN0c1N5bmMoaG9pc3RlZCkpIHJldHVybiBob2lzdGVkO1xuICByZXR1cm4gJyc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgSW5zdGFsbGVySG9zdCB7XG4gIHNlbmRQcm9ncmVzcyhwOiBJbnN0YWxsUHJvZ3Jlc3MpOiB2b2lkO1xuICBsb2cobXNnOiBzdHJpbmcpOiB2b2lkO1xuICAvKiogXHU1Qjg5XHU4OEM1XHU2MjEwXHU1MjlGKFx1NTE2NVx1NTNFM1x1NURGMlx1OUE4Q1x1OEJDMVx1NUI1OFx1NTcyOClcdTIwMTRcdTIwMTQgbWFpbiBcdTU3MjhcdTZCNjRcdTYzMDFcdTRFNDVcdTUzMTZcdTVFNzZcdTkxQ0RcdTU0MkYgaG9zdFx1MzAwMiAqL1xuICBvbkluc3RhbGxlZChlbnRyeTogc3RyaW5nLCB2aWE6ICducG0nIHwgJ3RneicpOiB2b2lkO1xufVxuXG5sZXQgcnVubmluZyA9IGZhbHNlO1xuXG5leHBvcnQgZnVuY3Rpb24gaW5zdGFsbFJ1bm5pbmcoKTogYm9vbGVhbiB7XG4gIHJldHVybiBydW5uaW5nO1xufVxuXG4vKiogXHU1NDJGXHU1MkE4XHU1Qjg5XHU4OEM1KFx1NTQwRVx1NTNGMFx1NjI2N1x1ODg0QztcdThGREJcdTVFQTYvXHU3RUQzXHU2NzlDXHU1MTY4XHU5MEU4XHU3RUNGXHU0RThCXHU0RUY2XHU1NkRFXHU2RDQxLFByb21pc2UgXHU1M0VBXHU4ODY4XHU4RkJFXCJcdTVERjJcdTUzRDdcdTc0MDZcIilcdTMwMDIgKi9cbmV4cG9ydCBmdW5jdGlvbiBzdGFydENsaUluc3RhbGwoaG9zdDogSW5zdGFsbGVySG9zdCwgb3B0czogSW5zdGFsbE9wdGlvbnMgPSB7fSk6IHsgb2s6IGJvb2xlYW47IGVycm9yPzogc3RyaW5nIH0ge1xuICBpZiAocnVubmluZykgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ1x1NUI4OVx1ODhDNVx1NURGMlx1NTcyOFx1OEZEQlx1ODg0Q1x1NEUyRCcgfTtcbiAgcnVubmluZyA9IHRydWU7XG4gIGNvbnN0IGZpbmlzaCA9IChwOiBJbnN0YWxsUHJvZ3Jlc3MpOiB2b2lkID0+IHtcbiAgICBob3N0LnNlbmRQcm9ncmVzcyhwKTtcbiAgICBydW5uaW5nID0gZmFsc2U7XG4gIH07XG4gIGNvbnN0IGZhaWwgPSAodGV4dDogc3RyaW5nLCBlcnI6IHVua25vd24pOiB2b2lkID0+IHtcbiAgICBob3N0LmxvZyhgaW5zdGFsbCBmYWlsZWQ6ICR7dGV4dH0gJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxODApfWApO1xuICAgIGZpbmlzaCh7IHBoYXNlOiAnZXJyb3InLCB0ZXh0LCBlcnJvcjogYCR7dGV4dH06JHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxNjApfWAgfSk7XG4gIH07XG4gIHZvaWQgKGFzeW5jICgpID0+IHtcbiAgICBjb25zdCB0YXJnZXQgPSBpbnN0YWxsVGFyZ2V0KCk7XG4gICAgdHJ5IHtcbiAgICAgIG1rZGlyU3luYyh0YXJnZXQsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgY29uc3QgbnBtT2sgPSBvcHRzLmZvcmNlVGd6ID09PSB0cnVlID8gZmFsc2UgOiBhd2FpdCBwcm9iZU5wbShob3N0KTtcbiAgICAgIGlmIChucG1PaykgYXdhaXQgaW5zdGFsbFZpYU5wbShob3N0LCB0YXJnZXQsIG9wdHMpO1xuICAgICAgZWxzZSBhd2FpdCBpbnN0YWxsVmlhVGFyYmFsbHMoaG9zdCwgdGFyZ2V0LCBvcHRzKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGZhaWwoJ1x1NUI4OVx1ODhDNVx1NTkzMVx1OEQyNScsIGVycik7XG4gICAgfVxuICB9KSgpO1xuICByZXR1cm4geyBvazogdHJ1ZSB9O1xufVxuXG4vKiAtLS0tIG5wbSBcdTUzRUZcdTc1MjhcdTYwMjcoXHU2Q0U4XHU2MTBGOldpbmRvd3MgXHU0RTBCIHNwYXduKCducG0nKSBcdTUzRUZcdTg4NEMsJ25wbS5jbWQnIFx1NTNDRFx1ODAwQyBFSU5WQUwpIC0tLS0gKi9cbmFzeW5jIGZ1bmN0aW9uIHByb2JlTnBtKGhvc3Q6IEluc3RhbGxlckhvc3QpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgaG9zdC5zZW5kUHJvZ3Jlc3MoeyBwaGFzZTogJ2NoZWNrJywgdGV4dDogJ1x1NjhDMFx1NjdFNSBucG1cdTIwMjYnIH0pO1xuICBjb25zdCBvayA9IGF3YWl0IG5ldyBQcm9taXNlPGJvb2xlYW4+KChyZXNvbHZlKSA9PiB7XG4gICAgY29uc3QgYyA9IHNwYXduKCducG0nLCBbJy0tdmVyc2lvbiddLCB7IHdpbmRvd3NIaWRlOiB0cnVlLCBzdGRpbzogJ2lnbm9yZScgfSk7XG4gICAgY29uc3QgdCA9IHNldFRpbWVvdXQoKCkgPT4geyB0cnkgeyBjLmtpbGwoKTsgfSBjYXRjaCB7IC8qIG5vb3AgKi8gfSByZXNvbHZlKGZhbHNlKTsgfSwgMTVfMDAwKTtcbiAgICBjLm9uKCdlcnJvcicsICgpID0+IHsgY2xlYXJUaW1lb3V0KHQpOyByZXNvbHZlKGZhbHNlKTsgfSk7XG4gICAgYy5vbignZXhpdCcsIChjb2RlKSA9PiB7IGNsZWFyVGltZW91dCh0KTsgcmVzb2x2ZShjb2RlID09PSAwKTsgfSk7XG4gIH0pO1xuICBob3N0LmxvZyhgbnBtICR7b2sgPyAnYXZhaWxhYmxlJyA6ICd1bmF2YWlsYWJsZSd9IFx1MjE5MiAke29rID8gJ25wbSBwcmVmaXgnIDogJ3Rneid9IHBhdGhgKTtcbiAgcmV0dXJuIG9rO1xufVxuXG4vKiAtLS0tIFx1OERFRlx1NUY4NCBBOm5wbSAtLXByZWZpeChcdTVCODlcdTg4QzVcdTZCNjVcdTlBQTRcdTY1ODdcdTY4NDggPSBucG0gXHU4RjkzXHU1MUZBXHU4ODRDKSAtLS0tICovXG5hc3luYyBmdW5jdGlvbiBpbnN0YWxsVmlhTnBtKGhvc3Q6IEluc3RhbGxlckhvc3QsIHRhcmdldDogc3RyaW5nLCBvcHRzOiBJbnN0YWxsT3B0aW9ucyk6IFByb21pc2U8dm9pZD4ge1xuICBob3N0LnNlbmRQcm9ncmVzcyh7IHBoYXNlOiAnbnBtJywgdGV4dDogYG5wbSBpbnN0YWxsIEBobWhhcm5lc3MvY2xpIFx1MjE5MiAke3RhcmdldH0oXHU0RUM1XHU3NTI4XHU2MjM3XHU3NkVFXHU1RjU1KWAgfSk7XG4gIGNvbnN0IHJlZ2lzdHJ5ID0gb3B0cy5taXJyb3JGaXJzdCA9PT0gJ25wbW1pcnJvcicgPyBbJy0tcmVnaXN0cnknLCBSRUdJU1RSSUVTLm5wbW1pcnJvcl0gOiBvcHRzLm1pcnJvckZpcnN0ID09PSAnbnBtanMnID8gWyctLXJlZ2lzdHJ5JywgUkVHSVNUUklFUy5ucG1qc10gOiBbXTtcbiAgY29uc3QgYXJncyA9IFsnaW5zdGFsbCcsICctLXByZWZpeCcsIHRhcmdldCwgJy0tbm8tYXVkaXQnLCAnLS1uby1mdW5kJywgJy0tbG9nbGV2ZWwnLCAnbm90aWNlJywgLi4ucmVnaXN0cnksICdAaG1oYXJuZXNzL2NsaUBsYXRlc3QnXTtcbiAgY29uc3QgY29kZSA9IGF3YWl0IG5ldyBQcm9taXNlPG51bWJlcj4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgIGNvbnN0IGMgPSBzcGF3bignbnBtJywgYXJncywgeyB3aW5kb3dzSGlkZTogdHJ1ZSwgY3dkOiBob21lZGlyKCkgfSk7XG4gICAgbGV0IGxhc3QgPSAnJztcbiAgICBjb25zdCBvbkxpbmUgPSAoZDogQnVmZmVyKTogdm9pZCA9PiB7XG4gICAgICBmb3IgKGNvbnN0IHJhdyBvZiBkLnRvU3RyaW5nKCkuc3BsaXQoL1xccj9cXG4vKSkge1xuICAgICAgICBjb25zdCBsaW5lID0gcmF3LnJlcGxhY2UoL1tcXHUwMDAwLVxcdTAwMWZdL2csICcnKS50cmltKCkuc2xpY2UoMCwgMTgwKTtcbiAgICAgICAgaWYgKGxpbmUgPT09ICcnIHx8IGxpbmUgPT09IGxhc3QpIGNvbnRpbnVlO1xuICAgICAgICBsYXN0ID0gbGluZTtcbiAgICAgICAgaG9zdC5zZW5kUHJvZ3Jlc3MoeyBwaGFzZTogJ25wbScsIHRleHQ6IGxpbmUgfSk7XG4gICAgICB9XG4gICAgfTtcbiAgICBjLnN0ZG91dD8ub24oJ2RhdGEnLCBvbkxpbmUpO1xuICAgIGMuc3RkZXJyPy5vbignZGF0YScsIG9uTGluZSk7XG4gICAgYy5vbignZXJyb3InLCByZWplY3QpO1xuICAgIGNvbnN0IGtpbGxlciA9IHNldFRpbWVvdXQoKCkgPT4geyB0cnkgeyBjLmtpbGwoKTsgfSBjYXRjaCB7IC8qIG5vb3AgKi8gfSByZWplY3QobmV3IEVycm9yKCducG0gXHU1Qjg5XHU4OEM1XHU4RDg1XHU2NUY2KDggXHU1MjA2XHU5NDlGKScpKTsgfSwgOCAqIDYwXzAwMCk7XG4gICAgYy5vbignZXhpdCcsICh4KSA9PiB7IGNsZWFyVGltZW91dChraWxsZXIpOyByZXNvbHZlKHggPz8gMSk7IH0pO1xuICB9KTtcbiAgaWYgKGNvZGUgIT09IDApIHRocm93IG5ldyBFcnJvcihgbnBtIGluc3RhbGwgXHU5MDAwXHU1MUZBXHU3ODAxICR7Y29kZX1gKTtcbiAgY29uc3QgZW50cnkgPSByZXNvbHZlSW5zdGFsbGVkRW50cnkodGFyZ2V0KTtcbiAgaWYgKGVudHJ5ID09PSAnJykgdGhyb3cgbmV3IEVycm9yKCducG0gXHU1Qjg5XHU4OEM1XHU1QjhDXHU2MjEwXHU0RjQ2XHU2NzJBXHU2MjdFXHU1MjMwIGRlc2t0b3AtaG9zdCBcdTUxNjVcdTUzRTMnKTtcbiAgd3JpdGVTdGFtcCh0YXJnZXQsICducG0nKTtcbiAgZmluaXNoSW5zdGFsbChob3N0LCBlbnRyeSwgJ25wbScpO1xufVxuXG4vKiAtLS0tIFx1OERFRlx1NUY4NCBCOlx1ODFFQVx1NzgxNCB0Z3ooXHU3NzFGXHU0RTBCXHU4RjdEXHU4RkRCXHU1RUE2ICsgXHU5NTVDXHU1MENGXHU1NkRFXHU5MDAwICsgaW50ZWdyaXR5ICsgdGFyIFx1ODlFM1x1NTM4QikgLS0tLSAqL1xuYXN5bmMgZnVuY3Rpb24gaW5zdGFsbFZpYVRhcmJhbGxzKGhvc3Q6IEluc3RhbGxlckhvc3QsIHRhcmdldDogc3RyaW5nLCBvcHRzOiBJbnN0YWxsT3B0aW9ucyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBvcmRlcjogQXJyYXk8J25wbWpzJyB8ICducG1taXJyb3InPiA9IG9wdHMubWlycm9yRmlyc3QgPT09ICducG1taXJyb3InID8gWyducG1taXJyb3InLCAnbnBtanMnXSA6IFsnbnBtanMnLCAnbnBtbWlycm9yJ107XG4gIGNvbnN0IG1pcnJvcnMgPSBvcmRlci5tYXAoKGspID0+IFJFR0lTVFJJRVNba10pO1xuICBob3N0LnNlbmRQcm9ncmVzcyh7IHBoYXNlOiAnbWV0YScsIHRleHQ6ICdcdTg5RTNcdTY3OTBcdTRGOURcdThENTZcdTZFMDVcdTUzNTUoQGhtaGFybmVzcy9jbGkgXHU1MTY4XHU1QkI2KVx1MjAyNicgfSk7XG5cbiAgY29uc3QgcGFja3VtZW50cyA9IG5ldyBNYXA8c3RyaW5nLCBQYWNrdW1lbnQ+KCk7XG4gIGNvbnN0IGdldFBhY2t1bWVudCA9IGFzeW5jIChuYW1lOiBzdHJpbmcpOiBQcm9taXNlPFBhY2t1bWVudD4gPT4ge1xuICAgIGNvbnN0IGhpdCA9IHBhY2t1bWVudHMuZ2V0KG5hbWUpO1xuICAgIGlmIChoaXQgIT09IHVuZGVmaW5lZCkgcmV0dXJuIGhpdDtcbiAgICBsZXQgbGFzdEVyciA9ICcnO1xuICAgIGZvciAoY29uc3QgbSBvZiBtaXJyb3JzKSB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCByID0gYXdhaXQgZmV0Y2goYCR7bX0vJHtlbmNvZGVVUklDb21wb25lbnQobmFtZSl9YCwge1xuICAgICAgICAgIGhlYWRlcnM6IHsgYWNjZXB0OiAnYXBwbGljYXRpb24vdm5kLm5wbS5pbnN0YWxsLXYxK2pzb24nIH0sXG4gICAgICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDI1XzAwMCksXG4gICAgICAgIH0pO1xuICAgICAgICBpZiAoIXIub2spIHsgbGFzdEVyciA9IGBIVFRQICR7ci5zdGF0dXN9YDsgY29udGludWU7IH1cbiAgICAgICAgY29uc3QgZG9jID0gKGF3YWl0IHIuanNvbigpKSBhcyBQYWNrdW1lbnQ7XG4gICAgICAgIGlmIChkb2MudmVyc2lvbnMgPT09IHVuZGVmaW5lZCkgeyBsYXN0RXJyID0gJ21hbGZvcm1lZCBwYWNrdW1lbnQnOyBjb250aW51ZTsgfVxuICAgICAgICBwYWNrdW1lbnRzLnNldChuYW1lLCBkb2MpO1xuICAgICAgICByZXR1cm4gZG9jO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7IGxhc3RFcnIgPSBTdHJpbmcoZXJyKS5zbGljZSgwLCA2MCk7IH1cbiAgICB9XG4gICAgdGhyb3cgbmV3IEVycm9yKGBcdTgzQjdcdTUzRDYgJHtuYW1lfSBcdTUxNDNcdTY1NzBcdTYzNkVcdTU5MzFcdThEMjUoXHU1MTY4XHU5MEU4XHU5NTVDXHU1MENGOiR7bGFzdEVycn0pYCk7XG4gIH07XG5cbiAgY29uc3QgY2xvc3VyZSA9IGF3YWl0IHJlc29sdmVDbG9zdXJlKHsgbmFtZTogJ0BobWhhcm5lc3MvY2xpJywgc3BlYzogJ2xhdGVzdCcgfSwgZ2V0UGFja3VtZW50KTtcbiAgY29uc3Qgcm9vdCA9IGNsb3N1cmUuZmluZCgocCkgPT4gcC5uYW1lID09PSAnQGhtaGFybmVzcy9jbGknKTtcbiAgaG9zdC5sb2coYGNsb3N1cmU6ICR7Y2xvc3VyZS5sZW5ndGh9IHBhY2thZ2VzIChyb290IEBobWhhcm5lc3MvY2xpQCR7cm9vdD8udmVyc2lvbiA/PyAnPyd9KWApO1xuICBob3N0LnNlbmRQcm9ncmVzcyh7IHBoYXNlOiAnbWV0YScsIHRleHQ6IGBcdTRGOURcdThENTZcdTZFMDVcdTUzNTVcdTVDMzFcdTdFRUE6JHtjbG9zdXJlLmxlbmd0aH0gXHU0RTJBXHU1MzA1KEBobWhhcm5lc3MvY2xpQCR7cm9vdD8udmVyc2lvbiA/PyAnPyd9KWAgfSk7XG5cbiAgY29uc3Qgc3RhZ2luZyA9IGpvaW4odGFyZ2V0LCAnLnN0YWdpbmcnKTtcbiAgcm1TeW5jKHN0YWdpbmcsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgbWtkaXJTeW5jKHN0YWdpbmcsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gIGZvciAobGV0IGkgPSAwOyBpIDwgY2xvc3VyZS5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IHBrZyA9IGNsb3N1cmVbaV0hO1xuICAgIGNvbnN0IHVybHMgPSB0YXJiYWxsTWlycm9ycyhwa2cudGFyYmFsbCwgbWlycm9ycyk7XG4gICAgbGV0IGJ1ZjogQnVmZmVyIHwgbnVsbCA9IG51bGw7XG4gICAgbGV0IHVzZWRNaXJyb3IgPSAnJztcbiAgICBsZXQgbGFzdEVyciA9ICcnO1xuICAgIGZvciAoY29uc3QgdSBvZiB1cmxzKSB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCByID0gYXdhaXQgZmV0Y2godSwgeyBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoMzAwXzAwMCkgfSk7XG4gICAgICAgIGlmICghci5vaykgeyBsYXN0RXJyID0gYEhUVFAgJHtyLnN0YXR1c31gOyBjb250aW51ZTsgfVxuICAgICAgICBjb25zdCB0b3RhbCA9IE51bWJlcihyLmhlYWRlcnMuZ2V0KCdjb250ZW50LWxlbmd0aCcpID8/ICcwJyk7XG4gICAgICAgIGNvbnN0IHJlYWRlciA9IHIuYm9keT8uZ2V0UmVhZGVyKCk7XG4gICAgICAgIGlmIChyZWFkZXIgPT09IHVuZGVmaW5lZCkgdGhyb3cgbmV3IEVycm9yKCdubyBib2R5Jyk7XG4gICAgICAgIGNvbnN0IGNodW5rczogQnVmZmVyW10gPSBbXTtcbiAgICAgICAgbGV0IGdvdCA9IDA7XG4gICAgICAgIGxldCBsYXN0RW1pdCA9IDA7XG4gICAgICAgIGZvciAoOzspIHtcbiAgICAgICAgICBjb25zdCB7IGRvbmUsIHZhbHVlIH0gPSBhd2FpdCByZWFkZXIucmVhZCgpO1xuICAgICAgICAgIGlmIChkb25lID09PSB0cnVlKSBicmVhaztcbiAgICAgICAgICBjb25zdCBiID0gQnVmZmVyLmZyb20odmFsdWUpO1xuICAgICAgICAgIGNodW5rcy5wdXNoKGIpO1xuICAgICAgICAgIGdvdCArPSBiLmxlbmd0aDtcbiAgICAgICAgICBpZiAoZ290IC0gbGFzdEVtaXQgPiAyNTYgKiAxMDI0KSB7XG4gICAgICAgICAgICBsYXN0RW1pdCA9IGdvdDtcbiAgICAgICAgICAgIGhvc3Quc2VuZFByb2dyZXNzKHtcbiAgICAgICAgICAgICAgcGhhc2U6ICdkb3dubG9hZCcsXG4gICAgICAgICAgICAgIHBjdDogTWF0aC5yb3VuZCgoKGkgKyBNYXRoLm1pbihnb3QgLyAodG90YWwgfHwgZ290KSwgMSkpIC8gY2xvc3VyZS5sZW5ndGgpICogMTAwKSxcbiAgICAgICAgICAgICAgdGV4dDogYFx1NEUwQlx1OEY3RCAke3BrZy5uYW1lfUAke3BrZy52ZXJzaW9ufSgke2kgKyAxfS8ke2Nsb3N1cmUubGVuZ3RofSlcdTAwQjcgJHtieXRlc0xhYmVsKGdvdCl9JHt0b3RhbCA+IDAgPyBgIC8gJHtieXRlc0xhYmVsKHRvdGFsKX1gIDogJyd9YCxcbiAgICAgICAgICAgICAgbWlycm9yOiBuZXcgVVJMKHUpLmhvc3QsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgYnVmID0gQnVmZmVyLmNvbmNhdChjaHVua3MpO1xuICAgICAgICBpZiAoIWludGVncml0eU9rKGJ1ZiwgcGtnLmludGVncml0eSkpIHsgbGFzdEVyciA9ICdpbnRlZ3JpdHkgXHU0RTBEXHU1MzM5XHU5MTREJzsgYnVmID0gbnVsbDsgY29udGludWU7IH1cbiAgICAgICAgdXNlZE1pcnJvciA9IG5ldyBVUkwodSkuaG9zdDtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgbGFzdEVyciA9IFN0cmluZyhlcnIpLnNsaWNlKDAsIDYwKTtcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKGJ1ZiA9PT0gbnVsbCkgdGhyb3cgbmV3IEVycm9yKGBcdTRFMEJcdThGN0QgJHtwa2cubmFtZX0gXHU1OTMxXHU4RDI1KFx1NTE2OFx1OTBFOFx1OTU1Q1x1NTBDRjoke2xhc3RFcnJ9KWApO1xuICAgIGNvbnN0IHRneiA9IGpvaW4oc3RhZ2luZywgYCR7aX0udGd6YCk7XG4gICAgd3JpdGVGaWxlU3luYyh0Z3osIGJ1Zik7XG4gICAgaG9zdC5zZW5kUHJvZ3Jlc3Moe1xuICAgICAgcGhhc2U6ICdkb3dubG9hZCcsXG4gICAgICBwY3Q6IE1hdGgucm91bmQoKChpICsgMSkgLyBjbG9zdXJlLmxlbmd0aCkgKiAxMDApLFxuICAgICAgdGV4dDogYFx1NEUwQlx1OEY3RCAke3BrZy5uYW1lfUAke3BrZy52ZXJzaW9ufSBcdTVCOENcdTYyMTAoJHtieXRlc0xhYmVsKGJ1Zi5sZW5ndGgpfSx2aWEgJHt1c2VkTWlycm9yfSlgLFxuICAgICAgbWlycm9yOiB1c2VkTWlycm9yLFxuICAgIH0pO1xuICB9XG5cbiAgaG9zdC5zZW5kUHJvZ3Jlc3MoeyBwaGFzZTogJ2V4dHJhY3QnLCB0ZXh0OiAnXHU4OUUzXHU1MzhCXHU1RTc2XHU1RTAzXHU1QzQwIG5vZGVfbW9kdWxlc1x1MjAyNicgfSk7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgY2xvc3VyZS5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IHBrZyA9IGNsb3N1cmVbaV0hO1xuICAgIGF3YWl0IGV4dHJhY3RUZ3ooam9pbihzdGFnaW5nLCBgJHtpfS50Z3pgKSwgc3RhZ2luZywgcGtnKTtcbiAgICBob3N0LnNlbmRQcm9ncmVzcyh7IHBoYXNlOiAnZXh0cmFjdCcsIHBjdDogTWF0aC5yb3VuZCgoKGkgKyAxKSAvIGNsb3N1cmUubGVuZ3RoKSAqIDEwMCksIHRleHQ6IGBcdTg5RTNcdTUzOEIgJHtwa2cubmFtZX0oJHtpICsgMX0vJHtjbG9zdXJlLmxlbmd0aH0pYCB9KTtcbiAgfVxuICBybVN5bmMoc3RhZ2luZywgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuXG4gIGNvbnN0IGVudHJ5ID0gcmVzb2x2ZUluc3RhbGxlZEVudHJ5KHRhcmdldCk7XG4gIGlmIChlbnRyeSA9PT0gJycpIHRocm93IG5ldyBFcnJvcigndGd6IFx1NUI4OVx1ODhDNVx1NUI4Q1x1NjIxMFx1NEY0Nlx1NjcyQVx1NjI3RVx1NTIzMCBkZXNrdG9wLWhvc3QgXHU1MTY1XHU1M0UzJyk7XG4gIHdyaXRlU3RhbXAodGFyZ2V0LCAndGd6Jyk7XG4gIGZpbmlzaEluc3RhbGwoaG9zdCwgZW50cnksICd0Z3onKTtcbn1cblxuLyoqIHRhci5leGUoV2luMTArIFx1ODFFQVx1NUUyNilcdTg5RTNcdTUzOEIgdGd6IFx1NTIzMCBleERpcixcdTUxOERcdTYyOEEgcGFja2FnZS8gXHU2MzJBXHU1MjMwIG5vZGVfbW9kdWxlcyBcdTVFMDNcdTVDNDBcdTMwMDIgKi9cbmFzeW5jIGZ1bmN0aW9uIGV4dHJhY3RUZ3oodGd6OiBzdHJpbmcsIHN0YWdpbmc6IHN0cmluZywgcGtnOiBSZXNvbHZlZFBrZyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBleERpciA9IGpvaW4oc3RhZ2luZywgYHgtJHtwa2cubmFtZS5yZXBsYWNlKC9bXlxcdy4tXS9nLCAnXycpfWApO1xuICBybVN5bmMoZXhEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgbWtkaXJTeW5jKGV4RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgY29uc3QgY29kZSA9IGF3YWl0IG5ldyBQcm9taXNlPG51bWJlcj4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgIGNvbnN0IGMgPSBzcGF3bigndGFyJywgWycteHpmJywgdGd6LCAnLUMnLCBleERpcl0sIHsgd2luZG93c0hpZGU6IHRydWUsIHN0ZGlvOiAnaWdub3JlJyB9KTtcbiAgICBjLm9uKCdlcnJvcicsIHJlamVjdCk7XG4gICAgYy5vbignZXhpdCcsICh4KSA9PiByZXNvbHZlKHggPz8gMSkpO1xuICB9KTtcbiAgaWYgKGNvZGUgIT09IDApIHRocm93IG5ldyBFcnJvcihgdGFyIFx1ODlFM1x1NTM4QiAke3BrZy5uYW1lfSBcdTU5MzFcdThEMjUoXHU5MDAwXHU1MUZBXHU3ODAxICR7Y29kZX0pYCk7XG4gIGNvbnN0IGRlc3QgPSBtb2R1bGVEaXIoaW5zdGFsbFRhcmdldCgpLCBwa2cubmFtZSk7XG4gIGNvbnN0IHBhcmVudCA9IGRlc3Quc2xpY2UoMCwgZGVzdC5sYXN0SW5kZXhPZignXFxcXCcpKTtcbiAgbWtkaXJTeW5jKHBhcmVudCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHJtU3luYyhkZXN0LCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIHJlbmFtZVN5bmMoam9pbihleERpciwgJ3BhY2thZ2UnKSwgZGVzdCk7XG4gIHJtU3luYyhleERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xufVxuXG4vKiogXHU1Qjg5XHU4OEM1XHU2MjMzKFx1NTQxMVx1NUJGQ1x1NUI4Q1x1NjIxMFx1OTg3NS9cdThCQkVcdTdGNkVcdTk3NjJcdTY3N0ZcdTVDNTVcdTc5M0FcdTVCODlcdTg4QzVcdTY1QjlcdTVGMEZcdTRFMEVcdTY1RjZcdTk1RjQ7XHU0RTBEXHU2MjdGXHU4RjdEXHU4RkQwXHU4ODRDXHU2NUY2XHU5MDNCXHU4RjkxKVx1MzAwMiAqL1xuZnVuY3Rpb24gd3JpdGVTdGFtcCh0YXJnZXQ6IHN0cmluZywgdmlhOiAnbnBtJyB8ICd0Z3onKTogdm9pZCB7XG4gIHRyeSB7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHRhcmdldCwgJ2luc3RhbGxlZC1ieS1obWgtZGVza3RvcC5qc29uJyksIEpTT04uc3RyaW5naWZ5KHsgdmlhLCBhdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpIH0sIG51bGwsIDIpLCAndXRmOCcpO1xuICB9IGNhdGNoIHsgLyogYmVzdCBlZmZvcnQgKi8gfVxufVxuXG5mdW5jdGlvbiBmaW5pc2hJbnN0YWxsKGhvc3Q6IEluc3RhbGxlckhvc3QsIGVudHJ5OiBzdHJpbmcsIHZpYTogJ25wbScgfCAndGd6Jyk6IHZvaWQge1xuICBob3N0LmxvZyhgaW5zdGFsbCBkb25lIHZpYSAke3ZpYX06ICR7ZW50cnl9YCk7XG4gIGhvc3Quc2VuZFByb2dyZXNzKHsgcGhhc2U6ICdkb25lJywgdGV4dDogYFx1NUI4OVx1ODhDNVx1NUI4Q1x1NjIxMCgke3ZpYX0pYCwgZW50cnkgfSk7XG4gIGhvc3Qub25JbnN0YWxsZWQoZW50cnksIHZpYSk7XG4gIHJ1bm5pbmcgPSBmYWxzZTtcbn1cbiIsICIvKipcbiAqIEBobWhhcm5lc3MvY2xpIFx1NUI4OVx1ODhDNVx1NjgzOFx1NUZDMyhcdTdFQUZcdTkwM0JcdThGOTEsXHU5NkY2IElPIFx1MjAxNFx1MjAxNCBmZXRjaC9cdTg5RTNcdTUzOEIvXHU4NDNEXHU3NkQ4XHU1NzI4XHU0RTNCXHU4RkRCXHU3QTBCIGluc3RhbGxlciBcdTkxQ0MpXHUzMDAyXG4gKlxuICogXHU4MDRDXHU4RDIzKHY1LjEgXHU1Qjg5XHU4OEM1XHU1NDExXHU1QkZDKTpcdTdFRDlcdTVCOUEgcmVnaXN0cnkgXHU1MTQzXHU2NTcwXHU2MzZFXHU4M0I3XHU1M0Q2XHU1MUZEXHU2NTcwLFx1ODlFM1x1Njc5MCBAaG1oYXJuZXNzL2NsaSBcdTc2ODRcbiAqIFx1NUI4Q1x1NjU3NFx1NEY5RFx1OEQ1Nlx1OTVFRFx1NTMwNShAaG1oYXJuZXNzLyogXHU1MTY4XHU1QkI2XHU0RTNBXHU3Q0JFXHU3ODZFXHU3MjQ4XHU2NzJDXHU0RTkyXHU5NDg5O1x1NTkxNlx1OTBFOFx1NEY5RFx1OEQ1NiBxcmNvZGUgXHU5NEZFXHU0RTNBIF4gXHU4MzAzXHU1NkY0KSxcbiAqIFx1NEVBN1x1NTFGQVwiXHU4OEM1XHU0RUMwXHU0RTQ4XHUzMDAxXHU0RUNFXHU1NEVBXHU0RTlCXHU5NTVDXHU1MENGXHU0RTBCXHUzMDAxXHU4OEM1XHU1MjMwXHU1NEVBXCJcdTc2ODRcdTc4NkVcdTVCOUFcdTYwMjdcdThCQTFcdTUyMTJcdTMwMDJcdThCQkVcdThCQTFcdTdFQTZcdTY3NUY6XG4gKiAgLSBcdTk1RURcdTUzMDVcdTYzMDlcdTUzMDVcdTU0MERcdTUzQkJcdTkxQ0QoXHU5NEJCXHU3N0YzXHU0RjlEXHU4RDU2XHU1M0VBXHU4OEM1XHU0RTAwXHU0RUZELG5wbSBcdThCRURcdTRFNDkpO1xuICogIC0gXHU4MzAzXHU1NkY0XHU4OUUzXHU2NzkwXHU1M0VBXHU2NTJGXHU2MzAxIG5wbSBcdTc1MUZcdTYwMDFcdTVCOUVcdTk2NDVcdTc1MjhcdTUyMzBcdTc2ODRcdTVGNjJcdTYwMDE6XHU3Q0JFXHU3ODZFIC8gbGF0ZXN0IC8gKiAvIF4gLyB+IC8gPj0sXG4gKiAgICBcdTRFMERcdTVGMTUgc2VtdmVyIFx1NUU5MyhcdTk2RjZcdTRGOURcdThENTZcdTUzOUZcdTUyMTksXHU0RTBFXHU4MUVBXHU3ODE0XHU2NkY0XHU2NUIwXHU1NjY4XHU0RTAwXHU4MUY0KTtcbiAqICAtIG9wdGlvbmFsRGVwZW5kZW5jaWVzIFx1NEUwRFx1ODhDNTpcdTk1RURcdTUzMDVcdTUxODVcdTVCOUVcdTk2NDVcdTU4RjBcdTY2MEVcdTc2ODQgb3B0aW9uYWwgXHU1NzQ3XHU0RTNBXHU1RTczXHU1M0YwXHU3Mjc5XHU1QjlBXG4gKiAgICAoZnNldmVudHMgXHU3QjQ5KSx0Z3ogXHU4REVGXHU1Rjg0XHU0RTBEXHU4REQxXHU3NTFGXHU1NDdEXHU1NDY4XHU2NzFGXHU4MTFBXHU2NzJDLFx1ODhDNVx1NEU4Nlx1NEU1Rlx1NTNFQVx1NjYyRlx1NkI3Qlx1OTFDRFx1MzAwMlxuICovXG5pbXBvcnQgeyBjcmVhdGVIYXNoIH0gZnJvbSAnbm9kZTpjcnlwdG8nO1xuXG5leHBvcnQgaW50ZXJmYWNlIFBrZ1ZlcnNpb25NZXRhIHtcbiAgdmVyc2lvbjogc3RyaW5nO1xuICBkZXBlbmRlbmNpZXM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG4gIHRhcmJhbGw6IHN0cmluZztcbiAgaW50ZWdyaXR5Pzogc3RyaW5nIHwgdW5kZWZpbmVkO1xufVxuXG4vKiogcmVnaXN0cnkgcGFja3VtZW50IFx1NzY4NFx1NjcwMFx1NUMwRlx1OEJGQlx1NTNENlx1OTc2MihkaXN0LXRhZ3MgKyBcdTUxNjhcdTcyNDhcdTY3MkNcdTRGOURcdThENTYvdGFyYmFsbCBcdTUxNDNcdTY1NzBcdTYzNkUpXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIFBhY2t1bWVudCB7XG4gICdkaXN0LXRhZ3MnOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuICB2ZXJzaW9uczogUmVjb3JkPHN0cmluZywgeyBkZXBlbmRlbmNpZXM/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IHwgdW5kZWZpbmVkOyBkaXN0PzogeyB0YXJiYWxsPzogc3RyaW5nOyBpbnRlZ3JpdHk/OiBzdHJpbmcgfCB1bmRlZmluZWQgfSB8IHVuZGVmaW5lZCB9Pjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBSZXNvbHZlZFBrZyB7XG4gIG5hbWU6IHN0cmluZztcbiAgdmVyc2lvbjogc3RyaW5nO1xuICAvKiogcmVnaXN0cnkgXHU1MzlGXHU1OUNCXHU1NzMwXHU1NzQwKFx1OTU1Q1x1NTBDRlx1NTIxN1x1ODg2OFx1NzUzMSB0YXJiYWxsTWlycm9ycyBcdTZEM0VcdTc1MUYpXHUzMDAyICovXG4gIHRhcmJhbGw6IHN0cmluZztcbiAgaW50ZWdyaXR5Pzogc3RyaW5nIHwgdW5kZWZpbmVkO1xufVxuXG4vKiAtLS0tIHNlbXZlcihcdTY3MDBcdTVDMEZcdTVCOUVcdTczQjA6XHU5NUVEXHU1MzA1XHU1MTg1XHU1QjlFXHU5NjQ1XHU1MUZBXHU3M0IwXHU3Njg0XHU1RjYyXHU2MDAxKSAtLS0tICovXG5cbmV4cG9ydCBmdW5jdGlvbiBjbXBTZW12ZXIoYTogc3RyaW5nLCBiOiBzdHJpbmcpOiBudW1iZXIge1xuICBjb25zdCBwYSA9IGEucmVwbGFjZSgvXnYvLCAnJykuc3BsaXQoJy0nKVswXSEuc3BsaXQoJy4nKS5tYXAoTnVtYmVyKTtcbiAgY29uc3QgcGIgPSBiLnJlcGxhY2UoL152LywgJycpLnNwbGl0KCctJylbMF0hLnNwbGl0KCcuJykubWFwKE51bWJlcik7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgMzsgaSsrKSB7XG4gICAgY29uc3QgeCA9IHBhW2ldID8/IDA7XG4gICAgY29uc3QgeSA9IHBiW2ldID8/IDA7XG4gICAgaWYgKHggIT09IHkpIHJldHVybiB4IDwgeSA/IC0xIDogMTtcbiAgfVxuICByZXR1cm4gMDtcbn1cblxuLyoqIHJhbmdlIFx1NjYyRlx1NTQyNlx1NjNBNVx1NTNENyB2ZXJzaW9uKFx1NjUyRlx1NjMwMSBcdTdDQkVcdTc4NkUgLyBsYXRlc3QgLyAqIC8geCAvIF4gLyB+IC8gPj07XHU0RTBEXHU4QkM2XHU1MjJCXHU1MjE5IGZhbHNlKVx1MzAwMiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNhdGlzZmllcyhyYW5nZTogc3RyaW5nLCB2ZXJzaW9uOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgciA9IHJhbmdlLnRyaW0oKTtcbiAgaWYgKHIgPT09ICcnIHx8IHIgPT09ICcqJyB8fCByID09PSAnbGF0ZXN0JyB8fCByID09PSAneCcpIHJldHVybiB0cnVlO1xuICBpZiAociA9PT0gdmVyc2lvbikgcmV0dXJuIHRydWU7XG4gIGNvbnN0IGJvdW5kID0gL14oXFxefH58Pj0/KVxccyooXFxkKylcXC4oXFxkKylcXC4oXFxkKykvLmV4ZWMocik7XG4gIGlmIChib3VuZCAhPT0gbnVsbCkge1xuICAgIGNvbnN0IG9wID0gYm91bmRbMV0hO1xuICAgIGNvbnN0IG1ham9yID0gTnVtYmVyKGJvdW5kWzJdKTtcbiAgICBjb25zdCBtaW5vciA9IE51bWJlcihib3VuZFszXSk7XG4gICAgY29uc3QgcGF0Y2ggPSBOdW1iZXIoYm91bmRbNF0pO1xuICAgIGNvbnN0IGMgPSBjbXBTZW12ZXIodmVyc2lvbiwgYCR7bWFqb3J9LiR7bWlub3J9LiR7cGF0Y2h9YCk7XG4gICAgaWYgKGMgPCAwKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKG9wID09PSAnPj0nKSByZXR1cm4gdHJ1ZTsgLy8gJz49JyBcdTRFMEJcdTc1NENcdTUzNzNcdTUzRUY6XHU5NUVEXHU1MzA1XHU1MTg1XHU1M0VBXHU0RUU1ICc+PXgueS56IDx6JyBcdTU5MERcdTU0MDhcdTVGNjJcdTYwMDFcdTUxRkFcdTczQjAsXHU0RkREXHU1Qjg4XHU1M0Q2XHU0RTBCXHU3NTRDXG4gICAgaWYgKG9wID09PSAnficpIHJldHVybiBjbXBTZW12ZXIodmVyc2lvbiwgYCR7bWFqb3J9LiR7bWlub3IgKyAxfS4wYCkgPCAwO1xuICAgIC8vICdeJzowLnggXHU3Mjc5XHU1MjI0KDAuMi4zIFx1NTE0MVx1OEJCOCAwLjIueiksXHU1MTc2XHU0RjU5XHU5NTAxXHU0RTNCXHU3MjQ4XHU2NzJDXG4gICAgaWYgKG1ham9yID09PSAwKSByZXR1cm4gbWlub3IgPT09IDAgPyBjbXBTZW12ZXIodmVyc2lvbiwgYDAuMC4ke3BhdGNoICsgMX1gKSA8IDAgOiBjbXBTZW12ZXIodmVyc2lvbiwgYDAuJHttaW5vciArIDF9LjBgKSA8IDA7XG4gICAgcmV0dXJuIGNtcFNlbXZlcih2ZXJzaW9uLCBgJHttYWpvciArIDF9LjAuMGApIDwgMDtcbiAgfVxuICByZXR1cm4gZmFsc2U7XG59XG5cbi8qKiBcdTRFQ0UgcGFja3VtZW50IFx1OTAwOVx1NTFGQSBzcGVjKFx1N0NCRVx1Nzg2RS9sYXRlc3QvXi9+LyopXHU2MzA3XHU1NDExXHU3Njg0XHU3MjQ4XHU2NzJDO1x1NjVFMFx1NTMzOVx1OTE0RFx1OEZENFx1NTZERSAnJ1x1MzAwMiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBpY2tWZXJzaW9uKGRvYzogUGFja3VtZW50LCBzcGVjOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBzID0gc3BlYy50cmltKCk7XG4gIGNvbnN0IHRhZyA9IHMgPT09ICcnIHx8IHMgPT09ICdsYXRlc3QnIHx8IHMgPT09ICcqJyA/IGRvY1snZGlzdC10YWdzJ10/LmxhdGVzdCA6IHVuZGVmaW5lZDtcbiAgaWYgKHRhZyAhPT0gdW5kZWZpbmVkICYmIGRvYy52ZXJzaW9uc1t0YWddICE9PSB1bmRlZmluZWQpIHJldHVybiB0YWc7XG4gIGlmIChkb2MudmVyc2lvbnNbc10gIT09IHVuZGVmaW5lZCkgcmV0dXJuIHM7XG4gIGxldCBiZXN0ID0gJyc7XG4gIGZvciAoY29uc3QgdiBvZiBPYmplY3Qua2V5cyhkb2MudmVyc2lvbnMpKSB7XG4gICAgaWYgKHNhdGlzZmllcyhzLCB2KSAmJiBjbXBTZW12ZXIodiwgYmVzdCkgPiAwKSBiZXN0ID0gdjtcbiAgfVxuICByZXR1cm4gYmVzdDtcbn1cblxuLyogLS0tLSBcdTRGOURcdThENTZcdTk1RURcdTUzMDUgLS0tLSAqL1xuXG4vKipcbiAqIFx1ODlFM1x1Njc5MCByb290IFx1NTNDQVx1NTE3Nlx1NTE2OFx1OTBFOFx1NEYyMFx1OTAxMlx1NEY5RFx1OEQ1NihCRlMsXHU2MzA5XHU1MzA1XHU1NDBEXHU1M0JCXHU5MUNEXHU1M0Q2XHU5OTk2XHU0RTJBXHU4OUUzXHU2NzkwXHU3RUQzXHU2NzlDIFx1MjAxNFx1MjAxNCBcdTRFMEUgbnBtIFx1NjI0MVx1NUU3M1xuICogXHU1RTAzXHU1QzQwXHU0RTAwXHU4MUY0KVx1MzAwMmdldFBhY2t1bWVudCBcdTc1MzFcdThDMDNcdTc1MjhcdTY1QjlcdTZDRThcdTUxNjUoZmV0Y2ggXHU3RjUxXHU3RURDIC8gXHU2RDRCXHU4QkQ1XHU2Q0U4XHU1MTY1XHU1QjU3XHU1MTc4KVx1MzAwMlxuICogXHU0RUZCXHU0RTAwXHU0RjlEXHU4RDU2XHU2NUUwXHU2RUUxXHU4REIzXHU3MjQ4XHU2NzJDXHU2NUY2XHU2MjlCXHU5NTE5KFx1NUUyNlx1NTMwNVx1NTQwRFx1NEUwRSByYW5nZSxcdTk3NjJcdTU0MTFcdTVCODlcdTg4QzVcdTk4NzVcdTk1MTlcdThCRUZcdTY1ODdcdTY4NDgpXHUzMDAyXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZXNvbHZlQ2xvc3VyZShcbiAgcm9vdDogeyBuYW1lOiBzdHJpbmc7IHNwZWM6IHN0cmluZyB9LFxuICBnZXRQYWNrdW1lbnQ6IChuYW1lOiBzdHJpbmcpID0+IFByb21pc2U8UGFja3VtZW50Pixcbik6IFByb21pc2U8UmVzb2x2ZWRQa2dbXT4ge1xuICBjb25zdCByZXNvbHZlZCA9IG5ldyBNYXA8c3RyaW5nLCBQa2dWZXJzaW9uTWV0YT4oKTtcbiAgY29uc3QgcXVldWU6IEFycmF5PHsgbmFtZTogc3RyaW5nOyBzcGVjOiBzdHJpbmcgfT4gPSBbcm9vdF07XG4gIHdoaWxlIChxdWV1ZS5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgeyBuYW1lLCBzcGVjIH0gPSBxdWV1ZS5zaGlmdCgpITtcbiAgICBpZiAocmVzb2x2ZWQuaGFzKG5hbWUpKSBjb250aW51ZTsgLy8gXHU1REYyXHU1QjlBXHU3MjQ4Olx1NTQwRVx1N0VFRCByYW5nZSBcdTVGMTVcdTc1MjhcdTRFMERcdTUxOERcdTkxQ0RcdTg5RTMobnBtIFx1NjI0MVx1NUU3M1x1OEJFRFx1NEU0OSlcbiAgICBjb25zdCBkb2MgPSBhd2FpdCBnZXRQYWNrdW1lbnQobmFtZSk7XG4gICAgY29uc3QgdmVyc2lvbiA9IHBpY2tWZXJzaW9uKGRvYywgc3BlYyk7XG4gICAgY29uc3QgbWV0YSA9IHZlcnNpb24gIT09ICcnID8gZG9jLnZlcnNpb25zW3ZlcnNpb25dIDogdW5kZWZpbmVkO1xuICAgIGlmIChtZXRhID09PSB1bmRlZmluZWQgfHwgbWV0YS5kaXN0Py50YXJiYWxsID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgbm8gdmVyc2lvbiBvZiAke25hbWV9IHNhdGlzZmllcyAke3NwZWMgfHwgJ2xhdGVzdCd9YCk7XG4gICAgfVxuICAgIGNvbnN0IGl0ZW06IFBrZ1ZlcnNpb25NZXRhID0ge1xuICAgICAgdmVyc2lvbixcbiAgICAgIGRlcGVuZGVuY2llczogbWV0YS5kZXBlbmRlbmNpZXMgPz8ge30sXG4gICAgICB0YXJiYWxsOiBtZXRhLmRpc3QudGFyYmFsbCxcbiAgICAgIGludGVncml0eTogbWV0YS5kaXN0LmludGVncml0eSxcbiAgICB9O1xuICAgIHJlc29sdmVkLnNldChuYW1lLCBpdGVtKTtcbiAgICBmb3IgKGNvbnN0IFtkZXAsIHJhbmdlXSBvZiBPYmplY3QuZW50cmllcyhpdGVtLmRlcGVuZGVuY2llcykpIHtcbiAgICAgIGlmICghcmVzb2x2ZWQuaGFzKGRlcCkpIHF1ZXVlLnB1c2goeyBuYW1lOiBkZXAsIHNwZWM6IHJhbmdlIH0pO1xuICAgIH1cbiAgfVxuICByZXR1cm4gWy4uLnJlc29sdmVkLmVudHJpZXMoKV0ubWFwKChbbmFtZSwgbV0pID0+ICh7IG5hbWUsIHZlcnNpb246IG0udmVyc2lvbiwgdGFyYmFsbDogbS50YXJiYWxsLCBpbnRlZ3JpdHk6IG0uaW50ZWdyaXR5IH0pKTtcbn1cblxuLyogLS0tLSBcdTk1NUNcdTUwQ0ZcdTRFMEVcdTVFMDNcdTVDNDAgLS0tLSAqL1xuXG5jb25zdCBSRUdJU1RSWV9IT1NUUyA9IC9eKGh0dHBzPzpcXC9cXC9bXi9dKylcXC8oLiopJC87XG5cbi8qKlxuICogdGFyYmFsbCBcdTc2ODRcdTk1NUNcdTUwQ0ZcdTUwMTlcdTkwMDkoXHU5ODdBXHU1RThGXHU1MzczXHU1NkRFXHU5MDAwXHU5ODdBXHU1RThGKTpcdTUzOUZcdTU5Q0JcdTU3MzBcdTU3NDAgXHUyMTkyIFx1NTQwNCByZWdpc3RyeSBcdTU0MENcdThERUZcdTVGODRcdTY1MzlcdTUxOTlcdTMwMDJcbiAqIHBhY2t1bWVudCBcdTkxQ0NcdTc2ODQgZGlzdC50YXJiYWxsIFx1NjA1Mlx1NjMwN1x1NTQxMVx1NTNEMVx1NUUwM1x1NkU5MChyZWdpc3RyeS5ucG1qcy5vcmcpLFx1NTZGRFx1NTE4NVx1N0Y1MVx1N0VEQ1xuICogXHU0RTBEXHU1M0VGXHU4RkJFXHU2NUY2XHU2MzA5IHJlZ2lzdHJ5IFx1NTIxN1x1ODg2OFx1NjUzOVx1NTE5OSBob3N0KFx1OERFRlx1NUY4NFx1NEUwRFx1NTNEOCBcdTIwMTRcdTIwMTQgbnBtbWlycm9yIFx1NEUwRSBucG1qcyBcdTU0MENcdTY3ODQpXHUzMDAyXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0YXJiYWxsTWlycm9ycyh0YXJiYWxsOiBzdHJpbmcsIHJlZ2lzdHJpZXM6IHN0cmluZ1tdKTogc3RyaW5nW10ge1xuICBjb25zdCBtID0gUkVHSVNUUllfSE9TVFMuZXhlYyh0YXJiYWxsKTtcbiAgY29uc3QgcGF0aCA9IG0/LlsyXSA/PyAnJztcbiAgY29uc3Qgb3V0ID0gW3RhcmJhbGxdO1xuICBmb3IgKGNvbnN0IHJlZyBvZiByZWdpc3RyaWVzKSB7XG4gICAgY29uc3QgYmFzZSA9IHJlZy5yZXBsYWNlKC9cXC8rJC8sICcnKTtcbiAgICBpZiAoYmFzZSA9PT0gbT8uWzFdKSBjb250aW51ZTtcbiAgICBjb25zdCB1ID0gYCR7YmFzZX0vJHtwYXRofWA7XG4gICAgaWYgKCFvdXQuaW5jbHVkZXModSkpIG91dC5wdXNoKHUpO1xuICB9XG4gIHJldHVybiBvdXQ7XG59XG5cbi8qKiBcdTUzMDVcdTU3Mjggbm9kZV9tb2R1bGVzIFx1NEUwQlx1NzY4NFx1NzZFRVx1NjgwN1x1NzZFRVx1NUY1NShzY29wZWQgXHU1MzA1XHU0RkREXHU2MzAxIEBzY29wZS9uYW1lIFx1NEUyNFx1N0VBNylcdTMwMDIgKi9cbmV4cG9ydCBmdW5jdGlvbiBtb2R1bGVEaXIocHJlZml4OiBzdHJpbmcsIG5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHBhcnRzID0gbmFtZS5zcGxpdCgnLycpLmZpbHRlcigocCkgPT4gcCAhPT0gJycgJiYgcCAhPT0gJy4nKTtcbiAgaWYgKG5hbWUuc3RhcnRzV2l0aCgnQCcpICYmIHBhcnRzLmxlbmd0aCAhPT0gMikgdGhyb3cgbmV3IEVycm9yKGBpbnZhbGlkIHBhY2thZ2UgbmFtZTogJHtuYW1lfWApO1xuICBpZiAoIW5hbWUuc3RhcnRzV2l0aCgnQCcpICYmIHBhcnRzLmxlbmd0aCAhPT0gMSkgdGhyb3cgbmV3IEVycm9yKGBpbnZhbGlkIHBhY2thZ2UgbmFtZTogJHtuYW1lfWApO1xuICByZXR1cm4gWy4uLnBhcnRzXS5yZWR1Y2UoKGRpciwgcCkgPT4gYCR7ZGlyfVxcXFwke3B9YCwgYCR7cHJlZml4fVxcXFxub2RlX21vZHVsZXNgKTtcbn1cblxuLyogLS0tLSBpbnRlZ3JpdHkgLS0tLSAqL1xuXG4vKiogbnBtIGRpc3QuaW50ZWdyaXR5KCdzaGE1MTItYmFzZTY0JykgXHU2ODIxXHU5QThDO1x1NEUwRFx1NTMzOVx1OTE0RFx1OEZENFx1NTZERSBmYWxzZShcdTY3MkFcdTc3RTVcdTdCOTdcdTZDRDVcdThGRDRcdTU2REUgdHJ1ZSBcdTY1M0VcdTg4NEMpXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gaW50ZWdyaXR5T2soZGF0YTogQnVmZmVyLCBpbnRlZ3JpdHk/OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgaWYgKGludGVncml0eSA9PT0gdW5kZWZpbmVkIHx8IGludGVncml0eSA9PT0gJycpIHJldHVybiB0cnVlO1xuICBjb25zdCBtID0gL15zaGE1MTItKFtBLVphLXowLTkrLz1dKykkLy5leGVjKGludGVncml0eS50cmltKCkpO1xuICBpZiAobSA9PT0gbnVsbCkgcmV0dXJuIHRydWU7XG4gIHJldHVybiBjcmVhdGVIYXNoKCdzaGE1MTInKS51cGRhdGUoZGF0YSkuZGlnZXN0KCdiYXNlNjQnKSA9PT0gbVsxXTtcbn1cblxuLyoqIFx1NEVCQVx1N0M3Qlx1NTNFRlx1OEJGQlx1NUI1N1x1ODI4MihcdTVCODlcdTg4QzVcdThGREJcdTVFQTZcdTY1ODdcdTY4NDhcdTc1MjgpXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gYnl0ZXNMYWJlbChuOiBudW1iZXIpOiBzdHJpbmcge1xuICBpZiAobiA8IDEwMjQpIHJldHVybiBgJHtufSBCYDtcbiAgaWYgKG4gPCAxMDI0ICogMTAyNCkgcmV0dXJuIGAkeyhuIC8gMTAyNCkudG9GaXhlZCgwKX0gS0JgO1xuICByZXR1cm4gYCR7KG4gLyAxMDI0IC8gMTAyNCkudG9GaXhlZCgxKX0gTUJgO1xufVxuIiwgIi8qKlxyXG4gKiBcdTY2RjRcdTY1QjBcdTU2NjhcdTkwMUFcdTkwNTNcdTdFQUZcdTkwM0JcdThGOTEoMjAyNi0xMC0yOSBcdTc1MjhcdTYyMzdcdTUzQ0RcdTk5ODhcdTY4MzlcdTZDQkI6XHU1NkZEXHU1MTg1XHU3NTI4XHU2MjM3XHU2NTM2XHU0RTBEXHU1MjMwXHU2NkY0XHU2NUIwXHU2M0E4XHU5MDAxO1xyXG4gKiBcdTU0MENcdTY1RTVcdTRFRkJcdTUyQTEgMTMtQzphdG9tZ2l0IFx1NTZGRFx1NTE4NVx1OTk5Nlx1OTAwOVx1OTAxQVx1OTA1MyArIFx1NTQwRVx1NTNGMFx1OTc1OVx1OUVEOFx1NjZGNFx1NjVCMClcdTMwMDJcclxuICpcclxuICogXHU4MENDXHU2NjZGOlx1NjhDMFx1NjdFNVx1OTAxQVx1OTA1M1x1NTM5Rlx1NjcyQ1x1NTNFQVx1OEQ3MCBhcGkuZ2l0aHViLmNvbSBcdTc2RjRcdThGREUoMTVzIFx1OEQ4NVx1NjVGNiksXHU1NkZEXHU1MTg1XHU2NUUwXHU0RUUzXHU3NDA2XHU3RjUxXHU3RURDXHU1RkM1XHJcbiAqIFx1OEQ4NVx1NjVGNiBcdTIxOTIgY2hlY2sgZmFpbGVkIFx1MjE5MiBcdTc1MjhcdTYyMzdcdTZDMzhcdThGRENcdTc3MEJcdTRFMERcdTUyMzBcdTY1QjBcdTcyNDhcdTY3MkM7XHU0RTBCXHU4RjdEXHU5MDFBXHU5MDUzXHU1M0NEXHU4MDBDXHU2NzA5XHU5NTVDXHU1MENGXHU1NkRFXHU5MDAwXHU5NEZFXHUzMDAyXHJcbiAqIFx1NjcyQ1x1NkEyMVx1NTc1N1x1N0VEOVx1NTFGQVx1N0VBRlx1ODlDNFx1NTIxOShtYWluIFx1OEZEQlx1N0EwQlx1NEUwRSBzY3JpcHRzL3NpbS11cGRhdGVyLm1qcyBcdTUxNzFcdTc1MjgsXHU1MzU1XHU2RDRCXHU4OTg2XHU3NkQ2KTpcclxuICogIDEpIFx1NjhDMFx1NjdFNVx1OTAxQVx1OTA1M1x1OTRGRTpcdTc2RjRcdThGREUoOHMsXHU1NkZEXHU1OTE2XHU3OUQyXHU4RkM3KVx1MjE5MiBhdG9tZ2l0IHY1KFx1NTZGRFx1NTE4NVx1NzZGNFx1OEZERSxcdTUzM0ZcdTU0MERcdTVDMEZcdTU0Q0RcdTVFOTQpXHJcbiAqICAgICBcdTIxOTIgZ2gtcHJveHkgXHUyMTkyIGdoZmFzdCxcdTkwMTBcdTRFMkFcdThCRDVcdTUyMzBcdTYyRkZcdTUyMzAgcmVsZWFzZTtcclxuICogIDIpIFx1OTAxQVx1OTA1M1x1N0M5OFx1NjAyNzpcdTRFMEFcdTZCMjFcdTU0N0RcdTRFMkRcdTc2ODRcdTkwMUFcdTkwNTNcdTRGMThcdTUxNDgsXHU1OTMxXHU4RDI1XHU1MThEXHU1NkRFXHU5MDAwXHU1MTY4XHU5NEZFO1xyXG4gKiAgMykgXHU0RTBCXHU4RjdEXHU1NDBDXHU2RTkwXHU0RjE4XHU1MTQ4Olx1NEUwRVx1NTQ3RFx1NEUyRFx1NzY4NFx1NjhDMFx1NjdFNVx1OTAxQVx1OTA1M1x1NTQwQ1x1NkU5MFx1NzY4NFx1OTU1Q1x1NTBDRlx1NTE0OFx1OEJENSxcdTUxOERcdTc2RjRcdThGREVcdTRFMEVcdTUxNzZcdTRGNTlcdTk1NUNcdTUwQ0Y7XHJcbiAqICAgICBhdG9tZ2l0IFx1NTQ3RFx1NEUyRCBcdTIxOTIgYXRvbWdpdCBcdThENDRcdTRFQTdcdTc2RjRcdTk0RkUgLyBBUEkgXHU3QUVGXHU3MEI5XHU0RjE4XHU1MTQ4LEdpdEh1YiBcdTRFM0JcdTRFRDNcdTk1NUNcdTUwQ0ZcdTUxNUNcdTVFOTVcdTMwMDJcclxuICogXHU2NUUwIGVsZWN0cm9uIFx1NEY5RFx1OEQ1NihcdTUzRUZcdTg4QUIgbm9kZSAtLWltcG9ydCB0c3ggXHU3Njg0XHU2RDRCXHU4QkQ1L1x1NkEyMVx1NjJERlx1ODExQVx1NjcyQ1x1NzZGNFx1NjNBNSBpbXBvcnQpXHUzMDAyXHJcbiAqL1xyXG5cclxuZXhwb3J0IHR5cGUgVXBkYXRlQ2hhbm5lbElkID0gJ2RpcmVjdCcgfCAnYXRvbWdpdCcgfCAnZ2gtcHJveHknIHwgJ2doZmFzdCc7XHJcblxyXG4vKiogXHU1M0NDXHU0RUQzXHU2NjIwXHU1QzA0OkdpdEh1YiBcdTRFM0JcdTRFRDNcdTRFMEUgYXRvbWdpdCBcdTk1NUNcdTUwQ0ZcdTRFRDMgb3duZXIgXHU0RTBEXHU1NDBDKHN3c2dibCB2cyBob25nZnUpLFxyXG4gKiAgXHU5MDFBXHU5MDUzXHU1NDA0XHU4MUVBXHU1M0Q2XHU4MUVBXHU1REYxXHU3Njg0XHU0RUQzKFx1NTNFRlx1ODhBQiBVUERBVEVfUkVQTyAvIFVQREFURV9SRVBPX0FUT01HSVQgXHU4OTg2XHU3NkQ2KVx1MzAwMiAqL1xyXG5leHBvcnQgaW50ZXJmYWNlIFVwZGF0ZVJlcG9zIHsgZ2l0aHViOiBzdHJpbmc7IGF0b21naXQ6IHN0cmluZyB9XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIENoZWNrQ2hhbm5lbCB7XHJcbiAgaWQ6IFVwZGF0ZUNoYW5uZWxJZDtcclxuICAvKiogXHU4QkNBXHU2NUFEL1VJIFx1NjYzRVx1NzkzQVx1NTQwRChcdTk1MTlcdThCRUZcdTRGRTFcdTYwNkZcdTkxQ0NcdTkwMTBcdTkwMUFcdTkwNTNcdTUzRUZcdTg5QzEpXHUzMDAyICovXHJcbiAgbGFiZWw6IHN0cmluZztcclxuICAvKiogXHU1MzU1XHU5MDFBXHU5MDUzXHU4RDg1XHU2NUY2Olx1NzZGNFx1OEZERSA4cyhcdTU2RkRcdTU5MTZcdTc5RDJcdThGQzdcdTMwMDFcdTU2RkRcdTUxODVcdTVGRUJcdTkwMUZcdThCQTlcdTRGNERcdTk1NUNcdTUwQ0YpLGF0b21naXQvXHU5NTVDXHU1MENGIDEwc1x1MzAwMiAqL1xyXG4gIHRpbWVvdXRNczogbnVtYmVyO1xyXG4gIGFwaVVybDogKHJlcG9zOiBVcGRhdGVSZXBvcykgPT4gc3RyaW5nO1xyXG4gIC8qKiBcdTRFMEJcdThGN0RcdTk1NUNcdTUwQ0ZcdTUyNERcdTdGMDAoJycgPSBcdTc2RjRcdThGREUgYXNzZXQgdXJsKTtcdTk4N0JcdTU3MjggRE9XTkxPQURfTUlSUk9SX1BSRUZJWEVTIFx1NkUwNVx1NTM1NVx1NTE4NVx1MzAwMiAqL1xyXG4gIGRvd25sb2FkUHJlZml4OiBzdHJpbmc7XHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgUmVsZWFzZUFzc2V0IHsgbmFtZTogc3RyaW5nOyBicm93c2VyX2Rvd25sb2FkX3VybDogc3RyaW5nOyBzaXplOiBudW1iZXIgfVxyXG5leHBvcnQgaW50ZXJmYWNlIExhdGVzdFJlbGVhc2UgeyB0YWdfbmFtZTogc3RyaW5nOyBib2R5Pzogc3RyaW5nOyBhc3NldHM/OiBSZWxlYXNlQXNzZXRbXSB9XHJcblxyXG5jb25zdCBnaXRodWJMYXRlc3QgPSAocmVwbzogc3RyaW5nKTogc3RyaW5nID0+IGBodHRwczovL2FwaS5naXRodWIuY29tL3JlcG9zLyR7cmVwb30vcmVsZWFzZXMvbGF0ZXN0YDtcclxuXHJcbi8qKiBcdTY4QzBcdTY3RTVcdTkwMUFcdTkwNTNcdTk0RkUoXHU5RUQ4XHU4QkE0XHU5ODdBXHU1RThGOlx1NzZGNFx1OEZERSBcdTIxOTIgYXRvbWdpdChcdTU2RkRcdTUxODVcdTk5OTZcdTkwMDkpXHUyMTkyIGdoLXByb3h5IFx1MjE5MiBnaGZhc3QpXHUzMDAyICovXHJcbmV4cG9ydCBjb25zdCBDSEVDS19DSEFOTkVMUzogcmVhZG9ubHkgQ2hlY2tDaGFubmVsW10gPSBbXHJcbiAgeyBpZDogJ2RpcmVjdCcsIGxhYmVsOiAnXHU3NkY0XHU4RkRFJywgdGltZW91dE1zOiA4XzAwMCwgYXBpVXJsOiAocikgPT4gZ2l0aHViTGF0ZXN0KHIuZ2l0aHViKSwgZG93bmxvYWRQcmVmaXg6ICcnIH0sXHJcbiAgeyBpZDogJ2F0b21naXQnLCBsYWJlbDogJ2F0b21naXQoXHU1NkZEXHU1MTg1KScsIHRpbWVvdXRNczogMTBfMDAwLCBhcGlVcmw6IChyKSA9PiBgaHR0cHM6Ly9hcGkuYXRvbWdpdC5jb20vYXBpL3Y1L3JlcG9zLyR7ci5hdG9tZ2l0fS9yZWxlYXNlcz9wZXJfcGFnZT01JmRpcmVjdGlvbj1kZXNjYCwgZG93bmxvYWRQcmVmaXg6ICcnIH0sXHJcbiAgeyBpZDogJ2doLXByb3h5JywgbGFiZWw6ICdnaC1wcm94eScsIHRpbWVvdXRNczogMTBfMDAwLCBhcGlVcmw6IChyKSA9PiBgaHR0cHM6Ly9naC1wcm94eS5jb20vJHtnaXRodWJMYXRlc3Qoci5naXRodWIpfWAsIGRvd25sb2FkUHJlZml4OiAnaHR0cHM6Ly9naC1wcm94eS5jb20vJyB9LFxyXG4gIHsgaWQ6ICdnaGZhc3QnLCBsYWJlbDogJ2doZmFzdCcsIHRpbWVvdXRNczogMTBfMDAwLCBhcGlVcmw6IChyKSA9PiBgaHR0cHM6Ly9naGZhc3QudG9wLyR7Z2l0aHViTGF0ZXN0KHIuZ2l0aHViKX1gLCBkb3dubG9hZFByZWZpeDogJ2h0dHBzOi8vZ2hmYXN0LnRvcC8nIH0sXHJcbl07XHJcblxyXG4vKiogXHU0RTBCXHU4RjdEXHU5NTVDXHU1MENGXHU1MTY4XHU2RTA1XHU1MzU1KFx1OUVEOFx1OEJBNFx1OTg3QVx1NUU4RjtnaHByb3h5LmNuIFx1NEVDNVx1NEUwQlx1OEY3RFx1NTE1Q1x1NUU5NSxcdTRFMERcdTUwNUFcdTY4QzBcdTY3RTVcdTkwMUFcdTkwNTMpXHUzMDAyICovXHJcbmV4cG9ydCBjb25zdCBET1dOTE9BRF9NSVJST1JfUFJFRklYRVM6IHJlYWRvbmx5IHN0cmluZ1tdID0gWycnLCAnaHR0cHM6Ly9naGZhc3QudG9wLycsICdodHRwczovL2doLXByb3h5LmNvbS8nLCAnaHR0cHM6Ly9naHByb3h5LmNuLyddO1xyXG5cclxuLyoqIFx1NUI1OFx1NTBBOFx1NTAzQy9JUEMgXHU1MDNDXHU1RjUyXHU0RTAwOlx1NTQwOFx1NkNENVx1OTAxQVx1OTA1MyBpZCBcdTYyMTYgbnVsbChcdTdDOThcdTYwMjdcdTY1ODdcdTRFRjZcdTYzNUZcdTU3NEYvXHU2NUU3XHU3MjQ4XHU2NzJDXHU2QjhCXHU3NTU5XHU2NUY2XHU0RTBEXHU4MUY0XHU1NDdEKVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplQ2hhbm5lbCh2OiB1bmtub3duKTogVXBkYXRlQ2hhbm5lbElkIHwgbnVsbCB7XHJcbiAgcmV0dXJuIHR5cGVvZiB2ID09PSAnc3RyaW5nJyAmJiBDSEVDS19DSEFOTkVMUy5zb21lKChjKSA9PiBjLmlkID09PSB2KSA/ICh2IGFzIFVwZGF0ZUNoYW5uZWxJZCkgOiBudWxsO1xyXG59XHJcblxyXG4vKiogXHU3Qzk4XHU2MDI3XHU2MzkyXHU1RThGOlx1NEUwQVx1NkIyMVx1NTQ3RFx1NEUyRFx1OTAxQVx1OTA1M1x1NEYxOFx1NTE0OCxcdTUxNzZcdTRGNTlcdTRGRERcdTYzMDFcdTlFRDhcdThCQTRcdTk0RkVcdTVFOEYoXHU0RUZCXHU0RTAwXHU5MDFBXHU5MDUzXHU1OTMxXHU4RDI1XHU0RUNEXHU1M0VGXHU1MTY4XHU5NEZFXHU1NkRFXHU5MDAwKVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gb3JkZXJlZENoZWNrQ2hhbm5lbHMoc3RpY2t5OiB1bmtub3duKTogcmVhZG9ubHkgQ2hlY2tDaGFubmVsW10ge1xyXG4gIGNvbnN0IHMgPSBub3JtYWxpemVDaGFubmVsKHN0aWNreSk7XHJcbiAgY29uc3QgZmlyc3QgPSBzID09PSBudWxsID8gdW5kZWZpbmVkIDogQ0hFQ0tfQ0hBTk5FTFMuZmluZCgoYykgPT4gYy5pZCA9PT0gcyk7XHJcbiAgaWYgKGZpcnN0ID09PSB1bmRlZmluZWQpIHJldHVybiBDSEVDS19DSEFOTkVMUztcclxuICByZXR1cm4gW2ZpcnN0LCAuLi5DSEVDS19DSEFOTkVMUy5maWx0ZXIoKGMpID0+IGMuaWQgIT09IHMpXTtcclxufVxyXG5cclxuLyoqIFx1NEUwQlx1OEY3RFx1OTU1Q1x1NTBDRlx1OTg3QVx1NUU4RjpcdTU0N0RcdTRFMkRcdTY4QzBcdTY3RTVcdTkwMUFcdTkwNTNcdTc2ODRcdTU0MENcdTZFOTBcdTk1NUNcdTUwQ0ZcdTRGMThcdTUxNDggXHUyMTkyIFx1NzZGNFx1OEZERSBcdTIxOTIgXHU1MTc2XHU0RjU5XHU5NTVDXHU1MENGKFx1NTNCQlx1OTFDRCw0IFx1OTAxQVx1OTA1M1x1NkUwNVx1NTM1NVx1NEZERFx1NzU1OSlcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIG9yZGVyZWREb3dubG9hZE1pcnJvcnMoYXNzZXRVcmw6IHN0cmluZywgY2hhbm5lbDogdW5rbm93bik6IHJlYWRvbmx5IHN0cmluZ1tdIHtcclxuICBjb25zdCBoaXQgPSBub3JtYWxpemVDaGFubmVsKGNoYW5uZWwpO1xyXG4gIGNvbnN0IHByZWZpeCA9IGhpdCA9PT0gbnVsbCA/ICcnIDogQ0hFQ0tfQ0hBTk5FTFMuZmluZCgoYykgPT4gYy5pZCA9PT0gaGl0KT8uZG93bmxvYWRQcmVmaXggPz8gJyc7XHJcbiAgY29uc3QgcHJlZml4ZXMgPSBbLi4ubmV3IFNldChbcHJlZml4LCAuLi5ET1dOTE9BRF9NSVJST1JfUFJFRklYRVNdKV07XHJcbiAgcmV0dXJuIHByZWZpeGVzLm1hcCgocCkgPT4gKHAgPT09ICcnID8gYXNzZXRVcmwgOiBgJHtwfSR7YXNzZXRVcmx9YCkpO1xyXG59XHJcblxyXG4vKiogXHU4QkVEXHU0RTQ5XHU3MjQ4XHU2NzJDXHU2QkQ0XHU4RjgzKCd2JyBcdTUyNERcdTdGMDBcdTUzRUZcdTkwMDksXHU2MzA5IC4gXHU1MjA2XHU2QkI1XHU2NTcwXHU1MDNDXHU2QkQ0O1x1NEUwRFx1OERCM1x1NEUwOVx1NkJCNVx1ODg2NSAwKVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gY21wVmVyc2lvbihhOiBzdHJpbmcsIGI6IHN0cmluZyk6IG51bWJlciB7XHJcbiAgY29uc3QgcGEgPSBhLnJlcGxhY2UoL152LywgJycpLnNwbGl0KCcuJykubWFwKE51bWJlcik7XHJcbiAgY29uc3QgcGIgPSBiLnJlcGxhY2UoL152LywgJycpLnNwbGl0KCcuJykubWFwKE51bWJlcik7XHJcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCAzOyBpKyspIHtcclxuICAgIGlmICgocGFbaV0gPz8gMCkgIT09IChwYltpXSA/PyAwKSkgcmV0dXJuIChwYVtpXSA/PyAwKSA8IChwYltpXSA/PyAwKSA/IC0xIDogMTtcclxuICB9XHJcbiAgcmV0dXJuIDA7XHJcbn1cclxuXHJcbi8qKiBcdTU0Q0RcdTVFOTRcdTVGNTJcdTRFMDA6R2l0SHViIC9yZWxlYXNlcy9sYXRlc3QgXHU4RkQ0XHU1NkRFXHU1QkY5XHU4QzYxLGF0b21naXQgL3JlbGVhc2VzIFx1OEZENFx1NTZERVx1NjU3MFx1N0VDNFx1MzAwMlxyXG4gKiAgYXRvbWdpdCBcdTUyMTdcdTg4NjhcdTYzMDkgY3JlYXRlZF9hdCBcdTYzOTJcdTVFOEZcdTMwMDFcdTk5OTZcdTRFMkFcdTUxNDNcdTdEMjBcdTRFMERcdTRGRERcdThCQzFcdTY2MkZcdTY3MDBcdTY1QjAgdGFnKFx1NUI5RVx1NkQ0QiB2MC4yLjggXHU1RUZBXHJcbiAqICBcdTVGOTdcdTZCRDQgdjAuMi45IFx1NjY1QVx1ODAwQ1x1NjM5Mlx1N0IyQ1x1NEUwMClcdTIxOTIgXHU1QkEyXHU2MjM3XHU3QUVGXHU2MzA5XHU4QkVEXHU0RTQ5XHU3MjQ4XHU2NzJDXHU2MzExIHRhZyBcdTY3MDBcdTU5MjdcdTc2ODQgcmVsZWFzZVx1MzAwMnRhZyBcdTdGM0FcdTU5MzEvXHJcbiAqICBcdTVGNjJcdTcyQjZcdTRFMERcdTVCRjlcdThGRDRcdTU2REUgbnVsbChcdTYzMDlcdTY3MkNcdTkwMUFcdTkwNTNcdTU5MzFcdThEMjVcdTU2REVcdTkwMDBcdTRFMEJcdTRFMDBcdTkwMUFcdTkwNTMpXHUzMDAyICovXHJcbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpemVSZWxlYXNlKGpzb246IHVua25vd24pOiBMYXRlc3RSZWxlYXNlIHwgbnVsbCB7XHJcbiAgbGV0IGJlc3Q6IExhdGVzdFJlbGVhc2UgfCBudWxsID0gbnVsbDtcclxuICBmb3IgKGNvbnN0IHJlbCBvZiBBcnJheS5pc0FycmF5KGpzb24pID8ganNvbiA6IFtqc29uXSkge1xyXG4gICAgaWYgKHR5cGVvZiByZWwgIT09ICdvYmplY3QnIHx8IHJlbCA9PT0gbnVsbCkgY29udGludWU7XHJcbiAgICBjb25zdCByID0gcmVsIGFzIHsgdGFnX25hbWU/OiB1bmtub3duOyBib2R5PzogdW5rbm93bjsgYXNzZXRzPzogdW5rbm93biB9O1xyXG4gICAgaWYgKHR5cGVvZiByLnRhZ19uYW1lICE9PSAnc3RyaW5nJyB8fCByLnRhZ19uYW1lID09PSAnJykgY29udGludWU7XHJcbiAgICBjb25zdCBhc3NldHM6IFJlbGVhc2VBc3NldFtdID0gQXJyYXkuaXNBcnJheShyLmFzc2V0cylcclxuICAgICAgPyByLmFzc2V0cy5mbGF0TWFwKChhKTogUmVsZWFzZUFzc2V0W10gPT4ge1xyXG4gICAgICAgICAgY29uc3QgeCA9IGEgYXMgeyBuYW1lPzogdW5rbm93bjsgYnJvd3Nlcl9kb3dubG9hZF91cmw/OiB1bmtub3duOyBzaXplPzogdW5rbm93biB9O1xyXG4gICAgICAgICAgcmV0dXJuIHR5cGVvZiB4Lm5hbWUgPT09ICdzdHJpbmcnICYmIHR5cGVvZiB4LmJyb3dzZXJfZG93bmxvYWRfdXJsID09PSAnc3RyaW5nJ1xyXG4gICAgICAgICAgICA/IFt7IG5hbWU6IHgubmFtZSwgYnJvd3Nlcl9kb3dubG9hZF91cmw6IHguYnJvd3Nlcl9kb3dubG9hZF91cmwsIHNpemU6IHR5cGVvZiB4LnNpemUgPT09ICdudW1iZXInID8geC5zaXplIDogMCB9XVxyXG4gICAgICAgICAgICA6IFtdO1xyXG4gICAgICAgIH0pXHJcbiAgICAgIDogW107XHJcbiAgICBjb25zdCBjdXI6IExhdGVzdFJlbGVhc2UgPSB7IHRhZ19uYW1lOiByLnRhZ19uYW1lLCBib2R5OiB0eXBlb2Ygci5ib2R5ID09PSAnc3RyaW5nJyA/IHIuYm9keSA6ICcnLCBhc3NldHMgfTtcclxuICAgIGlmIChiZXN0ID09PSBudWxsIHx8IGNtcFZlcnNpb24oY3VyLnRhZ19uYW1lLCBiZXN0LnRhZ19uYW1lKSA+IDApIGJlc3QgPSBjdXI7XHJcbiAgfVxyXG4gIHJldHVybiBiZXN0O1xyXG59XHJcblxyXG4vKiogXHU0RUNFIHJlbGVhc2UgXHU4RDQ0XHU0RUE3XHU2MzExXHU1Qjg5XHU4OEM1XHU1MzA1OkhNSC1EZXNrdG9wLVNldHVwLSouZXhlIFx1N0NCRVx1Nzg2RVx1NTMzOVx1OTE0RCxcdTUxNUNcdTVFOTVcdTRFRkJcdTYxMEYgLmV4ZVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gcGlja0luc3RhbGxlckFzc2V0KGFzc2V0czogcmVhZG9ubHkgUmVsZWFzZUFzc2V0W10pOiBSZWxlYXNlQXNzZXQgfCBudWxsIHtcclxuICByZXR1cm4gYXNzZXRzLmZpbmQoKGEpID0+IC9eSE1ILURlc2t0b3AtU2V0dXAtLipcXC5leGUkL2kudGVzdChhLm5hbWUpKVxyXG4gICAgPz8gYXNzZXRzLmZpbmQoKGEpID0+IGEubmFtZS50b0xvd2VyQ2FzZSgpLmVuZHNXaXRoKCcuZXhlJykpXHJcbiAgICA/PyBudWxsO1xyXG59XHJcblxyXG4vKiogYXRvbWdpdCBBUEkgXHU0RTBCXHU4RjdEXHU3QUVGXHU3MEI5KGFnLWNsaSByZWxlYXNlX2Fzc2V0cy5nbyBcdTU0MENcdTVGNjI6dGFnICsgXHU2NTg3XHU0RUY2XHU1NDBEKVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gYXRvbWdpdEFwaURvd25sb2FkVXJsKHJlcG9zOiBVcGRhdGVSZXBvcywgdGFnOiBzdHJpbmcsIGFzc2V0TmFtZTogc3RyaW5nKTogc3RyaW5nIHtcclxuICByZXR1cm4gYGh0dHBzOi8vYXBpLmF0b21naXQuY29tL2FwaS92NS9yZXBvcy8ke3JlcG9zLmF0b21naXR9L3JlbGVhc2VzLyR7dGFnfS9hdHRhY2hfZmlsZXMvJHtlbmNvZGVVUklDb21wb25lbnQoYXNzZXROYW1lKX0vZG93bmxvYWRgO1xyXG59XHJcblxyXG4vKiogXHU0RTBCXHU4RjdEXHU1MDE5XHU5MDA5XHU5NEZFOmF0b21naXQgXHU1NDdEXHU0RTJEKFx1NjIxNlx1OEQ0NFx1NEVBNyBVUkwgXHU2NzJDXHU1QzMxXHU1NzI4IGF0b21naXQuY29tKVx1MjE5MiBhdG9tZ2l0IFx1OEQ0NFx1NEVBN1x1NzZGNFx1OTRGRVx1MzAwMVxyXG4gKiAgYXRvbWdpdCBBUEkgXHU3QUVGXHU3MEI5XHU0RjE4XHU1MTQ4LFx1NTE4RFx1NjJGQyBHaXRIdWIgXHU0RTNCXHU0RUQzXHU1NDBDIHRhZyBcdTU0MENcdTU0MERcdThENDRcdTRFQTdcdTc2ODRcdTk1NUNcdTUwQ0ZcdTk0RkVcdTUxNUNcdTVFOTUoYXRvbWdpdFxyXG4gKiAgMzAyIFx1MjE5MiBDRE4gXHU3QjdFXHU1NDBEXHU3NkY0XHU5NEZFLFx1NTMzRlx1NTQwRFx1NTNFRlx1NEUwQlx1MzAwMVx1NjVFMFx1OTcwMCBSZWZlcmVyKTtHaXRIdWIgXHU1NDdEXHU0RTJEIFx1MjE5MiBcdTY1RTJcdTY3MDlcdTk1NUNcdTUwQ0ZcdTk0RkVcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGRvd25sb2FkQ2FuZGlkYXRlcyhpbnB1dDogeyBjaGFubmVsOiB1bmtub3duOyB0YWc6IHN0cmluZzsgYXNzZXRVcmw6IHN0cmluZzsgYXNzZXROYW1lOiBzdHJpbmc7IHJlcG9zOiBVcGRhdGVSZXBvcyB9KTogcmVhZG9ubHkgc3RyaW5nW10ge1xyXG4gIGNvbnN0IHsgY2hhbm5lbCwgdGFnLCBhc3NldFVybCwgYXNzZXROYW1lLCByZXBvcyB9ID0gaW5wdXQ7XHJcbiAgbGV0IG9uQXRvbWdpdCA9IG5vcm1hbGl6ZUNoYW5uZWwoY2hhbm5lbCkgPT09ICdhdG9tZ2l0JztcclxuICB0cnkgeyBpZiAobmV3IFVSTChhc3NldFVybCkuaG9zdG5hbWUgPT09ICdhdG9tZ2l0LmNvbScpIG9uQXRvbWdpdCA9IHRydWU7IH0gY2F0Y2ggeyAvKiBcdTY1RTBcdTY1NDggVVJMIFx1NjMwOVx1OTAxQVx1OTA1M1x1NTIyNFx1NUI5QSAqLyB9XHJcbiAgaWYgKG9uQXRvbWdpdCkge1xyXG4gICAgY29uc3QgZ2l0aHViQXNzZXRVcmwgPSBgaHR0cHM6Ly9naXRodWIuY29tLyR7cmVwb3MuZ2l0aHVifS9yZWxlYXNlcy9kb3dubG9hZC8ke3RhZ30vJHthc3NldE5hbWV9YDtcclxuICAgIHJldHVybiBbLi4ubmV3IFNldChbYXNzZXRVcmwsIGF0b21naXRBcGlEb3dubG9hZFVybChyZXBvcywgdGFnLCBhc3NldE5hbWUpLCAuLi5vcmRlcmVkRG93bmxvYWRNaXJyb3JzKGdpdGh1YkFzc2V0VXJsLCBjaGFubmVsKV0pXTtcclxuICB9XHJcbiAgcmV0dXJuIG9yZGVyZWREb3dubG9hZE1pcnJvcnMoYXNzZXRVcmwsIGNoYW5uZWwpO1xyXG59XHJcblxyXG4vKiogXHU0RTBCXHU4RjdEXHU2ODIxXHU5QThDOlx1NTE0M1x1NjU3MFx1NjM2RSBzaXplPjAgXHU2NUY2XHU5ODdCXHU0RTBFXHU4NDNEXHU3NkQ4XHU1QjU3XHU4MjgyXHU0RTAwXHU4MUY0KGF0b21naXQgXHU0RjIwXHU4RjkzXHU1M0VGXHU5NzYwXHU2MDI3XHU5OTk2XHU5QThDLFxyXG4gKiAgR2l0SHViIFx1OEQ0NFx1NEVBN1x1NTE0M1x1NjU3MFx1NjM2RVx1NTQwQ1x1NjgzN1x1NUUyNiBzaXplLFx1OTg3QVx1NUUyNlx1NEUwMFx1OEQ3N1x1NEZERFx1NzcxRilcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHNpemVNYXRjaGVzKG1ldGFTaXplOiBudW1iZXIsIGFjdHVhbEJ5dGVzOiBudW1iZXIpOiBib29sZWFuIHtcclxuICByZXR1cm4gIShtZXRhU2l6ZSA+IDApIHx8IG1ldGFTaXplID09PSBhY3R1YWxCeXRlcztcclxufVxyXG5cclxuLyoqIFx1NTE2OFx1OTAxQVx1OTA1M1x1NTkzMVx1OEQyNVx1NzY4NFx1OTUxOVx1OEJFRlx1NEUzMjpcdTkwMTBcdTkwMUFcdTkwNTNcdTUyMTdcdTUxRkFcdTUzOUZcdTU2RTAoXHU3RjUxXHU3RURDXHU4QkNBXHU2NUFEXHU3NTI4O1VJIFx1NjZGNFx1NjVCMFx1OTc2Mlx1Njc3Rlx1NzE2N1x1NUUzOFx1NjYzRVx1NzkzQSlcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHN1bW1hcml6ZUNoZWNrRmFpbHVyZXMoZmFpbHVyZXM6IFJlYWRvbmx5QXJyYXk8eyBsYWJlbDogc3RyaW5nOyByZWFzb246IHN0cmluZyB9Pik6IHN0cmluZyB7XHJcbiAgcmV0dXJuIGZhaWx1cmVzLm1hcCgoZikgPT4gYCR7Zi5sYWJlbH06JHtmLnJlYXNvbn1gKS5qb2luKCc7ICcpO1xyXG59XHJcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFjQSxTQUFTLE9BQUFBLE1BQUssZUFBZSxRQUFRLFNBQVMsU0FBUyxPQUFPLE1BQU0sY0FBYyxNQUFNLGFBQWEsbUJBQW1CO0FBQ3hILFNBQVMsUUFBQUMsT0FBTSxTQUFTLFVBQVUsWUFBWSxlQUFlO0FBQzdELFNBQVMsY0FBQUMsYUFBWSxnQkFBQUMsZUFBYyxvQkFBb0I7QUFDdkQsU0FBUyx5QkFBeUI7QUFDbEMsU0FBUyxhQUFBQyxZQUFXLFVBQVUsTUFBTSxjQUFjO0FBQ2xELFNBQVMsV0FBQUMsVUFBUyx5QkFBeUI7QUFDM0MsU0FBUyxjQUFjLFNBQUFDLGNBQWE7QUFDcEMsU0FBUyxpQkFBQUMsc0JBQXFCOzs7QUNYOUIsU0FBUyxhQUFnQztBQUN6QyxTQUFTLHVCQUF1QjtBQUNoQyxTQUFTLG1CQUFtQjs7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QTJFQTtBQU9BO0FBUUE7QUFXQTtBQWtFQTtBQUtBO0FBaUJBO0FBS0E7QUFZQTtBQW9CQTtBQW9IQTtBQVlBO0FBV0E7IiwKICAibmFtZXMiOiBbImFwcCIsICJqb2luIiwgImV4aXN0c1N5bmMiLCAicmVhbHBhdGhTeW5jIiwgIndyaXRlRmlsZSIsICJob21lZGlyIiwgInNwYXduIiwgInBhdGhUb0ZpbGVVUkwiLCAicmVzb2x2ZSIsICJyYW5kb21VVUlEIiwgInJhbmRvbVVVSUQiLCAicmVzb2x2ZSIsICJhcHAiLCAibWtkaXIiLCAid3JpdGVGaWxlIiwgImpvaW4iLCAic2xlZXAiLCAic3Bhd24iLCAiam9pbiIsICJqb2luIiwgInJlc29sdmUiLCAic3Bhd24iLCAiam9pbiIsICJqb2luIiwgImFwcCIsICJwdXNoRXZlbnQiLCAibm90aWZ5RXZlbnQiLCAiZm9jdXNNYWluV2luZG93IiwgInNldHVwVHJheSIsICJhcHBseUNocm9tZSIsICJhcHBseVVwZGF0ZSIsICJzcGF3biIsICJidWlsZEFwcE1lbnUiLCAicG9wdXBNYWluTWVudSIsICJ3ZWJBdXRvc3RhcnRJbnN0YWxsZWQiLCAiZXhpc3RzU3luYyIsICJsYW5JcE9mIiwgImNsaUVudHJ5T2YiLCAicmVwb1Jvb3RPZiIsICJwa2dOYW1lQXQiLCAicnVuQ2xpIiwgImJyb2FkY2FzdEhvc3RTdGF0ZSIsICJwa2dWZXJzaW9uQXQiLCAiZW50cnlGcm9tQ2xpRGlyIiwgImRldGVjdEV4dGVybmFsUnVudGltZSIsICJyZWFscGF0aFN5bmMiLCAiaG9tZWRpciIsICJkZXRlY3RSZWFsRW50cnkiLCAiYnVuZGxlZFJ1bnRpbWVQYXRoIiwgImJ1bmRsZWRSdW50aW1lSW5mbyIsICJucG1PblBhdGgiLCAid2l6YXJkU3VwcHJlc3NlZCIsICJzZW5kZXJUcnVzdGVkIiwgImhvc3RDYWxsIiwgInJlZ2lzdGVySXBjIiwgIndyaXRlRmlsZSIsICJ3IiwgInBhdGhUb0ZpbGVVUkwiLCAiYXBwMiJdCn0K
