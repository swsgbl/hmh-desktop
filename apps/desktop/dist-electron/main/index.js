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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vZWxlY3Ryb24vbWFpbi9pbmRleC50cyIsICIuLi8uLi8uLi8uLi9wYWNrYWdlcy9ob3N0LWFkYXB0ZXIvc3JjL3N1cGVydmlzb3IudHMiLCAiLi4vLi4vLi4vLi4vcGFja2FnZXMvY29udHJhY3RzL3NyYy9ldmVudC50cyIsICIuLi8uLi8uLi8uLi9wYWNrYWdlcy9jb250cmFjdHMvc3JjL2Vycm9yLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2NvbnRyYWN0cy9zcmMvZ3VhcmRzLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2hvc3QtYWRhcHRlci9zcmMvY2xpZW50LnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2hvc3QtYWRhcHRlci9zcmMvZmFrZS1ob3N0LnRzIiwgIi4uLy4uL2VsZWN0cm9uL21haW4vdWl2ZXJpZnkudHMiLCAiLi4vLi4vZWxlY3Ryb24vbWFpbi92aXN1YWxyZWdyZXNzaW9uLnRzIiwgIi4uLy4uL2VsZWN0cm9uL21haW4vaW5zdGFsbGVyLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2NsaS1pbnN0YWxsZXIvc3JjL2luZGV4LnRzIiwgIi4uLy4uL2VsZWN0cm9uL21haW4vdXBkYXRlci1jaGFubmVscy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXHJcbiAqIEhNSCBEZXNrdG9wIFx1MjAxNCBFbGVjdHJvbiBcdTRFM0JcdThGREJcdTdBMEIoQURSLTAwMS8wMDMvMDA0KVx1MzAwMlxyXG4gKlxyXG4gKiBcdTVCODlcdTUxNjhcdTRFMERcdTUzRDhcdTkxQ0YoXHU1RjAwXHU1M0QxXHU4QkExXHU1MjEyIE0wIFx1NTFGQVx1NTNFM1x1OTVFOCArIEVsZWN0cm9uIFx1NUI5OFx1NjVCOVx1NUI4OVx1NTE2OFx1NkUwNVx1NTM1NSk6XHJcbiAqICAtIHJlbmRlcmVyOmNvbnRleHRJc29sYXRpb24gKyBzYW5kYm94ICsgXHU3OTgxIG5vZGVJbnRlZ3JhdGlvbixcdTRFMjVcdTY4M0MgQ1NQO1xyXG4gKiAgLSBcdTVCRkNcdTgyMkEvXHU2NUIwXHU3QTk3XHU1M0UzXHU0RTAwXHU1RjhCXHU2MkQyXHU3RUREKFx1NTNFQVx1NTJBMFx1OEY3RFx1NjIxMVx1NEVFQ1x1ODFFQVx1NURGMVx1NzY4NCByZW5kZXJlcik7XHJcbiAqICAtIFx1NkJDRlx1Njc2MSBJUEMgXHU2ODIxXHU5QThDIHNlbmRlciBcdTc2ODRcdTk4NzZcdTVDNDIgZnJhbWUgVVJMIFx1NUM1RVx1NEU4RVx1NjcyQ1x1NUU5NFx1NzUyOCxcdTkwMUFcdTkwNTNcdTc2N0RcdTU0MERcdTUzNTU7XHJcbiAqICAtIGhvc3QgdG9rZW4gXHU1M0VBXHU1QjU4XHU1NzI4XHU0RThFXHU2NzJDXHU4RkRCXHU3QTBCXHU0RTBFXHU1QjUwXHU4RkRCXHU3QTBCIGVudixcdTY1RTVcdTVGRDdcdThGOTNcdTUxRkFcdTUyNERcdTUxNDhcdTgxMzFcdTY1NEY7XHJcbiAqICAtIFx1NTM1NVx1NUI5RVx1NEY4Qlx1OTUwMTtcdTkwMDBcdTUxRkFcdTY1RjZcdTUzRUFcdTUwNUNcdTZCNjJcdTgxRUFcdTVERjEgc3Bhd24gXHU3Njg0IGhvc3QoXHU0RjE4XHU5NkM1XHUyMTkyXHU1MTVDXHU1RTk1IGtpbGwpXHUzMDAyXHJcbiAqXHJcbiAqIFx1OTYzNlx1NkJCNUUoMjAyNi0xMC0xMCk6bWFpbiBcdTYzMDFcdTY3MDkgRGVza3RvcEhvc3RDbGllbnQsU1NFIFx1NEZFMVx1NUMwMVx1NkQ0MShldmVudDogaG1oKVxyXG4gKiBcdTdFQ0YgNTBtcyBcdTYyNzlcdTkxQ0ZcdTYzQThcdTdFRDkgcmVuZGVyZXI7c2VuZFRhc2svYXBwcm92ZS9pbnRlcnJ1cHQvc2Vzc2lvbnMgXHU1MTY4XHU5MEU4XHU4RjZDXHU1M0QxXHJcbiAqIFx1N0VEOSBob3N0IFx1MjAxNFx1MjAxNCBmYWtlIFx1NEUwRVx1NzcxRlx1NUI5RSBobWhhcm5lc3MgZGVza3RvcC1ob3N0IFx1OEQ3MFx1NTQwQ1x1NEUwMFx1Njc2MVx1NEVFM1x1NzgwMVx1OERFRlx1NUY4NFx1MzAwMlxyXG4gKi9cclxuaW1wb3J0IHsgYXBwLCBCcm93c2VyV2luZG93LCBkaWFsb2csIGlwY01haW4sIHNlc3Npb24sIHNoZWxsLCBUcmF5LCBOb3RpZmljYXRpb24sIE1lbnUsIG5hdGl2ZUltYWdlLCBuYXRpdmVUaGVtZSB9IGZyb20gJ2VsZWN0cm9uJztcclxuaW1wb3J0IHsgam9pbiwgZGlybmFtZSwgYmFzZW5hbWUsIGlzQWJzb2x1dGUsIHJlc29sdmUgfSBmcm9tICdub2RlOnBhdGgnO1xyXG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFscGF0aFN5bmMsIHJlYWRGaWxlU3luYyB9IGZyb20gJ25vZGU6ZnMnO1xyXG5pbXBvcnQgeyBjcmVhdGVXcml0ZVN0cmVhbSB9IGZyb20gJ25vZGU6ZnMnO1xyXG5pbXBvcnQgeyB3cml0ZUZpbGUsIHJlYWRGaWxlLCBzdGF0LCByZW5hbWUgfSBmcm9tICdub2RlOmZzL3Byb21pc2VzJztcclxuaW1wb3J0IHsgaG9tZWRpciwgbmV0d29ya0ludGVyZmFjZXMgfSBmcm9tICdub2RlOm9zJztcclxuaW1wb3J0IHsgZXhlY0ZpbGVTeW5jLCBzcGF3biB9IGZyb20gJ25vZGU6Y2hpbGRfcHJvY2Vzcyc7XHJcbmltcG9ydCB7IHBhdGhUb0ZpbGVVUkwgfSBmcm9tICdub2RlOnVybCc7XHJcbmltcG9ydCB7IHJhbmRvbVVVSUQgfSBmcm9tICdub2RlOmNyeXB0byc7XHJcbmltcG9ydCB7IERlc2t0b3BSdW50aW1lU3VwZXJ2aXNvciwgRGVza3RvcEhvc3RDbGllbnQsIGVudmVsb3BlRnJvbUZyYW1lLCB0eXBlIEhvc3RTdGF0ZSB9IGZyb20gJ0BobWgtZGVza3RvcC9ob3N0LWFkYXB0ZXInO1xyXG5pbXBvcnQgeyBpc0V2ZW50RW52ZWxvcGUsIHR5cGUgRXZlbnRFbnZlbG9wZSB9IGZyb20gJ0BobWgtZGVza3RvcC9jb250cmFjdHMnO1xyXG5pbXBvcnQgeyBhdHRhY2hVaVZlcmlmeSB9IGZyb20gJy4vdWl2ZXJpZnkudHMnO1xyXG5pbXBvcnQgeyBhdHRhY2hWaXN1YWxSZWdyZXNzaW9uIH0gZnJvbSAnLi92aXN1YWxyZWdyZXNzaW9uLnRzJztcclxuaW1wb3J0IHsgaW5zdGFsbFRhcmdldCwgcmVzb2x2ZUluc3RhbGxlZEVudHJ5LCBzdGFydENsaUluc3RhbGwsIHR5cGUgSW5zdGFsbFByb2dyZXNzIH0gZnJvbSAnLi9pbnN0YWxsZXIudHMnO1xyXG5pbXBvcnQgeyBvcmRlcmVkQ2hlY2tDaGFubmVscywgZG93bmxvYWRDYW5kaWRhdGVzLCBub3JtYWxpemVDaGFubmVsLCBub3JtYWxpemVSZWxlYXNlLCBwaWNrSW5zdGFsbGVyQXNzZXQsIHNpemVNYXRjaGVzLCBzdW1tYXJpemVDaGVja0ZhaWx1cmVzLCBjbXBWZXJzaW9uLCB0eXBlIExhdGVzdFJlbGVhc2UsIHR5cGUgUmVsZWFzZUFzc2V0LCB0eXBlIFVwZGF0ZUNoYW5uZWxJZCwgdHlwZSBVcGRhdGVSZXBvcyB9IGZyb20gJy4vdXBkYXRlci1jaGFubmVscy50cyc7XHJcblxyXG5jb25zdCBoZXJlID0gaW1wb3J0Lm1ldGEuZGlybmFtZSA/PyAnLic7XHJcbmNvbnN0IGlzRGV2ID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfREVWID09PSAnMSc7XHJcbmNvbnN0IHJlbmRlcmVyRGV2VXJsID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfUkVOREVSRVJfVVJMID8/ICcnO1xyXG5jb25zdCBwcmVsb2FkUGF0aCA9IGpvaW4oaGVyZSwgJy4uL3ByZWxvYWQvaW5kZXguY2pzJyk7XHJcblxyXG4vKiAtLS0tIFx1NjVFNVx1NUZEN1x1ODEzMVx1NjU0Rjp0b2tlbi9hdXRob3JpemF0aW9uIFx1NkMzOFx1NEUwRFx1OEZEQlx1NjNBN1x1NTIzNlx1NTNGMCAtLS0tICovXHJcbmNvbnN0IHNlY3JldHM6IHN0cmluZ1tdID0gW107XHJcbmZ1bmN0aW9uIHJlZGFjdChzOiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gIGxldCBvdXQgPSBzO1xyXG4gIGZvciAoY29uc3Qgc2VjIG9mIHNlY3JldHMpIHtcclxuICAgIGlmIChzZWMubGVuZ3RoID49IDgpIG91dCA9IG91dC5zcGxpdChzZWMpLmpvaW4oJ1tyZWRhY3RlZF0nKTtcclxuICB9XHJcbiAgcmV0dXJuIG91dDtcclxufVxyXG5mdW5jdGlvbiBsb2dJbmZvKHRhZzogc3RyaW5nLCBtc2c6IHN0cmluZyk6IHZvaWQge1xyXG4gIGNvbnNvbGUubG9nKGBbaG1oLWRlc2t0b3A6JHt0YWd9XSAke3JlZGFjdChtc2cpfWApO1xyXG59XHJcblxyXG4vKiAtLS0tIFx1NTM1NVx1NUI5RVx1NEY4QiAtLS0tICovXHJcbmlmICghYXBwLnJlcXVlc3RTaW5nbGVJbnN0YW5jZUxvY2soKSkge1xyXG4gIGFwcC5xdWl0KCk7XHJcbn0gZWxzZSB7XHJcbiAgYXBwLm9uKCdzZWNvbmQtaW5zdGFuY2UnLCAoKSA9PiB7XHJcbiAgICBjb25zdCB3aW4gPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKVswXTtcclxuICAgIGlmICh3aW4pIHtcclxuICAgICAgaWYgKHdpbi5pc01pbmltaXplZCgpKSB3aW4ucmVzdG9yZSgpO1xyXG4gICAgICB3aW4uZm9jdXMoKTtcclxuICAgIH1cclxuICB9KTtcclxuXHJcbiAgLyogLS0tLSBob3N0IFx1NzZEMVx1N0JBMSArIFx1Njg2NVx1NUJBMlx1NjIzN1x1N0FFRiAtLS0tICovXHJcbiAgaW50ZXJmYWNlIEJyaWRnZVNuYXBzaG90IHtcclxuICAgIGhvc3RTdGF0ZTogSG9zdFN0YXRlO1xyXG4gICAgaG9zdFBvcnQ6IG51bWJlciB8IG51bGw7XHJcbiAgICBob3N0VmVyc2lvbjogc3RyaW5nIHwgbnVsbDtcclxuICAgIGxhc3RFcnJvcjogc3RyaW5nIHwgbnVsbDtcclxuICAgIG1vZGU6ICdmYWtlJyB8ICdyZWFsJztcclxuICAgIHJ1bnRpbWVFbnRyeTogc3RyaW5nIHwgbnVsbDtcclxuICB9XHJcbiAgbGV0IHN1cGVydmlzb3I6IERlc2t0b3BSdW50aW1lU3VwZXJ2aXNvciB8IG51bGwgPSBudWxsO1xyXG4gIGxldCBjbGllbnQ6IERlc2t0b3BIb3N0Q2xpZW50IHwgbnVsbCA9IG51bGw7XHJcbiAgbGV0IGJyaWRnZTogQnJpZGdlU25hcHNob3QgPSB7IGhvc3RTdGF0ZTogJ3N0b3BwZWQnLCBob3N0UG9ydDogbnVsbCwgaG9zdFZlcnNpb246IG51bGwsIGxhc3RFcnJvcjogbnVsbCwgbW9kZTogJ2Zha2UnLCBydW50aW1lRW50cnk6IG51bGwgfTtcclxuICAvKiogXHU0RThCXHU0RUY2XHU2Mjc5XHU5MUNGXHU3RjEzXHU1MUIyOlx1OUFEOFx1OTg5MSBTU0UgXHU0RTBEXHU5MDEwXHU2NzYxXHU4RkM3IElQQyw1MG1zIFx1NjI3OVx1OTFDRiBmbHVzaChcdTZFMzJcdTY3RDNcdTRFMERcdTUzNjEpXHUzMDAyICovXHJcbiAgbGV0IGV2ZW50QnVmZmVyOiBFdmVudEVudmVsb3BlW10gPSBbXTtcclxuICBsZXQgZmx1c2hUaW1lcjogTm9kZUpTLlRpbWVvdXQgfCBudWxsID0gbnVsbDtcclxuICBsZXQgc3NlQWJvcnQ6IEFib3J0Q29udHJvbGxlciB8IG51bGwgPSBudWxsO1xyXG4gIGxldCBsYXN0RXZlbnRJZCA9ICcnO1xyXG4gIC8qKiBcdTY3MkFcdTc3RTUvXHU3NTc4XHU1RjYyXHU0RkUxXHU1QzAxXHU4QkExXHU2NTcwKFNDSEVNQV9NSVNNQVRDSCBcdTk3NjJcdTU0MTFcdThCQ0FcdTY1QUQsXHU0RTBEXHU1RDI5KVx1MzAwMiAqL1xyXG4gIGxldCBkcm9wcGVkRnJhbWVzID0gMDtcclxuXHJcbiAgZnVuY3Rpb24gcHVzaEV2ZW50KGVudjogRXZlbnRFbnZlbG9wZSk6IHZvaWQge1xyXG4gICAgZXZlbnRCdWZmZXIucHVzaChlbnYpO1xyXG4gICAgaWYgKGV2ZW50QnVmZmVyLmxlbmd0aCA+IDJfMDAwKSBldmVudEJ1ZmZlci5zcGxpY2UoMCwgZXZlbnRCdWZmZXIubGVuZ3RoIC0gMl8wMDApO1xyXG4gICAgaWYgKGZsdXNoVGltZXIgPT09IG51bGwpIHtcclxuICAgICAgZmx1c2hUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xyXG4gICAgICAgIGZsdXNoVGltZXIgPSBudWxsO1xyXG4gICAgICAgIGNvbnN0IGJhdGNoID0gZXZlbnRCdWZmZXI7XHJcbiAgICAgICAgZXZlbnRCdWZmZXIgPSBbXTtcclxuICAgICAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcclxuICAgICAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ2JyaWRnZTpldmVudC1iYXRjaCcsIGJhdGNoKTtcclxuICAgICAgICB9XHJcbiAgICAgIH0sIDUwKTtcclxuICAgIH1cclxuICAgIG5vdGlmeUV2ZW50KGVudik7XHJcbiAgfVxyXG5cclxuICAvKiAtLS0tIFx1N0NGQlx1N0VERlx1NjI1OFx1NzZEOCArIFx1OTAxQVx1NzdFNSgwMyBcdTUzRjcgXHUwMEE3XHU0RTAwOlx1Njg0Q1x1OTc2Mlx1NEVBN1x1NTRDMVx1OTcwMFx1ODk4MVx1N0NGQlx1N0VERlx1NjI1OFx1NzZEOFx1MzAwMVx1OTAxQVx1NzdFNSkgLS0tLVxyXG4gICAgIFx1NUJBMVx1NjI3OVx1N0I0OVx1NUY4NVx1NUZDNVx1OTg3Qlx1NjI1M1x1NjI3MChcdTc1MjhcdTYyMzdcdTVGQzVcdTk4N0JcdTUxQjNcdTdCNTYpO1x1NUI4Q1x1NjIxMC9cdTU5MzFcdThEMjVcdTRFQzVcdTU3MjhcdTdBOTdcdTUzRTNcdTU5MzFcdTcxMjZcdTY1RjZcdTYzRDBcdTkxOTJcdTMwMDIgKi9cclxuICBjb25zdCBUUkFZX0lDT05fQkFTRTY0ID0gJ2lWQk9SdzBLR2dvQUFBQU5TVWhFVWdBQUFCQUFBQUFRQ0FZQUFBQWY4LzloQUFBQVIwbEVRVlI0bkdOZ1FBUFNzb3IvOFdGMDlVUnJ4R3NRcVpveERJRUo2RGQrQjJOMGhiakVNV3duMVFDd0lZUFRBRnlZZmdZTWZCaVFaQURGQ1lrcVNabml6RVJKZGdZQWxMNXJzRGMyYVRjQUFBQUFTVVZPUks1Q1lJST0nO1xyXG4gIGxldCB0cmF5OiBUcmF5IHwgbnVsbCA9IG51bGw7XHJcbiAgY29uc3Qgc2VuZE1lbnVBY3Rpb24gPSAoYTogc3RyaW5nKTogdm9pZCA9PiB7XHJcbiAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcclxuICAgICAgaWYgKCF3LmlzRGVzdHJveWVkKCkpIHcud2ViQ29udGVudHMuc2VuZCgnbWVudTphY3Rpb24nLCBhKTtcclxuICAgIH1cclxuICB9O1xyXG4gIGZ1bmN0aW9uIGZvY3VzTWFpbldpbmRvdygpOiB2b2lkIHtcclxuICAgIGNvbnN0IHdpbiA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmZpbmQoKHcpID0+ICF3LmlzRGVzdHJveWVkKCkpO1xyXG4gICAgaWYgKHdpbiA9PT0gdW5kZWZpbmVkKSByZXR1cm47XHJcbiAgICBpZiAod2luLmlzTWluaW1pemVkKCkpIHdpbi5yZXN0b3JlKCk7XHJcbiAgICB3aW4uc2hvdygpO1xyXG4gICAgd2luLmZvY3VzKCk7XHJcbiAgfVxyXG4gIGZ1bmN0aW9uIHNldHVwVHJheSgpOiB2b2lkIHtcclxuICAgIGlmICh0cmF5ICE9PSBudWxsKSByZXR1cm47XHJcbiAgICBjb25zdCBpY29uID0gbmF0aXZlSW1hZ2UuY3JlYXRlRnJvbURhdGFVUkwoYGRhdGE6aW1hZ2UvcG5nO2Jhc2U2NCwke1RSQVlfSUNPTl9CQVNFNjR9YCk7XHJcbiAgICB0cmF5ID0gbmV3IFRyYXkoaWNvbik7XHJcbiAgICB0cmF5LnNldFRvb2xUaXAoJ0hNSCBEZXNrdG9wJyk7XHJcbiAgICB0cmF5Lm9uKCdjbGljaycsIGZvY3VzTWFpbldpbmRvdyk7XHJcbiAgICB0cmF5LnNldENvbnRleHRNZW51KE1lbnUuYnVpbGRGcm9tVGVtcGxhdGUoW1xyXG4gICAgICB7IGxhYmVsOiAnXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREJywgY2xpY2s6ICgpOiB2b2lkID0+IHNlbmRNZW51QWN0aW9uKCduZXctc2Vzc2lvbicpIH0sXHJcbiAgICAgIHsgbGFiZWw6ICdcdTY2M0VcdTc5M0FcdTRFM0JcdTdBOTdcdTUzRTMnLCBjbGljazogZm9jdXNNYWluV2luZG93IH0sXHJcbiAgICAgIHsgbGFiZWw6ICdcdTYyNEJcdTY3M0FcdThGRENcdTdBMEJcdTYzQTdcdTUyMzYnLCBjbGljazogKCk6IHZvaWQgPT4gc2VuZE1lbnVBY3Rpb24oJ29wZW4tcmVtb3RlJykgfSxcclxuICAgICAgeyBsYWJlbDogJ1x1OEJCRVx1N0Y2RScsIGNsaWNrOiAoKTogdm9pZCA9PiBzZW5kTWVudUFjdGlvbignb3Blbi1zZXR0aW5ncycpIH0sXHJcbiAgICAgIHsgdHlwZTogJ3NlcGFyYXRvcicgfSxcclxuICAgICAgeyBsYWJlbDogJ1x1OTAwMFx1NTFGQScsIGNsaWNrOiAoKTogdm9pZCA9PiB7IGFwcC5xdWl0KCk7IH0gfSxcclxuICAgIF0pKTtcclxuICB9XHJcbiAgZnVuY3Rpb24gbm90aWZ5RXZlbnQoZW52OiBFdmVudEVudmVsb3BlKTogdm9pZCB7XHJcbiAgICAvLyBcdTlBOENcdTY1MzYvXHU2MjJBXHU1NkZFL1x1NkUzMlx1NjdEM1x1NjNBMlx1OTQ4OC9cdTg5QzZcdTg5QzlcdTU2REVcdTVGNTJcdTZBMjFcdTVGMEZcdTk3NTlcdTlFRDgoXHU0RTBEXHU1RjgwXHU3NTI4XHU2MjM3XHU2ODRDXHU5NzYyXHU1RjM5XHU2RDRCXHU4QkQ1XHU5MDFBXHU3N0U1KVxyXG4gICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZID09PSAnMScgfHwgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfU05BUFNIT1QgIT09IHVuZGVmaW5lZCB8fCBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9SRU5ERVJfVEVTVCA9PT0gJzEnIHx8IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1ZJU1JFRyA9PT0gJzEnKSByZXR1cm47XHJcbiAgICBpZiAoIU5vdGlmaWNhdGlvbi5pc1N1cHBvcnRlZCgpKSByZXR1cm47XHJcbiAgICBjb25zdCB3aW4gPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5maW5kKCh3KSA9PiAhdy5pc0Rlc3Ryb3llZCgpKTtcclxuICAgIGNvbnN0IGZvY3VzZWQgPSB3aW4/LmlzRm9jdXNlZCgpID8/IGZhbHNlO1xyXG4gICAgY29uc3QgbWsgPSAodGl0bGU6IHN0cmluZywgYm9keTogc3RyaW5nKTogdm9pZCA9PiB7XHJcbiAgICAgIGNvbnN0IG4gPSBuZXcgTm90aWZpY2F0aW9uKHsgdGl0bGUsIGJvZHksIGljb246IG5hdGl2ZUltYWdlLmNyZWF0ZUZyb21EYXRhVVJMKGBkYXRhOmltYWdlL3BuZztiYXNlNjQsJHtUUkFZX0lDT05fQkFTRTY0fWApIH0pO1xyXG4gICAgICBuLm9uKCdjbGljaycsIGZvY3VzTWFpbldpbmRvdyk7XHJcbiAgICAgIG4uc2hvdygpO1xyXG4gICAgfTtcclxuICAgIGlmIChlbnYua2luZCA9PT0gJ2FwcHJvdmFsLnJlcXVpcmVkJykge1xyXG4gICAgICBjb25zdCBwID0gZW52LnBheWxvYWQgYXMgeyB0b29sPzogc3RyaW5nIH07XHJcbiAgICAgIG1rKCdITUggXHU5NzAwXHU4OTgxXHU1QkExXHU2Mjc5JywgYCR7U3RyaW5nKHAudG9vbCA/PyAnXHU2NENEXHU0RjVDJyl9IFx1N0I0OVx1NUY4NVx1NEY2MFx1NzY4NFx1NjI3OVx1NTFDNmApO1xyXG4gICAgfSBlbHNlIGlmIChlbnYua2luZCA9PT0gJ3J1bi5jb21wbGV0ZWQnICYmICFmb2N1c2VkKSB7XHJcbiAgICAgIG1rKCdITUggXHU0RUZCXHU1MkExXHU1QjhDXHU2MjEwJywgYFx1NEYxQVx1OEJERCAke2Vudi5zZXNzaW9uSWR9IFx1NzY4NFx1NEVGQlx1NTJBMVx1NURGMlx1NUI4Q1x1NjIxMGApO1xyXG4gICAgfSBlbHNlIGlmIChlbnYua2luZCA9PT0gJ3J1bi5mYWlsZWQnICYmICFmb2N1c2VkKSB7XHJcbiAgICAgIG1rKCdITUggXHU0RUZCXHU1MkExXHU1OTMxXHU4RDI1JywgYFx1NEYxQVx1OEJERCAke2Vudi5zZXNzaW9uSWR9IFx1NzY4NFx1NEVGQlx1NTJBMVx1NTkzMVx1OEQyNSxcdTcwQjlcdTUxRkJcdTY3RTVcdTc3MEJgKTtcclxuICAgIH1cclxuICB9XHJcblxyXG4gIC8qIC0tLS0gXHU4MUVBXHU1QjlBXHU0RTQ5XHU2ODA3XHU5ODk4XHU2ODBGKDIwMjYtMTAtMTEgXHU3NTI4XHU2MjM3XHU1M0NEXHU5OTg4Olx1NEVBRVx1ODI3Mlx1NkEyMVx1NUYwRlx1OTg3Nlx1OTBFOFx1OUVEMVx1Njc2MT1cdTUzOUZcdTc1MUZcdTgzRENcdTUzNTVcdTY4MEZcclxuICAgICBcdTRFMERcdThEREZcdTRFM0JcdTk4OTg7XHU4M0RDXHU1MzU1XHU0RTBFXHU4QkJFXHU3RjZFXHU5MUNEXHU1OTBEKSAtLS0tIFx1NjVCOVx1Njg0ODpcdTk2OTBcdTg1Q0ZcdTVGMEZcdTY4MDdcdTk4OThcdTY4MEYgKyB0aXRsZUJhck92ZXJsYXlcclxuICAgICAoXHU5ODlDXHU4MjcyXHU5NjhGXHU0RTNCXHU5ODk4KSxcdTgzRENcdTUzNTVcdTY4MEYgYXV0b0hpZGUoQWx0IFx1NTQ3Q1x1NTFGQSlcdTRFMTRcdTdDQkVcdTdCODBcdTRFM0FcdTdDRkJcdTdFREZcdTdFQTdcdTgwRkRcdTUyOUI7XHJcbiAgICAgXHU1RTM4XHU3NTI4XHU1MkE4XHU0RjVDXHU4RDcwIHJlbmRlcmVyIFx1NjgwN1x1OTg5OFx1NjgwRiBcdTI2MzAgXHU0RTNCXHU4M0RDXHU1MzU1KFx1NTUyRlx1NEUwMFx1NTE2NVx1NTNFMylcdTMwMDIgKi9cclxuICAvLyB2NCBEU0ggXHU4QkJFXHU4QkExXHU4QkVEXHU4QTAwOm92ZXJsYXkgXHU4MjcyXHU4RERGXHU5NjhGIHRpdGxlYmFyIFx1NzY4NCBiZy1sYXllci0xKFx1NkQ0NSAjZmZmL1x1NkRGMSAjMTYxODFkKVxyXG4gIGNvbnN0IGNocm9tZUZvciA9IChkYXJrOiBib29sZWFuKTogeyBjb2xvcjogc3RyaW5nOyBzeW1ib2xDb2xvcjogc3RyaW5nIH0gPT5cclxuICAgIGRhcmsgPyB7IGNvbG9yOiAnIzE2MTgxZCcsIHN5bWJvbENvbG9yOiAnI2Y1ZjZmOCcgfSA6IHsgY29sb3I6ICcjZmZmZmZmJywgc3ltYm9sQ29sb3I6ICcjMGYxMTE1JyB9O1xyXG4gIGZ1bmN0aW9uIGFwcGx5Q2hyb21lKGRhcms6IGJvb2xlYW4pOiB2b2lkIHtcclxuICAgIGZvciAoY29uc3QgdyBvZiBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKSkge1xyXG4gICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkge1xyXG4gICAgICAgIHRyeSB7IHcuc2V0VGl0bGVCYXJPdmVybGF5KGNocm9tZUZvcihkYXJrKSk7IH0gY2F0Y2ggeyAvKiBcdTRFQzUgV2luZG93cyBcdTY1MkZcdTYzMDEgKi8gfVxyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvKiAtLS0tIFx1NUU5NFx1NzUyOFx1NTE4NVx1NjZGNFx1NjVCMCgyMDI2LTEwLTI2Olx1ODFFQVx1NzgxNFx1OEY3Qlx1OTFDRlx1NjZGNFx1NjVCMFx1NTY2OCxcdTk2RjZcdTRGOURcdThENTY7R2l0SHViIFJlbGVhc2VzIFx1OTAxQVx1OTA1MylcclxuICAgICBcdTZENDFcdTdBMEI6XHU1NDJGXHU1MkE4IDMwcyBcdTU0MEVcdTk3NTlcdTlFRDhcdTY4QzBcdTY3RTUgXHUyMTkyIGZldGNoIGxhdGVzdCByZWxlYXNlIHRhZyBcdTIxOTIgXHU2QkQ0XHU3MjQ4XHU2NzJDIFx1MjE5MiBcdTU0MEVcdTUzRjBcdTZENDFcdTVGMEZcclxuICAgICBcdTRFMEJcdThGN0QgU2V0dXAgZXhlIFx1NTIzMFx1NEUzNFx1NjVGNlx1NzZFRVx1NUY1NShcdThGREJcdTVFQTZcdTYzQThcdTkwMDEgcmVuZGVyZXIgXHU2QTJBXHU1RTQ1KVx1MjE5MlwiXHU5MUNEXHU1NDJGXHU2NkY0XHU2NUIwXCJcdTIxOTIgXHU5MDAwXHU1MUZBXHU1RTk0XHU3NTI4XHJcbiAgICAgXHU1NDBFIE5TSVMgL1MgL0Q9XHU1MzlGXHU3NkVFXHU1RjU1IFx1OTc1OVx1OUVEOFx1ODk4Nlx1NzZENlx1NUI4OVx1ODhDNShcdTRFMEJcdTZCMjFcdTU0MkZcdTUyQThcdTUzNzNcdTY1QjBcdTcyNDgpXHUyMDE0XHUyMDE0XHU1MTY4XHU3QTBCXHU0RTBEXHU4REYzXHU2RDRGXHU4OUM4XHU1NjY4XHUzMDAyXHJcbiAgICAgMjAyNi0xMC0yOSBcdTUzQ0NcdTkwMUFcdTkwNTNcdTY4MzlcdTRGRUUoXHU3NTI4XHU2MjM3XHU1NkZEXHU1MTg1XHU2NTM2XHU0RTBEXHU1MjMwXHU2M0E4XHU5MDAxKTpcdTY4QzBcdTY3RTVcdTkwMUFcdTkwNTNcdTk1NUNcdTUwQ0ZcdTU2REVcdTkwMDBcdTk0RkVcclxuICAgICAoXHU3NkY0XHU4RkRFIDhzIFx1MjE5MiBnaC1wcm94eSBcdTIxOTIgZ2hmYXN0KSsgXHU1NDdEXHU0RTJEXHU5MDFBXHU5MDUzXHU3Qzk4XHU2MDI3XHU4QkIwXHU1RkM2ICsgXHU0RTBCXHU4RjdEXHU1NDBDXHU2RTkwXHU0RjE4XHU1MTQ4XHUzMDAyXHJcbiAgICAgXHU1NDBDXHU2NUU1XHU0RUZCXHU1MkExIDEzLUM6YXRvbWdpdCBcdTU2RkRcdTUxODVcdTk5OTZcdTkwMDlcdTkwMUFcdTkwNTMoXHU5NEZFXHU3QjJDXHU0RThDXHU0RjRELFx1NTZGRFx1NTE4NVx1NzZGNFx1OEZERVx1NTMzRlx1NTQwRFx1NTNFRlx1OEJGQikrIFx1NkQ0MVx1NUYwRlxyXG4gICAgIFx1NEUwQlx1OEY3RFx1OEZEQlx1NUVBNiArIFx1NEUwQlx1OEY3RCBzaXplIFx1NjgyMVx1OUE4QyArIFwiXHU5MUNEXHU1NDJGXHU2NkY0XHU2NUIwXCJcdTk3NUVcdTZBMjFcdTYwMDFcdTZBMkFcdTVFNDUocmVuZGVyZXIpXHUzMDAyXHJcbiAgICAgXHU2NUNCXHU5NEFFOlVQREFURV9SRVBPIC8gVVBEQVRFX1JFUE9fQVRPTUdJVCBcdTg5ODZcdTc2RDZcdTUzQ0NcdTRFRDM7SE1IX0RFU0tUT1BfVVBEQVRFX0ZPUkNFX1RBR1xyXG4gICAgIFx1OTc1RVx1N0E3QSBcdTIxOTIgXHU2NUUwXHU4OUM2XHU3MjQ4XHU2NzJDXHU2QkQ0XHU4RjgzXHU1RjNBXHU1MjM2XHU4RDcwXHU2NkY0XHU2NUIwXHU2RDQxXHU3QTBCKFx1OUE4Q1x1NjUzNlx1NzUyOCxcdTRFMERcdTkxQ0RcdTYyNTNcdTUzMDUpXHUzMDAyICovXHJcbiAgY29uc3QgVVBEQVRFX1JFUE9TOiBVcGRhdGVSZXBvcyA9IHtcclxuICAgIGdpdGh1YjogcHJvY2Vzcy5lbnYuVVBEQVRFX1JFUE8gPz8gJ3N3c2dibC9obWgtZGVza3RvcCcsXHJcbiAgICBhdG9tZ2l0OiBwcm9jZXNzLmVudi5VUERBVEVfUkVQT19BVE9NR0lUID8/ICdob25nZnUvaG1oLWRlc2t0b3AnLFxyXG4gIH07XHJcbiAgY29uc3QgVVBEQVRFX0ZPUkNFX1RBRyA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VQREFURV9GT1JDRV9UQUcgPz8gJyc7XHJcbiAgaW50ZXJmYWNlIFVwZGF0ZVByb2dyZXNzIHsgcmVjZWl2ZWQ6IG51bWJlcjsgdG90YWw6IG51bWJlcjsgc3BlZWRCcHM6IG51bWJlciB9XHJcbiAgaW50ZXJmYWNlIFVwZGF0ZVN0YXRlIHsgY2hlY2tpbmc6IGJvb2xlYW47IGN1cnJlbnRWZXJzaW9uOiBzdHJpbmc7IGxhdGVzdDogc3RyaW5nIHwgbnVsbDsgbm90ZXM6IHN0cmluZzsgZG93bmxvYWRlZDogYm9vbGVhbjsgZXJyb3I6IHN0cmluZzsgY2hhbm5lbDogc3RyaW5nOyBwcm9ncmVzczogVXBkYXRlUHJvZ3Jlc3MgfCBudWxsIH1cclxuICBsZXQgdXBkYXRlU3RhdGU6IFVwZGF0ZVN0YXRlID0geyBjaGVja2luZzogZmFsc2UsIGN1cnJlbnRWZXJzaW9uOiBhcHAuZ2V0VmVyc2lvbigpLCBsYXRlc3Q6IG51bGwsIG5vdGVzOiAnJywgZG93bmxvYWRlZDogZmFsc2UsIGVycm9yOiAnJywgY2hhbm5lbDogJycsIHByb2dyZXNzOiBudWxsIH07XHJcbiAgbGV0IGluc3RhbGxlclBhdGg6IHN0cmluZyB8IG51bGwgPSBudWxsO1xyXG4gIGNvbnN0IGJ1bXBVcGRhdGUgPSAocGF0Y2g6IFBhcnRpYWw8VXBkYXRlU3RhdGU+KTogdm9pZCA9PiB7XHJcbiAgICB1cGRhdGVTdGF0ZSA9IHsgLi4udXBkYXRlU3RhdGUsIC4uLnBhdGNoIH07XHJcbiAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcclxuICAgICAgaWYgKCF3LmlzRGVzdHJveWVkKCkpIHcud2ViQ29udGVudHMuc2VuZCgndXBkYXRlOnN0YXRlJywgdXBkYXRlU3RhdGUpO1xyXG4gICAgfVxyXG4gIH07XHJcbiAgLyoqIFx1OTAxQVx1OTA1M1x1N0M5OFx1NjAyNzpcdTRFMEFcdTZCMjFcdTYyMTBcdTUyOUZcdTU0N0RcdTRFMkRcdTc2ODRcdTY4QzBcdTY3RTVcdTkwMUFcdTkwNTModXNlckRhdGEvdXBkYXRlLWNoYW5uZWwuanNvbixcdTRFMEUgcnVudGltZS5qc29uIFx1NTQwQ1x1NkEyMVx1NUYwRilcdTMwMDIgKi9cclxuICBjb25zdCB1cGRhdGVDaGFubmVsRmlsZSA9ICgpOiBzdHJpbmcgPT4gam9pbihhcHAuZ2V0UGF0aCgndXNlckRhdGEnKSwgJ3VwZGF0ZS1jaGFubmVsLmpzb24nKTtcclxuICBhc3luYyBmdW5jdGlvbiBsb2FkU3RpY2t5Q2hhbm5lbCgpOiBQcm9taXNlPFVwZGF0ZUNoYW5uZWxJZCB8IG51bGw+IHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHYgPSBKU09OLnBhcnNlKGF3YWl0IHJlYWRGaWxlKHVwZGF0ZUNoYW5uZWxGaWxlKCksICd1dGY4JykpIGFzIHsgY2hhbm5lbD86IHVua25vd24gfTtcclxuICAgICAgcmV0dXJuIG5vcm1hbGl6ZUNoYW5uZWwodi5jaGFubmVsKTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4gbnVsbDsgfVxyXG4gIH1cclxuICBhc3luYyBmdW5jdGlvbiBzYXZlU3RpY2t5Q2hhbm5lbChpZDogVXBkYXRlQ2hhbm5lbElkKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBhd2FpdCB3cml0ZUZpbGUodXBkYXRlQ2hhbm5lbEZpbGUoKSwgSlNPTi5zdHJpbmdpZnkoeyBjaGFubmVsOiBpZCB9LCBudWxsLCAyKSwgJ3V0ZjgnKS5jYXRjaCgoKSA9PiB1bmRlZmluZWQpO1xyXG4gIH1cclxuICBhc3luYyBmdW5jdGlvbiBjaGVja0ZvclVwZGF0ZXMoKTogUHJvbWlzZTxVcGRhdGVTdGF0ZT4ge1xyXG4gICAgaWYgKHVwZGF0ZVN0YXRlLmNoZWNraW5nIHx8IHVwZGF0ZVN0YXRlLmRvd25sb2FkZWQpIHJldHVybiB1cGRhdGVTdGF0ZTtcclxuICAgIGJ1bXBVcGRhdGUoeyBjaGVja2luZzogdHJ1ZSwgZXJyb3I6ICcnIH0pO1xyXG4gICAgbG9nSW5mbygndXBkYXRlJywgYGNoZWNraW5nXHUyMDI2IChjdXJyZW50IHYke2FwcC5nZXRWZXJzaW9uKCl9KSR7VVBEQVRFX0ZPUkNFX1RBRyAhPT0gJycgPyBgIGZvcmNlLXRhZz0ke1VQREFURV9GT1JDRV9UQUd9YCA6ICcnfWApO1xyXG4gICAgY29uc3QgZmFpbHVyZXM6IEFycmF5PHsgbGFiZWw6IHN0cmluZzsgcmVhc29uOiBzdHJpbmcgfT4gPSBbXTtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHN0aWNreSA9IGF3YWl0IGxvYWRTdGlja3lDaGFubmVsKCk7XHJcbiAgICAgIGNvbnN0IGNoYW5uZWxzID0gb3JkZXJlZENoZWNrQ2hhbm5lbHMoc3RpY2t5ID8/IHVuZGVmaW5lZCk7XHJcbiAgICAgIGZvciAoY29uc3QgY2ggb2YgY2hhbm5lbHMpIHtcclxuICAgICAgICBsZXQgcmVsOiBMYXRlc3RSZWxlYXNlIHwgbnVsbCA9IG51bGw7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgIGNvbnN0IHIgPSBhd2FpdCBmZXRjaChjaC5hcGlVcmwoVVBEQVRFX1JFUE9TKSwge1xyXG4gICAgICAgICAgICBoZWFkZXJzOiB7ICd1c2VyLWFnZW50JzogJ2htaC1kZXNrdG9wLXVwZGF0ZXInIH0sXHJcbiAgICAgICAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dChjaC50aW1lb3V0TXMpLFxyXG4gICAgICAgICAgfSk7XHJcbiAgICAgICAgICBpZiAoIXIub2spIHsgZmFpbHVyZXMucHVzaCh7IGxhYmVsOiBjaC5sYWJlbCwgcmVhc29uOiBgSFRUUCAke3Iuc3RhdHVzfWAgfSk7IGxvZ0luZm8oJ3VwZGF0ZScsIGAke2NoLmxhYmVsfSBcdTIxOTIgSFRUUCAke3Iuc3RhdHVzfWApOyBjb250aW51ZTsgfVxyXG4gICAgICAgICAgLy8gXHU5NTVDXHU1MENGXHU1M0VGXHU4MEZEXHU1NkRFIDIwMCBcdTRGNDZcdTUxODVcdTVCQjlcdTk3NUUgSlNPTihIVE1MIFx1OTUxOVx1OEJFRlx1OTg3NSk7R2l0SHViIFx1NTZERVx1NUJGOVx1OEM2MVx1MzAwMWF0b21naXRcclxuICAgICAgICAgIC8vIFx1NTZERVx1NjU3MFx1N0VDNFx1MjAxNFx1MjAxNG5vcm1hbGl6ZVJlbGVhc2UgXHU3RURGXHU0RTAwXHU1RjUyXHU0RTAwLFx1NUY2Mlx1NzJCNlx1NEUwRFx1NUJGOVx1NjMwOVx1NjcyQ1x1OTAxQVx1OTA1M1x1NTkzMVx1OEQyNVx1NTZERVx1OTAwMFxyXG4gICAgICAgICAgcmVsID0gbm9ybWFsaXplUmVsZWFzZShhd2FpdCByLmpzb24oKSk7XHJcbiAgICAgICAgICBpZiAocmVsID09PSBudWxsKSB7IGZhaWx1cmVzLnB1c2goeyBsYWJlbDogY2gubGFiZWwsIHJlYXNvbjogJ1x1NTRDRFx1NUU5NFx1NjVFMCB0YWdfbmFtZScgfSk7IGxvZ0luZm8oJ3VwZGF0ZScsIGAke2NoLmxhYmVsfSBcdTIxOTIgXHU2NUUwIHRhZ19uYW1lYCk7IGNvbnRpbnVlOyB9XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgICBjb25zdCBlID0gZXJyIGFzIHsgY2F1c2U/OiB7IGNvZGU/OiB1bmtub3duIH0gfTtcclxuICAgICAgICAgIGNvbnN0IHJlYXNvbiA9IGVyciBpbnN0YW5jZW9mIEVycm9yICYmIGVyci5uYW1lID09PSAnVGltZW91dEVycm9yJ1xyXG4gICAgICAgICAgICA/IGBcdThEODVcdTY1RjYoJHtNYXRoLnJvdW5kKGNoLnRpbWVvdXRNcyAvIDEwMDApfXMpYFxyXG4gICAgICAgICAgICA6IFN0cmluZyhlLmNhdXNlPy5jb2RlID8/IGVycikuc2xpY2UoMCwgNjApO1xyXG4gICAgICAgICAgZmFpbHVyZXMucHVzaCh7IGxhYmVsOiBjaC5sYWJlbCwgcmVhc29uIH0pO1xyXG4gICAgICAgICAgbG9nSW5mbygndXBkYXRlJywgYCR7Y2gubGFiZWx9IFx1MjE5MiBmYWlsICR7cmVhc29ufWApO1xyXG4gICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHRhZyA9IHJlbC50YWdfbmFtZTtcclxuICAgICAgICBsb2dJbmZvKCd1cGRhdGUnLCBgbGF0ZXN0PSR7dGFnfSBhc3NldHM9JHsocmVsLmFzc2V0cyA/PyBbXSkubGVuZ3RofSB2aWEgJHtjaC5sYWJlbH0ke3N0aWNreSA9PT0gY2guaWQgPyAnKHN0aWNreSknIDogJyd9YCk7XHJcbiAgICAgICAgYXdhaXQgc2F2ZVN0aWNreUNoYW5uZWwoY2guaWQpOyAvLyBcdTdDOThcdTYwMjc6XHU0RTBCXHU2QjIxXHU1MTQ4XHU4QkQ1XHU2NzJDXHU5MDFBXHU5MDUzXHJcbiAgICAgICAgYnVtcFVwZGF0ZSh7IGNoZWNraW5nOiBmYWxzZSwgbGF0ZXN0OiB0YWcsIG5vdGVzOiBTdHJpbmcocmVsLmJvZHkgPz8gJycpLnNsaWNlKDAsIDYwMCksIGNoYW5uZWw6IGNoLmlkIH0pO1xyXG4gICAgICAgIC8vIFx1NjcwOVx1NjVCMFx1NzI0OChcdTYyMTYgRk9SQ0VfVEFHIFx1OUE4Q1x1NjUzNlx1NjVDQlx1OTRBRSlcdTRFMTRcdTY3MkFcdTRFMEJcdThGN0RcdThGQzcgXHUyMTkyIFx1NTQwRVx1NTNGMFx1NEUwQlx1OEY3RFx1NUI4OVx1ODhDNVx1NTMwNVxyXG4gICAgICAgIGlmICgoVVBEQVRFX0ZPUkNFX1RBRyAhPT0gJycgfHwgY21wVmVyc2lvbihhcHAuZ2V0VmVyc2lvbigpLCB0YWcpIDwgMCkgJiYgIXVwZGF0ZVN0YXRlLmRvd25sb2FkZWQpIHtcclxuICAgICAgICAgIHZvaWQgZG93bmxvYWRJbnN0YWxsZXIocmVsLmFzc2V0cyA/PyBbXSwgdGFnKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHVwZGF0ZVN0YXRlO1xyXG4gICAgICB9XHJcbiAgICAgIGNvbnN0IHN1bW1hcnkgPSBzdW1tYXJpemVDaGVja0ZhaWx1cmVzKGZhaWx1cmVzKTtcclxuICAgICAgbG9nSW5mbygndXBkYXRlJywgYGNoZWNrIGZhaWxlZDogYWxsIGNoYW5uZWxzICgke3N1bW1hcnl9KWApO1xyXG4gICAgICBidW1wVXBkYXRlKHsgY2hlY2tpbmc6IGZhbHNlLCBlcnJvcjogYFx1NTE2OFx1OTBFOFx1NjhDMFx1NjdFNVx1OTAxQVx1OTA1M1x1NTkzMVx1OEQyNSgke3N1bW1hcnl9KWAuc2xpY2UoMCwgMjAwKSB9KTtcclxuICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICBsb2dJbmZvKCd1cGRhdGUnLCBgY2hlY2sgZmFpbGVkOiAke1N0cmluZyhlcnIpLnNsaWNlKDAsIDE0MCl9YCk7XHJcbiAgICAgIGJ1bXBVcGRhdGUoeyBjaGVja2luZzogZmFsc2UsIGVycm9yOiBTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApIH0pO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHVwZGF0ZVN0YXRlO1xyXG4gIH1cclxuICAvKiogXHU1NDBFXHU1M0YwXHU2RDQxXHU1RjBGXHU0RTBCXHU4RjdEXHU1Qjg5XHU4OEM1XHU1MzA1Olx1NTIwNlx1NTc1N1x1NTE5OVx1NzZEOCgxMTJNQiBcdTRFMERcdTUxOERcdTY1NzRcdTlBN0JcdTUxODVcdTVCNTgpLFx1OEZEQlx1NUVBNihcdTVERjJcdTRFMEJcdThGN0QvXHU2MDNCXHU1QjU3XHU4MjgyL1xyXG4gICAqICBcdTkwMUZcdTVFQTYpXHU3RUNGIHVwZGF0ZTpzdGF0ZSBcdTYzQTggcmVuZGVyZXIgXHU2QTJBXHU1RTQ1O1x1ODQzRFx1NzZEOFx1NTQwRVx1NjMwOVx1OEQ0NFx1NEVBN1x1NTE0M1x1NjU3MFx1NjM2RSBzaXplIFx1NjgyMVx1OUE4Q1x1MzAwMiAqL1xyXG4gIGFzeW5jIGZ1bmN0aW9uIGRvd25sb2FkSW5zdGFsbGVyKGFzc2V0czogcmVhZG9ubHkgUmVsZWFzZUFzc2V0W10sIHRhZzogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCBhc3NldCA9IHBpY2tJbnN0YWxsZXJBc3NldChhc3NldHMpO1xyXG4gICAgICBpZiAoYXNzZXQgPT09IG51bGwpIHsgYnVtcFVwZGF0ZSh7IGVycm9yOiAncmVsZWFzZSBcdTY1RTBcdTVCODlcdTg4QzVcdTUzMDVcdThENDRcdTRFQTcnIH0pOyByZXR1cm47IH1cclxuICAgICAgY29uc3QgZGVzdCA9IGpvaW4oYXBwLmdldFBhdGgoJ3RlbXAnKSwgYXNzZXQubmFtZSk7XHJcbiAgICAgIC8vIFx1NEUwQVx1NkIyMVx1NEYxQVx1OEJERFx1NURGMlx1NjI4QVx1NTQwQ1x1NzI0OFx1NjcyQ1x1NUI4OVx1ODhDNVx1NTMwNVx1NUI4Q1x1NjU3NFx1NEUwQlx1NTIzMFx1NEUzNFx1NjVGNlx1NzZFRVx1NUY1NShzaXplIFx1NUJGOVx1NUY5N1x1NEUwQSlcdTIxOTIgXHU3NkY0XHU2M0E1XHU1OTBEXHU3NTI4LFxyXG4gICAgICAvLyBcdTRFMERcdTUxOERcdTYyQzkgMTEyTUI7XHU4RkQ5XHU1QzMxXHU2NjJGXCJcdTc1MjhcdTYyMzdcdTVGRkRcdTc1NjVcdTZBMkFcdTVFNDVcdTdFRTdcdTdFRURcdTc1MjgsXHU0RTBCXHU2QjIxXHU1NDJGXHU1MkE4XHU0RUNEXHU0RTAwXHU5NTJFXHU1M0VGXHU4OEM1XCJcdTc2ODRcdTg0M0RcdTU3MzBcdTMwMDJcclxuICAgICAgdHJ5IHtcclxuICAgICAgICBjb25zdCBzdCA9IGF3YWl0IHN0YXQoZGVzdCk7XHJcbiAgICAgICAgaWYgKHNpemVNYXRjaGVzKGFzc2V0LnNpemUsIHN0LnNpemUpKSB7XHJcbiAgICAgICAgICBpbnN0YWxsZXJQYXRoID0gZGVzdDtcclxuICAgICAgICAgIGJ1bXBVcGRhdGUoeyBkb3dubG9hZGVkOiB0cnVlLCBwcm9ncmVzczogbnVsbCB9KTtcclxuICAgICAgICAgIGxvZ0luZm8oJ3VwZGF0ZScsIGBcdTU5MERcdTc1MjhcdTVERjJcdTRFMEJcdThGN0QgJHthc3NldC5uYW1lfSgke01hdGgucm91bmQoc3Quc2l6ZSAvIDFlNil9TUIpIFx1MjE5MiAke2Rlc3R9YCk7XHJcbiAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICB9IGNhdGNoIHsgLyogXHU0RTBEXHU1QjU4XHU1NzI4XHU1MjE5XHU2QjYzXHU1RTM4XHU0RTBCXHU4RjdEICovIH1cclxuICAgICAgLy8gXHU0RTBCXHU4RjdEXHU1MDE5XHU5MDA5XHU5NEZFOmF0b21naXQgXHU1NDdEXHU0RTJEIFx1MjE5MiBhdG9tZ2l0IFx1NzZGNFx1OTRGRS9BUEkgXHU3QUVGXHU3MEI5XHU0RjE4XHU1MTQ4LEdpdEh1YiBcdTRFM0JcdTRFRDNcdTk1NUNcdTUwQ0ZcdTUxNUNcdTVFOTVcclxuICAgICAgY29uc3QgY2FuZGlkYXRlcyA9IGRvd25sb2FkQ2FuZGlkYXRlcyh7IGNoYW5uZWw6IHVwZGF0ZVN0YXRlLmNoYW5uZWwsIHRhZywgYXNzZXRVcmw6IGFzc2V0LmJyb3dzZXJfZG93bmxvYWRfdXJsLCBhc3NldE5hbWU6IGFzc2V0Lm5hbWUsIHJlcG9zOiBVUERBVEVfUkVQT1MgfSk7XHJcbiAgICAgIGxldCBsYXN0RXJyID0gJyc7XHJcbiAgICAgIGZvciAoY29uc3QgdSBvZiBjYW5kaWRhdGVzKSB7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgIGxvZ0luZm8oJ3VwZGF0ZScsIGB0cnlpbmcgJHtuZXcgVVJMKHUpLmhvc3R9XHUyMDI2YCk7XHJcbiAgICAgICAgICBjb25zdCByID0gYXdhaXQgZmV0Y2godSwgeyBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoOTAwXzAwMCkgfSk7XHJcbiAgICAgICAgICBpZiAoIXIub2spIHsgbGFzdEVyciA9IGBIVFRQICR7ci5zdGF0dXN9YDsgbG9nSW5mbygndXBkYXRlJywgYFx1MjE5MiBIVFRQICR7ci5zdGF0dXN9YCk7IGNvbnRpbnVlOyB9XHJcbiAgICAgICAgICBpZiAoci5ib2R5ID09PSBudWxsKSB7IGxhc3RFcnIgPSAnXHU2NUUwXHU1NENEXHU1RTk0XHU0RjUzJzsgY29udGludWU7IH1cclxuICAgICAgICAgIGNvbnN0IHRvdGFsID0gTnVtYmVyKHIuaGVhZGVycy5nZXQoJ2NvbnRlbnQtbGVuZ3RoJykgPz8gMCkgPiAwID8gTnVtYmVyKHIuaGVhZGVycy5nZXQoJ2NvbnRlbnQtbGVuZ3RoJykpIDogYXNzZXQuc2l6ZTtcclxuICAgICAgICAgIGNvbnN0IGRlc3RUbXAgPSBgJHtkZXN0fS5wYXJ0YDtcclxuICAgICAgICAgIGNvbnN0IG91dCA9IGNyZWF0ZVdyaXRlU3RyZWFtKGRlc3RUbXApO1xyXG4gICAgICAgICAgbGV0IHJlY2VpdmVkID0gMDtcclxuICAgICAgICAgIGxldCBsYXN0QnVtcCA9IDA7XHJcbiAgICAgICAgICBjb25zdCB0MCA9IERhdGUubm93KCk7XHJcbiAgICAgICAgICBjb25zdCByZWFkZXIgPSByLmJvZHkuZ2V0UmVhZGVyKCk7XHJcbiAgICAgICAgICBmb3IgKDs7KSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHsgZG9uZSwgdmFsdWUgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XHJcbiAgICAgICAgICAgIGlmIChkb25lID09PSB0cnVlIHx8IHZhbHVlID09PSB1bmRlZmluZWQpIGJyZWFrO1xyXG4gICAgICAgICAgICByZWNlaXZlZCArPSB2YWx1ZS5ieXRlTGVuZ3RoO1xyXG4gICAgICAgICAgICBvdXQud3JpdGUodmFsdWUpO1xyXG4gICAgICAgICAgICAvLyBcdThGREJcdTVFQTZcdTgyODJcdTZENDE6XHUyMjY0IFx1NkJDRiA0MDBtcyBcdTRFMDBcdTVFMjcsSVBDIFx1NEUwRFx1NkQyQVx1NkNEQjtcdTk5OTZcdTU3NTdcdTdBQ0JcdTUzNzNcdTRFMEFcdTYyQTUoXHU2MDNCXHU1QjU3XHU4MjgyXHU1QzNEXHU1RkVCXHU1M0VGXHU4OUMxKVxyXG4gICAgICAgICAgICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xyXG4gICAgICAgICAgICBpZiAocmVjZWl2ZWQgPT09IHZhbHVlLmJ5dGVMZW5ndGggfHwgbm93IC0gbGFzdEJ1bXAgPiA0MDApIHtcclxuICAgICAgICAgICAgICBsYXN0QnVtcCA9IG5vdztcclxuICAgICAgICAgICAgICBidW1wVXBkYXRlKHsgcHJvZ3Jlc3M6IHsgcmVjZWl2ZWQsIHRvdGFsLCBzcGVlZEJwczogTWF0aC5yb3VuZChyZWNlaXZlZCAvIE1hdGgubWF4KChub3cgLSB0MCkgLyAxMDAwLCAwLjEpKSB9IH0pO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPigocmVzLCByZWopID0+IHsgb3V0LmVuZCgoZXJyPzogRXJyb3IgfCBudWxsKSA9PiB7IGlmIChlcnIgIT09IG51bGwgJiYgZXJyICE9PSB1bmRlZmluZWQpIHJlaihlcnIpOyBlbHNlIHJlcygpOyB9KTsgfSk7XHJcbiAgICAgICAgICBpZiAocmVjZWl2ZWQgPCAxXzAwMF8wMDApIHsgbGFzdEVyciA9IGBcdTUxODVcdTVCQjlcdTVGMDJcdTVFMzgoJHtyZWNlaXZlZH1CKWA7IGxvZ0luZm8oJ3VwZGF0ZScsIGBcdTIxOTIgJHtsYXN0RXJyfWApOyBjb250aW51ZTsgfVxyXG4gICAgICAgICAgaWYgKCFzaXplTWF0Y2hlcyhhc3NldC5zaXplLCByZWNlaXZlZCkpIHsgbGFzdEVyciA9IGBzaXplIFx1NEUwRFx1N0IyNihcdTUxNDNcdTY1NzBcdTYzNkUgJHthc3NldC5zaXplfUIgLyBcdTVCOUVcdTY1MzYgJHtyZWNlaXZlZH1CKWA7IGxvZ0luZm8oJ3VwZGF0ZScsIGBcdTIxOTIgJHtsYXN0RXJyfWApOyBjb250aW51ZTsgfVxyXG4gICAgICAgICAgYXdhaXQgcmVuYW1lKGRlc3RUbXAsIGRlc3QpO1xyXG4gICAgICAgICAgaW5zdGFsbGVyUGF0aCA9IGRlc3Q7XHJcbiAgICAgICAgICBidW1wVXBkYXRlKHsgZG93bmxvYWRlZDogdHJ1ZSwgcHJvZ3Jlc3M6IG51bGwgfSk7XHJcbiAgICAgICAgICBsb2dJbmZvKCd1cGRhdGUnLCBgXHU1REYyXHU0RTBCXHU4RjdEICR7YXNzZXQubmFtZX0oJHtNYXRoLnJvdW5kKHJlY2VpdmVkIC8gMWU2KX1NQikgXHUyMTkyICR7ZGVzdH1gKTtcclxuICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgICAgIGNvbnN0IGUgPSBlcnIgYXMgeyBjYXVzZT86IHsgY29kZT86IHVua25vd24gfSB9O1xyXG4gICAgICAgICAgbGFzdEVyciA9IFN0cmluZyhlLmNhdXNlPy5jb2RlID8/IGVycikuc2xpY2UoMCwgODApO1xyXG4gICAgICAgICAgbG9nSW5mbygndXBkYXRlJywgYFx1MjE5MiBmYWlsICR7bGFzdEVycn1gKTtcclxuICAgICAgICAgIGJ1bXBVcGRhdGUoeyBwcm9ncmVzczogbnVsbCB9KTtcclxuICAgICAgICB9XHJcbiAgICAgIH1cclxuICAgICAgYnVtcFVwZGF0ZSh7IGVycm9yOiBgXHU0RTBCXHU4RjdEXHU1OTMxXHU4RDI1Olx1NTE2OFx1OTBFOFx1NEUwQlx1OEY3RFx1OTAxQVx1OTA1M1x1NTkzMVx1OEQyNSgke2xhc3RFcnJ9KWAuc2xpY2UoMCwgMTYwKSwgcHJvZ3Jlc3M6IG51bGwgfSk7XHJcbiAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgYnVtcFVwZGF0ZSh7IGVycm9yOiBgXHU0RTBCXHU4RjdEXHU1OTMxXHU4RDI1OiAke1N0cmluZyhlcnIpLnNsaWNlKDAsIDEyMCl9YCwgcHJvZ3Jlc3M6IG51bGwgfSk7XHJcbiAgICB9XHJcbiAgfVxyXG4gIGZ1bmN0aW9uIGFwcGx5VXBkYXRlKCk6IHZvaWQge1xyXG4gICAgLy8gXHU5QThDXHU2NTM2XHU1M0VGXHU4OUMyXHU2RDRCOlx1NkJDRlx1NkIyMSBhcHBseSBcdThCRjdcdTZDNDJcdTkwRkRcdTc1NTlcdTY1RTVcdTVGRDcobW9jay9cdTY1RTBcdTVCODlcdTg4QzVcdTUzMDVcdTY1RjZcdTcwQjlcdTUxRkJcIlx1OTFDRFx1NTQyRlx1NjZGNFx1NjVCMFwiXHJcbiAgICAvLyBcdTRFMERcdTkwMDBcdTUxRkEsVUlWRVJJRlkgXHU2NUFEXHU4QTAwXCJcdTcwQjlcdTUxRkJcdTU0MEVcdThGREJcdTdBMEJcdTVCNThcdTZEM0JcIlx1OTE0RFx1NTQwOFx1OEZEOVx1ODg0Q1x1NjVFNVx1NUZEN1x1Njc4NFx1NjIxMFx1NUI4Q1x1NjU3NFx1OEJDMVx1NjM2RVx1OTRGRSlcdTMwMDJcclxuICAgIGxvZ0luZm8oJ3VwZGF0ZScsIGBhcHBseSByZXF1ZXN0ZWQgKGluc3RhbGxlcj0ke2luc3RhbGxlclBhdGggPT09IG51bGwgPyAnbm9uZScgOiBiYXNlbmFtZShpbnN0YWxsZXJQYXRoKX0pYCk7XHJcbiAgICBpZiAoaW5zdGFsbGVyUGF0aCA9PT0gbnVsbCkgcmV0dXJuO1xyXG4gICAgLy8gXHU5MDAwXHU1MUZBXHU1RjUzXHU1MjREXHU1RTk0XHU3NTI4XHU1NDBFXHU3NTMxXHU1Qjg5XHU4OEM1XHU1NjY4XHU5NzU5XHU5RUQ4XHU4OTg2XHU3NkQ2XHU1Qjg5XHU4OEM1KFx1ODhDNVx1NTZERVx1NTM5Rlx1NzZFRVx1NUY1NSlcdTMwMDJOU0lTIGFzc2lzdGVkIFx1ODlDNFx1NTIxOTpcclxuICAgIC8vIC9TIFx1NEUxNCAvRD1wYXRoIFx1NUZDNVx1OTg3Qlx1NjcwMFx1NTQwRVx1NEUwMFx1NEUyQVx1NTNDMlx1NjU3MFx1MzAwMVx1NTAzQ1x1NEUwRFx1NTJBMFx1NUYxNVx1NTNGNyhcdTU0MkJcdTdBN0FcdTY4M0NcdTRFNUZcdTRFMERcdTUyQTApXHUyMDE0XHUyMDE0bm9kZSBzcGF3blxyXG4gICAgLy8gXHU5RUQ4XHU4QkE0XHU0RjFBXHU3RUQ5XHU1NDJCXHU3QTdBXHU2ODNDXHU1M0MyXHU2NTcwXHU1MkEwXHU1RjE1XHU1M0Y3XHU1QkZDXHU4MUY0IE5TSVMgXHU4OUUzXHU2NzkwXHU5NTE5XHU4REVGXHU1Rjg0KFx1NUI5RVx1NkQ0Qlx1ODhDNVx1NTc0Rlx1NzZFRVx1NUY1NSksXHU2NTQ1XHU3NTI4XHJcbiAgICAvLyB3aW5kb3dzVmVyYmF0aW1Bcmd1bWVudHMgXHU1MzlGXHU2ODM3XHU0RjIwXHU5MDEyXHUzMDAyXHJcbiAgICBjb25zdCBpbnN0YWxsRGlyID0gZGlybmFtZShwcm9jZXNzLmV4ZWNQYXRoKTtcclxuICAgIGNvbnN0IGNoaWxkID0gc3Bhd24oYFwiJHtpbnN0YWxsZXJQYXRofVwiIC9TIC9EPSR7aW5zdGFsbERpcn1gLCB7XHJcbiAgICAgIGRldGFjaGVkOiB0cnVlLFxyXG4gICAgICBzdGRpbzogJ2lnbm9yZScsXHJcbiAgICAgIHdpbmRvd3NIaWRlOiB0cnVlLFxyXG4gICAgICBzaGVsbDogZmFsc2UsXHJcbiAgICAgIHdpbmRvd3NWZXJiYXRpbUFyZ3VtZW50czogdHJ1ZSxcclxuICAgIH0pO1xyXG4gICAgY2hpbGQudW5yZWYoKTtcclxuICAgIGxvZ0luZm8oJ3VwZGF0ZScsIGBhcHBseTogJHtpbnN0YWxsZXJQYXRofSBcdTIxOTIgJHtpbnN0YWxsRGlyfWApO1xyXG4gICAgYXBwLmV4aXQoMCk7XHJcbiAgfVxyXG5cclxuICBmdW5jdGlvbiBidWlsZEFwcE1lbnUoKTogdm9pZCB7XHJcbiAgICAvLyBcdTdDQkVcdTdCODA6XHU1M0VBXHU0RkREXHU3NTU5IFVJIFx1NkNBMVx1NjcwOVx1NzY4NFx1N0NGQlx1N0VERlx1N0VBN1x1ODBGRFx1NTI5QihcdTUyNkFcdThEMzRcdTY3N0YvXHU3QTk3XHU1M0UzKTtcdTUxNzZcdTRGNTlcdTU1MkZcdTRFMDBcdTUxNjVcdTUzRTNcdTU3MjggVUlcdTMwMDJcclxuICAgIGNvbnN0IHRlbXBsYXRlOiBBcnJheTxFbGVjdHJvbi5NZW51SXRlbUNvbnN0cnVjdG9yT3B0aW9ucz4gPSBbXHJcbiAgICAgIHtcclxuICAgICAgICBsYWJlbDogJ1x1N0YxNlx1OEY5MScsXHJcbiAgICAgICAgc3VibWVudTogW1xyXG4gICAgICAgICAgeyByb2xlOiAndW5kbycsIGxhYmVsOiAnXHU2NEE0XHU5NTAwJyB9LFxyXG4gICAgICAgICAgeyByb2xlOiAncmVkbycsIGxhYmVsOiAnXHU5MUNEXHU1MDVBJyB9LFxyXG4gICAgICAgICAgeyB0eXBlOiAnc2VwYXJhdG9yJyB9LFxyXG4gICAgICAgICAgeyByb2xlOiAnY3V0JywgbGFiZWw6ICdcdTUyNkFcdTUyMDcnIH0sXHJcbiAgICAgICAgICB7IHJvbGU6ICdjb3B5JywgbGFiZWw6ICdcdTU5MERcdTUyMzYnIH0sXHJcbiAgICAgICAgICB7IHJvbGU6ICdwYXN0ZScsIGxhYmVsOiAnXHU3Qzk4XHU4RDM0JyB9LFxyXG4gICAgICAgICAgeyByb2xlOiAnc2VsZWN0QWxsJywgbGFiZWw6ICdcdTUxNjhcdTkwMDknIH0sXHJcbiAgICAgICAgXSxcclxuICAgICAgfSxcclxuICAgICAge1xyXG4gICAgICAgIGxhYmVsOiAnXHU3QTk3XHU1M0UzJyxcclxuICAgICAgICBzdWJtZW51OiBbXHJcbiAgICAgICAgICB7IHJvbGU6ICdtaW5pbWl6ZScsIGxhYmVsOiAnXHU2NzAwXHU1QzBGXHU1MzE2JyB9LFxyXG4gICAgICAgICAgeyByb2xlOiAnem9vbScsIGxhYmVsOiAnXHU3RjI5XHU2NTNFJyB9LFxyXG4gICAgICAgICAgeyB0eXBlOiAnc2VwYXJhdG9yJyB9LFxyXG4gICAgICAgICAgeyByb2xlOiAnY2xvc2UnLCBsYWJlbDogJ1x1NTE3M1x1OTVFRCcgfSxcclxuICAgICAgICBdLFxyXG4gICAgICB9LFxyXG4gICAgXTtcclxuICAgIE1lbnUuc2V0QXBwbGljYXRpb25NZW51KE1lbnUuYnVpbGRGcm9tVGVtcGxhdGUodGVtcGxhdGUpKTtcclxuICB9XHJcbiAgLyoqIFx1NjgwN1x1OTg5OFx1NjgwRiBcdTI2MzAgXHU0RTNCXHU4M0RDXHU1MzU1KFx1NUUzOFx1NzUyOFx1NTJBOFx1NEY1Q1x1NzY4NFx1NTUyRlx1NEUwMFx1NTE2NVx1NTNFMztcdTg5QzZcdTU2RkVcdTYwMDFcdTdFQ0YgbWVudTphY3Rpb24gXHU4RjZDXHU1M0QxKVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIHBvcHVwTWFpbk1lbnUoKTogdm9pZCB7XHJcbiAgICBjb25zdCBzZW5kID0gKGE6IHN0cmluZyk6IHZvaWQgPT4ge1xyXG4gICAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcclxuICAgICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCdtZW51OmFjdGlvbicsIGEpO1xyXG4gICAgICB9XHJcbiAgICB9O1xyXG4gICAgY29uc3Qgd2luID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkuZmluZCgodykgPT4gIXcuaXNEZXN0cm95ZWQoKSk7XHJcbiAgICBpZiAod2luID09PSB1bmRlZmluZWQpIHJldHVybjtcclxuICAgIE1lbnUuYnVpbGRGcm9tVGVtcGxhdGUoW1xyXG4gICAgICB7IGxhYmVsOiAnXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREJywgYWNjZWxlcmF0b3I6ICdDbWRPckN0cmwrTicsIGNsaWNrOiAoKTogdm9pZCA9PiBzZW5kKCduZXctc2Vzc2lvbicpIH0sXHJcbiAgICAgIHsgbGFiZWw6ICdcdThCQkVcdTdGNkUnLCBhY2NlbGVyYXRvcjogJ0NtZE9yQ3RybCtTaGlmdCtQJywgY2xpY2s6ICgpOiB2b2lkID0+IHNlbmQoJ29wZW4tc2V0dGluZ3MnKSB9LFxyXG4gICAgICB7IGxhYmVsOiAnXHU1RkVCXHU2Mzc3XHU5NTJFJywgYWNjZWxlcmF0b3I6ICdDbWRPckN0cmwrLycsIGNsaWNrOiAoKTogdm9pZCA9PiBzZW5kKCdzaG9ydGN1dHMnKSB9LFxyXG4gICAgICB7IHR5cGU6ICdzZXBhcmF0b3InIH0sXHJcbiAgICAgIHsgbGFiZWw6ICdcdTYyNEJcdTY3M0FcdThGRENcdTdBMEJcdTYzQTdcdTUyMzYnLCBjbGljazogKCk6IHZvaWQgPT4gc2VuZCgnb3Blbi1yZW1vdGUnKSB9LFxyXG4gICAgICB7IHR5cGU6ICdzZXBhcmF0b3InIH0sXHJcbiAgICAgIHtcclxuICAgICAgICBsYWJlbDogdXBkYXRlU3RhdGUuZG93bmxvYWRlZCA/IGBcdTkxQ0RcdTU0MkZcdTVFNzZcdTVCODlcdTg4QzVcdTY2RjRcdTY1QjAodiR7dXBkYXRlU3RhdGUubGF0ZXN0ID8/ICc/J30pYCA6ICdcdTY4QzBcdTY3RTVcdTY2RjRcdTY1QjBcdTIwMjYnLFxyXG4gICAgICAgIGNsaWNrOiAoKTogdm9pZCA9PiB7XHJcbiAgICAgICAgICBpZiAodXBkYXRlU3RhdGUuZG93bmxvYWRlZCkgeyBhcHBseVVwZGF0ZSgpOyByZXR1cm47IH1cclxuICAgICAgICAgIHZvaWQgY2hlY2tGb3JVcGRhdGVzKCkudGhlbigoc3QpID0+IHtcclxuICAgICAgICAgICAgY29uc3QgbmV3ZXIgPSBzdC5sYXRlc3QgIT09IG51bGwgJiYgKGNtcFZlcnNpb24oc3QuY3VycmVudFZlcnNpb24sIHN0LmxhdGVzdCkgPCAwIHx8IFVQREFURV9GT1JDRV9UQUcgIT09ICcnKTtcclxuICAgICAgICAgICAgY29uc3QgZGV0YWlsID0gbmV3ZXIgPyBgJHtzdC5ub3Rlc31cXG5cXG5cdTVCODlcdTg4QzVcdTUzMDVcdTZCNjNcdTU3MjhcdTU0MEVcdTUzRjBcdTRFMEJcdThGN0QsXHU1QjhDXHU2MjEwXHU1NDBFXHU5ODc2XHU5MEU4XHU2QTJBXHU1RTQ1XHU0RjFBXHU1MUZBXHU3M0IwXCJcdTkxQ0RcdTU0MkZcdTY2RjRcdTY1QjBcIlx1NEUwMFx1OTUyRVx1NUI4OVx1ODhDNShcdTY1RTBcdTk3MDBcdTYyNTNcdTVGMDBcdTRFMEJcdThGN0RcdTk4NzUpXHUzMDAyYCA6ICcnO1xyXG4gICAgICAgICAgICB2b2lkIGRpYWxvZy5zaG93TWVzc2FnZUJveCh3aW4sIHtcclxuICAgICAgICAgICAgICB0eXBlOiAnaW5mbycsXHJcbiAgICAgICAgICAgICAgdGl0bGU6ICdcdTY4QzBcdTY3RTVcdTY2RjRcdTY1QjAnLFxyXG4gICAgICAgICAgICAgIG1lc3NhZ2U6IG5ld2VyXHJcbiAgICAgICAgICAgICAgICA/IGBcdTUzRDFcdTczQjBcdTY1QjBcdTcyNDhcdTY3MkMgdiR7c3QubGF0ZXN0fSFgXHJcbiAgICAgICAgICAgICAgICA6IChzdC5lcnJvciAhPT0gJycgPyBgXHU2OEMwXHU2N0U1XHU1OTMxXHU4RDI1OiR7c3QuZXJyb3J9YCA6IGBcdTVERjJcdTY2MkZcdTY3MDBcdTY1QjBcdTcyNDhcdTY3MkModiR7c3QuY3VycmVudFZlcnNpb259KWApLFxyXG4gICAgICAgICAgICAgIGRldGFpbCxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICB9KTtcclxuICAgICAgICB9LFxyXG4gICAgICB9LFxyXG4gICAgICB7XHJcbiAgICAgICAgbGFiZWw6ICdcdTUxNzNcdTRFOEUgSE1IIERlc2t0b3AnLFxyXG4gICAgICAgIGNsaWNrOiAoKTogdm9pZCA9PiB7XHJcbiAgICAgICAgICB2b2lkIGRpYWxvZy5zaG93TWVzc2FnZUJveCh3aW4sIHtcclxuICAgICAgICAgICAgdHlwZTogJ2luZm8nLFxyXG4gICAgICAgICAgICB0aXRsZTogJ1x1NTE3M1x1NEU4RSBITUggRGVza3RvcCcsXHJcbiAgICAgICAgICAgIG1lc3NhZ2U6ICdITUggRGVza3RvcCcsXHJcbiAgICAgICAgICAgIGRldGFpbDogYGFwcCB2JHthcHAuZ2V0VmVyc2lvbigpfSBcdTAwQjcgXHU2NkY0XHU2NUIwXHU5MDFBXHU5MDUzOiR7dXBkYXRlU3RhdGUuY2hhbm5lbCB8fCAnLSd9XFxucnVudGltZTogaG1oYXJuZXNzICR7YnJpZGdlLmhvc3RWZXJzaW9uID8/ICcoXHU2NzJBXHU4RkRFXHU2M0E1KSd9JHt1c2VCdW5kbGVkUnVudGltZSA/ICcoXHU1MTg1XHU3RjZFKScgOiAnJ31cXG5cdTZBMjFcdTVGMEY6ICR7YnJpZGdlLm1vZGUgPT09ICdyZWFsJyA/ICh1c2VCdW5kbGVkUnVudGltZSA/ICdcdTc3MUZcdTVCOUUgaG1oYXJuZXNzKFx1NTE4NVx1N0Y2RSBydW50aW1lKScgOiAnXHU3NzFGXHU1QjlFIGhtaGFybmVzcyhcdTU5MTZcdTkwRThcdTVCODlcdTg4QzUpJykgOiAnXHU2RjE0XHU3OTNBKFx1NTA0N1x1NjU3MFx1NjM2RSknfVxcblxcblx1NEUwRSBDTEkgLyBUVUkgLyBcdTdGNTFcdTk4NzVcdTcyNDhcdTUxNzFcdTRFQUJcdTU0MENcdTRFMDAgSE1IX0hPTUVcdTMwMDJgLFxyXG4gICAgICAgICAgfSk7XHJcbiAgICAgICAgfSxcclxuICAgICAgfSxcclxuICAgICAgeyBsYWJlbDogJ1x1OTAwMFx1NTFGQScsIHJvbGU6ICdxdWl0JyB9LFxyXG4gICAgXSkucG9wdXAoeyB3aW5kb3c6IHdpbiB9KTtcclxuICB9XHJcblxyXG4gIC8qIC0tLS0gXHU2MjRCXHU2NzNBXHU4RkRDXHU3QTBCXHU2M0E3XHU1MjM2KDAzIFx1NTNGNzpXZWIgNzc4OCBcdTY2MkZcdTZENEZcdTg5QzhcdTU2NjgvXHU4RkRDXHU3QTBCL1x1NjI0Qlx1NjczQVx1NTE2NVx1NTNFMyxBRFItMDA1OlxyXG4gICAgIERlc2t0b3AgXHU0RTBEXHU5RUQ4XHU4QkE0XHU2MjUzXHU1RjAwIExBTiBcdTIwMTRcdTIwMTQgXHU4RkQ5XHU5MUNDXHU2NjJGXHU3NTI4XHU2MjM3XHU2NjNFXHU1RjBGXHU1NDJGXHU1MkE4XHU3Njg0XHU1MTY1XHU1M0UzKSAtLS0tICovXHJcbiAgY29uc3QgV0VCX1BPUlQgPSA3Nzg4O1xyXG4gIGFzeW5jIGZ1bmN0aW9uIHByb2JlV2ViUmVtb3RlKCk6IFByb21pc2U8eyB1cDogYm9vbGVhbjsgdmVyc2lvbjogc3RyaW5nIH0+IHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHIgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke1dFQl9QT1JUfS9hcGkvc3RhdGVgLCB7IHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCgxNTAwKSB9KTtcclxuICAgICAgaWYgKCFyLm9rKSByZXR1cm4geyB1cDogZmFsc2UsIHZlcnNpb246ICcnIH07XHJcbiAgICAgIGNvbnN0IGQgPSAoYXdhaXQgci5qc29uKCkpIGFzIHsgZGFlbW9uVmVyc2lvbj86IHN0cmluZyB9O1xyXG4gICAgICByZXR1cm4geyB1cDogdHJ1ZSwgdmVyc2lvbjogU3RyaW5nKGQuZGFlbW9uVmVyc2lvbiA/PyAnJykgfTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4geyB1cDogZmFsc2UsIHZlcnNpb246ICcnIH07IH1cclxuICB9XHJcbiAgLyoqIFx1NUYwMFx1NjczQVx1ODFFQVx1NTQyRlx1NjYyRlx1NTQyNlx1NURGMlx1ODhDNShydW50aW1lIHdlYi1kYWVtb24gXHU3Njg0XHU1NDJGXHU1MkE4XHU5ODc5XHU2NTg3XHU0RUY2XHU1QjU4XHU1NzI4XHU2MDI3OzAuMjMuMzcgXHU2NUIwXHU4MEZEXHU1MjlCKVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIHdlYkF1dG9zdGFydEluc3RhbGxlZCgpOiBib29sZWFuIHtcclxuICAgIGNvbnN0IGhvbWUgPSBwcm9jZXNzLmVudi5IT01FID8/ICcnO1xyXG4gICAgY29uc3QgY2FuZGlkYXRlcyA9IHByb2Nlc3MucGxhdGZvcm0gPT09ICd3aW4zMidcclxuICAgICAgPyBbam9pbihwcm9jZXNzLmVudi5BUFBEQVRBID8/ICcnLCAnTWljcm9zb2Z0JywgJ1dpbmRvd3MnLCAnU3RhcnQgTWVudScsICdQcm9ncmFtcycsICdTdGFydHVwJywgJ2htaGFybmVzcy13ZWItZGFlbW9uLmNtZCcpXVxyXG4gICAgICA6IHByb2Nlc3MucGxhdGZvcm0gPT09ICdkYXJ3aW4nXHJcbiAgICAgICAgPyBbam9pbihob21lLCAnTGlicmFyeScsICdMYXVuY2hBZ2VudHMnLCAnaG1oYXJuZXNzLXdlYi1kYWVtb24ucGxpc3QnKV1cclxuICAgICAgICA6IFtqb2luKGhvbWUsICcuY29uZmlnJywgJ3N5c3RlbWQnLCAndXNlcicsICdobWhhcm5lc3Mtd2ViLWRhZW1vbi5zZXJ2aWNlJyldO1xyXG4gICAgcmV0dXJuIGNhbmRpZGF0ZXMuc29tZSgocCkgPT4geyB0cnkgeyByZXR1cm4gZXhpc3RzU3luYyhwKTsgfSBjYXRjaCB7IHJldHVybiBmYWxzZTsgfSB9KTtcclxuICB9XHJcbiAgLyoqIFx1NjI0Qlx1NjczQVx1NTNFRlx1OERFRlx1NzUzMVx1NzY4NCBMQU4gSVAoUkZDMTkxOCxcdTYzOTJcdTk2NjRcdTg2NUFcdTYyREZcdTdGNTFcdTUzNjEpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gbGFuSXBPZigpOiBzdHJpbmcge1xyXG4gICAgY29uc3QgVklSVFVBTCA9IC92bXdhcmV8dmlydHVhbHxoeXBlci0/dnx2ZXRoZXJuZXR8d3NsfHRhaWxzY2FsZXxsb29wYmFja3xibHVldG9vdGh8dmJveHxkb2NrZXJ8dGFwLXxwc2V1ZG8vaTtcclxuICAgIGNvbnN0IGlzUmZjMTkxOCA9IChhOiBzdHJpbmcpOiBib29sZWFuID0+IC9eMTBcXC4vLnRlc3QoYSkgfHwgL14xOTJcXC4xNjhcXC4vLnRlc3QoYSkgfHwgL14xNzJcXC4oMVs2LTldfDJcXGR8M1swMV0pXFwuLy50ZXN0KGEpO1xyXG4gICAgbGV0IGxhbklwID0gJyc7XHJcbiAgICBsZXQgZmFsbGJhY2sgPSAnJztcclxuICAgIGZvciAoY29uc3QgW25hbWUsIGxpc3RdIG9mIE9iamVjdC5lbnRyaWVzKG5ldHdvcmtJbnRlcmZhY2VzKCkpKSB7XHJcbiAgICAgIGZvciAoY29uc3QgbiBvZiBsaXN0ID8/IFtdKSB7XHJcbiAgICAgICAgaWYgKG4uZmFtaWx5ICE9PSAnSVB2NCcgfHwgbi5pbnRlcm5hbCB8fCAhaXNSZmMxOTE4KG4uYWRkcmVzcykpIGNvbnRpbnVlO1xyXG4gICAgICAgIGlmICghVklSVFVBTC50ZXN0KG5hbWUpKSBsYW5JcCA9IGxhbklwIHx8IG4uYWRkcmVzcztcclxuICAgICAgICBlbHNlIGZhbGxiYWNrID0gZmFsbGJhY2sgfHwgbi5hZGRyZXNzO1xyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gbGFuSXAgfHwgZmFsbGJhY2s7XHJcbiAgfVxyXG4gIC8qKiBDTEkgXHU1MTY1XHU1M0UzOlx1NkU5MFx1NzgwMSByZXBvIFx1NUUwM1x1NUM0MChtYWluLnRzLFx1N0VDRiB0c3gpXHU2MjE2IG5wbSBcdTVCODlcdTg4QzVcdTVFMDNcdTVDNDAoZGlzdC9tYWluLmpzXHJcbiAgICogIFx1NzZGNFx1OEREMVx1MjAxNFx1MjAxNFx1NEVDRSBydW50aW1lIFx1NTE2NVx1NTNFM1x1NEUwQVx1NkVBRlx1NjI3RSBAaG1oYXJuZXNzL2NsaSBcdTUzMDU7XHU1RDRDXHU1OTU3L1x1NjNEMFx1NTM0Ny9cdTZFOTBcdTc4MDFcdTRFMDlcdTc5Q0RcdTVFMDNcdTVDNDBcdTkwMUFcdTU0MDMpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gY2xpRW50cnlPZigpOiBzdHJpbmcge1xyXG4gICAgaWYgKHJ1bnRpbWVFbnRyeSA9PT0gJycgfHwgcnVudGltZUVudHJ5ID09PSBudWxsKSByZXR1cm4gJyc7XHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCBwID0gam9pbihyZXBvUm9vdE9mKHJ1bnRpbWVFbnRyeSksICdwYWNrYWdlcycsICdjbGknLCAnc3JjJywgJ21haW4udHMnKTtcclxuICAgICAgaWYgKGV4aXN0c1N5bmMocCkpIHJldHVybiBwO1xyXG4gICAgfSBjYXRjaCB7IC8qIFx1OTc1RSByZXBvIFx1NUUwM1x1NUM0MCAqLyB9XHJcbiAgICBsZXQgZGlyID0gZGlybmFtZShydW50aW1lRW50cnkpO1xyXG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCA4OyBpKyspIHtcclxuICAgICAgaWYgKGV4aXN0c1N5bmMoam9pbihkaXIsICdkaXN0JywgJ21haW4uanMnKSkgJiYgcGtnTmFtZUF0KGRpcikgPT09ICdAaG1oYXJuZXNzL2NsaScpIHJldHVybiBqb2luKGRpciwgJ2Rpc3QnLCAnbWFpbi5qcycpO1xyXG4gICAgICBpZiAoYmFzZW5hbWUoZGlyKSA9PT0gJ0BobWhhcm5lc3MnICYmIGV4aXN0c1N5bmMoam9pbihkaXIsICdjbGknLCAnZGlzdCcsICdtYWluLmpzJykpKSByZXR1cm4gam9pbihkaXIsICdjbGknLCAnZGlzdCcsICdtYWluLmpzJyk7XHJcbiAgICAgIGNvbnN0IHBhcmVudCA9IGRpcm5hbWUoZGlyKTtcclxuICAgICAgaWYgKHBhcmVudCA9PT0gZGlyKSBicmVhaztcclxuICAgICAgZGlyID0gcGFyZW50O1xyXG4gICAgfVxyXG4gICAgcmV0dXJuICcnO1xyXG4gIH1cclxuICBmdW5jdGlvbiBydW5DbGkoYXJnczogc3RyaW5nW10pOiB2b2lkIHtcclxuICAgIGNvbnN0IGVudHJ5ID0gY2xpRW50cnlPZigpO1xyXG4gICAgaWYgKGVudHJ5ID09PSAnJykgcmV0dXJuO1xyXG4gICAgY29uc3QgaXNUcyA9IGVudHJ5LmVuZHNXaXRoKCcudHMnKTtcclxuICAgIGNvbnN0IHJlcG8gPSByZXBvUm9vdE9mKHJ1bnRpbWVFbnRyeSA/PyBlbnRyeSk7XHJcbiAgICBjb25zdCBjaGlsZCA9IHNwYXduKHByb2Nlc3MuZXhlY1BhdGgsIGlzVHMgPyBbJy0taW1wb3J0JywgJ3RzeCcsIGVudHJ5LCAuLi5hcmdzXSA6IFtlbnRyeSwgLi4uYXJnc10sIHtcclxuICAgICAgY3dkOiBpc1RzID8gcmVwbyA6IGRpcm5hbWUoZW50cnkpLFxyXG4gICAgICBkZXRhY2hlZDogdHJ1ZSxcclxuICAgICAgc3RkaW86ICdpZ25vcmUnLFxyXG4gICAgICB3aW5kb3dzSGlkZTogdHJ1ZSxcclxuICAgICAgZW52OiB7IEVMRUNUUk9OX1JVTl9BU19OT0RFOiAnMScgfSxcclxuICAgIH0pO1xyXG4gICAgY2hpbGQudW5yZWYoKTtcclxuICB9XHJcblxyXG4gIGZ1bmN0aW9uIGJyb2FkY2FzdEhvc3RTdGF0ZShzOiBIb3N0U3RhdGUsIGluZm86IHsgcmVzdGFydENvdW50OiBudW1iZXI7IGxhc3RFcnJvcj86IHN0cmluZyB9KTogdm9pZCB7XHJcbiAgICBicmlkZ2UgPSB7IC4uLmJyaWRnZSwgaG9zdFN0YXRlOiBzLCBob3N0UG9ydDogc3VwZXJ2aXNvcj8uZW5kcG9pbnQ/LnBvcnQgPz8gbnVsbCwgaG9zdFZlcnNpb246IHN1cGVydmlzb3I/LmVuZHBvaW50Py52ZXJzaW9uID8/IG51bGwgfTtcclxuICAgIGxvZ0luZm8oJ2hvc3QnLCBgc3RhdGU9JHtzfSR7aW5mby5sYXN0RXJyb3IgIT09IHVuZGVmaW5lZCA/IGAgZXJyPSR7aW5mby5sYXN0RXJyb3J9YCA6ICcnfWApO1xyXG4gICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XHJcbiAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ2JyaWRnZTpob3N0LXN0YXRlJywgcywgaW5mbyk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvKiogU1NFIFx1NkQ0MVx1OEJBMlx1OTYwNTpcdTRGRTFcdTVDMDEoZXZlbnQ6IGhtaClcdTYyNzlcdTkxQ0ZcdTYzQTggcmVuZGVyZXI7XHU5QUQ4XHU5ODkxIGRlbHRhL2xpbmUgXHU1MzlGXHU1RTI3XHJcbiAgICogIFx1NEY1Q1x1NEUzQVx1NkQ0MVx1NTc1N1x1OEY2Q1x1NTNEMShyZW5kZXJlciBcdTYyRkNcdTYzQTVcdTVGNTNcdTUyNEQgYXNzaXN0YW50IFx1NTM2MFx1NEY0RClcdTMwMDJcdTY1QURcdTdFQkZcdTgxRUFcdTUyQThcdTkxQ0RcdThGREVcdTMwMDIgKi9cclxuICBhc3luYyBmdW5jdGlvbiBwdW1wRXZlbnRzKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgaWYgKGNsaWVudCA9PT0gbnVsbCkgcmV0dXJuO1xyXG4gICAgZm9yICg7Oykge1xyXG4gICAgICBjb25zdCBjID0gY2xpZW50O1xyXG4gICAgICBpZiAoYyA9PT0gbnVsbCkgcmV0dXJuO1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGZvciBhd2FpdCAoY29uc3QgZnJhbWUgb2YgYy5yYXdFdmVudHMobGFzdEV2ZW50SWQgPT09ICcnID8gdW5kZWZpbmVkIDogbGFzdEV2ZW50SWQsIHNzZUFib3J0Py5zaWduYWwpKSB7XHJcbiAgICAgICAgICBpZiAoZnJhbWUuZXZlbnQgPT09ICdobWgnKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGVudiA9IGVudmVsb3BlRnJvbUZyYW1lKGZyYW1lKTtcclxuICAgICAgICAgICAgaWYgKGVudiA9PT0gbnVsbCkge1xyXG4gICAgICAgICAgICAgIGRyb3BwZWRGcmFtZXMgKz0gMTtcclxuICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBsYXN0RXZlbnRJZCA9IGVudi5ldmVudElkO1xyXG4gICAgICAgICAgICBwdXNoRXZlbnQoZW52KTtcclxuICAgICAgICAgIH0gZWxzZSBpZiAoZnJhbWUuZXZlbnQgPT09ICdkZWx0YScgfHwgZnJhbWUuZXZlbnQgPT09ICdsaW5lJykge1xyXG4gICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgIGNvbnN0IGQgPSBKU09OLnBhcnNlKGZyYW1lLmRhdGEpIGFzIHsgc2Vzc2lvbklkPzogc3RyaW5nOyBrPzogc3RyaW5nOyBjaHVuaz86IHN0cmluZzsgdGV4dD86IHN0cmluZyB9O1xyXG4gICAgICAgICAgICAgIGNvbnN0IHBheWxvYWQgPSBmcmFtZS5ldmVudCA9PT0gJ2RlbHRhJ1xyXG4gICAgICAgICAgICAgICAgPyB7IHNlc3Npb25JZDogZC5zZXNzaW9uSWQgPz8gJycsIGtpbmQ6IGQuayA/PyAndGV4dCcsIGNodW5rOiBTdHJpbmcoZC5jaHVuayA/PyAnJykgfVxyXG4gICAgICAgICAgICAgICAgOiB7IHNlc3Npb25JZDogZC5zZXNzaW9uSWQgPz8gJycsIGtpbmQ6ICdsaW5lJywgY2h1bms6IFN0cmluZyhkLnRleHQgPz8gJycpIH07XHJcbiAgICAgICAgICAgICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XHJcbiAgICAgICAgICAgICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCdicmlkZ2U6c3RyZWFtLWNodW5rJywgcGF5bG9hZCk7XHJcbiAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9IGNhdGNoIHsgLyogbWFsZm9ybWVkIHN0cmVhbSBmcmFtZTogc2tpcCAqLyB9XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybjsgLy8gXHU2RDQxXHU2QjYzXHU1RTM4XHU3RUQzXHU2NzVGKGhvc3QgXHU1MTczXHU5NUVEKVxyXG4gICAgICB9IGNhdGNoIHtcclxuICAgICAgICAvLyBcdTY1QURcdTdFQkY6XHU3N0VEXHU5MDAwXHU5MDdGXHU1NDBFXHU5MUNEXHU4RkRFKHN1cGVydmlzb3IgXHU1M0VGXHU4MEZEXHU2QjYzXHU1NzI4XHU5MUNEXHU1NDJGIGhvc3QpXHJcbiAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgMV8wMDApKTtcclxuICAgICAgICBpZiAoc3NlQWJvcnQ/LnNpZ25hbC5hYm9ydGVkKSByZXR1cm47XHJcbiAgICAgIH1cclxuICAgIH1cclxuICB9XHJcblxyXG4gIC8qIC0tLS0gaG1oYXJuZXNzIHJ1bnRpbWUgXHU4MUVBXHU1MkE4XHU1M0QxXHU3M0IwKDIwMjYtMTAtMTAgXHU3NTI4XHU2MjM3XHU1QjlBXHU4QzAzOlx1ODhDNVx1OEZDNyBobWhhcm5lc3MgXHU3Njg0XHJcbiAgICAgXHU2NzNBXHU1NjY4XHU5NkY2XHU5MTREXHU3RjZFXHU3NkY0XHU4RkRFLFx1NTkwRFx1NzUyOCBDTEkvVFVJL3dlYiA3Nzg4IFx1NzY4NFx1NTQwQ1x1NEUwMCBITUhfSE9NRVx1MjAxNFx1MjAxNGNvbmZpZy9wcm92aWRlcnMvXHJcbiAgICAgXHU0RjFBXHU4QkREXHU1Mzg2XHU1M0YyXHU1OTI5XHU3MTM2XHU1MTcxXHU0RUFCKVx1MzAwMnY1LjEgXHU1M0QxXHU3M0IwXHU5ODdBXHU1RThGOlx1NjYzRVx1NUYwRlx1OTE0RFx1N0Y2RSA+IHdoZXJlIGhtaChcdTZFOTBcdTc4MDEgbGluayBcdTRFMEVcclxuICAgICBAaG1oYXJuZXNzL2NsaSBucG0gXHU1Qjg5XHU4OEM1XHU0RTI0XHU3OUNEXHU1RTAzXHU1QzQwKT4gbnBtIFx1NTE2OFx1NUM0MFx1NjgzOShcdTU0MEMpPiBcdTU0MTFcdTVCRkNcdTVCODlcdTg4QzVcdTc2RUVcdTVGNTVcclxuICAgICB+Ly5obWhhcm5lc3MtZ2xvYmFsID4gXHU1RTM4XHU4OUMxXHU2RTkwXHU3ODAxXHU0RjREXHU3RjZFXHUzMDAyICovXHJcbiAgY29uc3QgcnVudGltZUNvbmZpZ0ZpbGUgPSAoKTogc3RyaW5nID0+IGpvaW4oYXBwLmdldFBhdGgoJ3VzZXJEYXRhJyksICdydW50aW1lLmpzb24nKTtcclxuICAvKiogcnVudGltZS5qc29uOnsgZW50cnkoXHU2MjRCXHU1MkE4L1x1NTQxMVx1NUJGQ1x1OTAwOVx1NjJFOVx1NzY4NFx1NTE2NVx1NTNFMyksIGRlbW8oXHU2MzAxXHU0RTQ1XHU2RjE0XHU3OTNBXHU2QTIxXHU1RjBGKSB9XHUzMDAyICovXHJcbiAgYXN5bmMgZnVuY3Rpb24gbG9hZFJ1bnRpbWVDb25maWcoKTogUHJvbWlzZTx7IGVudHJ5OiBzdHJpbmc7IGRlbW86IGJvb2xlYW4gfT4ge1xyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3QgdiA9IEpTT04ucGFyc2UoYXdhaXQgcmVhZEZpbGUocnVudGltZUNvbmZpZ0ZpbGUoKSwgJ3V0ZjgnKSkgYXMgeyBlbnRyeT86IHVua25vd247IGRlbW8/OiB1bmtub3duIH07XHJcbiAgICAgIHJldHVybiB7XHJcbiAgICAgICAgZW50cnk6IHR5cGVvZiB2LmVudHJ5ID09PSAnc3RyaW5nJyAmJiB2LmVudHJ5ICE9PSAnJyAmJiBpc0Fic29sdXRlKHYuZW50cnkpID8gdi5lbnRyeSA6ICcnLFxyXG4gICAgICAgIGRlbW86IHYuZGVtbyA9PT0gdHJ1ZSxcclxuICAgICAgfTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4geyBlbnRyeTogJycsIGRlbW86IGZhbHNlIH07IH1cclxuICB9XHJcbiAgYXN5bmMgZnVuY3Rpb24gc2F2ZVJ1bnRpbWVDb25maWcoY2ZnOiB7IGVudHJ5OiBzdHJpbmc7IGRlbW86IGJvb2xlYW4gfSk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgYXdhaXQgd3JpdGVGaWxlKHJ1bnRpbWVDb25maWdGaWxlKCksIEpTT04uc3RyaW5naWZ5KGNmZywgbnVsbCwgMiksICd1dGY4JykuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcclxuICB9XHJcbiAgYXN5bmMgZnVuY3Rpb24gbG9hZFJ1bnRpbWVFbnRyeU92ZXJyaWRlKCk6IFByb21pc2U8c3RyaW5nPiB7XHJcbiAgICByZXR1cm4gKGF3YWl0IGxvYWRSdW50aW1lQ29uZmlnKCkpLmVudHJ5O1xyXG4gIH1cclxuICBhc3luYyBmdW5jdGlvbiBzYXZlUnVudGltZUVudHJ5T3ZlcnJpZGUoZW50cnk6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgYXdhaXQgc2F2ZVJ1bnRpbWVDb25maWcoeyBlbnRyeSwgZGVtbzogKGF3YWl0IGxvYWRSdW50aW1lQ29uZmlnKCkpLmRlbW8gfSk7XHJcbiAgfVxyXG5cclxuICBpbnRlcmZhY2UgRXh0ZXJuYWxSdW50aW1lIHsgZW50cnk6IHN0cmluZzsgdmVyc2lvbjogc3RyaW5nOyBzb3VyY2U6IHN0cmluZyB9XHJcblxyXG4gIC8qKiBcdThCRkJcdTUzMDVcdTcyNDhcdTY3MkMocGFja2FnZS5qc29uIFx1NzY4NCB2ZXJzaW9uIFx1NUI1N1x1NkJCNTtcdTU5MzFcdThEMjVcdTdBN0FcdTRFMzIpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gcGtnVmVyc2lvbkF0KGRpcjogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHYgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKGRpciwgJ3BhY2thZ2UuanNvbicpLCAndXRmOCcpKSBhcyB7IHZlcnNpb24/OiB1bmtub3duIH07XHJcbiAgICAgIHJldHVybiB0eXBlb2Ygdi52ZXJzaW9uID09PSAnc3RyaW5nJyA/IHYudmVyc2lvbiA6ICcnO1xyXG4gICAgfSBjYXRjaCB7IHJldHVybiAnJzsgfVxyXG4gIH1cclxuICAvKiogXHU4QkZCXHU1MzA1XHU1NDBEKFx1NTQwQ1x1NEUwQTtAaG1oYXJuZXNzL2NsaSBcdTVFMDNcdTVDNDBcdThCQzZcdTUyMkJcdTc1MjgpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gcGtnTmFtZUF0KGRpcjogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHYgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKGRpciwgJ3BhY2thZ2UuanNvbicpLCAndXRmOCcpKSBhcyB7IG5hbWU/OiB1bmtub3duIH07XHJcbiAgICAgIHJldHVybiB0eXBlb2Ygdi5uYW1lID09PSAnc3RyaW5nJyA/IHYubmFtZSA6ICcnO1xyXG4gICAgfSBjYXRjaCB7IHJldHVybiAnJzsgfVxyXG4gIH1cclxuXHJcbiAgLyoqIG5wbSBcdTVCODlcdTg4QzVcdTc2ODQgQGhtaGFybmVzcy9jbGkgXHUyMTkyIGRlc2t0b3AtaG9zdCBcdTdGMTZcdThCRDFcdTUxNjVcdTUzRTMoXHU1RDRDXHU1OTU3XHU0RTBFXHU2M0QwXHU1MzQ3XHU0RTI0XHU3OUNEXHU1RTAzXHU1QzQwKVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIGVudHJ5RnJvbUNsaURpcihjbGlEaXI6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICBjb25zdCBuZXN0ZWQgPSBqb2luKGNsaURpciwgJ25vZGVfbW9kdWxlcycsICdAaG1oYXJuZXNzJywgJ3dlYicsICdkaXN0JywgJ2Rlc2t0b3AtaG9zdC5qcycpO1xyXG4gICAgaWYgKGV4aXN0c1N5bmMobmVzdGVkKSkgcmV0dXJuIG5lc3RlZDtcclxuICAgIGNvbnN0IGhvaXN0ZWQgPSBqb2luKGRpcm5hbWUoY2xpRGlyKSwgJ3dlYicsICdkaXN0JywgJ2Rlc2t0b3AtaG9zdC5qcycpO1xyXG4gICAgaWYgKGV4aXN0c1N5bmMoaG9pc3RlZCkpIHJldHVybiBob2lzdGVkO1xyXG4gICAgcmV0dXJuICcnO1xyXG4gIH1cclxuXHJcbiAgLyoqIFx1NTkxNlx1OTBFOFx1NTNEMVx1NzNCMChcdTRGOUJcdTgxRUFcdTUyQThcdThGREVcdTYzQTVcdTRFMEVcdTU0MTFcdTVCRkNcdTY4QzBcdTZENEJcdTk4NzVcdTUxNzFcdTc1MjgpXHUzMDAyXHU0RjE4XHU1MTQ4XHU3RUE3OmVudiA+IHdoZXJlIGhtaCA+IG5wbVxyXG4gICAqICBcdTUxNjhcdTVDNDBcdTY4MzkgPiBcdTU0MTFcdTVCRkNcdTVCODlcdTg4QzVcdTc2RUVcdTVGNTUgfi8uaG1oYXJuZXNzLWdsb2JhbCA+IFx1NkU5MFx1NzgwMVx1NEVEM1x1NjI2Qlx1NjNDRjtcdTU0MENcdTRFMDBcdTVDNDJcdTUxODVcclxuICAgKiAgXCJcdTVERjJcdTg4QzUgQ0xJKG5wbSBcdTVFMDNcdTVDNDApXCIgXHU1MTQ4XHU0RThFIFwiXHU2RTkwXHU3ODAxIHJlcG8gXHU1RTAzXHU1QzQwXCJcdTMwMDIgKi9cclxuICBmdW5jdGlvbiBkZXRlY3RFeHRlcm5hbFJ1bnRpbWUoKTogRXh0ZXJuYWxSdW50aW1lIHtcclxuICAgIC8vIDEpIFx1NzNBRlx1NTg4M1x1NTNEOFx1OTFDRlx1NjYzRVx1NUYwRlx1ODk4Nlx1NzZENihcdTlBRDhcdTdFQTdcdTc1MjhcdTYyMzcpXHJcbiAgICBjb25zdCBlbnZFbnRyeSA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1JFQUxfRU5UUlk7XHJcbiAgICBpZiAoZW52RW50cnkgIT09IHVuZGVmaW5lZCAmJiBlbnZFbnRyeSAhPT0gJycgJiYgaXNBYnNvbHV0ZShlbnZFbnRyeSkpIHtcclxuICAgICAgcmV0dXJuIHsgZW50cnk6IGVudkVudHJ5LCB2ZXJzaW9uOiAnJywgc291cmNlOiAnZW52JyB9O1xyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IHdoZXJlUmVwb3MgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgIGNvbnN0IHdoZXJlQ2xpczogc3RyaW5nW10gPSBbXTtcclxuICAgIGNvbnN0IG5wbVJlcG9zID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICBsZXQgbnBtQ2xpID0gJyc7XHJcbiAgICAvLyAyKSB3aGVyZSBobWg6bnBtIGxpbmsoXHU2RTkwXHU3ODAxXHU2ODM5XHU1RTAzXHU1QzQwKVx1NEUwRSBAaG1oYXJuZXNzL2NsaSBucG0gXHU1Qjg5XHU4OEM1XHU1RTAzXHU1QzQwXHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCBvdXQgPSBleGVjRmlsZVN5bmMoJ3doZXJlJywgWydobWgnXSwgeyBlbmNvZGluZzogJ3V0ZjgnLCB0aW1lb3V0OiA0XzAwMCwgd2luZG93c0hpZGU6IHRydWUgfSk7XHJcbiAgICAgIGZvciAoY29uc3QgbGluZSBvZiBvdXQuc3BsaXQoL1xccj9cXG4vKSkge1xyXG4gICAgICAgIGNvbnN0IGJpbiA9IGxpbmUudHJpbSgpO1xyXG4gICAgICAgIGlmIChiaW4gPT09ICcnKSBjb250aW51ZTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgY29uc3QgYmluRGlyID0gZGlybmFtZShiaW4pO1xyXG4gICAgICAgICAgY29uc3QgbGlua2VkID0gam9pbihiaW5EaXIsICdub2RlX21vZHVsZXMnLCAnaG1oYXJuZXNzJyk7XHJcbiAgICAgICAgICBpZiAoZXhpc3RzU3luYyhsaW5rZWQpKSB3aGVyZVJlcG9zLmFkZChyZWFscGF0aFN5bmMobGlua2VkKSk7XHJcbiAgICAgICAgICBjb25zdCBjbGkgPSBqb2luKGJpbkRpciwgJ25vZGVfbW9kdWxlcycsICdAaG1oYXJuZXNzJywgJ2NsaScpO1xyXG4gICAgICAgICAgaWYgKGV4aXN0c1N5bmMoY2xpKSkgd2hlcmVDbGlzLnB1c2goY2xpKTtcclxuICAgICAgICB9IGNhdGNoIHsgLyogYmluIFx1NUUwM1x1NUM0MFx1NEUwRFx1N0IyNixcdThERjNcdThGQzcgKi8gfVxyXG4gICAgICB9XHJcbiAgICB9IGNhdGNoIHsgLyogaG1oIFx1NEUwRFx1NTcyOCBQQVRIICovIH1cclxuICAgIC8vIDMpIG5wbSBcdTUxNjhcdTVDNDBcdTY4MzkoXHU0RTI0XHU3OUNEXHU1RTAzXHU1QzQwXHU1NDBDIHdoZXJlKVxyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3Qgb3V0ID0gZXhlY0ZpbGVTeW5jKCducG0nLCBbJ3Jvb3QnLCAnLWcnXSwgeyBlbmNvZGluZzogJ3V0ZjgnLCB0aW1lb3V0OiA2XzAwMCwgd2luZG93c0hpZGU6IHRydWUgfSk7XHJcbiAgICAgIGNvbnN0IHJvb3QgPSBvdXQudHJpbSgpO1xyXG4gICAgICBjb25zdCBsaW5rZWQgPSBqb2luKHJvb3QsICdobWhhcm5lc3MnKTtcclxuICAgICAgaWYgKGV4aXN0c1N5bmMobGlua2VkKSkgbnBtUmVwb3MuYWRkKHJlYWxwYXRoU3luYyhsaW5rZWQpKTtcclxuICAgICAgY29uc3QgY2xpID0gam9pbihyb290LCAnQGhtaGFybmVzcycsICdjbGknKTtcclxuICAgICAgaWYgKGV4aXN0c1N5bmMoY2xpKSkgbnBtQ2xpID0gY2xpO1xyXG4gICAgfSBjYXRjaCB7IC8qIG5wbSBcdTRFMERcdTUzRUZcdTc1MjggKi8gfVxyXG5cclxuICAgIC8vIFx1NURGMlx1ODhDNSBDTEkoQGhtaGFybmVzcy9jbGkgbnBtIFx1NUUwM1x1NUM0MDtkZXNrdG9wLWhvc3QgXHU0RTNBXHU3RjE2XHU4QkQxXHU0RUE3XHU3MjY5XHU1M0VGXHU3NkY0XHU4REQxKTpcclxuICAgIC8vIHdoZXJlKFBBVEggXHU3NzFGXHU3NkY4KT4gbnBtIFx1NTE2OFx1NUM0MFx1NjgzOSA+IFx1NTQxMVx1NUJGQ1x1NUI4OVx1ODhDNVx1NzZFRVx1NUY1NVxyXG4gICAgZm9yIChjb25zdCBbY2xpLCBzb3VyY2VdIG9mIFtbd2hlcmVDbGlzWzBdID8/ICcnLCAnd2hlcmUtaG1oJ10sIFtucG1DbGksICducG0tZ2xvYmFsJ11dIGFzIEFycmF5PFtzdHJpbmcsIHN0cmluZ10+KSB7XHJcbiAgICAgIGlmIChjbGkgPT09ICcnKSBjb250aW51ZTtcclxuICAgICAgY29uc3QgZW50cnkgPSBlbnRyeUZyb21DbGlEaXIoY2xpKTtcclxuICAgICAgaWYgKGVudHJ5ICE9PSAnJykgcmV0dXJuIHsgZW50cnksIHZlcnNpb246IHBrZ1ZlcnNpb25BdChjbGkpLCBzb3VyY2UgfTtcclxuICAgIH1cclxuICAgIGNvbnN0IHdpemFyZEVudHJ5ID0gcmVzb2x2ZUluc3RhbGxlZEVudHJ5KGluc3RhbGxUYXJnZXQoKSk7XHJcbiAgICBpZiAod2l6YXJkRW50cnkgIT09ICcnKSB7XHJcbiAgICAgIHJldHVybiB7IGVudHJ5OiB3aXphcmRFbnRyeSwgdmVyc2lvbjogcGtnVmVyc2lvbkF0KGpvaW4oaW5zdGFsbFRhcmdldCgpLCAnbm9kZV9tb2R1bGVzJywgJ0BobWhhcm5lc3MnLCAnY2xpJykpLCBzb3VyY2U6ICd3aXphcmQtaW5zdGFsbCcgfTtcclxuICAgIH1cclxuXHJcbiAgICAvLyBcdTZFOTBcdTc4MDEgcmVwbyBcdTVFMDNcdTVDNDAod2hlcmUgPiBucG0gXHU1MTY4XHU1QzQwID4gXHU1RTM4XHU4OUMxXHU2RTkwXHU3ODAxXHU0RjREXHU3RjZFO1x1NTQ3RFx1NEUyRFx1OTg3Qlx1NjcwOVx1NTE2NVx1NTNFM1x1NEUwRVx1NEY5RFx1OEQ1NilcclxuICAgIGNvbnN0IHJlcG9zID0gbmV3IFNldDxzdHJpbmc+KFsuLi53aGVyZVJlcG9zLCAuLi5ucG1SZXBvc10pO1xyXG4gICAgY29uc3QgYmFzZXMgPSBbJ0M6XFxcXCcsICdEOlxcXFwnLCAnRTpcXFxcJywgJ0Y6XFxcXCcsICdHOlxcXFwnLCAnSDpcXFxcJywgaG9tZWRpcigpLCBqb2luKGhvbWVkaXIoKSwgJ0RldmVsb3BlcicpXTtcclxuICAgIGZvciAoY29uc3QgYmFzZSBvZiBiYXNlcykge1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHAgPSByZXNvbHZlKGJhc2UsICdobWhhcm5lc3MnKTtcclxuICAgICAgICBpZiAoZXhpc3RzU3luYyhwKSkgcmVwb3MuYWRkKHApO1xyXG4gICAgICB9IGNhdGNoIHsgLyogXHU3NkQ4XHU0RTBEXHU1QjU4XHU1NzI4ICovIH1cclxuICAgIH1cclxuICAgIGZvciAoY29uc3QgcmVwbyBvZiByZXBvcykge1xyXG4gICAgICBjb25zdCBlbnRyeSA9IGpvaW4ocmVwbywgJ3BhY2thZ2VzJywgJ3dlYicsICdzcmMnLCAnZGVza3RvcC1ob3N0LnRzJyk7XHJcbiAgICAgIGlmIChleGlzdHNTeW5jKGVudHJ5KSAmJiBleGlzdHNTeW5jKGpvaW4ocmVwbywgJ25vZGVfbW9kdWxlcycpKSkge1xyXG4gICAgICAgIHJldHVybiB7IGVudHJ5LCB2ZXJzaW9uOiBwa2dWZXJzaW9uQXQocmVwbyksIHNvdXJjZTogJ3NvdXJjZS1yZXBvJyB9O1xyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4geyBlbnRyeTogJycsIHZlcnNpb246ICcnLCBzb3VyY2U6ICcnIH07XHJcbiAgfVxyXG5cclxuICBmdW5jdGlvbiBkZXRlY3RSZWFsRW50cnkoKTogc3RyaW5nIHtcclxuICAgIHJldHVybiBkZXRlY3RFeHRlcm5hbFJ1bnRpbWUoKS5lbnRyeTtcclxuICB9XHJcblxyXG4gIC8qKiBcdTg5RTNcdTY3OTAgcnVudGltZSBcdTUxNjVcdTUzRTNcdTYyNDBcdTVDNUVcdTc2ODQgaG1oYXJuZXNzIFx1NEVEM1x1NUU5M1x1NjgzOShwYWNrYWdlcy93ZWIvc3JjfGRpc3QgXHU0RTBBXHU2RUFGKVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIHJlcG9Sb290T2YoZW50cnk6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICBsZXQgZGlyID0gZGlybmFtZShlbnRyeSk7XHJcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IDY7IGkrKykge1xyXG4gICAgICBpZiAoZXhpc3RzU3luYyhqb2luKGRpciwgJ3BhY2thZ2UuanNvbicpKSAmJiBleGlzdHNTeW5jKGpvaW4oZGlyLCAncGFja2FnZXMnLCAnd2ViJykpKSByZXR1cm4gZGlyO1xyXG4gICAgICBjb25zdCBwYXJlbnQgPSBkaXJuYW1lKGRpcik7XHJcbiAgICAgIGlmIChwYXJlbnQgPT09IGRpcikgYnJlYWs7XHJcbiAgICAgIGRpciA9IHBhcmVudDtcclxuICAgIH1cclxuICAgIHJldHVybiBkaXJuYW1lKGVudHJ5KTtcclxuICB9XHJcblxyXG4gIGxldCBydW50aW1lRW50cnkgPSAnJzsgLy8gXHU1RjUzXHU1MjREXHU1QjlFXHU5NjQ1XHU0RjdGXHU3NTI4XHU3Njg0XHU3NzFGXHU1QjlFIHJ1bnRpbWUgXHU1MTY1XHU1M0UzKCcnPVx1NjcyQVx1NjNBNSlcclxuICBsZXQgdXNlQnVuZGxlZFJ1bnRpbWUgPSBmYWxzZTsgLy8gdjU6XHU2NjJGXHU1NDI2XHU1NzI4XHU3NTI4XHU1MTg1XHU3RjZFIHJ1bnRpbWUoXHU1MTczXHU0RThFL1x1OTc2Mlx1Njc3Rlx1NjgwN1x1NkNFOClcclxuXHJcbiAgLyoqIFx1NTE4NVx1N0Y2RSBydW50aW1lKHY1IFx1NUYwMFx1N0JCMVx1NTM3M1x1NzUyOCk6XHU2MjUzXHU1MzA1XHU1NDBFXHU5NjhGIGV4dHJhUmVzb3VyY2VzIFx1NUU3M1x1OTRGQVx1NTcyOCByZXNvdXJjZXMvO1xyXG4gICAgIGRldiBcdTc1MjhcdTRFRDNcdTVFOTNcdTUxODVcdTY3ODRcdTVFRkFcdTRFQTdcdTcyNjkoc2NyaXB0cy9idW5kbGUtcnVudGltZS5tanMpXHUzMDAyXHU4MUVBXHU1MzA1XHU1NDJCXHU1MzU1XHU2NTg3XHU0RUY2LFx1NjVFMCB0c3hcdTMwMDFcclxuICAgICBcdTY1RTAgcmVwbyBub2RlX21vZHVsZXMgXHU0RjlEXHU4RDU2XHUzMDAyICovXHJcbiAgZnVuY3Rpb24gYnVuZGxlZFJ1bnRpbWVQYXRoKHJlcG9Sb290OiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIGpvaW4oYXBwLmlzUGFja2FnZWQgPyBwcm9jZXNzLnJlc291cmNlc1BhdGggOiBqb2luKHJlcG9Sb290LCAnYXBwcycsICdkZXNrdG9wJywgJ3Jlc291cmNlcycpLCAncnVudGltZScsICdydW50aW1lLmNqcycpO1xyXG4gIH1cclxuXHJcbiAgLyoqIFx1NTE4NVx1N0Y2RSBydW50aW1lIFx1NTE0M1x1NEZFMVx1NjA2RihcdTU0MTFcdTVCRkNcIlx1NTE4NVx1N0Y2RVx1N0NCRVx1N0I4MFx1NTE4NVx1NjgzOFwiXHU5MDA5XHU5ODc5XHU3Njg0XHU3MjQ4XHU2NzJDXHU2ODA3XHU2Q0U4KVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIGJ1bmRsZWRSdW50aW1lSW5mbygpOiB7IHJlYWR5OiBib29sZWFuOyB2ZXJzaW9uOiBzdHJpbmcgfSB7XHJcbiAgICBjb25zdCByZXBvUm9vdCA9IGpvaW4oaGVyZSwgJy4uJywgJy4uJywgJy4uJywgJy4uJyk7XHJcbiAgICBjb25zdCBwID0gYnVuZGxlZFJ1bnRpbWVQYXRoKHJlcG9Sb290KTtcclxuICAgIGxldCB2ZXJzaW9uID0gJyc7XHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCB2ID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoam9pbihkaXJuYW1lKHApLCAncGFja2FnZS5qc29uJyksICd1dGY4JykpIGFzIHsgdmVyc2lvbj86IHVua25vd24gfTtcclxuICAgICAgdmVyc2lvbiA9IHR5cGVvZiB2LnZlcnNpb24gPT09ICdzdHJpbmcnID8gdi52ZXJzaW9uIDogJyc7XHJcbiAgICB9IGNhdGNoIHsgLyogXHU1MTQzXHU2NTcwXHU2MzZFXHU3RjNBXHU1OTMxXHU1MjE5XHU1M0VBXHU2MkE1IHJlYWR5ICovIH1cclxuICAgIHJldHVybiB7IHJlYWR5OiBleGlzdHNTeW5jKHApLCB2ZXJzaW9uIH07XHJcbiAgfVxyXG5cclxuICAvKiogbnBtIFx1NjYyRlx1NTQyNlx1NTcyOCBQQVRIKFx1NTQxMVx1NUJGQ1x1OTAwOVx1NjJFOVx1OTg3NSBcdTI0NjAgXHU3Njg0XHU1Qjg5XHU4OEM1XHU2NUI5XHU1RjBGXHU2ODA3XHU2Q0U4O3doZXJlIFx1NUZFQlx1NjNBMixcdTRFMERcdTUwNUFcdTVCOENcdTY1NzRcdTYzQTJcdTZENEIpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gbnBtT25QYXRoKCk6IGJvb2xlYW4ge1xyXG4gICAgdHJ5IHtcclxuICAgICAgZXhlY0ZpbGVTeW5jKCd3aGVyZScsIFsnbnBtJ10sIHsgZW5jb2Rpbmc6ICd1dGY4JywgdGltZW91dDogNF8wMDAsIHdpbmRvd3NIaWRlOiB0cnVlIH0pO1xyXG4gICAgICByZXR1cm4gdHJ1ZTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4gZmFsc2U7IH1cclxuICB9XHJcblxyXG4gIC8qIC0tLS0gXHU5OTk2XHU1NDJGXHU1Qjg5XHU4OEM1XHU1NDExXHU1QkZDXHU3MkI2XHU2MDAxKHY1LjEpIC0tLS0gKi9cclxuICBjb25zdCB3aXphcmRGaWxlID0gKCk6IHN0cmluZyA9PiBqb2luKGFwcC5nZXRQYXRoKCd1c2VyRGF0YScpLCAnd2l6YXJkLmpzb24nKTtcclxuICBhc3luYyBmdW5jdGlvbiBsb2FkV2l6YXJkU3RhdGUoKTogUHJvbWlzZTx7IGRvbmU6IGJvb2xlYW47IGNob2ljZTogc3RyaW5nIH0+IHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHYgPSBKU09OLnBhcnNlKGF3YWl0IHJlYWRGaWxlKHdpemFyZEZpbGUoKSwgJ3V0ZjgnKSkgYXMgeyBkb25lPzogdW5rbm93bjsgY2hvaWNlPzogdW5rbm93biB9O1xyXG4gICAgICByZXR1cm4geyBkb25lOiB2LmRvbmUgPT09IHRydWUsIGNob2ljZTogdHlwZW9mIHYuY2hvaWNlID09PSAnc3RyaW5nJyA/IHYuY2hvaWNlIDogJycgfTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4geyBkb25lOiBmYWxzZSwgY2hvaWNlOiAnJyB9OyB9XHJcbiAgfVxyXG4gIGFzeW5jIGZ1bmN0aW9uIHNhdmVXaXphcmRTdGF0ZShjaG9pY2U6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgYXdhaXQgd3JpdGVGaWxlKHdpemFyZEZpbGUoKSwgSlNPTi5zdHJpbmdpZnkoeyBkb25lOiB0cnVlLCBjaG9pY2UgfSwgbnVsbCwgMiksICd1dGY4JykuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcclxuICB9XHJcbiAgLyoqIFx1NTQxMVx1NUJGQ1x1ODFFQVx1NTJBOFx1NUYzOVx1NTFGQVx1NjI5MVx1NTIzNjpcdTZENEJcdThCRDUvXHU1RjAwXHU1M0QxXHU3M0FGXHU1ODgzXHU0RTBEXHU1RjM5KFVJVkVSSUZZL1NOQVBTSE9UL1JFTkRFUl9URVNUL1xyXG4gICAqICBET01QUk9CRS9TRUNVUklUWV9URVNUL0ZBS0UvZGV2KTtITUhfREVTS1RPUF9XSVpBUkRfRk9SQ0U9MSBcdTVGM0FcdTUyMzZcdTVGMzkoXHU5QThDXHU2NTM2KVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIHdpemFyZFN1cHByZXNzZWQoKTogYm9vbGVhbiB7XHJcbiAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfV0laQVJEX0ZPUkNFID09PSAnMScpIHJldHVybiBmYWxzZTtcclxuICAgIHJldHVybiBpc0RldlxyXG4gICAgICB8fCBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWSA9PT0gJzEnXHJcbiAgICAgIHx8IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NOQVBTSE9UICE9PSB1bmRlZmluZWRcclxuICAgICAgfHwgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVklTUkVHID09PSAnMSdcclxuICAgICAgfHwgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfUkVOREVSX1RFU1QgPT09ICcxJ1xyXG4gICAgICB8fCBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9ET01QUk9CRSA9PT0gJzEnXHJcbiAgICAgIHx8IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NFQ1VSSVRZX1RFU1QgPT09ICcxJ1xyXG4gICAgICB8fCBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9GQUtFID09PSAnMSc7XHJcbiAgfVxyXG5cclxuICAvKiogXHU1M0QxXHU3M0IwXHU5ODdBXHU1RThGOlx1NjYzRVx1NUYwRlx1ODk4Nlx1NzZENihcdTU0MkJcdTU0MTFcdTVCRkNcdTkwMDlcdTYyRTk6XHU1OTE2XHU5MEU4XHU1MTY1XHU1M0UzL1x1NTE4NVx1N0Y2RVx1OERFRlx1NUY4NC9cdTZGMTRcdTc5M0EpPiBcdTUxODVcdTdGNkVcdTVGMDBcdTUxNzNcclxuICAgICAoSE1IX0RFU0tUT1BfQlVORExFRD0xKT4gXHU1OTE2XHU5MEU4XHU1M0QxXHU3M0IwKGRldiBcdTc2RjhcdTkwQkJcdTRFRDNcdTVFOTMgLyB3aGVyZSBobWggLyBucG0gXHU1MTY4XHU1QzQwIC9cclxuICAgICBcdTU0MTFcdTVCRkNcdTVCODlcdTg4QzVcdTc2RUVcdTVGNTUgLyBcdTZFOTBcdTc4MDFcdTRGNERcdTdGNkUpPiBcdTUxODVcdTdGNkVcdTUxNUNcdTVFOTVcdTMwMDJcdTU5MTZcdTkwRThcdTRGMThcdTUxNDg9XHU4MDAxXHU3NTI4XHU2MjM3XHU3RUU3XHU3RUVEXHU3NTI4XHU4MUVBXHU1REYxXHU4OEM1XHU3Njg0XHU3MjQ4XHU2NzJDO1xyXG4gICAgIFx1NTE4NVx1N0Y2RT1cdTY1QjBcdTY3M0FcdTU2NjhcdTg4QzVcdTVCOENcdTc2RjRcdThGREVcdTc3MUZcdTVCOUVcdTUxODVcdTY4MzhcdTMwMDJITUhfREVTS1RPUF9GQUtFPTEgXHU2MjE2IHJ1bnRpbWUuanNvbiBkZW1vPXRydWVcclxuICAgICAoXHU1NDExXHU1QkZDXCJcdTZGMTRcdTc5M0FcdTZBMjFcdTVGMEZcIlx1OTAwOVx1NjJFOSxcdTYzMDFcdTRFNDUpXHU4RkRCXHU2RjE0XHU3OTNBXHUzMDAyICovXHJcbiAgYXN5bmMgZnVuY3Rpb24gc3RhcnRIb3N0KCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3QgcmVwb1Jvb3QgPSBqb2luKGhlcmUsICcuLicsICcuLicsICcuLicsICcuLicpOyAvLyBhcHBzL2Rlc2t0b3AvZGlzdC1lbGVjdHJvbi9tYWluIFx1MjE5MiByZXBvIHJvb3RcclxuICAgIGNvbnN0IHBhY2thZ2VkID0gYXBwLmlzUGFja2FnZWQ7XHJcbiAgICBjb25zdCBjZmcgPSBhd2FpdCBsb2FkUnVudGltZUNvbmZpZygpO1xyXG4gICAgY29uc3QgZm9yY2VGYWtlID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfRkFLRSA9PT0gJzEnIHx8IGNmZy5kZW1vO1xyXG4gICAgY29uc3QgZm9yY2VCdW5kbGVkID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfQlVORExFRCA9PT0gJzEnO1xyXG4gICAgY29uc3Qgb3ZlcnJpZGUgPSBjZmcuZW50cnk7XHJcbiAgICBjb25zdCBhZGphY2VudCA9IGpvaW4ocmVwb1Jvb3QsICcuLicsICdobWhhcm5lc3MnLCAncGFja2FnZXMnLCAnd2ViJywgJ3NyYycsICdkZXNrdG9wLWhvc3QudHMnKTtcclxuICAgIGNvbnN0IGJ1bmRsZWQgPSBidW5kbGVkUnVudGltZVBhdGgocmVwb1Jvb3QpO1xyXG4gICAgY29uc3QgYnVuZGxlZFJlYWR5ID0gZXhpc3RzU3luYyhidW5kbGVkKTtcclxuICAgIC8vIFx1ODlFM1x1Njc5MChcdTdFRDNcdTY3OUNcdTVGNTJcdTRFMDA6b3ZlcnJpZGU9YnVuZGxlZCBcdThERUZcdTVGODRcdTIxOTJcdTUxODVcdTdGNkU7XHU2RTkwXHU3ODAxIC50cyBcdTk3MDAgdHN4O1xyXG4gICAgLy8gbnBtIFx1NUI4OVx1ODhDNSAuanMgXHU3RjE2XHU4QkQxXHU0RUE3XHU3MjY5XHU3NkY0XHU4REQxO2J1bmRsZWQ9XHU4MUVBXHU1MzA1XHU1NDJCIGNqcyBcdTc2RjRcdThERDEpXHJcbiAgICBsZXQgZW50cnkgPSAnJztcclxuICAgIHVzZUJ1bmRsZWRSdW50aW1lID0gZmFsc2U7XHJcbiAgICBpZiAoZm9yY2VGYWtlKSB7XHJcbiAgICAgIC8vIFx1NkYxNFx1NzkzQVx1NkEyMVx1NUYwRlxyXG4gICAgfSBlbHNlIGlmIChvdmVycmlkZSAhPT0gJycpIHtcclxuICAgICAgZW50cnkgPSBvdmVycmlkZTtcclxuICAgICAgaWYgKG92ZXJyaWRlID09PSBidW5kbGVkKSB1c2VCdW5kbGVkUnVudGltZSA9IHRydWU7IC8vIFx1NTQxMVx1NUJGQ1x1OTAwOVwiXHU1MTg1XHU3RjZFXHU3Q0JFXHU3QjgwXHU1MTg1XHU2ODM4XCJcdTc2ODRcdTYzMDFcdTRFNDVcdTVGNjJcdTYwMDFcclxuICAgIH0gZWxzZSBpZiAoZm9yY2VCdW5kbGVkKSB7XHJcbiAgICAgIGlmIChidW5kbGVkUmVhZHkpIHsgZW50cnkgPSBidW5kbGVkOyB1c2VCdW5kbGVkUnVudGltZSA9IHRydWU7IH1cclxuICAgICAgZWxzZSBsb2dJbmZvKCdob3N0JywgJ0hNSF9ERVNLVE9QX0JVTkRMRUQ9MSBcdTRGNDZcdTUxODVcdTdGNkUgcnVudGltZSBcdTdGM0FcdTU5MzEoXHU1MTQ4XHU4REQxIHNjcmlwdHMvYnVuZGxlLXJ1bnRpbWUubWpzKScpO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgZW50cnkgPSBwYWNrYWdlZCA/IGRldGVjdFJlYWxFbnRyeSgpIDogKGV4aXN0c1N5bmMoYWRqYWNlbnQpID8gYWRqYWNlbnQgOiBkZXRlY3RSZWFsRW50cnkoKSk7XHJcbiAgICAgIGlmIChlbnRyeSA9PT0gJycgJiYgYnVuZGxlZFJlYWR5KSB7IGVudHJ5ID0gYnVuZGxlZDsgdXNlQnVuZGxlZFJ1bnRpbWUgPSB0cnVlOyB9XHJcbiAgICB9XHJcbiAgICBydW50aW1lRW50cnkgPSBlbnRyeTtcclxuICAgIGNvbnN0IHVzZVJlYWwgPSBlbnRyeSAhPT0gJycgJiYgKHVzZUJ1bmRsZWRSdW50aW1lIHx8IGV4aXN0c1N5bmMoZW50cnkpKTtcclxuICAgIGJyaWRnZSA9IHtcclxuICAgICAgLi4uYnJpZGdlLFxyXG4gICAgICBtb2RlOiB1c2VSZWFsID8gJ3JlYWwnIDogJ2Zha2UnLFxyXG4gICAgICBydW50aW1lRW50cnk6IHVzZVJlYWwgPyAodXNlQnVuZGxlZFJ1bnRpbWUgPyBgJHtlbnRyeX0gKGJ1bmRsZWQpYCA6IGVudHJ5KSA6IG51bGwsXHJcbiAgICB9O1xyXG4gICAgbGV0IHNwZWM6IHsgY29tbWFuZDogc3RyaW5nOyBhcmdzOiBzdHJpbmdbXTsgZW52OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+OyBjd2Q/OiBzdHJpbmcgfTtcclxuICAgIGlmICh1c2VCdW5kbGVkUnVudGltZSkge1xyXG4gICAgICBzcGVjID0ge1xyXG4gICAgICAgIGNvbW1hbmQ6IHByb2Nlc3MuZXhlY1BhdGgsXHJcbiAgICAgICAgYXJnczogW2VudHJ5XSwgLy8gXHU4MUVBXHU1MzA1XHU1NDJCXHU1MzU1XHU2NTg3XHU0RUY2OmVsZWN0cm9uLWFzLW5vZGUgXHU3NkY0XHU4REQxLFx1NjVFMCB0c3ggXHU2NUUwIHJlcG9cclxuICAgICAgICBlbnY6IHsgRUxFQ1RST05fUlVOX0FTX05PREU6ICcxJyB9LFxyXG4gICAgICB9O1xyXG4gICAgfSBlbHNlIGlmICh1c2VSZWFsICYmIGVudHJ5LmVuZHNXaXRoKCcuanMnKSkge1xyXG4gICAgICBzcGVjID0ge1xyXG4gICAgICAgIGNvbW1hbmQ6IHByb2Nlc3MuZXhlY1BhdGgsXHJcbiAgICAgICAgYXJnczogW2VudHJ5XSwgLy8gbnBtIFx1NUI4OVx1ODhDNVx1NzY4NFx1N0YxNlx1OEJEMVx1NEVBN1x1NzI2OTpFU00gXHU0RjlEXHU4RDU2XHU2MzA5XHU2NTg3XHU0RUY2XHU0RjREXHU3RjZFXHU4OUUzXHU2NzkwLFx1NzZGNFx1OEREMVx1NTM3M1x1NTNFRlxyXG4gICAgICAgIGN3ZDogZGlybmFtZShlbnRyeSksXHJcbiAgICAgICAgZW52OiB7IEVMRUNUUk9OX1JVTl9BU19OT0RFOiAnMScgfSxcclxuICAgICAgfTtcclxuICAgIH0gZWxzZSBpZiAodXNlUmVhbCkge1xyXG4gICAgICBjb25zdCByZXBvID0gcmVwb1Jvb3RPZihlbnRyeSk7XHJcbiAgICAgIHNwZWMgPSB7XHJcbiAgICAgICAgY29tbWFuZDogcHJvY2Vzcy5leGVjUGF0aCxcclxuICAgICAgICBhcmdzOiBbJy0taW1wb3J0JywgJ3RzeCcsIGVudHJ5XSxcclxuICAgICAgICBjd2Q6IHJlcG8sIC8vIGJhcmUgJ3RzeCcgXHU0RTBFIHdvcmtzcGFjZSBcdTRGOURcdThENTZcdTkwRkRcdTRFQ0UgcmVwbyBcdTc2ODQgbm9kZV9tb2R1bGVzIFx1ODlFM1x1Njc5MFxyXG4gICAgICAgIGVudjogeyBFTEVDVFJPTl9SVU5fQVNfTk9ERTogJzEnIH0sXHJcbiAgICAgIH07XHJcbiAgICB9IGVsc2UgaWYgKHBhY2thZ2VkKSB7XHJcbiAgICAgIHNwZWMgPSB7XHJcbiAgICAgICAgY29tbWFuZDogcHJvY2Vzcy5leGVjUGF0aCxcclxuICAgICAgICBhcmdzOiBbam9pbihwcm9jZXNzLnJlc291cmNlc1BhdGgsICdmYWtlLWhvc3QuY2pzJyldLFxyXG4gICAgICAgIGVudjogeyBFTEVDVFJPTl9SVU5fQVNfTk9ERTogJzEnIH0sXHJcbiAgICAgIH07XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICBzcGVjID0ge1xyXG4gICAgICAgIGNvbW1hbmQ6IHByb2Nlc3MuZXhlY1BhdGgsXHJcbiAgICAgICAgLy8gXHU3NkY0XHU2M0E1XHU4RDcwXHU1MzA1XHU3NzFGXHU1QjlFXHU4REVGXHU1Rjg0KG5vZGVfbW9kdWxlcyBcdTkxQ0NcdTc2ODQgd29ya3NwYWNlIGp1bmN0aW9uIFx1NEYxQVx1ODhBQiBFU01cclxuICAgICAgICAvLyByZWFscGF0aCBcdTUzMTYsXHU1QkZDXHU4MUY0IGZha2UtaG9zdCBcdTc2ODQgYXJndlsxXS9pbXBvcnQubWV0YS51cmwgXHU1MzM5XHU5MTREXHU1OTMxXHU2NTQ4KVxyXG4gICAgICAgIGFyZ3M6IFsnLS1pbXBvcnQnLCAndHN4Jywgam9pbihyZXBvUm9vdCwgJ3BhY2thZ2VzJywgJ2hvc3QtYWRhcHRlcicsICdzcmMnLCAnZmFrZS1ob3N0LnRzJyldLFxyXG4gICAgICAgIGVudjogeyBFTEVDVFJPTl9SVU5fQVNfTk9ERTogJzEnIH0sXHJcbiAgICAgIH07XHJcbiAgICB9XHJcbiAgICBzdXBlcnZpc29yID0gbmV3IERlc2t0b3BSdW50aW1lU3VwZXJ2aXNvcihzcGVjLCB7XHJcbiAgICAgIG9uU3RhdGVDaGFuZ2U6IGJyb2FkY2FzdEhvc3RTdGF0ZSxcclxuICAgICAgLy8gXHU5OTk2XHU2QjIxXHU1NDJGXHU1MkE4XHU0RTBFIGNyYXNoIFx1ODFFQVx1NjEwOFx1NTQwRVx1NzY4NFx1OTFDRFx1NTQyRlx1OTBGRFx1NEYxQVx1OEQ3MFx1OEZEOVx1OTFDQzpcdTdBRUZcdTUzRTMvdG9rZW4gXHU5MEZEXHU2NjJGXHU2NUIwXHU3Njg0LFxyXG4gICAgICAvLyBcdTkxQ0RcdTVFRkFcdTY4NjVcdTVCQTJcdTYyMzdcdTdBRUZcdTVFNzZcdTkxQ0RcdTY1QjBcdThCQTJcdTk2MDUgU1NFKHJlbmRlcmVyIFx1NzY4NCBFdmVudFN0b3JlIFx1OTc2MCBldmVudElkIFx1NTNCQlx1OTFDRClcclxuICAgICAgb25SZWFkeTogKGVwKSA9PiB7XHJcbiAgICAgICAgY2xpZW50ID0gbmV3IERlc2t0b3BIb3N0Q2xpZW50KGBodHRwOi8vMTI3LjAuMC4xOiR7ZXAucG9ydH1gLCBlcC50b2tlbik7XHJcbiAgICAgICAgc3NlQWJvcnQ/LmFib3J0KCk7XHJcbiAgICAgICAgc3NlQWJvcnQgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XHJcbiAgICAgICAgbGFzdEV2ZW50SWQgPSAnJztcclxuICAgICAgICB2b2lkIHB1bXBFdmVudHMoKTtcclxuICAgICAgICBsb2dJbmZvKCdob3N0JywgYGJyaWRnZSByZWFkeSBvbiAxMjcuMC4wLjE6JHtlcC5wb3J0fSAocnVudGltZSAke2VwLnZlcnNpb259LCBtb2RlICR7YnJpZGdlLm1vZGV9JHt1c2VSZWFsID8gYCwgZW50cnk9JHtydW50aW1lRW50cnl9JHt1c2VCdW5kbGVkUnVudGltZSA/ICcgW2J1bmRsZWRdJyA6ICcnfWAgOiAnJ30pYCk7XHJcbiAgICAgIH0sXHJcbiAgICB9KTtcclxuICAgIHRyeSB7XHJcbiAgICAgIGF3YWl0IHN1cGVydmlzb3Iuc3RhcnQoKTtcclxuICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICBjb25zdCBkZXRhaWwgPSAoKCkgPT4geyB0cnkgeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkoZXJyKTsgfSBjYXRjaCB7IHJldHVybiBTdHJpbmcoZXJyKTsgfSB9KSgpLnNsaWNlKDAsIDQwMCk7XHJcbiAgICAgIGJyaWRnZSA9IHsgLi4uYnJpZGdlLCBob3N0U3RhdGU6ICdmYWlsZWQnLCBsYXN0RXJyb3I6IGRldGFpbCB9O1xyXG4gICAgICBsb2dJbmZvKCdob3N0JywgYHN0YXJ0IGZhaWxlZDogJHtkZXRhaWx9YCk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvKiAtLS0tIElQQyBcdTc2N0RcdTU0MERcdTUzNTUgKyBzZW5kZXIgXHU2ODIxXHU5QThDIC0tLS0gKi9cclxuICBjb25zdCBhbGxvd2VkT3JpZ2lucyA9IG5ldyBTZXQ8c3RyaW5nPihcclxuICAgIGlzRGV2ICYmIHJlbmRlcmVyRGV2VXJsXHJcbiAgICAgID8gW3JlbmRlcmVyRGV2VXJsXVxyXG4gICAgICA6IFtwYXRoVG9GaWxlVVJMKGpvaW4oaGVyZSwgJy4uJywgJy4uJywgJ2Rpc3QtcmVuZGVyZXInLCAnaW5kZXguaHRtbCcpKS5ocmVmXSxcclxuICApO1xyXG5cclxuICBmdW5jdGlvbiBzZW5kZXJUcnVzdGVkKHNlbmRlckZyYW1lOiBFbGVjdHJvbi5XZWJGcmFtZU1haW4gfCBudWxsIHwgdW5kZWZpbmVkKTogYm9vbGVhbiB7XHJcbiAgICBpZiAoc2VuZGVyRnJhbWUgPT09IG51bGwgfHwgc2VuZGVyRnJhbWUgPT09IHVuZGVmaW5lZCkgcmV0dXJuIGZhbHNlO1xyXG4gICAgbGV0IHRvcDogRWxlY3Ryb24uV2ViRnJhbWVNYWluIHwgbnVsbCA9IHNlbmRlckZyYW1lO1xyXG4gICAgd2hpbGUgKHRvcD8ucGFyZW50ICE9PSBudWxsICYmIHRvcD8ucGFyZW50ICE9PSB1bmRlZmluZWQpIHRvcCA9IHRvcC5wYXJlbnQ7XHJcbiAgICBjb25zdCB1cmwgPSB0b3A/LnVybCA/PyAnJztcclxuICAgIGZvciAoY29uc3Qgb3JpZ2luIG9mIGFsbG93ZWRPcmlnaW5zKSB7XHJcbiAgICAgIGlmICh1cmwgPT09IG9yaWdpbiB8fCB1cmwuc3RhcnRzV2l0aChgJHtvcmlnaW59L2ApIHx8IHVybC5zdGFydHNXaXRoKGAke29yaWdpbn0/YCkpIHJldHVybiB0cnVlO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGZhbHNlO1xyXG4gIH1cclxuXHJcbiAgLyoqIFx1OTcwMFx1ODk4MSBob3N0IFx1NUMzMVx1N0VFQVx1NzY4NCBJUEMgaGFuZGxlciBcdTUxNkNcdTUxNzFcdTU4RjM6XHU2NzJBXHU1QzMxXHU3RUVBXHU4RkQ0XHU1NkRFXHU3RUQzXHU2Nzg0XHU1MzE2XHU5NTE5XHU4QkVGXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gaG9zdENhbGw8VD4oZXZlbnQ6IEVsZWN0cm9uLklwY01haW5JbnZva2VFdmVudCwgZm46IChjOiBEZXNrdG9wSG9zdENsaWVudCkgPT4gUHJvbWlzZTxUPik6IFByb21pc2U8VCB8IHsgZXJyb3I6IHN0cmluZzsgY29kZTogc3RyaW5nIH0+IHtcclxuICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9KTtcclxuICAgIGlmIChjbGllbnQgPT09IG51bGwgfHwgYnJpZGdlLmhvc3RTdGF0ZSAhPT0gJ3JlYWR5Jykge1xyXG4gICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6IGBob3N0IG5vdCByZWFkeSAoJHticmlkZ2UuaG9zdFN0YXRlfSlgLCBjb2RlOiAnSE9TVF9OT1RfUkVBRFknIH0pO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGZuKGNsaWVudCkuY2F0Y2goKGVycjogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBkZXRhaWwgPSAoKCkgPT4geyB0cnkgeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkoZXJyKTsgfSBjYXRjaCB7IHJldHVybiBTdHJpbmcoZXJyKTsgfSB9KSgpLnNsaWNlKDAsIDMwMCk7XHJcbiAgICAgIHJldHVybiB7IGVycm9yOiBkZXRhaWwsIGNvZGU6ICdCUklER0VfRVJST1InIH07XHJcbiAgICB9KTtcclxuICB9XHJcblxyXG4gIGZ1bmN0aW9uIHJlZ2lzdGVySXBjKCk6IHZvaWQge1xyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpnZXQtc3RhdGUnLCAoZXZlbnQpID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJyB9O1xyXG4gICAgICByZXR1cm4geyAuLi5icmlkZ2UsIGRyb3BwZWRGcmFtZXMgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6c2Vzc2lvbnMnLCAoZXZlbnQpID0+XHJcbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPHsgc2Vzc2lvbnM6IEFycmF5PHsgaWQ6IHN0cmluZzsgdGl0bGU6IHN0cmluZzsgdGFzazogc3RyaW5nOyBvdXRjb21lOiBzdHJpbmc7IHR1cm5zOiBudW1iZXI7IHRvb2xVc2VzOiBudW1iZXI7IHRpbWU6IHN0cmluZzsgY3dkOiBzdHJpbmc7IGNyZWF0ZWRBdDogc3RyaW5nOyB1cGRhdGVkQXQ6IHN0cmluZyB9PiB9PignL2FwaS9zZXNzaW9ucz9saW1pdD0xMDAnKSkpO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6c2VuZC10YXNrJywgKGV2ZW50LCB0ZXh0OiB1bmtub3duLCBzZXNzaW9uSWQ6IHVua25vd24sIG1vZGU6IHVua25vd24sIGF0dGFjaG1lbnRzOiB1bmtub3duLCBpbWFnZXM6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3QgdGFzayA9IHR5cGVvZiB0ZXh0ID09PSAnc3RyaW5nJyA/IHRleHQuc2xpY2UoMCwgMjBfMDAwKSA6ICcnO1xyXG4gICAgICBjb25zdCBzaWQgPSB0eXBlb2Ygc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IHNlc3Npb25JZC5zbGljZSgwLCA4MCkgOiAnJztcclxuICAgICAgY29uc3QgbSA9IG1vZGUgPT09ICdhdXRvJyB8fCBtb2RlID09PSAneW9sbycgPyBtb2RlIDogJ2Fzayc7XHJcbiAgICAgIC8vIFx1OTY0NFx1NEVGNjpcdTU0MEVcdTdBRUZcdTYzODhcdTY3NDMgRFRPIFx1NzY4NFx1N0VERFx1NUJGOVx1OERFRlx1NUY4NChAIFx1OTAwOVx1NjJFOVx1NTY2OC9cdUQ4M0RcdURDQ0UgXHU0RTBBXHU0RjIwXHU1M0VBXHU2NzY1XHU4MUVBXHU2NzJDXHU1NzMwXHU2NTg3XHU0RUY2XHU3Q0ZCXHU3RURGKVxyXG4gICAgICBjb25zdCBhdHRzID0gQXJyYXkuaXNBcnJheShhdHRhY2htZW50cykgPyBhdHRhY2htZW50cy5maWx0ZXIoKGEpOiBhIGlzIHN0cmluZyA9PiB0eXBlb2YgYSA9PT0gJ3N0cmluZycpLnNsaWNlKDAsIDEwKSA6IFtdO1xyXG4gICAgICAvLyBcdTU2RkVcdTcyNDc6cnVudGltZSB2aXNpb24gXHU5NEZFXHU1MzRGXHU4QkFFIHtuYW1lLCBkYXRhVXJsfSBiYXNlNjQoXHUyMjY0MyBcdTVGMjAgXHUyMjY0Nk1CLHJlbmRlcmVyIFx1NzUxRlx1NjIxMClcclxuICAgICAgY29uc3QgaW1ncyA9IEFycmF5LmlzQXJyYXkoaW1hZ2VzKVxyXG4gICAgICAgID8gaW1hZ2VzXHJcbiAgICAgICAgICAgIC5maWx0ZXIoKGltKTogaW0gaXMgeyBuYW1lOiBzdHJpbmc7IGRhdGFVcmw6IHN0cmluZyB9ID0+XHJcbiAgICAgICAgICAgICAgdHlwZW9mIGltID09PSAnb2JqZWN0JyAmJiBpbSAhPT0gbnVsbCAmJiB0eXBlb2YgKGltIGFzIHsgbmFtZT86IHVua25vd24gfSkubmFtZSA9PT0gJ3N0cmluZycgJiYgdHlwZW9mIChpbSBhcyB7IGRhdGFVcmw/OiB1bmtub3duIH0pLmRhdGFVcmwgPT09ICdzdHJpbmcnKVxyXG4gICAgICAgICAgICAuc2xpY2UoMCwgMylcclxuICAgICAgICAgICAgLm1hcCgoaW0pID0+ICh7IG5hbWU6IGltLm5hbWUuc2xpY2UoMCwgMTIwKSwgZGF0YVVybDogaW0uZGF0YVVybC5zbGljZSgwLCA4XzUwMF8wMDApIH0pKVxyXG4gICAgICAgIDogW107XHJcbiAgICAgIGlmICh0YXNrID09PSAnJyB8fCBzaWQgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgb2s6IGZhbHNlLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW47IHJ1bklkPzogc3RyaW5nIH0+KCcvYXBpL3Rhc2snLCB7IHRleHQ6IHRhc2ssIHNlc3Npb25JZDogc2lkLCBtb2RlOiBtLCBhdHRhY2htZW50czogYXR0cywgaW1hZ2VzOiBpbWdzIH0pKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gXHU2QTIxXHU1NzhCXHU1MjA3XHU2MzYyKHJ1bnRpbWUgUE9TVCAvYXBpL21vZGVsOlx1NTIwNyBjaGF0IFx1OERFRlx1NzUzMSxjb25maWcgXHU1MzczXHU2NUY2XHU3NTFGXHU2NTQ4KSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOm1vZGVsLXNldCcsIChldmVudCwgbmFtZTogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBuID0gdHlwZW9mIG5hbWUgPT09ICdzdHJpbmcnID8gbmFtZS50cmltKCkuc2xpY2UoMCwgODApIDogJyc7XHJcbiAgICAgIGlmIChuID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAnbmFtZSByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbjsgbW9kZWw/OiBzdHJpbmcgfT4oJy9hcGkvbW9kZWwnLCB7IG5hbWU6IG4gfSkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBcdTVFOTRcdTc1MjhcdTUxODVcdTY2RjRcdTY1QjAoR2l0SHViIFJlbGVhc2VzO1x1ODFFQVx1NzgxNFx1OTZGNlx1NEY5RFx1OEQ1Nlx1NjZGNFx1NjVCMFx1NTY2OCkgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpjaGVjay11cGRhdGUnLCBhc3luYyAoZXZlbnQpID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgcmV0dXJuIGNoZWNrRm9yVXBkYXRlcygpO1xyXG4gICAgfSk7XHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmFwcGx5LXVwZGF0ZScsIChldmVudCkgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBpZiAoaW5zdGFsbGVyUGF0aCA9PT0gbnVsbCkgcmV0dXJuIHsgZXJyb3I6ICdubyBpbnN0YWxsZXIgZG93bmxvYWRlZCcsIGNvZGU6ICdIT1NUX05PVF9SRUFEWScgfTtcclxuICAgICAgYXBwbHlVcGRhdGUoKTtcclxuICAgICAgcmV0dXJuIHsgb2s6IHRydWUgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gXHU2ODA3XHU5ODk4XHU2ODBGXHU0RTNCXHU5ODk4XHU1NDBDXHU2QjY1KFx1NkQ0NVx1ODI3Mlx1NkEyMVx1NUYwRlx1NEUwRFx1NTE4RFx1NjcwOVx1OUVEMVx1Njc2MSkrIFx1MjYzMCBcdTRFM0JcdTgzRENcdTUzNTUgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpjaHJvbWUtdGhlbWUnLCAoZXZlbnQsIGRhcms6IHVua25vd24pID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgYXBwbHlDaHJvbWUoZGFyayA9PT0gdHJ1ZSk7XHJcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlIH07XHJcbiAgICB9KTtcclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cG9wdXAtbWFpbi1tZW51JywgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIHBvcHVwTWFpbk1lbnUoKTtcclxuICAgICAgcmV0dXJuIHsgb2s6IHRydWUgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gXHU2MjRCXHU2NzNBXHU4RkRDXHU3QTBCXHU2M0E3XHU1MjM2KDc3ODggd2ViIFx1NUI4OFx1NjJBNDtcdTc1MjhcdTYyMzdcdTY2M0VcdTVGMEZcdTU0MkZcdTUyQTgsQURSLTAwNSBcdTRFMERcdTlFRDhcdThCQTRcdTVGMDAgTEFOKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnJlbW90ZS13ZWItc3RhdHVzJywgYXN5bmMgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IHAgPSBhd2FpdCBwcm9iZVdlYlJlbW90ZSgpO1xyXG4gICAgICByZXR1cm4geyB1cDogcC51cCwgdmVyc2lvbjogcC52ZXJzaW9uLCBsYW5JcDogbGFuSXBPZigpLCBwb3J0OiBXRUJfUE9SVCwgYXZhaWxhYmxlOiBjbGlFbnRyeU9mKCkgIT09ICcnLCBhdXRvc3RhcnQ6IHdlYkF1dG9zdGFydEluc3RhbGxlZCgpIH07XHJcbiAgICB9KTtcclxuICAgIC8vIC0tLS0gXHU1RjAwXHU2NzNBXHU4MUVBXHU1NDJGKDAuMjMuMzcgd2ViIGluc3RhbGwtZGFlbW9uL3VuaW5zdGFsbC1kYWVtb247XHU3NjdCXHU1RjU1XHU1MzczXHU1Qjg4XHU2MkE0XHU1NzI4XHU3RUJGKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnJlbW90ZS13ZWItYXV0b3N0YXJ0JywgYXN5bmMgKGV2ZW50LCBlbmFibGVkOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGlmIChjbGlFbnRyeU9mKCkgPT09ICcnKSByZXR1cm4geyBlcnJvcjogJ25vIGhtaGFybmVzcyBydW50aW1lIGRldGVjdGVkJywgY29kZTogJ0hPU1RfTk9UX1JFQURZJyB9O1xyXG4gICAgICBydW5DbGkoWyd3ZWInLCBlbmFibGVkID09PSB0cnVlID8gJ2luc3RhbGwtZGFlbW9uJyA6ICd1bmluc3RhbGwtZGFlbW9uJ10pO1xyXG4gICAgICAvLyBpbnN0YWxsLWRhZW1vbiBcdTdBQ0JcdTUzNzNcdTYyQzlcdThENzdcdTVCODhcdTYyQTQ6XHU4RjZFXHU4QkUyXHU3ODZFXHU4QkE0O3VuaW5zdGFsbCBcdTUzNzNcdTY1RjZcdTc1MUZcdTY1NDhcclxuICAgICAgaWYgKGVuYWJsZWQgPT09IHRydWUpIHtcclxuICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IDUwOyBpKyspIHtcclxuICAgICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDUwMCkpO1xyXG4gICAgICAgICAgaWYgKChhd2FpdCBwcm9iZVdlYlJlbW90ZSgpKS51cCkgcmV0dXJuIHsgb2s6IHRydWUsIGF1dG9zdGFydDogd2ViQXV0b3N0YXJ0SW5zdGFsbGVkKCkgfTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHsgZXJyb3I6ICdkYWVtb24gZGlkIG5vdCBjb21lIHVwIHdpdGhpbiAyNXMnLCBjb2RlOiAnUlVOVElNRV9DUkFTSEVEJyB9O1xyXG4gICAgICB9XHJcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBhdXRvc3RhcnQ6IHdlYkF1dG9zdGFydEluc3RhbGxlZCgpIH07XHJcbiAgICB9KTtcclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cmVtb3RlLXdlYi1zdGFydCcsIGFzeW5jIChldmVudCkgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBpZiAoY2xpRW50cnlPZigpID09PSAnJykgcmV0dXJuIHsgZXJyb3I6ICdubyBobWhhcm5lc3MgcnVudGltZSBkZXRlY3RlZCcsIGNvZGU6ICdIT1NUX05PVF9SRUFEWScgfTtcclxuICAgICAgaWYgKChhd2FpdCBwcm9iZVdlYlJlbW90ZSgpKS51cCkge1xyXG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBhbHJlYWR5OiB0cnVlLCBsYW5Vcmw6IGBodHRwOi8vJHtsYW5JcE9mKCkgfHwgJzEyNy4wLjAuMSd9OiR7V0VCX1BPUlR9YCB9O1xyXG4gICAgICB9XHJcbiAgICAgIHJ1bkNsaShbJ3dlYicsICdzdGFydCcsICctLWV4cG9zdXJlPWxhbiddKTtcclxuICAgICAgLy8gXHU1Qjg4XHU2MkE0XHU4RkRCXHU3QTBCXHU1MUI3XHU1NDJGXHU1MkE4KHRzeCBcdTdGMTZcdThCRDFcdTY1NzRcdTU5NTcgQ0xJKTpcdThGNkVcdThCRTIgMjVzXHJcbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgNTA7IGkrKykge1xyXG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDUwMCkpO1xyXG4gICAgICAgIGlmICgoYXdhaXQgcHJvYmVXZWJSZW1vdGUoKSkudXApIHtcclxuICAgICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBsYW5Vcmw6IGBodHRwOi8vJHtsYW5JcE9mKCkgfHwgJzEyNy4wLjAuMSd9OiR7V0VCX1BPUlR9YCB9O1xyXG4gICAgICAgIH1cclxuICAgICAgfVxyXG4gICAgICByZXR1cm4geyBlcnJvcjogJ3dlYiBkYWVtb24gZGlkIG5vdCBjb21lIHVwIHdpdGhpbiAyNXMgKHNlZSBITUhfSE9NRS93ZWIubG9nKScsIGNvZGU6ICdSVU5USU1FX0NSQVNIRUQnIH07XHJcbiAgICB9KTtcclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cmVtb3RlLXdlYi1zdG9wJywgYXN5bmMgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIHJ1bkNsaShbJ3dlYicsICdzdG9wJ10pO1xyXG4gICAgICBmb3IgKGxldCBpID0gMDsgaSA8IDIwOyBpKyspIHtcclxuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCA0MDApKTtcclxuICAgICAgICBpZiAoIShhd2FpdCBwcm9iZVdlYlJlbW90ZSgpKS51cCkgcmV0dXJuIHsgb2s6IHRydWUgfTtcclxuICAgICAgfVxyXG4gICAgICBjb25zdCBzdGlsbCA9IChhd2FpdCBwcm9iZVdlYlJlbW90ZSgpKS51cDtcclxuICAgICAgcmV0dXJuIHN0aWxsID8geyBlcnJvcjogJ3N0aWxsIHJ1bm5pbmcnLCBjb2RlOiAnQlJJREdFX0VSUk9SJyB9IDogeyBvazogdHJ1ZSB9O1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBcdUQ4M0RcdURDQ0UgXHU2NTg3XHU0RUY2XHU0RTBBXHU0RjIwKFx1NjcyQ1x1NTczMFx1NTkxQVx1OTAwOTtydW50aW1lIFx1NjgyMVx1OUE4QyBpbnNpZGVXcyxcdTVERTVcdTRGNUNcdTUzM0FcdTU5MTZcdTY1ODdcdTRFRjZcdTRGMUFcdTg4QUIgNDAwKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnBpY2stZmlsZXMnLCBhc3luYyAoZXZlbnQsIHRpdGxlOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IHdpbiA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmZpbmQoKHcpID0+ICF3LmlzRGVzdHJveWVkKCkpO1xyXG4gICAgICBpZiAod2luID09PSB1bmRlZmluZWQpIHJldHVybiB7IGVycm9yOiAnbm8gd2luZG93JywgY29kZTogJ0JSSURHRV9FUlJPUicgfTtcclxuICAgICAgY29uc3QgciA9IGF3YWl0IGRpYWxvZy5zaG93T3BlbkRpYWxvZyh3aW4sIHtcclxuICAgICAgICB0aXRsZTogdHlwZW9mIHRpdGxlID09PSAnc3RyaW5nJyAmJiB0aXRsZSAhPT0gJycgPyB0aXRsZS5zbGljZSgwLCAxMjApIDogJ1x1OTAwOVx1NjJFOVx1ODk4MVx1OTY0NFx1NTJBMFx1NzY4NFx1NjU4N1x1NEVGNihcdTUzRUZcdTU5MUFcdTkwMDkpJyxcclxuICAgICAgICBwcm9wZXJ0aWVzOiBbJ29wZW5GaWxlJywgJ211bHRpU2VsZWN0aW9ucyddLFxyXG4gICAgICB9KTtcclxuICAgICAgaWYgKHIuY2FuY2VsZWQgfHwgci5maWxlUGF0aHMubGVuZ3RoID09PSAwKSByZXR1cm4geyBvazogZmFsc2UsIGNhbmNlbGVkOiB0cnVlIH07XHJcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBwYXRoczogci5maWxlUGF0aHMuc2xpY2UoMCwgMTApIH07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIFx1RDgzRFx1RENDMSBcdTc2RUVcdTVGNTVcdTkwMDlcdTYyRTkoXHU1REU1XHU0RjVDXHU1MzNBXHU2REZCXHU1MkEwXHU3Njg0XHU2RDRGXHU4OUM4XHU2MzA5XHU5NEFFO1x1NTM5Rlx1NzUxRiBjaG9vc2VyKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnBpY2stZGlyZWN0b3J5JywgYXN5bmMgKGV2ZW50LCB0aXRsZTogdW5rbm93bikgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBjb25zdCB3aW4gPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5maW5kKCh3KSA9PiAhdy5pc0Rlc3Ryb3llZCgpKTtcclxuICAgICAgaWYgKHdpbiA9PT0gdW5kZWZpbmVkKSByZXR1cm4geyBlcnJvcjogJ25vIHdpbmRvdycsIGNvZGU6ICdCUklER0VfRVJST1InIH07XHJcbiAgICAgIGNvbnN0IHIgPSBhd2FpdCBkaWFsb2cuc2hvd09wZW5EaWFsb2cod2luLCB7XHJcbiAgICAgICAgdGl0bGU6IHR5cGVvZiB0aXRsZSA9PT0gJ3N0cmluZycgJiYgdGl0bGUgIT09ICcnID8gdGl0bGUuc2xpY2UoMCwgMTIwKSA6ICdcdTkwMDlcdTYyRTlcdTY1ODdcdTRFRjZcdTU5MzknLFxyXG4gICAgICAgIHByb3BlcnRpZXM6IFsnb3BlbkRpcmVjdG9yeSddLFxyXG4gICAgICB9KTtcclxuICAgICAgaWYgKHIuY2FuY2VsZWQgfHwgci5maWxlUGF0aHNbMF0gPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBjYW5jZWxlZDogdHJ1ZSB9O1xyXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgcGF0aDogci5maWxlUGF0aHNbMF0gfTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gQCBcdTk2NDRcdTRFRjY6XHU1REU1XHU0RjVDXHU1MzNBXHU2NTg3XHU0RUY2XHU2NDFDXHU3RDIyKHJ1bnRpbWUgXHU2Mzg4XHU2NzQzXHU3Njg0XHU4REVGXHU1Rjg0XHU2NzY1XHU2RTkwKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmZzLXNlYXJjaCcsIChldmVudCwgcTogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBxdWVyeSA9IHR5cGVvZiBxID09PSAnc3RyaW5nJyA/IHEuc2xpY2UoMCwgMjAwKSA6ICcnO1xyXG4gICAgICBpZiAocXVlcnkgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgcmVzdWx0czogW10gfSk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjx7IHJlc3VsdHM6IEFycmF5PHsgcmVsOiBzdHJpbmc7IHBhdGg6IHN0cmluZyB9PiB9PihgL2FwaS9mcy9zZWFyY2g/cT0ke2VuY29kZVVSSUNvbXBvbmVudChxdWVyeSl9YCkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTphcHByb3ZlJywgKGV2ZW50LCBncmFudGVkOiB1bmtub3duLCBzZXNzaW9uSWQ6IHVua25vd24pID0+XHJcbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KCcvYXBpL2FwcHJvdmUnLCB7XHJcbiAgICAgICAgZ3JhbnRlZDogZ3JhbnRlZCA9PT0gdHJ1ZSxcclxuICAgICAgICBzZXNzaW9uSWQ6IHR5cGVvZiBzZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gc2Vzc2lvbklkLnNsaWNlKDAsIDgwKSA6ICcnLFxyXG4gICAgICB9KSkpO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6aW50ZXJydXB0JywgKGV2ZW50LCBzZXNzaW9uSWQ6IHVua25vd24pID0+XHJcbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KCcvYXBpL2ludGVycnVwdCcsIHtcclxuICAgICAgICBzZXNzaW9uSWQ6IHR5cGVvZiBzZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gc2Vzc2lvbklkLnNsaWNlKDAsIDgwKSA6ICcnLFxyXG4gICAgICB9KSkpO1xyXG5cclxuICAgIC8vIC0tLS0gTTQ6XHU1REU1XHU0RjVDXHU1MzNBXHU2NTg3XHU0RUY2XHU5NzYyKFx1OERFRlx1NUY4NFx1NjM4OFx1Njc0M1x1NTcyOCBydW50aW1lOmluc2lkZVdzIFx1NjgyMVx1OUE4QykgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpmcy1saXN0JywgKGV2ZW50LCBwYXRoOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IHAgPSB0eXBlb2YgcGF0aCA9PT0gJ3N0cmluZycgPyBwYXRoLnNsaWNlKDAsIDEwMDApIDogJyc7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oYC9hcGkvZnM/ZmlsZXM9MSR7cCAhPT0gJycgPyBgJnBhdGg9JHtlbmNvZGVVUklDb21wb25lbnQocCl9YCA6ICcnfWApKTtcclxuICAgIH0pO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6ZnMtcmVhZCcsIChldmVudCwgcGF0aDogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBwID0gdHlwZW9mIHBhdGggPT09ICdzdHJpbmcnID8gcGF0aC5zbGljZSgwLCAxMDAwKSA6ICcnO1xyXG4gICAgICBpZiAocCA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ3BhdGggcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KGAvYXBpL2ZzL3JlYWQ/cGF0aD0ke2VuY29kZVVSSUNvbXBvbmVudChwKX1gKSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmluamVjdCcsIChldmVudCwgdGV4dDogdW5rbm93biwgc2Vzc2lvbklkOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IHQgPSB0eXBlb2YgdGV4dCA9PT0gJ3N0cmluZycgPyB0ZXh0LnNsaWNlKDAsIDIwXzAwMCkgOiAnJztcclxuICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIHNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBzZXNzaW9uSWQuc2xpY2UoMCwgODApIDogJyc7XHJcbiAgICAgIGlmICh0ID09PSAnJyB8fCBzaWQgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgb2s6IGZhbHNlLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvaW5qZWN0JywgeyB0ZXh0OiB0LCBzZXNzaW9uSWQ6IHNpZCB9KSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIFx1NEYxQVx1OEJERFx1NUJGQ1x1NTFGQShleHBvcnQubWQgXHUyMTkyIFx1NEZERFx1NUI1OFx1NUJGOVx1OEJERFx1Njg0NjtcdTY1ODdcdTRFRjZcdTUxOTlcdTUxNjVcdTUzRUFcdTU3MjggbWFpbikgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpleHBvcnQtc2Vzc2lvbicsIGFzeW5jIChldmVudCwgaWQ6IHVua25vd24sIHRpdGxlOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IHNpZCA9IHR5cGVvZiBpZCA9PT0gJ3N0cmluZycgPyBpZC5yZXBsYWNlKC9bXmEtekEtWjAtOV86LkAtXS9nLCAnJykuc2xpY2UoMCwgODApIDogJyc7XHJcbiAgICAgIGlmIChzaWQgPT09ICcnKSByZXR1cm4geyBlcnJvcjogJ2lkIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9O1xyXG4gICAgICBpZiAoY2xpZW50ID09PSBudWxsIHx8IGJyaWRnZS5ob3N0U3RhdGUgIT09ICdyZWFkeScpIHJldHVybiB7IGVycm9yOiBgaG9zdCBub3QgcmVhZHkgKCR7YnJpZGdlLmhvc3RTdGF0ZX0pYCwgY29kZTogJ0hPU1RfTk9UX1JFQURZJyB9O1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IG1kID0gYXdhaXQgY2xpZW50LmdldFRleHQoYC9hcGkvc2Vzc2lvbnMvJHtlbmNvZGVVUklDb21wb25lbnQoc2lkKX0vZXhwb3J0Lm1kYCk7XHJcbiAgICAgICAgY29uc3Qgd2luID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkuZmluZCgodykgPT4gIXcuaXNEZXN0cm95ZWQoKSk7XHJcbiAgICAgICAgaWYgKHdpbiA9PT0gdW5kZWZpbmVkKSByZXR1cm4geyBlcnJvcjogJ25vIHdpbmRvdycsIGNvZGU6ICdCUklER0VfRVJST1InIH07XHJcbiAgICAgICAgY29uc3QgciA9IGF3YWl0IGRpYWxvZy5zaG93U2F2ZURpYWxvZyh3aW4sIHtcclxuICAgICAgICAgIHRpdGxlOiB0eXBlb2YgdGl0bGUgPT09ICdzdHJpbmcnICYmIHRpdGxlICE9PSAnJyA/IHRpdGxlLnNsaWNlKDAsIDgwKSA6ICdcdTVCRkNcdTUxRkFcdTRGMUFcdThCREQnLFxyXG4gICAgICAgICAgZGVmYXVsdFBhdGg6IGBobWgtJHtzaWR9Lm1kYCxcclxuICAgICAgICAgIGZpbHRlcnM6IFt7IG5hbWU6ICdNYXJrZG93bicsIGV4dGVuc2lvbnM6IFsnbWQnXSB9XSxcclxuICAgICAgICB9KTtcclxuICAgICAgICBpZiAoci5jYW5jZWxlZCB8fCByLmZpbGVQYXRoID09PSB1bmRlZmluZWQgfHwgci5maWxlUGF0aCA9PT0gJycpIHJldHVybiB7IG9rOiBmYWxzZSwgY2FuY2VsZWQ6IHRydWUgfTtcclxuICAgICAgICBhd2FpdCB3cml0ZUZpbGUoci5maWxlUGF0aCwgbWQsICd1dGY4Jyk7XHJcbiAgICAgICAgbG9nSW5mbygnZXhwb3J0JywgYHNlc3Npb24gJHtzaWR9IFx1MjE5MiAke3IuZmlsZVBhdGh9YCk7XHJcbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHBhdGg6IHIuZmlsZVBhdGggfTtcclxuICAgICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgY29uc3QgZGV0YWlsID0gKCgpID0+IHsgdHJ5IHsgcmV0dXJuIEpTT04uc3RyaW5naWZ5KGVycik7IH0gY2F0Y2ggeyByZXR1cm4gU3RyaW5nKGVycik7IH0gfSkoKS5zbGljZSgwLCAzMDApO1xyXG4gICAgICAgIHJldHVybiB7IGVycm9yOiBkZXRhaWwsIGNvZGU6ICdCUklER0VfRVJST1InIH07XHJcbiAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gXHU1QkExXHU2Mjc5XHU2QTIxXHU1RjBGXHU4QkZCXHU1MTk5KFx1Njc0M1x1NUEwMVx1NTcyOCBydW50aW1lIGNvbmZpZztcdTUyMDdcdTYzNjJcdTVGQzVcdTk4N0JcdTY2M0VcdTVGMEYpIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6YXBwcm92YWwtZ2V0JywgKGV2ZW50KSA9PlxyXG4gICAgICBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjx7IHNldHRpbmdzPzogeyBhcHByb3ZhbD86IHN0cmluZyB9IH0+KCcvYXBpL3N0YXRlJykpKTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmFwcHJvdmFsLXNldCcsIChldmVudCwgbW9kZTogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBtID0gbW9kZSA9PT0gJ2F1dG8nID8gJ2F1dG8nIDogbW9kZSA9PT0gJ2FzaycgPyAnYXNrJyA6ICcnO1xyXG4gICAgICBpZiAobSA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ21vZGUgbXVzdCBiZSBhc2t8YXV0bycsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PignL2FwaS9jb25maWcnLCB7IGFwcHJvdmFsOiBtIH0pKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gaG1oYXJuZXNzIHJ1bnRpbWUgXHU4RkRFXHU2M0E1KFx1ODFFQVx1NTJBOFx1NTNEMVx1NzNCMCArIFx1NjI0Qlx1NTJBOFx1ODk4Nlx1NzZENiArIFx1NzBFRFx1NTIwN1x1NjM2MikgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpydW50aW1lLWluZm8nLCBhc3luYyAoZXZlbnQpID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgY29uc3QgZCA9IGRldGVjdEV4dGVybmFsUnVudGltZSgpO1xyXG4gICAgICBjb25zdCBjZmcgPSBhd2FpdCBsb2FkUnVudGltZUNvbmZpZygpO1xyXG4gICAgICByZXR1cm4ge1xyXG4gICAgICAgIG1vZGU6IGJyaWRnZS5tb2RlLFxyXG4gICAgICAgIHJ1bnRpbWVFbnRyeTogYnJpZGdlLnJ1bnRpbWVFbnRyeSxcclxuICAgICAgICBvdmVycmlkZTogY2ZnLmVudHJ5LFxyXG4gICAgICAgIGRlbW86IGNmZy5kZW1vLFxyXG4gICAgICAgIGRldGVjdGVkOiBkLmVudHJ5LFxyXG4gICAgICAgIGRldGVjdGVkVmVyc2lvbjogZC52ZXJzaW9uLFxyXG4gICAgICAgIGRldGVjdGVkU291cmNlOiBkLnNvdXJjZSxcclxuICAgICAgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6YnJvd3NlLXJ1bnRpbWUnLCBhc3luYyAoZXZlbnQsIHRpdGxlOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IHdpbiA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmZpbmQoKHcpID0+ICF3LmlzRGVzdHJveWVkKCkpO1xyXG4gICAgICBpZiAod2luID09PSB1bmRlZmluZWQpIHJldHVybiB7IGVycm9yOiAnbm8gd2luZG93JywgY29kZTogJ0JSSURHRV9FUlJPUicgfTtcclxuICAgICAgY29uc3QgciA9IGF3YWl0IGRpYWxvZy5zaG93T3BlbkRpYWxvZyh3aW4sIHtcclxuICAgICAgICB0aXRsZTogdHlwZW9mIHRpdGxlID09PSAnc3RyaW5nJyAmJiB0aXRsZSAhPT0gJycgPyB0aXRsZS5zbGljZSgwLCAxMjApIDogJ1x1OTAwOVx1NjJFOSBobWhhcm5lc3MgXHU3Njg0IGRlc2t0b3AtaG9zdCBcdTUxNjVcdTUzRTMnLFxyXG4gICAgICAgIHByb3BlcnRpZXM6IFsnb3BlbkZpbGUnXSxcclxuICAgICAgICBmaWx0ZXJzOiBbeyBuYW1lOiAnZGVza3RvcC1ob3N0JywgZXh0ZW5zaW9uczogWyd0cycsICdqcyddIH1dLFxyXG4gICAgICB9KTtcclxuICAgICAgaWYgKHIuY2FuY2VsZWQgfHwgci5maWxlUGF0aHNbMF0gPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBjYW5jZWxlZDogdHJ1ZSB9O1xyXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgZW50cnk6IHIuZmlsZVBhdGhzWzBdIH07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiogXHU4QkJFXHU3RjZFL1x1NkUwNVx1OTY2NFx1NjI0Qlx1NTJBOFx1NTE2NVx1NTNFM1x1NTQwRVx1NzBFRFx1OTFDRFx1NTQyRiBob3N0KFx1N0E3QVx1NEUzMj1cdTU2REVcdTUyMzBcdTgxRUFcdTUyQThcdTUzRDFcdTczQjApXHUzMDAyICovXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnNldC1ydW50aW1lJywgYXN5bmMgKGV2ZW50LCBlbnRyeTogdW5rbm93bikgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBjb25zdCBlID0gdHlwZW9mIGVudHJ5ID09PSAnc3RyaW5nJyA/IGVudHJ5LnRyaW0oKSA6ICcnO1xyXG4gICAgICBpZiAoZSAhPT0gJycgJiYgKCFpc0Fic29sdXRlKGUpIHx8ICFleGlzdHNTeW5jKGUpKSkge1xyXG4gICAgICAgIHJldHVybiB7IGVycm9yOiAnXHU1MTY1XHU1M0UzXHU1RkM1XHU5ODdCXHU2NjJGXHU1QjU4XHU1NzI4XHU3Njg0XHU3RUREXHU1QkY5XHU4REVGXHU1Rjg0KGRlc2t0b3AtaG9zdC50cyknLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH07XHJcbiAgICAgIH1cclxuICAgICAgYXdhaXQgc2F2ZVJ1bnRpbWVFbnRyeU92ZXJyaWRlKGUpO1xyXG4gICAgICAvLyBcdTcwRURcdTUyMDdcdTYzNjI6XHU1MTQ4XHU0RjE4XHU5NkM1XHU1MDVDXHU2Mzg5XHU1RjUzXHU1MjREIGhvc3QsXHU1MThEXHU2MzA5XHU2NUIwXHU5MTREXHU3RjZFXHU2MkM5XHU4RDc3XHJcbiAgICAgIHNzZUFib3J0Py5hYm9ydCgpO1xyXG4gICAgICBpZiAoc3VwZXJ2aXNvciAhPT0gbnVsbCkgYXdhaXQgc3VwZXJ2aXNvci5zdG9wKCk7XHJcbiAgICAgIGF3YWl0IHN0YXJ0SG9zdCgpO1xyXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgbW9kZTogYnJpZGdlLm1vZGUgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gdjUuMSBcdTk5OTZcdTU0MkZcdTVCODlcdTg4QzVcdTU0MTFcdTVCRkM6XHU2NzJDXHU2NzNBXHU2OEMwXHU2RDRCIC8gXHU0RTBCXHU4RjdEXHU1Qjg5XHU4OEM1KFx1OEZEQlx1NUVBNlx1NEU4Qlx1NEVGNikgLyBcdTU0MTFcdTVCRkNcdTcyQjZcdTYwMDEgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpkZXRlY3QtcnVudGltZScsIChldmVudCkgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBjb25zdCBpbmZvID0gYnVuZGxlZFJ1bnRpbWVJbmZvKCk7XHJcbiAgICAgIC8vIFVJVkVSSUZZIFx1NTQxMVx1NUJGQ1x1NkI2NVx1NzY4NFwiXHU0RjJBXHU5MDIwXHU2NzJBXHU5MTREXHU3RjZFXHU2MDAxXCI6ZmFrZSBcdTZBMjFcdTVGMEZcdTRFMEJcdTYwNTJcdTYyQTVcdTY3MkFcdTY4QzBcdTZENEJcclxuICAgICAgLy8gKFx1NzcxRlx1NUI5RVx1NjhDMFx1NkQ0Qlx1OERFRlx1NUY4NFx1NzUzMSByZWFsIFx1NTNEOFx1NEY1M1x1OUE4Q1x1NjUzNixcdTg5QzEgZXZpZGVuY2Uvc2V0dXAtd2l6YXJkLylcdTMwMDJcclxuICAgICAgLy8gVUlWRVJJRllfRkFLRV9ERVRFQ1RfRk9VTkQ9MSh1aXZlcmlmeSBcdTdBODRcdTVDNEZcdTU3M0FcdTY2NkZcdThGRDBcdTg4NENcdTRFMkRcdTUyQThcdTYwMDFcdTdGNkVcdTRGNEQpOlxyXG4gICAgICAvLyBcdTRGMkFcdTkwMjBcIlx1NjhDMFx1NkQ0Qlx1NTIzMFx1NURGMlx1ODhDNVwiLFx1OEJBOVx1NTQxMVx1NUJGQ1x1NTFGQVx1NzNCMFx1NjhDMFx1NkQ0Qlx1OTg3NVx1NEUwOVx1OTAwOVx1OTg3OSBcdTIxOTIgXHU1MzU1XHU1MUZCXHU1MjREXHU4RkRCIFx1MjE5MiBcdTkwMDlcdTYyRTlcdTk4NzVcdTMwMDJcclxuICAgICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX1dJWkFSRCA9PT0gJ2Zha2UnICYmIHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX0ZBS0UgPT09ICcxJykge1xyXG4gICAgICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9GQUtFX0RFVEVDVF9GT1VORCA9PT0gJzEnKSB7XHJcbiAgICAgICAgICByZXR1cm4geyBmb3VuZDogdHJ1ZSwgdmVyc2lvbjogJzAuMC4wLXZlcmlmeScsIGVudHJ5OiAndmVyaWZ5Oi8vZmFrZS1lbnRyeScsIHNvdXJjZTogJ3ZlcmlmeScsIGJ1bmRsZWQ6IGluZm8sIG5wbTogbnBtT25QYXRoKCkgfTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHsgZm91bmQ6IGZhbHNlLCB2ZXJzaW9uOiAnJywgZW50cnk6ICcnLCBzb3VyY2U6ICcnLCBidW5kbGVkOiBpbmZvLCBucG06IG5wbU9uUGF0aCgpIH07XHJcbiAgICAgIH1cclxuICAgICAgY29uc3QgZCA9IGRldGVjdEV4dGVybmFsUnVudGltZSgpO1xyXG4gICAgICByZXR1cm4geyBmb3VuZDogZC5lbnRyeSAhPT0gJycsIHZlcnNpb246IGQudmVyc2lvbiwgZW50cnk6IGQuZW50cnksIHNvdXJjZTogZC5zb3VyY2UsIGJ1bmRsZWQ6IGluZm8sIG5wbTogbnBtT25QYXRoKCkgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6aW5zdGFsbC1jbGknLCAoZXZlbnQsIG9wdHM6IHVua25vd24pID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgY29uc3QgbyA9IChvcHRzID8/IHt9KSBhcyB7IGZvcmNlVGd6PzogdW5rbm93bjsgbWlycm9yRmlyc3Q/OiB1bmtub3duIH07XHJcbiAgICAgIC8vIFVJVkVSSUZZIGZha2UgXHU1NDExXHU1QkZDOlx1ODFFQVx1NTJBOFx1NUI4OVx1ODhDNVx1OERFRlx1NUY4NFx1OEQ3MFx1NkEyMVx1NjJERlx1OEZEQlx1NUVBNihcdTRFMERcdTc4QjBcdTc4QzFcdTc2RDgvXHU3RjUxXHU3RURDL1x1NEUwRFx1NzBFRFx1NTIwN1x1NjM2MiksXHJcbiAgICAgIC8vIFx1NEUxNFx1NEUwRFx1NTNEMSBkb25lXHUyMDE0XHUyMDE0XHU5QThDXHU2NTM2XHU4OTgxXHU1NzI4XHU1Qjg5XHU4OEM1XHU5ODc1XHU3MEI5XCJcdTY1MzlcdTc1MjhcdTUxODVcdTdGNkVcIlx1NTIwN1x1NjM2Mlx1OTRGRVx1NjNBNVx1MzAwMlxyXG4gICAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfV0laQVJEID09PSAnZmFrZScgJiYgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfRkFLRSA9PT0gJzEnKSB7XHJcbiAgICAgICAgY29uc3Qgc2VuZFNpbSA9IChwOiBJbnN0YWxsUHJvZ3Jlc3MpOiB2b2lkID0+IHtcclxuICAgICAgICAgIGZvciAoY29uc3QgdyBvZiBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKSkge1xyXG4gICAgICAgICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCdpbnN0YWxsOnByb2dyZXNzJywgcCk7XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgfTtcclxuICAgICAgICB2b2lkIChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgICBzZW5kU2ltKHsgcGhhc2U6ICdjaGVjaycsIHRleHQ6ICdcdTY4QzBcdTY3RTUgbnBtXHUyMDI2KHZlcmlmeSBcdTZBMjFcdTYyREYpJyB9KTtcclxuICAgICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDQwMCkpO1xyXG4gICAgICAgICAgc2VuZFNpbSh7IHBoYXNlOiAnbnBtJywgdGV4dDogJ25wbSBpbnN0YWxsIEBobWhhcm5lc3MvY2xpIFx1MjE5MiB+Ly5obWhhcm5lc3MtZ2xvYmFsKHZlcmlmeSBcdTZBMjFcdTYyREYsXHU0RTBEXHU4NDNEXHU3NkQ4KScgfSk7XHJcbiAgICAgICAgfSkoKTtcclxuICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgdGVzdDogdHJ1ZSB9O1xyXG4gICAgICB9XHJcbiAgICAgIHJldHVybiBzdGFydENsaUluc3RhbGwoXHJcbiAgICAgICAge1xyXG4gICAgICAgICAgc2VuZFByb2dyZXNzOiAocDogSW5zdGFsbFByb2dyZXNzKTogdm9pZCA9PiB7XHJcbiAgICAgICAgICAgIGxvZ0luZm8oJ2luc3RhbGwnLCBgJHtwLnBoYXNlfSR7cC5wY3QgIT09IHVuZGVmaW5lZCA/IGAgJHtwLnBjdH0lYCA6ICcnfSAke3AudGV4dH1gKTtcclxuICAgICAgICAgICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XHJcbiAgICAgICAgICAgICAgaWYgKCF3LmlzRGVzdHJveWVkKCkpIHcud2ViQ29udGVudHMuc2VuZCgnaW5zdGFsbDpwcm9ncmVzcycsIHApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICB9LFxyXG4gICAgICAgICAgbG9nOiAobTogc3RyaW5nKTogdm9pZCA9PiB7IGxvZ0luZm8oJ2luc3RhbGwnLCBtKTsgfSxcclxuICAgICAgICAgIC8vIFx1NUI4OVx1ODhDNVx1NjIxMFx1NTI5Rlx1NTM3M1x1NjMwMVx1NEU0NVx1NTMxNlx1NUU3Nlx1NzBFRFx1NTIwN1x1NjM2MihcdTU0MTFcdTVCRkNcdTk2OEZcdTU0MEVcdTY1MzZcdTVDM0U7XHU0RTJEXHU5MDE0XHU1M0Q2XHU2RDg4XHU0RTVGXHU1REYyXHU3NTFGXHU2NTQ4KVxyXG4gICAgICAgICAgb25JbnN0YWxsZWQ6IChlbnRyeTogc3RyaW5nKTogdm9pZCA9PiB7XHJcbiAgICAgICAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcclxuICAgICAgICAgICAgICBhd2FpdCBzYXZlUnVudGltZUNvbmZpZyh7IGVudHJ5LCBkZW1vOiBmYWxzZSB9KTtcclxuICAgICAgICAgICAgICBzc2VBYm9ydD8uYWJvcnQoKTtcclxuICAgICAgICAgICAgICBpZiAoc3VwZXJ2aXNvciAhPT0gbnVsbCkgYXdhaXQgc3VwZXJ2aXNvci5zdG9wKCk7XHJcbiAgICAgICAgICAgICAgYXdhaXQgc3RhcnRIb3N0KCk7XHJcbiAgICAgICAgICAgIH0pKCk7XHJcbiAgICAgICAgICB9LFxyXG4gICAgICAgIH0sXHJcbiAgICAgICAge1xyXG4gICAgICAgICAgZm9yY2VUZ3o6IG8uZm9yY2VUZ3ogPT09IHRydWUsXHJcbiAgICAgICAgICBtaXJyb3JGaXJzdDogby5taXJyb3JGaXJzdCA9PT0gJ25wbW1pcnJvcicgPyAnbnBtbWlycm9yJyA6IG8ubWlycm9yRmlyc3QgPT09ICducG1qcycgPyAnbnBtanMnIDogdW5kZWZpbmVkLFxyXG4gICAgICAgIH0sXHJcbiAgICAgICk7XHJcbiAgICB9KTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmdldC13aXphcmQnLCBhc3luYyAoZXZlbnQpID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgY29uc3QgdmFyaWFudCA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX1dJWkFSRDtcclxuICAgICAgaWYgKHZhcmlhbnQgIT09IHVuZGVmaW5lZCAmJiB2YXJpYW50ICE9PSAnJykge1xyXG4gICAgICAgIC8vIFx1OUE4Q1x1NjUzNlx1Njc4NFx1OTAyMDpcdTVGM0FcdTUyMzZcdTU0MTFcdTVCRkNcdTUzRUZcdTg5QzFcdTRFMTRcdTg5QzZcdTRFM0FcdTY3MkFcdTkxNERcdTdGNkUoXHU1M0VGXHU5MUNEXHU1OTBEXHU4REQxKTtwZXJzaXN0ZWQ9XHU3NzFGXHU1QjlFXHU4NDNEXHU3NkQ4XHJcbiAgICAgICAgLy8gXHU3MkI2XHU2MDAxKFx1NTQxMVx1NUJGQ1x1NkI2NVx1NjVBRFx1OEEwMFwiXHU5MDA5XHU2MkU5XHU2MzAxXHU0RTQ1XCJcdTc1MjgsXHU0RTBEXHU1RjcxXHU1NENEIFVJIFx1NTIyNFx1NUI5QSlcclxuICAgICAgICBjb25zdCB3ID0gYXdhaXQgbG9hZFdpemFyZFN0YXRlKCk7XHJcbiAgICAgICAgcmV0dXJuIHsgZG9uZTogZmFsc2UsIGNob2ljZTogJycsIHN1cHByZXNzZWQ6IGZhbHNlLCBwZXJzaXN0ZWQ6IHsgZG9uZTogdy5kb25lLCBjaG9pY2U6IHcuY2hvaWNlIH0gfTtcclxuICAgICAgfVxyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgbG9hZFdpemFyZFN0YXRlKCk7XHJcbiAgICAgIGNvbnN0IGNmZyA9IGF3YWl0IGxvYWRSdW50aW1lQ29uZmlnKCk7XHJcbiAgICAgIC8vIFx1NURGMlx1OTE0RFx1N0Y2RVx1OEZDNyBydW50aW1lKFx1NjI0Qlx1NTJBOFx1NTE2NVx1NTNFMy9cdTU0MTFcdTVCRkNcdTkwMDlcdTYyRTkvXHU2RjE0XHU3OTNBKVx1ODlDNlx1NTQwQ1x1NURGMlx1NUI4Q1x1NjIxMFx1OTk5Nlx1NTQyRlxyXG4gICAgICByZXR1cm4geyBkb25lOiB3LmRvbmUgfHwgY2ZnLmVudHJ5ICE9PSAnJyB8fCBjZmcuZGVtbywgY2hvaWNlOiB3LmNob2ljZSwgc3VwcHJlc3NlZDogd2l6YXJkU3VwcHJlc3NlZCgpIH07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiogXHU1NDExXHU1QkZDXHU2NTM2XHU1QzNFOlx1NjMwMVx1NEU0NVx1NTMxNlx1OTAwOVx1NjJFOVx1NUU3Nlx1NUU5NFx1NzUyOChleHRlcm5hbC9idW5kbGVkXHUyMTkyXHU1MTY1XHU1M0UzXHU4OTg2XHU3NkQ2O2RlbW9cdTIxOTJcdTYzMDFcdTRFNDVcdTZGMTRcdTc5M0E7XHJcbiAgICAgKiAgaW5zdGFsbFx1MjE5Mlx1NTE2NVx1NTNFM1x1NURGMlx1NzUzMVx1NUI4OVx1ODhDNVx1NTY2OFx1NjMwMVx1NEU0NVx1NTMxNixcdTUzRUFcdThCQjBcdTcyQjZcdTYwMDEpXHUzMDAyZmFrZS9cdTZENEJcdThCRDVcdTczQUZcdTU4ODNcdTUzRUFcdThCQjBcdTcyQjZcdTYwMDFcdTMwMDIgKi9cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6d2l6YXJkLWNvbXBsZXRlJywgYXN5bmMgKGV2ZW50LCBjaG9pY2U6IHVua25vd24sIGVudHJ5OiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IGMgPSBjaG9pY2UgPT09ICdleHRlcm5hbCcgfHwgY2hvaWNlID09PSAnaW5zdGFsbCcgfHwgY2hvaWNlID09PSAnYnVuZGxlZCcgfHwgY2hvaWNlID09PSAnZGVtbycgPyBjaG9pY2UgOiAnJztcclxuICAgICAgaWYgKGMgPT09ICcnKSByZXR1cm4geyBlcnJvcjogJ2Nob2ljZSBtdXN0IGJlIGV4dGVybmFsfGluc3RhbGx8YnVuZGxlZHxkZW1vJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9O1xyXG4gICAgICBjb25zdCBlID0gdHlwZW9mIGVudHJ5ID09PSAnc3RyaW5nJyA/IGVudHJ5IDogJyc7XHJcbiAgICAgIGF3YWl0IHNhdmVXaXphcmRTdGF0ZShjKTtcclxuICAgICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX0ZBS0UgPT09ICcxJykgcmV0dXJuIHsgb2s6IHRydWUsIG1vZGU6IGJyaWRnZS5tb2RlLCB0ZXN0OiB0cnVlIH07XHJcbiAgICAgIGNvbnN0IHJlcG9Sb290ID0gam9pbihoZXJlLCAnLi4nLCAnLi4nLCAnLi4nLCAnLi4nKTtcclxuICAgICAgaWYgKGMgPT09ICdleHRlcm5hbCcgfHwgYyA9PT0gJ2J1bmRsZWQnKSB7XHJcbiAgICAgICAgY29uc3QgdGFyZ2V0ID0gYyA9PT0gJ2J1bmRsZWQnID8gYnVuZGxlZFJ1bnRpbWVQYXRoKHJlcG9Sb290KSA6IGU7XHJcbiAgICAgICAgaWYgKHRhcmdldCA9PT0gJycgfHwgIWlzQWJzb2x1dGUodGFyZ2V0KSB8fCAhZXhpc3RzU3luYyh0YXJnZXQpKSB7XHJcbiAgICAgICAgICByZXR1cm4geyBlcnJvcjogJ3J1bnRpbWUgXHU1MTY1XHU1M0UzXHU0RTBEXHU1QjU4XHU1NzI4JywgY29kZTogJ0JBRF9SRVFVRVNUJyB9O1xyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCBzYXZlUnVudGltZUNvbmZpZyh7IGVudHJ5OiB0YXJnZXQsIGRlbW86IGZhbHNlIH0pO1xyXG4gICAgICB9IGVsc2UgaWYgKGMgPT09ICdkZW1vJykge1xyXG4gICAgICAgIGF3YWl0IHNhdmVSdW50aW1lQ29uZmlnKHsgZW50cnk6ICcnLCBkZW1vOiB0cnVlIH0pO1xyXG4gICAgICB9XHJcbiAgICAgIGlmIChjICE9PSAnaW5zdGFsbCcpIHtcclxuICAgICAgICAvLyBpbnN0YWxsOlx1NUI4OVx1ODhDNVx1NTY2OFx1NURGMlx1NTcyOCBvbkluc3RhbGxlZCBcdTYzMDFcdTRFNDVcdTUzMTZcdTVFNzZcdTcwRURcdTUyMDdcdTYzNjIsXHU4RkQ5XHU5MUNDXHU0RTBEXHU1MThEXHU5MUNEXHU1NDJGXHJcbiAgICAgICAgc3NlQWJvcnQ/LmFib3J0KCk7XHJcbiAgICAgICAgaWYgKHN1cGVydmlzb3IgIT09IG51bGwpIGF3YWl0IHN1cGVydmlzb3Iuc3RvcCgpO1xyXG4gICAgICAgIGF3YWl0IHN0YXJ0SG9zdCgpO1xyXG4gICAgICB9XHJcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBtb2RlOiBicmlkZ2UubW9kZSB9O1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBQcm92aWRlciBcdThCQkVcdTdGNkUoMDMgXHUwMEE3XHU0RTAzOmtleSBcdTUzRUFcdTUxRkEgaGFzS2V5L1x1NjcyQlx1NTZEQlx1NEY0RDtcdTRGRERcdTVCNThcdTc2RjRcdTUxOTkgcnVudGltZSkgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpwcm92aWRlcnMnLCAoZXZlbnQpID0+XHJcbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPHsgcHJvdmlkZXJzRGV0YWlsPzogQXJyYXk8eyBuYW1lOiBzdHJpbmc7IG1vZGVsOiBzdHJpbmc7IGJhc2VVcmw6IHN0cmluZzsgaGFzS2V5OiBib29sZWFuOyBrZXlUYWlsPzogc3RyaW5nIH0+OyBtb2RlbD86IHN0cmluZyB9PignL2FwaS9zdGF0ZScpKSk7XHJcblxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpwcm92aWRlci1zYXZlJywgKGV2ZW50LCBwcm92aWRlcjogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBwID0gcHJvdmlkZXIgYXMgeyBuYW1lPzogdW5rbm93bjsgYmFzZVVybD86IHVua25vd247IG1vZGVsPzogdW5rbm93bjsgYXBpS2V5PzogdW5rbm93biB9O1xyXG4gICAgICBjb25zdCBuYW1lID0gdHlwZW9mIHA/Lm5hbWUgPT09ICdzdHJpbmcnID8gcC5uYW1lLnNsaWNlKDAsIDgwKSA6ICcnO1xyXG4gICAgICBjb25zdCBiYXNlVXJsID0gdHlwZW9mIHA/LmJhc2VVcmwgPT09ICdzdHJpbmcnID8gcC5iYXNlVXJsLnNsaWNlKDAsIDMwMCkgOiAnJztcclxuICAgICAgY29uc3QgbW9kZWwgPSB0eXBlb2YgcD8ubW9kZWwgPT09ICdzdHJpbmcnID8gcC5tb2RlbC5zbGljZSgwLCAxMjApIDogJyc7XHJcbiAgICAgIGlmIChuYW1lID09PSAnJyB8fCBiYXNlVXJsID09PSAnJyB8fCBtb2RlbCA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ25hbWUvYmFzZVVybC9tb2RlbCByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XHJcbiAgICAgIGNvbnN0IGJvZHk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0geyBuYW1lLCBiYXNlVXJsLCBtb2RlbCB9O1xyXG4gICAgICAvLyBhcGlLZXkgXHU1M0VBXHU1NzI4XHU2NjNFXHU1RjBGXHU4RjkzXHU1MTY1XHU2NUY2XHU0RTBBXHU0RjIwLFx1N0VERFx1NEUwRFx1NTZERVx1NjYzRShyZW5kZXJlciBcdTg4NjhcdTUzNTVcdTYzRDBcdTRFQTRcdTU0MEVcdTUzNzNcdTZFMDVcdTdBN0EpXHJcbiAgICAgIGlmICh0eXBlb2YgcD8uYXBpS2V5ID09PSAnc3RyaW5nJyAmJiBwLmFwaUtleSAhPT0gJycpIGJvZHkuYXBpS2V5ID0gcC5hcGlLZXkuc2xpY2UoMCwgMzAwKTtcclxuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KCcvYXBpL3Byb3ZpZGVycycsIGJvZHkpKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gXHU1REU1XHU0RjVDXHU1MzNBKDAzIFx1MDBBN1x1NTE2RDtcdTUyMDdcdTYzNjJcdThCRURcdTRFNDlcdTRFMEUgd2ViIFx1NzZGOFx1NTQwQzpydW50aW1lIFx1NTM1NVx1OTAwOSBjd2QpIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6d29ya3NwYWNlcycsIChldmVudCkgPT5cclxuICAgICAgaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248eyBjdXJyZW50OiBzdHJpbmc7IGl0ZW1zOiBBcnJheTx7IGlkOiBzdHJpbmc7IG5hbWU6IHN0cmluZzsgcGF0aDogc3RyaW5nIH0+IH0+KCcvYXBpL3dvcmtzcGFjZXMnKSkpO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6d29ya3NwYWNlLXVzZScsIChldmVudCwgaWQ6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3Qgd2lkID0gdHlwZW9mIGlkID09PSAnc3RyaW5nJyA/IGlkLnNsaWNlKDAsIDYwKSA6ICcnO1xyXG4gICAgICBpZiAod2lkID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAnaWQgcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvd29ya3NwYWNlcy91c2UnLCB7IGlkOiB3aWQgfSkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTp3b3Jrc3BhY2UtYWRkJywgKGV2ZW50LCBuYW1lOiB1bmtub3duLCBwYXRoOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IG4gPSB0eXBlb2YgbmFtZSA9PT0gJ3N0cmluZycgPyBuYW1lLnNsaWNlKDAsIDEyMCkgOiAnJztcclxuICAgICAgY29uc3QgcCA9IHR5cGVvZiBwYXRoID09PSAnc3RyaW5nJyA/IHBhdGguc2xpY2UoMCwgMTAwMCkgOiAnJztcclxuICAgICAgaWYgKHAgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICdwYXRoIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcclxuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KCcvYXBpL3dvcmtzcGFjZXMnLCB7IG5hbWU6IG4gPT09ICcnID8gdW5kZWZpbmVkIDogbiwgcGF0aDogcCB9KSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIFx1NEYxQVx1OEJERFx1NUY1Mlx1Njg2My9cdTUyMjBcdTk2NjQoXHU3OUZCXHU1MTY1IGFyY2hpdmUvdHJhc2gsXHU1M0VGXHU2MDYyXHU1OTBEO3J1bnRpbWUgXHU2NzQzXHU1QTAxKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnNlc3Npb24tb3AnLCAoZXZlbnQsIGlkOiB1bmtub3duLCBvcDogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBzaWQgPSB0eXBlb2YgaWQgPT09ICdzdHJpbmcnID8gaWQucmVwbGFjZSgvW15hLXpBLVowLTlfOi5ALV0vZywgJycpLnNsaWNlKDAsIDgwKSA6ICcnO1xyXG4gICAgICBjb25zdCBvID0gb3AgPT09ICdhcmNoaXZlJyB8fCBvcCA9PT0gJ2RlbGV0ZScgPyBvcCA6ICcnO1xyXG4gICAgICBpZiAoc2lkID09PSAnJyB8fCBvID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAnaWQgYW5kIG9wKGFyY2hpdmV8ZGVsZXRlKSByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PihgL2FwaS9zZXNzaW9ucy8ke2VuY29kZVVSSUNvbXBvbmVudChzaWQpfS8ke299YCwge30pKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gTTQ6RGlmZiBcdTk3NjJcdTY3N0YoXHU1M0VBXHU4QkZCIGdpdCBcdTUzRDhcdTY2RjQ7XHU2Mzg4XHU2NzQzXHU1NzI4IHJ1bnRpbWUpIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6ZGlmZicsIChldmVudCwgc2Vzc2lvbklkOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IHNpZCA9IHR5cGVvZiBzZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gc2Vzc2lvbklkLnNsaWNlKDAsIDgwKSA6ICcnO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KGAvYXBpL2RpZmYke3NpZCAhPT0gJycgPyBgP3Nlc3Npb25JZD0ke2VuY29kZVVSSUNvbXBvbmVudChzaWQpfWAgOiAnJ31gKSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIE01Olx1OEJBNFx1NzdFNVx1NzJCNlx1NjAwMShcdTdFRDNcdTY3ODRcdTUzMTZcdTRFOEJcdTVCOUU7XHU3RjNBXHU2NTcwXHU2MzZFXHU1QjU3XHU2QkI1XHU3NTMxIFVJIFx1NjYzRVx1NzkzQVwiXHU2NUUwXHU2NTcwXHU2MzZFXCIpIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6Y29nbml0aXZlJywgKGV2ZW50KSA9PlxyXG4gICAgICBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oJy9hcGkvY29nbml0aXZlJykpKTtcclxuXHJcbiAgICAvLyAtLS0tIFx1NTM4Nlx1NTNGMlx1NEYxQVx1OEJERFx1OTg4NFx1ODlDOChcdTY3MDBcdTU0MEUgODAgXHU2NzYxLFx1NkJDRlx1Njc2MSA1MDAgXHU1QjU3O3J1bnRpbWUgXHU2NzQzXHU1QTAxXHU2NTcwXHU2MzZFKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnNlc3Npb24tcHJldmlldycsIChldmVudCwgaWQ6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIGlkID09PSAnc3RyaW5nJyA/IGlkLnJlcGxhY2UoL1teYS16QS1aMC05XzouQC1dL2csICcnKS5zbGljZSgwLCA4MCkgOiAnJztcclxuICAgICAgaWYgKHNpZCA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ2lkIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcclxuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPFJlY29yZDxzdHJpbmcsIHVua25vd24+PihgL2FwaS9zZXNzaW9ucy8ke2VuY29kZVVSSUNvbXBvbmVudChzaWQpfWApKTtcclxuICAgIH0pO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6c3RvcC1ob3N0JywgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicgfTtcclxuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIHNzZUFib3J0Py5hYm9ydCgpO1xyXG4gICAgICAgIGF3YWl0IHN1cGVydmlzb3I/LnN0b3AoKTtcclxuICAgICAgICBhcHAucXVpdCgpO1xyXG4gICAgICB9KSgpO1xyXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSB9O1xyXG4gICAgfSk7XHJcbiAgfVxyXG5cclxuICAvKiAtLS0tIFx1N0E5N1x1NTNFM1x1NEUwRVx1NUI4OVx1NTE2OFx1N0I1Nlx1NzU2NSAtLS0tICovXHJcbiAgLy8gMDMgXHUwMEE3XHU0RTAzOkRlc2t0b3AgXHU2NzJDXHU1NzMwXHU1M0VBXHU1QjU4IFVJIFx1NTA0Rlx1NTk3RC9cdTdBOTdcdTUzRTNcdTcyQjZcdTYwMDEodXNlckRhdGEvd2luZG93LXN0YXRlLmpzb24pXHJcbiAgY29uc3Qgd2luZG93U3RhdGVGaWxlID0gKCk6IHN0cmluZyA9PiBqb2luKGFwcC5nZXRQYXRoKCd1c2VyRGF0YScpLCAnd2luZG93LXN0YXRlLmpzb24nKTtcclxuICBhc3luYyBmdW5jdGlvbiBsb2FkQm91bmRzKCk6IFByb21pc2U8eyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlcjsgeD86IG51bWJlcjsgeT86IG51bWJlciB9IHwgbnVsbD4ge1xyXG4gICAgdHJ5IHtcclxuICAgICAgcmV0dXJuIEpTT04ucGFyc2UoYXdhaXQgcmVhZEZpbGUod2luZG93U3RhdGVGaWxlKCksICd1dGY4JykpIGFzIHsgd2lkdGg6IG51bWJlcjsgaGVpZ2h0OiBudW1iZXI7IHg/OiBudW1iZXI7IHk/OiBudW1iZXIgfTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4gbnVsbDsgfVxyXG4gIH1cclxuICBhc3luYyBmdW5jdGlvbiBzYXZlQm91bmRzKHdpbjogQnJvd3NlcldpbmRvdyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgdHJ5IHsgYXdhaXQgd3JpdGVGaWxlKHdpbmRvd1N0YXRlRmlsZSgpLCBKU09OLnN0cmluZ2lmeSh3aW4uZ2V0Qm91bmRzKCkpLCAndXRmOCcpOyB9IGNhdGNoIHsgLyogYmVzdCBlZmZvcnQgKi8gfVxyXG4gIH1cclxuXHJcbiAgYXN5bmMgZnVuY3Rpb24gY3JlYXRlV2luZG93KCk6IFByb21pc2U8QnJvd3NlcldpbmRvdyB8IG51bGw+IHtcclxuICAgIGNvbnN0IHNhdmVkID0gYXdhaXQgbG9hZEJvdW5kcygpO1xyXG4gICAgY29uc3Qgd2luID0gbmV3IEJyb3dzZXJXaW5kb3coe1xyXG4gICAgICB3aWR0aDogc2F2ZWQ/LndpZHRoID8/IDE0NDAsXHJcbiAgICAgIGhlaWdodDogc2F2ZWQ/LmhlaWdodCA/PyA5MDAsXHJcbiAgICAgIC4uLihzYXZlZD8ueCAhPT0gdW5kZWZpbmVkICYmIHNhdmVkPy55ICE9PSB1bmRlZmluZWQgPyB7IHg6IHNhdmVkLngsIHk6IHNhdmVkLnkgfSA6IHt9KSxcclxuICAgICAgLy8gSElHIFx1OTYzNlx1NkJCNTIoMTEtQSk6XHU3QTg0XHU3QTk3XHU0RTBCXHU5NjUwIDU2MCgwNCBcdTUzRjdcdTg5QzRcdTY4M0M7XHU1MzlGIDk2MCBcdTRGN0YgXHUyMjY0ODIwcHggXHU2MkJEXHU1QzQ5XHU2NUFEXHU3MEI5XHU0RTBEXHU1M0VGXHU4RkJFKTtcclxuICAgICAgLy8gVUlWRVJJRlkgXHU3QTg0XHU1QzRGXHU5QThDXHU2NTM2KDExLUIsd2l6YXJkIDM2MFx1MDBENzY0MCBcdTUxNjhcdTUxNDNcdTdEMjBcdTUzRUZcdThGQkUpXHU5NzAwXHU0RTM0XHU2NUY2XHU2NTNFXHU1QkJEXHU1MjMwIDMyMFx1MDBENzM2MFx1MzAwMlxyXG4gICAgICBtaW5XaWR0aDogcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRlkgPT09ICcxJyA/IDMyMCA6IDU2MCxcclxuICAgICAgbWluSGVpZ2h0OiBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWSA9PT0gJzEnID8gMzYwIDogNjAwLFxyXG4gICAgICBzaG93OiBmYWxzZSxcclxuICAgICAgYmFja2dyb3VuZENvbG9yOiAnI2Y5ZmFmYicsIC8vIHY0IERTSDpcdTZENDVcdTgyNzJcdTlFRDhcdThCQTQoYmctYmFzZSksXHU5MDdGXHU1MTREXHU2REYxXHU4MjcyXHU5NUVBXHU1QzRGXHJcbiAgICAgIHRpdGxlOiAnSE1IIERlc2t0b3AnLFxyXG4gICAgICAvLyBcdTk2OTBcdTg1Q0ZcdTVGMEZcdTY4MDdcdTk4OThcdTY4MEY6XHU1MzlGXHU3NTFGXHU3QTk3XHU1M0UzXHU2M0E3XHU1MjM2KG92ZXJsYXkgXHU2M0QwXHU0RjlCKStcdTk4OUNcdTgyNzJcdTk2OEZcdTRFM0JcdTk4OTgocmVuZGVyZXIgXHU3RUNGXHJcbiAgICAgIC8vIGNocm9tZS10aGVtZSBcdTU0MENcdTZCNjUpXHUyMDE0XHUyMDE0XHU2ODM5XHU2Q0JCXHU0RUFFXHU4MjcyXHU2QTIxXHU1RjBGXHU5ODc2XHU5MEU4XHU5RUQxXHU2NzYxO1x1ODNEQ1x1NTM1NVx1NjgwRiBhdXRvSGlkZShBbHQgXHU1NDdDXHU1MUZBKVx1MzAwMlxyXG4gICAgICB0aXRsZUJhclN0eWxlOiAnaGlkZGVuJyxcclxuICAgICAgLy8gSElHIFx1OTYzNlx1NkJCNTI6MzZcdTIxOTI0NCxcdTRFMEUgcmVuZGVyZXIgLnRpdGxlYmFyIFx1OUFEOFx1NUVBNlx1NEUwMFx1ODFGNChcdTRFMERcdTRFMDBcdTgxRjRcdTRGMUFcdTk3MzJcdTUxRkEvXHU5MDZFXHU0RjRGIDhweClcclxuICAgICAgdGl0bGVCYXJPdmVybGF5OiB7IC4uLmNocm9tZUZvcihuYXRpdmVUaGVtZS5zaG91bGRVc2VEYXJrQ29sb3JzKSwgaGVpZ2h0OiA0NCB9LFxyXG4gICAgICBhdXRvSGlkZU1lbnVCYXI6IHRydWUsXHJcbiAgICAgIHdlYlByZWZlcmVuY2VzOiB7XHJcbiAgICAgICAgcHJlbG9hZDogcHJlbG9hZFBhdGgsXHJcbiAgICAgICAgY29udGV4dElzb2xhdGlvbjogdHJ1ZSxcclxuICAgICAgICBzYW5kYm94OiB0cnVlLFxyXG4gICAgICAgIG5vZGVJbnRlZ3JhdGlvbjogZmFsc2UsXHJcbiAgICAgICAgbm9kZUludGVncmF0aW9uSW5Xb3JrZXI6IGZhbHNlLFxyXG4gICAgICAgIHdlYlNlY3VyaXR5OiB0cnVlLFxyXG4gICAgICAgIHNwZWxsY2hlY2s6IGZhbHNlLFxyXG4gICAgICAgIGRldlRvb2xzOiBpc0RldixcclxuICAgICAgfSxcclxuICAgIH0pO1xyXG4gICAgd2luLm9uY2UoJ3JlYWR5LXRvLXNob3cnLCAoKSA9PiB3aW4uc2hvdygpKTtcclxuICAgIHdpbi5vbignY2xvc2UnLCAoKSA9PiB7IHZvaWQgc2F2ZUJvdW5kcyh3aW4pOyB9KTtcclxuXHJcbiAgICAvLyBcdTUzRUFcdTUxNDFcdThCQjhcdTUyQTBcdThGN0RcdTYyMTFcdTRFRUNcdTgxRUFcdTVERjFcdTc2ODQgcmVuZGVyZXI7XHU0RUZCXHU0RjU1XHU1QkZDXHU4MjJBL1x1NjVCMFx1N0E5N1x1NTNFM1x1NEUwMFx1NUY4Qlx1NjJEMlx1N0VERFxyXG4gICAgd2luLndlYkNvbnRlbnRzLnNldFdpbmRvd09wZW5IYW5kbGVyKCh7IHVybCB9KSA9PiB7XHJcbiAgICAgIGlmICgvXmh0dHBzPzpcXC9cXC8vLnRlc3QodXJsKSkgdm9pZCBzaGVsbC5vcGVuRXh0ZXJuYWwodXJsKTtcclxuICAgICAgcmV0dXJuIHsgYWN0aW9uOiAnZGVueScgfTtcclxuICAgIH0pO1xyXG4gICAgd2luLndlYkNvbnRlbnRzLm9uKCd3aWxsLW5hdmlnYXRlJywgKGUsIHVybCkgPT4ge1xyXG4gICAgICBjb25zdCBvayA9IFsuLi5hbGxvd2VkT3JpZ2luc10uc29tZSgobykgPT4gdXJsID09PSBvIHx8IHVybC5zdGFydHNXaXRoKGAke299L2ApIHx8IHVybC5zdGFydHNXaXRoKGAke299P2ApKTtcclxuICAgICAgaWYgKCFvaykge1xyXG4gICAgICAgIGxvZ0luZm8oJ25hdicsIGBibG9ja2VkIG5hdmlnYXRpb24gdG8gJHt1cmwuc2xpY2UoMCwgMTIwKX1gKTtcclxuICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7XHJcbiAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIGlmIChpc0RldiAmJiByZW5kZXJlckRldlVybCkge1xyXG4gICAgICB2b2lkIHdpbi5sb2FkVVJMKHJlbmRlcmVyRGV2VXJsKTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgIHZvaWQgd2luLmxvYWRGaWxlKGpvaW4oaGVyZSwgJy4uJywgJy4uJywgJ2Rpc3QtcmVuZGVyZXInLCAnaW5kZXguaHRtbCcpKTtcclxuICAgIH1cclxuICAgIC8vIFx1OTg3NVx1OTc2Mlx1NTJBMFx1OEY3RFx1NUI4Q1x1OTFDRFx1NjRBRFx1NUY1M1x1NTI0RCBob3N0IFx1NzJCNlx1NjAwMTpyZWFkeSBcdTVFN0ZcdTY0QURcdTgyRTVcdTY1RTlcdTRFOEUgcmVuZGVyZXIgXHU4QkEyXHU5NjA1XHU1MzczXHU0RTIyXHU1OTMxLFxyXG4gICAgLy8gcmVuZGVyZXIgXHU3Njg0IGdldC1zdGF0ZSBcdTVGRUJcdTcxNjcgKyBcdThGRDlcdTkxQ0NcdTc2ODRcdTkxQ0RcdTY0QURcdTUzQ0NcdTRGRERcdTk2NjkoXHU1OTFBXHU3QTk3XHU1M0UzL1x1OTFDRFx1OEY3RFx1NTczQVx1NjY2Rlx1NEU1Rlx1ODk4Nlx1NzZENilcdTMwMDJcclxuICAgIHdpbi53ZWJDb250ZW50cy5vbmNlKCdkaWQtZmluaXNoLWxvYWQnLCAoKSA9PiB7XHJcbiAgICAgIGlmICghd2luLmlzRGVzdHJveWVkKCkpIHtcclxuICAgICAgICB3aW4ud2ViQ29udGVudHMuc2VuZCgnYnJpZGdlOmhvc3Qtc3RhdGUnLCBicmlkZ2UuaG9zdFN0YXRlLCB7IHJlc3RhcnRDb3VudDogMCB9KTtcclxuICAgICAgfVxyXG4gICAgfSk7XHJcbiAgICByZXR1cm4gd2luO1xyXG4gIH1cclxuXHJcbiAgYXBwLndoZW5SZWFkeSgpLnRoZW4oKCkgPT4ge1xyXG4gICAgLy8gVUlWRVJJRlk6ZmFrZSBcdTZBMjFcdTVGMEZcdTlBOENcdTY1MzZcdTk4N0JcdTU3Mjggc3RhcnRIb3N0IFx1OEJGQiBlbnYgXHU0RTRCXHU1MjREXHU1RjNBXHU1MjM2IGZha2U7VklTUkVHKFx1ODlDNlx1ODlDOVx1NTZERVx1NUY1MilcdTU0MENcdTg5QzRcdTUyMTlcclxuICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9WSVNSRUcgPT09ICcxJyB8fCAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRlkgPT09ICcxJyAmJiBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9NT0RFICE9PSAncmVhbCcpKSB7XHJcbiAgICAgIHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX0ZBS0UgPSAnMSc7XHJcbiAgICB9XHJcbiAgICAvLyBXaW5kb3dzIFx1OTAxQVx1NzdFNVx1NUY1Mlx1NUM1RShcdTU0MjZcdTUyMTlcdTY2M0VcdTc5M0FcdTRFM0EgZWxlY3Ryb24uZXhlKVxyXG4gICAgYXBwLnNldEFwcFVzZXJNb2RlbElkKCdkZXYuaG1oLmRlc2t0b3AnKTtcclxuICAgIHNldHVwVHJheSgpO1xyXG4gICAgYnVpbGRBcHBNZW51KCk7XHJcbiAgICAvLyBcdTU0MkZcdTUyQTggMzBzIFx1NTQwRVx1OTc1OVx1OUVEOFx1NjhDMFx1NjdFNVx1NjZGNFx1NjVCMChcdTY3MDlcdTY1QjBcdTcyNDhcdTRFQzVcdTU0MEVcdTUzRjBcdTRFMEJcdThGN0QsXHU0RTBEXHU2MjUzXHU2MjcwO1x1NTkzMVx1OEQyNVx1OTc1OVx1OUVEOCxcdTRFMEJcdTZCMjFcdTU0MkZcdTUyQThcdTUxOERcdThCRDUpXHUzMDAyXHJcbiAgICAvLyBkZXYgXHU0RTVGXHU2OEMwXHU2N0U1Olx1ODg0Q1x1NEUzQVx1NEUwRVx1NjI1M1x1NTMwNVx1NzI0OFx1NEUwMFx1ODFGNCxcdTRFMTQgRk9SQ0VfVEFHIFx1NjVDQlx1OTRBRVx1NEUwQiBkZXYgXHU1MzczXHU1M0VGXHU1MTY4XHU2RDQxXHU3QTBCXHU5QThDXHU2NTM2XHUzMDAyXHJcbiAgICBzZXRUaW1lb3V0KCgpID0+IHsgdm9pZCBjaGVja0ZvclVwZGF0ZXMoKTsgfSwgMzBfMDAwKTtcclxuICAgIC8vIENTUChkZXYgXHU0RTBFIHByb2QgXHU0RTBEXHU1NDBDO3Byb2QgXHU0RTBEXHU1MTQxXHU4QkI4XHU0RUZCXHU0RjU1XHU4RkRDXHU3QTBCXHU2RTkwKVxyXG4gICAgY29uc3QgY3NwID0gaXNEZXZcclxuICAgICAgPyBbXHJcbiAgICAgICAgICBcImRlZmF1bHQtc3JjICdzZWxmJ1wiLFxyXG4gICAgICAgICAgYHNjcmlwdC1zcmMgJ3NlbGYnICR7cmVuZGVyZXJEZXZVcmx9YCxcclxuICAgICAgICAgIFwic3R5bGUtc3JjICdzZWxmJyAndW5zYWZlLWlubGluZSdcIixcclxuICAgICAgICAgIGBjb25uZWN0LXNyYyAnc2VsZicgJHtyZW5kZXJlckRldlVybH0gd3M6Ly8xMjcuMC4wLjE6KmAsXHJcbiAgICAgICAgICBcImltZy1zcmMgJ3NlbGYnIGRhdGE6XCIsXHJcbiAgICAgICAgICBcImZvbnQtc3JjICdzZWxmJyBkYXRhOlwiLFxyXG4gICAgICAgIF0uam9pbignOyAnKVxyXG4gICAgICA6IFwiZGVmYXVsdC1zcmMgJ3NlbGYnOyBzY3JpcHQtc3JjICdzZWxmJzsgc3R5bGUtc3JjICdzZWxmJyAndW5zYWZlLWlubGluZSc7IGltZy1zcmMgJ3NlbGYnIGRhdGE6OyBmb250LXNyYyAnc2VsZicgZGF0YTpcIjtcclxuICAgIHNlc3Npb24uZGVmYXVsdFNlc3Npb24ud2ViUmVxdWVzdC5vbkhlYWRlcnNSZWNlaXZlZCgoZGV0YWlscywgY2FsbGJhY2spID0+IHtcclxuICAgICAgY2FsbGJhY2soe1xyXG4gICAgICAgIHJlc3BvbnNlSGVhZGVyczoge1xyXG4gICAgICAgICAgLi4uZGV0YWlscy5yZXNwb25zZUhlYWRlcnMsXHJcbiAgICAgICAgICAnQ29udGVudC1TZWN1cml0eS1Qb2xpY3knOiBbY3NwXSxcclxuICAgICAgICB9LFxyXG4gICAgICB9KTtcclxuICAgIH0pO1xyXG5cclxuICAgIHJlZ2lzdGVySXBjKCk7XHJcbiAgICAvLyBjcmVhdGVXaW5kb3cgXHU2NjJGIGFzeW5jKGJvdW5kcyBcdTYwNjJcdTU5MEQpO1x1NUI4OVx1NTE2OFx1ODFFQVx1NkQ0Qi9cdTZFMzJcdTY3RDNcdTgxRUFcdTY4QzBcdTU3MjhcdTdBOTdcdTUzRTNcdTVDMzFcdTdFRUFcdTU0MEVcdTYzMDJcdThGN0RcclxuICAgIHZvaWQgY3JlYXRlV2luZG93KCkudGhlbigod2luKSA9PiB7XHJcbiAgICAgIGlmICh3aW4gPT09IG51bGwpIHJldHVybjtcclxuICAgICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZID09PSAnMScpIGF0dGFjaFVpVmVyaWZ5KHdpbik7XHJcbiAgICAgIC8vIFx1ODlDNlx1ODlDOVx1NTZERVx1NUY1Mlx1NjIyQVx1NTZGRVx1OTRBOVx1NUI1MDpITUhfREVTS1RPUF9WSVNSRUc9MSxcdTc4NkVcdTVCOUFcdTYwMjdcdTg5QzZcdTUzRTNcdTYyMkFcdTU2RkVcdTU0MEVcdTkwMDBcdTUxRkEoc2NyaXB0cy92aXN1YWwtcmVncmVzc2lvbi5tanMgXHU5QTcxXHU1MkE4KVxyXG4gICAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVklTUkVHID09PSAnMScpIGF0dGFjaFZpc3VhbFJlZ3Jlc3Npb24od2luKTtcclxuICAgICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NFQ1VSSVRZX1RFU1QgPT09ICcxJykge1xyXG4gICAgICAgIHdpbi53ZWJDb250ZW50cy5vbmNlKCdkaWQtZmluaXNoLWxvYWQnLCAoKSA9PiB7XHJcbiAgICAgICAgICB2b2lkIHNlY3VyaXR5U2VsZlRlc3Qod2luKTtcclxuICAgICAgICB9KTtcclxuICAgICAgfVxyXG4gICAgICAvLyBVSSBcdTYyMkFcdTU2RkVcdTk0QTlcdTVCNTA6SE1IX0RFU0tUT1BfU05BUFNIT1Q9PGZpbGUucG5nPiBcdTU3MjhcdTc1NENcdTk3NjJcdTVDMzFcdTdFRUFcdTU0MEVcdTYyMkFcdTU2RkVcdTkwMDBcdTUxRkFcclxuICAgICAgLy8gKFx1ODhDNVx1NjczQVx1OEJDQVx1NjVBRFx1NzUyODpcdTRFQjJcdTc3M0NcdTc3MEJcdTZFMzJcdTY3RDNcdTdFRDNcdTY3OUMsXHU4MDBDXHU0RTBEXHU2NjJGXHU1M0VBXHU2NTcwIHJvb3QgXHU1QjUwXHU4MjgyXHU3MEI5KVx1MzAwMlxyXG4gICAgICBjb25zdCBzbmFwID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfU05BUFNIT1Q7XHJcbiAgICAgIGlmIChzbmFwICE9PSB1bmRlZmluZWQgJiYgc25hcCAhPT0gJycpIHtcclxuICAgICAgICB3aW4ud2ViQ29udGVudHMub25jZSgnZGlkLWZpbmlzaC1sb2FkJywgKCkgPT4ge1xyXG4gICAgICAgICAgc2V0VGltZW91dCgoKSA9PiB7XHJcbiAgICAgICAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcclxuICAgICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgaW1nID0gYXdhaXQgd2luLndlYkNvbnRlbnRzLmNhcHR1cmVQYWdlKCk7XHJcbiAgICAgICAgICAgICAgICBjb25zdCB7IHdyaXRlRmlsZTogd2YgfSA9IGF3YWl0IGltcG9ydCgnbm9kZTpmcy9wcm9taXNlcycpO1xyXG4gICAgICAgICAgICAgICAgYXdhaXQgd2Yoc25hcCwgaW1nLnRvUE5HKCkpO1xyXG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYFNOQVBTSE9UIG9rICR7c25hcH0gJHtpbWcuZ2V0U2l6ZSgpLndpZHRofXgke2ltZy5nZXRTaXplKCkuaGVpZ2h0fWApO1xyXG4gICAgICAgICAgICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYFNOQVBTSE9UIGVycm9yICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTIwKX1gKTtcclxuICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgY29uc3QgYXBwMiA9IGFwcDtcclxuICAgICAgICAgICAgICBzZXRUaW1lb3V0KCgpID0+IGFwcDIuZXhpdCgwKSwgNTAwKTtcclxuICAgICAgICAgICAgfSkoKTtcclxuICAgICAgICAgIH0sIE51bWJlcihwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9TTkFQU0hPVF9ERUxBWV9NUyA/PyAxMl8wMDApKTtcclxuICAgICAgICB9KTtcclxuICAgICAgfVxyXG4gICAgICAvLyBET00gXHU3RUQzXHU2Nzg0XHU2M0EyXHU5NDg4OkhNSF9ERVNLVE9QX0RPTVBST0JFPTEgXHU4RjkzXHU1MUZBXHU1MTczXHU5NTJFXHU1MTQzXHU3RDIwXHU3Njg0IGJveC9kaXNwbGF5L2NoaWxkcmVuLFxyXG4gICAgICAvLyBcdTUxOERcdTkwMDBcdTUxRkEoXHU4QkNBXHU2NUFEXCJSZWFjdCBcdTYzMDJcdThGN0RcdTRFODZcdTRGNDZcdTY3RDBcdTU3NTcgVUkgXHU0RTBEXHU1M0VGXHU4OUMxXCJcdThGRDlcdTdDN0JcdTk1RUVcdTk4OTg7XHU2MjJBXHU1NkZFXHU0RTRCXHU1OTE2XHU3Njg0XHU3ODZDXHU4QkMxXHU2MzZFKVx1MzAwMlxyXG4gICAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfRE9NUFJPQkUgPT09ICcxJykge1xyXG4gICAgICAgIHdpbi53ZWJDb250ZW50cy5vbmNlKCdkaWQtZmluaXNoLWxvYWQnLCAoKSA9PiB7XHJcbiAgICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHtcclxuICAgICAgICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCByID0gKGF3YWl0IHdpbi53ZWJDb250ZW50cy5leGVjdXRlSmF2YVNjcmlwdChgKGZ1bmN0aW9uKCl7XHJcbiAgICAgICAgICAgICAgICAgIHZhciBwaWNrID0gZnVuY3Rpb24oc2VsKXtcclxuICAgICAgICAgICAgICAgICAgICB2YXIgZWxzID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbChzZWwpO1xyXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBBcnJheS5wcm90b3R5cGUuc2xpY2UuY2FsbChlbHMsIDAsIDQpLm1hcChmdW5jdGlvbihlbCl7XHJcbiAgICAgICAgICAgICAgICAgICAgICB2YXIgY3MgPSBnZXRDb21wdXRlZFN0eWxlKGVsKTtcclxuICAgICAgICAgICAgICAgICAgICAgIHZhciBiID0gZWwuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICByZXR1cm4geyBjbHM6IChlbC5jbGFzc05hbWV8fCcnKS50b1N0cmluZygpLnNsaWNlKDAsODApLCB0YWc6IGVsLnRhZ05hbWUsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGRpc3BsYXk6IGNzLmRpc3BsYXksIHZpczogY3MudmlzaWJpbGl0eSwgb3BhY2l0eTogY3Mub3BhY2l0eSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgcG9zOiBjcy5wb3NpdGlvbiwgejogY3MuekluZGV4LCBvdmVyZmxvdzogY3Mub3ZlcmZsb3csXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHg6IE1hdGgucm91bmQoYi54KSwgeTogTWF0aC5yb3VuZChiLnkpLCB3OiBNYXRoLnJvdW5kKGIud2lkdGgpLCBoOiBNYXRoLnJvdW5kKGIuaGVpZ2h0KSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgdGV4dDogKGVsLmlubmVyVGV4dHx8JycpLnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw2MCkgfTtcclxuICAgICAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgICAgICAgdmFyIHNlbHMgPSBbJ2h0bWwnLCdib2R5JywnI3Jvb3QnLCcuYXBwLXNoZWxsJywnLnNpZGViYXInLCcud29ya3NwYWNlJywnLnRvcGJhcicsJy5zdHJlYW0nLCcuZW1wdHktaGludCcsJy5jb21wb3NlcicsJy5jb21wb3Nlci1yb3cnLCcuY29tcG9zZXIgdGV4dGFyZWEnLCcuY29tcG9zZXItc2lkZScsJy5hdHQtcGlja2VyJywnLmF0dC1jaGlwcycsJy5zaWRlcGFuZWwnLCcucnVudGltZS1ndWlkZScsJy5vdmVybGF5JywnLnR1cm4nLCcuY2FyZCddO1xyXG4gICAgICAgICAgICAgICAgICB2YXIgb3V0ID0ge307XHJcbiAgICAgICAgICAgICAgICAgIHNlbHMuZm9yRWFjaChmdW5jdGlvbihzKXsgdHJ5IHsgb3V0W3NdID0gcGljayhzKTsgfSBjYXRjaChlKXsgb3V0W3NdID0gW3tlcnI6IFN0cmluZyhlKS5zbGljZSgwLDgwKX1dOyB9IH0pO1xyXG4gICAgICAgICAgICAgICAgICBvdXQuX19tZXRhID0ge1xyXG4gICAgICAgICAgICAgICAgICAgIHN0eWxlU2hlZXRzOiBkb2N1bWVudC5zdHlsZVNoZWV0cy5sZW5ndGgsXHJcbiAgICAgICAgICAgICAgICAgICAgc2hlZXQwcnVsZXM6IChkb2N1bWVudC5zdHlsZVNoZWV0c1swXSAmJiBkb2N1bWVudC5zdHlsZVNoZWV0c1swXS5jc3NSdWxlcykgPyBkb2N1bWVudC5zdHlsZVNoZWV0c1swXS5jc3NSdWxlcy5sZW5ndGggOiAtMSxcclxuICAgICAgICAgICAgICAgICAgICByb290Q2hpbGRyZW46IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyb290JykgPyBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncm9vdCcpLmNoaWxkcmVuLmxlbmd0aCA6IC0xLFxyXG4gICAgICAgICAgICAgICAgICAgIGJvZHlDaGlsZHJlbjogZG9jdW1lbnQuYm9keS5jaGlsZHJlbi5sZW5ndGgsXHJcbiAgICAgICAgICAgICAgICAgICAgaW5uZXJIVE1MTGVuOiBkb2N1bWVudC5ib2R5LmlubmVySFRNTC5sZW5ndGgsXHJcbiAgICAgICAgICAgICAgICAgICAgdmlld3BvcnQ6IHdpbmRvdy5pbm5lcldpZHRoICsgJ3gnICsgd2luZG93LmlubmVySGVpZ2h0XHJcbiAgICAgICAgICAgICAgICAgIH07XHJcbiAgICAgICAgICAgICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeShvdXQpO1xyXG4gICAgICAgICAgICAgICAgfSkoKWAsIHRydWUpKSBhcyBzdHJpbmc7XHJcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgRE9NUFJPQkUgJHtyfWApO1xyXG4gICAgICAgICAgICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYERPTVBST0JFIGVycm9yICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMjAwKX1gKTtcclxuICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgYXBwLmV4aXQoMCk7XHJcbiAgICAgICAgICAgIH0pKCk7XHJcbiAgICAgICAgICB9LCBOdW1iZXIocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfRE9NUFJPQkVfREVMQVlfTVMgPz8gOV8wMDApKTtcclxuICAgICAgICB9KTtcclxuICAgICAgfVxyXG4gICAgICAvLyBcdTZFMzJcdTY3RDNcdTgxRUFcdTY4QzAoMjAyNi0xMC0xMCBcdTg4QzVcdTY3M0FcdTlFRDFcdTVDNEZcdTY1NTlcdThCQUQ6YnJpZGdlIHJlYWR5IFx1MjI2MCBcdTc1NENcdTk3NjJcdTZFMzJcdTY3RDNcdTRFODYpXHUzMDAyXHJcbiAgICAgIC8vICNyb290IFx1NTcyOCBSZWFjdCBcdTYzMDJcdThGN0RcdTU0MEVcdTVGQzVcdTY3MDlcdTVCNTBcdTgyODJcdTcwQjk7XHU3QTdBID0gXHU4RDQ0XHU2RTkwXHU4REVGXHU1Rjg0L0NTUC9cdTgxMUFcdTY3MkNcdTUyQTBcdThGN0RcdTU3NEZcdTRFODZcdTMwMDJcclxuICAgICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1JFTkRFUl9URVNUID09PSAnMScpIHtcclxuICAgICAgICB3aW4ud2ViQ29udGVudHMub25jZSgnZGlkLWZpbmlzaC1sb2FkJywgKCkgPT4ge1xyXG4gICAgICAgICAgc2V0VGltZW91dCgoKSA9PiB7XHJcbiAgICAgICAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcclxuICAgICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgbiA9IChhd2FpdCB3aW4ud2ViQ29udGVudHMuZXhlY3V0ZUphdmFTY3JpcHQoXHJcbiAgICAgICAgICAgICAgICAgICdkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInJvb3RcIikgPyBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInJvb3RcIikuY2hpbGRyZW4ubGVuZ3RoIDogLTEnLCB0cnVlLFxyXG4gICAgICAgICAgICAgICAgKSkgYXMgbnVtYmVyO1xyXG4gICAgICAgICAgICAgICAgY29uc3Qgb2sgPSBuID4gMDtcclxuICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBSRU5ERVItVEVTVCAke29rID8gJ29rJyA6ICdFTVBUWSd9IHJvb3RDaGlsZHJlbj0ke259YCk7XHJcbiAgICAgICAgICAgICAgICBhcHAuZXhpdChvayA/IDAgOiAxKTtcclxuICAgICAgICAgICAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBSRU5ERVItVEVTVCBFUlJPUiAke1N0cmluZyhlcnIpLnNsaWNlKDAsIDEyMCl9YCk7XHJcbiAgICAgICAgICAgICAgICBhcHAuZXhpdCgxKTtcclxuICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH0pKCk7XHJcbiAgICAgICAgICB9LCAyXzUwMCk7XHJcbiAgICAgICAgfSk7XHJcbiAgICAgIH1cclxuICAgIH0pO1xyXG4gICAgdm9pZCBzdGFydEhvc3QoKTtcclxuXHJcbiAgICBhcHAub24oJ2FjdGl2YXRlJywgKCkgPT4ge1xyXG4gICAgICBpZiAoQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkubGVuZ3RoID09PSAwKSB2b2lkIGNyZWF0ZVdpbmRvdygpO1xyXG4gICAgfSk7XHJcbiAgfSk7XHJcblxyXG4gIGFzeW5jIGZ1bmN0aW9uIHNlY3VyaXR5U2VsZlRlc3Qod2luOiBCcm93c2VyV2luZG93KTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCByZXN1bHRzOiBBcnJheTxbc3RyaW5nLCBib29sZWFuLCBzdHJpbmddPiA9IFtdO1xyXG4gICAgY29uc3QgY2hlY2sgPSBhc3luYyAobmFtZTogc3RyaW5nLCBwcm9iZTogKCkgPT4gUHJvbWlzZTxbYm9vbGVhbiwgc3RyaW5nXT4pOiBQcm9taXNlPHZvaWQ+ID0+IHtcclxuICAgICAgdHJ5IHtcclxuICAgICAgICBjb25zdCBbb2ssIGRldGFpbF0gPSBhd2FpdCBwcm9iZSgpO1xyXG4gICAgICAgIHJlc3VsdHMucHVzaChbbmFtZSwgb2ssIGRldGFpbF0pO1xyXG4gICAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgICByZXN1bHRzLnB1c2goW25hbWUsIGZhbHNlLCBTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApXSk7XHJcbiAgICAgIH1cclxuICAgIH07XHJcbiAgICBjb25zdCBqcyA9IChjb2RlOiBzdHJpbmcpOiBQcm9taXNlPHVua25vd24+ID0+IHdpbi53ZWJDb250ZW50cy5leGVjdXRlSmF2YVNjcmlwdChjb2RlLCB0cnVlKTtcclxuXHJcbiAgICBhd2FpdCBjaGVjaygncmVuZGVyZXIgXHU2NUUwXHU1M0VGXHU3NTI4XHU3Njg0IHByb2Nlc3MvcmVxdWlyZShzYW5kYm94IFx1NzUxRlx1NjU0OCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoYChmdW5jdGlvbigpe1xyXG4gICAgICAgIHZhciB0ID0gZnVuY3Rpb24oZil7IHRyeSB7IHZhciB2ID0gZigpOyByZXR1cm4gKHYgPT09IHVuZGVmaW5lZCB8fCB2ID09PSBudWxsKSA/ICd1bmF2YWlsYWJsZScgOiB0eXBlb2YgdjsgfSBjYXRjaChlKXsgcmV0dXJuICdibG9ja2VkJzsgfSB9O1xyXG4gICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeShbdChmdW5jdGlvbigpe3JldHVybiBwcm9jZXNzfSksIHQoZnVuY3Rpb24oKXtyZXR1cm4gcmVxdWlyZX0pLCB0KGZ1bmN0aW9uKCl7cmV0dXJuIGdsb2JhbFRoaXMucHJvY2Vzc30pXSk7XHJcbiAgICAgIH0pKClgKSkgYXMgc3RyaW5nO1xyXG4gICAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHIpIGFzIHN0cmluZ1tdO1xyXG4gICAgICBjb25zdCBwID0gcGFyc2VkWzBdID8/ICd1bmtub3duJztcclxuICAgICAgY29uc3QgcmVxID0gcGFyc2VkWzFdID8/ICd1bmtub3duJztcclxuICAgICAgY29uc3Qgc2FmZSA9ICh2OiBzdHJpbmcpOiBib29sZWFuID0+IHYgPT09ICd1bmF2YWlsYWJsZScgfHwgdiA9PT0gJ2Jsb2NrZWQnO1xyXG4gICAgICByZXR1cm4gW3NhZmUocCkgJiYgc2FmZShyZXEpLCBgcHJvY2Vzcz0ke3B9IHJlcXVpcmU9JHtyZXF9YF07XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IGNoZWNrKCd3aW5kb3cuaG1oIFx1NTNFQVx1NjcwOVx1NzY3RFx1NTQwRFx1NTM1NVx1NjVCOVx1NkNENShcdTY1RTAgaXBjUmVuZGVyZXIvXHU5ODlEXHU1OTE2XHU5NzYyKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgciA9IChhd2FpdCBqcygnT2JqZWN0LmtleXMod2luZG93LmhtaCB8fCB7fSkuc29ydCgpLmpvaW4oXCIsXCIpJykpIGFzIHN0cmluZztcclxuICAgICAgY29uc3QgYWxsb3cgPSBbJ2FwcGx5VXBkYXRlJywgJ2FwcHJvdmUnLCAnYXBwcm92YWxHZXQnLCAnYXBwcm92YWxTZXQnLCAnYnJvd3NlUnVudGltZScsICdjaGVja1VwZGF0ZScsICdjaHJvbWVUaGVtZScsICdjb2duaXRpdmUnLCAnZGV0ZWN0UnVudGltZScsICdkaWZmJywgJ2V4cG9ydFNlc3Npb24nLCAnZnNMaXN0JywgJ2ZzUmVhZCcsICdmc1NlYXJjaCcsICdnZXRTdGF0ZScsICdnZXRXaXphcmQnLCAnaW5qZWN0JywgJ2luc3RhbGxDbGknLCAnaW50ZXJydXB0JywgJ21vZGVsU2V0JywgJ29uRXZlbnRCYXRjaGVzJywgJ29uSG9zdFN0YXRlJywgJ29uSW5zdGFsbFByb2dyZXNzJywgJ29uTWVudUFjdGlvbicsICdvblN0cmVhbUNodW5rcycsICdvblVwZGF0ZVN0YXRlJywgJ3BpY2tEaXJlY3RvcnknLCAncGlja0ZpbGVzJywgJ3BvcHVwTWFpbk1lbnUnLCAncHJvdmlkZXJTYXZlJywgJ3Byb3ZpZGVycycsICdyZW1vdGVXZWJBdXRvc3RhcnQnLCAncmVtb3RlV2ViU3RhcnQnLCAncmVtb3RlV2ViU3RhdHVzJywgJ3JlbW90ZVdlYlN0b3AnLCAncnVudGltZUluZm8nLCAnc2VuZFRhc2snLCAnc2Vzc2lvbk9wJywgJ3Nlc3Npb25QcmV2aWV3JywgJ3Nlc3Npb25zJywgJ3NldFJ1bnRpbWUnLCAnc3RvcEhvc3QnLCAnd2l6YXJkQ29tcGxldGUnLCAnd29ya3NwYWNlcycsICd3b3Jrc3BhY2VBZGQnLCAnd29ya3NwYWNlVXNlJ107XHJcbiAgICAgIGNvbnN0IGdvdCA9IHIgPT09ICcnID8gW10gOiByLnNwbGl0KCcsJyk7XHJcbiAgICAgIGNvbnN0IHVuZXhwZWN0ZWQgPSBnb3QuZmlsdGVyKChrKSA9PiAhYWxsb3cuaW5jbHVkZXMoaykpO1xyXG4gICAgICByZXR1cm4gW3VuZXhwZWN0ZWQubGVuZ3RoID09PSAwLCBga2V5cz0ke3J9YF07XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IGNoZWNrKCdcdTU5MTZcdTkwRThcdTVCRkNcdTgyMkFcdTg4QUJcdTYyRTZcdTYyMkEoVVJMIFx1NEUwRFx1NTNEOCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IGJlZm9yZSA9IHdpbi53ZWJDb250ZW50cy5nZXRVUkwoKTtcclxuICAgICAgYXdhaXQganMoJ2xvY2F0aW9uLmhyZWYgPSBcImh0dHBzOi8vZXhhbXBsZS5pbnZhbGlkL3hcIjsgXCJub29wXCInKS5jYXRjaCgoKSA9PiAnbm9vcCcpO1xyXG4gICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocjIpID0+IHNldFRpbWVvdXQocjIsIDFfMjAwKSk7XHJcbiAgICAgIGNvbnN0IGFmdGVyID0gd2luLndlYkNvbnRlbnRzLmdldFVSTCgpO1xyXG4gICAgICByZXR1cm4gW2FmdGVyID09PSBiZWZvcmUsIGAke2JlZm9yZX0gXHUyMTkyICR7YWZ0ZXJ9YF07XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IGNoZWNrKCd3aW5kb3cub3BlbiBcdTg4QUJcdTYyRDJcdTdFREQoXHU4RkQ0XHU1NkRFIG51bGwgXHU0RTE0XHU2NUUwXHU2NUIwXHU3QTk3XHU1M0UzKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgYmVmb3JlID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkubGVuZ3RoO1xyXG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKCdTdHJpbmcod2luZG93Lm9wZW4oXCJodHRwczovL2V4YW1wbGUuaW52YWxpZFwiKSknKSkgYXMgc3RyaW5nO1xyXG4gICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocjIpID0+IHNldFRpbWVvdXQocjIsIDQwMCkpO1xyXG4gICAgICBjb25zdCBhZnRlciA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmxlbmd0aDtcclxuICAgICAgcmV0dXJuIFtyID09PSAnbnVsbCcgJiYgYWZ0ZXIgPT09IGJlZm9yZSwgYG9wZW4oKT0ke3J9IHdpbmRvd3M9JHtiZWZvcmV9XHUyMTkyJHthZnRlcn1gXTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgY2hlY2soJ0NTUCBcdTVCNThcdTU3MjgobWV0YSBcdTZDRThcdTUxNjVcdTYyMTZcdTU0Q0RcdTVFOTRcdTU5MzQpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCBtZXRhID0gKGF3YWl0IGpzKCdCb29sZWFuKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoXCJtZXRhW2h0dHAtZXF1aXY9XFwnQ29udGVudC1TZWN1cml0eS1Qb2xpY3lcXCddXCIpKScpKSBhcyBib29sZWFuO1xyXG4gICAgICBjb25zdCBoZWFkZXJDc3AgPSBpc0RldiA/ICdkZXY6IGhlYWRlciBDU1AgXHU3NTMxIG9uSGVhZGVyc1JlY2VpdmVkIFx1NkNFOFx1NTE2NShcdTRFMERcdTkwMDJcdTc1MjggbWV0YSBcdTY1QURcdThBMDApJyA6ICdwcm9kJztcclxuICAgICAgcmV0dXJuIFttZXRhIHx8IGlzRGV2LCBgbWV0YT0ke21ldGF9ICR7aGVhZGVyQ3NwfWBdO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBjaGVjaygnYnJpZGdlOmdldC1zdGF0ZSBcdTZCNjNcdTVFMzhcdThGRDRcdTU2REUoaG9zdCBcdTY4NjVcdTUzRUZcdTc1MjgpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKCd3aW5kb3cuaG1oLmdldFN0YXRlKCkudGhlbihzID0+IEpTT04uc3RyaW5naWZ5KHMpKS5jYXRjaChlID0+IFwiRVJSOlwiK2UpJykpIGFzIHN0cmluZztcclxuICAgICAgcmV0dXJuIFtyLnN0YXJ0c1dpdGgoJ3snKSAmJiByLmluY2x1ZGVzKCdob3N0U3RhdGUnKSwgci5zbGljZSgwLCA4MCldO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBjaGVjaygnWFNTOlx1NjA3Nlx1NjEwRlx1NEVGQlx1NTJBMVx1NjU4N1x1NjcyQ1x1NTNFQVx1NEVFNVx1NjU4N1x1NjcyQ1x1NkUzMlx1NjdEMyhcdTRFMERcdTYyNjdcdTg4NEMpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCBwYXlsb2FkID0gJzxpbWcgc3JjPXggb25lcnJvcj1cIndpbmRvdy5fX3hzcz0xXCI+PHNjcmlwdD53aW5kb3cuX194c3M9MjxcXC9zY3JpcHQ+XCImXFwnJztcclxuICAgICAgY29uc3Qgc2VuZFIgPSAoYXdhaXQganMoYHdpbmRvdy5obWguc2VuZFRhc2soJHtKU09OLnN0cmluZ2lmeShwYXlsb2FkKX0sICdzZWMteHNzLTEnLCAnYXV0bycpLnRoZW4ocj0+SlNPTi5zdHJpbmdpZnkocikpLmNhdGNoKGU9PidFUlI6JytlKWApKSBhcyBzdHJpbmc7XHJcbiAgICAgIGlmICghc2VuZFIuaW5jbHVkZXMoJ1wib2tcIjp0cnVlJykpIHJldHVybiBbZmFsc2UsIGBzZW5kVGFzayBcdTY3MkFcdTUzRDdcdTc0MDY6ICR7c2VuZFIuc2xpY2UoMCwgODApfWBdO1xyXG4gICAgICAvLyBmYWtlIGhvc3QgZWNobyBcdTU2REVcdTY3NjVcdTU0MEVcdTdFQ0YgUmVhY3QgXHU2RTMyXHU2N0QzKFx1NzUyOFx1NjIzN1x1NkQ4OFx1NjA2RiArIFx1NTJBOVx1NjI0QiBlY2hvIFx1NTNDQ1x1OERFRlx1NUY4NClcclxuICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHIyKSA9PiBzZXRUaW1lb3V0KHIyLCAzXzAwMCkpO1xyXG4gICAgICBjb25zdCBwcm9iZSA9IChhd2FpdCBqcyhgSlNPTi5zdHJpbmdpZnkoe1xyXG4gICAgICAgIHhzc0ZsYWc6IHR5cGVvZiB3aW5kb3cuX194c3MsXHJcbiAgICAgICAgaW1nQ291bnQ6IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ2ltZ1tzcmM9XCJ4XCJdJykubGVuZ3RoLFxyXG4gICAgICAgIHNjcmlwdFJhbjogZG9jdW1lbnQuYm9keS5pbm5lclRleHQuaW5kZXhPZignd2luZG93Ll9feHNzPTInKSA+PSAwXHJcbiAgICAgIH0pYCkpIGFzIHN0cmluZztcclxuICAgICAgY29uc3QgcCA9IEpTT04ucGFyc2UocHJvYmUpIGFzIHsgeHNzRmxhZzogc3RyaW5nOyBpbWdDb3VudDogbnVtYmVyOyBzY3JpcHRSYW46IGJvb2xlYW4gfTtcclxuICAgICAgcmV0dXJuIFtwLnhzc0ZsYWcgPT09ICd1bmRlZmluZWQnICYmIHAuaW1nQ291bnQgPT09IDAsIGB4c3NGbGFnPSR7cC54c3NGbGFnfSBpbWc9JHtwLmltZ0NvdW50fWBdO1xyXG4gICAgfSk7XHJcblxyXG4gICAgbGV0IGZhaWxlZCA9IDA7XHJcbiAgICBmb3IgKGNvbnN0IFtuYW1lLCBvaywgZGV0YWlsXSBvZiByZXN1bHRzKSB7XHJcbiAgICAgIGNvbnNvbGUubG9nKGBTRUNVUklUWS1URVNUICR7b2sgPyAnUEFTUycgOiAnRkFJTCd9IHwgJHtuYW1lfSB8ICR7cmVkYWN0KGRldGFpbCl9YCk7XHJcbiAgICAgIGlmICghb2spIGZhaWxlZCArPSAxO1xyXG4gICAgfVxyXG4gICAgY29uc29sZS5sb2coYFNFQ1VSSVRZLVRFU1QgU1VNTUFSWSBwYXNzPSR7cmVzdWx0cy5sZW5ndGggLSBmYWlsZWR9LyR7cmVzdWx0cy5sZW5ndGh9YCk7XHJcbiAgICBhcHAuZXhpdChmYWlsZWQgPT09IDAgPyAwIDogMSk7XHJcbiAgfVxyXG5cclxuICAvLyBcdTkwMDBcdTUxRkE6XHU0RjE4XHU5NkM1XHU1MDVDXHU2QjYyXHU4MUVBXHU1REYxIHNwYXduIFx1NzY4NCBob3N0KHNodXRkb3duIFx1N0FFRlx1NzBCOSBcdTIxOTIgXHU1MTVDXHU1RTk1XHU1M0VBIGtpbGwgXHU4MUVBXHU1REYxXHU3Njg0XHU1M0U1XHU2N0M0KVxyXG4gIGFwcC5vbignYmVmb3JlLXF1aXQnLCAoZSkgPT4ge1xyXG4gICAgaWYgKHN1cGVydmlzb3IgIT09IG51bGwgJiYgc3VwZXJ2aXNvci5zdGF0ZSAhPT0gJ3N0b3BwZWQnKSB7XHJcbiAgICAgIGUucHJldmVudERlZmF1bHQoKTtcclxuICAgICAgc3NlQWJvcnQ/LmFib3J0KCk7XHJcbiAgICAgIHZvaWQgc3VwZXJ2aXNvci5zdG9wKCkuZmluYWxseSgoKSA9PiBhcHAucXVpdCgpKTtcclxuICAgIH1cclxuICB9KTtcclxuICBhcHAub24oJ3dpbmRvdy1hbGwtY2xvc2VkJywgKCkgPT4ge1xyXG4gICAgaWYgKHByb2Nlc3MucGxhdGZvcm0gIT09ICdkYXJ3aW4nKSBhcHAucXVpdCgpO1xyXG4gIH0pO1xyXG59XHJcbiIsICIvKipcclxuICogRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yIFx1MjAxNCBobWhhcm5lc3MgaG9zdCBcdThGREJcdTdBMEJcdTc2ODRcdTc1MUZcdTU0N0RcdTU0NjhcdTY3MUZcdTcyQjZcdTYwMDFcdTY3M0EoQURSLTAwMylcdTMwMDJcclxuICpcclxuICogXHU1Qjg5XHU1MTY4XHU0RTBEXHU1M0Q4XHU5MUNGOlxyXG4gKiAgLSBcdTUzRUFcdTdFRDFcdTVCOUEvXHU2M0EyXHU2RDRCIDEyNy4wLjAuMTtob3N0IFx1NEY3Rlx1NzUyOFx1NjRDRFx1NEY1Q1x1N0NGQlx1N0VERlx1NTIwNlx1OTE0RFx1N0FFRlx1NTNFMyhwb3J0IDApLFx1NUI5RVx1OTY0NVx1N0FFRlx1NTNFM1xyXG4gKiAgICBcdTc1MzEgaG9zdCBcdTc2ODQgc3Rkb3V0IFx1NUYxNVx1NUJGQ1x1ODg0Q1x1NTZERVx1NEYyMChIb3N0UmVhZHlMaW5lKVx1MzAwMlxyXG4gKiAgLSBcdTlBRDhcdTcxQjUgdG9rZW4gXHU1M0VBXHU5MDFBXHU4RkM3XHU1QjUwXHU4RkRCXHU3QTBCXHU3M0FGXHU1ODgzXHU1M0Q4XHU5MUNGXHU0RjIwXHU5MDEyLFx1N0VERFx1NEUwRFx1OEZEQiBVUkwvXHU2NUU1XHU1RkQ3L0lQQyBcdTY2MEVcdTY1ODdcdThEMUZcdThGN0RcdTMwMDJcclxuICogIC0gXHU1M0VBXHU1MDVDXHU2QjYyXHU2NzJDIHN1cGVydmlzb3Igc3Bhd24gXHU3Njg0XHU4RkRCXHU3QTBCXHU1M0U1XHU2N0M0O1x1N0VERFx1NEUwRFx1NjMwOVx1OEZEQlx1N0EwQlx1NTQwRCBraWxsXHUzMDAyXHJcbiAqICAtIGhvc3QgY3Jhc2ggXHU1NDBFXHU2NzA5XHU5NjUwXHU5MUNEXHU1NDJGO1x1OTFDRFx1NTQyRlx1NEUwRFx1OTFDRFx1NjUzRVx1NEVGQlx1NEY1NVx1NzUyOFx1NjIzN1x1NTJBOFx1NEY1QyhcdTk3NUVcdTVFNDJcdTdCNDlcdTUyQThcdTRGNUNcdTc1MzFcdTc1MjhcdTYyMzdcdTc4NkVcdThCQTQpXHUzMDAyXHJcbiAqL1xyXG5pbXBvcnQgeyBzcGF3biwgdHlwZSBDaGlsZFByb2Nlc3MgfSBmcm9tICdub2RlOmNoaWxkX3Byb2Nlc3MnO1xyXG5pbXBvcnQgeyBjcmVhdGVJbnRlcmZhY2UgfSBmcm9tICdub2RlOnJlYWRsaW5lJztcclxuaW1wb3J0IHsgcmFuZG9tQnl0ZXMgfSBmcm9tICdub2RlOmNyeXB0byc7XHJcbmltcG9ydCB7IGRlc2t0b3BFcnJvciwgaXNEZXNrdG9wRXJyb3IsIHR5cGUgRGVza3RvcEVycm9yIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyc7XHJcblxyXG5leHBvcnQgdHlwZSBIb3N0U3RhdGUgPVxyXG4gIHwgJ3N0b3BwZWQnXHJcbiAgfCAnc3RhcnRpbmcnXHJcbiAgfCAncmVhZHknXHJcbiAgfCAnZGlzY29ubmVjdGVkJ1xyXG4gIHwgJ3Jlc3RhcnRpbmcnXHJcbiAgfCAnc3RvcHBpbmcnXHJcbiAgfCAnZmFpbGVkJztcclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgSG9zdFNwZWMge1xyXG4gIC8qKiBcdTUzRUZcdTYyNjdcdTg4NENcdTY1ODdcdTRFRjYoXHU5MDFBXHU1RTM4IHByb2Nlc3MuZXhlY1BhdGgpXHUzMDAyICovXHJcbiAgY29tbWFuZDogc3RyaW5nO1xyXG4gIGFyZ3M6IHN0cmluZ1tdO1xyXG4gIGN3ZD86IHN0cmluZztcclxuICAvKiogXHU5ODlEXHU1OTE2XHU3M0FGXHU1ODgzXHU1M0Q4XHU5MUNGKFx1NEYxQVx1NEUwRSBwcm9jZXNzLmVudiBcdTU0MDhcdTVFNzYpXHUzMDAyICovXHJcbiAgZW52PzogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcclxufVxyXG5cclxuZXhwb3J0IGludGVyZmFjZSBTdXBlcnZpc29yT3B0aW9ucyB7XHJcbiAgLyoqIFx1NjcxRlx1NjcxQiBob3N0IFx1NjgyMVx1OUE4Q1x1NzY4NCBiZWFyZXIgdG9rZW47XHU0RTBEXHU0RjIwXHU1MjE5XHU2QkNGXHU2QjIxIHN0YXJ0IFx1NzUxRlx1NjIxMFx1OUFEOFx1NzFCNVx1OTY4Rlx1NjczQVx1NTAzQ1x1MzAwMiAqL1xyXG4gIHRva2VuPzogc3RyaW5nO1xyXG4gIG1heFJlc3RhcnRzPzogbnVtYmVyO1xyXG4gIHN0YXJ0VGltZW91dE1zPzogbnVtYmVyO1xyXG4gIGdyYWNlZnVsU2h1dGRvd25Ncz86IG51bWJlcjtcclxuICBvblN0YXRlQ2hhbmdlPyhzdGF0ZTogSG9zdFN0YXRlLCBpbmZvOiB7IHJlc3RhcnRDb3VudDogbnVtYmVyOyBsYXN0RXJyb3I/OiBzdHJpbmcgfSk6IHZvaWQ7XHJcbiAgLyoqIFx1NkJDRlx1NkIyMSBob3N0IFx1NUMzMVx1N0VFQShcdTU0MkIgY3Jhc2ggXHU4MUVBXHU2MTA4XHU1NDBFXHU3Njg0XHU5MUNEXHU1NDJGKVx1OTBGRFx1NEYxQVx1ODlFNlx1NTNEMSxcdTY0M0FcdTVFMjZcdTdBRUZcdTcwQjkoXHU1NDJCIHRva2VuLFxyXG4gICAqICBcdTRFQzVcdTRGOUJcdTU0MENcdTRGRTFcdTRFRkJcdTU3REZcdTc2ODRcdTVCQkZcdTRFM0JcdThGREJcdTdBMEJcdTkxQ0RcdTVFRkFcdTY4NjVcdTVCQTJcdTYyMzdcdTdBRUY7XHU0RTBEXHU4OTgxXHU4REU4XHU4RkRCIHJlbmRlcmVyKVx1MzAwMiAqL1xyXG4gIG9uUmVhZHk/KGVuZHBvaW50OiBIb3N0RW5kcG9pbnQpOiB2b2lkO1xyXG59XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIEhvc3RFbmRwb2ludCB7XHJcbiAgcG9ydDogbnVtYmVyO1xyXG4gIHZlcnNpb246IHN0cmluZztcclxuICB0b2tlbjogc3RyaW5nO1xyXG59XHJcblxyXG4vKiogSG9zdFJlYWR5TGluZSBcdTc2ODRcdTdDN0JcdTU3OEJcdTVCODhcdTUzNkJcdTRFQ0UgY29udHJhY3RzIFx1NUYxNVx1NTE2NSxcdTkwN0ZcdTUxNERcdTUzQ0NcdTVCOUVcdTczQjBcdTMwMDIgKi9cclxuaW1wb3J0IHsgaXNIb3N0UmVhZHlMaW5lIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyc7XHJcblxyXG4vLyA0NXM6aG1oYXJuZXNzIFx1NzcxRlx1NUI5RVx1NTE2NVx1NTNFM1x1N0VDRiB0c3ggXHU1MUI3XHU3RjE2XHU4QkQxXHU2NTc0XHU1OTU3IENMSSxcdTY3M0FcdTU2NjhcdTlBRDhcdThEMUZcdThGN0RcdTY1RjZcdTUzRUZcdThEODUgMjBzXHJcbi8vICgyMDI2LTEwLTExIFx1OEZERVx1N0VFRFx1OUE4Q1x1NjUzNlx1NEUyRFx1OTVGNFx1NkI0N1x1NjAyNyBIT1NUX05PVF9SRUFEWSBcdTc2ODRcdTY4MzlcdTU2RTA7XHU3QTdBXHU5NUYyXHU1QjlFXHU2RDRCIDZzKVx1MzAwMlxyXG5jb25zdCBERUZBVUxUX1NUQVJUX1RJTUVPVVRfTVMgPSA0NV8wMDA7XHJcbmNvbnN0IERFRkFVTFRfTUFYX1JFU1RBUlRTID0gMztcclxuY29uc3QgREVGQVVMVF9HUkFDRUZVTF9NUyA9IDVfMDAwO1xyXG5cclxuZXhwb3J0IGNsYXNzIERlc2t0b3BSdW50aW1lU3VwZXJ2aXNvciB7XHJcbiAgcHJpdmF0ZSBjaGlsZDogQ2hpbGRQcm9jZXNzIHwgbnVsbCA9IG51bGw7XHJcbiAgcHJpdmF0ZSBfc3RhdGU6IEhvc3RTdGF0ZSA9ICdzdG9wcGVkJztcclxuICBwcml2YXRlIHJlc3RhcnRDb3VudCA9IDA7XHJcbiAgcHJpdmF0ZSBsYXN0RXJyb3IgPSAnJztcclxuICBwcml2YXRlIHN0b3BwaW5nID0gZmFsc2U7XHJcbiAgcHJpdmF0ZSByZWFkb25seSB0b2tlbjogc3RyaW5nO1xyXG4gIHByaXZhdGUgcmVhZG9ubHkgb3B0czogUmVxdWlyZWQ8UGljazxTdXBlcnZpc29yT3B0aW9ucywgJ21heFJlc3RhcnRzJyB8ICdzdGFydFRpbWVvdXRNcycgfCAnZ3JhY2VmdWxTaHV0ZG93bk1zJz4+ICYgU3VwZXJ2aXNvck9wdGlvbnM7XHJcbiAgcHJpdmF0ZSBleGl0V2FpdGVyczogQXJyYXk8KCkgPT4gdm9pZD4gPSBbXTtcclxuXHJcbiAgY29uc3RydWN0b3IoXHJcbiAgICBwcml2YXRlIHJlYWRvbmx5IHNwZWM6IEhvc3RTcGVjLFxyXG4gICAgb3B0czogU3VwZXJ2aXNvck9wdGlvbnMgPSB7fSxcclxuICApIHtcclxuICAgIHRoaXMudG9rZW4gPSBvcHRzLnRva2VuID8/IHJhbmRvbUJ5dGVzKDMyKS50b1N0cmluZygnYmFzZTY0dXJsJyk7XHJcbiAgICB0aGlzLm9wdHMgPSB7XHJcbiAgICAgIG1heFJlc3RhcnRzOiBvcHRzLm1heFJlc3RhcnRzID8/IERFRkFVTFRfTUFYX1JFU1RBUlRTLFxyXG4gICAgICBzdGFydFRpbWVvdXRNczogb3B0cy5zdGFydFRpbWVvdXRNcyA/PyBERUZBVUxUX1NUQVJUX1RJTUVPVVRfTVMsXHJcbiAgICAgIGdyYWNlZnVsU2h1dGRvd25Nczogb3B0cy5ncmFjZWZ1bFNodXRkb3duTXMgPz8gREVGQVVMVF9HUkFDRUZVTF9NUyxcclxuICAgICAgLi4ub3B0cyxcclxuICAgIH07XHJcbiAgfVxyXG5cclxuICBnZXQgc3RhdGUoKTogSG9zdFN0YXRlIHtcclxuICAgIHJldHVybiB0aGlzLl9zdGF0ZTtcclxuICB9XHJcblxyXG4gIGdldCByZXN0YXJ0c1VzZWQoKTogbnVtYmVyIHtcclxuICAgIHJldHVybiB0aGlzLnJlc3RhcnRDb3VudDtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgc2V0U3RhdGUoczogSG9zdFN0YXRlLCBlcnI/OiBzdHJpbmcpOiB2b2lkIHtcclxuICAgIHRoaXMuX3N0YXRlID0gcztcclxuICAgIGlmIChlcnIgIT09IHVuZGVmaW5lZCkgdGhpcy5sYXN0RXJyb3IgPSBlcnI7XHJcbiAgICBjb25zdCBpbmZvOiB7IHJlc3RhcnRDb3VudDogbnVtYmVyOyBsYXN0RXJyb3I/OiBzdHJpbmcgfSA9IHsgcmVzdGFydENvdW50OiB0aGlzLnJlc3RhcnRDb3VudCB9O1xyXG4gICAgaWYgKHRoaXMubGFzdEVycm9yICE9PSAnJykgaW5mby5sYXN0RXJyb3IgPSB0aGlzLmxhc3RFcnJvcjtcclxuICAgIHRoaXMub3B0cy5vblN0YXRlQ2hhbmdlPy4ocywgaW5mbyk7XHJcbiAgfVxyXG5cclxuICAvKiogXHU1NDJGXHU1MkE4IGhvc3QgXHU1RTc2XHU3QjQ5XHU1Rjg1IHJlYWR5KFx1NUYxNVx1NUJGQ1x1ODg0QyArIFx1NUUyNiB0b2tlbiBcdTc2ODRcdTUwNjVcdTVFQjdcdTYzQTJcdTZENEIpXHUzMDAyICovXHJcbiAgYXN5bmMgc3RhcnQoKTogUHJvbWlzZTxIb3N0RW5kcG9pbnQ+IHtcclxuICAgIGlmICh0aGlzLl9zdGF0ZSA9PT0gJ3JlYWR5JyB8fCB0aGlzLl9zdGF0ZSA9PT0gJ3N0YXJ0aW5nJykge1xyXG4gICAgICB0aHJvdyBkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYHN1cGVydmlzb3IgYWxyZWFkeSAke3RoaXMuX3N0YXRlfWApO1xyXG4gICAgfVxyXG4gICAgdGhpcy5yZXN0YXJ0Q291bnQgPSAwO1xyXG4gICAgdGhpcy5zdG9wcGluZyA9IGZhbHNlO1xyXG4gICAgcmV0dXJuIHRoaXMubGF1bmNoKCk7XHJcbiAgfVxyXG5cclxuICBwcml2YXRlIGFzeW5jIGxhdW5jaCgpOiBQcm9taXNlPEhvc3RFbmRwb2ludD4ge1xyXG4gICAgdGhpcy5zZXRTdGF0ZSgnc3RhcnRpbmcnKTtcclxuICAgIGNvbnN0IGNoaWxkID0gc3Bhd24odGhpcy5zcGVjLmNvbW1hbmQsIHRoaXMuc3BlYy5hcmdzLCB7XHJcbiAgICAgIGN3ZDogdGhpcy5zcGVjLmN3ZCxcclxuICAgICAgZW52OiB7XHJcbiAgICAgICAgLi4ucHJvY2Vzcy5lbnYsXHJcbiAgICAgICAgLi4udGhpcy5zcGVjLmVudixcclxuICAgICAgICBITUhfREVTS1RPUF9UT0tFTjogdGhpcy50b2tlbixcclxuICAgICAgfSxcclxuICAgICAgc3RkaW86IFsnaWdub3JlJywgJ3BpcGUnLCAncGlwZSddLFxyXG4gICAgICB3aW5kb3dzSGlkZTogdHJ1ZSxcclxuICAgIH0pO1xyXG4gICAgdGhpcy5jaGlsZCA9IGNoaWxkO1xyXG5cclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IGVuZHBvaW50ID0gYXdhaXQgdGhpcy5hd2FpdFJlYWR5KGNoaWxkKTtcclxuICAgICAgdGhpcy5jdXJyZW50RW5kcG9pbnQgPSB7IHBvcnQ6IGVuZHBvaW50LnBvcnQsIHZlcnNpb246IGVuZHBvaW50LnZlcnNpb24gfTtcclxuICAgICAgdGhpcy5zZXRTdGF0ZSgncmVhZHknKTtcclxuICAgICAgdGhpcy5vcHRzLm9uUmVhZHk/LihlbmRwb2ludCk7XHJcbiAgICAgIC8vIHJlYWR5IFx1NEU0Qlx1NTQwRVx1OEZEQlx1N0EwQlx1NkI3Qlx1NEVBMSA9IFx1NjEwRlx1NTkxNlx1OTAwMFx1NTFGQSBcdTIxOTIgXHU2NzA5XHU5NjUwXHU5MUNEXHU1NDJGXHJcbiAgICAgIGNoaWxkLm9uY2UoJ2V4aXQnLCAoKSA9PiB7XHJcbiAgICAgICAgdGhpcy5leGl0V2FpdGVycy5mb3JFYWNoKCh3KSA9PiB3KCkpO1xyXG4gICAgICAgIHRoaXMuZXhpdFdhaXRlcnMgPSBbXTtcclxuICAgICAgICB0aGlzLm9uVW5leHBlY3RlZEV4aXQoKTtcclxuICAgICAgfSk7XHJcbiAgICAgIHJldHVybiBlbmRwb2ludDtcclxuICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICBpZiAoIWNoaWxkLmtpbGxlZCkgY2hpbGQua2lsbCgpO1xyXG4gICAgICBpZiAodGhpcy5jaGlsZCA9PT0gY2hpbGQpIHRoaXMuY2hpbGQgPSBudWxsO1xyXG4gICAgICB0aHJvdyBlcnI7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvKiogXHU0RUNFIHN0ZG91dCBcdTYyN0UgSG9zdFJlYWR5TGluZSxcdTcxMzZcdTU0MEVcdTUwNjVcdTVFQjdcdTYzQTJcdTZENEJcdTMwMDIgKi9cclxuICBwcml2YXRlIGF3YWl0UmVhZHkoY2hpbGQ6IENoaWxkUHJvY2Vzcyk6IFByb21pc2U8SG9zdEVuZHBvaW50PiB7XHJcbiAgICByZXR1cm4gbmV3IFByb21pc2U8SG9zdEVuZHBvaW50PigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XHJcbiAgICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XHJcbiAgICAgICAgcmVqZWN0KGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgaG9zdCBkaWQgbm90IHNpZ25hbCByZWFkeSB3aXRoaW4gJHt0aGlzLm9wdHMuc3RhcnRUaW1lb3V0TXN9bXNgLCB7IHJldHJ5YWJsZTogdHJ1ZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcclxuICAgICAgfSwgdGhpcy5vcHRzLnN0YXJ0VGltZW91dE1zKTtcclxuXHJcbiAgICAgIGNvbnN0IGRvbmUgPSAoZm46ICgpID0+IHZvaWQpOiB2b2lkID0+IHtcclxuICAgICAgICBjbGVhclRpbWVvdXQodGltZXIpO1xyXG4gICAgICAgIGZuKCk7XHJcbiAgICAgIH07XHJcblxyXG4gICAgICBpZiAoIWNoaWxkLnN0ZG91dCkge1xyXG4gICAgICAgIGRvbmUoKCkgPT4gcmVqZWN0KGRlc2t0b3BFcnJvcignUlVOVElNRV9DUkFTSEVEJywgJ2hvc3Qgc3Bhd25lZCB3aXRob3V0IHN0ZG91dCBwaXBlJykpKTtcclxuICAgICAgICByZXR1cm47XHJcbiAgICAgIH1cclxuXHJcbiAgICAgIGNvbnN0IHJsID0gY3JlYXRlSW50ZXJmYWNlKHsgaW5wdXQ6IGNoaWxkLnN0ZG91dCB9KTtcclxuICAgICAgY29uc3Qgb25MaW5lID0gKGxpbmU6IHN0cmluZyk6IHZvaWQgPT4ge1xyXG4gICAgICAgIGxldCBwYXJzZWQ6IHVua25vd247XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgIHBhcnNlZCA9IEpTT04ucGFyc2UobGluZSk7XHJcbiAgICAgICAgfSBjYXRjaCB7XHJcbiAgICAgICAgICByZXR1cm47IC8vIGhvc3QgXHU3Njg0XHU2NjZFXHU5MDFBXHU2NUU1XHU1RkQ3XHU4ODRDLFx1NUZGRFx1NzU2NVxyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoaXNIb3N0UmVhZHlMaW5lKHBhcnNlZCkpIHtcclxuICAgICAgICAgIHJsLmNsb3NlKCk7XHJcbiAgICAgICAgICB2b2lkIHRoaXMucHJvYmVBbmRSZW1lbWJlcihwYXJzZWQucG9ydCwgcGFyc2VkLnZlcnNpb24pXHJcbiAgICAgICAgICAgIC50aGVuKChlbmRwb2ludCkgPT4gZG9uZSgoKSA9PiByZXNvbHZlKGVuZHBvaW50KSkpXHJcbiAgICAgICAgICAgIC5jYXRjaCgoZXJyOiB1bmtub3duKSA9PiBkb25lKCgpID0+IHJlamVjdChlcnIpKSk7XHJcbiAgICAgICAgfVxyXG4gICAgICB9O1xyXG4gICAgICBybC5vbignbGluZScsIG9uTGluZSk7XHJcblxyXG4gICAgICBjaGlsZC5vbmNlKCdleGl0JywgKGNvZGUpID0+IHtcclxuICAgICAgICBkb25lKCgpID0+IHJlamVjdChkZXNrdG9wRXJyb3IoJ1JVTlRJTUVfQ1JBU0hFRCcsIGBob3N0IGV4aXRlZCBkdXJpbmcgc3RhcnR1cCAoY29kZSAke2NvZGUgPz8gJ251bGwnfSlgLCB7IHJldHJ5YWJsZTogZmFsc2UsIHJlY292ZXJ5QWN0aW9uOiAnT1BFTl9MT0dTJyB9KSkpO1xyXG4gICAgICB9KTtcclxuICAgIH0pO1xyXG4gIH1cclxuXHJcbiAgLyoqIFx1NUUyNiB0b2tlbiBcdTc2ODRcdTUwNjVcdTVFQjdcdTYzQTJcdTZENEI6R0VUIC9hcGkvc3RhdGVcdTMwMDI0MDEgXHUyMTkyIEFVVEhfRkFJTEVEKFx1NEUwRFx1OTFDRFx1OEJENSlcdTMwMDIgKi9cclxuICBwcml2YXRlIGFzeW5jIHByb2JlKHBvcnQ6IG51bWJlciwgdmVyc2lvbjogc3RyaW5nKTogUHJvbWlzZTxIb3N0RW5kcG9pbnQ+IHtcclxuICAgIGxldCByZXM6IFJlc3BvbnNlO1xyXG4gICAgdHJ5IHtcclxuICAgICAgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9hcGkvc3RhdGVgLCB7XHJcbiAgICAgICAgaGVhZGVyczogeyAneC1obWgta2V5JzogdGhpcy50b2tlbiB9LFxyXG4gICAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCgzXzAwMCksXHJcbiAgICAgIH0pO1xyXG4gICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgIHRocm93IGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgaGVhbHRoIHByb2JlIGZhaWxlZDogJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxNjApfWAsIHsgcmV0cnlhYmxlOiB0cnVlIH0pO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSB8fCByZXMuc3RhdHVzID09PSA0MDMpIHtcclxuICAgICAgdGhyb3cgZGVza3RvcEVycm9yKCdBVVRIX0ZBSUxFRCcsIGBob3N0IHJlamVjdGVkIHRoZSBzZXNzaW9uIHRva2VuIChIVFRQICR7cmVzLnN0YXR1c30pYCwgeyByZXRyeWFibGU6IGZhbHNlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSk7XHJcbiAgICB9XHJcbiAgICBpZiAoIXJlcy5vaykge1xyXG4gICAgICB0aHJvdyBkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYGhlYWx0aCBwcm9iZSBIVFRQICR7cmVzLnN0YXR1c31gLCB7IHJldHJ5YWJsZTogdHJ1ZSB9KTtcclxuICAgIH1cclxuICAgIHJldHVybiB7IHBvcnQsIHZlcnNpb24sIHRva2VuOiB0aGlzLnRva2VuIH07XHJcbiAgfVxyXG5cclxuICBwcml2YXRlIG9uVW5leHBlY3RlZEV4aXQoKTogdm9pZCB7XHJcbiAgICBpZiAodGhpcy5zdG9wcGluZyB8fCB0aGlzLl9zdGF0ZSA9PT0gJ3N0b3BwZWQnIHx8IHRoaXMuX3N0YXRlID09PSAnc3RvcHBpbmcnKSByZXR1cm47XHJcbiAgICB0aGlzLmNoaWxkID0gbnVsbDtcclxuICAgIGlmICh0aGlzLnJlc3RhcnRDb3VudCA8IHRoaXMub3B0cy5tYXhSZXN0YXJ0cykge1xyXG4gICAgICB0aGlzLnJlc3RhcnRDb3VudCArPSAxO1xyXG4gICAgICB0aGlzLnNldFN0YXRlKCdyZXN0YXJ0aW5nJyk7XHJcbiAgICAgIHZvaWQgdGhpcy5sYXVuY2goKS5jYXRjaCgoKSA9PiB7XHJcbiAgICAgICAgLy8gXHU5MUNEXHU1NDJGXHU1QzFEXHU4QkQ1XHU1OTMxXHU4RDI1KFx1NTQyRlx1NTJBOFx1NTM3M1x1NUQyOS9cdThEODVcdTY1RjYvXHU2MkQyXHU4QkE0KTpcdTdFRTdcdTdFRURcdTZEODhcdTgwMTdcdTkxQ0RcdTU0MkZcdTZCMjFcdTY1NzBcdTc2RjRcdTUyMzBcdTY1M0VcdTVGMDNcclxuICAgICAgICB0aGlzLnJldHJ5T3JGYWlsKCk7XHJcbiAgICAgIH0pO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgdGhpcy5zZXRTdGF0ZSgnZmFpbGVkJywgYGhvc3QgZXhpdGVkIHVuZXhwZWN0ZWRseSAke3RoaXMucmVzdGFydENvdW50ICsgMX0gdGltZXM7IGdpdmluZyB1cGApO1xyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgcHJpdmF0ZSByZXRyeU9yRmFpbCgpOiB2b2lkIHtcclxuICAgIGlmICh0aGlzLnN0b3BwaW5nIHx8IHRoaXMuX3N0YXRlID09PSAnc3RvcHBlZCcgfHwgdGhpcy5fc3RhdGUgPT09ICdzdG9wcGluZycpIHJldHVybjtcclxuICAgIGlmICh0aGlzLnJlc3RhcnRDb3VudCA8IHRoaXMub3B0cy5tYXhSZXN0YXJ0cykge1xyXG4gICAgICB0aGlzLnJlc3RhcnRDb3VudCArPSAxO1xyXG4gICAgICB0aGlzLnNldFN0YXRlKCdyZXN0YXJ0aW5nJyk7XHJcbiAgICAgIHZvaWQgdGhpcy5sYXVuY2goKS5jYXRjaCgoKSA9PiB0aGlzLnJldHJ5T3JGYWlsKCkpO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgdGhpcy5zZXRTdGF0ZSgnZmFpbGVkJywgYGhvc3QgZmFpbGVkIHRvIHN0YXkgdXAgYWZ0ZXIgJHt0aGlzLnJlc3RhcnRDb3VudH0gcmVzdGFydCBhdHRlbXB0c2ApO1xyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgLyoqIFx1NEYxOFx1OTZDNVx1NTA1Q1x1NkI2MjpcdTUxNDggSFRUUCBzaHV0ZG93bixcdThEODVcdTY1RjZcdTYyNERcdTVCRjlcdTY3MkNcdThGREJcdTdBMEJcdTUzRTVcdTY3QzQga2lsbFx1MzAwMiAqL1xyXG4gIGFzeW5jIHN0b3AoKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICB0aGlzLnN0b3BwaW5nID0gdHJ1ZTtcclxuICAgIGlmICh0aGlzLl9zdGF0ZSA9PT0gJ3N0b3BwZWQnKSByZXR1cm47XHJcbiAgICB0aGlzLnNldFN0YXRlKCdzdG9wcGluZycpO1xyXG4gICAgY29uc3QgY2hpbGQgPSB0aGlzLmNoaWxkO1xyXG4gICAgdGhpcy5jaGlsZCA9IG51bGw7XHJcbiAgICB0aGlzLmN1cnJlbnRFbmRwb2ludCA9IG51bGw7XHJcbiAgICBpZiAoIWNoaWxkKSB7XHJcbiAgICAgIHRoaXMuc2V0U3RhdGUoJ3N0b3BwZWQnKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgY29uc3QgZXhpdGVkID0gbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUpID0+IHtcclxuICAgICAgaWYgKGNoaWxkLmV4aXRDb2RlICE9PSBudWxsIHx8IGNoaWxkLnNpZ25hbENvZGUgIT09IG51bGwpIHJlc29sdmUoKTtcclxuICAgICAgZWxzZSB7XHJcbiAgICAgICAgY29uc3QgdyA9ICgpOiB2b2lkID0+IHJlc29sdmUoKTtcclxuICAgICAgICB0aGlzLmV4aXRXYWl0ZXJzLnB1c2godyk7XHJcbiAgICAgICAgY2hpbGQub25jZSgnZXhpdCcsIHcpO1xyXG4gICAgICB9XHJcbiAgICB9KTtcclxuICAgIC8vIFx1NURGMlx1NzdFNVx1N0FFRlx1NTNFM1x1NjI0RFx1NUMxRFx1OEJENSBIVFRQIFx1NEYxOFx1OTZDNVx1NTE3M1x1OTVFRDtcdTY3MkFcdTc3RTVcdTdBRUZcdTUzRTNcdTc2RjRcdTYzQTVcdThENzAga2lsbCBcdTUxNUNcdTVFOTVcclxuICAgIGlmICh0aGlzLmxhc3RFbmRwb2ludCAhPT0gbnVsbCkge1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7dGhpcy5sYXN0RW5kcG9pbnR9L2FwaS9kZXNrdG9wL3NodXRkb3duYCwge1xyXG4gICAgICAgICAgbWV0aG9kOiAnUE9TVCcsXHJcbiAgICAgICAgICBoZWFkZXJzOiB7ICd4LWhtaC1rZXknOiB0aGlzLnRva2VuIH0sXHJcbiAgICAgICAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoMV8wMDApLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICB9IGNhdGNoIHtcclxuICAgICAgICAvLyBob3N0IFx1NURGMlx1NkI3Qlx1NjIxNlx1NEUwRFx1NUU5NFx1N0I1NDpcdThENzAga2lsbCBcdTUxNUNcdTVFOTVcclxuICAgICAgfVxyXG4gICAgfVxyXG4gICAgY29uc3QgZ3JhY2VmdWwgPSBhd2FpdCBQcm9taXNlLnJhY2UoW1xyXG4gICAgICBleGl0ZWQudGhlbigoKSA9PiB0cnVlKSxcclxuICAgICAgbmV3IFByb21pc2U8Ym9vbGVhbj4oKHJlc29sdmUpID0+IHNldFRpbWVvdXQoKCkgPT4gcmVzb2x2ZShmYWxzZSksIHRoaXMub3B0cy5ncmFjZWZ1bFNodXRkb3duTXMpKSxcclxuICAgIF0pO1xyXG4gICAgaWYgKCFncmFjZWZ1bCAmJiBjaGlsZC5leGl0Q29kZSA9PT0gbnVsbCAmJiBjaGlsZC5zaWduYWxDb2RlID09PSBudWxsKSB7XHJcbiAgICAgIGNoaWxkLmtpbGwoKTsgLy8gXHU1M0VBXHU2NzQwXHU4MUVBXHU1REYxXHU2MzAxXHU2NzA5XHU3Njg0XHU1M0U1XHU2N0M0LFx1N0VERFx1NEUwRFx1NjMwOVx1OEZEQlx1N0EwQlx1NTQwRFxyXG4gICAgfVxyXG4gICAgYXdhaXQgZXhpdGVkLmNhdGNoKCgpID0+IHVuZGVmaW5lZCk7XHJcbiAgICB0aGlzLnNldFN0YXRlKCdzdG9wcGVkJyk7XHJcbiAgfVxyXG5cclxuICBwcml2YXRlIGxhc3RFbmRwb2ludDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XHJcbiAgcHJpdmF0ZSBjdXJyZW50RW5kcG9pbnQ6IHsgcG9ydDogbnVtYmVyOyB2ZXJzaW9uOiBzdHJpbmcgfSB8IG51bGwgPSBudWxsO1xyXG5cclxuICAvKiogXHU1RjUzXHU1MjREIGhvc3QgXHU3QUVGXHU3MEI5KHJlYWR5IFx1NTQwRVx1NjcwOVx1NTAzQztcdTRFMERcdTU0MkIgdG9rZW4pXHUzMDAyICovXHJcbiAgZ2V0IGVuZHBvaW50KCk6IHsgcG9ydDogbnVtYmVyOyB2ZXJzaW9uOiBzdHJpbmcgfSB8IG51bGwge1xyXG4gICAgcmV0dXJuIHRoaXMuY3VycmVudEVuZHBvaW50O1xyXG4gIH1cclxuXHJcbiAgLyoqIFx1NjNBMlx1NkQ0Qlx1NjIxMFx1NTI5Rlx1NTQwRVx1OEJCMFx1NEY0Rlx1N0FFRlx1NTNFMyxcdTRGOUIgc3RvcCgpIFx1NzY4NFx1NEYxOFx1OTZDNVx1NTE3M1x1OTVFRFx1NEY3Rlx1NzUyOFx1MzAwMiAqL1xyXG4gIHByaXZhdGUgYXN5bmMgcHJvYmVBbmRSZW1lbWJlcihwb3J0OiBudW1iZXIsIHZlcnNpb246IHN0cmluZyk6IFByb21pc2U8SG9zdEVuZHBvaW50PiB7XHJcbiAgICBjb25zdCBlcCA9IGF3YWl0IHRoaXMucHJvYmUocG9ydCwgdmVyc2lvbik7XHJcbiAgICB0aGlzLmxhc3RFbmRwb2ludCA9IGVwLnBvcnQ7XHJcbiAgICByZXR1cm4gZXA7XHJcbiAgfVxyXG59XHJcblxyXG4vKiogXHU2MjhBXHU2NzJBXHU3N0U1XHU5NTE5XHU4QkVGXHU4OUM0XHU3RUE2XHU0RTNBIERlc2t0b3BFcnJvcihcdTVERjJcdTY2MkZcdTUyMTlcdTUzOUZcdTY4MzdcdThGRDRcdTU2REUpXHUzMDAyICovXHJcbmV4cG9ydCBmdW5jdGlvbiB0b0Rlc2t0b3BFcnJvcihlcnI6IHVua25vd24pOiBEZXNrdG9wRXJyb3Ige1xyXG4gIGlmIChpc0Rlc2t0b3BFcnJvcihlcnIpKSByZXR1cm4gZXJyO1xyXG4gIGNvbnN0IG1lc3NhZ2UgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XHJcbiAgcmV0dXJuIGRlc2t0b3BFcnJvcignUlVOVElNRV9DUkFTSEVEJywgbWVzc2FnZS5zbGljZSgwLCAzMDApLCB7IHJldHJ5YWJsZTogZmFsc2UgfSk7XHJcbn1cclxuIiwgIi8qKlxyXG4gKiBAaG1oLWRlc2t0b3AvY29udHJhY3RzIFx1MjAxNCBcdTRFOEJcdTRFRjZcdTRGRTFcdTVDMDEoXHU1RjAwXHU1M0QxXHU4QkExXHU1MjEyXHU2NTg3XHU2ODYzIDA0IFx1MDBBN1x1NEUwOSlcclxuICpcclxuICogXHU0RTAwXHU2NzYxIFVJIFx1NEU4Qlx1NEVGNlx1NzY4NFx1NTUyRlx1NEUwMFx1NUY2Mlx1NzJCNlx1MzAwMlx1NTI0RFx1N0FFRiByZWR1Y2VyIFx1NUZDNVx1OTg3Qlx1NjMwOSBzZXNzaW9uSWQvcnVuSWQvc2VxIFx1NTkwNFx1NzQwNjtcclxuICogXHU5MUNEXHU1OTBEIGV2ZW50SWQgXHU1RTQyXHU3QjQ5XHU0RTIyXHU1RjAzO3NlcSBcdTdGM0FcdTUzRTNcdTg5RTZcdTUzRDFcdTg4NjVcdTYyQzk7XHU5NzVFXHU1RTQyXHU3QjQ5XHU1MkE4XHU0RjVDXHU0RTBEXHU3NTMxIFNTRSBcdTgxRUFcdTUyQThcdTkxQ0RcdTUzRDFcdTMwMDJcclxuICovXHJcblxyXG5pbXBvcnQgdHlwZSB7IEFydGlmYWN0UmVmIH0gZnJvbSAnLi9kdG8udHMnO1xyXG5pbXBvcnQgdHlwZSB7IERlc2t0b3BFcnJvciB9IGZyb20gJy4vZXJyb3IudHMnO1xyXG5cclxuLyoqIFx1NEU4Qlx1NEVGNlx1NzlDRFx1N0M3QihcdTUyMjRcdTUyMkJcdTk1MkUpXHUzMDAyXHU2NUIwXHU1ODlFIGtpbmQgPSBzY2hlbWFWZXJzaW9uIFx1NTM0N1x1N0VBNyxcdTRFMERcdTUxNDFcdThCQjhcdTk3NTlcdTlFRDhcdTYyNjlcdTY3OUFcdTRFM0VcdTMwMDIgKi9cclxuZXhwb3J0IGNvbnN0IEVWRU5UX0tJTkRTID0gW1xyXG4gICdydW4uc3RhcnRlZCcsXHJcbiAgJ3BsYW4udXBkYXRlZCcsXHJcbiAgJ3Rvb2wuc3RhcnRlZCcsXHJcbiAgJ3Rvb2wuY29tcGxldGVkJyxcclxuICAnYXBwcm92YWwucmVxdWlyZWQnLFxyXG4gICd2ZXJpZmljYXRpb24udXBkYXRlZCcsXHJcbiAgJ2FydGlmYWN0LmNyZWF0ZWQnLFxyXG4gICdydW4uY29tcGxldGVkJyxcclxuICAncnVuLmZhaWxlZCcsXHJcbl0gYXMgY29uc3Q7XHJcblxyXG5leHBvcnQgdHlwZSBFdmVudEtpbmQgPSAodHlwZW9mIEVWRU5UX0tJTkRTKVtudW1iZXJdO1xyXG5cclxuZXhwb3J0IGNvbnN0IEVWRU5UX1NDSEVNQV9WRVJTSU9OID0gMTtcclxuZXhwb3J0IHR5cGUgRXZlbnRTY2hlbWFWZXJzaW9uID0gMTtcclxuXHJcbi8qKiBTU0UgXHU2RDQxXHU0RTBBXHU3Njg0XHU2QkNGXHU0RTAwXHU2NzYxXHU0RThCXHU0RUY2XHUzMDAyICovXHJcbmV4cG9ydCBpbnRlcmZhY2UgRXZlbnRFbnZlbG9wZTxUID0gdW5rbm93bj4ge1xyXG4gIHNjaGVtYVZlcnNpb246IEV2ZW50U2NoZW1hVmVyc2lvbjtcclxuICAvKiogXHU1MTY4XHU1QzQwXHU1NTJGXHU0RTAwO1x1OTFDRFx1OEZERS9cdTg4NjVcdTYyQzlcdTU0MEVcdTkxQ0RcdTU5MERcdTUxRkFcdTczQjBcdTY1RjZcdTYzQTVcdTY1MzZcdTY1QjlcdTVFNDJcdTdCNDlcdTRFMjJcdTVGMDNcdTMwMDIgKi9cclxuICBldmVudElkOiBzdHJpbmc7XHJcbiAgc2Vzc2lvbklkOiBzdHJpbmc7XHJcbiAgcnVuSWQ6IHN0cmluZztcclxuICAvKiogXHU0RjFBXHU4QkREXHU1MTg1XHU1MzU1XHU4QzAzXHU5MDEyXHU1ODlFO1x1N0YzQVx1NTNFM1x1NjEwRlx1NTQ3M1x1Nzc0MFx1NEUyMlx1NEU4Qlx1NEVGNixcdTk3MDBcdTg5ODFcdTg4NjVcdTYyQzlcdTMwMDIgKi9cclxuICBzZXE6IG51bWJlcjtcclxuICAvKiogUkZDMzMzOVx1MzAwMiAqL1xyXG4gIG9jY3VycmVkQXQ6IHN0cmluZztcclxuICBraW5kOiBFdmVudEtpbmQ7XHJcbiAgcGF5bG9hZDogVDtcclxufVxyXG5cclxuLyoqIHJ1bi5zdGFydGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXHJcbmV4cG9ydCBpbnRlcmZhY2UgUnVuU3RhcnRlZFBheWxvYWQge1xyXG4gIHRhc2s6IHN0cmluZztcclxuICBtb2RlOiAnYXNrJyB8ICdhdXRvJyB8ICd5b2xvJztcclxufVxyXG5cclxuLyoqIHBsYW4udXBkYXRlZCBcdTc2ODQgcGF5bG9hZChcdThCQTFcdTUyMTJcdTZCNjVcdTlBQTRcdTUyMTdcdTg4NjgsXHU2NzY1XHU4MUVBIHJ1bnRpbWUgXHU3Njg0XHU3RUQzXHU2Nzg0XHU1MzE2XHU4QkExXHU1MjEyLFx1NEUwRFx1NjYyRiBjaGFpbi1vZi10aG91Z2h0KVx1MzAwMiAqL1xyXG5leHBvcnQgaW50ZXJmYWNlIFBsYW5VcGRhdGVkUGF5bG9hZCB7XHJcbiAgc3RlcHM6IEFycmF5PHsgdGl0bGU6IHN0cmluZzsgc3RhdHVzOiAncGVuZGluZycgfCAnYWN0aXZlJyB8ICdkb25lJyB8ICdmYWlsZWQnIH0+O1xyXG59XHJcblxyXG4vKiogdG9vbC5zdGFydGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXHJcbmV4cG9ydCBpbnRlcmZhY2UgVG9vbFN0YXJ0ZWRQYXlsb2FkIHtcclxuICBuYW1lOiBzdHJpbmc7XHJcbiAgLyoqIFx1NTNDMlx1NjU3MFx1NEVFNVx1NjU4N1x1NjcyQ1x1NTQ0OFx1NzNCMCxcdTZFMzJcdTY3RDNcdTdBRUZcdTZDMzhcdTRFMEQgZXZhbDtcdTU5MjdcdTVCRjlcdThDNjFcdTc1MzEgcnVudGltZSBcdTYyMkFcdTY1QURcdTMwMDIgKi9cclxuICBhcmdzUHJldmlldzogc3RyaW5nO1xyXG59XHJcblxyXG4vKiogdG9vbC5jb21wbGV0ZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cclxuZXhwb3J0IGludGVyZmFjZSBUb29sQ29tcGxldGVkUGF5bG9hZCB7XHJcbiAgbmFtZTogc3RyaW5nO1xyXG4gIGlzRXJyb3I6IGJvb2xlYW47XHJcbiAgb3V0cHV0UHJldmlldzogc3RyaW5nO1xyXG59XHJcblxyXG4vKiogYXBwcm92YWwucmVxdWlyZWQgXHU3Njg0IHBheWxvYWRcdTMwMDJcdTVCQTFcdTYyNzlcdTY3NDNcdTVBMDFcdTU3MjggcnVudGltZSBcdTU0MEVcdTdBRUY7VUkgXHU1M0VBXHU2NjJGXHU4RjZDXHU4RkYwXHUzMDAyICovXHJcbmV4cG9ydCBpbnRlcmZhY2UgQXBwcm92YWxSZXF1aXJlZFBheWxvYWQge1xyXG4gIGFwcHJvdmFsSWQ6IHN0cmluZztcclxuICB0b29sOiBzdHJpbmc7XHJcbiAgYXJnc1ByZXZpZXc6IHN0cmluZztcclxuICAvKiogXHU1RjcxXHU1NENEXHU4MzAzXHU1NkY0L1x1OThDRVx1OTY2OVx1NzY4NFx1NEVCQVx1N0M3Qlx1NTNFRlx1OEJGQlx1OEJGNFx1NjYwRSxcdTc1MzEgcnVudGltZSBcdTc1MUZcdTYyMTBcdTMwMDIgKi9cclxuICByaXNrOiBzdHJpbmc7XHJcbn1cclxuXHJcbi8qKiB2ZXJpZmljYXRpb24udXBkYXRlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xyXG5leHBvcnQgaW50ZXJmYWNlIFZlcmlmaWNhdGlvblVwZGF0ZWRQYXlsb2FkIHtcclxuICBzdW1tYXJ5OiBzdHJpbmc7XHJcbiAgcGFzc2VkOiBib29sZWFuIHwgbnVsbDsgLy8gbnVsbCA9IFx1NjcyQVx1NzdFNS9cdThGREJcdTg4NENcdTRFMkQoTkVFRFMtREFUQSBcdTY1RjZcdTRFMERcdTUwNDdcdTU4NkIpXHJcbn1cclxuXHJcbi8qKiBhcnRpZmFjdC5jcmVhdGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXHJcbmV4cG9ydCBpbnRlcmZhY2UgQXJ0aWZhY3RDcmVhdGVkUGF5bG9hZCB7XHJcbiAgYXJ0aWZhY3Q6IEFydGlmYWN0UmVmO1xyXG59XHJcblxyXG4vKiogcnVuLmNvbXBsZXRlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xyXG5leHBvcnQgaW50ZXJmYWNlIFJ1bkNvbXBsZXRlZFBheWxvYWQge1xyXG4gIHRleHQ6IHN0cmluZztcclxuICB0dXJuczogbnVtYmVyO1xyXG4gIHRvb2xVc2VzOiBudW1iZXI7XHJcbiAgdXNhZ2U/OiB7IHByb21wdFRva2VuczogbnVtYmVyOyBjb21wbGV0aW9uVG9rZW5zOiBudW1iZXIgfTtcclxufVxyXG5cclxuLyoqIHJ1bi5mYWlsZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cclxuZXhwb3J0IGludGVyZmFjZSBSdW5GYWlsZWRQYXlsb2FkIHtcclxuICBlcnJvcjogRGVza3RvcEVycm9yO1xyXG59XHJcbiIsICIvKipcclxuICogQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyBcdTIwMTQgXHU3RUQzXHU2Nzg0XHU1MzE2XHU2ODRDXHU5NzYyXHU5NTE5XHU4QkVGKFx1NUYwMFx1NTNEMVx1OEJBMVx1NTIxMlx1NjU4N1x1Njg2MyAwNCBcdTAwQTdcdTRFMDkpXHUzMDAyXHJcbiAqXHJcbiAqIGhvc3Qtbm90LXJlYWR5IC8gYXV0aC1mYWlsZWQgLyBzdGFsZS12ZXJzaW9uIC8gcnVudGltZS1jcmFzaGVkIC9cclxuICogcG9ydC1iaW5kLWZhaWxlZCAvIHNjaGVtYS1taXNtYXRjaCBcdTVGQzVcdTk4N0JcdTY2MkZcdTdFRDNcdTY3ODRcdTUzMTZcdTk1MTlcdThCRUZcdTc4MDEsXHU1RTc2XHU2M0QwXHU0RjlCXHU0RTBCXHU0RTAwXHU2QjY1XHU1MkE4XHU0RjVDXHUzMDAyXHJcbiAqIG1lc3NhZ2UgXHU2NjJGXHU3RUFGXHU2NTg3XHU2NzJDLFx1NkUzMlx1NjdEM1x1N0FFRlx1NkMzOFx1NEUwRFx1NjI4QVx1NUI4M1x1NUY1MyBIVE1MXHUzMDAyXHJcbiAqL1xyXG5leHBvcnQgY29uc3QgRVJST1JfQ09ERVMgPSBbXHJcbiAgJ0hPU1RfTk9UX1JFQURZJyxcclxuICAnQVVUSF9GQUlMRUQnLFxyXG4gICdSVU5USU1FX0NSQVNIRUQnLFxyXG4gICdQT1JUX0JJTkRfRkFJTEVEJyxcclxuICAnU1RBTEVfVkVSU0lPTicsXHJcbiAgJ1NDSEVNQV9NSVNNQVRDSCcsXHJcbl0gYXMgY29uc3Q7XHJcblxyXG5leHBvcnQgdHlwZSBFcnJvckNvZGUgPSAodHlwZW9mIEVSUk9SX0NPREVTKVtudW1iZXJdO1xyXG5cclxuZXhwb3J0IGNvbnN0IFJFQ09WRVJZX0FDVElPTlMgPSBbJ1JFQ09OTkVDVCcsICdSRVNVTUUnLCAnRVhQT1JUJywgJ09QRU5fTE9HUyddIGFzIGNvbnN0O1xyXG5leHBvcnQgdHlwZSBSZWNvdmVyeUFjdGlvbiA9ICh0eXBlb2YgUkVDT1ZFUllfQUNUSU9OUylbbnVtYmVyXTtcclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgRGVza3RvcEVycm9yIHtcclxuICBjb2RlOiBFcnJvckNvZGU7XHJcbiAgLyoqIFx1N0VBRlx1NjU4N1x1NjcyQyxcdTZDMzhcdTRFMERcdTRGRTFcdTRFRkJcdTRFM0EgSFRNTFx1MzAwMiAqL1xyXG4gIG1lc3NhZ2U6IHN0cmluZztcclxuICByZXRyeWFibGU6IGJvb2xlYW47XHJcbiAgc2Vzc2lvbklkPzogc3RyaW5nO1xyXG4gIHJ1bklkPzogc3RyaW5nO1xyXG4gIHJlY292ZXJ5QWN0aW9uPzogUmVjb3ZlcnlBY3Rpb247XHJcbn1cclxuXHJcbi8qKiBcdTY3ODRcdTkwMjBcdTRFMDBcdTRFMkEgRGVza3RvcEVycm9yKGV4YWN0T3B0aW9uYWxQcm9wZXJ0eVR5cGVzIFx1NTNDQlx1NTk3RClcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGRlc2t0b3BFcnJvcihcclxuICBjb2RlOiBFcnJvckNvZGUsXHJcbiAgbWVzc2FnZTogc3RyaW5nLFxyXG4gIG9wdHM6IHsgcmV0cnlhYmxlPzogYm9vbGVhbjsgc2Vzc2lvbklkPzogc3RyaW5nOyBydW5JZD86IHN0cmluZzsgcmVjb3ZlcnlBY3Rpb24/OiBSZWNvdmVyeUFjdGlvbiB9ID0ge30sXHJcbik6IERlc2t0b3BFcnJvciB7XHJcbiAgY29uc3QgZTogRGVza3RvcEVycm9yID0geyBjb2RlLCBtZXNzYWdlLCByZXRyeWFibGU6IG9wdHMucmV0cnlhYmxlID09PSB0cnVlIH07XHJcbiAgaWYgKG9wdHMuc2Vzc2lvbklkICE9PSB1bmRlZmluZWQpIGUuc2Vzc2lvbklkID0gb3B0cy5zZXNzaW9uSWQ7XHJcbiAgaWYgKG9wdHMucnVuSWQgIT09IHVuZGVmaW5lZCkgZS5ydW5JZCA9IG9wdHMucnVuSWQ7XHJcbiAgaWYgKG9wdHMucmVjb3ZlcnlBY3Rpb24gIT09IHVuZGVmaW5lZCkgZS5yZWNvdmVyeUFjdGlvbiA9IG9wdHMucmVjb3ZlcnlBY3Rpb247XHJcbiAgcmV0dXJuIGU7XHJcbn1cclxuIiwgIi8qKlxyXG4gKiBAaG1oLWRlc2t0b3AvY29udHJhY3RzIFx1MjAxNCBydW50aW1lIFx1NjgyMVx1OUE4QyhndWFyZHMpXHUzMDAyXHJcbiAqXHJcbiAqIFx1NkJDRlx1NEUyQVx1OERFOFx1NEZFMVx1NEVGQlx1OEZCOVx1NzU0Q1x1NzY4NFx1NjU3MFx1NjM2RShydW50aW1lXHUyMTkycmVuZGVyZXJcdTMwMDFob3N0XHUyMTkybWFpbilcdThGREJcdTUxNjVcdTUyNERcdTUxNDhcdThGQzcgZ3VhcmQ7XHJcbiAqIFx1NjgyMVx1OUE4Q1x1NTkzMVx1OEQyNVx1NzY4NFx1NjU3MFx1NjM2RVx1NjMwOSBTQ0hFTUFfTUlTTUFUQ0ggXHU3RUQzXHU2Nzg0XHU1MzE2XHU5NTE5XHU4QkVGXHU1OTA0XHU3NDA2LFx1NEUwRFx1OTc1OVx1OUVEOFx1NjNBNVx1NTNEN1x1MzAwMlxyXG4gKiBcdTYyNEJcdTUxOTlcdTVCODhcdTUzNkJcdTgwMENcdTRFMERcdTY2MkZcdTVGMTVcdTdCMkNcdTRFMDlcdTY1Qjkgc2NoZW1hIFx1NUU5MzpcdTU5NTFcdTdFQTZcdTk3NjJcdTVDMEYsXHU5NkY2XHU0RjlEXHU4RDU2XHU2NTg3XHU1MzE2KGhtaGFybmVzcyBcdTU0MENcdTZFOTApXHUzMDAyXHJcbiAqL1xyXG5pbXBvcnQge1xyXG4gIEVWRU5UX0tJTkRTLFxyXG4gIEVWRU5UX1NDSEVNQV9WRVJTSU9OLFxyXG4gIHR5cGUgRXZlbnRFbnZlbG9wZSxcclxuICB0eXBlIEV2ZW50S2luZCxcclxufSBmcm9tICcuL2V2ZW50LnRzJztcclxuaW1wb3J0IHsgRVJST1JfQ09ERVMsIFJFQ09WRVJZX0FDVElPTlMsIHR5cGUgRGVza3RvcEVycm9yIH0gZnJvbSAnLi9lcnJvci50cyc7XHJcbmltcG9ydCB7IFJVTl9TVEFUVVNFUywgdHlwZSBSdW5TdGF0dXMgfSBmcm9tICcuL2R0by50cyc7XHJcblxyXG5jb25zdCBpc1JlY29yZCA9ICh2OiB1bmtub3duKTogdiBpcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9PlxyXG4gIHR5cGVvZiB2ID09PSAnb2JqZWN0JyAmJiB2ICE9PSBudWxsICYmICFBcnJheS5pc0FycmF5KHYpO1xyXG5cclxuY29uc3QgaXNOb25FbXB0eVN0cmluZyA9ICh2OiB1bmtub3duKTogdiBpcyBzdHJpbmcgPT4gdHlwZW9mIHYgPT09ICdzdHJpbmcnICYmIHYubGVuZ3RoID4gMDtcclxuXHJcbmNvbnN0IGlzUmZjMzMzOSA9ICh2OiBzdHJpbmcpOiBib29sZWFuID0+IHtcclxuICBjb25zdCB0ID0gRGF0ZS5wYXJzZSh2KTtcclxuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKHQpICYmIC9cXGR7NH0tXFxkezJ9LVxcZHsyfVQvLnRlc3Qodik7XHJcbn07XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gaXNFdmVudEVudmVsb3BlKHY6IHVua25vd24pOiB2IGlzIEV2ZW50RW52ZWxvcGUge1xyXG4gIGlmICghaXNSZWNvcmQodikpIHJldHVybiBmYWxzZTtcclxuICBpZiAodi5zY2hlbWFWZXJzaW9uICE9PSBFVkVOVF9TQ0hFTUFfVkVSU0lPTikgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICghaXNOb25FbXB0eVN0cmluZyh2LmV2ZW50SWQpKSByZXR1cm4gZmFsc2U7XHJcbiAgaWYgKCFpc05vbkVtcHR5U3RyaW5nKHYuc2Vzc2lvbklkKSkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICghaXNOb25FbXB0eVN0cmluZyh2LnJ1bklkKSkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICh0eXBlb2Ygdi5zZXEgIT09ICdudW1iZXInIHx8ICFOdW1iZXIuaXNJbnRlZ2VyKHYuc2VxKSB8fCB2LnNlcSA8IDApIHJldHVybiBmYWxzZTtcclxuICBpZiAoIWlzTm9uRW1wdHlTdHJpbmcodi5vY2N1cnJlZEF0KSB8fCAhaXNSZmMzMzM5KHYub2NjdXJyZWRBdCkpIHJldHVybiBmYWxzZTtcclxuICBpZiAoIUVWRU5UX0tJTkRTLmluY2x1ZGVzKHYua2luZCBhcyBFdmVudEtpbmQpKSByZXR1cm4gZmFsc2U7XHJcbiAgcmV0dXJuIGlzUmVjb3JkKHYucGF5bG9hZCk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpc0Rlc2t0b3BFcnJvcih2OiB1bmtub3duKTogdiBpcyBEZXNrdG9wRXJyb3Ige1xyXG4gIGlmICghaXNSZWNvcmQodikpIHJldHVybiBmYWxzZTtcclxuICBpZiAoIUVSUk9SX0NPREVTLmluY2x1ZGVzKHYuY29kZSBhcyBuZXZlcikpIHJldHVybiBmYWxzZTtcclxuICBpZiAodHlwZW9mIHYubWVzc2FnZSAhPT0gJ3N0cmluZycpIHJldHVybiBmYWxzZTtcclxuICBpZiAodHlwZW9mIHYucmV0cnlhYmxlICE9PSAnYm9vbGVhbicpIHJldHVybiBmYWxzZTtcclxuICBpZiAodi5zZXNzaW9uSWQgIT09IHVuZGVmaW5lZCAmJiAhaXNOb25FbXB0eVN0cmluZyh2LnNlc3Npb25JZCkpIHJldHVybiBmYWxzZTtcclxuICBpZiAodi5ydW5JZCAhPT0gdW5kZWZpbmVkICYmICFpc05vbkVtcHR5U3RyaW5nKHYucnVuSWQpKSByZXR1cm4gZmFsc2U7XHJcbiAgaWYgKHYucmVjb3ZlcnlBY3Rpb24gIT09IHVuZGVmaW5lZCAmJiAhUkVDT1ZFUllfQUNUSU9OUy5pbmNsdWRlcyh2LnJlY292ZXJ5QWN0aW9uIGFzIG5ldmVyKSkgcmV0dXJuIGZhbHNlO1xyXG4gIHJldHVybiB0cnVlO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gaXNSdW5TdGF0dXModjogdW5rbm93bik6IHYgaXMgUnVuU3RhdHVzIHtcclxuICByZXR1cm4gdHlwZW9mIHYgPT09ICdzdHJpbmcnICYmIFJVTl9TVEFUVVNFUy5pbmNsdWRlcyh2IGFzIFJ1blN0YXR1cyk7XHJcbn1cclxuXHJcbi8qKiBIb3N0IFx1NUYxNVx1NUJGQ1x1ODg0QyhzdGRvdXQgXHU3QjJDXHU0RTAwXHU4ODRDKVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gaXNIb3N0UmVhZHlMaW5lKHY6IHVua25vd24pOiB2IGlzIHsgaG1oRGVza3RvcEhvc3RSZWFkeTogdHJ1ZTsgcG9ydDogbnVtYmVyOyB2ZXJzaW9uOiBzdHJpbmcgfSB7XHJcbiAgaWYgKCFpc1JlY29yZCh2KSkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICh2LmhtaERlc2t0b3BIb3N0UmVhZHkgIT09IHRydWUpIHJldHVybiBmYWxzZTtcclxuICBpZiAodHlwZW9mIHYucG9ydCAhPT0gJ251bWJlcicgfHwgIU51bWJlci5pc0ludGVnZXIodi5wb3J0KSB8fCB2LnBvcnQgPD0gMCB8fCB2LnBvcnQgPiA2NTUzNSkgcmV0dXJuIGZhbHNlO1xyXG4gIHJldHVybiBpc05vbkVtcHR5U3RyaW5nKHYudmVyc2lvbik7XHJcbn1cclxuIiwgIi8qKlxyXG4gKiBEZXNrdG9wSG9zdENsaWVudCBcdTIwMTQgXHU1QkY5IGhtaCBob3N0IFx1NzY4NCBIVFRQK1NTRSBcdTVCQTJcdTYyMzdcdTdBRUZcdTMwMDJcclxuICpcclxuICogLSBcdTZCQ0ZcdTRFMkEgSFRUUCBcdThCRjdcdTZDNDJcdTgxRUFcdTUyQThcdTVFMjYgWC1IbWgtS2V5KHRva2VuIFx1NEUwRFx1OEZEQiBVUkwpO1xyXG4gKiAtIFx1N0VEM1x1Njc4NFx1NTMxNlx1OTUxOVx1OEJFRihyZXMuYm9keSBcdTkxQ0NcdTc2ODQgRGVza3RvcEVycm9yIFx1NUY2Mlx1NzJCNlx1NjIxNiBIVFRQIFx1NzJCNlx1NjAwMSlcdTg5QzRcdTdFQTZcdTYyMTBcdTVGMDJcdTVFMzhcdTYyOUJcdTUxRkE7XHJcbiAqIC0gU1NFIFx1NzUyOCBmZXRjaCBcdTZENDFcdTYyNEJcdTUxOTlcdTg5RTNcdTY3OTAoaWQvZXZlbnQvZGF0YSBcdTVFMjcpLFx1NjUyRlx1NjMwMSBMYXN0LUV2ZW50LUlEIFx1ODg2NVx1NjJDOVx1OTFDRFx1OEZERVx1MzAwMlxyXG4gKi9cclxuaW1wb3J0IHsgZGVza3RvcEVycm9yLCBpc0Rlc2t0b3BFcnJvciwgaXNFdmVudEVudmVsb3BlLCB0eXBlIERlc2t0b3BFcnJvciwgdHlwZSBFdmVudEVudmVsb3BlIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyc7XHJcbmltcG9ydCB7IHJhbmRvbVVVSUQgfSBmcm9tICdub2RlOmNyeXB0byc7XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIFNzZUZyYW1lIHtcclxuICBpZD86IHN0cmluZztcclxuICBldmVudDogc3RyaW5nO1xyXG4gIGRhdGE6IHN0cmluZztcclxufVxyXG5cclxuLyoqIFx1ODlFM1x1Njc5MFx1NEUwMFx1NkJCNSBTU0UgXHU2NTg3XHU2NzJDXHU0RTNBXHU1RTI3KFx1NEUwRFx1NTQyQlx1OERFOCBjaHVuayBcdTc2ODRcdTdGMTNcdTUxQjJcdTkwM0JcdThGOTEsXHU3RUFGXHU1MUZEXHU2NTcwXHU0RkJGXHU0RThFXHU2RDRCXHU4QkQ1KVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VTc2VDaHVuayhjaHVuazogc3RyaW5nKTogU3NlRnJhbWVbXSB7XHJcbiAgY29uc3QgZnJhbWVzOiBTc2VGcmFtZVtdID0gW107XHJcbiAgZm9yIChjb25zdCBibG9jayBvZiBjaHVuay5zcGxpdCgvXFxuXFxuLykpIHtcclxuICAgIGlmICghYmxvY2sudHJpbSgpKSBjb250aW51ZTtcclxuICAgIGxldCBpZDogc3RyaW5nIHwgdW5kZWZpbmVkO1xyXG4gICAgbGV0IGV2ZW50ID0gJ21lc3NhZ2UnO1xyXG4gICAgY29uc3QgZGF0YUxpbmVzOiBzdHJpbmdbXSA9IFtdO1xyXG4gICAgbGV0IHNhd0ZpZWxkID0gZmFsc2U7XHJcbiAgICBmb3IgKGNvbnN0IGxpbmUgb2YgYmxvY2suc3BsaXQoJ1xcbicpKSB7XHJcbiAgICAgIGlmIChsaW5lLnN0YXJ0c1dpdGgoJzonKSkgY29udGludWU7IC8vIFx1NkNFOFx1OTFDQS9cdTVGQzNcdThERjNcclxuICAgICAgaWYgKGxpbmUuc3RhcnRzV2l0aCgnaWQ6JykpIHsgaWQgPSBsaW5lLnNsaWNlKDMpLnRyaW0oKTsgc2F3RmllbGQgPSB0cnVlOyB9XHJcbiAgICAgIGVsc2UgaWYgKGxpbmUuc3RhcnRzV2l0aCgnZXZlbnQ6JykpIHsgZXZlbnQgPSBsaW5lLnNsaWNlKDYpLnRyaW0oKTsgc2F3RmllbGQgPSB0cnVlOyB9XHJcbiAgICAgIGVsc2UgaWYgKGxpbmUuc3RhcnRzV2l0aCgnZGF0YTonKSkgeyBkYXRhTGluZXMucHVzaChsaW5lLnNsaWNlKDUpLnJlcGxhY2UoL14gLywgJycpKTsgc2F3RmllbGQgPSB0cnVlOyB9XHJcbiAgICB9XHJcbiAgICBpZiAoIXNhd0ZpZWxkKSBjb250aW51ZTsgLy8gXHU3RUFGXHU2Q0U4XHU5MUNBL1x1NUZDM1x1OERGM1x1NTc1N1x1NEUwRFx1NEVBN1x1NzUxRlx1NUUyN1xyXG4gICAgZnJhbWVzLnB1c2goeyAuLi4oaWQgIT09IHVuZGVmaW5lZCA/IHsgaWQgfSA6IHt9KSwgZXZlbnQsIGRhdGE6IGRhdGFMaW5lcy5qb2luKCdcXG4nKSB9KTtcclxuICB9XHJcbiAgcmV0dXJuIGZyYW1lcztcclxufVxyXG5cclxuLyoqIFx1NEVDRSBTU0UgXHU1RTI3XHU2NTcwXHU2MzZFXHU0RTJEXHU4OUUzXHU1MUZBXHU1NDA4XHU2Q0Q1IEV2ZW50RW52ZWxvcGU7XHU0RTBEXHU1NDA4XHU2Q0Q1XHU3Njg0XHU4RkQ0XHU1NkRFIG51bGwoU0NIRU1BX01JU01BVENIIFx1NzUzMVx1OEMwM1x1NzUyOFx1NjVCOVx1OEJBMVx1NjU3MClcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGVudmVsb3BlRnJvbUZyYW1lKGZyYW1lOiBTc2VGcmFtZSk6IEV2ZW50RW52ZWxvcGUgfCBudWxsIHtcclxuICBpZiAoZnJhbWUuZXZlbnQgIT09ICdobWgnKSByZXR1cm4gbnVsbDsgLy8gXHU2MjExXHU0RUVDXHU3Njg0XHU0RThCXHU0RUY2XHU0RkUxXHU1QzAxXHU3RURGXHU0RTAwXHU4RDcwIGV2ZW50OiBobWhcclxuICB0cnkge1xyXG4gICAgY29uc3QgcGFyc2VkOiB1bmtub3duID0gSlNPTi5wYXJzZShmcmFtZS5kYXRhKTtcclxuICAgIHJldHVybiBpc0V2ZW50RW52ZWxvcGUocGFyc2VkKSA/IHBhcnNlZCA6IG51bGw7XHJcbiAgfSBjYXRjaCB7XHJcbiAgICByZXR1cm4gbnVsbDtcclxuICB9XHJcbn1cclxuXHJcbmV4cG9ydCBjbGFzcyBEZXNrdG9wSHR0cEVycm9yIGV4dGVuZHMgRXJyb3Ige1xyXG4gIGNvbnN0cnVjdG9yKHB1YmxpYyByZWFkb25seSBkZXRhaWw6IERlc2t0b3BFcnJvcikge1xyXG4gICAgc3VwZXIoZGV0YWlsLm1lc3NhZ2UpO1xyXG4gIH1cclxufVxyXG5cclxuZXhwb3J0IGNsYXNzIERlc2t0b3BIb3N0Q2xpZW50IHtcclxuICBjb25zdHJ1Y3RvcihcclxuICAgIHByaXZhdGUgcmVhZG9ubHkgYmFzZVVybDogc3RyaW5nLFxyXG4gICAgcHJpdmF0ZSByZWFkb25seSB0b2tlbjogc3RyaW5nLFxyXG4gICkge31cclxuXHJcbiAgcHJpdmF0ZSBoZWFkZXJzKGV4dHJhOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge30pOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IHtcclxuICAgIHJldHVybiB7ICd4LWhtaC1rZXknOiB0aGlzLnRva2VuLCAuLi5leHRyYSB9O1xyXG4gIH1cclxuXHJcbiAgYXN5bmMgZ2V0SnNvbjxUPihwYXRoOiBzdHJpbmcsIHRpbWVvdXRNcyA9IDVfMDAwKTogUHJvbWlzZTxUPiB7XHJcbiAgICBsZXQgcmVzOiBSZXNwb25zZTtcclxuICAgIHRyeSB7XHJcbiAgICAgIHJlcyA9IGF3YWl0IGZldGNoKGAke3RoaXMuYmFzZVVybH0ke3BhdGh9YCwgeyBoZWFkZXJzOiB0aGlzLmhlYWRlcnMoKSwgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KHRpbWVvdXRNcykgfSk7XHJcbiAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGByZXF1ZXN0IGZhaWxlZDogJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxNjApfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHRoaXMucGFyc2VSZXNwb25zZTxUPihyZXMpO1xyXG4gIH1cclxuXHJcbiAgLyoqIFx1NjJDOVx1NTNENlx1N0VBRlx1NjU4N1x1NjcyQ1x1N0FFRlx1NzBCOShcdTU5ODIgL2FwaS9zZXNzaW9ucy86aWQvZXhwb3J0Lm1kKVx1MzAwMiAqL1xyXG4gIGFzeW5jIGdldFRleHQocGF0aDogc3RyaW5nLCB0aW1lb3V0TXMgPSAxMF8wMDApOiBQcm9taXNlPHN0cmluZz4ge1xyXG4gICAgbGV0IHJlczogUmVzcG9uc2U7XHJcbiAgICB0cnkge1xyXG4gICAgICByZXMgPSBhd2FpdCBmZXRjaChgJHt0aGlzLmJhc2VVcmx9JHtwYXRofWAsIHsgaGVhZGVyczogdGhpcy5oZWFkZXJzKCksIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCh0aW1lb3V0TXMpIH0pO1xyXG4gICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgcmVxdWVzdCBmYWlsZWQ6ICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTYwKX1gLCB7IHJldHJ5YWJsZTogdHJ1ZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcclxuICAgIH1cclxuICAgIGlmIChyZXMuc3RhdHVzID09PSA0MDEgfHwgcmVzLnN0YXR1cyA9PT0gNDAzKSB7XHJcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignQVVUSF9GQUlMRUQnLCBgaG9zdCByZWplY3RlZCB0aGUgc2Vzc2lvbiB0b2tlbiAoSFRUUCAke3Jlcy5zdGF0dXN9KWAsIHsgcmV0cnlhYmxlOiBmYWxzZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcclxuICAgIH1cclxuICAgIGlmICghcmVzLm9rKSB7XHJcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgSFRUUCAke3Jlcy5zdGF0dXN9YCwgeyByZXRyeWFibGU6IHJlcy5zdGF0dXMgPj0gNTAwIH0pKTtcclxuICAgIH1cclxuICAgIHJldHVybiByZXMudGV4dCgpO1xyXG4gIH1cclxuXHJcbiAgLyoqIFx1NkJDRlx1NEUyQVx1NUUyNlx1NTI2Rlx1NEY1Q1x1NzUyOFx1NzY4NCBQT1NUIFx1ODFFQVx1NTJBOFx1NjQzQVx1NUUyNlx1NUU0Mlx1N0I0OVx1OTUyRSgwMyBcdTAwQTdcdTU2REJcdTk2MzJcdTkxQ0RcdTY1M0U6XHU4QkY3XHU2QzQyXHU0RjdGXHU3NTI4IGlkZW1wb3RlbmN5S2V5O1xyXG4gICAqICBydW50aW1lIFx1NEZBN1x1NzdFRFx1NjcxRlx1NTE3Q1x1NUJCOVx1NUZGRFx1NzU2NSxcdTUzNEZcdThCQUVcdTUxNDhcdTg4NENcdTIwMTRcdTIwMTRcdTkxQ0RcdThCRDVcdTUzRUZcdTUxRURcdTk1MkVcdTUzQkJcdTkxQ0QsXHU0RTBEXHU3NkYyXHU3NkVFXHU5MUNEXHU2NTNFKVx1MzAwMiAqL1xyXG4gIGFzeW5jIHBvc3RKc29uPFQ+KHBhdGg6IHN0cmluZywgYm9keTogdW5rbm93biwgdGltZW91dE1zID0gMTBfMDAwKTogUHJvbWlzZTxUPiB7XHJcbiAgICBsZXQgcmVzOiBSZXNwb25zZTtcclxuICAgIHRyeSB7XHJcbiAgICAgIHJlcyA9IGF3YWl0IGZldGNoKGAke3RoaXMuYmFzZVVybH0ke3BhdGh9YCwge1xyXG4gICAgICAgIG1ldGhvZDogJ1BPU1QnLFxyXG4gICAgICAgIGhlYWRlcnM6IHRoaXMuaGVhZGVycyh7XHJcbiAgICAgICAgICAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLFxyXG4gICAgICAgICAgJ3gtaWRlbXBvdGVuY3kta2V5JzogcmFuZG9tVVVJRCgpLFxyXG4gICAgICAgIH0pLFxyXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpLFxyXG4gICAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCh0aW1lb3V0TXMpLFxyXG4gICAgICB9KTtcclxuICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYHJlcXVlc3QgZmFpbGVkOiAke1N0cmluZyhlcnIpLnNsaWNlKDAsIDE2MCl9YCwgeyByZXRyeWFibGU6IHRydWUsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gdGhpcy5wYXJzZVJlc3BvbnNlPFQ+KHJlcyk7XHJcbiAgfVxyXG5cclxuICBwcml2YXRlIGFzeW5jIHBhcnNlUmVzcG9uc2U8VD4ocmVzOiBSZXNwb25zZSk6IFByb21pc2U8VD4ge1xyXG4gICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSB8fCByZXMuc3RhdHVzID09PSA0MDMpIHtcclxuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdBVVRIX0ZBSUxFRCcsIGBob3N0IHJlamVjdGVkIHRoZSBzZXNzaW9uIHRva2VuIChIVFRQICR7cmVzLnN0YXR1c30pYCwgeyByZXRyeWFibGU6IGZhbHNlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgdGV4dCA9IGF3YWl0IHJlcy50ZXh0KCk7XHJcbiAgICBsZXQgcGFyc2VkOiB1bmtub3duID0gbnVsbDtcclxuICAgIHRyeSB7XHJcbiAgICAgIHBhcnNlZCA9IHRleHQgPyBKU09OLnBhcnNlKHRleHQpIDogbnVsbDtcclxuICAgIH0gY2F0Y2gge1xyXG4gICAgICBwYXJzZWQgPSBudWxsO1xyXG4gICAgfVxyXG4gICAgaWYgKCFyZXMub2spIHtcclxuICAgICAgaWYgKGlzRGVza3RvcEVycm9yKHBhcnNlZCkpIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKHBhcnNlZCk7XHJcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgSFRUUCAke3Jlcy5zdGF0dXN9OiAke3RleHQuc2xpY2UoMCwgMTYwKX1gLCB7IHJldHJ5YWJsZTogcmVzLnN0YXR1cyA+PSA1MDAgfSkpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHBhcnNlZCBhcyBUO1xyXG4gIH1cclxuXHJcbiAgLyoqXHJcbiAgICogXHU4QkEyXHU5NjA1XHU1MTY4XHU5MEU4IFNTRSBcdTVFMjcoXHU1NDJCXHU5NzVFXHU0RkUxXHU1QzAxXHU0RThCXHU0RUY2OmRlbHRhL2xpbmUgXHU3QjQ5XHU5QUQ4XHU5ODkxXHU2RDQxKVx1MzAwMlx1NEZFMVx1NUMwMVx1NzUzMVx1OEMwM1x1NzUyOFx1NjVCOVxyXG4gICAqIFx1NzUyOCBlbnZlbG9wZUZyb21GcmFtZSBcdTgxRUFcdTg4NENcdTUyMDZcdTZENDE7XHU2NUFEXHU3RUJGXHU5MUNEXHU4RkRFXHU4QkVEXHU0RTQ5XHU1NDBDIGV2ZW50cygpXHUzMDAyXHJcbiAgICovXHJcbiAgYXN5bmMgKnJhd0V2ZW50cyhsYXN0RXZlbnRJZD86IHN0cmluZywgc2lnbmFsPzogQWJvcnRTaWduYWwpOiBBc3luY0dlbmVyYXRvcjxTc2VGcmFtZT4ge1xyXG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYCR7dGhpcy5iYXNlVXJsfS9hcGkvZXZlbnRzYCwge1xyXG4gICAgICBoZWFkZXJzOiB0aGlzLmhlYWRlcnMoe1xyXG4gICAgICAgIGFjY2VwdDogJ3RleHQvZXZlbnQtc3RyZWFtJyxcclxuICAgICAgICAuLi4obGFzdEV2ZW50SWQgIT09IHVuZGVmaW5lZCA/IHsgJ2xhc3QtZXZlbnQtaWQnOiBsYXN0RXZlbnRJZCB9IDoge30pLFxyXG4gICAgICB9KSxcclxuICAgICAgLi4uKHNpZ25hbCAhPT0gdW5kZWZpbmVkID8geyBzaWduYWwgfSA6IHt9KSxcclxuICAgIH0pO1xyXG4gICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSB8fCByZXMuc3RhdHVzID09PSA0MDMpIHtcclxuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdBVVRIX0ZBSUxFRCcsIGBob3N0IHJlamVjdGVkIHRoZSBzZXNzaW9uIHRva2VuIChIVFRQICR7cmVzLnN0YXR1c30pYCwgeyByZXRyeWFibGU6IGZhbHNlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xyXG4gICAgfVxyXG4gICAgaWYgKCFyZXMub2sgfHwgcmVzLmJvZHkgPT09IG51bGwpIHtcclxuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBTU0UgSFRUUCAke3Jlcy5zdGF0dXN9YCwgeyByZXRyeWFibGU6IHRydWUsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XHJcbiAgICB9XHJcbiAgICBjb25zdCByZWFkZXIgPSByZXMuYm9keS5nZXRSZWFkZXIoKTtcclxuICAgIGNvbnN0IGRlY29kZXIgPSBuZXcgVGV4dERlY29kZXIoKTtcclxuICAgIGxldCBidWZmZXIgPSAnJztcclxuICAgIGZvciAoOzspIHtcclxuICAgICAgY29uc3QgeyBkb25lLCB2YWx1ZSB9ID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcclxuICAgICAgaWYgKGRvbmUpIHJldHVybjtcclxuICAgICAgYnVmZmVyICs9IGRlY29kZXIuZGVjb2RlKHZhbHVlLCB7IHN0cmVhbTogdHJ1ZSB9KTtcclxuICAgICAgbGV0IGlkeDogbnVtYmVyO1xyXG4gICAgICB3aGlsZSAoKGlkeCA9IGJ1ZmZlci5pbmRleE9mKCdcXG5cXG4nKSkgIT09IC0xKSB7XHJcbiAgICAgICAgY29uc3QgYmxvY2sgPSBidWZmZXIuc2xpY2UoMCwgaWR4KTtcclxuICAgICAgICBidWZmZXIgPSBidWZmZXIuc2xpY2UoaWR4ICsgMik7XHJcbiAgICAgICAgZm9yIChjb25zdCBmcmFtZSBvZiBwYXJzZVNzZUNodW5rKGJsb2NrKSkgeWllbGQgZnJhbWU7XHJcbiAgICAgIH1cclxuICAgIH1cclxuICB9XHJcblxyXG4gIC8qKlxyXG4gICAqIFx1OEJBMlx1OTYwNSBTU0UgXHU0RThCXHU0RUY2XHU2RDQxKGFzeW5jIGl0ZXJhdG9yKVx1MzAwMlx1NjVBRFx1N0VCRlx1NzUzMVx1OEMwM1x1NzUyOFx1NjVCOVx1OTFDRFx1OEZERTtcdTkxQ0RcdThGREVcdTY1RjZcdTYyOEFcdTY3MDBcdTU0MEVcclxuICAgKiBcdTY1MzZcdTUyMzBcdTc2ODQgZXZlbnRJZCBcdTRGMjBcdTUxNjUgbGFzdEV2ZW50SWQsaG9zdCBcdTdBRUZcdTRFQ0VcdTkxQ0RcdTY1M0VcdTczQUZcdTg4NjVcdTUzRDFcdTMwMDJcclxuICAgKi9cclxuICBhc3luYyAqZXZlbnRzKGxhc3RFdmVudElkPzogc3RyaW5nLCBzaWduYWw/OiBBYm9ydFNpZ25hbCk6IEFzeW5jR2VuZXJhdG9yPEV2ZW50RW52ZWxvcGU+IHtcclxuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGAke3RoaXMuYmFzZVVybH0vYXBpL2V2ZW50c2AsIHtcclxuICAgICAgaGVhZGVyczogdGhpcy5oZWFkZXJzKHtcclxuICAgICAgICBhY2NlcHQ6ICd0ZXh0L2V2ZW50LXN0cmVhbScsXHJcbiAgICAgICAgLi4uKGxhc3RFdmVudElkICE9PSB1bmRlZmluZWQgPyB7ICdsYXN0LWV2ZW50LWlkJzogbGFzdEV2ZW50SWQgfSA6IHt9KSxcclxuICAgICAgfSksXHJcbiAgICAgIC4uLihzaWduYWwgIT09IHVuZGVmaW5lZCA/IHsgc2lnbmFsIH0gOiB7fSksXHJcbiAgICB9KTtcclxuICAgIGlmIChyZXMuc3RhdHVzID09PSA0MDEgfHwgcmVzLnN0YXR1cyA9PT0gNDAzKSB7XHJcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignQVVUSF9GQUlMRUQnLCBgaG9zdCByZWplY3RlZCB0aGUgc2Vzc2lvbiB0b2tlbiAoSFRUUCAke3Jlcy5zdGF0dXN9KWAsIHsgcmV0cnlhYmxlOiBmYWxzZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcclxuICAgIH1cclxuICAgIGlmICghcmVzLm9rIHx8ICFyZXMuYm9keSkge1xyXG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYFNTRSBIVFRQICR7cmVzLnN0YXR1c31gLCB7IHJldHJ5YWJsZTogdHJ1ZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHJlYWRlciA9IHJlcy5ib2R5LmdldFJlYWRlcigpO1xyXG4gICAgY29uc3QgZGVjb2RlciA9IG5ldyBUZXh0RGVjb2RlcigpO1xyXG4gICAgbGV0IGJ1ZmZlciA9ICcnO1xyXG4gICAgZm9yICg7Oykge1xyXG4gICAgICBjb25zdCB7IGRvbmUsIHZhbHVlIH0gPSBhd2FpdCByZWFkZXIucmVhZCgpO1xyXG4gICAgICBpZiAoZG9uZSkgcmV0dXJuO1xyXG4gICAgICBidWZmZXIgKz0gZGVjb2Rlci5kZWNvZGUodmFsdWUsIHsgc3RyZWFtOiB0cnVlIH0pO1xyXG4gICAgICAvLyBcdTRFRTVcdTdBN0FcdTg4NENcdTUyMDZcdTVFMjc7XHU0RkREXHU3NTU5XHU0RTBEXHU1QjhDXHU2NTc0XHU3Njg0XHU1QzNFXHU5MEU4XHJcbiAgICAgIGxldCBpZHg6IG51bWJlcjtcclxuICAgICAgd2hpbGUgKChpZHggPSBidWZmZXIuaW5kZXhPZignXFxuXFxuJykpICE9PSAtMSkge1xyXG4gICAgICAgIGNvbnN0IGJsb2NrID0gYnVmZmVyLnNsaWNlKDAsIGlkeCk7XHJcbiAgICAgICAgYnVmZmVyID0gYnVmZmVyLnNsaWNlKGlkeCArIDIpO1xyXG4gICAgICAgIGZvciAoY29uc3QgZnJhbWUgb2YgcGFyc2VTc2VDaHVuayhibG9jaykpIHtcclxuICAgICAgICAgIGNvbnN0IGVudiA9IGVudmVsb3BlRnJvbUZyYW1lKGZyYW1lKTtcclxuICAgICAgICAgIGlmIChlbnYgIT09IG51bGwpIHlpZWxkIGVudjtcclxuICAgICAgICB9XHJcbiAgICAgIH1cclxuICAgIH1cclxuICB9XHJcbn1cclxuIiwgIi8qKlxyXG4gKiBmYWtlIGhvc3QgXHUyMDE0IGhtaGFybmVzcyBydW50aW1lIFx1NzY4NFx1NkQ0Qlx1OEJENVx1NjZGRlx1OEVBQihNYXN0ZXJQcm9tcHQgXHU5NjM2XHU2QkI1IEQvRTpcclxuICogXCJcdTUxNDhcdTRGN0ZcdTc1MjggZmFrZSBob3N0IFx1N0YxNlx1NTE5OVx1NzJCNlx1NjAwMVx1NjczQVx1NkQ0Qlx1OEJENSxcdTUxOERcdTYzQTVcdTc3MUZcdTVCOUUgQVBJXCI7XHU5NjM2XHU2QkI1IEUgXHU3Njg0XHU0RjFBXHU4QkREXHU3RUI1XHU1MjA3XHU3MjQ3XHJcbiAqIGUyZSBcdTRFNUZcdTUxNDhcdTU3MjggZmFrZSBcdTVDNDJcdTk1RURcdTczQUYpXHUzMDAyXHJcbiAqXHJcbiAqIFx1Njg0Q1x1OTc2MiBob3N0IFx1NTQwOFx1NTQwQzpcclxuICogIC0gXHU1M0VBXHU3RUQxIDEyNy4wLjAuMSxcdTdBRUZcdTUzRTMgT1MgXHU1MjA2XHU5MTRELFx1NUI5RVx1OTY0NVx1N0FFRlx1NTNFM1x1NTE5OSBzdGRvdXQgXHU1RjE1XHU1QkZDXHU4ODRDO1xyXG4gKiAgLSBcdTYyNDBcdTY3MDkgL2FwaS8qIFx1ODk4MVx1NkM0MiBYLUhtaC1LZXkgPT09IEhNSF9ERVNLVE9QX1RPS0VOLFx1NTQyNlx1NTIxOSA0MDEgKyBEZXNrdG9wRXJyb3I7XHJcbiAqICAtIEdFVCAvYXBpL3N0YXRlIFx1NTA2NVx1NUVCN1x1NjNBMlx1NkQ0QjtHRVQgL2FwaS9ldmVudHMgU1NFKGV2ZW50OiBobWggXHU0RkUxXHU1QzAxXHU2RDQxICsgXHU5MUNEXHU2NTNFXHU3M0FGKTtcclxuICogIC0gUE9TVCAvYXBpL2Rlc2t0b3Avc2h1dGRvd24gXHU0RjE4XHU5NkM1XHU5MDAwXHU1MUZBXHUzMDAyXHJcbiAqXHJcbiAqIFx1OTYzNlx1NkJCNSBFIFx1NkEyMVx1NjJERlx1OTc2MihcdTRFMEUgaG1oYXJuZXNzIGRlc2t0b3AgXHU2QTIxXHU1RjBGXHU1NDBDXHU1RjYyKTpcclxuICogIC0gUE9TVCAvYXBpL3Rhc2sge3RleHQsIHNlc3Npb25JZCwgbW9kZX06XHU2MzkyXHU5NjFGXHU1RTc2XHU2MzA5XHU4MTFBXHU2NzJDXHU1M0QxXHJcbiAqICAgIHJ1bi5zdGFydGVkIFx1MjE5MiB0b29sLnN0YXJ0ZWQvY29tcGxldGVkIFx1MjE5Mihtb2RlPT09J2FzaycgXHU2NUY2KVxyXG4gKiAgICBhcHByb3ZhbC5yZXF1aXJlZChcdTdCNDkgL2FwaS9hcHByb3ZlKVx1MjE5MiBydW4uY29tcGxldGVkO1xyXG4gKiAgLSBQT1NUIC9hcGkvYXBwcm92ZSB7Z3JhbnRlZCwgc2Vzc2lvbklkfTtcclxuICogIC0gUE9TVCAvYXBpL2ludGVycnVwdCB7c2Vzc2lvbklkfTtcclxuICogIC0gR0VUIC9hcGkvc2Vzc2lvbnNcdTMwMDJcclxuICpcclxuICogXHU2RDRCXHU4QkQ1XHU5NEE5XHU1QjUwOkZBS0VfSE9TVF9ESUVfQUZURVJfTVMgLyBGQUtFX0hPU1RfRElFX0FUX0JPT1QgL1xyXG4gKiBGQUtFX0hPU1RfRVhQRUNUX1RPS0VOIC8gRkFLRV9IT1NUX1RBU0tfREVMQVlfTVMgLyBGQUtFX0hPU1RfVEFTS19GQUlMPTFcclxuICogKFx1NEVGQlx1NTJBMVx1NEVFNSBydW4uZmFpbGVkIFx1N0VEM1x1Njc1RixcdTY3ODRcdTkwMjBcdTk1MTlcdThCRUZcdTYwNjJcdTU5MERcdTU3M0FcdTY2NkYpXHUzMDAyXHJcbiAqL1xyXG5pbXBvcnQgeyBjcmVhdGVTZXJ2ZXIsIHR5cGUgU2VydmVyUmVzcG9uc2UgfSBmcm9tICdub2RlOmh0dHAnO1xyXG5pbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSAnbm9kZTpjcnlwdG8nO1xyXG5pbXBvcnQgeyBwYXRoVG9GaWxlVVJMIH0gZnJvbSAnbm9kZTp1cmwnO1xyXG5pbXBvcnQgeyByZWFscGF0aFN5bmMgfSBmcm9tICdub2RlOmZzJztcclxuaW1wb3J0IHsgRVZFTlRfU0NIRU1BX1ZFUlNJT04sIGRlc2t0b3BFcnJvciwgdHlwZSBFdmVudEVudmVsb3BlLCB0eXBlIEV2ZW50S2luZCB9IGZyb20gJ0BobWgtZGVza3RvcC9jb250cmFjdHMnO1xyXG5cclxuZXhwb3J0IGludGVyZmFjZSBGYWtlSG9zdEhhbmRsZSB7XHJcbiAgcG9ydDogbnVtYmVyO1xyXG4gIGVtaXQoc2Vzc2lvbklkOiBzdHJpbmcsIHJ1bklkOiBzdHJpbmcsIGtpbmQ6IEV2ZW50S2luZCwgcGF5bG9hZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBudW1iZXI7XHJcbiAgY2xvc2UoKTogUHJvbWlzZTx2b2lkPjtcclxufVxyXG5cclxuaW50ZXJmYWNlIEZha2VTZXNzaW9uIHtcclxuICBpZDogc3RyaW5nO1xyXG4gIGNyZWF0ZWRBdDogc3RyaW5nO1xyXG4gIHVwZGF0ZWRBdDogc3RyaW5nO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgUGVuZGluZ0FwcHJvdmFsIHtcclxuICBzZXNzaW9uSWQ6IHN0cmluZztcclxuICBhcHByb3ZhbElkOiBzdHJpbmc7XHJcbiAgcmVzb2x2ZShncmFudGVkOiBib29sZWFuKTogdm9pZDtcclxufVxyXG5cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHN0YXJ0RmFrZUhvc3Qob3B0czogeyB0b2tlbjogc3RyaW5nOyBxdWlldD86IGJvb2xlYW4gfSk6IFByb21pc2U8RmFrZUhvc3RIYW5kbGU+IHtcclxuICBjb25zdCB0b2tlbiA9IG9wdHMudG9rZW47XHJcbiAgLy8gXHU2RDRCXHU4QkQ1XHU5NEE5XHU1QjUwOkZBS0VfSE9TVF9FWFBFQ1RfVE9LRU4gXHU4QkE5IGhvc3QgXHU2ODIxXHU5QThDXHU0RTAwXHU0RTJBXHU0RTBFIEhNSF9ERVNLVE9QX1RPS0VOXHJcbiAgLy8gXHU0RTBEXHU1NDBDXHU3Njg0XHU1MDNDKFx1Njc4NFx1OTAyMCBBVVRIX0ZBSUxFRCBcdTU3M0FcdTY2NkY7c3VwZXJ2aXNvciBcdTYwM0JcdTY2MkZcdTg5ODZcdTc2RDYgSE1IX0RFU0tUT1BfVE9LRU4pXHJcbiAgY29uc3QgZXhwZWN0ZWQgPSBwcm9jZXNzLmVudi5GQUtFX0hPU1RfRVhQRUNUX1RPS0VOID8/IHRva2VuO1xyXG4gIGNvbnN0IHRhc2tEZWxheSA9IE51bWJlcihwcm9jZXNzLmVudi5GQUtFX0hPU1RfVEFTS19ERUxBWV9NUyA/PyAzMCk7XHJcbiAgY29uc3QgZmFpbFRhc2tzID0gcHJvY2Vzcy5lbnYuRkFLRV9IT1NUX1RBU0tfRkFJTCA9PT0gJzEnO1xyXG5cclxuICBjb25zdCBzc2VDbGllbnRzID0gbmV3IFNldDxTZXJ2ZXJSZXNwb25zZT4oKTtcclxuICBjb25zdCBzZXFCeVJ1biA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XHJcbiAgLy8gXHU5MUNEXHU2NTNFXHU3M0FGOlx1NjcwMFx1OEZEMSAyMDAgXHU1RTI3KExhc3QtRXZlbnQtSUQgXHU2NUFEXHU3RUJGXHU4ODY1XHU2MkM5KSxcdTRFMEUgaG1oYXJuZXNzIHdlYiBcdTU0MENcdTZCM0VcdThCRURcdTRFNDlcclxuICBjb25zdCByaW5nOiBBcnJheTx7IGlkOiBudW1iZXI7IGV2ZW50OiBzdHJpbmc7IGRhdGE6IHVua25vd24gfT4gPSBbXTtcclxuICBsZXQgcmluZ1NlcSA9IDA7XHJcbiAgY29uc3Qgc2Vzc2lvbnMgPSBuZXcgTWFwPHN0cmluZywgRmFrZVNlc3Npb24+KCk7XHJcbiAgbGV0IHBlbmRpbmc6IFBlbmRpbmdBcHByb3ZhbCB8IG51bGwgPSBudWxsO1xyXG4gIGNvbnN0IHJ1blRpbWVycyA9IG5ldyBNYXA8c3RyaW5nLCBOb2RlSlMuVGltZW91dD4oKTtcclxuICAvLyBcdTVERTVcdTRGNUNcdTUzM0EvUHJvdmlkZXIgXHU3MkI2XHU2MDAxKFx1NEUwRSBobWhhcm5lc3MgXHU1NDBDXHU1RjYyXHU3Njg0XHU2NzAwXHU1QzBGXHU2QTIxXHU2MkRGKVxyXG4gIGNvbnN0IGZha2VXb3Jrc3BhY2VzID0ge1xyXG4gICAgY3VycmVudDogJ3dzLWRlbW8nLFxyXG4gICAgaXRlbXM6IFtcclxuICAgICAgeyBpZDogJ3dzLWRlbW8nLCBuYW1lOiAnZGVtby13b3Jrc3BhY2UnLCBwYXRoOiAnQzpcXFxcZGVtbycgfSxcclxuICAgIF0sXHJcbiAgfTtcclxuICBjb25zdCBmYWtlUHJvdmlkZXJzID0gbmV3IE1hcDxzdHJpbmcsIHsgYmFzZVVybDogc3RyaW5nOyBtb2RlbDogc3RyaW5nOyBhcGlLZXk6IHN0cmluZyB9PihbXHJcbiAgICBbJ2RlbW8nLCB7IGJhc2VVcmw6ICdodHRwOi8vMTI3LjAuMC4xOjkvdjEnLCBtb2RlbDogJ2Zha2UtbScsIGFwaUtleTogJ3NrLWRlbW8tMTIzNCcgfV0sXHJcbiAgICBbJ2RlbW8tdmlzaW9uJywgeyBiYXNlVXJsOiAnaHR0cDovLzEyNy4wLjAuMTo5L3YxJywgbW9kZWw6ICdmYWtlLW0tdmlzaW9uJywgYXBpS2V5OiAnc2stZGVtby01Njc4JyB9XSxcclxuICBdKTtcclxuICBsZXQgZmFrZUNoYXRQcm92aWRlciA9ICdkZW1vJztcclxuXHJcbiAgY29uc3QgZW1pdCA9IChzZXNzaW9uSWQ6IHN0cmluZywgcnVuSWQ6IHN0cmluZywga2luZDogRXZlbnRLaW5kLCBwYXlsb2FkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IG51bWJlciA9PiB7XHJcbiAgICBjb25zdCBrZXkgPSBgJHtzZXNzaW9uSWR9XFwwJHtydW5JZH1gO1xyXG4gICAgY29uc3Qgc2VxID0gKHNlcUJ5UnVuLmdldChrZXkpID8/IDApICsgMTtcclxuICAgIHNlcUJ5UnVuLnNldChrZXksIHNlcSk7XHJcbiAgICBjb25zdCBlbnY6IEV2ZW50RW52ZWxvcGUgPSB7XHJcbiAgICAgIHNjaGVtYVZlcnNpb246IEVWRU5UX1NDSEVNQV9WRVJTSU9OLFxyXG4gICAgICBldmVudElkOiByYW5kb21VVUlEKCksXHJcbiAgICAgIHNlc3Npb25JZCxcclxuICAgICAgcnVuSWQsXHJcbiAgICAgIHNlcSxcclxuICAgICAgb2NjdXJyZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxyXG4gICAgICBraW5kLFxyXG4gICAgICBwYXlsb2FkLFxyXG4gICAgfTtcclxuICAgIGNvbnN0IGlkID0gKytyaW5nU2VxO1xyXG4gICAgcmluZy5wdXNoKHsgaWQsIGV2ZW50OiAnaG1oJywgZGF0YTogZW52IH0pO1xyXG4gICAgaWYgKHJpbmcubGVuZ3RoID4gMjAwKSByaW5nLnNwbGljZSgwLCByaW5nLmxlbmd0aCAtIDIwMCk7XHJcbiAgICBmb3IgKGNvbnN0IGMgb2Ygc3NlQ2xpZW50cykge1xyXG4gICAgICBjLndyaXRlKGBpZDogJHtpZH1cXG5ldmVudDogaG1oXFxuZGF0YTogJHtKU09OLnN0cmluZ2lmeShlbnYpfVxcblxcbmApO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHNlcTtcclxuICB9O1xyXG5cclxuICBjb25zdCB0b3VjaCA9IChzZXNzaW9uSWQ6IHN0cmluZyk6IEZha2VTZXNzaW9uID0+IHtcclxuICAgIGxldCBzID0gc2Vzc2lvbnMuZ2V0KHNlc3Npb25JZCk7XHJcbiAgICBpZiAocyA9PT0gdW5kZWZpbmVkKSB7XHJcbiAgICAgIHMgPSB7IGlkOiBzZXNzaW9uSWQsIGNyZWF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLCB1cGRhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSB9O1xyXG4gICAgICBzZXNzaW9ucy5zZXQoc2Vzc2lvbklkLCBzKTtcclxuICAgIH1cclxuICAgIHMudXBkYXRlZEF0ID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xyXG4gICAgcmV0dXJuIHM7XHJcbiAgfTtcclxuXHJcbiAgLyoqIFx1NkEyMVx1NjJERlx1NEUwMFx1NkIyMVx1NEVGQlx1NTJBMTpcdTYyNzlcdTUxQzZcdTZBMjFcdTVGMEZcdTYzMDJcdThENzdcdTdCNDlcdTVGODUgL2FwaS9hcHByb3ZlXHUzMDAyICovXHJcbiAgY29uc3QgcnVuVGFzayA9IChzZXNzaW9uSWQ6IHN0cmluZywgdGV4dDogc3RyaW5nLCBtb2RlOiBzdHJpbmcpOiBzdHJpbmcgPT4ge1xyXG4gICAgY29uc3QgcnVuSWQgPSBgcnVuLSR7RGF0ZS5ub3coKS50b1N0cmluZygzNil9LSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMiwgOCl9YDtcclxuICAgIHRvdWNoKHNlc3Npb25JZCk7XHJcbiAgICBjb25zdCBzdGVwczogQXJyYXk8KCkgPT4gdm9pZD4gPSBbXTtcclxuICAgIGNvbnN0IHdhaXQgPSAoZm46ICgpID0+IHZvaWQsIG1zID0gdGFza0RlbGF5KTogdm9pZCA9PiB7XHJcbiAgICAgIGNvbnN0IHQgPSBzZXRUaW1lb3V0KGZuLCBtcyk7XHJcbiAgICAgIHJ1blRpbWVycy5zZXQoYCR7c2Vzc2lvbklkfVxcMCR7cnVuSWR9YCwgdCk7XHJcbiAgICB9O1xyXG4gICAgY29uc3QgY2hhaW4gPSAoZm5zOiBBcnJheTwoKSA9PiB2b2lkPik6IHZvaWQgPT4ge1xyXG4gICAgICBjb25zdCBbZmlyc3QsIC4uLnJlc3RdID0gZm5zO1xyXG4gICAgICBpZiAoZmlyc3QgPT09IHVuZGVmaW5lZCkgcmV0dXJuO1xyXG4gICAgICB3YWl0KCgpID0+IHtcclxuICAgICAgICBmaXJzdCgpO1xyXG4gICAgICAgIGNoYWluKHJlc3QpO1xyXG4gICAgICB9KTtcclxuICAgIH07XHJcblxyXG4gICAgZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAncnVuLnN0YXJ0ZWQnLCB7IHRhc2s6IHRleHQsIG1vZGUgfSk7XHJcbiAgICBpZiAoZmFpbFRhc2tzKSB7XHJcbiAgICAgIHdhaXQoKCkgPT4gZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAncnVuLmZhaWxlZCcsIHtcclxuICAgICAgICBlcnJvcjogeyBjb2RlOiAnQVVUSF9GQUlMRUQnLCBtZXNzYWdlOiAnc2ltdWxhdGVkIHByb3ZpZGVyIGF1dGggZmFpbHVyZScsIHJldHJ5YWJsZTogZmFsc2UgfSxcclxuICAgICAgfSkpO1xyXG4gICAgICByZXR1cm4gcnVuSWQ7XHJcbiAgICB9XHJcblxyXG4gICAgY29uc3QgZmluaXNoUnVuID0gKGFuc3dlcjogc3RyaW5nLCB0b29sVXNlczogbnVtYmVyKTogdm9pZCA9PiB7XHJcbiAgICAgIHJ1blRpbWVycy5kZWxldGUoYCR7c2Vzc2lvbklkfVxcMCR7cnVuSWR9YCk7XHJcbiAgICAgIC8vIFx1NEVBNFx1NEVEOFx1NzI2OVx1NTE0OFx1NEU4RVx1N0VDOFx1NjAwMShcdTRFMEUgaG1oYXJuZXNzIGRlc2t0b3AgXHU2ODY1XHU1NDBDXHU1RThGOmFydGlmYWN0LmNyZWF0ZWQgXHUyMTkyIHJ1bi5jb21wbGV0ZWQpXHJcbiAgICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ2FydGlmYWN0LmNyZWF0ZWQnLCB7XHJcbiAgICAgICAgYXJ0aWZhY3Q6IHsgcmVsUGF0aDogJ291dC50eHQnLCBraW5kOiAnZmlsZScsIHRpdGxlOiAnb3V0LnR4dCcgfSxcclxuICAgICAgfSk7XHJcbiAgICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ3J1bi5jb21wbGV0ZWQnLCB7IHRleHQ6IGFuc3dlciwgdHVybnM6IDEsIHRvb2xVc2VzIH0pO1xyXG4gICAgfTtcclxuXHJcbiAgICBjb25zdCBzY3JpcHRlZDogQXJyYXk8KCkgPT4gdm9pZD4gPSBbXHJcbiAgICAgICgpID0+IGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ3Rvb2wuc3RhcnRlZCcsIHsgbmFtZTogJ3JlYWRfZmlsZScsIGFyZ3NQcmV2aWV3OiAne1wicGF0aFwiOlwiUkVBRE1FLm1kXCJ9JyB9KSxcclxuICAgICAgKCkgPT4gZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAndG9vbC5jb21wbGV0ZWQnLCB7IG5hbWU6ICdyZWFkX2ZpbGUnLCBpc0Vycm9yOiBmYWxzZSwgb3V0cHV0UHJldmlldzogJyMgZGVtbycgfSksXHJcbiAgICBdO1xyXG5cclxuICAgIGlmIChtb2RlID09PSAnYXNrJykge1xyXG4gICAgICBzY3JpcHRlZC5wdXNoKCgpID0+IHtcclxuICAgICAgICBjb25zdCBhcHByb3ZhbElkID0gYGFwLSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMiwgOCl9YDtcclxuICAgICAgICBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICdhcHByb3ZhbC5yZXF1aXJlZCcsIHtcclxuICAgICAgICAgIGFwcHJvdmFsSWQsXHJcbiAgICAgICAgICB0b29sOiAnd3JpdGVfZmlsZScsXHJcbiAgICAgICAgICBhcmdzUHJldmlldzogJ3tcInBhdGhcIjpcIm91dC50eHRcIixcImNvbnRlbnRcIjpcImhpXCJ9JyxcclxuICAgICAgICAgIHJpc2s6ICdcdTUxOTlcdTUxNjVcdTVERTVcdTRGNUNcdTUzM0FcdTY1ODdcdTRFRjYgb3V0LnR4dChcdTZBMjFcdTYyREYpJyxcclxuICAgICAgICB9KTtcclxuICAgICAgICBwZW5kaW5nID0ge1xyXG4gICAgICAgICAgc2Vzc2lvbklkLFxyXG4gICAgICAgICAgYXBwcm92YWxJZCxcclxuICAgICAgICAgIHJlc29sdmU6IChncmFudGVkKSA9PiB7XHJcbiAgICAgICAgICAgIHBlbmRpbmcgPSBudWxsO1xyXG4gICAgICAgICAgICBpZiAoZ3JhbnRlZCkge1xyXG4gICAgICAgICAgICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ3Rvb2wuc3RhcnRlZCcsIHsgbmFtZTogJ3dyaXRlX2ZpbGUnLCBhcmdzUHJldmlldzogJ3tcInBhdGhcIjpcIm91dC50eHRcIn0nIH0pO1xyXG4gICAgICAgICAgICAgIHdhaXQoKCkgPT4gZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAndG9vbC5jb21wbGV0ZWQnLCB7IG5hbWU6ICd3cml0ZV9maWxlJywgaXNFcnJvcjogZmFsc2UsIG91dHB1dFByZXZpZXc6ICd3cm90ZSAyIGJ5dGVzJyB9KSk7XHJcbiAgICAgICAgICAgICAgd2FpdCgoKSA9PiBmaW5pc2hSdW4oYGVjaG86ICR7dGV4dH0oXHU1REYyXHU2MjY3XHU4ODRDXHU1MTk5XHU1MTY1KWAsIDMpLCB0YXNrRGVsYXkgKiAyKTtcclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICBmaW5pc2hSdW4oYGVjaG86ICR7dGV4dH0oXHU1QkExXHU2Mjc5XHU4OEFCXHU2MkQyXHU3RURELFx1NjcyQVx1NjI2N1x1ODg0Q1x1NTE5OVx1NTE2NSlgLCAxKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgfSxcclxuICAgICAgICB9O1xyXG4gICAgICB9KTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgIHNjcmlwdGVkLnB1c2goKCkgPT4gZmluaXNoUnVuKGBlY2hvOiAke3RleHR9YCwgMSkpO1xyXG4gICAgfVxyXG4gICAgY2hhaW4oc2NyaXB0ZWQpO1xyXG4gICAgcmV0dXJuIHJ1bklkO1xyXG4gIH07XHJcblxyXG4gIGNvbnN0IHNlcnZlciA9IGNyZWF0ZVNlcnZlcigocmVxLCByZXMpID0+IHtcclxuICAgIGNvbnN0IHVybCA9IG5ldyBVUkwocmVxLnVybCA/PyAnLycsICdodHRwOi8vMTI3LjAuMC4xJyk7XHJcbiAgICBjb25zdCBhdXRob3JpemVkID0gcmVxLmhlYWRlcnNbJ3gtaG1oLWtleSddID09PSBleHBlY3RlZDtcclxuICAgIGNvbnN0IGRlbnkgPSAoKTogdm9pZCA9PiB7XHJcbiAgICAgIHJlcy53cml0ZUhlYWQoNDAxLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdBVVRIX0ZBSUxFRCcsICdtaXNzaW5nIG9yIGludmFsaWQgeC1obWgta2V5JywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XHJcbiAgICB9O1xyXG5cclxuICAgIGNvbnN0IHJlYWRCb2R5ID0gKCk6IFByb21pc2U8c3RyaW5nPiA9PlxyXG4gICAgICBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xyXG4gICAgICAgIGxldCBiID0gJyc7XHJcbiAgICAgICAgcmVxLm9uKCdkYXRhJywgKGM6IEJ1ZmZlcikgPT4geyBiICs9IGMudG9TdHJpbmcoKTsgfSk7XHJcbiAgICAgICAgcmVxLm9uKCdlbmQnLCAoKSA9PiByZXNvbHZlKGIpKTtcclxuICAgICAgfSk7XHJcblxyXG4gICAgaWYgKHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZXZlbnRzJykge1xyXG4gICAgICBpZiAoIWF1dGhvcml6ZWQpIHsgZGVueSgpOyByZXR1cm47IH1cclxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICd0ZXh0L2V2ZW50LXN0cmVhbScsICdjYWNoZS1jb250cm9sJzogJ25vLWNhY2hlJywgY29ubmVjdGlvbjogJ2tlZXAtYWxpdmUnIH0pO1xyXG4gICAgICByZXMuZmx1c2hIZWFkZXJzPy4oKTtcclxuICAgICAgc3NlQ2xpZW50cy5hZGQocmVzKTtcclxuICAgICAgLy8gXHU2NUFEXHU3RUJGXHU4ODY1XHU2MkM5Okxhc3QtRXZlbnQtSUQgXHU0RTRCXHU1MjREXHU3Njg0XHU1RTI3XHU1REYyXHU1NzI4XHU1QkEyXHU2MjM3XHU3QUVGLFx1OTFDRFx1NTNEMVx1NTE3Nlx1NTQwRVx1NzY4NFx1NzNBRlx1NUY2Mlx1N0YxM1x1NTFCMlxyXG4gICAgICBjb25zdCBsYXN0SWQgPSBOdW1iZXIocmVxLmhlYWRlcnNbJ2xhc3QtZXZlbnQtaWQnXSA/PyAwKTtcclxuICAgICAgaWYgKE51bWJlci5pc0Zpbml0ZShsYXN0SWQpICYmIGxhc3RJZCA+IDApIHtcclxuICAgICAgICBmb3IgKGNvbnN0IGUgb2YgcmluZykge1xyXG4gICAgICAgICAgaWYgKGUuaWQgPiBsYXN0SWQpIHJlcy53cml0ZShgaWQ6ICR7ZS5pZH1cXG5ldmVudDogJHtlLmV2ZW50fVxcbmRhdGE6ICR7SlNPTi5zdHJpbmdpZnkoZS5kYXRhKX1cXG5cXG5gKTtcclxuICAgICAgICB9XHJcbiAgICAgIH1cclxuICAgICAgcmVxLm9uKCdjbG9zZScsICgpID0+IHNzZUNsaWVudHMuZGVsZXRlKHJlcykpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAoIWF1dGhvcml6ZWQpIHsgZGVueSgpOyByZXR1cm47IH1cclxuXHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9zdGF0ZScpIHtcclxuICAgICAgLy8gcHJvdmlkZXJzRGV0YWlsOlx1NEUwRSBobWhhcm5lc3MgXHU1NDBDXHU1RjYyXHUyMDE0XHUyMDE0a2V5IFx1NTNFQVx1NTFGQSBoYXNLZXkvXHU2NzJCXHU1NkRCXHU0RjRELFx1NkMzOFx1NEUwRFx1NjYwRVx1NjU4N1xyXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcclxuICAgICAgICBkYWVtb25WZXJzaW9uOiAnZmFrZS0wLjAuMCcsIGRlc2t0b3A6IHRydWUsIG1vZGVsOiBmYWtlUHJvdmlkZXJzLmdldChmYWtlQ2hhdFByb3ZpZGVyKT8ubW9kZWwgPz8gJ2Zha2UtbW9kZWwnLFxyXG4gICAgICAgIGNoYXRQcm92aWRlcjogZmFrZUNoYXRQcm92aWRlciwgbG9jYWxlOiAnemgnLFxyXG4gICAgICAgIGJ1c3lTZXNzaW9uczogWy4uLnNlc3Npb25zLmtleXMoKV0uc2xpY2UoMCwgMiksXHJcbiAgICAgICAgYXBwcm92YWxQZW5kaW5nOiBwZW5kaW5nICE9PSBudWxsLFxyXG4gICAgICAgIHNldHRpbmdzOiB7IGFwcHJvdmFsOiAnYXNrJyB9LFxyXG4gICAgICAgIHdvcmtzcGFjZTogZmFrZVdvcmtzcGFjZXMuaXRlbXMuZmluZCgodykgPT4gdy5pZCA9PT0gZmFrZVdvcmtzcGFjZXMuY3VycmVudCkgPz8gbnVsbCxcclxuICAgICAgICBwcm92aWRlcnNEZXRhaWw6IFsuLi5mYWtlUHJvdmlkZXJzLmVudHJpZXMoKV0ubWFwKChbbmFtZSwgcF0pID0+ICh7XHJcbiAgICAgICAgICBuYW1lLCBtb2RlbDogcC5tb2RlbCwgYmFzZVVybDogcC5iYXNlVXJsLFxyXG4gICAgICAgICAgaGFzS2V5OiBwLmFwaUtleSAhPT0gJycsXHJcbiAgICAgICAgICBrZXlUYWlsOiBwLmFwaUtleS5sZW5ndGggPj0gNCA/IHAuYXBpS2V5LnNsaWNlKC00KSA6IHVuZGVmaW5lZCxcclxuICAgICAgICAgIHB1cnBvc2VzOiBbJ2NoYXQnXSxcclxuICAgICAgICB9KSksXHJcbiAgICAgIH0pKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2Rlc2t0b3Avc2h1dGRvd24nKSB7XHJcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSB9KSk7XHJcbiAgICAgIHNlcnZlci5jbG9zZSgoKSA9PiBwcm9jZXNzLmV4aXQoMCkpO1xyXG4gICAgICBzZXRUaW1lb3V0KCgpID0+IHByb2Nlc3MuZXhpdCgwKSwgMV8wMDApLnVucmVmKCk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9mYWtlL2RpZScpIHtcclxuICAgICAgLy8gXHU2RDRCXHU4QkQ1XHU5NEE5XHU1QjUwOlx1NkEyMVx1NjJERiBob3N0IFx1NUQyOVx1NkU4MyhcdTUxNDhcdTVFOTRcdTdCNTRcdTUxOERcdTkwMDBcdTUxRkEsXHU0RkREXHU4QkMxXHU1NENEXHU1RTk0XHU1REYyXHU1M0QxXHU1MUZBKVxyXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUgfSkpO1xyXG4gICAgICBzZXRUaW1lb3V0KCgpID0+IHByb2Nlc3MuZXhpdCgxKSwgNTApO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvbW9kZWwnKSB7XHJcbiAgICAgIC8vIFx1NkEyMVx1NTc4Qlx1NTIwN1x1NjM2MihcdTRFMEUgaG1oYXJuZXNzIC9hcGkvbW9kZWwgXHU1NDBDXHU1RjYyOlx1NTIwNyBjaGF0IFx1OERFRlx1NzUzMSlcclxuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7IG5hbWU/OiB1bmtub3duIH07XHJcbiAgICAgICAgY29uc3QgbmFtZSA9IHR5cGVvZiBib2R5Lm5hbWUgPT09ICdzdHJpbmcnID8gYm9keS5uYW1lLnRyaW0oKSA6ICcnO1xyXG4gICAgICAgIGlmICghZmFrZVByb3ZpZGVycy5oYXMobmFtZSkpIHtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3Byb3ZpZGVyIG5vdCBmb3VuZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xyXG4gICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBmYWtlQ2hhdFByb3ZpZGVyID0gbmFtZTtcclxuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgbW9kZWw6IGZha2VQcm92aWRlcnMuZ2V0KG5hbWUpPy5tb2RlbCB9KSk7XHJcbiAgICAgIH0pKCk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS90YXNrJykge1xyXG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7IHRleHQ/OiB1bmtub3duOyBzZXNzaW9uSWQ/OiB1bmtub3duOyBtb2RlPzogdW5rbm93bjsgYXR0YWNobWVudHM/OiB1bmtub3duOyBpbWFnZXM/OiB1bmtub3duIH07XHJcbiAgICAgICAgICBjb25zdCB0ZXh0ID0gdHlwZW9mIGJvZHkudGV4dCA9PT0gJ3N0cmluZycgPyBib2R5LnRleHQgOiAnJztcclxuICAgICAgICAgIGNvbnN0IHNlc3Npb25JZCA9IHR5cGVvZiBib2R5LnNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBib2R5LnNlc3Npb25JZCA6IGB3ZWItJHtEYXRlLm5vdygpLnRvU3RyaW5nKDM2KX1gO1xyXG4gICAgICAgICAgY29uc3QgbW9kZSA9IGJvZHkubW9kZSA9PT0gJ2FzaycgfHwgYm9keS5tb2RlID09PSAnYXV0bycgfHwgYm9keS5tb2RlID09PSAneW9sbycgPyBib2R5Lm1vZGUgOiAnYXNrJztcclxuICAgICAgICAgIGNvbnN0IGF0dGFjaG1lbnRzID0gQXJyYXkuaXNBcnJheShib2R5LmF0dGFjaG1lbnRzKSA/IGJvZHkuYXR0YWNobWVudHMuZmlsdGVyKChhKTogYSBpcyBzdHJpbmcgPT4gdHlwZW9mIGEgPT09ICdzdHJpbmcnKSA6IFtdO1xyXG4gICAgICAgICAgLy8gXHU1NkZFXHU3MjQ3XHU5NjQ0XHU0RUY2Olx1NEUwRSBobWhhcm5lc3MgdmlzaW9uIFx1NTM0Rlx1OEJBRVx1NTQwQ1x1NUY2Mih7bmFtZSxkYXRhVXJsfSk7ZmFrZSBcdTY4MjFcdTlBOENcdTVGNjJcdTcyQjZcdTUzNzNcdTY1MzZcclxuICAgICAgICAgIGNvbnN0IGltYWdlcyA9IEFycmF5LmlzQXJyYXkoYm9keS5pbWFnZXMpXHJcbiAgICAgICAgICAgID8gYm9keS5pbWFnZXMuZmlsdGVyKChpbSk6IGltIGlzIHsgbmFtZTogc3RyaW5nOyBkYXRhVXJsOiBzdHJpbmcgfSA9PiB7XHJcbiAgICAgICAgICAgICAgICBpZiAodHlwZW9mIGltICE9PSAnb2JqZWN0JyB8fCBpbSA9PT0gbnVsbCkgcmV0dXJuIGZhbHNlO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgbyA9IGltIGFzIHsgbmFtZT86IHVua25vd247IGRhdGFVcmw/OiB1bmtub3duIH07XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gdHlwZW9mIG8ubmFtZSA9PT0gJ3N0cmluZycgJiYgdHlwZW9mIG8uZGF0YVVybCA9PT0gJ3N0cmluZycgJiYgby5kYXRhVXJsLnN0YXJ0c1dpdGgoJ2RhdGE6aW1hZ2UvJyk7XHJcbiAgICAgICAgICAgICAgfSlcclxuICAgICAgICAgICAgOiBbXTtcclxuICAgICAgICAgIGlmICghdGV4dCkge1xyXG4gICAgICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3RleHQgcmVxdWlyZWQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgfVxyXG4gICAgICAgICAgLy8gXHU0RTBFIGhtaGFybmVzcyBcdTU0MENcdThCRURcdTRFNDk6XHU1NDA4XHU2Q0Q1XHU5NjQ0XHU0RUY2XHU0RUU1IFtyZWZlcmVuY2VkIGZpbGVzXSBcdTUyNERcdTdGMDBcdTVFNzZcdTUxNjVcdTRFRkJcdTUyQTFcdTY1ODdcdTY3MkM7XHJcbiAgICAgICAgICAvLyBcdTU2RkVcdTcyNDdcdTRFRTUgW2ltYWdlc10gXHU1MjREXHU3RjAwXHU2ODA3XHU2Q0U4XHU1RjIwXHU2NTcwKHZpc2lvbiBcdTYzQ0ZcdThGRjBcdTk0RkVcdTU3MjhcdTc3MUZcdTVCOUUgcnVudGltZSBcdTkxQ0NcdTUzRDFcdTc1MUYpXHJcbiAgICAgICAgICBjb25zdCBjb21wb3NlZCA9IGF0dGFjaG1lbnRzLmxlbmd0aCA+IDBcclxuICAgICAgICAgICAgPyBgW3JlZmVyZW5jZWQgZmlsZXNdXFxuJHthdHRhY2htZW50cy5tYXAoKGEpID0+IGAtICR7YS5zcGxpdCgvW1xcXFwvXS8pLnBvcCgpfWApLmpvaW4oJ1xcbicpfVxcblxcbiR7dGV4dH1gXHJcbiAgICAgICAgICAgIDogdGV4dDtcclxuICAgICAgICAgIGNvbnN0IHdpdGhJbWFnZXMgPSBpbWFnZXMubGVuZ3RoID4gMCA/IGBbaW1hZ2VzOiAke2ltYWdlcy5sZW5ndGh9XVxcbiR7Y29tcG9zZWR9YCA6IGNvbXBvc2VkO1xyXG4gICAgICAgICAgY29uc3QgcnVuSWQgPSBydW5UYXNrKHNlc3Npb25JZCwgd2l0aEltYWdlcywgbW9kZSk7XHJcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlLCBydW5JZCwgaW1hZ2VzOiBpbWFnZXMubGVuZ3RoIH0pKTtcclxuICAgICAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgU3RyaW5nKGVycikuc2xpY2UoMCwgMTIwKSwgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XHJcbiAgICAgICAgfVxyXG4gICAgICB9KSgpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvYXBwcm92ZScpIHtcclxuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7IGdyYW50ZWQ/OiB1bmtub3duOyBzZXNzaW9uSWQ/OiB1bmtub3duIH07XHJcbiAgICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIGJvZHkuc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IGJvZHkuc2Vzc2lvbklkIDogJyc7XHJcbiAgICAgICAgaWYgKHBlbmRpbmcgPT09IG51bGwgfHwgKHNpZCAhPT0gJycgJiYgcGVuZGluZy5zZXNzaW9uSWQgIT09IHNpZCkpIHtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ25vIGFwcHJvdmFsIHBlbmRpbmcnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcclxuICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgcCA9IHBlbmRpbmc7XHJcbiAgICAgICAgcGVuZGluZyA9IG51bGw7XHJcbiAgICAgICAgcC5yZXNvbHZlKGJvZHkuZ3JhbnRlZCA9PT0gdHJ1ZSk7XHJcbiAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIGdyYW50ZWQ6IGJvZHkuZ3JhbnRlZCA9PT0gdHJ1ZSB9KSk7XHJcbiAgICAgIH0pKCk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lLnN0YXJ0c1dpdGgoJy9hcGkvc2Vzc2lvbnMvJykgJiYgKHVybC5wYXRobmFtZS5lbmRzV2l0aCgnL2FyY2hpdmUnKSB8fCB1cmwucGF0aG5hbWUuZW5kc1dpdGgoJy9kZWxldGUnKSkpIHtcclxuICAgICAgLy8gXHU0RjFBXHU4QkREXHU1RjUyXHU2ODYzL1x1NTIyMFx1OTY2NChobWhhcm5lc3MgXHU1NDBDXHU1RjYyOlx1NzlGQlx1NTE2NSBhcmNoaXZlL3RyYXNoLFx1NTNFRlx1NjA2Mlx1NTkwRCxcdTRFMERcdTc4NkNcdTUyMjApXHJcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCBwYXJ0cyA9IHVybC5wYXRobmFtZS5zbGljZSgnL2FwaS9zZXNzaW9ucy8nLmxlbmd0aCkuc3BsaXQoJy8nKTtcclxuICAgICAgICBjb25zdCBvcCA9IHBhcnRzWzFdID8/ICcnO1xyXG4gICAgICAgIGNvbnN0IG9pZCA9IGRlY29kZVVSSUNvbXBvbmVudChwYXJ0c1swXSA/PyAnJykucmVwbGFjZSgvW15hLXpBLVowLTlfOi5ALV0vZywgJycpO1xyXG4gICAgICAgIGlmIChvaWQgPT09ICcnIHx8IChvcCAhPT0gJ2FyY2hpdmUnICYmIG9wICE9PSAnZGVsZXRlJykpIHtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ2JhZCBvcCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xyXG4gICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoIXNlc3Npb25zLmhhcyhvaWQpKSB7XHJcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICdzZXNzaW9uIG5vdCBmb3VuZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xyXG4gICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBzZXNzaW9ucy5kZWxldGUob2lkKTtcclxuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSB9KSk7XHJcbiAgICAgIH0pKCk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9pbmplY3QnKSB7XHJcbiAgICAgIC8vIFx1OEZEMFx1ODg0Q1x1NEUyRFx1NkNFOFx1NTE2NShcdTRFMEUgaG1oYXJuZXNzIC9hcGkvaW5qZWN0IFx1NTQwQ1x1NUY2MjtmYWtlIFx1NTNFQVx1NTZERVx1NjI2NylcclxuICAgICAgdm9pZCByZWFkQm9keSgpO1xyXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUgfSkpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvaW50ZXJydXB0Jykge1xyXG4gICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgnJykgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47IC8vIGludGVycnVwdCBcdTY1RTAgYm9keSBcdThCRURcdTRFNDlcclxuICAgICAgdm9pZCBib2R5O1xyXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUgfSkpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9zZXNzaW9ucycpIHtcclxuICAgICAgY29uc3QgbGlzdCA9IFsuLi5zZXNzaW9ucy52YWx1ZXMoKV0ubWFwKChzKSA9PiAoe1xyXG4gICAgICAgIGlkOiBzLmlkLCB0aXRsZTogJycsIHRhc2s6ICcnLCBvdXRjb21lOiAnb2snLCB0dXJuczogMSwgdG9vbFVzZXM6IDEsXHJcbiAgICAgICAgdGltZTogcy51cGRhdGVkQXQsIGN3ZDogJ0M6XFxcXGRlbW8nLCBicmFuY2g6ICcnLCBjcmVhdGVkQXQ6IHMuY3JlYXRlZEF0LCB1cGRhdGVkQXQ6IHMudXBkYXRlZEF0LFxyXG4gICAgICB9KSk7XHJcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBzZXNzaW9uczogbGlzdCwgbmV4dEN1cnNvcjogbnVsbCB9KSk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUuc3RhcnRzV2l0aCgnL2FwaS9zZXNzaW9ucy8nKSkge1xyXG4gICAgICBjb25zdCBzZWcgPSBkZWNvZGVVUklDb21wb25lbnQodXJsLnBhdGhuYW1lLnNsaWNlKCcvYXBpL3Nlc3Npb25zLycubGVuZ3RoKSk7XHJcbiAgICAgIC8vIFx1NUJGQ1x1NTFGQShcdTRFMEUgaG1oYXJuZXNzIC9hcGkvc2Vzc2lvbnMvOmlkL2V4cG9ydC5tZCBcdTU0MENcdTVGNjI6dGV4dC9tYXJrZG93biBcdTRFMEJcdThGN0QpXHJcbiAgICAgIGNvbnN0IGV4cG9ydE1hdGNoID0gL14oLiopXFwvZXhwb3J0XFwubWQkLy5leGVjKHNlZykgPz8gL14oLiopXFwuZXhwb3J0XFwubWQkLy5leGVjKHNlZyk7XHJcbiAgICAgIGlmIChleHBvcnRNYXRjaCAhPT0gbnVsbCAmJiBleHBvcnRNYXRjaFsxXSAhPT0gdW5kZWZpbmVkICYmIGV4cG9ydE1hdGNoWzFdICE9PSAnJykge1xyXG4gICAgICAgIGNvbnN0IGVpZCA9IGV4cG9ydE1hdGNoWzFdLnJlcGxhY2UoL1teYS16QS1aMC05XzouQC1dL2csICcnKTtcclxuICAgICAgICBjb25zdCBlcyA9IHNlc3Npb25zLmdldChlaWQpO1xyXG4gICAgICAgIGlmIChlcyA9PT0gdW5kZWZpbmVkKSB7XHJcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICdzZXNzaW9uIG5vdCBmb3VuZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xyXG4gICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ3RleHQvbWFya2Rvd247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgIHJlcy5lbmQoYCMgaG1oYXJuZXNzIFx1NEYxQVx1OEJERFx1NUJGQ1x1NTFGQShmYWtlKVxcblxcbi0gXHU0RjFBXHU4QkREOiR7ZWlkfVxcblxcbiMjIFx1NzUyOFx1NjIzN1xcblxcblx1NEU0Qlx1NTI0RFx1NzY4NFx1NEVGQlx1NTJBMShmYWtlIFx1OTg4NFx1ODlDOClcXG5cXG4jIyBcdTUyQTlcdTYyNEJcXG5cXG5cdThGRDlcdTY2MkZcdTVCRkNcdTUxRkFcdTc2ODRcdTU2REVcdTU5MERcdTk4ODRcdTg5QzgoZmFrZSlcdTMwMDJcXG5gKTtcclxuICAgICAgICByZXR1cm47XHJcbiAgICAgIH1cclxuICAgICAgLy8gXHU0RjFBXHU4QkREXHU5ODg0XHU4OUM4KFx1NEUwRSBobWhhcm5lc3MgR0VUIC9hcGkvc2Vzc2lvbnMvOmlkIFx1NTQwQ1x1NUY2MjpcdTY3MDBcdTU0MEUgODAgXHU2NzYxLFx1NkJDRlx1Njc2MSA1MDAgXHU1QjU3KVxyXG4gICAgICBjb25zdCBpZCA9IHNlZy5yZXBsYWNlKC9bXmEtekEtWjAtOV86LkAtXS9nLCAnJyk7XHJcbiAgICAgIGNvbnN0IHMgPSBzZXNzaW9ucy5nZXQoaWQpO1xyXG4gICAgICBpZiAocyA9PT0gdW5kZWZpbmVkKSB7XHJcbiAgICAgICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3Nlc3Npb24gbm90IGZvdW5kJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgICB9XHJcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xyXG4gICAgICAgIGlkLCBtb2RlbDogJ2Zha2UtbW9kZWwnLCBjd2Q6ICdDOlxcXFxkZW1vJyxcclxuICAgICAgICBtZXNzYWdlczogW1xyXG4gICAgICAgICAgeyByb2xlOiAndXNlcicsIHRleHQ6ICdcdTRFNEJcdTUyNERcdTc2ODRcdTRFRkJcdTUyQTEoZmFrZSBcdTk4ODRcdTg5QzgpJywgdG9vbHM6IFtdIH0sXHJcbiAgICAgICAgICB7IHJvbGU6ICdhc3Npc3RhbnQnLCB0ZXh0OiAnXHU4RkQ5XHU2NjJGXHU1Mzg2XHU1M0YyXHU0RjFBXHU4QkREXHU3Njg0XHU1NkRFXHU1OTBEXHU5ODg0XHU4OUM4KGZha2UpXHUzMDAyJywgdG9vbHM6IFsncmVhZF9maWxlJ10gfSxcclxuICAgICAgICBdLFxyXG4gICAgICB9KSk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2ZzJykge1xyXG4gICAgICAvLyBcdTc2RUVcdTVGNTVcdTZENEZcdTg5QzgoXHU0RTBFIGhtaGFybmVzcyBcdTU0MENcdTVGNjI6cGF0aCBcdTc3MDFcdTc1NjU9XHU2ODM5O2ZpbGVzPTEgXHU5NjQ0XHU1RTI2XHU2NTg3XHU0RUY2XHU1MjE3XHU4ODY4KVxyXG4gICAgICBjb25zdCBxID0gdXJsLnNlYXJjaFBhcmFtcy5nZXQoJ3BhdGgnKSA/PyAnJztcclxuICAgICAgY29uc3Qgd2l0aEZpbGVzID0gdXJsLnNlYXJjaFBhcmFtcy5nZXQoJ2ZpbGVzJykgPT09ICcxJztcclxuICAgICAgaWYgKHEgPT09ICcnKSB7XHJcbiAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcclxuICAgICAgICAgIHBhdGg6ICcnLCBzZWdtZW50czogW10sIHBhcmVudDogJycsXHJcbiAgICAgICAgICBkaXJzOiBbeyBuYW1lOiAnZGVtby13b3Jrc3BhY2UnLCBwYXRoOiAnQzpcXFxcZGVtbycgfV0sXHJcbiAgICAgICAgICAuLi4od2l0aEZpbGVzID8geyBmaWxlczogW10gfSA6IHt9KSxcclxuICAgICAgICB9KSk7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgICB9XHJcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xyXG4gICAgICAgIHBhdGg6IHEsIHNlZ21lbnRzOiBbeyBuYW1lOiBxLnNwbGl0KC9bXFxcXC9dLykuZmlsdGVyKEJvb2xlYW4pLnBvcCgpID8/IHEsIHBhdGg6IHEgfV0sIHBhcmVudDogJycsXHJcbiAgICAgICAgZGlyczogW3sgbmFtZTogJ3NyYycsIHBhdGg6IGAke3EucmVwbGFjZSgvW1xcXFwvXSQvLCAnJyl9XFxcXHNyY2AgfV0sXHJcbiAgICAgICAgLi4uKHdpdGhGaWxlcyA/IHsgZmlsZXM6IFtcclxuICAgICAgICAgIHsgbmFtZTogJ1JFQURNRS5tZCcsIHBhdGg6IGAke3EucmVwbGFjZSgvW1xcXFwvXSQvLCAnJyl9XFxcXFJFQURNRS5tZGAsIHJlbDogJ1JFQURNRS5tZCcgfSxcclxuICAgICAgICAgIHsgbmFtZTogJ3BhY2thZ2UuanNvbicsIHBhdGg6IGAke3EucmVwbGFjZSgvW1xcXFwvXSQvLCAnJyl9XFxcXHBhY2thZ2UuanNvbmAsIHJlbDogJ3BhY2thZ2UuanNvbicgfSxcclxuICAgICAgICBdIH0gOiB7fSksXHJcbiAgICAgIH0pKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZnMvcmVhZCcpIHtcclxuICAgICAgLy8gXHU2NTg3XHU0RUY2XHU5ODg0XHU4OUM4KDY0S0IgXHU0RTBBXHU5NjUwXHU4QkVEXHU0RTQ5O2Zha2UgXHU4RkQ0XHU1NkRFXHU1NkZBXHU1QjlBXHU2NTg3XHU2NzJDKVxyXG4gICAgICBjb25zdCBwID0gdXJsLnNlYXJjaFBhcmFtcy5nZXQoJ3BhdGgnKSA/PyAnJztcclxuICAgICAgaWYgKHAgPT09ICcnKSB7XHJcbiAgICAgICAgcmVzLndyaXRlSGVhZCg0MDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3BhdGggcmVxdWlyZWQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcclxuICAgICAgICByZXR1cm47XHJcbiAgICAgIH1cclxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XHJcbiAgICAgICAgcGF0aDogcCwgcmVsOiBwLnNwbGl0KC9bXFxcXC9dLykucG9wKCkgPz8gcCwgc2l6ZTogNDIsXHJcbiAgICAgICAgdGV4dDogJyMgZGVtbyB3b3Jrc3BhY2VcXG5cXG5cdThGRDlcdTY2MkYgZmFrZSBob3N0IFx1NzY4NFx1NjU4N1x1NEVGNlx1OTg4NFx1ODlDOFx1NTE4NVx1NUJCOVx1MzAwMlxcbicsXHJcbiAgICAgIH0pKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZGlmZicpIHtcclxuICAgICAgLy8gRGlmZiBcdTk3NjJcdTY3N0YoXHU0RTBFIGhtaGFybmVzcyAvYXBpL2RpZmYgXHU1NDBDXHU1RjYyO2Zha2UgXHU4RkQ0XHU1NkRFXHU1NkZBXHU1QjlBXHU1QzBGXHU1M0Q4XHU2NkY0XHU5NkM2KVxyXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcclxuICAgICAgICBnaXQ6IHRydWUsIGN3ZDogJ0M6XFxcXGRlbW8nLFxyXG4gICAgICAgIGNoYW5nZWQ6IFtcclxuICAgICAgICAgIHsgc3RhdGU6ICdNJywgcGF0aDogJ3NyYy9hcHAudHMnIH0sXHJcbiAgICAgICAgICB7IHN0YXRlOiAnQScsIHBhdGg6ICdkb2NzL25vdGVzLm1kJyB9LFxyXG4gICAgICAgIF0sXHJcbiAgICAgICAgc3RhdDogJyBzcmMvYXBwLnRzICAgICAgfCAxMiArKysrKysrLS0tXFxuIGRvY3Mvbm90ZXMubWQgICB8ICA0ICsrKytcXG4gMiBmaWxlcyBjaGFuZ2VkLCAxNiBpbnNlcnRpb25zKCspLCAzIGRlbGV0aW9ucygtKScsXHJcbiAgICAgIH0pKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvd29ya3NwYWNlcycpIHtcclxuICAgICAgLy8gXHU1REU1XHU0RjVDXHU1MzNBKFx1NEUwRSBobWhhcm5lc3MgXHU1NDBDXHU1RjYyOmN1cnJlbnQgKyBpdGVtcylcclxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XHJcbiAgICAgICAgY3VycmVudDogZmFrZVdvcmtzcGFjZXMuY3VycmVudCxcclxuICAgICAgICBpdGVtczogZmFrZVdvcmtzcGFjZXMuaXRlbXMsXHJcbiAgICAgIH0pKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3dvcmtzcGFjZXMnKSB7XHJcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgoYXdhaXQgcmVhZEJvZHkoKSkgfHwgJ3t9JykgYXMgeyBuYW1lPzogdW5rbm93bjsgcGF0aD86IHVua25vd24gfTtcclxuICAgICAgICBjb25zdCBwYXRoID0gdHlwZW9mIGJvZHkucGF0aCA9PT0gJ3N0cmluZycgPyBib2R5LnBhdGggOiAnJztcclxuICAgICAgICBjb25zdCBuYW1lID0gdHlwZW9mIGJvZHkubmFtZSA9PT0gJ3N0cmluZycgJiYgYm9keS5uYW1lICE9PSAnJyA/IGJvZHkubmFtZSA6IChwYXRoLnNwbGl0KC9bXFxcXC9dLykuZmlsdGVyKEJvb2xlYW4pLnBvcCgpID8/ICcnKTtcclxuICAgICAgICBpZiAocGF0aCA9PT0gJycgfHwgbmFtZSA9PT0gJycpIHtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ2Fic29sdXRlIHBhdGggYW5kIG5hbWUgcmVxdWlyZWQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcclxuICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKGZha2VXb3Jrc3BhY2VzLml0ZW1zLnNvbWUoKHcpID0+IHcucGF0aC50b0xvd2VyQ2FzZSgpID09PSBwYXRoLnRvTG93ZXJDYXNlKCkpKSB7XHJcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwOSwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICd3b3Jrc3BhY2UgYWxyZWFkeSByZWdpc3RlcmVkJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XHJcbiAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGl0ZW0gPSB7IGlkOiBgd3MtJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCA4KX1gLCBuYW1lLCBwYXRoIH07XHJcbiAgICAgICAgZmFrZVdvcmtzcGFjZXMuaXRlbXMucHVzaChpdGVtKTtcclxuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgY3VycmVudDogZmFrZVdvcmtzcGFjZXMuY3VycmVudCwgaXRlbXM6IGZha2VXb3Jrc3BhY2VzLml0ZW1zIH0pKTtcclxuICAgICAgfSkoKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3dvcmtzcGFjZXMvdXNlJykge1xyXG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoKGF3YWl0IHJlYWRCb2R5KCkpIHx8ICd7fScpIGFzIHsgaWQ/OiB1bmtub3duIH07XHJcbiAgICAgICAgY29uc3QgaGl0ID0gZmFrZVdvcmtzcGFjZXMuaXRlbXMuZmluZCgodykgPT4gdy5pZCA9PT0gYm9keS5pZCk7XHJcbiAgICAgICAgaWYgKGhpdCA9PT0gdW5kZWZpbmVkKSB7XHJcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICd3b3Jrc3BhY2Ugbm90IGZvdW5kJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XHJcbiAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGZha2VXb3Jrc3BhY2VzLmN1cnJlbnQgPSBoaXQuaWQ7XHJcbiAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIGN1cnJlbnQ6IGZha2VXb3Jrc3BhY2VzLmN1cnJlbnQsIGl0ZW1zOiBmYWtlV29ya3NwYWNlcy5pdGVtcyB9KSk7XHJcbiAgICAgIH0pKCk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9wcm92aWRlcnMnKSB7XHJcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgoYXdhaXQgcmVhZEJvZHkoKSkgfHwgJ3t9JykgYXMgeyBuYW1lPzogdW5rbm93bjsgYmFzZVVybD86IHVua25vd247IG1vZGVsPzogdW5rbm93bjsgYXBpS2V5PzogdW5rbm93biB9O1xyXG4gICAgICAgIGNvbnN0IG5hbWUgPSB0eXBlb2YgYm9keS5uYW1lID09PSAnc3RyaW5nJyA/IGJvZHkubmFtZS50cmltKCkgOiAnJztcclxuICAgICAgICBjb25zdCBiYXNlVXJsID0gdHlwZW9mIGJvZHkuYmFzZVVybCA9PT0gJ3N0cmluZycgPyBib2R5LmJhc2VVcmwudHJpbSgpIDogJyc7XHJcbiAgICAgICAgY29uc3QgbW9kZWwgPSB0eXBlb2YgYm9keS5tb2RlbCA9PT0gJ3N0cmluZycgPyBib2R5Lm1vZGVsLnRyaW0oKSA6ICcnO1xyXG4gICAgICAgIGlmIChuYW1lID09PSAnJyB8fCBiYXNlVXJsID09PSAnJyB8fCBtb2RlbCA9PT0gJycpIHtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ25hbWUsIGJhc2VVcmwgYW5kIG1vZGVsIGFyZSByZXF1aXJlZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xyXG4gICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBmYWtlUHJvdmlkZXJzLnNldChuYW1lLCB7IGJhc2VVcmwsIG1vZGVsLCBhcGlLZXk6IHR5cGVvZiBib2R5LmFwaUtleSA9PT0gJ3N0cmluZycgPyBib2R5LmFwaUtleSA6ICcnIH0pO1xyXG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlLCBuYW1lIH0pKTtcclxuICAgICAgfSkoKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZnMvc2VhcmNoJykge1xyXG4gICAgICAvLyBcdTVERTVcdTRGNUNcdTUzM0FcdTY1ODdcdTRFRjZcdTY0MUNcdTdEMjIoXHU0RTBFIGhtaGFybmVzcyBcdTU0MENcdTVGNjI6QFx1OTY0NFx1NEVGNlx1OTAwOVx1NjJFOVx1NTY2OFx1NzY4NFx1NjU3MFx1NjM2RVx1NkU5MClcclxuICAgICAgY29uc3QgcSA9ICh1cmwuc2VhcmNoUGFyYW1zLmdldCgncScpID8/ICcnKS50cmltKCkudG9Mb3dlckNhc2UoKTtcclxuICAgICAgY29uc3QgYWxsID0gW1xyXG4gICAgICAgIHsgcmVsOiAnUkVBRE1FLm1kJywgcGF0aDogJ0M6XFxcXGRlbW9cXFxcUkVBRE1FLm1kJywga2luZDogJ2ZpbGUnIH0sXHJcbiAgICAgICAgeyByZWw6ICdzcmMvYXBwLnRzJywgcGF0aDogJ0M6XFxcXGRlbW9cXFxcc3JjXFxcXGFwcC50cycsIGtpbmQ6ICdmaWxlJyB9LFxyXG4gICAgICAgIHsgcmVsOiAnZG9jcy9ub3Rlcy5tZCcsIHBhdGg6ICdDOlxcXFxkZW1vXFxcXGRvY3NcXFxcbm90ZXMubWQnLCBraW5kOiAnZmlsZScgfSxcclxuICAgICAgXTtcclxuICAgICAgY29uc3QgaGl0cyA9IHEgPT09ICcnID8gYWxsIDogYWxsLmZpbHRlcigoZikgPT4gZi5yZWwudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhxKSk7XHJcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyByZXN1bHRzOiBoaXRzLnNsaWNlKDAsIDIwKSwgdHJ1bmNhdGVkOiBmYWxzZSwgdG90YWw6IGhpdHMubGVuZ3RoIH0pKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvY29nbml0aXZlJykge1xyXG4gICAgICAvLyBcdThCQTRcdTc3RTVcdTcyQjZcdTYwMDEoXHU0RTBFIGhtaGFybmVzcyBjb2duaXRpdmVTdGF0dXMgXHU1NDBDXHU1RjYyXHU1QjUwXHU5NkM2O1x1N0YzQVx1NjU3MFx1NjM2RVx1NjYzRVx1NUYwRiBudWxsKVxyXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcclxuICAgICAgICBtZW1vcnk6IHsgbGF5ZXJzOiAzLCBlbnRyaWVzOiAxMiwgY29udHJhZGljdGlvbnM6IDAgfSxcclxuICAgICAgICB0cmFqZWN0b3JpZXM6IDcsXHJcbiAgICAgICAgYXVkaXRFdmVudHM6IDIxLFxyXG4gICAgICAgIHdvcmxkTW9kZWw6IHsgdmVyc2lvbjogNCwgYmVsaWVmczogOSwgdHJ1c3RlZDogNSwgYnJpZXI6IDAuMzEgfSxcclxuICAgICAgICBjYWxpYnJhdGlvbjogeyBwcmVkaWN0aW9uczogNDYsIHJlbGlhYmlsaXR5OiAwLjcyIH0sXHJcbiAgICAgIH0pKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2Zha2UvZW1pdCcpIHtcclxuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgoYXdhaXQgcmVhZEJvZHkoKSkgfHwgJ3t9JykgYXMge1xyXG4gICAgICAgICAgICBzZXNzaW9uSWQ6IHN0cmluZzsgcnVuSWQ6IHN0cmluZzsga2luZDogRXZlbnRLaW5kOyBwYXlsb2FkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcclxuICAgICAgICAgIH07XHJcbiAgICAgICAgICBjb25zdCBzZXEgPSBlbWl0KGJvZHkuc2Vzc2lvbklkLCBib2R5LnJ1bklkLCBib2R5LmtpbmQsIGJvZHkucGF5bG9hZCk7XHJcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlLCBzZXEgfSkpO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCBTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcclxuICAgICAgICB9XHJcbiAgICAgIH0pKCk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgYG5vIHJvdXRlICR7cmVxLm1ldGhvZH0gJHt1cmwucGF0aG5hbWV9YCwgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XHJcbiAgfSk7XHJcblxyXG4gIGF3YWl0IG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcclxuICAgIHNlcnZlci5vbmNlKCdlcnJvcicsIHJlamVjdCk7XHJcbiAgICBzZXJ2ZXIubGlzdGVuKDAsICcxMjcuMC4wLjEnLCAoKSA9PiByZXNvbHZlKCkpO1xyXG4gIH0pO1xyXG4gIGNvbnN0IGFkZHJlc3MgPSBzZXJ2ZXIuYWRkcmVzcygpO1xyXG4gIGlmIChhZGRyZXNzID09PSBudWxsIHx8IHR5cGVvZiBhZGRyZXNzICE9PSAnb2JqZWN0JykgdGhyb3cgbmV3IEVycm9yKCdmYWtlIGhvc3Q6IG5vIHBvcnQnKTtcclxuICBjb25zdCBwb3J0ID0gYWRkcmVzcy5wb3J0O1xyXG5cclxuICBpZiAoIW9wdHMucXVpZXQpIHtcclxuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KHsgaG1oRGVza3RvcEhvc3RSZWFkeTogdHJ1ZSwgcG9ydCwgdmVyc2lvbjogJ2Zha2UtMC4wLjAnIH0pfVxcbmApO1xyXG4gIH1cclxuICBjb25zdCBkaWVBZnRlciA9IE51bWJlcihwcm9jZXNzLmVudi5GQUtFX0hPU1RfRElFX0FGVEVSX01TID8/IDApO1xyXG4gIGlmIChOdW1iZXIuaXNGaW5pdGUoZGllQWZ0ZXIpICYmIGRpZUFmdGVyID4gMCkge1xyXG4gICAgc2V0VGltZW91dCgoKSA9PiBwcm9jZXNzLmV4aXQoMSksIGRpZUFmdGVyKS51bnJlZigpO1xyXG4gIH1cclxuXHJcbiAgLy8gY2xvc2UoKTogXHU1MTQ4XHU2NUFEXHU1RjAwXHU1MTY4XHU5MEU4IFNTRSBcdThGREVcdTYzQTUoXHU1QjgzXHU0RUVDXHU2QzM4XHU0RTBEXHU4MUVBXHU3MTM2XHU1MTczXHU5NUVEKSxcdTU0MjZcdTUyMTkgc2VydmVyLmNsb3NlXHJcbiAgLy8gXHU0RjFBXHU0RTAwXHU3NkY0XHU3QjQ5XHU2RDNCXHU4REMzXHU4RkRFXHU2M0E1LFx1NkQ0Qlx1OEJENVx1OEZEQlx1N0EwQlx1NjMwMlx1NkI3Qlx1MzAwMlxyXG4gIGNvbnN0IGNsb3NlID0gKCk6IFByb21pc2U8dm9pZD4gPT5cclxuICAgIG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlKSA9PiB7XHJcbiAgICAgIGZvciAoY29uc3QgYyBvZiBzc2VDbGllbnRzKSB7XHJcbiAgICAgICAgdHJ5IHsgYy5lbmQoKTsgYy5kZXN0cm95KCk7IH0gY2F0Y2ggeyAvKiBhbHJlYWR5IGdvbmUgKi8gfVxyXG4gICAgICB9XHJcbiAgICAgIHNzZUNsaWVudHMuY2xlYXIoKTtcclxuICAgICAgc2VydmVyLmNsb3NlKCgpID0+IHJlc29sdmUoKSk7XHJcbiAgICAgIHNldFRpbWVvdXQoKCkgPT4gcmVzb2x2ZSgpLCAxXzAwMCkudW5yZWYoKTtcclxuICAgIH0pO1xyXG5cclxuICByZXR1cm4geyBwb3J0LCBlbWl0LCBjbG9zZSB9O1xyXG59XHJcblxyXG4vLyBcdTc2RjRcdTYzQTVcdThGRDBcdTg4NEMoc3VwZXJ2aXNvciBzcGF3biBcdTc2ODRcdTVCNTBcdThGREJcdTdBMEJcdTVGNjJcdTYwMDEpXHUzMDAycmVhbHBhdGggXHU2QkQ0XHU4RjgzOm5wbSB3b3Jrc3BhY2VcclxuLy8ganVuY3Rpb24gLyBcdTU5MjdcdTVDMEZcdTUxOTlcdTVERUVcdTVGMDJcdTkwRkRcdTRFMERcdTgwRkRcdThCQTlcdThGRDlcdTRFMkFcdTY4QzBcdTZENEJcdTU5MzFcdTYyNEIoXHU1OTMxXHU2MjRCPVx1OTc1OVx1OUVEOFx1OTAwMFx1NTFGQSBjb2RlIDAsXHU5NkJFXHU2N0U1KVx1MzAwMlxyXG4vLyBjanMgYnVuZGxlKGVzYnVpbGQsXHU2MjUzXHU1MzA1XHU0RUE3XHU1NEMxKVx1NEUwQiBfX2ZpbGVuYW1lIFx1NUI1OFx1NTcyODtFU00odHN4L1x1NkU5MFx1NzgwMSlcdTc1MjggaW1wb3J0Lm1ldGFcdTMwMDJcclxuY29uc3Qgc2VsZlVybDogc3RyaW5nID0gdHlwZW9mIF9fZmlsZW5hbWUgPT09ICdzdHJpbmcnXHJcbiAgPyBwYXRoVG9GaWxlVVJMKHJlYWxwYXRoU3luYyhfX2ZpbGVuYW1lKSkuaHJlZlxyXG4gIDogaW1wb3J0Lm1ldGEudXJsO1xyXG5jb25zdCBpbnZva2VkQXNTY3JpcHQgPSAoKCkgPT4ge1xyXG4gIGlmIChwcm9jZXNzLmFyZ3ZbMV0gPT09IHVuZGVmaW5lZCkgcmV0dXJuIGZhbHNlO1xyXG4gIHRyeSB7XHJcbiAgICByZXR1cm4gc2VsZlVybCA9PT0gcGF0aFRvRmlsZVVSTChyZWFscGF0aFN5bmMocHJvY2Vzcy5hcmd2WzFdKSkuaHJlZjtcclxuICB9IGNhdGNoIHtcclxuICAgIHJldHVybiBmYWxzZTtcclxuICB9XHJcbn0pKCk7XHJcbmlmIChpbnZva2VkQXNTY3JpcHQpIHtcclxuICBjb25zdCB0b2tlbiA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1RPS0VOID8/ICcnO1xyXG4gIC8vIEZBS0VfSE9TVF9ESUVfQVRfQk9PVD0xOlx1NUYxNVx1NUJGQ1x1ODg0Q1x1OEY5M1x1NTFGQVx1NTI0RFx1NTM3M1x1NkI3QihcdTY3ODRcdTkwMjBcdTU0MkZcdTUyQThcdTY3MUYgUlVOVElNRV9DUkFTSEVEKVxyXG4gIGlmIChwcm9jZXNzLmVudi5GQUtFX0hPU1RfRElFX0FUX0JPT1QgPT09ICcxJykge1xyXG4gICAgcHJvY2Vzcy5leGl0KDEpO1xyXG4gIH1cclxuICBjb25zdCBzbG93ID0gTnVtYmVyKHByb2Nlc3MuZW52LkZBS0VfSE9TVF9TTE9XX0FGVEVSID8/IDApO1xyXG4gIGNvbnN0IGJvb3QgPSAoKTogdm9pZCA9PiB7XHJcbiAgICB2b2lkIHN0YXJ0RmFrZUhvc3QoeyB0b2tlbiB9KS5jYXRjaCgoZXJyKSA9PiB7XHJcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBmYWtlLWhvc3QgZmFpbGVkOiAke1N0cmluZyhlcnIpfVxcbmApO1xyXG4gICAgICBwcm9jZXNzLmV4aXQoMSk7XHJcbiAgICB9KTtcclxuICB9O1xyXG4gIGlmIChOdW1iZXIuaXNGaW5pdGUoc2xvdykgJiYgc2xvdyA+IDApIHNldFRpbWVvdXQoYm9vdCwgc2xvdyk7XHJcbiAgZWxzZSBib290KCk7XHJcbn1cclxuIiwgIi8qKlxyXG4gKiBVSVZFUklGWSBcdTk0QTlcdTVCNTAgXHUyMDE0XHUyMDE0IFx1OTAxMFx1NTI5Rlx1ODBGRFx1NzcxRlx1NUI5RSBVSSBcdTlBNzFcdTUyQThcdTlBOENcdTY1MzYoMjAyNi0xMC0xMCBcdTc1MjhcdTYyMzdcdTYzMDdcdTRFRTQ6XHJcbiAqIFwiXHU1QkY5XHU2QkNGXHU0RTAwXHU0RTJBXHU1MjlGXHU4MEZELFx1NkJDRlx1NEUwMFx1NEUyQVx1NEUxQVx1NTJBMVx1NkQ0MVx1N0EwQlx1NTE2OFx1OTc2Mlx1NzY4NFx1OUE4Q1x1NjUzNlwiKVx1MzAwMlxyXG4gKlxyXG4gKiBcdTc2RjRcdTYzQTVcdTVCRjlcdTZFMzJcdTY3RDNcdTU0MEVcdTc2ODQgRE9NIFx1NjVBRFx1OEEwMChcdTVFMDNcdTVDNDBcdTUxRTBcdTRGNTUvXHU1M0VGXHU4OUMxXHU2MDI3KSxcdTVFNzZcdTc1MjhcdTUzOUZcdTc1MUZcdTRFOEJcdTRFRjZcdTlBNzFcdTUyQTggUmVhY3RcclxuICogKFx1NTNEN1x1NjNBN1x1OEY5M1x1NTE2NVx1NzUyOFx1NTM5Rlx1NTc4QiBzZXR0ZXIgKyBpbnB1dCBcdTRFOEJcdTRFRjY7XHU2MzA5XHU5NEFFIGNsaWNrO1x1OTUyRVx1NzZEOFx1OEQ3MCB3aW5kb3dcclxuICoga2V5ZG93bilcdTMwMDJmYWtlIFx1NkEyMVx1NUYwRlx1OEREMVx1NUI4Q1x1NjU3NFx1NEVGQlx1NTJBMVx1OTRGRShcdTUzRDFcdTkwMDFcdTIxOTJcdTVERTVcdTUxNzdcdTIxOTJcdTVCQTFcdTYyNzlcdTIxOTJcdTRFQTRcdTRFRDhcdTcyNjlcdTIxOTJcdTZDNDdcdTYwM0IpO1xyXG4gKiByZWFsIFx1NkEyMVx1NUYwRlx1NTNFQVx1OEREMVx1NTNFQVx1OEJGQlx1NUI1MFx1OTZDNihcdTRFMERcdTUyQThcdTc3MUZcdTVCOUVcdTRGMUFcdThCRERcdTMwMDFcdTRFMERcdTcwRTcgdG9rZW4pXHUzMDAyXHJcbiAqIFx1NkJDRlx1NkI2NVx1OEY5M1x1NTFGQSBgVUlWRVJJRlkgUEFTU3xGQUlMIG5hbWUgfCBkZXRhaWxgLFx1N0VEM1x1NUMzRSBTVU1NQVJZLGV4aXQgY29kZVx1MzAwMlxyXG4gKi9cclxuaW1wb3J0IHsgYXBwLCB0eXBlIEJyb3dzZXJXaW5kb3cgfSBmcm9tICdlbGVjdHJvbic7XHJcbmltcG9ydCB7IG1rZGlyLCB3cml0ZUZpbGUgfSBmcm9tICdub2RlOmZzL3Byb21pc2VzJztcclxuaW1wb3J0IHsgam9pbiB9IGZyb20gJ25vZGU6cGF0aCc7XHJcblxyXG5jb25zdCBzbGVlcCA9IChtczogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiA9PiBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCBtcykpO1xyXG5cclxuYXN5bmMgZnVuY3Rpb24gcnVuVWlWZXJpZnkod2luOiBCcm93c2VyV2luZG93LCBtb2RlOiAnZmFrZScgfCAncmVhbCcpOiBQcm9taXNlPHZvaWQ+IHtcclxuICBjb25zdCBzaG90cyA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX1NIT1RTID8/IGpvaW4oYXBwLmdldFBhdGgoJ3RlbXAnKSwgJ2htaC11aXZlcmlmeScpO1xyXG4gIGF3YWl0IG1rZGlyKHNob3RzLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KS5jYXRjaCgoKSA9PiB1bmRlZmluZWQpO1xyXG4gIGNvbnN0IHJlc3VsdHM6IEFycmF5PFtzdHJpbmcsIGJvb2xlYW4sIHN0cmluZ10+ID0gW107XHJcbiAgbGV0IHNob3RJZHggPSAwO1xyXG5cclxuICBjb25zdCBqcyA9IDxUPihjb2RlOiBzdHJpbmcpOiBQcm9taXNlPFQ+ID0+IHdpbi53ZWJDb250ZW50cy5leGVjdXRlSmF2YVNjcmlwdChjb2RlLCB0cnVlKSBhcyBQcm9taXNlPFQ+O1xyXG4gIGNvbnN0IHN0ZXAgPSBhc3luYyAobmFtZTogc3RyaW5nLCBmbjogKCkgPT4gUHJvbWlzZTxbYm9vbGVhbiwgc3RyaW5nXT4pOiBQcm9taXNlPHZvaWQ+ID0+IHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IFtvaywgZGV0YWlsXSA9IGF3YWl0IGZuKCk7XHJcbiAgICAgIHJlc3VsdHMucHVzaChbbmFtZSwgb2ssIGRldGFpbF0pO1xyXG4gICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgIGNvbnN0IGRldGFpbCA9IGVyciBpbnN0YW5jZW9mIEVycm9yICYmIGVyci5zdGFjayAhPT0gdW5kZWZpbmVkID8gZXJyLnN0YWNrIDogU3RyaW5nKGVycik7XHJcbiAgICAgIHJlc3VsdHMucHVzaChbbmFtZSwgZmFsc2UsIGRldGFpbC5zbGljZSgwLCAzMDApXSk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBsYXN0ID0gcmVzdWx0c1tyZXN1bHRzLmxlbmd0aCAtIDFdITtcclxuICAgIGNvbnNvbGUubG9nKGBVSVZFUklGWSAke2xhc3RbMV0gPyAnUEFTUycgOiAnRkFJTCd9IHwgJHtsYXN0WzBdfSB8ICR7bGFzdFsyXX1gKTtcclxuICB9O1xyXG4gIC8qKiBcdThGNkVcdThCRTJcdTc2RjRcdTUyMzAgcHJlZGljYXRlQ29kZSBcdThGRDRcdTU2REUge29rOnRydWUsLi4ufSBcdTYyMTZcdThEODVcdTY1RjYoXHU4RkQ0XHU1NkRFXHU2NzAwXHU1NDBFXHU3Njg0IGRldGFpbClcdTMwMDIgKi9cclxuICBjb25zdCB3YWl0Rm9yID0gYXN5bmMgKGxhYmVsOiBzdHJpbmcsIHByZWRpY2F0ZUNvZGU6IHN0cmluZywgdGltZW91dE1zOiBudW1iZXIpOiBQcm9taXNlPFtib29sZWFuLCBzdHJpbmddPiA9PiB7XHJcbiAgICBjb25zdCBzdGFydGVkID0gRGF0ZS5ub3coKTtcclxuICAgIGZvciAoOzspIHtcclxuICAgICAgY29uc3QgciA9IChhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHRyeSB7IHJldHVybiBKU09OLnN0cmluZ2lmeSgoZnVuY3Rpb24oKXsgJHtwcmVkaWNhdGVDb2RlfSB9KSgpKTsgfSBjYXRjaChlKXsgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHtvazpmYWxzZSwgZGV0YWlsOlN0cmluZyhlKS5zbGljZSgwLDEyMCl9KTsgfSB9KSgpYCkpIGFzIHN0cmluZztcclxuICAgICAgbGV0IHBhcnNlZDogeyBvaz86IGJvb2xlYW47IGRldGFpbD86IHN0cmluZyB9O1xyXG4gICAgICB0cnkgeyBwYXJzZWQgPSBKU09OLnBhcnNlKHIpIGFzIHsgb2s/OiBib29sZWFuOyBkZXRhaWw/OiBzdHJpbmcgfTsgfSBjYXRjaCB7IHBhcnNlZCA9IHsgb2s6IGZhbHNlLCBkZXRhaWw6IFN0cmluZyhyKS5zbGljZSgwLCAxMjApIH07IH1cclxuICAgICAgaWYgKHBhcnNlZC5vayA9PT0gdHJ1ZSkgcmV0dXJuIFt0cnVlLCBTdHJpbmcocGFyc2VkLmRldGFpbCA/PyAnJyldO1xyXG4gICAgICBpZiAoRGF0ZS5ub3coKSAtIHN0YXJ0ZWQgPiB0aW1lb3V0TXMpIHJldHVybiBbZmFsc2UsIGAke2xhYmVsfTogJHtTdHJpbmcocGFyc2VkLmRldGFpbCA/PyAndGltZW91dCcpfWBdO1xyXG4gICAgICBhd2FpdCBzbGVlcCgyNTApO1xyXG4gICAgfVxyXG4gIH07XHJcbiAgY29uc3Qgc2hvdCA9IGFzeW5jIChsYWJlbDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiA9PiB7XHJcbiAgICBzaG90SWR4ICs9IDE7XHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCBpbWcgPSBhd2FpdCB3aW4ud2ViQ29udGVudHMuY2FwdHVyZVBhZ2UoKTtcclxuICAgICAgYXdhaXQgd3JpdGVGaWxlKGpvaW4oc2hvdHMsIGAke21vZGV9LSR7U3RyaW5nKHNob3RJZHgpLnBhZFN0YXJ0KDIsICcwJyl9LSR7bGFiZWx9LnBuZ2ApLCBpbWcudG9QTkcoKSk7XHJcbiAgICB9IGNhdGNoIHsgLyogXHU2MjJBXHU1NkZFXHU1OTMxXHU4RDI1XHU0RTBEXHU1MjI0XHU2QjdCICovIH1cclxuICB9O1xyXG5cclxuICAvKiAtLS0tIFx1NTNEN1x1NjNBN1x1OEY5M1x1NTE2NShSZWFjdDpcdTUzOUZcdTU3OEIgc2V0dGVyIFx1ODlFNlx1NTNEMSBvbkNoYW5nZSkgLS0tLSAqL1xyXG4gIGNvbnN0IHR5cGVJbnRvID0gKHNlbDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpOiBQcm9taXNlPHVua25vd24+ID0+XHJcbiAgICBqcyhgKGZ1bmN0aW9uKCl7XHJcbiAgICAgIHZhciBlbCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJHtKU09OLnN0cmluZ2lmeShzZWwpfSk7XHJcbiAgICAgIGlmICghZWwpIHJldHVybiAnTk9FTCc7XHJcbiAgICAgIHZhciBwcm90byA9IGVsLnRhZ05hbWUgPT09ICdURVhUQVJFQScgPyBIVE1MVGV4dEFyZWFFbGVtZW50LnByb3RvdHlwZSA6IEhUTUxJbnB1dEVsZW1lbnQucHJvdG90eXBlO1xyXG4gICAgICBPYmplY3QuZ2V0T3duUHJvcGVydHlEZXNjcmlwdG9yKHByb3RvLCAndmFsdWUnKS5zZXQuY2FsbChlbCwgJHtKU09OLnN0cmluZ2lmeSh0ZXh0KX0pO1xyXG4gICAgICBlbC5kaXNwYXRjaEV2ZW50KG5ldyBFdmVudCgnaW5wdXQnLCB7IGJ1YmJsZXM6IHRydWUgfSkpO1xyXG4gICAgICByZXR1cm4gJ09LJztcclxuICAgIH0pKClgKTtcclxuXHJcbiAgLyogLS0tLSBcdTU0MkZcdTUyQThcdTdCNDlcdTVGODU6UmVhY3QgXHU2MzAyXHU4RjdEICsgaG9zdCBcdTdFRkZcdTcwQjkocmVhbCBcdTc2ODQgaG1oYXJuZXNzIFx1NTFCN1x1NTQyRlx1NTJBOFx1ODk4MVx1N0YxNlx1OEJEMVxyXG4gICAgIFx1NjU3NFx1NTk1NyBDTEkgXHU0RjlEXHU4RDU2LFx1NTNFRlx1NTIzMCAzMHMrO1x1NEUwRFx1N0I0OVx1N0VGRlx1NzBCOVx1NUMzMVx1NUYwMFx1OEREMVx1NEYxQVx1NTE2OFx1OTBFOFx1OEQ4NVx1NjVGNlx1OEJFRlx1NjJBNSkgLS0tLSAqL1xyXG4gIGF3YWl0IHdhaXRGb3IoJ2hvc3QgcmVhZHknLCBgdmFyIHQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNvbXBvc2VyIHRleHRhcmVhJyk7IHJldHVybiB7b2s6ICEhdCwgZGV0YWlsOiB0ID8gJ21vdW50ZWQnIDogJ25vIGNvbXBvc2VyJ307YCwgMjBfMDAwKTtcclxuICBhd2FpdCB3YWl0Rm9yKCdob3N0IGRvdCBvbicsIGB2YXIgZD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuaG9zdC1kb3QnKTsgcmV0dXJuIHtvazogISFkICYmIGQuY2xhc3NMaXN0LmNvbnRhaW5zKCdvbicpLCBkZXRhaWw6IGQgPyBkLmNsYXNzTmFtZSA6ICdubyBkb3QnfTtgLCBtb2RlID09PSAncmVhbCcgPyA2MF8wMDAgOiAyMF8wMDApO1xyXG4gIGF3YWl0IHNsZWVwKDFfMjAwKTsgLy8gXHU0RjFBXHU4QkREXHU1MjE3XHU4ODY4L1x1OTg3Nlx1NjgwRlx1NjU3MFx1NjM2RVx1ODQzRFx1NTczMFxyXG5cclxuICAvKiogXHU3RURGXHU0RTAwXHU2NTM2XHU1QzNFOlNVTU1BUlkgKyBcdTYzMDlcdTU5MzFcdThEMjVcdTY1NzBcdTkwMDBcdTUxRkFcdTMwMDIgKi9cclxuICBjb25zdCBmaW5pc2ggPSAoKTogdm9pZCA9PiB7XHJcbiAgICBjb25zdCBmYWlsZWQgPSByZXN1bHRzLmZpbHRlcigocikgPT4gIXJbMV0pLmxlbmd0aDtcclxuICAgIGNvbnNvbGUubG9nKGBVSVZFUklGWSBTVU1NQVJZIHBhc3M9JHtyZXN1bHRzLmxlbmd0aCAtIGZhaWxlZH0vJHtyZXN1bHRzLmxlbmd0aH0gbW9kZT0ke21vZGV9IHNob3RzPSR7c2hvdHN9YCk7XHJcbiAgICBhcHAuZXhpdChmYWlsZWQgPT09IDAgPyAwIDogMSk7XHJcbiAgfTtcclxuXHJcbiAgLyogPT09PT09PT09PSBcdTRFMTNcdTc1Mjg6XHU3NzFGXHU1QjlFXHU2NkY0XHU2NUIwXHU1MTY4XHU2RDQxXHU3QTBCXHU5QThDXHU2NTM2KFx1NEVGQlx1NTJBMSAxMy1DO1x1OUE3MVx1NTJBOFx1NTY2OCAtLXVwZGF0ZS1yZWFsKVxyXG4gICAgIFx1NTI0RFx1N0Y2RSBlbnY6SE1IX0RFU0tUT1BfVVBEQVRFX0ZPUkNFX1RBRyBcdTk3NUVcdTdBN0EoXHU1RjNBXHU1MjM2XHU4OUM2XHU0RTNBXHU2NzA5XHU2NkY0XHU2NUIwLFx1NUY1M1x1NTI0RCAwLjIuOVxyXG4gICAgID09IGxhdGVzdCAwLjIuOSBcdTRFQ0RcdThENzBcdTRFMEJcdThGN0QpXHUzMDAyXHU4RDcwXHU3NzFGXHU1QjlFXHU2OEMwXHU2N0U1XHU5NEZFKGRpcmVjdCBcdTIxOTIgYXRvbWdpdCBcdTIxOTIgXHUyMDI2KVx1MjE5MiBcdTU0MEVcdTUzRjBcclxuICAgICBcdTZENDFcdTVGMEZcdTRFMEJcdThGN0RcdTc3MUZcdTVCOUUgU2V0dXAoMTEyTUIsYXRvbWdpdCBcdThENDRcdTRFQTcpXHUyMTkyIGRvd25sb2FkZWQgXHU2QTJBXHU1RTQ1XHUzMDAyXHU1M0VBXHU2NUFEXHU4QTAwXHU1QzMxXHU3RUVBLFxyXG4gICAgIFx1N0VERFx1NEUwRFx1NzBCOVx1NTFGQlwiXHU5MUNEXHU1NDJGXHU2NkY0XHU2NUIwXCIoXHU5MDdGXHU1MTREXHU2MjhBXHU1RjAwXHU1M0QxXHU2NzNBXHU3Njg0IGVsZWN0cm9uIGRpc3QgXHU4OEM1XHU1NzRGKVx1MzAwMiAqL1xyXG4gIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9VUERBVEUgPT09ICdyZWFsJykge1xyXG4gICAgYXdhaXQgc3RlcCgnXHU2NkY0XHU2NUIwKFx1NzcxRlx1NUI5RSk6XHU1NDJGXHU1MkE4IDMwcyBcdTgxRUFcdTUyQThcdTY4QzBcdTY3RTUgXHUyMTkyIGF0b21naXQvXHU5NTVDXHU1MENGXHU5MDFBXHU5MDUzXHU1NDdEXHU0RTJEIFx1MjE5MiBcdTU0MEVcdTUzRjBcdTRFMEJcdThGN0RcdThGREJcdTVFQTZcdTZBMkFcdTVFNDVcdTUxRkFcdTczQjAnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdkb3dubG9hZGluZyBvciByZWFkeSBiYW5uZXInLCBgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnVwZGF0ZS1iYW5uZXInKTtcclxuICAgICAgICBpZighYikgcmV0dXJuIHtvazpmYWxzZSwgZGV0YWlsOidubyBiYW5uZXIgeWV0J307XHJcbiAgICAgICAgdmFyIHQ9Yi50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpO1xyXG4gICAgICAgIHJldHVybiB7b2s6IHRydWUsIGRldGFpbDogdC5zbGljZSgwLDkwKX07YCwgMTUwXzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHNob3QoJ3VwZGF0ZS1yZWFsLWRvd25sb2FkaW5nJyk7XHJcbiAgICBhd2FpdCBzdGVwKCdcdTY2RjRcdTY1QjAoXHU3NzFGXHU1QjlFKToxMTJNQiBcdTZENDFcdTVGMEZcdTRFMEJcdThGN0RcdTVCOENcdTYyMTAgXHUyMTkyIFwiXHU5MUNEXHU1NDJGXHU2NkY0XHU2NUIwXCJcdTZBMkFcdTVFNDVcdTVDMzFcdTdFRUEoXHU0RTBEXHU3MEI5XHU1MUZCLFx1NEUwRFx1NUI4OVx1ODhDNSknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdyZWFkeSBiYW5uZXInLCBgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnVwZGF0ZS1iYW5uZXInKTtcclxuICAgICAgICB2YXIgYnRuPWI/Yi5xdWVyeVNlbGVjdG9yKCcudXBkYXRlLXJlc3RhcnQnKTpudWxsO1xyXG4gICAgICAgIHZhciBsaW5rcz1iP2IucXVlcnlTZWxlY3RvckFsbCgnYScpLmxlbmd0aDotMTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWJ0biAmJiBidG4uZGlzYWJsZWQ9PT1mYWxzZSAmJiBsaW5rcz09PTAsIGRldGFpbDogYiA/IGIudGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDkwKSA6ICdubyBiYW5uZXInfTtgLCA5MDBfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc2hvdCgndXBkYXRlLXJlYWwtcmVhZHknKTtcclxuICAgIGF3YWl0IHN0ZXAoJ1x1NjZGNFx1NjVCMChcdTc3MUZcdTVCOUUpOmNvbXBvc2VyL1x1NEZBN1x1NjgwRlx1NEUwRFx1NTNEN1x1NkEyQVx1NUU0NVx1NjMyNFx1NTM4QihcdTRFRkJcdTUyQTFcdTUzM0FcdTUzRUZcdTc1MjgpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKGAoZnVuY3Rpb24oKXtcclxuICAgICAgICB2YXIgdGE9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNvbXBvc2VyIHRleHRhcmVhJyksIHNiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyJyk7XHJcbiAgICAgICAgdmFyIHRyPXRhP3RhLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOm51bGw7XHJcbiAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHt0YTogISF0ciAmJiB0ci5oZWlnaHQ+MzAgJiYgdHIuYm90dG9tPD13aW5kb3cuaW5uZXJIZWlnaHQsIHNiOiAhIXNiICYmIGdldENvbXB1dGVkU3R5bGUoc2IpLmRpc3BsYXkhPT0nbm9uZSd9KTtcclxuICAgICAgfSkoKWApKSBhcyBzdHJpbmc7XHJcbiAgICAgIGNvbnN0IHAgPSBKU09OLnBhcnNlKHIpIGFzIHsgdGE6IGJvb2xlYW47IHNiOiBib29sZWFuIH07XHJcbiAgICAgIHJldHVybiBbcC50YSAmJiBwLnNiLCBgY29tcG9zZXIgXHU1M0VGXHU3NTI4PSR7cC50YX0gXHU0RkE3XHU2ODBGXHU2QjYzXHU1RTM4PSR7cC5zYn1gXTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc2hvdCgnZmluYWwnKTtcclxuICAgIGZpbmlzaCgpO1xyXG4gICAgcmV0dXJuO1xyXG4gIH1cclxuXHJcbiAgLyogPT09PT09PT09PSBcdTkwMUFcdTc1Mjg6XHU1RTAzXHU1QzQwXHU1MUUwXHU0RjU1KFx1NzUyOFx1NjIzN1x1NjJBNVx1OTY5Q1x1NzY4NFx1NzZGNFx1NjNBNVx1NjVBRFx1OEEwMCkgPT09PT09PT09PSAqL1xyXG4gIGF3YWl0IHN0ZXAoJ1x1NUUwM1x1NUM0MDpcdTY4MDdcdTk4OThcdTY4MEYrXHU0RTA5XHU2ODBGK2NvbXBvc2VyIFx1NTcyOFx1ODlDNlx1NTNFM1x1NTE4NShcdThGOTNcdTUxNjVcdTY4NDZcdTUzRUZcdTg5QzEpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgY29uc3QgciA9IChhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XHJcbiAgICAgIHZhciBxID0gZG9jdW1lbnQucXVlcnlTZWxlY3Rvci5iaW5kKGRvY3VtZW50KTtcclxuICAgICAgdmFyIHRiID0gcSgnLnRpdGxlYmFyJyksIHNoZWxsID0gcSgnLmFwcC1zaGVsbCcpLCBzYiA9IHEoJy5zaWRlYmFyJyksIHdzID0gcSgnLndvcmtzcGFjZScpLCB0YSA9IHEoJy5jb21wb3NlciB0ZXh0YXJlYScpO1xyXG4gICAgICB2YXIgbWlzc2luZyA9IFshdGIgJiYgJ3RpdGxlYmFyJywgIXNoZWxsICYmICdzaGVsbCcsICFzYiAmJiAnc2lkZWJhcicsICF3cyAmJiAnd29ya3NwYWNlJywgIXRhICYmICd0ZXh0YXJlYSddLmZpbHRlcihCb29sZWFuKS5qb2luKCcsJyk7XHJcbiAgICAgIGlmIChtaXNzaW5nICE9PSAnJykgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHtvazpmYWxzZSwgZGV0YWlsOidtaXNzaW5nOicrbWlzc2luZ30pO1xyXG4gICAgICB2YXIgciA9IHRhLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpLCB2aCA9IHdpbmRvdy5pbm5lckhlaWdodCwgdncgPSB3aW5kb3cuaW5uZXJXaWR0aDtcclxuICAgICAgdmFyIGhpbnQgPSBxKCcuZW1wdHktaGludC5iaWcnKTsgdmFyIGhyID0gaGludCA/IGhpbnQuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCkgOiBudWxsO1xyXG4gICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoeyBvazogci5oZWlnaHQgPiAzMCAmJiByLmJvdHRvbSA8PSB2aCAmJiByLndpZHRoID4gMTAwICYmIGhyICE9PSBudWxsICYmIGhyLnRvcCA+PSAwICYmIGhyLmJvdHRvbSA8PSB2aCxcclxuICAgICAgICBkZXRhaWw6ICd0ZXh0YXJlYSB5PScrTWF0aC5yb3VuZChyLnkpKycgaD0nK01hdGgucm91bmQoci5oZWlnaHQpKycgYm90dG9tPScrTWF0aC5yb3VuZChyLmJvdHRvbSkrJyB2aD0nK3ZoKyhociA/ICcgaGludCB5PScrTWF0aC5yb3VuZChoci55KSA6ICcgbm8taGludCcpIH0pO1xyXG4gICAgfSkoKWApKSBhcyBzdHJpbmc7XHJcbiAgICBjb25zdCBwID0gSlNPTi5wYXJzZShyKSBhcyB7IG9rOiBib29sZWFuOyBkZXRhaWw6IHN0cmluZyB9O1xyXG4gICAgcmV0dXJuIFtwLm9rID09PSB0cnVlLCBwLmRldGFpbF07XHJcbiAgfSk7XHJcblxyXG4gIGlmIChtb2RlID09PSAnZmFrZScpIHtcclxuICAgIC8qID09PT09PT09PT0gZmFrZShcdTU0MTFcdTVCRkNcdTY3ODRcdTkwMjAsSE1IX0RFU0tUT1BfVUlWRVJJRllfV0laQVJEPWZha2UpOlxyXG4gICAgICAgXHU0RjJBXHU5MDIwXHU2NzJBXHU5MTREXHU3RjZFXHU2MDAxIFx1MjE5MiBcdTU0MTFcdTVCRkNcdTUxRkFcdTczQjAgXHUyMTkyIFx1NjhDMFx1NkQ0QihcdTY3MkFcdTg4QzUpXHUyMTkyIFx1OTAwOVx1NjJFOSBcdTIxOTIgXHU1MTg1XHU3RjZFIFx1MjE5MiBcdThGREVcdTRFMEEgPT09PT09PT09PSAqL1xyXG4gICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX1dJWkFSRCA9PT0gJ2Zha2UnKSB7XHJcbiAgICAgIGF3YWl0IHN0ZXAoJ1x1NTQxMVx1NUJGQzpcdTk5OTZcdTU0MkZcdTVGMzlcdTUxRkFcdTZCMjJcdThGQ0VcdTk4NzUoXHU1RjAwXHU1OUNCXHU5MTREXHU3RjZFL1x1NkYxNFx1NzkzQVx1NTE2NVx1NTNFMyknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3dpemFyZCBvdmVybGF5JywgYHZhciBvPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3ZlcmxheScpO1xyXG4gICAgICAgICAgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NUYwMFx1NTlDQlx1OTE0RFx1N0Y2RSc7fSk7XHJcbiAgICAgICAgICByZXR1cm4ge29rOiAhIW8gJiYgISFiLCBkZXRhaWw6IG8gPyAnb3ZlcmxheStcdTVGMDBcdTU5Q0JcdTkxNERcdTdGNkUnIDogJ25vIG92ZXJsYXknfTtgLCAxMl8wMDApO1xyXG4gICAgICAgIGF3YWl0IHNob3QoJ3dpemFyZC13ZWxjb21lJyk7XHJcbiAgICAgICAgcmV0dXJuIHc7XHJcbiAgICAgIH0pO1xyXG4gICAgICBhd2FpdCBzdGVwKCdcdTU0MTFcdTVCRkM6XHU1RjAwXHU1OUNCXHU5MTREXHU3RjZFXHUyMTkyXHU2OEMwXHU2RDRCKFx1NEYyQVx1OTAyMFx1NjcyQVx1ODhDNSlcdTIxOTJcdTY3MkFcdTg4QzVcdTUzNzNcdTgxRUFcdTUyQThcdTVCODlcdTg4QzVcdTk4NzUoXHU4QkY0XHU2NjBFXHU2QTJBXHU1RTQ1K1x1NTIwN1x1NjM2Mlx1OTRGRVx1NjNBNSknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1RjAwXHU1OUNCXHU5MTREXHU3RjZFJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2F1dG8gaW5zdGFsbCBwYWdlJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1pbnN0YWxsJyk7XHJcbiAgICAgICAgICBpZighcCkgcmV0dXJuIHtvazpmYWxzZSwgZGV0YWlsOidub3Qgb24gaW5zdGFsbCd9O1xyXG4gICAgICAgICAgdmFyIHQ9cC50ZXh0Q29udGVudDtcclxuICAgICAgICAgIHZhciBub3RlPXQuaW5kZXhPZignXHU2NzJBXHU2OEMwXHU2RDRCXHU1MjMwIGhtaCBDTEksXHU1REYyXHU4MUVBXHU1MkE4XHU1RjAwXHU1OUNCXHU1Qjg5XHU4OEM1Jyk+PTA7XHJcbiAgICAgICAgICB2YXIgbDE9dC5pbmRleE9mKCdcdTY1MzlcdTc1MjhcdTUxODVcdTdGNkVcdTdDQkVcdTdCODBcdTUxODVcdTY4MzgnKT49MCwgbDI9dC5pbmRleE9mKCdcdTZGMTRcdTc5M0FcdTZBMjFcdTVGMEYnKT49MDtcclxuICAgICAgICAgIHZhciBiYXI9ISFwLnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtcHJvZ3Jlc3MnKTtcclxuICAgICAgICAgIHZhciBzZWw9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLXNlbGVjdCcpO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogbm90ZSYmbDEmJmwyJiZiYXImJiFzZWwsIGRldGFpbDogJ25vdGU9Jytub3RlKycgXHU1MTg1XHU3RjZFXHU5NEZFXHU2M0E1PScrbDErJyBcdTZGMTRcdTc5M0FcdTk0RkVcdTYzQTU9JytsMisnIGJhcj0nK2JhcisnIHNlbGVjdExlYWs9JyshIXNlbH07YCwgMTJfMDAwKTtcclxuICAgICAgICBhd2FpdCBzaG90KCd3aXphcmQtYXV0by1pbnN0YWxsJyk7XHJcbiAgICAgICAgcmV0dXJuIHc7XHJcbiAgICAgIH0pO1xyXG4gICAgICBhd2FpdCBzdGVwKCdcdTU0MTFcdTVCRkM6XHU2QTJBXHU1RTQ1XCJcdTY1MzlcdTc1MjhcdTUxODVcdTdGNkVcdTdDQkVcdTdCODBcdTUxODVcdTY4MzhcIlx1MjE5Mlx1OTE0RFx1N0Y2RVx1OERGM1x1OEZDN1x1MjE5Mlx1NUI4Q1x1NjIxMFx1OTg3NVx1MjE5Mlx1NUYwMFx1NTlDQlx1NEY3Rlx1NzUyOFx1MjE5Mlx1NTE3M1x1OTVFRFx1NEUxNFx1NURGMlx1OEZERVx1NjNBNScsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1wYWdlLWluc3RhbGwgLndpemFyZC1hbHQtbGluaycpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1NjUzOVx1NzUyOFx1NTE4NVx1N0Y2RVx1N0NCRVx1N0I4MFx1NTE4NVx1NjgzOCcpPj0wO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICAvLyBcdTkxNERcdTdGNkVcdTk4NzU6ZmFrZSBwcm92aWRlcnMgXHU1REYyXHU2NzA5XHU1QkM2XHU5NEE1IFx1MjE5MiBcdTgxRUFcdTUyQThcdThERjNcdThGQzc7XHU1MTVDXHU1RTk1XHU3MEI5XCJcdThERjNcdThGQzdcIlxyXG4gICAgICAgIGF3YWl0IHdhaXRGb3IoJ2NvbmZpZyBvciBkb25lJywgYHZhciBkPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1kb25lJyk7XHJcbiAgICAgICAgICBpZihkKSByZXR1cm4ge29rOnRydWUsIGRldGFpbDonZG9uZSd9O1xyXG4gICAgICAgICAgdmFyIGM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLWNvbmZpZycpO1xyXG4gICAgICAgICAgaWYoYyl7IHZhciBzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1OERGM1x1OEZDNycpPj0wO30pOyBpZihzKSBzLmNsaWNrKCk7IH1cclxuICAgICAgICAgIHJldHVybiB7b2s6ZmFsc2UsIGRldGFpbDond2FpdGluZyd9O2AsIDE1XzAwMCk7XHJcbiAgICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2RvbmUgcGFnZScsIGB2YXIgZD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtZG9uZScpO1xyXG4gICAgICAgICAgdmFyIHQ9ZD9kLnRleHRDb250ZW50OicnO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogISFkICYmIHQuaW5kZXhPZignXHU1QzMxXHU3RUVBJyk+PTAgJiYgdC5pbmRleE9mKCdcdTUxNzFcdTRFQUInKT49MCwgZGV0YWlsOiB0LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw2MCl9O2AsIDhfMDAwKTtcclxuICAgICAgICBhd2FpdCBzaG90KCd3aXphcmQtZG9uZScpO1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NUYwMFx1NTlDQlx1NEY3Rlx1NzUyOCc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgIGNvbnN0IGNsb3NlZCA9IGF3YWl0IHdhaXRGb3IoJ3dpemFyZCBjbG9zZWQgKyBjb25uZWN0ZWQnLCBgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3ZlcmxheScpICYmICEhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmhvc3QtZG90Lm9uJyksXHJcbiAgICAgICAgICBkZXRhaWw6ICdvdmVybGF5PScrKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3ZlcmxheScpPydvcGVuJzonY2xvc2VkJykrJyBkb3Q9JysoZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmhvc3QtZG90Lm9uJyk/J29uJzonb2ZmJyl9O2AsIDEwXzAwMCk7XHJcbiAgICAgICAgcmV0dXJuIFt3WzBdICYmIGNsb3NlZFswXSwgYGRvbmU6ICR7d1sxXX07ICR7Y2xvc2VkWzFdfWBdO1xyXG4gICAgICB9KTtcclxuICAgIH1cclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU5OTk2XHU4REQxXHU1RjE1XHU1QkZDXHU1QzQyID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1NUYxNVx1NUJGQ1x1NUM0MjpcdTZGMTRcdTc5M0FcdTZBMjFcdTVGMEZcdTYzRDBcdTc5M0FcdTUxRkFcdTczQjBcdTVFNzZcdTUzRUZcdTUxNzNcdTk1RUQnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdndWlkZScsIGB2YXIgZz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcucnVudGltZS1ndWlkZScpOyByZXR1cm4ge29rOiAhIWcsIGRldGFpbDogZyA/ICdzaG93bicgOiAnbm90IHNob3duJ307YCwgOF8wMDApO1xyXG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XHJcbiAgICAgICAgdmFyIGJ0bnMgPSBbXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5ydW50aW1lLWd1aWRlIGJ1dHRvbicpKTtcclxuICAgICAgICB2YXIgYiA9IGJ0bnMuZmluZChmdW5jdGlvbih4KXsgcmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU2RjE0XHU3OTNBJykgPj0gMDsgfSk7XHJcbiAgICAgICAgaWYgKGIpIGIuY2xpY2soKTtcclxuICAgICAgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignZ3VpZGUgZ29uZScsIGByZXR1cm4ge29rOiAhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnJ1bnRpbWUtZ3VpZGUnKSwgZGV0YWlsOiBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcucnVudGltZS1ndWlkZScpID8gJ3N0aWxsJyA6ICdkaXNtaXNzZWQnfTtgLCA1XzAwMCk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREKEN0cmwrTikgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnQ3RybCtOIFx1NjVCMFx1NUVGQVx1NEYxQVx1OEJERCxcdThGOTNcdTUxNjVcdTY4NDZcdTUzRUZcdTc1MjgnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J24nLCBjdHJsS2V5OnRydWUsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcigndGV4dGFyZWEgZW5hYmxlZCcsIGB2YXIgdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY29tcG9zZXIgdGV4dGFyZWEnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXQgJiYgdC5kaXNhYmxlZCA9PT0gZmFsc2UgJiYgKHQucGxhY2Vob2xkZXJ8fCcnKS5pbmRleE9mKCdcdTYzQ0ZcdThGRjBcdTc2RUVcdTY4MDcnKSA+PSAwLCBkZXRhaWw6IHQgPyAoJ2Rpc2FibGVkPScrdC5kaXNhYmxlZCsnIHBoPScrKHQucGxhY2Vob2xkZXJ8fCcnKS5zbGljZSgwLDIwKSkgOiAnbm8gdGEnfTtgLCA1XzAwMCk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU1M0QxXHU5MDAxXHU0RUZCXHU1MkExIFx1MjE5MiBcdTc1MjhcdTYyMzdcdThGNkVcdTUxRkFcdTczQjAoXHU0RTE0XHU0RUM1XHU0RTAwXHU2NzYxLFx1NTNDQ1x1NkQ4OFx1NjA2Rlx1NTZERVx1NUY1MikgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU4RjkzXHU1MTY1XHU1RTc2XHU1M0QxXHU5MDAxXHU0RUZCXHU1MkExLFx1NzUyOFx1NjIzN1x1NkQ4OFx1NjA2Rlx1NEUwQVx1NUM0Rlx1NEUxNFx1NEUwRFx1OTFDRFx1NTkwRCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQgdHlwZUludG8oJy5jb21wb3NlciB0ZXh0YXJlYScsICdcdTlBOENcdTY1MzZcdTRFRkJcdTUyQTE6XHU1MTk5XHU1MTY1XHU0RTAwXHU0RTJBXHU2NTg3XHU0RUY2Jyk7XHJcbiAgICAgIGF3YWl0IHNsZWVwKDIwMCk7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXtcclxuICAgICAgICB2YXIgYnRucyA9IFtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNvbXBvc2VyIGJ1dHRvbicpKTtcclxuICAgICAgICB2YXIgYiA9IGJ0bnMuZmluZChmdW5jdGlvbih4KXsgcmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpID09PSAnXHU1M0QxXHU5MDAxJzsgfSk7XHJcbiAgICAgICAgaWYgKGIpIGIuY2xpY2soKTtcclxuICAgICAgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignZXhhY3RseSBvbmUgdXNlciB0dXJuJywgYHZhciB0cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50dXJuLnVzZXInKSkuZmlsdGVyKGZ1bmN0aW9uKHgpeyByZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTlBOENcdTY1MzZcdTRFRkJcdTUyQTEnKSA+PSAwOyB9KTtcclxuICAgICAgICByZXR1cm4ge29rOiB0cy5sZW5ndGggPT09IDEsIGRldGFpbDogJ2NvdW50PScrdHMubGVuZ3RoKycgdGV4dD0nKyh0c1swXT90c1swXS50ZXh0Q29udGVudC5zbGljZSgwLDMwKTonbm9uZScpfTtgLCA4XzAwMCk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU1REU1XHU1MTc3XHU1MzYxKHJlYWRfZmlsZSBcdTVCOENcdTYyMTApID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1NURFNVx1NTE3N1x1NjI5OFx1NTNFMFx1NTM2MTpyZWFkX2ZpbGUgXHU2MjY3XHU4ODRDXHU1RTc2XHU1QjhDXHU2MjEwJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcigndG9vbCBjYXJkJywgYHZhciBjPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnRvb2wtY2FyZCcpKTtcclxuICAgICAgICB2YXIgZG9uZSA9IGMuZmlsdGVyKGZ1bmN0aW9uKHgpeyByZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdyZWFkX2ZpbGUnKSA+PSAwICYmIHgudGV4dENvbnRlbnQuaW5kZXhPZignIyBkZW1vJykgPj0gMDsgfSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogZG9uZS5sZW5ndGggPj0gMSwgZGV0YWlsOiAnY2FyZHM9JytjLmxlbmd0aCsnIGRvbmU9Jytkb25lLmxlbmd0aH07YCwgOF8wMDApO1xyXG4gICAgICByZXR1cm4gdztcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTVCQTFcdTYyNzlcdTdFQjVcdTUyMDdcdTcyNDcoXHU3NTI4XHU2MjM3XHU2MkE1XHU5NjlDXHU2ODM4XHU1RkMzXHU0RTRCXHU0RTAwKSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTVCQTFcdTYyNzk6YXBwcm92YWwgXHU1MzYxXHU1MUZBXHU3M0IwKFx1N0I0OVx1NUY4NVx1NEVCQVx1NURFNVx1NjI3OVx1NTFDNiknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IHNob3QoJ2FwcHJvdmFsLXBlbmRpbmcnKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2FwcHJvdmFsIGNhcmQnLCBgdmFyIGE9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmFwcHJvdmFsLWNhcmQnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWEgJiYgYS50ZXh0Q29udGVudC5pbmRleE9mKCdcdTk3MDBcdTg5ODFcdTVCQTFcdTYyNzknKSA+PSAwLCBkZXRhaWw6IGEgPyBhLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCwgNjApIDogJ25vIGFwcHJvdmFsIGNhcmQnfTtgLCA4XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ1x1NUJBMVx1NjI3OTpcdTcwQjlcdTYyNzlcdTUxQzYgXHUyMTkyIFx1NEVGQlx1NTJBMVx1N0VFN1x1N0VFRFx1NTIzMFx1NEVBNFx1NEVEOFx1NzI2OStcdTZDNDdcdTYwM0InLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXtcclxuICAgICAgICB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5hcHByb3ZhbC1jYXJkIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpeyByZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU2Mjc5XHU1MUM2JzsgfSk7XHJcbiAgICAgICAgaWYgKGIpIGIuY2xpY2soKTtcclxuICAgICAgfSkoKWApO1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignYXJ0aWZhY3Qrc3VtJywgYHZhciBhcnQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmFydGlmYWN0LWNhcmQnKTtcclxuICAgICAgICB2YXIgc3VtPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy50dXJuLXN1bScpO1xyXG4gICAgICAgIHZhciBhc3Q9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudHVybicpKS5maWx0ZXIoZnVuY3Rpb24oeCl7IHJldHVybiB4LmNsYXNzTmFtZS5pbmRleE9mKCd1c2VyJyk8MCAmJiB4LnRleHRDb250ZW50LmluZGV4T2YoJ2VjaG86Jyk+PTA7IH0pO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYXJ0ICYmICEhc3VtICYmIGFzdC5sZW5ndGg+PTEsIGRldGFpbDogJ2FydGlmYWN0PScrKGFydD9hcnQudGV4dENvbnRlbnQuc2xpY2UoMCwzMCk6J25vbmUnKSsnIHN1bT0nKyhzdW0/c3VtLnRleHRDb250ZW50Oidub25lJykrJyBhbnN3ZXJlZD0nK2FzdC5sZW5ndGh9O2AsIDEyXzAwMCk7XHJcbiAgICAgIGF3YWl0IHNob3QoJ3J1bi1jb21wbGV0ZWQnKTtcclxuICAgICAgcmV0dXJuIHc7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU1Mzg2XHU1M0YyXHU0RjFBXHU4QkREXHU1MTg1XHU1QkI5KFx1NzUyOFx1NjIzN1x1NjJBNVx1OTY5Q1wiXHU3NzBCXHU0RTBEXHU1MjMwXHU1MTg1XHU1QkI5XCIpID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1NzBCOVx1NTFGQlx1NTM4Nlx1NTNGMlx1NEYxQVx1OEJERCBcdTIxOTIgdHJhbnNjcmlwdCBcdTUxODVcdTVCQjlcdTUzRUZcdTg5QzEnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGl0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zZXNzaW9uLWl0ZW0nKTsgaWYgKGl0KSBpdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdoaXN0b3J5IHR1cm5zJywgYHZhciB0cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50dXJuJykpO1xyXG4gICAgICAgIHJldHVybiB7b2s6IHRzLmxlbmd0aCA+PSAyLCBkZXRhaWw6ICd0dXJucz0nK3RzLmxlbmd0aCsnIGZpcnN0PScrKHRzWzBdP3RzWzBdLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw0MCk6J25vbmUnKX07YCwgOF8wMDApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NEU5NFx1OTg3NVx1N0I3RSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdEb2NrOk92ZXJ2aWV3IFx1NjU3MFx1NjM2RVx1ODg0QycsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J092ZXJ2aWV3Jzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdvdmVydmlldyByb3dzJywgYHZhciByb3dzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stcm93JykpO1xyXG4gICAgICAgIHZhciB2ZXIgPSByb3dzLmZpbmQoZnVuY3Rpb24ocil7IHJldHVybiByLnRleHRDb250ZW50LmluZGV4T2YoJ3J1bnRpbWUgXHU3MjQ4XHU2NzJDJyk+PTA7IH0pO1xyXG4gICAgICAgIHJldHVybiB7b2s6IHJvd3MubGVuZ3RoID49IDUgJiYgISF2ZXIsIGRldGFpbDogJ3Jvd3M9Jytyb3dzLmxlbmd0aCsodmVyPycgdmVyPScrdmVyLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw0MCk6JycpfTtgLCA2XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ0RvY2s6RmlsZXMgXHU2RDRGXHU4OUM4K1x1NjU4N1x1NEVGNlx1OTg4NFx1ODlDOCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J1x1NjU4N1x1NEVGNid8fHgudGV4dENvbnRlbnQ9PT0nRmlsZXMnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2ZzIHJvd3MnLCBgdmFyIHJvd3M9ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmZzLXJvdycpLmxlbmd0aDtcclxuICAgICAgICByZXR1cm4ge29rOiByb3dzID49IDEsIGRldGFpbDogJ3Jvd3M9Jytyb3dzfTtgLCA2XzAwMCk7XHJcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgIC8vIFx1NjgzOVx1NzZFRVx1NUY1NVx1NTNFQVx1NjcwOVx1NURFNVx1NEY1Q1x1NTMzQVx1NzZFRVx1NUY1NShmYWtlIFx1NEUwRVx1NzcxRlx1NUI5RSBydW50aW1lIFx1NTQwQ1x1NUY2Mik6XHU1MTQ4XHU4RkRCXHU3NkVFXHU1RjU1LFx1NTE4RFx1NzBCOVx1NjU4N1x1NEVGNlxyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBkPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmZzLXJvdycpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ2RlbW8td29ya3NwYWNlJyk+PTAgfHwgeC50ZXh0Q29udGVudC5pbmRleE9mKCdcdUQ4M0RcdURDQzEnKT49MDt9KTsgaWYoZCkgZC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IHcyID0gYXdhaXQgd2FpdEZvcignZmlsZSByb3dzJywgYHZhciByb3dzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmZzLXJvdycpKTtcclxuICAgICAgICByZXR1cm4ge29rOiByb3dzLnNvbWUoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignUkVBRE1FJyk+PTA7fSksIGRldGFpbDogJ3Jvd3M9Jytyb3dzLmxlbmd0aH07YCwgNl8wMDApO1xyXG4gICAgICBpZiAoIXcyWzBdKSByZXR1cm4gdzI7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGY9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZnMtcm93JykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignUkVBRE1FJyk+PTA7fSk7IGlmKGYpIGYuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignZmlsZSBwcmV2aWV3JywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5mcy1wcmV2aWV3Jyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFwICYmIHAudGV4dENvbnRlbnQuaW5kZXhPZignZGVtbyB3b3Jrc3BhY2UnKSA+PSAwLCBkZXRhaWw6IHAgPyBwLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw0MCkgOiAnbm8gcHJldmlldyd9O2AsIDZfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnRG9jazpEaWZmIFx1NTNEOFx1NjZGNFx1ODg0QycsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J1x1NTNEOFx1NjZGNCd8fHgudGV4dENvbnRlbnQ9PT0nRGlmZic7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignZGlmZiByb3dzJywgYHZhciByb3dzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kaWZmLXJvdycpLmxlbmd0aDtcclxuICAgICAgICByZXR1cm4ge29rOiByb3dzID49IDEsIGRldGFpbDogJ2RpZmYgcm93cz0nK3Jvd3N9O2AsIDZfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnRG9jazpFdmlkZW5jZSBcdThCQTRcdTc3RTVcdTY1NzBcdTYzNkUnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdcdThCQzFcdTYzNkUnfHx4LnRleHRDb250ZW50PT09J0V2aWRlbmNlJzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdldmlkZW5jZSByb3dzJywgYHZhciByb3dzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stcm93JykpO1xyXG4gICAgICAgIHZhciBtZW0gPSByb3dzLmZpbmQoZnVuY3Rpb24ocil7IHJldHVybiByLnRleHRDb250ZW50LmluZGV4T2YoJ1x1OEJCMFx1NUZDNlx1NUM0MicpPj0wIHx8IHIudGV4dENvbnRlbnQuaW5kZXhPZignTWVtb3J5IGxheWVycycpPj0wOyB9KTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIW1lbSAmJiBtZW0udGV4dENvbnRlbnQuaW5kZXhPZignMycpID49IDAsIGRldGFpbDogbWVtID8gbWVtLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykgOiAnbm8gbWVtb3J5IHJvdyd9O2AsIDZfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnRG9jazpMb2dzIFx1OTc2Mlx1Njc3RihcdTdBN0FcdTYwMDFcdTYzRDBcdTc5M0EpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nXHU2NUU1XHU1RkQ3J3x8eC50ZXh0Q29udGVudD09PSdMb2dzJzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdsb2dzIHBhbmUnLCBgdmFyIGw9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmxvZ3MtbGlzdCcpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhbCwgZGV0YWlsOiBsID8gKCdyb3dzPScrbC5xdWVyeVNlbGVjdG9yQWxsKCcubG9nLXJvdycpLmxlbmd0aCkgOiAnbm8gbG9ncyBsaXN0J307YCwgNV8wMDApO1xyXG4gICAgICByZXR1cm4gdztcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpEb2NrOlx1OEZEQ1x1N0EwQlx1OTg3NVx1N0I3RShcdTYyNEJcdTY3M0FcdThGRENcdTdBMEJcdTYzQTdcdTUyMzZcdTk3NjJcdTY3N0YrXHU1RjAwXHU2NzNBXHU4MUVBXHU1NDJGXHU4ODRDKSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdEb2NrOlx1OEZEQ1x1N0EwQlx1OTg3NVx1N0I3RShcdTYyNEJcdTY3M0FcdThGRENcdTdBMEJcdTYzQTdcdTUyMzZcdTk3NjJcdTY3N0YpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nXHU4RkRDXHU3QTBCJ3x8eC50ZXh0Q29udGVudD09PSdSZW1vdGUnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ3JlbW90ZSBwYW5lJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5kb2NrLWJvZHknKTtcclxuICAgICAgICB2YXIgdCA9IHAgPyBwLnRleHRDb250ZW50IDogJyc7XHJcbiAgICAgICAgdmFyIG9rVCA9IHQuaW5kZXhPZignXHU2MjRCXHU2NzNBXHU4RkRDXHU3QTBCXHU2M0E3XHU1MjM2Jyk+PTAgfHwgdC5pbmRleE9mKCdQaG9uZSByZW1vdGUnKT49MDtcclxuICAgICAgICB2YXIgb2tBID0gdC5pbmRleE9mKCdcdTVGMDBcdTY3M0FcdTgxRUFcdTU0MkYnKT49MCB8fCB0LmluZGV4T2YoJ0F1dG9zdGFydCcpPj0wO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhcCAmJiBva1QgJiYgb2tBLCBkZXRhaWw6IHQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDYwKX07YCwgNl8wMDApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NjQxQ1x1N0QyMlx1OEZDN1x1NkVFNCA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTRGMUFcdThCRERcdTY0MUNcdTdEMjI6XHU4RkM3XHU2RUU0XHU3NTFGXHU2NTQ4JywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCBiZWZvcmUgPSAoYXdhaXQganMoYGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGhgKSkgYXMgbnVtYmVyO1xyXG4gICAgICBhd2FpdCB0eXBlSW50bygnLnNlc3Npb24tc2VhcmNoJywgJ3p6ei1cdTRFMERcdTVCNThcdTU3MjhcdTc2ODRcdTRGMUFcdThCREQnKTtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2ZpbHRlcmVkIGVtcHR5JywgYHZhciBuPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGg7XHJcbiAgICAgICAgcmV0dXJuIHtvazogbiA9PT0gMCwgZGV0YWlsOiAnYWZ0ZXI9JytufTtgLCA1XzAwMCk7XHJcbiAgICAgIGF3YWl0IHR5cGVJbnRvKCcuc2Vzc2lvbi1zZWFyY2gnLCAnJyk7XHJcbiAgICAgIGF3YWl0IHNsZWVwKDQwMCk7XHJcbiAgICAgIGNvbnN0IGFmdGVyID0gKGF3YWl0IGpzKGBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoYCkpIGFzIG51bWJlcjtcclxuICAgICAgcmV0dXJuIFt3WzBdICYmIGFmdGVyID09PSBiZWZvcmUsIGAke3dbMV19OyBcdTYwNjJcdTU5MERcdTU0MEUgJHthZnRlcn09PT0ke2JlZm9yZX1gXTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpDdHJsK0sgXHU1NDdEXHU0RUU0XHU5NzYyXHU2NzdGID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ0N0cmwrSyBcdTU0N0RcdTRFRTRcdTk3NjJcdTY3N0Y6XHU2MjUzXHU1RjAwXHU1RTc2XHU2MjY3XHU4ODRDXHU1NDdEXHU0RUU0JywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidrJywgY3RybEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2NtZGsgb3BlbicsIGB2YXIgYz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kaycpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYywgZGV0YWlsOiBjID8gJ29wZW4nIDogJ25vdCBvcGVuJ307YCwgNV8wMDApO1xyXG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBpdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jbWRrLWl0ZW0nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTY1ODdcdTRFRjYnKT49MCB8fCB4LnRleHRDb250ZW50LmluZGV4T2YoJ0ZpbGVzJyk+PTA7fSk7IGlmKGl0KSBpdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCd0YWIgc3dpdGNoZWQnLCBgdmFyIHQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmRvY2stdGFiLmFjdGl2ZScpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhdCAmJiAodC50ZXh0Q29udGVudD09PSdcdTY1ODdcdTRFRjYnfHx0LnRleHRDb250ZW50PT09J0ZpbGVzJyksIGRldGFpbDogJ2FjdGl2ZT0nKyh0P3QudGV4dENvbnRlbnQ6J25vbmUnKX07YCwgNV8wMDApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1OEJCRVx1N0Y2RVx1OTc2Mlx1Njc3RiA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdThCQkVcdTdGNkUoQ3RybCtTaGlmdCtQKTpQcm92aWRlciBcdTg4NjhcdTUzNTVcdTUzRUZcdTg5QzEsRXNjIFx1NTE3M1x1OTVFRCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleToncCcsIGN0cmxLZXk6dHJ1ZSwgc2hpZnRLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdzZXR0aW5ncyBvcGVuJywgYHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrLnNldHRpbmdzJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFzICYmICEhcy5xdWVyeVNlbGVjdG9yKCcucHJvdmlkZXItZm9ybScpLCBkZXRhaWw6IHMgPyAnb3Blbitmb3JtJyA6ICdub3Qgb3Blbid9O2AsIDVfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleTonRXNjYXBlJywgYnViYmxlczp0cnVlfSkpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdzZXR0aW5ncyBjbG9zZWQnLCBgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrLW92ZXJsYXknKSwgZGV0YWlsOiAnY2xvc2VkJ307YCwgNV8wMDApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOmkxOG4gXHU4QkVEXHU4QTAwXHU1MjA3XHU2MzYyID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1OEJFRFx1OEEwMFx1NTIwN1x1NjM2MjpcdTRFMkRcdTY1ODcgXHUyMTkyIEVuZ2xpc2ggXHUyMTkyIFx1NjA2Mlx1NTkwRFx1NEUyRFx1NjU4NycsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleToncCcsIGN0cmxLZXk6dHJ1ZSwgc2hpZnRLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdzZXR0aW5ncyBvcGVuJywgYHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrLnNldHRpbmdzJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFzLCBkZXRhaWw6IHMgPyAnb3BlbicgOiAnbm90IG9wZW4nfTtgLCA1XzAwMCk7XHJcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY21kay5zZXR0aW5ncyBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nRW5nbGlzaCc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBlbiA9IGF3YWl0IHdhaXRGb3IoJ2VuZ2xpc2ggc2hvd24nLCBgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXItaGVhZCAuYnRuLnByaW1hcnknKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWIgJiYgYi50ZXh0Q29udGVudCA9PT0gJysgTmV3IFNlc3Npb24nLCBkZXRhaWw6ICdidG49JysoYj9iLnRleHRDb250ZW50Oidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgICAgYXdhaXQgc2hvdCgnZW5nbGlzaCcpO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNtZGsuc2V0dGluZ3MgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NEUyRFx1NjU4Nyc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCB6aCA9IGF3YWl0IHdhaXRGb3IoJ2NoaW5lc2UgYmFjaycsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhci1oZWFkIC5idG4ucHJpbWFyeScpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYiAmJiBiLnRleHRDb250ZW50ID09PSAnKyBcdTY1QjBcdTVFRkFcdTRGMUFcdThCREQnLCBkZXRhaWw6ICdidG49JysoYj9iLnRleHRDb250ZW50Oidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleTonRXNjYXBlJywgYnViYmxlczp0cnVlfSkpYCk7XHJcbiAgICAgIHJldHVybiBbZW5bMF0gJiYgemhbMF0sIGBlbjogJHtlblsxXX07IHpoOiAke3poWzFdfWBdO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NURFNVx1NEY1Q1x1NTMzQVx1N0JBMVx1NzQwNihcdTVERTZcdTY4MEZcdTY4MEZcdTRGNEQgKyBcdTgzRENcdTUzNTUgKyBcdTY1QjBcdTVFRkFcdTRGMUFcdThCRERcdTkwMDlcdTVERTVcdTRGNUNcdTUzM0EpID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1NURFNVx1NEY1Q1x1NTMzQTpcdTVERTZcdTY4MEZcdTVERTVcdTRGNUNcdTUzM0FcdTY4MEZcdTUzRUZcdTg5QzEoXHU1RjUzXHU1MjREXHU1REU1XHU0RjVDXHU1MzNBXHU1NDBEKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ3dvcmtzcGFjZSBiYXInLCBgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndvcmtzcGFjZS1iYXInKTtcclxuICAgICAgICB2YXIgbiA9IGIgPyAoYi5xdWVyeVNlbGVjdG9yKCcud3MtYmFyLW5hbWUnKXx8e30pLnRleHRDb250ZW50IDogJyc7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFiICYmICEhbiAmJiBuLmxlbmd0aCA+IDAgJiYgbi5pbmRleE9mKCdcdTUyQTBcdThGN0QnKSA8IDAsIGRldGFpbDogJ2Jhcj0nKyhiPyd5ZXMnOidubycpKycgbmFtZT0nK259O2AsIDhfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnXHU1REU1XHU0RjVDXHU1MzNBOlx1ODNEQ1x1NTM1NVx1NUYzOVx1NTFGQSxcdTUyMTdcdTg4NjgrXHU1RjUzXHU1MjREXHU5QUQ4XHU0RUFFK1x1NkRGQlx1NTJBMFx1NTE2NVx1NTNFMztcdTU3MjhcdTYzMDdcdTVCOUFcdTVERTVcdTRGNUNcdTUzM0FcdTY1QjBcdTVFRkFcdTRGMUFcdThCREQnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndvcmtzcGFjZS1iYXInKTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCd3cyBtZW51JywgYHZhciBtPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1tZW51Jyk7XHJcbiAgICAgICAgdmFyIGl0ZW1zID0gbSA/IG0ucXVlcnlTZWxlY3RvckFsbCgnLndzLW1lbnUtaXRlbScpLmxlbmd0aCA6IDA7XHJcbiAgICAgICAgdmFyIGN1ciA9IG0gPyBtLnF1ZXJ5U2VsZWN0b3JBbGwoJy53cy1tZW51LWl0ZW0uY3VycmVudCcpLmxlbmd0aCA6IDA7XHJcbiAgICAgICAgdmFyIGFkZCA9IG0gPyAobS50ZXh0Q29udGVudC5pbmRleE9mKCdcdTZERkJcdTUyQTBcdTVERTVcdTRGNUNcdTUzM0EnKT49MCB8fCBtLnRleHRDb250ZW50LmluZGV4T2YoJ0FkZCB3b3Jrc3BhY2UnKT49MCkgOiBmYWxzZTtcclxuICAgICAgICByZXR1cm4ge29rOiBpdGVtcyA+PSAxICYmIGN1ciA+PSAxICYmIGFkZCwgZGV0YWlsOiAnaXRlbXM9JytpdGVtcysnIGN1cnJlbnQ9JytjdXIrJyBhZGQ9JythZGR9O2AsIDZfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQgc2hvdCgnd3MtbWVudScpO1xyXG4gICAgICAvLyBcdTcwQjlcdTdCMkNcdTRFMDBcdTRFMkFcdTVERTVcdTRGNUNcdTUzM0FcdTk4NzkgPSBcdTU3MjhcdThCRTVcdTVERTVcdTRGNUNcdTUzM0FcdTY1QjBcdTVFRkFcdTRGMUFcdThCREQoXHU4M0RDXHU1MzU1XHU1MTczXHU5NUVEXHUzMDAxY29tcG9zZXIgXHU1M0VGXHU3NTI4KVxyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBpdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtbWVudS1pdGVtJyk7IGlmKGl0KSBpdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IGNsb3NlZCA9IGF3YWl0IHdhaXRGb3IoJ21lbnUgY2xvc2VkICsgc2Vzc2lvbiBhY3RpdmUnLCBgdmFyIHRhPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jb21wb3NlciB0ZXh0YXJlYScpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtbWVudScpICYmICEhdGEgJiYgdGEuZGlzYWJsZWQgPT09IGZhbHNlLCBkZXRhaWw6ICdtZW51PScrKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1tZW51Jyk/J29wZW4nOidjbG9zZWQnKSsnIHRhPScrKHRhP3RhLmRpc2FibGVkOidub25lJyl9O2AsIDZfMDAwKTtcclxuICAgICAgcmV0dXJuIFtjbG9zZWRbMF0sIGAke3dbMV19OyAke2Nsb3NlZFsxXX1gXTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTRGMUFcdThCRERcdTYzMDlcdTVERTVcdTRGNUNcdTUzM0FcdTUyMDZcdTdFQzQgKyBcdTVDNTVcdTVGMDAvXHU2NTM2XHU4RDc3ID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1NEYxQVx1OEJERFx1NTIwNlx1N0VDNDpcdTdFQzRcdTU5MzRcdTUxRkFcdTczQjAoXHU1REU1XHU0RjVDXHU1MzNBXHU1NDBEK1x1NjU3MFx1OTFDRiknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdncm91cCBoZWFkJywgYHZhciBoPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1ncm91cC1oZWFkJyk7XHJcbiAgICAgICAgdmFyIG4gPSBoID8gKGgucXVlcnlTZWxlY3RvcignLndzLWdyb3VwLW5hbWUnKXx8e30pLnRleHRDb250ZW50IDogJyc7XHJcbiAgICAgICAgdmFyIGMgPSBoID8gKGgucXVlcnlTZWxlY3RvcignLndzLWdyb3VwLWNvdW50Jyl8fHt9KS50ZXh0Q29udGVudCA6ICcnO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhaCAmJiBuLmxlbmd0aCA+IDAgJiYgYy5sZW5ndGggPiAwLCBkZXRhaWw6ICduYW1lPScrbisnIGNvdW50PScrY307YCwgOF8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdcdTRGMUFcdThCRERcdTUyMDZcdTdFQzQ6XHU3MEI5XHU1MUZCXHU3RUM0XHU1OTM0XHU2NTM2XHU4RDc3LFx1NTE4RFx1NzBCOVx1NUM1NVx1NUYwMFx1NjA2Mlx1NTkwRCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgYmVmb3JlID0gKGF3YWl0IGpzKGBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoYCkpIGFzIG51bWJlcjtcclxuICAgICAgaWYgKGJlZm9yZSA9PT0gMCkgcmV0dXJuIFtmYWxzZSwgJ25vIHNlc3Npb25zIHRvIGdyb3VwJ107XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGg9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLWdyb3VwLWhlYWQnKTsgaWYoaCkgaC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IGNvbGxhcHNlZCA9IGF3YWl0IHdhaXRGb3IoJ2NvbGxhcHNlZCcsIGB2YXIgZz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtZ3JvdXAnKTtcclxuICAgICAgICB2YXIgaGlkZGVuID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aCA8ICR7YmVmb3JlfTtcclxuICAgICAgICByZXR1cm4ge29rOiBoaWRkZW4sIGRldGFpbDogJ2l0ZW1zPScrZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aCsnIGJlZm9yZT0ke2JlZm9yZX0nfTtgLCA1XzAwMCk7XHJcbiAgICAgIGF3YWl0IHNob3QoJ3dzLWdyb3VwLWNvbGxhcHNlZCcpO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBoPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1ncm91cC1oZWFkJyk7IGlmKGgpIGguY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBleHBhbmRlZCA9IGF3YWl0IHdhaXRGb3IoJ2V4cGFuZGVkIGJhY2snLCBgdmFyIG49ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aDtcclxuICAgICAgICByZXR1cm4ge29rOiBuID49ICR7YmVmb3JlfSwgZGV0YWlsOiAnaXRlbXM9JytufTtgLCA1XzAwMCk7XHJcbiAgICAgIHJldHVybiBbY29sbGFwc2VkWzBdICYmIGV4cGFuZGVkWzBdLCBgY29sbGFwc2U6ICR7Y29sbGFwc2VkWzFdfTsgZXhwYW5kOiAke2V4cGFuZGVkWzFdfWBdO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NUZFQlx1NjM3N1x1OTUyRVx1NUUyRVx1NTJBOVx1OTc2Mlx1Njc3RihDdHJsKy8pID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1NUZFQlx1NjM3N1x1OTUyRVx1NUUyRVx1NTJBOTpDdHJsKy8gXHU2MjUzXHU1RjAwLEVzYyBcdTUxNzNcdTk1RUQnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6Jy8nLCBjdHJsS2V5OnRydWUsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignc2hvcnRjdXRzIG9wZW4nLCBgdmFyIHM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNtZGsnKTtcclxuICAgICAgICB2YXIgcm93cyA9IHMgPyBzLnF1ZXJ5U2VsZWN0b3JBbGwoJy5zaG9ydGN1dC1yb3cnKS5sZW5ndGggOiAwO1xyXG4gICAgICAgIHJldHVybiB7b2s6IHJvd3MgPj0gNSwgZGV0YWlsOiAncm93cz0nK3Jvd3N9O2AsIDVfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQgc2hvdCgnc2hvcnRjdXRzJyk7XHJcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J0VzY2FwZScsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignc2hvcnRjdXRzIGNsb3NlZCcsIGByZXR1cm4ge29rOiAhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNtZGstb3ZlcmxheScpLCBkZXRhaWw6ICdjbG9zZWQnfTtgLCA1XzAwMCk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU0RkE3XHU2ODBGXHU2NTM2XHU3RjI5ICsgXHU3MkI2XHU2MDAxXHU4RkM3XHU2RUU0ID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1NEZBN1x1NjgwRlx1NjUzNlx1N0YyOTpcdTIxRTQgXHU2NTM2XHU4RDc3XHU1REU2XHU2ODBGLFx1MjFFNSBcdTVDNTVcdTVGMDBcdTYwNjJcdTU5MEQnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIC8vIEhJRyBQMyBcdTdFQzQyOlx1MjFFNC9cdTIxRTUgRW1vamkgXHU1REYyXHU2MzYyIFNWRyBpY29uLFx1NjMwOVx1OTRBRVx1NEVFNSBhcmlhLWxhYmVsKFx1NTQyQlwiXHU0RkE3XHU2ODBGXCIpXHU1QjlBXHU0RjREXHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCd0b2dnbGUgYnRuJywgYHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnRvcGJhciBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4gKHguZ2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJyl8fCcnKS5pbmRleE9mKCdcdTRGQTdcdTY4MEYnKT49MDt9KTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWIsIGRldGFpbDogJ2J0bj0nKyhiP2IuZ2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJyk6J25vbmUnKX07YCwgNV8wMDApO1xyXG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnRvcGJhciBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4gKHguZ2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJyl8fCcnKS5pbmRleE9mKCdcdTRGQTdcdTY4MEYnKT49MDt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IGhpZGRlbiA9IGF3YWl0IHdhaXRGb3IoJ3NpZGViYXIgaGlkZGVuJywgYHZhciBzYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhcicpO1xyXG4gICAgICAgIHZhciBnb25lID0gIXNiIHx8IGdldENvbXB1dGVkU3R5bGUoc2IpLmRpc3BsYXkgPT09ICdub25lJztcclxuICAgICAgICByZXR1cm4ge29rOiBnb25lLCBkZXRhaWw6ICdkaXNwbGF5PScrKHNiP2dldENvbXB1dGVkU3R5bGUoc2IpLmRpc3BsYXk6J25vbmUnKX07YCwgNV8wMDApO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnRvcGJhciBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4gKHguZ2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJyl8fCcnKS5pbmRleE9mKCdcdTRGQTdcdTY4MEYnKT49MDt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IHNob3duID0gYXdhaXQgd2FpdEZvcignc2lkZWJhciBiYWNrJywgYHZhciBzYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhcicpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhc2IgJiYgZ2V0Q29tcHV0ZWRTdHlsZShzYikuZGlzcGxheSAhPT0gJ25vbmUnLCBkZXRhaWw6ICdkaXNwbGF5PScrKHNiP2dldENvbXB1dGVkU3R5bGUoc2IpLmRpc3BsYXk6J25vbmUnKX07YCwgNV8wMDApO1xyXG4gICAgICByZXR1cm4gW2hpZGRlblswXSAmJiBzaG93blswXSwgYGhpZGU6ICR7aGlkZGVuWzFdfTsgc2hvdzogJHtzaG93blsxXX1gXTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnXHU3MkI2XHU2MDAxXHU4RkM3XHU2RUU0Olx1NEUwQlx1NjJDOVx1NTIwN1x1NjM2Mlx1NTIzMFwiXHU4RkQwXHU4ODRDXHU0RTJEXCJcdTRFMERcdTVEMjlcdTZFODNcdTVFNzZcdTYwNjJcdTU5MEQnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHNlbCA9IGF3YWl0IHdhaXRGb3IoJ2ZpbHRlciBzZWxlY3QnLCBgdmFyIHM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnN0YXR1cy1maWx0ZXInKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXMgJiYgcy5vcHRpb25zLmxlbmd0aCA+PSA0LCBkZXRhaWw6ICdvcHRpb25zPScrKHM/cy5vcHRpb25zLmxlbmd0aDowKX07YCwgNV8wMDApO1xyXG4gICAgICBpZiAoIXNlbFswXSkgcmV0dXJuIHNlbDtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgcz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc3RhdHVzLWZpbHRlcicpOyBzLnZhbHVlPSdydW5uaW5nJzsgcy5kaXNwYXRjaEV2ZW50KG5ldyBFdmVudCgnY2hhbmdlJyx7YnViYmxlczp0cnVlfSkpOyB9KSgpYCk7XHJcbiAgICAgIGF3YWl0IHNsZWVwKDUwMCk7XHJcbiAgICAgIGNvbnN0IHIxID0gKGF3YWl0IGpzKGBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoYCkpIGFzIG51bWJlcjtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgcz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc3RhdHVzLWZpbHRlcicpOyBzLnZhbHVlPSdhbGwnOyBzLmRpc3BhdGNoRXZlbnQobmV3IEV2ZW50KCdjaGFuZ2UnLHtidWJibGVzOnRydWV9KSk7IH0pKClgKTtcclxuICAgICAgYXdhaXQgc2xlZXAoNTAwKTtcclxuICAgICAgY29uc3QgcjIgPSAoYXdhaXQganMoYGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGhgKSkgYXMgbnVtYmVyO1xyXG4gICAgICByZXR1cm4gW3IyID49IHIxICYmIHIyID49IDEsIGBydW5uaW5nPSR7cjF9IGFsbD0ke3IyfWBdO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NkEyMVx1NTc4Qlx1OTAwOVx1NjJFOVx1NTY2OChcdTk4NzZcdTY4MEZcdTUyMDdcdTYzNjIgY2hhdCBcdThERUZcdTc1MzEpID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1NkEyMVx1NTc4Qlx1OTAwOVx1NjJFOVx1NTY2ODpcdTk4NzZcdTY4MEZcdTgzRENcdTUzNTVcdTUyMTdcdTUxRkEgcHJvdmlkZXJzIFx1NUU3Nlx1NTNFRlx1NTIwN1x1NjM2MicsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ21vZGVsIGJ1dHRvbicsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudG9wYmFyLW1vZGVsLmFzLWJ1dHRvbicpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYiAmJiBiLmRpc2FibGVkID09PSBmYWxzZSwgZGV0YWlsOiBiID8gYi50ZXh0Q29udGVudCA6ICdub25lJ307YCwgNl8wMDApO1xyXG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy50b3BiYXItbW9kZWwuYXMtYnV0dG9uJyk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBtID0gYXdhaXQgd2FpdEZvcignbW9kZWwgbWVudScsIGB2YXIgbT1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcubW9kZWwtbWVudScpO1xyXG4gICAgICAgIHZhciBpdGVtcyA9IG0gPyBtLnF1ZXJ5U2VsZWN0b3JBbGwoJy53cy1tZW51LWl0ZW0nKS5sZW5ndGggOiAwO1xyXG4gICAgICAgIHZhciBjdXIgPSBtID8gbS5xdWVyeVNlbGVjdG9yQWxsKCcud3MtbWVudS1pdGVtLmN1cnJlbnQnKS5sZW5ndGggOiAwO1xyXG4gICAgICAgIHJldHVybiB7b2s6IGl0ZW1zID49IDIgJiYgY3VyID49IDEsIGRldGFpbDogJ2l0ZW1zPScraXRlbXMrJyBjdXJyZW50PScrY3VyfTtgLCA1XzAwMCk7XHJcbiAgICAgIGlmICghbVswXSkgcmV0dXJuIG07XHJcbiAgICAgIGF3YWl0IHNob3QoJ21vZGVsLW1lbnUnKTtcclxuICAgICAgLy8gXHU1MjA3XHU1MjMwXHU3QjJDXHU0RThDXHU0RTJBIHByb3ZpZGVyKGZha2U6IGRlbW8tdmlzaW9uL2Zha2UtbS12aXNpb24pXHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGl0cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5tb2RlbC1tZW51IC53cy1tZW51LWl0ZW0nKSk7IHZhciBpdD1pdHNbaXRzLmxlbmd0aC0xXTsgaWYoaXQpIGl0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ21vZGVsIHN3aXRjaGVkJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy50b3BiYXItbW9kZWwuYXMtYnV0dG9uJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFiICYmIGIudGV4dENvbnRlbnQuaW5kZXhPZignZmFrZS1tLXZpc2lvbicpID49IDAsIGRldGFpbDogJ2JhZGdlPScrKGI/Yi50ZXh0Q29udGVudDonbm9uZScpfTtgLCA2XzAwMCk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU0RTNCXHU5ODk4KFx1NkQ0NVx1ODI3Mlx1NzUxRlx1NjU0OFx1MjE5Mlx1NjA2Mlx1NTkwRFx1NkRGMVx1ODI3MikgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU0RTNCXHU5ODk4Olx1OEJCRVx1N0Y2RVx1NTIwN1x1NkQ0NVx1ODI3Mlx1NzUxRlx1NjU0OCxcdTYwNjJcdTU5MERcdTZERjFcdTgyNzInLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J3AnLCBjdHJsS2V5OnRydWUsIHNoaWZ0S2V5OnRydWUsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignc2V0dGluZ3Mgb3BlbicsIGB2YXIgcz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kay5zZXR0aW5ncycpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhcywgZGV0YWlsOiBzID8gJ29wZW4nIDogJ25vdCBvcGVuJ307YCwgNV8wMDApO1xyXG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNtZGsuc2V0dGluZ3MgLnNlZyBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU2RDQ1XHU4MjcyJ3x8eC50ZXh0Q29udGVudC50cmltKCk9PT0nTGlnaHQnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgbGlnaHQgPSBhd2FpdCB3YWl0Rm9yKCdsaWdodCB0aGVtZScsIGB2YXIgZHQ9ZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LmRhdGFzZXQudGhlbWU7XHJcbiAgICAgICAgdmFyIGJnID0gZ2V0Q29tcHV0ZWRTdHlsZShkb2N1bWVudC5ib2R5KS5iYWNrZ3JvdW5kQ29sb3I7XHJcbiAgICAgICAgdmFyIG0gPSAvXFxcXGQrL2c7IHZhciBudW1zPShiZy5tYXRjaChtKXx8WycwJywnMCcsJzAnXSkubWFwKE51bWJlcik7XHJcbiAgICAgICAgcmV0dXJuIHtvazogZHQ9PT0nbGlnaHQnICYmIG51bXNbMF0+MjAwICYmIG51bXNbMV0+MjAwICYmIG51bXNbMl0+MjAwLCBkZXRhaWw6ICd0aGVtZT0nK2R0KycgYmc9JytiZ307YCwgNV8wMDApO1xyXG4gICAgICBhd2FpdCBzaG90KCdsaWdodC10aGVtZScpO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNtZGsuc2V0dGluZ3MgLnNlZyBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU2REYxXHU4MjcyJ3x8eC50ZXh0Q29udGVudC50cmltKCk9PT0nRGFyayc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBkYXJrID0gYXdhaXQgd2FpdEZvcignZGFyayBiYWNrJywgYHJldHVybiB7b2s6IGRvY3VtZW50LmRvY3VtZW50RWxlbWVudC5kYXRhc2V0LnRoZW1lPT09J2RhcmsnLCBkZXRhaWw6ICd0aGVtZT0nK2RvY3VtZW50LmRvY3VtZW50RWxlbWVudC5kYXRhc2V0LnRoZW1lfTtgLCA1XzAwMCk7XHJcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J0VzY2FwZScsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICByZXR1cm4gW2xpZ2h0WzBdICYmIGRhcmtbMF0sIGBsaWdodDogJHtsaWdodFsxXX07IGRhcms6ICR7ZGFya1sxXX1gXTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTk4NzZcdTY4MEYgXHU0RTJEL0VOIFx1NUZFQlx1NjM3N1x1NTIwN1x1NjM2MihcdTUzRUZcdTUzRDFcdTczQjBcdTYwMjcpID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1OTg3Nlx1NjgwRlx1NUZFQlx1NjM3N1x1NTIwN1x1NjM2MjpcdTRFMkQvRU4gXHU0RTAwXHU5NTJFXHU1MjA3XHU2MzYyJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignbGFuZyBzZWcnLCBgdmFyIHM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmxhbmctc2VnJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFzICYmIHMucXVlcnlTZWxlY3RvckFsbCgnYnV0dG9uJykubGVuZ3RoID09PSAyLCBkZXRhaWw6IHMgPyAncHJlc2VudCcgOiAnYWJzZW50J307YCwgNV8wMDApO1xyXG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmxhbmctc2VnIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdFTic7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBlbiA9IGF3YWl0IHdhaXRGb3IoJ2VuZ2xpc2gnLCBgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXItaGVhZCAuYnRuLnByaW1hcnknKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWIgJiYgYi50ZXh0Q29udGVudCA9PT0gJysgTmV3IFNlc3Npb24nLCBkZXRhaWw6ICdidG49JysoYj9iLnRleHRDb250ZW50Oidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5sYW5nLXNlZyBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU0RTJEJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IHpoID0gYXdhaXQgd2FpdEZvcignY2hpbmVzZSBiYWNrJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyLWhlYWQgLmJ0bi5wcmltYXJ5Jyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFiICYmIGIudGV4dENvbnRlbnQgPT09ICcrIFx1NjVCMFx1NUVGQVx1NEYxQVx1OEJERCcsIGRldGFpbDogJ2J0bj0nKyhiP2IudGV4dENvbnRlbnQ6J25vbmUnKX07YCwgNV8wMDApO1xyXG4gICAgICByZXR1cm4gW2VuWzBdICYmIHpoWzBdLCBgZW46ICR7ZW5bMV19OyB6aDogJHt6aFsxXX1gXTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTdDOThcdThEMzRcdTU2RkVcdTcyNDcgXHUyMTkyIFx1N0YyOVx1NzU2NVx1NTZGRSBjaGlwIFx1MjE5MiBcdTUzRDFcdTkwMDEgXHUyMTkyIHJ1bnRpbWUgXHU2NTM2XHU1MjMwID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1N0M5OFx1OEQzNFx1NTZGRVx1NzI0NzpcdTdGMjlcdTc1NjVcdTU2RkUgY2hpcCArIFx1NTNEMVx1OTAwMVx1NTQwRSBydW50aW1lIFx1NjUzNlx1NTIzMFx1NTZGRVx1NzI0NycsIGFzeW5jICgpID0+IHtcclxuICAgICAgLy8gXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREXHU3ODZFXHU0RkREIGNvbXBvc2VyIFx1NTNFRlx1NzUyOFxyXG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OiduJywgY3RybEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgYXdhaXQgc2xlZXAoMzAwKTtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpe1xyXG4gICAgICAgIHZhciB0YSA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jb21wb3NlciB0ZXh0YXJlYScpO1xyXG4gICAgICAgIGlmICghdGEpIHJldHVybjtcclxuICAgICAgICB2YXIgYyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2NhbnZhcycpO1xyXG4gICAgICAgIGMud2lkdGggPSA4OyBjLmhlaWdodCA9IDg7XHJcbiAgICAgICAgdmFyIGN0eCA9IGMuZ2V0Q29udGV4dCgnMmQnKTtcclxuICAgICAgICBjdHguZmlsbFN0eWxlID0gJyMzZjk2NTAnOyBjdHguZmlsbFJlY3QoMCwgMCwgOCwgOCk7XHJcbiAgICAgICAgYy50b0Jsb2IoZnVuY3Rpb24oYmxvYil7XHJcbiAgICAgICAgICB2YXIgZHQgPSBuZXcgRGF0YVRyYW5zZmVyKCk7XHJcbiAgICAgICAgICBkdC5pdGVtcy5hZGQobmV3IEZpbGUoW2Jsb2JdLCAncGFzdGVkLnBuZycsIHt0eXBlOiAnaW1hZ2UvcG5nJ30pKTtcclxuICAgICAgICAgIHRhLmRpc3BhdGNoRXZlbnQobmV3IENsaXBib2FyZEV2ZW50KCdwYXN0ZScsIHtjbGlwYm9hcmREYXRhOiBkdCwgYnViYmxlczogdHJ1ZSwgY2FuY2VsYWJsZTogdHJ1ZX0pKTtcclxuICAgICAgICB9LCAnaW1hZ2UvcG5nJyk7XHJcbiAgICAgIH0pKClgKTtcclxuICAgICAgY29uc3QgY2hpcCA9IGF3YWl0IHdhaXRGb3IoJ2ltYWdlIGNoaXAnLCBgdmFyIG49ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmF0dC1jaGlwLmltZycpLmxlbmd0aDtcclxuICAgICAgICByZXR1cm4ge29rOiBuID49IDEsIGRldGFpbDogJ2ltZyBjaGlwcz0nK259O2AsIDZfMDAwKTtcclxuICAgICAgaWYgKCFjaGlwWzBdKSByZXR1cm4gY2hpcDtcclxuICAgICAgYXdhaXQgdHlwZUludG8oJy5jb21wb3NlciB0ZXh0YXJlYScsICdcdTc3MEJcdThGRDlcdTVGMjBcdTU2RkUnKTtcclxuICAgICAgYXdhaXQgc2xlZXAoMjAwKTtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jb21wb3NlciBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1M0QxXHU5MDAxJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IGRvbmUgPSBhd2FpdCB3YWl0Rm9yKCdpbWFnZSBzZW50JywgYFxyXG4gICAgICAgIHZhciBhcCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5hcHByb3ZhbC1jYXJkIGJ1dHRvbicpO1xyXG4gICAgICAgIGlmIChhcCAmJiBhcC50ZXh0Q29udGVudC50cmltKCkuaW5kZXhPZignXHU2Mjc5XHU1MUM2Jyk+PTApIGFwLmNsaWNrKCk7XHJcbiAgICAgICAgdmFyIHRzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnR1cm4nKSk7XHJcbiAgICAgICAgdmFyIGhpdCA9IHRzLmZpbHRlcihmdW5jdGlvbih4KXsgcmV0dXJuIHguY2xhc3NOYW1lLmluZGV4T2YoJ3VzZXInKTwwICYmIHgudGV4dENvbnRlbnQuaW5kZXhPZignW2ltYWdlczogMV0nKSA+PSAwOyB9KTtcclxuICAgICAgICByZXR1cm4ge29rOiBoaXQubGVuZ3RoID49IDEsIGRldGFpbDogJ3J1bnRpbWUtZWNoby13aXRoLWltYWdlPScraGl0Lmxlbmd0aH07XHJcbiAgICAgIGAsIDE1XzAwMCk7XHJcbiAgICAgIGF3YWl0IHNob3QoJ3Bhc3RlZC1pbWFnZScpO1xyXG4gICAgICByZXR1cm4gZG9uZTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdUQ4M0RcdURDQ0UgXHU0RTBBXHU0RjIwL1x1RDgzRFx1RENDMSBcdTZENEZcdTg5QzhcdTYzMDlcdTk0QUVcdTVDMzFcdTRGNEQgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU5NjQ0XHU0RUY2XHU0RTBFXHU3NkVFXHU1RjU1XHU1MTY1XHU1M0UzOlx1RDgzRFx1RENDRSBcdTRFMEFcdTRGMjAgKyBcdUQ4M0RcdURDQzEgXHU2RDRGXHU4OUM4XHU2MzA5XHU5NEFFXHU1QjU4XHU1NzI4JywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKGAoZnVuY3Rpb24oKXtcclxuICAgICAgICB2YXIgdXAgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY29tcG9zZXIgYnV0dG9uW2FyaWEtbGFiZWwqPVwiXHU0RTBBXHU0RjIwXCJdLCAuY29tcG9zZXIgYnV0dG9uW2FyaWEtbGFiZWwqPVwiVXBsb2FkXCJdJyk7XHJcbiAgICAgICAgdmFyIGJyID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLXBpY2tlciBidXR0b24nKTtcclxuICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe3VwOiAhIXVwLCBicm93c2U6ICEhYnJ9KTtcclxuICAgICAgfSkoKWApKSBhcyBzdHJpbmc7XHJcbiAgICAgIGNvbnN0IHAgPSBKU09OLnBhcnNlKHIpIGFzIHsgdXA6IGJvb2xlYW47IGJyb3dzZTogYm9vbGVhbiB9O1xyXG4gICAgICByZXR1cm4gW3AudXAgJiYgcC5icm93c2UsIGBcdUQ4M0RcdURDQ0U9JHtwLnVwfSBcdUQ4M0RcdURDQzE9JHtwLmJyb3dzZX1gXTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpAIFx1OTY0NFx1NEVGNlx1OTAwOVx1NjJFOVx1NTY2OCA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdAIFx1OTY0NFx1NEVGNjpcdTkwMDlcdTYyRTlcdTU2NjhcdTUxRkFcdTczQjBcdTVFNzZcdTUzRUZcdTkwMDlcdTY1ODdcdTRFRjYnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY29tcG9zZXIgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J0AnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2F0dCBwaWNrZXInLCBgdmFyIHA9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmF0dC1waWNrZXInKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXAsIGRldGFpbDogcCA/ICdvcGVuJyA6ICdub3Qgb3Blbid9O2AsIDVfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQgdHlwZUludG8oJy5hdHQtcGlja2VyIGlucHV0JywgJ3JlYWQnKTtcclxuICAgICAgY29uc3QgdzIgPSBhd2FpdCB3YWl0Rm9yKCdhdHQgcmVzdWx0cycsIGB2YXIgcj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuYXR0LXJlc3VsdHMgLmZzLXJvdycpLmxlbmd0aDtcclxuICAgICAgICByZXR1cm4ge29rOiByID49IDEsIGRldGFpbDogJ3Jlc3VsdHM9JytyfTtgLCA2XzAwMCk7XHJcbiAgICAgIGlmICghdzJbMF0pIHJldHVybiB3MjtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgZj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuYXR0LXJlc3VsdHMgLmZzLXJvdycpOyBpZihmKSBmLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2F0dCBjaGlwJywgYHZhciBjPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5hdHQtY2hpcCcpLmxlbmd0aDtcclxuICAgICAgICByZXR1cm4ge29rOiBjID49IDEsIGRldGFpbDogJ2NoaXBzPScrY307YCwgNV8wMDApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlKFx1NTQxMVx1NUJGQ1x1Njc4NFx1OTAyMCk6XHU4QkJFXHU3RjZFXHUzMDBDXHU5MUNEXHU2NUIwXHU5MTREXHU3RjZFXHUzMDBEXHU5MUNEXHU1MTY1ICsgXHU5MDA5XHU2MkU5XHU2MzAxXHU0RTQ1ID09PT09PT09PT0gKi9cclxuICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9XSVpBUkQgPT09ICdmYWtlJykge1xyXG4gICAgICBhd2FpdCBzdGVwKCdcdTU0MTFcdTVCRkM6XHU4QkJFXHU3RjZFXHUzMDBDXHU5MUNEXHU2NUIwXHU5MTREXHU3RjZFXHUzMDBEXHU5MUNEXHU1MTY1ICsgXHU5MDA5XHU2MkU5XHU2MzAxXHU0RTQ1KHdpemFyZC5qc29uKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidwJywgY3RybEtleTp0cnVlLCBzaGlmdEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgICBjb25zdCBvcGVuID0gYXdhaXQgd2FpdEZvcignc2V0dGluZ3Mgb3BlbicsIGB2YXIgcz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kay5zZXR0aW5ncycpO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogISFzLCBkZXRhaWw6IHMgPyAnb3BlbicgOiAnY2xvc2VkJ307YCwgNV8wMDApO1xyXG4gICAgICAgIGlmICghb3BlblswXSkgcmV0dXJuIG9wZW47XHJcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jbWRrLnNldHRpbmdzIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1OTFDRFx1NjVCMFx1OTE0RFx1N0Y2RScpPj0wO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICBjb25zdCBzaG93biA9IGF3YWl0IHdhaXRGb3IoJ3dpemFyZCByZW9wZW5lZCcsIGByZXR1cm4ge29rOiAhIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3ZlcmxheScpLFxyXG4gICAgICAgICAgZGV0YWlsOiBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKSA/ICdvcGVuJyA6ICdjbG9zZWQnfTtgLCA1XzAwMCk7XHJcbiAgICAgICAgaWYgKCFzaG93blswXSkgcmV0dXJuIHNob3duO1xyXG4gICAgICAgIGF3YWl0IHNob3QoJ3dpemFyZC1yZWVudHJ5Jyk7XHJcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1M0Q2XHU2RDg4Jzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgY29uc3QgY2xvc2VkID0gYXdhaXQgd2FpdEZvcignd2l6YXJkIGNsb3NlZCcsIGByZXR1cm4ge29rOiAhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1vdmVybGF5JyksIGRldGFpbDogJ2Nsb3NlZCd9O2AsIDVfMDAwKTtcclxuICAgICAgICBjb25zdCBzdCA9IChhd2FpdCBqcyhgd2luZG93LmhtaC5nZXRXaXphcmQoKS50aGVuKGZ1bmN0aW9uKHIpe3JldHVybiBKU09OLnN0cmluZ2lmeShyKTt9KWApKSBhcyBzdHJpbmc7XHJcbiAgICAgICAgY29uc3QgcCA9IEpTT04ucGFyc2Uoc3QpIGFzIHsgcGVyc2lzdGVkPzogeyBkb25lPzogYm9vbGVhbjsgY2hvaWNlPzogc3RyaW5nIH0gfTtcclxuICAgICAgICBjb25zdCBwZXJzaXN0ZWQgPSBwLnBlcnNpc3RlZD8uZG9uZSA9PT0gdHJ1ZSAmJiBwLnBlcnNpc3RlZD8uY2hvaWNlID09PSAnYnVuZGxlZCc7XHJcbiAgICAgICAgcmV0dXJuIFtjbG9zZWRbMF0gJiYgcGVyc2lzdGVkLCBgY2xvc2VkPSR7Y2xvc2VkWzBdfSBwZXJzaXN0ZWQ9JHtKU09OLnN0cmluZ2lmeShwLnBlcnNpc3RlZCA/PyBudWxsKX1gXTtcclxuICAgICAgfSk7XHJcblxyXG4gICAgICAvKiA9PT09PT09PT09IGZha2UoXHU1NDExXHU1QkZDXHU2Nzg0XHU5MDIwKTpcdTdBODRcdTVDNEYgMzYwXHUwMEQ3NjQwIFx1NTE2OFx1NTE0M1x1N0QyMFx1NTNFRlx1OEZCRSArIFx1NTM1NVx1NTFGQlx1OTAwOVx1OTg3OVx1NTM3M1x1NTI0RFx1OEZEQiA9PT09PT09PT09XHJcbiAgICAgICAgIFx1NzUyOFx1NjIzN1x1NjI0Qlx1NjczQVx1NUI5RVx1NkQ0Qlx1NzVEQlx1NzBCOTpcdTdBODRcdTg5QzZcdTUzRTNcdTRFMEJcdTkwMDlcdTk4NzkvXHU2MzA5XHU5NEFFXHU4OEFCXHU4OEMxXHU1MjA3XHU3MEI5XHU0RTBEXHU1MjMwXHUzMDAyXHU0RjJBXHU5MDIwXCJcdTY4QzBcdTZENEJcdTUyMzBcdTVERjJcdTg4QzVcIlxyXG4gICAgICAgICAoXHU0RTNCXHU4RkRCXHU3QTBCIGVudiBcdTUzNzNcdTY1RjZcdThCRkIpXHU4QkE5XHU1NDExXHU1QkZDXHU1MUZBXHU3M0IwXHU0RTA5XHU5MDA5XHU5ODc5XHU4REVGXHU1Rjg0LFx1N0YyOVx1NTIzMCAzNjBcdTAwRDc2NDAgXHU1NDBFXHU5MDEwXHU0RTJBXHJcbiAgICAgICAgIGVsZW1lbnRGcm9tUG9pbnQgXHU2NUFEXHU4QTAwKFx1NEUwRFx1NjYyRlx1ODhBQlx1ODhDMVx1NTIwNyk7XHU1MThEXHU5QThDXHU4QkMxXHU1MzU1XHU1MUZCXHU1MjREXHU4RkRCXHU0RTBFXHU1M0Q2XHU2RDg4XHUzMDAyICovXHJcbiAgICAgIGF3YWl0IHN0ZXAoJ1x1NTQxMVx1NUJGQzpcdTdBODRcdTVDNEYgMzYwXHUwMEQ3NjQwXHUyMDE0XHUyMDE0XHU0RTA5XHU5MDA5XHU5ODc5KFx1NTQyQiBub3RlIFx1NjU3NFx1NjgwRilcdTRFMEVcdTYzMDlcdTk0QUVcdTUxNjhcdTkwRThcdTUzRUZcdTU0N0RcdTRFMkQrXHU1MzU1XHU1MUZCXHU1MzczXHU1MjREXHU4RkRCJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX0ZBS0VfREVURUNUX0ZPVU5EID0gJzEnO1xyXG4gICAgICAgIGNvbnN0IHNpemUwID0gd2luLmdldFNpemUoKTtcclxuICAgICAgICBjb25zdCB3MCA9IHNpemUwWzBdID8/IDEyODA7XHJcbiAgICAgICAgY29uc3QgaDAgPSBzaXplMFsxXSA/PyA4MDA7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J3AnLCBjdHJsS2V5OnRydWUsIHNoaWZ0S2V5OnRydWUsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICAgICAgY29uc3Qgb3BlbiA9IGF3YWl0IHdhaXRGb3IoJ3NldHRpbmdzIG9wZW4nLCBgdmFyIHM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNtZGsuc2V0dGluZ3MnKTsgcmV0dXJuIHtvazogISFzLCBkZXRhaWw6IHMgPyAnb3BlbicgOiAnY2xvc2VkJ307YCwgNV8wMDApO1xyXG4gICAgICAgICAgaWYgKCFvcGVuWzBdKSByZXR1cm4gb3BlbjtcclxuICAgICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY21kay5zZXR0aW5ncyBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTkxQ0RcdTY1QjBcdTkxNERcdTdGNkUnKT49MDt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgICBjb25zdCBzaG93biA9IGF3YWl0IHdhaXRGb3IoJ3dpemFyZCByZW9wZW5lZCcsIGByZXR1cm4ge29rOiAhIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3ZlcmxheScpLCBkZXRhaWw6IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3ZlcmxheScpID8gJ29wZW4nIDogJ2Nsb3NlZCd9O2AsIDVfMDAwKTtcclxuICAgICAgICAgIGlmICghc2hvd25bMF0pIHJldHVybiBzaG93bjtcclxuICAgICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NUYwMFx1NTlDQlx1OTE0RFx1N0Y2RSc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgICAgY29uc3QgZGV0ZWN0UGFnZSA9IGF3YWl0IHdhaXRGb3IoJ2RldGVjdCBmb3VuZCBwYWdlKDMgb3B0aW9ucyknLCBgdmFyIHA9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLWRldGVjdCcpO1xyXG4gICAgICAgICAgICB2YXIgb3B0cz1wP3AucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vcHQnKS5sZW5ndGg6MDtcclxuICAgICAgICAgICAgcmV0dXJuIHtvazogISFwICYmIG9wdHM9PT0zLCBkZXRhaWw6ICdvcHRzPScrb3B0c307YCwgMTJfMDAwKTtcclxuICAgICAgICAgIGlmICghZGV0ZWN0UGFnZVswXSkgcmV0dXJuIGRldGVjdFBhZ2U7XHJcbiAgICAgICAgICAvLyBcdTUzNTVcdTUxRkJcdTkwMDlcdTk4NzlcdTUzNzNcdTUyNERcdThGREI6XHU3MEI5XCJcdTRFQ0RcdTg5ODFcdTRFMEJcdThGN0RcdTY1QjBcdTcyNDhcIlx1NUU5NFx1NzZGNFx1NjNBNVx1ODQzRFx1NTIzMFx1OTAwOVx1NjJFOVx1OTg3NShcdTY1RTBcdTk3MDBcdTUxOERcdTcwQjlcIlx1NEUwQlx1NEUwMFx1NkI2NVwiKVxyXG4gICAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgbz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3B0JykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU0RUNEXHU4OTgxXHU0RTBCXHU4RjdEXHU2NUIwXHU3MjQ4Jyk+PTA7fSk7IGlmKG8pIG8uY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgICAgY29uc3Qgc2VsZWN0UGFnZSA9IGF3YWl0IHdhaXRGb3IoJ3NlbGVjdCBwYWdlIHZpYSBzaW5nbGUgY2xpY2snLCBgdmFyIHA9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLXNlbGVjdCcpO1xyXG4gICAgICAgICAgICByZXR1cm4ge29rOiAhIXAgJiYgcC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW9wdCcpLmxlbmd0aD09PTMsIGRldGFpbDogcCA/ICdzZWxlY3QnIDogJ25vdCBzZWxlY3QnfTtgLCA2XzAwMCk7XHJcbiAgICAgICAgICBpZiAoIXNlbGVjdFBhZ2VbMF0pIHJldHVybiBbZmFsc2UsIGBcdTUzNTVcdTUxRkJcdTkwMDlcdTk4NzlcdTY3MkFcdTUyNERcdThGREJcdTUyMzBcdTkwMDlcdTYyRTlcdTk4NzU6ICR7c2VsZWN0UGFnZVsxXX1gXTtcclxuICAgICAgICAgIC8vIFx1N0YyOVx1NTIzMCAzNjBcdTAwRDc2NDAobWluV2lkdGggXHU1REYyXHU1NzI4IFVJVkVSSUZZIFx1NEUwQlx1NjUzRVx1NUJCRCksXHU2NUFEXHU4QTAwXHU1MTY4XHU5MEU4XHU1M0VGXHU1NDdEXHU0RTJEXHJcbiAgICAgICAgICB3aW4uc2V0U2l6ZSgzNjAsIDY0MCk7XHJcbiAgICAgICAgICBhd2FpdCBzbGVlcCg1MDApO1xyXG4gICAgICAgICAgY29uc3QgciA9IChhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XHJcbiAgICAgICAgICAgIGZ1bmN0aW9uIGhpdChlbCl7IGVsLnNjcm9sbEludG9WaWV3KHtibG9jazonbmVhcmVzdCd9KTsgdmFyIHI9ZWwuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XHJcbiAgICAgICAgICAgICAgdmFyIHg9ci5sZWZ0K3Iud2lkdGgvMiwgeT1yLnRvcCtyLmhlaWdodC8yO1xyXG4gICAgICAgICAgICAgIHZhciBlPWRvY3VtZW50LmVsZW1lbnRGcm9tUG9pbnQoeCx5KTtcclxuICAgICAgICAgICAgICByZXR1cm4gISEoZSAmJiAoZT09PWVsIHx8IGVsLmNvbnRhaW5zKGUpKSk7IH1cclxuICAgICAgICAgICAgdmFyIGNhcmQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLXNlbGVjdCcpO1xyXG4gICAgICAgICAgICB2YXIgb3B0cz1bXS5zbGljZS5jYWxsKGNhcmQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vcHQnKSk7XHJcbiAgICAgICAgICAgIHZhciBvcHRIaXQ9b3B0cy5tYXAoaGl0KTtcclxuICAgICAgICAgICAgdmFyIG5vdGVzPVtdLnNsaWNlLmNhbGwoY2FyZC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW9wdC1ub3RlJykpO1xyXG4gICAgICAgICAgICB2YXIgbm90ZUhpdD1ub3Rlcy5tYXAoZnVuY3Rpb24obil7IG4uc2Nyb2xsSW50b1ZpZXcoe2Jsb2NrOiduZWFyZXN0J30pOyB2YXIgcj1uLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xyXG4gICAgICAgICAgICAgIHZhciBlPWRvY3VtZW50LmVsZW1lbnRGcm9tUG9pbnQoci5sZWZ0K3Iud2lkdGgvMiwgci50b3ArTWF0aC5taW4oci5oZWlnaHQvMiwgOCkpO1xyXG4gICAgICAgICAgICAgIHJldHVybiAhIShlICYmIG9wdHMuc29tZShmdW5jdGlvbihvKXsgcmV0dXJuIGU9PT1vIHx8IG8uY29udGFpbnMoZSk7IH0pKTsgfSk7XHJcbiAgICAgICAgICAgIHZhciBhY3Q9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLXNlbGVjdCAud2l6YXJkLWFjdGlvbnMgLmJ0bi5wcmltYXJ5Jyk7XHJcbiAgICAgICAgICAgIHZhciBmb290ZXI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLWZvb3RlciBidXR0b24nKSk7XHJcbiAgICAgICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh7dnc6IHdpbmRvdy5pbm5lcldpZHRoLCB2aDogd2luZG93LmlubmVySGVpZ2h0LCBvcHRzOiBvcHRzLmxlbmd0aCxcclxuICAgICAgICAgICAgICBvcHRIaXQ6IG9wdEhpdCwgbm90ZUhpdDogbm90ZUhpdCwgYWN0SGl0OiBhY3QgPyBoaXQoYWN0KSA6IGZhbHNlLCBmdEhpdDogZm9vdGVyLm1hcChoaXQpfSk7XHJcbiAgICAgICAgICB9KSgpYCkpIGFzIHN0cmluZztcclxuICAgICAgICAgIGNvbnN0IHEgPSBKU09OLnBhcnNlKHIpIGFzIHsgdnc6IG51bWJlcjsgdmg6IG51bWJlcjsgb3B0czogbnVtYmVyOyBvcHRIaXQ6IGJvb2xlYW5bXTsgbm90ZUhpdDogYm9vbGVhbltdOyBhY3RIaXQ6IGJvb2xlYW47IGZ0SGl0OiBib29sZWFuW10gfTtcclxuICAgICAgICAgIGF3YWl0IHNob3QoJ3dpemFyZC1uYXJyb3ctMzYwLXNlbGVjdCcpO1xyXG4gICAgICAgICAgY29uc3QgbmFycm93T2sgPSBxLm9wdHMgPT09IDMgJiYgcS52dyA8PSAzODAgJiYgcS5vcHRIaXQuZXZlcnkoQm9vbGVhbikgJiYgcS5ub3RlSGl0LmV2ZXJ5KEJvb2xlYW4pICYmIHEuYWN0SGl0ICYmIHEuZnRIaXQuZXZlcnkoQm9vbGVhbik7XHJcbiAgICAgICAgICAvLyBcdTdBODRcdTVDNEZcdTRFMEJcdTUzNTVcdTUxRkJcdTkwMDlcdTk4NzlcdTI0NjAgPSBcdTkwMDlcdTRFMkRcdTVFNzZcdTUyNERcdThGREJcdTUyMzBcdTVCODlcdTg4QzVcdTk4NzUodmVyaWZ5IFx1NkEyMVx1NjJERlx1OEZEQlx1NUVBNixcdTRFMERcdTg0M0RcdTc2RDgpXHJcbiAgICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBvPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vcHQnKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTRFMEJcdThGN0RcdTVCODlcdTg4QzVcdTVCOENcdTY1NzQgaG1oIENMSScpPj0wO30pOyBpZihvKSBvLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICAgIGNvbnN0IGFkdiA9IGF3YWl0IHdhaXRGb3IoJ2luc3RhbGwgcGFnZSB2aWEgc2luZ2xlIGNsaWNrJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1pbnN0YWxsJyk7XHJcbiAgICAgICAgICAgIHJldHVybiB7b2s6ICEhcCwgZGV0YWlsOiBwID8gJ2luc3RhbGxpbmcnIDogJ25vdCBzaG93bid9O2AsIDZfMDAwKTtcclxuICAgICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NTNENlx1NkQ4OCc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgICAgY29uc3QgY2xvc2VkTmFycm93ID0gYXdhaXQgd2FpdEZvcignd2l6YXJkIGNsb3NlZCBhdCAzNjBweCcsIGByZXR1cm4ge29rOiAhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1vdmVybGF5JyksIGRldGFpbDogJ2Nsb3NlZCd9O2AsIDVfMDAwKTtcclxuICAgICAgICAgIHJldHVybiBbbmFycm93T2sgJiYgYWR2WzBdICYmIGNsb3NlZE5hcnJvd1swXSxcclxuICAgICAgICAgICAgYHZwPSR7cS52d314JHtxLnZofSBvcHRzPSR7cS5vcHRzfSBvcHRIaXQ9WyR7cS5vcHRIaXQuam9pbignLCcpfV0gbm90ZUhpdD1bJHtxLm5vdGVIaXQuam9pbignLCcpfV0gXHU0RTNCXHU2MzA5XHU5NEFFPSR7cS5hY3RIaXR9IGZvb3Rlcj1bJHtxLmZ0SGl0LmpvaW4oJywnKX1dOyBcdTUzNTVcdTUxRkJcdTUyNERcdThGREI6ICR7YWR2WzFdfTsgXHU3QTg0XHU1QzRGXHU1M0Q2XHU2RDg4OiAke2Nsb3NlZE5hcnJvd1sxXX1gXTtcclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgd2luLnNldFNpemUodzAsIGgwKTtcclxuICAgICAgICAgIHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX0ZBS0VfREVURUNUX0ZPVU5EID0gdW5kZWZpbmVkO1xyXG4gICAgICAgIH1cclxuICAgICAgfSk7XHJcbiAgICB9XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOkhJRyBcdTk2MzZcdTZCQjUyIFx1MjAxNFx1MjAxNCBcdTdBODRcdTdBOTdcdTYyQkRcdTVDNDkgKyBcdTY4MDdcdTk4OThcdTY4MEYgNDRweC9kcmFnIFx1NTMzQSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTdBODRcdTdBOTdcdTYyQkRcdTVDNDk6NzYwcHggXHU0RkE3XHU2ODBGXHU1M0VGXHU4RkJFXHU1M0VGXHU1MTczKFx1OTA2RVx1N0Y2OVx1NzBCOVx1NTFGQiArIEVzYyknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIHRyeSB7IHdpbi5zZXRNaW5pbXVtU2l6ZSg1NjAsIDYwMCk7IHdpbi5zZXRCb3VuZHMoeyB3aWR0aDogNzYwLCBoZWlnaHQ6IDcwMCB9KTsgfSBjYXRjaCB7IC8qIGJlc3QgZWZmb3J0ICovIH1cclxuICAgICAgY29uc3QgaXNOYXJyb3cgPSBhd2FpdCB3YWl0Rm9yKCdtYXRjaE1lZGlhIDgyMCcsIGByZXR1cm4ge29rOiB3aW5kb3cubWF0Y2hNZWRpYSgnKG1heC13aWR0aDogODIwcHgpJykubWF0Y2hlcywgZGV0YWlsOiAnaXc9JyArIHdpbmRvdy5pbm5lcldpZHRofTtgLCA1XzAwMCk7XHJcbiAgICAgIGlmICghaXNOYXJyb3dbMF0pIHJldHVybiBpc05hcnJvdztcclxuICAgICAgLy8gXHU3QjQ5IFJlYWN0IFx1NjMwOVx1N0E4NFx1N0E5N1x1OTFDRFx1NkUzMlx1NjdEM1x1NTFGQVx1NjJCRFx1NUM0OVx1NjMwOVx1OTRBRShhcmlhLWxhYmVsIFx1NjM2Mlx1NjIxMFwiXHU2MkJEXHU1QzQ5XCJcdTY1ODdcdTY4NDgpXHU1MThEXHU3MEI5XHUyMDE0XHUyMDE0Q1NTIFx1NjVBRFx1NzBCOVx1NTM3M1x1NjVGNixcclxuICAgICAgLy8gUmVhY3Qgc3RhdGUgXHU2NzA5XHU2QkVCXHU3OUQyXHU3RUE3XHU1RUY2XHU4RkRGLFx1NzZGMlx1NzBCOVx1NEYxQVx1ODQzRFx1NTcyOFx1NjVFN1x1NzY4NFwiXHU2NTM2XHU4RDc3XHU0RkE3XHU2ODBGXCJcdTRFMEFcclxuICAgICAgY29uc3QgYnRuID0gYXdhaXQgd2FpdEZvcignZHJhd2VyIGJ1dHRvbicsIGB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50b3BiYXIgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuICh4LmdldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcpfHwnJykuaW5kZXhPZignXHU2MkJEXHU1QzQ5Jyk+PTA7fSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFiLCBkZXRhaWw6ICdidG49JysoYj9iLmdldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcpOidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgICAgaWYgKCFidG5bMF0pIHJldHVybiBidG47XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudG9wYmFyIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiAoeC5nZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnKXx8JycpLmluZGV4T2YoJ1x1NjJCRFx1NUM0OScpPj0wO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3Qgb3BlbmVkID0gYXdhaXQgd2FpdEZvcignZHJhd2VyIG9wZW4nLCBgdmFyIHNiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyJyksIHNjPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyLXNjcmltJyk7XHJcbiAgICAgICAgdmFyIHI9c2I/c2IuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk6bnVsbDtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXIgJiYgci54ID49IDAgJiYgci54IDwgNDAgJiYgISFzYywgZGV0YWlsOiAneD0nKyhyP01hdGgucm91bmQoci54KTonbm9uZScpKycgc2NyaW09Jysoc2M/J3llcyc6J25vJyl9O2AsIDVfMDAwKTtcclxuICAgICAgYXdhaXQgc2hvdCgnZHJhd2VyLW9wZW4nKTtcclxuICAgICAgLy8gXHU5MDZFXHU3RjY5XHU3MEI5XHU1MUZCXHU1MTczXHU5NUVEIFx1MjE5MiBcdTRGQTdcdTY4MEZcdTZFRDFcdTUxRkEoeCA8IDApKyBcdTkwNkVcdTdGNjlcdTZEODhcdTU5MzFcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgc2M9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXItc2NyaW0nKTsgaWYoc2MpIHNjLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgY2xvc2VkID0gYXdhaXQgd2FpdEZvcignZHJhd2VyIGNsb3NlZCBieSBzY3JpbScsIGB2YXIgc2I9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXInKSwgc2M9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXItc2NyaW0nKTtcclxuICAgICAgICB2YXIgcj1zYj9zYi5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTpudWxsO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhciAmJiByLnggPCAwICYmICFzYywgZGV0YWlsOiAneD0nKyhyP01hdGgucm91bmQoci54KTonbm9uZScpKycgc2NyaW09Jysoc2M/J3llcyc6J25vJyl9O2AsIDVfMDAwKTtcclxuICAgICAgLy8gRXNjIFx1NEU1Rlx1ODBGRFx1NUYwMC9cdTUxNzNcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50b3BiYXIgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuICh4LmdldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcpfHwnJykuaW5kZXhPZignXHU2MkJEXHU1QzQ5Jyk+PTA7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBhd2FpdCB3YWl0Rm9yKCdkcmF3ZXIgcmVvcGVuJywgYHZhciBzYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhcicpOyB2YXIgcj1zYj9zYi5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTpudWxsO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhciAmJiByLnggPj0gMCAmJiByLnggPCA0MCwgZGV0YWlsOiAneD0nKyhyP01hdGgucm91bmQoci54KTonbm9uZScpfTtgLCA1XzAwMCk7XHJcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J0VzY2FwZScsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICBjb25zdCBlc2NDbG9zZWQgPSBhd2FpdCB3YWl0Rm9yKCdkcmF3ZXIgY2xvc2VkIGJ5IEVzYycsIGB2YXIgc2I9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXInKTsgdmFyIHI9c2I/c2IuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk6bnVsbDtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXIgJiYgci54IDwgMCwgZGV0YWlsOiAneD0nKyhyP01hdGgucm91bmQoci54KTonbm9uZScpfTtgLCA1XzAwMCk7XHJcbiAgICAgIC8vIFx1NjA2Mlx1NTkwRFx1NUJCRFx1N0E5NzpcdTRGQTdcdTY4MEZcdTU2REVcdTUyMzAgZ3JpZCBcdTUyMTcoZGlzcGxheSBcdTk3NUUgbm9uZSxcdTZCNjNcdTVFMzhcdTUyMTdcdTVFMDNcdTVDNDApXHJcbiAgICAgIHRyeSB7IHdpbi5zZXRCb3VuZHMoeyB3aWR0aDogMTI4MCwgaGVpZ2h0OiA4MDAgfSk7IH0gY2F0Y2ggeyAvKiBiZXN0IGVmZm9ydCAqLyB9XHJcbiAgICAgIGF3YWl0IHNsZWVwKDQwMCk7XHJcbiAgICAgIGNvbnN0IHdpZGUgPSBhd2FpdCB3YWl0Rm9yKCd3aWRlIHJlc3RvcmVkJywgYHZhciBzYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhcicpOyB2YXIgcj1zYj9zYi5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTpudWxsO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhciAmJiByLndpZHRoID4gMjAwICYmIGdldENvbXB1dGVkU3R5bGUoc2IpLmRpc3BsYXkgIT09ICdub25lJywgZGV0YWlsOiAndz0nKyhyP01hdGgucm91bmQoci53aWR0aCk6J25vbmUnKX07YCwgNV8wMDApO1xyXG4gICAgICByZXR1cm4gW29wZW5lZFswXSAmJiBjbG9zZWRbMF0gJiYgZXNjQ2xvc2VkWzBdICYmIHdpZGVbMF0sIGBvcGVuOiAke29wZW5lZFsxXX07IHNjcmltLWNsb3NlOiAke2Nsb3NlZFsxXX07IGVzYy1jbG9zZTogJHtlc2NDbG9zZWRbMV19OyB3aWRlOiAke3dpZGVbMV19YF07XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ1x1NjgwN1x1OTg5OFx1NjgwRjo0NHB4ICsgZHJhZyBcdTUzM0EoXHU4M0RDXHU1MzU1IG5vLWRyYWc7b3ZlcmxheSBcdTlBRDhcdTVFQTZcdTRFMDBcdTgxRjQpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKGAoZnVuY3Rpb24oKXtcclxuICAgICAgICB2YXIgdGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnRpdGxlYmFyJyksIG1iPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy50aXRsZWJhci1tZW51Jyk7XHJcbiAgICAgICAgaWYoIXRiIHx8ICFtYikgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHtvazpmYWxzZSwgZGV0YWlsOidtaXNzaW5nIHRpdGxlYmFyL21lbnUnfSk7XHJcbiAgICAgICAgdmFyIGNzPWdldENvbXB1dGVkU3R5bGUodGIpLCBtcz1nZXRDb21wdXRlZFN0eWxlKG1iKTtcclxuICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoeyBvazogY3MuaGVpZ2h0ID09PSAnNDRweCcgJiYgY3Mud2Via2l0QXBwUmVnaW9uID09PSAnZHJhZycgJiYgbXMud2Via2l0QXBwUmVnaW9uID09PSAnbm8tZHJhZycgJiYgbWIuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCkuaGVpZ2h0ID49IDM2LFxyXG4gICAgICAgICAgZGV0YWlsOiAnaD0nK2NzLmhlaWdodCsnIHJlZ2lvbj0nK2NzLndlYmtpdEFwcFJlZ2lvbisnIG1lbnUtcmVnaW9uPScrbXMud2Via2l0QXBwUmVnaW9uKycgbWVudS1oPScrTWF0aC5yb3VuZChtYi5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKS5oZWlnaHQpIH0pO1xyXG4gICAgICB9KSgpYCkpIGFzIHN0cmluZztcclxuICAgICAgY29uc3QgcCA9IEpTT04ucGFyc2UocikgYXMgeyBvazogYm9vbGVhbjsgZGV0YWlsOiBzdHJpbmcgfTtcclxuICAgICAgLy8gXHU0RTNCXHU4RkRCXHU3QTBCXHU0RkE3Olx1NTM5Rlx1NzUxRiB0aXRsZUJhck92ZXJsYXkgXHU5QUQ4XHU1RUE2XHU5ODdCXHU1NDBDXHU0RTNBIDQ0KFdpbmRvd3MgXHU2MjREXHU2NzA5IG92ZXJsYXk7XHU2NUU3XHU3QzdCXHU1NzhCXHU3RjNBXHU2QjY0IEFQSSxcdTUzRUZcdTkwMDlcdThDMDNcdTc1MjgpXHJcbiAgICAgIGxldCBvdmVybGF5ID0gJ24vYSc7XHJcbiAgICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgcHJvYmUgPSB3aW4gYXMgdW5rbm93biBhcyB7IGdldFRpdGxlQmFyT3ZlcmxheT86ICgpID0+IHsgaGVpZ2h0PzogbnVtYmVyIH0gfCBudWxsIH07XHJcbiAgICAgICAgY29uc3QgbyA9IHByb2JlLmdldFRpdGxlQmFyT3ZlcmxheT8uKCkgPz8gbnVsbDtcclxuICAgICAgICBvdmVybGF5ID0gbyAhPT0gbnVsbCA/IFN0cmluZyhvLmhlaWdodCkgOiAnbi9hJztcclxuICAgICAgfSBjYXRjaCB7IC8qIFx1NUU3M1x1NTNGMFx1NjVFMCBvdmVybGF5ICovIH1cclxuICAgICAgcmV0dXJuIFtwLm9rID09PSB0cnVlLCBgJHtwLmRldGFpbH0gb3ZlcmxheS1oPSR7b3ZlcmxheX1gXTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTY2RjRcdTY1QjBcdTZBMkFcdTVFNDUobW9jayB1cGRhdGU6c3RhdGUgXHU0RTA5XHU2MDAxO1x1NEVGQlx1NTJBMSAxMy1DKSA9PT09PT09PT09XHJcbiAgICAgICBcdTRFM0JcdThGREJcdTdBMEJcdTc2RjRcdTUzRDEgbW9jayBcdTcyQjZcdTYwMDE6XHU2OEMwXHU2N0U1XHU0RTJEXHU5NzU5XHU5RUQ4IFx1MjE5MiBcdTRFMEJcdThGN0RcdTRFMkQoXHU4RkRCXHU1RUE2L1x1OTAxRlx1NUVBNi9cdThGREJcdTVFQTZcdTY3NjEpXHUyMTkyIFx1NUMzMVx1N0VFQVxyXG4gICAgICAgKFwiXHU5MUNEXHU1NDJGXHU2NkY0XHU2NUIwXCJcdTUzRUZcdTcwQjlcdTMwMDFcdTY1RTBcdTU5MTZcdTk0RkVcdTMwMDFhcHBseSBcdTRFMERcdTVEMjkpXHUyMTkyIFx1NTkzMVx1OEQyNShcdTkxQ0RcdThCRDVcdTZENDFcdThGNkMgKyBcdTdBMERcdTU0MEVcdTUxNzNcdTk1RUQpXHUzMDAyICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTY2RjRcdTY1QjBcdTZBMkFcdTVFNDU6XHU2OEMwXHU2N0U1XHU0RTJEXHU5NzU5XHU5RUQ4XHU2NUUwXHU2QTJBXHU1RTQ1IFx1MjE5MiBcdTRFMEJcdThGN0RcdTRFMkRcdThGREJcdTVFQTZcdTUzRUZcdTg5QzEoXHU1QjU3XHU4MjgyL1x1OTAxRlx1NUVBNi9cdThGREJcdTVFQTZcdTY3NjEpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCBzdEJhc2UgPSB7IGNoZWNraW5nOiBmYWxzZSwgY3VycmVudFZlcnNpb246ICcwLjIuOScsIGxhdGVzdDogbnVsbCwgbm90ZXM6ICcnLCBkb3dubG9hZGVkOiBmYWxzZSwgZXJyb3I6ICcnLCBjaGFubmVsOiAnJywgcHJvZ3Jlc3M6IG51bGwgfTtcclxuICAgICAgLy8gY2hlY2tpbmcgXHU2MDAxOlx1OTc1OVx1OUVEOFx1NjhDMFx1NjdFNSxcdTRFMERcdTYyNTNcdTYyNzBcdTRFRkJcdTUyQTFcdTUzM0FcclxuICAgICAgd2luLndlYkNvbnRlbnRzLnNlbmQoJ3VwZGF0ZTpzdGF0ZScsIHsgLi4uc3RCYXNlLCBjaGVja2luZzogdHJ1ZSB9KTtcclxuICAgICAgYXdhaXQgc2xlZXAoNDAwKTtcclxuICAgICAgY29uc3Qgc2lsZW50ID0gKGF3YWl0IGpzKGAhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnVwZGF0ZS1iYW5uZXInKWApKSBhcyBib29sZWFuO1xyXG4gICAgICAvLyBcdTRFMEJcdThGN0RcdTRFMkQ6XHU3MjQ4XHU2NzJDXHU1M0Y3ICsgXHU1REYyXHU0RTBCXHU4RjdEL1x1NjAzQlx1NUI1N1x1ODI4MiArIFx1OTAxRlx1NUVBNiArIFx1OEZEQlx1NUVBNlx1Njc2MVx1NUJCRFx1NUVBNlxyXG4gICAgICB3aW4ud2ViQ29udGVudHMuc2VuZCgndXBkYXRlOnN0YXRlJywgeyAuLi5zdEJhc2UsIGxhdGVzdDogJ3YwLjMuMCcsIGNoYW5uZWw6ICdhdG9tZ2l0KFx1NTZGRFx1NTE4NSknLCBwcm9ncmVzczogeyByZWNlaXZlZDogNDdfMDAwXzAwMCwgdG90YWw6IDExMl8xNDdfMTk5LCBzcGVlZEJwczogMl8xMDBfMDAwIH0gfSk7XHJcbiAgICAgIGNvbnN0IGRsID0gYXdhaXQgd2FpdEZvcignZG93bmxvYWRpbmcgYmFubmVyJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy51cGRhdGUtYmFubmVyJyk7XHJcbiAgICAgICAgaWYoIWIpIHJldHVybiB7b2s6ZmFsc2UsIGRldGFpbDonbm8gYmFubmVyJ307XHJcbiAgICAgICAgdmFyIHQ9Yi50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpO1xyXG4gICAgICAgIHZhciBiYXI9Yi5xdWVyeVNlbGVjdG9yKCcudXBkYXRlLWJhci1maWxsJyk7XHJcbiAgICAgICAgdmFyIHc9YmFyP3BhcnNlRmxvYXQoYmFyLnN0eWxlLndpZHRoKTowO1xyXG4gICAgICAgIHJldHVybiB7b2s6IHQuaW5kZXhPZigndjAuMy4wJyk+PTAgJiYgdC5pbmRleE9mKCcvJyk+PTAgJiYgdC5pbmRleE9mKCcvcycpPj0wICYmIHc+MzAgJiYgdzw9MTAwLCBkZXRhaWw6ICd0ZXh0PScrdC5zbGljZSgwLDcwKSsnIGJhclc9Jyt3fTtgLCA1XzAwMCk7XHJcbiAgICAgIGF3YWl0IHNob3QoJ3VwZGF0ZS1kb3dubG9hZGluZycpO1xyXG4gICAgICByZXR1cm4gW3NpbGVudCAmJiBkbFswXSwgYGNoZWNraW5nIFx1OTc1OVx1OUVEOD0ke3NpbGVudH07ICR7ZGxbMV19YF07XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ1x1NjZGNFx1NjVCMFx1NkEyQVx1NUU0NTpcdTVDMzFcdTdFRUFcdTYwMDFcIlx1OTFDRFx1NTQyRlx1NjZGNFx1NjVCMFwiXHU1M0VGXHU3MEI5XHUzMDAxXHU2NUUwXHU1OTE2XHU5NEZFXHU1RjE1XHU1QkZDLGFwcGx5IFx1ODlFNlx1NTNEMSBwcmVsb2FkIFx1NEUxNFx1OEZEQlx1N0EwQlx1NUI1OFx1NkQzQicsIGFzeW5jICgpID0+IHtcclxuICAgICAgd2luLndlYkNvbnRlbnRzLnNlbmQoJ3VwZGF0ZTpzdGF0ZScsIHsgY2hlY2tpbmc6IGZhbHNlLCBjdXJyZW50VmVyc2lvbjogJzAuMi45JywgbGF0ZXN0OiAndjAuMy4wJywgbm90ZXM6ICcnLCBkb3dubG9hZGVkOiB0cnVlLCBlcnJvcjogJycsIGNoYW5uZWw6ICdhdG9tZ2l0KFx1NTZGRFx1NTE4NSknLCBwcm9ncmVzczogbnVsbCB9KTtcclxuICAgICAgY29uc3QgcmVhZHkgPSBhd2FpdCB3YWl0Rm9yKCdyZWFkeSBiYW5uZXInLCBgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnVwZGF0ZS1iYW5uZXInKTtcclxuICAgICAgICB2YXIgYnRuPWI/Yi5xdWVyeVNlbGVjdG9yKCcudXBkYXRlLXJlc3RhcnQnKTpudWxsO1xyXG4gICAgICAgIHZhciBsaW5rcz1iP2IucXVlcnlTZWxlY3RvckFsbCgnYScpLmxlbmd0aDotMTtcclxuICAgICAgICB2YXIgbm9FeHQ9Yj8oYi50ZXh0Q29udGVudC5pbmRleE9mKCdcdTRFMEJcdThGN0RcdTk4NzUnKTwwICYmIGIudGV4dENvbnRlbnQuaW5kZXhPZignaHR0cCcpPDApOmZhbHNlO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYiAmJiAhIWJ0biAmJiBidG4uZGlzYWJsZWQ9PT1mYWxzZSAmJiBsaW5rcz09PTAgJiYgbm9FeHQsIGRldGFpbDogJ2J0bj0nKyhidG4/YnRuLnRleHRDb250ZW50Oidub25lJykrJyBsaW5rcz0nK2xpbmtzKycgbm9FeHQ9Jytub0V4dH07YCwgNV8wMDApO1xyXG4gICAgICBhd2FpdCBzaG90KCd1cGRhdGUtcmVhZHknKTtcclxuICAgICAgaWYgKCFyZWFkeVswXSkgcmV0dXJuIHJlYWR5O1xyXG4gICAgICAvLyBwcmVsb2FkIFx1Njg2NVx1NTcyOCArIFx1NzBCOVx1NTFGQlx1NTQwRVx1OEZEQlx1N0EwQlx1NUI1OFx1NkQzQihtb2NrIFx1NjVFMFx1NUI4OVx1ODhDNVx1NTMwNSBcdTIxOTIgYXBwbHlVcGRhdGUgbm8tb3AgXHU0RTBEXHU5MDAwXHU1MUZBO1xyXG4gICAgICAvLyBcdTRFM0JcdThGREJcdTdBMEJcdTRGQTdcdTY3MDkgXCJhcHBseSByZXF1ZXN0ZWRcIiBcdTY1RTVcdTVGRDdcdTg4NEMsXHU3NTMxXHU5QTcxXHU1MkE4XHU1NjY4XHU4RjkzXHU1MUZBXHU0RUJBXHU1QkExKVx1MzAwMlxyXG4gICAgICBjb25zdCBoYXNCcmlkZ2UgPSAoYXdhaXQganMoYHR5cGVvZiB3aW5kb3cuaG1oLmFwcGx5VXBkYXRlID09PSAnZnVuY3Rpb24nICYmIHR5cGVvZiB3aW5kb3cuaG1oLmNoZWNrVXBkYXRlID09PSAnZnVuY3Rpb24nYCkpIGFzIGJvb2xlYW47XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnVwZGF0ZS1iYW5uZXIgLnVwZGF0ZS1yZXN0YXJ0Jyk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBhd2FpdCBzbGVlcCg4MDApO1xyXG4gICAgICBjb25zdCBhbGl2ZSA9IChhd2FpdCBqcyhgISFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudXBkYXRlLWJhbm5lcicpICYmICEhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNvbXBvc2VyIHRleHRhcmVhJylgKSkgYXMgYm9vbGVhbjtcclxuICAgICAgcmV0dXJuIFtoYXNCcmlkZ2UgJiYgYWxpdmUsIGBwcmVsb2FkIGFwcGx5VXBkYXRlL2NoZWNrVXBkYXRlPSR7aGFzQnJpZGdlfTsgXHU3MEI5XHU1MUZCXHU1NDBFXHU2QTJBXHU1RTQ1XHU0RTBFIGNvbXBvc2VyIFx1NUI1OFx1NkQzQj0ke2FsaXZlfWBdO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdcdTY2RjRcdTY1QjBcdTZBMkFcdTVFNDU6XHU1OTMxXHU4RDI1XHU2MDAxXHU5NTE5XHU4QkVGXHU2NjBFXHU3RUM2K1x1OTFDRFx1OEJENVx1NkQ0MVx1OEY2QyxcdTdBMERcdTU0MEVcdTUzRUZcdTUxNzNcdTk1RUQnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIHdpbi53ZWJDb250ZW50cy5zZW5kKCd1cGRhdGU6c3RhdGUnLCB7IGNoZWNraW5nOiBmYWxzZSwgY3VycmVudFZlcnNpb246ICcwLjIuOScsIGxhdGVzdDogbnVsbCwgbm90ZXM6ICcnLCBkb3dubG9hZGVkOiBmYWxzZSwgZXJyb3I6ICdcdTUxNjhcdTkwRThcdTY4QzBcdTY3RTVcdTkwMUFcdTkwNTNcdTU5MzFcdThEMjUoXHU3NkY0XHU4RkRFOlx1OEQ4NVx1NjVGNig4cyk7IGF0b21naXQoXHU1NkZEXHU1MTg1KTpIVFRQIDUwMjsgZ2gtcHJveHk6XHU4RDg1XHU2NUY2KDEwcykpJywgY2hhbm5lbDogJycsIHByb2dyZXNzOiBudWxsIH0pO1xyXG4gICAgICBjb25zdCBlcnIgPSBhd2FpdCB3YWl0Rm9yKCdlcnJvciBiYW5uZXInLCBgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnVwZGF0ZS1iYW5uZXInKTtcclxuICAgICAgICB2YXIgYnRuPWI/Yi5xdWVyeVNlbGVjdG9yKCcudXBkYXRlLXJldHJ5Jyk6bnVsbDtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWIgJiYgYi50ZXh0Q29udGVudC5pbmRleE9mKCdcdTY2RjRcdTY1QjBcdTY4QzBcdTY3RTVcdTU5MzFcdThEMjUnKT49MCAmJiBiLnRleHRDb250ZW50LmluZGV4T2YoJ2F0b21naXQnKT49MCAmJiAhIWJ0biAmJiBidG4uZGlzYWJsZWQ9PT1mYWxzZSwgZGV0YWlsOiBiID8gYi50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsOTApIDogJ25vIGJhbm5lcid9O2AsIDVfMDAwKTtcclxuICAgICAgYXdhaXQgc2hvdCgndXBkYXRlLWVycm9yJyk7XHJcbiAgICAgIGlmICghZXJyWzBdKSByZXR1cm4gZXJyO1xyXG4gICAgICAvLyBcdTcwQjlcdTkxQ0RcdThCRDUgXHUyMTkyIFx1OEZEQlx1NTE2NSBjaGVja2luZyhcdTZBMkFcdTVFNDVcdTYzMDlcdTcyQjZcdTYwMDFcdTY3M0FcdTY1MzZcdThENzc7XHU3NzFGXHU1QjlFIGNoZWNrRm9yVXBkYXRlcyBcdTU3MjhcdTU0MEVcdTUzRjBcdThERDEsXHU0RTBEXHU1RjcxXHU1NENEXHU2NzJDXHU2QjY1KVxyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy51cGRhdGUtYmFubmVyIC51cGRhdGUtcmV0cnknKTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IHRvQ2hlY2tpbmcgPSBhd2FpdCB3YWl0Rm9yKCdiYW5uZXIgaGlkZGVuIG9uIHJldHJ5JywgYHJldHVybiB7b2s6ICFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudXBkYXRlLWJhbm5lcicpLCBkZXRhaWw6IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy51cGRhdGUtYmFubmVyJykgPyAnc3RpbGwnIDogJ2hpZGRlbid9O2AsIDVfMDAwKTtcclxuICAgICAgLy8gXHU2MDYyXHU1OTBEXHU1QzMxXHU3RUVBXHU2MDAxXHU5QThDXHU4QkMxXCJcdTdBMERcdTU0MEVcIjpcdTcwQjlcdTUxRkJcdTU0MEVcdTZBMkFcdTVFNDVcdTUxNzNcdTk1RUQoXHU0RjFBXHU4QkREXHU1MTg1XHU5NzU5XHU5RUQ4LFx1NEUwQlx1NkIyMVx1NTQyRlx1NTJBOFx1NTE4RFx1NjNEMFx1OTE5MilcclxuICAgICAgd2luLndlYkNvbnRlbnRzLnNlbmQoJ3VwZGF0ZTpzdGF0ZScsIHsgY2hlY2tpbmc6IGZhbHNlLCBjdXJyZW50VmVyc2lvbjogJzAuMi45JywgbGF0ZXN0OiAndjAuMy4wJywgbm90ZXM6ICcnLCBkb3dubG9hZGVkOiB0cnVlLCBlcnJvcjogJycsIGNoYW5uZWw6ICdhdG9tZ2l0KFx1NTZGRFx1NTE4NSknLCBwcm9ncmVzczogbnVsbCB9KTtcclxuICAgICAgYXdhaXQgd2FpdEZvcigncmVhZHkgYWdhaW4nLCBgcmV0dXJuIHtvazogISFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudXBkYXRlLWJhbm5lciAudXBkYXRlLXJlc3RhcnQnKSwgZGV0YWlsOiAncmVhZHknfTtgLCA1XzAwMCk7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGJzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnVwZGF0ZS1iYW5uZXIgYnV0dG9uJykpOyB2YXIgYj1icy5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1N0EwRFx1NTQwRScpPj0wO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgZGlzbWlzc2VkID0gYXdhaXQgd2FpdEZvcignYmFubmVyIGRpc21pc3NlZCcsIGByZXR1cm4ge29rOiAhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnVwZGF0ZS1iYW5uZXInKSwgZGV0YWlsOiBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudXBkYXRlLWJhbm5lcicpID8gJ3N0aWxsJyA6ICdkaXNtaXNzZWQnfTtgLCA1XzAwMCk7XHJcbiAgICAgIHJldHVybiBbdG9DaGVja2luZ1swXSAmJiBkaXNtaXNzZWRbMF0sIGBcdTkxQ0RcdThCRDVcdTIxOTJjaGVja2luZyBcdTY1MzZcdThENzc9JHt0b0NoZWNraW5nWzBdfTsgXHU3QTBEXHU1NDBFXHU1MTczXHU5NUVEPSR7ZGlzbWlzc2VkWzBdfWBdO1xyXG4gICAgfSk7XHJcblxyXG4gICAgYXdhaXQgc2hvdCgnZmluYWwnKTtcclxuICB9IGVsc2UgaWYgKChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9XSVpBUkQgPz8gJycpICE9PSAnJykge1xyXG4gICAgLyogPT09PT09PT09PSByZWFsKFx1NTQxMVx1NUJGQ1x1Njc4NFx1OTAyMCxcdTRFOTJcdTY1QTVcdTRFOEVcdTVFMzhcdTg5QzQgcmVhbCBcdTZCNjVcdTlBQTQpOlxyXG4gICAgICAgV1oyIFx1NjcyQ1x1NjczQVx1NzcxRlx1NUI5RVx1NjhDMFx1NkQ0QihcdTlFRDhcdThCQTRcdTUxNzFcdTRFQUJcdTk4NzUpLyBXWjMgXHU0RTBCXHU4RjdEXHU1Qjg5XHU4OEM1XHU1QjlFXHU2RDRCID09PT09PT09PT0gKi9cclxuICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9XSVpBUkQgPT09ICdkZXRlY3QnKSB7XHJcbiAgICAgIGF3YWl0IHN0ZXAoJ1x1NTQxMVx1NUJGQyhcdTc3MUZcdTVCOUUpOlx1NkIyMlx1OEZDRVx1MjE5Mlx1NjhDMFx1NkQ0Qlx1NTIzMFx1NjcyQ1x1NjczQVx1NURGMlx1ODhDNSBDTEkoXHU5RUQ4XHU4QkE0XHU1MTcxXHU0RUFCLFx1NTJGRVx1OTAwOVx1NkI2M1x1Nzg2RSknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3dpemFyZCBvdmVybGF5JywgYHZhciBvPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3ZlcmxheScpO1xyXG4gICAgICAgICAgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NUYwMFx1NTlDQlx1OTE0RFx1N0Y2RSc7fSk7XHJcbiAgICAgICAgICByZXR1cm4ge29rOiAhIW8gJiYgISFiLCBkZXRhaWw6IG8gPyAnb3ZlcmxheStcdTVGMDBcdTU5Q0JcdTkxNERcdTdGNkUnIDogJ25vIG92ZXJsYXknfTtgLCAxMl8wMDApO1xyXG4gICAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgICAgYXdhaXQgc2hvdCgnd2l6YXJkLXJlYWwtd2VsY29tZScpO1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NUYwMFx1NTlDQlx1OTE0RFx1N0Y2RSc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgIGNvbnN0IGZvdW5kID0gYXdhaXQgd2FpdEZvcignZGV0ZWN0IGZvdW5kJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1kZXRlY3QnKTtcclxuICAgICAgICAgIGlmKCFwKSByZXR1cm4ge29rOmZhbHNlLCBkZXRhaWw6J2RldGVjdCBwYWdlIG5vdCBzaG93bid9O1xyXG4gICAgICAgICAgdmFyIHQ9cC50ZXh0Q29udGVudDtcclxuICAgICAgICAgIHZhciBvazE9dC5pbmRleE9mKCdcdTY4QzBcdTZENEJcdTUyMzBcdTVERjJcdTVCODlcdTg4QzUgaG1oYXJuZXNzIHYnKT49MDtcclxuICAgICAgICAgIHZhciBvazI9dC5pbmRleE9mKCdcdTlFRDhcdThCQTRcdTUxNzFcdTRFQUJcdTRGN0ZcdTc1MjhcdTVCODMoXHU2M0E4XHU4MzUwKScpPj0wO1xyXG4gICAgICAgICAgdmFyIHJhZGlvPXAucXVlcnlTZWxlY3RvcignLndpemFyZC1vcHQub24nKTtcclxuICAgICAgICAgIHJldHVybiB7b2s6IG9rMSYmb2syJiYhIXJhZGlvLCBkZXRhaWw6IHQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDkwKX07YCwgMjBfMDAwKTtcclxuICAgICAgICBhd2FpdCBzaG90KCd3aXphcmQtcmVhbC1kZXRlY3QnKTtcclxuICAgICAgICByZXR1cm4gZm91bmQ7XHJcbiAgICAgIH0pO1xyXG4gICAgfSBlbHNlIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9XSVpBUkQgPT09ICdpbnN0YWxsJykge1xyXG4gICAgICBhd2FpdCBzdGVwKCdcdTU0MTFcdTVCRkMoXHU3NzFGXHU1QjlFKTpcdTY4QzBcdTZENEJcdTIxOTJcdTRFQ0RcdTg5ODFcdTRFMEJcdThGN0RcdTY1QjBcdTcyNDhcdTIxOTJcdTkwMDlcdTYyRTlcdTI0NjBcdTIxOTJcdThGREJcdTUxNjVcdTVCODlcdTg4QzVcdTk4NzUnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3dpemFyZCBvdmVybGF5JywgYHZhciBvPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3ZlcmxheScpO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogISFvLCBkZXRhaWw6IG8gPyAnb3BlbicgOiAnY2xvc2VkJ307YCwgMTJfMDAwKTtcclxuICAgICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NUYwMFx1NTlDQlx1OTE0RFx1N0Y2RSc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgIGNvbnN0IGZvdW5kID0gYXdhaXQgd2FpdEZvcignZGV0ZWN0IGZvdW5kJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1kZXRlY3QnKTtcclxuICAgICAgICAgIHJldHVybiB7b2s6ICEhcCAmJiBwLnRleHRDb250ZW50LmluZGV4T2YoJ1x1NjhDMFx1NkQ0Qlx1NTIzMFx1NURGMlx1NUI4OVx1ODhDNSBobWhhcm5lc3MgdicpPj0wLCBkZXRhaWw6IHAgPyBwLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw2MCkgOiAnbm8gZGV0ZWN0IHBhZ2UnfTtgLCAyMF8wMDApO1xyXG4gICAgICAgIGlmICghZm91bmRbMF0pIHJldHVybiBmb3VuZDtcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBvPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vcHQnKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTRFQ0RcdTg5ODFcdTRFMEJcdThGN0RcdTY1QjBcdTcyNDgnKT49MDt9KTsgaWYobykgby5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgYXdhaXQgc2xlZXAoMjAwKTtcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTRFMEJcdTRFMDBcdTZCNjUnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICBjb25zdCBzZWwgPSBhd2FpdCB3YWl0Rm9yKCdzZWxlY3QgcGFnZSBcdTI0NjAgb24nLCBgdmFyIHA9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLXNlbGVjdCcpO1xyXG4gICAgICAgICAgdmFyIG9uPXA/cC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW9wdC5vbicpOm51bGw7XHJcbiAgICAgICAgICByZXR1cm4ge29rOiAhIXAgJiYgISFvbiAmJiBvbi50ZXh0Q29udGVudC5pbmRleE9mKCdcdTRFMEJcdThGN0RcdTVCODlcdTg4QzVcdTVCOENcdTY1NzQgaG1oIENMSScpPj0wLCBkZXRhaWw6IHAgPyAnc2VsZWN0IFx1MjQ2MCBvbicgOiAnbm8gc2VsZWN0J307YCwgOF8wMDApO1xyXG4gICAgICAgIGlmICghc2VsWzBdKSByZXR1cm4gc2VsO1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NUYwMFx1NTlDQlx1NUI4OVx1ODhDNSc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgIHJldHVybiB3YWl0Rm9yKCdpbnN0YWxsIHBhZ2UnLCBgdmFyIHA9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLWluc3RhbGwnKTtcclxuICAgICAgICAgIHJldHVybiB7b2s6ICEhcCwgZGV0YWlsOiBwID8gJ2luc3RhbGxpbmcnIDogJ25vdCBzaG93bid9O2AsIDhfMDAwKTtcclxuICAgICAgfSk7XHJcbiAgICAgIGF3YWl0IHN0ZXAoJ1x1NTQxMVx1NUJGQyhcdTc3MUZcdTVCOUUpOlx1NUI4OVx1ODhDNVx1OEZEQlx1NUVBNlx1NTNFRlx1ODlDMShcdTZCNjVcdTlBQTRcdTY1ODdcdTY4NDgvXHU0RTBCXHU4RjdEXHU3NjdFXHU1MjA2XHU2QkQ0XHU2RURBXHU1MkE4KScsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcigncHJvZ3Jlc3MgdmlzaWJsZScsIGB2YXIgYmFyPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtcHJvZ3Jlc3MnKTtcclxuICAgICAgICAgIHZhciBsb2c9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1pbnN0YWxsLWxvZycpO1xyXG4gICAgICAgICAgdmFyIGxpbmVzPWxvZz9sb2cudGV4dENvbnRlbnQuc3BsaXQoJ1xcXFxuJykuZmlsdGVyKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRyaW0oKSE9PScnO30pOltdO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogISFiYXIgJiYgbGluZXMubGVuZ3RoPj0xLCBkZXRhaWw6ICdiYXI9JysoYmFyPyd5JzonbicpKycgbGluZXM9JytsaW5lcy5sZW5ndGgrKGxpbmVzLmxlbmd0aD4wPygnIGxhc3Q9JysobGluZXNbbGluZXMubGVuZ3RoLTFdfHwnJykuc2xpY2UoMCw1MCkpOicnKX07YCwgNjBfMDAwKTtcclxuICAgICAgICBhd2FpdCBzaG90KCd3aXphcmQtcmVhbC1pbnN0YWxsJyk7XHJcbiAgICAgICAgcmV0dXJuIHc7XHJcbiAgICAgIH0pO1xyXG4gICAgICBhd2FpdCBzdGVwKCdcdTU0MTFcdTVCRkMoXHU3NzFGXHU1QjlFKTpcdTVCODlcdTg4QzVcdTVCOENcdTYyMTBcdTIxOTJcdTkxNERcdTdGNkVcdThERjNcdThGQzcoXHU1REYyXHU2NzA5XHU1QkM2XHU5NEE1KVx1MjE5Mlx1NUI4Q1x1NjIxMFx1OTg3NVx1MjE5Mlx1NUYwMFx1NTlDQlx1NEY3Rlx1NzUyOFx1MjE5Mlx1NjVCMCBydW50aW1lIFx1OEZERVx1NjNBNScsIGFzeW5jICgpID0+IHtcclxuICAgICAgICAvLyBcdTVCODlcdTg4QzVcdTUxNjhcdTdBMEIobnBtIFx1ODlFM1x1Njc5MCtcdTRFMEJcdThGN0QrXHU4NDNEXHU3NkQ4O1x1OTU1Q1x1NTBDRiBucG1taXJyb3IgXHU5MDFBXHU1RTM4IDwyIFx1NTIwNlx1OTQ5RiksXHU0RTBBXHU5NjUwIDggXHU1MjA2XHU5NDlGXHJcbiAgICAgICAgYXdhaXQgd2FpdEZvcignZG9uZSBwYWdlJywgYHZhciBkPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1kb25lJyk7XHJcbiAgICAgICAgICBpZihkKSByZXR1cm4ge29rOnRydWUsIGRldGFpbDonZG9uZSd9O1xyXG4gICAgICAgICAgdmFyIGM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLWNvbmZpZycpO1xyXG4gICAgICAgICAgaWYoYyl7IHZhciBzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1OERGM1x1OEZDNycpPj0wO30pOyBpZihzKSBzLmNsaWNrKCk7IH1cclxuICAgICAgICAgIHZhciBlcnI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1lcnJvcicpO1xyXG4gICAgICAgICAgaWYoZXJyKSByZXR1cm4ge29rOmZhbHNlLCBkZXRhaWw6J2luc3RhbGwgZXJyb3I6ICcrZXJyLnRleHRDb250ZW50LnNsaWNlKDAsODApfTtcclxuICAgICAgICAgIHJldHVybiB7b2s6ZmFsc2UsIGRldGFpbDonaW5zdGFsbGluZ1x1MjAyNid9O2AsIDggKiA2MF8wMDApO1xyXG4gICAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdkb25lIHJlYWR5IHRleHQnLCBgdmFyIGQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLWRvbmUnKTtcclxuICAgICAgICAgIHZhciB0PWQ/ZC50ZXh0Q29udGVudDonJztcclxuICAgICAgICAgIHJldHVybiB7b2s6ICEhZCAmJiB0LmluZGV4T2YoJ1x1NUMzMVx1N0VFQScpPj0wLCBkZXRhaWw6IHQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDYwKX07YCwgMTBfMDAwKTtcclxuICAgICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICAgIGF3YWl0IHNob3QoJ3dpemFyZC1yZWFsLWRvbmUnKTtcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTVGMDBcdTU5Q0JcdTRGN0ZcdTc1MjgnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICBjb25zdCBjb25uZWN0ZWQgPSBhd2FpdCB3YWl0Rm9yKCduZXcgcnVudGltZSBjb25uZWN0ZWQnLCBgdmFyIGRvdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuaG9zdC1kb3Qub24nKTtcclxuICAgICAgICAgIHZhciBsPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ob3N0LWxhYmVsJyk7XHJcbiAgICAgICAgICByZXR1cm4ge29rOiAhIWRvdCAmJiAhIWwgJiYgbC50ZXh0Q29udGVudC5pbmRleE9mKCdydW50aW1lJyk+PTAsIGRldGFpbDogJ2RvdD0nKyhkb3Q/J29uJzonb2ZmJykrJyBsYWJlbD0nKyhsP2wudGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDUwKTonbm9uZScpfTtgLCA2MF8wMDApO1xyXG4gICAgICAgIGNvbnN0IHN0ID0gKGF3YWl0IGpzKGB3aW5kb3cuaG1oLmdldFN0YXRlKCkudGhlbihmdW5jdGlvbihyKXtyZXR1cm4gSlNPTi5zdHJpbmdpZnkoe21vZGU6ci5tb2RlLCBydW50aW1lRW50cnk6ci5ydW50aW1lRW50cnl9KTt9KWApKSBhcyBzdHJpbmc7XHJcbiAgICAgICAgY29uc3QgcCA9IEpTT04ucGFyc2Uoc3QpIGFzIHsgbW9kZT86IHN0cmluZzsgcnVudGltZUVudHJ5Pzogc3RyaW5nIHwgbnVsbCB9O1xyXG4gICAgICAgIGNvbnN0IGVudHJ5T2sgPSAocC5ydW50aW1lRW50cnkgPz8gJycpLmluZGV4T2YoJy5obWhhcm5lc3MtZ2xvYmFsJykgPj0gMDtcclxuICAgICAgICBhd2FpdCBzaG90KCd3aXphcmQtcmVhbC1maW5hbCcpO1xyXG4gICAgICAgIHJldHVybiBbY29ubmVjdGVkWzBdICYmIGVudHJ5T2ssIGBjb25uZWN0ZWQ6ICR7Y29ubmVjdGVkWzFdfTsgc3RhdGU9JHtzdC5zbGljZSgwLCA5MCl9YF07XHJcbiAgICAgIH0pO1xyXG4gICAgfVxyXG4gICAgYXdhaXQgc2hvdCgnZmluYWwnKTtcclxuICB9IGVsc2Uge1xyXG4gICAgLyogPT09PT09PT09PSByZWFsOlx1NTNFQVx1OEJGQlx1NUI1MFx1OTZDNihcdTRFMERcdTUyQThcdTc3MUZcdTVCOUVcdTRGMUFcdThCREQpID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1OTg3Nlx1NjgwRjpydW50aW1lIFx1NzI0OFx1NjcyQ1x1NEUwRVx1N0FFRlx1NTNFM1x1NURGMlx1NjYzRVx1NzkzQShcdTk3NUUgPyknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdob3N0IGxhYmVsJywgYHZhciBsPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ob3N0LWxhYmVsJyk7XHJcbiAgICAgICAgdmFyIHQgPSBsID8gbC50ZXh0Q29udGVudCA6ICcnO1xyXG4gICAgICAgIHJldHVybiB7b2s6IHQuaW5kZXhPZignPycpIDwgMCAmJiB0LmluZGV4T2YoJ3J1bnRpbWUnKSA+PSAwLCBkZXRhaWw6IHQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDYwKX07YCwgMTVfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnXHU0RjFBXHU4QkREXHU1MjE3XHU4ODY4Olx1NzcxRlx1NUI5RVx1NTM4Nlx1NTNGMlx1NTJBMFx1OEY3RChcdTY1NzBcdTkxQ0Y+MCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdzZXNzaW9ucycsIGB2YXIgbj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoO1xyXG4gICAgICAgIHJldHVybiB7b2s6IG4gPiAwLCBkZXRhaWw6ICdzZXNzaW9ucz0nK259O2AsIDE1XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ1x1NzBCOVx1NTFGQlx1NTM4Nlx1NTNGMlx1NEYxQVx1OEJERCBcdTIxOTIgXHU3NzFGXHU1QjlFIHRyYW5zY3JpcHQgXHU1MTg1XHU1QkI5XHU1M0VGXHU4OUMxJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCBuID0gKGF3YWl0IGpzKGBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoYCkpIGFzIG51bWJlcjtcclxuICAgICAgaWYgKG4gPT09IDApIHJldHVybiBbZmFsc2UsICdubyBzZXNzaW9ucyB0byBjbGljayddO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBpdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2Vzc2lvbi1pdGVtJyk7IGlmIChpdCkgaXQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignaGlzdG9yeSB0dXJucycsIGB2YXIgdHM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudHVybicpKTtcclxuICAgICAgICByZXR1cm4ge29rOiB0cy5sZW5ndGggPj0gMSwgZGV0YWlsOiAndHVybnM9Jyt0cy5sZW5ndGgrJyBmaXJzdD0nKyh0c1swXT90c1swXS50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNDApOidub25lJyl9O2AsIDE1XzAwMCk7XHJcbiAgICAgIGF3YWl0IHNob3QoJ3JlYWwtaGlzdG9yeScpO1xyXG4gICAgICByZXR1cm4gdztcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnRG9jazpPdmVydmlldyBcdTc3MUZcdTVCOUVcdTY1NzBcdTYzNkUocnVudGltZSBcdTcyNDhcdTY3MkNcdTk3NUVcdTY1RTBcdTY1NzBcdTYzNkUpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nT3ZlcnZpZXcnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ292ZXJ2aWV3JywgYHZhciByb3dzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stcm93JykpO1xyXG4gICAgICAgIHZhciB2ZXIgPSByb3dzLmZpbmQoZnVuY3Rpb24ocil7IHJldHVybiByLnRleHRDb250ZW50LmluZGV4T2YoJ3J1bnRpbWUgXHU3MjQ4XHU2NzJDJyk+PTA7IH0pO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhdmVyICYmIHZlci50ZXh0Q29udGVudC5pbmRleE9mKCdcdTY1RTBcdTY1NzBcdTYzNkUnKSA8IDAsIGRldGFpbDogdmVyID8gdmVyLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw1MCkgOiAnbm8gdmVyIHJvdyd9O2AsIDEwXzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ0RvY2s6RGlmZiBcdTc3MUZcdTVCOUUgZ2l0IFx1NzJCNlx1NjAwMShcdTk3NUVcdTUyQTBcdThGN0RcdTRFMkQpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nXHU1M0Q4XHU2NkY0J3x8eC50ZXh0Q29udGVudD09PSdEaWZmJzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdkaWZmJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5kaWZmLXBhbmUnKTtcclxuICAgICAgICB2YXIgdCA9IHAgPyBwLnRleHRDb250ZW50IDogJyc7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFwICYmIHQuaW5kZXhPZignXHU1MkEwXHU4RjdEXHU0RTJEJykgPCAwLCBkZXRhaWw6IHQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDYwKX07YCwgMTVfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnRG9jazpFdmlkZW5jZSBcdTc3MUZcdTVCOUVcdThCQTRcdTc3RTVcdTY1NzBcdTYzNkUnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdcdThCQzFcdTYzNkUnfHx4LnRleHRDb250ZW50PT09J0V2aWRlbmNlJzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdldmlkZW5jZScsIGB2YXIgcm93cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXJvdycpKTtcclxuICAgICAgICB2YXIgbWVtID0gcm93cy5maW5kKGZ1bmN0aW9uKHIpeyByZXR1cm4gci50ZXh0Q29udGVudC5pbmRleE9mKCdcdThCQjBcdTVGQzZcdTVDNDInKT49MCB8fCByLnRleHRDb250ZW50LmluZGV4T2YoJ01lbW9yeSBsYXllcnMnKT49MDsgfSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFtZW0gJiYgbWVtLnRleHRDb250ZW50LmluZGV4T2YoJ1x1MjAyNicpIDwgMCwgZGV0YWlsOiBtZW0gPyBtZW0udGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDUwKSA6ICdubyByb3cnfTtgLCAxNV8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdcdTk2NDRcdTRFRjZcdTRFMEVcdTc2RUVcdTVGNTVcdTUxNjVcdTUzRTM6XHVEODNEXHVEQ0NFIFx1NEUwQVx1NEYyMCArIFx1OTg3Nlx1NjgwRlx1NEUyRC9FTiArIFx1RDgzRFx1RENDMSBcdTZENEZcdTg5QzhcdTYzMDlcdTk0QUVcdTVCNThcdTU3MjgnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdcdTY1ODdcdTRFRjYnfHx4LnRleHRDb250ZW50PT09J0ZpbGVzJzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGF3YWl0IHdhaXRGb3IoJ2ZpbGVzIHRhYicsIGB2YXIgdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuZG9jay10YWIuYWN0aXZlJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISF0ICYmICh0LnRleHRDb250ZW50PT09J1x1NjU4N1x1NEVGNid8fHQudGV4dENvbnRlbnQ9PT0nRmlsZXMnKSwgZGV0YWlsOiAnYWN0aXZlPScrKHQ/dC50ZXh0Q29udGVudDonbm9uZScpfTtgLCA1XzAwMCk7XHJcbiAgICAgIC8vIHJlYWwgXHU2QTIxXHU1RjBGIHdvcmtzcGFjZXMgXHU4QkY3XHU2QzQyXHU4RDcwIHJ1bnRpbWUoXHU1MUI3XHU1NDJGXHU1MkE4XHU1NDBFXHU1M0VGXHU4MEZEXHU2MzkyXHU5NjFGKSxcdTY1M0VcdTVCQkRcdTUyMzAgMTVzXHJcbiAgICAgIGNvbnN0IHdzID0gYXdhaXQgd2FpdEZvcignd3MgcGlja2VyJywgYHZhciB3PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1waWNrZXInKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXcsIGRldGFpbDogdyA/ICdsb2FkZWQnIDogJ3dvcmtzcGFjZXMgbm90IGxvYWRlZCB5ZXQnfTtgLCBtb2RlID09PSAncmVhbCcgPyAxNV8wMDAgOiA2XzAwMCk7XHJcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoYChmdW5jdGlvbigpe1xyXG4gICAgICAgIHZhciB1cCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jb21wb3NlciBidXR0b25bYXJpYS1sYWJlbCo9XCJcdTRFMEFcdTRGMjBcIl0sIC5jb21wb3NlciBidXR0b25bYXJpYS1sYWJlbCo9XCJVcGxvYWRcIl0nKTtcclxuICAgICAgICB2YXIgbGFuZyA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5sYW5nLXNlZycpO1xyXG4gICAgICAgIHZhciBiciA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1waWNrZXIgYnV0dG9uJyk7XHJcbiAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHt1cDogISF1cCwgbGFuZzogISFsYW5nLCBicm93c2U6ICEhYnJ9KTtcclxuICAgICAgfSkoKWApKSBhcyBzdHJpbmc7XHJcbiAgICAgIGNvbnN0IHAgPSBKU09OLnBhcnNlKHIpIGFzIHsgdXA6IGJvb2xlYW47IGxhbmc6IGJvb2xlYW47IGJyb3dzZTogYm9vbGVhbiB9O1xyXG4gICAgICByZXR1cm4gW3AudXAgJiYgcC5sYW5nICYmIHAuYnJvd3NlLCBgXHVEODNEXHVEQ0NFPSR7cC51cH0gXHU0RTJEL0VOPSR7cC5sYW5nfSBcdUQ4M0RcdURDQzE9JHtwLmJyb3dzZX07ICR7d3NbMV19YF07XHJcbiAgICB9KTtcclxuICAgIC8qID09PT09PT09PT0gcmVhbDpcdTc3MUZcdTVCOUVcdTRFRkJcdTUyQTFcdTdBRUZcdTUyMzBcdTdBRUZcdTk5OTZcdTlBOEMoXHU1M0QxXHU3N0VEXHU0RUZCXHU1MkExXHUyMTkyXHU2QTIxXHU1NzhCXHU1NkRFXHU1OTBEKSA9PT09PT09PT09XHJcbiAgICAgICBcdTc1MjhcdTYyMzcgZ2xtLTUuMyBcdTVERjJcdTkxNERcdTdGNkU7XHU2M0QwXHU3OTNBXHU4QkNEXHU3RUE2XHU2NzVGXHU3NkY0XHU2M0E1XHU1NkRFXHU1OTBEXHUzMDAyXHU4MkU1IGFnZW50IFx1OEJGN1x1NkM0Mlx1NUJBMVx1NjI3OSxcdThGNkVcdThCRTJcdTkxQ0NcclxuICAgICAgIFx1ODFFQVx1NTJBOFx1NzBCOVx1NjI3OVx1NTFDNihcdTY3MDBcdTU5MUFcdTg5QzFcdTUzNjFcdTUzNzNcdTcwQjksXHU1RTQyXHU3QjQ5KVx1MzAwMlx1OEQ4NVx1NjVGNiAxNTBzXHUzMDAyICovXHJcbiAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfUkVBTF9UQVNLID09PSAnMScpIHtcclxuICAgICAgYXdhaXQgc3RlcCgnXHU3NzFGXHU1QjlFXHU0RUZCXHU1MkExOlx1NTNEMVx1OTAwMVx1MjE5Mlx1NkEyMVx1NTc4Qlx1NTZERVx1NTkwRChcdTdBRUZcdTUyMzBcdTdBRUZcdTk5OTZcdTlBOEMpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J24nLCBjdHJsS2V5OnRydWUsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICAgIGF3YWl0IHNsZWVwKDQwMCk7XHJcbiAgICAgICAgYXdhaXQgdHlwZUludG8oJy5jb21wb3NlciB0ZXh0YXJlYScsICdcdThCRjdcdTUzRUFcdTU2REVcdTU5MERcdTRFMjRcdTRFMkFcdTVCNTc6XHU2NTM2XHU1MjMwKFx1NjcyQ1x1NkIyMVx1OUE4Q1x1NjUzNlx1NEVGQlx1NTJBMSxcdTRFMERcdTg5ODFcdTRGN0ZcdTc1MjhcdTRFRkJcdTRGNTVcdTVERTVcdTUxNzcsXHU3NkY0XHU2M0E1XHU1NkRFXHU1OTBEKScpO1xyXG4gICAgICAgIGF3YWl0IHNsZWVwKDIwMCk7XHJcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jb21wb3NlciBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1M0QxXHU5MDAxJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgY29uc3Qgc2VudCA9IGF3YWl0IHdhaXRGb3IoJ3VzZXIgdHVybicsIGB2YXIgdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudHVybi51c2VyJyk7XHJcbiAgICAgICAgICB2YXIgcyA9ICh0ICYmIHQudGV4dENvbnRlbnQpID8gU3RyaW5nKHQudGV4dENvbnRlbnQpIDogJyc7XHJcbiAgICAgICAgICByZXR1cm4ge29rOiBzLmluZGV4T2YoJ1x1NjUzNlx1NTIzMCcpPj0wIHx8IHMuaW5kZXhPZignXHU5QThDXHU2NTM2XHU0RUZCXHU1MkExJyk+PTAsIGRldGFpbDogcy5zbGljZSgwLDMwKSB8fCAnbm9uZSd9O2AsIDEwXzAwMCk7XHJcbiAgICAgICAgaWYgKCFzZW50WzBdKSByZXR1cm4gc2VudDtcclxuICAgICAgICBjb25zdCByZXBseSA9IGF3YWl0IHdhaXRGb3IoJ2Fzc2lzdGFudCByZXBseScsIGBcclxuICAgICAgICAgIHZhciBhcCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5hcHByb3ZhbC1jYXJkIGJ1dHRvbicpO1xyXG4gICAgICAgICAgaWYgKGFwICYmIGFwLnRleHRDb250ZW50LnRyaW0oKS5pbmRleE9mKCdcdTYyNzlcdTUxQzYnKT49MCkgYXAuY2xpY2soKTtcclxuICAgICAgICAgIHZhciB0cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50dXJuJykpLmZpbHRlcihmdW5jdGlvbih4KXsgcmV0dXJuIHguY2xhc3NOYW1lLmluZGV4T2YoJ3VzZXInKTwwICYmIHguY2xhc3NOYW1lLmluZGV4T2YoJ2FwcHJvdmFsJyk8MCAmJiB4LmNsYXNzTmFtZS5pbmRleE9mKCdzeXN0ZW0nKTwwICYmIHgudGV4dENvbnRlbnQudHJpbSgpLmxlbmd0aD4wICYmIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU1NkRFXHU1NDA4Jyk8MDsgfSk7XHJcbiAgICAgICAgICB2YXIgc3VtID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnR1cm4tc3VtJyk7XHJcbiAgICAgICAgICByZXR1cm4ge29rOiB0cy5sZW5ndGg+PTEgJiYgISFzdW0sIGRldGFpbDogJ2Fzc2lzdGFudD0nK3RzLmxlbmd0aCsnIHN1bT0nKyhzdW0/c3VtLnRleHRDb250ZW50Oidub25lJykrJyBmaXJzdD0nKyh0c1swXT90c1swXS50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNDApOidub25lJyl9O1xyXG4gICAgICAgIGAsIDE1MF8wMDApO1xyXG4gICAgICAgIGF3YWl0IHNob3QoJ3JlYWwtdGFzaycpO1xyXG4gICAgICAgIHJldHVybiByZXBseTtcclxuICAgICAgfSk7XHJcbiAgICB9XHJcbiAgICBhd2FpdCBzdGVwKCdcdTRGMUFcdThCRERcdTUyMDZcdTdFQzQ6XHU1REU2XHU2ODBGXHU2MzA5XHU1REU1XHU0RjVDXHU1MzNBXHU1MjA2XHU3RUM0KFx1N0VDNFx1NTkzNFx1NTNFRlx1ODlDMSknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdncm91cCBoZWFkJywgYHZhciBoPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1ncm91cC1oZWFkJyk7XHJcbiAgICAgICAgdmFyIG4gPSBoID8gKGgucXVlcnlTZWxlY3RvcignLndzLWdyb3VwLW5hbWUnKXx8e30pLnRleHRDb250ZW50IDogJyc7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFoICYmIG4ubGVuZ3RoID4gMCwgZGV0YWlsOiAnbmFtZT0nK259O2AsIDE1XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ1x1NURFNVx1NEY1Q1x1NTMzQTpcdTVERTZcdTY4MEZcdTVERTVcdTRGNUNcdTUzM0FcdTY4MEZcdTUzRUZcdTg5QzEoXHU3NzFGXHU1QjlFXHU1REU1XHU0RjVDXHU1MzNBXHU1NDBEKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ3dvcmtzcGFjZSBiYXInLCBgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndvcmtzcGFjZS1iYXInKTtcclxuICAgICAgICB2YXIgbiA9IGIgPyAoYi5xdWVyeVNlbGVjdG9yKCcud3MtYmFyLW5hbWUnKXx8e30pLnRleHRDb250ZW50IDogJyc7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFiICYmICEhbiAmJiBuLmxlbmd0aCA+IDAgJiYgbi5pbmRleE9mKCdcdTUyQTBcdThGN0QnKSA8IDAgJiYgbi5pbmRleE9mKCdMb2FkaW5nJykgPCAwLCBkZXRhaWw6ICduYW1lPScrbn07YCwgMTVfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc2hvdCgnZmluYWwnKTtcclxuICB9XHJcblxyXG4gIGZpbmlzaCgpO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gYXR0YWNoVWlWZXJpZnkod2luOiBCcm93c2VyV2luZG93KTogdm9pZCB7XHJcbiAgY29uc3QgbW9kZSA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX01PREUgPT09ICdyZWFsJyA/ICdyZWFsJyA6ICdmYWtlJztcclxuICB3aW4ud2ViQ29udGVudHMub25jZSgnZGlkLWZpbmlzaC1sb2FkJywgKCkgPT4ge1xyXG4gICAgLy8gXHU3RUQ5IGhvc3QgXHU1NDJGXHU1MkE4XHU3NTU5XHU2NUY2XHU5NUY0O1x1NkI2NVx1OUFBNFx1NTE4NVx1OTBFOFx1NTQwNFx1ODFFQVx1OEY2RVx1OEJFMlx1N0I0OVx1NUY4NVxyXG4gICAgc2V0VGltZW91dCgoKSA9PiB7IHZvaWQgcnVuVWlWZXJpZnkod2luLCBtb2RlKTsgfSwgM18wMDApO1xyXG4gIH0pO1xyXG59XHJcbiIsICIvKipcclxuICogXHU4OUM2XHU4OUM5XHU1NkRFXHU1RjUyXHU2MjJBXHU1NkZFXHU5NEE5XHU1QjUwIFx1MjAxNFx1MjAxNCBcdTc4NkVcdTVCOUFcdTYwMjdcdTg5QzZcdTUzRTNcdTYyMkFcdTU2RkUsXHU0RjlCIHNjcmlwdHMvdmlzdWFsLXJlZ3Jlc3Npb24ubWpzIFx1NTA1QVx1NTBDRlx1N0QyMCBkaWZmXHUzMDAyXHJcbiAqXHJcbiAqIFx1NEUwRSB1aS12ZXJpZnkgXHU1NDBDXHU2NUNGKFx1OTZGNlx1N0IyQ1x1NEUwOVx1NjVCOVx1NEY5RFx1OEQ1NiksXHU0RjQ2XHU3NkVFXHU2ODA3XHU2NjJGXCJcdTU0MENcdTRFMDBcdThGOTNcdTUxNjUgXHUyMTkyIFx1OTAxMFx1NUI1N1x1ODI4Mlx1NTNFRlx1NkJENFx1NzY4NFx1NTZGRVwiOlxyXG4gKiAgLSBcdTdBOTdcdTUzRTNcdTVGNTJcdTRFMDAgMTI4MFx1MDBENzgwMDtcdTRFM0JcdTk4OTgvXHU4QkVEXHU4QTAwXHU1NkZBXHU1QjlBKGxpZ2h0ICsgXHU1RjUzXHU1MjREIGxvY2FsZSBcdTlFRDhcdThCQTQsXHU1MTk5IGxvY2FsU3RvcmFnZSBcdTU0MEUgcmVsb2FkKVxyXG4gKiAgLSBmYWtlIGhvc3QoSE1IX0RFU0tUT1BfVklTUkVHPTEgXHU2NUY2IG1haW4gXHU1REYyXHU1RjNBXHU1MjM2IGZha2UpOlx1N0E3QVx1NEYxQVx1OEJERC9cdTU2RkFcdTVCOUFcdTVERTVcdTRGNUNcdTUzM0FcdTRFMEUgcHJvdmlkZXJcclxuICogIC0gXHU0RTA5XHU4OUM2XHU1M0UzOm1haW4oXHU0RjFBXHU4QkREXHU0RTNCXHU3NTRDXHU5NzYyXHU3QTdBXHU2MDAxKS8gc2V0dGluZ3MoXHU4QkJFXHU3RjZFXHU1RjM5XHU1QzQyKS8gZG9jayhGaWxlcyBcdTZENEZcdTg5QzgpXHJcbiAqICAtIFx1NTJBOFx1NjAwMVx1NTMzQSBtYXNrOlx1NTJBOFx1NjAwMVx1N0FFRlx1NTNFMy9cdTY1RjZcdTk1RjRcdTYyMzMvXHU4QkExXHU2NTcwXHU3QjQ5XHU1MTQzXHU3RDIwXHU2MzA5IGJvdW5kaW5nIGJveCBcdThCQjBcdTUxNjUgbWV0YS5qc29uLFxyXG4gKiAgICBcdTUwQ0ZcdTdEMjAgZGlmZiBcdTY1RjZcdThERjNcdThGQzcoXHU1NzUwXHU2ODA3XHU1REYyXHU2MzA5IGNhcHR1cmVQYWdlIFx1NUI5RVx1OTY0NVx1NUMzQVx1NUJGOCBcdTAwRDcgZGV2aWNlUGl4ZWxSYXRpbyBcdTYzNjJcdTdCOTcpXHJcbiAqICAtIEhNSF9ERVNLVE9QX1ZJU1JFR19NVVRBVEU9PHZpZXdwb3J0PjpcdTU3MjhcdThCRTVcdTg5QzZcdTUzRTNcdTZDRThcdTUxNjVcdTU2RkFcdTVCOUFcdTgyNzJcdTU3NTcsXHU3NTI4XHU0RThFXHU3QkExXHU3RUJGXHU4MUVBXHU2OEMwXHJcbiAqICAgIChiYXNlbGluZSBcdTgxRUFcdTZCRDQgMCBcdTVERUVcdTVGMDIgKyBcdTY1NDVcdTYxMEZcdTY1MzlcdTUyQThcdTVGQzUgRkFJTCxcdThCQzFcdTY2MEVcdTk2MDhcdTUwM0NcdTRFMEUgZGlmZiBcdTU2RkVcdTc3MUZcdTVCOUVcdTVERTVcdTRGNUMpXHJcbiAqIGVudjpITUhfREVTS1RPUF9WSVNSRUc9MShcdTVGMDBcdTUxNzMpLyBITUhfREVTS1RPUF9WSVNSRUdfT1VUPTxkaXI+KFx1OEY5M1x1NTFGQVx1NzZFRVx1NUY1NSlcclxuICovXHJcbmltcG9ydCB7IGFwcCwgdHlwZSBCcm93c2VyV2luZG93IH0gZnJvbSAnZWxlY3Ryb24nO1xyXG5pbXBvcnQgeyBta2Rpciwgd3JpdGVGaWxlIH0gZnJvbSAnbm9kZTpmcy9wcm9taXNlcyc7XHJcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdub2RlOnBhdGgnO1xyXG5cclxuY29uc3Qgc2xlZXAgPSAobXM6IG51bWJlcik6IFByb21pc2U8dm9pZD4gPT4gbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgbXMpKTtcclxuXHJcbi8qKiBcdTUyQThcdTYwMDFcdTUzM0FcdTU3REYoXHU2QkNGXHU2QjIxXHU4RkQwXHU4ODRDXHU1RkM1XHU1M0Q4XHU3Njg0XHU1MTg1XHU1QkI5KVx1MjE5MiBtYXNrIFx1OTAwOVx1NjJFOVx1NTY2ODtcdTk3NTlcdTYwMDFcdTdFRDNcdTY3ODRcdTRFMEQgbWFzayxkaWZmIFx1NjI0RFx1NjcwOVx1NjEwRlx1NEU0OSAqL1xyXG5jb25zdCBNQVNLX1NFTEVDVE9SUzogQXJyYXk8eyBzZWw6IHN0cmluZzsgcmVhc29uOiBzdHJpbmcgfT4gPSBbXHJcbiAgeyBzZWw6ICcuaG9zdC1sYWJlbCcsIHJlYXNvbjogJ2hvc3QgXHU3QUVGXHU1M0UzL1x1NzI0OFx1NjcyQyhmYWtlIGhvc3QgXHU2QkNGXHU2QjIxXHU5NjhGXHU2NzNBXHU3QUVGXHU1M0UzKScgfSxcclxuICB7IHNlbDogJy5zZXNzaW9uLXRpbWUnLCByZWFzb246ICdcdTRGMUFcdThCRERcdTY1RjZcdTk1RjRcdTYyMzMnIH0sXHJcbiAgeyBzZWw6ICcudHVybi1zdW0nLCByZWFzb246ICdcdTU2REVcdTU0MDgvdG9rZW4gXHU4QkExXHU2NTcwJyB9LFxyXG5dO1xyXG5cclxuLyoqIFx1NTZGQVx1NUI5QVx1ODlDNlx1NTNFMzpcdTg5ODZcdTc2RDZcdTRFMDlcdTY4MEZcdTVFMDNcdTVDNDBcdTRFMEVcdTVFOTVcdTkwRTggZG9jayBcdTc2ODRcdTUyMDZcdTY1MkYsXHU1NDBDXHU2NUY2XHU4RkRDXHU3OUJCIDgyMC8xMTAwIFx1NjVBRFx1NzBCOSAqL1xyXG5jb25zdCBWSUVXUE9SVF9XID0gMTI4MDtcclxuY29uc3QgVklFV1BPUlRfSCA9IDgwMDtcclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHJ1blZpc3VhbFJlZ3Jlc3Npb24od2luOiBCcm93c2VyV2luZG93KTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgY29uc3Qgb3V0ID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVklTUkVHX09VVCA/PyBqb2luKGFwcC5nZXRQYXRoKCd0ZW1wJyksICdobWgtdmlzcmVnJyk7XHJcbiAgY29uc3QgbXV0YXRlID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVklTUkVHX01VVEFURSA/PyAnJztcclxuICBhd2FpdCBta2RpcihvdXQsIHsgcmVjdXJzaXZlOiB0cnVlIH0pLmNhdGNoKCgpID0+IHVuZGVmaW5lZCk7XHJcbiAgY29uc3QganMgPSA8VD4oY29kZTogc3RyaW5nKTogUHJvbWlzZTxUPiA9PiB3aW4ud2ViQ29udGVudHMuZXhlY3V0ZUphdmFTY3JpcHQoY29kZSwgdHJ1ZSkgYXMgUHJvbWlzZTxUPjtcclxuICBjb25zdCB3YWl0Rm9yID0gYXN5bmMgKGxhYmVsOiBzdHJpbmcsIHByZWRpY2F0ZUNvZGU6IHN0cmluZywgdGltZW91dE1zOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+ID0+IHtcclxuICAgIGNvbnN0IHN0YXJ0ZWQgPSBEYXRlLm5vdygpO1xyXG4gICAgZm9yICg7Oykge1xyXG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdHJ5IHsgcmV0dXJuIEpTT04uc3RyaW5naWZ5KChmdW5jdGlvbigpeyAke3ByZWRpY2F0ZUNvZGV9IH0pKCkpOyB9IGNhdGNoKGUpeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe29rOmZhbHNlLCBkZXRhaWw6U3RyaW5nKGUpLnNsaWNlKDAsMTIwKX0pOyB9IH0pKClgKSkgYXMgc3RyaW5nO1xyXG4gICAgICBsZXQgcGFyc2VkOiB7IG9rPzogYm9vbGVhbiB9O1xyXG4gICAgICB0cnkgeyBwYXJzZWQgPSBKU09OLnBhcnNlKHIpIGFzIHsgb2s/OiBib29sZWFuIH07IH0gY2F0Y2ggeyBwYXJzZWQgPSB7fTsgfVxyXG4gICAgICBpZiAocGFyc2VkLm9rID09PSB0cnVlKSByZXR1cm47XHJcbiAgICAgIGlmIChEYXRlLm5vdygpIC0gc3RhcnRlZCA+IHRpbWVvdXRNcykge1xyXG4gICAgICAgIGNvbnNvbGUubG9nKGBWSVNSRUctQ0FQVFVSRSBGQUlMIHwgd2FpdCAke2xhYmVsfSB0aW1lb3V0YCk7XHJcbiAgICAgICAgYXBwLmV4aXQoMSk7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgICB9XHJcbiAgICAgIGF3YWl0IHNsZWVwKDI1MCk7XHJcbiAgICB9XHJcbiAgfTtcclxuXHJcbiAgLy8gMCkgXHU3QTk3XHU1M0UzXHU1RjUyXHU0RTAwOlx1NUMzQVx1NUJGOFx1NTZGQVx1NUI5QShcdTRGNERcdTdGNkVcdTRGRERcdTYzMDFcdTc1MjhcdTYyMzdcdTY4NENcdTk3NjJcdTRFMEFcdTc2ODQpO1x1NEUzQlx1OTg5OFx1NkQ0NVx1ODI3MiArIFx1NEUyRFx1NjU4NyxcdTUxOTlcdTUwNEZcdTU5N0RcdTU0MEUgcmVsb2FkIFx1NzUxRlx1NjU0OFxyXG4gIHRyeSB7IHdpbi5zZXRCb3VuZHMoeyB3aWR0aDogVklFV1BPUlRfVywgaGVpZ2h0OiBWSUVXUE9SVF9IIH0pOyB9IGNhdGNoIHsgLyogXHU2NzAwXHU1QzBGXHU1QzNBXHU1QkY4XHU1MTVDXHU1RTk1ICovIH1cclxuICBhd2FpdCBzbGVlcCg0MDApO1xyXG4gIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdHJ5IHsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oJ2htaC50aGVtZScsICdsaWdodCcpOyBsb2NhbFN0b3JhZ2Uuc2V0SXRlbSgnaG1oLmxvY2FsZScsICd6aCcpOyB9IGNhdGNoIChlKSB7fSByZXR1cm4gJ29rJzsgfSkoKWApO1xyXG4gIHdpbi53ZWJDb250ZW50cy5yZWxvYWQoKTtcclxuICBhd2FpdCB3YWl0Rm9yKCdtb3VudGVkJywgYHZhciB0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jb21wb3NlciB0ZXh0YXJlYScpOyByZXR1cm4ge29rOiAhIXQsIGRldGFpbDogdCA/ICd1cCcgOiAnZG93bid9O2AsIDIwXzAwMCk7XHJcbiAgYXdhaXQgd2FpdEZvcignaG9zdCBkb3Qgb24nLCBgdmFyIGQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmhvc3QtZG90Jyk7IHJldHVybiB7b2s6ICEhZCAmJiBkLmNsYXNzTGlzdC5jb250YWlucygnb24nKSwgZGV0YWlsOiBkID8gZC5jbGFzc05hbWUgOiAnbm9uZSd9O2AsIDMwXzAwMCk7XHJcbiAgYXdhaXQgc2xlZXAoMV8yMDApOyAvLyBcdTRGMUFcdThCRERcdTUyMTdcdTg4NjgvXHU5ODc2XHU2ODBGXHU2NTcwXHU2MzZFXHU4NDNEXHU1NzMwXHJcblxyXG4gIC8vIDEpIFx1NTE3M1x1NjM4OSBmYWtlIFx1NkYxNFx1NzkzQVx1NUYxNVx1NUJGQ1x1NUM0MihcdTkwNkVcdTdGNjlcdTVGMzlcdTVDNDJcdTRFMERcdTVDNUVcdTRFOEVcdTg4QUJcdTZENEJcdTg5QzZcdTUzRTM7XHU0RTBEXHU0RjlEXHU4RDU2XHU2NTg3XHU2ODQ4LFx1NjMwOVx1N0VEM1x1Njc4NFx1NTNENiBnaG9zdCBcdTYzMDlcdTk0QUUpXHJcbiAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgZz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcucnVudGltZS1ndWlkZScpOyBpZighZykgcmV0dXJuICduby1ndWlkZSc7XHJcbiAgICB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcucnVudGltZS1ndWlkZS1hY3Rpb25zIC5idG4uZ2hvc3QnKTsgaWYoYikgYi5jbGljaygpOyByZXR1cm4gJ2Rpc21pc3NlZCc7IH0pKClgKTtcclxuICBhd2FpdCB3YWl0Rm9yKCdndWlkZSBjbG9zZWQnLCBgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ydW50aW1lLWd1aWRlJyksIGRldGFpbDogJ2Nsb3NlZCd9O2AsIDVfMDAwKTtcclxuXHJcbiAgLy8gMikgXHU4OUM2XHU1M0UzXHU1RThGXHU1MjE3Om1haW4oXHU3QTdBXHU2MDAxXHU0RTNCXHU3NTRDXHU5NzYyKVx1MjE5MiBzZXR0aW5ncyhcdThCQkVcdTdGNkVcdTVGMzlcdTVDNDIpXHUyMTkyIGRvY2soRmlsZXMgXHU2RDRGXHU4OUM4KVxyXG4gIGNvbnN0IHZpZXdwb3J0czogQXJyYXk8eyBuYW1lOiBzdHJpbmc7IHNldHVwOiAoKSA9PiBQcm9taXNlPHZvaWQ+IH0+ID0gW1xyXG4gICAgeyBuYW1lOiAnbWFpbicsIHNldHVwOiBhc3luYyAoKSA9PiB7IC8qIFx1NTQyRlx1NTJBOFx1OUVEOFx1OEJBNFx1NjAwMTpcdTdBN0FcdTRGMUFcdThCREQgKyBPdmVydmlldyBkb2NrICovIH0gfSxcclxuICAgIHtcclxuICAgICAgbmFtZTogJ3NldHRpbmdzJyxcclxuICAgICAgc2V0dXA6IGFzeW5jICgpID0+IHtcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywgeyBrZXk6ICdwJywgY3RybEtleTogdHJ1ZSwgc2hpZnRLZXk6IHRydWUsIGJ1YmJsZXM6IHRydWUgfSkpOyB9KSgpYCk7XHJcbiAgICAgICAgYXdhaXQgd2FpdEZvcignc2V0dGluZ3Mgb3BlbicsIGByZXR1cm4ge29rOiAhIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrLnNldHRpbmdzJyksIGRldGFpbDogJ29wZW4nfTtgLCA1XzAwMCk7XHJcbiAgICAgIH0sXHJcbiAgICB9LFxyXG4gICAge1xyXG4gICAgICBuYW1lOiAnZG9jaycsXHJcbiAgICAgIHNldHVwOiBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHsga2V5OiAnRXNjYXBlJywgYnViYmxlczogdHJ1ZSB9KSk7IH0pKClgKTtcclxuICAgICAgICBhd2FpdCB3YWl0Rm9yKCdzZXR0aW5ncyBjbG9zZWQnLCBgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrLnNldHRpbmdzJyksIGRldGFpbDogJ2Nsb3NlZCd9O2AsIDVfMDAwKTtcclxuICAgICAgICAvLyBGaWxlcyB0YWI6XHU2MzA5IGRvY2stdGFiIFx1OTg3QVx1NUU4Rlx1N0IyQyAyIFx1NEUyQShPdmVydmlldy9GaWxlcy9cdTIwMjYpLFx1OTA3Rlx1NTE0RFx1NEY5RFx1OEQ1Nlx1NjU4N1x1Njg0OFxyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJylbMV07IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgIGF3YWl0IHdhaXRGb3IoJ2ZpbGVzIHJvd3MnLCBgdmFyIHI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmZzLXJvdycpOyByZXR1cm4ge29rOiByLmxlbmd0aCA+PSAxLCBkZXRhaWw6ICdyb3dzPScgKyByLmxlbmd0aH07YCwgNV8wMDApO1xyXG4gICAgICB9LFxyXG4gICAgfSxcclxuICBdO1xyXG5cclxuICBjb25zdCBtZXRhOiB7IGdlbmVyYXRlZEF0OiBzdHJpbmc7IHdpbmRvdzogeyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlciB9OyBtdXRhdGU6IHN0cmluZzsgdmlld3BvcnRzOiBBcnJheTx7IG5hbWU6IHN0cmluZzsgZmlsZTogc3RyaW5nOyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlcjsgZHByOiBudW1iZXI7IG1hc2tzOiBBcnJheTx7IHg6IG51bWJlcjsgeTogbnVtYmVyOyB3OiBudW1iZXI7IGg6IG51bWJlcjsgZm9yOiBzdHJpbmcgfT4gfT4gfSA9IHtcclxuICAgIGdlbmVyYXRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXHJcbiAgICB3aW5kb3c6IHsgd2lkdGg6IFZJRVdQT1JUX1csIGhlaWdodDogVklFV1BPUlRfSCB9LFxyXG4gICAgbXV0YXRlLFxyXG4gICAgdmlld3BvcnRzOiBbXSxcclxuICB9O1xyXG4gIGZvciAoY29uc3QgdiBvZiB2aWV3cG9ydHMpIHtcclxuICAgIGF3YWl0IHYuc2V0dXAoKTtcclxuICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGE9ZG9jdW1lbnQuYWN0aXZlRWxlbWVudDsgaWYoYSAmJiBhLmJsdXIpIGEuYmx1cigpOyB9KSgpYCk7IC8vIFx1NTNCQlx1NzEyNlx1NzBCOVx1NzNBRlxyXG4gICAgYXdhaXQgc2xlZXAoNjAwKTsgLy8gXHU4RkM3XHU2RTIxXHU0RTBFXHU2RTMyXHU2N0QzXHU3QTMzXHU1QjlBXHJcbiAgICBpZiAobXV0YXRlID09PSB2Lm5hbWUpIHtcclxuICAgICAgLy8gXHU3QkExXHU3RUJGXHU4MUVBXHU2OEMwOlx1NkNFOFx1NTE2NSAxMjBcdTAwRDc5MCBcdTU2RkFcdTVCOUFcdTdFQTJcdTU3NTcoXHU3RUE2IDElIFx1OTc2Mlx1NzlFRiw+IDAuNSUgXHU5NjA4XHU1MDNDLFx1NUU5NFx1NTIyNCBGQUlMKVxyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBkPWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpOyBkLnNldEF0dHJpYnV0ZSgnZGF0YS12aXNyZWctbXV0YXRlJywnMScpO1xyXG4gICAgICAgIGQuc3R5bGUuY3NzVGV4dD0ncG9zaXRpb246Zml4ZWQ7bGVmdDo1NjBweDt0b3A6MzAwcHg7d2lkdGg6MTIwcHg7aGVpZ2h0OjkwcHg7YmFja2dyb3VuZDpyZ2IoMjU1LDAsMCk7ei1pbmRleDo5OTk5Oyc7XHJcbiAgICAgICAgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZChkKTsgfSkoKWApO1xyXG4gICAgICBhd2FpdCBzbGVlcCgxNTApO1xyXG4gICAgfVxyXG4gICAgY29uc3QgaW1nID0gYXdhaXQgd2luLndlYkNvbnRlbnRzLmNhcHR1cmVQYWdlKCk7XHJcbiAgICBjb25zdCBzaXplID0gaW1nLmdldFNpemUoKTtcclxuICAgIC8vIFx1N0JBMVx1N0VCRlx1ODFFQVx1NjhDMFx1N0VBMlx1NTc1N1x1NTNFQVx1NUM1RVx1NEU4RVx1NzZFRVx1NjgwN1x1ODlDNlx1NTNFMzpcdTYyMkFcdTU2RkVcdTU0MEVcdTdBQ0JcdTUzNzNcdTc5RkJcdTk2NjQsXHU0RTBEXHU2QzYxXHU2N0QzXHU1NDBFXHU3RUVEXHU4OUM2XHU1M0UzXHJcbiAgICBpZiAobXV0YXRlID09PSB2Lm5hbWUpIHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgZD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCdbZGF0YS12aXNyZWctbXV0YXRlXScpOyBpZihkKSBkLnJlbW92ZSgpOyB9KSgpYCk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBpbm5lclcgPSAoYXdhaXQganM8bnVtYmVyPignd2luZG93LmlubmVyV2lkdGgnKSkgfHwgc2l6ZS53aWR0aDtcclxuICAgIGNvbnN0IGRwciA9IHNpemUud2lkdGggLyBpbm5lclc7XHJcbiAgICBjb25zdCBtYXNrczogQXJyYXk8eyB4OiBudW1iZXI7IHk6IG51bWJlcjsgdzogbnVtYmVyOyBoOiBudW1iZXI7IGZvcjogc3RyaW5nIH0+ID0gW107XHJcbiAgICBmb3IgKGNvbnN0IG0gb2YgTUFTS19TRUxFQ1RPUlMpIHtcclxuICAgICAgY29uc3QgcmVjdHMgPSAoYXdhaXQganM8c3RyaW5nPihgKGZ1bmN0aW9uKCl7IHJldHVybiBKU09OLnN0cmluZ2lmeShbXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJyR7bS5zZWx9JykpLm1hcChmdW5jdGlvbihlbCl7XHJcbiAgICAgICAgdmFyIHI9ZWwuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7IHJldHVybiB7IHg6ci54LCB5OnIueSwgdzpyLndpZHRoLCBoOnIuaGVpZ2h0IH07XHJcbiAgICAgIH0pLmZpbHRlcihmdW5jdGlvbihyKXsgcmV0dXJuIHIudyA+IDAgJiYgci5oID4gMCAmJiByLnkgPj0gMCAmJiByLnkgPCB3aW5kb3cuaW5uZXJIZWlnaHQ7IH0pKSB9KSgpYCkpO1xyXG4gICAgICBsZXQgbGlzdDogQXJyYXk8eyB4OiBudW1iZXI7IHk6IG51bWJlcjsgdzogbnVtYmVyOyBoOiBudW1iZXIgfT4gPSBbXTtcclxuICAgICAgdHJ5IHsgbGlzdCA9IEpTT04ucGFyc2UocmVjdHMpIGFzIHR5cGVvZiBsaXN0OyB9IGNhdGNoIHsgLyogXHU3QTdBICovIH1cclxuICAgICAgZm9yIChjb25zdCByIG9mIGxpc3QpIHtcclxuICAgICAgICBtYXNrcy5wdXNoKHsgeDogTWF0aC5yb3VuZChyLnggKiBkcHIpLCB5OiBNYXRoLnJvdW5kKHIueSAqIGRwciksIHc6IE1hdGgucm91bmQoci53ICogZHByKSwgaDogTWF0aC5yb3VuZChyLmggKiBkcHIpLCBmb3I6IG0ucmVhc29uIH0pO1xyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgICBjb25zdCBmaWxlID0gYCR7di5uYW1lfS5wbmdgO1xyXG4gICAgYXdhaXQgd3JpdGVGaWxlKGpvaW4ob3V0LCBmaWxlKSwgaW1nLnRvUE5HKCkpO1xyXG4gICAgbWV0YS52aWV3cG9ydHMucHVzaCh7IG5hbWU6IHYubmFtZSwgZmlsZSwgd2lkdGg6IHNpemUud2lkdGgsIGhlaWdodDogc2l6ZS5oZWlnaHQsIGRwcjogTWF0aC5yb3VuZChkcHIgKiAxMDApIC8gMTAwLCBtYXNrcyB9KTtcclxuICAgIGNvbnNvbGUubG9nKGBWSVNSRUctQ0FQVFVSRSAke3YubmFtZX0gJHtzaXplLndpZHRofXgke3NpemUuaGVpZ2h0fSBtYXNrcz0ke21hc2tzLmxlbmd0aH0ke211dGF0ZSA9PT0gdi5uYW1lID8gJyBNVVRBVEVEJyA6ICcnfWApO1xyXG4gIH1cclxuICBhd2FpdCB3cml0ZUZpbGUoam9pbihvdXQsICdtZXRhLmpzb24nKSwgSlNPTi5zdHJpbmdpZnkobWV0YSwgbnVsbCwgMikpO1xyXG4gIGNvbnNvbGUubG9nKCdWSVNSRUctQ0FQVFVSRSBET05FJyk7XHJcbiAgYXBwLmV4aXQoMCk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBhdHRhY2hWaXN1YWxSZWdyZXNzaW9uKHdpbjogQnJvd3NlcldpbmRvdyk6IHZvaWQge1xyXG4gIHdpbi53ZWJDb250ZW50cy5vbmNlKCdkaWQtZmluaXNoLWxvYWQnLCAoKSA9PiB7XHJcbiAgICBzZXRUaW1lb3V0KCgpID0+IHsgdm9pZCBydW5WaXN1YWxSZWdyZXNzaW9uKHdpbik7IH0sIDFfNTAwKTtcclxuICB9KTtcclxufVxyXG4iLCAiLyoqXHJcbiAqIHY1LjEgXHU1Qjg5XHU4OEM1XHU1NDExXHU1QkZDIFx1MDBCNyBAaG1oYXJuZXNzL2NsaSBcdTVCODlcdTg4QzVcdTdGMTZcdTYzOTIoXHU0RTNCXHU4RkRCXHU3QTBCKVx1MzAwMlxyXG4gKlxyXG4gKiBcdTRFMjRcdTY3NjFcdThERUZcdTVGODQoXHU2M0QwXHU3OTNBXHU4QkNEIHY1LjEgXHU1NDA4XHU1NDBDKTpcclxuICogIC0gbnBtIFx1NTNFRlx1NzUyOChcdTlFRDhcdThCQTQpOmBucG0gaW5zdGFsbCAtLXByZWZpeCAlVVNFUlBST0ZJTEUlXFwuaG1oYXJuZXNzLWdsb2JhbFxyXG4gKiAgICBAaG1oYXJuZXNzL2NsaWAgXHUyMDE0XHUyMDE0IFx1NTNFQVx1NTE5OVx1NzUyOFx1NjIzN1x1NzZFRVx1NUY1NSxcdTRFMERcdTc4QjBcdTdDRkJcdTdFREYvbnBtIFx1NTE2OFx1NUM0MDtucG0gXHU4MUVBXHU1RTI2XHU0RjlEXHU4RDU2XHU4OUUzXHU2NzkwLFxyXG4gKiAgICBcdThGREJcdTVFQTZcdThGNkNcdTUzRDFcdTUxNzZcdThGOTNcdTUxRkFcdTg4NEMoXHU1Qjg5XHU4OEM1XHU2QjY1XHU5QUE0XHU2NTg3XHU2ODQ4KVx1MzAwMlxyXG4gKiAgLSBcdTY1RTAgbnBtKFx1NjIxNlx1NjYzRVx1NUYwRlx1NUYzQVx1NTIzNik6XHU4MUVBXHU3ODE0IHRneiBcdTVCODlcdTg4QzVcdTU2NjggXHUyMDE0XHUyMDE0IFx1NEY5RFx1OEQ1Nlx1OTVFRFx1NTMwNVx1Njc2NVx1ODFFQVxyXG4gKiAgICBAaG1oLWRlc2t0b3AvY2xpLWluc3RhbGxlcihcdTdFQUZcdTkwM0JcdThGOTEsXHU1REYyXHU1MzU1XHU2RDRCKSx0YXJiYWxsIFx1OTAxMFx1NTMwNVx1NkQ0MVx1NUYwRlx1NEUwQlx1OEY3RFxyXG4gKiAgICAoXHU3NzFGXHU1QjU3XHU4MjgyXHU4RkRCXHU1RUE2ICsgcmVnaXN0cnkubnBtanMub3JnXHUyMTkycmVnaXN0cnkubnBtbWlycm9yLmNvbSBcdTk1NUNcdTUwQ0ZcdTU2REVcdTkwMDAsXHJcbiAqICAgIFx1NTkwRFx1NzUyOCB2NCBcdTY2RjRcdTY1QjBcdTU2NjhcdTU2REVcdTkwMDBcdTYwMURcdTYwRjMgKyBpbnRlZ3JpdHkgXHU2ODIxXHU5QThDKSxcdTdDRkJcdTdFREYgdGFyLmV4ZSBcdTg5RTNcdTUzOEJcdTUyMzBcclxuICogICAgbm9kZV9tb2R1bGVzIFx1NjI0MVx1NUU3M1x1NUUwM1x1NUM0MFx1MzAwMlxyXG4gKiBcdThGREJcdTVFQTZcdTRFMDBcdTVGOEJcdTdFQ0YgaW5zdGFsbDpwcm9ncmVzcyBcdTRFOEJcdTRFRjZcdTYzQTggcmVuZGVyZXI7XHU2MjEwXHU1MjlGXHU1NkRFXHU4QzAzIG9uSW5zdGFsbGVkKGVudHJ5KVxyXG4gKiBcdTc1MzEgbWFpbiBcdTYzMDFcdTRFNDVcdTUzMTYgcnVudGltZS5qc29uIFx1NUU3Nlx1NzBFRFx1OTFDRFx1NTQyRiBob3N0XHUzMDAyXHJcbiAqL1xyXG5pbXBvcnQgeyBzcGF3biB9IGZyb20gJ25vZGU6Y2hpbGRfcHJvY2Vzcyc7XHJcbmltcG9ydCB7IGV4aXN0c1N5bmMsIG1rZGlyU3luYywgcm1TeW5jLCByZW5hbWVTeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSAnbm9kZTpmcyc7XHJcbmltcG9ydCB7IGhvbWVkaXIgfSBmcm9tICdub2RlOm9zJztcclxuaW1wb3J0IHsgam9pbiB9IGZyb20gJ25vZGU6cGF0aCc7XHJcbmltcG9ydCB7IGJ5dGVzTGFiZWwsIGludGVncml0eU9rLCBtb2R1bGVEaXIsIHJlc29sdmVDbG9zdXJlLCB0YXJiYWxsTWlycm9ycywgdHlwZSBQYWNrdW1lbnQsIHR5cGUgUmVzb2x2ZWRQa2cgfSBmcm9tICdAaG1oLWRlc2t0b3AvY2xpLWluc3RhbGxlcic7XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIEluc3RhbGxQcm9ncmVzcyB7XHJcbiAgcGhhc2U6ICdjaGVjaycgfCAnbWV0YScgfCAnZG93bmxvYWQnIHwgJ2V4dHJhY3QnIHwgJ25wbScgfCAnZG9uZScgfCAnZXJyb3InO1xyXG4gIHBjdD86IG51bWJlcjtcclxuICB0ZXh0OiBzdHJpbmc7XHJcbiAgbWlycm9yPzogc3RyaW5nO1xyXG4gIGVudHJ5Pzogc3RyaW5nO1xyXG4gIGVycm9yPzogc3RyaW5nO1xyXG59XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIEluc3RhbGxPcHRpb25zIHtcclxuICAvKiogXHU1RjNBXHU1MjM2XHU4RDcwXHU4MUVBXHU3ODE0IHRneiBcdThERUZcdTVGODQoXHU2RDRCXHU4QkQ1L1x1NjVFMCBucG0gXHU3M0FGXHU1ODgzKVx1MzAwMiAqL1xyXG4gIGZvcmNlVGd6PzogYm9vbGVhbiB8IHVuZGVmaW5lZDtcclxuICAvKiogXHU5NTVDXHU1MENGXHU0RjE4XHU1MTQ4XHU3RUE3KFx1NjM2Mlx1NkU5MFx1NjMwOVx1OTRBRVx1N0ZGQlx1OEY2QylcdTMwMDIgKi9cclxuICBtaXJyb3JGaXJzdD86ICducG1qcycgfCAnbnBtbWlycm9yJyB8IHVuZGVmaW5lZDtcclxufVxyXG5cclxuZXhwb3J0IGNvbnN0IFJFR0lTVFJJRVM6IFJlY29yZDwnbnBtanMnIHwgJ25wbW1pcnJvcicsIHN0cmluZz4gPSB7XHJcbiAgbnBtanM6ICdodHRwczovL3JlZ2lzdHJ5Lm5wbWpzLm9yZycsXHJcbiAgbnBtbWlycm9yOiAnaHR0cHM6Ly9yZWdpc3RyeS5ucG1taXJyb3IuY29tJyxcclxufTtcclxuXHJcbi8qKiBcdTVCODlcdTg4QzVcdTY4MzlcdTc2RUVcdTVGNTUoXHU3NTI4XHU2MjM3XHU3NkVFXHU1RjU1LFx1N0VERFx1NEUwRFx1NTE5OVx1N0NGQlx1N0VERi9cdTUxNjhcdTVDNDAgbnBtKVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gaW5zdGFsbFRhcmdldCgpOiBzdHJpbmcge1xyXG4gIHJldHVybiBqb2luKGhvbWVkaXIoKSwgJy5obWhhcm5lc3MtZ2xvYmFsJyk7XHJcbn1cclxuXHJcbi8qKiBcdTVCODlcdTg4QzVcdTVCOENcdTYyMTBcdTU0MEVcdTc2ODQgZGVza3RvcC1ob3N0IFx1NTE2NVx1NTNFMyhucG0gXHU1RDRDXHU1OTU3XHU0RTBFXHU2M0QwXHU1MzQ3XHU0RTI0XHU3OUNEXHU1RTAzXHU1QzQwXHU5MEZEXHU4QkE0KVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZUluc3RhbGxlZEVudHJ5KHRhcmdldDogc3RyaW5nKTogc3RyaW5nIHtcclxuICBjb25zdCBuZXN0ZWQgPSBqb2luKHRhcmdldCwgJ25vZGVfbW9kdWxlcycsICdAaG1oYXJuZXNzJywgJ2NsaScsICdub2RlX21vZHVsZXMnLCAnQGhtaGFybmVzcycsICd3ZWInLCAnZGlzdCcsICdkZXNrdG9wLWhvc3QuanMnKTtcclxuICBjb25zdCBob2lzdGVkID0gam9pbih0YXJnZXQsICdub2RlX21vZHVsZXMnLCAnQGhtaGFybmVzcycsICd3ZWInLCAnZGlzdCcsICdkZXNrdG9wLWhvc3QuanMnKTtcclxuICBpZiAoZXhpc3RzU3luYyhuZXN0ZWQpKSByZXR1cm4gbmVzdGVkO1xyXG4gIGlmIChleGlzdHNTeW5jKGhvaXN0ZWQpKSByZXR1cm4gaG9pc3RlZDtcclxuICByZXR1cm4gJyc7XHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgSW5zdGFsbGVySG9zdCB7XHJcbiAgc2VuZFByb2dyZXNzKHA6IEluc3RhbGxQcm9ncmVzcyk6IHZvaWQ7XHJcbiAgbG9nKG1zZzogc3RyaW5nKTogdm9pZDtcclxuICAvKiogXHU1Qjg5XHU4OEM1XHU2MjEwXHU1MjlGKFx1NTE2NVx1NTNFM1x1NURGMlx1OUE4Q1x1OEJDMVx1NUI1OFx1NTcyOClcdTIwMTRcdTIwMTQgbWFpbiBcdTU3MjhcdTZCNjRcdTYzMDFcdTRFNDVcdTUzMTZcdTVFNzZcdTkxQ0RcdTU0MkYgaG9zdFx1MzAwMiAqL1xyXG4gIG9uSW5zdGFsbGVkKGVudHJ5OiBzdHJpbmcsIHZpYTogJ25wbScgfCAndGd6Jyk6IHZvaWQ7XHJcbn1cclxuXHJcbmxldCBydW5uaW5nID0gZmFsc2U7XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gaW5zdGFsbFJ1bm5pbmcoKTogYm9vbGVhbiB7XHJcbiAgcmV0dXJuIHJ1bm5pbmc7XHJcbn1cclxuXHJcbi8qKiBcdTU0MkZcdTUyQThcdTVCODlcdTg4QzUoXHU1NDBFXHU1M0YwXHU2MjY3XHU4ODRDO1x1OEZEQlx1NUVBNi9cdTdFRDNcdTY3OUNcdTUxNjhcdTkwRThcdTdFQ0ZcdTRFOEJcdTRFRjZcdTU2REVcdTZENDEsUHJvbWlzZSBcdTUzRUFcdTg4NjhcdThGQkVcIlx1NURGMlx1NTNEN1x1NzQwNlwiKVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gc3RhcnRDbGlJbnN0YWxsKGhvc3Q6IEluc3RhbGxlckhvc3QsIG9wdHM6IEluc3RhbGxPcHRpb25zID0ge30pOiB7IG9rOiBib29sZWFuOyBlcnJvcj86IHN0cmluZyB9IHtcclxuICBpZiAocnVubmluZykgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ1x1NUI4OVx1ODhDNVx1NURGMlx1NTcyOFx1OEZEQlx1ODg0Q1x1NEUyRCcgfTtcclxuICBydW5uaW5nID0gdHJ1ZTtcclxuICBjb25zdCBmaW5pc2ggPSAocDogSW5zdGFsbFByb2dyZXNzKTogdm9pZCA9PiB7XHJcbiAgICBob3N0LnNlbmRQcm9ncmVzcyhwKTtcclxuICAgIHJ1bm5pbmcgPSBmYWxzZTtcclxuICB9O1xyXG4gIGNvbnN0IGZhaWwgPSAodGV4dDogc3RyaW5nLCBlcnI6IHVua25vd24pOiB2b2lkID0+IHtcclxuICAgIGhvc3QubG9nKGBpbnN0YWxsIGZhaWxlZDogJHt0ZXh0fSAke1N0cmluZyhlcnIpLnNsaWNlKDAsIDE4MCl9YCk7XHJcbiAgICBmaW5pc2goeyBwaGFzZTogJ2Vycm9yJywgdGV4dCwgZXJyb3I6IGAke3RleHR9OiR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTYwKX1gIH0pO1xyXG4gIH07XHJcbiAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgY29uc3QgdGFyZ2V0ID0gaW5zdGFsbFRhcmdldCgpO1xyXG4gICAgdHJ5IHtcclxuICAgICAgbWtkaXJTeW5jKHRhcmdldCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XHJcbiAgICAgIGNvbnN0IG5wbU9rID0gb3B0cy5mb3JjZVRneiA9PT0gdHJ1ZSA/IGZhbHNlIDogYXdhaXQgcHJvYmVOcG0oaG9zdCk7XHJcbiAgICAgIGlmIChucG1PaykgYXdhaXQgaW5zdGFsbFZpYU5wbShob3N0LCB0YXJnZXQsIG9wdHMpO1xyXG4gICAgICBlbHNlIGF3YWl0IGluc3RhbGxWaWFUYXJiYWxscyhob3N0LCB0YXJnZXQsIG9wdHMpO1xyXG4gICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgIGZhaWwoJ1x1NUI4OVx1ODhDNVx1NTkzMVx1OEQyNScsIGVycik7XHJcbiAgICB9XHJcbiAgfSkoKTtcclxuICByZXR1cm4geyBvazogdHJ1ZSB9O1xyXG59XHJcblxyXG4vKiAtLS0tIG5wbSBcdTUzRUZcdTc1MjhcdTYwMjcoXHU2Q0U4XHU2MTBGOldpbmRvd3MgXHU0RTBCIHNwYXduKCducG0nKSBcdTUzRUZcdTg4NEMsJ25wbS5jbWQnIFx1NTNDRFx1ODAwQyBFSU5WQUwpIC0tLS0gKi9cclxuYXN5bmMgZnVuY3Rpb24gcHJvYmVOcG0oaG9zdDogSW5zdGFsbGVySG9zdCk6IFByb21pc2U8Ym9vbGVhbj4ge1xyXG4gIGhvc3Quc2VuZFByb2dyZXNzKHsgcGhhc2U6ICdjaGVjaycsIHRleHQ6ICdcdTY4QzBcdTY3RTUgbnBtXHUyMDI2JyB9KTtcclxuICBjb25zdCBvayA9IGF3YWl0IG5ldyBQcm9taXNlPGJvb2xlYW4+KChyZXNvbHZlKSA9PiB7XHJcbiAgICBjb25zdCBjID0gc3Bhd24oJ25wbScsIFsnLS12ZXJzaW9uJ10sIHsgd2luZG93c0hpZGU6IHRydWUsIHN0ZGlvOiAnaWdub3JlJyB9KTtcclxuICAgIGNvbnN0IHQgPSBzZXRUaW1lb3V0KCgpID0+IHsgdHJ5IHsgYy5raWxsKCk7IH0gY2F0Y2ggeyAvKiBub29wICovIH0gcmVzb2x2ZShmYWxzZSk7IH0sIDE1XzAwMCk7XHJcbiAgICBjLm9uKCdlcnJvcicsICgpID0+IHsgY2xlYXJUaW1lb3V0KHQpOyByZXNvbHZlKGZhbHNlKTsgfSk7XHJcbiAgICBjLm9uKCdleGl0JywgKGNvZGUpID0+IHsgY2xlYXJUaW1lb3V0KHQpOyByZXNvbHZlKGNvZGUgPT09IDApOyB9KTtcclxuICB9KTtcclxuICBob3N0LmxvZyhgbnBtICR7b2sgPyAnYXZhaWxhYmxlJyA6ICd1bmF2YWlsYWJsZSd9IFx1MjE5MiAke29rID8gJ25wbSBwcmVmaXgnIDogJ3Rneid9IHBhdGhgKTtcclxuICByZXR1cm4gb2s7XHJcbn1cclxuXHJcbi8qIC0tLS0gXHU4REVGXHU1Rjg0IEE6bnBtIC0tcHJlZml4KFx1NUI4OVx1ODhDNVx1NkI2NVx1OUFBNFx1NjU4N1x1Njg0OCA9IG5wbSBcdThGOTNcdTUxRkFcdTg4NEMpIC0tLS0gKi9cclxuYXN5bmMgZnVuY3Rpb24gaW5zdGFsbFZpYU5wbShob3N0OiBJbnN0YWxsZXJIb3N0LCB0YXJnZXQ6IHN0cmluZywgb3B0czogSW5zdGFsbE9wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcclxuICBob3N0LnNlbmRQcm9ncmVzcyh7IHBoYXNlOiAnbnBtJywgdGV4dDogYG5wbSBpbnN0YWxsIEBobWhhcm5lc3MvY2xpIFx1MjE5MiAke3RhcmdldH0oXHU0RUM1XHU3NTI4XHU2MjM3XHU3NkVFXHU1RjU1KWAgfSk7XHJcbiAgY29uc3QgcmVnaXN0cnkgPSBvcHRzLm1pcnJvckZpcnN0ID09PSAnbnBtbWlycm9yJyA/IFsnLS1yZWdpc3RyeScsIFJFR0lTVFJJRVMubnBtbWlycm9yXSA6IG9wdHMubWlycm9yRmlyc3QgPT09ICducG1qcycgPyBbJy0tcmVnaXN0cnknLCBSRUdJU1RSSUVTLm5wbWpzXSA6IFtdO1xyXG4gIGNvbnN0IGFyZ3MgPSBbJ2luc3RhbGwnLCAnLS1wcmVmaXgnLCB0YXJnZXQsICctLW5vLWF1ZGl0JywgJy0tbm8tZnVuZCcsICctLWxvZ2xldmVsJywgJ25vdGljZScsIC4uLnJlZ2lzdHJ5LCAnQGhtaGFybmVzcy9jbGlAbGF0ZXN0J107XHJcbiAgY29uc3QgY29kZSA9IGF3YWl0IG5ldyBQcm9taXNlPG51bWJlcj4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xyXG4gICAgY29uc3QgYyA9IHNwYXduKCducG0nLCBhcmdzLCB7IHdpbmRvd3NIaWRlOiB0cnVlLCBjd2Q6IGhvbWVkaXIoKSB9KTtcclxuICAgIGxldCBsYXN0ID0gJyc7XHJcbiAgICBjb25zdCBvbkxpbmUgPSAoZDogQnVmZmVyKTogdm9pZCA9PiB7XHJcbiAgICAgIGZvciAoY29uc3QgcmF3IG9mIGQudG9TdHJpbmcoKS5zcGxpdCgvXFxyP1xcbi8pKSB7XHJcbiAgICAgICAgY29uc3QgbGluZSA9IHJhdy5yZXBsYWNlKC9bXFx1MDAwMC1cXHUwMDFmXS9nLCAnJykudHJpbSgpLnNsaWNlKDAsIDE4MCk7XHJcbiAgICAgICAgaWYgKGxpbmUgPT09ICcnIHx8IGxpbmUgPT09IGxhc3QpIGNvbnRpbnVlO1xyXG4gICAgICAgIGxhc3QgPSBsaW5lO1xyXG4gICAgICAgIGhvc3Quc2VuZFByb2dyZXNzKHsgcGhhc2U6ICducG0nLCB0ZXh0OiBsaW5lIH0pO1xyXG4gICAgICB9XHJcbiAgICB9O1xyXG4gICAgYy5zdGRvdXQ/Lm9uKCdkYXRhJywgb25MaW5lKTtcclxuICAgIGMuc3RkZXJyPy5vbignZGF0YScsIG9uTGluZSk7XHJcbiAgICBjLm9uKCdlcnJvcicsIHJlamVjdCk7XHJcbiAgICBjb25zdCBraWxsZXIgPSBzZXRUaW1lb3V0KCgpID0+IHsgdHJ5IHsgYy5raWxsKCk7IH0gY2F0Y2ggeyAvKiBub29wICovIH0gcmVqZWN0KG5ldyBFcnJvcignbnBtIFx1NUI4OVx1ODhDNVx1OEQ4NVx1NjVGNig4IFx1NTIwNlx1OTQ5RiknKSk7IH0sIDggKiA2MF8wMDApO1xyXG4gICAgYy5vbignZXhpdCcsICh4KSA9PiB7IGNsZWFyVGltZW91dChraWxsZXIpOyByZXNvbHZlKHggPz8gMSk7IH0pO1xyXG4gIH0pO1xyXG4gIGlmIChjb2RlICE9PSAwKSB0aHJvdyBuZXcgRXJyb3IoYG5wbSBpbnN0YWxsIFx1OTAwMFx1NTFGQVx1NzgwMSAke2NvZGV9YCk7XHJcbiAgY29uc3QgZW50cnkgPSByZXNvbHZlSW5zdGFsbGVkRW50cnkodGFyZ2V0KTtcclxuICBpZiAoZW50cnkgPT09ICcnKSB0aHJvdyBuZXcgRXJyb3IoJ25wbSBcdTVCODlcdTg4QzVcdTVCOENcdTYyMTBcdTRGNDZcdTY3MkFcdTYyN0VcdTUyMzAgZGVza3RvcC1ob3N0IFx1NTE2NVx1NTNFMycpO1xyXG4gIHdyaXRlU3RhbXAodGFyZ2V0LCAnbnBtJyk7XHJcbiAgZmluaXNoSW5zdGFsbChob3N0LCBlbnRyeSwgJ25wbScpO1xyXG59XHJcblxyXG4vKiAtLS0tIFx1OERFRlx1NUY4NCBCOlx1ODFFQVx1NzgxNCB0Z3ooXHU3NzFGXHU0RTBCXHU4RjdEXHU4RkRCXHU1RUE2ICsgXHU5NTVDXHU1MENGXHU1NkRFXHU5MDAwICsgaW50ZWdyaXR5ICsgdGFyIFx1ODlFM1x1NTM4QikgLS0tLSAqL1xyXG5hc3luYyBmdW5jdGlvbiBpbnN0YWxsVmlhVGFyYmFsbHMoaG9zdDogSW5zdGFsbGVySG9zdCwgdGFyZ2V0OiBzdHJpbmcsIG9wdHM6IEluc3RhbGxPcHRpb25zKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgY29uc3Qgb3JkZXI6IEFycmF5PCducG1qcycgfCAnbnBtbWlycm9yJz4gPSBvcHRzLm1pcnJvckZpcnN0ID09PSAnbnBtbWlycm9yJyA/IFsnbnBtbWlycm9yJywgJ25wbWpzJ10gOiBbJ25wbWpzJywgJ25wbW1pcnJvciddO1xyXG4gIGNvbnN0IG1pcnJvcnMgPSBvcmRlci5tYXAoKGspID0+IFJFR0lTVFJJRVNba10pO1xyXG4gIGhvc3Quc2VuZFByb2dyZXNzKHsgcGhhc2U6ICdtZXRhJywgdGV4dDogJ1x1ODlFM1x1Njc5MFx1NEY5RFx1OEQ1Nlx1NkUwNVx1NTM1NShAaG1oYXJuZXNzL2NsaSBcdTUxNjhcdTVCQjYpXHUyMDI2JyB9KTtcclxuXHJcbiAgY29uc3QgcGFja3VtZW50cyA9IG5ldyBNYXA8c3RyaW5nLCBQYWNrdW1lbnQ+KCk7XHJcbiAgY29uc3QgZ2V0UGFja3VtZW50ID0gYXN5bmMgKG5hbWU6IHN0cmluZyk6IFByb21pc2U8UGFja3VtZW50PiA9PiB7XHJcbiAgICBjb25zdCBoaXQgPSBwYWNrdW1lbnRzLmdldChuYW1lKTtcclxuICAgIGlmIChoaXQgIT09IHVuZGVmaW5lZCkgcmV0dXJuIGhpdDtcclxuICAgIGxldCBsYXN0RXJyID0gJyc7XHJcbiAgICBmb3IgKGNvbnN0IG0gb2YgbWlycm9ycykge1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHIgPSBhd2FpdCBmZXRjaChgJHttfS8ke2VuY29kZVVSSUNvbXBvbmVudChuYW1lKX1gLCB7XHJcbiAgICAgICAgICBoZWFkZXJzOiB7IGFjY2VwdDogJ2FwcGxpY2F0aW9uL3ZuZC5ucG0uaW5zdGFsbC12MStqc29uJyB9LFxyXG4gICAgICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDI1XzAwMCksXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgaWYgKCFyLm9rKSB7IGxhc3RFcnIgPSBgSFRUUCAke3Iuc3RhdHVzfWA7IGNvbnRpbnVlOyB9XHJcbiAgICAgICAgY29uc3QgZG9jID0gKGF3YWl0IHIuanNvbigpKSBhcyBQYWNrdW1lbnQ7XHJcbiAgICAgICAgaWYgKGRvYy52ZXJzaW9ucyA9PT0gdW5kZWZpbmVkKSB7IGxhc3RFcnIgPSAnbWFsZm9ybWVkIHBhY2t1bWVudCc7IGNvbnRpbnVlOyB9XHJcbiAgICAgICAgcGFja3VtZW50cy5zZXQobmFtZSwgZG9jKTtcclxuICAgICAgICByZXR1cm4gZG9jO1xyXG4gICAgICB9IGNhdGNoIChlcnIpIHsgbGFzdEVyciA9IFN0cmluZyhlcnIpLnNsaWNlKDAsIDYwKTsgfVxyXG4gICAgfVxyXG4gICAgdGhyb3cgbmV3IEVycm9yKGBcdTgzQjdcdTUzRDYgJHtuYW1lfSBcdTUxNDNcdTY1NzBcdTYzNkVcdTU5MzFcdThEMjUoXHU1MTY4XHU5MEU4XHU5NTVDXHU1MENGOiR7bGFzdEVycn0pYCk7XHJcbiAgfTtcclxuXHJcbiAgY29uc3QgY2xvc3VyZSA9IGF3YWl0IHJlc29sdmVDbG9zdXJlKHsgbmFtZTogJ0BobWhhcm5lc3MvY2xpJywgc3BlYzogJ2xhdGVzdCcgfSwgZ2V0UGFja3VtZW50KTtcclxuICBjb25zdCByb290ID0gY2xvc3VyZS5maW5kKChwKSA9PiBwLm5hbWUgPT09ICdAaG1oYXJuZXNzL2NsaScpO1xyXG4gIGhvc3QubG9nKGBjbG9zdXJlOiAke2Nsb3N1cmUubGVuZ3RofSBwYWNrYWdlcyAocm9vdCBAaG1oYXJuZXNzL2NsaUAke3Jvb3Q/LnZlcnNpb24gPz8gJz8nfSlgKTtcclxuICBob3N0LnNlbmRQcm9ncmVzcyh7IHBoYXNlOiAnbWV0YScsIHRleHQ6IGBcdTRGOURcdThENTZcdTZFMDVcdTUzNTVcdTVDMzFcdTdFRUE6JHtjbG9zdXJlLmxlbmd0aH0gXHU0RTJBXHU1MzA1KEBobWhhcm5lc3MvY2xpQCR7cm9vdD8udmVyc2lvbiA/PyAnPyd9KWAgfSk7XHJcblxyXG4gIGNvbnN0IHN0YWdpbmcgPSBqb2luKHRhcmdldCwgJy5zdGFnaW5nJyk7XHJcbiAgcm1TeW5jKHN0YWdpbmcsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcclxuICBta2RpclN5bmMoc3RhZ2luZywgeyByZWN1cnNpdmU6IHRydWUgfSk7XHJcblxyXG4gIGZvciAobGV0IGkgPSAwOyBpIDwgY2xvc3VyZS5sZW5ndGg7IGkrKykge1xyXG4gICAgY29uc3QgcGtnID0gY2xvc3VyZVtpXSE7XHJcbiAgICBjb25zdCB1cmxzID0gdGFyYmFsbE1pcnJvcnMocGtnLnRhcmJhbGwsIG1pcnJvcnMpO1xyXG4gICAgbGV0IGJ1ZjogQnVmZmVyIHwgbnVsbCA9IG51bGw7XHJcbiAgICBsZXQgdXNlZE1pcnJvciA9ICcnO1xyXG4gICAgbGV0IGxhc3RFcnIgPSAnJztcclxuICAgIGZvciAoY29uc3QgdSBvZiB1cmxzKSB7XHJcbiAgICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgciA9IGF3YWl0IGZldGNoKHUsIHsgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDMwMF8wMDApIH0pO1xyXG4gICAgICAgIGlmICghci5vaykgeyBsYXN0RXJyID0gYEhUVFAgJHtyLnN0YXR1c31gOyBjb250aW51ZTsgfVxyXG4gICAgICAgIGNvbnN0IHRvdGFsID0gTnVtYmVyKHIuaGVhZGVycy5nZXQoJ2NvbnRlbnQtbGVuZ3RoJykgPz8gJzAnKTtcclxuICAgICAgICBjb25zdCByZWFkZXIgPSByLmJvZHk/LmdldFJlYWRlcigpO1xyXG4gICAgICAgIGlmIChyZWFkZXIgPT09IHVuZGVmaW5lZCkgdGhyb3cgbmV3IEVycm9yKCdubyBib2R5Jyk7XHJcbiAgICAgICAgY29uc3QgY2h1bmtzOiBCdWZmZXJbXSA9IFtdO1xyXG4gICAgICAgIGxldCBnb3QgPSAwO1xyXG4gICAgICAgIGxldCBsYXN0RW1pdCA9IDA7XHJcbiAgICAgICAgZm9yICg7Oykge1xyXG4gICAgICAgICAgY29uc3QgeyBkb25lLCB2YWx1ZSB9ID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcclxuICAgICAgICAgIGlmIChkb25lID09PSB0cnVlKSBicmVhaztcclxuICAgICAgICAgIGNvbnN0IGIgPSBCdWZmZXIuZnJvbSh2YWx1ZSk7XHJcbiAgICAgICAgICBjaHVua3MucHVzaChiKTtcclxuICAgICAgICAgIGdvdCArPSBiLmxlbmd0aDtcclxuICAgICAgICAgIGlmIChnb3QgLSBsYXN0RW1pdCA+IDI1NiAqIDEwMjQpIHtcclxuICAgICAgICAgICAgbGFzdEVtaXQgPSBnb3Q7XHJcbiAgICAgICAgICAgIGhvc3Quc2VuZFByb2dyZXNzKHtcclxuICAgICAgICAgICAgICBwaGFzZTogJ2Rvd25sb2FkJyxcclxuICAgICAgICAgICAgICBwY3Q6IE1hdGgucm91bmQoKChpICsgTWF0aC5taW4oZ290IC8gKHRvdGFsIHx8IGdvdCksIDEpKSAvIGNsb3N1cmUubGVuZ3RoKSAqIDEwMCksXHJcbiAgICAgICAgICAgICAgdGV4dDogYFx1NEUwQlx1OEY3RCAke3BrZy5uYW1lfUAke3BrZy52ZXJzaW9ufSgke2kgKyAxfS8ke2Nsb3N1cmUubGVuZ3RofSlcdTAwQjcgJHtieXRlc0xhYmVsKGdvdCl9JHt0b3RhbCA+IDAgPyBgIC8gJHtieXRlc0xhYmVsKHRvdGFsKX1gIDogJyd9YCxcclxuICAgICAgICAgICAgICBtaXJyb3I6IG5ldyBVUkwodSkuaG9zdCxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGJ1ZiA9IEJ1ZmZlci5jb25jYXQoY2h1bmtzKTtcclxuICAgICAgICBpZiAoIWludGVncml0eU9rKGJ1ZiwgcGtnLmludGVncml0eSkpIHsgbGFzdEVyciA9ICdpbnRlZ3JpdHkgXHU0RTBEXHU1MzM5XHU5MTREJzsgYnVmID0gbnVsbDsgY29udGludWU7IH1cclxuICAgICAgICB1c2VkTWlycm9yID0gbmV3IFVSTCh1KS5ob3N0O1xyXG4gICAgICAgIGJyZWFrO1xyXG4gICAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgICBsYXN0RXJyID0gU3RyaW5nKGVycikuc2xpY2UoMCwgNjApO1xyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgICBpZiAoYnVmID09PSBudWxsKSB0aHJvdyBuZXcgRXJyb3IoYFx1NEUwQlx1OEY3RCAke3BrZy5uYW1lfSBcdTU5MzFcdThEMjUoXHU1MTY4XHU5MEU4XHU5NTVDXHU1MENGOiR7bGFzdEVycn0pYCk7XHJcbiAgICBjb25zdCB0Z3ogPSBqb2luKHN0YWdpbmcsIGAke2l9LnRnemApO1xyXG4gICAgd3JpdGVGaWxlU3luYyh0Z3osIGJ1Zik7XHJcbiAgICBob3N0LnNlbmRQcm9ncmVzcyh7XHJcbiAgICAgIHBoYXNlOiAnZG93bmxvYWQnLFxyXG4gICAgICBwY3Q6IE1hdGgucm91bmQoKChpICsgMSkgLyBjbG9zdXJlLmxlbmd0aCkgKiAxMDApLFxyXG4gICAgICB0ZXh0OiBgXHU0RTBCXHU4RjdEICR7cGtnLm5hbWV9QCR7cGtnLnZlcnNpb259IFx1NUI4Q1x1NjIxMCgke2J5dGVzTGFiZWwoYnVmLmxlbmd0aCl9LHZpYSAke3VzZWRNaXJyb3J9KWAsXHJcbiAgICAgIG1pcnJvcjogdXNlZE1pcnJvcixcclxuICAgIH0pO1xyXG4gIH1cclxuXHJcbiAgaG9zdC5zZW5kUHJvZ3Jlc3MoeyBwaGFzZTogJ2V4dHJhY3QnLCB0ZXh0OiAnXHU4OUUzXHU1MzhCXHU1RTc2XHU1RTAzXHU1QzQwIG5vZGVfbW9kdWxlc1x1MjAyNicgfSk7XHJcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBjbG9zdXJlLmxlbmd0aDsgaSsrKSB7XHJcbiAgICBjb25zdCBwa2cgPSBjbG9zdXJlW2ldITtcclxuICAgIGF3YWl0IGV4dHJhY3RUZ3ooam9pbihzdGFnaW5nLCBgJHtpfS50Z3pgKSwgc3RhZ2luZywgcGtnKTtcclxuICAgIGhvc3Quc2VuZFByb2dyZXNzKHsgcGhhc2U6ICdleHRyYWN0JywgcGN0OiBNYXRoLnJvdW5kKCgoaSArIDEpIC8gY2xvc3VyZS5sZW5ndGgpICogMTAwKSwgdGV4dDogYFx1ODlFM1x1NTM4QiAke3BrZy5uYW1lfSgke2kgKyAxfS8ke2Nsb3N1cmUubGVuZ3RofSlgIH0pO1xyXG4gIH1cclxuICBybVN5bmMoc3RhZ2luZywgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xyXG5cclxuICBjb25zdCBlbnRyeSA9IHJlc29sdmVJbnN0YWxsZWRFbnRyeSh0YXJnZXQpO1xyXG4gIGlmIChlbnRyeSA9PT0gJycpIHRocm93IG5ldyBFcnJvcigndGd6IFx1NUI4OVx1ODhDNVx1NUI4Q1x1NjIxMFx1NEY0Nlx1NjcyQVx1NjI3RVx1NTIzMCBkZXNrdG9wLWhvc3QgXHU1MTY1XHU1M0UzJyk7XHJcbiAgd3JpdGVTdGFtcCh0YXJnZXQsICd0Z3onKTtcclxuICBmaW5pc2hJbnN0YWxsKGhvc3QsIGVudHJ5LCAndGd6Jyk7XHJcbn1cclxuXHJcbi8qKiB0YXIuZXhlKFdpbjEwKyBcdTgxRUFcdTVFMjYpXHU4OUUzXHU1MzhCIHRneiBcdTUyMzAgZXhEaXIsXHU1MThEXHU2MjhBIHBhY2thZ2UvIFx1NjMyQVx1NTIzMCBub2RlX21vZHVsZXMgXHU1RTAzXHU1QzQwXHUzMDAyICovXHJcbmFzeW5jIGZ1bmN0aW9uIGV4dHJhY3RUZ3oodGd6OiBzdHJpbmcsIHN0YWdpbmc6IHN0cmluZywgcGtnOiBSZXNvbHZlZFBrZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gIGNvbnN0IGV4RGlyID0gam9pbihzdGFnaW5nLCBgeC0ke3BrZy5uYW1lLnJlcGxhY2UoL1teXFx3Li1dL2csICdfJyl9YCk7XHJcbiAgcm1TeW5jKGV4RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XHJcbiAgbWtkaXJTeW5jKGV4RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcclxuICBjb25zdCBjb2RlID0gYXdhaXQgbmV3IFByb21pc2U8bnVtYmVyPigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XHJcbiAgICBjb25zdCBjID0gc3Bhd24oJ3RhcicsIFsnLXh6ZicsIHRneiwgJy1DJywgZXhEaXJdLCB7IHdpbmRvd3NIaWRlOiB0cnVlLCBzdGRpbzogJ2lnbm9yZScgfSk7XHJcbiAgICBjLm9uKCdlcnJvcicsIHJlamVjdCk7XHJcbiAgICBjLm9uKCdleGl0JywgKHgpID0+IHJlc29sdmUoeCA/PyAxKSk7XHJcbiAgfSk7XHJcbiAgaWYgKGNvZGUgIT09IDApIHRocm93IG5ldyBFcnJvcihgdGFyIFx1ODlFM1x1NTM4QiAke3BrZy5uYW1lfSBcdTU5MzFcdThEMjUoXHU5MDAwXHU1MUZBXHU3ODAxICR7Y29kZX0pYCk7XHJcbiAgY29uc3QgZGVzdCA9IG1vZHVsZURpcihpbnN0YWxsVGFyZ2V0KCksIHBrZy5uYW1lKTtcclxuICBjb25zdCBwYXJlbnQgPSBkZXN0LnNsaWNlKDAsIGRlc3QubGFzdEluZGV4T2YoJ1xcXFwnKSk7XHJcbiAgbWtkaXJTeW5jKHBhcmVudCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XHJcbiAgcm1TeW5jKGRlc3QsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcclxuICByZW5hbWVTeW5jKGpvaW4oZXhEaXIsICdwYWNrYWdlJyksIGRlc3QpO1xyXG4gIHJtU3luYyhleERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xyXG59XHJcblxyXG4vKiogXHU1Qjg5XHU4OEM1XHU2MjMzKFx1NTQxMVx1NUJGQ1x1NUI4Q1x1NjIxMFx1OTg3NS9cdThCQkVcdTdGNkVcdTk3NjJcdTY3N0ZcdTVDNTVcdTc5M0FcdTVCODlcdTg4QzVcdTY1QjlcdTVGMEZcdTRFMEVcdTY1RjZcdTk1RjQ7XHU0RTBEXHU2MjdGXHU4RjdEXHU4RkQwXHU4ODRDXHU2NUY2XHU5MDNCXHU4RjkxKVx1MzAwMiAqL1xyXG5mdW5jdGlvbiB3cml0ZVN0YW1wKHRhcmdldDogc3RyaW5nLCB2aWE6ICducG0nIHwgJ3RneicpOiB2b2lkIHtcclxuICB0cnkge1xyXG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHRhcmdldCwgJ2luc3RhbGxlZC1ieS1obWgtZGVza3RvcC5qc29uJyksIEpTT04uc3RyaW5naWZ5KHsgdmlhLCBhdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpIH0sIG51bGwsIDIpLCAndXRmOCcpO1xyXG4gIH0gY2F0Y2ggeyAvKiBiZXN0IGVmZm9ydCAqLyB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZpbmlzaEluc3RhbGwoaG9zdDogSW5zdGFsbGVySG9zdCwgZW50cnk6IHN0cmluZywgdmlhOiAnbnBtJyB8ICd0Z3onKTogdm9pZCB7XHJcbiAgaG9zdC5sb2coYGluc3RhbGwgZG9uZSB2aWEgJHt2aWF9OiAke2VudHJ5fWApO1xyXG4gIGhvc3Quc2VuZFByb2dyZXNzKHsgcGhhc2U6ICdkb25lJywgdGV4dDogYFx1NUI4OVx1ODhDNVx1NUI4Q1x1NjIxMCgke3ZpYX0pYCwgZW50cnkgfSk7XHJcbiAgaG9zdC5vbkluc3RhbGxlZChlbnRyeSwgdmlhKTtcclxuICBydW5uaW5nID0gZmFsc2U7XHJcbn1cclxuIiwgIi8qKlxyXG4gKiBAaG1oYXJuZXNzL2NsaSBcdTVCODlcdTg4QzVcdTY4MzhcdTVGQzMoXHU3RUFGXHU5MDNCXHU4RjkxLFx1OTZGNiBJTyBcdTIwMTRcdTIwMTQgZmV0Y2gvXHU4OUUzXHU1MzhCL1x1ODQzRFx1NzZEOFx1NTcyOFx1NEUzQlx1OEZEQlx1N0EwQiBpbnN0YWxsZXIgXHU5MUNDKVx1MzAwMlxyXG4gKlxyXG4gKiBcdTgwNENcdThEMjModjUuMSBcdTVCODlcdTg4QzVcdTU0MTFcdTVCRkMpOlx1N0VEOVx1NUI5QSByZWdpc3RyeSBcdTUxNDNcdTY1NzBcdTYzNkVcdTgzQjdcdTUzRDZcdTUxRkRcdTY1NzAsXHU4OUUzXHU2NzkwIEBobWhhcm5lc3MvY2xpIFx1NzY4NFxyXG4gKiBcdTVCOENcdTY1NzRcdTRGOURcdThENTZcdTk1RURcdTUzMDUoQGhtaGFybmVzcy8qIFx1NTE2OFx1NUJCNlx1NEUzQVx1N0NCRVx1Nzg2RVx1NzI0OFx1NjcyQ1x1NEU5Mlx1OTQ4OTtcdTU5MTZcdTkwRThcdTRGOURcdThENTYgcXJjb2RlIFx1OTRGRVx1NEUzQSBeIFx1ODMwM1x1NTZGNCksXHJcbiAqIFx1NEVBN1x1NTFGQVwiXHU4OEM1XHU0RUMwXHU0RTQ4XHUzMDAxXHU0RUNFXHU1NEVBXHU0RTlCXHU5NTVDXHU1MENGXHU0RTBCXHUzMDAxXHU4OEM1XHU1MjMwXHU1NEVBXCJcdTc2ODRcdTc4NkVcdTVCOUFcdTYwMjdcdThCQTFcdTUyMTJcdTMwMDJcdThCQkVcdThCQTFcdTdFQTZcdTY3NUY6XHJcbiAqICAtIFx1OTVFRFx1NTMwNVx1NjMwOVx1NTMwNVx1NTQwRFx1NTNCQlx1OTFDRChcdTk0QkJcdTc3RjNcdTRGOURcdThENTZcdTUzRUFcdTg4QzVcdTRFMDBcdTRFRkQsbnBtIFx1OEJFRFx1NEU0OSk7XHJcbiAqICAtIFx1ODMwM1x1NTZGNFx1ODlFM1x1Njc5MFx1NTNFQVx1NjUyRlx1NjMwMSBucG0gXHU3NTFGXHU2MDAxXHU1QjlFXHU5NjQ1XHU3NTI4XHU1MjMwXHU3Njg0XHU1RjYyXHU2MDAxOlx1N0NCRVx1Nzg2RSAvIGxhdGVzdCAvICogLyBeIC8gfiAvID49LFxyXG4gKiAgICBcdTRFMERcdTVGMTUgc2VtdmVyIFx1NUU5MyhcdTk2RjZcdTRGOURcdThENTZcdTUzOUZcdTUyMTksXHU0RTBFXHU4MUVBXHU3ODE0XHU2NkY0XHU2NUIwXHU1NjY4XHU0RTAwXHU4MUY0KTtcclxuICogIC0gb3B0aW9uYWxEZXBlbmRlbmNpZXMgXHU0RTBEXHU4OEM1Olx1OTVFRFx1NTMwNVx1NTE4NVx1NUI5RVx1OTY0NVx1NThGMFx1NjYwRVx1NzY4NCBvcHRpb25hbCBcdTU3NDdcdTRFM0FcdTVFNzNcdTUzRjBcdTcyNzlcdTVCOUFcclxuICogICAgKGZzZXZlbnRzIFx1N0I0OSksdGd6IFx1OERFRlx1NUY4NFx1NEUwRFx1OEREMVx1NzUxRlx1NTQ3RFx1NTQ2OFx1NjcxRlx1ODExQVx1NjcyQyxcdTg4QzVcdTRFODZcdTRFNUZcdTUzRUFcdTY2MkZcdTZCN0JcdTkxQ0RcdTMwMDJcclxuICovXHJcbmltcG9ydCB7IGNyZWF0ZUhhc2ggfSBmcm9tICdub2RlOmNyeXB0byc7XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIFBrZ1ZlcnNpb25NZXRhIHtcclxuICB2ZXJzaW9uOiBzdHJpbmc7XHJcbiAgZGVwZW5kZW5jaWVzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xyXG4gIHRhcmJhbGw6IHN0cmluZztcclxuICBpbnRlZ3JpdHk/OiBzdHJpbmcgfCB1bmRlZmluZWQ7XHJcbn1cclxuXHJcbi8qKiByZWdpc3RyeSBwYWNrdW1lbnQgXHU3Njg0XHU2NzAwXHU1QzBGXHU4QkZCXHU1M0Q2XHU5NzYyKGRpc3QtdGFncyArIFx1NTE2OFx1NzI0OFx1NjcyQ1x1NEY5RFx1OEQ1Ni90YXJiYWxsIFx1NTE0M1x1NjU3MFx1NjM2RSlcdTMwMDIgKi9cclxuZXhwb3J0IGludGVyZmFjZSBQYWNrdW1lbnQge1xyXG4gICdkaXN0LXRhZ3MnOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xyXG4gIHZlcnNpb25zOiBSZWNvcmQ8c3RyaW5nLCB7IGRlcGVuZGVuY2llcz86IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gfCB1bmRlZmluZWQ7IGRpc3Q/OiB7IHRhcmJhbGw/OiBzdHJpbmc7IGludGVncml0eT86IHN0cmluZyB8IHVuZGVmaW5lZCB9IHwgdW5kZWZpbmVkIH0+O1xyXG59XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIFJlc29sdmVkUGtnIHtcclxuICBuYW1lOiBzdHJpbmc7XHJcbiAgdmVyc2lvbjogc3RyaW5nO1xyXG4gIC8qKiByZWdpc3RyeSBcdTUzOUZcdTU5Q0JcdTU3MzBcdTU3NDAoXHU5NTVDXHU1MENGXHU1MjE3XHU4ODY4XHU3NTMxIHRhcmJhbGxNaXJyb3JzIFx1NkQzRVx1NzUxRilcdTMwMDIgKi9cclxuICB0YXJiYWxsOiBzdHJpbmc7XHJcbiAgaW50ZWdyaXR5Pzogc3RyaW5nIHwgdW5kZWZpbmVkO1xyXG59XHJcblxyXG4vKiAtLS0tIHNlbXZlcihcdTY3MDBcdTVDMEZcdTVCOUVcdTczQjA6XHU5NUVEXHU1MzA1XHU1MTg1XHU1QjlFXHU5NjQ1XHU1MUZBXHU3M0IwXHU3Njg0XHU1RjYyXHU2MDAxKSAtLS0tICovXHJcblxyXG5leHBvcnQgZnVuY3Rpb24gY21wU2VtdmVyKGE6IHN0cmluZywgYjogc3RyaW5nKTogbnVtYmVyIHtcclxuICBjb25zdCBwYSA9IGEucmVwbGFjZSgvXnYvLCAnJykuc3BsaXQoJy0nKVswXSEuc3BsaXQoJy4nKS5tYXAoTnVtYmVyKTtcclxuICBjb25zdCBwYiA9IGIucmVwbGFjZSgvXnYvLCAnJykuc3BsaXQoJy0nKVswXSEuc3BsaXQoJy4nKS5tYXAoTnVtYmVyKTtcclxuICBmb3IgKGxldCBpID0gMDsgaSA8IDM7IGkrKykge1xyXG4gICAgY29uc3QgeCA9IHBhW2ldID8/IDA7XHJcbiAgICBjb25zdCB5ID0gcGJbaV0gPz8gMDtcclxuICAgIGlmICh4ICE9PSB5KSByZXR1cm4geCA8IHkgPyAtMSA6IDE7XHJcbiAgfVxyXG4gIHJldHVybiAwO1xyXG59XHJcblxyXG4vKiogcmFuZ2UgXHU2NjJGXHU1NDI2XHU2M0E1XHU1M0Q3IHZlcnNpb24oXHU2NTJGXHU2MzAxIFx1N0NCRVx1Nzg2RSAvIGxhdGVzdCAvICogLyB4IC8gXiAvIH4gLyA+PTtcdTRFMERcdThCQzZcdTUyMkJcdTUyMTkgZmFsc2UpXHUzMDAyICovXHJcbmV4cG9ydCBmdW5jdGlvbiBzYXRpc2ZpZXMocmFuZ2U6IHN0cmluZywgdmVyc2lvbjogc3RyaW5nKTogYm9vbGVhbiB7XHJcbiAgY29uc3QgciA9IHJhbmdlLnRyaW0oKTtcclxuICBpZiAociA9PT0gJycgfHwgciA9PT0gJyonIHx8IHIgPT09ICdsYXRlc3QnIHx8IHIgPT09ICd4JykgcmV0dXJuIHRydWU7XHJcbiAgaWYgKHIgPT09IHZlcnNpb24pIHJldHVybiB0cnVlO1xyXG4gIGNvbnN0IGJvdW5kID0gL14oXFxefH58Pj0/KVxccyooXFxkKylcXC4oXFxkKylcXC4oXFxkKykvLmV4ZWMocik7XHJcbiAgaWYgKGJvdW5kICE9PSBudWxsKSB7XHJcbiAgICBjb25zdCBvcCA9IGJvdW5kWzFdITtcclxuICAgIGNvbnN0IG1ham9yID0gTnVtYmVyKGJvdW5kWzJdKTtcclxuICAgIGNvbnN0IG1pbm9yID0gTnVtYmVyKGJvdW5kWzNdKTtcclxuICAgIGNvbnN0IHBhdGNoID0gTnVtYmVyKGJvdW5kWzRdKTtcclxuICAgIGNvbnN0IGMgPSBjbXBTZW12ZXIodmVyc2lvbiwgYCR7bWFqb3J9LiR7bWlub3J9LiR7cGF0Y2h9YCk7XHJcbiAgICBpZiAoYyA8IDApIHJldHVybiBmYWxzZTtcclxuICAgIGlmIChvcCA9PT0gJz49JykgcmV0dXJuIHRydWU7IC8vICc+PScgXHU0RTBCXHU3NTRDXHU1MzczXHU1M0VGOlx1OTVFRFx1NTMwNVx1NTE4NVx1NTNFQVx1NEVFNSAnPj14LnkueiA8eicgXHU1OTBEXHU1NDA4XHU1RjYyXHU2MDAxXHU1MUZBXHU3M0IwLFx1NEZERFx1NUI4OFx1NTNENlx1NEUwQlx1NzU0Q1xyXG4gICAgaWYgKG9wID09PSAnficpIHJldHVybiBjbXBTZW12ZXIodmVyc2lvbiwgYCR7bWFqb3J9LiR7bWlub3IgKyAxfS4wYCkgPCAwO1xyXG4gICAgLy8gJ14nOjAueCBcdTcyNzlcdTUyMjQoMC4yLjMgXHU1MTQxXHU4QkI4IDAuMi56KSxcdTUxNzZcdTRGNTlcdTk1MDFcdTRFM0JcdTcyNDhcdTY3MkNcclxuICAgIGlmIChtYWpvciA9PT0gMCkgcmV0dXJuIG1pbm9yID09PSAwID8gY21wU2VtdmVyKHZlcnNpb24sIGAwLjAuJHtwYXRjaCArIDF9YCkgPCAwIDogY21wU2VtdmVyKHZlcnNpb24sIGAwLiR7bWlub3IgKyAxfS4wYCkgPCAwO1xyXG4gICAgcmV0dXJuIGNtcFNlbXZlcih2ZXJzaW9uLCBgJHttYWpvciArIDF9LjAuMGApIDwgMDtcclxuICB9XHJcbiAgcmV0dXJuIGZhbHNlO1xyXG59XHJcblxyXG4vKiogXHU0RUNFIHBhY2t1bWVudCBcdTkwMDlcdTUxRkEgc3BlYyhcdTdDQkVcdTc4NkUvbGF0ZXN0L14vfi8qKVx1NjMwN1x1NTQxMVx1NzY4NFx1NzI0OFx1NjcyQztcdTY1RTBcdTUzMzlcdTkxNERcdThGRDRcdTU2REUgJydcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHBpY2tWZXJzaW9uKGRvYzogUGFja3VtZW50LCBzcGVjOiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gIGNvbnN0IHMgPSBzcGVjLnRyaW0oKTtcclxuICBjb25zdCB0YWcgPSBzID09PSAnJyB8fCBzID09PSAnbGF0ZXN0JyB8fCBzID09PSAnKicgPyBkb2NbJ2Rpc3QtdGFncyddPy5sYXRlc3QgOiB1bmRlZmluZWQ7XHJcbiAgaWYgKHRhZyAhPT0gdW5kZWZpbmVkICYmIGRvYy52ZXJzaW9uc1t0YWddICE9PSB1bmRlZmluZWQpIHJldHVybiB0YWc7XHJcbiAgaWYgKGRvYy52ZXJzaW9uc1tzXSAhPT0gdW5kZWZpbmVkKSByZXR1cm4gcztcclxuICBsZXQgYmVzdCA9ICcnO1xyXG4gIGZvciAoY29uc3QgdiBvZiBPYmplY3Qua2V5cyhkb2MudmVyc2lvbnMpKSB7XHJcbiAgICBpZiAoc2F0aXNmaWVzKHMsIHYpICYmIGNtcFNlbXZlcih2LCBiZXN0KSA+IDApIGJlc3QgPSB2O1xyXG4gIH1cclxuICByZXR1cm4gYmVzdDtcclxufVxyXG5cclxuLyogLS0tLSBcdTRGOURcdThENTZcdTk1RURcdTUzMDUgLS0tLSAqL1xyXG5cclxuLyoqXHJcbiAqIFx1ODlFM1x1Njc5MCByb290IFx1NTNDQVx1NTE3Nlx1NTE2OFx1OTBFOFx1NEYyMFx1OTAxMlx1NEY5RFx1OEQ1NihCRlMsXHU2MzA5XHU1MzA1XHU1NDBEXHU1M0JCXHU5MUNEXHU1M0Q2XHU5OTk2XHU0RTJBXHU4OUUzXHU2NzkwXHU3RUQzXHU2NzlDIFx1MjAxNFx1MjAxNCBcdTRFMEUgbnBtIFx1NjI0MVx1NUU3M1xyXG4gKiBcdTVFMDNcdTVDNDBcdTRFMDBcdTgxRjQpXHUzMDAyZ2V0UGFja3VtZW50IFx1NzUzMVx1OEMwM1x1NzUyOFx1NjVCOVx1NkNFOFx1NTE2NShmZXRjaCBcdTdGNTFcdTdFREMgLyBcdTZENEJcdThCRDVcdTZDRThcdTUxNjVcdTVCNTdcdTUxNzgpXHUzMDAyXHJcbiAqIFx1NEVGQlx1NEUwMFx1NEY5RFx1OEQ1Nlx1NjVFMFx1NkVFMVx1OERCM1x1NzI0OFx1NjcyQ1x1NjVGNlx1NjI5Qlx1OTUxOShcdTVFMjZcdTUzMDVcdTU0MERcdTRFMEUgcmFuZ2UsXHU5NzYyXHU1NDExXHU1Qjg5XHU4OEM1XHU5ODc1XHU5NTE5XHU4QkVGXHU2NTg3XHU2ODQ4KVx1MzAwMlxyXG4gKi9cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlc29sdmVDbG9zdXJlKFxyXG4gIHJvb3Q6IHsgbmFtZTogc3RyaW5nOyBzcGVjOiBzdHJpbmcgfSxcclxuICBnZXRQYWNrdW1lbnQ6IChuYW1lOiBzdHJpbmcpID0+IFByb21pc2U8UGFja3VtZW50PixcclxuKTogUHJvbWlzZTxSZXNvbHZlZFBrZ1tdPiB7XHJcbiAgY29uc3QgcmVzb2x2ZWQgPSBuZXcgTWFwPHN0cmluZywgUGtnVmVyc2lvbk1ldGE+KCk7XHJcbiAgY29uc3QgcXVldWU6IEFycmF5PHsgbmFtZTogc3RyaW5nOyBzcGVjOiBzdHJpbmcgfT4gPSBbcm9vdF07XHJcbiAgd2hpbGUgKHF1ZXVlLmxlbmd0aCA+IDApIHtcclxuICAgIGNvbnN0IHsgbmFtZSwgc3BlYyB9ID0gcXVldWUuc2hpZnQoKSE7XHJcbiAgICBpZiAocmVzb2x2ZWQuaGFzKG5hbWUpKSBjb250aW51ZTsgLy8gXHU1REYyXHU1QjlBXHU3MjQ4Olx1NTQwRVx1N0VFRCByYW5nZSBcdTVGMTVcdTc1MjhcdTRFMERcdTUxOERcdTkxQ0RcdTg5RTMobnBtIFx1NjI0MVx1NUU3M1x1OEJFRFx1NEU0OSlcclxuICAgIGNvbnN0IGRvYyA9IGF3YWl0IGdldFBhY2t1bWVudChuYW1lKTtcclxuICAgIGNvbnN0IHZlcnNpb24gPSBwaWNrVmVyc2lvbihkb2MsIHNwZWMpO1xyXG4gICAgY29uc3QgbWV0YSA9IHZlcnNpb24gIT09ICcnID8gZG9jLnZlcnNpb25zW3ZlcnNpb25dIDogdW5kZWZpbmVkO1xyXG4gICAgaWYgKG1ldGEgPT09IHVuZGVmaW5lZCB8fCBtZXRhLmRpc3Q/LnRhcmJhbGwgPT09IHVuZGVmaW5lZCkge1xyXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYG5vIHZlcnNpb24gb2YgJHtuYW1lfSBzYXRpc2ZpZXMgJHtzcGVjIHx8ICdsYXRlc3QnfWApO1xyXG4gICAgfVxyXG4gICAgY29uc3QgaXRlbTogUGtnVmVyc2lvbk1ldGEgPSB7XHJcbiAgICAgIHZlcnNpb24sXHJcbiAgICAgIGRlcGVuZGVuY2llczogbWV0YS5kZXBlbmRlbmNpZXMgPz8ge30sXHJcbiAgICAgIHRhcmJhbGw6IG1ldGEuZGlzdC50YXJiYWxsLFxyXG4gICAgICBpbnRlZ3JpdHk6IG1ldGEuZGlzdC5pbnRlZ3JpdHksXHJcbiAgICB9O1xyXG4gICAgcmVzb2x2ZWQuc2V0KG5hbWUsIGl0ZW0pO1xyXG4gICAgZm9yIChjb25zdCBbZGVwLCByYW5nZV0gb2YgT2JqZWN0LmVudHJpZXMoaXRlbS5kZXBlbmRlbmNpZXMpKSB7XHJcbiAgICAgIGlmICghcmVzb2x2ZWQuaGFzKGRlcCkpIHF1ZXVlLnB1c2goeyBuYW1lOiBkZXAsIHNwZWM6IHJhbmdlIH0pO1xyXG4gICAgfVxyXG4gIH1cclxuICByZXR1cm4gWy4uLnJlc29sdmVkLmVudHJpZXMoKV0ubWFwKChbbmFtZSwgbV0pID0+ICh7IG5hbWUsIHZlcnNpb246IG0udmVyc2lvbiwgdGFyYmFsbDogbS50YXJiYWxsLCBpbnRlZ3JpdHk6IG0uaW50ZWdyaXR5IH0pKTtcclxufVxyXG5cclxuLyogLS0tLSBcdTk1NUNcdTUwQ0ZcdTRFMEVcdTVFMDNcdTVDNDAgLS0tLSAqL1xyXG5cclxuY29uc3QgUkVHSVNUUllfSE9TVFMgPSAvXihodHRwcz86XFwvXFwvW14vXSspXFwvKC4qKSQvO1xyXG5cclxuLyoqXHJcbiAqIHRhcmJhbGwgXHU3Njg0XHU5NTVDXHU1MENGXHU1MDE5XHU5MDA5KFx1OTg3QVx1NUU4Rlx1NTM3M1x1NTZERVx1OTAwMFx1OTg3QVx1NUU4Rik6XHU1MzlGXHU1OUNCXHU1NzMwXHU1NzQwIFx1MjE5MiBcdTU0MDQgcmVnaXN0cnkgXHU1NDBDXHU4REVGXHU1Rjg0XHU2NTM5XHU1MTk5XHUzMDAyXHJcbiAqIHBhY2t1bWVudCBcdTkxQ0NcdTc2ODQgZGlzdC50YXJiYWxsIFx1NjA1Mlx1NjMwN1x1NTQxMVx1NTNEMVx1NUUwM1x1NkU5MChyZWdpc3RyeS5ucG1qcy5vcmcpLFx1NTZGRFx1NTE4NVx1N0Y1MVx1N0VEQ1xyXG4gKiBcdTRFMERcdTUzRUZcdThGQkVcdTY1RjZcdTYzMDkgcmVnaXN0cnkgXHU1MjE3XHU4ODY4XHU2NTM5XHU1MTk5IGhvc3QoXHU4REVGXHU1Rjg0XHU0RTBEXHU1M0Q4IFx1MjAxNFx1MjAxNCBucG1taXJyb3IgXHU0RTBFIG5wbWpzIFx1NTQwQ1x1Njc4NClcdTMwMDJcclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiB0YXJiYWxsTWlycm9ycyh0YXJiYWxsOiBzdHJpbmcsIHJlZ2lzdHJpZXM6IHN0cmluZ1tdKTogc3RyaW5nW10ge1xyXG4gIGNvbnN0IG0gPSBSRUdJU1RSWV9IT1NUUy5leGVjKHRhcmJhbGwpO1xyXG4gIGNvbnN0IHBhdGggPSBtPy5bMl0gPz8gJyc7XHJcbiAgY29uc3Qgb3V0ID0gW3RhcmJhbGxdO1xyXG4gIGZvciAoY29uc3QgcmVnIG9mIHJlZ2lzdHJpZXMpIHtcclxuICAgIGNvbnN0IGJhc2UgPSByZWcucmVwbGFjZSgvXFwvKyQvLCAnJyk7XHJcbiAgICBpZiAoYmFzZSA9PT0gbT8uWzFdKSBjb250aW51ZTtcclxuICAgIGNvbnN0IHUgPSBgJHtiYXNlfS8ke3BhdGh9YDtcclxuICAgIGlmICghb3V0LmluY2x1ZGVzKHUpKSBvdXQucHVzaCh1KTtcclxuICB9XHJcbiAgcmV0dXJuIG91dDtcclxufVxyXG5cclxuLyoqIFx1NTMwNVx1NTcyOCBub2RlX21vZHVsZXMgXHU0RTBCXHU3Njg0XHU3NkVFXHU2ODA3XHU3NkVFXHU1RjU1KHNjb3BlZCBcdTUzMDVcdTRGRERcdTYzMDEgQHNjb3BlL25hbWUgXHU0RTI0XHU3RUE3KVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gbW9kdWxlRGlyKHByZWZpeDogc3RyaW5nLCBuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gIGNvbnN0IHBhcnRzID0gbmFtZS5zcGxpdCgnLycpLmZpbHRlcigocCkgPT4gcCAhPT0gJycgJiYgcCAhPT0gJy4nKTtcclxuICBpZiAobmFtZS5zdGFydHNXaXRoKCdAJykgJiYgcGFydHMubGVuZ3RoICE9PSAyKSB0aHJvdyBuZXcgRXJyb3IoYGludmFsaWQgcGFja2FnZSBuYW1lOiAke25hbWV9YCk7XHJcbiAgaWYgKCFuYW1lLnN0YXJ0c1dpdGgoJ0AnKSAmJiBwYXJ0cy5sZW5ndGggIT09IDEpIHRocm93IG5ldyBFcnJvcihgaW52YWxpZCBwYWNrYWdlIG5hbWU6ICR7bmFtZX1gKTtcclxuICByZXR1cm4gWy4uLnBhcnRzXS5yZWR1Y2UoKGRpciwgcCkgPT4gYCR7ZGlyfVxcXFwke3B9YCwgYCR7cHJlZml4fVxcXFxub2RlX21vZHVsZXNgKTtcclxufVxyXG5cclxuLyogLS0tLSBpbnRlZ3JpdHkgLS0tLSAqL1xyXG5cclxuLyoqIG5wbSBkaXN0LmludGVncml0eSgnc2hhNTEyLWJhc2U2NCcpIFx1NjgyMVx1OUE4QztcdTRFMERcdTUzMzlcdTkxNERcdThGRDRcdTU2REUgZmFsc2UoXHU2NzJBXHU3N0U1XHU3Qjk3XHU2Q0Q1XHU4RkQ0XHU1NkRFIHRydWUgXHU2NTNFXHU4ODRDKVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gaW50ZWdyaXR5T2soZGF0YTogQnVmZmVyLCBpbnRlZ3JpdHk/OiBzdHJpbmcpOiBib29sZWFuIHtcclxuICBpZiAoaW50ZWdyaXR5ID09PSB1bmRlZmluZWQgfHwgaW50ZWdyaXR5ID09PSAnJykgcmV0dXJuIHRydWU7XHJcbiAgY29uc3QgbSA9IC9ec2hhNTEyLShbQS1aYS16MC05Ky89XSspJC8uZXhlYyhpbnRlZ3JpdHkudHJpbSgpKTtcclxuICBpZiAobSA9PT0gbnVsbCkgcmV0dXJuIHRydWU7XHJcbiAgcmV0dXJuIGNyZWF0ZUhhc2goJ3NoYTUxMicpLnVwZGF0ZShkYXRhKS5kaWdlc3QoJ2Jhc2U2NCcpID09PSBtWzFdO1xyXG59XHJcblxyXG4vKiogXHU0RUJBXHU3QzdCXHU1M0VGXHU4QkZCXHU1QjU3XHU4MjgyKFx1NUI4OVx1ODhDNVx1OEZEQlx1NUVBNlx1NjU4N1x1Njg0OFx1NzUyOClcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGJ5dGVzTGFiZWwobjogbnVtYmVyKTogc3RyaW5nIHtcclxuICBpZiAobiA8IDEwMjQpIHJldHVybiBgJHtufSBCYDtcclxuICBpZiAobiA8IDEwMjQgKiAxMDI0KSByZXR1cm4gYCR7KG4gLyAxMDI0KS50b0ZpeGVkKDApfSBLQmA7XHJcbiAgcmV0dXJuIGAkeyhuIC8gMTAyNCAvIDEwMjQpLnRvRml4ZWQoMSl9IE1CYDtcclxufVxyXG4iLCAiLyoqXG4gKiBcdTY2RjRcdTY1QjBcdTU2NjhcdTkwMUFcdTkwNTNcdTdFQUZcdTkwM0JcdThGOTEoMjAyNi0xMC0yOSBcdTc1MjhcdTYyMzdcdTUzQ0RcdTk5ODhcdTY4MzlcdTZDQkI6XHU1NkZEXHU1MTg1XHU3NTI4XHU2MjM3XHU2NTM2XHU0RTBEXHU1MjMwXHU2NkY0XHU2NUIwXHU2M0E4XHU5MDAxO1xuICogXHU1NDBDXHU2NUU1XHU0RUZCXHU1MkExIDEzLUM6YXRvbWdpdCBcdTU2RkRcdTUxODVcdTk5OTZcdTkwMDlcdTkwMUFcdTkwNTMgKyBcdTU0MEVcdTUzRjBcdTk3NTlcdTlFRDhcdTY2RjRcdTY1QjApXHUzMDAyXG4gKlxuICogXHU4MENDXHU2NjZGOlx1NjhDMFx1NjdFNVx1OTAxQVx1OTA1M1x1NTM5Rlx1NjcyQ1x1NTNFQVx1OEQ3MCBhcGkuZ2l0aHViLmNvbSBcdTc2RjRcdThGREUoMTVzIFx1OEQ4NVx1NjVGNiksXHU1NkZEXHU1MTg1XHU2NUUwXHU0RUUzXHU3NDA2XHU3RjUxXHU3RURDXHU1RkM1XG4gKiBcdThEODVcdTY1RjYgXHUyMTkyIGNoZWNrIGZhaWxlZCBcdTIxOTIgXHU3NTI4XHU2MjM3XHU2QzM4XHU4RkRDXHU3NzBCXHU0RTBEXHU1MjMwXHU2NUIwXHU3MjQ4XHU2NzJDO1x1NEUwQlx1OEY3RFx1OTAxQVx1OTA1M1x1NTNDRFx1ODAwQ1x1NjcwOVx1OTU1Q1x1NTBDRlx1NTZERVx1OTAwMFx1OTRGRVx1MzAwMlxuICogXHU2NzJDXHU2QTIxXHU1NzU3XHU3RUQ5XHU1MUZBXHU3RUFGXHU4OUM0XHU1MjE5KG1haW4gXHU4RkRCXHU3QTBCXHU0RTBFIHNjcmlwdHMvc2ltLXVwZGF0ZXIubWpzIFx1NTE3MVx1NzUyOCxcdTUzNTVcdTZENEJcdTg5ODZcdTc2RDYpOlxuICogIDEpIFx1NjhDMFx1NjdFNVx1OTAxQVx1OTA1M1x1OTRGRTpcdTc2RjRcdThGREUoOHMsXHU1NkZEXHU1OTE2XHU3OUQyXHU4RkM3KVx1MjE5MiBhdG9tZ2l0IHY1KFx1NTZGRFx1NTE4NVx1NzZGNFx1OEZERSxcdTUzM0ZcdTU0MERcdTVDMEZcdTU0Q0RcdTVFOTQpXG4gKiAgICAgXHUyMTkyIGdoLXByb3h5IFx1MjE5MiBnaGZhc3QsXHU5MDEwXHU0RTJBXHU4QkQ1XHU1MjMwXHU2MkZGXHU1MjMwIHJlbGVhc2U7XG4gKiAgMikgXHU5MDFBXHU5MDUzXHU3Qzk4XHU2MDI3Olx1NEUwQVx1NkIyMVx1NTQ3RFx1NEUyRFx1NzY4NFx1OTAxQVx1OTA1M1x1NEYxOFx1NTE0OCxcdTU5MzFcdThEMjVcdTUxOERcdTU2REVcdTkwMDBcdTUxNjhcdTk0RkU7XG4gKiAgMykgXHU0RTBCXHU4RjdEXHU1NDBDXHU2RTkwXHU0RjE4XHU1MTQ4Olx1NEUwRVx1NTQ3RFx1NEUyRFx1NzY4NFx1NjhDMFx1NjdFNVx1OTAxQVx1OTA1M1x1NTQwQ1x1NkU5MFx1NzY4NFx1OTU1Q1x1NTBDRlx1NTE0OFx1OEJENSxcdTUxOERcdTc2RjRcdThGREVcdTRFMEVcdTUxNzZcdTRGNTlcdTk1NUNcdTUwQ0Y7XG4gKiAgICAgYXRvbWdpdCBcdTU0N0RcdTRFMkQgXHUyMTkyIGF0b21naXQgXHU4RDQ0XHU0RUE3XHU3NkY0XHU5NEZFIC8gQVBJIFx1N0FFRlx1NzBCOVx1NEYxOFx1NTE0OCxHaXRIdWIgXHU0RTNCXHU0RUQzXHU5NTVDXHU1MENGXHU1MTVDXHU1RTk1XHUzMDAyXG4gKiBcdTY1RTAgZWxlY3Ryb24gXHU0RjlEXHU4RDU2KFx1NTNFRlx1ODhBQiBub2RlIC0taW1wb3J0IHRzeCBcdTc2ODRcdTZENEJcdThCRDUvXHU2QTIxXHU2MkRGXHU4MTFBXHU2NzJDXHU3NkY0XHU2M0E1IGltcG9ydClcdTMwMDJcbiAqL1xuXG5leHBvcnQgdHlwZSBVcGRhdGVDaGFubmVsSWQgPSAnZGlyZWN0JyB8ICdhdG9tZ2l0JyB8ICdnaC1wcm94eScgfCAnZ2hmYXN0JztcblxuLyoqIFx1NTNDQ1x1NEVEM1x1NjYyMFx1NUMwNDpHaXRIdWIgXHU0RTNCXHU0RUQzXHU0RTBFIGF0b21naXQgXHU5NTVDXHU1MENGXHU0RUQzIG93bmVyIFx1NEUwRFx1NTQwQyhzd3NnYmwgdnMgaG9uZ2Z1KSxcbiAqICBcdTkwMUFcdTkwNTNcdTU0MDRcdTgxRUFcdTUzRDZcdTgxRUFcdTVERjFcdTc2ODRcdTRFRDMoXHU1M0VGXHU4OEFCIFVQREFURV9SRVBPIC8gVVBEQVRFX1JFUE9fQVRPTUdJVCBcdTg5ODZcdTc2RDYpXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIFVwZGF0ZVJlcG9zIHsgZ2l0aHViOiBzdHJpbmc7IGF0b21naXQ6IHN0cmluZyB9XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ2hlY2tDaGFubmVsIHtcbiAgaWQ6IFVwZGF0ZUNoYW5uZWxJZDtcbiAgLyoqIFx1OEJDQVx1NjVBRC9VSSBcdTY2M0VcdTc5M0FcdTU0MEQoXHU5NTE5XHU4QkVGXHU0RkUxXHU2MDZGXHU5MUNDXHU5MDEwXHU5MDFBXHU5MDUzXHU1M0VGXHU4OUMxKVx1MzAwMiAqL1xuICBsYWJlbDogc3RyaW5nO1xuICAvKiogXHU1MzU1XHU5MDFBXHU5MDUzXHU4RDg1XHU2NUY2Olx1NzZGNFx1OEZERSA4cyhcdTU2RkRcdTU5MTZcdTc5RDJcdThGQzdcdTMwMDFcdTU2RkRcdTUxODVcdTVGRUJcdTkwMUZcdThCQTlcdTRGNERcdTk1NUNcdTUwQ0YpLGF0b21naXQvXHU5NTVDXHU1MENGIDEwc1x1MzAwMiAqL1xuICB0aW1lb3V0TXM6IG51bWJlcjtcbiAgYXBpVXJsOiAocmVwb3M6IFVwZGF0ZVJlcG9zKSA9PiBzdHJpbmc7XG4gIC8qKiBcdTRFMEJcdThGN0RcdTk1NUNcdTUwQ0ZcdTUyNERcdTdGMDAoJycgPSBcdTc2RjRcdThGREUgYXNzZXQgdXJsKTtcdTk4N0JcdTU3MjggRE9XTkxPQURfTUlSUk9SX1BSRUZJWEVTIFx1NkUwNVx1NTM1NVx1NTE4NVx1MzAwMiAqL1xuICBkb3dubG9hZFByZWZpeDogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFJlbGVhc2VBc3NldCB7IG5hbWU6IHN0cmluZzsgYnJvd3Nlcl9kb3dubG9hZF91cmw6IHN0cmluZzsgc2l6ZTogbnVtYmVyIH1cbmV4cG9ydCBpbnRlcmZhY2UgTGF0ZXN0UmVsZWFzZSB7IHRhZ19uYW1lOiBzdHJpbmc7IGJvZHk/OiBzdHJpbmc7IGFzc2V0cz86IFJlbGVhc2VBc3NldFtdIH1cblxuY29uc3QgZ2l0aHViTGF0ZXN0ID0gKHJlcG86IHN0cmluZyk6IHN0cmluZyA9PiBgaHR0cHM6Ly9hcGkuZ2l0aHViLmNvbS9yZXBvcy8ke3JlcG99L3JlbGVhc2VzL2xhdGVzdGA7XG5cbi8qKiBcdTY4QzBcdTY3RTVcdTkwMUFcdTkwNTNcdTk0RkUoXHU5RUQ4XHU4QkE0XHU5ODdBXHU1RThGOlx1NzZGNFx1OEZERSBcdTIxOTIgYXRvbWdpdChcdTU2RkRcdTUxODVcdTk5OTZcdTkwMDkpXHUyMTkyIGdoLXByb3h5IFx1MjE5MiBnaGZhc3QpXHUzMDAyICovXG5leHBvcnQgY29uc3QgQ0hFQ0tfQ0hBTk5FTFM6IHJlYWRvbmx5IENoZWNrQ2hhbm5lbFtdID0gW1xuICB7IGlkOiAnZGlyZWN0JywgbGFiZWw6ICdcdTc2RjRcdThGREUnLCB0aW1lb3V0TXM6IDhfMDAwLCBhcGlVcmw6IChyKSA9PiBnaXRodWJMYXRlc3Qoci5naXRodWIpLCBkb3dubG9hZFByZWZpeDogJycgfSxcbiAgeyBpZDogJ2F0b21naXQnLCBsYWJlbDogJ2F0b21naXQoXHU1NkZEXHU1MTg1KScsIHRpbWVvdXRNczogMTBfMDAwLCBhcGlVcmw6IChyKSA9PiBgaHR0cHM6Ly9hcGkuYXRvbWdpdC5jb20vYXBpL3Y1L3JlcG9zLyR7ci5hdG9tZ2l0fS9yZWxlYXNlcz9wZXJfcGFnZT01JmRpcmVjdGlvbj1kZXNjYCwgZG93bmxvYWRQcmVmaXg6ICcnIH0sXG4gIHsgaWQ6ICdnaC1wcm94eScsIGxhYmVsOiAnZ2gtcHJveHknLCB0aW1lb3V0TXM6IDEwXzAwMCwgYXBpVXJsOiAocikgPT4gYGh0dHBzOi8vZ2gtcHJveHkuY29tLyR7Z2l0aHViTGF0ZXN0KHIuZ2l0aHViKX1gLCBkb3dubG9hZFByZWZpeDogJ2h0dHBzOi8vZ2gtcHJveHkuY29tLycgfSxcbiAgeyBpZDogJ2doZmFzdCcsIGxhYmVsOiAnZ2hmYXN0JywgdGltZW91dE1zOiAxMF8wMDAsIGFwaVVybDogKHIpID0+IGBodHRwczovL2doZmFzdC50b3AvJHtnaXRodWJMYXRlc3Qoci5naXRodWIpfWAsIGRvd25sb2FkUHJlZml4OiAnaHR0cHM6Ly9naGZhc3QudG9wLycgfSxcbl07XG5cbi8qKiBcdTRFMEJcdThGN0RcdTk1NUNcdTUwQ0ZcdTUxNjhcdTZFMDVcdTUzNTUoXHU5RUQ4XHU4QkE0XHU5ODdBXHU1RThGO2docHJveHkuY24gXHU0RUM1XHU0RTBCXHU4RjdEXHU1MTVDXHU1RTk1LFx1NEUwRFx1NTA1QVx1NjhDMFx1NjdFNVx1OTAxQVx1OTA1MylcdTMwMDIgKi9cbmV4cG9ydCBjb25zdCBET1dOTE9BRF9NSVJST1JfUFJFRklYRVM6IHJlYWRvbmx5IHN0cmluZ1tdID0gWycnLCAnaHR0cHM6Ly9naGZhc3QudG9wLycsICdodHRwczovL2doLXByb3h5LmNvbS8nLCAnaHR0cHM6Ly9naHByb3h5LmNuLyddO1xuXG4vKiogXHU1QjU4XHU1MEE4XHU1MDNDL0lQQyBcdTUwM0NcdTVGNTJcdTRFMDA6XHU1NDA4XHU2Q0Q1XHU5MDFBXHU5MDUzIGlkIFx1NjIxNiBudWxsKFx1N0M5OFx1NjAyN1x1NjU4N1x1NEVGNlx1NjM1Rlx1NTc0Ri9cdTY1RTdcdTcyNDhcdTY3MkNcdTZCOEJcdTc1NTlcdTY1RjZcdTRFMERcdTgxRjRcdTU0N0QpXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplQ2hhbm5lbCh2OiB1bmtub3duKTogVXBkYXRlQ2hhbm5lbElkIHwgbnVsbCB7XG4gIHJldHVybiB0eXBlb2YgdiA9PT0gJ3N0cmluZycgJiYgQ0hFQ0tfQ0hBTk5FTFMuc29tZSgoYykgPT4gYy5pZCA9PT0gdikgPyAodiBhcyBVcGRhdGVDaGFubmVsSWQpIDogbnVsbDtcbn1cblxuLyoqIFx1N0M5OFx1NjAyN1x1NjM5Mlx1NUU4RjpcdTRFMEFcdTZCMjFcdTU0N0RcdTRFMkRcdTkwMUFcdTkwNTNcdTRGMThcdTUxNDgsXHU1MTc2XHU0RjU5XHU0RkREXHU2MzAxXHU5RUQ4XHU4QkE0XHU5NEZFXHU1RThGKFx1NEVGQlx1NEUwMFx1OTAxQVx1OTA1M1x1NTkzMVx1OEQyNVx1NEVDRFx1NTNFRlx1NTE2OFx1OTRGRVx1NTZERVx1OTAwMClcdTMwMDIgKi9cbmV4cG9ydCBmdW5jdGlvbiBvcmRlcmVkQ2hlY2tDaGFubmVscyhzdGlja3k6IHVua25vd24pOiByZWFkb25seSBDaGVja0NoYW5uZWxbXSB7XG4gIGNvbnN0IHMgPSBub3JtYWxpemVDaGFubmVsKHN0aWNreSk7XG4gIGNvbnN0IGZpcnN0ID0gcyA9PT0gbnVsbCA/IHVuZGVmaW5lZCA6IENIRUNLX0NIQU5ORUxTLmZpbmQoKGMpID0+IGMuaWQgPT09IHMpO1xuICBpZiAoZmlyc3QgPT09IHVuZGVmaW5lZCkgcmV0dXJuIENIRUNLX0NIQU5ORUxTO1xuICByZXR1cm4gW2ZpcnN0LCAuLi5DSEVDS19DSEFOTkVMUy5maWx0ZXIoKGMpID0+IGMuaWQgIT09IHMpXTtcbn1cblxuLyoqIFx1NEUwQlx1OEY3RFx1OTU1Q1x1NTBDRlx1OTg3QVx1NUU4RjpcdTU0N0RcdTRFMkRcdTY4QzBcdTY3RTVcdTkwMUFcdTkwNTNcdTc2ODRcdTU0MENcdTZFOTBcdTk1NUNcdTUwQ0ZcdTRGMThcdTUxNDggXHUyMTkyIFx1NzZGNFx1OEZERSBcdTIxOTIgXHU1MTc2XHU0RjU5XHU5NTVDXHU1MENGKFx1NTNCQlx1OTFDRCw0IFx1OTAxQVx1OTA1M1x1NkUwNVx1NTM1NVx1NEZERFx1NzU1OSlcdTMwMDIgKi9cbmV4cG9ydCBmdW5jdGlvbiBvcmRlcmVkRG93bmxvYWRNaXJyb3JzKGFzc2V0VXJsOiBzdHJpbmcsIGNoYW5uZWw6IHVua25vd24pOiByZWFkb25seSBzdHJpbmdbXSB7XG4gIGNvbnN0IGhpdCA9IG5vcm1hbGl6ZUNoYW5uZWwoY2hhbm5lbCk7XG4gIGNvbnN0IHByZWZpeCA9IGhpdCA9PT0gbnVsbCA/ICcnIDogQ0hFQ0tfQ0hBTk5FTFMuZmluZCgoYykgPT4gYy5pZCA9PT0gaGl0KT8uZG93bmxvYWRQcmVmaXggPz8gJyc7XG4gIGNvbnN0IHByZWZpeGVzID0gWy4uLm5ldyBTZXQoW3ByZWZpeCwgLi4uRE9XTkxPQURfTUlSUk9SX1BSRUZJWEVTXSldO1xuICByZXR1cm4gcHJlZml4ZXMubWFwKChwKSA9PiAocCA9PT0gJycgPyBhc3NldFVybCA6IGAke3B9JHthc3NldFVybH1gKSk7XG59XG5cbi8qKiBcdThCRURcdTRFNDlcdTcyNDhcdTY3MkNcdTZCRDRcdThGODMoJ3YnIFx1NTI0RFx1N0YwMFx1NTNFRlx1OTAwOSxcdTYzMDkgLiBcdTUyMDZcdTZCQjVcdTY1NzBcdTUwM0NcdTZCRDQ7XHU0RTBEXHU4REIzXHU0RTA5XHU2QkI1XHU4ODY1IDApXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gY21wVmVyc2lvbihhOiBzdHJpbmcsIGI6IHN0cmluZyk6IG51bWJlciB7XG4gIGNvbnN0IHBhID0gYS5yZXBsYWNlKC9edi8sICcnKS5zcGxpdCgnLicpLm1hcChOdW1iZXIpO1xuICBjb25zdCBwYiA9IGIucmVwbGFjZSgvXnYvLCAnJykuc3BsaXQoJy4nKS5tYXAoTnVtYmVyKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCAzOyBpKyspIHtcbiAgICBpZiAoKHBhW2ldID8/IDApICE9PSAocGJbaV0gPz8gMCkpIHJldHVybiAocGFbaV0gPz8gMCkgPCAocGJbaV0gPz8gMCkgPyAtMSA6IDE7XG4gIH1cbiAgcmV0dXJuIDA7XG59XG5cbi8qKiBcdTU0Q0RcdTVFOTRcdTVGNTJcdTRFMDA6R2l0SHViIC9yZWxlYXNlcy9sYXRlc3QgXHU4RkQ0XHU1NkRFXHU1QkY5XHU4QzYxLGF0b21naXQgL3JlbGVhc2VzIFx1OEZENFx1NTZERVx1NjU3MFx1N0VDNFx1MzAwMlxuICogIGF0b21naXQgXHU1MjE3XHU4ODY4XHU2MzA5IGNyZWF0ZWRfYXQgXHU2MzkyXHU1RThGXHUzMDAxXHU5OTk2XHU0RTJBXHU1MTQzXHU3RDIwXHU0RTBEXHU0RkREXHU4QkMxXHU2NjJGXHU2NzAwXHU2NUIwIHRhZyhcdTVCOUVcdTZENEIgdjAuMi44IFx1NUVGQVxuICogIFx1NUY5N1x1NkJENCB2MC4yLjkgXHU2NjVBXHU4MDBDXHU2MzkyXHU3QjJDXHU0RTAwKVx1MjE5MiBcdTVCQTJcdTYyMzdcdTdBRUZcdTYzMDlcdThCRURcdTRFNDlcdTcyNDhcdTY3MkNcdTYzMTEgdGFnIFx1NjcwMFx1NTkyN1x1NzY4NCByZWxlYXNlXHUzMDAydGFnIFx1N0YzQVx1NTkzMS9cbiAqICBcdTVGNjJcdTcyQjZcdTRFMERcdTVCRjlcdThGRDRcdTU2REUgbnVsbChcdTYzMDlcdTY3MkNcdTkwMUFcdTkwNTNcdTU5MzFcdThEMjVcdTU2REVcdTkwMDBcdTRFMEJcdTRFMDBcdTkwMUFcdTkwNTMpXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplUmVsZWFzZShqc29uOiB1bmtub3duKTogTGF0ZXN0UmVsZWFzZSB8IG51bGwge1xuICBsZXQgYmVzdDogTGF0ZXN0UmVsZWFzZSB8IG51bGwgPSBudWxsO1xuICBmb3IgKGNvbnN0IHJlbCBvZiBBcnJheS5pc0FycmF5KGpzb24pID8ganNvbiA6IFtqc29uXSkge1xuICAgIGlmICh0eXBlb2YgcmVsICE9PSAnb2JqZWN0JyB8fCByZWwgPT09IG51bGwpIGNvbnRpbnVlO1xuICAgIGNvbnN0IHIgPSByZWwgYXMgeyB0YWdfbmFtZT86IHVua25vd247IGJvZHk/OiB1bmtub3duOyBhc3NldHM/OiB1bmtub3duIH07XG4gICAgaWYgKHR5cGVvZiByLnRhZ19uYW1lICE9PSAnc3RyaW5nJyB8fCByLnRhZ19uYW1lID09PSAnJykgY29udGludWU7XG4gICAgY29uc3QgYXNzZXRzOiBSZWxlYXNlQXNzZXRbXSA9IEFycmF5LmlzQXJyYXkoci5hc3NldHMpXG4gICAgICA/IHIuYXNzZXRzLmZsYXRNYXAoKGEpOiBSZWxlYXNlQXNzZXRbXSA9PiB7XG4gICAgICAgICAgY29uc3QgeCA9IGEgYXMgeyBuYW1lPzogdW5rbm93bjsgYnJvd3Nlcl9kb3dubG9hZF91cmw/OiB1bmtub3duOyBzaXplPzogdW5rbm93biB9O1xuICAgICAgICAgIHJldHVybiB0eXBlb2YgeC5uYW1lID09PSAnc3RyaW5nJyAmJiB0eXBlb2YgeC5icm93c2VyX2Rvd25sb2FkX3VybCA9PT0gJ3N0cmluZydcbiAgICAgICAgICAgID8gW3sgbmFtZTogeC5uYW1lLCBicm93c2VyX2Rvd25sb2FkX3VybDogeC5icm93c2VyX2Rvd25sb2FkX3VybCwgc2l6ZTogdHlwZW9mIHguc2l6ZSA9PT0gJ251bWJlcicgPyB4LnNpemUgOiAwIH1dXG4gICAgICAgICAgICA6IFtdO1xuICAgICAgICB9KVxuICAgICAgOiBbXTtcbiAgICBjb25zdCBjdXI6IExhdGVzdFJlbGVhc2UgPSB7IHRhZ19uYW1lOiByLnRhZ19uYW1lLCBib2R5OiB0eXBlb2Ygci5ib2R5ID09PSAnc3RyaW5nJyA/IHIuYm9keSA6ICcnLCBhc3NldHMgfTtcbiAgICBpZiAoYmVzdCA9PT0gbnVsbCB8fCBjbXBWZXJzaW9uKGN1ci50YWdfbmFtZSwgYmVzdC50YWdfbmFtZSkgPiAwKSBiZXN0ID0gY3VyO1xuICB9XG4gIHJldHVybiBiZXN0O1xufVxuXG4vKiogXHU0RUNFIHJlbGVhc2UgXHU4RDQ0XHU0RUE3XHU2MzExXHU1Qjg5XHU4OEM1XHU1MzA1OkhNSC1EZXNrdG9wLVNldHVwLSouZXhlIFx1N0NCRVx1Nzg2RVx1NTMzOVx1OTE0RCxcdTUxNUNcdTVFOTVcdTRFRkJcdTYxMEYgLmV4ZVx1MzAwMiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBpY2tJbnN0YWxsZXJBc3NldChhc3NldHM6IHJlYWRvbmx5IFJlbGVhc2VBc3NldFtdKTogUmVsZWFzZUFzc2V0IHwgbnVsbCB7XG4gIHJldHVybiBhc3NldHMuZmluZCgoYSkgPT4gL15ITUgtRGVza3RvcC1TZXR1cC0uKlxcLmV4ZSQvaS50ZXN0KGEubmFtZSkpXG4gICAgPz8gYXNzZXRzLmZpbmQoKGEpID0+IGEubmFtZS50b0xvd2VyQ2FzZSgpLmVuZHNXaXRoKCcuZXhlJykpXG4gICAgPz8gbnVsbDtcbn1cblxuLyoqIGF0b21naXQgQVBJIFx1NEUwQlx1OEY3RFx1N0FFRlx1NzBCOShhZy1jbGkgcmVsZWFzZV9hc3NldHMuZ28gXHU1NDBDXHU1RjYyOnRhZyArIFx1NjU4N1x1NEVGNlx1NTQwRClcdTMwMDIgKi9cbmV4cG9ydCBmdW5jdGlvbiBhdG9tZ2l0QXBpRG93bmxvYWRVcmwocmVwb3M6IFVwZGF0ZVJlcG9zLCB0YWc6IHN0cmluZywgYXNzZXROYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gYGh0dHBzOi8vYXBpLmF0b21naXQuY29tL2FwaS92NS9yZXBvcy8ke3JlcG9zLmF0b21naXR9L3JlbGVhc2VzLyR7dGFnfS9hdHRhY2hfZmlsZXMvJHtlbmNvZGVVUklDb21wb25lbnQoYXNzZXROYW1lKX0vZG93bmxvYWRgO1xufVxuXG4vKiogXHU0RTBCXHU4RjdEXHU1MDE5XHU5MDA5XHU5NEZFOmF0b21naXQgXHU1NDdEXHU0RTJEKFx1NjIxNlx1OEQ0NFx1NEVBNyBVUkwgXHU2NzJDXHU1QzMxXHU1NzI4IGF0b21naXQuY29tKVx1MjE5MiBhdG9tZ2l0IFx1OEQ0NFx1NEVBN1x1NzZGNFx1OTRGRVx1MzAwMVxuICogIGF0b21naXQgQVBJIFx1N0FFRlx1NzBCOVx1NEYxOFx1NTE0OCxcdTUxOERcdTYyRkMgR2l0SHViIFx1NEUzQlx1NEVEM1x1NTQwQyB0YWcgXHU1NDBDXHU1NDBEXHU4RDQ0XHU0RUE3XHU3Njg0XHU5NTVDXHU1MENGXHU5NEZFXHU1MTVDXHU1RTk1KGF0b21naXRcbiAqICAzMDIgXHUyMTkyIENETiBcdTdCN0VcdTU0MERcdTc2RjRcdTk0RkUsXHU1MzNGXHU1NDBEXHU1M0VGXHU0RTBCXHUzMDAxXHU2NUUwXHU5NzAwIFJlZmVyZXIpO0dpdEh1YiBcdTU0N0RcdTRFMkQgXHUyMTkyIFx1NjVFMlx1NjcwOVx1OTU1Q1x1NTBDRlx1OTRGRVx1MzAwMiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRvd25sb2FkQ2FuZGlkYXRlcyhpbnB1dDogeyBjaGFubmVsOiB1bmtub3duOyB0YWc6IHN0cmluZzsgYXNzZXRVcmw6IHN0cmluZzsgYXNzZXROYW1lOiBzdHJpbmc7IHJlcG9zOiBVcGRhdGVSZXBvcyB9KTogcmVhZG9ubHkgc3RyaW5nW10ge1xuICBjb25zdCB7IGNoYW5uZWwsIHRhZywgYXNzZXRVcmwsIGFzc2V0TmFtZSwgcmVwb3MgfSA9IGlucHV0O1xuICBsZXQgb25BdG9tZ2l0ID0gbm9ybWFsaXplQ2hhbm5lbChjaGFubmVsKSA9PT0gJ2F0b21naXQnO1xuICB0cnkgeyBpZiAobmV3IFVSTChhc3NldFVybCkuaG9zdG5hbWUgPT09ICdhdG9tZ2l0LmNvbScpIG9uQXRvbWdpdCA9IHRydWU7IH0gY2F0Y2ggeyAvKiBcdTY1RTBcdTY1NDggVVJMIFx1NjMwOVx1OTAxQVx1OTA1M1x1NTIyNFx1NUI5QSAqLyB9XG4gIGlmIChvbkF0b21naXQpIHtcbiAgICBjb25zdCBnaXRodWJBc3NldFVybCA9IGBodHRwczovL2dpdGh1Yi5jb20vJHtyZXBvcy5naXRodWJ9L3JlbGVhc2VzL2Rvd25sb2FkLyR7dGFnfS8ke2Fzc2V0TmFtZX1gO1xuICAgIHJldHVybiBbLi4ubmV3IFNldChbYXNzZXRVcmwsIGF0b21naXRBcGlEb3dubG9hZFVybChyZXBvcywgdGFnLCBhc3NldE5hbWUpLCAuLi5vcmRlcmVkRG93bmxvYWRNaXJyb3JzKGdpdGh1YkFzc2V0VXJsLCBjaGFubmVsKV0pXTtcbiAgfVxuICByZXR1cm4gb3JkZXJlZERvd25sb2FkTWlycm9ycyhhc3NldFVybCwgY2hhbm5lbCk7XG59XG5cbi8qKiBcdTRFMEJcdThGN0RcdTY4MjFcdTlBOEM6XHU1MTQzXHU2NTcwXHU2MzZFIHNpemU+MCBcdTY1RjZcdTk4N0JcdTRFMEVcdTg0M0RcdTc2RDhcdTVCNTdcdTgyODJcdTRFMDBcdTgxRjQoYXRvbWdpdCBcdTRGMjBcdThGOTNcdTUzRUZcdTk3NjBcdTYwMjdcdTk5OTZcdTlBOEMsXG4gKiAgR2l0SHViIFx1OEQ0NFx1NEVBN1x1NTE0M1x1NjU3MFx1NjM2RVx1NTQwQ1x1NjgzN1x1NUUyNiBzaXplLFx1OTg3QVx1NUUyNlx1NEUwMFx1OEQ3N1x1NEZERFx1NzcxRilcdTMwMDIgKi9cbmV4cG9ydCBmdW5jdGlvbiBzaXplTWF0Y2hlcyhtZXRhU2l6ZTogbnVtYmVyLCBhY3R1YWxCeXRlczogbnVtYmVyKTogYm9vbGVhbiB7XG4gIHJldHVybiAhKG1ldGFTaXplID4gMCkgfHwgbWV0YVNpemUgPT09IGFjdHVhbEJ5dGVzO1xufVxuXG4vKiogXHU1MTY4XHU5MDFBXHU5MDUzXHU1OTMxXHU4RDI1XHU3Njg0XHU5NTE5XHU4QkVGXHU0RTMyOlx1OTAxMFx1OTAxQVx1OTA1M1x1NTIxN1x1NTFGQVx1NTM5Rlx1NTZFMChcdTdGNTFcdTdFRENcdThCQ0FcdTY1QURcdTc1Mjg7VUkgXHU2NkY0XHU2NUIwXHU5NzYyXHU2NzdGXHU3MTY3XHU1RTM4XHU2NjNFXHU3OTNBKVx1MzAwMiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN1bW1hcml6ZUNoZWNrRmFpbHVyZXMoZmFpbHVyZXM6IFJlYWRvbmx5QXJyYXk8eyBsYWJlbDogc3RyaW5nOyByZWFzb246IHN0cmluZyB9Pik6IHN0cmluZyB7XG4gIHJldHVybiBmYWlsdXJlcy5tYXAoKGYpID0+IGAke2YubGFiZWx9OiR7Zi5yZWFzb259YCkuam9pbignOyAnKTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICI7QUFjQSxTQUFTLE9BQUFBLE1BQUssZUFBZSxRQUFRLFNBQVMsU0FBUyxPQUFPLE1BQU0sY0FBYyxNQUFNLGFBQWEsbUJBQW1CO0FBQ3hILFNBQVMsUUFBQUMsT0FBTSxTQUFTLFVBQVUsWUFBWSxlQUFlO0FBQzdELFNBQVMsY0FBQUMsYUFBWSxnQkFBQUMsZUFBYyxvQkFBb0I7QUFDdkQsU0FBUyx5QkFBeUI7QUFDbEMsU0FBUyxhQUFBQyxZQUFXLFVBQVUsTUFBTSxjQUFjO0FBQ2xELFNBQVMsV0FBQUMsVUFBUyx5QkFBeUI7QUFDM0MsU0FBUyxjQUFjLFNBQUFDLGNBQWE7QUFDcEMsU0FBUyxpQkFBQUMsc0JBQXFCOzs7QUNYOUIsU0FBUyxhQUFnQztBQUN6QyxTQUFTLHVCQUF1QjtBQUNoQyxTQUFTLG1CQUFtQjs7O0FDRHJCLElBQU0sY0FBYztBQUFBLEVBQ3pCO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFDRjtBQUlPLElBQU0sdUJBQXVCOzs7QUNsQjdCLElBQU0sY0FBYztBQUFBLEVBQ3pCO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFDRjtBQUlPLElBQU0sbUJBQW1CLENBQUMsYUFBYSxVQUFVLFVBQVUsV0FBVztBQWN0RSxTQUFTLGFBQ2QsTUFDQSxTQUNBLE9BQXFHLENBQUMsR0FDeEY7QUFDZCxRQUFNLElBQWtCLEVBQUUsTUFBTSxTQUFTLFdBQVcsS0FBSyxjQUFjLEtBQUs7QUFDNUUsTUFBSSxLQUFLLGNBQWMsT0FBVyxHQUFFLFlB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QUFNLENBQUMsRUFBRTtBQUNqRixVQUFJLENBQUMsR0FBSSxXQUFVO0FBQUEsSUFDckI7QUFDQSxZQUFRLElBQUksOEJBQThCLFFBQVEsU0FBUyxNQUFNLElBQUksUUFBUSxNQUFNLEVBQUU7QUFDckYsSUFBQUEsS0FBSSxLQUFLLFdBQVcsSUFBSSxJQUFJLENBQUM7QUFBQSxFQUMvQjtBQUdBLEVBQUFBLEtBQUksR0FBRyxlQUFlLENBQUMsTUFBTTtBQUMzQixRQUFJLGVBQWUsUUFBUSxXQUFXLFVBQVUsV0FBVztBQUN6RCxRQUFFLGVBQWU7QUFDakIsZ0JBQVUsTUFBTTtBQUNoQixXQUFLLFdBQVcsS0FBSyxFQUFFLFFBQVEsTUFBTUEsS0FBSSxLQUFLLENBQUM7QUFBQSxJQUNqRDtBQUFBLEVBQ0YsQ0FBQztBQUNELEVBQUFBLEtBQUksR0FBRyxxQkFBcUIsTUFBTTtBQUNoQyxRQUFJLFFBQVEsYUFBYSxTQUFVLENBQUFBLEtBQUksS0FBSztBQUFBLEVBQzlDLENBQUM7QUFDSDtBQTU4Q1c7QUF5QkE7QUFPQTtBQWVBO0FBNEJBO0FBOEpBO0FBc0JBO0FBNEJBO0FBNERBO0FBVUE7QUFnQkE7QUFnQkE7QUFlQTtBQTJFQTtBQU9BO0FBUUE7QUFXQTtBQWtFQTtBQUtBO0FBaUJBO0FBS0E7QUFZQTtBQW9CQTtBQW9IQTtBQVlBO0FBV0E7IiwKICAibmFtZXMiOiBbImFwcCIsICJqb2luIiwgImV4aXN0c1N5bmMiLCAicmVhbHBhdGhTeW5jIiwgIndyaXRlRmlsZSIsICJob21lZGlyIiwgInNwYXduIiwgInBhdGhUb0ZpbGVVUkwiLCAicmVzb2x2ZSIsICJyYW5kb21VVUlEIiwgInJhbmRvbVVVSUQiLCAicmVzb2x2ZSIsICJhcHAiLCAibWtkaXIiLCAid3JpdGVGaWxlIiwgImpvaW4iLCAic2xlZXAiLCAic3Bhd24iLCAiam9pbiIsICJqb2luIiwgInJlc29sdmUiLCAic3Bhd24iLCAiam9pbiIsICJqb2luIiwgImFwcCIsICJwdXNoRXZlbnQiLCAibm90aWZ5RXZlbnQiLCAiZm9jdXNNYWluV2luZG93IiwgInNldHVwVHJheSIsICJhcHBseUNocm9tZSIsICJhcHBseVVwZGF0ZSIsICJzcGF3biIsICJidWlsZEFwcE1lbnUiLCAicG9wdXBNYWluTWVudSIsICJ3ZWJBdXRvc3RhcnRJbnN0YWxsZWQiLCAiZXhpc3RzU3luYyIsICJsYW5JcE9mIiwgImNsaUVudHJ5T2YiLCAicmVwb1Jvb3RPZiIsICJwa2dOYW1lQXQiLCAicnVuQ2xpIiwgImJyb2FkY2FzdEhvc3RTdGF0ZSIsICJwa2dWZXJzaW9uQXQiLCAiZW50cnlGcm9tQ2xpRGlyIiwgImRldGVjdEV4dGVybmFsUnVudGltZSIsICJyZWFscGF0aFN5bmMiLCAiaG9tZWRpciIsICJkZXRlY3RSZWFsRW50cnkiLCAiYnVuZGxlZFJ1bnRpbWVQYXRoIiwgImJ1bmRsZWRSdW50aW1lSW5mbyIsICJucG1PblBhdGgiLCAid2l6YXJkU3VwcHJlc3NlZCIsICJzZW5kZXJUcnVzdGVkIiwgImhvc3RDYWxsIiwgInJlZ2lzdGVySXBjIiwgIndyaXRlRmlsZSIsICJ3IiwgInBhdGhUb0ZpbGVVUkwiLCAiYXBwMiJdCn0K
