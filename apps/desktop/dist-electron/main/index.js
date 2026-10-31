// apps/desktop/electron/main/index.ts
import { app as app3, BrowserWindow, dialog, ipcMain, session, shell, Tray, Notification, Menu, nativeImage, nativeTheme } from "electron";
import { join as join5, dirname as dirname2, basename, isAbsolute as isAbsolute2, resolve } from "node:path";
import { existsSync as existsSync3, realpathSync as realpathSync2, readFileSync as readFileSync2 } from "node:fs";
import { createWriteStream } from "node:fs";
import { writeFile as writeFile3, readFile, stat, rename } from "node:fs/promises";
import { homedir as homedir3, networkInterfaces } from "node:os";
import { execFileSync as execFileSync2, spawn as spawn4 } from "node:child_process";
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
  setState(s2, err) {
    this._state = s2;
    if (err !== void 0) this.lastError = err;
    const info = { restartCount: this.restartCount };
    if (this.lastError !== "") info.lastError = this.lastError;
    this.opts.onStateChange?.(s2, info);
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
    let s2 = sessions.get(sessionId);
    if (s2 === void 0) {
      s2 = { id: sessionId, createdAt: (/* @__PURE__ */ new Date()).toISOString(), updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
      sessions.set(sessionId, s2);
    }
    s2.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    return s2;
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
      let b2 = "";
      req.on("data", (c) => {
        b2 += c.toString();
      });
      req.on("end", () => resolve2(b2));
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
      const list = [...sessions.values()].map((s2) => ({
        id: s2.id,
        title: "",
        task: "",
        outcome: "ok",
        turns: 1,
        toolUses: 1,
        time: s2.updatedAt,
        cwd: "C:\\demo",
        branch: "",
        createdAt: s2.createdAt,
        updatedAt: s2.updatedAt
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
      const s2 = sessions.get(id);
      if (s2 === void 0) {
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
      const [ok2, detail] = await fn();
      results.push([name, ok2, detail]);
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
  if (process.env.HMH_DESKTOP_UIVERIFY_FORGE === "real") {
    await step("\u4ED3\u5E93(\u771F\u5B9E):\u53CC\u5E73\u53F0\u767B\u5F55\u5361 \u2014\u2014 gh=swsgbl / ag=hongfu", async () => {
      await js(`(function(){ var t=[].slice.call(document.querySelectorAll('.dock-tab')).find(function(x){return x.textContent==='\u4ED3\u5E93'||x.textContent==='Repos';}); if(t) t.click(); })()`);
      return waitFor("both logged in", `var gh=document.querySelector('[data-testid="forge-host-github"]');
        var ag=document.querySelector('[data-testid="forge-host-atomgit"]');
        var ghOk = !!gh && gh.textContent.indexOf('swsgbl')>=0;
        var agOk = !!ag && ag.textContent.indexOf('hongfu')>=0;
        return {ok: ghOk && agOk, detail: 'gh='+(gh?gh.textContent.replace(/\\s+/g,' ').slice(0,40):'none')+' | ag='+(ag?ag.textContent.replace(/\\s+/g,' ').slice(0,40):'none')};`, 3e4);
    });
    await shot("forge-real-hosts");
    await step("\u4ED3\u5E93(\u771F\u5B9E):GitHub \u6211\u7684\u4ED3\u5E93\u5217\u8868 \u22651 \u884C", async () => {
      return waitFor("github repos", `var rows=document.querySelectorAll('[data-testid="forge-repo-row"]').length;
        return {ok: rows>=1, detail: 'rows='+rows};`, 45e3);
    });
    await step("\u4ED3\u5E93(\u771F\u5B9E):\u5207 AtomGit \u2192 \u5217\u51FA hongfu \u4ED3\u5E93(\u542B hmh-desktop)", async () => {
      await js(`(function(){ var c=[].slice.call(document.querySelectorAll('.forge-host-chips .forge-chip')).find(function(x){return x.textContent==='AtomGit';}); if(c) c.click(); })()`);
      return waitFor("atomgit repos", `var rows=[].slice.call(document.querySelectorAll('[data-testid="forge-repo-row"]'));
        var hit = rows.some(function(x){return x.textContent.indexOf('hmh-desktop')>=0;});
        return {ok: rows.length>=1 && hit, detail: 'rows='+rows.length+(hit?' \u542Bhmh-desktop':' \u65E0hmh-desktop')};`, 45e3);
    });
    await shot("forge-real-atomgit-repos");
    await step("\u4ED3\u5E93(\u771F\u5B9E):\u8FDB\u5165 hongfu/hmh-desktop \u2192 Release \u5217\u8868\u542B v0.2.10", async () => {
      await js(`(function(){ var r=[].slice.call(document.querySelectorAll('[data-testid="forge-repo-row"]')).find(function(x){return x.textContent.indexOf('hmh-desktop')>=0;}); var m=r?r.querySelector('.forge-main'):null; if(m) m.click(); })()`);
      return waitFor("releases with v0.2.10", `var rows=[].slice.call(document.querySelectorAll('[data-testid="forge-release-row"]'));
        var hit = rows.some(function(x){return x.textContent.indexOf('v0.2.10')>=0;});
        return {ok: rows.length>=1 && hit, detail: 'releases='+rows.length+(hit?' \u542Bv0.2.10':' \u65E0v0.2.10;\u9996\u884C='+(rows[0]?rows[0].textContent.replace(/\\s+/g,' ').slice(0,50):'none'))};`, 45e3);
    });
    await shot("forge-real-releases");
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
    await step("\u4ED3\u5E93:\u53CC\u5E73\u53F0\u72B6\u6001\u5361(GitHub \u5DF2\u767B\u5F55 swsgbl;AtomGit \u672A\u88C5 \u2192 \u4E00\u884C\u5B89\u88C5\u6307\u5F15,\u65E0\u81EA\u52A8\u5B89\u88C5)", async () => {
      await js(`(function(){ var t=[].slice.call(document.querySelectorAll('.dock-tab')).find(function(x){return x.textContent==='\u4ED3\u5E93'||x.textContent==='Repos';}); if(t) t.click(); })()`);
      return waitFor("forge host cards", `var pane=document.querySelector('[data-testid="forge-pane"]');
        if(!pane) return {ok:false, detail:'no pane'};
        var gh=document.querySelector('[data-testid="forge-host-github"]');
        var ag=document.querySelector('[data-testid="forge-host-atomgit"]');
        var ghOk = !!gh && gh.textContent.indexOf('swsgbl')>=0 && (gh.textContent.indexOf('\u5DF2\u767B\u5F55')>=0 || gh.textContent.indexOf('Signed in')>=0);
        // \u672A\u88C5 CLI:\u6307\u5F15\u6587\u6848\u542B CLI \u540D + \u65E0\u767B\u5F55\u6309\u94AE(\u4E0D\u81EA\u52A8\u88C5,\u53EA\u6307\u8DEF)
        var agHint = !!ag && (ag.textContent.indexOf('\u672A\u68C0\u6D4B\u5230')>=0 || ag.textContent.indexOf('CLI not detected')>=0);
        var agNoInstallBtn = !!ag && ag.querySelectorAll('button').length===0;
        return {ok: ghOk && agHint && agNoInstallBtn, detail: 'gh='+(gh?gh.textContent.replace(/\\s+/g,' ').slice(0,44):'none')+' | ag='+(ag?ag.textContent.replace(/\\s+/g,' ').slice(0,44):'none')};`, 6e3);
    });
    await step("\u4ED3\u5E93:\u6211\u7684\u4ED3\u5E93\u5217\u8868 + \u884C\u5185\u4E09\u52A8\u4F5C(\u514B\u9686/\u6D4F\u89C8\u5668/\u8BA9 hmh \u5904\u7406),\u70B9\u51FB\u8FDB\u4ED3\u5E93\u8BE6\u60C5", async () => {
      const w = await waitFor("repo rows", `var rows=document.querySelectorAll('[data-testid="forge-repo-row"]').length;
        return {ok: rows>=1, detail: 'rows='+rows};`, 6e3);
      if (!w[0]) return w;
      const acts = await js(`(function(){ var r=document.querySelector('[data-testid="forge-repo-row"]');
        return JSON.stringify(r?[].slice.call(r.querySelectorAll('.forge-actions button')).map(function(b){return b.textContent;}):[]); })()`);
      const hasClone = acts.indexOf("\u514B\u9686") >= 0 || acts.indexOf("Clone") >= 0;
      const hasAsk = acts.indexOf("hmh") >= 0;
      await js(`(function(){ var r=document.querySelector('[data-testid="forge-repo-row"] .forge-main'); if(r) r.click(); })()`);
      const w2 = await waitFor("repo detail", `var pane=document.querySelector('[data-testid="forge-pane"]');
        var t = pane ? pane.textContent : '';
        return {ok: !!pane && t.indexOf('PR')>=0 && t.indexOf('Release')>=0, detail: t.replace(/\\s+/g,' ').slice(0,60)};`, 6e3);
      return [w2[0] && hasClone && hasAsk, `${w2[1]}; \u52A8\u4F5C=${acts.slice(0, 60)}`];
    });
    await step("\u4ED3\u5E93:PR \u5217\u8868\u70B9\u5408\u5E76 \u2192 \u786E\u8BA4\u5361\u51FA\u73B0(\u5408\u5E76\u65B9\u5F0F\u9ED8\u8BA4 squash)\u2192 \u53D6\u6D88\u4E0D\u771F\u53D1", async () => {
      const w = await waitFor("pr rows", `var rows=document.querySelectorAll('[data-testid="forge-pr-row"]').length;
        return {ok: rows>=1, detail: 'pr rows='+rows};`, 6e3);
      if (!w[0]) return w;
      await js(`(function(){ var r=document.querySelector('[data-testid="forge-pr-row"]');
        var b=[].slice.call(r.querySelectorAll('button')).find(function(x){return x.textContent.indexOf('\u5408\u5E76')>=0||x.textContent.indexOf('Merge')>=0;});
        if(b) b.click(); })()`);
      const w2 = await waitFor("merge confirm card", `var c=document.querySelector('[data-testid="forge-merge-confirm"]');
        var radio = c ? c.querySelector('input[type=radio]:checked') : null;
        return {ok: !!c && !!radio, detail: c ? '\u786E\u8BA4\u5361+\u65B9\u5F0F\u5355\u9009('+radio.value+')' : 'no card'};`, 5e3);
      if (!w2[0]) return w2;
      await js(`(function(){ var c=document.querySelector('[data-testid="forge-merge-confirm"]');
        var b=[].slice.call(c.querySelectorAll('button')).find(function(x){return x.textContent.indexOf('\u53D6\u6D88')>=0||x.textContent.indexOf('Cancel')>=0;});
        if(b) b.click(); })()`);
      return waitFor("confirm dismissed", `return {ok: !document.querySelector('[data-testid="forge-merge-confirm"]'), detail:'closed'};`, 5e3);
    });
    await step("\u4ED3\u5E93:Release \u533A\u5C55\u793A\u7248\u672C\u5217\u8868(fixture \u542B v0.2.10)+ \u65B0\u5EFA\u8868\u5355\u5F39\u5C42(tag \u5FC5\u586B\u95E8)", async () => {
      const w = await waitFor("release rows", `var rows=[].slice.call(document.querySelectorAll('[data-testid="forge-release-row"]'));
        var has = rows.some(function(x){return x.textContent.indexOf('v0.2.10')>=0;});
        return {ok: rows.length>=1 && has, detail: 'rows='+rows.length+(has?' \u542Bv0.2.10':' \u65E0v0.2.10')};`, 6e3);
      if (!w[0]) return w;
      await js(`(function(){ var pane=document.querySelector('[data-testid="forge-pane"]');
        var b=[].slice.call(pane.querySelectorAll('button')).find(function(x){return x.textContent.indexOf('\u53D1\u5E03\u65B0\u7248\u672C')>=0||x.textContent.indexOf('New release')>=0;});
        if(b) b.click(); })()`);
      const w2 = await waitFor("release form", `var f=document.querySelector('[data-testid="forge-form"]');
        var submit = f ? [].slice.call(f.querySelectorAll('button')).pop() : null;
        return {ok: !!f && !!submit && submit.disabled===true, detail: f ? '\u8868\u5355\u51FA\u73B0,\u7A7A tag \u65F6\u63D0\u4EA4\u7981\u7528' : 'no form'};`, 5e3);
      if (!w2[0]) return w2;
      await js(`(function(){ var f=document.querySelector('[data-testid="forge-form"]'); var x=[].slice.call(f.querySelectorAll('button')).find(function(b){return b.textContent==='\u2715';}); if(x) x.click(); })()`);
      return waitFor("form closed", `return {ok: !document.querySelector('[data-testid="forge-form"]'), detail:'closed'};`, 5e3);
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
function cmpSemver(a, b2) {
  const pa = a.replace(/^v/, "").split("-")[0].split(".").map(Number);
  const pb = b2.replace(/^v/, "").split("-")[0].split(".").map(Number);
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
  const s2 = spec.trim();
  const tag = s2 === "" || s2 === "latest" || s2 === "*" ? doc["dist-tags"]?.latest : void 0;
  if (tag !== void 0 && doc.versions[tag] !== void 0) return tag;
  if (doc.versions[s2] !== void 0) return s2;
  let best = "";
  for (const v of Object.keys(doc.versions)) {
    if (satisfies(s2, v) && cmpSemver(v, best) > 0) best = v;
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
  const ok2 = await new Promise((resolve2) => {
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
  host.log(`npm ${ok2 ? "available" : "unavailable"} \u2192 ${ok2 ? "npm prefix" : "tgz"} path`);
  return ok2;
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
          const b2 = Buffer.from(value);
          chunks.push(b2);
          got += b2.length;
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
  const s2 = normalizeChannel(sticky);
  const first = s2 === null ? void 0 : CHECK_CHANNELS.find((c) => c.id === s2);
  if (first === void 0) return CHECK_CHANNELS;
  return [first, ...CHECK_CHANNELS.filter((c) => c.id !== s2)];
}
function orderedDownloadMirrors(assetUrl, channel) {
  const hit = normalizeChannel(channel);
  const prefix = hit === null ? "" : CHECK_CHANNELS.find((c) => c.id === hit)?.downloadPrefix ?? "";
  const prefixes = [.../* @__PURE__ */ new Set([prefix, ...DOWNLOAD_MIRROR_PREFIXES])];
  return prefixes.map((p) => p === "" ? assetUrl : `${p}${assetUrl}`);
}
function cmpVersion(a, b2) {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b2.replace(/^v/, "").split(".").map(Number);
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

// apps/desktop/electron/main/forge.ts
import { spawn as spawn3, execFileSync } from "node:child_process";
import { existsSync as existsSync2, readFileSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { isAbsolute, join as join4, dirname, sep } from "node:path";
var CLI_BIN = { github: "gh", atomgit: "ag" };
var HOSTS = ["github", "atomgit"];
var REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
var CMD_TIMEOUT_MS = 6e4;
var LOGIN_TIMEOUT_MS = 18e4;
var LIST_LIMIT = 50;
var PAGE_SIZE = 20;
var defaultDeps = {
  run: (cmd, args, timeoutMs, onLine) => new Promise((resolve2) => {
    const r = resolveCli(cmd);
    const child = spawn3(r.bin, [...r.prefix, ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      const text = d.toString();
      out = (out + text).slice(-2e5);
      if (onLine !== void 0) {
        for (const line of text.split(/\r?\n/)) if (line.trim() !== "") onLine(line);
      }
    });
    child.stderr.on("data", (d) => {
      err = (err + d.toString()).slice(-6e4);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve2({ code: -1, stdout: out, stderr: `${err}${String(e)}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve2({ code: code ?? -1, stdout: out, stderr: err, timedOut });
    });
  }),
  which: (cmd) => {
    try {
      const out = execFileSync("where", [cmd], { encoding: "utf8", timeout: 4e3, windowsHide: true });
      return (out.split(/\r?\n/).find((l) => l.trim() !== "") ?? "").trim();
    } catch {
      return "";
    }
  }
};
function whereLines(cmd) {
  try {
    const out = execFileSync("where", [cmd], { encoding: "utf8", timeout: 4e3, windowsHide: true });
    return out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  } catch {
    return [];
  }
}
function resolveCli(cmd) {
  const lines = whereLines(cmd);
  const exe = lines.find((l) => /\.exe$/i.test(l));
  if (exe !== void 0) return { bin: exe, prefix: [] };
  const shim = lines.find((l) => /\.(cmd|bat)$/i.test(l)) ?? lines[0];
  if (shim === void 0) return { bin: cmd, prefix: [] };
  try {
    const text = readFileSync(shim, "utf8");
    const m = text.match(/node_modules[\\/][\w@.\-\\/]+?\.(?:js|mjs|cjs)/i);
    if (m !== null) {
      const js = join4(dirname(shim), m[0].replace(/\//g, sep));
      if (existsSync2(js)) {
        const nodeExe = whereLines("node").find((l) => /\.exe$/i.test(l)) ?? "node";
        return { bin: nodeExe, prefix: [js] };
      }
    }
  } catch {
  }
  return { bin: shim, prefix: [] };
}
function checkHost(host) {
  return host === "github" || host === "atomgit" ? host : null;
}
function checkRepo(repo) {
  return typeof repo === "string" && REPO_RE.test(repo) && repo.length <= 140 ? repo : null;
}
function checkState(state) {
  return state === "closed" || state === "all" ? state : "open";
}
function checkStr(v, max) {
  return typeof v === "string" ? v.slice(0, max) : "";
}
function extractUrl(text) {
  const m = text.match(/https:\/\/[^\s'")\]]+/);
  return m === null ? "" : m[0].replace(/[.,;]+$/, "");
}
function parseAuthStatus(host, stdout, stderr, code) {
  const text = `${stdout}
${stderr}`;
  const m = text.match(host === "github" ? /Logged in to github\.com account (\S+)/ : /Logged in to atomgit\.com as (\S+)/);
  if (m !== null) return { installed: true, logged: true, user: (m[1] ?? "").replace(/[()]/g, "") };
  return { installed: true, logged: false, user: "", ...code === -1 && /ENOENT|spawn/i.test(text) ? { installed: false } : {} };
}
var s = (v) => typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
var b = (v, dflt = false) => typeof v === "boolean" ? v : dflt;
function normalizeRepos(host, rows) {
  return rows.map((r) => {
    const name = s(r.name);
    const fullName = s(r.nameWithOwner) || s(r.fullName) || name;
    return {
      name,
      fullName,
      isPrivate: host === "github" ? b(r.isPrivate) : s(r.visibility) === "private",
      updatedAt: s(r.updatedAt),
      url: s(r.url) || (host === "github" ? `https://github.com/${fullName}` : `https://atomgit.com/${fullName}`),
      description: s(r.description)
    };
  });
}
function normalizePrs(rows) {
  return rows.map((r) => ({
    number: s(r.number),
    title: s(r.title),
    state: s(r.state).toLowerCase() || "open",
    isDraft: b(r.isDraft) || b(r.draft),
    updatedAt: s(r.updatedAt),
    url: s(r.url)
  }));
}
function normalizeIssues(rows) {
  return rows.map((r) => ({
    number: s(r.number),
    title: s(r.title),
    state: s(r.state).toLowerCase() || "open",
    updatedAt: s(r.updatedAt),
    url: s(r.url)
  }));
}
function normalizeReleases(host, rows) {
  return rows.map((r) => ({
    tag: s(host === "github" ? r.tagName : r.tag),
    name: s(r.name),
    createdAt: s(r.createdAt),
    isDraft: b(r.isDraft) || b(r.draft),
    isPrerelease: b(r.isPrerelease) || b(r.prerelease)
  }));
}
function buildListArgs(kind, host, repo, state) {
  if (kind === "repos") {
    return host === "github" ? ["repo", "list", "--limit", String(LIST_LIMIT), "--json", "name,nameWithOwner,isPrivate,updatedAt,url,description"] : ["repo", "list", "--limit", String(LIST_LIMIT), "--json"];
  }
  if (host === "github") {
    const base2 = kind === "prs" ? "pr" : kind === "issues" ? "issue" : "release";
    if (kind === "releases") return ["release", "list", "--repo", repo, "--limit", String(LIST_LIMIT), "--json", "tagName,name,createdAt,isDraft,isPrerelease"];
    const fields = kind === "prs" ? "number,title,state,isDraft,updatedAt,url" : "number,title,state,updatedAt,url";
    return [base2, "list", "--repo", repo, "--state", state, "--limit", String(LIST_LIMIT), "--json", fields];
  }
  if (kind === "releases") return ["release", "list", repo, "--json", "--limit", String(LIST_LIMIT)];
  const base = kind === "prs" ? "pr" : "issue";
  return [base, "list", repo, "--state", state, "--json", "--limit", String(LIST_LIMIT)];
}
function buildActionArgs(kind, host, a) {
  const R = (v) => host === "github" ? ["--repo", v ?? ""] : [v ?? ""];
  if (kind === "pr_create") {
    const title = checkStr(a.title, 300);
    const body = checkStr(a.body, 2e4);
    const base = checkStr(a.base, 200);
    const head = checkStr(a.head, 200);
    if (title === "") return null;
    const args = host === "github" ? ["pr", "create", "--repo", a.repo, "--title", title, "--body", body] : ["pr", "create", a.repo, "--title", title, "--body", body];
    if (base !== "") args.push("--base", base);
    if (head !== "") args.push("--head", head);
    return args;
  }
  if (kind === "pr_merge") {
    const num = checkStr(a.number, 20).replace(/[^0-9]/g, "");
    if (num === "") return null;
    const squash = a.method !== "merge";
    return host === "github" ? ["pr", "merge", "--repo", a.repo, num, squash ? "--squash" : "--merge"] : ["pr", "merge", a.repo, num, squash ? "--squash" : "--merge"];
  }
  if (kind === "issue_create") {
    const title = checkStr(a.title, 300);
    const body = checkStr(a.body, 2e4);
    if (title === "") return null;
    return host === "github" ? ["issue", "create", "--repo", a.repo, "--title", title, "--body", body] : ["issue", "create", a.repo, "--title", title, "--body", body];
  }
  if (kind === "release_create") {
    const tag = checkStr(a.tag, 120);
    const name = checkStr(a.name, 300);
    const notes = checkStr(a.notes, 6e4) || tag;
    if (!/^[A-Za-z0-9_.-]+$/.test(tag)) return null;
    return host === "github" ? ["release", "create", tag, "--repo", a.repo, "--title", name || tag, "--notes", notes, ...a.prerelease === true ? ["--prerelease"] : []] : ["release", "create", a.repo, tag, "--name", name || tag, "--body", notes, ...a.prerelease === true ? ["--prerelease"] : []];
  }
  if (kind === "release_upload") {
    const tag = checkStr(a.tag, 120);
    const file = checkStr(a.file, 1e3);
    if (!/^[A-Za-z0-9_.-]+$/.test(tag) || file === "") return null;
    return host === "github" ? ["release", "upload", tag, file, "--repo", a.repo] : ["release", "upload", a.repo, tag, file];
  }
  const dir = checkStr(a.dir, 1e3);
  if (dir === "") return null;
  return ["repo", "clone", a.repo, dir];
}
function validateLocalPath(p, allowedRoots) {
  if (!isAbsolute(p)) return false;
  const home = homedir2();
  const under = (root) => {
    try {
      const r = join4(root, "");
      return p === r || p.startsWith(`${r}${sep}`);
    } catch {
      return false;
    }
  };
  if (under(home)) return true;
  return allowedRoots.some(under);
}
function resolveRepoOf(path) {
  try {
    const cfg = readFileSync(join4(path, ".git", "config"), "utf8");
    const urls = [...cfg.matchAll(/url\s*=\s*(\S+)/g)].map((m) => m[1] ?? "");
    for (const u of urls) {
      const gh = u.match(/(?:github\.com[/:])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/i);
      if (gh !== null && (gh[1] ?? "") !== "") return { host: "github", repo: gh[1] ?? "" };
      const ag = u.match(/(?:atomgit\.com[/:])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/i);
      if (ag !== null && (ag[1] ?? "") !== "") return { host: "atomgit", repo: ag[1] ?? "" };
    }
    return null;
  } catch {
    return null;
  }
}
var bad = (code, error) => ({ ok: false, code, error: error.slice(0, 300) });
var ok = (data) => ({ ok: true, data });
function createForge(deps = defaultDeps, opts = {}) {
  const roots = () => (opts.allowedRoots?.() ?? []).filter((r) => typeof r === "string" && r !== "");
  async function cliJson(host, args, normalizer) {
    const r = await deps.run(CLI_BIN[host], args, CMD_TIMEOUT_MS);
    if (r.timedOut) return bad("TIMEOUT", `${CLI_BIN[host]} ${args[0]} \u8D85\u65F6(${Math.round(CMD_TIMEOUT_MS / 1e3)}s)`);
    if (r.code !== 0) return bad("CLI_ERROR", `${CLI_BIN[host]} ${args.slice(0, 3).join(" ")} \u5931\u8D25(${r.code}):${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")}`);
    try {
      const parsed = JSON.parse(r.stdout);
      if (!Array.isArray(parsed)) return bad("BAD_JSON", "CLI \u8F93\u51FA\u975E JSON \u6570\u7EC4");
      return ok(normalizer(parsed));
    } catch {
      return bad("BAD_JSON", "CLI \u8F93\u51FA\u65E0\u6CD5\u89E3\u6790\u4E3A JSON");
    }
  }
  return {
    async status() {
      const one = async (host) => {
        if (deps.which(CLI_BIN[host]) === "") return { installed: false, logged: false, user: "" };
        const r = await deps.run(CLI_BIN[host], ["auth", "status"], 15e3);
        return parseAuthStatus(host, r.stdout, r.stderr, r.code);
      };
      const [github, atomgit] = await Promise.all(HOSTS.map(one));
      return { github, atomgit };
    },
    repos: async (host, page) => cliJson(host, buildListArgs("repos", host, "", "open"), (rows) => {
      const all = normalizeRepos(host, rows);
      const p = Math.max(1, Math.min(20, page));
      return { repos: all.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE), hasMore: all.length > p * PAGE_SIZE };
    }),
    prs: (host, repo, state) => cliJson(host, buildListArgs("prs", host, repo, state), (rows) => ({ prs: normalizePrs(rows) })),
    issues: (host, repo, state) => cliJson(host, buildListArgs("issues", host, repo, state), (rows) => ({ issues: normalizeIssues(rows) })),
    releases: (host, repo) => cliJson(host, buildListArgs("releases", host, repo, "open"), (rows) => ({ releases: normalizeReleases(host, rows) })),
    async action(kind, host, a) {
      const args = buildActionArgs(kind, host, a);
      if (args === null) return bad("BAD_REQUEST", `\u5199\u64CD\u4F5C ${kind} \u53C2\u6570\u4E0D\u5408\u6CD5`);
      if ((kind === "release_upload" || kind === "repo_clone") && !validateLocalPath(a.file ?? a.dir ?? "", roots())) {
        return bad("BAD_REQUEST", "\u6587\u4EF6\u8DEF\u5F84\u5FC5\u987B\u4F4D\u4E8E\u7528\u6237\u76EE\u5F55\u6216\u5DF2\u6CE8\u518C\u5DE5\u4F5C\u533A\u5185");
      }
      const r = await deps.run(CLI_BIN[host], args.filter((x) => x !== ""), CMD_TIMEOUT_MS);
      if (r.timedOut) return bad("TIMEOUT", `${CLI_BIN[host]} ${kind} \u8D85\u65F6`);
      if (r.code !== 0) return bad("CLI_ERROR", `${kind} \u5931\u8D25(${r.code}):${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")}`);
      return ok({ url: extractUrl(`${r.stdout}
${r.stderr}`) });
    },
    /** 登录:spawn 官方 OAuth 流程,stdout 行转发 + URL 外开;不捕获任何令牌。 */
    async login(host) {
      const args = host === "github" ? ["auth", "login", "--web", "--git-protocol", "https", "--skip-ssh-key"] : ["auth", "login"];
      let opened = "";
      const r = await deps.run(CLI_BIN[host], args, LOGIN_TIMEOUT_MS, (line) => {
        opts.onLoginLine?.(host, line);
        const url = extractUrl(line);
        if (url !== "" && opened === "") {
          opened = url;
          opts.openExternal?.(url);
        }
      });
      if (r.timedOut) return bad("TIMEOUT", `\u767B\u5F55\u8D85\u65F6(${Math.round(LOGIN_TIMEOUT_MS / 6e4)} \u5206\u949F)`);
      return ok({ url: opened });
    },
    resolve(path) {
      const p = checkStr(path, 1e3);
      if (p === "" || !existsSync2(p)) return null;
      return resolveRepoOf(p);
    }
  };
}
function forgeFixtures() {
  return {
    status: {
      github: { installed: true, logged: true, user: "swsgbl" },
      // 无 CLI 指引态:atomgit 卡展示安装指引(单测断言"不自动装")
      atomgit: { installed: false, logged: false, user: "" }
    },
    repos: (host) => ({
      repos: host === "github" ? [
        { name: "hmh-desktop", fullName: "swsgbl/hmh-desktop", isPrivate: false, updatedAt: "2026-10-29T23:41:04Z", url: "https://github.com/swsgbl/hmh-desktop", description: "HMH Desktop(monorepo)" },
        { name: "ai-learning-os", fullName: "swsgbl/ai-learning-os", isPrivate: true, updatedAt: "2026-10-29T15:29:52Z", url: "https://github.com/swsgbl/ai-learning-os", description: "AI learning OS" }
      ] : [
        { name: "hmh-desktop", fullName: "hongfu/hmh-desktop", isPrivate: false, updatedAt: "2026-10-29T22:41:49+08:00", url: "https://atomgit.com/hongfu/hmh-desktop", description: "HMH Desktop(atomgit \u955C\u50CF\u4ED3)" }
      ],
      hasMore: false
    }),
    prs: { prs: [{ number: "11", title: "feat(desktop): \u4ED3\u5E93\u9762\u677F(\u9A8C\u6536 fixture)", state: "open", isDraft: false, updatedAt: "2026-10-30T09:00:00Z", url: "https://github.com/swsgbl/hmh-desktop/pull/11" }] },
    issues: { issues: [{ number: "4", title: "\u4ED3\u5E93\u9762\u677F\u9A8C\u6536 fixture issue", state: "open", updatedAt: "2026-10-30T09:00:00Z", url: "https://github.com/swsgbl/hmh-desktop/issues/4" }] },
    releases: { releases: [{ tag: "v0.2.10", name: "v0.2.10 \u2014 \u66F4\u65B0\u5668 atomgit \u56FD\u5185\u9996\u9009+\u540E\u53F0\u9759\u9ED8\u66F4\u65B0", createdAt: "2026-10-29T23:37:09+08:00", isDraft: false, isPrerelease: false }] },
    action: { ok: true, data: { url: "https://example.invalid/forge-fixture" } },
    login: { ok: true, data: { url: "https://example.invalid/forge-login-fixture" } },
    resolve: { host: "github", repo: "swsgbl/hmh-desktop" }
  };
}

// apps/desktop/electron/main/index.ts
var here = import.meta.dirname ?? ".";
var isDev = process.env.HMH_DESKTOP_DEV === "1";
var rendererDevUrl = process.env.HMH_DESKTOP_RENDERER_URL ?? "";
var preloadPath = join5(here, "../preload/index.cjs");
var secrets = [];
function redact(s2) {
  let out = s2;
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
    const installDir = dirname2(process.execPath);
    const child = spawn4(`"${installerPath}" /S /D=${installDir}`, {
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
    const candidates = process.platform === "win32" ? [join5(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "hmharness-web-daemon.cmd")] : process.platform === "darwin" ? [join5(home, "Library", "LaunchAgents", "hmharness-web-daemon.plist")] : [join5(home, ".config", "systemd", "user", "hmharness-web-daemon.service")];
    return candidates.some((p) => {
      try {
        return existsSync3(p);
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
      const p = join5(repoRootOf2(runtimeEntry), "packages", "cli", "src", "main.ts");
      if (existsSync3(p)) return p;
    } catch {
    }
    let dir = dirname2(runtimeEntry);
    for (let i = 0; i < 8; i++) {
      if (existsSync3(join5(dir, "dist", "main.js")) && pkgNameAt2(dir) === "@hmharness/cli") return join5(dir, "dist", "main.js");
      if (basename(dir) === "@hmharness" && existsSync3(join5(dir, "cli", "dist", "main.js"))) return join5(dir, "cli", "dist", "main.js");
      const parent = dirname2(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return "";
  }, runCli2 = function(args) {
    const entry = cliEntryOf2();
    if (entry === "") return;
    const isTs = entry.endsWith(".ts");
    const repo = repoRootOf2(runtimeEntry ?? entry);
    const child = spawn4(process.execPath, isTs ? ["--import", "tsx", entry, ...args] : [entry, ...args], {
      cwd: isTs ? repo : dirname2(entry),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ELECTRON_RUN_AS_NODE: "1" }
    });
    child.unref();
  }, broadcastHostState2 = function(s2, info) {
    bridge = { ...bridge, hostState: s2, hostPort: supervisor?.endpoint?.port ?? null, hostVersion: supervisor?.endpoint?.version ?? null };
    logInfo("host", `state=${s2}${info.lastError !== void 0 ? ` err=${info.lastError}` : ""}`);
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send("bridge:host-state", s2, info);
    }
  }, pkgVersionAt2 = function(dir) {
    try {
      const v = JSON.parse(readFileSync2(join5(dir, "package.json"), "utf8"));
      return typeof v.version === "string" ? v.version : "";
    } catch {
      return "";
    }
  }, pkgNameAt2 = function(dir) {
    try {
      const v = JSON.parse(readFileSync2(join5(dir, "package.json"), "utf8"));
      return typeof v.name === "string" ? v.name : "";
    } catch {
      return "";
    }
  }, entryFromCliDir2 = function(cliDir) {
    const nested = join5(cliDir, "node_modules", "@hmharness", "web", "dist", "desktop-host.js");
    if (existsSync3(nested)) return nested;
    const hoisted = join5(dirname2(cliDir), "web", "dist", "desktop-host.js");
    if (existsSync3(hoisted)) return hoisted;
    return "";
  }, detectExternalRuntime2 = function() {
    const envEntry = process.env.HMH_DESKTOP_REAL_ENTRY;
    if (envEntry !== void 0 && envEntry !== "" && isAbsolute2(envEntry)) {
      return { entry: envEntry, version: "", source: "env" };
    }
    const whereRepos = /* @__PURE__ */ new Set();
    const whereClis = [];
    const npmRepos = /* @__PURE__ */ new Set();
    let npmCli = "";
    try {
      const out = execFileSync2("where", ["hmh"], { encoding: "utf8", timeout: 4e3, windowsHide: true });
      for (const line of out.split(/\r?\n/)) {
        const bin = line.trim();
        if (bin === "") continue;
        try {
          const binDir = dirname2(bin);
          const linked = join5(binDir, "node_modules", "hmharness");
          if (existsSync3(linked)) whereRepos.add(realpathSync2(linked));
          const cli = join5(binDir, "node_modules", "@hmharness", "cli");
          if (existsSync3(cli)) whereClis.push(cli);
        } catch {
        }
      }
    } catch {
    }
    try {
      const out = execFileSync2("npm", ["root", "-g"], { encoding: "utf8", timeout: 6e3, windowsHide: true });
      const root = out.trim();
      const linked = join5(root, "hmharness");
      if (existsSync3(linked)) npmRepos.add(realpathSync2(linked));
      const cli = join5(root, "@hmharness", "cli");
      if (existsSync3(cli)) npmCli = cli;
    } catch {
    }
    for (const [cli, source] of [[whereClis[0] ?? "", "where-hmh"], [npmCli, "npm-global"]]) {
      if (cli === "") continue;
      const entry = entryFromCliDir2(cli);
      if (entry !== "") return { entry, version: pkgVersionAt2(cli), source };
    }
    const wizardEntry = resolveInstalledEntry(installTarget());
    if (wizardEntry !== "") {
      return { entry: wizardEntry, version: pkgVersionAt2(join5(installTarget(), "node_modules", "@hmharness", "cli")), source: "wizard-install" };
    }
    const repos = /* @__PURE__ */ new Set([...whereRepos, ...npmRepos]);
    const bases = ["C:\\", "D:\\", "E:\\", "F:\\", "G:\\", "H:\\", homedir3(), join5(homedir3(), "Developer")];
    for (const base of bases) {
      try {
        const p = resolve(base, "hmharness");
        if (existsSync3(p)) repos.add(p);
      } catch {
      }
    }
    for (const repo of repos) {
      const entry = join5(repo, "packages", "web", "src", "desktop-host.ts");
      if (existsSync3(entry) && existsSync3(join5(repo, "node_modules"))) {
        return { entry, version: pkgVersionAt2(repo), source: "source-repo" };
      }
    }
    return { entry: "", version: "", source: "" };
  }, detectRealEntry2 = function() {
    return detectExternalRuntime2().entry;
  }, repoRootOf2 = function(entry) {
    let dir = dirname2(entry);
    for (let i = 0; i < 6; i++) {
      if (existsSync3(join5(dir, "package.json")) && existsSync3(join5(dir, "packages", "web"))) return dir;
      const parent = dirname2(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return dirname2(entry);
  }, bundledRuntimePath2 = function(repoRoot) {
    return join5(app3.isPackaged ? process.resourcesPath : join5(repoRoot, "apps", "desktop", "resources"), "runtime", "runtime.cjs");
  }, bundledRuntimeInfo2 = function() {
    const repoRoot = join5(here, "..", "..", "..", "..");
    const p = bundledRuntimePath2(repoRoot);
    let version = "";
    try {
      const v = JSON.parse(readFileSync2(join5(dirname2(p), "package.json"), "utf8"));
      version = typeof v.version === "string" ? v.version : "";
    } catch {
    }
    return { ready: existsSync3(p), version };
  }, npmOnPath2 = function() {
    try {
      execFileSync2("where", ["npm"], { encoding: "utf8", timeout: 4e3, windowsHide: true });
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
  }, forgeSvc2 = function() {
    if (process.env.HMH_DESKTOP_UIVERIFY === "1" && !forgeFixtureOff) return fixtureForge;
    if (realForge === null) {
      realForge = createForge(void 0, {
        allowedRoots: () => wsRootsCache,
        onLoginLine: (host, line) => {
          logInfo("forge", `${host} login: ${line.slice(0, 160)}`);
          for (const w of BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed()) w.webContents.send("forge:login-line", host, line);
          }
        },
        openExternal: (url) => {
          void shell.openExternal(url);
        }
      });
    }
    return realForge;
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
      if (e !== "" && (!isAbsolute2(e) || !existsSync3(e))) {
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
      const repoRoot = join5(here, "..", "..", "..", "..");
      if (c === "external" || c === "bundled") {
        const target = c === "bundled" ? bundledRuntimePath2(repoRoot) : e;
        if (target === "" || !isAbsolute2(target) || !existsSync3(target)) {
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
    ipcMain.handle("bridge:workspaces", (event) => hostCall2(event, async (c) => {
      const r = await c.getJson("/api/workspaces");
      wsRootsCache = r.items.map((w) => w.path);
      return r;
    }));
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
    const forgeErr = (event, fn) => {
      if (!senderTrusted2(event.senderFrame)) return Promise.resolve({ error: "untrusted sender", code: "FORBIDDEN" });
      return fn().catch((err) => ({ ok: false, code: "BRIDGE_ERROR", error: String(err).slice(0, 300) }));
    };
    ipcMain.handle("forge:status", (event) => forgeErr(event, () => forgeSvc2().status()));
    ipcMain.handle("forge:login", (event, h) => {
      const host = checkHost(h);
      if (host === null) return Promise.resolve({ ok: false, code: "BAD_REQUEST", error: "host must be github|atomgit" });
      return forgeErr(event, () => forgeSvc2().login(host));
    });
    ipcMain.handle("forge:repos", (event, h, page) => {
      const host = checkHost(h);
      const p = typeof page === "number" && Number.isFinite(page) ? Math.floor(page) : 1;
      if (host === null) return Promise.resolve({ ok: false, code: "BAD_REQUEST", error: "host must be github|atomgit" });
      return forgeErr(event, () => forgeSvc2().repos(host, p));
    });
    const repoArgs = (h, repo) => {
      const host = checkHost(h);
      const r = checkRepo(repo);
      if (host === null || r === null) return { bad: "host must be github|atomgit, repo must be owner/name" };
      return { host, repo: r };
    };
    ipcMain.handle("forge:prs", (event, h, repo, state) => {
      const a = repoArgs(h, repo);
      if ("bad" in a) return Promise.resolve({ ok: false, code: "BAD_REQUEST", error: a.bad });
      return forgeErr(event, () => forgeSvc2().prs(a.host, a.repo, checkState(state)));
    });
    ipcMain.handle("forge:issues", (event, h, repo, state) => {
      const a = repoArgs(h, repo);
      if ("bad" in a) return Promise.resolve({ ok: false, code: "BAD_REQUEST", error: a.bad });
      return forgeErr(event, () => forgeSvc2().issues(a.host, a.repo, checkState(state)));
    });
    ipcMain.handle("forge:releases", (event, h, repo) => {
      const a = repoArgs(h, repo);
      if ("bad" in a) return Promise.resolve({ ok: false, code: "BAD_REQUEST", error: a.bad });
      return forgeErr(event, () => forgeSvc2().releases(a.host, a.repo));
    });
    const ACTION_KINDS = ["pr_create", "pr_merge", "issue_create", "release_create", "release_upload", "repo_clone"];
    ipcMain.handle("forge:action", (event, k, h, args) => {
      const kind = ACTION_KINDS.find((x) => x === k);
      const a = repoArgs(h, args?.repo);
      if (kind === void 0 || "bad" in a) return Promise.resolve({ ok: false, code: "BAD_REQUEST", error: "kind/host/repo \u6821\u9A8C\u5931\u8D25" });
      const raw = args ?? {};
      const pas = (v, max) => typeof v === "string" ? v.slice(0, max) : "";
      const fa = {
        repo: a.repo,
        number: pas(raw.number, 20),
        title: pas(raw.title, 300),
        body: pas(raw.body, 2e4),
        base: pas(raw.base, 200),
        head: pas(raw.head, 200),
        tag: pas(raw.tag, 120),
        name: pas(raw.name, 300),
        notes: pas(raw.notes, 6e4),
        file: pas(raw.file, 1e3),
        dir: pas(raw.dir, 1e3),
        method: pas(raw.method, 10),
        prerelease: raw.prerelease === true
      };
      return forgeErr(event, () => forgeSvc2().action(kind, a.host, fa));
    });
    ipcMain.handle("forge:open", (event, url) => {
      if (!senderTrusted2(event.senderFrame)) return { error: "untrusted sender", code: "FORBIDDEN" };
      const u = typeof url === "string" ? url.slice(0, 2e3) : "";
      if (!/^https:\/\/([a-z0-9-]+\.)*(github\.com|atomgit\.com)\//.test(u)) {
        return { ok: false, code: "BAD_REQUEST", error: "\u4EC5 github.com / atomgit.com \u94FE\u63A5\u53EF\u6253\u5F00" };
      }
      if (process.env.HMH_DESKTOP_UIVERIFY === "1" && !forgeFixtureOff) return { ok: true };
      void shell.openExternal(u);
      return { ok: true };
    });
    ipcMain.handle("forge:resolve", (event, p) => {
      if (!senderTrusted2(event.senderFrame)) return { error: "untrusted sender", code: "FORBIDDEN" };
      if (process.env.HMH_DESKTOP_UIVERIFY === "1" && !forgeFixtureOff) return forgeFixtures().resolve;
      const path = typeof p === "string" ? p.slice(0, 1e3) : "";
      return forgeSvc2().resolve(path);
    });
  };
  pushEvent = pushEvent2, focusMainWindow = focusMainWindow2, setupTray = setupTray2, notifyEvent = notifyEvent2, applyChrome = applyChrome2, applyUpdate = applyUpdate2, buildAppMenu = buildAppMenu2, popupMainMenu = popupMainMenu2, webAutostartInstalled = webAutostartInstalled2, lanIpOf = lanIpOf2, cliEntryOf = cliEntryOf2, runCli = runCli2, broadcastHostState = broadcastHostState2, pkgVersionAt = pkgVersionAt2, pkgNameAt = pkgNameAt2, entryFromCliDir = entryFromCliDir2, detectExternalRuntime = detectExternalRuntime2, detectRealEntry = detectRealEntry2, repoRootOf = repoRootOf2, bundledRuntimePath = bundledRuntimePath2, bundledRuntimeInfo = bundledRuntimeInfo2, npmOnPath = npmOnPath2, wizardSuppressed = wizardSuppressed2, senderTrusted = senderTrusted2, hostCall = hostCall2, forgeSvc = forgeSvc2, registerIpc = registerIpc2;
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
  const updateChannelFile = () => join5(app3.getPath("userData"), "update-channel.json");
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
      const dest = join5(app3.getPath("temp"), asset.name);
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
  const runtimeConfigFile = () => join5(app3.getPath("userData"), "runtime.json");
  async function loadRuntimeConfig() {
    try {
      const v = JSON.parse(await readFile(runtimeConfigFile(), "utf8"));
      return {
        entry: typeof v.entry === "string" && v.entry !== "" && isAbsolute2(v.entry) ? v.entry : "",
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
  const wizardFile = () => join5(app3.getPath("userData"), "wizard.json");
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
    const repoRoot = join5(here, "..", "..", "..", "..");
    const packaged = app3.isPackaged;
    const cfg = await loadRuntimeConfig();
    const forceFake = process.env.HMH_DESKTOP_FAKE === "1" || cfg.demo;
    const forceBundled = process.env.HMH_DESKTOP_BUNDLED === "1";
    const override = cfg.entry;
    const adjacent = join5(repoRoot, "..", "hmharness", "packages", "web", "src", "desktop-host.ts");
    const bundled = bundledRuntimePath2(repoRoot);
    const bundledReady = existsSync3(bundled);
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
      entry = packaged ? detectRealEntry2() : existsSync3(adjacent) ? adjacent : detectRealEntry2();
      if (entry === "" && bundledReady) {
        entry = bundled;
        useBundledRuntime = true;
      }
    }
    runtimeEntry = entry;
    const useReal = entry !== "" && (useBundledRuntime || existsSync3(entry));
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
        cwd: dirname2(entry),
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
        args: [join5(process.resourcesPath, "fake-host.cjs")],
        env: { ELECTRON_RUN_AS_NODE: "1" }
      };
    } else {
      spec = {
        command: process.execPath,
        // 直接走包真实路径(node_modules 里的 workspace junction 会被 ESM
        // realpath 化,导致 fake-host 的 argv[1]/import.meta.url 匹配失效)
        args: ["--import", "tsx", join5(repoRoot, "packages", "host-adapter", "src", "fake-host.ts")],
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
    isDev && rendererDevUrl ? [rendererDevUrl] : [pathToFileURL2(join5(here, "..", "..", "dist-renderer", "index.html")).href]
  );
  let wsRootsCache = [];
  let realForge = null;
  const forgeFixtureOff = process.env.HMH_DESKTOP_UIVERIFY_FORGE === "real";
  const fixtureForge = (() => {
    const f = forgeFixtures();
    return {
      status: async () => f.status,
      repos: async (host) => ({ ok: true, data: f.repos(host) }),
      prs: async () => ({ ok: true, data: f.prs }),
      issues: async () => ({ ok: true, data: f.issues }),
      releases: async () => ({ ok: true, data: f.releases }),
      action: async () => f.action,
      login: async () => f.login,
      resolve: () => f.resolve
    };
  })();
  const windowStateFile = () => join5(app3.getPath("userData"), "window-state.json");
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
      const ok2 = [...allowedOrigins].some((o) => url === o || url.startsWith(`${o}/`) || url.startsWith(`${o}?`));
      if (!ok2) {
        logInfo("nav", `blocked navigation to ${url.slice(0, 120)}`);
        e.preventDefault();
      }
    });
    if (isDev && rendererDevUrl) {
      void win.loadURL(rendererDevUrl);
    } else {
      void win.loadFile(join5(here, "..", "..", "dist-renderer", "index.html"));
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
                const ok2 = n > 0;
                console.log(`RENDER-TEST ${ok2 ? "ok" : "EMPTY"} rootChildren=${n}`);
                app3.exit(ok2 ? 0 : 1);
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
        const [ok2, detail] = await probe();
        results.push([name, ok2, detail]);
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
      const allow = ["applyUpdate", "approve", "approvalGet", "approvalSet", "browseRuntime", "checkUpdate", "chromeTheme", "cognitive", "detectRuntime", "diff", "exportSession", "forgeAction", "forgeIssues", "forgeLogin", "forgeOpen", "forgePrs", "forgeReleases", "forgeRepos", "forgeResolve", "forgeStatus", "fsList", "fsRead", "fsSearch", "getState", "getWizard", "inject", "installCli", "interrupt", "modelSet", "onEventBatches", "onForgeLoginOutput", "onHostState", "onInstallProgress", "onMenuAction", "onStreamChunks", "onUpdateState", "pickDirectory", "pickFiles", "popupMainMenu", "providerSave", "providers", "remoteWebAutostart", "remoteWebStart", "remoteWebStatus", "remoteWebStop", "runtimeInfo", "sendTask", "sessionOp", "sessionPreview", "sessions", "setRuntime", "stopHost", "wizardComplete", "workspaces", "workspaceAdd", "workspaceUse"];
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
    for (const [name, ok2, detail] of results) {
      console.log(`SECURITY-TEST ${ok2 ? "PASS" : "FAIL"} | ${name} | ${redact(detail)}`);
      if (!ok2) failed += 1;
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
var forgeSvc;
var registerIpc;
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vZWxlY3Ryb24vbWFpbi9pbmRleC50cyIsICIuLi8uLi8uLi8uLi9wYWNrYWdlcy9ob3N0LWFkYXB0ZXIvc3JjL3N1cGVydmlzb3IudHMiLCAiLi4vLi4vLi4vLi4vcGFja2FnZXMvY29udHJhY3RzL3NyYy9ldmVudC50cyIsICIuLi8uLi8uLi8uLi9wYWNrYWdlcy9jb250cmFjdHMvc3JjL2Vycm9yLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2NvbnRyYWN0cy9zcmMvZ3VhcmRzLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2hvc3QtYWRhcHRlci9zcmMvY2xpZW50LnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2hvc3QtYWRhcHRlci9zcmMvZmFrZS1ob3N0LnRzIiwgIi4uLy4uL2VsZWN0cm9uL21haW4vdWl2ZXJpZnkudHMiLCAiLi4vLi4vZWxlY3Ryb24vbWFpbi92aXN1YWxyZWdyZXNzaW9uLnRzIiwgIi4uLy4uL2VsZWN0cm9uL21haW4vaW5zdGFsbGVyLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2NsaS1pbnN0YWxsZXIvc3JjL2luZGV4LnRzIiwgIi4uLy4uL2VsZWN0cm9uL21haW4vdXBkYXRlci1jaGFubmVscy50cyIsICIuLi8uLi9lbGVjdHJvbi9tYWluL2ZvcmdlLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcclxuICogSE1IIERlc2t0b3AgXHUyMDE0IEVsZWN0cm9uIFx1NEUzQlx1OEZEQlx1N0EwQihBRFItMDAxLzAwMy8wMDQpXHUzMDAyXHJcbiAqXHJcbiAqIFx1NUI4OVx1NTE2OFx1NEUwRFx1NTNEOFx1OTFDRihcdTVGMDBcdTUzRDFcdThCQTFcdTUyMTIgTTAgXHU1MUZBXHU1M0UzXHU5NUU4ICsgRWxlY3Ryb24gXHU1Qjk4XHU2NUI5XHU1Qjg5XHU1MTY4XHU2RTA1XHU1MzU1KTpcclxuICogIC0gcmVuZGVyZXI6Y29udGV4dElzb2xhdGlvbiArIHNhbmRib3ggKyBcdTc5ODEgbm9kZUludGVncmF0aW9uLFx1NEUyNVx1NjgzQyBDU1A7XHJcbiAqICAtIFx1NUJGQ1x1ODIyQS9cdTY1QjBcdTdBOTdcdTUzRTNcdTRFMDBcdTVGOEJcdTYyRDJcdTdFREQoXHU1M0VBXHU1MkEwXHU4RjdEXHU2MjExXHU0RUVDXHU4MUVBXHU1REYxXHU3Njg0IHJlbmRlcmVyKTtcclxuICogIC0gXHU2QkNGXHU2NzYxIElQQyBcdTY4MjFcdTlBOEMgc2VuZGVyIFx1NzY4NFx1OTg3Nlx1NUM0MiBmcmFtZSBVUkwgXHU1QzVFXHU0RThFXHU2NzJDXHU1RTk0XHU3NTI4LFx1OTAxQVx1OTA1M1x1NzY3RFx1NTQwRFx1NTM1NTtcclxuICogIC0gaG9zdCB0b2tlbiBcdTUzRUFcdTVCNThcdTU3MjhcdTRFOEVcdTY3MkNcdThGREJcdTdBMEJcdTRFMEVcdTVCNTBcdThGREJcdTdBMEIgZW52LFx1NjVFNVx1NUZEN1x1OEY5M1x1NTFGQVx1NTI0RFx1NTE0OFx1ODEzMVx1NjU0RjtcclxuICogIC0gXHU1MzU1XHU1QjlFXHU0RjhCXHU5NTAxO1x1OTAwMFx1NTFGQVx1NjVGNlx1NTNFQVx1NTA1Q1x1NkI2Mlx1ODFFQVx1NURGMSBzcGF3biBcdTc2ODQgaG9zdChcdTRGMThcdTk2QzVcdTIxOTJcdTUxNUNcdTVFOTUga2lsbClcdTMwMDJcclxuICpcclxuICogXHU5NjM2XHU2QkI1RSgyMDI2LTEwLTEwKTptYWluIFx1NjMwMVx1NjcwOSBEZXNrdG9wSG9zdENsaWVudCxTU0UgXHU0RkUxXHU1QzAxXHU2RDQxKGV2ZW50OiBobWgpXHJcbiAqIFx1N0VDRiA1MG1zIFx1NjI3OVx1OTFDRlx1NjNBOFx1N0VEOSByZW5kZXJlcjtzZW5kVGFzay9hcHByb3ZlL2ludGVycnVwdC9zZXNzaW9ucyBcdTUxNjhcdTkwRThcdThGNkNcdTUzRDFcclxuICogXHU3RUQ5IGhvc3QgXHUyMDE0XHUyMDE0IGZha2UgXHU0RTBFXHU3NzFGXHU1QjlFIGhtaGFybmVzcyBkZXNrdG9wLWhvc3QgXHU4RDcwXHU1NDBDXHU0RTAwXHU2NzYxXHU0RUUzXHU3ODAxXHU4REVGXHU1Rjg0XHUzMDAyXHJcbiAqL1xyXG5pbXBvcnQgeyBhcHAsIEJyb3dzZXJXaW5kb3csIGRpYWxvZywgaXBjTWFpbiwgc2Vzc2lvbiwgc2hlbGwsIFRyYXksIE5vdGlmaWNhdGlvbiwgTWVudSwgbmF0aXZlSW1hZ2UsIG5hdGl2ZVRoZW1lIH0gZnJvbSAnZWxlY3Ryb24nO1xyXG5pbXBvcnQgeyBqb2luLCBkaXJuYW1lLCBiYXNlbmFtZSwgaXNBYnNvbHV0ZSwgcmVzb2x2ZSB9IGZyb20gJ25vZGU6cGF0aCc7XHJcbmltcG9ydCB7IGV4aXN0c1N5bmMsIHJlYWxwYXRoU3luYywgcmVhZEZpbGVTeW5jIH0gZnJvbSAnbm9kZTpmcyc7XHJcbmltcG9ydCB7IGNyZWF0ZVdyaXRlU3RyZWFtIH0gZnJvbSAnbm9kZTpmcyc7XHJcbmltcG9ydCB7IHdyaXRlRmlsZSwgcmVhZEZpbGUsIHN0YXQsIHJlbmFtZSB9IGZyb20gJ25vZGU6ZnMvcHJvbWlzZXMnO1xyXG5pbXBvcnQgeyBob21lZGlyLCBuZXR3b3JrSW50ZXJmYWNlcyB9IGZyb20gJ25vZGU6b3MnO1xyXG5pbXBvcnQgeyBleGVjRmlsZVN5bmMsIHNwYXduIH0gZnJvbSAnbm9kZTpjaGlsZF9wcm9jZXNzJztcclxuaW1wb3J0IHsgcGF0aFRvRmlsZVVSTCB9IGZyb20gJ25vZGU6dXJsJztcclxuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gJ25vZGU6Y3J5cHRvJztcclxuaW1wb3J0IHsgRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yLCBEZXNrdG9wSG9zdENsaWVudCwgZW52ZWxvcGVGcm9tRnJhbWUsIHR5cGUgSG9zdFN0YXRlIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2hvc3QtYWRhcHRlcic7XHJcbmltcG9ydCB7IGlzRXZlbnRFbnZlbG9wZSwgdHlwZSBFdmVudEVudmVsb3BlIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyc7XHJcbmltcG9ydCB7IGF0dGFjaFVpVmVyaWZ5IH0gZnJvbSAnLi91aXZlcmlmeS50cyc7XHJcbmltcG9ydCB7IGF0dGFjaFZpc3VhbFJlZ3Jlc3Npb24gfSBmcm9tICcuL3Zpc3VhbHJlZ3Jlc3Npb24udHMnO1xyXG5pbXBvcnQgeyBpbnN0YWxsVGFyZ2V0LCByZXNvbHZlSW5zdGFsbGVkRW50cnksIHN0YXJ0Q2xpSW5zdGFsbCwgdHlwZSBJbnN0YWxsUHJvZ3Jlc3MgfSBmcm9tICcuL2luc3RhbGxlci50cyc7XHJcbmltcG9ydCB7IG9yZGVyZWRDaGVja0NoYW5uZWxzLCBkb3dubG9hZENhbmRpZGF0ZXMsIG5vcm1hbGl6ZUNoYW5uZWwsIG5vcm1hbGl6ZVJlbGVhc2UsIHBpY2tJbnN0YWxsZXJBc3NldCwgc2l6ZU1hdGNoZXMsIHN1bW1hcml6ZUNoZWNrRmFpbHVyZXMsIGNtcFZlcnNpb24sIHR5cGUgTGF0ZXN0UmVsZWFzZSwgdHlwZSBSZWxlYXNlQXNzZXQsIHR5cGUgVXBkYXRlQ2hhbm5lbElkLCB0eXBlIFVwZGF0ZVJlcG9zIH0gZnJvbSAnLi91cGRhdGVyLWNoYW5uZWxzLnRzJztcclxuaW1wb3J0IHsgY3JlYXRlRm9yZ2UsIGZvcmdlRml4dHVyZXMsIGNoZWNrSG9zdCwgY2hlY2tSZXBvLCBjaGVja1N0YXRlLCB0eXBlIEZvcmdlQWN0aW9uS2luZCwgdHlwZSBGb3JnZUhvc3QsIHR5cGUgRm9yZ2VTZXJ2aWNlIH0gZnJvbSAnLi9mb3JnZS50cyc7XHJcblxyXG5jb25zdCBoZXJlID0gaW1wb3J0Lm1ldGEuZGlybmFtZSA/PyAnLic7XHJcbmNvbnN0IGlzRGV2ID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfREVWID09PSAnMSc7XHJcbmNvbnN0IHJlbmRlcmVyRGV2VXJsID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfUkVOREVSRVJfVVJMID8/ICcnO1xyXG5jb25zdCBwcmVsb2FkUGF0aCA9IGpvaW4oaGVyZSwgJy4uL3ByZWxvYWQvaW5kZXguY2pzJyk7XHJcblxyXG4vKiAtLS0tIFx1NjVFNVx1NUZEN1x1ODEzMVx1NjU0Rjp0b2tlbi9hdXRob3JpemF0aW9uIFx1NkMzOFx1NEUwRFx1OEZEQlx1NjNBN1x1NTIzNlx1NTNGMCAtLS0tICovXHJcbmNvbnN0IHNlY3JldHM6IHN0cmluZ1tdID0gW107XHJcbmZ1bmN0aW9uIHJlZGFjdChzOiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gIGxldCBvdXQgPSBzO1xyXG4gIGZvciAoY29uc3Qgc2VjIG9mIHNlY3JldHMpIHtcclxuICAgIGlmIChzZWMubGVuZ3RoID49IDgpIG91dCA9IG91dC5zcGxpdChzZWMpLmpvaW4oJ1tyZWRhY3RlZF0nKTtcclxuICB9XHJcbiAgcmV0dXJuIG91dDtcclxufVxyXG5mdW5jdGlvbiBsb2dJbmZvKHRhZzogc3RyaW5nLCBtc2c6IHN0cmluZyk6IHZvaWQge1xyXG4gIGNvbnNvbGUubG9nKGBbaG1oLWRlc2t0b3A6JHt0YWd9XSAke3JlZGFjdChtc2cpfWApO1xyXG59XHJcblxyXG4vKiAtLS0tIFx1NTM1NVx1NUI5RVx1NEY4QiAtLS0tICovXHJcbmlmICghYXBwLnJlcXVlc3RTaW5nbGVJbnN0YW5jZUxvY2soKSkge1xyXG4gIGFwcC5xdWl0KCk7XHJcbn0gZWxzZSB7XHJcbiAgYXBwLm9uKCdzZWNvbmQtaW5zdGFuY2UnLCAoKSA9PiB7XHJcbiAgICBjb25zdCB3aW4gPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKVswXTtcclxuICAgIGlmICh3aW4pIHtcclxuICAgICAgaWYgKHdpbi5pc01pbmltaXplZCgpKSB3aW4ucmVzdG9yZSgpO1xyXG4gICAgICB3aW4uZm9jdXMoKTtcclxuICAgIH1cclxuICB9KTtcclxuXHJcbiAgLyogLS0tLSBob3N0IFx1NzZEMVx1N0JBMSArIFx1Njg2NVx1NUJBMlx1NjIzN1x1N0FFRiAtLS0tICovXHJcbiAgaW50ZXJmYWNlIEJyaWRnZVNuYXBzaG90IHtcclxuICAgIGhvc3RTdGF0ZTogSG9zdFN0YXRlO1xyXG4gICAgaG9zdFBvcnQ6IG51bWJlciB8IG51bGw7XHJcbiAgICBob3N0VmVyc2lvbjogc3RyaW5nIHwgbnVsbDtcclxuICAgIGxhc3RFcnJvcjogc3RyaW5nIHwgbnVsbDtcclxuICAgIG1vZGU6ICdmYWtlJyB8ICdyZWFsJztcclxuICAgIHJ1bnRpbWVFbnRyeTogc3RyaW5nIHwgbnVsbDtcclxuICB9XHJcbiAgbGV0IHN1cGVydmlzb3I6IERlc2t0b3BSdW50aW1lU3VwZXJ2aXNvciB8IG51bGwgPSBudWxsO1xyXG4gIGxldCBjbGllbnQ6IERlc2t0b3BIb3N0Q2xpZW50IHwgbnVsbCA9IG51bGw7XHJcbiAgbGV0IGJyaWRnZTogQnJpZGdlU25hcHNob3QgPSB7IGhvc3RTdGF0ZTogJ3N0b3BwZWQnLCBob3N0UG9ydDogbnVsbCwgaG9zdFZlcnNpb246IG51bGwsIGxhc3RFcnJvcjogbnVsbCwgbW9kZTogJ2Zha2UnLCBydW50aW1lRW50cnk6IG51bGwgfTtcclxuICAvKiogXHU0RThCXHU0RUY2XHU2Mjc5XHU5MUNGXHU3RjEzXHU1MUIyOlx1OUFEOFx1OTg5MSBTU0UgXHU0RTBEXHU5MDEwXHU2NzYxXHU4RkM3IElQQyw1MG1zIFx1NjI3OVx1OTFDRiBmbHVzaChcdTZFMzJcdTY3RDNcdTRFMERcdTUzNjEpXHUzMDAyICovXHJcbiAgbGV0IGV2ZW50QnVmZmVyOiBFdmVudEVudmVsb3BlW10gPSBbXTtcclxuICBsZXQgZmx1c2hUaW1lcjogTm9kZUpTLlRpbWVvdXQgfCBudWxsID0gbnVsbDtcclxuICBsZXQgc3NlQWJvcnQ6IEFib3J0Q29udHJvbGxlciB8IG51bGwgPSBudWxsO1xyXG4gIGxldCBsYXN0RXZlbnRJZCA9ICcnO1xyXG4gIC8qKiBcdTY3MkFcdTc3RTUvXHU3NTc4XHU1RjYyXHU0RkUxXHU1QzAxXHU4QkExXHU2NTcwKFNDSEVNQV9NSVNNQVRDSCBcdTk3NjJcdTU0MTFcdThCQ0FcdTY1QUQsXHU0RTBEXHU1RDI5KVx1MzAwMiAqL1xyXG4gIGxldCBkcm9wcGVkRnJhbWVzID0gMDtcclxuXHJcbiAgZnVuY3Rpb24gcHVzaEV2ZW50KGVudjogRXZlbnRFbnZlbG9wZSk6IHZvaWQge1xyXG4gICAgZXZlbnRCdWZmZXIucHVzaChlbnYpO1xyXG4gICAgaWYgKGV2ZW50QnVmZmVyLmxlbmd0aCA+IDJfMDAwKSBldmVudEJ1ZmZlci5zcGxpY2UoMCwgZXZlbnRCdWZmZXIubGVuZ3RoIC0gMl8wMDApO1xyXG4gICAgaWYgKGZsdXNoVGltZXIgPT09IG51bGwpIHtcclxuICAgICAgZmx1c2hUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xyXG4gICAgICAgIGZsdXNoVGltZXIgPSBudWxsO1xyXG4gICAgICAgIGNvbnN0IGJhdGNoID0gZXZlbnRCdWZmZXI7XHJcbiAgICAgICAgZXZlbnRCdWZmZXIgPSBbXTtcclxuICAgICAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcclxuICAgICAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ2JyaWRnZTpldmVudC1iYXRjaCcsIGJhdGNoKTtcclxuICAgICAgICB9XHJcbiAgICAgIH0sIDUwKTtcclxuICAgIH1cclxuICAgIG5vdGlmeUV2ZW50KGVudik7XHJcbiAgfVxyXG5cclxuICAvKiAtLS0tIFx1N0NGQlx1N0VERlx1NjI1OFx1NzZEOCArIFx1OTAxQVx1NzdFNSgwMyBcdTUzRjcgXHUwMEE3XHU0RTAwOlx1Njg0Q1x1OTc2Mlx1NEVBN1x1NTRDMVx1OTcwMFx1ODk4MVx1N0NGQlx1N0VERlx1NjI1OFx1NzZEOFx1MzAwMVx1OTAxQVx1NzdFNSkgLS0tLVxyXG4gICAgIFx1NUJBMVx1NjI3OVx1N0I0OVx1NUY4NVx1NUZDNVx1OTg3Qlx1NjI1M1x1NjI3MChcdTc1MjhcdTYyMzdcdTVGQzVcdTk4N0JcdTUxQjNcdTdCNTYpO1x1NUI4Q1x1NjIxMC9cdTU5MzFcdThEMjVcdTRFQzVcdTU3MjhcdTdBOTdcdTUzRTNcdTU5MzFcdTcxMjZcdTY1RjZcdTYzRDBcdTkxOTJcdTMwMDIgKi9cclxuICBjb25zdCBUUkFZX0lDT05fQkFTRTY0ID0gJ2lWQk9SdzBLR2dvQUFBQU5TVWhFVWdBQUFCQUFBQUFRQ0FZQUFBQWY4LzloQUFBQVIwbEVRVlI0bkdOZ1FBUFNzb3IvOFdGMDlVUnJ4R3NRcVpveERJRUo2RGQrQjJOMGhiakVNV3duMVFDd0lZUFRBRnlZZmdZTWZCaVFaQURGQ1lrcVNabml6RVJKZGdZQWxMNXJzRGMyYVRjQUFBQUFTVVZPUks1Q1lJST0nO1xyXG4gIGxldCB0cmF5OiBUcmF5IHwgbnVsbCA9IG51bGw7XHJcbiAgY29uc3Qgc2VuZE1lbnVBY3Rpb24gPSAoYTogc3RyaW5nKTogdm9pZCA9PiB7XHJcbiAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcclxuICAgICAgaWYgKCF3LmlzRGVzdHJveWVkKCkpIHcud2ViQ29udGVudHMuc2VuZCgnbWVudTphY3Rpb24nLCBhKTtcclxuICAgIH1cclxuICB9O1xyXG4gIGZ1bmN0aW9uIGZvY3VzTWFpbldpbmRvdygpOiB2b2lkIHtcclxuICAgIGNvbnN0IHdpbiA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmZpbmQoKHcpID0+ICF3LmlzRGVzdHJveWVkKCkpO1xyXG4gICAgaWYgKHdpbiA9PT0gdW5kZWZpbmVkKSByZXR1cm47XHJcbiAgICBpZiAod2luLmlzTWluaW1pemVkKCkpIHdpbi5yZXN0b3JlKCk7XHJcbiAgICB3aW4uc2hvdygpO1xyXG4gICAgd2luLmZvY3VzKCk7XHJcbiAgfVxyXG4gIGZ1bmN0aW9uIHNldHVwVHJheSgpOiB2b2lkIHtcclxuICAgIGlmICh0cmF5ICE9PSBudWxsKSByZXR1cm47XHJcbiAgICBjb25zdCBpY29uID0gbmF0aXZlSW1hZ2UuY3JlYXRlRnJvbURhdGFVUkwoYGRhdGE6aW1hZ2UvcG5nO2Jhc2U2NCwke1RSQVlfSUNPTl9CQVNFNjR9YCk7XHJcbiAgICB0cmF5ID0gbmV3IFRyYXkoaWNvbik7XHJcbiAgICB0cmF5LnNldFRvb2xUaXAoJ0hNSCBEZXNrdG9wJyk7XHJcbiAgICB0cmF5Lm9uKCdjbGljaycsIGZvY3VzTWFpbldpbmRvdyk7XHJcbiAgICB0cmF5LnNldENvbnRleHRNZW51KE1lbnUuYnVpbGRGcm9tVGVtcGxhdGUoW1xyXG4gICAgICB7IGxhYmVsOiAnXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREJywgY2xpY2s6ICgpOiB2b2lkID0+IHNlbmRNZW51QWN0aW9uKCduZXctc2Vzc2lvbicpIH0sXHJcbiAgICAgIHsgbGFiZWw6ICdcdTY2M0VcdTc5M0FcdTRFM0JcdTdBOTdcdTUzRTMnLCBjbGljazogZm9jdXNNYWluV2luZG93IH0sXHJcbiAgICAgIHsgbGFiZWw6ICdcdTYyNEJcdTY3M0FcdThGRENcdTdBMEJcdTYzQTdcdTUyMzYnLCBjbGljazogKCk6IHZvaWQgPT4gc2VuZE1lbnVBY3Rpb24oJ29wZW4tcmVtb3RlJykgfSxcclxuICAgICAgeyBsYWJlbDogJ1x1OEJCRVx1N0Y2RScsIGNsaWNrOiAoKTogdm9pZCA9PiBzZW5kTWVudUFjdGlvbignb3Blbi1zZXR0aW5ncycpIH0sXHJcbiAgICAgIHsgdHlwZTogJ3NlcGFyYXRvcicgfSxcclxuICAgICAgeyBsYWJlbDogJ1x1OTAwMFx1NTFGQScsIGNsaWNrOiAoKTogdm9pZCA9PiB7IGFwcC5xdWl0KCk7IH0gfSxcclxuICAgIF0pKTtcclxuICB9XHJcbiAgZnVuY3Rpb24gbm90aWZ5RXZlbnQoZW52OiBFdmVudEVudmVsb3BlKTogdm9pZCB7XHJcbiAgICAvLyBcdTlBOENcdTY1MzYvXHU2MjJBXHU1NkZFL1x1NkUzMlx1NjdEM1x1NjNBMlx1OTQ4OC9cdTg5QzZcdTg5QzlcdTU2REVcdTVGNTJcdTZBMjFcdTVGMEZcdTk3NTlcdTlFRDgoXHU0RTBEXHU1RjgwXHU3NTI4XHU2MjM3XHU2ODRDXHU5NzYyXHU1RjM5XHU2RDRCXHU4QkQ1XHU5MDFBXHU3N0U1KVxyXG4gICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZID09PSAnMScgfHwgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfU05BUFNIT1QgIT09IHVuZGVmaW5lZCB8fCBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9SRU5ERVJfVEVTVCA9PT0gJzEnIHx8IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1ZJU1JFRyA9PT0gJzEnKSByZXR1cm47XHJcbiAgICBpZiAoIU5vdGlmaWNhdGlvbi5pc1N1cHBvcnRlZCgpKSByZXR1cm47XHJcbiAgICBjb25zdCB3aW4gPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5maW5kKCh3KSA9PiAhdy5pc0Rlc3Ryb3llZCgpKTtcclxuICAgIGNvbnN0IGZvY3VzZWQgPSB3aW4/LmlzRm9jdXNlZCgpID8/IGZhbHNlO1xyXG4gICAgY29uc3QgbWsgPSAodGl0bGU6IHN0cmluZywgYm9keTogc3RyaW5nKTogdm9pZCA9PiB7XHJcbiAgICAgIGNvbnN0IG4gPSBuZXcgTm90aWZpY2F0aW9uKHsgdGl0bGUsIGJvZHksIGljb246IG5hdGl2ZUltYWdlLmNyZWF0ZUZyb21EYXRhVVJMKGBkYXRhOmltYWdlL3BuZztiYXNlNjQsJHtUUkFZX0lDT05fQkFTRTY0fWApIH0pO1xyXG4gICAgICBuLm9uKCdjbGljaycsIGZvY3VzTWFpbldpbmRvdyk7XHJcbiAgICAgIG4uc2hvdygpO1xyXG4gICAgfTtcclxuICAgIGlmIChlbnYua2luZCA9PT0gJ2FwcHJvdmFsLnJlcXVpcmVkJykge1xyXG4gICAgICBjb25zdCBwID0gZW52LnBheWxvYWQgYXMgeyB0b29sPzogc3RyaW5nIH07XHJcbiAgICAgIG1rKCdITUggXHU5NzAwXHU4OTgxXHU1QkExXHU2Mjc5JywgYCR7U3RyaW5nKHAudG9vbCA/PyAnXHU2NENEXHU0RjVDJyl9IFx1N0I0OVx1NUY4NVx1NEY2MFx1NzY4NFx1NjI3OVx1NTFDNmApO1xyXG4gICAgfSBlbHNlIGlmIChlbnYua2luZCA9PT0gJ3J1bi5jb21wbGV0ZWQnICYmICFmb2N1c2VkKSB7XHJcbiAgICAgIG1rKCdITUggXHU0RUZCXHU1MkExXHU1QjhDXHU2MjEwJywgYFx1NEYxQVx1OEJERCAke2Vudi5zZXNzaW9uSWR9IFx1NzY4NFx1NEVGQlx1NTJBMVx1NURGMlx1NUI4Q1x1NjIxMGApO1xyXG4gICAgfSBlbHNlIGlmIChlbnYua2luZCA9PT0gJ3J1bi5mYWlsZWQnICYmICFmb2N1c2VkKSB7XHJcbiAgICAgIG1rKCdITUggXHU0RUZCXHU1MkExXHU1OTMxXHU4RDI1JywgYFx1NEYxQVx1OEJERCAke2Vudi5zZXNzaW9uSWR9IFx1NzY4NFx1NEVGQlx1NTJBMVx1NTkzMVx1OEQyNSxcdTcwQjlcdTUxRkJcdTY3RTVcdTc3MEJgKTtcclxuICAgIH1cclxuICB9XHJcblxyXG4gIC8qIC0tLS0gXHU4MUVBXHU1QjlBXHU0RTQ5XHU2ODA3XHU5ODk4XHU2ODBGKDIwMjYtMTAtMTEgXHU3NTI4XHU2MjM3XHU1M0NEXHU5OTg4Olx1NEVBRVx1ODI3Mlx1NkEyMVx1NUYwRlx1OTg3Nlx1OTBFOFx1OUVEMVx1Njc2MT1cdTUzOUZcdTc1MUZcdTgzRENcdTUzNTVcdTY4MEZcclxuICAgICBcdTRFMERcdThEREZcdTRFM0JcdTk4OTg7XHU4M0RDXHU1MzU1XHU0RTBFXHU4QkJFXHU3RjZFXHU5MUNEXHU1OTBEKSAtLS0tIFx1NjVCOVx1Njg0ODpcdTk2OTBcdTg1Q0ZcdTVGMEZcdTY4MDdcdTk4OThcdTY4MEYgKyB0aXRsZUJhck92ZXJsYXlcclxuICAgICAoXHU5ODlDXHU4MjcyXHU5NjhGXHU0RTNCXHU5ODk4KSxcdTgzRENcdTUzNTVcdTY4MEYgYXV0b0hpZGUoQWx0IFx1NTQ3Q1x1NTFGQSlcdTRFMTRcdTdDQkVcdTdCODBcdTRFM0FcdTdDRkJcdTdFREZcdTdFQTdcdTgwRkRcdTUyOUI7XHJcbiAgICAgXHU1RTM4XHU3NTI4XHU1MkE4XHU0RjVDXHU4RDcwIHJlbmRlcmVyIFx1NjgwN1x1OTg5OFx1NjgwRiBcdTI2MzAgXHU0RTNCXHU4M0RDXHU1MzU1KFx1NTUyRlx1NEUwMFx1NTE2NVx1NTNFMylcdTMwMDIgKi9cclxuICAvLyB2NCBEU0ggXHU4QkJFXHU4QkExXHU4QkVEXHU4QTAwOm92ZXJsYXkgXHU4MjcyXHU4RERGXHU5NjhGIHRpdGxlYmFyIFx1NzY4NCBiZy1sYXllci0xKFx1NkQ0NSAjZmZmL1x1NkRGMSAjMTYxODFkKVxyXG4gIGNvbnN0IGNocm9tZUZvciA9IChkYXJrOiBib29sZWFuKTogeyBjb2xvcjogc3RyaW5nOyBzeW1ib2xDb2xvcjogc3RyaW5nIH0gPT5cclxuICAgIGRhcmsgPyB7IGNvbG9yOiAnIzE2MTgxZCcsIHN5bWJvbENvbG9yOiAnI2Y1ZjZmOCcgfSA6IHsgY29sb3I6ICcjZmZmZmZmJywgc3ltYm9sQ29sb3I6ICcjMGYxMTE1JyB9O1xyXG4gIGZ1bmN0aW9uIGFwcGx5Q2hyb21lKGRhcms6IGJvb2xlYW4pOiB2b2lkIHtcclxuICAgIGZvciAoY29uc3QgdyBvZiBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKSkge1xyXG4gICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkge1xyXG4gICAgICAgIHRyeSB7IHcuc2V0VGl0bGVCYXJPdmVybGF5KGNocm9tZUZvcihkYXJrKSk7IH0gY2F0Y2ggeyAvKiBcdTRFQzUgV2luZG93cyBcdTY1MkZcdTYzMDEgKi8gfVxyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvKiAtLS0tIFx1NUU5NFx1NzUyOFx1NTE4NVx1NjZGNFx1NjVCMCgyMDI2LTEwLTI2Olx1ODFFQVx1NzgxNFx1OEY3Qlx1OTFDRlx1NjZGNFx1NjVCMFx1NTY2OCxcdTk2RjZcdTRGOURcdThENTY7R2l0SHViIFJlbGVhc2VzIFx1OTAxQVx1OTA1MylcclxuICAgICBcdTZENDFcdTdBMEI6XHU1NDJGXHU1MkE4IDMwcyBcdTU0MEVcdTk3NTlcdTlFRDhcdTY4QzBcdTY3RTUgXHUyMTkyIGZldGNoIGxhdGVzdCByZWxlYXNlIHRhZyBcdTIxOTIgXHU2QkQ0XHU3MjQ4XHU2NzJDIFx1MjE5MiBcdTU0MEVcdTUzRjBcdTZENDFcdTVGMEZcclxuICAgICBcdTRFMEJcdThGN0QgU2V0dXAgZXhlIFx1NTIzMFx1NEUzNFx1NjVGNlx1NzZFRVx1NUY1NShcdThGREJcdTVFQTZcdTYzQThcdTkwMDEgcmVuZGVyZXIgXHU2QTJBXHU1RTQ1KVx1MjE5MlwiXHU5MUNEXHU1NDJGXHU2NkY0XHU2NUIwXCJcdTIxOTIgXHU5MDAwXHU1MUZBXHU1RTk0XHU3NTI4XHJcbiAgICAgXHU1NDBFIE5TSVMgL1MgL0Q9XHU1MzlGXHU3NkVFXHU1RjU1IFx1OTc1OVx1OUVEOFx1ODk4Nlx1NzZENlx1NUI4OVx1ODhDNShcdTRFMEJcdTZCMjFcdTU0MkZcdTUyQThcdTUzNzNcdTY1QjBcdTcyNDgpXHUyMDE0XHUyMDE0XHU1MTY4XHU3QTBCXHU0RTBEXHU4REYzXHU2RDRGXHU4OUM4XHU1NjY4XHUzMDAyXHJcbiAgICAgMjAyNi0xMC0yOSBcdTUzQ0NcdTkwMUFcdTkwNTNcdTY4MzlcdTRGRUUoXHU3NTI4XHU2MjM3XHU1NkZEXHU1MTg1XHU2NTM2XHU0RTBEXHU1MjMwXHU2M0E4XHU5MDAxKTpcdTY4QzBcdTY3RTVcdTkwMUFcdTkwNTNcdTk1NUNcdTUwQ0ZcdTU2REVcdTkwMDBcdTk0RkVcclxuICAgICAoXHU3NkY0XHU4RkRFIDhzIFx1MjE5MiBnaC1wcm94eSBcdTIxOTIgZ2hmYXN0KSsgXHU1NDdEXHU0RTJEXHU5MDFBXHU5MDUzXHU3Qzk4XHU2MDI3XHU4QkIwXHU1RkM2ICsgXHU0RTBCXHU4RjdEXHU1NDBDXHU2RTkwXHU0RjE4XHU1MTQ4XHUzMDAyXHJcbiAgICAgXHU1NDBDXHU2NUU1XHU0RUZCXHU1MkExIDEzLUM6YXRvbWdpdCBcdTU2RkRcdTUxODVcdTk5OTZcdTkwMDlcdTkwMUFcdTkwNTMoXHU5NEZFXHU3QjJDXHU0RThDXHU0RjRELFx1NTZGRFx1NTE4NVx1NzZGNFx1OEZERVx1NTMzRlx1NTQwRFx1NTNFRlx1OEJGQikrIFx1NkQ0MVx1NUYwRlxyXG4gICAgIFx1NEUwQlx1OEY3RFx1OEZEQlx1NUVBNiArIFx1NEUwQlx1OEY3RCBzaXplIFx1NjgyMVx1OUE4QyArIFwiXHU5MUNEXHU1NDJGXHU2NkY0XHU2NUIwXCJcdTk3NUVcdTZBMjFcdTYwMDFcdTZBMkFcdTVFNDUocmVuZGVyZXIpXHUzMDAyXHJcbiAgICAgXHU2NUNCXHU5NEFFOlVQREFURV9SRVBPIC8gVVBEQVRFX1JFUE9fQVRPTUdJVCBcdTg5ODZcdTc2RDZcdTUzQ0NcdTRFRDM7SE1IX0RFU0tUT1BfVVBEQVRFX0ZPUkNFX1RBR1xyXG4gICAgIFx1OTc1RVx1N0E3QSBcdTIxOTIgXHU2NUUwXHU4OUM2XHU3MjQ4XHU2NzJDXHU2QkQ0XHU4RjgzXHU1RjNBXHU1MjM2XHU4RDcwXHU2NkY0XHU2NUIwXHU2RDQxXHU3QTBCKFx1OUE4Q1x1NjUzNlx1NzUyOCxcdTRFMERcdTkxQ0RcdTYyNTNcdTUzMDUpXHUzMDAyICovXHJcbiAgY29uc3QgVVBEQVRFX1JFUE9TOiBVcGRhdGVSZXBvcyA9IHtcclxuICAgIGdpdGh1YjogcHJvY2Vzcy5lbnYuVVBEQVRFX1JFUE8gPz8gJ3N3c2dibC9obWgtZGVza3RvcCcsXHJcbiAgICBhdG9tZ2l0OiBwcm9jZXNzLmVudi5VUERBVEVfUkVQT19BVE9NR0lUID8/ICdob25nZnUvaG1oLWRlc2t0b3AnLFxyXG4gIH07XHJcbiAgY29uc3QgVVBEQVRFX0ZPUkNFX1RBRyA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VQREFURV9GT1JDRV9UQUcgPz8gJyc7XHJcbiAgaW50ZXJmYWNlIFVwZGF0ZVByb2dyZXNzIHsgcmVjZWl2ZWQ6IG51bWJlcjsgdG90YWw6IG51bWJlcjsgc3BlZWRCcHM6IG51bWJlciB9XHJcbiAgaW50ZXJmYWNlIFVwZGF0ZVN0YXRlIHsgY2hlY2tpbmc6IGJvb2xlYW47IGN1cnJlbnRWZXJzaW9uOiBzdHJpbmc7IGxhdGVzdDogc3RyaW5nIHwgbnVsbDsgbm90ZXM6IHN0cmluZzsgZG93bmxvYWRlZDogYm9vbGVhbjsgZXJyb3I6IHN0cmluZzsgY2hhbm5lbDogc3RyaW5nOyBwcm9ncmVzczogVXBkYXRlUHJvZ3Jlc3MgfCBudWxsIH1cclxuICBsZXQgdXBkYXRlU3RhdGU6IFVwZGF0ZVN0YXRlID0geyBjaGVja2luZzogZmFsc2UsIGN1cnJlbnRWZXJzaW9uOiBhcHAuZ2V0VmVyc2lvbigpLCBsYXRlc3Q6IG51bGwsIG5vdGVzOiAnJywgZG93bmxvYWRlZDogZmFsc2UsIGVycm9yOiAnJywgY2hhbm5lbDogJycsIHByb2dyZXNzOiBudWxsIH07XHJcbiAgbGV0IGluc3RhbGxlclBhdGg6IHN0cmluZyB8IG51bGwgPSBudWxsO1xyXG4gIGNvbnN0IGJ1bXBVcGRhdGUgPSAocGF0Y2g6IFBhcnRpYWw8VXBkYXRlU3RhdGU+KTogdm9pZCA9PiB7XHJcbiAgICB1cGRhdGVTdGF0ZSA9IHsgLi4udXBkYXRlU3RhdGUsIC4uLnBhdGNoIH07XHJcbiAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcclxuICAgICAgaWYgKCF3LmlzRGVzdHJveWVkKCkpIHcud2ViQ29udGVudHMuc2VuZCgndXBkYXRlOnN0YXRlJywgdXBkYXRlU3RhdGUpO1xyXG4gICAgfVxyXG4gIH07XHJcbiAgLyoqIFx1OTAxQVx1OTA1M1x1N0M5OFx1NjAyNzpcdTRFMEFcdTZCMjFcdTYyMTBcdTUyOUZcdTU0N0RcdTRFMkRcdTc2ODRcdTY4QzBcdTY3RTVcdTkwMUFcdTkwNTModXNlckRhdGEvdXBkYXRlLWNoYW5uZWwuanNvbixcdTRFMEUgcnVudGltZS5qc29uIFx1NTQwQ1x1NkEyMVx1NUYwRilcdTMwMDIgKi9cclxuICBjb25zdCB1cGRhdGVDaGFubmVsRmlsZSA9ICgpOiBzdHJpbmcgPT4gam9pbihhcHAuZ2V0UGF0aCgndXNlckRhdGEnKSwgJ3VwZGF0ZS1jaGFubmVsLmpzb24nKTtcclxuICBhc3luYyBmdW5jdGlvbiBsb2FkU3RpY2t5Q2hhbm5lbCgpOiBQcm9taXNlPFVwZGF0ZUNoYW5uZWxJZCB8IG51bGw+IHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHYgPSBKU09OLnBhcnNlKGF3YWl0IHJlYWRGaWxlKHVwZGF0ZUNoYW5uZWxGaWxlKCksICd1dGY4JykpIGFzIHsgY2hhbm5lbD86IHVua25vd24gfTtcclxuICAgICAgcmV0dXJuIG5vcm1hbGl6ZUNoYW5uZWwodi5jaGFubmVsKTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4gbnVsbDsgfVxyXG4gIH1cclxuICBhc3luYyBmdW5jdGlvbiBzYXZlU3RpY2t5Q2hhbm5lbChpZDogVXBkYXRlQ2hhbm5lbElkKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBhd2FpdCB3cml0ZUZpbGUodXBkYXRlQ2hhbm5lbEZpbGUoKSwgSlNPTi5zdHJpbmdpZnkoeyBjaGFubmVsOiBpZCB9LCBudWxsLCAyKSwgJ3V0ZjgnKS5jYXRjaCgoKSA9PiB1bmRlZmluZWQpO1xyXG4gIH1cclxuICBhc3luYyBmdW5jdGlvbiBjaGVja0ZvclVwZGF0ZXMoKTogUHJvbWlzZTxVcGRhdGVTdGF0ZT4ge1xyXG4gICAgaWYgKHVwZGF0ZVN0YXRlLmNoZWNraW5nIHx8IHVwZGF0ZVN0YXRlLmRvd25sb2FkZWQpIHJldHVybiB1cGRhdGVTdGF0ZTtcclxuICAgIGJ1bXBVcGRhdGUoeyBjaGVja2luZzogdHJ1ZSwgZXJyb3I6ICcnIH0pO1xyXG4gICAgbG9nSW5mbygndXBkYXRlJywgYGNoZWNraW5nXHUyMDI2IChjdXJyZW50IHYke2FwcC5nZXRWZXJzaW9uKCl9KSR7VVBEQVRFX0ZPUkNFX1RBRyAhPT0gJycgPyBgIGZvcmNlLXRhZz0ke1VQREFURV9GT1JDRV9UQUd9YCA6ICcnfWApO1xyXG4gICAgY29uc3QgZmFpbHVyZXM6IEFycmF5PHsgbGFiZWw6IHN0cmluZzsgcmVhc29uOiBzdHJpbmcgfT4gPSBbXTtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHN0aWNreSA9IGF3YWl0IGxvYWRTdGlja3lDaGFubmVsKCk7XHJcbiAgICAgIGNvbnN0IGNoYW5uZWxzID0gb3JkZXJlZENoZWNrQ2hhbm5lbHMoc3RpY2t5ID8/IHVuZGVmaW5lZCk7XHJcbiAgICAgIGZvciAoY29uc3QgY2ggb2YgY2hhbm5lbHMpIHtcclxuICAgICAgICBsZXQgcmVsOiBMYXRlc3RSZWxlYXNlIHwgbnVsbCA9IG51bGw7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgIGNvbnN0IHIgPSBhd2FpdCBmZXRjaChjaC5hcGlVcmwoVVBEQVRFX1JFUE9TKSwge1xyXG4gICAgICAgICAgICBoZWFkZXJzOiB7ICd1c2VyLWFnZW50JzogJ2htaC1kZXNrdG9wLXVwZGF0ZXInIH0sXHJcbiAgICAgICAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dChjaC50aW1lb3V0TXMpLFxyXG4gICAgICAgICAgfSk7XHJcbiAgICAgICAgICBpZiAoIXIub2spIHsgZmFpbHVyZXMucHVzaCh7IGxhYmVsOiBjaC5sYWJlbCwgcmVhc29uOiBgSFRUUCAke3Iuc3RhdHVzfWAgfSk7IGxvZ0luZm8oJ3VwZGF0ZScsIGAke2NoLmxhYmVsfSBcdTIxOTIgSFRUUCAke3Iuc3RhdHVzfWApOyBjb250aW51ZTsgfVxyXG4gICAgICAgICAgLy8gXHU5NTVDXHU1MENGXHU1M0VGXHU4MEZEXHU1NkRFIDIwMCBcdTRGNDZcdTUxODVcdTVCQjlcdTk3NUUgSlNPTihIVE1MIFx1OTUxOVx1OEJFRlx1OTg3NSk7R2l0SHViIFx1NTZERVx1NUJGOVx1OEM2MVx1MzAwMWF0b21naXRcclxuICAgICAgICAgIC8vIFx1NTZERVx1NjU3MFx1N0VDNFx1MjAxNFx1MjAxNG5vcm1hbGl6ZVJlbGVhc2UgXHU3RURGXHU0RTAwXHU1RjUyXHU0RTAwLFx1NUY2Mlx1NzJCNlx1NEUwRFx1NUJGOVx1NjMwOVx1NjcyQ1x1OTAxQVx1OTA1M1x1NTkzMVx1OEQyNVx1NTZERVx1OTAwMFxyXG4gICAgICAgICAgcmVsID0gbm9ybWFsaXplUmVsZWFzZShhd2FpdCByLmpzb24oKSk7XHJcbiAgICAgICAgICBpZiAocmVsID09PSBudWxsKSB7IGZhaWx1cmVzLnB1c2goeyBsYWJlbDogY2gubGFiZWwsIHJlYXNvbjogJ1x1NTRDRFx1NUU5NFx1NjVFMCB0YWdfbmFtZScgfSk7IGxvZ0luZm8oJ3VwZGF0ZScsIGAke2NoLmxhYmVsfSBcdTIxOTIgXHU2NUUwIHRhZ19uYW1lYCk7IGNvbnRpbnVlOyB9XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgICBjb25zdCBlID0gZXJyIGFzIHsgY2F1c2U/OiB7IGNvZGU/OiB1bmtub3duIH0gfTtcclxuICAgICAgICAgIGNvbnN0IHJlYXNvbiA9IGVyciBpbnN0YW5jZW9mIEVycm9yICYmIGVyci5uYW1lID09PSAnVGltZW91dEVycm9yJ1xyXG4gICAgICAgICAgICA/IGBcdThEODVcdTY1RjYoJHtNYXRoLnJvdW5kKGNoLnRpbWVvdXRNcyAvIDEwMDApfXMpYFxyXG4gICAgICAgICAgICA6IFN0cmluZyhlLmNhdXNlPy5jb2RlID8/IGVycikuc2xpY2UoMCwgNjApO1xyXG4gICAgICAgICAgZmFpbHVyZXMucHVzaCh7IGxhYmVsOiBjaC5sYWJlbCwgcmVhc29uIH0pO1xyXG4gICAgICAgICAgbG9nSW5mbygndXBkYXRlJywgYCR7Y2gubGFiZWx9IFx1MjE5MiBmYWlsICR7cmVhc29ufWApO1xyXG4gICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHRhZyA9IHJlbC50YWdfbmFtZTtcclxuICAgICAgICBsb2dJbmZvKCd1cGRhdGUnLCBgbGF0ZXN0PSR7dGFnfSBhc3NldHM9JHsocmVsLmFzc2V0cyA/PyBbXSkubGVuZ3RofSB2aWEgJHtjaC5sYWJlbH0ke3N0aWNreSA9PT0gY2guaWQgPyAnKHN0aWNreSknIDogJyd9YCk7XHJcbiAgICAgICAgYXdhaXQgc2F2ZVN0aWNreUNoYW5uZWwoY2guaWQpOyAvLyBcdTdDOThcdTYwMjc6XHU0RTBCXHU2QjIxXHU1MTQ4XHU4QkQ1XHU2NzJDXHU5MDFBXHU5MDUzXHJcbiAgICAgICAgYnVtcFVwZGF0ZSh7IGNoZWNraW5nOiBmYWxzZSwgbGF0ZXN0OiB0YWcsIG5vdGVzOiBTdHJpbmcocmVsLmJvZHkgPz8gJycpLnNsaWNlKDAsIDYwMCksIGNoYW5uZWw6IGNoLmlkIH0pO1xyXG4gICAgICAgIC8vIFx1NjcwOVx1NjVCMFx1NzI0OChcdTYyMTYgRk9SQ0VfVEFHIFx1OUE4Q1x1NjUzNlx1NjVDQlx1OTRBRSlcdTRFMTRcdTY3MkFcdTRFMEJcdThGN0RcdThGQzcgXHUyMTkyIFx1NTQwRVx1NTNGMFx1NEUwQlx1OEY3RFx1NUI4OVx1ODhDNVx1NTMwNVxyXG4gICAgICAgIGlmICgoVVBEQVRFX0ZPUkNFX1RBRyAhPT0gJycgfHwgY21wVmVyc2lvbihhcHAuZ2V0VmVyc2lvbigpLCB0YWcpIDwgMCkgJiYgIXVwZGF0ZVN0YXRlLmRvd25sb2FkZWQpIHtcclxuICAgICAgICAgIHZvaWQgZG93bmxvYWRJbnN0YWxsZXIocmVsLmFzc2V0cyA/PyBbXSwgdGFnKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHVwZGF0ZVN0YXRlO1xyXG4gICAgICB9XHJcbiAgICAgIGNvbnN0IHN1bW1hcnkgPSBzdW1tYXJpemVDaGVja0ZhaWx1cmVzKGZhaWx1cmVzKTtcclxuICAgICAgbG9nSW5mbygndXBkYXRlJywgYGNoZWNrIGZhaWxlZDogYWxsIGNoYW5uZWxzICgke3N1bW1hcnl9KWApO1xyXG4gICAgICBidW1wVXBkYXRlKHsgY2hlY2tpbmc6IGZhbHNlLCBlcnJvcjogYFx1NTE2OFx1OTBFOFx1NjhDMFx1NjdFNVx1OTAxQVx1OTA1M1x1NTkzMVx1OEQyNSgke3N1bW1hcnl9KWAuc2xpY2UoMCwgMjAwKSB9KTtcclxuICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICBsb2dJbmZvKCd1cGRhdGUnLCBgY2hlY2sgZmFpbGVkOiAke1N0cmluZyhlcnIpLnNsaWNlKDAsIDE0MCl9YCk7XHJcbiAgICAgIGJ1bXBVcGRhdGUoeyBjaGVja2luZzogZmFsc2UsIGVycm9yOiBTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApIH0pO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHVwZGF0ZVN0YXRlO1xyXG4gIH1cclxuICAvKiogXHU1NDBFXHU1M0YwXHU2RDQxXHU1RjBGXHU0RTBCXHU4RjdEXHU1Qjg5XHU4OEM1XHU1MzA1Olx1NTIwNlx1NTc1N1x1NTE5OVx1NzZEOCgxMTJNQiBcdTRFMERcdTUxOERcdTY1NzRcdTlBN0JcdTUxODVcdTVCNTgpLFx1OEZEQlx1NUVBNihcdTVERjJcdTRFMEJcdThGN0QvXHU2MDNCXHU1QjU3XHU4MjgyL1xyXG4gICAqICBcdTkwMUZcdTVFQTYpXHU3RUNGIHVwZGF0ZTpzdGF0ZSBcdTYzQTggcmVuZGVyZXIgXHU2QTJBXHU1RTQ1O1x1ODQzRFx1NzZEOFx1NTQwRVx1NjMwOVx1OEQ0NFx1NEVBN1x1NTE0M1x1NjU3MFx1NjM2RSBzaXplIFx1NjgyMVx1OUE4Q1x1MzAwMiAqL1xyXG4gIGFzeW5jIGZ1bmN0aW9uIGRvd25sb2FkSW5zdGFsbGVyKGFzc2V0czogcmVhZG9ubHkgUmVsZWFzZUFzc2V0W10sIHRhZzogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCBhc3NldCA9IHBpY2tJbnN0YWxsZXJBc3NldChhc3NldHMpO1xyXG4gICAgICBpZiAoYXNzZXQgPT09IG51bGwpIHsgYnVtcFVwZGF0ZSh7IGVycm9yOiAncmVsZWFzZSBcdTY1RTBcdTVCODlcdTg4QzVcdTUzMDVcdThENDRcdTRFQTcnIH0pOyByZXR1cm47IH1cclxuICAgICAgY29uc3QgZGVzdCA9IGpvaW4oYXBwLmdldFBhdGgoJ3RlbXAnKSwgYXNzZXQubmFtZSk7XHJcbiAgICAgIC8vIFx1NEUwQVx1NkIyMVx1NEYxQVx1OEJERFx1NURGMlx1NjI4QVx1NTQwQ1x1NzI0OFx1NjcyQ1x1NUI4OVx1ODhDNVx1NTMwNVx1NUI4Q1x1NjU3NFx1NEUwQlx1NTIzMFx1NEUzNFx1NjVGNlx1NzZFRVx1NUY1NShzaXplIFx1NUJGOVx1NUY5N1x1NEUwQSlcdTIxOTIgXHU3NkY0XHU2M0E1XHU1OTBEXHU3NTI4LFxyXG4gICAgICAvLyBcdTRFMERcdTUxOERcdTYyQzkgMTEyTUI7XHU4RkQ5XHU1QzMxXHU2NjJGXCJcdTc1MjhcdTYyMzdcdTVGRkRcdTc1NjVcdTZBMkFcdTVFNDVcdTdFRTdcdTdFRURcdTc1MjgsXHU0RTBCXHU2QjIxXHU1NDJGXHU1MkE4XHU0RUNEXHU0RTAwXHU5NTJFXHU1M0VGXHU4OEM1XCJcdTc2ODRcdTg0M0RcdTU3MzBcdTMwMDJcclxuICAgICAgdHJ5IHtcclxuICAgICAgICBjb25zdCBzdCA9IGF3YWl0IHN0YXQoZGVzdCk7XHJcbiAgICAgICAgaWYgKHNpemVNYXRjaGVzKGFzc2V0LnNpemUsIHN0LnNpemUpKSB7XHJcbiAgICAgICAgICBpbnN0YWxsZXJQYXRoID0gZGVzdDtcclxuICAgICAgICAgIGJ1bXBVcGRhdGUoeyBkb3dubG9hZGVkOiB0cnVlLCBwcm9ncmVzczogbnVsbCB9KTtcclxuICAgICAgICAgIGxvZ0luZm8oJ3VwZGF0ZScsIGBcdTU5MERcdTc1MjhcdTVERjJcdTRFMEJcdThGN0QgJHthc3NldC5uYW1lfSgke01hdGgucm91bmQoc3Quc2l6ZSAvIDFlNil9TUIpIFx1MjE5MiAke2Rlc3R9YCk7XHJcbiAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICB9IGNhdGNoIHsgLyogXHU0RTBEXHU1QjU4XHU1NzI4XHU1MjE5XHU2QjYzXHU1RTM4XHU0RTBCXHU4RjdEICovIH1cclxuICAgICAgLy8gXHU0RTBCXHU4RjdEXHU1MDE5XHU5MDA5XHU5NEZFOmF0b21naXQgXHU1NDdEXHU0RTJEIFx1MjE5MiBhdG9tZ2l0IFx1NzZGNFx1OTRGRS9BUEkgXHU3QUVGXHU3MEI5XHU0RjE4XHU1MTQ4LEdpdEh1YiBcdTRFM0JcdTRFRDNcdTk1NUNcdTUwQ0ZcdTUxNUNcdTVFOTVcclxuICAgICAgY29uc3QgY2FuZGlkYXRlcyA9IGRvd25sb2FkQ2FuZGlkYXRlcyh7IGNoYW5uZWw6IHVwZGF0ZVN0YXRlLmNoYW5uZWwsIHRhZywgYXNzZXRVcmw6IGFzc2V0LmJyb3dzZXJfZG93bmxvYWRfdXJsLCBhc3NldE5hbWU6IGFzc2V0Lm5hbWUsIHJlcG9zOiBVUERBVEVfUkVQT1MgfSk7XHJcbiAgICAgIGxldCBsYXN0RXJyID0gJyc7XHJcbiAgICAgIGZvciAoY29uc3QgdSBvZiBjYW5kaWRhdGVzKSB7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgIGxvZ0luZm8oJ3VwZGF0ZScsIGB0cnlpbmcgJHtuZXcgVVJMKHUpLmhvc3R9XHUyMDI2YCk7XHJcbiAgICAgICAgICBjb25zdCByID0gYXdhaXQgZmV0Y2godSwgeyBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoOTAwXzAwMCkgfSk7XHJcbiAgICAgICAgICBpZiAoIXIub2spIHsgbGFzdEVyciA9IGBIVFRQICR7ci5zdGF0dXN9YDsgbG9nSW5mbygndXBkYXRlJywgYFx1MjE5MiBIVFRQICR7ci5zdGF0dXN9YCk7IGNvbnRpbnVlOyB9XHJcbiAgICAgICAgICBpZiAoci5ib2R5ID09PSBudWxsKSB7IGxhc3RFcnIgPSAnXHU2NUUwXHU1NENEXHU1RTk0XHU0RjUzJzsgY29udGludWU7IH1cclxuICAgICAgICAgIGNvbnN0IHRvdGFsID0gTnVtYmVyKHIuaGVhZGVycy5nZXQoJ2NvbnRlbnQtbGVuZ3RoJykgPz8gMCkgPiAwID8gTnVtYmVyKHIuaGVhZGVycy5nZXQoJ2NvbnRlbnQtbGVuZ3RoJykpIDogYXNzZXQuc2l6ZTtcclxuICAgICAgICAgIGNvbnN0IGRlc3RUbXAgPSBgJHtkZXN0fS5wYXJ0YDtcclxuICAgICAgICAgIGNvbnN0IG91dCA9IGNyZWF0ZVdyaXRlU3RyZWFtKGRlc3RUbXApO1xyXG4gICAgICAgICAgbGV0IHJlY2VpdmVkID0gMDtcclxuICAgICAgICAgIGxldCBsYXN0QnVtcCA9IDA7XHJcbiAgICAgICAgICBjb25zdCB0MCA9IERhdGUubm93KCk7XHJcbiAgICAgICAgICBjb25zdCByZWFkZXIgPSByLmJvZHkuZ2V0UmVhZGVyKCk7XHJcbiAgICAgICAgICBmb3IgKDs7KSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHsgZG9uZSwgdmFsdWUgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XHJcbiAgICAgICAgICAgIGlmIChkb25lID09PSB0cnVlIHx8IHZhbHVlID09PSB1bmRlZmluZWQpIGJyZWFrO1xyXG4gICAgICAgICAgICByZWNlaXZlZCArPSB2YWx1ZS5ieXRlTGVuZ3RoO1xyXG4gICAgICAgICAgICBvdXQud3JpdGUodmFsdWUpO1xyXG4gICAgICAgICAgICAvLyBcdThGREJcdTVFQTZcdTgyODJcdTZENDE6XHUyMjY0IFx1NkJDRiA0MDBtcyBcdTRFMDBcdTVFMjcsSVBDIFx1NEUwRFx1NkQyQVx1NkNEQjtcdTk5OTZcdTU3NTdcdTdBQ0JcdTUzNzNcdTRFMEFcdTYyQTUoXHU2MDNCXHU1QjU3XHU4MjgyXHU1QzNEXHU1RkVCXHU1M0VGXHU4OUMxKVxyXG4gICAgICAgICAgICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xyXG4gICAgICAgICAgICBpZiAocmVjZWl2ZWQgPT09IHZhbHVlLmJ5dGVMZW5ndGggfHwgbm93IC0gbGFzdEJ1bXAgPiA0MDApIHtcclxuICAgICAgICAgICAgICBsYXN0QnVtcCA9IG5vdztcclxuICAgICAgICAgICAgICBidW1wVXBkYXRlKHsgcHJvZ3Jlc3M6IHsgcmVjZWl2ZWQsIHRvdGFsLCBzcGVlZEJwczogTWF0aC5yb3VuZChyZWNlaXZlZCAvIE1hdGgubWF4KChub3cgLSB0MCkgLyAxMDAwLCAwLjEpKSB9IH0pO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPigocmVzLCByZWopID0+IHsgb3V0LmVuZCgoZXJyPzogRXJyb3IgfCBudWxsKSA9PiB7IGlmIChlcnIgIT09IG51bGwgJiYgZXJyICE9PSB1bmRlZmluZWQpIHJlaihlcnIpOyBlbHNlIHJlcygpOyB9KTsgfSk7XHJcbiAgICAgICAgICBpZiAocmVjZWl2ZWQgPCAxXzAwMF8wMDApIHsgbGFzdEVyciA9IGBcdTUxODVcdTVCQjlcdTVGMDJcdTVFMzgoJHtyZWNlaXZlZH1CKWA7IGxvZ0luZm8oJ3VwZGF0ZScsIGBcdTIxOTIgJHtsYXN0RXJyfWApOyBjb250aW51ZTsgfVxyXG4gICAgICAgICAgaWYgKCFzaXplTWF0Y2hlcyhhc3NldC5zaXplLCByZWNlaXZlZCkpIHsgbGFzdEVyciA9IGBzaXplIFx1NEUwRFx1N0IyNihcdTUxNDNcdTY1NzBcdTYzNkUgJHthc3NldC5zaXplfUIgLyBcdTVCOUVcdTY1MzYgJHtyZWNlaXZlZH1CKWA7IGxvZ0luZm8oJ3VwZGF0ZScsIGBcdTIxOTIgJHtsYXN0RXJyfWApOyBjb250aW51ZTsgfVxyXG4gICAgICAgICAgYXdhaXQgcmVuYW1lKGRlc3RUbXAsIGRlc3QpO1xyXG4gICAgICAgICAgaW5zdGFsbGVyUGF0aCA9IGRlc3Q7XHJcbiAgICAgICAgICBidW1wVXBkYXRlKHsgZG93bmxvYWRlZDogdHJ1ZSwgcHJvZ3Jlc3M6IG51bGwgfSk7XHJcbiAgICAgICAgICBsb2dJbmZvKCd1cGRhdGUnLCBgXHU1REYyXHU0RTBCXHU4RjdEICR7YXNzZXQubmFtZX0oJHtNYXRoLnJvdW5kKHJlY2VpdmVkIC8gMWU2KX1NQikgXHUyMTkyICR7ZGVzdH1gKTtcclxuICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgICAgIGNvbnN0IGUgPSBlcnIgYXMgeyBjYXVzZT86IHsgY29kZT86IHVua25vd24gfSB9O1xyXG4gICAgICAgICAgbGFzdEVyciA9IFN0cmluZyhlLmNhdXNlPy5jb2RlID8/IGVycikuc2xpY2UoMCwgODApO1xyXG4gICAgICAgICAgbG9nSW5mbygndXBkYXRlJywgYFx1MjE5MiBmYWlsICR7bGFzdEVycn1gKTtcclxuICAgICAgICAgIGJ1bXBVcGRhdGUoeyBwcm9ncmVzczogbnVsbCB9KTtcclxuICAgICAgICB9XHJcbiAgICAgIH1cclxuICAgICAgYnVtcFVwZGF0ZSh7IGVycm9yOiBgXHU0RTBCXHU4RjdEXHU1OTMxXHU4RDI1Olx1NTE2OFx1OTBFOFx1NEUwQlx1OEY3RFx1OTAxQVx1OTA1M1x1NTkzMVx1OEQyNSgke2xhc3RFcnJ9KWAuc2xpY2UoMCwgMTYwKSwgcHJvZ3Jlc3M6IG51bGwgfSk7XHJcbiAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgYnVtcFVwZGF0ZSh7IGVycm9yOiBgXHU0RTBCXHU4RjdEXHU1OTMxXHU4RDI1OiAke1N0cmluZyhlcnIpLnNsaWNlKDAsIDEyMCl9YCwgcHJvZ3Jlc3M6IG51bGwgfSk7XHJcbiAgICB9XHJcbiAgfVxyXG4gIGZ1bmN0aW9uIGFwcGx5VXBkYXRlKCk6IHZvaWQge1xyXG4gICAgLy8gXHU5QThDXHU2NTM2XHU1M0VGXHU4OUMyXHU2RDRCOlx1NkJDRlx1NkIyMSBhcHBseSBcdThCRjdcdTZDNDJcdTkwRkRcdTc1NTlcdTY1RTVcdTVGRDcobW9jay9cdTY1RTBcdTVCODlcdTg4QzVcdTUzMDVcdTY1RjZcdTcwQjlcdTUxRkJcIlx1OTFDRFx1NTQyRlx1NjZGNFx1NjVCMFwiXHJcbiAgICAvLyBcdTRFMERcdTkwMDBcdTUxRkEsVUlWRVJJRlkgXHU2NUFEXHU4QTAwXCJcdTcwQjlcdTUxRkJcdTU0MEVcdThGREJcdTdBMEJcdTVCNThcdTZEM0JcIlx1OTE0RFx1NTQwOFx1OEZEOVx1ODg0Q1x1NjVFNVx1NUZEN1x1Njc4NFx1NjIxMFx1NUI4Q1x1NjU3NFx1OEJDMVx1NjM2RVx1OTRGRSlcdTMwMDJcclxuICAgIGxvZ0luZm8oJ3VwZGF0ZScsIGBhcHBseSByZXF1ZXN0ZWQgKGluc3RhbGxlcj0ke2luc3RhbGxlclBhdGggPT09IG51bGwgPyAnbm9uZScgOiBiYXNlbmFtZShpbnN0YWxsZXJQYXRoKX0pYCk7XHJcbiAgICBpZiAoaW5zdGFsbGVyUGF0aCA9PT0gbnVsbCkgcmV0dXJuO1xyXG4gICAgLy8gXHU5MDAwXHU1MUZBXHU1RjUzXHU1MjREXHU1RTk0XHU3NTI4XHU1NDBFXHU3NTMxXHU1Qjg5XHU4OEM1XHU1NjY4XHU5NzU5XHU5RUQ4XHU4OTg2XHU3NkQ2XHU1Qjg5XHU4OEM1KFx1ODhDNVx1NTZERVx1NTM5Rlx1NzZFRVx1NUY1NSlcdTMwMDJOU0lTIGFzc2lzdGVkIFx1ODlDNFx1NTIxOTpcclxuICAgIC8vIC9TIFx1NEUxNCAvRD1wYXRoIFx1NUZDNVx1OTg3Qlx1NjcwMFx1NTQwRVx1NEUwMFx1NEUyQVx1NTNDMlx1NjU3MFx1MzAwMVx1NTAzQ1x1NEUwRFx1NTJBMFx1NUYxNVx1NTNGNyhcdTU0MkJcdTdBN0FcdTY4M0NcdTRFNUZcdTRFMERcdTUyQTApXHUyMDE0XHUyMDE0bm9kZSBzcGF3blxyXG4gICAgLy8gXHU5RUQ4XHU4QkE0XHU0RjFBXHU3RUQ5XHU1NDJCXHU3QTdBXHU2ODNDXHU1M0MyXHU2NTcwXHU1MkEwXHU1RjE1XHU1M0Y3XHU1QkZDXHU4MUY0IE5TSVMgXHU4OUUzXHU2NzkwXHU5NTE5XHU4REVGXHU1Rjg0KFx1NUI5RVx1NkQ0Qlx1ODhDNVx1NTc0Rlx1NzZFRVx1NUY1NSksXHU2NTQ1XHU3NTI4XHJcbiAgICAvLyB3aW5kb3dzVmVyYmF0aW1Bcmd1bWVudHMgXHU1MzlGXHU2ODM3XHU0RjIwXHU5MDEyXHUzMDAyXHJcbiAgICBjb25zdCBpbnN0YWxsRGlyID0gZGlybmFtZShwcm9jZXNzLmV4ZWNQYXRoKTtcclxuICAgIGNvbnN0IGNoaWxkID0gc3Bhd24oYFwiJHtpbnN0YWxsZXJQYXRofVwiIC9TIC9EPSR7aW5zdGFsbERpcn1gLCB7XHJcbiAgICAgIGRldGFjaGVkOiB0cnVlLFxyXG4gICAgICBzdGRpbzogJ2lnbm9yZScsXHJcbiAgICAgIHdpbmRvd3NIaWRlOiB0cnVlLFxyXG4gICAgICBzaGVsbDogZmFsc2UsXHJcbiAgICAgIHdpbmRvd3NWZXJiYXRpbUFyZ3VtZW50czogdHJ1ZSxcclxuICAgIH0pO1xyXG4gICAgY2hpbGQudW5yZWYoKTtcclxuICAgIGxvZ0luZm8oJ3VwZGF0ZScsIGBhcHBseTogJHtpbnN0YWxsZXJQYXRofSBcdTIxOTIgJHtpbnN0YWxsRGlyfWApO1xyXG4gICAgYXBwLmV4aXQoMCk7XHJcbiAgfVxyXG5cclxuICBmdW5jdGlvbiBidWlsZEFwcE1lbnUoKTogdm9pZCB7XHJcbiAgICAvLyBcdTdDQkVcdTdCODA6XHU1M0VBXHU0RkREXHU3NTU5IFVJIFx1NkNBMVx1NjcwOVx1NzY4NFx1N0NGQlx1N0VERlx1N0VBN1x1ODBGRFx1NTI5QihcdTUyNkFcdThEMzRcdTY3N0YvXHU3QTk3XHU1M0UzKTtcdTUxNzZcdTRGNTlcdTU1MkZcdTRFMDBcdTUxNjVcdTUzRTNcdTU3MjggVUlcdTMwMDJcclxuICAgIGNvbnN0IHRlbXBsYXRlOiBBcnJheTxFbGVjdHJvbi5NZW51SXRlbUNvbnN0cnVjdG9yT3B0aW9ucz4gPSBbXHJcbiAgICAgIHtcclxuICAgICAgICBsYWJlbDogJ1x1N0YxNlx1OEY5MScsXHJcbiAgICAgICAgc3VibWVudTogW1xyXG4gICAgICAgICAgeyByb2xlOiAndW5kbycsIGxhYmVsOiAnXHU2NEE0XHU5NTAwJyB9LFxyXG4gICAgICAgICAgeyByb2xlOiAncmVkbycsIGxhYmVsOiAnXHU5MUNEXHU1MDVBJyB9LFxyXG4gICAgICAgICAgeyB0eXBlOiAnc2VwYXJhdG9yJyB9LFxyXG4gICAgICAgICAgeyByb2xlOiAnY3V0JywgbGFiZWw6ICdcdTUyNkFcdTUyMDcnIH0sXHJcbiAgICAgICAgICB7IHJvbGU6ICdjb3B5JywgbGFiZWw6ICdcdTU5MERcdTUyMzYnIH0sXHJcbiAgICAgICAgICB7IHJvbGU6ICdwYXN0ZScsIGxhYmVsOiAnXHU3Qzk4XHU4RDM0JyB9LFxyXG4gICAgICAgICAgeyByb2xlOiAnc2VsZWN0QWxsJywgbGFiZWw6ICdcdTUxNjhcdTkwMDknIH0sXHJcbiAgICAgICAgXSxcclxuICAgICAgfSxcclxuICAgICAge1xyXG4gICAgICAgIGxhYmVsOiAnXHU3QTk3XHU1M0UzJyxcclxuICAgICAgICBzdWJtZW51OiBbXHJcbiAgICAgICAgICB7IHJvbGU6ICdtaW5pbWl6ZScsIGxhYmVsOiAnXHU2NzAwXHU1QzBGXHU1MzE2JyB9LFxyXG4gICAgICAgICAgeyByb2xlOiAnem9vbScsIGxhYmVsOiAnXHU3RjI5XHU2NTNFJyB9LFxyXG4gICAgICAgICAgeyB0eXBlOiAnc2VwYXJhdG9yJyB9LFxyXG4gICAgICAgICAgeyByb2xlOiAnY2xvc2UnLCBsYWJlbDogJ1x1NTE3M1x1OTVFRCcgfSxcclxuICAgICAgICBdLFxyXG4gICAgICB9LFxyXG4gICAgXTtcclxuICAgIE1lbnUuc2V0QXBwbGljYXRpb25NZW51KE1lbnUuYnVpbGRGcm9tVGVtcGxhdGUodGVtcGxhdGUpKTtcclxuICB9XHJcbiAgLyoqIFx1NjgwN1x1OTg5OFx1NjgwRiBcdTI2MzAgXHU0RTNCXHU4M0RDXHU1MzU1KFx1NUUzOFx1NzUyOFx1NTJBOFx1NEY1Q1x1NzY4NFx1NTUyRlx1NEUwMFx1NTE2NVx1NTNFMztcdTg5QzZcdTU2RkVcdTYwMDFcdTdFQ0YgbWVudTphY3Rpb24gXHU4RjZDXHU1M0QxKVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIHBvcHVwTWFpbk1lbnUoKTogdm9pZCB7XHJcbiAgICBjb25zdCBzZW5kID0gKGE6IHN0cmluZyk6IHZvaWQgPT4ge1xyXG4gICAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcclxuICAgICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCdtZW51OmFjdGlvbicsIGEpO1xyXG4gICAgICB9XHJcbiAgICB9O1xyXG4gICAgY29uc3Qgd2luID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkuZmluZCgodykgPT4gIXcuaXNEZXN0cm95ZWQoKSk7XHJcbiAgICBpZiAod2luID09PSB1bmRlZmluZWQpIHJldHVybjtcclxuICAgIE1lbnUuYnVpbGRGcm9tVGVtcGxhdGUoW1xyXG4gICAgICB7IGxhYmVsOiAnXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREJywgYWNjZWxlcmF0b3I6ICdDbWRPckN0cmwrTicsIGNsaWNrOiAoKTogdm9pZCA9PiBzZW5kKCduZXctc2Vzc2lvbicpIH0sXHJcbiAgICAgIHsgbGFiZWw6ICdcdThCQkVcdTdGNkUnLCBhY2NlbGVyYXRvcjogJ0NtZE9yQ3RybCtTaGlmdCtQJywgY2xpY2s6ICgpOiB2b2lkID0+IHNlbmQoJ29wZW4tc2V0dGluZ3MnKSB9LFxyXG4gICAgICB7IGxhYmVsOiAnXHU1RkVCXHU2Mzc3XHU5NTJFJywgYWNjZWxlcmF0b3I6ICdDbWRPckN0cmwrLycsIGNsaWNrOiAoKTogdm9pZCA9PiBzZW5kKCdzaG9ydGN1dHMnKSB9LFxyXG4gICAgICB7IHR5cGU6ICdzZXBhcmF0b3InIH0sXHJcbiAgICAgIHsgbGFiZWw6ICdcdTYyNEJcdTY3M0FcdThGRENcdTdBMEJcdTYzQTdcdTUyMzYnLCBjbGljazogKCk6IHZvaWQgPT4gc2VuZCgnb3Blbi1yZW1vdGUnKSB9LFxyXG4gICAgICB7IHR5cGU6ICdzZXBhcmF0b3InIH0sXHJcbiAgICAgIHtcclxuICAgICAgICBsYWJlbDogdXBkYXRlU3RhdGUuZG93bmxvYWRlZCA/IGBcdTkxQ0RcdTU0MkZcdTVFNzZcdTVCODlcdTg4QzVcdTY2RjRcdTY1QjAodiR7dXBkYXRlU3RhdGUubGF0ZXN0ID8/ICc/J30pYCA6ICdcdTY4QzBcdTY3RTVcdTY2RjRcdTY1QjBcdTIwMjYnLFxyXG4gICAgICAgIGNsaWNrOiAoKTogdm9pZCA9PiB7XHJcbiAgICAgICAgICBpZiAodXBkYXRlU3RhdGUuZG93bmxvYWRlZCkgeyBhcHBseVVwZGF0ZSgpOyByZXR1cm47IH1cclxuICAgICAgICAgIHZvaWQgY2hlY2tGb3JVcGRhdGVzKCkudGhlbigoc3QpID0+IHtcclxuICAgICAgICAgICAgY29uc3QgbmV3ZXIgPSBzdC5sYXRlc3QgIT09IG51bGwgJiYgKGNtcFZlcnNpb24oc3QuY3VycmVudFZlcnNpb24sIHN0LmxhdGVzdCkgPCAwIHx8IFVQREFURV9GT1JDRV9UQUcgIT09ICcnKTtcclxuICAgICAgICAgICAgY29uc3QgZGV0YWlsID0gbmV3ZXIgPyBgJHtzdC5ub3Rlc31cXG5cXG5cdTVCODlcdTg4QzVcdTUzMDVcdTZCNjNcdTU3MjhcdTU0MEVcdTUzRjBcdTRFMEJcdThGN0QsXHU1QjhDXHU2MjEwXHU1NDBFXHU5ODc2XHU5MEU4XHU2QTJBXHU1RTQ1XHU0RjFBXHU1MUZBXHU3M0IwXCJcdTkxQ0RcdTU0MkZcdTY2RjRcdTY1QjBcIlx1NEUwMFx1OTUyRVx1NUI4OVx1ODhDNShcdTY1RTBcdTk3MDBcdTYyNTNcdTVGMDBcdTRFMEJcdThGN0RcdTk4NzUpXHUzMDAyYCA6ICcnO1xyXG4gICAgICAgICAgICB2b2lkIGRpYWxvZy5zaG93TWVzc2FnZUJveCh3aW4sIHtcclxuICAgICAgICAgICAgICB0eXBlOiAnaW5mbycsXHJcbiAgICAgICAgICAgICAgdGl0bGU6ICdcdTY4QzBcdTY3RTVcdTY2RjRcdTY1QjAnLFxyXG4gICAgICAgICAgICAgIG1lc3NhZ2U6IG5ld2VyXHJcbiAgICAgICAgICAgICAgICA/IGBcdTUzRDFcdTczQjBcdTY1QjBcdTcyNDhcdTY3MkMgdiR7c3QubGF0ZXN0fSFgXHJcbiAgICAgICAgICAgICAgICA6IChzdC5lcnJvciAhPT0gJycgPyBgXHU2OEMwXHU2N0U1XHU1OTMxXHU4RDI1OiR7c3QuZXJyb3J9YCA6IGBcdTVERjJcdTY2MkZcdTY3MDBcdTY1QjBcdTcyNDhcdTY3MkModiR7c3QuY3VycmVudFZlcnNpb259KWApLFxyXG4gICAgICAgICAgICAgIGRldGFpbCxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICB9KTtcclxuICAgICAgICB9LFxyXG4gICAgICB9LFxyXG4gICAgICB7XHJcbiAgICAgICAgbGFiZWw6ICdcdTUxNzNcdTRFOEUgSE1IIERlc2t0b3AnLFxyXG4gICAgICAgIGNsaWNrOiAoKTogdm9pZCA9PiB7XHJcbiAgICAgICAgICB2b2lkIGRpYWxvZy5zaG93TWVzc2FnZUJveCh3aW4sIHtcclxuICAgICAgICAgICAgdHlwZTogJ2luZm8nLFxyXG4gICAgICAgICAgICB0aXRsZTogJ1x1NTE3M1x1NEU4RSBITUggRGVza3RvcCcsXHJcbiAgICAgICAgICAgIG1lc3NhZ2U6ICdITUggRGVza3RvcCcsXHJcbiAgICAgICAgICAgIGRldGFpbDogYGFwcCB2JHthcHAuZ2V0VmVyc2lvbigpfSBcdTAwQjcgXHU2NkY0XHU2NUIwXHU5MDFBXHU5MDUzOiR7dXBkYXRlU3RhdGUuY2hhbm5lbCB8fCAnLSd9XFxucnVudGltZTogaG1oYXJuZXNzICR7YnJpZGdlLmhvc3RWZXJzaW9uID8/ICcoXHU2NzJBXHU4RkRFXHU2M0E1KSd9JHt1c2VCdW5kbGVkUnVudGltZSA/ICcoXHU1MTg1XHU3RjZFKScgOiAnJ31cXG5cdTZBMjFcdTVGMEY6ICR7YnJpZGdlLm1vZGUgPT09ICdyZWFsJyA/ICh1c2VCdW5kbGVkUnVudGltZSA/ICdcdTc3MUZcdTVCOUUgaG1oYXJuZXNzKFx1NTE4NVx1N0Y2RSBydW50aW1lKScgOiAnXHU3NzFGXHU1QjlFIGhtaGFybmVzcyhcdTU5MTZcdTkwRThcdTVCODlcdTg4QzUpJykgOiAnXHU2RjE0XHU3OTNBKFx1NTA0N1x1NjU3MFx1NjM2RSknfVxcblxcblx1NEUwRSBDTEkgLyBUVUkgLyBcdTdGNTFcdTk4NzVcdTcyNDhcdTUxNzFcdTRFQUJcdTU0MENcdTRFMDAgSE1IX0hPTUVcdTMwMDJgLFxyXG4gICAgICAgICAgfSk7XHJcbiAgICAgICAgfSxcclxuICAgICAgfSxcclxuICAgICAgeyBsYWJlbDogJ1x1OTAwMFx1NTFGQScsIHJvbGU6ICdxdWl0JyB9LFxyXG4gICAgXSkucG9wdXAoeyB3aW5kb3c6IHdpbiB9KTtcclxuICB9XHJcblxyXG4gIC8qIC0tLS0gXHU2MjRCXHU2NzNBXHU4RkRDXHU3QTBCXHU2M0E3XHU1MjM2KDAzIFx1NTNGNzpXZWIgNzc4OCBcdTY2MkZcdTZENEZcdTg5QzhcdTU2NjgvXHU4RkRDXHU3QTBCL1x1NjI0Qlx1NjczQVx1NTE2NVx1NTNFMyxBRFItMDA1OlxyXG4gICAgIERlc2t0b3AgXHU0RTBEXHU5RUQ4XHU4QkE0XHU2MjUzXHU1RjAwIExBTiBcdTIwMTRcdTIwMTQgXHU4RkQ5XHU5MUNDXHU2NjJGXHU3NTI4XHU2MjM3XHU2NjNFXHU1RjBGXHU1NDJGXHU1MkE4XHU3Njg0XHU1MTY1XHU1M0UzKSAtLS0tICovXHJcbiAgY29uc3QgV0VCX1BPUlQgPSA3Nzg4O1xyXG4gIGFzeW5jIGZ1bmN0aW9uIHByb2JlV2ViUmVtb3RlKCk6IFByb21pc2U8eyB1cDogYm9vbGVhbjsgdmVyc2lvbjogc3RyaW5nIH0+IHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHIgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke1dFQl9QT1JUfS9hcGkvc3RhdGVgLCB7IHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCgxNTAwKSB9KTtcclxuICAgICAgaWYgKCFyLm9rKSByZXR1cm4geyB1cDogZmFsc2UsIHZlcnNpb246ICcnIH07XHJcbiAgICAgIGNvbnN0IGQgPSAoYXdhaXQgci5qc29uKCkpIGFzIHsgZGFlbW9uVmVyc2lvbj86IHN0cmluZyB9O1xyXG4gICAgICByZXR1cm4geyB1cDogdHJ1ZSwgdmVyc2lvbjogU3RyaW5nKGQuZGFlbW9uVmVyc2lvbiA/PyAnJykgfTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4geyB1cDogZmFsc2UsIHZlcnNpb246ICcnIH07IH1cclxuICB9XHJcbiAgLyoqIFx1NUYwMFx1NjczQVx1ODFFQVx1NTQyRlx1NjYyRlx1NTQyNlx1NURGMlx1ODhDNShydW50aW1lIHdlYi1kYWVtb24gXHU3Njg0XHU1NDJGXHU1MkE4XHU5ODc5XHU2NTg3XHU0RUY2XHU1QjU4XHU1NzI4XHU2MDI3OzAuMjMuMzcgXHU2NUIwXHU4MEZEXHU1MjlCKVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIHdlYkF1dG9zdGFydEluc3RhbGxlZCgpOiBib29sZWFuIHtcclxuICAgIGNvbnN0IGhvbWUgPSBwcm9jZXNzLmVudi5IT01FID8/ICcnO1xyXG4gICAgY29uc3QgY2FuZGlkYXRlcyA9IHByb2Nlc3MucGxhdGZvcm0gPT09ICd3aW4zMidcclxuICAgICAgPyBbam9pbihwcm9jZXNzLmVudi5BUFBEQVRBID8/ICcnLCAnTWljcm9zb2Z0JywgJ1dpbmRvd3MnLCAnU3RhcnQgTWVudScsICdQcm9ncmFtcycsICdTdGFydHVwJywgJ2htaGFybmVzcy13ZWItZGFlbW9uLmNtZCcpXVxyXG4gICAgICA6IHByb2Nlc3MucGxhdGZvcm0gPT09ICdkYXJ3aW4nXHJcbiAgICAgICAgPyBbam9pbihob21lLCAnTGlicmFyeScsICdMYXVuY2hBZ2VudHMnLCAnaG1oYXJuZXNzLXdlYi1kYWVtb24ucGxpc3QnKV1cclxuICAgICAgICA6IFtqb2luKGhvbWUsICcuY29uZmlnJywgJ3N5c3RlbWQnLCAndXNlcicsICdobWhhcm5lc3Mtd2ViLWRhZW1vbi5zZXJ2aWNlJyldO1xyXG4gICAgcmV0dXJuIGNhbmRpZGF0ZXMuc29tZSgocCkgPT4geyB0cnkgeyByZXR1cm4gZXhpc3RzU3luYyhwKTsgfSBjYXRjaCB7IHJldHVybiBmYWxzZTsgfSB9KTtcclxuICB9XHJcbiAgLyoqIFx1NjI0Qlx1NjczQVx1NTNFRlx1OERFRlx1NzUzMVx1NzY4NCBMQU4gSVAoUkZDMTkxOCxcdTYzOTJcdTk2NjRcdTg2NUFcdTYyREZcdTdGNTFcdTUzNjEpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gbGFuSXBPZigpOiBzdHJpbmcge1xyXG4gICAgY29uc3QgVklSVFVBTCA9IC92bXdhcmV8dmlydHVhbHxoeXBlci0/dnx2ZXRoZXJuZXR8d3NsfHRhaWxzY2FsZXxsb29wYmFja3xibHVldG9vdGh8dmJveHxkb2NrZXJ8dGFwLXxwc2V1ZG8vaTtcclxuICAgIGNvbnN0IGlzUmZjMTkxOCA9IChhOiBzdHJpbmcpOiBib29sZWFuID0+IC9eMTBcXC4vLnRlc3QoYSkgfHwgL14xOTJcXC4xNjhcXC4vLnRlc3QoYSkgfHwgL14xNzJcXC4oMVs2LTldfDJcXGR8M1swMV0pXFwuLy50ZXN0KGEpO1xyXG4gICAgbGV0IGxhbklwID0gJyc7XHJcbiAgICBsZXQgZmFsbGJhY2sgPSAnJztcclxuICAgIGZvciAoY29uc3QgW25hbWUsIGxpc3RdIG9mIE9iamVjdC5lbnRyaWVzKG5ldHdvcmtJbnRlcmZhY2VzKCkpKSB7XHJcbiAgICAgIGZvciAoY29uc3QgbiBvZiBsaXN0ID8/IFtdKSB7XHJcbiAgICAgICAgaWYgKG4uZmFtaWx5ICE9PSAnSVB2NCcgfHwgbi5pbnRlcm5hbCB8fCAhaXNSZmMxOTE4KG4uYWRkcmVzcykpIGNvbnRpbnVlO1xyXG4gICAgICAgIGlmICghVklSVFVBTC50ZXN0KG5hbWUpKSBsYW5JcCA9IGxhbklwIHx8IG4uYWRkcmVzcztcclxuICAgICAgICBlbHNlIGZhbGxiYWNrID0gZmFsbGJhY2sgfHwgbi5hZGRyZXNzO1xyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gbGFuSXAgfHwgZmFsbGJhY2s7XHJcbiAgfVxyXG4gIC8qKiBDTEkgXHU1MTY1XHU1M0UzOlx1NkU5MFx1NzgwMSByZXBvIFx1NUUwM1x1NUM0MChtYWluLnRzLFx1N0VDRiB0c3gpXHU2MjE2IG5wbSBcdTVCODlcdTg4QzVcdTVFMDNcdTVDNDAoZGlzdC9tYWluLmpzXHJcbiAgICogIFx1NzZGNFx1OEREMVx1MjAxNFx1MjAxNFx1NEVDRSBydW50aW1lIFx1NTE2NVx1NTNFM1x1NEUwQVx1NkVBRlx1NjI3RSBAaG1oYXJuZXNzL2NsaSBcdTUzMDU7XHU1RDRDXHU1OTU3L1x1NjNEMFx1NTM0Ny9cdTZFOTBcdTc4MDFcdTRFMDlcdTc5Q0RcdTVFMDNcdTVDNDBcdTkwMUFcdTU0MDMpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gY2xpRW50cnlPZigpOiBzdHJpbmcge1xyXG4gICAgaWYgKHJ1bnRpbWVFbnRyeSA9PT0gJycgfHwgcnVudGltZUVudHJ5ID09PSBudWxsKSByZXR1cm4gJyc7XHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCBwID0gam9pbihyZXBvUm9vdE9mKHJ1bnRpbWVFbnRyeSksICdwYWNrYWdlcycsICdjbGknLCAnc3JjJywgJ21haW4udHMnKTtcclxuICAgICAgaWYgKGV4aXN0c1N5bmMocCkpIHJldHVybiBwO1xyXG4gICAgfSBjYXRjaCB7IC8qIFx1OTc1RSByZXBvIFx1NUUwM1x1NUM0MCAqLyB9XHJcbiAgICBsZXQgZGlyID0gZGlybmFtZShydW50aW1lRW50cnkpO1xyXG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCA4OyBpKyspIHtcclxuICAgICAgaWYgKGV4aXN0c1N5bmMoam9pbihkaXIsICdkaXN0JywgJ21haW4uanMnKSkgJiYgcGtnTmFtZUF0KGRpcikgPT09ICdAaG1oYXJuZXNzL2NsaScpIHJldHVybiBqb2luKGRpciwgJ2Rpc3QnLCAnbWFpbi5qcycpO1xyXG4gICAgICBpZiAoYmFzZW5hbWUoZGlyKSA9PT0gJ0BobWhhcm5lc3MnICYmIGV4aXN0c1N5bmMoam9pbihkaXIsICdjbGknLCAnZGlzdCcsICdtYWluLmpzJykpKSByZXR1cm4gam9pbihkaXIsICdjbGknLCAnZGlzdCcsICdtYWluLmpzJyk7XHJcbiAgICAgIGNvbnN0IHBhcmVudCA9IGRpcm5hbWUoZGlyKTtcclxuICAgICAgaWYgKHBhcmVudCA9PT0gZGlyKSBicmVhaztcclxuICAgICAgZGlyID0gcGFyZW50O1xyXG4gICAgfVxyXG4gICAgcmV0dXJuICcnO1xyXG4gIH1cclxuICBmdW5jdGlvbiBydW5DbGkoYXJnczogc3RyaW5nW10pOiB2b2lkIHtcclxuICAgIGNvbnN0IGVudHJ5ID0gY2xpRW50cnlPZigpO1xyXG4gICAgaWYgKGVudHJ5ID09PSAnJykgcmV0dXJuO1xyXG4gICAgY29uc3QgaXNUcyA9IGVudHJ5LmVuZHNXaXRoKCcudHMnKTtcclxuICAgIGNvbnN0IHJlcG8gPSByZXBvUm9vdE9mKHJ1bnRpbWVFbnRyeSA/PyBlbnRyeSk7XHJcbiAgICBjb25zdCBjaGlsZCA9IHNwYXduKHByb2Nlc3MuZXhlY1BhdGgsIGlzVHMgPyBbJy0taW1wb3J0JywgJ3RzeCcsIGVudHJ5LCAuLi5hcmdzXSA6IFtlbnRyeSwgLi4uYXJnc10sIHtcclxuICAgICAgY3dkOiBpc1RzID8gcmVwbyA6IGRpcm5hbWUoZW50cnkpLFxyXG4gICAgICBkZXRhY2hlZDogdHJ1ZSxcclxuICAgICAgc3RkaW86ICdpZ25vcmUnLFxyXG4gICAgICB3aW5kb3dzSGlkZTogdHJ1ZSxcclxuICAgICAgZW52OiB7IEVMRUNUUk9OX1JVTl9BU19OT0RFOiAnMScgfSxcclxuICAgIH0pO1xyXG4gICAgY2hpbGQudW5yZWYoKTtcclxuICB9XHJcblxyXG4gIGZ1bmN0aW9uIGJyb2FkY2FzdEhvc3RTdGF0ZShzOiBIb3N0U3RhdGUsIGluZm86IHsgcmVzdGFydENvdW50OiBudW1iZXI7IGxhc3RFcnJvcj86IHN0cmluZyB9KTogdm9pZCB7XHJcbiAgICBicmlkZ2UgPSB7IC4uLmJyaWRnZSwgaG9zdFN0YXRlOiBzLCBob3N0UG9ydDogc3VwZXJ2aXNvcj8uZW5kcG9pbnQ/LnBvcnQgPz8gbnVsbCwgaG9zdFZlcnNpb246IHN1cGVydmlzb3I/LmVuZHBvaW50Py52ZXJzaW9uID8/IG51bGwgfTtcclxuICAgIGxvZ0luZm8oJ2hvc3QnLCBgc3RhdGU9JHtzfSR7aW5mby5sYXN0RXJyb3IgIT09IHVuZGVmaW5lZCA/IGAgZXJyPSR7aW5mby5sYXN0RXJyb3J9YCA6ICcnfWApO1xyXG4gICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XHJcbiAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ2JyaWRnZTpob3N0LXN0YXRlJywgcywgaW5mbyk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvKiogU1NFIFx1NkQ0MVx1OEJBMlx1OTYwNTpcdTRGRTFcdTVDMDEoZXZlbnQ6IGhtaClcdTYyNzlcdTkxQ0ZcdTYzQTggcmVuZGVyZXI7XHU5QUQ4XHU5ODkxIGRlbHRhL2xpbmUgXHU1MzlGXHU1RTI3XHJcbiAgICogIFx1NEY1Q1x1NEUzQVx1NkQ0MVx1NTc1N1x1OEY2Q1x1NTNEMShyZW5kZXJlciBcdTYyRkNcdTYzQTVcdTVGNTNcdTUyNEQgYXNzaXN0YW50IFx1NTM2MFx1NEY0RClcdTMwMDJcdTY1QURcdTdFQkZcdTgxRUFcdTUyQThcdTkxQ0RcdThGREVcdTMwMDIgKi9cclxuICBhc3luYyBmdW5jdGlvbiBwdW1wRXZlbnRzKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgaWYgKGNsaWVudCA9PT0gbnVsbCkgcmV0dXJuO1xyXG4gICAgZm9yICg7Oykge1xyXG4gICAgICBjb25zdCBjID0gY2xpZW50O1xyXG4gICAgICBpZiAoYyA9PT0gbnVsbCkgcmV0dXJuO1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGZvciBhd2FpdCAoY29uc3QgZnJhbWUgb2YgYy5yYXdFdmVudHMobGFzdEV2ZW50SWQgPT09ICcnID8gdW5kZWZpbmVkIDogbGFzdEV2ZW50SWQsIHNzZUFib3J0Py5zaWduYWwpKSB7XHJcbiAgICAgICAgICBpZiAoZnJhbWUuZXZlbnQgPT09ICdobWgnKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGVudiA9IGVudmVsb3BlRnJvbUZyYW1lKGZyYW1lKTtcclxuICAgICAgICAgICAgaWYgKGVudiA9PT0gbnVsbCkge1xyXG4gICAgICAgICAgICAgIGRyb3BwZWRGcmFtZXMgKz0gMTtcclxuICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBsYXN0RXZlbnRJZCA9IGVudi5ldmVudElkO1xyXG4gICAgICAgICAgICBwdXNoRXZlbnQoZW52KTtcclxuICAgICAgICAgIH0gZWxzZSBpZiAoZnJhbWUuZXZlbnQgPT09ICdkZWx0YScgfHwgZnJhbWUuZXZlbnQgPT09ICdsaW5lJykge1xyXG4gICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgIGNvbnN0IGQgPSBKU09OLnBhcnNlKGZyYW1lLmRhdGEpIGFzIHsgc2Vzc2lvbklkPzogc3RyaW5nOyBrPzogc3RyaW5nOyBjaHVuaz86IHN0cmluZzsgdGV4dD86IHN0cmluZyB9O1xyXG4gICAgICAgICAgICAgIGNvbnN0IHBheWxvYWQgPSBmcmFtZS5ldmVudCA9PT0gJ2RlbHRhJ1xyXG4gICAgICAgICAgICAgICAgPyB7IHNlc3Npb25JZDogZC5zZXNzaW9uSWQgPz8gJycsIGtpbmQ6IGQuayA/PyAndGV4dCcsIGNodW5rOiBTdHJpbmcoZC5jaHVuayA/PyAnJykgfVxyXG4gICAgICAgICAgICAgICAgOiB7IHNlc3Npb25JZDogZC5zZXNzaW9uSWQgPz8gJycsIGtpbmQ6ICdsaW5lJywgY2h1bms6IFN0cmluZyhkLnRleHQgPz8gJycpIH07XHJcbiAgICAgICAgICAgICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XHJcbiAgICAgICAgICAgICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCdicmlkZ2U6c3RyZWFtLWNodW5rJywgcGF5bG9hZCk7XHJcbiAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9IGNhdGNoIHsgLyogbWFsZm9ybWVkIHN0cmVhbSBmcmFtZTogc2tpcCAqLyB9XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybjsgLy8gXHU2RDQxXHU2QjYzXHU1RTM4XHU3RUQzXHU2NzVGKGhvc3QgXHU1MTczXHU5NUVEKVxyXG4gICAgICB9IGNhdGNoIHtcclxuICAgICAgICAvLyBcdTY1QURcdTdFQkY6XHU3N0VEXHU5MDAwXHU5MDdGXHU1NDBFXHU5MUNEXHU4RkRFKHN1cGVydmlzb3IgXHU1M0VGXHU4MEZEXHU2QjYzXHU1NzI4XHU5MUNEXHU1NDJGIGhvc3QpXHJcbiAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgMV8wMDApKTtcclxuICAgICAgICBpZiAoc3NlQWJvcnQ/LnNpZ25hbC5hYm9ydGVkKSByZXR1cm47XHJcbiAgICAgIH1cclxuICAgIH1cclxuICB9XHJcblxyXG4gIC8qIC0tLS0gaG1oYXJuZXNzIHJ1bnRpbWUgXHU4MUVBXHU1MkE4XHU1M0QxXHU3M0IwKDIwMjYtMTAtMTAgXHU3NTI4XHU2MjM3XHU1QjlBXHU4QzAzOlx1ODhDNVx1OEZDNyBobWhhcm5lc3MgXHU3Njg0XHJcbiAgICAgXHU2NzNBXHU1NjY4XHU5NkY2XHU5MTREXHU3RjZFXHU3NkY0XHU4RkRFLFx1NTkwRFx1NzUyOCBDTEkvVFVJL3dlYiA3Nzg4IFx1NzY4NFx1NTQwQ1x1NEUwMCBITUhfSE9NRVx1MjAxNFx1MjAxNGNvbmZpZy9wcm92aWRlcnMvXHJcbiAgICAgXHU0RjFBXHU4QkREXHU1Mzg2XHU1M0YyXHU1OTI5XHU3MTM2XHU1MTcxXHU0RUFCKVx1MzAwMnY1LjEgXHU1M0QxXHU3M0IwXHU5ODdBXHU1RThGOlx1NjYzRVx1NUYwRlx1OTE0RFx1N0Y2RSA+IHdoZXJlIGhtaChcdTZFOTBcdTc4MDEgbGluayBcdTRFMEVcclxuICAgICBAaG1oYXJuZXNzL2NsaSBucG0gXHU1Qjg5XHU4OEM1XHU0RTI0XHU3OUNEXHU1RTAzXHU1QzQwKT4gbnBtIFx1NTE2OFx1NUM0MFx1NjgzOShcdTU0MEMpPiBcdTU0MTFcdTVCRkNcdTVCODlcdTg4QzVcdTc2RUVcdTVGNTVcclxuICAgICB+Ly5obWhhcm5lc3MtZ2xvYmFsID4gXHU1RTM4XHU4OUMxXHU2RTkwXHU3ODAxXHU0RjREXHU3RjZFXHUzMDAyICovXHJcbiAgY29uc3QgcnVudGltZUNvbmZpZ0ZpbGUgPSAoKTogc3RyaW5nID0+IGpvaW4oYXBwLmdldFBhdGgoJ3VzZXJEYXRhJyksICdydW50aW1lLmpzb24nKTtcclxuICAvKiogcnVudGltZS5qc29uOnsgZW50cnkoXHU2MjRCXHU1MkE4L1x1NTQxMVx1NUJGQ1x1OTAwOVx1NjJFOVx1NzY4NFx1NTE2NVx1NTNFMyksIGRlbW8oXHU2MzAxXHU0RTQ1XHU2RjE0XHU3OTNBXHU2QTIxXHU1RjBGKSB9XHUzMDAyICovXHJcbiAgYXN5bmMgZnVuY3Rpb24gbG9hZFJ1bnRpbWVDb25maWcoKTogUHJvbWlzZTx7IGVudHJ5OiBzdHJpbmc7IGRlbW86IGJvb2xlYW4gfT4ge1xyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3QgdiA9IEpTT04ucGFyc2UoYXdhaXQgcmVhZEZpbGUocnVudGltZUNvbmZpZ0ZpbGUoKSwgJ3V0ZjgnKSkgYXMgeyBlbnRyeT86IHVua25vd247IGRlbW8/OiB1bmtub3duIH07XHJcbiAgICAgIHJldHVybiB7XHJcbiAgICAgICAgZW50cnk6IHR5cGVvZiB2LmVudHJ5ID09PSAnc3RyaW5nJyAmJiB2LmVudHJ5ICE9PSAnJyAmJiBpc0Fic29sdXRlKHYuZW50cnkpID8gdi5lbnRyeSA6ICcnLFxyXG4gICAgICAgIGRlbW86IHYuZGVtbyA9PT0gdHJ1ZSxcclxuICAgICAgfTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4geyBlbnRyeTogJycsIGRlbW86IGZhbHNlIH07IH1cclxuICB9XHJcbiAgYXN5bmMgZnVuY3Rpb24gc2F2ZVJ1bnRpbWVDb25maWcoY2ZnOiB7IGVudHJ5OiBzdHJpbmc7IGRlbW86IGJvb2xlYW4gfSk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgYXdhaXQgd3JpdGVGaWxlKHJ1bnRpbWVDb25maWdGaWxlKCksIEpTT04uc3RyaW5naWZ5KGNmZywgbnVsbCwgMiksICd1dGY4JykuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcclxuICB9XHJcbiAgYXN5bmMgZnVuY3Rpb24gbG9hZFJ1bnRpbWVFbnRyeU92ZXJyaWRlKCk6IFByb21pc2U8c3RyaW5nPiB7XHJcbiAgICByZXR1cm4gKGF3YWl0IGxvYWRSdW50aW1lQ29uZmlnKCkpLmVudHJ5O1xyXG4gIH1cclxuICBhc3luYyBmdW5jdGlvbiBzYXZlUnVudGltZUVudHJ5T3ZlcnJpZGUoZW50cnk6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgYXdhaXQgc2F2ZVJ1bnRpbWVDb25maWcoeyBlbnRyeSwgZGVtbzogKGF3YWl0IGxvYWRSdW50aW1lQ29uZmlnKCkpLmRlbW8gfSk7XHJcbiAgfVxyXG5cclxuICBpbnRlcmZhY2UgRXh0ZXJuYWxSdW50aW1lIHsgZW50cnk6IHN0cmluZzsgdmVyc2lvbjogc3RyaW5nOyBzb3VyY2U6IHN0cmluZyB9XHJcblxyXG4gIC8qKiBcdThCRkJcdTUzMDVcdTcyNDhcdTY3MkMocGFja2FnZS5qc29uIFx1NzY4NCB2ZXJzaW9uIFx1NUI1N1x1NkJCNTtcdTU5MzFcdThEMjVcdTdBN0FcdTRFMzIpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gcGtnVmVyc2lvbkF0KGRpcjogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHYgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKGRpciwgJ3BhY2thZ2UuanNvbicpLCAndXRmOCcpKSBhcyB7IHZlcnNpb24/OiB1bmtub3duIH07XHJcbiAgICAgIHJldHVybiB0eXBlb2Ygdi52ZXJzaW9uID09PSAnc3RyaW5nJyA/IHYudmVyc2lvbiA6ICcnO1xyXG4gICAgfSBjYXRjaCB7IHJldHVybiAnJzsgfVxyXG4gIH1cclxuICAvKiogXHU4QkZCXHU1MzA1XHU1NDBEKFx1NTQwQ1x1NEUwQTtAaG1oYXJuZXNzL2NsaSBcdTVFMDNcdTVDNDBcdThCQzZcdTUyMkJcdTc1MjgpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gcGtnTmFtZUF0KGRpcjogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHYgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKGRpciwgJ3BhY2thZ2UuanNvbicpLCAndXRmOCcpKSBhcyB7IG5hbWU/OiB1bmtub3duIH07XHJcbiAgICAgIHJldHVybiB0eXBlb2Ygdi5uYW1lID09PSAnc3RyaW5nJyA/IHYubmFtZSA6ICcnO1xyXG4gICAgfSBjYXRjaCB7IHJldHVybiAnJzsgfVxyXG4gIH1cclxuXHJcbiAgLyoqIG5wbSBcdTVCODlcdTg4QzVcdTc2ODQgQGhtaGFybmVzcy9jbGkgXHUyMTkyIGRlc2t0b3AtaG9zdCBcdTdGMTZcdThCRDFcdTUxNjVcdTUzRTMoXHU1RDRDXHU1OTU3XHU0RTBFXHU2M0QwXHU1MzQ3XHU0RTI0XHU3OUNEXHU1RTAzXHU1QzQwKVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIGVudHJ5RnJvbUNsaURpcihjbGlEaXI6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICBjb25zdCBuZXN0ZWQgPSBqb2luKGNsaURpciwgJ25vZGVfbW9kdWxlcycsICdAaG1oYXJuZXNzJywgJ3dlYicsICdkaXN0JywgJ2Rlc2t0b3AtaG9zdC5qcycpO1xyXG4gICAgaWYgKGV4aXN0c1N5bmMobmVzdGVkKSkgcmV0dXJuIG5lc3RlZDtcclxuICAgIGNvbnN0IGhvaXN0ZWQgPSBqb2luKGRpcm5hbWUoY2xpRGlyKSwgJ3dlYicsICdkaXN0JywgJ2Rlc2t0b3AtaG9zdC5qcycpO1xyXG4gICAgaWYgKGV4aXN0c1N5bmMoaG9pc3RlZCkpIHJldHVybiBob2lzdGVkO1xyXG4gICAgcmV0dXJuICcnO1xyXG4gIH1cclxuXHJcbiAgLyoqIFx1NTkxNlx1OTBFOFx1NTNEMVx1NzNCMChcdTRGOUJcdTgxRUFcdTUyQThcdThGREVcdTYzQTVcdTRFMEVcdTU0MTFcdTVCRkNcdTY4QzBcdTZENEJcdTk4NzVcdTUxNzFcdTc1MjgpXHUzMDAyXHU0RjE4XHU1MTQ4XHU3RUE3OmVudiA+IHdoZXJlIGhtaCA+IG5wbVxyXG4gICAqICBcdTUxNjhcdTVDNDBcdTY4MzkgPiBcdTU0MTFcdTVCRkNcdTVCODlcdTg4QzVcdTc2RUVcdTVGNTUgfi8uaG1oYXJuZXNzLWdsb2JhbCA+IFx1NkU5MFx1NzgwMVx1NEVEM1x1NjI2Qlx1NjNDRjtcdTU0MENcdTRFMDBcdTVDNDJcdTUxODVcclxuICAgKiAgXCJcdTVERjJcdTg4QzUgQ0xJKG5wbSBcdTVFMDNcdTVDNDApXCIgXHU1MTQ4XHU0RThFIFwiXHU2RTkwXHU3ODAxIHJlcG8gXHU1RTAzXHU1QzQwXCJcdTMwMDIgKi9cclxuICBmdW5jdGlvbiBkZXRlY3RFeHRlcm5hbFJ1bnRpbWUoKTogRXh0ZXJuYWxSdW50aW1lIHtcclxuICAgIC8vIDEpIFx1NzNBRlx1NTg4M1x1NTNEOFx1OTFDRlx1NjYzRVx1NUYwRlx1ODk4Nlx1NzZENihcdTlBRDhcdTdFQTdcdTc1MjhcdTYyMzcpXHJcbiAgICBjb25zdCBlbnZFbnRyeSA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1JFQUxfRU5UUlk7XHJcbiAgICBpZiAoZW52RW50cnkgIT09IHVuZGVmaW5lZCAmJiBlbnZFbnRyeSAhPT0gJycgJiYgaXNBYnNvbHV0ZShlbnZFbnRyeSkpIHtcclxuICAgICAgcmV0dXJuIHsgZW50cnk6IGVudkVudHJ5LCB2ZXJzaW9uOiAnJywgc291cmNlOiAnZW52JyB9O1xyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IHdoZXJlUmVwb3MgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgIGNvbnN0IHdoZXJlQ2xpczogc3RyaW5nW10gPSBbXTtcclxuICAgIGNvbnN0IG5wbVJlcG9zID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICBsZXQgbnBtQ2xpID0gJyc7XHJcbiAgICAvLyAyKSB3aGVyZSBobWg6bnBtIGxpbmsoXHU2RTkwXHU3ODAxXHU2ODM5XHU1RTAzXHU1QzQwKVx1NEUwRSBAaG1oYXJuZXNzL2NsaSBucG0gXHU1Qjg5XHU4OEM1XHU1RTAzXHU1QzQwXHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCBvdXQgPSBleGVjRmlsZVN5bmMoJ3doZXJlJywgWydobWgnXSwgeyBlbmNvZGluZzogJ3V0ZjgnLCB0aW1lb3V0OiA0XzAwMCwgd2luZG93c0hpZGU6IHRydWUgfSk7XHJcbiAgICAgIGZvciAoY29uc3QgbGluZSBvZiBvdXQuc3BsaXQoL1xccj9cXG4vKSkge1xyXG4gICAgICAgIGNvbnN0IGJpbiA9IGxpbmUudHJpbSgpO1xyXG4gICAgICAgIGlmIChiaW4gPT09ICcnKSBjb250aW51ZTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgY29uc3QgYmluRGlyID0gZGlybmFtZShiaW4pO1xyXG4gICAgICAgICAgY29uc3QgbGlua2VkID0gam9pbihiaW5EaXIsICdub2RlX21vZHVsZXMnLCAnaG1oYXJuZXNzJyk7XHJcbiAgICAgICAgICBpZiAoZXhpc3RzU3luYyhsaW5rZWQpKSB3aGVyZVJlcG9zLmFkZChyZWFscGF0aFN5bmMobGlua2VkKSk7XHJcbiAgICAgICAgICBjb25zdCBjbGkgPSBqb2luKGJpbkRpciwgJ25vZGVfbW9kdWxlcycsICdAaG1oYXJuZXNzJywgJ2NsaScpO1xyXG4gICAgICAgICAgaWYgKGV4aXN0c1N5bmMoY2xpKSkgd2hlcmVDbGlzLnB1c2goY2xpKTtcclxuICAgICAgICB9IGNhdGNoIHsgLyogYmluIFx1NUUwM1x1NUM0MFx1NEUwRFx1N0IyNixcdThERjNcdThGQzcgKi8gfVxyXG4gICAgICB9XHJcbiAgICB9IGNhdGNoIHsgLyogaG1oIFx1NEUwRFx1NTcyOCBQQVRIICovIH1cclxuICAgIC8vIDMpIG5wbSBcdTUxNjhcdTVDNDBcdTY4MzkoXHU0RTI0XHU3OUNEXHU1RTAzXHU1QzQwXHU1NDBDIHdoZXJlKVxyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3Qgb3V0ID0gZXhlY0ZpbGVTeW5jKCducG0nLCBbJ3Jvb3QnLCAnLWcnXSwgeyBlbmNvZGluZzogJ3V0ZjgnLCB0aW1lb3V0OiA2XzAwMCwgd2luZG93c0hpZGU6IHRydWUgfSk7XHJcbiAgICAgIGNvbnN0IHJvb3QgPSBvdXQudHJpbSgpO1xyXG4gICAgICBjb25zdCBsaW5rZWQgPSBqb2luKHJvb3QsICdobWhhcm5lc3MnKTtcclxuICAgICAgaWYgKGV4aXN0c1N5bmMobGlua2VkKSkgbnBtUmVwb3MuYWRkKHJlYWxwYXRoU3luYyhsaW5rZWQpKTtcclxuICAgICAgY29uc3QgY2xpID0gam9pbihyb290LCAnQGhtaGFybmVzcycsICdjbGknKTtcclxuICAgICAgaWYgKGV4aXN0c1N5bmMoY2xpKSkgbnBtQ2xpID0gY2xpO1xyXG4gICAgfSBjYXRjaCB7IC8qIG5wbSBcdTRFMERcdTUzRUZcdTc1MjggKi8gfVxyXG5cclxuICAgIC8vIFx1NURGMlx1ODhDNSBDTEkoQGhtaGFybmVzcy9jbGkgbnBtIFx1NUUwM1x1NUM0MDtkZXNrdG9wLWhvc3QgXHU0RTNBXHU3RjE2XHU4QkQxXHU0RUE3XHU3MjY5XHU1M0VGXHU3NkY0XHU4REQxKTpcclxuICAgIC8vIHdoZXJlKFBBVEggXHU3NzFGXHU3NkY4KT4gbnBtIFx1NTE2OFx1NUM0MFx1NjgzOSA+IFx1NTQxMVx1NUJGQ1x1NUI4OVx1ODhDNVx1NzZFRVx1NUY1NVxyXG4gICAgZm9yIChjb25zdCBbY2xpLCBzb3VyY2VdIG9mIFtbd2hlcmVDbGlzWzBdID8/ICcnLCAnd2hlcmUtaG1oJ10sIFtucG1DbGksICducG0tZ2xvYmFsJ11dIGFzIEFycmF5PFtzdHJpbmcsIHN0cmluZ10+KSB7XHJcbiAgICAgIGlmIChjbGkgPT09ICcnKSBjb250aW51ZTtcclxuICAgICAgY29uc3QgZW50cnkgPSBlbnRyeUZyb21DbGlEaXIoY2xpKTtcclxuICAgICAgaWYgKGVudHJ5ICE9PSAnJykgcmV0dXJuIHsgZW50cnksIHZlcnNpb246IHBrZ1ZlcnNpb25BdChjbGkpLCBzb3VyY2UgfTtcclxuICAgIH1cclxuICAgIGNvbnN0IHdpemFyZEVudHJ5ID0gcmVzb2x2ZUluc3RhbGxlZEVudHJ5KGluc3RhbGxUYXJnZXQoKSk7XHJcbiAgICBpZiAod2l6YXJkRW50cnkgIT09ICcnKSB7XHJcbiAgICAgIHJldHVybiB7IGVudHJ5OiB3aXphcmRFbnRyeSwgdmVyc2lvbjogcGtnVmVyc2lvbkF0KGpvaW4oaW5zdGFsbFRhcmdldCgpLCAnbm9kZV9tb2R1bGVzJywgJ0BobWhhcm5lc3MnLCAnY2xpJykpLCBzb3VyY2U6ICd3aXphcmQtaW5zdGFsbCcgfTtcclxuICAgIH1cclxuXHJcbiAgICAvLyBcdTZFOTBcdTc4MDEgcmVwbyBcdTVFMDNcdTVDNDAod2hlcmUgPiBucG0gXHU1MTY4XHU1QzQwID4gXHU1RTM4XHU4OUMxXHU2RTkwXHU3ODAxXHU0RjREXHU3RjZFO1x1NTQ3RFx1NEUyRFx1OTg3Qlx1NjcwOVx1NTE2NVx1NTNFM1x1NEUwRVx1NEY5RFx1OEQ1NilcclxuICAgIGNvbnN0IHJlcG9zID0gbmV3IFNldDxzdHJpbmc+KFsuLi53aGVyZVJlcG9zLCAuLi5ucG1SZXBvc10pO1xyXG4gICAgY29uc3QgYmFzZXMgPSBbJ0M6XFxcXCcsICdEOlxcXFwnLCAnRTpcXFxcJywgJ0Y6XFxcXCcsICdHOlxcXFwnLCAnSDpcXFxcJywgaG9tZWRpcigpLCBqb2luKGhvbWVkaXIoKSwgJ0RldmVsb3BlcicpXTtcclxuICAgIGZvciAoY29uc3QgYmFzZSBvZiBiYXNlcykge1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHAgPSByZXNvbHZlKGJhc2UsICdobWhhcm5lc3MnKTtcclxuICAgICAgICBpZiAoZXhpc3RzU3luYyhwKSkgcmVwb3MuYWRkKHApO1xyXG4gICAgICB9IGNhdGNoIHsgLyogXHU3NkQ4XHU0RTBEXHU1QjU4XHU1NzI4ICovIH1cclxuICAgIH1cclxuICAgIGZvciAoY29uc3QgcmVwbyBvZiByZXBvcykge1xyXG4gICAgICBjb25zdCBlbnRyeSA9IGpvaW4ocmVwbywgJ3BhY2thZ2VzJywgJ3dlYicsICdzcmMnLCAnZGVza3RvcC1ob3N0LnRzJyk7XHJcbiAgICAgIGlmIChleGlzdHNTeW5jKGVudHJ5KSAmJiBleGlzdHNTeW5jKGpvaW4ocmVwbywgJ25vZGVfbW9kdWxlcycpKSkge1xyXG4gICAgICAgIHJldHVybiB7IGVudHJ5LCB2ZXJzaW9uOiBwa2dWZXJzaW9uQXQocmVwbyksIHNvdXJjZTogJ3NvdXJjZS1yZXBvJyB9O1xyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4geyBlbnRyeTogJycsIHZlcnNpb246ICcnLCBzb3VyY2U6ICcnIH07XHJcbiAgfVxyXG5cclxuICBmdW5jdGlvbiBkZXRlY3RSZWFsRW50cnkoKTogc3RyaW5nIHtcclxuICAgIHJldHVybiBkZXRlY3RFeHRlcm5hbFJ1bnRpbWUoKS5lbnRyeTtcclxuICB9XHJcblxyXG4gIC8qKiBcdTg5RTNcdTY3OTAgcnVudGltZSBcdTUxNjVcdTUzRTNcdTYyNDBcdTVDNUVcdTc2ODQgaG1oYXJuZXNzIFx1NEVEM1x1NUU5M1x1NjgzOShwYWNrYWdlcy93ZWIvc3JjfGRpc3QgXHU0RTBBXHU2RUFGKVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIHJlcG9Sb290T2YoZW50cnk6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICBsZXQgZGlyID0gZGlybmFtZShlbnRyeSk7XHJcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IDY7IGkrKykge1xyXG4gICAgICBpZiAoZXhpc3RzU3luYyhqb2luKGRpciwgJ3BhY2thZ2UuanNvbicpKSAmJiBleGlzdHNTeW5jKGpvaW4oZGlyLCAncGFja2FnZXMnLCAnd2ViJykpKSByZXR1cm4gZGlyO1xyXG4gICAgICBjb25zdCBwYXJlbnQgPSBkaXJuYW1lKGRpcik7XHJcbiAgICAgIGlmIChwYXJlbnQgPT09IGRpcikgYnJlYWs7XHJcbiAgICAgIGRpciA9IHBhcmVudDtcclxuICAgIH1cclxuICAgIHJldHVybiBkaXJuYW1lKGVudHJ5KTtcclxuICB9XHJcblxyXG4gIGxldCBydW50aW1lRW50cnkgPSAnJzsgLy8gXHU1RjUzXHU1MjREXHU1QjlFXHU5NjQ1XHU0RjdGXHU3NTI4XHU3Njg0XHU3NzFGXHU1QjlFIHJ1bnRpbWUgXHU1MTY1XHU1M0UzKCcnPVx1NjcyQVx1NjNBNSlcclxuICBsZXQgdXNlQnVuZGxlZFJ1bnRpbWUgPSBmYWxzZTsgLy8gdjU6XHU2NjJGXHU1NDI2XHU1NzI4XHU3NTI4XHU1MTg1XHU3RjZFIHJ1bnRpbWUoXHU1MTczXHU0RThFL1x1OTc2Mlx1Njc3Rlx1NjgwN1x1NkNFOClcclxuXHJcbiAgLyoqIFx1NTE4NVx1N0Y2RSBydW50aW1lKHY1IFx1NUYwMFx1N0JCMVx1NTM3M1x1NzUyOCk6XHU2MjUzXHU1MzA1XHU1NDBFXHU5NjhGIGV4dHJhUmVzb3VyY2VzIFx1NUU3M1x1OTRGQVx1NTcyOCByZXNvdXJjZXMvO1xyXG4gICAgIGRldiBcdTc1MjhcdTRFRDNcdTVFOTNcdTUxODVcdTY3ODRcdTVFRkFcdTRFQTdcdTcyNjkoc2NyaXB0cy9idW5kbGUtcnVudGltZS5tanMpXHUzMDAyXHU4MUVBXHU1MzA1XHU1NDJCXHU1MzU1XHU2NTg3XHU0RUY2LFx1NjVFMCB0c3hcdTMwMDFcclxuICAgICBcdTY1RTAgcmVwbyBub2RlX21vZHVsZXMgXHU0RjlEXHU4RDU2XHUzMDAyICovXHJcbiAgZnVuY3Rpb24gYnVuZGxlZFJ1bnRpbWVQYXRoKHJlcG9Sb290OiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIGpvaW4oYXBwLmlzUGFja2FnZWQgPyBwcm9jZXNzLnJlc291cmNlc1BhdGggOiBqb2luKHJlcG9Sb290LCAnYXBwcycsICdkZXNrdG9wJywgJ3Jlc291cmNlcycpLCAncnVudGltZScsICdydW50aW1lLmNqcycpO1xyXG4gIH1cclxuXHJcbiAgLyoqIFx1NTE4NVx1N0Y2RSBydW50aW1lIFx1NTE0M1x1NEZFMVx1NjA2RihcdTU0MTFcdTVCRkNcIlx1NTE4NVx1N0Y2RVx1N0NCRVx1N0I4MFx1NTE4NVx1NjgzOFwiXHU5MDA5XHU5ODc5XHU3Njg0XHU3MjQ4XHU2NzJDXHU2ODA3XHU2Q0U4KVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIGJ1bmRsZWRSdW50aW1lSW5mbygpOiB7IHJlYWR5OiBib29sZWFuOyB2ZXJzaW9uOiBzdHJpbmcgfSB7XHJcbiAgICBjb25zdCByZXBvUm9vdCA9IGpvaW4oaGVyZSwgJy4uJywgJy4uJywgJy4uJywgJy4uJyk7XHJcbiAgICBjb25zdCBwID0gYnVuZGxlZFJ1bnRpbWVQYXRoKHJlcG9Sb290KTtcclxuICAgIGxldCB2ZXJzaW9uID0gJyc7XHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCB2ID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoam9pbihkaXJuYW1lKHApLCAncGFja2FnZS5qc29uJyksICd1dGY4JykpIGFzIHsgdmVyc2lvbj86IHVua25vd24gfTtcclxuICAgICAgdmVyc2lvbiA9IHR5cGVvZiB2LnZlcnNpb24gPT09ICdzdHJpbmcnID8gdi52ZXJzaW9uIDogJyc7XHJcbiAgICB9IGNhdGNoIHsgLyogXHU1MTQzXHU2NTcwXHU2MzZFXHU3RjNBXHU1OTMxXHU1MjE5XHU1M0VBXHU2MkE1IHJlYWR5ICovIH1cclxuICAgIHJldHVybiB7IHJlYWR5OiBleGlzdHNTeW5jKHApLCB2ZXJzaW9uIH07XHJcbiAgfVxyXG5cclxuICAvKiogbnBtIFx1NjYyRlx1NTQyNlx1NTcyOCBQQVRIKFx1NTQxMVx1NUJGQ1x1OTAwOVx1NjJFOVx1OTg3NSBcdTI0NjAgXHU3Njg0XHU1Qjg5XHU4OEM1XHU2NUI5XHU1RjBGXHU2ODA3XHU2Q0U4O3doZXJlIFx1NUZFQlx1NjNBMixcdTRFMERcdTUwNUFcdTVCOENcdTY1NzRcdTYzQTJcdTZENEIpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gbnBtT25QYXRoKCk6IGJvb2xlYW4ge1xyXG4gICAgdHJ5IHtcclxuICAgICAgZXhlY0ZpbGVTeW5jKCd3aGVyZScsIFsnbnBtJ10sIHsgZW5jb2Rpbmc6ICd1dGY4JywgdGltZW91dDogNF8wMDAsIHdpbmRvd3NIaWRlOiB0cnVlIH0pO1xyXG4gICAgICByZXR1cm4gdHJ1ZTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4gZmFsc2U7IH1cclxuICB9XHJcblxyXG4gIC8qIC0tLS0gXHU5OTk2XHU1NDJGXHU1Qjg5XHU4OEM1XHU1NDExXHU1QkZDXHU3MkI2XHU2MDAxKHY1LjEpIC0tLS0gKi9cclxuICBjb25zdCB3aXphcmRGaWxlID0gKCk6IHN0cmluZyA9PiBqb2luKGFwcC5nZXRQYXRoKCd1c2VyRGF0YScpLCAnd2l6YXJkLmpzb24nKTtcclxuICBhc3luYyBmdW5jdGlvbiBsb2FkV2l6YXJkU3RhdGUoKTogUHJvbWlzZTx7IGRvbmU6IGJvb2xlYW47IGNob2ljZTogc3RyaW5nIH0+IHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHYgPSBKU09OLnBhcnNlKGF3YWl0IHJlYWRGaWxlKHdpemFyZEZpbGUoKSwgJ3V0ZjgnKSkgYXMgeyBkb25lPzogdW5rbm93bjsgY2hvaWNlPzogdW5rbm93biB9O1xyXG4gICAgICByZXR1cm4geyBkb25lOiB2LmRvbmUgPT09IHRydWUsIGNob2ljZTogdHlwZW9mIHYuY2hvaWNlID09PSAnc3RyaW5nJyA/IHYuY2hvaWNlIDogJycgfTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4geyBkb25lOiBmYWxzZSwgY2hvaWNlOiAnJyB9OyB9XHJcbiAgfVxyXG4gIGFzeW5jIGZ1bmN0aW9uIHNhdmVXaXphcmRTdGF0ZShjaG9pY2U6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgYXdhaXQgd3JpdGVGaWxlKHdpemFyZEZpbGUoKSwgSlNPTi5zdHJpbmdpZnkoeyBkb25lOiB0cnVlLCBjaG9pY2UgfSwgbnVsbCwgMiksICd1dGY4JykuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcclxuICB9XHJcbiAgLyoqIFx1NTQxMVx1NUJGQ1x1ODFFQVx1NTJBOFx1NUYzOVx1NTFGQVx1NjI5MVx1NTIzNjpcdTZENEJcdThCRDUvXHU1RjAwXHU1M0QxXHU3M0FGXHU1ODgzXHU0RTBEXHU1RjM5KFVJVkVSSUZZL1NOQVBTSE9UL1JFTkRFUl9URVNUL1xyXG4gICAqICBET01QUk9CRS9TRUNVUklUWV9URVNUL0ZBS0UvZGV2KTtITUhfREVTS1RPUF9XSVpBUkRfRk9SQ0U9MSBcdTVGM0FcdTUyMzZcdTVGMzkoXHU5QThDXHU2NTM2KVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIHdpemFyZFN1cHByZXNzZWQoKTogYm9vbGVhbiB7XHJcbiAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfV0laQVJEX0ZPUkNFID09PSAnMScpIHJldHVybiBmYWxzZTtcclxuICAgIHJldHVybiBpc0RldlxyXG4gICAgICB8fCBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWSA9PT0gJzEnXHJcbiAgICAgIHx8IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NOQVBTSE9UICE9PSB1bmRlZmluZWRcclxuICAgICAgfHwgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVklTUkVHID09PSAnMSdcclxuICAgICAgfHwgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfUkVOREVSX1RFU1QgPT09ICcxJ1xyXG4gICAgICB8fCBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9ET01QUk9CRSA9PT0gJzEnXHJcbiAgICAgIHx8IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NFQ1VSSVRZX1RFU1QgPT09ICcxJ1xyXG4gICAgICB8fCBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9GQUtFID09PSAnMSc7XHJcbiAgfVxyXG5cclxuICAvKiogXHU1M0QxXHU3M0IwXHU5ODdBXHU1RThGOlx1NjYzRVx1NUYwRlx1ODk4Nlx1NzZENihcdTU0MkJcdTU0MTFcdTVCRkNcdTkwMDlcdTYyRTk6XHU1OTE2XHU5MEU4XHU1MTY1XHU1M0UzL1x1NTE4NVx1N0Y2RVx1OERFRlx1NUY4NC9cdTZGMTRcdTc5M0EpPiBcdTUxODVcdTdGNkVcdTVGMDBcdTUxNzNcclxuICAgICAoSE1IX0RFU0tUT1BfQlVORExFRD0xKT4gXHU1OTE2XHU5MEU4XHU1M0QxXHU3M0IwKGRldiBcdTc2RjhcdTkwQkJcdTRFRDNcdTVFOTMgLyB3aGVyZSBobWggLyBucG0gXHU1MTY4XHU1QzQwIC9cclxuICAgICBcdTU0MTFcdTVCRkNcdTVCODlcdTg4QzVcdTc2RUVcdTVGNTUgLyBcdTZFOTBcdTc4MDFcdTRGNERcdTdGNkUpPiBcdTUxODVcdTdGNkVcdTUxNUNcdTVFOTVcdTMwMDJcdTU5MTZcdTkwRThcdTRGMThcdTUxNDg9XHU4MDAxXHU3NTI4XHU2MjM3XHU3RUU3XHU3RUVEXHU3NTI4XHU4MUVBXHU1REYxXHU4OEM1XHU3Njg0XHU3MjQ4XHU2NzJDO1xyXG4gICAgIFx1NTE4NVx1N0Y2RT1cdTY1QjBcdTY3M0FcdTU2NjhcdTg4QzVcdTVCOENcdTc2RjRcdThGREVcdTc3MUZcdTVCOUVcdTUxODVcdTY4MzhcdTMwMDJITUhfREVTS1RPUF9GQUtFPTEgXHU2MjE2IHJ1bnRpbWUuanNvbiBkZW1vPXRydWVcclxuICAgICAoXHU1NDExXHU1QkZDXCJcdTZGMTRcdTc5M0FcdTZBMjFcdTVGMEZcIlx1OTAwOVx1NjJFOSxcdTYzMDFcdTRFNDUpXHU4RkRCXHU2RjE0XHU3OTNBXHUzMDAyICovXHJcbiAgYXN5bmMgZnVuY3Rpb24gc3RhcnRIb3N0KCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3QgcmVwb1Jvb3QgPSBqb2luKGhlcmUsICcuLicsICcuLicsICcuLicsICcuLicpOyAvLyBhcHBzL2Rlc2t0b3AvZGlzdC1lbGVjdHJvbi9tYWluIFx1MjE5MiByZXBvIHJvb3RcclxuICAgIGNvbnN0IHBhY2thZ2VkID0gYXBwLmlzUGFja2FnZWQ7XHJcbiAgICBjb25zdCBjZmcgPSBhd2FpdCBsb2FkUnVudGltZUNvbmZpZygpO1xyXG4gICAgY29uc3QgZm9yY2VGYWtlID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfRkFLRSA9PT0gJzEnIHx8IGNmZy5kZW1vO1xyXG4gICAgY29uc3QgZm9yY2VCdW5kbGVkID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfQlVORExFRCA9PT0gJzEnO1xyXG4gICAgY29uc3Qgb3ZlcnJpZGUgPSBjZmcuZW50cnk7XHJcbiAgICBjb25zdCBhZGphY2VudCA9IGpvaW4ocmVwb1Jvb3QsICcuLicsICdobWhhcm5lc3MnLCAncGFja2FnZXMnLCAnd2ViJywgJ3NyYycsICdkZXNrdG9wLWhvc3QudHMnKTtcclxuICAgIGNvbnN0IGJ1bmRsZWQgPSBidW5kbGVkUnVudGltZVBhdGgocmVwb1Jvb3QpO1xyXG4gICAgY29uc3QgYnVuZGxlZFJlYWR5ID0gZXhpc3RzU3luYyhidW5kbGVkKTtcclxuICAgIC8vIFx1ODlFM1x1Njc5MChcdTdFRDNcdTY3OUNcdTVGNTJcdTRFMDA6b3ZlcnJpZGU9YnVuZGxlZCBcdThERUZcdTVGODRcdTIxOTJcdTUxODVcdTdGNkU7XHU2RTkwXHU3ODAxIC50cyBcdTk3MDAgdHN4O1xyXG4gICAgLy8gbnBtIFx1NUI4OVx1ODhDNSAuanMgXHU3RjE2XHU4QkQxXHU0RUE3XHU3MjY5XHU3NkY0XHU4REQxO2J1bmRsZWQ9XHU4MUVBXHU1MzA1XHU1NDJCIGNqcyBcdTc2RjRcdThERDEpXHJcbiAgICBsZXQgZW50cnkgPSAnJztcclxuICAgIHVzZUJ1bmRsZWRSdW50aW1lID0gZmFsc2U7XHJcbiAgICBpZiAoZm9yY2VGYWtlKSB7XHJcbiAgICAgIC8vIFx1NkYxNFx1NzkzQVx1NkEyMVx1NUYwRlxyXG4gICAgfSBlbHNlIGlmIChvdmVycmlkZSAhPT0gJycpIHtcclxuICAgICAgZW50cnkgPSBvdmVycmlkZTtcclxuICAgICAgaWYgKG92ZXJyaWRlID09PSBidW5kbGVkKSB1c2VCdW5kbGVkUnVudGltZSA9IHRydWU7IC8vIFx1NTQxMVx1NUJGQ1x1OTAwOVwiXHU1MTg1XHU3RjZFXHU3Q0JFXHU3QjgwXHU1MTg1XHU2ODM4XCJcdTc2ODRcdTYzMDFcdTRFNDVcdTVGNjJcdTYwMDFcclxuICAgIH0gZWxzZSBpZiAoZm9yY2VCdW5kbGVkKSB7XHJcbiAgICAgIGlmIChidW5kbGVkUmVhZHkpIHsgZW50cnkgPSBidW5kbGVkOyB1c2VCdW5kbGVkUnVudGltZSA9IHRydWU7IH1cclxuICAgICAgZWxzZSBsb2dJbmZvKCdob3N0JywgJ0hNSF9ERVNLVE9QX0JVTkRMRUQ9MSBcdTRGNDZcdTUxODVcdTdGNkUgcnVudGltZSBcdTdGM0FcdTU5MzEoXHU1MTQ4XHU4REQxIHNjcmlwdHMvYnVuZGxlLXJ1bnRpbWUubWpzKScpO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgZW50cnkgPSBwYWNrYWdlZCA/IGRldGVjdFJlYWxFbnRyeSgpIDogKGV4aXN0c1N5bmMoYWRqYWNlbnQpID8gYWRqYWNlbnQgOiBkZXRlY3RSZWFsRW50cnkoKSk7XHJcbiAgICAgIGlmIChlbnRyeSA9PT0gJycgJiYgYnVuZGxlZFJlYWR5KSB7IGVudHJ5ID0gYnVuZGxlZDsgdXNlQnVuZGxlZFJ1bnRpbWUgPSB0cnVlOyB9XHJcbiAgICB9XHJcbiAgICBydW50aW1lRW50cnkgPSBlbnRyeTtcclxuICAgIGNvbnN0IHVzZVJlYWwgPSBlbnRyeSAhPT0gJycgJiYgKHVzZUJ1bmRsZWRSdW50aW1lIHx8IGV4aXN0c1N5bmMoZW50cnkpKTtcclxuICAgIGJyaWRnZSA9IHtcclxuICAgICAgLi4uYnJpZGdlLFxyXG4gICAgICBtb2RlOiB1c2VSZWFsID8gJ3JlYWwnIDogJ2Zha2UnLFxyXG4gICAgICBydW50aW1lRW50cnk6IHVzZVJlYWwgPyAodXNlQnVuZGxlZFJ1bnRpbWUgPyBgJHtlbnRyeX0gKGJ1bmRsZWQpYCA6IGVudHJ5KSA6IG51bGwsXHJcbiAgICB9O1xyXG4gICAgbGV0IHNwZWM6IHsgY29tbWFuZDogc3RyaW5nOyBhcmdzOiBzdHJpbmdbXTsgZW52OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+OyBjd2Q/OiBzdHJpbmcgfTtcclxuICAgIGlmICh1c2VCdW5kbGVkUnVudGltZSkge1xyXG4gICAgICBzcGVjID0ge1xyXG4gICAgICAgIGNvbW1hbmQ6IHByb2Nlc3MuZXhlY1BhdGgsXHJcbiAgICAgICAgYXJnczogW2VudHJ5XSwgLy8gXHU4MUVBXHU1MzA1XHU1NDJCXHU1MzU1XHU2NTg3XHU0RUY2OmVsZWN0cm9uLWFzLW5vZGUgXHU3NkY0XHU4REQxLFx1NjVFMCB0c3ggXHU2NUUwIHJlcG9cclxuICAgICAgICBlbnY6IHsgRUxFQ1RST05fUlVOX0FTX05PREU6ICcxJyB9LFxyXG4gICAgICB9O1xyXG4gICAgfSBlbHNlIGlmICh1c2VSZWFsICYmIGVudHJ5LmVuZHNXaXRoKCcuanMnKSkge1xyXG4gICAgICBzcGVjID0ge1xyXG4gICAgICAgIGNvbW1hbmQ6IHByb2Nlc3MuZXhlY1BhdGgsXHJcbiAgICAgICAgYXJnczogW2VudHJ5XSwgLy8gbnBtIFx1NUI4OVx1ODhDNVx1NzY4NFx1N0YxNlx1OEJEMVx1NEVBN1x1NzI2OTpFU00gXHU0RjlEXHU4RDU2XHU2MzA5XHU2NTg3XHU0RUY2XHU0RjREXHU3RjZFXHU4OUUzXHU2NzkwLFx1NzZGNFx1OEREMVx1NTM3M1x1NTNFRlxyXG4gICAgICAgIGN3ZDogZGlybmFtZShlbnRyeSksXHJcbiAgICAgICAgZW52OiB7IEVMRUNUUk9OX1JVTl9BU19OT0RFOiAnMScgfSxcclxuICAgICAgfTtcclxuICAgIH0gZWxzZSBpZiAodXNlUmVhbCkge1xyXG4gICAgICBjb25zdCByZXBvID0gcmVwb1Jvb3RPZihlbnRyeSk7XHJcbiAgICAgIHNwZWMgPSB7XHJcbiAgICAgICAgY29tbWFuZDogcHJvY2Vzcy5leGVjUGF0aCxcclxuICAgICAgICBhcmdzOiBbJy0taW1wb3J0JywgJ3RzeCcsIGVudHJ5XSxcclxuICAgICAgICBjd2Q6IHJlcG8sIC8vIGJhcmUgJ3RzeCcgXHU0RTBFIHdvcmtzcGFjZSBcdTRGOURcdThENTZcdTkwRkRcdTRFQ0UgcmVwbyBcdTc2ODQgbm9kZV9tb2R1bGVzIFx1ODlFM1x1Njc5MFxyXG4gICAgICAgIGVudjogeyBFTEVDVFJPTl9SVU5fQVNfTk9ERTogJzEnIH0sXHJcbiAgICAgIH07XHJcbiAgICB9IGVsc2UgaWYgKHBhY2thZ2VkKSB7XHJcbiAgICAgIHNwZWMgPSB7XHJcbiAgICAgICAgY29tbWFuZDogcHJvY2Vzcy5leGVjUGF0aCxcclxuICAgICAgICBhcmdzOiBbam9pbihwcm9jZXNzLnJlc291cmNlc1BhdGgsICdmYWtlLWhvc3QuY2pzJyldLFxyXG4gICAgICAgIGVudjogeyBFTEVDVFJPTl9SVU5fQVNfTk9ERTogJzEnIH0sXHJcbiAgICAgIH07XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICBzcGVjID0ge1xyXG4gICAgICAgIGNvbW1hbmQ6IHByb2Nlc3MuZXhlY1BhdGgsXHJcbiAgICAgICAgLy8gXHU3NkY0XHU2M0E1XHU4RDcwXHU1MzA1XHU3NzFGXHU1QjlFXHU4REVGXHU1Rjg0KG5vZGVfbW9kdWxlcyBcdTkxQ0NcdTc2ODQgd29ya3NwYWNlIGp1bmN0aW9uIFx1NEYxQVx1ODhBQiBFU01cclxuICAgICAgICAvLyByZWFscGF0aCBcdTUzMTYsXHU1QkZDXHU4MUY0IGZha2UtaG9zdCBcdTc2ODQgYXJndlsxXS9pbXBvcnQubWV0YS51cmwgXHU1MzM5XHU5MTREXHU1OTMxXHU2NTQ4KVxyXG4gICAgICAgIGFyZ3M6IFsnLS1pbXBvcnQnLCAndHN4Jywgam9pbihyZXBvUm9vdCwgJ3BhY2thZ2VzJywgJ2hvc3QtYWRhcHRlcicsICdzcmMnLCAnZmFrZS1ob3N0LnRzJyldLFxyXG4gICAgICAgIGVudjogeyBFTEVDVFJPTl9SVU5fQVNfTk9ERTogJzEnIH0sXHJcbiAgICAgIH07XHJcbiAgICB9XHJcbiAgICBzdXBlcnZpc29yID0gbmV3IERlc2t0b3BSdW50aW1lU3VwZXJ2aXNvcihzcGVjLCB7XHJcbiAgICAgIG9uU3RhdGVDaGFuZ2U6IGJyb2FkY2FzdEhvc3RTdGF0ZSxcclxuICAgICAgLy8gXHU5OTk2XHU2QjIxXHU1NDJGXHU1MkE4XHU0RTBFIGNyYXNoIFx1ODFFQVx1NjEwOFx1NTQwRVx1NzY4NFx1OTFDRFx1NTQyRlx1OTBGRFx1NEYxQVx1OEQ3MFx1OEZEOVx1OTFDQzpcdTdBRUZcdTUzRTMvdG9rZW4gXHU5MEZEXHU2NjJGXHU2NUIwXHU3Njg0LFxyXG4gICAgICAvLyBcdTkxQ0RcdTVFRkFcdTY4NjVcdTVCQTJcdTYyMzdcdTdBRUZcdTVFNzZcdTkxQ0RcdTY1QjBcdThCQTJcdTk2MDUgU1NFKHJlbmRlcmVyIFx1NzY4NCBFdmVudFN0b3JlIFx1OTc2MCBldmVudElkIFx1NTNCQlx1OTFDRClcclxuICAgICAgb25SZWFkeTogKGVwKSA9PiB7XHJcbiAgICAgICAgY2xpZW50ID0gbmV3IERlc2t0b3BIb3N0Q2xpZW50KGBodHRwOi8vMTI3LjAuMC4xOiR7ZXAucG9ydH1gLCBlcC50b2tlbik7XHJcbiAgICAgICAgc3NlQWJvcnQ/LmFib3J0KCk7XHJcbiAgICAgICAgc3NlQWJvcnQgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XHJcbiAgICAgICAgbGFzdEV2ZW50SWQgPSAnJztcclxuICAgICAgICB2b2lkIHB1bXBFdmVudHMoKTtcclxuICAgICAgICBsb2dJbmZvKCdob3N0JywgYGJyaWRnZSByZWFkeSBvbiAxMjcuMC4wLjE6JHtlcC5wb3J0fSAocnVudGltZSAke2VwLnZlcnNpb259LCBtb2RlICR7YnJpZGdlLm1vZGV9JHt1c2VSZWFsID8gYCwgZW50cnk9JHtydW50aW1lRW50cnl9JHt1c2VCdW5kbGVkUnVudGltZSA/ICcgW2J1bmRsZWRdJyA6ICcnfWAgOiAnJ30pYCk7XHJcbiAgICAgIH0sXHJcbiAgICB9KTtcclxuICAgIHRyeSB7XHJcbiAgICAgIGF3YWl0IHN1cGVydmlzb3Iuc3RhcnQoKTtcclxuICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICBjb25zdCBkZXRhaWwgPSAoKCkgPT4geyB0cnkgeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkoZXJyKTsgfSBjYXRjaCB7IHJldHVybiBTdHJpbmcoZXJyKTsgfSB9KSgpLnNsaWNlKDAsIDQwMCk7XHJcbiAgICAgIGJyaWRnZSA9IHsgLi4uYnJpZGdlLCBob3N0U3RhdGU6ICdmYWlsZWQnLCBsYXN0RXJyb3I6IGRldGFpbCB9O1xyXG4gICAgICBsb2dJbmZvKCdob3N0JywgYHN0YXJ0IGZhaWxlZDogJHtkZXRhaWx9YCk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvKiAtLS0tIElQQyBcdTc2N0RcdTU0MERcdTUzNTUgKyBzZW5kZXIgXHU2ODIxXHU5QThDIC0tLS0gKi9cclxuICBjb25zdCBhbGxvd2VkT3JpZ2lucyA9IG5ldyBTZXQ8c3RyaW5nPihcclxuICAgIGlzRGV2ICYmIHJlbmRlcmVyRGV2VXJsXHJcbiAgICAgID8gW3JlbmRlcmVyRGV2VXJsXVxyXG4gICAgICA6IFtwYXRoVG9GaWxlVVJMKGpvaW4oaGVyZSwgJy4uJywgJy4uJywgJ2Rpc3QtcmVuZGVyZXInLCAnaW5kZXguaHRtbCcpKS5ocmVmXSxcclxuICApO1xyXG5cclxuICBmdW5jdGlvbiBzZW5kZXJUcnVzdGVkKHNlbmRlckZyYW1lOiBFbGVjdHJvbi5XZWJGcmFtZU1haW4gfCBudWxsIHwgdW5kZWZpbmVkKTogYm9vbGVhbiB7XHJcbiAgICBpZiAoc2VuZGVyRnJhbWUgPT09IG51bGwgfHwgc2VuZGVyRnJhbWUgPT09IHVuZGVmaW5lZCkgcmV0dXJuIGZhbHNlO1xyXG4gICAgbGV0IHRvcDogRWxlY3Ryb24uV2ViRnJhbWVNYWluIHwgbnVsbCA9IHNlbmRlckZyYW1lO1xyXG4gICAgd2hpbGUgKHRvcD8ucGFyZW50ICE9PSBudWxsICYmIHRvcD8ucGFyZW50ICE9PSB1bmRlZmluZWQpIHRvcCA9IHRvcC5wYXJlbnQ7XHJcbiAgICBjb25zdCB1cmwgPSB0b3A/LnVybCA/PyAnJztcclxuICAgIGZvciAoY29uc3Qgb3JpZ2luIG9mIGFsbG93ZWRPcmlnaW5zKSB7XHJcbiAgICAgIGlmICh1cmwgPT09IG9yaWdpbiB8fCB1cmwuc3RhcnRzV2l0aChgJHtvcmlnaW59L2ApIHx8IHVybC5zdGFydHNXaXRoKGAke29yaWdpbn0/YCkpIHJldHVybiB0cnVlO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGZhbHNlO1xyXG4gIH1cclxuXHJcbiAgLyoqIFx1OTcwMFx1ODk4MSBob3N0IFx1NUMzMVx1N0VFQVx1NzY4NCBJUEMgaGFuZGxlciBcdTUxNkNcdTUxNzFcdTU4RjM6XHU2NzJBXHU1QzMxXHU3RUVBXHU4RkQ0XHU1NkRFXHU3RUQzXHU2Nzg0XHU1MzE2XHU5NTE5XHU4QkVGXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gaG9zdENhbGw8VD4oZXZlbnQ6IEVsZWN0cm9uLklwY01haW5JbnZva2VFdmVudCwgZm46IChjOiBEZXNrdG9wSG9zdENsaWVudCkgPT4gUHJvbWlzZTxUPik6IFByb21pc2U8VCB8IHsgZXJyb3I6IHN0cmluZzsgY29kZTogc3RyaW5nIH0+IHtcclxuICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9KTtcclxuICAgIGlmIChjbGllbnQgPT09IG51bGwgfHwgYnJpZGdlLmhvc3RTdGF0ZSAhPT0gJ3JlYWR5Jykge1xyXG4gICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6IGBob3N0IG5vdCByZWFkeSAoJHticmlkZ2UuaG9zdFN0YXRlfSlgLCBjb2RlOiAnSE9TVF9OT1RfUkVBRFknIH0pO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGZuKGNsaWVudCkuY2F0Y2goKGVycjogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBkZXRhaWwgPSAoKCkgPT4geyB0cnkgeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkoZXJyKTsgfSBjYXRjaCB7IHJldHVybiBTdHJpbmcoZXJyKTsgfSB9KSgpLnNsaWNlKDAsIDMwMCk7XHJcbiAgICAgIHJldHVybiB7IGVycm9yOiBkZXRhaWwsIGNvZGU6ICdCUklER0VfRVJST1InIH07XHJcbiAgICB9KTtcclxuICB9XHJcblxyXG4gIC8qIC0tLS0gXHU0RUQzXHU1RTkzXHU5NzYyXHU2NzdGXHU2NzBEXHU1MkExKFx1NEVGQlx1NTJBMSAxNC1CKS0tLS1cclxuICAgKiBnaC9hZyBDTEkgXHU3Njg0IG1haW4gXHU0RkE3XHU1QzAxXHU4OEM1O1VJVkVSSUZZIGZha2UgXHU2QTIxXHU1RjBGXHU1MTY4XHU5MUNGXHU4RDcwIGZpeHR1cmUoXHU0RTBEXHU3OEIwXHU3OEMxXHU3NkQ4L1x1N0Y1MVx1N0VEQy9cdTUxRURcdTYzNkUpXHUzMDAyXHJcbiAgICogXHU3NjdCXHU1RjU1XHU4ODRDXHU3RUNGIGZvcmdlOmxvZ2luLWxpbmUgXHU2M0E4XHU3RUQ5XHU1MTY4XHU5MEU4XHU3QTk3XHU1M0UzO1VSTCBcdTU5MTZcdTVGMDBcdThENzAgc2hlbGwub3BlbkV4dGVybmFsXHUzMDAyICovXHJcbiAgbGV0IHdzUm9vdHNDYWNoZTogc3RyaW5nW10gPSBbXTtcclxuICBsZXQgcmVhbEZvcmdlOiBGb3JnZVNlcnZpY2UgfCBudWxsID0gbnVsbDtcclxuICAvLyBVSVZFUklGWV9GT1JHRT1yZWFsOlVJVkVSSUZZIFx1Njg0Nlx1NjdCNlx1NTE4NVx1OEREMVx1NzcxRlx1NUI5RSBnaC9hZyBcdTUxOTJcdTcwREYoXHU1M0VBXHU4QkZCKSxmb3JnZSBcdTRFMERcdThENzAgZml4dHVyZVxyXG4gIGNvbnN0IGZvcmdlRml4dHVyZU9mZiA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX0ZPUkdFID09PSAncmVhbCc7XHJcbiAgY29uc3QgZml4dHVyZUZvcmdlOiBGb3JnZVNlcnZpY2UgPSAoKCkgPT4ge1xyXG4gICAgY29uc3QgZiA9IGZvcmdlRml4dHVyZXMoKTtcclxuICAgIHJldHVybiB7XHJcbiAgICAgIHN0YXR1czogYXN5bmMgKCkgPT4gZi5zdGF0dXMsXHJcbiAgICAgIHJlcG9zOiBhc3luYyAoaG9zdCkgPT4gKHsgb2s6IHRydWUgYXMgY29uc3QsIGRhdGE6IGYucmVwb3MoaG9zdCkgfSksXHJcbiAgICAgIHByczogYXN5bmMgKCkgPT4gKHsgb2s6IHRydWUgYXMgY29uc3QsIGRhdGE6IGYucHJzIH0pLFxyXG4gICAgICBpc3N1ZXM6IGFzeW5jICgpID0+ICh7IG9rOiB0cnVlIGFzIGNvbnN0LCBkYXRhOiBmLmlzc3VlcyB9KSxcclxuICAgICAgcmVsZWFzZXM6IGFzeW5jICgpID0+ICh7IG9rOiB0cnVlIGFzIGNvbnN0LCBkYXRhOiBmLnJlbGVhc2VzIH0pLFxyXG4gICAgICBhY3Rpb246IGFzeW5jICgpID0+IGYuYWN0aW9uLFxyXG4gICAgICBsb2dpbjogYXN5bmMgKCkgPT4gZi5sb2dpbixcclxuICAgICAgcmVzb2x2ZTogKCkgPT4gZi5yZXNvbHZlLFxyXG4gICAgfTtcclxuICB9KSgpO1xyXG4gIGZ1bmN0aW9uIGZvcmdlU3ZjKCk6IEZvcmdlU2VydmljZSB7XHJcbiAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRlkgPT09ICcxJyAmJiAhZm9yZ2VGaXh0dXJlT2ZmKSByZXR1cm4gZml4dHVyZUZvcmdlO1xyXG4gICAgaWYgKHJlYWxGb3JnZSA9PT0gbnVsbCkge1xyXG4gICAgICByZWFsRm9yZ2UgPSBjcmVhdGVGb3JnZSh1bmRlZmluZWQsIHtcclxuICAgICAgICBhbGxvd2VkUm9vdHM6ICgpID0+IHdzUm9vdHNDYWNoZSxcclxuICAgICAgICBvbkxvZ2luTGluZTogKGhvc3QsIGxpbmUpID0+IHtcclxuICAgICAgICAgIGxvZ0luZm8oJ2ZvcmdlJywgYCR7aG9zdH0gbG9naW46ICR7bGluZS5zbGljZSgwLCAxNjApfWApO1xyXG4gICAgICAgICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XHJcbiAgICAgICAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ2ZvcmdlOmxvZ2luLWxpbmUnLCBob3N0LCBsaW5lKTtcclxuICAgICAgICAgIH1cclxuICAgICAgICB9LFxyXG4gICAgICAgIG9wZW5FeHRlcm5hbDogKHVybCkgPT4geyB2b2lkIHNoZWxsLm9wZW5FeHRlcm5hbCh1cmwpOyB9LFxyXG4gICAgICB9KTtcclxuICAgIH1cclxuICAgIHJldHVybiByZWFsRm9yZ2U7XHJcbiAgfVxyXG5cclxuICBmdW5jdGlvbiByZWdpc3RlcklwYygpOiB2b2lkIHtcclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6Z2V0LXN0YXRlJywgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicgfTtcclxuICAgICAgcmV0dXJuIHsgLi4uYnJpZGdlLCBkcm9wcGVkRnJhbWVzIH07XHJcbiAgICB9KTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnNlc3Npb25zJywgKGV2ZW50KSA9PlxyXG4gICAgICBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjx7IHNlc3Npb25zOiBBcnJheTx7IGlkOiBzdHJpbmc7IHRpdGxlOiBzdHJpbmc7IHRhc2s6IHN0cmluZzsgb3V0Y29tZTogc3RyaW5nOyB0dXJuczogbnVtYmVyOyB0b29sVXNlczogbnVtYmVyOyB0aW1lOiBzdHJpbmc7IGN3ZDogc3RyaW5nOyBjcmVhdGVkQXQ6IHN0cmluZzsgdXBkYXRlZEF0OiBzdHJpbmcgfT4gfT4oJy9hcGkvc2Vzc2lvbnM/bGltaXQ9MTAwJykpKTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnNlbmQtdGFzaycsIChldmVudCwgdGV4dDogdW5rbm93biwgc2Vzc2lvbklkOiB1bmtub3duLCBtb2RlOiB1bmtub3duLCBhdHRhY2htZW50czogdW5rbm93biwgaW1hZ2VzOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IHRhc2sgPSB0eXBlb2YgdGV4dCA9PT0gJ3N0cmluZycgPyB0ZXh0LnNsaWNlKDAsIDIwXzAwMCkgOiAnJztcclxuICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIHNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBzZXNzaW9uSWQuc2xpY2UoMCwgODApIDogJyc7XHJcbiAgICAgIGNvbnN0IG0gPSBtb2RlID09PSAnYXV0bycgfHwgbW9kZSA9PT0gJ3lvbG8nID8gbW9kZSA6ICdhc2snO1xyXG4gICAgICAvLyBcdTk2NDRcdTRFRjY6XHU1NDBFXHU3QUVGXHU2Mzg4XHU2NzQzIERUTyBcdTc2ODRcdTdFRERcdTVCRjlcdThERUZcdTVGODQoQCBcdTkwMDlcdTYyRTlcdTU2NjgvXHVEODNEXHVEQ0NFIFx1NEUwQVx1NEYyMFx1NTNFQVx1Njc2NVx1ODFFQVx1NjcyQ1x1NTczMFx1NjU4N1x1NEVGNlx1N0NGQlx1N0VERilcclxuICAgICAgY29uc3QgYXR0cyA9IEFycmF5LmlzQXJyYXkoYXR0YWNobWVudHMpID8gYXR0YWNobWVudHMuZmlsdGVyKChhKTogYSBpcyBzdHJpbmcgPT4gdHlwZW9mIGEgPT09ICdzdHJpbmcnKS5zbGljZSgwLCAxMCkgOiBbXTtcclxuICAgICAgLy8gXHU1NkZFXHU3MjQ3OnJ1bnRpbWUgdmlzaW9uIFx1OTRGRVx1NTM0Rlx1OEJBRSB7bmFtZSwgZGF0YVVybH0gYmFzZTY0KFx1MjI2NDMgXHU1RjIwIFx1MjI2NDZNQixyZW5kZXJlciBcdTc1MUZcdTYyMTApXHJcbiAgICAgIGNvbnN0IGltZ3MgPSBBcnJheS5pc0FycmF5KGltYWdlcylcclxuICAgICAgICA/IGltYWdlc1xyXG4gICAgICAgICAgICAuZmlsdGVyKChpbSk6IGltIGlzIHsgbmFtZTogc3RyaW5nOyBkYXRhVXJsOiBzdHJpbmcgfSA9PlxyXG4gICAgICAgICAgICAgIHR5cGVvZiBpbSA9PT0gJ29iamVjdCcgJiYgaW0gIT09IG51bGwgJiYgdHlwZW9mIChpbSBhcyB7IG5hbWU/OiB1bmtub3duIH0pLm5hbWUgPT09ICdzdHJpbmcnICYmIHR5cGVvZiAoaW0gYXMgeyBkYXRhVXJsPzogdW5rbm93biB9KS5kYXRhVXJsID09PSAnc3RyaW5nJylcclxuICAgICAgICAgICAgLnNsaWNlKDAsIDMpXHJcbiAgICAgICAgICAgIC5tYXAoKGltKSA9PiAoeyBuYW1lOiBpbS5uYW1lLnNsaWNlKDAsIDEyMCksIGRhdGFVcmw6IGltLmRhdGFVcmwuc2xpY2UoMCwgOF81MDBfMDAwKSB9KSlcclxuICAgICAgICA6IFtdO1xyXG4gICAgICBpZiAodGFzayA9PT0gJycgfHwgc2lkID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IG9rOiBmYWxzZSwgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcclxuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuOyBydW5JZD86IHN0cmluZyB9PignL2FwaS90YXNrJywgeyB0ZXh0OiB0YXNrLCBzZXNzaW9uSWQ6IHNpZCwgbW9kZTogbSwgYXR0YWNobWVudHM6IGF0dHMsIGltYWdlczogaW1ncyB9KSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIFx1NkEyMVx1NTc4Qlx1NTIwN1x1NjM2MihydW50aW1lIFBPU1QgL2FwaS9tb2RlbDpcdTUyMDcgY2hhdCBcdThERUZcdTc1MzEsY29uZmlnIFx1NTM3M1x1NjVGNlx1NzUxRlx1NjU0OCkgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTptb2RlbC1zZXQnLCAoZXZlbnQsIG5hbWU6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3QgbiA9IHR5cGVvZiBuYW1lID09PSAnc3RyaW5nJyA/IG5hbWUudHJpbSgpLnNsaWNlKDAsIDgwKSA6ICcnO1xyXG4gICAgICBpZiAobiA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ25hbWUgcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW47IG1vZGVsPzogc3RyaW5nIH0+KCcvYXBpL21vZGVsJywgeyBuYW1lOiBuIH0pKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gXHU1RTk0XHU3NTI4XHU1MTg1XHU2NkY0XHU2NUIwKEdpdEh1YiBSZWxlYXNlcztcdTgxRUFcdTc4MTRcdTk2RjZcdTRGOURcdThENTZcdTY2RjRcdTY1QjBcdTU2NjgpIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6Y2hlY2stdXBkYXRlJywgYXN5bmMgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIHJldHVybiBjaGVja0ZvclVwZGF0ZXMoKTtcclxuICAgIH0pO1xyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTphcHBseS11cGRhdGUnLCAoZXZlbnQpID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgaWYgKGluc3RhbGxlclBhdGggPT09IG51bGwpIHJldHVybiB7IGVycm9yOiAnbm8gaW5zdGFsbGVyIGRvd25sb2FkZWQnLCBjb2RlOiAnSE9TVF9OT1RfUkVBRFknIH07XHJcbiAgICAgIGFwcGx5VXBkYXRlKCk7XHJcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlIH07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIFx1NjgwN1x1OTg5OFx1NjgwRlx1NEUzQlx1OTg5OFx1NTQwQ1x1NkI2NShcdTZENDVcdTgyNzJcdTZBMjFcdTVGMEZcdTRFMERcdTUxOERcdTY3MDlcdTlFRDFcdTY3NjEpKyBcdTI2MzAgXHU0RTNCXHU4M0RDXHU1MzU1IC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6Y2hyb21lLXRoZW1lJywgKGV2ZW50LCBkYXJrOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGFwcGx5Q2hyb21lKGRhcmsgPT09IHRydWUpO1xyXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSB9O1xyXG4gICAgfSk7XHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnBvcHVwLW1haW4tbWVudScsIChldmVudCkgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBwb3B1cE1haW5NZW51KCk7XHJcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlIH07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIFx1NjI0Qlx1NjczQVx1OEZEQ1x1N0EwQlx1NjNBN1x1NTIzNig3Nzg4IHdlYiBcdTVCODhcdTYyQTQ7XHU3NTI4XHU2MjM3XHU2NjNFXHU1RjBGXHU1NDJGXHU1MkE4LEFEUi0wMDUgXHU0RTBEXHU5RUQ4XHU4QkE0XHU1RjAwIExBTikgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpyZW1vdGUtd2ViLXN0YXR1cycsIGFzeW5jIChldmVudCkgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBjb25zdCBwID0gYXdhaXQgcHJvYmVXZWJSZW1vdGUoKTtcclxuICAgICAgcmV0dXJuIHsgdXA6IHAudXAsIHZlcnNpb246IHAudmVyc2lvbiwgbGFuSXA6IGxhbklwT2YoKSwgcG9ydDogV0VCX1BPUlQsIGF2YWlsYWJsZTogY2xpRW50cnlPZigpICE9PSAnJywgYXV0b3N0YXJ0OiB3ZWJBdXRvc3RhcnRJbnN0YWxsZWQoKSB9O1xyXG4gICAgfSk7XHJcbiAgICAvLyAtLS0tIFx1NUYwMFx1NjczQVx1ODFFQVx1NTQyRigwLjIzLjM3IHdlYiBpbnN0YWxsLWRhZW1vbi91bmluc3RhbGwtZGFlbW9uO1x1NzY3Qlx1NUY1NVx1NTM3M1x1NUI4OFx1NjJBNFx1NTcyOFx1N0VCRikgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpyZW1vdGUtd2ViLWF1dG9zdGFydCcsIGFzeW5jIChldmVudCwgZW5hYmxlZDogdW5rbm93bikgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBpZiAoY2xpRW50cnlPZigpID09PSAnJykgcmV0dXJuIHsgZXJyb3I6ICdubyBobWhhcm5lc3MgcnVudGltZSBkZXRlY3RlZCcsIGNvZGU6ICdIT1NUX05PVF9SRUFEWScgfTtcclxuICAgICAgcnVuQ2xpKFsnd2ViJywgZW5hYmxlZCA9PT0gdHJ1ZSA/ICdpbnN0YWxsLWRhZW1vbicgOiAndW5pbnN0YWxsLWRhZW1vbiddKTtcclxuICAgICAgLy8gaW5zdGFsbC1kYWVtb24gXHU3QUNCXHU1MzczXHU2MkM5XHU4RDc3XHU1Qjg4XHU2MkE0Olx1OEY2RVx1OEJFMlx1Nzg2RVx1OEJBNDt1bmluc3RhbGwgXHU1MzczXHU2NUY2XHU3NTFGXHU2NTQ4XHJcbiAgICAgIGlmIChlbmFibGVkID09PSB0cnVlKSB7XHJcbiAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCA1MDsgaSsrKSB7XHJcbiAgICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCA1MDApKTtcclxuICAgICAgICAgIGlmICgoYXdhaXQgcHJvYmVXZWJSZW1vdGUoKSkudXApIHJldHVybiB7IG9rOiB0cnVlLCBhdXRvc3RhcnQ6IHdlYkF1dG9zdGFydEluc3RhbGxlZCgpIH07XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiB7IGVycm9yOiAnZGFlbW9uIGRpZCBub3QgY29tZSB1cCB3aXRoaW4gMjVzJywgY29kZTogJ1JVTlRJTUVfQ1JBU0hFRCcgfTtcclxuICAgICAgfVxyXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgYXV0b3N0YXJ0OiB3ZWJBdXRvc3RhcnRJbnN0YWxsZWQoKSB9O1xyXG4gICAgfSk7XHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnJlbW90ZS13ZWItc3RhcnQnLCBhc3luYyAoZXZlbnQpID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgaWYgKGNsaUVudHJ5T2YoKSA9PT0gJycpIHJldHVybiB7IGVycm9yOiAnbm8gaG1oYXJuZXNzIHJ1bnRpbWUgZGV0ZWN0ZWQnLCBjb2RlOiAnSE9TVF9OT1RfUkVBRFknIH07XHJcbiAgICAgIGlmICgoYXdhaXQgcHJvYmVXZWJSZW1vdGUoKSkudXApIHtcclxuICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgYWxyZWFkeTogdHJ1ZSwgbGFuVXJsOiBgaHR0cDovLyR7bGFuSXBPZigpIHx8ICcxMjcuMC4wLjEnfToke1dFQl9QT1JUfWAgfTtcclxuICAgICAgfVxyXG4gICAgICBydW5DbGkoWyd3ZWInLCAnc3RhcnQnLCAnLS1leHBvc3VyZT1sYW4nXSk7XHJcbiAgICAgIC8vIFx1NUI4OFx1NjJBNFx1OEZEQlx1N0EwQlx1NTFCN1x1NTQyRlx1NTJBOCh0c3ggXHU3RjE2XHU4QkQxXHU2NTc0XHU1OTU3IENMSSk6XHU4RjZFXHU4QkUyIDI1c1xyXG4gICAgICBmb3IgKGxldCBpID0gMDsgaSA8IDUwOyBpKyspIHtcclxuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCA1MDApKTtcclxuICAgICAgICBpZiAoKGF3YWl0IHByb2JlV2ViUmVtb3RlKCkpLnVwKSB7XHJcbiAgICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgbGFuVXJsOiBgaHR0cDovLyR7bGFuSXBPZigpIHx8ICcxMjcuMC4wLjEnfToke1dFQl9QT1JUfWAgfTtcclxuICAgICAgICB9XHJcbiAgICAgIH1cclxuICAgICAgcmV0dXJuIHsgZXJyb3I6ICd3ZWIgZGFlbW9uIGRpZCBub3QgY29tZSB1cCB3aXRoaW4gMjVzIChzZWUgSE1IX0hPTUUvd2ViLmxvZyknLCBjb2RlOiAnUlVOVElNRV9DUkFTSEVEJyB9O1xyXG4gICAgfSk7XHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnJlbW90ZS13ZWItc3RvcCcsIGFzeW5jIChldmVudCkgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBydW5DbGkoWyd3ZWInLCAnc3RvcCddKTtcclxuICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCAyMDsgaSsrKSB7XHJcbiAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgNDAwKSk7XHJcbiAgICAgICAgaWYgKCEoYXdhaXQgcHJvYmVXZWJSZW1vdGUoKSkudXApIHJldHVybiB7IG9rOiB0cnVlIH07XHJcbiAgICAgIH1cclxuICAgICAgY29uc3Qgc3RpbGwgPSAoYXdhaXQgcHJvYmVXZWJSZW1vdGUoKSkudXA7XHJcbiAgICAgIHJldHVybiBzdGlsbCA/IHsgZXJyb3I6ICdzdGlsbCBydW5uaW5nJywgY29kZTogJ0JSSURHRV9FUlJPUicgfSA6IHsgb2s6IHRydWUgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gXHVEODNEXHVEQ0NFIFx1NjU4N1x1NEVGNlx1NEUwQVx1NEYyMChcdTY3MkNcdTU3MzBcdTU5MUFcdTkwMDk7cnVudGltZSBcdTY4MjFcdTlBOEMgaW5zaWRlV3MsXHU1REU1XHU0RjVDXHU1MzNBXHU1OTE2XHU2NTg3XHU0RUY2XHU0RjFBXHU4OEFCIDQwMCkgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpwaWNrLWZpbGVzJywgYXN5bmMgKGV2ZW50LCB0aXRsZTogdW5rbm93bikgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBjb25zdCB3aW4gPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5maW5kKCh3KSA9PiAhdy5pc0Rlc3Ryb3llZCgpKTtcclxuICAgICAgaWYgKHdpbiA9PT0gdW5kZWZpbmVkKSByZXR1cm4geyBlcnJvcjogJ25vIHdpbmRvdycsIGNvZGU6ICdCUklER0VfRVJST1InIH07XHJcbiAgICAgIGNvbnN0IHIgPSBhd2FpdCBkaWFsb2cuc2hvd09wZW5EaWFsb2cod2luLCB7XHJcbiAgICAgICAgdGl0bGU6IHR5cGVvZiB0aXRsZSA9PT0gJ3N0cmluZycgJiYgdGl0bGUgIT09ICcnID8gdGl0bGUuc2xpY2UoMCwgMTIwKSA6ICdcdTkwMDlcdTYyRTlcdTg5ODFcdTk2NDRcdTUyQTBcdTc2ODRcdTY1ODdcdTRFRjYoXHU1M0VGXHU1OTFBXHU5MDA5KScsXHJcbiAgICAgICAgcHJvcGVydGllczogWydvcGVuRmlsZScsICdtdWx0aVNlbGVjdGlvbnMnXSxcclxuICAgICAgfSk7XHJcbiAgICAgIGlmIChyLmNhbmNlbGVkIHx8IHIuZmlsZVBhdGhzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBjYW5jZWxlZDogdHJ1ZSB9O1xyXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgcGF0aHM6IHIuZmlsZVBhdGhzLnNsaWNlKDAsIDEwKSB9O1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBcdUQ4M0RcdURDQzEgXHU3NkVFXHU1RjU1XHU5MDA5XHU2MkU5KFx1NURFNVx1NEY1Q1x1NTMzQVx1NkRGQlx1NTJBMFx1NzY4NFx1NkQ0Rlx1ODlDOFx1NjMwOVx1OTRBRTtcdTUzOUZcdTc1MUYgY2hvb3NlcikgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpwaWNrLWRpcmVjdG9yeScsIGFzeW5jIChldmVudCwgdGl0bGU6IHVua25vd24pID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgY29uc3Qgd2luID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkuZmluZCgodykgPT4gIXcuaXNEZXN0cm95ZWQoKSk7XHJcbiAgICAgIGlmICh3aW4gPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgZXJyb3I6ICdubyB3aW5kb3cnLCBjb2RlOiAnQlJJREdFX0VSUk9SJyB9O1xyXG4gICAgICBjb25zdCByID0gYXdhaXQgZGlhbG9nLnNob3dPcGVuRGlhbG9nKHdpbiwge1xyXG4gICAgICAgIHRpdGxlOiB0eXBlb2YgdGl0bGUgPT09ICdzdHJpbmcnICYmIHRpdGxlICE9PSAnJyA/IHRpdGxlLnNsaWNlKDAsIDEyMCkgOiAnXHU5MDA5XHU2MkU5XHU2NTg3XHU0RUY2XHU1OTM5JyxcclxuICAgICAgICBwcm9wZXJ0aWVzOiBbJ29wZW5EaXJlY3RvcnknXSxcclxuICAgICAgfSk7XHJcbiAgICAgIGlmIChyLmNhbmNlbGVkIHx8IHIuZmlsZVBhdGhzWzBdID09PSB1bmRlZmluZWQpIHJldHVybiB7IG9rOiBmYWxzZSwgY2FuY2VsZWQ6IHRydWUgfTtcclxuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHBhdGg6IHIuZmlsZVBhdGhzWzBdIH07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIEAgXHU5NjQ0XHU0RUY2Olx1NURFNVx1NEY1Q1x1NTMzQVx1NjU4N1x1NEVGNlx1NjQxQ1x1N0QyMihydW50aW1lIFx1NjM4OFx1Njc0M1x1NzY4NFx1OERFRlx1NUY4NFx1Njc2NVx1NkU5MCkgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpmcy1zZWFyY2gnLCAoZXZlbnQsIHE6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3QgcXVlcnkgPSB0eXBlb2YgcSA9PT0gJ3N0cmluZycgPyBxLnNsaWNlKDAsIDIwMCkgOiAnJztcclxuICAgICAgaWYgKHF1ZXJ5ID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IHJlc3VsdHM6IFtdIH0pO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248eyByZXN1bHRzOiBBcnJheTx7IHJlbDogc3RyaW5nOyBwYXRoOiBzdHJpbmcgfT4gfT4oYC9hcGkvZnMvc2VhcmNoP3E9JHtlbmNvZGVVUklDb21wb25lbnQocXVlcnkpfWApKTtcclxuICAgIH0pO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6YXBwcm92ZScsIChldmVudCwgZ3JhbnRlZDogdW5rbm93biwgc2Vzc2lvbklkOiB1bmtub3duKSA9PlxyXG4gICAgICBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PignL2FwaS9hcHByb3ZlJywge1xyXG4gICAgICAgIGdyYW50ZWQ6IGdyYW50ZWQgPT09IHRydWUsXHJcbiAgICAgICAgc2Vzc2lvbklkOiB0eXBlb2Ygc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IHNlc3Npb25JZC5zbGljZSgwLCA4MCkgOiAnJyxcclxuICAgICAgfSkpKTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmludGVycnVwdCcsIChldmVudCwgc2Vzc2lvbklkOiB1bmtub3duKSA9PlxyXG4gICAgICBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PignL2FwaS9pbnRlcnJ1cHQnLCB7XHJcbiAgICAgICAgc2Vzc2lvbklkOiB0eXBlb2Ygc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IHNlc3Npb25JZC5zbGljZSgwLCA4MCkgOiAnJyxcclxuICAgICAgfSkpKTtcclxuXHJcbiAgICAvLyAtLS0tIE00Olx1NURFNVx1NEY1Q1x1NTMzQVx1NjU4N1x1NEVGNlx1OTc2MihcdThERUZcdTVGODRcdTYzODhcdTY3NDNcdTU3MjggcnVudGltZTppbnNpZGVXcyBcdTY4MjFcdTlBOEMpIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6ZnMtbGlzdCcsIChldmVudCwgcGF0aDogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBwID0gdHlwZW9mIHBhdGggPT09ICdzdHJpbmcnID8gcGF0aC5zbGljZSgwLCAxMDAwKSA6ICcnO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KGAvYXBpL2ZzP2ZpbGVzPTEke3AgIT09ICcnID8gYCZwYXRoPSR7ZW5jb2RlVVJJQ29tcG9uZW50KHApfWAgOiAnJ31gKSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmZzLXJlYWQnLCAoZXZlbnQsIHBhdGg6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3QgcCA9IHR5cGVvZiBwYXRoID09PSAnc3RyaW5nJyA/IHBhdGguc2xpY2UoMCwgMTAwMCkgOiAnJztcclxuICAgICAgaWYgKHAgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICdwYXRoIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcclxuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPFJlY29yZDxzdHJpbmcsIHVua25vd24+PihgL2FwaS9mcy9yZWFkP3BhdGg9JHtlbmNvZGVVUklDb21wb25lbnQocCl9YCkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTppbmplY3QnLCAoZXZlbnQsIHRleHQ6IHVua25vd24sIHNlc3Npb25JZDogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCB0ID0gdHlwZW9mIHRleHQgPT09ICdzdHJpbmcnID8gdGV4dC5zbGljZSgwLCAyMF8wMDApIDogJyc7XHJcbiAgICAgIGNvbnN0IHNpZCA9IHR5cGVvZiBzZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gc2Vzc2lvbklkLnNsaWNlKDAsIDgwKSA6ICcnO1xyXG4gICAgICBpZiAodCA9PT0gJycgfHwgc2lkID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IG9rOiBmYWxzZSwgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcclxuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KCcvYXBpL2luamVjdCcsIHsgdGV4dDogdCwgc2Vzc2lvbklkOiBzaWQgfSkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBcdTRGMUFcdThCRERcdTVCRkNcdTUxRkEoZXhwb3J0Lm1kIFx1MjE5MiBcdTRGRERcdTVCNThcdTVCRjlcdThCRERcdTY4NDY7XHU2NTg3XHU0RUY2XHU1MTk5XHU1MTY1XHU1M0VBXHU1NzI4IG1haW4pIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6ZXhwb3J0LXNlc3Npb24nLCBhc3luYyAoZXZlbnQsIGlkOiB1bmtub3duLCB0aXRsZTogdW5rbm93bikgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBjb25zdCBzaWQgPSB0eXBlb2YgaWQgPT09ICdzdHJpbmcnID8gaWQucmVwbGFjZSgvW15hLXpBLVowLTlfOi5ALV0vZywgJycpLnNsaWNlKDAsIDgwKSA6ICcnO1xyXG4gICAgICBpZiAoc2lkID09PSAnJykgcmV0dXJuIHsgZXJyb3I6ICdpZCByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfTtcclxuICAgICAgaWYgKGNsaWVudCA9PT0gbnVsbCB8fCBicmlkZ2UuaG9zdFN0YXRlICE9PSAncmVhZHknKSByZXR1cm4geyBlcnJvcjogYGhvc3Qgbm90IHJlYWR5ICgke2JyaWRnZS5ob3N0U3RhdGV9KWAsIGNvZGU6ICdIT1NUX05PVF9SRUFEWScgfTtcclxuICAgICAgdHJ5IHtcclxuICAgICAgICBjb25zdCBtZCA9IGF3YWl0IGNsaWVudC5nZXRUZXh0KGAvYXBpL3Nlc3Npb25zLyR7ZW5jb2RlVVJJQ29tcG9uZW50KHNpZCl9L2V4cG9ydC5tZGApO1xyXG4gICAgICAgIGNvbnN0IHdpbiA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmZpbmQoKHcpID0+ICF3LmlzRGVzdHJveWVkKCkpO1xyXG4gICAgICAgIGlmICh3aW4gPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgZXJyb3I6ICdubyB3aW5kb3cnLCBjb2RlOiAnQlJJREdFX0VSUk9SJyB9O1xyXG4gICAgICAgIGNvbnN0IHIgPSBhd2FpdCBkaWFsb2cuc2hvd1NhdmVEaWFsb2cod2luLCB7XHJcbiAgICAgICAgICB0aXRsZTogdHlwZW9mIHRpdGxlID09PSAnc3RyaW5nJyAmJiB0aXRsZSAhPT0gJycgPyB0aXRsZS5zbGljZSgwLCA4MCkgOiAnXHU1QkZDXHU1MUZBXHU0RjFBXHU4QkREJyxcclxuICAgICAgICAgIGRlZmF1bHRQYXRoOiBgaG1oLSR7c2lkfS5tZGAsXHJcbiAgICAgICAgICBmaWx0ZXJzOiBbeyBuYW1lOiAnTWFya2Rvd24nLCBleHRlbnNpb25zOiBbJ21kJ10gfV0sXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgaWYgKHIuY2FuY2VsZWQgfHwgci5maWxlUGF0aCA9PT0gdW5kZWZpbmVkIHx8IHIuZmlsZVBhdGggPT09ICcnKSByZXR1cm4geyBvazogZmFsc2UsIGNhbmNlbGVkOiB0cnVlIH07XHJcbiAgICAgICAgYXdhaXQgd3JpdGVGaWxlKHIuZmlsZVBhdGgsIG1kLCAndXRmOCcpO1xyXG4gICAgICAgIGxvZ0luZm8oJ2V4cG9ydCcsIGBzZXNzaW9uICR7c2lkfSBcdTIxOTIgJHtyLmZpbGVQYXRofWApO1xyXG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBwYXRoOiByLmZpbGVQYXRoIH07XHJcbiAgICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICAgIGNvbnN0IGRldGFpbCA9ICgoKSA9PiB7IHRyeSB7IHJldHVybiBKU09OLnN0cmluZ2lmeShlcnIpOyB9IGNhdGNoIHsgcmV0dXJuIFN0cmluZyhlcnIpOyB9IH0pKCkuc2xpY2UoMCwgMzAwKTtcclxuICAgICAgICByZXR1cm4geyBlcnJvcjogZGV0YWlsLCBjb2RlOiAnQlJJREdFX0VSUk9SJyB9O1xyXG4gICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIFx1NUJBMVx1NjI3OVx1NkEyMVx1NUYwRlx1OEJGQlx1NTE5OShcdTY3NDNcdTVBMDFcdTU3MjggcnVudGltZSBjb25maWc7XHU1MjA3XHU2MzYyXHU1RkM1XHU5ODdCXHU2NjNFXHU1RjBGKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmFwcHJvdmFsLWdldCcsIChldmVudCkgPT5cclxuICAgICAgaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248eyBzZXR0aW5ncz86IHsgYXBwcm92YWw/OiBzdHJpbmcgfSB9PignL2FwaS9zdGF0ZScpKSk7XHJcblxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTphcHByb3ZhbC1zZXQnLCAoZXZlbnQsIG1vZGU6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3QgbSA9IG1vZGUgPT09ICdhdXRvJyA/ICdhdXRvJyA6IG1vZGUgPT09ICdhc2snID8gJ2FzaycgOiAnJztcclxuICAgICAgaWYgKG0gPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICdtb2RlIG11c3QgYmUgYXNrfGF1dG8nLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvY29uZmlnJywgeyBhcHByb3ZhbDogbSB9KSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIGhtaGFybmVzcyBydW50aW1lIFx1OEZERVx1NjNBNShcdTgxRUFcdTUyQThcdTUzRDFcdTczQjAgKyBcdTYyNEJcdTUyQThcdTg5ODZcdTc2RDYgKyBcdTcwRURcdTUyMDdcdTYzNjIpIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cnVudGltZS1pbmZvJywgYXN5bmMgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IGQgPSBkZXRlY3RFeHRlcm5hbFJ1bnRpbWUoKTtcclxuICAgICAgY29uc3QgY2ZnID0gYXdhaXQgbG9hZFJ1bnRpbWVDb25maWcoKTtcclxuICAgICAgcmV0dXJuIHtcclxuICAgICAgICBtb2RlOiBicmlkZ2UubW9kZSxcclxuICAgICAgICBydW50aW1lRW50cnk6IGJyaWRnZS5ydW50aW1lRW50cnksXHJcbiAgICAgICAgb3ZlcnJpZGU6IGNmZy5lbnRyeSxcclxuICAgICAgICBkZW1vOiBjZmcuZGVtbyxcclxuICAgICAgICBkZXRlY3RlZDogZC5lbnRyeSxcclxuICAgICAgICBkZXRlY3RlZFZlcnNpb246IGQudmVyc2lvbixcclxuICAgICAgICBkZXRlY3RlZFNvdXJjZTogZC5zb3VyY2UsXHJcbiAgICAgIH07XHJcbiAgICB9KTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmJyb3dzZS1ydW50aW1lJywgYXN5bmMgKGV2ZW50LCB0aXRsZTogdW5rbm93bikgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBjb25zdCB3aW4gPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5maW5kKCh3KSA9PiAhdy5pc0Rlc3Ryb3llZCgpKTtcclxuICAgICAgaWYgKHdpbiA9PT0gdW5kZWZpbmVkKSByZXR1cm4geyBlcnJvcjogJ25vIHdpbmRvdycsIGNvZGU6ICdCUklER0VfRVJST1InIH07XHJcbiAgICAgIGNvbnN0IHIgPSBhd2FpdCBkaWFsb2cuc2hvd09wZW5EaWFsb2cod2luLCB7XHJcbiAgICAgICAgdGl0bGU6IHR5cGVvZiB0aXRsZSA9PT0gJ3N0cmluZycgJiYgdGl0bGUgIT09ICcnID8gdGl0bGUuc2xpY2UoMCwgMTIwKSA6ICdcdTkwMDlcdTYyRTkgaG1oYXJuZXNzIFx1NzY4NCBkZXNrdG9wLWhvc3QgXHU1MTY1XHU1M0UzJyxcclxuICAgICAgICBwcm9wZXJ0aWVzOiBbJ29wZW5GaWxlJ10sXHJcbiAgICAgICAgZmlsdGVyczogW3sgbmFtZTogJ2Rlc2t0b3AtaG9zdCcsIGV4dGVuc2lvbnM6IFsndHMnLCAnanMnXSB9XSxcclxuICAgICAgfSk7XHJcbiAgICAgIGlmIChyLmNhbmNlbGVkIHx8IHIuZmlsZVBhdGhzWzBdID09PSB1bmRlZmluZWQpIHJldHVybiB7IG9rOiBmYWxzZSwgY2FuY2VsZWQ6IHRydWUgfTtcclxuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGVudHJ5OiByLmZpbGVQYXRoc1swXSB9O1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyoqIFx1OEJCRVx1N0Y2RS9cdTZFMDVcdTk2NjRcdTYyNEJcdTUyQThcdTUxNjVcdTUzRTNcdTU0MEVcdTcwRURcdTkxQ0RcdTU0MkYgaG9zdChcdTdBN0FcdTRFMzI9XHU1NkRFXHU1MjMwXHU4MUVBXHU1MkE4XHU1M0QxXHU3M0IwKVx1MzAwMiAqL1xyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpzZXQtcnVudGltZScsIGFzeW5jIChldmVudCwgZW50cnk6IHVua25vd24pID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgY29uc3QgZSA9IHR5cGVvZiBlbnRyeSA9PT0gJ3N0cmluZycgPyBlbnRyeS50cmltKCkgOiAnJztcclxuICAgICAgaWYgKGUgIT09ICcnICYmICghaXNBYnNvbHV0ZShlKSB8fCAhZXhpc3RzU3luYyhlKSkpIHtcclxuICAgICAgICByZXR1cm4geyBlcnJvcjogJ1x1NTE2NVx1NTNFM1x1NUZDNVx1OTg3Qlx1NjYyRlx1NUI1OFx1NTcyOFx1NzY4NFx1N0VERFx1NUJGOVx1OERFRlx1NUY4NChkZXNrdG9wLWhvc3QudHMpJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9O1xyXG4gICAgICB9XHJcbiAgICAgIGF3YWl0IHNhdmVSdW50aW1lRW50cnlPdmVycmlkZShlKTtcclxuICAgICAgLy8gXHU3MEVEXHU1MjA3XHU2MzYyOlx1NTE0OFx1NEYxOFx1OTZDNVx1NTA1Q1x1NjM4OVx1NUY1M1x1NTI0RCBob3N0LFx1NTE4RFx1NjMwOVx1NjVCMFx1OTE0RFx1N0Y2RVx1NjJDOVx1OEQ3N1xyXG4gICAgICBzc2VBYm9ydD8uYWJvcnQoKTtcclxuICAgICAgaWYgKHN1cGVydmlzb3IgIT09IG51bGwpIGF3YWl0IHN1cGVydmlzb3Iuc3RvcCgpO1xyXG4gICAgICBhd2FpdCBzdGFydEhvc3QoKTtcclxuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIG1vZGU6IGJyaWRnZS5tb2RlIH07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIHY1LjEgXHU5OTk2XHU1NDJGXHU1Qjg5XHU4OEM1XHU1NDExXHU1QkZDOlx1NjcyQ1x1NjczQVx1NjhDMFx1NkQ0QiAvIFx1NEUwQlx1OEY3RFx1NUI4OVx1ODhDNShcdThGREJcdTVFQTZcdTRFOEJcdTRFRjYpIC8gXHU1NDExXHU1QkZDXHU3MkI2XHU2MDAxIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6ZGV0ZWN0LXJ1bnRpbWUnLCAoZXZlbnQpID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgY29uc3QgaW5mbyA9IGJ1bmRsZWRSdW50aW1lSW5mbygpO1xyXG4gICAgICAvLyBVSVZFUklGWSBcdTU0MTFcdTVCRkNcdTZCNjVcdTc2ODRcIlx1NEYyQVx1OTAyMFx1NjcyQVx1OTE0RFx1N0Y2RVx1NjAwMVwiOmZha2UgXHU2QTIxXHU1RjBGXHU0RTBCXHU2MDUyXHU2MkE1XHU2NzJBXHU2OEMwXHU2RDRCXHJcbiAgICAgIC8vIChcdTc3MUZcdTVCOUVcdTY4QzBcdTZENEJcdThERUZcdTVGODRcdTc1MzEgcmVhbCBcdTUzRDhcdTRGNTNcdTlBOENcdTY1MzYsXHU4OUMxIGV2aWRlbmNlL3NldHVwLXdpemFyZC8pXHUzMDAyXHJcbiAgICAgIC8vIFVJVkVSSUZZX0ZBS0VfREVURUNUX0ZPVU5EPTEodWl2ZXJpZnkgXHU3QTg0XHU1QzRGXHU1NzNBXHU2NjZGXHU4RkQwXHU4ODRDXHU0RTJEXHU1MkE4XHU2MDAxXHU3RjZFXHU0RjREKTpcclxuICAgICAgLy8gXHU0RjJBXHU5MDIwXCJcdTY4QzBcdTZENEJcdTUyMzBcdTVERjJcdTg4QzVcIixcdThCQTlcdTU0MTFcdTVCRkNcdTUxRkFcdTczQjBcdTY4QzBcdTZENEJcdTk4NzVcdTRFMDlcdTkwMDlcdTk4NzkgXHUyMTkyIFx1NTM1NVx1NTFGQlx1NTI0RFx1OEZEQiBcdTIxOTIgXHU5MDA5XHU2MkU5XHU5ODc1XHUzMDAyXHJcbiAgICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9XSVpBUkQgPT09ICdmYWtlJyAmJiBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9GQUtFID09PSAnMScpIHtcclxuICAgICAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfRkFLRV9ERVRFQ1RfRk9VTkQgPT09ICcxJykge1xyXG4gICAgICAgICAgcmV0dXJuIHsgZm91bmQ6IHRydWUsIHZlcnNpb246ICcwLjAuMC12ZXJpZnknLCBlbnRyeTogJ3ZlcmlmeTovL2Zha2UtZW50cnknLCBzb3VyY2U6ICd2ZXJpZnknLCBidW5kbGVkOiBpbmZvLCBucG06IG5wbU9uUGF0aCgpIH07XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiB7IGZvdW5kOiBmYWxzZSwgdmVyc2lvbjogJycsIGVudHJ5OiAnJywgc291cmNlOiAnJywgYnVuZGxlZDogaW5mbywgbnBtOiBucG1PblBhdGgoKSB9O1xyXG4gICAgICB9XHJcbiAgICAgIGNvbnN0IGQgPSBkZXRlY3RFeHRlcm5hbFJ1bnRpbWUoKTtcclxuICAgICAgcmV0dXJuIHsgZm91bmQ6IGQuZW50cnkgIT09ICcnLCB2ZXJzaW9uOiBkLnZlcnNpb24sIGVudHJ5OiBkLmVudHJ5LCBzb3VyY2U6IGQuc291cmNlLCBidW5kbGVkOiBpbmZvLCBucG06IG5wbU9uUGF0aCgpIH07XHJcbiAgICB9KTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmluc3RhbGwtY2xpJywgKGV2ZW50LCBvcHRzOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IG8gPSAob3B0cyA/PyB7fSkgYXMgeyBmb3JjZVRnej86IHVua25vd247IG1pcnJvckZpcnN0PzogdW5rbm93biB9O1xyXG4gICAgICAvLyBVSVZFUklGWSBmYWtlIFx1NTQxMVx1NUJGQzpcdTgxRUFcdTUyQThcdTVCODlcdTg4QzVcdThERUZcdTVGODRcdThENzBcdTZBMjFcdTYyREZcdThGREJcdTVFQTYoXHU0RTBEXHU3OEIwXHU3OEMxXHU3NkQ4L1x1N0Y1MVx1N0VEQy9cdTRFMERcdTcwRURcdTUyMDdcdTYzNjIpLFxyXG4gICAgICAvLyBcdTRFMTRcdTRFMERcdTUzRDEgZG9uZVx1MjAxNFx1MjAxNFx1OUE4Q1x1NjUzNlx1ODk4MVx1NTcyOFx1NUI4OVx1ODhDNVx1OTg3NVx1NzBCOVwiXHU2NTM5XHU3NTI4XHU1MTg1XHU3RjZFXCJcdTUyMDdcdTYzNjJcdTk0RkVcdTYzQTVcdTMwMDJcclxuICAgICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX1dJWkFSRCA9PT0gJ2Zha2UnICYmIHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX0ZBS0UgPT09ICcxJykge1xyXG4gICAgICAgIGNvbnN0IHNlbmRTaW0gPSAocDogSW5zdGFsbFByb2dyZXNzKTogdm9pZCA9PiB7XHJcbiAgICAgICAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcclxuICAgICAgICAgICAgaWYgKCF3LmlzRGVzdHJveWVkKCkpIHcud2ViQ29udGVudHMuc2VuZCgnaW5zdGFsbDpwcm9ncmVzcycsIHApO1xyXG4gICAgICAgICAgfVxyXG4gICAgICAgIH07XHJcbiAgICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgICAgc2VuZFNpbSh7IHBoYXNlOiAnY2hlY2snLCB0ZXh0OiAnXHU2OEMwXHU2N0U1IG5wbVx1MjAyNih2ZXJpZnkgXHU2QTIxXHU2MkRGKScgfSk7XHJcbiAgICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCA0MDApKTtcclxuICAgICAgICAgIHNlbmRTaW0oeyBwaGFzZTogJ25wbScsIHRleHQ6ICducG0gaW5zdGFsbCBAaG1oYXJuZXNzL2NsaSBcdTIxOTIgfi8uaG1oYXJuZXNzLWdsb2JhbCh2ZXJpZnkgXHU2QTIxXHU2MkRGLFx1NEUwRFx1ODQzRFx1NzZEOCknIH0pO1xyXG4gICAgICAgIH0pKCk7XHJcbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHRlc3Q6IHRydWUgfTtcclxuICAgICAgfVxyXG4gICAgICByZXR1cm4gc3RhcnRDbGlJbnN0YWxsKFxyXG4gICAgICAgIHtcclxuICAgICAgICAgIHNlbmRQcm9ncmVzczogKHA6IEluc3RhbGxQcm9ncmVzcyk6IHZvaWQgPT4ge1xyXG4gICAgICAgICAgICBsb2dJbmZvKCdpbnN0YWxsJywgYCR7cC5waGFzZX0ke3AucGN0ICE9PSB1bmRlZmluZWQgPyBgICR7cC5wY3R9JWAgOiAnJ30gJHtwLnRleHR9YCk7XHJcbiAgICAgICAgICAgIGZvciAoY29uc3QgdyBvZiBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKSkge1xyXG4gICAgICAgICAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ2luc3RhbGw6cHJvZ3Jlc3MnLCBwKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgfSxcclxuICAgICAgICAgIGxvZzogKG06IHN0cmluZyk6IHZvaWQgPT4geyBsb2dJbmZvKCdpbnN0YWxsJywgbSk7IH0sXHJcbiAgICAgICAgICAvLyBcdTVCODlcdTg4QzVcdTYyMTBcdTUyOUZcdTUzNzNcdTYzMDFcdTRFNDVcdTUzMTZcdTVFNzZcdTcwRURcdTUyMDdcdTYzNjIoXHU1NDExXHU1QkZDXHU5NjhGXHU1NDBFXHU2NTM2XHU1QzNFO1x1NEUyRFx1OTAxNFx1NTNENlx1NkQ4OFx1NEU1Rlx1NURGMlx1NzUxRlx1NjU0OClcclxuICAgICAgICAgIG9uSW5zdGFsbGVkOiAoZW50cnk6IHN0cmluZyk6IHZvaWQgPT4ge1xyXG4gICAgICAgICAgICB2b2lkIChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgICAgICAgYXdhaXQgc2F2ZVJ1bnRpbWVDb25maWcoeyBlbnRyeSwgZGVtbzogZmFsc2UgfSk7XHJcbiAgICAgICAgICAgICAgc3NlQWJvcnQ/LmFib3J0KCk7XHJcbiAgICAgICAgICAgICAgaWYgKHN1cGVydmlzb3IgIT09IG51bGwpIGF3YWl0IHN1cGVydmlzb3Iuc3RvcCgpO1xyXG4gICAgICAgICAgICAgIGF3YWl0IHN0YXJ0SG9zdCgpO1xyXG4gICAgICAgICAgICB9KSgpO1xyXG4gICAgICAgICAgfSxcclxuICAgICAgICB9LFxyXG4gICAgICAgIHtcclxuICAgICAgICAgIGZvcmNlVGd6OiBvLmZvcmNlVGd6ID09PSB0cnVlLFxyXG4gICAgICAgICAgbWlycm9yRmlyc3Q6IG8ubWlycm9yRmlyc3QgPT09ICducG1taXJyb3InID8gJ25wbW1pcnJvcicgOiBvLm1pcnJvckZpcnN0ID09PSAnbnBtanMnID8gJ25wbWpzJyA6IHVuZGVmaW5lZCxcclxuICAgICAgICB9LFxyXG4gICAgICApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpnZXQtd2l6YXJkJywgYXN5bmMgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IHZhcmlhbnQgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9XSVpBUkQ7XHJcbiAgICAgIGlmICh2YXJpYW50ICE9PSB1bmRlZmluZWQgJiYgdmFyaWFudCAhPT0gJycpIHtcclxuICAgICAgICAvLyBcdTlBOENcdTY1MzZcdTY3ODRcdTkwMjA6XHU1RjNBXHU1MjM2XHU1NDExXHU1QkZDXHU1M0VGXHU4OUMxXHU0RTE0XHU4OUM2XHU0RTNBXHU2NzJBXHU5MTREXHU3RjZFKFx1NTNFRlx1OTFDRFx1NTkwRFx1OEREMSk7cGVyc2lzdGVkPVx1NzcxRlx1NUI5RVx1ODQzRFx1NzZEOFxyXG4gICAgICAgIC8vIFx1NzJCNlx1NjAwMShcdTU0MTFcdTVCRkNcdTZCNjVcdTY1QURcdThBMDBcIlx1OTAwOVx1NjJFOVx1NjMwMVx1NEU0NVwiXHU3NTI4LFx1NEUwRFx1NUY3MVx1NTRDRCBVSSBcdTUyMjRcdTVCOUEpXHJcbiAgICAgICAgY29uc3QgdyA9IGF3YWl0IGxvYWRXaXphcmRTdGF0ZSgpO1xyXG4gICAgICAgIHJldHVybiB7IGRvbmU6IGZhbHNlLCBjaG9pY2U6ICcnLCBzdXBwcmVzc2VkOiBmYWxzZSwgcGVyc2lzdGVkOiB7IGRvbmU6IHcuZG9uZSwgY2hvaWNlOiB3LmNob2ljZSB9IH07XHJcbiAgICAgIH1cclxuICAgICAgY29uc3QgdyA9IGF3YWl0IGxvYWRXaXphcmRTdGF0ZSgpO1xyXG4gICAgICBjb25zdCBjZmcgPSBhd2FpdCBsb2FkUnVudGltZUNvbmZpZygpO1xyXG4gICAgICAvLyBcdTVERjJcdTkxNERcdTdGNkVcdThGQzcgcnVudGltZShcdTYyNEJcdTUyQThcdTUxNjVcdTUzRTMvXHU1NDExXHU1QkZDXHU5MDA5XHU2MkU5L1x1NkYxNFx1NzkzQSlcdTg5QzZcdTU0MENcdTVERjJcdTVCOENcdTYyMTBcdTk5OTZcdTU0MkZcclxuICAgICAgcmV0dXJuIHsgZG9uZTogdy5kb25lIHx8IGNmZy5lbnRyeSAhPT0gJycgfHwgY2ZnLmRlbW8sIGNob2ljZTogdy5jaG9pY2UsIHN1cHByZXNzZWQ6IHdpemFyZFN1cHByZXNzZWQoKSB9O1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyoqIFx1NTQxMVx1NUJGQ1x1NjUzNlx1NUMzRTpcdTYzMDFcdTRFNDVcdTUzMTZcdTkwMDlcdTYyRTlcdTVFNzZcdTVFOTRcdTc1MjgoZXh0ZXJuYWwvYnVuZGxlZFx1MjE5Mlx1NTE2NVx1NTNFM1x1ODk4Nlx1NzZENjtkZW1vXHUyMTkyXHU2MzAxXHU0RTQ1XHU2RjE0XHU3OTNBO1xyXG4gICAgICogIGluc3RhbGxcdTIxOTJcdTUxNjVcdTUzRTNcdTVERjJcdTc1MzFcdTVCODlcdTg4QzVcdTU2NjhcdTYzMDFcdTRFNDVcdTUzMTYsXHU1M0VBXHU4QkIwXHU3MkI2XHU2MDAxKVx1MzAwMmZha2UvXHU2RDRCXHU4QkQ1XHU3M0FGXHU1ODgzXHU1M0VBXHU4QkIwXHU3MkI2XHU2MDAxXHUzMDAyICovXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOndpemFyZC1jb21wbGV0ZScsIGFzeW5jIChldmVudCwgY2hvaWNlOiB1bmtub3duLCBlbnRyeTogdW5rbm93bikgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBjb25zdCBjID0gY2hvaWNlID09PSAnZXh0ZXJuYWwnIHx8IGNob2ljZSA9PT0gJ2luc3RhbGwnIHx8IGNob2ljZSA9PT0gJ2J1bmRsZWQnIHx8IGNob2ljZSA9PT0gJ2RlbW8nID8gY2hvaWNlIDogJyc7XHJcbiAgICAgIGlmIChjID09PSAnJykgcmV0dXJuIHsgZXJyb3I6ICdjaG9pY2UgbXVzdCBiZSBleHRlcm5hbHxpbnN0YWxsfGJ1bmRsZWR8ZGVtbycsIGNvZGU6ICdCQURfUkVRVUVTVCcgfTtcclxuICAgICAgY29uc3QgZSA9IHR5cGVvZiBlbnRyeSA9PT0gJ3N0cmluZycgPyBlbnRyeSA6ICcnO1xyXG4gICAgICBhd2FpdCBzYXZlV2l6YXJkU3RhdGUoYyk7XHJcbiAgICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9GQUtFID09PSAnMScpIHJldHVybiB7IG9rOiB0cnVlLCBtb2RlOiBicmlkZ2UubW9kZSwgdGVzdDogdHJ1ZSB9O1xyXG4gICAgICBjb25zdCByZXBvUm9vdCA9IGpvaW4oaGVyZSwgJy4uJywgJy4uJywgJy4uJywgJy4uJyk7XHJcbiAgICAgIGlmIChjID09PSAnZXh0ZXJuYWwnIHx8IGMgPT09ICdidW5kbGVkJykge1xyXG4gICAgICAgIGNvbnN0IHRhcmdldCA9IGMgPT09ICdidW5kbGVkJyA/IGJ1bmRsZWRSdW50aW1lUGF0aChyZXBvUm9vdCkgOiBlO1xyXG4gICAgICAgIGlmICh0YXJnZXQgPT09ICcnIHx8ICFpc0Fic29sdXRlKHRhcmdldCkgfHwgIWV4aXN0c1N5bmModGFyZ2V0KSkge1xyXG4gICAgICAgICAgcmV0dXJuIHsgZXJyb3I6ICdydW50aW1lIFx1NTE2NVx1NTNFM1x1NEUwRFx1NUI1OFx1NTcyOCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfTtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgc2F2ZVJ1bnRpbWVDb25maWcoeyBlbnRyeTogdGFyZ2V0LCBkZW1vOiBmYWxzZSB9KTtcclxuICAgICAgfSBlbHNlIGlmIChjID09PSAnZGVtbycpIHtcclxuICAgICAgICBhd2FpdCBzYXZlUnVudGltZUNvbmZpZyh7IGVudHJ5OiAnJywgZGVtbzogdHJ1ZSB9KTtcclxuICAgICAgfVxyXG4gICAgICBpZiAoYyAhPT0gJ2luc3RhbGwnKSB7XHJcbiAgICAgICAgLy8gaW5zdGFsbDpcdTVCODlcdTg4QzVcdTU2NjhcdTVERjJcdTU3Mjggb25JbnN0YWxsZWQgXHU2MzAxXHU0RTQ1XHU1MzE2XHU1RTc2XHU3MEVEXHU1MjA3XHU2MzYyLFx1OEZEOVx1OTFDQ1x1NEUwRFx1NTE4RFx1OTFDRFx1NTQyRlxyXG4gICAgICAgIHNzZUFib3J0Py5hYm9ydCgpO1xyXG4gICAgICAgIGlmIChzdXBlcnZpc29yICE9PSBudWxsKSBhd2FpdCBzdXBlcnZpc29yLnN0b3AoKTtcclxuICAgICAgICBhd2FpdCBzdGFydEhvc3QoKTtcclxuICAgICAgfVxyXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgbW9kZTogYnJpZGdlLm1vZGUgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gUHJvdmlkZXIgXHU4QkJFXHU3RjZFKDAzIFx1MDBBN1x1NEUwMzprZXkgXHU1M0VBXHU1MUZBIGhhc0tleS9cdTY3MkJcdTU2REJcdTRGNEQ7XHU0RkREXHU1QjU4XHU3NkY0XHU1MTk5IHJ1bnRpbWUpIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cHJvdmlkZXJzJywgKGV2ZW50KSA9PlxyXG4gICAgICBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjx7IHByb3ZpZGVyc0RldGFpbD86IEFycmF5PHsgbmFtZTogc3RyaW5nOyBtb2RlbDogc3RyaW5nOyBiYXNlVXJsOiBzdHJpbmc7IGhhc0tleTogYm9vbGVhbjsga2V5VGFpbD86IHN0cmluZyB9PjsgbW9kZWw/OiBzdHJpbmcgfT4oJy9hcGkvc3RhdGUnKSkpO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cHJvdmlkZXItc2F2ZScsIChldmVudCwgcHJvdmlkZXI6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3QgcCA9IHByb3ZpZGVyIGFzIHsgbmFtZT86IHVua25vd247IGJhc2VVcmw/OiB1bmtub3duOyBtb2RlbD86IHVua25vd247IGFwaUtleT86IHVua25vd24gfTtcclxuICAgICAgY29uc3QgbmFtZSA9IHR5cGVvZiBwPy5uYW1lID09PSAnc3RyaW5nJyA/IHAubmFtZS5zbGljZSgwLCA4MCkgOiAnJztcclxuICAgICAgY29uc3QgYmFzZVVybCA9IHR5cGVvZiBwPy5iYXNlVXJsID09PSAnc3RyaW5nJyA/IHAuYmFzZVVybC5zbGljZSgwLCAzMDApIDogJyc7XHJcbiAgICAgIGNvbnN0IG1vZGVsID0gdHlwZW9mIHA/Lm1vZGVsID09PSAnc3RyaW5nJyA/IHAubW9kZWwuc2xpY2UoMCwgMTIwKSA6ICcnO1xyXG4gICAgICBpZiAobmFtZSA9PT0gJycgfHwgYmFzZVVybCA9PT0gJycgfHwgbW9kZWwgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICduYW1lL2Jhc2VVcmwvbW9kZWwgcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xyXG4gICAgICBjb25zdCBib2R5OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgbmFtZSwgYmFzZVVybCwgbW9kZWwgfTtcclxuICAgICAgLy8gYXBpS2V5IFx1NTNFQVx1NTcyOFx1NjYzRVx1NUYwRlx1OEY5M1x1NTE2NVx1NjVGNlx1NEUwQVx1NEYyMCxcdTdFRERcdTRFMERcdTU2REVcdTY2M0UocmVuZGVyZXIgXHU4ODY4XHU1MzU1XHU2M0QwXHU0RUE0XHU1NDBFXHU1MzczXHU2RTA1XHU3QTdBKVxyXG4gICAgICBpZiAodHlwZW9mIHA/LmFwaUtleSA9PT0gJ3N0cmluZycgJiYgcC5hcGlLZXkgIT09ICcnKSBib2R5LmFwaUtleSA9IHAuYXBpS2V5LnNsaWNlKDAsIDMwMCk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PignL2FwaS9wcm92aWRlcnMnLCBib2R5KSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIFx1NURFNVx1NEY1Q1x1NTMzQSgwMyBcdTAwQTdcdTUxNkQ7XHU1MjA3XHU2MzYyXHU4QkVEXHU0RTQ5XHU0RTBFIHdlYiBcdTc2RjhcdTU0MEM6cnVudGltZSBcdTUzNTVcdTkwMDkgY3dkKSAtLS0tXHJcbiAgICAvLyBcdTUyMTdcdTg4NjhcdTU0MENcdTY1RjZcdTdGMTNcdTVCNThcdTRFM0EgZm9yZ2UgXHU3Njg0XHU0RTBBXHU0RjIwL1x1NTE0Qlx1OTY4Nlx1OERFRlx1NUY4NFx1OTVFOChcdTUxNDFcdThCQjhcdTc2ODRcdTVERTVcdTRGNUNcdTUzM0FcdTY4MzkpXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOndvcmtzcGFjZXMnLCAoZXZlbnQpID0+XHJcbiAgICAgIGhvc3RDYWxsKGV2ZW50LCBhc3luYyAoYykgPT4ge1xyXG4gICAgICAgIGNvbnN0IHIgPSBhd2FpdCBjLmdldEpzb248eyBjdXJyZW50OiBzdHJpbmc7IGl0ZW1zOiBBcnJheTx7IGlkOiBzdHJpbmc7IG5hbWU6IHN0cmluZzsgcGF0aDogc3RyaW5nIH0+IH0+KCcvYXBpL3dvcmtzcGFjZXMnKTtcclxuICAgICAgICB3c1Jvb3RzQ2FjaGUgPSByLml0ZW1zLm1hcCgodykgPT4gdy5wYXRoKTtcclxuICAgICAgICByZXR1cm4gcjtcclxuICAgICAgfSkpO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6d29ya3NwYWNlLXVzZScsIChldmVudCwgaWQ6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3Qgd2lkID0gdHlwZW9mIGlkID09PSAnc3RyaW5nJyA/IGlkLnNsaWNlKDAsIDYwKSA6ICcnO1xyXG4gICAgICBpZiAod2lkID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAnaWQgcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvd29ya3NwYWNlcy91c2UnLCB7IGlkOiB3aWQgfSkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTp3b3Jrc3BhY2UtYWRkJywgKGV2ZW50LCBuYW1lOiB1bmtub3duLCBwYXRoOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IG4gPSB0eXBlb2YgbmFtZSA9PT0gJ3N0cmluZycgPyBuYW1lLnNsaWNlKDAsIDEyMCkgOiAnJztcclxuICAgICAgY29uc3QgcCA9IHR5cGVvZiBwYXRoID09PSAnc3RyaW5nJyA/IHBhdGguc2xpY2UoMCwgMTAwMCkgOiAnJztcclxuICAgICAgaWYgKHAgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICdwYXRoIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcclxuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KCcvYXBpL3dvcmtzcGFjZXMnLCB7IG5hbWU6IG4gPT09ICcnID8gdW5kZWZpbmVkIDogbiwgcGF0aDogcCB9KSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIFx1NEYxQVx1OEJERFx1NUY1Mlx1Njg2My9cdTUyMjBcdTk2NjQoXHU3OUZCXHU1MTY1IGFyY2hpdmUvdHJhc2gsXHU1M0VGXHU2MDYyXHU1OTBEO3J1bnRpbWUgXHU2NzQzXHU1QTAxKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnNlc3Npb24tb3AnLCAoZXZlbnQsIGlkOiB1bmtub3duLCBvcDogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBzaWQgPSB0eXBlb2YgaWQgPT09ICdzdHJpbmcnID8gaWQucmVwbGFjZSgvW15hLXpBLVowLTlfOi5ALV0vZywgJycpLnNsaWNlKDAsIDgwKSA6ICcnO1xyXG4gICAgICBjb25zdCBvID0gb3AgPT09ICdhcmNoaXZlJyB8fCBvcCA9PT0gJ2RlbGV0ZScgPyBvcCA6ICcnO1xyXG4gICAgICBpZiAoc2lkID09PSAnJyB8fCBvID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAnaWQgYW5kIG9wKGFyY2hpdmV8ZGVsZXRlKSByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PihgL2FwaS9zZXNzaW9ucy8ke2VuY29kZVVSSUNvbXBvbmVudChzaWQpfS8ke299YCwge30pKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gTTQ6RGlmZiBcdTk3NjJcdTY3N0YoXHU1M0VBXHU4QkZCIGdpdCBcdTUzRDhcdTY2RjQ7XHU2Mzg4XHU2NzQzXHU1NzI4IHJ1bnRpbWUpIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6ZGlmZicsIChldmVudCwgc2Vzc2lvbklkOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IHNpZCA9IHR5cGVvZiBzZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gc2Vzc2lvbklkLnNsaWNlKDAsIDgwKSA6ICcnO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KGAvYXBpL2RpZmYke3NpZCAhPT0gJycgPyBgP3Nlc3Npb25JZD0ke2VuY29kZVVSSUNvbXBvbmVudChzaWQpfWAgOiAnJ31gKSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIE01Olx1OEJBNFx1NzdFNVx1NzJCNlx1NjAwMShcdTdFRDNcdTY3ODRcdTUzMTZcdTRFOEJcdTVCOUU7XHU3RjNBXHU2NTcwXHU2MzZFXHU1QjU3XHU2QkI1XHU3NTMxIFVJIFx1NjYzRVx1NzkzQVwiXHU2NUUwXHU2NTcwXHU2MzZFXCIpIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6Y29nbml0aXZlJywgKGV2ZW50KSA9PlxyXG4gICAgICBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oJy9hcGkvY29nbml0aXZlJykpKTtcclxuXHJcbiAgICAvLyAtLS0tIFx1NTM4Nlx1NTNGMlx1NEYxQVx1OEJERFx1OTg4NFx1ODlDOChcdTY3MDBcdTU0MEUgODAgXHU2NzYxLFx1NkJDRlx1Njc2MSA1MDAgXHU1QjU3O3J1bnRpbWUgXHU2NzQzXHU1QTAxXHU2NTcwXHU2MzZFKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnNlc3Npb24tcHJldmlldycsIChldmVudCwgaWQ6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIGlkID09PSAnc3RyaW5nJyA/IGlkLnJlcGxhY2UoL1teYS16QS1aMC05XzouQC1dL2csICcnKS5zbGljZSgwLCA4MCkgOiAnJztcclxuICAgICAgaWYgKHNpZCA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ2lkIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcclxuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPFJlY29yZDxzdHJpbmcsIHVua25vd24+PihgL2FwaS9zZXNzaW9ucy8ke2VuY29kZVVSSUNvbXBvbmVudChzaWQpfWApKTtcclxuICAgIH0pO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6c3RvcC1ob3N0JywgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicgfTtcclxuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIHNzZUFib3J0Py5hYm9ydCgpO1xyXG4gICAgICAgIGF3YWl0IHN1cGVydmlzb3I/LnN0b3AoKTtcclxuICAgICAgICBhcHAucXVpdCgpO1xyXG4gICAgICB9KSgpO1xyXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSB9O1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBcdTRFRDNcdTVFOTNcdTk3NjJcdTY3N0YgSVBDKFx1NEVGQlx1NTJBMSAxNC1COlx1OTAxMFx1NjVCOVx1NkNENVx1NzY3RFx1NTQwRFx1NTM1NSArIFx1NTNDMlx1NjU3MFx1NjgyMVx1OUE4QztyZW5kZXJlciBcdTZDMzhcdTRFMEQgc3Bhd24pIC0tLS1cclxuICAgIGNvbnN0IGZvcmdlRXJyID0gKGV2ZW50OiBFbGVjdHJvbi5JcGNNYWluSW52b2tlRXZlbnQsIGZuOiAoKSA9PiBQcm9taXNlPHVua25vd24+KTogUHJvbWlzZTx1bmtub3duPiA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9KTtcclxuICAgICAgcmV0dXJuIGZuKCkuY2F0Y2goKGVycjogdW5rbm93bikgPT4gKHsgb2s6IGZhbHNlLCBjb2RlOiAnQlJJREdFX0VSUk9SJywgZXJyb3I6IFN0cmluZyhlcnIpLnNsaWNlKDAsIDMwMCkgfSkpO1xyXG4gICAgfTtcclxuICAgIGlwY01haW4uaGFuZGxlKCdmb3JnZTpzdGF0dXMnLCAoZXZlbnQpID0+IGZvcmdlRXJyKGV2ZW50LCAoKSA9PiBmb3JnZVN2YygpLnN0YXR1cygpKSk7XHJcbiAgICBpcGNNYWluLmhhbmRsZSgnZm9yZ2U6bG9naW4nLCAoZXZlbnQsIGg6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3QgaG9zdCA9IGNoZWNrSG9zdChoKTtcclxuICAgICAgaWYgKGhvc3QgPT09IG51bGwpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBvazogZmFsc2UsIGNvZGU6ICdCQURfUkVRVUVTVCcsIGVycm9yOiAnaG9zdCBtdXN0IGJlIGdpdGh1YnxhdG9tZ2l0JyB9KTtcclxuICAgICAgcmV0dXJuIGZvcmdlRXJyKGV2ZW50LCAoKSA9PiBmb3JnZVN2YygpLmxvZ2luKGhvc3QpKTtcclxuICAgIH0pO1xyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2ZvcmdlOnJlcG9zJywgKGV2ZW50LCBoOiB1bmtub3duLCBwYWdlOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IGhvc3QgPSBjaGVja0hvc3QoaCk7XHJcbiAgICAgIGNvbnN0IHAgPSB0eXBlb2YgcGFnZSA9PT0gJ251bWJlcicgJiYgTnVtYmVyLmlzRmluaXRlKHBhZ2UpID8gTWF0aC5mbG9vcihwYWdlKSA6IDE7XHJcbiAgICAgIGlmIChob3N0ID09PSBudWxsKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgb2s6IGZhbHNlLCBjb2RlOiAnQkFEX1JFUVVFU1QnLCBlcnJvcjogJ2hvc3QgbXVzdCBiZSBnaXRodWJ8YXRvbWdpdCcgfSk7XHJcbiAgICAgIHJldHVybiBmb3JnZUVycihldmVudCwgKCkgPT4gZm9yZ2VTdmMoKS5yZXBvcyhob3N0LCBwKSk7XHJcbiAgICB9KTtcclxuICAgIGNvbnN0IHJlcG9BcmdzID0gKGg6IHVua25vd24sIHJlcG86IHVua25vd24pOiB7IGhvc3Q6IEZvcmdlSG9zdDsgcmVwbzogc3RyaW5nIH0gfCB7IGJhZDogc3RyaW5nIH0gPT4ge1xyXG4gICAgICBjb25zdCBob3N0ID0gY2hlY2tIb3N0KGgpO1xyXG4gICAgICBjb25zdCByID0gY2hlY2tSZXBvKHJlcG8pO1xyXG4gICAgICBpZiAoaG9zdCA9PT0gbnVsbCB8fCByID09PSBudWxsKSByZXR1cm4geyBiYWQ6ICdob3N0IG11c3QgYmUgZ2l0aHVifGF0b21naXQsIHJlcG8gbXVzdCBiZSBvd25lci9uYW1lJyB9O1xyXG4gICAgICByZXR1cm4geyBob3N0LCByZXBvOiByIH07XHJcbiAgICB9O1xyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2ZvcmdlOnBycycsIChldmVudCwgaDogdW5rbm93biwgcmVwbzogdW5rbm93biwgc3RhdGU6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3QgYSA9IHJlcG9BcmdzKGgsIHJlcG8pO1xyXG4gICAgICBpZiAoJ2JhZCcgaW4gYSkgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IG9rOiBmYWxzZSwgY29kZTogJ0JBRF9SRVFVRVNUJywgZXJyb3I6IGEuYmFkIH0pO1xyXG4gICAgICByZXR1cm4gZm9yZ2VFcnIoZXZlbnQsICgpID0+IGZvcmdlU3ZjKCkucHJzKGEuaG9zdCwgYS5yZXBvLCBjaGVja1N0YXRlKHN0YXRlKSkpO1xyXG4gICAgfSk7XHJcbiAgICBpcGNNYWluLmhhbmRsZSgnZm9yZ2U6aXNzdWVzJywgKGV2ZW50LCBoOiB1bmtub3duLCByZXBvOiB1bmtub3duLCBzdGF0ZTogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBhID0gcmVwb0FyZ3MoaCwgcmVwbyk7XHJcbiAgICAgIGlmICgnYmFkJyBpbiBhKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgb2s6IGZhbHNlLCBjb2RlOiAnQkFEX1JFUVVFU1QnLCBlcnJvcjogYS5iYWQgfSk7XHJcbiAgICAgIHJldHVybiBmb3JnZUVycihldmVudCwgKCkgPT4gZm9yZ2VTdmMoKS5pc3N1ZXMoYS5ob3N0LCBhLnJlcG8sIGNoZWNrU3RhdGUoc3RhdGUpKSk7XHJcbiAgICB9KTtcclxuICAgIGlwY01haW4uaGFuZGxlKCdmb3JnZTpyZWxlYXNlcycsIChldmVudCwgaDogdW5rbm93biwgcmVwbzogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBhID0gcmVwb0FyZ3MoaCwgcmVwbyk7XHJcbiAgICAgIGlmICgnYmFkJyBpbiBhKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgb2s6IGZhbHNlLCBjb2RlOiAnQkFEX1JFUVVFU1QnLCBlcnJvcjogYS5iYWQgfSk7XHJcbiAgICAgIHJldHVybiBmb3JnZUVycihldmVudCwgKCkgPT4gZm9yZ2VTdmMoKS5yZWxlYXNlcyhhLmhvc3QsIGEucmVwbykpO1xyXG4gICAgfSk7XHJcbiAgICBjb25zdCBBQ1RJT05fS0lORFM6IHJlYWRvbmx5IEZvcmdlQWN0aW9uS2luZFtdID0gWydwcl9jcmVhdGUnLCAncHJfbWVyZ2UnLCAnaXNzdWVfY3JlYXRlJywgJ3JlbGVhc2VfY3JlYXRlJywgJ3JlbGVhc2VfdXBsb2FkJywgJ3JlcG9fY2xvbmUnXTtcclxuICAgIGlwY01haW4uaGFuZGxlKCdmb3JnZTphY3Rpb24nLCAoZXZlbnQsIGs6IHVua25vd24sIGg6IHVua25vd24sIGFyZ3M6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3Qga2luZCA9IEFDVElPTl9LSU5EUy5maW5kKCh4KSA9PiB4ID09PSBrKTtcclxuICAgICAgY29uc3QgYSA9IHJlcG9BcmdzKGgsIChhcmdzIGFzIHsgcmVwbz86IHVua25vd24gfSB8IG51bGwgfCB1bmRlZmluZWQpPy5yZXBvKTtcclxuICAgICAgaWYgKGtpbmQgPT09IHVuZGVmaW5lZCB8fCAnYmFkJyBpbiBhKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgb2s6IGZhbHNlLCBjb2RlOiAnQkFEX1JFUVVFU1QnLCBlcnJvcjogJ2tpbmQvaG9zdC9yZXBvIFx1NjgyMVx1OUE4Q1x1NTkzMVx1OEQyNScgfSk7XHJcbiAgICAgIGNvbnN0IHJhdyA9IChhcmdzID8/IHt9KSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcclxuICAgICAgLy8gXHU5MDEwXHU1QjU3XHU2QkI1XHU4RkM3XHU3QzdCXHU1NzhCICsgXHU5NTdGXHU1RUE2XHU5NUU4O1x1NkRGMVx1NUVBNlx1OEJFRFx1NEU0OVx1NjgyMVx1OUE4Q1x1NTcyOCBmb3JnZS50cyBidWlsZEFjdGlvbkFyZ3MoXHU2MkZDXHU1NDdEXHU0RUU0XHU1MjREXHU2NzAwXHU1NDBFXHU5NjMyXHU3RUJGKVxyXG4gICAgICBjb25zdCBwYXMgPSAodjogdW5rbm93biwgbWF4OiBudW1iZXIpOiBzdHJpbmcgPT4gKHR5cGVvZiB2ID09PSAnc3RyaW5nJyA/IHYuc2xpY2UoMCwgbWF4KSA6ICcnKTtcclxuICAgICAgY29uc3QgZmEgPSB7XHJcbiAgICAgICAgcmVwbzogYS5yZXBvLFxyXG4gICAgICAgIG51bWJlcjogcGFzKHJhdy5udW1iZXIsIDIwKSwgdGl0bGU6IHBhcyhyYXcudGl0bGUsIDMwMCksIGJvZHk6IHBhcyhyYXcuYm9keSwgMjBfMDAwKSxcclxuICAgICAgICBiYXNlOiBwYXMocmF3LmJhc2UsIDIwMCksIGhlYWQ6IHBhcyhyYXcuaGVhZCwgMjAwKSwgdGFnOiBwYXMocmF3LnRhZywgMTIwKSxcclxuICAgICAgICBuYW1lOiBwYXMocmF3Lm5hbWUsIDMwMCksIG5vdGVzOiBwYXMocmF3Lm5vdGVzLCA2MF8wMDApLCBmaWxlOiBwYXMocmF3LmZpbGUsIDFfMDAwKSxcclxuICAgICAgICBkaXI6IHBhcyhyYXcuZGlyLCAxXzAwMCksIG1ldGhvZDogcGFzKHJhdy5tZXRob2QsIDEwKSxcclxuICAgICAgICBwcmVyZWxlYXNlOiByYXcucHJlcmVsZWFzZSA9PT0gdHJ1ZSxcclxuICAgICAgfTtcclxuICAgICAgcmV0dXJuIGZvcmdlRXJyKGV2ZW50LCAoKSA9PiBmb3JnZVN2YygpLmFjdGlvbihraW5kLCBhLmhvc3QsIGZhKSk7XHJcbiAgICB9KTtcclxuICAgIC8vIFx1OTAwM1x1NzUxRlx1NTNFMzpcdTRFQzVcdTUzQ0NcdTVFNzNcdTUzRjBcdTU3REZcdTU0MERcdTUzRUZcdTU5MTZcdTVGMDAocmVuZGVyZXIgXHU3OTgxIHdpbmRvdy5vcGVuO1VJVkVSSUZZIFx1NTNFQVx1NTZERSBvaylcclxuICAgIGlwY01haW4uaGFuZGxlKCdmb3JnZTpvcGVuJywgKGV2ZW50LCB1cmw6IHVua25vd24pID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgY29uc3QgdSA9IHR5cGVvZiB1cmwgPT09ICdzdHJpbmcnID8gdXJsLnNsaWNlKDAsIDJfMDAwKSA6ICcnO1xyXG4gICAgICBpZiAoIS9eaHR0cHM6XFwvXFwvKFthLXowLTktXStcXC4pKihnaXRodWJcXC5jb218YXRvbWdpdFxcLmNvbSlcXC8vLnRlc3QodSkpIHtcclxuICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIGNvZGU6ICdCQURfUkVRVUVTVCcsIGVycm9yOiAnXHU0RUM1IGdpdGh1Yi5jb20gLyBhdG9tZ2l0LmNvbSBcdTk0RkVcdTYzQTVcdTUzRUZcdTYyNTNcdTVGMDAnIH07XHJcbiAgICAgIH1cclxuICAgICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZID09PSAnMScgJiYgIWZvcmdlRml4dHVyZU9mZikgcmV0dXJuIHsgb2s6IHRydWUgfTtcclxuICAgICAgdm9pZCBzaGVsbC5vcGVuRXh0ZXJuYWwodSk7XHJcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlIH07XHJcbiAgICB9KTtcclxuICAgIGlwY01haW4uaGFuZGxlKCdmb3JnZTpyZXNvbHZlJywgKGV2ZW50LCBwOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWSA9PT0gJzEnICYmICFmb3JnZUZpeHR1cmVPZmYpIHJldHVybiBmb3JnZUZpeHR1cmVzKCkucmVzb2x2ZTtcclxuICAgICAgY29uc3QgcGF0aCA9IHR5cGVvZiBwID09PSAnc3RyaW5nJyA/IHAuc2xpY2UoMCwgMV8wMDApIDogJyc7XHJcbiAgICAgIHJldHVybiBmb3JnZVN2YygpLnJlc29sdmUocGF0aCk7XHJcbiAgICB9KTtcclxuICB9XHJcblxyXG4gIC8qIC0tLS0gXHU3QTk3XHU1M0UzXHU0RTBFXHU1Qjg5XHU1MTY4XHU3QjU2XHU3NTY1IC0tLS0gKi9cclxuICAvLyAwMyBcdTAwQTdcdTRFMDM6RGVza3RvcCBcdTY3MkNcdTU3MzBcdTUzRUFcdTVCNTggVUkgXHU1MDRGXHU1OTdEL1x1N0E5N1x1NTNFM1x1NzJCNlx1NjAwMSh1c2VyRGF0YS93aW5kb3ctc3RhdGUuanNvbilcclxuICBjb25zdCB3aW5kb3dTdGF0ZUZpbGUgPSAoKTogc3RyaW5nID0+IGpvaW4oYXBwLmdldFBhdGgoJ3VzZXJEYXRhJyksICd3aW5kb3ctc3RhdGUuanNvbicpO1xyXG4gIGFzeW5jIGZ1bmN0aW9uIGxvYWRCb3VuZHMoKTogUHJvbWlzZTx7IHdpZHRoOiBudW1iZXI7IGhlaWdodDogbnVtYmVyOyB4PzogbnVtYmVyOyB5PzogbnVtYmVyIH0gfCBudWxsPiB7XHJcbiAgICB0cnkge1xyXG4gICAgICByZXR1cm4gSlNPTi5wYXJzZShhd2FpdCByZWFkRmlsZSh3aW5kb3dTdGF0ZUZpbGUoKSwgJ3V0ZjgnKSkgYXMgeyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlcjsgeD86IG51bWJlcjsgeT86IG51bWJlciB9O1xyXG4gICAgfSBjYXRjaCB7IHJldHVybiBudWxsOyB9XHJcbiAgfVxyXG4gIGFzeW5jIGZ1bmN0aW9uIHNhdmVCb3VuZHMod2luOiBCcm93c2VyV2luZG93KTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICB0cnkgeyBhd2FpdCB3cml0ZUZpbGUod2luZG93U3RhdGVGaWxlKCksIEpTT04uc3RyaW5naWZ5KHdpbi5nZXRCb3VuZHMoKSksICd1dGY4Jyk7IH0gY2F0Y2ggeyAvKiBiZXN0IGVmZm9ydCAqLyB9XHJcbiAgfVxyXG5cclxuICBhc3luYyBmdW5jdGlvbiBjcmVhdGVXaW5kb3coKTogUHJvbWlzZTxCcm93c2VyV2luZG93IHwgbnVsbD4ge1xyXG4gICAgY29uc3Qgc2F2ZWQgPSBhd2FpdCBsb2FkQm91bmRzKCk7XHJcbiAgICBjb25zdCB3aW4gPSBuZXcgQnJvd3NlcldpbmRvdyh7XHJcbiAgICAgIHdpZHRoOiBzYXZlZD8ud2lkdGggPz8gMTQ0MCxcclxuICAgICAgaGVpZ2h0OiBzYXZlZD8uaGVpZ2h0ID8/IDkwMCxcclxuICAgICAgLi4uKHNhdmVkPy54ICE9PSB1bmRlZmluZWQgJiYgc2F2ZWQ/LnkgIT09IHVuZGVmaW5lZCA/IHsgeDogc2F2ZWQueCwgeTogc2F2ZWQueSB9IDoge30pLFxyXG4gICAgICAvLyBISUcgXHU5NjM2XHU2QkI1MigxMS1BKTpcdTdBODRcdTdBOTdcdTRFMEJcdTk2NTAgNTYwKDA0IFx1NTNGN1x1ODlDNFx1NjgzQztcdTUzOUYgOTYwIFx1NEY3RiBcdTIyNjQ4MjBweCBcdTYyQkRcdTVDNDlcdTY1QURcdTcwQjlcdTRFMERcdTUzRUZcdThGQkUpO1xyXG4gICAgICAvLyBVSVZFUklGWSBcdTdBODRcdTVDNEZcdTlBOENcdTY1MzYoMTEtQix3aXphcmQgMzYwXHUwMEQ3NjQwIFx1NTE2OFx1NTE0M1x1N0QyMFx1NTNFRlx1OEZCRSlcdTk3MDBcdTRFMzRcdTY1RjZcdTY1M0VcdTVCQkRcdTUyMzAgMzIwXHUwMEQ3MzYwXHUzMDAyXHJcbiAgICAgIG1pbldpZHRoOiBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWSA9PT0gJzEnID8gMzIwIDogNTYwLFxyXG4gICAgICBtaW5IZWlnaHQ6IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZID09PSAnMScgPyAzNjAgOiA2MDAsXHJcbiAgICAgIHNob3c6IGZhbHNlLFxyXG4gICAgICBiYWNrZ3JvdW5kQ29sb3I6ICcjZjlmYWZiJywgLy8gdjQgRFNIOlx1NkQ0NVx1ODI3Mlx1OUVEOFx1OEJBNChiZy1iYXNlKSxcdTkwN0ZcdTUxNERcdTZERjFcdTgyNzJcdTk1RUFcdTVDNEZcclxuICAgICAgdGl0bGU6ICdITUggRGVza3RvcCcsXHJcbiAgICAgIC8vIFx1OTY5MFx1ODVDRlx1NUYwRlx1NjgwN1x1OTg5OFx1NjgwRjpcdTUzOUZcdTc1MUZcdTdBOTdcdTUzRTNcdTYzQTdcdTUyMzYob3ZlcmxheSBcdTYzRDBcdTRGOUIpK1x1OTg5Q1x1ODI3Mlx1OTY4Rlx1NEUzQlx1OTg5OChyZW5kZXJlciBcdTdFQ0ZcclxuICAgICAgLy8gY2hyb21lLXRoZW1lIFx1NTQwQ1x1NkI2NSlcdTIwMTRcdTIwMTRcdTY4MzlcdTZDQkJcdTRFQUVcdTgyNzJcdTZBMjFcdTVGMEZcdTk4NzZcdTkwRThcdTlFRDFcdTY3NjE7XHU4M0RDXHU1MzU1XHU2ODBGIGF1dG9IaWRlKEFsdCBcdTU0N0NcdTUxRkEpXHUzMDAyXHJcbiAgICAgIHRpdGxlQmFyU3R5bGU6ICdoaWRkZW4nLFxyXG4gICAgICAvLyBISUcgXHU5NjM2XHU2QkI1MjozNlx1MjE5MjQ0LFx1NEUwRSByZW5kZXJlciAudGl0bGViYXIgXHU5QUQ4XHU1RUE2XHU0RTAwXHU4MUY0KFx1NEUwRFx1NEUwMFx1ODFGNFx1NEYxQVx1OTczMlx1NTFGQS9cdTkwNkVcdTRGNEYgOHB4KVxyXG4gICAgICB0aXRsZUJhck92ZXJsYXk6IHsgLi4uY2hyb21lRm9yKG5hdGl2ZVRoZW1lLnNob3VsZFVzZURhcmtDb2xvcnMpLCBoZWlnaHQ6IDQ0IH0sXHJcbiAgICAgIGF1dG9IaWRlTWVudUJhcjogdHJ1ZSxcclxuICAgICAgd2ViUHJlZmVyZW5jZXM6IHtcclxuICAgICAgICBwcmVsb2FkOiBwcmVsb2FkUGF0aCxcclxuICAgICAgICBjb250ZXh0SXNvbGF0aW9uOiB0cnVlLFxyXG4gICAgICAgIHNhbmRib3g6IHRydWUsXHJcbiAgICAgICAgbm9kZUludGVncmF0aW9uOiBmYWxzZSxcclxuICAgICAgICBub2RlSW50ZWdyYXRpb25JbldvcmtlcjogZmFsc2UsXHJcbiAgICAgICAgd2ViU2VjdXJpdHk6IHRydWUsXHJcbiAgICAgICAgc3BlbGxjaGVjazogZmFsc2UsXHJcbiAgICAgICAgZGV2VG9vbHM6IGlzRGV2LFxyXG4gICAgICB9LFxyXG4gICAgfSk7XHJcbiAgICB3aW4ub25jZSgncmVhZHktdG8tc2hvdycsICgpID0+IHdpbi5zaG93KCkpO1xyXG4gICAgd2luLm9uKCdjbG9zZScsICgpID0+IHsgdm9pZCBzYXZlQm91bmRzKHdpbik7IH0pO1xyXG5cclxuICAgIC8vIFx1NTNFQVx1NTE0MVx1OEJCOFx1NTJBMFx1OEY3RFx1NjIxMVx1NEVFQ1x1ODFFQVx1NURGMVx1NzY4NCByZW5kZXJlcjtcdTRFRkJcdTRGNTVcdTVCRkNcdTgyMkEvXHU2NUIwXHU3QTk3XHU1M0UzXHU0RTAwXHU1RjhCXHU2MkQyXHU3RUREXHJcbiAgICB3aW4ud2ViQ29udGVudHMuc2V0V2luZG93T3BlbkhhbmRsZXIoKHsgdXJsIH0pID0+IHtcclxuICAgICAgaWYgKC9eaHR0cHM/OlxcL1xcLy8udGVzdCh1cmwpKSB2b2lkIHNoZWxsLm9wZW5FeHRlcm5hbCh1cmwpO1xyXG4gICAgICByZXR1cm4geyBhY3Rpb246ICdkZW55JyB9O1xyXG4gICAgfSk7XHJcbiAgICB3aW4ud2ViQ29udGVudHMub24oJ3dpbGwtbmF2aWdhdGUnLCAoZSwgdXJsKSA9PiB7XHJcbiAgICAgIGNvbnN0IG9rID0gWy4uLmFsbG93ZWRPcmlnaW5zXS5zb21lKChvKSA9PiB1cmwgPT09IG8gfHwgdXJsLnN0YXJ0c1dpdGgoYCR7b30vYCkgfHwgdXJsLnN0YXJ0c1dpdGgoYCR7b30/YCkpO1xyXG4gICAgICBpZiAoIW9rKSB7XHJcbiAgICAgICAgbG9nSW5mbygnbmF2JywgYGJsb2NrZWQgbmF2aWdhdGlvbiB0byAke3VybC5zbGljZSgwLCAxMjApfWApO1xyXG4gICAgICAgIGUucHJldmVudERlZmF1bHQoKTtcclxuICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgaWYgKGlzRGV2ICYmIHJlbmRlcmVyRGV2VXJsKSB7XHJcbiAgICAgIHZvaWQgd2luLmxvYWRVUkwocmVuZGVyZXJEZXZVcmwpO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgdm9pZCB3aW4ubG9hZEZpbGUoam9pbihoZXJlLCAnLi4nLCAnLi4nLCAnZGlzdC1yZW5kZXJlcicsICdpbmRleC5odG1sJykpO1xyXG4gICAgfVxyXG4gICAgLy8gXHU5ODc1XHU5NzYyXHU1MkEwXHU4RjdEXHU1QjhDXHU5MUNEXHU2NEFEXHU1RjUzXHU1MjREIGhvc3QgXHU3MkI2XHU2MDAxOnJlYWR5IFx1NUU3Rlx1NjRBRFx1ODJFNVx1NjVFOVx1NEU4RSByZW5kZXJlciBcdThCQTJcdTk2MDVcdTUzNzNcdTRFMjJcdTU5MzEsXHJcbiAgICAvLyByZW5kZXJlciBcdTc2ODQgZ2V0LXN0YXRlIFx1NUZFQlx1NzE2NyArIFx1OEZEOVx1OTFDQ1x1NzY4NFx1OTFDRFx1NjRBRFx1NTNDQ1x1NEZERFx1OTY2OShcdTU5MUFcdTdBOTdcdTUzRTMvXHU5MUNEXHU4RjdEXHU1NzNBXHU2NjZGXHU0RTVGXHU4OTg2XHU3NkQ2KVx1MzAwMlxyXG4gICAgd2luLndlYkNvbnRlbnRzLm9uY2UoJ2RpZC1maW5pc2gtbG9hZCcsICgpID0+IHtcclxuICAgICAgaWYgKCF3aW4uaXNEZXN0cm95ZWQoKSkge1xyXG4gICAgICAgIHdpbi53ZWJDb250ZW50cy5zZW5kKCdicmlkZ2U6aG9zdC1zdGF0ZScsIGJyaWRnZS5ob3N0U3RhdGUsIHsgcmVzdGFydENvdW50OiAwIH0pO1xyXG4gICAgICB9XHJcbiAgICB9KTtcclxuICAgIHJldHVybiB3aW47XHJcbiAgfVxyXG5cclxuICBhcHAud2hlblJlYWR5KCkudGhlbigoKSA9PiB7XHJcbiAgICAvLyBVSVZFUklGWTpmYWtlIFx1NkEyMVx1NUYwRlx1OUE4Q1x1NjUzNlx1OTg3Qlx1NTcyOCBzdGFydEhvc3QgXHU4QkZCIGVudiBcdTRFNEJcdTUyNERcdTVGM0FcdTUyMzYgZmFrZTtWSVNSRUcoXHU4OUM2XHU4OUM5XHU1NkRFXHU1RjUyKVx1NTQwQ1x1ODlDNFx1NTIxOVxyXG4gICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1ZJU1JFRyA9PT0gJzEnIHx8IChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWSA9PT0gJzEnICYmIHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX01PREUgIT09ICdyZWFsJykpIHtcclxuICAgICAgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfRkFLRSA9ICcxJztcclxuICAgIH1cclxuICAgIC8vIFdpbmRvd3MgXHU5MDFBXHU3N0U1XHU1RjUyXHU1QzVFKFx1NTQyNlx1NTIxOVx1NjYzRVx1NzkzQVx1NEUzQSBlbGVjdHJvbi5leGUpXHJcbiAgICBhcHAuc2V0QXBwVXNlck1vZGVsSWQoJ2Rldi5obWguZGVza3RvcCcpO1xyXG4gICAgc2V0dXBUcmF5KCk7XHJcbiAgICBidWlsZEFwcE1lbnUoKTtcclxuICAgIC8vIFx1NTQyRlx1NTJBOCAzMHMgXHU1NDBFXHU5NzU5XHU5RUQ4XHU2OEMwXHU2N0U1XHU2NkY0XHU2NUIwKFx1NjcwOVx1NjVCMFx1NzI0OFx1NEVDNVx1NTQwRVx1NTNGMFx1NEUwQlx1OEY3RCxcdTRFMERcdTYyNTNcdTYyNzA7XHU1OTMxXHU4RDI1XHU5NzU5XHU5RUQ4LFx1NEUwQlx1NkIyMVx1NTQyRlx1NTJBOFx1NTE4RFx1OEJENSlcdTMwMDJcclxuICAgIC8vIGRldiBcdTRFNUZcdTY4QzBcdTY3RTU6XHU4ODRDXHU0RTNBXHU0RTBFXHU2MjUzXHU1MzA1XHU3MjQ4XHU0RTAwXHU4MUY0LFx1NEUxNCBGT1JDRV9UQUcgXHU2NUNCXHU5NEFFXHU0RTBCIGRldiBcdTUzNzNcdTUzRUZcdTUxNjhcdTZENDFcdTdBMEJcdTlBOENcdTY1MzZcdTMwMDJcclxuICAgIHNldFRpbWVvdXQoKCkgPT4geyB2b2lkIGNoZWNrRm9yVXBkYXRlcygpOyB9LCAzMF8wMDApO1xyXG4gICAgLy8gQ1NQKGRldiBcdTRFMEUgcHJvZCBcdTRFMERcdTU0MEM7cHJvZCBcdTRFMERcdTUxNDFcdThCQjhcdTRFRkJcdTRGNTVcdThGRENcdTdBMEJcdTZFOTApXHJcbiAgICBjb25zdCBjc3AgPSBpc0RldlxyXG4gICAgICA/IFtcclxuICAgICAgICAgIFwiZGVmYXVsdC1zcmMgJ3NlbGYnXCIsXHJcbiAgICAgICAgICBgc2NyaXB0LXNyYyAnc2VsZicgJHtyZW5kZXJlckRldlVybH1gLFxyXG4gICAgICAgICAgXCJzdHlsZS1zcmMgJ3NlbGYnICd1bnNhZmUtaW5saW5lJ1wiLFxyXG4gICAgICAgICAgYGNvbm5lY3Qtc3JjICdzZWxmJyAke3JlbmRlcmVyRGV2VXJsfSB3czovLzEyNy4wLjAuMToqYCxcclxuICAgICAgICAgIFwiaW1nLXNyYyAnc2VsZicgZGF0YTpcIixcclxuICAgICAgICAgIFwiZm9udC1zcmMgJ3NlbGYnIGRhdGE6XCIsXHJcbiAgICAgICAgXS5qb2luKCc7ICcpXHJcbiAgICAgIDogXCJkZWZhdWx0LXNyYyAnc2VsZic7IHNjcmlwdC1zcmMgJ3NlbGYnOyBzdHlsZS1zcmMgJ3NlbGYnICd1bnNhZmUtaW5saW5lJzsgaW1nLXNyYyAnc2VsZicgZGF0YTo7IGZvbnQtc3JjICdzZWxmJyBkYXRhOlwiO1xyXG4gICAgc2Vzc2lvbi5kZWZhdWx0U2Vzc2lvbi53ZWJSZXF1ZXN0Lm9uSGVhZGVyc1JlY2VpdmVkKChkZXRhaWxzLCBjYWxsYmFjaykgPT4ge1xyXG4gICAgICBjYWxsYmFjayh7XHJcbiAgICAgICAgcmVzcG9uc2VIZWFkZXJzOiB7XHJcbiAgICAgICAgICAuLi5kZXRhaWxzLnJlc3BvbnNlSGVhZGVycyxcclxuICAgICAgICAgICdDb250ZW50LVNlY3VyaXR5LVBvbGljeSc6IFtjc3BdLFxyXG4gICAgICAgIH0sXHJcbiAgICAgIH0pO1xyXG4gICAgfSk7XHJcblxyXG4gICAgcmVnaXN0ZXJJcGMoKTtcclxuICAgIC8vIGNyZWF0ZVdpbmRvdyBcdTY2MkYgYXN5bmMoYm91bmRzIFx1NjA2Mlx1NTkwRCk7XHU1Qjg5XHU1MTY4XHU4MUVBXHU2RDRCL1x1NkUzMlx1NjdEM1x1ODFFQVx1NjhDMFx1NTcyOFx1N0E5N1x1NTNFM1x1NUMzMVx1N0VFQVx1NTQwRVx1NjMwMlx1OEY3RFxyXG4gICAgdm9pZCBjcmVhdGVXaW5kb3coKS50aGVuKCh3aW4pID0+IHtcclxuICAgICAgaWYgKHdpbiA9PT0gbnVsbCkgcmV0dXJuO1xyXG4gICAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRlkgPT09ICcxJykgYXR0YWNoVWlWZXJpZnkod2luKTtcclxuICAgICAgLy8gXHU4OUM2XHU4OUM5XHU1NkRFXHU1RjUyXHU2MjJBXHU1NkZFXHU5NEE5XHU1QjUwOkhNSF9ERVNLVE9QX1ZJU1JFRz0xLFx1Nzg2RVx1NUI5QVx1NjAyN1x1ODlDNlx1NTNFM1x1NjIyQVx1NTZGRVx1NTQwRVx1OTAwMFx1NTFGQShzY3JpcHRzL3Zpc3VhbC1yZWdyZXNzaW9uLm1qcyBcdTlBNzFcdTUyQTgpXHJcbiAgICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9WSVNSRUcgPT09ICcxJykgYXR0YWNoVmlzdWFsUmVncmVzc2lvbih3aW4pO1xyXG4gICAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfU0VDVVJJVFlfVEVTVCA9PT0gJzEnKSB7XHJcbiAgICAgICAgd2luLndlYkNvbnRlbnRzLm9uY2UoJ2RpZC1maW5pc2gtbG9hZCcsICgpID0+IHtcclxuICAgICAgICAgIHZvaWQgc2VjdXJpdHlTZWxmVGVzdCh3aW4pO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICB9XHJcbiAgICAgIC8vIFVJIFx1NjIyQVx1NTZGRVx1OTRBOVx1NUI1MDpITUhfREVTS1RPUF9TTkFQU0hPVD08ZmlsZS5wbmc+IFx1NTcyOFx1NzU0Q1x1OTc2Mlx1NUMzMVx1N0VFQVx1NTQwRVx1NjIyQVx1NTZGRVx1OTAwMFx1NTFGQVxyXG4gICAgICAvLyAoXHU4OEM1XHU2NzNBXHU4QkNBXHU2NUFEXHU3NTI4Olx1NEVCMlx1NzczQ1x1NzcwQlx1NkUzMlx1NjdEM1x1N0VEM1x1Njc5QyxcdTgwMENcdTRFMERcdTY2MkZcdTUzRUFcdTY1NzAgcm9vdCBcdTVCNTBcdTgyODJcdTcwQjkpXHUzMDAyXHJcbiAgICAgIGNvbnN0IHNuYXAgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9TTkFQU0hPVDtcclxuICAgICAgaWYgKHNuYXAgIT09IHVuZGVmaW5lZCAmJiBzbmFwICE9PSAnJykge1xyXG4gICAgICAgIHdpbi53ZWJDb250ZW50cy5vbmNlKCdkaWQtZmluaXNoLWxvYWQnLCAoKSA9PiB7XHJcbiAgICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHtcclxuICAgICAgICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBpbWcgPSBhd2FpdCB3aW4ud2ViQ29udGVudHMuY2FwdHVyZVBhZ2UoKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHsgd3JpdGVGaWxlOiB3ZiB9ID0gYXdhaXQgaW1wb3J0KCdub2RlOmZzL3Byb21pc2VzJyk7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCB3ZihzbmFwLCBpbWcudG9QTkcoKSk7XHJcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgU05BUFNIT1Qgb2sgJHtzbmFwfSAke2ltZy5nZXRTaXplKCkud2lkdGh9eCR7aW1nLmdldFNpemUoKS5oZWlnaHR9YCk7XHJcbiAgICAgICAgICAgICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgU05BUFNIT1QgZXJyb3IgJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApfWApO1xyXG4gICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICBjb25zdCBhcHAyID0gYXBwO1xyXG4gICAgICAgICAgICAgIHNldFRpbWVvdXQoKCkgPT4gYXBwMi5leGl0KDApLCA1MDApO1xyXG4gICAgICAgICAgICB9KSgpO1xyXG4gICAgICAgICAgfSwgTnVtYmVyKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NOQVBTSE9UX0RFTEFZX01TID8/IDEyXzAwMCkpO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICB9XHJcbiAgICAgIC8vIERPTSBcdTdFRDNcdTY3ODRcdTYzQTJcdTk0ODg6SE1IX0RFU0tUT1BfRE9NUFJPQkU9MSBcdThGOTNcdTUxRkFcdTUxNzNcdTk1MkVcdTUxNDNcdTdEMjBcdTc2ODQgYm94L2Rpc3BsYXkvY2hpbGRyZW4sXHJcbiAgICAgIC8vIFx1NTE4RFx1OTAwMFx1NTFGQShcdThCQ0FcdTY1QURcIlJlYWN0IFx1NjMwMlx1OEY3RFx1NEU4Nlx1NEY0Nlx1NjdEMFx1NTc1NyBVSSBcdTRFMERcdTUzRUZcdTg5QzFcIlx1OEZEOVx1N0M3Qlx1OTVFRVx1OTg5ODtcdTYyMkFcdTU2RkVcdTRFNEJcdTU5MTZcdTc2ODRcdTc4NkNcdThCQzFcdTYzNkUpXHUzMDAyXHJcbiAgICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9ET01QUk9CRSA9PT0gJzEnKSB7XHJcbiAgICAgICAgd2luLndlYkNvbnRlbnRzLm9uY2UoJ2RpZC1maW5pc2gtbG9hZCcsICgpID0+IHtcclxuICAgICAgICAgIHNldFRpbWVvdXQoKCkgPT4ge1xyXG4gICAgICAgICAgICB2b2lkIChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHIgPSAoYXdhaXQgd2luLndlYkNvbnRlbnRzLmV4ZWN1dGVKYXZhU2NyaXB0KGAoZnVuY3Rpb24oKXtcclxuICAgICAgICAgICAgICAgICAgdmFyIHBpY2sgPSBmdW5jdGlvbihzZWwpe1xyXG4gICAgICAgICAgICAgICAgICAgIHZhciBlbHMgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKHNlbCk7XHJcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGVscywgMCwgNCkubWFwKGZ1bmN0aW9uKGVsKXtcclxuICAgICAgICAgICAgICAgICAgICAgIHZhciBjcyA9IGdldENvbXB1dGVkU3R5bGUoZWwpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgdmFyIGIgPSBlbC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcclxuICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB7IGNsczogKGVsLmNsYXNzTmFtZXx8JycpLnRvU3RyaW5nKCkuc2xpY2UoMCw4MCksIHRhZzogZWwudGFnTmFtZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgZGlzcGxheTogY3MuZGlzcGxheSwgdmlzOiBjcy52aXNpYmlsaXR5LCBvcGFjaXR5OiBjcy5vcGFjaXR5LFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBwb3M6IGNzLnBvc2l0aW9uLCB6OiBjcy56SW5kZXgsIG92ZXJmbG93OiBjcy5vdmVyZmxvdyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgeDogTWF0aC5yb3VuZChiLngpLCB5OiBNYXRoLnJvdW5kKGIueSksIHc6IE1hdGgucm91bmQoYi53aWR0aCksIGg6IE1hdGgucm91bmQoYi5oZWlnaHQpLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB0ZXh0OiAoZWwuaW5uZXJUZXh0fHwnJykucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDYwKSB9O1xyXG4gICAgICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgICB9O1xyXG4gICAgICAgICAgICAgICAgICB2YXIgc2VscyA9IFsnaHRtbCcsJ2JvZHknLCcjcm9vdCcsJy5hcHAtc2hlbGwnLCcuc2lkZWJhcicsJy53b3Jrc3BhY2UnLCcudG9wYmFyJywnLnN0cmVhbScsJy5lbXB0eS1oaW50JywnLmNvbXBvc2VyJywnLmNvbXBvc2VyLXJvdycsJy5jb21wb3NlciB0ZXh0YXJlYScsJy5jb21wb3Nlci1zaWRlJywnLmF0dC1waWNrZXInLCcuYXR0LWNoaXBzJywnLnNpZGVwYW5lbCcsJy5ydW50aW1lLWd1aWRlJywnLm92ZXJsYXknLCcudHVybicsJy5jYXJkJ107XHJcbiAgICAgICAgICAgICAgICAgIHZhciBvdXQgPSB7fTtcclxuICAgICAgICAgICAgICAgICAgc2Vscy5mb3JFYWNoKGZ1bmN0aW9uKHMpeyB0cnkgeyBvdXRbc10gPSBwaWNrKHMpOyB9IGNhdGNoKGUpeyBvdXRbc10gPSBbe2VycjogU3RyaW5nKGUpLnNsaWNlKDAsODApfV07IH0gfSk7XHJcbiAgICAgICAgICAgICAgICAgIG91dC5fX21ldGEgPSB7XHJcbiAgICAgICAgICAgICAgICAgICAgc3R5bGVTaGVldHM6IGRvY3VtZW50LnN0eWxlU2hlZXRzLmxlbmd0aCxcclxuICAgICAgICAgICAgICAgICAgICBzaGVldDBydWxlczogKGRvY3VtZW50LnN0eWxlU2hlZXRzWzBdICYmIGRvY3VtZW50LnN0eWxlU2hlZXRzWzBdLmNzc1J1bGVzKSA/IGRvY3VtZW50LnN0eWxlU2hlZXRzWzBdLmNzc1J1bGVzLmxlbmd0aCA6IC0xLFxyXG4gICAgICAgICAgICAgICAgICAgIHJvb3RDaGlsZHJlbjogZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Jvb3QnKSA/IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyb290JykuY2hpbGRyZW4ubGVuZ3RoIDogLTEsXHJcbiAgICAgICAgICAgICAgICAgICAgYm9keUNoaWxkcmVuOiBkb2N1bWVudC5ib2R5LmNoaWxkcmVuLmxlbmd0aCxcclxuICAgICAgICAgICAgICAgICAgICBpbm5lckhUTUxMZW46IGRvY3VtZW50LmJvZHkuaW5uZXJIVE1MLmxlbmd0aCxcclxuICAgICAgICAgICAgICAgICAgICB2aWV3cG9ydDogd2luZG93LmlubmVyV2lkdGggKyAneCcgKyB3aW5kb3cuaW5uZXJIZWlnaHRcclxuICAgICAgICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KG91dCk7XHJcbiAgICAgICAgICAgICAgICB9KSgpYCwgdHJ1ZSkpIGFzIHN0cmluZztcclxuICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBET01QUk9CRSAke3J9YCk7XHJcbiAgICAgICAgICAgICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgRE9NUFJPQkUgZXJyb3IgJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAyMDApfWApO1xyXG4gICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICBhcHAuZXhpdCgwKTtcclxuICAgICAgICAgICAgfSkoKTtcclxuICAgICAgICAgIH0sIE51bWJlcihwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9ET01QUk9CRV9ERUxBWV9NUyA/PyA5XzAwMCkpO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICB9XHJcbiAgICAgIC8vIFx1NkUzMlx1NjdEM1x1ODFFQVx1NjhDMCgyMDI2LTEwLTEwIFx1ODhDNVx1NjczQVx1OUVEMVx1NUM0Rlx1NjU1OVx1OEJBRDpicmlkZ2UgcmVhZHkgXHUyMjYwIFx1NzU0Q1x1OTc2Mlx1NkUzMlx1NjdEM1x1NEU4NilcdTMwMDJcclxuICAgICAgLy8gI3Jvb3QgXHU1NzI4IFJlYWN0IFx1NjMwMlx1OEY3RFx1NTQwRVx1NUZDNVx1NjcwOVx1NUI1MFx1ODI4Mlx1NzBCOTtcdTdBN0EgPSBcdThENDRcdTZFOTBcdThERUZcdTVGODQvQ1NQL1x1ODExQVx1NjcyQ1x1NTJBMFx1OEY3RFx1NTc0Rlx1NEU4Nlx1MzAwMlxyXG4gICAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfUkVOREVSX1RFU1QgPT09ICcxJykge1xyXG4gICAgICAgIHdpbi53ZWJDb250ZW50cy5vbmNlKCdkaWQtZmluaXNoLWxvYWQnLCAoKSA9PiB7XHJcbiAgICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHtcclxuICAgICAgICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBuID0gKGF3YWl0IHdpbi53ZWJDb250ZW50cy5leGVjdXRlSmF2YVNjcmlwdChcclxuICAgICAgICAgICAgICAgICAgJ2RvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwicm9vdFwiKSA/IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwicm9vdFwiKS5jaGlsZHJlbi5sZW5ndGggOiAtMScsIHRydWUsXHJcbiAgICAgICAgICAgICAgICApKSBhcyBudW1iZXI7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBvayA9IG4gPiAwO1xyXG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYFJFTkRFUi1URVNUICR7b2sgPyAnb2snIDogJ0VNUFRZJ30gcm9vdENoaWxkcmVuPSR7bn1gKTtcclxuICAgICAgICAgICAgICAgIGFwcC5leGl0KG9rID8gMCA6IDEpO1xyXG4gICAgICAgICAgICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYFJFTkRFUi1URVNUIEVSUk9SICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTIwKX1gKTtcclxuICAgICAgICAgICAgICAgIGFwcC5leGl0KDEpO1xyXG4gICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfSkoKTtcclxuICAgICAgICAgIH0sIDJfNTAwKTtcclxuICAgICAgICB9KTtcclxuICAgICAgfVxyXG4gICAgfSk7XHJcbiAgICB2b2lkIHN0YXJ0SG9zdCgpO1xyXG5cclxuICAgIGFwcC5vbignYWN0aXZhdGUnLCAoKSA9PiB7XHJcbiAgICAgIGlmIChCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5sZW5ndGggPT09IDApIHZvaWQgY3JlYXRlV2luZG93KCk7XHJcbiAgICB9KTtcclxuICB9KTtcclxuXHJcbiAgYXN5bmMgZnVuY3Rpb24gc2VjdXJpdHlTZWxmVGVzdCh3aW46IEJyb3dzZXJXaW5kb3cpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IHJlc3VsdHM6IEFycmF5PFtzdHJpbmcsIGJvb2xlYW4sIHN0cmluZ10+ID0gW107XHJcbiAgICBjb25zdCBjaGVjayA9IGFzeW5jIChuYW1lOiBzdHJpbmcsIHByb2JlOiAoKSA9PiBQcm9taXNlPFtib29sZWFuLCBzdHJpbmddPik6IFByb21pc2U8dm9pZD4gPT4ge1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IFtvaywgZGV0YWlsXSA9IGF3YWl0IHByb2JlKCk7XHJcbiAgICAgICAgcmVzdWx0cy5wdXNoKFtuYW1lLCBvaywgZGV0YWlsXSk7XHJcbiAgICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICAgIHJlc3VsdHMucHVzaChbbmFtZSwgZmFsc2UsIFN0cmluZyhlcnIpLnNsaWNlKDAsIDEyMCldKTtcclxuICAgICAgfVxyXG4gICAgfTtcclxuICAgIGNvbnN0IGpzID0gKGNvZGU6IHN0cmluZyk6IFByb21pc2U8dW5rbm93bj4gPT4gd2luLndlYkNvbnRlbnRzLmV4ZWN1dGVKYXZhU2NyaXB0KGNvZGUsIHRydWUpO1xyXG5cclxuICAgIGF3YWl0IGNoZWNrKCdyZW5kZXJlciBcdTY1RTBcdTUzRUZcdTc1MjhcdTc2ODQgcHJvY2Vzcy9yZXF1aXJlKHNhbmRib3ggXHU3NTFGXHU2NTQ4KScsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgciA9IChhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XHJcbiAgICAgICAgdmFyIHQgPSBmdW5jdGlvbihmKXsgdHJ5IHsgdmFyIHYgPSBmKCk7IHJldHVybiAodiA9PT0gdW5kZWZpbmVkIHx8IHYgPT09IG51bGwpID8gJ3VuYXZhaWxhYmxlJyA6IHR5cGVvZiB2OyB9IGNhdGNoKGUpeyByZXR1cm4gJ2Jsb2NrZWQnOyB9IH07XHJcbiAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KFt0KGZ1bmN0aW9uKCl7cmV0dXJuIHByb2Nlc3N9KSwgdChmdW5jdGlvbigpe3JldHVybiByZXF1aXJlfSksIHQoZnVuY3Rpb24oKXtyZXR1cm4gZ2xvYmFsVGhpcy5wcm9jZXNzfSldKTtcclxuICAgICAgfSkoKWApKSBhcyBzdHJpbmc7XHJcbiAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocikgYXMgc3RyaW5nW107XHJcbiAgICAgIGNvbnN0IHAgPSBwYXJzZWRbMF0gPz8gJ3Vua25vd24nO1xyXG4gICAgICBjb25zdCByZXEgPSBwYXJzZWRbMV0gPz8gJ3Vua25vd24nO1xyXG4gICAgICBjb25zdCBzYWZlID0gKHY6IHN0cmluZyk6IGJvb2xlYW4gPT4gdiA9PT0gJ3VuYXZhaWxhYmxlJyB8fCB2ID09PSAnYmxvY2tlZCc7XHJcbiAgICAgIHJldHVybiBbc2FmZShwKSAmJiBzYWZlKHJlcSksIGBwcm9jZXNzPSR7cH0gcmVxdWlyZT0ke3JlcX1gXTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgY2hlY2soJ3dpbmRvdy5obWggXHU1M0VBXHU2NzA5XHU3NjdEXHU1NDBEXHU1MzU1XHU2NUI5XHU2Q0Q1KFx1NjVFMCBpcGNSZW5kZXJlci9cdTk4OURcdTU5MTZcdTk3NjIpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKCdPYmplY3Qua2V5cyh3aW5kb3cuaG1oIHx8IHt9KS5zb3J0KCkuam9pbihcIixcIiknKSkgYXMgc3RyaW5nO1xyXG4gICAgICBjb25zdCBhbGxvdyA9IFsnYXBwbHlVcGRhdGUnLCAnYXBwcm92ZScsICdhcHByb3ZhbEdldCcsICdhcHByb3ZhbFNldCcsICdicm93c2VSdW50aW1lJywgJ2NoZWNrVXBkYXRlJywgJ2Nocm9tZVRoZW1lJywgJ2NvZ25pdGl2ZScsICdkZXRlY3RSdW50aW1lJywgJ2RpZmYnLCAnZXhwb3J0U2Vzc2lvbicsICdmb3JnZUFjdGlvbicsICdmb3JnZUlzc3VlcycsICdmb3JnZUxvZ2luJywgJ2ZvcmdlT3BlbicsICdmb3JnZVBycycsICdmb3JnZVJlbGVhc2VzJywgJ2ZvcmdlUmVwb3MnLCAnZm9yZ2VSZXNvbHZlJywgJ2ZvcmdlU3RhdHVzJywgJ2ZzTGlzdCcsICdmc1JlYWQnLCAnZnNTZWFyY2gnLCAnZ2V0U3RhdGUnLCAnZ2V0V2l6YXJkJywgJ2luamVjdCcsICdpbnN0YWxsQ2xpJywgJ2ludGVycnVwdCcsICdtb2RlbFNldCcsICdvbkV2ZW50QmF0Y2hlcycsICdvbkZvcmdlTG9naW5PdXRwdXQnLCAnb25Ib3N0U3RhdGUnLCAnb25JbnN0YWxsUHJvZ3Jlc3MnLCAnb25NZW51QWN0aW9uJywgJ29uU3RyZWFtQ2h1bmtzJywgJ29uVXBkYXRlU3RhdGUnLCAncGlja0RpcmVjdG9yeScsICdwaWNrRmlsZXMnLCAncG9wdXBNYWluTWVudScsICdwcm92aWRlclNhdmUnLCAncHJvdmlkZXJzJywgJ3JlbW90ZVdlYkF1dG9zdGFydCcsICdyZW1vdGVXZWJTdGFydCcsICdyZW1vdGVXZWJTdGF0dXMnLCAncmVtb3RlV2ViU3RvcCcsICdydW50aW1lSW5mbycsICdzZW5kVGFzaycsICdzZXNzaW9uT3AnLCAnc2Vzc2lvblByZXZpZXcnLCAnc2Vzc2lvbnMnLCAnc2V0UnVudGltZScsICdzdG9wSG9zdCcsICd3aXphcmRDb21wbGV0ZScsICd3b3Jrc3BhY2VzJywgJ3dvcmtzcGFjZUFkZCcsICd3b3Jrc3BhY2VVc2UnXTtcclxuICAgICAgY29uc3QgZ290ID0gciA9PT0gJycgPyBbXSA6IHIuc3BsaXQoJywnKTtcclxuICAgICAgY29uc3QgdW5leHBlY3RlZCA9IGdvdC5maWx0ZXIoKGspID0+ICFhbGxvdy5pbmNsdWRlcyhrKSk7XHJcbiAgICAgIHJldHVybiBbdW5leHBlY3RlZC5sZW5ndGggPT09IDAsIGBrZXlzPSR7cn1gXTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgY2hlY2soJ1x1NTkxNlx1OTBFOFx1NUJGQ1x1ODIyQVx1ODhBQlx1NjJFNlx1NjIyQShVUkwgXHU0RTBEXHU1M0Q4KScsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgYmVmb3JlID0gd2luLndlYkNvbnRlbnRzLmdldFVSTCgpO1xyXG4gICAgICBhd2FpdCBqcygnbG9jYXRpb24uaHJlZiA9IFwiaHR0cHM6Ly9leGFtcGxlLmludmFsaWQveFwiOyBcIm5vb3BcIicpLmNhdGNoKCgpID0+ICdub29wJyk7XHJcbiAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyMikgPT4gc2V0VGltZW91dChyMiwgMV8yMDApKTtcclxuICAgICAgY29uc3QgYWZ0ZXIgPSB3aW4ud2ViQ29udGVudHMuZ2V0VVJMKCk7XHJcbiAgICAgIHJldHVybiBbYWZ0ZXIgPT09IGJlZm9yZSwgYCR7YmVmb3JlfSBcdTIxOTIgJHthZnRlcn1gXTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgY2hlY2soJ3dpbmRvdy5vcGVuIFx1ODhBQlx1NjJEMlx1N0VERChcdThGRDRcdTU2REUgbnVsbCBcdTRFMTRcdTY1RTBcdTY1QjBcdTdBOTdcdTUzRTMpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCBiZWZvcmUgPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5sZW5ndGg7XHJcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoJ1N0cmluZyh3aW5kb3cub3BlbihcImh0dHBzOi8vZXhhbXBsZS5pbnZhbGlkXCIpKScpKSBhcyBzdHJpbmc7XHJcbiAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyMikgPT4gc2V0VGltZW91dChyMiwgNDAwKSk7XHJcbiAgICAgIGNvbnN0IGFmdGVyID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkubGVuZ3RoO1xyXG4gICAgICByZXR1cm4gW3IgPT09ICdudWxsJyAmJiBhZnRlciA9PT0gYmVmb3JlLCBgb3BlbigpPSR7cn0gd2luZG93cz0ke2JlZm9yZX1cdTIxOTIke2FmdGVyfWBdO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBjaGVjaygnQ1NQIFx1NUI1OFx1NTcyOChtZXRhIFx1NkNFOFx1NTE2NVx1NjIxNlx1NTRDRFx1NUU5NFx1NTkzNCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IG1ldGEgPSAoYXdhaXQganMoJ0Jvb2xlYW4oZG9jdW1lbnQucXVlcnlTZWxlY3RvcihcIm1ldGFbaHR0cC1lcXVpdj1cXCdDb250ZW50LVNlY3VyaXR5LVBvbGljeVxcJ11cIikpJykpIGFzIGJvb2xlYW47XHJcbiAgICAgIGNvbnN0IGhlYWRlckNzcCA9IGlzRGV2ID8gJ2RldjogaGVhZGVyIENTUCBcdTc1MzEgb25IZWFkZXJzUmVjZWl2ZWQgXHU2Q0U4XHU1MTY1KFx1NEUwRFx1OTAwMlx1NzUyOCBtZXRhIFx1NjVBRFx1OEEwMCknIDogJ3Byb2QnO1xyXG4gICAgICByZXR1cm4gW21ldGEgfHwgaXNEZXYsIGBtZXRhPSR7bWV0YX0gJHtoZWFkZXJDc3B9YF07XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IGNoZWNrKCdicmlkZ2U6Z2V0LXN0YXRlIFx1NkI2M1x1NUUzOFx1OEZENFx1NTZERShob3N0IFx1Njg2NVx1NTNFRlx1NzUyOCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoJ3dpbmRvdy5obWguZ2V0U3RhdGUoKS50aGVuKHMgPT4gSlNPTi5zdHJpbmdpZnkocykpLmNhdGNoKGUgPT4gXCJFUlI6XCIrZSknKSkgYXMgc3RyaW5nO1xyXG4gICAgICByZXR1cm4gW3Iuc3RhcnRzV2l0aCgneycpICYmIHIuaW5jbHVkZXMoJ2hvc3RTdGF0ZScpLCByLnNsaWNlKDAsIDgwKV07XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IGNoZWNrKCdYU1M6XHU2MDc2XHU2MTBGXHU0RUZCXHU1MkExXHU2NTg3XHU2NzJDXHU1M0VBXHU0RUU1XHU2NTg3XHU2NzJDXHU2RTMyXHU2N0QzKFx1NEUwRFx1NjI2N1x1ODg0QyknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHBheWxvYWQgPSAnPGltZyBzcmM9eCBvbmVycm9yPVwid2luZG93Ll9feHNzPTFcIj48c2NyaXB0PndpbmRvdy5fX3hzcz0yPFxcL3NjcmlwdD5cIiZcXCcnO1xyXG4gICAgICBjb25zdCBzZW5kUiA9IChhd2FpdCBqcyhgd2luZG93LmhtaC5zZW5kVGFzaygke0pTT04uc3RyaW5naWZ5KHBheWxvYWQpfSwgJ3NlYy14c3MtMScsICdhdXRvJykudGhlbihyPT5KU09OLnN0cmluZ2lmeShyKSkuY2F0Y2goZT0+J0VSUjonK2UpYCkpIGFzIHN0cmluZztcclxuICAgICAgaWYgKCFzZW5kUi5pbmNsdWRlcygnXCJva1wiOnRydWUnKSkgcmV0dXJuIFtmYWxzZSwgYHNlbmRUYXNrIFx1NjcyQVx1NTNEN1x1NzQwNjogJHtzZW5kUi5zbGljZSgwLCA4MCl9YF07XHJcbiAgICAgIC8vIGZha2UgaG9zdCBlY2hvIFx1NTZERVx1Njc2NVx1NTQwRVx1N0VDRiBSZWFjdCBcdTZFMzJcdTY3RDMoXHU3NTI4XHU2MjM3XHU2RDg4XHU2MDZGICsgXHU1MkE5XHU2MjRCIGVjaG8gXHU1M0NDXHU4REVGXHU1Rjg0KVxyXG4gICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocjIpID0+IHNldFRpbWVvdXQocjIsIDNfMDAwKSk7XHJcbiAgICAgIGNvbnN0IHByb2JlID0gKGF3YWl0IGpzKGBKU09OLnN0cmluZ2lmeSh7XHJcbiAgICAgICAgeHNzRmxhZzogdHlwZW9mIHdpbmRvdy5fX3hzcyxcclxuICAgICAgICBpbWdDb3VudDogZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnaW1nW3NyYz1cInhcIl0nKS5sZW5ndGgsXHJcbiAgICAgICAgc2NyaXB0UmFuOiBkb2N1bWVudC5ib2R5LmlubmVyVGV4dC5pbmRleE9mKCd3aW5kb3cuX194c3M9MicpID49IDBcclxuICAgICAgfSlgKSkgYXMgc3RyaW5nO1xyXG4gICAgICBjb25zdCBwID0gSlNPTi5wYXJzZShwcm9iZSkgYXMgeyB4c3NGbGFnOiBzdHJpbmc7IGltZ0NvdW50OiBudW1iZXI7IHNjcmlwdFJhbjogYm9vbGVhbiB9O1xyXG4gICAgICByZXR1cm4gW3AueHNzRmxhZyA9PT0gJ3VuZGVmaW5lZCcgJiYgcC5pbWdDb3VudCA9PT0gMCwgYHhzc0ZsYWc9JHtwLnhzc0ZsYWd9IGltZz0ke3AuaW1nQ291bnR9YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICBsZXQgZmFpbGVkID0gMDtcclxuICAgIGZvciAoY29uc3QgW25hbWUsIG9rLCBkZXRhaWxdIG9mIHJlc3VsdHMpIHtcclxuICAgICAgY29uc29sZS5sb2coYFNFQ1VSSVRZLVRFU1QgJHtvayA/ICdQQVNTJyA6ICdGQUlMJ30gfCAke25hbWV9IHwgJHtyZWRhY3QoZGV0YWlsKX1gKTtcclxuICAgICAgaWYgKCFvaykgZmFpbGVkICs9IDE7XHJcbiAgICB9XHJcbiAgICBjb25zb2xlLmxvZyhgU0VDVVJJVFktVEVTVCBTVU1NQVJZIHBhc3M9JHtyZXN1bHRzLmxlbmd0aCAtIGZhaWxlZH0vJHtyZXN1bHRzLmxlbmd0aH1gKTtcclxuICAgIGFwcC5leGl0KGZhaWxlZCA9PT0gMCA/IDAgOiAxKTtcclxuICB9XHJcblxyXG4gIC8vIFx1OTAwMFx1NTFGQTpcdTRGMThcdTk2QzVcdTUwNUNcdTZCNjJcdTgxRUFcdTVERjEgc3Bhd24gXHU3Njg0IGhvc3Qoc2h1dGRvd24gXHU3QUVGXHU3MEI5IFx1MjE5MiBcdTUxNUNcdTVFOTVcdTUzRUEga2lsbCBcdTgxRUFcdTVERjFcdTc2ODRcdTUzRTVcdTY3QzQpXHJcbiAgYXBwLm9uKCdiZWZvcmUtcXVpdCcsIChlKSA9PiB7XHJcbiAgICBpZiAoc3VwZXJ2aXNvciAhPT0gbnVsbCAmJiBzdXBlcnZpc29yLnN0YXRlICE9PSAnc3RvcHBlZCcpIHtcclxuICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xyXG4gICAgICBzc2VBYm9ydD8uYWJvcnQoKTtcclxuICAgICAgdm9pZCBzdXBlcnZpc29yLnN0b3AoKS5maW5hbGx5KCgpID0+IGFwcC5xdWl0KCkpO1xyXG4gICAgfVxyXG4gIH0pO1xyXG4gIGFwcC5vbignd2luZG93LWFsbC1jbG9zZWQnLCAoKSA9PiB7XHJcbiAgICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSAhPT0gJ2RhcndpbicpIGFwcC5xdWl0KCk7XHJcbiAgfSk7XHJcbn1cclxuIiwgIi8qKlxuICogRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yIFx1MjAxNCBobWhhcm5lc3MgaG9zdCBcdThGREJcdTdBMEJcdTc2ODRcdTc1MUZcdTU0N0RcdTU0NjhcdTY3MUZcdTcyQjZcdTYwMDFcdTY3M0EoQURSLTAwMylcdTMwMDJcbiAqXG4gKiBcdTVCODlcdTUxNjhcdTRFMERcdTUzRDhcdTkxQ0Y6XG4gKiAgLSBcdTUzRUFcdTdFRDFcdTVCOUEvXHU2M0EyXHU2RDRCIDEyNy4wLjAuMTtob3N0IFx1NEY3Rlx1NzUyOFx1NjRDRFx1NEY1Q1x1N0NGQlx1N0VERlx1NTIwNlx1OTE0RFx1N0FFRlx1NTNFMyhwb3J0IDApLFx1NUI5RVx1OTY0NVx1N0FFRlx1NTNFM1xuICogICAgXHU3NTMxIGhvc3QgXHU3Njg0IHN0ZG91dCBcdTVGMTVcdTVCRkNcdTg4NENcdTU2REVcdTRGMjAoSG9zdFJlYWR5TGluZSlcdTMwMDJcbiAqICAtIFx1OUFEOFx1NzFCNSB0b2tlbiBcdTUzRUFcdTkwMUFcdThGQzdcdTVCNTBcdThGREJcdTdBMEJcdTczQUZcdTU4ODNcdTUzRDhcdTkxQ0ZcdTRGMjBcdTkwMTIsXHU3RUREXHU0RTBEXHU4RkRCIFVSTC9cdTY1RTVcdTVGRDcvSVBDIFx1NjYwRVx1NjU4N1x1OEQxRlx1OEY3RFx1MzAwMlxuICogIC0gXHU1M0VBXHU1MDVDXHU2QjYyXHU2NzJDIHN1cGVydmlzb3Igc3Bhd24gXHU3Njg0XHU4RkRCXHU3QTBCXHU1M0U1XHU2N0M0O1x1N0VERFx1NEUwRFx1NjMwOVx1OEZEQlx1N0EwQlx1NTQwRCBraWxsXHUzMDAyXG4gKiAgLSBob3N0IGNyYXNoIFx1NTQwRVx1NjcwOVx1OTY1MFx1OTFDRFx1NTQyRjtcdTkxQ0RcdTU0MkZcdTRFMERcdTkxQ0RcdTY1M0VcdTRFRkJcdTRGNTVcdTc1MjhcdTYyMzdcdTUyQThcdTRGNUMoXHU5NzVFXHU1RTQyXHU3QjQ5XHU1MkE4XHU0RjVDXHU3NTMxXHU3NTI4XHU2MjM3XHU3ODZFXHU4QkE0KVx1MzAwMlxuICovXG5pbXBvcnQgeyBzcGF3biwgdHlwZSBDaGlsZFByb2Nlc3MgfSBmcm9tICdub2RlOmNoaWxkX3Byb2Nlc3MnO1xuaW1wb3J0IHsgY3JlYXRlSW50ZXJmYWNlIH0gZnJvbSAnbm9kZTpyZWFkbGluZSc7XG5pbXBvcnQgeyByYW5kb21CeXRlcyB9IGZyb20gJ25vZGU6Y3J5cHRvJztcbmltcG9ydCB7IGRlc2t0b3BFcnJvciwgaXNEZXNrdG9wRXJyb3IsIHR5cGUgRGVza3RvcEVycm9yIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyc7XG5cbmV4cG9ydCB0eXBlIEhvc3RTdGF0ZSA9XG4gIHwgJ3N0b3BwZWQnXG4gIHwgJ3N0YXJ0aW5nJ1xuICB8ICdyZWFkeSdcbiAgfCAnZGlzY29ubmVjdGVkJ1xuICB8ICdyZXN0YXJ0aW5nJ1xuICB8ICdzdG9wcGluZydcbiAgfCAnZmFpbGVkJztcblxuZXhwb3J0IGludGVyZmFjZSBIb3N0U3BlYyB7XG4gIC8qKiBcdTUzRUZcdTYyNjdcdTg4NENcdTY1ODdcdTRFRjYoXHU5MDFBXHU1RTM4IHByb2Nlc3MuZXhlY1BhdGgpXHUzMDAyICovXG4gIGNvbW1hbmQ6IHN0cmluZztcbiAgYXJnczogc3RyaW5nW107XG4gIGN3ZD86IHN0cmluZztcbiAgLyoqIFx1OTg5RFx1NTkxNlx1NzNBRlx1NTg4M1x1NTNEOFx1OTFDRihcdTRGMUFcdTRFMEUgcHJvY2Vzcy5lbnYgXHU1NDA4XHU1RTc2KVx1MzAwMiAqL1xuICBlbnY/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFN1cGVydmlzb3JPcHRpb25zIHtcbiAgLyoqIFx1NjcxRlx1NjcxQiBob3N0IFx1NjgyMVx1OUE4Q1x1NzY4NCBiZWFyZXIgdG9rZW47XHU0RTBEXHU0RjIwXHU1MjE5XHU2QkNGXHU2QjIxIHN0YXJ0IFx1NzUxRlx1NjIxMFx1OUFEOFx1NzFCNVx1OTY4Rlx1NjczQVx1NTAzQ1x1MzAwMiAqL1xuICB0b2tlbj86IHN0cmluZztcbiAgbWF4UmVzdGFydHM/OiBudW1iZXI7XG4gIHN0YXJ0VGltZW91dE1zPzogbnVtYmVyO1xuICBncmFjZWZ1bFNodXRkb3duTXM/OiBudW1iZXI7XG4gIG9uU3RhdGVDaGFuZ2U/KHN0YXRlOiBIb3N0U3RhdGUsIGluZm86IHsgcmVzdGFydENvdW50OiBudW1iZXI7IGxhc3RFcnJvcj86IHN0cmluZyB9KTogdm9pZDtcbiAgLyoqIFx1NkJDRlx1NkIyMSBob3N0IFx1NUMzMVx1N0VFQShcdTU0MkIgY3Jhc2ggXHU4MUVBXHU2MTA4XHU1NDBFXHU3Njg0XHU5MUNEXHU1NDJGKVx1OTBGRFx1NEYxQVx1ODlFNlx1NTNEMSxcdTY0M0FcdTVFMjZcdTdBRUZcdTcwQjkoXHU1NDJCIHRva2VuLFxuICAgKiAgXHU0RUM1XHU0RjlCXHU1NDBDXHU0RkUxXHU0RUZCXHU1N0RGXHU3Njg0XHU1QkJGXHU0RTNCXHU4RkRCXHU3QTBCXHU5MUNEXHU1RUZBXHU2ODY1XHU1QkEyXHU2MjM3XHU3QUVGO1x1NEUwRFx1ODk4MVx1OERFOFx1OEZEQiByZW5kZXJlcilcdTMwMDIgKi9cbiAgb25SZWFkeT8oZW5kcG9pbnQ6IEhvc3RFbmRwb2ludCk6IHZvaWQ7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgSG9zdEVuZHBvaW50IHtcbiAgcG9ydDogbnVtYmVyO1xuICB2ZXJzaW9uOiBzdHJpbmc7XG4gIHRva2VuOiBzdHJpbmc7XG59XG5cbi8qKiBIb3N0UmVhZHlMaW5lIFx1NzY4NFx1N0M3Qlx1NTc4Qlx1NUI4OFx1NTM2Qlx1NEVDRSBjb250cmFjdHMgXHU1RjE1XHU1MTY1LFx1OTA3Rlx1NTE0RFx1NTNDQ1x1NUI5RVx1NzNCMFx1MzAwMiAqL1xuaW1wb3J0IHsgaXNIb3N0UmVhZHlMaW5lIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyc7XG5cbi8vIDQ1czpobWhhcm5lc3MgXHU3NzFGXHU1QjlFXHU1MTY1XHU1M0UzXHU3RUNGIHRzeCBcdTUxQjdcdTdGMTZcdThCRDFcdTY1NzRcdTU5NTcgQ0xJLFx1NjczQVx1NTY2OFx1OUFEOFx1OEQxRlx1OEY3RFx1NjVGNlx1NTNFRlx1OEQ4NSAyMHNcbi8vICgyMDI2LTEwLTExIFx1OEZERVx1N0VFRFx1OUE4Q1x1NjUzNlx1NEUyRFx1OTVGNFx1NkI0N1x1NjAyNyBIT1NUX05PVF9SRUFEWSBcdTc2ODRcdTY4MzlcdTU2RTA7XHU3QTdBXHU5NUYyXHU1QjlFXHU2RDRCIDZzKVx1MzAwMlxuY29uc3QgREVGQVVMVF9TVEFSVF9USU1FT1VUX01TID0gNDVfMDAwO1xuY29uc3QgREVGQVVMVF9NQVhfUkVTVEFSVFMgPSAzO1xuY29uc3QgREVGQVVMVF9HUkFDRUZVTF9NUyA9IDVfMDAwO1xuXG5leHBvcnQgY2xhc3MgRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yIHtcbiAgcHJpdmF0ZSBjaGlsZDogQ2hpbGRQcm9jZXNzIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgX3N0YXRlOiBIb3N0U3RhdGUgPSAnc3RvcHBlZCc7XG4gIHByaXZhdGUgcmVzdGFydENvdW50ID0gMDtcbiAgcHJpdmF0ZSBsYXN0RXJyb3IgPSAnJztcbiAgcHJpdmF0ZSBzdG9wcGluZyA9IGZhbHNlO1xuICBwcml2YXRlIHJlYWRvbmx5IHRva2VuOiBzdHJpbmc7XG4gIHByaXZhdGUgcmVhZG9ubHkgb3B0czogUmVxdWlyZWQ8UGljazxTdXBlcnZpc29yT3B0aW9ucywgJ21heFJlc3RhcnRzJyB8ICdzdGFydFRpbWVvdXRNcycgfCAnZ3JhY2VmdWxTaHV0ZG93bk1zJz4+ICYgU3VwZXJ2aXNvck9wdGlvbnM7XG4gIHByaXZhdGUgZXhpdFdhaXRlcnM6IEFycmF5PCgpID0+IHZvaWQ+ID0gW107XG5cbiAgY29uc3RydWN0b3IoXG4gICAgcHJpdmF0ZSByZWFkb25seSBzcGVjOiBIb3N0U3BlYyxcbiAgICBvcHRzOiBTdXBlcnZpc29yT3B0aW9ucyA9IHt9LFxuICApIHtcbiAgICB0aGlzLnRva2VuID0gb3B0cy50b2tlbiA/PyByYW5kb21CeXRlcygzMikudG9TdHJpbmcoJ2Jhc2U2NHVybCcpO1xuICAgIHRoaXMub3B0cyA9IHtcbiAgICAgIG1heFJlc3RhcnRzOiBvcHRzLm1heFJlc3RhcnRzID8/IERFRkFVTFRfTUFYX1JFU1RBUlRTLFxuICAgICAgc3RhcnRUaW1lb3V0TXM6IG9wdHMuc3RhcnRUaW1lb3V0TXMgPz8gREVGQVVMVF9TVEFSVF9USU1FT1VUX01TLFxuICAgICAgZ3JhY2VmdWxTaHV0ZG93bk1zOiBvcHRzLmdyYWNlZnVsU2h1dGRvd25NcyA/PyBERUZBVUxUX0dSQUNFRlVMX01TLFxuICAgICAgLi4ub3B0cyxcbiAgICB9O1xuICB9XG5cbiAgZ2V0IHN0YXRlKCk6IEhvc3RTdGF0ZSB7XG4gICAgcmV0dXJuIHRoaXMuX3N0YXRlO1xuICB9XG5cbiAgZ2V0IHJlc3RhcnRzVXNlZCgpOiBudW1iZXIge1xuICAgIHJldHVybiB0aGlzLnJlc3RhcnRDb3VudDtcbiAgfVxuXG4gIHByaXZhdGUgc2V0U3RhdGUoczogSG9zdFN0YXRlLCBlcnI/OiBzdHJpbmcpOiB2b2lkIHtcbiAgICB0aGlzLl9zdGF0ZSA9IHM7XG4gICAgaWYgKGVyciAhPT0gdW5kZWZpbmVkKSB0aGlzLmxhc3RFcnJvciA9IGVycjtcbiAgICBjb25zdCBpbmZvOiB7IHJlc3RhcnRDb3VudDogbnVtYmVyOyBsYXN0RXJyb3I/OiBzdHJpbmcgfSA9IHsgcmVzdGFydENvdW50OiB0aGlzLnJlc3RhcnRDb3VudCB9O1xuICAgIGlmICh0aGlzLmxhc3RFcnJvciAhPT0gJycpIGluZm8ubGFzdEVycm9yID0gdGhpcy5sYXN0RXJyb3I7XG4gICAgdGhpcy5vcHRzLm9uU3RhdGVDaGFuZ2U/LihzLCBpbmZvKTtcbiAgfVxuXG4gIC8qKiBcdTU0MkZcdTUyQTggaG9zdCBcdTVFNzZcdTdCNDlcdTVGODUgcmVhZHkoXHU1RjE1XHU1QkZDXHU4ODRDICsgXHU1RTI2IHRva2VuIFx1NzY4NFx1NTA2NVx1NUVCN1x1NjNBMlx1NkQ0QilcdTMwMDIgKi9cbiAgYXN5bmMgc3RhcnQoKTogUHJvbWlzZTxIb3N0RW5kcG9pbnQ+IHtcbiAgICBpZiAodGhpcy5fc3RhdGUgPT09ICdyZWFkeScgfHwgdGhpcy5fc3RhdGUgPT09ICdzdGFydGluZycpIHtcbiAgICAgIHRocm93IGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgc3VwZXJ2aXNvciBhbHJlYWR5ICR7dGhpcy5fc3RhdGV9YCk7XG4gICAgfVxuICAgIHRoaXMucmVzdGFydENvdW50ID0gMDtcbiAgICB0aGlzLnN0b3BwaW5nID0gZmFsc2U7XG4gICAgcmV0dXJuIHRoaXMubGF1bmNoKCk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGxhdW5jaCgpOiBQcm9taXNlPEhvc3RFbmRwb2ludD4ge1xuICAgIHRoaXMuc2V0U3RhdGUoJ3N0YXJ0aW5nJyk7XG4gICAgY29uc3QgY2hpbGQgPSBzcGF3bih0aGlzLnNwZWMuY29tbWFuZCwgdGhpcy5zcGVjLmFyZ3MsIHtcbiAgICAgIGN3ZDogdGhpcy5zcGVjLmN3ZCxcbiAgICAgIGVudjoge1xuICAgICAgICAuLi5wcm9jZXNzLmVudixcbiAgICAgICAgLi4udGhpcy5zcGVjLmVudixcbiAgICAgICAgSE1IX0RFU0tUT1BfVE9LRU46IHRoaXMudG9rZW4sXG4gICAgICB9LFxuICAgICAgc3RkaW86IFsnaWdub3JlJywgJ3BpcGUnLCAncGlwZSddLFxuICAgICAgd2luZG93c0hpZGU6IHRydWUsXG4gICAgfSk7XG4gICAgdGhpcy5jaGlsZCA9IGNoaWxkO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGVuZHBvaW50ID0gYXdhaXQgdGhpcy5hd2FpdFJlYWR5KGNoaWxkKTtcbiAgICAgIHRoaXMuY3VycmVudEVuZHBvaW50ID0geyBwb3J0OiBlbmRwb2ludC5wb3J0LCB2ZXJzaW9uOiBlbmRwb2ludC52ZXJzaW9uIH07XG4gICAgICB0aGlzLnNldFN0YXRlKCdyZWFkeScpO1xuICAgICAgdGhpcy5vcHRzLm9uUmVhZHk/LihlbmRwb2ludCk7XG4gICAgICAvLyByZWFkeSBcdTRFNEJcdTU0MEVcdThGREJcdTdBMEJcdTZCN0JcdTRFQTEgPSBcdTYxMEZcdTU5MTZcdTkwMDBcdTUxRkEgXHUyMTkyIFx1NjcwOVx1OTY1MFx1OTFDRFx1NTQyRlxuICAgICAgY2hpbGQub25jZSgnZXhpdCcsICgpID0+IHtcbiAgICAgICAgdGhpcy5leGl0V2FpdGVycy5mb3JFYWNoKCh3KSA9PiB3KCkpO1xuICAgICAgICB0aGlzLmV4aXRXYWl0ZXJzID0gW107XG4gICAgICAgIHRoaXMub25VbmV4cGVjdGVkRXhpdCgpO1xuICAgICAgfSk7XG4gICAgICByZXR1cm4gZW5kcG9pbnQ7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBpZiAoIWNoaWxkLmtpbGxlZCkgY2hpbGQua2lsbCgpO1xuICAgICAgaWYgKHRoaXMuY2hpbGQgPT09IGNoaWxkKSB0aGlzLmNoaWxkID0gbnVsbDtcbiAgICAgIHRocm93IGVycjtcbiAgICB9XG4gIH1cblxuICAvKiogXHU0RUNFIHN0ZG91dCBcdTYyN0UgSG9zdFJlYWR5TGluZSxcdTcxMzZcdTU0MEVcdTUwNjVcdTVFQjdcdTYzQTJcdTZENEJcdTMwMDIgKi9cbiAgcHJpdmF0ZSBhd2FpdFJlYWR5KGNoaWxkOiBDaGlsZFByb2Nlc3MpOiBQcm9taXNlPEhvc3RFbmRwb2ludD4ge1xuICAgIHJldHVybiBuZXcgUHJvbWlzZTxIb3N0RW5kcG9pbnQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgIHJlamVjdChkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYGhvc3QgZGlkIG5vdCBzaWduYWwgcmVhZHkgd2l0aGluICR7dGhpcy5vcHRzLnN0YXJ0VGltZW91dE1zfW1zYCwgeyByZXRyeWFibGU6IHRydWUsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XG4gICAgICB9LCB0aGlzLm9wdHMuc3RhcnRUaW1lb3V0TXMpO1xuXG4gICAgICBjb25zdCBkb25lID0gKGZuOiAoKSA9PiB2b2lkKTogdm9pZCA9PiB7XG4gICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgIGZuKCk7XG4gICAgICB9O1xuXG4gICAgICBpZiAoIWNoaWxkLnN0ZG91dCkge1xuICAgICAgICBkb25lKCgpID0+IHJlamVjdChkZXNrdG9wRXJyb3IoJ1JVTlRJTUVfQ1JBU0hFRCcsICdob3N0IHNwYXduZWQgd2l0aG91dCBzdGRvdXQgcGlwZScpKSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgY29uc3QgcmwgPSBjcmVhdGVJbnRlcmZhY2UoeyBpbnB1dDogY2hpbGQuc3Rkb3V0IH0pO1xuICAgICAgY29uc3Qgb25MaW5lID0gKGxpbmU6IHN0cmluZyk6IHZvaWQgPT4ge1xuICAgICAgICBsZXQgcGFyc2VkOiB1bmtub3duO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHBhcnNlZCA9IEpTT04ucGFyc2UobGluZSk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIHJldHVybjsgLy8gaG9zdCBcdTc2ODRcdTY2NkVcdTkwMUFcdTY1RTVcdTVGRDdcdTg4NEMsXHU1RkZEXHU3NTY1XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGlzSG9zdFJlYWR5TGluZShwYXJzZWQpKSB7XG4gICAgICAgICAgcmwuY2xvc2UoKTtcbiAgICAgICAgICB2b2lkIHRoaXMucHJvYmVBbmRSZW1lbWJlcihwYXJzZWQucG9ydCwgcGFyc2VkLnZlcnNpb24pXG4gICAgICAgICAgICAudGhlbigoZW5kcG9pbnQpID0+IGRvbmUoKCkgPT4gcmVzb2x2ZShlbmRwb2ludCkpKVxuICAgICAgICAgICAgLmNhdGNoKChlcnI6IHVua25vd24pID0+IGRvbmUoKCkgPT4gcmVqZWN0KGVycikpKTtcbiAgICAgICAgfVxuICAgICAgfTtcbiAgICAgIHJsLm9uKCdsaW5lJywgb25MaW5lKTtcblxuICAgICAgY2hpbGQub25jZSgnZXhpdCcsIChjb2RlKSA9PiB7XG4gICAgICAgIGRvbmUoKCkgPT4gcmVqZWN0KGRlc2t0b3BFcnJvcignUlVOVElNRV9DUkFTSEVEJywgYGhvc3QgZXhpdGVkIGR1cmluZyBzdGFydHVwIChjb2RlICR7Y29kZSA/PyAnbnVsbCd9KWAsIHsgcmV0cnlhYmxlOiBmYWxzZSwgcmVjb3ZlcnlBY3Rpb246ICdPUEVOX0xPR1MnIH0pKSk7XG4gICAgICB9KTtcbiAgICB9KTtcbiAgfVxuXG4gIC8qKiBcdTVFMjYgdG9rZW4gXHU3Njg0XHU1MDY1XHU1RUI3XHU2M0EyXHU2RDRCOkdFVCAvYXBpL3N0YXRlXHUzMDAyNDAxIFx1MjE5MiBBVVRIX0ZBSUxFRChcdTRFMERcdTkxQ0RcdThCRDUpXHUzMDAyICovXG4gIHByaXZhdGUgYXN5bmMgcHJvYmUocG9ydDogbnVtYmVyLCB2ZXJzaW9uOiBzdHJpbmcpOiBQcm9taXNlPEhvc3RFbmRwb2ludD4ge1xuICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgIHRyeSB7XG4gICAgICByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2FwaS9zdGF0ZWAsIHtcbiAgICAgICAgaGVhZGVyczogeyAneC1obWgta2V5JzogdGhpcy50b2tlbiB9LFxuICAgICAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoM18wMDApLFxuICAgICAgfSk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICB0aHJvdyBkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYGhlYWx0aCBwcm9iZSBmYWlsZWQ6ICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTYwKX1gLCB7IHJldHJ5YWJsZTogdHJ1ZSB9KTtcbiAgICB9XG4gICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSB8fCByZXMuc3RhdHVzID09PSA0MDMpIHtcbiAgICAgIHRocm93IGRlc2t0b3BFcnJvcignQVVUSF9GQUlMRUQnLCBgaG9zdCByZWplY3RlZCB0aGUgc2Vzc2lvbiB0b2tlbiAoSFRUUCAke3Jlcy5zdGF0dXN9KWAsIHsgcmV0cnlhYmxlOiBmYWxzZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pO1xuICAgIH1cbiAgICBpZiAoIXJlcy5vaykge1xuICAgICAgdGhyb3cgZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBoZWFsdGggcHJvYmUgSFRUUCAke3Jlcy5zdGF0dXN9YCwgeyByZXRyeWFibGU6IHRydWUgfSk7XG4gICAgfVxuICAgIHJldHVybiB7IHBvcnQsIHZlcnNpb24sIHRva2VuOiB0aGlzLnRva2VuIH07XG4gIH1cblxuICBwcml2YXRlIG9uVW5leHBlY3RlZEV4aXQoKTogdm9pZCB7XG4gICAgaWYgKHRoaXMuc3RvcHBpbmcgfHwgdGhpcy5fc3RhdGUgPT09ICdzdG9wcGVkJyB8fCB0aGlzLl9zdGF0ZSA9PT0gJ3N0b3BwaW5nJykgcmV0dXJuO1xuICAgIHRoaXMuY2hpbGQgPSBudWxsO1xuICAgIGlmICh0aGlzLnJlc3RhcnRDb3VudCA8IHRoaXMub3B0cy5tYXhSZXN0YXJ0cykge1xuICAgICAgdGhpcy5yZXN0YXJ0Q291bnQgKz0gMTtcbiAgICAgIHRoaXMuc2V0U3RhdGUoJ3Jlc3RhcnRpbmcnKTtcbiAgICAgIHZvaWQgdGhpcy5sYXVuY2goKS5jYXRjaCgoKSA9PiB7XG4gICAgICAgIC8vIFx1OTFDRFx1NTQyRlx1NUMxRFx1OEJENVx1NTkzMVx1OEQyNShcdTU0MkZcdTUyQThcdTUzNzNcdTVEMjkvXHU4RDg1XHU2NUY2L1x1NjJEMlx1OEJBNCk6XHU3RUU3XHU3RUVEXHU2RDg4XHU4MDE3XHU5MUNEXHU1NDJGXHU2QjIxXHU2NTcwXHU3NkY0XHU1MjMwXHU2NTNFXHU1RjAzXG4gICAgICAgIHRoaXMucmV0cnlPckZhaWwoKTtcbiAgICAgIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLnNldFN0YXRlKCdmYWlsZWQnLCBgaG9zdCBleGl0ZWQgdW5leHBlY3RlZGx5ICR7dGhpcy5yZXN0YXJ0Q291bnQgKyAxfSB0aW1lczsgZ2l2aW5nIHVwYCk7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSByZXRyeU9yRmFpbCgpOiB2b2lkIHtcbiAgICBpZiAodGhpcy5zdG9wcGluZyB8fCB0aGlzLl9zdGF0ZSA9PT0gJ3N0b3BwZWQnIHx8IHRoaXMuX3N0YXRlID09PSAnc3RvcHBpbmcnKSByZXR1cm47XG4gICAgaWYgKHRoaXMucmVzdGFydENvdW50IDwgdGhpcy5vcHRzLm1heFJlc3RhcnRzKSB7XG4gICAgICB0aGlzLnJlc3RhcnRDb3VudCArPSAxO1xuICAgICAgdGhpcy5zZXRTdGF0ZSgncmVzdGFydGluZycpO1xuICAgICAgdm9pZCB0aGlzLmxhdW5jaCgpLmNhdGNoKCgpID0+IHRoaXMucmV0cnlPckZhaWwoKSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMuc2V0U3RhdGUoJ2ZhaWxlZCcsIGBob3N0IGZhaWxlZCB0byBzdGF5IHVwIGFmdGVyICR7dGhpcy5yZXN0YXJ0Q291bnR9IHJlc3RhcnQgYXR0ZW1wdHNgKTtcbiAgICB9XG4gIH1cblxuICAvKiogXHU0RjE4XHU5NkM1XHU1MDVDXHU2QjYyOlx1NTE0OCBIVFRQIHNodXRkb3duLFx1OEQ4NVx1NjVGNlx1NjI0RFx1NUJGOVx1NjcyQ1x1OEZEQlx1N0EwQlx1NTNFNVx1NjdDNCBraWxsXHUzMDAyICovXG4gIGFzeW5jIHN0b3AoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgdGhpcy5zdG9wcGluZyA9IHRydWU7XG4gICAgaWYgKHRoaXMuX3N0YXRlID09PSAnc3RvcHBlZCcpIHJldHVybjtcbiAgICB0aGlzLnNldFN0YXRlKCdzdG9wcGluZycpO1xuICAgIGNvbnN0IGNoaWxkID0gdGhpcy5jaGlsZDtcbiAgICB0aGlzLmNoaWxkID0gbnVsbDtcbiAgICB0aGlzLmN1cnJlbnRFbmRwb2ludCA9IG51bGw7XG4gICAgaWYgKCFjaGlsZCkge1xuICAgICAgdGhpcy5zZXRTdGF0ZSgnc3RvcHBlZCcpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBleGl0ZWQgPSBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4ge1xuICAgICAgaWYgKGNoaWxkLmV4aXRDb2RlICE9PSBudWxsIHx8IGNoaWxkLnNpZ25hbENvZGUgIT09IG51bGwpIHJlc29sdmUoKTtcbiAgICAgIGVsc2Uge1xuICAgICAgICBjb25zdCB3ID0gKCk6IHZvaWQgPT4gcmVzb2x2ZSgpO1xuICAgICAgICB0aGlzLmV4aXRXYWl0ZXJzLnB1c2godyk7XG4gICAgICAgIGNoaWxkLm9uY2UoJ2V4aXQnLCB3KTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICAvLyBcdTVERjJcdTc3RTVcdTdBRUZcdTUzRTNcdTYyNERcdTVDMURcdThCRDUgSFRUUCBcdTRGMThcdTk2QzVcdTUxNzNcdTk1RUQ7XHU2NzJBXHU3N0U1XHU3QUVGXHU1M0UzXHU3NkY0XHU2M0E1XHU4RDcwIGtpbGwgXHU1MTVDXHU1RTk1XG4gICAgaWYgKHRoaXMubGFzdEVuZHBvaW50ICE9PSBudWxsKSB7XG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3RoaXMubGFzdEVuZHBvaW50fS9hcGkvZGVza3RvcC9zaHV0ZG93bmAsIHtcbiAgICAgICAgICBtZXRob2Q6ICdQT1NUJyxcbiAgICAgICAgICBoZWFkZXJzOiB7ICd4LWhtaC1rZXknOiB0aGlzLnRva2VuIH0sXG4gICAgICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDFfMDAwKSxcbiAgICAgICAgfSk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLy8gaG9zdCBcdTVERjJcdTZCN0JcdTYyMTZcdTRFMERcdTVFOTRcdTdCNTQ6XHU4RDcwIGtpbGwgXHU1MTVDXHU1RTk1XG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IGdyYWNlZnVsID0gYXdhaXQgUHJvbWlzZS5yYWNlKFtcbiAgICAgIGV4aXRlZC50aGVuKCgpID0+IHRydWUpLFxuICAgICAgbmV3IFByb21pc2U8Ym9vbGVhbj4oKHJlc29sdmUpID0+IHNldFRpbWVvdXQoKCkgPT4gcmVzb2x2ZShmYWxzZSksIHRoaXMub3B0cy5ncmFjZWZ1bFNodXRkb3duTXMpKSxcbiAgICBdKTtcbiAgICBpZiAoIWdyYWNlZnVsICYmIGNoaWxkLmV4aXRDb2RlID09PSBudWxsICYmIGNoaWxkLnNpZ25hbENvZGUgPT09IG51bGwpIHtcbiAgICAgIGNoaWxkLmtpbGwoKTsgLy8gXHU1M0VBXHU2NzQwXHU4MUVBXHU1REYxXHU2MzAxXHU2NzA5XHU3Njg0XHU1M0U1XHU2N0M0LFx1N0VERFx1NEUwRFx1NjMwOVx1OEZEQlx1N0EwQlx1NTQwRFxuICAgIH1cbiAgICBhd2FpdCBleGl0ZWQuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcbiAgICB0aGlzLnNldFN0YXRlKCdzdG9wcGVkJyk7XG4gIH1cblxuICBwcml2YXRlIGxhc3RFbmRwb2ludDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgY3VycmVudEVuZHBvaW50OiB7IHBvcnQ6IG51bWJlcjsgdmVyc2lvbjogc3RyaW5nIH0gfCBudWxsID0gbnVsbDtcblxuICAvKiogXHU1RjUzXHU1MjREIGhvc3QgXHU3QUVGXHU3MEI5KHJlYWR5IFx1NTQwRVx1NjcwOVx1NTAzQztcdTRFMERcdTU0MkIgdG9rZW4pXHUzMDAyICovXG4gIGdldCBlbmRwb2ludCgpOiB7IHBvcnQ6IG51bWJlcjsgdmVyc2lvbjogc3RyaW5nIH0gfCBudWxsIHtcbiAgICByZXR1cm4gdGhpcy5jdXJyZW50RW5kcG9pbnQ7XG4gIH1cblxuICAvKiogXHU2M0EyXHU2RDRCXHU2MjEwXHU1MjlGXHU1NDBFXHU4QkIwXHU0RjRGXHU3QUVGXHU1M0UzLFx1NEY5QiBzdG9wKCkgXHU3Njg0XHU0RjE4XHU5NkM1XHU1MTczXHU5NUVEXHU0RjdGXHU3NTI4XHUzMDAyICovXG4gIHByaXZhdGUgYXN5bmMgcHJvYmVBbmRSZW1lbWJlcihwb3J0OiBudW1iZXIsIHZlcnNpb246IHN0cmluZyk6IFByb21pc2U8SG9zdEVuZHBvaW50PiB7XG4gICAgY29uc3QgZXAgPSBhd2FpdCB0aGlzLnByb2JlKHBvcnQsIHZlcnNpb24pO1xuICAgIHRoaXMubGFzdEVuZHBvaW50ID0gZXAucG9ydDtcbiAgICByZXR1cm4gZXA7XG4gIH1cbn1cblxuLyoqIFx1NjI4QVx1NjcyQVx1NzdFNVx1OTUxOVx1OEJFRlx1ODlDNFx1N0VBNlx1NEUzQSBEZXNrdG9wRXJyb3IoXHU1REYyXHU2NjJGXHU1MjE5XHU1MzlGXHU2ODM3XHU4RkQ0XHU1NkRFKVx1MzAwMiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRvRGVza3RvcEVycm9yKGVycjogdW5rbm93bik6IERlc2t0b3BFcnJvciB7XG4gIGlmIChpc0Rlc2t0b3BFcnJvcihlcnIpKSByZXR1cm4gZXJyO1xuICBjb25zdCBtZXNzYWdlID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICByZXR1cm4gZGVza3RvcEVycm9yKCdSVU5USU1FX0NSQVNIRUQnLCBtZXNzYWdlLnNsaWNlKDAsIDMwMCksIHsgcmV0cnlhYmxlOiBmYWxzZSB9KTtcbn1cbiIsICIvKipcbiAqIEBobWgtZGVza3RvcC9jb250cmFjdHMgXHUyMDE0IFx1NEU4Qlx1NEVGNlx1NEZFMVx1NUMwMShcdTVGMDBcdTUzRDFcdThCQTFcdTUyMTJcdTY1ODdcdTY4NjMgMDQgXHUwMEE3XHU0RTA5KVxuICpcbiAqIFx1NEUwMFx1Njc2MSBVSSBcdTRFOEJcdTRFRjZcdTc2ODRcdTU1MkZcdTRFMDBcdTVGNjJcdTcyQjZcdTMwMDJcdTUyNERcdTdBRUYgcmVkdWNlciBcdTVGQzVcdTk4N0JcdTYzMDkgc2Vzc2lvbklkL3J1bklkL3NlcSBcdTU5MDRcdTc0MDY7XG4gKiBcdTkxQ0RcdTU5MEQgZXZlbnRJZCBcdTVFNDJcdTdCNDlcdTRFMjJcdTVGMDM7c2VxIFx1N0YzQVx1NTNFM1x1ODlFNlx1NTNEMVx1ODg2NVx1NjJDOTtcdTk3NUVcdTVFNDJcdTdCNDlcdTUyQThcdTRGNUNcdTRFMERcdTc1MzEgU1NFIFx1ODFFQVx1NTJBOFx1OTFDRFx1NTNEMVx1MzAwMlxuICovXG5cbmltcG9ydCB0eXBlIHsgQXJ0aWZhY3RSZWYgfSBmcm9tICcuL2R0by50cyc7XG5pbXBvcnQgdHlwZSB7IERlc2t0b3BFcnJvciB9IGZyb20gJy4vZXJyb3IudHMnO1xuXG4vKiogXHU0RThCXHU0RUY2XHU3OUNEXHU3QzdCKFx1NTIyNFx1NTIyQlx1OTUyRSlcdTMwMDJcdTY1QjBcdTU4OUUga2luZCA9IHNjaGVtYVZlcnNpb24gXHU1MzQ3XHU3RUE3LFx1NEUwRFx1NTE0MVx1OEJCOFx1OTc1OVx1OUVEOFx1NjI2OVx1Njc5QVx1NEUzRVx1MzAwMiAqL1xuZXhwb3J0IGNvbnN0IEVWRU5UX0tJTkRTID0gW1xuICAncnVuLnN0YXJ0ZWQnLFxuICAncGxhbi51cGRhdGVkJyxcbiAgJ3Rvb2wuc3RhcnRlZCcsXG4gICd0b29sLmNvbXBsZXRlZCcsXG4gICdhcHByb3ZhbC5yZXF1aXJlZCcsXG4gICd2ZXJpZmljYXRpb24udXBkYXRlZCcsXG4gICdhcnRpZmFjdC5jcmVhdGVkJyxcbiAgJ3J1bi5jb21wbGV0ZWQnLFxuICAncnVuLmZhaWxlZCcsXG5dIGFzIGNvbnN0O1xuXG5leHBvcnQgdHlwZSBFdmVudEtpbmQgPSAodHlwZW9mIEVWRU5UX0tJTkRTKVtudW1iZXJdO1xuXG5leHBvcnQgY29uc3QgRVZFTlRfU0NIRU1BX1ZFUlNJT04gPSAxO1xuZXhwb3J0IHR5cGUgRXZlbnRTY2hlbWFWZXJzaW9uID0gMTtcblxuLyoqIFNTRSBcdTZENDFcdTRFMEFcdTc2ODRcdTZCQ0ZcdTRFMDBcdTY3NjFcdTRFOEJcdTRFRjZcdTMwMDIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgRXZlbnRFbnZlbG9wZTxUID0gdW5rbm93bj4ge1xuICBzY2hlbWFWZXJzaW9uOiBFdmVudFNjaGVtYVZlcnNpb247XG4gIC8qKiBcdTUxNjhcdTVDNDBcdTU1MkZcdTRFMDA7XHU5MUNEXHU4RkRFL1x1ODg2NVx1NjJDOVx1NTQwRVx1OTFDRFx1NTkwRFx1NTFGQVx1NzNCMFx1NjVGNlx1NjNBNVx1NjUzNlx1NjVCOVx1NUU0Mlx1N0I0OVx1NEUyMlx1NUYwM1x1MzAwMiAqL1xuICBldmVudElkOiBzdHJpbmc7XG4gIHNlc3Npb25JZDogc3RyaW5nO1xuICBydW5JZDogc3RyaW5nO1xuICAvKiogXHU0RjFBXHU4QkREXHU1MTg1XHU1MzU1XHU4QzAzXHU5MDEyXHU1ODlFO1x1N0YzQVx1NTNFM1x1NjEwRlx1NTQ3M1x1Nzc0MFx1NEUyMlx1NEU4Qlx1NEVGNixcdTk3MDBcdTg5ODFcdTg4NjVcdTYyQzlcdTMwMDIgKi9cbiAgc2VxOiBudW1iZXI7XG4gIC8qKiBSRkMzMzM5XHUzMDAyICovXG4gIG9jY3VycmVkQXQ6IHN0cmluZztcbiAga2luZDogRXZlbnRLaW5kO1xuICBwYXlsb2FkOiBUO1xufVxuXG4vKiogcnVuLnN0YXJ0ZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgUnVuU3RhcnRlZFBheWxvYWQge1xuICB0YXNrOiBzdHJpbmc7XG4gIG1vZGU6ICdhc2snIHwgJ2F1dG8nIHwgJ3lvbG8nO1xufVxuXG4vKiogcGxhbi51cGRhdGVkIFx1NzY4NCBwYXlsb2FkKFx1OEJBMVx1NTIxMlx1NkI2NVx1OUFBNFx1NTIxN1x1ODg2OCxcdTY3NjVcdTgxRUEgcnVudGltZSBcdTc2ODRcdTdFRDNcdTY3ODRcdTUzMTZcdThCQTFcdTUyMTIsXHU0RTBEXHU2NjJGIGNoYWluLW9mLXRob3VnaHQpXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIFBsYW5VcGRhdGVkUGF5bG9hZCB7XG4gIHN0ZXBzOiBBcnJheTx7IHRpdGxlOiBzdHJpbmc7IHN0YXR1czogJ3BlbmRpbmcnIHwgJ2FjdGl2ZScgfCAnZG9uZScgfCAnZmFpbGVkJyB9Pjtcbn1cblxuLyoqIHRvb2wuc3RhcnRlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBUb29sU3RhcnRlZFBheWxvYWQge1xuICBuYW1lOiBzdHJpbmc7XG4gIC8qKiBcdTUzQzJcdTY1NzBcdTRFRTVcdTY1ODdcdTY3MkNcdTU0NDhcdTczQjAsXHU2RTMyXHU2N0QzXHU3QUVGXHU2QzM4XHU0RTBEIGV2YWw7XHU1OTI3XHU1QkY5XHU4QzYxXHU3NTMxIHJ1bnRpbWUgXHU2MjJBXHU2NUFEXHUzMDAyICovXG4gIGFyZ3NQcmV2aWV3OiBzdHJpbmc7XG59XG5cbi8qKiB0b29sLmNvbXBsZXRlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBUb29sQ29tcGxldGVkUGF5bG9hZCB7XG4gIG5hbWU6IHN0cmluZztcbiAgaXNFcnJvcjogYm9vbGVhbjtcbiAgb3V0cHV0UHJldmlldzogc3RyaW5nO1xufVxuXG4vKiogYXBwcm92YWwucmVxdWlyZWQgXHU3Njg0IHBheWxvYWRcdTMwMDJcdTVCQTFcdTYyNzlcdTY3NDNcdTVBMDFcdTU3MjggcnVudGltZSBcdTU0MEVcdTdBRUY7VUkgXHU1M0VBXHU2NjJGXHU4RjZDXHU4RkYwXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcHJvdmFsUmVxdWlyZWRQYXlsb2FkIHtcbiAgYXBwcm92YWxJZDogc3RyaW5nO1xuICB0b29sOiBzdHJpbmc7XG4gIGFyZ3NQcmV2aWV3OiBzdHJpbmc7XG4gIC8qKiBcdTVGNzFcdTU0Q0RcdTgzMDNcdTU2RjQvXHU5OENFXHU5NjY5XHU3Njg0XHU0RUJBXHU3QzdCXHU1M0VGXHU4QkZCXHU4QkY0XHU2NjBFLFx1NzUzMSBydW50aW1lIFx1NzUxRlx1NjIxMFx1MzAwMiAqL1xuICByaXNrOiBzdHJpbmc7XG59XG5cbi8qKiB2ZXJpZmljYXRpb24udXBkYXRlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBWZXJpZmljYXRpb25VcGRhdGVkUGF5bG9hZCB7XG4gIHN1bW1hcnk6IHN0cmluZztcbiAgcGFzc2VkOiBib29sZWFuIHwgbnVsbDsgLy8gbnVsbCA9IFx1NjcyQVx1NzdFNS9cdThGREJcdTg4NENcdTRFMkQoTkVFRFMtREFUQSBcdTY1RjZcdTRFMERcdTUwNDdcdTU4NkIpXG59XG5cbi8qKiBhcnRpZmFjdC5jcmVhdGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIEFydGlmYWN0Q3JlYXRlZFBheWxvYWQge1xuICBhcnRpZmFjdDogQXJ0aWZhY3RSZWY7XG59XG5cbi8qKiBydW4uY29tcGxldGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIFJ1bkNvbXBsZXRlZFBheWxvYWQge1xuICB0ZXh0OiBzdHJpbmc7XG4gIHR1cm5zOiBudW1iZXI7XG4gIHRvb2xVc2VzOiBudW1iZXI7XG4gIHVzYWdlPzogeyBwcm9tcHRUb2tlbnM6IG51bWJlcjsgY29tcGxldGlvblRva2VuczogbnVtYmVyIH07XG59XG5cbi8qKiBydW4uZmFpbGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIFJ1bkZhaWxlZFBheWxvYWQge1xuICBlcnJvcjogRGVza3RvcEVycm9yO1xufVxuIiwgIi8qKlxuICogQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyBcdTIwMTQgXHU3RUQzXHU2Nzg0XHU1MzE2XHU2ODRDXHU5NzYyXHU5NTE5XHU4QkVGKFx1NUYwMFx1NTNEMVx1OEJBMVx1NTIxMlx1NjU4N1x1Njg2MyAwNCBcdTAwQTdcdTRFMDkpXHUzMDAyXG4gKlxuICogaG9zdC1ub3QtcmVhZHkgLyBhdXRoLWZhaWxlZCAvIHN0YWxlLXZlcnNpb24gLyBydW50aW1lLWNyYXNoZWQgL1xuICogcG9ydC1iaW5kLWZhaWxlZCAvIHNjaGVtYS1taXNtYXRjaCBcdTVGQzVcdTk4N0JcdTY2MkZcdTdFRDNcdTY3ODRcdTUzMTZcdTk1MTlcdThCRUZcdTc4MDEsXHU1RTc2XHU2M0QwXHU0RjlCXHU0RTBCXHU0RTAwXHU2QjY1XHU1MkE4XHU0RjVDXHUzMDAyXG4gKiBtZXNzYWdlIFx1NjYyRlx1N0VBRlx1NjU4N1x1NjcyQyxcdTZFMzJcdTY3RDNcdTdBRUZcdTZDMzhcdTRFMERcdTYyOEFcdTVCODNcdTVGNTMgSFRNTFx1MzAwMlxuICovXG5leHBvcnQgY29uc3QgRVJST1JfQ09ERVMgPSBbXG4gICdIT1NUX05PVF9SRUFEWScsXG4gICdBVVRIX0ZBSUxFRCcsXG4gICdSVU5USU1FX0NSQVNIRUQnLFxuICAnUE9SVF9CSU5EX0ZBSUxFRCcsXG4gICdTVEFMRV9WRVJTSU9OJyxcbiAgJ1NDSEVNQV9NSVNNQVRDSCcsXG5dIGFzIGNvbnN0O1xuXG5leHBvcnQgdHlwZSBFcnJvckNvZGUgPSAodHlwZW9mIEVSUk9SX0NPREVTKVtudW1iZXJdO1xuXG5leHBvcnQgY29uc3QgUkVDT1ZFUllfQUNUSU9OUyA9IFsnUkVDT05ORUNUJywgJ1JFU1VNRScsICdFWFBPUlQnLCAnT1BFTl9MT0dTJ10gYXMgY29uc3Q7XG5leHBvcnQgdHlwZSBSZWNvdmVyeUFjdGlvbiA9ICh0eXBlb2YgUkVDT1ZFUllfQUNUSU9OUylbbnVtYmVyXTtcblxuZXhwb3J0IGludGVyZmFjZSBEZXNrdG9wRXJyb3Ige1xuICBjb2RlOiBFcnJvckNvZGU7XG4gIC8qKiBcdTdFQUZcdTY1ODdcdTY3MkMsXHU2QzM4XHU0RTBEXHU0RkUxXHU0RUZCXHU0RTNBIEhUTUxcdTMwMDIgKi9cbiAgbWVzc2FnZTogc3RyaW5nO1xuICByZXRyeWFibGU6IGJvb2xlYW47XG4gIHNlc3Npb25JZD86IHN0cmluZztcbiAgcnVuSWQ/OiBzdHJpbmc7XG4gIHJlY292ZXJ5QWN0aW9uPzogUmVjb3ZlcnlBY3Rpb247XG59XG5cbi8qKiBcdTY3ODRcdTkwMjBcdTRFMDBcdTRFMkEgRGVza3RvcEVycm9yKGV4YWN0T3B0aW9uYWxQcm9wZXJ0eVR5cGVzIFx1NTNDQlx1NTk3RClcdTMwMDIgKi9cbmV4cG9ydCBmdW5jdGlvbiBkZXNrdG9wRXJyb3IoXG4gIGNvZGU6IEVycm9yQ29kZSxcbiAgbWVzc2FnZTogc3RyaW5nLFxuICBvcHRzOiB7IHJldHJ5YWJsZT86IGJvb2xlYW47IHNlc3Npb25JZD86IHN0cmluZzsgcnVuSWQ/OiBzdHJpbmc7IHJlY292ZXJ5QWN0aW9uPzogUmVjb3ZlcnlBY3Rpb24gfSA9IHt9LFxuKTogRGVza3RvcEVycm9yIHtcbiAgY29uc3QgZTogRGVza3RvcEVycm9yID0geyBjb2RlLCBtZXNzYWdlLCByZXRyeWFibGU6IG9wdHMucmV0cnlhYmxlID09PSB0cnVlIH07XG4gIGlmIChvcHRzLnNlc3Npb25JZCAhPT0gdW5kZWZpbmVkKSBlLnNlc3Npb25JZCA9IG9wdHMuc2Vzc2lvbklkO1xuICBpZiAob3B0cy5ydW5JZCAhPT0gdW5kZWZpbmVkKSBlLnJ1bklkID0gb3B0cy5ydW5JZDtcbiAgaWYgKG9wdHMucmVjb3ZlcnlBY3Rpb24gIT09IHVuZGVmaW5lZCkgZS5yZWNvdmVyeUFjdGlvbiA9IG9wdHMucmVjb3ZlcnlBY3Rpb247XG4gIHJldHVybiBlO1xufVxuIiwgIi8qKlxuICogQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyBcdTIwMTQgcnVudGltZSBcdTY4MjFcdTlBOEMoZ3VhcmRzKVx1MzAwMlxuICpcbiAqIFx1NkJDRlx1NEUyQVx1OERFOFx1NEZFMVx1NEVGQlx1OEZCOVx1NzU0Q1x1NzY4NFx1NjU3MFx1NjM2RShydW50aW1lXHUyMTkycmVuZGVyZXJcdTMwMDFob3N0XHUyMTkybWFpbilcdThGREJcdTUxNjVcdTUyNERcdTUxNDhcdThGQzcgZ3VhcmQ7XG4gKiBcdTY4MjFcdTlBOENcdTU5MzFcdThEMjVcdTc2ODRcdTY1NzBcdTYzNkVcdTYzMDkgU0NIRU1BX01JU01BVENIIFx1N0VEM1x1Njc4NFx1NTMxNlx1OTUxOVx1OEJFRlx1NTkwNFx1NzQwNixcdTRFMERcdTk3NTlcdTlFRDhcdTYzQTVcdTUzRDdcdTMwMDJcbiAqIFx1NjI0Qlx1NTE5OVx1NUI4OFx1NTM2Qlx1ODAwQ1x1NEUwRFx1NjYyRlx1NUYxNVx1N0IyQ1x1NEUwOVx1NjVCOSBzY2hlbWEgXHU1RTkzOlx1NTk1MVx1N0VBNlx1OTc2Mlx1NUMwRixcdTk2RjZcdTRGOURcdThENTZcdTY1ODdcdTUzMTYoaG1oYXJuZXNzIFx1NTQwQ1x1NkU5MClcdTMwMDJcbiAqL1xuaW1wb3J0IHtcbiAgRVZFTlRfS0lORFMsXG4gIEVWRU5UX1NDSEVNQV9WRVJTSU9OLFxuICB0eXBlIEV2ZW50RW52ZWxvcGUsXG4gIHR5cGUgRXZlbnRLaW5kLFxufSBmcm9tICcuL2V2ZW50LnRzJztcbmltcG9ydCB7IEVSUk9SX0NPREVTLCBSRUNPVkVSWV9BQ1RJT05TLCB0eXBlIERlc2t0b3BFcnJvciB9IGZyb20gJy4vZXJyb3IudHMnO1xuaW1wb3J0IHsgUlVOX1NUQVRVU0VTLCB0eXBlIFJ1blN0YXR1cyB9IGZyb20gJy4vZHRvLnRzJztcblxuY29uc3QgaXNSZWNvcmQgPSAodjogdW5rbm93bik6IHYgaXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPT5cbiAgdHlwZW9mIHYgPT09ICdvYmplY3QnICYmIHYgIT09IG51bGwgJiYgIUFycmF5LmlzQXJyYXkodik7XG5cbmNvbnN0IGlzTm9uRW1wdHlTdHJpbmcgPSAodjogdW5rbm93bik6IHYgaXMgc3RyaW5nID0+IHR5cGVvZiB2ID09PSAnc3RyaW5nJyAmJiB2Lmxlbmd0aCA+IDA7XG5cbmNvbnN0IGlzUmZjMzMzOSA9ICh2OiBzdHJpbmcpOiBib29sZWFuID0+IHtcbiAgY29uc3QgdCA9IERhdGUucGFyc2Uodik7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUodCkgJiYgL1xcZHs0fS1cXGR7Mn0tXFxkezJ9VC8udGVzdCh2KTtcbn07XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0V2ZW50RW52ZWxvcGUodjogdW5rbm93bik6IHYgaXMgRXZlbnRFbnZlbG9wZSB7XG4gIGlmICghaXNSZWNvcmQodikpIHJldHVybiBmYWxzZTtcbiAgaWYgKHYuc2NoZW1hVmVyc2lvbiAhPT0gRVZFTlRfU0NIRU1BX1ZFUlNJT04pIHJldHVybiBmYWxzZTtcbiAgaWYgKCFpc05vbkVtcHR5U3RyaW5nKHYuZXZlbnRJZCkpIHJldHVybiBmYWxzZTtcbiAgaWYgKCFpc05vbkVtcHR5U3RyaW5nKHYuc2Vzc2lvbklkKSkgcmV0dXJuIGZhbHNlO1xuICBpZiAoIWlzTm9uRW1wdHlTdHJpbmcodi5ydW5JZCkpIHJldHVybiBmYWxzZTtcbiAgaWYgKHR5cGVvZiB2LnNlcSAhPT0gJ251bWJlcicgfHwgIU51bWJlci5pc0ludGVnZXIodi5zZXEpIHx8IHYuc2VxIDwgMCkgcmV0dXJuIGZhbHNlO1xuICBpZiAoIWlzTm9uRW1wdHlTdHJpbmcodi5vY2N1cnJlZEF0KSB8fCAhaXNSZmMzMzM5KHYub2NjdXJyZWRBdCkpIHJldHVybiBmYWxzZTtcbiAgaWYgKCFFVkVOVF9LSU5EUy5pbmNsdWRlcyh2LmtpbmQgYXMgRXZlbnRLaW5kKSkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gaXNSZWNvcmQodi5wYXlsb2FkKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzRGVza3RvcEVycm9yKHY6IHVua25vd24pOiB2IGlzIERlc2t0b3BFcnJvciB7XG4gIGlmICghaXNSZWNvcmQodikpIHJldHVybiBmYWxzZTtcbiAgaWYgKCFFUlJPUl9DT0RFUy5pbmNsdWRlcyh2LmNvZGUgYXMgbmV2ZXIpKSByZXR1cm4gZmFsc2U7XG4gIGlmICh0eXBlb2Ygdi5tZXNzYWdlICE9PSAnc3RyaW5nJykgcmV0dXJuIGZhbHNlO1xuICBpZiAodHlwZW9mIHYucmV0cnlhYmxlICE9PSAnYm9vbGVhbicpIHJldHVybiBmYWxzZTtcbiAgaWYgKHYuc2Vzc2lvbklkICE9PSB1bmRlZmluZWQgJiYgIWlzTm9uRW1wdHlTdHJpbmcodi5zZXNzaW9uSWQpKSByZXR1cm4gZmFsc2U7XG4gIGlmICh2LnJ1bklkICE9PSB1bmRlZmluZWQgJiYgIWlzTm9uRW1wdHlTdHJpbmcodi5ydW5JZCkpIHJldHVybiBmYWxzZTtcbiAgaWYgKHYucmVjb3ZlcnlBY3Rpb24gIT09IHVuZGVmaW5lZCAmJiAhUkVDT1ZFUllfQUNUSU9OUy5pbmNsdWRlcyh2LnJlY292ZXJ5QWN0aW9uIGFzIG5ldmVyKSkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzUnVuU3RhdHVzKHY6IHVua25vd24pOiB2IGlzIFJ1blN0YXR1cyB7XG4gIHJldHVybiB0eXBlb2YgdiA9PT0gJ3N0cmluZycgJiYgUlVOX1NUQVRVU0VTLmluY2x1ZGVzKHYgYXMgUnVuU3RhdHVzKTtcbn1cblxuLyoqIEhvc3QgXHU1RjE1XHU1QkZDXHU4ODRDKHN0ZG91dCBcdTdCMkNcdTRFMDBcdTg4NEMpXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gaXNIb3N0UmVhZHlMaW5lKHY6IHVua25vd24pOiB2IGlzIHsgaG1oRGVza3RvcEhvc3RSZWFkeTogdHJ1ZTsgcG9ydDogbnVtYmVyOyB2ZXJzaW9uOiBzdHJpbmcgfSB7XG4gIGlmICghaXNSZWNvcmQodikpIHJldHVybiBmYWxzZTtcbiAgaWYgKHYuaG1oRGVza3RvcEhvc3RSZWFkeSAhPT0gdHJ1ZSkgcmV0dXJuIGZhbHNlO1xuICBpZiAodHlwZW9mIHYucG9ydCAhPT0gJ251bWJlcicgfHwgIU51bWJlci5pc0ludGVnZXIodi5wb3J0KSB8fCB2LnBvcnQgPD0gMCB8fCB2LnBvcnQgPiA2NTUzNSkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gaXNOb25FbXB0eVN0cmluZyh2LnZlcnNpb24pO1xufVxuIiwgIi8qKlxuICogRGVza3RvcEhvc3RDbGllbnQgXHUyMDE0IFx1NUJGOSBobWggaG9zdCBcdTc2ODQgSFRUUCtTU0UgXHU1QkEyXHU2MjM3XHU3QUVGXHUzMDAyXG4gKlxuICogLSBcdTZCQ0ZcdTRFMkEgSFRUUCBcdThCRjdcdTZDNDJcdTgxRUFcdTUyQThcdTVFMjYgWC1IbWgtS2V5KHRva2VuIFx1NEUwRFx1OEZEQiBVUkwpO1xuICogLSBcdTdFRDNcdTY3ODRcdTUzMTZcdTk1MTlcdThCRUYocmVzLmJvZHkgXHU5MUNDXHU3Njg0IERlc2t0b3BFcnJvciBcdTVGNjJcdTcyQjZcdTYyMTYgSFRUUCBcdTcyQjZcdTYwMDEpXHU4OUM0XHU3RUE2XHU2MjEwXHU1RjAyXHU1RTM4XHU2MjlCXHU1MUZBO1xuICogLSBTU0UgXHU3NTI4IGZldGNoIFx1NkQ0MVx1NjI0Qlx1NTE5OVx1ODlFM1x1Njc5MChpZC9ldmVudC9kYXRhIFx1NUUyNyksXHU2NTJGXHU2MzAxIExhc3QtRXZlbnQtSUQgXHU4ODY1XHU2MkM5XHU5MUNEXHU4RkRFXHUzMDAyXG4gKi9cbmltcG9ydCB7IGRlc2t0b3BFcnJvciwgaXNEZXNrdG9wRXJyb3IsIGlzRXZlbnRFbnZlbG9wZSwgdHlwZSBEZXNrdG9wRXJyb3IsIHR5cGUgRXZlbnRFbnZlbG9wZSB9IGZyb20gJ0BobWgtZGVza3RvcC9jb250cmFjdHMnO1xuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gJ25vZGU6Y3J5cHRvJztcblxuZXhwb3J0IGludGVyZmFjZSBTc2VGcmFtZSB7XG4gIGlkPzogc3RyaW5nO1xuICBldmVudDogc3RyaW5nO1xuICBkYXRhOiBzdHJpbmc7XG59XG5cbi8qKiBcdTg5RTNcdTY3OTBcdTRFMDBcdTZCQjUgU1NFIFx1NjU4N1x1NjcyQ1x1NEUzQVx1NUUyNyhcdTRFMERcdTU0MkJcdThERTggY2h1bmsgXHU3Njg0XHU3RjEzXHU1MUIyXHU5MDNCXHU4RjkxLFx1N0VBRlx1NTFGRFx1NjU3MFx1NEZCRlx1NEU4RVx1NkQ0Qlx1OEJENSlcdTMwMDIgKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVNzZUNodW5rKGNodW5rOiBzdHJpbmcpOiBTc2VGcmFtZVtdIHtcbiAgY29uc3QgZnJhbWVzOiBTc2VGcmFtZVtdID0gW107XG4gIGZvciAoY29uc3QgYmxvY2sgb2YgY2h1bmsuc3BsaXQoL1xcblxcbi8pKSB7XG4gICAgaWYgKCFibG9jay50cmltKCkpIGNvbnRpbnVlO1xuICAgIGxldCBpZDogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAgIGxldCBldmVudCA9ICdtZXNzYWdlJztcbiAgICBjb25zdCBkYXRhTGluZXM6IHN0cmluZ1tdID0gW107XG4gICAgbGV0IHNhd0ZpZWxkID0gZmFsc2U7XG4gICAgZm9yIChjb25zdCBsaW5lIG9mIGJsb2NrLnNwbGl0KCdcXG4nKSkge1xuICAgICAgaWYgKGxpbmUuc3RhcnRzV2l0aCgnOicpKSBjb250aW51ZTsgLy8gXHU2Q0U4XHU5MUNBL1x1NUZDM1x1OERGM1xuICAgICAgaWYgKGxpbmUuc3RhcnRzV2l0aCgnaWQ6JykpIHsgaWQgPSBsaW5lLnNsaWNlKDMpLnRyaW0oKTsgc2F3RmllbGQgPSB0cnVlOyB9XG4gICAgICBlbHNlIGlmIChsaW5lLnN0YXJ0c1dpdGgoJ2V2ZW50OicpKSB7IGV2ZW50ID0gbGluZS5zbGljZSg2KS50cmltKCk7IHNhd0ZpZWxkID0gdHJ1ZTsgfVxuICAgICAgZWxzZSBpZiAobGluZS5zdGFydHNXaXRoKCdkYXRhOicpKSB7IGRhdGFMaW5lcy5wdXNoKGxpbmUuc2xpY2UoNSkucmVwbGFjZSgvXiAvLCAnJykpOyBzYXdGaWVsZCA9IHRydWU7IH1cbiAgICB9XG4gICAgaWYgKCFzYXdGaWVsZCkgY29udGludWU7IC8vIFx1N0VBRlx1NkNFOFx1OTFDQS9cdTVGQzNcdThERjNcdTU3NTdcdTRFMERcdTRFQTdcdTc1MUZcdTVFMjdcbiAgICBmcmFtZXMucHVzaCh7IC4uLihpZCAhPT0gdW5kZWZpbmVkID8geyBpZCB9IDoge30pLCBldmVudCwgZGF0YTogZGF0YUxpbmVzLmpvaW4oJ1xcbicpIH0pO1xuICB9XG4gIHJldHVybiBmcmFtZXM7XG59XG5cbi8qKiBcdTRFQ0UgU1NFIFx1NUUyN1x1NjU3MFx1NjM2RVx1NEUyRFx1ODlFM1x1NTFGQVx1NTQwOFx1NkNENSBFdmVudEVudmVsb3BlO1x1NEUwRFx1NTQwOFx1NkNENVx1NzY4NFx1OEZENFx1NTZERSBudWxsKFNDSEVNQV9NSVNNQVRDSCBcdTc1MzFcdThDMDNcdTc1MjhcdTY1QjlcdThCQTFcdTY1NzApXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gZW52ZWxvcGVGcm9tRnJhbWUoZnJhbWU6IFNzZUZyYW1lKTogRXZlbnRFbnZlbG9wZSB8IG51bGwge1xuICBpZiAoZnJhbWUuZXZlbnQgIT09ICdobWgnKSByZXR1cm4gbnVsbDsgLy8gXHU2MjExXHU0RUVDXHU3Njg0XHU0RThCXHU0RUY2XHU0RkUxXHU1QzAxXHU3RURGXHU0RTAwXHU4RDcwIGV2ZW50OiBobWhcbiAgdHJ5IHtcbiAgICBjb25zdCBwYXJzZWQ6IHVua25vd24gPSBKU09OLnBhcnNlKGZyYW1lLmRhdGEpO1xuICAgIHJldHVybiBpc0V2ZW50RW52ZWxvcGUocGFyc2VkKSA/IHBhcnNlZCA6IG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbmV4cG9ydCBjbGFzcyBEZXNrdG9wSHR0cEVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICBjb25zdHJ1Y3RvcihwdWJsaWMgcmVhZG9ubHkgZGV0YWlsOiBEZXNrdG9wRXJyb3IpIHtcbiAgICBzdXBlcihkZXRhaWwubWVzc2FnZSk7XG4gIH1cbn1cblxuZXhwb3J0IGNsYXNzIERlc2t0b3BIb3N0Q2xpZW50IHtcbiAgY29uc3RydWN0b3IoXG4gICAgcHJpdmF0ZSByZWFkb25seSBiYXNlVXJsOiBzdHJpbmcsXG4gICAgcHJpdmF0ZSByZWFkb25seSB0b2tlbjogc3RyaW5nLFxuICApIHt9XG5cbiAgcHJpdmF0ZSBoZWFkZXJzKGV4dHJhOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge30pOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IHtcbiAgICByZXR1cm4geyAneC1obWgta2V5JzogdGhpcy50b2tlbiwgLi4uZXh0cmEgfTtcbiAgfVxuXG4gIGFzeW5jIGdldEpzb248VD4ocGF0aDogc3RyaW5nLCB0aW1lb3V0TXMgPSA1XzAwMCk6IFByb21pc2U8VD4ge1xuICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgIHRyeSB7XG4gICAgICByZXMgPSBhd2FpdCBmZXRjaChgJHt0aGlzLmJhc2VVcmx9JHtwYXRofWAsIHsgaGVhZGVyczogdGhpcy5oZWFkZXJzKCksIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCh0aW1lb3V0TXMpIH0pO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGByZXF1ZXN0IGZhaWxlZDogJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxNjApfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy5wYXJzZVJlc3BvbnNlPFQ+KHJlcyk7XG4gIH1cblxuICAvKiogXHU2MkM5XHU1M0Q2XHU3RUFGXHU2NTg3XHU2NzJDXHU3QUVGXHU3MEI5KFx1NTk4MiAvYXBpL3Nlc3Npb25zLzppZC9leHBvcnQubWQpXHUzMDAyICovXG4gIGFzeW5jIGdldFRleHQocGF0aDogc3RyaW5nLCB0aW1lb3V0TXMgPSAxMF8wMDApOiBQcm9taXNlPHN0cmluZz4ge1xuICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgIHRyeSB7XG4gICAgICByZXMgPSBhd2FpdCBmZXRjaChgJHt0aGlzLmJhc2VVcmx9JHtwYXRofWAsIHsgaGVhZGVyczogdGhpcy5oZWFkZXJzKCksIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCh0aW1lb3V0TXMpIH0pO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGByZXF1ZXN0IGZhaWxlZDogJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxNjApfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICBpZiAocmVzLnN0YXR1cyA9PT0gNDAxIHx8IHJlcy5zdGF0dXMgPT09IDQwMykge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdBVVRIX0ZBSUxFRCcsIGBob3N0IHJlamVjdGVkIHRoZSBzZXNzaW9uIHRva2VuIChIVFRQICR7cmVzLnN0YXR1c30pYCwgeyByZXRyeWFibGU6IGZhbHNlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICBpZiAoIXJlcy5vaykge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBIVFRQICR7cmVzLnN0YXR1c31gLCB7IHJldHJ5YWJsZTogcmVzLnN0YXR1cyA+PSA1MDAgfSkpO1xuICAgIH1cbiAgICByZXR1cm4gcmVzLnRleHQoKTtcbiAgfVxuXG4gIC8qKiBcdTZCQ0ZcdTRFMkFcdTVFMjZcdTUyNkZcdTRGNUNcdTc1MjhcdTc2ODQgUE9TVCBcdTgxRUFcdTUyQThcdTY0M0FcdTVFMjZcdTVFNDJcdTdCNDlcdTk1MkUoMDMgXHUwMEE3XHU1NkRCXHU5NjMyXHU5MUNEXHU2NTNFOlx1OEJGN1x1NkM0Mlx1NEY3Rlx1NzUyOCBpZGVtcG90ZW5jeUtleTtcbiAgICogIHJ1bnRpbWUgXHU0RkE3XHU3N0VEXHU2NzFGXHU1MTdDXHU1QkI5XHU1RkZEXHU3NTY1LFx1NTM0Rlx1OEJBRVx1NTE0OFx1ODg0Q1x1MjAxNFx1MjAxNFx1OTFDRFx1OEJENVx1NTNFRlx1NTFFRFx1OTUyRVx1NTNCQlx1OTFDRCxcdTRFMERcdTc2RjJcdTc2RUVcdTkxQ0RcdTY1M0UpXHUzMDAyICovXG4gIGFzeW5jIHBvc3RKc29uPFQ+KHBhdGg6IHN0cmluZywgYm9keTogdW5rbm93biwgdGltZW91dE1zID0gMTBfMDAwKTogUHJvbWlzZTxUPiB7XG4gICAgbGV0IHJlczogUmVzcG9uc2U7XG4gICAgdHJ5IHtcbiAgICAgIHJlcyA9IGF3YWl0IGZldGNoKGAke3RoaXMuYmFzZVVybH0ke3BhdGh9YCwge1xuICAgICAgICBtZXRob2Q6ICdQT1NUJyxcbiAgICAgICAgaGVhZGVyczogdGhpcy5oZWFkZXJzKHtcbiAgICAgICAgICAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgICAgICAgICd4LWlkZW1wb3RlbmN5LWtleSc6IHJhbmRvbVVVSUQoKSxcbiAgICAgICAgfSksXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpLFxuICAgICAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQodGltZW91dE1zKSxcbiAgICAgIH0pO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGByZXF1ZXN0IGZhaWxlZDogJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxNjApfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy5wYXJzZVJlc3BvbnNlPFQ+KHJlcyk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHBhcnNlUmVzcG9uc2U8VD4ocmVzOiBSZXNwb25zZSk6IFByb21pc2U8VD4ge1xuICAgIGlmIChyZXMuc3RhdHVzID09PSA0MDEgfHwgcmVzLnN0YXR1cyA9PT0gNDAzKSB7XG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgYGhvc3QgcmVqZWN0ZWQgdGhlIHNlc3Npb24gdG9rZW4gKEhUVFAgJHtyZXMuc3RhdHVzfSlgLCB7IHJldHJ5YWJsZTogZmFsc2UsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XG4gICAgfVxuICAgIGNvbnN0IHRleHQgPSBhd2FpdCByZXMudGV4dCgpO1xuICAgIGxldCBwYXJzZWQ6IHVua25vd24gPSBudWxsO1xuICAgIHRyeSB7XG4gICAgICBwYXJzZWQgPSB0ZXh0ID8gSlNPTi5wYXJzZSh0ZXh0KSA6IG51bGw7XG4gICAgfSBjYXRjaCB7XG4gICAgICBwYXJzZWQgPSBudWxsO1xuICAgIH1cbiAgICBpZiAoIXJlcy5vaykge1xuICAgICAgaWYgKGlzRGVza3RvcEVycm9yKHBhcnNlZCkpIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKHBhcnNlZCk7XG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYEhUVFAgJHtyZXMuc3RhdHVzfTogJHt0ZXh0LnNsaWNlKDAsIDE2MCl9YCwgeyByZXRyeWFibGU6IHJlcy5zdGF0dXMgPj0gNTAwIH0pKTtcbiAgICB9XG4gICAgcmV0dXJuIHBhcnNlZCBhcyBUO1xuICB9XG5cbiAgLyoqXG4gICAqIFx1OEJBMlx1OTYwNVx1NTE2OFx1OTBFOCBTU0UgXHU1RTI3KFx1NTQyQlx1OTc1RVx1NEZFMVx1NUMwMVx1NEU4Qlx1NEVGNjpkZWx0YS9saW5lIFx1N0I0OVx1OUFEOFx1OTg5MVx1NkQ0MSlcdTMwMDJcdTRGRTFcdTVDMDFcdTc1MzFcdThDMDNcdTc1MjhcdTY1QjlcbiAgICogXHU3NTI4IGVudmVsb3BlRnJvbUZyYW1lIFx1ODFFQVx1ODg0Q1x1NTIwNlx1NkQ0MTtcdTY1QURcdTdFQkZcdTkxQ0RcdThGREVcdThCRURcdTRFNDlcdTU0MEMgZXZlbnRzKClcdTMwMDJcbiAgICovXG4gIGFzeW5jICpyYXdFdmVudHMobGFzdEV2ZW50SWQ/OiBzdHJpbmcsIHNpZ25hbD86IEFib3J0U2lnbmFsKTogQXN5bmNHZW5lcmF0b3I8U3NlRnJhbWU+IHtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgJHt0aGlzLmJhc2VVcmx9L2FwaS9ldmVudHNgLCB7XG4gICAgICBoZWFkZXJzOiB0aGlzLmhlYWRlcnMoe1xuICAgICAgICBhY2NlcHQ6ICd0ZXh0L2V2ZW50LXN0cmVhbScsXG4gICAgICAgIC4uLihsYXN0RXZlbnRJZCAhPT0gdW5kZWZpbmVkID8geyAnbGFzdC1ldmVudC1pZCc6IGxhc3RFdmVudElkIH0gOiB7fSksXG4gICAgICB9KSxcbiAgICAgIC4uLihzaWduYWwgIT09IHVuZGVmaW5lZCA/IHsgc2lnbmFsIH0gOiB7fSksXG4gICAgfSk7XG4gICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSB8fCByZXMuc3RhdHVzID09PSA0MDMpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignQVVUSF9GQUlMRUQnLCBgaG9zdCByZWplY3RlZCB0aGUgc2Vzc2lvbiB0b2tlbiAoSFRUUCAke3Jlcy5zdGF0dXN9KWAsIHsgcmV0cnlhYmxlOiBmYWxzZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcbiAgICB9XG4gICAgaWYgKCFyZXMub2sgfHwgcmVzLmJvZHkgPT09IG51bGwpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgU1NFIEhUVFAgJHtyZXMuc3RhdHVzfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICBjb25zdCByZWFkZXIgPSByZXMuYm9keS5nZXRSZWFkZXIoKTtcbiAgICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKCk7XG4gICAgbGV0IGJ1ZmZlciA9ICcnO1xuICAgIGZvciAoOzspIHtcbiAgICAgIGNvbnN0IHsgZG9uZSwgdmFsdWUgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICBpZiAoZG9uZSkgcmV0dXJuO1xuICAgICAgYnVmZmVyICs9IGRlY29kZXIuZGVjb2RlKHZhbHVlLCB7IHN0cmVhbTogdHJ1ZSB9KTtcbiAgICAgIGxldCBpZHg6IG51bWJlcjtcbiAgICAgIHdoaWxlICgoaWR4ID0gYnVmZmVyLmluZGV4T2YoJ1xcblxcbicpKSAhPT0gLTEpIHtcbiAgICAgICAgY29uc3QgYmxvY2sgPSBidWZmZXIuc2xpY2UoMCwgaWR4KTtcbiAgICAgICAgYnVmZmVyID0gYnVmZmVyLnNsaWNlKGlkeCArIDIpO1xuICAgICAgICBmb3IgKGNvbnN0IGZyYW1lIG9mIHBhcnNlU3NlQ2h1bmsoYmxvY2spKSB5aWVsZCBmcmFtZTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogXHU4QkEyXHU5NjA1IFNTRSBcdTRFOEJcdTRFRjZcdTZENDEoYXN5bmMgaXRlcmF0b3IpXHUzMDAyXHU2NUFEXHU3RUJGXHU3NTMxXHU4QzAzXHU3NTI4XHU2NUI5XHU5MUNEXHU4RkRFO1x1OTFDRFx1OEZERVx1NjVGNlx1NjI4QVx1NjcwMFx1NTQwRVxuICAgKiBcdTY1MzZcdTUyMzBcdTc2ODQgZXZlbnRJZCBcdTRGMjBcdTUxNjUgbGFzdEV2ZW50SWQsaG9zdCBcdTdBRUZcdTRFQ0VcdTkxQ0RcdTY1M0VcdTczQUZcdTg4NjVcdTUzRDFcdTMwMDJcbiAgICovXG4gIGFzeW5jICpldmVudHMobGFzdEV2ZW50SWQ/OiBzdHJpbmcsIHNpZ25hbD86IEFib3J0U2lnbmFsKTogQXN5bmNHZW5lcmF0b3I8RXZlbnRFbnZlbG9wZT4ge1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGAke3RoaXMuYmFzZVVybH0vYXBpL2V2ZW50c2AsIHtcbiAgICAgIGhlYWRlcnM6IHRoaXMuaGVhZGVycyh7XG4gICAgICAgIGFjY2VwdDogJ3RleHQvZXZlbnQtc3RyZWFtJyxcbiAgICAgICAgLi4uKGxhc3RFdmVudElkICE9PSB1bmRlZmluZWQgPyB7ICdsYXN0LWV2ZW50LWlkJzogbGFzdEV2ZW50SWQgfSA6IHt9KSxcbiAgICAgIH0pLFxuICAgICAgLi4uKHNpZ25hbCAhPT0gdW5kZWZpbmVkID8geyBzaWduYWwgfSA6IHt9KSxcbiAgICB9KTtcbiAgICBpZiAocmVzLnN0YXR1cyA9PT0gNDAxIHx8IHJlcy5zdGF0dXMgPT09IDQwMykge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdBVVRIX0ZBSUxFRCcsIGBob3N0IHJlamVjdGVkIHRoZSBzZXNzaW9uIHRva2VuIChIVFRQICR7cmVzLnN0YXR1c30pYCwgeyByZXRyeWFibGU6IGZhbHNlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICBpZiAoIXJlcy5vayB8fCAhcmVzLmJvZHkpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgU1NFIEhUVFAgJHtyZXMuc3RhdHVzfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICBjb25zdCByZWFkZXIgPSByZXMuYm9keS5nZXRSZWFkZXIoKTtcbiAgICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKCk7XG4gICAgbGV0IGJ1ZmZlciA9ICcnO1xuICAgIGZvciAoOzspIHtcbiAgICAgIGNvbnN0IHsgZG9uZSwgdmFsdWUgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICBpZiAoZG9uZSkgcmV0dXJuO1xuICAgICAgYnVmZmVyICs9IGRlY29kZXIuZGVjb2RlKHZhbHVlLCB7IHN0cmVhbTogdHJ1ZSB9KTtcbiAgICAgIC8vIFx1NEVFNVx1N0E3QVx1ODg0Q1x1NTIwNlx1NUUyNztcdTRGRERcdTc1NTlcdTRFMERcdTVCOENcdTY1NzRcdTc2ODRcdTVDM0VcdTkwRThcbiAgICAgIGxldCBpZHg6IG51bWJlcjtcbiAgICAgIHdoaWxlICgoaWR4ID0gYnVmZmVyLmluZGV4T2YoJ1xcblxcbicpKSAhPT0gLTEpIHtcbiAgICAgICAgY29uc3QgYmxvY2sgPSBidWZmZXIuc2xpY2UoMCwgaWR4KTtcbiAgICAgICAgYnVmZmVyID0gYnVmZmVyLnNsaWNlKGlkeCArIDIpO1xuICAgICAgICBmb3IgKGNvbnN0IGZyYW1lIG9mIHBhcnNlU3NlQ2h1bmsoYmxvY2spKSB7XG4gICAgICAgICAgY29uc3QgZW52ID0gZW52ZWxvcGVGcm9tRnJhbWUoZnJhbWUpO1xuICAgICAgICAgIGlmIChlbnYgIT09IG51bGwpIHlpZWxkIGVudjtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxufVxuIiwgIi8qKlxuICogZmFrZSBob3N0IFx1MjAxNCBobWhhcm5lc3MgcnVudGltZSBcdTc2ODRcdTZENEJcdThCRDVcdTY2RkZcdThFQUIoTWFzdGVyUHJvbXB0IFx1OTYzNlx1NkJCNSBEL0U6XG4gKiBcIlx1NTE0OFx1NEY3Rlx1NzUyOCBmYWtlIGhvc3QgXHU3RjE2XHU1MTk5XHU3MkI2XHU2MDAxXHU2NzNBXHU2RDRCXHU4QkQ1LFx1NTE4RFx1NjNBNVx1NzcxRlx1NUI5RSBBUElcIjtcdTk2MzZcdTZCQjUgRSBcdTc2ODRcdTRGMUFcdThCRERcdTdFQjVcdTUyMDdcdTcyNDdcbiAqIGUyZSBcdTRFNUZcdTUxNDhcdTU3MjggZmFrZSBcdTVDNDJcdTk1RURcdTczQUYpXHUzMDAyXG4gKlxuICogXHU2ODRDXHU5NzYyIGhvc3QgXHU1NDA4XHU1NDBDOlxuICogIC0gXHU1M0VBXHU3RUQxIDEyNy4wLjAuMSxcdTdBRUZcdTUzRTMgT1MgXHU1MjA2XHU5MTRELFx1NUI5RVx1OTY0NVx1N0FFRlx1NTNFM1x1NTE5OSBzdGRvdXQgXHU1RjE1XHU1QkZDXHU4ODRDO1xuICogIC0gXHU2MjQwXHU2NzA5IC9hcGkvKiBcdTg5ODFcdTZDNDIgWC1IbWgtS2V5ID09PSBITUhfREVTS1RPUF9UT0tFTixcdTU0MjZcdTUyMTkgNDAxICsgRGVza3RvcEVycm9yO1xuICogIC0gR0VUIC9hcGkvc3RhdGUgXHU1MDY1XHU1RUI3XHU2M0EyXHU2RDRCO0dFVCAvYXBpL2V2ZW50cyBTU0UoZXZlbnQ6IGhtaCBcdTRGRTFcdTVDMDFcdTZENDEgKyBcdTkxQ0RcdTY1M0VcdTczQUYpO1xuICogIC0gUE9TVCAvYXBpL2Rlc2t0b3Avc2h1dGRvd24gXHU0RjE4XHU5NkM1XHU5MDAwXHU1MUZBXHUzMDAyXG4gKlxuICogXHU5NjM2XHU2QkI1IEUgXHU2QTIxXHU2MkRGXHU5NzYyKFx1NEUwRSBobWhhcm5lc3MgZGVza3RvcCBcdTZBMjFcdTVGMEZcdTU0MENcdTVGNjIpOlxuICogIC0gUE9TVCAvYXBpL3Rhc2sge3RleHQsIHNlc3Npb25JZCwgbW9kZX06XHU2MzkyXHU5NjFGXHU1RTc2XHU2MzA5XHU4MTFBXHU2NzJDXHU1M0QxXG4gKiAgICBydW4uc3RhcnRlZCBcdTIxOTIgdG9vbC5zdGFydGVkL2NvbXBsZXRlZCBcdTIxOTIobW9kZT09PSdhc2snIFx1NjVGNilcbiAqICAgIGFwcHJvdmFsLnJlcXVpcmVkKFx1N0I0OSAvYXBpL2FwcHJvdmUpXHUyMTkyIHJ1bi5jb21wbGV0ZWQ7XG4gKiAgLSBQT1NUIC9hcGkvYXBwcm92ZSB7Z3JhbnRlZCwgc2Vzc2lvbklkfTtcbiAqICAtIFBPU1QgL2FwaS9pbnRlcnJ1cHQge3Nlc3Npb25JZH07XG4gKiAgLSBHRVQgL2FwaS9zZXNzaW9uc1x1MzAwMlxuICpcbiAqIFx1NkQ0Qlx1OEJENVx1OTRBOVx1NUI1MDpGQUtFX0hPU1RfRElFX0FGVEVSX01TIC8gRkFLRV9IT1NUX0RJRV9BVF9CT09UIC9cbiAqIEZBS0VfSE9TVF9FWFBFQ1RfVE9LRU4gLyBGQUtFX0hPU1RfVEFTS19ERUxBWV9NUyAvIEZBS0VfSE9TVF9UQVNLX0ZBSUw9MVxuICogKFx1NEVGQlx1NTJBMVx1NEVFNSBydW4uZmFpbGVkIFx1N0VEM1x1Njc1RixcdTY3ODRcdTkwMjBcdTk1MTlcdThCRUZcdTYwNjJcdTU5MERcdTU3M0FcdTY2NkYpXHUzMDAyXG4gKi9cbmltcG9ydCB7IGNyZWF0ZVNlcnZlciwgdHlwZSBTZXJ2ZXJSZXNwb25zZSB9IGZyb20gJ25vZGU6aHR0cCc7XG5pbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSAnbm9kZTpjcnlwdG8nO1xuaW1wb3J0IHsgcGF0aFRvRmlsZVVSTCB9IGZyb20gJ25vZGU6dXJsJztcbmltcG9ydCB7IHJlYWxwYXRoU3luYyB9IGZyb20gJ25vZGU6ZnMnO1xuaW1wb3J0IHsgRVZFTlRfU0NIRU1BX1ZFUlNJT04sIGRlc2t0b3BFcnJvciwgdHlwZSBFdmVudEVudmVsb3BlLCB0eXBlIEV2ZW50S2luZCB9IGZyb20gJ0BobWgtZGVza3RvcC9jb250cmFjdHMnO1xuXG5leHBvcnQgaW50ZXJmYWNlIEZha2VIb3N0SGFuZGxlIHtcbiAgcG9ydDogbnVtYmVyO1xuICBlbWl0KHNlc3Npb25JZDogc3RyaW5nLCBydW5JZDogc3RyaW5nLCBraW5kOiBFdmVudEtpbmQsIHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogbnVtYmVyO1xuICBjbG9zZSgpOiBQcm9taXNlPHZvaWQ+O1xufVxuXG5pbnRlcmZhY2UgRmFrZVNlc3Npb24ge1xuICBpZDogc3RyaW5nO1xuICBjcmVhdGVkQXQ6IHN0cmluZztcbiAgdXBkYXRlZEF0OiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBQZW5kaW5nQXBwcm92YWwge1xuICBzZXNzaW9uSWQ6IHN0cmluZztcbiAgYXBwcm92YWxJZDogc3RyaW5nO1xuICByZXNvbHZlKGdyYW50ZWQ6IGJvb2xlYW4pOiB2b2lkO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc3RhcnRGYWtlSG9zdChvcHRzOiB7IHRva2VuOiBzdHJpbmc7IHF1aWV0PzogYm9vbGVhbiB9KTogUHJvbWlzZTxGYWtlSG9zdEhhbmRsZT4ge1xuICBjb25zdCB0b2tlbiA9IG9wdHMudG9rZW47XG4gIC8vIFx1NkQ0Qlx1OEJENVx1OTRBOVx1NUI1MDpGQUtFX0hPU1RfRVhQRUNUX1RPS0VOIFx1OEJBOSBob3N0IFx1NjgyMVx1OUE4Q1x1NEUwMFx1NEUyQVx1NEUwRSBITUhfREVTS1RPUF9UT0tFTlxuICAvLyBcdTRFMERcdTU0MENcdTc2ODRcdTUwM0MoXHU2Nzg0XHU5MDIwIEFVVEhfRkFJTEVEIFx1NTczQVx1NjY2RjtzdXBlcnZpc29yIFx1NjAzQlx1NjYyRlx1ODk4Nlx1NzZENiBITUhfREVTS1RPUF9UT0tFTilcbiAgY29uc3QgZXhwZWN0ZWQgPSBwcm9jZXNzLmVudi5GQUtFX0hPU1RfRVhQRUNUX1RPS0VOID8/IHRva2VuO1xuICBjb25zdCB0YXNrRGVsYXkgPSBOdW1iZXIocHJvY2Vzcy5lbnYuRkFLRV9IT1NUX1RBU0tfREVMQVlfTVMgPz8gMzApO1xuICBjb25zdCBmYWlsVGFza3MgPSBwcm9jZXNzLmVudi5GQUtFX0hPU1RfVEFTS19GQUlMID09PSAnMSc7XG5cbiAgY29uc3Qgc3NlQ2xpZW50cyA9IG5ldyBTZXQ8U2VydmVyUmVzcG9uc2U+KCk7XG4gIGNvbnN0IHNlcUJ5UnVuID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgLy8gXHU5MUNEXHU2NTNFXHU3M0FGOlx1NjcwMFx1OEZEMSAyMDAgXHU1RTI3KExhc3QtRXZlbnQtSUQgXHU2NUFEXHU3RUJGXHU4ODY1XHU2MkM5KSxcdTRFMEUgaG1oYXJuZXNzIHdlYiBcdTU0MENcdTZCM0VcdThCRURcdTRFNDlcbiAgY29uc3QgcmluZzogQXJyYXk8eyBpZDogbnVtYmVyOyBldmVudDogc3RyaW5nOyBkYXRhOiB1bmtub3duIH0+ID0gW107XG4gIGxldCByaW5nU2VxID0gMDtcbiAgY29uc3Qgc2Vzc2lvbnMgPSBuZXcgTWFwPHN0cmluZywgRmFrZVNlc3Npb24+KCk7XG4gIGxldCBwZW5kaW5nOiBQZW5kaW5nQXBwcm92YWwgfCBudWxsID0gbnVsbDtcbiAgY29uc3QgcnVuVGltZXJzID0gbmV3IE1hcDxzdHJpbmcsIE5vZGVKUy5UaW1lb3V0PigpO1xuICAvLyBcdTVERTVcdTRGNUNcdTUzM0EvUHJvdmlkZXIgXHU3MkI2XHU2MDAxKFx1NEUwRSBobWhhcm5lc3MgXHU1NDBDXHU1RjYyXHU3Njg0XHU2NzAwXHU1QzBGXHU2QTIxXHU2MkRGKVxuICBjb25zdCBmYWtlV29ya3NwYWNlcyA9IHtcbiAgICBjdXJyZW50OiAnd3MtZGVtbycsXG4gICAgaXRlbXM6IFtcbiAgICAgIHsgaWQ6ICd3cy1kZW1vJywgbmFtZTogJ2RlbW8td29ya3NwYWNlJywgcGF0aDogJ0M6XFxcXGRlbW8nIH0sXG4gICAgXSxcbiAgfTtcbiAgY29uc3QgZmFrZVByb3ZpZGVycyA9IG5ldyBNYXA8c3RyaW5nLCB7IGJhc2VVcmw6IHN0cmluZzsgbW9kZWw6IHN0cmluZzsgYXBpS2V5OiBzdHJpbmcgfT4oW1xuICAgIFsnZGVtbycsIHsgYmFzZVVybDogJ2h0dHA6Ly8xMjcuMC4wLjE6OS92MScsIG1vZGVsOiAnZmFrZS1tJywgYXBpS2V5OiAnc2stZGVtby0xMjM0JyB9XSxcbiAgICBbJ2RlbW8tdmlzaW9uJywgeyBiYXNlVXJsOiAnaHR0cDovLzEyNy4wLjAuMTo5L3YxJywgbW9kZWw6ICdmYWtlLW0tdmlzaW9uJywgYXBpS2V5OiAnc2stZGVtby01Njc4JyB9XSxcbiAgXSk7XG4gIGxldCBmYWtlQ2hhdFByb3ZpZGVyID0gJ2RlbW8nO1xuXG4gIGNvbnN0IGVtaXQgPSAoc2Vzc2lvbklkOiBzdHJpbmcsIHJ1bklkOiBzdHJpbmcsIGtpbmQ6IEV2ZW50S2luZCwgcGF5bG9hZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBudW1iZXIgPT4ge1xuICAgIGNvbnN0IGtleSA9IGAke3Nlc3Npb25JZH1cXDAke3J1bklkfWA7XG4gICAgY29uc3Qgc2VxID0gKHNlcUJ5UnVuLmdldChrZXkpID8/IDApICsgMTtcbiAgICBzZXFCeVJ1bi5zZXQoa2V5LCBzZXEpO1xuICAgIGNvbnN0IGVudjogRXZlbnRFbnZlbG9wZSA9IHtcbiAgICAgIHNjaGVtYVZlcnNpb246IEVWRU5UX1NDSEVNQV9WRVJTSU9OLFxuICAgICAgZXZlbnRJZDogcmFuZG9tVVVJRCgpLFxuICAgICAgc2Vzc2lvbklkLFxuICAgICAgcnVuSWQsXG4gICAgICBzZXEsXG4gICAgICBvY2N1cnJlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICBraW5kLFxuICAgICAgcGF5bG9hZCxcbiAgICB9O1xuICAgIGNvbnN0IGlkID0gKytyaW5nU2VxO1xuICAgIHJpbmcucHVzaCh7IGlkLCBldmVudDogJ2htaCcsIGRhdGE6IGVudiB9KTtcbiAgICBpZiAocmluZy5sZW5ndGggPiAyMDApIHJpbmcuc3BsaWNlKDAsIHJpbmcubGVuZ3RoIC0gMjAwKTtcbiAgICBmb3IgKGNvbnN0IGMgb2Ygc3NlQ2xpZW50cykge1xuICAgICAgYy53cml0ZShgaWQ6ICR7aWR9XFxuZXZlbnQ6IGhtaFxcbmRhdGE6ICR7SlNPTi5zdHJpbmdpZnkoZW52KX1cXG5cXG5gKTtcbiAgICB9XG4gICAgcmV0dXJuIHNlcTtcbiAgfTtcblxuICBjb25zdCB0b3VjaCA9IChzZXNzaW9uSWQ6IHN0cmluZyk6IEZha2VTZXNzaW9uID0+IHtcbiAgICBsZXQgcyA9IHNlc3Npb25zLmdldChzZXNzaW9uSWQpO1xuICAgIGlmIChzID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHMgPSB7IGlkOiBzZXNzaW9uSWQsIGNyZWF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLCB1cGRhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSB9O1xuICAgICAgc2Vzc2lvbnMuc2V0KHNlc3Npb25JZCwgcyk7XG4gICAgfVxuICAgIHMudXBkYXRlZEF0ID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuICAgIHJldHVybiBzO1xuICB9O1xuXG4gIC8qKiBcdTZBMjFcdTYyREZcdTRFMDBcdTZCMjFcdTRFRkJcdTUyQTE6XHU2Mjc5XHU1MUM2XHU2QTIxXHU1RjBGXHU2MzAyXHU4RDc3XHU3QjQ5XHU1Rjg1IC9hcGkvYXBwcm92ZVx1MzAwMiAqL1xuICBjb25zdCBydW5UYXNrID0gKHNlc3Npb25JZDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcsIG1vZGU6IHN0cmluZyk6IHN0cmluZyA9PiB7XG4gICAgY29uc3QgcnVuSWQgPSBgcnVuLSR7RGF0ZS5ub3coKS50b1N0cmluZygzNil9LSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMiwgOCl9YDtcbiAgICB0b3VjaChzZXNzaW9uSWQpO1xuICAgIGNvbnN0IHN0ZXBzOiBBcnJheTwoKSA9PiB2b2lkPiA9IFtdO1xuICAgIGNvbnN0IHdhaXQgPSAoZm46ICgpID0+IHZvaWQsIG1zID0gdGFza0RlbGF5KTogdm9pZCA9PiB7XG4gICAgICBjb25zdCB0ID0gc2V0VGltZW91dChmbiwgbXMpO1xuICAgICAgcnVuVGltZXJzLnNldChgJHtzZXNzaW9uSWR9XFwwJHtydW5JZH1gLCB0KTtcbiAgICB9O1xuICAgIGNvbnN0IGNoYWluID0gKGZuczogQXJyYXk8KCkgPT4gdm9pZD4pOiB2b2lkID0+IHtcbiAgICAgIGNvbnN0IFtmaXJzdCwgLi4ucmVzdF0gPSBmbnM7XG4gICAgICBpZiAoZmlyc3QgPT09IHVuZGVmaW5lZCkgcmV0dXJuO1xuICAgICAgd2FpdCgoKSA9PiB7XG4gICAgICAgIGZpcnN0KCk7XG4gICAgICAgIGNoYWluKHJlc3QpO1xuICAgICAgfSk7XG4gICAgfTtcblxuICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ3J1bi5zdGFydGVkJywgeyB0YXNrOiB0ZXh0LCBtb2RlIH0pO1xuICAgIGlmIChmYWlsVGFza3MpIHtcbiAgICAgIHdhaXQoKCkgPT4gZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAncnVuLmZhaWxlZCcsIHtcbiAgICAgICAgZXJyb3I6IHsgY29kZTogJ0FVVEhfRkFJTEVEJywgbWVzc2FnZTogJ3NpbXVsYXRlZCBwcm92aWRlciBhdXRoIGZhaWx1cmUnLCByZXRyeWFibGU6IGZhbHNlIH0sXG4gICAgICB9KSk7XG4gICAgICByZXR1cm4gcnVuSWQ7XG4gICAgfVxuXG4gICAgY29uc3QgZmluaXNoUnVuID0gKGFuc3dlcjogc3RyaW5nLCB0b29sVXNlczogbnVtYmVyKTogdm9pZCA9PiB7XG4gICAgICBydW5UaW1lcnMuZGVsZXRlKGAke3Nlc3Npb25JZH1cXDAke3J1bklkfWApO1xuICAgICAgLy8gXHU0RUE0XHU0RUQ4XHU3MjY5XHU1MTQ4XHU0RThFXHU3RUM4XHU2MDAxKFx1NEUwRSBobWhhcm5lc3MgZGVza3RvcCBcdTY4NjVcdTU0MENcdTVFOEY6YXJ0aWZhY3QuY3JlYXRlZCBcdTIxOTIgcnVuLmNvbXBsZXRlZClcbiAgICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ2FydGlmYWN0LmNyZWF0ZWQnLCB7XG4gICAgICAgIGFydGlmYWN0OiB7IHJlbFBhdGg6ICdvdXQudHh0Jywga2luZDogJ2ZpbGUnLCB0aXRsZTogJ291dC50eHQnIH0sXG4gICAgICB9KTtcbiAgICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ3J1bi5jb21wbGV0ZWQnLCB7IHRleHQ6IGFuc3dlciwgdHVybnM6IDEsIHRvb2xVc2VzIH0pO1xuICAgIH07XG5cbiAgICBjb25zdCBzY3JpcHRlZDogQXJyYXk8KCkgPT4gdm9pZD4gPSBbXG4gICAgICAoKSA9PiBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICd0b29sLnN0YXJ0ZWQnLCB7IG5hbWU6ICdyZWFkX2ZpbGUnLCBhcmdzUHJldmlldzogJ3tcInBhdGhcIjpcIlJFQURNRS5tZFwifScgfSksXG4gICAgICAoKSA9PiBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICd0b29sLmNvbXBsZXRlZCcsIHsgbmFtZTogJ3JlYWRfZmlsZScsIGlzRXJyb3I6IGZhbHNlLCBvdXRwdXRQcmV2aWV3OiAnIyBkZW1vJyB9KSxcbiAgICBdO1xuXG4gICAgaWYgKG1vZGUgPT09ICdhc2snKSB7XG4gICAgICBzY3JpcHRlZC5wdXNoKCgpID0+IHtcbiAgICAgICAgY29uc3QgYXBwcm92YWxJZCA9IGBhcC0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDgpfWA7XG4gICAgICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ2FwcHJvdmFsLnJlcXVpcmVkJywge1xuICAgICAgICAgIGFwcHJvdmFsSWQsXG4gICAgICAgICAgdG9vbDogJ3dyaXRlX2ZpbGUnLFxuICAgICAgICAgIGFyZ3NQcmV2aWV3OiAne1wicGF0aFwiOlwib3V0LnR4dFwiLFwiY29udGVudFwiOlwiaGlcIn0nLFxuICAgICAgICAgIHJpc2s6ICdcdTUxOTlcdTUxNjVcdTVERTVcdTRGNUNcdTUzM0FcdTY1ODdcdTRFRjYgb3V0LnR4dChcdTZBMjFcdTYyREYpJyxcbiAgICAgICAgfSk7XG4gICAgICAgIHBlbmRpbmcgPSB7XG4gICAgICAgICAgc2Vzc2lvbklkLFxuICAgICAgICAgIGFwcHJvdmFsSWQsXG4gICAgICAgICAgcmVzb2x2ZTogKGdyYW50ZWQpID0+IHtcbiAgICAgICAgICAgIHBlbmRpbmcgPSBudWxsO1xuICAgICAgICAgICAgaWYgKGdyYW50ZWQpIHtcbiAgICAgICAgICAgICAgZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAndG9vbC5zdGFydGVkJywgeyBuYW1lOiAnd3JpdGVfZmlsZScsIGFyZ3NQcmV2aWV3OiAne1wicGF0aFwiOlwib3V0LnR4dFwifScgfSk7XG4gICAgICAgICAgICAgIHdhaXQoKCkgPT4gZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAndG9vbC5jb21wbGV0ZWQnLCB7IG5hbWU6ICd3cml0ZV9maWxlJywgaXNFcnJvcjogZmFsc2UsIG91dHB1dFByZXZpZXc6ICd3cm90ZSAyIGJ5dGVzJyB9KSk7XG4gICAgICAgICAgICAgIHdhaXQoKCkgPT4gZmluaXNoUnVuKGBlY2hvOiAke3RleHR9KFx1NURGMlx1NjI2N1x1ODg0Q1x1NTE5OVx1NTE2NSlgLCAzKSwgdGFza0RlbGF5ICogMik7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICBmaW5pc2hSdW4oYGVjaG86ICR7dGV4dH0oXHU1QkExXHU2Mjc5XHU4OEFCXHU2MkQyXHU3RURELFx1NjcyQVx1NjI2N1x1ODg0Q1x1NTE5OVx1NTE2NSlgLCAxKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9LFxuICAgICAgICB9O1xuICAgICAgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHNjcmlwdGVkLnB1c2goKCkgPT4gZmluaXNoUnVuKGBlY2hvOiAke3RleHR9YCwgMSkpO1xuICAgIH1cbiAgICBjaGFpbihzY3JpcHRlZCk7XG4gICAgcmV0dXJuIHJ1bklkO1xuICB9O1xuXG4gIGNvbnN0IHNlcnZlciA9IGNyZWF0ZVNlcnZlcigocmVxLCByZXMpID0+IHtcbiAgICBjb25zdCB1cmwgPSBuZXcgVVJMKHJlcS51cmwgPz8gJy8nLCAnaHR0cDovLzEyNy4wLjAuMScpO1xuICAgIGNvbnN0IGF1dGhvcml6ZWQgPSByZXEuaGVhZGVyc1sneC1obWgta2V5J10gPT09IGV4cGVjdGVkO1xuICAgIGNvbnN0IGRlbnkgPSAoKTogdm9pZCA9PiB7XG4gICAgICByZXMud3JpdGVIZWFkKDQwMSwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgJ21pc3Npbmcgb3IgaW52YWxpZCB4LWhtaC1rZXknLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICB9O1xuXG4gICAgY29uc3QgcmVhZEJvZHkgPSAoKTogUHJvbWlzZTxzdHJpbmc+ID0+XG4gICAgICBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xuICAgICAgICBsZXQgYiA9ICcnO1xuICAgICAgICByZXEub24oJ2RhdGEnLCAoYzogQnVmZmVyKSA9PiB7IGIgKz0gYy50b1N0cmluZygpOyB9KTtcbiAgICAgICAgcmVxLm9uKCdlbmQnLCAoKSA9PiByZXNvbHZlKGIpKTtcbiAgICAgIH0pO1xuXG4gICAgaWYgKHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZXZlbnRzJykge1xuICAgICAgaWYgKCFhdXRob3JpemVkKSB7IGRlbnkoKTsgcmV0dXJuOyB9XG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ3RleHQvZXZlbnQtc3RyZWFtJywgJ2NhY2hlLWNvbnRyb2wnOiAnbm8tY2FjaGUnLCBjb25uZWN0aW9uOiAna2VlcC1hbGl2ZScgfSk7XG4gICAgICByZXMuZmx1c2hIZWFkZXJzPy4oKTtcbiAgICAgIHNzZUNsaWVudHMuYWRkKHJlcyk7XG4gICAgICAvLyBcdTY1QURcdTdFQkZcdTg4NjVcdTYyQzk6TGFzdC1FdmVudC1JRCBcdTRFNEJcdTUyNERcdTc2ODRcdTVFMjdcdTVERjJcdTU3MjhcdTVCQTJcdTYyMzdcdTdBRUYsXHU5MUNEXHU1M0QxXHU1MTc2XHU1NDBFXHU3Njg0XHU3M0FGXHU1RjYyXHU3RjEzXHU1MUIyXG4gICAgICBjb25zdCBsYXN0SWQgPSBOdW1iZXIocmVxLmhlYWRlcnNbJ2xhc3QtZXZlbnQtaWQnXSA/PyAwKTtcbiAgICAgIGlmIChOdW1iZXIuaXNGaW5pdGUobGFzdElkKSAmJiBsYXN0SWQgPiAwKSB7XG4gICAgICAgIGZvciAoY29uc3QgZSBvZiByaW5nKSB7XG4gICAgICAgICAgaWYgKGUuaWQgPiBsYXN0SWQpIHJlcy53cml0ZShgaWQ6ICR7ZS5pZH1cXG5ldmVudDogJHtlLmV2ZW50fVxcbmRhdGE6ICR7SlNPTi5zdHJpbmdpZnkoZS5kYXRhKX1cXG5cXG5gKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmVxLm9uKCdjbG9zZScsICgpID0+IHNzZUNsaWVudHMuZGVsZXRlKHJlcykpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAoIWF1dGhvcml6ZWQpIHsgZGVueSgpOyByZXR1cm47IH1cblxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3N0YXRlJykge1xuICAgICAgLy8gcHJvdmlkZXJzRGV0YWlsOlx1NEUwRSBobWhhcm5lc3MgXHU1NDBDXHU1RjYyXHUyMDE0XHUyMDE0a2V5IFx1NTNFQVx1NTFGQSBoYXNLZXkvXHU2NzJCXHU1NkRCXHU0RjRELFx1NkMzOFx1NEUwRFx1NjYwRVx1NjU4N1xuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBkYWVtb25WZXJzaW9uOiAnZmFrZS0wLjAuMCcsIGRlc2t0b3A6IHRydWUsIG1vZGVsOiBmYWtlUHJvdmlkZXJzLmdldChmYWtlQ2hhdFByb3ZpZGVyKT8ubW9kZWwgPz8gJ2Zha2UtbW9kZWwnLFxuICAgICAgICBjaGF0UHJvdmlkZXI6IGZha2VDaGF0UHJvdmlkZXIsIGxvY2FsZTogJ3poJyxcbiAgICAgICAgYnVzeVNlc3Npb25zOiBbLi4uc2Vzc2lvbnMua2V5cygpXS5zbGljZSgwLCAyKSxcbiAgICAgICAgYXBwcm92YWxQZW5kaW5nOiBwZW5kaW5nICE9PSBudWxsLFxuICAgICAgICBzZXR0aW5nczogeyBhcHByb3ZhbDogJ2FzaycgfSxcbiAgICAgICAgd29ya3NwYWNlOiBmYWtlV29ya3NwYWNlcy5pdGVtcy5maW5kKCh3KSA9PiB3LmlkID09PSBmYWtlV29ya3NwYWNlcy5jdXJyZW50KSA/PyBudWxsLFxuICAgICAgICBwcm92aWRlcnNEZXRhaWw6IFsuLi5mYWtlUHJvdmlkZXJzLmVudHJpZXMoKV0ubWFwKChbbmFtZSwgcF0pID0+ICh7XG4gICAgICAgICAgbmFtZSwgbW9kZWw6IHAubW9kZWwsIGJhc2VVcmw6IHAuYmFzZVVybCxcbiAgICAgICAgICBoYXNLZXk6IHAuYXBpS2V5ICE9PSAnJyxcbiAgICAgICAgICBrZXlUYWlsOiBwLmFwaUtleS5sZW5ndGggPj0gNCA/IHAuYXBpS2V5LnNsaWNlKC00KSA6IHVuZGVmaW5lZCxcbiAgICAgICAgICBwdXJwb3NlczogWydjaGF0J10sXG4gICAgICAgIH0pKSxcbiAgICAgIH0pKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2Rlc2t0b3Avc2h1dGRvd24nKSB7XG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlIH0pKTtcbiAgICAgIHNlcnZlci5jbG9zZSgoKSA9PiBwcm9jZXNzLmV4aXQoMCkpO1xuICAgICAgc2V0VGltZW91dCgoKSA9PiBwcm9jZXNzLmV4aXQoMCksIDFfMDAwKS51bnJlZigpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZmFrZS9kaWUnKSB7XG4gICAgICAvLyBcdTZENEJcdThCRDVcdTk0QTlcdTVCNTA6XHU2QTIxXHU2MkRGIGhvc3QgXHU1RDI5XHU2RTgzKFx1NTE0OFx1NUU5NFx1N0I1NFx1NTE4RFx1OTAwMFx1NTFGQSxcdTRGRERcdThCQzFcdTU0Q0RcdTVFOTRcdTVERjJcdTUzRDFcdTUxRkEpXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlIH0pKTtcbiAgICAgIHNldFRpbWVvdXQoKCkgPT4gcHJvY2Vzcy5leGl0KDEpLCA1MCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9tb2RlbCcpIHtcbiAgICAgIC8vIFx1NkEyMVx1NTc4Qlx1NTIwN1x1NjM2MihcdTRFMEUgaG1oYXJuZXNzIC9hcGkvbW9kZWwgXHU1NDBDXHU1RjYyOlx1NTIwNyBjaGF0IFx1OERFRlx1NzUzMSlcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoKGF3YWl0IHJlYWRCb2R5KCkpIHx8ICd7fScpIGFzIHsgbmFtZT86IHVua25vd24gfTtcbiAgICAgICAgY29uc3QgbmFtZSA9IHR5cGVvZiBib2R5Lm5hbWUgPT09ICdzdHJpbmcnID8gYm9keS5uYW1lLnRyaW0oKSA6ICcnO1xuICAgICAgICBpZiAoIWZha2VQcm92aWRlcnMuaGFzKG5hbWUpKSB7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3Byb3ZpZGVyIG5vdCBmb3VuZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBmYWtlQ2hhdFByb3ZpZGVyID0gbmFtZTtcbiAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlLCBtb2RlbDogZmFrZVByb3ZpZGVycy5nZXQobmFtZSk/Lm1vZGVsIH0pKTtcbiAgICAgIH0pKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS90YXNrJykge1xuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7IHRleHQ/OiB1bmtub3duOyBzZXNzaW9uSWQ/OiB1bmtub3duOyBtb2RlPzogdW5rbm93bjsgYXR0YWNobWVudHM/OiB1bmtub3duOyBpbWFnZXM/OiB1bmtub3duIH07XG4gICAgICAgICAgY29uc3QgdGV4dCA9IHR5cGVvZiBib2R5LnRleHQgPT09ICdzdHJpbmcnID8gYm9keS50ZXh0IDogJyc7XG4gICAgICAgICAgY29uc3Qgc2Vzc2lvbklkID0gdHlwZW9mIGJvZHkuc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IGJvZHkuc2Vzc2lvbklkIDogYHdlYi0ke0RhdGUubm93KCkudG9TdHJpbmcoMzYpfWA7XG4gICAgICAgICAgY29uc3QgbW9kZSA9IGJvZHkubW9kZSA9PT0gJ2FzaycgfHwgYm9keS5tb2RlID09PSAnYXV0bycgfHwgYm9keS5tb2RlID09PSAneW9sbycgPyBib2R5Lm1vZGUgOiAnYXNrJztcbiAgICAgICAgICBjb25zdCBhdHRhY2htZW50cyA9IEFycmF5LmlzQXJyYXkoYm9keS5hdHRhY2htZW50cykgPyBib2R5LmF0dGFjaG1lbnRzLmZpbHRlcigoYSk6IGEgaXMgc3RyaW5nID0+IHR5cGVvZiBhID09PSAnc3RyaW5nJykgOiBbXTtcbiAgICAgICAgICAvLyBcdTU2RkVcdTcyNDdcdTk2NDRcdTRFRjY6XHU0RTBFIGhtaGFybmVzcyB2aXNpb24gXHU1MzRGXHU4QkFFXHU1NDBDXHU1RjYyKHtuYW1lLGRhdGFVcmx9KTtmYWtlIFx1NjgyMVx1OUE4Q1x1NUY2Mlx1NzJCNlx1NTM3M1x1NjUzNlxuICAgICAgICAgIGNvbnN0IGltYWdlcyA9IEFycmF5LmlzQXJyYXkoYm9keS5pbWFnZXMpXG4gICAgICAgICAgICA/IGJvZHkuaW1hZ2VzLmZpbHRlcigoaW0pOiBpbSBpcyB7IG5hbWU6IHN0cmluZzsgZGF0YVVybDogc3RyaW5nIH0gPT4ge1xuICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgaW0gIT09ICdvYmplY3QnIHx8IGltID09PSBudWxsKSByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICAgICAgY29uc3QgbyA9IGltIGFzIHsgbmFtZT86IHVua25vd247IGRhdGFVcmw/OiB1bmtub3duIH07XG4gICAgICAgICAgICAgICAgcmV0dXJuIHR5cGVvZiBvLm5hbWUgPT09ICdzdHJpbmcnICYmIHR5cGVvZiBvLmRhdGFVcmwgPT09ICdzdHJpbmcnICYmIG8uZGF0YVVybC5zdGFydHNXaXRoKCdkYXRhOmltYWdlLycpO1xuICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgOiBbXTtcbiAgICAgICAgICBpZiAoIXRleHQpIHtcbiAgICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3RleHQgcmVxdWlyZWQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8gXHU0RTBFIGhtaGFybmVzcyBcdTU0MENcdThCRURcdTRFNDk6XHU1NDA4XHU2Q0Q1XHU5NjQ0XHU0RUY2XHU0RUU1IFtyZWZlcmVuY2VkIGZpbGVzXSBcdTUyNERcdTdGMDBcdTVFNzZcdTUxNjVcdTRFRkJcdTUyQTFcdTY1ODdcdTY3MkM7XG4gICAgICAgICAgLy8gXHU1NkZFXHU3MjQ3XHU0RUU1IFtpbWFnZXNdIFx1NTI0RFx1N0YwMFx1NjgwN1x1NkNFOFx1NUYyMFx1NjU3MCh2aXNpb24gXHU2M0NGXHU4RkYwXHU5NEZFXHU1NzI4XHU3NzFGXHU1QjlFIHJ1bnRpbWUgXHU5MUNDXHU1M0QxXHU3NTFGKVxuICAgICAgICAgIGNvbnN0IGNvbXBvc2VkID0gYXR0YWNobWVudHMubGVuZ3RoID4gMFxuICAgICAgICAgICAgPyBgW3JlZmVyZW5jZWQgZmlsZXNdXFxuJHthdHRhY2htZW50cy5tYXAoKGEpID0+IGAtICR7YS5zcGxpdCgvW1xcXFwvXS8pLnBvcCgpfWApLmpvaW4oJ1xcbicpfVxcblxcbiR7dGV4dH1gXG4gICAgICAgICAgICA6IHRleHQ7XG4gICAgICAgICAgY29uc3Qgd2l0aEltYWdlcyA9IGltYWdlcy5sZW5ndGggPiAwID8gYFtpbWFnZXM6ICR7aW1hZ2VzLmxlbmd0aH1dXFxuJHtjb21wb3NlZH1gIDogY29tcG9zZWQ7XG4gICAgICAgICAgY29uc3QgcnVuSWQgPSBydW5UYXNrKHNlc3Npb25JZCwgd2l0aEltYWdlcywgbW9kZSk7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIHJ1bklkLCBpbWFnZXM6IGltYWdlcy5sZW5ndGggfSkpO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCBTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgfVxuICAgICAgfSkoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2FwcHJvdmUnKSB7XG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7IGdyYW50ZWQ/OiB1bmtub3duOyBzZXNzaW9uSWQ/OiB1bmtub3duIH07XG4gICAgICAgIGNvbnN0IHNpZCA9IHR5cGVvZiBib2R5LnNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBib2R5LnNlc3Npb25JZCA6ICcnO1xuICAgICAgICBpZiAocGVuZGluZyA9PT0gbnVsbCB8fCAoc2lkICE9PSAnJyAmJiBwZW5kaW5nLnNlc3Npb25JZCAhPT0gc2lkKSkge1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICdubyBhcHByb3ZhbCBwZW5kaW5nJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHAgPSBwZW5kaW5nO1xuICAgICAgICBwZW5kaW5nID0gbnVsbDtcbiAgICAgICAgcC5yZXNvbHZlKGJvZHkuZ3JhbnRlZCA9PT0gdHJ1ZSk7XG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgZ3JhbnRlZDogYm9keS5ncmFudGVkID09PSB0cnVlIH0pKTtcbiAgICAgIH0pKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lLnN0YXJ0c1dpdGgoJy9hcGkvc2Vzc2lvbnMvJykgJiYgKHVybC5wYXRobmFtZS5lbmRzV2l0aCgnL2FyY2hpdmUnKSB8fCB1cmwucGF0aG5hbWUuZW5kc1dpdGgoJy9kZWxldGUnKSkpIHtcbiAgICAgIC8vIFx1NEYxQVx1OEJERFx1NUY1Mlx1Njg2My9cdTUyMjBcdTk2NjQoaG1oYXJuZXNzIFx1NTQwQ1x1NUY2MjpcdTc5RkJcdTUxNjUgYXJjaGl2ZS90cmFzaCxcdTUzRUZcdTYwNjJcdTU5MEQsXHU0RTBEXHU3ODZDXHU1MjIwKVxuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCBwYXJ0cyA9IHVybC5wYXRobmFtZS5zbGljZSgnL2FwaS9zZXNzaW9ucy8nLmxlbmd0aCkuc3BsaXQoJy8nKTtcbiAgICAgICAgY29uc3Qgb3AgPSBwYXJ0c1sxXSA/PyAnJztcbiAgICAgICAgY29uc3Qgb2lkID0gZGVjb2RlVVJJQ29tcG9uZW50KHBhcnRzWzBdID8/ICcnKS5yZXBsYWNlKC9bXmEtekEtWjAtOV86LkAtXS9nLCAnJyk7XG4gICAgICAgIGlmIChvaWQgPT09ICcnIHx8IChvcCAhPT0gJ2FyY2hpdmUnICYmIG9wICE9PSAnZGVsZXRlJykpIHtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnYmFkIG9wJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGlmICghc2Vzc2lvbnMuaGFzKG9pZCkpIHtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnc2Vzc2lvbiBub3QgZm91bmQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgc2Vzc2lvbnMuZGVsZXRlKG9pZCk7XG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSB9KSk7XG4gICAgICB9KSgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvaW5qZWN0Jykge1xuICAgICAgLy8gXHU4RkQwXHU4ODRDXHU0RTJEXHU2Q0U4XHU1MTY1KFx1NEUwRSBobWhhcm5lc3MgL2FwaS9pbmplY3QgXHU1NDBDXHU1RjYyO2Zha2UgXHU1M0VBXHU1NkRFXHU2MjY3KVxuICAgICAgdm9pZCByZWFkQm9keSgpO1xuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9pbnRlcnJ1cHQnKSB7XG4gICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgnJykgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47IC8vIGludGVycnVwdCBcdTY1RTAgYm9keSBcdThCRURcdTRFNDlcbiAgICAgIHZvaWQgYm9keTtcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUgfSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9zZXNzaW9ucycpIHtcbiAgICAgIGNvbnN0IGxpc3QgPSBbLi4uc2Vzc2lvbnMudmFsdWVzKCldLm1hcCgocykgPT4gKHtcbiAgICAgICAgaWQ6IHMuaWQsIHRpdGxlOiAnJywgdGFzazogJycsIG91dGNvbWU6ICdvaycsIHR1cm5zOiAxLCB0b29sVXNlczogMSxcbiAgICAgICAgdGltZTogcy51cGRhdGVkQXQsIGN3ZDogJ0M6XFxcXGRlbW8nLCBicmFuY2g6ICcnLCBjcmVhdGVkQXQ6IHMuY3JlYXRlZEF0LCB1cGRhdGVkQXQ6IHMudXBkYXRlZEF0LFxuICAgICAgfSkpO1xuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBzZXNzaW9uczogbGlzdCwgbmV4dEN1cnNvcjogbnVsbCB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUuc3RhcnRzV2l0aCgnL2FwaS9zZXNzaW9ucy8nKSkge1xuICAgICAgY29uc3Qgc2VnID0gZGVjb2RlVVJJQ29tcG9uZW50KHVybC5wYXRobmFtZS5zbGljZSgnL2FwaS9zZXNzaW9ucy8nLmxlbmd0aCkpO1xuICAgICAgLy8gXHU1QkZDXHU1MUZBKFx1NEUwRSBobWhhcm5lc3MgL2FwaS9zZXNzaW9ucy86aWQvZXhwb3J0Lm1kIFx1NTQwQ1x1NUY2Mjp0ZXh0L21hcmtkb3duIFx1NEUwQlx1OEY3RClcbiAgICAgIGNvbnN0IGV4cG9ydE1hdGNoID0gL14oLiopXFwvZXhwb3J0XFwubWQkLy5leGVjKHNlZykgPz8gL14oLiopXFwuZXhwb3J0XFwubWQkLy5leGVjKHNlZyk7XG4gICAgICBpZiAoZXhwb3J0TWF0Y2ggIT09IG51bGwgJiYgZXhwb3J0TWF0Y2hbMV0gIT09IHVuZGVmaW5lZCAmJiBleHBvcnRNYXRjaFsxXSAhPT0gJycpIHtcbiAgICAgICAgY29uc3QgZWlkID0gZXhwb3J0TWF0Y2hbMV0ucmVwbGFjZSgvW15hLXpBLVowLTlfOi5ALV0vZywgJycpO1xuICAgICAgICBjb25zdCBlcyA9IHNlc3Npb25zLmdldChlaWQpO1xuICAgICAgICBpZiAoZXMgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICdzZXNzaW9uIG5vdCBmb3VuZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ3RleHQvbWFya2Rvd247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICByZXMuZW5kKGAjIGhtaGFybmVzcyBcdTRGMUFcdThCRERcdTVCRkNcdTUxRkEoZmFrZSlcXG5cXG4tIFx1NEYxQVx1OEJERDoke2VpZH1cXG5cXG4jIyBcdTc1MjhcdTYyMzdcXG5cXG5cdTRFNEJcdTUyNERcdTc2ODRcdTRFRkJcdTUyQTEoZmFrZSBcdTk4ODRcdTg5QzgpXFxuXFxuIyMgXHU1MkE5XHU2MjRCXFxuXFxuXHU4RkQ5XHU2NjJGXHU1QkZDXHU1MUZBXHU3Njg0XHU1NkRFXHU1OTBEXHU5ODg0XHU4OUM4KGZha2UpXHUzMDAyXFxuYCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIC8vIFx1NEYxQVx1OEJERFx1OTg4NFx1ODlDOChcdTRFMEUgaG1oYXJuZXNzIEdFVCAvYXBpL3Nlc3Npb25zLzppZCBcdTU0MENcdTVGNjI6XHU2NzAwXHU1NDBFIDgwIFx1Njc2MSxcdTZCQ0ZcdTY3NjEgNTAwIFx1NUI1NylcbiAgICAgIGNvbnN0IGlkID0gc2VnLnJlcGxhY2UoL1teYS16QS1aMC05XzouQC1dL2csICcnKTtcbiAgICAgIGNvbnN0IHMgPSBzZXNzaW9ucy5nZXQoaWQpO1xuICAgICAgaWYgKHMgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3Nlc3Npb24gbm90IGZvdW5kJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgaWQsIG1vZGVsOiAnZmFrZS1tb2RlbCcsIGN3ZDogJ0M6XFxcXGRlbW8nLFxuICAgICAgICBtZXNzYWdlczogW1xuICAgICAgICAgIHsgcm9sZTogJ3VzZXInLCB0ZXh0OiAnXHU0RTRCXHU1MjREXHU3Njg0XHU0RUZCXHU1MkExKGZha2UgXHU5ODg0XHU4OUM4KScsIHRvb2xzOiBbXSB9LFxuICAgICAgICAgIHsgcm9sZTogJ2Fzc2lzdGFudCcsIHRleHQ6ICdcdThGRDlcdTY2MkZcdTUzODZcdTUzRjJcdTRGMUFcdThCRERcdTc2ODRcdTU2REVcdTU5MERcdTk4ODRcdTg5QzgoZmFrZSlcdTMwMDInLCB0b29sczogWydyZWFkX2ZpbGUnXSB9LFxuICAgICAgICBdLFxuICAgICAgfSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9mcycpIHtcbiAgICAgIC8vIFx1NzZFRVx1NUY1NVx1NkQ0Rlx1ODlDOChcdTRFMEUgaG1oYXJuZXNzIFx1NTQwQ1x1NUY2MjpwYXRoIFx1NzcwMVx1NzU2NT1cdTY4Mzk7ZmlsZXM9MSBcdTk2NDRcdTVFMjZcdTY1ODdcdTRFRjZcdTUyMTdcdTg4NjgpXG4gICAgICBjb25zdCBxID0gdXJsLnNlYXJjaFBhcmFtcy5nZXQoJ3BhdGgnKSA/PyAnJztcbiAgICAgIGNvbnN0IHdpdGhGaWxlcyA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KCdmaWxlcycpID09PSAnMSc7XG4gICAgICBpZiAocSA9PT0gJycpIHtcbiAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgcGF0aDogJycsIHNlZ21lbnRzOiBbXSwgcGFyZW50OiAnJyxcbiAgICAgICAgICBkaXJzOiBbeyBuYW1lOiAnZGVtby13b3Jrc3BhY2UnLCBwYXRoOiAnQzpcXFxcZGVtbycgfV0sXG4gICAgICAgICAgLi4uKHdpdGhGaWxlcyA/IHsgZmlsZXM6IFtdIH0gOiB7fSksXG4gICAgICAgIH0pKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBwYXRoOiBxLCBzZWdtZW50czogW3sgbmFtZTogcS5zcGxpdCgvW1xcXFwvXS8pLmZpbHRlcihCb29sZWFuKS5wb3AoKSA/PyBxLCBwYXRoOiBxIH1dLCBwYXJlbnQ6ICcnLFxuICAgICAgICBkaXJzOiBbeyBuYW1lOiAnc3JjJywgcGF0aDogYCR7cS5yZXBsYWNlKC9bXFxcXC9dJC8sICcnKX1cXFxcc3JjYCB9XSxcbiAgICAgICAgLi4uKHdpdGhGaWxlcyA/IHsgZmlsZXM6IFtcbiAgICAgICAgICB7IG5hbWU6ICdSRUFETUUubWQnLCBwYXRoOiBgJHtxLnJlcGxhY2UoL1tcXFxcL10kLywgJycpfVxcXFxSRUFETUUubWRgLCByZWw6ICdSRUFETUUubWQnIH0sXG4gICAgICAgICAgeyBuYW1lOiAncGFja2FnZS5qc29uJywgcGF0aDogYCR7cS5yZXBsYWNlKC9bXFxcXC9dJC8sICcnKX1cXFxccGFja2FnZS5qc29uYCwgcmVsOiAncGFja2FnZS5qc29uJyB9LFxuICAgICAgICBdIH0gOiB7fSksXG4gICAgICB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2ZzL3JlYWQnKSB7XG4gICAgICAvLyBcdTY1ODdcdTRFRjZcdTk4ODRcdTg5QzgoNjRLQiBcdTRFMEFcdTk2NTBcdThCRURcdTRFNDk7ZmFrZSBcdThGRDRcdTU2REVcdTU2RkFcdTVCOUFcdTY1ODdcdTY3MkMpXG4gICAgICBjb25zdCBwID0gdXJsLnNlYXJjaFBhcmFtcy5nZXQoJ3BhdGgnKSA/PyAnJztcbiAgICAgIGlmIChwID09PSAnJykge1xuICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3BhdGggcmVxdWlyZWQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBwYXRoOiBwLCByZWw6IHAuc3BsaXQoL1tcXFxcL10vKS5wb3AoKSA/PyBwLCBzaXplOiA0MixcbiAgICAgICAgdGV4dDogJyMgZGVtbyB3b3Jrc3BhY2VcXG5cXG5cdThGRDlcdTY2MkYgZmFrZSBob3N0IFx1NzY4NFx1NjU4N1x1NEVGNlx1OTg4NFx1ODlDOFx1NTE4NVx1NUJCOVx1MzAwMlxcbicsXG4gICAgICB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2RpZmYnKSB7XG4gICAgICAvLyBEaWZmIFx1OTc2Mlx1Njc3RihcdTRFMEUgaG1oYXJuZXNzIC9hcGkvZGlmZiBcdTU0MENcdTVGNjI7ZmFrZSBcdThGRDRcdTU2REVcdTU2RkFcdTVCOUFcdTVDMEZcdTUzRDhcdTY2RjRcdTk2QzYpXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIGdpdDogdHJ1ZSwgY3dkOiAnQzpcXFxcZGVtbycsXG4gICAgICAgIGNoYW5nZWQ6IFtcbiAgICAgICAgICB7IHN0YXRlOiAnTScsIHBhdGg6ICdzcmMvYXBwLnRzJyB9LFxuICAgICAgICAgIHsgc3RhdGU6ICdBJywgcGF0aDogJ2RvY3Mvbm90ZXMubWQnIH0sXG4gICAgICAgIF0sXG4gICAgICAgIHN0YXQ6ICcgc3JjL2FwcC50cyAgICAgIHwgMTIgKysrKysrKy0tLVxcbiBkb2NzL25vdGVzLm1kICAgfCAgNCArKysrXFxuIDIgZmlsZXMgY2hhbmdlZCwgMTYgaW5zZXJ0aW9ucygrKSwgMyBkZWxldGlvbnMoLSknLFxuICAgICAgfSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS93b3Jrc3BhY2VzJykge1xuICAgICAgLy8gXHU1REU1XHU0RjVDXHU1MzNBKFx1NEUwRSBobWhhcm5lc3MgXHU1NDBDXHU1RjYyOmN1cnJlbnQgKyBpdGVtcylcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgY3VycmVudDogZmFrZVdvcmtzcGFjZXMuY3VycmVudCxcbiAgICAgICAgaXRlbXM6IGZha2VXb3Jrc3BhY2VzLml0ZW1zLFxuICAgICAgfSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvd29ya3NwYWNlcycpIHtcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoKGF3YWl0IHJlYWRCb2R5KCkpIHx8ICd7fScpIGFzIHsgbmFtZT86IHVua25vd247IHBhdGg/OiB1bmtub3duIH07XG4gICAgICAgIGNvbnN0IHBhdGggPSB0eXBlb2YgYm9keS5wYXRoID09PSAnc3RyaW5nJyA/IGJvZHkucGF0aCA6ICcnO1xuICAgICAgICBjb25zdCBuYW1lID0gdHlwZW9mIGJvZHkubmFtZSA9PT0gJ3N0cmluZycgJiYgYm9keS5uYW1lICE9PSAnJyA/IGJvZHkubmFtZSA6IChwYXRoLnNwbGl0KC9bXFxcXC9dLykuZmlsdGVyKEJvb2xlYW4pLnBvcCgpID8/ICcnKTtcbiAgICAgICAgaWYgKHBhdGggPT09ICcnIHx8IG5hbWUgPT09ICcnKSB7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ2Fic29sdXRlIHBhdGggYW5kIG5hbWUgcmVxdWlyZWQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGZha2VXb3Jrc3BhY2VzLml0ZW1zLnNvbWUoKHcpID0+IHcucGF0aC50b0xvd2VyQ2FzZSgpID09PSBwYXRoLnRvTG93ZXJDYXNlKCkpKSB7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDksIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3dvcmtzcGFjZSBhbHJlYWR5IHJlZ2lzdGVyZWQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgaXRlbSA9IHsgaWQ6IGB3cy0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDgpfWAsIG5hbWUsIHBhdGggfTtcbiAgICAgICAgZmFrZVdvcmtzcGFjZXMuaXRlbXMucHVzaChpdGVtKTtcbiAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlLCBjdXJyZW50OiBmYWtlV29ya3NwYWNlcy5jdXJyZW50LCBpdGVtczogZmFrZVdvcmtzcGFjZXMuaXRlbXMgfSkpO1xuICAgICAgfSkoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3dvcmtzcGFjZXMvdXNlJykge1xuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgoYXdhaXQgcmVhZEJvZHkoKSkgfHwgJ3t9JykgYXMgeyBpZD86IHVua25vd24gfTtcbiAgICAgICAgY29uc3QgaGl0ID0gZmFrZVdvcmtzcGFjZXMuaXRlbXMuZmluZCgodykgPT4gdy5pZCA9PT0gYm9keS5pZCk7XG4gICAgICAgIGlmIChoaXQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICd3b3Jrc3BhY2Ugbm90IGZvdW5kJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGZha2VXb3Jrc3BhY2VzLmN1cnJlbnQgPSBoaXQuaWQ7XG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgY3VycmVudDogZmFrZVdvcmtzcGFjZXMuY3VycmVudCwgaXRlbXM6IGZha2VXb3Jrc3BhY2VzLml0ZW1zIH0pKTtcbiAgICAgIH0pKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9wcm92aWRlcnMnKSB7XG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7IG5hbWU/OiB1bmtub3duOyBiYXNlVXJsPzogdW5rbm93bjsgbW9kZWw/OiB1bmtub3duOyBhcGlLZXk/OiB1bmtub3duIH07XG4gICAgICAgIGNvbnN0IG5hbWUgPSB0eXBlb2YgYm9keS5uYW1lID09PSAnc3RyaW5nJyA/IGJvZHkubmFtZS50cmltKCkgOiAnJztcbiAgICAgICAgY29uc3QgYmFzZVVybCA9IHR5cGVvZiBib2R5LmJhc2VVcmwgPT09ICdzdHJpbmcnID8gYm9keS5iYXNlVXJsLnRyaW0oKSA6ICcnO1xuICAgICAgICBjb25zdCBtb2RlbCA9IHR5cGVvZiBib2R5Lm1vZGVsID09PSAnc3RyaW5nJyA/IGJvZHkubW9kZWwudHJpbSgpIDogJyc7XG4gICAgICAgIGlmIChuYW1lID09PSAnJyB8fCBiYXNlVXJsID09PSAnJyB8fCBtb2RlbCA9PT0gJycpIHtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnbmFtZSwgYmFzZVVybCBhbmQgbW9kZWwgYXJlIHJlcXVpcmVkJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGZha2VQcm92aWRlcnMuc2V0KG5hbWUsIHsgYmFzZVVybCwgbW9kZWwsIGFwaUtleTogdHlwZW9mIGJvZHkuYXBpS2V5ID09PSAnc3RyaW5nJyA/IGJvZHkuYXBpS2V5IDogJycgfSk7XG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgbmFtZSB9KSk7XG4gICAgICB9KSgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9mcy9zZWFyY2gnKSB7XG4gICAgICAvLyBcdTVERTVcdTRGNUNcdTUzM0FcdTY1ODdcdTRFRjZcdTY0MUNcdTdEMjIoXHU0RTBFIGhtaGFybmVzcyBcdTU0MENcdTVGNjI6QFx1OTY0NFx1NEVGNlx1OTAwOVx1NjJFOVx1NTY2OFx1NzY4NFx1NjU3MFx1NjM2RVx1NkU5MClcbiAgICAgIGNvbnN0IHEgPSAodXJsLnNlYXJjaFBhcmFtcy5nZXQoJ3EnKSA/PyAnJykudHJpbSgpLnRvTG93ZXJDYXNlKCk7XG4gICAgICBjb25zdCBhbGwgPSBbXG4gICAgICAgIHsgcmVsOiAnUkVBRE1FLm1kJywgcGF0aDogJ0M6XFxcXGRlbW9cXFxcUkVBRE1FLm1kJywga2luZDogJ2ZpbGUnIH0sXG4gICAgICAgIHsgcmVsOiAnc3JjL2FwcC50cycsIHBhdGg6ICdDOlxcXFxkZW1vXFxcXHNyY1xcXFxhcHAudHMnLCBraW5kOiAnZmlsZScgfSxcbiAgICAgICAgeyByZWw6ICdkb2NzL25vdGVzLm1kJywgcGF0aDogJ0M6XFxcXGRlbW9cXFxcZG9jc1xcXFxub3Rlcy5tZCcsIGtpbmQ6ICdmaWxlJyB9LFxuICAgICAgXTtcbiAgICAgIGNvbnN0IGhpdHMgPSBxID09PSAnJyA/IGFsbCA6IGFsbC5maWx0ZXIoKGYpID0+IGYucmVsLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMocSkpO1xuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyByZXN1bHRzOiBoaXRzLnNsaWNlKDAsIDIwKSwgdHJ1bmNhdGVkOiBmYWxzZSwgdG90YWw6IGhpdHMubGVuZ3RoIH0pKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvY29nbml0aXZlJykge1xuICAgICAgLy8gXHU4QkE0XHU3N0U1XHU3MkI2XHU2MDAxKFx1NEUwRSBobWhhcm5lc3MgY29nbml0aXZlU3RhdHVzIFx1NTQwQ1x1NUY2Mlx1NUI1MFx1OTZDNjtcdTdGM0FcdTY1NzBcdTYzNkVcdTY2M0VcdTVGMEYgbnVsbClcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgbWVtb3J5OiB7IGxheWVyczogMywgZW50cmllczogMTIsIGNvbnRyYWRpY3Rpb25zOiAwIH0sXG4gICAgICAgIHRyYWplY3RvcmllczogNyxcbiAgICAgICAgYXVkaXRFdmVudHM6IDIxLFxuICAgICAgICB3b3JsZE1vZGVsOiB7IHZlcnNpb246IDQsIGJlbGllZnM6IDksIHRydXN0ZWQ6IDUsIGJyaWVyOiAwLjMxIH0sXG4gICAgICAgIGNhbGlicmF0aW9uOiB7IHByZWRpY3Rpb25zOiA0NiwgcmVsaWFiaWxpdHk6IDAuNzIgfSxcbiAgICAgIH0pKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2Zha2UvZW1pdCcpIHtcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgoYXdhaXQgcmVhZEJvZHkoKSkgfHwgJ3t9JykgYXMge1xuICAgICAgICAgICAgc2Vzc2lvbklkOiBzdHJpbmc7IHJ1bklkOiBzdHJpbmc7IGtpbmQ6IEV2ZW50S2luZDsgcGF5bG9hZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICAgICAgfTtcbiAgICAgICAgICBjb25zdCBzZXEgPSBlbWl0KGJvZHkuc2Vzc2lvbklkLCBib2R5LnJ1bklkLCBib2R5LmtpbmQsIGJvZHkucGF5bG9hZCk7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIHNlcSB9KSk7XG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsIFN0cmluZyhlcnIpLnNsaWNlKDAsIDEyMCksIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICB9XG4gICAgICB9KSgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCBgbm8gcm91dGUgJHtyZXEubWV0aG9kfSAke3VybC5wYXRobmFtZX1gLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgfSk7XG5cbiAgYXdhaXQgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgIHNlcnZlci5vbmNlKCdlcnJvcicsIHJlamVjdCk7XG4gICAgc2VydmVyLmxpc3RlbigwLCAnMTI3LjAuMC4xJywgKCkgPT4gcmVzb2x2ZSgpKTtcbiAgfSk7XG4gIGNvbnN0IGFkZHJlc3MgPSBzZXJ2ZXIuYWRkcmVzcygpO1xuICBpZiAoYWRkcmVzcyA9PT0gbnVsbCB8fCB0eXBlb2YgYWRkcmVzcyAhPT0gJ29iamVjdCcpIHRocm93IG5ldyBFcnJvcignZmFrZSBob3N0OiBubyBwb3J0Jyk7XG4gIGNvbnN0IHBvcnQgPSBhZGRyZXNzLnBvcnQ7XG5cbiAgaWYgKCFvcHRzLnF1aWV0KSB7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7SlNPTi5zdHJpbmdpZnkoeyBobWhEZXNrdG9wSG9zdFJlYWR5OiB0cnVlLCBwb3J0LCB2ZXJzaW9uOiAnZmFrZS0wLjAuMCcgfSl9XFxuYCk7XG4gIH1cbiAgY29uc3QgZGllQWZ0ZXIgPSBOdW1iZXIocHJvY2Vzcy5lbnYuRkFLRV9IT1NUX0RJRV9BRlRFUl9NUyA/PyAwKTtcbiAgaWYgKE51bWJlci5pc0Zpbml0ZShkaWVBZnRlcikgJiYgZGllQWZ0ZXIgPiAwKSB7XG4gICAgc2V0VGltZW91dCgoKSA9PiBwcm9jZXNzLmV4aXQoMSksIGRpZUFmdGVyKS51bnJlZigpO1xuICB9XG5cbiAgLy8gY2xvc2UoKTogXHU1MTQ4XHU2NUFEXHU1RjAwXHU1MTY4XHU5MEU4IFNTRSBcdThGREVcdTYzQTUoXHU1QjgzXHU0RUVDXHU2QzM4XHU0RTBEXHU4MUVBXHU3MTM2XHU1MTczXHU5NUVEKSxcdTU0MjZcdTUyMTkgc2VydmVyLmNsb3NlXG4gIC8vIFx1NEYxQVx1NEUwMFx1NzZGNFx1N0I0OVx1NkQzQlx1OERDM1x1OEZERVx1NjNBNSxcdTZENEJcdThCRDVcdThGREJcdTdBMEJcdTYzMDJcdTZCN0JcdTMwMDJcbiAgY29uc3QgY2xvc2UgPSAoKTogUHJvbWlzZTx2b2lkPiA9PlxuICAgIG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlKSA9PiB7XG4gICAgICBmb3IgKGNvbnN0IGMgb2Ygc3NlQ2xpZW50cykge1xuICAgICAgICB0cnkgeyBjLmVuZCgpOyBjLmRlc3Ryb3koKTsgfSBjYXRjaCB7IC8qIGFscmVhZHkgZ29uZSAqLyB9XG4gICAgICB9XG4gICAgICBzc2VDbGllbnRzLmNsZWFyKCk7XG4gICAgICBzZXJ2ZXIuY2xvc2UoKCkgPT4gcmVzb2x2ZSgpKTtcbiAgICAgIHNldFRpbWVvdXQoKCkgPT4gcmVzb2x2ZSgpLCAxXzAwMCkudW5yZWYoKTtcbiAgICB9KTtcblxuICByZXR1cm4geyBwb3J0LCBlbWl0LCBjbG9zZSB9O1xufVxuXG4vLyBcdTc2RjRcdTYzQTVcdThGRDBcdTg4NEMoc3VwZXJ2aXNvciBzcGF3biBcdTc2ODRcdTVCNTBcdThGREJcdTdBMEJcdTVGNjJcdTYwMDEpXHUzMDAycmVhbHBhdGggXHU2QkQ0XHU4RjgzOm5wbSB3b3Jrc3BhY2Vcbi8vIGp1bmN0aW9uIC8gXHU1OTI3XHU1QzBGXHU1MTk5XHU1REVFXHU1RjAyXHU5MEZEXHU0RTBEXHU4MEZEXHU4QkE5XHU4RkQ5XHU0RTJBXHU2OEMwXHU2RDRCXHU1OTMxXHU2MjRCKFx1NTkzMVx1NjI0Qj1cdTk3NTlcdTlFRDhcdTkwMDBcdTUxRkEgY29kZSAwLFx1OTZCRVx1NjdFNSlcdTMwMDJcbi8vIGNqcyBidW5kbGUoZXNidWlsZCxcdTYyNTNcdTUzMDVcdTRFQTdcdTU0QzEpXHU0RTBCIF9fZmlsZW5hbWUgXHU1QjU4XHU1NzI4O0VTTSh0c3gvXHU2RTkwXHU3ODAxKVx1NzUyOCBpbXBvcnQubWV0YVx1MzAwMlxuY29uc3Qgc2VsZlVybDogc3RyaW5nID0gdHlwZW9mIF9fZmlsZW5hbWUgPT09ICdzdHJpbmcnXG4gID8gcGF0aFRvRmlsZVVSTChyZWFscGF0aFN5bmMoX19maWxlbmFtZSkpLmhyZWZcbiAgOiBpbXBvcnQubWV0YS51cmw7XG5jb25zdCBpbnZva2VkQXNTY3JpcHQgPSAoKCkgPT4ge1xuICBpZiAocHJvY2Vzcy5hcmd2WzFdID09PSB1bmRlZmluZWQpIHJldHVybiBmYWxzZTtcbiAgdHJ5IHtcbiAgICByZXR1cm4gc2VsZlVybCA9PT0gcGF0aFRvRmlsZVVSTChyZWFscGF0aFN5bmMocHJvY2Vzcy5hcmd2WzFdKSkuaHJlZjtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59KSgpO1xuaWYgKGludm9rZWRBc1NjcmlwdCkge1xuICBjb25zdCB0b2tlbiA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1RPS0VOID8/ICcnO1xuICAvLyBGQUtFX0hPU1RfRElFX0FUX0JPT1Q9MTpcdTVGMTVcdTVCRkNcdTg4NENcdThGOTNcdTUxRkFcdTUyNERcdTUzNzNcdTZCN0IoXHU2Nzg0XHU5MDIwXHU1NDJGXHU1MkE4XHU2NzFGIFJVTlRJTUVfQ1JBU0hFRClcbiAgaWYgKHByb2Nlc3MuZW52LkZBS0VfSE9TVF9ESUVfQVRfQk9PVCA9PT0gJzEnKSB7XG4gICAgcHJvY2Vzcy5leGl0KDEpO1xuICB9XG4gIGNvbnN0IHNsb3cgPSBOdW1iZXIocHJvY2Vzcy5lbnYuRkFLRV9IT1NUX1NMT1dfQUZURVIgPz8gMCk7XG4gIGNvbnN0IGJvb3QgPSAoKTogdm9pZCA9PiB7XG4gICAgdm9pZCBzdGFydEZha2VIb3N0KHsgdG9rZW4gfSkuY2F0Y2goKGVycikgPT4ge1xuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYGZha2UtaG9zdCBmYWlsZWQ6ICR7U3RyaW5nKGVycil9XFxuYCk7XG4gICAgICBwcm9jZXNzLmV4aXQoMSk7XG4gICAgfSk7XG4gIH07XG4gIGlmIChOdW1iZXIuaXNGaW5pdGUoc2xvdykgJiYgc2xvdyA+IDApIHNldFRpbWVvdXQoYm9vdCwgc2xvdyk7XG4gIGVsc2UgYm9vdCgpO1xufVxuIiwgIi8qKlxyXG4gKiBVSVZFUklGWSBcdTk0QTlcdTVCNTAgXHUyMDE0XHUyMDE0IFx1OTAxMFx1NTI5Rlx1ODBGRFx1NzcxRlx1NUI5RSBVSSBcdTlBNzFcdTUyQThcdTlBOENcdTY1MzYoMjAyNi0xMC0xMCBcdTc1MjhcdTYyMzdcdTYzMDdcdTRFRTQ6XHJcbiAqIFwiXHU1QkY5XHU2QkNGXHU0RTAwXHU0RTJBXHU1MjlGXHU4MEZELFx1NkJDRlx1NEUwMFx1NEUyQVx1NEUxQVx1NTJBMVx1NkQ0MVx1N0EwQlx1NTE2OFx1OTc2Mlx1NzY4NFx1OUE4Q1x1NjUzNlwiKVx1MzAwMlxyXG4gKlxyXG4gKiBcdTc2RjRcdTYzQTVcdTVCRjlcdTZFMzJcdTY3RDNcdTU0MEVcdTc2ODQgRE9NIFx1NjVBRFx1OEEwMChcdTVFMDNcdTVDNDBcdTUxRTBcdTRGNTUvXHU1M0VGXHU4OUMxXHU2MDI3KSxcdTVFNzZcdTc1MjhcdTUzOUZcdTc1MUZcdTRFOEJcdTRFRjZcdTlBNzFcdTUyQTggUmVhY3RcclxuICogKFx1NTNEN1x1NjNBN1x1OEY5M1x1NTE2NVx1NzUyOFx1NTM5Rlx1NTc4QiBzZXR0ZXIgKyBpbnB1dCBcdTRFOEJcdTRFRjY7XHU2MzA5XHU5NEFFIGNsaWNrO1x1OTUyRVx1NzZEOFx1OEQ3MCB3aW5kb3dcclxuICoga2V5ZG93bilcdTMwMDJmYWtlIFx1NkEyMVx1NUYwRlx1OEREMVx1NUI4Q1x1NjU3NFx1NEVGQlx1NTJBMVx1OTRGRShcdTUzRDFcdTkwMDFcdTIxOTJcdTVERTVcdTUxNzdcdTIxOTJcdTVCQTFcdTYyNzlcdTIxOTJcdTRFQTRcdTRFRDhcdTcyNjlcdTIxOTJcdTZDNDdcdTYwM0IpO1xyXG4gKiByZWFsIFx1NkEyMVx1NUYwRlx1NTNFQVx1OEREMVx1NTNFQVx1OEJGQlx1NUI1MFx1OTZDNihcdTRFMERcdTUyQThcdTc3MUZcdTVCOUVcdTRGMUFcdThCRERcdTMwMDFcdTRFMERcdTcwRTcgdG9rZW4pXHUzMDAyXHJcbiAqIFx1NkJDRlx1NkI2NVx1OEY5M1x1NTFGQSBgVUlWRVJJRlkgUEFTU3xGQUlMIG5hbWUgfCBkZXRhaWxgLFx1N0VEM1x1NUMzRSBTVU1NQVJZLGV4aXQgY29kZVx1MzAwMlxyXG4gKi9cclxuaW1wb3J0IHsgYXBwLCB0eXBlIEJyb3dzZXJXaW5kb3cgfSBmcm9tICdlbGVjdHJvbic7XHJcbmltcG9ydCB7IG1rZGlyLCB3cml0ZUZpbGUgfSBmcm9tICdub2RlOmZzL3Byb21pc2VzJztcclxuaW1wb3J0IHsgam9pbiB9IGZyb20gJ25vZGU6cGF0aCc7XHJcblxyXG5jb25zdCBzbGVlcCA9IChtczogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiA9PiBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCBtcykpO1xyXG5cclxuYXN5bmMgZnVuY3Rpb24gcnVuVWlWZXJpZnkod2luOiBCcm93c2VyV2luZG93LCBtb2RlOiAnZmFrZScgfCAncmVhbCcpOiBQcm9taXNlPHZvaWQ+IHtcclxuICBjb25zdCBzaG90cyA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX1NIT1RTID8/IGpvaW4oYXBwLmdldFBhdGgoJ3RlbXAnKSwgJ2htaC11aXZlcmlmeScpO1xyXG4gIGF3YWl0IG1rZGlyKHNob3RzLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KS5jYXRjaCgoKSA9PiB1bmRlZmluZWQpO1xyXG4gIGNvbnN0IHJlc3VsdHM6IEFycmF5PFtzdHJpbmcsIGJvb2xlYW4sIHN0cmluZ10+ID0gW107XHJcbiAgbGV0IHNob3RJZHggPSAwO1xyXG5cclxuICBjb25zdCBqcyA9IDxUPihjb2RlOiBzdHJpbmcpOiBQcm9taXNlPFQ+ID0+IHdpbi53ZWJDb250ZW50cy5leGVjdXRlSmF2YVNjcmlwdChjb2RlLCB0cnVlKSBhcyBQcm9taXNlPFQ+O1xyXG4gIGNvbnN0IHN0ZXAgPSBhc3luYyAobmFtZTogc3RyaW5nLCBmbjogKCkgPT4gUHJvbWlzZTxbYm9vbGVhbiwgc3RyaW5nXT4pOiBQcm9taXNlPHZvaWQ+ID0+IHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IFtvaywgZGV0YWlsXSA9IGF3YWl0IGZuKCk7XHJcbiAgICAgIHJlc3VsdHMucHVzaChbbmFtZSwgb2ssIGRldGFpbF0pO1xyXG4gICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgIGNvbnN0IGRldGFpbCA9IGVyciBpbnN0YW5jZW9mIEVycm9yICYmIGVyci5zdGFjayAhPT0gdW5kZWZpbmVkID8gZXJyLnN0YWNrIDogU3RyaW5nKGVycik7XHJcbiAgICAgIHJlc3VsdHMucHVzaChbbmFtZSwgZmFsc2UsIGRldGFpbC5zbGljZSgwLCAzMDApXSk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBsYXN0ID0gcmVzdWx0c1tyZXN1bHRzLmxlbmd0aCAtIDFdITtcclxuICAgIGNvbnNvbGUubG9nKGBVSVZFUklGWSAke2xhc3RbMV0gPyAnUEFTUycgOiAnRkFJTCd9IHwgJHtsYXN0WzBdfSB8ICR7bGFzdFsyXX1gKTtcclxuICB9O1xyXG4gIC8qKiBcdThGNkVcdThCRTJcdTc2RjRcdTUyMzAgcHJlZGljYXRlQ29kZSBcdThGRDRcdTU2REUge29rOnRydWUsLi4ufSBcdTYyMTZcdThEODVcdTY1RjYoXHU4RkQ0XHU1NkRFXHU2NzAwXHU1NDBFXHU3Njg0IGRldGFpbClcdTMwMDIgKi9cclxuICBjb25zdCB3YWl0Rm9yID0gYXN5bmMgKGxhYmVsOiBzdHJpbmcsIHByZWRpY2F0ZUNvZGU6IHN0cmluZywgdGltZW91dE1zOiBudW1iZXIpOiBQcm9taXNlPFtib29sZWFuLCBzdHJpbmddPiA9PiB7XHJcbiAgICBjb25zdCBzdGFydGVkID0gRGF0ZS5ub3coKTtcclxuICAgIGZvciAoOzspIHtcclxuICAgICAgY29uc3QgciA9IChhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHRyeSB7IHJldHVybiBKU09OLnN0cmluZ2lmeSgoZnVuY3Rpb24oKXsgJHtwcmVkaWNhdGVDb2RlfSB9KSgpKTsgfSBjYXRjaChlKXsgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHtvazpmYWxzZSwgZGV0YWlsOlN0cmluZyhlKS5zbGljZSgwLDEyMCl9KTsgfSB9KSgpYCkpIGFzIHN0cmluZztcclxuICAgICAgbGV0IHBhcnNlZDogeyBvaz86IGJvb2xlYW47IGRldGFpbD86IHN0cmluZyB9O1xyXG4gICAgICB0cnkgeyBwYXJzZWQgPSBKU09OLnBhcnNlKHIpIGFzIHsgb2s/OiBib29sZWFuOyBkZXRhaWw/OiBzdHJpbmcgfTsgfSBjYXRjaCB7IHBhcnNlZCA9IHsgb2s6IGZhbHNlLCBkZXRhaWw6IFN0cmluZyhyKS5zbGljZSgwLCAxMjApIH07IH1cclxuICAgICAgaWYgKHBhcnNlZC5vayA9PT0gdHJ1ZSkgcmV0dXJuIFt0cnVlLCBTdHJpbmcocGFyc2VkLmRldGFpbCA/PyAnJyldO1xyXG4gICAgICBpZiAoRGF0ZS5ub3coKSAtIHN0YXJ0ZWQgPiB0aW1lb3V0TXMpIHJldHVybiBbZmFsc2UsIGAke2xhYmVsfTogJHtTdHJpbmcocGFyc2VkLmRldGFpbCA/PyAndGltZW91dCcpfWBdO1xyXG4gICAgICBhd2FpdCBzbGVlcCgyNTApO1xyXG4gICAgfVxyXG4gIH07XHJcbiAgY29uc3Qgc2hvdCA9IGFzeW5jIChsYWJlbDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiA9PiB7XHJcbiAgICBzaG90SWR4ICs9IDE7XHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCBpbWcgPSBhd2FpdCB3aW4ud2ViQ29udGVudHMuY2FwdHVyZVBhZ2UoKTtcclxuICAgICAgYXdhaXQgd3JpdGVGaWxlKGpvaW4oc2hvdHMsIGAke21vZGV9LSR7U3RyaW5nKHNob3RJZHgpLnBhZFN0YXJ0KDIsICcwJyl9LSR7bGFiZWx9LnBuZ2ApLCBpbWcudG9QTkcoKSk7XHJcbiAgICB9IGNhdGNoIHsgLyogXHU2MjJBXHU1NkZFXHU1OTMxXHU4RDI1XHU0RTBEXHU1MjI0XHU2QjdCICovIH1cclxuICB9O1xyXG5cclxuICAvKiAtLS0tIFx1NTNEN1x1NjNBN1x1OEY5M1x1NTE2NShSZWFjdDpcdTUzOUZcdTU3OEIgc2V0dGVyIFx1ODlFNlx1NTNEMSBvbkNoYW5nZSkgLS0tLSAqL1xyXG4gIGNvbnN0IHR5cGVJbnRvID0gKHNlbDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpOiBQcm9taXNlPHVua25vd24+ID0+XHJcbiAgICBqcyhgKGZ1bmN0aW9uKCl7XHJcbiAgICAgIHZhciBlbCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJHtKU09OLnN0cmluZ2lmeShzZWwpfSk7XHJcbiAgICAgIGlmICghZWwpIHJldHVybiAnTk9FTCc7XHJcbiAgICAgIHZhciBwcm90byA9IGVsLnRhZ05hbWUgPT09ICdURVhUQVJFQScgPyBIVE1MVGV4dEFyZWFFbGVtZW50LnByb3RvdHlwZSA6IEhUTUxJbnB1dEVsZW1lbnQucHJvdG90eXBlO1xyXG4gICAgICBPYmplY3QuZ2V0T3duUHJvcGVydHlEZXNjcmlwdG9yKHByb3RvLCAndmFsdWUnKS5zZXQuY2FsbChlbCwgJHtKU09OLnN0cmluZ2lmeSh0ZXh0KX0pO1xyXG4gICAgICBlbC5kaXNwYXRjaEV2ZW50KG5ldyBFdmVudCgnaW5wdXQnLCB7IGJ1YmJsZXM6IHRydWUgfSkpO1xyXG4gICAgICByZXR1cm4gJ09LJztcclxuICAgIH0pKClgKTtcclxuXHJcbiAgLyogLS0tLSBcdTU0MkZcdTUyQThcdTdCNDlcdTVGODU6UmVhY3QgXHU2MzAyXHU4RjdEICsgaG9zdCBcdTdFRkZcdTcwQjkocmVhbCBcdTc2ODQgaG1oYXJuZXNzIFx1NTFCN1x1NTQyRlx1NTJBOFx1ODk4MVx1N0YxNlx1OEJEMVxyXG4gICAgIFx1NjU3NFx1NTk1NyBDTEkgXHU0RjlEXHU4RDU2LFx1NTNFRlx1NTIzMCAzMHMrO1x1NEUwRFx1N0I0OVx1N0VGRlx1NzBCOVx1NUMzMVx1NUYwMFx1OEREMVx1NEYxQVx1NTE2OFx1OTBFOFx1OEQ4NVx1NjVGNlx1OEJFRlx1NjJBNSkgLS0tLSAqL1xyXG4gIGF3YWl0IHdhaXRGb3IoJ2hvc3QgcmVhZHknLCBgdmFyIHQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNvbXBvc2VyIHRleHRhcmVhJyk7IHJldHVybiB7b2s6ICEhdCwgZGV0YWlsOiB0ID8gJ21vdW50ZWQnIDogJ25vIGNvbXBvc2VyJ307YCwgMjBfMDAwKTtcclxuICBhd2FpdCB3YWl0Rm9yKCdob3N0IGRvdCBvbicsIGB2YXIgZD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuaG9zdC1kb3QnKTsgcmV0dXJuIHtvazogISFkICYmIGQuY2xhc3NMaXN0LmNvbnRhaW5zKCdvbicpLCBkZXRhaWw6IGQgPyBkLmNsYXNzTmFtZSA6ICdubyBkb3QnfTtgLCBtb2RlID09PSAncmVhbCcgPyA2MF8wMDAgOiAyMF8wMDApO1xyXG4gIGF3YWl0IHNsZWVwKDFfMjAwKTsgLy8gXHU0RjFBXHU4QkREXHU1MjE3XHU4ODY4L1x1OTg3Nlx1NjgwRlx1NjU3MFx1NjM2RVx1ODQzRFx1NTczMFxyXG5cclxuICAvKiogXHU3RURGXHU0RTAwXHU2NTM2XHU1QzNFOlNVTU1BUlkgKyBcdTYzMDlcdTU5MzFcdThEMjVcdTY1NzBcdTkwMDBcdTUxRkFcdTMwMDIgKi9cclxuICBjb25zdCBmaW5pc2ggPSAoKTogdm9pZCA9PiB7XHJcbiAgICBjb25zdCBmYWlsZWQgPSByZXN1bHRzLmZpbHRlcigocikgPT4gIXJbMV0pLmxlbmd0aDtcclxuICAgIGNvbnNvbGUubG9nKGBVSVZFUklGWSBTVU1NQVJZIHBhc3M9JHtyZXN1bHRzLmxlbmd0aCAtIGZhaWxlZH0vJHtyZXN1bHRzLmxlbmd0aH0gbW9kZT0ke21vZGV9IHNob3RzPSR7c2hvdHN9YCk7XHJcbiAgICBhcHAuZXhpdChmYWlsZWQgPT09IDAgPyAwIDogMSk7XHJcbiAgfTtcclxuXHJcbiAgLyogPT09PT09PT09PSBcdTRFMTNcdTc1Mjg6XHU3NzFGXHU1QjlFXHU2NkY0XHU2NUIwXHU1MTY4XHU2RDQxXHU3QTBCXHU5QThDXHU2NTM2KFx1NEVGQlx1NTJBMSAxMy1DO1x1OUE3MVx1NTJBOFx1NTY2OCAtLXVwZGF0ZS1yZWFsKVxyXG4gICAgIFx1NTI0RFx1N0Y2RSBlbnY6SE1IX0RFU0tUT1BfVVBEQVRFX0ZPUkNFX1RBRyBcdTk3NUVcdTdBN0EoXHU1RjNBXHU1MjM2XHU4OUM2XHU0RTNBXHU2NzA5XHU2NkY0XHU2NUIwLFx1NUY1M1x1NTI0RCAwLjIuOVxyXG4gICAgID09IGxhdGVzdCAwLjIuOSBcdTRFQ0RcdThENzBcdTRFMEJcdThGN0QpXHUzMDAyXHU4RDcwXHU3NzFGXHU1QjlFXHU2OEMwXHU2N0U1XHU5NEZFKGRpcmVjdCBcdTIxOTIgYXRvbWdpdCBcdTIxOTIgXHUyMDI2KVx1MjE5MiBcdTU0MEVcdTUzRjBcclxuICAgICBcdTZENDFcdTVGMEZcdTRFMEJcdThGN0RcdTc3MUZcdTVCOUUgU2V0dXAoMTEyTUIsYXRvbWdpdCBcdThENDRcdTRFQTcpXHUyMTkyIGRvd25sb2FkZWQgXHU2QTJBXHU1RTQ1XHUzMDAyXHU1M0VBXHU2NUFEXHU4QTAwXHU1QzMxXHU3RUVBLFxyXG4gICAgIFx1N0VERFx1NEUwRFx1NzBCOVx1NTFGQlwiXHU5MUNEXHU1NDJGXHU2NkY0XHU2NUIwXCIoXHU5MDdGXHU1MTREXHU2MjhBXHU1RjAwXHU1M0QxXHU2NzNBXHU3Njg0IGVsZWN0cm9uIGRpc3QgXHU4OEM1XHU1NzRGKVx1MzAwMiAqL1xyXG4gIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9VUERBVEUgPT09ICdyZWFsJykge1xyXG4gICAgYXdhaXQgc3RlcCgnXHU2NkY0XHU2NUIwKFx1NzcxRlx1NUI5RSk6XHU1NDJGXHU1MkE4IDMwcyBcdTgxRUFcdTUyQThcdTY4QzBcdTY3RTUgXHUyMTkyIGF0b21naXQvXHU5NTVDXHU1MENGXHU5MDFBXHU5MDUzXHU1NDdEXHU0RTJEIFx1MjE5MiBcdTU0MEVcdTUzRjBcdTRFMEJcdThGN0RcdThGREJcdTVFQTZcdTZBMkFcdTVFNDVcdTUxRkFcdTczQjAnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdkb3dubG9hZGluZyBvciByZWFkeSBiYW5uZXInLCBgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnVwZGF0ZS1iYW5uZXInKTtcclxuICAgICAgICBpZighYikgcmV0dXJuIHtvazpmYWxzZSwgZGV0YWlsOidubyBiYW5uZXIgeWV0J307XHJcbiAgICAgICAgdmFyIHQ9Yi50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpO1xyXG4gICAgICAgIHJldHVybiB7b2s6IHRydWUsIGRldGFpbDogdC5zbGljZSgwLDkwKX07YCwgMTUwXzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHNob3QoJ3VwZGF0ZS1yZWFsLWRvd25sb2FkaW5nJyk7XHJcbiAgICBhd2FpdCBzdGVwKCdcdTY2RjRcdTY1QjAoXHU3NzFGXHU1QjlFKToxMTJNQiBcdTZENDFcdTVGMEZcdTRFMEJcdThGN0RcdTVCOENcdTYyMTAgXHUyMTkyIFwiXHU5MUNEXHU1NDJGXHU2NkY0XHU2NUIwXCJcdTZBMkFcdTVFNDVcdTVDMzFcdTdFRUEoXHU0RTBEXHU3MEI5XHU1MUZCLFx1NEUwRFx1NUI4OVx1ODhDNSknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdyZWFkeSBiYW5uZXInLCBgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnVwZGF0ZS1iYW5uZXInKTtcclxuICAgICAgICB2YXIgYnRuPWI/Yi5xdWVyeVNlbGVjdG9yKCcudXBkYXRlLXJlc3RhcnQnKTpudWxsO1xyXG4gICAgICAgIHZhciBsaW5rcz1iP2IucXVlcnlTZWxlY3RvckFsbCgnYScpLmxlbmd0aDotMTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWJ0biAmJiBidG4uZGlzYWJsZWQ9PT1mYWxzZSAmJiBsaW5rcz09PTAsIGRldGFpbDogYiA/IGIudGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDkwKSA6ICdubyBiYW5uZXInfTtgLCA5MDBfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc2hvdCgndXBkYXRlLXJlYWwtcmVhZHknKTtcclxuICAgIGF3YWl0IHN0ZXAoJ1x1NjZGNFx1NjVCMChcdTc3MUZcdTVCOUUpOmNvbXBvc2VyL1x1NEZBN1x1NjgwRlx1NEUwRFx1NTNEN1x1NkEyQVx1NUU0NVx1NjMyNFx1NTM4QihcdTRFRkJcdTUyQTFcdTUzM0FcdTUzRUZcdTc1MjgpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKGAoZnVuY3Rpb24oKXtcclxuICAgICAgICB2YXIgdGE9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNvbXBvc2VyIHRleHRhcmVhJyksIHNiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyJyk7XHJcbiAgICAgICAgdmFyIHRyPXRhP3RhLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOm51bGw7XHJcbiAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHt0YTogISF0ciAmJiB0ci5oZWlnaHQ+MzAgJiYgdHIuYm90dG9tPD13aW5kb3cuaW5uZXJIZWlnaHQsIHNiOiAhIXNiICYmIGdldENvbXB1dGVkU3R5bGUoc2IpLmRpc3BsYXkhPT0nbm9uZSd9KTtcclxuICAgICAgfSkoKWApKSBhcyBzdHJpbmc7XHJcbiAgICAgIGNvbnN0IHAgPSBKU09OLnBhcnNlKHIpIGFzIHsgdGE6IGJvb2xlYW47IHNiOiBib29sZWFuIH07XHJcbiAgICAgIHJldHVybiBbcC50YSAmJiBwLnNiLCBgY29tcG9zZXIgXHU1M0VGXHU3NTI4PSR7cC50YX0gXHU0RkE3XHU2ODBGXHU2QjYzXHU1RTM4PSR7cC5zYn1gXTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc2hvdCgnZmluYWwnKTtcclxuICAgIGZpbmlzaCgpO1xyXG4gICAgcmV0dXJuO1xyXG4gIH1cclxuXHJcbiAgLyogPT09PT09PT09PSBcdTRFMTNcdTc1Mjg6XHU0RUQzXHU1RTkzXHU5NzYyXHU2NzdGXHU3NzFGXHU1QjlFXHU1MTkyXHU3MERGKFx1NEVGQlx1NTJBMSAxNC1CO1x1OUE3MVx1NTJBOFx1NTY2OCAtLWZvcmdlLXJlYWwpXHJcbiAgICAgZW52OkhNSF9ERVNLVE9QX1VJVkVSSUZZX0ZPUkdFPXJlYWwgXHUyMTkyIGZvcmdlIFx1NjcwRFx1NTJBMVx1NEUwRFx1OEQ3MCBmaXh0dXJlLFx1NzZGNFx1OEZERVx1NjcyQ1x1NjczQVxyXG4gICAgIGdoL2FnKFx1NURGMlx1NzY3Qlx1NUY1NSBzd3NnYmwgLyBob25nZnUpXHUzMDAyXHU1M0VBXHU4QkZCOlx1NzY3Qlx1NUY1NVx1NTM2MS9cdTRFRDNcdTVFOTNcdTUyMTdcdTg4NjgvUmVsZWFzZSBcdTUyMTdcdTg4Njg7XHJcbiAgICAgXHU1MTk5XHU2NENEXHU0RjVDKFx1NTQwOFx1NUU3Ni9cdTY1QjBcdTVFRkEvXHU1M0QxXHU1RTAzKVx1NEUwRFx1ODlFNlx1NTNEMVx1MjAxNFx1MjAxNFx1OTc2Mlx1Njc3Rlx1NEZBN1x1NjcyQ1x1NUMzMVx1NjcwOVx1Nzg2RVx1OEJBNFx1NTM2MVx1OTVFOFx1MzAwMmhvc3QgXHU0RUNEXHU4RDcwIGZha2UsXHJcbiAgICAgXHU0RUQzXHU1RTkzXHU5NzYyXHU2NzdGXHU0RTBFIGhvc3QgXHU2NUUwXHU4MDI2XHU1NDA4XHUzMDAyICovXHJcbiAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX0ZPUkdFID09PSAncmVhbCcpIHtcclxuICAgIGF3YWl0IHN0ZXAoJ1x1NEVEM1x1NUU5MyhcdTc3MUZcdTVCOUUpOlx1NTNDQ1x1NUU3M1x1NTNGMFx1NzY3Qlx1NUY1NVx1NTM2MSBcdTIwMTRcdTIwMTQgZ2g9c3dzZ2JsIC8gYWc9aG9uZ2Z1JywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nXHU0RUQzXHU1RTkzJ3x8eC50ZXh0Q29udGVudD09PSdSZXBvcyc7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignYm90aCBsb2dnZWQgaW4nLCBgdmFyIGdoPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLXRlc3RpZD1cImZvcmdlLWhvc3QtZ2l0aHViXCJdJyk7XHJcbiAgICAgICAgdmFyIGFnPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLXRlc3RpZD1cImZvcmdlLWhvc3QtYXRvbWdpdFwiXScpO1xyXG4gICAgICAgIHZhciBnaE9rID0gISFnaCAmJiBnaC50ZXh0Q29udGVudC5pbmRleE9mKCdzd3NnYmwnKT49MDtcclxuICAgICAgICB2YXIgYWdPayA9ICEhYWcgJiYgYWcudGV4dENvbnRlbnQuaW5kZXhPZignaG9uZ2Z1Jyk+PTA7XHJcbiAgICAgICAgcmV0dXJuIHtvazogZ2hPayAmJiBhZ09rLCBkZXRhaWw6ICdnaD0nKyhnaD9naC50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNDApOidub25lJykrJyB8IGFnPScrKGFnP2FnLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw0MCk6J25vbmUnKX07YCwgMzBfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc2hvdCgnZm9yZ2UtcmVhbC1ob3N0cycpO1xyXG4gICAgYXdhaXQgc3RlcCgnXHU0RUQzXHU1RTkzKFx1NzcxRlx1NUI5RSk6R2l0SHViIFx1NjIxMVx1NzY4NFx1NEVEM1x1NUU5M1x1NTIxN1x1ODg2OCBcdTIyNjUxIFx1ODg0QycsIGFzeW5jICgpID0+IHtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2dpdGh1YiByZXBvcycsIGB2YXIgcm93cz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS10ZXN0aWQ9XCJmb3JnZS1yZXBvLXJvd1wiXScpLmxlbmd0aDtcclxuICAgICAgICByZXR1cm4ge29rOiByb3dzPj0xLCBkZXRhaWw6ICdyb3dzPScrcm93c307YCwgNDVfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnXHU0RUQzXHU1RTkzKFx1NzcxRlx1NUI5RSk6XHU1MjA3IEF0b21HaXQgXHUyMTkyIFx1NTIxN1x1NTFGQSBob25nZnUgXHU0RUQzXHU1RTkzKFx1NTQyQiBobWgtZGVza3RvcCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZm9yZ2UtaG9zdC1jaGlwcyAuZm9yZ2UtY2hpcCcpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J0F0b21HaXQnO30pOyBpZihjKSBjLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2F0b21naXQgcmVwb3MnLCBgdmFyIHJvd3M9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS10ZXN0aWQ9XCJmb3JnZS1yZXBvLXJvd1wiXScpKTtcclxuICAgICAgICB2YXIgaGl0ID0gcm93cy5zb21lKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ2htaC1kZXNrdG9wJyk+PTA7fSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogcm93cy5sZW5ndGg+PTEgJiYgaGl0LCBkZXRhaWw6ICdyb3dzPScrcm93cy5sZW5ndGgrKGhpdD8nIFx1NTQyQmhtaC1kZXNrdG9wJzonIFx1NjVFMGhtaC1kZXNrdG9wJyl9O2AsIDQ1XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHNob3QoJ2ZvcmdlLXJlYWwtYXRvbWdpdC1yZXBvcycpO1xyXG4gICAgYXdhaXQgc3RlcCgnXHU0RUQzXHU1RTkzKFx1NzcxRlx1NUI5RSk6XHU4RkRCXHU1MTY1IGhvbmdmdS9obWgtZGVza3RvcCBcdTIxOTIgUmVsZWFzZSBcdTUyMTdcdTg4NjhcdTU0MkIgdjAuMi4xMCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgcj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXRlc3RpZD1cImZvcmdlLXJlcG8tcm93XCJdJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignaG1oLWRlc2t0b3AnKT49MDt9KTsgdmFyIG09cj9yLnF1ZXJ5U2VsZWN0b3IoJy5mb3JnZS1tYWluJyk6bnVsbDsgaWYobSkgbS5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdyZWxlYXNlcyB3aXRoIHYwLjIuMTAnLCBgdmFyIHJvd3M9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS10ZXN0aWQ9XCJmb3JnZS1yZWxlYXNlLXJvd1wiXScpKTtcclxuICAgICAgICB2YXIgaGl0ID0gcm93cy5zb21lKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ3YwLjIuMTAnKT49MDt9KTtcclxuICAgICAgICByZXR1cm4ge29rOiByb3dzLmxlbmd0aD49MSAmJiBoaXQsIGRldGFpbDogJ3JlbGVhc2VzPScrcm93cy5sZW5ndGgrKGhpdD8nIFx1NTQyQnYwLjIuMTAnOicgXHU2NUUwdjAuMi4xMDtcdTk5OTZcdTg4NEM9Jysocm93c1swXT9yb3dzWzBdLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw1MCk6J25vbmUnKSl9O2AsIDQ1XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHNob3QoJ2ZvcmdlLXJlYWwtcmVsZWFzZXMnKTtcclxuICAgIGZpbmlzaCgpO1xyXG4gICAgcmV0dXJuO1xyXG4gIH1cclxuXHJcbiAgLyogPT09PT09PT09PSBcdTkwMUFcdTc1Mjg6XHU1RTAzXHU1QzQwXHU1MUUwXHU0RjU1KFx1NzUyOFx1NjIzN1x1NjJBNVx1OTY5Q1x1NzY4NFx1NzZGNFx1NjNBNVx1NjVBRFx1OEEwMCkgPT09PT09PT09PSAqL1xyXG4gIGF3YWl0IHN0ZXAoJ1x1NUUwM1x1NUM0MDpcdTY4MDdcdTk4OThcdTY4MEYrXHU0RTA5XHU2ODBGK2NvbXBvc2VyIFx1NTcyOFx1ODlDNlx1NTNFM1x1NTE4NShcdThGOTNcdTUxNjVcdTY4NDZcdTUzRUZcdTg5QzEpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgY29uc3QgciA9IChhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XHJcbiAgICAgIHZhciBxID0gZG9jdW1lbnQucXVlcnlTZWxlY3Rvci5iaW5kKGRvY3VtZW50KTtcclxuICAgICAgdmFyIHRiID0gcSgnLnRpdGxlYmFyJyksIHNoZWxsID0gcSgnLmFwcC1zaGVsbCcpLCBzYiA9IHEoJy5zaWRlYmFyJyksIHdzID0gcSgnLndvcmtzcGFjZScpLCB0YSA9IHEoJy5jb21wb3NlciB0ZXh0YXJlYScpO1xyXG4gICAgICB2YXIgbWlzc2luZyA9IFshdGIgJiYgJ3RpdGxlYmFyJywgIXNoZWxsICYmICdzaGVsbCcsICFzYiAmJiAnc2lkZWJhcicsICF3cyAmJiAnd29ya3NwYWNlJywgIXRhICYmICd0ZXh0YXJlYSddLmZpbHRlcihCb29sZWFuKS5qb2luKCcsJyk7XHJcbiAgICAgIGlmIChtaXNzaW5nICE9PSAnJykgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHtvazpmYWxzZSwgZGV0YWlsOidtaXNzaW5nOicrbWlzc2luZ30pO1xyXG4gICAgICB2YXIgciA9IHRhLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpLCB2aCA9IHdpbmRvdy5pbm5lckhlaWdodCwgdncgPSB3aW5kb3cuaW5uZXJXaWR0aDtcclxuICAgICAgdmFyIGhpbnQgPSBxKCcuZW1wdHktaGludC5iaWcnKTsgdmFyIGhyID0gaGludCA/IGhpbnQuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCkgOiBudWxsO1xyXG4gICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoeyBvazogci5oZWlnaHQgPiAzMCAmJiByLmJvdHRvbSA8PSB2aCAmJiByLndpZHRoID4gMTAwICYmIGhyICE9PSBudWxsICYmIGhyLnRvcCA+PSAwICYmIGhyLmJvdHRvbSA8PSB2aCxcclxuICAgICAgICBkZXRhaWw6ICd0ZXh0YXJlYSB5PScrTWF0aC5yb3VuZChyLnkpKycgaD0nK01hdGgucm91bmQoci5oZWlnaHQpKycgYm90dG9tPScrTWF0aC5yb3VuZChyLmJvdHRvbSkrJyB2aD0nK3ZoKyhociA/ICcgaGludCB5PScrTWF0aC5yb3VuZChoci55KSA6ICcgbm8taGludCcpIH0pO1xyXG4gICAgfSkoKWApKSBhcyBzdHJpbmc7XHJcbiAgICBjb25zdCBwID0gSlNPTi5wYXJzZShyKSBhcyB7IG9rOiBib29sZWFuOyBkZXRhaWw6IHN0cmluZyB9O1xyXG4gICAgcmV0dXJuIFtwLm9rID09PSB0cnVlLCBwLmRldGFpbF07XHJcbiAgfSk7XHJcblxyXG4gIGlmIChtb2RlID09PSAnZmFrZScpIHtcclxuICAgIC8qID09PT09PT09PT0gZmFrZShcdTU0MTFcdTVCRkNcdTY3ODRcdTkwMjAsSE1IX0RFU0tUT1BfVUlWRVJJRllfV0laQVJEPWZha2UpOlxyXG4gICAgICAgXHU0RjJBXHU5MDIwXHU2NzJBXHU5MTREXHU3RjZFXHU2MDAxIFx1MjE5MiBcdTU0MTFcdTVCRkNcdTUxRkFcdTczQjAgXHUyMTkyIFx1NjhDMFx1NkQ0QihcdTY3MkFcdTg4QzUpXHUyMTkyIFx1OTAwOVx1NjJFOSBcdTIxOTIgXHU1MTg1XHU3RjZFIFx1MjE5MiBcdThGREVcdTRFMEEgPT09PT09PT09PSAqL1xyXG4gICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX1dJWkFSRCA9PT0gJ2Zha2UnKSB7XHJcbiAgICAgIGF3YWl0IHN0ZXAoJ1x1NTQxMVx1NUJGQzpcdTk5OTZcdTU0MkZcdTVGMzlcdTUxRkFcdTZCMjJcdThGQ0VcdTk4NzUoXHU1RjAwXHU1OUNCXHU5MTREXHU3RjZFL1x1NkYxNFx1NzkzQVx1NTE2NVx1NTNFMyknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3dpemFyZCBvdmVybGF5JywgYHZhciBvPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3ZlcmxheScpO1xyXG4gICAgICAgICAgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NUYwMFx1NTlDQlx1OTE0RFx1N0Y2RSc7fSk7XHJcbiAgICAgICAgICByZXR1cm4ge29rOiAhIW8gJiYgISFiLCBkZXRhaWw6IG8gPyAnb3ZlcmxheStcdTVGMDBcdTU5Q0JcdTkxNERcdTdGNkUnIDogJ25vIG92ZXJsYXknfTtgLCAxMl8wMDApO1xyXG4gICAgICAgIGF3YWl0IHNob3QoJ3dpemFyZC13ZWxjb21lJyk7XHJcbiAgICAgICAgcmV0dXJuIHc7XHJcbiAgICAgIH0pO1xyXG4gICAgICBhd2FpdCBzdGVwKCdcdTU0MTFcdTVCRkM6XHU1RjAwXHU1OUNCXHU5MTREXHU3RjZFXHUyMTkyXHU2OEMwXHU2RDRCKFx1NEYyQVx1OTAyMFx1NjcyQVx1ODhDNSlcdTIxOTJcdTY3MkFcdTg4QzVcdTUzNzNcdTgxRUFcdTUyQThcdTVCODlcdTg4QzVcdTk4NzUoXHU4QkY0XHU2NjBFXHU2QTJBXHU1RTQ1K1x1NTIwN1x1NjM2Mlx1OTRGRVx1NjNBNSknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1RjAwXHU1OUNCXHU5MTREXHU3RjZFJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2F1dG8gaW5zdGFsbCBwYWdlJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1pbnN0YWxsJyk7XHJcbiAgICAgICAgICBpZighcCkgcmV0dXJuIHtvazpmYWxzZSwgZGV0YWlsOidub3Qgb24gaW5zdGFsbCd9O1xyXG4gICAgICAgICAgdmFyIHQ9cC50ZXh0Q29udGVudDtcclxuICAgICAgICAgIHZhciBub3RlPXQuaW5kZXhPZignXHU2NzJBXHU2OEMwXHU2RDRCXHU1MjMwIGhtaCBDTEksXHU1REYyXHU4MUVBXHU1MkE4XHU1RjAwXHU1OUNCXHU1Qjg5XHU4OEM1Jyk+PTA7XHJcbiAgICAgICAgICB2YXIgbDE9dC5pbmRleE9mKCdcdTY1MzlcdTc1MjhcdTUxODVcdTdGNkVcdTdDQkVcdTdCODBcdTUxODVcdTY4MzgnKT49MCwgbDI9dC5pbmRleE9mKCdcdTZGMTRcdTc5M0FcdTZBMjFcdTVGMEYnKT49MDtcclxuICAgICAgICAgIHZhciBiYXI9ISFwLnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtcHJvZ3Jlc3MnKTtcclxuICAgICAgICAgIHZhciBzZWw9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLXNlbGVjdCcpO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogbm90ZSYmbDEmJmwyJiZiYXImJiFzZWwsIGRldGFpbDogJ25vdGU9Jytub3RlKycgXHU1MTg1XHU3RjZFXHU5NEZFXHU2M0E1PScrbDErJyBcdTZGMTRcdTc5M0FcdTk0RkVcdTYzQTU9JytsMisnIGJhcj0nK2JhcisnIHNlbGVjdExlYWs9JyshIXNlbH07YCwgMTJfMDAwKTtcclxuICAgICAgICBhd2FpdCBzaG90KCd3aXphcmQtYXV0by1pbnN0YWxsJyk7XHJcbiAgICAgICAgcmV0dXJuIHc7XHJcbiAgICAgIH0pO1xyXG4gICAgICBhd2FpdCBzdGVwKCdcdTU0MTFcdTVCRkM6XHU2QTJBXHU1RTQ1XCJcdTY1MzlcdTc1MjhcdTUxODVcdTdGNkVcdTdDQkVcdTdCODBcdTUxODVcdTY4MzhcIlx1MjE5Mlx1OTE0RFx1N0Y2RVx1OERGM1x1OEZDN1x1MjE5Mlx1NUI4Q1x1NjIxMFx1OTg3NVx1MjE5Mlx1NUYwMFx1NTlDQlx1NEY3Rlx1NzUyOFx1MjE5Mlx1NTE3M1x1OTVFRFx1NEUxNFx1NURGMlx1OEZERVx1NjNBNScsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1wYWdlLWluc3RhbGwgLndpemFyZC1hbHQtbGluaycpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1NjUzOVx1NzUyOFx1NTE4NVx1N0Y2RVx1N0NCRVx1N0I4MFx1NTE4NVx1NjgzOCcpPj0wO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICAvLyBcdTkxNERcdTdGNkVcdTk4NzU6ZmFrZSBwcm92aWRlcnMgXHU1REYyXHU2NzA5XHU1QkM2XHU5NEE1IFx1MjE5MiBcdTgxRUFcdTUyQThcdThERjNcdThGQzc7XHU1MTVDXHU1RTk1XHU3MEI5XCJcdThERjNcdThGQzdcIlxyXG4gICAgICAgIGF3YWl0IHdhaXRGb3IoJ2NvbmZpZyBvciBkb25lJywgYHZhciBkPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1kb25lJyk7XHJcbiAgICAgICAgICBpZihkKSByZXR1cm4ge29rOnRydWUsIGRldGFpbDonZG9uZSd9O1xyXG4gICAgICAgICAgdmFyIGM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLWNvbmZpZycpO1xyXG4gICAgICAgICAgaWYoYyl7IHZhciBzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1OERGM1x1OEZDNycpPj0wO30pOyBpZihzKSBzLmNsaWNrKCk7IH1cclxuICAgICAgICAgIHJldHVybiB7b2s6ZmFsc2UsIGRldGFpbDond2FpdGluZyd9O2AsIDE1XzAwMCk7XHJcbiAgICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2RvbmUgcGFnZScsIGB2YXIgZD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtZG9uZScpO1xyXG4gICAgICAgICAgdmFyIHQ9ZD9kLnRleHRDb250ZW50OicnO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogISFkICYmIHQuaW5kZXhPZignXHU1QzMxXHU3RUVBJyk+PTAgJiYgdC5pbmRleE9mKCdcdTUxNzFcdTRFQUInKT49MCwgZGV0YWlsOiB0LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw2MCl9O2AsIDhfMDAwKTtcclxuICAgICAgICBhd2FpdCBzaG90KCd3aXphcmQtZG9uZScpO1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NUYwMFx1NTlDQlx1NEY3Rlx1NzUyOCc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgIGNvbnN0IGNsb3NlZCA9IGF3YWl0IHdhaXRGb3IoJ3dpemFyZCBjbG9zZWQgKyBjb25uZWN0ZWQnLCBgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3ZlcmxheScpICYmICEhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmhvc3QtZG90Lm9uJyksXHJcbiAgICAgICAgICBkZXRhaWw6ICdvdmVybGF5PScrKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3ZlcmxheScpPydvcGVuJzonY2xvc2VkJykrJyBkb3Q9JysoZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmhvc3QtZG90Lm9uJyk/J29uJzonb2ZmJyl9O2AsIDEwXzAwMCk7XHJcbiAgICAgICAgcmV0dXJuIFt3WzBdICYmIGNsb3NlZFswXSwgYGRvbmU6ICR7d1sxXX07ICR7Y2xvc2VkWzFdfWBdO1xyXG4gICAgICB9KTtcclxuICAgIH1cclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU5OTk2XHU4REQxXHU1RjE1XHU1QkZDXHU1QzQyID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1NUYxNVx1NUJGQ1x1NUM0MjpcdTZGMTRcdTc5M0FcdTZBMjFcdTVGMEZcdTYzRDBcdTc5M0FcdTUxRkFcdTczQjBcdTVFNzZcdTUzRUZcdTUxNzNcdTk1RUQnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdndWlkZScsIGB2YXIgZz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcucnVudGltZS1ndWlkZScpOyByZXR1cm4ge29rOiAhIWcsIGRldGFpbDogZyA/ICdzaG93bicgOiAnbm90IHNob3duJ307YCwgOF8wMDApO1xyXG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XHJcbiAgICAgICAgdmFyIGJ0bnMgPSBbXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5ydW50aW1lLWd1aWRlIGJ1dHRvbicpKTtcclxuICAgICAgICB2YXIgYiA9IGJ0bnMuZmluZChmdW5jdGlvbih4KXsgcmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU2RjE0XHU3OTNBJykgPj0gMDsgfSk7XHJcbiAgICAgICAgaWYgKGIpIGIuY2xpY2soKTtcclxuICAgICAgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignZ3VpZGUgZ29uZScsIGByZXR1cm4ge29rOiAhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnJ1bnRpbWUtZ3VpZGUnKSwgZGV0YWlsOiBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcucnVudGltZS1ndWlkZScpID8gJ3N0aWxsJyA6ICdkaXNtaXNzZWQnfTtgLCA1XzAwMCk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREKEN0cmwrTikgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnQ3RybCtOIFx1NjVCMFx1NUVGQVx1NEYxQVx1OEJERCxcdThGOTNcdTUxNjVcdTY4NDZcdTUzRUZcdTc1MjgnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J24nLCBjdHJsS2V5OnRydWUsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcigndGV4dGFyZWEgZW5hYmxlZCcsIGB2YXIgdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY29tcG9zZXIgdGV4dGFyZWEnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXQgJiYgdC5kaXNhYmxlZCA9PT0gZmFsc2UgJiYgKHQucGxhY2Vob2xkZXJ8fCcnKS5pbmRleE9mKCdcdTYzQ0ZcdThGRjBcdTc2RUVcdTY4MDcnKSA+PSAwLCBkZXRhaWw6IHQgPyAoJ2Rpc2FibGVkPScrdC5kaXNhYmxlZCsnIHBoPScrKHQucGxhY2Vob2xkZXJ8fCcnKS5zbGljZSgwLDIwKSkgOiAnbm8gdGEnfTtgLCA1XzAwMCk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU1M0QxXHU5MDAxXHU0RUZCXHU1MkExIFx1MjE5MiBcdTc1MjhcdTYyMzdcdThGNkVcdTUxRkFcdTczQjAoXHU0RTE0XHU0RUM1XHU0RTAwXHU2NzYxLFx1NTNDQ1x1NkQ4OFx1NjA2Rlx1NTZERVx1NUY1MikgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU4RjkzXHU1MTY1XHU1RTc2XHU1M0QxXHU5MDAxXHU0RUZCXHU1MkExLFx1NzUyOFx1NjIzN1x1NkQ4OFx1NjA2Rlx1NEUwQVx1NUM0Rlx1NEUxNFx1NEUwRFx1OTFDRFx1NTkwRCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQgdHlwZUludG8oJy5jb21wb3NlciB0ZXh0YXJlYScsICdcdTlBOENcdTY1MzZcdTRFRkJcdTUyQTE6XHU1MTk5XHU1MTY1XHU0RTAwXHU0RTJBXHU2NTg3XHU0RUY2Jyk7XHJcbiAgICAgIGF3YWl0IHNsZWVwKDIwMCk7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXtcclxuICAgICAgICB2YXIgYnRucyA9IFtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNvbXBvc2VyIGJ1dHRvbicpKTtcclxuICAgICAgICB2YXIgYiA9IGJ0bnMuZmluZChmdW5jdGlvbih4KXsgcmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpID09PSAnXHU1M0QxXHU5MDAxJzsgfSk7XHJcbiAgICAgICAgaWYgKGIpIGIuY2xpY2soKTtcclxuICAgICAgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignZXhhY3RseSBvbmUgdXNlciB0dXJuJywgYHZhciB0cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50dXJuLnVzZXInKSkuZmlsdGVyKGZ1bmN0aW9uKHgpeyByZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTlBOENcdTY1MzZcdTRFRkJcdTUyQTEnKSA+PSAwOyB9KTtcclxuICAgICAgICByZXR1cm4ge29rOiB0cy5sZW5ndGggPT09IDEsIGRldGFpbDogJ2NvdW50PScrdHMubGVuZ3RoKycgdGV4dD0nKyh0c1swXT90c1swXS50ZXh0Q29udGVudC5zbGljZSgwLDMwKTonbm9uZScpfTtgLCA4XzAwMCk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU1REU1XHU1MTc3XHU1MzYxKHJlYWRfZmlsZSBcdTVCOENcdTYyMTApID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1NURFNVx1NTE3N1x1NjI5OFx1NTNFMFx1NTM2MTpyZWFkX2ZpbGUgXHU2MjY3XHU4ODRDXHU1RTc2XHU1QjhDXHU2MjEwJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcigndG9vbCBjYXJkJywgYHZhciBjPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnRvb2wtY2FyZCcpKTtcclxuICAgICAgICB2YXIgZG9uZSA9IGMuZmlsdGVyKGZ1bmN0aW9uKHgpeyByZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdyZWFkX2ZpbGUnKSA+PSAwICYmIHgudGV4dENvbnRlbnQuaW5kZXhPZignIyBkZW1vJykgPj0gMDsgfSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogZG9uZS5sZW5ndGggPj0gMSwgZGV0YWlsOiAnY2FyZHM9JytjLmxlbmd0aCsnIGRvbmU9Jytkb25lLmxlbmd0aH07YCwgOF8wMDApO1xyXG4gICAgICByZXR1cm4gdztcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTVCQTFcdTYyNzlcdTdFQjVcdTUyMDdcdTcyNDcoXHU3NTI4XHU2MjM3XHU2MkE1XHU5NjlDXHU2ODM4XHU1RkMzXHU0RTRCXHU0RTAwKSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTVCQTFcdTYyNzk6YXBwcm92YWwgXHU1MzYxXHU1MUZBXHU3M0IwKFx1N0I0OVx1NUY4NVx1NEVCQVx1NURFNVx1NjI3OVx1NTFDNiknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IHNob3QoJ2FwcHJvdmFsLXBlbmRpbmcnKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2FwcHJvdmFsIGNhcmQnLCBgdmFyIGE9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmFwcHJvdmFsLWNhcmQnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWEgJiYgYS50ZXh0Q29udGVudC5pbmRleE9mKCdcdTk3MDBcdTg5ODFcdTVCQTFcdTYyNzknKSA+PSAwLCBkZXRhaWw6IGEgPyBhLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCwgNjApIDogJ25vIGFwcHJvdmFsIGNhcmQnfTtgLCA4XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ1x1NUJBMVx1NjI3OTpcdTcwQjlcdTYyNzlcdTUxQzYgXHUyMTkyIFx1NEVGQlx1NTJBMVx1N0VFN1x1N0VFRFx1NTIzMFx1NEVBNFx1NEVEOFx1NzI2OStcdTZDNDdcdTYwM0InLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXtcclxuICAgICAgICB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5hcHByb3ZhbC1jYXJkIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpeyByZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU2Mjc5XHU1MUM2JzsgfSk7XHJcbiAgICAgICAgaWYgKGIpIGIuY2xpY2soKTtcclxuICAgICAgfSkoKWApO1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignYXJ0aWZhY3Qrc3VtJywgYHZhciBhcnQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmFydGlmYWN0LWNhcmQnKTtcclxuICAgICAgICB2YXIgc3VtPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy50dXJuLXN1bScpO1xyXG4gICAgICAgIHZhciBhc3Q9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudHVybicpKS5maWx0ZXIoZnVuY3Rpb24oeCl7IHJldHVybiB4LmNsYXNzTmFtZS5pbmRleE9mKCd1c2VyJyk8MCAmJiB4LnRleHRDb250ZW50LmluZGV4T2YoJ2VjaG86Jyk+PTA7IH0pO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYXJ0ICYmICEhc3VtICYmIGFzdC5sZW5ndGg+PTEsIGRldGFpbDogJ2FydGlmYWN0PScrKGFydD9hcnQudGV4dENvbnRlbnQuc2xpY2UoMCwzMCk6J25vbmUnKSsnIHN1bT0nKyhzdW0/c3VtLnRleHRDb250ZW50Oidub25lJykrJyBhbnN3ZXJlZD0nK2FzdC5sZW5ndGh9O2AsIDEyXzAwMCk7XHJcbiAgICAgIGF3YWl0IHNob3QoJ3J1bi1jb21wbGV0ZWQnKTtcclxuICAgICAgcmV0dXJuIHc7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU1Mzg2XHU1M0YyXHU0RjFBXHU4QkREXHU1MTg1XHU1QkI5KFx1NzUyOFx1NjIzN1x1NjJBNVx1OTY5Q1wiXHU3NzBCXHU0RTBEXHU1MjMwXHU1MTg1XHU1QkI5XCIpID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1NzBCOVx1NTFGQlx1NTM4Nlx1NTNGMlx1NEYxQVx1OEJERCBcdTIxOTIgdHJhbnNjcmlwdCBcdTUxODVcdTVCQjlcdTUzRUZcdTg5QzEnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGl0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zZXNzaW9uLWl0ZW0nKTsgaWYgKGl0KSBpdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdoaXN0b3J5IHR1cm5zJywgYHZhciB0cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50dXJuJykpO1xyXG4gICAgICAgIHJldHVybiB7b2s6IHRzLmxlbmd0aCA+PSAyLCBkZXRhaWw6ICd0dXJucz0nK3RzLmxlbmd0aCsnIGZpcnN0PScrKHRzWzBdP3RzWzBdLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw0MCk6J25vbmUnKX07YCwgOF8wMDApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NEU5NFx1OTg3NVx1N0I3RSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdEb2NrOk92ZXJ2aWV3IFx1NjU3MFx1NjM2RVx1ODg0QycsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J092ZXJ2aWV3Jzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdvdmVydmlldyByb3dzJywgYHZhciByb3dzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stcm93JykpO1xyXG4gICAgICAgIHZhciB2ZXIgPSByb3dzLmZpbmQoZnVuY3Rpb24ocil7IHJldHVybiByLnRleHRDb250ZW50LmluZGV4T2YoJ3J1bnRpbWUgXHU3MjQ4XHU2NzJDJyk+PTA7IH0pO1xyXG4gICAgICAgIHJldHVybiB7b2s6IHJvd3MubGVuZ3RoID49IDUgJiYgISF2ZXIsIGRldGFpbDogJ3Jvd3M9Jytyb3dzLmxlbmd0aCsodmVyPycgdmVyPScrdmVyLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw0MCk6JycpfTtgLCA2XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ0RvY2s6RmlsZXMgXHU2RDRGXHU4OUM4K1x1NjU4N1x1NEVGNlx1OTg4NFx1ODlDOCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J1x1NjU4N1x1NEVGNid8fHgudGV4dENvbnRlbnQ9PT0nRmlsZXMnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2ZzIHJvd3MnLCBgdmFyIHJvd3M9ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmZzLXJvdycpLmxlbmd0aDtcclxuICAgICAgICByZXR1cm4ge29rOiByb3dzID49IDEsIGRldGFpbDogJ3Jvd3M9Jytyb3dzfTtgLCA2XzAwMCk7XHJcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgIC8vIFx1NjgzOVx1NzZFRVx1NUY1NVx1NTNFQVx1NjcwOVx1NURFNVx1NEY1Q1x1NTMzQVx1NzZFRVx1NUY1NShmYWtlIFx1NEUwRVx1NzcxRlx1NUI5RSBydW50aW1lIFx1NTQwQ1x1NUY2Mik6XHU1MTQ4XHU4RkRCXHU3NkVFXHU1RjU1LFx1NTE4RFx1NzBCOVx1NjU4N1x1NEVGNlxyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBkPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmZzLXJvdycpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ2RlbW8td29ya3NwYWNlJyk+PTAgfHwgeC50ZXh0Q29udGVudC5pbmRleE9mKCdcdUQ4M0RcdURDQzEnKT49MDt9KTsgaWYoZCkgZC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IHcyID0gYXdhaXQgd2FpdEZvcignZmlsZSByb3dzJywgYHZhciByb3dzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmZzLXJvdycpKTtcclxuICAgICAgICByZXR1cm4ge29rOiByb3dzLnNvbWUoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignUkVBRE1FJyk+PTA7fSksIGRldGFpbDogJ3Jvd3M9Jytyb3dzLmxlbmd0aH07YCwgNl8wMDApO1xyXG4gICAgICBpZiAoIXcyWzBdKSByZXR1cm4gdzI7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGY9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZnMtcm93JykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignUkVBRE1FJyk+PTA7fSk7IGlmKGYpIGYuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignZmlsZSBwcmV2aWV3JywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5mcy1wcmV2aWV3Jyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFwICYmIHAudGV4dENvbnRlbnQuaW5kZXhPZignZGVtbyB3b3Jrc3BhY2UnKSA+PSAwLCBkZXRhaWw6IHAgPyBwLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw0MCkgOiAnbm8gcHJldmlldyd9O2AsIDZfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnRG9jazpEaWZmIFx1NTNEOFx1NjZGNFx1ODg0QycsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J1x1NTNEOFx1NjZGNCd8fHgudGV4dENvbnRlbnQ9PT0nRGlmZic7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignZGlmZiByb3dzJywgYHZhciByb3dzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kaWZmLXJvdycpLmxlbmd0aDtcclxuICAgICAgICByZXR1cm4ge29rOiByb3dzID49IDEsIGRldGFpbDogJ2RpZmYgcm93cz0nK3Jvd3N9O2AsIDZfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnRG9jazpFdmlkZW5jZSBcdThCQTRcdTc3RTVcdTY1NzBcdTYzNkUnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdcdThCQzFcdTYzNkUnfHx4LnRleHRDb250ZW50PT09J0V2aWRlbmNlJzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdldmlkZW5jZSByb3dzJywgYHZhciByb3dzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stcm93JykpO1xyXG4gICAgICAgIHZhciBtZW0gPSByb3dzLmZpbmQoZnVuY3Rpb24ocil7IHJldHVybiByLnRleHRDb250ZW50LmluZGV4T2YoJ1x1OEJCMFx1NUZDNlx1NUM0MicpPj0wIHx8IHIudGV4dENvbnRlbnQuaW5kZXhPZignTWVtb3J5IGxheWVycycpPj0wOyB9KTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIW1lbSAmJiBtZW0udGV4dENvbnRlbnQuaW5kZXhPZignMycpID49IDAsIGRldGFpbDogbWVtID8gbWVtLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykgOiAnbm8gbWVtb3J5IHJvdyd9O2AsIDZfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnRG9jazpMb2dzIFx1OTc2Mlx1Njc3RihcdTdBN0FcdTYwMDFcdTYzRDBcdTc5M0EpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nXHU2NUU1XHU1RkQ3J3x8eC50ZXh0Q29udGVudD09PSdMb2dzJzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdsb2dzIHBhbmUnLCBgdmFyIGw9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmxvZ3MtbGlzdCcpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhbCwgZGV0YWlsOiBsID8gKCdyb3dzPScrbC5xdWVyeVNlbGVjdG9yQWxsKCcubG9nLXJvdycpLmxlbmd0aCkgOiAnbm8gbG9ncyBsaXN0J307YCwgNV8wMDApO1xyXG4gICAgICByZXR1cm4gdztcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpEb2NrOlx1OEZEQ1x1N0EwQlx1OTg3NVx1N0I3RShcdTYyNEJcdTY3M0FcdThGRENcdTdBMEJcdTYzQTdcdTUyMzZcdTk3NjJcdTY3N0YrXHU1RjAwXHU2NzNBXHU4MUVBXHU1NDJGXHU4ODRDKSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdEb2NrOlx1OEZEQ1x1N0EwQlx1OTg3NVx1N0I3RShcdTYyNEJcdTY3M0FcdThGRENcdTdBMEJcdTYzQTdcdTUyMzZcdTk3NjJcdTY3N0YpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nXHU4RkRDXHU3QTBCJ3x8eC50ZXh0Q29udGVudD09PSdSZW1vdGUnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ3JlbW90ZSBwYW5lJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5kb2NrLWJvZHknKTtcclxuICAgICAgICB2YXIgdCA9IHAgPyBwLnRleHRDb250ZW50IDogJyc7XHJcbiAgICAgICAgdmFyIG9rVCA9IHQuaW5kZXhPZignXHU2MjRCXHU2NzNBXHU4RkRDXHU3QTBCXHU2M0E3XHU1MjM2Jyk+PTAgfHwgdC5pbmRleE9mKCdQaG9uZSByZW1vdGUnKT49MDtcclxuICAgICAgICB2YXIgb2tBID0gdC5pbmRleE9mKCdcdTVGMDBcdTY3M0FcdTgxRUFcdTU0MkYnKT49MCB8fCB0LmluZGV4T2YoJ0F1dG9zdGFydCcpPj0wO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhcCAmJiBva1QgJiYgb2tBLCBkZXRhaWw6IHQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDYwKX07YCwgNl8wMDApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOkRvY2s6XHU0RUQzXHU1RTkzXHU5ODc1XHU3QjdFKFx1NEVGQlx1NTJBMSAxNC1COmdoL2FnIFx1NzY3Qlx1NUY1NStcdTRFRDNcdTVFOTMvUFIvUmVsZWFzZTtcclxuICAgICAgIGZpeHR1cmUgPSBnaXRodWIgXHU1REYyXHU3NjdCXHU1RjU1KHN3c2dibCkgKyBhdG9tZ2l0IFx1NjcyQVx1ODhDNSBcdTIxOTIgXHU0RTAwXHU0RTJBIGZpeHR1cmUgXHU4OTg2XHU3NkQ2XHJcbiAgICAgICBcdTMwMENcdTc2N0JcdTVGNTVcdTUzNjFcdTMwMERcdTRFMEVcdTMwMENcdTY1RTAgQ0xJIFx1NjMwN1x1NUYxNVx1NjAwMVx1MzAwRFx1NEUyNFx1NEUyQVx1OUE4Q1x1NjUzNlx1NTczQVx1NjY2RjtcdTUxOTlcdTY0Q0RcdTRGNUNcdTUzRUFcdTUyMzBcdTc4NkVcdThCQTRcdTUzNjEsXHU0RTBEXHU3NzFGXHU1M0QxKSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTRFRDNcdTVFOTM6XHU1M0NDXHU1RTczXHU1M0YwXHU3MkI2XHU2MDAxXHU1MzYxKEdpdEh1YiBcdTVERjJcdTc2N0JcdTVGNTUgc3dzZ2JsO0F0b21HaXQgXHU2NzJBXHU4OEM1IFx1MjE5MiBcdTRFMDBcdTg4NENcdTVCODlcdTg4QzVcdTYzMDdcdTVGMTUsXHU2NUUwXHU4MUVBXHU1MkE4XHU1Qjg5XHU4OEM1KScsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J1x1NEVEM1x1NUU5Myd8fHgudGV4dENvbnRlbnQ9PT0nUmVwb3MnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2ZvcmdlIGhvc3QgY2FyZHMnLCBgdmFyIHBhbmU9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignW2RhdGEtdGVzdGlkPVwiZm9yZ2UtcGFuZVwiXScpO1xyXG4gICAgICAgIGlmKCFwYW5lKSByZXR1cm4ge29rOmZhbHNlLCBkZXRhaWw6J25vIHBhbmUnfTtcclxuICAgICAgICB2YXIgZ2g9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignW2RhdGEtdGVzdGlkPVwiZm9yZ2UtaG9zdC1naXRodWJcIl0nKTtcclxuICAgICAgICB2YXIgYWc9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignW2RhdGEtdGVzdGlkPVwiZm9yZ2UtaG9zdC1hdG9tZ2l0XCJdJyk7XHJcbiAgICAgICAgdmFyIGdoT2sgPSAhIWdoICYmIGdoLnRleHRDb250ZW50LmluZGV4T2YoJ3N3c2dibCcpPj0wICYmIChnaC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTVERjJcdTc2N0JcdTVGNTUnKT49MCB8fCBnaC50ZXh0Q29udGVudC5pbmRleE9mKCdTaWduZWQgaW4nKT49MCk7XHJcbiAgICAgICAgLy8gXHU2NzJBXHU4OEM1IENMSTpcdTYzMDdcdTVGMTVcdTY1ODdcdTY4NDhcdTU0MkIgQ0xJIFx1NTQwRCArIFx1NjVFMFx1NzY3Qlx1NUY1NVx1NjMwOVx1OTRBRShcdTRFMERcdTgxRUFcdTUyQThcdTg4QzUsXHU1M0VBXHU2MzA3XHU4REVGKVxyXG4gICAgICAgIHZhciBhZ0hpbnQgPSAhIWFnICYmIChhZy50ZXh0Q29udGVudC5pbmRleE9mKCdcdTY3MkFcdTY4QzBcdTZENEJcdTUyMzAnKT49MCB8fCBhZy50ZXh0Q29udGVudC5pbmRleE9mKCdDTEkgbm90IGRldGVjdGVkJyk+PTApO1xyXG4gICAgICAgIHZhciBhZ05vSW5zdGFsbEJ0biA9ICEhYWcgJiYgYWcucXVlcnlTZWxlY3RvckFsbCgnYnV0dG9uJykubGVuZ3RoPT09MDtcclxuICAgICAgICByZXR1cm4ge29rOiBnaE9rICYmIGFnSGludCAmJiBhZ05vSW5zdGFsbEJ0biwgZGV0YWlsOiAnZ2g9JysoZ2g/Z2gudGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDQ0KTonbm9uZScpKycgfCBhZz0nKyhhZz9hZy50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNDQpOidub25lJyl9O2AsIDZfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnXHU0RUQzXHU1RTkzOlx1NjIxMVx1NzY4NFx1NEVEM1x1NUU5M1x1NTIxN1x1ODg2OCArIFx1ODg0Q1x1NTE4NVx1NEUwOVx1NTJBOFx1NEY1QyhcdTUxNEJcdTk2ODYvXHU2RDRGXHU4OUM4XHU1NjY4L1x1OEJBOSBobWggXHU1OTA0XHU3NDA2KSxcdTcwQjlcdTUxRkJcdThGREJcdTRFRDNcdTVFOTNcdThCRTZcdTYwQzUnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdyZXBvIHJvd3MnLCBgdmFyIHJvd3M9ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtdGVzdGlkPVwiZm9yZ2UtcmVwby1yb3dcIl0nKS5sZW5ndGg7XHJcbiAgICAgICAgcmV0dXJuIHtvazogcm93cz49MSwgZGV0YWlsOiAncm93cz0nK3Jvd3N9O2AsIDZfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgY29uc3QgYWN0cyA9IChhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciByPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLXRlc3RpZD1cImZvcmdlLXJlcG8tcm93XCJdJyk7XHJcbiAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHI/W10uc2xpY2UuY2FsbChyLnF1ZXJ5U2VsZWN0b3JBbGwoJy5mb3JnZS1hY3Rpb25zIGJ1dHRvbicpKS5tYXAoZnVuY3Rpb24oYil7cmV0dXJuIGIudGV4dENvbnRlbnQ7fSk6W10pOyB9KSgpYCkpIGFzIHN0cmluZztcclxuICAgICAgY29uc3QgaGFzQ2xvbmUgPSBhY3RzLmluZGV4T2YoJ1x1NTE0Qlx1OTY4NicpPj0wIHx8IGFjdHMuaW5kZXhPZignQ2xvbmUnKT49MDtcclxuICAgICAgY29uc3QgaGFzQXNrID0gYWN0cy5pbmRleE9mKCdobWgnKT49MDtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgcj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCdbZGF0YS10ZXN0aWQ9XCJmb3JnZS1yZXBvLXJvd1wiXSAuZm9yZ2UtbWFpbicpOyBpZihyKSByLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgdzIgPSBhd2FpdCB3YWl0Rm9yKCdyZXBvIGRldGFpbCcsIGB2YXIgcGFuZT1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCdbZGF0YS10ZXN0aWQ9XCJmb3JnZS1wYW5lXCJdJyk7XHJcbiAgICAgICAgdmFyIHQgPSBwYW5lID8gcGFuZS50ZXh0Q29udGVudCA6ICcnO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhcGFuZSAmJiB0LmluZGV4T2YoJ1BSJyk+PTAgJiYgdC5pbmRleE9mKCdSZWxlYXNlJyk+PTAsIGRldGFpbDogdC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNjApfTtgLCA2XzAwMCk7XHJcbiAgICAgIHJldHVybiBbdzJbMF0gJiYgaGFzQ2xvbmUgJiYgaGFzQXNrLCBgJHt3MlsxXX07IFx1NTJBOFx1NEY1Qz0ke2FjdHMuc2xpY2UoMCwgNjApfWBdO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdcdTRFRDNcdTVFOTM6UFIgXHU1MjE3XHU4ODY4XHU3MEI5XHU1NDA4XHU1RTc2IFx1MjE5MiBcdTc4NkVcdThCQTRcdTUzNjFcdTUxRkFcdTczQjAoXHU1NDA4XHU1RTc2XHU2NUI5XHU1RjBGXHU5RUQ4XHU4QkE0IHNxdWFzaClcdTIxOTIgXHU1M0Q2XHU2RDg4XHU0RTBEXHU3NzFGXHU1M0QxJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcigncHIgcm93cycsIGB2YXIgcm93cz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS10ZXN0aWQ9XCJmb3JnZS1wci1yb3dcIl0nKS5sZW5ndGg7XHJcbiAgICAgICAgcmV0dXJuIHtvazogcm93cz49MSwgZGV0YWlsOiAncHIgcm93cz0nK3Jvd3N9O2AsIDZfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgcj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCdbZGF0YS10ZXN0aWQ9XCJmb3JnZS1wci1yb3dcIl0nKTtcclxuICAgICAgICB2YXIgYj1bXS5zbGljZS5jYWxsKHIucXVlcnlTZWxlY3RvckFsbCgnYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU1NDA4XHU1RTc2Jyk+PTB8fHgudGV4dENvbnRlbnQuaW5kZXhPZignTWVyZ2UnKT49MDt9KTtcclxuICAgICAgICBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgdzIgPSBhd2FpdCB3YWl0Rm9yKCdtZXJnZSBjb25maXJtIGNhcmQnLCBgdmFyIGM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignW2RhdGEtdGVzdGlkPVwiZm9yZ2UtbWVyZ2UtY29uZmlybVwiXScpO1xyXG4gICAgICAgIHZhciByYWRpbyA9IGMgPyBjLnF1ZXJ5U2VsZWN0b3IoJ2lucHV0W3R5cGU9cmFkaW9dOmNoZWNrZWQnKSA6IG51bGw7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFjICYmICEhcmFkaW8sIGRldGFpbDogYyA/ICdcdTc4NkVcdThCQTRcdTUzNjErXHU2NUI5XHU1RjBGXHU1MzU1XHU5MDA5KCcrcmFkaW8udmFsdWUrJyknIDogJ25vIGNhcmQnfTtgLCA1XzAwMCk7XHJcbiAgICAgIGlmICghdzJbMF0pIHJldHVybiB3MjtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCdbZGF0YS10ZXN0aWQ9XCJmb3JnZS1tZXJnZS1jb25maXJtXCJdJyk7XHJcbiAgICAgICAgdmFyIGI9W10uc2xpY2UuY2FsbChjLnF1ZXJ5U2VsZWN0b3JBbGwoJ2J1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1NTNENlx1NkQ4OCcpPj0wfHx4LnRleHRDb250ZW50LmluZGV4T2YoJ0NhbmNlbCcpPj0wO30pO1xyXG4gICAgICAgIGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignY29uZmlybSBkaXNtaXNzZWQnLCBgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLXRlc3RpZD1cImZvcmdlLW1lcmdlLWNvbmZpcm1cIl0nKSwgZGV0YWlsOidjbG9zZWQnfTtgLCA1XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ1x1NEVEM1x1NUU5MzpSZWxlYXNlIFx1NTMzQVx1NUM1NVx1NzkzQVx1NzI0OFx1NjcyQ1x1NTIxN1x1ODg2OChmaXh0dXJlIFx1NTQyQiB2MC4yLjEwKSsgXHU2NUIwXHU1RUZBXHU4ODY4XHU1MzU1XHU1RjM5XHU1QzQyKHRhZyBcdTVGQzVcdTU4NkJcdTk1RTgpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcigncmVsZWFzZSByb3dzJywgYHZhciByb3dzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtdGVzdGlkPVwiZm9yZ2UtcmVsZWFzZS1yb3dcIl0nKSk7XHJcbiAgICAgICAgdmFyIGhhcyA9IHJvd3Muc29tZShmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCd2MC4yLjEwJyk+PTA7fSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogcm93cy5sZW5ndGg+PTEgJiYgaGFzLCBkZXRhaWw6ICdyb3dzPScrcm93cy5sZW5ndGgrKGhhcz8nIFx1NTQyQnYwLjIuMTAnOicgXHU2NUUwdjAuMi4xMCcpfTtgLCA2XzAwMCk7XHJcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHBhbmU9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignW2RhdGEtdGVzdGlkPVwiZm9yZ2UtcGFuZVwiXScpO1xyXG4gICAgICAgIHZhciBiPVtdLnNsaWNlLmNhbGwocGFuZS5xdWVyeVNlbGVjdG9yQWxsKCdidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTUzRDFcdTVFMDNcdTY1QjBcdTcyNDhcdTY3MkMnKT49MHx8eC50ZXh0Q29udGVudC5pbmRleE9mKCdOZXcgcmVsZWFzZScpPj0wO30pO1xyXG4gICAgICAgIGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCB3MiA9IGF3YWl0IHdhaXRGb3IoJ3JlbGVhc2UgZm9ybScsIGB2YXIgZj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCdbZGF0YS10ZXN0aWQ9XCJmb3JnZS1mb3JtXCJdJyk7XHJcbiAgICAgICAgdmFyIHN1Ym1pdCA9IGYgPyBbXS5zbGljZS5jYWxsKGYucXVlcnlTZWxlY3RvckFsbCgnYnV0dG9uJykpLnBvcCgpIDogbnVsbDtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWYgJiYgISFzdWJtaXQgJiYgc3VibWl0LmRpc2FibGVkPT09dHJ1ZSwgZGV0YWlsOiBmID8gJ1x1ODg2OFx1NTM1NVx1NTFGQVx1NzNCMCxcdTdBN0EgdGFnIFx1NjVGNlx1NjNEMFx1NEVBNFx1Nzk4MVx1NzUyOCcgOiAnbm8gZm9ybSd9O2AsIDVfMDAwKTtcclxuICAgICAgaWYgKCF3MlswXSkgcmV0dXJuIHcyO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBmPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLXRlc3RpZD1cImZvcmdlLWZvcm1cIl0nKTsgdmFyIHg9W10uc2xpY2UuY2FsbChmLnF1ZXJ5U2VsZWN0b3JBbGwoJ2J1dHRvbicpKS5maW5kKGZ1bmN0aW9uKGIpe3JldHVybiBiLnRleHRDb250ZW50PT09J1x1MjcxNSc7fSk7IGlmKHgpIHguY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignZm9ybSBjbG9zZWQnLCBgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLXRlc3RpZD1cImZvcmdlLWZvcm1cIl0nKSwgZGV0YWlsOidjbG9zZWQnfTtgLCA1XzAwMCk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU2NDFDXHU3RDIyXHU4RkM3XHU2RUU0ID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1NEYxQVx1OEJERFx1NjQxQ1x1N0QyMjpcdThGQzdcdTZFRTRcdTc1MUZcdTY1NDgnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IGJlZm9yZSA9IChhd2FpdCBqcyhgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aGApKSBhcyBudW1iZXI7XHJcbiAgICAgIGF3YWl0IHR5cGVJbnRvKCcuc2Vzc2lvbi1zZWFyY2gnLCAnenp6LVx1NEUwRFx1NUI1OFx1NTcyOFx1NzY4NFx1NEYxQVx1OEJERCcpO1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignZmlsdGVyZWQgZW1wdHknLCBgdmFyIG49ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aDtcclxuICAgICAgICByZXR1cm4ge29rOiBuID09PSAwLCBkZXRhaWw6ICdhZnRlcj0nK259O2AsIDVfMDAwKTtcclxuICAgICAgYXdhaXQgdHlwZUludG8oJy5zZXNzaW9uLXNlYXJjaCcsICcnKTtcclxuICAgICAgYXdhaXQgc2xlZXAoNDAwKTtcclxuICAgICAgY29uc3QgYWZ0ZXIgPSAoYXdhaXQganMoYGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGhgKSkgYXMgbnVtYmVyO1xyXG4gICAgICByZXR1cm4gW3dbMF0gJiYgYWZ0ZXIgPT09IGJlZm9yZSwgYCR7d1sxXX07IFx1NjA2Mlx1NTkwRFx1NTQwRSAke2FmdGVyfT09PSR7YmVmb3JlfWBdO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOkN0cmwrSyBcdTU0N0RcdTRFRTRcdTk3NjJcdTY3N0YgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnQ3RybCtLIFx1NTQ3RFx1NEVFNFx1OTc2Mlx1Njc3RjpcdTYyNTNcdTVGMDBcdTVFNzZcdTYyNjdcdTg4NENcdTU0N0RcdTRFRTQnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J2snLCBjdHJsS2V5OnRydWUsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignY21kayBvcGVuJywgYHZhciBjPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFjLCBkZXRhaWw6IGMgPyAnb3BlbicgOiAnbm90IG9wZW4nfTtgLCA1XzAwMCk7XHJcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGl0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNtZGstaXRlbScpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1NjU4N1x1NEVGNicpPj0wIHx8IHgudGV4dENvbnRlbnQuaW5kZXhPZignRmlsZXMnKT49MDt9KTsgaWYoaXQpIGl0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ3RhYiBzd2l0Y2hlZCcsIGB2YXIgdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuZG9jay10YWIuYWN0aXZlJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISF0ICYmICh0LnRleHRDb250ZW50PT09J1x1NjU4N1x1NEVGNid8fHQudGV4dENvbnRlbnQ9PT0nRmlsZXMnKSwgZGV0YWlsOiAnYWN0aXZlPScrKHQ/dC50ZXh0Q29udGVudDonbm9uZScpfTtgLCA1XzAwMCk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU4QkJFXHU3RjZFXHU5NzYyXHU2NzdGID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1OEJCRVx1N0Y2RShDdHJsK1NoaWZ0K1ApOlByb3ZpZGVyIFx1ODg2OFx1NTM1NVx1NTNFRlx1ODlDMSxFc2MgXHU1MTczXHU5NUVEJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidwJywgY3RybEtleTp0cnVlLCBzaGlmdEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3NldHRpbmdzIG9wZW4nLCBgdmFyIHM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNtZGsuc2V0dGluZ3MnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXMgJiYgISFzLnF1ZXJ5U2VsZWN0b3IoJy5wcm92aWRlci1mb3JtJyksIGRldGFpbDogcyA/ICdvcGVuK2Zvcm0nIDogJ25vdCBvcGVuJ307YCwgNV8wMDApO1xyXG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidFc2NhcGUnLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ3NldHRpbmdzIGNsb3NlZCcsIGByZXR1cm4ge29rOiAhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNtZGstb3ZlcmxheScpLCBkZXRhaWw6ICdjbG9zZWQnfTtgLCA1XzAwMCk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6aTE4biBcdThCRURcdThBMDBcdTUyMDdcdTYzNjIgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU4QkVEXHU4QTAwXHU1MjA3XHU2MzYyOlx1NEUyRFx1NjU4NyBcdTIxOTIgRW5nbGlzaCBcdTIxOTIgXHU2MDYyXHU1OTBEXHU0RTJEXHU2NTg3JywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidwJywgY3RybEtleTp0cnVlLCBzaGlmdEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3NldHRpbmdzIG9wZW4nLCBgdmFyIHM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNtZGsuc2V0dGluZ3MnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXMsIGRldGFpbDogcyA/ICdvcGVuJyA6ICdub3Qgb3Blbid9O2AsIDVfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jbWRrLnNldHRpbmdzIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdFbmdsaXNoJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IGVuID0gYXdhaXQgd2FpdEZvcignZW5nbGlzaCBzaG93bicsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhci1oZWFkIC5idG4ucHJpbWFyeScpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYiAmJiBiLnRleHRDb250ZW50ID09PSAnKyBOZXcgU2Vzc2lvbicsIGRldGFpbDogJ2J0bj0nKyhiP2IudGV4dENvbnRlbnQ6J25vbmUnKX07YCwgNV8wMDApO1xyXG4gICAgICBhd2FpdCBzaG90KCdlbmdsaXNoJyk7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY21kay5zZXR0aW5ncyBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU0RTJEXHU2NTg3Jzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IHpoID0gYXdhaXQgd2FpdEZvcignY2hpbmVzZSBiYWNrJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyLWhlYWQgLmJ0bi5wcmltYXJ5Jyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFiICYmIGIudGV4dENvbnRlbnQgPT09ICcrIFx1NjVCMFx1NUVGQVx1NEYxQVx1OEJERCcsIGRldGFpbDogJ2J0bj0nKyhiP2IudGV4dENvbnRlbnQ6J25vbmUnKX07YCwgNV8wMDApO1xyXG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidFc2NhcGUnLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgcmV0dXJuIFtlblswXSAmJiB6aFswXSwgYGVuOiAke2VuWzFdfTsgemg6ICR7emhbMV19YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU1REU1XHU0RjVDXHU1MzNBXHU3QkExXHU3NDA2KFx1NURFNlx1NjgwRlx1NjgwRlx1NEY0RCArIFx1ODNEQ1x1NTM1NSArIFx1NjVCMFx1NUVGQVx1NEYxQVx1OEJERFx1OTAwOVx1NURFNVx1NEY1Q1x1NTMzQSkgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU1REU1XHU0RjVDXHU1MzNBOlx1NURFNlx1NjgwRlx1NURFNVx1NEY1Q1x1NTMzQVx1NjgwRlx1NTNFRlx1ODlDMShcdTVGNTNcdTUyNERcdTVERTVcdTRGNUNcdTUzM0FcdTU0MEQpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignd29ya3NwYWNlIGJhcicsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud29ya3NwYWNlLWJhcicpO1xyXG4gICAgICAgIHZhciBuID0gYiA/IChiLnF1ZXJ5U2VsZWN0b3IoJy53cy1iYXItbmFtZScpfHx7fSkudGV4dENvbnRlbnQgOiAnJztcclxuICAgICAgICByZXR1cm4ge29rOiAhIWIgJiYgISFuICYmIG4ubGVuZ3RoID4gMCAmJiBuLmluZGV4T2YoJ1x1NTJBMFx1OEY3RCcpIDwgMCwgZGV0YWlsOiAnYmFyPScrKGI/J3llcyc6J25vJykrJyBuYW1lPScrbn07YCwgOF8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdcdTVERTVcdTRGNUNcdTUzM0E6XHU4M0RDXHU1MzU1XHU1RjM5XHU1MUZBLFx1NTIxN1x1ODg2OCtcdTVGNTNcdTUyNERcdTlBRDhcdTRFQUUrXHU2REZCXHU1MkEwXHU1MTY1XHU1M0UzO1x1NTcyOFx1NjMwN1x1NUI5QVx1NURFNVx1NEY1Q1x1NTMzQVx1NjVCMFx1NUVGQVx1NEYxQVx1OEJERCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud29ya3NwYWNlLWJhcicpOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3dzIG1lbnUnLCBgdmFyIG09ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLW1lbnUnKTtcclxuICAgICAgICB2YXIgaXRlbXMgPSBtID8gbS5xdWVyeVNlbGVjdG9yQWxsKCcud3MtbWVudS1pdGVtJykubGVuZ3RoIDogMDtcclxuICAgICAgICB2YXIgY3VyID0gbSA/IG0ucXVlcnlTZWxlY3RvckFsbCgnLndzLW1lbnUtaXRlbS5jdXJyZW50JykubGVuZ3RoIDogMDtcclxuICAgICAgICB2YXIgYWRkID0gbSA/IChtLnRleHRDb250ZW50LmluZGV4T2YoJ1x1NkRGQlx1NTJBMFx1NURFNVx1NEY1Q1x1NTMzQScpPj0wIHx8IG0udGV4dENvbnRlbnQuaW5kZXhPZignQWRkIHdvcmtzcGFjZScpPj0wKSA6IGZhbHNlO1xyXG4gICAgICAgIHJldHVybiB7b2s6IGl0ZW1zID49IDEgJiYgY3VyID49IDEgJiYgYWRkLCBkZXRhaWw6ICdpdGVtcz0nK2l0ZW1zKycgY3VycmVudD0nK2N1cisnIGFkZD0nK2FkZH07YCwgNl8wMDApO1xyXG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICBhd2FpdCBzaG90KCd3cy1tZW51Jyk7XHJcbiAgICAgIC8vIFx1NzBCOVx1N0IyQ1x1NEUwMFx1NEUyQVx1NURFNVx1NEY1Q1x1NTMzQVx1OTg3OSA9IFx1NTcyOFx1OEJFNVx1NURFNVx1NEY1Q1x1NTMzQVx1NjVCMFx1NUVGQVx1NEYxQVx1OEJERChcdTgzRENcdTUzNTVcdTUxNzNcdTk1RURcdTMwMDFjb21wb3NlciBcdTUzRUZcdTc1MjgpXHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGl0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1tZW51LWl0ZW0nKTsgaWYoaXQpIGl0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgY2xvc2VkID0gYXdhaXQgd2FpdEZvcignbWVudSBjbG9zZWQgKyBzZXNzaW9uIGFjdGl2ZScsIGB2YXIgdGE9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNvbXBvc2VyIHRleHRhcmVhJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1tZW51JykgJiYgISF0YSAmJiB0YS5kaXNhYmxlZCA9PT0gZmFsc2UsIGRldGFpbDogJ21lbnU9JysoZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLW1lbnUnKT8nb3Blbic6J2Nsb3NlZCcpKycgdGE9JysodGE/dGEuZGlzYWJsZWQ6J25vbmUnKX07YCwgNl8wMDApO1xyXG4gICAgICByZXR1cm4gW2Nsb3NlZFswXSwgYCR7d1sxXX07ICR7Y2xvc2VkWzFdfWBdO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NEYxQVx1OEJERFx1NjMwOVx1NURFNVx1NEY1Q1x1NTMzQVx1NTIwNlx1N0VDNCArIFx1NUM1NVx1NUYwMC9cdTY1MzZcdThENzcgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU0RjFBXHU4QkREXHU1MjA2XHU3RUM0Olx1N0VDNFx1NTkzNFx1NTFGQVx1NzNCMChcdTVERTVcdTRGNUNcdTUzM0FcdTU0MEQrXHU2NTcwXHU5MUNGKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2dyb3VwIGhlYWQnLCBgdmFyIGg9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLWdyb3VwLWhlYWQnKTtcclxuICAgICAgICB2YXIgbiA9IGggPyAoaC5xdWVyeVNlbGVjdG9yKCcud3MtZ3JvdXAtbmFtZScpfHx7fSkudGV4dENvbnRlbnQgOiAnJztcclxuICAgICAgICB2YXIgYyA9IGggPyAoaC5xdWVyeVNlbGVjdG9yKCcud3MtZ3JvdXAtY291bnQnKXx8e30pLnRleHRDb250ZW50IDogJyc7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFoICYmIG4ubGVuZ3RoID4gMCAmJiBjLmxlbmd0aCA+IDAsIGRldGFpbDogJ25hbWU9JytuKycgY291bnQ9JytjfTtgLCA4XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ1x1NEYxQVx1OEJERFx1NTIwNlx1N0VDNDpcdTcwQjlcdTUxRkJcdTdFQzRcdTU5MzRcdTY1MzZcdThENzcsXHU1MThEXHU3MEI5XHU1QzU1XHU1RjAwXHU2MDYyXHU1OTBEJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCBiZWZvcmUgPSAoYXdhaXQganMoYGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGhgKSkgYXMgbnVtYmVyO1xyXG4gICAgICBpZiAoYmVmb3JlID09PSAwKSByZXR1cm4gW2ZhbHNlLCAnbm8gc2Vzc2lvbnMgdG8gZ3JvdXAnXTtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgaD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtZ3JvdXAtaGVhZCcpOyBpZihoKSBoLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgY29sbGFwc2VkID0gYXdhaXQgd2FpdEZvcignY29sbGFwc2VkJywgYHZhciBnPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1ncm91cCcpO1xyXG4gICAgICAgIHZhciBoaWRkZW4gPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoIDwgJHtiZWZvcmV9O1xyXG4gICAgICAgIHJldHVybiB7b2s6IGhpZGRlbiwgZGV0YWlsOiAnaXRlbXM9Jytkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoKycgYmVmb3JlPSR7YmVmb3JlfSd9O2AsIDVfMDAwKTtcclxuICAgICAgYXdhaXQgc2hvdCgnd3MtZ3JvdXAtY29sbGFwc2VkJyk7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGg9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLWdyb3VwLWhlYWQnKTsgaWYoaCkgaC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IGV4cGFuZGVkID0gYXdhaXQgd2FpdEZvcignZXhwYW5kZWQgYmFjaycsIGB2YXIgbj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoO1xyXG4gICAgICAgIHJldHVybiB7b2s6IG4gPj0gJHtiZWZvcmV9LCBkZXRhaWw6ICdpdGVtcz0nK259O2AsIDVfMDAwKTtcclxuICAgICAgcmV0dXJuIFtjb2xsYXBzZWRbMF0gJiYgZXhwYW5kZWRbMF0sIGBjb2xsYXBzZTogJHtjb2xsYXBzZWRbMV19OyBleHBhbmQ6ICR7ZXhwYW5kZWRbMV19YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU1RkVCXHU2Mzc3XHU5NTJFXHU1RTJFXHU1MkE5XHU5NzYyXHU2NzdGKEN0cmwrLykgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU1RkVCXHU2Mzc3XHU5NTJFXHU1RTJFXHU1MkE5OkN0cmwrLyBcdTYyNTNcdTVGMDAsRXNjIFx1NTE3M1x1OTVFRCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleTonLycsIGN0cmxLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdzaG9ydGN1dHMgb3BlbicsIGB2YXIgcz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kaycpO1xyXG4gICAgICAgIHZhciByb3dzID0gcyA/IHMucXVlcnlTZWxlY3RvckFsbCgnLnNob3J0Y3V0LXJvdycpLmxlbmd0aCA6IDA7XHJcbiAgICAgICAgcmV0dXJuIHtvazogcm93cyA+PSA1LCBkZXRhaWw6ICdyb3dzPScrcm93c307YCwgNV8wMDApO1xyXG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICBhd2FpdCBzaG90KCdzaG9ydGN1dHMnKTtcclxuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleTonRXNjYXBlJywgYnViYmxlczp0cnVlfSkpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdzaG9ydGN1dHMgY2xvc2VkJywgYHJldHVybiB7b2s6ICFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kay1vdmVybGF5JyksIGRldGFpbDogJ2Nsb3NlZCd9O2AsIDVfMDAwKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTRGQTdcdTY4MEZcdTY1MzZcdTdGMjkgKyBcdTcyQjZcdTYwMDFcdThGQzdcdTZFRTQgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU0RkE3XHU2ODBGXHU2NTM2XHU3RjI5Olx1MjFFNCBcdTY1MzZcdThENzdcdTVERTZcdTY4MEYsXHUyMUU1IFx1NUM1NVx1NUYwMFx1NjA2Mlx1NTkwRCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgLy8gSElHIFAzIFx1N0VDNDI6XHUyMUU0L1x1MjFFNSBFbW9qaSBcdTVERjJcdTYzNjIgU1ZHIGljb24sXHU2MzA5XHU5NEFFXHU0RUU1IGFyaWEtbGFiZWwoXHU1NDJCXCJcdTRGQTdcdTY4MEZcIilcdTVCOUFcdTRGNERcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3RvZ2dsZSBidG4nLCBgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudG9wYmFyIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiAoeC5nZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnKXx8JycpLmluZGV4T2YoJ1x1NEZBN1x1NjgwRicpPj0wO30pO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYiwgZGV0YWlsOiAnYnRuPScrKGI/Yi5nZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnKTonbm9uZScpfTtgLCA1XzAwMCk7XHJcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudG9wYmFyIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiAoeC5nZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnKXx8JycpLmluZGV4T2YoJ1x1NEZBN1x1NjgwRicpPj0wO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgaGlkZGVuID0gYXdhaXQgd2FpdEZvcignc2lkZWJhciBoaWRkZW4nLCBgdmFyIHNiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyJyk7XHJcbiAgICAgICAgdmFyIGdvbmUgPSAhc2IgfHwgZ2V0Q29tcHV0ZWRTdHlsZShzYikuZGlzcGxheSA9PT0gJ25vbmUnO1xyXG4gICAgICAgIHJldHVybiB7b2s6IGdvbmUsIGRldGFpbDogJ2Rpc3BsYXk9Jysoc2I/Z2V0Q29tcHV0ZWRTdHlsZShzYikuZGlzcGxheTonbm9uZScpfTtgLCA1XzAwMCk7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudG9wYmFyIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiAoeC5nZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnKXx8JycpLmluZGV4T2YoJ1x1NEZBN1x1NjgwRicpPj0wO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3Qgc2hvd24gPSBhd2FpdCB3YWl0Rm9yKCdzaWRlYmFyIGJhY2snLCBgdmFyIHNiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFzYiAmJiBnZXRDb21wdXRlZFN0eWxlKHNiKS5kaXNwbGF5ICE9PSAnbm9uZScsIGRldGFpbDogJ2Rpc3BsYXk9Jysoc2I/Z2V0Q29tcHV0ZWRTdHlsZShzYikuZGlzcGxheTonbm9uZScpfTtgLCA1XzAwMCk7XHJcbiAgICAgIHJldHVybiBbaGlkZGVuWzBdICYmIHNob3duWzBdLCBgaGlkZTogJHtoaWRkZW5bMV19OyBzaG93OiAke3Nob3duWzFdfWBdO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdcdTcyQjZcdTYwMDFcdThGQzdcdTZFRTQ6XHU0RTBCXHU2MkM5XHU1MjA3XHU2MzYyXHU1MjMwXCJcdThGRDBcdTg4NENcdTRFMkRcIlx1NEUwRFx1NUQyOVx1NkU4M1x1NUU3Nlx1NjA2Mlx1NTkwRCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3Qgc2VsID0gYXdhaXQgd2FpdEZvcignZmlsdGVyIHNlbGVjdCcsIGB2YXIgcz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc3RhdHVzLWZpbHRlcicpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhcyAmJiBzLm9wdGlvbnMubGVuZ3RoID49IDQsIGRldGFpbDogJ29wdGlvbnM9Jysocz9zLm9wdGlvbnMubGVuZ3RoOjApfTtgLCA1XzAwMCk7XHJcbiAgICAgIGlmICghc2VsWzBdKSByZXR1cm4gc2VsO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zdGF0dXMtZmlsdGVyJyk7IHMudmFsdWU9J3J1bm5pbmcnOyBzLmRpc3BhdGNoRXZlbnQobmV3IEV2ZW50KCdjaGFuZ2UnLHtidWJibGVzOnRydWV9KSk7IH0pKClgKTtcclxuICAgICAgYXdhaXQgc2xlZXAoNTAwKTtcclxuICAgICAgY29uc3QgcjEgPSAoYXdhaXQganMoYGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGhgKSkgYXMgbnVtYmVyO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zdGF0dXMtZmlsdGVyJyk7IHMudmFsdWU9J2FsbCc7IHMuZGlzcGF0Y2hFdmVudChuZXcgRXZlbnQoJ2NoYW5nZScse2J1YmJsZXM6dHJ1ZX0pKTsgfSkoKWApO1xyXG4gICAgICBhd2FpdCBzbGVlcCg1MDApO1xyXG4gICAgICBjb25zdCByMiA9IChhd2FpdCBqcyhgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aGApKSBhcyBudW1iZXI7XHJcbiAgICAgIHJldHVybiBbcjIgPj0gcjEgJiYgcjIgPj0gMSwgYHJ1bm5pbmc9JHtyMX0gYWxsPSR7cjJ9YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU2QTIxXHU1NzhCXHU5MDA5XHU2MkU5XHU1NjY4KFx1OTg3Nlx1NjgwRlx1NTIwN1x1NjM2MiBjaGF0IFx1OERFRlx1NzUzMSkgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU2QTIxXHU1NzhCXHU5MDA5XHU2MkU5XHU1NjY4Olx1OTg3Nlx1NjgwRlx1ODNEQ1x1NTM1NVx1NTIxN1x1NTFGQSBwcm92aWRlcnMgXHU1RTc2XHU1M0VGXHU1MjA3XHU2MzYyJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignbW9kZWwgYnV0dG9uJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy50b3BiYXItbW9kZWwuYXMtYnV0dG9uJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFiICYmIGIuZGlzYWJsZWQgPT09IGZhbHNlLCBkZXRhaWw6IGIgPyBiLnRleHRDb250ZW50IDogJ25vbmUnfTtgLCA2XzAwMCk7XHJcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnRvcGJhci1tb2RlbC5hcy1idXR0b24nKTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IG0gPSBhd2FpdCB3YWl0Rm9yKCdtb2RlbCBtZW51JywgYHZhciBtPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5tb2RlbC1tZW51Jyk7XHJcbiAgICAgICAgdmFyIGl0ZW1zID0gbSA/IG0ucXVlcnlTZWxlY3RvckFsbCgnLndzLW1lbnUtaXRlbScpLmxlbmd0aCA6IDA7XHJcbiAgICAgICAgdmFyIGN1ciA9IG0gPyBtLnF1ZXJ5U2VsZWN0b3JBbGwoJy53cy1tZW51LWl0ZW0uY3VycmVudCcpLmxlbmd0aCA6IDA7XHJcbiAgICAgICAgcmV0dXJuIHtvazogaXRlbXMgPj0gMiAmJiBjdXIgPj0gMSwgZGV0YWlsOiAnaXRlbXM9JytpdGVtcysnIGN1cnJlbnQ9JytjdXJ9O2AsIDVfMDAwKTtcclxuICAgICAgaWYgKCFtWzBdKSByZXR1cm4gbTtcclxuICAgICAgYXdhaXQgc2hvdCgnbW9kZWwtbWVudScpO1xyXG4gICAgICAvLyBcdTUyMDdcdTUyMzBcdTdCMkNcdTRFOENcdTRFMkEgcHJvdmlkZXIoZmFrZTogZGVtby12aXNpb24vZmFrZS1tLXZpc2lvbilcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgaXRzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLm1vZGVsLW1lbnUgLndzLW1lbnUtaXRlbScpKTsgdmFyIGl0PWl0c1tpdHMubGVuZ3RoLTFdOyBpZihpdCkgaXQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignbW9kZWwgc3dpdGNoZWQnLCBgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnRvcGJhci1tb2RlbC5hcy1idXR0b24nKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWIgJiYgYi50ZXh0Q29udGVudC5pbmRleE9mKCdmYWtlLW0tdmlzaW9uJykgPj0gMCwgZGV0YWlsOiAnYmFkZ2U9JysoYj9iLnRleHRDb250ZW50Oidub25lJyl9O2AsIDZfMDAwKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTRFM0JcdTk4OTgoXHU2RDQ1XHU4MjcyXHU3NTFGXHU2NTQ4XHUyMTkyXHU2MDYyXHU1OTBEXHU2REYxXHU4MjcyKSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTRFM0JcdTk4OTg6XHU4QkJFXHU3RjZFXHU1MjA3XHU2RDQ1XHU4MjcyXHU3NTFGXHU2NTQ4LFx1NjA2Mlx1NTkwRFx1NkRGMVx1ODI3MicsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleToncCcsIGN0cmxLZXk6dHJ1ZSwgc2hpZnRLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdzZXR0aW5ncyBvcGVuJywgYHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrLnNldHRpbmdzJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFzLCBkZXRhaWw6IHMgPyAnb3BlbicgOiAnbm90IG9wZW4nfTtgLCA1XzAwMCk7XHJcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY21kay5zZXR0aW5ncyAuc2VnIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTZENDVcdTgyNzInfHx4LnRleHRDb250ZW50LnRyaW0oKT09PSdMaWdodCc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBsaWdodCA9IGF3YWl0IHdhaXRGb3IoJ2xpZ2h0IHRoZW1lJywgYHZhciBkdD1kb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuZGF0YXNldC50aGVtZTtcclxuICAgICAgICB2YXIgYmcgPSBnZXRDb21wdXRlZFN0eWxlKGRvY3VtZW50LmJvZHkpLmJhY2tncm91bmRDb2xvcjtcclxuICAgICAgICB2YXIgbSA9IC9cXFxcZCsvZzsgdmFyIG51bXM9KGJnLm1hdGNoKG0pfHxbJzAnLCcwJywnMCddKS5tYXAoTnVtYmVyKTtcclxuICAgICAgICByZXR1cm4ge29rOiBkdD09PSdsaWdodCcgJiYgbnVtc1swXT4yMDAgJiYgbnVtc1sxXT4yMDAgJiYgbnVtc1syXT4yMDAsIGRldGFpbDogJ3RoZW1lPScrZHQrJyBiZz0nK2JnfTtgLCA1XzAwMCk7XHJcbiAgICAgIGF3YWl0IHNob3QoJ2xpZ2h0LXRoZW1lJyk7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY21kay5zZXR0aW5ncyAuc2VnIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTZERjFcdTgyNzInfHx4LnRleHRDb250ZW50LnRyaW0oKT09PSdEYXJrJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IGRhcmsgPSBhd2FpdCB3YWl0Rm9yKCdkYXJrIGJhY2snLCBgcmV0dXJuIHtvazogZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LmRhdGFzZXQudGhlbWU9PT0nZGFyaycsIGRldGFpbDogJ3RoZW1lPScrZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LmRhdGFzZXQudGhlbWV9O2AsIDVfMDAwKTtcclxuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleTonRXNjYXBlJywgYnViYmxlczp0cnVlfSkpYCk7XHJcbiAgICAgIHJldHVybiBbbGlnaHRbMF0gJiYgZGFya1swXSwgYGxpZ2h0OiAke2xpZ2h0WzFdfTsgZGFyazogJHtkYXJrWzFdfWBdO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1OTg3Nlx1NjgwRiBcdTRFMkQvRU4gXHU1RkVCXHU2Mzc3XHU1MjA3XHU2MzYyKFx1NTNFRlx1NTNEMVx1NzNCMFx1NjAyNykgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU5ODc2XHU2ODBGXHU1RkVCXHU2Mzc3XHU1MjA3XHU2MzYyOlx1NEUyRC9FTiBcdTRFMDBcdTk1MkVcdTUyMDdcdTYzNjInLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdsYW5nIHNlZycsIGB2YXIgcz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcubGFuZy1zZWcnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXMgJiYgcy5xdWVyeVNlbGVjdG9yQWxsKCdidXR0b24nKS5sZW5ndGggPT09IDIsIGRldGFpbDogcyA/ICdwcmVzZW50JyA6ICdhYnNlbnQnfTtgLCA1XzAwMCk7XHJcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcubGFuZy1zZWcgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J0VOJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IGVuID0gYXdhaXQgd2FpdEZvcignZW5nbGlzaCcsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhci1oZWFkIC5idG4ucHJpbWFyeScpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYiAmJiBiLnRleHRDb250ZW50ID09PSAnKyBOZXcgU2Vzc2lvbicsIGRldGFpbDogJ2J0bj0nKyhiP2IudGV4dENvbnRlbnQ6J25vbmUnKX07YCwgNV8wMDApO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmxhbmctc2VnIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTRFMkQnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgemggPSBhd2FpdCB3YWl0Rm9yKCdjaGluZXNlIGJhY2snLCBgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXItaGVhZCAuYnRuLnByaW1hcnknKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWIgJiYgYi50ZXh0Q29udGVudCA9PT0gJysgXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREJywgZGV0YWlsOiAnYnRuPScrKGI/Yi50ZXh0Q29udGVudDonbm9uZScpfTtgLCA1XzAwMCk7XHJcbiAgICAgIHJldHVybiBbZW5bMF0gJiYgemhbMF0sIGBlbjogJHtlblsxXX07IHpoOiAke3poWzFdfWBdO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1N0M5OFx1OEQzNFx1NTZGRVx1NzI0NyBcdTIxOTIgXHU3RjI5XHU3NTY1XHU1NkZFIGNoaXAgXHUyMTkyIFx1NTNEMVx1OTAwMSBcdTIxOTIgcnVudGltZSBcdTY1MzZcdTUyMzAgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU3Qzk4XHU4RDM0XHU1NkZFXHU3MjQ3Olx1N0YyOVx1NzU2NVx1NTZGRSBjaGlwICsgXHU1M0QxXHU5MDAxXHU1NDBFIHJ1bnRpbWUgXHU2NTM2XHU1MjMwXHU1NkZFXHU3MjQ3JywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAvLyBcdTY1QjBcdTVFRkFcdTRGMUFcdThCRERcdTc4NkVcdTRGREQgY29tcG9zZXIgXHU1M0VGXHU3NTI4XHJcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J24nLCBjdHJsS2V5OnRydWUsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICBhd2FpdCBzbGVlcCgzMDApO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XHJcbiAgICAgICAgdmFyIHRhID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNvbXBvc2VyIHRleHRhcmVhJyk7XHJcbiAgICAgICAgaWYgKCF0YSkgcmV0dXJuO1xyXG4gICAgICAgIHZhciBjID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnY2FudmFzJyk7XHJcbiAgICAgICAgYy53aWR0aCA9IDg7IGMuaGVpZ2h0ID0gODtcclxuICAgICAgICB2YXIgY3R4ID0gYy5nZXRDb250ZXh0KCcyZCcpO1xyXG4gICAgICAgIGN0eC5maWxsU3R5bGUgPSAnIzNmOTY1MCc7IGN0eC5maWxsUmVjdCgwLCAwLCA4LCA4KTtcclxuICAgICAgICBjLnRvQmxvYihmdW5jdGlvbihibG9iKXtcclxuICAgICAgICAgIHZhciBkdCA9IG5ldyBEYXRhVHJhbnNmZXIoKTtcclxuICAgICAgICAgIGR0Lml0ZW1zLmFkZChuZXcgRmlsZShbYmxvYl0sICdwYXN0ZWQucG5nJywge3R5cGU6ICdpbWFnZS9wbmcnfSkpO1xyXG4gICAgICAgICAgdGEuZGlzcGF0Y2hFdmVudChuZXcgQ2xpcGJvYXJkRXZlbnQoJ3Bhc3RlJywge2NsaXBib2FyZERhdGE6IGR0LCBidWJibGVzOiB0cnVlLCBjYW5jZWxhYmxlOiB0cnVlfSkpO1xyXG4gICAgICAgIH0sICdpbWFnZS9wbmcnKTtcclxuICAgICAgfSkoKWApO1xyXG4gICAgICBjb25zdCBjaGlwID0gYXdhaXQgd2FpdEZvcignaW1hZ2UgY2hpcCcsIGB2YXIgbj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuYXR0LWNoaXAuaW1nJykubGVuZ3RoO1xyXG4gICAgICAgIHJldHVybiB7b2s6IG4gPj0gMSwgZGV0YWlsOiAnaW1nIGNoaXBzPScrbn07YCwgNl8wMDApO1xyXG4gICAgICBpZiAoIWNoaXBbMF0pIHJldHVybiBjaGlwO1xyXG4gICAgICBhd2FpdCB0eXBlSW50bygnLmNvbXBvc2VyIHRleHRhcmVhJywgJ1x1NzcwQlx1OEZEOVx1NUYyMFx1NTZGRScpO1xyXG4gICAgICBhd2FpdCBzbGVlcCgyMDApO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNvbXBvc2VyIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTUzRDFcdTkwMDEnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgZG9uZSA9IGF3YWl0IHdhaXRGb3IoJ2ltYWdlIHNlbnQnLCBgXHJcbiAgICAgICAgdmFyIGFwID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmFwcHJvdmFsLWNhcmQgYnV0dG9uJyk7XHJcbiAgICAgICAgaWYgKGFwICYmIGFwLnRleHRDb250ZW50LnRyaW0oKS5pbmRleE9mKCdcdTYyNzlcdTUxQzYnKT49MCkgYXAuY2xpY2soKTtcclxuICAgICAgICB2YXIgdHM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudHVybicpKTtcclxuICAgICAgICB2YXIgaGl0ID0gdHMuZmlsdGVyKGZ1bmN0aW9uKHgpeyByZXR1cm4geC5jbGFzc05hbWUuaW5kZXhPZigndXNlcicpPDAgJiYgeC50ZXh0Q29udGVudC5pbmRleE9mKCdbaW1hZ2VzOiAxXScpID49IDA7IH0pO1xyXG4gICAgICAgIHJldHVybiB7b2s6IGhpdC5sZW5ndGggPj0gMSwgZGV0YWlsOiAncnVudGltZS1lY2hvLXdpdGgtaW1hZ2U9JytoaXQubGVuZ3RofTtcclxuICAgICAgYCwgMTVfMDAwKTtcclxuICAgICAgYXdhaXQgc2hvdCgncGFzdGVkLWltYWdlJyk7XHJcbiAgICAgIHJldHVybiBkb25lO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1RDgzRFx1RENDRSBcdTRFMEFcdTRGMjAvXHVEODNEXHVEQ0MxIFx1NkQ0Rlx1ODlDOFx1NjMwOVx1OTRBRVx1NUMzMVx1NEY0RCA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTk2NDRcdTRFRjZcdTRFMEVcdTc2RUVcdTVGNTVcdTUxNjVcdTUzRTM6XHVEODNEXHVEQ0NFIFx1NEUwQVx1NEYyMCArIFx1RDgzRFx1RENDMSBcdTZENEZcdTg5QzhcdTYzMDlcdTk0QUVcdTVCNThcdTU3MjgnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoYChmdW5jdGlvbigpe1xyXG4gICAgICAgIHZhciB1cCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jb21wb3NlciBidXR0b25bYXJpYS1sYWJlbCo9XCJcdTRFMEFcdTRGMjBcIl0sIC5jb21wb3NlciBidXR0b25bYXJpYS1sYWJlbCo9XCJVcGxvYWRcIl0nKTtcclxuICAgICAgICB2YXIgYnIgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtcGlja2VyIGJ1dHRvbicpO1xyXG4gICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh7dXA6ICEhdXAsIGJyb3dzZTogISFicn0pO1xyXG4gICAgICB9KSgpYCkpIGFzIHN0cmluZztcclxuICAgICAgY29uc3QgcCA9IEpTT04ucGFyc2UocikgYXMgeyB1cDogYm9vbGVhbjsgYnJvd3NlOiBib29sZWFuIH07XHJcbiAgICAgIHJldHVybiBbcC51cCAmJiBwLmJyb3dzZSwgYFx1RDgzRFx1RENDRT0ke3AudXB9IFx1RDgzRFx1RENDMT0ke3AuYnJvd3NlfWBdO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOkAgXHU5NjQ0XHU0RUY2XHU5MDA5XHU2MkU5XHU1NjY4ID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ0AgXHU5NjQ0XHU0RUY2Olx1OTAwOVx1NjJFOVx1NTY2OFx1NTFGQVx1NzNCMFx1NUU3Nlx1NTNFRlx1OTAwOVx1NjU4N1x1NEVGNicsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jb21wb3NlciBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nQCc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignYXR0IHBpY2tlcicsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuYXR0LXBpY2tlcicpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhcCwgZGV0YWlsOiBwID8gJ29wZW4nIDogJ25vdCBvcGVuJ307YCwgNV8wMDApO1xyXG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICBhd2FpdCB0eXBlSW50bygnLmF0dC1waWNrZXIgaW5wdXQnLCAncmVhZCcpO1xyXG4gICAgICBjb25zdCB3MiA9IGF3YWl0IHdhaXRGb3IoJ2F0dCByZXN1bHRzJywgYHZhciByPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5hdHQtcmVzdWx0cyAuZnMtcm93JykubGVuZ3RoO1xyXG4gICAgICAgIHJldHVybiB7b2s6IHIgPj0gMSwgZGV0YWlsOiAncmVzdWx0cz0nK3J9O2AsIDZfMDAwKTtcclxuICAgICAgaWYgKCF3MlswXSkgcmV0dXJuIHcyO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBmPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5hdHQtcmVzdWx0cyAuZnMtcm93Jyk7IGlmKGYpIGYuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignYXR0IGNoaXAnLCBgdmFyIGM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmF0dC1jaGlwJykubGVuZ3RoO1xyXG4gICAgICAgIHJldHVybiB7b2s6IGMgPj0gMSwgZGV0YWlsOiAnY2hpcHM9JytjfTtgLCA1XzAwMCk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2UoXHU1NDExXHU1QkZDXHU2Nzg0XHU5MDIwKTpcdThCQkVcdTdGNkVcdTMwMENcdTkxQ0RcdTY1QjBcdTkxNERcdTdGNkVcdTMwMERcdTkxQ0RcdTUxNjUgKyBcdTkwMDlcdTYyRTlcdTYzMDFcdTRFNDUgPT09PT09PT09PSAqL1xyXG4gICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX1dJWkFSRCA9PT0gJ2Zha2UnKSB7XHJcbiAgICAgIGF3YWl0IHN0ZXAoJ1x1NTQxMVx1NUJGQzpcdThCQkVcdTdGNkVcdTMwMENcdTkxQ0RcdTY1QjBcdTkxNERcdTdGNkVcdTMwMERcdTkxQ0RcdTUxNjUgKyBcdTkwMDlcdTYyRTlcdTYzMDFcdTRFNDUod2l6YXJkLmpzb24pJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J3AnLCBjdHJsS2V5OnRydWUsIHNoaWZ0S2V5OnRydWUsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICAgIGNvbnN0IG9wZW4gPSBhd2FpdCB3YWl0Rm9yKCdzZXR0aW5ncyBvcGVuJywgYHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrLnNldHRpbmdzJyk7XHJcbiAgICAgICAgICByZXR1cm4ge29rOiAhIXMsIGRldGFpbDogcyA/ICdvcGVuJyA6ICdjbG9zZWQnfTtgLCA1XzAwMCk7XHJcbiAgICAgICAgaWYgKCFvcGVuWzBdKSByZXR1cm4gb3BlbjtcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNtZGsuc2V0dGluZ3MgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU5MUNEXHU2NUIwXHU5MTREXHU3RjZFJyk+PTA7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgIGNvbnN0IHNob3duID0gYXdhaXQgd2FpdEZvcignd2l6YXJkIHJlb3BlbmVkJywgYHJldHVybiB7b2s6ICEhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1vdmVybGF5JyksXHJcbiAgICAgICAgICBkZXRhaWw6IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3ZlcmxheScpID8gJ29wZW4nIDogJ2Nsb3NlZCd9O2AsIDVfMDAwKTtcclxuICAgICAgICBpZiAoIXNob3duWzBdKSByZXR1cm4gc2hvd247XHJcbiAgICAgICAgYXdhaXQgc2hvdCgnd2l6YXJkLXJlZW50cnknKTtcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTUzRDZcdTZEODgnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICBjb25zdCBjbG9zZWQgPSBhd2FpdCB3YWl0Rm9yKCd3aXphcmQgY2xvc2VkJywgYHJldHVybiB7b2s6ICFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKSwgZGV0YWlsOiAnY2xvc2VkJ307YCwgNV8wMDApO1xyXG4gICAgICAgIGNvbnN0IHN0ID0gKGF3YWl0IGpzKGB3aW5kb3cuaG1oLmdldFdpemFyZCgpLnRoZW4oZnVuY3Rpb24ocil7cmV0dXJuIEpTT04uc3RyaW5naWZ5KHIpO30pYCkpIGFzIHN0cmluZztcclxuICAgICAgICBjb25zdCBwID0gSlNPTi5wYXJzZShzdCkgYXMgeyBwZXJzaXN0ZWQ/OiB7IGRvbmU/OiBib29sZWFuOyBjaG9pY2U/OiBzdHJpbmcgfSB9O1xyXG4gICAgICAgIGNvbnN0IHBlcnNpc3RlZCA9IHAucGVyc2lzdGVkPy5kb25lID09PSB0cnVlICYmIHAucGVyc2lzdGVkPy5jaG9pY2UgPT09ICdidW5kbGVkJztcclxuICAgICAgICByZXR1cm4gW2Nsb3NlZFswXSAmJiBwZXJzaXN0ZWQsIGBjbG9zZWQ9JHtjbG9zZWRbMF19IHBlcnNpc3RlZD0ke0pTT04uc3RyaW5naWZ5KHAucGVyc2lzdGVkID8/IG51bGwpfWBdO1xyXG4gICAgICB9KTtcclxuXHJcbiAgICAgIC8qID09PT09PT09PT0gZmFrZShcdTU0MTFcdTVCRkNcdTY3ODRcdTkwMjApOlx1N0E4NFx1NUM0RiAzNjBcdTAwRDc2NDAgXHU1MTY4XHU1MTQzXHU3RDIwXHU1M0VGXHU4RkJFICsgXHU1MzU1XHU1MUZCXHU5MDA5XHU5ODc5XHU1MzczXHU1MjREXHU4RkRCID09PT09PT09PT1cclxuICAgICAgICAgXHU3NTI4XHU2MjM3XHU2MjRCXHU2NzNBXHU1QjlFXHU2RDRCXHU3NURCXHU3MEI5Olx1N0E4NFx1ODlDNlx1NTNFM1x1NEUwQlx1OTAwOVx1OTg3OS9cdTYzMDlcdTk0QUVcdTg4QUJcdTg4QzFcdTUyMDdcdTcwQjlcdTRFMERcdTUyMzBcdTMwMDJcdTRGMkFcdTkwMjBcIlx1NjhDMFx1NkQ0Qlx1NTIzMFx1NURGMlx1ODhDNVwiXHJcbiAgICAgICAgIChcdTRFM0JcdThGREJcdTdBMEIgZW52IFx1NTM3M1x1NjVGNlx1OEJGQilcdThCQTlcdTU0MTFcdTVCRkNcdTUxRkFcdTczQjBcdTRFMDlcdTkwMDlcdTk4NzlcdThERUZcdTVGODQsXHU3RjI5XHU1MjMwIDM2MFx1MDBENzY0MCBcdTU0MEVcdTkwMTBcdTRFMkFcclxuICAgICAgICAgZWxlbWVudEZyb21Qb2ludCBcdTY1QURcdThBMDAoXHU0RTBEXHU2NjJGXHU4OEFCXHU4OEMxXHU1MjA3KTtcdTUxOERcdTlBOENcdThCQzFcdTUzNTVcdTUxRkJcdTUyNERcdThGREJcdTRFMEVcdTUzRDZcdTZEODhcdTMwMDIgKi9cclxuICAgICAgYXdhaXQgc3RlcCgnXHU1NDExXHU1QkZDOlx1N0E4NFx1NUM0RiAzNjBcdTAwRDc2NDBcdTIwMTRcdTIwMTRcdTRFMDlcdTkwMDlcdTk4NzkoXHU1NDJCIG5vdGUgXHU2NTc0XHU2ODBGKVx1NEUwRVx1NjMwOVx1OTRBRVx1NTE2OFx1OTBFOFx1NTNFRlx1NTQ3RFx1NEUyRCtcdTUzNTVcdTUxRkJcdTUzNzNcdTUyNERcdThGREInLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfRkFLRV9ERVRFQ1RfRk9VTkQgPSAnMSc7XHJcbiAgICAgICAgY29uc3Qgc2l6ZTAgPSB3aW4uZ2V0U2l6ZSgpO1xyXG4gICAgICAgIGNvbnN0IHcwID0gc2l6ZTBbMF0gPz8gMTI4MDtcclxuICAgICAgICBjb25zdCBoMCA9IHNpemUwWzFdID8/IDgwMDtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleToncCcsIGN0cmxLZXk6dHJ1ZSwgc2hpZnRLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XHJcbiAgICAgICAgICBjb25zdCBvcGVuID0gYXdhaXQgd2FpdEZvcignc2V0dGluZ3Mgb3BlbicsIGB2YXIgcz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kay5zZXR0aW5ncycpOyByZXR1cm4ge29rOiAhIXMsIGRldGFpbDogcyA/ICdvcGVuJyA6ICdjbG9zZWQnfTtgLCA1XzAwMCk7XHJcbiAgICAgICAgICBpZiAoIW9wZW5bMF0pIHJldHVybiBvcGVuO1xyXG4gICAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jbWRrLnNldHRpbmdzIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1OTFDRFx1NjVCMFx1OTE0RFx1N0Y2RScpPj0wO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICAgIGNvbnN0IHNob3duID0gYXdhaXQgd2FpdEZvcignd2l6YXJkIHJlb3BlbmVkJywgYHJldHVybiB7b2s6ICEhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1vdmVybGF5JyksIGRldGFpbDogZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1vdmVybGF5JykgPyAnb3BlbicgOiAnY2xvc2VkJ307YCwgNV8wMDApO1xyXG4gICAgICAgICAgaWYgKCFzaG93blswXSkgcmV0dXJuIHNob3duO1xyXG4gICAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1RjAwXHU1OUNCXHU5MTREXHU3RjZFJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgICBjb25zdCBkZXRlY3RQYWdlID0gYXdhaXQgd2FpdEZvcignZGV0ZWN0IGZvdW5kIHBhZ2UoMyBvcHRpb25zKScsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtZGV0ZWN0Jyk7XHJcbiAgICAgICAgICAgIHZhciBvcHRzPXA/cC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW9wdCcpLmxlbmd0aDowO1xyXG4gICAgICAgICAgICByZXR1cm4ge29rOiAhIXAgJiYgb3B0cz09PTMsIGRldGFpbDogJ29wdHM9JytvcHRzfTtgLCAxMl8wMDApO1xyXG4gICAgICAgICAgaWYgKCFkZXRlY3RQYWdlWzBdKSByZXR1cm4gZGV0ZWN0UGFnZTtcclxuICAgICAgICAgIC8vIFx1NTM1NVx1NTFGQlx1OTAwOVx1OTg3OVx1NTM3M1x1NTI0RFx1OEZEQjpcdTcwQjlcIlx1NEVDRFx1ODk4MVx1NEUwQlx1OEY3RFx1NjVCMFx1NzI0OFwiXHU1RTk0XHU3NkY0XHU2M0E1XHU4NDNEXHU1MjMwXHU5MDA5XHU2MkU5XHU5ODc1KFx1NjVFMFx1OTcwMFx1NTE4RFx1NzBCOVwiXHU0RTBCXHU0RTAwXHU2QjY1XCIpXHJcbiAgICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBvPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vcHQnKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTRFQ0RcdTg5ODFcdTRFMEJcdThGN0RcdTY1QjBcdTcyNDgnKT49MDt9KTsgaWYobykgby5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgICBjb25zdCBzZWxlY3RQYWdlID0gYXdhaXQgd2FpdEZvcignc2VsZWN0IHBhZ2UgdmlhIHNpbmdsZSBjbGljaycsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2Utc2VsZWN0Jyk7XHJcbiAgICAgICAgICAgIHJldHVybiB7b2s6ICEhcCAmJiBwLnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3B0JykubGVuZ3RoPT09MywgZGV0YWlsOiBwID8gJ3NlbGVjdCcgOiAnbm90IHNlbGVjdCd9O2AsIDZfMDAwKTtcclxuICAgICAgICAgIGlmICghc2VsZWN0UGFnZVswXSkgcmV0dXJuIFtmYWxzZSwgYFx1NTM1NVx1NTFGQlx1OTAwOVx1OTg3OVx1NjcyQVx1NTI0RFx1OEZEQlx1NTIzMFx1OTAwOVx1NjJFOVx1OTg3NTogJHtzZWxlY3RQYWdlWzFdfWBdO1xyXG4gICAgICAgICAgLy8gXHU3RjI5XHU1MjMwIDM2MFx1MDBENzY0MChtaW5XaWR0aCBcdTVERjJcdTU3MjggVUlWRVJJRlkgXHU0RTBCXHU2NTNFXHU1QkJEKSxcdTY1QURcdThBMDBcdTUxNjhcdTkwRThcdTUzRUZcdTU0N0RcdTRFMkRcclxuICAgICAgICAgIHdpbi5zZXRTaXplKDM2MCwgNjQwKTtcclxuICAgICAgICAgIGF3YWl0IHNsZWVwKDUwMCk7XHJcbiAgICAgICAgICBjb25zdCByID0gKGF3YWl0IGpzKGAoZnVuY3Rpb24oKXtcclxuICAgICAgICAgICAgZnVuY3Rpb24gaGl0KGVsKXsgZWwuc2Nyb2xsSW50b1ZpZXcoe2Jsb2NrOiduZWFyZXN0J30pOyB2YXIgcj1lbC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcclxuICAgICAgICAgICAgICB2YXIgeD1yLmxlZnQrci53aWR0aC8yLCB5PXIudG9wK3IuaGVpZ2h0LzI7XHJcbiAgICAgICAgICAgICAgdmFyIGU9ZG9jdW1lbnQuZWxlbWVudEZyb21Qb2ludCh4LHkpO1xyXG4gICAgICAgICAgICAgIHJldHVybiAhIShlICYmIChlPT09ZWwgfHwgZWwuY29udGFpbnMoZSkpKTsgfVxyXG4gICAgICAgICAgICB2YXIgY2FyZD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2Utc2VsZWN0Jyk7XHJcbiAgICAgICAgICAgIHZhciBvcHRzPVtdLnNsaWNlLmNhbGwoY2FyZC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW9wdCcpKTtcclxuICAgICAgICAgICAgdmFyIG9wdEhpdD1vcHRzLm1hcChoaXQpO1xyXG4gICAgICAgICAgICB2YXIgbm90ZXM9W10uc2xpY2UuY2FsbChjYXJkLnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3B0LW5vdGUnKSk7XHJcbiAgICAgICAgICAgIHZhciBub3RlSGl0PW5vdGVzLm1hcChmdW5jdGlvbihuKXsgbi5zY3JvbGxJbnRvVmlldyh7YmxvY2s6J25lYXJlc3QnfSk7IHZhciByPW4uZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XHJcbiAgICAgICAgICAgICAgdmFyIGU9ZG9jdW1lbnQuZWxlbWVudEZyb21Qb2ludChyLmxlZnQrci53aWR0aC8yLCByLnRvcCtNYXRoLm1pbihyLmhlaWdodC8yLCA4KSk7XHJcbiAgICAgICAgICAgICAgcmV0dXJuICEhKGUgJiYgb3B0cy5zb21lKGZ1bmN0aW9uKG8peyByZXR1cm4gZT09PW8gfHwgby5jb250YWlucyhlKTsgfSkpOyB9KTtcclxuICAgICAgICAgICAgdmFyIGFjdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2Utc2VsZWN0IC53aXphcmQtYWN0aW9ucyAuYnRuLnByaW1hcnknKTtcclxuICAgICAgICAgICAgdmFyIGZvb3Rlcj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtZm9vdGVyIGJ1dHRvbicpKTtcclxuICAgICAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHt2dzogd2luZG93LmlubmVyV2lkdGgsIHZoOiB3aW5kb3cuaW5uZXJIZWlnaHQsIG9wdHM6IG9wdHMubGVuZ3RoLFxyXG4gICAgICAgICAgICAgIG9wdEhpdDogb3B0SGl0LCBub3RlSGl0OiBub3RlSGl0LCBhY3RIaXQ6IGFjdCA/IGhpdChhY3QpIDogZmFsc2UsIGZ0SGl0OiBmb290ZXIubWFwKGhpdCl9KTtcclxuICAgICAgICAgIH0pKClgKSkgYXMgc3RyaW5nO1xyXG4gICAgICAgICAgY29uc3QgcSA9IEpTT04ucGFyc2UocikgYXMgeyB2dzogbnVtYmVyOyB2aDogbnVtYmVyOyBvcHRzOiBudW1iZXI7IG9wdEhpdDogYm9vbGVhbltdOyBub3RlSGl0OiBib29sZWFuW107IGFjdEhpdDogYm9vbGVhbjsgZnRIaXQ6IGJvb2xlYW5bXSB9O1xyXG4gICAgICAgICAgYXdhaXQgc2hvdCgnd2l6YXJkLW5hcnJvdy0zNjAtc2VsZWN0Jyk7XHJcbiAgICAgICAgICBjb25zdCBuYXJyb3dPayA9IHEub3B0cyA9PT0gMyAmJiBxLnZ3IDw9IDM4MCAmJiBxLm9wdEhpdC5ldmVyeShCb29sZWFuKSAmJiBxLm5vdGVIaXQuZXZlcnkoQm9vbGVhbikgJiYgcS5hY3RIaXQgJiYgcS5mdEhpdC5ldmVyeShCb29sZWFuKTtcclxuICAgICAgICAgIC8vIFx1N0E4NFx1NUM0Rlx1NEUwQlx1NTM1NVx1NTFGQlx1OTAwOVx1OTg3OVx1MjQ2MCA9IFx1OTAwOVx1NEUyRFx1NUU3Nlx1NTI0RFx1OEZEQlx1NTIzMFx1NUI4OVx1ODhDNVx1OTg3NSh2ZXJpZnkgXHU2QTIxXHU2MkRGXHU4RkRCXHU1RUE2LFx1NEUwRFx1ODQzRFx1NzZEOClcclxuICAgICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIG89W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW9wdCcpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1NEUwQlx1OEY3RFx1NUI4OVx1ODhDNVx1NUI4Q1x1NjU3NCBobWggQ0xJJyk+PTA7fSk7IGlmKG8pIG8uY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgICAgY29uc3QgYWR2ID0gYXdhaXQgd2FpdEZvcignaW5zdGFsbCBwYWdlIHZpYSBzaW5nbGUgY2xpY2snLCBgdmFyIHA9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLWluc3RhbGwnKTtcclxuICAgICAgICAgICAgcmV0dXJuIHtvazogISFwLCBkZXRhaWw6IHAgPyAnaW5zdGFsbGluZycgOiAnbm90IHNob3duJ307YCwgNl8wMDApO1xyXG4gICAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1M0Q2XHU2RDg4Jzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgICBjb25zdCBjbG9zZWROYXJyb3cgPSBhd2FpdCB3YWl0Rm9yKCd3aXphcmQgY2xvc2VkIGF0IDM2MHB4JywgYHJldHVybiB7b2s6ICFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKSwgZGV0YWlsOiAnY2xvc2VkJ307YCwgNV8wMDApO1xyXG4gICAgICAgICAgcmV0dXJuIFtuYXJyb3dPayAmJiBhZHZbMF0gJiYgY2xvc2VkTmFycm93WzBdLFxyXG4gICAgICAgICAgICBgdnA9JHtxLnZ3fXgke3Eudmh9IG9wdHM9JHtxLm9wdHN9IG9wdEhpdD1bJHtxLm9wdEhpdC5qb2luKCcsJyl9XSBub3RlSGl0PVske3Eubm90ZUhpdC5qb2luKCcsJyl9XSBcdTRFM0JcdTYzMDlcdTk0QUU9JHtxLmFjdEhpdH0gZm9vdGVyPVske3EuZnRIaXQuam9pbignLCcpfV07IFx1NTM1NVx1NTFGQlx1NTI0RFx1OEZEQjogJHthZHZbMV19OyBcdTdBODRcdTVDNEZcdTUzRDZcdTZEODg6ICR7Y2xvc2VkTmFycm93WzFdfWBdO1xyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICB3aW4uc2V0U2l6ZSh3MCwgaDApO1xyXG4gICAgICAgICAgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfRkFLRV9ERVRFQ1RfRk9VTkQgPSB1bmRlZmluZWQ7XHJcbiAgICAgICAgfVxyXG4gICAgICB9KTtcclxuICAgIH1cclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6SElHIFx1OTYzNlx1NkJCNTIgXHUyMDE0XHUyMDE0IFx1N0E4NFx1N0E5N1x1NjJCRFx1NUM0OSArIFx1NjgwN1x1OTg5OFx1NjgwRiA0NHB4L2RyYWcgXHU1MzNBID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1N0E4NFx1N0E5N1x1NjJCRFx1NUM0OTo3NjBweCBcdTRGQTdcdTY4MEZcdTUzRUZcdThGQkVcdTUzRUZcdTUxNzMoXHU5MDZFXHU3RjY5XHU3MEI5XHU1MUZCICsgRXNjKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgdHJ5IHsgd2luLnNldE1pbmltdW1TaXplKDU2MCwgNjAwKTsgd2luLnNldEJvdW5kcyh7IHdpZHRoOiA3NjAsIGhlaWdodDogNzAwIH0pOyB9IGNhdGNoIHsgLyogYmVzdCBlZmZvcnQgKi8gfVxyXG4gICAgICBjb25zdCBpc05hcnJvdyA9IGF3YWl0IHdhaXRGb3IoJ21hdGNoTWVkaWEgODIwJywgYHJldHVybiB7b2s6IHdpbmRvdy5tYXRjaE1lZGlhKCcobWF4LXdpZHRoOiA4MjBweCknKS5tYXRjaGVzLCBkZXRhaWw6ICdpdz0nICsgd2luZG93LmlubmVyV2lkdGh9O2AsIDVfMDAwKTtcclxuICAgICAgaWYgKCFpc05hcnJvd1swXSkgcmV0dXJuIGlzTmFycm93O1xyXG4gICAgICAvLyBcdTdCNDkgUmVhY3QgXHU2MzA5XHU3QTg0XHU3QTk3XHU5MUNEXHU2RTMyXHU2N0QzXHU1MUZBXHU2MkJEXHU1QzQ5XHU2MzA5XHU5NEFFKGFyaWEtbGFiZWwgXHU2MzYyXHU2MjEwXCJcdTYyQkRcdTVDNDlcIlx1NjU4N1x1Njg0OClcdTUxOERcdTcwQjlcdTIwMTRcdTIwMTRDU1MgXHU2NUFEXHU3MEI5XHU1MzczXHU2NUY2LFxyXG4gICAgICAvLyBSZWFjdCBzdGF0ZSBcdTY3MDlcdTZCRUJcdTc5RDJcdTdFQTdcdTVFRjZcdThGREYsXHU3NkYyXHU3MEI5XHU0RjFBXHU4NDNEXHU1NzI4XHU2NUU3XHU3Njg0XCJcdTY1MzZcdThENzdcdTRGQTdcdTY4MEZcIlx1NEUwQVxyXG4gICAgICBjb25zdCBidG4gPSBhd2FpdCB3YWl0Rm9yKCdkcmF3ZXIgYnV0dG9uJywgYHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnRvcGJhciBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4gKHguZ2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJyl8fCcnKS5pbmRleE9mKCdcdTYyQkRcdTVDNDknKT49MDt9KTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWIsIGRldGFpbDogJ2J0bj0nKyhiP2IuZ2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJyk6J25vbmUnKX07YCwgNV8wMDApO1xyXG4gICAgICBpZiAoIWJ0blswXSkgcmV0dXJuIGJ0bjtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50b3BiYXIgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuICh4LmdldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcpfHwnJykuaW5kZXhPZignXHU2MkJEXHU1QzQ5Jyk+PTA7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBvcGVuZWQgPSBhd2FpdCB3YWl0Rm9yKCdkcmF3ZXIgb3BlbicsIGB2YXIgc2I9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXInKSwgc2M9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXItc2NyaW0nKTtcclxuICAgICAgICB2YXIgcj1zYj9zYi5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTpudWxsO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhciAmJiByLnggPj0gMCAmJiByLnggPCA0MCAmJiAhIXNjLCBkZXRhaWw6ICd4PScrKHI/TWF0aC5yb3VuZChyLngpOidub25lJykrJyBzY3JpbT0nKyhzYz8neWVzJzonbm8nKX07YCwgNV8wMDApO1xyXG4gICAgICBhd2FpdCBzaG90KCdkcmF3ZXItb3BlbicpO1xyXG4gICAgICAvLyBcdTkwNkVcdTdGNjlcdTcwQjlcdTUxRkJcdTUxNzNcdTk1RUQgXHUyMTkyIFx1NEZBN1x1NjgwRlx1NkVEMVx1NTFGQSh4IDwgMCkrIFx1OTA2RVx1N0Y2OVx1NkQ4OFx1NTkzMVxyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBzYz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhci1zY3JpbScpOyBpZihzYykgc2MuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBjbG9zZWQgPSBhd2FpdCB3YWl0Rm9yKCdkcmF3ZXIgY2xvc2VkIGJ5IHNjcmltJywgYHZhciBzYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhcicpLCBzYz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhci1zY3JpbScpO1xyXG4gICAgICAgIHZhciByPXNiP3NiLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOm51bGw7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFyICYmIHIueCA8IDAgJiYgIXNjLCBkZXRhaWw6ICd4PScrKHI/TWF0aC5yb3VuZChyLngpOidub25lJykrJyBzY3JpbT0nKyhzYz8neWVzJzonbm8nKX07YCwgNV8wMDApO1xyXG4gICAgICAvLyBFc2MgXHU0RTVGXHU4MEZEXHU1RjAwL1x1NTE3M1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnRvcGJhciBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4gKHguZ2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJyl8fCcnKS5pbmRleE9mKCdcdTYyQkRcdTVDNDknKT49MDt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGF3YWl0IHdhaXRGb3IoJ2RyYXdlciByZW9wZW4nLCBgdmFyIHNiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyJyk7IHZhciByPXNiP3NiLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOm51bGw7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFyICYmIHIueCA+PSAwICYmIHIueCA8IDQwLCBkZXRhaWw6ICd4PScrKHI/TWF0aC5yb3VuZChyLngpOidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleTonRXNjYXBlJywgYnViYmxlczp0cnVlfSkpYCk7XHJcbiAgICAgIGNvbnN0IGVzY0Nsb3NlZCA9IGF3YWl0IHdhaXRGb3IoJ2RyYXdlciBjbG9zZWQgYnkgRXNjJywgYHZhciBzYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhcicpOyB2YXIgcj1zYj9zYi5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTpudWxsO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhciAmJiByLnggPCAwLCBkZXRhaWw6ICd4PScrKHI/TWF0aC5yb3VuZChyLngpOidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgICAgLy8gXHU2MDYyXHU1OTBEXHU1QkJEXHU3QTk3Olx1NEZBN1x1NjgwRlx1NTZERVx1NTIzMCBncmlkIFx1NTIxNyhkaXNwbGF5IFx1OTc1RSBub25lLFx1NkI2M1x1NUUzOFx1NTIxN1x1NUUwM1x1NUM0MClcclxuICAgICAgdHJ5IHsgd2luLnNldEJvdW5kcyh7IHdpZHRoOiAxMjgwLCBoZWlnaHQ6IDgwMCB9KTsgfSBjYXRjaCB7IC8qIGJlc3QgZWZmb3J0ICovIH1cclxuICAgICAgYXdhaXQgc2xlZXAoNDAwKTtcclxuICAgICAgY29uc3Qgd2lkZSA9IGF3YWl0IHdhaXRGb3IoJ3dpZGUgcmVzdG9yZWQnLCBgdmFyIHNiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyJyk7IHZhciByPXNiP3NiLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOm51bGw7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFyICYmIHIud2lkdGggPiAyMDAgJiYgZ2V0Q29tcHV0ZWRTdHlsZShzYikuZGlzcGxheSAhPT0gJ25vbmUnLCBkZXRhaWw6ICd3PScrKHI/TWF0aC5yb3VuZChyLndpZHRoKTonbm9uZScpfTtgLCA1XzAwMCk7XHJcbiAgICAgIHJldHVybiBbb3BlbmVkWzBdICYmIGNsb3NlZFswXSAmJiBlc2NDbG9zZWRbMF0gJiYgd2lkZVswXSwgYG9wZW46ICR7b3BlbmVkWzFdfTsgc2NyaW0tY2xvc2U6ICR7Y2xvc2VkWzFdfTsgZXNjLWNsb3NlOiAke2VzY0Nsb3NlZFsxXX07IHdpZGU6ICR7d2lkZVsxXX1gXTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnXHU2ODA3XHU5ODk4XHU2ODBGOjQ0cHggKyBkcmFnIFx1NTMzQShcdTgzRENcdTUzNTUgbm8tZHJhZztvdmVybGF5IFx1OUFEOFx1NUVBNlx1NEUwMFx1ODFGNCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoYChmdW5jdGlvbigpe1xyXG4gICAgICAgIHZhciB0Yj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudGl0bGViYXInKSwgbWI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnRpdGxlYmFyLW1lbnUnKTtcclxuICAgICAgICBpZighdGIgfHwgIW1iKSByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe29rOmZhbHNlLCBkZXRhaWw6J21pc3NpbmcgdGl0bGViYXIvbWVudSd9KTtcclxuICAgICAgICB2YXIgY3M9Z2V0Q29tcHV0ZWRTdHlsZSh0YiksIG1zPWdldENvbXB1dGVkU3R5bGUobWIpO1xyXG4gICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh7IG9rOiBjcy5oZWlnaHQgPT09ICc0NHB4JyAmJiBjcy53ZWJraXRBcHBSZWdpb24gPT09ICdkcmFnJyAmJiBtcy53ZWJraXRBcHBSZWdpb24gPT09ICduby1kcmFnJyAmJiBtYi5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKS5oZWlnaHQgPj0gMzYsXHJcbiAgICAgICAgICBkZXRhaWw6ICdoPScrY3MuaGVpZ2h0KycgcmVnaW9uPScrY3Mud2Via2l0QXBwUmVnaW9uKycgbWVudS1yZWdpb249Jyttcy53ZWJraXRBcHBSZWdpb24rJyBtZW51LWg9JytNYXRoLnJvdW5kKG1iLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpLmhlaWdodCkgfSk7XHJcbiAgICAgIH0pKClgKSkgYXMgc3RyaW5nO1xyXG4gICAgICBjb25zdCBwID0gSlNPTi5wYXJzZShyKSBhcyB7IG9rOiBib29sZWFuOyBkZXRhaWw6IHN0cmluZyB9O1xyXG4gICAgICAvLyBcdTRFM0JcdThGREJcdTdBMEJcdTRGQTc6XHU1MzlGXHU3NTFGIHRpdGxlQmFyT3ZlcmxheSBcdTlBRDhcdTVFQTZcdTk4N0JcdTU0MENcdTRFM0EgNDQoV2luZG93cyBcdTYyNERcdTY3MDkgb3ZlcmxheTtcdTY1RTdcdTdDN0JcdTU3OEJcdTdGM0FcdTZCNjQgQVBJLFx1NTNFRlx1OTAwOVx1OEMwM1x1NzUyOClcclxuICAgICAgbGV0IG92ZXJsYXkgPSAnbi9hJztcclxuICAgICAgdHJ5IHtcclxuICAgICAgICBjb25zdCBwcm9iZSA9IHdpbiBhcyB1bmtub3duIGFzIHsgZ2V0VGl0bGVCYXJPdmVybGF5PzogKCkgPT4geyBoZWlnaHQ/OiBudW1iZXIgfSB8IG51bGwgfTtcclxuICAgICAgICBjb25zdCBvID0gcHJvYmUuZ2V0VGl0bGVCYXJPdmVybGF5Py4oKSA/PyBudWxsO1xyXG4gICAgICAgIG92ZXJsYXkgPSBvICE9PSBudWxsID8gU3RyaW5nKG8uaGVpZ2h0KSA6ICduL2EnO1xyXG4gICAgICB9IGNhdGNoIHsgLyogXHU1RTczXHU1M0YwXHU2NUUwIG92ZXJsYXkgKi8gfVxyXG4gICAgICByZXR1cm4gW3Aub2sgPT09IHRydWUsIGAke3AuZGV0YWlsfSBvdmVybGF5LWg9JHtvdmVybGF5fWBdO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NjZGNFx1NjVCMFx1NkEyQVx1NUU0NShtb2NrIHVwZGF0ZTpzdGF0ZSBcdTRFMDlcdTYwMDE7XHU0RUZCXHU1MkExIDEzLUMpID09PT09PT09PT1cclxuICAgICAgIFx1NEUzQlx1OEZEQlx1N0EwQlx1NzZGNFx1NTNEMSBtb2NrIFx1NzJCNlx1NjAwMTpcdTY4QzBcdTY3RTVcdTRFMkRcdTk3NTlcdTlFRDggXHUyMTkyIFx1NEUwQlx1OEY3RFx1NEUyRChcdThGREJcdTVFQTYvXHU5MDFGXHU1RUE2L1x1OEZEQlx1NUVBNlx1Njc2MSlcdTIxOTIgXHU1QzMxXHU3RUVBXHJcbiAgICAgICAoXCJcdTkxQ0RcdTU0MkZcdTY2RjRcdTY1QjBcIlx1NTNFRlx1NzBCOVx1MzAwMVx1NjVFMFx1NTkxNlx1OTRGRVx1MzAwMWFwcGx5IFx1NEUwRFx1NUQyOSlcdTIxOTIgXHU1OTMxXHU4RDI1KFx1OTFDRFx1OEJENVx1NkQ0MVx1OEY2QyArIFx1N0EwRFx1NTQwRVx1NTE3M1x1OTVFRClcdTMwMDIgKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1NjZGNFx1NjVCMFx1NkEyQVx1NUU0NTpcdTY4QzBcdTY3RTVcdTRFMkRcdTk3NTlcdTlFRDhcdTY1RTBcdTZBMkFcdTVFNDUgXHUyMTkyIFx1NEUwQlx1OEY3RFx1NEUyRFx1OEZEQlx1NUVBNlx1NTNFRlx1ODlDMShcdTVCNTdcdTgyODIvXHU5MDFGXHU1RUE2L1x1OEZEQlx1NUVBNlx1Njc2MSknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHN0QmFzZSA9IHsgY2hlY2tpbmc6IGZhbHNlLCBjdXJyZW50VmVyc2lvbjogJzAuMi45JywgbGF0ZXN0OiBudWxsLCBub3RlczogJycsIGRvd25sb2FkZWQ6IGZhbHNlLCBlcnJvcjogJycsIGNoYW5uZWw6ICcnLCBwcm9ncmVzczogbnVsbCB9O1xyXG4gICAgICAvLyBjaGVja2luZyBcdTYwMDE6XHU5NzU5XHU5RUQ4XHU2OEMwXHU2N0U1LFx1NEUwRFx1NjI1M1x1NjI3MFx1NEVGQlx1NTJBMVx1NTMzQVxyXG4gICAgICB3aW4ud2ViQ29udGVudHMuc2VuZCgndXBkYXRlOnN0YXRlJywgeyAuLi5zdEJhc2UsIGNoZWNraW5nOiB0cnVlIH0pO1xyXG4gICAgICBhd2FpdCBzbGVlcCg0MDApO1xyXG4gICAgICBjb25zdCBzaWxlbnQgPSAoYXdhaXQganMoYCFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudXBkYXRlLWJhbm5lcicpYCkpIGFzIGJvb2xlYW47XHJcbiAgICAgIC8vIFx1NEUwQlx1OEY3RFx1NEUyRDpcdTcyNDhcdTY3MkNcdTUzRjcgKyBcdTVERjJcdTRFMEJcdThGN0QvXHU2MDNCXHU1QjU3XHU4MjgyICsgXHU5MDFGXHU1RUE2ICsgXHU4RkRCXHU1RUE2XHU2NzYxXHU1QkJEXHU1RUE2XHJcbiAgICAgIHdpbi53ZWJDb250ZW50cy5zZW5kKCd1cGRhdGU6c3RhdGUnLCB7IC4uLnN0QmFzZSwgbGF0ZXN0OiAndjAuMy4wJywgY2hhbm5lbDogJ2F0b21naXQoXHU1NkZEXHU1MTg1KScsIHByb2dyZXNzOiB7IHJlY2VpdmVkOiA0N18wMDBfMDAwLCB0b3RhbDogMTEyXzE0N18xOTksIHNwZWVkQnBzOiAyXzEwMF8wMDAgfSB9KTtcclxuICAgICAgY29uc3QgZGwgPSBhd2FpdCB3YWl0Rm9yKCdkb3dubG9hZGluZyBiYW5uZXInLCBgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnVwZGF0ZS1iYW5uZXInKTtcclxuICAgICAgICBpZighYikgcmV0dXJuIHtvazpmYWxzZSwgZGV0YWlsOidubyBiYW5uZXInfTtcclxuICAgICAgICB2YXIgdD1iLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJyk7XHJcbiAgICAgICAgdmFyIGJhcj1iLnF1ZXJ5U2VsZWN0b3IoJy51cGRhdGUtYmFyLWZpbGwnKTtcclxuICAgICAgICB2YXIgdz1iYXI/cGFyc2VGbG9hdChiYXIuc3R5bGUud2lkdGgpOjA7XHJcbiAgICAgICAgcmV0dXJuIHtvazogdC5pbmRleE9mKCd2MC4zLjAnKT49MCAmJiB0LmluZGV4T2YoJy8nKT49MCAmJiB0LmluZGV4T2YoJy9zJyk+PTAgJiYgdz4zMCAmJiB3PD0xMDAsIGRldGFpbDogJ3RleHQ9Jyt0LnNsaWNlKDAsNzApKycgYmFyVz0nK3d9O2AsIDVfMDAwKTtcclxuICAgICAgYXdhaXQgc2hvdCgndXBkYXRlLWRvd25sb2FkaW5nJyk7XHJcbiAgICAgIHJldHVybiBbc2lsZW50ICYmIGRsWzBdLCBgY2hlY2tpbmcgXHU5NzU5XHU5RUQ4PSR7c2lsZW50fTsgJHtkbFsxXX1gXTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnXHU2NkY0XHU2NUIwXHU2QTJBXHU1RTQ1Olx1NUMzMVx1N0VFQVx1NjAwMVwiXHU5MUNEXHU1NDJGXHU2NkY0XHU2NUIwXCJcdTUzRUZcdTcwQjlcdTMwMDFcdTY1RTBcdTU5MTZcdTk0RkVcdTVGMTVcdTVCRkMsYXBwbHkgXHU4OUU2XHU1M0QxIHByZWxvYWQgXHU0RTE0XHU4RkRCXHU3QTBCXHU1QjU4XHU2RDNCJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICB3aW4ud2ViQ29udGVudHMuc2VuZCgndXBkYXRlOnN0YXRlJywgeyBjaGVja2luZzogZmFsc2UsIGN1cnJlbnRWZXJzaW9uOiAnMC4yLjknLCBsYXRlc3Q6ICd2MC4zLjAnLCBub3RlczogJycsIGRvd25sb2FkZWQ6IHRydWUsIGVycm9yOiAnJywgY2hhbm5lbDogJ2F0b21naXQoXHU1NkZEXHU1MTg1KScsIHByb2dyZXNzOiBudWxsIH0pO1xyXG4gICAgICBjb25zdCByZWFkeSA9IGF3YWl0IHdhaXRGb3IoJ3JlYWR5IGJhbm5lcicsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudXBkYXRlLWJhbm5lcicpO1xyXG4gICAgICAgIHZhciBidG49Yj9iLnF1ZXJ5U2VsZWN0b3IoJy51cGRhdGUtcmVzdGFydCcpOm51bGw7XHJcbiAgICAgICAgdmFyIGxpbmtzPWI/Yi5xdWVyeVNlbGVjdG9yQWxsKCdhJykubGVuZ3RoOi0xO1xyXG4gICAgICAgIHZhciBub0V4dD1iPyhiLnRleHRDb250ZW50LmluZGV4T2YoJ1x1NEUwQlx1OEY3RFx1OTg3NScpPDAgJiYgYi50ZXh0Q29udGVudC5pbmRleE9mKCdodHRwJyk8MCk6ZmFsc2U7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFiICYmICEhYnRuICYmIGJ0bi5kaXNhYmxlZD09PWZhbHNlICYmIGxpbmtzPT09MCAmJiBub0V4dCwgZGV0YWlsOiAnYnRuPScrKGJ0bj9idG4udGV4dENvbnRlbnQ6J25vbmUnKSsnIGxpbmtzPScrbGlua3MrJyBub0V4dD0nK25vRXh0fTtgLCA1XzAwMCk7XHJcbiAgICAgIGF3YWl0IHNob3QoJ3VwZGF0ZS1yZWFkeScpO1xyXG4gICAgICBpZiAoIXJlYWR5WzBdKSByZXR1cm4gcmVhZHk7XHJcbiAgICAgIC8vIHByZWxvYWQgXHU2ODY1XHU1NzI4ICsgXHU3MEI5XHU1MUZCXHU1NDBFXHU4RkRCXHU3QTBCXHU1QjU4XHU2RDNCKG1vY2sgXHU2NUUwXHU1Qjg5XHU4OEM1XHU1MzA1IFx1MjE5MiBhcHBseVVwZGF0ZSBuby1vcCBcdTRFMERcdTkwMDBcdTUxRkE7XHJcbiAgICAgIC8vIFx1NEUzQlx1OEZEQlx1N0EwQlx1NEZBN1x1NjcwOSBcImFwcGx5IHJlcXVlc3RlZFwiIFx1NjVFNVx1NUZEN1x1ODg0QyxcdTc1MzFcdTlBNzFcdTUyQThcdTU2NjhcdThGOTNcdTUxRkFcdTRFQkFcdTVCQTEpXHUzMDAyXHJcbiAgICAgIGNvbnN0IGhhc0JyaWRnZSA9IChhd2FpdCBqcyhgdHlwZW9mIHdpbmRvdy5obWguYXBwbHlVcGRhdGUgPT09ICdmdW5jdGlvbicgJiYgdHlwZW9mIHdpbmRvdy5obWguY2hlY2tVcGRhdGUgPT09ICdmdW5jdGlvbidgKSkgYXMgYm9vbGVhbjtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudXBkYXRlLWJhbm5lciAudXBkYXRlLXJlc3RhcnQnKTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGF3YWl0IHNsZWVwKDgwMCk7XHJcbiAgICAgIGNvbnN0IGFsaXZlID0gKGF3YWl0IGpzKGAhIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy51cGRhdGUtYmFubmVyJykgJiYgISFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY29tcG9zZXIgdGV4dGFyZWEnKWApKSBhcyBib29sZWFuO1xyXG4gICAgICByZXR1cm4gW2hhc0JyaWRnZSAmJiBhbGl2ZSwgYHByZWxvYWQgYXBwbHlVcGRhdGUvY2hlY2tVcGRhdGU9JHtoYXNCcmlkZ2V9OyBcdTcwQjlcdTUxRkJcdTU0MEVcdTZBMkFcdTVFNDVcdTRFMEUgY29tcG9zZXIgXHU1QjU4XHU2RDNCPSR7YWxpdmV9YF07XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ1x1NjZGNFx1NjVCMFx1NkEyQVx1NUU0NTpcdTU5MzFcdThEMjVcdTYwMDFcdTk1MTlcdThCRUZcdTY2MEVcdTdFQzYrXHU5MUNEXHU4QkQ1XHU2RDQxXHU4RjZDLFx1N0EwRFx1NTQwRVx1NTNFRlx1NTE3M1x1OTVFRCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgd2luLndlYkNvbnRlbnRzLnNlbmQoJ3VwZGF0ZTpzdGF0ZScsIHsgY2hlY2tpbmc6IGZhbHNlLCBjdXJyZW50VmVyc2lvbjogJzAuMi45JywgbGF0ZXN0OiBudWxsLCBub3RlczogJycsIGRvd25sb2FkZWQ6IGZhbHNlLCBlcnJvcjogJ1x1NTE2OFx1OTBFOFx1NjhDMFx1NjdFNVx1OTAxQVx1OTA1M1x1NTkzMVx1OEQyNShcdTc2RjRcdThGREU6XHU4RDg1XHU2NUY2KDhzKTsgYXRvbWdpdChcdTU2RkRcdTUxODUpOkhUVFAgNTAyOyBnaC1wcm94eTpcdThEODVcdTY1RjYoMTBzKSknLCBjaGFubmVsOiAnJywgcHJvZ3Jlc3M6IG51bGwgfSk7XHJcbiAgICAgIGNvbnN0IGVyciA9IGF3YWl0IHdhaXRGb3IoJ2Vycm9yIGJhbm5lcicsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudXBkYXRlLWJhbm5lcicpO1xyXG4gICAgICAgIHZhciBidG49Yj9iLnF1ZXJ5U2VsZWN0b3IoJy51cGRhdGUtcmV0cnknKTpudWxsO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYiAmJiBiLnRleHRDb250ZW50LmluZGV4T2YoJ1x1NjZGNFx1NjVCMFx1NjhDMFx1NjdFNVx1NTkzMVx1OEQyNScpPj0wICYmIGIudGV4dENvbnRlbnQuaW5kZXhPZignYXRvbWdpdCcpPj0wICYmICEhYnRuICYmIGJ0bi5kaXNhYmxlZD09PWZhbHNlLCBkZXRhaWw6IGIgPyBiLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw5MCkgOiAnbm8gYmFubmVyJ307YCwgNV8wMDApO1xyXG4gICAgICBhd2FpdCBzaG90KCd1cGRhdGUtZXJyb3InKTtcclxuICAgICAgaWYgKCFlcnJbMF0pIHJldHVybiBlcnI7XHJcbiAgICAgIC8vIFx1NzBCOVx1OTFDRFx1OEJENSBcdTIxOTIgXHU4RkRCXHU1MTY1IGNoZWNraW5nKFx1NkEyQVx1NUU0NVx1NjMwOVx1NzJCNlx1NjAwMVx1NjczQVx1NjUzNlx1OEQ3NztcdTc3MUZcdTVCOUUgY2hlY2tGb3JVcGRhdGVzIFx1NTcyOFx1NTQwRVx1NTNGMFx1OEREMSxcdTRFMERcdTVGNzFcdTU0Q0RcdTY3MkNcdTZCNjUpXHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnVwZGF0ZS1iYW5uZXIgLnVwZGF0ZS1yZXRyeScpOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgdG9DaGVja2luZyA9IGF3YWl0IHdhaXRGb3IoJ2Jhbm5lciBoaWRkZW4gb24gcmV0cnknLCBgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy51cGRhdGUtYmFubmVyJyksIGRldGFpbDogZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnVwZGF0ZS1iYW5uZXInKSA/ICdzdGlsbCcgOiAnaGlkZGVuJ307YCwgNV8wMDApO1xyXG4gICAgICAvLyBcdTYwNjJcdTU5MERcdTVDMzFcdTdFRUFcdTYwMDFcdTlBOENcdThCQzFcIlx1N0EwRFx1NTQwRVwiOlx1NzBCOVx1NTFGQlx1NTQwRVx1NkEyQVx1NUU0NVx1NTE3M1x1OTVFRChcdTRGMUFcdThCRERcdTUxODVcdTk3NTlcdTlFRDgsXHU0RTBCXHU2QjIxXHU1NDJGXHU1MkE4XHU1MThEXHU2M0QwXHU5MTkyKVxyXG4gICAgICB3aW4ud2ViQ29udGVudHMuc2VuZCgndXBkYXRlOnN0YXRlJywgeyBjaGVja2luZzogZmFsc2UsIGN1cnJlbnRWZXJzaW9uOiAnMC4yLjknLCBsYXRlc3Q6ICd2MC4zLjAnLCBub3RlczogJycsIGRvd25sb2FkZWQ6IHRydWUsIGVycm9yOiAnJywgY2hhbm5lbDogJ2F0b21naXQoXHU1NkZEXHU1MTg1KScsIHByb2dyZXNzOiBudWxsIH0pO1xyXG4gICAgICBhd2FpdCB3YWl0Rm9yKCdyZWFkeSBhZ2FpbicsIGByZXR1cm4ge29rOiAhIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy51cGRhdGUtYmFubmVyIC51cGRhdGUtcmVzdGFydCcpLCBkZXRhaWw6ICdyZWFkeSd9O2AsIDVfMDAwKTtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYnM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudXBkYXRlLWJhbm5lciBidXR0b24nKSk7IHZhciBiPWJzLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU3QTBEXHU1NDBFJyk+PTA7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBkaXNtaXNzZWQgPSBhd2FpdCB3YWl0Rm9yKCdiYW5uZXIgZGlzbWlzc2VkJywgYHJldHVybiB7b2s6ICFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudXBkYXRlLWJhbm5lcicpLCBkZXRhaWw6IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy51cGRhdGUtYmFubmVyJykgPyAnc3RpbGwnIDogJ2Rpc21pc3NlZCd9O2AsIDVfMDAwKTtcclxuICAgICAgcmV0dXJuIFt0b0NoZWNraW5nWzBdICYmIGRpc21pc3NlZFswXSwgYFx1OTFDRFx1OEJENVx1MjE5MmNoZWNraW5nIFx1NjUzNlx1OEQ3Nz0ke3RvQ2hlY2tpbmdbMF19OyBcdTdBMERcdTU0MEVcdTUxNzNcdTk1RUQ9JHtkaXNtaXNzZWRbMF19YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICBhd2FpdCBzaG90KCdmaW5hbCcpO1xyXG4gIH0gZWxzZSBpZiAoKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX1dJWkFSRCA/PyAnJykgIT09ICcnKSB7XHJcbiAgICAvKiA9PT09PT09PT09IHJlYWwoXHU1NDExXHU1QkZDXHU2Nzg0XHU5MDIwLFx1NEU5Mlx1NjVBNVx1NEU4RVx1NUUzOFx1ODlDNCByZWFsIFx1NkI2NVx1OUFBNCk6XHJcbiAgICAgICBXWjIgXHU2NzJDXHU2NzNBXHU3NzFGXHU1QjlFXHU2OEMwXHU2RDRCKFx1OUVEOFx1OEJBNFx1NTE3MVx1NEVBQlx1OTg3NSkvIFdaMyBcdTRFMEJcdThGN0RcdTVCODlcdTg4QzVcdTVCOUVcdTZENEIgPT09PT09PT09PSAqL1xyXG4gICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX1dJWkFSRCA9PT0gJ2RldGVjdCcpIHtcclxuICAgICAgYXdhaXQgc3RlcCgnXHU1NDExXHU1QkZDKFx1NzcxRlx1NUI5RSk6XHU2QjIyXHU4RkNFXHUyMTkyXHU2OEMwXHU2RDRCXHU1MjMwXHU2NzJDXHU2NzNBXHU1REYyXHU4OEM1IENMSShcdTlFRDhcdThCQTRcdTUxNzFcdTRFQUIsXHU1MkZFXHU5MDA5XHU2QjYzXHU3ODZFKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignd2l6YXJkIG92ZXJsYXknLCBgdmFyIG89ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1vdmVybGF5Jyk7XHJcbiAgICAgICAgICB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1RjAwXHU1OUNCXHU5MTREXHU3RjZFJzt9KTtcclxuICAgICAgICAgIHJldHVybiB7b2s6ICEhbyAmJiAhIWIsIGRldGFpbDogbyA/ICdvdmVybGF5K1x1NUYwMFx1NTlDQlx1OTE0RFx1N0Y2RScgOiAnbm8gb3ZlcmxheSd9O2AsIDEyXzAwMCk7XHJcbiAgICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgICBhd2FpdCBzaG90KCd3aXphcmQtcmVhbC13ZWxjb21lJyk7XHJcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1RjAwXHU1OUNCXHU5MTREXHU3RjZFJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgY29uc3QgZm91bmQgPSBhd2FpdCB3YWl0Rm9yKCdkZXRlY3QgZm91bmQnLCBgdmFyIHA9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLWRldGVjdCcpO1xyXG4gICAgICAgICAgaWYoIXApIHJldHVybiB7b2s6ZmFsc2UsIGRldGFpbDonZGV0ZWN0IHBhZ2Ugbm90IHNob3duJ307XHJcbiAgICAgICAgICB2YXIgdD1wLnRleHRDb250ZW50O1xyXG4gICAgICAgICAgdmFyIG9rMT10LmluZGV4T2YoJ1x1NjhDMFx1NkQ0Qlx1NTIzMFx1NURGMlx1NUI4OVx1ODhDNSBobWhhcm5lc3MgdicpPj0wO1xyXG4gICAgICAgICAgdmFyIG9rMj10LmluZGV4T2YoJ1x1OUVEOFx1OEJBNFx1NTE3MVx1NEVBQlx1NEY3Rlx1NzUyOFx1NUI4MyhcdTYzQThcdTgzNTApJyk+PTA7XHJcbiAgICAgICAgICB2YXIgcmFkaW89cC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW9wdC5vbicpO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogb2sxJiZvazImJiEhcmFkaW8sIGRldGFpbDogdC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsOTApfTtgLCAyMF8wMDApO1xyXG4gICAgICAgIGF3YWl0IHNob3QoJ3dpemFyZC1yZWFsLWRldGVjdCcpO1xyXG4gICAgICAgIHJldHVybiBmb3VuZDtcclxuICAgICAgfSk7XHJcbiAgICB9IGVsc2UgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX1dJWkFSRCA9PT0gJ2luc3RhbGwnKSB7XHJcbiAgICAgIGF3YWl0IHN0ZXAoJ1x1NTQxMVx1NUJGQyhcdTc3MUZcdTVCOUUpOlx1NjhDMFx1NkQ0Qlx1MjE5Mlx1NEVDRFx1ODk4MVx1NEUwQlx1OEY3RFx1NjVCMFx1NzI0OFx1MjE5Mlx1OTAwOVx1NjJFOVx1MjQ2MFx1MjE5Mlx1OEZEQlx1NTE2NVx1NUI4OVx1ODhDNVx1OTg3NScsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignd2l6YXJkIG92ZXJsYXknLCBgdmFyIG89ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1vdmVybGF5Jyk7XHJcbiAgICAgICAgICByZXR1cm4ge29rOiAhIW8sIGRldGFpbDogbyA/ICdvcGVuJyA6ICdjbG9zZWQnfTtgLCAxMl8wMDApO1xyXG4gICAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1RjAwXHU1OUNCXHU5MTREXHU3RjZFJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgY29uc3QgZm91bmQgPSBhd2FpdCB3YWl0Rm9yKCdkZXRlY3QgZm91bmQnLCBgdmFyIHA9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLWRldGVjdCcpO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogISFwICYmIHAudGV4dENvbnRlbnQuaW5kZXhPZignXHU2OEMwXHU2RDRCXHU1MjMwXHU1REYyXHU1Qjg5XHU4OEM1IGhtaGFybmVzcyB2Jyk+PTAsIGRldGFpbDogcCA/IHAudGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDYwKSA6ICdubyBkZXRlY3QgcGFnZSd9O2AsIDIwXzAwMCk7XHJcbiAgICAgICAgaWYgKCFmb3VuZFswXSkgcmV0dXJuIGZvdW5kO1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIG89W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW9wdCcpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1NEVDRFx1ODk4MVx1NEUwQlx1OEY3RFx1NjVCMFx1NzI0OCcpPj0wO30pOyBpZihvKSBvLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICBhd2FpdCBzbGVlcCgyMDApO1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NEUwQlx1NEUwMFx1NkI2NSc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgIGNvbnN0IHNlbCA9IGF3YWl0IHdhaXRGb3IoJ3NlbGVjdCBwYWdlIFx1MjQ2MCBvbicsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2Utc2VsZWN0Jyk7XHJcbiAgICAgICAgICB2YXIgb249cD9wLnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3B0Lm9uJyk6bnVsbDtcclxuICAgICAgICAgIHJldHVybiB7b2s6ICEhcCAmJiAhIW9uICYmIG9uLnRleHRDb250ZW50LmluZGV4T2YoJ1x1NEUwQlx1OEY3RFx1NUI4OVx1ODhDNVx1NUI4Q1x1NjU3NCBobWggQ0xJJyk+PTAsIGRldGFpbDogcCA/ICdzZWxlY3QgXHUyNDYwIG9uJyA6ICdubyBzZWxlY3QnfTtgLCA4XzAwMCk7XHJcbiAgICAgICAgaWYgKCFzZWxbMF0pIHJldHVybiBzZWw7XHJcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1RjAwXHU1OUNCXHU1Qjg5XHU4OEM1Jzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgcmV0dXJuIHdhaXRGb3IoJ2luc3RhbGwgcGFnZScsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtaW5zdGFsbCcpO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogISFwLCBkZXRhaWw6IHAgPyAnaW5zdGFsbGluZycgOiAnbm90IHNob3duJ307YCwgOF8wMDApO1xyXG4gICAgICB9KTtcclxuICAgICAgYXdhaXQgc3RlcCgnXHU1NDExXHU1QkZDKFx1NzcxRlx1NUI5RSk6XHU1Qjg5XHU4OEM1XHU4RkRCXHU1RUE2XHU1M0VGXHU4OUMxKFx1NkI2NVx1OUFBNFx1NjU4N1x1Njg0OC9cdTRFMEJcdThGN0RcdTc2N0VcdTUyMDZcdTZCRDRcdTZFREFcdTUyQTgpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdwcm9ncmVzcyB2aXNpYmxlJywgYHZhciBiYXI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1wcm9ncmVzcycpO1xyXG4gICAgICAgICAgdmFyIGxvZz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWluc3RhbGwtbG9nJyk7XHJcbiAgICAgICAgICB2YXIgbGluZXM9bG9nP2xvZy50ZXh0Q29udGVudC5zcGxpdCgnXFxcXG4nKS5maWx0ZXIoZnVuY3Rpb24oeCl7cmV0dXJuIHgudHJpbSgpIT09Jyc7fSk6W107XHJcbiAgICAgICAgICByZXR1cm4ge29rOiAhIWJhciAmJiBsaW5lcy5sZW5ndGg+PTEsIGRldGFpbDogJ2Jhcj0nKyhiYXI/J3knOiduJykrJyBsaW5lcz0nK2xpbmVzLmxlbmd0aCsobGluZXMubGVuZ3RoPjA/KCcgbGFzdD0nKyhsaW5lc1tsaW5lcy5sZW5ndGgtMV18fCcnKS5zbGljZSgwLDUwKSk6JycpfTtgLCA2MF8wMDApO1xyXG4gICAgICAgIGF3YWl0IHNob3QoJ3dpemFyZC1yZWFsLWluc3RhbGwnKTtcclxuICAgICAgICByZXR1cm4gdztcclxuICAgICAgfSk7XHJcbiAgICAgIGF3YWl0IHN0ZXAoJ1x1NTQxMVx1NUJGQyhcdTc3MUZcdTVCOUUpOlx1NUI4OVx1ODhDNVx1NUI4Q1x1NjIxMFx1MjE5Mlx1OTE0RFx1N0Y2RVx1OERGM1x1OEZDNyhcdTVERjJcdTY3MDlcdTVCQzZcdTk0QTUpXHUyMTkyXHU1QjhDXHU2MjEwXHU5ODc1XHUyMTkyXHU1RjAwXHU1OUNCXHU0RjdGXHU3NTI4XHUyMTkyXHU2NUIwIHJ1bnRpbWUgXHU4RkRFXHU2M0E1JywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIC8vIFx1NUI4OVx1ODhDNVx1NTE2OFx1N0EwQihucG0gXHU4OUUzXHU2NzkwK1x1NEUwQlx1OEY3RCtcdTg0M0RcdTc2RDg7XHU5NTVDXHU1MENGIG5wbW1pcnJvciBcdTkwMUFcdTVFMzggPDIgXHU1MjA2XHU5NDlGKSxcdTRFMEFcdTk2NTAgOCBcdTUyMDZcdTk0OUZcclxuICAgICAgICBhd2FpdCB3YWl0Rm9yKCdkb25lIHBhZ2UnLCBgdmFyIGQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLWRvbmUnKTtcclxuICAgICAgICAgIGlmKGQpIHJldHVybiB7b2s6dHJ1ZSwgZGV0YWlsOidkb25lJ307XHJcbiAgICAgICAgICB2YXIgYz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtY29uZmlnJyk7XHJcbiAgICAgICAgICBpZihjKXsgdmFyIHM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU4REYzXHU4RkM3Jyk+PTA7fSk7IGlmKHMpIHMuY2xpY2soKTsgfVxyXG4gICAgICAgICAgdmFyIGVycj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWVycm9yJyk7XHJcbiAgICAgICAgICBpZihlcnIpIHJldHVybiB7b2s6ZmFsc2UsIGRldGFpbDonaW5zdGFsbCBlcnJvcjogJytlcnIudGV4dENvbnRlbnQuc2xpY2UoMCw4MCl9O1xyXG4gICAgICAgICAgcmV0dXJuIHtvazpmYWxzZSwgZGV0YWlsOidpbnN0YWxsaW5nXHUyMDI2J307YCwgOCAqIDYwXzAwMCk7XHJcbiAgICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2RvbmUgcmVhZHkgdGV4dCcsIGB2YXIgZD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtZG9uZScpO1xyXG4gICAgICAgICAgdmFyIHQ9ZD9kLnRleHRDb250ZW50OicnO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogISFkICYmIHQuaW5kZXhPZignXHU1QzMxXHU3RUVBJyk+PTAsIGRldGFpbDogdC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNjApfTtgLCAxMF8wMDApO1xyXG4gICAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgICAgYXdhaXQgc2hvdCgnd2l6YXJkLXJlYWwtZG9uZScpO1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NUYwMFx1NTlDQlx1NEY3Rlx1NzUyOCc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgIGNvbnN0IGNvbm5lY3RlZCA9IGF3YWl0IHdhaXRGb3IoJ25ldyBydW50aW1lIGNvbm5lY3RlZCcsIGB2YXIgZG90PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ob3N0LWRvdC5vbicpO1xyXG4gICAgICAgICAgdmFyIGw9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmhvc3QtbGFiZWwnKTtcclxuICAgICAgICAgIHJldHVybiB7b2s6ICEhZG90ICYmICEhbCAmJiBsLnRleHRDb250ZW50LmluZGV4T2YoJ3J1bnRpbWUnKT49MCwgZGV0YWlsOiAnZG90PScrKGRvdD8nb24nOidvZmYnKSsnIGxhYmVsPScrKGw/bC50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNTApOidub25lJyl9O2AsIDYwXzAwMCk7XHJcbiAgICAgICAgY29uc3Qgc3QgPSAoYXdhaXQganMoYHdpbmRvdy5obWguZ2V0U3RhdGUoKS50aGVuKGZ1bmN0aW9uKHIpe3JldHVybiBKU09OLnN0cmluZ2lmeSh7bW9kZTpyLm1vZGUsIHJ1bnRpbWVFbnRyeTpyLnJ1bnRpbWVFbnRyeX0pO30pYCkpIGFzIHN0cmluZztcclxuICAgICAgICBjb25zdCBwID0gSlNPTi5wYXJzZShzdCkgYXMgeyBtb2RlPzogc3RyaW5nOyBydW50aW1lRW50cnk/OiBzdHJpbmcgfCBudWxsIH07XHJcbiAgICAgICAgY29uc3QgZW50cnlPayA9IChwLnJ1bnRpbWVFbnRyeSA/PyAnJykuaW5kZXhPZignLmhtaGFybmVzcy1nbG9iYWwnKSA+PSAwO1xyXG4gICAgICAgIGF3YWl0IHNob3QoJ3dpemFyZC1yZWFsLWZpbmFsJyk7XHJcbiAgICAgICAgcmV0dXJuIFtjb25uZWN0ZWRbMF0gJiYgZW50cnlPaywgYGNvbm5lY3RlZDogJHtjb25uZWN0ZWRbMV19OyBzdGF0ZT0ke3N0LnNsaWNlKDAsIDkwKX1gXTtcclxuICAgICAgfSk7XHJcbiAgICB9XHJcbiAgICBhd2FpdCBzaG90KCdmaW5hbCcpO1xyXG4gIH0gZWxzZSB7XHJcbiAgICAvKiA9PT09PT09PT09IHJlYWw6XHU1M0VBXHU4QkZCXHU1QjUwXHU5NkM2KFx1NEUwRFx1NTJBOFx1NzcxRlx1NUI5RVx1NEYxQVx1OEJERCkgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU5ODc2XHU2ODBGOnJ1bnRpbWUgXHU3MjQ4XHU2NzJDXHU0RTBFXHU3QUVGXHU1M0UzXHU1REYyXHU2NjNFXHU3OTNBKFx1OTc1RSA/KScsIGFzeW5jICgpID0+IHtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2hvc3QgbGFiZWwnLCBgdmFyIGw9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmhvc3QtbGFiZWwnKTtcclxuICAgICAgICB2YXIgdCA9IGwgPyBsLnRleHRDb250ZW50IDogJyc7XHJcbiAgICAgICAgcmV0dXJuIHtvazogdC5pbmRleE9mKCc/JykgPCAwICYmIHQuaW5kZXhPZigncnVudGltZScpID49IDAsIGRldGFpbDogdC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNjApfTtgLCAxNV8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdcdTRGMUFcdThCRERcdTUyMTdcdTg4Njg6XHU3NzFGXHU1QjlFXHU1Mzg2XHU1M0YyXHU1MkEwXHU4RjdEKFx1NjU3MFx1OTFDRj4wKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ3Nlc3Npb25zJywgYHZhciBuPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGg7XHJcbiAgICAgICAgcmV0dXJuIHtvazogbiA+IDAsIGRldGFpbDogJ3Nlc3Npb25zPScrbn07YCwgMTVfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnXHU3MEI5XHU1MUZCXHU1Mzg2XHU1M0YyXHU0RjFBXHU4QkREIFx1MjE5MiBcdTc3MUZcdTVCOUUgdHJhbnNjcmlwdCBcdTUxODVcdTVCQjlcdTUzRUZcdTg5QzEnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IG4gPSAoYXdhaXQganMoYGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGhgKSkgYXMgbnVtYmVyO1xyXG4gICAgICBpZiAobiA9PT0gMCkgcmV0dXJuIFtmYWxzZSwgJ25vIHNlc3Npb25zIHRvIGNsaWNrJ107XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGl0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zZXNzaW9uLWl0ZW0nKTsgaWYgKGl0KSBpdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdoaXN0b3J5IHR1cm5zJywgYHZhciB0cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50dXJuJykpO1xyXG4gICAgICAgIHJldHVybiB7b2s6IHRzLmxlbmd0aCA+PSAxLCBkZXRhaWw6ICd0dXJucz0nK3RzLmxlbmd0aCsnIGZpcnN0PScrKHRzWzBdP3RzWzBdLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw0MCk6J25vbmUnKX07YCwgMTVfMDAwKTtcclxuICAgICAgYXdhaXQgc2hvdCgncmVhbC1oaXN0b3J5Jyk7XHJcbiAgICAgIHJldHVybiB3O1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdEb2NrOk92ZXJ2aWV3IFx1NzcxRlx1NUI5RVx1NjU3MFx1NjM2RShydW50aW1lIFx1NzI0OFx1NjcyQ1x1OTc1RVx1NjVFMFx1NjU3MFx1NjM2RSknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdPdmVydmlldyc7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignb3ZlcnZpZXcnLCBgdmFyIHJvd3M9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay1yb3cnKSk7XHJcbiAgICAgICAgdmFyIHZlciA9IHJvd3MuZmluZChmdW5jdGlvbihyKXsgcmV0dXJuIHIudGV4dENvbnRlbnQuaW5kZXhPZigncnVudGltZSBcdTcyNDhcdTY3MkMnKT49MDsgfSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISF2ZXIgJiYgdmVyLnRleHRDb250ZW50LmluZGV4T2YoJ1x1NjVFMFx1NjU3MFx1NjM2RScpIDwgMCwgZGV0YWlsOiB2ZXIgPyB2ZXIudGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDUwKSA6ICdubyB2ZXIgcm93J307YCwgMTBfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnRG9jazpEaWZmIFx1NzcxRlx1NUI5RSBnaXQgXHU3MkI2XHU2MDAxKFx1OTc1RVx1NTJBMFx1OEY3RFx1NEUyRCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdcdTUzRDhcdTY2RjQnfHx4LnRleHRDb250ZW50PT09J0RpZmYnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2RpZmYnLCBgdmFyIHA9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmRpZmYtcGFuZScpO1xyXG4gICAgICAgIHZhciB0ID0gcCA/IHAudGV4dENvbnRlbnQgOiAnJztcclxuICAgICAgICByZXR1cm4ge29rOiAhIXAgJiYgdC5pbmRleE9mKCdcdTUyQTBcdThGN0RcdTRFMkQnKSA8IDAsIGRldGFpbDogdC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNjApfTtgLCAxNV8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdEb2NrOkV2aWRlbmNlIFx1NzcxRlx1NUI5RVx1OEJBNFx1NzdFNVx1NjU3MFx1NjM2RScsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J1x1OEJDMVx1NjM2RSd8fHgudGV4dENvbnRlbnQ9PT0nRXZpZGVuY2UnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2V2aWRlbmNlJywgYHZhciByb3dzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stcm93JykpO1xyXG4gICAgICAgIHZhciBtZW0gPSByb3dzLmZpbmQoZnVuY3Rpb24ocil7IHJldHVybiByLnRleHRDb250ZW50LmluZGV4T2YoJ1x1OEJCMFx1NUZDNlx1NUM0MicpPj0wIHx8IHIudGV4dENvbnRlbnQuaW5kZXhPZignTWVtb3J5IGxheWVycycpPj0wOyB9KTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIW1lbSAmJiBtZW0udGV4dENvbnRlbnQuaW5kZXhPZignXHUyMDI2JykgPCAwLCBkZXRhaWw6IG1lbSA/IG1lbS50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNTApIDogJ25vIHJvdyd9O2AsIDE1XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ1x1OTY0NFx1NEVGNlx1NEUwRVx1NzZFRVx1NUY1NVx1NTE2NVx1NTNFMzpcdUQ4M0RcdURDQ0UgXHU0RTBBXHU0RjIwICsgXHU5ODc2XHU2ODBGXHU0RTJEL0VOICsgXHVEODNEXHVEQ0MxIFx1NkQ0Rlx1ODlDOFx1NjMwOVx1OTRBRVx1NUI1OFx1NTcyOCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J1x1NjU4N1x1NEVGNid8fHgudGV4dENvbnRlbnQ9PT0nRmlsZXMnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgYXdhaXQgd2FpdEZvcignZmlsZXMgdGFiJywgYHZhciB0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5kb2NrLXRhYi5hY3RpdmUnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXQgJiYgKHQudGV4dENvbnRlbnQ9PT0nXHU2NTg3XHU0RUY2J3x8dC50ZXh0Q29udGVudD09PSdGaWxlcycpLCBkZXRhaWw6ICdhY3RpdmU9JysodD90LnRleHRDb250ZW50Oidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgICAgLy8gcmVhbCBcdTZBMjFcdTVGMEYgd29ya3NwYWNlcyBcdThCRjdcdTZDNDJcdThENzAgcnVudGltZShcdTUxQjdcdTU0MkZcdTUyQThcdTU0MEVcdTUzRUZcdTgwRkRcdTYzOTJcdTk2MUYpLFx1NjUzRVx1NUJCRFx1NTIzMCAxNXNcclxuICAgICAgY29uc3Qgd3MgPSBhd2FpdCB3YWl0Rm9yKCd3cyBwaWNrZXInLCBgdmFyIHc9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLXBpY2tlcicpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhdywgZGV0YWlsOiB3ID8gJ2xvYWRlZCcgOiAnd29ya3NwYWNlcyBub3QgbG9hZGVkIHlldCd9O2AsIG1vZGUgPT09ICdyZWFsJyA/IDE1XzAwMCA6IDZfMDAwKTtcclxuICAgICAgY29uc3QgciA9IChhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XHJcbiAgICAgICAgdmFyIHVwID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNvbXBvc2VyIGJ1dHRvblthcmlhLWxhYmVsKj1cIlx1NEUwQVx1NEYyMFwiXSwgLmNvbXBvc2VyIGJ1dHRvblthcmlhLWxhYmVsKj1cIlVwbG9hZFwiXScpO1xyXG4gICAgICAgIHZhciBsYW5nID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmxhbmctc2VnJyk7XHJcbiAgICAgICAgdmFyIGJyID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLXBpY2tlciBidXR0b24nKTtcclxuICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe3VwOiAhIXVwLCBsYW5nOiAhIWxhbmcsIGJyb3dzZTogISFicn0pO1xyXG4gICAgICB9KSgpYCkpIGFzIHN0cmluZztcclxuICAgICAgY29uc3QgcCA9IEpTT04ucGFyc2UocikgYXMgeyB1cDogYm9vbGVhbjsgbGFuZzogYm9vbGVhbjsgYnJvd3NlOiBib29sZWFuIH07XHJcbiAgICAgIHJldHVybiBbcC51cCAmJiBwLmxhbmcgJiYgcC5icm93c2UsIGBcdUQ4M0RcdURDQ0U9JHtwLnVwfSBcdTRFMkQvRU49JHtwLmxhbmd9IFx1RDgzRFx1RENDMT0ke3AuYnJvd3NlfTsgJHt3c1sxXX1gXTtcclxuICAgIH0pO1xyXG4gICAgLyogPT09PT09PT09PSByZWFsOlx1NzcxRlx1NUI5RVx1NEVGQlx1NTJBMVx1N0FFRlx1NTIzMFx1N0FFRlx1OTk5Nlx1OUE4QyhcdTUzRDFcdTc3RURcdTRFRkJcdTUyQTFcdTIxOTJcdTZBMjFcdTU3OEJcdTU2REVcdTU5MEQpID09PT09PT09PT1cclxuICAgICAgIFx1NzUyOFx1NjIzNyBnbG0tNS4zIFx1NURGMlx1OTE0RFx1N0Y2RTtcdTYzRDBcdTc5M0FcdThCQ0RcdTdFQTZcdTY3NUZcdTc2RjRcdTYzQTVcdTU2REVcdTU5MERcdTMwMDJcdTgyRTUgYWdlbnQgXHU4QkY3XHU2QzQyXHU1QkExXHU2Mjc5LFx1OEY2RVx1OEJFMlx1OTFDQ1xyXG4gICAgICAgXHU4MUVBXHU1MkE4XHU3MEI5XHU2Mjc5XHU1MUM2KFx1NjcwMFx1NTkxQVx1ODlDMVx1NTM2MVx1NTM3M1x1NzBCOSxcdTVFNDJcdTdCNDkpXHUzMDAyXHU4RDg1XHU2NUY2IDE1MHNcdTMwMDIgKi9cclxuICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9SRUFMX1RBU0sgPT09ICcxJykge1xyXG4gICAgICBhd2FpdCBzdGVwKCdcdTc3MUZcdTVCOUVcdTRFRkJcdTUyQTE6XHU1M0QxXHU5MDAxXHUyMTkyXHU2QTIxXHU1NzhCXHU1NkRFXHU1OTBEKFx1N0FFRlx1NTIzMFx1N0FFRlx1OTk5Nlx1OUE4QyknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleTonbicsIGN0cmxLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XHJcbiAgICAgICAgYXdhaXQgc2xlZXAoNDAwKTtcclxuICAgICAgICBhd2FpdCB0eXBlSW50bygnLmNvbXBvc2VyIHRleHRhcmVhJywgJ1x1OEJGN1x1NTNFQVx1NTZERVx1NTkwRFx1NEUyNFx1NEUyQVx1NUI1NzpcdTY1MzZcdTUyMzAoXHU2NzJDXHU2QjIxXHU5QThDXHU2NTM2XHU0RUZCXHU1MkExLFx1NEUwRFx1ODk4MVx1NEY3Rlx1NzUyOFx1NEVGQlx1NEY1NVx1NURFNVx1NTE3NyxcdTc2RjRcdTYzQTVcdTU2REVcdTU5MEQpJyk7XHJcbiAgICAgICAgYXdhaXQgc2xlZXAoMjAwKTtcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNvbXBvc2VyIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTUzRDFcdTkwMDEnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICBjb25zdCBzZW50ID0gYXdhaXQgd2FpdEZvcigndXNlciB0dXJuJywgYHZhciB0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy50dXJuLnVzZXInKTtcclxuICAgICAgICAgIHZhciBzID0gKHQgJiYgdC50ZXh0Q29udGVudCkgPyBTdHJpbmcodC50ZXh0Q29udGVudCkgOiAnJztcclxuICAgICAgICAgIHJldHVybiB7b2s6IHMuaW5kZXhPZignXHU2NTM2XHU1MjMwJyk+PTAgfHwgcy5pbmRleE9mKCdcdTlBOENcdTY1MzZcdTRFRkJcdTUyQTEnKT49MCwgZGV0YWlsOiBzLnNsaWNlKDAsMzApIHx8ICdub25lJ307YCwgMTBfMDAwKTtcclxuICAgICAgICBpZiAoIXNlbnRbMF0pIHJldHVybiBzZW50O1xyXG4gICAgICAgIGNvbnN0IHJlcGx5ID0gYXdhaXQgd2FpdEZvcignYXNzaXN0YW50IHJlcGx5JywgYFxyXG4gICAgICAgICAgdmFyIGFwID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmFwcHJvdmFsLWNhcmQgYnV0dG9uJyk7XHJcbiAgICAgICAgICBpZiAoYXAgJiYgYXAudGV4dENvbnRlbnQudHJpbSgpLmluZGV4T2YoJ1x1NjI3OVx1NTFDNicpPj0wKSBhcC5jbGljaygpO1xyXG4gICAgICAgICAgdmFyIHRzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnR1cm4nKSkuZmlsdGVyKGZ1bmN0aW9uKHgpeyByZXR1cm4geC5jbGFzc05hbWUuaW5kZXhPZigndXNlcicpPDAgJiYgeC5jbGFzc05hbWUuaW5kZXhPZignYXBwcm92YWwnKTwwICYmIHguY2xhc3NOYW1lLmluZGV4T2YoJ3N5c3RlbScpPDAgJiYgeC50ZXh0Q29udGVudC50cmltKCkubGVuZ3RoPjAgJiYgeC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTU2REVcdTU0MDgnKTwwOyB9KTtcclxuICAgICAgICAgIHZhciBzdW0gPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudHVybi1zdW0nKTtcclxuICAgICAgICAgIHJldHVybiB7b2s6IHRzLmxlbmd0aD49MSAmJiAhIXN1bSwgZGV0YWlsOiAnYXNzaXN0YW50PScrdHMubGVuZ3RoKycgc3VtPScrKHN1bT9zdW0udGV4dENvbnRlbnQ6J25vbmUnKSsnIGZpcnN0PScrKHRzWzBdP3RzWzBdLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw0MCk6J25vbmUnKX07XHJcbiAgICAgICAgYCwgMTUwXzAwMCk7XHJcbiAgICAgICAgYXdhaXQgc2hvdCgncmVhbC10YXNrJyk7XHJcbiAgICAgICAgcmV0dXJuIHJlcGx5O1xyXG4gICAgICB9KTtcclxuICAgIH1cclxuICAgIGF3YWl0IHN0ZXAoJ1x1NEYxQVx1OEJERFx1NTIwNlx1N0VDNDpcdTVERTZcdTY4MEZcdTYzMDlcdTVERTVcdTRGNUNcdTUzM0FcdTUyMDZcdTdFQzQoXHU3RUM0XHU1OTM0XHU1M0VGXHU4OUMxKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2dyb3VwIGhlYWQnLCBgdmFyIGg9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLWdyb3VwLWhlYWQnKTtcclxuICAgICAgICB2YXIgbiA9IGggPyAoaC5xdWVyeVNlbGVjdG9yKCcud3MtZ3JvdXAtbmFtZScpfHx7fSkudGV4dENvbnRlbnQgOiAnJztcclxuICAgICAgICByZXR1cm4ge29rOiAhIWggJiYgbi5sZW5ndGggPiAwLCBkZXRhaWw6ICduYW1lPScrbn07YCwgMTVfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnXHU1REU1XHU0RjVDXHU1MzNBOlx1NURFNlx1NjgwRlx1NURFNVx1NEY1Q1x1NTMzQVx1NjgwRlx1NTNFRlx1ODlDMShcdTc3MUZcdTVCOUVcdTVERTVcdTRGNUNcdTUzM0FcdTU0MEQpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignd29ya3NwYWNlIGJhcicsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud29ya3NwYWNlLWJhcicpO1xyXG4gICAgICAgIHZhciBuID0gYiA/IChiLnF1ZXJ5U2VsZWN0b3IoJy53cy1iYXItbmFtZScpfHx7fSkudGV4dENvbnRlbnQgOiAnJztcclxuICAgICAgICByZXR1cm4ge29rOiAhIWIgJiYgISFuICYmIG4ubGVuZ3RoID4gMCAmJiBuLmluZGV4T2YoJ1x1NTJBMFx1OEY3RCcpIDwgMCAmJiBuLmluZGV4T2YoJ0xvYWRpbmcnKSA8IDAsIGRldGFpbDogJ25hbWU9JytufTtgLCAxNV8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzaG90KCdmaW5hbCcpO1xyXG4gIH1cclxuXHJcbiAgZmluaXNoKCk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBhdHRhY2hVaVZlcmlmeSh3aW46IEJyb3dzZXJXaW5kb3cpOiB2b2lkIHtcclxuICBjb25zdCBtb2RlID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfTU9ERSA9PT0gJ3JlYWwnID8gJ3JlYWwnIDogJ2Zha2UnO1xyXG4gIHdpbi53ZWJDb250ZW50cy5vbmNlKCdkaWQtZmluaXNoLWxvYWQnLCAoKSA9PiB7XHJcbiAgICAvLyBcdTdFRDkgaG9zdCBcdTU0MkZcdTUyQThcdTc1NTlcdTY1RjZcdTk1RjQ7XHU2QjY1XHU5QUE0XHU1MTg1XHU5MEU4XHU1NDA0XHU4MUVBXHU4RjZFXHU4QkUyXHU3QjQ5XHU1Rjg1XHJcbiAgICBzZXRUaW1lb3V0KCgpID0+IHsgdm9pZCBydW5VaVZlcmlmeSh3aW4sIG1vZGUpOyB9LCAzXzAwMCk7XHJcbiAgfSk7XHJcbn1cclxuIiwgIi8qKlxyXG4gKiBcdTg5QzZcdTg5QzlcdTU2REVcdTVGNTJcdTYyMkFcdTU2RkVcdTk0QTlcdTVCNTAgXHUyMDE0XHUyMDE0IFx1Nzg2RVx1NUI5QVx1NjAyN1x1ODlDNlx1NTNFM1x1NjIyQVx1NTZGRSxcdTRGOUIgc2NyaXB0cy92aXN1YWwtcmVncmVzc2lvbi5tanMgXHU1MDVBXHU1MENGXHU3RDIwIGRpZmZcdTMwMDJcclxuICpcclxuICogXHU0RTBFIHVpLXZlcmlmeSBcdTU0MENcdTY1Q0YoXHU5NkY2XHU3QjJDXHU0RTA5XHU2NUI5XHU0RjlEXHU4RDU2KSxcdTRGNDZcdTc2RUVcdTY4MDdcdTY2MkZcIlx1NTQwQ1x1NEUwMFx1OEY5M1x1NTE2NSBcdTIxOTIgXHU5MDEwXHU1QjU3XHU4MjgyXHU1M0VGXHU2QkQ0XHU3Njg0XHU1NkZFXCI6XHJcbiAqICAtIFx1N0E5N1x1NTNFM1x1NUY1Mlx1NEUwMCAxMjgwXHUwMEQ3ODAwO1x1NEUzQlx1OTg5OC9cdThCRURcdThBMDBcdTU2RkFcdTVCOUEobGlnaHQgKyBcdTVGNTNcdTUyNEQgbG9jYWxlIFx1OUVEOFx1OEJBNCxcdTUxOTkgbG9jYWxTdG9yYWdlIFx1NTQwRSByZWxvYWQpXHJcbiAqICAtIGZha2UgaG9zdChITUhfREVTS1RPUF9WSVNSRUc9MSBcdTY1RjYgbWFpbiBcdTVERjJcdTVGM0FcdTUyMzYgZmFrZSk6XHU3QTdBXHU0RjFBXHU4QkREL1x1NTZGQVx1NUI5QVx1NURFNVx1NEY1Q1x1NTMzQVx1NEUwRSBwcm92aWRlclxyXG4gKiAgLSBcdTRFMDlcdTg5QzZcdTUzRTM6bWFpbihcdTRGMUFcdThCRERcdTRFM0JcdTc1NENcdTk3NjJcdTdBN0FcdTYwMDEpLyBzZXR0aW5ncyhcdThCQkVcdTdGNkVcdTVGMzlcdTVDNDIpLyBkb2NrKEZpbGVzIFx1NkQ0Rlx1ODlDOClcclxuICogIC0gXHU1MkE4XHU2MDAxXHU1MzNBIG1hc2s6XHU1MkE4XHU2MDAxXHU3QUVGXHU1M0UzL1x1NjVGNlx1OTVGNFx1NjIzMy9cdThCQTFcdTY1NzBcdTdCNDlcdTUxNDNcdTdEMjBcdTYzMDkgYm91bmRpbmcgYm94IFx1OEJCMFx1NTE2NSBtZXRhLmpzb24sXHJcbiAqICAgIFx1NTBDRlx1N0QyMCBkaWZmIFx1NjVGNlx1OERGM1x1OEZDNyhcdTU3NTBcdTY4MDdcdTVERjJcdTYzMDkgY2FwdHVyZVBhZ2UgXHU1QjlFXHU5NjQ1XHU1QzNBXHU1QkY4IFx1MDBENyBkZXZpY2VQaXhlbFJhdGlvIFx1NjM2Mlx1N0I5NylcclxuICogIC0gSE1IX0RFU0tUT1BfVklTUkVHX01VVEFURT08dmlld3BvcnQ+Olx1NTcyOFx1OEJFNVx1ODlDNlx1NTNFM1x1NkNFOFx1NTE2NVx1NTZGQVx1NUI5QVx1ODI3Mlx1NTc1NyxcdTc1MjhcdTRFOEVcdTdCQTFcdTdFQkZcdTgxRUFcdTY4QzBcclxuICogICAgKGJhc2VsaW5lIFx1ODFFQVx1NkJENCAwIFx1NURFRVx1NUYwMiArIFx1NjU0NVx1NjEwRlx1NjUzOVx1NTJBOFx1NUZDNSBGQUlMLFx1OEJDMVx1NjYwRVx1OTYwOFx1NTAzQ1x1NEUwRSBkaWZmIFx1NTZGRVx1NzcxRlx1NUI5RVx1NURFNVx1NEY1QylcclxuICogZW52OkhNSF9ERVNLVE9QX1ZJU1JFRz0xKFx1NUYwMFx1NTE3MykvIEhNSF9ERVNLVE9QX1ZJU1JFR19PVVQ9PGRpcj4oXHU4RjkzXHU1MUZBXHU3NkVFXHU1RjU1KVxyXG4gKi9cclxuaW1wb3J0IHsgYXBwLCB0eXBlIEJyb3dzZXJXaW5kb3cgfSBmcm9tICdlbGVjdHJvbic7XHJcbmltcG9ydCB7IG1rZGlyLCB3cml0ZUZpbGUgfSBmcm9tICdub2RlOmZzL3Byb21pc2VzJztcclxuaW1wb3J0IHsgam9pbiB9IGZyb20gJ25vZGU6cGF0aCc7XHJcblxyXG5jb25zdCBzbGVlcCA9IChtczogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiA9PiBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCBtcykpO1xyXG5cclxuLyoqIFx1NTJBOFx1NjAwMVx1NTMzQVx1NTdERihcdTZCQ0ZcdTZCMjFcdThGRDBcdTg4NENcdTVGQzVcdTUzRDhcdTc2ODRcdTUxODVcdTVCQjkpXHUyMTkyIG1hc2sgXHU5MDA5XHU2MkU5XHU1NjY4O1x1OTc1OVx1NjAwMVx1N0VEM1x1Njc4NFx1NEUwRCBtYXNrLGRpZmYgXHU2MjREXHU2NzA5XHU2MTBGXHU0RTQ5ICovXHJcbmNvbnN0IE1BU0tfU0VMRUNUT1JTOiBBcnJheTx7IHNlbDogc3RyaW5nOyByZWFzb246IHN0cmluZyB9PiA9IFtcclxuICB7IHNlbDogJy5ob3N0LWxhYmVsJywgcmVhc29uOiAnaG9zdCBcdTdBRUZcdTUzRTMvXHU3MjQ4XHU2NzJDKGZha2UgaG9zdCBcdTZCQ0ZcdTZCMjFcdTk2OEZcdTY3M0FcdTdBRUZcdTUzRTMpJyB9LFxyXG4gIHsgc2VsOiAnLnNlc3Npb24tdGltZScsIHJlYXNvbjogJ1x1NEYxQVx1OEJERFx1NjVGNlx1OTVGNFx1NjIzMycgfSxcclxuICB7IHNlbDogJy50dXJuLXN1bScsIHJlYXNvbjogJ1x1NTZERVx1NTQwOC90b2tlbiBcdThCQTFcdTY1NzAnIH0sXHJcbl07XHJcblxyXG4vKiogXHU1NkZBXHU1QjlBXHU4OUM2XHU1M0UzOlx1ODk4Nlx1NzZENlx1NEUwOVx1NjgwRlx1NUUwM1x1NUM0MFx1NEUwRVx1NUU5NVx1OTBFOCBkb2NrIFx1NzY4NFx1NTIwNlx1NjUyRixcdTU0MENcdTY1RjZcdThGRENcdTc5QkIgODIwLzExMDAgXHU2NUFEXHU3MEI5ICovXHJcbmNvbnN0IFZJRVdQT1JUX1cgPSAxMjgwO1xyXG5jb25zdCBWSUVXUE9SVF9IID0gODAwO1xyXG5cclxuYXN5bmMgZnVuY3Rpb24gcnVuVmlzdWFsUmVncmVzc2lvbih3aW46IEJyb3dzZXJXaW5kb3cpOiBQcm9taXNlPHZvaWQ+IHtcclxuICBjb25zdCBvdXQgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9WSVNSRUdfT1VUID8/IGpvaW4oYXBwLmdldFBhdGgoJ3RlbXAnKSwgJ2htaC12aXNyZWcnKTtcclxuICBjb25zdCBtdXRhdGUgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9WSVNSRUdfTVVUQVRFID8/ICcnO1xyXG4gIGF3YWl0IG1rZGlyKG91dCwgeyByZWN1cnNpdmU6IHRydWUgfSkuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcclxuICBjb25zdCBqcyA9IDxUPihjb2RlOiBzdHJpbmcpOiBQcm9taXNlPFQ+ID0+IHdpbi53ZWJDb250ZW50cy5leGVjdXRlSmF2YVNjcmlwdChjb2RlLCB0cnVlKSBhcyBQcm9taXNlPFQ+O1xyXG4gIGNvbnN0IHdhaXRGb3IgPSBhc3luYyAobGFiZWw6IHN0cmluZywgcHJlZGljYXRlQ29kZTogc3RyaW5nLCB0aW1lb3V0TXM6IG51bWJlcik6IFByb21pc2U8dm9pZD4gPT4ge1xyXG4gICAgY29uc3Qgc3RhcnRlZCA9IERhdGUubm93KCk7XHJcbiAgICBmb3IgKDs7KSB7XHJcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoYChmdW5jdGlvbigpeyB0cnkgeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkoKGZ1bmN0aW9uKCl7ICR7cHJlZGljYXRlQ29kZX0gfSkoKSk7IH0gY2F0Y2goZSl7IHJldHVybiBKU09OLnN0cmluZ2lmeSh7b2s6ZmFsc2UsIGRldGFpbDpTdHJpbmcoZSkuc2xpY2UoMCwxMjApfSk7IH0gfSkoKWApKSBhcyBzdHJpbmc7XHJcbiAgICAgIGxldCBwYXJzZWQ6IHsgb2s/OiBib29sZWFuIH07XHJcbiAgICAgIHRyeSB7IHBhcnNlZCA9IEpTT04ucGFyc2UocikgYXMgeyBvaz86IGJvb2xlYW4gfTsgfSBjYXRjaCB7IHBhcnNlZCA9IHt9OyB9XHJcbiAgICAgIGlmIChwYXJzZWQub2sgPT09IHRydWUpIHJldHVybjtcclxuICAgICAgaWYgKERhdGUubm93KCkgLSBzdGFydGVkID4gdGltZW91dE1zKSB7XHJcbiAgICAgICAgY29uc29sZS5sb2coYFZJU1JFRy1DQVBUVVJFIEZBSUwgfCB3YWl0ICR7bGFiZWx9IHRpbWVvdXRgKTtcclxuICAgICAgICBhcHAuZXhpdCgxKTtcclxuICAgICAgICByZXR1cm47XHJcbiAgICAgIH1cclxuICAgICAgYXdhaXQgc2xlZXAoMjUwKTtcclxuICAgIH1cclxuICB9O1xyXG5cclxuICAvLyAwKSBcdTdBOTdcdTUzRTNcdTVGNTJcdTRFMDA6XHU1QzNBXHU1QkY4XHU1NkZBXHU1QjlBKFx1NEY0RFx1N0Y2RVx1NEZERFx1NjMwMVx1NzUyOFx1NjIzN1x1Njg0Q1x1OTc2Mlx1NEUwQVx1NzY4NCk7XHU0RTNCXHU5ODk4XHU2RDQ1XHU4MjcyICsgXHU0RTJEXHU2NTg3LFx1NTE5OVx1NTA0Rlx1NTk3RFx1NTQwRSByZWxvYWQgXHU3NTFGXHU2NTQ4XHJcbiAgdHJ5IHsgd2luLnNldEJvdW5kcyh7IHdpZHRoOiBWSUVXUE9SVF9XLCBoZWlnaHQ6IFZJRVdQT1JUX0ggfSk7IH0gY2F0Y2ggeyAvKiBcdTY3MDBcdTVDMEZcdTVDM0FcdTVCRjhcdTUxNUNcdTVFOTUgKi8gfVxyXG4gIGF3YWl0IHNsZWVwKDQwMCk7XHJcbiAgYXdhaXQganMoYChmdW5jdGlvbigpeyB0cnkgeyBsb2NhbFN0b3JhZ2Uuc2V0SXRlbSgnaG1oLnRoZW1lJywgJ2xpZ2h0Jyk7IGxvY2FsU3RvcmFnZS5zZXRJdGVtKCdobWgubG9jYWxlJywgJ3poJyk7IH0gY2F0Y2ggKGUpIHt9IHJldHVybiAnb2snOyB9KSgpYCk7XHJcbiAgd2luLndlYkNvbnRlbnRzLnJlbG9hZCgpO1xyXG4gIGF3YWl0IHdhaXRGb3IoJ21vdW50ZWQnLCBgdmFyIHQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNvbXBvc2VyIHRleHRhcmVhJyk7IHJldHVybiB7b2s6ICEhdCwgZGV0YWlsOiB0ID8gJ3VwJyA6ICdkb3duJ307YCwgMjBfMDAwKTtcclxuICBhd2FpdCB3YWl0Rm9yKCdob3N0IGRvdCBvbicsIGB2YXIgZD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuaG9zdC1kb3QnKTsgcmV0dXJuIHtvazogISFkICYmIGQuY2xhc3NMaXN0LmNvbnRhaW5zKCdvbicpLCBkZXRhaWw6IGQgPyBkLmNsYXNzTmFtZSA6ICdub25lJ307YCwgMzBfMDAwKTtcclxuICBhd2FpdCBzbGVlcCgxXzIwMCk7IC8vIFx1NEYxQVx1OEJERFx1NTIxN1x1ODg2OC9cdTk4NzZcdTY4MEZcdTY1NzBcdTYzNkVcdTg0M0RcdTU3MzBcclxuXHJcbiAgLy8gMSkgXHU1MTczXHU2Mzg5IGZha2UgXHU2RjE0XHU3OTNBXHU1RjE1XHU1QkZDXHU1QzQyKFx1OTA2RVx1N0Y2OVx1NUYzOVx1NUM0Mlx1NEUwRFx1NUM1RVx1NEU4RVx1ODhBQlx1NkQ0Qlx1ODlDNlx1NTNFMztcdTRFMERcdTRGOURcdThENTZcdTY1ODdcdTY4NDgsXHU2MzA5XHU3RUQzXHU2Nzg0XHU1M0Q2IGdob3N0IFx1NjMwOVx1OTRBRSlcclxuICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBnPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ydW50aW1lLWd1aWRlJyk7IGlmKCFnKSByZXR1cm4gJ25vLWd1aWRlJztcclxuICAgIHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ydW50aW1lLWd1aWRlLWFjdGlvbnMgLmJ0bi5naG9zdCcpOyBpZihiKSBiLmNsaWNrKCk7IHJldHVybiAnZGlzbWlzc2VkJzsgfSkoKWApO1xyXG4gIGF3YWl0IHdhaXRGb3IoJ2d1aWRlIGNsb3NlZCcsIGByZXR1cm4ge29rOiAhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnJ1bnRpbWUtZ3VpZGUnKSwgZGV0YWlsOiAnY2xvc2VkJ307YCwgNV8wMDApO1xyXG5cclxuICAvLyAyKSBcdTg5QzZcdTUzRTNcdTVFOEZcdTUyMTc6bWFpbihcdTdBN0FcdTYwMDFcdTRFM0JcdTc1NENcdTk3NjIpXHUyMTkyIHNldHRpbmdzKFx1OEJCRVx1N0Y2RVx1NUYzOVx1NUM0MilcdTIxOTIgZG9jayhGaWxlcyBcdTZENEZcdTg5QzgpXHJcbiAgY29uc3Qgdmlld3BvcnRzOiBBcnJheTx7IG5hbWU6IHN0cmluZzsgc2V0dXA6ICgpID0+IFByb21pc2U8dm9pZD4gfT4gPSBbXHJcbiAgICB7IG5hbWU6ICdtYWluJywgc2V0dXA6IGFzeW5jICgpID0+IHsgLyogXHU1NDJGXHU1MkE4XHU5RUQ4XHU4QkE0XHU2MDAxOlx1N0E3QVx1NEYxQVx1OEJERCArIE92ZXJ2aWV3IGRvY2sgKi8gfSB9LFxyXG4gICAge1xyXG4gICAgICBuYW1lOiAnc2V0dGluZ3MnLFxyXG4gICAgICBzZXR1cDogYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7IGtleTogJ3AnLCBjdHJsS2V5OiB0cnVlLCBzaGlmdEtleTogdHJ1ZSwgYnViYmxlczogdHJ1ZSB9KSk7IH0pKClgKTtcclxuICAgICAgICBhd2FpdCB3YWl0Rm9yKCdzZXR0aW5ncyBvcGVuJywgYHJldHVybiB7b2s6ICEhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNtZGsuc2V0dGluZ3MnKSwgZGV0YWlsOiAnb3Blbid9O2AsIDVfMDAwKTtcclxuICAgICAgfSxcclxuICAgIH0sXHJcbiAgICB7XHJcbiAgICAgIG5hbWU6ICdkb2NrJyxcclxuICAgICAgc2V0dXA6IGFzeW5jICgpID0+IHtcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywgeyBrZXk6ICdFc2NhcGUnLCBidWJibGVzOiB0cnVlIH0pKTsgfSkoKWApO1xyXG4gICAgICAgIGF3YWl0IHdhaXRGb3IoJ3NldHRpbmdzIGNsb3NlZCcsIGByZXR1cm4ge29rOiAhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNtZGsuc2V0dGluZ3MnKSwgZGV0YWlsOiAnY2xvc2VkJ307YCwgNV8wMDApO1xyXG4gICAgICAgIC8vIEZpbGVzIHRhYjpcdTYzMDkgZG9jay10YWIgXHU5ODdBXHU1RThGXHU3QjJDIDIgXHU0RTJBKE92ZXJ2aWV3L0ZpbGVzL1x1MjAyNiksXHU5MDdGXHU1MTREXHU0RjlEXHU4RDU2XHU2NTg3XHU2ODQ4XHJcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKVsxXTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgYXdhaXQgd2FpdEZvcignZmlsZXMgcm93cycsIGB2YXIgcj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZnMtcm93Jyk7IHJldHVybiB7b2s6IHIubGVuZ3RoID49IDEsIGRldGFpbDogJ3Jvd3M9JyArIHIubGVuZ3RofTtgLCA1XzAwMCk7XHJcbiAgICAgIH0sXHJcbiAgICB9LFxyXG4gIF07XHJcblxyXG4gIGNvbnN0IG1ldGE6IHsgZ2VuZXJhdGVkQXQ6IHN0cmluZzsgd2luZG93OiB7IHdpZHRoOiBudW1iZXI7IGhlaWdodDogbnVtYmVyIH07IG11dGF0ZTogc3RyaW5nOyB2aWV3cG9ydHM6IEFycmF5PHsgbmFtZTogc3RyaW5nOyBmaWxlOiBzdHJpbmc7IHdpZHRoOiBudW1iZXI7IGhlaWdodDogbnVtYmVyOyBkcHI6IG51bWJlcjsgbWFza3M6IEFycmF5PHsgeDogbnVtYmVyOyB5OiBudW1iZXI7IHc6IG51bWJlcjsgaDogbnVtYmVyOyBmb3I6IHN0cmluZyB9PiB9PiB9ID0ge1xyXG4gICAgZ2VuZXJhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcclxuICAgIHdpbmRvdzogeyB3aWR0aDogVklFV1BPUlRfVywgaGVpZ2h0OiBWSUVXUE9SVF9IIH0sXHJcbiAgICBtdXRhdGUsXHJcbiAgICB2aWV3cG9ydHM6IFtdLFxyXG4gIH07XHJcbiAgZm9yIChjb25zdCB2IG9mIHZpZXdwb3J0cykge1xyXG4gICAgYXdhaXQgdi5zZXR1cCgpO1xyXG4gICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYT1kb2N1bWVudC5hY3RpdmVFbGVtZW50OyBpZihhICYmIGEuYmx1cikgYS5ibHVyKCk7IH0pKClgKTsgLy8gXHU1M0JCXHU3MTI2XHU3MEI5XHU3M0FGXHJcbiAgICBhd2FpdCBzbGVlcCg2MDApOyAvLyBcdThGQzdcdTZFMjFcdTRFMEVcdTZFMzJcdTY3RDNcdTdBMzNcdTVCOUFcclxuICAgIGlmIChtdXRhdGUgPT09IHYubmFtZSkge1xyXG4gICAgICAvLyBcdTdCQTFcdTdFQkZcdTgxRUFcdTY4QzA6XHU2Q0U4XHU1MTY1IDEyMFx1MDBENzkwIFx1NTZGQVx1NUI5QVx1N0VBMlx1NTc1NyhcdTdFQTYgMSUgXHU5NzYyXHU3OUVGLD4gMC41JSBcdTk2MDhcdTUwM0MsXHU1RTk0XHU1MjI0IEZBSUwpXHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGQ9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7IGQuc2V0QXR0cmlidXRlKCdkYXRhLXZpc3JlZy1tdXRhdGUnLCcxJyk7XHJcbiAgICAgICAgZC5zdHlsZS5jc3NUZXh0PSdwb3NpdGlvbjpmaXhlZDtsZWZ0OjU2MHB4O3RvcDozMDBweDt3aWR0aDoxMjBweDtoZWlnaHQ6OTBweDtiYWNrZ3JvdW5kOnJnYigyNTUsMCwwKTt6LWluZGV4Ojk5OTk7JztcclxuICAgICAgICBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKGQpOyB9KSgpYCk7XHJcbiAgICAgIGF3YWl0IHNsZWVwKDE1MCk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBpbWcgPSBhd2FpdCB3aW4ud2ViQ29udGVudHMuY2FwdHVyZVBhZ2UoKTtcclxuICAgIGNvbnN0IHNpemUgPSBpbWcuZ2V0U2l6ZSgpO1xyXG4gICAgLy8gXHU3QkExXHU3RUJGXHU4MUVBXHU2OEMwXHU3RUEyXHU1NzU3XHU1M0VBXHU1QzVFXHU0RThFXHU3NkVFXHU2ODA3XHU4OUM2XHU1M0UzOlx1NjIyQVx1NTZGRVx1NTQwRVx1N0FDQlx1NTM3M1x1NzlGQlx1OTY2NCxcdTRFMERcdTZDNjFcdTY3RDNcdTU0MEVcdTdFRURcdTg5QzZcdTUzRTNcclxuICAgIGlmIChtdXRhdGUgPT09IHYubmFtZSkge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBkPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLXZpc3JlZy1tdXRhdGVdJyk7IGlmKGQpIGQucmVtb3ZlKCk7IH0pKClgKTtcclxuICAgIH1cclxuICAgIGNvbnN0IGlubmVyVyA9IChhd2FpdCBqczxudW1iZXI+KCd3aW5kb3cuaW5uZXJXaWR0aCcpKSB8fCBzaXplLndpZHRoO1xyXG4gICAgY29uc3QgZHByID0gc2l6ZS53aWR0aCAvIGlubmVyVztcclxuICAgIGNvbnN0IG1hc2tzOiBBcnJheTx7IHg6IG51bWJlcjsgeTogbnVtYmVyOyB3OiBudW1iZXI7IGg6IG51bWJlcjsgZm9yOiBzdHJpbmcgfT4gPSBbXTtcclxuICAgIGZvciAoY29uc3QgbSBvZiBNQVNLX1NFTEVDVE9SUykge1xyXG4gICAgICBjb25zdCByZWN0cyA9IChhd2FpdCBqczxzdHJpbmc+KGAoZnVuY3Rpb24oKXsgcmV0dXJuIEpTT04uc3RyaW5naWZ5KFtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnJHttLnNlbH0nKSkubWFwKGZ1bmN0aW9uKGVsKXtcclxuICAgICAgICB2YXIgcj1lbC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTsgcmV0dXJuIHsgeDpyLngsIHk6ci55LCB3OnIud2lkdGgsIGg6ci5oZWlnaHQgfTtcclxuICAgICAgfSkuZmlsdGVyKGZ1bmN0aW9uKHIpeyByZXR1cm4gci53ID4gMCAmJiByLmggPiAwICYmIHIueSA+PSAwICYmIHIueSA8IHdpbmRvdy5pbm5lckhlaWdodDsgfSkpIH0pKClgKSk7XHJcbiAgICAgIGxldCBsaXN0OiBBcnJheTx7IHg6IG51bWJlcjsgeTogbnVtYmVyOyB3OiBudW1iZXI7IGg6IG51bWJlciB9PiA9IFtdO1xyXG4gICAgICB0cnkgeyBsaXN0ID0gSlNPTi5wYXJzZShyZWN0cykgYXMgdHlwZW9mIGxpc3Q7IH0gY2F0Y2ggeyAvKiBcdTdBN0EgKi8gfVxyXG4gICAgICBmb3IgKGNvbnN0IHIgb2YgbGlzdCkge1xyXG4gICAgICAgIG1hc2tzLnB1c2goeyB4OiBNYXRoLnJvdW5kKHIueCAqIGRwciksIHk6IE1hdGgucm91bmQoci55ICogZHByKSwgdzogTWF0aC5yb3VuZChyLncgKiBkcHIpLCBoOiBNYXRoLnJvdW5kKHIuaCAqIGRwciksIGZvcjogbS5yZWFzb24gfSk7XHJcbiAgICAgIH1cclxuICAgIH1cclxuICAgIGNvbnN0IGZpbGUgPSBgJHt2Lm5hbWV9LnBuZ2A7XHJcbiAgICBhd2FpdCB3cml0ZUZpbGUoam9pbihvdXQsIGZpbGUpLCBpbWcudG9QTkcoKSk7XHJcbiAgICBtZXRhLnZpZXdwb3J0cy5wdXNoKHsgbmFtZTogdi5uYW1lLCBmaWxlLCB3aWR0aDogc2l6ZS53aWR0aCwgaGVpZ2h0OiBzaXplLmhlaWdodCwgZHByOiBNYXRoLnJvdW5kKGRwciAqIDEwMCkgLyAxMDAsIG1hc2tzIH0pO1xyXG4gICAgY29uc29sZS5sb2coYFZJU1JFRy1DQVBUVVJFICR7di5uYW1lfSAke3NpemUud2lkdGh9eCR7c2l6ZS5oZWlnaHR9IG1hc2tzPSR7bWFza3MubGVuZ3RofSR7bXV0YXRlID09PSB2Lm5hbWUgPyAnIE1VVEFURUQnIDogJyd9YCk7XHJcbiAgfVxyXG4gIGF3YWl0IHdyaXRlRmlsZShqb2luKG91dCwgJ21ldGEuanNvbicpLCBKU09OLnN0cmluZ2lmeShtZXRhLCBudWxsLCAyKSk7XHJcbiAgY29uc29sZS5sb2coJ1ZJU1JFRy1DQVBUVVJFIERPTkUnKTtcclxuICBhcHAuZXhpdCgwKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGF0dGFjaFZpc3VhbFJlZ3Jlc3Npb24od2luOiBCcm93c2VyV2luZG93KTogdm9pZCB7XHJcbiAgd2luLndlYkNvbnRlbnRzLm9uY2UoJ2RpZC1maW5pc2gtbG9hZCcsICgpID0+IHtcclxuICAgIHNldFRpbWVvdXQoKCkgPT4geyB2b2lkIHJ1blZpc3VhbFJlZ3Jlc3Npb24od2luKTsgfSwgMV81MDApO1xyXG4gIH0pO1xyXG59XHJcbiIsICIvKipcbiAqIHY1LjEgXHU1Qjg5XHU4OEM1XHU1NDExXHU1QkZDIFx1MDBCNyBAaG1oYXJuZXNzL2NsaSBcdTVCODlcdTg4QzVcdTdGMTZcdTYzOTIoXHU0RTNCXHU4RkRCXHU3QTBCKVx1MzAwMlxuICpcbiAqIFx1NEUyNFx1Njc2MVx1OERFRlx1NUY4NChcdTYzRDBcdTc5M0FcdThCQ0QgdjUuMSBcdTU0MDhcdTU0MEMpOlxuICogIC0gbnBtIFx1NTNFRlx1NzUyOChcdTlFRDhcdThCQTQpOmBucG0gaW5zdGFsbCAtLXByZWZpeCAlVVNFUlBST0ZJTEUlXFwuaG1oYXJuZXNzLWdsb2JhbFxuICogICAgQGhtaGFybmVzcy9jbGlgIFx1MjAxNFx1MjAxNCBcdTUzRUFcdTUxOTlcdTc1MjhcdTYyMzdcdTc2RUVcdTVGNTUsXHU0RTBEXHU3OEIwXHU3Q0ZCXHU3RURGL25wbSBcdTUxNjhcdTVDNDA7bnBtIFx1ODFFQVx1NUUyNlx1NEY5RFx1OEQ1Nlx1ODlFM1x1Njc5MCxcbiAqICAgIFx1OEZEQlx1NUVBNlx1OEY2Q1x1NTNEMVx1NTE3Nlx1OEY5M1x1NTFGQVx1ODg0QyhcdTVCODlcdTg4QzVcdTZCNjVcdTlBQTRcdTY1ODdcdTY4NDgpXHUzMDAyXG4gKiAgLSBcdTY1RTAgbnBtKFx1NjIxNlx1NjYzRVx1NUYwRlx1NUYzQVx1NTIzNik6XHU4MUVBXHU3ODE0IHRneiBcdTVCODlcdTg4QzVcdTU2NjggXHUyMDE0XHUyMDE0IFx1NEY5RFx1OEQ1Nlx1OTVFRFx1NTMwNVx1Njc2NVx1ODFFQVxuICogICAgQGhtaC1kZXNrdG9wL2NsaS1pbnN0YWxsZXIoXHU3RUFGXHU5MDNCXHU4RjkxLFx1NURGMlx1NTM1NVx1NkQ0QiksdGFyYmFsbCBcdTkwMTBcdTUzMDVcdTZENDFcdTVGMEZcdTRFMEJcdThGN0RcbiAqICAgIChcdTc3MUZcdTVCNTdcdTgyODJcdThGREJcdTVFQTYgKyByZWdpc3RyeS5ucG1qcy5vcmdcdTIxOTJyZWdpc3RyeS5ucG1taXJyb3IuY29tIFx1OTU1Q1x1NTBDRlx1NTZERVx1OTAwMCxcbiAqICAgIFx1NTkwRFx1NzUyOCB2NCBcdTY2RjRcdTY1QjBcdTU2NjhcdTU2REVcdTkwMDBcdTYwMURcdTYwRjMgKyBpbnRlZ3JpdHkgXHU2ODIxXHU5QThDKSxcdTdDRkJcdTdFREYgdGFyLmV4ZSBcdTg5RTNcdTUzOEJcdTUyMzBcbiAqICAgIG5vZGVfbW9kdWxlcyBcdTYyNDFcdTVFNzNcdTVFMDNcdTVDNDBcdTMwMDJcbiAqIFx1OEZEQlx1NUVBNlx1NEUwMFx1NUY4Qlx1N0VDRiBpbnN0YWxsOnByb2dyZXNzIFx1NEU4Qlx1NEVGNlx1NjNBOCByZW5kZXJlcjtcdTYyMTBcdTUyOUZcdTU2REVcdThDMDMgb25JbnN0YWxsZWQoZW50cnkpXG4gKiBcdTc1MzEgbWFpbiBcdTYzMDFcdTRFNDVcdTUzMTYgcnVudGltZS5qc29uIFx1NUU3Nlx1NzBFRFx1OTFDRFx1NTQyRiBob3N0XHUzMDAyXG4gKi9cbmltcG9ydCB7IHNwYXduIH0gZnJvbSAnbm9kZTpjaGlsZF9wcm9jZXNzJztcbmltcG9ydCB7IGV4aXN0c1N5bmMsIG1rZGlyU3luYywgcm1TeW5jLCByZW5hbWVTeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSAnbm9kZTpmcyc7XG5pbXBvcnQgeyBob21lZGlyIH0gZnJvbSAnbm9kZTpvcyc7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSAnbm9kZTpwYXRoJztcbmltcG9ydCB7IGJ5dGVzTGFiZWwsIGludGVncml0eU9rLCBtb2R1bGVEaXIsIHJlc29sdmVDbG9zdXJlLCB0YXJiYWxsTWlycm9ycywgdHlwZSBQYWNrdW1lbnQsIHR5cGUgUmVzb2x2ZWRQa2cgfSBmcm9tICdAaG1oLWRlc2t0b3AvY2xpLWluc3RhbGxlcic7XG5cbmV4cG9ydCBpbnRlcmZhY2UgSW5zdGFsbFByb2dyZXNzIHtcbiAgcGhhc2U6ICdjaGVjaycgfCAnbWV0YScgfCAnZG93bmxvYWQnIHwgJ2V4dHJhY3QnIHwgJ25wbScgfCAnZG9uZScgfCAnZXJyb3InO1xuICBwY3Q/OiBudW1iZXI7XG4gIHRleHQ6IHN0cmluZztcbiAgbWlycm9yPzogc3RyaW5nO1xuICBlbnRyeT86IHN0cmluZztcbiAgZXJyb3I/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgSW5zdGFsbE9wdGlvbnMge1xuICAvKiogXHU1RjNBXHU1MjM2XHU4RDcwXHU4MUVBXHU3ODE0IHRneiBcdThERUZcdTVGODQoXHU2RDRCXHU4QkQ1L1x1NjVFMCBucG0gXHU3M0FGXHU1ODgzKVx1MzAwMiAqL1xuICBmb3JjZVRnej86IGJvb2xlYW4gfCB1bmRlZmluZWQ7XG4gIC8qKiBcdTk1NUNcdTUwQ0ZcdTRGMThcdTUxNDhcdTdFQTcoXHU2MzYyXHU2RTkwXHU2MzA5XHU5NEFFXHU3RkZCXHU4RjZDKVx1MzAwMiAqL1xuICBtaXJyb3JGaXJzdD86ICducG1qcycgfCAnbnBtbWlycm9yJyB8IHVuZGVmaW5lZDtcbn1cblxuZXhwb3J0IGNvbnN0IFJFR0lTVFJJRVM6IFJlY29yZDwnbnBtanMnIHwgJ25wbW1pcnJvcicsIHN0cmluZz4gPSB7XG4gIG5wbWpzOiAnaHR0cHM6Ly9yZWdpc3RyeS5ucG1qcy5vcmcnLFxuICBucG1taXJyb3I6ICdodHRwczovL3JlZ2lzdHJ5Lm5wbW1pcnJvci5jb20nLFxufTtcblxuLyoqIFx1NUI4OVx1ODhDNVx1NjgzOVx1NzZFRVx1NUY1NShcdTc1MjhcdTYyMzdcdTc2RUVcdTVGNTUsXHU3RUREXHU0RTBEXHU1MTk5XHU3Q0ZCXHU3RURGL1x1NTE2OFx1NUM0MCBucG0pXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gaW5zdGFsbFRhcmdldCgpOiBzdHJpbmcge1xuICByZXR1cm4gam9pbihob21lZGlyKCksICcuaG1oYXJuZXNzLWdsb2JhbCcpO1xufVxuXG4vKiogXHU1Qjg5XHU4OEM1XHU1QjhDXHU2MjEwXHU1NDBFXHU3Njg0IGRlc2t0b3AtaG9zdCBcdTUxNjVcdTUzRTMobnBtIFx1NUQ0Q1x1NTk1N1x1NEUwRVx1NjNEMFx1NTM0N1x1NEUyNFx1NzlDRFx1NUUwM1x1NUM0MFx1OTBGRFx1OEJBNClcdTMwMDIgKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlSW5zdGFsbGVkRW50cnkodGFyZ2V0OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBuZXN0ZWQgPSBqb2luKHRhcmdldCwgJ25vZGVfbW9kdWxlcycsICdAaG1oYXJuZXNzJywgJ2NsaScsICdub2RlX21vZHVsZXMnLCAnQGhtaGFybmVzcycsICd3ZWInLCAnZGlzdCcsICdkZXNrdG9wLWhvc3QuanMnKTtcbiAgY29uc3QgaG9pc3RlZCA9IGpvaW4odGFyZ2V0LCAnbm9kZV9tb2R1bGVzJywgJ0BobWhhcm5lc3MnLCAnd2ViJywgJ2Rpc3QnLCAnZGVza3RvcC1ob3N0LmpzJyk7XG4gIGlmIChleGlzdHNTeW5jKG5lc3RlZCkpIHJldHVybiBuZXN0ZWQ7XG4gIGlmIChleGlzdHNTeW5jKGhvaXN0ZWQpKSByZXR1cm4gaG9pc3RlZDtcbiAgcmV0dXJuICcnO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEluc3RhbGxlckhvc3Qge1xuICBzZW5kUHJvZ3Jlc3MocDogSW5zdGFsbFByb2dyZXNzKTogdm9pZDtcbiAgbG9nKG1zZzogc3RyaW5nKTogdm9pZDtcbiAgLyoqIFx1NUI4OVx1ODhDNVx1NjIxMFx1NTI5RihcdTUxNjVcdTUzRTNcdTVERjJcdTlBOENcdThCQzFcdTVCNThcdTU3MjgpXHUyMDE0XHUyMDE0IG1haW4gXHU1NzI4XHU2QjY0XHU2MzAxXHU0RTQ1XHU1MzE2XHU1RTc2XHU5MUNEXHU1NDJGIGhvc3RcdTMwMDIgKi9cbiAgb25JbnN0YWxsZWQoZW50cnk6IHN0cmluZywgdmlhOiAnbnBtJyB8ICd0Z3onKTogdm9pZDtcbn1cblxubGV0IHJ1bm5pbmcgPSBmYWxzZTtcblxuZXhwb3J0IGZ1bmN0aW9uIGluc3RhbGxSdW5uaW5nKCk6IGJvb2xlYW4ge1xuICByZXR1cm4gcnVubmluZztcbn1cblxuLyoqIFx1NTQyRlx1NTJBOFx1NUI4OVx1ODhDNShcdTU0MEVcdTUzRjBcdTYyNjdcdTg4NEM7XHU4RkRCXHU1RUE2L1x1N0VEM1x1Njc5Q1x1NTE2OFx1OTBFOFx1N0VDRlx1NEU4Qlx1NEVGNlx1NTZERVx1NkQ0MSxQcm9taXNlIFx1NTNFQVx1ODg2OFx1OEZCRVwiXHU1REYyXHU1M0Q3XHU3NDA2XCIpXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gc3RhcnRDbGlJbnN0YWxsKGhvc3Q6IEluc3RhbGxlckhvc3QsIG9wdHM6IEluc3RhbGxPcHRpb25zID0ge30pOiB7IG9rOiBib29sZWFuOyBlcnJvcj86IHN0cmluZyB9IHtcbiAgaWYgKHJ1bm5pbmcpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICdcdTVCODlcdTg4QzVcdTVERjJcdTU3MjhcdThGREJcdTg4NENcdTRFMkQnIH07XG4gIHJ1bm5pbmcgPSB0cnVlO1xuICBjb25zdCBmaW5pc2ggPSAocDogSW5zdGFsbFByb2dyZXNzKTogdm9pZCA9PiB7XG4gICAgaG9zdC5zZW5kUHJvZ3Jlc3MocCk7XG4gICAgcnVubmluZyA9IGZhbHNlO1xuICB9O1xuICBjb25zdCBmYWlsID0gKHRleHQ6IHN0cmluZywgZXJyOiB1bmtub3duKTogdm9pZCA9PiB7XG4gICAgaG9zdC5sb2coYGluc3RhbGwgZmFpbGVkOiAke3RleHR9ICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTgwKX1gKTtcbiAgICBmaW5pc2goeyBwaGFzZTogJ2Vycm9yJywgdGV4dCwgZXJyb3I6IGAke3RleHR9OiR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTYwKX1gIH0pO1xuICB9O1xuICB2b2lkIChhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgdGFyZ2V0ID0gaW5zdGFsbFRhcmdldCgpO1xuICAgIHRyeSB7XG4gICAgICBta2RpclN5bmModGFyZ2V0LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIGNvbnN0IG5wbU9rID0gb3B0cy5mb3JjZVRneiA9PT0gdHJ1ZSA/IGZhbHNlIDogYXdhaXQgcHJvYmVOcG0oaG9zdCk7XG4gICAgICBpZiAobnBtT2spIGF3YWl0IGluc3RhbGxWaWFOcG0oaG9zdCwgdGFyZ2V0LCBvcHRzKTtcbiAgICAgIGVsc2UgYXdhaXQgaW5zdGFsbFZpYVRhcmJhbGxzKGhvc3QsIHRhcmdldCwgb3B0cyk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBmYWlsKCdcdTVCODlcdTg4QzVcdTU5MzFcdThEMjUnLCBlcnIpO1xuICAgIH1cbiAgfSkoKTtcbiAgcmV0dXJuIHsgb2s6IHRydWUgfTtcbn1cblxuLyogLS0tLSBucG0gXHU1M0VGXHU3NTI4XHU2MDI3KFx1NkNFOFx1NjEwRjpXaW5kb3dzIFx1NEUwQiBzcGF3bignbnBtJykgXHU1M0VGXHU4ODRDLCducG0uY21kJyBcdTUzQ0RcdTgwMEMgRUlOVkFMKSAtLS0tICovXG5hc3luYyBmdW5jdGlvbiBwcm9iZU5wbShob3N0OiBJbnN0YWxsZXJIb3N0KTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGhvc3Quc2VuZFByb2dyZXNzKHsgcGhhc2U6ICdjaGVjaycsIHRleHQ6ICdcdTY4QzBcdTY3RTUgbnBtXHUyMDI2JyB9KTtcbiAgY29uc3Qgb2sgPSBhd2FpdCBuZXcgUHJvbWlzZTxib29sZWFuPigocmVzb2x2ZSkgPT4ge1xuICAgIGNvbnN0IGMgPSBzcGF3bignbnBtJywgWyctLXZlcnNpb24nXSwgeyB3aW5kb3dzSGlkZTogdHJ1ZSwgc3RkaW86ICdpZ25vcmUnIH0pO1xuICAgIGNvbnN0IHQgPSBzZXRUaW1lb3V0KCgpID0+IHsgdHJ5IHsgYy5raWxsKCk7IH0gY2F0Y2ggeyAvKiBub29wICovIH0gcmVzb2x2ZShmYWxzZSk7IH0sIDE1XzAwMCk7XG4gICAgYy5vbignZXJyb3InLCAoKSA9PiB7IGNsZWFyVGltZW91dCh0KTsgcmVzb2x2ZShmYWxzZSk7IH0pO1xuICAgIGMub24oJ2V4aXQnLCAoY29kZSkgPT4geyBjbGVhclRpbWVvdXQodCk7IHJlc29sdmUoY29kZSA9PT0gMCk7IH0pO1xuICB9KTtcbiAgaG9zdC5sb2coYG5wbSAke29rID8gJ2F2YWlsYWJsZScgOiAndW5hdmFpbGFibGUnfSBcdTIxOTIgJHtvayA/ICducG0gcHJlZml4JyA6ICd0Z3onfSBwYXRoYCk7XG4gIHJldHVybiBvaztcbn1cblxuLyogLS0tLSBcdThERUZcdTVGODQgQTpucG0gLS1wcmVmaXgoXHU1Qjg5XHU4OEM1XHU2QjY1XHU5QUE0XHU2NTg3XHU2ODQ4ID0gbnBtIFx1OEY5M1x1NTFGQVx1ODg0QykgLS0tLSAqL1xuYXN5bmMgZnVuY3Rpb24gaW5zdGFsbFZpYU5wbShob3N0OiBJbnN0YWxsZXJIb3N0LCB0YXJnZXQ6IHN0cmluZywgb3B0czogSW5zdGFsbE9wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgaG9zdC5zZW5kUHJvZ3Jlc3MoeyBwaGFzZTogJ25wbScsIHRleHQ6IGBucG0gaW5zdGFsbCBAaG1oYXJuZXNzL2NsaSBcdTIxOTIgJHt0YXJnZXR9KFx1NEVDNVx1NzUyOFx1NjIzN1x1NzZFRVx1NUY1NSlgIH0pO1xuICBjb25zdCByZWdpc3RyeSA9IG9wdHMubWlycm9yRmlyc3QgPT09ICducG1taXJyb3InID8gWyctLXJlZ2lzdHJ5JywgUkVHSVNUUklFUy5ucG1taXJyb3JdIDogb3B0cy5taXJyb3JGaXJzdCA9PT0gJ25wbWpzJyA/IFsnLS1yZWdpc3RyeScsIFJFR0lTVFJJRVMubnBtanNdIDogW107XG4gIGNvbnN0IGFyZ3MgPSBbJ2luc3RhbGwnLCAnLS1wcmVmaXgnLCB0YXJnZXQsICctLW5vLWF1ZGl0JywgJy0tbm8tZnVuZCcsICctLWxvZ2xldmVsJywgJ25vdGljZScsIC4uLnJlZ2lzdHJ5LCAnQGhtaGFybmVzcy9jbGlAbGF0ZXN0J107XG4gIGNvbnN0IGNvZGUgPSBhd2FpdCBuZXcgUHJvbWlzZTxudW1iZXI+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICBjb25zdCBjID0gc3Bhd24oJ25wbScsIGFyZ3MsIHsgd2luZG93c0hpZGU6IHRydWUsIGN3ZDogaG9tZWRpcigpIH0pO1xuICAgIGxldCBsYXN0ID0gJyc7XG4gICAgY29uc3Qgb25MaW5lID0gKGQ6IEJ1ZmZlcik6IHZvaWQgPT4ge1xuICAgICAgZm9yIChjb25zdCByYXcgb2YgZC50b1N0cmluZygpLnNwbGl0KC9cXHI/XFxuLykpIHtcbiAgICAgICAgY29uc3QgbGluZSA9IHJhdy5yZXBsYWNlKC9bXFx1MDAwMC1cXHUwMDFmXS9nLCAnJykudHJpbSgpLnNsaWNlKDAsIDE4MCk7XG4gICAgICAgIGlmIChsaW5lID09PSAnJyB8fCBsaW5lID09PSBsYXN0KSBjb250aW51ZTtcbiAgICAgICAgbGFzdCA9IGxpbmU7XG4gICAgICAgIGhvc3Quc2VuZFByb2dyZXNzKHsgcGhhc2U6ICducG0nLCB0ZXh0OiBsaW5lIH0pO1xuICAgICAgfVxuICAgIH07XG4gICAgYy5zdGRvdXQ/Lm9uKCdkYXRhJywgb25MaW5lKTtcbiAgICBjLnN0ZGVycj8ub24oJ2RhdGEnLCBvbkxpbmUpO1xuICAgIGMub24oJ2Vycm9yJywgcmVqZWN0KTtcbiAgICBjb25zdCBraWxsZXIgPSBzZXRUaW1lb3V0KCgpID0+IHsgdHJ5IHsgYy5raWxsKCk7IH0gY2F0Y2ggeyAvKiBub29wICovIH0gcmVqZWN0KG5ldyBFcnJvcignbnBtIFx1NUI4OVx1ODhDNVx1OEQ4NVx1NjVGNig4IFx1NTIwNlx1OTQ5RiknKSk7IH0sIDggKiA2MF8wMDApO1xuICAgIGMub24oJ2V4aXQnLCAoeCkgPT4geyBjbGVhclRpbWVvdXQoa2lsbGVyKTsgcmVzb2x2ZSh4ID8/IDEpOyB9KTtcbiAgfSk7XG4gIGlmIChjb2RlICE9PSAwKSB0aHJvdyBuZXcgRXJyb3IoYG5wbSBpbnN0YWxsIFx1OTAwMFx1NTFGQVx1NzgwMSAke2NvZGV9YCk7XG4gIGNvbnN0IGVudHJ5ID0gcmVzb2x2ZUluc3RhbGxlZEVudHJ5KHRhcmdldCk7XG4gIGlmIChlbnRyeSA9PT0gJycpIHRocm93IG5ldyBFcnJvcignbnBtIFx1NUI4OVx1ODhDNVx1NUI4Q1x1NjIxMFx1NEY0Nlx1NjcyQVx1NjI3RVx1NTIzMCBkZXNrdG9wLWhvc3QgXHU1MTY1XHU1M0UzJyk7XG4gIHdyaXRlU3RhbXAodGFyZ2V0LCAnbnBtJyk7XG4gIGZpbmlzaEluc3RhbGwoaG9zdCwgZW50cnksICducG0nKTtcbn1cblxuLyogLS0tLSBcdThERUZcdTVGODQgQjpcdTgxRUFcdTc4MTQgdGd6KFx1NzcxRlx1NEUwQlx1OEY3RFx1OEZEQlx1NUVBNiArIFx1OTU1Q1x1NTBDRlx1NTZERVx1OTAwMCArIGludGVncml0eSArIHRhciBcdTg5RTNcdTUzOEIpIC0tLS0gKi9cbmFzeW5jIGZ1bmN0aW9uIGluc3RhbGxWaWFUYXJiYWxscyhob3N0OiBJbnN0YWxsZXJIb3N0LCB0YXJnZXQ6IHN0cmluZywgb3B0czogSW5zdGFsbE9wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3Qgb3JkZXI6IEFycmF5PCducG1qcycgfCAnbnBtbWlycm9yJz4gPSBvcHRzLm1pcnJvckZpcnN0ID09PSAnbnBtbWlycm9yJyA/IFsnbnBtbWlycm9yJywgJ25wbWpzJ10gOiBbJ25wbWpzJywgJ25wbW1pcnJvciddO1xuICBjb25zdCBtaXJyb3JzID0gb3JkZXIubWFwKChrKSA9PiBSRUdJU1RSSUVTW2tdKTtcbiAgaG9zdC5zZW5kUHJvZ3Jlc3MoeyBwaGFzZTogJ21ldGEnLCB0ZXh0OiAnXHU4OUUzXHU2NzkwXHU0RjlEXHU4RDU2XHU2RTA1XHU1MzU1KEBobWhhcm5lc3MvY2xpIFx1NTE2OFx1NUJCNilcdTIwMjYnIH0pO1xuXG4gIGNvbnN0IHBhY2t1bWVudHMgPSBuZXcgTWFwPHN0cmluZywgUGFja3VtZW50PigpO1xuICBjb25zdCBnZXRQYWNrdW1lbnQgPSBhc3luYyAobmFtZTogc3RyaW5nKTogUHJvbWlzZTxQYWNrdW1lbnQ+ID0+IHtcbiAgICBjb25zdCBoaXQgPSBwYWNrdW1lbnRzLmdldChuYW1lKTtcbiAgICBpZiAoaGl0ICE9PSB1bmRlZmluZWQpIHJldHVybiBoaXQ7XG4gICAgbGV0IGxhc3RFcnIgPSAnJztcbiAgICBmb3IgKGNvbnN0IG0gb2YgbWlycm9ycykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgciA9IGF3YWl0IGZldGNoKGAke219LyR7ZW5jb2RlVVJJQ29tcG9uZW50KG5hbWUpfWAsIHtcbiAgICAgICAgICBoZWFkZXJzOiB7IGFjY2VwdDogJ2FwcGxpY2F0aW9uL3ZuZC5ucG0uaW5zdGFsbC12MStqc29uJyB9LFxuICAgICAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCgyNV8wMDApLFxuICAgICAgICB9KTtcbiAgICAgICAgaWYgKCFyLm9rKSB7IGxhc3RFcnIgPSBgSFRUUCAke3Iuc3RhdHVzfWA7IGNvbnRpbnVlOyB9XG4gICAgICAgIGNvbnN0IGRvYyA9IChhd2FpdCByLmpzb24oKSkgYXMgUGFja3VtZW50O1xuICAgICAgICBpZiAoZG9jLnZlcnNpb25zID09PSB1bmRlZmluZWQpIHsgbGFzdEVyciA9ICdtYWxmb3JtZWQgcGFja3VtZW50JzsgY29udGludWU7IH1cbiAgICAgICAgcGFja3VtZW50cy5zZXQobmFtZSwgZG9jKTtcbiAgICAgICAgcmV0dXJuIGRvYztcbiAgICAgIH0gY2F0Y2ggKGVycikgeyBsYXN0RXJyID0gU3RyaW5nKGVycikuc2xpY2UoMCwgNjApOyB9XG4gICAgfVxuICAgIHRocm93IG5ldyBFcnJvcihgXHU4M0I3XHU1M0Q2ICR7bmFtZX0gXHU1MTQzXHU2NTcwXHU2MzZFXHU1OTMxXHU4RDI1KFx1NTE2OFx1OTBFOFx1OTU1Q1x1NTBDRjoke2xhc3RFcnJ9KWApO1xuICB9O1xuXG4gIGNvbnN0IGNsb3N1cmUgPSBhd2FpdCByZXNvbHZlQ2xvc3VyZSh7IG5hbWU6ICdAaG1oYXJuZXNzL2NsaScsIHNwZWM6ICdsYXRlc3QnIH0sIGdldFBhY2t1bWVudCk7XG4gIGNvbnN0IHJvb3QgPSBjbG9zdXJlLmZpbmQoKHApID0+IHAubmFtZSA9PT0gJ0BobWhhcm5lc3MvY2xpJyk7XG4gIGhvc3QubG9nKGBjbG9zdXJlOiAke2Nsb3N1cmUubGVuZ3RofSBwYWNrYWdlcyAocm9vdCBAaG1oYXJuZXNzL2NsaUAke3Jvb3Q/LnZlcnNpb24gPz8gJz8nfSlgKTtcbiAgaG9zdC5zZW5kUHJvZ3Jlc3MoeyBwaGFzZTogJ21ldGEnLCB0ZXh0OiBgXHU0RjlEXHU4RDU2XHU2RTA1XHU1MzU1XHU1QzMxXHU3RUVBOiR7Y2xvc3VyZS5sZW5ndGh9IFx1NEUyQVx1NTMwNShAaG1oYXJuZXNzL2NsaUAke3Jvb3Q/LnZlcnNpb24gPz8gJz8nfSlgIH0pO1xuXG4gIGNvbnN0IHN0YWdpbmcgPSBqb2luKHRhcmdldCwgJy5zdGFnaW5nJyk7XG4gIHJtU3luYyhzdGFnaW5nLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIG1rZGlyU3luYyhzdGFnaW5nLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICBmb3IgKGxldCBpID0gMDsgaSA8IGNsb3N1cmUubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBwa2cgPSBjbG9zdXJlW2ldITtcbiAgICBjb25zdCB1cmxzID0gdGFyYmFsbE1pcnJvcnMocGtnLnRhcmJhbGwsIG1pcnJvcnMpO1xuICAgIGxldCBidWY6IEJ1ZmZlciB8IG51bGwgPSBudWxsO1xuICAgIGxldCB1c2VkTWlycm9yID0gJyc7XG4gICAgbGV0IGxhc3RFcnIgPSAnJztcbiAgICBmb3IgKGNvbnN0IHUgb2YgdXJscykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgciA9IGF3YWl0IGZldGNoKHUsIHsgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDMwMF8wMDApIH0pO1xuICAgICAgICBpZiAoIXIub2spIHsgbGFzdEVyciA9IGBIVFRQICR7ci5zdGF0dXN9YDsgY29udGludWU7IH1cbiAgICAgICAgY29uc3QgdG90YWwgPSBOdW1iZXIoci5oZWFkZXJzLmdldCgnY29udGVudC1sZW5ndGgnKSA/PyAnMCcpO1xuICAgICAgICBjb25zdCByZWFkZXIgPSByLmJvZHk/LmdldFJlYWRlcigpO1xuICAgICAgICBpZiAocmVhZGVyID09PSB1bmRlZmluZWQpIHRocm93IG5ldyBFcnJvcignbm8gYm9keScpO1xuICAgICAgICBjb25zdCBjaHVua3M6IEJ1ZmZlcltdID0gW107XG4gICAgICAgIGxldCBnb3QgPSAwO1xuICAgICAgICBsZXQgbGFzdEVtaXQgPSAwO1xuICAgICAgICBmb3IgKDs7KSB7XG4gICAgICAgICAgY29uc3QgeyBkb25lLCB2YWx1ZSB9ID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcbiAgICAgICAgICBpZiAoZG9uZSA9PT0gdHJ1ZSkgYnJlYWs7XG4gICAgICAgICAgY29uc3QgYiA9IEJ1ZmZlci5mcm9tKHZhbHVlKTtcbiAgICAgICAgICBjaHVua3MucHVzaChiKTtcbiAgICAgICAgICBnb3QgKz0gYi5sZW5ndGg7XG4gICAgICAgICAgaWYgKGdvdCAtIGxhc3RFbWl0ID4gMjU2ICogMTAyNCkge1xuICAgICAgICAgICAgbGFzdEVtaXQgPSBnb3Q7XG4gICAgICAgICAgICBob3N0LnNlbmRQcm9ncmVzcyh7XG4gICAgICAgICAgICAgIHBoYXNlOiAnZG93bmxvYWQnLFxuICAgICAgICAgICAgICBwY3Q6IE1hdGgucm91bmQoKChpICsgTWF0aC5taW4oZ290IC8gKHRvdGFsIHx8IGdvdCksIDEpKSAvIGNsb3N1cmUubGVuZ3RoKSAqIDEwMCksXG4gICAgICAgICAgICAgIHRleHQ6IGBcdTRFMEJcdThGN0QgJHtwa2cubmFtZX1AJHtwa2cudmVyc2lvbn0oJHtpICsgMX0vJHtjbG9zdXJlLmxlbmd0aH0pXHUwMEI3ICR7Ynl0ZXNMYWJlbChnb3QpfSR7dG90YWwgPiAwID8gYCAvICR7Ynl0ZXNMYWJlbCh0b3RhbCl9YCA6ICcnfWAsXG4gICAgICAgICAgICAgIG1pcnJvcjogbmV3IFVSTCh1KS5ob3N0LFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGJ1ZiA9IEJ1ZmZlci5jb25jYXQoY2h1bmtzKTtcbiAgICAgICAgaWYgKCFpbnRlZ3JpdHlPayhidWYsIHBrZy5pbnRlZ3JpdHkpKSB7IGxhc3RFcnIgPSAnaW50ZWdyaXR5IFx1NEUwRFx1NTMzOVx1OTE0RCc7IGJ1ZiA9IG51bGw7IGNvbnRpbnVlOyB9XG4gICAgICAgIHVzZWRNaXJyb3IgPSBuZXcgVVJMKHUpLmhvc3Q7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGxhc3RFcnIgPSBTdHJpbmcoZXJyKS5zbGljZSgwLCA2MCk7XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChidWYgPT09IG51bGwpIHRocm93IG5ldyBFcnJvcihgXHU0RTBCXHU4RjdEICR7cGtnLm5hbWV9IFx1NTkzMVx1OEQyNShcdTUxNjhcdTkwRThcdTk1NUNcdTUwQ0Y6JHtsYXN0RXJyfSlgKTtcbiAgICBjb25zdCB0Z3ogPSBqb2luKHN0YWdpbmcsIGAke2l9LnRnemApO1xuICAgIHdyaXRlRmlsZVN5bmModGd6LCBidWYpO1xuICAgIGhvc3Quc2VuZFByb2dyZXNzKHtcbiAgICAgIHBoYXNlOiAnZG93bmxvYWQnLFxuICAgICAgcGN0OiBNYXRoLnJvdW5kKCgoaSArIDEpIC8gY2xvc3VyZS5sZW5ndGgpICogMTAwKSxcbiAgICAgIHRleHQ6IGBcdTRFMEJcdThGN0QgJHtwa2cubmFtZX1AJHtwa2cudmVyc2lvbn0gXHU1QjhDXHU2MjEwKCR7Ynl0ZXNMYWJlbChidWYubGVuZ3RoKX0sdmlhICR7dXNlZE1pcnJvcn0pYCxcbiAgICAgIG1pcnJvcjogdXNlZE1pcnJvcixcbiAgICB9KTtcbiAgfVxuXG4gIGhvc3Quc2VuZFByb2dyZXNzKHsgcGhhc2U6ICdleHRyYWN0JywgdGV4dDogJ1x1ODlFM1x1NTM4Qlx1NUU3Nlx1NUUwM1x1NUM0MCBub2RlX21vZHVsZXNcdTIwMjYnIH0pO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGNsb3N1cmUubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBwa2cgPSBjbG9zdXJlW2ldITtcbiAgICBhd2FpdCBleHRyYWN0VGd6KGpvaW4oc3RhZ2luZywgYCR7aX0udGd6YCksIHN0YWdpbmcsIHBrZyk7XG4gICAgaG9zdC5zZW5kUHJvZ3Jlc3MoeyBwaGFzZTogJ2V4dHJhY3QnLCBwY3Q6IE1hdGgucm91bmQoKChpICsgMSkgLyBjbG9zdXJlLmxlbmd0aCkgKiAxMDApLCB0ZXh0OiBgXHU4OUUzXHU1MzhCICR7cGtnLm5hbWV9KCR7aSArIDF9LyR7Y2xvc3VyZS5sZW5ndGh9KWAgfSk7XG4gIH1cbiAgcm1TeW5jKHN0YWdpbmcsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcblxuICBjb25zdCBlbnRyeSA9IHJlc29sdmVJbnN0YWxsZWRFbnRyeSh0YXJnZXQpO1xuICBpZiAoZW50cnkgPT09ICcnKSB0aHJvdyBuZXcgRXJyb3IoJ3RneiBcdTVCODlcdTg4QzVcdTVCOENcdTYyMTBcdTRGNDZcdTY3MkFcdTYyN0VcdTUyMzAgZGVza3RvcC1ob3N0IFx1NTE2NVx1NTNFMycpO1xuICB3cml0ZVN0YW1wKHRhcmdldCwgJ3RneicpO1xuICBmaW5pc2hJbnN0YWxsKGhvc3QsIGVudHJ5LCAndGd6Jyk7XG59XG5cbi8qKiB0YXIuZXhlKFdpbjEwKyBcdTgxRUFcdTVFMjYpXHU4OUUzXHU1MzhCIHRneiBcdTUyMzAgZXhEaXIsXHU1MThEXHU2MjhBIHBhY2thZ2UvIFx1NjMyQVx1NTIzMCBub2RlX21vZHVsZXMgXHU1RTAzXHU1QzQwXHUzMDAyICovXG5hc3luYyBmdW5jdGlvbiBleHRyYWN0VGd6KHRnejogc3RyaW5nLCBzdGFnaW5nOiBzdHJpbmcsIHBrZzogUmVzb2x2ZWRQa2cpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgZXhEaXIgPSBqb2luKHN0YWdpbmcsIGB4LSR7cGtnLm5hbWUucmVwbGFjZSgvW15cXHcuLV0vZywgJ18nKX1gKTtcbiAgcm1TeW5jKGV4RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIG1rZGlyU3luYyhleERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIGNvbnN0IGNvZGUgPSBhd2FpdCBuZXcgUHJvbWlzZTxudW1iZXI+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICBjb25zdCBjID0gc3Bhd24oJ3RhcicsIFsnLXh6ZicsIHRneiwgJy1DJywgZXhEaXJdLCB7IHdpbmRvd3NIaWRlOiB0cnVlLCBzdGRpbzogJ2lnbm9yZScgfSk7XG4gICAgYy5vbignZXJyb3InLCByZWplY3QpO1xuICAgIGMub24oJ2V4aXQnLCAoeCkgPT4gcmVzb2x2ZSh4ID8/IDEpKTtcbiAgfSk7XG4gIGlmIChjb2RlICE9PSAwKSB0aHJvdyBuZXcgRXJyb3IoYHRhciBcdTg5RTNcdTUzOEIgJHtwa2cubmFtZX0gXHU1OTMxXHU4RDI1KFx1OTAwMFx1NTFGQVx1NzgwMSAke2NvZGV9KWApO1xuICBjb25zdCBkZXN0ID0gbW9kdWxlRGlyKGluc3RhbGxUYXJnZXQoKSwgcGtnLm5hbWUpO1xuICBjb25zdCBwYXJlbnQgPSBkZXN0LnNsaWNlKDAsIGRlc3QubGFzdEluZGV4T2YoJ1xcXFwnKSk7XG4gIG1rZGlyU3luYyhwYXJlbnQsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBybVN5bmMoZGVzdCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICByZW5hbWVTeW5jKGpvaW4oZXhEaXIsICdwYWNrYWdlJyksIGRlc3QpO1xuICBybVN5bmMoZXhEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbn1cblxuLyoqIFx1NUI4OVx1ODhDNVx1NjIzMyhcdTU0MTFcdTVCRkNcdTVCOENcdTYyMTBcdTk4NzUvXHU4QkJFXHU3RjZFXHU5NzYyXHU2NzdGXHU1QzU1XHU3OTNBXHU1Qjg5XHU4OEM1XHU2NUI5XHU1RjBGXHU0RTBFXHU2NUY2XHU5NUY0O1x1NEUwRFx1NjI3Rlx1OEY3RFx1OEZEMFx1ODg0Q1x1NjVGNlx1OTAzQlx1OEY5MSlcdTMwMDIgKi9cbmZ1bmN0aW9uIHdyaXRlU3RhbXAodGFyZ2V0OiBzdHJpbmcsIHZpYTogJ25wbScgfCAndGd6Jyk6IHZvaWQge1xuICB0cnkge1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbih0YXJnZXQsICdpbnN0YWxsZWQtYnktaG1oLWRlc2t0b3AuanNvbicpLCBKU09OLnN0cmluZ2lmeSh7IHZpYSwgYXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSB9LCBudWxsLCAyKSwgJ3V0ZjgnKTtcbiAgfSBjYXRjaCB7IC8qIGJlc3QgZWZmb3J0ICovIH1cbn1cblxuZnVuY3Rpb24gZmluaXNoSW5zdGFsbChob3N0OiBJbnN0YWxsZXJIb3N0LCBlbnRyeTogc3RyaW5nLCB2aWE6ICducG0nIHwgJ3RneicpOiB2b2lkIHtcbiAgaG9zdC5sb2coYGluc3RhbGwgZG9uZSB2aWEgJHt2aWF9OiAke2VudHJ5fWApO1xuICBob3N0LnNlbmRQcm9ncmVzcyh7IHBoYXNlOiAnZG9uZScsIHRleHQ6IGBcdTVCODlcdTg4QzVcdTVCOENcdTYyMTAoJHt2aWF9KWAsIGVudHJ5IH0pO1xuICBob3N0Lm9uSW5zdGFsbGVkKGVudHJ5LCB2aWEpO1xuICBydW5uaW5nID0gZmFsc2U7XG59XG4iLCAiLyoqXG4gKiBAaG1oYXJuZXNzL2NsaSBcdTVCODlcdTg4QzVcdTY4MzhcdTVGQzMoXHU3RUFGXHU5MDNCXHU4RjkxLFx1OTZGNiBJTyBcdTIwMTRcdTIwMTQgZmV0Y2gvXHU4OUUzXHU1MzhCL1x1ODQzRFx1NzZEOFx1NTcyOFx1NEUzQlx1OEZEQlx1N0EwQiBpbnN0YWxsZXIgXHU5MUNDKVx1MzAwMlxuICpcbiAqIFx1ODA0Q1x1OEQyMyh2NS4xIFx1NUI4OVx1ODhDNVx1NTQxMVx1NUJGQyk6XHU3RUQ5XHU1QjlBIHJlZ2lzdHJ5IFx1NTE0M1x1NjU3MFx1NjM2RVx1ODNCN1x1NTNENlx1NTFGRFx1NjU3MCxcdTg5RTNcdTY3OTAgQGhtaGFybmVzcy9jbGkgXHU3Njg0XG4gKiBcdTVCOENcdTY1NzRcdTRGOURcdThENTZcdTk1RURcdTUzMDUoQGhtaGFybmVzcy8qIFx1NTE2OFx1NUJCNlx1NEUzQVx1N0NCRVx1Nzg2RVx1NzI0OFx1NjcyQ1x1NEU5Mlx1OTQ4OTtcdTU5MTZcdTkwRThcdTRGOURcdThENTYgcXJjb2RlIFx1OTRGRVx1NEUzQSBeIFx1ODMwM1x1NTZGNCksXG4gKiBcdTRFQTdcdTUxRkFcIlx1ODhDNVx1NEVDMFx1NEU0OFx1MzAwMVx1NEVDRVx1NTRFQVx1NEU5Qlx1OTU1Q1x1NTBDRlx1NEUwQlx1MzAwMVx1ODhDNVx1NTIzMFx1NTRFQVwiXHU3Njg0XHU3ODZFXHU1QjlBXHU2MDI3XHU4QkExXHU1MjEyXHUzMDAyXHU4QkJFXHU4QkExXHU3RUE2XHU2NzVGOlxuICogIC0gXHU5NUVEXHU1MzA1XHU2MzA5XHU1MzA1XHU1NDBEXHU1M0JCXHU5MUNEKFx1OTRCQlx1NzdGM1x1NEY5RFx1OEQ1Nlx1NTNFQVx1ODhDNVx1NEUwMFx1NEVGRCxucG0gXHU4QkVEXHU0RTQ5KTtcbiAqICAtIFx1ODMwM1x1NTZGNFx1ODlFM1x1Njc5MFx1NTNFQVx1NjUyRlx1NjMwMSBucG0gXHU3NTFGXHU2MDAxXHU1QjlFXHU5NjQ1XHU3NTI4XHU1MjMwXHU3Njg0XHU1RjYyXHU2MDAxOlx1N0NCRVx1Nzg2RSAvIGxhdGVzdCAvICogLyBeIC8gfiAvID49LFxuICogICAgXHU0RTBEXHU1RjE1IHNlbXZlciBcdTVFOTMoXHU5NkY2XHU0RjlEXHU4RDU2XHU1MzlGXHU1MjE5LFx1NEUwRVx1ODFFQVx1NzgxNFx1NjZGNFx1NjVCMFx1NTY2OFx1NEUwMFx1ODFGNCk7XG4gKiAgLSBvcHRpb25hbERlcGVuZGVuY2llcyBcdTRFMERcdTg4QzU6XHU5NUVEXHU1MzA1XHU1MTg1XHU1QjlFXHU5NjQ1XHU1OEYwXHU2NjBFXHU3Njg0IG9wdGlvbmFsIFx1NTc0N1x1NEUzQVx1NUU3M1x1NTNGMFx1NzI3OVx1NUI5QVxuICogICAgKGZzZXZlbnRzIFx1N0I0OSksdGd6IFx1OERFRlx1NUY4NFx1NEUwRFx1OEREMVx1NzUxRlx1NTQ3RFx1NTQ2OFx1NjcxRlx1ODExQVx1NjcyQyxcdTg4QzVcdTRFODZcdTRFNUZcdTUzRUFcdTY2MkZcdTZCN0JcdTkxQ0RcdTMwMDJcbiAqL1xuaW1wb3J0IHsgY3JlYXRlSGFzaCB9IGZyb20gJ25vZGU6Y3J5cHRvJztcblxuZXhwb3J0IGludGVyZmFjZSBQa2dWZXJzaW9uTWV0YSB7XG4gIHZlcnNpb246IHN0cmluZztcbiAgZGVwZW5kZW5jaWVzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuICB0YXJiYWxsOiBzdHJpbmc7XG4gIGludGVncml0eT86IHN0cmluZyB8IHVuZGVmaW5lZDtcbn1cblxuLyoqIHJlZ2lzdHJ5IHBhY2t1bWVudCBcdTc2ODRcdTY3MDBcdTVDMEZcdThCRkJcdTUzRDZcdTk3NjIoZGlzdC10YWdzICsgXHU1MTY4XHU3MjQ4XHU2NzJDXHU0RjlEXHU4RDU2L3RhcmJhbGwgXHU1MTQzXHU2NTcwXHU2MzZFKVx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBQYWNrdW1lbnQge1xuICAnZGlzdC10YWdzJzogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcbiAgdmVyc2lvbnM6IFJlY29yZDxzdHJpbmcsIHsgZGVwZW5kZW5jaWVzPzogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB8IHVuZGVmaW5lZDsgZGlzdD86IHsgdGFyYmFsbD86IHN0cmluZzsgaW50ZWdyaXR5Pzogc3RyaW5nIHwgdW5kZWZpbmVkIH0gfCB1bmRlZmluZWQgfT47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUmVzb2x2ZWRQa2cge1xuICBuYW1lOiBzdHJpbmc7XG4gIHZlcnNpb246IHN0cmluZztcbiAgLyoqIHJlZ2lzdHJ5IFx1NTM5Rlx1NTlDQlx1NTczMFx1NTc0MChcdTk1NUNcdTUwQ0ZcdTUyMTdcdTg4NjhcdTc1MzEgdGFyYmFsbE1pcnJvcnMgXHU2RDNFXHU3NTFGKVx1MzAwMiAqL1xuICB0YXJiYWxsOiBzdHJpbmc7XG4gIGludGVncml0eT86IHN0cmluZyB8IHVuZGVmaW5lZDtcbn1cblxuLyogLS0tLSBzZW12ZXIoXHU2NzAwXHU1QzBGXHU1QjlFXHU3M0IwOlx1OTVFRFx1NTMwNVx1NTE4NVx1NUI5RVx1OTY0NVx1NTFGQVx1NzNCMFx1NzY4NFx1NUY2Mlx1NjAwMSkgLS0tLSAqL1xuXG5leHBvcnQgZnVuY3Rpb24gY21wU2VtdmVyKGE6IHN0cmluZywgYjogc3RyaW5nKTogbnVtYmVyIHtcbiAgY29uc3QgcGEgPSBhLnJlcGxhY2UoL152LywgJycpLnNwbGl0KCctJylbMF0hLnNwbGl0KCcuJykubWFwKE51bWJlcik7XG4gIGNvbnN0IHBiID0gYi5yZXBsYWNlKC9edi8sICcnKS5zcGxpdCgnLScpWzBdIS5zcGxpdCgnLicpLm1hcChOdW1iZXIpO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IDM7IGkrKykge1xuICAgIGNvbnN0IHggPSBwYVtpXSA/PyAwO1xuICAgIGNvbnN0IHkgPSBwYltpXSA/PyAwO1xuICAgIGlmICh4ICE9PSB5KSByZXR1cm4geCA8IHkgPyAtMSA6IDE7XG4gIH1cbiAgcmV0dXJuIDA7XG59XG5cbi8qKiByYW5nZSBcdTY2MkZcdTU0MjZcdTYzQTVcdTUzRDcgdmVyc2lvbihcdTY1MkZcdTYzMDEgXHU3Q0JFXHU3ODZFIC8gbGF0ZXN0IC8gKiAvIHggLyBeIC8gfiAvID49O1x1NEUwRFx1OEJDNlx1NTIyQlx1NTIxOSBmYWxzZSlcdTMwMDIgKi9cbmV4cG9ydCBmdW5jdGlvbiBzYXRpc2ZpZXMocmFuZ2U6IHN0cmluZywgdmVyc2lvbjogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IHIgPSByYW5nZS50cmltKCk7XG4gIGlmIChyID09PSAnJyB8fCByID09PSAnKicgfHwgciA9PT0gJ2xhdGVzdCcgfHwgciA9PT0gJ3gnKSByZXR1cm4gdHJ1ZTtcbiAgaWYgKHIgPT09IHZlcnNpb24pIHJldHVybiB0cnVlO1xuICBjb25zdCBib3VuZCA9IC9eKFxcXnx+fD49PylcXHMqKFxcZCspXFwuKFxcZCspXFwuKFxcZCspLy5leGVjKHIpO1xuICBpZiAoYm91bmQgIT09IG51bGwpIHtcbiAgICBjb25zdCBvcCA9IGJvdW5kWzFdITtcbiAgICBjb25zdCBtYWpvciA9IE51bWJlcihib3VuZFsyXSk7XG4gICAgY29uc3QgbWlub3IgPSBOdW1iZXIoYm91bmRbM10pO1xuICAgIGNvbnN0IHBhdGNoID0gTnVtYmVyKGJvdW5kWzRdKTtcbiAgICBjb25zdCBjID0gY21wU2VtdmVyKHZlcnNpb24sIGAke21ham9yfS4ke21pbm9yfS4ke3BhdGNofWApO1xuICAgIGlmIChjIDwgMCkgcmV0dXJuIGZhbHNlO1xuICAgIGlmIChvcCA9PT0gJz49JykgcmV0dXJuIHRydWU7IC8vICc+PScgXHU0RTBCXHU3NTRDXHU1MzczXHU1M0VGOlx1OTVFRFx1NTMwNVx1NTE4NVx1NTNFQVx1NEVFNSAnPj14LnkueiA8eicgXHU1OTBEXHU1NDA4XHU1RjYyXHU2MDAxXHU1MUZBXHU3M0IwLFx1NEZERFx1NUI4OFx1NTNENlx1NEUwQlx1NzU0Q1xuICAgIGlmIChvcCA9PT0gJ34nKSByZXR1cm4gY21wU2VtdmVyKHZlcnNpb24sIGAke21ham9yfS4ke21pbm9yICsgMX0uMGApIDwgMDtcbiAgICAvLyAnXic6MC54IFx1NzI3OVx1NTIyNCgwLjIuMyBcdTUxNDFcdThCQjggMC4yLnopLFx1NTE3Nlx1NEY1OVx1OTUwMVx1NEUzQlx1NzI0OFx1NjcyQ1xuICAgIGlmIChtYWpvciA9PT0gMCkgcmV0dXJuIG1pbm9yID09PSAwID8gY21wU2VtdmVyKHZlcnNpb24sIGAwLjAuJHtwYXRjaCArIDF9YCkgPCAwIDogY21wU2VtdmVyKHZlcnNpb24sIGAwLiR7bWlub3IgKyAxfS4wYCkgPCAwO1xuICAgIHJldHVybiBjbXBTZW12ZXIodmVyc2lvbiwgYCR7bWFqb3IgKyAxfS4wLjBgKSA8IDA7XG4gIH1cbiAgcmV0dXJuIGZhbHNlO1xufVxuXG4vKiogXHU0RUNFIHBhY2t1bWVudCBcdTkwMDlcdTUxRkEgc3BlYyhcdTdDQkVcdTc4NkUvbGF0ZXN0L14vfi8qKVx1NjMwN1x1NTQxMVx1NzY4NFx1NzI0OFx1NjcyQztcdTY1RTBcdTUzMzlcdTkxNERcdThGRDRcdTU2REUgJydcdTMwMDIgKi9cbmV4cG9ydCBmdW5jdGlvbiBwaWNrVmVyc2lvbihkb2M6IFBhY2t1bWVudCwgc3BlYzogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgcyA9IHNwZWMudHJpbSgpO1xuICBjb25zdCB0YWcgPSBzID09PSAnJyB8fCBzID09PSAnbGF0ZXN0JyB8fCBzID09PSAnKicgPyBkb2NbJ2Rpc3QtdGFncyddPy5sYXRlc3QgOiB1bmRlZmluZWQ7XG4gIGlmICh0YWcgIT09IHVuZGVmaW5lZCAmJiBkb2MudmVyc2lvbnNbdGFnXSAhPT0gdW5kZWZpbmVkKSByZXR1cm4gdGFnO1xuICBpZiAoZG9jLnZlcnNpb25zW3NdICE9PSB1bmRlZmluZWQpIHJldHVybiBzO1xuICBsZXQgYmVzdCA9ICcnO1xuICBmb3IgKGNvbnN0IHYgb2YgT2JqZWN0LmtleXMoZG9jLnZlcnNpb25zKSkge1xuICAgIGlmIChzYXRpc2ZpZXMocywgdikgJiYgY21wU2VtdmVyKHYsIGJlc3QpID4gMCkgYmVzdCA9IHY7XG4gIH1cbiAgcmV0dXJuIGJlc3Q7XG59XG5cbi8qIC0tLS0gXHU0RjlEXHU4RDU2XHU5NUVEXHU1MzA1IC0tLS0gKi9cblxuLyoqXG4gKiBcdTg5RTNcdTY3OTAgcm9vdCBcdTUzQ0FcdTUxNzZcdTUxNjhcdTkwRThcdTRGMjBcdTkwMTJcdTRGOURcdThENTYoQkZTLFx1NjMwOVx1NTMwNVx1NTQwRFx1NTNCQlx1OTFDRFx1NTNENlx1OTk5Nlx1NEUyQVx1ODlFM1x1Njc5MFx1N0VEM1x1Njc5QyBcdTIwMTRcdTIwMTQgXHU0RTBFIG5wbSBcdTYyNDFcdTVFNzNcbiAqIFx1NUUwM1x1NUM0MFx1NEUwMFx1ODFGNClcdTMwMDJnZXRQYWNrdW1lbnQgXHU3NTMxXHU4QzAzXHU3NTI4XHU2NUI5XHU2Q0U4XHU1MTY1KGZldGNoIFx1N0Y1MVx1N0VEQyAvIFx1NkQ0Qlx1OEJENVx1NkNFOFx1NTE2NVx1NUI1N1x1NTE3OClcdTMwMDJcbiAqIFx1NEVGQlx1NEUwMFx1NEY5RFx1OEQ1Nlx1NjVFMFx1NkVFMVx1OERCM1x1NzI0OFx1NjcyQ1x1NjVGNlx1NjI5Qlx1OTUxOShcdTVFMjZcdTUzMDVcdTU0MERcdTRFMEUgcmFuZ2UsXHU5NzYyXHU1NDExXHU1Qjg5XHU4OEM1XHU5ODc1XHU5NTE5XHU4QkVGXHU2NTg3XHU2ODQ4KVx1MzAwMlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZUNsb3N1cmUoXG4gIHJvb3Q6IHsgbmFtZTogc3RyaW5nOyBzcGVjOiBzdHJpbmcgfSxcbiAgZ2V0UGFja3VtZW50OiAobmFtZTogc3RyaW5nKSA9PiBQcm9taXNlPFBhY2t1bWVudD4sXG4pOiBQcm9taXNlPFJlc29sdmVkUGtnW10+IHtcbiAgY29uc3QgcmVzb2x2ZWQgPSBuZXcgTWFwPHN0cmluZywgUGtnVmVyc2lvbk1ldGE+KCk7XG4gIGNvbnN0IHF1ZXVlOiBBcnJheTx7IG5hbWU6IHN0cmluZzsgc3BlYzogc3RyaW5nIH0+ID0gW3Jvb3RdO1xuICB3aGlsZSAocXVldWUubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IHsgbmFtZSwgc3BlYyB9ID0gcXVldWUuc2hpZnQoKSE7XG4gICAgaWYgKHJlc29sdmVkLmhhcyhuYW1lKSkgY29udGludWU7IC8vIFx1NURGMlx1NUI5QVx1NzI0ODpcdTU0MEVcdTdFRUQgcmFuZ2UgXHU1RjE1XHU3NTI4XHU0RTBEXHU1MThEXHU5MUNEXHU4OUUzKG5wbSBcdTYyNDFcdTVFNzNcdThCRURcdTRFNDkpXG4gICAgY29uc3QgZG9jID0gYXdhaXQgZ2V0UGFja3VtZW50KG5hbWUpO1xuICAgIGNvbnN0IHZlcnNpb24gPSBwaWNrVmVyc2lvbihkb2MsIHNwZWMpO1xuICAgIGNvbnN0IG1ldGEgPSB2ZXJzaW9uICE9PSAnJyA/IGRvYy52ZXJzaW9uc1t2ZXJzaW9uXSA6IHVuZGVmaW5lZDtcbiAgICBpZiAobWV0YSA9PT0gdW5kZWZpbmVkIHx8IG1ldGEuZGlzdD8udGFyYmFsbCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYG5vIHZlcnNpb24gb2YgJHtuYW1lfSBzYXRpc2ZpZXMgJHtzcGVjIHx8ICdsYXRlc3QnfWApO1xuICAgIH1cbiAgICBjb25zdCBpdGVtOiBQa2dWZXJzaW9uTWV0YSA9IHtcbiAgICAgIHZlcnNpb24sXG4gICAgICBkZXBlbmRlbmNpZXM6IG1ldGEuZGVwZW5kZW5jaWVzID8/IHt9LFxuICAgICAgdGFyYmFsbDogbWV0YS5kaXN0LnRhcmJhbGwsXG4gICAgICBpbnRlZ3JpdHk6IG1ldGEuZGlzdC5pbnRlZ3JpdHksXG4gICAgfTtcbiAgICByZXNvbHZlZC5zZXQobmFtZSwgaXRlbSk7XG4gICAgZm9yIChjb25zdCBbZGVwLCByYW5nZV0gb2YgT2JqZWN0LmVudHJpZXMoaXRlbS5kZXBlbmRlbmNpZXMpKSB7XG4gICAgICBpZiAoIXJlc29sdmVkLmhhcyhkZXApKSBxdWV1ZS5wdXNoKHsgbmFtZTogZGVwLCBzcGVjOiByYW5nZSB9KTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIFsuLi5yZXNvbHZlZC5lbnRyaWVzKCldLm1hcCgoW25hbWUsIG1dKSA9PiAoeyBuYW1lLCB2ZXJzaW9uOiBtLnZlcnNpb24sIHRhcmJhbGw6IG0udGFyYmFsbCwgaW50ZWdyaXR5OiBtLmludGVncml0eSB9KSk7XG59XG5cbi8qIC0tLS0gXHU5NTVDXHU1MENGXHU0RTBFXHU1RTAzXHU1QzQwIC0tLS0gKi9cblxuY29uc3QgUkVHSVNUUllfSE9TVFMgPSAvXihodHRwcz86XFwvXFwvW14vXSspXFwvKC4qKSQvO1xuXG4vKipcbiAqIHRhcmJhbGwgXHU3Njg0XHU5NTVDXHU1MENGXHU1MDE5XHU5MDA5KFx1OTg3QVx1NUU4Rlx1NTM3M1x1NTZERVx1OTAwMFx1OTg3QVx1NUU4Rik6XHU1MzlGXHU1OUNCXHU1NzMwXHU1NzQwIFx1MjE5MiBcdTU0MDQgcmVnaXN0cnkgXHU1NDBDXHU4REVGXHU1Rjg0XHU2NTM5XHU1MTk5XHUzMDAyXG4gKiBwYWNrdW1lbnQgXHU5MUNDXHU3Njg0IGRpc3QudGFyYmFsbCBcdTYwNTJcdTYzMDdcdTU0MTFcdTUzRDFcdTVFMDNcdTZFOTAocmVnaXN0cnkubnBtanMub3JnKSxcdTU2RkRcdTUxODVcdTdGNTFcdTdFRENcbiAqIFx1NEUwRFx1NTNFRlx1OEZCRVx1NjVGNlx1NjMwOSByZWdpc3RyeSBcdTUyMTdcdTg4NjhcdTY1MzlcdTUxOTkgaG9zdChcdThERUZcdTVGODRcdTRFMERcdTUzRDggXHUyMDE0XHUyMDE0IG5wbW1pcnJvciBcdTRFMEUgbnBtanMgXHU1NDBDXHU2Nzg0KVx1MzAwMlxuICovXG5leHBvcnQgZnVuY3Rpb24gdGFyYmFsbE1pcnJvcnModGFyYmFsbDogc3RyaW5nLCByZWdpc3RyaWVzOiBzdHJpbmdbXSk6IHN0cmluZ1tdIHtcbiAgY29uc3QgbSA9IFJFR0lTVFJZX0hPU1RTLmV4ZWModGFyYmFsbCk7XG4gIGNvbnN0IHBhdGggPSBtPy5bMl0gPz8gJyc7XG4gIGNvbnN0IG91dCA9IFt0YXJiYWxsXTtcbiAgZm9yIChjb25zdCByZWcgb2YgcmVnaXN0cmllcykge1xuICAgIGNvbnN0IGJhc2UgPSByZWcucmVwbGFjZSgvXFwvKyQvLCAnJyk7XG4gICAgaWYgKGJhc2UgPT09IG0/LlsxXSkgY29udGludWU7XG4gICAgY29uc3QgdSA9IGAke2Jhc2V9LyR7cGF0aH1gO1xuICAgIGlmICghb3V0LmluY2x1ZGVzKHUpKSBvdXQucHVzaCh1KTtcbiAgfVxuICByZXR1cm4gb3V0O1xufVxuXG4vKiogXHU1MzA1XHU1NzI4IG5vZGVfbW9kdWxlcyBcdTRFMEJcdTc2ODRcdTc2RUVcdTY4MDdcdTc2RUVcdTVGNTUoc2NvcGVkIFx1NTMwNVx1NEZERFx1NjMwMSBAc2NvcGUvbmFtZSBcdTRFMjRcdTdFQTcpXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gbW9kdWxlRGlyKHByZWZpeDogc3RyaW5nLCBuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBwYXJ0cyA9IG5hbWUuc3BsaXQoJy8nKS5maWx0ZXIoKHApID0+IHAgIT09ICcnICYmIHAgIT09ICcuJyk7XG4gIGlmIChuYW1lLnN0YXJ0c1dpdGgoJ0AnKSAmJiBwYXJ0cy5sZW5ndGggIT09IDIpIHRocm93IG5ldyBFcnJvcihgaW52YWxpZCBwYWNrYWdlIG5hbWU6ICR7bmFtZX1gKTtcbiAgaWYgKCFuYW1lLnN0YXJ0c1dpdGgoJ0AnKSAmJiBwYXJ0cy5sZW5ndGggIT09IDEpIHRocm93IG5ldyBFcnJvcihgaW52YWxpZCBwYWNrYWdlIG5hbWU6ICR7bmFtZX1gKTtcbiAgcmV0dXJuIFsuLi5wYXJ0c10ucmVkdWNlKChkaXIsIHApID0+IGAke2Rpcn1cXFxcJHtwfWAsIGAke3ByZWZpeH1cXFxcbm9kZV9tb2R1bGVzYCk7XG59XG5cbi8qIC0tLS0gaW50ZWdyaXR5IC0tLS0gKi9cblxuLyoqIG5wbSBkaXN0LmludGVncml0eSgnc2hhNTEyLWJhc2U2NCcpIFx1NjgyMVx1OUE4QztcdTRFMERcdTUzMzlcdTkxNERcdThGRDRcdTU2REUgZmFsc2UoXHU2NzJBXHU3N0U1XHU3Qjk3XHU2Q0Q1XHU4RkQ0XHU1NkRFIHRydWUgXHU2NTNFXHU4ODRDKVx1MzAwMiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGludGVncml0eU9rKGRhdGE6IEJ1ZmZlciwgaW50ZWdyaXR5Pzogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGlmIChpbnRlZ3JpdHkgPT09IHVuZGVmaW5lZCB8fCBpbnRlZ3JpdHkgPT09ICcnKSByZXR1cm4gdHJ1ZTtcbiAgY29uc3QgbSA9IC9ec2hhNTEyLShbQS1aYS16MC05Ky89XSspJC8uZXhlYyhpbnRlZ3JpdHkudHJpbSgpKTtcbiAgaWYgKG0gPT09IG51bGwpIHJldHVybiB0cnVlO1xuICByZXR1cm4gY3JlYXRlSGFzaCgnc2hhNTEyJykudXBkYXRlKGRhdGEpLmRpZ2VzdCgnYmFzZTY0JykgPT09IG1bMV07XG59XG5cbi8qKiBcdTRFQkFcdTdDN0JcdTUzRUZcdThCRkJcdTVCNTdcdTgyODIoXHU1Qjg5XHU4OEM1XHU4RkRCXHU1RUE2XHU2NTg3XHU2ODQ4XHU3NTI4KVx1MzAwMiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJ5dGVzTGFiZWwobjogbnVtYmVyKTogc3RyaW5nIHtcbiAgaWYgKG4gPCAxMDI0KSByZXR1cm4gYCR7bn0gQmA7XG4gIGlmIChuIDwgMTAyNCAqIDEwMjQpIHJldHVybiBgJHsobiAvIDEwMjQpLnRvRml4ZWQoMCl9IEtCYDtcbiAgcmV0dXJuIGAkeyhuIC8gMTAyNCAvIDEwMjQpLnRvRml4ZWQoMSl9IE1CYDtcbn1cbiIsICIvKipcclxuICogXHU2NkY0XHU2NUIwXHU1NjY4XHU5MDFBXHU5MDUzXHU3RUFGXHU5MDNCXHU4RjkxKDIwMjYtMTAtMjkgXHU3NTI4XHU2MjM3XHU1M0NEXHU5OTg4XHU2ODM5XHU2Q0JCOlx1NTZGRFx1NTE4NVx1NzUyOFx1NjIzN1x1NjUzNlx1NEUwRFx1NTIzMFx1NjZGNFx1NjVCMFx1NjNBOFx1OTAwMTtcclxuICogXHU1NDBDXHU2NUU1XHU0RUZCXHU1MkExIDEzLUM6YXRvbWdpdCBcdTU2RkRcdTUxODVcdTk5OTZcdTkwMDlcdTkwMUFcdTkwNTMgKyBcdTU0MEVcdTUzRjBcdTk3NTlcdTlFRDhcdTY2RjRcdTY1QjApXHUzMDAyXHJcbiAqXHJcbiAqIFx1ODBDQ1x1NjY2RjpcdTY4QzBcdTY3RTVcdTkwMUFcdTkwNTNcdTUzOUZcdTY3MkNcdTUzRUFcdThENzAgYXBpLmdpdGh1Yi5jb20gXHU3NkY0XHU4RkRFKDE1cyBcdThEODVcdTY1RjYpLFx1NTZGRFx1NTE4NVx1NjVFMFx1NEVFM1x1NzQwNlx1N0Y1MVx1N0VEQ1x1NUZDNVxyXG4gKiBcdThEODVcdTY1RjYgXHUyMTkyIGNoZWNrIGZhaWxlZCBcdTIxOTIgXHU3NTI4XHU2MjM3XHU2QzM4XHU4RkRDXHU3NzBCXHU0RTBEXHU1MjMwXHU2NUIwXHU3MjQ4XHU2NzJDO1x1NEUwQlx1OEY3RFx1OTAxQVx1OTA1M1x1NTNDRFx1ODAwQ1x1NjcwOVx1OTU1Q1x1NTBDRlx1NTZERVx1OTAwMFx1OTRGRVx1MzAwMlxyXG4gKiBcdTY3MkNcdTZBMjFcdTU3NTdcdTdFRDlcdTUxRkFcdTdFQUZcdTg5QzRcdTUyMTkobWFpbiBcdThGREJcdTdBMEJcdTRFMEUgc2NyaXB0cy9zaW0tdXBkYXRlci5tanMgXHU1MTcxXHU3NTI4LFx1NTM1NVx1NkQ0Qlx1ODk4Nlx1NzZENik6XHJcbiAqICAxKSBcdTY4QzBcdTY3RTVcdTkwMUFcdTkwNTNcdTk0RkU6XHU3NkY0XHU4RkRFKDhzLFx1NTZGRFx1NTkxNlx1NzlEMlx1OEZDNylcdTIxOTIgYXRvbWdpdCB2NShcdTU2RkRcdTUxODVcdTc2RjRcdThGREUsXHU1MzNGXHU1NDBEXHU1QzBGXHU1NENEXHU1RTk0KVxyXG4gKiAgICAgXHUyMTkyIGdoLXByb3h5IFx1MjE5MiBnaGZhc3QsXHU5MDEwXHU0RTJBXHU4QkQ1XHU1MjMwXHU2MkZGXHU1MjMwIHJlbGVhc2U7XHJcbiAqICAyKSBcdTkwMUFcdTkwNTNcdTdDOThcdTYwMjc6XHU0RTBBXHU2QjIxXHU1NDdEXHU0RTJEXHU3Njg0XHU5MDFBXHU5MDUzXHU0RjE4XHU1MTQ4LFx1NTkzMVx1OEQyNVx1NTE4RFx1NTZERVx1OTAwMFx1NTE2OFx1OTRGRTtcclxuICogIDMpIFx1NEUwQlx1OEY3RFx1NTQwQ1x1NkU5MFx1NEYxOFx1NTE0ODpcdTRFMEVcdTU0N0RcdTRFMkRcdTc2ODRcdTY4QzBcdTY3RTVcdTkwMUFcdTkwNTNcdTU0MENcdTZFOTBcdTc2ODRcdTk1NUNcdTUwQ0ZcdTUxNDhcdThCRDUsXHU1MThEXHU3NkY0XHU4RkRFXHU0RTBFXHU1MTc2XHU0RjU5XHU5NTVDXHU1MENGO1xyXG4gKiAgICAgYXRvbWdpdCBcdTU0N0RcdTRFMkQgXHUyMTkyIGF0b21naXQgXHU4RDQ0XHU0RUE3XHU3NkY0XHU5NEZFIC8gQVBJIFx1N0FFRlx1NzBCOVx1NEYxOFx1NTE0OCxHaXRIdWIgXHU0RTNCXHU0RUQzXHU5NTVDXHU1MENGXHU1MTVDXHU1RTk1XHUzMDAyXHJcbiAqIFx1NjVFMCBlbGVjdHJvbiBcdTRGOURcdThENTYoXHU1M0VGXHU4OEFCIG5vZGUgLS1pbXBvcnQgdHN4IFx1NzY4NFx1NkQ0Qlx1OEJENS9cdTZBMjFcdTYyREZcdTgxMUFcdTY3MkNcdTc2RjRcdTYzQTUgaW1wb3J0KVx1MzAwMlxyXG4gKi9cclxuXHJcbmV4cG9ydCB0eXBlIFVwZGF0ZUNoYW5uZWxJZCA9ICdkaXJlY3QnIHwgJ2F0b21naXQnIHwgJ2doLXByb3h5JyB8ICdnaGZhc3QnO1xyXG5cclxuLyoqIFx1NTNDQ1x1NEVEM1x1NjYyMFx1NUMwNDpHaXRIdWIgXHU0RTNCXHU0RUQzXHU0RTBFIGF0b21naXQgXHU5NTVDXHU1MENGXHU0RUQzIG93bmVyIFx1NEUwRFx1NTQwQyhzd3NnYmwgdnMgaG9uZ2Z1KSxcclxuICogIFx1OTAxQVx1OTA1M1x1NTQwNFx1ODFFQVx1NTNENlx1ODFFQVx1NURGMVx1NzY4NFx1NEVEMyhcdTUzRUZcdTg4QUIgVVBEQVRFX1JFUE8gLyBVUERBVEVfUkVQT19BVE9NR0lUIFx1ODk4Nlx1NzZENilcdTMwMDIgKi9cclxuZXhwb3J0IGludGVyZmFjZSBVcGRhdGVSZXBvcyB7IGdpdGh1Yjogc3RyaW5nOyBhdG9tZ2l0OiBzdHJpbmcgfVxyXG5cclxuZXhwb3J0IGludGVyZmFjZSBDaGVja0NoYW5uZWwge1xyXG4gIGlkOiBVcGRhdGVDaGFubmVsSWQ7XHJcbiAgLyoqIFx1OEJDQVx1NjVBRC9VSSBcdTY2M0VcdTc5M0FcdTU0MEQoXHU5NTE5XHU4QkVGXHU0RkUxXHU2MDZGXHU5MUNDXHU5MDEwXHU5MDFBXHU5MDUzXHU1M0VGXHU4OUMxKVx1MzAwMiAqL1xyXG4gIGxhYmVsOiBzdHJpbmc7XHJcbiAgLyoqIFx1NTM1NVx1OTAxQVx1OTA1M1x1OEQ4NVx1NjVGNjpcdTc2RjRcdThGREUgOHMoXHU1NkZEXHU1OTE2XHU3OUQyXHU4RkM3XHUzMDAxXHU1NkZEXHU1MTg1XHU1RkVCXHU5MDFGXHU4QkE5XHU0RjREXHU5NTVDXHU1MENGKSxhdG9tZ2l0L1x1OTU1Q1x1NTBDRiAxMHNcdTMwMDIgKi9cclxuICB0aW1lb3V0TXM6IG51bWJlcjtcclxuICBhcGlVcmw6IChyZXBvczogVXBkYXRlUmVwb3MpID0+IHN0cmluZztcclxuICAvKiogXHU0RTBCXHU4RjdEXHU5NTVDXHU1MENGXHU1MjREXHU3RjAwKCcnID0gXHU3NkY0XHU4RkRFIGFzc2V0IHVybCk7XHU5ODdCXHU1NzI4IERPV05MT0FEX01JUlJPUl9QUkVGSVhFUyBcdTZFMDVcdTUzNTVcdTUxODVcdTMwMDIgKi9cclxuICBkb3dubG9hZFByZWZpeDogc3RyaW5nO1xyXG59XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIFJlbGVhc2VBc3NldCB7IG5hbWU6IHN0cmluZzsgYnJvd3Nlcl9kb3dubG9hZF91cmw6IHN0cmluZzsgc2l6ZTogbnVtYmVyIH1cclxuZXhwb3J0IGludGVyZmFjZSBMYXRlc3RSZWxlYXNlIHsgdGFnX25hbWU6IHN0cmluZzsgYm9keT86IHN0cmluZzsgYXNzZXRzPzogUmVsZWFzZUFzc2V0W10gfVxyXG5cclxuY29uc3QgZ2l0aHViTGF0ZXN0ID0gKHJlcG86IHN0cmluZyk6IHN0cmluZyA9PiBgaHR0cHM6Ly9hcGkuZ2l0aHViLmNvbS9yZXBvcy8ke3JlcG99L3JlbGVhc2VzL2xhdGVzdGA7XHJcblxyXG4vKiogXHU2OEMwXHU2N0U1XHU5MDFBXHU5MDUzXHU5NEZFKFx1OUVEOFx1OEJBNFx1OTg3QVx1NUU4RjpcdTc2RjRcdThGREUgXHUyMTkyIGF0b21naXQoXHU1NkZEXHU1MTg1XHU5OTk2XHU5MDA5KVx1MjE5MiBnaC1wcm94eSBcdTIxOTIgZ2hmYXN0KVx1MzAwMiAqL1xyXG5leHBvcnQgY29uc3QgQ0hFQ0tfQ0hBTk5FTFM6IHJlYWRvbmx5IENoZWNrQ2hhbm5lbFtdID0gW1xyXG4gIHsgaWQ6ICdkaXJlY3QnLCBsYWJlbDogJ1x1NzZGNFx1OEZERScsIHRpbWVvdXRNczogOF8wMDAsIGFwaVVybDogKHIpID0+IGdpdGh1YkxhdGVzdChyLmdpdGh1YiksIGRvd25sb2FkUHJlZml4OiAnJyB9LFxyXG4gIHsgaWQ6ICdhdG9tZ2l0JywgbGFiZWw6ICdhdG9tZ2l0KFx1NTZGRFx1NTE4NSknLCB0aW1lb3V0TXM6IDEwXzAwMCwgYXBpVXJsOiAocikgPT4gYGh0dHBzOi8vYXBpLmF0b21naXQuY29tL2FwaS92NS9yZXBvcy8ke3IuYXRvbWdpdH0vcmVsZWFzZXM/cGVyX3BhZ2U9NSZkaXJlY3Rpb249ZGVzY2AsIGRvd25sb2FkUHJlZml4OiAnJyB9LFxyXG4gIHsgaWQ6ICdnaC1wcm94eScsIGxhYmVsOiAnZ2gtcHJveHknLCB0aW1lb3V0TXM6IDEwXzAwMCwgYXBpVXJsOiAocikgPT4gYGh0dHBzOi8vZ2gtcHJveHkuY29tLyR7Z2l0aHViTGF0ZXN0KHIuZ2l0aHViKX1gLCBkb3dubG9hZFByZWZpeDogJ2h0dHBzOi8vZ2gtcHJveHkuY29tLycgfSxcclxuICB7IGlkOiAnZ2hmYXN0JywgbGFiZWw6ICdnaGZhc3QnLCB0aW1lb3V0TXM6IDEwXzAwMCwgYXBpVXJsOiAocikgPT4gYGh0dHBzOi8vZ2hmYXN0LnRvcC8ke2dpdGh1YkxhdGVzdChyLmdpdGh1Yil9YCwgZG93bmxvYWRQcmVmaXg6ICdodHRwczovL2doZmFzdC50b3AvJyB9LFxyXG5dO1xyXG5cclxuLyoqIFx1NEUwQlx1OEY3RFx1OTU1Q1x1NTBDRlx1NTE2OFx1NkUwNVx1NTM1NShcdTlFRDhcdThCQTRcdTk4N0FcdTVFOEY7Z2hwcm94eS5jbiBcdTRFQzVcdTRFMEJcdThGN0RcdTUxNUNcdTVFOTUsXHU0RTBEXHU1MDVBXHU2OEMwXHU2N0U1XHU5MDFBXHU5MDUzKVx1MzAwMiAqL1xyXG5leHBvcnQgY29uc3QgRE9XTkxPQURfTUlSUk9SX1BSRUZJWEVTOiByZWFkb25seSBzdHJpbmdbXSA9IFsnJywgJ2h0dHBzOi8vZ2hmYXN0LnRvcC8nLCAnaHR0cHM6Ly9naC1wcm94eS5jb20vJywgJ2h0dHBzOi8vZ2hwcm94eS5jbi8nXTtcclxuXHJcbi8qKiBcdTVCNThcdTUwQThcdTUwM0MvSVBDIFx1NTAzQ1x1NUY1Mlx1NEUwMDpcdTU0MDhcdTZDRDVcdTkwMUFcdTkwNTMgaWQgXHU2MjE2IG51bGwoXHU3Qzk4XHU2MDI3XHU2NTg3XHU0RUY2XHU2MzVGXHU1NzRGL1x1NjVFN1x1NzI0OFx1NjcyQ1x1NkI4Qlx1NzU1OVx1NjVGNlx1NEUwRFx1ODFGNFx1NTQ3RClcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZUNoYW5uZWwodjogdW5rbm93bik6IFVwZGF0ZUNoYW5uZWxJZCB8IG51bGwge1xyXG4gIHJldHVybiB0eXBlb2YgdiA9PT0gJ3N0cmluZycgJiYgQ0hFQ0tfQ0hBTk5FTFMuc29tZSgoYykgPT4gYy5pZCA9PT0gdikgPyAodiBhcyBVcGRhdGVDaGFubmVsSWQpIDogbnVsbDtcclxufVxyXG5cclxuLyoqIFx1N0M5OFx1NjAyN1x1NjM5Mlx1NUU4RjpcdTRFMEFcdTZCMjFcdTU0N0RcdTRFMkRcdTkwMUFcdTkwNTNcdTRGMThcdTUxNDgsXHU1MTc2XHU0RjU5XHU0RkREXHU2MzAxXHU5RUQ4XHU4QkE0XHU5NEZFXHU1RThGKFx1NEVGQlx1NEUwMFx1OTAxQVx1OTA1M1x1NTkzMVx1OEQyNVx1NEVDRFx1NTNFRlx1NTE2OFx1OTRGRVx1NTZERVx1OTAwMClcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIG9yZGVyZWRDaGVja0NoYW5uZWxzKHN0aWNreTogdW5rbm93bik6IHJlYWRvbmx5IENoZWNrQ2hhbm5lbFtdIHtcclxuICBjb25zdCBzID0gbm9ybWFsaXplQ2hhbm5lbChzdGlja3kpO1xyXG4gIGNvbnN0IGZpcnN0ID0gcyA9PT0gbnVsbCA/IHVuZGVmaW5lZCA6IENIRUNLX0NIQU5ORUxTLmZpbmQoKGMpID0+IGMuaWQgPT09IHMpO1xyXG4gIGlmIChmaXJzdCA9PT0gdW5kZWZpbmVkKSByZXR1cm4gQ0hFQ0tfQ0hBTk5FTFM7XHJcbiAgcmV0dXJuIFtmaXJzdCwgLi4uQ0hFQ0tfQ0hBTk5FTFMuZmlsdGVyKChjKSA9PiBjLmlkICE9PSBzKV07XHJcbn1cclxuXHJcbi8qKiBcdTRFMEJcdThGN0RcdTk1NUNcdTUwQ0ZcdTk4N0FcdTVFOEY6XHU1NDdEXHU0RTJEXHU2OEMwXHU2N0U1XHU5MDFBXHU5MDUzXHU3Njg0XHU1NDBDXHU2RTkwXHU5NTVDXHU1MENGXHU0RjE4XHU1MTQ4IFx1MjE5MiBcdTc2RjRcdThGREUgXHUyMTkyIFx1NTE3Nlx1NEY1OVx1OTU1Q1x1NTBDRihcdTUzQkJcdTkxQ0QsNCBcdTkwMUFcdTkwNTNcdTZFMDVcdTUzNTVcdTRGRERcdTc1NTkpXHUzMDAyICovXHJcbmV4cG9ydCBmdW5jdGlvbiBvcmRlcmVkRG93bmxvYWRNaXJyb3JzKGFzc2V0VXJsOiBzdHJpbmcsIGNoYW5uZWw6IHVua25vd24pOiByZWFkb25seSBzdHJpbmdbXSB7XHJcbiAgY29uc3QgaGl0ID0gbm9ybWFsaXplQ2hhbm5lbChjaGFubmVsKTtcclxuICBjb25zdCBwcmVmaXggPSBoaXQgPT09IG51bGwgPyAnJyA6IENIRUNLX0NIQU5ORUxTLmZpbmQoKGMpID0+IGMuaWQgPT09IGhpdCk/LmRvd25sb2FkUHJlZml4ID8/ICcnO1xyXG4gIGNvbnN0IHByZWZpeGVzID0gWy4uLm5ldyBTZXQoW3ByZWZpeCwgLi4uRE9XTkxPQURfTUlSUk9SX1BSRUZJWEVTXSldO1xyXG4gIHJldHVybiBwcmVmaXhlcy5tYXAoKHApID0+IChwID09PSAnJyA/IGFzc2V0VXJsIDogYCR7cH0ke2Fzc2V0VXJsfWApKTtcclxufVxyXG5cclxuLyoqIFx1OEJFRFx1NEU0OVx1NzI0OFx1NjcyQ1x1NkJENFx1OEY4MygndicgXHU1MjREXHU3RjAwXHU1M0VGXHU5MDA5LFx1NjMwOSAuIFx1NTIwNlx1NkJCNVx1NjU3MFx1NTAzQ1x1NkJENDtcdTRFMERcdThEQjNcdTRFMDlcdTZCQjVcdTg4NjUgMClcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGNtcFZlcnNpb24oYTogc3RyaW5nLCBiOiBzdHJpbmcpOiBudW1iZXIge1xyXG4gIGNvbnN0IHBhID0gYS5yZXBsYWNlKC9edi8sICcnKS5zcGxpdCgnLicpLm1hcChOdW1iZXIpO1xyXG4gIGNvbnN0IHBiID0gYi5yZXBsYWNlKC9edi8sICcnKS5zcGxpdCgnLicpLm1hcChOdW1iZXIpO1xyXG4gIGZvciAobGV0IGkgPSAwOyBpIDwgMzsgaSsrKSB7XHJcbiAgICBpZiAoKHBhW2ldID8/IDApICE9PSAocGJbaV0gPz8gMCkpIHJldHVybiAocGFbaV0gPz8gMCkgPCAocGJbaV0gPz8gMCkgPyAtMSA6IDE7XHJcbiAgfVxyXG4gIHJldHVybiAwO1xyXG59XHJcblxyXG4vKiogXHU1NENEXHU1RTk0XHU1RjUyXHU0RTAwOkdpdEh1YiAvcmVsZWFzZXMvbGF0ZXN0IFx1OEZENFx1NTZERVx1NUJGOVx1OEM2MSxhdG9tZ2l0IC9yZWxlYXNlcyBcdThGRDRcdTU2REVcdTY1NzBcdTdFQzRcdTMwMDJcclxuICogIGF0b21naXQgXHU1MjE3XHU4ODY4XHU2MzA5IGNyZWF0ZWRfYXQgXHU2MzkyXHU1RThGXHUzMDAxXHU5OTk2XHU0RTJBXHU1MTQzXHU3RDIwXHU0RTBEXHU0RkREXHU4QkMxXHU2NjJGXHU2NzAwXHU2NUIwIHRhZyhcdTVCOUVcdTZENEIgdjAuMi44IFx1NUVGQVxyXG4gKiAgXHU1Rjk3XHU2QkQ0IHYwLjIuOSBcdTY2NUFcdTgwMENcdTYzOTJcdTdCMkNcdTRFMDApXHUyMTkyIFx1NUJBMlx1NjIzN1x1N0FFRlx1NjMwOVx1OEJFRFx1NEU0OVx1NzI0OFx1NjcyQ1x1NjMxMSB0YWcgXHU2NzAwXHU1OTI3XHU3Njg0IHJlbGVhc2VcdTMwMDJ0YWcgXHU3RjNBXHU1OTMxL1xyXG4gKiAgXHU1RjYyXHU3MkI2XHU0RTBEXHU1QkY5XHU4RkQ0XHU1NkRFIG51bGwoXHU2MzA5XHU2NzJDXHU5MDFBXHU5MDUzXHU1OTMxXHU4RDI1XHU1NkRFXHU5MDAwXHU0RTBCXHU0RTAwXHU5MDFBXHU5MDUzKVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplUmVsZWFzZShqc29uOiB1bmtub3duKTogTGF0ZXN0UmVsZWFzZSB8IG51bGwge1xyXG4gIGxldCBiZXN0OiBMYXRlc3RSZWxlYXNlIHwgbnVsbCA9IG51bGw7XHJcbiAgZm9yIChjb25zdCByZWwgb2YgQXJyYXkuaXNBcnJheShqc29uKSA/IGpzb24gOiBbanNvbl0pIHtcclxuICAgIGlmICh0eXBlb2YgcmVsICE9PSAnb2JqZWN0JyB8fCByZWwgPT09IG51bGwpIGNvbnRpbnVlO1xyXG4gICAgY29uc3QgciA9IHJlbCBhcyB7IHRhZ19uYW1lPzogdW5rbm93bjsgYm9keT86IHVua25vd247IGFzc2V0cz86IHVua25vd24gfTtcclxuICAgIGlmICh0eXBlb2Ygci50YWdfbmFtZSAhPT0gJ3N0cmluZycgfHwgci50YWdfbmFtZSA9PT0gJycpIGNvbnRpbnVlO1xyXG4gICAgY29uc3QgYXNzZXRzOiBSZWxlYXNlQXNzZXRbXSA9IEFycmF5LmlzQXJyYXkoci5hc3NldHMpXHJcbiAgICAgID8gci5hc3NldHMuZmxhdE1hcCgoYSk6IFJlbGVhc2VBc3NldFtdID0+IHtcclxuICAgICAgICAgIGNvbnN0IHggPSBhIGFzIHsgbmFtZT86IHVua25vd247IGJyb3dzZXJfZG93bmxvYWRfdXJsPzogdW5rbm93bjsgc2l6ZT86IHVua25vd24gfTtcclxuICAgICAgICAgIHJldHVybiB0eXBlb2YgeC5uYW1lID09PSAnc3RyaW5nJyAmJiB0eXBlb2YgeC5icm93c2VyX2Rvd25sb2FkX3VybCA9PT0gJ3N0cmluZydcclxuICAgICAgICAgICAgPyBbeyBuYW1lOiB4Lm5hbWUsIGJyb3dzZXJfZG93bmxvYWRfdXJsOiB4LmJyb3dzZXJfZG93bmxvYWRfdXJsLCBzaXplOiB0eXBlb2YgeC5zaXplID09PSAnbnVtYmVyJyA/IHguc2l6ZSA6IDAgfV1cclxuICAgICAgICAgICAgOiBbXTtcclxuICAgICAgICB9KVxyXG4gICAgICA6IFtdO1xyXG4gICAgY29uc3QgY3VyOiBMYXRlc3RSZWxlYXNlID0geyB0YWdfbmFtZTogci50YWdfbmFtZSwgYm9keTogdHlwZW9mIHIuYm9keSA9PT0gJ3N0cmluZycgPyByLmJvZHkgOiAnJywgYXNzZXRzIH07XHJcbiAgICBpZiAoYmVzdCA9PT0gbnVsbCB8fCBjbXBWZXJzaW9uKGN1ci50YWdfbmFtZSwgYmVzdC50YWdfbmFtZSkgPiAwKSBiZXN0ID0gY3VyO1xyXG4gIH1cclxuICByZXR1cm4gYmVzdDtcclxufVxyXG5cclxuLyoqIFx1NEVDRSByZWxlYXNlIFx1OEQ0NFx1NEVBN1x1NjMxMVx1NUI4OVx1ODhDNVx1NTMwNTpITUgtRGVza3RvcC1TZXR1cC0qLmV4ZSBcdTdDQkVcdTc4NkVcdTUzMzlcdTkxNEQsXHU1MTVDXHU1RTk1XHU0RUZCXHU2MTBGIC5leGVcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHBpY2tJbnN0YWxsZXJBc3NldChhc3NldHM6IHJlYWRvbmx5IFJlbGVhc2VBc3NldFtdKTogUmVsZWFzZUFzc2V0IHwgbnVsbCB7XHJcbiAgcmV0dXJuIGFzc2V0cy5maW5kKChhKSA9PiAvXkhNSC1EZXNrdG9wLVNldHVwLS4qXFwuZXhlJC9pLnRlc3QoYS5uYW1lKSlcclxuICAgID8/IGFzc2V0cy5maW5kKChhKSA9PiBhLm5hbWUudG9Mb3dlckNhc2UoKS5lbmRzV2l0aCgnLmV4ZScpKVxyXG4gICAgPz8gbnVsbDtcclxufVxyXG5cclxuLyoqIGF0b21naXQgQVBJIFx1NEUwQlx1OEY3RFx1N0FFRlx1NzBCOShhZy1jbGkgcmVsZWFzZV9hc3NldHMuZ28gXHU1NDBDXHU1RjYyOnRhZyArIFx1NjU4N1x1NEVGNlx1NTQwRClcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGF0b21naXRBcGlEb3dubG9hZFVybChyZXBvczogVXBkYXRlUmVwb3MsIHRhZzogc3RyaW5nLCBhc3NldE5hbWU6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgcmV0dXJuIGBodHRwczovL2FwaS5hdG9tZ2l0LmNvbS9hcGkvdjUvcmVwb3MvJHtyZXBvcy5hdG9tZ2l0fS9yZWxlYXNlcy8ke3RhZ30vYXR0YWNoX2ZpbGVzLyR7ZW5jb2RlVVJJQ29tcG9uZW50KGFzc2V0TmFtZSl9L2Rvd25sb2FkYDtcclxufVxyXG5cclxuLyoqIFx1NEUwQlx1OEY3RFx1NTAxOVx1OTAwOVx1OTRGRTphdG9tZ2l0IFx1NTQ3RFx1NEUyRChcdTYyMTZcdThENDRcdTRFQTcgVVJMIFx1NjcyQ1x1NUMzMVx1NTcyOCBhdG9tZ2l0LmNvbSlcdTIxOTIgYXRvbWdpdCBcdThENDRcdTRFQTdcdTc2RjRcdTk0RkVcdTMwMDFcclxuICogIGF0b21naXQgQVBJIFx1N0FFRlx1NzBCOVx1NEYxOFx1NTE0OCxcdTUxOERcdTYyRkMgR2l0SHViIFx1NEUzQlx1NEVEM1x1NTQwQyB0YWcgXHU1NDBDXHU1NDBEXHU4RDQ0XHU0RUE3XHU3Njg0XHU5NTVDXHU1MENGXHU5NEZFXHU1MTVDXHU1RTk1KGF0b21naXRcclxuICogIDMwMiBcdTIxOTIgQ0ROIFx1N0I3RVx1NTQwRFx1NzZGNFx1OTRGRSxcdTUzM0ZcdTU0MERcdTUzRUZcdTRFMEJcdTMwMDFcdTY1RTBcdTk3MDAgUmVmZXJlcik7R2l0SHViIFx1NTQ3RFx1NEUyRCBcdTIxOTIgXHU2NUUyXHU2NzA5XHU5NTVDXHU1MENGXHU5NEZFXHUzMDAyICovXHJcbmV4cG9ydCBmdW5jdGlvbiBkb3dubG9hZENhbmRpZGF0ZXMoaW5wdXQ6IHsgY2hhbm5lbDogdW5rbm93bjsgdGFnOiBzdHJpbmc7IGFzc2V0VXJsOiBzdHJpbmc7IGFzc2V0TmFtZTogc3RyaW5nOyByZXBvczogVXBkYXRlUmVwb3MgfSk6IHJlYWRvbmx5IHN0cmluZ1tdIHtcclxuICBjb25zdCB7IGNoYW5uZWwsIHRhZywgYXNzZXRVcmwsIGFzc2V0TmFtZSwgcmVwb3MgfSA9IGlucHV0O1xyXG4gIGxldCBvbkF0b21naXQgPSBub3JtYWxpemVDaGFubmVsKGNoYW5uZWwpID09PSAnYXRvbWdpdCc7XHJcbiAgdHJ5IHsgaWYgKG5ldyBVUkwoYXNzZXRVcmwpLmhvc3RuYW1lID09PSAnYXRvbWdpdC5jb20nKSBvbkF0b21naXQgPSB0cnVlOyB9IGNhdGNoIHsgLyogXHU2NUUwXHU2NTQ4IFVSTCBcdTYzMDlcdTkwMUFcdTkwNTNcdTUyMjRcdTVCOUEgKi8gfVxyXG4gIGlmIChvbkF0b21naXQpIHtcclxuICAgIGNvbnN0IGdpdGh1YkFzc2V0VXJsID0gYGh0dHBzOi8vZ2l0aHViLmNvbS8ke3JlcG9zLmdpdGh1Yn0vcmVsZWFzZXMvZG93bmxvYWQvJHt0YWd9LyR7YXNzZXROYW1lfWA7XHJcbiAgICByZXR1cm4gWy4uLm5ldyBTZXQoW2Fzc2V0VXJsLCBhdG9tZ2l0QXBpRG93bmxvYWRVcmwocmVwb3MsIHRhZywgYXNzZXROYW1lKSwgLi4ub3JkZXJlZERvd25sb2FkTWlycm9ycyhnaXRodWJBc3NldFVybCwgY2hhbm5lbCldKV07XHJcbiAgfVxyXG4gIHJldHVybiBvcmRlcmVkRG93bmxvYWRNaXJyb3JzKGFzc2V0VXJsLCBjaGFubmVsKTtcclxufVxyXG5cclxuLyoqIFx1NEUwQlx1OEY3RFx1NjgyMVx1OUE4QzpcdTUxNDNcdTY1NzBcdTYzNkUgc2l6ZT4wIFx1NjVGNlx1OTg3Qlx1NEUwRVx1ODQzRFx1NzZEOFx1NUI1N1x1ODI4Mlx1NEUwMFx1ODFGNChhdG9tZ2l0IFx1NEYyMFx1OEY5M1x1NTNFRlx1OTc2MFx1NjAyN1x1OTk5Nlx1OUE4QyxcclxuICogIEdpdEh1YiBcdThENDRcdTRFQTdcdTUxNDNcdTY1NzBcdTYzNkVcdTU0MENcdTY4MzdcdTVFMjYgc2l6ZSxcdTk4N0FcdTVFMjZcdTRFMDBcdThENzdcdTRGRERcdTc3MUYpXHUzMDAyICovXHJcbmV4cG9ydCBmdW5jdGlvbiBzaXplTWF0Y2hlcyhtZXRhU2l6ZTogbnVtYmVyLCBhY3R1YWxCeXRlczogbnVtYmVyKTogYm9vbGVhbiB7XHJcbiAgcmV0dXJuICEobWV0YVNpemUgPiAwKSB8fCBtZXRhU2l6ZSA9PT0gYWN0dWFsQnl0ZXM7XHJcbn1cclxuXHJcbi8qKiBcdTUxNjhcdTkwMUFcdTkwNTNcdTU5MzFcdThEMjVcdTc2ODRcdTk1MTlcdThCRUZcdTRFMzI6XHU5MDEwXHU5MDFBXHU5MDUzXHU1MjE3XHU1MUZBXHU1MzlGXHU1NkUwKFx1N0Y1MVx1N0VEQ1x1OEJDQVx1NjVBRFx1NzUyODtVSSBcdTY2RjRcdTY1QjBcdTk3NjJcdTY3N0ZcdTcxNjdcdTVFMzhcdTY2M0VcdTc5M0EpXHUzMDAyICovXHJcbmV4cG9ydCBmdW5jdGlvbiBzdW1tYXJpemVDaGVja0ZhaWx1cmVzKGZhaWx1cmVzOiBSZWFkb25seUFycmF5PHsgbGFiZWw6IHN0cmluZzsgcmVhc29uOiBzdHJpbmcgfT4pOiBzdHJpbmcge1xyXG4gIHJldHVybiBmYWlsdXJlcy5tYXAoKGYpID0+IGAke2YubGFiZWx9OiR7Zi5yZWFzb259YCkuam9pbignOyAnKTtcclxufVxyXG4iLCAiLyoqXHJcbiAqIFx1NEVEM1x1NUU5M1x1OTc2Mlx1Njc3Rlx1NTQwRVx1N0FFRihcdTRFRkJcdTUyQTEgMTQtQilcdTIwMTRcdTIwMTQgR2l0SHViL0F0b21HaXQgXHU1M0NDXHU1RTczXHU1M0YwIGdoL2FnIENMSSBcdTc2ODQgbWFpbiBcdThGREJcdTdBMEJcdTVDMDFcdTg4QzVcdTMwMDJcclxuICpcclxuICogXHU1Qjg5XHU1MTY4XHU0RTBEXHU1M0Q4XHU5MUNGKFx1NUYwMFx1NTNEMVx1OEJBMVx1NTIxMiBNMCBcdTUxRkFcdTUzRTNcdTk1RThcdTU0MENcdTZFOTApOlxyXG4gKiAgLSByZW5kZXJlciBcdTZDMzhcdTRFMEQgc3Bhd246XHU2MjQwXHU2NzA5XHU4QzAzXHU3NTI4XHU4RDcwIGluZGV4LnRzIFx1NkNFOFx1NTE4Q1x1NzY4NCBJUEMgXHU3NjdEXHU1NDBEXHU1MzU1LFx1OTAxMFx1NjVCOVx1NkNENVx1NjgyMVx1OUE4Q1x1NTNDMlx1NjU3MDtcclxuICogIC0gaG9zdCBcdTUzRUFcdThCQTQgJ2dpdGh1Yid8J2F0b21naXQnLHJlcG8gXHU1M0VBXHU4QkE0IG93bmVyL25hbWUgXHU1RjYyXHU2MDAxLHN0YXRlIFx1NTNFQVx1OEJBNCBvcGVufGNsb3NlZHxhbGw7XHJcbiAqICAtIFx1NzY3Qlx1NUY1NVx1N0VERFx1NEUwRFx1NjM1NVx1ODNCNy9cdTVCNThcdTUwQThcdTRFRTRcdTcyNEM6XHU1M0VBIHNwYXduIFx1NUI5OFx1NjVCOSBDTEkgXHU3Njg0XHU2RDRGXHU4OUM4XHU1NjY4IE9BdXRoIFx1NkQ0MVx1N0EwQixcdThGNkNcdTUzRDFcdTUxNzYgc3Rkb3V0XHJcbiAqICAgIFx1ODg0Q1x1N0VEOSByZW5kZXJlciBcdTVDNTVcdTc5M0EgVVJML1x1OEJCRVx1NTkwN1x1NzgwMSxcdTVFNzZcdTU5MTZcdTVGMDBcdTdDRkJcdTdFREZcdTZENEZcdTg5QzhcdTU2Njg7XHU0RUU0XHU3MjRDXHU1M0VBXHU4NDNEIENMSSBcdTgxRUFcdTVERjFcdTc2ODRcdTUxRURcdTYzNkVcdTVFOTM7XHJcbiAqICAtIFx1NjI0MFx1NjcwOVx1NTQ3RFx1NEVFNCA2MHMgXHU4RDg1XHU2NUY2KFx1NzY3Qlx1NUY1NVx1NjUzRVx1NUJCRFx1NTIzMCAzIFx1NTIwNlx1OTQ5RixcdTdCNDlcdTc1MjhcdTYyMzdcdTU3MjhcdTZENEZcdTg5QzhcdTU2NjhcdTVCOENcdTYyMTApO1xyXG4gKiAgLSBcdTk1MTlcdThCRUZcdTVGNTJcdTRFMDAgeyBvazpmYWxzZSwgY29kZSwgZXJyb3IgfSxlcnJvciBcdTYyMkFcdTY1QURcdTk2MzJcdTY1RTVcdTVGRDdcdTZEMkFcdTZDREJcdTMwMDJcclxuICpcclxuICogXHU0RTBFIDE0LUEoaG1oYXJuZXNzIGZvcmdlXyogXHU1REU1XHU1MTc3KVx1NEU5Mlx1OTAxQTpyZW5kZXJlciBcdTc2ODRcIlx1OEJBOSBobWggXHU1OTA0XHU3NDA2XCJcdTYyOEFcdTRFRDNcdTVFOTNcdTRFMEFcdTRFMEJcdTY1ODdcclxuICogXHU1ODZCXHU4RkRCIGNvbXBvc2VyLFx1NzUzMSBhZ2VudCBcdTRGQTdcdTVERTVcdTUxNzdcdTYzQTVcdTYyNEI7XHU2NzJDXHU2NTg3XHU0RUY2XHU1M0VBXHU2NzBEXHU1MkExXHU5NzYyXHU2NzdGXHU4MUVBXHU4RUFCXHU3Njg0XHU1MzczXHU2NUY2XHU3NkY0XHU2NENEXHU0RjVDXHUzMDAyXHJcbiAqL1xyXG5pbXBvcnQgeyBzcGF3biwgZXhlY0ZpbGVTeW5jIH0gZnJvbSAnbm9kZTpjaGlsZF9wcm9jZXNzJztcclxuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jIH0gZnJvbSAnbm9kZTpmcyc7XHJcbmltcG9ydCB7IGhvbWVkaXIgfSBmcm9tICdub2RlOm9zJztcclxuaW1wb3J0IHsgaXNBYnNvbHV0ZSwgam9pbiwgZGlybmFtZSwgc2VwIH0gZnJvbSAnbm9kZTpwYXRoJztcclxuXHJcbmV4cG9ydCB0eXBlIEZvcmdlSG9zdCA9ICdnaXRodWInIHwgJ2F0b21naXQnO1xyXG5cclxuZXhwb3J0IGludGVyZmFjZSBGb3JnZUhvc3RTdGF0dXMgeyBpbnN0YWxsZWQ6IGJvb2xlYW47IGxvZ2dlZDogYm9vbGVhbjsgdXNlcjogc3RyaW5nIH1cclxuZXhwb3J0IGludGVyZmFjZSBGb3JnZVN0YXR1cyB7IGdpdGh1YjogRm9yZ2VIb3N0U3RhdHVzOyBhdG9tZ2l0OiBGb3JnZUhvc3RTdGF0dXMgfVxyXG5leHBvcnQgaW50ZXJmYWNlIEZvcmdlUmVwbyB7IG5hbWU6IHN0cmluZzsgZnVsbE5hbWU6IHN0cmluZzsgaXNQcml2YXRlOiBib29sZWFuOyB1cGRhdGVkQXQ6IHN0cmluZzsgdXJsOiBzdHJpbmc7IGRlc2NyaXB0aW9uOiBzdHJpbmcgfVxyXG5leHBvcnQgaW50ZXJmYWNlIEZvcmdlUHIgeyBudW1iZXI6IHN0cmluZzsgdGl0bGU6IHN0cmluZzsgc3RhdGU6IHN0cmluZzsgaXNEcmFmdDogYm9vbGVhbjsgdXBkYXRlZEF0OiBzdHJpbmc7IHVybDogc3RyaW5nIH1cclxuZXhwb3J0IGludGVyZmFjZSBGb3JnZUlzc3VlIHsgbnVtYmVyOiBzdHJpbmc7IHRpdGxlOiBzdHJpbmc7IHN0YXRlOiBzdHJpbmc7IHVwZGF0ZWRBdDogc3RyaW5nOyB1cmw6IHN0cmluZyB9XHJcbmV4cG9ydCBpbnRlcmZhY2UgRm9yZ2VSZWxlYXNlIHsgdGFnOiBzdHJpbmc7IG5hbWU6IHN0cmluZzsgY3JlYXRlZEF0OiBzdHJpbmc7IGlzRHJhZnQ6IGJvb2xlYW47IGlzUHJlcmVsZWFzZTogYm9vbGVhbiB9XHJcbmV4cG9ydCBpbnRlcmZhY2UgRm9yZ2VDbGlSZXN1bHQgeyBjb2RlOiBudW1iZXIgfCBudWxsOyBzdGRvdXQ6IHN0cmluZzsgc3RkZXJyOiBzdHJpbmc7IHRpbWVkT3V0OiBib29sZWFuIH1cclxuZXhwb3J0IHR5cGUgRm9yZ2VPazxUPiA9IHsgb2s6IHRydWU7IGRhdGE6IFQgfSB8IHsgb2s6IGZhbHNlOyBjb2RlOiBzdHJpbmc7IGVycm9yOiBzdHJpbmcgfVxyXG5cclxuLyoqIFx1NTQ3RFx1NEVFNFx1NzdFOVx1OTYzNTpcdTRFMjRcdTVFNzNcdTUzRjBcdTU0MENcdTY1Q0ZcdTU0N0RcdTRFRTQsXHU1REVFXHU1RjAyXHU1M0VBXHU1NzI4IHJlcG8gXHU0RjIwXHU1M0MyKGdoIC0tcmVwbyAvIGFnIFx1NEY0RFx1N0Y2RVx1NTNDMlx1NjU3MClcdTMwMDIgKi9cclxuZXhwb3J0IGNvbnN0IENMSV9CSU46IFJlY29yZDxGb3JnZUhvc3QsIHN0cmluZz4gPSB7IGdpdGh1YjogJ2doJywgYXRvbWdpdDogJ2FnJyB9O1xyXG5jb25zdCBIT1NUUzogcmVhZG9ubHkgRm9yZ2VIb3N0W10gPSBbJ2dpdGh1YicsICdhdG9tZ2l0J107XHJcbmNvbnN0IFJFUE9fUkUgPSAvXltBLVphLXowLTlfLi1dK1xcL1tBLVphLXowLTlfLi1dKyQvO1xyXG5jb25zdCBDTURfVElNRU9VVF9NUyA9IDYwXzAwMDtcclxuY29uc3QgTE9HSU5fVElNRU9VVF9NUyA9IDE4MF8wMDA7XHJcbmNvbnN0IExJU1RfTElNSVQgPSA1MDtcclxuY29uc3QgUEFHRV9TSVpFID0gMjA7XHJcblxyXG4vKiAtLS0tIHNwYXduIHNlYW0oXHU1MzU1XHU2RDRCXHU2Q0U4XHU1MTY1O1x1NzUxRlx1NEVBN1x1NUI5RVx1NzNCMCA9IHdoZXJlIFx1ODlFM1x1Njc5MCArIFx1OEQ4NVx1NjVGNiBraWxsKSAtLS0tICovXHJcbmV4cG9ydCBpbnRlcmZhY2UgRm9yZ2VEZXBzIHtcclxuICAvKiogXHU4REQxXHU0RTAwXHU2NzYxIENMSSBcdTU0N0RcdTRFRTQoXHU4RDg1XHU2NUY2XHU1RjNBXHU1MjM2IGtpbGwpO29uTGluZSBcdTY1MzZcdTUyMzAgc3Rkb3V0IFx1ODg0QyhcdTc2N0JcdTVGNTVcdTZENDFcdTdBMEJcdTZENDFcdTVGMEZcdThGNkNcdTUzRDEpXHUzMDAyICovXHJcbiAgcnVuKGNtZDogc3RyaW5nLCBhcmdzOiBzdHJpbmdbXSwgdGltZW91dE1zOiBudW1iZXIsIG9uTGluZT86IChsaW5lOiBzdHJpbmcpID0+IHZvaWQpOiBQcm9taXNlPEZvcmdlQ2xpUmVzdWx0PjtcclxuICAvKiogXHU4OUUzXHU2NzkwXHU1M0VGXHU2MjY3XHU4ODRDXHU2NTg3XHU0RUY2XHU1QjhDXHU2NTc0XHU4REVGXHU1Rjg0OycnID0gXHU2NzJBXHU1Qjg5XHU4OEM1XHUzMDAyICovXHJcbiAgd2hpY2goY21kOiBzdHJpbmcpOiBzdHJpbmc7XHJcbn1cclxuXHJcbmV4cG9ydCBjb25zdCBkZWZhdWx0RGVwczogRm9yZ2VEZXBzID0ge1xyXG4gIHJ1bjogKGNtZCwgYXJncywgdGltZW91dE1zLCBvbkxpbmUpID0+XHJcbiAgICBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xyXG4gICAgICBjb25zdCByID0gcmVzb2x2ZUNsaShjbWQpO1xyXG4gICAgICBjb25zdCBjaGlsZCA9IHNwYXduKHIuYmluLCBbLi4uci5wcmVmaXgsIC4uLmFyZ3NdLCB7IHdpbmRvd3NIaWRlOiB0cnVlLCBzdGRpbzogWydpZ25vcmUnLCAncGlwZScsICdwaXBlJ10gfSk7XHJcbiAgICAgIGxldCBvdXQgPSAnJztcclxuICAgICAgbGV0IGVyciA9ICcnO1xyXG4gICAgICBsZXQgdGltZWRPdXQgPSBmYWxzZTtcclxuICAgICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHsgdGltZWRPdXQgPSB0cnVlOyBjaGlsZC5raWxsKCk7IH0sIHRpbWVvdXRNcyk7XHJcbiAgICAgIGNoaWxkLnN0ZG91dC5vbignZGF0YScsIChkOiBCdWZmZXIpID0+IHtcclxuICAgICAgICBjb25zdCB0ZXh0ID0gZC50b1N0cmluZygpO1xyXG4gICAgICAgIG91dCA9IChvdXQgKyB0ZXh0KS5zbGljZSgtMjAwXzAwMCk7XHJcbiAgICAgICAgaWYgKG9uTGluZSAhPT0gdW5kZWZpbmVkKSBmb3IgKGNvbnN0IGxpbmUgb2YgdGV4dC5zcGxpdCgvXFxyP1xcbi8pKSBpZiAobGluZS50cmltKCkgIT09ICcnKSBvbkxpbmUobGluZSk7XHJcbiAgICAgIH0pO1xyXG4gICAgICBjaGlsZC5zdGRlcnIub24oJ2RhdGEnLCAoZDogQnVmZmVyKSA9PiB7IGVyciA9IChlcnIgKyBkLnRvU3RyaW5nKCkpLnNsaWNlKC02MF8wMDApOyB9KTtcclxuICAgICAgY2hpbGQub24oJ2Vycm9yJywgKGUpID0+IHsgY2xlYXJUaW1lb3V0KHRpbWVyKTsgcmVzb2x2ZSh7IGNvZGU6IC0xLCBzdGRvdXQ6IG91dCwgc3RkZXJyOiBgJHtlcnJ9JHtTdHJpbmcoZSl9YCwgdGltZWRPdXQgfSk7IH0pO1xyXG4gICAgICBjaGlsZC5vbignY2xvc2UnLCAoY29kZSkgPT4geyBjbGVhclRpbWVvdXQodGltZXIpOyByZXNvbHZlKHsgY29kZTogY29kZSA/PyAtMSwgc3Rkb3V0OiBvdXQsIHN0ZGVycjogZXJyLCB0aW1lZE91dCB9KTsgfSk7XHJcbiAgICB9KSxcclxuICB3aGljaDogKGNtZCkgPT4ge1xyXG4gICAgdHJ5IHtcclxuICAgICAgLy8gd2hlcmUgXHU4RDcwIFBBVEhFWFQgXHU4OUUzXHU2NzkwO1x1NEVGQlx1NEUwMFx1ODg0Q1x1NTQ3RFx1NEUyRFx1NTM3M1x1ODlDNlx1NEUzQVx1NURGMlx1NUI4OVx1ODhDNShnaD1leGU7YWc9bnBtIHNoaW0gXHU0RTVGXHU3Qjk3KVxyXG4gICAgICBjb25zdCBvdXQgPSBleGVjRmlsZVN5bmMoJ3doZXJlJywgW2NtZF0sIHsgZW5jb2Rpbmc6ICd1dGY4JywgdGltZW91dDogNF8wMDAsIHdpbmRvd3NIaWRlOiB0cnVlIH0pO1xyXG4gICAgICByZXR1cm4gKG91dC5zcGxpdCgvXFxyP1xcbi8pLmZpbmQoKGwpID0+IGwudHJpbSgpICE9PSAnJykgPz8gJycpLnRyaW0oKTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4gJyc7IH1cclxuICB9LFxyXG59O1xyXG5cclxuLyoqIHdoZXJlIFx1NzY4NFx1NTE2OFx1OTBFOFx1NTAxOVx1OTAwOVx1ODg0QyhcdTVDMEZcdTVERTVcdTUxNzc6d2hpY2gvcmVzb2x2ZUNsaSBcdTUxNzFcdTc1MjgpXHUzMDAyICovXHJcbmZ1bmN0aW9uIHdoZXJlTGluZXMoY21kOiBzdHJpbmcpOiBzdHJpbmdbXSB7XHJcbiAgdHJ5IHtcclxuICAgIGNvbnN0IG91dCA9IGV4ZWNGaWxlU3luYygnd2hlcmUnLCBbY21kXSwgeyBlbmNvZGluZzogJ3V0ZjgnLCB0aW1lb3V0OiA0XzAwMCwgd2luZG93c0hpZGU6IHRydWUgfSk7XHJcbiAgICByZXR1cm4gb3V0LnNwbGl0KC9cXHI/XFxuLykubWFwKChsKSA9PiBsLnRyaW0oKSkuZmlsdGVyKChsKSA9PiBsICE9PSAnJyk7XHJcbiAgfSBjYXRjaCB7IHJldHVybiBbXTsgfVxyXG59XHJcblxyXG4vKipcclxuICogQ0xJIFx1NTQwRCBcdTIxOTIgXHU1M0VGIHNwYXduIFx1NzY4NFx1NUY2Mlx1NjAwMShXaW5kb3dzIFx1NUI5RVx1NkQ0Qlx1NTc1MSk6XHJcbiAqICAtIC5leGUoZ2gpXHUyMTkyIFx1NzZGNFx1NjNBNSBzcGF3bjtcclxuICogIC0gbnBtIFx1NTE2OFx1NUM0MCBzaGltKGFnIFx1NzY4NCBhZy5jbWQgLyBcdTY1RTBcdTYyNjlcdTVDNTVcdTU0MEQgc2gpXHUyMTkyIENyZWF0ZVByb2Nlc3MgXHU0RTBEXHU4MEZEXHU2MjY3XHU4ODRDLFxyXG4gKiAgICBcdTRFMTQgc2hlbGw6dHJ1ZSBcdTYyRkNcdTYzQTVcdTY3MDlcdTZDRThcdTUxNjVcdTk3NjIodGl0bGUvYm9keSBcdTY2MkZcdTc1MjhcdTYyMzdcdThGOTNcdTUxNjUpXHUyMDE0XHUyMDE0XHU4OUUzXHU2NzkwIHNoaW0gXHU5MUNDXHU1RjE1XHU3NTI4XHU3Njg0XHJcbiAqICAgIG5vZGVfbW9kdWxlcy8qKi5qcyBcdTc3MUZcdThFQUIsXHU3NTI4IG5vZGUuZXhlIDxqcz4gXHU3NkY0XHU4REQxKFx1NjVFMCBzaGVsbCxcdTUzQzJcdTY1NzBcdTY1NzBcdTdFQzRcdTUzOUZcdTY4MzdcdTRGMjApXHUzMDAyXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZUNsaShjbWQ6IHN0cmluZyk6IHsgYmluOiBzdHJpbmc7IHByZWZpeDogc3RyaW5nW10gfSB7XHJcbiAgY29uc3QgbGluZXMgPSB3aGVyZUxpbmVzKGNtZCk7XHJcbiAgY29uc3QgZXhlID0gbGluZXMuZmluZCgobCkgPT4gL1xcLmV4ZSQvaS50ZXN0KGwpKTtcclxuICBpZiAoZXhlICE9PSB1bmRlZmluZWQpIHJldHVybiB7IGJpbjogZXhlLCBwcmVmaXg6IFtdIH07XHJcbiAgY29uc3Qgc2hpbSA9IGxpbmVzLmZpbmQoKGwpID0+IC9cXC4oY21kfGJhdCkkL2kudGVzdChsKSkgPz8gbGluZXNbMF07XHJcbiAgaWYgKHNoaW0gPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgYmluOiBjbWQsIHByZWZpeDogW10gfTtcclxuICB0cnkge1xyXG4gICAgY29uc3QgdGV4dCA9IHJlYWRGaWxlU3luYyhzaGltLCAndXRmOCcpO1xyXG4gICAgY29uc3QgbSA9IHRleHQubWF0Y2goL25vZGVfbW9kdWxlc1tcXFxcL11bXFx3QC5cXC1cXFxcL10rP1xcLig/OmpzfG1qc3xjanMpL2kpO1xyXG4gICAgaWYgKG0gIT09IG51bGwpIHtcclxuICAgICAgY29uc3QganMgPSBqb2luKGRpcm5hbWUoc2hpbSksIG1bMF0ucmVwbGFjZSgvXFwvL2csIHNlcCkpO1xyXG4gICAgICBpZiAoZXhpc3RzU3luYyhqcykpIHtcclxuICAgICAgICBjb25zdCBub2RlRXhlID0gd2hlcmVMaW5lcygnbm9kZScpLmZpbmQoKGwpID0+IC9cXC5leGUkL2kudGVzdChsKSkgPz8gJ25vZGUnO1xyXG4gICAgICAgIHJldHVybiB7IGJpbjogbm9kZUV4ZSwgcHJlZml4OiBbanNdIH07XHJcbiAgICAgIH1cclxuICAgIH1cclxuICB9IGNhdGNoIHsgLyogc2hpbSBcdThCRkJcdTRFMERcdTRFODY6XHU2MzA5XHU1MzlGXHU2ODM3IHNwYXduKFx1NTkzMVx1OEQyNVx1NEYxQVx1NUY1Mlx1NEUwMFx1NjIxMCBDTElfRVJST1IvXHU2NzJBXHU4OEM1KSAqLyB9XHJcbiAgcmV0dXJuIHsgYmluOiBzaGltLCBwcmVmaXg6IFtdIH07XHJcbn1cclxuXHJcbi8qIC0tLS0gXHU1M0MyXHU2NTcwXHU2ODIxXHU5QThDKFx1NkJDRlx1NEUyQSBJUEMgXHU2NUI5XHU2Q0Q1XHU1MTY1XHU1M0UzXHU5MDEwXHU1M0MyXHU2NTcwXHU4RkM3XHU0RTAwXHU5MDREO1x1OEZENFx1NTZERSBudWxsPVx1OTAxQVx1OEZDNykgLS0tLSAqL1xyXG5leHBvcnQgZnVuY3Rpb24gY2hlY2tIb3N0KGhvc3Q6IHVua25vd24pOiBGb3JnZUhvc3QgfCBudWxsIHtcclxuICByZXR1cm4gaG9zdCA9PT0gJ2dpdGh1YicgfHwgaG9zdCA9PT0gJ2F0b21naXQnID8gaG9zdCA6IG51bGw7XHJcbn1cclxuZXhwb3J0IGZ1bmN0aW9uIGNoZWNrUmVwbyhyZXBvOiB1bmtub3duKTogc3RyaW5nIHwgbnVsbCB7XHJcbiAgcmV0dXJuIHR5cGVvZiByZXBvID09PSAnc3RyaW5nJyAmJiBSRVBPX1JFLnRlc3QocmVwbykgJiYgcmVwby5sZW5ndGggPD0gMTQwID8gcmVwbyA6IG51bGw7XHJcbn1cclxuZXhwb3J0IGZ1bmN0aW9uIGNoZWNrU3RhdGUoc3RhdGU6IHVua25vd24pOiAnb3BlbicgfCAnY2xvc2VkJyB8ICdhbGwnIHtcclxuICByZXR1cm4gc3RhdGUgPT09ICdjbG9zZWQnIHx8IHN0YXRlID09PSAnYWxsJyA/IHN0YXRlIDogJ29wZW4nO1xyXG59XHJcbmV4cG9ydCBmdW5jdGlvbiBjaGVja1N0cih2OiB1bmtub3duLCBtYXg6IG51bWJlcik6IHN0cmluZyB7XHJcbiAgcmV0dXJuIHR5cGVvZiB2ID09PSAnc3RyaW5nJyA/IHYuc2xpY2UoMCwgbWF4KSA6ICcnO1xyXG59XHJcblxyXG4vKiogXHU4OUUzXHU2NzkwIHN0ZG91dC9zdGRlcnIgXHU5MUNDXHU3Njg0XHU3QjJDXHU0RTAwXHU0RTJBIGh0dHAocykgVVJMKFx1NzY3Qlx1NUY1NVx1NkQ0MVx1N0EwQlx1NTkxNlx1NUYwMFx1NkQ0Rlx1ODlDOFx1NTY2OCArIFx1NUM1NVx1NzkzQSlcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGV4dHJhY3RVcmwodGV4dDogc3RyaW5nKTogc3RyaW5nIHtcclxuICBjb25zdCBtID0gdGV4dC5tYXRjaCgvaHR0cHM6XFwvXFwvW15cXHMnXCIpXFxdXSsvKTtcclxuICByZXR1cm4gbSA9PT0gbnVsbCA/ICcnIDogbVswXS5yZXBsYWNlKC9bLiw7XSskLywgJycpO1xyXG59XHJcblxyXG4vKiogYXV0aCBzdGF0dXMgXHU2NTg3XHU2NzJDIFx1MjE5MiBcdTc2N0JcdTVGNTVcdTYwMDEgKyBcdTc1MjhcdTYyMzdcdTU0MEQoXHU0RTI0XHU1RTczXHU1M0YwXHU2NTg3XHU2ODQ4OmdoIFwiYWNjb3VudCBYXCIgLyBhZyBcImFzIFhcIilcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQXV0aFN0YXR1cyhob3N0OiBGb3JnZUhvc3QsIHN0ZG91dDogc3RyaW5nLCBzdGRlcnI6IHN0cmluZywgY29kZTogbnVtYmVyIHwgbnVsbCk6IEZvcmdlSG9zdFN0YXR1cyB7XHJcbiAgY29uc3QgdGV4dCA9IGAke3N0ZG91dH1cXG4ke3N0ZGVycn1gO1xyXG4gIGNvbnN0IG0gPSB0ZXh0Lm1hdGNoKGhvc3QgPT09ICdnaXRodWInID8gL0xvZ2dlZCBpbiB0byBnaXRodWJcXC5jb20gYWNjb3VudCAoXFxTKykvIDogL0xvZ2dlZCBpbiB0byBhdG9tZ2l0XFwuY29tIGFzIChcXFMrKS8pO1xyXG4gIGlmIChtICE9PSBudWxsKSByZXR1cm4geyBpbnN0YWxsZWQ6IHRydWUsIGxvZ2dlZDogdHJ1ZSwgdXNlcjogKG1bMV0gPz8gJycpLnJlcGxhY2UoL1soKV0vZywgJycpIH07XHJcbiAgLy8gZXhpdFx1MjI2MDAgXHU0RTE0XHU2NjBFXHU3ODZFXHU4QkY0XHU2NzJBXHU3NjdCXHU1RjU1IFx1MjE5MiBcdTVERjJcdTg4QzVcdTY3MkFcdTc2N0JcdTVGNTU7XHU4MEZEXHU4REQxXHU1MjMwXHU4RkQ5KFx1ODAwQ1x1OTc1RSBFTk9FTlQpXHU1MzczIENMSSBcdTVCNThcdTU3MjhcclxuICByZXR1cm4geyBpbnN0YWxsZWQ6IHRydWUsIGxvZ2dlZDogZmFsc2UsIHVzZXI6ICcnICwgLi4uKGNvZGUgPT09IC0xICYmIC9FTk9FTlR8c3Bhd24vaS50ZXN0KHRleHQpID8geyBpbnN0YWxsZWQ6IGZhbHNlIH0gOiB7fSkgfTtcclxufVxyXG5cclxuLyogLS0tLSBKU09OIFx1NUY1Mlx1NEUwMChnaC9hZyBcdTVCNTdcdTZCQjVcdTVERUVcdTVGMDJcdTYyQjlcdTVFNzM7XHU1QjU3XHU2QkI1XHU3RjNBXHU1OTMxXHU3RUQ5XHU1Qjg5XHU1MTY4XHU5RUQ4XHU4QkE0KSAtLS0tICovXHJcbnR5cGUgQW55UmVjID0gUmVjb3JkPHN0cmluZywgdW5rbm93bj47XHJcbmNvbnN0IHMgPSAodjogdW5rbm93bik6IHN0cmluZyA9PiB0eXBlb2YgdiA9PT0gJ3N0cmluZycgPyB2IDogdHlwZW9mIHYgPT09ICdudW1iZXInID8gU3RyaW5nKHYpIDogJyc7XHJcbmNvbnN0IGIgPSAodjogdW5rbm93biwgZGZsdCA9IGZhbHNlKTogYm9vbGVhbiA9PiB0eXBlb2YgdiA9PT0gJ2Jvb2xlYW4nID8gdiA6IGRmbHQ7XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplUmVwb3MoaG9zdDogRm9yZ2VIb3N0LCByb3dzOiBBbnlSZWNbXSk6IEZvcmdlUmVwb1tdIHtcclxuICByZXR1cm4gcm93cy5tYXAoKHIpID0+IHtcclxuICAgIGNvbnN0IG5hbWUgPSBzKHIubmFtZSk7XHJcbiAgICBjb25zdCBmdWxsTmFtZSA9IHMoci5uYW1lV2l0aE93bmVyKSB8fCBzKHIuZnVsbE5hbWUpIHx8IG5hbWU7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICBuYW1lLFxyXG4gICAgICBmdWxsTmFtZSxcclxuICAgICAgaXNQcml2YXRlOiBob3N0ID09PSAnZ2l0aHViJyA/IGIoci5pc1ByaXZhdGUpIDogcyhyLnZpc2liaWxpdHkpID09PSAncHJpdmF0ZScsXHJcbiAgICAgIHVwZGF0ZWRBdDogcyhyLnVwZGF0ZWRBdCksXHJcbiAgICAgIHVybDogcyhyLnVybCkgfHwgKGhvc3QgPT09ICdnaXRodWInID8gYGh0dHBzOi8vZ2l0aHViLmNvbS8ke2Z1bGxOYW1lfWAgOiBgaHR0cHM6Ly9hdG9tZ2l0LmNvbS8ke2Z1bGxOYW1lfWApLFxyXG4gICAgICBkZXNjcmlwdGlvbjogcyhyLmRlc2NyaXB0aW9uKSxcclxuICAgIH07XHJcbiAgfSk7XHJcbn1cclxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZVBycyhyb3dzOiBBbnlSZWNbXSk6IEZvcmdlUHJbXSB7XHJcbiAgcmV0dXJuIHJvd3MubWFwKChyKSA9PiAoe1xyXG4gICAgbnVtYmVyOiBzKHIubnVtYmVyKSxcclxuICAgIHRpdGxlOiBzKHIudGl0bGUpLFxyXG4gICAgc3RhdGU6IHMoci5zdGF0ZSkudG9Mb3dlckNhc2UoKSB8fCAnb3BlbicsXHJcbiAgICBpc0RyYWZ0OiBiKHIuaXNEcmFmdCkgfHwgYihyLmRyYWZ0KSxcclxuICAgIHVwZGF0ZWRBdDogcyhyLnVwZGF0ZWRBdCksXHJcbiAgICB1cmw6IHMoci51cmwpLFxyXG4gIH0pKTtcclxufVxyXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplSXNzdWVzKHJvd3M6IEFueVJlY1tdKTogRm9yZ2VJc3N1ZVtdIHtcclxuICByZXR1cm4gcm93cy5tYXAoKHIpID0+ICh7XHJcbiAgICBudW1iZXI6IHMoci5udW1iZXIpLFxyXG4gICAgdGl0bGU6IHMoci50aXRsZSksXHJcbiAgICBzdGF0ZTogcyhyLnN0YXRlKS50b0xvd2VyQ2FzZSgpIHx8ICdvcGVuJyxcclxuICAgIHVwZGF0ZWRBdDogcyhyLnVwZGF0ZWRBdCksXHJcbiAgICB1cmw6IHMoci51cmwpLFxyXG4gIH0pKTtcclxufVxyXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplUmVsZWFzZXMoaG9zdDogRm9yZ2VIb3N0LCByb3dzOiBBbnlSZWNbXSk6IEZvcmdlUmVsZWFzZVtdIHtcclxuICByZXR1cm4gcm93cy5tYXAoKHIpID0+ICh7XHJcbiAgICB0YWc6IHMoaG9zdCA9PT0gJ2dpdGh1YicgPyByLnRhZ05hbWUgOiByLnRhZyksXHJcbiAgICBuYW1lOiBzKHIubmFtZSksXHJcbiAgICBjcmVhdGVkQXQ6IHMoci5jcmVhdGVkQXQpLFxyXG4gICAgaXNEcmFmdDogYihyLmlzRHJhZnQpIHx8IGIoci5kcmFmdCksXHJcbiAgICBpc1ByZXJlbGVhc2U6IGIoci5pc1ByZXJlbGVhc2UpIHx8IGIoci5wcmVyZWxlYXNlKSxcclxuICB9KSk7XHJcbn1cclxuXHJcbi8qIC0tLS0gXHU1NDdEXHU0RUU0XHU2MkZDXHU4OEM1KFx1N0VBRlx1NTFGRFx1NjU3MCxcdTUzNTVcdTZENEJcdTk1MUFcdTcwQjkpIC0tLS0gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkTGlzdEFyZ3Moa2luZDogJ3JlcG9zJyB8ICdwcnMnIHwgJ2lzc3VlcycgfCAncmVsZWFzZXMnLCBob3N0OiBGb3JnZUhvc3QsIHJlcG86IHN0cmluZywgc3RhdGU6IHN0cmluZyk6IHN0cmluZ1tdIHtcclxuICBpZiAoa2luZCA9PT0gJ3JlcG9zJykge1xyXG4gICAgcmV0dXJuIGhvc3QgPT09ICdnaXRodWInXHJcbiAgICAgID8gWydyZXBvJywgJ2xpc3QnLCAnLS1saW1pdCcsIFN0cmluZyhMSVNUX0xJTUlUKSwgJy0tanNvbicsICduYW1lLG5hbWVXaXRoT3duZXIsaXNQcml2YXRlLHVwZGF0ZWRBdCx1cmwsZGVzY3JpcHRpb24nXVxyXG4gICAgICA6IFsncmVwbycsICdsaXN0JywgJy0tbGltaXQnLCBTdHJpbmcoTElTVF9MSU1JVCksICctLWpzb24nXTtcclxuICB9XHJcbiAgaWYgKGhvc3QgPT09ICdnaXRodWInKSB7XHJcbiAgICBjb25zdCBiYXNlID0ga2luZCA9PT0gJ3BycycgPyAncHInIDoga2luZCA9PT0gJ2lzc3VlcycgPyAnaXNzdWUnIDogJ3JlbGVhc2UnO1xyXG4gICAgaWYgKGtpbmQgPT09ICdyZWxlYXNlcycpIHJldHVybiBbJ3JlbGVhc2UnLCAnbGlzdCcsICctLXJlcG8nLCByZXBvLCAnLS1saW1pdCcsIFN0cmluZyhMSVNUX0xJTUlUKSwgJy0tanNvbicsICd0YWdOYW1lLG5hbWUsY3JlYXRlZEF0LGlzRHJhZnQsaXNQcmVyZWxlYXNlJ107XHJcbiAgICBjb25zdCBmaWVsZHMgPSBraW5kID09PSAncHJzJyA/ICdudW1iZXIsdGl0bGUsc3RhdGUsaXNEcmFmdCx1cGRhdGVkQXQsdXJsJyA6ICdudW1iZXIsdGl0bGUsc3RhdGUsdXBkYXRlZEF0LHVybCc7XHJcbiAgICByZXR1cm4gW2Jhc2UsICdsaXN0JywgJy0tcmVwbycsIHJlcG8sICctLXN0YXRlJywgc3RhdGUsICctLWxpbWl0JywgU3RyaW5nKExJU1RfTElNSVQpLCAnLS1qc29uJywgZmllbGRzXTtcclxuICB9XHJcbiAgaWYgKGtpbmQgPT09ICdyZWxlYXNlcycpIHJldHVybiBbJ3JlbGVhc2UnLCAnbGlzdCcsIHJlcG8sICctLWpzb24nLCAnLS1saW1pdCcsIFN0cmluZyhMSVNUX0xJTUlUKV07XHJcbiAgY29uc3QgYmFzZSA9IGtpbmQgPT09ICdwcnMnID8gJ3ByJyA6ICdpc3N1ZSc7XHJcbiAgcmV0dXJuIFtiYXNlLCAnbGlzdCcsIHJlcG8sICctLXN0YXRlJywgc3RhdGUsICctLWpzb24nLCAnLS1saW1pdCcsIFN0cmluZyhMSVNUX0xJTUlUKV07XHJcbn1cclxuXHJcbmV4cG9ydCB0eXBlIEZvcmdlQWN0aW9uS2luZCA9ICdwcl9jcmVhdGUnIHwgJ3ByX21lcmdlJyB8ICdpc3N1ZV9jcmVhdGUnIHwgJ3JlbGVhc2VfY3JlYXRlJyB8ICdyZWxlYXNlX3VwbG9hZCcgfCAncmVwb19jbG9uZSc7XHJcbmV4cG9ydCBpbnRlcmZhY2UgRm9yZ2VBY3Rpb25BcmdzIHtcclxuICByZXBvOiBzdHJpbmc7IG51bWJlcj86IHN0cmluZzsgdGl0bGU/OiBzdHJpbmc7IGJvZHk/OiBzdHJpbmc7IGJhc2U/OiBzdHJpbmc7IGhlYWQ/OiBzdHJpbmc7XHJcbiAgdGFnPzogc3RyaW5nOyBuYW1lPzogc3RyaW5nOyBub3Rlcz86IHN0cmluZzsgcHJlcmVsZWFzZT86IGJvb2xlYW47IGZpbGU/OiBzdHJpbmc7IGRpcj86IHN0cmluZzsgbWV0aG9kPzogc3RyaW5nO1xyXG59XHJcblxyXG4vKiogXHU1MTk5XHU2NENEXHU0RjVDXHU1NDdEXHU0RUU0XHU2MkZDXHU4OEM1KFx1OTAxMCBraW5kIFx1NjgyMVx1OUE4QztcdThGRDRcdTU2REUgbnVsbCA9IFx1NTNDMlx1NjU3MFx1NEUwRFx1NTQwOFx1NkNENSlcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkQWN0aW9uQXJncyhraW5kOiBGb3JnZUFjdGlvbktpbmQsIGhvc3Q6IEZvcmdlSG9zdCwgYTogRm9yZ2VBY3Rpb25BcmdzKTogc3RyaW5nW10gfCBudWxsIHtcclxuICBjb25zdCBSID0gKHY6IHN0cmluZyB8IHVuZGVmaW5lZCk6IHN0cmluZ1tdID0+IGhvc3QgPT09ICdnaXRodWInID8gWyctLXJlcG8nLCB2ID8/ICcnXSA6IFt2ID8/ICcnXTtcclxuICBpZiAoa2luZCA9PT0gJ3ByX2NyZWF0ZScpIHtcclxuICAgIGNvbnN0IHRpdGxlID0gY2hlY2tTdHIoYS50aXRsZSwgMzAwKTsgY29uc3QgYm9keSA9IGNoZWNrU3RyKGEuYm9keSwgMjBfMDAwKTtcclxuICAgIGNvbnN0IGJhc2UgPSBjaGVja1N0cihhLmJhc2UsIDIwMCk7IGNvbnN0IGhlYWQgPSBjaGVja1N0cihhLmhlYWQsIDIwMCk7XHJcbiAgICBpZiAodGl0bGUgPT09ICcnKSByZXR1cm4gbnVsbDtcclxuICAgIGNvbnN0IGFyZ3MgPSBob3N0ID09PSAnZ2l0aHViJ1xyXG4gICAgICA/IFsncHInLCAnY3JlYXRlJywgJy0tcmVwbycsIGEucmVwbywgJy0tdGl0bGUnLCB0aXRsZSwgJy0tYm9keScsIGJvZHldXHJcbiAgICAgIDogWydwcicsICdjcmVhdGUnLCBhLnJlcG8sICctLXRpdGxlJywgdGl0bGUsICctLWJvZHknLCBib2R5XTtcclxuICAgIGlmIChiYXNlICE9PSAnJykgYXJncy5wdXNoKCctLWJhc2UnLCBiYXNlKTtcclxuICAgIGlmIChoZWFkICE9PSAnJykgYXJncy5wdXNoKCctLWhlYWQnLCBoZWFkKTtcclxuICAgIHJldHVybiBhcmdzO1xyXG4gIH1cclxuICBpZiAoa2luZCA9PT0gJ3ByX21lcmdlJykge1xyXG4gICAgY29uc3QgbnVtID0gY2hlY2tTdHIoYS5udW1iZXIsIDIwKS5yZXBsYWNlKC9bXjAtOV0vZywgJycpO1xyXG4gICAgaWYgKG51bSA9PT0gJycpIHJldHVybiBudWxsO1xyXG4gICAgY29uc3Qgc3F1YXNoID0gYS5tZXRob2QgIT09ICdtZXJnZSc7IC8vIFx1OUVEOFx1OEJBNCBzcXVhc2goXHU0RTBFIGdoIFx1OTc1RVx1NEVBNFx1NEU5Mlx1ODk4MVx1NkM0Mlx1NEUwMFx1ODFGNClcclxuICAgIHJldHVybiBob3N0ID09PSAnZ2l0aHViJ1xyXG4gICAgICA/IFsncHInLCAnbWVyZ2UnLCAnLS1yZXBvJywgYS5yZXBvLCBudW0sIHNxdWFzaCA/ICctLXNxdWFzaCcgOiAnLS1tZXJnZSddXHJcbiAgICAgIDogWydwcicsICdtZXJnZScsIGEucmVwbywgbnVtLCBzcXVhc2ggPyAnLS1zcXVhc2gnIDogJy0tbWVyZ2UnXTtcclxuICB9XHJcbiAgaWYgKGtpbmQgPT09ICdpc3N1ZV9jcmVhdGUnKSB7XHJcbiAgICBjb25zdCB0aXRsZSA9IGNoZWNrU3RyKGEudGl0bGUsIDMwMCk7IGNvbnN0IGJvZHkgPSBjaGVja1N0cihhLmJvZHksIDIwXzAwMCk7XHJcbiAgICBpZiAodGl0bGUgPT09ICcnKSByZXR1cm4gbnVsbDtcclxuICAgIHJldHVybiBob3N0ID09PSAnZ2l0aHViJ1xyXG4gICAgICA/IFsnaXNzdWUnLCAnY3JlYXRlJywgJy0tcmVwbycsIGEucmVwbywgJy0tdGl0bGUnLCB0aXRsZSwgJy0tYm9keScsIGJvZHldXHJcbiAgICAgIDogWydpc3N1ZScsICdjcmVhdGUnLCBhLnJlcG8sICctLXRpdGxlJywgdGl0bGUsICctLWJvZHknLCBib2R5XTtcclxuICB9XHJcbiAgaWYgKGtpbmQgPT09ICdyZWxlYXNlX2NyZWF0ZScpIHtcclxuICAgIGNvbnN0IHRhZyA9IGNoZWNrU3RyKGEudGFnLCAxMjApOyBjb25zdCBuYW1lID0gY2hlY2tTdHIoYS5uYW1lLCAzMDApO1xyXG4gICAgLy8gYXRvbWdpdCBBUEkgXHU4OTgxXHU2QzQyIGJvZHkgXHU5NzVFXHU3QTdBOlx1NjVFMCBub3RlcyBcdTY1RjZcdTU2REVcdTkwMDAgdGFnIFx1NjU4N1x1NjcyQ1xyXG4gICAgY29uc3Qgbm90ZXMgPSBjaGVja1N0cihhLm5vdGVzLCA2MF8wMDApIHx8IHRhZztcclxuICAgIGlmICghL15bQS1aYS16MC05Xy4tXSskLy50ZXN0KHRhZykpIHJldHVybiBudWxsO1xyXG4gICAgcmV0dXJuIGhvc3QgPT09ICdnaXRodWInXHJcbiAgICAgID8gWydyZWxlYXNlJywgJ2NyZWF0ZScsIHRhZywgJy0tcmVwbycsIGEucmVwbywgJy0tdGl0bGUnLCBuYW1lIHx8IHRhZywgJy0tbm90ZXMnLCBub3RlcywgLi4uKGEucHJlcmVsZWFzZSA9PT0gdHJ1ZSA/IFsnLS1wcmVyZWxlYXNlJ10gOiBbXSldXHJcbiAgICAgIDogWydyZWxlYXNlJywgJ2NyZWF0ZScsIGEucmVwbywgdGFnLCAnLS1uYW1lJywgbmFtZSB8fCB0YWcsICctLWJvZHknLCBub3RlcywgLi4uKGEucHJlcmVsZWFzZSA9PT0gdHJ1ZSA/IFsnLS1wcmVyZWxlYXNlJ10gOiBbXSldO1xyXG4gIH1cclxuICBpZiAoa2luZCA9PT0gJ3JlbGVhc2VfdXBsb2FkJykge1xyXG4gICAgY29uc3QgdGFnID0gY2hlY2tTdHIoYS50YWcsIDEyMCk7IGNvbnN0IGZpbGUgPSBjaGVja1N0cihhLmZpbGUsIDFfMDAwKTtcclxuICAgIGlmICghL15bQS1aYS16MC05Xy4tXSskLy50ZXN0KHRhZykgfHwgZmlsZSA9PT0gJycpIHJldHVybiBudWxsO1xyXG4gICAgcmV0dXJuIGhvc3QgPT09ICdnaXRodWInXHJcbiAgICAgID8gWydyZWxlYXNlJywgJ3VwbG9hZCcsIHRhZywgZmlsZSwgJy0tcmVwbycsIGEucmVwb11cclxuICAgICAgOiBbJ3JlbGVhc2UnLCAndXBsb2FkJywgYS5yZXBvLCB0YWcsIGZpbGVdO1xyXG4gIH1cclxuICAvLyByZXBvX2Nsb25lOmdoL2FnIFx1NTQwQ1x1NUY2MihjbG9uZSBPV05FUi9SRVBPIDxkaXI+KVxyXG4gIGNvbnN0IGRpciA9IGNoZWNrU3RyKGEuZGlyLCAxXzAwMCk7XHJcbiAgaWYgKGRpciA9PT0gJycpIHJldHVybiBudWxsO1xyXG4gIHJldHVybiBbJ3JlcG8nLCAnY2xvbmUnLCBhLnJlcG8sIGRpcl07XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBcdTRFMEFcdTRGMjAvXHU1MTRCXHU5Njg2XHU3Njg0XHU2NTg3XHU0RUY2XHU4REVGXHU1Rjg0XHU5NUU4Olx1N0VERFx1NUJGOVx1OERFRlx1NUY4NCArIFx1NUZDNVx1OTg3Qlx1ODQzRFx1NTcyOFx1NzUyOFx1NjIzN1x1NEUzQlx1NzZFRVx1NUY1NVx1NjIxNlx1NURGMlx1NkNFOFx1NTE4Q1x1NURFNVx1NEY1Q1x1NTMzQVx1NEU0Qlx1NEUwQlx1MzAwMlxyXG4gKiAoXHU5NzYyXHU2NzdGXHU3Njg0XHU4RDQ0XHU0RUE3XHU5MDA5XHU2MkU5XHU1NjY4XHU1M0VBXHU1RTk0XHU3OEIwXHU3NTI4XHU2MjM3XHU4MUVBXHU1REYxXHU3Njg0XHU3NkVFXHU1RjU1O1x1OTYzMlx1NkI2Mlx1NjI4QVx1N0NGQlx1N0VERlx1NjU4N1x1NEVGNlx1NEYyMFx1NEUwQSByZWxlYXNlXHUzMDAyKVxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHZhbGlkYXRlTG9jYWxQYXRoKHA6IHN0cmluZywgYWxsb3dlZFJvb3RzOiByZWFkb25seSBzdHJpbmdbXSk6IGJvb2xlYW4ge1xyXG4gIGlmICghaXNBYnNvbHV0ZShwKSkgcmV0dXJuIGZhbHNlO1xyXG4gIGNvbnN0IGhvbWUgPSBob21lZGlyKCk7XHJcbiAgY29uc3QgdW5kZXIgPSAocm9vdDogc3RyaW5nKTogYm9vbGVhbiA9PiB7XHJcbiAgICB0cnkgeyBjb25zdCByID0gam9pbihyb290LCAnJyk7IHJldHVybiBwID09PSByIHx8IHAuc3RhcnRzV2l0aChgJHtyfSR7c2VwfWApOyB9IGNhdGNoIHsgcmV0dXJuIGZhbHNlOyB9XHJcbiAgfTtcclxuICBpZiAodW5kZXIoaG9tZSkpIHJldHVybiB0cnVlO1xyXG4gIHJldHVybiBhbGxvd2VkUm9vdHMuc29tZSh1bmRlcik7XHJcbn1cclxuXHJcbi8qKiBcdTVERTVcdTRGNUNcdTUzM0FcdThERUZcdTVGODQgXHUyMTkyIFx1NUU3M1x1NTNGMFx1NEVEM1x1NUU5Myhvd25lci9yZXBvKTpcdThCRkIgLmdpdC9jb25maWcgXHU3Njg0IHJlbW90ZSB1cmwoaHR0cHMvc3NoIFx1NEUyNFx1NzlDRFx1NTE5OVx1NkNENSlcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVSZXBvT2YocGF0aDogc3RyaW5nKTogeyBob3N0OiBGb3JnZUhvc3Q7IHJlcG86IHN0cmluZyB9IHwgbnVsbCB7XHJcbiAgdHJ5IHtcclxuICAgIGNvbnN0IGNmZyA9IHJlYWRGaWxlU3luYyhqb2luKHBhdGgsICcuZ2l0JywgJ2NvbmZpZycpLCAndXRmOCcpO1xyXG4gICAgY29uc3QgdXJscyA9IFsuLi5jZmcubWF0Y2hBbGwoL3VybFxccyo9XFxzKihcXFMrKS9nKV0ubWFwKChtKSA9PiBtWzFdID8/ICcnKTtcclxuICAgIGZvciAoY29uc3QgdSBvZiB1cmxzKSB7XHJcbiAgICAgIGNvbnN0IGdoID0gdS5tYXRjaCgvKD86Z2l0aHViXFwuY29tWy86XSkoW0EtWmEtejAtOV8uLV0rXFwvW0EtWmEtejAtOV8uLV0rPykoPzpcXC5naXQpPyQvaSk7XHJcbiAgICAgIGlmIChnaCAhPT0gbnVsbCAmJiAoZ2hbMV0gPz8gJycpICE9PSAnJykgcmV0dXJuIHsgaG9zdDogJ2dpdGh1YicsIHJlcG86IGdoWzFdID8/ICcnIH07XHJcbiAgICAgIGNvbnN0IGFnID0gdS5tYXRjaCgvKD86YXRvbWdpdFxcLmNvbVsvOl0pKFtBLVphLXowLTlfLi1dK1xcL1tBLVphLXowLTlfLi1dKz8pKD86XFwuZ2l0KT8kL2kpO1xyXG4gICAgICBpZiAoYWcgIT09IG51bGwgJiYgKGFnWzFdID8/ICcnKSAhPT0gJycpIHJldHVybiB7IGhvc3Q6ICdhdG9tZ2l0JywgcmVwbzogYWdbMV0gPz8gJycgfTtcclxuICAgIH1cclxuICAgIHJldHVybiBudWxsO1xyXG4gIH0gY2F0Y2ggeyByZXR1cm4gbnVsbDsgfVxyXG59XHJcblxyXG4vKiAtLS0tIGZvcmdlIFx1NjcwRFx1NTJBMVx1NUJGOVx1OEM2MShtYWluIFx1NTM1NVx1NEY4QjtcdTUzNTVcdTZENEJcdTZDRThcdTUxNjUgZGVwcykgLS0tLSAqL1xyXG5leHBvcnQgaW50ZXJmYWNlIEZvcmdlT3B0aW9ucyB7XHJcbiAgLyoqIFx1NURGMlx1NkNFOFx1NTE4Q1x1NURFNVx1NEY1Q1x1NTMzQVx1NjgzOVx1NTIxN1x1ODg2OChyZWxlYXNlX3VwbG9hZC9yZXBvX2Nsb25lIFx1NzY4NFx1OERFRlx1NUY4NFx1OTVFOCArIFx1OTc2Mlx1Njc3Rlx1NEUwQVx1NEUwQlx1NjU4NylcdTMwMDIgKi9cclxuICBhbGxvd2VkUm9vdHM/OiAoKSA9PiBzdHJpbmdbXTtcclxuICAvKiogXHU3NjdCXHU1RjU1XHU2RDQxXHU3QTBCXHU4ODRDXHU4RjZDXHU1M0QxICsgVVJMIFx1NTkxNlx1NUYwMCh1aXZlcmlmeS9cdTUzNTVcdTZENEJcdTUzRUZcdTk3NTlcdTlFRDgpXHUzMDAyICovXHJcbiAgb25Mb2dpbkxpbmU/OiAoaG9zdDogRm9yZ2VIb3N0LCBsaW5lOiBzdHJpbmcpID0+IHZvaWQ7XHJcbiAgb3BlbkV4dGVybmFsPzogKHVybDogc3RyaW5nKSA9PiB2b2lkO1xyXG59XHJcblxyXG5jb25zdCBiYWQgPSAoY29kZTogc3RyaW5nLCBlcnJvcjogc3RyaW5nKTogeyBvazogZmFsc2U7IGNvZGU6IHN0cmluZzsgZXJyb3I6IHN0cmluZyB9ID0+ICh7IG9rOiBmYWxzZSwgY29kZSwgZXJyb3I6IGVycm9yLnNsaWNlKDAsIDMwMCkgfSk7XHJcbmNvbnN0IG9rID0gPFQ+KGRhdGE6IFQpOiBGb3JnZU9rPFQ+ID0+ICh7IG9rOiB0cnVlLCBkYXRhIH0pO1xyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZUZvcmdlKGRlcHM6IEZvcmdlRGVwcyA9IGRlZmF1bHREZXBzLCBvcHRzOiBGb3JnZU9wdGlvbnMgPSB7fSk6IEZvcmdlU2VydmljZSB7XHJcbiAgY29uc3Qgcm9vdHMgPSAoKTogc3RyaW5nW10gPT4gKG9wdHMuYWxsb3dlZFJvb3RzPy4oKSA/PyBbXSkuZmlsdGVyKChyKSA9PiB0eXBlb2YgciA9PT0gJ3N0cmluZycgJiYgciAhPT0gJycpO1xyXG5cclxuICAvKiogXHU1RjUyXHU0RTAwIENMSSBcdTdFRDNcdTY3OUM6XHU4RDg1XHU2NUY2L1x1OTc1RVx1OTZGNlx1OTAwMFx1NTFGQS9cdTU3NEYgSlNPTiBcdTIxOTIgXHU3RUQzXHU2Nzg0XHU1MzE2XHU5NTE5XHU4QkVGXHUzMDAyICovXHJcbiAgYXN5bmMgZnVuY3Rpb24gY2xpSnNvbjxUPihob3N0OiBGb3JnZUhvc3QsIGFyZ3M6IHN0cmluZ1tdLCBub3JtYWxpemVyOiAocm93czogQW55UmVjW10pID0+IFQpOiBQcm9taXNlPEZvcmdlT2s8VD4+IHtcclxuICAgIGNvbnN0IHIgPSBhd2FpdCBkZXBzLnJ1bihDTElfQklOW2hvc3RdLCBhcmdzLCBDTURfVElNRU9VVF9NUyk7XHJcbiAgICBpZiAoci50aW1lZE91dCkgcmV0dXJuIGJhZCgnVElNRU9VVCcsIGAke0NMSV9CSU5baG9zdF19ICR7YXJnc1swXX0gXHU4RDg1XHU2NUY2KCR7TWF0aC5yb3VuZChDTURfVElNRU9VVF9NUyAvIDEwMDApfXMpYCk7XHJcbiAgICBpZiAoci5jb2RlICE9PSAwKSByZXR1cm4gYmFkKCdDTElfRVJST1InLCBgJHtDTElfQklOW2hvc3RdfSAke2FyZ3Muc2xpY2UoMCwgMykuam9pbignICcpfSBcdTU5MzFcdThEMjUoJHtyLmNvZGV9KTokeyhyLnN0ZGVyciB8fCByLnN0ZG91dCkudHJpbSgpLnNwbGl0KCdcXG4nKS5zbGljZSgtMykuam9pbignICcpfWApO1xyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShyLnN0ZG91dCkgYXMgdW5rbm93bjtcclxuICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHBhcnNlZCkpIHJldHVybiBiYWQoJ0JBRF9KU09OJywgJ0NMSSBcdThGOTNcdTUxRkFcdTk3NUUgSlNPTiBcdTY1NzBcdTdFQzQnKTtcclxuICAgICAgcmV0dXJuIG9rKG5vcm1hbGl6ZXIocGFyc2VkIGFzIEFueVJlY1tdKSk7XHJcbiAgICB9IGNhdGNoIHtcclxuICAgICAgcmV0dXJuIGJhZCgnQkFEX0pTT04nLCAnQ0xJIFx1OEY5M1x1NTFGQVx1NjVFMFx1NkNENVx1ODlFM1x1Njc5MFx1NEUzQSBKU09OJyk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICByZXR1cm4ge1xyXG4gICAgYXN5bmMgc3RhdHVzKCk6IFByb21pc2U8Rm9yZ2VTdGF0dXM+IHtcclxuICAgICAgY29uc3Qgb25lID0gYXN5bmMgKGhvc3Q6IEZvcmdlSG9zdCk6IFByb21pc2U8Rm9yZ2VIb3N0U3RhdHVzPiA9PiB7XHJcbiAgICAgICAgaWYgKGRlcHMud2hpY2goQ0xJX0JJTltob3N0XSkgPT09ICcnKSByZXR1cm4geyBpbnN0YWxsZWQ6IGZhbHNlLCBsb2dnZWQ6IGZhbHNlLCB1c2VyOiAnJyB9O1xyXG4gICAgICAgIGNvbnN0IHIgPSBhd2FpdCBkZXBzLnJ1bihDTElfQklOW2hvc3RdLCBbJ2F1dGgnLCAnc3RhdHVzJ10sIDE1XzAwMCk7XHJcbiAgICAgICAgcmV0dXJuIHBhcnNlQXV0aFN0YXR1cyhob3N0LCByLnN0ZG91dCwgci5zdGRlcnIsIHIuY29kZSk7XHJcbiAgICAgIH07XHJcbiAgICAgIGNvbnN0IFtnaXRodWIsIGF0b21naXRdID0gYXdhaXQgUHJvbWlzZS5hbGwoSE9TVFMubWFwKG9uZSkgYXMgW1Byb21pc2U8Rm9yZ2VIb3N0U3RhdHVzPiwgUHJvbWlzZTxGb3JnZUhvc3RTdGF0dXM+XSk7XHJcbiAgICAgIHJldHVybiB7IGdpdGh1YiwgYXRvbWdpdCB9O1xyXG4gICAgfSxcclxuXHJcbiAgICByZXBvczogYXN5bmMgKGhvc3QsIHBhZ2UpID0+XHJcbiAgICAgIGNsaUpzb24oaG9zdCwgYnVpbGRMaXN0QXJncygncmVwb3MnLCBob3N0LCAnJywgJ29wZW4nKSwgKHJvd3MpID0+IHtcclxuICAgICAgICBjb25zdCBhbGwgPSBub3JtYWxpemVSZXBvcyhob3N0LCByb3dzKTtcclxuICAgICAgICBjb25zdCBwID0gTWF0aC5tYXgoMSwgTWF0aC5taW4oMjAsIHBhZ2UpKTtcclxuICAgICAgICByZXR1cm4geyByZXBvczogYWxsLnNsaWNlKChwIC0gMSkgKiBQQUdFX1NJWkUsIHAgKiBQQUdFX1NJWkUpLCBoYXNNb3JlOiBhbGwubGVuZ3RoID4gcCAqIFBBR0VfU0laRSB9O1xyXG4gICAgICB9KSxcclxuXHJcbiAgICBwcnM6IChob3N0LCByZXBvLCBzdGF0ZSkgPT4gY2xpSnNvbihob3N0LCBidWlsZExpc3RBcmdzKCdwcnMnLCBob3N0LCByZXBvLCBzdGF0ZSksIChyb3dzKSA9PiAoeyBwcnM6IG5vcm1hbGl6ZVBycyhyb3dzKSB9KSksXHJcbiAgICBpc3N1ZXM6IChob3N0LCByZXBvLCBzdGF0ZSkgPT4gY2xpSnNvbihob3N0LCBidWlsZExpc3RBcmdzKCdpc3N1ZXMnLCBob3N0LCByZXBvLCBzdGF0ZSksIChyb3dzKSA9PiAoeyBpc3N1ZXM6IG5vcm1hbGl6ZUlzc3Vlcyhyb3dzKSB9KSksXHJcbiAgICByZWxlYXNlczogKGhvc3QsIHJlcG8pID0+IGNsaUpzb24oaG9zdCwgYnVpbGRMaXN0QXJncygncmVsZWFzZXMnLCBob3N0LCByZXBvLCAnb3BlbicpLCAocm93cykgPT4gKHsgcmVsZWFzZXM6IG5vcm1hbGl6ZVJlbGVhc2VzKGhvc3QsIHJvd3MpIH0pKSxcclxuXHJcbiAgICBhc3luYyBhY3Rpb24oa2luZCwgaG9zdCwgYSk6IFByb21pc2U8Rm9yZ2VPazx7IHVybDogc3RyaW5nIH0+PiB7XHJcbiAgICAgIGNvbnN0IGFyZ3MgPSBidWlsZEFjdGlvbkFyZ3Moa2luZCwgaG9zdCwgYSk7XHJcbiAgICAgIGlmIChhcmdzID09PSBudWxsKSByZXR1cm4gYmFkKCdCQURfUkVRVUVTVCcsIGBcdTUxOTlcdTY0Q0RcdTRGNUMgJHtraW5kfSBcdTUzQzJcdTY1NzBcdTRFMERcdTU0MDhcdTZDRDVgKTtcclxuICAgICAgLy8gXHU4REVGXHU1Rjg0XHU5NUU4OnVwbG9hZC9jbG9uZSBcdTc2ODRcdTY3MkNcdTU3MzBcdThERUZcdTVGODRcdTVGQzVcdTk4N0JcdTU3MjhcdTVERTVcdTRGNUNcdTUzM0EvXHU3NTI4XHU2MjM3XHU3NkVFXHU1RjU1XHU1MTg1XHU0RTE0XHU1QjU4XHU1NzI4XHJcbiAgICAgIGlmICgoa2luZCA9PT0gJ3JlbGVhc2VfdXBsb2FkJyB8fCBraW5kID09PSAncmVwb19jbG9uZScpICYmICF2YWxpZGF0ZUxvY2FsUGF0aChhLmZpbGUgPz8gYS5kaXIgPz8gJycsIHJvb3RzKCkpKSB7XHJcbiAgICAgICAgcmV0dXJuIGJhZCgnQkFEX1JFUVVFU1QnLCAnXHU2NTg3XHU0RUY2XHU4REVGXHU1Rjg0XHU1RkM1XHU5ODdCXHU0RjREXHU0RThFXHU3NTI4XHU2MjM3XHU3NkVFXHU1RjU1XHU2MjE2XHU1REYyXHU2Q0U4XHU1MThDXHU1REU1XHU0RjVDXHU1MzNBXHU1MTg1Jyk7XHJcbiAgICAgIH1cclxuICAgICAgY29uc3QgciA9IGF3YWl0IGRlcHMucnVuKENMSV9CSU5baG9zdF0sIGFyZ3MuZmlsdGVyKCh4KSA9PiB4ICE9PSAnJyksIENNRF9USU1FT1VUX01TKTtcclxuICAgICAgaWYgKHIudGltZWRPdXQpIHJldHVybiBiYWQoJ1RJTUVPVVQnLCBgJHtDTElfQklOW2hvc3RdfSAke2tpbmR9IFx1OEQ4NVx1NjVGNmApO1xyXG4gICAgICBpZiAoci5jb2RlICE9PSAwKSByZXR1cm4gYmFkKCdDTElfRVJST1InLCBgJHtraW5kfSBcdTU5MzFcdThEMjUoJHtyLmNvZGV9KTokeyhyLnN0ZGVyciB8fCByLnN0ZG91dCkudHJpbSgpLnNwbGl0KCdcXG4nKS5zbGljZSgtMykuam9pbignICcpfWApO1xyXG4gICAgICByZXR1cm4gb2soeyB1cmw6IGV4dHJhY3RVcmwoYCR7ci5zdGRvdXR9XFxuJHtyLnN0ZGVycn1gKSB9KTtcclxuICAgIH0sXHJcblxyXG4gICAgLyoqIFx1NzY3Qlx1NUY1NTpzcGF3biBcdTVCOThcdTY1QjkgT0F1dGggXHU2RDQxXHU3QTBCLHN0ZG91dCBcdTg4NENcdThGNkNcdTUzRDEgKyBVUkwgXHU1OTE2XHU1RjAwO1x1NEUwRFx1NjM1NVx1ODNCN1x1NEVGQlx1NEY1NVx1NEVFNFx1NzI0Q1x1MzAwMiAqL1xyXG4gICAgYXN5bmMgbG9naW4oaG9zdCk6IFByb21pc2U8Rm9yZ2VPazx7IHVybDogc3RyaW5nIH0+PiB7XHJcbiAgICAgIGNvbnN0IGFyZ3MgPSBob3N0ID09PSAnZ2l0aHViJyA/IFsnYXV0aCcsICdsb2dpbicsICctLXdlYicsICctLWdpdC1wcm90b2NvbCcsICdodHRwcycsICctLXNraXAtc3NoLWtleSddIDogWydhdXRoJywgJ2xvZ2luJ107XHJcbiAgICAgIGxldCBvcGVuZWQgPSAnJztcclxuICAgICAgY29uc3QgciA9IGF3YWl0IGRlcHMucnVuKENMSV9CSU5baG9zdF0sIGFyZ3MsIExPR0lOX1RJTUVPVVRfTVMsIChsaW5lKSA9PiB7XHJcbiAgICAgICAgb3B0cy5vbkxvZ2luTGluZT8uKGhvc3QsIGxpbmUpO1xyXG4gICAgICAgIGNvbnN0IHVybCA9IGV4dHJhY3RVcmwobGluZSk7XHJcbiAgICAgICAgLy8gXHU3QjJDXHU0RTAwXHU0RTJBIFVSTCA9IFx1OEJCRVx1NTkwN1x1NjM4OFx1Njc0M1x1OTg3NTpcdTgxRUFcdTUyQThcdTU5MTZcdTVGMDAoXHU0RUZCXHU1MkExXHU0RTY2Olx1NTkxNlx1NUYwMFx1N0NGQlx1N0VERlx1NkQ0Rlx1ODlDOFx1NTY2OCk7XHU1NDBFXHU3RUVEXHU4ODRDXHU1M0VBXHU1QzU1XHU3OTNBXHJcbiAgICAgICAgaWYgKHVybCAhPT0gJycgJiYgb3BlbmVkID09PSAnJykgeyBvcGVuZWQgPSB1cmw7IG9wdHMub3BlbkV4dGVybmFsPy4odXJsKTsgfVxyXG4gICAgICB9KTtcclxuICAgICAgaWYgKHIudGltZWRPdXQpIHJldHVybiBiYWQoJ1RJTUVPVVQnLCBgXHU3NjdCXHU1RjU1XHU4RDg1XHU2NUY2KCR7TWF0aC5yb3VuZChMT0dJTl9USU1FT1VUX01TIC8gNjBfMDAwKX0gXHU1MjA2XHU5NDlGKWApO1xyXG4gICAgICAvLyBcdTkwMDBcdTUxRkFcdTc4MDFcdTk3NUUgMCBcdTRFMERcdTRFMDBcdTVCOUFcdTU5MzFcdThEMjUoXHU3NTI4XHU2MjM3IEN0cmwtQyk7XHU0RUU1XHU0RThCXHU1NDBFXHU3Njg0IGZvcmdlOnN0YXR1cyBcdThGNkVcdThCRTJcdTRFM0FcdTUxQzZcclxuICAgICAgcmV0dXJuIG9rKHsgdXJsOiBvcGVuZWQgfSk7XHJcbiAgICB9LFxyXG5cclxuICAgIHJlc29sdmUocGF0aCkge1xyXG4gICAgICBjb25zdCBwID0gY2hlY2tTdHIocGF0aCwgMV8wMDApO1xyXG4gICAgICBpZiAocCA9PT0gJycgfHwgIWV4aXN0c1N5bmMocCkpIHJldHVybiBudWxsO1xyXG4gICAgICByZXR1cm4gcmVzb2x2ZVJlcG9PZihwKTtcclxuICAgIH0sXHJcbiAgfTtcclxufVxyXG5cclxuZXhwb3J0IGludGVyZmFjZSBGb3JnZVNlcnZpY2Uge1xyXG4gIHN0YXR1cygpOiBQcm9taXNlPEZvcmdlU3RhdHVzPjtcclxuICByZXBvcyhob3N0OiBGb3JnZUhvc3QsIHBhZ2U6IG51bWJlcik6IFByb21pc2U8Rm9yZ2VPazx7IHJlcG9zOiBGb3JnZVJlcG9bXTsgaGFzTW9yZTogYm9vbGVhbiB9Pj47XHJcbiAgcHJzKGhvc3Q6IEZvcmdlSG9zdCwgcmVwbzogc3RyaW5nLCBzdGF0ZTogc3RyaW5nKTogUHJvbWlzZTxGb3JnZU9rPHsgcHJzOiBGb3JnZVByW10gfT4+O1xyXG4gIGlzc3Vlcyhob3N0OiBGb3JnZUhvc3QsIHJlcG86IHN0cmluZywgc3RhdGU6IHN0cmluZyk6IFByb21pc2U8Rm9yZ2VPazx7IGlzc3VlczogRm9yZ2VJc3N1ZVtdIH0+PjtcclxuICByZWxlYXNlcyhob3N0OiBGb3JnZUhvc3QsIHJlcG86IHN0cmluZyk6IFByb21pc2U8Rm9yZ2VPazx7IHJlbGVhc2VzOiBGb3JnZVJlbGVhc2VbXSB9Pj47XHJcbiAgYWN0aW9uKGtpbmQ6IEZvcmdlQWN0aW9uS2luZCwgaG9zdDogRm9yZ2VIb3N0LCBhOiBGb3JnZUFjdGlvbkFyZ3MpOiBQcm9taXNlPEZvcmdlT2s8eyB1cmw6IHN0cmluZyB9Pj47XHJcbiAgbG9naW4oaG9zdDogRm9yZ2VIb3N0KTogUHJvbWlzZTxGb3JnZU9rPHsgdXJsOiBzdHJpbmcgfT4+O1xyXG4gIHJlc29sdmUocGF0aDogc3RyaW5nKTogeyBob3N0OiBGb3JnZUhvc3Q7IHJlcG86IHN0cmluZyB9IHwgbnVsbDtcclxufVxyXG5cclxuLyogLS0tLSBVSVZFUklGWSBmaXh0dXJlcyhmYWtlIFx1NjU3MFx1NjM2RVx1NkNFOFx1NTE2NTtcdTRFMERcdTc4QjBcdTc4QzFcdTc2RDgvXHU3RjUxXHU3RURDL1x1NTFFRFx1NjM2RSkgLS0tLSAqL1xyXG5leHBvcnQgZnVuY3Rpb24gZm9yZ2VGaXh0dXJlcygpIHtcclxuICByZXR1cm4ge1xyXG4gICAgc3RhdHVzOiB7XHJcbiAgICAgIGdpdGh1YjogeyBpbnN0YWxsZWQ6IHRydWUsIGxvZ2dlZDogdHJ1ZSwgdXNlcjogJ3N3c2dibCcgfSxcclxuICAgICAgLy8gXHU2NUUwIENMSSBcdTYzMDdcdTVGMTVcdTYwMDE6YXRvbWdpdCBcdTUzNjFcdTVDNTVcdTc5M0FcdTVCODlcdTg4QzVcdTYzMDdcdTVGMTUoXHU1MzU1XHU2RDRCXHU2NUFEXHU4QTAwXCJcdTRFMERcdTgxRUFcdTUyQThcdTg4QzVcIilcclxuICAgICAgYXRvbWdpdDogeyBpbnN0YWxsZWQ6IGZhbHNlLCBsb2dnZWQ6IGZhbHNlLCB1c2VyOiAnJyB9LFxyXG4gICAgfSBzYXRpc2ZpZXMgRm9yZ2VTdGF0dXMsXHJcbiAgICByZXBvczogKGhvc3Q6IEZvcmdlSG9zdCk6IHsgcmVwb3M6IEZvcmdlUmVwb1tdOyBoYXNNb3JlOiBib29sZWFuIH0gPT4gKHtcclxuICAgICAgcmVwb3M6IGhvc3QgPT09ICdnaXRodWInXHJcbiAgICAgICAgPyBbXHJcbiAgICAgICAgICAgIHsgbmFtZTogJ2htaC1kZXNrdG9wJywgZnVsbE5hbWU6ICdzd3NnYmwvaG1oLWRlc2t0b3AnLCBpc1ByaXZhdGU6IGZhbHNlLCB1cGRhdGVkQXQ6ICcyMDI2LTEwLTI5VDIzOjQxOjA0WicsIHVybDogJ2h0dHBzOi8vZ2l0aHViLmNvbS9zd3NnYmwvaG1oLWRlc2t0b3AnLCBkZXNjcmlwdGlvbjogJ0hNSCBEZXNrdG9wKG1vbm9yZXBvKScgfSxcclxuICAgICAgICAgICAgeyBuYW1lOiAnYWktbGVhcm5pbmctb3MnLCBmdWxsTmFtZTogJ3N3c2dibC9haS1sZWFybmluZy1vcycsIGlzUHJpdmF0ZTogdHJ1ZSwgdXBkYXRlZEF0OiAnMjAyNi0xMC0yOVQxNToyOTo1MlonLCB1cmw6ICdodHRwczovL2dpdGh1Yi5jb20vc3dzZ2JsL2FpLWxlYXJuaW5nLW9zJywgZGVzY3JpcHRpb246ICdBSSBsZWFybmluZyBPUycgfSxcclxuICAgICAgICAgIF1cclxuICAgICAgICA6IFtcclxuICAgICAgICAgICAgeyBuYW1lOiAnaG1oLWRlc2t0b3AnLCBmdWxsTmFtZTogJ2hvbmdmdS9obWgtZGVza3RvcCcsIGlzUHJpdmF0ZTogZmFsc2UsIHVwZGF0ZWRBdDogJzIwMjYtMTAtMjlUMjI6NDE6NDkrMDg6MDAnLCB1cmw6ICdodHRwczovL2F0b21naXQuY29tL2hvbmdmdS9obWgtZGVza3RvcCcsIGRlc2NyaXB0aW9uOiAnSE1IIERlc2t0b3AoYXRvbWdpdCBcdTk1NUNcdTUwQ0ZcdTRFRDMpJyB9LFxyXG4gICAgICAgICAgXSxcclxuICAgICAgaGFzTW9yZTogZmFsc2UsXHJcbiAgICB9KSxcclxuICAgIHByczogeyBwcnM6IFt7IG51bWJlcjogJzExJywgdGl0bGU6ICdmZWF0KGRlc2t0b3ApOiBcdTRFRDNcdTVFOTNcdTk3NjJcdTY3N0YoXHU5QThDXHU2NTM2IGZpeHR1cmUpJywgc3RhdGU6ICdvcGVuJywgaXNEcmFmdDogZmFsc2UsIHVwZGF0ZWRBdDogJzIwMjYtMTAtMzBUMDk6MDA6MDBaJywgdXJsOiAnaHR0cHM6Ly9naXRodWIuY29tL3N3c2dibC9obWgtZGVza3RvcC9wdWxsLzExJyB9XSB9LFxyXG4gICAgaXNzdWVzOiB7IGlzc3VlczogW3sgbnVtYmVyOiAnNCcsIHRpdGxlOiAnXHU0RUQzXHU1RTkzXHU5NzYyXHU2NzdGXHU5QThDXHU2NTM2IGZpeHR1cmUgaXNzdWUnLCBzdGF0ZTogJ29wZW4nLCB1cGRhdGVkQXQ6ICcyMDI2LTEwLTMwVDA5OjAwOjAwWicsIHVybDogJ2h0dHBzOi8vZ2l0aHViLmNvbS9zd3NnYmwvaG1oLWRlc2t0b3AvaXNzdWVzLzQnIH1dIH0sXHJcbiAgICByZWxlYXNlczogeyByZWxlYXNlczogW3sgdGFnOiAndjAuMi4xMCcsIG5hbWU6ICd2MC4yLjEwIFx1MjAxNCBcdTY2RjRcdTY1QjBcdTU2NjggYXRvbWdpdCBcdTU2RkRcdTUxODVcdTk5OTZcdTkwMDkrXHU1NDBFXHU1M0YwXHU5NzU5XHU5RUQ4XHU2NkY0XHU2NUIwJywgY3JlYXRlZEF0OiAnMjAyNi0xMC0yOVQyMzozNzowOSswODowMCcsIGlzRHJhZnQ6IGZhbHNlLCBpc1ByZXJlbGVhc2U6IGZhbHNlIH1dIH0sXHJcbiAgICBhY3Rpb246IHsgb2s6IHRydWUgYXMgY29uc3QsIGRhdGE6IHsgdXJsOiAnaHR0cHM6Ly9leGFtcGxlLmludmFsaWQvZm9yZ2UtZml4dHVyZScgfSB9LFxyXG4gICAgbG9naW46IHsgb2s6IHRydWUgYXMgY29uc3QsIGRhdGE6IHsgdXJsOiAnaHR0cHM6Ly9leGFtcGxlLmludmFsaWQvZm9yZ2UtbG9naW4tZml4dHVyZScgfSB9LFxyXG4gICAgcmVzb2x2ZTogeyBob3N0OiAnZ2l0aHViJyBhcyBGb3JnZUhvc3QsIHJlcG86ICdzd3NnYmwvaG1oLWRlc2t0b3AnIH0sXHJcbiAgfTtcclxufVxyXG4iXSwKICAibWFwcGluZ3MiOiAiO0FBY0EsU0FBUyxPQUFBQSxNQUFLLGVBQWUsUUFBUSxTQUFTLFNBQVMsT0FBTyxNQUFNLGNBQWMsTUFBTSxhQUFhLG1CQUFtQjtBQUN4SCxTQUFTLFFBQUFDLE9BQU0sV0FBQUMsVUFBUyxVQUFVLGNBQUFDLGFBQVksZUFBZTtBQUM3RCxTQUFTLGNBQUFDLGFBQVksZ0JBQUFDLGVBQWMsZ0JBQUFDLHFCQUFvQjtBQUN2RCxTQUFTLHlCQUF5QjtBQUNsQyxTQUFTLGFBQUFDLFlBQVcsVUFBVSxNQUFNLGNBQWM7QUFDbEQsU0FBUyxXQUFBQyxVQUFTLHlCQUF5QjtBQUMzQyxTQUFTLGdCQUFBQyxlQUFjLFNBQUFDLGNBQWE7QUFDcEMsU0FBUyxp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QVUsV0FBVztBQUN6RCxRQUFFLGVBQWU7QUFDakIsZ0JBQVUsTUFBTTtBQUNoQixXQUFLLFdBQVcsS0FBSyxFQUFFLFFBQVEsTUFBTUEsS0FBSSxLQUFLLENBQUM7QUFBQSxJQUNqRDtBQUFBLEVBQ0YsQ0FBQztBQUNELEVBQUFBLEtBQUksR0FBRyxxQkFBcUIsTUFBTTtBQUNoQyxRQUFJLFFBQVEsYUFBYSxTQUFVLENBQUFBLEtBQUksS0FBSztBQUFBLEVBQzlDLENBQUM7QUFDSDtBQWhrRFc7QUF5QkE7QUFPQTtBQWVBO0FBNEJBO0FBOEpBO0FBc0JBO0FBNEJBO0FBNERBO0FBVUE7QUFnQkE7QUFnQkE7QUFlQTtBQTJFQTtBQU9BO0FBUUE7QUFXQTtBQWtFQTtBQUtBO0FBaUJBO0FBS0E7QUFZQTtBQW9CQTtBQW9IQTtBQVlBO0FBK0JBO0FBaUJBOyIsCiAgIm5hbWVzIjogWyJhcHAiLCAiam9pbiIsICJkaXJuYW1lIiwgImlzQWJzb2x1dGUiLCAiZXhpc3RzU3luYyIsICJyZWFscGF0aFN5bmMiLCAicmVhZEZpbGVTeW5jIiwgIndyaXRlRmlsZSIsICJob21lZGlyIiwgImV4ZWNGaWxlU3luYyIsICJzcGF3biIsICJwYXRoVG9GaWxlVVJMIiwgInMiLCAicmVzb2x2ZSIsICJyYW5kb21VVUlEIiwgInJhbmRvbVVVSUQiLCAicyIsICJyZXNvbHZlIiwgImIiLCAib2siLCAiYXBwIiwgIm1rZGlyIiwgIndyaXRlRmlsZSIsICJqb2luIiwgInNsZWVwIiwgInNwYXduIiwgImpvaW4iLCAiYiIsICJzIiwgImpvaW4iLCAib2siLCAicmVzb2x2ZSIsICJzcGF3biIsICJqb2luIiwgImIiLCAicyIsICJiIiwgInNwYXduIiwgImV4aXN0c1N5bmMiLCAiaG9tZWRpciIsICJqb2luIiwgInJlc29sdmUiLCAiYmFzZSIsICJqb2luIiwgInMiLCAiYXBwIiwgInB1c2hFdmVudCIsICJub3RpZnlFdmVudCIsICJmb2N1c01haW5XaW5kb3ciLCAic2V0dXBUcmF5IiwgImFwcGx5Q2hyb21lIiwgImFwcGx5VXBkYXRlIiwgImRpcm5hbWUiLCAic3Bhd24iLCAiYnVpbGRBcHBNZW51IiwgInBvcHVwTWFpbk1lbnUiLCAid2ViQXV0b3N0YXJ0SW5zdGFsbGVkIiwgImV4aXN0c1N5bmMiLCAibGFuSXBPZiIsICJjbGlFbnRyeU9mIiwgInJlcG9Sb290T2YiLCAicGtnTmFtZUF0IiwgInJ1bkNsaSIsICJicm9hZGNhc3RIb3N0U3RhdGUiLCAicGtnVmVyc2lvbkF0IiwgInJlYWRGaWxlU3luYyIsICJlbnRyeUZyb21DbGlEaXIiLCAiZGV0ZWN0RXh0ZXJuYWxSdW50aW1lIiwgImlzQWJzb2x1dGUiLCAiZXhlY0ZpbGVTeW5jIiwgInJlYWxwYXRoU3luYyIsICJob21lZGlyIiwgImRldGVjdFJlYWxFbnRyeSIsICJidW5kbGVkUnVudGltZVBhdGgiLCAiYnVuZGxlZFJ1bnRpbWVJbmZvIiwgIm5wbU9uUGF0aCIsICJ3aXphcmRTdXBwcmVzc2VkIiwgInNlbmRlclRydXN0ZWQiLCAiaG9zdENhbGwiLCAiZm9yZ2VTdmMiLCAicmVnaXN0ZXJJcGMiLCAid3JpdGVGaWxlIiwgInciLCAicGF0aFRvRmlsZVVSTCIsICJvayIsICJhcHAyIl0KfQo=
