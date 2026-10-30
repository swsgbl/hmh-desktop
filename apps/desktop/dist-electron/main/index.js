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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vZWxlY3Ryb24vbWFpbi9pbmRleC50cyIsICIuLi8uLi8uLi8uLi9wYWNrYWdlcy9ob3N0LWFkYXB0ZXIvc3JjL3N1cGVydmlzb3IudHMiLCAiLi4vLi4vLi4vLi4vcGFja2FnZXMvY29udHJhY3RzL3NyYy9ldmVudC50cyIsICIuLi8uLi8uLi8uLi9wYWNrYWdlcy9jb250cmFjdHMvc3JjL2Vycm9yLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2NvbnRyYWN0cy9zcmMvZ3VhcmRzLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2hvc3QtYWRhcHRlci9zcmMvY2xpZW50LnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2hvc3QtYWRhcHRlci9zcmMvZmFrZS1ob3N0LnRzIiwgIi4uLy4uL2VsZWN0cm9uL21haW4vdWl2ZXJpZnkudHMiLCAiLi4vLi4vZWxlY3Ryb24vbWFpbi92aXN1YWxyZWdyZXNzaW9uLnRzIiwgIi4uLy4uL2VsZWN0cm9uL21haW4vaW5zdGFsbGVyLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2NsaS1pbnN0YWxsZXIvc3JjL2luZGV4LnRzIiwgIi4uLy4uL2VsZWN0cm9uL21haW4vdXBkYXRlci1jaGFubmVscy50cyIsICIuLi8uLi9lbGVjdHJvbi9tYWluL2ZvcmdlLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcclxuICogSE1IIERlc2t0b3AgXHUyMDE0IEVsZWN0cm9uIFx1NEUzQlx1OEZEQlx1N0EwQihBRFItMDAxLzAwMy8wMDQpXHUzMDAyXHJcbiAqXHJcbiAqIFx1NUI4OVx1NTE2OFx1NEUwRFx1NTNEOFx1OTFDRihcdTVGMDBcdTUzRDFcdThCQTFcdTUyMTIgTTAgXHU1MUZBXHU1M0UzXHU5NUU4ICsgRWxlY3Ryb24gXHU1Qjk4XHU2NUI5XHU1Qjg5XHU1MTY4XHU2RTA1XHU1MzU1KTpcclxuICogIC0gcmVuZGVyZXI6Y29udGV4dElzb2xhdGlvbiArIHNhbmRib3ggKyBcdTc5ODEgbm9kZUludGVncmF0aW9uLFx1NEUyNVx1NjgzQyBDU1A7XHJcbiAqICAtIFx1NUJGQ1x1ODIyQS9cdTY1QjBcdTdBOTdcdTUzRTNcdTRFMDBcdTVGOEJcdTYyRDJcdTdFREQoXHU1M0VBXHU1MkEwXHU4RjdEXHU2MjExXHU0RUVDXHU4MUVBXHU1REYxXHU3Njg0IHJlbmRlcmVyKTtcclxuICogIC0gXHU2QkNGXHU2NzYxIElQQyBcdTY4MjFcdTlBOEMgc2VuZGVyIFx1NzY4NFx1OTg3Nlx1NUM0MiBmcmFtZSBVUkwgXHU1QzVFXHU0RThFXHU2NzJDXHU1RTk0XHU3NTI4LFx1OTAxQVx1OTA1M1x1NzY3RFx1NTQwRFx1NTM1NTtcclxuICogIC0gaG9zdCB0b2tlbiBcdTUzRUFcdTVCNThcdTU3MjhcdTRFOEVcdTY3MkNcdThGREJcdTdBMEJcdTRFMEVcdTVCNTBcdThGREJcdTdBMEIgZW52LFx1NjVFNVx1NUZEN1x1OEY5M1x1NTFGQVx1NTI0RFx1NTE0OFx1ODEzMVx1NjU0RjtcclxuICogIC0gXHU1MzU1XHU1QjlFXHU0RjhCXHU5NTAxO1x1OTAwMFx1NTFGQVx1NjVGNlx1NTNFQVx1NTA1Q1x1NkI2Mlx1ODFFQVx1NURGMSBzcGF3biBcdTc2ODQgaG9zdChcdTRGMThcdTk2QzVcdTIxOTJcdTUxNUNcdTVFOTUga2lsbClcdTMwMDJcclxuICpcclxuICogXHU5NjM2XHU2QkI1RSgyMDI2LTEwLTEwKTptYWluIFx1NjMwMVx1NjcwOSBEZXNrdG9wSG9zdENsaWVudCxTU0UgXHU0RkUxXHU1QzAxXHU2RDQxKGV2ZW50OiBobWgpXHJcbiAqIFx1N0VDRiA1MG1zIFx1NjI3OVx1OTFDRlx1NjNBOFx1N0VEOSByZW5kZXJlcjtzZW5kVGFzay9hcHByb3ZlL2ludGVycnVwdC9zZXNzaW9ucyBcdTUxNjhcdTkwRThcdThGNkNcdTUzRDFcclxuICogXHU3RUQ5IGhvc3QgXHUyMDE0XHUyMDE0IGZha2UgXHU0RTBFXHU3NzFGXHU1QjlFIGhtaGFybmVzcyBkZXNrdG9wLWhvc3QgXHU4RDcwXHU1NDBDXHU0RTAwXHU2NzYxXHU0RUUzXHU3ODAxXHU4REVGXHU1Rjg0XHUzMDAyXHJcbiAqL1xyXG5pbXBvcnQgeyBhcHAsIEJyb3dzZXJXaW5kb3csIGRpYWxvZywgaXBjTWFpbiwgc2Vzc2lvbiwgc2hlbGwsIFRyYXksIE5vdGlmaWNhdGlvbiwgTWVudSwgbmF0aXZlSW1hZ2UsIG5hdGl2ZVRoZW1lIH0gZnJvbSAnZWxlY3Ryb24nO1xyXG5pbXBvcnQgeyBqb2luLCBkaXJuYW1lLCBiYXNlbmFtZSwgaXNBYnNvbHV0ZSwgcmVzb2x2ZSB9IGZyb20gJ25vZGU6cGF0aCc7XHJcbmltcG9ydCB7IGV4aXN0c1N5bmMsIHJlYWxwYXRoU3luYywgcmVhZEZpbGVTeW5jIH0gZnJvbSAnbm9kZTpmcyc7XHJcbmltcG9ydCB7IGNyZWF0ZVdyaXRlU3RyZWFtIH0gZnJvbSAnbm9kZTpmcyc7XHJcbmltcG9ydCB7IHdyaXRlRmlsZSwgcmVhZEZpbGUsIHN0YXQsIHJlbmFtZSB9IGZyb20gJ25vZGU6ZnMvcHJvbWlzZXMnO1xyXG5pbXBvcnQgeyBob21lZGlyLCBuZXR3b3JrSW50ZXJmYWNlcyB9IGZyb20gJ25vZGU6b3MnO1xyXG5pbXBvcnQgeyBleGVjRmlsZVN5bmMsIHNwYXduIH0gZnJvbSAnbm9kZTpjaGlsZF9wcm9jZXNzJztcclxuaW1wb3J0IHsgcGF0aFRvRmlsZVVSTCB9IGZyb20gJ25vZGU6dXJsJztcclxuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gJ25vZGU6Y3J5cHRvJztcclxuaW1wb3J0IHsgRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yLCBEZXNrdG9wSG9zdENsaWVudCwgZW52ZWxvcGVGcm9tRnJhbWUsIHR5cGUgSG9zdFN0YXRlIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2hvc3QtYWRhcHRlcic7XHJcbmltcG9ydCB7IGlzRXZlbnRFbnZlbG9wZSwgdHlwZSBFdmVudEVudmVsb3BlIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyc7XHJcbmltcG9ydCB7IGF0dGFjaFVpVmVyaWZ5IH0gZnJvbSAnLi91aXZlcmlmeS50cyc7XHJcbmltcG9ydCB7IGF0dGFjaFZpc3VhbFJlZ3Jlc3Npb24gfSBmcm9tICcuL3Zpc3VhbHJlZ3Jlc3Npb24udHMnO1xyXG5pbXBvcnQgeyBpbnN0YWxsVGFyZ2V0LCByZXNvbHZlSW5zdGFsbGVkRW50cnksIHN0YXJ0Q2xpSW5zdGFsbCwgdHlwZSBJbnN0YWxsUHJvZ3Jlc3MgfSBmcm9tICcuL2luc3RhbGxlci50cyc7XHJcbmltcG9ydCB7IG9yZGVyZWRDaGVja0NoYW5uZWxzLCBkb3dubG9hZENhbmRpZGF0ZXMsIG5vcm1hbGl6ZUNoYW5uZWwsIG5vcm1hbGl6ZVJlbGVhc2UsIHBpY2tJbnN0YWxsZXJBc3NldCwgc2l6ZU1hdGNoZXMsIHN1bW1hcml6ZUNoZWNrRmFpbHVyZXMsIGNtcFZlcnNpb24sIHR5cGUgTGF0ZXN0UmVsZWFzZSwgdHlwZSBSZWxlYXNlQXNzZXQsIHR5cGUgVXBkYXRlQ2hhbm5lbElkLCB0eXBlIFVwZGF0ZVJlcG9zIH0gZnJvbSAnLi91cGRhdGVyLWNoYW5uZWxzLnRzJztcclxuaW1wb3J0IHsgY3JlYXRlRm9yZ2UsIGZvcmdlRml4dHVyZXMsIGNoZWNrSG9zdCwgY2hlY2tSZXBvLCBjaGVja1N0YXRlLCB0eXBlIEZvcmdlQWN0aW9uS2luZCwgdHlwZSBGb3JnZUhvc3QsIHR5cGUgRm9yZ2VTZXJ2aWNlIH0gZnJvbSAnLi9mb3JnZS50cyc7XHJcblxyXG5jb25zdCBoZXJlID0gaW1wb3J0Lm1ldGEuZGlybmFtZSA/PyAnLic7XHJcbmNvbnN0IGlzRGV2ID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfREVWID09PSAnMSc7XHJcbmNvbnN0IHJlbmRlcmVyRGV2VXJsID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfUkVOREVSRVJfVVJMID8/ICcnO1xyXG5jb25zdCBwcmVsb2FkUGF0aCA9IGpvaW4oaGVyZSwgJy4uL3ByZWxvYWQvaW5kZXguY2pzJyk7XHJcblxyXG4vKiAtLS0tIFx1NjVFNVx1NUZEN1x1ODEzMVx1NjU0Rjp0b2tlbi9hdXRob3JpemF0aW9uIFx1NkMzOFx1NEUwRFx1OEZEQlx1NjNBN1x1NTIzNlx1NTNGMCAtLS0tICovXHJcbmNvbnN0IHNlY3JldHM6IHN0cmluZ1tdID0gW107XHJcbmZ1bmN0aW9uIHJlZGFjdChzOiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gIGxldCBvdXQgPSBzO1xyXG4gIGZvciAoY29uc3Qgc2VjIG9mIHNlY3JldHMpIHtcclxuICAgIGlmIChzZWMubGVuZ3RoID49IDgpIG91dCA9IG91dC5zcGxpdChzZWMpLmpvaW4oJ1tyZWRhY3RlZF0nKTtcclxuICB9XHJcbiAgcmV0dXJuIG91dDtcclxufVxyXG5mdW5jdGlvbiBsb2dJbmZvKHRhZzogc3RyaW5nLCBtc2c6IHN0cmluZyk6IHZvaWQge1xyXG4gIGNvbnNvbGUubG9nKGBbaG1oLWRlc2t0b3A6JHt0YWd9XSAke3JlZGFjdChtc2cpfWApO1xyXG59XHJcblxyXG4vKiAtLS0tIFx1NTM1NVx1NUI5RVx1NEY4QiAtLS0tICovXHJcbmlmICghYXBwLnJlcXVlc3RTaW5nbGVJbnN0YW5jZUxvY2soKSkge1xyXG4gIGFwcC5xdWl0KCk7XHJcbn0gZWxzZSB7XHJcbiAgYXBwLm9uKCdzZWNvbmQtaW5zdGFuY2UnLCAoKSA9PiB7XHJcbiAgICBjb25zdCB3aW4gPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKVswXTtcclxuICAgIGlmICh3aW4pIHtcclxuICAgICAgaWYgKHdpbi5pc01pbmltaXplZCgpKSB3aW4ucmVzdG9yZSgpO1xyXG4gICAgICB3aW4uZm9jdXMoKTtcclxuICAgIH1cclxuICB9KTtcclxuXHJcbiAgLyogLS0tLSBob3N0IFx1NzZEMVx1N0JBMSArIFx1Njg2NVx1NUJBMlx1NjIzN1x1N0FFRiAtLS0tICovXHJcbiAgaW50ZXJmYWNlIEJyaWRnZVNuYXBzaG90IHtcclxuICAgIGhvc3RTdGF0ZTogSG9zdFN0YXRlO1xyXG4gICAgaG9zdFBvcnQ6IG51bWJlciB8IG51bGw7XHJcbiAgICBob3N0VmVyc2lvbjogc3RyaW5nIHwgbnVsbDtcclxuICAgIGxhc3RFcnJvcjogc3RyaW5nIHwgbnVsbDtcclxuICAgIG1vZGU6ICdmYWtlJyB8ICdyZWFsJztcclxuICAgIHJ1bnRpbWVFbnRyeTogc3RyaW5nIHwgbnVsbDtcclxuICB9XHJcbiAgbGV0IHN1cGVydmlzb3I6IERlc2t0b3BSdW50aW1lU3VwZXJ2aXNvciB8IG51bGwgPSBudWxsO1xyXG4gIGxldCBjbGllbnQ6IERlc2t0b3BIb3N0Q2xpZW50IHwgbnVsbCA9IG51bGw7XHJcbiAgbGV0IGJyaWRnZTogQnJpZGdlU25hcHNob3QgPSB7IGhvc3RTdGF0ZTogJ3N0b3BwZWQnLCBob3N0UG9ydDogbnVsbCwgaG9zdFZlcnNpb246IG51bGwsIGxhc3RFcnJvcjogbnVsbCwgbW9kZTogJ2Zha2UnLCBydW50aW1lRW50cnk6IG51bGwgfTtcclxuICAvKiogXHU0RThCXHU0RUY2XHU2Mjc5XHU5MUNGXHU3RjEzXHU1MUIyOlx1OUFEOFx1OTg5MSBTU0UgXHU0RTBEXHU5MDEwXHU2NzYxXHU4RkM3IElQQyw1MG1zIFx1NjI3OVx1OTFDRiBmbHVzaChcdTZFMzJcdTY3RDNcdTRFMERcdTUzNjEpXHUzMDAyICovXHJcbiAgbGV0IGV2ZW50QnVmZmVyOiBFdmVudEVudmVsb3BlW10gPSBbXTtcclxuICBsZXQgZmx1c2hUaW1lcjogTm9kZUpTLlRpbWVvdXQgfCBudWxsID0gbnVsbDtcclxuICBsZXQgc3NlQWJvcnQ6IEFib3J0Q29udHJvbGxlciB8IG51bGwgPSBudWxsO1xyXG4gIGxldCBsYXN0RXZlbnRJZCA9ICcnO1xyXG4gIC8qKiBcdTY3MkFcdTc3RTUvXHU3NTc4XHU1RjYyXHU0RkUxXHU1QzAxXHU4QkExXHU2NTcwKFNDSEVNQV9NSVNNQVRDSCBcdTk3NjJcdTU0MTFcdThCQ0FcdTY1QUQsXHU0RTBEXHU1RDI5KVx1MzAwMiAqL1xyXG4gIGxldCBkcm9wcGVkRnJhbWVzID0gMDtcclxuXHJcbiAgZnVuY3Rpb24gcHVzaEV2ZW50KGVudjogRXZlbnRFbnZlbG9wZSk6IHZvaWQge1xyXG4gICAgZXZlbnRCdWZmZXIucHVzaChlbnYpO1xyXG4gICAgaWYgKGV2ZW50QnVmZmVyLmxlbmd0aCA+IDJfMDAwKSBldmVudEJ1ZmZlci5zcGxpY2UoMCwgZXZlbnRCdWZmZXIubGVuZ3RoIC0gMl8wMDApO1xyXG4gICAgaWYgKGZsdXNoVGltZXIgPT09IG51bGwpIHtcclxuICAgICAgZmx1c2hUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xyXG4gICAgICAgIGZsdXNoVGltZXIgPSBudWxsO1xyXG4gICAgICAgIGNvbnN0IGJhdGNoID0gZXZlbnRCdWZmZXI7XHJcbiAgICAgICAgZXZlbnRCdWZmZXIgPSBbXTtcclxuICAgICAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcclxuICAgICAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ2JyaWRnZTpldmVudC1iYXRjaCcsIGJhdGNoKTtcclxuICAgICAgICB9XHJcbiAgICAgIH0sIDUwKTtcclxuICAgIH1cclxuICAgIG5vdGlmeUV2ZW50KGVudik7XHJcbiAgfVxyXG5cclxuICAvKiAtLS0tIFx1N0NGQlx1N0VERlx1NjI1OFx1NzZEOCArIFx1OTAxQVx1NzdFNSgwMyBcdTUzRjcgXHUwMEE3XHU0RTAwOlx1Njg0Q1x1OTc2Mlx1NEVBN1x1NTRDMVx1OTcwMFx1ODk4MVx1N0NGQlx1N0VERlx1NjI1OFx1NzZEOFx1MzAwMVx1OTAxQVx1NzdFNSkgLS0tLVxyXG4gICAgIFx1NUJBMVx1NjI3OVx1N0I0OVx1NUY4NVx1NUZDNVx1OTg3Qlx1NjI1M1x1NjI3MChcdTc1MjhcdTYyMzdcdTVGQzVcdTk4N0JcdTUxQjNcdTdCNTYpO1x1NUI4Q1x1NjIxMC9cdTU5MzFcdThEMjVcdTRFQzVcdTU3MjhcdTdBOTdcdTUzRTNcdTU5MzFcdTcxMjZcdTY1RjZcdTYzRDBcdTkxOTJcdTMwMDIgKi9cclxuICBjb25zdCBUUkFZX0lDT05fQkFTRTY0ID0gJ2lWQk9SdzBLR2dvQUFBQU5TVWhFVWdBQUFCQUFBQUFRQ0FZQUFBQWY4LzloQUFBQVIwbEVRVlI0bkdOZ1FBUFNzb3IvOFdGMDlVUnJ4R3NRcVpveERJRUo2RGQrQjJOMGhiakVNV3duMVFDd0lZUFRBRnlZZmdZTWZCaVFaQURGQ1lrcVNabml6RVJKZGdZQWxMNXJzRGMyYVRjQUFBQUFTVVZPUks1Q1lJST0nO1xyXG4gIGxldCB0cmF5OiBUcmF5IHwgbnVsbCA9IG51bGw7XHJcbiAgY29uc3Qgc2VuZE1lbnVBY3Rpb24gPSAoYTogc3RyaW5nKTogdm9pZCA9PiB7XHJcbiAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcclxuICAgICAgaWYgKCF3LmlzRGVzdHJveWVkKCkpIHcud2ViQ29udGVudHMuc2VuZCgnbWVudTphY3Rpb24nLCBhKTtcclxuICAgIH1cclxuICB9O1xyXG4gIGZ1bmN0aW9uIGZvY3VzTWFpbldpbmRvdygpOiB2b2lkIHtcclxuICAgIGNvbnN0IHdpbiA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmZpbmQoKHcpID0+ICF3LmlzRGVzdHJveWVkKCkpO1xyXG4gICAgaWYgKHdpbiA9PT0gdW5kZWZpbmVkKSByZXR1cm47XHJcbiAgICBpZiAod2luLmlzTWluaW1pemVkKCkpIHdpbi5yZXN0b3JlKCk7XHJcbiAgICB3aW4uc2hvdygpO1xyXG4gICAgd2luLmZvY3VzKCk7XHJcbiAgfVxyXG4gIGZ1bmN0aW9uIHNldHVwVHJheSgpOiB2b2lkIHtcclxuICAgIGlmICh0cmF5ICE9PSBudWxsKSByZXR1cm47XHJcbiAgICBjb25zdCBpY29uID0gbmF0aXZlSW1hZ2UuY3JlYXRlRnJvbURhdGFVUkwoYGRhdGE6aW1hZ2UvcG5nO2Jhc2U2NCwke1RSQVlfSUNPTl9CQVNFNjR9YCk7XHJcbiAgICB0cmF5ID0gbmV3IFRyYXkoaWNvbik7XHJcbiAgICB0cmF5LnNldFRvb2xUaXAoJ0hNSCBEZXNrdG9wJyk7XHJcbiAgICB0cmF5Lm9uKCdjbGljaycsIGZvY3VzTWFpbldpbmRvdyk7XHJcbiAgICB0cmF5LnNldENvbnRleHRNZW51KE1lbnUuYnVpbGRGcm9tVGVtcGxhdGUoW1xyXG4gICAgICB7IGxhYmVsOiAnXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREJywgY2xpY2s6ICgpOiB2b2lkID0+IHNlbmRNZW51QWN0aW9uKCduZXctc2Vzc2lvbicpIH0sXHJcbiAgICAgIHsgbGFiZWw6ICdcdTY2M0VcdTc5M0FcdTRFM0JcdTdBOTdcdTUzRTMnLCBjbGljazogZm9jdXNNYWluV2luZG93IH0sXHJcbiAgICAgIHsgbGFiZWw6ICdcdTYyNEJcdTY3M0FcdThGRENcdTdBMEJcdTYzQTdcdTUyMzYnLCBjbGljazogKCk6IHZvaWQgPT4gc2VuZE1lbnVBY3Rpb24oJ29wZW4tcmVtb3RlJykgfSxcclxuICAgICAgeyBsYWJlbDogJ1x1OEJCRVx1N0Y2RScsIGNsaWNrOiAoKTogdm9pZCA9PiBzZW5kTWVudUFjdGlvbignb3Blbi1zZXR0aW5ncycpIH0sXHJcbiAgICAgIHsgdHlwZTogJ3NlcGFyYXRvcicgfSxcclxuICAgICAgeyBsYWJlbDogJ1x1OTAwMFx1NTFGQScsIGNsaWNrOiAoKTogdm9pZCA9PiB7IGFwcC5xdWl0KCk7IH0gfSxcclxuICAgIF0pKTtcclxuICB9XHJcbiAgZnVuY3Rpb24gbm90aWZ5RXZlbnQoZW52OiBFdmVudEVudmVsb3BlKTogdm9pZCB7XHJcbiAgICAvLyBcdTlBOENcdTY1MzYvXHU2MjJBXHU1NkZFL1x1NkUzMlx1NjdEM1x1NjNBMlx1OTQ4OC9cdTg5QzZcdTg5QzlcdTU2REVcdTVGNTJcdTZBMjFcdTVGMEZcdTk3NTlcdTlFRDgoXHU0RTBEXHU1RjgwXHU3NTI4XHU2MjM3XHU2ODRDXHU5NzYyXHU1RjM5XHU2RDRCXHU4QkQ1XHU5MDFBXHU3N0U1KVxyXG4gICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZID09PSAnMScgfHwgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfU05BUFNIT1QgIT09IHVuZGVmaW5lZCB8fCBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9SRU5ERVJfVEVTVCA9PT0gJzEnIHx8IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1ZJU1JFRyA9PT0gJzEnKSByZXR1cm47XHJcbiAgICBpZiAoIU5vdGlmaWNhdGlvbi5pc1N1cHBvcnRlZCgpKSByZXR1cm47XHJcbiAgICBjb25zdCB3aW4gPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5maW5kKCh3KSA9PiAhdy5pc0Rlc3Ryb3llZCgpKTtcclxuICAgIGNvbnN0IGZvY3VzZWQgPSB3aW4/LmlzRm9jdXNlZCgpID8/IGZhbHNlO1xyXG4gICAgY29uc3QgbWsgPSAodGl0bGU6IHN0cmluZywgYm9keTogc3RyaW5nKTogdm9pZCA9PiB7XHJcbiAgICAgIGNvbnN0IG4gPSBuZXcgTm90aWZpY2F0aW9uKHsgdGl0bGUsIGJvZHksIGljb246IG5hdGl2ZUltYWdlLmNyZWF0ZUZyb21EYXRhVVJMKGBkYXRhOmltYWdlL3BuZztiYXNlNjQsJHtUUkFZX0lDT05fQkFTRTY0fWApIH0pO1xyXG4gICAgICBuLm9uKCdjbGljaycsIGZvY3VzTWFpbldpbmRvdyk7XHJcbiAgICAgIG4uc2hvdygpO1xyXG4gICAgfTtcclxuICAgIGlmIChlbnYua2luZCA9PT0gJ2FwcHJvdmFsLnJlcXVpcmVkJykge1xyXG4gICAgICBjb25zdCBwID0gZW52LnBheWxvYWQgYXMgeyB0b29sPzogc3RyaW5nIH07XHJcbiAgICAgIG1rKCdITUggXHU5NzAwXHU4OTgxXHU1QkExXHU2Mjc5JywgYCR7U3RyaW5nKHAudG9vbCA/PyAnXHU2NENEXHU0RjVDJyl9IFx1N0I0OVx1NUY4NVx1NEY2MFx1NzY4NFx1NjI3OVx1NTFDNmApO1xyXG4gICAgfSBlbHNlIGlmIChlbnYua2luZCA9PT0gJ3J1bi5jb21wbGV0ZWQnICYmICFmb2N1c2VkKSB7XHJcbiAgICAgIG1rKCdITUggXHU0RUZCXHU1MkExXHU1QjhDXHU2MjEwJywgYFx1NEYxQVx1OEJERCAke2Vudi5zZXNzaW9uSWR9IFx1NzY4NFx1NEVGQlx1NTJBMVx1NURGMlx1NUI4Q1x1NjIxMGApO1xyXG4gICAgfSBlbHNlIGlmIChlbnYua2luZCA9PT0gJ3J1bi5mYWlsZWQnICYmICFmb2N1c2VkKSB7XHJcbiAgICAgIG1rKCdITUggXHU0RUZCXHU1MkExXHU1OTMxXHU4RDI1JywgYFx1NEYxQVx1OEJERCAke2Vudi5zZXNzaW9uSWR9IFx1NzY4NFx1NEVGQlx1NTJBMVx1NTkzMVx1OEQyNSxcdTcwQjlcdTUxRkJcdTY3RTVcdTc3MEJgKTtcclxuICAgIH1cclxuICB9XHJcblxyXG4gIC8qIC0tLS0gXHU4MUVBXHU1QjlBXHU0RTQ5XHU2ODA3XHU5ODk4XHU2ODBGKDIwMjYtMTAtMTEgXHU3NTI4XHU2MjM3XHU1M0NEXHU5OTg4Olx1NEVBRVx1ODI3Mlx1NkEyMVx1NUYwRlx1OTg3Nlx1OTBFOFx1OUVEMVx1Njc2MT1cdTUzOUZcdTc1MUZcdTgzRENcdTUzNTVcdTY4MEZcclxuICAgICBcdTRFMERcdThEREZcdTRFM0JcdTk4OTg7XHU4M0RDXHU1MzU1XHU0RTBFXHU4QkJFXHU3RjZFXHU5MUNEXHU1OTBEKSAtLS0tIFx1NjVCOVx1Njg0ODpcdTk2OTBcdTg1Q0ZcdTVGMEZcdTY4MDdcdTk4OThcdTY4MEYgKyB0aXRsZUJhck92ZXJsYXlcclxuICAgICAoXHU5ODlDXHU4MjcyXHU5NjhGXHU0RTNCXHU5ODk4KSxcdTgzRENcdTUzNTVcdTY4MEYgYXV0b0hpZGUoQWx0IFx1NTQ3Q1x1NTFGQSlcdTRFMTRcdTdDQkVcdTdCODBcdTRFM0FcdTdDRkJcdTdFREZcdTdFQTdcdTgwRkRcdTUyOUI7XHJcbiAgICAgXHU1RTM4XHU3NTI4XHU1MkE4XHU0RjVDXHU4RDcwIHJlbmRlcmVyIFx1NjgwN1x1OTg5OFx1NjgwRiBcdTI2MzAgXHU0RTNCXHU4M0RDXHU1MzU1KFx1NTUyRlx1NEUwMFx1NTE2NVx1NTNFMylcdTMwMDIgKi9cclxuICAvLyB2NCBEU0ggXHU4QkJFXHU4QkExXHU4QkVEXHU4QTAwOm92ZXJsYXkgXHU4MjcyXHU4RERGXHU5NjhGIHRpdGxlYmFyIFx1NzY4NCBiZy1sYXllci0xKFx1NkQ0NSAjZmZmL1x1NkRGMSAjMTYxODFkKVxyXG4gIGNvbnN0IGNocm9tZUZvciA9IChkYXJrOiBib29sZWFuKTogeyBjb2xvcjogc3RyaW5nOyBzeW1ib2xDb2xvcjogc3RyaW5nIH0gPT5cclxuICAgIGRhcmsgPyB7IGNvbG9yOiAnIzE2MTgxZCcsIHN5bWJvbENvbG9yOiAnI2Y1ZjZmOCcgfSA6IHsgY29sb3I6ICcjZmZmZmZmJywgc3ltYm9sQ29sb3I6ICcjMGYxMTE1JyB9O1xyXG4gIGZ1bmN0aW9uIGFwcGx5Q2hyb21lKGRhcms6IGJvb2xlYW4pOiB2b2lkIHtcclxuICAgIGZvciAoY29uc3QgdyBvZiBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKSkge1xyXG4gICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkge1xyXG4gICAgICAgIHRyeSB7IHcuc2V0VGl0bGVCYXJPdmVybGF5KGNocm9tZUZvcihkYXJrKSk7IH0gY2F0Y2ggeyAvKiBcdTRFQzUgV2luZG93cyBcdTY1MkZcdTYzMDEgKi8gfVxyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvKiAtLS0tIFx1NUU5NFx1NzUyOFx1NTE4NVx1NjZGNFx1NjVCMCgyMDI2LTEwLTI2Olx1ODFFQVx1NzgxNFx1OEY3Qlx1OTFDRlx1NjZGNFx1NjVCMFx1NTY2OCxcdTk2RjZcdTRGOURcdThENTY7R2l0SHViIFJlbGVhc2VzIFx1OTAxQVx1OTA1MylcclxuICAgICBcdTZENDFcdTdBMEI6XHU1NDJGXHU1MkE4IDMwcyBcdTU0MEVcdTk3NTlcdTlFRDhcdTY4QzBcdTY3RTUgXHUyMTkyIGZldGNoIGxhdGVzdCByZWxlYXNlIHRhZyBcdTIxOTIgXHU2QkQ0XHU3MjQ4XHU2NzJDIFx1MjE5MiBcdTU0MEVcdTUzRjBcdTZENDFcdTVGMEZcclxuICAgICBcdTRFMEJcdThGN0QgU2V0dXAgZXhlIFx1NTIzMFx1NEUzNFx1NjVGNlx1NzZFRVx1NUY1NShcdThGREJcdTVFQTZcdTYzQThcdTkwMDEgcmVuZGVyZXIgXHU2QTJBXHU1RTQ1KVx1MjE5MlwiXHU5MUNEXHU1NDJGXHU2NkY0XHU2NUIwXCJcdTIxOTIgXHU5MDAwXHU1MUZBXHU1RTk0XHU3NTI4XHJcbiAgICAgXHU1NDBFIE5TSVMgL1MgL0Q9XHU1MzlGXHU3NkVFXHU1RjU1IFx1OTc1OVx1OUVEOFx1ODk4Nlx1NzZENlx1NUI4OVx1ODhDNShcdTRFMEJcdTZCMjFcdTU0MkZcdTUyQThcdTUzNzNcdTY1QjBcdTcyNDgpXHUyMDE0XHUyMDE0XHU1MTY4XHU3QTBCXHU0RTBEXHU4REYzXHU2RDRGXHU4OUM4XHU1NjY4XHUzMDAyXHJcbiAgICAgMjAyNi0xMC0yOSBcdTUzQ0NcdTkwMUFcdTkwNTNcdTY4MzlcdTRGRUUoXHU3NTI4XHU2MjM3XHU1NkZEXHU1MTg1XHU2NTM2XHU0RTBEXHU1MjMwXHU2M0E4XHU5MDAxKTpcdTY4QzBcdTY3RTVcdTkwMUFcdTkwNTNcdTk1NUNcdTUwQ0ZcdTU2REVcdTkwMDBcdTk0RkVcclxuICAgICAoXHU3NkY0XHU4RkRFIDhzIFx1MjE5MiBnaC1wcm94eSBcdTIxOTIgZ2hmYXN0KSsgXHU1NDdEXHU0RTJEXHU5MDFBXHU5MDUzXHU3Qzk4XHU2MDI3XHU4QkIwXHU1RkM2ICsgXHU0RTBCXHU4RjdEXHU1NDBDXHU2RTkwXHU0RjE4XHU1MTQ4XHUzMDAyXHJcbiAgICAgXHU1NDBDXHU2NUU1XHU0RUZCXHU1MkExIDEzLUM6YXRvbWdpdCBcdTU2RkRcdTUxODVcdTk5OTZcdTkwMDlcdTkwMUFcdTkwNTMoXHU5NEZFXHU3QjJDXHU0RThDXHU0RjRELFx1NTZGRFx1NTE4NVx1NzZGNFx1OEZERVx1NTMzRlx1NTQwRFx1NTNFRlx1OEJGQikrIFx1NkQ0MVx1NUYwRlxyXG4gICAgIFx1NEUwQlx1OEY3RFx1OEZEQlx1NUVBNiArIFx1NEUwQlx1OEY3RCBzaXplIFx1NjgyMVx1OUE4QyArIFwiXHU5MUNEXHU1NDJGXHU2NkY0XHU2NUIwXCJcdTk3NUVcdTZBMjFcdTYwMDFcdTZBMkFcdTVFNDUocmVuZGVyZXIpXHUzMDAyXHJcbiAgICAgXHU2NUNCXHU5NEFFOlVQREFURV9SRVBPIC8gVVBEQVRFX1JFUE9fQVRPTUdJVCBcdTg5ODZcdTc2RDZcdTUzQ0NcdTRFRDM7SE1IX0RFU0tUT1BfVVBEQVRFX0ZPUkNFX1RBR1xyXG4gICAgIFx1OTc1RVx1N0E3QSBcdTIxOTIgXHU2NUUwXHU4OUM2XHU3MjQ4XHU2NzJDXHU2QkQ0XHU4RjgzXHU1RjNBXHU1MjM2XHU4RDcwXHU2NkY0XHU2NUIwXHU2RDQxXHU3QTBCKFx1OUE4Q1x1NjUzNlx1NzUyOCxcdTRFMERcdTkxQ0RcdTYyNTNcdTUzMDUpXHUzMDAyICovXHJcbiAgY29uc3QgVVBEQVRFX1JFUE9TOiBVcGRhdGVSZXBvcyA9IHtcclxuICAgIGdpdGh1YjogcHJvY2Vzcy5lbnYuVVBEQVRFX1JFUE8gPz8gJ3N3c2dibC9obWgtZGVza3RvcCcsXHJcbiAgICBhdG9tZ2l0OiBwcm9jZXNzLmVudi5VUERBVEVfUkVQT19BVE9NR0lUID8/ICdob25nZnUvaG1oLWRlc2t0b3AnLFxyXG4gIH07XHJcbiAgY29uc3QgVVBEQVRFX0ZPUkNFX1RBRyA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VQREFURV9GT1JDRV9UQUcgPz8gJyc7XHJcbiAgaW50ZXJmYWNlIFVwZGF0ZVByb2dyZXNzIHsgcmVjZWl2ZWQ6IG51bWJlcjsgdG90YWw6IG51bWJlcjsgc3BlZWRCcHM6IG51bWJlciB9XHJcbiAgaW50ZXJmYWNlIFVwZGF0ZVN0YXRlIHsgY2hlY2tpbmc6IGJvb2xlYW47IGN1cnJlbnRWZXJzaW9uOiBzdHJpbmc7IGxhdGVzdDogc3RyaW5nIHwgbnVsbDsgbm90ZXM6IHN0cmluZzsgZG93bmxvYWRlZDogYm9vbGVhbjsgZXJyb3I6IHN0cmluZzsgY2hhbm5lbDogc3RyaW5nOyBwcm9ncmVzczogVXBkYXRlUHJvZ3Jlc3MgfCBudWxsIH1cclxuICBsZXQgdXBkYXRlU3RhdGU6IFVwZGF0ZVN0YXRlID0geyBjaGVja2luZzogZmFsc2UsIGN1cnJlbnRWZXJzaW9uOiBhcHAuZ2V0VmVyc2lvbigpLCBsYXRlc3Q6IG51bGwsIG5vdGVzOiAnJywgZG93bmxvYWRlZDogZmFsc2UsIGVycm9yOiAnJywgY2hhbm5lbDogJycsIHByb2dyZXNzOiBudWxsIH07XHJcbiAgbGV0IGluc3RhbGxlclBhdGg6IHN0cmluZyB8IG51bGwgPSBudWxsO1xyXG4gIGNvbnN0IGJ1bXBVcGRhdGUgPSAocGF0Y2g6IFBhcnRpYWw8VXBkYXRlU3RhdGU+KTogdm9pZCA9PiB7XHJcbiAgICB1cGRhdGVTdGF0ZSA9IHsgLi4udXBkYXRlU3RhdGUsIC4uLnBhdGNoIH07XHJcbiAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcclxuICAgICAgaWYgKCF3LmlzRGVzdHJveWVkKCkpIHcud2ViQ29udGVudHMuc2VuZCgndXBkYXRlOnN0YXRlJywgdXBkYXRlU3RhdGUpO1xyXG4gICAgfVxyXG4gIH07XHJcbiAgLyoqIFx1OTAxQVx1OTA1M1x1N0M5OFx1NjAyNzpcdTRFMEFcdTZCMjFcdTYyMTBcdTUyOUZcdTU0N0RcdTRFMkRcdTc2ODRcdTY4QzBcdTY3RTVcdTkwMUFcdTkwNTModXNlckRhdGEvdXBkYXRlLWNoYW5uZWwuanNvbixcdTRFMEUgcnVudGltZS5qc29uIFx1NTQwQ1x1NkEyMVx1NUYwRilcdTMwMDIgKi9cclxuICBjb25zdCB1cGRhdGVDaGFubmVsRmlsZSA9ICgpOiBzdHJpbmcgPT4gam9pbihhcHAuZ2V0UGF0aCgndXNlckRhdGEnKSwgJ3VwZGF0ZS1jaGFubmVsLmpzb24nKTtcclxuICBhc3luYyBmdW5jdGlvbiBsb2FkU3RpY2t5Q2hhbm5lbCgpOiBQcm9taXNlPFVwZGF0ZUNoYW5uZWxJZCB8IG51bGw+IHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHYgPSBKU09OLnBhcnNlKGF3YWl0IHJlYWRGaWxlKHVwZGF0ZUNoYW5uZWxGaWxlKCksICd1dGY4JykpIGFzIHsgY2hhbm5lbD86IHVua25vd24gfTtcclxuICAgICAgcmV0dXJuIG5vcm1hbGl6ZUNoYW5uZWwodi5jaGFubmVsKTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4gbnVsbDsgfVxyXG4gIH1cclxuICBhc3luYyBmdW5jdGlvbiBzYXZlU3RpY2t5Q2hhbm5lbChpZDogVXBkYXRlQ2hhbm5lbElkKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBhd2FpdCB3cml0ZUZpbGUodXBkYXRlQ2hhbm5lbEZpbGUoKSwgSlNPTi5zdHJpbmdpZnkoeyBjaGFubmVsOiBpZCB9LCBudWxsLCAyKSwgJ3V0ZjgnKS5jYXRjaCgoKSA9PiB1bmRlZmluZWQpO1xyXG4gIH1cclxuICBhc3luYyBmdW5jdGlvbiBjaGVja0ZvclVwZGF0ZXMoKTogUHJvbWlzZTxVcGRhdGVTdGF0ZT4ge1xyXG4gICAgaWYgKHVwZGF0ZVN0YXRlLmNoZWNraW5nIHx8IHVwZGF0ZVN0YXRlLmRvd25sb2FkZWQpIHJldHVybiB1cGRhdGVTdGF0ZTtcclxuICAgIGJ1bXBVcGRhdGUoeyBjaGVja2luZzogdHJ1ZSwgZXJyb3I6ICcnIH0pO1xyXG4gICAgbG9nSW5mbygndXBkYXRlJywgYGNoZWNraW5nXHUyMDI2IChjdXJyZW50IHYke2FwcC5nZXRWZXJzaW9uKCl9KSR7VVBEQVRFX0ZPUkNFX1RBRyAhPT0gJycgPyBgIGZvcmNlLXRhZz0ke1VQREFURV9GT1JDRV9UQUd9YCA6ICcnfWApO1xyXG4gICAgY29uc3QgZmFpbHVyZXM6IEFycmF5PHsgbGFiZWw6IHN0cmluZzsgcmVhc29uOiBzdHJpbmcgfT4gPSBbXTtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHN0aWNreSA9IGF3YWl0IGxvYWRTdGlja3lDaGFubmVsKCk7XHJcbiAgICAgIGNvbnN0IGNoYW5uZWxzID0gb3JkZXJlZENoZWNrQ2hhbm5lbHMoc3RpY2t5ID8/IHVuZGVmaW5lZCk7XHJcbiAgICAgIGZvciAoY29uc3QgY2ggb2YgY2hhbm5lbHMpIHtcclxuICAgICAgICBsZXQgcmVsOiBMYXRlc3RSZWxlYXNlIHwgbnVsbCA9IG51bGw7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgIGNvbnN0IHIgPSBhd2FpdCBmZXRjaChjaC5hcGlVcmwoVVBEQVRFX1JFUE9TKSwge1xyXG4gICAgICAgICAgICBoZWFkZXJzOiB7ICd1c2VyLWFnZW50JzogJ2htaC1kZXNrdG9wLXVwZGF0ZXInIH0sXHJcbiAgICAgICAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dChjaC50aW1lb3V0TXMpLFxyXG4gICAgICAgICAgfSk7XHJcbiAgICAgICAgICBpZiAoIXIub2spIHsgZmFpbHVyZXMucHVzaCh7IGxhYmVsOiBjaC5sYWJlbCwgcmVhc29uOiBgSFRUUCAke3Iuc3RhdHVzfWAgfSk7IGxvZ0luZm8oJ3VwZGF0ZScsIGAke2NoLmxhYmVsfSBcdTIxOTIgSFRUUCAke3Iuc3RhdHVzfWApOyBjb250aW51ZTsgfVxyXG4gICAgICAgICAgLy8gXHU5NTVDXHU1MENGXHU1M0VGXHU4MEZEXHU1NkRFIDIwMCBcdTRGNDZcdTUxODVcdTVCQjlcdTk3NUUgSlNPTihIVE1MIFx1OTUxOVx1OEJFRlx1OTg3NSk7R2l0SHViIFx1NTZERVx1NUJGOVx1OEM2MVx1MzAwMWF0b21naXRcclxuICAgICAgICAgIC8vIFx1NTZERVx1NjU3MFx1N0VDNFx1MjAxNFx1MjAxNG5vcm1hbGl6ZVJlbGVhc2UgXHU3RURGXHU0RTAwXHU1RjUyXHU0RTAwLFx1NUY2Mlx1NzJCNlx1NEUwRFx1NUJGOVx1NjMwOVx1NjcyQ1x1OTAxQVx1OTA1M1x1NTkzMVx1OEQyNVx1NTZERVx1OTAwMFxyXG4gICAgICAgICAgcmVsID0gbm9ybWFsaXplUmVsZWFzZShhd2FpdCByLmpzb24oKSk7XHJcbiAgICAgICAgICBpZiAocmVsID09PSBudWxsKSB7IGZhaWx1cmVzLnB1c2goeyBsYWJlbDogY2gubGFiZWwsIHJlYXNvbjogJ1x1NTRDRFx1NUU5NFx1NjVFMCB0YWdfbmFtZScgfSk7IGxvZ0luZm8oJ3VwZGF0ZScsIGAke2NoLmxhYmVsfSBcdTIxOTIgXHU2NUUwIHRhZ19uYW1lYCk7IGNvbnRpbnVlOyB9XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgICBjb25zdCBlID0gZXJyIGFzIHsgY2F1c2U/OiB7IGNvZGU/OiB1bmtub3duIH0gfTtcclxuICAgICAgICAgIGNvbnN0IHJlYXNvbiA9IGVyciBpbnN0YW5jZW9mIEVycm9yICYmIGVyci5uYW1lID09PSAnVGltZW91dEVycm9yJ1xyXG4gICAgICAgICAgICA/IGBcdThEODVcdTY1RjYoJHtNYXRoLnJvdW5kKGNoLnRpbWVvdXRNcyAvIDEwMDApfXMpYFxyXG4gICAgICAgICAgICA6IFN0cmluZyhlLmNhdXNlPy5jb2RlID8/IGVycikuc2xpY2UoMCwgNjApO1xyXG4gICAgICAgICAgZmFpbHVyZXMucHVzaCh7IGxhYmVsOiBjaC5sYWJlbCwgcmVhc29uIH0pO1xyXG4gICAgICAgICAgbG9nSW5mbygndXBkYXRlJywgYCR7Y2gubGFiZWx9IFx1MjE5MiBmYWlsICR7cmVhc29ufWApO1xyXG4gICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IHRhZyA9IHJlbC50YWdfbmFtZTtcclxuICAgICAgICBsb2dJbmZvKCd1cGRhdGUnLCBgbGF0ZXN0PSR7dGFnfSBhc3NldHM9JHsocmVsLmFzc2V0cyA/PyBbXSkubGVuZ3RofSB2aWEgJHtjaC5sYWJlbH0ke3N0aWNreSA9PT0gY2guaWQgPyAnKHN0aWNreSknIDogJyd9YCk7XHJcbiAgICAgICAgYXdhaXQgc2F2ZVN0aWNreUNoYW5uZWwoY2guaWQpOyAvLyBcdTdDOThcdTYwMjc6XHU0RTBCXHU2QjIxXHU1MTQ4XHU4QkQ1XHU2NzJDXHU5MDFBXHU5MDUzXHJcbiAgICAgICAgYnVtcFVwZGF0ZSh7IGNoZWNraW5nOiBmYWxzZSwgbGF0ZXN0OiB0YWcsIG5vdGVzOiBTdHJpbmcocmVsLmJvZHkgPz8gJycpLnNsaWNlKDAsIDYwMCksIGNoYW5uZWw6IGNoLmlkIH0pO1xyXG4gICAgICAgIC8vIFx1NjcwOVx1NjVCMFx1NzI0OChcdTYyMTYgRk9SQ0VfVEFHIFx1OUE4Q1x1NjUzNlx1NjVDQlx1OTRBRSlcdTRFMTRcdTY3MkFcdTRFMEJcdThGN0RcdThGQzcgXHUyMTkyIFx1NTQwRVx1NTNGMFx1NEUwQlx1OEY3RFx1NUI4OVx1ODhDNVx1NTMwNVxyXG4gICAgICAgIGlmICgoVVBEQVRFX0ZPUkNFX1RBRyAhPT0gJycgfHwgY21wVmVyc2lvbihhcHAuZ2V0VmVyc2lvbigpLCB0YWcpIDwgMCkgJiYgIXVwZGF0ZVN0YXRlLmRvd25sb2FkZWQpIHtcclxuICAgICAgICAgIHZvaWQgZG93bmxvYWRJbnN0YWxsZXIocmVsLmFzc2V0cyA/PyBbXSwgdGFnKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHVwZGF0ZVN0YXRlO1xyXG4gICAgICB9XHJcbiAgICAgIGNvbnN0IHN1bW1hcnkgPSBzdW1tYXJpemVDaGVja0ZhaWx1cmVzKGZhaWx1cmVzKTtcclxuICAgICAgbG9nSW5mbygndXBkYXRlJywgYGNoZWNrIGZhaWxlZDogYWxsIGNoYW5uZWxzICgke3N1bW1hcnl9KWApO1xyXG4gICAgICBidW1wVXBkYXRlKHsgY2hlY2tpbmc6IGZhbHNlLCBlcnJvcjogYFx1NTE2OFx1OTBFOFx1NjhDMFx1NjdFNVx1OTAxQVx1OTA1M1x1NTkzMVx1OEQyNSgke3N1bW1hcnl9KWAuc2xpY2UoMCwgMjAwKSB9KTtcclxuICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICBsb2dJbmZvKCd1cGRhdGUnLCBgY2hlY2sgZmFpbGVkOiAke1N0cmluZyhlcnIpLnNsaWNlKDAsIDE0MCl9YCk7XHJcbiAgICAgIGJ1bXBVcGRhdGUoeyBjaGVja2luZzogZmFsc2UsIGVycm9yOiBTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApIH0pO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHVwZGF0ZVN0YXRlO1xyXG4gIH1cclxuICAvKiogXHU1NDBFXHU1M0YwXHU2RDQxXHU1RjBGXHU0RTBCXHU4RjdEXHU1Qjg5XHU4OEM1XHU1MzA1Olx1NTIwNlx1NTc1N1x1NTE5OVx1NzZEOCgxMTJNQiBcdTRFMERcdTUxOERcdTY1NzRcdTlBN0JcdTUxODVcdTVCNTgpLFx1OEZEQlx1NUVBNihcdTVERjJcdTRFMEJcdThGN0QvXHU2MDNCXHU1QjU3XHU4MjgyL1xyXG4gICAqICBcdTkwMUZcdTVFQTYpXHU3RUNGIHVwZGF0ZTpzdGF0ZSBcdTYzQTggcmVuZGVyZXIgXHU2QTJBXHU1RTQ1O1x1ODQzRFx1NzZEOFx1NTQwRVx1NjMwOVx1OEQ0NFx1NEVBN1x1NTE0M1x1NjU3MFx1NjM2RSBzaXplIFx1NjgyMVx1OUE4Q1x1MzAwMiAqL1xyXG4gIGFzeW5jIGZ1bmN0aW9uIGRvd25sb2FkSW5zdGFsbGVyKGFzc2V0czogcmVhZG9ubHkgUmVsZWFzZUFzc2V0W10sIHRhZzogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCBhc3NldCA9IHBpY2tJbnN0YWxsZXJBc3NldChhc3NldHMpO1xyXG4gICAgICBpZiAoYXNzZXQgPT09IG51bGwpIHsgYnVtcFVwZGF0ZSh7IGVycm9yOiAncmVsZWFzZSBcdTY1RTBcdTVCODlcdTg4QzVcdTUzMDVcdThENDRcdTRFQTcnIH0pOyByZXR1cm47IH1cclxuICAgICAgY29uc3QgZGVzdCA9IGpvaW4oYXBwLmdldFBhdGgoJ3RlbXAnKSwgYXNzZXQubmFtZSk7XHJcbiAgICAgIC8vIFx1NEUwQVx1NkIyMVx1NEYxQVx1OEJERFx1NURGMlx1NjI4QVx1NTQwQ1x1NzI0OFx1NjcyQ1x1NUI4OVx1ODhDNVx1NTMwNVx1NUI4Q1x1NjU3NFx1NEUwQlx1NTIzMFx1NEUzNFx1NjVGNlx1NzZFRVx1NUY1NShzaXplIFx1NUJGOVx1NUY5N1x1NEUwQSlcdTIxOTIgXHU3NkY0XHU2M0E1XHU1OTBEXHU3NTI4LFxyXG4gICAgICAvLyBcdTRFMERcdTUxOERcdTYyQzkgMTEyTUI7XHU4RkQ5XHU1QzMxXHU2NjJGXCJcdTc1MjhcdTYyMzdcdTVGRkRcdTc1NjVcdTZBMkFcdTVFNDVcdTdFRTdcdTdFRURcdTc1MjgsXHU0RTBCXHU2QjIxXHU1NDJGXHU1MkE4XHU0RUNEXHU0RTAwXHU5NTJFXHU1M0VGXHU4OEM1XCJcdTc2ODRcdTg0M0RcdTU3MzBcdTMwMDJcclxuICAgICAgdHJ5IHtcclxuICAgICAgICBjb25zdCBzdCA9IGF3YWl0IHN0YXQoZGVzdCk7XHJcbiAgICAgICAgaWYgKHNpemVNYXRjaGVzKGFzc2V0LnNpemUsIHN0LnNpemUpKSB7XHJcbiAgICAgICAgICBpbnN0YWxsZXJQYXRoID0gZGVzdDtcclxuICAgICAgICAgIGJ1bXBVcGRhdGUoeyBkb3dubG9hZGVkOiB0cnVlLCBwcm9ncmVzczogbnVsbCB9KTtcclxuICAgICAgICAgIGxvZ0luZm8oJ3VwZGF0ZScsIGBcdTU5MERcdTc1MjhcdTVERjJcdTRFMEJcdThGN0QgJHthc3NldC5uYW1lfSgke01hdGgucm91bmQoc3Quc2l6ZSAvIDFlNil9TUIpIFx1MjE5MiAke2Rlc3R9YCk7XHJcbiAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICB9IGNhdGNoIHsgLyogXHU0RTBEXHU1QjU4XHU1NzI4XHU1MjE5XHU2QjYzXHU1RTM4XHU0RTBCXHU4RjdEICovIH1cclxuICAgICAgLy8gXHU0RTBCXHU4RjdEXHU1MDE5XHU5MDA5XHU5NEZFOmF0b21naXQgXHU1NDdEXHU0RTJEIFx1MjE5MiBhdG9tZ2l0IFx1NzZGNFx1OTRGRS9BUEkgXHU3QUVGXHU3MEI5XHU0RjE4XHU1MTQ4LEdpdEh1YiBcdTRFM0JcdTRFRDNcdTk1NUNcdTUwQ0ZcdTUxNUNcdTVFOTVcclxuICAgICAgY29uc3QgY2FuZGlkYXRlcyA9IGRvd25sb2FkQ2FuZGlkYXRlcyh7IGNoYW5uZWw6IHVwZGF0ZVN0YXRlLmNoYW5uZWwsIHRhZywgYXNzZXRVcmw6IGFzc2V0LmJyb3dzZXJfZG93bmxvYWRfdXJsLCBhc3NldE5hbWU6IGFzc2V0Lm5hbWUsIHJlcG9zOiBVUERBVEVfUkVQT1MgfSk7XHJcbiAgICAgIGxldCBsYXN0RXJyID0gJyc7XHJcbiAgICAgIGZvciAoY29uc3QgdSBvZiBjYW5kaWRhdGVzKSB7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgIGxvZ0luZm8oJ3VwZGF0ZScsIGB0cnlpbmcgJHtuZXcgVVJMKHUpLmhvc3R9XHUyMDI2YCk7XHJcbiAgICAgICAgICBjb25zdCByID0gYXdhaXQgZmV0Y2godSwgeyBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoOTAwXzAwMCkgfSk7XHJcbiAgICAgICAgICBpZiAoIXIub2spIHsgbGFzdEVyciA9IGBIVFRQICR7ci5zdGF0dXN9YDsgbG9nSW5mbygndXBkYXRlJywgYFx1MjE5MiBIVFRQICR7ci5zdGF0dXN9YCk7IGNvbnRpbnVlOyB9XHJcbiAgICAgICAgICBpZiAoci5ib2R5ID09PSBudWxsKSB7IGxhc3RFcnIgPSAnXHU2NUUwXHU1NENEXHU1RTk0XHU0RjUzJzsgY29udGludWU7IH1cclxuICAgICAgICAgIGNvbnN0IHRvdGFsID0gTnVtYmVyKHIuaGVhZGVycy5nZXQoJ2NvbnRlbnQtbGVuZ3RoJykgPz8gMCkgPiAwID8gTnVtYmVyKHIuaGVhZGVycy5nZXQoJ2NvbnRlbnQtbGVuZ3RoJykpIDogYXNzZXQuc2l6ZTtcclxuICAgICAgICAgIGNvbnN0IGRlc3RUbXAgPSBgJHtkZXN0fS5wYXJ0YDtcclxuICAgICAgICAgIGNvbnN0IG91dCA9IGNyZWF0ZVdyaXRlU3RyZWFtKGRlc3RUbXApO1xyXG4gICAgICAgICAgbGV0IHJlY2VpdmVkID0gMDtcclxuICAgICAgICAgIGxldCBsYXN0QnVtcCA9IDA7XHJcbiAgICAgICAgICBjb25zdCB0MCA9IERhdGUubm93KCk7XHJcbiAgICAgICAgICBjb25zdCByZWFkZXIgPSByLmJvZHkuZ2V0UmVhZGVyKCk7XHJcbiAgICAgICAgICBmb3IgKDs7KSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHsgZG9uZSwgdmFsdWUgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XHJcbiAgICAgICAgICAgIGlmIChkb25lID09PSB0cnVlIHx8IHZhbHVlID09PSB1bmRlZmluZWQpIGJyZWFrO1xyXG4gICAgICAgICAgICByZWNlaXZlZCArPSB2YWx1ZS5ieXRlTGVuZ3RoO1xyXG4gICAgICAgICAgICBvdXQud3JpdGUodmFsdWUpO1xyXG4gICAgICAgICAgICAvLyBcdThGREJcdTVFQTZcdTgyODJcdTZENDE6XHUyMjY0IFx1NkJDRiA0MDBtcyBcdTRFMDBcdTVFMjcsSVBDIFx1NEUwRFx1NkQyQVx1NkNEQjtcdTk5OTZcdTU3NTdcdTdBQ0JcdTUzNzNcdTRFMEFcdTYyQTUoXHU2MDNCXHU1QjU3XHU4MjgyXHU1QzNEXHU1RkVCXHU1M0VGXHU4OUMxKVxyXG4gICAgICAgICAgICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xyXG4gICAgICAgICAgICBpZiAocmVjZWl2ZWQgPT09IHZhbHVlLmJ5dGVMZW5ndGggfHwgbm93IC0gbGFzdEJ1bXAgPiA0MDApIHtcclxuICAgICAgICAgICAgICBsYXN0QnVtcCA9IG5vdztcclxuICAgICAgICAgICAgICBidW1wVXBkYXRlKHsgcHJvZ3Jlc3M6IHsgcmVjZWl2ZWQsIHRvdGFsLCBzcGVlZEJwczogTWF0aC5yb3VuZChyZWNlaXZlZCAvIE1hdGgubWF4KChub3cgLSB0MCkgLyAxMDAwLCAwLjEpKSB9IH0pO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPigocmVzLCByZWopID0+IHsgb3V0LmVuZCgoZXJyPzogRXJyb3IgfCBudWxsKSA9PiB7IGlmIChlcnIgIT09IG51bGwgJiYgZXJyICE9PSB1bmRlZmluZWQpIHJlaihlcnIpOyBlbHNlIHJlcygpOyB9KTsgfSk7XHJcbiAgICAgICAgICBpZiAocmVjZWl2ZWQgPCAxXzAwMF8wMDApIHsgbGFzdEVyciA9IGBcdTUxODVcdTVCQjlcdTVGMDJcdTVFMzgoJHtyZWNlaXZlZH1CKWA7IGxvZ0luZm8oJ3VwZGF0ZScsIGBcdTIxOTIgJHtsYXN0RXJyfWApOyBjb250aW51ZTsgfVxyXG4gICAgICAgICAgaWYgKCFzaXplTWF0Y2hlcyhhc3NldC5zaXplLCByZWNlaXZlZCkpIHsgbGFzdEVyciA9IGBzaXplIFx1NEUwRFx1N0IyNihcdTUxNDNcdTY1NzBcdTYzNkUgJHthc3NldC5zaXplfUIgLyBcdTVCOUVcdTY1MzYgJHtyZWNlaXZlZH1CKWA7IGxvZ0luZm8oJ3VwZGF0ZScsIGBcdTIxOTIgJHtsYXN0RXJyfWApOyBjb250aW51ZTsgfVxyXG4gICAgICAgICAgYXdhaXQgcmVuYW1lKGRlc3RUbXAsIGRlc3QpO1xyXG4gICAgICAgICAgaW5zdGFsbGVyUGF0aCA9IGRlc3Q7XHJcbiAgICAgICAgICBidW1wVXBkYXRlKHsgZG93bmxvYWRlZDogdHJ1ZSwgcHJvZ3Jlc3M6IG51bGwgfSk7XHJcbiAgICAgICAgICBsb2dJbmZvKCd1cGRhdGUnLCBgXHU1REYyXHU0RTBCXHU4RjdEICR7YXNzZXQubmFtZX0oJHtNYXRoLnJvdW5kKHJlY2VpdmVkIC8gMWU2KX1NQikgXHUyMTkyICR7ZGVzdH1gKTtcclxuICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgICAgIGNvbnN0IGUgPSBlcnIgYXMgeyBjYXVzZT86IHsgY29kZT86IHVua25vd24gfSB9O1xyXG4gICAgICAgICAgbGFzdEVyciA9IFN0cmluZyhlLmNhdXNlPy5jb2RlID8/IGVycikuc2xpY2UoMCwgODApO1xyXG4gICAgICAgICAgbG9nSW5mbygndXBkYXRlJywgYFx1MjE5MiBmYWlsICR7bGFzdEVycn1gKTtcclxuICAgICAgICAgIGJ1bXBVcGRhdGUoeyBwcm9ncmVzczogbnVsbCB9KTtcclxuICAgICAgICB9XHJcbiAgICAgIH1cclxuICAgICAgYnVtcFVwZGF0ZSh7IGVycm9yOiBgXHU0RTBCXHU4RjdEXHU1OTMxXHU4RDI1Olx1NTE2OFx1OTBFOFx1NEUwQlx1OEY3RFx1OTAxQVx1OTA1M1x1NTkzMVx1OEQyNSgke2xhc3RFcnJ9KWAuc2xpY2UoMCwgMTYwKSwgcHJvZ3Jlc3M6IG51bGwgfSk7XHJcbiAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgYnVtcFVwZGF0ZSh7IGVycm9yOiBgXHU0RTBCXHU4RjdEXHU1OTMxXHU4RDI1OiAke1N0cmluZyhlcnIpLnNsaWNlKDAsIDEyMCl9YCwgcHJvZ3Jlc3M6IG51bGwgfSk7XHJcbiAgICB9XHJcbiAgfVxyXG4gIGZ1bmN0aW9uIGFwcGx5VXBkYXRlKCk6IHZvaWQge1xyXG4gICAgLy8gXHU5QThDXHU2NTM2XHU1M0VGXHU4OUMyXHU2RDRCOlx1NkJDRlx1NkIyMSBhcHBseSBcdThCRjdcdTZDNDJcdTkwRkRcdTc1NTlcdTY1RTVcdTVGRDcobW9jay9cdTY1RTBcdTVCODlcdTg4QzVcdTUzMDVcdTY1RjZcdTcwQjlcdTUxRkJcIlx1OTFDRFx1NTQyRlx1NjZGNFx1NjVCMFwiXHJcbiAgICAvLyBcdTRFMERcdTkwMDBcdTUxRkEsVUlWRVJJRlkgXHU2NUFEXHU4QTAwXCJcdTcwQjlcdTUxRkJcdTU0MEVcdThGREJcdTdBMEJcdTVCNThcdTZEM0JcIlx1OTE0RFx1NTQwOFx1OEZEOVx1ODg0Q1x1NjVFNVx1NUZEN1x1Njc4NFx1NjIxMFx1NUI4Q1x1NjU3NFx1OEJDMVx1NjM2RVx1OTRGRSlcdTMwMDJcclxuICAgIGxvZ0luZm8oJ3VwZGF0ZScsIGBhcHBseSByZXF1ZXN0ZWQgKGluc3RhbGxlcj0ke2luc3RhbGxlclBhdGggPT09IG51bGwgPyAnbm9uZScgOiBiYXNlbmFtZShpbnN0YWxsZXJQYXRoKX0pYCk7XHJcbiAgICBpZiAoaW5zdGFsbGVyUGF0aCA9PT0gbnVsbCkgcmV0dXJuO1xyXG4gICAgLy8gXHU5MDAwXHU1MUZBXHU1RjUzXHU1MjREXHU1RTk0XHU3NTI4XHU1NDBFXHU3NTMxXHU1Qjg5XHU4OEM1XHU1NjY4XHU5NzU5XHU5RUQ4XHU4OTg2XHU3NkQ2XHU1Qjg5XHU4OEM1KFx1ODhDNVx1NTZERVx1NTM5Rlx1NzZFRVx1NUY1NSlcdTMwMDJOU0lTIGFzc2lzdGVkIFx1ODlDNFx1NTIxOTpcclxuICAgIC8vIC9TIFx1NEUxNCAvRD1wYXRoIFx1NUZDNVx1OTg3Qlx1NjcwMFx1NTQwRVx1NEUwMFx1NEUyQVx1NTNDMlx1NjU3MFx1MzAwMVx1NTAzQ1x1NEUwRFx1NTJBMFx1NUYxNVx1NTNGNyhcdTU0MkJcdTdBN0FcdTY4M0NcdTRFNUZcdTRFMERcdTUyQTApXHUyMDE0XHUyMDE0bm9kZSBzcGF3blxyXG4gICAgLy8gXHU5RUQ4XHU4QkE0XHU0RjFBXHU3RUQ5XHU1NDJCXHU3QTdBXHU2ODNDXHU1M0MyXHU2NTcwXHU1MkEwXHU1RjE1XHU1M0Y3XHU1QkZDXHU4MUY0IE5TSVMgXHU4OUUzXHU2NzkwXHU5NTE5XHU4REVGXHU1Rjg0KFx1NUI5RVx1NkQ0Qlx1ODhDNVx1NTc0Rlx1NzZFRVx1NUY1NSksXHU2NTQ1XHU3NTI4XHJcbiAgICAvLyB3aW5kb3dzVmVyYmF0aW1Bcmd1bWVudHMgXHU1MzlGXHU2ODM3XHU0RjIwXHU5MDEyXHUzMDAyXHJcbiAgICBjb25zdCBpbnN0YWxsRGlyID0gZGlybmFtZShwcm9jZXNzLmV4ZWNQYXRoKTtcclxuICAgIGNvbnN0IGNoaWxkID0gc3Bhd24oYFwiJHtpbnN0YWxsZXJQYXRofVwiIC9TIC9EPSR7aW5zdGFsbERpcn1gLCB7XHJcbiAgICAgIGRldGFjaGVkOiB0cnVlLFxyXG4gICAgICBzdGRpbzogJ2lnbm9yZScsXHJcbiAgICAgIHdpbmRvd3NIaWRlOiB0cnVlLFxyXG4gICAgICBzaGVsbDogZmFsc2UsXHJcbiAgICAgIHdpbmRvd3NWZXJiYXRpbUFyZ3VtZW50czogdHJ1ZSxcclxuICAgIH0pO1xyXG4gICAgY2hpbGQudW5yZWYoKTtcclxuICAgIGxvZ0luZm8oJ3VwZGF0ZScsIGBhcHBseTogJHtpbnN0YWxsZXJQYXRofSBcdTIxOTIgJHtpbnN0YWxsRGlyfWApO1xyXG4gICAgYXBwLmV4aXQoMCk7XHJcbiAgfVxyXG5cclxuICBmdW5jdGlvbiBidWlsZEFwcE1lbnUoKTogdm9pZCB7XHJcbiAgICAvLyBcdTdDQkVcdTdCODA6XHU1M0VBXHU0RkREXHU3NTU5IFVJIFx1NkNBMVx1NjcwOVx1NzY4NFx1N0NGQlx1N0VERlx1N0VBN1x1ODBGRFx1NTI5QihcdTUyNkFcdThEMzRcdTY3N0YvXHU3QTk3XHU1M0UzKTtcdTUxNzZcdTRGNTlcdTU1MkZcdTRFMDBcdTUxNjVcdTUzRTNcdTU3MjggVUlcdTMwMDJcclxuICAgIGNvbnN0IHRlbXBsYXRlOiBBcnJheTxFbGVjdHJvbi5NZW51SXRlbUNvbnN0cnVjdG9yT3B0aW9ucz4gPSBbXHJcbiAgICAgIHtcclxuICAgICAgICBsYWJlbDogJ1x1N0YxNlx1OEY5MScsXHJcbiAgICAgICAgc3VibWVudTogW1xyXG4gICAgICAgICAgeyByb2xlOiAndW5kbycsIGxhYmVsOiAnXHU2NEE0XHU5NTAwJyB9LFxyXG4gICAgICAgICAgeyByb2xlOiAncmVkbycsIGxhYmVsOiAnXHU5MUNEXHU1MDVBJyB9LFxyXG4gICAgICAgICAgeyB0eXBlOiAnc2VwYXJhdG9yJyB9LFxyXG4gICAgICAgICAgeyByb2xlOiAnY3V0JywgbGFiZWw6ICdcdTUyNkFcdTUyMDcnIH0sXHJcbiAgICAgICAgICB7IHJvbGU6ICdjb3B5JywgbGFiZWw6ICdcdTU5MERcdTUyMzYnIH0sXHJcbiAgICAgICAgICB7IHJvbGU6ICdwYXN0ZScsIGxhYmVsOiAnXHU3Qzk4XHU4RDM0JyB9LFxyXG4gICAgICAgICAgeyByb2xlOiAnc2VsZWN0QWxsJywgbGFiZWw6ICdcdTUxNjhcdTkwMDknIH0sXHJcbiAgICAgICAgXSxcclxuICAgICAgfSxcclxuICAgICAge1xyXG4gICAgICAgIGxhYmVsOiAnXHU3QTk3XHU1M0UzJyxcclxuICAgICAgICBzdWJtZW51OiBbXHJcbiAgICAgICAgICB7IHJvbGU6ICdtaW5pbWl6ZScsIGxhYmVsOiAnXHU2NzAwXHU1QzBGXHU1MzE2JyB9LFxyXG4gICAgICAgICAgeyByb2xlOiAnem9vbScsIGxhYmVsOiAnXHU3RjI5XHU2NTNFJyB9LFxyXG4gICAgICAgICAgeyB0eXBlOiAnc2VwYXJhdG9yJyB9LFxyXG4gICAgICAgICAgeyByb2xlOiAnY2xvc2UnLCBsYWJlbDogJ1x1NTE3M1x1OTVFRCcgfSxcclxuICAgICAgICBdLFxyXG4gICAgICB9LFxyXG4gICAgXTtcclxuICAgIE1lbnUuc2V0QXBwbGljYXRpb25NZW51KE1lbnUuYnVpbGRGcm9tVGVtcGxhdGUodGVtcGxhdGUpKTtcclxuICB9XHJcbiAgLyoqIFx1NjgwN1x1OTg5OFx1NjgwRiBcdTI2MzAgXHU0RTNCXHU4M0RDXHU1MzU1KFx1NUUzOFx1NzUyOFx1NTJBOFx1NEY1Q1x1NzY4NFx1NTUyRlx1NEUwMFx1NTE2NVx1NTNFMztcdTg5QzZcdTU2RkVcdTYwMDFcdTdFQ0YgbWVudTphY3Rpb24gXHU4RjZDXHU1M0QxKVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIHBvcHVwTWFpbk1lbnUoKTogdm9pZCB7XHJcbiAgICBjb25zdCBzZW5kID0gKGE6IHN0cmluZyk6IHZvaWQgPT4ge1xyXG4gICAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcclxuICAgICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCdtZW51OmFjdGlvbicsIGEpO1xyXG4gICAgICB9XHJcbiAgICB9O1xyXG4gICAgY29uc3Qgd2luID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkuZmluZCgodykgPT4gIXcuaXNEZXN0cm95ZWQoKSk7XHJcbiAgICBpZiAod2luID09PSB1bmRlZmluZWQpIHJldHVybjtcclxuICAgIE1lbnUuYnVpbGRGcm9tVGVtcGxhdGUoW1xyXG4gICAgICB7IGxhYmVsOiAnXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREJywgYWNjZWxlcmF0b3I6ICdDbWRPckN0cmwrTicsIGNsaWNrOiAoKTogdm9pZCA9PiBzZW5kKCduZXctc2Vzc2lvbicpIH0sXHJcbiAgICAgIHsgbGFiZWw6ICdcdThCQkVcdTdGNkUnLCBhY2NlbGVyYXRvcjogJ0NtZE9yQ3RybCtTaGlmdCtQJywgY2xpY2s6ICgpOiB2b2lkID0+IHNlbmQoJ29wZW4tc2V0dGluZ3MnKSB9LFxyXG4gICAgICB7IGxhYmVsOiAnXHU1RkVCXHU2Mzc3XHU5NTJFJywgYWNjZWxlcmF0b3I6ICdDbWRPckN0cmwrLycsIGNsaWNrOiAoKTogdm9pZCA9PiBzZW5kKCdzaG9ydGN1dHMnKSB9LFxyXG4gICAgICB7IHR5cGU6ICdzZXBhcmF0b3InIH0sXHJcbiAgICAgIHsgbGFiZWw6ICdcdTYyNEJcdTY3M0FcdThGRENcdTdBMEJcdTYzQTdcdTUyMzYnLCBjbGljazogKCk6IHZvaWQgPT4gc2VuZCgnb3Blbi1yZW1vdGUnKSB9LFxyXG4gICAgICB7IHR5cGU6ICdzZXBhcmF0b3InIH0sXHJcbiAgICAgIHtcclxuICAgICAgICBsYWJlbDogdXBkYXRlU3RhdGUuZG93bmxvYWRlZCA/IGBcdTkxQ0RcdTU0MkZcdTVFNzZcdTVCODlcdTg4QzVcdTY2RjRcdTY1QjAodiR7dXBkYXRlU3RhdGUubGF0ZXN0ID8/ICc/J30pYCA6ICdcdTY4QzBcdTY3RTVcdTY2RjRcdTY1QjBcdTIwMjYnLFxyXG4gICAgICAgIGNsaWNrOiAoKTogdm9pZCA9PiB7XHJcbiAgICAgICAgICBpZiAodXBkYXRlU3RhdGUuZG93bmxvYWRlZCkgeyBhcHBseVVwZGF0ZSgpOyByZXR1cm47IH1cclxuICAgICAgICAgIHZvaWQgY2hlY2tGb3JVcGRhdGVzKCkudGhlbigoc3QpID0+IHtcclxuICAgICAgICAgICAgY29uc3QgbmV3ZXIgPSBzdC5sYXRlc3QgIT09IG51bGwgJiYgKGNtcFZlcnNpb24oc3QuY3VycmVudFZlcnNpb24sIHN0LmxhdGVzdCkgPCAwIHx8IFVQREFURV9GT1JDRV9UQUcgIT09ICcnKTtcclxuICAgICAgICAgICAgY29uc3QgZGV0YWlsID0gbmV3ZXIgPyBgJHtzdC5ub3Rlc31cXG5cXG5cdTVCODlcdTg4QzVcdTUzMDVcdTZCNjNcdTU3MjhcdTU0MEVcdTUzRjBcdTRFMEJcdThGN0QsXHU1QjhDXHU2MjEwXHU1NDBFXHU5ODc2XHU5MEU4XHU2QTJBXHU1RTQ1XHU0RjFBXHU1MUZBXHU3M0IwXCJcdTkxQ0RcdTU0MkZcdTY2RjRcdTY1QjBcIlx1NEUwMFx1OTUyRVx1NUI4OVx1ODhDNShcdTY1RTBcdTk3MDBcdTYyNTNcdTVGMDBcdTRFMEJcdThGN0RcdTk4NzUpXHUzMDAyYCA6ICcnO1xyXG4gICAgICAgICAgICB2b2lkIGRpYWxvZy5zaG93TWVzc2FnZUJveCh3aW4sIHtcclxuICAgICAgICAgICAgICB0eXBlOiAnaW5mbycsXHJcbiAgICAgICAgICAgICAgdGl0bGU6ICdcdTY4QzBcdTY3RTVcdTY2RjRcdTY1QjAnLFxyXG4gICAgICAgICAgICAgIG1lc3NhZ2U6IG5ld2VyXHJcbiAgICAgICAgICAgICAgICA/IGBcdTUzRDFcdTczQjBcdTY1QjBcdTcyNDhcdTY3MkMgdiR7c3QubGF0ZXN0fSFgXHJcbiAgICAgICAgICAgICAgICA6IChzdC5lcnJvciAhPT0gJycgPyBgXHU2OEMwXHU2N0U1XHU1OTMxXHU4RDI1OiR7c3QuZXJyb3J9YCA6IGBcdTVERjJcdTY2MkZcdTY3MDBcdTY1QjBcdTcyNDhcdTY3MkModiR7c3QuY3VycmVudFZlcnNpb259KWApLFxyXG4gICAgICAgICAgICAgIGRldGFpbCxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICB9KTtcclxuICAgICAgICB9LFxyXG4gICAgICB9LFxyXG4gICAgICB7XHJcbiAgICAgICAgbGFiZWw6ICdcdTUxNzNcdTRFOEUgSE1IIERlc2t0b3AnLFxyXG4gICAgICAgIGNsaWNrOiAoKTogdm9pZCA9PiB7XHJcbiAgICAgICAgICB2b2lkIGRpYWxvZy5zaG93TWVzc2FnZUJveCh3aW4sIHtcclxuICAgICAgICAgICAgdHlwZTogJ2luZm8nLFxyXG4gICAgICAgICAgICB0aXRsZTogJ1x1NTE3M1x1NEU4RSBITUggRGVza3RvcCcsXHJcbiAgICAgICAgICAgIG1lc3NhZ2U6ICdITUggRGVza3RvcCcsXHJcbiAgICAgICAgICAgIGRldGFpbDogYGFwcCB2JHthcHAuZ2V0VmVyc2lvbigpfSBcdTAwQjcgXHU2NkY0XHU2NUIwXHU5MDFBXHU5MDUzOiR7dXBkYXRlU3RhdGUuY2hhbm5lbCB8fCAnLSd9XFxucnVudGltZTogaG1oYXJuZXNzICR7YnJpZGdlLmhvc3RWZXJzaW9uID8/ICcoXHU2NzJBXHU4RkRFXHU2M0E1KSd9JHt1c2VCdW5kbGVkUnVudGltZSA/ICcoXHU1MTg1XHU3RjZFKScgOiAnJ31cXG5cdTZBMjFcdTVGMEY6ICR7YnJpZGdlLm1vZGUgPT09ICdyZWFsJyA/ICh1c2VCdW5kbGVkUnVudGltZSA/ICdcdTc3MUZcdTVCOUUgaG1oYXJuZXNzKFx1NTE4NVx1N0Y2RSBydW50aW1lKScgOiAnXHU3NzFGXHU1QjlFIGhtaGFybmVzcyhcdTU5MTZcdTkwRThcdTVCODlcdTg4QzUpJykgOiAnXHU2RjE0XHU3OTNBKFx1NTA0N1x1NjU3MFx1NjM2RSknfVxcblxcblx1NEUwRSBDTEkgLyBUVUkgLyBcdTdGNTFcdTk4NzVcdTcyNDhcdTUxNzFcdTRFQUJcdTU0MENcdTRFMDAgSE1IX0hPTUVcdTMwMDJgLFxyXG4gICAgICAgICAgfSk7XHJcbiAgICAgICAgfSxcclxuICAgICAgfSxcclxuICAgICAgeyBsYWJlbDogJ1x1OTAwMFx1NTFGQScsIHJvbGU6ICdxdWl0JyB9LFxyXG4gICAgXSkucG9wdXAoeyB3aW5kb3c6IHdpbiB9KTtcclxuICB9XHJcblxyXG4gIC8qIC0tLS0gXHU2MjRCXHU2NzNBXHU4RkRDXHU3QTBCXHU2M0E3XHU1MjM2KDAzIFx1NTNGNzpXZWIgNzc4OCBcdTY2MkZcdTZENEZcdTg5QzhcdTU2NjgvXHU4RkRDXHU3QTBCL1x1NjI0Qlx1NjczQVx1NTE2NVx1NTNFMyxBRFItMDA1OlxyXG4gICAgIERlc2t0b3AgXHU0RTBEXHU5RUQ4XHU4QkE0XHU2MjUzXHU1RjAwIExBTiBcdTIwMTRcdTIwMTQgXHU4RkQ5XHU5MUNDXHU2NjJGXHU3NTI4XHU2MjM3XHU2NjNFXHU1RjBGXHU1NDJGXHU1MkE4XHU3Njg0XHU1MTY1XHU1M0UzKSAtLS0tICovXHJcbiAgY29uc3QgV0VCX1BPUlQgPSA3Nzg4O1xyXG4gIGFzeW5jIGZ1bmN0aW9uIHByb2JlV2ViUmVtb3RlKCk6IFByb21pc2U8eyB1cDogYm9vbGVhbjsgdmVyc2lvbjogc3RyaW5nIH0+IHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHIgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke1dFQl9QT1JUfS9hcGkvc3RhdGVgLCB7IHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCgxNTAwKSB9KTtcclxuICAgICAgaWYgKCFyLm9rKSByZXR1cm4geyB1cDogZmFsc2UsIHZlcnNpb246ICcnIH07XHJcbiAgICAgIGNvbnN0IGQgPSAoYXdhaXQgci5qc29uKCkpIGFzIHsgZGFlbW9uVmVyc2lvbj86IHN0cmluZyB9O1xyXG4gICAgICByZXR1cm4geyB1cDogdHJ1ZSwgdmVyc2lvbjogU3RyaW5nKGQuZGFlbW9uVmVyc2lvbiA/PyAnJykgfTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4geyB1cDogZmFsc2UsIHZlcnNpb246ICcnIH07IH1cclxuICB9XHJcbiAgLyoqIFx1NUYwMFx1NjczQVx1ODFFQVx1NTQyRlx1NjYyRlx1NTQyNlx1NURGMlx1ODhDNShydW50aW1lIHdlYi1kYWVtb24gXHU3Njg0XHU1NDJGXHU1MkE4XHU5ODc5XHU2NTg3XHU0RUY2XHU1QjU4XHU1NzI4XHU2MDI3OzAuMjMuMzcgXHU2NUIwXHU4MEZEXHU1MjlCKVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIHdlYkF1dG9zdGFydEluc3RhbGxlZCgpOiBib29sZWFuIHtcclxuICAgIGNvbnN0IGhvbWUgPSBwcm9jZXNzLmVudi5IT01FID8/ICcnO1xyXG4gICAgY29uc3QgY2FuZGlkYXRlcyA9IHByb2Nlc3MucGxhdGZvcm0gPT09ICd3aW4zMidcclxuICAgICAgPyBbam9pbihwcm9jZXNzLmVudi5BUFBEQVRBID8/ICcnLCAnTWljcm9zb2Z0JywgJ1dpbmRvd3MnLCAnU3RhcnQgTWVudScsICdQcm9ncmFtcycsICdTdGFydHVwJywgJ2htaGFybmVzcy13ZWItZGFlbW9uLmNtZCcpXVxyXG4gICAgICA6IHByb2Nlc3MucGxhdGZvcm0gPT09ICdkYXJ3aW4nXHJcbiAgICAgICAgPyBbam9pbihob21lLCAnTGlicmFyeScsICdMYXVuY2hBZ2VudHMnLCAnaG1oYXJuZXNzLXdlYi1kYWVtb24ucGxpc3QnKV1cclxuICAgICAgICA6IFtqb2luKGhvbWUsICcuY29uZmlnJywgJ3N5c3RlbWQnLCAndXNlcicsICdobWhhcm5lc3Mtd2ViLWRhZW1vbi5zZXJ2aWNlJyldO1xyXG4gICAgcmV0dXJuIGNhbmRpZGF0ZXMuc29tZSgocCkgPT4geyB0cnkgeyByZXR1cm4gZXhpc3RzU3luYyhwKTsgfSBjYXRjaCB7IHJldHVybiBmYWxzZTsgfSB9KTtcclxuICB9XHJcbiAgLyoqIFx1NjI0Qlx1NjczQVx1NTNFRlx1OERFRlx1NzUzMVx1NzY4NCBMQU4gSVAoUkZDMTkxOCxcdTYzOTJcdTk2NjRcdTg2NUFcdTYyREZcdTdGNTFcdTUzNjEpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gbGFuSXBPZigpOiBzdHJpbmcge1xyXG4gICAgY29uc3QgVklSVFVBTCA9IC92bXdhcmV8dmlydHVhbHxoeXBlci0/dnx2ZXRoZXJuZXR8d3NsfHRhaWxzY2FsZXxsb29wYmFja3xibHVldG9vdGh8dmJveHxkb2NrZXJ8dGFwLXxwc2V1ZG8vaTtcclxuICAgIGNvbnN0IGlzUmZjMTkxOCA9IChhOiBzdHJpbmcpOiBib29sZWFuID0+IC9eMTBcXC4vLnRlc3QoYSkgfHwgL14xOTJcXC4xNjhcXC4vLnRlc3QoYSkgfHwgL14xNzJcXC4oMVs2LTldfDJcXGR8M1swMV0pXFwuLy50ZXN0KGEpO1xyXG4gICAgbGV0IGxhbklwID0gJyc7XHJcbiAgICBsZXQgZmFsbGJhY2sgPSAnJztcclxuICAgIGZvciAoY29uc3QgW25hbWUsIGxpc3RdIG9mIE9iamVjdC5lbnRyaWVzKG5ldHdvcmtJbnRlcmZhY2VzKCkpKSB7XHJcbiAgICAgIGZvciAoY29uc3QgbiBvZiBsaXN0ID8/IFtdKSB7XHJcbiAgICAgICAgaWYgKG4uZmFtaWx5ICE9PSAnSVB2NCcgfHwgbi5pbnRlcm5hbCB8fCAhaXNSZmMxOTE4KG4uYWRkcmVzcykpIGNvbnRpbnVlO1xyXG4gICAgICAgIGlmICghVklSVFVBTC50ZXN0KG5hbWUpKSBsYW5JcCA9IGxhbklwIHx8IG4uYWRkcmVzcztcclxuICAgICAgICBlbHNlIGZhbGxiYWNrID0gZmFsbGJhY2sgfHwgbi5hZGRyZXNzO1xyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gbGFuSXAgfHwgZmFsbGJhY2s7XHJcbiAgfVxyXG4gIC8qKiBDTEkgXHU1MTY1XHU1M0UzOlx1NkU5MFx1NzgwMSByZXBvIFx1NUUwM1x1NUM0MChtYWluLnRzLFx1N0VDRiB0c3gpXHU2MjE2IG5wbSBcdTVCODlcdTg4QzVcdTVFMDNcdTVDNDAoZGlzdC9tYWluLmpzXHJcbiAgICogIFx1NzZGNFx1OEREMVx1MjAxNFx1MjAxNFx1NEVDRSBydW50aW1lIFx1NTE2NVx1NTNFM1x1NEUwQVx1NkVBRlx1NjI3RSBAaG1oYXJuZXNzL2NsaSBcdTUzMDU7XHU1RDRDXHU1OTU3L1x1NjNEMFx1NTM0Ny9cdTZFOTBcdTc4MDFcdTRFMDlcdTc5Q0RcdTVFMDNcdTVDNDBcdTkwMUFcdTU0MDMpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gY2xpRW50cnlPZigpOiBzdHJpbmcge1xyXG4gICAgaWYgKHJ1bnRpbWVFbnRyeSA9PT0gJycgfHwgcnVudGltZUVudHJ5ID09PSBudWxsKSByZXR1cm4gJyc7XHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCBwID0gam9pbihyZXBvUm9vdE9mKHJ1bnRpbWVFbnRyeSksICdwYWNrYWdlcycsICdjbGknLCAnc3JjJywgJ21haW4udHMnKTtcclxuICAgICAgaWYgKGV4aXN0c1N5bmMocCkpIHJldHVybiBwO1xyXG4gICAgfSBjYXRjaCB7IC8qIFx1OTc1RSByZXBvIFx1NUUwM1x1NUM0MCAqLyB9XHJcbiAgICBsZXQgZGlyID0gZGlybmFtZShydW50aW1lRW50cnkpO1xyXG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCA4OyBpKyspIHtcclxuICAgICAgaWYgKGV4aXN0c1N5bmMoam9pbihkaXIsICdkaXN0JywgJ21haW4uanMnKSkgJiYgcGtnTmFtZUF0KGRpcikgPT09ICdAaG1oYXJuZXNzL2NsaScpIHJldHVybiBqb2luKGRpciwgJ2Rpc3QnLCAnbWFpbi5qcycpO1xyXG4gICAgICBpZiAoYmFzZW5hbWUoZGlyKSA9PT0gJ0BobWhhcm5lc3MnICYmIGV4aXN0c1N5bmMoam9pbihkaXIsICdjbGknLCAnZGlzdCcsICdtYWluLmpzJykpKSByZXR1cm4gam9pbihkaXIsICdjbGknLCAnZGlzdCcsICdtYWluLmpzJyk7XHJcbiAgICAgIGNvbnN0IHBhcmVudCA9IGRpcm5hbWUoZGlyKTtcclxuICAgICAgaWYgKHBhcmVudCA9PT0gZGlyKSBicmVhaztcclxuICAgICAgZGlyID0gcGFyZW50O1xyXG4gICAgfVxyXG4gICAgcmV0dXJuICcnO1xyXG4gIH1cclxuICBmdW5jdGlvbiBydW5DbGkoYXJnczogc3RyaW5nW10pOiB2b2lkIHtcclxuICAgIGNvbnN0IGVudHJ5ID0gY2xpRW50cnlPZigpO1xyXG4gICAgaWYgKGVudHJ5ID09PSAnJykgcmV0dXJuO1xyXG4gICAgY29uc3QgaXNUcyA9IGVudHJ5LmVuZHNXaXRoKCcudHMnKTtcclxuICAgIGNvbnN0IHJlcG8gPSByZXBvUm9vdE9mKHJ1bnRpbWVFbnRyeSA/PyBlbnRyeSk7XHJcbiAgICBjb25zdCBjaGlsZCA9IHNwYXduKHByb2Nlc3MuZXhlY1BhdGgsIGlzVHMgPyBbJy0taW1wb3J0JywgJ3RzeCcsIGVudHJ5LCAuLi5hcmdzXSA6IFtlbnRyeSwgLi4uYXJnc10sIHtcclxuICAgICAgY3dkOiBpc1RzID8gcmVwbyA6IGRpcm5hbWUoZW50cnkpLFxyXG4gICAgICBkZXRhY2hlZDogdHJ1ZSxcclxuICAgICAgc3RkaW86ICdpZ25vcmUnLFxyXG4gICAgICB3aW5kb3dzSGlkZTogdHJ1ZSxcclxuICAgICAgZW52OiB7IEVMRUNUUk9OX1JVTl9BU19OT0RFOiAnMScgfSxcclxuICAgIH0pO1xyXG4gICAgY2hpbGQudW5yZWYoKTtcclxuICB9XHJcblxyXG4gIGZ1bmN0aW9uIGJyb2FkY2FzdEhvc3RTdGF0ZShzOiBIb3N0U3RhdGUsIGluZm86IHsgcmVzdGFydENvdW50OiBudW1iZXI7IGxhc3RFcnJvcj86IHN0cmluZyB9KTogdm9pZCB7XHJcbiAgICBicmlkZ2UgPSB7IC4uLmJyaWRnZSwgaG9zdFN0YXRlOiBzLCBob3N0UG9ydDogc3VwZXJ2aXNvcj8uZW5kcG9pbnQ/LnBvcnQgPz8gbnVsbCwgaG9zdFZlcnNpb246IHN1cGVydmlzb3I/LmVuZHBvaW50Py52ZXJzaW9uID8/IG51bGwgfTtcclxuICAgIGxvZ0luZm8oJ2hvc3QnLCBgc3RhdGU9JHtzfSR7aW5mby5sYXN0RXJyb3IgIT09IHVuZGVmaW5lZCA/IGAgZXJyPSR7aW5mby5sYXN0RXJyb3J9YCA6ICcnfWApO1xyXG4gICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XHJcbiAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ2JyaWRnZTpob3N0LXN0YXRlJywgcywgaW5mbyk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvKiogU1NFIFx1NkQ0MVx1OEJBMlx1OTYwNTpcdTRGRTFcdTVDMDEoZXZlbnQ6IGhtaClcdTYyNzlcdTkxQ0ZcdTYzQTggcmVuZGVyZXI7XHU5QUQ4XHU5ODkxIGRlbHRhL2xpbmUgXHU1MzlGXHU1RTI3XHJcbiAgICogIFx1NEY1Q1x1NEUzQVx1NkQ0MVx1NTc1N1x1OEY2Q1x1NTNEMShyZW5kZXJlciBcdTYyRkNcdTYzQTVcdTVGNTNcdTUyNEQgYXNzaXN0YW50IFx1NTM2MFx1NEY0RClcdTMwMDJcdTY1QURcdTdFQkZcdTgxRUFcdTUyQThcdTkxQ0RcdThGREVcdTMwMDIgKi9cclxuICBhc3luYyBmdW5jdGlvbiBwdW1wRXZlbnRzKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgaWYgKGNsaWVudCA9PT0gbnVsbCkgcmV0dXJuO1xyXG4gICAgZm9yICg7Oykge1xyXG4gICAgICBjb25zdCBjID0gY2xpZW50O1xyXG4gICAgICBpZiAoYyA9PT0gbnVsbCkgcmV0dXJuO1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGZvciBhd2FpdCAoY29uc3QgZnJhbWUgb2YgYy5yYXdFdmVudHMobGFzdEV2ZW50SWQgPT09ICcnID8gdW5kZWZpbmVkIDogbGFzdEV2ZW50SWQsIHNzZUFib3J0Py5zaWduYWwpKSB7XHJcbiAgICAgICAgICBpZiAoZnJhbWUuZXZlbnQgPT09ICdobWgnKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGVudiA9IGVudmVsb3BlRnJvbUZyYW1lKGZyYW1lKTtcclxuICAgICAgICAgICAgaWYgKGVudiA9PT0gbnVsbCkge1xyXG4gICAgICAgICAgICAgIGRyb3BwZWRGcmFtZXMgKz0gMTtcclxuICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBsYXN0RXZlbnRJZCA9IGVudi5ldmVudElkO1xyXG4gICAgICAgICAgICBwdXNoRXZlbnQoZW52KTtcclxuICAgICAgICAgIH0gZWxzZSBpZiAoZnJhbWUuZXZlbnQgPT09ICdkZWx0YScgfHwgZnJhbWUuZXZlbnQgPT09ICdsaW5lJykge1xyXG4gICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgIGNvbnN0IGQgPSBKU09OLnBhcnNlKGZyYW1lLmRhdGEpIGFzIHsgc2Vzc2lvbklkPzogc3RyaW5nOyBrPzogc3RyaW5nOyBjaHVuaz86IHN0cmluZzsgdGV4dD86IHN0cmluZyB9O1xyXG4gICAgICAgICAgICAgIGNvbnN0IHBheWxvYWQgPSBmcmFtZS5ldmVudCA9PT0gJ2RlbHRhJ1xyXG4gICAgICAgICAgICAgICAgPyB7IHNlc3Npb25JZDogZC5zZXNzaW9uSWQgPz8gJycsIGtpbmQ6IGQuayA/PyAndGV4dCcsIGNodW5rOiBTdHJpbmcoZC5jaHVuayA/PyAnJykgfVxyXG4gICAgICAgICAgICAgICAgOiB7IHNlc3Npb25JZDogZC5zZXNzaW9uSWQgPz8gJycsIGtpbmQ6ICdsaW5lJywgY2h1bms6IFN0cmluZyhkLnRleHQgPz8gJycpIH07XHJcbiAgICAgICAgICAgICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XHJcbiAgICAgICAgICAgICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCdicmlkZ2U6c3RyZWFtLWNodW5rJywgcGF5bG9hZCk7XHJcbiAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9IGNhdGNoIHsgLyogbWFsZm9ybWVkIHN0cmVhbSBmcmFtZTogc2tpcCAqLyB9XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybjsgLy8gXHU2RDQxXHU2QjYzXHU1RTM4XHU3RUQzXHU2NzVGKGhvc3QgXHU1MTczXHU5NUVEKVxyXG4gICAgICB9IGNhdGNoIHtcclxuICAgICAgICAvLyBcdTY1QURcdTdFQkY6XHU3N0VEXHU5MDAwXHU5MDdGXHU1NDBFXHU5MUNEXHU4RkRFKHN1cGVydmlzb3IgXHU1M0VGXHU4MEZEXHU2QjYzXHU1NzI4XHU5MUNEXHU1NDJGIGhvc3QpXHJcbiAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgMV8wMDApKTtcclxuICAgICAgICBpZiAoc3NlQWJvcnQ/LnNpZ25hbC5hYm9ydGVkKSByZXR1cm47XHJcbiAgICAgIH1cclxuICAgIH1cclxuICB9XHJcblxyXG4gIC8qIC0tLS0gaG1oYXJuZXNzIHJ1bnRpbWUgXHU4MUVBXHU1MkE4XHU1M0QxXHU3M0IwKDIwMjYtMTAtMTAgXHU3NTI4XHU2MjM3XHU1QjlBXHU4QzAzOlx1ODhDNVx1OEZDNyBobWhhcm5lc3MgXHU3Njg0XHJcbiAgICAgXHU2NzNBXHU1NjY4XHU5NkY2XHU5MTREXHU3RjZFXHU3NkY0XHU4RkRFLFx1NTkwRFx1NzUyOCBDTEkvVFVJL3dlYiA3Nzg4IFx1NzY4NFx1NTQwQ1x1NEUwMCBITUhfSE9NRVx1MjAxNFx1MjAxNGNvbmZpZy9wcm92aWRlcnMvXHJcbiAgICAgXHU0RjFBXHU4QkREXHU1Mzg2XHU1M0YyXHU1OTI5XHU3MTM2XHU1MTcxXHU0RUFCKVx1MzAwMnY1LjEgXHU1M0QxXHU3M0IwXHU5ODdBXHU1RThGOlx1NjYzRVx1NUYwRlx1OTE0RFx1N0Y2RSA+IHdoZXJlIGhtaChcdTZFOTBcdTc4MDEgbGluayBcdTRFMEVcclxuICAgICBAaG1oYXJuZXNzL2NsaSBucG0gXHU1Qjg5XHU4OEM1XHU0RTI0XHU3OUNEXHU1RTAzXHU1QzQwKT4gbnBtIFx1NTE2OFx1NUM0MFx1NjgzOShcdTU0MEMpPiBcdTU0MTFcdTVCRkNcdTVCODlcdTg4QzVcdTc2RUVcdTVGNTVcclxuICAgICB+Ly5obWhhcm5lc3MtZ2xvYmFsID4gXHU1RTM4XHU4OUMxXHU2RTkwXHU3ODAxXHU0RjREXHU3RjZFXHUzMDAyICovXHJcbiAgY29uc3QgcnVudGltZUNvbmZpZ0ZpbGUgPSAoKTogc3RyaW5nID0+IGpvaW4oYXBwLmdldFBhdGgoJ3VzZXJEYXRhJyksICdydW50aW1lLmpzb24nKTtcclxuICAvKiogcnVudGltZS5qc29uOnsgZW50cnkoXHU2MjRCXHU1MkE4L1x1NTQxMVx1NUJGQ1x1OTAwOVx1NjJFOVx1NzY4NFx1NTE2NVx1NTNFMyksIGRlbW8oXHU2MzAxXHU0RTQ1XHU2RjE0XHU3OTNBXHU2QTIxXHU1RjBGKSB9XHUzMDAyICovXHJcbiAgYXN5bmMgZnVuY3Rpb24gbG9hZFJ1bnRpbWVDb25maWcoKTogUHJvbWlzZTx7IGVudHJ5OiBzdHJpbmc7IGRlbW86IGJvb2xlYW4gfT4ge1xyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3QgdiA9IEpTT04ucGFyc2UoYXdhaXQgcmVhZEZpbGUocnVudGltZUNvbmZpZ0ZpbGUoKSwgJ3V0ZjgnKSkgYXMgeyBlbnRyeT86IHVua25vd247IGRlbW8/OiB1bmtub3duIH07XHJcbiAgICAgIHJldHVybiB7XHJcbiAgICAgICAgZW50cnk6IHR5cGVvZiB2LmVudHJ5ID09PSAnc3RyaW5nJyAmJiB2LmVudHJ5ICE9PSAnJyAmJiBpc0Fic29sdXRlKHYuZW50cnkpID8gdi5lbnRyeSA6ICcnLFxyXG4gICAgICAgIGRlbW86IHYuZGVtbyA9PT0gdHJ1ZSxcclxuICAgICAgfTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4geyBlbnRyeTogJycsIGRlbW86IGZhbHNlIH07IH1cclxuICB9XHJcbiAgYXN5bmMgZnVuY3Rpb24gc2F2ZVJ1bnRpbWVDb25maWcoY2ZnOiB7IGVudHJ5OiBzdHJpbmc7IGRlbW86IGJvb2xlYW4gfSk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgYXdhaXQgd3JpdGVGaWxlKHJ1bnRpbWVDb25maWdGaWxlKCksIEpTT04uc3RyaW5naWZ5KGNmZywgbnVsbCwgMiksICd1dGY4JykuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcclxuICB9XHJcbiAgYXN5bmMgZnVuY3Rpb24gbG9hZFJ1bnRpbWVFbnRyeU92ZXJyaWRlKCk6IFByb21pc2U8c3RyaW5nPiB7XHJcbiAgICByZXR1cm4gKGF3YWl0IGxvYWRSdW50aW1lQ29uZmlnKCkpLmVudHJ5O1xyXG4gIH1cclxuICBhc3luYyBmdW5jdGlvbiBzYXZlUnVudGltZUVudHJ5T3ZlcnJpZGUoZW50cnk6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgYXdhaXQgc2F2ZVJ1bnRpbWVDb25maWcoeyBlbnRyeSwgZGVtbzogKGF3YWl0IGxvYWRSdW50aW1lQ29uZmlnKCkpLmRlbW8gfSk7XHJcbiAgfVxyXG5cclxuICBpbnRlcmZhY2UgRXh0ZXJuYWxSdW50aW1lIHsgZW50cnk6IHN0cmluZzsgdmVyc2lvbjogc3RyaW5nOyBzb3VyY2U6IHN0cmluZyB9XHJcblxyXG4gIC8qKiBcdThCRkJcdTUzMDVcdTcyNDhcdTY3MkMocGFja2FnZS5qc29uIFx1NzY4NCB2ZXJzaW9uIFx1NUI1N1x1NkJCNTtcdTU5MzFcdThEMjVcdTdBN0FcdTRFMzIpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gcGtnVmVyc2lvbkF0KGRpcjogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHYgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKGRpciwgJ3BhY2thZ2UuanNvbicpLCAndXRmOCcpKSBhcyB7IHZlcnNpb24/OiB1bmtub3duIH07XHJcbiAgICAgIHJldHVybiB0eXBlb2Ygdi52ZXJzaW9uID09PSAnc3RyaW5nJyA/IHYudmVyc2lvbiA6ICcnO1xyXG4gICAgfSBjYXRjaCB7IHJldHVybiAnJzsgfVxyXG4gIH1cclxuICAvKiogXHU4QkZCXHU1MzA1XHU1NDBEKFx1NTQwQ1x1NEUwQTtAaG1oYXJuZXNzL2NsaSBcdTVFMDNcdTVDNDBcdThCQzZcdTUyMkJcdTc1MjgpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gcGtnTmFtZUF0KGRpcjogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHYgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKGRpciwgJ3BhY2thZ2UuanNvbicpLCAndXRmOCcpKSBhcyB7IG5hbWU/OiB1bmtub3duIH07XHJcbiAgICAgIHJldHVybiB0eXBlb2Ygdi5uYW1lID09PSAnc3RyaW5nJyA/IHYubmFtZSA6ICcnO1xyXG4gICAgfSBjYXRjaCB7IHJldHVybiAnJzsgfVxyXG4gIH1cclxuXHJcbiAgLyoqIG5wbSBcdTVCODlcdTg4QzVcdTc2ODQgQGhtaGFybmVzcy9jbGkgXHUyMTkyIGRlc2t0b3AtaG9zdCBcdTdGMTZcdThCRDFcdTUxNjVcdTUzRTMoXHU1RDRDXHU1OTU3XHU0RTBFXHU2M0QwXHU1MzQ3XHU0RTI0XHU3OUNEXHU1RTAzXHU1QzQwKVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIGVudHJ5RnJvbUNsaURpcihjbGlEaXI6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICBjb25zdCBuZXN0ZWQgPSBqb2luKGNsaURpciwgJ25vZGVfbW9kdWxlcycsICdAaG1oYXJuZXNzJywgJ3dlYicsICdkaXN0JywgJ2Rlc2t0b3AtaG9zdC5qcycpO1xyXG4gICAgaWYgKGV4aXN0c1N5bmMobmVzdGVkKSkgcmV0dXJuIG5lc3RlZDtcclxuICAgIGNvbnN0IGhvaXN0ZWQgPSBqb2luKGRpcm5hbWUoY2xpRGlyKSwgJ3dlYicsICdkaXN0JywgJ2Rlc2t0b3AtaG9zdC5qcycpO1xyXG4gICAgaWYgKGV4aXN0c1N5bmMoaG9pc3RlZCkpIHJldHVybiBob2lzdGVkO1xyXG4gICAgcmV0dXJuICcnO1xyXG4gIH1cclxuXHJcbiAgLyoqIFx1NTkxNlx1OTBFOFx1NTNEMVx1NzNCMChcdTRGOUJcdTgxRUFcdTUyQThcdThGREVcdTYzQTVcdTRFMEVcdTU0MTFcdTVCRkNcdTY4QzBcdTZENEJcdTk4NzVcdTUxNzFcdTc1MjgpXHUzMDAyXHU0RjE4XHU1MTQ4XHU3RUE3OmVudiA+IHdoZXJlIGhtaCA+IG5wbVxyXG4gICAqICBcdTUxNjhcdTVDNDBcdTY4MzkgPiBcdTU0MTFcdTVCRkNcdTVCODlcdTg4QzVcdTc2RUVcdTVGNTUgfi8uaG1oYXJuZXNzLWdsb2JhbCA+IFx1NkU5MFx1NzgwMVx1NEVEM1x1NjI2Qlx1NjNDRjtcdTU0MENcdTRFMDBcdTVDNDJcdTUxODVcclxuICAgKiAgXCJcdTVERjJcdTg4QzUgQ0xJKG5wbSBcdTVFMDNcdTVDNDApXCIgXHU1MTQ4XHU0RThFIFwiXHU2RTkwXHU3ODAxIHJlcG8gXHU1RTAzXHU1QzQwXCJcdTMwMDIgKi9cclxuICBmdW5jdGlvbiBkZXRlY3RFeHRlcm5hbFJ1bnRpbWUoKTogRXh0ZXJuYWxSdW50aW1lIHtcclxuICAgIC8vIDEpIFx1NzNBRlx1NTg4M1x1NTNEOFx1OTFDRlx1NjYzRVx1NUYwRlx1ODk4Nlx1NzZENihcdTlBRDhcdTdFQTdcdTc1MjhcdTYyMzcpXHJcbiAgICBjb25zdCBlbnZFbnRyeSA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1JFQUxfRU5UUlk7XHJcbiAgICBpZiAoZW52RW50cnkgIT09IHVuZGVmaW5lZCAmJiBlbnZFbnRyeSAhPT0gJycgJiYgaXNBYnNvbHV0ZShlbnZFbnRyeSkpIHtcclxuICAgICAgcmV0dXJuIHsgZW50cnk6IGVudkVudHJ5LCB2ZXJzaW9uOiAnJywgc291cmNlOiAnZW52JyB9O1xyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IHdoZXJlUmVwb3MgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgIGNvbnN0IHdoZXJlQ2xpczogc3RyaW5nW10gPSBbXTtcclxuICAgIGNvbnN0IG5wbVJlcG9zID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICBsZXQgbnBtQ2xpID0gJyc7XHJcbiAgICAvLyAyKSB3aGVyZSBobWg6bnBtIGxpbmsoXHU2RTkwXHU3ODAxXHU2ODM5XHU1RTAzXHU1QzQwKVx1NEUwRSBAaG1oYXJuZXNzL2NsaSBucG0gXHU1Qjg5XHU4OEM1XHU1RTAzXHU1QzQwXHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCBvdXQgPSBleGVjRmlsZVN5bmMoJ3doZXJlJywgWydobWgnXSwgeyBlbmNvZGluZzogJ3V0ZjgnLCB0aW1lb3V0OiA0XzAwMCwgd2luZG93c0hpZGU6IHRydWUgfSk7XHJcbiAgICAgIGZvciAoY29uc3QgbGluZSBvZiBvdXQuc3BsaXQoL1xccj9cXG4vKSkge1xyXG4gICAgICAgIGNvbnN0IGJpbiA9IGxpbmUudHJpbSgpO1xyXG4gICAgICAgIGlmIChiaW4gPT09ICcnKSBjb250aW51ZTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgY29uc3QgYmluRGlyID0gZGlybmFtZShiaW4pO1xyXG4gICAgICAgICAgY29uc3QgbGlua2VkID0gam9pbihiaW5EaXIsICdub2RlX21vZHVsZXMnLCAnaG1oYXJuZXNzJyk7XHJcbiAgICAgICAgICBpZiAoZXhpc3RzU3luYyhsaW5rZWQpKSB3aGVyZVJlcG9zLmFkZChyZWFscGF0aFN5bmMobGlua2VkKSk7XHJcbiAgICAgICAgICBjb25zdCBjbGkgPSBqb2luKGJpbkRpciwgJ25vZGVfbW9kdWxlcycsICdAaG1oYXJuZXNzJywgJ2NsaScpO1xyXG4gICAgICAgICAgaWYgKGV4aXN0c1N5bmMoY2xpKSkgd2hlcmVDbGlzLnB1c2goY2xpKTtcclxuICAgICAgICB9IGNhdGNoIHsgLyogYmluIFx1NUUwM1x1NUM0MFx1NEUwRFx1N0IyNixcdThERjNcdThGQzcgKi8gfVxyXG4gICAgICB9XHJcbiAgICB9IGNhdGNoIHsgLyogaG1oIFx1NEUwRFx1NTcyOCBQQVRIICovIH1cclxuICAgIC8vIDMpIG5wbSBcdTUxNjhcdTVDNDBcdTY4MzkoXHU0RTI0XHU3OUNEXHU1RTAzXHU1QzQwXHU1NDBDIHdoZXJlKVxyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3Qgb3V0ID0gZXhlY0ZpbGVTeW5jKCducG0nLCBbJ3Jvb3QnLCAnLWcnXSwgeyBlbmNvZGluZzogJ3V0ZjgnLCB0aW1lb3V0OiA2XzAwMCwgd2luZG93c0hpZGU6IHRydWUgfSk7XHJcbiAgICAgIGNvbnN0IHJvb3QgPSBvdXQudHJpbSgpO1xyXG4gICAgICBjb25zdCBsaW5rZWQgPSBqb2luKHJvb3QsICdobWhhcm5lc3MnKTtcclxuICAgICAgaWYgKGV4aXN0c1N5bmMobGlua2VkKSkgbnBtUmVwb3MuYWRkKHJlYWxwYXRoU3luYyhsaW5rZWQpKTtcclxuICAgICAgY29uc3QgY2xpID0gam9pbihyb290LCAnQGhtaGFybmVzcycsICdjbGknKTtcclxuICAgICAgaWYgKGV4aXN0c1N5bmMoY2xpKSkgbnBtQ2xpID0gY2xpO1xyXG4gICAgfSBjYXRjaCB7IC8qIG5wbSBcdTRFMERcdTUzRUZcdTc1MjggKi8gfVxyXG5cclxuICAgIC8vIFx1NURGMlx1ODhDNSBDTEkoQGhtaGFybmVzcy9jbGkgbnBtIFx1NUUwM1x1NUM0MDtkZXNrdG9wLWhvc3QgXHU0RTNBXHU3RjE2XHU4QkQxXHU0RUE3XHU3MjY5XHU1M0VGXHU3NkY0XHU4REQxKTpcclxuICAgIC8vIHdoZXJlKFBBVEggXHU3NzFGXHU3NkY4KT4gbnBtIFx1NTE2OFx1NUM0MFx1NjgzOSA+IFx1NTQxMVx1NUJGQ1x1NUI4OVx1ODhDNVx1NzZFRVx1NUY1NVxyXG4gICAgZm9yIChjb25zdCBbY2xpLCBzb3VyY2VdIG9mIFtbd2hlcmVDbGlzWzBdID8/ICcnLCAnd2hlcmUtaG1oJ10sIFtucG1DbGksICducG0tZ2xvYmFsJ11dIGFzIEFycmF5PFtzdHJpbmcsIHN0cmluZ10+KSB7XHJcbiAgICAgIGlmIChjbGkgPT09ICcnKSBjb250aW51ZTtcclxuICAgICAgY29uc3QgZW50cnkgPSBlbnRyeUZyb21DbGlEaXIoY2xpKTtcclxuICAgICAgaWYgKGVudHJ5ICE9PSAnJykgcmV0dXJuIHsgZW50cnksIHZlcnNpb246IHBrZ1ZlcnNpb25BdChjbGkpLCBzb3VyY2UgfTtcclxuICAgIH1cclxuICAgIGNvbnN0IHdpemFyZEVudHJ5ID0gcmVzb2x2ZUluc3RhbGxlZEVudHJ5KGluc3RhbGxUYXJnZXQoKSk7XHJcbiAgICBpZiAod2l6YXJkRW50cnkgIT09ICcnKSB7XHJcbiAgICAgIHJldHVybiB7IGVudHJ5OiB3aXphcmRFbnRyeSwgdmVyc2lvbjogcGtnVmVyc2lvbkF0KGpvaW4oaW5zdGFsbFRhcmdldCgpLCAnbm9kZV9tb2R1bGVzJywgJ0BobWhhcm5lc3MnLCAnY2xpJykpLCBzb3VyY2U6ICd3aXphcmQtaW5zdGFsbCcgfTtcclxuICAgIH1cclxuXHJcbiAgICAvLyBcdTZFOTBcdTc4MDEgcmVwbyBcdTVFMDNcdTVDNDAod2hlcmUgPiBucG0gXHU1MTY4XHU1QzQwID4gXHU1RTM4XHU4OUMxXHU2RTkwXHU3ODAxXHU0RjREXHU3RjZFO1x1NTQ3RFx1NEUyRFx1OTg3Qlx1NjcwOVx1NTE2NVx1NTNFM1x1NEUwRVx1NEY5RFx1OEQ1NilcclxuICAgIGNvbnN0IHJlcG9zID0gbmV3IFNldDxzdHJpbmc+KFsuLi53aGVyZVJlcG9zLCAuLi5ucG1SZXBvc10pO1xyXG4gICAgY29uc3QgYmFzZXMgPSBbJ0M6XFxcXCcsICdEOlxcXFwnLCAnRTpcXFxcJywgJ0Y6XFxcXCcsICdHOlxcXFwnLCAnSDpcXFxcJywgaG9tZWRpcigpLCBqb2luKGhvbWVkaXIoKSwgJ0RldmVsb3BlcicpXTtcclxuICAgIGZvciAoY29uc3QgYmFzZSBvZiBiYXNlcykge1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHAgPSByZXNvbHZlKGJhc2UsICdobWhhcm5lc3MnKTtcclxuICAgICAgICBpZiAoZXhpc3RzU3luYyhwKSkgcmVwb3MuYWRkKHApO1xyXG4gICAgICB9IGNhdGNoIHsgLyogXHU3NkQ4XHU0RTBEXHU1QjU4XHU1NzI4ICovIH1cclxuICAgIH1cclxuICAgIGZvciAoY29uc3QgcmVwbyBvZiByZXBvcykge1xyXG4gICAgICBjb25zdCBlbnRyeSA9IGpvaW4ocmVwbywgJ3BhY2thZ2VzJywgJ3dlYicsICdzcmMnLCAnZGVza3RvcC1ob3N0LnRzJyk7XHJcbiAgICAgIGlmIChleGlzdHNTeW5jKGVudHJ5KSAmJiBleGlzdHNTeW5jKGpvaW4ocmVwbywgJ25vZGVfbW9kdWxlcycpKSkge1xyXG4gICAgICAgIHJldHVybiB7IGVudHJ5LCB2ZXJzaW9uOiBwa2dWZXJzaW9uQXQocmVwbyksIHNvdXJjZTogJ3NvdXJjZS1yZXBvJyB9O1xyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4geyBlbnRyeTogJycsIHZlcnNpb246ICcnLCBzb3VyY2U6ICcnIH07XHJcbiAgfVxyXG5cclxuICBmdW5jdGlvbiBkZXRlY3RSZWFsRW50cnkoKTogc3RyaW5nIHtcclxuICAgIHJldHVybiBkZXRlY3RFeHRlcm5hbFJ1bnRpbWUoKS5lbnRyeTtcclxuICB9XHJcblxyXG4gIC8qKiBcdTg5RTNcdTY3OTAgcnVudGltZSBcdTUxNjVcdTUzRTNcdTYyNDBcdTVDNUVcdTc2ODQgaG1oYXJuZXNzIFx1NEVEM1x1NUU5M1x1NjgzOShwYWNrYWdlcy93ZWIvc3JjfGRpc3QgXHU0RTBBXHU2RUFGKVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIHJlcG9Sb290T2YoZW50cnk6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICBsZXQgZGlyID0gZGlybmFtZShlbnRyeSk7XHJcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IDY7IGkrKykge1xyXG4gICAgICBpZiAoZXhpc3RzU3luYyhqb2luKGRpciwgJ3BhY2thZ2UuanNvbicpKSAmJiBleGlzdHNTeW5jKGpvaW4oZGlyLCAncGFja2FnZXMnLCAnd2ViJykpKSByZXR1cm4gZGlyO1xyXG4gICAgICBjb25zdCBwYXJlbnQgPSBkaXJuYW1lKGRpcik7XHJcbiAgICAgIGlmIChwYXJlbnQgPT09IGRpcikgYnJlYWs7XHJcbiAgICAgIGRpciA9IHBhcmVudDtcclxuICAgIH1cclxuICAgIHJldHVybiBkaXJuYW1lKGVudHJ5KTtcclxuICB9XHJcblxyXG4gIGxldCBydW50aW1lRW50cnkgPSAnJzsgLy8gXHU1RjUzXHU1MjREXHU1QjlFXHU5NjQ1XHU0RjdGXHU3NTI4XHU3Njg0XHU3NzFGXHU1QjlFIHJ1bnRpbWUgXHU1MTY1XHU1M0UzKCcnPVx1NjcyQVx1NjNBNSlcclxuICBsZXQgdXNlQnVuZGxlZFJ1bnRpbWUgPSBmYWxzZTsgLy8gdjU6XHU2NjJGXHU1NDI2XHU1NzI4XHU3NTI4XHU1MTg1XHU3RjZFIHJ1bnRpbWUoXHU1MTczXHU0RThFL1x1OTc2Mlx1Njc3Rlx1NjgwN1x1NkNFOClcclxuXHJcbiAgLyoqIFx1NTE4NVx1N0Y2RSBydW50aW1lKHY1IFx1NUYwMFx1N0JCMVx1NTM3M1x1NzUyOCk6XHU2MjUzXHU1MzA1XHU1NDBFXHU5NjhGIGV4dHJhUmVzb3VyY2VzIFx1NUU3M1x1OTRGQVx1NTcyOCByZXNvdXJjZXMvO1xyXG4gICAgIGRldiBcdTc1MjhcdTRFRDNcdTVFOTNcdTUxODVcdTY3ODRcdTVFRkFcdTRFQTdcdTcyNjkoc2NyaXB0cy9idW5kbGUtcnVudGltZS5tanMpXHUzMDAyXHU4MUVBXHU1MzA1XHU1NDJCXHU1MzU1XHU2NTg3XHU0RUY2LFx1NjVFMCB0c3hcdTMwMDFcclxuICAgICBcdTY1RTAgcmVwbyBub2RlX21vZHVsZXMgXHU0RjlEXHU4RDU2XHUzMDAyICovXHJcbiAgZnVuY3Rpb24gYnVuZGxlZFJ1bnRpbWVQYXRoKHJlcG9Sb290OiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIGpvaW4oYXBwLmlzUGFja2FnZWQgPyBwcm9jZXNzLnJlc291cmNlc1BhdGggOiBqb2luKHJlcG9Sb290LCAnYXBwcycsICdkZXNrdG9wJywgJ3Jlc291cmNlcycpLCAncnVudGltZScsICdydW50aW1lLmNqcycpO1xyXG4gIH1cclxuXHJcbiAgLyoqIFx1NTE4NVx1N0Y2RSBydW50aW1lIFx1NTE0M1x1NEZFMVx1NjA2RihcdTU0MTFcdTVCRkNcIlx1NTE4NVx1N0Y2RVx1N0NCRVx1N0I4MFx1NTE4NVx1NjgzOFwiXHU5MDA5XHU5ODc5XHU3Njg0XHU3MjQ4XHU2NzJDXHU2ODA3XHU2Q0U4KVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIGJ1bmRsZWRSdW50aW1lSW5mbygpOiB7IHJlYWR5OiBib29sZWFuOyB2ZXJzaW9uOiBzdHJpbmcgfSB7XHJcbiAgICBjb25zdCByZXBvUm9vdCA9IGpvaW4oaGVyZSwgJy4uJywgJy4uJywgJy4uJywgJy4uJyk7XHJcbiAgICBjb25zdCBwID0gYnVuZGxlZFJ1bnRpbWVQYXRoKHJlcG9Sb290KTtcclxuICAgIGxldCB2ZXJzaW9uID0gJyc7XHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCB2ID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoam9pbihkaXJuYW1lKHApLCAncGFja2FnZS5qc29uJyksICd1dGY4JykpIGFzIHsgdmVyc2lvbj86IHVua25vd24gfTtcclxuICAgICAgdmVyc2lvbiA9IHR5cGVvZiB2LnZlcnNpb24gPT09ICdzdHJpbmcnID8gdi52ZXJzaW9uIDogJyc7XHJcbiAgICB9IGNhdGNoIHsgLyogXHU1MTQzXHU2NTcwXHU2MzZFXHU3RjNBXHU1OTMxXHU1MjE5XHU1M0VBXHU2MkE1IHJlYWR5ICovIH1cclxuICAgIHJldHVybiB7IHJlYWR5OiBleGlzdHNTeW5jKHApLCB2ZXJzaW9uIH07XHJcbiAgfVxyXG5cclxuICAvKiogbnBtIFx1NjYyRlx1NTQyNlx1NTcyOCBQQVRIKFx1NTQxMVx1NUJGQ1x1OTAwOVx1NjJFOVx1OTg3NSBcdTI0NjAgXHU3Njg0XHU1Qjg5XHU4OEM1XHU2NUI5XHU1RjBGXHU2ODA3XHU2Q0U4O3doZXJlIFx1NUZFQlx1NjNBMixcdTRFMERcdTUwNUFcdTVCOENcdTY1NzRcdTYzQTJcdTZENEIpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gbnBtT25QYXRoKCk6IGJvb2xlYW4ge1xyXG4gICAgdHJ5IHtcclxuICAgICAgZXhlY0ZpbGVTeW5jKCd3aGVyZScsIFsnbnBtJ10sIHsgZW5jb2Rpbmc6ICd1dGY4JywgdGltZW91dDogNF8wMDAsIHdpbmRvd3NIaWRlOiB0cnVlIH0pO1xyXG4gICAgICByZXR1cm4gdHJ1ZTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4gZmFsc2U7IH1cclxuICB9XHJcblxyXG4gIC8qIC0tLS0gXHU5OTk2XHU1NDJGXHU1Qjg5XHU4OEM1XHU1NDExXHU1QkZDXHU3MkI2XHU2MDAxKHY1LjEpIC0tLS0gKi9cclxuICBjb25zdCB3aXphcmRGaWxlID0gKCk6IHN0cmluZyA9PiBqb2luKGFwcC5nZXRQYXRoKCd1c2VyRGF0YScpLCAnd2l6YXJkLmpzb24nKTtcclxuICBhc3luYyBmdW5jdGlvbiBsb2FkV2l6YXJkU3RhdGUoKTogUHJvbWlzZTx7IGRvbmU6IGJvb2xlYW47IGNob2ljZTogc3RyaW5nIH0+IHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHYgPSBKU09OLnBhcnNlKGF3YWl0IHJlYWRGaWxlKHdpemFyZEZpbGUoKSwgJ3V0ZjgnKSkgYXMgeyBkb25lPzogdW5rbm93bjsgY2hvaWNlPzogdW5rbm93biB9O1xyXG4gICAgICByZXR1cm4geyBkb25lOiB2LmRvbmUgPT09IHRydWUsIGNob2ljZTogdHlwZW9mIHYuY2hvaWNlID09PSAnc3RyaW5nJyA/IHYuY2hvaWNlIDogJycgfTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4geyBkb25lOiBmYWxzZSwgY2hvaWNlOiAnJyB9OyB9XHJcbiAgfVxyXG4gIGFzeW5jIGZ1bmN0aW9uIHNhdmVXaXphcmRTdGF0ZShjaG9pY2U6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgYXdhaXQgd3JpdGVGaWxlKHdpemFyZEZpbGUoKSwgSlNPTi5zdHJpbmdpZnkoeyBkb25lOiB0cnVlLCBjaG9pY2UgfSwgbnVsbCwgMiksICd1dGY4JykuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcclxuICB9XHJcbiAgLyoqIFx1NTQxMVx1NUJGQ1x1ODFFQVx1NTJBOFx1NUYzOVx1NTFGQVx1NjI5MVx1NTIzNjpcdTZENEJcdThCRDUvXHU1RjAwXHU1M0QxXHU3M0FGXHU1ODgzXHU0RTBEXHU1RjM5KFVJVkVSSUZZL1NOQVBTSE9UL1JFTkRFUl9URVNUL1xyXG4gICAqICBET01QUk9CRS9TRUNVUklUWV9URVNUL0ZBS0UvZGV2KTtITUhfREVTS1RPUF9XSVpBUkRfRk9SQ0U9MSBcdTVGM0FcdTUyMzZcdTVGMzkoXHU5QThDXHU2NTM2KVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIHdpemFyZFN1cHByZXNzZWQoKTogYm9vbGVhbiB7XHJcbiAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfV0laQVJEX0ZPUkNFID09PSAnMScpIHJldHVybiBmYWxzZTtcclxuICAgIHJldHVybiBpc0RldlxyXG4gICAgICB8fCBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWSA9PT0gJzEnXHJcbiAgICAgIHx8IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NOQVBTSE9UICE9PSB1bmRlZmluZWRcclxuICAgICAgfHwgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVklTUkVHID09PSAnMSdcclxuICAgICAgfHwgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfUkVOREVSX1RFU1QgPT09ICcxJ1xyXG4gICAgICB8fCBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9ET01QUk9CRSA9PT0gJzEnXHJcbiAgICAgIHx8IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NFQ1VSSVRZX1RFU1QgPT09ICcxJ1xyXG4gICAgICB8fCBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9GQUtFID09PSAnMSc7XHJcbiAgfVxyXG5cclxuICAvKiogXHU1M0QxXHU3M0IwXHU5ODdBXHU1RThGOlx1NjYzRVx1NUYwRlx1ODk4Nlx1NzZENihcdTU0MkJcdTU0MTFcdTVCRkNcdTkwMDlcdTYyRTk6XHU1OTE2XHU5MEU4XHU1MTY1XHU1M0UzL1x1NTE4NVx1N0Y2RVx1OERFRlx1NUY4NC9cdTZGMTRcdTc5M0EpPiBcdTUxODVcdTdGNkVcdTVGMDBcdTUxNzNcclxuICAgICAoSE1IX0RFU0tUT1BfQlVORExFRD0xKT4gXHU1OTE2XHU5MEU4XHU1M0QxXHU3M0IwKGRldiBcdTc2RjhcdTkwQkJcdTRFRDNcdTVFOTMgLyB3aGVyZSBobWggLyBucG0gXHU1MTY4XHU1QzQwIC9cclxuICAgICBcdTU0MTFcdTVCRkNcdTVCODlcdTg4QzVcdTc2RUVcdTVGNTUgLyBcdTZFOTBcdTc4MDFcdTRGNERcdTdGNkUpPiBcdTUxODVcdTdGNkVcdTUxNUNcdTVFOTVcdTMwMDJcdTU5MTZcdTkwRThcdTRGMThcdTUxNDg9XHU4MDAxXHU3NTI4XHU2MjM3XHU3RUU3XHU3RUVEXHU3NTI4XHU4MUVBXHU1REYxXHU4OEM1XHU3Njg0XHU3MjQ4XHU2NzJDO1xyXG4gICAgIFx1NTE4NVx1N0Y2RT1cdTY1QjBcdTY3M0FcdTU2NjhcdTg4QzVcdTVCOENcdTc2RjRcdThGREVcdTc3MUZcdTVCOUVcdTUxODVcdTY4MzhcdTMwMDJITUhfREVTS1RPUF9GQUtFPTEgXHU2MjE2IHJ1bnRpbWUuanNvbiBkZW1vPXRydWVcclxuICAgICAoXHU1NDExXHU1QkZDXCJcdTZGMTRcdTc5M0FcdTZBMjFcdTVGMEZcIlx1OTAwOVx1NjJFOSxcdTYzMDFcdTRFNDUpXHU4RkRCXHU2RjE0XHU3OTNBXHUzMDAyICovXHJcbiAgYXN5bmMgZnVuY3Rpb24gc3RhcnRIb3N0KCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3QgcmVwb1Jvb3QgPSBqb2luKGhlcmUsICcuLicsICcuLicsICcuLicsICcuLicpOyAvLyBhcHBzL2Rlc2t0b3AvZGlzdC1lbGVjdHJvbi9tYWluIFx1MjE5MiByZXBvIHJvb3RcclxuICAgIGNvbnN0IHBhY2thZ2VkID0gYXBwLmlzUGFja2FnZWQ7XHJcbiAgICBjb25zdCBjZmcgPSBhd2FpdCBsb2FkUnVudGltZUNvbmZpZygpO1xyXG4gICAgY29uc3QgZm9yY2VGYWtlID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfRkFLRSA9PT0gJzEnIHx8IGNmZy5kZW1vO1xyXG4gICAgY29uc3QgZm9yY2VCdW5kbGVkID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfQlVORExFRCA9PT0gJzEnO1xyXG4gICAgY29uc3Qgb3ZlcnJpZGUgPSBjZmcuZW50cnk7XHJcbiAgICBjb25zdCBhZGphY2VudCA9IGpvaW4ocmVwb1Jvb3QsICcuLicsICdobWhhcm5lc3MnLCAncGFja2FnZXMnLCAnd2ViJywgJ3NyYycsICdkZXNrdG9wLWhvc3QudHMnKTtcclxuICAgIGNvbnN0IGJ1bmRsZWQgPSBidW5kbGVkUnVudGltZVBhdGgocmVwb1Jvb3QpO1xyXG4gICAgY29uc3QgYnVuZGxlZFJlYWR5ID0gZXhpc3RzU3luYyhidW5kbGVkKTtcclxuICAgIC8vIFx1ODlFM1x1Njc5MChcdTdFRDNcdTY3OUNcdTVGNTJcdTRFMDA6b3ZlcnJpZGU9YnVuZGxlZCBcdThERUZcdTVGODRcdTIxOTJcdTUxODVcdTdGNkU7XHU2RTkwXHU3ODAxIC50cyBcdTk3MDAgdHN4O1xyXG4gICAgLy8gbnBtIFx1NUI4OVx1ODhDNSAuanMgXHU3RjE2XHU4QkQxXHU0RUE3XHU3MjY5XHU3NkY0XHU4REQxO2J1bmRsZWQ9XHU4MUVBXHU1MzA1XHU1NDJCIGNqcyBcdTc2RjRcdThERDEpXHJcbiAgICBsZXQgZW50cnkgPSAnJztcclxuICAgIHVzZUJ1bmRsZWRSdW50aW1lID0gZmFsc2U7XHJcbiAgICBpZiAoZm9yY2VGYWtlKSB7XHJcbiAgICAgIC8vIFx1NkYxNFx1NzkzQVx1NkEyMVx1NUYwRlxyXG4gICAgfSBlbHNlIGlmIChvdmVycmlkZSAhPT0gJycpIHtcclxuICAgICAgZW50cnkgPSBvdmVycmlkZTtcclxuICAgICAgaWYgKG92ZXJyaWRlID09PSBidW5kbGVkKSB1c2VCdW5kbGVkUnVudGltZSA9IHRydWU7IC8vIFx1NTQxMVx1NUJGQ1x1OTAwOVwiXHU1MTg1XHU3RjZFXHU3Q0JFXHU3QjgwXHU1MTg1XHU2ODM4XCJcdTc2ODRcdTYzMDFcdTRFNDVcdTVGNjJcdTYwMDFcclxuICAgIH0gZWxzZSBpZiAoZm9yY2VCdW5kbGVkKSB7XHJcbiAgICAgIGlmIChidW5kbGVkUmVhZHkpIHsgZW50cnkgPSBidW5kbGVkOyB1c2VCdW5kbGVkUnVudGltZSA9IHRydWU7IH1cclxuICAgICAgZWxzZSBsb2dJbmZvKCdob3N0JywgJ0hNSF9ERVNLVE9QX0JVTkRMRUQ9MSBcdTRGNDZcdTUxODVcdTdGNkUgcnVudGltZSBcdTdGM0FcdTU5MzEoXHU1MTQ4XHU4REQxIHNjcmlwdHMvYnVuZGxlLXJ1bnRpbWUubWpzKScpO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgZW50cnkgPSBwYWNrYWdlZCA/IGRldGVjdFJlYWxFbnRyeSgpIDogKGV4aXN0c1N5bmMoYWRqYWNlbnQpID8gYWRqYWNlbnQgOiBkZXRlY3RSZWFsRW50cnkoKSk7XHJcbiAgICAgIGlmIChlbnRyeSA9PT0gJycgJiYgYnVuZGxlZFJlYWR5KSB7IGVudHJ5ID0gYnVuZGxlZDsgdXNlQnVuZGxlZFJ1bnRpbWUgPSB0cnVlOyB9XHJcbiAgICB9XHJcbiAgICBydW50aW1lRW50cnkgPSBlbnRyeTtcclxuICAgIGNvbnN0IHVzZVJlYWwgPSBlbnRyeSAhPT0gJycgJiYgKHVzZUJ1bmRsZWRSdW50aW1lIHx8IGV4aXN0c1N5bmMoZW50cnkpKTtcclxuICAgIGJyaWRnZSA9IHtcclxuICAgICAgLi4uYnJpZGdlLFxyXG4gICAgICBtb2RlOiB1c2VSZWFsID8gJ3JlYWwnIDogJ2Zha2UnLFxyXG4gICAgICBydW50aW1lRW50cnk6IHVzZVJlYWwgPyAodXNlQnVuZGxlZFJ1bnRpbWUgPyBgJHtlbnRyeX0gKGJ1bmRsZWQpYCA6IGVudHJ5KSA6IG51bGwsXHJcbiAgICB9O1xyXG4gICAgbGV0IHNwZWM6IHsgY29tbWFuZDogc3RyaW5nOyBhcmdzOiBzdHJpbmdbXTsgZW52OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+OyBjd2Q/OiBzdHJpbmcgfTtcclxuICAgIGlmICh1c2VCdW5kbGVkUnVudGltZSkge1xyXG4gICAgICBzcGVjID0ge1xyXG4gICAgICAgIGNvbW1hbmQ6IHByb2Nlc3MuZXhlY1BhdGgsXHJcbiAgICAgICAgYXJnczogW2VudHJ5XSwgLy8gXHU4MUVBXHU1MzA1XHU1NDJCXHU1MzU1XHU2NTg3XHU0RUY2OmVsZWN0cm9uLWFzLW5vZGUgXHU3NkY0XHU4REQxLFx1NjVFMCB0c3ggXHU2NUUwIHJlcG9cclxuICAgICAgICBlbnY6IHsgRUxFQ1RST05fUlVOX0FTX05PREU6ICcxJyB9LFxyXG4gICAgICB9O1xyXG4gICAgfSBlbHNlIGlmICh1c2VSZWFsICYmIGVudHJ5LmVuZHNXaXRoKCcuanMnKSkge1xyXG4gICAgICBzcGVjID0ge1xyXG4gICAgICAgIGNvbW1hbmQ6IHByb2Nlc3MuZXhlY1BhdGgsXHJcbiAgICAgICAgYXJnczogW2VudHJ5XSwgLy8gbnBtIFx1NUI4OVx1ODhDNVx1NzY4NFx1N0YxNlx1OEJEMVx1NEVBN1x1NzI2OTpFU00gXHU0RjlEXHU4RDU2XHU2MzA5XHU2NTg3XHU0RUY2XHU0RjREXHU3RjZFXHU4OUUzXHU2NzkwLFx1NzZGNFx1OEREMVx1NTM3M1x1NTNFRlxyXG4gICAgICAgIGN3ZDogZGlybmFtZShlbnRyeSksXHJcbiAgICAgICAgZW52OiB7IEVMRUNUUk9OX1JVTl9BU19OT0RFOiAnMScgfSxcclxuICAgICAgfTtcclxuICAgIH0gZWxzZSBpZiAodXNlUmVhbCkge1xyXG4gICAgICBjb25zdCByZXBvID0gcmVwb1Jvb3RPZihlbnRyeSk7XHJcbiAgICAgIHNwZWMgPSB7XHJcbiAgICAgICAgY29tbWFuZDogcHJvY2Vzcy5leGVjUGF0aCxcclxuICAgICAgICBhcmdzOiBbJy0taW1wb3J0JywgJ3RzeCcsIGVudHJ5XSxcclxuICAgICAgICBjd2Q6IHJlcG8sIC8vIGJhcmUgJ3RzeCcgXHU0RTBFIHdvcmtzcGFjZSBcdTRGOURcdThENTZcdTkwRkRcdTRFQ0UgcmVwbyBcdTc2ODQgbm9kZV9tb2R1bGVzIFx1ODlFM1x1Njc5MFxyXG4gICAgICAgIGVudjogeyBFTEVDVFJPTl9SVU5fQVNfTk9ERTogJzEnIH0sXHJcbiAgICAgIH07XHJcbiAgICB9IGVsc2UgaWYgKHBhY2thZ2VkKSB7XHJcbiAgICAgIHNwZWMgPSB7XHJcbiAgICAgICAgY29tbWFuZDogcHJvY2Vzcy5leGVjUGF0aCxcclxuICAgICAgICBhcmdzOiBbam9pbihwcm9jZXNzLnJlc291cmNlc1BhdGgsICdmYWtlLWhvc3QuY2pzJyldLFxyXG4gICAgICAgIGVudjogeyBFTEVDVFJPTl9SVU5fQVNfTk9ERTogJzEnIH0sXHJcbiAgICAgIH07XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICBzcGVjID0ge1xyXG4gICAgICAgIGNvbW1hbmQ6IHByb2Nlc3MuZXhlY1BhdGgsXHJcbiAgICAgICAgLy8gXHU3NkY0XHU2M0E1XHU4RDcwXHU1MzA1XHU3NzFGXHU1QjlFXHU4REVGXHU1Rjg0KG5vZGVfbW9kdWxlcyBcdTkxQ0NcdTc2ODQgd29ya3NwYWNlIGp1bmN0aW9uIFx1NEYxQVx1ODhBQiBFU01cclxuICAgICAgICAvLyByZWFscGF0aCBcdTUzMTYsXHU1QkZDXHU4MUY0IGZha2UtaG9zdCBcdTc2ODQgYXJndlsxXS9pbXBvcnQubWV0YS51cmwgXHU1MzM5XHU5MTREXHU1OTMxXHU2NTQ4KVxyXG4gICAgICAgIGFyZ3M6IFsnLS1pbXBvcnQnLCAndHN4Jywgam9pbihyZXBvUm9vdCwgJ3BhY2thZ2VzJywgJ2hvc3QtYWRhcHRlcicsICdzcmMnLCAnZmFrZS1ob3N0LnRzJyldLFxyXG4gICAgICAgIGVudjogeyBFTEVDVFJPTl9SVU5fQVNfTk9ERTogJzEnIH0sXHJcbiAgICAgIH07XHJcbiAgICB9XHJcbiAgICBzdXBlcnZpc29yID0gbmV3IERlc2t0b3BSdW50aW1lU3VwZXJ2aXNvcihzcGVjLCB7XHJcbiAgICAgIG9uU3RhdGVDaGFuZ2U6IGJyb2FkY2FzdEhvc3RTdGF0ZSxcclxuICAgICAgLy8gXHU5OTk2XHU2QjIxXHU1NDJGXHU1MkE4XHU0RTBFIGNyYXNoIFx1ODFFQVx1NjEwOFx1NTQwRVx1NzY4NFx1OTFDRFx1NTQyRlx1OTBGRFx1NEYxQVx1OEQ3MFx1OEZEOVx1OTFDQzpcdTdBRUZcdTUzRTMvdG9rZW4gXHU5MEZEXHU2NjJGXHU2NUIwXHU3Njg0LFxyXG4gICAgICAvLyBcdTkxQ0RcdTVFRkFcdTY4NjVcdTVCQTJcdTYyMzdcdTdBRUZcdTVFNzZcdTkxQ0RcdTY1QjBcdThCQTJcdTk2MDUgU1NFKHJlbmRlcmVyIFx1NzY4NCBFdmVudFN0b3JlIFx1OTc2MCBldmVudElkIFx1NTNCQlx1OTFDRClcclxuICAgICAgb25SZWFkeTogKGVwKSA9PiB7XHJcbiAgICAgICAgY2xpZW50ID0gbmV3IERlc2t0b3BIb3N0Q2xpZW50KGBodHRwOi8vMTI3LjAuMC4xOiR7ZXAucG9ydH1gLCBlcC50b2tlbik7XHJcbiAgICAgICAgc3NlQWJvcnQ/LmFib3J0KCk7XHJcbiAgICAgICAgc3NlQWJvcnQgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XHJcbiAgICAgICAgbGFzdEV2ZW50SWQgPSAnJztcclxuICAgICAgICB2b2lkIHB1bXBFdmVudHMoKTtcclxuICAgICAgICBsb2dJbmZvKCdob3N0JywgYGJyaWRnZSByZWFkeSBvbiAxMjcuMC4wLjE6JHtlcC5wb3J0fSAocnVudGltZSAke2VwLnZlcnNpb259LCBtb2RlICR7YnJpZGdlLm1vZGV9JHt1c2VSZWFsID8gYCwgZW50cnk9JHtydW50aW1lRW50cnl9JHt1c2VCdW5kbGVkUnVudGltZSA/ICcgW2J1bmRsZWRdJyA6ICcnfWAgOiAnJ30pYCk7XHJcbiAgICAgIH0sXHJcbiAgICB9KTtcclxuICAgIHRyeSB7XHJcbiAgICAgIGF3YWl0IHN1cGVydmlzb3Iuc3RhcnQoKTtcclxuICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICBjb25zdCBkZXRhaWwgPSAoKCkgPT4geyB0cnkgeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkoZXJyKTsgfSBjYXRjaCB7IHJldHVybiBTdHJpbmcoZXJyKTsgfSB9KSgpLnNsaWNlKDAsIDQwMCk7XHJcbiAgICAgIGJyaWRnZSA9IHsgLi4uYnJpZGdlLCBob3N0U3RhdGU6ICdmYWlsZWQnLCBsYXN0RXJyb3I6IGRldGFpbCB9O1xyXG4gICAgICBsb2dJbmZvKCdob3N0JywgYHN0YXJ0IGZhaWxlZDogJHtkZXRhaWx9YCk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvKiAtLS0tIElQQyBcdTc2N0RcdTU0MERcdTUzNTUgKyBzZW5kZXIgXHU2ODIxXHU5QThDIC0tLS0gKi9cclxuICBjb25zdCBhbGxvd2VkT3JpZ2lucyA9IG5ldyBTZXQ8c3RyaW5nPihcclxuICAgIGlzRGV2ICYmIHJlbmRlcmVyRGV2VXJsXHJcbiAgICAgID8gW3JlbmRlcmVyRGV2VXJsXVxyXG4gICAgICA6IFtwYXRoVG9GaWxlVVJMKGpvaW4oaGVyZSwgJy4uJywgJy4uJywgJ2Rpc3QtcmVuZGVyZXInLCAnaW5kZXguaHRtbCcpKS5ocmVmXSxcclxuICApO1xyXG5cclxuICBmdW5jdGlvbiBzZW5kZXJUcnVzdGVkKHNlbmRlckZyYW1lOiBFbGVjdHJvbi5XZWJGcmFtZU1haW4gfCBudWxsIHwgdW5kZWZpbmVkKTogYm9vbGVhbiB7XHJcbiAgICBpZiAoc2VuZGVyRnJhbWUgPT09IG51bGwgfHwgc2VuZGVyRnJhbWUgPT09IHVuZGVmaW5lZCkgcmV0dXJuIGZhbHNlO1xyXG4gICAgbGV0IHRvcDogRWxlY3Ryb24uV2ViRnJhbWVNYWluIHwgbnVsbCA9IHNlbmRlckZyYW1lO1xyXG4gICAgd2hpbGUgKHRvcD8ucGFyZW50ICE9PSBudWxsICYmIHRvcD8ucGFyZW50ICE9PSB1bmRlZmluZWQpIHRvcCA9IHRvcC5wYXJlbnQ7XHJcbiAgICBjb25zdCB1cmwgPSB0b3A/LnVybCA/PyAnJztcclxuICAgIGZvciAoY29uc3Qgb3JpZ2luIG9mIGFsbG93ZWRPcmlnaW5zKSB7XHJcbiAgICAgIGlmICh1cmwgPT09IG9yaWdpbiB8fCB1cmwuc3RhcnRzV2l0aChgJHtvcmlnaW59L2ApIHx8IHVybC5zdGFydHNXaXRoKGAke29yaWdpbn0/YCkpIHJldHVybiB0cnVlO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGZhbHNlO1xyXG4gIH1cclxuXHJcbiAgLyoqIFx1OTcwMFx1ODk4MSBob3N0IFx1NUMzMVx1N0VFQVx1NzY4NCBJUEMgaGFuZGxlciBcdTUxNkNcdTUxNzFcdTU4RjM6XHU2NzJBXHU1QzMxXHU3RUVBXHU4RkQ0XHU1NkRFXHU3RUQzXHU2Nzg0XHU1MzE2XHU5NTE5XHU4QkVGXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gaG9zdENhbGw8VD4oZXZlbnQ6IEVsZWN0cm9uLklwY01haW5JbnZva2VFdmVudCwgZm46IChjOiBEZXNrdG9wSG9zdENsaWVudCkgPT4gUHJvbWlzZTxUPik6IFByb21pc2U8VCB8IHsgZXJyb3I6IHN0cmluZzsgY29kZTogc3RyaW5nIH0+IHtcclxuICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9KTtcclxuICAgIGlmIChjbGllbnQgPT09IG51bGwgfHwgYnJpZGdlLmhvc3RTdGF0ZSAhPT0gJ3JlYWR5Jykge1xyXG4gICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6IGBob3N0IG5vdCByZWFkeSAoJHticmlkZ2UuaG9zdFN0YXRlfSlgLCBjb2RlOiAnSE9TVF9OT1RfUkVBRFknIH0pO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGZuKGNsaWVudCkuY2F0Y2goKGVycjogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBkZXRhaWwgPSAoKCkgPT4geyB0cnkgeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkoZXJyKTsgfSBjYXRjaCB7IHJldHVybiBTdHJpbmcoZXJyKTsgfSB9KSgpLnNsaWNlKDAsIDMwMCk7XHJcbiAgICAgIHJldHVybiB7IGVycm9yOiBkZXRhaWwsIGNvZGU6ICdCUklER0VfRVJST1InIH07XHJcbiAgICB9KTtcclxuICB9XHJcblxyXG4gIC8qIC0tLS0gXHU0RUQzXHU1RTkzXHU5NzYyXHU2NzdGXHU2NzBEXHU1MkExKFx1NEVGQlx1NTJBMSAxNC1CKS0tLS1cclxuICAgKiBnaC9hZyBDTEkgXHU3Njg0IG1haW4gXHU0RkE3XHU1QzAxXHU4OEM1O1VJVkVSSUZZIGZha2UgXHU2QTIxXHU1RjBGXHU1MTY4XHU5MUNGXHU4RDcwIGZpeHR1cmUoXHU0RTBEXHU3OEIwXHU3OEMxXHU3NkQ4L1x1N0Y1MVx1N0VEQy9cdTUxRURcdTYzNkUpXHUzMDAyXHJcbiAgICogXHU3NjdCXHU1RjU1XHU4ODRDXHU3RUNGIGZvcmdlOmxvZ2luLWxpbmUgXHU2M0E4XHU3RUQ5XHU1MTY4XHU5MEU4XHU3QTk3XHU1M0UzO1VSTCBcdTU5MTZcdTVGMDBcdThENzAgc2hlbGwub3BlbkV4dGVybmFsXHUzMDAyICovXHJcbiAgbGV0IHdzUm9vdHNDYWNoZTogc3RyaW5nW10gPSBbXTtcclxuICBsZXQgcmVhbEZvcmdlOiBGb3JnZVNlcnZpY2UgfCBudWxsID0gbnVsbDtcclxuICAvLyBVSVZFUklGWV9GT1JHRT1yZWFsOlVJVkVSSUZZIFx1Njg0Nlx1NjdCNlx1NTE4NVx1OEREMVx1NzcxRlx1NUI5RSBnaC9hZyBcdTUxOTJcdTcwREYoXHU1M0VBXHU4QkZCKSxmb3JnZSBcdTRFMERcdThENzAgZml4dHVyZVxyXG4gIGNvbnN0IGZvcmdlRml4dHVyZU9mZiA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX0ZPUkdFID09PSAncmVhbCc7XHJcbiAgY29uc3QgZml4dHVyZUZvcmdlOiBGb3JnZVNlcnZpY2UgPSAoKCkgPT4ge1xyXG4gICAgY29uc3QgZiA9IGZvcmdlRml4dHVyZXMoKTtcclxuICAgIHJldHVybiB7XHJcbiAgICAgIHN0YXR1czogYXN5bmMgKCkgPT4gZi5zdGF0dXMsXHJcbiAgICAgIHJlcG9zOiBhc3luYyAoaG9zdCkgPT4gKHsgb2s6IHRydWUgYXMgY29uc3QsIGRhdGE6IGYucmVwb3MoaG9zdCkgfSksXHJcbiAgICAgIHByczogYXN5bmMgKCkgPT4gKHsgb2s6IHRydWUgYXMgY29uc3QsIGRhdGE6IGYucHJzIH0pLFxyXG4gICAgICBpc3N1ZXM6IGFzeW5jICgpID0+ICh7IG9rOiB0cnVlIGFzIGNvbnN0LCBkYXRhOiBmLmlzc3VlcyB9KSxcclxuICAgICAgcmVsZWFzZXM6IGFzeW5jICgpID0+ICh7IG9rOiB0cnVlIGFzIGNvbnN0LCBkYXRhOiBmLnJlbGVhc2VzIH0pLFxyXG4gICAgICBhY3Rpb246IGFzeW5jICgpID0+IGYuYWN0aW9uLFxyXG4gICAgICBsb2dpbjogYXN5bmMgKCkgPT4gZi5sb2dpbixcclxuICAgICAgcmVzb2x2ZTogKCkgPT4gZi5yZXNvbHZlLFxyXG4gICAgfTtcclxuICB9KSgpO1xyXG4gIGZ1bmN0aW9uIGZvcmdlU3ZjKCk6IEZvcmdlU2VydmljZSB7XHJcbiAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRlkgPT09ICcxJyAmJiAhZm9yZ2VGaXh0dXJlT2ZmKSByZXR1cm4gZml4dHVyZUZvcmdlO1xyXG4gICAgaWYgKHJlYWxGb3JnZSA9PT0gbnVsbCkge1xyXG4gICAgICByZWFsRm9yZ2UgPSBjcmVhdGVGb3JnZSh1bmRlZmluZWQsIHtcclxuICAgICAgICBhbGxvd2VkUm9vdHM6ICgpID0+IHdzUm9vdHNDYWNoZSxcclxuICAgICAgICBvbkxvZ2luTGluZTogKGhvc3QsIGxpbmUpID0+IHtcclxuICAgICAgICAgIGxvZ0luZm8oJ2ZvcmdlJywgYCR7aG9zdH0gbG9naW46ICR7bGluZS5zbGljZSgwLCAxNjApfWApO1xyXG4gICAgICAgICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XHJcbiAgICAgICAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ2ZvcmdlOmxvZ2luLWxpbmUnLCBob3N0LCBsaW5lKTtcclxuICAgICAgICAgIH1cclxuICAgICAgICB9LFxyXG4gICAgICAgIG9wZW5FeHRlcm5hbDogKHVybCkgPT4geyB2b2lkIHNoZWxsLm9wZW5FeHRlcm5hbCh1cmwpOyB9LFxyXG4gICAgICB9KTtcclxuICAgIH1cclxuICAgIHJldHVybiByZWFsRm9yZ2U7XHJcbiAgfVxyXG5cclxuICBmdW5jdGlvbiByZWdpc3RlcklwYygpOiB2b2lkIHtcclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6Z2V0LXN0YXRlJywgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicgfTtcclxuICAgICAgcmV0dXJuIHsgLi4uYnJpZGdlLCBkcm9wcGVkRnJhbWVzIH07XHJcbiAgICB9KTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnNlc3Npb25zJywgKGV2ZW50KSA9PlxyXG4gICAgICBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjx7IHNlc3Npb25zOiBBcnJheTx7IGlkOiBzdHJpbmc7IHRpdGxlOiBzdHJpbmc7IHRhc2s6IHN0cmluZzsgb3V0Y29tZTogc3RyaW5nOyB0dXJuczogbnVtYmVyOyB0b29sVXNlczogbnVtYmVyOyB0aW1lOiBzdHJpbmc7IGN3ZDogc3RyaW5nOyBjcmVhdGVkQXQ6IHN0cmluZzsgdXBkYXRlZEF0OiBzdHJpbmcgfT4gfT4oJy9hcGkvc2Vzc2lvbnM/bGltaXQ9MTAwJykpKTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnNlbmQtdGFzaycsIChldmVudCwgdGV4dDogdW5rbm93biwgc2Vzc2lvbklkOiB1bmtub3duLCBtb2RlOiB1bmtub3duLCBhdHRhY2htZW50czogdW5rbm93biwgaW1hZ2VzOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IHRhc2sgPSB0eXBlb2YgdGV4dCA9PT0gJ3N0cmluZycgPyB0ZXh0LnNsaWNlKDAsIDIwXzAwMCkgOiAnJztcclxuICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIHNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBzZXNzaW9uSWQuc2xpY2UoMCwgODApIDogJyc7XHJcbiAgICAgIGNvbnN0IG0gPSBtb2RlID09PSAnYXV0bycgfHwgbW9kZSA9PT0gJ3lvbG8nID8gbW9kZSA6ICdhc2snO1xyXG4gICAgICAvLyBcdTk2NDRcdTRFRjY6XHU1NDBFXHU3QUVGXHU2Mzg4XHU2NzQzIERUTyBcdTc2ODRcdTdFRERcdTVCRjlcdThERUZcdTVGODQoQCBcdTkwMDlcdTYyRTlcdTU2NjgvXHVEODNEXHVEQ0NFIFx1NEUwQVx1NEYyMFx1NTNFQVx1Njc2NVx1ODFFQVx1NjcyQ1x1NTczMFx1NjU4N1x1NEVGNlx1N0NGQlx1N0VERilcclxuICAgICAgY29uc3QgYXR0cyA9IEFycmF5LmlzQXJyYXkoYXR0YWNobWVudHMpID8gYXR0YWNobWVudHMuZmlsdGVyKChhKTogYSBpcyBzdHJpbmcgPT4gdHlwZW9mIGEgPT09ICdzdHJpbmcnKS5zbGljZSgwLCAxMCkgOiBbXTtcclxuICAgICAgLy8gXHU1NkZFXHU3MjQ3OnJ1bnRpbWUgdmlzaW9uIFx1OTRGRVx1NTM0Rlx1OEJBRSB7bmFtZSwgZGF0YVVybH0gYmFzZTY0KFx1MjI2NDMgXHU1RjIwIFx1MjI2NDZNQixyZW5kZXJlciBcdTc1MUZcdTYyMTApXHJcbiAgICAgIGNvbnN0IGltZ3MgPSBBcnJheS5pc0FycmF5KGltYWdlcylcclxuICAgICAgICA/IGltYWdlc1xyXG4gICAgICAgICAgICAuZmlsdGVyKChpbSk6IGltIGlzIHsgbmFtZTogc3RyaW5nOyBkYXRhVXJsOiBzdHJpbmcgfSA9PlxyXG4gICAgICAgICAgICAgIHR5cGVvZiBpbSA9PT0gJ29iamVjdCcgJiYgaW0gIT09IG51bGwgJiYgdHlwZW9mIChpbSBhcyB7IG5hbWU/OiB1bmtub3duIH0pLm5hbWUgPT09ICdzdHJpbmcnICYmIHR5cGVvZiAoaW0gYXMgeyBkYXRhVXJsPzogdW5rbm93biB9KS5kYXRhVXJsID09PSAnc3RyaW5nJylcclxuICAgICAgICAgICAgLnNsaWNlKDAsIDMpXHJcbiAgICAgICAgICAgIC5tYXAoKGltKSA9PiAoeyBuYW1lOiBpbS5uYW1lLnNsaWNlKDAsIDEyMCksIGRhdGFVcmw6IGltLmRhdGFVcmwuc2xpY2UoMCwgOF81MDBfMDAwKSB9KSlcclxuICAgICAgICA6IFtdO1xyXG4gICAgICBpZiAodGFzayA9PT0gJycgfHwgc2lkID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IG9rOiBmYWxzZSwgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcclxuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuOyBydW5JZD86IHN0cmluZyB9PignL2FwaS90YXNrJywgeyB0ZXh0OiB0YXNrLCBzZXNzaW9uSWQ6IHNpZCwgbW9kZTogbSwgYXR0YWNobWVudHM6IGF0dHMsIGltYWdlczogaW1ncyB9KSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIFx1NkEyMVx1NTc4Qlx1NTIwN1x1NjM2MihydW50aW1lIFBPU1QgL2FwaS9tb2RlbDpcdTUyMDcgY2hhdCBcdThERUZcdTc1MzEsY29uZmlnIFx1NTM3M1x1NjVGNlx1NzUxRlx1NjU0OCkgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTptb2RlbC1zZXQnLCAoZXZlbnQsIG5hbWU6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3QgbiA9IHR5cGVvZiBuYW1lID09PSAnc3RyaW5nJyA/IG5hbWUudHJpbSgpLnNsaWNlKDAsIDgwKSA6ICcnO1xyXG4gICAgICBpZiAobiA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ25hbWUgcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW47IG1vZGVsPzogc3RyaW5nIH0+KCcvYXBpL21vZGVsJywgeyBuYW1lOiBuIH0pKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gXHU1RTk0XHU3NTI4XHU1MTg1XHU2NkY0XHU2NUIwKEdpdEh1YiBSZWxlYXNlcztcdTgxRUFcdTc4MTRcdTk2RjZcdTRGOURcdThENTZcdTY2RjRcdTY1QjBcdTU2NjgpIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6Y2hlY2stdXBkYXRlJywgYXN5bmMgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIHJldHVybiBjaGVja0ZvclVwZGF0ZXMoKTtcclxuICAgIH0pO1xyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTphcHBseS11cGRhdGUnLCAoZXZlbnQpID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgaWYgKGluc3RhbGxlclBhdGggPT09IG51bGwpIHJldHVybiB7IGVycm9yOiAnbm8gaW5zdGFsbGVyIGRvd25sb2FkZWQnLCBjb2RlOiAnSE9TVF9OT1RfUkVBRFknIH07XHJcbiAgICAgIGFwcGx5VXBkYXRlKCk7XHJcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlIH07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIFx1NjgwN1x1OTg5OFx1NjgwRlx1NEUzQlx1OTg5OFx1NTQwQ1x1NkI2NShcdTZENDVcdTgyNzJcdTZBMjFcdTVGMEZcdTRFMERcdTUxOERcdTY3MDlcdTlFRDFcdTY3NjEpKyBcdTI2MzAgXHU0RTNCXHU4M0RDXHU1MzU1IC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6Y2hyb21lLXRoZW1lJywgKGV2ZW50LCBkYXJrOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGFwcGx5Q2hyb21lKGRhcmsgPT09IHRydWUpO1xyXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSB9O1xyXG4gICAgfSk7XHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnBvcHVwLW1haW4tbWVudScsIChldmVudCkgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBwb3B1cE1haW5NZW51KCk7XHJcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlIH07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIFx1NjI0Qlx1NjczQVx1OEZEQ1x1N0EwQlx1NjNBN1x1NTIzNig3Nzg4IHdlYiBcdTVCODhcdTYyQTQ7XHU3NTI4XHU2MjM3XHU2NjNFXHU1RjBGXHU1NDJGXHU1MkE4LEFEUi0wMDUgXHU0RTBEXHU5RUQ4XHU4QkE0XHU1RjAwIExBTikgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpyZW1vdGUtd2ViLXN0YXR1cycsIGFzeW5jIChldmVudCkgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBjb25zdCBwID0gYXdhaXQgcHJvYmVXZWJSZW1vdGUoKTtcclxuICAgICAgcmV0dXJuIHsgdXA6IHAudXAsIHZlcnNpb246IHAudmVyc2lvbiwgbGFuSXA6IGxhbklwT2YoKSwgcG9ydDogV0VCX1BPUlQsIGF2YWlsYWJsZTogY2xpRW50cnlPZigpICE9PSAnJywgYXV0b3N0YXJ0OiB3ZWJBdXRvc3RhcnRJbnN0YWxsZWQoKSB9O1xyXG4gICAgfSk7XHJcbiAgICAvLyAtLS0tIFx1NUYwMFx1NjczQVx1ODFFQVx1NTQyRigwLjIzLjM3IHdlYiBpbnN0YWxsLWRhZW1vbi91bmluc3RhbGwtZGFlbW9uO1x1NzY3Qlx1NUY1NVx1NTM3M1x1NUI4OFx1NjJBNFx1NTcyOFx1N0VCRikgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpyZW1vdGUtd2ViLWF1dG9zdGFydCcsIGFzeW5jIChldmVudCwgZW5hYmxlZDogdW5rbm93bikgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBpZiAoY2xpRW50cnlPZigpID09PSAnJykgcmV0dXJuIHsgZXJyb3I6ICdubyBobWhhcm5lc3MgcnVudGltZSBkZXRlY3RlZCcsIGNvZGU6ICdIT1NUX05PVF9SRUFEWScgfTtcclxuICAgICAgcnVuQ2xpKFsnd2ViJywgZW5hYmxlZCA9PT0gdHJ1ZSA/ICdpbnN0YWxsLWRhZW1vbicgOiAndW5pbnN0YWxsLWRhZW1vbiddKTtcclxuICAgICAgLy8gaW5zdGFsbC1kYWVtb24gXHU3QUNCXHU1MzczXHU2MkM5XHU4RDc3XHU1Qjg4XHU2MkE0Olx1OEY2RVx1OEJFMlx1Nzg2RVx1OEJBNDt1bmluc3RhbGwgXHU1MzczXHU2NUY2XHU3NTFGXHU2NTQ4XHJcbiAgICAgIGlmIChlbmFibGVkID09PSB0cnVlKSB7XHJcbiAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCA1MDsgaSsrKSB7XHJcbiAgICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCA1MDApKTtcclxuICAgICAgICAgIGlmICgoYXdhaXQgcHJvYmVXZWJSZW1vdGUoKSkudXApIHJldHVybiB7IG9rOiB0cnVlLCBhdXRvc3RhcnQ6IHdlYkF1dG9zdGFydEluc3RhbGxlZCgpIH07XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiB7IGVycm9yOiAnZGFlbW9uIGRpZCBub3QgY29tZSB1cCB3aXRoaW4gMjVzJywgY29kZTogJ1JVTlRJTUVfQ1JBU0hFRCcgfTtcclxuICAgICAgfVxyXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgYXV0b3N0YXJ0OiB3ZWJBdXRvc3RhcnRJbnN0YWxsZWQoKSB9O1xyXG4gICAgfSk7XHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnJlbW90ZS13ZWItc3RhcnQnLCBhc3luYyAoZXZlbnQpID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgaWYgKGNsaUVudHJ5T2YoKSA9PT0gJycpIHJldHVybiB7IGVycm9yOiAnbm8gaG1oYXJuZXNzIHJ1bnRpbWUgZGV0ZWN0ZWQnLCBjb2RlOiAnSE9TVF9OT1RfUkVBRFknIH07XHJcbiAgICAgIGlmICgoYXdhaXQgcHJvYmVXZWJSZW1vdGUoKSkudXApIHtcclxuICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgYWxyZWFkeTogdHJ1ZSwgbGFuVXJsOiBgaHR0cDovLyR7bGFuSXBPZigpIHx8ICcxMjcuMC4wLjEnfToke1dFQl9QT1JUfWAgfTtcclxuICAgICAgfVxyXG4gICAgICBydW5DbGkoWyd3ZWInLCAnc3RhcnQnLCAnLS1leHBvc3VyZT1sYW4nXSk7XHJcbiAgICAgIC8vIFx1NUI4OFx1NjJBNFx1OEZEQlx1N0EwQlx1NTFCN1x1NTQyRlx1NTJBOCh0c3ggXHU3RjE2XHU4QkQxXHU2NTc0XHU1OTU3IENMSSk6XHU4RjZFXHU4QkUyIDI1c1xyXG4gICAgICBmb3IgKGxldCBpID0gMDsgaSA8IDUwOyBpKyspIHtcclxuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCA1MDApKTtcclxuICAgICAgICBpZiAoKGF3YWl0IHByb2JlV2ViUmVtb3RlKCkpLnVwKSB7XHJcbiAgICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgbGFuVXJsOiBgaHR0cDovLyR7bGFuSXBPZigpIHx8ICcxMjcuMC4wLjEnfToke1dFQl9QT1JUfWAgfTtcclxuICAgICAgICB9XHJcbiAgICAgIH1cclxuICAgICAgcmV0dXJuIHsgZXJyb3I6ICd3ZWIgZGFlbW9uIGRpZCBub3QgY29tZSB1cCB3aXRoaW4gMjVzIChzZWUgSE1IX0hPTUUvd2ViLmxvZyknLCBjb2RlOiAnUlVOVElNRV9DUkFTSEVEJyB9O1xyXG4gICAgfSk7XHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnJlbW90ZS13ZWItc3RvcCcsIGFzeW5jIChldmVudCkgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBydW5DbGkoWyd3ZWInLCAnc3RvcCddKTtcclxuICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCAyMDsgaSsrKSB7XHJcbiAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgNDAwKSk7XHJcbiAgICAgICAgaWYgKCEoYXdhaXQgcHJvYmVXZWJSZW1vdGUoKSkudXApIHJldHVybiB7IG9rOiB0cnVlIH07XHJcbiAgICAgIH1cclxuICAgICAgY29uc3Qgc3RpbGwgPSAoYXdhaXQgcHJvYmVXZWJSZW1vdGUoKSkudXA7XHJcbiAgICAgIHJldHVybiBzdGlsbCA/IHsgZXJyb3I6ICdzdGlsbCBydW5uaW5nJywgY29kZTogJ0JSSURHRV9FUlJPUicgfSA6IHsgb2s6IHRydWUgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gXHVEODNEXHVEQ0NFIFx1NjU4N1x1NEVGNlx1NEUwQVx1NEYyMChcdTY3MkNcdTU3MzBcdTU5MUFcdTkwMDk7cnVudGltZSBcdTY4MjFcdTlBOEMgaW5zaWRlV3MsXHU1REU1XHU0RjVDXHU1MzNBXHU1OTE2XHU2NTg3XHU0RUY2XHU0RjFBXHU4OEFCIDQwMCkgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpwaWNrLWZpbGVzJywgYXN5bmMgKGV2ZW50LCB0aXRsZTogdW5rbm93bikgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBjb25zdCB3aW4gPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5maW5kKCh3KSA9PiAhdy5pc0Rlc3Ryb3llZCgpKTtcclxuICAgICAgaWYgKHdpbiA9PT0gdW5kZWZpbmVkKSByZXR1cm4geyBlcnJvcjogJ25vIHdpbmRvdycsIGNvZGU6ICdCUklER0VfRVJST1InIH07XHJcbiAgICAgIGNvbnN0IHIgPSBhd2FpdCBkaWFsb2cuc2hvd09wZW5EaWFsb2cod2luLCB7XHJcbiAgICAgICAgdGl0bGU6IHR5cGVvZiB0aXRsZSA9PT0gJ3N0cmluZycgJiYgdGl0bGUgIT09ICcnID8gdGl0bGUuc2xpY2UoMCwgMTIwKSA6ICdcdTkwMDlcdTYyRTlcdTg5ODFcdTk2NDRcdTUyQTBcdTc2ODRcdTY1ODdcdTRFRjYoXHU1M0VGXHU1OTFBXHU5MDA5KScsXHJcbiAgICAgICAgcHJvcGVydGllczogWydvcGVuRmlsZScsICdtdWx0aVNlbGVjdGlvbnMnXSxcclxuICAgICAgfSk7XHJcbiAgICAgIGlmIChyLmNhbmNlbGVkIHx8IHIuZmlsZVBhdGhzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBjYW5jZWxlZDogdHJ1ZSB9O1xyXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgcGF0aHM6IHIuZmlsZVBhdGhzLnNsaWNlKDAsIDEwKSB9O1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBcdUQ4M0RcdURDQzEgXHU3NkVFXHU1RjU1XHU5MDA5XHU2MkU5KFx1NURFNVx1NEY1Q1x1NTMzQVx1NkRGQlx1NTJBMFx1NzY4NFx1NkQ0Rlx1ODlDOFx1NjMwOVx1OTRBRTtcdTUzOUZcdTc1MUYgY2hvb3NlcikgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpwaWNrLWRpcmVjdG9yeScsIGFzeW5jIChldmVudCwgdGl0bGU6IHVua25vd24pID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgY29uc3Qgd2luID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkuZmluZCgodykgPT4gIXcuaXNEZXN0cm95ZWQoKSk7XHJcbiAgICAgIGlmICh3aW4gPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgZXJyb3I6ICdubyB3aW5kb3cnLCBjb2RlOiAnQlJJREdFX0VSUk9SJyB9O1xyXG4gICAgICBjb25zdCByID0gYXdhaXQgZGlhbG9nLnNob3dPcGVuRGlhbG9nKHdpbiwge1xyXG4gICAgICAgIHRpdGxlOiB0eXBlb2YgdGl0bGUgPT09ICdzdHJpbmcnICYmIHRpdGxlICE9PSAnJyA/IHRpdGxlLnNsaWNlKDAsIDEyMCkgOiAnXHU5MDA5XHU2MkU5XHU2NTg3XHU0RUY2XHU1OTM5JyxcclxuICAgICAgICBwcm9wZXJ0aWVzOiBbJ29wZW5EaXJlY3RvcnknXSxcclxuICAgICAgfSk7XHJcbiAgICAgIGlmIChyLmNhbmNlbGVkIHx8IHIuZmlsZVBhdGhzWzBdID09PSB1bmRlZmluZWQpIHJldHVybiB7IG9rOiBmYWxzZSwgY2FuY2VsZWQ6IHRydWUgfTtcclxuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHBhdGg6IHIuZmlsZVBhdGhzWzBdIH07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIEAgXHU5NjQ0XHU0RUY2Olx1NURFNVx1NEY1Q1x1NTMzQVx1NjU4N1x1NEVGNlx1NjQxQ1x1N0QyMihydW50aW1lIFx1NjM4OFx1Njc0M1x1NzY4NFx1OERFRlx1NUY4NFx1Njc2NVx1NkU5MCkgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpmcy1zZWFyY2gnLCAoZXZlbnQsIHE6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3QgcXVlcnkgPSB0eXBlb2YgcSA9PT0gJ3N0cmluZycgPyBxLnNsaWNlKDAsIDIwMCkgOiAnJztcclxuICAgICAgaWYgKHF1ZXJ5ID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IHJlc3VsdHM6IFtdIH0pO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248eyByZXN1bHRzOiBBcnJheTx7IHJlbDogc3RyaW5nOyBwYXRoOiBzdHJpbmcgfT4gfT4oYC9hcGkvZnMvc2VhcmNoP3E9JHtlbmNvZGVVUklDb21wb25lbnQocXVlcnkpfWApKTtcclxuICAgIH0pO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6YXBwcm92ZScsIChldmVudCwgZ3JhbnRlZDogdW5rbm93biwgc2Vzc2lvbklkOiB1bmtub3duKSA9PlxyXG4gICAgICBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PignL2FwaS9hcHByb3ZlJywge1xyXG4gICAgICAgIGdyYW50ZWQ6IGdyYW50ZWQgPT09IHRydWUsXHJcbiAgICAgICAgc2Vzc2lvbklkOiB0eXBlb2Ygc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IHNlc3Npb25JZC5zbGljZSgwLCA4MCkgOiAnJyxcclxuICAgICAgfSkpKTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmludGVycnVwdCcsIChldmVudCwgc2Vzc2lvbklkOiB1bmtub3duKSA9PlxyXG4gICAgICBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PignL2FwaS9pbnRlcnJ1cHQnLCB7XHJcbiAgICAgICAgc2Vzc2lvbklkOiB0eXBlb2Ygc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IHNlc3Npb25JZC5zbGljZSgwLCA4MCkgOiAnJyxcclxuICAgICAgfSkpKTtcclxuXHJcbiAgICAvLyAtLS0tIE00Olx1NURFNVx1NEY1Q1x1NTMzQVx1NjU4N1x1NEVGNlx1OTc2MihcdThERUZcdTVGODRcdTYzODhcdTY3NDNcdTU3MjggcnVudGltZTppbnNpZGVXcyBcdTY4MjFcdTlBOEMpIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6ZnMtbGlzdCcsIChldmVudCwgcGF0aDogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBwID0gdHlwZW9mIHBhdGggPT09ICdzdHJpbmcnID8gcGF0aC5zbGljZSgwLCAxMDAwKSA6ICcnO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KGAvYXBpL2ZzP2ZpbGVzPTEke3AgIT09ICcnID8gYCZwYXRoPSR7ZW5jb2RlVVJJQ29tcG9uZW50KHApfWAgOiAnJ31gKSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmZzLXJlYWQnLCAoZXZlbnQsIHBhdGg6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3QgcCA9IHR5cGVvZiBwYXRoID09PSAnc3RyaW5nJyA/IHBhdGguc2xpY2UoMCwgMTAwMCkgOiAnJztcclxuICAgICAgaWYgKHAgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICdwYXRoIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcclxuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPFJlY29yZDxzdHJpbmcsIHVua25vd24+PihgL2FwaS9mcy9yZWFkP3BhdGg9JHtlbmNvZGVVUklDb21wb25lbnQocCl9YCkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTppbmplY3QnLCAoZXZlbnQsIHRleHQ6IHVua25vd24sIHNlc3Npb25JZDogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCB0ID0gdHlwZW9mIHRleHQgPT09ICdzdHJpbmcnID8gdGV4dC5zbGljZSgwLCAyMF8wMDApIDogJyc7XHJcbiAgICAgIGNvbnN0IHNpZCA9IHR5cGVvZiBzZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gc2Vzc2lvbklkLnNsaWNlKDAsIDgwKSA6ICcnO1xyXG4gICAgICBpZiAodCA9PT0gJycgfHwgc2lkID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IG9rOiBmYWxzZSwgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcclxuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KCcvYXBpL2luamVjdCcsIHsgdGV4dDogdCwgc2Vzc2lvbklkOiBzaWQgfSkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBcdTRGMUFcdThCRERcdTVCRkNcdTUxRkEoZXhwb3J0Lm1kIFx1MjE5MiBcdTRGRERcdTVCNThcdTVCRjlcdThCRERcdTY4NDY7XHU2NTg3XHU0RUY2XHU1MTk5XHU1MTY1XHU1M0VBXHU1NzI4IG1haW4pIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6ZXhwb3J0LXNlc3Npb24nLCBhc3luYyAoZXZlbnQsIGlkOiB1bmtub3duLCB0aXRsZTogdW5rbm93bikgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBjb25zdCBzaWQgPSB0eXBlb2YgaWQgPT09ICdzdHJpbmcnID8gaWQucmVwbGFjZSgvW15hLXpBLVowLTlfOi5ALV0vZywgJycpLnNsaWNlKDAsIDgwKSA6ICcnO1xyXG4gICAgICBpZiAoc2lkID09PSAnJykgcmV0dXJuIHsgZXJyb3I6ICdpZCByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfTtcclxuICAgICAgaWYgKGNsaWVudCA9PT0gbnVsbCB8fCBicmlkZ2UuaG9zdFN0YXRlICE9PSAncmVhZHknKSByZXR1cm4geyBlcnJvcjogYGhvc3Qgbm90IHJlYWR5ICgke2JyaWRnZS5ob3N0U3RhdGV9KWAsIGNvZGU6ICdIT1NUX05PVF9SRUFEWScgfTtcclxuICAgICAgdHJ5IHtcclxuICAgICAgICBjb25zdCBtZCA9IGF3YWl0IGNsaWVudC5nZXRUZXh0KGAvYXBpL3Nlc3Npb25zLyR7ZW5jb2RlVVJJQ29tcG9uZW50KHNpZCl9L2V4cG9ydC5tZGApO1xyXG4gICAgICAgIGNvbnN0IHdpbiA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmZpbmQoKHcpID0+ICF3LmlzRGVzdHJveWVkKCkpO1xyXG4gICAgICAgIGlmICh3aW4gPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgZXJyb3I6ICdubyB3aW5kb3cnLCBjb2RlOiAnQlJJREdFX0VSUk9SJyB9O1xyXG4gICAgICAgIGNvbnN0IHIgPSBhd2FpdCBkaWFsb2cuc2hvd1NhdmVEaWFsb2cod2luLCB7XHJcbiAgICAgICAgICB0aXRsZTogdHlwZW9mIHRpdGxlID09PSAnc3RyaW5nJyAmJiB0aXRsZSAhPT0gJycgPyB0aXRsZS5zbGljZSgwLCA4MCkgOiAnXHU1QkZDXHU1MUZBXHU0RjFBXHU4QkREJyxcclxuICAgICAgICAgIGRlZmF1bHRQYXRoOiBgaG1oLSR7c2lkfS5tZGAsXHJcbiAgICAgICAgICBmaWx0ZXJzOiBbeyBuYW1lOiAnTWFya2Rvd24nLCBleHRlbnNpb25zOiBbJ21kJ10gfV0sXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgaWYgKHIuY2FuY2VsZWQgfHwgci5maWxlUGF0aCA9PT0gdW5kZWZpbmVkIHx8IHIuZmlsZVBhdGggPT09ICcnKSByZXR1cm4geyBvazogZmFsc2UsIGNhbmNlbGVkOiB0cnVlIH07XHJcbiAgICAgICAgYXdhaXQgd3JpdGVGaWxlKHIuZmlsZVBhdGgsIG1kLCAndXRmOCcpO1xyXG4gICAgICAgIGxvZ0luZm8oJ2V4cG9ydCcsIGBzZXNzaW9uICR7c2lkfSBcdTIxOTIgJHtyLmZpbGVQYXRofWApO1xyXG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBwYXRoOiByLmZpbGVQYXRoIH07XHJcbiAgICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICAgIGNvbnN0IGRldGFpbCA9ICgoKSA9PiB7IHRyeSB7IHJldHVybiBKU09OLnN0cmluZ2lmeShlcnIpOyB9IGNhdGNoIHsgcmV0dXJuIFN0cmluZyhlcnIpOyB9IH0pKCkuc2xpY2UoMCwgMzAwKTtcclxuICAgICAgICByZXR1cm4geyBlcnJvcjogZGV0YWlsLCBjb2RlOiAnQlJJREdFX0VSUk9SJyB9O1xyXG4gICAgICB9XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIFx1NUJBMVx1NjI3OVx1NkEyMVx1NUYwRlx1OEJGQlx1NTE5OShcdTY3NDNcdTVBMDFcdTU3MjggcnVudGltZSBjb25maWc7XHU1MjA3XHU2MzYyXHU1RkM1XHU5ODdCXHU2NjNFXHU1RjBGKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmFwcHJvdmFsLWdldCcsIChldmVudCkgPT5cclxuICAgICAgaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248eyBzZXR0aW5ncz86IHsgYXBwcm92YWw/OiBzdHJpbmcgfSB9PignL2FwaS9zdGF0ZScpKSk7XHJcblxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTphcHByb3ZhbC1zZXQnLCAoZXZlbnQsIG1vZGU6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3QgbSA9IG1vZGUgPT09ICdhdXRvJyA/ICdhdXRvJyA6IG1vZGUgPT09ICdhc2snID8gJ2FzaycgOiAnJztcclxuICAgICAgaWYgKG0gPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICdtb2RlIG11c3QgYmUgYXNrfGF1dG8nLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvY29uZmlnJywgeyBhcHByb3ZhbDogbSB9KSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIGhtaGFybmVzcyBydW50aW1lIFx1OEZERVx1NjNBNShcdTgxRUFcdTUyQThcdTUzRDFcdTczQjAgKyBcdTYyNEJcdTUyQThcdTg5ODZcdTc2RDYgKyBcdTcwRURcdTUyMDdcdTYzNjIpIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cnVudGltZS1pbmZvJywgYXN5bmMgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IGQgPSBkZXRlY3RFeHRlcm5hbFJ1bnRpbWUoKTtcclxuICAgICAgY29uc3QgY2ZnID0gYXdhaXQgbG9hZFJ1bnRpbWVDb25maWcoKTtcclxuICAgICAgcmV0dXJuIHtcclxuICAgICAgICBtb2RlOiBicmlkZ2UubW9kZSxcclxuICAgICAgICBydW50aW1lRW50cnk6IGJyaWRnZS5ydW50aW1lRW50cnksXHJcbiAgICAgICAgb3ZlcnJpZGU6IGNmZy5lbnRyeSxcclxuICAgICAgICBkZW1vOiBjZmcuZGVtbyxcclxuICAgICAgICBkZXRlY3RlZDogZC5lbnRyeSxcclxuICAgICAgICBkZXRlY3RlZFZlcnNpb246IGQudmVyc2lvbixcclxuICAgICAgICBkZXRlY3RlZFNvdXJjZTogZC5zb3VyY2UsXHJcbiAgICAgIH07XHJcbiAgICB9KTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmJyb3dzZS1ydW50aW1lJywgYXN5bmMgKGV2ZW50LCB0aXRsZTogdW5rbm93bikgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBjb25zdCB3aW4gPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5maW5kKCh3KSA9PiAhdy5pc0Rlc3Ryb3llZCgpKTtcclxuICAgICAgaWYgKHdpbiA9PT0gdW5kZWZpbmVkKSByZXR1cm4geyBlcnJvcjogJ25vIHdpbmRvdycsIGNvZGU6ICdCUklER0VfRVJST1InIH07XHJcbiAgICAgIGNvbnN0IHIgPSBhd2FpdCBkaWFsb2cuc2hvd09wZW5EaWFsb2cod2luLCB7XHJcbiAgICAgICAgdGl0bGU6IHR5cGVvZiB0aXRsZSA9PT0gJ3N0cmluZycgJiYgdGl0bGUgIT09ICcnID8gdGl0bGUuc2xpY2UoMCwgMTIwKSA6ICdcdTkwMDlcdTYyRTkgaG1oYXJuZXNzIFx1NzY4NCBkZXNrdG9wLWhvc3QgXHU1MTY1XHU1M0UzJyxcclxuICAgICAgICBwcm9wZXJ0aWVzOiBbJ29wZW5GaWxlJ10sXHJcbiAgICAgICAgZmlsdGVyczogW3sgbmFtZTogJ2Rlc2t0b3AtaG9zdCcsIGV4dGVuc2lvbnM6IFsndHMnLCAnanMnXSB9XSxcclxuICAgICAgfSk7XHJcbiAgICAgIGlmIChyLmNhbmNlbGVkIHx8IHIuZmlsZVBhdGhzWzBdID09PSB1bmRlZmluZWQpIHJldHVybiB7IG9rOiBmYWxzZSwgY2FuY2VsZWQ6IHRydWUgfTtcclxuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGVudHJ5OiByLmZpbGVQYXRoc1swXSB9O1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyoqIFx1OEJCRVx1N0Y2RS9cdTZFMDVcdTk2NjRcdTYyNEJcdTUyQThcdTUxNjVcdTUzRTNcdTU0MEVcdTcwRURcdTkxQ0RcdTU0MkYgaG9zdChcdTdBN0FcdTRFMzI9XHU1NkRFXHU1MjMwXHU4MUVBXHU1MkE4XHU1M0QxXHU3M0IwKVx1MzAwMiAqL1xyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpzZXQtcnVudGltZScsIGFzeW5jIChldmVudCwgZW50cnk6IHVua25vd24pID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgY29uc3QgZSA9IHR5cGVvZiBlbnRyeSA9PT0gJ3N0cmluZycgPyBlbnRyeS50cmltKCkgOiAnJztcclxuICAgICAgaWYgKGUgIT09ICcnICYmICghaXNBYnNvbHV0ZShlKSB8fCAhZXhpc3RzU3luYyhlKSkpIHtcclxuICAgICAgICByZXR1cm4geyBlcnJvcjogJ1x1NTE2NVx1NTNFM1x1NUZDNVx1OTg3Qlx1NjYyRlx1NUI1OFx1NTcyOFx1NzY4NFx1N0VERFx1NUJGOVx1OERFRlx1NUY4NChkZXNrdG9wLWhvc3QudHMpJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9O1xyXG4gICAgICB9XHJcbiAgICAgIGF3YWl0IHNhdmVSdW50aW1lRW50cnlPdmVycmlkZShlKTtcclxuICAgICAgLy8gXHU3MEVEXHU1MjA3XHU2MzYyOlx1NTE0OFx1NEYxOFx1OTZDNVx1NTA1Q1x1NjM4OVx1NUY1M1x1NTI0RCBob3N0LFx1NTE4RFx1NjMwOVx1NjVCMFx1OTE0RFx1N0Y2RVx1NjJDOVx1OEQ3N1xyXG4gICAgICBzc2VBYm9ydD8uYWJvcnQoKTtcclxuICAgICAgaWYgKHN1cGVydmlzb3IgIT09IG51bGwpIGF3YWl0IHN1cGVydmlzb3Iuc3RvcCgpO1xyXG4gICAgICBhd2FpdCBzdGFydEhvc3QoKTtcclxuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIG1vZGU6IGJyaWRnZS5tb2RlIH07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIHY1LjEgXHU5OTk2XHU1NDJGXHU1Qjg5XHU4OEM1XHU1NDExXHU1QkZDOlx1NjcyQ1x1NjczQVx1NjhDMFx1NkQ0QiAvIFx1NEUwQlx1OEY3RFx1NUI4OVx1ODhDNShcdThGREJcdTVFQTZcdTRFOEJcdTRFRjYpIC8gXHU1NDExXHU1QkZDXHU3MkI2XHU2MDAxIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6ZGV0ZWN0LXJ1bnRpbWUnLCAoZXZlbnQpID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgY29uc3QgaW5mbyA9IGJ1bmRsZWRSdW50aW1lSW5mbygpO1xyXG4gICAgICAvLyBVSVZFUklGWSBcdTU0MTFcdTVCRkNcdTZCNjVcdTc2ODRcIlx1NEYyQVx1OTAyMFx1NjcyQVx1OTE0RFx1N0Y2RVx1NjAwMVwiOmZha2UgXHU2QTIxXHU1RjBGXHU0RTBCXHU2MDUyXHU2MkE1XHU2NzJBXHU2OEMwXHU2RDRCXHJcbiAgICAgIC8vIChcdTc3MUZcdTVCOUVcdTY4QzBcdTZENEJcdThERUZcdTVGODRcdTc1MzEgcmVhbCBcdTUzRDhcdTRGNTNcdTlBOENcdTY1MzYsXHU4OUMxIGV2aWRlbmNlL3NldHVwLXdpemFyZC8pXHUzMDAyXHJcbiAgICAgIC8vIFVJVkVSSUZZX0ZBS0VfREVURUNUX0ZPVU5EPTEodWl2ZXJpZnkgXHU3QTg0XHU1QzRGXHU1NzNBXHU2NjZGXHU4RkQwXHU4ODRDXHU0RTJEXHU1MkE4XHU2MDAxXHU3RjZFXHU0RjREKTpcclxuICAgICAgLy8gXHU0RjJBXHU5MDIwXCJcdTY4QzBcdTZENEJcdTUyMzBcdTVERjJcdTg4QzVcIixcdThCQTlcdTU0MTFcdTVCRkNcdTUxRkFcdTczQjBcdTY4QzBcdTZENEJcdTk4NzVcdTRFMDlcdTkwMDlcdTk4NzkgXHUyMTkyIFx1NTM1NVx1NTFGQlx1NTI0RFx1OEZEQiBcdTIxOTIgXHU5MDA5XHU2MkU5XHU5ODc1XHUzMDAyXHJcbiAgICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9XSVpBUkQgPT09ICdmYWtlJyAmJiBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9GQUtFID09PSAnMScpIHtcclxuICAgICAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfRkFLRV9ERVRFQ1RfRk9VTkQgPT09ICcxJykge1xyXG4gICAgICAgICAgcmV0dXJuIHsgZm91bmQ6IHRydWUsIHZlcnNpb246ICcwLjAuMC12ZXJpZnknLCBlbnRyeTogJ3ZlcmlmeTovL2Zha2UtZW50cnknLCBzb3VyY2U6ICd2ZXJpZnknLCBidW5kbGVkOiBpbmZvLCBucG06IG5wbU9uUGF0aCgpIH07XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiB7IGZvdW5kOiBmYWxzZSwgdmVyc2lvbjogJycsIGVudHJ5OiAnJywgc291cmNlOiAnJywgYnVuZGxlZDogaW5mbywgbnBtOiBucG1PblBhdGgoKSB9O1xyXG4gICAgICB9XHJcbiAgICAgIGNvbnN0IGQgPSBkZXRlY3RFeHRlcm5hbFJ1bnRpbWUoKTtcclxuICAgICAgcmV0dXJuIHsgZm91bmQ6IGQuZW50cnkgIT09ICcnLCB2ZXJzaW9uOiBkLnZlcnNpb24sIGVudHJ5OiBkLmVudHJ5LCBzb3VyY2U6IGQuc291cmNlLCBidW5kbGVkOiBpbmZvLCBucG06IG5wbU9uUGF0aCgpIH07XHJcbiAgICB9KTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmluc3RhbGwtY2xpJywgKGV2ZW50LCBvcHRzOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IG8gPSAob3B0cyA/PyB7fSkgYXMgeyBmb3JjZVRnej86IHVua25vd247IG1pcnJvckZpcnN0PzogdW5rbm93biB9O1xyXG4gICAgICAvLyBVSVZFUklGWSBmYWtlIFx1NTQxMVx1NUJGQzpcdTgxRUFcdTUyQThcdTVCODlcdTg4QzVcdThERUZcdTVGODRcdThENzBcdTZBMjFcdTYyREZcdThGREJcdTVFQTYoXHU0RTBEXHU3OEIwXHU3OEMxXHU3NkQ4L1x1N0Y1MVx1N0VEQy9cdTRFMERcdTcwRURcdTUyMDdcdTYzNjIpLFxyXG4gICAgICAvLyBcdTRFMTRcdTRFMERcdTUzRDEgZG9uZVx1MjAxNFx1MjAxNFx1OUE4Q1x1NjUzNlx1ODk4MVx1NTcyOFx1NUI4OVx1ODhDNVx1OTg3NVx1NzBCOVwiXHU2NTM5XHU3NTI4XHU1MTg1XHU3RjZFXCJcdTUyMDdcdTYzNjJcdTk0RkVcdTYzQTVcdTMwMDJcclxuICAgICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX1dJWkFSRCA9PT0gJ2Zha2UnICYmIHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX0ZBS0UgPT09ICcxJykge1xyXG4gICAgICAgIGNvbnN0IHNlbmRTaW0gPSAocDogSW5zdGFsbFByb2dyZXNzKTogdm9pZCA9PiB7XHJcbiAgICAgICAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcclxuICAgICAgICAgICAgaWYgKCF3LmlzRGVzdHJveWVkKCkpIHcud2ViQ29udGVudHMuc2VuZCgnaW5zdGFsbDpwcm9ncmVzcycsIHApO1xyXG4gICAgICAgICAgfVxyXG4gICAgICAgIH07XHJcbiAgICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgICAgc2VuZFNpbSh7IHBoYXNlOiAnY2hlY2snLCB0ZXh0OiAnXHU2OEMwXHU2N0U1IG5wbVx1MjAyNih2ZXJpZnkgXHU2QTIxXHU2MkRGKScgfSk7XHJcbiAgICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCA0MDApKTtcclxuICAgICAgICAgIHNlbmRTaW0oeyBwaGFzZTogJ25wbScsIHRleHQ6ICducG0gaW5zdGFsbCBAaG1oYXJuZXNzL2NsaSBcdTIxOTIgfi8uaG1oYXJuZXNzLWdsb2JhbCh2ZXJpZnkgXHU2QTIxXHU2MkRGLFx1NEUwRFx1ODQzRFx1NzZEOCknIH0pO1xyXG4gICAgICAgIH0pKCk7XHJcbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHRlc3Q6IHRydWUgfTtcclxuICAgICAgfVxyXG4gICAgICByZXR1cm4gc3RhcnRDbGlJbnN0YWxsKFxyXG4gICAgICAgIHtcclxuICAgICAgICAgIHNlbmRQcm9ncmVzczogKHA6IEluc3RhbGxQcm9ncmVzcyk6IHZvaWQgPT4ge1xyXG4gICAgICAgICAgICBsb2dJbmZvKCdpbnN0YWxsJywgYCR7cC5waGFzZX0ke3AucGN0ICE9PSB1bmRlZmluZWQgPyBgICR7cC5wY3R9JWAgOiAnJ30gJHtwLnRleHR9YCk7XHJcbiAgICAgICAgICAgIGZvciAoY29uc3QgdyBvZiBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKSkge1xyXG4gICAgICAgICAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ2luc3RhbGw6cHJvZ3Jlc3MnLCBwKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgfSxcclxuICAgICAgICAgIGxvZzogKG06IHN0cmluZyk6IHZvaWQgPT4geyBsb2dJbmZvKCdpbnN0YWxsJywgbSk7IH0sXHJcbiAgICAgICAgICAvLyBcdTVCODlcdTg4QzVcdTYyMTBcdTUyOUZcdTUzNzNcdTYzMDFcdTRFNDVcdTUzMTZcdTVFNzZcdTcwRURcdTUyMDdcdTYzNjIoXHU1NDExXHU1QkZDXHU5NjhGXHU1NDBFXHU2NTM2XHU1QzNFO1x1NEUyRFx1OTAxNFx1NTNENlx1NkQ4OFx1NEU1Rlx1NURGMlx1NzUxRlx1NjU0OClcclxuICAgICAgICAgIG9uSW5zdGFsbGVkOiAoZW50cnk6IHN0cmluZyk6IHZvaWQgPT4ge1xyXG4gICAgICAgICAgICB2b2lkIChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgICAgICAgYXdhaXQgc2F2ZVJ1bnRpbWVDb25maWcoeyBlbnRyeSwgZGVtbzogZmFsc2UgfSk7XHJcbiAgICAgICAgICAgICAgc3NlQWJvcnQ/LmFib3J0KCk7XHJcbiAgICAgICAgICAgICAgaWYgKHN1cGVydmlzb3IgIT09IG51bGwpIGF3YWl0IHN1cGVydmlzb3Iuc3RvcCgpO1xyXG4gICAgICAgICAgICAgIGF3YWl0IHN0YXJ0SG9zdCgpO1xyXG4gICAgICAgICAgICB9KSgpO1xyXG4gICAgICAgICAgfSxcclxuICAgICAgICB9LFxyXG4gICAgICAgIHtcclxuICAgICAgICAgIGZvcmNlVGd6OiBvLmZvcmNlVGd6ID09PSB0cnVlLFxyXG4gICAgICAgICAgbWlycm9yRmlyc3Q6IG8ubWlycm9yRmlyc3QgPT09ICducG1taXJyb3InID8gJ25wbW1pcnJvcicgOiBvLm1pcnJvckZpcnN0ID09PSAnbnBtanMnID8gJ25wbWpzJyA6IHVuZGVmaW5lZCxcclxuICAgICAgICB9LFxyXG4gICAgICApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpnZXQtd2l6YXJkJywgYXN5bmMgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IHZhcmlhbnQgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9XSVpBUkQ7XHJcbiAgICAgIGlmICh2YXJpYW50ICE9PSB1bmRlZmluZWQgJiYgdmFyaWFudCAhPT0gJycpIHtcclxuICAgICAgICAvLyBcdTlBOENcdTY1MzZcdTY3ODRcdTkwMjA6XHU1RjNBXHU1MjM2XHU1NDExXHU1QkZDXHU1M0VGXHU4OUMxXHU0RTE0XHU4OUM2XHU0RTNBXHU2NzJBXHU5MTREXHU3RjZFKFx1NTNFRlx1OTFDRFx1NTkwRFx1OEREMSk7cGVyc2lzdGVkPVx1NzcxRlx1NUI5RVx1ODQzRFx1NzZEOFxyXG4gICAgICAgIC8vIFx1NzJCNlx1NjAwMShcdTU0MTFcdTVCRkNcdTZCNjVcdTY1QURcdThBMDBcIlx1OTAwOVx1NjJFOVx1NjMwMVx1NEU0NVwiXHU3NTI4LFx1NEUwRFx1NUY3MVx1NTRDRCBVSSBcdTUyMjRcdTVCOUEpXHJcbiAgICAgICAgY29uc3QgdyA9IGF3YWl0IGxvYWRXaXphcmRTdGF0ZSgpO1xyXG4gICAgICAgIHJldHVybiB7IGRvbmU6IGZhbHNlLCBjaG9pY2U6ICcnLCBzdXBwcmVzc2VkOiBmYWxzZSwgcGVyc2lzdGVkOiB7IGRvbmU6IHcuZG9uZSwgY2hvaWNlOiB3LmNob2ljZSB9IH07XHJcbiAgICAgIH1cclxuICAgICAgY29uc3QgdyA9IGF3YWl0IGxvYWRXaXphcmRTdGF0ZSgpO1xyXG4gICAgICBjb25zdCBjZmcgPSBhd2FpdCBsb2FkUnVudGltZUNvbmZpZygpO1xyXG4gICAgICAvLyBcdTVERjJcdTkxNERcdTdGNkVcdThGQzcgcnVudGltZShcdTYyNEJcdTUyQThcdTUxNjVcdTUzRTMvXHU1NDExXHU1QkZDXHU5MDA5XHU2MkU5L1x1NkYxNFx1NzkzQSlcdTg5QzZcdTU0MENcdTVERjJcdTVCOENcdTYyMTBcdTk5OTZcdTU0MkZcclxuICAgICAgcmV0dXJuIHsgZG9uZTogdy5kb25lIHx8IGNmZy5lbnRyeSAhPT0gJycgfHwgY2ZnLmRlbW8sIGNob2ljZTogdy5jaG9pY2UsIHN1cHByZXNzZWQ6IHdpemFyZFN1cHByZXNzZWQoKSB9O1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyoqIFx1NTQxMVx1NUJGQ1x1NjUzNlx1NUMzRTpcdTYzMDFcdTRFNDVcdTUzMTZcdTkwMDlcdTYyRTlcdTVFNzZcdTVFOTRcdTc1MjgoZXh0ZXJuYWwvYnVuZGxlZFx1MjE5Mlx1NTE2NVx1NTNFM1x1ODk4Nlx1NzZENjtkZW1vXHUyMTkyXHU2MzAxXHU0RTQ1XHU2RjE0XHU3OTNBO1xyXG4gICAgICogIGluc3RhbGxcdTIxOTJcdTUxNjVcdTUzRTNcdTVERjJcdTc1MzFcdTVCODlcdTg4QzVcdTU2NjhcdTYzMDFcdTRFNDVcdTUzMTYsXHU1M0VBXHU4QkIwXHU3MkI2XHU2MDAxKVx1MzAwMmZha2UvXHU2RDRCXHU4QkQ1XHU3M0FGXHU1ODgzXHU1M0VBXHU4QkIwXHU3MkI2XHU2MDAxXHUzMDAyICovXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOndpemFyZC1jb21wbGV0ZScsIGFzeW5jIChldmVudCwgY2hvaWNlOiB1bmtub3duLCBlbnRyeTogdW5rbm93bikgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBjb25zdCBjID0gY2hvaWNlID09PSAnZXh0ZXJuYWwnIHx8IGNob2ljZSA9PT0gJ2luc3RhbGwnIHx8IGNob2ljZSA9PT0gJ2J1bmRsZWQnIHx8IGNob2ljZSA9PT0gJ2RlbW8nID8gY2hvaWNlIDogJyc7XHJcbiAgICAgIGlmIChjID09PSAnJykgcmV0dXJuIHsgZXJyb3I6ICdjaG9pY2UgbXVzdCBiZSBleHRlcm5hbHxpbnN0YWxsfGJ1bmRsZWR8ZGVtbycsIGNvZGU6ICdCQURfUkVRVUVTVCcgfTtcclxuICAgICAgY29uc3QgZSA9IHR5cGVvZiBlbnRyeSA9PT0gJ3N0cmluZycgPyBlbnRyeSA6ICcnO1xyXG4gICAgICBhd2FpdCBzYXZlV2l6YXJkU3RhdGUoYyk7XHJcbiAgICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9GQUtFID09PSAnMScpIHJldHVybiB7IG9rOiB0cnVlLCBtb2RlOiBicmlkZ2UubW9kZSwgdGVzdDogdHJ1ZSB9O1xyXG4gICAgICBjb25zdCByZXBvUm9vdCA9IGpvaW4oaGVyZSwgJy4uJywgJy4uJywgJy4uJywgJy4uJyk7XHJcbiAgICAgIGlmIChjID09PSAnZXh0ZXJuYWwnIHx8IGMgPT09ICdidW5kbGVkJykge1xyXG4gICAgICAgIGNvbnN0IHRhcmdldCA9IGMgPT09ICdidW5kbGVkJyA/IGJ1bmRsZWRSdW50aW1lUGF0aChyZXBvUm9vdCkgOiBlO1xyXG4gICAgICAgIGlmICh0YXJnZXQgPT09ICcnIHx8ICFpc0Fic29sdXRlKHRhcmdldCkgfHwgIWV4aXN0c1N5bmModGFyZ2V0KSkge1xyXG4gICAgICAgICAgcmV0dXJuIHsgZXJyb3I6ICdydW50aW1lIFx1NTE2NVx1NTNFM1x1NEUwRFx1NUI1OFx1NTcyOCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfTtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgc2F2ZVJ1bnRpbWVDb25maWcoeyBlbnRyeTogdGFyZ2V0LCBkZW1vOiBmYWxzZSB9KTtcclxuICAgICAgfSBlbHNlIGlmIChjID09PSAnZGVtbycpIHtcclxuICAgICAgICBhd2FpdCBzYXZlUnVudGltZUNvbmZpZyh7IGVudHJ5OiAnJywgZGVtbzogdHJ1ZSB9KTtcclxuICAgICAgfVxyXG4gICAgICBpZiAoYyAhPT0gJ2luc3RhbGwnKSB7XHJcbiAgICAgICAgLy8gaW5zdGFsbDpcdTVCODlcdTg4QzVcdTU2NjhcdTVERjJcdTU3Mjggb25JbnN0YWxsZWQgXHU2MzAxXHU0RTQ1XHU1MzE2XHU1RTc2XHU3MEVEXHU1MjA3XHU2MzYyLFx1OEZEOVx1OTFDQ1x1NEUwRFx1NTE4RFx1OTFDRFx1NTQyRlxyXG4gICAgICAgIHNzZUFib3J0Py5hYm9ydCgpO1xyXG4gICAgICAgIGlmIChzdXBlcnZpc29yICE9PSBudWxsKSBhd2FpdCBzdXBlcnZpc29yLnN0b3AoKTtcclxuICAgICAgICBhd2FpdCBzdGFydEhvc3QoKTtcclxuICAgICAgfVxyXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgbW9kZTogYnJpZGdlLm1vZGUgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gUHJvdmlkZXIgXHU4QkJFXHU3RjZFKDAzIFx1MDBBN1x1NEUwMzprZXkgXHU1M0VBXHU1MUZBIGhhc0tleS9cdTY3MkJcdTU2REJcdTRGNEQ7XHU0RkREXHU1QjU4XHU3NkY0XHU1MTk5IHJ1bnRpbWUpIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cHJvdmlkZXJzJywgKGV2ZW50KSA9PlxyXG4gICAgICBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjx7IHByb3ZpZGVyc0RldGFpbD86IEFycmF5PHsgbmFtZTogc3RyaW5nOyBtb2RlbDogc3RyaW5nOyBiYXNlVXJsOiBzdHJpbmc7IGhhc0tleTogYm9vbGVhbjsga2V5VGFpbD86IHN0cmluZyB9PjsgbW9kZWw/OiBzdHJpbmcgfT4oJy9hcGkvc3RhdGUnKSkpO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cHJvdmlkZXItc2F2ZScsIChldmVudCwgcHJvdmlkZXI6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3QgcCA9IHByb3ZpZGVyIGFzIHsgbmFtZT86IHVua25vd247IGJhc2VVcmw/OiB1bmtub3duOyBtb2RlbD86IHVua25vd247IGFwaUtleT86IHVua25vd24gfTtcclxuICAgICAgY29uc3QgbmFtZSA9IHR5cGVvZiBwPy5uYW1lID09PSAnc3RyaW5nJyA/IHAubmFtZS5zbGljZSgwLCA4MCkgOiAnJztcclxuICAgICAgY29uc3QgYmFzZVVybCA9IHR5cGVvZiBwPy5iYXNlVXJsID09PSAnc3RyaW5nJyA/IHAuYmFzZVVybC5zbGljZSgwLCAzMDApIDogJyc7XHJcbiAgICAgIGNvbnN0IG1vZGVsID0gdHlwZW9mIHA/Lm1vZGVsID09PSAnc3RyaW5nJyA/IHAubW9kZWwuc2xpY2UoMCwgMTIwKSA6ICcnO1xyXG4gICAgICBpZiAobmFtZSA9PT0gJycgfHwgYmFzZVVybCA9PT0gJycgfHwgbW9kZWwgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICduYW1lL2Jhc2VVcmwvbW9kZWwgcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xyXG4gICAgICBjb25zdCBib2R5OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgbmFtZSwgYmFzZVVybCwgbW9kZWwgfTtcclxuICAgICAgLy8gYXBpS2V5IFx1NTNFQVx1NTcyOFx1NjYzRVx1NUYwRlx1OEY5M1x1NTE2NVx1NjVGNlx1NEUwQVx1NEYyMCxcdTdFRERcdTRFMERcdTU2REVcdTY2M0UocmVuZGVyZXIgXHU4ODY4XHU1MzU1XHU2M0QwXHU0RUE0XHU1NDBFXHU1MzczXHU2RTA1XHU3QTdBKVxyXG4gICAgICBpZiAodHlwZW9mIHA/LmFwaUtleSA9PT0gJ3N0cmluZycgJiYgcC5hcGlLZXkgIT09ICcnKSBib2R5LmFwaUtleSA9IHAuYXBpS2V5LnNsaWNlKDAsIDMwMCk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PignL2FwaS9wcm92aWRlcnMnLCBib2R5KSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIFx1NURFNVx1NEY1Q1x1NTMzQSgwMyBcdTAwQTdcdTUxNkQ7XHU1MjA3XHU2MzYyXHU4QkVEXHU0RTQ5XHU0RTBFIHdlYiBcdTc2RjhcdTU0MEM6cnVudGltZSBcdTUzNTVcdTkwMDkgY3dkKSAtLS0tXHJcbiAgICAvLyBcdTUyMTdcdTg4NjhcdTU0MENcdTY1RjZcdTdGMTNcdTVCNThcdTRFM0EgZm9yZ2UgXHU3Njg0XHU0RTBBXHU0RjIwL1x1NTE0Qlx1OTY4Nlx1OERFRlx1NUY4NFx1OTVFOChcdTUxNDFcdThCQjhcdTc2ODRcdTVERTVcdTRGNUNcdTUzM0FcdTY4MzkpXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOndvcmtzcGFjZXMnLCAoZXZlbnQpID0+XHJcbiAgICAgIGhvc3RDYWxsKGV2ZW50LCBhc3luYyAoYykgPT4ge1xyXG4gICAgICAgIGNvbnN0IHIgPSBhd2FpdCBjLmdldEpzb248eyBjdXJyZW50OiBzdHJpbmc7IGl0ZW1zOiBBcnJheTx7IGlkOiBzdHJpbmc7IG5hbWU6IHN0cmluZzsgcGF0aDogc3RyaW5nIH0+IH0+KCcvYXBpL3dvcmtzcGFjZXMnKTtcclxuICAgICAgICB3c1Jvb3RzQ2FjaGUgPSByLml0ZW1zLm1hcCgodykgPT4gdy5wYXRoKTtcclxuICAgICAgICByZXR1cm4gcjtcclxuICAgICAgfSkpO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6d29ya3NwYWNlLXVzZScsIChldmVudCwgaWQ6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3Qgd2lkID0gdHlwZW9mIGlkID09PSAnc3RyaW5nJyA/IGlkLnNsaWNlKDAsIDYwKSA6ICcnO1xyXG4gICAgICBpZiAod2lkID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAnaWQgcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvd29ya3NwYWNlcy91c2UnLCB7IGlkOiB3aWQgfSkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTp3b3Jrc3BhY2UtYWRkJywgKGV2ZW50LCBuYW1lOiB1bmtub3duLCBwYXRoOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IG4gPSB0eXBlb2YgbmFtZSA9PT0gJ3N0cmluZycgPyBuYW1lLnNsaWNlKDAsIDEyMCkgOiAnJztcclxuICAgICAgY29uc3QgcCA9IHR5cGVvZiBwYXRoID09PSAnc3RyaW5nJyA/IHBhdGguc2xpY2UoMCwgMTAwMCkgOiAnJztcclxuICAgICAgaWYgKHAgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICdwYXRoIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcclxuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KCcvYXBpL3dvcmtzcGFjZXMnLCB7IG5hbWU6IG4gPT09ICcnID8gdW5kZWZpbmVkIDogbiwgcGF0aDogcCB9KSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIFx1NEYxQVx1OEJERFx1NUY1Mlx1Njg2My9cdTUyMjBcdTk2NjQoXHU3OUZCXHU1MTY1IGFyY2hpdmUvdHJhc2gsXHU1M0VGXHU2MDYyXHU1OTBEO3J1bnRpbWUgXHU2NzQzXHU1QTAxKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnNlc3Npb24tb3AnLCAoZXZlbnQsIGlkOiB1bmtub3duLCBvcDogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBzaWQgPSB0eXBlb2YgaWQgPT09ICdzdHJpbmcnID8gaWQucmVwbGFjZSgvW15hLXpBLVowLTlfOi5ALV0vZywgJycpLnNsaWNlKDAsIDgwKSA6ICcnO1xyXG4gICAgICBjb25zdCBvID0gb3AgPT09ICdhcmNoaXZlJyB8fCBvcCA9PT0gJ2RlbGV0ZScgPyBvcCA6ICcnO1xyXG4gICAgICBpZiAoc2lkID09PSAnJyB8fCBvID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAnaWQgYW5kIG9wKGFyY2hpdmV8ZGVsZXRlKSByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PihgL2FwaS9zZXNzaW9ucy8ke2VuY29kZVVSSUNvbXBvbmVudChzaWQpfS8ke299YCwge30pKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gTTQ6RGlmZiBcdTk3NjJcdTY3N0YoXHU1M0VBXHU4QkZCIGdpdCBcdTUzRDhcdTY2RjQ7XHU2Mzg4XHU2NzQzXHU1NzI4IHJ1bnRpbWUpIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6ZGlmZicsIChldmVudCwgc2Vzc2lvbklkOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IHNpZCA9IHR5cGVvZiBzZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gc2Vzc2lvbklkLnNsaWNlKDAsIDgwKSA6ICcnO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KGAvYXBpL2RpZmYke3NpZCAhPT0gJycgPyBgP3Nlc3Npb25JZD0ke2VuY29kZVVSSUNvbXBvbmVudChzaWQpfWAgOiAnJ31gKSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIE01Olx1OEJBNFx1NzdFNVx1NzJCNlx1NjAwMShcdTdFRDNcdTY3ODRcdTUzMTZcdTRFOEJcdTVCOUU7XHU3RjNBXHU2NTcwXHU2MzZFXHU1QjU3XHU2QkI1XHU3NTMxIFVJIFx1NjYzRVx1NzkzQVwiXHU2NUUwXHU2NTcwXHU2MzZFXCIpIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6Y29nbml0aXZlJywgKGV2ZW50KSA9PlxyXG4gICAgICBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oJy9hcGkvY29nbml0aXZlJykpKTtcclxuXHJcbiAgICAvLyAtLS0tIFx1NTM4Nlx1NTNGMlx1NEYxQVx1OEJERFx1OTg4NFx1ODlDOChcdTY3MDBcdTU0MEUgODAgXHU2NzYxLFx1NkJDRlx1Njc2MSA1MDAgXHU1QjU3O3J1bnRpbWUgXHU2NzQzXHU1QTAxXHU2NTcwXHU2MzZFKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnNlc3Npb24tcHJldmlldycsIChldmVudCwgaWQ6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIGlkID09PSAnc3RyaW5nJyA/IGlkLnJlcGxhY2UoL1teYS16QS1aMC05XzouQC1dL2csICcnKS5zbGljZSgwLCA4MCkgOiAnJztcclxuICAgICAgaWYgKHNpZCA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ2lkIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcclxuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPFJlY29yZDxzdHJpbmcsIHVua25vd24+PihgL2FwaS9zZXNzaW9ucy8ke2VuY29kZVVSSUNvbXBvbmVudChzaWQpfWApKTtcclxuICAgIH0pO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6c3RvcC1ob3N0JywgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicgfTtcclxuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIHNzZUFib3J0Py5hYm9ydCgpO1xyXG4gICAgICAgIGF3YWl0IHN1cGVydmlzb3I/LnN0b3AoKTtcclxuICAgICAgICBhcHAucXVpdCgpO1xyXG4gICAgICB9KSgpO1xyXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSB9O1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBcdTRFRDNcdTVFOTNcdTk3NjJcdTY3N0YgSVBDKFx1NEVGQlx1NTJBMSAxNC1COlx1OTAxMFx1NjVCOVx1NkNENVx1NzY3RFx1NTQwRFx1NTM1NSArIFx1NTNDMlx1NjU3MFx1NjgyMVx1OUE4QztyZW5kZXJlciBcdTZDMzhcdTRFMEQgc3Bhd24pIC0tLS1cclxuICAgIGNvbnN0IGZvcmdlRXJyID0gKGV2ZW50OiBFbGVjdHJvbi5JcGNNYWluSW52b2tlRXZlbnQsIGZuOiAoKSA9PiBQcm9taXNlPHVua25vd24+KTogUHJvbWlzZTx1bmtub3duPiA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9KTtcclxuICAgICAgcmV0dXJuIGZuKCkuY2F0Y2goKGVycjogdW5rbm93bikgPT4gKHsgb2s6IGZhbHNlLCBjb2RlOiAnQlJJREdFX0VSUk9SJywgZXJyb3I6IFN0cmluZyhlcnIpLnNsaWNlKDAsIDMwMCkgfSkpO1xyXG4gICAgfTtcclxuICAgIGlwY01haW4uaGFuZGxlKCdmb3JnZTpzdGF0dXMnLCAoZXZlbnQpID0+IGZvcmdlRXJyKGV2ZW50LCAoKSA9PiBmb3JnZVN2YygpLnN0YXR1cygpKSk7XHJcbiAgICBpcGNNYWluLmhhbmRsZSgnZm9yZ2U6bG9naW4nLCAoZXZlbnQsIGg6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3QgaG9zdCA9IGNoZWNrSG9zdChoKTtcclxuICAgICAgaWYgKGhvc3QgPT09IG51bGwpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBvazogZmFsc2UsIGNvZGU6ICdCQURfUkVRVUVTVCcsIGVycm9yOiAnaG9zdCBtdXN0IGJlIGdpdGh1YnxhdG9tZ2l0JyB9KTtcclxuICAgICAgcmV0dXJuIGZvcmdlRXJyKGV2ZW50LCAoKSA9PiBmb3JnZVN2YygpLmxvZ2luKGhvc3QpKTtcclxuICAgIH0pO1xyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2ZvcmdlOnJlcG9zJywgKGV2ZW50LCBoOiB1bmtub3duLCBwYWdlOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IGhvc3QgPSBjaGVja0hvc3QoaCk7XHJcbiAgICAgIGNvbnN0IHAgPSB0eXBlb2YgcGFnZSA9PT0gJ251bWJlcicgJiYgTnVtYmVyLmlzRmluaXRlKHBhZ2UpID8gTWF0aC5mbG9vcihwYWdlKSA6IDE7XHJcbiAgICAgIGlmIChob3N0ID09PSBudWxsKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgb2s6IGZhbHNlLCBjb2RlOiAnQkFEX1JFUVVFU1QnLCBlcnJvcjogJ2hvc3QgbXVzdCBiZSBnaXRodWJ8YXRvbWdpdCcgfSk7XHJcbiAgICAgIHJldHVybiBmb3JnZUVycihldmVudCwgKCkgPT4gZm9yZ2VTdmMoKS5yZXBvcyhob3N0LCBwKSk7XHJcbiAgICB9KTtcclxuICAgIGNvbnN0IHJlcG9BcmdzID0gKGg6IHVua25vd24sIHJlcG86IHVua25vd24pOiB7IGhvc3Q6IEZvcmdlSG9zdDsgcmVwbzogc3RyaW5nIH0gfCB7IGJhZDogc3RyaW5nIH0gPT4ge1xyXG4gICAgICBjb25zdCBob3N0ID0gY2hlY2tIb3N0KGgpO1xyXG4gICAgICBjb25zdCByID0gY2hlY2tSZXBvKHJlcG8pO1xyXG4gICAgICBpZiAoaG9zdCA9PT0gbnVsbCB8fCByID09PSBudWxsKSByZXR1cm4geyBiYWQ6ICdob3N0IG11c3QgYmUgZ2l0aHVifGF0b21naXQsIHJlcG8gbXVzdCBiZSBvd25lci9uYW1lJyB9O1xyXG4gICAgICByZXR1cm4geyBob3N0LCByZXBvOiByIH07XHJcbiAgICB9O1xyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2ZvcmdlOnBycycsIChldmVudCwgaDogdW5rbm93biwgcmVwbzogdW5rbm93biwgc3RhdGU6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3QgYSA9IHJlcG9BcmdzKGgsIHJlcG8pO1xyXG4gICAgICBpZiAoJ2JhZCcgaW4gYSkgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IG9rOiBmYWxzZSwgY29kZTogJ0JBRF9SRVFVRVNUJywgZXJyb3I6IGEuYmFkIH0pO1xyXG4gICAgICByZXR1cm4gZm9yZ2VFcnIoZXZlbnQsICgpID0+IGZvcmdlU3ZjKCkucHJzKGEuaG9zdCwgYS5yZXBvLCBjaGVja1N0YXRlKHN0YXRlKSkpO1xyXG4gICAgfSk7XHJcbiAgICBpcGNNYWluLmhhbmRsZSgnZm9yZ2U6aXNzdWVzJywgKGV2ZW50LCBoOiB1bmtub3duLCByZXBvOiB1bmtub3duLCBzdGF0ZTogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBhID0gcmVwb0FyZ3MoaCwgcmVwbyk7XHJcbiAgICAgIGlmICgnYmFkJyBpbiBhKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgb2s6IGZhbHNlLCBjb2RlOiAnQkFEX1JFUVVFU1QnLCBlcnJvcjogYS5iYWQgfSk7XHJcbiAgICAgIHJldHVybiBmb3JnZUVycihldmVudCwgKCkgPT4gZm9yZ2VTdmMoKS5pc3N1ZXMoYS5ob3N0LCBhLnJlcG8sIGNoZWNrU3RhdGUoc3RhdGUpKSk7XHJcbiAgICB9KTtcclxuICAgIGlwY01haW4uaGFuZGxlKCdmb3JnZTpyZWxlYXNlcycsIChldmVudCwgaDogdW5rbm93biwgcmVwbzogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBhID0gcmVwb0FyZ3MoaCwgcmVwbyk7XHJcbiAgICAgIGlmICgnYmFkJyBpbiBhKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgb2s6IGZhbHNlLCBjb2RlOiAnQkFEX1JFUVVFU1QnLCBlcnJvcjogYS5iYWQgfSk7XHJcbiAgICAgIHJldHVybiBmb3JnZUVycihldmVudCwgKCkgPT4gZm9yZ2VTdmMoKS5yZWxlYXNlcyhhLmhvc3QsIGEucmVwbykpO1xyXG4gICAgfSk7XHJcbiAgICBjb25zdCBBQ1RJT05fS0lORFM6IHJlYWRvbmx5IEZvcmdlQWN0aW9uS2luZFtdID0gWydwcl9jcmVhdGUnLCAncHJfbWVyZ2UnLCAnaXNzdWVfY3JlYXRlJywgJ3JlbGVhc2VfY3JlYXRlJywgJ3JlbGVhc2VfdXBsb2FkJywgJ3JlcG9fY2xvbmUnXTtcclxuICAgIGlwY01haW4uaGFuZGxlKCdmb3JnZTphY3Rpb24nLCAoZXZlbnQsIGs6IHVua25vd24sIGg6IHVua25vd24sIGFyZ3M6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3Qga2luZCA9IEFDVElPTl9LSU5EUy5maW5kKCh4KSA9PiB4ID09PSBrKTtcclxuICAgICAgY29uc3QgYSA9IHJlcG9BcmdzKGgsIChhcmdzIGFzIHsgcmVwbz86IHVua25vd24gfSB8IG51bGwgfCB1bmRlZmluZWQpPy5yZXBvKTtcclxuICAgICAgaWYgKGtpbmQgPT09IHVuZGVmaW5lZCB8fCAnYmFkJyBpbiBhKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgb2s6IGZhbHNlLCBjb2RlOiAnQkFEX1JFUVVFU1QnLCBlcnJvcjogJ2tpbmQvaG9zdC9yZXBvIFx1NjgyMVx1OUE4Q1x1NTkzMVx1OEQyNScgfSk7XHJcbiAgICAgIGNvbnN0IHJhdyA9IChhcmdzID8/IHt9KSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcclxuICAgICAgLy8gXHU5MDEwXHU1QjU3XHU2QkI1XHU4RkM3XHU3QzdCXHU1NzhCICsgXHU5NTdGXHU1RUE2XHU5NUU4O1x1NkRGMVx1NUVBNlx1OEJFRFx1NEU0OVx1NjgyMVx1OUE4Q1x1NTcyOCBmb3JnZS50cyBidWlsZEFjdGlvbkFyZ3MoXHU2MkZDXHU1NDdEXHU0RUU0XHU1MjREXHU2NzAwXHU1NDBFXHU5NjMyXHU3RUJGKVxyXG4gICAgICBjb25zdCBwYXMgPSAodjogdW5rbm93biwgbWF4OiBudW1iZXIpOiBzdHJpbmcgPT4gKHR5cGVvZiB2ID09PSAnc3RyaW5nJyA/IHYuc2xpY2UoMCwgbWF4KSA6ICcnKTtcclxuICAgICAgY29uc3QgZmEgPSB7XHJcbiAgICAgICAgcmVwbzogYS5yZXBvLFxyXG4gICAgICAgIG51bWJlcjogcGFzKHJhdy5udW1iZXIsIDIwKSwgdGl0bGU6IHBhcyhyYXcudGl0bGUsIDMwMCksIGJvZHk6IHBhcyhyYXcuYm9keSwgMjBfMDAwKSxcclxuICAgICAgICBiYXNlOiBwYXMocmF3LmJhc2UsIDIwMCksIGhlYWQ6IHBhcyhyYXcuaGVhZCwgMjAwKSwgdGFnOiBwYXMocmF3LnRhZywgMTIwKSxcclxuICAgICAgICBuYW1lOiBwYXMocmF3Lm5hbWUsIDMwMCksIG5vdGVzOiBwYXMocmF3Lm5vdGVzLCA2MF8wMDApLCBmaWxlOiBwYXMocmF3LmZpbGUsIDFfMDAwKSxcclxuICAgICAgICBkaXI6IHBhcyhyYXcuZGlyLCAxXzAwMCksIG1ldGhvZDogcGFzKHJhdy5tZXRob2QsIDEwKSxcclxuICAgICAgICBwcmVyZWxlYXNlOiByYXcucHJlcmVsZWFzZSA9PT0gdHJ1ZSxcclxuICAgICAgfTtcclxuICAgICAgcmV0dXJuIGZvcmdlRXJyKGV2ZW50LCAoKSA9PiBmb3JnZVN2YygpLmFjdGlvbihraW5kLCBhLmhvc3QsIGZhKSk7XHJcbiAgICB9KTtcclxuICAgIC8vIFx1OTAwM1x1NzUxRlx1NTNFMzpcdTRFQzVcdTUzQ0NcdTVFNzNcdTUzRjBcdTU3REZcdTU0MERcdTUzRUZcdTU5MTZcdTVGMDAocmVuZGVyZXIgXHU3OTgxIHdpbmRvdy5vcGVuO1VJVkVSSUZZIFx1NTNFQVx1NTZERSBvaylcclxuICAgIGlwY01haW4uaGFuZGxlKCdmb3JnZTpvcGVuJywgKGV2ZW50LCB1cmw6IHVua25vd24pID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgY29uc3QgdSA9IHR5cGVvZiB1cmwgPT09ICdzdHJpbmcnID8gdXJsLnNsaWNlKDAsIDJfMDAwKSA6ICcnO1xyXG4gICAgICBpZiAoIS9eaHR0cHM6XFwvXFwvKFthLXowLTktXStcXC4pKihnaXRodWJcXC5jb218YXRvbWdpdFxcLmNvbSlcXC8vLnRlc3QodSkpIHtcclxuICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIGNvZGU6ICdCQURfUkVRVUVTVCcsIGVycm9yOiAnXHU0RUM1IGdpdGh1Yi5jb20gLyBhdG9tZ2l0LmNvbSBcdTk0RkVcdTYzQTVcdTUzRUZcdTYyNTNcdTVGMDAnIH07XHJcbiAgICAgIH1cclxuICAgICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZID09PSAnMScgJiYgIWZvcmdlRml4dHVyZU9mZikgcmV0dXJuIHsgb2s6IHRydWUgfTtcclxuICAgICAgdm9pZCBzaGVsbC5vcGVuRXh0ZXJuYWwodSk7XHJcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlIH07XHJcbiAgICB9KTtcclxuICAgIGlwY01haW4uaGFuZGxlKCdmb3JnZTpyZXNvbHZlJywgKGV2ZW50LCBwOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWSA9PT0gJzEnICYmICFmb3JnZUZpeHR1cmVPZmYpIHJldHVybiBmb3JnZUZpeHR1cmVzKCkucmVzb2x2ZTtcclxuICAgICAgY29uc3QgcGF0aCA9IHR5cGVvZiBwID09PSAnc3RyaW5nJyA/IHAuc2xpY2UoMCwgMV8wMDApIDogJyc7XHJcbiAgICAgIHJldHVybiBmb3JnZVN2YygpLnJlc29sdmUocGF0aCk7XHJcbiAgICB9KTtcclxuICB9XHJcblxyXG4gIC8qIC0tLS0gXHU3QTk3XHU1M0UzXHU0RTBFXHU1Qjg5XHU1MTY4XHU3QjU2XHU3NTY1IC0tLS0gKi9cclxuICAvLyAwMyBcdTAwQTdcdTRFMDM6RGVza3RvcCBcdTY3MkNcdTU3MzBcdTUzRUFcdTVCNTggVUkgXHU1MDRGXHU1OTdEL1x1N0E5N1x1NTNFM1x1NzJCNlx1NjAwMSh1c2VyRGF0YS93aW5kb3ctc3RhdGUuanNvbilcclxuICBjb25zdCB3aW5kb3dTdGF0ZUZpbGUgPSAoKTogc3RyaW5nID0+IGpvaW4oYXBwLmdldFBhdGgoJ3VzZXJEYXRhJyksICd3aW5kb3ctc3RhdGUuanNvbicpO1xyXG4gIGFzeW5jIGZ1bmN0aW9uIGxvYWRCb3VuZHMoKTogUHJvbWlzZTx7IHdpZHRoOiBudW1iZXI7IGhlaWdodDogbnVtYmVyOyB4PzogbnVtYmVyOyB5PzogbnVtYmVyIH0gfCBudWxsPiB7XHJcbiAgICB0cnkge1xyXG4gICAgICByZXR1cm4gSlNPTi5wYXJzZShhd2FpdCByZWFkRmlsZSh3aW5kb3dTdGF0ZUZpbGUoKSwgJ3V0ZjgnKSkgYXMgeyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlcjsgeD86IG51bWJlcjsgeT86IG51bWJlciB9O1xyXG4gICAgfSBjYXRjaCB7IHJldHVybiBudWxsOyB9XHJcbiAgfVxyXG4gIGFzeW5jIGZ1bmN0aW9uIHNhdmVCb3VuZHMod2luOiBCcm93c2VyV2luZG93KTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICB0cnkgeyBhd2FpdCB3cml0ZUZpbGUod2luZG93U3RhdGVGaWxlKCksIEpTT04uc3RyaW5naWZ5KHdpbi5nZXRCb3VuZHMoKSksICd1dGY4Jyk7IH0gY2F0Y2ggeyAvKiBiZXN0IGVmZm9ydCAqLyB9XHJcbiAgfVxyXG5cclxuICBhc3luYyBmdW5jdGlvbiBjcmVhdGVXaW5kb3coKTogUHJvbWlzZTxCcm93c2VyV2luZG93IHwgbnVsbD4ge1xyXG4gICAgY29uc3Qgc2F2ZWQgPSBhd2FpdCBsb2FkQm91bmRzKCk7XHJcbiAgICBjb25zdCB3aW4gPSBuZXcgQnJvd3NlcldpbmRvdyh7XHJcbiAgICAgIHdpZHRoOiBzYXZlZD8ud2lkdGggPz8gMTQ0MCxcclxuICAgICAgaGVpZ2h0OiBzYXZlZD8uaGVpZ2h0ID8/IDkwMCxcclxuICAgICAgLi4uKHNhdmVkPy54ICE9PSB1bmRlZmluZWQgJiYgc2F2ZWQ/LnkgIT09IHVuZGVmaW5lZCA/IHsgeDogc2F2ZWQueCwgeTogc2F2ZWQueSB9IDoge30pLFxyXG4gICAgICAvLyBISUcgXHU5NjM2XHU2QkI1MigxMS1BKTpcdTdBODRcdTdBOTdcdTRFMEJcdTk2NTAgNTYwKDA0IFx1NTNGN1x1ODlDNFx1NjgzQztcdTUzOUYgOTYwIFx1NEY3RiBcdTIyNjQ4MjBweCBcdTYyQkRcdTVDNDlcdTY1QURcdTcwQjlcdTRFMERcdTUzRUZcdThGQkUpO1xyXG4gICAgICAvLyBVSVZFUklGWSBcdTdBODRcdTVDNEZcdTlBOENcdTY1MzYoMTEtQix3aXphcmQgMzYwXHUwMEQ3NjQwIFx1NTE2OFx1NTE0M1x1N0QyMFx1NTNFRlx1OEZCRSlcdTk3MDBcdTRFMzRcdTY1RjZcdTY1M0VcdTVCQkRcdTUyMzAgMzIwXHUwMEQ3MzYwXHUzMDAyXHJcbiAgICAgIG1pbldpZHRoOiBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWSA9PT0gJzEnID8gMzIwIDogNTYwLFxyXG4gICAgICBtaW5IZWlnaHQ6IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZID09PSAnMScgPyAzNjAgOiA2MDAsXHJcbiAgICAgIHNob3c6IGZhbHNlLFxyXG4gICAgICBiYWNrZ3JvdW5kQ29sb3I6ICcjZjlmYWZiJywgLy8gdjQgRFNIOlx1NkQ0NVx1ODI3Mlx1OUVEOFx1OEJBNChiZy1iYXNlKSxcdTkwN0ZcdTUxNERcdTZERjFcdTgyNzJcdTk1RUFcdTVDNEZcclxuICAgICAgdGl0bGU6ICdITUggRGVza3RvcCcsXHJcbiAgICAgIC8vIFx1OTY5MFx1ODVDRlx1NUYwRlx1NjgwN1x1OTg5OFx1NjgwRjpcdTUzOUZcdTc1MUZcdTdBOTdcdTUzRTNcdTYzQTdcdTUyMzYob3ZlcmxheSBcdTYzRDBcdTRGOUIpK1x1OTg5Q1x1ODI3Mlx1OTY4Rlx1NEUzQlx1OTg5OChyZW5kZXJlciBcdTdFQ0ZcclxuICAgICAgLy8gY2hyb21lLXRoZW1lIFx1NTQwQ1x1NkI2NSlcdTIwMTRcdTIwMTRcdTY4MzlcdTZDQkJcdTRFQUVcdTgyNzJcdTZBMjFcdTVGMEZcdTk4NzZcdTkwRThcdTlFRDFcdTY3NjE7XHU4M0RDXHU1MzU1XHU2ODBGIGF1dG9IaWRlKEFsdCBcdTU0N0NcdTUxRkEpXHUzMDAyXHJcbiAgICAgIHRpdGxlQmFyU3R5bGU6ICdoaWRkZW4nLFxyXG4gICAgICAvLyBISUcgXHU5NjM2XHU2QkI1MjozNlx1MjE5MjQ0LFx1NEUwRSByZW5kZXJlciAudGl0bGViYXIgXHU5QUQ4XHU1RUE2XHU0RTAwXHU4MUY0KFx1NEUwRFx1NEUwMFx1ODFGNFx1NEYxQVx1OTczMlx1NTFGQS9cdTkwNkVcdTRGNEYgOHB4KVxyXG4gICAgICB0aXRsZUJhck92ZXJsYXk6IHsgLi4uY2hyb21lRm9yKG5hdGl2ZVRoZW1lLnNob3VsZFVzZURhcmtDb2xvcnMpLCBoZWlnaHQ6IDQ0IH0sXHJcbiAgICAgIGF1dG9IaWRlTWVudUJhcjogdHJ1ZSxcclxuICAgICAgd2ViUHJlZmVyZW5jZXM6IHtcclxuICAgICAgICBwcmVsb2FkOiBwcmVsb2FkUGF0aCxcclxuICAgICAgICBjb250ZXh0SXNvbGF0aW9uOiB0cnVlLFxyXG4gICAgICAgIHNhbmRib3g6IHRydWUsXHJcbiAgICAgICAgbm9kZUludGVncmF0aW9uOiBmYWxzZSxcclxuICAgICAgICBub2RlSW50ZWdyYXRpb25JbldvcmtlcjogZmFsc2UsXHJcbiAgICAgICAgd2ViU2VjdXJpdHk6IHRydWUsXHJcbiAgICAgICAgc3BlbGxjaGVjazogZmFsc2UsXHJcbiAgICAgICAgZGV2VG9vbHM6IGlzRGV2LFxyXG4gICAgICB9LFxyXG4gICAgfSk7XHJcbiAgICB3aW4ub25jZSgncmVhZHktdG8tc2hvdycsICgpID0+IHdpbi5zaG93KCkpO1xyXG4gICAgd2luLm9uKCdjbG9zZScsICgpID0+IHsgdm9pZCBzYXZlQm91bmRzKHdpbik7IH0pO1xyXG5cclxuICAgIC8vIFx1NTNFQVx1NTE0MVx1OEJCOFx1NTJBMFx1OEY3RFx1NjIxMVx1NEVFQ1x1ODFFQVx1NURGMVx1NzY4NCByZW5kZXJlcjtcdTRFRkJcdTRGNTVcdTVCRkNcdTgyMkEvXHU2NUIwXHU3QTk3XHU1M0UzXHU0RTAwXHU1RjhCXHU2MkQyXHU3RUREXHJcbiAgICB3aW4ud2ViQ29udGVudHMuc2V0V2luZG93T3BlbkhhbmRsZXIoKHsgdXJsIH0pID0+IHtcclxuICAgICAgaWYgKC9eaHR0cHM/OlxcL1xcLy8udGVzdCh1cmwpKSB2b2lkIHNoZWxsLm9wZW5FeHRlcm5hbCh1cmwpO1xyXG4gICAgICByZXR1cm4geyBhY3Rpb246ICdkZW55JyB9O1xyXG4gICAgfSk7XHJcbiAgICB3aW4ud2ViQ29udGVudHMub24oJ3dpbGwtbmF2aWdhdGUnLCAoZSwgdXJsKSA9PiB7XHJcbiAgICAgIGNvbnN0IG9rID0gWy4uLmFsbG93ZWRPcmlnaW5zXS5zb21lKChvKSA9PiB1cmwgPT09IG8gfHwgdXJsLnN0YXJ0c1dpdGgoYCR7b30vYCkgfHwgdXJsLnN0YXJ0c1dpdGgoYCR7b30/YCkpO1xyXG4gICAgICBpZiAoIW9rKSB7XHJcbiAgICAgICAgbG9nSW5mbygnbmF2JywgYGJsb2NrZWQgbmF2aWdhdGlvbiB0byAke3VybC5zbGljZSgwLCAxMjApfWApO1xyXG4gICAgICAgIGUucHJldmVudERlZmF1bHQoKTtcclxuICAgICAgfVxyXG4gICAgfSk7XHJcblxyXG4gICAgaWYgKGlzRGV2ICYmIHJlbmRlcmVyRGV2VXJsKSB7XHJcbiAgICAgIHZvaWQgd2luLmxvYWRVUkwocmVuZGVyZXJEZXZVcmwpO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgdm9pZCB3aW4ubG9hZEZpbGUoam9pbihoZXJlLCAnLi4nLCAnLi4nLCAnZGlzdC1yZW5kZXJlcicsICdpbmRleC5odG1sJykpO1xyXG4gICAgfVxyXG4gICAgLy8gXHU5ODc1XHU5NzYyXHU1MkEwXHU4RjdEXHU1QjhDXHU5MUNEXHU2NEFEXHU1RjUzXHU1MjREIGhvc3QgXHU3MkI2XHU2MDAxOnJlYWR5IFx1NUU3Rlx1NjRBRFx1ODJFNVx1NjVFOVx1NEU4RSByZW5kZXJlciBcdThCQTJcdTk2MDVcdTUzNzNcdTRFMjJcdTU5MzEsXHJcbiAgICAvLyByZW5kZXJlciBcdTc2ODQgZ2V0LXN0YXRlIFx1NUZFQlx1NzE2NyArIFx1OEZEOVx1OTFDQ1x1NzY4NFx1OTFDRFx1NjRBRFx1NTNDQ1x1NEZERFx1OTY2OShcdTU5MUFcdTdBOTdcdTUzRTMvXHU5MUNEXHU4RjdEXHU1NzNBXHU2NjZGXHU0RTVGXHU4OTg2XHU3NkQ2KVx1MzAwMlxyXG4gICAgd2luLndlYkNvbnRlbnRzLm9uY2UoJ2RpZC1maW5pc2gtbG9hZCcsICgpID0+IHtcclxuICAgICAgaWYgKCF3aW4uaXNEZXN0cm95ZWQoKSkge1xyXG4gICAgICAgIHdpbi53ZWJDb250ZW50cy5zZW5kKCdicmlkZ2U6aG9zdC1zdGF0ZScsIGJyaWRnZS5ob3N0U3RhdGUsIHsgcmVzdGFydENvdW50OiAwIH0pO1xyXG4gICAgICB9XHJcbiAgICB9KTtcclxuICAgIHJldHVybiB3aW47XHJcbiAgfVxyXG5cclxuICBhcHAud2hlblJlYWR5KCkudGhlbigoKSA9PiB7XHJcbiAgICAvLyBVSVZFUklGWTpmYWtlIFx1NkEyMVx1NUYwRlx1OUE4Q1x1NjUzNlx1OTg3Qlx1NTcyOCBzdGFydEhvc3QgXHU4QkZCIGVudiBcdTRFNEJcdTUyNERcdTVGM0FcdTUyMzYgZmFrZTtWSVNSRUcoXHU4OUM2XHU4OUM5XHU1NkRFXHU1RjUyKVx1NTQwQ1x1ODlDNFx1NTIxOVxyXG4gICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1ZJU1JFRyA9PT0gJzEnIHx8IChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWSA9PT0gJzEnICYmIHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX01PREUgIT09ICdyZWFsJykpIHtcclxuICAgICAgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfRkFLRSA9ICcxJztcclxuICAgIH1cclxuICAgIC8vIFdpbmRvd3MgXHU5MDFBXHU3N0U1XHU1RjUyXHU1QzVFKFx1NTQyNlx1NTIxOVx1NjYzRVx1NzkzQVx1NEUzQSBlbGVjdHJvbi5leGUpXHJcbiAgICBhcHAuc2V0QXBwVXNlck1vZGVsSWQoJ2Rldi5obWguZGVza3RvcCcpO1xyXG4gICAgc2V0dXBUcmF5KCk7XHJcbiAgICBidWlsZEFwcE1lbnUoKTtcclxuICAgIC8vIFx1NTQyRlx1NTJBOCAzMHMgXHU1NDBFXHU5NzU5XHU5RUQ4XHU2OEMwXHU2N0U1XHU2NkY0XHU2NUIwKFx1NjcwOVx1NjVCMFx1NzI0OFx1NEVDNVx1NTQwRVx1NTNGMFx1NEUwQlx1OEY3RCxcdTRFMERcdTYyNTNcdTYyNzA7XHU1OTMxXHU4RDI1XHU5NzU5XHU5RUQ4LFx1NEUwQlx1NkIyMVx1NTQyRlx1NTJBOFx1NTE4RFx1OEJENSlcdTMwMDJcclxuICAgIC8vIGRldiBcdTRFNUZcdTY4QzBcdTY3RTU6XHU4ODRDXHU0RTNBXHU0RTBFXHU2MjUzXHU1MzA1XHU3MjQ4XHU0RTAwXHU4MUY0LFx1NEUxNCBGT1JDRV9UQUcgXHU2NUNCXHU5NEFFXHU0RTBCIGRldiBcdTUzNzNcdTUzRUZcdTUxNjhcdTZENDFcdTdBMEJcdTlBOENcdTY1MzZcdTMwMDJcclxuICAgIHNldFRpbWVvdXQoKCkgPT4geyB2b2lkIGNoZWNrRm9yVXBkYXRlcygpOyB9LCAzMF8wMDApO1xyXG4gICAgLy8gQ1NQKGRldiBcdTRFMEUgcHJvZCBcdTRFMERcdTU0MEM7cHJvZCBcdTRFMERcdTUxNDFcdThCQjhcdTRFRkJcdTRGNTVcdThGRENcdTdBMEJcdTZFOTApXHJcbiAgICBjb25zdCBjc3AgPSBpc0RldlxyXG4gICAgICA/IFtcclxuICAgICAgICAgIFwiZGVmYXVsdC1zcmMgJ3NlbGYnXCIsXHJcbiAgICAgICAgICBgc2NyaXB0LXNyYyAnc2VsZicgJHtyZW5kZXJlckRldlVybH1gLFxyXG4gICAgICAgICAgXCJzdHlsZS1zcmMgJ3NlbGYnICd1bnNhZmUtaW5saW5lJ1wiLFxyXG4gICAgICAgICAgYGNvbm5lY3Qtc3JjICdzZWxmJyAke3JlbmRlcmVyRGV2VXJsfSB3czovLzEyNy4wLjAuMToqYCxcclxuICAgICAgICAgIFwiaW1nLXNyYyAnc2VsZicgZGF0YTpcIixcclxuICAgICAgICAgIFwiZm9udC1zcmMgJ3NlbGYnIGRhdGE6XCIsXHJcbiAgICAgICAgXS5qb2luKCc7ICcpXHJcbiAgICAgIDogXCJkZWZhdWx0LXNyYyAnc2VsZic7IHNjcmlwdC1zcmMgJ3NlbGYnOyBzdHlsZS1zcmMgJ3NlbGYnICd1bnNhZmUtaW5saW5lJzsgaW1nLXNyYyAnc2VsZicgZGF0YTo7IGZvbnQtc3JjICdzZWxmJyBkYXRhOlwiO1xyXG4gICAgc2Vzc2lvbi5kZWZhdWx0U2Vzc2lvbi53ZWJSZXF1ZXN0Lm9uSGVhZGVyc1JlY2VpdmVkKChkZXRhaWxzLCBjYWxsYmFjaykgPT4ge1xyXG4gICAgICBjYWxsYmFjayh7XHJcbiAgICAgICAgcmVzcG9uc2VIZWFkZXJzOiB7XHJcbiAgICAgICAgICAuLi5kZXRhaWxzLnJlc3BvbnNlSGVhZGVycyxcclxuICAgICAgICAgICdDb250ZW50LVNlY3VyaXR5LVBvbGljeSc6IFtjc3BdLFxyXG4gICAgICAgIH0sXHJcbiAgICAgIH0pO1xyXG4gICAgfSk7XHJcblxyXG4gICAgcmVnaXN0ZXJJcGMoKTtcclxuICAgIC8vIGNyZWF0ZVdpbmRvdyBcdTY2MkYgYXN5bmMoYm91bmRzIFx1NjA2Mlx1NTkwRCk7XHU1Qjg5XHU1MTY4XHU4MUVBXHU2RDRCL1x1NkUzMlx1NjdEM1x1ODFFQVx1NjhDMFx1NTcyOFx1N0E5N1x1NTNFM1x1NUMzMVx1N0VFQVx1NTQwRVx1NjMwMlx1OEY3RFxyXG4gICAgdm9pZCBjcmVhdGVXaW5kb3coKS50aGVuKCh3aW4pID0+IHtcclxuICAgICAgaWYgKHdpbiA9PT0gbnVsbCkgcmV0dXJuO1xyXG4gICAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRlkgPT09ICcxJykgYXR0YWNoVWlWZXJpZnkod2luKTtcclxuICAgICAgLy8gXHU4OUM2XHU4OUM5XHU1NkRFXHU1RjUyXHU2MjJBXHU1NkZFXHU5NEE5XHU1QjUwOkhNSF9ERVNLVE9QX1ZJU1JFRz0xLFx1Nzg2RVx1NUI5QVx1NjAyN1x1ODlDNlx1NTNFM1x1NjIyQVx1NTZGRVx1NTQwRVx1OTAwMFx1NTFGQShzY3JpcHRzL3Zpc3VhbC1yZWdyZXNzaW9uLm1qcyBcdTlBNzFcdTUyQTgpXHJcbiAgICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9WSVNSRUcgPT09ICcxJykgYXR0YWNoVmlzdWFsUmVncmVzc2lvbih3aW4pO1xyXG4gICAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfU0VDVVJJVFlfVEVTVCA9PT0gJzEnKSB7XHJcbiAgICAgICAgd2luLndlYkNvbnRlbnRzLm9uY2UoJ2RpZC1maW5pc2gtbG9hZCcsICgpID0+IHtcclxuICAgICAgICAgIHZvaWQgc2VjdXJpdHlTZWxmVGVzdCh3aW4pO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICB9XHJcbiAgICAgIC8vIFVJIFx1NjIyQVx1NTZGRVx1OTRBOVx1NUI1MDpITUhfREVTS1RPUF9TTkFQU0hPVD08ZmlsZS5wbmc+IFx1NTcyOFx1NzU0Q1x1OTc2Mlx1NUMzMVx1N0VFQVx1NTQwRVx1NjIyQVx1NTZGRVx1OTAwMFx1NTFGQVxyXG4gICAgICAvLyAoXHU4OEM1XHU2NzNBXHU4QkNBXHU2NUFEXHU3NTI4Olx1NEVCMlx1NzczQ1x1NzcwQlx1NkUzMlx1NjdEM1x1N0VEM1x1Njc5QyxcdTgwMENcdTRFMERcdTY2MkZcdTUzRUFcdTY1NzAgcm9vdCBcdTVCNTBcdTgyODJcdTcwQjkpXHUzMDAyXHJcbiAgICAgIGNvbnN0IHNuYXAgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9TTkFQU0hPVDtcclxuICAgICAgaWYgKHNuYXAgIT09IHVuZGVmaW5lZCAmJiBzbmFwICE9PSAnJykge1xyXG4gICAgICAgIHdpbi53ZWJDb250ZW50cy5vbmNlKCdkaWQtZmluaXNoLWxvYWQnLCAoKSA9PiB7XHJcbiAgICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHtcclxuICAgICAgICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBpbWcgPSBhd2FpdCB3aW4ud2ViQ29udGVudHMuY2FwdHVyZVBhZ2UoKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHsgd3JpdGVGaWxlOiB3ZiB9ID0gYXdhaXQgaW1wb3J0KCdub2RlOmZzL3Byb21pc2VzJyk7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCB3ZihzbmFwLCBpbWcudG9QTkcoKSk7XHJcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgU05BUFNIT1Qgb2sgJHtzbmFwfSAke2ltZy5nZXRTaXplKCkud2lkdGh9eCR7aW1nLmdldFNpemUoKS5oZWlnaHR9YCk7XHJcbiAgICAgICAgICAgICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgU05BUFNIT1QgZXJyb3IgJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApfWApO1xyXG4gICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICBjb25zdCBhcHAyID0gYXBwO1xyXG4gICAgICAgICAgICAgIHNldFRpbWVvdXQoKCkgPT4gYXBwMi5leGl0KDApLCA1MDApO1xyXG4gICAgICAgICAgICB9KSgpO1xyXG4gICAgICAgICAgfSwgTnVtYmVyKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NOQVBTSE9UX0RFTEFZX01TID8/IDEyXzAwMCkpO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICB9XHJcbiAgICAgIC8vIERPTSBcdTdFRDNcdTY3ODRcdTYzQTJcdTk0ODg6SE1IX0RFU0tUT1BfRE9NUFJPQkU9MSBcdThGOTNcdTUxRkFcdTUxNzNcdTk1MkVcdTUxNDNcdTdEMjBcdTc2ODQgYm94L2Rpc3BsYXkvY2hpbGRyZW4sXHJcbiAgICAgIC8vIFx1NTE4RFx1OTAwMFx1NTFGQShcdThCQ0FcdTY1QURcIlJlYWN0IFx1NjMwMlx1OEY3RFx1NEU4Nlx1NEY0Nlx1NjdEMFx1NTc1NyBVSSBcdTRFMERcdTUzRUZcdTg5QzFcIlx1OEZEOVx1N0M3Qlx1OTVFRVx1OTg5ODtcdTYyMkFcdTU2RkVcdTRFNEJcdTU5MTZcdTc2ODRcdTc4NkNcdThCQzFcdTYzNkUpXHUzMDAyXHJcbiAgICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9ET01QUk9CRSA9PT0gJzEnKSB7XHJcbiAgICAgICAgd2luLndlYkNvbnRlbnRzLm9uY2UoJ2RpZC1maW5pc2gtbG9hZCcsICgpID0+IHtcclxuICAgICAgICAgIHNldFRpbWVvdXQoKCkgPT4ge1xyXG4gICAgICAgICAgICB2b2lkIChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHIgPSAoYXdhaXQgd2luLndlYkNvbnRlbnRzLmV4ZWN1dGVKYXZhU2NyaXB0KGAoZnVuY3Rpb24oKXtcclxuICAgICAgICAgICAgICAgICAgdmFyIHBpY2sgPSBmdW5jdGlvbihzZWwpe1xyXG4gICAgICAgICAgICAgICAgICAgIHZhciBlbHMgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKHNlbCk7XHJcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGVscywgMCwgNCkubWFwKGZ1bmN0aW9uKGVsKXtcclxuICAgICAgICAgICAgICAgICAgICAgIHZhciBjcyA9IGdldENvbXB1dGVkU3R5bGUoZWwpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgdmFyIGIgPSBlbC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcclxuICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB7IGNsczogKGVsLmNsYXNzTmFtZXx8JycpLnRvU3RyaW5nKCkuc2xpY2UoMCw4MCksIHRhZzogZWwudGFnTmFtZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgZGlzcGxheTogY3MuZGlzcGxheSwgdmlzOiBjcy52aXNpYmlsaXR5LCBvcGFjaXR5OiBjcy5vcGFjaXR5LFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBwb3M6IGNzLnBvc2l0aW9uLCB6OiBjcy56SW5kZXgsIG92ZXJmbG93OiBjcy5vdmVyZmxvdyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgeDogTWF0aC5yb3VuZChiLngpLCB5OiBNYXRoLnJvdW5kKGIueSksIHc6IE1hdGgucm91bmQoYi53aWR0aCksIGg6IE1hdGgucm91bmQoYi5oZWlnaHQpLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB0ZXh0OiAoZWwuaW5uZXJUZXh0fHwnJykucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDYwKSB9O1xyXG4gICAgICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgICB9O1xyXG4gICAgICAgICAgICAgICAgICB2YXIgc2VscyA9IFsnaHRtbCcsJ2JvZHknLCcjcm9vdCcsJy5hcHAtc2hlbGwnLCcuc2lkZWJhcicsJy53b3Jrc3BhY2UnLCcudG9wYmFyJywnLnN0cmVhbScsJy5lbXB0eS1oaW50JywnLmNvbXBvc2VyJywnLmNvbXBvc2VyLXJvdycsJy5jb21wb3NlciB0ZXh0YXJlYScsJy5jb21wb3Nlci1zaWRlJywnLmF0dC1waWNrZXInLCcuYXR0LWNoaXBzJywnLnNpZGVwYW5lbCcsJy5ydW50aW1lLWd1aWRlJywnLm92ZXJsYXknLCcudHVybicsJy5jYXJkJ107XHJcbiAgICAgICAgICAgICAgICAgIHZhciBvdXQgPSB7fTtcclxuICAgICAgICAgICAgICAgICAgc2Vscy5mb3JFYWNoKGZ1bmN0aW9uKHMpeyB0cnkgeyBvdXRbc10gPSBwaWNrKHMpOyB9IGNhdGNoKGUpeyBvdXRbc10gPSBbe2VycjogU3RyaW5nKGUpLnNsaWNlKDAsODApfV07IH0gfSk7XHJcbiAgICAgICAgICAgICAgICAgIG91dC5fX21ldGEgPSB7XHJcbiAgICAgICAgICAgICAgICAgICAgc3R5bGVTaGVldHM6IGRvY3VtZW50LnN0eWxlU2hlZXRzLmxlbmd0aCxcclxuICAgICAgICAgICAgICAgICAgICBzaGVldDBydWxlczogKGRvY3VtZW50LnN0eWxlU2hlZXRzWzBdICYmIGRvY3VtZW50LnN0eWxlU2hlZXRzWzBdLmNzc1J1bGVzKSA/IGRvY3VtZW50LnN0eWxlU2hlZXRzWzBdLmNzc1J1bGVzLmxlbmd0aCA6IC0xLFxyXG4gICAgICAgICAgICAgICAgICAgIHJvb3RDaGlsZHJlbjogZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Jvb3QnKSA/IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyb290JykuY2hpbGRyZW4ubGVuZ3RoIDogLTEsXHJcbiAgICAgICAgICAgICAgICAgICAgYm9keUNoaWxkcmVuOiBkb2N1bWVudC5ib2R5LmNoaWxkcmVuLmxlbmd0aCxcclxuICAgICAgICAgICAgICAgICAgICBpbm5lckhUTUxMZW46IGRvY3VtZW50LmJvZHkuaW5uZXJIVE1MLmxlbmd0aCxcclxuICAgICAgICAgICAgICAgICAgICB2aWV3cG9ydDogd2luZG93LmlubmVyV2lkdGggKyAneCcgKyB3aW5kb3cuaW5uZXJIZWlnaHRcclxuICAgICAgICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KG91dCk7XHJcbiAgICAgICAgICAgICAgICB9KSgpYCwgdHJ1ZSkpIGFzIHN0cmluZztcclxuICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBET01QUk9CRSAke3J9YCk7XHJcbiAgICAgICAgICAgICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgRE9NUFJPQkUgZXJyb3IgJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAyMDApfWApO1xyXG4gICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICBhcHAuZXhpdCgwKTtcclxuICAgICAgICAgICAgfSkoKTtcclxuICAgICAgICAgIH0sIE51bWJlcihwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9ET01QUk9CRV9ERUxBWV9NUyA/PyA5XzAwMCkpO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICB9XHJcbiAgICAgIC8vIFx1NkUzMlx1NjdEM1x1ODFFQVx1NjhDMCgyMDI2LTEwLTEwIFx1ODhDNVx1NjczQVx1OUVEMVx1NUM0Rlx1NjU1OVx1OEJBRDpicmlkZ2UgcmVhZHkgXHUyMjYwIFx1NzU0Q1x1OTc2Mlx1NkUzMlx1NjdEM1x1NEU4NilcdTMwMDJcclxuICAgICAgLy8gI3Jvb3QgXHU1NzI4IFJlYWN0IFx1NjMwMlx1OEY3RFx1NTQwRVx1NUZDNVx1NjcwOVx1NUI1MFx1ODI4Mlx1NzBCOTtcdTdBN0EgPSBcdThENDRcdTZFOTBcdThERUZcdTVGODQvQ1NQL1x1ODExQVx1NjcyQ1x1NTJBMFx1OEY3RFx1NTc0Rlx1NEU4Nlx1MzAwMlxyXG4gICAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfUkVOREVSX1RFU1QgPT09ICcxJykge1xyXG4gICAgICAgIHdpbi53ZWJDb250ZW50cy5vbmNlKCdkaWQtZmluaXNoLWxvYWQnLCAoKSA9PiB7XHJcbiAgICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHtcclxuICAgICAgICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBuID0gKGF3YWl0IHdpbi53ZWJDb250ZW50cy5leGVjdXRlSmF2YVNjcmlwdChcclxuICAgICAgICAgICAgICAgICAgJ2RvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwicm9vdFwiKSA/IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwicm9vdFwiKS5jaGlsZHJlbi5sZW5ndGggOiAtMScsIHRydWUsXHJcbiAgICAgICAgICAgICAgICApKSBhcyBudW1iZXI7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBvayA9IG4gPiAwO1xyXG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYFJFTkRFUi1URVNUICR7b2sgPyAnb2snIDogJ0VNUFRZJ30gcm9vdENoaWxkcmVuPSR7bn1gKTtcclxuICAgICAgICAgICAgICAgIGFwcC5leGl0KG9rID8gMCA6IDEpO1xyXG4gICAgICAgICAgICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYFJFTkRFUi1URVNUIEVSUk9SICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTIwKX1gKTtcclxuICAgICAgICAgICAgICAgIGFwcC5leGl0KDEpO1xyXG4gICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfSkoKTtcclxuICAgICAgICAgIH0sIDJfNTAwKTtcclxuICAgICAgICB9KTtcclxuICAgICAgfVxyXG4gICAgfSk7XHJcbiAgICB2b2lkIHN0YXJ0SG9zdCgpO1xyXG5cclxuICAgIGFwcC5vbignYWN0aXZhdGUnLCAoKSA9PiB7XHJcbiAgICAgIGlmIChCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5sZW5ndGggPT09IDApIHZvaWQgY3JlYXRlV2luZG93KCk7XHJcbiAgICB9KTtcclxuICB9KTtcclxuXHJcbiAgYXN5bmMgZnVuY3Rpb24gc2VjdXJpdHlTZWxmVGVzdCh3aW46IEJyb3dzZXJXaW5kb3cpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IHJlc3VsdHM6IEFycmF5PFtzdHJpbmcsIGJvb2xlYW4sIHN0cmluZ10+ID0gW107XHJcbiAgICBjb25zdCBjaGVjayA9IGFzeW5jIChuYW1lOiBzdHJpbmcsIHByb2JlOiAoKSA9PiBQcm9taXNlPFtib29sZWFuLCBzdHJpbmddPik6IFByb21pc2U8dm9pZD4gPT4ge1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IFtvaywgZGV0YWlsXSA9IGF3YWl0IHByb2JlKCk7XHJcbiAgICAgICAgcmVzdWx0cy5wdXNoKFtuYW1lLCBvaywgZGV0YWlsXSk7XHJcbiAgICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICAgIHJlc3VsdHMucHVzaChbbmFtZSwgZmFsc2UsIFN0cmluZyhlcnIpLnNsaWNlKDAsIDEyMCldKTtcclxuICAgICAgfVxyXG4gICAgfTtcclxuICAgIGNvbnN0IGpzID0gKGNvZGU6IHN0cmluZyk6IFByb21pc2U8dW5rbm93bj4gPT4gd2luLndlYkNvbnRlbnRzLmV4ZWN1dGVKYXZhU2NyaXB0KGNvZGUsIHRydWUpO1xyXG5cclxuICAgIGF3YWl0IGNoZWNrKCdyZW5kZXJlciBcdTY1RTBcdTUzRUZcdTc1MjhcdTc2ODQgcHJvY2Vzcy9yZXF1aXJlKHNhbmRib3ggXHU3NTFGXHU2NTQ4KScsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgciA9IChhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XHJcbiAgICAgICAgdmFyIHQgPSBmdW5jdGlvbihmKXsgdHJ5IHsgdmFyIHYgPSBmKCk7IHJldHVybiAodiA9PT0gdW5kZWZpbmVkIHx8IHYgPT09IG51bGwpID8gJ3VuYXZhaWxhYmxlJyA6IHR5cGVvZiB2OyB9IGNhdGNoKGUpeyByZXR1cm4gJ2Jsb2NrZWQnOyB9IH07XHJcbiAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KFt0KGZ1bmN0aW9uKCl7cmV0dXJuIHByb2Nlc3N9KSwgdChmdW5jdGlvbigpe3JldHVybiByZXF1aXJlfSksIHQoZnVuY3Rpb24oKXtyZXR1cm4gZ2xvYmFsVGhpcy5wcm9jZXNzfSldKTtcclxuICAgICAgfSkoKWApKSBhcyBzdHJpbmc7XHJcbiAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocikgYXMgc3RyaW5nW107XHJcbiAgICAgIGNvbnN0IHAgPSBwYXJzZWRbMF0gPz8gJ3Vua25vd24nO1xyXG4gICAgICBjb25zdCByZXEgPSBwYXJzZWRbMV0gPz8gJ3Vua25vd24nO1xyXG4gICAgICBjb25zdCBzYWZlID0gKHY6IHN0cmluZyk6IGJvb2xlYW4gPT4gdiA9PT0gJ3VuYXZhaWxhYmxlJyB8fCB2ID09PSAnYmxvY2tlZCc7XHJcbiAgICAgIHJldHVybiBbc2FmZShwKSAmJiBzYWZlKHJlcSksIGBwcm9jZXNzPSR7cH0gcmVxdWlyZT0ke3JlcX1gXTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgY2hlY2soJ3dpbmRvdy5obWggXHU1M0VBXHU2NzA5XHU3NjdEXHU1NDBEXHU1MzU1XHU2NUI5XHU2Q0Q1KFx1NjVFMCBpcGNSZW5kZXJlci9cdTk4OURcdTU5MTZcdTk3NjIpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKCdPYmplY3Qua2V5cyh3aW5kb3cuaG1oIHx8IHt9KS5zb3J0KCkuam9pbihcIixcIiknKSkgYXMgc3RyaW5nO1xyXG4gICAgICBjb25zdCBhbGxvdyA9IFsnYXBwbHlVcGRhdGUnLCAnYXBwcm92ZScsICdhcHByb3ZhbEdldCcsICdhcHByb3ZhbFNldCcsICdicm93c2VSdW50aW1lJywgJ2NoZWNrVXBkYXRlJywgJ2Nocm9tZVRoZW1lJywgJ2NvZ25pdGl2ZScsICdkZXRlY3RSdW50aW1lJywgJ2RpZmYnLCAnZXhwb3J0U2Vzc2lvbicsICdmb3JnZUFjdGlvbicsICdmb3JnZUlzc3VlcycsICdmb3JnZUxvZ2luJywgJ2ZvcmdlT3BlbicsICdmb3JnZVBycycsICdmb3JnZVJlbGVhc2VzJywgJ2ZvcmdlUmVwb3MnLCAnZm9yZ2VSZXNvbHZlJywgJ2ZvcmdlU3RhdHVzJywgJ2ZzTGlzdCcsICdmc1JlYWQnLCAnZnNTZWFyY2gnLCAnZ2V0U3RhdGUnLCAnZ2V0V2l6YXJkJywgJ2luamVjdCcsICdpbnN0YWxsQ2xpJywgJ2ludGVycnVwdCcsICdtb2RlbFNldCcsICdvbkV2ZW50QmF0Y2hlcycsICdvbkZvcmdlTG9naW5PdXRwdXQnLCAnb25Ib3N0U3RhdGUnLCAnb25JbnN0YWxsUHJvZ3Jlc3MnLCAnb25NZW51QWN0aW9uJywgJ29uU3RyZWFtQ2h1bmtzJywgJ29uVXBkYXRlU3RhdGUnLCAncGlja0RpcmVjdG9yeScsICdwaWNrRmlsZXMnLCAncG9wdXBNYWluTWVudScsICdwcm92aWRlclNhdmUnLCAncHJvdmlkZXJzJywgJ3JlbW90ZVdlYkF1dG9zdGFydCcsICdyZW1vdGVXZWJTdGFydCcsICdyZW1vdGVXZWJTdGF0dXMnLCAncmVtb3RlV2ViU3RvcCcsICdydW50aW1lSW5mbycsICdzZW5kVGFzaycsICdzZXNzaW9uT3AnLCAnc2Vzc2lvblByZXZpZXcnLCAnc2Vzc2lvbnMnLCAnc2V0UnVudGltZScsICdzdG9wSG9zdCcsICd3aXphcmRDb21wbGV0ZScsICd3b3Jrc3BhY2VzJywgJ3dvcmtzcGFjZUFkZCcsICd3b3Jrc3BhY2VVc2UnXTtcclxuICAgICAgY29uc3QgZ290ID0gciA9PT0gJycgPyBbXSA6IHIuc3BsaXQoJywnKTtcclxuICAgICAgY29uc3QgdW5leHBlY3RlZCA9IGdvdC5maWx0ZXIoKGspID0+ICFhbGxvdy5pbmNsdWRlcyhrKSk7XHJcbiAgICAgIHJldHVybiBbdW5leHBlY3RlZC5sZW5ndGggPT09IDAsIGBrZXlzPSR7cn1gXTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgY2hlY2soJ1x1NTkxNlx1OTBFOFx1NUJGQ1x1ODIyQVx1ODhBQlx1NjJFNlx1NjIyQShVUkwgXHU0RTBEXHU1M0Q4KScsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgYmVmb3JlID0gd2luLndlYkNvbnRlbnRzLmdldFVSTCgpO1xyXG4gICAgICBhd2FpdCBqcygnbG9jYXRpb24uaHJlZiA9IFwiaHR0cHM6Ly9leGFtcGxlLmludmFsaWQveFwiOyBcIm5vb3BcIicpLmNhdGNoKCgpID0+ICdub29wJyk7XHJcbiAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyMikgPT4gc2V0VGltZW91dChyMiwgMV8yMDApKTtcclxuICAgICAgY29uc3QgYWZ0ZXIgPSB3aW4ud2ViQ29udGVudHMuZ2V0VVJMKCk7XHJcbiAgICAgIHJldHVybiBbYWZ0ZXIgPT09IGJlZm9yZSwgYCR7YmVmb3JlfSBcdTIxOTIgJHthZnRlcn1gXTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgY2hlY2soJ3dpbmRvdy5vcGVuIFx1ODhBQlx1NjJEMlx1N0VERChcdThGRDRcdTU2REUgbnVsbCBcdTRFMTRcdTY1RTBcdTY1QjBcdTdBOTdcdTUzRTMpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCBiZWZvcmUgPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5sZW5ndGg7XHJcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoJ1N0cmluZyh3aW5kb3cub3BlbihcImh0dHBzOi8vZXhhbXBsZS5pbnZhbGlkXCIpKScpKSBhcyBzdHJpbmc7XHJcbiAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyMikgPT4gc2V0VGltZW91dChyMiwgNDAwKSk7XHJcbiAgICAgIGNvbnN0IGFmdGVyID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkubGVuZ3RoO1xyXG4gICAgICByZXR1cm4gW3IgPT09ICdudWxsJyAmJiBhZnRlciA9PT0gYmVmb3JlLCBgb3BlbigpPSR7cn0gd2luZG93cz0ke2JlZm9yZX1cdTIxOTIke2FmdGVyfWBdO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBjaGVjaygnQ1NQIFx1NUI1OFx1NTcyOChtZXRhIFx1NkNFOFx1NTE2NVx1NjIxNlx1NTRDRFx1NUU5NFx1NTkzNCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IG1ldGEgPSAoYXdhaXQganMoJ0Jvb2xlYW4oZG9jdW1lbnQucXVlcnlTZWxlY3RvcihcIm1ldGFbaHR0cC1lcXVpdj1cXCdDb250ZW50LVNlY3VyaXR5LVBvbGljeVxcJ11cIikpJykpIGFzIGJvb2xlYW47XHJcbiAgICAgIGNvbnN0IGhlYWRlckNzcCA9IGlzRGV2ID8gJ2RldjogaGVhZGVyIENTUCBcdTc1MzEgb25IZWFkZXJzUmVjZWl2ZWQgXHU2Q0U4XHU1MTY1KFx1NEUwRFx1OTAwMlx1NzUyOCBtZXRhIFx1NjVBRFx1OEEwMCknIDogJ3Byb2QnO1xyXG4gICAgICByZXR1cm4gW21ldGEgfHwgaXNEZXYsIGBtZXRhPSR7bWV0YX0gJHtoZWFkZXJDc3B9YF07XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IGNoZWNrKCdicmlkZ2U6Z2V0LXN0YXRlIFx1NkI2M1x1NUUzOFx1OEZENFx1NTZERShob3N0IFx1Njg2NVx1NTNFRlx1NzUyOCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoJ3dpbmRvdy5obWguZ2V0U3RhdGUoKS50aGVuKHMgPT4gSlNPTi5zdHJpbmdpZnkocykpLmNhdGNoKGUgPT4gXCJFUlI6XCIrZSknKSkgYXMgc3RyaW5nO1xyXG4gICAgICByZXR1cm4gW3Iuc3RhcnRzV2l0aCgneycpICYmIHIuaW5jbHVkZXMoJ2hvc3RTdGF0ZScpLCByLnNsaWNlKDAsIDgwKV07XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IGNoZWNrKCdYU1M6XHU2MDc2XHU2MTBGXHU0RUZCXHU1MkExXHU2NTg3XHU2NzJDXHU1M0VBXHU0RUU1XHU2NTg3XHU2NzJDXHU2RTMyXHU2N0QzKFx1NEUwRFx1NjI2N1x1ODg0QyknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHBheWxvYWQgPSAnPGltZyBzcmM9eCBvbmVycm9yPVwid2luZG93Ll9feHNzPTFcIj48c2NyaXB0PndpbmRvdy5fX3hzcz0yPFxcL3NjcmlwdD5cIiZcXCcnO1xyXG4gICAgICBjb25zdCBzZW5kUiA9IChhd2FpdCBqcyhgd2luZG93LmhtaC5zZW5kVGFzaygke0pTT04uc3RyaW5naWZ5KHBheWxvYWQpfSwgJ3NlYy14c3MtMScsICdhdXRvJykudGhlbihyPT5KU09OLnN0cmluZ2lmeShyKSkuY2F0Y2goZT0+J0VSUjonK2UpYCkpIGFzIHN0cmluZztcclxuICAgICAgaWYgKCFzZW5kUi5pbmNsdWRlcygnXCJva1wiOnRydWUnKSkgcmV0dXJuIFtmYWxzZSwgYHNlbmRUYXNrIFx1NjcyQVx1NTNEN1x1NzQwNjogJHtzZW5kUi5zbGljZSgwLCA4MCl9YF07XHJcbiAgICAgIC8vIGZha2UgaG9zdCBlY2hvIFx1NTZERVx1Njc2NVx1NTQwRVx1N0VDRiBSZWFjdCBcdTZFMzJcdTY3RDMoXHU3NTI4XHU2MjM3XHU2RDg4XHU2MDZGICsgXHU1MkE5XHU2MjRCIGVjaG8gXHU1M0NDXHU4REVGXHU1Rjg0KVxyXG4gICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocjIpID0+IHNldFRpbWVvdXQocjIsIDNfMDAwKSk7XHJcbiAgICAgIGNvbnN0IHByb2JlID0gKGF3YWl0IGpzKGBKU09OLnN0cmluZ2lmeSh7XHJcbiAgICAgICAgeHNzRmxhZzogdHlwZW9mIHdpbmRvdy5fX3hzcyxcclxuICAgICAgICBpbWdDb3VudDogZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnaW1nW3NyYz1cInhcIl0nKS5sZW5ndGgsXHJcbiAgICAgICAgc2NyaXB0UmFuOiBkb2N1bWVudC5ib2R5LmlubmVyVGV4dC5pbmRleE9mKCd3aW5kb3cuX194c3M9MicpID49IDBcclxuICAgICAgfSlgKSkgYXMgc3RyaW5nO1xyXG4gICAgICBjb25zdCBwID0gSlNPTi5wYXJzZShwcm9iZSkgYXMgeyB4c3NGbGFnOiBzdHJpbmc7IGltZ0NvdW50OiBudW1iZXI7IHNjcmlwdFJhbjogYm9vbGVhbiB9O1xyXG4gICAgICByZXR1cm4gW3AueHNzRmxhZyA9PT0gJ3VuZGVmaW5lZCcgJiYgcC5pbWdDb3VudCA9PT0gMCwgYHhzc0ZsYWc9JHtwLnhzc0ZsYWd9IGltZz0ke3AuaW1nQ291bnR9YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICBsZXQgZmFpbGVkID0gMDtcclxuICAgIGZvciAoY29uc3QgW25hbWUsIG9rLCBkZXRhaWxdIG9mIHJlc3VsdHMpIHtcclxuICAgICAgY29uc29sZS5sb2coYFNFQ1VSSVRZLVRFU1QgJHtvayA/ICdQQVNTJyA6ICdGQUlMJ30gfCAke25hbWV9IHwgJHtyZWRhY3QoZGV0YWlsKX1gKTtcclxuICAgICAgaWYgKCFvaykgZmFpbGVkICs9IDE7XHJcbiAgICB9XHJcbiAgICBjb25zb2xlLmxvZyhgU0VDVVJJVFktVEVTVCBTVU1NQVJZIHBhc3M9JHtyZXN1bHRzLmxlbmd0aCAtIGZhaWxlZH0vJHtyZXN1bHRzLmxlbmd0aH1gKTtcclxuICAgIGFwcC5leGl0KGZhaWxlZCA9PT0gMCA/IDAgOiAxKTtcclxuICB9XHJcblxyXG4gIC8vIFx1OTAwMFx1NTFGQTpcdTRGMThcdTk2QzVcdTUwNUNcdTZCNjJcdTgxRUFcdTVERjEgc3Bhd24gXHU3Njg0IGhvc3Qoc2h1dGRvd24gXHU3QUVGXHU3MEI5IFx1MjE5MiBcdTUxNUNcdTVFOTVcdTUzRUEga2lsbCBcdTgxRUFcdTVERjFcdTc2ODRcdTUzRTVcdTY3QzQpXHJcbiAgYXBwLm9uKCdiZWZvcmUtcXVpdCcsIChlKSA9PiB7XHJcbiAgICBpZiAoc3VwZXJ2aXNvciAhPT0gbnVsbCAmJiBzdXBlcnZpc29yLnN0YXRlICE9PSAnc3RvcHBlZCcpIHtcclxuICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xyXG4gICAgICBzc2VBYm9ydD8uYWJvcnQoKTtcclxuICAgICAgdm9pZCBzdXBlcnZpc29yLnN0b3AoKS5maW5hbGx5KCgpID0+IGFwcC5xdWl0KCkpO1xyXG4gICAgfVxyXG4gIH0pO1xyXG4gIGFwcC5vbignd2luZG93LWFsbC1jbG9zZWQnLCAoKSA9PiB7XHJcbiAgICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSAhPT0gJ2RhcndpbicpIGFwcC5xdWl0KCk7XHJcbiAgfSk7XHJcbn1cclxuIiwgIi8qKlxyXG4gKiBEZXNrdG9wUnVudGltZVN1cGVydmlzb3IgXHUyMDE0IGhtaGFybmVzcyBob3N0IFx1OEZEQlx1N0EwQlx1NzY4NFx1NzUxRlx1NTQ3RFx1NTQ2OFx1NjcxRlx1NzJCNlx1NjAwMVx1NjczQShBRFItMDAzKVx1MzAwMlxyXG4gKlxyXG4gKiBcdTVCODlcdTUxNjhcdTRFMERcdTUzRDhcdTkxQ0Y6XHJcbiAqICAtIFx1NTNFQVx1N0VEMVx1NUI5QS9cdTYzQTJcdTZENEIgMTI3LjAuMC4xO2hvc3QgXHU0RjdGXHU3NTI4XHU2NENEXHU0RjVDXHU3Q0ZCXHU3RURGXHU1MjA2XHU5MTREXHU3QUVGXHU1M0UzKHBvcnQgMCksXHU1QjlFXHU5NjQ1XHU3QUVGXHU1M0UzXHJcbiAqICAgIFx1NzUzMSBob3N0IFx1NzY4NCBzdGRvdXQgXHU1RjE1XHU1QkZDXHU4ODRDXHU1NkRFXHU0RjIwKEhvc3RSZWFkeUxpbmUpXHUzMDAyXHJcbiAqICAtIFx1OUFEOFx1NzFCNSB0b2tlbiBcdTUzRUFcdTkwMUFcdThGQzdcdTVCNTBcdThGREJcdTdBMEJcdTczQUZcdTU4ODNcdTUzRDhcdTkxQ0ZcdTRGMjBcdTkwMTIsXHU3RUREXHU0RTBEXHU4RkRCIFVSTC9cdTY1RTVcdTVGRDcvSVBDIFx1NjYwRVx1NjU4N1x1OEQxRlx1OEY3RFx1MzAwMlxyXG4gKiAgLSBcdTUzRUFcdTUwNUNcdTZCNjJcdTY3MkMgc3VwZXJ2aXNvciBzcGF3biBcdTc2ODRcdThGREJcdTdBMEJcdTUzRTVcdTY3QzQ7XHU3RUREXHU0RTBEXHU2MzA5XHU4RkRCXHU3QTBCXHU1NDBEIGtpbGxcdTMwMDJcclxuICogIC0gaG9zdCBjcmFzaCBcdTU0MEVcdTY3MDlcdTk2NTBcdTkxQ0RcdTU0MkY7XHU5MUNEXHU1NDJGXHU0RTBEXHU5MUNEXHU2NTNFXHU0RUZCXHU0RjU1XHU3NTI4XHU2MjM3XHU1MkE4XHU0RjVDKFx1OTc1RVx1NUU0Mlx1N0I0OVx1NTJBOFx1NEY1Q1x1NzUzMVx1NzUyOFx1NjIzN1x1Nzg2RVx1OEJBNClcdTMwMDJcclxuICovXHJcbmltcG9ydCB7IHNwYXduLCB0eXBlIENoaWxkUHJvY2VzcyB9IGZyb20gJ25vZGU6Y2hpbGRfcHJvY2Vzcyc7XHJcbmltcG9ydCB7IGNyZWF0ZUludGVyZmFjZSB9IGZyb20gJ25vZGU6cmVhZGxpbmUnO1xyXG5pbXBvcnQgeyByYW5kb21CeXRlcyB9IGZyb20gJ25vZGU6Y3J5cHRvJztcclxuaW1wb3J0IHsgZGVza3RvcEVycm9yLCBpc0Rlc2t0b3BFcnJvciwgdHlwZSBEZXNrdG9wRXJyb3IgfSBmcm9tICdAaG1oLWRlc2t0b3AvY29udHJhY3RzJztcclxuXHJcbmV4cG9ydCB0eXBlIEhvc3RTdGF0ZSA9XHJcbiAgfCAnc3RvcHBlZCdcclxuICB8ICdzdGFydGluZydcclxuICB8ICdyZWFkeSdcclxuICB8ICdkaXNjb25uZWN0ZWQnXHJcbiAgfCAncmVzdGFydGluZydcclxuICB8ICdzdG9wcGluZydcclxuICB8ICdmYWlsZWQnO1xyXG5cclxuZXhwb3J0IGludGVyZmFjZSBIb3N0U3BlYyB7XHJcbiAgLyoqIFx1NTNFRlx1NjI2N1x1ODg0Q1x1NjU4N1x1NEVGNihcdTkwMUFcdTVFMzggcHJvY2Vzcy5leGVjUGF0aClcdTMwMDIgKi9cclxuICBjb21tYW5kOiBzdHJpbmc7XHJcbiAgYXJnczogc3RyaW5nW107XHJcbiAgY3dkPzogc3RyaW5nO1xyXG4gIC8qKiBcdTk4OURcdTU5MTZcdTczQUZcdTU4ODNcdTUzRDhcdTkxQ0YoXHU0RjFBXHU0RTBFIHByb2Nlc3MuZW52IFx1NTQwOFx1NUU3NilcdTMwMDIgKi9cclxuICBlbnY/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xyXG59XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIFN1cGVydmlzb3JPcHRpb25zIHtcclxuICAvKiogXHU2NzFGXHU2NzFCIGhvc3QgXHU2ODIxXHU5QThDXHU3Njg0IGJlYXJlciB0b2tlbjtcdTRFMERcdTRGMjBcdTUyMTlcdTZCQ0ZcdTZCMjEgc3RhcnQgXHU3NTFGXHU2MjEwXHU5QUQ4XHU3MUI1XHU5NjhGXHU2NzNBXHU1MDNDXHUzMDAyICovXHJcbiAgdG9rZW4/OiBzdHJpbmc7XHJcbiAgbWF4UmVzdGFydHM/OiBudW1iZXI7XHJcbiAgc3RhcnRUaW1lb3V0TXM/OiBudW1iZXI7XHJcbiAgZ3JhY2VmdWxTaHV0ZG93bk1zPzogbnVtYmVyO1xyXG4gIG9uU3RhdGVDaGFuZ2U/KHN0YXRlOiBIb3N0U3RhdGUsIGluZm86IHsgcmVzdGFydENvdW50OiBudW1iZXI7IGxhc3RFcnJvcj86IHN0cmluZyB9KTogdm9pZDtcclxuICAvKiogXHU2QkNGXHU2QjIxIGhvc3QgXHU1QzMxXHU3RUVBKFx1NTQyQiBjcmFzaCBcdTgxRUFcdTYxMDhcdTU0MEVcdTc2ODRcdTkxQ0RcdTU0MkYpXHU5MEZEXHU0RjFBXHU4OUU2XHU1M0QxLFx1NjQzQVx1NUUyNlx1N0FFRlx1NzBCOShcdTU0MkIgdG9rZW4sXHJcbiAgICogIFx1NEVDNVx1NEY5Qlx1NTQwQ1x1NEZFMVx1NEVGQlx1NTdERlx1NzY4NFx1NUJCRlx1NEUzQlx1OEZEQlx1N0EwQlx1OTFDRFx1NUVGQVx1Njg2NVx1NUJBMlx1NjIzN1x1N0FFRjtcdTRFMERcdTg5ODFcdThERThcdThGREIgcmVuZGVyZXIpXHUzMDAyICovXHJcbiAgb25SZWFkeT8oZW5kcG9pbnQ6IEhvc3RFbmRwb2ludCk6IHZvaWQ7XHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgSG9zdEVuZHBvaW50IHtcclxuICBwb3J0OiBudW1iZXI7XHJcbiAgdmVyc2lvbjogc3RyaW5nO1xyXG4gIHRva2VuOiBzdHJpbmc7XHJcbn1cclxuXHJcbi8qKiBIb3N0UmVhZHlMaW5lIFx1NzY4NFx1N0M3Qlx1NTc4Qlx1NUI4OFx1NTM2Qlx1NEVDRSBjb250cmFjdHMgXHU1RjE1XHU1MTY1LFx1OTA3Rlx1NTE0RFx1NTNDQ1x1NUI5RVx1NzNCMFx1MzAwMiAqL1xyXG5pbXBvcnQgeyBpc0hvc3RSZWFkeUxpbmUgfSBmcm9tICdAaG1oLWRlc2t0b3AvY29udHJhY3RzJztcclxuXHJcbi8vIDQ1czpobWhhcm5lc3MgXHU3NzFGXHU1QjlFXHU1MTY1XHU1M0UzXHU3RUNGIHRzeCBcdTUxQjdcdTdGMTZcdThCRDFcdTY1NzRcdTU5NTcgQ0xJLFx1NjczQVx1NTY2OFx1OUFEOFx1OEQxRlx1OEY3RFx1NjVGNlx1NTNFRlx1OEQ4NSAyMHNcclxuLy8gKDIwMjYtMTAtMTEgXHU4RkRFXHU3RUVEXHU5QThDXHU2NTM2XHU0RTJEXHU5NUY0XHU2QjQ3XHU2MDI3IEhPU1RfTk9UX1JFQURZIFx1NzY4NFx1NjgzOVx1NTZFMDtcdTdBN0FcdTk1RjJcdTVCOUVcdTZENEIgNnMpXHUzMDAyXHJcbmNvbnN0IERFRkFVTFRfU1RBUlRfVElNRU9VVF9NUyA9IDQ1XzAwMDtcclxuY29uc3QgREVGQVVMVF9NQVhfUkVTVEFSVFMgPSAzO1xyXG5jb25zdCBERUZBVUxUX0dSQUNFRlVMX01TID0gNV8wMDA7XHJcblxyXG5leHBvcnQgY2xhc3MgRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yIHtcclxuICBwcml2YXRlIGNoaWxkOiBDaGlsZFByb2Nlc3MgfCBudWxsID0gbnVsbDtcclxuICBwcml2YXRlIF9zdGF0ZTogSG9zdFN0YXRlID0gJ3N0b3BwZWQnO1xyXG4gIHByaXZhdGUgcmVzdGFydENvdW50ID0gMDtcclxuICBwcml2YXRlIGxhc3RFcnJvciA9ICcnO1xyXG4gIHByaXZhdGUgc3RvcHBpbmcgPSBmYWxzZTtcclxuICBwcml2YXRlIHJlYWRvbmx5IHRva2VuOiBzdHJpbmc7XHJcbiAgcHJpdmF0ZSByZWFkb25seSBvcHRzOiBSZXF1aXJlZDxQaWNrPFN1cGVydmlzb3JPcHRpb25zLCAnbWF4UmVzdGFydHMnIHwgJ3N0YXJ0VGltZW91dE1zJyB8ICdncmFjZWZ1bFNodXRkb3duTXMnPj4gJiBTdXBlcnZpc29yT3B0aW9ucztcclxuICBwcml2YXRlIGV4aXRXYWl0ZXJzOiBBcnJheTwoKSA9PiB2b2lkPiA9IFtdO1xyXG5cclxuICBjb25zdHJ1Y3RvcihcclxuICAgIHByaXZhdGUgcmVhZG9ubHkgc3BlYzogSG9zdFNwZWMsXHJcbiAgICBvcHRzOiBTdXBlcnZpc29yT3B0aW9ucyA9IHt9LFxyXG4gICkge1xyXG4gICAgdGhpcy50b2tlbiA9IG9wdHMudG9rZW4gPz8gcmFuZG9tQnl0ZXMoMzIpLnRvU3RyaW5nKCdiYXNlNjR1cmwnKTtcclxuICAgIHRoaXMub3B0cyA9IHtcclxuICAgICAgbWF4UmVzdGFydHM6IG9wdHMubWF4UmVzdGFydHMgPz8gREVGQVVMVF9NQVhfUkVTVEFSVFMsXHJcbiAgICAgIHN0YXJ0VGltZW91dE1zOiBvcHRzLnN0YXJ0VGltZW91dE1zID8/IERFRkFVTFRfU1RBUlRfVElNRU9VVF9NUyxcclxuICAgICAgZ3JhY2VmdWxTaHV0ZG93bk1zOiBvcHRzLmdyYWNlZnVsU2h1dGRvd25NcyA/PyBERUZBVUxUX0dSQUNFRlVMX01TLFxyXG4gICAgICAuLi5vcHRzLFxyXG4gICAgfTtcclxuICB9XHJcblxyXG4gIGdldCBzdGF0ZSgpOiBIb3N0U3RhdGUge1xyXG4gICAgcmV0dXJuIHRoaXMuX3N0YXRlO1xyXG4gIH1cclxuXHJcbiAgZ2V0IHJlc3RhcnRzVXNlZCgpOiBudW1iZXIge1xyXG4gICAgcmV0dXJuIHRoaXMucmVzdGFydENvdW50O1xyXG4gIH1cclxuXHJcbiAgcHJpdmF0ZSBzZXRTdGF0ZShzOiBIb3N0U3RhdGUsIGVycj86IHN0cmluZyk6IHZvaWQge1xyXG4gICAgdGhpcy5fc3RhdGUgPSBzO1xyXG4gICAgaWYgKGVyciAhPT0gdW5kZWZpbmVkKSB0aGlzLmxhc3RFcnJvciA9IGVycjtcclxuICAgIGNvbnN0IGluZm86IHsgcmVzdGFydENvdW50OiBudW1iZXI7IGxhc3RFcnJvcj86IHN0cmluZyB9ID0geyByZXN0YXJ0Q291bnQ6IHRoaXMucmVzdGFydENvdW50IH07XHJcbiAgICBpZiAodGhpcy5sYXN0RXJyb3IgIT09ICcnKSBpbmZvLmxhc3RFcnJvciA9IHRoaXMubGFzdEVycm9yO1xyXG4gICAgdGhpcy5vcHRzLm9uU3RhdGVDaGFuZ2U/LihzLCBpbmZvKTtcclxuICB9XHJcblxyXG4gIC8qKiBcdTU0MkZcdTUyQTggaG9zdCBcdTVFNzZcdTdCNDlcdTVGODUgcmVhZHkoXHU1RjE1XHU1QkZDXHU4ODRDICsgXHU1RTI2IHRva2VuIFx1NzY4NFx1NTA2NVx1NUVCN1x1NjNBMlx1NkQ0QilcdTMwMDIgKi9cclxuICBhc3luYyBzdGFydCgpOiBQcm9taXNlPEhvc3RFbmRwb2ludD4ge1xyXG4gICAgaWYgKHRoaXMuX3N0YXRlID09PSAncmVhZHknIHx8IHRoaXMuX3N0YXRlID09PSAnc3RhcnRpbmcnKSB7XHJcbiAgICAgIHRocm93IGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgc3VwZXJ2aXNvciBhbHJlYWR5ICR7dGhpcy5fc3RhdGV9YCk7XHJcbiAgICB9XHJcbiAgICB0aGlzLnJlc3RhcnRDb3VudCA9IDA7XHJcbiAgICB0aGlzLnN0b3BwaW5nID0gZmFsc2U7XHJcbiAgICByZXR1cm4gdGhpcy5sYXVuY2goKTtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgYXN5bmMgbGF1bmNoKCk6IFByb21pc2U8SG9zdEVuZHBvaW50PiB7XHJcbiAgICB0aGlzLnNldFN0YXRlKCdzdGFydGluZycpO1xyXG4gICAgY29uc3QgY2hpbGQgPSBzcGF3bih0aGlzLnNwZWMuY29tbWFuZCwgdGhpcy5zcGVjLmFyZ3MsIHtcclxuICAgICAgY3dkOiB0aGlzLnNwZWMuY3dkLFxyXG4gICAgICBlbnY6IHtcclxuICAgICAgICAuLi5wcm9jZXNzLmVudixcclxuICAgICAgICAuLi50aGlzLnNwZWMuZW52LFxyXG4gICAgICAgIEhNSF9ERVNLVE9QX1RPS0VOOiB0aGlzLnRva2VuLFxyXG4gICAgICB9LFxyXG4gICAgICBzdGRpbzogWydpZ25vcmUnLCAncGlwZScsICdwaXBlJ10sXHJcbiAgICAgIHdpbmRvd3NIaWRlOiB0cnVlLFxyXG4gICAgfSk7XHJcbiAgICB0aGlzLmNoaWxkID0gY2hpbGQ7XHJcblxyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3QgZW5kcG9pbnQgPSBhd2FpdCB0aGlzLmF3YWl0UmVhZHkoY2hpbGQpO1xyXG4gICAgICB0aGlzLmN1cnJlbnRFbmRwb2ludCA9IHsgcG9ydDogZW5kcG9pbnQucG9ydCwgdmVyc2lvbjogZW5kcG9pbnQudmVyc2lvbiB9O1xyXG4gICAgICB0aGlzLnNldFN0YXRlKCdyZWFkeScpO1xyXG4gICAgICB0aGlzLm9wdHMub25SZWFkeT8uKGVuZHBvaW50KTtcclxuICAgICAgLy8gcmVhZHkgXHU0RTRCXHU1NDBFXHU4RkRCXHU3QTBCXHU2QjdCXHU0RUExID0gXHU2MTBGXHU1OTE2XHU5MDAwXHU1MUZBIFx1MjE5MiBcdTY3MDlcdTk2NTBcdTkxQ0RcdTU0MkZcclxuICAgICAgY2hpbGQub25jZSgnZXhpdCcsICgpID0+IHtcclxuICAgICAgICB0aGlzLmV4aXRXYWl0ZXJzLmZvckVhY2goKHcpID0+IHcoKSk7XHJcbiAgICAgICAgdGhpcy5leGl0V2FpdGVycyA9IFtdO1xyXG4gICAgICAgIHRoaXMub25VbmV4cGVjdGVkRXhpdCgpO1xyXG4gICAgICB9KTtcclxuICAgICAgcmV0dXJuIGVuZHBvaW50O1xyXG4gICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgIGlmICghY2hpbGQua2lsbGVkKSBjaGlsZC5raWxsKCk7XHJcbiAgICAgIGlmICh0aGlzLmNoaWxkID09PSBjaGlsZCkgdGhpcy5jaGlsZCA9IG51bGw7XHJcbiAgICAgIHRocm93IGVycjtcclxuICAgIH1cclxuICB9XHJcblxyXG4gIC8qKiBcdTRFQ0Ugc3Rkb3V0IFx1NjI3RSBIb3N0UmVhZHlMaW5lLFx1NzEzNlx1NTQwRVx1NTA2NVx1NUVCN1x1NjNBMlx1NkQ0Qlx1MzAwMiAqL1xyXG4gIHByaXZhdGUgYXdhaXRSZWFkeShjaGlsZDogQ2hpbGRQcm9jZXNzKTogUHJvbWlzZTxIb3N0RW5kcG9pbnQ+IHtcclxuICAgIHJldHVybiBuZXcgUHJvbWlzZTxIb3N0RW5kcG9pbnQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcclxuICAgICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHtcclxuICAgICAgICByZWplY3QoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBob3N0IGRpZCBub3Qgc2lnbmFsIHJlYWR5IHdpdGhpbiAke3RoaXMub3B0cy5zdGFydFRpbWVvdXRNc31tc2AsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xyXG4gICAgICB9LCB0aGlzLm9wdHMuc3RhcnRUaW1lb3V0TXMpO1xyXG5cclxuICAgICAgY29uc3QgZG9uZSA9IChmbjogKCkgPT4gdm9pZCk6IHZvaWQgPT4ge1xyXG4gICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XHJcbiAgICAgICAgZm4oKTtcclxuICAgICAgfTtcclxuXHJcbiAgICAgIGlmICghY2hpbGQuc3Rkb3V0KSB7XHJcbiAgICAgICAgZG9uZSgoKSA9PiByZWplY3QoZGVza3RvcEVycm9yKCdSVU5USU1FX0NSQVNIRUQnLCAnaG9zdCBzcGF3bmVkIHdpdGhvdXQgc3Rkb3V0IHBpcGUnKSkpO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgICAgfVxyXG5cclxuICAgICAgY29uc3QgcmwgPSBjcmVhdGVJbnRlcmZhY2UoeyBpbnB1dDogY2hpbGQuc3Rkb3V0IH0pO1xyXG4gICAgICBjb25zdCBvbkxpbmUgPSAobGluZTogc3RyaW5nKTogdm9pZCA9PiB7XHJcbiAgICAgICAgbGV0IHBhcnNlZDogdW5rbm93bjtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgcGFyc2VkID0gSlNPTi5wYXJzZShsaW5lKTtcclxuICAgICAgICB9IGNhdGNoIHtcclxuICAgICAgICAgIHJldHVybjsgLy8gaG9zdCBcdTc2ODRcdTY2NkVcdTkwMUFcdTY1RTVcdTVGRDdcdTg4NEMsXHU1RkZEXHU3NTY1XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChpc0hvc3RSZWFkeUxpbmUocGFyc2VkKSkge1xyXG4gICAgICAgICAgcmwuY2xvc2UoKTtcclxuICAgICAgICAgIHZvaWQgdGhpcy5wcm9iZUFuZFJlbWVtYmVyKHBhcnNlZC5wb3J0LCBwYXJzZWQudmVyc2lvbilcclxuICAgICAgICAgICAgLnRoZW4oKGVuZHBvaW50KSA9PiBkb25lKCgpID0+IHJlc29sdmUoZW5kcG9pbnQpKSlcclxuICAgICAgICAgICAgLmNhdGNoKChlcnI6IHVua25vd24pID0+IGRvbmUoKCkgPT4gcmVqZWN0KGVycikpKTtcclxuICAgICAgICB9XHJcbiAgICAgIH07XHJcbiAgICAgIHJsLm9uKCdsaW5lJywgb25MaW5lKTtcclxuXHJcbiAgICAgIGNoaWxkLm9uY2UoJ2V4aXQnLCAoY29kZSkgPT4ge1xyXG4gICAgICAgIGRvbmUoKCkgPT4gcmVqZWN0KGRlc2t0b3BFcnJvcignUlVOVElNRV9DUkFTSEVEJywgYGhvc3QgZXhpdGVkIGR1cmluZyBzdGFydHVwIChjb2RlICR7Y29kZSA/PyAnbnVsbCd9KWAsIHsgcmV0cnlhYmxlOiBmYWxzZSwgcmVjb3ZlcnlBY3Rpb246ICdPUEVOX0xPR1MnIH0pKSk7XHJcbiAgICAgIH0pO1xyXG4gICAgfSk7XHJcbiAgfVxyXG5cclxuICAvKiogXHU1RTI2IHRva2VuIFx1NzY4NFx1NTA2NVx1NUVCN1x1NjNBMlx1NkQ0QjpHRVQgL2FwaS9zdGF0ZVx1MzAwMjQwMSBcdTIxOTIgQVVUSF9GQUlMRUQoXHU0RTBEXHU5MUNEXHU4QkQ1KVx1MzAwMiAqL1xyXG4gIHByaXZhdGUgYXN5bmMgcHJvYmUocG9ydDogbnVtYmVyLCB2ZXJzaW9uOiBzdHJpbmcpOiBQcm9taXNlPEhvc3RFbmRwb2ludD4ge1xyXG4gICAgbGV0IHJlczogUmVzcG9uc2U7XHJcbiAgICB0cnkge1xyXG4gICAgICByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2FwaS9zdGF0ZWAsIHtcclxuICAgICAgICBoZWFkZXJzOiB7ICd4LWhtaC1rZXknOiB0aGlzLnRva2VuIH0sXHJcbiAgICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDNfMDAwKSxcclxuICAgICAgfSk7XHJcbiAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgdGhyb3cgZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBoZWFsdGggcHJvYmUgZmFpbGVkOiAke1N0cmluZyhlcnIpLnNsaWNlKDAsIDE2MCl9YCwgeyByZXRyeWFibGU6IHRydWUgfSk7XHJcbiAgICB9XHJcbiAgICBpZiAocmVzLnN0YXR1cyA9PT0gNDAxIHx8IHJlcy5zdGF0dXMgPT09IDQwMykge1xyXG4gICAgICB0aHJvdyBkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgYGhvc3QgcmVqZWN0ZWQgdGhlIHNlc3Npb24gdG9rZW4gKEhUVFAgJHtyZXMuc3RhdHVzfSlgLCB7IHJldHJ5YWJsZTogZmFsc2UsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KTtcclxuICAgIH1cclxuICAgIGlmICghcmVzLm9rKSB7XHJcbiAgICAgIHRocm93IGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgaGVhbHRoIHByb2JlIEhUVFAgJHtyZXMuc3RhdHVzfWAsIHsgcmV0cnlhYmxlOiB0cnVlIH0pO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHsgcG9ydCwgdmVyc2lvbiwgdG9rZW46IHRoaXMudG9rZW4gfTtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgb25VbmV4cGVjdGVkRXhpdCgpOiB2b2lkIHtcclxuICAgIGlmICh0aGlzLnN0b3BwaW5nIHx8IHRoaXMuX3N0YXRlID09PSAnc3RvcHBlZCcgfHwgdGhpcy5fc3RhdGUgPT09ICdzdG9wcGluZycpIHJldHVybjtcclxuICAgIHRoaXMuY2hpbGQgPSBudWxsO1xyXG4gICAgaWYgKHRoaXMucmVzdGFydENvdW50IDwgdGhpcy5vcHRzLm1heFJlc3RhcnRzKSB7XHJcbiAgICAgIHRoaXMucmVzdGFydENvdW50ICs9IDE7XHJcbiAgICAgIHRoaXMuc2V0U3RhdGUoJ3Jlc3RhcnRpbmcnKTtcclxuICAgICAgdm9pZCB0aGlzLmxhdW5jaCgpLmNhdGNoKCgpID0+IHtcclxuICAgICAgICAvLyBcdTkxQ0RcdTU0MkZcdTVDMURcdThCRDVcdTU5MzFcdThEMjUoXHU1NDJGXHU1MkE4XHU1MzczXHU1RDI5L1x1OEQ4NVx1NjVGNi9cdTYyRDJcdThCQTQpOlx1N0VFN1x1N0VFRFx1NkQ4OFx1ODAxN1x1OTFDRFx1NTQyRlx1NkIyMVx1NjU3MFx1NzZGNFx1NTIzMFx1NjUzRVx1NUYwM1xyXG4gICAgICAgIHRoaXMucmV0cnlPckZhaWwoKTtcclxuICAgICAgfSk7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICB0aGlzLnNldFN0YXRlKCdmYWlsZWQnLCBgaG9zdCBleGl0ZWQgdW5leHBlY3RlZGx5ICR7dGhpcy5yZXN0YXJ0Q291bnQgKyAxfSB0aW1lczsgZ2l2aW5nIHVwYCk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICBwcml2YXRlIHJldHJ5T3JGYWlsKCk6IHZvaWQge1xyXG4gICAgaWYgKHRoaXMuc3RvcHBpbmcgfHwgdGhpcy5fc3RhdGUgPT09ICdzdG9wcGVkJyB8fCB0aGlzLl9zdGF0ZSA9PT0gJ3N0b3BwaW5nJykgcmV0dXJuO1xyXG4gICAgaWYgKHRoaXMucmVzdGFydENvdW50IDwgdGhpcy5vcHRzLm1heFJlc3RhcnRzKSB7XHJcbiAgICAgIHRoaXMucmVzdGFydENvdW50ICs9IDE7XHJcbiAgICAgIHRoaXMuc2V0U3RhdGUoJ3Jlc3RhcnRpbmcnKTtcclxuICAgICAgdm9pZCB0aGlzLmxhdW5jaCgpLmNhdGNoKCgpID0+IHRoaXMucmV0cnlPckZhaWwoKSk7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICB0aGlzLnNldFN0YXRlKCdmYWlsZWQnLCBgaG9zdCBmYWlsZWQgdG8gc3RheSB1cCBhZnRlciAke3RoaXMucmVzdGFydENvdW50fSByZXN0YXJ0IGF0dGVtcHRzYCk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvKiogXHU0RjE4XHU5NkM1XHU1MDVDXHU2QjYyOlx1NTE0OCBIVFRQIHNodXRkb3duLFx1OEQ4NVx1NjVGNlx1NjI0RFx1NUJGOVx1NjcyQ1x1OEZEQlx1N0EwQlx1NTNFNVx1NjdDNCBraWxsXHUzMDAyICovXHJcbiAgYXN5bmMgc3RvcCgpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIHRoaXMuc3RvcHBpbmcgPSB0cnVlO1xyXG4gICAgaWYgKHRoaXMuX3N0YXRlID09PSAnc3RvcHBlZCcpIHJldHVybjtcclxuICAgIHRoaXMuc2V0U3RhdGUoJ3N0b3BwaW5nJyk7XHJcbiAgICBjb25zdCBjaGlsZCA9IHRoaXMuY2hpbGQ7XHJcbiAgICB0aGlzLmNoaWxkID0gbnVsbDtcclxuICAgIHRoaXMuY3VycmVudEVuZHBvaW50ID0gbnVsbDtcclxuICAgIGlmICghY2hpbGQpIHtcclxuICAgICAgdGhpcy5zZXRTdGF0ZSgnc3RvcHBlZCcpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCBleGl0ZWQgPSBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4ge1xyXG4gICAgICBpZiAoY2hpbGQuZXhpdENvZGUgIT09IG51bGwgfHwgY2hpbGQuc2lnbmFsQ29kZSAhPT0gbnVsbCkgcmVzb2x2ZSgpO1xyXG4gICAgICBlbHNlIHtcclxuICAgICAgICBjb25zdCB3ID0gKCk6IHZvaWQgPT4gcmVzb2x2ZSgpO1xyXG4gICAgICAgIHRoaXMuZXhpdFdhaXRlcnMucHVzaCh3KTtcclxuICAgICAgICBjaGlsZC5vbmNlKCdleGl0Jywgdyk7XHJcbiAgICAgIH1cclxuICAgIH0pO1xyXG4gICAgLy8gXHU1REYyXHU3N0U1XHU3QUVGXHU1M0UzXHU2MjREXHU1QzFEXHU4QkQ1IEhUVFAgXHU0RjE4XHU5NkM1XHU1MTczXHU5NUVEO1x1NjcyQVx1NzdFNVx1N0FFRlx1NTNFM1x1NzZGNFx1NjNBNVx1OEQ3MCBraWxsIFx1NTE1Q1x1NUU5NVxyXG4gICAgaWYgKHRoaXMubGFzdEVuZHBvaW50ICE9PSBudWxsKSB7XHJcbiAgICAgIHRyeSB7XHJcbiAgICAgICAgYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHt0aGlzLmxhc3RFbmRwb2ludH0vYXBpL2Rlc2t0b3Avc2h1dGRvd25gLCB7XHJcbiAgICAgICAgICBtZXRob2Q6ICdQT1NUJyxcclxuICAgICAgICAgIGhlYWRlcnM6IHsgJ3gtaG1oLWtleSc6IHRoaXMudG9rZW4gfSxcclxuICAgICAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCgxXzAwMCksXHJcbiAgICAgICAgfSk7XHJcbiAgICAgIH0gY2F0Y2gge1xyXG4gICAgICAgIC8vIGhvc3QgXHU1REYyXHU2QjdCXHU2MjE2XHU0RTBEXHU1RTk0XHU3QjU0Olx1OEQ3MCBraWxsIFx1NTE1Q1x1NUU5NVxyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgICBjb25zdCBncmFjZWZ1bCA9IGF3YWl0IFByb21pc2UucmFjZShbXHJcbiAgICAgIGV4aXRlZC50aGVuKCgpID0+IHRydWUpLFxyXG4gICAgICBuZXcgUHJvbWlzZTxib29sZWFuPigocmVzb2x2ZSkgPT4gc2V0VGltZW91dCgoKSA9PiByZXNvbHZlKGZhbHNlKSwgdGhpcy5vcHRzLmdyYWNlZnVsU2h1dGRvd25NcykpLFxyXG4gICAgXSk7XHJcbiAgICBpZiAoIWdyYWNlZnVsICYmIGNoaWxkLmV4aXRDb2RlID09PSBudWxsICYmIGNoaWxkLnNpZ25hbENvZGUgPT09IG51bGwpIHtcclxuICAgICAgY2hpbGQua2lsbCgpOyAvLyBcdTUzRUFcdTY3NDBcdTgxRUFcdTVERjFcdTYzMDFcdTY3MDlcdTc2ODRcdTUzRTVcdTY3QzQsXHU3RUREXHU0RTBEXHU2MzA5XHU4RkRCXHU3QTBCXHU1NDBEXHJcbiAgICB9XHJcbiAgICBhd2FpdCBleGl0ZWQuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcclxuICAgIHRoaXMuc2V0U3RhdGUoJ3N0b3BwZWQnKTtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgbGFzdEVuZHBvaW50OiBudW1iZXIgfCBudWxsID0gbnVsbDtcclxuICBwcml2YXRlIGN1cnJlbnRFbmRwb2ludDogeyBwb3J0OiBudW1iZXI7IHZlcnNpb246IHN0cmluZyB9IHwgbnVsbCA9IG51bGw7XHJcblxyXG4gIC8qKiBcdTVGNTNcdTUyNEQgaG9zdCBcdTdBRUZcdTcwQjkocmVhZHkgXHU1NDBFXHU2NzA5XHU1MDNDO1x1NEUwRFx1NTQyQiB0b2tlbilcdTMwMDIgKi9cclxuICBnZXQgZW5kcG9pbnQoKTogeyBwb3J0OiBudW1iZXI7IHZlcnNpb246IHN0cmluZyB9IHwgbnVsbCB7XHJcbiAgICByZXR1cm4gdGhpcy5jdXJyZW50RW5kcG9pbnQ7XHJcbiAgfVxyXG5cclxuICAvKiogXHU2M0EyXHU2RDRCXHU2MjEwXHU1MjlGXHU1NDBFXHU4QkIwXHU0RjRGXHU3QUVGXHU1M0UzLFx1NEY5QiBzdG9wKCkgXHU3Njg0XHU0RjE4XHU5NkM1XHU1MTczXHU5NUVEXHU0RjdGXHU3NTI4XHUzMDAyICovXHJcbiAgcHJpdmF0ZSBhc3luYyBwcm9iZUFuZFJlbWVtYmVyKHBvcnQ6IG51bWJlciwgdmVyc2lvbjogc3RyaW5nKTogUHJvbWlzZTxIb3N0RW5kcG9pbnQ+IHtcclxuICAgIGNvbnN0IGVwID0gYXdhaXQgdGhpcy5wcm9iZShwb3J0LCB2ZXJzaW9uKTtcclxuICAgIHRoaXMubGFzdEVuZHBvaW50ID0gZXAucG9ydDtcclxuICAgIHJldHVybiBlcDtcclxuICB9XHJcbn1cclxuXHJcbi8qKiBcdTYyOEFcdTY3MkFcdTc3RTVcdTk1MTlcdThCRUZcdTg5QzRcdTdFQTZcdTRFM0EgRGVza3RvcEVycm9yKFx1NURGMlx1NjYyRlx1NTIxOVx1NTM5Rlx1NjgzN1x1OEZENFx1NTZERSlcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHRvRGVza3RvcEVycm9yKGVycjogdW5rbm93bik6IERlc2t0b3BFcnJvciB7XHJcbiAgaWYgKGlzRGVza3RvcEVycm9yKGVycikpIHJldHVybiBlcnI7XHJcbiAgY29uc3QgbWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcclxuICByZXR1cm4gZGVza3RvcEVycm9yKCdSVU5USU1FX0NSQVNIRUQnLCBtZXNzYWdlLnNsaWNlKDAsIDMwMCksIHsgcmV0cnlhYmxlOiBmYWxzZSB9KTtcclxufVxyXG4iLCAiLyoqXHJcbiAqIEBobWgtZGVza3RvcC9jb250cmFjdHMgXHUyMDE0IFx1NEU4Qlx1NEVGNlx1NEZFMVx1NUMwMShcdTVGMDBcdTUzRDFcdThCQTFcdTUyMTJcdTY1ODdcdTY4NjMgMDQgXHUwMEE3XHU0RTA5KVxyXG4gKlxyXG4gKiBcdTRFMDBcdTY3NjEgVUkgXHU0RThCXHU0RUY2XHU3Njg0XHU1NTJGXHU0RTAwXHU1RjYyXHU3MkI2XHUzMDAyXHU1MjREXHU3QUVGIHJlZHVjZXIgXHU1RkM1XHU5ODdCXHU2MzA5IHNlc3Npb25JZC9ydW5JZC9zZXEgXHU1OTA0XHU3NDA2O1xyXG4gKiBcdTkxQ0RcdTU5MEQgZXZlbnRJZCBcdTVFNDJcdTdCNDlcdTRFMjJcdTVGMDM7c2VxIFx1N0YzQVx1NTNFM1x1ODlFNlx1NTNEMVx1ODg2NVx1NjJDOTtcdTk3NUVcdTVFNDJcdTdCNDlcdTUyQThcdTRGNUNcdTRFMERcdTc1MzEgU1NFIFx1ODFFQVx1NTJBOFx1OTFDRFx1NTNEMVx1MzAwMlxyXG4gKi9cclxuXHJcbmltcG9ydCB0eXBlIHsgQXJ0aWZhY3RSZWYgfSBmcm9tICcuL2R0by50cyc7XHJcbmltcG9ydCB0eXBlIHsgRGVza3RvcEVycm9yIH0gZnJvbSAnLi9lcnJvci50cyc7XHJcblxyXG4vKiogXHU0RThCXHU0RUY2XHU3OUNEXHU3QzdCKFx1NTIyNFx1NTIyQlx1OTUyRSlcdTMwMDJcdTY1QjBcdTU4OUUga2luZCA9IHNjaGVtYVZlcnNpb24gXHU1MzQ3XHU3RUE3LFx1NEUwRFx1NTE0MVx1OEJCOFx1OTc1OVx1OUVEOFx1NjI2OVx1Njc5QVx1NEUzRVx1MzAwMiAqL1xyXG5leHBvcnQgY29uc3QgRVZFTlRfS0lORFMgPSBbXHJcbiAgJ3J1bi5zdGFydGVkJyxcclxuICAncGxhbi51cGRhdGVkJyxcclxuICAndG9vbC5zdGFydGVkJyxcclxuICAndG9vbC5jb21wbGV0ZWQnLFxyXG4gICdhcHByb3ZhbC5yZXF1aXJlZCcsXHJcbiAgJ3ZlcmlmaWNhdGlvbi51cGRhdGVkJyxcclxuICAnYXJ0aWZhY3QuY3JlYXRlZCcsXHJcbiAgJ3J1bi5jb21wbGV0ZWQnLFxyXG4gICdydW4uZmFpbGVkJyxcclxuXSBhcyBjb25zdDtcclxuXHJcbmV4cG9ydCB0eXBlIEV2ZW50S2luZCA9ICh0eXBlb2YgRVZFTlRfS0lORFMpW251bWJlcl07XHJcblxyXG5leHBvcnQgY29uc3QgRVZFTlRfU0NIRU1BX1ZFUlNJT04gPSAxO1xyXG5leHBvcnQgdHlwZSBFdmVudFNjaGVtYVZlcnNpb24gPSAxO1xyXG5cclxuLyoqIFNTRSBcdTZENDFcdTRFMEFcdTc2ODRcdTZCQ0ZcdTRFMDBcdTY3NjFcdTRFOEJcdTRFRjZcdTMwMDIgKi9cclxuZXhwb3J0IGludGVyZmFjZSBFdmVudEVudmVsb3BlPFQgPSB1bmtub3duPiB7XHJcbiAgc2NoZW1hVmVyc2lvbjogRXZlbnRTY2hlbWFWZXJzaW9uO1xyXG4gIC8qKiBcdTUxNjhcdTVDNDBcdTU1MkZcdTRFMDA7XHU5MUNEXHU4RkRFL1x1ODg2NVx1NjJDOVx1NTQwRVx1OTFDRFx1NTkwRFx1NTFGQVx1NzNCMFx1NjVGNlx1NjNBNVx1NjUzNlx1NjVCOVx1NUU0Mlx1N0I0OVx1NEUyMlx1NUYwM1x1MzAwMiAqL1xyXG4gIGV2ZW50SWQ6IHN0cmluZztcclxuICBzZXNzaW9uSWQ6IHN0cmluZztcclxuICBydW5JZDogc3RyaW5nO1xyXG4gIC8qKiBcdTRGMUFcdThCRERcdTUxODVcdTUzNTVcdThDMDNcdTkwMTJcdTU4OUU7XHU3RjNBXHU1M0UzXHU2MTBGXHU1NDczXHU3NzQwXHU0RTIyXHU0RThCXHU0RUY2LFx1OTcwMFx1ODk4MVx1ODg2NVx1NjJDOVx1MzAwMiAqL1xyXG4gIHNlcTogbnVtYmVyO1xyXG4gIC8qKiBSRkMzMzM5XHUzMDAyICovXHJcbiAgb2NjdXJyZWRBdDogc3RyaW5nO1xyXG4gIGtpbmQ6IEV2ZW50S2luZDtcclxuICBwYXlsb2FkOiBUO1xyXG59XHJcblxyXG4vKiogcnVuLnN0YXJ0ZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cclxuZXhwb3J0IGludGVyZmFjZSBSdW5TdGFydGVkUGF5bG9hZCB7XHJcbiAgdGFzazogc3RyaW5nO1xyXG4gIG1vZGU6ICdhc2snIHwgJ2F1dG8nIHwgJ3lvbG8nO1xyXG59XHJcblxyXG4vKiogcGxhbi51cGRhdGVkIFx1NzY4NCBwYXlsb2FkKFx1OEJBMVx1NTIxMlx1NkI2NVx1OUFBNFx1NTIxN1x1ODg2OCxcdTY3NjVcdTgxRUEgcnVudGltZSBcdTc2ODRcdTdFRDNcdTY3ODRcdTUzMTZcdThCQTFcdTUyMTIsXHU0RTBEXHU2NjJGIGNoYWluLW9mLXRob3VnaHQpXHUzMDAyICovXHJcbmV4cG9ydCBpbnRlcmZhY2UgUGxhblVwZGF0ZWRQYXlsb2FkIHtcclxuICBzdGVwczogQXJyYXk8eyB0aXRsZTogc3RyaW5nOyBzdGF0dXM6ICdwZW5kaW5nJyB8ICdhY3RpdmUnIHwgJ2RvbmUnIHwgJ2ZhaWxlZCcgfT47XHJcbn1cclxuXHJcbi8qKiB0b29sLnN0YXJ0ZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cclxuZXhwb3J0IGludGVyZmFjZSBUb29sU3RhcnRlZFBheWxvYWQge1xyXG4gIG5hbWU6IHN0cmluZztcclxuICAvKiogXHU1M0MyXHU2NTcwXHU0RUU1XHU2NTg3XHU2NzJDXHU1NDQ4XHU3M0IwLFx1NkUzMlx1NjdEM1x1N0FFRlx1NkMzOFx1NEUwRCBldmFsO1x1NTkyN1x1NUJGOVx1OEM2MVx1NzUzMSBydW50aW1lIFx1NjIyQVx1NjVBRFx1MzAwMiAqL1xyXG4gIGFyZ3NQcmV2aWV3OiBzdHJpbmc7XHJcbn1cclxuXHJcbi8qKiB0b29sLmNvbXBsZXRlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xyXG5leHBvcnQgaW50ZXJmYWNlIFRvb2xDb21wbGV0ZWRQYXlsb2FkIHtcclxuICBuYW1lOiBzdHJpbmc7XHJcbiAgaXNFcnJvcjogYm9vbGVhbjtcclxuICBvdXRwdXRQcmV2aWV3OiBzdHJpbmc7XHJcbn1cclxuXHJcbi8qKiBhcHByb3ZhbC5yZXF1aXJlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMlx1NUJBMVx1NjI3OVx1Njc0M1x1NUEwMVx1NTcyOCBydW50aW1lIFx1NTQwRVx1N0FFRjtVSSBcdTUzRUFcdTY2MkZcdThGNkNcdThGRjBcdTMwMDIgKi9cclxuZXhwb3J0IGludGVyZmFjZSBBcHByb3ZhbFJlcXVpcmVkUGF5bG9hZCB7XHJcbiAgYXBwcm92YWxJZDogc3RyaW5nO1xyXG4gIHRvb2w6IHN0cmluZztcclxuICBhcmdzUHJldmlldzogc3RyaW5nO1xyXG4gIC8qKiBcdTVGNzFcdTU0Q0RcdTgzMDNcdTU2RjQvXHU5OENFXHU5NjY5XHU3Njg0XHU0RUJBXHU3QzdCXHU1M0VGXHU4QkZCXHU4QkY0XHU2NjBFLFx1NzUzMSBydW50aW1lIFx1NzUxRlx1NjIxMFx1MzAwMiAqL1xyXG4gIHJpc2s6IHN0cmluZztcclxufVxyXG5cclxuLyoqIHZlcmlmaWNhdGlvbi51cGRhdGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXHJcbmV4cG9ydCBpbnRlcmZhY2UgVmVyaWZpY2F0aW9uVXBkYXRlZFBheWxvYWQge1xyXG4gIHN1bW1hcnk6IHN0cmluZztcclxuICBwYXNzZWQ6IGJvb2xlYW4gfCBudWxsOyAvLyBudWxsID0gXHU2NzJBXHU3N0U1L1x1OEZEQlx1ODg0Q1x1NEUyRChORUVEUy1EQVRBIFx1NjVGNlx1NEUwRFx1NTA0N1x1NTg2QilcclxufVxyXG5cclxuLyoqIGFydGlmYWN0LmNyZWF0ZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cclxuZXhwb3J0IGludGVyZmFjZSBBcnRpZmFjdENyZWF0ZWRQYXlsb2FkIHtcclxuICBhcnRpZmFjdDogQXJ0aWZhY3RSZWY7XHJcbn1cclxuXHJcbi8qKiBydW4uY29tcGxldGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXHJcbmV4cG9ydCBpbnRlcmZhY2UgUnVuQ29tcGxldGVkUGF5bG9hZCB7XHJcbiAgdGV4dDogc3RyaW5nO1xyXG4gIHR1cm5zOiBudW1iZXI7XHJcbiAgdG9vbFVzZXM6IG51bWJlcjtcclxuICB1c2FnZT86IHsgcHJvbXB0VG9rZW5zOiBudW1iZXI7IGNvbXBsZXRpb25Ub2tlbnM6IG51bWJlciB9O1xyXG59XHJcblxyXG4vKiogcnVuLmZhaWxlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xyXG5leHBvcnQgaW50ZXJmYWNlIFJ1bkZhaWxlZFBheWxvYWQge1xyXG4gIGVycm9yOiBEZXNrdG9wRXJyb3I7XHJcbn1cclxuIiwgIi8qKlxyXG4gKiBAaG1oLWRlc2t0b3AvY29udHJhY3RzIFx1MjAxNCBcdTdFRDNcdTY3ODRcdTUzMTZcdTY4NENcdTk3NjJcdTk1MTlcdThCRUYoXHU1RjAwXHU1M0QxXHU4QkExXHU1MjEyXHU2NTg3XHU2ODYzIDA0IFx1MDBBN1x1NEUwOSlcdTMwMDJcclxuICpcclxuICogaG9zdC1ub3QtcmVhZHkgLyBhdXRoLWZhaWxlZCAvIHN0YWxlLXZlcnNpb24gLyBydW50aW1lLWNyYXNoZWQgL1xyXG4gKiBwb3J0LWJpbmQtZmFpbGVkIC8gc2NoZW1hLW1pc21hdGNoIFx1NUZDNVx1OTg3Qlx1NjYyRlx1N0VEM1x1Njc4NFx1NTMxNlx1OTUxOVx1OEJFRlx1NzgwMSxcdTVFNzZcdTYzRDBcdTRGOUJcdTRFMEJcdTRFMDBcdTZCNjVcdTUyQThcdTRGNUNcdTMwMDJcclxuICogbWVzc2FnZSBcdTY2MkZcdTdFQUZcdTY1ODdcdTY3MkMsXHU2RTMyXHU2N0QzXHU3QUVGXHU2QzM4XHU0RTBEXHU2MjhBXHU1QjgzXHU1RjUzIEhUTUxcdTMwMDJcclxuICovXHJcbmV4cG9ydCBjb25zdCBFUlJPUl9DT0RFUyA9IFtcclxuICAnSE9TVF9OT1RfUkVBRFknLFxyXG4gICdBVVRIX0ZBSUxFRCcsXHJcbiAgJ1JVTlRJTUVfQ1JBU0hFRCcsXHJcbiAgJ1BPUlRfQklORF9GQUlMRUQnLFxyXG4gICdTVEFMRV9WRVJTSU9OJyxcclxuICAnU0NIRU1BX01JU01BVENIJyxcclxuXSBhcyBjb25zdDtcclxuXHJcbmV4cG9ydCB0eXBlIEVycm9yQ29kZSA9ICh0eXBlb2YgRVJST1JfQ09ERVMpW251bWJlcl07XHJcblxyXG5leHBvcnQgY29uc3QgUkVDT1ZFUllfQUNUSU9OUyA9IFsnUkVDT05ORUNUJywgJ1JFU1VNRScsICdFWFBPUlQnLCAnT1BFTl9MT0dTJ10gYXMgY29uc3Q7XHJcbmV4cG9ydCB0eXBlIFJlY292ZXJ5QWN0aW9uID0gKHR5cGVvZiBSRUNPVkVSWV9BQ1RJT05TKVtudW1iZXJdO1xyXG5cclxuZXhwb3J0IGludGVyZmFjZSBEZXNrdG9wRXJyb3Ige1xyXG4gIGNvZGU6IEVycm9yQ29kZTtcclxuICAvKiogXHU3RUFGXHU2NTg3XHU2NzJDLFx1NkMzOFx1NEUwRFx1NEZFMVx1NEVGQlx1NEUzQSBIVE1MXHUzMDAyICovXHJcbiAgbWVzc2FnZTogc3RyaW5nO1xyXG4gIHJldHJ5YWJsZTogYm9vbGVhbjtcclxuICBzZXNzaW9uSWQ/OiBzdHJpbmc7XHJcbiAgcnVuSWQ/OiBzdHJpbmc7XHJcbiAgcmVjb3ZlcnlBY3Rpb24/OiBSZWNvdmVyeUFjdGlvbjtcclxufVxyXG5cclxuLyoqIFx1Njc4NFx1OTAyMFx1NEUwMFx1NEUyQSBEZXNrdG9wRXJyb3IoZXhhY3RPcHRpb25hbFByb3BlcnR5VHlwZXMgXHU1M0NCXHU1OTdEKVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gZGVza3RvcEVycm9yKFxyXG4gIGNvZGU6IEVycm9yQ29kZSxcclxuICBtZXNzYWdlOiBzdHJpbmcsXHJcbiAgb3B0czogeyByZXRyeWFibGU/OiBib29sZWFuOyBzZXNzaW9uSWQ/OiBzdHJpbmc7IHJ1bklkPzogc3RyaW5nOyByZWNvdmVyeUFjdGlvbj86IFJlY292ZXJ5QWN0aW9uIH0gPSB7fSxcclxuKTogRGVza3RvcEVycm9yIHtcclxuICBjb25zdCBlOiBEZXNrdG9wRXJyb3IgPSB7IGNvZGUsIG1lc3NhZ2UsIHJldHJ5YWJsZTogb3B0cy5yZXRyeWFibGUgPT09IHRydWUgfTtcclxuICBpZiAob3B0cy5zZXNzaW9uSWQgIT09IHVuZGVmaW5lZCkgZS5zZXNzaW9uSWQgPSBvcHRzLnNlc3Npb25JZDtcclxuICBpZiAob3B0cy5ydW5JZCAhPT0gdW5kZWZpbmVkKSBlLnJ1bklkID0gb3B0cy5ydW5JZDtcclxuICBpZiAob3B0cy5yZWNvdmVyeUFjdGlvbiAhPT0gdW5kZWZpbmVkKSBlLnJlY292ZXJ5QWN0aW9uID0gb3B0cy5yZWNvdmVyeUFjdGlvbjtcclxuICByZXR1cm4gZTtcclxufVxyXG4iLCAiLyoqXHJcbiAqIEBobWgtZGVza3RvcC9jb250cmFjdHMgXHUyMDE0IHJ1bnRpbWUgXHU2ODIxXHU5QThDKGd1YXJkcylcdTMwMDJcclxuICpcclxuICogXHU2QkNGXHU0RTJBXHU4REU4XHU0RkUxXHU0RUZCXHU4RkI5XHU3NTRDXHU3Njg0XHU2NTcwXHU2MzZFKHJ1bnRpbWVcdTIxOTJyZW5kZXJlclx1MzAwMWhvc3RcdTIxOTJtYWluKVx1OEZEQlx1NTE2NVx1NTI0RFx1NTE0OFx1OEZDNyBndWFyZDtcclxuICogXHU2ODIxXHU5QThDXHU1OTMxXHU4RDI1XHU3Njg0XHU2NTcwXHU2MzZFXHU2MzA5IFNDSEVNQV9NSVNNQVRDSCBcdTdFRDNcdTY3ODRcdTUzMTZcdTk1MTlcdThCRUZcdTU5MDRcdTc0MDYsXHU0RTBEXHU5NzU5XHU5RUQ4XHU2M0E1XHU1M0Q3XHUzMDAyXHJcbiAqIFx1NjI0Qlx1NTE5OVx1NUI4OFx1NTM2Qlx1ODAwQ1x1NEUwRFx1NjYyRlx1NUYxNVx1N0IyQ1x1NEUwOVx1NjVCOSBzY2hlbWEgXHU1RTkzOlx1NTk1MVx1N0VBNlx1OTc2Mlx1NUMwRixcdTk2RjZcdTRGOURcdThENTZcdTY1ODdcdTUzMTYoaG1oYXJuZXNzIFx1NTQwQ1x1NkU5MClcdTMwMDJcclxuICovXHJcbmltcG9ydCB7XHJcbiAgRVZFTlRfS0lORFMsXHJcbiAgRVZFTlRfU0NIRU1BX1ZFUlNJT04sXHJcbiAgdHlwZSBFdmVudEVudmVsb3BlLFxyXG4gIHR5cGUgRXZlbnRLaW5kLFxyXG59IGZyb20gJy4vZXZlbnQudHMnO1xyXG5pbXBvcnQgeyBFUlJPUl9DT0RFUywgUkVDT1ZFUllfQUNUSU9OUywgdHlwZSBEZXNrdG9wRXJyb3IgfSBmcm9tICcuL2Vycm9yLnRzJztcclxuaW1wb3J0IHsgUlVOX1NUQVRVU0VTLCB0eXBlIFJ1blN0YXR1cyB9IGZyb20gJy4vZHRvLnRzJztcclxuXHJcbmNvbnN0IGlzUmVjb3JkID0gKHY6IHVua25vd24pOiB2IGlzIFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0+XHJcbiAgdHlwZW9mIHYgPT09ICdvYmplY3QnICYmIHYgIT09IG51bGwgJiYgIUFycmF5LmlzQXJyYXkodik7XHJcblxyXG5jb25zdCBpc05vbkVtcHR5U3RyaW5nID0gKHY6IHVua25vd24pOiB2IGlzIHN0cmluZyA9PiB0eXBlb2YgdiA9PT0gJ3N0cmluZycgJiYgdi5sZW5ndGggPiAwO1xyXG5cclxuY29uc3QgaXNSZmMzMzM5ID0gKHY6IHN0cmluZyk6IGJvb2xlYW4gPT4ge1xyXG4gIGNvbnN0IHQgPSBEYXRlLnBhcnNlKHYpO1xyXG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUodCkgJiYgL1xcZHs0fS1cXGR7Mn0tXFxkezJ9VC8udGVzdCh2KTtcclxufTtcclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpc0V2ZW50RW52ZWxvcGUodjogdW5rbm93bik6IHYgaXMgRXZlbnRFbnZlbG9wZSB7XHJcbiAgaWYgKCFpc1JlY29yZCh2KSkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICh2LnNjaGVtYVZlcnNpb24gIT09IEVWRU5UX1NDSEVNQV9WRVJTSU9OKSByZXR1cm4gZmFsc2U7XHJcbiAgaWYgKCFpc05vbkVtcHR5U3RyaW5nKHYuZXZlbnRJZCkpIHJldHVybiBmYWxzZTtcclxuICBpZiAoIWlzTm9uRW1wdHlTdHJpbmcodi5zZXNzaW9uSWQpKSByZXR1cm4gZmFsc2U7XHJcbiAgaWYgKCFpc05vbkVtcHR5U3RyaW5nKHYucnVuSWQpKSByZXR1cm4gZmFsc2U7XHJcbiAgaWYgKHR5cGVvZiB2LnNlcSAhPT0gJ251bWJlcicgfHwgIU51bWJlci5pc0ludGVnZXIodi5zZXEpIHx8IHYuc2VxIDwgMCkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICghaXNOb25FbXB0eVN0cmluZyh2Lm9jY3VycmVkQXQpIHx8ICFpc1JmYzMzMzkodi5vY2N1cnJlZEF0KSkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICghRVZFTlRfS0lORFMuaW5jbHVkZXModi5raW5kIGFzIEV2ZW50S2luZCkpIHJldHVybiBmYWxzZTtcclxuICByZXR1cm4gaXNSZWNvcmQodi5wYXlsb2FkKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGlzRGVza3RvcEVycm9yKHY6IHVua25vd24pOiB2IGlzIERlc2t0b3BFcnJvciB7XHJcbiAgaWYgKCFpc1JlY29yZCh2KSkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICghRVJST1JfQ09ERVMuaW5jbHVkZXModi5jb2RlIGFzIG5ldmVyKSkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICh0eXBlb2Ygdi5tZXNzYWdlICE9PSAnc3RyaW5nJykgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICh0eXBlb2Ygdi5yZXRyeWFibGUgIT09ICdib29sZWFuJykgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICh2LnNlc3Npb25JZCAhPT0gdW5kZWZpbmVkICYmICFpc05vbkVtcHR5U3RyaW5nKHYuc2Vzc2lvbklkKSkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICh2LnJ1bklkICE9PSB1bmRlZmluZWQgJiYgIWlzTm9uRW1wdHlTdHJpbmcodi5ydW5JZCkpIHJldHVybiBmYWxzZTtcclxuICBpZiAodi5yZWNvdmVyeUFjdGlvbiAhPT0gdW5kZWZpbmVkICYmICFSRUNPVkVSWV9BQ1RJT05TLmluY2x1ZGVzKHYucmVjb3ZlcnlBY3Rpb24gYXMgbmV2ZXIpKSByZXR1cm4gZmFsc2U7XHJcbiAgcmV0dXJuIHRydWU7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpc1J1blN0YXR1cyh2OiB1bmtub3duKTogdiBpcyBSdW5TdGF0dXMge1xyXG4gIHJldHVybiB0eXBlb2YgdiA9PT0gJ3N0cmluZycgJiYgUlVOX1NUQVRVU0VTLmluY2x1ZGVzKHYgYXMgUnVuU3RhdHVzKTtcclxufVxyXG5cclxuLyoqIEhvc3QgXHU1RjE1XHU1QkZDXHU4ODRDKHN0ZG91dCBcdTdCMkNcdTRFMDBcdTg4NEMpXHUzMDAyICovXHJcbmV4cG9ydCBmdW5jdGlvbiBpc0hvc3RSZWFkeUxpbmUodjogdW5rbm93bik6IHYgaXMgeyBobWhEZXNrdG9wSG9zdFJlYWR5OiB0cnVlOyBwb3J0OiBudW1iZXI7IHZlcnNpb246IHN0cmluZyB9IHtcclxuICBpZiAoIWlzUmVjb3JkKHYpKSByZXR1cm4gZmFsc2U7XHJcbiAgaWYgKHYuaG1oRGVza3RvcEhvc3RSZWFkeSAhPT0gdHJ1ZSkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICh0eXBlb2Ygdi5wb3J0ICE9PSAnbnVtYmVyJyB8fCAhTnVtYmVyLmlzSW50ZWdlcih2LnBvcnQpIHx8IHYucG9ydCA8PSAwIHx8IHYucG9ydCA+IDY1NTM1KSByZXR1cm4gZmFsc2U7XHJcbiAgcmV0dXJuIGlzTm9uRW1wdHlTdHJpbmcodi52ZXJzaW9uKTtcclxufVxyXG4iLCAiLyoqXHJcbiAqIERlc2t0b3BIb3N0Q2xpZW50IFx1MjAxNCBcdTVCRjkgaG1oIGhvc3QgXHU3Njg0IEhUVFArU1NFIFx1NUJBMlx1NjIzN1x1N0FFRlx1MzAwMlxyXG4gKlxyXG4gKiAtIFx1NkJDRlx1NEUyQSBIVFRQIFx1OEJGN1x1NkM0Mlx1ODFFQVx1NTJBOFx1NUUyNiBYLUhtaC1LZXkodG9rZW4gXHU0RTBEXHU4RkRCIFVSTCk7XHJcbiAqIC0gXHU3RUQzXHU2Nzg0XHU1MzE2XHU5NTE5XHU4QkVGKHJlcy5ib2R5IFx1OTFDQ1x1NzY4NCBEZXNrdG9wRXJyb3IgXHU1RjYyXHU3MkI2XHU2MjE2IEhUVFAgXHU3MkI2XHU2MDAxKVx1ODlDNFx1N0VBNlx1NjIxMFx1NUYwMlx1NUUzOFx1NjI5Qlx1NTFGQTtcclxuICogLSBTU0UgXHU3NTI4IGZldGNoIFx1NkQ0MVx1NjI0Qlx1NTE5OVx1ODlFM1x1Njc5MChpZC9ldmVudC9kYXRhIFx1NUUyNyksXHU2NTJGXHU2MzAxIExhc3QtRXZlbnQtSUQgXHU4ODY1XHU2MkM5XHU5MUNEXHU4RkRFXHUzMDAyXHJcbiAqL1xyXG5pbXBvcnQgeyBkZXNrdG9wRXJyb3IsIGlzRGVza3RvcEVycm9yLCBpc0V2ZW50RW52ZWxvcGUsIHR5cGUgRGVza3RvcEVycm9yLCB0eXBlIEV2ZW50RW52ZWxvcGUgfSBmcm9tICdAaG1oLWRlc2t0b3AvY29udHJhY3RzJztcclxuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gJ25vZGU6Y3J5cHRvJztcclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgU3NlRnJhbWUge1xyXG4gIGlkPzogc3RyaW5nO1xyXG4gIGV2ZW50OiBzdHJpbmc7XHJcbiAgZGF0YTogc3RyaW5nO1xyXG59XHJcblxyXG4vKiogXHU4OUUzXHU2NzkwXHU0RTAwXHU2QkI1IFNTRSBcdTY1ODdcdTY3MkNcdTRFM0FcdTVFMjcoXHU0RTBEXHU1NDJCXHU4REU4IGNodW5rIFx1NzY4NFx1N0YxM1x1NTFCMlx1OTAzQlx1OEY5MSxcdTdFQUZcdTUxRkRcdTY1NzBcdTRGQkZcdTRFOEVcdTZENEJcdThCRDUpXHUzMDAyICovXHJcbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVNzZUNodW5rKGNodW5rOiBzdHJpbmcpOiBTc2VGcmFtZVtdIHtcclxuICBjb25zdCBmcmFtZXM6IFNzZUZyYW1lW10gPSBbXTtcclxuICBmb3IgKGNvbnN0IGJsb2NrIG9mIGNodW5rLnNwbGl0KC9cXG5cXG4vKSkge1xyXG4gICAgaWYgKCFibG9jay50cmltKCkpIGNvbnRpbnVlO1xyXG4gICAgbGV0IGlkOiBzdHJpbmcgfCB1bmRlZmluZWQ7XHJcbiAgICBsZXQgZXZlbnQgPSAnbWVzc2FnZSc7XHJcbiAgICBjb25zdCBkYXRhTGluZXM6IHN0cmluZ1tdID0gW107XHJcbiAgICBsZXQgc2F3RmllbGQgPSBmYWxzZTtcclxuICAgIGZvciAoY29uc3QgbGluZSBvZiBibG9jay5zcGxpdCgnXFxuJykpIHtcclxuICAgICAgaWYgKGxpbmUuc3RhcnRzV2l0aCgnOicpKSBjb250aW51ZTsgLy8gXHU2Q0U4XHU5MUNBL1x1NUZDM1x1OERGM1xyXG4gICAgICBpZiAobGluZS5zdGFydHNXaXRoKCdpZDonKSkgeyBpZCA9IGxpbmUuc2xpY2UoMykudHJpbSgpOyBzYXdGaWVsZCA9IHRydWU7IH1cclxuICAgICAgZWxzZSBpZiAobGluZS5zdGFydHNXaXRoKCdldmVudDonKSkgeyBldmVudCA9IGxpbmUuc2xpY2UoNikudHJpbSgpOyBzYXdGaWVsZCA9IHRydWU7IH1cclxuICAgICAgZWxzZSBpZiAobGluZS5zdGFydHNXaXRoKCdkYXRhOicpKSB7IGRhdGFMaW5lcy5wdXNoKGxpbmUuc2xpY2UoNSkucmVwbGFjZSgvXiAvLCAnJykpOyBzYXdGaWVsZCA9IHRydWU7IH1cclxuICAgIH1cclxuICAgIGlmICghc2F3RmllbGQpIGNvbnRpbnVlOyAvLyBcdTdFQUZcdTZDRThcdTkxQ0EvXHU1RkMzXHU4REYzXHU1NzU3XHU0RTBEXHU0RUE3XHU3NTFGXHU1RTI3XHJcbiAgICBmcmFtZXMucHVzaCh7IC4uLihpZCAhPT0gdW5kZWZpbmVkID8geyBpZCB9IDoge30pLCBldmVudCwgZGF0YTogZGF0YUxpbmVzLmpvaW4oJ1xcbicpIH0pO1xyXG4gIH1cclxuICByZXR1cm4gZnJhbWVzO1xyXG59XHJcblxyXG4vKiogXHU0RUNFIFNTRSBcdTVFMjdcdTY1NzBcdTYzNkVcdTRFMkRcdTg5RTNcdTUxRkFcdTU0MDhcdTZDRDUgRXZlbnRFbnZlbG9wZTtcdTRFMERcdTU0MDhcdTZDRDVcdTc2ODRcdThGRDRcdTU2REUgbnVsbChTQ0hFTUFfTUlTTUFUQ0ggXHU3NTMxXHU4QzAzXHU3NTI4XHU2NUI5XHU4QkExXHU2NTcwKVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gZW52ZWxvcGVGcm9tRnJhbWUoZnJhbWU6IFNzZUZyYW1lKTogRXZlbnRFbnZlbG9wZSB8IG51bGwge1xyXG4gIGlmIChmcmFtZS5ldmVudCAhPT0gJ2htaCcpIHJldHVybiBudWxsOyAvLyBcdTYyMTFcdTRFRUNcdTc2ODRcdTRFOEJcdTRFRjZcdTRGRTFcdTVDMDFcdTdFREZcdTRFMDBcdThENzAgZXZlbnQ6IGhtaFxyXG4gIHRyeSB7XHJcbiAgICBjb25zdCBwYXJzZWQ6IHVua25vd24gPSBKU09OLnBhcnNlKGZyYW1lLmRhdGEpO1xyXG4gICAgcmV0dXJuIGlzRXZlbnRFbnZlbG9wZShwYXJzZWQpID8gcGFyc2VkIDogbnVsbDtcclxuICB9IGNhdGNoIHtcclxuICAgIHJldHVybiBudWxsO1xyXG4gIH1cclxufVxyXG5cclxuZXhwb3J0IGNsYXNzIERlc2t0b3BIdHRwRXJyb3IgZXh0ZW5kcyBFcnJvciB7XHJcbiAgY29uc3RydWN0b3IocHVibGljIHJlYWRvbmx5IGRldGFpbDogRGVza3RvcEVycm9yKSB7XHJcbiAgICBzdXBlcihkZXRhaWwubWVzc2FnZSk7XHJcbiAgfVxyXG59XHJcblxyXG5leHBvcnQgY2xhc3MgRGVza3RvcEhvc3RDbGllbnQge1xyXG4gIGNvbnN0cnVjdG9yKFxyXG4gICAgcHJpdmF0ZSByZWFkb25seSBiYXNlVXJsOiBzdHJpbmcsXHJcbiAgICBwcml2YXRlIHJlYWRvbmx5IHRva2VuOiBzdHJpbmcsXHJcbiAgKSB7fVxyXG5cclxuICBwcml2YXRlIGhlYWRlcnMoZXh0cmE6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fSk6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4ge1xyXG4gICAgcmV0dXJuIHsgJ3gtaG1oLWtleSc6IHRoaXMudG9rZW4sIC4uLmV4dHJhIH07XHJcbiAgfVxyXG5cclxuICBhc3luYyBnZXRKc29uPFQ+KHBhdGg6IHN0cmluZywgdGltZW91dE1zID0gNV8wMDApOiBQcm9taXNlPFQ+IHtcclxuICAgIGxldCByZXM6IFJlc3BvbnNlO1xyXG4gICAgdHJ5IHtcclxuICAgICAgcmVzID0gYXdhaXQgZmV0Y2goYCR7dGhpcy5iYXNlVXJsfSR7cGF0aH1gLCB7IGhlYWRlcnM6IHRoaXMuaGVhZGVycygpLCBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQodGltZW91dE1zKSB9KTtcclxuICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYHJlcXVlc3QgZmFpbGVkOiAke1N0cmluZyhlcnIpLnNsaWNlKDAsIDE2MCl9YCwgeyByZXRyeWFibGU6IHRydWUsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gdGhpcy5wYXJzZVJlc3BvbnNlPFQ+KHJlcyk7XHJcbiAgfVxyXG5cclxuICAvKiogXHU2MkM5XHU1M0Q2XHU3RUFGXHU2NTg3XHU2NzJDXHU3QUVGXHU3MEI5KFx1NTk4MiAvYXBpL3Nlc3Npb25zLzppZC9leHBvcnQubWQpXHUzMDAyICovXHJcbiAgYXN5bmMgZ2V0VGV4dChwYXRoOiBzdHJpbmcsIHRpbWVvdXRNcyA9IDEwXzAwMCk6IFByb21pc2U8c3RyaW5nPiB7XHJcbiAgICBsZXQgcmVzOiBSZXNwb25zZTtcclxuICAgIHRyeSB7XHJcbiAgICAgIHJlcyA9IGF3YWl0IGZldGNoKGAke3RoaXMuYmFzZVVybH0ke3BhdGh9YCwgeyBoZWFkZXJzOiB0aGlzLmhlYWRlcnMoKSwgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KHRpbWVvdXRNcykgfSk7XHJcbiAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGByZXF1ZXN0IGZhaWxlZDogJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxNjApfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSB8fCByZXMuc3RhdHVzID09PSA0MDMpIHtcclxuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdBVVRIX0ZBSUxFRCcsIGBob3N0IHJlamVjdGVkIHRoZSBzZXNzaW9uIHRva2VuIChIVFRQICR7cmVzLnN0YXR1c30pYCwgeyByZXRyeWFibGU6IGZhbHNlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xyXG4gICAgfVxyXG4gICAgaWYgKCFyZXMub2spIHtcclxuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBIVFRQICR7cmVzLnN0YXR1c31gLCB7IHJldHJ5YWJsZTogcmVzLnN0YXR1cyA+PSA1MDAgfSkpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHJlcy50ZXh0KCk7XHJcbiAgfVxyXG5cclxuICAvKiogXHU2QkNGXHU0RTJBXHU1RTI2XHU1MjZGXHU0RjVDXHU3NTI4XHU3Njg0IFBPU1QgXHU4MUVBXHU1MkE4XHU2NDNBXHU1RTI2XHU1RTQyXHU3QjQ5XHU5NTJFKDAzIFx1MDBBN1x1NTZEQlx1OTYzMlx1OTFDRFx1NjUzRTpcdThCRjdcdTZDNDJcdTRGN0ZcdTc1MjggaWRlbXBvdGVuY3lLZXk7XHJcbiAgICogIHJ1bnRpbWUgXHU0RkE3XHU3N0VEXHU2NzFGXHU1MTdDXHU1QkI5XHU1RkZEXHU3NTY1LFx1NTM0Rlx1OEJBRVx1NTE0OFx1ODg0Q1x1MjAxNFx1MjAxNFx1OTFDRFx1OEJENVx1NTNFRlx1NTFFRFx1OTUyRVx1NTNCQlx1OTFDRCxcdTRFMERcdTc2RjJcdTc2RUVcdTkxQ0RcdTY1M0UpXHUzMDAyICovXHJcbiAgYXN5bmMgcG9zdEpzb248VD4ocGF0aDogc3RyaW5nLCBib2R5OiB1bmtub3duLCB0aW1lb3V0TXMgPSAxMF8wMDApOiBQcm9taXNlPFQ+IHtcclxuICAgIGxldCByZXM6IFJlc3BvbnNlO1xyXG4gICAgdHJ5IHtcclxuICAgICAgcmVzID0gYXdhaXQgZmV0Y2goYCR7dGhpcy5iYXNlVXJsfSR7cGF0aH1gLCB7XHJcbiAgICAgICAgbWV0aG9kOiAnUE9TVCcsXHJcbiAgICAgICAgaGVhZGVyczogdGhpcy5oZWFkZXJzKHtcclxuICAgICAgICAgICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsXHJcbiAgICAgICAgICAneC1pZGVtcG90ZW5jeS1rZXknOiByYW5kb21VVUlEKCksXHJcbiAgICAgICAgfSksXHJcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoYm9keSksXHJcbiAgICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KHRpbWVvdXRNcyksXHJcbiAgICAgIH0pO1xyXG4gICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgcmVxdWVzdCBmYWlsZWQ6ICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTYwKX1gLCB7IHJldHJ5YWJsZTogdHJ1ZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcclxuICAgIH1cclxuICAgIHJldHVybiB0aGlzLnBhcnNlUmVzcG9uc2U8VD4ocmVzKTtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgYXN5bmMgcGFyc2VSZXNwb25zZTxUPihyZXM6IFJlc3BvbnNlKTogUHJvbWlzZTxUPiB7XHJcbiAgICBpZiAocmVzLnN0YXR1cyA9PT0gNDAxIHx8IHJlcy5zdGF0dXMgPT09IDQwMykge1xyXG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgYGhvc3QgcmVqZWN0ZWQgdGhlIHNlc3Npb24gdG9rZW4gKEhUVFAgJHtyZXMuc3RhdHVzfSlgLCB7IHJldHJ5YWJsZTogZmFsc2UsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XHJcbiAgICB9XHJcbiAgICBjb25zdCB0ZXh0ID0gYXdhaXQgcmVzLnRleHQoKTtcclxuICAgIGxldCBwYXJzZWQ6IHVua25vd24gPSBudWxsO1xyXG4gICAgdHJ5IHtcclxuICAgICAgcGFyc2VkID0gdGV4dCA/IEpTT04ucGFyc2UodGV4dCkgOiBudWxsO1xyXG4gICAgfSBjYXRjaCB7XHJcbiAgICAgIHBhcnNlZCA9IG51bGw7XHJcbiAgICB9XHJcbiAgICBpZiAoIXJlcy5vaykge1xyXG4gICAgICBpZiAoaXNEZXNrdG9wRXJyb3IocGFyc2VkKSkgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IocGFyc2VkKTtcclxuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBIVFRQICR7cmVzLnN0YXR1c306ICR7dGV4dC5zbGljZSgwLCAxNjApfWAsIHsgcmV0cnlhYmxlOiByZXMuc3RhdHVzID49IDUwMCB9KSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gcGFyc2VkIGFzIFQ7XHJcbiAgfVxyXG5cclxuICAvKipcclxuICAgKiBcdThCQTJcdTk2MDVcdTUxNjhcdTkwRTggU1NFIFx1NUUyNyhcdTU0MkJcdTk3NUVcdTRGRTFcdTVDMDFcdTRFOEJcdTRFRjY6ZGVsdGEvbGluZSBcdTdCNDlcdTlBRDhcdTk4OTFcdTZENDEpXHUzMDAyXHU0RkUxXHU1QzAxXHU3NTMxXHU4QzAzXHU3NTI4XHU2NUI5XHJcbiAgICogXHU3NTI4IGVudmVsb3BlRnJvbUZyYW1lIFx1ODFFQVx1ODg0Q1x1NTIwNlx1NkQ0MTtcdTY1QURcdTdFQkZcdTkxQ0RcdThGREVcdThCRURcdTRFNDlcdTU0MEMgZXZlbnRzKClcdTMwMDJcclxuICAgKi9cclxuICBhc3luYyAqcmF3RXZlbnRzKGxhc3RFdmVudElkPzogc3RyaW5nLCBzaWduYWw/OiBBYm9ydFNpZ25hbCk6IEFzeW5jR2VuZXJhdG9yPFNzZUZyYW1lPiB7XHJcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgJHt0aGlzLmJhc2VVcmx9L2FwaS9ldmVudHNgLCB7XHJcbiAgICAgIGhlYWRlcnM6IHRoaXMuaGVhZGVycyh7XHJcbiAgICAgICAgYWNjZXB0OiAndGV4dC9ldmVudC1zdHJlYW0nLFxyXG4gICAgICAgIC4uLihsYXN0RXZlbnRJZCAhPT0gdW5kZWZpbmVkID8geyAnbGFzdC1ldmVudC1pZCc6IGxhc3RFdmVudElkIH0gOiB7fSksXHJcbiAgICAgIH0pLFxyXG4gICAgICAuLi4oc2lnbmFsICE9PSB1bmRlZmluZWQgPyB7IHNpZ25hbCB9IDoge30pLFxyXG4gICAgfSk7XHJcbiAgICBpZiAocmVzLnN0YXR1cyA9PT0gNDAxIHx8IHJlcy5zdGF0dXMgPT09IDQwMykge1xyXG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgYGhvc3QgcmVqZWN0ZWQgdGhlIHNlc3Npb24gdG9rZW4gKEhUVFAgJHtyZXMuc3RhdHVzfSlgLCB7IHJldHJ5YWJsZTogZmFsc2UsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XHJcbiAgICB9XHJcbiAgICBpZiAoIXJlcy5vayB8fCByZXMuYm9keSA9PT0gbnVsbCkge1xyXG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYFNTRSBIVFRQICR7cmVzLnN0YXR1c31gLCB7IHJldHJ5YWJsZTogdHJ1ZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHJlYWRlciA9IHJlcy5ib2R5LmdldFJlYWRlcigpO1xyXG4gICAgY29uc3QgZGVjb2RlciA9IG5ldyBUZXh0RGVjb2RlcigpO1xyXG4gICAgbGV0IGJ1ZmZlciA9ICcnO1xyXG4gICAgZm9yICg7Oykge1xyXG4gICAgICBjb25zdCB7IGRvbmUsIHZhbHVlIH0gPSBhd2FpdCByZWFkZXIucmVhZCgpO1xyXG4gICAgICBpZiAoZG9uZSkgcmV0dXJuO1xyXG4gICAgICBidWZmZXIgKz0gZGVjb2Rlci5kZWNvZGUodmFsdWUsIHsgc3RyZWFtOiB0cnVlIH0pO1xyXG4gICAgICBsZXQgaWR4OiBudW1iZXI7XHJcbiAgICAgIHdoaWxlICgoaWR4ID0gYnVmZmVyLmluZGV4T2YoJ1xcblxcbicpKSAhPT0gLTEpIHtcclxuICAgICAgICBjb25zdCBibG9jayA9IGJ1ZmZlci5zbGljZSgwLCBpZHgpO1xyXG4gICAgICAgIGJ1ZmZlciA9IGJ1ZmZlci5zbGljZShpZHggKyAyKTtcclxuICAgICAgICBmb3IgKGNvbnN0IGZyYW1lIG9mIHBhcnNlU3NlQ2h1bmsoYmxvY2spKSB5aWVsZCBmcmFtZTtcclxuICAgICAgfVxyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgLyoqXHJcbiAgICogXHU4QkEyXHU5NjA1IFNTRSBcdTRFOEJcdTRFRjZcdTZENDEoYXN5bmMgaXRlcmF0b3IpXHUzMDAyXHU2NUFEXHU3RUJGXHU3NTMxXHU4QzAzXHU3NTI4XHU2NUI5XHU5MUNEXHU4RkRFO1x1OTFDRFx1OEZERVx1NjVGNlx1NjI4QVx1NjcwMFx1NTQwRVxyXG4gICAqIFx1NjUzNlx1NTIzMFx1NzY4NCBldmVudElkIFx1NEYyMFx1NTE2NSBsYXN0RXZlbnRJZCxob3N0IFx1N0FFRlx1NEVDRVx1OTFDRFx1NjUzRVx1NzNBRlx1ODg2NVx1NTNEMVx1MzAwMlxyXG4gICAqL1xyXG4gIGFzeW5jICpldmVudHMobGFzdEV2ZW50SWQ/OiBzdHJpbmcsIHNpZ25hbD86IEFib3J0U2lnbmFsKTogQXN5bmNHZW5lcmF0b3I8RXZlbnRFbnZlbG9wZT4ge1xyXG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYCR7dGhpcy5iYXNlVXJsfS9hcGkvZXZlbnRzYCwge1xyXG4gICAgICBoZWFkZXJzOiB0aGlzLmhlYWRlcnMoe1xyXG4gICAgICAgIGFjY2VwdDogJ3RleHQvZXZlbnQtc3RyZWFtJyxcclxuICAgICAgICAuLi4obGFzdEV2ZW50SWQgIT09IHVuZGVmaW5lZCA/IHsgJ2xhc3QtZXZlbnQtaWQnOiBsYXN0RXZlbnRJZCB9IDoge30pLFxyXG4gICAgICB9KSxcclxuICAgICAgLi4uKHNpZ25hbCAhPT0gdW5kZWZpbmVkID8geyBzaWduYWwgfSA6IHt9KSxcclxuICAgIH0pO1xyXG4gICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSB8fCByZXMuc3RhdHVzID09PSA0MDMpIHtcclxuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdBVVRIX0ZBSUxFRCcsIGBob3N0IHJlamVjdGVkIHRoZSBzZXNzaW9uIHRva2VuIChIVFRQICR7cmVzLnN0YXR1c30pYCwgeyByZXRyeWFibGU6IGZhbHNlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xyXG4gICAgfVxyXG4gICAgaWYgKCFyZXMub2sgfHwgIXJlcy5ib2R5KSB7XHJcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgU1NFIEhUVFAgJHtyZXMuc3RhdHVzfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgcmVhZGVyID0gcmVzLmJvZHkuZ2V0UmVhZGVyKCk7XHJcbiAgICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKCk7XHJcbiAgICBsZXQgYnVmZmVyID0gJyc7XHJcbiAgICBmb3IgKDs7KSB7XHJcbiAgICAgIGNvbnN0IHsgZG9uZSwgdmFsdWUgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XHJcbiAgICAgIGlmIChkb25lKSByZXR1cm47XHJcbiAgICAgIGJ1ZmZlciArPSBkZWNvZGVyLmRlY29kZSh2YWx1ZSwgeyBzdHJlYW06IHRydWUgfSk7XHJcbiAgICAgIC8vIFx1NEVFNVx1N0E3QVx1ODg0Q1x1NTIwNlx1NUUyNztcdTRGRERcdTc1NTlcdTRFMERcdTVCOENcdTY1NzRcdTc2ODRcdTVDM0VcdTkwRThcclxuICAgICAgbGV0IGlkeDogbnVtYmVyO1xyXG4gICAgICB3aGlsZSAoKGlkeCA9IGJ1ZmZlci5pbmRleE9mKCdcXG5cXG4nKSkgIT09IC0xKSB7XHJcbiAgICAgICAgY29uc3QgYmxvY2sgPSBidWZmZXIuc2xpY2UoMCwgaWR4KTtcclxuICAgICAgICBidWZmZXIgPSBidWZmZXIuc2xpY2UoaWR4ICsgMik7XHJcbiAgICAgICAgZm9yIChjb25zdCBmcmFtZSBvZiBwYXJzZVNzZUNodW5rKGJsb2NrKSkge1xyXG4gICAgICAgICAgY29uc3QgZW52ID0gZW52ZWxvcGVGcm9tRnJhbWUoZnJhbWUpO1xyXG4gICAgICAgICAgaWYgKGVudiAhPT0gbnVsbCkgeWllbGQgZW52O1xyXG4gICAgICAgIH1cclxuICAgICAgfVxyXG4gICAgfVxyXG4gIH1cclxufVxyXG4iLCAiLyoqXHJcbiAqIGZha2UgaG9zdCBcdTIwMTQgaG1oYXJuZXNzIHJ1bnRpbWUgXHU3Njg0XHU2RDRCXHU4QkQ1XHU2NkZGXHU4RUFCKE1hc3RlclByb21wdCBcdTk2MzZcdTZCQjUgRC9FOlxyXG4gKiBcIlx1NTE0OFx1NEY3Rlx1NzUyOCBmYWtlIGhvc3QgXHU3RjE2XHU1MTk5XHU3MkI2XHU2MDAxXHU2NzNBXHU2RDRCXHU4QkQ1LFx1NTE4RFx1NjNBNVx1NzcxRlx1NUI5RSBBUElcIjtcdTk2MzZcdTZCQjUgRSBcdTc2ODRcdTRGMUFcdThCRERcdTdFQjVcdTUyMDdcdTcyNDdcclxuICogZTJlIFx1NEU1Rlx1NTE0OFx1NTcyOCBmYWtlIFx1NUM0Mlx1OTVFRFx1NzNBRilcdTMwMDJcclxuICpcclxuICogXHU2ODRDXHU5NzYyIGhvc3QgXHU1NDA4XHU1NDBDOlxyXG4gKiAgLSBcdTUzRUFcdTdFRDEgMTI3LjAuMC4xLFx1N0FFRlx1NTNFMyBPUyBcdTUyMDZcdTkxNEQsXHU1QjlFXHU5NjQ1XHU3QUVGXHU1M0UzXHU1MTk5IHN0ZG91dCBcdTVGMTVcdTVCRkNcdTg4NEM7XHJcbiAqICAtIFx1NjI0MFx1NjcwOSAvYXBpLyogXHU4OTgxXHU2QzQyIFgtSG1oLUtleSA9PT0gSE1IX0RFU0tUT1BfVE9LRU4sXHU1NDI2XHU1MjE5IDQwMSArIERlc2t0b3BFcnJvcjtcclxuICogIC0gR0VUIC9hcGkvc3RhdGUgXHU1MDY1XHU1RUI3XHU2M0EyXHU2RDRCO0dFVCAvYXBpL2V2ZW50cyBTU0UoZXZlbnQ6IGhtaCBcdTRGRTFcdTVDMDFcdTZENDEgKyBcdTkxQ0RcdTY1M0VcdTczQUYpO1xyXG4gKiAgLSBQT1NUIC9hcGkvZGVza3RvcC9zaHV0ZG93biBcdTRGMThcdTk2QzVcdTkwMDBcdTUxRkFcdTMwMDJcclxuICpcclxuICogXHU5NjM2XHU2QkI1IEUgXHU2QTIxXHU2MkRGXHU5NzYyKFx1NEUwRSBobWhhcm5lc3MgZGVza3RvcCBcdTZBMjFcdTVGMEZcdTU0MENcdTVGNjIpOlxyXG4gKiAgLSBQT1NUIC9hcGkvdGFzayB7dGV4dCwgc2Vzc2lvbklkLCBtb2RlfTpcdTYzOTJcdTk2MUZcdTVFNzZcdTYzMDlcdTgxMUFcdTY3MkNcdTUzRDFcclxuICogICAgcnVuLnN0YXJ0ZWQgXHUyMTkyIHRvb2wuc3RhcnRlZC9jb21wbGV0ZWQgXHUyMTkyKG1vZGU9PT0nYXNrJyBcdTY1RjYpXHJcbiAqICAgIGFwcHJvdmFsLnJlcXVpcmVkKFx1N0I0OSAvYXBpL2FwcHJvdmUpXHUyMTkyIHJ1bi5jb21wbGV0ZWQ7XHJcbiAqICAtIFBPU1QgL2FwaS9hcHByb3ZlIHtncmFudGVkLCBzZXNzaW9uSWR9O1xyXG4gKiAgLSBQT1NUIC9hcGkvaW50ZXJydXB0IHtzZXNzaW9uSWR9O1xyXG4gKiAgLSBHRVQgL2FwaS9zZXNzaW9uc1x1MzAwMlxyXG4gKlxyXG4gKiBcdTZENEJcdThCRDVcdTk0QTlcdTVCNTA6RkFLRV9IT1NUX0RJRV9BRlRFUl9NUyAvIEZBS0VfSE9TVF9ESUVfQVRfQk9PVCAvXHJcbiAqIEZBS0VfSE9TVF9FWFBFQ1RfVE9LRU4gLyBGQUtFX0hPU1RfVEFTS19ERUxBWV9NUyAvIEZBS0VfSE9TVF9UQVNLX0ZBSUw9MVxyXG4gKiAoXHU0RUZCXHU1MkExXHU0RUU1IHJ1bi5mYWlsZWQgXHU3RUQzXHU2NzVGLFx1Njc4NFx1OTAyMFx1OTUxOVx1OEJFRlx1NjA2Mlx1NTkwRFx1NTczQVx1NjY2RilcdTMwMDJcclxuICovXHJcbmltcG9ydCB7IGNyZWF0ZVNlcnZlciwgdHlwZSBTZXJ2ZXJSZXNwb25zZSB9IGZyb20gJ25vZGU6aHR0cCc7XHJcbmltcG9ydCB7IHJhbmRvbVVVSUQgfSBmcm9tICdub2RlOmNyeXB0byc7XHJcbmltcG9ydCB7IHBhdGhUb0ZpbGVVUkwgfSBmcm9tICdub2RlOnVybCc7XHJcbmltcG9ydCB7IHJlYWxwYXRoU3luYyB9IGZyb20gJ25vZGU6ZnMnO1xyXG5pbXBvcnQgeyBFVkVOVF9TQ0hFTUFfVkVSU0lPTiwgZGVza3RvcEVycm9yLCB0eXBlIEV2ZW50RW52ZWxvcGUsIHR5cGUgRXZlbnRLaW5kIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyc7XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIEZha2VIb3N0SGFuZGxlIHtcclxuICBwb3J0OiBudW1iZXI7XHJcbiAgZW1pdChzZXNzaW9uSWQ6IHN0cmluZywgcnVuSWQ6IHN0cmluZywga2luZDogRXZlbnRLaW5kLCBwYXlsb2FkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IG51bWJlcjtcclxuICBjbG9zZSgpOiBQcm9taXNlPHZvaWQ+O1xyXG59XHJcblxyXG5pbnRlcmZhY2UgRmFrZVNlc3Npb24ge1xyXG4gIGlkOiBzdHJpbmc7XHJcbiAgY3JlYXRlZEF0OiBzdHJpbmc7XHJcbiAgdXBkYXRlZEF0OiBzdHJpbmc7XHJcbn1cclxuXHJcbmludGVyZmFjZSBQZW5kaW5nQXBwcm92YWwge1xyXG4gIHNlc3Npb25JZDogc3RyaW5nO1xyXG4gIGFwcHJvdmFsSWQ6IHN0cmluZztcclxuICByZXNvbHZlKGdyYW50ZWQ6IGJvb2xlYW4pOiB2b2lkO1xyXG59XHJcblxyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc3RhcnRGYWtlSG9zdChvcHRzOiB7IHRva2VuOiBzdHJpbmc7IHF1aWV0PzogYm9vbGVhbiB9KTogUHJvbWlzZTxGYWtlSG9zdEhhbmRsZT4ge1xyXG4gIGNvbnN0IHRva2VuID0gb3B0cy50b2tlbjtcclxuICAvLyBcdTZENEJcdThCRDVcdTk0QTlcdTVCNTA6RkFLRV9IT1NUX0VYUEVDVF9UT0tFTiBcdThCQTkgaG9zdCBcdTY4MjFcdTlBOENcdTRFMDBcdTRFMkFcdTRFMEUgSE1IX0RFU0tUT1BfVE9LRU5cclxuICAvLyBcdTRFMERcdTU0MENcdTc2ODRcdTUwM0MoXHU2Nzg0XHU5MDIwIEFVVEhfRkFJTEVEIFx1NTczQVx1NjY2RjtzdXBlcnZpc29yIFx1NjAzQlx1NjYyRlx1ODk4Nlx1NzZENiBITUhfREVTS1RPUF9UT0tFTilcclxuICBjb25zdCBleHBlY3RlZCA9IHByb2Nlc3MuZW52LkZBS0VfSE9TVF9FWFBFQ1RfVE9LRU4gPz8gdG9rZW47XHJcbiAgY29uc3QgdGFza0RlbGF5ID0gTnVtYmVyKHByb2Nlc3MuZW52LkZBS0VfSE9TVF9UQVNLX0RFTEFZX01TID8/IDMwKTtcclxuICBjb25zdCBmYWlsVGFza3MgPSBwcm9jZXNzLmVudi5GQUtFX0hPU1RfVEFTS19GQUlMID09PSAnMSc7XHJcblxyXG4gIGNvbnN0IHNzZUNsaWVudHMgPSBuZXcgU2V0PFNlcnZlclJlc3BvbnNlPigpO1xyXG4gIGNvbnN0IHNlcUJ5UnVuID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcclxuICAvLyBcdTkxQ0RcdTY1M0VcdTczQUY6XHU2NzAwXHU4RkQxIDIwMCBcdTVFMjcoTGFzdC1FdmVudC1JRCBcdTY1QURcdTdFQkZcdTg4NjVcdTYyQzkpLFx1NEUwRSBobWhhcm5lc3Mgd2ViIFx1NTQwQ1x1NkIzRVx1OEJFRFx1NEU0OVxyXG4gIGNvbnN0IHJpbmc6IEFycmF5PHsgaWQ6IG51bWJlcjsgZXZlbnQ6IHN0cmluZzsgZGF0YTogdW5rbm93biB9PiA9IFtdO1xyXG4gIGxldCByaW5nU2VxID0gMDtcclxuICBjb25zdCBzZXNzaW9ucyA9IG5ldyBNYXA8c3RyaW5nLCBGYWtlU2Vzc2lvbj4oKTtcclxuICBsZXQgcGVuZGluZzogUGVuZGluZ0FwcHJvdmFsIHwgbnVsbCA9IG51bGw7XHJcbiAgY29uc3QgcnVuVGltZXJzID0gbmV3IE1hcDxzdHJpbmcsIE5vZGVKUy5UaW1lb3V0PigpO1xyXG4gIC8vIFx1NURFNVx1NEY1Q1x1NTMzQS9Qcm92aWRlciBcdTcyQjZcdTYwMDEoXHU0RTBFIGhtaGFybmVzcyBcdTU0MENcdTVGNjJcdTc2ODRcdTY3MDBcdTVDMEZcdTZBMjFcdTYyREYpXHJcbiAgY29uc3QgZmFrZVdvcmtzcGFjZXMgPSB7XHJcbiAgICBjdXJyZW50OiAnd3MtZGVtbycsXHJcbiAgICBpdGVtczogW1xyXG4gICAgICB7IGlkOiAnd3MtZGVtbycsIG5hbWU6ICdkZW1vLXdvcmtzcGFjZScsIHBhdGg6ICdDOlxcXFxkZW1vJyB9LFxyXG4gICAgXSxcclxuICB9O1xyXG4gIGNvbnN0IGZha2VQcm92aWRlcnMgPSBuZXcgTWFwPHN0cmluZywgeyBiYXNlVXJsOiBzdHJpbmc7IG1vZGVsOiBzdHJpbmc7IGFwaUtleTogc3RyaW5nIH0+KFtcclxuICAgIFsnZGVtbycsIHsgYmFzZVVybDogJ2h0dHA6Ly8xMjcuMC4wLjE6OS92MScsIG1vZGVsOiAnZmFrZS1tJywgYXBpS2V5OiAnc2stZGVtby0xMjM0JyB9XSxcclxuICAgIFsnZGVtby12aXNpb24nLCB7IGJhc2VVcmw6ICdodHRwOi8vMTI3LjAuMC4xOjkvdjEnLCBtb2RlbDogJ2Zha2UtbS12aXNpb24nLCBhcGlLZXk6ICdzay1kZW1vLTU2NzgnIH1dLFxyXG4gIF0pO1xyXG4gIGxldCBmYWtlQ2hhdFByb3ZpZGVyID0gJ2RlbW8nO1xyXG5cclxuICBjb25zdCBlbWl0ID0gKHNlc3Npb25JZDogc3RyaW5nLCBydW5JZDogc3RyaW5nLCBraW5kOiBFdmVudEtpbmQsIHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogbnVtYmVyID0+IHtcclxuICAgIGNvbnN0IGtleSA9IGAke3Nlc3Npb25JZH1cXDAke3J1bklkfWA7XHJcbiAgICBjb25zdCBzZXEgPSAoc2VxQnlSdW4uZ2V0KGtleSkgPz8gMCkgKyAxO1xyXG4gICAgc2VxQnlSdW4uc2V0KGtleSwgc2VxKTtcclxuICAgIGNvbnN0IGVudjogRXZlbnRFbnZlbG9wZSA9IHtcclxuICAgICAgc2NoZW1hVmVyc2lvbjogRVZFTlRfU0NIRU1BX1ZFUlNJT04sXHJcbiAgICAgIGV2ZW50SWQ6IHJhbmRvbVVVSUQoKSxcclxuICAgICAgc2Vzc2lvbklkLFxyXG4gICAgICBydW5JZCxcclxuICAgICAgc2VxLFxyXG4gICAgICBvY2N1cnJlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXHJcbiAgICAgIGtpbmQsXHJcbiAgICAgIHBheWxvYWQsXHJcbiAgICB9O1xyXG4gICAgY29uc3QgaWQgPSArK3JpbmdTZXE7XHJcbiAgICByaW5nLnB1c2goeyBpZCwgZXZlbnQ6ICdobWgnLCBkYXRhOiBlbnYgfSk7XHJcbiAgICBpZiAocmluZy5sZW5ndGggPiAyMDApIHJpbmcuc3BsaWNlKDAsIHJpbmcubGVuZ3RoIC0gMjAwKTtcclxuICAgIGZvciAoY29uc3QgYyBvZiBzc2VDbGllbnRzKSB7XHJcbiAgICAgIGMud3JpdGUoYGlkOiAke2lkfVxcbmV2ZW50OiBobWhcXG5kYXRhOiAke0pTT04uc3RyaW5naWZ5KGVudil9XFxuXFxuYCk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gc2VxO1xyXG4gIH07XHJcblxyXG4gIGNvbnN0IHRvdWNoID0gKHNlc3Npb25JZDogc3RyaW5nKTogRmFrZVNlc3Npb24gPT4ge1xyXG4gICAgbGV0IHMgPSBzZXNzaW9ucy5nZXQoc2Vzc2lvbklkKTtcclxuICAgIGlmIChzID09PSB1bmRlZmluZWQpIHtcclxuICAgICAgcyA9IHsgaWQ6IHNlc3Npb25JZCwgY3JlYXRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksIHVwZGF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpIH07XHJcbiAgICAgIHNlc3Npb25zLnNldChzZXNzaW9uSWQsIHMpO1xyXG4gICAgfVxyXG4gICAgcy51cGRhdGVkQXQgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XHJcbiAgICByZXR1cm4gcztcclxuICB9O1xyXG5cclxuICAvKiogXHU2QTIxXHU2MkRGXHU0RTAwXHU2QjIxXHU0RUZCXHU1MkExOlx1NjI3OVx1NTFDNlx1NkEyMVx1NUYwRlx1NjMwMlx1OEQ3N1x1N0I0OVx1NUY4NSAvYXBpL2FwcHJvdmVcdTMwMDIgKi9cclxuICBjb25zdCBydW5UYXNrID0gKHNlc3Npb25JZDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcsIG1vZGU6IHN0cmluZyk6IHN0cmluZyA9PiB7XHJcbiAgICBjb25zdCBydW5JZCA9IGBydW4tJHtEYXRlLm5vdygpLnRvU3RyaW5nKDM2KX0tJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCA4KX1gO1xyXG4gICAgdG91Y2goc2Vzc2lvbklkKTtcclxuICAgIGNvbnN0IHN0ZXBzOiBBcnJheTwoKSA9PiB2b2lkPiA9IFtdO1xyXG4gICAgY29uc3Qgd2FpdCA9IChmbjogKCkgPT4gdm9pZCwgbXMgPSB0YXNrRGVsYXkpOiB2b2lkID0+IHtcclxuICAgICAgY29uc3QgdCA9IHNldFRpbWVvdXQoZm4sIG1zKTtcclxuICAgICAgcnVuVGltZXJzLnNldChgJHtzZXNzaW9uSWR9XFwwJHtydW5JZH1gLCB0KTtcclxuICAgIH07XHJcbiAgICBjb25zdCBjaGFpbiA9IChmbnM6IEFycmF5PCgpID0+IHZvaWQ+KTogdm9pZCA9PiB7XHJcbiAgICAgIGNvbnN0IFtmaXJzdCwgLi4ucmVzdF0gPSBmbnM7XHJcbiAgICAgIGlmIChmaXJzdCA9PT0gdW5kZWZpbmVkKSByZXR1cm47XHJcbiAgICAgIHdhaXQoKCkgPT4ge1xyXG4gICAgICAgIGZpcnN0KCk7XHJcbiAgICAgICAgY2hhaW4ocmVzdCk7XHJcbiAgICAgIH0pO1xyXG4gICAgfTtcclxuXHJcbiAgICBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICdydW4uc3RhcnRlZCcsIHsgdGFzazogdGV4dCwgbW9kZSB9KTtcclxuICAgIGlmIChmYWlsVGFza3MpIHtcclxuICAgICAgd2FpdCgoKSA9PiBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICdydW4uZmFpbGVkJywge1xyXG4gICAgICAgIGVycm9yOiB7IGNvZGU6ICdBVVRIX0ZBSUxFRCcsIG1lc3NhZ2U6ICdzaW11bGF0ZWQgcHJvdmlkZXIgYXV0aCBmYWlsdXJlJywgcmV0cnlhYmxlOiBmYWxzZSB9LFxyXG4gICAgICB9KSk7XHJcbiAgICAgIHJldHVybiBydW5JZDtcclxuICAgIH1cclxuXHJcbiAgICBjb25zdCBmaW5pc2hSdW4gPSAoYW5zd2VyOiBzdHJpbmcsIHRvb2xVc2VzOiBudW1iZXIpOiB2b2lkID0+IHtcclxuICAgICAgcnVuVGltZXJzLmRlbGV0ZShgJHtzZXNzaW9uSWR9XFwwJHtydW5JZH1gKTtcclxuICAgICAgLy8gXHU0RUE0XHU0RUQ4XHU3MjY5XHU1MTQ4XHU0RThFXHU3RUM4XHU2MDAxKFx1NEUwRSBobWhhcm5lc3MgZGVza3RvcCBcdTY4NjVcdTU0MENcdTVFOEY6YXJ0aWZhY3QuY3JlYXRlZCBcdTIxOTIgcnVuLmNvbXBsZXRlZClcclxuICAgICAgZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAnYXJ0aWZhY3QuY3JlYXRlZCcsIHtcclxuICAgICAgICBhcnRpZmFjdDogeyByZWxQYXRoOiAnb3V0LnR4dCcsIGtpbmQ6ICdmaWxlJywgdGl0bGU6ICdvdXQudHh0JyB9LFxyXG4gICAgICB9KTtcclxuICAgICAgZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAncnVuLmNvbXBsZXRlZCcsIHsgdGV4dDogYW5zd2VyLCB0dXJuczogMSwgdG9vbFVzZXMgfSk7XHJcbiAgICB9O1xyXG5cclxuICAgIGNvbnN0IHNjcmlwdGVkOiBBcnJheTwoKSA9PiB2b2lkPiA9IFtcclxuICAgICAgKCkgPT4gZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAndG9vbC5zdGFydGVkJywgeyBuYW1lOiAncmVhZF9maWxlJywgYXJnc1ByZXZpZXc6ICd7XCJwYXRoXCI6XCJSRUFETUUubWRcIn0nIH0pLFxyXG4gICAgICAoKSA9PiBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICd0b29sLmNvbXBsZXRlZCcsIHsgbmFtZTogJ3JlYWRfZmlsZScsIGlzRXJyb3I6IGZhbHNlLCBvdXRwdXRQcmV2aWV3OiAnIyBkZW1vJyB9KSxcclxuICAgIF07XHJcblxyXG4gICAgaWYgKG1vZGUgPT09ICdhc2snKSB7XHJcbiAgICAgIHNjcmlwdGVkLnB1c2goKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IGFwcHJvdmFsSWQgPSBgYXAtJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCA4KX1gO1xyXG4gICAgICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ2FwcHJvdmFsLnJlcXVpcmVkJywge1xyXG4gICAgICAgICAgYXBwcm92YWxJZCxcclxuICAgICAgICAgIHRvb2w6ICd3cml0ZV9maWxlJyxcclxuICAgICAgICAgIGFyZ3NQcmV2aWV3OiAne1wicGF0aFwiOlwib3V0LnR4dFwiLFwiY29udGVudFwiOlwiaGlcIn0nLFxyXG4gICAgICAgICAgcmlzazogJ1x1NTE5OVx1NTE2NVx1NURFNVx1NEY1Q1x1NTMzQVx1NjU4N1x1NEVGNiBvdXQudHh0KFx1NkEyMVx1NjJERiknLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHBlbmRpbmcgPSB7XHJcbiAgICAgICAgICBzZXNzaW9uSWQsXHJcbiAgICAgICAgICBhcHByb3ZhbElkLFxyXG4gICAgICAgICAgcmVzb2x2ZTogKGdyYW50ZWQpID0+IHtcclxuICAgICAgICAgICAgcGVuZGluZyA9IG51bGw7XHJcbiAgICAgICAgICAgIGlmIChncmFudGVkKSB7XHJcbiAgICAgICAgICAgICAgZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAndG9vbC5zdGFydGVkJywgeyBuYW1lOiAnd3JpdGVfZmlsZScsIGFyZ3NQcmV2aWV3OiAne1wicGF0aFwiOlwib3V0LnR4dFwifScgfSk7XHJcbiAgICAgICAgICAgICAgd2FpdCgoKSA9PiBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICd0b29sLmNvbXBsZXRlZCcsIHsgbmFtZTogJ3dyaXRlX2ZpbGUnLCBpc0Vycm9yOiBmYWxzZSwgb3V0cHV0UHJldmlldzogJ3dyb3RlIDIgYnl0ZXMnIH0pKTtcclxuICAgICAgICAgICAgICB3YWl0KCgpID0+IGZpbmlzaFJ1bihgZWNobzogJHt0ZXh0fShcdTVERjJcdTYyNjdcdTg4NENcdTUxOTlcdTUxNjUpYCwgMyksIHRhc2tEZWxheSAqIDIpO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgIGZpbmlzaFJ1bihgZWNobzogJHt0ZXh0fShcdTVCQTFcdTYyNzlcdTg4QUJcdTYyRDJcdTdFREQsXHU2NzJBXHU2MjY3XHU4ODRDXHU1MTk5XHU1MTY1KWAsIDEpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICB9LFxyXG4gICAgICAgIH07XHJcbiAgICAgIH0pO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgc2NyaXB0ZWQucHVzaCgoKSA9PiBmaW5pc2hSdW4oYGVjaG86ICR7dGV4dH1gLCAxKSk7XHJcbiAgICB9XHJcbiAgICBjaGFpbihzY3JpcHRlZCk7XHJcbiAgICByZXR1cm4gcnVuSWQ7XHJcbiAgfTtcclxuXHJcbiAgY29uc3Qgc2VydmVyID0gY3JlYXRlU2VydmVyKChyZXEsIHJlcykgPT4ge1xyXG4gICAgY29uc3QgdXJsID0gbmV3IFVSTChyZXEudXJsID8/ICcvJywgJ2h0dHA6Ly8xMjcuMC4wLjEnKTtcclxuICAgIGNvbnN0IGF1dGhvcml6ZWQgPSByZXEuaGVhZGVyc1sneC1obWgta2V5J10gPT09IGV4cGVjdGVkO1xyXG4gICAgY29uc3QgZGVueSA9ICgpOiB2b2lkID0+IHtcclxuICAgICAgcmVzLndyaXRlSGVhZCg0MDEsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgJ21pc3Npbmcgb3IgaW52YWxpZCB4LWhtaC1rZXknLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcclxuICAgIH07XHJcblxyXG4gICAgY29uc3QgcmVhZEJvZHkgPSAoKTogUHJvbWlzZTxzdHJpbmc+ID0+XHJcbiAgICAgIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XHJcbiAgICAgICAgbGV0IGIgPSAnJztcclxuICAgICAgICByZXEub24oJ2RhdGEnLCAoYzogQnVmZmVyKSA9PiB7IGIgKz0gYy50b1N0cmluZygpOyB9KTtcclxuICAgICAgICByZXEub24oJ2VuZCcsICgpID0+IHJlc29sdmUoYikpO1xyXG4gICAgICB9KTtcclxuXHJcbiAgICBpZiAodXJsLnBhdGhuYW1lID09PSAnL2FwaS9ldmVudHMnKSB7XHJcbiAgICAgIGlmICghYXV0aG9yaXplZCkgeyBkZW55KCk7IHJldHVybjsgfVxyXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ3RleHQvZXZlbnQtc3RyZWFtJywgJ2NhY2hlLWNvbnRyb2wnOiAnbm8tY2FjaGUnLCBjb25uZWN0aW9uOiAna2VlcC1hbGl2ZScgfSk7XHJcbiAgICAgIHJlcy5mbHVzaEhlYWRlcnM/LigpO1xyXG4gICAgICBzc2VDbGllbnRzLmFkZChyZXMpO1xyXG4gICAgICAvLyBcdTY1QURcdTdFQkZcdTg4NjVcdTYyQzk6TGFzdC1FdmVudC1JRCBcdTRFNEJcdTUyNERcdTc2ODRcdTVFMjdcdTVERjJcdTU3MjhcdTVCQTJcdTYyMzdcdTdBRUYsXHU5MUNEXHU1M0QxXHU1MTc2XHU1NDBFXHU3Njg0XHU3M0FGXHU1RjYyXHU3RjEzXHU1MUIyXHJcbiAgICAgIGNvbnN0IGxhc3RJZCA9IE51bWJlcihyZXEuaGVhZGVyc1snbGFzdC1ldmVudC1pZCddID8/IDApO1xyXG4gICAgICBpZiAoTnVtYmVyLmlzRmluaXRlKGxhc3RJZCkgJiYgbGFzdElkID4gMCkge1xyXG4gICAgICAgIGZvciAoY29uc3QgZSBvZiByaW5nKSB7XHJcbiAgICAgICAgICBpZiAoZS5pZCA+IGxhc3RJZCkgcmVzLndyaXRlKGBpZDogJHtlLmlkfVxcbmV2ZW50OiAke2UuZXZlbnR9XFxuZGF0YTogJHtKU09OLnN0cmluZ2lmeShlLmRhdGEpfVxcblxcbmApO1xyXG4gICAgICAgIH1cclxuICAgICAgfVxyXG4gICAgICByZXEub24oJ2Nsb3NlJywgKCkgPT4gc3NlQ2xpZW50cy5kZWxldGUocmVzKSk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmICghYXV0aG9yaXplZCkgeyBkZW55KCk7IHJldHVybjsgfVxyXG5cclxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3N0YXRlJykge1xyXG4gICAgICAvLyBwcm92aWRlcnNEZXRhaWw6XHU0RTBFIGhtaGFybmVzcyBcdTU0MENcdTVGNjJcdTIwMTRcdTIwMTRrZXkgXHU1M0VBXHU1MUZBIGhhc0tleS9cdTY3MkJcdTU2REJcdTRGNEQsXHU2QzM4XHU0RTBEXHU2NjBFXHU2NTg3XHJcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xyXG4gICAgICAgIGRhZW1vblZlcnNpb246ICdmYWtlLTAuMC4wJywgZGVza3RvcDogdHJ1ZSwgbW9kZWw6IGZha2VQcm92aWRlcnMuZ2V0KGZha2VDaGF0UHJvdmlkZXIpPy5tb2RlbCA/PyAnZmFrZS1tb2RlbCcsXHJcbiAgICAgICAgY2hhdFByb3ZpZGVyOiBmYWtlQ2hhdFByb3ZpZGVyLCBsb2NhbGU6ICd6aCcsXHJcbiAgICAgICAgYnVzeVNlc3Npb25zOiBbLi4uc2Vzc2lvbnMua2V5cygpXS5zbGljZSgwLCAyKSxcclxuICAgICAgICBhcHByb3ZhbFBlbmRpbmc6IHBlbmRpbmcgIT09IG51bGwsXHJcbiAgICAgICAgc2V0dGluZ3M6IHsgYXBwcm92YWw6ICdhc2snIH0sXHJcbiAgICAgICAgd29ya3NwYWNlOiBmYWtlV29ya3NwYWNlcy5pdGVtcy5maW5kKCh3KSA9PiB3LmlkID09PSBmYWtlV29ya3NwYWNlcy5jdXJyZW50KSA/PyBudWxsLFxyXG4gICAgICAgIHByb3ZpZGVyc0RldGFpbDogWy4uLmZha2VQcm92aWRlcnMuZW50cmllcygpXS5tYXAoKFtuYW1lLCBwXSkgPT4gKHtcclxuICAgICAgICAgIG5hbWUsIG1vZGVsOiBwLm1vZGVsLCBiYXNlVXJsOiBwLmJhc2VVcmwsXHJcbiAgICAgICAgICBoYXNLZXk6IHAuYXBpS2V5ICE9PSAnJyxcclxuICAgICAgICAgIGtleVRhaWw6IHAuYXBpS2V5Lmxlbmd0aCA+PSA0ID8gcC5hcGlLZXkuc2xpY2UoLTQpIDogdW5kZWZpbmVkLFxyXG4gICAgICAgICAgcHVycG9zZXM6IFsnY2hhdCddLFxyXG4gICAgICAgIH0pKSxcclxuICAgICAgfSkpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZGVza3RvcC9zaHV0ZG93bicpIHtcclxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlIH0pKTtcclxuICAgICAgc2VydmVyLmNsb3NlKCgpID0+IHByb2Nlc3MuZXhpdCgwKSk7XHJcbiAgICAgIHNldFRpbWVvdXQoKCkgPT4gcHJvY2Vzcy5leGl0KDApLCAxXzAwMCkudW5yZWYoKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2Zha2UvZGllJykge1xyXG4gICAgICAvLyBcdTZENEJcdThCRDVcdTk0QTlcdTVCNTA6XHU2QTIxXHU2MkRGIGhvc3QgXHU1RDI5XHU2RTgzKFx1NTE0OFx1NUU5NFx1N0I1NFx1NTE4RFx1OTAwMFx1NTFGQSxcdTRGRERcdThCQzFcdTU0Q0RcdTVFOTRcdTVERjJcdTUzRDFcdTUxRkEpXHJcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSB9KSk7XHJcbiAgICAgIHNldFRpbWVvdXQoKCkgPT4gcHJvY2Vzcy5leGl0KDEpLCA1MCk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9tb2RlbCcpIHtcclxuICAgICAgLy8gXHU2QTIxXHU1NzhCXHU1MjA3XHU2MzYyKFx1NEUwRSBobWhhcm5lc3MgL2FwaS9tb2RlbCBcdTU0MENcdTVGNjI6XHU1MjA3IGNoYXQgXHU4REVGXHU3NTMxKVxyXG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoKGF3YWl0IHJlYWRCb2R5KCkpIHx8ICd7fScpIGFzIHsgbmFtZT86IHVua25vd24gfTtcclxuICAgICAgICBjb25zdCBuYW1lID0gdHlwZW9mIGJvZHkubmFtZSA9PT0gJ3N0cmluZycgPyBib2R5Lm5hbWUudHJpbSgpIDogJyc7XHJcbiAgICAgICAgaWYgKCFmYWtlUHJvdmlkZXJzLmhhcyhuYW1lKSkge1xyXG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAncHJvdmlkZXIgbm90IGZvdW5kJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XHJcbiAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGZha2VDaGF0UHJvdmlkZXIgPSBuYW1lO1xyXG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlLCBtb2RlbDogZmFrZVByb3ZpZGVycy5nZXQobmFtZSk/Lm1vZGVsIH0pKTtcclxuICAgICAgfSkoKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3Rhc2snKSB7XHJcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoKGF3YWl0IHJlYWRCb2R5KCkpIHx8ICd7fScpIGFzIHsgdGV4dD86IHVua25vd247IHNlc3Npb25JZD86IHVua25vd247IG1vZGU/OiB1bmtub3duOyBhdHRhY2htZW50cz86IHVua25vd247IGltYWdlcz86IHVua25vd24gfTtcclxuICAgICAgICAgIGNvbnN0IHRleHQgPSB0eXBlb2YgYm9keS50ZXh0ID09PSAnc3RyaW5nJyA/IGJvZHkudGV4dCA6ICcnO1xyXG4gICAgICAgICAgY29uc3Qgc2Vzc2lvbklkID0gdHlwZW9mIGJvZHkuc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IGJvZHkuc2Vzc2lvbklkIDogYHdlYi0ke0RhdGUubm93KCkudG9TdHJpbmcoMzYpfWA7XHJcbiAgICAgICAgICBjb25zdCBtb2RlID0gYm9keS5tb2RlID09PSAnYXNrJyB8fCBib2R5Lm1vZGUgPT09ICdhdXRvJyB8fCBib2R5Lm1vZGUgPT09ICd5b2xvJyA/IGJvZHkubW9kZSA6ICdhc2snO1xyXG4gICAgICAgICAgY29uc3QgYXR0YWNobWVudHMgPSBBcnJheS5pc0FycmF5KGJvZHkuYXR0YWNobWVudHMpID8gYm9keS5hdHRhY2htZW50cy5maWx0ZXIoKGEpOiBhIGlzIHN0cmluZyA9PiB0eXBlb2YgYSA9PT0gJ3N0cmluZycpIDogW107XHJcbiAgICAgICAgICAvLyBcdTU2RkVcdTcyNDdcdTk2NDRcdTRFRjY6XHU0RTBFIGhtaGFybmVzcyB2aXNpb24gXHU1MzRGXHU4QkFFXHU1NDBDXHU1RjYyKHtuYW1lLGRhdGFVcmx9KTtmYWtlIFx1NjgyMVx1OUE4Q1x1NUY2Mlx1NzJCNlx1NTM3M1x1NjUzNlxyXG4gICAgICAgICAgY29uc3QgaW1hZ2VzID0gQXJyYXkuaXNBcnJheShib2R5LmltYWdlcylcclxuICAgICAgICAgICAgPyBib2R5LmltYWdlcy5maWx0ZXIoKGltKTogaW0gaXMgeyBuYW1lOiBzdHJpbmc7IGRhdGFVcmw6IHN0cmluZyB9ID0+IHtcclxuICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgaW0gIT09ICdvYmplY3QnIHx8IGltID09PSBudWxsKSByZXR1cm4gZmFsc2U7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBvID0gaW0gYXMgeyBuYW1lPzogdW5rbm93bjsgZGF0YVVybD86IHVua25vd24gfTtcclxuICAgICAgICAgICAgICAgIHJldHVybiB0eXBlb2Ygby5uYW1lID09PSAnc3RyaW5nJyAmJiB0eXBlb2Ygby5kYXRhVXJsID09PSAnc3RyaW5nJyAmJiBvLmRhdGFVcmwuc3RhcnRzV2l0aCgnZGF0YTppbWFnZS8nKTtcclxuICAgICAgICAgICAgICB9KVxyXG4gICAgICAgICAgICA6IFtdO1xyXG4gICAgICAgICAgaWYgKCF0ZXh0KSB7XHJcbiAgICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAndGV4dCByZXF1aXJlZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgICAvLyBcdTRFMEUgaG1oYXJuZXNzIFx1NTQwQ1x1OEJFRFx1NEU0OTpcdTU0MDhcdTZDRDVcdTk2NDRcdTRFRjZcdTRFRTUgW3JlZmVyZW5jZWQgZmlsZXNdIFx1NTI0RFx1N0YwMFx1NUU3Nlx1NTE2NVx1NEVGQlx1NTJBMVx1NjU4N1x1NjcyQztcclxuICAgICAgICAgIC8vIFx1NTZGRVx1NzI0N1x1NEVFNSBbaW1hZ2VzXSBcdTUyNERcdTdGMDBcdTY4MDdcdTZDRThcdTVGMjBcdTY1NzAodmlzaW9uIFx1NjNDRlx1OEZGMFx1OTRGRVx1NTcyOFx1NzcxRlx1NUI5RSBydW50aW1lIFx1OTFDQ1x1NTNEMVx1NzUxRilcclxuICAgICAgICAgIGNvbnN0IGNvbXBvc2VkID0gYXR0YWNobWVudHMubGVuZ3RoID4gMFxyXG4gICAgICAgICAgICA/IGBbcmVmZXJlbmNlZCBmaWxlc11cXG4ke2F0dGFjaG1lbnRzLm1hcCgoYSkgPT4gYC0gJHthLnNwbGl0KC9bXFxcXC9dLykucG9wKCl9YCkuam9pbignXFxuJyl9XFxuXFxuJHt0ZXh0fWBcclxuICAgICAgICAgICAgOiB0ZXh0O1xyXG4gICAgICAgICAgY29uc3Qgd2l0aEltYWdlcyA9IGltYWdlcy5sZW5ndGggPiAwID8gYFtpbWFnZXM6ICR7aW1hZ2VzLmxlbmd0aH1dXFxuJHtjb21wb3NlZH1gIDogY29tcG9zZWQ7XHJcbiAgICAgICAgICBjb25zdCBydW5JZCA9IHJ1blRhc2soc2Vzc2lvbklkLCB3aXRoSW1hZ2VzLCBtb2RlKTtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIHJ1bklkLCBpbWFnZXM6IGltYWdlcy5sZW5ndGggfSkpO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCBTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcclxuICAgICAgICB9XHJcbiAgICAgIH0pKCk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9hcHByb3ZlJykge1xyXG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoKGF3YWl0IHJlYWRCb2R5KCkpIHx8ICd7fScpIGFzIHsgZ3JhbnRlZD86IHVua25vd247IHNlc3Npb25JZD86IHVua25vd24gfTtcclxuICAgICAgICBjb25zdCBzaWQgPSB0eXBlb2YgYm9keS5zZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gYm9keS5zZXNzaW9uSWQgOiAnJztcclxuICAgICAgICBpZiAocGVuZGluZyA9PT0gbnVsbCB8fCAoc2lkICE9PSAnJyAmJiBwZW5kaW5nLnNlc3Npb25JZCAhPT0gc2lkKSkge1xyXG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnbm8gYXBwcm92YWwgcGVuZGluZycsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xyXG4gICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBwID0gcGVuZGluZztcclxuICAgICAgICBwZW5kaW5nID0gbnVsbDtcclxuICAgICAgICBwLnJlc29sdmUoYm9keS5ncmFudGVkID09PSB0cnVlKTtcclxuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgZ3JhbnRlZDogYm9keS5ncmFudGVkID09PSB0cnVlIH0pKTtcclxuICAgICAgfSkoKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUuc3RhcnRzV2l0aCgnL2FwaS9zZXNzaW9ucy8nKSAmJiAodXJsLnBhdGhuYW1lLmVuZHNXaXRoKCcvYXJjaGl2ZScpIHx8IHVybC5wYXRobmFtZS5lbmRzV2l0aCgnL2RlbGV0ZScpKSkge1xyXG4gICAgICAvLyBcdTRGMUFcdThCRERcdTVGNTJcdTY4NjMvXHU1MjIwXHU5NjY0KGhtaGFybmVzcyBcdTU0MENcdTVGNjI6XHU3OUZCXHU1MTY1IGFyY2hpdmUvdHJhc2gsXHU1M0VGXHU2MDYyXHU1OTBELFx1NEUwRFx1Nzg2Q1x1NTIyMClcclxuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHBhcnRzID0gdXJsLnBhdGhuYW1lLnNsaWNlKCcvYXBpL3Nlc3Npb25zLycubGVuZ3RoKS5zcGxpdCgnLycpO1xyXG4gICAgICAgIGNvbnN0IG9wID0gcGFydHNbMV0gPz8gJyc7XHJcbiAgICAgICAgY29uc3Qgb2lkID0gZGVjb2RlVVJJQ29tcG9uZW50KHBhcnRzWzBdID8/ICcnKS5yZXBsYWNlKC9bXmEtekEtWjAtOV86LkAtXS9nLCAnJyk7XHJcbiAgICAgICAgaWYgKG9pZCA9PT0gJycgfHwgKG9wICE9PSAnYXJjaGl2ZScgJiYgb3AgIT09ICdkZWxldGUnKSkge1xyXG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnYmFkIG9wJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XHJcbiAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICghc2Vzc2lvbnMuaGFzKG9pZCkpIHtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3Nlc3Npb24gbm90IGZvdW5kJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XHJcbiAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHNlc3Npb25zLmRlbGV0ZShvaWQpO1xyXG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlIH0pKTtcclxuICAgICAgfSkoKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2luamVjdCcpIHtcclxuICAgICAgLy8gXHU4RkQwXHU4ODRDXHU0RTJEXHU2Q0U4XHU1MTY1KFx1NEUwRSBobWhhcm5lc3MgL2FwaS9pbmplY3QgXHU1NDBDXHU1RjYyO2Zha2UgXHU1M0VBXHU1NkRFXHU2MjY3KVxyXG4gICAgICB2b2lkIHJlYWRCb2R5KCk7XHJcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSB9KSk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9pbnRlcnJ1cHQnKSB7XHJcbiAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKCcnKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjsgLy8gaW50ZXJydXB0IFx1NjVFMCBib2R5IFx1OEJFRFx1NEU0OVxyXG4gICAgICB2b2lkIGJvZHk7XHJcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSB9KSk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3Nlc3Npb25zJykge1xyXG4gICAgICBjb25zdCBsaXN0ID0gWy4uLnNlc3Npb25zLnZhbHVlcygpXS5tYXAoKHMpID0+ICh7XHJcbiAgICAgICAgaWQ6IHMuaWQsIHRpdGxlOiAnJywgdGFzazogJycsIG91dGNvbWU6ICdvaycsIHR1cm5zOiAxLCB0b29sVXNlczogMSxcclxuICAgICAgICB0aW1lOiBzLnVwZGF0ZWRBdCwgY3dkOiAnQzpcXFxcZGVtbycsIGJyYW5jaDogJycsIGNyZWF0ZWRBdDogcy5jcmVhdGVkQXQsIHVwZGF0ZWRBdDogcy51cGRhdGVkQXQsXHJcbiAgICAgIH0pKTtcclxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IHNlc3Npb25zOiBsaXN0LCBuZXh0Q3Vyc29yOiBudWxsIH0pKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZS5zdGFydHNXaXRoKCcvYXBpL3Nlc3Npb25zLycpKSB7XHJcbiAgICAgIGNvbnN0IHNlZyA9IGRlY29kZVVSSUNvbXBvbmVudCh1cmwucGF0aG5hbWUuc2xpY2UoJy9hcGkvc2Vzc2lvbnMvJy5sZW5ndGgpKTtcclxuICAgICAgLy8gXHU1QkZDXHU1MUZBKFx1NEUwRSBobWhhcm5lc3MgL2FwaS9zZXNzaW9ucy86aWQvZXhwb3J0Lm1kIFx1NTQwQ1x1NUY2Mjp0ZXh0L21hcmtkb3duIFx1NEUwQlx1OEY3RClcclxuICAgICAgY29uc3QgZXhwb3J0TWF0Y2ggPSAvXiguKilcXC9leHBvcnRcXC5tZCQvLmV4ZWMoc2VnKSA/PyAvXiguKilcXC5leHBvcnRcXC5tZCQvLmV4ZWMoc2VnKTtcclxuICAgICAgaWYgKGV4cG9ydE1hdGNoICE9PSBudWxsICYmIGV4cG9ydE1hdGNoWzFdICE9PSB1bmRlZmluZWQgJiYgZXhwb3J0TWF0Y2hbMV0gIT09ICcnKSB7XHJcbiAgICAgICAgY29uc3QgZWlkID0gZXhwb3J0TWF0Y2hbMV0ucmVwbGFjZSgvW15hLXpBLVowLTlfOi5ALV0vZywgJycpO1xyXG4gICAgICAgIGNvbnN0IGVzID0gc2Vzc2lvbnMuZ2V0KGVpZCk7XHJcbiAgICAgICAgaWYgKGVzID09PSB1bmRlZmluZWQpIHtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3Nlc3Npb24gbm90IGZvdW5kJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XHJcbiAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAndGV4dC9tYXJrZG93bjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgcmVzLmVuZChgIyBobWhhcm5lc3MgXHU0RjFBXHU4QkREXHU1QkZDXHU1MUZBKGZha2UpXFxuXFxuLSBcdTRGMUFcdThCREQ6JHtlaWR9XFxuXFxuIyMgXHU3NTI4XHU2MjM3XFxuXFxuXHU0RTRCXHU1MjREXHU3Njg0XHU0RUZCXHU1MkExKGZha2UgXHU5ODg0XHU4OUM4KVxcblxcbiMjIFx1NTJBOVx1NjI0Qlxcblxcblx1OEZEOVx1NjYyRlx1NUJGQ1x1NTFGQVx1NzY4NFx1NTZERVx1NTkwRFx1OTg4NFx1ODlDOChmYWtlKVx1MzAwMlxcbmApO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgICAgfVxyXG4gICAgICAvLyBcdTRGMUFcdThCRERcdTk4ODRcdTg5QzgoXHU0RTBFIGhtaGFybmVzcyBHRVQgL2FwaS9zZXNzaW9ucy86aWQgXHU1NDBDXHU1RjYyOlx1NjcwMFx1NTQwRSA4MCBcdTY3NjEsXHU2QkNGXHU2NzYxIDUwMCBcdTVCNTcpXHJcbiAgICAgIGNvbnN0IGlkID0gc2VnLnJlcGxhY2UoL1teYS16QS1aMC05XzouQC1dL2csICcnKTtcclxuICAgICAgY29uc3QgcyA9IHNlc3Npb25zLmdldChpZCk7XHJcbiAgICAgIGlmIChzID09PSB1bmRlZmluZWQpIHtcclxuICAgICAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnc2Vzc2lvbiBub3QgZm91bmQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcclxuICAgICAgICByZXR1cm47XHJcbiAgICAgIH1cclxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XHJcbiAgICAgICAgaWQsIG1vZGVsOiAnZmFrZS1tb2RlbCcsIGN3ZDogJ0M6XFxcXGRlbW8nLFxyXG4gICAgICAgIG1lc3NhZ2VzOiBbXHJcbiAgICAgICAgICB7IHJvbGU6ICd1c2VyJywgdGV4dDogJ1x1NEU0Qlx1NTI0RFx1NzY4NFx1NEVGQlx1NTJBMShmYWtlIFx1OTg4NFx1ODlDOCknLCB0b29sczogW10gfSxcclxuICAgICAgICAgIHsgcm9sZTogJ2Fzc2lzdGFudCcsIHRleHQ6ICdcdThGRDlcdTY2MkZcdTUzODZcdTUzRjJcdTRGMUFcdThCRERcdTc2ODRcdTU2REVcdTU5MERcdTk4ODRcdTg5QzgoZmFrZSlcdTMwMDInLCB0b29sczogWydyZWFkX2ZpbGUnXSB9LFxyXG4gICAgICAgIF0sXHJcbiAgICAgIH0pKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZnMnKSB7XHJcbiAgICAgIC8vIFx1NzZFRVx1NUY1NVx1NkQ0Rlx1ODlDOChcdTRFMEUgaG1oYXJuZXNzIFx1NTQwQ1x1NUY2MjpwYXRoIFx1NzcwMVx1NzU2NT1cdTY4Mzk7ZmlsZXM9MSBcdTk2NDRcdTVFMjZcdTY1ODdcdTRFRjZcdTUyMTdcdTg4NjgpXHJcbiAgICAgIGNvbnN0IHEgPSB1cmwuc2VhcmNoUGFyYW1zLmdldCgncGF0aCcpID8/ICcnO1xyXG4gICAgICBjb25zdCB3aXRoRmlsZXMgPSB1cmwuc2VhcmNoUGFyYW1zLmdldCgnZmlsZXMnKSA9PT0gJzEnO1xyXG4gICAgICBpZiAocSA9PT0gJycpIHtcclxuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xyXG4gICAgICAgICAgcGF0aDogJycsIHNlZ21lbnRzOiBbXSwgcGFyZW50OiAnJyxcclxuICAgICAgICAgIGRpcnM6IFt7IG5hbWU6ICdkZW1vLXdvcmtzcGFjZScsIHBhdGg6ICdDOlxcXFxkZW1vJyB9XSxcclxuICAgICAgICAgIC4uLih3aXRoRmlsZXMgPyB7IGZpbGVzOiBbXSB9IDoge30pLFxyXG4gICAgICAgIH0pKTtcclxuICAgICAgICByZXR1cm47XHJcbiAgICAgIH1cclxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XHJcbiAgICAgICAgcGF0aDogcSwgc2VnbWVudHM6IFt7IG5hbWU6IHEuc3BsaXQoL1tcXFxcL10vKS5maWx0ZXIoQm9vbGVhbikucG9wKCkgPz8gcSwgcGF0aDogcSB9XSwgcGFyZW50OiAnJyxcclxuICAgICAgICBkaXJzOiBbeyBuYW1lOiAnc3JjJywgcGF0aDogYCR7cS5yZXBsYWNlKC9bXFxcXC9dJC8sICcnKX1cXFxcc3JjYCB9XSxcclxuICAgICAgICAuLi4od2l0aEZpbGVzID8geyBmaWxlczogW1xyXG4gICAgICAgICAgeyBuYW1lOiAnUkVBRE1FLm1kJywgcGF0aDogYCR7cS5yZXBsYWNlKC9bXFxcXC9dJC8sICcnKX1cXFxcUkVBRE1FLm1kYCwgcmVsOiAnUkVBRE1FLm1kJyB9LFxyXG4gICAgICAgICAgeyBuYW1lOiAncGFja2FnZS5qc29uJywgcGF0aDogYCR7cS5yZXBsYWNlKC9bXFxcXC9dJC8sICcnKX1cXFxccGFja2FnZS5qc29uYCwgcmVsOiAncGFja2FnZS5qc29uJyB9LFxyXG4gICAgICAgIF0gfSA6IHt9KSxcclxuICAgICAgfSkpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9mcy9yZWFkJykge1xyXG4gICAgICAvLyBcdTY1ODdcdTRFRjZcdTk4ODRcdTg5QzgoNjRLQiBcdTRFMEFcdTk2NTBcdThCRURcdTRFNDk7ZmFrZSBcdThGRDRcdTU2REVcdTU2RkFcdTVCOUFcdTY1ODdcdTY3MkMpXHJcbiAgICAgIGNvbnN0IHAgPSB1cmwuc2VhcmNoUGFyYW1zLmdldCgncGF0aCcpID8/ICcnO1xyXG4gICAgICBpZiAocCA9PT0gJycpIHtcclxuICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAncGF0aCByZXF1aXJlZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgICAgfVxyXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcclxuICAgICAgICBwYXRoOiBwLCByZWw6IHAuc3BsaXQoL1tcXFxcL10vKS5wb3AoKSA/PyBwLCBzaXplOiA0MixcclxuICAgICAgICB0ZXh0OiAnIyBkZW1vIHdvcmtzcGFjZVxcblxcblx1OEZEOVx1NjYyRiBmYWtlIGhvc3QgXHU3Njg0XHU2NTg3XHU0RUY2XHU5ODg0XHU4OUM4XHU1MTg1XHU1QkI5XHUzMDAyXFxuJyxcclxuICAgICAgfSkpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9kaWZmJykge1xyXG4gICAgICAvLyBEaWZmIFx1OTc2Mlx1Njc3RihcdTRFMEUgaG1oYXJuZXNzIC9hcGkvZGlmZiBcdTU0MENcdTVGNjI7ZmFrZSBcdThGRDRcdTU2REVcdTU2RkFcdTVCOUFcdTVDMEZcdTUzRDhcdTY2RjRcdTk2QzYpXHJcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xyXG4gICAgICAgIGdpdDogdHJ1ZSwgY3dkOiAnQzpcXFxcZGVtbycsXHJcbiAgICAgICAgY2hhbmdlZDogW1xyXG4gICAgICAgICAgeyBzdGF0ZTogJ00nLCBwYXRoOiAnc3JjL2FwcC50cycgfSxcclxuICAgICAgICAgIHsgc3RhdGU6ICdBJywgcGF0aDogJ2RvY3Mvbm90ZXMubWQnIH0sXHJcbiAgICAgICAgXSxcclxuICAgICAgICBzdGF0OiAnIHNyYy9hcHAudHMgICAgICB8IDEyICsrKysrKystLS1cXG4gZG9jcy9ub3Rlcy5tZCAgIHwgIDQgKysrK1xcbiAyIGZpbGVzIGNoYW5nZWQsIDE2IGluc2VydGlvbnMoKyksIDMgZGVsZXRpb25zKC0pJyxcclxuICAgICAgfSkpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS93b3Jrc3BhY2VzJykge1xyXG4gICAgICAvLyBcdTVERTVcdTRGNUNcdTUzM0EoXHU0RTBFIGhtaGFybmVzcyBcdTU0MENcdTVGNjI6Y3VycmVudCArIGl0ZW1zKVxyXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcclxuICAgICAgICBjdXJyZW50OiBmYWtlV29ya3NwYWNlcy5jdXJyZW50LFxyXG4gICAgICAgIGl0ZW1zOiBmYWtlV29ya3NwYWNlcy5pdGVtcyxcclxuICAgICAgfSkpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvd29ya3NwYWNlcycpIHtcclxuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7IG5hbWU/OiB1bmtub3duOyBwYXRoPzogdW5rbm93biB9O1xyXG4gICAgICAgIGNvbnN0IHBhdGggPSB0eXBlb2YgYm9keS5wYXRoID09PSAnc3RyaW5nJyA/IGJvZHkucGF0aCA6ICcnO1xyXG4gICAgICAgIGNvbnN0IG5hbWUgPSB0eXBlb2YgYm9keS5uYW1lID09PSAnc3RyaW5nJyAmJiBib2R5Lm5hbWUgIT09ICcnID8gYm9keS5uYW1lIDogKHBhdGguc3BsaXQoL1tcXFxcL10vKS5maWx0ZXIoQm9vbGVhbikucG9wKCkgPz8gJycpO1xyXG4gICAgICAgIGlmIChwYXRoID09PSAnJyB8fCBuYW1lID09PSAnJykge1xyXG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnYWJzb2x1dGUgcGF0aCBhbmQgbmFtZSByZXF1aXJlZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xyXG4gICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoZmFrZVdvcmtzcGFjZXMuaXRlbXMuc29tZSgodykgPT4gdy5wYXRoLnRvTG93ZXJDYXNlKCkgPT09IHBhdGgudG9Mb3dlckNhc2UoKSkpIHtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA5LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3dvcmtzcGFjZSBhbHJlYWR5IHJlZ2lzdGVyZWQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcclxuICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgaXRlbSA9IHsgaWQ6IGB3cy0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDgpfWAsIG5hbWUsIHBhdGggfTtcclxuICAgICAgICBmYWtlV29ya3NwYWNlcy5pdGVtcy5wdXNoKGl0ZW0pO1xyXG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlLCBjdXJyZW50OiBmYWtlV29ya3NwYWNlcy5jdXJyZW50LCBpdGVtczogZmFrZVdvcmtzcGFjZXMuaXRlbXMgfSkpO1xyXG4gICAgICB9KSgpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvd29ya3NwYWNlcy91c2UnKSB7XHJcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgoYXdhaXQgcmVhZEJvZHkoKSkgfHwgJ3t9JykgYXMgeyBpZD86IHVua25vd24gfTtcclxuICAgICAgICBjb25zdCBoaXQgPSBmYWtlV29ya3NwYWNlcy5pdGVtcy5maW5kKCh3KSA9PiB3LmlkID09PSBib2R5LmlkKTtcclxuICAgICAgICBpZiAoaGl0ID09PSB1bmRlZmluZWQpIHtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3dvcmtzcGFjZSBub3QgZm91bmQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcclxuICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgZmFrZVdvcmtzcGFjZXMuY3VycmVudCA9IGhpdC5pZDtcclxuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgY3VycmVudDogZmFrZVdvcmtzcGFjZXMuY3VycmVudCwgaXRlbXM6IGZha2VXb3Jrc3BhY2VzLml0ZW1zIH0pKTtcclxuICAgICAgfSkoKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3Byb3ZpZGVycycpIHtcclxuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7IG5hbWU/OiB1bmtub3duOyBiYXNlVXJsPzogdW5rbm93bjsgbW9kZWw/OiB1bmtub3duOyBhcGlLZXk/OiB1bmtub3duIH07XHJcbiAgICAgICAgY29uc3QgbmFtZSA9IHR5cGVvZiBib2R5Lm5hbWUgPT09ICdzdHJpbmcnID8gYm9keS5uYW1lLnRyaW0oKSA6ICcnO1xyXG4gICAgICAgIGNvbnN0IGJhc2VVcmwgPSB0eXBlb2YgYm9keS5iYXNlVXJsID09PSAnc3RyaW5nJyA/IGJvZHkuYmFzZVVybC50cmltKCkgOiAnJztcclxuICAgICAgICBjb25zdCBtb2RlbCA9IHR5cGVvZiBib2R5Lm1vZGVsID09PSAnc3RyaW5nJyA/IGJvZHkubW9kZWwudHJpbSgpIDogJyc7XHJcbiAgICAgICAgaWYgKG5hbWUgPT09ICcnIHx8IGJhc2VVcmwgPT09ICcnIHx8IG1vZGVsID09PSAnJykge1xyXG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnbmFtZSwgYmFzZVVybCBhbmQgbW9kZWwgYXJlIHJlcXVpcmVkJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XHJcbiAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGZha2VQcm92aWRlcnMuc2V0KG5hbWUsIHsgYmFzZVVybCwgbW9kZWwsIGFwaUtleTogdHlwZW9mIGJvZHkuYXBpS2V5ID09PSAnc3RyaW5nJyA/IGJvZHkuYXBpS2V5IDogJycgfSk7XHJcbiAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIG5hbWUgfSkpO1xyXG4gICAgICB9KSgpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9mcy9zZWFyY2gnKSB7XHJcbiAgICAgIC8vIFx1NURFNVx1NEY1Q1x1NTMzQVx1NjU4N1x1NEVGNlx1NjQxQ1x1N0QyMihcdTRFMEUgaG1oYXJuZXNzIFx1NTQwQ1x1NUY2MjpAXHU5NjQ0XHU0RUY2XHU5MDA5XHU2MkU5XHU1NjY4XHU3Njg0XHU2NTcwXHU2MzZFXHU2RTkwKVxyXG4gICAgICBjb25zdCBxID0gKHVybC5zZWFyY2hQYXJhbXMuZ2V0KCdxJykgPz8gJycpLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xyXG4gICAgICBjb25zdCBhbGwgPSBbXHJcbiAgICAgICAgeyByZWw6ICdSRUFETUUubWQnLCBwYXRoOiAnQzpcXFxcZGVtb1xcXFxSRUFETUUubWQnLCBraW5kOiAnZmlsZScgfSxcclxuICAgICAgICB7IHJlbDogJ3NyYy9hcHAudHMnLCBwYXRoOiAnQzpcXFxcZGVtb1xcXFxzcmNcXFxcYXBwLnRzJywga2luZDogJ2ZpbGUnIH0sXHJcbiAgICAgICAgeyByZWw6ICdkb2NzL25vdGVzLm1kJywgcGF0aDogJ0M6XFxcXGRlbW9cXFxcZG9jc1xcXFxub3Rlcy5tZCcsIGtpbmQ6ICdmaWxlJyB9LFxyXG4gICAgICBdO1xyXG4gICAgICBjb25zdCBoaXRzID0gcSA9PT0gJycgPyBhbGwgOiBhbGwuZmlsdGVyKChmKSA9PiBmLnJlbC50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHEpKTtcclxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IHJlc3VsdHM6IGhpdHMuc2xpY2UoMCwgMjApLCB0cnVuY2F0ZWQ6IGZhbHNlLCB0b3RhbDogaGl0cy5sZW5ndGggfSkpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9jb2duaXRpdmUnKSB7XHJcbiAgICAgIC8vIFx1OEJBNFx1NzdFNVx1NzJCNlx1NjAwMShcdTRFMEUgaG1oYXJuZXNzIGNvZ25pdGl2ZVN0YXR1cyBcdTU0MENcdTVGNjJcdTVCNTBcdTk2QzY7XHU3RjNBXHU2NTcwXHU2MzZFXHU2NjNFXHU1RjBGIG51bGwpXHJcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xyXG4gICAgICAgIG1lbW9yeTogeyBsYXllcnM6IDMsIGVudHJpZXM6IDEyLCBjb250cmFkaWN0aW9uczogMCB9LFxyXG4gICAgICAgIHRyYWplY3RvcmllczogNyxcclxuICAgICAgICBhdWRpdEV2ZW50czogMjEsXHJcbiAgICAgICAgd29ybGRNb2RlbDogeyB2ZXJzaW9uOiA0LCBiZWxpZWZzOiA5LCB0cnVzdGVkOiA1LCBicmllcjogMC4zMSB9LFxyXG4gICAgICAgIGNhbGlicmF0aW9uOiB7IHByZWRpY3Rpb25zOiA0NiwgcmVsaWFiaWxpdHk6IDAuNzIgfSxcclxuICAgICAgfSkpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZmFrZS9lbWl0Jykge1xyXG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7XHJcbiAgICAgICAgICAgIHNlc3Npb25JZDogc3RyaW5nOyBydW5JZDogc3RyaW5nOyBraW5kOiBFdmVudEtpbmQ7IHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xyXG4gICAgICAgICAgfTtcclxuICAgICAgICAgIGNvbnN0IHNlcSA9IGVtaXQoYm9keS5zZXNzaW9uSWQsIGJvZHkucnVuSWQsIGJvZHkua2luZCwgYm9keS5wYXlsb2FkKTtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIHNlcSB9KSk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsIFN0cmluZyhlcnIpLnNsaWNlKDAsIDEyMCksIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xyXG4gICAgICAgIH1cclxuICAgICAgfSkoKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCBgbm8gcm91dGUgJHtyZXEubWV0aG9kfSAke3VybC5wYXRobmFtZX1gLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcclxuICB9KTtcclxuXHJcbiAgYXdhaXQgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xyXG4gICAgc2VydmVyLm9uY2UoJ2Vycm9yJywgcmVqZWN0KTtcclxuICAgIHNlcnZlci5saXN0ZW4oMCwgJzEyNy4wLjAuMScsICgpID0+IHJlc29sdmUoKSk7XHJcbiAgfSk7XHJcbiAgY29uc3QgYWRkcmVzcyA9IHNlcnZlci5hZGRyZXNzKCk7XHJcbiAgaWYgKGFkZHJlc3MgPT09IG51bGwgfHwgdHlwZW9mIGFkZHJlc3MgIT09ICdvYmplY3QnKSB0aHJvdyBuZXcgRXJyb3IoJ2Zha2UgaG9zdDogbm8gcG9ydCcpO1xyXG4gIGNvbnN0IHBvcnQgPSBhZGRyZXNzLnBvcnQ7XHJcblxyXG4gIGlmICghb3B0cy5xdWlldCkge1xyXG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7SlNPTi5zdHJpbmdpZnkoeyBobWhEZXNrdG9wSG9zdFJlYWR5OiB0cnVlLCBwb3J0LCB2ZXJzaW9uOiAnZmFrZS0wLjAuMCcgfSl9XFxuYCk7XHJcbiAgfVxyXG4gIGNvbnN0IGRpZUFmdGVyID0gTnVtYmVyKHByb2Nlc3MuZW52LkZBS0VfSE9TVF9ESUVfQUZURVJfTVMgPz8gMCk7XHJcbiAgaWYgKE51bWJlci5pc0Zpbml0ZShkaWVBZnRlcikgJiYgZGllQWZ0ZXIgPiAwKSB7XHJcbiAgICBzZXRUaW1lb3V0KCgpID0+IHByb2Nlc3MuZXhpdCgxKSwgZGllQWZ0ZXIpLnVucmVmKCk7XHJcbiAgfVxyXG5cclxuICAvLyBjbG9zZSgpOiBcdTUxNDhcdTY1QURcdTVGMDBcdTUxNjhcdTkwRTggU1NFIFx1OEZERVx1NjNBNShcdTVCODNcdTRFRUNcdTZDMzhcdTRFMERcdTgxRUFcdTcxMzZcdTUxNzNcdTk1RUQpLFx1NTQyNlx1NTIxOSBzZXJ2ZXIuY2xvc2VcclxuICAvLyBcdTRGMUFcdTRFMDBcdTc2RjRcdTdCNDlcdTZEM0JcdThEQzNcdThGREVcdTYzQTUsXHU2RDRCXHU4QkQ1XHU4RkRCXHU3QTBCXHU2MzAyXHU2QjdCXHUzMDAyXHJcbiAgY29uc3QgY2xvc2UgPSAoKTogUHJvbWlzZTx2b2lkPiA9PlxyXG4gICAgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUpID0+IHtcclxuICAgICAgZm9yIChjb25zdCBjIG9mIHNzZUNsaWVudHMpIHtcclxuICAgICAgICB0cnkgeyBjLmVuZCgpOyBjLmRlc3Ryb3koKTsgfSBjYXRjaCB7IC8qIGFscmVhZHkgZ29uZSAqLyB9XHJcbiAgICAgIH1cclxuICAgICAgc3NlQ2xpZW50cy5jbGVhcigpO1xyXG4gICAgICBzZXJ2ZXIuY2xvc2UoKCkgPT4gcmVzb2x2ZSgpKTtcclxuICAgICAgc2V0VGltZW91dCgoKSA9PiByZXNvbHZlKCksIDFfMDAwKS51bnJlZigpO1xyXG4gICAgfSk7XHJcblxyXG4gIHJldHVybiB7IHBvcnQsIGVtaXQsIGNsb3NlIH07XHJcbn1cclxuXHJcbi8vIFx1NzZGNFx1NjNBNVx1OEZEMFx1ODg0QyhzdXBlcnZpc29yIHNwYXduIFx1NzY4NFx1NUI1MFx1OEZEQlx1N0EwQlx1NUY2Mlx1NjAwMSlcdTMwMDJyZWFscGF0aCBcdTZCRDRcdThGODM6bnBtIHdvcmtzcGFjZVxyXG4vLyBqdW5jdGlvbiAvIFx1NTkyN1x1NUMwRlx1NTE5OVx1NURFRVx1NUYwMlx1OTBGRFx1NEUwRFx1ODBGRFx1OEJBOVx1OEZEOVx1NEUyQVx1NjhDMFx1NkQ0Qlx1NTkzMVx1NjI0QihcdTU5MzFcdTYyNEI9XHU5NzU5XHU5RUQ4XHU5MDAwXHU1MUZBIGNvZGUgMCxcdTk2QkVcdTY3RTUpXHUzMDAyXHJcbi8vIGNqcyBidW5kbGUoZXNidWlsZCxcdTYyNTNcdTUzMDVcdTRFQTdcdTU0QzEpXHU0RTBCIF9fZmlsZW5hbWUgXHU1QjU4XHU1NzI4O0VTTSh0c3gvXHU2RTkwXHU3ODAxKVx1NzUyOCBpbXBvcnQubWV0YVx1MzAwMlxyXG5jb25zdCBzZWxmVXJsOiBzdHJpbmcgPSB0eXBlb2YgX19maWxlbmFtZSA9PT0gJ3N0cmluZydcclxuICA/IHBhdGhUb0ZpbGVVUkwocmVhbHBhdGhTeW5jKF9fZmlsZW5hbWUpKS5ocmVmXHJcbiAgOiBpbXBvcnQubWV0YS51cmw7XHJcbmNvbnN0IGludm9rZWRBc1NjcmlwdCA9ICgoKSA9PiB7XHJcbiAgaWYgKHByb2Nlc3MuYXJndlsxXSA9PT0gdW5kZWZpbmVkKSByZXR1cm4gZmFsc2U7XHJcbiAgdHJ5IHtcclxuICAgIHJldHVybiBzZWxmVXJsID09PSBwYXRoVG9GaWxlVVJMKHJlYWxwYXRoU3luYyhwcm9jZXNzLmFyZ3ZbMV0pKS5ocmVmO1xyXG4gIH0gY2F0Y2gge1xyXG4gICAgcmV0dXJuIGZhbHNlO1xyXG4gIH1cclxufSkoKTtcclxuaWYgKGludm9rZWRBc1NjcmlwdCkge1xyXG4gIGNvbnN0IHRva2VuID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVE9LRU4gPz8gJyc7XHJcbiAgLy8gRkFLRV9IT1NUX0RJRV9BVF9CT09UPTE6XHU1RjE1XHU1QkZDXHU4ODRDXHU4RjkzXHU1MUZBXHU1MjREXHU1MzczXHU2QjdCKFx1Njc4NFx1OTAyMFx1NTQyRlx1NTJBOFx1NjcxRiBSVU5USU1FX0NSQVNIRUQpXHJcbiAgaWYgKHByb2Nlc3MuZW52LkZBS0VfSE9TVF9ESUVfQVRfQk9PVCA9PT0gJzEnKSB7XHJcbiAgICBwcm9jZXNzLmV4aXQoMSk7XHJcbiAgfVxyXG4gIGNvbnN0IHNsb3cgPSBOdW1iZXIocHJvY2Vzcy5lbnYuRkFLRV9IT1NUX1NMT1dfQUZURVIgPz8gMCk7XHJcbiAgY29uc3QgYm9vdCA9ICgpOiB2b2lkID0+IHtcclxuICAgIHZvaWQgc3RhcnRGYWtlSG9zdCh7IHRva2VuIH0pLmNhdGNoKChlcnIpID0+IHtcclxuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYGZha2UtaG9zdCBmYWlsZWQ6ICR7U3RyaW5nKGVycil9XFxuYCk7XHJcbiAgICAgIHByb2Nlc3MuZXhpdCgxKTtcclxuICAgIH0pO1xyXG4gIH07XHJcbiAgaWYgKE51bWJlci5pc0Zpbml0ZShzbG93KSAmJiBzbG93ID4gMCkgc2V0VGltZW91dChib290LCBzbG93KTtcclxuICBlbHNlIGJvb3QoKTtcclxufVxyXG4iLCAiLyoqXHJcbiAqIFVJVkVSSUZZIFx1OTRBOVx1NUI1MCBcdTIwMTRcdTIwMTQgXHU5MDEwXHU1MjlGXHU4MEZEXHU3NzFGXHU1QjlFIFVJIFx1OUE3MVx1NTJBOFx1OUE4Q1x1NjUzNigyMDI2LTEwLTEwIFx1NzUyOFx1NjIzN1x1NjMwN1x1NEVFNDpcclxuICogXCJcdTVCRjlcdTZCQ0ZcdTRFMDBcdTRFMkFcdTUyOUZcdTgwRkQsXHU2QkNGXHU0RTAwXHU0RTJBXHU0RTFBXHU1MkExXHU2RDQxXHU3QTBCXHU1MTY4XHU5NzYyXHU3Njg0XHU5QThDXHU2NTM2XCIpXHUzMDAyXHJcbiAqXHJcbiAqIFx1NzZGNFx1NjNBNVx1NUJGOVx1NkUzMlx1NjdEM1x1NTQwRVx1NzY4NCBET00gXHU2NUFEXHU4QTAwKFx1NUUwM1x1NUM0MFx1NTFFMFx1NEY1NS9cdTUzRUZcdTg5QzFcdTYwMjcpLFx1NUU3Nlx1NzUyOFx1NTM5Rlx1NzUxRlx1NEU4Qlx1NEVGNlx1OUE3MVx1NTJBOCBSZWFjdFxyXG4gKiAoXHU1M0Q3XHU2M0E3XHU4RjkzXHU1MTY1XHU3NTI4XHU1MzlGXHU1NzhCIHNldHRlciArIGlucHV0IFx1NEU4Qlx1NEVGNjtcdTYzMDlcdTk0QUUgY2xpY2s7XHU5NTJFXHU3NkQ4XHU4RDcwIHdpbmRvd1xyXG4gKiBrZXlkb3duKVx1MzAwMmZha2UgXHU2QTIxXHU1RjBGXHU4REQxXHU1QjhDXHU2NTc0XHU0RUZCXHU1MkExXHU5NEZFKFx1NTNEMVx1OTAwMVx1MjE5Mlx1NURFNVx1NTE3N1x1MjE5Mlx1NUJBMVx1NjI3OVx1MjE5Mlx1NEVBNFx1NEVEOFx1NzI2OVx1MjE5Mlx1NkM0N1x1NjAzQik7XHJcbiAqIHJlYWwgXHU2QTIxXHU1RjBGXHU1M0VBXHU4REQxXHU1M0VBXHU4QkZCXHU1QjUwXHU5NkM2KFx1NEUwRFx1NTJBOFx1NzcxRlx1NUI5RVx1NEYxQVx1OEJERFx1MzAwMVx1NEUwRFx1NzBFNyB0b2tlbilcdTMwMDJcclxuICogXHU2QkNGXHU2QjY1XHU4RjkzXHU1MUZBIGBVSVZFUklGWSBQQVNTfEZBSUwgbmFtZSB8IGRldGFpbGAsXHU3RUQzXHU1QzNFIFNVTU1BUlksZXhpdCBjb2RlXHUzMDAyXHJcbiAqL1xyXG5pbXBvcnQgeyBhcHAsIHR5cGUgQnJvd3NlcldpbmRvdyB9IGZyb20gJ2VsZWN0cm9uJztcclxuaW1wb3J0IHsgbWtkaXIsIHdyaXRlRmlsZSB9IGZyb20gJ25vZGU6ZnMvcHJvbWlzZXMnO1xyXG5pbXBvcnQgeyBqb2luIH0gZnJvbSAnbm9kZTpwYXRoJztcclxuXHJcbmNvbnN0IHNsZWVwID0gKG1zOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+ID0+IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIG1zKSk7XHJcblxyXG5hc3luYyBmdW5jdGlvbiBydW5VaVZlcmlmeSh3aW46IEJyb3dzZXJXaW5kb3csIG1vZGU6ICdmYWtlJyB8ICdyZWFsJyk6IFByb21pc2U8dm9pZD4ge1xyXG4gIGNvbnN0IHNob3RzID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfU0hPVFMgPz8gam9pbihhcHAuZ2V0UGF0aCgndGVtcCcpLCAnaG1oLXVpdmVyaWZ5Jyk7XHJcbiAgYXdhaXQgbWtkaXIoc2hvdHMsIHsgcmVjdXJzaXZlOiB0cnVlIH0pLmNhdGNoKCgpID0+IHVuZGVmaW5lZCk7XHJcbiAgY29uc3QgcmVzdWx0czogQXJyYXk8W3N0cmluZywgYm9vbGVhbiwgc3RyaW5nXT4gPSBbXTtcclxuICBsZXQgc2hvdElkeCA9IDA7XHJcblxyXG4gIGNvbnN0IGpzID0gPFQ+KGNvZGU6IHN0cmluZyk6IFByb21pc2U8VD4gPT4gd2luLndlYkNvbnRlbnRzLmV4ZWN1dGVKYXZhU2NyaXB0KGNvZGUsIHRydWUpIGFzIFByb21pc2U8VD47XHJcbiAgY29uc3Qgc3RlcCA9IGFzeW5jIChuYW1lOiBzdHJpbmcsIGZuOiAoKSA9PiBQcm9taXNlPFtib29sZWFuLCBzdHJpbmddPik6IFByb21pc2U8dm9pZD4gPT4ge1xyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3QgW29rLCBkZXRhaWxdID0gYXdhaXQgZm4oKTtcclxuICAgICAgcmVzdWx0cy5wdXNoKFtuYW1lLCBvaywgZGV0YWlsXSk7XHJcbiAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgY29uc3QgZGV0YWlsID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgJiYgZXJyLnN0YWNrICE9PSB1bmRlZmluZWQgPyBlcnIuc3RhY2sgOiBTdHJpbmcoZXJyKTtcclxuICAgICAgcmVzdWx0cy5wdXNoKFtuYW1lLCBmYWxzZSwgZGV0YWlsLnNsaWNlKDAsIDMwMCldKTtcclxuICAgIH1cclxuICAgIGNvbnN0IGxhc3QgPSByZXN1bHRzW3Jlc3VsdHMubGVuZ3RoIC0gMV0hO1xyXG4gICAgY29uc29sZS5sb2coYFVJVkVSSUZZICR7bGFzdFsxXSA/ICdQQVNTJyA6ICdGQUlMJ30gfCAke2xhc3RbMF19IHwgJHtsYXN0WzJdfWApO1xyXG4gIH07XHJcbiAgLyoqIFx1OEY2RVx1OEJFMlx1NzZGNFx1NTIzMCBwcmVkaWNhdGVDb2RlIFx1OEZENFx1NTZERSB7b2s6dHJ1ZSwuLi59IFx1NjIxNlx1OEQ4NVx1NjVGNihcdThGRDRcdTU2REVcdTY3MDBcdTU0MEVcdTc2ODQgZGV0YWlsKVx1MzAwMiAqL1xyXG4gIGNvbnN0IHdhaXRGb3IgPSBhc3luYyAobGFiZWw6IHN0cmluZywgcHJlZGljYXRlQ29kZTogc3RyaW5nLCB0aW1lb3V0TXM6IG51bWJlcik6IFByb21pc2U8W2Jvb2xlYW4sIHN0cmluZ10+ID0+IHtcclxuICAgIGNvbnN0IHN0YXJ0ZWQgPSBEYXRlLm5vdygpO1xyXG4gICAgZm9yICg7Oykge1xyXG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdHJ5IHsgcmV0dXJuIEpTT04uc3RyaW5naWZ5KChmdW5jdGlvbigpeyAke3ByZWRpY2F0ZUNvZGV9IH0pKCkpOyB9IGNhdGNoKGUpeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe29rOmZhbHNlLCBkZXRhaWw6U3RyaW5nKGUpLnNsaWNlKDAsMTIwKX0pOyB9IH0pKClgKSkgYXMgc3RyaW5nO1xyXG4gICAgICBsZXQgcGFyc2VkOiB7IG9rPzogYm9vbGVhbjsgZGV0YWlsPzogc3RyaW5nIH07XHJcbiAgICAgIHRyeSB7IHBhcnNlZCA9IEpTT04ucGFyc2UocikgYXMgeyBvaz86IGJvb2xlYW47IGRldGFpbD86IHN0cmluZyB9OyB9IGNhdGNoIHsgcGFyc2VkID0geyBvazogZmFsc2UsIGRldGFpbDogU3RyaW5nKHIpLnNsaWNlKDAsIDEyMCkgfTsgfVxyXG4gICAgICBpZiAocGFyc2VkLm9rID09PSB0cnVlKSByZXR1cm4gW3RydWUsIFN0cmluZyhwYXJzZWQuZGV0YWlsID8/ICcnKV07XHJcbiAgICAgIGlmIChEYXRlLm5vdygpIC0gc3RhcnRlZCA+IHRpbWVvdXRNcykgcmV0dXJuIFtmYWxzZSwgYCR7bGFiZWx9OiAke1N0cmluZyhwYXJzZWQuZGV0YWlsID8/ICd0aW1lb3V0Jyl9YF07XHJcbiAgICAgIGF3YWl0IHNsZWVwKDI1MCk7XHJcbiAgICB9XHJcbiAgfTtcclxuICBjb25zdCBzaG90ID0gYXN5bmMgKGxhYmVsOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+ID0+IHtcclxuICAgIHNob3RJZHggKz0gMTtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IGltZyA9IGF3YWl0IHdpbi53ZWJDb250ZW50cy5jYXB0dXJlUGFnZSgpO1xyXG4gICAgICBhd2FpdCB3cml0ZUZpbGUoam9pbihzaG90cywgYCR7bW9kZX0tJHtTdHJpbmcoc2hvdElkeCkucGFkU3RhcnQoMiwgJzAnKX0tJHtsYWJlbH0ucG5nYCksIGltZy50b1BORygpKTtcclxuICAgIH0gY2F0Y2ggeyAvKiBcdTYyMkFcdTU2RkVcdTU5MzFcdThEMjVcdTRFMERcdTUyMjRcdTZCN0IgKi8gfVxyXG4gIH07XHJcblxyXG4gIC8qIC0tLS0gXHU1M0Q3XHU2M0E3XHU4RjkzXHU1MTY1KFJlYWN0Olx1NTM5Rlx1NTc4QiBzZXR0ZXIgXHU4OUU2XHU1M0QxIG9uQ2hhbmdlKSAtLS0tICovXHJcbiAgY29uc3QgdHlwZUludG8gPSAoc2VsOiBzdHJpbmcsIHRleHQ6IHN0cmluZyk6IFByb21pc2U8dW5rbm93bj4gPT5cclxuICAgIGpzKGAoZnVuY3Rpb24oKXtcclxuICAgICAgdmFyIGVsID0gZG9jdW1lbnQucXVlcnlTZWxlY3Rvcigke0pTT04uc3RyaW5naWZ5KHNlbCl9KTtcclxuICAgICAgaWYgKCFlbCkgcmV0dXJuICdOT0VMJztcclxuICAgICAgdmFyIHByb3RvID0gZWwudGFnTmFtZSA9PT0gJ1RFWFRBUkVBJyA/IEhUTUxUZXh0QXJlYUVsZW1lbnQucHJvdG90eXBlIDogSFRNTElucHV0RWxlbWVudC5wcm90b3R5cGU7XHJcbiAgICAgIE9iamVjdC5nZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IocHJvdG8sICd2YWx1ZScpLnNldC5jYWxsKGVsLCAke0pTT04uc3RyaW5naWZ5KHRleHQpfSk7XHJcbiAgICAgIGVsLmRpc3BhdGNoRXZlbnQobmV3IEV2ZW50KCdpbnB1dCcsIHsgYnViYmxlczogdHJ1ZSB9KSk7XHJcbiAgICAgIHJldHVybiAnT0snO1xyXG4gICAgfSkoKWApO1xyXG5cclxuICAvKiAtLS0tIFx1NTQyRlx1NTJBOFx1N0I0OVx1NUY4NTpSZWFjdCBcdTYzMDJcdThGN0QgKyBob3N0IFx1N0VGRlx1NzBCOShyZWFsIFx1NzY4NCBobWhhcm5lc3MgXHU1MUI3XHU1NDJGXHU1MkE4XHU4OTgxXHU3RjE2XHU4QkQxXHJcbiAgICAgXHU2NTc0XHU1OTU3IENMSSBcdTRGOURcdThENTYsXHU1M0VGXHU1MjMwIDMwcys7XHU0RTBEXHU3QjQ5XHU3RUZGXHU3MEI5XHU1QzMxXHU1RjAwXHU4REQxXHU0RjFBXHU1MTY4XHU5MEU4XHU4RDg1XHU2NUY2XHU4QkVGXHU2MkE1KSAtLS0tICovXHJcbiAgYXdhaXQgd2FpdEZvcignaG9zdCByZWFkeScsIGB2YXIgdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY29tcG9zZXIgdGV4dGFyZWEnKTsgcmV0dXJuIHtvazogISF0LCBkZXRhaWw6IHQgPyAnbW91bnRlZCcgOiAnbm8gY29tcG9zZXInfTtgLCAyMF8wMDApO1xyXG4gIGF3YWl0IHdhaXRGb3IoJ2hvc3QgZG90IG9uJywgYHZhciBkPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ob3N0LWRvdCcpOyByZXR1cm4ge29rOiAhIWQgJiYgZC5jbGFzc0xpc3QuY29udGFpbnMoJ29uJyksIGRldGFpbDogZCA/IGQuY2xhc3NOYW1lIDogJ25vIGRvdCd9O2AsIG1vZGUgPT09ICdyZWFsJyA/IDYwXzAwMCA6IDIwXzAwMCk7XHJcbiAgYXdhaXQgc2xlZXAoMV8yMDApOyAvLyBcdTRGMUFcdThCRERcdTUyMTdcdTg4NjgvXHU5ODc2XHU2ODBGXHU2NTcwXHU2MzZFXHU4NDNEXHU1NzMwXHJcblxyXG4gIC8qKiBcdTdFREZcdTRFMDBcdTY1MzZcdTVDM0U6U1VNTUFSWSArIFx1NjMwOVx1NTkzMVx1OEQyNVx1NjU3MFx1OTAwMFx1NTFGQVx1MzAwMiAqL1xyXG4gIGNvbnN0IGZpbmlzaCA9ICgpOiB2b2lkID0+IHtcclxuICAgIGNvbnN0IGZhaWxlZCA9IHJlc3VsdHMuZmlsdGVyKChyKSA9PiAhclsxXSkubGVuZ3RoO1xyXG4gICAgY29uc29sZS5sb2coYFVJVkVSSUZZIFNVTU1BUlkgcGFzcz0ke3Jlc3VsdHMubGVuZ3RoIC0gZmFpbGVkfS8ke3Jlc3VsdHMubGVuZ3RofSBtb2RlPSR7bW9kZX0gc2hvdHM9JHtzaG90c31gKTtcclxuICAgIGFwcC5leGl0KGZhaWxlZCA9PT0gMCA/IDAgOiAxKTtcclxuICB9O1xyXG5cclxuICAvKiA9PT09PT09PT09IFx1NEUxM1x1NzUyODpcdTc3MUZcdTVCOUVcdTY2RjRcdTY1QjBcdTUxNjhcdTZENDFcdTdBMEJcdTlBOENcdTY1MzYoXHU0RUZCXHU1MkExIDEzLUM7XHU5QTcxXHU1MkE4XHU1NjY4IC0tdXBkYXRlLXJlYWwpXHJcbiAgICAgXHU1MjREXHU3RjZFIGVudjpITUhfREVTS1RPUF9VUERBVEVfRk9SQ0VfVEFHIFx1OTc1RVx1N0E3QShcdTVGM0FcdTUyMzZcdTg5QzZcdTRFM0FcdTY3MDlcdTY2RjRcdTY1QjAsXHU1RjUzXHU1MjREIDAuMi45XHJcbiAgICAgPT0gbGF0ZXN0IDAuMi45IFx1NEVDRFx1OEQ3MFx1NEUwQlx1OEY3RClcdTMwMDJcdThENzBcdTc3MUZcdTVCOUVcdTY4QzBcdTY3RTVcdTk0RkUoZGlyZWN0IFx1MjE5MiBhdG9tZ2l0IFx1MjE5MiBcdTIwMjYpXHUyMTkyIFx1NTQwRVx1NTNGMFxyXG4gICAgIFx1NkQ0MVx1NUYwRlx1NEUwQlx1OEY3RFx1NzcxRlx1NUI5RSBTZXR1cCgxMTJNQixhdG9tZ2l0IFx1OEQ0NFx1NEVBNylcdTIxOTIgZG93bmxvYWRlZCBcdTZBMkFcdTVFNDVcdTMwMDJcdTUzRUFcdTY1QURcdThBMDBcdTVDMzFcdTdFRUEsXHJcbiAgICAgXHU3RUREXHU0RTBEXHU3MEI5XHU1MUZCXCJcdTkxQ0RcdTU0MkZcdTY2RjRcdTY1QjBcIihcdTkwN0ZcdTUxNERcdTYyOEFcdTVGMDBcdTUzRDFcdTY3M0FcdTc2ODQgZWxlY3Ryb24gZGlzdCBcdTg4QzVcdTU3NEYpXHUzMDAyICovXHJcbiAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX1VQREFURSA9PT0gJ3JlYWwnKSB7XHJcbiAgICBhd2FpdCBzdGVwKCdcdTY2RjRcdTY1QjAoXHU3NzFGXHU1QjlFKTpcdTU0MkZcdTUyQTggMzBzIFx1ODFFQVx1NTJBOFx1NjhDMFx1NjdFNSBcdTIxOTIgYXRvbWdpdC9cdTk1NUNcdTUwQ0ZcdTkwMUFcdTkwNTNcdTU0N0RcdTRFMkQgXHUyMTkyIFx1NTQwRVx1NTNGMFx1NEUwQlx1OEY3RFx1OEZEQlx1NUVBNlx1NkEyQVx1NUU0NVx1NTFGQVx1NzNCMCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2Rvd25sb2FkaW5nIG9yIHJlYWR5IGJhbm5lcicsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudXBkYXRlLWJhbm5lcicpO1xyXG4gICAgICAgIGlmKCFiKSByZXR1cm4ge29rOmZhbHNlLCBkZXRhaWw6J25vIGJhbm5lciB5ZXQnfTtcclxuICAgICAgICB2YXIgdD1iLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogdHJ1ZSwgZGV0YWlsOiB0LnNsaWNlKDAsOTApfTtgLCAxNTBfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc2hvdCgndXBkYXRlLXJlYWwtZG93bmxvYWRpbmcnKTtcclxuICAgIGF3YWl0IHN0ZXAoJ1x1NjZGNFx1NjVCMChcdTc3MUZcdTVCOUUpOjExMk1CIFx1NkQ0MVx1NUYwRlx1NEUwQlx1OEY3RFx1NUI4Q1x1NjIxMCBcdTIxOTIgXCJcdTkxQ0RcdTU0MkZcdTY2RjRcdTY1QjBcIlx1NkEyQVx1NUU0NVx1NUMzMVx1N0VFQShcdTRFMERcdTcwQjlcdTUxRkIsXHU0RTBEXHU1Qjg5XHU4OEM1KScsIGFzeW5jICgpID0+IHtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ3JlYWR5IGJhbm5lcicsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudXBkYXRlLWJhbm5lcicpO1xyXG4gICAgICAgIHZhciBidG49Yj9iLnF1ZXJ5U2VsZWN0b3IoJy51cGRhdGUtcmVzdGFydCcpOm51bGw7XHJcbiAgICAgICAgdmFyIGxpbmtzPWI/Yi5xdWVyeVNlbGVjdG9yQWxsKCdhJykubGVuZ3RoOi0xO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYnRuICYmIGJ0bi5kaXNhYmxlZD09PWZhbHNlICYmIGxpbmtzPT09MCwgZGV0YWlsOiBiID8gYi50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsOTApIDogJ25vIGJhbm5lcid9O2AsIDkwMF8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzaG90KCd1cGRhdGUtcmVhbC1yZWFkeScpO1xyXG4gICAgYXdhaXQgc3RlcCgnXHU2NkY0XHU2NUIwKFx1NzcxRlx1NUI5RSk6Y29tcG9zZXIvXHU0RkE3XHU2ODBGXHU0RTBEXHU1M0Q3XHU2QTJBXHU1RTQ1XHU2MzI0XHU1MzhCKFx1NEVGQlx1NTJBMVx1NTMzQVx1NTNFRlx1NzUyOCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoYChmdW5jdGlvbigpe1xyXG4gICAgICAgIHZhciB0YT1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY29tcG9zZXIgdGV4dGFyZWEnKSwgc2I9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXInKTtcclxuICAgICAgICB2YXIgdHI9dGE/dGEuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk6bnVsbDtcclxuICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe3RhOiAhIXRyICYmIHRyLmhlaWdodD4zMCAmJiB0ci5ib3R0b208PXdpbmRvdy5pbm5lckhlaWdodCwgc2I6ICEhc2IgJiYgZ2V0Q29tcHV0ZWRTdHlsZShzYikuZGlzcGxheSE9PSdub25lJ30pO1xyXG4gICAgICB9KSgpYCkpIGFzIHN0cmluZztcclxuICAgICAgY29uc3QgcCA9IEpTT04ucGFyc2UocikgYXMgeyB0YTogYm9vbGVhbjsgc2I6IGJvb2xlYW4gfTtcclxuICAgICAgcmV0dXJuIFtwLnRhICYmIHAuc2IsIGBjb21wb3NlciBcdTUzRUZcdTc1Mjg9JHtwLnRhfSBcdTRGQTdcdTY4MEZcdTZCNjNcdTVFMzg9JHtwLnNifWBdO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzaG90KCdmaW5hbCcpO1xyXG4gICAgZmluaXNoKCk7XHJcbiAgICByZXR1cm47XHJcbiAgfVxyXG5cclxuICAvKiA9PT09PT09PT09IFx1NEUxM1x1NzUyODpcdTRFRDNcdTVFOTNcdTk3NjJcdTY3N0ZcdTc3MUZcdTVCOUVcdTUxOTJcdTcwREYoXHU0RUZCXHU1MkExIDE0LUI7XHU5QTcxXHU1MkE4XHU1NjY4IC0tZm9yZ2UtcmVhbClcclxuICAgICBlbnY6SE1IX0RFU0tUT1BfVUlWRVJJRllfRk9SR0U9cmVhbCBcdTIxOTIgZm9yZ2UgXHU2NzBEXHU1MkExXHU0RTBEXHU4RDcwIGZpeHR1cmUsXHU3NkY0XHU4RkRFXHU2NzJDXHU2NzNBXHJcbiAgICAgZ2gvYWcoXHU1REYyXHU3NjdCXHU1RjU1IHN3c2dibCAvIGhvbmdmdSlcdTMwMDJcdTUzRUFcdThCRkI6XHU3NjdCXHU1RjU1XHU1MzYxL1x1NEVEM1x1NUU5M1x1NTIxN1x1ODg2OC9SZWxlYXNlIFx1NTIxN1x1ODg2ODtcclxuICAgICBcdTUxOTlcdTY0Q0RcdTRGNUMoXHU1NDA4XHU1RTc2L1x1NjVCMFx1NUVGQS9cdTUzRDFcdTVFMDMpXHU0RTBEXHU4OUU2XHU1M0QxXHUyMDE0XHUyMDE0XHU5NzYyXHU2NzdGXHU0RkE3XHU2NzJDXHU1QzMxXHU2NzA5XHU3ODZFXHU4QkE0XHU1MzYxXHU5NUU4XHUzMDAyaG9zdCBcdTRFQ0RcdThENzAgZmFrZSxcclxuICAgICBcdTRFRDNcdTVFOTNcdTk3NjJcdTY3N0ZcdTRFMEUgaG9zdCBcdTY1RTBcdTgwMjZcdTU0MDhcdTMwMDIgKi9cclxuICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfRk9SR0UgPT09ICdyZWFsJykge1xyXG4gICAgYXdhaXQgc3RlcCgnXHU0RUQzXHU1RTkzKFx1NzcxRlx1NUI5RSk6XHU1M0NDXHU1RTczXHU1M0YwXHU3NjdCXHU1RjU1XHU1MzYxIFx1MjAxNFx1MjAxNCBnaD1zd3NnYmwgLyBhZz1ob25nZnUnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdcdTRFRDNcdTVFOTMnfHx4LnRleHRDb250ZW50PT09J1JlcG9zJzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdib3RoIGxvZ2dlZCBpbicsIGB2YXIgZ2g9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignW2RhdGEtdGVzdGlkPVwiZm9yZ2UtaG9zdC1naXRodWJcIl0nKTtcclxuICAgICAgICB2YXIgYWc9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignW2RhdGEtdGVzdGlkPVwiZm9yZ2UtaG9zdC1hdG9tZ2l0XCJdJyk7XHJcbiAgICAgICAgdmFyIGdoT2sgPSAhIWdoICYmIGdoLnRleHRDb250ZW50LmluZGV4T2YoJ3N3c2dibCcpPj0wO1xyXG4gICAgICAgIHZhciBhZ09rID0gISFhZyAmJiBhZy50ZXh0Q29udGVudC5pbmRleE9mKCdob25nZnUnKT49MDtcclxuICAgICAgICByZXR1cm4ge29rOiBnaE9rICYmIGFnT2ssIGRldGFpbDogJ2doPScrKGdoP2doLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw0MCk6J25vbmUnKSsnIHwgYWc9JysoYWc/YWcudGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDQwKTonbm9uZScpfTtgLCAzMF8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzaG90KCdmb3JnZS1yZWFsLWhvc3RzJyk7XHJcbiAgICBhd2FpdCBzdGVwKCdcdTRFRDNcdTVFOTMoXHU3NzFGXHU1QjlFKTpHaXRIdWIgXHU2MjExXHU3Njg0XHU0RUQzXHU1RTkzXHU1MjE3XHU4ODY4IFx1MjI2NTEgXHU4ODRDJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignZ2l0aHViIHJlcG9zJywgYHZhciByb3dzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXRlc3RpZD1cImZvcmdlLXJlcG8tcm93XCJdJykubGVuZ3RoO1xyXG4gICAgICAgIHJldHVybiB7b2s6IHJvd3M+PTEsIGRldGFpbDogJ3Jvd3M9Jytyb3dzfTtgLCA0NV8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdcdTRFRDNcdTVFOTMoXHU3NzFGXHU1QjlFKTpcdTUyMDcgQXRvbUdpdCBcdTIxOTIgXHU1MjE3XHU1MUZBIGhvbmdmdSBcdTRFRDNcdTVFOTMoXHU1NDJCIGhtaC1kZXNrdG9wKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5mb3JnZS1ob3N0LWNoaXBzIC5mb3JnZS1jaGlwJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nQXRvbUdpdCc7fSk7IGlmKGMpIGMuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignYXRvbWdpdCByZXBvcycsIGB2YXIgcm93cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXRlc3RpZD1cImZvcmdlLXJlcG8tcm93XCJdJykpO1xyXG4gICAgICAgIHZhciBoaXQgPSByb3dzLnNvbWUoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignaG1oLWRlc2t0b3AnKT49MDt9KTtcclxuICAgICAgICByZXR1cm4ge29rOiByb3dzLmxlbmd0aD49MSAmJiBoaXQsIGRldGFpbDogJ3Jvd3M9Jytyb3dzLmxlbmd0aCsoaGl0PycgXHU1NDJCaG1oLWRlc2t0b3AnOicgXHU2NUUwaG1oLWRlc2t0b3AnKX07YCwgNDVfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc2hvdCgnZm9yZ2UtcmVhbC1hdG9tZ2l0LXJlcG9zJyk7XHJcbiAgICBhd2FpdCBzdGVwKCdcdTRFRDNcdTVFOTMoXHU3NzFGXHU1QjlFKTpcdThGREJcdTUxNjUgaG9uZ2Z1L2htaC1kZXNrdG9wIFx1MjE5MiBSZWxlYXNlIFx1NTIxN1x1ODg2OFx1NTQyQiB2MC4yLjEwJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciByPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtdGVzdGlkPVwiZm9yZ2UtcmVwby1yb3dcIl0nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdobWgtZGVza3RvcCcpPj0wO30pOyB2YXIgbT1yP3IucXVlcnlTZWxlY3RvcignLmZvcmdlLW1haW4nKTpudWxsOyBpZihtKSBtLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ3JlbGVhc2VzIHdpdGggdjAuMi4xMCcsIGB2YXIgcm93cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXRlc3RpZD1cImZvcmdlLXJlbGVhc2Utcm93XCJdJykpO1xyXG4gICAgICAgIHZhciBoaXQgPSByb3dzLnNvbWUoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZigndjAuMi4xMCcpPj0wO30pO1xyXG4gICAgICAgIHJldHVybiB7b2s6IHJvd3MubGVuZ3RoPj0xICYmIGhpdCwgZGV0YWlsOiAncmVsZWFzZXM9Jytyb3dzLmxlbmd0aCsoaGl0PycgXHU1NDJCdjAuMi4xMCc6JyBcdTY1RTB2MC4yLjEwO1x1OTk5Nlx1ODg0Qz0nKyhyb3dzWzBdP3Jvd3NbMF0udGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDUwKTonbm9uZScpKX07YCwgNDVfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc2hvdCgnZm9yZ2UtcmVhbC1yZWxlYXNlcycpO1xyXG4gICAgZmluaXNoKCk7XHJcbiAgICByZXR1cm47XHJcbiAgfVxyXG5cclxuICAvKiA9PT09PT09PT09IFx1OTAxQVx1NzUyODpcdTVFMDNcdTVDNDBcdTUxRTBcdTRGNTUoXHU3NTI4XHU2MjM3XHU2MkE1XHU5NjlDXHU3Njg0XHU3NkY0XHU2M0E1XHU2NUFEXHU4QTAwKSA9PT09PT09PT09ICovXHJcbiAgYXdhaXQgc3RlcCgnXHU1RTAzXHU1QzQwOlx1NjgwN1x1OTg5OFx1NjgwRitcdTRFMDlcdTY4MEYrY29tcG9zZXIgXHU1NzI4XHU4OUM2XHU1M0UzXHU1MTg1KFx1OEY5M1x1NTE2NVx1Njg0Nlx1NTNFRlx1ODlDMSknLCBhc3luYyAoKSA9PiB7XHJcbiAgICBjb25zdCByID0gKGF3YWl0IGpzKGAoZnVuY3Rpb24oKXtcclxuICAgICAgdmFyIHEgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yLmJpbmQoZG9jdW1lbnQpO1xyXG4gICAgICB2YXIgdGIgPSBxKCcudGl0bGViYXInKSwgc2hlbGwgPSBxKCcuYXBwLXNoZWxsJyksIHNiID0gcSgnLnNpZGViYXInKSwgd3MgPSBxKCcud29ya3NwYWNlJyksIHRhID0gcSgnLmNvbXBvc2VyIHRleHRhcmVhJyk7XHJcbiAgICAgIHZhciBtaXNzaW5nID0gWyF0YiAmJiAndGl0bGViYXInLCAhc2hlbGwgJiYgJ3NoZWxsJywgIXNiICYmICdzaWRlYmFyJywgIXdzICYmICd3b3Jrc3BhY2UnLCAhdGEgJiYgJ3RleHRhcmVhJ10uZmlsdGVyKEJvb2xlYW4pLmpvaW4oJywnKTtcclxuICAgICAgaWYgKG1pc3NpbmcgIT09ICcnKSByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe29rOmZhbHNlLCBkZXRhaWw6J21pc3Npbmc6JyttaXNzaW5nfSk7XHJcbiAgICAgIHZhciByID0gdGEuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCksIHZoID0gd2luZG93LmlubmVySGVpZ2h0LCB2dyA9IHdpbmRvdy5pbm5lcldpZHRoO1xyXG4gICAgICB2YXIgaGludCA9IHEoJy5lbXB0eS1oaW50LmJpZycpOyB2YXIgaHIgPSBoaW50ID8gaGludC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKSA6IG51bGw7XHJcbiAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh7IG9rOiByLmhlaWdodCA+IDMwICYmIHIuYm90dG9tIDw9IHZoICYmIHIud2lkdGggPiAxMDAgJiYgaHIgIT09IG51bGwgJiYgaHIudG9wID49IDAgJiYgaHIuYm90dG9tIDw9IHZoLFxyXG4gICAgICAgIGRldGFpbDogJ3RleHRhcmVhIHk9JytNYXRoLnJvdW5kKHIueSkrJyBoPScrTWF0aC5yb3VuZChyLmhlaWdodCkrJyBib3R0b209JytNYXRoLnJvdW5kKHIuYm90dG9tKSsnIHZoPScrdmgrKGhyID8gJyBoaW50IHk9JytNYXRoLnJvdW5kKGhyLnkpIDogJyBuby1oaW50JykgfSk7XHJcbiAgICB9KSgpYCkpIGFzIHN0cmluZztcclxuICAgIGNvbnN0IHAgPSBKU09OLnBhcnNlKHIpIGFzIHsgb2s6IGJvb2xlYW47IGRldGFpbDogc3RyaW5nIH07XHJcbiAgICByZXR1cm4gW3Aub2sgPT09IHRydWUsIHAuZGV0YWlsXTtcclxuICB9KTtcclxuXHJcbiAgaWYgKG1vZGUgPT09ICdmYWtlJykge1xyXG4gICAgLyogPT09PT09PT09PSBmYWtlKFx1NTQxMVx1NUJGQ1x1Njc4NFx1OTAyMCxITUhfREVTS1RPUF9VSVZFUklGWV9XSVpBUkQ9ZmFrZSk6XHJcbiAgICAgICBcdTRGMkFcdTkwMjBcdTY3MkFcdTkxNERcdTdGNkVcdTYwMDEgXHUyMTkyIFx1NTQxMVx1NUJGQ1x1NTFGQVx1NzNCMCBcdTIxOTIgXHU2OEMwXHU2RDRCKFx1NjcyQVx1ODhDNSlcdTIxOTIgXHU5MDA5XHU2MkU5IFx1MjE5MiBcdTUxODVcdTdGNkUgXHUyMTkyIFx1OEZERVx1NEUwQSA9PT09PT09PT09ICovXHJcbiAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfV0laQVJEID09PSAnZmFrZScpIHtcclxuICAgICAgYXdhaXQgc3RlcCgnXHU1NDExXHU1QkZDOlx1OTk5Nlx1NTQyRlx1NUYzOVx1NTFGQVx1NkIyMlx1OEZDRVx1OTg3NShcdTVGMDBcdTU5Q0JcdTkxNERcdTdGNkUvXHU2RjE0XHU3OTNBXHU1MTY1XHU1M0UzKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignd2l6YXJkIG92ZXJsYXknLCBgdmFyIG89ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1vdmVybGF5Jyk7XHJcbiAgICAgICAgICB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1RjAwXHU1OUNCXHU5MTREXHU3RjZFJzt9KTtcclxuICAgICAgICAgIHJldHVybiB7b2s6ICEhbyAmJiAhIWIsIGRldGFpbDogbyA/ICdvdmVybGF5K1x1NUYwMFx1NTlDQlx1OTE0RFx1N0Y2RScgOiAnbm8gb3ZlcmxheSd9O2AsIDEyXzAwMCk7XHJcbiAgICAgICAgYXdhaXQgc2hvdCgnd2l6YXJkLXdlbGNvbWUnKTtcclxuICAgICAgICByZXR1cm4gdztcclxuICAgICAgfSk7XHJcbiAgICAgIGF3YWl0IHN0ZXAoJ1x1NTQxMVx1NUJGQzpcdTVGMDBcdTU5Q0JcdTkxNERcdTdGNkVcdTIxOTJcdTY4QzBcdTZENEIoXHU0RjJBXHU5MDIwXHU2NzJBXHU4OEM1KVx1MjE5Mlx1NjcyQVx1ODhDNVx1NTM3M1x1ODFFQVx1NTJBOFx1NUI4OVx1ODhDNVx1OTg3NShcdThCRjRcdTY2MEVcdTZBMkFcdTVFNDUrXHU1MjA3XHU2MzYyXHU5NEZFXHU2M0E1KScsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTVGMDBcdTU5Q0JcdTkxNERcdTdGNkUnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignYXV0byBpbnN0YWxsIHBhZ2UnLCBgdmFyIHA9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLWluc3RhbGwnKTtcclxuICAgICAgICAgIGlmKCFwKSByZXR1cm4ge29rOmZhbHNlLCBkZXRhaWw6J25vdCBvbiBpbnN0YWxsJ307XHJcbiAgICAgICAgICB2YXIgdD1wLnRleHRDb250ZW50O1xyXG4gICAgICAgICAgdmFyIG5vdGU9dC5pbmRleE9mKCdcdTY3MkFcdTY4QzBcdTZENEJcdTUyMzAgaG1oIENMSSxcdTVERjJcdTgxRUFcdTUyQThcdTVGMDBcdTU5Q0JcdTVCODlcdTg4QzUnKT49MDtcclxuICAgICAgICAgIHZhciBsMT10LmluZGV4T2YoJ1x1NjUzOVx1NzUyOFx1NTE4NVx1N0Y2RVx1N0NCRVx1N0I4MFx1NTE4NVx1NjgzOCcpPj0wLCBsMj10LmluZGV4T2YoJ1x1NkYxNFx1NzkzQVx1NkEyMVx1NUYwRicpPj0wO1xyXG4gICAgICAgICAgdmFyIGJhcj0hIXAucXVlcnlTZWxlY3RvcignLndpemFyZC1wcm9ncmVzcycpO1xyXG4gICAgICAgICAgdmFyIHNlbD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2Utc2VsZWN0Jyk7XHJcbiAgICAgICAgICByZXR1cm4ge29rOiBub3RlJiZsMSYmbDImJmJhciYmIXNlbCwgZGV0YWlsOiAnbm90ZT0nK25vdGUrJyBcdTUxODVcdTdGNkVcdTk0RkVcdTYzQTU9JytsMSsnIFx1NkYxNFx1NzkzQVx1OTRGRVx1NjNBNT0nK2wyKycgYmFyPScrYmFyKycgc2VsZWN0TGVhaz0nKyEhc2VsfTtgLCAxMl8wMDApO1xyXG4gICAgICAgIGF3YWl0IHNob3QoJ3dpemFyZC1hdXRvLWluc3RhbGwnKTtcclxuICAgICAgICByZXR1cm4gdztcclxuICAgICAgfSk7XHJcbiAgICAgIGF3YWl0IHN0ZXAoJ1x1NTQxMVx1NUJGQzpcdTZBMkFcdTVFNDVcIlx1NjUzOVx1NzUyOFx1NTE4NVx1N0Y2RVx1N0NCRVx1N0I4MFx1NTE4NVx1NjgzOFwiXHUyMTkyXHU5MTREXHU3RjZFXHU4REYzXHU4RkM3XHUyMTkyXHU1QjhDXHU2MjEwXHU5ODc1XHUyMTkyXHU1RjAwXHU1OUNCXHU0RjdGXHU3NTI4XHUyMTkyXHU1MTczXHU5NUVEXHU0RTE0XHU1REYyXHU4RkRFXHU2M0E1JywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLXBhZ2UtaW5zdGFsbCAud2l6YXJkLWFsdC1saW5rJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU2NTM5XHU3NTI4XHU1MTg1XHU3RjZFXHU3Q0JFXHU3QjgwXHU1MTg1XHU2ODM4Jyk+PTA7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgIC8vIFx1OTE0RFx1N0Y2RVx1OTg3NTpmYWtlIHByb3ZpZGVycyBcdTVERjJcdTY3MDlcdTVCQzZcdTk0QTUgXHUyMTkyIFx1ODFFQVx1NTJBOFx1OERGM1x1OEZDNztcdTUxNUNcdTVFOTVcdTcwQjlcIlx1OERGM1x1OEZDN1wiXHJcbiAgICAgICAgYXdhaXQgd2FpdEZvcignY29uZmlnIG9yIGRvbmUnLCBgdmFyIGQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLWRvbmUnKTtcclxuICAgICAgICAgIGlmKGQpIHJldHVybiB7b2s6dHJ1ZSwgZGV0YWlsOidkb25lJ307XHJcbiAgICAgICAgICB2YXIgYz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtY29uZmlnJyk7XHJcbiAgICAgICAgICBpZihjKXsgdmFyIHM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU4REYzXHU4RkM3Jyk+PTA7fSk7IGlmKHMpIHMuY2xpY2soKTsgfVxyXG4gICAgICAgICAgcmV0dXJuIHtvazpmYWxzZSwgZGV0YWlsOid3YWl0aW5nJ307YCwgMTVfMDAwKTtcclxuICAgICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignZG9uZSBwYWdlJywgYHZhciBkPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1kb25lJyk7XHJcbiAgICAgICAgICB2YXIgdD1kP2QudGV4dENvbnRlbnQ6Jyc7XHJcbiAgICAgICAgICByZXR1cm4ge29rOiAhIWQgJiYgdC5pbmRleE9mKCdcdTVDMzFcdTdFRUEnKT49MCAmJiB0LmluZGV4T2YoJ1x1NTE3MVx1NEVBQicpPj0wLCBkZXRhaWw6IHQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDYwKX07YCwgOF8wMDApO1xyXG4gICAgICAgIGF3YWl0IHNob3QoJ3dpemFyZC1kb25lJyk7XHJcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1RjAwXHU1OUNCXHU0RjdGXHU3NTI4Jzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgY29uc3QgY2xvc2VkID0gYXdhaXQgd2FpdEZvcignd2l6YXJkIGNsb3NlZCArIGNvbm5lY3RlZCcsIGByZXR1cm4ge29rOiAhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1vdmVybGF5JykgJiYgISFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuaG9zdC1kb3Qub24nKSxcclxuICAgICAgICAgIGRldGFpbDogJ292ZXJsYXk9JysoZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1vdmVybGF5Jyk/J29wZW4nOidjbG9zZWQnKSsnIGRvdD0nKyhkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuaG9zdC1kb3Qub24nKT8nb24nOidvZmYnKX07YCwgMTBfMDAwKTtcclxuICAgICAgICByZXR1cm4gW3dbMF0gJiYgY2xvc2VkWzBdLCBgZG9uZTogJHt3WzFdfTsgJHtjbG9zZWRbMV19YF07XHJcbiAgICAgIH0pO1xyXG4gICAgfVxyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTk5OTZcdThERDFcdTVGMTVcdTVCRkNcdTVDNDIgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU1RjE1XHU1QkZDXHU1QzQyOlx1NkYxNFx1NzkzQVx1NkEyMVx1NUYwRlx1NjNEMFx1NzkzQVx1NTFGQVx1NzNCMFx1NUU3Nlx1NTNFRlx1NTE3M1x1OTVFRCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2d1aWRlJywgYHZhciBnPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ydW50aW1lLWd1aWRlJyk7IHJldHVybiB7b2s6ICEhZywgZGV0YWlsOiBnID8gJ3Nob3duJyA6ICdub3Qgc2hvd24nfTtgLCA4XzAwMCk7XHJcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXtcclxuICAgICAgICB2YXIgYnRucyA9IFtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnJ1bnRpbWUtZ3VpZGUgYnV0dG9uJykpO1xyXG4gICAgICAgIHZhciBiID0gYnRucy5maW5kKGZ1bmN0aW9uKHgpeyByZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTZGMTRcdTc5M0EnKSA+PSAwOyB9KTtcclxuICAgICAgICBpZiAoYikgYi5jbGljaygpO1xyXG4gICAgICB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdndWlkZSBnb25lJywgYHJldHVybiB7b2s6ICFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcucnVudGltZS1ndWlkZScpLCBkZXRhaWw6IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ydW50aW1lLWd1aWRlJykgPyAnc3RpbGwnIDogJ2Rpc21pc3NlZCd9O2AsIDVfMDAwKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTY1QjBcdTVFRkFcdTRGMUFcdThCREQoQ3RybCtOKSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdDdHJsK04gXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkRELFx1OEY5M1x1NTE2NVx1Njg0Nlx1NTNFRlx1NzUyOCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleTonbicsIGN0cmxLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCd0ZXh0YXJlYSBlbmFibGVkJywgYHZhciB0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jb21wb3NlciB0ZXh0YXJlYScpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhdCAmJiB0LmRpc2FibGVkID09PSBmYWxzZSAmJiAodC5wbGFjZWhvbGRlcnx8JycpLmluZGV4T2YoJ1x1NjNDRlx1OEZGMFx1NzZFRVx1NjgwNycpID49IDAsIGRldGFpbDogdCA/ICgnZGlzYWJsZWQ9Jyt0LmRpc2FibGVkKycgcGg9JysodC5wbGFjZWhvbGRlcnx8JycpLnNsaWNlKDAsMjApKSA6ICdubyB0YSd9O2AsIDVfMDAwKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTUzRDFcdTkwMDFcdTRFRkJcdTUyQTEgXHUyMTkyIFx1NzUyOFx1NjIzN1x1OEY2RVx1NTFGQVx1NzNCMChcdTRFMTRcdTRFQzVcdTRFMDBcdTY3NjEsXHU1M0NDXHU2RDg4XHU2MDZGXHU1NkRFXHU1RjUyKSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdThGOTNcdTUxNjVcdTVFNzZcdTUzRDFcdTkwMDFcdTRFRkJcdTUyQTEsXHU3NTI4XHU2MjM3XHU2RDg4XHU2MDZGXHU0RTBBXHU1QzRGXHU0RTE0XHU0RTBEXHU5MUNEXHU1OTBEJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCB0eXBlSW50bygnLmNvbXBvc2VyIHRleHRhcmVhJywgJ1x1OUE4Q1x1NjUzNlx1NEVGQlx1NTJBMTpcdTUxOTlcdTUxNjVcdTRFMDBcdTRFMkFcdTY1ODdcdTRFRjYnKTtcclxuICAgICAgYXdhaXQgc2xlZXAoMjAwKTtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpe1xyXG4gICAgICAgIHZhciBidG5zID0gW10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY29tcG9zZXIgYnV0dG9uJykpO1xyXG4gICAgICAgIHZhciBiID0gYnRucy5maW5kKGZ1bmN0aW9uKHgpeyByZXR1cm4geC50ZXh0Q29udGVudC50cmltKCkgPT09ICdcdTUzRDFcdTkwMDEnOyB9KTtcclxuICAgICAgICBpZiAoYikgYi5jbGljaygpO1xyXG4gICAgICB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdleGFjdGx5IG9uZSB1c2VyIHR1cm4nLCBgdmFyIHRzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnR1cm4udXNlcicpKS5maWx0ZXIoZnVuY3Rpb24oeCl7IHJldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1OUE4Q1x1NjUzNlx1NEVGQlx1NTJBMScpID49IDA7IH0pO1xyXG4gICAgICAgIHJldHVybiB7b2s6IHRzLmxlbmd0aCA9PT0gMSwgZGV0YWlsOiAnY291bnQ9Jyt0cy5sZW5ndGgrJyB0ZXh0PScrKHRzWzBdP3RzWzBdLnRleHRDb250ZW50LnNsaWNlKDAsMzApOidub25lJyl9O2AsIDhfMDAwKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTVERTVcdTUxNzdcdTUzNjEocmVhZF9maWxlIFx1NUI4Q1x1NjIxMCkgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU1REU1XHU1MTc3XHU2Mjk4XHU1M0UwXHU1MzYxOnJlYWRfZmlsZSBcdTYyNjdcdTg4NENcdTVFNzZcdTVCOENcdTYyMTAnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCd0b29sIGNhcmQnLCBgdmFyIGM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudG9vbC1jYXJkJykpO1xyXG4gICAgICAgIHZhciBkb25lID0gYy5maWx0ZXIoZnVuY3Rpb24oeCl7IHJldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ3JlYWRfZmlsZScpID49IDAgJiYgeC50ZXh0Q29udGVudC5pbmRleE9mKCcjIGRlbW8nKSA+PSAwOyB9KTtcclxuICAgICAgICByZXR1cm4ge29rOiBkb25lLmxlbmd0aCA+PSAxLCBkZXRhaWw6ICdjYXJkcz0nK2MubGVuZ3RoKycgZG9uZT0nK2RvbmUubGVuZ3RofTtgLCA4XzAwMCk7XHJcbiAgICAgIHJldHVybiB3O1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NUJBMVx1NjI3OVx1N0VCNVx1NTIwN1x1NzI0NyhcdTc1MjhcdTYyMzdcdTYyQTVcdTk2OUNcdTY4MzhcdTVGQzNcdTRFNEJcdTRFMDApID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1NUJBMVx1NjI3OTphcHByb3ZhbCBcdTUzNjFcdTUxRkFcdTczQjAoXHU3QjQ5XHU1Rjg1XHU0RUJBXHU1REU1XHU2Mjc5XHU1MUM2KScsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQgc2hvdCgnYXBwcm92YWwtcGVuZGluZycpO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignYXBwcm92YWwgY2FyZCcsIGB2YXIgYT1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuYXBwcm92YWwtY2FyZCcpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYSAmJiBhLnRleHRDb250ZW50LmluZGV4T2YoJ1x1OTcwMFx1ODk4MVx1NUJBMVx1NjI3OScpID49IDAsIGRldGFpbDogYSA/IGEudGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLCA2MCkgOiAnbm8gYXBwcm92YWwgY2FyZCd9O2AsIDhfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnXHU1QkExXHU2Mjc5Olx1NzBCOVx1NjI3OVx1NTFDNiBcdTIxOTIgXHU0RUZCXHU1MkExXHU3RUU3XHU3RUVEXHU1MjMwXHU0RUE0XHU0RUQ4XHU3MjY5K1x1NkM0N1x1NjAzQicsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpe1xyXG4gICAgICAgIHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmFwcHJvdmFsLWNhcmQgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7IHJldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTYyNzlcdTUxQzYnOyB9KTtcclxuICAgICAgICBpZiAoYikgYi5jbGljaygpO1xyXG4gICAgICB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdhcnRpZmFjdCtzdW0nLCBgdmFyIGFydD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuYXJ0aWZhY3QtY2FyZCcpO1xyXG4gICAgICAgIHZhciBzdW09ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnR1cm4tc3VtJyk7XHJcbiAgICAgICAgdmFyIGFzdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50dXJuJykpLmZpbHRlcihmdW5jdGlvbih4KXsgcmV0dXJuIHguY2xhc3NOYW1lLmluZGV4T2YoJ3VzZXInKTwwICYmIHgudGV4dENvbnRlbnQuaW5kZXhPZignZWNobzonKT49MDsgfSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFhcnQgJiYgISFzdW0gJiYgYXN0Lmxlbmd0aD49MSwgZGV0YWlsOiAnYXJ0aWZhY3Q9JysoYXJ0P2FydC50ZXh0Q29udGVudC5zbGljZSgwLDMwKTonbm9uZScpKycgc3VtPScrKHN1bT9zdW0udGV4dENvbnRlbnQ6J25vbmUnKSsnIGFuc3dlcmVkPScrYXN0Lmxlbmd0aH07YCwgMTJfMDAwKTtcclxuICAgICAgYXdhaXQgc2hvdCgncnVuLWNvbXBsZXRlZCcpO1xyXG4gICAgICByZXR1cm4gdztcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTUzODZcdTUzRjJcdTRGMUFcdThCRERcdTUxODVcdTVCQjkoXHU3NTI4XHU2MjM3XHU2MkE1XHU5NjlDXCJcdTc3MEJcdTRFMERcdTUyMzBcdTUxODVcdTVCQjlcIikgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU3MEI5XHU1MUZCXHU1Mzg2XHU1M0YyXHU0RjFBXHU4QkREIFx1MjE5MiB0cmFuc2NyaXB0IFx1NTE4NVx1NUJCOVx1NTNFRlx1ODlDMScsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgaXQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNlc3Npb24taXRlbScpOyBpZiAoaXQpIGl0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2hpc3RvcnkgdHVybnMnLCBgdmFyIHRzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnR1cm4nKSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogdHMubGVuZ3RoID49IDIsIGRldGFpbDogJ3R1cm5zPScrdHMubGVuZ3RoKycgZmlyc3Q9JysodHNbMF0/dHNbMF0udGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDQwKTonbm9uZScpfTtgLCA4XzAwMCk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU0RTk0XHU5ODc1XHU3QjdFID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ0RvY2s6T3ZlcnZpZXcgXHU2NTcwXHU2MzZFXHU4ODRDJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nT3ZlcnZpZXcnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ292ZXJ2aWV3IHJvd3MnLCBgdmFyIHJvd3M9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay1yb3cnKSk7XHJcbiAgICAgICAgdmFyIHZlciA9IHJvd3MuZmluZChmdW5jdGlvbihyKXsgcmV0dXJuIHIudGV4dENvbnRlbnQuaW5kZXhPZigncnVudGltZSBcdTcyNDhcdTY3MkMnKT49MDsgfSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogcm93cy5sZW5ndGggPj0gNSAmJiAhIXZlciwgZGV0YWlsOiAncm93cz0nK3Jvd3MubGVuZ3RoKyh2ZXI/JyB2ZXI9Jyt2ZXIudGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDQwKTonJyl9O2AsIDZfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnRG9jazpGaWxlcyBcdTZENEZcdTg5QzgrXHU2NTg3XHU0RUY2XHU5ODg0XHU4OUM4JywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nXHU2NTg3XHU0RUY2J3x8eC50ZXh0Q29udGVudD09PSdGaWxlcyc7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignZnMgcm93cycsIGB2YXIgcm93cz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZnMtcm93JykubGVuZ3RoO1xyXG4gICAgICAgIHJldHVybiB7b2s6IHJvd3MgPj0gMSwgZGV0YWlsOiAncm93cz0nK3Jvd3N9O2AsIDZfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgLy8gXHU2ODM5XHU3NkVFXHU1RjU1XHU1M0VBXHU2NzA5XHU1REU1XHU0RjVDXHU1MzNBXHU3NkVFXHU1RjU1KGZha2UgXHU0RTBFXHU3NzFGXHU1QjlFIHJ1bnRpbWUgXHU1NDBDXHU1RjYyKTpcdTUxNDhcdThGREJcdTc2RUVcdTVGNTUsXHU1MThEXHU3MEI5XHU2NTg3XHU0RUY2XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZnMtcm93JykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignZGVtby13b3Jrc3BhY2UnKT49MCB8fCB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1RDgzRFx1RENDMScpPj0wO30pOyBpZihkKSBkLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgdzIgPSBhd2FpdCB3YWl0Rm9yKCdmaWxlIHJvd3MnLCBgdmFyIHJvd3M9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZnMtcm93JykpO1xyXG4gICAgICAgIHJldHVybiB7b2s6IHJvd3Muc29tZShmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdSRUFETUUnKT49MDt9KSwgZGV0YWlsOiAncm93cz0nK3Jvd3MubGVuZ3RofTtgLCA2XzAwMCk7XHJcbiAgICAgIGlmICghdzJbMF0pIHJldHVybiB3MjtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgZj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5mcy1yb3cnKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdSRUFETUUnKT49MDt9KTsgaWYoZikgZi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdmaWxlIHByZXZpZXcnLCBgdmFyIHA9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmZzLXByZXZpZXcnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXAgJiYgcC50ZXh0Q29udGVudC5pbmRleE9mKCdkZW1vIHdvcmtzcGFjZScpID49IDAsIGRldGFpbDogcCA/IHAudGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDQwKSA6ICdubyBwcmV2aWV3J307YCwgNl8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdEb2NrOkRpZmYgXHU1M0Q4XHU2NkY0XHU4ODRDJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nXHU1M0Q4XHU2NkY0J3x8eC50ZXh0Q29udGVudD09PSdEaWZmJzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdkaWZmIHJvd3MnLCBgdmFyIHJvd3M9ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRpZmYtcm93JykubGVuZ3RoO1xyXG4gICAgICAgIHJldHVybiB7b2s6IHJvd3MgPj0gMSwgZGV0YWlsOiAnZGlmZiByb3dzPScrcm93c307YCwgNl8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdEb2NrOkV2aWRlbmNlIFx1OEJBNFx1NzdFNVx1NjU3MFx1NjM2RScsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J1x1OEJDMVx1NjM2RSd8fHgudGV4dENvbnRlbnQ9PT0nRXZpZGVuY2UnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2V2aWRlbmNlIHJvd3MnLCBgdmFyIHJvd3M9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay1yb3cnKSk7XHJcbiAgICAgICAgdmFyIG1lbSA9IHJvd3MuZmluZChmdW5jdGlvbihyKXsgcmV0dXJuIHIudGV4dENvbnRlbnQuaW5kZXhPZignXHU4QkIwXHU1RkM2XHU1QzQyJyk+PTAgfHwgci50ZXh0Q29udGVudC5pbmRleE9mKCdNZW1vcnkgbGF5ZXJzJyk+PTA7IH0pO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhbWVtICYmIG1lbS50ZXh0Q29udGVudC5pbmRleE9mKCczJykgPj0gMCwgZGV0YWlsOiBtZW0gPyBtZW0udGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKSA6ICdubyBtZW1vcnkgcm93J307YCwgNl8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdEb2NrOkxvZ3MgXHU5NzYyXHU2NzdGKFx1N0E3QVx1NjAwMVx1NjNEMFx1NzkzQSknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdcdTY1RTVcdTVGRDcnfHx4LnRleHRDb250ZW50PT09J0xvZ3MnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2xvZ3MgcGFuZScsIGB2YXIgbD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcubG9ncy1saXN0Jyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFsLCBkZXRhaWw6IGwgPyAoJ3Jvd3M9JytsLnF1ZXJ5U2VsZWN0b3JBbGwoJy5sb2ctcm93JykubGVuZ3RoKSA6ICdubyBsb2dzIGxpc3QnfTtgLCA1XzAwMCk7XHJcbiAgICAgIHJldHVybiB3O1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOkRvY2s6XHU4RkRDXHU3QTBCXHU5ODc1XHU3QjdFKFx1NjI0Qlx1NjczQVx1OEZEQ1x1N0EwQlx1NjNBN1x1NTIzNlx1OTc2Mlx1Njc3RitcdTVGMDBcdTY3M0FcdTgxRUFcdTU0MkZcdTg4NEMpID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ0RvY2s6XHU4RkRDXHU3QTBCXHU5ODc1XHU3QjdFKFx1NjI0Qlx1NjczQVx1OEZEQ1x1N0EwQlx1NjNBN1x1NTIzNlx1OTc2Mlx1Njc3RiknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdcdThGRENcdTdBMEInfHx4LnRleHRDb250ZW50PT09J1JlbW90ZSc7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcigncmVtb3RlIHBhbmUnLCBgdmFyIHA9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmRvY2stYm9keScpO1xyXG4gICAgICAgIHZhciB0ID0gcCA/IHAudGV4dENvbnRlbnQgOiAnJztcclxuICAgICAgICB2YXIgb2tUID0gdC5pbmRleE9mKCdcdTYyNEJcdTY3M0FcdThGRENcdTdBMEJcdTYzQTdcdTUyMzYnKT49MCB8fCB0LmluZGV4T2YoJ1Bob25lIHJlbW90ZScpPj0wO1xyXG4gICAgICAgIHZhciBva0EgPSB0LmluZGV4T2YoJ1x1NUYwMFx1NjczQVx1ODFFQVx1NTQyRicpPj0wIHx8IHQuaW5kZXhPZignQXV0b3N0YXJ0Jyk+PTA7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFwICYmIG9rVCAmJiBva0EsIGRldGFpbDogdC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNjApfTtgLCA2XzAwMCk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6RG9jazpcdTRFRDNcdTVFOTNcdTk4NzVcdTdCN0UoXHU0RUZCXHU1MkExIDE0LUI6Z2gvYWcgXHU3NjdCXHU1RjU1K1x1NEVEM1x1NUU5My9QUi9SZWxlYXNlO1xyXG4gICAgICAgZml4dHVyZSA9IGdpdGh1YiBcdTVERjJcdTc2N0JcdTVGNTUoc3dzZ2JsKSArIGF0b21naXQgXHU2NzJBXHU4OEM1IFx1MjE5MiBcdTRFMDBcdTRFMkEgZml4dHVyZSBcdTg5ODZcdTc2RDZcclxuICAgICAgIFx1MzAwQ1x1NzY3Qlx1NUY1NVx1NTM2MVx1MzAwRFx1NEUwRVx1MzAwQ1x1NjVFMCBDTEkgXHU2MzA3XHU1RjE1XHU2MDAxXHUzMDBEXHU0RTI0XHU0RTJBXHU5QThDXHU2NTM2XHU1NzNBXHU2NjZGO1x1NTE5OVx1NjRDRFx1NEY1Q1x1NTNFQVx1NTIzMFx1Nzg2RVx1OEJBNFx1NTM2MSxcdTRFMERcdTc3MUZcdTUzRDEpID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1NEVEM1x1NUU5MzpcdTUzQ0NcdTVFNzNcdTUzRjBcdTcyQjZcdTYwMDFcdTUzNjEoR2l0SHViIFx1NURGMlx1NzY3Qlx1NUY1NSBzd3NnYmw7QXRvbUdpdCBcdTY3MkFcdTg4QzUgXHUyMTkyIFx1NEUwMFx1ODg0Q1x1NUI4OVx1ODhDNVx1NjMwN1x1NUYxNSxcdTY1RTBcdTgxRUFcdTUyQThcdTVCODlcdTg4QzUpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nXHU0RUQzXHU1RTkzJ3x8eC50ZXh0Q29udGVudD09PSdSZXBvcyc7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignZm9yZ2UgaG9zdCBjYXJkcycsIGB2YXIgcGFuZT1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCdbZGF0YS10ZXN0aWQ9XCJmb3JnZS1wYW5lXCJdJyk7XHJcbiAgICAgICAgaWYoIXBhbmUpIHJldHVybiB7b2s6ZmFsc2UsIGRldGFpbDonbm8gcGFuZSd9O1xyXG4gICAgICAgIHZhciBnaD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCdbZGF0YS10ZXN0aWQ9XCJmb3JnZS1ob3N0LWdpdGh1YlwiXScpO1xyXG4gICAgICAgIHZhciBhZz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCdbZGF0YS10ZXN0aWQ9XCJmb3JnZS1ob3N0LWF0b21naXRcIl0nKTtcclxuICAgICAgICB2YXIgZ2hPayA9ICEhZ2ggJiYgZ2gudGV4dENvbnRlbnQuaW5kZXhPZignc3dzZ2JsJyk+PTAgJiYgKGdoLnRleHRDb250ZW50LmluZGV4T2YoJ1x1NURGMlx1NzY3Qlx1NUY1NScpPj0wIHx8IGdoLnRleHRDb250ZW50LmluZGV4T2YoJ1NpZ25lZCBpbicpPj0wKTtcclxuICAgICAgICAvLyBcdTY3MkFcdTg4QzUgQ0xJOlx1NjMwN1x1NUYxNVx1NjU4N1x1Njg0OFx1NTQyQiBDTEkgXHU1NDBEICsgXHU2NUUwXHU3NjdCXHU1RjU1XHU2MzA5XHU5NEFFKFx1NEUwRFx1ODFFQVx1NTJBOFx1ODhDNSxcdTUzRUFcdTYzMDdcdThERUYpXHJcbiAgICAgICAgdmFyIGFnSGludCA9ICEhYWcgJiYgKGFnLnRleHRDb250ZW50LmluZGV4T2YoJ1x1NjcyQVx1NjhDMFx1NkQ0Qlx1NTIzMCcpPj0wIHx8IGFnLnRleHRDb250ZW50LmluZGV4T2YoJ0NMSSBub3QgZGV0ZWN0ZWQnKT49MCk7XHJcbiAgICAgICAgdmFyIGFnTm9JbnN0YWxsQnRuID0gISFhZyAmJiBhZy5xdWVyeVNlbGVjdG9yQWxsKCdidXR0b24nKS5sZW5ndGg9PT0wO1xyXG4gICAgICAgIHJldHVybiB7b2s6IGdoT2sgJiYgYWdIaW50ICYmIGFnTm9JbnN0YWxsQnRuLCBkZXRhaWw6ICdnaD0nKyhnaD9naC50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNDQpOidub25lJykrJyB8IGFnPScrKGFnP2FnLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw0NCk6J25vbmUnKX07YCwgNl8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdcdTRFRDNcdTVFOTM6XHU2MjExXHU3Njg0XHU0RUQzXHU1RTkzXHU1MjE3XHU4ODY4ICsgXHU4ODRDXHU1MTg1XHU0RTA5XHU1MkE4XHU0RjVDKFx1NTE0Qlx1OTY4Ni9cdTZENEZcdTg5QzhcdTU2NjgvXHU4QkE5IGhtaCBcdTU5MDRcdTc0MDYpLFx1NzBCOVx1NTFGQlx1OEZEQlx1NEVEM1x1NUU5M1x1OEJFNlx1NjBDNScsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3JlcG8gcm93cycsIGB2YXIgcm93cz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS10ZXN0aWQ9XCJmb3JnZS1yZXBvLXJvd1wiXScpLmxlbmd0aDtcclxuICAgICAgICByZXR1cm4ge29rOiByb3dzPj0xLCBkZXRhaWw6ICdyb3dzPScrcm93c307YCwgNl8wMDApO1xyXG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICBjb25zdCBhY3RzID0gKGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignW2RhdGEtdGVzdGlkPVwiZm9yZ2UtcmVwby1yb3dcIl0nKTtcclxuICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkocj9bXS5zbGljZS5jYWxsKHIucXVlcnlTZWxlY3RvckFsbCgnLmZvcmdlLWFjdGlvbnMgYnV0dG9uJykpLm1hcChmdW5jdGlvbihiKXtyZXR1cm4gYi50ZXh0Q29udGVudDt9KTpbXSk7IH0pKClgKSkgYXMgc3RyaW5nO1xyXG4gICAgICBjb25zdCBoYXNDbG9uZSA9IGFjdHMuaW5kZXhPZignXHU1MTRCXHU5Njg2Jyk+PTAgfHwgYWN0cy5pbmRleE9mKCdDbG9uZScpPj0wO1xyXG4gICAgICBjb25zdCBoYXNBc2sgPSBhY3RzLmluZGV4T2YoJ2htaCcpPj0wO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciByPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLXRlc3RpZD1cImZvcmdlLXJlcG8tcm93XCJdIC5mb3JnZS1tYWluJyk7IGlmKHIpIHIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCB3MiA9IGF3YWl0IHdhaXRGb3IoJ3JlcG8gZGV0YWlsJywgYHZhciBwYW5lPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLXRlc3RpZD1cImZvcmdlLXBhbmVcIl0nKTtcclxuICAgICAgICB2YXIgdCA9IHBhbmUgPyBwYW5lLnRleHRDb250ZW50IDogJyc7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFwYW5lICYmIHQuaW5kZXhPZignUFInKT49MCAmJiB0LmluZGV4T2YoJ1JlbGVhc2UnKT49MCwgZGV0YWlsOiB0LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw2MCl9O2AsIDZfMDAwKTtcclxuICAgICAgcmV0dXJuIFt3MlswXSAmJiBoYXNDbG9uZSAmJiBoYXNBc2ssIGAke3cyWzFdfTsgXHU1MkE4XHU0RjVDPSR7YWN0cy5zbGljZSgwLCA2MCl9YF07XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ1x1NEVEM1x1NUU5MzpQUiBcdTUyMTdcdTg4NjhcdTcwQjlcdTU0MDhcdTVFNzYgXHUyMTkyIFx1Nzg2RVx1OEJBNFx1NTM2MVx1NTFGQVx1NzNCMChcdTU0MDhcdTVFNzZcdTY1QjlcdTVGMEZcdTlFRDhcdThCQTQgc3F1YXNoKVx1MjE5MiBcdTUzRDZcdTZEODhcdTRFMERcdTc3MUZcdTUzRDEnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdwciByb3dzJywgYHZhciByb3dzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXRlc3RpZD1cImZvcmdlLXByLXJvd1wiXScpLmxlbmd0aDtcclxuICAgICAgICByZXR1cm4ge29rOiByb3dzPj0xLCBkZXRhaWw6ICdwciByb3dzPScrcm93c307YCwgNl8wMDApO1xyXG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciByPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLXRlc3RpZD1cImZvcmdlLXByLXJvd1wiXScpO1xyXG4gICAgICAgIHZhciBiPVtdLnNsaWNlLmNhbGwoci5xdWVyeVNlbGVjdG9yQWxsKCdidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTU0MDhcdTVFNzYnKT49MHx8eC50ZXh0Q29udGVudC5pbmRleE9mKCdNZXJnZScpPj0wO30pO1xyXG4gICAgICAgIGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCB3MiA9IGF3YWl0IHdhaXRGb3IoJ21lcmdlIGNvbmZpcm0gY2FyZCcsIGB2YXIgYz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCdbZGF0YS10ZXN0aWQ9XCJmb3JnZS1tZXJnZS1jb25maXJtXCJdJyk7XHJcbiAgICAgICAgdmFyIHJhZGlvID0gYyA/IGMucXVlcnlTZWxlY3RvcignaW5wdXRbdHlwZT1yYWRpb106Y2hlY2tlZCcpIDogbnVsbDtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWMgJiYgISFyYWRpbywgZGV0YWlsOiBjID8gJ1x1Nzg2RVx1OEJBNFx1NTM2MStcdTY1QjlcdTVGMEZcdTUzNTVcdTkwMDkoJytyYWRpby52YWx1ZSsnKScgOiAnbm8gY2FyZCd9O2AsIDVfMDAwKTtcclxuICAgICAgaWYgKCF3MlswXSkgcmV0dXJuIHcyO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBjPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLXRlc3RpZD1cImZvcmdlLW1lcmdlLWNvbmZpcm1cIl0nKTtcclxuICAgICAgICB2YXIgYj1bXS5zbGljZS5jYWxsKGMucXVlcnlTZWxlY3RvckFsbCgnYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU1M0Q2XHU2RDg4Jyk+PTB8fHgudGV4dENvbnRlbnQuaW5kZXhPZignQ2FuY2VsJyk+PTA7fSk7XHJcbiAgICAgICAgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdjb25maXJtIGRpc21pc3NlZCcsIGByZXR1cm4ge29rOiAhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignW2RhdGEtdGVzdGlkPVwiZm9yZ2UtbWVyZ2UtY29uZmlybVwiXScpLCBkZXRhaWw6J2Nsb3NlZCd9O2AsIDVfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnXHU0RUQzXHU1RTkzOlJlbGVhc2UgXHU1MzNBXHU1QzU1XHU3OTNBXHU3MjQ4XHU2NzJDXHU1MjE3XHU4ODY4KGZpeHR1cmUgXHU1NDJCIHYwLjIuMTApKyBcdTY1QjBcdTVFRkFcdTg4NjhcdTUzNTVcdTVGMzlcdTVDNDIodGFnIFx1NUZDNVx1NTg2Qlx1OTVFOCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdyZWxlYXNlIHJvd3MnLCBgdmFyIHJvd3M9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS10ZXN0aWQ9XCJmb3JnZS1yZWxlYXNlLXJvd1wiXScpKTtcclxuICAgICAgICB2YXIgaGFzID0gcm93cy5zb21lKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ3YwLjIuMTAnKT49MDt9KTtcclxuICAgICAgICByZXR1cm4ge29rOiByb3dzLmxlbmd0aD49MSAmJiBoYXMsIGRldGFpbDogJ3Jvd3M9Jytyb3dzLmxlbmd0aCsoaGFzPycgXHU1NDJCdjAuMi4xMCc6JyBcdTY1RTB2MC4yLjEwJyl9O2AsIDZfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgcGFuZT1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCdbZGF0YS10ZXN0aWQ9XCJmb3JnZS1wYW5lXCJdJyk7XHJcbiAgICAgICAgdmFyIGI9W10uc2xpY2UuY2FsbChwYW5lLnF1ZXJ5U2VsZWN0b3JBbGwoJ2J1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1NTNEMVx1NUUwM1x1NjVCMFx1NzI0OFx1NjcyQycpPj0wfHx4LnRleHRDb250ZW50LmluZGV4T2YoJ05ldyByZWxlYXNlJyk+PTA7fSk7XHJcbiAgICAgICAgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IHcyID0gYXdhaXQgd2FpdEZvcigncmVsZWFzZSBmb3JtJywgYHZhciBmPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLXRlc3RpZD1cImZvcmdlLWZvcm1cIl0nKTtcclxuICAgICAgICB2YXIgc3VibWl0ID0gZiA/IFtdLnNsaWNlLmNhbGwoZi5xdWVyeVNlbGVjdG9yQWxsKCdidXR0b24nKSkucG9wKCkgOiBudWxsO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhZiAmJiAhIXN1Ym1pdCAmJiBzdWJtaXQuZGlzYWJsZWQ9PT10cnVlLCBkZXRhaWw6IGYgPyAnXHU4ODY4XHU1MzU1XHU1MUZBXHU3M0IwLFx1N0E3QSB0YWcgXHU2NUY2XHU2M0QwXHU0RUE0XHU3OTgxXHU3NTI4JyA6ICdubyBmb3JtJ307YCwgNV8wMDApO1xyXG4gICAgICBpZiAoIXcyWzBdKSByZXR1cm4gdzI7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGY9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignW2RhdGEtdGVzdGlkPVwiZm9yZ2UtZm9ybVwiXScpOyB2YXIgeD1bXS5zbGljZS5jYWxsKGYucXVlcnlTZWxlY3RvckFsbCgnYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oYil7cmV0dXJuIGIudGV4dENvbnRlbnQ9PT0nXHUyNzE1Jzt9KTsgaWYoeCkgeC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdmb3JtIGNsb3NlZCcsIGByZXR1cm4ge29rOiAhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignW2RhdGEtdGVzdGlkPVwiZm9yZ2UtZm9ybVwiXScpLCBkZXRhaWw6J2Nsb3NlZCd9O2AsIDVfMDAwKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTY0MUNcdTdEMjJcdThGQzdcdTZFRTQgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU0RjFBXHU4QkREXHU2NDFDXHU3RDIyOlx1OEZDN1x1NkVFNFx1NzUxRlx1NjU0OCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgYmVmb3JlID0gKGF3YWl0IGpzKGBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoYCkpIGFzIG51bWJlcjtcclxuICAgICAgYXdhaXQgdHlwZUludG8oJy5zZXNzaW9uLXNlYXJjaCcsICd6enotXHU0RTBEXHU1QjU4XHU1NzI4XHU3Njg0XHU0RjFBXHU4QkREJyk7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdmaWx0ZXJlZCBlbXB0eScsIGB2YXIgbj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoO1xyXG4gICAgICAgIHJldHVybiB7b2s6IG4gPT09IDAsIGRldGFpbDogJ2FmdGVyPScrbn07YCwgNV8wMDApO1xyXG4gICAgICBhd2FpdCB0eXBlSW50bygnLnNlc3Npb24tc2VhcmNoJywgJycpO1xyXG4gICAgICBhd2FpdCBzbGVlcCg0MDApO1xyXG4gICAgICBjb25zdCBhZnRlciA9IChhd2FpdCBqcyhgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aGApKSBhcyBudW1iZXI7XHJcbiAgICAgIHJldHVybiBbd1swXSAmJiBhZnRlciA9PT0gYmVmb3JlLCBgJHt3WzFdfTsgXHU2MDYyXHU1OTBEXHU1NDBFICR7YWZ0ZXJ9PT09JHtiZWZvcmV9YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6Q3RybCtLIFx1NTQ3RFx1NEVFNFx1OTc2Mlx1Njc3RiA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdDdHJsK0sgXHU1NDdEXHU0RUU0XHU5NzYyXHU2NzdGOlx1NjI1M1x1NUYwMFx1NUU3Nlx1NjI2N1x1ODg0Q1x1NTQ3RFx1NEVFNCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleTonaycsIGN0cmxLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdjbWRrIG9wZW4nLCBgdmFyIGM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNtZGsnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWMsIGRldGFpbDogYyA/ICdvcGVuJyA6ICdub3Qgb3Blbid9O2AsIDVfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgaXQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY21kay1pdGVtJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU2NTg3XHU0RUY2Jyk+PTAgfHwgeC50ZXh0Q29udGVudC5pbmRleE9mKCdGaWxlcycpPj0wO30pOyBpZihpdCkgaXQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcigndGFiIHN3aXRjaGVkJywgYHZhciB0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5kb2NrLXRhYi5hY3RpdmUnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXQgJiYgKHQudGV4dENvbnRlbnQ9PT0nXHU2NTg3XHU0RUY2J3x8dC50ZXh0Q29udGVudD09PSdGaWxlcycpLCBkZXRhaWw6ICdhY3RpdmU9JysodD90LnRleHRDb250ZW50Oidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdThCQkVcdTdGNkVcdTk3NjJcdTY3N0YgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU4QkJFXHU3RjZFKEN0cmwrU2hpZnQrUCk6UHJvdmlkZXIgXHU4ODY4XHU1MzU1XHU1M0VGXHU4OUMxLEVzYyBcdTUxNzNcdTk1RUQnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J3AnLCBjdHJsS2V5OnRydWUsIHNoaWZ0S2V5OnRydWUsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignc2V0dGluZ3Mgb3BlbicsIGB2YXIgcz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kay5zZXR0aW5ncycpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhcyAmJiAhIXMucXVlcnlTZWxlY3RvcignLnByb3ZpZGVyLWZvcm0nKSwgZGV0YWlsOiBzID8gJ29wZW4rZm9ybScgOiAnbm90IG9wZW4nfTtgLCA1XzAwMCk7XHJcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J0VzY2FwZScsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignc2V0dGluZ3MgY2xvc2VkJywgYHJldHVybiB7b2s6ICFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kay1vdmVybGF5JyksIGRldGFpbDogJ2Nsb3NlZCd9O2AsIDVfMDAwKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTppMThuIFx1OEJFRFx1OEEwMFx1NTIwN1x1NjM2MiA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdThCRURcdThBMDBcdTUyMDdcdTYzNjI6XHU0RTJEXHU2NTg3IFx1MjE5MiBFbmdsaXNoIFx1MjE5MiBcdTYwNjJcdTU5MERcdTRFMkRcdTY1ODcnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J3AnLCBjdHJsS2V5OnRydWUsIHNoaWZ0S2V5OnRydWUsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignc2V0dGluZ3Mgb3BlbicsIGB2YXIgcz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kay5zZXR0aW5ncycpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhcywgZGV0YWlsOiBzID8gJ29wZW4nIDogJ25vdCBvcGVuJ307YCwgNV8wMDApO1xyXG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNtZGsuc2V0dGluZ3MgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J0VuZ2xpc2gnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgZW4gPSBhd2FpdCB3YWl0Rm9yKCdlbmdsaXNoIHNob3duJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyLWhlYWQgLmJ0bi5wcmltYXJ5Jyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFiICYmIGIudGV4dENvbnRlbnQgPT09ICcrIE5ldyBTZXNzaW9uJywgZGV0YWlsOiAnYnRuPScrKGI/Yi50ZXh0Q29udGVudDonbm9uZScpfTtgLCA1XzAwMCk7XHJcbiAgICAgIGF3YWl0IHNob3QoJ2VuZ2xpc2gnKTtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jbWRrLnNldHRpbmdzIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTRFMkRcdTY1ODcnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgemggPSBhd2FpdCB3YWl0Rm9yKCdjaGluZXNlIGJhY2snLCBgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXItaGVhZCAuYnRuLnByaW1hcnknKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWIgJiYgYi50ZXh0Q29udGVudCA9PT0gJysgXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREJywgZGV0YWlsOiAnYnRuPScrKGI/Yi50ZXh0Q29udGVudDonbm9uZScpfTtgLCA1XzAwMCk7XHJcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J0VzY2FwZScsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICByZXR1cm4gW2VuWzBdICYmIHpoWzBdLCBgZW46ICR7ZW5bMV19OyB6aDogJHt6aFsxXX1gXTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTVERTVcdTRGNUNcdTUzM0FcdTdCQTFcdTc0MDYoXHU1REU2XHU2ODBGXHU2ODBGXHU0RjREICsgXHU4M0RDXHU1MzU1ICsgXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREXHU5MDA5XHU1REU1XHU0RjVDXHU1MzNBKSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTVERTVcdTRGNUNcdTUzM0E6XHU1REU2XHU2ODBGXHU1REU1XHU0RjVDXHU1MzNBXHU2ODBGXHU1M0VGXHU4OUMxKFx1NUY1M1x1NTI0RFx1NURFNVx1NEY1Q1x1NTMzQVx1NTQwRCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCd3b3Jrc3BhY2UgYmFyJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53b3Jrc3BhY2UtYmFyJyk7XHJcbiAgICAgICAgdmFyIG4gPSBiID8gKGIucXVlcnlTZWxlY3RvcignLndzLWJhci1uYW1lJyl8fHt9KS50ZXh0Q29udGVudCA6ICcnO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYiAmJiAhIW4gJiYgbi5sZW5ndGggPiAwICYmIG4uaW5kZXhPZignXHU1MkEwXHU4RjdEJykgPCAwLCBkZXRhaWw6ICdiYXI9JysoYj8neWVzJzonbm8nKSsnIG5hbWU9JytufTtgLCA4XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ1x1NURFNVx1NEY1Q1x1NTMzQTpcdTgzRENcdTUzNTVcdTVGMzlcdTUxRkEsXHU1MjE3XHU4ODY4K1x1NUY1M1x1NTI0RFx1OUFEOFx1NEVBRStcdTZERkJcdTUyQTBcdTUxNjVcdTUzRTM7XHU1NzI4XHU2MzA3XHU1QjlBXHU1REU1XHU0RjVDXHU1MzNBXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53b3Jrc3BhY2UtYmFyJyk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignd3MgbWVudScsIGB2YXIgbT1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtbWVudScpO1xyXG4gICAgICAgIHZhciBpdGVtcyA9IG0gPyBtLnF1ZXJ5U2VsZWN0b3JBbGwoJy53cy1tZW51LWl0ZW0nKS5sZW5ndGggOiAwO1xyXG4gICAgICAgIHZhciBjdXIgPSBtID8gbS5xdWVyeVNlbGVjdG9yQWxsKCcud3MtbWVudS1pdGVtLmN1cnJlbnQnKS5sZW5ndGggOiAwO1xyXG4gICAgICAgIHZhciBhZGQgPSBtID8gKG0udGV4dENvbnRlbnQuaW5kZXhPZignXHU2REZCXHU1MkEwXHU1REU1XHU0RjVDXHU1MzNBJyk+PTAgfHwgbS50ZXh0Q29udGVudC5pbmRleE9mKCdBZGQgd29ya3NwYWNlJyk+PTApIDogZmFsc2U7XHJcbiAgICAgICAgcmV0dXJuIHtvazogaXRlbXMgPj0gMSAmJiBjdXIgPj0gMSAmJiBhZGQsIGRldGFpbDogJ2l0ZW1zPScraXRlbXMrJyBjdXJyZW50PScrY3VyKycgYWRkPScrYWRkfTtgLCA2XzAwMCk7XHJcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgIGF3YWl0IHNob3QoJ3dzLW1lbnUnKTtcclxuICAgICAgLy8gXHU3MEI5XHU3QjJDXHU0RTAwXHU0RTJBXHU1REU1XHU0RjVDXHU1MzNBXHU5ODc5ID0gXHU1NzI4XHU4QkU1XHU1REU1XHU0RjVDXHU1MzNBXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREKFx1ODNEQ1x1NTM1NVx1NTE3M1x1OTVFRFx1MzAwMWNvbXBvc2VyIFx1NTNFRlx1NzUyOClcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgaXQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLW1lbnUtaXRlbScpOyBpZihpdCkgaXQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBjbG9zZWQgPSBhd2FpdCB3YWl0Rm9yKCdtZW51IGNsb3NlZCArIHNlc3Npb24gYWN0aXZlJywgYHZhciB0YT1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY29tcG9zZXIgdGV4dGFyZWEnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLW1lbnUnKSAmJiAhIXRhICYmIHRhLmRpc2FibGVkID09PSBmYWxzZSwgZGV0YWlsOiAnbWVudT0nKyhkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtbWVudScpPydvcGVuJzonY2xvc2VkJykrJyB0YT0nKyh0YT90YS5kaXNhYmxlZDonbm9uZScpfTtgLCA2XzAwMCk7XHJcbiAgICAgIHJldHVybiBbY2xvc2VkWzBdLCBgJHt3WzFdfTsgJHtjbG9zZWRbMV19YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU0RjFBXHU4QkREXHU2MzA5XHU1REU1XHU0RjVDXHU1MzNBXHU1MjA2XHU3RUM0ICsgXHU1QzU1XHU1RjAwL1x1NjUzNlx1OEQ3NyA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTRGMUFcdThCRERcdTUyMDZcdTdFQzQ6XHU3RUM0XHU1OTM0XHU1MUZBXHU3M0IwKFx1NURFNVx1NEY1Q1x1NTMzQVx1NTQwRCtcdTY1NzBcdTkxQ0YpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignZ3JvdXAgaGVhZCcsIGB2YXIgaD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtZ3JvdXAtaGVhZCcpO1xyXG4gICAgICAgIHZhciBuID0gaCA/IChoLnF1ZXJ5U2VsZWN0b3IoJy53cy1ncm91cC1uYW1lJyl8fHt9KS50ZXh0Q29udGVudCA6ICcnO1xyXG4gICAgICAgIHZhciBjID0gaCA/IChoLnF1ZXJ5U2VsZWN0b3IoJy53cy1ncm91cC1jb3VudCcpfHx7fSkudGV4dENvbnRlbnQgOiAnJztcclxuICAgICAgICByZXR1cm4ge29rOiAhIWggJiYgbi5sZW5ndGggPiAwICYmIGMubGVuZ3RoID4gMCwgZGV0YWlsOiAnbmFtZT0nK24rJyBjb3VudD0nK2N9O2AsIDhfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnXHU0RjFBXHU4QkREXHU1MjA2XHU3RUM0Olx1NzBCOVx1NTFGQlx1N0VDNFx1NTkzNFx1NjUzNlx1OEQ3NyxcdTUxOERcdTcwQjlcdTVDNTVcdTVGMDBcdTYwNjJcdTU5MEQnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IGJlZm9yZSA9IChhd2FpdCBqcyhgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aGApKSBhcyBudW1iZXI7XHJcbiAgICAgIGlmIChiZWZvcmUgPT09IDApIHJldHVybiBbZmFsc2UsICdubyBzZXNzaW9ucyB0byBncm91cCddO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBoPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1ncm91cC1oZWFkJyk7IGlmKGgpIGguY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBjb2xsYXBzZWQgPSBhd2FpdCB3YWl0Rm9yKCdjb2xsYXBzZWQnLCBgdmFyIGc9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLWdyb3VwJyk7XHJcbiAgICAgICAgdmFyIGhpZGRlbiA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGggPCAke2JlZm9yZX07XHJcbiAgICAgICAgcmV0dXJuIHtvazogaGlkZGVuLCBkZXRhaWw6ICdpdGVtcz0nK2RvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGgrJyBiZWZvcmU9JHtiZWZvcmV9J307YCwgNV8wMDApO1xyXG4gICAgICBhd2FpdCBzaG90KCd3cy1ncm91cC1jb2xsYXBzZWQnKTtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgaD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtZ3JvdXAtaGVhZCcpOyBpZihoKSBoLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgZXhwYW5kZWQgPSBhd2FpdCB3YWl0Rm9yKCdleHBhbmRlZCBiYWNrJywgYHZhciBuPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGg7XHJcbiAgICAgICAgcmV0dXJuIHtvazogbiA+PSAke2JlZm9yZX0sIGRldGFpbDogJ2l0ZW1zPScrbn07YCwgNV8wMDApO1xyXG4gICAgICByZXR1cm4gW2NvbGxhcHNlZFswXSAmJiBleHBhbmRlZFswXSwgYGNvbGxhcHNlOiAke2NvbGxhcHNlZFsxXX07IGV4cGFuZDogJHtleHBhbmRlZFsxXX1gXTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTVGRUJcdTYzNzdcdTk1MkVcdTVFMkVcdTUyQTlcdTk3NjJcdTY3N0YoQ3RybCsvKSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTVGRUJcdTYzNzdcdTk1MkVcdTVFMkVcdTUyQTk6Q3RybCsvIFx1NjI1M1x1NUYwMCxFc2MgXHU1MTczXHU5NUVEJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OicvJywgY3RybEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3Nob3J0Y3V0cyBvcGVuJywgYHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrJyk7XHJcbiAgICAgICAgdmFyIHJvd3MgPSBzID8gcy5xdWVyeVNlbGVjdG9yQWxsKCcuc2hvcnRjdXQtcm93JykubGVuZ3RoIDogMDtcclxuICAgICAgICByZXR1cm4ge29rOiByb3dzID49IDUsIGRldGFpbDogJ3Jvd3M9Jytyb3dzfTtgLCA1XzAwMCk7XHJcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgIGF3YWl0IHNob3QoJ3Nob3J0Y3V0cycpO1xyXG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidFc2NhcGUnLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ3Nob3J0Y3V0cyBjbG9zZWQnLCBgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrLW92ZXJsYXknKSwgZGV0YWlsOiAnY2xvc2VkJ307YCwgNV8wMDApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NEZBN1x1NjgwRlx1NjUzNlx1N0YyOSArIFx1NzJCNlx1NjAwMVx1OEZDN1x1NkVFNCA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTRGQTdcdTY4MEZcdTY1MzZcdTdGMjk6XHUyMUU0IFx1NjUzNlx1OEQ3N1x1NURFNlx1NjgwRixcdTIxRTUgXHU1QzU1XHU1RjAwXHU2MDYyXHU1OTBEJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAvLyBISUcgUDMgXHU3RUM0MjpcdTIxRTQvXHUyMUU1IEVtb2ppIFx1NURGMlx1NjM2MiBTVkcgaWNvbixcdTYzMDlcdTk0QUVcdTRFRTUgYXJpYS1sYWJlbChcdTU0MkJcIlx1NEZBN1x1NjgwRlwiKVx1NUI5QVx1NEY0RFxyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcigndG9nZ2xlIGJ0bicsIGB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50b3BiYXIgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuICh4LmdldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcpfHwnJykuaW5kZXhPZignXHU0RkE3XHU2ODBGJyk+PTA7fSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFiLCBkZXRhaWw6ICdidG49JysoYj9iLmdldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcpOidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50b3BiYXIgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuICh4LmdldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcpfHwnJykuaW5kZXhPZignXHU0RkE3XHU2ODBGJyk+PTA7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBoaWRkZW4gPSBhd2FpdCB3YWl0Rm9yKCdzaWRlYmFyIGhpZGRlbicsIGB2YXIgc2I9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXInKTtcclxuICAgICAgICB2YXIgZ29uZSA9ICFzYiB8fCBnZXRDb21wdXRlZFN0eWxlKHNiKS5kaXNwbGF5ID09PSAnbm9uZSc7XHJcbiAgICAgICAgcmV0dXJuIHtvazogZ29uZSwgZGV0YWlsOiAnZGlzcGxheT0nKyhzYj9nZXRDb21wdXRlZFN0eWxlKHNiKS5kaXNwbGF5Oidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50b3BiYXIgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuICh4LmdldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcpfHwnJykuaW5kZXhPZignXHU0RkE3XHU2ODBGJyk+PTA7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBzaG93biA9IGF3YWl0IHdhaXRGb3IoJ3NpZGViYXIgYmFjaycsIGB2YXIgc2I9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXInKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXNiICYmIGdldENvbXB1dGVkU3R5bGUoc2IpLmRpc3BsYXkgIT09ICdub25lJywgZGV0YWlsOiAnZGlzcGxheT0nKyhzYj9nZXRDb21wdXRlZFN0eWxlKHNiKS5kaXNwbGF5Oidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgICAgcmV0dXJuIFtoaWRkZW5bMF0gJiYgc2hvd25bMF0sIGBoaWRlOiAke2hpZGRlblsxXX07IHNob3c6ICR7c2hvd25bMV19YF07XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ1x1NzJCNlx1NjAwMVx1OEZDN1x1NkVFNDpcdTRFMEJcdTYyQzlcdTUyMDdcdTYzNjJcdTUyMzBcIlx1OEZEMFx1ODg0Q1x1NEUyRFwiXHU0RTBEXHU1RDI5XHU2RTgzXHU1RTc2XHU2MDYyXHU1OTBEJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCBzZWwgPSBhd2FpdCB3YWl0Rm9yKCdmaWx0ZXIgc2VsZWN0JywgYHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zdGF0dXMtZmlsdGVyJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFzICYmIHMub3B0aW9ucy5sZW5ndGggPj0gNCwgZGV0YWlsOiAnb3B0aW9ucz0nKyhzP3Mub3B0aW9ucy5sZW5ndGg6MCl9O2AsIDVfMDAwKTtcclxuICAgICAgaWYgKCFzZWxbMF0pIHJldHVybiBzZWw7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnN0YXR1cy1maWx0ZXInKTsgcy52YWx1ZT0ncnVubmluZyc7IHMuZGlzcGF0Y2hFdmVudChuZXcgRXZlbnQoJ2NoYW5nZScse2J1YmJsZXM6dHJ1ZX0pKTsgfSkoKWApO1xyXG4gICAgICBhd2FpdCBzbGVlcCg1MDApO1xyXG4gICAgICBjb25zdCByMSA9IChhd2FpdCBqcyhgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aGApKSBhcyBudW1iZXI7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnN0YXR1cy1maWx0ZXInKTsgcy52YWx1ZT0nYWxsJzsgcy5kaXNwYXRjaEV2ZW50KG5ldyBFdmVudCgnY2hhbmdlJyx7YnViYmxlczp0cnVlfSkpOyB9KSgpYCk7XHJcbiAgICAgIGF3YWl0IHNsZWVwKDUwMCk7XHJcbiAgICAgIGNvbnN0IHIyID0gKGF3YWl0IGpzKGBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoYCkpIGFzIG51bWJlcjtcclxuICAgICAgcmV0dXJuIFtyMiA+PSByMSAmJiByMiA+PSAxLCBgcnVubmluZz0ke3IxfSBhbGw9JHtyMn1gXTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTZBMjFcdTU3OEJcdTkwMDlcdTYyRTlcdTU2NjgoXHU5ODc2XHU2ODBGXHU1MjA3XHU2MzYyIGNoYXQgXHU4REVGXHU3NTMxKSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTZBMjFcdTU3OEJcdTkwMDlcdTYyRTlcdTU2Njg6XHU5ODc2XHU2ODBGXHU4M0RDXHU1MzU1XHU1MjE3XHU1MUZBIHByb3ZpZGVycyBcdTVFNzZcdTUzRUZcdTUyMDdcdTYzNjInLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdtb2RlbCBidXR0b24nLCBgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnRvcGJhci1tb2RlbC5hcy1idXR0b24nKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWIgJiYgYi5kaXNhYmxlZCA9PT0gZmFsc2UsIGRldGFpbDogYiA/IGIudGV4dENvbnRlbnQgOiAnbm9uZSd9O2AsIDZfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudG9wYmFyLW1vZGVsLmFzLWJ1dHRvbicpOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgbSA9IGF3YWl0IHdhaXRGb3IoJ21vZGVsIG1lbnUnLCBgdmFyIG09ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLm1vZGVsLW1lbnUnKTtcclxuICAgICAgICB2YXIgaXRlbXMgPSBtID8gbS5xdWVyeVNlbGVjdG9yQWxsKCcud3MtbWVudS1pdGVtJykubGVuZ3RoIDogMDtcclxuICAgICAgICB2YXIgY3VyID0gbSA/IG0ucXVlcnlTZWxlY3RvckFsbCgnLndzLW1lbnUtaXRlbS5jdXJyZW50JykubGVuZ3RoIDogMDtcclxuICAgICAgICByZXR1cm4ge29rOiBpdGVtcyA+PSAyICYmIGN1ciA+PSAxLCBkZXRhaWw6ICdpdGVtcz0nK2l0ZW1zKycgY3VycmVudD0nK2N1cn07YCwgNV8wMDApO1xyXG4gICAgICBpZiAoIW1bMF0pIHJldHVybiBtO1xyXG4gICAgICBhd2FpdCBzaG90KCdtb2RlbC1tZW51Jyk7XHJcbiAgICAgIC8vIFx1NTIwN1x1NTIzMFx1N0IyQ1x1NEU4Q1x1NEUyQSBwcm92aWRlcihmYWtlOiBkZW1vLXZpc2lvbi9mYWtlLW0tdmlzaW9uKVxyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBpdHM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcubW9kZWwtbWVudSAud3MtbWVudS1pdGVtJykpOyB2YXIgaXQ9aXRzW2l0cy5sZW5ndGgtMV07IGlmKGl0KSBpdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdtb2RlbCBzd2l0Y2hlZCcsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudG9wYmFyLW1vZGVsLmFzLWJ1dHRvbicpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYiAmJiBiLnRleHRDb250ZW50LmluZGV4T2YoJ2Zha2UtbS12aXNpb24nKSA+PSAwLCBkZXRhaWw6ICdiYWRnZT0nKyhiP2IudGV4dENvbnRlbnQ6J25vbmUnKX07YCwgNl8wMDApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NEUzQlx1OTg5OChcdTZENDVcdTgyNzJcdTc1MUZcdTY1NDhcdTIxOTJcdTYwNjJcdTU5MERcdTZERjFcdTgyNzIpID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1NEUzQlx1OTg5ODpcdThCQkVcdTdGNkVcdTUyMDdcdTZENDVcdTgyNzJcdTc1MUZcdTY1NDgsXHU2MDYyXHU1OTBEXHU2REYxXHU4MjcyJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidwJywgY3RybEtleTp0cnVlLCBzaGlmdEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3NldHRpbmdzIG9wZW4nLCBgdmFyIHM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNtZGsuc2V0dGluZ3MnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXMsIGRldGFpbDogcyA/ICdvcGVuJyA6ICdub3Qgb3Blbid9O2AsIDVfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jbWRrLnNldHRpbmdzIC5zZWcgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NkQ0NVx1ODI3Mid8fHgudGV4dENvbnRlbnQudHJpbSgpPT09J0xpZ2h0Jzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IGxpZ2h0ID0gYXdhaXQgd2FpdEZvcignbGlnaHQgdGhlbWUnLCBgdmFyIGR0PWRvY3VtZW50LmRvY3VtZW50RWxlbWVudC5kYXRhc2V0LnRoZW1lO1xyXG4gICAgICAgIHZhciBiZyA9IGdldENvbXB1dGVkU3R5bGUoZG9jdW1lbnQuYm9keSkuYmFja2dyb3VuZENvbG9yO1xyXG4gICAgICAgIHZhciBtID0gL1xcXFxkKy9nOyB2YXIgbnVtcz0oYmcubWF0Y2gobSl8fFsnMCcsJzAnLCcwJ10pLm1hcChOdW1iZXIpO1xyXG4gICAgICAgIHJldHVybiB7b2s6IGR0PT09J2xpZ2h0JyAmJiBudW1zWzBdPjIwMCAmJiBudW1zWzFdPjIwMCAmJiBudW1zWzJdPjIwMCwgZGV0YWlsOiAndGhlbWU9JytkdCsnIGJnPScrYmd9O2AsIDVfMDAwKTtcclxuICAgICAgYXdhaXQgc2hvdCgnbGlnaHQtdGhlbWUnKTtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jbWRrLnNldHRpbmdzIC5zZWcgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NkRGMVx1ODI3Mid8fHgudGV4dENvbnRlbnQudHJpbSgpPT09J0RhcmsnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgZGFyayA9IGF3YWl0IHdhaXRGb3IoJ2RhcmsgYmFjaycsIGByZXR1cm4ge29rOiBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuZGF0YXNldC50aGVtZT09PSdkYXJrJywgZGV0YWlsOiAndGhlbWU9Jytkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuZGF0YXNldC50aGVtZX07YCwgNV8wMDApO1xyXG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidFc2NhcGUnLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgcmV0dXJuIFtsaWdodFswXSAmJiBkYXJrWzBdLCBgbGlnaHQ6ICR7bGlnaHRbMV19OyBkYXJrOiAke2RhcmtbMV19YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU5ODc2XHU2ODBGIFx1NEUyRC9FTiBcdTVGRUJcdTYzNzdcdTUyMDdcdTYzNjIoXHU1M0VGXHU1M0QxXHU3M0IwXHU2MDI3KSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTk4NzZcdTY4MEZcdTVGRUJcdTYzNzdcdTUyMDdcdTYzNjI6XHU0RTJEL0VOIFx1NEUwMFx1OTUyRVx1NTIwN1x1NjM2MicsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2xhbmcgc2VnJywgYHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5sYW5nLXNlZycpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhcyAmJiBzLnF1ZXJ5U2VsZWN0b3JBbGwoJ2J1dHRvbicpLmxlbmd0aCA9PT0gMiwgZGV0YWlsOiBzID8gJ3ByZXNlbnQnIDogJ2Fic2VudCd9O2AsIDVfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5sYW5nLXNlZyBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nRU4nO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgZW4gPSBhd2FpdCB3YWl0Rm9yKCdlbmdsaXNoJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyLWhlYWQgLmJ0bi5wcmltYXJ5Jyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFiICYmIGIudGV4dENvbnRlbnQgPT09ICcrIE5ldyBTZXNzaW9uJywgZGV0YWlsOiAnYnRuPScrKGI/Yi50ZXh0Q29udGVudDonbm9uZScpfTtgLCA1XzAwMCk7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcubGFuZy1zZWcgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NEUyRCc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCB6aCA9IGF3YWl0IHdhaXRGb3IoJ2NoaW5lc2UgYmFjaycsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhci1oZWFkIC5idG4ucHJpbWFyeScpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYiAmJiBiLnRleHRDb250ZW50ID09PSAnKyBcdTY1QjBcdTVFRkFcdTRGMUFcdThCREQnLCBkZXRhaWw6ICdidG49JysoYj9iLnRleHRDb250ZW50Oidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgICAgcmV0dXJuIFtlblswXSAmJiB6aFswXSwgYGVuOiAke2VuWzFdfTsgemg6ICR7emhbMV19YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU3Qzk4XHU4RDM0XHU1NkZFXHU3MjQ3IFx1MjE5MiBcdTdGMjlcdTc1NjVcdTU2RkUgY2hpcCBcdTIxOTIgXHU1M0QxXHU5MDAxIFx1MjE5MiBydW50aW1lIFx1NjUzNlx1NTIzMCA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTdDOThcdThEMzRcdTU2RkVcdTcyNDc6XHU3RjI5XHU3NTY1XHU1NkZFIGNoaXAgKyBcdTUzRDFcdTkwMDFcdTU0MEUgcnVudGltZSBcdTY1MzZcdTUyMzBcdTU2RkVcdTcyNDcnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIC8vIFx1NjVCMFx1NUVGQVx1NEYxQVx1OEJERFx1Nzg2RVx1NEZERCBjb21wb3NlciBcdTUzRUZcdTc1MjhcclxuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleTonbicsIGN0cmxLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XHJcbiAgICAgIGF3YWl0IHNsZWVwKDMwMCk7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXtcclxuICAgICAgICB2YXIgdGEgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY29tcG9zZXIgdGV4dGFyZWEnKTtcclxuICAgICAgICBpZiAoIXRhKSByZXR1cm47XHJcbiAgICAgICAgdmFyIGMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdjYW52YXMnKTtcclxuICAgICAgICBjLndpZHRoID0gODsgYy5oZWlnaHQgPSA4O1xyXG4gICAgICAgIHZhciBjdHggPSBjLmdldENvbnRleHQoJzJkJyk7XHJcbiAgICAgICAgY3R4LmZpbGxTdHlsZSA9ICcjM2Y5NjUwJzsgY3R4LmZpbGxSZWN0KDAsIDAsIDgsIDgpO1xyXG4gICAgICAgIGMudG9CbG9iKGZ1bmN0aW9uKGJsb2Ipe1xyXG4gICAgICAgICAgdmFyIGR0ID0gbmV3IERhdGFUcmFuc2ZlcigpO1xyXG4gICAgICAgICAgZHQuaXRlbXMuYWRkKG5ldyBGaWxlKFtibG9iXSwgJ3Bhc3RlZC5wbmcnLCB7dHlwZTogJ2ltYWdlL3BuZyd9KSk7XHJcbiAgICAgICAgICB0YS5kaXNwYXRjaEV2ZW50KG5ldyBDbGlwYm9hcmRFdmVudCgncGFzdGUnLCB7Y2xpcGJvYXJkRGF0YTogZHQsIGJ1YmJsZXM6IHRydWUsIGNhbmNlbGFibGU6IHRydWV9KSk7XHJcbiAgICAgICAgfSwgJ2ltYWdlL3BuZycpO1xyXG4gICAgICB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IGNoaXAgPSBhd2FpdCB3YWl0Rm9yKCdpbWFnZSBjaGlwJywgYHZhciBuPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5hdHQtY2hpcC5pbWcnKS5sZW5ndGg7XHJcbiAgICAgICAgcmV0dXJuIHtvazogbiA+PSAxLCBkZXRhaWw6ICdpbWcgY2hpcHM9JytufTtgLCA2XzAwMCk7XHJcbiAgICAgIGlmICghY2hpcFswXSkgcmV0dXJuIGNoaXA7XHJcbiAgICAgIGF3YWl0IHR5cGVJbnRvKCcuY29tcG9zZXIgdGV4dGFyZWEnLCAnXHU3NzBCXHU4RkQ5XHU1RjIwXHU1NkZFJyk7XHJcbiAgICAgIGF3YWl0IHNsZWVwKDIwMCk7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY29tcG9zZXIgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NTNEMVx1OTAwMSc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBkb25lID0gYXdhaXQgd2FpdEZvcignaW1hZ2Ugc2VudCcsIGBcclxuICAgICAgICB2YXIgYXAgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuYXBwcm92YWwtY2FyZCBidXR0b24nKTtcclxuICAgICAgICBpZiAoYXAgJiYgYXAudGV4dENvbnRlbnQudHJpbSgpLmluZGV4T2YoJ1x1NjI3OVx1NTFDNicpPj0wKSBhcC5jbGljaygpO1xyXG4gICAgICAgIHZhciB0cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50dXJuJykpO1xyXG4gICAgICAgIHZhciBoaXQgPSB0cy5maWx0ZXIoZnVuY3Rpb24oeCl7IHJldHVybiB4LmNsYXNzTmFtZS5pbmRleE9mKCd1c2VyJyk8MCAmJiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1tpbWFnZXM6IDFdJykgPj0gMDsgfSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogaGl0Lmxlbmd0aCA+PSAxLCBkZXRhaWw6ICdydW50aW1lLWVjaG8td2l0aC1pbWFnZT0nK2hpdC5sZW5ndGh9O1xyXG4gICAgICBgLCAxNV8wMDApO1xyXG4gICAgICBhd2FpdCBzaG90KCdwYXN0ZWQtaW1hZ2UnKTtcclxuICAgICAgcmV0dXJuIGRvbmU7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHVEODNEXHVEQ0NFIFx1NEUwQVx1NEYyMC9cdUQ4M0RcdURDQzEgXHU2RDRGXHU4OUM4XHU2MzA5XHU5NEFFXHU1QzMxXHU0RjREID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1OTY0NFx1NEVGNlx1NEUwRVx1NzZFRVx1NUY1NVx1NTE2NVx1NTNFMzpcdUQ4M0RcdURDQ0UgXHU0RTBBXHU0RjIwICsgXHVEODNEXHVEQ0MxIFx1NkQ0Rlx1ODlDOFx1NjMwOVx1OTRBRVx1NUI1OFx1NTcyOCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgciA9IChhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XHJcbiAgICAgICAgdmFyIHVwID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNvbXBvc2VyIGJ1dHRvblthcmlhLWxhYmVsKj1cIlx1NEUwQVx1NEYyMFwiXSwgLmNvbXBvc2VyIGJ1dHRvblthcmlhLWxhYmVsKj1cIlVwbG9hZFwiXScpO1xyXG4gICAgICAgIHZhciBiciA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1waWNrZXIgYnV0dG9uJyk7XHJcbiAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHt1cDogISF1cCwgYnJvd3NlOiAhIWJyfSk7XHJcbiAgICAgIH0pKClgKSkgYXMgc3RyaW5nO1xyXG4gICAgICBjb25zdCBwID0gSlNPTi5wYXJzZShyKSBhcyB7IHVwOiBib29sZWFuOyBicm93c2U6IGJvb2xlYW4gfTtcclxuICAgICAgcmV0dXJuIFtwLnVwICYmIHAuYnJvd3NlLCBgXHVEODNEXHVEQ0NFPSR7cC51cH0gXHVEODNEXHVEQ0MxPSR7cC5icm93c2V9YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6QCBcdTk2NDRcdTRFRjZcdTkwMDlcdTYyRTlcdTU2NjggPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnQCBcdTk2NDRcdTRFRjY6XHU5MDA5XHU2MkU5XHU1NjY4XHU1MUZBXHU3M0IwXHU1RTc2XHU1M0VGXHU5MDA5XHU2NTg3XHU0RUY2JywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNvbXBvc2VyIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdAJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdhdHQgcGlja2VyJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5hdHQtcGlja2VyJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFwLCBkZXRhaWw6IHAgPyAnb3BlbicgOiAnbm90IG9wZW4nfTtgLCA1XzAwMCk7XHJcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgIGF3YWl0IHR5cGVJbnRvKCcuYXR0LXBpY2tlciBpbnB1dCcsICdyZWFkJyk7XHJcbiAgICAgIGNvbnN0IHcyID0gYXdhaXQgd2FpdEZvcignYXR0IHJlc3VsdHMnLCBgdmFyIHI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmF0dC1yZXN1bHRzIC5mcy1yb3cnKS5sZW5ndGg7XHJcbiAgICAgICAgcmV0dXJuIHtvazogciA+PSAxLCBkZXRhaWw6ICdyZXN1bHRzPScrcn07YCwgNl8wMDApO1xyXG4gICAgICBpZiAoIXcyWzBdKSByZXR1cm4gdzI7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGY9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmF0dC1yZXN1bHRzIC5mcy1yb3cnKTsgaWYoZikgZi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdhdHQgY2hpcCcsIGB2YXIgYz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuYXR0LWNoaXAnKS5sZW5ndGg7XHJcbiAgICAgICAgcmV0dXJuIHtvazogYyA+PSAxLCBkZXRhaWw6ICdjaGlwcz0nK2N9O2AsIDVfMDAwKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZShcdTU0MTFcdTVCRkNcdTY3ODRcdTkwMjApOlx1OEJCRVx1N0Y2RVx1MzAwQ1x1OTFDRFx1NjVCMFx1OTE0RFx1N0Y2RVx1MzAwRFx1OTFDRFx1NTE2NSArIFx1OTAwOVx1NjJFOVx1NjMwMVx1NEU0NSA9PT09PT09PT09ICovXHJcbiAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfV0laQVJEID09PSAnZmFrZScpIHtcclxuICAgICAgYXdhaXQgc3RlcCgnXHU1NDExXHU1QkZDOlx1OEJCRVx1N0Y2RVx1MzAwQ1x1OTFDRFx1NjVCMFx1OTE0RFx1N0Y2RVx1MzAwRFx1OTFDRFx1NTE2NSArIFx1OTAwOVx1NjJFOVx1NjMwMVx1NEU0NSh3aXphcmQuanNvbiknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleToncCcsIGN0cmxLZXk6dHJ1ZSwgc2hpZnRLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XHJcbiAgICAgICAgY29uc3Qgb3BlbiA9IGF3YWl0IHdhaXRGb3IoJ3NldHRpbmdzIG9wZW4nLCBgdmFyIHM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNtZGsuc2V0dGluZ3MnKTtcclxuICAgICAgICAgIHJldHVybiB7b2s6ICEhcywgZGV0YWlsOiBzID8gJ29wZW4nIDogJ2Nsb3NlZCd9O2AsIDVfMDAwKTtcclxuICAgICAgICBpZiAoIW9wZW5bMF0pIHJldHVybiBvcGVuO1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY21kay5zZXR0aW5ncyBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTkxQ0RcdTY1QjBcdTkxNERcdTdGNkUnKT49MDt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgY29uc3Qgc2hvd24gPSBhd2FpdCB3YWl0Rm9yKCd3aXphcmQgcmVvcGVuZWQnLCBgcmV0dXJuIHtvazogISFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKSxcclxuICAgICAgICAgIGRldGFpbDogZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1vdmVybGF5JykgPyAnb3BlbicgOiAnY2xvc2VkJ307YCwgNV8wMDApO1xyXG4gICAgICAgIGlmICghc2hvd25bMF0pIHJldHVybiBzaG93bjtcclxuICAgICAgICBhd2FpdCBzaG90KCd3aXphcmQtcmVlbnRyeScpO1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NTNENlx1NkQ4OCc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgIGNvbnN0IGNsb3NlZCA9IGF3YWl0IHdhaXRGb3IoJ3dpemFyZCBjbG9zZWQnLCBgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3ZlcmxheScpLCBkZXRhaWw6ICdjbG9zZWQnfTtgLCA1XzAwMCk7XHJcbiAgICAgICAgY29uc3Qgc3QgPSAoYXdhaXQganMoYHdpbmRvdy5obWguZ2V0V2l6YXJkKCkudGhlbihmdW5jdGlvbihyKXtyZXR1cm4gSlNPTi5zdHJpbmdpZnkocik7fSlgKSkgYXMgc3RyaW5nO1xyXG4gICAgICAgIGNvbnN0IHAgPSBKU09OLnBhcnNlKHN0KSBhcyB7IHBlcnNpc3RlZD86IHsgZG9uZT86IGJvb2xlYW47IGNob2ljZT86IHN0cmluZyB9IH07XHJcbiAgICAgICAgY29uc3QgcGVyc2lzdGVkID0gcC5wZXJzaXN0ZWQ/LmRvbmUgPT09IHRydWUgJiYgcC5wZXJzaXN0ZWQ/LmNob2ljZSA9PT0gJ2J1bmRsZWQnO1xyXG4gICAgICAgIHJldHVybiBbY2xvc2VkWzBdICYmIHBlcnNpc3RlZCwgYGNsb3NlZD0ke2Nsb3NlZFswXX0gcGVyc2lzdGVkPSR7SlNPTi5zdHJpbmdpZnkocC5wZXJzaXN0ZWQgPz8gbnVsbCl9YF07XHJcbiAgICAgIH0pO1xyXG5cclxuICAgICAgLyogPT09PT09PT09PSBmYWtlKFx1NTQxMVx1NUJGQ1x1Njc4NFx1OTAyMCk6XHU3QTg0XHU1QzRGIDM2MFx1MDBENzY0MCBcdTUxNjhcdTUxNDNcdTdEMjBcdTUzRUZcdThGQkUgKyBcdTUzNTVcdTUxRkJcdTkwMDlcdTk4NzlcdTUzNzNcdTUyNERcdThGREIgPT09PT09PT09PVxyXG4gICAgICAgICBcdTc1MjhcdTYyMzdcdTYyNEJcdTY3M0FcdTVCOUVcdTZENEJcdTc1REJcdTcwQjk6XHU3QTg0XHU4OUM2XHU1M0UzXHU0RTBCXHU5MDA5XHU5ODc5L1x1NjMwOVx1OTRBRVx1ODhBQlx1ODhDMVx1NTIwN1x1NzBCOVx1NEUwRFx1NTIzMFx1MzAwMlx1NEYyQVx1OTAyMFwiXHU2OEMwXHU2RDRCXHU1MjMwXHU1REYyXHU4OEM1XCJcclxuICAgICAgICAgKFx1NEUzQlx1OEZEQlx1N0EwQiBlbnYgXHU1MzczXHU2NUY2XHU4QkZCKVx1OEJBOVx1NTQxMVx1NUJGQ1x1NTFGQVx1NzNCMFx1NEUwOVx1OTAwOVx1OTg3OVx1OERFRlx1NUY4NCxcdTdGMjlcdTUyMzAgMzYwXHUwMEQ3NjQwIFx1NTQwRVx1OTAxMFx1NEUyQVxyXG4gICAgICAgICBlbGVtZW50RnJvbVBvaW50IFx1NjVBRFx1OEEwMChcdTRFMERcdTY2MkZcdTg4QUJcdTg4QzFcdTUyMDcpO1x1NTE4RFx1OUE4Q1x1OEJDMVx1NTM1NVx1NTFGQlx1NTI0RFx1OEZEQlx1NEUwRVx1NTNENlx1NkQ4OFx1MzAwMiAqL1xyXG4gICAgICBhd2FpdCBzdGVwKCdcdTU0MTFcdTVCRkM6XHU3QTg0XHU1QzRGIDM2MFx1MDBENzY0MFx1MjAxNFx1MjAxNFx1NEUwOVx1OTAwOVx1OTg3OShcdTU0MkIgbm90ZSBcdTY1NzRcdTY4MEYpXHU0RTBFXHU2MzA5XHU5NEFFXHU1MTY4XHU5MEU4XHU1M0VGXHU1NDdEXHU0RTJEK1x1NTM1NVx1NTFGQlx1NTM3M1x1NTI0RFx1OEZEQicsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9GQUtFX0RFVEVDVF9GT1VORCA9ICcxJztcclxuICAgICAgICBjb25zdCBzaXplMCA9IHdpbi5nZXRTaXplKCk7XHJcbiAgICAgICAgY29uc3QgdzAgPSBzaXplMFswXSA/PyAxMjgwO1xyXG4gICAgICAgIGNvbnN0IGgwID0gc2l6ZTBbMV0gPz8gODAwO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidwJywgY3RybEtleTp0cnVlLCBzaGlmdEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgICAgIGNvbnN0IG9wZW4gPSBhd2FpdCB3YWl0Rm9yKCdzZXR0aW5ncyBvcGVuJywgYHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrLnNldHRpbmdzJyk7IHJldHVybiB7b2s6ICEhcywgZGV0YWlsOiBzID8gJ29wZW4nIDogJ2Nsb3NlZCd9O2AsIDVfMDAwKTtcclxuICAgICAgICAgIGlmICghb3BlblswXSkgcmV0dXJuIG9wZW47XHJcbiAgICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNtZGsuc2V0dGluZ3MgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU5MUNEXHU2NUIwXHU5MTREXHU3RjZFJyk+PTA7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgICAgY29uc3Qgc2hvd24gPSBhd2FpdCB3YWl0Rm9yKCd3aXphcmQgcmVvcGVuZWQnLCBgcmV0dXJuIHtvazogISFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKSwgZGV0YWlsOiBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKSA/ICdvcGVuJyA6ICdjbG9zZWQnfTtgLCA1XzAwMCk7XHJcbiAgICAgICAgICBpZiAoIXNob3duWzBdKSByZXR1cm4gc2hvd247XHJcbiAgICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTVGMDBcdTU5Q0JcdTkxNERcdTdGNkUnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICAgIGNvbnN0IGRldGVjdFBhZ2UgPSBhd2FpdCB3YWl0Rm9yKCdkZXRlY3QgZm91bmQgcGFnZSgzIG9wdGlvbnMpJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1kZXRlY3QnKTtcclxuICAgICAgICAgICAgdmFyIG9wdHM9cD9wLnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3B0JykubGVuZ3RoOjA7XHJcbiAgICAgICAgICAgIHJldHVybiB7b2s6ICEhcCAmJiBvcHRzPT09MywgZGV0YWlsOiAnb3B0cz0nK29wdHN9O2AsIDEyXzAwMCk7XHJcbiAgICAgICAgICBpZiAoIWRldGVjdFBhZ2VbMF0pIHJldHVybiBkZXRlY3RQYWdlO1xyXG4gICAgICAgICAgLy8gXHU1MzU1XHU1MUZCXHU5MDA5XHU5ODc5XHU1MzczXHU1MjREXHU4RkRCOlx1NzBCOVwiXHU0RUNEXHU4OTgxXHU0RTBCXHU4RjdEXHU2NUIwXHU3MjQ4XCJcdTVFOTRcdTc2RjRcdTYzQTVcdTg0M0RcdTUyMzBcdTkwMDlcdTYyRTlcdTk4NzUoXHU2NUUwXHU5NzAwXHU1MThEXHU3MEI5XCJcdTRFMEJcdTRFMDBcdTZCNjVcIilcclxuICAgICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIG89W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW9wdCcpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1NEVDRFx1ODk4MVx1NEUwQlx1OEY3RFx1NjVCMFx1NzI0OCcpPj0wO30pOyBpZihvKSBvLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICAgIGNvbnN0IHNlbGVjdFBhZ2UgPSBhd2FpdCB3YWl0Rm9yKCdzZWxlY3QgcGFnZSB2aWEgc2luZ2xlIGNsaWNrJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1zZWxlY3QnKTtcclxuICAgICAgICAgICAgcmV0dXJuIHtvazogISFwICYmIHAucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vcHQnKS5sZW5ndGg9PT0zLCBkZXRhaWw6IHAgPyAnc2VsZWN0JyA6ICdub3Qgc2VsZWN0J307YCwgNl8wMDApO1xyXG4gICAgICAgICAgaWYgKCFzZWxlY3RQYWdlWzBdKSByZXR1cm4gW2ZhbHNlLCBgXHU1MzU1XHU1MUZCXHU5MDA5XHU5ODc5XHU2NzJBXHU1MjREXHU4RkRCXHU1MjMwXHU5MDA5XHU2MkU5XHU5ODc1OiAke3NlbGVjdFBhZ2VbMV19YF07XHJcbiAgICAgICAgICAvLyBcdTdGMjlcdTUyMzAgMzYwXHUwMEQ3NjQwKG1pbldpZHRoIFx1NURGMlx1NTcyOCBVSVZFUklGWSBcdTRFMEJcdTY1M0VcdTVCQkQpLFx1NjVBRFx1OEEwMFx1NTE2OFx1OTBFOFx1NTNFRlx1NTQ3RFx1NEUyRFxyXG4gICAgICAgICAgd2luLnNldFNpemUoMzYwLCA2NDApO1xyXG4gICAgICAgICAgYXdhaXQgc2xlZXAoNTAwKTtcclxuICAgICAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoYChmdW5jdGlvbigpe1xyXG4gICAgICAgICAgICBmdW5jdGlvbiBoaXQoZWwpeyBlbC5zY3JvbGxJbnRvVmlldyh7YmxvY2s6J25lYXJlc3QnfSk7IHZhciByPWVsLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xyXG4gICAgICAgICAgICAgIHZhciB4PXIubGVmdCtyLndpZHRoLzIsIHk9ci50b3Arci5oZWlnaHQvMjtcclxuICAgICAgICAgICAgICB2YXIgZT1kb2N1bWVudC5lbGVtZW50RnJvbVBvaW50KHgseSk7XHJcbiAgICAgICAgICAgICAgcmV0dXJuICEhKGUgJiYgKGU9PT1lbCB8fCBlbC5jb250YWlucyhlKSkpOyB9XHJcbiAgICAgICAgICAgIHZhciBjYXJkPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1zZWxlY3QnKTtcclxuICAgICAgICAgICAgdmFyIG9wdHM9W10uc2xpY2UuY2FsbChjYXJkLnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3B0JykpO1xyXG4gICAgICAgICAgICB2YXIgb3B0SGl0PW9wdHMubWFwKGhpdCk7XHJcbiAgICAgICAgICAgIHZhciBub3Rlcz1bXS5zbGljZS5jYWxsKGNhcmQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vcHQtbm90ZScpKTtcclxuICAgICAgICAgICAgdmFyIG5vdGVIaXQ9bm90ZXMubWFwKGZ1bmN0aW9uKG4peyBuLnNjcm9sbEludG9WaWV3KHtibG9jazonbmVhcmVzdCd9KTsgdmFyIHI9bi5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcclxuICAgICAgICAgICAgICB2YXIgZT1kb2N1bWVudC5lbGVtZW50RnJvbVBvaW50KHIubGVmdCtyLndpZHRoLzIsIHIudG9wK01hdGgubWluKHIuaGVpZ2h0LzIsIDgpKTtcclxuICAgICAgICAgICAgICByZXR1cm4gISEoZSAmJiBvcHRzLnNvbWUoZnVuY3Rpb24obyl7IHJldHVybiBlPT09byB8fCBvLmNvbnRhaW5zKGUpOyB9KSk7IH0pO1xyXG4gICAgICAgICAgICB2YXIgYWN0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1zZWxlY3QgLndpemFyZC1hY3Rpb25zIC5idG4ucHJpbWFyeScpO1xyXG4gICAgICAgICAgICB2YXIgZm9vdGVyPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1mb290ZXIgYnV0dG9uJykpO1xyXG4gICAgICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe3Z3OiB3aW5kb3cuaW5uZXJXaWR0aCwgdmg6IHdpbmRvdy5pbm5lckhlaWdodCwgb3B0czogb3B0cy5sZW5ndGgsXHJcbiAgICAgICAgICAgICAgb3B0SGl0OiBvcHRIaXQsIG5vdGVIaXQ6IG5vdGVIaXQsIGFjdEhpdDogYWN0ID8gaGl0KGFjdCkgOiBmYWxzZSwgZnRIaXQ6IGZvb3Rlci5tYXAoaGl0KX0pO1xyXG4gICAgICAgICAgfSkoKWApKSBhcyBzdHJpbmc7XHJcbiAgICAgICAgICBjb25zdCBxID0gSlNPTi5wYXJzZShyKSBhcyB7IHZ3OiBudW1iZXI7IHZoOiBudW1iZXI7IG9wdHM6IG51bWJlcjsgb3B0SGl0OiBib29sZWFuW107IG5vdGVIaXQ6IGJvb2xlYW5bXTsgYWN0SGl0OiBib29sZWFuOyBmdEhpdDogYm9vbGVhbltdIH07XHJcbiAgICAgICAgICBhd2FpdCBzaG90KCd3aXphcmQtbmFycm93LTM2MC1zZWxlY3QnKTtcclxuICAgICAgICAgIGNvbnN0IG5hcnJvd09rID0gcS5vcHRzID09PSAzICYmIHEudncgPD0gMzgwICYmIHEub3B0SGl0LmV2ZXJ5KEJvb2xlYW4pICYmIHEubm90ZUhpdC5ldmVyeShCb29sZWFuKSAmJiBxLmFjdEhpdCAmJiBxLmZ0SGl0LmV2ZXJ5KEJvb2xlYW4pO1xyXG4gICAgICAgICAgLy8gXHU3QTg0XHU1QzRGXHU0RTBCXHU1MzU1XHU1MUZCXHU5MDA5XHU5ODc5XHUyNDYwID0gXHU5MDA5XHU0RTJEXHU1RTc2XHU1MjREXHU4RkRCXHU1MjMwXHU1Qjg5XHU4OEM1XHU5ODc1KHZlcmlmeSBcdTZBMjFcdTYyREZcdThGREJcdTVFQTYsXHU0RTBEXHU4NDNEXHU3NkQ4KVxyXG4gICAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgbz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3B0JykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU0RTBCXHU4RjdEXHU1Qjg5XHU4OEM1XHU1QjhDXHU2NTc0IGhtaCBDTEknKT49MDt9KTsgaWYobykgby5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgICBjb25zdCBhZHYgPSBhd2FpdCB3YWl0Rm9yKCdpbnN0YWxsIHBhZ2UgdmlhIHNpbmdsZSBjbGljaycsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtaW5zdGFsbCcpO1xyXG4gICAgICAgICAgICByZXR1cm4ge29rOiAhIXAsIGRldGFpbDogcCA/ICdpbnN0YWxsaW5nJyA6ICdub3Qgc2hvd24nfTtgLCA2XzAwMCk7XHJcbiAgICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTUzRDZcdTZEODgnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICAgIGNvbnN0IGNsb3NlZE5hcnJvdyA9IGF3YWl0IHdhaXRGb3IoJ3dpemFyZCBjbG9zZWQgYXQgMzYwcHgnLCBgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3ZlcmxheScpLCBkZXRhaWw6ICdjbG9zZWQnfTtgLCA1XzAwMCk7XHJcbiAgICAgICAgICByZXR1cm4gW25hcnJvd09rICYmIGFkdlswXSAmJiBjbG9zZWROYXJyb3dbMF0sXHJcbiAgICAgICAgICAgIGB2cD0ke3Eudnd9eCR7cS52aH0gb3B0cz0ke3Eub3B0c30gb3B0SGl0PVske3Eub3B0SGl0LmpvaW4oJywnKX1dIG5vdGVIaXQ9WyR7cS5ub3RlSGl0LmpvaW4oJywnKX1dIFx1NEUzQlx1NjMwOVx1OTRBRT0ke3EuYWN0SGl0fSBmb290ZXI9WyR7cS5mdEhpdC5qb2luKCcsJyl9XTsgXHU1MzU1XHU1MUZCXHU1MjREXHU4RkRCOiAke2FkdlsxXX07IFx1N0E4NFx1NUM0Rlx1NTNENlx1NkQ4ODogJHtjbG9zZWROYXJyb3dbMV19YF07XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgIHdpbi5zZXRTaXplKHcwLCBoMCk7XHJcbiAgICAgICAgICBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9GQUtFX0RFVEVDVF9GT1VORCA9IHVuZGVmaW5lZDtcclxuICAgICAgICB9XHJcbiAgICAgIH0pO1xyXG4gICAgfVxyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpISUcgXHU5NjM2XHU2QkI1MiBcdTIwMTRcdTIwMTQgXHU3QTg0XHU3QTk3XHU2MkJEXHU1QzQ5ICsgXHU2ODA3XHU5ODk4XHU2ODBGIDQ0cHgvZHJhZyBcdTUzM0EgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU3QTg0XHU3QTk3XHU2MkJEXHU1QzQ5Ojc2MHB4IFx1NEZBN1x1NjgwRlx1NTNFRlx1OEZCRVx1NTNFRlx1NTE3MyhcdTkwNkVcdTdGNjlcdTcwQjlcdTUxRkIgKyBFc2MpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICB0cnkgeyB3aW4uc2V0TWluaW11bVNpemUoNTYwLCA2MDApOyB3aW4uc2V0Qm91bmRzKHsgd2lkdGg6IDc2MCwgaGVpZ2h0OiA3MDAgfSk7IH0gY2F0Y2ggeyAvKiBiZXN0IGVmZm9ydCAqLyB9XHJcbiAgICAgIGNvbnN0IGlzTmFycm93ID0gYXdhaXQgd2FpdEZvcignbWF0Y2hNZWRpYSA4MjAnLCBgcmV0dXJuIHtvazogd2luZG93Lm1hdGNoTWVkaWEoJyhtYXgtd2lkdGg6IDgyMHB4KScpLm1hdGNoZXMsIGRldGFpbDogJ2l3PScgKyB3aW5kb3cuaW5uZXJXaWR0aH07YCwgNV8wMDApO1xyXG4gICAgICBpZiAoIWlzTmFycm93WzBdKSByZXR1cm4gaXNOYXJyb3c7XHJcbiAgICAgIC8vIFx1N0I0OSBSZWFjdCBcdTYzMDlcdTdBODRcdTdBOTdcdTkxQ0RcdTZFMzJcdTY3RDNcdTUxRkFcdTYyQkRcdTVDNDlcdTYzMDlcdTk0QUUoYXJpYS1sYWJlbCBcdTYzNjJcdTYyMTBcIlx1NjJCRFx1NUM0OVwiXHU2NTg3XHU2ODQ4KVx1NTE4RFx1NzBCOVx1MjAxNFx1MjAxNENTUyBcdTY1QURcdTcwQjlcdTUzNzNcdTY1RjYsXHJcbiAgICAgIC8vIFJlYWN0IHN0YXRlIFx1NjcwOVx1NkJFQlx1NzlEMlx1N0VBN1x1NUVGNlx1OEZERixcdTc2RjJcdTcwQjlcdTRGMUFcdTg0M0RcdTU3MjhcdTY1RTdcdTc2ODRcIlx1NjUzNlx1OEQ3N1x1NEZBN1x1NjgwRlwiXHU0RTBBXHJcbiAgICAgIGNvbnN0IGJ0biA9IGF3YWl0IHdhaXRGb3IoJ2RyYXdlciBidXR0b24nLCBgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudG9wYmFyIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiAoeC5nZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnKXx8JycpLmluZGV4T2YoJ1x1NjJCRFx1NUM0OScpPj0wO30pO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYiwgZGV0YWlsOiAnYnRuPScrKGI/Yi5nZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnKTonbm9uZScpfTtgLCA1XzAwMCk7XHJcbiAgICAgIGlmICghYnRuWzBdKSByZXR1cm4gYnRuO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnRvcGJhciBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4gKHguZ2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJyl8fCcnKS5pbmRleE9mKCdcdTYyQkRcdTVDNDknKT49MDt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IG9wZW5lZCA9IGF3YWl0IHdhaXRGb3IoJ2RyYXdlciBvcGVuJywgYHZhciBzYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhcicpLCBzYz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhci1zY3JpbScpO1xyXG4gICAgICAgIHZhciByPXNiP3NiLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOm51bGw7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFyICYmIHIueCA+PSAwICYmIHIueCA8IDQwICYmICEhc2MsIGRldGFpbDogJ3g9Jysocj9NYXRoLnJvdW5kKHIueCk6J25vbmUnKSsnIHNjcmltPScrKHNjPyd5ZXMnOidubycpfTtgLCA1XzAwMCk7XHJcbiAgICAgIGF3YWl0IHNob3QoJ2RyYXdlci1vcGVuJyk7XHJcbiAgICAgIC8vIFx1OTA2RVx1N0Y2OVx1NzBCOVx1NTFGQlx1NTE3M1x1OTVFRCBcdTIxOTIgXHU0RkE3XHU2ODBGXHU2RUQxXHU1MUZBKHggPCAwKSsgXHU5MDZFXHU3RjY5XHU2RDg4XHU1OTMxXHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHNjPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyLXNjcmltJyk7IGlmKHNjKSBzYy5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IGNsb3NlZCA9IGF3YWl0IHdhaXRGb3IoJ2RyYXdlciBjbG9zZWQgYnkgc2NyaW0nLCBgdmFyIHNiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyJyksIHNjPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyLXNjcmltJyk7XHJcbiAgICAgICAgdmFyIHI9c2I/c2IuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk6bnVsbDtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXIgJiYgci54IDwgMCAmJiAhc2MsIGRldGFpbDogJ3g9Jysocj9NYXRoLnJvdW5kKHIueCk6J25vbmUnKSsnIHNjcmltPScrKHNjPyd5ZXMnOidubycpfTtgLCA1XzAwMCk7XHJcbiAgICAgIC8vIEVzYyBcdTRFNUZcdTgwRkRcdTVGMDAvXHU1MTczXHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudG9wYmFyIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiAoeC5nZXRBdHRyaWJ1dGUoJ2FyaWEtbGFiZWwnKXx8JycpLmluZGV4T2YoJ1x1NjJCRFx1NUM0OScpPj0wO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgYXdhaXQgd2FpdEZvcignZHJhd2VyIHJlb3BlbicsIGB2YXIgc2I9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXInKTsgdmFyIHI9c2I/c2IuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk6bnVsbDtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXIgJiYgci54ID49IDAgJiYgci54IDwgNDAsIGRldGFpbDogJ3g9Jysocj9NYXRoLnJvdW5kKHIueCk6J25vbmUnKX07YCwgNV8wMDApO1xyXG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidFc2NhcGUnLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgY29uc3QgZXNjQ2xvc2VkID0gYXdhaXQgd2FpdEZvcignZHJhd2VyIGNsb3NlZCBieSBFc2MnLCBgdmFyIHNiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyJyk7IHZhciByPXNiP3NiLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOm51bGw7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFyICYmIHIueCA8IDAsIGRldGFpbDogJ3g9Jysocj9NYXRoLnJvdW5kKHIueCk6J25vbmUnKX07YCwgNV8wMDApO1xyXG4gICAgICAvLyBcdTYwNjJcdTU5MERcdTVCQkRcdTdBOTc6XHU0RkE3XHU2ODBGXHU1NkRFXHU1MjMwIGdyaWQgXHU1MjE3KGRpc3BsYXkgXHU5NzVFIG5vbmUsXHU2QjYzXHU1RTM4XHU1MjE3XHU1RTAzXHU1QzQwKVxyXG4gICAgICB0cnkgeyB3aW4uc2V0Qm91bmRzKHsgd2lkdGg6IDEyODAsIGhlaWdodDogODAwIH0pOyB9IGNhdGNoIHsgLyogYmVzdCBlZmZvcnQgKi8gfVxyXG4gICAgICBhd2FpdCBzbGVlcCg0MDApO1xyXG4gICAgICBjb25zdCB3aWRlID0gYXdhaXQgd2FpdEZvcignd2lkZSByZXN0b3JlZCcsIGB2YXIgc2I9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXInKTsgdmFyIHI9c2I/c2IuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk6bnVsbDtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXIgJiYgci53aWR0aCA+IDIwMCAmJiBnZXRDb21wdXRlZFN0eWxlKHNiKS5kaXNwbGF5ICE9PSAnbm9uZScsIGRldGFpbDogJ3c9Jysocj9NYXRoLnJvdW5kKHIud2lkdGgpOidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgICAgcmV0dXJuIFtvcGVuZWRbMF0gJiYgY2xvc2VkWzBdICYmIGVzY0Nsb3NlZFswXSAmJiB3aWRlWzBdLCBgb3BlbjogJHtvcGVuZWRbMV19OyBzY3JpbS1jbG9zZTogJHtjbG9zZWRbMV19OyBlc2MtY2xvc2U6ICR7ZXNjQ2xvc2VkWzFdfTsgd2lkZTogJHt3aWRlWzFdfWBdO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdcdTY4MDdcdTk4OThcdTY4MEY6NDRweCArIGRyYWcgXHU1MzNBKFx1ODNEQ1x1NTM1NSBuby1kcmFnO292ZXJsYXkgXHU5QUQ4XHU1RUE2XHU0RTAwXHU4MUY0KScsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgciA9IChhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XHJcbiAgICAgICAgdmFyIHRiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy50aXRsZWJhcicpLCBtYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudGl0bGViYXItbWVudScpO1xyXG4gICAgICAgIGlmKCF0YiB8fCAhbWIpIHJldHVybiBKU09OLnN0cmluZ2lmeSh7b2s6ZmFsc2UsIGRldGFpbDonbWlzc2luZyB0aXRsZWJhci9tZW51J30pO1xyXG4gICAgICAgIHZhciBjcz1nZXRDb21wdXRlZFN0eWxlKHRiKSwgbXM9Z2V0Q29tcHV0ZWRTdHlsZShtYik7XHJcbiAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHsgb2s6IGNzLmhlaWdodCA9PT0gJzQ0cHgnICYmIGNzLndlYmtpdEFwcFJlZ2lvbiA9PT0gJ2RyYWcnICYmIG1zLndlYmtpdEFwcFJlZ2lvbiA9PT0gJ25vLWRyYWcnICYmIG1iLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpLmhlaWdodCA+PSAzNixcclxuICAgICAgICAgIGRldGFpbDogJ2g9Jytjcy5oZWlnaHQrJyByZWdpb249Jytjcy53ZWJraXRBcHBSZWdpb24rJyBtZW51LXJlZ2lvbj0nK21zLndlYmtpdEFwcFJlZ2lvbisnIG1lbnUtaD0nK01hdGgucm91bmQobWIuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCkuaGVpZ2h0KSB9KTtcclxuICAgICAgfSkoKWApKSBhcyBzdHJpbmc7XHJcbiAgICAgIGNvbnN0IHAgPSBKU09OLnBhcnNlKHIpIGFzIHsgb2s6IGJvb2xlYW47IGRldGFpbDogc3RyaW5nIH07XHJcbiAgICAgIC8vIFx1NEUzQlx1OEZEQlx1N0EwQlx1NEZBNzpcdTUzOUZcdTc1MUYgdGl0bGVCYXJPdmVybGF5IFx1OUFEOFx1NUVBNlx1OTg3Qlx1NTQwQ1x1NEUzQSA0NChXaW5kb3dzIFx1NjI0RFx1NjcwOSBvdmVybGF5O1x1NjVFN1x1N0M3Qlx1NTc4Qlx1N0YzQVx1NkI2NCBBUEksXHU1M0VGXHU5MDA5XHU4QzAzXHU3NTI4KVxyXG4gICAgICBsZXQgb3ZlcmxheSA9ICduL2EnO1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHByb2JlID0gd2luIGFzIHVua25vd24gYXMgeyBnZXRUaXRsZUJhck92ZXJsYXk/OiAoKSA9PiB7IGhlaWdodD86IG51bWJlciB9IHwgbnVsbCB9O1xyXG4gICAgICAgIGNvbnN0IG8gPSBwcm9iZS5nZXRUaXRsZUJhck92ZXJsYXk/LigpID8/IG51bGw7XHJcbiAgICAgICAgb3ZlcmxheSA9IG8gIT09IG51bGwgPyBTdHJpbmcoby5oZWlnaHQpIDogJ24vYSc7XHJcbiAgICAgIH0gY2F0Y2ggeyAvKiBcdTVFNzNcdTUzRjBcdTY1RTAgb3ZlcmxheSAqLyB9XHJcbiAgICAgIHJldHVybiBbcC5vayA9PT0gdHJ1ZSwgYCR7cC5kZXRhaWx9IG92ZXJsYXktaD0ke292ZXJsYXl9YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU2NkY0XHU2NUIwXHU2QTJBXHU1RTQ1KG1vY2sgdXBkYXRlOnN0YXRlIFx1NEUwOVx1NjAwMTtcdTRFRkJcdTUyQTEgMTMtQykgPT09PT09PT09PVxyXG4gICAgICAgXHU0RTNCXHU4RkRCXHU3QTBCXHU3NkY0XHU1M0QxIG1vY2sgXHU3MkI2XHU2MDAxOlx1NjhDMFx1NjdFNVx1NEUyRFx1OTc1OVx1OUVEOCBcdTIxOTIgXHU0RTBCXHU4RjdEXHU0RTJEKFx1OEZEQlx1NUVBNi9cdTkwMUZcdTVFQTYvXHU4RkRCXHU1RUE2XHU2NzYxKVx1MjE5MiBcdTVDMzFcdTdFRUFcclxuICAgICAgIChcIlx1OTFDRFx1NTQyRlx1NjZGNFx1NjVCMFwiXHU1M0VGXHU3MEI5XHUzMDAxXHU2NUUwXHU1OTE2XHU5NEZFXHUzMDAxYXBwbHkgXHU0RTBEXHU1RDI5KVx1MjE5MiBcdTU5MzFcdThEMjUoXHU5MUNEXHU4QkQ1XHU2RDQxXHU4RjZDICsgXHU3QTBEXHU1NDBFXHU1MTczXHU5NUVEKVx1MzAwMiAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU2NkY0XHU2NUIwXHU2QTJBXHU1RTQ1Olx1NjhDMFx1NjdFNVx1NEUyRFx1OTc1OVx1OUVEOFx1NjVFMFx1NkEyQVx1NUU0NSBcdTIxOTIgXHU0RTBCXHU4RjdEXHU0RTJEXHU4RkRCXHU1RUE2XHU1M0VGXHU4OUMxKFx1NUI1N1x1ODI4Mi9cdTkwMUZcdTVFQTYvXHU4RkRCXHU1RUE2XHU2NzYxKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3Qgc3RCYXNlID0geyBjaGVja2luZzogZmFsc2UsIGN1cnJlbnRWZXJzaW9uOiAnMC4yLjknLCBsYXRlc3Q6IG51bGwsIG5vdGVzOiAnJywgZG93bmxvYWRlZDogZmFsc2UsIGVycm9yOiAnJywgY2hhbm5lbDogJycsIHByb2dyZXNzOiBudWxsIH07XHJcbiAgICAgIC8vIGNoZWNraW5nIFx1NjAwMTpcdTk3NTlcdTlFRDhcdTY4QzBcdTY3RTUsXHU0RTBEXHU2MjUzXHU2MjcwXHU0RUZCXHU1MkExXHU1MzNBXHJcbiAgICAgIHdpbi53ZWJDb250ZW50cy5zZW5kKCd1cGRhdGU6c3RhdGUnLCB7IC4uLnN0QmFzZSwgY2hlY2tpbmc6IHRydWUgfSk7XHJcbiAgICAgIGF3YWl0IHNsZWVwKDQwMCk7XHJcbiAgICAgIGNvbnN0IHNpbGVudCA9IChhd2FpdCBqcyhgIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy51cGRhdGUtYmFubmVyJylgKSkgYXMgYm9vbGVhbjtcclxuICAgICAgLy8gXHU0RTBCXHU4RjdEXHU0RTJEOlx1NzI0OFx1NjcyQ1x1NTNGNyArIFx1NURGMlx1NEUwQlx1OEY3RC9cdTYwM0JcdTVCNTdcdTgyODIgKyBcdTkwMUZcdTVFQTYgKyBcdThGREJcdTVFQTZcdTY3NjFcdTVCQkRcdTVFQTZcclxuICAgICAgd2luLndlYkNvbnRlbnRzLnNlbmQoJ3VwZGF0ZTpzdGF0ZScsIHsgLi4uc3RCYXNlLCBsYXRlc3Q6ICd2MC4zLjAnLCBjaGFubmVsOiAnYXRvbWdpdChcdTU2RkRcdTUxODUpJywgcHJvZ3Jlc3M6IHsgcmVjZWl2ZWQ6IDQ3XzAwMF8wMDAsIHRvdGFsOiAxMTJfMTQ3XzE5OSwgc3BlZWRCcHM6IDJfMTAwXzAwMCB9IH0pO1xyXG4gICAgICBjb25zdCBkbCA9IGF3YWl0IHdhaXRGb3IoJ2Rvd25sb2FkaW5nIGJhbm5lcicsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudXBkYXRlLWJhbm5lcicpO1xyXG4gICAgICAgIGlmKCFiKSByZXR1cm4ge29rOmZhbHNlLCBkZXRhaWw6J25vIGJhbm5lcid9O1xyXG4gICAgICAgIHZhciB0PWIudGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKTtcclxuICAgICAgICB2YXIgYmFyPWIucXVlcnlTZWxlY3RvcignLnVwZGF0ZS1iYXItZmlsbCcpO1xyXG4gICAgICAgIHZhciB3PWJhcj9wYXJzZUZsb2F0KGJhci5zdHlsZS53aWR0aCk6MDtcclxuICAgICAgICByZXR1cm4ge29rOiB0LmluZGV4T2YoJ3YwLjMuMCcpPj0wICYmIHQuaW5kZXhPZignLycpPj0wICYmIHQuaW5kZXhPZignL3MnKT49MCAmJiB3PjMwICYmIHc8PTEwMCwgZGV0YWlsOiAndGV4dD0nK3Quc2xpY2UoMCw3MCkrJyBiYXJXPScrd307YCwgNV8wMDApO1xyXG4gICAgICBhd2FpdCBzaG90KCd1cGRhdGUtZG93bmxvYWRpbmcnKTtcclxuICAgICAgcmV0dXJuIFtzaWxlbnQgJiYgZGxbMF0sIGBjaGVja2luZyBcdTk3NTlcdTlFRDg9JHtzaWxlbnR9OyAke2RsWzFdfWBdO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdcdTY2RjRcdTY1QjBcdTZBMkFcdTVFNDU6XHU1QzMxXHU3RUVBXHU2MDAxXCJcdTkxQ0RcdTU0MkZcdTY2RjRcdTY1QjBcIlx1NTNFRlx1NzBCOVx1MzAwMVx1NjVFMFx1NTkxNlx1OTRGRVx1NUYxNVx1NUJGQyxhcHBseSBcdTg5RTZcdTUzRDEgcHJlbG9hZCBcdTRFMTRcdThGREJcdTdBMEJcdTVCNThcdTZEM0InLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIHdpbi53ZWJDb250ZW50cy5zZW5kKCd1cGRhdGU6c3RhdGUnLCB7IGNoZWNraW5nOiBmYWxzZSwgY3VycmVudFZlcnNpb246ICcwLjIuOScsIGxhdGVzdDogJ3YwLjMuMCcsIG5vdGVzOiAnJywgZG93bmxvYWRlZDogdHJ1ZSwgZXJyb3I6ICcnLCBjaGFubmVsOiAnYXRvbWdpdChcdTU2RkRcdTUxODUpJywgcHJvZ3Jlc3M6IG51bGwgfSk7XHJcbiAgICAgIGNvbnN0IHJlYWR5ID0gYXdhaXQgd2FpdEZvcigncmVhZHkgYmFubmVyJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy51cGRhdGUtYmFubmVyJyk7XHJcbiAgICAgICAgdmFyIGJ0bj1iP2IucXVlcnlTZWxlY3RvcignLnVwZGF0ZS1yZXN0YXJ0Jyk6bnVsbDtcclxuICAgICAgICB2YXIgbGlua3M9Yj9iLnF1ZXJ5U2VsZWN0b3JBbGwoJ2EnKS5sZW5ndGg6LTE7XHJcbiAgICAgICAgdmFyIG5vRXh0PWI/KGIudGV4dENvbnRlbnQuaW5kZXhPZignXHU0RTBCXHU4RjdEXHU5ODc1Jyk8MCAmJiBiLnRleHRDb250ZW50LmluZGV4T2YoJ2h0dHAnKTwwKTpmYWxzZTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWIgJiYgISFidG4gJiYgYnRuLmRpc2FibGVkPT09ZmFsc2UgJiYgbGlua3M9PT0wICYmIG5vRXh0LCBkZXRhaWw6ICdidG49JysoYnRuP2J0bi50ZXh0Q29udGVudDonbm9uZScpKycgbGlua3M9JytsaW5rcysnIG5vRXh0PScrbm9FeHR9O2AsIDVfMDAwKTtcclxuICAgICAgYXdhaXQgc2hvdCgndXBkYXRlLXJlYWR5Jyk7XHJcbiAgICAgIGlmICghcmVhZHlbMF0pIHJldHVybiByZWFkeTtcclxuICAgICAgLy8gcHJlbG9hZCBcdTY4NjVcdTU3MjggKyBcdTcwQjlcdTUxRkJcdTU0MEVcdThGREJcdTdBMEJcdTVCNThcdTZEM0IobW9jayBcdTY1RTBcdTVCODlcdTg4QzVcdTUzMDUgXHUyMTkyIGFwcGx5VXBkYXRlIG5vLW9wIFx1NEUwRFx1OTAwMFx1NTFGQTtcclxuICAgICAgLy8gXHU0RTNCXHU4RkRCXHU3QTBCXHU0RkE3XHU2NzA5IFwiYXBwbHkgcmVxdWVzdGVkXCIgXHU2NUU1XHU1RkQ3XHU4ODRDLFx1NzUzMVx1OUE3MVx1NTJBOFx1NTY2OFx1OEY5M1x1NTFGQVx1NEVCQVx1NUJBMSlcdTMwMDJcclxuICAgICAgY29uc3QgaGFzQnJpZGdlID0gKGF3YWl0IGpzKGB0eXBlb2Ygd2luZG93LmhtaC5hcHBseVVwZGF0ZSA9PT0gJ2Z1bmN0aW9uJyAmJiB0eXBlb2Ygd2luZG93LmhtaC5jaGVja1VwZGF0ZSA9PT0gJ2Z1bmN0aW9uJ2ApKSBhcyBib29sZWFuO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy51cGRhdGUtYmFubmVyIC51cGRhdGUtcmVzdGFydCcpOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgYXdhaXQgc2xlZXAoODAwKTtcclxuICAgICAgY29uc3QgYWxpdmUgPSAoYXdhaXQganMoYCEhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnVwZGF0ZS1iYW5uZXInKSAmJiAhIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jb21wb3NlciB0ZXh0YXJlYScpYCkpIGFzIGJvb2xlYW47XHJcbiAgICAgIHJldHVybiBbaGFzQnJpZGdlICYmIGFsaXZlLCBgcHJlbG9hZCBhcHBseVVwZGF0ZS9jaGVja1VwZGF0ZT0ke2hhc0JyaWRnZX07IFx1NzBCOVx1NTFGQlx1NTQwRVx1NkEyQVx1NUU0NVx1NEUwRSBjb21wb3NlciBcdTVCNThcdTZEM0I9JHthbGl2ZX1gXTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnXHU2NkY0XHU2NUIwXHU2QTJBXHU1RTQ1Olx1NTkzMVx1OEQyNVx1NjAwMVx1OTUxOVx1OEJFRlx1NjYwRVx1N0VDNitcdTkxQ0RcdThCRDVcdTZENDFcdThGNkMsXHU3QTBEXHU1NDBFXHU1M0VGXHU1MTczXHU5NUVEJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICB3aW4ud2ViQ29udGVudHMuc2VuZCgndXBkYXRlOnN0YXRlJywgeyBjaGVja2luZzogZmFsc2UsIGN1cnJlbnRWZXJzaW9uOiAnMC4yLjknLCBsYXRlc3Q6IG51bGwsIG5vdGVzOiAnJywgZG93bmxvYWRlZDogZmFsc2UsIGVycm9yOiAnXHU1MTY4XHU5MEU4XHU2OEMwXHU2N0U1XHU5MDFBXHU5MDUzXHU1OTMxXHU4RDI1KFx1NzZGNFx1OEZERTpcdThEODVcdTY1RjYoOHMpOyBhdG9tZ2l0KFx1NTZGRFx1NTE4NSk6SFRUUCA1MDI7IGdoLXByb3h5Olx1OEQ4NVx1NjVGNigxMHMpKScsIGNoYW5uZWw6ICcnLCBwcm9ncmVzczogbnVsbCB9KTtcclxuICAgICAgY29uc3QgZXJyID0gYXdhaXQgd2FpdEZvcignZXJyb3IgYmFubmVyJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy51cGRhdGUtYmFubmVyJyk7XHJcbiAgICAgICAgdmFyIGJ0bj1iP2IucXVlcnlTZWxlY3RvcignLnVwZGF0ZS1yZXRyeScpOm51bGw7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFiICYmIGIudGV4dENvbnRlbnQuaW5kZXhPZignXHU2NkY0XHU2NUIwXHU2OEMwXHU2N0U1XHU1OTMxXHU4RDI1Jyk+PTAgJiYgYi50ZXh0Q29udGVudC5pbmRleE9mKCdhdG9tZ2l0Jyk+PTAgJiYgISFidG4gJiYgYnRuLmRpc2FibGVkPT09ZmFsc2UsIGRldGFpbDogYiA/IGIudGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDkwKSA6ICdubyBiYW5uZXInfTtgLCA1XzAwMCk7XHJcbiAgICAgIGF3YWl0IHNob3QoJ3VwZGF0ZS1lcnJvcicpO1xyXG4gICAgICBpZiAoIWVyclswXSkgcmV0dXJuIGVycjtcclxuICAgICAgLy8gXHU3MEI5XHU5MUNEXHU4QkQ1IFx1MjE5MiBcdThGREJcdTUxNjUgY2hlY2tpbmcoXHU2QTJBXHU1RTQ1XHU2MzA5XHU3MkI2XHU2MDAxXHU2NzNBXHU2NTM2XHU4RDc3O1x1NzcxRlx1NUI5RSBjaGVja0ZvclVwZGF0ZXMgXHU1NzI4XHU1NDBFXHU1M0YwXHU4REQxLFx1NEUwRFx1NUY3MVx1NTRDRFx1NjcyQ1x1NkI2NSlcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudXBkYXRlLWJhbm5lciAudXBkYXRlLXJldHJ5Jyk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCB0b0NoZWNraW5nID0gYXdhaXQgd2FpdEZvcignYmFubmVyIGhpZGRlbiBvbiByZXRyeScsIGByZXR1cm4ge29rOiAhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnVwZGF0ZS1iYW5uZXInKSwgZGV0YWlsOiBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudXBkYXRlLWJhbm5lcicpID8gJ3N0aWxsJyA6ICdoaWRkZW4nfTtgLCA1XzAwMCk7XHJcbiAgICAgIC8vIFx1NjA2Mlx1NTkwRFx1NUMzMVx1N0VFQVx1NjAwMVx1OUE4Q1x1OEJDMVwiXHU3QTBEXHU1NDBFXCI6XHU3MEI5XHU1MUZCXHU1NDBFXHU2QTJBXHU1RTQ1XHU1MTczXHU5NUVEKFx1NEYxQVx1OEJERFx1NTE4NVx1OTc1OVx1OUVEOCxcdTRFMEJcdTZCMjFcdTU0MkZcdTUyQThcdTUxOERcdTYzRDBcdTkxOTIpXHJcbiAgICAgIHdpbi53ZWJDb250ZW50cy5zZW5kKCd1cGRhdGU6c3RhdGUnLCB7IGNoZWNraW5nOiBmYWxzZSwgY3VycmVudFZlcnNpb246ICcwLjIuOScsIGxhdGVzdDogJ3YwLjMuMCcsIG5vdGVzOiAnJywgZG93bmxvYWRlZDogdHJ1ZSwgZXJyb3I6ICcnLCBjaGFubmVsOiAnYXRvbWdpdChcdTU2RkRcdTUxODUpJywgcHJvZ3Jlc3M6IG51bGwgfSk7XHJcbiAgICAgIGF3YWl0IHdhaXRGb3IoJ3JlYWR5IGFnYWluJywgYHJldHVybiB7b2s6ICEhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnVwZGF0ZS1iYW5uZXIgLnVwZGF0ZS1yZXN0YXJ0JyksIGRldGFpbDogJ3JlYWR5J307YCwgNV8wMDApO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBicz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy51cGRhdGUtYmFubmVyIGJ1dHRvbicpKTsgdmFyIGI9YnMuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTdBMERcdTU0MEUnKT49MDt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IGRpc21pc3NlZCA9IGF3YWl0IHdhaXRGb3IoJ2Jhbm5lciBkaXNtaXNzZWQnLCBgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy51cGRhdGUtYmFubmVyJyksIGRldGFpbDogZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnVwZGF0ZS1iYW5uZXInKSA/ICdzdGlsbCcgOiAnZGlzbWlzc2VkJ307YCwgNV8wMDApO1xyXG4gICAgICByZXR1cm4gW3RvQ2hlY2tpbmdbMF0gJiYgZGlzbWlzc2VkWzBdLCBgXHU5MUNEXHU4QkQ1XHUyMTkyY2hlY2tpbmcgXHU2NTM2XHU4RDc3PSR7dG9DaGVja2luZ1swXX07IFx1N0EwRFx1NTQwRVx1NTE3M1x1OTVFRD0ke2Rpc21pc3NlZFswXX1gXTtcclxuICAgIH0pO1xyXG5cclxuICAgIGF3YWl0IHNob3QoJ2ZpbmFsJyk7XHJcbiAgfSBlbHNlIGlmICgocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfV0laQVJEID8/ICcnKSAhPT0gJycpIHtcclxuICAgIC8qID09PT09PT09PT0gcmVhbChcdTU0MTFcdTVCRkNcdTY3ODRcdTkwMjAsXHU0RTkyXHU2NUE1XHU0RThFXHU1RTM4XHU4OUM0IHJlYWwgXHU2QjY1XHU5QUE0KTpcclxuICAgICAgIFdaMiBcdTY3MkNcdTY3M0FcdTc3MUZcdTVCOUVcdTY4QzBcdTZENEIoXHU5RUQ4XHU4QkE0XHU1MTcxXHU0RUFCXHU5ODc1KS8gV1ozIFx1NEUwQlx1OEY3RFx1NUI4OVx1ODhDNVx1NUI5RVx1NkQ0QiA9PT09PT09PT09ICovXHJcbiAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfV0laQVJEID09PSAnZGV0ZWN0Jykge1xyXG4gICAgICBhd2FpdCBzdGVwKCdcdTU0MTFcdTVCRkMoXHU3NzFGXHU1QjlFKTpcdTZCMjJcdThGQ0VcdTIxOTJcdTY4QzBcdTZENEJcdTUyMzBcdTY3MkNcdTY3M0FcdTVERjJcdTg4QzUgQ0xJKFx1OUVEOFx1OEJBNFx1NTE3MVx1NEVBQixcdTUyRkVcdTkwMDlcdTZCNjNcdTc4NkUpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCd3aXphcmQgb3ZlcmxheScsIGB2YXIgbz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKTtcclxuICAgICAgICAgIHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTVGMDBcdTU5Q0JcdTkxNERcdTdGNkUnO30pO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogISFvICYmICEhYiwgZGV0YWlsOiBvID8gJ292ZXJsYXkrXHU1RjAwXHU1OUNCXHU5MTREXHU3RjZFJyA6ICdubyBvdmVybGF5J307YCwgMTJfMDAwKTtcclxuICAgICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICAgIGF3YWl0IHNob3QoJ3dpemFyZC1yZWFsLXdlbGNvbWUnKTtcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTVGMDBcdTU5Q0JcdTkxNERcdTdGNkUnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICBjb25zdCBmb3VuZCA9IGF3YWl0IHdhaXRGb3IoJ2RldGVjdCBmb3VuZCcsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtZGV0ZWN0Jyk7XHJcbiAgICAgICAgICBpZighcCkgcmV0dXJuIHtvazpmYWxzZSwgZGV0YWlsOidkZXRlY3QgcGFnZSBub3Qgc2hvd24nfTtcclxuICAgICAgICAgIHZhciB0PXAudGV4dENvbnRlbnQ7XHJcbiAgICAgICAgICB2YXIgb2sxPXQuaW5kZXhPZignXHU2OEMwXHU2RDRCXHU1MjMwXHU1REYyXHU1Qjg5XHU4OEM1IGhtaGFybmVzcyB2Jyk+PTA7XHJcbiAgICAgICAgICB2YXIgb2syPXQuaW5kZXhPZignXHU5RUQ4XHU4QkE0XHU1MTcxXHU0RUFCXHU0RjdGXHU3NTI4XHU1QjgzKFx1NjNBOFx1ODM1MCknKT49MDtcclxuICAgICAgICAgIHZhciByYWRpbz1wLnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3B0Lm9uJyk7XHJcbiAgICAgICAgICByZXR1cm4ge29rOiBvazEmJm9rMiYmISFyYWRpbywgZGV0YWlsOiB0LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw5MCl9O2AsIDIwXzAwMCk7XHJcbiAgICAgICAgYXdhaXQgc2hvdCgnd2l6YXJkLXJlYWwtZGV0ZWN0Jyk7XHJcbiAgICAgICAgcmV0dXJuIGZvdW5kO1xyXG4gICAgICB9KTtcclxuICAgIH0gZWxzZSBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfV0laQVJEID09PSAnaW5zdGFsbCcpIHtcclxuICAgICAgYXdhaXQgc3RlcCgnXHU1NDExXHU1QkZDKFx1NzcxRlx1NUI5RSk6XHU2OEMwXHU2RDRCXHUyMTkyXHU0RUNEXHU4OTgxXHU0RTBCXHU4RjdEXHU2NUIwXHU3MjQ4XHUyMTkyXHU5MDA5XHU2MkU5XHUyNDYwXHUyMTkyXHU4RkRCXHU1MTY1XHU1Qjg5XHU4OEM1XHU5ODc1JywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCd3aXphcmQgb3ZlcmxheScsIGB2YXIgbz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKTtcclxuICAgICAgICAgIHJldHVybiB7b2s6ICEhbywgZGV0YWlsOiBvID8gJ29wZW4nIDogJ2Nsb3NlZCd9O2AsIDEyXzAwMCk7XHJcbiAgICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTVGMDBcdTU5Q0JcdTkxNERcdTdGNkUnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICBjb25zdCBmb3VuZCA9IGF3YWl0IHdhaXRGb3IoJ2RldGVjdCBmb3VuZCcsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtZGV0ZWN0Jyk7XHJcbiAgICAgICAgICByZXR1cm4ge29rOiAhIXAgJiYgcC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTY4QzBcdTZENEJcdTUyMzBcdTVERjJcdTVCODlcdTg4QzUgaG1oYXJuZXNzIHYnKT49MCwgZGV0YWlsOiBwID8gcC50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNjApIDogJ25vIGRldGVjdCBwYWdlJ307YCwgMjBfMDAwKTtcclxuICAgICAgICBpZiAoIWZvdW5kWzBdKSByZXR1cm4gZm91bmQ7XHJcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgbz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3B0JykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU0RUNEXHU4OTgxXHU0RTBCXHU4RjdEXHU2NUIwXHU3MjQ4Jyk+PTA7fSk7IGlmKG8pIG8uY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgIGF3YWl0IHNsZWVwKDIwMCk7XHJcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU0RTBCXHU0RTAwXHU2QjY1Jzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgY29uc3Qgc2VsID0gYXdhaXQgd2FpdEZvcignc2VsZWN0IHBhZ2UgXHUyNDYwIG9uJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1zZWxlY3QnKTtcclxuICAgICAgICAgIHZhciBvbj1wP3AucXVlcnlTZWxlY3RvcignLndpemFyZC1vcHQub24nKTpudWxsO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogISFwICYmICEhb24gJiYgb24udGV4dENvbnRlbnQuaW5kZXhPZignXHU0RTBCXHU4RjdEXHU1Qjg5XHU4OEM1XHU1QjhDXHU2NTc0IGhtaCBDTEknKT49MCwgZGV0YWlsOiBwID8gJ3NlbGVjdCBcdTI0NjAgb24nIDogJ25vIHNlbGVjdCd9O2AsIDhfMDAwKTtcclxuICAgICAgICBpZiAoIXNlbFswXSkgcmV0dXJuIHNlbDtcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTVGMDBcdTU5Q0JcdTVCODlcdTg4QzUnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICByZXR1cm4gd2FpdEZvcignaW5zdGFsbCBwYWdlJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1pbnN0YWxsJyk7XHJcbiAgICAgICAgICByZXR1cm4ge29rOiAhIXAsIGRldGFpbDogcCA/ICdpbnN0YWxsaW5nJyA6ICdub3Qgc2hvd24nfTtgLCA4XzAwMCk7XHJcbiAgICAgIH0pO1xyXG4gICAgICBhd2FpdCBzdGVwKCdcdTU0MTFcdTVCRkMoXHU3NzFGXHU1QjlFKTpcdTVCODlcdTg4QzVcdThGREJcdTVFQTZcdTUzRUZcdTg5QzEoXHU2QjY1XHU5QUE0XHU2NTg3XHU2ODQ4L1x1NEUwQlx1OEY3RFx1NzY3RVx1NTIwNlx1NkJENFx1NkVEQVx1NTJBOCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3Byb2dyZXNzIHZpc2libGUnLCBgdmFyIGJhcj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLXByb2dyZXNzJyk7XHJcbiAgICAgICAgICB2YXIgbG9nPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtaW5zdGFsbC1sb2cnKTtcclxuICAgICAgICAgIHZhciBsaW5lcz1sb2c/bG9nLnRleHRDb250ZW50LnNwbGl0KCdcXFxcbicpLmZpbHRlcihmdW5jdGlvbih4KXtyZXR1cm4geC50cmltKCkhPT0nJzt9KTpbXTtcclxuICAgICAgICAgIHJldHVybiB7b2s6ICEhYmFyICYmIGxpbmVzLmxlbmd0aD49MSwgZGV0YWlsOiAnYmFyPScrKGJhcj8neSc6J24nKSsnIGxpbmVzPScrbGluZXMubGVuZ3RoKyhsaW5lcy5sZW5ndGg+MD8oJyBsYXN0PScrKGxpbmVzW2xpbmVzLmxlbmd0aC0xXXx8JycpLnNsaWNlKDAsNTApKTonJyl9O2AsIDYwXzAwMCk7XHJcbiAgICAgICAgYXdhaXQgc2hvdCgnd2l6YXJkLXJlYWwtaW5zdGFsbCcpO1xyXG4gICAgICAgIHJldHVybiB3O1xyXG4gICAgICB9KTtcclxuICAgICAgYXdhaXQgc3RlcCgnXHU1NDExXHU1QkZDKFx1NzcxRlx1NUI5RSk6XHU1Qjg5XHU4OEM1XHU1QjhDXHU2MjEwXHUyMTkyXHU5MTREXHU3RjZFXHU4REYzXHU4RkM3KFx1NURGMlx1NjcwOVx1NUJDNlx1OTRBNSlcdTIxOTJcdTVCOENcdTYyMTBcdTk4NzVcdTIxOTJcdTVGMDBcdTU5Q0JcdTRGN0ZcdTc1MjhcdTIxOTJcdTY1QjAgcnVudGltZSBcdThGREVcdTYzQTUnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgLy8gXHU1Qjg5XHU4OEM1XHU1MTY4XHU3QTBCKG5wbSBcdTg5RTNcdTY3OTArXHU0RTBCXHU4RjdEK1x1ODQzRFx1NzZEODtcdTk1NUNcdTUwQ0YgbnBtbWlycm9yIFx1OTAxQVx1NUUzOCA8MiBcdTUyMDZcdTk0OUYpLFx1NEUwQVx1OTY1MCA4IFx1NTIwNlx1OTQ5RlxyXG4gICAgICAgIGF3YWl0IHdhaXRGb3IoJ2RvbmUgcGFnZScsIGB2YXIgZD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtZG9uZScpO1xyXG4gICAgICAgICAgaWYoZCkgcmV0dXJuIHtvazp0cnVlLCBkZXRhaWw6J2RvbmUnfTtcclxuICAgICAgICAgIHZhciBjPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1jb25maWcnKTtcclxuICAgICAgICAgIGlmKGMpeyB2YXIgcz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdcdThERjNcdThGQzcnKT49MDt9KTsgaWYocykgcy5jbGljaygpOyB9XHJcbiAgICAgICAgICB2YXIgZXJyPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtZXJyb3InKTtcclxuICAgICAgICAgIGlmKGVycikgcmV0dXJuIHtvazpmYWxzZSwgZGV0YWlsOidpbnN0YWxsIGVycm9yOiAnK2Vyci50ZXh0Q29udGVudC5zbGljZSgwLDgwKX07XHJcbiAgICAgICAgICByZXR1cm4ge29rOmZhbHNlLCBkZXRhaWw6J2luc3RhbGxpbmdcdTIwMjYnfTtgLCA4ICogNjBfMDAwKTtcclxuICAgICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignZG9uZSByZWFkeSB0ZXh0JywgYHZhciBkPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1kb25lJyk7XHJcbiAgICAgICAgICB2YXIgdD1kP2QudGV4dENvbnRlbnQ6Jyc7XHJcbiAgICAgICAgICByZXR1cm4ge29rOiAhIWQgJiYgdC5pbmRleE9mKCdcdTVDMzFcdTdFRUEnKT49MCwgZGV0YWlsOiB0LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw2MCl9O2AsIDEwXzAwMCk7XHJcbiAgICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgICBhd2FpdCBzaG90KCd3aXphcmQtcmVhbC1kb25lJyk7XHJcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1RjAwXHU1OUNCXHU0RjdGXHU3NTI4Jzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgY29uc3QgY29ubmVjdGVkID0gYXdhaXQgd2FpdEZvcignbmV3IHJ1bnRpbWUgY29ubmVjdGVkJywgYHZhciBkb3Q9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmhvc3QtZG90Lm9uJyk7XHJcbiAgICAgICAgICB2YXIgbD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuaG9zdC1sYWJlbCcpO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogISFkb3QgJiYgISFsICYmIGwudGV4dENvbnRlbnQuaW5kZXhPZigncnVudGltZScpPj0wLCBkZXRhaWw6ICdkb3Q9JysoZG90Pydvbic6J29mZicpKycgbGFiZWw9JysobD9sLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw1MCk6J25vbmUnKX07YCwgNjBfMDAwKTtcclxuICAgICAgICBjb25zdCBzdCA9IChhd2FpdCBqcyhgd2luZG93LmhtaC5nZXRTdGF0ZSgpLnRoZW4oZnVuY3Rpb24ocil7cmV0dXJuIEpTT04uc3RyaW5naWZ5KHttb2RlOnIubW9kZSwgcnVudGltZUVudHJ5OnIucnVudGltZUVudHJ5fSk7fSlgKSkgYXMgc3RyaW5nO1xyXG4gICAgICAgIGNvbnN0IHAgPSBKU09OLnBhcnNlKHN0KSBhcyB7IG1vZGU/OiBzdHJpbmc7IHJ1bnRpbWVFbnRyeT86IHN0cmluZyB8IG51bGwgfTtcclxuICAgICAgICBjb25zdCBlbnRyeU9rID0gKHAucnVudGltZUVudHJ5ID8/ICcnKS5pbmRleE9mKCcuaG1oYXJuZXNzLWdsb2JhbCcpID49IDA7XHJcbiAgICAgICAgYXdhaXQgc2hvdCgnd2l6YXJkLXJlYWwtZmluYWwnKTtcclxuICAgICAgICByZXR1cm4gW2Nvbm5lY3RlZFswXSAmJiBlbnRyeU9rLCBgY29ubmVjdGVkOiAke2Nvbm5lY3RlZFsxXX07IHN0YXRlPSR7c3Quc2xpY2UoMCwgOTApfWBdO1xyXG4gICAgICB9KTtcclxuICAgIH1cclxuICAgIGF3YWl0IHNob3QoJ2ZpbmFsJyk7XHJcbiAgfSBlbHNlIHtcclxuICAgIC8qID09PT09PT09PT0gcmVhbDpcdTUzRUFcdThCRkJcdTVCNTBcdTk2QzYoXHU0RTBEXHU1MkE4XHU3NzFGXHU1QjlFXHU0RjFBXHU4QkREKSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTk4NzZcdTY4MEY6cnVudGltZSBcdTcyNDhcdTY3MkNcdTRFMEVcdTdBRUZcdTUzRTNcdTVERjJcdTY2M0VcdTc5M0EoXHU5NzVFID8pJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignaG9zdCBsYWJlbCcsIGB2YXIgbD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuaG9zdC1sYWJlbCcpO1xyXG4gICAgICAgIHZhciB0ID0gbCA/IGwudGV4dENvbnRlbnQgOiAnJztcclxuICAgICAgICByZXR1cm4ge29rOiB0LmluZGV4T2YoJz8nKSA8IDAgJiYgdC5pbmRleE9mKCdydW50aW1lJykgPj0gMCwgZGV0YWlsOiB0LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw2MCl9O2AsIDE1XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ1x1NEYxQVx1OEJERFx1NTIxN1x1ODg2ODpcdTc3MUZcdTVCOUVcdTUzODZcdTUzRjJcdTUyQTBcdThGN0QoXHU2NTcwXHU5MUNGPjApJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignc2Vzc2lvbnMnLCBgdmFyIG49ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aDtcclxuICAgICAgICByZXR1cm4ge29rOiBuID4gMCwgZGV0YWlsOiAnc2Vzc2lvbnM9JytufTtgLCAxNV8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdcdTcwQjlcdTUxRkJcdTUzODZcdTUzRjJcdTRGMUFcdThCREQgXHUyMTkyIFx1NzcxRlx1NUI5RSB0cmFuc2NyaXB0IFx1NTE4NVx1NUJCOVx1NTNFRlx1ODlDMScsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgbiA9IChhd2FpdCBqcyhgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aGApKSBhcyBudW1iZXI7XHJcbiAgICAgIGlmIChuID09PSAwKSByZXR1cm4gW2ZhbHNlLCAnbm8gc2Vzc2lvbnMgdG8gY2xpY2snXTtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgaXQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNlc3Npb24taXRlbScpOyBpZiAoaXQpIGl0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2hpc3RvcnkgdHVybnMnLCBgdmFyIHRzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnR1cm4nKSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogdHMubGVuZ3RoID49IDEsIGRldGFpbDogJ3R1cm5zPScrdHMubGVuZ3RoKycgZmlyc3Q9JysodHNbMF0/dHNbMF0udGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDQwKTonbm9uZScpfTtgLCAxNV8wMDApO1xyXG4gICAgICBhd2FpdCBzaG90KCdyZWFsLWhpc3RvcnknKTtcclxuICAgICAgcmV0dXJuIHc7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ0RvY2s6T3ZlcnZpZXcgXHU3NzFGXHU1QjlFXHU2NTcwXHU2MzZFKHJ1bnRpbWUgXHU3MjQ4XHU2NzJDXHU5NzVFXHU2NUUwXHU2NTcwXHU2MzZFKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J092ZXJ2aWV3Jzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdvdmVydmlldycsIGB2YXIgcm93cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXJvdycpKTtcclxuICAgICAgICB2YXIgdmVyID0gcm93cy5maW5kKGZ1bmN0aW9uKHIpeyByZXR1cm4gci50ZXh0Q29udGVudC5pbmRleE9mKCdydW50aW1lIFx1NzI0OFx1NjcyQycpPj0wOyB9KTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXZlciAmJiB2ZXIudGV4dENvbnRlbnQuaW5kZXhPZignXHU2NUUwXHU2NTcwXHU2MzZFJykgPCAwLCBkZXRhaWw6IHZlciA/IHZlci50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNTApIDogJ25vIHZlciByb3cnfTtgLCAxMF8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdEb2NrOkRpZmYgXHU3NzFGXHU1QjlFIGdpdCBcdTcyQjZcdTYwMDEoXHU5NzVFXHU1MkEwXHU4RjdEXHU0RTJEKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J1x1NTNEOFx1NjZGNCd8fHgudGV4dENvbnRlbnQ9PT0nRGlmZic7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignZGlmZicsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuZGlmZi1wYW5lJyk7XHJcbiAgICAgICAgdmFyIHQgPSBwID8gcC50ZXh0Q29udGVudCA6ICcnO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhcCAmJiB0LmluZGV4T2YoJ1x1NTJBMFx1OEY3RFx1NEUyRCcpIDwgMCwgZGV0YWlsOiB0LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw2MCl9O2AsIDE1XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ0RvY2s6RXZpZGVuY2UgXHU3NzFGXHU1QjlFXHU4QkE0XHU3N0U1XHU2NTcwXHU2MzZFJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nXHU4QkMxXHU2MzZFJ3x8eC50ZXh0Q29udGVudD09PSdFdmlkZW5jZSc7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignZXZpZGVuY2UnLCBgdmFyIHJvd3M9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay1yb3cnKSk7XHJcbiAgICAgICAgdmFyIG1lbSA9IHJvd3MuZmluZChmdW5jdGlvbihyKXsgcmV0dXJuIHIudGV4dENvbnRlbnQuaW5kZXhPZignXHU4QkIwXHU1RkM2XHU1QzQyJyk+PTAgfHwgci50ZXh0Q29udGVudC5pbmRleE9mKCdNZW1vcnkgbGF5ZXJzJyk+PTA7IH0pO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhbWVtICYmIG1lbS50ZXh0Q29udGVudC5pbmRleE9mKCdcdTIwMjYnKSA8IDAsIGRldGFpbDogbWVtID8gbWVtLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw1MCkgOiAnbm8gcm93J307YCwgMTVfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnXHU5NjQ0XHU0RUY2XHU0RTBFXHU3NkVFXHU1RjU1XHU1MTY1XHU1M0UzOlx1RDgzRFx1RENDRSBcdTRFMEFcdTRGMjAgKyBcdTk4NzZcdTY4MEZcdTRFMkQvRU4gKyBcdUQ4M0RcdURDQzEgXHU2RDRGXHU4OUM4XHU2MzA5XHU5NEFFXHU1QjU4XHU1NzI4JywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nXHU2NTg3XHU0RUY2J3x8eC50ZXh0Q29udGVudD09PSdGaWxlcyc7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBhd2FpdCB3YWl0Rm9yKCdmaWxlcyB0YWInLCBgdmFyIHQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmRvY2stdGFiLmFjdGl2ZScpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhdCAmJiAodC50ZXh0Q29udGVudD09PSdcdTY1ODdcdTRFRjYnfHx0LnRleHRDb250ZW50PT09J0ZpbGVzJyksIGRldGFpbDogJ2FjdGl2ZT0nKyh0P3QudGV4dENvbnRlbnQ6J25vbmUnKX07YCwgNV8wMDApO1xyXG4gICAgICAvLyByZWFsIFx1NkEyMVx1NUYwRiB3b3Jrc3BhY2VzIFx1OEJGN1x1NkM0Mlx1OEQ3MCBydW50aW1lKFx1NTFCN1x1NTQyRlx1NTJBOFx1NTQwRVx1NTNFRlx1ODBGRFx1NjM5Mlx1OTYxRiksXHU2NTNFXHU1QkJEXHU1MjMwIDE1c1xyXG4gICAgICBjb25zdCB3cyA9IGF3YWl0IHdhaXRGb3IoJ3dzIHBpY2tlcicsIGB2YXIgdz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtcGlja2VyJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISF3LCBkZXRhaWw6IHcgPyAnbG9hZGVkJyA6ICd3b3Jrc3BhY2VzIG5vdCBsb2FkZWQgeWV0J307YCwgbW9kZSA9PT0gJ3JlYWwnID8gMTVfMDAwIDogNl8wMDApO1xyXG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKGAoZnVuY3Rpb24oKXtcclxuICAgICAgICB2YXIgdXAgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY29tcG9zZXIgYnV0dG9uW2FyaWEtbGFiZWwqPVwiXHU0RTBBXHU0RjIwXCJdLCAuY29tcG9zZXIgYnV0dG9uW2FyaWEtbGFiZWwqPVwiVXBsb2FkXCJdJyk7XHJcbiAgICAgICAgdmFyIGxhbmcgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcubGFuZy1zZWcnKTtcclxuICAgICAgICB2YXIgYnIgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtcGlja2VyIGJ1dHRvbicpO1xyXG4gICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh7dXA6ICEhdXAsIGxhbmc6ICEhbGFuZywgYnJvd3NlOiAhIWJyfSk7XHJcbiAgICAgIH0pKClgKSkgYXMgc3RyaW5nO1xyXG4gICAgICBjb25zdCBwID0gSlNPTi5wYXJzZShyKSBhcyB7IHVwOiBib29sZWFuOyBsYW5nOiBib29sZWFuOyBicm93c2U6IGJvb2xlYW4gfTtcclxuICAgICAgcmV0dXJuIFtwLnVwICYmIHAubGFuZyAmJiBwLmJyb3dzZSwgYFx1RDgzRFx1RENDRT0ke3AudXB9IFx1NEUyRC9FTj0ke3AubGFuZ30gXHVEODNEXHVEQ0MxPSR7cC5icm93c2V9OyAke3dzWzFdfWBdO1xyXG4gICAgfSk7XHJcbiAgICAvKiA9PT09PT09PT09IHJlYWw6XHU3NzFGXHU1QjlFXHU0RUZCXHU1MkExXHU3QUVGXHU1MjMwXHU3QUVGXHU5OTk2XHU5QThDKFx1NTNEMVx1NzdFRFx1NEVGQlx1NTJBMVx1MjE5Mlx1NkEyMVx1NTc4Qlx1NTZERVx1NTkwRCkgPT09PT09PT09PVxyXG4gICAgICAgXHU3NTI4XHU2MjM3IGdsbS01LjMgXHU1REYyXHU5MTREXHU3RjZFO1x1NjNEMFx1NzkzQVx1OEJDRFx1N0VBNlx1Njc1Rlx1NzZGNFx1NjNBNVx1NTZERVx1NTkwRFx1MzAwMlx1ODJFNSBhZ2VudCBcdThCRjdcdTZDNDJcdTVCQTFcdTYyNzksXHU4RjZFXHU4QkUyXHU5MUNDXHJcbiAgICAgICBcdTgxRUFcdTUyQThcdTcwQjlcdTYyNzlcdTUxQzYoXHU2NzAwXHU1OTFBXHU4OUMxXHU1MzYxXHU1MzczXHU3MEI5LFx1NUU0Mlx1N0I0OSlcdTMwMDJcdThEODVcdTY1RjYgMTUwc1x1MzAwMiAqL1xyXG4gICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX1JFQUxfVEFTSyA9PT0gJzEnKSB7XHJcbiAgICAgIGF3YWl0IHN0ZXAoJ1x1NzcxRlx1NUI5RVx1NEVGQlx1NTJBMTpcdTUzRDFcdTkwMDFcdTIxOTJcdTZBMjFcdTU3OEJcdTU2REVcdTU5MEQoXHU3QUVGXHU1MjMwXHU3QUVGXHU5OTk2XHU5QThDKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OiduJywgY3RybEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgICBhd2FpdCBzbGVlcCg0MDApO1xyXG4gICAgICAgIGF3YWl0IHR5cGVJbnRvKCcuY29tcG9zZXIgdGV4dGFyZWEnLCAnXHU4QkY3XHU1M0VBXHU1NkRFXHU1OTBEXHU0RTI0XHU0RTJBXHU1QjU3Olx1NjUzNlx1NTIzMChcdTY3MkNcdTZCMjFcdTlBOENcdTY1MzZcdTRFRkJcdTUyQTEsXHU0RTBEXHU4OTgxXHU0RjdGXHU3NTI4XHU0RUZCXHU0RjU1XHU1REU1XHU1MTc3LFx1NzZGNFx1NjNBNVx1NTZERVx1NTkwRCknKTtcclxuICAgICAgICBhd2FpdCBzbGVlcCgyMDApO1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY29tcG9zZXIgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NTNEMVx1OTAwMSc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgIGNvbnN0IHNlbnQgPSBhd2FpdCB3YWl0Rm9yKCd1c2VyIHR1cm4nLCBgdmFyIHQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnR1cm4udXNlcicpO1xyXG4gICAgICAgICAgdmFyIHMgPSAodCAmJiB0LnRleHRDb250ZW50KSA/IFN0cmluZyh0LnRleHRDb250ZW50KSA6ICcnO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogcy5pbmRleE9mKCdcdTY1MzZcdTUyMzAnKT49MCB8fCBzLmluZGV4T2YoJ1x1OUE4Q1x1NjUzNlx1NEVGQlx1NTJBMScpPj0wLCBkZXRhaWw6IHMuc2xpY2UoMCwzMCkgfHwgJ25vbmUnfTtgLCAxMF8wMDApO1xyXG4gICAgICAgIGlmICghc2VudFswXSkgcmV0dXJuIHNlbnQ7XHJcbiAgICAgICAgY29uc3QgcmVwbHkgPSBhd2FpdCB3YWl0Rm9yKCdhc3Npc3RhbnQgcmVwbHknLCBgXHJcbiAgICAgICAgICB2YXIgYXAgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuYXBwcm92YWwtY2FyZCBidXR0b24nKTtcclxuICAgICAgICAgIGlmIChhcCAmJiBhcC50ZXh0Q29udGVudC50cmltKCkuaW5kZXhPZignXHU2Mjc5XHU1MUM2Jyk+PTApIGFwLmNsaWNrKCk7XHJcbiAgICAgICAgICB2YXIgdHM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudHVybicpKS5maWx0ZXIoZnVuY3Rpb24oeCl7IHJldHVybiB4LmNsYXNzTmFtZS5pbmRleE9mKCd1c2VyJyk8MCAmJiB4LmNsYXNzTmFtZS5pbmRleE9mKCdhcHByb3ZhbCcpPDAgJiYgeC5jbGFzc05hbWUuaW5kZXhPZignc3lzdGVtJyk8MCAmJiB4LnRleHRDb250ZW50LnRyaW0oKS5sZW5ndGg+MCAmJiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1NTZERVx1NTQwOCcpPDA7IH0pO1xyXG4gICAgICAgICAgdmFyIHN1bSA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy50dXJuLXN1bScpO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogdHMubGVuZ3RoPj0xICYmICEhc3VtLCBkZXRhaWw6ICdhc3Npc3RhbnQ9Jyt0cy5sZW5ndGgrJyBzdW09Jysoc3VtP3N1bS50ZXh0Q29udGVudDonbm9uZScpKycgZmlyc3Q9JysodHNbMF0/dHNbMF0udGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDQwKTonbm9uZScpfTtcclxuICAgICAgICBgLCAxNTBfMDAwKTtcclxuICAgICAgICBhd2FpdCBzaG90KCdyZWFsLXRhc2snKTtcclxuICAgICAgICByZXR1cm4gcmVwbHk7XHJcbiAgICAgIH0pO1xyXG4gICAgfVxyXG4gICAgYXdhaXQgc3RlcCgnXHU0RjFBXHU4QkREXHU1MjA2XHU3RUM0Olx1NURFNlx1NjgwRlx1NjMwOVx1NURFNVx1NEY1Q1x1NTMzQVx1NTIwNlx1N0VDNChcdTdFQzRcdTU5MzRcdTUzRUZcdTg5QzEpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignZ3JvdXAgaGVhZCcsIGB2YXIgaD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtZ3JvdXAtaGVhZCcpO1xyXG4gICAgICAgIHZhciBuID0gaCA/IChoLnF1ZXJ5U2VsZWN0b3IoJy53cy1ncm91cC1uYW1lJyl8fHt9KS50ZXh0Q29udGVudCA6ICcnO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhaCAmJiBuLmxlbmd0aCA+IDAsIGRldGFpbDogJ25hbWU9JytufTtgLCAxNV8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdcdTVERTVcdTRGNUNcdTUzM0E6XHU1REU2XHU2ODBGXHU1REU1XHU0RjVDXHU1MzNBXHU2ODBGXHU1M0VGXHU4OUMxKFx1NzcxRlx1NUI5RVx1NURFNVx1NEY1Q1x1NTMzQVx1NTQwRCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCd3b3Jrc3BhY2UgYmFyJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53b3Jrc3BhY2UtYmFyJyk7XHJcbiAgICAgICAgdmFyIG4gPSBiID8gKGIucXVlcnlTZWxlY3RvcignLndzLWJhci1uYW1lJyl8fHt9KS50ZXh0Q29udGVudCA6ICcnO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYiAmJiAhIW4gJiYgbi5sZW5ndGggPiAwICYmIG4uaW5kZXhPZignXHU1MkEwXHU4RjdEJykgPCAwICYmIG4uaW5kZXhPZignTG9hZGluZycpIDwgMCwgZGV0YWlsOiAnbmFtZT0nK259O2AsIDE1XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHNob3QoJ2ZpbmFsJyk7XHJcbiAgfVxyXG5cclxuICBmaW5pc2goKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGF0dGFjaFVpVmVyaWZ5KHdpbjogQnJvd3NlcldpbmRvdyk6IHZvaWQge1xyXG4gIGNvbnN0IG1vZGUgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9NT0RFID09PSAncmVhbCcgPyAncmVhbCcgOiAnZmFrZSc7XHJcbiAgd2luLndlYkNvbnRlbnRzLm9uY2UoJ2RpZC1maW5pc2gtbG9hZCcsICgpID0+IHtcclxuICAgIC8vIFx1N0VEOSBob3N0IFx1NTQyRlx1NTJBOFx1NzU1OVx1NjVGNlx1OTVGNDtcdTZCNjVcdTlBQTRcdTUxODVcdTkwRThcdTU0MDRcdTgxRUFcdThGNkVcdThCRTJcdTdCNDlcdTVGODVcclxuICAgIHNldFRpbWVvdXQoKCkgPT4geyB2b2lkIHJ1blVpVmVyaWZ5KHdpbiwgbW9kZSk7IH0sIDNfMDAwKTtcclxuICB9KTtcclxufVxyXG4iLCAiLyoqXHJcbiAqIFx1ODlDNlx1ODlDOVx1NTZERVx1NUY1Mlx1NjIyQVx1NTZGRVx1OTRBOVx1NUI1MCBcdTIwMTRcdTIwMTQgXHU3ODZFXHU1QjlBXHU2MDI3XHU4OUM2XHU1M0UzXHU2MjJBXHU1NkZFLFx1NEY5QiBzY3JpcHRzL3Zpc3VhbC1yZWdyZXNzaW9uLm1qcyBcdTUwNUFcdTUwQ0ZcdTdEMjAgZGlmZlx1MzAwMlxyXG4gKlxyXG4gKiBcdTRFMEUgdWktdmVyaWZ5IFx1NTQwQ1x1NjVDRihcdTk2RjZcdTdCMkNcdTRFMDlcdTY1QjlcdTRGOURcdThENTYpLFx1NEY0Nlx1NzZFRVx1NjgwN1x1NjYyRlwiXHU1NDBDXHU0RTAwXHU4RjkzXHU1MTY1IFx1MjE5MiBcdTkwMTBcdTVCNTdcdTgyODJcdTUzRUZcdTZCRDRcdTc2ODRcdTU2RkVcIjpcclxuICogIC0gXHU3QTk3XHU1M0UzXHU1RjUyXHU0RTAwIDEyODBcdTAwRDc4MDA7XHU0RTNCXHU5ODk4L1x1OEJFRFx1OEEwMFx1NTZGQVx1NUI5QShsaWdodCArIFx1NUY1M1x1NTI0RCBsb2NhbGUgXHU5RUQ4XHU4QkE0LFx1NTE5OSBsb2NhbFN0b3JhZ2UgXHU1NDBFIHJlbG9hZClcclxuICogIC0gZmFrZSBob3N0KEhNSF9ERVNLVE9QX1ZJU1JFRz0xIFx1NjVGNiBtYWluIFx1NURGMlx1NUYzQVx1NTIzNiBmYWtlKTpcdTdBN0FcdTRGMUFcdThCREQvXHU1NkZBXHU1QjlBXHU1REU1XHU0RjVDXHU1MzNBXHU0RTBFIHByb3ZpZGVyXHJcbiAqICAtIFx1NEUwOVx1ODlDNlx1NTNFMzptYWluKFx1NEYxQVx1OEJERFx1NEUzQlx1NzU0Q1x1OTc2Mlx1N0E3QVx1NjAwMSkvIHNldHRpbmdzKFx1OEJCRVx1N0Y2RVx1NUYzOVx1NUM0MikvIGRvY2soRmlsZXMgXHU2RDRGXHU4OUM4KVxyXG4gKiAgLSBcdTUyQThcdTYwMDFcdTUzM0EgbWFzazpcdTUyQThcdTYwMDFcdTdBRUZcdTUzRTMvXHU2NUY2XHU5NUY0XHU2MjMzL1x1OEJBMVx1NjU3MFx1N0I0OVx1NTE0M1x1N0QyMFx1NjMwOSBib3VuZGluZyBib3ggXHU4QkIwXHU1MTY1IG1ldGEuanNvbixcclxuICogICAgXHU1MENGXHU3RDIwIGRpZmYgXHU2NUY2XHU4REYzXHU4RkM3KFx1NTc1MFx1NjgwN1x1NURGMlx1NjMwOSBjYXB0dXJlUGFnZSBcdTVCOUVcdTk2NDVcdTVDM0FcdTVCRjggXHUwMEQ3IGRldmljZVBpeGVsUmF0aW8gXHU2MzYyXHU3Qjk3KVxyXG4gKiAgLSBITUhfREVTS1RPUF9WSVNSRUdfTVVUQVRFPTx2aWV3cG9ydD46XHU1NzI4XHU4QkU1XHU4OUM2XHU1M0UzXHU2Q0U4XHU1MTY1XHU1NkZBXHU1QjlBXHU4MjcyXHU1NzU3LFx1NzUyOFx1NEU4RVx1N0JBMVx1N0VCRlx1ODFFQVx1NjhDMFxyXG4gKiAgICAoYmFzZWxpbmUgXHU4MUVBXHU2QkQ0IDAgXHU1REVFXHU1RjAyICsgXHU2NTQ1XHU2MTBGXHU2NTM5XHU1MkE4XHU1RkM1IEZBSUwsXHU4QkMxXHU2NjBFXHU5NjA4XHU1MDNDXHU0RTBFIGRpZmYgXHU1NkZFXHU3NzFGXHU1QjlFXHU1REU1XHU0RjVDKVxyXG4gKiBlbnY6SE1IX0RFU0tUT1BfVklTUkVHPTEoXHU1RjAwXHU1MTczKS8gSE1IX0RFU0tUT1BfVklTUkVHX09VVD08ZGlyPihcdThGOTNcdTUxRkFcdTc2RUVcdTVGNTUpXHJcbiAqL1xyXG5pbXBvcnQgeyBhcHAsIHR5cGUgQnJvd3NlcldpbmRvdyB9IGZyb20gJ2VsZWN0cm9uJztcclxuaW1wb3J0IHsgbWtkaXIsIHdyaXRlRmlsZSB9IGZyb20gJ25vZGU6ZnMvcHJvbWlzZXMnO1xyXG5pbXBvcnQgeyBqb2luIH0gZnJvbSAnbm9kZTpwYXRoJztcclxuXHJcbmNvbnN0IHNsZWVwID0gKG1zOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+ID0+IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIG1zKSk7XHJcblxyXG4vKiogXHU1MkE4XHU2MDAxXHU1MzNBXHU1N0RGKFx1NkJDRlx1NkIyMVx1OEZEMFx1ODg0Q1x1NUZDNVx1NTNEOFx1NzY4NFx1NTE4NVx1NUJCOSlcdTIxOTIgbWFzayBcdTkwMDlcdTYyRTlcdTU2Njg7XHU5NzU5XHU2MDAxXHU3RUQzXHU2Nzg0XHU0RTBEIG1hc2ssZGlmZiBcdTYyNERcdTY3MDlcdTYxMEZcdTRFNDkgKi9cclxuY29uc3QgTUFTS19TRUxFQ1RPUlM6IEFycmF5PHsgc2VsOiBzdHJpbmc7IHJlYXNvbjogc3RyaW5nIH0+ID0gW1xyXG4gIHsgc2VsOiAnLmhvc3QtbGFiZWwnLCByZWFzb246ICdob3N0IFx1N0FFRlx1NTNFMy9cdTcyNDhcdTY3MkMoZmFrZSBob3N0IFx1NkJDRlx1NkIyMVx1OTY4Rlx1NjczQVx1N0FFRlx1NTNFMyknIH0sXHJcbiAgeyBzZWw6ICcuc2Vzc2lvbi10aW1lJywgcmVhc29uOiAnXHU0RjFBXHU4QkREXHU2NUY2XHU5NUY0XHU2MjMzJyB9LFxyXG4gIHsgc2VsOiAnLnR1cm4tc3VtJywgcmVhc29uOiAnXHU1NkRFXHU1NDA4L3Rva2VuIFx1OEJBMVx1NjU3MCcgfSxcclxuXTtcclxuXHJcbi8qKiBcdTU2RkFcdTVCOUFcdTg5QzZcdTUzRTM6XHU4OTg2XHU3NkQ2XHU0RTA5XHU2ODBGXHU1RTAzXHU1QzQwXHU0RTBFXHU1RTk1XHU5MEU4IGRvY2sgXHU3Njg0XHU1MjA2XHU2NTJGLFx1NTQwQ1x1NjVGNlx1OEZEQ1x1NzlCQiA4MjAvMTEwMCBcdTY1QURcdTcwQjkgKi9cclxuY29uc3QgVklFV1BPUlRfVyA9IDEyODA7XHJcbmNvbnN0IFZJRVdQT1JUX0ggPSA4MDA7XHJcblxyXG5hc3luYyBmdW5jdGlvbiBydW5WaXN1YWxSZWdyZXNzaW9uKHdpbjogQnJvd3NlcldpbmRvdyk6IFByb21pc2U8dm9pZD4ge1xyXG4gIGNvbnN0IG91dCA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1ZJU1JFR19PVVQgPz8gam9pbihhcHAuZ2V0UGF0aCgndGVtcCcpLCAnaG1oLXZpc3JlZycpO1xyXG4gIGNvbnN0IG11dGF0ZSA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1ZJU1JFR19NVVRBVEUgPz8gJyc7XHJcbiAgYXdhaXQgbWtkaXIob3V0LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KS5jYXRjaCgoKSA9PiB1bmRlZmluZWQpO1xyXG4gIGNvbnN0IGpzID0gPFQ+KGNvZGU6IHN0cmluZyk6IFByb21pc2U8VD4gPT4gd2luLndlYkNvbnRlbnRzLmV4ZWN1dGVKYXZhU2NyaXB0KGNvZGUsIHRydWUpIGFzIFByb21pc2U8VD47XHJcbiAgY29uc3Qgd2FpdEZvciA9IGFzeW5jIChsYWJlbDogc3RyaW5nLCBwcmVkaWNhdGVDb2RlOiBzdHJpbmcsIHRpbWVvdXRNczogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiA9PiB7XHJcbiAgICBjb25zdCBzdGFydGVkID0gRGF0ZS5ub3coKTtcclxuICAgIGZvciAoOzspIHtcclxuICAgICAgY29uc3QgciA9IChhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHRyeSB7IHJldHVybiBKU09OLnN0cmluZ2lmeSgoZnVuY3Rpb24oKXsgJHtwcmVkaWNhdGVDb2RlfSB9KSgpKTsgfSBjYXRjaChlKXsgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHtvazpmYWxzZSwgZGV0YWlsOlN0cmluZyhlKS5zbGljZSgwLDEyMCl9KTsgfSB9KSgpYCkpIGFzIHN0cmluZztcclxuICAgICAgbGV0IHBhcnNlZDogeyBvaz86IGJvb2xlYW4gfTtcclxuICAgICAgdHJ5IHsgcGFyc2VkID0gSlNPTi5wYXJzZShyKSBhcyB7IG9rPzogYm9vbGVhbiB9OyB9IGNhdGNoIHsgcGFyc2VkID0ge307IH1cclxuICAgICAgaWYgKHBhcnNlZC5vayA9PT0gdHJ1ZSkgcmV0dXJuO1xyXG4gICAgICBpZiAoRGF0ZS5ub3coKSAtIHN0YXJ0ZWQgPiB0aW1lb3V0TXMpIHtcclxuICAgICAgICBjb25zb2xlLmxvZyhgVklTUkVHLUNBUFRVUkUgRkFJTCB8IHdhaXQgJHtsYWJlbH0gdGltZW91dGApO1xyXG4gICAgICAgIGFwcC5leGl0KDEpO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgICAgfVxyXG4gICAgICBhd2FpdCBzbGVlcCgyNTApO1xyXG4gICAgfVxyXG4gIH07XHJcblxyXG4gIC8vIDApIFx1N0E5N1x1NTNFM1x1NUY1Mlx1NEUwMDpcdTVDM0FcdTVCRjhcdTU2RkFcdTVCOUEoXHU0RjREXHU3RjZFXHU0RkREXHU2MzAxXHU3NTI4XHU2MjM3XHU2ODRDXHU5NzYyXHU0RTBBXHU3Njg0KTtcdTRFM0JcdTk4OThcdTZENDVcdTgyNzIgKyBcdTRFMkRcdTY1ODcsXHU1MTk5XHU1MDRGXHU1OTdEXHU1NDBFIHJlbG9hZCBcdTc1MUZcdTY1NDhcclxuICB0cnkgeyB3aW4uc2V0Qm91bmRzKHsgd2lkdGg6IFZJRVdQT1JUX1csIGhlaWdodDogVklFV1BPUlRfSCB9KTsgfSBjYXRjaCB7IC8qIFx1NjcwMFx1NUMwRlx1NUMzQVx1NUJGOFx1NTE1Q1x1NUU5NSAqLyB9XHJcbiAgYXdhaXQgc2xlZXAoNDAwKTtcclxuICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHRyeSB7IGxvY2FsU3RvcmFnZS5zZXRJdGVtKCdobWgudGhlbWUnLCAnbGlnaHQnKTsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oJ2htaC5sb2NhbGUnLCAnemgnKTsgfSBjYXRjaCAoZSkge30gcmV0dXJuICdvayc7IH0pKClgKTtcclxuICB3aW4ud2ViQ29udGVudHMucmVsb2FkKCk7XHJcbiAgYXdhaXQgd2FpdEZvcignbW91bnRlZCcsIGB2YXIgdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY29tcG9zZXIgdGV4dGFyZWEnKTsgcmV0dXJuIHtvazogISF0LCBkZXRhaWw6IHQgPyAndXAnIDogJ2Rvd24nfTtgLCAyMF8wMDApO1xyXG4gIGF3YWl0IHdhaXRGb3IoJ2hvc3QgZG90IG9uJywgYHZhciBkPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ob3N0LWRvdCcpOyByZXR1cm4ge29rOiAhIWQgJiYgZC5jbGFzc0xpc3QuY29udGFpbnMoJ29uJyksIGRldGFpbDogZCA/IGQuY2xhc3NOYW1lIDogJ25vbmUnfTtgLCAzMF8wMDApO1xyXG4gIGF3YWl0IHNsZWVwKDFfMjAwKTsgLy8gXHU0RjFBXHU4QkREXHU1MjE3XHU4ODY4L1x1OTg3Nlx1NjgwRlx1NjU3MFx1NjM2RVx1ODQzRFx1NTczMFxyXG5cclxuICAvLyAxKSBcdTUxNzNcdTYzODkgZmFrZSBcdTZGMTRcdTc5M0FcdTVGMTVcdTVCRkNcdTVDNDIoXHU5MDZFXHU3RjY5XHU1RjM5XHU1QzQyXHU0RTBEXHU1QzVFXHU0RThFXHU4OEFCXHU2RDRCXHU4OUM2XHU1M0UzO1x1NEUwRFx1NEY5RFx1OEQ1Nlx1NjU4N1x1Njg0OCxcdTYzMDlcdTdFRDNcdTY3ODRcdTUzRDYgZ2hvc3QgXHU2MzA5XHU5NEFFKVxyXG4gIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGc9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnJ1bnRpbWUtZ3VpZGUnKTsgaWYoIWcpIHJldHVybiAnbm8tZ3VpZGUnO1xyXG4gICAgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnJ1bnRpbWUtZ3VpZGUtYWN0aW9ucyAuYnRuLmdob3N0Jyk7IGlmKGIpIGIuY2xpY2soKTsgcmV0dXJuICdkaXNtaXNzZWQnOyB9KSgpYCk7XHJcbiAgYXdhaXQgd2FpdEZvcignZ3VpZGUgY2xvc2VkJywgYHJldHVybiB7b2s6ICFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcucnVudGltZS1ndWlkZScpLCBkZXRhaWw6ICdjbG9zZWQnfTtgLCA1XzAwMCk7XHJcblxyXG4gIC8vIDIpIFx1ODlDNlx1NTNFM1x1NUU4Rlx1NTIxNzptYWluKFx1N0E3QVx1NjAwMVx1NEUzQlx1NzU0Q1x1OTc2MilcdTIxOTIgc2V0dGluZ3MoXHU4QkJFXHU3RjZFXHU1RjM5XHU1QzQyKVx1MjE5MiBkb2NrKEZpbGVzIFx1NkQ0Rlx1ODlDOClcclxuICBjb25zdCB2aWV3cG9ydHM6IEFycmF5PHsgbmFtZTogc3RyaW5nOyBzZXR1cDogKCkgPT4gUHJvbWlzZTx2b2lkPiB9PiA9IFtcclxuICAgIHsgbmFtZTogJ21haW4nLCBzZXR1cDogYXN5bmMgKCkgPT4geyAvKiBcdTU0MkZcdTUyQThcdTlFRDhcdThCQTRcdTYwMDE6XHU3QTdBXHU0RjFBXHU4QkREICsgT3ZlcnZpZXcgZG9jayAqLyB9IH0sXHJcbiAgICB7XHJcbiAgICAgIG5hbWU6ICdzZXR0aW5ncycsXHJcbiAgICAgIHNldHVwOiBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHsga2V5OiAncCcsIGN0cmxLZXk6IHRydWUsIHNoaWZ0S2V5OiB0cnVlLCBidWJibGVzOiB0cnVlIH0pKTsgfSkoKWApO1xyXG4gICAgICAgIGF3YWl0IHdhaXRGb3IoJ3NldHRpbmdzIG9wZW4nLCBgcmV0dXJuIHtvazogISFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kay5zZXR0aW5ncycpLCBkZXRhaWw6ICdvcGVuJ307YCwgNV8wMDApO1xyXG4gICAgICB9LFxyXG4gICAgfSxcclxuICAgIHtcclxuICAgICAgbmFtZTogJ2RvY2snLFxyXG4gICAgICBzZXR1cDogYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7IGtleTogJ0VzY2FwZScsIGJ1YmJsZXM6IHRydWUgfSkpOyB9KSgpYCk7XHJcbiAgICAgICAgYXdhaXQgd2FpdEZvcignc2V0dGluZ3MgY2xvc2VkJywgYHJldHVybiB7b2s6ICFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kay5zZXR0aW5ncycpLCBkZXRhaWw6ICdjbG9zZWQnfTtgLCA1XzAwMCk7XHJcbiAgICAgICAgLy8gRmlsZXMgdGFiOlx1NjMwOSBkb2NrLXRhYiBcdTk4N0FcdTVFOEZcdTdCMkMgMiBcdTRFMkEoT3ZlcnZpZXcvRmlsZXMvXHUyMDI2KSxcdTkwN0ZcdTUxNERcdTRGOURcdThENTZcdTY1ODdcdTY4NDhcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpWzFdOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICBhd2FpdCB3YWl0Rm9yKCdmaWxlcyByb3dzJywgYHZhciByPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5mcy1yb3cnKTsgcmV0dXJuIHtvazogci5sZW5ndGggPj0gMSwgZGV0YWlsOiAncm93cz0nICsgci5sZW5ndGh9O2AsIDVfMDAwKTtcclxuICAgICAgfSxcclxuICAgIH0sXHJcbiAgXTtcclxuXHJcbiAgY29uc3QgbWV0YTogeyBnZW5lcmF0ZWRBdDogc3RyaW5nOyB3aW5kb3c6IHsgd2lkdGg6IG51bWJlcjsgaGVpZ2h0OiBudW1iZXIgfTsgbXV0YXRlOiBzdHJpbmc7IHZpZXdwb3J0czogQXJyYXk8eyBuYW1lOiBzdHJpbmc7IGZpbGU6IHN0cmluZzsgd2lkdGg6IG51bWJlcjsgaGVpZ2h0OiBudW1iZXI7IGRwcjogbnVtYmVyOyBtYXNrczogQXJyYXk8eyB4OiBudW1iZXI7IHk6IG51bWJlcjsgdzogbnVtYmVyOyBoOiBudW1iZXI7IGZvcjogc3RyaW5nIH0+IH0+IH0gPSB7XHJcbiAgICBnZW5lcmF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxyXG4gICAgd2luZG93OiB7IHdpZHRoOiBWSUVXUE9SVF9XLCBoZWlnaHQ6IFZJRVdQT1JUX0ggfSxcclxuICAgIG11dGF0ZSxcclxuICAgIHZpZXdwb3J0czogW10sXHJcbiAgfTtcclxuICBmb3IgKGNvbnN0IHYgb2Ygdmlld3BvcnRzKSB7XHJcbiAgICBhd2FpdCB2LnNldHVwKCk7XHJcbiAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBhPWRvY3VtZW50LmFjdGl2ZUVsZW1lbnQ7IGlmKGEgJiYgYS5ibHVyKSBhLmJsdXIoKTsgfSkoKWApOyAvLyBcdTUzQkJcdTcxMjZcdTcwQjlcdTczQUZcclxuICAgIGF3YWl0IHNsZWVwKDYwMCk7IC8vIFx1OEZDN1x1NkUyMVx1NEUwRVx1NkUzMlx1NjdEM1x1N0EzM1x1NUI5QVxyXG4gICAgaWYgKG11dGF0ZSA9PT0gdi5uYW1lKSB7XHJcbiAgICAgIC8vIFx1N0JBMVx1N0VCRlx1ODFFQVx1NjhDMDpcdTZDRThcdTUxNjUgMTIwXHUwMEQ3OTAgXHU1NkZBXHU1QjlBXHU3RUEyXHU1NzU3KFx1N0VBNiAxJSBcdTk3NjJcdTc5RUYsPiAwLjUlIFx1OTYwOFx1NTAzQyxcdTVFOTRcdTUyMjQgRkFJTClcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgZD1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTsgZC5zZXRBdHRyaWJ1dGUoJ2RhdGEtdmlzcmVnLW11dGF0ZScsJzEnKTtcclxuICAgICAgICBkLnN0eWxlLmNzc1RleHQ9J3Bvc2l0aW9uOmZpeGVkO2xlZnQ6NTYwcHg7dG9wOjMwMHB4O3dpZHRoOjEyMHB4O2hlaWdodDo5MHB4O2JhY2tncm91bmQ6cmdiKDI1NSwwLDApO3otaW5kZXg6OTk5OTsnO1xyXG4gICAgICAgIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQoZCk7IH0pKClgKTtcclxuICAgICAgYXdhaXQgc2xlZXAoMTUwKTtcclxuICAgIH1cclxuICAgIGNvbnN0IGltZyA9IGF3YWl0IHdpbi53ZWJDb250ZW50cy5jYXB0dXJlUGFnZSgpO1xyXG4gICAgY29uc3Qgc2l6ZSA9IGltZy5nZXRTaXplKCk7XHJcbiAgICAvLyBcdTdCQTFcdTdFQkZcdTgxRUFcdTY4QzBcdTdFQTJcdTU3NTdcdTUzRUFcdTVDNUVcdTRFOEVcdTc2RUVcdTY4MDdcdTg5QzZcdTUzRTM6XHU2MjJBXHU1NkZFXHU1NDBFXHU3QUNCXHU1MzczXHU3OUZCXHU5NjY0LFx1NEUwRFx1NkM2MVx1NjdEM1x1NTQwRVx1N0VFRFx1ODlDNlx1NTNFM1xyXG4gICAgaWYgKG11dGF0ZSA9PT0gdi5uYW1lKSB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignW2RhdGEtdmlzcmVnLW11dGF0ZV0nKTsgaWYoZCkgZC5yZW1vdmUoKTsgfSkoKWApO1xyXG4gICAgfVxyXG4gICAgY29uc3QgaW5uZXJXID0gKGF3YWl0IGpzPG51bWJlcj4oJ3dpbmRvdy5pbm5lcldpZHRoJykpIHx8IHNpemUud2lkdGg7XHJcbiAgICBjb25zdCBkcHIgPSBzaXplLndpZHRoIC8gaW5uZXJXO1xyXG4gICAgY29uc3QgbWFza3M6IEFycmF5PHsgeDogbnVtYmVyOyB5OiBudW1iZXI7IHc6IG51bWJlcjsgaDogbnVtYmVyOyBmb3I6IHN0cmluZyB9PiA9IFtdO1xyXG4gICAgZm9yIChjb25zdCBtIG9mIE1BU0tfU0VMRUNUT1JTKSB7XHJcbiAgICAgIGNvbnN0IHJlY3RzID0gKGF3YWl0IGpzPHN0cmluZz4oYChmdW5jdGlvbigpeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkoW10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcke20uc2VsfScpKS5tYXAoZnVuY3Rpb24oZWwpe1xyXG4gICAgICAgIHZhciByPWVsLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOyByZXR1cm4geyB4OnIueCwgeTpyLnksIHc6ci53aWR0aCwgaDpyLmhlaWdodCB9O1xyXG4gICAgICB9KS5maWx0ZXIoZnVuY3Rpb24ocil7IHJldHVybiByLncgPiAwICYmIHIuaCA+IDAgJiYgci55ID49IDAgJiYgci55IDwgd2luZG93LmlubmVySGVpZ2h0OyB9KSkgfSkoKWApKTtcclxuICAgICAgbGV0IGxpc3Q6IEFycmF5PHsgeDogbnVtYmVyOyB5OiBudW1iZXI7IHc6IG51bWJlcjsgaDogbnVtYmVyIH0+ID0gW107XHJcbiAgICAgIHRyeSB7IGxpc3QgPSBKU09OLnBhcnNlKHJlY3RzKSBhcyB0eXBlb2YgbGlzdDsgfSBjYXRjaCB7IC8qIFx1N0E3QSAqLyB9XHJcbiAgICAgIGZvciAoY29uc3QgciBvZiBsaXN0KSB7XHJcbiAgICAgICAgbWFza3MucHVzaCh7IHg6IE1hdGgucm91bmQoci54ICogZHByKSwgeTogTWF0aC5yb3VuZChyLnkgKiBkcHIpLCB3OiBNYXRoLnJvdW5kKHIudyAqIGRwciksIGg6IE1hdGgucm91bmQoci5oICogZHByKSwgZm9yOiBtLnJlYXNvbiB9KTtcclxuICAgICAgfVxyXG4gICAgfVxyXG4gICAgY29uc3QgZmlsZSA9IGAke3YubmFtZX0ucG5nYDtcclxuICAgIGF3YWl0IHdyaXRlRmlsZShqb2luKG91dCwgZmlsZSksIGltZy50b1BORygpKTtcclxuICAgIG1ldGEudmlld3BvcnRzLnB1c2goeyBuYW1lOiB2Lm5hbWUsIGZpbGUsIHdpZHRoOiBzaXplLndpZHRoLCBoZWlnaHQ6IHNpemUuaGVpZ2h0LCBkcHI6IE1hdGgucm91bmQoZHByICogMTAwKSAvIDEwMCwgbWFza3MgfSk7XHJcbiAgICBjb25zb2xlLmxvZyhgVklTUkVHLUNBUFRVUkUgJHt2Lm5hbWV9ICR7c2l6ZS53aWR0aH14JHtzaXplLmhlaWdodH0gbWFza3M9JHttYXNrcy5sZW5ndGh9JHttdXRhdGUgPT09IHYubmFtZSA/ICcgTVVUQVRFRCcgOiAnJ31gKTtcclxuICB9XHJcbiAgYXdhaXQgd3JpdGVGaWxlKGpvaW4ob3V0LCAnbWV0YS5qc29uJyksIEpTT04uc3RyaW5naWZ5KG1ldGEsIG51bGwsIDIpKTtcclxuICBjb25zb2xlLmxvZygnVklTUkVHLUNBUFRVUkUgRE9ORScpO1xyXG4gIGFwcC5leGl0KDApO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gYXR0YWNoVmlzdWFsUmVncmVzc2lvbih3aW46IEJyb3dzZXJXaW5kb3cpOiB2b2lkIHtcclxuICB3aW4ud2ViQ29udGVudHMub25jZSgnZGlkLWZpbmlzaC1sb2FkJywgKCkgPT4ge1xyXG4gICAgc2V0VGltZW91dCgoKSA9PiB7IHZvaWQgcnVuVmlzdWFsUmVncmVzc2lvbih3aW4pOyB9LCAxXzUwMCk7XHJcbiAgfSk7XHJcbn1cclxuIiwgIi8qKlxyXG4gKiB2NS4xIFx1NUI4OVx1ODhDNVx1NTQxMVx1NUJGQyBcdTAwQjcgQGhtaGFybmVzcy9jbGkgXHU1Qjg5XHU4OEM1XHU3RjE2XHU2MzkyKFx1NEUzQlx1OEZEQlx1N0EwQilcdTMwMDJcclxuICpcclxuICogXHU0RTI0XHU2NzYxXHU4REVGXHU1Rjg0KFx1NjNEMFx1NzkzQVx1OEJDRCB2NS4xIFx1NTQwOFx1NTQwQyk6XHJcbiAqICAtIG5wbSBcdTUzRUZcdTc1MjgoXHU5RUQ4XHU4QkE0KTpgbnBtIGluc3RhbGwgLS1wcmVmaXggJVVTRVJQUk9GSUxFJVxcLmhtaGFybmVzcy1nbG9iYWxcclxuICogICAgQGhtaGFybmVzcy9jbGlgIFx1MjAxNFx1MjAxNCBcdTUzRUFcdTUxOTlcdTc1MjhcdTYyMzdcdTc2RUVcdTVGNTUsXHU0RTBEXHU3OEIwXHU3Q0ZCXHU3RURGL25wbSBcdTUxNjhcdTVDNDA7bnBtIFx1ODFFQVx1NUUyNlx1NEY5RFx1OEQ1Nlx1ODlFM1x1Njc5MCxcclxuICogICAgXHU4RkRCXHU1RUE2XHU4RjZDXHU1M0QxXHU1MTc2XHU4RjkzXHU1MUZBXHU4ODRDKFx1NUI4OVx1ODhDNVx1NkI2NVx1OUFBNFx1NjU4N1x1Njg0OClcdTMwMDJcclxuICogIC0gXHU2NUUwIG5wbShcdTYyMTZcdTY2M0VcdTVGMEZcdTVGM0FcdTUyMzYpOlx1ODFFQVx1NzgxNCB0Z3ogXHU1Qjg5XHU4OEM1XHU1NjY4IFx1MjAxNFx1MjAxNCBcdTRGOURcdThENTZcdTk1RURcdTUzMDVcdTY3NjVcdTgxRUFcclxuICogICAgQGhtaC1kZXNrdG9wL2NsaS1pbnN0YWxsZXIoXHU3RUFGXHU5MDNCXHU4RjkxLFx1NURGMlx1NTM1NVx1NkQ0QiksdGFyYmFsbCBcdTkwMTBcdTUzMDVcdTZENDFcdTVGMEZcdTRFMEJcdThGN0RcclxuICogICAgKFx1NzcxRlx1NUI1N1x1ODI4Mlx1OEZEQlx1NUVBNiArIHJlZ2lzdHJ5Lm5wbWpzLm9yZ1x1MjE5MnJlZ2lzdHJ5Lm5wbW1pcnJvci5jb20gXHU5NTVDXHU1MENGXHU1NkRFXHU5MDAwLFxyXG4gKiAgICBcdTU5MERcdTc1MjggdjQgXHU2NkY0XHU2NUIwXHU1NjY4XHU1NkRFXHU5MDAwXHU2MDFEXHU2MEYzICsgaW50ZWdyaXR5IFx1NjgyMVx1OUE4QyksXHU3Q0ZCXHU3RURGIHRhci5leGUgXHU4OUUzXHU1MzhCXHU1MjMwXHJcbiAqICAgIG5vZGVfbW9kdWxlcyBcdTYyNDFcdTVFNzNcdTVFMDNcdTVDNDBcdTMwMDJcclxuICogXHU4RkRCXHU1RUE2XHU0RTAwXHU1RjhCXHU3RUNGIGluc3RhbGw6cHJvZ3Jlc3MgXHU0RThCXHU0RUY2XHU2M0E4IHJlbmRlcmVyO1x1NjIxMFx1NTI5Rlx1NTZERVx1OEMwMyBvbkluc3RhbGxlZChlbnRyeSlcclxuICogXHU3NTMxIG1haW4gXHU2MzAxXHU0RTQ1XHU1MzE2IHJ1bnRpbWUuanNvbiBcdTVFNzZcdTcwRURcdTkxQ0RcdTU0MkYgaG9zdFx1MzAwMlxyXG4gKi9cclxuaW1wb3J0IHsgc3Bhd24gfSBmcm9tICdub2RlOmNoaWxkX3Byb2Nlc3MnO1xyXG5pbXBvcnQgeyBleGlzdHNTeW5jLCBta2RpclN5bmMsIHJtU3luYywgcmVuYW1lU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gJ25vZGU6ZnMnO1xyXG5pbXBvcnQgeyBob21lZGlyIH0gZnJvbSAnbm9kZTpvcyc7XHJcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdub2RlOnBhdGgnO1xyXG5pbXBvcnQgeyBieXRlc0xhYmVsLCBpbnRlZ3JpdHlPaywgbW9kdWxlRGlyLCByZXNvbHZlQ2xvc3VyZSwgdGFyYmFsbE1pcnJvcnMsIHR5cGUgUGFja3VtZW50LCB0eXBlIFJlc29sdmVkUGtnIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2NsaS1pbnN0YWxsZXInO1xyXG5cclxuZXhwb3J0IGludGVyZmFjZSBJbnN0YWxsUHJvZ3Jlc3Mge1xyXG4gIHBoYXNlOiAnY2hlY2snIHwgJ21ldGEnIHwgJ2Rvd25sb2FkJyB8ICdleHRyYWN0JyB8ICducG0nIHwgJ2RvbmUnIHwgJ2Vycm9yJztcclxuICBwY3Q/OiBudW1iZXI7XHJcbiAgdGV4dDogc3RyaW5nO1xyXG4gIG1pcnJvcj86IHN0cmluZztcclxuICBlbnRyeT86IHN0cmluZztcclxuICBlcnJvcj86IHN0cmluZztcclxufVxyXG5cclxuZXhwb3J0IGludGVyZmFjZSBJbnN0YWxsT3B0aW9ucyB7XHJcbiAgLyoqIFx1NUYzQVx1NTIzNlx1OEQ3MFx1ODFFQVx1NzgxNCB0Z3ogXHU4REVGXHU1Rjg0KFx1NkQ0Qlx1OEJENS9cdTY1RTAgbnBtIFx1NzNBRlx1NTg4MylcdTMwMDIgKi9cclxuICBmb3JjZVRnej86IGJvb2xlYW4gfCB1bmRlZmluZWQ7XHJcbiAgLyoqIFx1OTU1Q1x1NTBDRlx1NEYxOFx1NTE0OFx1N0VBNyhcdTYzNjJcdTZFOTBcdTYzMDlcdTk0QUVcdTdGRkJcdThGNkMpXHUzMDAyICovXHJcbiAgbWlycm9yRmlyc3Q/OiAnbnBtanMnIHwgJ25wbW1pcnJvcicgfCB1bmRlZmluZWQ7XHJcbn1cclxuXHJcbmV4cG9ydCBjb25zdCBSRUdJU1RSSUVTOiBSZWNvcmQ8J25wbWpzJyB8ICducG1taXJyb3InLCBzdHJpbmc+ID0ge1xyXG4gIG5wbWpzOiAnaHR0cHM6Ly9yZWdpc3RyeS5ucG1qcy5vcmcnLFxyXG4gIG5wbW1pcnJvcjogJ2h0dHBzOi8vcmVnaXN0cnkubnBtbWlycm9yLmNvbScsXHJcbn07XHJcblxyXG4vKiogXHU1Qjg5XHU4OEM1XHU2ODM5XHU3NkVFXHU1RjU1KFx1NzUyOFx1NjIzN1x1NzZFRVx1NUY1NSxcdTdFRERcdTRFMERcdTUxOTlcdTdDRkJcdTdFREYvXHU1MTY4XHU1QzQwIG5wbSlcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGluc3RhbGxUYXJnZXQoKTogc3RyaW5nIHtcclxuICByZXR1cm4gam9pbihob21lZGlyKCksICcuaG1oYXJuZXNzLWdsb2JhbCcpO1xyXG59XHJcblxyXG4vKiogXHU1Qjg5XHU4OEM1XHU1QjhDXHU2MjEwXHU1NDBFXHU3Njg0IGRlc2t0b3AtaG9zdCBcdTUxNjVcdTUzRTMobnBtIFx1NUQ0Q1x1NTk1N1x1NEUwRVx1NjNEMFx1NTM0N1x1NEUyNFx1NzlDRFx1NUUwM1x1NUM0MFx1OTBGRFx1OEJBNClcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVJbnN0YWxsZWRFbnRyeSh0YXJnZXQ6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgY29uc3QgbmVzdGVkID0gam9pbih0YXJnZXQsICdub2RlX21vZHVsZXMnLCAnQGhtaGFybmVzcycsICdjbGknLCAnbm9kZV9tb2R1bGVzJywgJ0BobWhhcm5lc3MnLCAnd2ViJywgJ2Rpc3QnLCAnZGVza3RvcC1ob3N0LmpzJyk7XHJcbiAgY29uc3QgaG9pc3RlZCA9IGpvaW4odGFyZ2V0LCAnbm9kZV9tb2R1bGVzJywgJ0BobWhhcm5lc3MnLCAnd2ViJywgJ2Rpc3QnLCAnZGVza3RvcC1ob3N0LmpzJyk7XHJcbiAgaWYgKGV4aXN0c1N5bmMobmVzdGVkKSkgcmV0dXJuIG5lc3RlZDtcclxuICBpZiAoZXhpc3RzU3luYyhob2lzdGVkKSkgcmV0dXJuIGhvaXN0ZWQ7XHJcbiAgcmV0dXJuICcnO1xyXG59XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIEluc3RhbGxlckhvc3Qge1xyXG4gIHNlbmRQcm9ncmVzcyhwOiBJbnN0YWxsUHJvZ3Jlc3MpOiB2b2lkO1xyXG4gIGxvZyhtc2c6IHN0cmluZyk6IHZvaWQ7XHJcbiAgLyoqIFx1NUI4OVx1ODhDNVx1NjIxMFx1NTI5RihcdTUxNjVcdTUzRTNcdTVERjJcdTlBOENcdThCQzFcdTVCNThcdTU3MjgpXHUyMDE0XHUyMDE0IG1haW4gXHU1NzI4XHU2QjY0XHU2MzAxXHU0RTQ1XHU1MzE2XHU1RTc2XHU5MUNEXHU1NDJGIGhvc3RcdTMwMDIgKi9cclxuICBvbkluc3RhbGxlZChlbnRyeTogc3RyaW5nLCB2aWE6ICducG0nIHwgJ3RneicpOiB2b2lkO1xyXG59XHJcblxyXG5sZXQgcnVubmluZyA9IGZhbHNlO1xyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGluc3RhbGxSdW5uaW5nKCk6IGJvb2xlYW4ge1xyXG4gIHJldHVybiBydW5uaW5nO1xyXG59XHJcblxyXG4vKiogXHU1NDJGXHU1MkE4XHU1Qjg5XHU4OEM1KFx1NTQwRVx1NTNGMFx1NjI2N1x1ODg0QztcdThGREJcdTVFQTYvXHU3RUQzXHU2NzlDXHU1MTY4XHU5MEU4XHU3RUNGXHU0RThCXHU0RUY2XHU1NkRFXHU2RDQxLFByb21pc2UgXHU1M0VBXHU4ODY4XHU4RkJFXCJcdTVERjJcdTUzRDdcdTc0MDZcIilcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHN0YXJ0Q2xpSW5zdGFsbChob3N0OiBJbnN0YWxsZXJIb3N0LCBvcHRzOiBJbnN0YWxsT3B0aW9ucyA9IHt9KTogeyBvazogYm9vbGVhbjsgZXJyb3I/OiBzdHJpbmcgfSB7XHJcbiAgaWYgKHJ1bm5pbmcpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3I6ICdcdTVCODlcdTg4QzVcdTVERjJcdTU3MjhcdThGREJcdTg4NENcdTRFMkQnIH07XHJcbiAgcnVubmluZyA9IHRydWU7XHJcbiAgY29uc3QgZmluaXNoID0gKHA6IEluc3RhbGxQcm9ncmVzcyk6IHZvaWQgPT4ge1xyXG4gICAgaG9zdC5zZW5kUHJvZ3Jlc3MocCk7XHJcbiAgICBydW5uaW5nID0gZmFsc2U7XHJcbiAgfTtcclxuICBjb25zdCBmYWlsID0gKHRleHQ6IHN0cmluZywgZXJyOiB1bmtub3duKTogdm9pZCA9PiB7XHJcbiAgICBob3N0LmxvZyhgaW5zdGFsbCBmYWlsZWQ6ICR7dGV4dH0gJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxODApfWApO1xyXG4gICAgZmluaXNoKHsgcGhhc2U6ICdlcnJvcicsIHRleHQsIGVycm9yOiBgJHt0ZXh0fToke1N0cmluZyhlcnIpLnNsaWNlKDAsIDE2MCl9YCB9KTtcclxuICB9O1xyXG4gIHZvaWQgKGFzeW5jICgpID0+IHtcclxuICAgIGNvbnN0IHRhcmdldCA9IGluc3RhbGxUYXJnZXQoKTtcclxuICAgIHRyeSB7XHJcbiAgICAgIG1rZGlyU3luYyh0YXJnZXQsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xyXG4gICAgICBjb25zdCBucG1PayA9IG9wdHMuZm9yY2VUZ3ogPT09IHRydWUgPyBmYWxzZSA6IGF3YWl0IHByb2JlTnBtKGhvc3QpO1xyXG4gICAgICBpZiAobnBtT2spIGF3YWl0IGluc3RhbGxWaWFOcG0oaG9zdCwgdGFyZ2V0LCBvcHRzKTtcclxuICAgICAgZWxzZSBhd2FpdCBpbnN0YWxsVmlhVGFyYmFsbHMoaG9zdCwgdGFyZ2V0LCBvcHRzKTtcclxuICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICBmYWlsKCdcdTVCODlcdTg4QzVcdTU5MzFcdThEMjUnLCBlcnIpO1xyXG4gICAgfVxyXG4gIH0pKCk7XHJcbiAgcmV0dXJuIHsgb2s6IHRydWUgfTtcclxufVxyXG5cclxuLyogLS0tLSBucG0gXHU1M0VGXHU3NTI4XHU2MDI3KFx1NkNFOFx1NjEwRjpXaW5kb3dzIFx1NEUwQiBzcGF3bignbnBtJykgXHU1M0VGXHU4ODRDLCducG0uY21kJyBcdTUzQ0RcdTgwMEMgRUlOVkFMKSAtLS0tICovXHJcbmFzeW5jIGZ1bmN0aW9uIHByb2JlTnBtKGhvc3Q6IEluc3RhbGxlckhvc3QpOiBQcm9taXNlPGJvb2xlYW4+IHtcclxuICBob3N0LnNlbmRQcm9ncmVzcyh7IHBoYXNlOiAnY2hlY2snLCB0ZXh0OiAnXHU2OEMwXHU2N0U1IG5wbVx1MjAyNicgfSk7XHJcbiAgY29uc3Qgb2sgPSBhd2FpdCBuZXcgUHJvbWlzZTxib29sZWFuPigocmVzb2x2ZSkgPT4ge1xyXG4gICAgY29uc3QgYyA9IHNwYXduKCducG0nLCBbJy0tdmVyc2lvbiddLCB7IHdpbmRvd3NIaWRlOiB0cnVlLCBzdGRpbzogJ2lnbm9yZScgfSk7XHJcbiAgICBjb25zdCB0ID0gc2V0VGltZW91dCgoKSA9PiB7IHRyeSB7IGMua2lsbCgpOyB9IGNhdGNoIHsgLyogbm9vcCAqLyB9IHJlc29sdmUoZmFsc2UpOyB9LCAxNV8wMDApO1xyXG4gICAgYy5vbignZXJyb3InLCAoKSA9PiB7IGNsZWFyVGltZW91dCh0KTsgcmVzb2x2ZShmYWxzZSk7IH0pO1xyXG4gICAgYy5vbignZXhpdCcsIChjb2RlKSA9PiB7IGNsZWFyVGltZW91dCh0KTsgcmVzb2x2ZShjb2RlID09PSAwKTsgfSk7XHJcbiAgfSk7XHJcbiAgaG9zdC5sb2coYG5wbSAke29rID8gJ2F2YWlsYWJsZScgOiAndW5hdmFpbGFibGUnfSBcdTIxOTIgJHtvayA/ICducG0gcHJlZml4JyA6ICd0Z3onfSBwYXRoYCk7XHJcbiAgcmV0dXJuIG9rO1xyXG59XHJcblxyXG4vKiAtLS0tIFx1OERFRlx1NUY4NCBBOm5wbSAtLXByZWZpeChcdTVCODlcdTg4QzVcdTZCNjVcdTlBQTRcdTY1ODdcdTY4NDggPSBucG0gXHU4RjkzXHU1MUZBXHU4ODRDKSAtLS0tICovXHJcbmFzeW5jIGZ1bmN0aW9uIGluc3RhbGxWaWFOcG0oaG9zdDogSW5zdGFsbGVySG9zdCwgdGFyZ2V0OiBzdHJpbmcsIG9wdHM6IEluc3RhbGxPcHRpb25zKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgaG9zdC5zZW5kUHJvZ3Jlc3MoeyBwaGFzZTogJ25wbScsIHRleHQ6IGBucG0gaW5zdGFsbCBAaG1oYXJuZXNzL2NsaSBcdTIxOTIgJHt0YXJnZXR9KFx1NEVDNVx1NzUyOFx1NjIzN1x1NzZFRVx1NUY1NSlgIH0pO1xyXG4gIGNvbnN0IHJlZ2lzdHJ5ID0gb3B0cy5taXJyb3JGaXJzdCA9PT0gJ25wbW1pcnJvcicgPyBbJy0tcmVnaXN0cnknLCBSRUdJU1RSSUVTLm5wbW1pcnJvcl0gOiBvcHRzLm1pcnJvckZpcnN0ID09PSAnbnBtanMnID8gWyctLXJlZ2lzdHJ5JywgUkVHSVNUUklFUy5ucG1qc10gOiBbXTtcclxuICBjb25zdCBhcmdzID0gWydpbnN0YWxsJywgJy0tcHJlZml4JywgdGFyZ2V0LCAnLS1uby1hdWRpdCcsICctLW5vLWZ1bmQnLCAnLS1sb2dsZXZlbCcsICdub3RpY2UnLCAuLi5yZWdpc3RyeSwgJ0BobWhhcm5lc3MvY2xpQGxhdGVzdCddO1xyXG4gIGNvbnN0IGNvZGUgPSBhd2FpdCBuZXcgUHJvbWlzZTxudW1iZXI+KChyZXNvbHZlLCByZWplY3QpID0+IHtcclxuICAgIGNvbnN0IGMgPSBzcGF3bignbnBtJywgYXJncywgeyB3aW5kb3dzSGlkZTogdHJ1ZSwgY3dkOiBob21lZGlyKCkgfSk7XHJcbiAgICBsZXQgbGFzdCA9ICcnO1xyXG4gICAgY29uc3Qgb25MaW5lID0gKGQ6IEJ1ZmZlcik6IHZvaWQgPT4ge1xyXG4gICAgICBmb3IgKGNvbnN0IHJhdyBvZiBkLnRvU3RyaW5nKCkuc3BsaXQoL1xccj9cXG4vKSkge1xyXG4gICAgICAgIGNvbnN0IGxpbmUgPSByYXcucmVwbGFjZSgvW1xcdTAwMDAtXFx1MDAxZl0vZywgJycpLnRyaW0oKS5zbGljZSgwLCAxODApO1xyXG4gICAgICAgIGlmIChsaW5lID09PSAnJyB8fCBsaW5lID09PSBsYXN0KSBjb250aW51ZTtcclxuICAgICAgICBsYXN0ID0gbGluZTtcclxuICAgICAgICBob3N0LnNlbmRQcm9ncmVzcyh7IHBoYXNlOiAnbnBtJywgdGV4dDogbGluZSB9KTtcclxuICAgICAgfVxyXG4gICAgfTtcclxuICAgIGMuc3Rkb3V0Py5vbignZGF0YScsIG9uTGluZSk7XHJcbiAgICBjLnN0ZGVycj8ub24oJ2RhdGEnLCBvbkxpbmUpO1xyXG4gICAgYy5vbignZXJyb3InLCByZWplY3QpO1xyXG4gICAgY29uc3Qga2lsbGVyID0gc2V0VGltZW91dCgoKSA9PiB7IHRyeSB7IGMua2lsbCgpOyB9IGNhdGNoIHsgLyogbm9vcCAqLyB9IHJlamVjdChuZXcgRXJyb3IoJ25wbSBcdTVCODlcdTg4QzVcdThEODVcdTY1RjYoOCBcdTUyMDZcdTk0OUYpJykpOyB9LCA4ICogNjBfMDAwKTtcclxuICAgIGMub24oJ2V4aXQnLCAoeCkgPT4geyBjbGVhclRpbWVvdXQoa2lsbGVyKTsgcmVzb2x2ZSh4ID8/IDEpOyB9KTtcclxuICB9KTtcclxuICBpZiAoY29kZSAhPT0gMCkgdGhyb3cgbmV3IEVycm9yKGBucG0gaW5zdGFsbCBcdTkwMDBcdTUxRkFcdTc4MDEgJHtjb2RlfWApO1xyXG4gIGNvbnN0IGVudHJ5ID0gcmVzb2x2ZUluc3RhbGxlZEVudHJ5KHRhcmdldCk7XHJcbiAgaWYgKGVudHJ5ID09PSAnJykgdGhyb3cgbmV3IEVycm9yKCducG0gXHU1Qjg5XHU4OEM1XHU1QjhDXHU2MjEwXHU0RjQ2XHU2NzJBXHU2MjdFXHU1MjMwIGRlc2t0b3AtaG9zdCBcdTUxNjVcdTUzRTMnKTtcclxuICB3cml0ZVN0YW1wKHRhcmdldCwgJ25wbScpO1xyXG4gIGZpbmlzaEluc3RhbGwoaG9zdCwgZW50cnksICducG0nKTtcclxufVxyXG5cclxuLyogLS0tLSBcdThERUZcdTVGODQgQjpcdTgxRUFcdTc4MTQgdGd6KFx1NzcxRlx1NEUwQlx1OEY3RFx1OEZEQlx1NUVBNiArIFx1OTU1Q1x1NTBDRlx1NTZERVx1OTAwMCArIGludGVncml0eSArIHRhciBcdTg5RTNcdTUzOEIpIC0tLS0gKi9cclxuYXN5bmMgZnVuY3Rpb24gaW5zdGFsbFZpYVRhcmJhbGxzKGhvc3Q6IEluc3RhbGxlckhvc3QsIHRhcmdldDogc3RyaW5nLCBvcHRzOiBJbnN0YWxsT3B0aW9ucyk6IFByb21pc2U8dm9pZD4ge1xyXG4gIGNvbnN0IG9yZGVyOiBBcnJheTwnbnBtanMnIHwgJ25wbW1pcnJvcic+ID0gb3B0cy5taXJyb3JGaXJzdCA9PT0gJ25wbW1pcnJvcicgPyBbJ25wbW1pcnJvcicsICducG1qcyddIDogWyducG1qcycsICducG1taXJyb3InXTtcclxuICBjb25zdCBtaXJyb3JzID0gb3JkZXIubWFwKChrKSA9PiBSRUdJU1RSSUVTW2tdKTtcclxuICBob3N0LnNlbmRQcm9ncmVzcyh7IHBoYXNlOiAnbWV0YScsIHRleHQ6ICdcdTg5RTNcdTY3OTBcdTRGOURcdThENTZcdTZFMDVcdTUzNTUoQGhtaGFybmVzcy9jbGkgXHU1MTY4XHU1QkI2KVx1MjAyNicgfSk7XHJcblxyXG4gIGNvbnN0IHBhY2t1bWVudHMgPSBuZXcgTWFwPHN0cmluZywgUGFja3VtZW50PigpO1xyXG4gIGNvbnN0IGdldFBhY2t1bWVudCA9IGFzeW5jIChuYW1lOiBzdHJpbmcpOiBQcm9taXNlPFBhY2t1bWVudD4gPT4ge1xyXG4gICAgY29uc3QgaGl0ID0gcGFja3VtZW50cy5nZXQobmFtZSk7XHJcbiAgICBpZiAoaGl0ICE9PSB1bmRlZmluZWQpIHJldHVybiBoaXQ7XHJcbiAgICBsZXQgbGFzdEVyciA9ICcnO1xyXG4gICAgZm9yIChjb25zdCBtIG9mIG1pcnJvcnMpIHtcclxuICAgICAgdHJ5IHtcclxuICAgICAgICBjb25zdCByID0gYXdhaXQgZmV0Y2goYCR7bX0vJHtlbmNvZGVVUklDb21wb25lbnQobmFtZSl9YCwge1xyXG4gICAgICAgICAgaGVhZGVyczogeyBhY2NlcHQ6ICdhcHBsaWNhdGlvbi92bmQubnBtLmluc3RhbGwtdjEranNvbicgfSxcclxuICAgICAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCgyNV8wMDApLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIGlmICghci5vaykgeyBsYXN0RXJyID0gYEhUVFAgJHtyLnN0YXR1c31gOyBjb250aW51ZTsgfVxyXG4gICAgICAgIGNvbnN0IGRvYyA9IChhd2FpdCByLmpzb24oKSkgYXMgUGFja3VtZW50O1xyXG4gICAgICAgIGlmIChkb2MudmVyc2lvbnMgPT09IHVuZGVmaW5lZCkgeyBsYXN0RXJyID0gJ21hbGZvcm1lZCBwYWNrdW1lbnQnOyBjb250aW51ZTsgfVxyXG4gICAgICAgIHBhY2t1bWVudHMuc2V0KG5hbWUsIGRvYyk7XHJcbiAgICAgICAgcmV0dXJuIGRvYztcclxuICAgICAgfSBjYXRjaCAoZXJyKSB7IGxhc3RFcnIgPSBTdHJpbmcoZXJyKS5zbGljZSgwLCA2MCk7IH1cclxuICAgIH1cclxuICAgIHRocm93IG5ldyBFcnJvcihgXHU4M0I3XHU1M0Q2ICR7bmFtZX0gXHU1MTQzXHU2NTcwXHU2MzZFXHU1OTMxXHU4RDI1KFx1NTE2OFx1OTBFOFx1OTU1Q1x1NTBDRjoke2xhc3RFcnJ9KWApO1xyXG4gIH07XHJcblxyXG4gIGNvbnN0IGNsb3N1cmUgPSBhd2FpdCByZXNvbHZlQ2xvc3VyZSh7IG5hbWU6ICdAaG1oYXJuZXNzL2NsaScsIHNwZWM6ICdsYXRlc3QnIH0sIGdldFBhY2t1bWVudCk7XHJcbiAgY29uc3Qgcm9vdCA9IGNsb3N1cmUuZmluZCgocCkgPT4gcC5uYW1lID09PSAnQGhtaGFybmVzcy9jbGknKTtcclxuICBob3N0LmxvZyhgY2xvc3VyZTogJHtjbG9zdXJlLmxlbmd0aH0gcGFja2FnZXMgKHJvb3QgQGhtaGFybmVzcy9jbGlAJHtyb290Py52ZXJzaW9uID8/ICc/J30pYCk7XHJcbiAgaG9zdC5zZW5kUHJvZ3Jlc3MoeyBwaGFzZTogJ21ldGEnLCB0ZXh0OiBgXHU0RjlEXHU4RDU2XHU2RTA1XHU1MzU1XHU1QzMxXHU3RUVBOiR7Y2xvc3VyZS5sZW5ndGh9IFx1NEUyQVx1NTMwNShAaG1oYXJuZXNzL2NsaUAke3Jvb3Q/LnZlcnNpb24gPz8gJz8nfSlgIH0pO1xyXG5cclxuICBjb25zdCBzdGFnaW5nID0gam9pbih0YXJnZXQsICcuc3RhZ2luZycpO1xyXG4gIHJtU3luYyhzdGFnaW5nLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XHJcbiAgbWtkaXJTeW5jKHN0YWdpbmcsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xyXG5cclxuICBmb3IgKGxldCBpID0gMDsgaSA8IGNsb3N1cmUubGVuZ3RoOyBpKyspIHtcclxuICAgIGNvbnN0IHBrZyA9IGNsb3N1cmVbaV0hO1xyXG4gICAgY29uc3QgdXJscyA9IHRhcmJhbGxNaXJyb3JzKHBrZy50YXJiYWxsLCBtaXJyb3JzKTtcclxuICAgIGxldCBidWY6IEJ1ZmZlciB8IG51bGwgPSBudWxsO1xyXG4gICAgbGV0IHVzZWRNaXJyb3IgPSAnJztcclxuICAgIGxldCBsYXN0RXJyID0gJyc7XHJcbiAgICBmb3IgKGNvbnN0IHUgb2YgdXJscykge1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHIgPSBhd2FpdCBmZXRjaCh1LCB7IHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCgzMDBfMDAwKSB9KTtcclxuICAgICAgICBpZiAoIXIub2spIHsgbGFzdEVyciA9IGBIVFRQICR7ci5zdGF0dXN9YDsgY29udGludWU7IH1cclxuICAgICAgICBjb25zdCB0b3RhbCA9IE51bWJlcihyLmhlYWRlcnMuZ2V0KCdjb250ZW50LWxlbmd0aCcpID8/ICcwJyk7XHJcbiAgICAgICAgY29uc3QgcmVhZGVyID0gci5ib2R5Py5nZXRSZWFkZXIoKTtcclxuICAgICAgICBpZiAocmVhZGVyID09PSB1bmRlZmluZWQpIHRocm93IG5ldyBFcnJvcignbm8gYm9keScpO1xyXG4gICAgICAgIGNvbnN0IGNodW5rczogQnVmZmVyW10gPSBbXTtcclxuICAgICAgICBsZXQgZ290ID0gMDtcclxuICAgICAgICBsZXQgbGFzdEVtaXQgPSAwO1xyXG4gICAgICAgIGZvciAoOzspIHtcclxuICAgICAgICAgIGNvbnN0IHsgZG9uZSwgdmFsdWUgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XHJcbiAgICAgICAgICBpZiAoZG9uZSA9PT0gdHJ1ZSkgYnJlYWs7XHJcbiAgICAgICAgICBjb25zdCBiID0gQnVmZmVyLmZyb20odmFsdWUpO1xyXG4gICAgICAgICAgY2h1bmtzLnB1c2goYik7XHJcbiAgICAgICAgICBnb3QgKz0gYi5sZW5ndGg7XHJcbiAgICAgICAgICBpZiAoZ290IC0gbGFzdEVtaXQgPiAyNTYgKiAxMDI0KSB7XHJcbiAgICAgICAgICAgIGxhc3RFbWl0ID0gZ290O1xyXG4gICAgICAgICAgICBob3N0LnNlbmRQcm9ncmVzcyh7XHJcbiAgICAgICAgICAgICAgcGhhc2U6ICdkb3dubG9hZCcsXHJcbiAgICAgICAgICAgICAgcGN0OiBNYXRoLnJvdW5kKCgoaSArIE1hdGgubWluKGdvdCAvICh0b3RhbCB8fCBnb3QpLCAxKSkgLyBjbG9zdXJlLmxlbmd0aCkgKiAxMDApLFxyXG4gICAgICAgICAgICAgIHRleHQ6IGBcdTRFMEJcdThGN0QgJHtwa2cubmFtZX1AJHtwa2cudmVyc2lvbn0oJHtpICsgMX0vJHtjbG9zdXJlLmxlbmd0aH0pXHUwMEI3ICR7Ynl0ZXNMYWJlbChnb3QpfSR7dG90YWwgPiAwID8gYCAvICR7Ynl0ZXNMYWJlbCh0b3RhbCl9YCA6ICcnfWAsXHJcbiAgICAgICAgICAgICAgbWlycm9yOiBuZXcgVVJMKHUpLmhvc3QsXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgICAgICBidWYgPSBCdWZmZXIuY29uY2F0KGNodW5rcyk7XHJcbiAgICAgICAgaWYgKCFpbnRlZ3JpdHlPayhidWYsIHBrZy5pbnRlZ3JpdHkpKSB7IGxhc3RFcnIgPSAnaW50ZWdyaXR5IFx1NEUwRFx1NTMzOVx1OTE0RCc7IGJ1ZiA9IG51bGw7IGNvbnRpbnVlOyB9XHJcbiAgICAgICAgdXNlZE1pcnJvciA9IG5ldyBVUkwodSkuaG9zdDtcclxuICAgICAgICBicmVhaztcclxuICAgICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgbGFzdEVyciA9IFN0cmluZyhlcnIpLnNsaWNlKDAsIDYwKTtcclxuICAgICAgfVxyXG4gICAgfVxyXG4gICAgaWYgKGJ1ZiA9PT0gbnVsbCkgdGhyb3cgbmV3IEVycm9yKGBcdTRFMEJcdThGN0QgJHtwa2cubmFtZX0gXHU1OTMxXHU4RDI1KFx1NTE2OFx1OTBFOFx1OTU1Q1x1NTBDRjoke2xhc3RFcnJ9KWApO1xyXG4gICAgY29uc3QgdGd6ID0gam9pbihzdGFnaW5nLCBgJHtpfS50Z3pgKTtcclxuICAgIHdyaXRlRmlsZVN5bmModGd6LCBidWYpO1xyXG4gICAgaG9zdC5zZW5kUHJvZ3Jlc3Moe1xyXG4gICAgICBwaGFzZTogJ2Rvd25sb2FkJyxcclxuICAgICAgcGN0OiBNYXRoLnJvdW5kKCgoaSArIDEpIC8gY2xvc3VyZS5sZW5ndGgpICogMTAwKSxcclxuICAgICAgdGV4dDogYFx1NEUwQlx1OEY3RCAke3BrZy5uYW1lfUAke3BrZy52ZXJzaW9ufSBcdTVCOENcdTYyMTAoJHtieXRlc0xhYmVsKGJ1Zi5sZW5ndGgpfSx2aWEgJHt1c2VkTWlycm9yfSlgLFxyXG4gICAgICBtaXJyb3I6IHVzZWRNaXJyb3IsXHJcbiAgICB9KTtcclxuICB9XHJcblxyXG4gIGhvc3Quc2VuZFByb2dyZXNzKHsgcGhhc2U6ICdleHRyYWN0JywgdGV4dDogJ1x1ODlFM1x1NTM4Qlx1NUU3Nlx1NUUwM1x1NUM0MCBub2RlX21vZHVsZXNcdTIwMjYnIH0pO1xyXG4gIGZvciAobGV0IGkgPSAwOyBpIDwgY2xvc3VyZS5sZW5ndGg7IGkrKykge1xyXG4gICAgY29uc3QgcGtnID0gY2xvc3VyZVtpXSE7XHJcbiAgICBhd2FpdCBleHRyYWN0VGd6KGpvaW4oc3RhZ2luZywgYCR7aX0udGd6YCksIHN0YWdpbmcsIHBrZyk7XHJcbiAgICBob3N0LnNlbmRQcm9ncmVzcyh7IHBoYXNlOiAnZXh0cmFjdCcsIHBjdDogTWF0aC5yb3VuZCgoKGkgKyAxKSAvIGNsb3N1cmUubGVuZ3RoKSAqIDEwMCksIHRleHQ6IGBcdTg5RTNcdTUzOEIgJHtwa2cubmFtZX0oJHtpICsgMX0vJHtjbG9zdXJlLmxlbmd0aH0pYCB9KTtcclxuICB9XHJcbiAgcm1TeW5jKHN0YWdpbmcsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcclxuXHJcbiAgY29uc3QgZW50cnkgPSByZXNvbHZlSW5zdGFsbGVkRW50cnkodGFyZ2V0KTtcclxuICBpZiAoZW50cnkgPT09ICcnKSB0aHJvdyBuZXcgRXJyb3IoJ3RneiBcdTVCODlcdTg4QzVcdTVCOENcdTYyMTBcdTRGNDZcdTY3MkFcdTYyN0VcdTUyMzAgZGVza3RvcC1ob3N0IFx1NTE2NVx1NTNFMycpO1xyXG4gIHdyaXRlU3RhbXAodGFyZ2V0LCAndGd6Jyk7XHJcbiAgZmluaXNoSW5zdGFsbChob3N0LCBlbnRyeSwgJ3RneicpO1xyXG59XHJcblxyXG4vKiogdGFyLmV4ZShXaW4xMCsgXHU4MUVBXHU1RTI2KVx1ODlFM1x1NTM4QiB0Z3ogXHU1MjMwIGV4RGlyLFx1NTE4RFx1NjI4QSBwYWNrYWdlLyBcdTYzMkFcdTUyMzAgbm9kZV9tb2R1bGVzIFx1NUUwM1x1NUM0MFx1MzAwMiAqL1xyXG5hc3luYyBmdW5jdGlvbiBleHRyYWN0VGd6KHRnejogc3RyaW5nLCBzdGFnaW5nOiBzdHJpbmcsIHBrZzogUmVzb2x2ZWRQa2cpOiBQcm9taXNlPHZvaWQ+IHtcclxuICBjb25zdCBleERpciA9IGpvaW4oc3RhZ2luZywgYHgtJHtwa2cubmFtZS5yZXBsYWNlKC9bXlxcdy4tXS9nLCAnXycpfWApO1xyXG4gIHJtU3luYyhleERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xyXG4gIG1rZGlyU3luYyhleERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XHJcbiAgY29uc3QgY29kZSA9IGF3YWl0IG5ldyBQcm9taXNlPG51bWJlcj4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xyXG4gICAgY29uc3QgYyA9IHNwYXduKCd0YXInLCBbJy14emYnLCB0Z3osICctQycsIGV4RGlyXSwgeyB3aW5kb3dzSGlkZTogdHJ1ZSwgc3RkaW86ICdpZ25vcmUnIH0pO1xyXG4gICAgYy5vbignZXJyb3InLCByZWplY3QpO1xyXG4gICAgYy5vbignZXhpdCcsICh4KSA9PiByZXNvbHZlKHggPz8gMSkpO1xyXG4gIH0pO1xyXG4gIGlmIChjb2RlICE9PSAwKSB0aHJvdyBuZXcgRXJyb3IoYHRhciBcdTg5RTNcdTUzOEIgJHtwa2cubmFtZX0gXHU1OTMxXHU4RDI1KFx1OTAwMFx1NTFGQVx1NzgwMSAke2NvZGV9KWApO1xyXG4gIGNvbnN0IGRlc3QgPSBtb2R1bGVEaXIoaW5zdGFsbFRhcmdldCgpLCBwa2cubmFtZSk7XHJcbiAgY29uc3QgcGFyZW50ID0gZGVzdC5zbGljZSgwLCBkZXN0Lmxhc3RJbmRleE9mKCdcXFxcJykpO1xyXG4gIG1rZGlyU3luYyhwYXJlbnQsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xyXG4gIHJtU3luYyhkZXN0LCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XHJcbiAgcmVuYW1lU3luYyhqb2luKGV4RGlyLCAncGFja2FnZScpLCBkZXN0KTtcclxuICBybVN5bmMoZXhEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcclxufVxyXG5cclxuLyoqIFx1NUI4OVx1ODhDNVx1NjIzMyhcdTU0MTFcdTVCRkNcdTVCOENcdTYyMTBcdTk4NzUvXHU4QkJFXHU3RjZFXHU5NzYyXHU2NzdGXHU1QzU1XHU3OTNBXHU1Qjg5XHU4OEM1XHU2NUI5XHU1RjBGXHU0RTBFXHU2NUY2XHU5NUY0O1x1NEUwRFx1NjI3Rlx1OEY3RFx1OEZEMFx1ODg0Q1x1NjVGNlx1OTAzQlx1OEY5MSlcdTMwMDIgKi9cclxuZnVuY3Rpb24gd3JpdGVTdGFtcCh0YXJnZXQ6IHN0cmluZywgdmlhOiAnbnBtJyB8ICd0Z3onKTogdm9pZCB7XHJcbiAgdHJ5IHtcclxuICAgIHdyaXRlRmlsZVN5bmMoam9pbih0YXJnZXQsICdpbnN0YWxsZWQtYnktaG1oLWRlc2t0b3AuanNvbicpLCBKU09OLnN0cmluZ2lmeSh7IHZpYSwgYXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSB9LCBudWxsLCAyKSwgJ3V0ZjgnKTtcclxuICB9IGNhdGNoIHsgLyogYmVzdCBlZmZvcnQgKi8gfVxyXG59XHJcblxyXG5mdW5jdGlvbiBmaW5pc2hJbnN0YWxsKGhvc3Q6IEluc3RhbGxlckhvc3QsIGVudHJ5OiBzdHJpbmcsIHZpYTogJ25wbScgfCAndGd6Jyk6IHZvaWQge1xyXG4gIGhvc3QubG9nKGBpbnN0YWxsIGRvbmUgdmlhICR7dmlhfTogJHtlbnRyeX1gKTtcclxuICBob3N0LnNlbmRQcm9ncmVzcyh7IHBoYXNlOiAnZG9uZScsIHRleHQ6IGBcdTVCODlcdTg4QzVcdTVCOENcdTYyMTAoJHt2aWF9KWAsIGVudHJ5IH0pO1xyXG4gIGhvc3Qub25JbnN0YWxsZWQoZW50cnksIHZpYSk7XHJcbiAgcnVubmluZyA9IGZhbHNlO1xyXG59XHJcbiIsICIvKipcclxuICogQGhtaGFybmVzcy9jbGkgXHU1Qjg5XHU4OEM1XHU2ODM4XHU1RkMzKFx1N0VBRlx1OTAzQlx1OEY5MSxcdTk2RjYgSU8gXHUyMDE0XHUyMDE0IGZldGNoL1x1ODlFM1x1NTM4Qi9cdTg0M0RcdTc2RDhcdTU3MjhcdTRFM0JcdThGREJcdTdBMEIgaW5zdGFsbGVyIFx1OTFDQylcdTMwMDJcclxuICpcclxuICogXHU4MDRDXHU4RDIzKHY1LjEgXHU1Qjg5XHU4OEM1XHU1NDExXHU1QkZDKTpcdTdFRDlcdTVCOUEgcmVnaXN0cnkgXHU1MTQzXHU2NTcwXHU2MzZFXHU4M0I3XHU1M0Q2XHU1MUZEXHU2NTcwLFx1ODlFM1x1Njc5MCBAaG1oYXJuZXNzL2NsaSBcdTc2ODRcclxuICogXHU1QjhDXHU2NTc0XHU0RjlEXHU4RDU2XHU5NUVEXHU1MzA1KEBobWhhcm5lc3MvKiBcdTUxNjhcdTVCQjZcdTRFM0FcdTdDQkVcdTc4NkVcdTcyNDhcdTY3MkNcdTRFOTJcdTk0ODk7XHU1OTE2XHU5MEU4XHU0RjlEXHU4RDU2IHFyY29kZSBcdTk0RkVcdTRFM0EgXiBcdTgzMDNcdTU2RjQpLFxyXG4gKiBcdTRFQTdcdTUxRkFcIlx1ODhDNVx1NEVDMFx1NEU0OFx1MzAwMVx1NEVDRVx1NTRFQVx1NEU5Qlx1OTU1Q1x1NTBDRlx1NEUwQlx1MzAwMVx1ODhDNVx1NTIzMFx1NTRFQVwiXHU3Njg0XHU3ODZFXHU1QjlBXHU2MDI3XHU4QkExXHU1MjEyXHUzMDAyXHU4QkJFXHU4QkExXHU3RUE2XHU2NzVGOlxyXG4gKiAgLSBcdTk1RURcdTUzMDVcdTYzMDlcdTUzMDVcdTU0MERcdTUzQkJcdTkxQ0QoXHU5NEJCXHU3N0YzXHU0RjlEXHU4RDU2XHU1M0VBXHU4OEM1XHU0RTAwXHU0RUZELG5wbSBcdThCRURcdTRFNDkpO1xyXG4gKiAgLSBcdTgzMDNcdTU2RjRcdTg5RTNcdTY3OTBcdTUzRUFcdTY1MkZcdTYzMDEgbnBtIFx1NzUxRlx1NjAwMVx1NUI5RVx1OTY0NVx1NzUyOFx1NTIzMFx1NzY4NFx1NUY2Mlx1NjAwMTpcdTdDQkVcdTc4NkUgLyBsYXRlc3QgLyAqIC8gXiAvIH4gLyA+PSxcclxuICogICAgXHU0RTBEXHU1RjE1IHNlbXZlciBcdTVFOTMoXHU5NkY2XHU0RjlEXHU4RDU2XHU1MzlGXHU1MjE5LFx1NEUwRVx1ODFFQVx1NzgxNFx1NjZGNFx1NjVCMFx1NTY2OFx1NEUwMFx1ODFGNCk7XHJcbiAqICAtIG9wdGlvbmFsRGVwZW5kZW5jaWVzIFx1NEUwRFx1ODhDNTpcdTk1RURcdTUzMDVcdTUxODVcdTVCOUVcdTk2NDVcdTU4RjBcdTY2MEVcdTc2ODQgb3B0aW9uYWwgXHU1NzQ3XHU0RTNBXHU1RTczXHU1M0YwXHU3Mjc5XHU1QjlBXHJcbiAqICAgIChmc2V2ZW50cyBcdTdCNDkpLHRneiBcdThERUZcdTVGODRcdTRFMERcdThERDFcdTc1MUZcdTU0N0RcdTU0NjhcdTY3MUZcdTgxMUFcdTY3MkMsXHU4OEM1XHU0RTg2XHU0RTVGXHU1M0VBXHU2NjJGXHU2QjdCXHU5MUNEXHUzMDAyXHJcbiAqL1xyXG5pbXBvcnQgeyBjcmVhdGVIYXNoIH0gZnJvbSAnbm9kZTpjcnlwdG8nO1xyXG5cclxuZXhwb3J0IGludGVyZmFjZSBQa2dWZXJzaW9uTWV0YSB7XHJcbiAgdmVyc2lvbjogc3RyaW5nO1xyXG4gIGRlcGVuZGVuY2llczogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcclxuICB0YXJiYWxsOiBzdHJpbmc7XHJcbiAgaW50ZWdyaXR5Pzogc3RyaW5nIHwgdW5kZWZpbmVkO1xyXG59XHJcblxyXG4vKiogcmVnaXN0cnkgcGFja3VtZW50IFx1NzY4NFx1NjcwMFx1NUMwRlx1OEJGQlx1NTNENlx1OTc2MihkaXN0LXRhZ3MgKyBcdTUxNjhcdTcyNDhcdTY3MkNcdTRGOURcdThENTYvdGFyYmFsbCBcdTUxNDNcdTY1NzBcdTYzNkUpXHUzMDAyICovXHJcbmV4cG9ydCBpbnRlcmZhY2UgUGFja3VtZW50IHtcclxuICAnZGlzdC10YWdzJzogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcclxuICB2ZXJzaW9uczogUmVjb3JkPHN0cmluZywgeyBkZXBlbmRlbmNpZXM/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IHwgdW5kZWZpbmVkOyBkaXN0PzogeyB0YXJiYWxsPzogc3RyaW5nOyBpbnRlZ3JpdHk/OiBzdHJpbmcgfCB1bmRlZmluZWQgfSB8IHVuZGVmaW5lZCB9PjtcclxufVxyXG5cclxuZXhwb3J0IGludGVyZmFjZSBSZXNvbHZlZFBrZyB7XHJcbiAgbmFtZTogc3RyaW5nO1xyXG4gIHZlcnNpb246IHN0cmluZztcclxuICAvKiogcmVnaXN0cnkgXHU1MzlGXHU1OUNCXHU1NzMwXHU1NzQwKFx1OTU1Q1x1NTBDRlx1NTIxN1x1ODg2OFx1NzUzMSB0YXJiYWxsTWlycm9ycyBcdTZEM0VcdTc1MUYpXHUzMDAyICovXHJcbiAgdGFyYmFsbDogc3RyaW5nO1xyXG4gIGludGVncml0eT86IHN0cmluZyB8IHVuZGVmaW5lZDtcclxufVxyXG5cclxuLyogLS0tLSBzZW12ZXIoXHU2NzAwXHU1QzBGXHU1QjlFXHU3M0IwOlx1OTVFRFx1NTMwNVx1NTE4NVx1NUI5RVx1OTY0NVx1NTFGQVx1NzNCMFx1NzY4NFx1NUY2Mlx1NjAwMSkgLS0tLSAqL1xyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGNtcFNlbXZlcihhOiBzdHJpbmcsIGI6IHN0cmluZyk6IG51bWJlciB7XHJcbiAgY29uc3QgcGEgPSBhLnJlcGxhY2UoL152LywgJycpLnNwbGl0KCctJylbMF0hLnNwbGl0KCcuJykubWFwKE51bWJlcik7XHJcbiAgY29uc3QgcGIgPSBiLnJlcGxhY2UoL152LywgJycpLnNwbGl0KCctJylbMF0hLnNwbGl0KCcuJykubWFwKE51bWJlcik7XHJcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCAzOyBpKyspIHtcclxuICAgIGNvbnN0IHggPSBwYVtpXSA/PyAwO1xyXG4gICAgY29uc3QgeSA9IHBiW2ldID8/IDA7XHJcbiAgICBpZiAoeCAhPT0geSkgcmV0dXJuIHggPCB5ID8gLTEgOiAxO1xyXG4gIH1cclxuICByZXR1cm4gMDtcclxufVxyXG5cclxuLyoqIHJhbmdlIFx1NjYyRlx1NTQyNlx1NjNBNVx1NTNENyB2ZXJzaW9uKFx1NjUyRlx1NjMwMSBcdTdDQkVcdTc4NkUgLyBsYXRlc3QgLyAqIC8geCAvIF4gLyB+IC8gPj07XHU0RTBEXHU4QkM2XHU1MjJCXHU1MjE5IGZhbHNlKVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gc2F0aXNmaWVzKHJhbmdlOiBzdHJpbmcsIHZlcnNpb246IHN0cmluZyk6IGJvb2xlYW4ge1xyXG4gIGNvbnN0IHIgPSByYW5nZS50cmltKCk7XHJcbiAgaWYgKHIgPT09ICcnIHx8IHIgPT09ICcqJyB8fCByID09PSAnbGF0ZXN0JyB8fCByID09PSAneCcpIHJldHVybiB0cnVlO1xyXG4gIGlmIChyID09PSB2ZXJzaW9uKSByZXR1cm4gdHJ1ZTtcclxuICBjb25zdCBib3VuZCA9IC9eKFxcXnx+fD49PylcXHMqKFxcZCspXFwuKFxcZCspXFwuKFxcZCspLy5leGVjKHIpO1xyXG4gIGlmIChib3VuZCAhPT0gbnVsbCkge1xyXG4gICAgY29uc3Qgb3AgPSBib3VuZFsxXSE7XHJcbiAgICBjb25zdCBtYWpvciA9IE51bWJlcihib3VuZFsyXSk7XHJcbiAgICBjb25zdCBtaW5vciA9IE51bWJlcihib3VuZFszXSk7XHJcbiAgICBjb25zdCBwYXRjaCA9IE51bWJlcihib3VuZFs0XSk7XHJcbiAgICBjb25zdCBjID0gY21wU2VtdmVyKHZlcnNpb24sIGAke21ham9yfS4ke21pbm9yfS4ke3BhdGNofWApO1xyXG4gICAgaWYgKGMgPCAwKSByZXR1cm4gZmFsc2U7XHJcbiAgICBpZiAob3AgPT09ICc+PScpIHJldHVybiB0cnVlOyAvLyAnPj0nIFx1NEUwQlx1NzU0Q1x1NTM3M1x1NTNFRjpcdTk1RURcdTUzMDVcdTUxODVcdTUzRUFcdTRFRTUgJz49eC55LnogPHonIFx1NTkwRFx1NTQwOFx1NUY2Mlx1NjAwMVx1NTFGQVx1NzNCMCxcdTRGRERcdTVCODhcdTUzRDZcdTRFMEJcdTc1NENcclxuICAgIGlmIChvcCA9PT0gJ34nKSByZXR1cm4gY21wU2VtdmVyKHZlcnNpb24sIGAke21ham9yfS4ke21pbm9yICsgMX0uMGApIDwgMDtcclxuICAgIC8vICdeJzowLnggXHU3Mjc5XHU1MjI0KDAuMi4zIFx1NTE0MVx1OEJCOCAwLjIueiksXHU1MTc2XHU0RjU5XHU5NTAxXHU0RTNCXHU3MjQ4XHU2NzJDXHJcbiAgICBpZiAobWFqb3IgPT09IDApIHJldHVybiBtaW5vciA9PT0gMCA/IGNtcFNlbXZlcih2ZXJzaW9uLCBgMC4wLiR7cGF0Y2ggKyAxfWApIDwgMCA6IGNtcFNlbXZlcih2ZXJzaW9uLCBgMC4ke21pbm9yICsgMX0uMGApIDwgMDtcclxuICAgIHJldHVybiBjbXBTZW12ZXIodmVyc2lvbiwgYCR7bWFqb3IgKyAxfS4wLjBgKSA8IDA7XHJcbiAgfVxyXG4gIHJldHVybiBmYWxzZTtcclxufVxyXG5cclxuLyoqIFx1NEVDRSBwYWNrdW1lbnQgXHU5MDA5XHU1MUZBIHNwZWMoXHU3Q0JFXHU3ODZFL2xhdGVzdC9eL34vKilcdTYzMDdcdTU0MTFcdTc2ODRcdTcyNDhcdTY3MkM7XHU2NUUwXHU1MzM5XHU5MTREXHU4RkQ0XHU1NkRFICcnXHUzMDAyICovXHJcbmV4cG9ydCBmdW5jdGlvbiBwaWNrVmVyc2lvbihkb2M6IFBhY2t1bWVudCwgc3BlYzogc3RyaW5nKTogc3RyaW5nIHtcclxuICBjb25zdCBzID0gc3BlYy50cmltKCk7XHJcbiAgY29uc3QgdGFnID0gcyA9PT0gJycgfHwgcyA9PT0gJ2xhdGVzdCcgfHwgcyA9PT0gJyonID8gZG9jWydkaXN0LXRhZ3MnXT8ubGF0ZXN0IDogdW5kZWZpbmVkO1xyXG4gIGlmICh0YWcgIT09IHVuZGVmaW5lZCAmJiBkb2MudmVyc2lvbnNbdGFnXSAhPT0gdW5kZWZpbmVkKSByZXR1cm4gdGFnO1xyXG4gIGlmIChkb2MudmVyc2lvbnNbc10gIT09IHVuZGVmaW5lZCkgcmV0dXJuIHM7XHJcbiAgbGV0IGJlc3QgPSAnJztcclxuICBmb3IgKGNvbnN0IHYgb2YgT2JqZWN0LmtleXMoZG9jLnZlcnNpb25zKSkge1xyXG4gICAgaWYgKHNhdGlzZmllcyhzLCB2KSAmJiBjbXBTZW12ZXIodiwgYmVzdCkgPiAwKSBiZXN0ID0gdjtcclxuICB9XHJcbiAgcmV0dXJuIGJlc3Q7XHJcbn1cclxuXHJcbi8qIC0tLS0gXHU0RjlEXHU4RDU2XHU5NUVEXHU1MzA1IC0tLS0gKi9cclxuXHJcbi8qKlxyXG4gKiBcdTg5RTNcdTY3OTAgcm9vdCBcdTUzQ0FcdTUxNzZcdTUxNjhcdTkwRThcdTRGMjBcdTkwMTJcdTRGOURcdThENTYoQkZTLFx1NjMwOVx1NTMwNVx1NTQwRFx1NTNCQlx1OTFDRFx1NTNENlx1OTk5Nlx1NEUyQVx1ODlFM1x1Njc5MFx1N0VEM1x1Njc5QyBcdTIwMTRcdTIwMTQgXHU0RTBFIG5wbSBcdTYyNDFcdTVFNzNcclxuICogXHU1RTAzXHU1QzQwXHU0RTAwXHU4MUY0KVx1MzAwMmdldFBhY2t1bWVudCBcdTc1MzFcdThDMDNcdTc1MjhcdTY1QjlcdTZDRThcdTUxNjUoZmV0Y2ggXHU3RjUxXHU3RURDIC8gXHU2RDRCXHU4QkQ1XHU2Q0U4XHU1MTY1XHU1QjU3XHU1MTc4KVx1MzAwMlxyXG4gKiBcdTRFRkJcdTRFMDBcdTRGOURcdThENTZcdTY1RTBcdTZFRTFcdThEQjNcdTcyNDhcdTY3MkNcdTY1RjZcdTYyOUJcdTk1MTkoXHU1RTI2XHU1MzA1XHU1NDBEXHU0RTBFIHJhbmdlLFx1OTc2Mlx1NTQxMVx1NUI4OVx1ODhDNVx1OTg3NVx1OTUxOVx1OEJFRlx1NjU4N1x1Njg0OClcdTMwMDJcclxuICovXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZXNvbHZlQ2xvc3VyZShcclxuICByb290OiB7IG5hbWU6IHN0cmluZzsgc3BlYzogc3RyaW5nIH0sXHJcbiAgZ2V0UGFja3VtZW50OiAobmFtZTogc3RyaW5nKSA9PiBQcm9taXNlPFBhY2t1bWVudD4sXHJcbik6IFByb21pc2U8UmVzb2x2ZWRQa2dbXT4ge1xyXG4gIGNvbnN0IHJlc29sdmVkID0gbmV3IE1hcDxzdHJpbmcsIFBrZ1ZlcnNpb25NZXRhPigpO1xyXG4gIGNvbnN0IHF1ZXVlOiBBcnJheTx7IG5hbWU6IHN0cmluZzsgc3BlYzogc3RyaW5nIH0+ID0gW3Jvb3RdO1xyXG4gIHdoaWxlIChxdWV1ZS5sZW5ndGggPiAwKSB7XHJcbiAgICBjb25zdCB7IG5hbWUsIHNwZWMgfSA9IHF1ZXVlLnNoaWZ0KCkhO1xyXG4gICAgaWYgKHJlc29sdmVkLmhhcyhuYW1lKSkgY29udGludWU7IC8vIFx1NURGMlx1NUI5QVx1NzI0ODpcdTU0MEVcdTdFRUQgcmFuZ2UgXHU1RjE1XHU3NTI4XHU0RTBEXHU1MThEXHU5MUNEXHU4OUUzKG5wbSBcdTYyNDFcdTVFNzNcdThCRURcdTRFNDkpXHJcbiAgICBjb25zdCBkb2MgPSBhd2FpdCBnZXRQYWNrdW1lbnQobmFtZSk7XHJcbiAgICBjb25zdCB2ZXJzaW9uID0gcGlja1ZlcnNpb24oZG9jLCBzcGVjKTtcclxuICAgIGNvbnN0IG1ldGEgPSB2ZXJzaW9uICE9PSAnJyA/IGRvYy52ZXJzaW9uc1t2ZXJzaW9uXSA6IHVuZGVmaW5lZDtcclxuICAgIGlmIChtZXRhID09PSB1bmRlZmluZWQgfHwgbWV0YS5kaXN0Py50YXJiYWxsID09PSB1bmRlZmluZWQpIHtcclxuICAgICAgdGhyb3cgbmV3IEVycm9yKGBubyB2ZXJzaW9uIG9mICR7bmFtZX0gc2F0aXNmaWVzICR7c3BlYyB8fCAnbGF0ZXN0J31gKTtcclxuICAgIH1cclxuICAgIGNvbnN0IGl0ZW06IFBrZ1ZlcnNpb25NZXRhID0ge1xyXG4gICAgICB2ZXJzaW9uLFxyXG4gICAgICBkZXBlbmRlbmNpZXM6IG1ldGEuZGVwZW5kZW5jaWVzID8/IHt9LFxyXG4gICAgICB0YXJiYWxsOiBtZXRhLmRpc3QudGFyYmFsbCxcclxuICAgICAgaW50ZWdyaXR5OiBtZXRhLmRpc3QuaW50ZWdyaXR5LFxyXG4gICAgfTtcclxuICAgIHJlc29sdmVkLnNldChuYW1lLCBpdGVtKTtcclxuICAgIGZvciAoY29uc3QgW2RlcCwgcmFuZ2VdIG9mIE9iamVjdC5lbnRyaWVzKGl0ZW0uZGVwZW5kZW5jaWVzKSkge1xyXG4gICAgICBpZiAoIXJlc29sdmVkLmhhcyhkZXApKSBxdWV1ZS5wdXNoKHsgbmFtZTogZGVwLCBzcGVjOiByYW5nZSB9KTtcclxuICAgIH1cclxuICB9XHJcbiAgcmV0dXJuIFsuLi5yZXNvbHZlZC5lbnRyaWVzKCldLm1hcCgoW25hbWUsIG1dKSA9PiAoeyBuYW1lLCB2ZXJzaW9uOiBtLnZlcnNpb24sIHRhcmJhbGw6IG0udGFyYmFsbCwgaW50ZWdyaXR5OiBtLmludGVncml0eSB9KSk7XHJcbn1cclxuXHJcbi8qIC0tLS0gXHU5NTVDXHU1MENGXHU0RTBFXHU1RTAzXHU1QzQwIC0tLS0gKi9cclxuXHJcbmNvbnN0IFJFR0lTVFJZX0hPU1RTID0gL14oaHR0cHM/OlxcL1xcL1teL10rKVxcLyguKikkLztcclxuXHJcbi8qKlxyXG4gKiB0YXJiYWxsIFx1NzY4NFx1OTU1Q1x1NTBDRlx1NTAxOVx1OTAwOShcdTk4N0FcdTVFOEZcdTUzNzNcdTU2REVcdTkwMDBcdTk4N0FcdTVFOEYpOlx1NTM5Rlx1NTlDQlx1NTczMFx1NTc0MCBcdTIxOTIgXHU1NDA0IHJlZ2lzdHJ5IFx1NTQwQ1x1OERFRlx1NUY4NFx1NjUzOVx1NTE5OVx1MzAwMlxyXG4gKiBwYWNrdW1lbnQgXHU5MUNDXHU3Njg0IGRpc3QudGFyYmFsbCBcdTYwNTJcdTYzMDdcdTU0MTFcdTUzRDFcdTVFMDNcdTZFOTAocmVnaXN0cnkubnBtanMub3JnKSxcdTU2RkRcdTUxODVcdTdGNTFcdTdFRENcclxuICogXHU0RTBEXHU1M0VGXHU4RkJFXHU2NUY2XHU2MzA5IHJlZ2lzdHJ5IFx1NTIxN1x1ODg2OFx1NjUzOVx1NTE5OSBob3N0KFx1OERFRlx1NUY4NFx1NEUwRFx1NTNEOCBcdTIwMTRcdTIwMTQgbnBtbWlycm9yIFx1NEUwRSBucG1qcyBcdTU0MENcdTY3ODQpXHUzMDAyXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gdGFyYmFsbE1pcnJvcnModGFyYmFsbDogc3RyaW5nLCByZWdpc3RyaWVzOiBzdHJpbmdbXSk6IHN0cmluZ1tdIHtcclxuICBjb25zdCBtID0gUkVHSVNUUllfSE9TVFMuZXhlYyh0YXJiYWxsKTtcclxuICBjb25zdCBwYXRoID0gbT8uWzJdID8/ICcnO1xyXG4gIGNvbnN0IG91dCA9IFt0YXJiYWxsXTtcclxuICBmb3IgKGNvbnN0IHJlZyBvZiByZWdpc3RyaWVzKSB7XHJcbiAgICBjb25zdCBiYXNlID0gcmVnLnJlcGxhY2UoL1xcLyskLywgJycpO1xyXG4gICAgaWYgKGJhc2UgPT09IG0/LlsxXSkgY29udGludWU7XHJcbiAgICBjb25zdCB1ID0gYCR7YmFzZX0vJHtwYXRofWA7XHJcbiAgICBpZiAoIW91dC5pbmNsdWRlcyh1KSkgb3V0LnB1c2godSk7XHJcbiAgfVxyXG4gIHJldHVybiBvdXQ7XHJcbn1cclxuXHJcbi8qKiBcdTUzMDVcdTU3Mjggbm9kZV9tb2R1bGVzIFx1NEUwQlx1NzY4NFx1NzZFRVx1NjgwN1x1NzZFRVx1NUY1NShzY29wZWQgXHU1MzA1XHU0RkREXHU2MzAxIEBzY29wZS9uYW1lIFx1NEUyNFx1N0VBNylcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIG1vZHVsZURpcihwcmVmaXg6IHN0cmluZywgbmFtZTogc3RyaW5nKTogc3RyaW5nIHtcclxuICBjb25zdCBwYXJ0cyA9IG5hbWUuc3BsaXQoJy8nKS5maWx0ZXIoKHApID0+IHAgIT09ICcnICYmIHAgIT09ICcuJyk7XHJcbiAgaWYgKG5hbWUuc3RhcnRzV2l0aCgnQCcpICYmIHBhcnRzLmxlbmd0aCAhPT0gMikgdGhyb3cgbmV3IEVycm9yKGBpbnZhbGlkIHBhY2thZ2UgbmFtZTogJHtuYW1lfWApO1xyXG4gIGlmICghbmFtZS5zdGFydHNXaXRoKCdAJykgJiYgcGFydHMubGVuZ3RoICE9PSAxKSB0aHJvdyBuZXcgRXJyb3IoYGludmFsaWQgcGFja2FnZSBuYW1lOiAke25hbWV9YCk7XHJcbiAgcmV0dXJuIFsuLi5wYXJ0c10ucmVkdWNlKChkaXIsIHApID0+IGAke2Rpcn1cXFxcJHtwfWAsIGAke3ByZWZpeH1cXFxcbm9kZV9tb2R1bGVzYCk7XHJcbn1cclxuXHJcbi8qIC0tLS0gaW50ZWdyaXR5IC0tLS0gKi9cclxuXHJcbi8qKiBucG0gZGlzdC5pbnRlZ3JpdHkoJ3NoYTUxMi1iYXNlNjQnKSBcdTY4MjFcdTlBOEM7XHU0RTBEXHU1MzM5XHU5MTREXHU4RkQ0XHU1NkRFIGZhbHNlKFx1NjcyQVx1NzdFNVx1N0I5N1x1NkNENVx1OEZENFx1NTZERSB0cnVlIFx1NjUzRVx1ODg0QylcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGludGVncml0eU9rKGRhdGE6IEJ1ZmZlciwgaW50ZWdyaXR5Pzogc3RyaW5nKTogYm9vbGVhbiB7XHJcbiAgaWYgKGludGVncml0eSA9PT0gdW5kZWZpbmVkIHx8IGludGVncml0eSA9PT0gJycpIHJldHVybiB0cnVlO1xyXG4gIGNvbnN0IG0gPSAvXnNoYTUxMi0oW0EtWmEtejAtOSsvPV0rKSQvLmV4ZWMoaW50ZWdyaXR5LnRyaW0oKSk7XHJcbiAgaWYgKG0gPT09IG51bGwpIHJldHVybiB0cnVlO1xyXG4gIHJldHVybiBjcmVhdGVIYXNoKCdzaGE1MTInKS51cGRhdGUoZGF0YSkuZGlnZXN0KCdiYXNlNjQnKSA9PT0gbVsxXTtcclxufVxyXG5cclxuLyoqIFx1NEVCQVx1N0M3Qlx1NTNFRlx1OEJGQlx1NUI1N1x1ODI4MihcdTVCODlcdTg4QzVcdThGREJcdTVFQTZcdTY1ODdcdTY4NDhcdTc1MjgpXHUzMDAyICovXHJcbmV4cG9ydCBmdW5jdGlvbiBieXRlc0xhYmVsKG46IG51bWJlcik6IHN0cmluZyB7XHJcbiAgaWYgKG4gPCAxMDI0KSByZXR1cm4gYCR7bn0gQmA7XHJcbiAgaWYgKG4gPCAxMDI0ICogMTAyNCkgcmV0dXJuIGAkeyhuIC8gMTAyNCkudG9GaXhlZCgwKX0gS0JgO1xyXG4gIHJldHVybiBgJHsobiAvIDEwMjQgLyAxMDI0KS50b0ZpeGVkKDEpfSBNQmA7XHJcbn1cclxuIiwgIi8qKlxyXG4gKiBcdTY2RjRcdTY1QjBcdTU2NjhcdTkwMUFcdTkwNTNcdTdFQUZcdTkwM0JcdThGOTEoMjAyNi0xMC0yOSBcdTc1MjhcdTYyMzdcdTUzQ0RcdTk5ODhcdTY4MzlcdTZDQkI6XHU1NkZEXHU1MTg1XHU3NTI4XHU2MjM3XHU2NTM2XHU0RTBEXHU1MjMwXHU2NkY0XHU2NUIwXHU2M0E4XHU5MDAxO1xyXG4gKiBcdTU0MENcdTY1RTVcdTRFRkJcdTUyQTEgMTMtQzphdG9tZ2l0IFx1NTZGRFx1NTE4NVx1OTk5Nlx1OTAwOVx1OTAxQVx1OTA1MyArIFx1NTQwRVx1NTNGMFx1OTc1OVx1OUVEOFx1NjZGNFx1NjVCMClcdTMwMDJcclxuICpcclxuICogXHU4MENDXHU2NjZGOlx1NjhDMFx1NjdFNVx1OTAxQVx1OTA1M1x1NTM5Rlx1NjcyQ1x1NTNFQVx1OEQ3MCBhcGkuZ2l0aHViLmNvbSBcdTc2RjRcdThGREUoMTVzIFx1OEQ4NVx1NjVGNiksXHU1NkZEXHU1MTg1XHU2NUUwXHU0RUUzXHU3NDA2XHU3RjUxXHU3RURDXHU1RkM1XHJcbiAqIFx1OEQ4NVx1NjVGNiBcdTIxOTIgY2hlY2sgZmFpbGVkIFx1MjE5MiBcdTc1MjhcdTYyMzdcdTZDMzhcdThGRENcdTc3MEJcdTRFMERcdTUyMzBcdTY1QjBcdTcyNDhcdTY3MkM7XHU0RTBCXHU4RjdEXHU5MDFBXHU5MDUzXHU1M0NEXHU4MDBDXHU2NzA5XHU5NTVDXHU1MENGXHU1NkRFXHU5MDAwXHU5NEZFXHUzMDAyXHJcbiAqIFx1NjcyQ1x1NkEyMVx1NTc1N1x1N0VEOVx1NTFGQVx1N0VBRlx1ODlDNFx1NTIxOShtYWluIFx1OEZEQlx1N0EwQlx1NEUwRSBzY3JpcHRzL3NpbS11cGRhdGVyLm1qcyBcdTUxNzFcdTc1MjgsXHU1MzU1XHU2RDRCXHU4OTg2XHU3NkQ2KTpcclxuICogIDEpIFx1NjhDMFx1NjdFNVx1OTAxQVx1OTA1M1x1OTRGRTpcdTc2RjRcdThGREUoOHMsXHU1NkZEXHU1OTE2XHU3OUQyXHU4RkM3KVx1MjE5MiBhdG9tZ2l0IHY1KFx1NTZGRFx1NTE4NVx1NzZGNFx1OEZERSxcdTUzM0ZcdTU0MERcdTVDMEZcdTU0Q0RcdTVFOTQpXHJcbiAqICAgICBcdTIxOTIgZ2gtcHJveHkgXHUyMTkyIGdoZmFzdCxcdTkwMTBcdTRFMkFcdThCRDVcdTUyMzBcdTYyRkZcdTUyMzAgcmVsZWFzZTtcclxuICogIDIpIFx1OTAxQVx1OTA1M1x1N0M5OFx1NjAyNzpcdTRFMEFcdTZCMjFcdTU0N0RcdTRFMkRcdTc2ODRcdTkwMUFcdTkwNTNcdTRGMThcdTUxNDgsXHU1OTMxXHU4RDI1XHU1MThEXHU1NkRFXHU5MDAwXHU1MTY4XHU5NEZFO1xyXG4gKiAgMykgXHU0RTBCXHU4RjdEXHU1NDBDXHU2RTkwXHU0RjE4XHU1MTQ4Olx1NEUwRVx1NTQ3RFx1NEUyRFx1NzY4NFx1NjhDMFx1NjdFNVx1OTAxQVx1OTA1M1x1NTQwQ1x1NkU5MFx1NzY4NFx1OTU1Q1x1NTBDRlx1NTE0OFx1OEJENSxcdTUxOERcdTc2RjRcdThGREVcdTRFMEVcdTUxNzZcdTRGNTlcdTk1NUNcdTUwQ0Y7XHJcbiAqICAgICBhdG9tZ2l0IFx1NTQ3RFx1NEUyRCBcdTIxOTIgYXRvbWdpdCBcdThENDRcdTRFQTdcdTc2RjRcdTk0RkUgLyBBUEkgXHU3QUVGXHU3MEI5XHU0RjE4XHU1MTQ4LEdpdEh1YiBcdTRFM0JcdTRFRDNcdTk1NUNcdTUwQ0ZcdTUxNUNcdTVFOTVcdTMwMDJcclxuICogXHU2NUUwIGVsZWN0cm9uIFx1NEY5RFx1OEQ1NihcdTUzRUZcdTg4QUIgbm9kZSAtLWltcG9ydCB0c3ggXHU3Njg0XHU2RDRCXHU4QkQ1L1x1NkEyMVx1NjJERlx1ODExQVx1NjcyQ1x1NzZGNFx1NjNBNSBpbXBvcnQpXHUzMDAyXHJcbiAqL1xyXG5cclxuZXhwb3J0IHR5cGUgVXBkYXRlQ2hhbm5lbElkID0gJ2RpcmVjdCcgfCAnYXRvbWdpdCcgfCAnZ2gtcHJveHknIHwgJ2doZmFzdCc7XHJcblxyXG4vKiogXHU1M0NDXHU0RUQzXHU2NjIwXHU1QzA0OkdpdEh1YiBcdTRFM0JcdTRFRDNcdTRFMEUgYXRvbWdpdCBcdTk1NUNcdTUwQ0ZcdTRFRDMgb3duZXIgXHU0RTBEXHU1NDBDKHN3c2dibCB2cyBob25nZnUpLFxyXG4gKiAgXHU5MDFBXHU5MDUzXHU1NDA0XHU4MUVBXHU1M0Q2XHU4MUVBXHU1REYxXHU3Njg0XHU0RUQzKFx1NTNFRlx1ODhBQiBVUERBVEVfUkVQTyAvIFVQREFURV9SRVBPX0FUT01HSVQgXHU4OTg2XHU3NkQ2KVx1MzAwMiAqL1xyXG5leHBvcnQgaW50ZXJmYWNlIFVwZGF0ZVJlcG9zIHsgZ2l0aHViOiBzdHJpbmc7IGF0b21naXQ6IHN0cmluZyB9XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIENoZWNrQ2hhbm5lbCB7XHJcbiAgaWQ6IFVwZGF0ZUNoYW5uZWxJZDtcclxuICAvKiogXHU4QkNBXHU2NUFEL1VJIFx1NjYzRVx1NzkzQVx1NTQwRChcdTk1MTlcdThCRUZcdTRGRTFcdTYwNkZcdTkxQ0NcdTkwMTBcdTkwMUFcdTkwNTNcdTUzRUZcdTg5QzEpXHUzMDAyICovXHJcbiAgbGFiZWw6IHN0cmluZztcclxuICAvKiogXHU1MzU1XHU5MDFBXHU5MDUzXHU4RDg1XHU2NUY2Olx1NzZGNFx1OEZERSA4cyhcdTU2RkRcdTU5MTZcdTc5RDJcdThGQzdcdTMwMDFcdTU2RkRcdTUxODVcdTVGRUJcdTkwMUZcdThCQTlcdTRGNERcdTk1NUNcdTUwQ0YpLGF0b21naXQvXHU5NTVDXHU1MENGIDEwc1x1MzAwMiAqL1xyXG4gIHRpbWVvdXRNczogbnVtYmVyO1xyXG4gIGFwaVVybDogKHJlcG9zOiBVcGRhdGVSZXBvcykgPT4gc3RyaW5nO1xyXG4gIC8qKiBcdTRFMEJcdThGN0RcdTk1NUNcdTUwQ0ZcdTUyNERcdTdGMDAoJycgPSBcdTc2RjRcdThGREUgYXNzZXQgdXJsKTtcdTk4N0JcdTU3MjggRE9XTkxPQURfTUlSUk9SX1BSRUZJWEVTIFx1NkUwNVx1NTM1NVx1NTE4NVx1MzAwMiAqL1xyXG4gIGRvd25sb2FkUHJlZml4OiBzdHJpbmc7XHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgUmVsZWFzZUFzc2V0IHsgbmFtZTogc3RyaW5nOyBicm93c2VyX2Rvd25sb2FkX3VybDogc3RyaW5nOyBzaXplOiBudW1iZXIgfVxyXG5leHBvcnQgaW50ZXJmYWNlIExhdGVzdFJlbGVhc2UgeyB0YWdfbmFtZTogc3RyaW5nOyBib2R5Pzogc3RyaW5nOyBhc3NldHM/OiBSZWxlYXNlQXNzZXRbXSB9XHJcblxyXG5jb25zdCBnaXRodWJMYXRlc3QgPSAocmVwbzogc3RyaW5nKTogc3RyaW5nID0+IGBodHRwczovL2FwaS5naXRodWIuY29tL3JlcG9zLyR7cmVwb30vcmVsZWFzZXMvbGF0ZXN0YDtcclxuXHJcbi8qKiBcdTY4QzBcdTY3RTVcdTkwMUFcdTkwNTNcdTk0RkUoXHU5RUQ4XHU4QkE0XHU5ODdBXHU1RThGOlx1NzZGNFx1OEZERSBcdTIxOTIgYXRvbWdpdChcdTU2RkRcdTUxODVcdTk5OTZcdTkwMDkpXHUyMTkyIGdoLXByb3h5IFx1MjE5MiBnaGZhc3QpXHUzMDAyICovXHJcbmV4cG9ydCBjb25zdCBDSEVDS19DSEFOTkVMUzogcmVhZG9ubHkgQ2hlY2tDaGFubmVsW10gPSBbXHJcbiAgeyBpZDogJ2RpcmVjdCcsIGxhYmVsOiAnXHU3NkY0XHU4RkRFJywgdGltZW91dE1zOiA4XzAwMCwgYXBpVXJsOiAocikgPT4gZ2l0aHViTGF0ZXN0KHIuZ2l0aHViKSwgZG93bmxvYWRQcmVmaXg6ICcnIH0sXHJcbiAgeyBpZDogJ2F0b21naXQnLCBsYWJlbDogJ2F0b21naXQoXHU1NkZEXHU1MTg1KScsIHRpbWVvdXRNczogMTBfMDAwLCBhcGlVcmw6IChyKSA9PiBgaHR0cHM6Ly9hcGkuYXRvbWdpdC5jb20vYXBpL3Y1L3JlcG9zLyR7ci5hdG9tZ2l0fS9yZWxlYXNlcz9wZXJfcGFnZT01JmRpcmVjdGlvbj1kZXNjYCwgZG93bmxvYWRQcmVmaXg6ICcnIH0sXHJcbiAgeyBpZDogJ2doLXByb3h5JywgbGFiZWw6ICdnaC1wcm94eScsIHRpbWVvdXRNczogMTBfMDAwLCBhcGlVcmw6IChyKSA9PiBgaHR0cHM6Ly9naC1wcm94eS5jb20vJHtnaXRodWJMYXRlc3Qoci5naXRodWIpfWAsIGRvd25sb2FkUHJlZml4OiAnaHR0cHM6Ly9naC1wcm94eS5jb20vJyB9LFxyXG4gIHsgaWQ6ICdnaGZhc3QnLCBsYWJlbDogJ2doZmFzdCcsIHRpbWVvdXRNczogMTBfMDAwLCBhcGlVcmw6IChyKSA9PiBgaHR0cHM6Ly9naGZhc3QudG9wLyR7Z2l0aHViTGF0ZXN0KHIuZ2l0aHViKX1gLCBkb3dubG9hZFByZWZpeDogJ2h0dHBzOi8vZ2hmYXN0LnRvcC8nIH0sXHJcbl07XHJcblxyXG4vKiogXHU0RTBCXHU4RjdEXHU5NTVDXHU1MENGXHU1MTY4XHU2RTA1XHU1MzU1KFx1OUVEOFx1OEJBNFx1OTg3QVx1NUU4RjtnaHByb3h5LmNuIFx1NEVDNVx1NEUwQlx1OEY3RFx1NTE1Q1x1NUU5NSxcdTRFMERcdTUwNUFcdTY4QzBcdTY3RTVcdTkwMUFcdTkwNTMpXHUzMDAyICovXHJcbmV4cG9ydCBjb25zdCBET1dOTE9BRF9NSVJST1JfUFJFRklYRVM6IHJlYWRvbmx5IHN0cmluZ1tdID0gWycnLCAnaHR0cHM6Ly9naGZhc3QudG9wLycsICdodHRwczovL2doLXByb3h5LmNvbS8nLCAnaHR0cHM6Ly9naHByb3h5LmNuLyddO1xyXG5cclxuLyoqIFx1NUI1OFx1NTBBOFx1NTAzQy9JUEMgXHU1MDNDXHU1RjUyXHU0RTAwOlx1NTQwOFx1NkNENVx1OTAxQVx1OTA1MyBpZCBcdTYyMTYgbnVsbChcdTdDOThcdTYwMjdcdTY1ODdcdTRFRjZcdTYzNUZcdTU3NEYvXHU2NUU3XHU3MjQ4XHU2NzJDXHU2QjhCXHU3NTU5XHU2NUY2XHU0RTBEXHU4MUY0XHU1NDdEKVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplQ2hhbm5lbCh2OiB1bmtub3duKTogVXBkYXRlQ2hhbm5lbElkIHwgbnVsbCB7XHJcbiAgcmV0dXJuIHR5cGVvZiB2ID09PSAnc3RyaW5nJyAmJiBDSEVDS19DSEFOTkVMUy5zb21lKChjKSA9PiBjLmlkID09PSB2KSA/ICh2IGFzIFVwZGF0ZUNoYW5uZWxJZCkgOiBudWxsO1xyXG59XHJcblxyXG4vKiogXHU3Qzk4XHU2MDI3XHU2MzkyXHU1RThGOlx1NEUwQVx1NkIyMVx1NTQ3RFx1NEUyRFx1OTAxQVx1OTA1M1x1NEYxOFx1NTE0OCxcdTUxNzZcdTRGNTlcdTRGRERcdTYzMDFcdTlFRDhcdThCQTRcdTk0RkVcdTVFOEYoXHU0RUZCXHU0RTAwXHU5MDFBXHU5MDUzXHU1OTMxXHU4RDI1XHU0RUNEXHU1M0VGXHU1MTY4XHU5NEZFXHU1NkRFXHU5MDAwKVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gb3JkZXJlZENoZWNrQ2hhbm5lbHMoc3RpY2t5OiB1bmtub3duKTogcmVhZG9ubHkgQ2hlY2tDaGFubmVsW10ge1xyXG4gIGNvbnN0IHMgPSBub3JtYWxpemVDaGFubmVsKHN0aWNreSk7XHJcbiAgY29uc3QgZmlyc3QgPSBzID09PSBudWxsID8gdW5kZWZpbmVkIDogQ0hFQ0tfQ0hBTk5FTFMuZmluZCgoYykgPT4gYy5pZCA9PT0gcyk7XHJcbiAgaWYgKGZpcnN0ID09PSB1bmRlZmluZWQpIHJldHVybiBDSEVDS19DSEFOTkVMUztcclxuICByZXR1cm4gW2ZpcnN0LCAuLi5DSEVDS19DSEFOTkVMUy5maWx0ZXIoKGMpID0+IGMuaWQgIT09IHMpXTtcclxufVxyXG5cclxuLyoqIFx1NEUwQlx1OEY3RFx1OTU1Q1x1NTBDRlx1OTg3QVx1NUU4RjpcdTU0N0RcdTRFMkRcdTY4QzBcdTY3RTVcdTkwMUFcdTkwNTNcdTc2ODRcdTU0MENcdTZFOTBcdTk1NUNcdTUwQ0ZcdTRGMThcdTUxNDggXHUyMTkyIFx1NzZGNFx1OEZERSBcdTIxOTIgXHU1MTc2XHU0RjU5XHU5NTVDXHU1MENGKFx1NTNCQlx1OTFDRCw0IFx1OTAxQVx1OTA1M1x1NkUwNVx1NTM1NVx1NEZERFx1NzU1OSlcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIG9yZGVyZWREb3dubG9hZE1pcnJvcnMoYXNzZXRVcmw6IHN0cmluZywgY2hhbm5lbDogdW5rbm93bik6IHJlYWRvbmx5IHN0cmluZ1tdIHtcclxuICBjb25zdCBoaXQgPSBub3JtYWxpemVDaGFubmVsKGNoYW5uZWwpO1xyXG4gIGNvbnN0IHByZWZpeCA9IGhpdCA9PT0gbnVsbCA/ICcnIDogQ0hFQ0tfQ0hBTk5FTFMuZmluZCgoYykgPT4gYy5pZCA9PT0gaGl0KT8uZG93bmxvYWRQcmVmaXggPz8gJyc7XHJcbiAgY29uc3QgcHJlZml4ZXMgPSBbLi4ubmV3IFNldChbcHJlZml4LCAuLi5ET1dOTE9BRF9NSVJST1JfUFJFRklYRVNdKV07XHJcbiAgcmV0dXJuIHByZWZpeGVzLm1hcCgocCkgPT4gKHAgPT09ICcnID8gYXNzZXRVcmwgOiBgJHtwfSR7YXNzZXRVcmx9YCkpO1xyXG59XHJcblxyXG4vKiogXHU4QkVEXHU0RTQ5XHU3MjQ4XHU2NzJDXHU2QkQ0XHU4RjgzKCd2JyBcdTUyNERcdTdGMDBcdTUzRUZcdTkwMDksXHU2MzA5IC4gXHU1MjA2XHU2QkI1XHU2NTcwXHU1MDNDXHU2QkQ0O1x1NEUwRFx1OERCM1x1NEUwOVx1NkJCNVx1ODg2NSAwKVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gY21wVmVyc2lvbihhOiBzdHJpbmcsIGI6IHN0cmluZyk6IG51bWJlciB7XHJcbiAgY29uc3QgcGEgPSBhLnJlcGxhY2UoL152LywgJycpLnNwbGl0KCcuJykubWFwKE51bWJlcik7XHJcbiAgY29uc3QgcGIgPSBiLnJlcGxhY2UoL152LywgJycpLnNwbGl0KCcuJykubWFwKE51bWJlcik7XHJcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCAzOyBpKyspIHtcclxuICAgIGlmICgocGFbaV0gPz8gMCkgIT09IChwYltpXSA/PyAwKSkgcmV0dXJuIChwYVtpXSA/PyAwKSA8IChwYltpXSA/PyAwKSA/IC0xIDogMTtcclxuICB9XHJcbiAgcmV0dXJuIDA7XHJcbn1cclxuXHJcbi8qKiBcdTU0Q0RcdTVFOTRcdTVGNTJcdTRFMDA6R2l0SHViIC9yZWxlYXNlcy9sYXRlc3QgXHU4RkQ0XHU1NkRFXHU1QkY5XHU4QzYxLGF0b21naXQgL3JlbGVhc2VzIFx1OEZENFx1NTZERVx1NjU3MFx1N0VDNFx1MzAwMlxyXG4gKiAgYXRvbWdpdCBcdTUyMTdcdTg4NjhcdTYzMDkgY3JlYXRlZF9hdCBcdTYzOTJcdTVFOEZcdTMwMDFcdTk5OTZcdTRFMkFcdTUxNDNcdTdEMjBcdTRFMERcdTRGRERcdThCQzFcdTY2MkZcdTY3MDBcdTY1QjAgdGFnKFx1NUI5RVx1NkQ0QiB2MC4yLjggXHU1RUZBXHJcbiAqICBcdTVGOTdcdTZCRDQgdjAuMi45IFx1NjY1QVx1ODAwQ1x1NjM5Mlx1N0IyQ1x1NEUwMClcdTIxOTIgXHU1QkEyXHU2MjM3XHU3QUVGXHU2MzA5XHU4QkVEXHU0RTQ5XHU3MjQ4XHU2NzJDXHU2MzExIHRhZyBcdTY3MDBcdTU5MjdcdTc2ODQgcmVsZWFzZVx1MzAwMnRhZyBcdTdGM0FcdTU5MzEvXHJcbiAqICBcdTVGNjJcdTcyQjZcdTRFMERcdTVCRjlcdThGRDRcdTU2REUgbnVsbChcdTYzMDlcdTY3MkNcdTkwMUFcdTkwNTNcdTU5MzFcdThEMjVcdTU2REVcdTkwMDBcdTRFMEJcdTRFMDBcdTkwMUFcdTkwNTMpXHUzMDAyICovXHJcbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpemVSZWxlYXNlKGpzb246IHVua25vd24pOiBMYXRlc3RSZWxlYXNlIHwgbnVsbCB7XHJcbiAgbGV0IGJlc3Q6IExhdGVzdFJlbGVhc2UgfCBudWxsID0gbnVsbDtcclxuICBmb3IgKGNvbnN0IHJlbCBvZiBBcnJheS5pc0FycmF5KGpzb24pID8ganNvbiA6IFtqc29uXSkge1xyXG4gICAgaWYgKHR5cGVvZiByZWwgIT09ICdvYmplY3QnIHx8IHJlbCA9PT0gbnVsbCkgY29udGludWU7XHJcbiAgICBjb25zdCByID0gcmVsIGFzIHsgdGFnX25hbWU/OiB1bmtub3duOyBib2R5PzogdW5rbm93bjsgYXNzZXRzPzogdW5rbm93biB9O1xyXG4gICAgaWYgKHR5cGVvZiByLnRhZ19uYW1lICE9PSAnc3RyaW5nJyB8fCByLnRhZ19uYW1lID09PSAnJykgY29udGludWU7XHJcbiAgICBjb25zdCBhc3NldHM6IFJlbGVhc2VBc3NldFtdID0gQXJyYXkuaXNBcnJheShyLmFzc2V0cylcclxuICAgICAgPyByLmFzc2V0cy5mbGF0TWFwKChhKTogUmVsZWFzZUFzc2V0W10gPT4ge1xyXG4gICAgICAgICAgY29uc3QgeCA9IGEgYXMgeyBuYW1lPzogdW5rbm93bjsgYnJvd3Nlcl9kb3dubG9hZF91cmw/OiB1bmtub3duOyBzaXplPzogdW5rbm93biB9O1xyXG4gICAgICAgICAgcmV0dXJuIHR5cGVvZiB4Lm5hbWUgPT09ICdzdHJpbmcnICYmIHR5cGVvZiB4LmJyb3dzZXJfZG93bmxvYWRfdXJsID09PSAnc3RyaW5nJ1xyXG4gICAgICAgICAgICA/IFt7IG5hbWU6IHgubmFtZSwgYnJvd3Nlcl9kb3dubG9hZF91cmw6IHguYnJvd3Nlcl9kb3dubG9hZF91cmwsIHNpemU6IHR5cGVvZiB4LnNpemUgPT09ICdudW1iZXInID8geC5zaXplIDogMCB9XVxyXG4gICAgICAgICAgICA6IFtdO1xyXG4gICAgICAgIH0pXHJcbiAgICAgIDogW107XHJcbiAgICBjb25zdCBjdXI6IExhdGVzdFJlbGVhc2UgPSB7IHRhZ19uYW1lOiByLnRhZ19uYW1lLCBib2R5OiB0eXBlb2Ygci5ib2R5ID09PSAnc3RyaW5nJyA/IHIuYm9keSA6ICcnLCBhc3NldHMgfTtcclxuICAgIGlmIChiZXN0ID09PSBudWxsIHx8IGNtcFZlcnNpb24oY3VyLnRhZ19uYW1lLCBiZXN0LnRhZ19uYW1lKSA+IDApIGJlc3QgPSBjdXI7XHJcbiAgfVxyXG4gIHJldHVybiBiZXN0O1xyXG59XHJcblxyXG4vKiogXHU0RUNFIHJlbGVhc2UgXHU4RDQ0XHU0RUE3XHU2MzExXHU1Qjg5XHU4OEM1XHU1MzA1OkhNSC1EZXNrdG9wLVNldHVwLSouZXhlIFx1N0NCRVx1Nzg2RVx1NTMzOVx1OTE0RCxcdTUxNUNcdTVFOTVcdTRFRkJcdTYxMEYgLmV4ZVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gcGlja0luc3RhbGxlckFzc2V0KGFzc2V0czogcmVhZG9ubHkgUmVsZWFzZUFzc2V0W10pOiBSZWxlYXNlQXNzZXQgfCBudWxsIHtcclxuICByZXR1cm4gYXNzZXRzLmZpbmQoKGEpID0+IC9eSE1ILURlc2t0b3AtU2V0dXAtLipcXC5leGUkL2kudGVzdChhLm5hbWUpKVxyXG4gICAgPz8gYXNzZXRzLmZpbmQoKGEpID0+IGEubmFtZS50b0xvd2VyQ2FzZSgpLmVuZHNXaXRoKCcuZXhlJykpXHJcbiAgICA/PyBudWxsO1xyXG59XHJcblxyXG4vKiogYXRvbWdpdCBBUEkgXHU0RTBCXHU4RjdEXHU3QUVGXHU3MEI5KGFnLWNsaSByZWxlYXNlX2Fzc2V0cy5nbyBcdTU0MENcdTVGNjI6dGFnICsgXHU2NTg3XHU0RUY2XHU1NDBEKVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gYXRvbWdpdEFwaURvd25sb2FkVXJsKHJlcG9zOiBVcGRhdGVSZXBvcywgdGFnOiBzdHJpbmcsIGFzc2V0TmFtZTogc3RyaW5nKTogc3RyaW5nIHtcclxuICByZXR1cm4gYGh0dHBzOi8vYXBpLmF0b21naXQuY29tL2FwaS92NS9yZXBvcy8ke3JlcG9zLmF0b21naXR9L3JlbGVhc2VzLyR7dGFnfS9hdHRhY2hfZmlsZXMvJHtlbmNvZGVVUklDb21wb25lbnQoYXNzZXROYW1lKX0vZG93bmxvYWRgO1xyXG59XHJcblxyXG4vKiogXHU0RTBCXHU4RjdEXHU1MDE5XHU5MDA5XHU5NEZFOmF0b21naXQgXHU1NDdEXHU0RTJEKFx1NjIxNlx1OEQ0NFx1NEVBNyBVUkwgXHU2NzJDXHU1QzMxXHU1NzI4IGF0b21naXQuY29tKVx1MjE5MiBhdG9tZ2l0IFx1OEQ0NFx1NEVBN1x1NzZGNFx1OTRGRVx1MzAwMVxyXG4gKiAgYXRvbWdpdCBBUEkgXHU3QUVGXHU3MEI5XHU0RjE4XHU1MTQ4LFx1NTE4RFx1NjJGQyBHaXRIdWIgXHU0RTNCXHU0RUQzXHU1NDBDIHRhZyBcdTU0MENcdTU0MERcdThENDRcdTRFQTdcdTc2ODRcdTk1NUNcdTUwQ0ZcdTk0RkVcdTUxNUNcdTVFOTUoYXRvbWdpdFxyXG4gKiAgMzAyIFx1MjE5MiBDRE4gXHU3QjdFXHU1NDBEXHU3NkY0XHU5NEZFLFx1NTMzRlx1NTQwRFx1NTNFRlx1NEUwQlx1MzAwMVx1NjVFMFx1OTcwMCBSZWZlcmVyKTtHaXRIdWIgXHU1NDdEXHU0RTJEIFx1MjE5MiBcdTY1RTJcdTY3MDlcdTk1NUNcdTUwQ0ZcdTk0RkVcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGRvd25sb2FkQ2FuZGlkYXRlcyhpbnB1dDogeyBjaGFubmVsOiB1bmtub3duOyB0YWc6IHN0cmluZzsgYXNzZXRVcmw6IHN0cmluZzsgYXNzZXROYW1lOiBzdHJpbmc7IHJlcG9zOiBVcGRhdGVSZXBvcyB9KTogcmVhZG9ubHkgc3RyaW5nW10ge1xyXG4gIGNvbnN0IHsgY2hhbm5lbCwgdGFnLCBhc3NldFVybCwgYXNzZXROYW1lLCByZXBvcyB9ID0gaW5wdXQ7XHJcbiAgbGV0IG9uQXRvbWdpdCA9IG5vcm1hbGl6ZUNoYW5uZWwoY2hhbm5lbCkgPT09ICdhdG9tZ2l0JztcclxuICB0cnkgeyBpZiAobmV3IFVSTChhc3NldFVybCkuaG9zdG5hbWUgPT09ICdhdG9tZ2l0LmNvbScpIG9uQXRvbWdpdCA9IHRydWU7IH0gY2F0Y2ggeyAvKiBcdTY1RTBcdTY1NDggVVJMIFx1NjMwOVx1OTAxQVx1OTA1M1x1NTIyNFx1NUI5QSAqLyB9XHJcbiAgaWYgKG9uQXRvbWdpdCkge1xyXG4gICAgY29uc3QgZ2l0aHViQXNzZXRVcmwgPSBgaHR0cHM6Ly9naXRodWIuY29tLyR7cmVwb3MuZ2l0aHVifS9yZWxlYXNlcy9kb3dubG9hZC8ke3RhZ30vJHthc3NldE5hbWV9YDtcclxuICAgIHJldHVybiBbLi4ubmV3IFNldChbYXNzZXRVcmwsIGF0b21naXRBcGlEb3dubG9hZFVybChyZXBvcywgdGFnLCBhc3NldE5hbWUpLCAuLi5vcmRlcmVkRG93bmxvYWRNaXJyb3JzKGdpdGh1YkFzc2V0VXJsLCBjaGFubmVsKV0pXTtcclxuICB9XHJcbiAgcmV0dXJuIG9yZGVyZWREb3dubG9hZE1pcnJvcnMoYXNzZXRVcmwsIGNoYW5uZWwpO1xyXG59XHJcblxyXG4vKiogXHU0RTBCXHU4RjdEXHU2ODIxXHU5QThDOlx1NTE0M1x1NjU3MFx1NjM2RSBzaXplPjAgXHU2NUY2XHU5ODdCXHU0RTBFXHU4NDNEXHU3NkQ4XHU1QjU3XHU4MjgyXHU0RTAwXHU4MUY0KGF0b21naXQgXHU0RjIwXHU4RjkzXHU1M0VGXHU5NzYwXHU2MDI3XHU5OTk2XHU5QThDLFxyXG4gKiAgR2l0SHViIFx1OEQ0NFx1NEVBN1x1NTE0M1x1NjU3MFx1NjM2RVx1NTQwQ1x1NjgzN1x1NUUyNiBzaXplLFx1OTg3QVx1NUUyNlx1NEUwMFx1OEQ3N1x1NEZERFx1NzcxRilcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHNpemVNYXRjaGVzKG1ldGFTaXplOiBudW1iZXIsIGFjdHVhbEJ5dGVzOiBudW1iZXIpOiBib29sZWFuIHtcclxuICByZXR1cm4gIShtZXRhU2l6ZSA+IDApIHx8IG1ldGFTaXplID09PSBhY3R1YWxCeXRlcztcclxufVxyXG5cclxuLyoqIFx1NTE2OFx1OTAxQVx1OTA1M1x1NTkzMVx1OEQyNVx1NzY4NFx1OTUxOVx1OEJFRlx1NEUzMjpcdTkwMTBcdTkwMUFcdTkwNTNcdTUyMTdcdTUxRkFcdTUzOUZcdTU2RTAoXHU3RjUxXHU3RURDXHU4QkNBXHU2NUFEXHU3NTI4O1VJIFx1NjZGNFx1NjVCMFx1OTc2Mlx1Njc3Rlx1NzE2N1x1NUUzOFx1NjYzRVx1NzkzQSlcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHN1bW1hcml6ZUNoZWNrRmFpbHVyZXMoZmFpbHVyZXM6IFJlYWRvbmx5QXJyYXk8eyBsYWJlbDogc3RyaW5nOyByZWFzb246IHN0cmluZyB9Pik6IHN0cmluZyB7XHJcbiAgcmV0dXJuIGZhaWx1cmVzLm1hcCgoZikgPT4gYCR7Zi5sYWJlbH06JHtmLnJlYXNvbn1gKS5qb2luKCc7ICcpO1xyXG59XHJcbiIsICIvKipcbiAqIFx1NEVEM1x1NUU5M1x1OTc2Mlx1Njc3Rlx1NTQwRVx1N0FFRihcdTRFRkJcdTUyQTEgMTQtQilcdTIwMTRcdTIwMTQgR2l0SHViL0F0b21HaXQgXHU1M0NDXHU1RTczXHU1M0YwIGdoL2FnIENMSSBcdTc2ODQgbWFpbiBcdThGREJcdTdBMEJcdTVDMDFcdTg4QzVcdTMwMDJcbiAqXG4gKiBcdTVCODlcdTUxNjhcdTRFMERcdTUzRDhcdTkxQ0YoXHU1RjAwXHU1M0QxXHU4QkExXHU1MjEyIE0wIFx1NTFGQVx1NTNFM1x1OTVFOFx1NTQwQ1x1NkU5MCk6XG4gKiAgLSByZW5kZXJlciBcdTZDMzhcdTRFMEQgc3Bhd246XHU2MjQwXHU2NzA5XHU4QzAzXHU3NTI4XHU4RDcwIGluZGV4LnRzIFx1NkNFOFx1NTE4Q1x1NzY4NCBJUEMgXHU3NjdEXHU1NDBEXHU1MzU1LFx1OTAxMFx1NjVCOVx1NkNENVx1NjgyMVx1OUE4Q1x1NTNDMlx1NjU3MDtcbiAqICAtIGhvc3QgXHU1M0VBXHU4QkE0ICdnaXRodWInfCdhdG9tZ2l0JyxyZXBvIFx1NTNFQVx1OEJBNCBvd25lci9uYW1lIFx1NUY2Mlx1NjAwMSxzdGF0ZSBcdTUzRUFcdThCQTQgb3BlbnxjbG9zZWR8YWxsO1xuICogIC0gXHU3NjdCXHU1RjU1XHU3RUREXHU0RTBEXHU2MzU1XHU4M0I3L1x1NUI1OFx1NTBBOFx1NEVFNFx1NzI0QzpcdTUzRUEgc3Bhd24gXHU1Qjk4XHU2NUI5IENMSSBcdTc2ODRcdTZENEZcdTg5QzhcdTU2NjggT0F1dGggXHU2RDQxXHU3QTBCLFx1OEY2Q1x1NTNEMVx1NTE3NiBzdGRvdXRcbiAqICAgIFx1ODg0Q1x1N0VEOSByZW5kZXJlciBcdTVDNTVcdTc5M0EgVVJML1x1OEJCRVx1NTkwN1x1NzgwMSxcdTVFNzZcdTU5MTZcdTVGMDBcdTdDRkJcdTdFREZcdTZENEZcdTg5QzhcdTU2Njg7XHU0RUU0XHU3MjRDXHU1M0VBXHU4NDNEIENMSSBcdTgxRUFcdTVERjFcdTc2ODRcdTUxRURcdTYzNkVcdTVFOTM7XG4gKiAgLSBcdTYyNDBcdTY3MDlcdTU0N0RcdTRFRTQgNjBzIFx1OEQ4NVx1NjVGNihcdTc2N0JcdTVGNTVcdTY1M0VcdTVCQkRcdTUyMzAgMyBcdTUyMDZcdTk0OUYsXHU3QjQ5XHU3NTI4XHU2MjM3XHU1NzI4XHU2RDRGXHU4OUM4XHU1NjY4XHU1QjhDXHU2MjEwKTtcbiAqICAtIFx1OTUxOVx1OEJFRlx1NUY1Mlx1NEUwMCB7IG9rOmZhbHNlLCBjb2RlLCBlcnJvciB9LGVycm9yIFx1NjIyQVx1NjVBRFx1OTYzMlx1NjVFNVx1NUZEN1x1NkQyQVx1NkNEQlx1MzAwMlxuICpcbiAqIFx1NEUwRSAxNC1BKGhtaGFybmVzcyBmb3JnZV8qIFx1NURFNVx1NTE3NylcdTRFOTJcdTkwMUE6cmVuZGVyZXIgXHU3Njg0XCJcdThCQTkgaG1oIFx1NTkwNFx1NzQwNlwiXHU2MjhBXHU0RUQzXHU1RTkzXHU0RTBBXHU0RTBCXHU2NTg3XG4gKiBcdTU4NkJcdThGREIgY29tcG9zZXIsXHU3NTMxIGFnZW50IFx1NEZBN1x1NURFNVx1NTE3N1x1NjNBNVx1NjI0QjtcdTY3MkNcdTY1ODdcdTRFRjZcdTUzRUFcdTY3MERcdTUyQTFcdTk3NjJcdTY3N0ZcdTgxRUFcdThFQUJcdTc2ODRcdTUzNzNcdTY1RjZcdTc2RjRcdTY0Q0RcdTRGNUNcdTMwMDJcbiAqL1xuaW1wb3J0IHsgc3Bhd24sIGV4ZWNGaWxlU3luYyB9IGZyb20gJ25vZGU6Y2hpbGRfcHJvY2Vzcyc7XG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFkRmlsZVN5bmMgfSBmcm9tICdub2RlOmZzJztcbmltcG9ydCB7IGhvbWVkaXIgfSBmcm9tICdub2RlOm9zJztcbmltcG9ydCB7IGlzQWJzb2x1dGUsIGpvaW4sIGRpcm5hbWUsIHNlcCB9IGZyb20gJ25vZGU6cGF0aCc7XG5cbmV4cG9ydCB0eXBlIEZvcmdlSG9zdCA9ICdnaXRodWInIHwgJ2F0b21naXQnO1xuXG5leHBvcnQgaW50ZXJmYWNlIEZvcmdlSG9zdFN0YXR1cyB7IGluc3RhbGxlZDogYm9vbGVhbjsgbG9nZ2VkOiBib29sZWFuOyB1c2VyOiBzdHJpbmcgfVxuZXhwb3J0IGludGVyZmFjZSBGb3JnZVN0YXR1cyB7IGdpdGh1YjogRm9yZ2VIb3N0U3RhdHVzOyBhdG9tZ2l0OiBGb3JnZUhvc3RTdGF0dXMgfVxuZXhwb3J0IGludGVyZmFjZSBGb3JnZVJlcG8geyBuYW1lOiBzdHJpbmc7IGZ1bGxOYW1lOiBzdHJpbmc7IGlzUHJpdmF0ZTogYm9vbGVhbjsgdXBkYXRlZEF0OiBzdHJpbmc7IHVybDogc3RyaW5nOyBkZXNjcmlwdGlvbjogc3RyaW5nIH1cbmV4cG9ydCBpbnRlcmZhY2UgRm9yZ2VQciB7IG51bWJlcjogc3RyaW5nOyB0aXRsZTogc3RyaW5nOyBzdGF0ZTogc3RyaW5nOyBpc0RyYWZ0OiBib29sZWFuOyB1cGRhdGVkQXQ6IHN0cmluZzsgdXJsOiBzdHJpbmcgfVxuZXhwb3J0IGludGVyZmFjZSBGb3JnZUlzc3VlIHsgbnVtYmVyOiBzdHJpbmc7IHRpdGxlOiBzdHJpbmc7IHN0YXRlOiBzdHJpbmc7IHVwZGF0ZWRBdDogc3RyaW5nOyB1cmw6IHN0cmluZyB9XG5leHBvcnQgaW50ZXJmYWNlIEZvcmdlUmVsZWFzZSB7IHRhZzogc3RyaW5nOyBuYW1lOiBzdHJpbmc7IGNyZWF0ZWRBdDogc3RyaW5nOyBpc0RyYWZ0OiBib29sZWFuOyBpc1ByZXJlbGVhc2U6IGJvb2xlYW4gfVxuZXhwb3J0IGludGVyZmFjZSBGb3JnZUNsaVJlc3VsdCB7IGNvZGU6IG51bWJlciB8IG51bGw7IHN0ZG91dDogc3RyaW5nOyBzdGRlcnI6IHN0cmluZzsgdGltZWRPdXQ6IGJvb2xlYW4gfVxuZXhwb3J0IHR5cGUgRm9yZ2VPazxUPiA9IHsgb2s6IHRydWU7IGRhdGE6IFQgfSB8IHsgb2s6IGZhbHNlOyBjb2RlOiBzdHJpbmc7IGVycm9yOiBzdHJpbmcgfVxuXG4vKiogXHU1NDdEXHU0RUU0XHU3N0U5XHU5NjM1Olx1NEUyNFx1NUU3M1x1NTNGMFx1NTQwQ1x1NjVDRlx1NTQ3RFx1NEVFNCxcdTVERUVcdTVGMDJcdTUzRUFcdTU3MjggcmVwbyBcdTRGMjBcdTUzQzIoZ2ggLS1yZXBvIC8gYWcgXHU0RjREXHU3RjZFXHU1M0MyXHU2NTcwKVx1MzAwMiAqL1xuZXhwb3J0IGNvbnN0IENMSV9CSU46IFJlY29yZDxGb3JnZUhvc3QsIHN0cmluZz4gPSB7IGdpdGh1YjogJ2doJywgYXRvbWdpdDogJ2FnJyB9O1xuY29uc3QgSE9TVFM6IHJlYWRvbmx5IEZvcmdlSG9zdFtdID0gWydnaXRodWInLCAnYXRvbWdpdCddO1xuY29uc3QgUkVQT19SRSA9IC9eW0EtWmEtejAtOV8uLV0rXFwvW0EtWmEtejAtOV8uLV0rJC87XG5jb25zdCBDTURfVElNRU9VVF9NUyA9IDYwXzAwMDtcbmNvbnN0IExPR0lOX1RJTUVPVVRfTVMgPSAxODBfMDAwO1xuY29uc3QgTElTVF9MSU1JVCA9IDUwO1xuY29uc3QgUEFHRV9TSVpFID0gMjA7XG5cbi8qIC0tLS0gc3Bhd24gc2VhbShcdTUzNTVcdTZENEJcdTZDRThcdTUxNjU7XHU3NTFGXHU0RUE3XHU1QjlFXHU3M0IwID0gd2hlcmUgXHU4OUUzXHU2NzkwICsgXHU4RDg1XHU2NUY2IGtpbGwpIC0tLS0gKi9cbmV4cG9ydCBpbnRlcmZhY2UgRm9yZ2VEZXBzIHtcbiAgLyoqIFx1OEREMVx1NEUwMFx1Njc2MSBDTEkgXHU1NDdEXHU0RUU0KFx1OEQ4NVx1NjVGNlx1NUYzQVx1NTIzNiBraWxsKTtvbkxpbmUgXHU2NTM2XHU1MjMwIHN0ZG91dCBcdTg4NEMoXHU3NjdCXHU1RjU1XHU2RDQxXHU3QTBCXHU2RDQxXHU1RjBGXHU4RjZDXHU1M0QxKVx1MzAwMiAqL1xuICBydW4oY21kOiBzdHJpbmcsIGFyZ3M6IHN0cmluZ1tdLCB0aW1lb3V0TXM6IG51bWJlciwgb25MaW5lPzogKGxpbmU6IHN0cmluZykgPT4gdm9pZCk6IFByb21pc2U8Rm9yZ2VDbGlSZXN1bHQ+O1xuICAvKiogXHU4OUUzXHU2NzkwXHU1M0VGXHU2MjY3XHU4ODRDXHU2NTg3XHU0RUY2XHU1QjhDXHU2NTc0XHU4REVGXHU1Rjg0OycnID0gXHU2NzJBXHU1Qjg5XHU4OEM1XHUzMDAyICovXG4gIHdoaWNoKGNtZDogc3RyaW5nKTogc3RyaW5nO1xufVxuXG5leHBvcnQgY29uc3QgZGVmYXVsdERlcHM6IEZvcmdlRGVwcyA9IHtcbiAgcnVuOiAoY21kLCBhcmdzLCB0aW1lb3V0TXMsIG9uTGluZSkgPT5cbiAgICBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xuICAgICAgY29uc3QgciA9IHJlc29sdmVDbGkoY21kKTtcbiAgICAgIGNvbnN0IGNoaWxkID0gc3Bhd24oci5iaW4sIFsuLi5yLnByZWZpeCwgLi4uYXJnc10sIHsgd2luZG93c0hpZGU6IHRydWUsIHN0ZGlvOiBbJ2lnbm9yZScsICdwaXBlJywgJ3BpcGUnXSB9KTtcbiAgICAgIGxldCBvdXQgPSAnJztcbiAgICAgIGxldCBlcnIgPSAnJztcbiAgICAgIGxldCB0aW1lZE91dCA9IGZhbHNlO1xuICAgICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHsgdGltZWRPdXQgPSB0cnVlOyBjaGlsZC5raWxsKCk7IH0sIHRpbWVvdXRNcyk7XG4gICAgICBjaGlsZC5zdGRvdXQub24oJ2RhdGEnLCAoZDogQnVmZmVyKSA9PiB7XG4gICAgICAgIGNvbnN0IHRleHQgPSBkLnRvU3RyaW5nKCk7XG4gICAgICAgIG91dCA9IChvdXQgKyB0ZXh0KS5zbGljZSgtMjAwXzAwMCk7XG4gICAgICAgIGlmIChvbkxpbmUgIT09IHVuZGVmaW5lZCkgZm9yIChjb25zdCBsaW5lIG9mIHRleHQuc3BsaXQoL1xccj9cXG4vKSkgaWYgKGxpbmUudHJpbSgpICE9PSAnJykgb25MaW5lKGxpbmUpO1xuICAgICAgfSk7XG4gICAgICBjaGlsZC5zdGRlcnIub24oJ2RhdGEnLCAoZDogQnVmZmVyKSA9PiB7IGVyciA9IChlcnIgKyBkLnRvU3RyaW5nKCkpLnNsaWNlKC02MF8wMDApOyB9KTtcbiAgICAgIGNoaWxkLm9uKCdlcnJvcicsIChlKSA9PiB7IGNsZWFyVGltZW91dCh0aW1lcik7IHJlc29sdmUoeyBjb2RlOiAtMSwgc3Rkb3V0OiBvdXQsIHN0ZGVycjogYCR7ZXJyfSR7U3RyaW5nKGUpfWAsIHRpbWVkT3V0IH0pOyB9KTtcbiAgICAgIGNoaWxkLm9uKCdjbG9zZScsIChjb2RlKSA9PiB7IGNsZWFyVGltZW91dCh0aW1lcik7IHJlc29sdmUoeyBjb2RlOiBjb2RlID8/IC0xLCBzdGRvdXQ6IG91dCwgc3RkZXJyOiBlcnIsIHRpbWVkT3V0IH0pOyB9KTtcbiAgICB9KSxcbiAgd2hpY2g6IChjbWQpID0+IHtcbiAgICB0cnkge1xuICAgICAgLy8gd2hlcmUgXHU4RDcwIFBBVEhFWFQgXHU4OUUzXHU2NzkwO1x1NEVGQlx1NEUwMFx1ODg0Q1x1NTQ3RFx1NEUyRFx1NTM3M1x1ODlDNlx1NEUzQVx1NURGMlx1NUI4OVx1ODhDNShnaD1leGU7YWc9bnBtIHNoaW0gXHU0RTVGXHU3Qjk3KVxuICAgICAgY29uc3Qgb3V0ID0gZXhlY0ZpbGVTeW5jKCd3aGVyZScsIFtjbWRdLCB7IGVuY29kaW5nOiAndXRmOCcsIHRpbWVvdXQ6IDRfMDAwLCB3aW5kb3dzSGlkZTogdHJ1ZSB9KTtcbiAgICAgIHJldHVybiAob3V0LnNwbGl0KC9cXHI/XFxuLykuZmluZCgobCkgPT4gbC50cmltKCkgIT09ICcnKSA/PyAnJykudHJpbSgpO1xuICAgIH0gY2F0Y2ggeyByZXR1cm4gJyc7IH1cbiAgfSxcbn07XG5cbi8qKiB3aGVyZSBcdTc2ODRcdTUxNjhcdTkwRThcdTUwMTlcdTkwMDlcdTg4NEMoXHU1QzBGXHU1REU1XHU1MTc3OndoaWNoL3Jlc29sdmVDbGkgXHU1MTcxXHU3NTI4KVx1MzAwMiAqL1xuZnVuY3Rpb24gd2hlcmVMaW5lcyhjbWQ6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBvdXQgPSBleGVjRmlsZVN5bmMoJ3doZXJlJywgW2NtZF0sIHsgZW5jb2Rpbmc6ICd1dGY4JywgdGltZW91dDogNF8wMDAsIHdpbmRvd3NIaWRlOiB0cnVlIH0pO1xuICAgIHJldHVybiBvdXQuc3BsaXQoL1xccj9cXG4vKS5tYXAoKGwpID0+IGwudHJpbSgpKS5maWx0ZXIoKGwpID0+IGwgIT09ICcnKTtcbiAgfSBjYXRjaCB7IHJldHVybiBbXTsgfVxufVxuXG4vKipcbiAqIENMSSBcdTU0MEQgXHUyMTkyIFx1NTNFRiBzcGF3biBcdTc2ODRcdTVGNjJcdTYwMDEoV2luZG93cyBcdTVCOUVcdTZENEJcdTU3NTEpOlxuICogIC0gLmV4ZShnaClcdTIxOTIgXHU3NkY0XHU2M0E1IHNwYXduO1xuICogIC0gbnBtIFx1NTE2OFx1NUM0MCBzaGltKGFnIFx1NzY4NCBhZy5jbWQgLyBcdTY1RTBcdTYyNjlcdTVDNTVcdTU0MEQgc2gpXHUyMTkyIENyZWF0ZVByb2Nlc3MgXHU0RTBEXHU4MEZEXHU2MjY3XHU4ODRDLFxuICogICAgXHU0RTE0IHNoZWxsOnRydWUgXHU2MkZDXHU2M0E1XHU2NzA5XHU2Q0U4XHU1MTY1XHU5NzYyKHRpdGxlL2JvZHkgXHU2NjJGXHU3NTI4XHU2MjM3XHU4RjkzXHU1MTY1KVx1MjAxNFx1MjAxNFx1ODlFM1x1Njc5MCBzaGltIFx1OTFDQ1x1NUYxNVx1NzUyOFx1NzY4NFxuICogICAgbm9kZV9tb2R1bGVzLyoqLmpzIFx1NzcxRlx1OEVBQixcdTc1Mjggbm9kZS5leGUgPGpzPiBcdTc2RjRcdThERDEoXHU2NUUwIHNoZWxsLFx1NTNDMlx1NjU3MFx1NjU3MFx1N0VDNFx1NTM5Rlx1NjgzN1x1NEYyMClcdTMwMDJcbiAqL1xuZnVuY3Rpb24gcmVzb2x2ZUNsaShjbWQ6IHN0cmluZyk6IHsgYmluOiBzdHJpbmc7IHByZWZpeDogc3RyaW5nW10gfSB7XG4gIGNvbnN0IGxpbmVzID0gd2hlcmVMaW5lcyhjbWQpO1xuICBjb25zdCBleGUgPSBsaW5lcy5maW5kKChsKSA9PiAvXFwuZXhlJC9pLnRlc3QobCkpO1xuICBpZiAoZXhlICE9PSB1bmRlZmluZWQpIHJldHVybiB7IGJpbjogZXhlLCBwcmVmaXg6IFtdIH07XG4gIGNvbnN0IHNoaW0gPSBsaW5lcy5maW5kKChsKSA9PiAvXFwuKGNtZHxiYXQpJC9pLnRlc3QobCkpID8/IGxpbmVzWzBdO1xuICBpZiAoc2hpbSA9PT0gdW5kZWZpbmVkKSByZXR1cm4geyBiaW46IGNtZCwgcHJlZml4OiBbXSB9O1xuICB0cnkge1xuICAgIGNvbnN0IHRleHQgPSByZWFkRmlsZVN5bmMoc2hpbSwgJ3V0ZjgnKTtcbiAgICBjb25zdCBtID0gdGV4dC5tYXRjaCgvbm9kZV9tb2R1bGVzW1xcXFwvXVtcXHdALlxcLVxcXFwvXSs/XFwuKD86anN8bWpzfGNqcykvaSk7XG4gICAgaWYgKG0gIT09IG51bGwpIHtcbiAgICAgIGNvbnN0IGpzID0gam9pbihkaXJuYW1lKHNoaW0pLCBtWzBdLnJlcGxhY2UoL1xcLy9nLCBzZXApKTtcbiAgICAgIGlmIChleGlzdHNTeW5jKGpzKSkge1xuICAgICAgICBjb25zdCBub2RlRXhlID0gd2hlcmVMaW5lcygnbm9kZScpLmZpbmQoKGwpID0+IC9cXC5leGUkL2kudGVzdChsKSkgPz8gJ25vZGUnO1xuICAgICAgICByZXR1cm4geyBiaW46IG5vZGVFeGUsIHByZWZpeDogW2pzXSB9O1xuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCB7IC8qIHNoaW0gXHU4QkZCXHU0RTBEXHU0RTg2Olx1NjMwOVx1NTM5Rlx1NjgzNyBzcGF3bihcdTU5MzFcdThEMjVcdTRGMUFcdTVGNTJcdTRFMDBcdTYyMTAgQ0xJX0VSUk9SL1x1NjcyQVx1ODhDNSkgKi8gfVxuICByZXR1cm4geyBiaW46IHNoaW0sIHByZWZpeDogW10gfTtcbn1cblxuLyogLS0tLSBcdTUzQzJcdTY1NzBcdTY4MjFcdTlBOEMoXHU2QkNGXHU0RTJBIElQQyBcdTY1QjlcdTZDRDVcdTUxNjVcdTUzRTNcdTkwMTBcdTUzQzJcdTY1NzBcdThGQzdcdTRFMDBcdTkwNEQ7XHU4RkQ0XHU1NkRFIG51bGw9XHU5MDFBXHU4RkM3KSAtLS0tICovXG5leHBvcnQgZnVuY3Rpb24gY2hlY2tIb3N0KGhvc3Q6IHVua25vd24pOiBGb3JnZUhvc3QgfCBudWxsIHtcbiAgcmV0dXJuIGhvc3QgPT09ICdnaXRodWInIHx8IGhvc3QgPT09ICdhdG9tZ2l0JyA/IGhvc3QgOiBudWxsO1xufVxuZXhwb3J0IGZ1bmN0aW9uIGNoZWNrUmVwbyhyZXBvOiB1bmtub3duKTogc3RyaW5nIHwgbnVsbCB7XG4gIHJldHVybiB0eXBlb2YgcmVwbyA9PT0gJ3N0cmluZycgJiYgUkVQT19SRS50ZXN0KHJlcG8pICYmIHJlcG8ubGVuZ3RoIDw9IDE0MCA/IHJlcG8gOiBudWxsO1xufVxuZXhwb3J0IGZ1bmN0aW9uIGNoZWNrU3RhdGUoc3RhdGU6IHVua25vd24pOiAnb3BlbicgfCAnY2xvc2VkJyB8ICdhbGwnIHtcbiAgcmV0dXJuIHN0YXRlID09PSAnY2xvc2VkJyB8fCBzdGF0ZSA9PT0gJ2FsbCcgPyBzdGF0ZSA6ICdvcGVuJztcbn1cbmV4cG9ydCBmdW5jdGlvbiBjaGVja1N0cih2OiB1bmtub3duLCBtYXg6IG51bWJlcik6IHN0cmluZyB7XG4gIHJldHVybiB0eXBlb2YgdiA9PT0gJ3N0cmluZycgPyB2LnNsaWNlKDAsIG1heCkgOiAnJztcbn1cblxuLyoqIFx1ODlFM1x1Njc5MCBzdGRvdXQvc3RkZXJyIFx1OTFDQ1x1NzY4NFx1N0IyQ1x1NEUwMFx1NEUyQSBodHRwKHMpIFVSTChcdTc2N0JcdTVGNTVcdTZENDFcdTdBMEJcdTU5MTZcdTVGMDBcdTZENEZcdTg5QzhcdTU2NjggKyBcdTVDNTVcdTc5M0EpXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gZXh0cmFjdFVybCh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBtID0gdGV4dC5tYXRjaCgvaHR0cHM6XFwvXFwvW15cXHMnXCIpXFxdXSsvKTtcbiAgcmV0dXJuIG0gPT09IG51bGwgPyAnJyA6IG1bMF0ucmVwbGFjZSgvWy4sO10rJC8sICcnKTtcbn1cblxuLyoqIGF1dGggc3RhdHVzIFx1NjU4N1x1NjcyQyBcdTIxOTIgXHU3NjdCXHU1RjU1XHU2MDAxICsgXHU3NTI4XHU2MjM3XHU1NDBEKFx1NEUyNFx1NUU3M1x1NTNGMFx1NjU4N1x1Njg0ODpnaCBcImFjY291bnQgWFwiIC8gYWcgXCJhcyBYXCIpXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VBdXRoU3RhdHVzKGhvc3Q6IEZvcmdlSG9zdCwgc3Rkb3V0OiBzdHJpbmcsIHN0ZGVycjogc3RyaW5nLCBjb2RlOiBudW1iZXIgfCBudWxsKTogRm9yZ2VIb3N0U3RhdHVzIHtcbiAgY29uc3QgdGV4dCA9IGAke3N0ZG91dH1cXG4ke3N0ZGVycn1gO1xuICBjb25zdCBtID0gdGV4dC5tYXRjaChob3N0ID09PSAnZ2l0aHViJyA/IC9Mb2dnZWQgaW4gdG8gZ2l0aHViXFwuY29tIGFjY291bnQgKFxcUyspLyA6IC9Mb2dnZWQgaW4gdG8gYXRvbWdpdFxcLmNvbSBhcyAoXFxTKykvKTtcbiAgaWYgKG0gIT09IG51bGwpIHJldHVybiB7IGluc3RhbGxlZDogdHJ1ZSwgbG9nZ2VkOiB0cnVlLCB1c2VyOiAobVsxXSA/PyAnJykucmVwbGFjZSgvWygpXS9nLCAnJykgfTtcbiAgLy8gZXhpdFx1MjI2MDAgXHU0RTE0XHU2NjBFXHU3ODZFXHU4QkY0XHU2NzJBXHU3NjdCXHU1RjU1IFx1MjE5MiBcdTVERjJcdTg4QzVcdTY3MkFcdTc2N0JcdTVGNTU7XHU4MEZEXHU4REQxXHU1MjMwXHU4RkQ5KFx1ODAwQ1x1OTc1RSBFTk9FTlQpXHU1MzczIENMSSBcdTVCNThcdTU3MjhcbiAgcmV0dXJuIHsgaW5zdGFsbGVkOiB0cnVlLCBsb2dnZWQ6IGZhbHNlLCB1c2VyOiAnJyAsIC4uLihjb2RlID09PSAtMSAmJiAvRU5PRU5UfHNwYXduL2kudGVzdCh0ZXh0KSA/IHsgaW5zdGFsbGVkOiBmYWxzZSB9IDoge30pIH07XG59XG5cbi8qIC0tLS0gSlNPTiBcdTVGNTJcdTRFMDAoZ2gvYWcgXHU1QjU3XHU2QkI1XHU1REVFXHU1RjAyXHU2MkI5XHU1RTczO1x1NUI1N1x1NkJCNVx1N0YzQVx1NTkzMVx1N0VEOVx1NUI4OVx1NTE2OFx1OUVEOFx1OEJBNCkgLS0tLSAqL1xudHlwZSBBbnlSZWMgPSBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbmNvbnN0IHMgPSAodjogdW5rbm93bik6IHN0cmluZyA9PiB0eXBlb2YgdiA9PT0gJ3N0cmluZycgPyB2IDogdHlwZW9mIHYgPT09ICdudW1iZXInID8gU3RyaW5nKHYpIDogJyc7XG5jb25zdCBiID0gKHY6IHVua25vd24sIGRmbHQgPSBmYWxzZSk6IGJvb2xlYW4gPT4gdHlwZW9mIHYgPT09ICdib29sZWFuJyA/IHYgOiBkZmx0O1xuXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplUmVwb3MoaG9zdDogRm9yZ2VIb3N0LCByb3dzOiBBbnlSZWNbXSk6IEZvcmdlUmVwb1tdIHtcbiAgcmV0dXJuIHJvd3MubWFwKChyKSA9PiB7XG4gICAgY29uc3QgbmFtZSA9IHMoci5uYW1lKTtcbiAgICBjb25zdCBmdWxsTmFtZSA9IHMoci5uYW1lV2l0aE93bmVyKSB8fCBzKHIuZnVsbE5hbWUpIHx8IG5hbWU7XG4gICAgcmV0dXJuIHtcbiAgICAgIG5hbWUsXG4gICAgICBmdWxsTmFtZSxcbiAgICAgIGlzUHJpdmF0ZTogaG9zdCA9PT0gJ2dpdGh1YicgPyBiKHIuaXNQcml2YXRlKSA6IHMoci52aXNpYmlsaXR5KSA9PT0gJ3ByaXZhdGUnLFxuICAgICAgdXBkYXRlZEF0OiBzKHIudXBkYXRlZEF0KSxcbiAgICAgIHVybDogcyhyLnVybCkgfHwgKGhvc3QgPT09ICdnaXRodWInID8gYGh0dHBzOi8vZ2l0aHViLmNvbS8ke2Z1bGxOYW1lfWAgOiBgaHR0cHM6Ly9hdG9tZ2l0LmNvbS8ke2Z1bGxOYW1lfWApLFxuICAgICAgZGVzY3JpcHRpb246IHMoci5kZXNjcmlwdGlvbiksXG4gICAgfTtcbiAgfSk7XG59XG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplUHJzKHJvd3M6IEFueVJlY1tdKTogRm9yZ2VQcltdIHtcbiAgcmV0dXJuIHJvd3MubWFwKChyKSA9PiAoe1xuICAgIG51bWJlcjogcyhyLm51bWJlciksXG4gICAgdGl0bGU6IHMoci50aXRsZSksXG4gICAgc3RhdGU6IHMoci5zdGF0ZSkudG9Mb3dlckNhc2UoKSB8fCAnb3BlbicsXG4gICAgaXNEcmFmdDogYihyLmlzRHJhZnQpIHx8IGIoci5kcmFmdCksXG4gICAgdXBkYXRlZEF0OiBzKHIudXBkYXRlZEF0KSxcbiAgICB1cmw6IHMoci51cmwpLFxuICB9KSk7XG59XG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplSXNzdWVzKHJvd3M6IEFueVJlY1tdKTogRm9yZ2VJc3N1ZVtdIHtcbiAgcmV0dXJuIHJvd3MubWFwKChyKSA9PiAoe1xuICAgIG51bWJlcjogcyhyLm51bWJlciksXG4gICAgdGl0bGU6IHMoci50aXRsZSksXG4gICAgc3RhdGU6IHMoci5zdGF0ZSkudG9Mb3dlckNhc2UoKSB8fCAnb3BlbicsXG4gICAgdXBkYXRlZEF0OiBzKHIudXBkYXRlZEF0KSxcbiAgICB1cmw6IHMoci51cmwpLFxuICB9KSk7XG59XG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplUmVsZWFzZXMoaG9zdDogRm9yZ2VIb3N0LCByb3dzOiBBbnlSZWNbXSk6IEZvcmdlUmVsZWFzZVtdIHtcbiAgcmV0dXJuIHJvd3MubWFwKChyKSA9PiAoe1xuICAgIHRhZzogcyhob3N0ID09PSAnZ2l0aHViJyA/IHIudGFnTmFtZSA6IHIudGFnKSxcbiAgICBuYW1lOiBzKHIubmFtZSksXG4gICAgY3JlYXRlZEF0OiBzKHIuY3JlYXRlZEF0KSxcbiAgICBpc0RyYWZ0OiBiKHIuaXNEcmFmdCkgfHwgYihyLmRyYWZ0KSxcbiAgICBpc1ByZXJlbGVhc2U6IGIoci5pc1ByZXJlbGVhc2UpIHx8IGIoci5wcmVyZWxlYXNlKSxcbiAgfSkpO1xufVxuXG4vKiAtLS0tIFx1NTQ3RFx1NEVFNFx1NjJGQ1x1ODhDNShcdTdFQUZcdTUxRkRcdTY1NzAsXHU1MzU1XHU2RDRCXHU5NTFBXHU3MEI5KSAtLS0tICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRMaXN0QXJncyhraW5kOiAncmVwb3MnIHwgJ3BycycgfCAnaXNzdWVzJyB8ICdyZWxlYXNlcycsIGhvc3Q6IEZvcmdlSG9zdCwgcmVwbzogc3RyaW5nLCBzdGF0ZTogc3RyaW5nKTogc3RyaW5nW10ge1xuICBpZiAoa2luZCA9PT0gJ3JlcG9zJykge1xuICAgIHJldHVybiBob3N0ID09PSAnZ2l0aHViJ1xuICAgICAgPyBbJ3JlcG8nLCAnbGlzdCcsICctLWxpbWl0JywgU3RyaW5nKExJU1RfTElNSVQpLCAnLS1qc29uJywgJ25hbWUsbmFtZVdpdGhPd25lcixpc1ByaXZhdGUsdXBkYXRlZEF0LHVybCxkZXNjcmlwdGlvbiddXG4gICAgICA6IFsncmVwbycsICdsaXN0JywgJy0tbGltaXQnLCBTdHJpbmcoTElTVF9MSU1JVCksICctLWpzb24nXTtcbiAgfVxuICBpZiAoaG9zdCA9PT0gJ2dpdGh1YicpIHtcbiAgICBjb25zdCBiYXNlID0ga2luZCA9PT0gJ3BycycgPyAncHInIDoga2luZCA9PT0gJ2lzc3VlcycgPyAnaXNzdWUnIDogJ3JlbGVhc2UnO1xuICAgIGlmIChraW5kID09PSAncmVsZWFzZXMnKSByZXR1cm4gWydyZWxlYXNlJywgJ2xpc3QnLCAnLS1yZXBvJywgcmVwbywgJy0tbGltaXQnLCBTdHJpbmcoTElTVF9MSU1JVCksICctLWpzb24nLCAndGFnTmFtZSxuYW1lLGNyZWF0ZWRBdCxpc0RyYWZ0LGlzUHJlcmVsZWFzZSddO1xuICAgIGNvbnN0IGZpZWxkcyA9IGtpbmQgPT09ICdwcnMnID8gJ251bWJlcix0aXRsZSxzdGF0ZSxpc0RyYWZ0LHVwZGF0ZWRBdCx1cmwnIDogJ251bWJlcix0aXRsZSxzdGF0ZSx1cGRhdGVkQXQsdXJsJztcbiAgICByZXR1cm4gW2Jhc2UsICdsaXN0JywgJy0tcmVwbycsIHJlcG8sICctLXN0YXRlJywgc3RhdGUsICctLWxpbWl0JywgU3RyaW5nKExJU1RfTElNSVQpLCAnLS1qc29uJywgZmllbGRzXTtcbiAgfVxuICBpZiAoa2luZCA9PT0gJ3JlbGVhc2VzJykgcmV0dXJuIFsncmVsZWFzZScsICdsaXN0JywgcmVwbywgJy0tanNvbicsICctLWxpbWl0JywgU3RyaW5nKExJU1RfTElNSVQpXTtcbiAgY29uc3QgYmFzZSA9IGtpbmQgPT09ICdwcnMnID8gJ3ByJyA6ICdpc3N1ZSc7XG4gIHJldHVybiBbYmFzZSwgJ2xpc3QnLCByZXBvLCAnLS1zdGF0ZScsIHN0YXRlLCAnLS1qc29uJywgJy0tbGltaXQnLCBTdHJpbmcoTElTVF9MSU1JVCldO1xufVxuXG5leHBvcnQgdHlwZSBGb3JnZUFjdGlvbktpbmQgPSAncHJfY3JlYXRlJyB8ICdwcl9tZXJnZScgfCAnaXNzdWVfY3JlYXRlJyB8ICdyZWxlYXNlX2NyZWF0ZScgfCAncmVsZWFzZV91cGxvYWQnIHwgJ3JlcG9fY2xvbmUnO1xuZXhwb3J0IGludGVyZmFjZSBGb3JnZUFjdGlvbkFyZ3Mge1xuICByZXBvOiBzdHJpbmc7IG51bWJlcj86IHN0cmluZzsgdGl0bGU/OiBzdHJpbmc7IGJvZHk/OiBzdHJpbmc7IGJhc2U/OiBzdHJpbmc7IGhlYWQ/OiBzdHJpbmc7XG4gIHRhZz86IHN0cmluZzsgbmFtZT86IHN0cmluZzsgbm90ZXM/OiBzdHJpbmc7IHByZXJlbGVhc2U/OiBib29sZWFuOyBmaWxlPzogc3RyaW5nOyBkaXI/OiBzdHJpbmc7IG1ldGhvZD86IHN0cmluZztcbn1cblxuLyoqIFx1NTE5OVx1NjRDRFx1NEY1Q1x1NTQ3RFx1NEVFNFx1NjJGQ1x1ODhDNShcdTkwMTAga2luZCBcdTY4MjFcdTlBOEM7XHU4RkQ0XHU1NkRFIG51bGwgPSBcdTUzQzJcdTY1NzBcdTRFMERcdTU0MDhcdTZDRDUpXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRBY3Rpb25BcmdzKGtpbmQ6IEZvcmdlQWN0aW9uS2luZCwgaG9zdDogRm9yZ2VIb3N0LCBhOiBGb3JnZUFjdGlvbkFyZ3MpOiBzdHJpbmdbXSB8IG51bGwge1xuICBjb25zdCBSID0gKHY6IHN0cmluZyB8IHVuZGVmaW5lZCk6IHN0cmluZ1tdID0+IGhvc3QgPT09ICdnaXRodWInID8gWyctLXJlcG8nLCB2ID8/ICcnXSA6IFt2ID8/ICcnXTtcbiAgaWYgKGtpbmQgPT09ICdwcl9jcmVhdGUnKSB7XG4gICAgY29uc3QgdGl0bGUgPSBjaGVja1N0cihhLnRpdGxlLCAzMDApOyBjb25zdCBib2R5ID0gY2hlY2tTdHIoYS5ib2R5LCAyMF8wMDApO1xuICAgIGNvbnN0IGJhc2UgPSBjaGVja1N0cihhLmJhc2UsIDIwMCk7IGNvbnN0IGhlYWQgPSBjaGVja1N0cihhLmhlYWQsIDIwMCk7XG4gICAgaWYgKHRpdGxlID09PSAnJykgcmV0dXJuIG51bGw7XG4gICAgY29uc3QgYXJncyA9IGhvc3QgPT09ICdnaXRodWInXG4gICAgICA/IFsncHInLCAnY3JlYXRlJywgJy0tcmVwbycsIGEucmVwbywgJy0tdGl0bGUnLCB0aXRsZSwgJy0tYm9keScsIGJvZHldXG4gICAgICA6IFsncHInLCAnY3JlYXRlJywgYS5yZXBvLCAnLS10aXRsZScsIHRpdGxlLCAnLS1ib2R5JywgYm9keV07XG4gICAgaWYgKGJhc2UgIT09ICcnKSBhcmdzLnB1c2goJy0tYmFzZScsIGJhc2UpO1xuICAgIGlmIChoZWFkICE9PSAnJykgYXJncy5wdXNoKCctLWhlYWQnLCBoZWFkKTtcbiAgICByZXR1cm4gYXJncztcbiAgfVxuICBpZiAoa2luZCA9PT0gJ3ByX21lcmdlJykge1xuICAgIGNvbnN0IG51bSA9IGNoZWNrU3RyKGEubnVtYmVyLCAyMCkucmVwbGFjZSgvW14wLTldL2csICcnKTtcbiAgICBpZiAobnVtID09PSAnJykgcmV0dXJuIG51bGw7XG4gICAgY29uc3Qgc3F1YXNoID0gYS5tZXRob2QgIT09ICdtZXJnZSc7IC8vIFx1OUVEOFx1OEJBNCBzcXVhc2goXHU0RTBFIGdoIFx1OTc1RVx1NEVBNFx1NEU5Mlx1ODk4MVx1NkM0Mlx1NEUwMFx1ODFGNClcbiAgICByZXR1cm4gaG9zdCA9PT0gJ2dpdGh1YidcbiAgICAgID8gWydwcicsICdtZXJnZScsICctLXJlcG8nLCBhLnJlcG8sIG51bSwgc3F1YXNoID8gJy0tc3F1YXNoJyA6ICctLW1lcmdlJ11cbiAgICAgIDogWydwcicsICdtZXJnZScsIGEucmVwbywgbnVtLCBzcXVhc2ggPyAnLS1zcXVhc2gnIDogJy0tbWVyZ2UnXTtcbiAgfVxuICBpZiAoa2luZCA9PT0gJ2lzc3VlX2NyZWF0ZScpIHtcbiAgICBjb25zdCB0aXRsZSA9IGNoZWNrU3RyKGEudGl0bGUsIDMwMCk7IGNvbnN0IGJvZHkgPSBjaGVja1N0cihhLmJvZHksIDIwXzAwMCk7XG4gICAgaWYgKHRpdGxlID09PSAnJykgcmV0dXJuIG51bGw7XG4gICAgcmV0dXJuIGhvc3QgPT09ICdnaXRodWInXG4gICAgICA/IFsnaXNzdWUnLCAnY3JlYXRlJywgJy0tcmVwbycsIGEucmVwbywgJy0tdGl0bGUnLCB0aXRsZSwgJy0tYm9keScsIGJvZHldXG4gICAgICA6IFsnaXNzdWUnLCAnY3JlYXRlJywgYS5yZXBvLCAnLS10aXRsZScsIHRpdGxlLCAnLS1ib2R5JywgYm9keV07XG4gIH1cbiAgaWYgKGtpbmQgPT09ICdyZWxlYXNlX2NyZWF0ZScpIHtcbiAgICBjb25zdCB0YWcgPSBjaGVja1N0cihhLnRhZywgMTIwKTsgY29uc3QgbmFtZSA9IGNoZWNrU3RyKGEubmFtZSwgMzAwKTtcbiAgICAvLyBhdG9tZ2l0IEFQSSBcdTg5ODFcdTZDNDIgYm9keSBcdTk3NUVcdTdBN0E6XHU2NUUwIG5vdGVzIFx1NjVGNlx1NTZERVx1OTAwMCB0YWcgXHU2NTg3XHU2NzJDXG4gICAgY29uc3Qgbm90ZXMgPSBjaGVja1N0cihhLm5vdGVzLCA2MF8wMDApIHx8IHRhZztcbiAgICBpZiAoIS9eW0EtWmEtejAtOV8uLV0rJC8udGVzdCh0YWcpKSByZXR1cm4gbnVsbDtcbiAgICByZXR1cm4gaG9zdCA9PT0gJ2dpdGh1YidcbiAgICAgID8gWydyZWxlYXNlJywgJ2NyZWF0ZScsIHRhZywgJy0tcmVwbycsIGEucmVwbywgJy0tdGl0bGUnLCBuYW1lIHx8IHRhZywgJy0tbm90ZXMnLCBub3RlcywgLi4uKGEucHJlcmVsZWFzZSA9PT0gdHJ1ZSA/IFsnLS1wcmVyZWxlYXNlJ10gOiBbXSldXG4gICAgICA6IFsncmVsZWFzZScsICdjcmVhdGUnLCBhLnJlcG8sIHRhZywgJy0tbmFtZScsIG5hbWUgfHwgdGFnLCAnLS1ib2R5Jywgbm90ZXMsIC4uLihhLnByZXJlbGVhc2UgPT09IHRydWUgPyBbJy0tcHJlcmVsZWFzZSddIDogW10pXTtcbiAgfVxuICBpZiAoa2luZCA9PT0gJ3JlbGVhc2VfdXBsb2FkJykge1xuICAgIGNvbnN0IHRhZyA9IGNoZWNrU3RyKGEudGFnLCAxMjApOyBjb25zdCBmaWxlID0gY2hlY2tTdHIoYS5maWxlLCAxXzAwMCk7XG4gICAgaWYgKCEvXltBLVphLXowLTlfLi1dKyQvLnRlc3QodGFnKSB8fCBmaWxlID09PSAnJykgcmV0dXJuIG51bGw7XG4gICAgcmV0dXJuIGhvc3QgPT09ICdnaXRodWInXG4gICAgICA/IFsncmVsZWFzZScsICd1cGxvYWQnLCB0YWcsIGZpbGUsICctLXJlcG8nLCBhLnJlcG9dXG4gICAgICA6IFsncmVsZWFzZScsICd1cGxvYWQnLCBhLnJlcG8sIHRhZywgZmlsZV07XG4gIH1cbiAgLy8gcmVwb19jbG9uZTpnaC9hZyBcdTU0MENcdTVGNjIoY2xvbmUgT1dORVIvUkVQTyA8ZGlyPilcbiAgY29uc3QgZGlyID0gY2hlY2tTdHIoYS5kaXIsIDFfMDAwKTtcbiAgaWYgKGRpciA9PT0gJycpIHJldHVybiBudWxsO1xuICByZXR1cm4gWydyZXBvJywgJ2Nsb25lJywgYS5yZXBvLCBkaXJdO1xufVxuXG4vKipcbiAqIFx1NEUwQVx1NEYyMC9cdTUxNEJcdTk2ODZcdTc2ODRcdTY1ODdcdTRFRjZcdThERUZcdTVGODRcdTk1RTg6XHU3RUREXHU1QkY5XHU4REVGXHU1Rjg0ICsgXHU1RkM1XHU5ODdCXHU4NDNEXHU1NzI4XHU3NTI4XHU2MjM3XHU0RTNCXHU3NkVFXHU1RjU1XHU2MjE2XHU1REYyXHU2Q0U4XHU1MThDXHU1REU1XHU0RjVDXHU1MzNBXHU0RTRCXHU0RTBCXHUzMDAyXG4gKiAoXHU5NzYyXHU2NzdGXHU3Njg0XHU4RDQ0XHU0RUE3XHU5MDA5XHU2MkU5XHU1NjY4XHU1M0VBXHU1RTk0XHU3OEIwXHU3NTI4XHU2MjM3XHU4MUVBXHU1REYxXHU3Njg0XHU3NkVFXHU1RjU1O1x1OTYzMlx1NkI2Mlx1NjI4QVx1N0NGQlx1N0VERlx1NjU4N1x1NEVGNlx1NEYyMFx1NEUwQSByZWxlYXNlXHUzMDAyKVxuICovXG5leHBvcnQgZnVuY3Rpb24gdmFsaWRhdGVMb2NhbFBhdGgocDogc3RyaW5nLCBhbGxvd2VkUm9vdHM6IHJlYWRvbmx5IHN0cmluZ1tdKTogYm9vbGVhbiB7XG4gIGlmICghaXNBYnNvbHV0ZShwKSkgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBob21lID0gaG9tZWRpcigpO1xuICBjb25zdCB1bmRlciA9IChyb290OiBzdHJpbmcpOiBib29sZWFuID0+IHtcbiAgICB0cnkgeyBjb25zdCByID0gam9pbihyb290LCAnJyk7IHJldHVybiBwID09PSByIHx8IHAuc3RhcnRzV2l0aChgJHtyfSR7c2VwfWApOyB9IGNhdGNoIHsgcmV0dXJuIGZhbHNlOyB9XG4gIH07XG4gIGlmICh1bmRlcihob21lKSkgcmV0dXJuIHRydWU7XG4gIHJldHVybiBhbGxvd2VkUm9vdHMuc29tZSh1bmRlcik7XG59XG5cbi8qKiBcdTVERTVcdTRGNUNcdTUzM0FcdThERUZcdTVGODQgXHUyMTkyIFx1NUU3M1x1NTNGMFx1NEVEM1x1NUU5Myhvd25lci9yZXBvKTpcdThCRkIgLmdpdC9jb25maWcgXHU3Njg0IHJlbW90ZSB1cmwoaHR0cHMvc3NoIFx1NEUyNFx1NzlDRFx1NTE5OVx1NkNENSlcdTMwMDIgKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlUmVwb09mKHBhdGg6IHN0cmluZyk6IHsgaG9zdDogRm9yZ2VIb3N0OyByZXBvOiBzdHJpbmcgfSB8IG51bGwge1xuICB0cnkge1xuICAgIGNvbnN0IGNmZyA9IHJlYWRGaWxlU3luYyhqb2luKHBhdGgsICcuZ2l0JywgJ2NvbmZpZycpLCAndXRmOCcpO1xuICAgIGNvbnN0IHVybHMgPSBbLi4uY2ZnLm1hdGNoQWxsKC91cmxcXHMqPVxccyooXFxTKykvZyldLm1hcCgobSkgPT4gbVsxXSA/PyAnJyk7XG4gICAgZm9yIChjb25zdCB1IG9mIHVybHMpIHtcbiAgICAgIGNvbnN0IGdoID0gdS5tYXRjaCgvKD86Z2l0aHViXFwuY29tWy86XSkoW0EtWmEtejAtOV8uLV0rXFwvW0EtWmEtejAtOV8uLV0rPykoPzpcXC5naXQpPyQvaSk7XG4gICAgICBpZiAoZ2ggIT09IG51bGwgJiYgKGdoWzFdID8/ICcnKSAhPT0gJycpIHJldHVybiB7IGhvc3Q6ICdnaXRodWInLCByZXBvOiBnaFsxXSA/PyAnJyB9O1xuICAgICAgY29uc3QgYWcgPSB1Lm1hdGNoKC8oPzphdG9tZ2l0XFwuY29tWy86XSkoW0EtWmEtejAtOV8uLV0rXFwvW0EtWmEtejAtOV8uLV0rPykoPzpcXC5naXQpPyQvaSk7XG4gICAgICBpZiAoYWcgIT09IG51bGwgJiYgKGFnWzFdID8/ICcnKSAhPT0gJycpIHJldHVybiB7IGhvc3Q6ICdhdG9tZ2l0JywgcmVwbzogYWdbMV0gPz8gJycgfTtcbiAgICB9XG4gICAgcmV0dXJuIG51bGw7XG4gIH0gY2F0Y2ggeyByZXR1cm4gbnVsbDsgfVxufVxuXG4vKiAtLS0tIGZvcmdlIFx1NjcwRFx1NTJBMVx1NUJGOVx1OEM2MShtYWluIFx1NTM1NVx1NEY4QjtcdTUzNTVcdTZENEJcdTZDRThcdTUxNjUgZGVwcykgLS0tLSAqL1xuZXhwb3J0IGludGVyZmFjZSBGb3JnZU9wdGlvbnMge1xuICAvKiogXHU1REYyXHU2Q0U4XHU1MThDXHU1REU1XHU0RjVDXHU1MzNBXHU2ODM5XHU1MjE3XHU4ODY4KHJlbGVhc2VfdXBsb2FkL3JlcG9fY2xvbmUgXHU3Njg0XHU4REVGXHU1Rjg0XHU5NUU4ICsgXHU5NzYyXHU2NzdGXHU0RTBBXHU0RTBCXHU2NTg3KVx1MzAwMiAqL1xuICBhbGxvd2VkUm9vdHM/OiAoKSA9PiBzdHJpbmdbXTtcbiAgLyoqIFx1NzY3Qlx1NUY1NVx1NkQ0MVx1N0EwQlx1ODg0Q1x1OEY2Q1x1NTNEMSArIFVSTCBcdTU5MTZcdTVGMDAodWl2ZXJpZnkvXHU1MzU1XHU2RDRCXHU1M0VGXHU5NzU5XHU5RUQ4KVx1MzAwMiAqL1xuICBvbkxvZ2luTGluZT86IChob3N0OiBGb3JnZUhvc3QsIGxpbmU6IHN0cmluZykgPT4gdm9pZDtcbiAgb3BlbkV4dGVybmFsPzogKHVybDogc3RyaW5nKSA9PiB2b2lkO1xufVxuXG5jb25zdCBiYWQgPSAoY29kZTogc3RyaW5nLCBlcnJvcjogc3RyaW5nKTogeyBvazogZmFsc2U7IGNvZGU6IHN0cmluZzsgZXJyb3I6IHN0cmluZyB9ID0+ICh7IG9rOiBmYWxzZSwgY29kZSwgZXJyb3I6IGVycm9yLnNsaWNlKDAsIDMwMCkgfSk7XG5jb25zdCBvayA9IDxUPihkYXRhOiBUKTogRm9yZ2VPazxUPiA9PiAoeyBvazogdHJ1ZSwgZGF0YSB9KTtcblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZUZvcmdlKGRlcHM6IEZvcmdlRGVwcyA9IGRlZmF1bHREZXBzLCBvcHRzOiBGb3JnZU9wdGlvbnMgPSB7fSk6IEZvcmdlU2VydmljZSB7XG4gIGNvbnN0IHJvb3RzID0gKCk6IHN0cmluZ1tdID0+IChvcHRzLmFsbG93ZWRSb290cz8uKCkgPz8gW10pLmZpbHRlcigocikgPT4gdHlwZW9mIHIgPT09ICdzdHJpbmcnICYmIHIgIT09ICcnKTtcblxuICAvKiogXHU1RjUyXHU0RTAwIENMSSBcdTdFRDNcdTY3OUM6XHU4RDg1XHU2NUY2L1x1OTc1RVx1OTZGNlx1OTAwMFx1NTFGQS9cdTU3NEYgSlNPTiBcdTIxOTIgXHU3RUQzXHU2Nzg0XHU1MzE2XHU5NTE5XHU4QkVGXHUzMDAyICovXG4gIGFzeW5jIGZ1bmN0aW9uIGNsaUpzb248VD4oaG9zdDogRm9yZ2VIb3N0LCBhcmdzOiBzdHJpbmdbXSwgbm9ybWFsaXplcjogKHJvd3M6IEFueVJlY1tdKSA9PiBUKTogUHJvbWlzZTxGb3JnZU9rPFQ+PiB7XG4gICAgY29uc3QgciA9IGF3YWl0IGRlcHMucnVuKENMSV9CSU5baG9zdF0sIGFyZ3MsIENNRF9USU1FT1VUX01TKTtcbiAgICBpZiAoci50aW1lZE91dCkgcmV0dXJuIGJhZCgnVElNRU9VVCcsIGAke0NMSV9CSU5baG9zdF19ICR7YXJnc1swXX0gXHU4RDg1XHU2NUY2KCR7TWF0aC5yb3VuZChDTURfVElNRU9VVF9NUyAvIDEwMDApfXMpYCk7XG4gICAgaWYgKHIuY29kZSAhPT0gMCkgcmV0dXJuIGJhZCgnQ0xJX0VSUk9SJywgYCR7Q0xJX0JJTltob3N0XX0gJHthcmdzLnNsaWNlKDAsIDMpLmpvaW4oJyAnKX0gXHU1OTMxXHU4RDI1KCR7ci5jb2RlfSk6JHsoci5zdGRlcnIgfHwgci5zdGRvdXQpLnRyaW0oKS5zcGxpdCgnXFxuJykuc2xpY2UoLTMpLmpvaW4oJyAnKX1gKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShyLnN0ZG91dCkgYXMgdW5rbm93bjtcbiAgICAgIGlmICghQXJyYXkuaXNBcnJheShwYXJzZWQpKSByZXR1cm4gYmFkKCdCQURfSlNPTicsICdDTEkgXHU4RjkzXHU1MUZBXHU5NzVFIEpTT04gXHU2NTcwXHU3RUM0Jyk7XG4gICAgICByZXR1cm4gb2sobm9ybWFsaXplcihwYXJzZWQgYXMgQW55UmVjW10pKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiBiYWQoJ0JBRF9KU09OJywgJ0NMSSBcdThGOTNcdTUxRkFcdTY1RTBcdTZDRDVcdTg5RTNcdTY3OTBcdTRFM0EgSlNPTicpO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiB7XG4gICAgYXN5bmMgc3RhdHVzKCk6IFByb21pc2U8Rm9yZ2VTdGF0dXM+IHtcbiAgICAgIGNvbnN0IG9uZSA9IGFzeW5jIChob3N0OiBGb3JnZUhvc3QpOiBQcm9taXNlPEZvcmdlSG9zdFN0YXR1cz4gPT4ge1xuICAgICAgICBpZiAoZGVwcy53aGljaChDTElfQklOW2hvc3RdKSA9PT0gJycpIHJldHVybiB7IGluc3RhbGxlZDogZmFsc2UsIGxvZ2dlZDogZmFsc2UsIHVzZXI6ICcnIH07XG4gICAgICAgIGNvbnN0IHIgPSBhd2FpdCBkZXBzLnJ1bihDTElfQklOW2hvc3RdLCBbJ2F1dGgnLCAnc3RhdHVzJ10sIDE1XzAwMCk7XG4gICAgICAgIHJldHVybiBwYXJzZUF1dGhTdGF0dXMoaG9zdCwgci5zdGRvdXQsIHIuc3RkZXJyLCByLmNvZGUpO1xuICAgICAgfTtcbiAgICAgIGNvbnN0IFtnaXRodWIsIGF0b21naXRdID0gYXdhaXQgUHJvbWlzZS5hbGwoSE9TVFMubWFwKG9uZSkgYXMgW1Byb21pc2U8Rm9yZ2VIb3N0U3RhdHVzPiwgUHJvbWlzZTxGb3JnZUhvc3RTdGF0dXM+XSk7XG4gICAgICByZXR1cm4geyBnaXRodWIsIGF0b21naXQgfTtcbiAgICB9LFxuXG4gICAgcmVwb3M6IGFzeW5jIChob3N0LCBwYWdlKSA9PlxuICAgICAgY2xpSnNvbihob3N0LCBidWlsZExpc3RBcmdzKCdyZXBvcycsIGhvc3QsICcnLCAnb3BlbicpLCAocm93cykgPT4ge1xuICAgICAgICBjb25zdCBhbGwgPSBub3JtYWxpemVSZXBvcyhob3N0LCByb3dzKTtcbiAgICAgICAgY29uc3QgcCA9IE1hdGgubWF4KDEsIE1hdGgubWluKDIwLCBwYWdlKSk7XG4gICAgICAgIHJldHVybiB7IHJlcG9zOiBhbGwuc2xpY2UoKHAgLSAxKSAqIFBBR0VfU0laRSwgcCAqIFBBR0VfU0laRSksIGhhc01vcmU6IGFsbC5sZW5ndGggPiBwICogUEFHRV9TSVpFIH07XG4gICAgICB9KSxcblxuICAgIHByczogKGhvc3QsIHJlcG8sIHN0YXRlKSA9PiBjbGlKc29uKGhvc3QsIGJ1aWxkTGlzdEFyZ3MoJ3BycycsIGhvc3QsIHJlcG8sIHN0YXRlKSwgKHJvd3MpID0+ICh7IHByczogbm9ybWFsaXplUHJzKHJvd3MpIH0pKSxcbiAgICBpc3N1ZXM6IChob3N0LCByZXBvLCBzdGF0ZSkgPT4gY2xpSnNvbihob3N0LCBidWlsZExpc3RBcmdzKCdpc3N1ZXMnLCBob3N0LCByZXBvLCBzdGF0ZSksIChyb3dzKSA9PiAoeyBpc3N1ZXM6IG5vcm1hbGl6ZUlzc3Vlcyhyb3dzKSB9KSksXG4gICAgcmVsZWFzZXM6IChob3N0LCByZXBvKSA9PiBjbGlKc29uKGhvc3QsIGJ1aWxkTGlzdEFyZ3MoJ3JlbGVhc2VzJywgaG9zdCwgcmVwbywgJ29wZW4nKSwgKHJvd3MpID0+ICh7IHJlbGVhc2VzOiBub3JtYWxpemVSZWxlYXNlcyhob3N0LCByb3dzKSB9KSksXG5cbiAgICBhc3luYyBhY3Rpb24oa2luZCwgaG9zdCwgYSk6IFByb21pc2U8Rm9yZ2VPazx7IHVybDogc3RyaW5nIH0+PiB7XG4gICAgICBjb25zdCBhcmdzID0gYnVpbGRBY3Rpb25BcmdzKGtpbmQsIGhvc3QsIGEpO1xuICAgICAgaWYgKGFyZ3MgPT09IG51bGwpIHJldHVybiBiYWQoJ0JBRF9SRVFVRVNUJywgYFx1NTE5OVx1NjRDRFx1NEY1QyAke2tpbmR9IFx1NTNDMlx1NjU3MFx1NEUwRFx1NTQwOFx1NkNENWApO1xuICAgICAgLy8gXHU4REVGXHU1Rjg0XHU5NUU4OnVwbG9hZC9jbG9uZSBcdTc2ODRcdTY3MkNcdTU3MzBcdThERUZcdTVGODRcdTVGQzVcdTk4N0JcdTU3MjhcdTVERTVcdTRGNUNcdTUzM0EvXHU3NTI4XHU2MjM3XHU3NkVFXHU1RjU1XHU1MTg1XHU0RTE0XHU1QjU4XHU1NzI4XG4gICAgICBpZiAoKGtpbmQgPT09ICdyZWxlYXNlX3VwbG9hZCcgfHwga2luZCA9PT0gJ3JlcG9fY2xvbmUnKSAmJiAhdmFsaWRhdGVMb2NhbFBhdGgoYS5maWxlID8/IGEuZGlyID8/ICcnLCByb290cygpKSkge1xuICAgICAgICByZXR1cm4gYmFkKCdCQURfUkVRVUVTVCcsICdcdTY1ODdcdTRFRjZcdThERUZcdTVGODRcdTVGQzVcdTk4N0JcdTRGNERcdTRFOEVcdTc1MjhcdTYyMzdcdTc2RUVcdTVGNTVcdTYyMTZcdTVERjJcdTZDRThcdTUxOENcdTVERTVcdTRGNUNcdTUzM0FcdTUxODUnKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHIgPSBhd2FpdCBkZXBzLnJ1bihDTElfQklOW2hvc3RdLCBhcmdzLmZpbHRlcigoeCkgPT4geCAhPT0gJycpLCBDTURfVElNRU9VVF9NUyk7XG4gICAgICBpZiAoci50aW1lZE91dCkgcmV0dXJuIGJhZCgnVElNRU9VVCcsIGAke0NMSV9CSU5baG9zdF19ICR7a2luZH0gXHU4RDg1XHU2NUY2YCk7XG4gICAgICBpZiAoci5jb2RlICE9PSAwKSByZXR1cm4gYmFkKCdDTElfRVJST1InLCBgJHtraW5kfSBcdTU5MzFcdThEMjUoJHtyLmNvZGV9KTokeyhyLnN0ZGVyciB8fCByLnN0ZG91dCkudHJpbSgpLnNwbGl0KCdcXG4nKS5zbGljZSgtMykuam9pbignICcpfWApO1xuICAgICAgcmV0dXJuIG9rKHsgdXJsOiBleHRyYWN0VXJsKGAke3Iuc3Rkb3V0fVxcbiR7ci5zdGRlcnJ9YCkgfSk7XG4gICAgfSxcblxuICAgIC8qKiBcdTc2N0JcdTVGNTU6c3Bhd24gXHU1Qjk4XHU2NUI5IE9BdXRoIFx1NkQ0MVx1N0EwQixzdGRvdXQgXHU4ODRDXHU4RjZDXHU1M0QxICsgVVJMIFx1NTkxNlx1NUYwMDtcdTRFMERcdTYzNTVcdTgzQjdcdTRFRkJcdTRGNTVcdTRFRTRcdTcyNENcdTMwMDIgKi9cbiAgICBhc3luYyBsb2dpbihob3N0KTogUHJvbWlzZTxGb3JnZU9rPHsgdXJsOiBzdHJpbmcgfT4+IHtcbiAgICAgIGNvbnN0IGFyZ3MgPSBob3N0ID09PSAnZ2l0aHViJyA/IFsnYXV0aCcsICdsb2dpbicsICctLXdlYicsICctLWdpdC1wcm90b2NvbCcsICdodHRwcycsICctLXNraXAtc3NoLWtleSddIDogWydhdXRoJywgJ2xvZ2luJ107XG4gICAgICBsZXQgb3BlbmVkID0gJyc7XG4gICAgICBjb25zdCByID0gYXdhaXQgZGVwcy5ydW4oQ0xJX0JJTltob3N0XSwgYXJncywgTE9HSU5fVElNRU9VVF9NUywgKGxpbmUpID0+IHtcbiAgICAgICAgb3B0cy5vbkxvZ2luTGluZT8uKGhvc3QsIGxpbmUpO1xuICAgICAgICBjb25zdCB1cmwgPSBleHRyYWN0VXJsKGxpbmUpO1xuICAgICAgICAvLyBcdTdCMkNcdTRFMDBcdTRFMkEgVVJMID0gXHU4QkJFXHU1OTA3XHU2Mzg4XHU2NzQzXHU5ODc1Olx1ODFFQVx1NTJBOFx1NTkxNlx1NUYwMChcdTRFRkJcdTUyQTFcdTRFNjY6XHU1OTE2XHU1RjAwXHU3Q0ZCXHU3RURGXHU2RDRGXHU4OUM4XHU1NjY4KTtcdTU0MEVcdTdFRURcdTg4NENcdTUzRUFcdTVDNTVcdTc5M0FcbiAgICAgICAgaWYgKHVybCAhPT0gJycgJiYgb3BlbmVkID09PSAnJykgeyBvcGVuZWQgPSB1cmw7IG9wdHMub3BlbkV4dGVybmFsPy4odXJsKTsgfVxuICAgICAgfSk7XG4gICAgICBpZiAoci50aW1lZE91dCkgcmV0dXJuIGJhZCgnVElNRU9VVCcsIGBcdTc2N0JcdTVGNTVcdThEODVcdTY1RjYoJHtNYXRoLnJvdW5kKExPR0lOX1RJTUVPVVRfTVMgLyA2MF8wMDApfSBcdTUyMDZcdTk0OUYpYCk7XG4gICAgICAvLyBcdTkwMDBcdTUxRkFcdTc4MDFcdTk3NUUgMCBcdTRFMERcdTRFMDBcdTVCOUFcdTU5MzFcdThEMjUoXHU3NTI4XHU2MjM3IEN0cmwtQyk7XHU0RUU1XHU0RThCXHU1NDBFXHU3Njg0IGZvcmdlOnN0YXR1cyBcdThGNkVcdThCRTJcdTRFM0FcdTUxQzZcbiAgICAgIHJldHVybiBvayh7IHVybDogb3BlbmVkIH0pO1xuICAgIH0sXG5cbiAgICByZXNvbHZlKHBhdGgpIHtcbiAgICAgIGNvbnN0IHAgPSBjaGVja1N0cihwYXRoLCAxXzAwMCk7XG4gICAgICBpZiAocCA9PT0gJycgfHwgIWV4aXN0c1N5bmMocCkpIHJldHVybiBudWxsO1xuICAgICAgcmV0dXJuIHJlc29sdmVSZXBvT2YocCk7XG4gICAgfSxcbiAgfTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBGb3JnZVNlcnZpY2Uge1xuICBzdGF0dXMoKTogUHJvbWlzZTxGb3JnZVN0YXR1cz47XG4gIHJlcG9zKGhvc3Q6IEZvcmdlSG9zdCwgcGFnZTogbnVtYmVyKTogUHJvbWlzZTxGb3JnZU9rPHsgcmVwb3M6IEZvcmdlUmVwb1tdOyBoYXNNb3JlOiBib29sZWFuIH0+PjtcbiAgcHJzKGhvc3Q6IEZvcmdlSG9zdCwgcmVwbzogc3RyaW5nLCBzdGF0ZTogc3RyaW5nKTogUHJvbWlzZTxGb3JnZU9rPHsgcHJzOiBGb3JnZVByW10gfT4+O1xuICBpc3N1ZXMoaG9zdDogRm9yZ2VIb3N0LCByZXBvOiBzdHJpbmcsIHN0YXRlOiBzdHJpbmcpOiBQcm9taXNlPEZvcmdlT2s8eyBpc3N1ZXM6IEZvcmdlSXNzdWVbXSB9Pj47XG4gIHJlbGVhc2VzKGhvc3Q6IEZvcmdlSG9zdCwgcmVwbzogc3RyaW5nKTogUHJvbWlzZTxGb3JnZU9rPHsgcmVsZWFzZXM6IEZvcmdlUmVsZWFzZVtdIH0+PjtcbiAgYWN0aW9uKGtpbmQ6IEZvcmdlQWN0aW9uS2luZCwgaG9zdDogRm9yZ2VIb3N0LCBhOiBGb3JnZUFjdGlvbkFyZ3MpOiBQcm9taXNlPEZvcmdlT2s8eyB1cmw6IHN0cmluZyB9Pj47XG4gIGxvZ2luKGhvc3Q6IEZvcmdlSG9zdCk6IFByb21pc2U8Rm9yZ2VPazx7IHVybDogc3RyaW5nIH0+PjtcbiAgcmVzb2x2ZShwYXRoOiBzdHJpbmcpOiB7IGhvc3Q6IEZvcmdlSG9zdDsgcmVwbzogc3RyaW5nIH0gfCBudWxsO1xufVxuXG4vKiAtLS0tIFVJVkVSSUZZIGZpeHR1cmVzKGZha2UgXHU2NTcwXHU2MzZFXHU2Q0U4XHU1MTY1O1x1NEUwRFx1NzhCMFx1NzhDMVx1NzZEOC9cdTdGNTFcdTdFREMvXHU1MUVEXHU2MzZFKSAtLS0tICovXG5leHBvcnQgZnVuY3Rpb24gZm9yZ2VGaXh0dXJlcygpIHtcbiAgcmV0dXJuIHtcbiAgICBzdGF0dXM6IHtcbiAgICAgIGdpdGh1YjogeyBpbnN0YWxsZWQ6IHRydWUsIGxvZ2dlZDogdHJ1ZSwgdXNlcjogJ3N3c2dibCcgfSxcbiAgICAgIC8vIFx1NjVFMCBDTEkgXHU2MzA3XHU1RjE1XHU2MDAxOmF0b21naXQgXHU1MzYxXHU1QzU1XHU3OTNBXHU1Qjg5XHU4OEM1XHU2MzA3XHU1RjE1KFx1NTM1NVx1NkQ0Qlx1NjVBRFx1OEEwMFwiXHU0RTBEXHU4MUVBXHU1MkE4XHU4OEM1XCIpXG4gICAgICBhdG9tZ2l0OiB7IGluc3RhbGxlZDogZmFsc2UsIGxvZ2dlZDogZmFsc2UsIHVzZXI6ICcnIH0sXG4gICAgfSBzYXRpc2ZpZXMgRm9yZ2VTdGF0dXMsXG4gICAgcmVwb3M6IChob3N0OiBGb3JnZUhvc3QpOiB7IHJlcG9zOiBGb3JnZVJlcG9bXTsgaGFzTW9yZTogYm9vbGVhbiB9ID0+ICh7XG4gICAgICByZXBvczogaG9zdCA9PT0gJ2dpdGh1YidcbiAgICAgICAgPyBbXG4gICAgICAgICAgICB7IG5hbWU6ICdobWgtZGVza3RvcCcsIGZ1bGxOYW1lOiAnc3dzZ2JsL2htaC1kZXNrdG9wJywgaXNQcml2YXRlOiBmYWxzZSwgdXBkYXRlZEF0OiAnMjAyNi0xMC0yOVQyMzo0MTowNFonLCB1cmw6ICdodHRwczovL2dpdGh1Yi5jb20vc3dzZ2JsL2htaC1kZXNrdG9wJywgZGVzY3JpcHRpb246ICdITUggRGVza3RvcChtb25vcmVwbyknIH0sXG4gICAgICAgICAgICB7IG5hbWU6ICdhaS1sZWFybmluZy1vcycsIGZ1bGxOYW1lOiAnc3dzZ2JsL2FpLWxlYXJuaW5nLW9zJywgaXNQcml2YXRlOiB0cnVlLCB1cGRhdGVkQXQ6ICcyMDI2LTEwLTI5VDE1OjI5OjUyWicsIHVybDogJ2h0dHBzOi8vZ2l0aHViLmNvbS9zd3NnYmwvYWktbGVhcm5pbmctb3MnLCBkZXNjcmlwdGlvbjogJ0FJIGxlYXJuaW5nIE9TJyB9LFxuICAgICAgICAgIF1cbiAgICAgICAgOiBbXG4gICAgICAgICAgICB7IG5hbWU6ICdobWgtZGVza3RvcCcsIGZ1bGxOYW1lOiAnaG9uZ2Z1L2htaC1kZXNrdG9wJywgaXNQcml2YXRlOiBmYWxzZSwgdXBkYXRlZEF0OiAnMjAyNi0xMC0yOVQyMjo0MTo0OSswODowMCcsIHVybDogJ2h0dHBzOi8vYXRvbWdpdC5jb20vaG9uZ2Z1L2htaC1kZXNrdG9wJywgZGVzY3JpcHRpb246ICdITUggRGVza3RvcChhdG9tZ2l0IFx1OTU1Q1x1NTBDRlx1NEVEMyknIH0sXG4gICAgICAgICAgXSxcbiAgICAgIGhhc01vcmU6IGZhbHNlLFxuICAgIH0pLFxuICAgIHByczogeyBwcnM6IFt7IG51bWJlcjogJzExJywgdGl0bGU6ICdmZWF0KGRlc2t0b3ApOiBcdTRFRDNcdTVFOTNcdTk3NjJcdTY3N0YoXHU5QThDXHU2NTM2IGZpeHR1cmUpJywgc3RhdGU6ICdvcGVuJywgaXNEcmFmdDogZmFsc2UsIHVwZGF0ZWRBdDogJzIwMjYtMTAtMzBUMDk6MDA6MDBaJywgdXJsOiAnaHR0cHM6Ly9naXRodWIuY29tL3N3c2dibC9obWgtZGVza3RvcC9wdWxsLzExJyB9XSB9LFxuICAgIGlzc3VlczogeyBpc3N1ZXM6IFt7IG51bWJlcjogJzQnLCB0aXRsZTogJ1x1NEVEM1x1NUU5M1x1OTc2Mlx1Njc3Rlx1OUE4Q1x1NjUzNiBmaXh0dXJlIGlzc3VlJywgc3RhdGU6ICdvcGVuJywgdXBkYXRlZEF0OiAnMjAyNi0xMC0zMFQwOTowMDowMFonLCB1cmw6ICdodHRwczovL2dpdGh1Yi5jb20vc3dzZ2JsL2htaC1kZXNrdG9wL2lzc3Vlcy80JyB9XSB9LFxuICAgIHJlbGVhc2VzOiB7IHJlbGVhc2VzOiBbeyB0YWc6ICd2MC4yLjEwJywgbmFtZTogJ3YwLjIuMTAgXHUyMDE0IFx1NjZGNFx1NjVCMFx1NTY2OCBhdG9tZ2l0IFx1NTZGRFx1NTE4NVx1OTk5Nlx1OTAwOStcdTU0MEVcdTUzRjBcdTk3NTlcdTlFRDhcdTY2RjRcdTY1QjAnLCBjcmVhdGVkQXQ6ICcyMDI2LTEwLTI5VDIzOjM3OjA5KzA4OjAwJywgaXNEcmFmdDogZmFsc2UsIGlzUHJlcmVsZWFzZTogZmFsc2UgfV0gfSxcbiAgICBhY3Rpb246IHsgb2s6IHRydWUgYXMgY29uc3QsIGRhdGE6IHsgdXJsOiAnaHR0cHM6Ly9leGFtcGxlLmludmFsaWQvZm9yZ2UtZml4dHVyZScgfSB9LFxuICAgIGxvZ2luOiB7IG9rOiB0cnVlIGFzIGNvbnN0LCBkYXRhOiB7IHVybDogJ2h0dHBzOi8vZXhhbXBsZS5pbnZhbGlkL2ZvcmdlLWxvZ2luLWZpeHR1cmUnIH0gfSxcbiAgICByZXNvbHZlOiB7IGhvc3Q6ICdnaXRodWInIGFzIEZvcmdlSG9zdCwgcmVwbzogJ3N3c2dibC9obWgtZGVza3RvcCcgfSxcbiAgfTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICI7QUFjQSxTQUFTLE9BQUFBLE1BQUssZUFBZSxRQUFRLFNBQVMsU0FBUyxPQUFPLE1BQU0sY0FBYyxNQUFNLGFBQWEsbUJBQW1CO0FBQ3hILFNBQVMsUUFBQUMsT0FBTSxXQUFBQyxVQUFTLFVBQVUsY0FBQUMsYUFBWSxlQUFlO0FBQzdELFNBQVMsY0FBQUMsYUFBWSxnQkFBQUMsZUFBYyxnQkFBQUMscUJBQW9CO0FBQ3ZELFNBQVMseUJBQXlCO0FBQ2xDLFNBQVMsYUFBQUMsWUFBVyxVQUFVLE1BQU0sY0FBYztBQUNsRCxTQUFTLFdBQUFDLFVBQVMseUJBQXlCO0FBQzNDLFNBQVMsZ0JBQUFDLGVBQWMsU0FBQUMsY0FBYTtBQUNwQyxTQUFTLGlCQUFBQyxzQkFBcUI7OztBQ1g5QixTQUFTLGFBQWdDO0FBQ3pDLFNBQVMs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Q2hCLFdBQUssV0FBVyxLQUFLLEVBQUUsUUFBUSxNQUFNQSxLQUFJLEtBQUssQ0FBQztBQUFBLElBQ2pEO0FBQUEsRUFDRixDQUFDO0FBQ0QsRUFBQUEsS0FBSSxHQUFHLHFCQUFxQixNQUFNO0FBQ2hDLFFBQUksUUFBUSxhQUFhLFNBQVUsQ0FBQUEsS0FBSSxLQUFLO0FBQUEsRUFDOUMsQ0FBQztBQUNIO0FBaGtEVztBQXlCQTtBQU9BO0FBZUE7QUE0QkE7QUE4SkE7QUFzQkE7QUE0QkE7QUE0REE7QUFVQTtBQWdCQTtBQWdCQTtBQWVBO0FBMkVBO0FBT0E7QUFRQTtBQVdBO0FBa0VBO0FBS0E7QUFpQkE7QUFLQTtBQVlBO0FBb0JBO0FBb0hBO0FBWUE7QUErQkE7QUFpQkE7IiwKICAibmFtZXMiOiBbImFwcCIsICJqb2luIiwgImRpcm5hbWUiLCAiaXNBYnNvbHV0ZSIsICJleGlzdHNTeW5jIiwgInJlYWxwYXRoU3luYyIsICJyZWFkRmlsZVN5bmMiLCAid3JpdGVGaWxlIiwgImhvbWVkaXIiLCAiZXhlY0ZpbGVTeW5jIiwgInNwYXduIiwgInBhdGhUb0ZpbGVVUkwiLCAicyIsICJyZXNvbHZlIiwgInJhbmRvbVVVSUQiLCAicmFuZG9tVVVJRCIsICJzIiwgInJlc29sdmUiLCAiYiIsICJvayIsICJhcHAiLCAibWtkaXIiLCAid3JpdGVGaWxlIiwgImpvaW4iLCAic2xlZXAiLCAic3Bhd24iLCAiam9pbiIsICJiIiwgInMiLCAiam9pbiIsICJvayIsICJyZXNvbHZlIiwgInNwYXduIiwgImpvaW4iLCAiYiIsICJzIiwgImIiLCAic3Bhd24iLCAiZXhpc3RzU3luYyIsICJob21lZGlyIiwgImpvaW4iLCAicmVzb2x2ZSIsICJiYXNlIiwgImpvaW4iLCAicyIsICJhcHAiLCAicHVzaEV2ZW50IiwgIm5vdGlmeUV2ZW50IiwgImZvY3VzTWFpbldpbmRvdyIsICJzZXR1cFRyYXkiLCAiYXBwbHlDaHJvbWUiLCAiYXBwbHlVcGRhdGUiLCAiZGlybmFtZSIsICJzcGF3biIsICJidWlsZEFwcE1lbnUiLCAicG9wdXBNYWluTWVudSIsICJ3ZWJBdXRvc3RhcnRJbnN0YWxsZWQiLCAiZXhpc3RzU3luYyIsICJsYW5JcE9mIiwgImNsaUVudHJ5T2YiLCAicmVwb1Jvb3RPZiIsICJwa2dOYW1lQXQiLCAicnVuQ2xpIiwgImJyb2FkY2FzdEhvc3RTdGF0ZSIsICJwa2dWZXJzaW9uQXQiLCAicmVhZEZpbGVTeW5jIiwgImVudHJ5RnJvbUNsaURpciIsICJkZXRlY3RFeHRlcm5hbFJ1bnRpbWUiLCAiaXNBYnNvbHV0ZSIsICJleGVjRmlsZVN5bmMiLCAicmVhbHBhdGhTeW5jIiwgImhvbWVkaXIiLCAiZGV0ZWN0UmVhbEVudHJ5IiwgImJ1bmRsZWRSdW50aW1lUGF0aCIsICJidW5kbGVkUnVudGltZUluZm8iLCAibnBtT25QYXRoIiwgIndpemFyZFN1cHByZXNzZWQiLCAic2VuZGVyVHJ1c3RlZCIsICJob3N0Q2FsbCIsICJmb3JnZVN2YyIsICJyZWdpc3RlcklwYyIsICJ3cml0ZUZpbGUiLCAidyIsICJwYXRoVG9GaWxlVVJMIiwgIm9rIiwgImFwcDIiXQp9Cg==
