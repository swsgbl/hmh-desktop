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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vZWxlY3Ryb24vbWFpbi9pbmRleC50cyIsICIuLi8uLi8uLi8uLi9wYWNrYWdlcy9ob3N0LWFkYXB0ZXIvc3JjL3N1cGVydmlzb3IudHMiLCAiLi4vLi4vLi4vLi4vcGFja2FnZXMvY29udHJhY3RzL3NyYy9ldmVudC50cyIsICIuLi8uLi8uLi8uLi9wYWNrYWdlcy9jb250cmFjdHMvc3JjL2Vycm9yLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2NvbnRyYWN0cy9zcmMvZ3VhcmRzLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2hvc3QtYWRhcHRlci9zcmMvY2xpZW50LnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2hvc3QtYWRhcHRlci9zcmMvZmFrZS1ob3N0LnRzIiwgIi4uLy4uL2VsZWN0cm9uL21haW4vdWl2ZXJpZnkudHMiLCAiLi4vLi4vZWxlY3Ryb24vbWFpbi9pbnN0YWxsZXIudHMiLCAiLi4vLi4vLi4vLi4vcGFja2FnZXMvY2xpLWluc3RhbGxlci9zcmMvaW5kZXgudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxyXG4gKiBITUggRGVza3RvcCBcdTIwMTQgRWxlY3Ryb24gXHU0RTNCXHU4RkRCXHU3QTBCKEFEUi0wMDEvMDAzLzAwNClcdTMwMDJcclxuICpcclxuICogXHU1Qjg5XHU1MTY4XHU0RTBEXHU1M0Q4XHU5MUNGKFx1NUYwMFx1NTNEMVx1OEJBMVx1NTIxMiBNMCBcdTUxRkFcdTUzRTNcdTk1RTggKyBFbGVjdHJvbiBcdTVCOThcdTY1QjlcdTVCODlcdTUxNjhcdTZFMDVcdTUzNTUpOlxyXG4gKiAgLSByZW5kZXJlcjpjb250ZXh0SXNvbGF0aW9uICsgc2FuZGJveCArIFx1Nzk4MSBub2RlSW50ZWdyYXRpb24sXHU0RTI1XHU2ODNDIENTUDtcclxuICogIC0gXHU1QkZDXHU4MjJBL1x1NjVCMFx1N0E5N1x1NTNFM1x1NEUwMFx1NUY4Qlx1NjJEMlx1N0VERChcdTUzRUFcdTUyQTBcdThGN0RcdTYyMTFcdTRFRUNcdTgxRUFcdTVERjFcdTc2ODQgcmVuZGVyZXIpO1xyXG4gKiAgLSBcdTZCQ0ZcdTY3NjEgSVBDIFx1NjgyMVx1OUE4QyBzZW5kZXIgXHU3Njg0XHU5ODc2XHU1QzQyIGZyYW1lIFVSTCBcdTVDNUVcdTRFOEVcdTY3MkNcdTVFOTRcdTc1MjgsXHU5MDFBXHU5MDUzXHU3NjdEXHU1NDBEXHU1MzU1O1xyXG4gKiAgLSBob3N0IHRva2VuIFx1NTNFQVx1NUI1OFx1NTcyOFx1NEU4RVx1NjcyQ1x1OEZEQlx1N0EwQlx1NEUwRVx1NUI1MFx1OEZEQlx1N0EwQiBlbnYsXHU2NUU1XHU1RkQ3XHU4RjkzXHU1MUZBXHU1MjREXHU1MTQ4XHU4MTMxXHU2NTRGO1xyXG4gKiAgLSBcdTUzNTVcdTVCOUVcdTRGOEJcdTk1MDE7XHU5MDAwXHU1MUZBXHU2NUY2XHU1M0VBXHU1MDVDXHU2QjYyXHU4MUVBXHU1REYxIHNwYXduIFx1NzY4NCBob3N0KFx1NEYxOFx1OTZDNVx1MjE5Mlx1NTE1Q1x1NUU5NSBraWxsKVx1MzAwMlxyXG4gKlxyXG4gKiBcdTk2MzZcdTZCQjVFKDIwMjYtMTAtMTApOm1haW4gXHU2MzAxXHU2NzA5IERlc2t0b3BIb3N0Q2xpZW50LFNTRSBcdTRGRTFcdTVDMDFcdTZENDEoZXZlbnQ6IGhtaClcclxuICogXHU3RUNGIDUwbXMgXHU2Mjc5XHU5MUNGXHU2M0E4XHU3RUQ5IHJlbmRlcmVyO3NlbmRUYXNrL2FwcHJvdmUvaW50ZXJydXB0L3Nlc3Npb25zIFx1NTE2OFx1OTBFOFx1OEY2Q1x1NTNEMVxyXG4gKiBcdTdFRDkgaG9zdCBcdTIwMTRcdTIwMTQgZmFrZSBcdTRFMEVcdTc3MUZcdTVCOUUgaG1oYXJuZXNzIGRlc2t0b3AtaG9zdCBcdThENzBcdTU0MENcdTRFMDBcdTY3NjFcdTRFRTNcdTc4MDFcdThERUZcdTVGODRcdTMwMDJcclxuICovXHJcbmltcG9ydCB7IGFwcCwgQnJvd3NlcldpbmRvdywgZGlhbG9nLCBpcGNNYWluLCBzZXNzaW9uLCBzaGVsbCwgVHJheSwgTm90aWZpY2F0aW9uLCBNZW51LCBuYXRpdmVJbWFnZSwgbmF0aXZlVGhlbWUgfSBmcm9tICdlbGVjdHJvbic7XHJcbmltcG9ydCB7IGpvaW4sIGRpcm5hbWUsIGJhc2VuYW1lLCBpc0Fic29sdXRlLCByZXNvbHZlIH0gZnJvbSAnbm9kZTpwYXRoJztcclxuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhbHBhdGhTeW5jLCByZWFkRmlsZVN5bmMgfSBmcm9tICdub2RlOmZzJztcclxuaW1wb3J0IHsgd3JpdGVGaWxlLCByZWFkRmlsZSB9IGZyb20gJ25vZGU6ZnMvcHJvbWlzZXMnO1xyXG5pbXBvcnQgeyBob21lZGlyLCBuZXR3b3JrSW50ZXJmYWNlcyB9IGZyb20gJ25vZGU6b3MnO1xyXG5pbXBvcnQgeyBleGVjRmlsZVN5bmMsIHNwYXduIH0gZnJvbSAnbm9kZTpjaGlsZF9wcm9jZXNzJztcclxuaW1wb3J0IHsgcGF0aFRvRmlsZVVSTCB9IGZyb20gJ25vZGU6dXJsJztcclxuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gJ25vZGU6Y3J5cHRvJztcclxuaW1wb3J0IHsgRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yLCBEZXNrdG9wSG9zdENsaWVudCwgZW52ZWxvcGVGcm9tRnJhbWUsIHR5cGUgSG9zdFN0YXRlIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2hvc3QtYWRhcHRlcic7XHJcbmltcG9ydCB7IGlzRXZlbnRFbnZlbG9wZSwgdHlwZSBFdmVudEVudmVsb3BlIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyc7XHJcbmltcG9ydCB7IGF0dGFjaFVpVmVyaWZ5IH0gZnJvbSAnLi91aXZlcmlmeS50cyc7XHJcbmltcG9ydCB7IGluc3RhbGxUYXJnZXQsIHJlc29sdmVJbnN0YWxsZWRFbnRyeSwgc3RhcnRDbGlJbnN0YWxsLCB0eXBlIEluc3RhbGxQcm9ncmVzcyB9IGZyb20gJy4vaW5zdGFsbGVyLnRzJztcclxuXHJcbmNvbnN0IGhlcmUgPSBpbXBvcnQubWV0YS5kaXJuYW1lID8/ICcuJztcclxuY29uc3QgaXNEZXYgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9ERVYgPT09ICcxJztcclxuY29uc3QgcmVuZGVyZXJEZXZVcmwgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9SRU5ERVJFUl9VUkwgPz8gJyc7XHJcbmNvbnN0IHByZWxvYWRQYXRoID0gam9pbihoZXJlLCAnLi4vcHJlbG9hZC9pbmRleC5janMnKTtcclxuXHJcbi8qIC0tLS0gXHU2NUU1XHU1RkQ3XHU4MTMxXHU2NTRGOnRva2VuL2F1dGhvcml6YXRpb24gXHU2QzM4XHU0RTBEXHU4RkRCXHU2M0E3XHU1MjM2XHU1M0YwIC0tLS0gKi9cclxuY29uc3Qgc2VjcmV0czogc3RyaW5nW10gPSBbXTtcclxuZnVuY3Rpb24gcmVkYWN0KHM6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgbGV0IG91dCA9IHM7XHJcbiAgZm9yIChjb25zdCBzZWMgb2Ygc2VjcmV0cykge1xyXG4gICAgaWYgKHNlYy5sZW5ndGggPj0gOCkgb3V0ID0gb3V0LnNwbGl0KHNlYykuam9pbignW3JlZGFjdGVkXScpO1xyXG4gIH1cclxuICByZXR1cm4gb3V0O1xyXG59XHJcbmZ1bmN0aW9uIGxvZ0luZm8odGFnOiBzdHJpbmcsIG1zZzogc3RyaW5nKTogdm9pZCB7XHJcbiAgY29uc29sZS5sb2coYFtobWgtZGVza3RvcDoke3RhZ31dICR7cmVkYWN0KG1zZyl9YCk7XHJcbn1cclxuXHJcbi8qIC0tLS0gXHU1MzU1XHU1QjlFXHU0RjhCIC0tLS0gKi9cclxuaWYgKCFhcHAucmVxdWVzdFNpbmdsZUluc3RhbmNlTG9jaygpKSB7XHJcbiAgYXBwLnF1aXQoKTtcclxufSBlbHNlIHtcclxuICBhcHAub24oJ3NlY29uZC1pbnN0YW5jZScsICgpID0+IHtcclxuICAgIGNvbnN0IHdpbiA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpWzBdO1xyXG4gICAgaWYgKHdpbikge1xyXG4gICAgICBpZiAod2luLmlzTWluaW1pemVkKCkpIHdpbi5yZXN0b3JlKCk7XHJcbiAgICAgIHdpbi5mb2N1cygpO1xyXG4gICAgfVxyXG4gIH0pO1xyXG5cclxuICAvKiAtLS0tIGhvc3QgXHU3NkQxXHU3QkExICsgXHU2ODY1XHU1QkEyXHU2MjM3XHU3QUVGIC0tLS0gKi9cclxuICBpbnRlcmZhY2UgQnJpZGdlU25hcHNob3Qge1xyXG4gICAgaG9zdFN0YXRlOiBIb3N0U3RhdGU7XHJcbiAgICBob3N0UG9ydDogbnVtYmVyIHwgbnVsbDtcclxuICAgIGhvc3RWZXJzaW9uOiBzdHJpbmcgfCBudWxsO1xyXG4gICAgbGFzdEVycm9yOiBzdHJpbmcgfCBudWxsO1xyXG4gICAgbW9kZTogJ2Zha2UnIHwgJ3JlYWwnO1xyXG4gICAgcnVudGltZUVudHJ5OiBzdHJpbmcgfCBudWxsO1xyXG4gIH1cclxuICBsZXQgc3VwZXJ2aXNvcjogRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yIHwgbnVsbCA9IG51bGw7XHJcbiAgbGV0IGNsaWVudDogRGVza3RvcEhvc3RDbGllbnQgfCBudWxsID0gbnVsbDtcclxuICBsZXQgYnJpZGdlOiBCcmlkZ2VTbmFwc2hvdCA9IHsgaG9zdFN0YXRlOiAnc3RvcHBlZCcsIGhvc3RQb3J0OiBudWxsLCBob3N0VmVyc2lvbjogbnVsbCwgbGFzdEVycm9yOiBudWxsLCBtb2RlOiAnZmFrZScsIHJ1bnRpbWVFbnRyeTogbnVsbCB9O1xyXG4gIC8qKiBcdTRFOEJcdTRFRjZcdTYyNzlcdTkxQ0ZcdTdGMTNcdTUxQjI6XHU5QUQ4XHU5ODkxIFNTRSBcdTRFMERcdTkwMTBcdTY3NjFcdThGQzcgSVBDLDUwbXMgXHU2Mjc5XHU5MUNGIGZsdXNoKFx1NkUzMlx1NjdEM1x1NEUwRFx1NTM2MSlcdTMwMDIgKi9cclxuICBsZXQgZXZlbnRCdWZmZXI6IEV2ZW50RW52ZWxvcGVbXSA9IFtdO1xyXG4gIGxldCBmbHVzaFRpbWVyOiBOb2RlSlMuVGltZW91dCB8IG51bGwgPSBudWxsO1xyXG4gIGxldCBzc2VBYm9ydDogQWJvcnRDb250cm9sbGVyIHwgbnVsbCA9IG51bGw7XHJcbiAgbGV0IGxhc3RFdmVudElkID0gJyc7XHJcbiAgLyoqIFx1NjcyQVx1NzdFNS9cdTc1NzhcdTVGNjJcdTRGRTFcdTVDMDFcdThCQTFcdTY1NzAoU0NIRU1BX01JU01BVENIIFx1OTc2Mlx1NTQxMVx1OEJDQVx1NjVBRCxcdTRFMERcdTVEMjkpXHUzMDAyICovXHJcbiAgbGV0IGRyb3BwZWRGcmFtZXMgPSAwO1xyXG5cclxuICBmdW5jdGlvbiBwdXNoRXZlbnQoZW52OiBFdmVudEVudmVsb3BlKTogdm9pZCB7XHJcbiAgICBldmVudEJ1ZmZlci5wdXNoKGVudik7XHJcbiAgICBpZiAoZXZlbnRCdWZmZXIubGVuZ3RoID4gMl8wMDApIGV2ZW50QnVmZmVyLnNwbGljZSgwLCBldmVudEJ1ZmZlci5sZW5ndGggLSAyXzAwMCk7XHJcbiAgICBpZiAoZmx1c2hUaW1lciA9PT0gbnVsbCkge1xyXG4gICAgICBmbHVzaFRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XHJcbiAgICAgICAgZmx1c2hUaW1lciA9IG51bGw7XHJcbiAgICAgICAgY29uc3QgYmF0Y2ggPSBldmVudEJ1ZmZlcjtcclxuICAgICAgICBldmVudEJ1ZmZlciA9IFtdO1xyXG4gICAgICAgIGZvciAoY29uc3QgdyBvZiBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKSkge1xyXG4gICAgICAgICAgaWYgKCF3LmlzRGVzdHJveWVkKCkpIHcud2ViQ29udGVudHMuc2VuZCgnYnJpZGdlOmV2ZW50LWJhdGNoJywgYmF0Y2gpO1xyXG4gICAgICAgIH1cclxuICAgICAgfSwgNTApO1xyXG4gICAgfVxyXG4gICAgbm90aWZ5RXZlbnQoZW52KTtcclxuICB9XHJcblxyXG4gIC8qIC0tLS0gXHU3Q0ZCXHU3RURGXHU2MjU4XHU3NkQ4ICsgXHU5MDFBXHU3N0U1KDAzIFx1NTNGNyBcdTAwQTdcdTRFMDA6XHU2ODRDXHU5NzYyXHU0RUE3XHU1NEMxXHU5NzAwXHU4OTgxXHU3Q0ZCXHU3RURGXHU2MjU4XHU3NkQ4XHUzMDAxXHU5MDFBXHU3N0U1KSAtLS0tXHJcbiAgICAgXHU1QkExXHU2Mjc5XHU3QjQ5XHU1Rjg1XHU1RkM1XHU5ODdCXHU2MjUzXHU2MjcwKFx1NzUyOFx1NjIzN1x1NUZDNVx1OTg3Qlx1NTFCM1x1N0I1Nik7XHU1QjhDXHU2MjEwL1x1NTkzMVx1OEQyNVx1NEVDNVx1NTcyOFx1N0E5N1x1NTNFM1x1NTkzMVx1NzEyNlx1NjVGNlx1NjNEMFx1OTE5Mlx1MzAwMiAqL1xyXG4gIGNvbnN0IFRSQVlfSUNPTl9CQVNFNjQgPSAnaVZCT1J3MEtHZ29BQUFBTlNVaEVVZ0FBQUJBQUFBQVFDQVlBQUFBZjgvOWhBQUFBUjBsRVFWUjRuR05nUUFQU3Nvci84V0YwOVVScnhHc1FxWm94RElFSjZEZCtCMk4waGJqRU1Xd24xUUN3SVlQVEFGeVlmZ1lNZkJpUVpBREZDWWtxU1puaXpFUkpkZ1lBbEw1cnNEYzJhVGNBQUFBQVNVVk9SSzVDWUlJPSc7XHJcbiAgbGV0IHRyYXk6IFRyYXkgfCBudWxsID0gbnVsbDtcclxuICBjb25zdCBzZW5kTWVudUFjdGlvbiA9IChhOiBzdHJpbmcpOiB2b2lkID0+IHtcclxuICAgIGZvciAoY29uc3QgdyBvZiBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKSkge1xyXG4gICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCdtZW51OmFjdGlvbicsIGEpO1xyXG4gICAgfVxyXG4gIH07XHJcbiAgZnVuY3Rpb24gZm9jdXNNYWluV2luZG93KCk6IHZvaWQge1xyXG4gICAgY29uc3Qgd2luID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkuZmluZCgodykgPT4gIXcuaXNEZXN0cm95ZWQoKSk7XHJcbiAgICBpZiAod2luID09PSB1bmRlZmluZWQpIHJldHVybjtcclxuICAgIGlmICh3aW4uaXNNaW5pbWl6ZWQoKSkgd2luLnJlc3RvcmUoKTtcclxuICAgIHdpbi5zaG93KCk7XHJcbiAgICB3aW4uZm9jdXMoKTtcclxuICB9XHJcbiAgZnVuY3Rpb24gc2V0dXBUcmF5KCk6IHZvaWQge1xyXG4gICAgaWYgKHRyYXkgIT09IG51bGwpIHJldHVybjtcclxuICAgIGNvbnN0IGljb24gPSBuYXRpdmVJbWFnZS5jcmVhdGVGcm9tRGF0YVVSTChgZGF0YTppbWFnZS9wbmc7YmFzZTY0LCR7VFJBWV9JQ09OX0JBU0U2NH1gKTtcclxuICAgIHRyYXkgPSBuZXcgVHJheShpY29uKTtcclxuICAgIHRyYXkuc2V0VG9vbFRpcCgnSE1IIERlc2t0b3AnKTtcclxuICAgIHRyYXkub24oJ2NsaWNrJywgZm9jdXNNYWluV2luZG93KTtcclxuICAgIHRyYXkuc2V0Q29udGV4dE1lbnUoTWVudS5idWlsZEZyb21UZW1wbGF0ZShbXHJcbiAgICAgIHsgbGFiZWw6ICdcdTY1QjBcdTVFRkFcdTRGMUFcdThCREQnLCBjbGljazogKCk6IHZvaWQgPT4gc2VuZE1lbnVBY3Rpb24oJ25ldy1zZXNzaW9uJykgfSxcclxuICAgICAgeyBsYWJlbDogJ1x1NjYzRVx1NzkzQVx1NEUzQlx1N0E5N1x1NTNFMycsIGNsaWNrOiBmb2N1c01haW5XaW5kb3cgfSxcclxuICAgICAgeyBsYWJlbDogJ1x1NjI0Qlx1NjczQVx1OEZEQ1x1N0EwQlx1NjNBN1x1NTIzNicsIGNsaWNrOiAoKTogdm9pZCA9PiBzZW5kTWVudUFjdGlvbignb3Blbi1yZW1vdGUnKSB9LFxyXG4gICAgICB7IGxhYmVsOiAnXHU4QkJFXHU3RjZFJywgY2xpY2s6ICgpOiB2b2lkID0+IHNlbmRNZW51QWN0aW9uKCdvcGVuLXNldHRpbmdzJykgfSxcclxuICAgICAgeyB0eXBlOiAnc2VwYXJhdG9yJyB9LFxyXG4gICAgICB7IGxhYmVsOiAnXHU5MDAwXHU1MUZBJywgY2xpY2s6ICgpOiB2b2lkID0+IHsgYXBwLnF1aXQoKTsgfSB9LFxyXG4gICAgXSkpO1xyXG4gIH1cclxuICBmdW5jdGlvbiBub3RpZnlFdmVudChlbnY6IEV2ZW50RW52ZWxvcGUpOiB2b2lkIHtcclxuICAgIC8vIFx1OUE4Q1x1NjUzNi9cdTYyMkFcdTU2RkUvXHU2RTMyXHU2N0QzXHU2M0EyXHU5NDg4XHU2QTIxXHU1RjBGXHU5NzU5XHU5RUQ4KFx1NEUwRFx1NUY4MFx1NzUyOFx1NjIzN1x1Njg0Q1x1OTc2Mlx1NUYzOVx1NkQ0Qlx1OEJENVx1OTAxQVx1NzdFNSlcclxuICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWSA9PT0gJzEnIHx8IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NOQVBTSE9UICE9PSB1bmRlZmluZWQgfHwgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfUkVOREVSX1RFU1QgPT09ICcxJykgcmV0dXJuO1xyXG4gICAgaWYgKCFOb3RpZmljYXRpb24uaXNTdXBwb3J0ZWQoKSkgcmV0dXJuO1xyXG4gICAgY29uc3Qgd2luID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkuZmluZCgodykgPT4gIXcuaXNEZXN0cm95ZWQoKSk7XHJcbiAgICBjb25zdCBmb2N1c2VkID0gd2luPy5pc0ZvY3VzZWQoKSA/PyBmYWxzZTtcclxuICAgIGNvbnN0IG1rID0gKHRpdGxlOiBzdHJpbmcsIGJvZHk6IHN0cmluZyk6IHZvaWQgPT4ge1xyXG4gICAgICBjb25zdCBuID0gbmV3IE5vdGlmaWNhdGlvbih7IHRpdGxlLCBib2R5LCBpY29uOiBuYXRpdmVJbWFnZS5jcmVhdGVGcm9tRGF0YVVSTChgZGF0YTppbWFnZS9wbmc7YmFzZTY0LCR7VFJBWV9JQ09OX0JBU0U2NH1gKSB9KTtcclxuICAgICAgbi5vbignY2xpY2snLCBmb2N1c01haW5XaW5kb3cpO1xyXG4gICAgICBuLnNob3coKTtcclxuICAgIH07XHJcbiAgICBpZiAoZW52LmtpbmQgPT09ICdhcHByb3ZhbC5yZXF1aXJlZCcpIHtcclxuICAgICAgY29uc3QgcCA9IGVudi5wYXlsb2FkIGFzIHsgdG9vbD86IHN0cmluZyB9O1xyXG4gICAgICBtaygnSE1IIFx1OTcwMFx1ODk4MVx1NUJBMVx1NjI3OScsIGAke1N0cmluZyhwLnRvb2wgPz8gJ1x1NjRDRFx1NEY1QycpfSBcdTdCNDlcdTVGODVcdTRGNjBcdTc2ODRcdTYyNzlcdTUxQzZgKTtcclxuICAgIH0gZWxzZSBpZiAoZW52LmtpbmQgPT09ICdydW4uY29tcGxldGVkJyAmJiAhZm9jdXNlZCkge1xyXG4gICAgICBtaygnSE1IIFx1NEVGQlx1NTJBMVx1NUI4Q1x1NjIxMCcsIGBcdTRGMUFcdThCREQgJHtlbnYuc2Vzc2lvbklkfSBcdTc2ODRcdTRFRkJcdTUyQTFcdTVERjJcdTVCOENcdTYyMTBgKTtcclxuICAgIH0gZWxzZSBpZiAoZW52LmtpbmQgPT09ICdydW4uZmFpbGVkJyAmJiAhZm9jdXNlZCkge1xyXG4gICAgICBtaygnSE1IIFx1NEVGQlx1NTJBMVx1NTkzMVx1OEQyNScsIGBcdTRGMUFcdThCREQgJHtlbnYuc2Vzc2lvbklkfSBcdTc2ODRcdTRFRkJcdTUyQTFcdTU5MzFcdThEMjUsXHU3MEI5XHU1MUZCXHU2N0U1XHU3NzBCYCk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvKiAtLS0tIFx1ODFFQVx1NUI5QVx1NEU0OVx1NjgwN1x1OTg5OFx1NjgwRigyMDI2LTEwLTExIFx1NzUyOFx1NjIzN1x1NTNDRFx1OTk4ODpcdTRFQUVcdTgyNzJcdTZBMjFcdTVGMEZcdTk4NzZcdTkwRThcdTlFRDFcdTY3NjE9XHU1MzlGXHU3NTFGXHU4M0RDXHU1MzU1XHU2ODBGXHJcbiAgICAgXHU0RTBEXHU4RERGXHU0RTNCXHU5ODk4O1x1ODNEQ1x1NTM1NVx1NEUwRVx1OEJCRVx1N0Y2RVx1OTFDRFx1NTkwRCkgLS0tLSBcdTY1QjlcdTY4NDg6XHU5NjkwXHU4NUNGXHU1RjBGXHU2ODA3XHU5ODk4XHU2ODBGICsgdGl0bGVCYXJPdmVybGF5XHJcbiAgICAgKFx1OTg5Q1x1ODI3Mlx1OTY4Rlx1NEUzQlx1OTg5OCksXHU4M0RDXHU1MzU1XHU2ODBGIGF1dG9IaWRlKEFsdCBcdTU0N0NcdTUxRkEpXHU0RTE0XHU3Q0JFXHU3QjgwXHU0RTNBXHU3Q0ZCXHU3RURGXHU3RUE3XHU4MEZEXHU1MjlCO1xyXG4gICAgIFx1NUUzOFx1NzUyOFx1NTJBOFx1NEY1Q1x1OEQ3MCByZW5kZXJlciBcdTY4MDdcdTk4OThcdTY4MEYgXHUyNjMwIFx1NEUzQlx1ODNEQ1x1NTM1NShcdTU1MkZcdTRFMDBcdTUxNjVcdTUzRTMpXHUzMDAyICovXHJcbiAgLy8gdjQgRFNIIFx1OEJCRVx1OEJBMVx1OEJFRFx1OEEwMDpvdmVybGF5IFx1ODI3Mlx1OERERlx1OTY4RiB0aXRsZWJhciBcdTc2ODQgYmctbGF5ZXItMShcdTZENDUgI2ZmZi9cdTZERjEgIzE2MTgxZClcclxuICBjb25zdCBjaHJvbWVGb3IgPSAoZGFyazogYm9vbGVhbik6IHsgY29sb3I6IHN0cmluZzsgc3ltYm9sQ29sb3I6IHN0cmluZyB9ID0+XHJcbiAgICBkYXJrID8geyBjb2xvcjogJyMxNjE4MWQnLCBzeW1ib2xDb2xvcjogJyNmNWY2ZjgnIH0gOiB7IGNvbG9yOiAnI2ZmZmZmZicsIHN5bWJvbENvbG9yOiAnIzBmMTExNScgfTtcclxuICBmdW5jdGlvbiBhcHBseUNocm9tZShkYXJrOiBib29sZWFuKTogdm9pZCB7XHJcbiAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcclxuICAgICAgaWYgKCF3LmlzRGVzdHJveWVkKCkpIHtcclxuICAgICAgICB0cnkgeyB3LnNldFRpdGxlQmFyT3ZlcmxheShjaHJvbWVGb3IoZGFyaykpOyB9IGNhdGNoIHsgLyogXHU0RUM1IFdpbmRvd3MgXHU2NTJGXHU2MzAxICovIH1cclxuICAgICAgfVxyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgLyogLS0tLSBcdTVFOTRcdTc1MjhcdTUxODVcdTY2RjRcdTY1QjAoMjAyNi0xMC0yNjpcdTgxRUFcdTc4MTRcdThGN0JcdTkxQ0ZcdTY2RjRcdTY1QjBcdTU2NjgsXHU5NkY2XHU0RjlEXHU4RDU2O0dpdEh1YiBSZWxlYXNlcyBcdTkwMUFcdTkwNTMpXHJcbiAgICAgXHU2RDQxXHU3QTBCOlx1MjYzMFwiXHU2OEMwXHU2N0U1XHU2NkY0XHU2NUIwXCJcdTIxOTIgZmV0Y2ggbGF0ZXN0IHJlbGVhc2UgdGFnIFx1MjE5MiBcdTZCRDRcdTcyNDhcdTY3MkMgXHUyMTkyIFx1NTQwRVx1NTNGMFx1NEUwQlx1OEY3RCBTZXR1cFxyXG4gICAgIGV4ZSBcdTUyMzBcdTRFMzRcdTY1RjZcdTc2RUVcdTVGNTUgXHUyMTkyIFx1ODNEQ1x1NTM1NVx1NTNEOFwiXHU5MUNEXHU1NDJGXHU1RTc2XHU1Qjg5XHU4OEM1XHU2NkY0XHU2NUIwXCJcdTIxOTIgXHU5MDAwXHU1MUZBXHU1RTk0XHU3NTI4XHU1NDBFIE5TSVMgL1MgL0Q9XHU1MzlGXHU3NkVFXHU1RjU1XHJcbiAgICAgXHU5NzU5XHU5RUQ4XHU4OTg2XHU3NkQ2XHU1Qjg5XHU4OEM1KFx1NEUwQlx1NkIyMVx1NTQyRlx1NTJBOFx1NTM3M1x1NjVCMFx1NzI0OClcdTMwMDJcdTY1RTBcdTdCN0VcdTU0MERcdThCQzFcdTRFNjZcdTk2MzZcdTZCQjVcdTUzRUZcdTc1Mjg7XHU2QjYzXHU1RjBGXHU3QjdFXHU1NDBEXHU1NDBFXHU1M0VGXHU1MkEwXHU2ODIxXHU5QThDXHUzMDAyICovXHJcbiAgY29uc3QgVVBEQVRFX1JFUE8gPSAnc3dzZ2JsL2htaC1kZXNrdG9wJztcclxuICBpbnRlcmZhY2UgVXBkYXRlU3RhdGUgeyBjaGVja2luZzogYm9vbGVhbjsgY3VycmVudFZlcnNpb246IHN0cmluZzsgbGF0ZXN0OiBzdHJpbmcgfCBudWxsOyBub3Rlczogc3RyaW5nOyBkb3dubG9hZGVkOiBib29sZWFuOyBlcnJvcjogc3RyaW5nIH1cclxuICBsZXQgdXBkYXRlU3RhdGU6IFVwZGF0ZVN0YXRlID0geyBjaGVja2luZzogZmFsc2UsIGN1cnJlbnRWZXJzaW9uOiBhcHAuZ2V0VmVyc2lvbigpLCBsYXRlc3Q6IG51bGwsIG5vdGVzOiAnJywgZG93bmxvYWRlZDogZmFsc2UsIGVycm9yOiAnJyB9O1xyXG4gIGxldCBpbnN0YWxsZXJQYXRoOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcclxuICBjb25zdCBidW1wVXBkYXRlID0gKHBhdGNoOiBQYXJ0aWFsPFVwZGF0ZVN0YXRlPik6IHZvaWQgPT4ge1xyXG4gICAgdXBkYXRlU3RhdGUgPSB7IC4uLnVwZGF0ZVN0YXRlLCAuLi5wYXRjaCB9O1xyXG4gICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XHJcbiAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ3VwZGF0ZTpzdGF0ZScsIHVwZGF0ZVN0YXRlKTtcclxuICAgIH1cclxuICB9O1xyXG4gIGNvbnN0IGNtcFZlcnNpb24gPSAoYTogc3RyaW5nLCBiOiBzdHJpbmcpOiBudW1iZXIgPT4ge1xyXG4gICAgY29uc3QgcGEgPSBhLnJlcGxhY2UoL152LywgJycpLnNwbGl0KCcuJykubWFwKE51bWJlcik7XHJcbiAgICBjb25zdCBwYiA9IGIucmVwbGFjZSgvXnYvLCAnJykuc3BsaXQoJy4nKS5tYXAoTnVtYmVyKTtcclxuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgMzsgaSsrKSB7IGlmICgocGFbaV0gPz8gMCkgIT09IChwYltpXSA/PyAwKSkgcmV0dXJuIChwYVtpXSA/PyAwKSA8IChwYltpXSA/PyAwKSA/IC0xIDogMTsgfVxyXG4gICAgcmV0dXJuIDA7XHJcbiAgfTtcclxuICBhc3luYyBmdW5jdGlvbiBjaGVja0ZvclVwZGF0ZXMoKTogUHJvbWlzZTxVcGRhdGVTdGF0ZT4ge1xyXG4gICAgaWYgKHVwZGF0ZVN0YXRlLmNoZWNraW5nIHx8IHVwZGF0ZVN0YXRlLmRvd25sb2FkZWQpIHJldHVybiB1cGRhdGVTdGF0ZTtcclxuICAgIGJ1bXBVcGRhdGUoeyBjaGVja2luZzogdHJ1ZSwgZXJyb3I6ICcnIH0pO1xyXG4gICAgbG9nSW5mbygndXBkYXRlJywgYGNoZWNraW5nXHUyMDI2IChjdXJyZW50IHYke2FwcC5nZXRWZXJzaW9uKCl9KWApO1xyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3QgciA9IGF3YWl0IGZldGNoKGBodHRwczovL2FwaS5naXRodWIuY29tL3JlcG9zLyR7VVBEQVRFX1JFUE99L3JlbGVhc2VzL2xhdGVzdGAsIHtcclxuICAgICAgICBoZWFkZXJzOiB7ICd1c2VyLWFnZW50JzogJ2htaC1kZXNrdG9wLXVwZGF0ZXInIH0sXHJcbiAgICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDE1XzAwMCksXHJcbiAgICAgIH0pO1xyXG4gICAgICBpZiAoIXIub2spIHRocm93IG5ldyBFcnJvcihgR2l0SHViIEFQSSAke3Iuc3RhdHVzfWApO1xyXG4gICAgICBjb25zdCByZWwgPSAoYXdhaXQgci5qc29uKCkpIGFzIHsgdGFnX25hbWU/OiBzdHJpbmc7IGJvZHk/OiBzdHJpbmc7IGFzc2V0cz86IEFycmF5PHsgbmFtZTogc3RyaW5nOyBicm93c2VyX2Rvd25sb2FkX3VybDogc3RyaW5nOyBzaXplOiBudW1iZXIgfT4gfTtcclxuICAgICAgY29uc3QgdGFnID0gU3RyaW5nKHJlbC50YWdfbmFtZSA/PyAnJyk7XHJcbiAgICAgIGxvZ0luZm8oJ3VwZGF0ZScsIGBsYXRlc3Q9JHt0YWd9IGFzc2V0cz0keyhyZWwuYXNzZXRzID8/IFtdKS5sZW5ndGh9YCk7XHJcbiAgICAgIGJ1bXBVcGRhdGUoeyBjaGVja2luZzogZmFsc2UsIGxhdGVzdDogdGFnLCBub3RlczogU3RyaW5nKHJlbC5ib2R5ID8/ICcnKS5zbGljZSgwLCA2MDApIH0pO1xyXG4gICAgICAvLyBcdTY3MDlcdTY1QjBcdTcyNDhcdTRFMTRcdTY3MkFcdTRFMEJcdThGN0RcdThGQzcgXHUyMTkyIFx1NTQwRVx1NTNGMFx1NEUwQlx1OEY3RFx1NUI4OVx1ODhDNVx1NTMwNVxyXG4gICAgICBpZiAodGFnICE9PSAnJyAmJiBjbXBWZXJzaW9uKGFwcC5nZXRWZXJzaW9uKCksIHRhZykgPCAwICYmICF1cGRhdGVTdGF0ZS5kb3dubG9hZGVkKSB7XHJcbiAgICAgICAgdm9pZCBkb3dubG9hZEluc3RhbGxlcihyZWwuYXNzZXRzID8/IFtdKTtcclxuICAgICAgfVxyXG4gICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgIGxvZ0luZm8oJ3VwZGF0ZScsIGBjaGVjayBmYWlsZWQ6ICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTQwKX1gKTtcclxuICAgICAgYnVtcFVwZGF0ZSh7IGNoZWNraW5nOiBmYWxzZSwgZXJyb3I6IFN0cmluZyhlcnIpLnNsaWNlKDAsIDEyMCkgfSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gdXBkYXRlU3RhdGU7XHJcbiAgfVxyXG4gIGFzeW5jIGZ1bmN0aW9uIGRvd25sb2FkSW5zdGFsbGVyKGFzc2V0czogQXJyYXk8eyBuYW1lOiBzdHJpbmc7IGJyb3dzZXJfZG93bmxvYWRfdXJsOiBzdHJpbmc7IHNpemU6IG51bWJlciB9Pik6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3QgYXNzZXQgPSBhc3NldHMuZmluZCgoYSkgPT4gL15ITUgtRGVza3RvcC1TZXR1cC0uKlxcLmV4ZSQvaS50ZXN0KGEubmFtZSkpID8/IGFzc2V0cy5maW5kKChhKSA9PiBhLm5hbWUuZW5kc1dpdGgoJy5leGUnKSk7XHJcbiAgICAgIGlmIChhc3NldCA9PT0gdW5kZWZpbmVkKSB7IGJ1bXBVcGRhdGUoeyBlcnJvcjogJ3JlbGVhc2UgXHU2NUUwXHU1Qjg5XHU4OEM1XHU1MzA1XHU4RDQ0XHU0RUE3JyB9KTsgcmV0dXJuOyB9XHJcbiAgICAgIGNvbnN0IGRlc3QgPSBqb2luKGFwcC5nZXRQYXRoKCd0ZW1wJyksIGFzc2V0Lm5hbWUpO1xyXG4gICAgICAvLyBnaXRodWIuY29tIFx1NzZGNFx1OEZERVx1NTcyOFx1OTBFOFx1NTIwNlx1N0Y1MVx1N0VEQ1x1OEQ4NVx1NjVGNiBcdTIxOTIgXHU5NTVDXHU1MENGXHU1NkRFXHU5MDAwXHU5NEZFKFx1NUI5RVx1NkQ0QiBnaGZhc3QvZ2gtcHJveHkgXHU1M0VGXHU3NTI4KVxyXG4gICAgICBjb25zdCBtaXJyb3JzID0gW1xyXG4gICAgICAgIGFzc2V0LmJyb3dzZXJfZG93bmxvYWRfdXJsLFxyXG4gICAgICAgIGBodHRwczovL2doZmFzdC50b3AvJHthc3NldC5icm93c2VyX2Rvd25sb2FkX3VybH1gLFxyXG4gICAgICAgIGBodHRwczovL2doLXByb3h5LmNvbS8ke2Fzc2V0LmJyb3dzZXJfZG93bmxvYWRfdXJsfWAsXHJcbiAgICAgICAgYGh0dHBzOi8vZ2hwcm94eS5jbi8ke2Fzc2V0LmJyb3dzZXJfZG93bmxvYWRfdXJsfWAsXHJcbiAgICAgIF07XHJcbiAgICAgIGxldCBidWY6IEJ1ZmZlciB8IG51bGwgPSBudWxsO1xyXG4gICAgICBsZXQgbGFzdEVyciA9ICcnO1xyXG4gICAgICBmb3IgKGNvbnN0IHUgb2YgbWlycm9ycykge1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICBsb2dJbmZvKCd1cGRhdGUnLCBgdHJ5aW5nICR7bmV3IFVSTCh1KS5ob3N0fVx1MjAyNmApO1xyXG4gICAgICAgICAgY29uc3QgciA9IGF3YWl0IGZldGNoKHUsIHsgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDYwMF8wMDApIH0pO1xyXG4gICAgICAgICAgaWYgKCFyLm9rKSB7IGxhc3RFcnIgPSBgSFRUUCAke3Iuc3RhdHVzfWA7IGxvZ0luZm8oJ3VwZGF0ZScsIGBcdTIxOTIgSFRUUCAke3Iuc3RhdHVzfWApOyBjb250aW51ZTsgfVxyXG4gICAgICAgICAgYnVmID0gQnVmZmVyLmZyb20oYXdhaXQgci5hcnJheUJ1ZmZlcigpKTtcclxuICAgICAgICAgIGlmIChidWYubGVuZ3RoID4gMV8wMDBfMDAwKSB7IGxvZ0luZm8oJ3VwZGF0ZScsIGBcdTIxOTIgb2sgJHtNYXRoLnJvdW5kKGJ1Zi5sZW5ndGggLyAxZTYpfU1CYCk7IGJyZWFrOyB9XHJcbiAgICAgICAgICBsYXN0RXJyID0gJ1x1NTE4NVx1NUJCOVx1NUYwMlx1NUUzOCc7IGJ1ZiA9IG51bGw7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgICBjb25zdCBlID0gZXJyIGFzIHsgY2F1c2U/OiB7IGNvZGU/OiB1bmtub3duIH0gfTtcclxuICAgICAgICAgIGxhc3RFcnIgPSBTdHJpbmcoZS5jYXVzZT8uY29kZSA/PyBlcnIpLnNsaWNlKDAsIDYwKTtcclxuICAgICAgICAgIGxvZ0luZm8oJ3VwZGF0ZScsIGBcdTIxOTIgZmFpbCAke2xhc3RFcnJ9YCk7XHJcbiAgICAgICAgfVxyXG4gICAgICB9XHJcbiAgICAgIGlmIChidWYgPT09IG51bGwpIHRocm93IG5ldyBFcnJvcihgXHU1MTY4XHU5MEU4XHU0RTBCXHU4RjdEXHU5MDFBXHU5MDUzXHU1OTMxXHU4RDI1KCR7bGFzdEVycn0pYCk7XHJcbiAgICAgIGNvbnN0IHsgd3JpdGVGaWxlOiB3ZiB9ID0gYXdhaXQgaW1wb3J0KCdub2RlOmZzL3Byb21pc2VzJyk7XHJcbiAgICAgIGF3YWl0IHdmKGRlc3QsIGJ1Zik7XHJcbiAgICAgIGluc3RhbGxlclBhdGggPSBkZXN0O1xyXG4gICAgICBidW1wVXBkYXRlKHsgZG93bmxvYWRlZDogdHJ1ZSB9KTtcclxuICAgICAgbG9nSW5mbygndXBkYXRlJywgYFx1NURGMlx1NEUwQlx1OEY3RCAke2Fzc2V0Lm5hbWV9KCR7TWF0aC5yb3VuZChidWYubGVuZ3RoIC8gMWU2KX1NQikgXHUyMTkyICR7ZGVzdH1gKTtcclxuICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICBidW1wVXBkYXRlKHsgZXJyb3I6IGBcdTRFMEJcdThGN0RcdTU5MzFcdThEMjU6ICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTIwKX1gIH0pO1xyXG4gICAgfVxyXG4gIH1cclxuICBmdW5jdGlvbiBhcHBseVVwZGF0ZSgpOiB2b2lkIHtcclxuICAgIGlmIChpbnN0YWxsZXJQYXRoID09PSBudWxsKSByZXR1cm47XHJcbiAgICAvLyBcdTkwMDBcdTUxRkFcdTVGNTNcdTUyNERcdTVFOTRcdTc1MjhcdTU0MEVcdTc1MzFcdTVCODlcdTg4QzVcdTU2NjhcdTk3NTlcdTlFRDhcdTg5ODZcdTc2RDZcdTVCODlcdTg4QzUoXHU4OEM1XHU1NkRFXHU1MzlGXHU3NkVFXHU1RjU1KVx1MzAwMk5TSVMgYXNzaXN0ZWQgXHU4OUM0XHU1MjE5OlxyXG4gICAgLy8gL1MgXHU0RTE0IC9EPXBhdGggXHU1RkM1XHU5ODdCXHU2NzAwXHU1NDBFXHU0RTAwXHU0RTJBXHU1M0MyXHU2NTcwXHUzMDAxXHU1MDNDXHU0RTBEXHU1MkEwXHU1RjE1XHU1M0Y3KFx1NTQyQlx1N0E3QVx1NjgzQ1x1NEU1Rlx1NEUwRFx1NTJBMClcdTIwMTRcdTIwMTRub2RlIHNwYXduXHJcbiAgICAvLyBcdTlFRDhcdThCQTRcdTRGMUFcdTdFRDlcdTU0MkJcdTdBN0FcdTY4M0NcdTUzQzJcdTY1NzBcdTUyQTBcdTVGMTVcdTUzRjdcdTVCRkNcdTgxRjQgTlNJUyBcdTg5RTNcdTY3OTBcdTk1MTlcdThERUZcdTVGODQoXHU1QjlFXHU2RDRCXHU4OEM1XHU1NzRGXHU3NkVFXHU1RjU1KSxcdTY1NDVcdTc1MjhcclxuICAgIC8vIHdpbmRvd3NWZXJiYXRpbUFyZ3VtZW50cyBcdTUzOUZcdTY4MzdcdTRGMjBcdTkwMTJcdTMwMDJcclxuICAgIGNvbnN0IGluc3RhbGxEaXIgPSBkaXJuYW1lKHByb2Nlc3MuZXhlY1BhdGgpO1xyXG4gICAgY29uc3QgY2hpbGQgPSBzcGF3bihgXCIke2luc3RhbGxlclBhdGh9XCIgL1MgL0Q9JHtpbnN0YWxsRGlyfWAsIHtcclxuICAgICAgZGV0YWNoZWQ6IHRydWUsXHJcbiAgICAgIHN0ZGlvOiAnaWdub3JlJyxcclxuICAgICAgd2luZG93c0hpZGU6IHRydWUsXHJcbiAgICAgIHNoZWxsOiBmYWxzZSxcclxuICAgICAgd2luZG93c1ZlcmJhdGltQXJndW1lbnRzOiB0cnVlLFxyXG4gICAgfSk7XHJcbiAgICBjaGlsZC51bnJlZigpO1xyXG4gICAgbG9nSW5mbygndXBkYXRlJywgYGFwcGx5OiAke2luc3RhbGxlclBhdGh9IFx1MjE5MiAke2luc3RhbGxEaXJ9YCk7XHJcbiAgICBhcHAuZXhpdCgwKTtcclxuICB9XHJcblxyXG4gIGZ1bmN0aW9uIGJ1aWxkQXBwTWVudSgpOiB2b2lkIHtcclxuICAgIC8vIFx1N0NCRVx1N0I4MDpcdTUzRUFcdTRGRERcdTc1NTkgVUkgXHU2Q0ExXHU2NzA5XHU3Njg0XHU3Q0ZCXHU3RURGXHU3RUE3XHU4MEZEXHU1MjlCKFx1NTI2QVx1OEQzNFx1Njc3Ri9cdTdBOTdcdTUzRTMpO1x1NTE3Nlx1NEY1OVx1NTUyRlx1NEUwMFx1NTE2NVx1NTNFM1x1NTcyOCBVSVx1MzAwMlxyXG4gICAgY29uc3QgdGVtcGxhdGU6IEFycmF5PEVsZWN0cm9uLk1lbnVJdGVtQ29uc3RydWN0b3JPcHRpb25zPiA9IFtcclxuICAgICAge1xyXG4gICAgICAgIGxhYmVsOiAnXHU3RjE2XHU4RjkxJyxcclxuICAgICAgICBzdWJtZW51OiBbXHJcbiAgICAgICAgICB7IHJvbGU6ICd1bmRvJywgbGFiZWw6ICdcdTY0QTRcdTk1MDAnIH0sXHJcbiAgICAgICAgICB7IHJvbGU6ICdyZWRvJywgbGFiZWw6ICdcdTkxQ0RcdTUwNUEnIH0sXHJcbiAgICAgICAgICB7IHR5cGU6ICdzZXBhcmF0b3InIH0sXHJcbiAgICAgICAgICB7IHJvbGU6ICdjdXQnLCBsYWJlbDogJ1x1NTI2QVx1NTIwNycgfSxcclxuICAgICAgICAgIHsgcm9sZTogJ2NvcHknLCBsYWJlbDogJ1x1NTkwRFx1NTIzNicgfSxcclxuICAgICAgICAgIHsgcm9sZTogJ3Bhc3RlJywgbGFiZWw6ICdcdTdDOThcdThEMzQnIH0sXHJcbiAgICAgICAgICB7IHJvbGU6ICdzZWxlY3RBbGwnLCBsYWJlbDogJ1x1NTE2OFx1OTAwOScgfSxcclxuICAgICAgICBdLFxyXG4gICAgICB9LFxyXG4gICAgICB7XHJcbiAgICAgICAgbGFiZWw6ICdcdTdBOTdcdTUzRTMnLFxyXG4gICAgICAgIHN1Ym1lbnU6IFtcclxuICAgICAgICAgIHsgcm9sZTogJ21pbmltaXplJywgbGFiZWw6ICdcdTY3MDBcdTVDMEZcdTUzMTYnIH0sXHJcbiAgICAgICAgICB7IHJvbGU6ICd6b29tJywgbGFiZWw6ICdcdTdGMjlcdTY1M0UnIH0sXHJcbiAgICAgICAgICB7IHR5cGU6ICdzZXBhcmF0b3InIH0sXHJcbiAgICAgICAgICB7IHJvbGU6ICdjbG9zZScsIGxhYmVsOiAnXHU1MTczXHU5NUVEJyB9LFxyXG4gICAgICAgIF0sXHJcbiAgICAgIH0sXHJcbiAgICBdO1xyXG4gICAgTWVudS5zZXRBcHBsaWNhdGlvbk1lbnUoTWVudS5idWlsZEZyb21UZW1wbGF0ZSh0ZW1wbGF0ZSkpO1xyXG4gIH1cclxuICAvKiogXHU2ODA3XHU5ODk4XHU2ODBGIFx1MjYzMCBcdTRFM0JcdTgzRENcdTUzNTUoXHU1RTM4XHU3NTI4XHU1MkE4XHU0RjVDXHU3Njg0XHU1NTJGXHU0RTAwXHU1MTY1XHU1M0UzO1x1ODlDNlx1NTZGRVx1NjAwMVx1N0VDRiBtZW51OmFjdGlvbiBcdThGNkNcdTUzRDEpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gcG9wdXBNYWluTWVudSgpOiB2b2lkIHtcclxuICAgIGNvbnN0IHNlbmQgPSAoYTogc3RyaW5nKTogdm9pZCA9PiB7XHJcbiAgICAgIGZvciAoY29uc3QgdyBvZiBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKSkge1xyXG4gICAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ21lbnU6YWN0aW9uJywgYSk7XHJcbiAgICAgIH1cclxuICAgIH07XHJcbiAgICBjb25zdCB3aW4gPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5maW5kKCh3KSA9PiAhdy5pc0Rlc3Ryb3llZCgpKTtcclxuICAgIGlmICh3aW4gPT09IHVuZGVmaW5lZCkgcmV0dXJuO1xyXG4gICAgTWVudS5idWlsZEZyb21UZW1wbGF0ZShbXHJcbiAgICAgIHsgbGFiZWw6ICdcdTY1QjBcdTVFRkFcdTRGMUFcdThCREQnLCBhY2NlbGVyYXRvcjogJ0NtZE9yQ3RybCtOJywgY2xpY2s6ICgpOiB2b2lkID0+IHNlbmQoJ25ldy1zZXNzaW9uJykgfSxcclxuICAgICAgeyBsYWJlbDogJ1x1OEJCRVx1N0Y2RScsIGFjY2VsZXJhdG9yOiAnQ21kT3JDdHJsK1NoaWZ0K1AnLCBjbGljazogKCk6IHZvaWQgPT4gc2VuZCgnb3Blbi1zZXR0aW5ncycpIH0sXHJcbiAgICAgIHsgbGFiZWw6ICdcdTVGRUJcdTYzNzdcdTk1MkUnLCBhY2NlbGVyYXRvcjogJ0NtZE9yQ3RybCsvJywgY2xpY2s6ICgpOiB2b2lkID0+IHNlbmQoJ3Nob3J0Y3V0cycpIH0sXHJcbiAgICAgIHsgdHlwZTogJ3NlcGFyYXRvcicgfSxcclxuICAgICAgeyBsYWJlbDogJ1x1NjI0Qlx1NjczQVx1OEZEQ1x1N0EwQlx1NjNBN1x1NTIzNicsIGNsaWNrOiAoKTogdm9pZCA9PiBzZW5kKCdvcGVuLXJlbW90ZScpIH0sXHJcbiAgICAgIHsgdHlwZTogJ3NlcGFyYXRvcicgfSxcclxuICAgICAge1xyXG4gICAgICAgIGxhYmVsOiB1cGRhdGVTdGF0ZS5kb3dubG9hZGVkID8gYFx1OTFDRFx1NTQyRlx1NUU3Nlx1NUI4OVx1ODhDNVx1NjZGNFx1NjVCMCh2JHt1cGRhdGVTdGF0ZS5sYXRlc3QgPz8gJz8nfSlgIDogJ1x1NjhDMFx1NjdFNVx1NjZGNFx1NjVCMFx1MjAyNicsXHJcbiAgICAgICAgY2xpY2s6ICgpOiB2b2lkID0+IHtcclxuICAgICAgICAgIGlmICh1cGRhdGVTdGF0ZS5kb3dubG9hZGVkKSB7IGFwcGx5VXBkYXRlKCk7IHJldHVybjsgfVxyXG4gICAgICAgICAgdm9pZCBjaGVja0ZvclVwZGF0ZXMoKS50aGVuKChzdCkgPT4ge1xyXG4gICAgICAgICAgICBjb25zdCBuZXdlciA9IHN0LmxhdGVzdCAhPT0gbnVsbCAmJiBjbXBWZXJzaW9uKHN0LmN1cnJlbnRWZXJzaW9uLCBzdC5sYXRlc3QpIDwgMDtcclxuICAgICAgICAgICAgY29uc3QgZGV0YWlsID0gbmV3ZXIgPyBgJHtzdC5ub3Rlc31cXG5cXG5cdTVCODlcdTg4QzVcdTUzMDVcdTZCNjNcdTU3MjhcdTU0MEVcdTUzRjBcdTRFMEJcdThGN0QsXHU1QjhDXHU2MjEwXHU1NDBFIFx1MjYzMCBcdTgzRENcdTUzNTVcdTRGMUFcdTUxRkFcdTczQjBcIlx1OTFDRFx1NTQyRlx1NUU3Nlx1NUI4OVx1ODhDNVx1NjZGNFx1NjVCMFwiXHUzMDAyYCA6ICcnO1xyXG4gICAgICAgICAgICB2b2lkIGRpYWxvZy5zaG93TWVzc2FnZUJveCh3aW4sIHtcclxuICAgICAgICAgICAgICB0eXBlOiAnaW5mbycsXHJcbiAgICAgICAgICAgICAgdGl0bGU6ICdcdTY4QzBcdTY3RTVcdTY2RjRcdTY1QjAnLFxyXG4gICAgICAgICAgICAgIG1lc3NhZ2U6IG5ld2VyXHJcbiAgICAgICAgICAgICAgICA/IGBcdTUzRDFcdTczQjBcdTY1QjBcdTcyNDhcdTY3MkMgdiR7c3QubGF0ZXN0fSFgXHJcbiAgICAgICAgICAgICAgICA6IChzdC5lcnJvciAhPT0gJycgPyBgXHU2OEMwXHU2N0U1XHU1OTMxXHU4RDI1OiR7c3QuZXJyb3J9YCA6IGBcdTVERjJcdTY2MkZcdTY3MDBcdTY1QjBcdTcyNDhcdTY3MkModiR7c3QuY3VycmVudFZlcnNpb259KWApLFxyXG4gICAgICAgICAgICAgIGRldGFpbCxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICB9KTtcclxuICAgICAgICB9LFxyXG4gICAgICB9LFxyXG4gICAgICB7XHJcbiAgICAgICAgbGFiZWw6ICdcdTUxNzNcdTRFOEUgSE1IIERlc2t0b3AnLFxyXG4gICAgICAgIGNsaWNrOiAoKTogdm9pZCA9PiB7XHJcbiAgICAgICAgICB2b2lkIGRpYWxvZy5zaG93TWVzc2FnZUJveCh3aW4sIHtcclxuICAgICAgICAgICAgdHlwZTogJ2luZm8nLFxyXG4gICAgICAgICAgICB0aXRsZTogJ1x1NTE3M1x1NEU4RSBITUggRGVza3RvcCcsXHJcbiAgICAgICAgICAgIG1lc3NhZ2U6ICdITUggRGVza3RvcCcsXHJcbiAgICAgICAgICAgIGRldGFpbDogYFx1NjcyQ1x1NTczMFx1NEYxOFx1NTE0OFx1NzY4NCBITUggQWdlbnQgXHU1NkZFXHU1RjYyXHU1REU1XHU0RjVDXHU1M0YwIHYke2FwcC5nZXRWZXJzaW9uKCl9XFxucnVudGltZTogaG1oYXJuZXNzICR7YnJpZGdlLmhvc3RWZXJzaW9uID8/ICcoXHU2NzJBXHU4RkRFXHU2M0E1KSd9JHt1c2VCdW5kbGVkUnVudGltZSA/ICcoXHU1MTg1XHU3RjZFKScgOiAnJ31cXG5cdTZBMjFcdTVGMEY6ICR7YnJpZGdlLm1vZGUgPT09ICdyZWFsJyA/ICh1c2VCdW5kbGVkUnVudGltZSA/ICdcdTc3MUZcdTVCOUUgaG1oYXJuZXNzKFx1NTE4NVx1N0Y2RSBydW50aW1lKScgOiAnXHU3NzFGXHU1QjlFIGhtaGFybmVzcyhcdTU5MTZcdTkwRThcdTVCODlcdTg4QzUpJykgOiAnXHU2RjE0XHU3OTNBKFx1NTA0N1x1NjU3MFx1NjM2RSknfVxcblxcblx1NEUwRSBDTEkgLyBUVUkgLyBcdTdGNTFcdTk4NzVcdTcyNDhcdTUxNzFcdTRFQUJcdTU0MENcdTRFMDAgSE1IX0hPTUVcdTMwMDJgLFxyXG4gICAgICAgICAgfSk7XHJcbiAgICAgICAgfSxcclxuICAgICAgfSxcclxuICAgICAgeyBsYWJlbDogJ1x1OTAwMFx1NTFGQScsIHJvbGU6ICdxdWl0JyB9LFxyXG4gICAgXSkucG9wdXAoeyB3aW5kb3c6IHdpbiB9KTtcclxuICB9XHJcblxyXG4gIC8qIC0tLS0gXHU2MjRCXHU2NzNBXHU4RkRDXHU3QTBCXHU2M0E3XHU1MjM2KDAzIFx1NTNGNzpXZWIgNzc4OCBcdTY2MkZcdTZENEZcdTg5QzhcdTU2NjgvXHU4RkRDXHU3QTBCL1x1NjI0Qlx1NjczQVx1NTE2NVx1NTNFMyxBRFItMDA1OlxyXG4gICAgIERlc2t0b3AgXHU0RTBEXHU5RUQ4XHU4QkE0XHU2MjUzXHU1RjAwIExBTiBcdTIwMTRcdTIwMTQgXHU4RkQ5XHU5MUNDXHU2NjJGXHU3NTI4XHU2MjM3XHU2NjNFXHU1RjBGXHU1NDJGXHU1MkE4XHU3Njg0XHU1MTY1XHU1M0UzKSAtLS0tICovXHJcbiAgY29uc3QgV0VCX1BPUlQgPSA3Nzg4O1xyXG4gIGFzeW5jIGZ1bmN0aW9uIHByb2JlV2ViUmVtb3RlKCk6IFByb21pc2U8eyB1cDogYm9vbGVhbjsgdmVyc2lvbjogc3RyaW5nIH0+IHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHIgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke1dFQl9QT1JUfS9hcGkvc3RhdGVgLCB7IHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCgxNTAwKSB9KTtcclxuICAgICAgaWYgKCFyLm9rKSByZXR1cm4geyB1cDogZmFsc2UsIHZlcnNpb246ICcnIH07XHJcbiAgICAgIGNvbnN0IGQgPSAoYXdhaXQgci5qc29uKCkpIGFzIHsgZGFlbW9uVmVyc2lvbj86IHN0cmluZyB9O1xyXG4gICAgICByZXR1cm4geyB1cDogdHJ1ZSwgdmVyc2lvbjogU3RyaW5nKGQuZGFlbW9uVmVyc2lvbiA/PyAnJykgfTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4geyB1cDogZmFsc2UsIHZlcnNpb246ICcnIH07IH1cclxuICB9XHJcbiAgLyoqIFx1NUYwMFx1NjczQVx1ODFFQVx1NTQyRlx1NjYyRlx1NTQyNlx1NURGMlx1ODhDNShydW50aW1lIHdlYi1kYWVtb24gXHU3Njg0XHU1NDJGXHU1MkE4XHU5ODc5XHU2NTg3XHU0RUY2XHU1QjU4XHU1NzI4XHU2MDI3OzAuMjMuMzcgXHU2NUIwXHU4MEZEXHU1MjlCKVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIHdlYkF1dG9zdGFydEluc3RhbGxlZCgpOiBib29sZWFuIHtcclxuICAgIGNvbnN0IGhvbWUgPSBwcm9jZXNzLmVudi5IT01FID8/ICcnO1xyXG4gICAgY29uc3QgY2FuZGlkYXRlcyA9IHByb2Nlc3MucGxhdGZvcm0gPT09ICd3aW4zMidcclxuICAgICAgPyBbam9pbihwcm9jZXNzLmVudi5BUFBEQVRBID8/ICcnLCAnTWljcm9zb2Z0JywgJ1dpbmRvd3MnLCAnU3RhcnQgTWVudScsICdQcm9ncmFtcycsICdTdGFydHVwJywgJ2htaGFybmVzcy13ZWItZGFlbW9uLmNtZCcpXVxyXG4gICAgICA6IHByb2Nlc3MucGxhdGZvcm0gPT09ICdkYXJ3aW4nXHJcbiAgICAgICAgPyBbam9pbihob21lLCAnTGlicmFyeScsICdMYXVuY2hBZ2VudHMnLCAnaG1oYXJuZXNzLXdlYi1kYWVtb24ucGxpc3QnKV1cclxuICAgICAgICA6IFtqb2luKGhvbWUsICcuY29uZmlnJywgJ3N5c3RlbWQnLCAndXNlcicsICdobWhhcm5lc3Mtd2ViLWRhZW1vbi5zZXJ2aWNlJyldO1xyXG4gICAgcmV0dXJuIGNhbmRpZGF0ZXMuc29tZSgocCkgPT4geyB0cnkgeyByZXR1cm4gZXhpc3RzU3luYyhwKTsgfSBjYXRjaCB7IHJldHVybiBmYWxzZTsgfSB9KTtcclxuICB9XHJcbiAgLyoqIFx1NjI0Qlx1NjczQVx1NTNFRlx1OERFRlx1NzUzMVx1NzY4NCBMQU4gSVAoUkZDMTkxOCxcdTYzOTJcdTk2NjRcdTg2NUFcdTYyREZcdTdGNTFcdTUzNjEpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gbGFuSXBPZigpOiBzdHJpbmcge1xyXG4gICAgY29uc3QgVklSVFVBTCA9IC92bXdhcmV8dmlydHVhbHxoeXBlci0/dnx2ZXRoZXJuZXR8d3NsfHRhaWxzY2FsZXxsb29wYmFja3xibHVldG9vdGh8dmJveHxkb2NrZXJ8dGFwLXxwc2V1ZG8vaTtcclxuICAgIGNvbnN0IGlzUmZjMTkxOCA9IChhOiBzdHJpbmcpOiBib29sZWFuID0+IC9eMTBcXC4vLnRlc3QoYSkgfHwgL14xOTJcXC4xNjhcXC4vLnRlc3QoYSkgfHwgL14xNzJcXC4oMVs2LTldfDJcXGR8M1swMV0pXFwuLy50ZXN0KGEpO1xyXG4gICAgbGV0IGxhbklwID0gJyc7XHJcbiAgICBsZXQgZmFsbGJhY2sgPSAnJztcclxuICAgIGZvciAoY29uc3QgW25hbWUsIGxpc3RdIG9mIE9iamVjdC5lbnRyaWVzKG5ldHdvcmtJbnRlcmZhY2VzKCkpKSB7XHJcbiAgICAgIGZvciAoY29uc3QgbiBvZiBsaXN0ID8/IFtdKSB7XHJcbiAgICAgICAgaWYgKG4uZmFtaWx5ICE9PSAnSVB2NCcgfHwgbi5pbnRlcm5hbCB8fCAhaXNSZmMxOTE4KG4uYWRkcmVzcykpIGNvbnRpbnVlO1xyXG4gICAgICAgIGlmICghVklSVFVBTC50ZXN0KG5hbWUpKSBsYW5JcCA9IGxhbklwIHx8IG4uYWRkcmVzcztcclxuICAgICAgICBlbHNlIGZhbGxiYWNrID0gZmFsbGJhY2sgfHwgbi5hZGRyZXNzO1xyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gbGFuSXAgfHwgZmFsbGJhY2s7XHJcbiAgfVxyXG4gIC8qKiBDTEkgXHU1MTY1XHU1M0UzOlx1NkU5MFx1NzgwMSByZXBvIFx1NUUwM1x1NUM0MChtYWluLnRzLFx1N0VDRiB0c3gpXHU2MjE2IG5wbSBcdTVCODlcdTg4QzVcdTVFMDNcdTVDNDAoZGlzdC9tYWluLmpzXHJcbiAgICogIFx1NzZGNFx1OEREMVx1MjAxNFx1MjAxNFx1NEVDRSBydW50aW1lIFx1NTE2NVx1NTNFM1x1NEUwQVx1NkVBRlx1NjI3RSBAaG1oYXJuZXNzL2NsaSBcdTUzMDU7XHU1RDRDXHU1OTU3L1x1NjNEMFx1NTM0Ny9cdTZFOTBcdTc4MDFcdTRFMDlcdTc5Q0RcdTVFMDNcdTVDNDBcdTkwMUFcdTU0MDMpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gY2xpRW50cnlPZigpOiBzdHJpbmcge1xyXG4gICAgaWYgKHJ1bnRpbWVFbnRyeSA9PT0gJycgfHwgcnVudGltZUVudHJ5ID09PSBudWxsKSByZXR1cm4gJyc7XHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCBwID0gam9pbihyZXBvUm9vdE9mKHJ1bnRpbWVFbnRyeSksICdwYWNrYWdlcycsICdjbGknLCAnc3JjJywgJ21haW4udHMnKTtcclxuICAgICAgaWYgKGV4aXN0c1N5bmMocCkpIHJldHVybiBwO1xyXG4gICAgfSBjYXRjaCB7IC8qIFx1OTc1RSByZXBvIFx1NUUwM1x1NUM0MCAqLyB9XHJcbiAgICBsZXQgZGlyID0gZGlybmFtZShydW50aW1lRW50cnkpO1xyXG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCA4OyBpKyspIHtcclxuICAgICAgaWYgKGV4aXN0c1N5bmMoam9pbihkaXIsICdkaXN0JywgJ21haW4uanMnKSkgJiYgcGtnTmFtZUF0KGRpcikgPT09ICdAaG1oYXJuZXNzL2NsaScpIHJldHVybiBqb2luKGRpciwgJ2Rpc3QnLCAnbWFpbi5qcycpO1xyXG4gICAgICBpZiAoYmFzZW5hbWUoZGlyKSA9PT0gJ0BobWhhcm5lc3MnICYmIGV4aXN0c1N5bmMoam9pbihkaXIsICdjbGknLCAnZGlzdCcsICdtYWluLmpzJykpKSByZXR1cm4gam9pbihkaXIsICdjbGknLCAnZGlzdCcsICdtYWluLmpzJyk7XHJcbiAgICAgIGNvbnN0IHBhcmVudCA9IGRpcm5hbWUoZGlyKTtcclxuICAgICAgaWYgKHBhcmVudCA9PT0gZGlyKSBicmVhaztcclxuICAgICAgZGlyID0gcGFyZW50O1xyXG4gICAgfVxyXG4gICAgcmV0dXJuICcnO1xyXG4gIH1cclxuICBmdW5jdGlvbiBydW5DbGkoYXJnczogc3RyaW5nW10pOiB2b2lkIHtcclxuICAgIGNvbnN0IGVudHJ5ID0gY2xpRW50cnlPZigpO1xyXG4gICAgaWYgKGVudHJ5ID09PSAnJykgcmV0dXJuO1xyXG4gICAgY29uc3QgaXNUcyA9IGVudHJ5LmVuZHNXaXRoKCcudHMnKTtcclxuICAgIGNvbnN0IHJlcG8gPSByZXBvUm9vdE9mKHJ1bnRpbWVFbnRyeSA/PyBlbnRyeSk7XHJcbiAgICBjb25zdCBjaGlsZCA9IHNwYXduKHByb2Nlc3MuZXhlY1BhdGgsIGlzVHMgPyBbJy0taW1wb3J0JywgJ3RzeCcsIGVudHJ5LCAuLi5hcmdzXSA6IFtlbnRyeSwgLi4uYXJnc10sIHtcclxuICAgICAgY3dkOiBpc1RzID8gcmVwbyA6IGRpcm5hbWUoZW50cnkpLFxyXG4gICAgICBkZXRhY2hlZDogdHJ1ZSxcclxuICAgICAgc3RkaW86ICdpZ25vcmUnLFxyXG4gICAgICB3aW5kb3dzSGlkZTogdHJ1ZSxcclxuICAgICAgZW52OiB7IEVMRUNUUk9OX1JVTl9BU19OT0RFOiAnMScgfSxcclxuICAgIH0pO1xyXG4gICAgY2hpbGQudW5yZWYoKTtcclxuICB9XHJcblxyXG4gIGZ1bmN0aW9uIGJyb2FkY2FzdEhvc3RTdGF0ZShzOiBIb3N0U3RhdGUsIGluZm86IHsgcmVzdGFydENvdW50OiBudW1iZXI7IGxhc3RFcnJvcj86IHN0cmluZyB9KTogdm9pZCB7XHJcbiAgICBicmlkZ2UgPSB7IC4uLmJyaWRnZSwgaG9zdFN0YXRlOiBzLCBob3N0UG9ydDogc3VwZXJ2aXNvcj8uZW5kcG9pbnQ/LnBvcnQgPz8gbnVsbCwgaG9zdFZlcnNpb246IHN1cGVydmlzb3I/LmVuZHBvaW50Py52ZXJzaW9uID8/IG51bGwgfTtcclxuICAgIGxvZ0luZm8oJ2hvc3QnLCBgc3RhdGU9JHtzfSR7aW5mby5sYXN0RXJyb3IgIT09IHVuZGVmaW5lZCA/IGAgZXJyPSR7aW5mby5sYXN0RXJyb3J9YCA6ICcnfWApO1xyXG4gICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XHJcbiAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ2JyaWRnZTpob3N0LXN0YXRlJywgcywgaW5mbyk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvKiogU1NFIFx1NkQ0MVx1OEJBMlx1OTYwNTpcdTRGRTFcdTVDMDEoZXZlbnQ6IGhtaClcdTYyNzlcdTkxQ0ZcdTYzQTggcmVuZGVyZXI7XHU5QUQ4XHU5ODkxIGRlbHRhL2xpbmUgXHU1MzlGXHU1RTI3XHJcbiAgICogIFx1NEY1Q1x1NEUzQVx1NkQ0MVx1NTc1N1x1OEY2Q1x1NTNEMShyZW5kZXJlciBcdTYyRkNcdTYzQTVcdTVGNTNcdTUyNEQgYXNzaXN0YW50IFx1NTM2MFx1NEY0RClcdTMwMDJcdTY1QURcdTdFQkZcdTgxRUFcdTUyQThcdTkxQ0RcdThGREVcdTMwMDIgKi9cclxuICBhc3luYyBmdW5jdGlvbiBwdW1wRXZlbnRzKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgaWYgKGNsaWVudCA9PT0gbnVsbCkgcmV0dXJuO1xyXG4gICAgZm9yICg7Oykge1xyXG4gICAgICBjb25zdCBjID0gY2xpZW50O1xyXG4gICAgICBpZiAoYyA9PT0gbnVsbCkgcmV0dXJuO1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGZvciBhd2FpdCAoY29uc3QgZnJhbWUgb2YgYy5yYXdFdmVudHMobGFzdEV2ZW50SWQgPT09ICcnID8gdW5kZWZpbmVkIDogbGFzdEV2ZW50SWQsIHNzZUFib3J0Py5zaWduYWwpKSB7XHJcbiAgICAgICAgICBpZiAoZnJhbWUuZXZlbnQgPT09ICdobWgnKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGVudiA9IGVudmVsb3BlRnJvbUZyYW1lKGZyYW1lKTtcclxuICAgICAgICAgICAgaWYgKGVudiA9PT0gbnVsbCkge1xyXG4gICAgICAgICAgICAgIGRyb3BwZWRGcmFtZXMgKz0gMTtcclxuICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBsYXN0RXZlbnRJZCA9IGVudi5ldmVudElkO1xyXG4gICAgICAgICAgICBwdXNoRXZlbnQoZW52KTtcclxuICAgICAgICAgIH0gZWxzZSBpZiAoZnJhbWUuZXZlbnQgPT09ICdkZWx0YScgfHwgZnJhbWUuZXZlbnQgPT09ICdsaW5lJykge1xyXG4gICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgIGNvbnN0IGQgPSBKU09OLnBhcnNlKGZyYW1lLmRhdGEpIGFzIHsgc2Vzc2lvbklkPzogc3RyaW5nOyBrPzogc3RyaW5nOyBjaHVuaz86IHN0cmluZzsgdGV4dD86IHN0cmluZyB9O1xyXG4gICAgICAgICAgICAgIGNvbnN0IHBheWxvYWQgPSBmcmFtZS5ldmVudCA9PT0gJ2RlbHRhJ1xyXG4gICAgICAgICAgICAgICAgPyB7IHNlc3Npb25JZDogZC5zZXNzaW9uSWQgPz8gJycsIGtpbmQ6IGQuayA/PyAndGV4dCcsIGNodW5rOiBTdHJpbmcoZC5jaHVuayA/PyAnJykgfVxyXG4gICAgICAgICAgICAgICAgOiB7IHNlc3Npb25JZDogZC5zZXNzaW9uSWQgPz8gJycsIGtpbmQ6ICdsaW5lJywgY2h1bms6IFN0cmluZyhkLnRleHQgPz8gJycpIH07XHJcbiAgICAgICAgICAgICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XHJcbiAgICAgICAgICAgICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCdicmlkZ2U6c3RyZWFtLWNodW5rJywgcGF5bG9hZCk7XHJcbiAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9IGNhdGNoIHsgLyogbWFsZm9ybWVkIHN0cmVhbSBmcmFtZTogc2tpcCAqLyB9XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybjsgLy8gXHU2RDQxXHU2QjYzXHU1RTM4XHU3RUQzXHU2NzVGKGhvc3QgXHU1MTczXHU5NUVEKVxyXG4gICAgICB9IGNhdGNoIHtcclxuICAgICAgICAvLyBcdTY1QURcdTdFQkY6XHU3N0VEXHU5MDAwXHU5MDdGXHU1NDBFXHU5MUNEXHU4RkRFKHN1cGVydmlzb3IgXHU1M0VGXHU4MEZEXHU2QjYzXHU1NzI4XHU5MUNEXHU1NDJGIGhvc3QpXHJcbiAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgMV8wMDApKTtcclxuICAgICAgICBpZiAoc3NlQWJvcnQ/LnNpZ25hbC5hYm9ydGVkKSByZXR1cm47XHJcbiAgICAgIH1cclxuICAgIH1cclxuICB9XHJcblxyXG4gIC8qIC0tLS0gaG1oYXJuZXNzIHJ1bnRpbWUgXHU4MUVBXHU1MkE4XHU1M0QxXHU3M0IwKDIwMjYtMTAtMTAgXHU3NTI4XHU2MjM3XHU1QjlBXHU4QzAzOlx1ODhDNVx1OEZDNyBobWhhcm5lc3MgXHU3Njg0XHJcbiAgICAgXHU2NzNBXHU1NjY4XHU5NkY2XHU5MTREXHU3RjZFXHU3NkY0XHU4RkRFLFx1NTkwRFx1NzUyOCBDTEkvVFVJL3dlYiA3Nzg4IFx1NzY4NFx1NTQwQ1x1NEUwMCBITUhfSE9NRVx1MjAxNFx1MjAxNGNvbmZpZy9wcm92aWRlcnMvXHJcbiAgICAgXHU0RjFBXHU4QkREXHU1Mzg2XHU1M0YyXHU1OTI5XHU3MTM2XHU1MTcxXHU0RUFCKVx1MzAwMnY1LjEgXHU1M0QxXHU3M0IwXHU5ODdBXHU1RThGOlx1NjYzRVx1NUYwRlx1OTE0RFx1N0Y2RSA+IHdoZXJlIGhtaChcdTZFOTBcdTc4MDEgbGluayBcdTRFMEVcclxuICAgICBAaG1oYXJuZXNzL2NsaSBucG0gXHU1Qjg5XHU4OEM1XHU0RTI0XHU3OUNEXHU1RTAzXHU1QzQwKT4gbnBtIFx1NTE2OFx1NUM0MFx1NjgzOShcdTU0MEMpPiBcdTU0MTFcdTVCRkNcdTVCODlcdTg4QzVcdTc2RUVcdTVGNTVcclxuICAgICB+Ly5obWhhcm5lc3MtZ2xvYmFsID4gXHU1RTM4XHU4OUMxXHU2RTkwXHU3ODAxXHU0RjREXHU3RjZFXHUzMDAyICovXHJcbiAgY29uc3QgcnVudGltZUNvbmZpZ0ZpbGUgPSAoKTogc3RyaW5nID0+IGpvaW4oYXBwLmdldFBhdGgoJ3VzZXJEYXRhJyksICdydW50aW1lLmpzb24nKTtcclxuICAvKiogcnVudGltZS5qc29uOnsgZW50cnkoXHU2MjRCXHU1MkE4L1x1NTQxMVx1NUJGQ1x1OTAwOVx1NjJFOVx1NzY4NFx1NTE2NVx1NTNFMyksIGRlbW8oXHU2MzAxXHU0RTQ1XHU2RjE0XHU3OTNBXHU2QTIxXHU1RjBGKSB9XHUzMDAyICovXHJcbiAgYXN5bmMgZnVuY3Rpb24gbG9hZFJ1bnRpbWVDb25maWcoKTogUHJvbWlzZTx7IGVudHJ5OiBzdHJpbmc7IGRlbW86IGJvb2xlYW4gfT4ge1xyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3QgdiA9IEpTT04ucGFyc2UoYXdhaXQgcmVhZEZpbGUocnVudGltZUNvbmZpZ0ZpbGUoKSwgJ3V0ZjgnKSkgYXMgeyBlbnRyeT86IHVua25vd247IGRlbW8/OiB1bmtub3duIH07XHJcbiAgICAgIHJldHVybiB7XHJcbiAgICAgICAgZW50cnk6IHR5cGVvZiB2LmVudHJ5ID09PSAnc3RyaW5nJyAmJiB2LmVudHJ5ICE9PSAnJyAmJiBpc0Fic29sdXRlKHYuZW50cnkpID8gdi5lbnRyeSA6ICcnLFxyXG4gICAgICAgIGRlbW86IHYuZGVtbyA9PT0gdHJ1ZSxcclxuICAgICAgfTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4geyBlbnRyeTogJycsIGRlbW86IGZhbHNlIH07IH1cclxuICB9XHJcbiAgYXN5bmMgZnVuY3Rpb24gc2F2ZVJ1bnRpbWVDb25maWcoY2ZnOiB7IGVudHJ5OiBzdHJpbmc7IGRlbW86IGJvb2xlYW4gfSk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgYXdhaXQgd3JpdGVGaWxlKHJ1bnRpbWVDb25maWdGaWxlKCksIEpTT04uc3RyaW5naWZ5KGNmZywgbnVsbCwgMiksICd1dGY4JykuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcclxuICB9XHJcbiAgYXN5bmMgZnVuY3Rpb24gbG9hZFJ1bnRpbWVFbnRyeU92ZXJyaWRlKCk6IFByb21pc2U8c3RyaW5nPiB7XHJcbiAgICByZXR1cm4gKGF3YWl0IGxvYWRSdW50aW1lQ29uZmlnKCkpLmVudHJ5O1xyXG4gIH1cclxuICBhc3luYyBmdW5jdGlvbiBzYXZlUnVudGltZUVudHJ5T3ZlcnJpZGUoZW50cnk6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgYXdhaXQgc2F2ZVJ1bnRpbWVDb25maWcoeyBlbnRyeSwgZGVtbzogKGF3YWl0IGxvYWRSdW50aW1lQ29uZmlnKCkpLmRlbW8gfSk7XHJcbiAgfVxyXG5cclxuICBpbnRlcmZhY2UgRXh0ZXJuYWxSdW50aW1lIHsgZW50cnk6IHN0cmluZzsgdmVyc2lvbjogc3RyaW5nOyBzb3VyY2U6IHN0cmluZyB9XHJcblxyXG4gIC8qKiBcdThCRkJcdTUzMDVcdTcyNDhcdTY3MkMocGFja2FnZS5qc29uIFx1NzY4NCB2ZXJzaW9uIFx1NUI1N1x1NkJCNTtcdTU5MzFcdThEMjVcdTdBN0FcdTRFMzIpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gcGtnVmVyc2lvbkF0KGRpcjogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHYgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKGRpciwgJ3BhY2thZ2UuanNvbicpLCAndXRmOCcpKSBhcyB7IHZlcnNpb24/OiB1bmtub3duIH07XHJcbiAgICAgIHJldHVybiB0eXBlb2Ygdi52ZXJzaW9uID09PSAnc3RyaW5nJyA/IHYudmVyc2lvbiA6ICcnO1xyXG4gICAgfSBjYXRjaCB7IHJldHVybiAnJzsgfVxyXG4gIH1cclxuICAvKiogXHU4QkZCXHU1MzA1XHU1NDBEKFx1NTQwQ1x1NEUwQTtAaG1oYXJuZXNzL2NsaSBcdTVFMDNcdTVDNDBcdThCQzZcdTUyMkJcdTc1MjgpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gcGtnTmFtZUF0KGRpcjogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHYgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKGRpciwgJ3BhY2thZ2UuanNvbicpLCAndXRmOCcpKSBhcyB7IG5hbWU/OiB1bmtub3duIH07XHJcbiAgICAgIHJldHVybiB0eXBlb2Ygdi5uYW1lID09PSAnc3RyaW5nJyA/IHYubmFtZSA6ICcnO1xyXG4gICAgfSBjYXRjaCB7IHJldHVybiAnJzsgfVxyXG4gIH1cclxuXHJcbiAgLyoqIG5wbSBcdTVCODlcdTg4QzVcdTc2ODQgQGhtaGFybmVzcy9jbGkgXHUyMTkyIGRlc2t0b3AtaG9zdCBcdTdGMTZcdThCRDFcdTUxNjVcdTUzRTMoXHU1RDRDXHU1OTU3XHU0RTBFXHU2M0QwXHU1MzQ3XHU0RTI0XHU3OUNEXHU1RTAzXHU1QzQwKVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIGVudHJ5RnJvbUNsaURpcihjbGlEaXI6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICBjb25zdCBuZXN0ZWQgPSBqb2luKGNsaURpciwgJ25vZGVfbW9kdWxlcycsICdAaG1oYXJuZXNzJywgJ3dlYicsICdkaXN0JywgJ2Rlc2t0b3AtaG9zdC5qcycpO1xyXG4gICAgaWYgKGV4aXN0c1N5bmMobmVzdGVkKSkgcmV0dXJuIG5lc3RlZDtcclxuICAgIGNvbnN0IGhvaXN0ZWQgPSBqb2luKGRpcm5hbWUoY2xpRGlyKSwgJ3dlYicsICdkaXN0JywgJ2Rlc2t0b3AtaG9zdC5qcycpO1xyXG4gICAgaWYgKGV4aXN0c1N5bmMoaG9pc3RlZCkpIHJldHVybiBob2lzdGVkO1xyXG4gICAgcmV0dXJuICcnO1xyXG4gIH1cclxuXHJcbiAgLyoqIFx1NTkxNlx1OTBFOFx1NTNEMVx1NzNCMChcdTRGOUJcdTgxRUFcdTUyQThcdThGREVcdTYzQTVcdTRFMEVcdTU0MTFcdTVCRkNcdTY4QzBcdTZENEJcdTk4NzVcdTUxNzFcdTc1MjgpXHUzMDAyXHU0RjE4XHU1MTQ4XHU3RUE3OmVudiA+IHdoZXJlIGhtaCA+IG5wbVxyXG4gICAqICBcdTUxNjhcdTVDNDBcdTY4MzkgPiBcdTU0MTFcdTVCRkNcdTVCODlcdTg4QzVcdTc2RUVcdTVGNTUgfi8uaG1oYXJuZXNzLWdsb2JhbCA+IFx1NkU5MFx1NzgwMVx1NEVEM1x1NjI2Qlx1NjNDRjtcdTU0MENcdTRFMDBcdTVDNDJcdTUxODVcclxuICAgKiAgXCJcdTVERjJcdTg4QzUgQ0xJKG5wbSBcdTVFMDNcdTVDNDApXCIgXHU1MTQ4XHU0RThFIFwiXHU2RTkwXHU3ODAxIHJlcG8gXHU1RTAzXHU1QzQwXCJcdTMwMDIgKi9cclxuICBmdW5jdGlvbiBkZXRlY3RFeHRlcm5hbFJ1bnRpbWUoKTogRXh0ZXJuYWxSdW50aW1lIHtcclxuICAgIC8vIDEpIFx1NzNBRlx1NTg4M1x1NTNEOFx1OTFDRlx1NjYzRVx1NUYwRlx1ODk4Nlx1NzZENihcdTlBRDhcdTdFQTdcdTc1MjhcdTYyMzcpXHJcbiAgICBjb25zdCBlbnZFbnRyeSA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1JFQUxfRU5UUlk7XHJcbiAgICBpZiAoZW52RW50cnkgIT09IHVuZGVmaW5lZCAmJiBlbnZFbnRyeSAhPT0gJycgJiYgaXNBYnNvbHV0ZShlbnZFbnRyeSkpIHtcclxuICAgICAgcmV0dXJuIHsgZW50cnk6IGVudkVudHJ5LCB2ZXJzaW9uOiAnJywgc291cmNlOiAnZW52JyB9O1xyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IHdoZXJlUmVwb3MgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgIGNvbnN0IHdoZXJlQ2xpczogc3RyaW5nW10gPSBbXTtcclxuICAgIGNvbnN0IG5wbVJlcG9zID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICBsZXQgbnBtQ2xpID0gJyc7XHJcbiAgICAvLyAyKSB3aGVyZSBobWg6bnBtIGxpbmsoXHU2RTkwXHU3ODAxXHU2ODM5XHU1RTAzXHU1QzQwKVx1NEUwRSBAaG1oYXJuZXNzL2NsaSBucG0gXHU1Qjg5XHU4OEM1XHU1RTAzXHU1QzQwXHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCBvdXQgPSBleGVjRmlsZVN5bmMoJ3doZXJlJywgWydobWgnXSwgeyBlbmNvZGluZzogJ3V0ZjgnLCB0aW1lb3V0OiA0XzAwMCwgd2luZG93c0hpZGU6IHRydWUgfSk7XHJcbiAgICAgIGZvciAoY29uc3QgbGluZSBvZiBvdXQuc3BsaXQoL1xccj9cXG4vKSkge1xyXG4gICAgICAgIGNvbnN0IGJpbiA9IGxpbmUudHJpbSgpO1xyXG4gICAgICAgIGlmIChiaW4gPT09ICcnKSBjb250aW51ZTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgY29uc3QgYmluRGlyID0gZGlybmFtZShiaW4pO1xyXG4gICAgICAgICAgY29uc3QgbGlua2VkID0gam9pbihiaW5EaXIsICdub2RlX21vZHVsZXMnLCAnaG1oYXJuZXNzJyk7XHJcbiAgICAgICAgICBpZiAoZXhpc3RzU3luYyhsaW5rZWQpKSB3aGVyZVJlcG9zLmFkZChyZWFscGF0aFN5bmMobGlua2VkKSk7XHJcbiAgICAgICAgICBjb25zdCBjbGkgPSBqb2luKGJpbkRpciwgJ25vZGVfbW9kdWxlcycsICdAaG1oYXJuZXNzJywgJ2NsaScpO1xyXG4gICAgICAgICAgaWYgKGV4aXN0c1N5bmMoY2xpKSkgd2hlcmVDbGlzLnB1c2goY2xpKTtcclxuICAgICAgICB9IGNhdGNoIHsgLyogYmluIFx1NUUwM1x1NUM0MFx1NEUwRFx1N0IyNixcdThERjNcdThGQzcgKi8gfVxyXG4gICAgICB9XHJcbiAgICB9IGNhdGNoIHsgLyogaG1oIFx1NEUwRFx1NTcyOCBQQVRIICovIH1cclxuICAgIC8vIDMpIG5wbSBcdTUxNjhcdTVDNDBcdTY4MzkoXHU0RTI0XHU3OUNEXHU1RTAzXHU1QzQwXHU1NDBDIHdoZXJlKVxyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3Qgb3V0ID0gZXhlY0ZpbGVTeW5jKCducG0nLCBbJ3Jvb3QnLCAnLWcnXSwgeyBlbmNvZGluZzogJ3V0ZjgnLCB0aW1lb3V0OiA2XzAwMCwgd2luZG93c0hpZGU6IHRydWUgfSk7XHJcbiAgICAgIGNvbnN0IHJvb3QgPSBvdXQudHJpbSgpO1xyXG4gICAgICBjb25zdCBsaW5rZWQgPSBqb2luKHJvb3QsICdobWhhcm5lc3MnKTtcclxuICAgICAgaWYgKGV4aXN0c1N5bmMobGlua2VkKSkgbnBtUmVwb3MuYWRkKHJlYWxwYXRoU3luYyhsaW5rZWQpKTtcclxuICAgICAgY29uc3QgY2xpID0gam9pbihyb290LCAnQGhtaGFybmVzcycsICdjbGknKTtcclxuICAgICAgaWYgKGV4aXN0c1N5bmMoY2xpKSkgbnBtQ2xpID0gY2xpO1xyXG4gICAgfSBjYXRjaCB7IC8qIG5wbSBcdTRFMERcdTUzRUZcdTc1MjggKi8gfVxyXG5cclxuICAgIC8vIFx1NURGMlx1ODhDNSBDTEkoQGhtaGFybmVzcy9jbGkgbnBtIFx1NUUwM1x1NUM0MDtkZXNrdG9wLWhvc3QgXHU0RTNBXHU3RjE2XHU4QkQxXHU0RUE3XHU3MjY5XHU1M0VGXHU3NkY0XHU4REQxKTpcclxuICAgIC8vIHdoZXJlKFBBVEggXHU3NzFGXHU3NkY4KT4gbnBtIFx1NTE2OFx1NUM0MFx1NjgzOSA+IFx1NTQxMVx1NUJGQ1x1NUI4OVx1ODhDNVx1NzZFRVx1NUY1NVxyXG4gICAgZm9yIChjb25zdCBbY2xpLCBzb3VyY2VdIG9mIFtbd2hlcmVDbGlzWzBdID8/ICcnLCAnd2hlcmUtaG1oJ10sIFtucG1DbGksICducG0tZ2xvYmFsJ11dIGFzIEFycmF5PFtzdHJpbmcsIHN0cmluZ10+KSB7XHJcbiAgICAgIGlmIChjbGkgPT09ICcnKSBjb250aW51ZTtcclxuICAgICAgY29uc3QgZW50cnkgPSBlbnRyeUZyb21DbGlEaXIoY2xpKTtcclxuICAgICAgaWYgKGVudHJ5ICE9PSAnJykgcmV0dXJuIHsgZW50cnksIHZlcnNpb246IHBrZ1ZlcnNpb25BdChjbGkpLCBzb3VyY2UgfTtcclxuICAgIH1cclxuICAgIGNvbnN0IHdpemFyZEVudHJ5ID0gcmVzb2x2ZUluc3RhbGxlZEVudHJ5KGluc3RhbGxUYXJnZXQoKSk7XHJcbiAgICBpZiAod2l6YXJkRW50cnkgIT09ICcnKSB7XHJcbiAgICAgIHJldHVybiB7IGVudHJ5OiB3aXphcmRFbnRyeSwgdmVyc2lvbjogcGtnVmVyc2lvbkF0KGpvaW4oaW5zdGFsbFRhcmdldCgpLCAnbm9kZV9tb2R1bGVzJywgJ0BobWhhcm5lc3MnLCAnY2xpJykpLCBzb3VyY2U6ICd3aXphcmQtaW5zdGFsbCcgfTtcclxuICAgIH1cclxuXHJcbiAgICAvLyBcdTZFOTBcdTc4MDEgcmVwbyBcdTVFMDNcdTVDNDAod2hlcmUgPiBucG0gXHU1MTY4XHU1QzQwID4gXHU1RTM4XHU4OUMxXHU2RTkwXHU3ODAxXHU0RjREXHU3RjZFO1x1NTQ3RFx1NEUyRFx1OTg3Qlx1NjcwOVx1NTE2NVx1NTNFM1x1NEUwRVx1NEY5RFx1OEQ1NilcclxuICAgIGNvbnN0IHJlcG9zID0gbmV3IFNldDxzdHJpbmc+KFsuLi53aGVyZVJlcG9zLCAuLi5ucG1SZXBvc10pO1xyXG4gICAgY29uc3QgYmFzZXMgPSBbJ0M6XFxcXCcsICdEOlxcXFwnLCAnRTpcXFxcJywgJ0Y6XFxcXCcsICdHOlxcXFwnLCAnSDpcXFxcJywgaG9tZWRpcigpLCBqb2luKGhvbWVkaXIoKSwgJ0RldmVsb3BlcicpXTtcclxuICAgIGZvciAoY29uc3QgYmFzZSBvZiBiYXNlcykge1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHAgPSByZXNvbHZlKGJhc2UsICdobWhhcm5lc3MnKTtcclxuICAgICAgICBpZiAoZXhpc3RzU3luYyhwKSkgcmVwb3MuYWRkKHApO1xyXG4gICAgICB9IGNhdGNoIHsgLyogXHU3NkQ4XHU0RTBEXHU1QjU4XHU1NzI4ICovIH1cclxuICAgIH1cclxuICAgIGZvciAoY29uc3QgcmVwbyBvZiByZXBvcykge1xyXG4gICAgICBjb25zdCBlbnRyeSA9IGpvaW4ocmVwbywgJ3BhY2thZ2VzJywgJ3dlYicsICdzcmMnLCAnZGVza3RvcC1ob3N0LnRzJyk7XHJcbiAgICAgIGlmIChleGlzdHNTeW5jKGVudHJ5KSAmJiBleGlzdHNTeW5jKGpvaW4ocmVwbywgJ25vZGVfbW9kdWxlcycpKSkge1xyXG4gICAgICAgIHJldHVybiB7IGVudHJ5LCB2ZXJzaW9uOiBwa2dWZXJzaW9uQXQocmVwbyksIHNvdXJjZTogJ3NvdXJjZS1yZXBvJyB9O1xyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4geyBlbnRyeTogJycsIHZlcnNpb246ICcnLCBzb3VyY2U6ICcnIH07XHJcbiAgfVxyXG5cclxuICBmdW5jdGlvbiBkZXRlY3RSZWFsRW50cnkoKTogc3RyaW5nIHtcclxuICAgIHJldHVybiBkZXRlY3RFeHRlcm5hbFJ1bnRpbWUoKS5lbnRyeTtcclxuICB9XHJcblxyXG4gIC8qKiBcdTg5RTNcdTY3OTAgcnVudGltZSBcdTUxNjVcdTUzRTNcdTYyNDBcdTVDNUVcdTc2ODQgaG1oYXJuZXNzIFx1NEVEM1x1NUU5M1x1NjgzOShwYWNrYWdlcy93ZWIvc3JjfGRpc3QgXHU0RTBBXHU2RUFGKVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIHJlcG9Sb290T2YoZW50cnk6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICBsZXQgZGlyID0gZGlybmFtZShlbnRyeSk7XHJcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IDY7IGkrKykge1xyXG4gICAgICBpZiAoZXhpc3RzU3luYyhqb2luKGRpciwgJ3BhY2thZ2UuanNvbicpKSAmJiBleGlzdHNTeW5jKGpvaW4oZGlyLCAncGFja2FnZXMnLCAnd2ViJykpKSByZXR1cm4gZGlyO1xyXG4gICAgICBjb25zdCBwYXJlbnQgPSBkaXJuYW1lKGRpcik7XHJcbiAgICAgIGlmIChwYXJlbnQgPT09IGRpcikgYnJlYWs7XHJcbiAgICAgIGRpciA9IHBhcmVudDtcclxuICAgIH1cclxuICAgIHJldHVybiBkaXJuYW1lKGVudHJ5KTtcclxuICB9XHJcblxyXG4gIGxldCBydW50aW1lRW50cnkgPSAnJzsgLy8gXHU1RjUzXHU1MjREXHU1QjlFXHU5NjQ1XHU0RjdGXHU3NTI4XHU3Njg0XHU3NzFGXHU1QjlFIHJ1bnRpbWUgXHU1MTY1XHU1M0UzKCcnPVx1NjcyQVx1NjNBNSlcclxuICBsZXQgdXNlQnVuZGxlZFJ1bnRpbWUgPSBmYWxzZTsgLy8gdjU6XHU2NjJGXHU1NDI2XHU1NzI4XHU3NTI4XHU1MTg1XHU3RjZFIHJ1bnRpbWUoXHU1MTczXHU0RThFL1x1OTc2Mlx1Njc3Rlx1NjgwN1x1NkNFOClcclxuXHJcbiAgLyoqIFx1NTE4NVx1N0Y2RSBydW50aW1lKHY1IFx1NUYwMFx1N0JCMVx1NTM3M1x1NzUyOCk6XHU2MjUzXHU1MzA1XHU1NDBFXHU5NjhGIGV4dHJhUmVzb3VyY2VzIFx1NUU3M1x1OTRGQVx1NTcyOCByZXNvdXJjZXMvO1xyXG4gICAgIGRldiBcdTc1MjhcdTRFRDNcdTVFOTNcdTUxODVcdTY3ODRcdTVFRkFcdTRFQTdcdTcyNjkoc2NyaXB0cy9idW5kbGUtcnVudGltZS5tanMpXHUzMDAyXHU4MUVBXHU1MzA1XHU1NDJCXHU1MzU1XHU2NTg3XHU0RUY2LFx1NjVFMCB0c3hcdTMwMDFcclxuICAgICBcdTY1RTAgcmVwbyBub2RlX21vZHVsZXMgXHU0RjlEXHU4RDU2XHUzMDAyICovXHJcbiAgZnVuY3Rpb24gYnVuZGxlZFJ1bnRpbWVQYXRoKHJlcG9Sb290OiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIGpvaW4oYXBwLmlzUGFja2FnZWQgPyBwcm9jZXNzLnJlc291cmNlc1BhdGggOiBqb2luKHJlcG9Sb290LCAnYXBwcycsICdkZXNrdG9wJywgJ3Jlc291cmNlcycpLCAncnVudGltZScsICdydW50aW1lLmNqcycpO1xyXG4gIH1cclxuXHJcbiAgLyoqIFx1NTE4NVx1N0Y2RSBydW50aW1lIFx1NTE0M1x1NEZFMVx1NjA2RihcdTU0MTFcdTVCRkNcIlx1NTE4NVx1N0Y2RVx1N0NCRVx1N0I4MFx1NTE4NVx1NjgzOFwiXHU5MDA5XHU5ODc5XHU3Njg0XHU3MjQ4XHU2NzJDXHU2ODA3XHU2Q0U4KVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIGJ1bmRsZWRSdW50aW1lSW5mbygpOiB7IHJlYWR5OiBib29sZWFuOyB2ZXJzaW9uOiBzdHJpbmcgfSB7XHJcbiAgICBjb25zdCByZXBvUm9vdCA9IGpvaW4oaGVyZSwgJy4uJywgJy4uJywgJy4uJywgJy4uJyk7XHJcbiAgICBjb25zdCBwID0gYnVuZGxlZFJ1bnRpbWVQYXRoKHJlcG9Sb290KTtcclxuICAgIGxldCB2ZXJzaW9uID0gJyc7XHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCB2ID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoam9pbihkaXJuYW1lKHApLCAncGFja2FnZS5qc29uJyksICd1dGY4JykpIGFzIHsgdmVyc2lvbj86IHVua25vd24gfTtcclxuICAgICAgdmVyc2lvbiA9IHR5cGVvZiB2LnZlcnNpb24gPT09ICdzdHJpbmcnID8gdi52ZXJzaW9uIDogJyc7XHJcbiAgICB9IGNhdGNoIHsgLyogXHU1MTQzXHU2NTcwXHU2MzZFXHU3RjNBXHU1OTMxXHU1MjE5XHU1M0VBXHU2MkE1IHJlYWR5ICovIH1cclxuICAgIHJldHVybiB7IHJlYWR5OiBleGlzdHNTeW5jKHApLCB2ZXJzaW9uIH07XHJcbiAgfVxyXG5cclxuICAvKiogbnBtIFx1NjYyRlx1NTQyNlx1NTcyOCBQQVRIKFx1NTQxMVx1NUJGQ1x1OTAwOVx1NjJFOVx1OTg3NSBcdTI0NjAgXHU3Njg0XHU1Qjg5XHU4OEM1XHU2NUI5XHU1RjBGXHU2ODA3XHU2Q0U4O3doZXJlIFx1NUZFQlx1NjNBMixcdTRFMERcdTUwNUFcdTVCOENcdTY1NzRcdTYzQTJcdTZENEIpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gbnBtT25QYXRoKCk6IGJvb2xlYW4ge1xyXG4gICAgdHJ5IHtcclxuICAgICAgZXhlY0ZpbGVTeW5jKCd3aGVyZScsIFsnbnBtJ10sIHsgZW5jb2Rpbmc6ICd1dGY4JywgdGltZW91dDogNF8wMDAsIHdpbmRvd3NIaWRlOiB0cnVlIH0pO1xyXG4gICAgICByZXR1cm4gdHJ1ZTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4gZmFsc2U7IH1cclxuICB9XHJcblxyXG4gIC8qIC0tLS0gXHU5OTk2XHU1NDJGXHU1Qjg5XHU4OEM1XHU1NDExXHU1QkZDXHU3MkI2XHU2MDAxKHY1LjEpIC0tLS0gKi9cclxuICBjb25zdCB3aXphcmRGaWxlID0gKCk6IHN0cmluZyA9PiBqb2luKGFwcC5nZXRQYXRoKCd1c2VyRGF0YScpLCAnd2l6YXJkLmpzb24nKTtcclxuICBhc3luYyBmdW5jdGlvbiBsb2FkV2l6YXJkU3RhdGUoKTogUHJvbWlzZTx7IGRvbmU6IGJvb2xlYW47IGNob2ljZTogc3RyaW5nIH0+IHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHYgPSBKU09OLnBhcnNlKGF3YWl0IHJlYWRGaWxlKHdpemFyZEZpbGUoKSwgJ3V0ZjgnKSkgYXMgeyBkb25lPzogdW5rbm93bjsgY2hvaWNlPzogdW5rbm93biB9O1xyXG4gICAgICByZXR1cm4geyBkb25lOiB2LmRvbmUgPT09IHRydWUsIGNob2ljZTogdHlwZW9mIHYuY2hvaWNlID09PSAnc3RyaW5nJyA/IHYuY2hvaWNlIDogJycgfTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4geyBkb25lOiBmYWxzZSwgY2hvaWNlOiAnJyB9OyB9XHJcbiAgfVxyXG4gIGFzeW5jIGZ1bmN0aW9uIHNhdmVXaXphcmRTdGF0ZShjaG9pY2U6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgYXdhaXQgd3JpdGVGaWxlKHdpemFyZEZpbGUoKSwgSlNPTi5zdHJpbmdpZnkoeyBkb25lOiB0cnVlLCBjaG9pY2UgfSwgbnVsbCwgMiksICd1dGY4JykuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcclxuICB9XHJcbiAgLyoqIFx1NTQxMVx1NUJGQ1x1ODFFQVx1NTJBOFx1NUYzOVx1NTFGQVx1NjI5MVx1NTIzNjpcdTZENEJcdThCRDUvXHU1RjAwXHU1M0QxXHU3M0FGXHU1ODgzXHU0RTBEXHU1RjM5KFVJVkVSSUZZL1NOQVBTSE9UL1JFTkRFUl9URVNUL1xyXG4gICAqICBET01QUk9CRS9TRUNVUklUWV9URVNUL0ZBS0UvZGV2KTtITUhfREVTS1RPUF9XSVpBUkRfRk9SQ0U9MSBcdTVGM0FcdTUyMzZcdTVGMzkoXHU5QThDXHU2NTM2KVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIHdpemFyZFN1cHByZXNzZWQoKTogYm9vbGVhbiB7XHJcbiAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfV0laQVJEX0ZPUkNFID09PSAnMScpIHJldHVybiBmYWxzZTtcclxuICAgIHJldHVybiBpc0RldlxyXG4gICAgICB8fCBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWSA9PT0gJzEnXHJcbiAgICAgIHx8IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NOQVBTSE9UICE9PSB1bmRlZmluZWRcclxuICAgICAgfHwgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfUkVOREVSX1RFU1QgPT09ICcxJ1xyXG4gICAgICB8fCBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9ET01QUk9CRSA9PT0gJzEnXHJcbiAgICAgIHx8IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NFQ1VSSVRZX1RFU1QgPT09ICcxJ1xyXG4gICAgICB8fCBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9GQUtFID09PSAnMSc7XHJcbiAgfVxyXG5cclxuICAvKiogXHU1M0QxXHU3M0IwXHU5ODdBXHU1RThGOlx1NjYzRVx1NUYwRlx1ODk4Nlx1NzZENihcdTU0MkJcdTU0MTFcdTVCRkNcdTkwMDlcdTYyRTk6XHU1OTE2XHU5MEU4XHU1MTY1XHU1M0UzL1x1NTE4NVx1N0Y2RVx1OERFRlx1NUY4NC9cdTZGMTRcdTc5M0EpPiBcdTUxODVcdTdGNkVcdTVGMDBcdTUxNzNcclxuICAgICAoSE1IX0RFU0tUT1BfQlVORExFRD0xKT4gXHU1OTE2XHU5MEU4XHU1M0QxXHU3M0IwKGRldiBcdTc2RjhcdTkwQkJcdTRFRDNcdTVFOTMgLyB3aGVyZSBobWggLyBucG0gXHU1MTY4XHU1QzQwIC9cclxuICAgICBcdTU0MTFcdTVCRkNcdTVCODlcdTg4QzVcdTc2RUVcdTVGNTUgLyBcdTZFOTBcdTc4MDFcdTRGNERcdTdGNkUpPiBcdTUxODVcdTdGNkVcdTUxNUNcdTVFOTVcdTMwMDJcdTU5MTZcdTkwRThcdTRGMThcdTUxNDg9XHU4MDAxXHU3NTI4XHU2MjM3XHU3RUU3XHU3RUVEXHU3NTI4XHU4MUVBXHU1REYxXHU4OEM1XHU3Njg0XHU3MjQ4XHU2NzJDO1xyXG4gICAgIFx1NTE4NVx1N0Y2RT1cdTY1QjBcdTY3M0FcdTU2NjhcdTg4QzVcdTVCOENcdTc2RjRcdThGREVcdTc3MUZcdTVCOUVcdTUxODVcdTY4MzhcdTMwMDJITUhfREVTS1RPUF9GQUtFPTEgXHU2MjE2IHJ1bnRpbWUuanNvbiBkZW1vPXRydWVcclxuICAgICAoXHU1NDExXHU1QkZDXCJcdTZGMTRcdTc5M0FcdTZBMjFcdTVGMEZcIlx1OTAwOVx1NjJFOSxcdTYzMDFcdTRFNDUpXHU4RkRCXHU2RjE0XHU3OTNBXHUzMDAyICovXHJcbiAgYXN5bmMgZnVuY3Rpb24gc3RhcnRIb3N0KCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3QgcmVwb1Jvb3QgPSBqb2luKGhlcmUsICcuLicsICcuLicsICcuLicsICcuLicpOyAvLyBhcHBzL2Rlc2t0b3AvZGlzdC1lbGVjdHJvbi9tYWluIFx1MjE5MiByZXBvIHJvb3RcclxuICAgIGNvbnN0IHBhY2thZ2VkID0gYXBwLmlzUGFja2FnZWQ7XHJcbiAgICBjb25zdCBjZmcgPSBhd2FpdCBsb2FkUnVudGltZUNvbmZpZygpO1xyXG4gICAgY29uc3QgZm9yY2VGYWtlID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfRkFLRSA9PT0gJzEnIHx8IGNmZy5kZW1vO1xyXG4gICAgY29uc3QgZm9yY2VCdW5kbGVkID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfQlVORExFRCA9PT0gJzEnO1xyXG4gICAgY29uc3Qgb3ZlcnJpZGUgPSBjZmcuZW50cnk7XHJcbiAgICBjb25zdCBhZGphY2VudCA9IGpvaW4ocmVwb1Jvb3QsICcuLicsICdobWhhcm5lc3MnLCAncGFja2FnZXMnLCAnd2ViJywgJ3NyYycsICdkZXNrdG9wLWhvc3QudHMnKTtcclxuICAgIGNvbnN0IGJ1bmRsZWQgPSBidW5kbGVkUnVudGltZVBhdGgocmVwb1Jvb3QpO1xyXG4gICAgY29uc3QgYnVuZGxlZFJlYWR5ID0gZXhpc3RzU3luYyhidW5kbGVkKTtcclxuICAgIC8vIFx1ODlFM1x1Njc5MChcdTdFRDNcdTY3OUNcdTVGNTJcdTRFMDA6b3ZlcnJpZGU9YnVuZGxlZCBcdThERUZcdTVGODRcdTIxOTJcdTUxODVcdTdGNkU7XHU2RTkwXHU3ODAxIC50cyBcdTk3MDAgdHN4O1xyXG4gICAgLy8gbnBtIFx1NUI4OVx1ODhDNSAuanMgXHU3RjE2XHU4QkQxXHU0RUE3XHU3MjY5XHU3NkY0XHU4REQxO2J1bmRsZWQ9XHU4MUVBXHU1MzA1XHU1NDJCIGNqcyBcdTc2RjRcdThERDEpXHJcbiAgICBsZXQgZW50cnkgPSAnJztcclxuICAgIHVzZUJ1bmRsZWRSdW50aW1lID0gZmFsc2U7XHJcbiAgICBpZiAoZm9yY2VGYWtlKSB7XHJcbiAgICAgIC8vIFx1NkYxNFx1NzkzQVx1NkEyMVx1NUYwRlxyXG4gICAgfSBlbHNlIGlmIChvdmVycmlkZSAhPT0gJycpIHtcclxuICAgICAgZW50cnkgPSBvdmVycmlkZTtcclxuICAgICAgaWYgKG92ZXJyaWRlID09PSBidW5kbGVkKSB1c2VCdW5kbGVkUnVudGltZSA9IHRydWU7IC8vIFx1NTQxMVx1NUJGQ1x1OTAwOVwiXHU1MTg1XHU3RjZFXHU3Q0JFXHU3QjgwXHU1MTg1XHU2ODM4XCJcdTc2ODRcdTYzMDFcdTRFNDVcdTVGNjJcdTYwMDFcclxuICAgIH0gZWxzZSBpZiAoZm9yY2VCdW5kbGVkKSB7XHJcbiAgICAgIGlmIChidW5kbGVkUmVhZHkpIHsgZW50cnkgPSBidW5kbGVkOyB1c2VCdW5kbGVkUnVudGltZSA9IHRydWU7IH1cclxuICAgICAgZWxzZSBsb2dJbmZvKCdob3N0JywgJ0hNSF9ERVNLVE9QX0JVTkRMRUQ9MSBcdTRGNDZcdTUxODVcdTdGNkUgcnVudGltZSBcdTdGM0FcdTU5MzEoXHU1MTQ4XHU4REQxIHNjcmlwdHMvYnVuZGxlLXJ1bnRpbWUubWpzKScpO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgZW50cnkgPSBwYWNrYWdlZCA/IGRldGVjdFJlYWxFbnRyeSgpIDogKGV4aXN0c1N5bmMoYWRqYWNlbnQpID8gYWRqYWNlbnQgOiBkZXRlY3RSZWFsRW50cnkoKSk7XHJcbiAgICAgIGlmIChlbnRyeSA9PT0gJycgJiYgYnVuZGxlZFJlYWR5KSB7IGVudHJ5ID0gYnVuZGxlZDsgdXNlQnVuZGxlZFJ1bnRpbWUgPSB0cnVlOyB9XHJcbiAgICB9XHJcbiAgICBydW50aW1lRW50cnkgPSBlbnRyeTtcclxuICAgIGNvbnN0IHVzZVJlYWwgPSBlbnRyeSAhPT0gJycgJiYgKHVzZUJ1bmRsZWRSdW50aW1lIHx8IGV4aXN0c1N5bmMoZW50cnkpKTtcclxuICAgIGJyaWRnZSA9IHtcclxuICAgICAgLi4uYnJpZGdlLFxyXG4gICAgICBtb2RlOiB1c2VSZWFsID8gJ3JlYWwnIDogJ2Zha2UnLFxyXG4gICAgICBydW50aW1lRW50cnk6IHVzZVJlYWwgPyAodXNlQnVuZGxlZFJ1bnRpbWUgPyBgJHtlbnRyeX0gKGJ1bmRsZWQpYCA6IGVudHJ5KSA6IG51bGwsXHJcbiAgICB9O1xyXG4gICAgbGV0IHNwZWM6IHsgY29tbWFuZDogc3RyaW5nOyBhcmdzOiBzdHJpbmdbXTsgZW52OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+OyBjd2Q/OiBzdHJpbmcgfTtcclxuICAgIGlmICh1c2VCdW5kbGVkUnVudGltZSkge1xyXG4gICAgICBzcGVjID0ge1xyXG4gICAgICAgIGNvbW1hbmQ6IHByb2Nlc3MuZXhlY1BhdGgsXHJcbiAgICAgICAgYXJnczogW2VudHJ5XSwgLy8gXHU4MUVBXHU1MzA1XHU1NDJCXHU1MzU1XHU2NTg3XHU0RUY2OmVsZWN0cm9uLWFzLW5vZGUgXHU3NkY0XHU4REQxLFx1NjVFMCB0c3ggXHU2NUUwIHJlcG9cclxuICAgICAgICBlbnY6IHsgRUxFQ1RST05fUlVOX0FTX05PREU6ICcxJyB9LFxyXG4gICAgICB9O1xyXG4gICAgfSBlbHNlIGlmICh1c2VSZWFsICYmIGVudHJ5LmVuZHNXaXRoKCcuanMnKSkge1xyXG4gICAgICBzcGVjID0ge1xyXG4gICAgICAgIGNvbW1hbmQ6IHByb2Nlc3MuZXhlY1BhdGgsXHJcbiAgICAgICAgYXJnczogW2VudHJ5XSwgLy8gbnBtIFx1NUI4OVx1ODhDNVx1NzY4NFx1N0YxNlx1OEJEMVx1NEVBN1x1NzI2OTpFU00gXHU0RjlEXHU4RDU2XHU2MzA5XHU2NTg3XHU0RUY2XHU0RjREXHU3RjZFXHU4OUUzXHU2NzkwLFx1NzZGNFx1OEREMVx1NTM3M1x1NTNFRlxyXG4gICAgICAgIGN3ZDogZGlybmFtZShlbnRyeSksXHJcbiAgICAgICAgZW52OiB7IEVMRUNUUk9OX1JVTl9BU19OT0RFOiAnMScgfSxcclxuICAgICAgfTtcclxuICAgIH0gZWxzZSBpZiAodXNlUmVhbCkge1xyXG4gICAgICBjb25zdCByZXBvID0gcmVwb1Jvb3RPZihlbnRyeSk7XHJcbiAgICAgIHNwZWMgPSB7XHJcbiAgICAgICAgY29tbWFuZDogcHJvY2Vzcy5leGVjUGF0aCxcclxuICAgICAgICBhcmdzOiBbJy0taW1wb3J0JywgJ3RzeCcsIGVudHJ5XSxcclxuICAgICAgICBjd2Q6IHJlcG8sIC8vIGJhcmUgJ3RzeCcgXHU0RTBFIHdvcmtzcGFjZSBcdTRGOURcdThENTZcdTkwRkRcdTRFQ0UgcmVwbyBcdTc2ODQgbm9kZV9tb2R1bGVzIFx1ODlFM1x1Njc5MFxyXG4gICAgICAgIGVudjogeyBFTEVDVFJPTl9SVU5fQVNfTk9ERTogJzEnIH0sXHJcbiAgICAgIH07XHJcbiAgICB9IGVsc2UgaWYgKHBhY2thZ2VkKSB7XHJcbiAgICAgIHNwZWMgPSB7XHJcbiAgICAgICAgY29tbWFuZDogcHJvY2Vzcy5leGVjUGF0aCxcclxuICAgICAgICBhcmdzOiBbam9pbihwcm9jZXNzLnJlc291cmNlc1BhdGgsICdmYWtlLWhvc3QuY2pzJyldLFxyXG4gICAgICAgIGVudjogeyBFTEVDVFJPTl9SVU5fQVNfTk9ERTogJzEnIH0sXHJcbiAgICAgIH07XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICBzcGVjID0ge1xyXG4gICAgICAgIGNvbW1hbmQ6IHByb2Nlc3MuZXhlY1BhdGgsXHJcbiAgICAgICAgLy8gXHU3NkY0XHU2M0E1XHU4RDcwXHU1MzA1XHU3NzFGXHU1QjlFXHU4REVGXHU1Rjg0KG5vZGVfbW9kdWxlcyBcdTkxQ0NcdTc2ODQgd29ya3NwYWNlIGp1bmN0aW9uIFx1NEYxQVx1ODhBQiBFU01cclxuICAgICAgICAvLyByZWFscGF0aCBcdTUzMTYsXHU1QkZDXHU4MUY0IGZha2UtaG9zdCBcdTc2ODQgYXJndlsxXS9pbXBvcnQubWV0YS51cmwgXHU1MzM5XHU5MTREXHU1OTMxXHU2NTQ4KVxyXG4gICAgICAgIGFyZ3M6IFsnLS1pbXBvcnQnLCAndHN4Jywgam9pbihyZXBvUm9vdCwgJ3BhY2thZ2VzJywgJ2hvc3QtYWRhcHRlcicsICdzcmMnLCAnZmFrZS1ob3N0LnRzJyldLFxyXG4gICAgICAgIGVudjogeyBFTEVDVFJPTl9SVU5fQVNfTk9ERTogJzEnIH0sXHJcbiAgICAgIH07XHJcbiAgICB9XHJcbiAgICBzdXBlcnZpc29yID0gbmV3IERlc2t0b3BSdW50aW1lU3VwZXJ2aXNvcihzcGVjLCB7XHJcbiAgICAgIG9uU3RhdGVDaGFuZ2U6IGJyb2FkY2FzdEhvc3RTdGF0ZSxcclxuICAgICAgLy8gXHU5OTk2XHU2QjIxXHU1NDJGXHU1MkE4XHU0RTBFIGNyYXNoIFx1ODFFQVx1NjEwOFx1NTQwRVx1NzY4NFx1OTFDRFx1NTQyRlx1OTBGRFx1NEYxQVx1OEQ3MFx1OEZEOVx1OTFDQzpcdTdBRUZcdTUzRTMvdG9rZW4gXHU5MEZEXHU2NjJGXHU2NUIwXHU3Njg0LFxyXG4gICAgICAvLyBcdTkxQ0RcdTVFRkFcdTY4NjVcdTVCQTJcdTYyMzdcdTdBRUZcdTVFNzZcdTkxQ0RcdTY1QjBcdThCQTJcdTk2MDUgU1NFKHJlbmRlcmVyIFx1NzY4NCBFdmVudFN0b3JlIFx1OTc2MCBldmVudElkIFx1NTNCQlx1OTFDRClcclxuICAgICAgb25SZWFkeTogKGVwKSA9PiB7XHJcbiAgICAgICAgY2xpZW50ID0gbmV3IERlc2t0b3BIb3N0Q2xpZW50KGBodHRwOi8vMTI3LjAuMC4xOiR7ZXAucG9ydH1gLCBlcC50b2tlbik7XHJcbiAgICAgICAgc3NlQWJvcnQ/LmFib3J0KCk7XHJcbiAgICAgICAgc3NlQWJvcnQgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XHJcbiAgICAgICAgbGFzdEV2ZW50SWQgPSAnJztcclxuICAgICAgICB2b2lkIHB1bXBFdmVudHMoKTtcclxuICAgICAgICBsb2dJbmZvKCdob3N0JywgYGJyaWRnZSByZWFkeSBvbiAxMjcuMC4wLjE6JHtlcC5wb3J0fSAocnVudGltZSAke2VwLnZlcnNpb259LCBtb2RlICR7YnJpZGdlLm1vZGV9JHt1c2VSZWFsID8gYCwgZW50cnk9JHtydW50aW1lRW50cnl9JHt1c2VCdW5kbGVkUnVudGltZSA/ICcgW2J1bmRsZWRdJyA6ICcnfWAgOiAnJ30pYCk7XHJcbiAgICAgIH0sXHJcbiAgICB9KTtcclxuICAgIHRyeSB7XHJcbiAgICAgIGF3YWl0IHN1cGVydmlzb3Iuc3RhcnQoKTtcclxuICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICBjb25zdCBkZXRhaWwgPSAoKCkgPT4geyB0cnkgeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkoZXJyKTsgfSBjYXRjaCB7IHJldHVybiBTdHJpbmcoZXJyKTsgfSB9KSgpLnNsaWNlKDAsIDQwMCk7XHJcbiAgICAgIGJyaWRnZSA9IHsgLi4uYnJpZGdlLCBob3N0U3RhdGU6ICdmYWlsZWQnLCBsYXN0RXJyb3I6IGRldGFpbCB9O1xyXG4gICAgICBsb2dJbmZvKCdob3N0JywgYHN0YXJ0IGZhaWxlZDogJHtkZXRhaWx9YCk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvKiAtLS0tIElQQyBcdTc2N0RcdTU0MERcdTUzNTUgKyBzZW5kZXIgXHU2ODIxXHU5QThDIC0tLS0gKi9cclxuICBjb25zdCBhbGxvd2VkT3JpZ2lucyA9IG5ldyBTZXQ8c3RyaW5nPihcclxuICAgIGlzRGV2ICYmIHJlbmRlcmVyRGV2VXJsXHJcbiAgICAgID8gW3JlbmRlcmVyRGV2VXJsXVxyXG4gICAgICA6IFtwYXRoVG9GaWxlVVJMKGpvaW4oaGVyZSwgJy4uJywgJy4uJywgJ2Rpc3QtcmVuZGVyZXInLCAnaW5kZXguaHRtbCcpKS5ocmVmXSxcclxuICApO1xyXG5cclxuICBmdW5jdGlvbiBzZW5kZXJUcnVzdGVkKHNlbmRlckZyYW1lOiBFbGVjdHJvbi5XZWJGcmFtZU1haW4gfCBudWxsIHwgdW5kZWZpbmVkKTogYm9vbGVhbiB7XHJcbiAgICBpZiAoc2VuZGVyRnJhbWUgPT09IG51bGwgfHwgc2VuZGVyRnJhbWUgPT09IHVuZGVmaW5lZCkgcmV0dXJuIGZhbHNlO1xyXG4gICAgbGV0IHRvcDogRWxlY3Ryb24uV2ViRnJhbWVNYWluIHwgbnVsbCA9IHNlbmRlckZyYW1lO1xyXG4gICAgd2hpbGUgKHRvcD8ucGFyZW50ICE9PSBudWxsICYmIHRvcD8ucGFyZW50ICE9PSB1bmRlZmluZWQpIHRvcCA9IHRvcC5wYXJlbnQ7XHJcbiAgICBjb25zdCB1cmwgPSB0b3A/LnVybCA/PyAnJztcclxuICAgIGZvciAoY29uc3Qgb3JpZ2luIG9mIGFsbG93ZWRPcmlnaW5zKSB7XHJcbiAgICAgIGlmICh1cmwgPT09IG9yaWdpbiB8fCB1cmwuc3RhcnRzV2l0aChgJHtvcmlnaW59L2ApIHx8IHVybC5zdGFydHNXaXRoKGAke29yaWdpbn0/YCkpIHJldHVybiB0cnVlO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGZhbHNlO1xyXG4gIH1cclxuXHJcbiAgLyoqIFx1OTcwMFx1ODk4MSBob3N0IFx1NUMzMVx1N0VFQVx1NzY4NCBJUEMgaGFuZGxlciBcdTUxNkNcdTUxNzFcdTU4RjM6XHU2NzJBXHU1QzMxXHU3RUVBXHU4RkQ0XHU1NkRFXHU3RUQzXHU2Nzg0XHU1MzE2XHU5NTE5XHU4QkVGXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gaG9zdENhbGw8VD4oZXZlbnQ6IEVsZWN0cm9uLklwY01haW5JbnZva2VFdmVudCwgZm46IChjOiBEZXNrdG9wSG9zdENsaWVudCkgPT4gUHJvbWlzZTxUPik6IFByb21pc2U8VCB8IHsgZXJyb3I6IHN0cmluZzsgY29kZTogc3RyaW5nIH0+IHtcclxuICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9KTtcclxuICAgIGlmIChjbGllbnQgPT09IG51bGwgfHwgYnJpZGdlLmhvc3RTdGF0ZSAhPT0gJ3JlYWR5Jykge1xyXG4gICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6IGBob3N0IG5vdCByZWFkeSAoJHticmlkZ2UuaG9zdFN0YXRlfSlgLCBjb2RlOiAnSE9TVF9OT1RfUkVBRFknIH0pO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGZuKGNsaWVudCkuY2F0Y2goKGVycjogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBkZXRhaWwgPSAoKCkgPT4geyB0cnkgeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkoZXJyKTsgfSBjYXRjaCB7IHJldHVybiBTdHJpbmcoZXJyKTsgfSB9KSgpLnNsaWNlKDAsIDMwMCk7XHJcbiAgICAgIHJldHVybiB7IGVycm9yOiBkZXRhaWwsIGNvZGU6ICdCUklER0VfRVJST1InIH07XHJcbiAgICB9KTtcclxuICB9XHJcblxyXG4gIGZ1bmN0aW9uIHJlZ2lzdGVySXBjKCk6IHZvaWQge1xyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpnZXQtc3RhdGUnLCAoZXZlbnQpID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJyB9O1xyXG4gICAgICByZXR1cm4geyAuLi5icmlkZ2UsIGRyb3BwZWRGcmFtZXMgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6c2Vzc2lvbnMnLCAoZXZlbnQpID0+XHJcbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPHsgc2Vzc2lvbnM6IEFycmF5PHsgaWQ6IHN0cmluZzsgdGl0bGU6IHN0cmluZzsgdGFzazogc3RyaW5nOyBvdXRjb21lOiBzdHJpbmc7IHR1cm5zOiBudW1iZXI7IHRvb2xVc2VzOiBudW1iZXI7IHRpbWU6IHN0cmluZzsgY3dkOiBzdHJpbmc7IGNyZWF0ZWRBdDogc3RyaW5nOyB1cGRhdGVkQXQ6IHN0cmluZyB9PiB9PignL2FwaS9zZXNzaW9ucz9saW1pdD0xMDAnKSkpO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6c2VuZC10YXNrJywgKGV2ZW50LCB0ZXh0OiB1bmtub3duLCBzZXNzaW9uSWQ6IHVua25vd24sIG1vZGU6IHVua25vd24sIGF0dGFjaG1lbnRzOiB1bmtub3duLCBpbWFnZXM6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3QgdGFzayA9IHR5cGVvZiB0ZXh0ID09PSAnc3RyaW5nJyA/IHRleHQuc2xpY2UoMCwgMjBfMDAwKSA6ICcnO1xyXG4gICAgICBjb25zdCBzaWQgPSB0eXBlb2Ygc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IHNlc3Npb25JZC5zbGljZSgwLCA4MCkgOiAnJztcclxuICAgICAgY29uc3QgbSA9IG1vZGUgPT09ICdhdXRvJyB8fCBtb2RlID09PSAneW9sbycgPyBtb2RlIDogJ2Fzayc7XHJcbiAgICAgIC8vIFx1OTY0NFx1NEVGNjpcdTU0MEVcdTdBRUZcdTYzODhcdTY3NDMgRFRPIFx1NzY4NFx1N0VERFx1NUJGOVx1OERFRlx1NUY4NChAIFx1OTAwOVx1NjJFOVx1NTY2OC9cdUQ4M0RcdURDQ0UgXHU0RTBBXHU0RjIwXHU1M0VBXHU2NzY1XHU4MUVBXHU2NzJDXHU1NzMwXHU2NTg3XHU0RUY2XHU3Q0ZCXHU3RURGKVxyXG4gICAgICBjb25zdCBhdHRzID0gQXJyYXkuaXNBcnJheShhdHRhY2htZW50cykgPyBhdHRhY2htZW50cy5maWx0ZXIoKGEpOiBhIGlzIHN0cmluZyA9PiB0eXBlb2YgYSA9PT0gJ3N0cmluZycpLnNsaWNlKDAsIDEwKSA6IFtdO1xyXG4gICAgICAvLyBcdTU2RkVcdTcyNDc6cnVudGltZSB2aXNpb24gXHU5NEZFXHU1MzRGXHU4QkFFIHtuYW1lLCBkYXRhVXJsfSBiYXNlNjQoXHUyMjY0MyBcdTVGMjAgXHUyMjY0Nk1CLHJlbmRlcmVyIFx1NzUxRlx1NjIxMClcclxuICAgICAgY29uc3QgaW1ncyA9IEFycmF5LmlzQXJyYXkoaW1hZ2VzKVxyXG4gICAgICAgID8gaW1hZ2VzXHJcbiAgICAgICAgICAgIC5maWx0ZXIoKGltKTogaW0gaXMgeyBuYW1lOiBzdHJpbmc7IGRhdGFVcmw6IHN0cmluZyB9ID0+XHJcbiAgICAgICAgICAgICAgdHlwZW9mIGltID09PSAnb2JqZWN0JyAmJiBpbSAhPT0gbnVsbCAmJiB0eXBlb2YgKGltIGFzIHsgbmFtZT86IHVua25vd24gfSkubmFtZSA9PT0gJ3N0cmluZycgJiYgdHlwZW9mIChpbSBhcyB7IGRhdGFVcmw/OiB1bmtub3duIH0pLmRhdGFVcmwgPT09ICdzdHJpbmcnKVxyXG4gICAgICAgICAgICAuc2xpY2UoMCwgMylcclxuICAgICAgICAgICAgLm1hcCgoaW0pID0+ICh7IG5hbWU6IGltLm5hbWUuc2xpY2UoMCwgMTIwKSwgZGF0YVVybDogaW0uZGF0YVVybC5zbGljZSgwLCA4XzUwMF8wMDApIH0pKVxyXG4gICAgICAgIDogW107XHJcbiAgICAgIGlmICh0YXNrID09PSAnJyB8fCBzaWQgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgb2s6IGZhbHNlLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW47IHJ1bklkPzogc3RyaW5nIH0+KCcvYXBpL3Rhc2snLCB7IHRleHQ6IHRhc2ssIHNlc3Npb25JZDogc2lkLCBtb2RlOiBtLCBhdHRhY2htZW50czogYXR0cywgaW1hZ2VzOiBpbWdzIH0pKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gXHU2QTIxXHU1NzhCXHU1MjA3XHU2MzYyKHJ1bnRpbWUgUE9TVCAvYXBpL21vZGVsOlx1NTIwNyBjaGF0IFx1OERFRlx1NzUzMSxjb25maWcgXHU1MzczXHU2NUY2XHU3NTFGXHU2NTQ4KSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOm1vZGVsLXNldCcsIChldmVudCwgbmFtZTogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBuID0gdHlwZW9mIG5hbWUgPT09ICdzdHJpbmcnID8gbmFtZS50cmltKCkuc2xpY2UoMCwgODApIDogJyc7XHJcbiAgICAgIGlmIChuID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAnbmFtZSByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbjsgbW9kZWw/OiBzdHJpbmcgfT4oJy9hcGkvbW9kZWwnLCB7IG5hbWU6IG4gfSkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBcdTVFOTRcdTc1MjhcdTUxODVcdTY2RjRcdTY1QjAoR2l0SHViIFJlbGVhc2VzO1x1ODFFQVx1NzgxNFx1OTZGNlx1NEY5RFx1OEQ1Nlx1NjZGNFx1NjVCMFx1NTY2OCkgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpjaGVjay11cGRhdGUnLCBhc3luYyAoZXZlbnQpID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgcmV0dXJuIGNoZWNrRm9yVXBkYXRlcygpO1xyXG4gICAgfSk7XHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmFwcGx5LXVwZGF0ZScsIChldmVudCkgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBpZiAoaW5zdGFsbGVyUGF0aCA9PT0gbnVsbCkgcmV0dXJuIHsgZXJyb3I6ICdubyBpbnN0YWxsZXIgZG93bmxvYWRlZCcsIGNvZGU6ICdIT1NUX05PVF9SRUFEWScgfTtcclxuICAgICAgYXBwbHlVcGRhdGUoKTtcclxuICAgICAgcmV0dXJuIHsgb2s6IHRydWUgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gXHU2ODA3XHU5ODk4XHU2ODBGXHU0RTNCXHU5ODk4XHU1NDBDXHU2QjY1KFx1NkQ0NVx1ODI3Mlx1NkEyMVx1NUYwRlx1NEUwRFx1NTE4RFx1NjcwOVx1OUVEMVx1Njc2MSkrIFx1MjYzMCBcdTRFM0JcdTgzRENcdTUzNTUgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpjaHJvbWUtdGhlbWUnLCAoZXZlbnQsIGRhcms6IHVua25vd24pID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgYXBwbHlDaHJvbWUoZGFyayA9PT0gdHJ1ZSk7XHJcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlIH07XHJcbiAgICB9KTtcclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cG9wdXAtbWFpbi1tZW51JywgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIHBvcHVwTWFpbk1lbnUoKTtcclxuICAgICAgcmV0dXJuIHsgb2s6IHRydWUgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gXHU2MjRCXHU2NzNBXHU4RkRDXHU3QTBCXHU2M0E3XHU1MjM2KDc3ODggd2ViIFx1NUI4OFx1NjJBNDtcdTc1MjhcdTYyMzdcdTY2M0VcdTVGMEZcdTU0MkZcdTUyQTgsQURSLTAwNSBcdTRFMERcdTlFRDhcdThCQTRcdTVGMDAgTEFOKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnJlbW90ZS13ZWItc3RhdHVzJywgYXN5bmMgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IHAgPSBhd2FpdCBwcm9iZVdlYlJlbW90ZSgpO1xyXG4gICAgICByZXR1cm4geyB1cDogcC51cCwgdmVyc2lvbjogcC52ZXJzaW9uLCBsYW5JcDogbGFuSXBPZigpLCBwb3J0OiBXRUJfUE9SVCwgYXZhaWxhYmxlOiBjbGlFbnRyeU9mKCkgIT09ICcnLCBhdXRvc3RhcnQ6IHdlYkF1dG9zdGFydEluc3RhbGxlZCgpIH07XHJcbiAgICB9KTtcclxuICAgIC8vIC0tLS0gXHU1RjAwXHU2NzNBXHU4MUVBXHU1NDJGKDAuMjMuMzcgd2ViIGluc3RhbGwtZGFlbW9uL3VuaW5zdGFsbC1kYWVtb247XHU3NjdCXHU1RjU1XHU1MzczXHU1Qjg4XHU2MkE0XHU1NzI4XHU3RUJGKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnJlbW90ZS13ZWItYXV0b3N0YXJ0JywgYXN5bmMgKGV2ZW50LCBlbmFibGVkOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGlmIChjbGlFbnRyeU9mKCkgPT09ICcnKSByZXR1cm4geyBlcnJvcjogJ25vIGhtaGFybmVzcyBydW50aW1lIGRldGVjdGVkJywgY29kZTogJ0hPU1RfTk9UX1JFQURZJyB9O1xyXG4gICAgICBydW5DbGkoWyd3ZWInLCBlbmFibGVkID09PSB0cnVlID8gJ2luc3RhbGwtZGFlbW9uJyA6ICd1bmluc3RhbGwtZGFlbW9uJ10pO1xyXG4gICAgICAvLyBpbnN0YWxsLWRhZW1vbiBcdTdBQ0JcdTUzNzNcdTYyQzlcdThENzdcdTVCODhcdTYyQTQ6XHU4RjZFXHU4QkUyXHU3ODZFXHU4QkE0O3VuaW5zdGFsbCBcdTUzNzNcdTY1RjZcdTc1MUZcdTY1NDhcclxuICAgICAgaWYgKGVuYWJsZWQgPT09IHRydWUpIHtcclxuICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IDUwOyBpKyspIHtcclxuICAgICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDUwMCkpO1xyXG4gICAgICAgICAgaWYgKChhd2FpdCBwcm9iZVdlYlJlbW90ZSgpKS51cCkgcmV0dXJuIHsgb2s6IHRydWUsIGF1dG9zdGFydDogd2ViQXV0b3N0YXJ0SW5zdGFsbGVkKCkgfTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHsgZXJyb3I6ICdkYWVtb24gZGlkIG5vdCBjb21lIHVwIHdpdGhpbiAyNXMnLCBjb2RlOiAnUlVOVElNRV9DUkFTSEVEJyB9O1xyXG4gICAgICB9XHJcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBhdXRvc3RhcnQ6IHdlYkF1dG9zdGFydEluc3RhbGxlZCgpIH07XHJcbiAgICB9KTtcclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cmVtb3RlLXdlYi1zdGFydCcsIGFzeW5jIChldmVudCkgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBpZiAoY2xpRW50cnlPZigpID09PSAnJykgcmV0dXJuIHsgZXJyb3I6ICdubyBobWhhcm5lc3MgcnVudGltZSBkZXRlY3RlZCcsIGNvZGU6ICdIT1NUX05PVF9SRUFEWScgfTtcclxuICAgICAgaWYgKChhd2FpdCBwcm9iZVdlYlJlbW90ZSgpKS51cCkge1xyXG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBhbHJlYWR5OiB0cnVlLCBsYW5Vcmw6IGBodHRwOi8vJHtsYW5JcE9mKCkgfHwgJzEyNy4wLjAuMSd9OiR7V0VCX1BPUlR9YCB9O1xyXG4gICAgICB9XHJcbiAgICAgIHJ1bkNsaShbJ3dlYicsICdzdGFydCcsICctLWV4cG9zdXJlPWxhbiddKTtcclxuICAgICAgLy8gXHU1Qjg4XHU2MkE0XHU4RkRCXHU3QTBCXHU1MUI3XHU1NDJGXHU1MkE4KHRzeCBcdTdGMTZcdThCRDFcdTY1NzRcdTU5NTcgQ0xJKTpcdThGNkVcdThCRTIgMjVzXHJcbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgNTA7IGkrKykge1xyXG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDUwMCkpO1xyXG4gICAgICAgIGlmICgoYXdhaXQgcHJvYmVXZWJSZW1vdGUoKSkudXApIHtcclxuICAgICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBsYW5Vcmw6IGBodHRwOi8vJHtsYW5JcE9mKCkgfHwgJzEyNy4wLjAuMSd9OiR7V0VCX1BPUlR9YCB9O1xyXG4gICAgICAgIH1cclxuICAgICAgfVxyXG4gICAgICByZXR1cm4geyBlcnJvcjogJ3dlYiBkYWVtb24gZGlkIG5vdCBjb21lIHVwIHdpdGhpbiAyNXMgKHNlZSBITUhfSE9NRS93ZWIubG9nKScsIGNvZGU6ICdSVU5USU1FX0NSQVNIRUQnIH07XHJcbiAgICB9KTtcclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cmVtb3RlLXdlYi1zdG9wJywgYXN5bmMgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIHJ1bkNsaShbJ3dlYicsICdzdG9wJ10pO1xyXG4gICAgICBmb3IgKGxldCBpID0gMDsgaSA8IDIwOyBpKyspIHtcclxuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCA0MDApKTtcclxuICAgICAgICBpZiAoIShhd2FpdCBwcm9iZVdlYlJlbW90ZSgpKS51cCkgcmV0dXJuIHsgb2s6IHRydWUgfTtcclxuICAgICAgfVxyXG4gICAgICBjb25zdCBzdGlsbCA9IChhd2FpdCBwcm9iZVdlYlJlbW90ZSgpKS51cDtcclxuICAgICAgcmV0dXJuIHN0aWxsID8geyBlcnJvcjogJ3N0aWxsIHJ1bm5pbmcnLCBjb2RlOiAnQlJJREdFX0VSUk9SJyB9IDogeyBvazogdHJ1ZSB9O1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBcdUQ4M0RcdURDQ0UgXHU2NTg3XHU0RUY2XHU0RTBBXHU0RjIwKFx1NjcyQ1x1NTczMFx1NTkxQVx1OTAwOTtydW50aW1lIFx1NjgyMVx1OUE4QyBpbnNpZGVXcyxcdTVERTVcdTRGNUNcdTUzM0FcdTU5MTZcdTY1ODdcdTRFRjZcdTRGMUFcdTg4QUIgNDAwKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnBpY2stZmlsZXMnLCBhc3luYyAoZXZlbnQsIHRpdGxlOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IHdpbiA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmZpbmQoKHcpID0+ICF3LmlzRGVzdHJveWVkKCkpO1xyXG4gICAgICBpZiAod2luID09PSB1bmRlZmluZWQpIHJldHVybiB7IGVycm9yOiAnbm8gd2luZG93JywgY29kZTogJ0JSSURHRV9FUlJPUicgfTtcclxuICAgICAgY29uc3QgciA9IGF3YWl0IGRpYWxvZy5zaG93T3BlbkRpYWxvZyh3aW4sIHtcclxuICAgICAgICB0aXRsZTogdHlwZW9mIHRpdGxlID09PSAnc3RyaW5nJyAmJiB0aXRsZSAhPT0gJycgPyB0aXRsZS5zbGljZSgwLCAxMjApIDogJ1x1OTAwOVx1NjJFOVx1ODk4MVx1OTY0NFx1NTJBMFx1NzY4NFx1NjU4N1x1NEVGNihcdTUzRUZcdTU5MUFcdTkwMDkpJyxcclxuICAgICAgICBwcm9wZXJ0aWVzOiBbJ29wZW5GaWxlJywgJ211bHRpU2VsZWN0aW9ucyddLFxyXG4gICAgICB9KTtcclxuICAgICAgaWYgKHIuY2FuY2VsZWQgfHwgci5maWxlUGF0aHMubGVuZ3RoID09PSAwKSByZXR1cm4geyBvazogZmFsc2UsIGNhbmNlbGVkOiB0cnVlIH07XHJcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBwYXRoczogci5maWxlUGF0aHMuc2xpY2UoMCwgMTApIH07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIFx1RDgzRFx1RENDMSBcdTc2RUVcdTVGNTVcdTkwMDlcdTYyRTkoXHU1REU1XHU0RjVDXHU1MzNBXHU2REZCXHU1MkEwXHU3Njg0XHU2RDRGXHU4OUM4XHU2MzA5XHU5NEFFO1x1NTM5Rlx1NzUxRiBjaG9vc2VyKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnBpY2stZGlyZWN0b3J5JywgYXN5bmMgKGV2ZW50LCB0aXRsZTogdW5rbm93bikgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBjb25zdCB3aW4gPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5maW5kKCh3KSA9PiAhdy5pc0Rlc3Ryb3llZCgpKTtcclxuICAgICAgaWYgKHdpbiA9PT0gdW5kZWZpbmVkKSByZXR1cm4geyBlcnJvcjogJ25vIHdpbmRvdycsIGNvZGU6ICdCUklER0VfRVJST1InIH07XHJcbiAgICAgIGNvbnN0IHIgPSBhd2FpdCBkaWFsb2cuc2hvd09wZW5EaWFsb2cod2luLCB7XHJcbiAgICAgICAgdGl0bGU6IHR5cGVvZiB0aXRsZSA9PT0gJ3N0cmluZycgJiYgdGl0bGUgIT09ICcnID8gdGl0bGUuc2xpY2UoMCwgMTIwKSA6ICdcdTkwMDlcdTYyRTlcdTY1ODdcdTRFRjZcdTU5MzknLFxyXG4gICAgICAgIHByb3BlcnRpZXM6IFsnb3BlbkRpcmVjdG9yeSddLFxyXG4gICAgICB9KTtcclxuICAgICAgaWYgKHIuY2FuY2VsZWQgfHwgci5maWxlUGF0aHNbMF0gPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBjYW5jZWxlZDogdHJ1ZSB9O1xyXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgcGF0aDogci5maWxlUGF0aHNbMF0gfTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gQCBcdTk2NDRcdTRFRjY6XHU1REU1XHU0RjVDXHU1MzNBXHU2NTg3XHU0RUY2XHU2NDFDXHU3RDIyKHJ1bnRpbWUgXHU2Mzg4XHU2NzQzXHU3Njg0XHU4REVGXHU1Rjg0XHU2NzY1XHU2RTkwKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmZzLXNlYXJjaCcsIChldmVudCwgcTogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBxdWVyeSA9IHR5cGVvZiBxID09PSAnc3RyaW5nJyA/IHEuc2xpY2UoMCwgMjAwKSA6ICcnO1xyXG4gICAgICBpZiAocXVlcnkgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgcmVzdWx0czogW10gfSk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjx7IHJlc3VsdHM6IEFycmF5PHsgcmVsOiBzdHJpbmc7IHBhdGg6IHN0cmluZyB9PiB9PihgL2FwaS9mcy9zZWFyY2g/cT0ke2VuY29kZVVSSUNvbXBvbmVudChxdWVyeSl9YCkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTphcHByb3ZlJywgKGV2ZW50LCBncmFudGVkOiB1bmtub3duLCBzZXNzaW9uSWQ6IHVua25vd24pID0+XHJcbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KCcvYXBpL2FwcHJvdmUnLCB7XHJcbiAgICAgICAgZ3JhbnRlZDogZ3JhbnRlZCA9PT0gdHJ1ZSxcclxuICAgICAgICBzZXNzaW9uSWQ6IHR5cGVvZiBzZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gc2Vzc2lvbklkLnNsaWNlKDAsIDgwKSA6ICcnLFxyXG4gICAgICB9KSkpO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6aW50ZXJydXB0JywgKGV2ZW50LCBzZXNzaW9uSWQ6IHVua25vd24pID0+XHJcbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KCcvYXBpL2ludGVycnVwdCcsIHtcclxuICAgICAgICBzZXNzaW9uSWQ6IHR5cGVvZiBzZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gc2Vzc2lvbklkLnNsaWNlKDAsIDgwKSA6ICcnLFxyXG4gICAgICB9KSkpO1xyXG5cclxuICAgIC8vIC0tLS0gTTQ6XHU1REU1XHU0RjVDXHU1MzNBXHU2NTg3XHU0RUY2XHU5NzYyKFx1OERFRlx1NUY4NFx1NjM4OFx1Njc0M1x1NTcyOCBydW50aW1lOmluc2lkZVdzIFx1NjgyMVx1OUE4QykgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpmcy1saXN0JywgKGV2ZW50LCBwYXRoOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IHAgPSB0eXBlb2YgcGF0aCA9PT0gJ3N0cmluZycgPyBwYXRoLnNsaWNlKDAsIDEwMDApIDogJyc7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oYC9hcGkvZnM/ZmlsZXM9MSR7cCAhPT0gJycgPyBgJnBhdGg9JHtlbmNvZGVVUklDb21wb25lbnQocCl9YCA6ICcnfWApKTtcclxuICAgIH0pO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6ZnMtcmVhZCcsIChldmVudCwgcGF0aDogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBwID0gdHlwZW9mIHBhdGggPT09ICdzdHJpbmcnID8gcGF0aC5zbGljZSgwLCAxMDAwKSA6ICcnO1xyXG4gICAgICBpZiAocCA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ3BhdGggcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KGAvYXBpL2ZzL3JlYWQ/cGF0aD0ke2VuY29kZVVSSUNvbXBvbmVudChwKX1gKSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmluamVjdCcsIChldmVudCwgdGV4dDogdW5rbm93biwgc2Vzc2lvbklkOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IHQgPSB0eXBlb2YgdGV4dCA9PT0gJ3N0cmluZycgPyB0ZXh0LnNsaWNlKDAsIDIwXzAwMCkgOiAnJztcclxuICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIHNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBzZXNzaW9uSWQuc2xpY2UoMCwgODApIDogJyc7XHJcbiAgICAgIGlmICh0ID09PSAnJyB8fCBzaWQgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgb2s6IGZhbHNlLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvaW5qZWN0JywgeyB0ZXh0OiB0LCBzZXNzaW9uSWQ6IHNpZCB9KSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIFx1NEYxQVx1OEJERFx1NUJGQ1x1NTFGQShleHBvcnQubWQgXHUyMTkyIFx1NEZERFx1NUI1OFx1NUJGOVx1OEJERFx1Njg0NjtcdTY1ODdcdTRFRjZcdTUxOTlcdTUxNjVcdTUzRUFcdTU3MjggbWFpbikgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpleHBvcnQtc2Vzc2lvbicsIGFzeW5jIChldmVudCwgaWQ6IHVua25vd24sIHRpdGxlOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IHNpZCA9IHR5cGVvZiBpZCA9PT0gJ3N0cmluZycgPyBpZC5yZXBsYWNlKC9bXmEtekEtWjAtOV86LkAtXS9nLCAnJykuc2xpY2UoMCwgODApIDogJyc7XHJcbiAgICAgIGlmIChzaWQgPT09ICcnKSByZXR1cm4geyBlcnJvcjogJ2lkIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9O1xyXG4gICAgICBpZiAoY2xpZW50ID09PSBudWxsIHx8IGJyaWRnZS5ob3N0U3RhdGUgIT09ICdyZWFkeScpIHJldHVybiB7IGVycm9yOiBgaG9zdCBub3QgcmVhZHkgKCR7YnJpZGdlLmhvc3RTdGF0ZX0pYCwgY29kZTogJ0hPU1RfTk9UX1JFQURZJyB9O1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IG1kID0gYXdhaXQgY2xpZW50LmdldFRleHQoYC9hcGkvc2Vzc2lvbnMvJHtlbmNvZGVVUklDb21wb25lbnQoc2lkKX0vZXhwb3J0Lm1kYCk7XHJcbiAgICAgICAgY29uc3Qgd2luID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkuZmluZCgodykgPT4gIXcuaXNEZXN0cm95ZWQoKSk7XHJcbiAgICAgICAgaWYgKHdpbiA9PT0gdW5kZWZpbmVkKSByZXR1cm4geyBlcnJvcjogJ25vIHdpbmRvdycsIGNvZGU6ICdCUklER0VfRVJST1InIH07XHJcbiAgICAgICAgY29uc3QgciA9IGF3YWl0IGRpYWxvZy5zaG93U2F2ZURpYWxvZyh3aW4sIHtcclxuICAgICAgICAgIHRpdGxlOiB0eXBlb2YgdGl0bGUgPT09ICdzdHJpbmcnICYmIHRpdGxlICE9PSAnJyA/IHRpdGxlLnNsaWNlKDAsIDgwKSA6ICdcdTVCRkNcdTUxRkFcdTRGMUFcdThCREQnLFxyXG4gICAgICAgICAgZGVmYXVsdFBhdGg6IGBobWgtJHtzaWR9Lm1kYCxcclxuICAgICAgICAgIGZpbHRlcnM6IFt7IG5hbWU6ICdNYXJrZG93bicsIGV4dGVuc2lvbnM6IFsnbWQnXSB9XSxcclxuICAgICAgICB9KTtcclxuICAgICAgICBpZiAoci5jYW5jZWxlZCB8fCByLmZpbGVQYXRoID09PSB1bmRlZmluZWQgfHwgci5maWxlUGF0aCA9PT0gJycpIHJldHVybiB7IG9rOiBmYWxzZSwgY2FuY2VsZWQ6IHRydWUgfTtcclxuICAgICAgICBhd2FpdCB3cml0ZUZpbGUoci5maWxlUGF0aCwgbWQsICd1dGY4Jyk7XHJcbiAgICAgICAgbG9nSW5mbygnZXhwb3J0JywgYHNlc3Npb24gJHtzaWR9IFx1MjE5MiAke3IuZmlsZVBhdGh9YCk7XHJcbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHBhdGg6IHIuZmlsZVBhdGggfTtcclxuICAgICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgY29uc3QgZGV0YWlsID0gKCgpID0+IHsgdHJ5IHsgcmV0dXJuIEpTT04uc3RyaW5naWZ5KGVycik7IH0gY2F0Y2ggeyByZXR1cm4gU3RyaW5nKGVycik7IH0gfSkoKS5zbGljZSgwLCAzMDApO1xyXG4gICAgICAgIHJldHVybiB7IGVycm9yOiBkZXRhaWwsIGNvZGU6ICdCUklER0VfRVJST1InIH07XHJcbiAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gXHU1QkExXHU2Mjc5XHU2QTIxXHU1RjBGXHU4QkZCXHU1MTk5KFx1Njc0M1x1NUEwMVx1NTcyOCBydW50aW1lIGNvbmZpZztcdTUyMDdcdTYzNjJcdTVGQzVcdTk4N0JcdTY2M0VcdTVGMEYpIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6YXBwcm92YWwtZ2V0JywgKGV2ZW50KSA9PlxyXG4gICAgICBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjx7IHNldHRpbmdzPzogeyBhcHByb3ZhbD86IHN0cmluZyB9IH0+KCcvYXBpL3N0YXRlJykpKTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmFwcHJvdmFsLXNldCcsIChldmVudCwgbW9kZTogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBtID0gbW9kZSA9PT0gJ2F1dG8nID8gJ2F1dG8nIDogbW9kZSA9PT0gJ2FzaycgPyAnYXNrJyA6ICcnO1xyXG4gICAgICBpZiAobSA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ21vZGUgbXVzdCBiZSBhc2t8YXV0bycsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PignL2FwaS9jb25maWcnLCB7IGFwcHJvdmFsOiBtIH0pKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gaG1oYXJuZXNzIHJ1bnRpbWUgXHU4RkRFXHU2M0E1KFx1ODFFQVx1NTJBOFx1NTNEMVx1NzNCMCArIFx1NjI0Qlx1NTJBOFx1ODk4Nlx1NzZENiArIFx1NzBFRFx1NTIwN1x1NjM2MikgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpydW50aW1lLWluZm8nLCBhc3luYyAoZXZlbnQpID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgY29uc3QgZCA9IGRldGVjdEV4dGVybmFsUnVudGltZSgpO1xyXG4gICAgICBjb25zdCBjZmcgPSBhd2FpdCBsb2FkUnVudGltZUNvbmZpZygpO1xyXG4gICAgICByZXR1cm4ge1xyXG4gICAgICAgIG1vZGU6IGJyaWRnZS5tb2RlLFxyXG4gICAgICAgIHJ1bnRpbWVFbnRyeTogYnJpZGdlLnJ1bnRpbWVFbnRyeSxcclxuICAgICAgICBvdmVycmlkZTogY2ZnLmVudHJ5LFxyXG4gICAgICAgIGRlbW86IGNmZy5kZW1vLFxyXG4gICAgICAgIGRldGVjdGVkOiBkLmVudHJ5LFxyXG4gICAgICAgIGRldGVjdGVkVmVyc2lvbjogZC52ZXJzaW9uLFxyXG4gICAgICAgIGRldGVjdGVkU291cmNlOiBkLnNvdXJjZSxcclxuICAgICAgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6YnJvd3NlLXJ1bnRpbWUnLCBhc3luYyAoZXZlbnQsIHRpdGxlOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IHdpbiA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmZpbmQoKHcpID0+ICF3LmlzRGVzdHJveWVkKCkpO1xyXG4gICAgICBpZiAod2luID09PSB1bmRlZmluZWQpIHJldHVybiB7IGVycm9yOiAnbm8gd2luZG93JywgY29kZTogJ0JSSURHRV9FUlJPUicgfTtcclxuICAgICAgY29uc3QgciA9IGF3YWl0IGRpYWxvZy5zaG93T3BlbkRpYWxvZyh3aW4sIHtcclxuICAgICAgICB0aXRsZTogdHlwZW9mIHRpdGxlID09PSAnc3RyaW5nJyAmJiB0aXRsZSAhPT0gJycgPyB0aXRsZS5zbGljZSgwLCAxMjApIDogJ1x1OTAwOVx1NjJFOSBobWhhcm5lc3MgXHU3Njg0IGRlc2t0b3AtaG9zdCBcdTUxNjVcdTUzRTMnLFxyXG4gICAgICAgIHByb3BlcnRpZXM6IFsnb3BlbkZpbGUnXSxcclxuICAgICAgICBmaWx0ZXJzOiBbeyBuYW1lOiAnZGVza3RvcC1ob3N0JywgZXh0ZW5zaW9uczogWyd0cycsICdqcyddIH1dLFxyXG4gICAgICB9KTtcclxuICAgICAgaWYgKHIuY2FuY2VsZWQgfHwgci5maWxlUGF0aHNbMF0gPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBjYW5jZWxlZDogdHJ1ZSB9O1xyXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgZW50cnk6IHIuZmlsZVBhdGhzWzBdIH07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiogXHU4QkJFXHU3RjZFL1x1NkUwNVx1OTY2NFx1NjI0Qlx1NTJBOFx1NTE2NVx1NTNFM1x1NTQwRVx1NzBFRFx1OTFDRFx1NTQyRiBob3N0KFx1N0E3QVx1NEUzMj1cdTU2REVcdTUyMzBcdTgxRUFcdTUyQThcdTUzRDFcdTczQjApXHUzMDAyICovXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnNldC1ydW50aW1lJywgYXN5bmMgKGV2ZW50LCBlbnRyeTogdW5rbm93bikgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBjb25zdCBlID0gdHlwZW9mIGVudHJ5ID09PSAnc3RyaW5nJyA/IGVudHJ5LnRyaW0oKSA6ICcnO1xyXG4gICAgICBpZiAoZSAhPT0gJycgJiYgKCFpc0Fic29sdXRlKGUpIHx8ICFleGlzdHNTeW5jKGUpKSkge1xyXG4gICAgICAgIHJldHVybiB7IGVycm9yOiAnXHU1MTY1XHU1M0UzXHU1RkM1XHU5ODdCXHU2NjJGXHU1QjU4XHU1NzI4XHU3Njg0XHU3RUREXHU1QkY5XHU4REVGXHU1Rjg0KGRlc2t0b3AtaG9zdC50cyknLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH07XHJcbiAgICAgIH1cclxuICAgICAgYXdhaXQgc2F2ZVJ1bnRpbWVFbnRyeU92ZXJyaWRlKGUpO1xyXG4gICAgICAvLyBcdTcwRURcdTUyMDdcdTYzNjI6XHU1MTQ4XHU0RjE4XHU5NkM1XHU1MDVDXHU2Mzg5XHU1RjUzXHU1MjREIGhvc3QsXHU1MThEXHU2MzA5XHU2NUIwXHU5MTREXHU3RjZFXHU2MkM5XHU4RDc3XHJcbiAgICAgIHNzZUFib3J0Py5hYm9ydCgpO1xyXG4gICAgICBpZiAoc3VwZXJ2aXNvciAhPT0gbnVsbCkgYXdhaXQgc3VwZXJ2aXNvci5zdG9wKCk7XHJcbiAgICAgIGF3YWl0IHN0YXJ0SG9zdCgpO1xyXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgbW9kZTogYnJpZGdlLm1vZGUgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gdjUuMSBcdTk5OTZcdTU0MkZcdTVCODlcdTg4QzVcdTU0MTFcdTVCRkM6XHU2NzJDXHU2NzNBXHU2OEMwXHU2RDRCIC8gXHU0RTBCXHU4RjdEXHU1Qjg5XHU4OEM1KFx1OEZEQlx1NUVBNlx1NEU4Qlx1NEVGNikgLyBcdTU0MTFcdTVCRkNcdTcyQjZcdTYwMDEgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpkZXRlY3QtcnVudGltZScsIChldmVudCkgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBjb25zdCBpbmZvID0gYnVuZGxlZFJ1bnRpbWVJbmZvKCk7XHJcbiAgICAgIC8vIFVJVkVSSUZZIFx1NTQxMVx1NUJGQ1x1NkI2NVx1NzY4NFwiXHU0RjJBXHU5MDIwXHU2NzJBXHU5MTREXHU3RjZFXHU2MDAxXCI6ZmFrZSBcdTZBMjFcdTVGMEZcdTRFMEJcdTYwNTJcdTYyQTVcdTY3MkFcdTY4QzBcdTZENEJcclxuICAgICAgLy8gKFx1NzcxRlx1NUI5RVx1NjhDMFx1NkQ0Qlx1OERFRlx1NUY4NFx1NzUzMSByZWFsIFx1NTNEOFx1NEY1M1x1OUE4Q1x1NjUzNixcdTg5QzEgZXZpZGVuY2Uvc2V0dXAtd2l6YXJkLylcclxuICAgICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX1dJWkFSRCA9PT0gJ2Zha2UnICYmIHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX0ZBS0UgPT09ICcxJykge1xyXG4gICAgICAgIHJldHVybiB7IGZvdW5kOiBmYWxzZSwgdmVyc2lvbjogJycsIGVudHJ5OiAnJywgc291cmNlOiAnJywgYnVuZGxlZDogaW5mbywgbnBtOiBucG1PblBhdGgoKSB9O1xyXG4gICAgICB9XHJcbiAgICAgIGNvbnN0IGQgPSBkZXRlY3RFeHRlcm5hbFJ1bnRpbWUoKTtcclxuICAgICAgcmV0dXJuIHsgZm91bmQ6IGQuZW50cnkgIT09ICcnLCB2ZXJzaW9uOiBkLnZlcnNpb24sIGVudHJ5OiBkLmVudHJ5LCBzb3VyY2U6IGQuc291cmNlLCBidW5kbGVkOiBpbmZvLCBucG06IG5wbU9uUGF0aCgpIH07XHJcbiAgICB9KTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmluc3RhbGwtY2xpJywgKGV2ZW50LCBvcHRzOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IG8gPSAob3B0cyA/PyB7fSkgYXMgeyBmb3JjZVRnej86IHVua25vd247IG1pcnJvckZpcnN0PzogdW5rbm93biB9O1xyXG4gICAgICByZXR1cm4gc3RhcnRDbGlJbnN0YWxsKFxyXG4gICAgICAgIHtcclxuICAgICAgICAgIHNlbmRQcm9ncmVzczogKHA6IEluc3RhbGxQcm9ncmVzcyk6IHZvaWQgPT4ge1xyXG4gICAgICAgICAgICBsb2dJbmZvKCdpbnN0YWxsJywgYCR7cC5waGFzZX0ke3AucGN0ICE9PSB1bmRlZmluZWQgPyBgICR7cC5wY3R9JWAgOiAnJ30gJHtwLnRleHR9YCk7XHJcbiAgICAgICAgICAgIGZvciAoY29uc3QgdyBvZiBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKSkge1xyXG4gICAgICAgICAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ2luc3RhbGw6cHJvZ3Jlc3MnLCBwKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgfSxcclxuICAgICAgICAgIGxvZzogKG06IHN0cmluZyk6IHZvaWQgPT4geyBsb2dJbmZvKCdpbnN0YWxsJywgbSk7IH0sXHJcbiAgICAgICAgICAvLyBcdTVCODlcdTg4QzVcdTYyMTBcdTUyOUZcdTUzNzNcdTYzMDFcdTRFNDVcdTUzMTZcdTVFNzZcdTcwRURcdTUyMDdcdTYzNjIoXHU1NDExXHU1QkZDXHU5NjhGXHU1NDBFXHU2NTM2XHU1QzNFO1x1NEUyRFx1OTAxNFx1NTNENlx1NkQ4OFx1NEU1Rlx1NURGMlx1NzUxRlx1NjU0OClcclxuICAgICAgICAgIG9uSW5zdGFsbGVkOiAoZW50cnk6IHN0cmluZyk6IHZvaWQgPT4ge1xyXG4gICAgICAgICAgICB2b2lkIChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgICAgICAgYXdhaXQgc2F2ZVJ1bnRpbWVDb25maWcoeyBlbnRyeSwgZGVtbzogZmFsc2UgfSk7XHJcbiAgICAgICAgICAgICAgc3NlQWJvcnQ/LmFib3J0KCk7XHJcbiAgICAgICAgICAgICAgaWYgKHN1cGVydmlzb3IgIT09IG51bGwpIGF3YWl0IHN1cGVydmlzb3Iuc3RvcCgpO1xyXG4gICAgICAgICAgICAgIGF3YWl0IHN0YXJ0SG9zdCgpO1xyXG4gICAgICAgICAgICB9KSgpO1xyXG4gICAgICAgICAgfSxcclxuICAgICAgICB9LFxyXG4gICAgICAgIHtcclxuICAgICAgICAgIGZvcmNlVGd6OiBvLmZvcmNlVGd6ID09PSB0cnVlLFxyXG4gICAgICAgICAgbWlycm9yRmlyc3Q6IG8ubWlycm9yRmlyc3QgPT09ICducG1taXJyb3InID8gJ25wbW1pcnJvcicgOiBvLm1pcnJvckZpcnN0ID09PSAnbnBtanMnID8gJ25wbWpzJyA6IHVuZGVmaW5lZCxcclxuICAgICAgICB9LFxyXG4gICAgICApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpnZXQtd2l6YXJkJywgYXN5bmMgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IHZhcmlhbnQgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9XSVpBUkQ7XHJcbiAgICAgIGlmICh2YXJpYW50ICE9PSB1bmRlZmluZWQgJiYgdmFyaWFudCAhPT0gJycpIHtcclxuICAgICAgICAvLyBcdTlBOENcdTY1MzZcdTY3ODRcdTkwMjA6XHU1RjNBXHU1MjM2XHU1NDExXHU1QkZDXHU1M0VGXHU4OUMxXHU0RTE0XHU4OUM2XHU0RTNBXHU2NzJBXHU5MTREXHU3RjZFKFx1NTNFRlx1OTFDRFx1NTkwRFx1OEREMSk7cGVyc2lzdGVkPVx1NzcxRlx1NUI5RVx1ODQzRFx1NzZEOFxyXG4gICAgICAgIC8vIFx1NzJCNlx1NjAwMShcdTU0MTFcdTVCRkNcdTZCNjVcdTY1QURcdThBMDBcIlx1OTAwOVx1NjJFOVx1NjMwMVx1NEU0NVwiXHU3NTI4LFx1NEUwRFx1NUY3MVx1NTRDRCBVSSBcdTUyMjRcdTVCOUEpXHJcbiAgICAgICAgY29uc3QgdyA9IGF3YWl0IGxvYWRXaXphcmRTdGF0ZSgpO1xyXG4gICAgICAgIHJldHVybiB7IGRvbmU6IGZhbHNlLCBjaG9pY2U6ICcnLCBzdXBwcmVzc2VkOiBmYWxzZSwgcGVyc2lzdGVkOiB7IGRvbmU6IHcuZG9uZSwgY2hvaWNlOiB3LmNob2ljZSB9IH07XHJcbiAgICAgIH1cclxuICAgICAgY29uc3QgdyA9IGF3YWl0IGxvYWRXaXphcmRTdGF0ZSgpO1xyXG4gICAgICBjb25zdCBjZmcgPSBhd2FpdCBsb2FkUnVudGltZUNvbmZpZygpO1xyXG4gICAgICAvLyBcdTVERjJcdTkxNERcdTdGNkVcdThGQzcgcnVudGltZShcdTYyNEJcdTUyQThcdTUxNjVcdTUzRTMvXHU1NDExXHU1QkZDXHU5MDA5XHU2MkU5L1x1NkYxNFx1NzkzQSlcdTg5QzZcdTU0MENcdTVERjJcdTVCOENcdTYyMTBcdTk5OTZcdTU0MkZcclxuICAgICAgcmV0dXJuIHsgZG9uZTogdy5kb25lIHx8IGNmZy5lbnRyeSAhPT0gJycgfHwgY2ZnLmRlbW8sIGNob2ljZTogdy5jaG9pY2UsIHN1cHByZXNzZWQ6IHdpemFyZFN1cHByZXNzZWQoKSB9O1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyoqIFx1NTQxMVx1NUJGQ1x1NjUzNlx1NUMzRTpcdTYzMDFcdTRFNDVcdTUzMTZcdTkwMDlcdTYyRTlcdTVFNzZcdTVFOTRcdTc1MjgoZXh0ZXJuYWwvYnVuZGxlZFx1MjE5Mlx1NTE2NVx1NTNFM1x1ODk4Nlx1NzZENjtkZW1vXHUyMTkyXHU2MzAxXHU0RTQ1XHU2RjE0XHU3OTNBO1xyXG4gICAgICogIGluc3RhbGxcdTIxOTJcdTUxNjVcdTUzRTNcdTVERjJcdTc1MzFcdTVCODlcdTg4QzVcdTU2NjhcdTYzMDFcdTRFNDVcdTUzMTYsXHU1M0VBXHU4QkIwXHU3MkI2XHU2MDAxKVx1MzAwMmZha2UvXHU2RDRCXHU4QkQ1XHU3M0FGXHU1ODgzXHU1M0VBXHU4QkIwXHU3MkI2XHU2MDAxXHUzMDAyICovXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOndpemFyZC1jb21wbGV0ZScsIGFzeW5jIChldmVudCwgY2hvaWNlOiB1bmtub3duLCBlbnRyeTogdW5rbm93bikgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBjb25zdCBjID0gY2hvaWNlID09PSAnZXh0ZXJuYWwnIHx8IGNob2ljZSA9PT0gJ2luc3RhbGwnIHx8IGNob2ljZSA9PT0gJ2J1bmRsZWQnIHx8IGNob2ljZSA9PT0gJ2RlbW8nID8gY2hvaWNlIDogJyc7XHJcbiAgICAgIGlmIChjID09PSAnJykgcmV0dXJuIHsgZXJyb3I6ICdjaG9pY2UgbXVzdCBiZSBleHRlcm5hbHxpbnN0YWxsfGJ1bmRsZWR8ZGVtbycsIGNvZGU6ICdCQURfUkVRVUVTVCcgfTtcclxuICAgICAgY29uc3QgZSA9IHR5cGVvZiBlbnRyeSA9PT0gJ3N0cmluZycgPyBlbnRyeSA6ICcnO1xyXG4gICAgICBhd2FpdCBzYXZlV2l6YXJkU3RhdGUoYyk7XHJcbiAgICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9GQUtFID09PSAnMScpIHJldHVybiB7IG9rOiB0cnVlLCBtb2RlOiBicmlkZ2UubW9kZSwgdGVzdDogdHJ1ZSB9O1xyXG4gICAgICBjb25zdCByZXBvUm9vdCA9IGpvaW4oaGVyZSwgJy4uJywgJy4uJywgJy4uJywgJy4uJyk7XHJcbiAgICAgIGlmIChjID09PSAnZXh0ZXJuYWwnIHx8IGMgPT09ICdidW5kbGVkJykge1xyXG4gICAgICAgIGNvbnN0IHRhcmdldCA9IGMgPT09ICdidW5kbGVkJyA/IGJ1bmRsZWRSdW50aW1lUGF0aChyZXBvUm9vdCkgOiBlO1xyXG4gICAgICAgIGlmICh0YXJnZXQgPT09ICcnIHx8ICFpc0Fic29sdXRlKHRhcmdldCkgfHwgIWV4aXN0c1N5bmModGFyZ2V0KSkge1xyXG4gICAgICAgICAgcmV0dXJuIHsgZXJyb3I6ICdydW50aW1lIFx1NTE2NVx1NTNFM1x1NEUwRFx1NUI1OFx1NTcyOCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfTtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgc2F2ZVJ1bnRpbWVDb25maWcoeyBlbnRyeTogdGFyZ2V0LCBkZW1vOiBmYWxzZSB9KTtcclxuICAgICAgfSBlbHNlIGlmIChjID09PSAnZGVtbycpIHtcclxuICAgICAgICBhd2FpdCBzYXZlUnVudGltZUNvbmZpZyh7IGVudHJ5OiAnJywgZGVtbzogdHJ1ZSB9KTtcclxuICAgICAgfVxyXG4gICAgICBpZiAoYyAhPT0gJ2luc3RhbGwnKSB7XHJcbiAgICAgICAgLy8gaW5zdGFsbDpcdTVCODlcdTg4QzVcdTU2NjhcdTVERjJcdTU3Mjggb25JbnN0YWxsZWQgXHU2MzAxXHU0RTQ1XHU1MzE2XHU1RTc2XHU3MEVEXHU1MjA3XHU2MzYyLFx1OEZEOVx1OTFDQ1x1NEUwRFx1NTE4RFx1OTFDRFx1NTQyRlxyXG4gICAgICAgIHNzZUFib3J0Py5hYm9ydCgpO1xyXG4gICAgICAgIGlmIChzdXBlcnZpc29yICE9PSBudWxsKSBhd2FpdCBzdXBlcnZpc29yLnN0b3AoKTtcclxuICAgICAgICBhd2FpdCBzdGFydEhvc3QoKTtcclxuICAgICAgfVxyXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgbW9kZTogYnJpZGdlLm1vZGUgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gUHJvdmlkZXIgXHU4QkJFXHU3RjZFKDAzIFx1MDBBN1x1NEUwMzprZXkgXHU1M0VBXHU1MUZBIGhhc0tleS9cdTY3MkJcdTU2REJcdTRGNEQ7XHU0RkREXHU1QjU4XHU3NkY0XHU1MTk5IHJ1bnRpbWUpIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cHJvdmlkZXJzJywgKGV2ZW50KSA9PlxyXG4gICAgICBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjx7IHByb3ZpZGVyc0RldGFpbD86IEFycmF5PHsgbmFtZTogc3RyaW5nOyBtb2RlbDogc3RyaW5nOyBiYXNlVXJsOiBzdHJpbmc7IGhhc0tleTogYm9vbGVhbjsga2V5VGFpbD86IHN0cmluZyB9PjsgbW9kZWw/OiBzdHJpbmcgfT4oJy9hcGkvc3RhdGUnKSkpO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cHJvdmlkZXItc2F2ZScsIChldmVudCwgcHJvdmlkZXI6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3QgcCA9IHByb3ZpZGVyIGFzIHsgbmFtZT86IHVua25vd247IGJhc2VVcmw/OiB1bmtub3duOyBtb2RlbD86IHVua25vd247IGFwaUtleT86IHVua25vd24gfTtcclxuICAgICAgY29uc3QgbmFtZSA9IHR5cGVvZiBwPy5uYW1lID09PSAnc3RyaW5nJyA/IHAubmFtZS5zbGljZSgwLCA4MCkgOiAnJztcclxuICAgICAgY29uc3QgYmFzZVVybCA9IHR5cGVvZiBwPy5iYXNlVXJsID09PSAnc3RyaW5nJyA/IHAuYmFzZVVybC5zbGljZSgwLCAzMDApIDogJyc7XHJcbiAgICAgIGNvbnN0IG1vZGVsID0gdHlwZW9mIHA/Lm1vZGVsID09PSAnc3RyaW5nJyA/IHAubW9kZWwuc2xpY2UoMCwgMTIwKSA6ICcnO1xyXG4gICAgICBpZiAobmFtZSA9PT0gJycgfHwgYmFzZVVybCA9PT0gJycgfHwgbW9kZWwgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICduYW1lL2Jhc2VVcmwvbW9kZWwgcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xyXG4gICAgICBjb25zdCBib2R5OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgbmFtZSwgYmFzZVVybCwgbW9kZWwgfTtcclxuICAgICAgLy8gYXBpS2V5IFx1NTNFQVx1NTcyOFx1NjYzRVx1NUYwRlx1OEY5M1x1NTE2NVx1NjVGNlx1NEUwQVx1NEYyMCxcdTdFRERcdTRFMERcdTU2REVcdTY2M0UocmVuZGVyZXIgXHU4ODY4XHU1MzU1XHU2M0QwXHU0RUE0XHU1NDBFXHU1MzczXHU2RTA1XHU3QTdBKVxyXG4gICAgICBpZiAodHlwZW9mIHA/LmFwaUtleSA9PT0gJ3N0cmluZycgJiYgcC5hcGlLZXkgIT09ICcnKSBib2R5LmFwaUtleSA9IHAuYXBpS2V5LnNsaWNlKDAsIDMwMCk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PignL2FwaS9wcm92aWRlcnMnLCBib2R5KSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIFx1NURFNVx1NEY1Q1x1NTMzQSgwMyBcdTAwQTdcdTUxNkQ7XHU1MjA3XHU2MzYyXHU4QkVEXHU0RTQ5XHU0RTBFIHdlYiBcdTc2RjhcdTU0MEM6cnVudGltZSBcdTUzNTVcdTkwMDkgY3dkKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOndvcmtzcGFjZXMnLCAoZXZlbnQpID0+XHJcbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPHsgY3VycmVudDogc3RyaW5nOyBpdGVtczogQXJyYXk8eyBpZDogc3RyaW5nOyBuYW1lOiBzdHJpbmc7IHBhdGg6IHN0cmluZyB9PiB9PignL2FwaS93b3Jrc3BhY2VzJykpKTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOndvcmtzcGFjZS11c2UnLCAoZXZlbnQsIGlkOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IHdpZCA9IHR5cGVvZiBpZCA9PT0gJ3N0cmluZycgPyBpZC5zbGljZSgwLCA2MCkgOiAnJztcclxuICAgICAgaWYgKHdpZCA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ2lkIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcclxuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KCcvYXBpL3dvcmtzcGFjZXMvdXNlJywgeyBpZDogd2lkIH0pKTtcclxuICAgIH0pO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6d29ya3NwYWNlLWFkZCcsIChldmVudCwgbmFtZTogdW5rbm93biwgcGF0aDogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBuID0gdHlwZW9mIG5hbWUgPT09ICdzdHJpbmcnID8gbmFtZS5zbGljZSgwLCAxMjApIDogJyc7XHJcbiAgICAgIGNvbnN0IHAgPSB0eXBlb2YgcGF0aCA9PT0gJ3N0cmluZycgPyBwYXRoLnNsaWNlKDAsIDEwMDApIDogJyc7XHJcbiAgICAgIGlmIChwID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAncGF0aCByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PignL2FwaS93b3Jrc3BhY2VzJywgeyBuYW1lOiBuID09PSAnJyA/IHVuZGVmaW5lZCA6IG4sIHBhdGg6IHAgfSkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBcdTRGMUFcdThCRERcdTVGNTJcdTY4NjMvXHU1MjIwXHU5NjY0KFx1NzlGQlx1NTE2NSBhcmNoaXZlL3RyYXNoLFx1NTNFRlx1NjA2Mlx1NTkwRDtydW50aW1lIFx1Njc0M1x1NUEwMSkgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpzZXNzaW9uLW9wJywgKGV2ZW50LCBpZDogdW5rbm93biwgb3A6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIGlkID09PSAnc3RyaW5nJyA/IGlkLnJlcGxhY2UoL1teYS16QS1aMC05XzouQC1dL2csICcnKS5zbGljZSgwLCA4MCkgOiAnJztcclxuICAgICAgY29uc3QgbyA9IG9wID09PSAnYXJjaGl2ZScgfHwgb3AgPT09ICdkZWxldGUnID8gb3AgOiAnJztcclxuICAgICAgaWYgKHNpZCA9PT0gJycgfHwgbyA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ2lkIGFuZCBvcChhcmNoaXZlfGRlbGV0ZSkgcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oYC9hcGkvc2Vzc2lvbnMvJHtlbmNvZGVVUklDb21wb25lbnQoc2lkKX0vJHtvfWAsIHt9KSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIE00OkRpZmYgXHU5NzYyXHU2NzdGKFx1NTNFQVx1OEJGQiBnaXQgXHU1M0Q4XHU2NkY0O1x1NjM4OFx1Njc0M1x1NTcyOCBydW50aW1lKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmRpZmYnLCAoZXZlbnQsIHNlc3Npb25JZDogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBzaWQgPSB0eXBlb2Ygc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IHNlc3Npb25JZC5zbGljZSgwLCA4MCkgOiAnJztcclxuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPFJlY29yZDxzdHJpbmcsIHVua25vd24+PihgL2FwaS9kaWZmJHtzaWQgIT09ICcnID8gYD9zZXNzaW9uSWQ9JHtlbmNvZGVVUklDb21wb25lbnQoc2lkKX1gIDogJyd9YCkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBNNTpcdThCQTRcdTc3RTVcdTcyQjZcdTYwMDEoXHU3RUQzXHU2Nzg0XHU1MzE2XHU0RThCXHU1QjlFO1x1N0YzQVx1NjU3MFx1NjM2RVx1NUI1N1x1NkJCNVx1NzUzMSBVSSBcdTY2M0VcdTc5M0FcIlx1NjVFMFx1NjU3MFx1NjM2RVwiKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmNvZ25pdGl2ZScsIChldmVudCkgPT5cclxuICAgICAgaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KCcvYXBpL2NvZ25pdGl2ZScpKSk7XHJcblxyXG4gICAgLy8gLS0tLSBcdTUzODZcdTUzRjJcdTRGMUFcdThCRERcdTk4ODRcdTg5QzgoXHU2NzAwXHU1NDBFIDgwIFx1Njc2MSxcdTZCQ0ZcdTY3NjEgNTAwIFx1NUI1NztydW50aW1lIFx1Njc0M1x1NUEwMVx1NjU3MFx1NjM2RSkgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpzZXNzaW9uLXByZXZpZXcnLCAoZXZlbnQsIGlkOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IHNpZCA9IHR5cGVvZiBpZCA9PT0gJ3N0cmluZycgPyBpZC5yZXBsYWNlKC9bXmEtekEtWjAtOV86LkAtXS9nLCAnJykuc2xpY2UoMCwgODApIDogJyc7XHJcbiAgICAgIGlmIChzaWQgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICdpZCByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oYC9hcGkvc2Vzc2lvbnMvJHtlbmNvZGVVUklDb21wb25lbnQoc2lkKX1gKSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnN0b3AtaG9zdCcsIChldmVudCkgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInIH07XHJcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcclxuICAgICAgICBzc2VBYm9ydD8uYWJvcnQoKTtcclxuICAgICAgICBhd2FpdCBzdXBlcnZpc29yPy5zdG9wKCk7XHJcbiAgICAgICAgYXBwLnF1aXQoKTtcclxuICAgICAgfSkoKTtcclxuICAgICAgcmV0dXJuIHsgb2s6IHRydWUgfTtcclxuICAgIH0pO1xyXG4gIH1cclxuXHJcbiAgLyogLS0tLSBcdTdBOTdcdTUzRTNcdTRFMEVcdTVCODlcdTUxNjhcdTdCNTZcdTc1NjUgLS0tLSAqL1xyXG4gIC8vIDAzIFx1MDBBN1x1NEUwMzpEZXNrdG9wIFx1NjcyQ1x1NTczMFx1NTNFQVx1NUI1OCBVSSBcdTUwNEZcdTU5N0QvXHU3QTk3XHU1M0UzXHU3MkI2XHU2MDAxKHVzZXJEYXRhL3dpbmRvdy1zdGF0ZS5qc29uKVxyXG4gIGNvbnN0IHdpbmRvd1N0YXRlRmlsZSA9ICgpOiBzdHJpbmcgPT4gam9pbihhcHAuZ2V0UGF0aCgndXNlckRhdGEnKSwgJ3dpbmRvdy1zdGF0ZS5qc29uJyk7XHJcbiAgYXN5bmMgZnVuY3Rpb24gbG9hZEJvdW5kcygpOiBQcm9taXNlPHsgd2lkdGg6IG51bWJlcjsgaGVpZ2h0OiBudW1iZXI7IHg/OiBudW1iZXI7IHk/OiBudW1iZXIgfSB8IG51bGw+IHtcclxuICAgIHRyeSB7XHJcbiAgICAgIHJldHVybiBKU09OLnBhcnNlKGF3YWl0IHJlYWRGaWxlKHdpbmRvd1N0YXRlRmlsZSgpLCAndXRmOCcpKSBhcyB7IHdpZHRoOiBudW1iZXI7IGhlaWdodDogbnVtYmVyOyB4PzogbnVtYmVyOyB5PzogbnVtYmVyIH07XHJcbiAgICB9IGNhdGNoIHsgcmV0dXJuIG51bGw7IH1cclxuICB9XHJcbiAgYXN5bmMgZnVuY3Rpb24gc2F2ZUJvdW5kcyh3aW46IEJyb3dzZXJXaW5kb3cpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIHRyeSB7IGF3YWl0IHdyaXRlRmlsZSh3aW5kb3dTdGF0ZUZpbGUoKSwgSlNPTi5zdHJpbmdpZnkod2luLmdldEJvdW5kcygpKSwgJ3V0ZjgnKTsgfSBjYXRjaCB7IC8qIGJlc3QgZWZmb3J0ICovIH1cclxuICB9XHJcblxyXG4gIGFzeW5jIGZ1bmN0aW9uIGNyZWF0ZVdpbmRvdygpOiBQcm9taXNlPEJyb3dzZXJXaW5kb3cgfCBudWxsPiB7XHJcbiAgICBjb25zdCBzYXZlZCA9IGF3YWl0IGxvYWRCb3VuZHMoKTtcclxuICAgIGNvbnN0IHdpbiA9IG5ldyBCcm93c2VyV2luZG93KHtcclxuICAgICAgd2lkdGg6IHNhdmVkPy53aWR0aCA/PyAxNDQwLFxyXG4gICAgICBoZWlnaHQ6IHNhdmVkPy5oZWlnaHQgPz8gOTAwLFxyXG4gICAgICAuLi4oc2F2ZWQ/LnggIT09IHVuZGVmaW5lZCAmJiBzYXZlZD8ueSAhPT0gdW5kZWZpbmVkID8geyB4OiBzYXZlZC54LCB5OiBzYXZlZC55IH0gOiB7fSksXHJcbiAgICAgIG1pbldpZHRoOiA5NjAsXHJcbiAgICAgIG1pbkhlaWdodDogNjAwLFxyXG4gICAgICBzaG93OiBmYWxzZSxcclxuICAgICAgYmFja2dyb3VuZENvbG9yOiAnI2Y5ZmFmYicsIC8vIHY0IERTSDpcdTZENDVcdTgyNzJcdTlFRDhcdThCQTQoYmctYmFzZSksXHU5MDdGXHU1MTREXHU2REYxXHU4MjcyXHU5NUVBXHU1QzRGXHJcbiAgICAgIHRpdGxlOiAnSE1IIERlc2t0b3AnLFxyXG4gICAgICAvLyBcdTk2OTBcdTg1Q0ZcdTVGMEZcdTY4MDdcdTk4OThcdTY4MEY6XHU1MzlGXHU3NTFGXHU3QTk3XHU1M0UzXHU2M0E3XHU1MjM2KG92ZXJsYXkgXHU2M0QwXHU0RjlCKStcdTk4OUNcdTgyNzJcdTk2OEZcdTRFM0JcdTk4OTgocmVuZGVyZXIgXHU3RUNGXHJcbiAgICAgIC8vIGNocm9tZS10aGVtZSBcdTU0MENcdTZCNjUpXHUyMDE0XHUyMDE0XHU2ODM5XHU2Q0JCXHU0RUFFXHU4MjcyXHU2QTIxXHU1RjBGXHU5ODc2XHU5MEU4XHU5RUQxXHU2NzYxO1x1ODNEQ1x1NTM1NVx1NjgwRiBhdXRvSGlkZShBbHQgXHU1NDdDXHU1MUZBKVx1MzAwMlxyXG4gICAgICB0aXRsZUJhclN0eWxlOiAnaGlkZGVuJyxcclxuICAgICAgdGl0bGVCYXJPdmVybGF5OiB7IC4uLmNocm9tZUZvcihuYXRpdmVUaGVtZS5zaG91bGRVc2VEYXJrQ29sb3JzKSwgaGVpZ2h0OiAzNiB9LFxyXG4gICAgICBhdXRvSGlkZU1lbnVCYXI6IHRydWUsXHJcbiAgICAgIHdlYlByZWZlcmVuY2VzOiB7XHJcbiAgICAgICAgcHJlbG9hZDogcHJlbG9hZFBhdGgsXHJcbiAgICAgICAgY29udGV4dElzb2xhdGlvbjogdHJ1ZSxcclxuICAgICAgICBzYW5kYm94OiB0cnVlLFxyXG4gICAgICAgIG5vZGVJbnRlZ3JhdGlvbjogZmFsc2UsXHJcbiAgICAgICAgbm9kZUludGVncmF0aW9uSW5Xb3JrZXI6IGZhbHNlLFxyXG4gICAgICAgIHdlYlNlY3VyaXR5OiB0cnVlLFxyXG4gICAgICAgIHNwZWxsY2hlY2s6IGZhbHNlLFxyXG4gICAgICAgIGRldlRvb2xzOiBpc0RldixcclxuICAgICAgfSxcclxuICAgIH0pO1xyXG4gICAgd2luLm9uY2UoJ3JlYWR5LXRvLXNob3cnLCAoKSA9PiB3aW4uc2hvdygpKTtcclxuICAgIHdpbi5vbignY2xvc2UnLCAoKSA9PiB7IHZvaWQgc2F2ZUJvdW5kcyh3aW4pOyB9KTtcclxuXHJcbiAgICAvLyBcdTUzRUFcdTUxNDFcdThCQjhcdTUyQTBcdThGN0RcdTYyMTFcdTRFRUNcdTgxRUFcdTVERjFcdTc2ODQgcmVuZGVyZXI7XHU0RUZCXHU0RjU1XHU1QkZDXHU4MjJBL1x1NjVCMFx1N0E5N1x1NTNFM1x1NEUwMFx1NUY4Qlx1NjJEMlx1N0VERFxyXG4gICAgd2luLndlYkNvbnRlbnRzLnNldFdpbmRvd09wZW5IYW5kbGVyKCh7IHVybCB9KSA9PiB7XHJcbiAgICAgIGlmICgvXmh0dHBzPzpcXC9cXC8vLnRlc3QodXJsKSkgdm9pZCBzaGVsbC5vcGVuRXh0ZXJuYWwodXJsKTtcclxuICAgICAgcmV0dXJuIHsgYWN0aW9uOiAnZGVueScgfTtcclxuICAgIH0pO1xyXG4gICAgd2luLndlYkNvbnRlbnRzLm9uKCd3aWxsLW5hdmlnYXRlJywgKGUsIHVybCkgPT4ge1xyXG4gICAgICBjb25zdCBvayA9IFsuLi5hbGxvd2VkT3JpZ2luc10uc29tZSgobykgPT4gdXJsID09PSBvIHx8IHVybC5zdGFydHNXaXRoKGAke299L2ApIHx8IHVybC5zdGFydHNXaXRoKGAke299P2ApKTtcclxuICAgICAgaWYgKCFvaykge1xyXG4gICAgICAgIGxvZ0luZm8oJ25hdicsIGBibG9ja2VkIG5hdmlnYXRpb24gdG8gJHt1cmwuc2xpY2UoMCwgMTIwKX1gKTtcclxuICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7XHJcbiAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIGlmIChpc0RldiAmJiByZW5kZXJlckRldlVybCkge1xyXG4gICAgICB2b2lkIHdpbi5sb2FkVVJMKHJlbmRlcmVyRGV2VXJsKTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgIHZvaWQgd2luLmxvYWRGaWxlKGpvaW4oaGVyZSwgJy4uJywgJy4uJywgJ2Rpc3QtcmVuZGVyZXInLCAnaW5kZXguaHRtbCcpKTtcclxuICAgIH1cclxuICAgIC8vIFx1OTg3NVx1OTc2Mlx1NTJBMFx1OEY3RFx1NUI4Q1x1OTFDRFx1NjRBRFx1NUY1M1x1NTI0RCBob3N0IFx1NzJCNlx1NjAwMTpyZWFkeSBcdTVFN0ZcdTY0QURcdTgyRTVcdTY1RTlcdTRFOEUgcmVuZGVyZXIgXHU4QkEyXHU5NjA1XHU1MzczXHU0RTIyXHU1OTMxLFxyXG4gICAgLy8gcmVuZGVyZXIgXHU3Njg0IGdldC1zdGF0ZSBcdTVGRUJcdTcxNjcgKyBcdThGRDlcdTkxQ0NcdTc2ODRcdTkxQ0RcdTY0QURcdTUzQ0NcdTRGRERcdTk2NjkoXHU1OTFBXHU3QTk3XHU1M0UzL1x1OTFDRFx1OEY3RFx1NTczQVx1NjY2Rlx1NEU1Rlx1ODk4Nlx1NzZENilcdTMwMDJcclxuICAgIHdpbi53ZWJDb250ZW50cy5vbmNlKCdkaWQtZmluaXNoLWxvYWQnLCAoKSA9PiB7XHJcbiAgICAgIGlmICghd2luLmlzRGVzdHJveWVkKCkpIHtcclxuICAgICAgICB3aW4ud2ViQ29udGVudHMuc2VuZCgnYnJpZGdlOmhvc3Qtc3RhdGUnLCBicmlkZ2UuaG9zdFN0YXRlLCB7IHJlc3RhcnRDb3VudDogMCB9KTtcclxuICAgICAgfVxyXG4gICAgfSk7XHJcbiAgICByZXR1cm4gd2luO1xyXG4gIH1cclxuXHJcbiAgYXBwLndoZW5SZWFkeSgpLnRoZW4oKCkgPT4ge1xyXG4gICAgLy8gVUlWRVJJRlk6ZmFrZSBcdTZBMjFcdTVGMEZcdTlBOENcdTY1MzZcdTk4N0JcdTU3Mjggc3RhcnRIb3N0IFx1OEJGQiBlbnYgXHU0RTRCXHU1MjREXHU1RjNBXHU1MjM2IGZha2VcclxuICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWSA9PT0gJzEnICYmIHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX01PREUgIT09ICdyZWFsJykge1xyXG4gICAgICBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9GQUtFID0gJzEnO1xyXG4gICAgfVxyXG4gICAgLy8gV2luZG93cyBcdTkwMUFcdTc3RTVcdTVGNTJcdTVDNUUoXHU1NDI2XHU1MjE5XHU2NjNFXHU3OTNBXHU0RTNBIGVsZWN0cm9uLmV4ZSlcclxuICAgIGFwcC5zZXRBcHBVc2VyTW9kZWxJZCgnZGV2LmhtaC5kZXNrdG9wJyk7XHJcbiAgICBzZXR1cFRyYXkoKTtcclxuICAgIGJ1aWxkQXBwTWVudSgpO1xyXG4gICAgLy8gXHU1NDJGXHU1MkE4IDMwcyBcdTU0MEVcdTk3NTlcdTlFRDhcdTY4QzBcdTY3RTVcdTY2RjRcdTY1QjAoXHU2NzA5XHU2NUIwXHU3MjQ4XHU0RUM1XHU1NDBFXHU1M0YwXHU0RTBCXHU4RjdELFx1NEUwRFx1NjI1M1x1NjI3MDtcdTc1MjhcdTYyMzdcdTdFQ0YgXHUyNjMwIFx1ODNEQ1x1NTM1NVx1NTFCM1x1NUI5QVx1ODhDNSlcclxuICAgIGlmIChhcHAuaXNQYWNrYWdlZCkgc2V0VGltZW91dCgoKSA9PiB7IHZvaWQgY2hlY2tGb3JVcGRhdGVzKCk7IH0sIDMwXzAwMCk7XHJcbiAgICAvLyBDU1AoZGV2IFx1NEUwRSBwcm9kIFx1NEUwRFx1NTQwQztwcm9kIFx1NEUwRFx1NTE0MVx1OEJCOFx1NEVGQlx1NEY1NVx1OEZEQ1x1N0EwQlx1NkU5MClcclxuICAgIGNvbnN0IGNzcCA9IGlzRGV2XHJcbiAgICAgID8gW1xyXG4gICAgICAgICAgXCJkZWZhdWx0LXNyYyAnc2VsZidcIixcclxuICAgICAgICAgIGBzY3JpcHQtc3JjICdzZWxmJyAke3JlbmRlcmVyRGV2VXJsfWAsXHJcbiAgICAgICAgICBcInN0eWxlLXNyYyAnc2VsZicgJ3Vuc2FmZS1pbmxpbmUnXCIsXHJcbiAgICAgICAgICBgY29ubmVjdC1zcmMgJ3NlbGYnICR7cmVuZGVyZXJEZXZVcmx9IHdzOi8vMTI3LjAuMC4xOipgLFxyXG4gICAgICAgICAgXCJpbWctc3JjICdzZWxmJyBkYXRhOlwiLFxyXG4gICAgICAgICAgXCJmb250LXNyYyAnc2VsZicgZGF0YTpcIixcclxuICAgICAgICBdLmpvaW4oJzsgJylcclxuICAgICAgOiBcImRlZmF1bHQtc3JjICdzZWxmJzsgc2NyaXB0LXNyYyAnc2VsZic7IHN0eWxlLXNyYyAnc2VsZicgJ3Vuc2FmZS1pbmxpbmUnOyBpbWctc3JjICdzZWxmJyBkYXRhOjsgZm9udC1zcmMgJ3NlbGYnIGRhdGE6XCI7XHJcbiAgICBzZXNzaW9uLmRlZmF1bHRTZXNzaW9uLndlYlJlcXVlc3Qub25IZWFkZXJzUmVjZWl2ZWQoKGRldGFpbHMsIGNhbGxiYWNrKSA9PiB7XHJcbiAgICAgIGNhbGxiYWNrKHtcclxuICAgICAgICByZXNwb25zZUhlYWRlcnM6IHtcclxuICAgICAgICAgIC4uLmRldGFpbHMucmVzcG9uc2VIZWFkZXJzLFxyXG4gICAgICAgICAgJ0NvbnRlbnQtU2VjdXJpdHktUG9saWN5JzogW2NzcF0sXHJcbiAgICAgICAgfSxcclxuICAgICAgfSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICByZWdpc3RlcklwYygpO1xyXG4gICAgLy8gY3JlYXRlV2luZG93IFx1NjYyRiBhc3luYyhib3VuZHMgXHU2MDYyXHU1OTBEKTtcdTVCODlcdTUxNjhcdTgxRUFcdTZENEIvXHU2RTMyXHU2N0QzXHU4MUVBXHU2OEMwXHU1NzI4XHU3QTk3XHU1M0UzXHU1QzMxXHU3RUVBXHU1NDBFXHU2MzAyXHU4RjdEXHJcbiAgICB2b2lkIGNyZWF0ZVdpbmRvdygpLnRoZW4oKHdpbikgPT4ge1xyXG4gICAgICBpZiAod2luID09PSBudWxsKSByZXR1cm47XHJcbiAgICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWSA9PT0gJzEnKSBhdHRhY2hVaVZlcmlmeSh3aW4pO1xyXG4gICAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfU0VDVVJJVFlfVEVTVCA9PT0gJzEnKSB7XHJcbiAgICAgICAgd2luLndlYkNvbnRlbnRzLm9uY2UoJ2RpZC1maW5pc2gtbG9hZCcsICgpID0+IHtcclxuICAgICAgICAgIHZvaWQgc2VjdXJpdHlTZWxmVGVzdCh3aW4pO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICB9XHJcbiAgICAgIC8vIFVJIFx1NjIyQVx1NTZGRVx1OTRBOVx1NUI1MDpITUhfREVTS1RPUF9TTkFQU0hPVD08ZmlsZS5wbmc+IFx1NTcyOFx1NzU0Q1x1OTc2Mlx1NUMzMVx1N0VFQVx1NTQwRVx1NjIyQVx1NTZGRVx1OTAwMFx1NTFGQVxyXG4gICAgICAvLyAoXHU4OEM1XHU2NzNBXHU4QkNBXHU2NUFEXHU3NTI4Olx1NEVCMlx1NzczQ1x1NzcwQlx1NkUzMlx1NjdEM1x1N0VEM1x1Njc5QyxcdTgwMENcdTRFMERcdTY2MkZcdTUzRUFcdTY1NzAgcm9vdCBcdTVCNTBcdTgyODJcdTcwQjkpXHUzMDAyXHJcbiAgICAgIGNvbnN0IHNuYXAgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9TTkFQU0hPVDtcclxuICAgICAgaWYgKHNuYXAgIT09IHVuZGVmaW5lZCAmJiBzbmFwICE9PSAnJykge1xyXG4gICAgICAgIHdpbi53ZWJDb250ZW50cy5vbmNlKCdkaWQtZmluaXNoLWxvYWQnLCAoKSA9PiB7XHJcbiAgICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHtcclxuICAgICAgICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBpbWcgPSBhd2FpdCB3aW4ud2ViQ29udGVudHMuY2FwdHVyZVBhZ2UoKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHsgd3JpdGVGaWxlOiB3ZiB9ID0gYXdhaXQgaW1wb3J0KCdub2RlOmZzL3Byb21pc2VzJyk7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCB3ZihzbmFwLCBpbWcudG9QTkcoKSk7XHJcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgU05BUFNIT1Qgb2sgJHtzbmFwfSAke2ltZy5nZXRTaXplKCkud2lkdGh9eCR7aW1nLmdldFNpemUoKS5oZWlnaHR9YCk7XHJcbiAgICAgICAgICAgICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgU05BUFNIT1QgZXJyb3IgJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApfWApO1xyXG4gICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICBjb25zdCBhcHAyID0gYXBwO1xyXG4gICAgICAgICAgICAgIHNldFRpbWVvdXQoKCkgPT4gYXBwMi5leGl0KDApLCA1MDApO1xyXG4gICAgICAgICAgICB9KSgpO1xyXG4gICAgICAgICAgfSwgTnVtYmVyKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NOQVBTSE9UX0RFTEFZX01TID8/IDEyXzAwMCkpO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICB9XHJcbiAgICAgIC8vIERPTSBcdTdFRDNcdTY3ODRcdTYzQTJcdTk0ODg6SE1IX0RFU0tUT1BfRE9NUFJPQkU9MSBcdThGOTNcdTUxRkFcdTUxNzNcdTk1MkVcdTUxNDNcdTdEMjBcdTc2ODQgYm94L2Rpc3BsYXkvY2hpbGRyZW4sXHJcbiAgICAgIC8vIFx1NTE4RFx1OTAwMFx1NTFGQShcdThCQ0FcdTY1QURcIlJlYWN0IFx1NjMwMlx1OEY3RFx1NEU4Nlx1NEY0Nlx1NjdEMFx1NTc1NyBVSSBcdTRFMERcdTUzRUZcdTg5QzFcIlx1OEZEOVx1N0M3Qlx1OTVFRVx1OTg5ODtcdTYyMkFcdTU2RkVcdTRFNEJcdTU5MTZcdTc2ODRcdTc4NkNcdThCQzFcdTYzNkUpXHUzMDAyXHJcbiAgICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9ET01QUk9CRSA9PT0gJzEnKSB7XHJcbiAgICAgICAgd2luLndlYkNvbnRlbnRzLm9uY2UoJ2RpZC1maW5pc2gtbG9hZCcsICgpID0+IHtcclxuICAgICAgICAgIHNldFRpbWVvdXQoKCkgPT4ge1xyXG4gICAgICAgICAgICB2b2lkIChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHIgPSAoYXdhaXQgd2luLndlYkNvbnRlbnRzLmV4ZWN1dGVKYXZhU2NyaXB0KGAoZnVuY3Rpb24oKXtcclxuICAgICAgICAgICAgICAgICAgdmFyIHBpY2sgPSBmdW5jdGlvbihzZWwpe1xyXG4gICAgICAgICAgICAgICAgICAgIHZhciBlbHMgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKHNlbCk7XHJcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGVscywgMCwgNCkubWFwKGZ1bmN0aW9uKGVsKXtcclxuICAgICAgICAgICAgICAgICAgICAgIHZhciBjcyA9IGdldENvbXB1dGVkU3R5bGUoZWwpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgdmFyIGIgPSBlbC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcclxuICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB7IGNsczogKGVsLmNsYXNzTmFtZXx8JycpLnRvU3RyaW5nKCkuc2xpY2UoMCw4MCksIHRhZzogZWwudGFnTmFtZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgZGlzcGxheTogY3MuZGlzcGxheSwgdmlzOiBjcy52aXNpYmlsaXR5LCBvcGFjaXR5OiBjcy5vcGFjaXR5LFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBwb3M6IGNzLnBvc2l0aW9uLCB6OiBjcy56SW5kZXgsIG92ZXJmbG93OiBjcy5vdmVyZmxvdyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgeDogTWF0aC5yb3VuZChiLngpLCB5OiBNYXRoLnJvdW5kKGIueSksIHc6IE1hdGgucm91bmQoYi53aWR0aCksIGg6IE1hdGgucm91bmQoYi5oZWlnaHQpLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB0ZXh0OiAoZWwuaW5uZXJUZXh0fHwnJykucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDYwKSB9O1xyXG4gICAgICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgICB9O1xyXG4gICAgICAgICAgICAgICAgICB2YXIgc2VscyA9IFsnaHRtbCcsJ2JvZHknLCcjcm9vdCcsJy5hcHAtc2hlbGwnLCcuc2lkZWJhcicsJy53b3Jrc3BhY2UnLCcudG9wYmFyJywnLnN0cmVhbScsJy5lbXB0eS1oaW50JywnLmNvbXBvc2VyJywnLmNvbXBvc2VyLXJvdycsJy5jb21wb3NlciB0ZXh0YXJlYScsJy5jb21wb3Nlci1zaWRlJywnLmF0dC1waWNrZXInLCcuYXR0LWNoaXBzJywnLnNpZGVwYW5lbCcsJy5ydW50aW1lLWd1aWRlJywnLm92ZXJsYXknLCcudHVybicsJy5jYXJkJ107XHJcbiAgICAgICAgICAgICAgICAgIHZhciBvdXQgPSB7fTtcclxuICAgICAgICAgICAgICAgICAgc2Vscy5mb3JFYWNoKGZ1bmN0aW9uKHMpeyB0cnkgeyBvdXRbc10gPSBwaWNrKHMpOyB9IGNhdGNoKGUpeyBvdXRbc10gPSBbe2VycjogU3RyaW5nKGUpLnNsaWNlKDAsODApfV07IH0gfSk7XHJcbiAgICAgICAgICAgICAgICAgIG91dC5fX21ldGEgPSB7XHJcbiAgICAgICAgICAgICAgICAgICAgc3R5bGVTaGVldHM6IGRvY3VtZW50LnN0eWxlU2hlZXRzLmxlbmd0aCxcclxuICAgICAgICAgICAgICAgICAgICBzaGVldDBydWxlczogKGRvY3VtZW50LnN0eWxlU2hlZXRzWzBdICYmIGRvY3VtZW50LnN0eWxlU2hlZXRzWzBdLmNzc1J1bGVzKSA/IGRvY3VtZW50LnN0eWxlU2hlZXRzWzBdLmNzc1J1bGVzLmxlbmd0aCA6IC0xLFxyXG4gICAgICAgICAgICAgICAgICAgIHJvb3RDaGlsZHJlbjogZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Jvb3QnKSA/IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyb290JykuY2hpbGRyZW4ubGVuZ3RoIDogLTEsXHJcbiAgICAgICAgICAgICAgICAgICAgYm9keUNoaWxkcmVuOiBkb2N1bWVudC5ib2R5LmNoaWxkcmVuLmxlbmd0aCxcclxuICAgICAgICAgICAgICAgICAgICBpbm5lckhUTUxMZW46IGRvY3VtZW50LmJvZHkuaW5uZXJIVE1MLmxlbmd0aCxcclxuICAgICAgICAgICAgICAgICAgICB2aWV3cG9ydDogd2luZG93LmlubmVyV2lkdGggKyAneCcgKyB3aW5kb3cuaW5uZXJIZWlnaHRcclxuICAgICAgICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KG91dCk7XHJcbiAgICAgICAgICAgICAgICB9KSgpYCwgdHJ1ZSkpIGFzIHN0cmluZztcclxuICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBET01QUk9CRSAke3J9YCk7XHJcbiAgICAgICAgICAgICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgRE9NUFJPQkUgZXJyb3IgJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAyMDApfWApO1xyXG4gICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICBhcHAuZXhpdCgwKTtcclxuICAgICAgICAgICAgfSkoKTtcclxuICAgICAgICAgIH0sIE51bWJlcihwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9ET01QUk9CRV9ERUxBWV9NUyA/PyA5XzAwMCkpO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICB9XHJcbiAgICAgIC8vIFx1NkUzMlx1NjdEM1x1ODFFQVx1NjhDMCgyMDI2LTEwLTEwIFx1ODhDNVx1NjczQVx1OUVEMVx1NUM0Rlx1NjU1OVx1OEJBRDpicmlkZ2UgcmVhZHkgXHUyMjYwIFx1NzU0Q1x1OTc2Mlx1NkUzMlx1NjdEM1x1NEU4NilcdTMwMDJcclxuICAgICAgLy8gI3Jvb3QgXHU1NzI4IFJlYWN0IFx1NjMwMlx1OEY3RFx1NTQwRVx1NUZDNVx1NjcwOVx1NUI1MFx1ODI4Mlx1NzBCOTtcdTdBN0EgPSBcdThENDRcdTZFOTBcdThERUZcdTVGODQvQ1NQL1x1ODExQVx1NjcyQ1x1NTJBMFx1OEY3RFx1NTc0Rlx1NEU4Nlx1MzAwMlxyXG4gICAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfUkVOREVSX1RFU1QgPT09ICcxJykge1xyXG4gICAgICAgIHdpbi53ZWJDb250ZW50cy5vbmNlKCdkaWQtZmluaXNoLWxvYWQnLCAoKSA9PiB7XHJcbiAgICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHtcclxuICAgICAgICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBuID0gKGF3YWl0IHdpbi53ZWJDb250ZW50cy5leGVjdXRlSmF2YVNjcmlwdChcclxuICAgICAgICAgICAgICAgICAgJ2RvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwicm9vdFwiKSA/IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwicm9vdFwiKS5jaGlsZHJlbi5sZW5ndGggOiAtMScsIHRydWUsXHJcbiAgICAgICAgICAgICAgICApKSBhcyBudW1iZXI7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBvayA9IG4gPiAwO1xyXG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYFJFTkRFUi1URVNUICR7b2sgPyAnb2snIDogJ0VNUFRZJ30gcm9vdENoaWxkcmVuPSR7bn1gKTtcclxuICAgICAgICAgICAgICAgIGFwcC5leGl0KG9rID8gMCA6IDEpO1xyXG4gICAgICAgICAgICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYFJFTkRFUi1URVNUIEVSUk9SICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTIwKX1gKTtcclxuICAgICAgICAgICAgICAgIGFwcC5leGl0KDEpO1xyXG4gICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfSkoKTtcclxuICAgICAgICAgIH0sIDJfNTAwKTtcclxuICAgICAgICB9KTtcclxuICAgICAgfVxyXG4gICAgfSk7XHJcbiAgICB2b2lkIHN0YXJ0SG9zdCgpO1xyXG5cclxuICAgIGFwcC5vbignYWN0aXZhdGUnLCAoKSA9PiB7XHJcbiAgICAgIGlmIChCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5sZW5ndGggPT09IDApIHZvaWQgY3JlYXRlV2luZG93KCk7XHJcbiAgICB9KTtcclxuICB9KTtcclxuXHJcbiAgYXN5bmMgZnVuY3Rpb24gc2VjdXJpdHlTZWxmVGVzdCh3aW46IEJyb3dzZXJXaW5kb3cpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IHJlc3VsdHM6IEFycmF5PFtzdHJpbmcsIGJvb2xlYW4sIHN0cmluZ10+ID0gW107XHJcbiAgICBjb25zdCBjaGVjayA9IGFzeW5jIChuYW1lOiBzdHJpbmcsIHByb2JlOiAoKSA9PiBQcm9taXNlPFtib29sZWFuLCBzdHJpbmddPik6IFByb21pc2U8dm9pZD4gPT4ge1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IFtvaywgZGV0YWlsXSA9IGF3YWl0IHByb2JlKCk7XHJcbiAgICAgICAgcmVzdWx0cy5wdXNoKFtuYW1lLCBvaywgZGV0YWlsXSk7XHJcbiAgICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICAgIHJlc3VsdHMucHVzaChbbmFtZSwgZmFsc2UsIFN0cmluZyhlcnIpLnNsaWNlKDAsIDEyMCldKTtcclxuICAgICAgfVxyXG4gICAgfTtcclxuICAgIGNvbnN0IGpzID0gKGNvZGU6IHN0cmluZyk6IFByb21pc2U8dW5rbm93bj4gPT4gd2luLndlYkNvbnRlbnRzLmV4ZWN1dGVKYXZhU2NyaXB0KGNvZGUsIHRydWUpO1xyXG5cclxuICAgIGF3YWl0IGNoZWNrKCdyZW5kZXJlciBcdTY1RTBcdTUzRUZcdTc1MjhcdTc2ODQgcHJvY2Vzcy9yZXF1aXJlKHNhbmRib3ggXHU3NTFGXHU2NTQ4KScsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgciA9IChhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XHJcbiAgICAgICAgdmFyIHQgPSBmdW5jdGlvbihmKXsgdHJ5IHsgdmFyIHYgPSBmKCk7IHJldHVybiAodiA9PT0gdW5kZWZpbmVkIHx8IHYgPT09IG51bGwpID8gJ3VuYXZhaWxhYmxlJyA6IHR5cGVvZiB2OyB9IGNhdGNoKGUpeyByZXR1cm4gJ2Jsb2NrZWQnOyB9IH07XHJcbiAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KFt0KGZ1bmN0aW9uKCl7cmV0dXJuIHByb2Nlc3N9KSwgdChmdW5jdGlvbigpe3JldHVybiByZXF1aXJlfSksIHQoZnVuY3Rpb24oKXtyZXR1cm4gZ2xvYmFsVGhpcy5wcm9jZXNzfSldKTtcclxuICAgICAgfSkoKWApKSBhcyBzdHJpbmc7XHJcbiAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocikgYXMgc3RyaW5nW107XHJcbiAgICAgIGNvbnN0IHAgPSBwYXJzZWRbMF0gPz8gJ3Vua25vd24nO1xyXG4gICAgICBjb25zdCByZXEgPSBwYXJzZWRbMV0gPz8gJ3Vua25vd24nO1xyXG4gICAgICBjb25zdCBzYWZlID0gKHY6IHN0cmluZyk6IGJvb2xlYW4gPT4gdiA9PT0gJ3VuYXZhaWxhYmxlJyB8fCB2ID09PSAnYmxvY2tlZCc7XHJcbiAgICAgIHJldHVybiBbc2FmZShwKSAmJiBzYWZlKHJlcSksIGBwcm9jZXNzPSR7cH0gcmVxdWlyZT0ke3JlcX1gXTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgY2hlY2soJ3dpbmRvdy5obWggXHU1M0VBXHU2NzA5XHU3NjdEXHU1NDBEXHU1MzU1XHU2NUI5XHU2Q0Q1KFx1NjVFMCBpcGNSZW5kZXJlci9cdTk4OURcdTU5MTZcdTk3NjIpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKCdPYmplY3Qua2V5cyh3aW5kb3cuaG1oIHx8IHt9KS5zb3J0KCkuam9pbihcIixcIiknKSkgYXMgc3RyaW5nO1xyXG4gICAgICBjb25zdCBhbGxvdyA9IFsnYXBwbHlVcGRhdGUnLCAnYXBwcm92ZScsICdhcHByb3ZhbEdldCcsICdhcHByb3ZhbFNldCcsICdicm93c2VSdW50aW1lJywgJ2NoZWNrVXBkYXRlJywgJ2Nocm9tZVRoZW1lJywgJ2NvZ25pdGl2ZScsICdkZXRlY3RSdW50aW1lJywgJ2RpZmYnLCAnZXhwb3J0U2Vzc2lvbicsICdmc0xpc3QnLCAnZnNSZWFkJywgJ2ZzU2VhcmNoJywgJ2dldFN0YXRlJywgJ2dldFdpemFyZCcsICdpbmplY3QnLCAnaW5zdGFsbENsaScsICdpbnRlcnJ1cHQnLCAnbW9kZWxTZXQnLCAnb25FdmVudEJhdGNoZXMnLCAnb25Ib3N0U3RhdGUnLCAnb25JbnN0YWxsUHJvZ3Jlc3MnLCAnb25NZW51QWN0aW9uJywgJ29uU3RyZWFtQ2h1bmtzJywgJ29uVXBkYXRlU3RhdGUnLCAncGlja0RpcmVjdG9yeScsICdwaWNrRmlsZXMnLCAncG9wdXBNYWluTWVudScsICdwcm92aWRlclNhdmUnLCAncHJvdmlkZXJzJywgJ3JlbW90ZVdlYkF1dG9zdGFydCcsICdyZW1vdGVXZWJTdGFydCcsICdyZW1vdGVXZWJTdGF0dXMnLCAncmVtb3RlV2ViU3RvcCcsICdydW50aW1lSW5mbycsICdzZW5kVGFzaycsICdzZXNzaW9uT3AnLCAnc2Vzc2lvblByZXZpZXcnLCAnc2Vzc2lvbnMnLCAnc2V0UnVudGltZScsICdzdG9wSG9zdCcsICd3aXphcmRDb21wbGV0ZScsICd3b3Jrc3BhY2VzJywgJ3dvcmtzcGFjZUFkZCcsICd3b3Jrc3BhY2VVc2UnXTtcclxuICAgICAgY29uc3QgZ290ID0gciA9PT0gJycgPyBbXSA6IHIuc3BsaXQoJywnKTtcclxuICAgICAgY29uc3QgdW5leHBlY3RlZCA9IGdvdC5maWx0ZXIoKGspID0+ICFhbGxvdy5pbmNsdWRlcyhrKSk7XHJcbiAgICAgIHJldHVybiBbdW5leHBlY3RlZC5sZW5ndGggPT09IDAsIGBrZXlzPSR7cn1gXTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgY2hlY2soJ1x1NTkxNlx1OTBFOFx1NUJGQ1x1ODIyQVx1ODhBQlx1NjJFNlx1NjIyQShVUkwgXHU0RTBEXHU1M0Q4KScsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgYmVmb3JlID0gd2luLndlYkNvbnRlbnRzLmdldFVSTCgpO1xyXG4gICAgICBhd2FpdCBqcygnbG9jYXRpb24uaHJlZiA9IFwiaHR0cHM6Ly9leGFtcGxlLmludmFsaWQveFwiOyBcIm5vb3BcIicpLmNhdGNoKCgpID0+ICdub29wJyk7XHJcbiAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyMikgPT4gc2V0VGltZW91dChyMiwgMV8yMDApKTtcclxuICAgICAgY29uc3QgYWZ0ZXIgPSB3aW4ud2ViQ29udGVudHMuZ2V0VVJMKCk7XHJcbiAgICAgIHJldHVybiBbYWZ0ZXIgPT09IGJlZm9yZSwgYCR7YmVmb3JlfSBcdTIxOTIgJHthZnRlcn1gXTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgY2hlY2soJ3dpbmRvdy5vcGVuIFx1ODhBQlx1NjJEMlx1N0VERChcdThGRDRcdTU2REUgbnVsbCBcdTRFMTRcdTY1RTBcdTY1QjBcdTdBOTdcdTUzRTMpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCBiZWZvcmUgPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5sZW5ndGg7XHJcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoJ1N0cmluZyh3aW5kb3cub3BlbihcImh0dHBzOi8vZXhhbXBsZS5pbnZhbGlkXCIpKScpKSBhcyBzdHJpbmc7XHJcbiAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyMikgPT4gc2V0VGltZW91dChyMiwgNDAwKSk7XHJcbiAgICAgIGNvbnN0IGFmdGVyID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkubGVuZ3RoO1xyXG4gICAgICByZXR1cm4gW3IgPT09ICdudWxsJyAmJiBhZnRlciA9PT0gYmVmb3JlLCBgb3BlbigpPSR7cn0gd2luZG93cz0ke2JlZm9yZX1cdTIxOTIke2FmdGVyfWBdO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBjaGVjaygnQ1NQIFx1NUI1OFx1NTcyOChtZXRhIFx1NkNFOFx1NTE2NVx1NjIxNlx1NTRDRFx1NUU5NFx1NTkzNCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IG1ldGEgPSAoYXdhaXQganMoJ0Jvb2xlYW4oZG9jdW1lbnQucXVlcnlTZWxlY3RvcihcIm1ldGFbaHR0cC1lcXVpdj1cXCdDb250ZW50LVNlY3VyaXR5LVBvbGljeVxcJ11cIikpJykpIGFzIGJvb2xlYW47XHJcbiAgICAgIGNvbnN0IGhlYWRlckNzcCA9IGlzRGV2ID8gJ2RldjogaGVhZGVyIENTUCBcdTc1MzEgb25IZWFkZXJzUmVjZWl2ZWQgXHU2Q0U4XHU1MTY1KFx1NEUwRFx1OTAwMlx1NzUyOCBtZXRhIFx1NjVBRFx1OEEwMCknIDogJ3Byb2QnO1xyXG4gICAgICByZXR1cm4gW21ldGEgfHwgaXNEZXYsIGBtZXRhPSR7bWV0YX0gJHtoZWFkZXJDc3B9YF07XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IGNoZWNrKCdicmlkZ2U6Z2V0LXN0YXRlIFx1NkI2M1x1NUUzOFx1OEZENFx1NTZERShob3N0IFx1Njg2NVx1NTNFRlx1NzUyOCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoJ3dpbmRvdy5obWguZ2V0U3RhdGUoKS50aGVuKHMgPT4gSlNPTi5zdHJpbmdpZnkocykpLmNhdGNoKGUgPT4gXCJFUlI6XCIrZSknKSkgYXMgc3RyaW5nO1xyXG4gICAgICByZXR1cm4gW3Iuc3RhcnRzV2l0aCgneycpICYmIHIuaW5jbHVkZXMoJ2hvc3RTdGF0ZScpLCByLnNsaWNlKDAsIDgwKV07XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IGNoZWNrKCdYU1M6XHU2MDc2XHU2MTBGXHU0RUZCXHU1MkExXHU2NTg3XHU2NzJDXHU1M0VBXHU0RUU1XHU2NTg3XHU2NzJDXHU2RTMyXHU2N0QzKFx1NEUwRFx1NjI2N1x1ODg0QyknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHBheWxvYWQgPSAnPGltZyBzcmM9eCBvbmVycm9yPVwid2luZG93Ll9feHNzPTFcIj48c2NyaXB0PndpbmRvdy5fX3hzcz0yPFxcL3NjcmlwdD5cIiZcXCcnO1xyXG4gICAgICBjb25zdCBzZW5kUiA9IChhd2FpdCBqcyhgd2luZG93LmhtaC5zZW5kVGFzaygke0pTT04uc3RyaW5naWZ5KHBheWxvYWQpfSwgJ3NlYy14c3MtMScsICdhdXRvJykudGhlbihyPT5KU09OLnN0cmluZ2lmeShyKSkuY2F0Y2goZT0+J0VSUjonK2UpYCkpIGFzIHN0cmluZztcclxuICAgICAgaWYgKCFzZW5kUi5pbmNsdWRlcygnXCJva1wiOnRydWUnKSkgcmV0dXJuIFtmYWxzZSwgYHNlbmRUYXNrIFx1NjcyQVx1NTNEN1x1NzQwNjogJHtzZW5kUi5zbGljZSgwLCA4MCl9YF07XHJcbiAgICAgIC8vIGZha2UgaG9zdCBlY2hvIFx1NTZERVx1Njc2NVx1NTQwRVx1N0VDRiBSZWFjdCBcdTZFMzJcdTY3RDMoXHU3NTI4XHU2MjM3XHU2RDg4XHU2MDZGICsgXHU1MkE5XHU2MjRCIGVjaG8gXHU1M0NDXHU4REVGXHU1Rjg0KVxyXG4gICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocjIpID0+IHNldFRpbWVvdXQocjIsIDNfMDAwKSk7XHJcbiAgICAgIGNvbnN0IHByb2JlID0gKGF3YWl0IGpzKGBKU09OLnN0cmluZ2lmeSh7XHJcbiAgICAgICAgeHNzRmxhZzogdHlwZW9mIHdpbmRvdy5fX3hzcyxcclxuICAgICAgICBpbWdDb3VudDogZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnaW1nW3NyYz1cInhcIl0nKS5sZW5ndGgsXHJcbiAgICAgICAgc2NyaXB0UmFuOiBkb2N1bWVudC5ib2R5LmlubmVyVGV4dC5pbmRleE9mKCd3aW5kb3cuX194c3M9MicpID49IDBcclxuICAgICAgfSlgKSkgYXMgc3RyaW5nO1xyXG4gICAgICBjb25zdCBwID0gSlNPTi5wYXJzZShwcm9iZSkgYXMgeyB4c3NGbGFnOiBzdHJpbmc7IGltZ0NvdW50OiBudW1iZXI7IHNjcmlwdFJhbjogYm9vbGVhbiB9O1xyXG4gICAgICByZXR1cm4gW3AueHNzRmxhZyA9PT0gJ3VuZGVmaW5lZCcgJiYgcC5pbWdDb3VudCA9PT0gMCwgYHhzc0ZsYWc9JHtwLnhzc0ZsYWd9IGltZz0ke3AuaW1nQ291bnR9YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICBsZXQgZmFpbGVkID0gMDtcclxuICAgIGZvciAoY29uc3QgW25hbWUsIG9rLCBkZXRhaWxdIG9mIHJlc3VsdHMpIHtcclxuICAgICAgY29uc29sZS5sb2coYFNFQ1VSSVRZLVRFU1QgJHtvayA/ICdQQVNTJyA6ICdGQUlMJ30gfCAke25hbWV9IHwgJHtyZWRhY3QoZGV0YWlsKX1gKTtcclxuICAgICAgaWYgKCFvaykgZmFpbGVkICs9IDE7XHJcbiAgICB9XHJcbiAgICBjb25zb2xlLmxvZyhgU0VDVVJJVFktVEVTVCBTVU1NQVJZIHBhc3M9JHtyZXN1bHRzLmxlbmd0aCAtIGZhaWxlZH0vJHtyZXN1bHRzLmxlbmd0aH1gKTtcclxuICAgIGFwcC5leGl0KGZhaWxlZCA9PT0gMCA/IDAgOiAxKTtcclxuICB9XHJcblxyXG4gIC8vIFx1OTAwMFx1NTFGQTpcdTRGMThcdTk2QzVcdTUwNUNcdTZCNjJcdTgxRUFcdTVERjEgc3Bhd24gXHU3Njg0IGhvc3Qoc2h1dGRvd24gXHU3QUVGXHU3MEI5IFx1MjE5MiBcdTUxNUNcdTVFOTVcdTUzRUEga2lsbCBcdTgxRUFcdTVERjFcdTc2ODRcdTUzRTVcdTY3QzQpXHJcbiAgYXBwLm9uKCdiZWZvcmUtcXVpdCcsIChlKSA9PiB7XHJcbiAgICBpZiAoc3VwZXJ2aXNvciAhPT0gbnVsbCAmJiBzdXBlcnZpc29yLnN0YXRlICE9PSAnc3RvcHBlZCcpIHtcclxuICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xyXG4gICAgICBzc2VBYm9ydD8uYWJvcnQoKTtcclxuICAgICAgdm9pZCBzdXBlcnZpc29yLnN0b3AoKS5maW5hbGx5KCgpID0+IGFwcC5xdWl0KCkpO1xyXG4gICAgfVxyXG4gIH0pO1xyXG4gIGFwcC5vbignd2luZG93LWFsbC1jbG9zZWQnLCAoKSA9PiB7XHJcbiAgICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSAhPT0gJ2RhcndpbicpIGFwcC5xdWl0KCk7XHJcbiAgfSk7XHJcbn1cclxuIiwgIi8qKlxyXG4gKiBEZXNrdG9wUnVudGltZVN1cGVydmlzb3IgXHUyMDE0IGhtaGFybmVzcyBob3N0IFx1OEZEQlx1N0EwQlx1NzY4NFx1NzUxRlx1NTQ3RFx1NTQ2OFx1NjcxRlx1NzJCNlx1NjAwMVx1NjczQShBRFItMDAzKVx1MzAwMlxyXG4gKlxyXG4gKiBcdTVCODlcdTUxNjhcdTRFMERcdTUzRDhcdTkxQ0Y6XHJcbiAqICAtIFx1NTNFQVx1N0VEMVx1NUI5QS9cdTYzQTJcdTZENEIgMTI3LjAuMC4xO2hvc3QgXHU0RjdGXHU3NTI4XHU2NENEXHU0RjVDXHU3Q0ZCXHU3RURGXHU1MjA2XHU5MTREXHU3QUVGXHU1M0UzKHBvcnQgMCksXHU1QjlFXHU5NjQ1XHU3QUVGXHU1M0UzXHJcbiAqICAgIFx1NzUzMSBob3N0IFx1NzY4NCBzdGRvdXQgXHU1RjE1XHU1QkZDXHU4ODRDXHU1NkRFXHU0RjIwKEhvc3RSZWFkeUxpbmUpXHUzMDAyXHJcbiAqICAtIFx1OUFEOFx1NzFCNSB0b2tlbiBcdTUzRUFcdTkwMUFcdThGQzdcdTVCNTBcdThGREJcdTdBMEJcdTczQUZcdTU4ODNcdTUzRDhcdTkxQ0ZcdTRGMjBcdTkwMTIsXHU3RUREXHU0RTBEXHU4RkRCIFVSTC9cdTY1RTVcdTVGRDcvSVBDIFx1NjYwRVx1NjU4N1x1OEQxRlx1OEY3RFx1MzAwMlxyXG4gKiAgLSBcdTUzRUFcdTUwNUNcdTZCNjJcdTY3MkMgc3VwZXJ2aXNvciBzcGF3biBcdTc2ODRcdThGREJcdTdBMEJcdTUzRTVcdTY3QzQ7XHU3RUREXHU0RTBEXHU2MzA5XHU4RkRCXHU3QTBCXHU1NDBEIGtpbGxcdTMwMDJcclxuICogIC0gaG9zdCBjcmFzaCBcdTU0MEVcdTY3MDlcdTk2NTBcdTkxQ0RcdTU0MkY7XHU5MUNEXHU1NDJGXHU0RTBEXHU5MUNEXHU2NTNFXHU0RUZCXHU0RjU1XHU3NTI4XHU2MjM3XHU1MkE4XHU0RjVDKFx1OTc1RVx1NUU0Mlx1N0I0OVx1NTJBOFx1NEY1Q1x1NzUzMVx1NzUyOFx1NjIzN1x1Nzg2RVx1OEJBNClcdTMwMDJcclxuICovXHJcbmltcG9ydCB7IHNwYXduLCB0eXBlIENoaWxkUHJvY2VzcyB9IGZyb20gJ25vZGU6Y2hpbGRfcHJvY2Vzcyc7XHJcbmltcG9ydCB7IGNyZWF0ZUludGVyZmFjZSB9IGZyb20gJ25vZGU6cmVhZGxpbmUnO1xyXG5pbXBvcnQgeyByYW5kb21CeXRlcyB9IGZyb20gJ25vZGU6Y3J5cHRvJztcclxuaW1wb3J0IHsgZGVza3RvcEVycm9yLCBpc0Rlc2t0b3BFcnJvciwgdHlwZSBEZXNrdG9wRXJyb3IgfSBmcm9tICdAaG1oLWRlc2t0b3AvY29udHJhY3RzJztcclxuXHJcbmV4cG9ydCB0eXBlIEhvc3RTdGF0ZSA9XHJcbiAgfCAnc3RvcHBlZCdcclxuICB8ICdzdGFydGluZydcclxuICB8ICdyZWFkeSdcclxuICB8ICdkaXNjb25uZWN0ZWQnXHJcbiAgfCAncmVzdGFydGluZydcclxuICB8ICdzdG9wcGluZydcclxuICB8ICdmYWlsZWQnO1xyXG5cclxuZXhwb3J0IGludGVyZmFjZSBIb3N0U3BlYyB7XHJcbiAgLyoqIFx1NTNFRlx1NjI2N1x1ODg0Q1x1NjU4N1x1NEVGNihcdTkwMUFcdTVFMzggcHJvY2Vzcy5leGVjUGF0aClcdTMwMDIgKi9cclxuICBjb21tYW5kOiBzdHJpbmc7XHJcbiAgYXJnczogc3RyaW5nW107XHJcbiAgY3dkPzogc3RyaW5nO1xyXG4gIC8qKiBcdTk4OURcdTU5MTZcdTczQUZcdTU4ODNcdTUzRDhcdTkxQ0YoXHU0RjFBXHU0RTBFIHByb2Nlc3MuZW52IFx1NTQwOFx1NUU3NilcdTMwMDIgKi9cclxuICBlbnY/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xyXG59XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIFN1cGVydmlzb3JPcHRpb25zIHtcclxuICAvKiogXHU2NzFGXHU2NzFCIGhvc3QgXHU2ODIxXHU5QThDXHU3Njg0IGJlYXJlciB0b2tlbjtcdTRFMERcdTRGMjBcdTUyMTlcdTZCQ0ZcdTZCMjEgc3RhcnQgXHU3NTFGXHU2MjEwXHU5QUQ4XHU3MUI1XHU5NjhGXHU2NzNBXHU1MDNDXHUzMDAyICovXHJcbiAgdG9rZW4/OiBzdHJpbmc7XHJcbiAgbWF4UmVzdGFydHM/OiBudW1iZXI7XHJcbiAgc3RhcnRUaW1lb3V0TXM/OiBudW1iZXI7XHJcbiAgZ3JhY2VmdWxTaHV0ZG93bk1zPzogbnVtYmVyO1xyXG4gIG9uU3RhdGVDaGFuZ2U/KHN0YXRlOiBIb3N0U3RhdGUsIGluZm86IHsgcmVzdGFydENvdW50OiBudW1iZXI7IGxhc3RFcnJvcj86IHN0cmluZyB9KTogdm9pZDtcclxuICAvKiogXHU2QkNGXHU2QjIxIGhvc3QgXHU1QzMxXHU3RUVBKFx1NTQyQiBjcmFzaCBcdTgxRUFcdTYxMDhcdTU0MEVcdTc2ODRcdTkxQ0RcdTU0MkYpXHU5MEZEXHU0RjFBXHU4OUU2XHU1M0QxLFx1NjQzQVx1NUUyNlx1N0FFRlx1NzBCOShcdTU0MkIgdG9rZW4sXHJcbiAgICogIFx1NEVDNVx1NEY5Qlx1NTQwQ1x1NEZFMVx1NEVGQlx1NTdERlx1NzY4NFx1NUJCRlx1NEUzQlx1OEZEQlx1N0EwQlx1OTFDRFx1NUVGQVx1Njg2NVx1NUJBMlx1NjIzN1x1N0FFRjtcdTRFMERcdTg5ODFcdThERThcdThGREIgcmVuZGVyZXIpXHUzMDAyICovXHJcbiAgb25SZWFkeT8oZW5kcG9pbnQ6IEhvc3RFbmRwb2ludCk6IHZvaWQ7XHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgSG9zdEVuZHBvaW50IHtcclxuICBwb3J0OiBudW1iZXI7XHJcbiAgdmVyc2lvbjogc3RyaW5nO1xyXG4gIHRva2VuOiBzdHJpbmc7XHJcbn1cclxuXHJcbi8qKiBIb3N0UmVhZHlMaW5lIFx1NzY4NFx1N0M3Qlx1NTc4Qlx1NUI4OFx1NTM2Qlx1NEVDRSBjb250cmFjdHMgXHU1RjE1XHU1MTY1LFx1OTA3Rlx1NTE0RFx1NTNDQ1x1NUI5RVx1NzNCMFx1MzAwMiAqL1xyXG5pbXBvcnQgeyBpc0hvc3RSZWFkeUxpbmUgfSBmcm9tICdAaG1oLWRlc2t0b3AvY29udHJhY3RzJztcclxuXHJcbi8vIDQ1czpobWhhcm5lc3MgXHU3NzFGXHU1QjlFXHU1MTY1XHU1M0UzXHU3RUNGIHRzeCBcdTUxQjdcdTdGMTZcdThCRDFcdTY1NzRcdTU5NTcgQ0xJLFx1NjczQVx1NTY2OFx1OUFEOFx1OEQxRlx1OEY3RFx1NjVGNlx1NTNFRlx1OEQ4NSAyMHNcclxuLy8gKDIwMjYtMTAtMTEgXHU4RkRFXHU3RUVEXHU5QThDXHU2NTM2XHU0RTJEXHU5NUY0XHU2QjQ3XHU2MDI3IEhPU1RfTk9UX1JFQURZIFx1NzY4NFx1NjgzOVx1NTZFMDtcdTdBN0FcdTk1RjJcdTVCOUVcdTZENEIgNnMpXHUzMDAyXHJcbmNvbnN0IERFRkFVTFRfU1RBUlRfVElNRU9VVF9NUyA9IDQ1XzAwMDtcclxuY29uc3QgREVGQVVMVF9NQVhfUkVTVEFSVFMgPSAzO1xyXG5jb25zdCBERUZBVUxUX0dSQUNFRlVMX01TID0gNV8wMDA7XHJcblxyXG5leHBvcnQgY2xhc3MgRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yIHtcclxuICBwcml2YXRlIGNoaWxkOiBDaGlsZFByb2Nlc3MgfCBudWxsID0gbnVsbDtcclxuICBwcml2YXRlIF9zdGF0ZTogSG9zdFN0YXRlID0gJ3N0b3BwZWQnO1xyXG4gIHByaXZhdGUgcmVzdGFydENvdW50ID0gMDtcclxuICBwcml2YXRlIGxhc3RFcnJvciA9ICcnO1xyXG4gIHByaXZhdGUgc3RvcHBpbmcgPSBmYWxzZTtcclxuICBwcml2YXRlIHJlYWRvbmx5IHRva2VuOiBzdHJpbmc7XHJcbiAgcHJpdmF0ZSByZWFkb25seSBvcHRzOiBSZXF1aXJlZDxQaWNrPFN1cGVydmlzb3JPcHRpb25zLCAnbWF4UmVzdGFydHMnIHwgJ3N0YXJ0VGltZW91dE1zJyB8ICdncmFjZWZ1bFNodXRkb3duTXMnPj4gJiBTdXBlcnZpc29yT3B0aW9ucztcclxuICBwcml2YXRlIGV4aXRXYWl0ZXJzOiBBcnJheTwoKSA9PiB2b2lkPiA9IFtdO1xyXG5cclxuICBjb25zdHJ1Y3RvcihcclxuICAgIHByaXZhdGUgcmVhZG9ubHkgc3BlYzogSG9zdFNwZWMsXHJcbiAgICBvcHRzOiBTdXBlcnZpc29yT3B0aW9ucyA9IHt9LFxyXG4gICkge1xyXG4gICAgdGhpcy50b2tlbiA9IG9wdHMudG9rZW4gPz8gcmFuZG9tQnl0ZXMoMzIpLnRvU3RyaW5nKCdiYXNlNjR1cmwnKTtcclxuICAgIHRoaXMub3B0cyA9IHtcclxuICAgICAgbWF4UmVzdGFydHM6IG9wdHMubWF4UmVzdGFydHMgPz8gREVGQVVMVF9NQVhfUkVTVEFSVFMsXHJcbiAgICAgIHN0YXJ0VGltZW91dE1zOiBvcHRzLnN0YXJ0VGltZW91dE1zID8/IERFRkFVTFRfU1RBUlRfVElNRU9VVF9NUyxcclxuICAgICAgZ3JhY2VmdWxTaHV0ZG93bk1zOiBvcHRzLmdyYWNlZnVsU2h1dGRvd25NcyA/PyBERUZBVUxUX0dSQUNFRlVMX01TLFxyXG4gICAgICAuLi5vcHRzLFxyXG4gICAgfTtcclxuICB9XHJcblxyXG4gIGdldCBzdGF0ZSgpOiBIb3N0U3RhdGUge1xyXG4gICAgcmV0dXJuIHRoaXMuX3N0YXRlO1xyXG4gIH1cclxuXHJcbiAgZ2V0IHJlc3RhcnRzVXNlZCgpOiBudW1iZXIge1xyXG4gICAgcmV0dXJuIHRoaXMucmVzdGFydENvdW50O1xyXG4gIH1cclxuXHJcbiAgcHJpdmF0ZSBzZXRTdGF0ZShzOiBIb3N0U3RhdGUsIGVycj86IHN0cmluZyk6IHZvaWQge1xyXG4gICAgdGhpcy5fc3RhdGUgPSBzO1xyXG4gICAgaWYgKGVyciAhPT0gdW5kZWZpbmVkKSB0aGlzLmxhc3RFcnJvciA9IGVycjtcclxuICAgIGNvbnN0IGluZm86IHsgcmVzdGFydENvdW50OiBudW1iZXI7IGxhc3RFcnJvcj86IHN0cmluZyB9ID0geyByZXN0YXJ0Q291bnQ6IHRoaXMucmVzdGFydENvdW50IH07XHJcbiAgICBpZiAodGhpcy5sYXN0RXJyb3IgIT09ICcnKSBpbmZvLmxhc3RFcnJvciA9IHRoaXMubGFzdEVycm9yO1xyXG4gICAgdGhpcy5vcHRzLm9uU3RhdGVDaGFuZ2U/LihzLCBpbmZvKTtcclxuICB9XHJcblxyXG4gIC8qKiBcdTU0MkZcdTUyQTggaG9zdCBcdTVFNzZcdTdCNDlcdTVGODUgcmVhZHkoXHU1RjE1XHU1QkZDXHU4ODRDICsgXHU1RTI2IHRva2VuIFx1NzY4NFx1NTA2NVx1NUVCN1x1NjNBMlx1NkQ0QilcdTMwMDIgKi9cclxuICBhc3luYyBzdGFydCgpOiBQcm9taXNlPEhvc3RFbmRwb2ludD4ge1xyXG4gICAgaWYgKHRoaXMuX3N0YXRlID09PSAncmVhZHknIHx8IHRoaXMuX3N0YXRlID09PSAnc3RhcnRpbmcnKSB7XHJcbiAgICAgIHRocm93IGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgc3VwZXJ2aXNvciBhbHJlYWR5ICR7dGhpcy5fc3RhdGV9YCk7XHJcbiAgICB9XHJcbiAgICB0aGlzLnJlc3RhcnRDb3VudCA9IDA7XHJcbiAgICB0aGlzLnN0b3BwaW5nID0gZmFsc2U7XHJcbiAgICByZXR1cm4gdGhpcy5sYXVuY2goKTtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgYXN5bmMgbGF1bmNoKCk6IFByb21pc2U8SG9zdEVuZHBvaW50PiB7XHJcbiAgICB0aGlzLnNldFN0YXRlKCdzdGFydGluZycpO1xyXG4gICAgY29uc3QgY2hpbGQgPSBzcGF3bih0aGlzLnNwZWMuY29tbWFuZCwgdGhpcy5zcGVjLmFyZ3MsIHtcclxuICAgICAgY3dkOiB0aGlzLnNwZWMuY3dkLFxyXG4gICAgICBlbnY6IHtcclxuICAgICAgICAuLi5wcm9jZXNzLmVudixcclxuICAgICAgICAuLi50aGlzLnNwZWMuZW52LFxyXG4gICAgICAgIEhNSF9ERVNLVE9QX1RPS0VOOiB0aGlzLnRva2VuLFxyXG4gICAgICB9LFxyXG4gICAgICBzdGRpbzogWydpZ25vcmUnLCAncGlwZScsICdwaXBlJ10sXHJcbiAgICAgIHdpbmRvd3NIaWRlOiB0cnVlLFxyXG4gICAgfSk7XHJcbiAgICB0aGlzLmNoaWxkID0gY2hpbGQ7XHJcblxyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3QgZW5kcG9pbnQgPSBhd2FpdCB0aGlzLmF3YWl0UmVhZHkoY2hpbGQpO1xyXG4gICAgICB0aGlzLmN1cnJlbnRFbmRwb2ludCA9IHsgcG9ydDogZW5kcG9pbnQucG9ydCwgdmVyc2lvbjogZW5kcG9pbnQudmVyc2lvbiB9O1xyXG4gICAgICB0aGlzLnNldFN0YXRlKCdyZWFkeScpO1xyXG4gICAgICB0aGlzLm9wdHMub25SZWFkeT8uKGVuZHBvaW50KTtcclxuICAgICAgLy8gcmVhZHkgXHU0RTRCXHU1NDBFXHU4RkRCXHU3QTBCXHU2QjdCXHU0RUExID0gXHU2MTBGXHU1OTE2XHU5MDAwXHU1MUZBIFx1MjE5MiBcdTY3MDlcdTk2NTBcdTkxQ0RcdTU0MkZcclxuICAgICAgY2hpbGQub25jZSgnZXhpdCcsICgpID0+IHtcclxuICAgICAgICB0aGlzLmV4aXRXYWl0ZXJzLmZvckVhY2goKHcpID0+IHcoKSk7XHJcbiAgICAgICAgdGhpcy5leGl0V2FpdGVycyA9IFtdO1xyXG4gICAgICAgIHRoaXMub25VbmV4cGVjdGVkRXhpdCgpO1xyXG4gICAgICB9KTtcclxuICAgICAgcmV0dXJuIGVuZHBvaW50O1xyXG4gICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgIGlmICghY2hpbGQua2lsbGVkKSBjaGlsZC5raWxsKCk7XHJcbiAgICAgIGlmICh0aGlzLmNoaWxkID09PSBjaGlsZCkgdGhpcy5jaGlsZCA9IG51bGw7XHJcbiAgICAgIHRocm93IGVycjtcclxuICAgIH1cclxuICB9XHJcblxyXG4gIC8qKiBcdTRFQ0Ugc3Rkb3V0IFx1NjI3RSBIb3N0UmVhZHlMaW5lLFx1NzEzNlx1NTQwRVx1NTA2NVx1NUVCN1x1NjNBMlx1NkQ0Qlx1MzAwMiAqL1xyXG4gIHByaXZhdGUgYXdhaXRSZWFkeShjaGlsZDogQ2hpbGRQcm9jZXNzKTogUHJvbWlzZTxIb3N0RW5kcG9pbnQ+IHtcclxuICAgIHJldHVybiBuZXcgUHJvbWlzZTxIb3N0RW5kcG9pbnQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcclxuICAgICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHtcclxuICAgICAgICByZWplY3QoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBob3N0IGRpZCBub3Qgc2lnbmFsIHJlYWR5IHdpdGhpbiAke3RoaXMub3B0cy5zdGFydFRpbWVvdXRNc31tc2AsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xyXG4gICAgICB9LCB0aGlzLm9wdHMuc3RhcnRUaW1lb3V0TXMpO1xyXG5cclxuICAgICAgY29uc3QgZG9uZSA9IChmbjogKCkgPT4gdm9pZCk6IHZvaWQgPT4ge1xyXG4gICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XHJcbiAgICAgICAgZm4oKTtcclxuICAgICAgfTtcclxuXHJcbiAgICAgIGlmICghY2hpbGQuc3Rkb3V0KSB7XHJcbiAgICAgICAgZG9uZSgoKSA9PiByZWplY3QoZGVza3RvcEVycm9yKCdSVU5USU1FX0NSQVNIRUQnLCAnaG9zdCBzcGF3bmVkIHdpdGhvdXQgc3Rkb3V0IHBpcGUnKSkpO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgICAgfVxyXG5cclxuICAgICAgY29uc3QgcmwgPSBjcmVhdGVJbnRlcmZhY2UoeyBpbnB1dDogY2hpbGQuc3Rkb3V0IH0pO1xyXG4gICAgICBjb25zdCBvbkxpbmUgPSAobGluZTogc3RyaW5nKTogdm9pZCA9PiB7XHJcbiAgICAgICAgbGV0IHBhcnNlZDogdW5rbm93bjtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgcGFyc2VkID0gSlNPTi5wYXJzZShsaW5lKTtcclxuICAgICAgICB9IGNhdGNoIHtcclxuICAgICAgICAgIHJldHVybjsgLy8gaG9zdCBcdTc2ODRcdTY2NkVcdTkwMUFcdTY1RTVcdTVGRDdcdTg4NEMsXHU1RkZEXHU3NTY1XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChpc0hvc3RSZWFkeUxpbmUocGFyc2VkKSkge1xyXG4gICAgICAgICAgcmwuY2xvc2UoKTtcclxuICAgICAgICAgIHZvaWQgdGhpcy5wcm9iZUFuZFJlbWVtYmVyKHBhcnNlZC5wb3J0LCBwYXJzZWQudmVyc2lvbilcclxuICAgICAgICAgICAgLnRoZW4oKGVuZHBvaW50KSA9PiBkb25lKCgpID0+IHJlc29sdmUoZW5kcG9pbnQpKSlcclxuICAgICAgICAgICAgLmNhdGNoKChlcnI6IHVua25vd24pID0+IGRvbmUoKCkgPT4gcmVqZWN0KGVycikpKTtcclxuICAgICAgICB9XHJcbiAgICAgIH07XHJcbiAgICAgIHJsLm9uKCdsaW5lJywgb25MaW5lKTtcclxuXHJcbiAgICAgIGNoaWxkLm9uY2UoJ2V4aXQnLCAoY29kZSkgPT4ge1xyXG4gICAgICAgIGRvbmUoKCkgPT4gcmVqZWN0KGRlc2t0b3BFcnJvcignUlVOVElNRV9DUkFTSEVEJywgYGhvc3QgZXhpdGVkIGR1cmluZyBzdGFydHVwIChjb2RlICR7Y29kZSA/PyAnbnVsbCd9KWAsIHsgcmV0cnlhYmxlOiBmYWxzZSwgcmVjb3ZlcnlBY3Rpb246ICdPUEVOX0xPR1MnIH0pKSk7XHJcbiAgICAgIH0pO1xyXG4gICAgfSk7XHJcbiAgfVxyXG5cclxuICAvKiogXHU1RTI2IHRva2VuIFx1NzY4NFx1NTA2NVx1NUVCN1x1NjNBMlx1NkQ0QjpHRVQgL2FwaS9zdGF0ZVx1MzAwMjQwMSBcdTIxOTIgQVVUSF9GQUlMRUQoXHU0RTBEXHU5MUNEXHU4QkQ1KVx1MzAwMiAqL1xyXG4gIHByaXZhdGUgYXN5bmMgcHJvYmUocG9ydDogbnVtYmVyLCB2ZXJzaW9uOiBzdHJpbmcpOiBQcm9taXNlPEhvc3RFbmRwb2ludD4ge1xyXG4gICAgbGV0IHJlczogUmVzcG9uc2U7XHJcbiAgICB0cnkge1xyXG4gICAgICByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2FwaS9zdGF0ZWAsIHtcclxuICAgICAgICBoZWFkZXJzOiB7ICd4LWhtaC1rZXknOiB0aGlzLnRva2VuIH0sXHJcbiAgICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDNfMDAwKSxcclxuICAgICAgfSk7XHJcbiAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgdGhyb3cgZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBoZWFsdGggcHJvYmUgZmFpbGVkOiAke1N0cmluZyhlcnIpLnNsaWNlKDAsIDE2MCl9YCwgeyByZXRyeWFibGU6IHRydWUgfSk7XHJcbiAgICB9XHJcbiAgICBpZiAocmVzLnN0YXR1cyA9PT0gNDAxIHx8IHJlcy5zdGF0dXMgPT09IDQwMykge1xyXG4gICAgICB0aHJvdyBkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgYGhvc3QgcmVqZWN0ZWQgdGhlIHNlc3Npb24gdG9rZW4gKEhUVFAgJHtyZXMuc3RhdHVzfSlgLCB7IHJldHJ5YWJsZTogZmFsc2UsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KTtcclxuICAgIH1cclxuICAgIGlmICghcmVzLm9rKSB7XHJcbiAgICAgIHRocm93IGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgaGVhbHRoIHByb2JlIEhUVFAgJHtyZXMuc3RhdHVzfWAsIHsgcmV0cnlhYmxlOiB0cnVlIH0pO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHsgcG9ydCwgdmVyc2lvbiwgdG9rZW46IHRoaXMudG9rZW4gfTtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgb25VbmV4cGVjdGVkRXhpdCgpOiB2b2lkIHtcclxuICAgIGlmICh0aGlzLnN0b3BwaW5nIHx8IHRoaXMuX3N0YXRlID09PSAnc3RvcHBlZCcgfHwgdGhpcy5fc3RhdGUgPT09ICdzdG9wcGluZycpIHJldHVybjtcclxuICAgIHRoaXMuY2hpbGQgPSBudWxsO1xyXG4gICAgaWYgKHRoaXMucmVzdGFydENvdW50IDwgdGhpcy5vcHRzLm1heFJlc3RhcnRzKSB7XHJcbiAgICAgIHRoaXMucmVzdGFydENvdW50ICs9IDE7XHJcbiAgICAgIHRoaXMuc2V0U3RhdGUoJ3Jlc3RhcnRpbmcnKTtcclxuICAgICAgdm9pZCB0aGlzLmxhdW5jaCgpLmNhdGNoKCgpID0+IHtcclxuICAgICAgICAvLyBcdTkxQ0RcdTU0MkZcdTVDMURcdThCRDVcdTU5MzFcdThEMjUoXHU1NDJGXHU1MkE4XHU1MzczXHU1RDI5L1x1OEQ4NVx1NjVGNi9cdTYyRDJcdThCQTQpOlx1N0VFN1x1N0VFRFx1NkQ4OFx1ODAxN1x1OTFDRFx1NTQyRlx1NkIyMVx1NjU3MFx1NzZGNFx1NTIzMFx1NjUzRVx1NUYwM1xyXG4gICAgICAgIHRoaXMucmV0cnlPckZhaWwoKTtcclxuICAgICAgfSk7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICB0aGlzLnNldFN0YXRlKCdmYWlsZWQnLCBgaG9zdCBleGl0ZWQgdW5leHBlY3RlZGx5ICR7dGhpcy5yZXN0YXJ0Q291bnQgKyAxfSB0aW1lczsgZ2l2aW5nIHVwYCk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICBwcml2YXRlIHJldHJ5T3JGYWlsKCk6IHZvaWQge1xyXG4gICAgaWYgKHRoaXMuc3RvcHBpbmcgfHwgdGhpcy5fc3RhdGUgPT09ICdzdG9wcGVkJyB8fCB0aGlzLl9zdGF0ZSA9PT0gJ3N0b3BwaW5nJykgcmV0dXJuO1xyXG4gICAgaWYgKHRoaXMucmVzdGFydENvdW50IDwgdGhpcy5vcHRzLm1heFJlc3RhcnRzKSB7XHJcbiAgICAgIHRoaXMucmVzdGFydENvdW50ICs9IDE7XHJcbiAgICAgIHRoaXMuc2V0U3RhdGUoJ3Jlc3RhcnRpbmcnKTtcclxuICAgICAgdm9pZCB0aGlzLmxhdW5jaCgpLmNhdGNoKCgpID0+IHRoaXMucmV0cnlPckZhaWwoKSk7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICB0aGlzLnNldFN0YXRlKCdmYWlsZWQnLCBgaG9zdCBmYWlsZWQgdG8gc3RheSB1cCBhZnRlciAke3RoaXMucmVzdGFydENvdW50fSByZXN0YXJ0IGF0dGVtcHRzYCk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvKiogXHU0RjE4XHU5NkM1XHU1MDVDXHU2QjYyOlx1NTE0OCBIVFRQIHNodXRkb3duLFx1OEQ4NVx1NjVGNlx1NjI0RFx1NUJGOVx1NjcyQ1x1OEZEQlx1N0EwQlx1NTNFNVx1NjdDNCBraWxsXHUzMDAyICovXHJcbiAgYXN5bmMgc3RvcCgpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIHRoaXMuc3RvcHBpbmcgPSB0cnVlO1xyXG4gICAgaWYgKHRoaXMuX3N0YXRlID09PSAnc3RvcHBlZCcpIHJldHVybjtcclxuICAgIHRoaXMuc2V0U3RhdGUoJ3N0b3BwaW5nJyk7XHJcbiAgICBjb25zdCBjaGlsZCA9IHRoaXMuY2hpbGQ7XHJcbiAgICB0aGlzLmNoaWxkID0gbnVsbDtcclxuICAgIHRoaXMuY3VycmVudEVuZHBvaW50ID0gbnVsbDtcclxuICAgIGlmICghY2hpbGQpIHtcclxuICAgICAgdGhpcy5zZXRTdGF0ZSgnc3RvcHBlZCcpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCBleGl0ZWQgPSBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4ge1xyXG4gICAgICBpZiAoY2hpbGQuZXhpdENvZGUgIT09IG51bGwgfHwgY2hpbGQuc2lnbmFsQ29kZSAhPT0gbnVsbCkgcmVzb2x2ZSgpO1xyXG4gICAgICBlbHNlIHtcclxuICAgICAgICBjb25zdCB3ID0gKCk6IHZvaWQgPT4gcmVzb2x2ZSgpO1xyXG4gICAgICAgIHRoaXMuZXhpdFdhaXRlcnMucHVzaCh3KTtcclxuICAgICAgICBjaGlsZC5vbmNlKCdleGl0Jywgdyk7XHJcbiAgICAgIH1cclxuICAgIH0pO1xyXG4gICAgLy8gXHU1REYyXHU3N0U1XHU3QUVGXHU1M0UzXHU2MjREXHU1QzFEXHU4QkQ1IEhUVFAgXHU0RjE4XHU5NkM1XHU1MTczXHU5NUVEO1x1NjcyQVx1NzdFNVx1N0FFRlx1NTNFM1x1NzZGNFx1NjNBNVx1OEQ3MCBraWxsIFx1NTE1Q1x1NUU5NVxyXG4gICAgaWYgKHRoaXMubGFzdEVuZHBvaW50ICE9PSBudWxsKSB7XHJcbiAgICAgIHRyeSB7XHJcbiAgICAgICAgYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHt0aGlzLmxhc3RFbmRwb2ludH0vYXBpL2Rlc2t0b3Avc2h1dGRvd25gLCB7XHJcbiAgICAgICAgICBtZXRob2Q6ICdQT1NUJyxcclxuICAgICAgICAgIGhlYWRlcnM6IHsgJ3gtaG1oLWtleSc6IHRoaXMudG9rZW4gfSxcclxuICAgICAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCgxXzAwMCksXHJcbiAgICAgICAgfSk7XHJcbiAgICAgIH0gY2F0Y2gge1xyXG4gICAgICAgIC8vIGhvc3QgXHU1REYyXHU2QjdCXHU2MjE2XHU0RTBEXHU1RTk0XHU3QjU0Olx1OEQ3MCBraWxsIFx1NTE1Q1x1NUU5NVxyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgICBjb25zdCBncmFjZWZ1bCA9IGF3YWl0IFByb21pc2UucmFjZShbXHJcbiAgICAgIGV4aXRlZC50aGVuKCgpID0+IHRydWUpLFxyXG4gICAgICBuZXcgUHJvbWlzZTxib29sZWFuPigocmVzb2x2ZSkgPT4gc2V0VGltZW91dCgoKSA9PiByZXNvbHZlKGZhbHNlKSwgdGhpcy5vcHRzLmdyYWNlZnVsU2h1dGRvd25NcykpLFxyXG4gICAgXSk7XHJcbiAgICBpZiAoIWdyYWNlZnVsICYmIGNoaWxkLmV4aXRDb2RlID09PSBudWxsICYmIGNoaWxkLnNpZ25hbENvZGUgPT09IG51bGwpIHtcclxuICAgICAgY2hpbGQua2lsbCgpOyAvLyBcdTUzRUFcdTY3NDBcdTgxRUFcdTVERjFcdTYzMDFcdTY3MDlcdTc2ODRcdTUzRTVcdTY3QzQsXHU3RUREXHU0RTBEXHU2MzA5XHU4RkRCXHU3QTBCXHU1NDBEXHJcbiAgICB9XHJcbiAgICBhd2FpdCBleGl0ZWQuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcclxuICAgIHRoaXMuc2V0U3RhdGUoJ3N0b3BwZWQnKTtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgbGFzdEVuZHBvaW50OiBudW1iZXIgfCBudWxsID0gbnVsbDtcclxuICBwcml2YXRlIGN1cnJlbnRFbmRwb2ludDogeyBwb3J0OiBudW1iZXI7IHZlcnNpb246IHN0cmluZyB9IHwgbnVsbCA9IG51bGw7XHJcblxyXG4gIC8qKiBcdTVGNTNcdTUyNEQgaG9zdCBcdTdBRUZcdTcwQjkocmVhZHkgXHU1NDBFXHU2NzA5XHU1MDNDO1x1NEUwRFx1NTQyQiB0b2tlbilcdTMwMDIgKi9cclxuICBnZXQgZW5kcG9pbnQoKTogeyBwb3J0OiBudW1iZXI7IHZlcnNpb246IHN0cmluZyB9IHwgbnVsbCB7XHJcbiAgICByZXR1cm4gdGhpcy5jdXJyZW50RW5kcG9pbnQ7XHJcbiAgfVxyXG5cclxuICAvKiogXHU2M0EyXHU2RDRCXHU2MjEwXHU1MjlGXHU1NDBFXHU4QkIwXHU0RjRGXHU3QUVGXHU1M0UzLFx1NEY5QiBzdG9wKCkgXHU3Njg0XHU0RjE4XHU5NkM1XHU1MTczXHU5NUVEXHU0RjdGXHU3NTI4XHUzMDAyICovXHJcbiAgcHJpdmF0ZSBhc3luYyBwcm9iZUFuZFJlbWVtYmVyKHBvcnQ6IG51bWJlciwgdmVyc2lvbjogc3RyaW5nKTogUHJvbWlzZTxIb3N0RW5kcG9pbnQ+IHtcclxuICAgIGNvbnN0IGVwID0gYXdhaXQgdGhpcy5wcm9iZShwb3J0LCB2ZXJzaW9uKTtcclxuICAgIHRoaXMubGFzdEVuZHBvaW50ID0gZXAucG9ydDtcclxuICAgIHJldHVybiBlcDtcclxuICB9XHJcbn1cclxuXHJcbi8qKiBcdTYyOEFcdTY3MkFcdTc3RTVcdTk1MTlcdThCRUZcdTg5QzRcdTdFQTZcdTRFM0EgRGVza3RvcEVycm9yKFx1NURGMlx1NjYyRlx1NTIxOVx1NTM5Rlx1NjgzN1x1OEZENFx1NTZERSlcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHRvRGVza3RvcEVycm9yKGVycjogdW5rbm93bik6IERlc2t0b3BFcnJvciB7XHJcbiAgaWYgKGlzRGVza3RvcEVycm9yKGVycikpIHJldHVybiBlcnI7XHJcbiAgY29uc3QgbWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcclxuICByZXR1cm4gZGVza3RvcEVycm9yKCdSVU5USU1FX0NSQVNIRUQnLCBtZXNzYWdlLnNsaWNlKDAsIDMwMCksIHsgcmV0cnlhYmxlOiBmYWxzZSB9KTtcclxufVxyXG4iLCAiLyoqXHJcbiAqIEBobWgtZGVza3RvcC9jb250cmFjdHMgXHUyMDE0IFx1NEU4Qlx1NEVGNlx1NEZFMVx1NUMwMShcdTVGMDBcdTUzRDFcdThCQTFcdTUyMTJcdTY1ODdcdTY4NjMgMDQgXHUwMEE3XHU0RTA5KVxyXG4gKlxyXG4gKiBcdTRFMDBcdTY3NjEgVUkgXHU0RThCXHU0RUY2XHU3Njg0XHU1NTJGXHU0RTAwXHU1RjYyXHU3MkI2XHUzMDAyXHU1MjREXHU3QUVGIHJlZHVjZXIgXHU1RkM1XHU5ODdCXHU2MzA5IHNlc3Npb25JZC9ydW5JZC9zZXEgXHU1OTA0XHU3NDA2O1xyXG4gKiBcdTkxQ0RcdTU5MEQgZXZlbnRJZCBcdTVFNDJcdTdCNDlcdTRFMjJcdTVGMDM7c2VxIFx1N0YzQVx1NTNFM1x1ODlFNlx1NTNEMVx1ODg2NVx1NjJDOTtcdTk3NUVcdTVFNDJcdTdCNDlcdTUyQThcdTRGNUNcdTRFMERcdTc1MzEgU1NFIFx1ODFFQVx1NTJBOFx1OTFDRFx1NTNEMVx1MzAwMlxyXG4gKi9cclxuXHJcbmltcG9ydCB0eXBlIHsgQXJ0aWZhY3RSZWYgfSBmcm9tICcuL2R0by50cyc7XHJcbmltcG9ydCB0eXBlIHsgRGVza3RvcEVycm9yIH0gZnJvbSAnLi9lcnJvci50cyc7XHJcblxyXG4vKiogXHU0RThCXHU0RUY2XHU3OUNEXHU3QzdCKFx1NTIyNFx1NTIyQlx1OTUyRSlcdTMwMDJcdTY1QjBcdTU4OUUga2luZCA9IHNjaGVtYVZlcnNpb24gXHU1MzQ3XHU3RUE3LFx1NEUwRFx1NTE0MVx1OEJCOFx1OTc1OVx1OUVEOFx1NjI2OVx1Njc5QVx1NEUzRVx1MzAwMiAqL1xyXG5leHBvcnQgY29uc3QgRVZFTlRfS0lORFMgPSBbXHJcbiAgJ3J1bi5zdGFydGVkJyxcclxuICAncGxhbi51cGRhdGVkJyxcclxuICAndG9vbC5zdGFydGVkJyxcclxuICAndG9vbC5jb21wbGV0ZWQnLFxyXG4gICdhcHByb3ZhbC5yZXF1aXJlZCcsXHJcbiAgJ3ZlcmlmaWNhdGlvbi51cGRhdGVkJyxcclxuICAnYXJ0aWZhY3QuY3JlYXRlZCcsXHJcbiAgJ3J1bi5jb21wbGV0ZWQnLFxyXG4gICdydW4uZmFpbGVkJyxcclxuXSBhcyBjb25zdDtcclxuXHJcbmV4cG9ydCB0eXBlIEV2ZW50S2luZCA9ICh0eXBlb2YgRVZFTlRfS0lORFMpW251bWJlcl07XHJcblxyXG5leHBvcnQgY29uc3QgRVZFTlRfU0NIRU1BX1ZFUlNJT04gPSAxO1xyXG5leHBvcnQgdHlwZSBFdmVudFNjaGVtYVZlcnNpb24gPSAxO1xyXG5cclxuLyoqIFNTRSBcdTZENDFcdTRFMEFcdTc2ODRcdTZCQ0ZcdTRFMDBcdTY3NjFcdTRFOEJcdTRFRjZcdTMwMDIgKi9cclxuZXhwb3J0IGludGVyZmFjZSBFdmVudEVudmVsb3BlPFQgPSB1bmtub3duPiB7XHJcbiAgc2NoZW1hVmVyc2lvbjogRXZlbnRTY2hlbWFWZXJzaW9uO1xyXG4gIC8qKiBcdTUxNjhcdTVDNDBcdTU1MkZcdTRFMDA7XHU5MUNEXHU4RkRFL1x1ODg2NVx1NjJDOVx1NTQwRVx1OTFDRFx1NTkwRFx1NTFGQVx1NzNCMFx1NjVGNlx1NjNBNVx1NjUzNlx1NjVCOVx1NUU0Mlx1N0I0OVx1NEUyMlx1NUYwM1x1MzAwMiAqL1xyXG4gIGV2ZW50SWQ6IHN0cmluZztcclxuICBzZXNzaW9uSWQ6IHN0cmluZztcclxuICBydW5JZDogc3RyaW5nO1xyXG4gIC8qKiBcdTRGMUFcdThCRERcdTUxODVcdTUzNTVcdThDMDNcdTkwMTJcdTU4OUU7XHU3RjNBXHU1M0UzXHU2MTBGXHU1NDczXHU3NzQwXHU0RTIyXHU0RThCXHU0RUY2LFx1OTcwMFx1ODk4MVx1ODg2NVx1NjJDOVx1MzAwMiAqL1xyXG4gIHNlcTogbnVtYmVyO1xyXG4gIC8qKiBSRkMzMzM5XHUzMDAyICovXHJcbiAgb2NjdXJyZWRBdDogc3RyaW5nO1xyXG4gIGtpbmQ6IEV2ZW50S2luZDtcclxuICBwYXlsb2FkOiBUO1xyXG59XHJcblxyXG4vKiogcnVuLnN0YXJ0ZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cclxuZXhwb3J0IGludGVyZmFjZSBSdW5TdGFydGVkUGF5bG9hZCB7XHJcbiAgdGFzazogc3RyaW5nO1xyXG4gIG1vZGU6ICdhc2snIHwgJ2F1dG8nIHwgJ3lvbG8nO1xyXG59XHJcblxyXG4vKiogcGxhbi51cGRhdGVkIFx1NzY4NCBwYXlsb2FkKFx1OEJBMVx1NTIxMlx1NkI2NVx1OUFBNFx1NTIxN1x1ODg2OCxcdTY3NjVcdTgxRUEgcnVudGltZSBcdTc2ODRcdTdFRDNcdTY3ODRcdTUzMTZcdThCQTFcdTUyMTIsXHU0RTBEXHU2NjJGIGNoYWluLW9mLXRob3VnaHQpXHUzMDAyICovXHJcbmV4cG9ydCBpbnRlcmZhY2UgUGxhblVwZGF0ZWRQYXlsb2FkIHtcclxuICBzdGVwczogQXJyYXk8eyB0aXRsZTogc3RyaW5nOyBzdGF0dXM6ICdwZW5kaW5nJyB8ICdhY3RpdmUnIHwgJ2RvbmUnIHwgJ2ZhaWxlZCcgfT47XHJcbn1cclxuXHJcbi8qKiB0b29sLnN0YXJ0ZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cclxuZXhwb3J0IGludGVyZmFjZSBUb29sU3RhcnRlZFBheWxvYWQge1xyXG4gIG5hbWU6IHN0cmluZztcclxuICAvKiogXHU1M0MyXHU2NTcwXHU0RUU1XHU2NTg3XHU2NzJDXHU1NDQ4XHU3M0IwLFx1NkUzMlx1NjdEM1x1N0FFRlx1NkMzOFx1NEUwRCBldmFsO1x1NTkyN1x1NUJGOVx1OEM2MVx1NzUzMSBydW50aW1lIFx1NjIyQVx1NjVBRFx1MzAwMiAqL1xyXG4gIGFyZ3NQcmV2aWV3OiBzdHJpbmc7XHJcbn1cclxuXHJcbi8qKiB0b29sLmNvbXBsZXRlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xyXG5leHBvcnQgaW50ZXJmYWNlIFRvb2xDb21wbGV0ZWRQYXlsb2FkIHtcclxuICBuYW1lOiBzdHJpbmc7XHJcbiAgaXNFcnJvcjogYm9vbGVhbjtcclxuICBvdXRwdXRQcmV2aWV3OiBzdHJpbmc7XHJcbn1cclxuXHJcbi8qKiBhcHByb3ZhbC5yZXF1aXJlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMlx1NUJBMVx1NjI3OVx1Njc0M1x1NUEwMVx1NTcyOCBydW50aW1lIFx1NTQwRVx1N0FFRjtVSSBcdTUzRUFcdTY2MkZcdThGNkNcdThGRjBcdTMwMDIgKi9cclxuZXhwb3J0IGludGVyZmFjZSBBcHByb3ZhbFJlcXVpcmVkUGF5bG9hZCB7XHJcbiAgYXBwcm92YWxJZDogc3RyaW5nO1xyXG4gIHRvb2w6IHN0cmluZztcclxuICBhcmdzUHJldmlldzogc3RyaW5nO1xyXG4gIC8qKiBcdTVGNzFcdTU0Q0RcdTgzMDNcdTU2RjQvXHU5OENFXHU5NjY5XHU3Njg0XHU0RUJBXHU3QzdCXHU1M0VGXHU4QkZCXHU4QkY0XHU2NjBFLFx1NzUzMSBydW50aW1lIFx1NzUxRlx1NjIxMFx1MzAwMiAqL1xyXG4gIHJpc2s6IHN0cmluZztcclxufVxyXG5cclxuLyoqIHZlcmlmaWNhdGlvbi51cGRhdGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXHJcbmV4cG9ydCBpbnRlcmZhY2UgVmVyaWZpY2F0aW9uVXBkYXRlZFBheWxvYWQge1xyXG4gIHN1bW1hcnk6IHN0cmluZztcclxuICBwYXNzZWQ6IGJvb2xlYW4gfCBudWxsOyAvLyBudWxsID0gXHU2NzJBXHU3N0U1L1x1OEZEQlx1ODg0Q1x1NEUyRChORUVEUy1EQVRBIFx1NjVGNlx1NEUwRFx1NTA0N1x1NTg2QilcclxufVxyXG5cclxuLyoqIGFydGlmYWN0LmNyZWF0ZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cclxuZXhwb3J0IGludGVyZmFjZSBBcnRpZmFjdENyZWF0ZWRQYXlsb2FkIHtcclxuICBhcnRpZmFjdDogQXJ0aWZhY3RSZWY7XHJcbn1cclxuXHJcbi8qKiBydW4uY29tcGxldGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXHJcbmV4cG9ydCBpbnRlcmZhY2UgUnVuQ29tcGxldGVkUGF5bG9hZCB7XHJcbiAgdGV4dDogc3RyaW5nO1xyXG4gIHR1cm5zOiBudW1iZXI7XHJcbiAgdG9vbFVzZXM6IG51bWJlcjtcclxuICB1c2FnZT86IHsgcHJvbXB0VG9rZW5zOiBudW1iZXI7IGNvbXBsZXRpb25Ub2tlbnM6IG51bWJlciB9O1xyXG59XHJcblxyXG4vKiogcnVuLmZhaWxlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xyXG5leHBvcnQgaW50ZXJmYWNlIFJ1bkZhaWxlZFBheWxvYWQge1xyXG4gIGVycm9yOiBEZXNrdG9wRXJyb3I7XHJcbn1cclxuIiwgIi8qKlxyXG4gKiBAaG1oLWRlc2t0b3AvY29udHJhY3RzIFx1MjAxNCBcdTdFRDNcdTY3ODRcdTUzMTZcdTY4NENcdTk3NjJcdTk1MTlcdThCRUYoXHU1RjAwXHU1M0QxXHU4QkExXHU1MjEyXHU2NTg3XHU2ODYzIDA0IFx1MDBBN1x1NEUwOSlcdTMwMDJcclxuICpcclxuICogaG9zdC1ub3QtcmVhZHkgLyBhdXRoLWZhaWxlZCAvIHN0YWxlLXZlcnNpb24gLyBydW50aW1lLWNyYXNoZWQgL1xyXG4gKiBwb3J0LWJpbmQtZmFpbGVkIC8gc2NoZW1hLW1pc21hdGNoIFx1NUZDNVx1OTg3Qlx1NjYyRlx1N0VEM1x1Njc4NFx1NTMxNlx1OTUxOVx1OEJFRlx1NzgwMSxcdTVFNzZcdTYzRDBcdTRGOUJcdTRFMEJcdTRFMDBcdTZCNjVcdTUyQThcdTRGNUNcdTMwMDJcclxuICogbWVzc2FnZSBcdTY2MkZcdTdFQUZcdTY1ODdcdTY3MkMsXHU2RTMyXHU2N0QzXHU3QUVGXHU2QzM4XHU0RTBEXHU2MjhBXHU1QjgzXHU1RjUzIEhUTUxcdTMwMDJcclxuICovXHJcbmV4cG9ydCBjb25zdCBFUlJPUl9DT0RFUyA9IFtcclxuICAnSE9TVF9OT1RfUkVBRFknLFxyXG4gICdBVVRIX0ZBSUxFRCcsXHJcbiAgJ1JVTlRJTUVfQ1JBU0hFRCcsXHJcbiAgJ1BPUlRfQklORF9GQUlMRUQnLFxyXG4gICdTVEFMRV9WRVJTSU9OJyxcclxuICAnU0NIRU1BX01JU01BVENIJyxcclxuXSBhcyBjb25zdDtcclxuXHJcbmV4cG9ydCB0eXBlIEVycm9yQ29kZSA9ICh0eXBlb2YgRVJST1JfQ09ERVMpW251bWJlcl07XHJcblxyXG5leHBvcnQgY29uc3QgUkVDT1ZFUllfQUNUSU9OUyA9IFsnUkVDT05ORUNUJywgJ1JFU1VNRScsICdFWFBPUlQnLCAnT1BFTl9MT0dTJ10gYXMgY29uc3Q7XHJcbmV4cG9ydCB0eXBlIFJlY292ZXJ5QWN0aW9uID0gKHR5cGVvZiBSRUNPVkVSWV9BQ1RJT05TKVtudW1iZXJdO1xyXG5cclxuZXhwb3J0IGludGVyZmFjZSBEZXNrdG9wRXJyb3Ige1xyXG4gIGNvZGU6IEVycm9yQ29kZTtcclxuICAvKiogXHU3RUFGXHU2NTg3XHU2NzJDLFx1NkMzOFx1NEUwRFx1NEZFMVx1NEVGQlx1NEUzQSBIVE1MXHUzMDAyICovXHJcbiAgbWVzc2FnZTogc3RyaW5nO1xyXG4gIHJldHJ5YWJsZTogYm9vbGVhbjtcclxuICBzZXNzaW9uSWQ/OiBzdHJpbmc7XHJcbiAgcnVuSWQ/OiBzdHJpbmc7XHJcbiAgcmVjb3ZlcnlBY3Rpb24/OiBSZWNvdmVyeUFjdGlvbjtcclxufVxyXG5cclxuLyoqIFx1Njc4NFx1OTAyMFx1NEUwMFx1NEUyQSBEZXNrdG9wRXJyb3IoZXhhY3RPcHRpb25hbFByb3BlcnR5VHlwZXMgXHU1M0NCXHU1OTdEKVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gZGVza3RvcEVycm9yKFxyXG4gIGNvZGU6IEVycm9yQ29kZSxcclxuICBtZXNzYWdlOiBzdHJpbmcsXHJcbiAgb3B0czogeyByZXRyeWFibGU/OiBib29sZWFuOyBzZXNzaW9uSWQ/OiBzdHJpbmc7IHJ1bklkPzogc3RyaW5nOyByZWNvdmVyeUFjdGlvbj86IFJlY292ZXJ5QWN0aW9uIH0gPSB7fSxcclxuKTogRGVza3RvcEVycm9yIHtcclxuICBjb25zdCBlOiBEZXNrdG9wRXJyb3IgPSB7IGNvZGUsIG1lc3NhZ2UsIHJldHJ5YWJsZTogb3B0cy5yZXRyeWFibGUgPT09IHRydWUgfTtcclxuICBpZiAob3B0cy5zZXNzaW9uSWQgIT09IHVuZGVmaW5lZCkgZS5zZXNzaW9uSWQgPSBvcHRzLnNlc3Npb25JZDtcclxuICBpZiAob3B0cy5ydW5JZCAhPT0gdW5kZWZpbmVkKSBlLnJ1bklkID0gb3B0cy5ydW5JZDtcclxuICBpZiAob3B0cy5yZWNvdmVyeUFjdGlvbiAhPT0gdW5kZWZpbmVkKSBlLnJlY292ZXJ5QWN0aW9uID0gb3B0cy5yZWNvdmVyeUFjdGlvbjtcclxuICByZXR1cm4gZTtcclxufVxyXG4iLCAiLyoqXHJcbiAqIEBobWgtZGVza3RvcC9jb250cmFjdHMgXHUyMDE0IHJ1bnRpbWUgXHU2ODIxXHU5QThDKGd1YXJkcylcdTMwMDJcclxuICpcclxuICogXHU2QkNGXHU0RTJBXHU4REU4XHU0RkUxXHU0RUZCXHU4RkI5XHU3NTRDXHU3Njg0XHU2NTcwXHU2MzZFKHJ1bnRpbWVcdTIxOTJyZW5kZXJlclx1MzAwMWhvc3RcdTIxOTJtYWluKVx1OEZEQlx1NTE2NVx1NTI0RFx1NTE0OFx1OEZDNyBndWFyZDtcclxuICogXHU2ODIxXHU5QThDXHU1OTMxXHU4RDI1XHU3Njg0XHU2NTcwXHU2MzZFXHU2MzA5IFNDSEVNQV9NSVNNQVRDSCBcdTdFRDNcdTY3ODRcdTUzMTZcdTk1MTlcdThCRUZcdTU5MDRcdTc0MDYsXHU0RTBEXHU5NzU5XHU5RUQ4XHU2M0E1XHU1M0Q3XHUzMDAyXHJcbiAqIFx1NjI0Qlx1NTE5OVx1NUI4OFx1NTM2Qlx1ODAwQ1x1NEUwRFx1NjYyRlx1NUYxNVx1N0IyQ1x1NEUwOVx1NjVCOSBzY2hlbWEgXHU1RTkzOlx1NTk1MVx1N0VBNlx1OTc2Mlx1NUMwRixcdTk2RjZcdTRGOURcdThENTZcdTY1ODdcdTUzMTYoaG1oYXJuZXNzIFx1NTQwQ1x1NkU5MClcdTMwMDJcclxuICovXHJcbmltcG9ydCB7XHJcbiAgRVZFTlRfS0lORFMsXHJcbiAgRVZFTlRfU0NIRU1BX1ZFUlNJT04sXHJcbiAgdHlwZSBFdmVudEVudmVsb3BlLFxyXG4gIHR5cGUgRXZlbnRLaW5kLFxyXG59IGZyb20gJy4vZXZlbnQudHMnO1xyXG5pbXBvcnQgeyBFUlJPUl9DT0RFUywgUkVDT1ZFUllfQUNUSU9OUywgdHlwZSBEZXNrdG9wRXJyb3IgfSBmcm9tICcuL2Vycm9yLnRzJztcclxuaW1wb3J0IHsgUlVOX1NUQVRVU0VTLCB0eXBlIFJ1blN0YXR1cyB9IGZyb20gJy4vZHRvLnRzJztcclxuXHJcbmNvbnN0IGlzUmVjb3JkID0gKHY6IHVua25vd24pOiB2IGlzIFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0+XHJcbiAgdHlwZW9mIHYgPT09ICdvYmplY3QnICYmIHYgIT09IG51bGwgJiYgIUFycmF5LmlzQXJyYXkodik7XHJcblxyXG5jb25zdCBpc05vbkVtcHR5U3RyaW5nID0gKHY6IHVua25vd24pOiB2IGlzIHN0cmluZyA9PiB0eXBlb2YgdiA9PT0gJ3N0cmluZycgJiYgdi5sZW5ndGggPiAwO1xyXG5cclxuY29uc3QgaXNSZmMzMzM5ID0gKHY6IHN0cmluZyk6IGJvb2xlYW4gPT4ge1xyXG4gIGNvbnN0IHQgPSBEYXRlLnBhcnNlKHYpO1xyXG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUodCkgJiYgL1xcZHs0fS1cXGR7Mn0tXFxkezJ9VC8udGVzdCh2KTtcclxufTtcclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpc0V2ZW50RW52ZWxvcGUodjogdW5rbm93bik6IHYgaXMgRXZlbnRFbnZlbG9wZSB7XHJcbiAgaWYgKCFpc1JlY29yZCh2KSkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICh2LnNjaGVtYVZlcnNpb24gIT09IEVWRU5UX1NDSEVNQV9WRVJTSU9OKSByZXR1cm4gZmFsc2U7XHJcbiAgaWYgKCFpc05vbkVtcHR5U3RyaW5nKHYuZXZlbnRJZCkpIHJldHVybiBmYWxzZTtcclxuICBpZiAoIWlzTm9uRW1wdHlTdHJpbmcodi5zZXNzaW9uSWQpKSByZXR1cm4gZmFsc2U7XHJcbiAgaWYgKCFpc05vbkVtcHR5U3RyaW5nKHYucnVuSWQpKSByZXR1cm4gZmFsc2U7XHJcbiAgaWYgKHR5cGVvZiB2LnNlcSAhPT0gJ251bWJlcicgfHwgIU51bWJlci5pc0ludGVnZXIodi5zZXEpIHx8IHYuc2VxIDwgMCkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICghaXNOb25FbXB0eVN0cmluZyh2Lm9jY3VycmVkQXQpIHx8ICFpc1JmYzMzMzkodi5vY2N1cnJlZEF0KSkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICghRVZFTlRfS0lORFMuaW5jbHVkZXModi5raW5kIGFzIEV2ZW50S2luZCkpIHJldHVybiBmYWxzZTtcclxuICByZXR1cm4gaXNSZWNvcmQodi5wYXlsb2FkKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGlzRGVza3RvcEVycm9yKHY6IHVua25vd24pOiB2IGlzIERlc2t0b3BFcnJvciB7XHJcbiAgaWYgKCFpc1JlY29yZCh2KSkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICghRVJST1JfQ09ERVMuaW5jbHVkZXModi5jb2RlIGFzIG5ldmVyKSkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICh0eXBlb2Ygdi5tZXNzYWdlICE9PSAnc3RyaW5nJykgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICh0eXBlb2Ygdi5yZXRyeWFibGUgIT09ICdib29sZWFuJykgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICh2LnNlc3Npb25JZCAhPT0gdW5kZWZpbmVkICYmICFpc05vbkVtcHR5U3RyaW5nKHYuc2Vzc2lvbklkKSkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICh2LnJ1bklkICE9PSB1bmRlZmluZWQgJiYgIWlzTm9uRW1wdHlTdHJpbmcodi5ydW5JZCkpIHJldHVybiBmYWxzZTtcclxuICBpZiAodi5yZWNvdmVyeUFjdGlvbiAhPT0gdW5kZWZpbmVkICYmICFSRUNPVkVSWV9BQ1RJT05TLmluY2x1ZGVzKHYucmVjb3ZlcnlBY3Rpb24gYXMgbmV2ZXIpKSByZXR1cm4gZmFsc2U7XHJcbiAgcmV0dXJuIHRydWU7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpc1J1blN0YXR1cyh2OiB1bmtub3duKTogdiBpcyBSdW5TdGF0dXMge1xyXG4gIHJldHVybiB0eXBlb2YgdiA9PT0gJ3N0cmluZycgJiYgUlVOX1NUQVRVU0VTLmluY2x1ZGVzKHYgYXMgUnVuU3RhdHVzKTtcclxufVxyXG5cclxuLyoqIEhvc3QgXHU1RjE1XHU1QkZDXHU4ODRDKHN0ZG91dCBcdTdCMkNcdTRFMDBcdTg4NEMpXHUzMDAyICovXHJcbmV4cG9ydCBmdW5jdGlvbiBpc0hvc3RSZWFkeUxpbmUodjogdW5rbm93bik6IHYgaXMgeyBobWhEZXNrdG9wSG9zdFJlYWR5OiB0cnVlOyBwb3J0OiBudW1iZXI7IHZlcnNpb246IHN0cmluZyB9IHtcclxuICBpZiAoIWlzUmVjb3JkKHYpKSByZXR1cm4gZmFsc2U7XHJcbiAgaWYgKHYuaG1oRGVza3RvcEhvc3RSZWFkeSAhPT0gdHJ1ZSkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICh0eXBlb2Ygdi5wb3J0ICE9PSAnbnVtYmVyJyB8fCAhTnVtYmVyLmlzSW50ZWdlcih2LnBvcnQpIHx8IHYucG9ydCA8PSAwIHx8IHYucG9ydCA+IDY1NTM1KSByZXR1cm4gZmFsc2U7XHJcbiAgcmV0dXJuIGlzTm9uRW1wdHlTdHJpbmcodi52ZXJzaW9uKTtcclxufVxyXG4iLCAiLyoqXHJcbiAqIERlc2t0b3BIb3N0Q2xpZW50IFx1MjAxNCBcdTVCRjkgaG1oIGhvc3QgXHU3Njg0IEhUVFArU1NFIFx1NUJBMlx1NjIzN1x1N0FFRlx1MzAwMlxyXG4gKlxyXG4gKiAtIFx1NkJDRlx1NEUyQSBIVFRQIFx1OEJGN1x1NkM0Mlx1ODFFQVx1NTJBOFx1NUUyNiBYLUhtaC1LZXkodG9rZW4gXHU0RTBEXHU4RkRCIFVSTCk7XHJcbiAqIC0gXHU3RUQzXHU2Nzg0XHU1MzE2XHU5NTE5XHU4QkVGKHJlcy5ib2R5IFx1OTFDQ1x1NzY4NCBEZXNrdG9wRXJyb3IgXHU1RjYyXHU3MkI2XHU2MjE2IEhUVFAgXHU3MkI2XHU2MDAxKVx1ODlDNFx1N0VBNlx1NjIxMFx1NUYwMlx1NUUzOFx1NjI5Qlx1NTFGQTtcclxuICogLSBTU0UgXHU3NTI4IGZldGNoIFx1NkQ0MVx1NjI0Qlx1NTE5OVx1ODlFM1x1Njc5MChpZC9ldmVudC9kYXRhIFx1NUUyNyksXHU2NTJGXHU2MzAxIExhc3QtRXZlbnQtSUQgXHU4ODY1XHU2MkM5XHU5MUNEXHU4RkRFXHUzMDAyXHJcbiAqL1xyXG5pbXBvcnQgeyBkZXNrdG9wRXJyb3IsIGlzRGVza3RvcEVycm9yLCBpc0V2ZW50RW52ZWxvcGUsIHR5cGUgRGVza3RvcEVycm9yLCB0eXBlIEV2ZW50RW52ZWxvcGUgfSBmcm9tICdAaG1oLWRlc2t0b3AvY29udHJhY3RzJztcclxuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gJ25vZGU6Y3J5cHRvJztcclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgU3NlRnJhbWUge1xyXG4gIGlkPzogc3RyaW5nO1xyXG4gIGV2ZW50OiBzdHJpbmc7XHJcbiAgZGF0YTogc3RyaW5nO1xyXG59XHJcblxyXG4vKiogXHU4OUUzXHU2NzkwXHU0RTAwXHU2QkI1IFNTRSBcdTY1ODdcdTY3MkNcdTRFM0FcdTVFMjcoXHU0RTBEXHU1NDJCXHU4REU4IGNodW5rIFx1NzY4NFx1N0YxM1x1NTFCMlx1OTAzQlx1OEY5MSxcdTdFQUZcdTUxRkRcdTY1NzBcdTRGQkZcdTRFOEVcdTZENEJcdThCRDUpXHUzMDAyICovXHJcbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVNzZUNodW5rKGNodW5rOiBzdHJpbmcpOiBTc2VGcmFtZVtdIHtcclxuICBjb25zdCBmcmFtZXM6IFNzZUZyYW1lW10gPSBbXTtcclxuICBmb3IgKGNvbnN0IGJsb2NrIG9mIGNodW5rLnNwbGl0KC9cXG5cXG4vKSkge1xyXG4gICAgaWYgKCFibG9jay50cmltKCkpIGNvbnRpbnVlO1xyXG4gICAgbGV0IGlkOiBzdHJpbmcgfCB1bmRlZmluZWQ7XHJcbiAgICBsZXQgZXZlbnQgPSAnbWVzc2FnZSc7XHJcbiAgICBjb25zdCBkYXRhTGluZXM6IHN0cmluZ1tdID0gW107XHJcbiAgICBsZXQgc2F3RmllbGQgPSBmYWxzZTtcclxuICAgIGZvciAoY29uc3QgbGluZSBvZiBibG9jay5zcGxpdCgnXFxuJykpIHtcclxuICAgICAgaWYgKGxpbmUuc3RhcnRzV2l0aCgnOicpKSBjb250aW51ZTsgLy8gXHU2Q0U4XHU5MUNBL1x1NUZDM1x1OERGM1xyXG4gICAgICBpZiAobGluZS5zdGFydHNXaXRoKCdpZDonKSkgeyBpZCA9IGxpbmUuc2xpY2UoMykudHJpbSgpOyBzYXdGaWVsZCA9IHRydWU7IH1cclxuICAgICAgZWxzZSBpZiAobGluZS5zdGFydHNXaXRoKCdldmVudDonKSkgeyBldmVudCA9IGxpbmUuc2xpY2UoNikudHJpbSgpOyBzYXdGaWVsZCA9IHRydWU7IH1cclxuICAgICAgZWxzZSBpZiAobGluZS5zdGFydHNXaXRoKCdkYXRhOicpKSB7IGRhdGFMaW5lcy5wdXNoKGxpbmUuc2xpY2UoNSkucmVwbGFjZSgvXiAvLCAnJykpOyBzYXdGaWVsZCA9IHRydWU7IH1cclxuICAgIH1cclxuICAgIGlmICghc2F3RmllbGQpIGNvbnRpbnVlOyAvLyBcdTdFQUZcdTZDRThcdTkxQ0EvXHU1RkMzXHU4REYzXHU1NzU3XHU0RTBEXHU0RUE3XHU3NTFGXHU1RTI3XHJcbiAgICBmcmFtZXMucHVzaCh7IC4uLihpZCAhPT0gdW5kZWZpbmVkID8geyBpZCB9IDoge30pLCBldmVudCwgZGF0YTogZGF0YUxpbmVzLmpvaW4oJ1xcbicpIH0pO1xyXG4gIH1cclxuICByZXR1cm4gZnJhbWVzO1xyXG59XHJcblxyXG4vKiogXHU0RUNFIFNTRSBcdTVFMjdcdTY1NzBcdTYzNkVcdTRFMkRcdTg5RTNcdTUxRkFcdTU0MDhcdTZDRDUgRXZlbnRFbnZlbG9wZTtcdTRFMERcdTU0MDhcdTZDRDVcdTc2ODRcdThGRDRcdTU2REUgbnVsbChTQ0hFTUFfTUlTTUFUQ0ggXHU3NTMxXHU4QzAzXHU3NTI4XHU2NUI5XHU4QkExXHU2NTcwKVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gZW52ZWxvcGVGcm9tRnJhbWUoZnJhbWU6IFNzZUZyYW1lKTogRXZlbnRFbnZlbG9wZSB8IG51bGwge1xyXG4gIGlmIChmcmFtZS5ldmVudCAhPT0gJ2htaCcpIHJldHVybiBudWxsOyAvLyBcdTYyMTFcdTRFRUNcdTc2ODRcdTRFOEJcdTRFRjZcdTRGRTFcdTVDMDFcdTdFREZcdTRFMDBcdThENzAgZXZlbnQ6IGhtaFxyXG4gIHRyeSB7XHJcbiAgICBjb25zdCBwYXJzZWQ6IHVua25vd24gPSBKU09OLnBhcnNlKGZyYW1lLmRhdGEpO1xyXG4gICAgcmV0dXJuIGlzRXZlbnRFbnZlbG9wZShwYXJzZWQpID8gcGFyc2VkIDogbnVsbDtcclxuICB9IGNhdGNoIHtcclxuICAgIHJldHVybiBudWxsO1xyXG4gIH1cclxufVxyXG5cclxuZXhwb3J0IGNsYXNzIERlc2t0b3BIdHRwRXJyb3IgZXh0ZW5kcyBFcnJvciB7XHJcbiAgY29uc3RydWN0b3IocHVibGljIHJlYWRvbmx5IGRldGFpbDogRGVza3RvcEVycm9yKSB7XHJcbiAgICBzdXBlcihkZXRhaWwubWVzc2FnZSk7XHJcbiAgfVxyXG59XHJcblxyXG5leHBvcnQgY2xhc3MgRGVza3RvcEhvc3RDbGllbnQge1xyXG4gIGNvbnN0cnVjdG9yKFxyXG4gICAgcHJpdmF0ZSByZWFkb25seSBiYXNlVXJsOiBzdHJpbmcsXHJcbiAgICBwcml2YXRlIHJlYWRvbmx5IHRva2VuOiBzdHJpbmcsXHJcbiAgKSB7fVxyXG5cclxuICBwcml2YXRlIGhlYWRlcnMoZXh0cmE6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fSk6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4ge1xyXG4gICAgcmV0dXJuIHsgJ3gtaG1oLWtleSc6IHRoaXMudG9rZW4sIC4uLmV4dHJhIH07XHJcbiAgfVxyXG5cclxuICBhc3luYyBnZXRKc29uPFQ+KHBhdGg6IHN0cmluZywgdGltZW91dE1zID0gNV8wMDApOiBQcm9taXNlPFQ+IHtcclxuICAgIGxldCByZXM6IFJlc3BvbnNlO1xyXG4gICAgdHJ5IHtcclxuICAgICAgcmVzID0gYXdhaXQgZmV0Y2goYCR7dGhpcy5iYXNlVXJsfSR7cGF0aH1gLCB7IGhlYWRlcnM6IHRoaXMuaGVhZGVycygpLCBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQodGltZW91dE1zKSB9KTtcclxuICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYHJlcXVlc3QgZmFpbGVkOiAke1N0cmluZyhlcnIpLnNsaWNlKDAsIDE2MCl9YCwgeyByZXRyeWFibGU6IHRydWUsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gdGhpcy5wYXJzZVJlc3BvbnNlPFQ+KHJlcyk7XHJcbiAgfVxyXG5cclxuICAvKiogXHU2MkM5XHU1M0Q2XHU3RUFGXHU2NTg3XHU2NzJDXHU3QUVGXHU3MEI5KFx1NTk4MiAvYXBpL3Nlc3Npb25zLzppZC9leHBvcnQubWQpXHUzMDAyICovXHJcbiAgYXN5bmMgZ2V0VGV4dChwYXRoOiBzdHJpbmcsIHRpbWVvdXRNcyA9IDEwXzAwMCk6IFByb21pc2U8c3RyaW5nPiB7XHJcbiAgICBsZXQgcmVzOiBSZXNwb25zZTtcclxuICAgIHRyeSB7XHJcbiAgICAgIHJlcyA9IGF3YWl0IGZldGNoKGAke3RoaXMuYmFzZVVybH0ke3BhdGh9YCwgeyBoZWFkZXJzOiB0aGlzLmhlYWRlcnMoKSwgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KHRpbWVvdXRNcykgfSk7XHJcbiAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGByZXF1ZXN0IGZhaWxlZDogJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxNjApfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSB8fCByZXMuc3RhdHVzID09PSA0MDMpIHtcclxuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdBVVRIX0ZBSUxFRCcsIGBob3N0IHJlamVjdGVkIHRoZSBzZXNzaW9uIHRva2VuIChIVFRQICR7cmVzLnN0YXR1c30pYCwgeyByZXRyeWFibGU6IGZhbHNlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xyXG4gICAgfVxyXG4gICAgaWYgKCFyZXMub2spIHtcclxuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBIVFRQICR7cmVzLnN0YXR1c31gLCB7IHJldHJ5YWJsZTogcmVzLnN0YXR1cyA+PSA1MDAgfSkpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHJlcy50ZXh0KCk7XHJcbiAgfVxyXG5cclxuICAvKiogXHU2QkNGXHU0RTJBXHU1RTI2XHU1MjZGXHU0RjVDXHU3NTI4XHU3Njg0IFBPU1QgXHU4MUVBXHU1MkE4XHU2NDNBXHU1RTI2XHU1RTQyXHU3QjQ5XHU5NTJFKDAzIFx1MDBBN1x1NTZEQlx1OTYzMlx1OTFDRFx1NjUzRTpcdThCRjdcdTZDNDJcdTRGN0ZcdTc1MjggaWRlbXBvdGVuY3lLZXk7XHJcbiAgICogIHJ1bnRpbWUgXHU0RkE3XHU3N0VEXHU2NzFGXHU1MTdDXHU1QkI5XHU1RkZEXHU3NTY1LFx1NTM0Rlx1OEJBRVx1NTE0OFx1ODg0Q1x1MjAxNFx1MjAxNFx1OTFDRFx1OEJENVx1NTNFRlx1NTFFRFx1OTUyRVx1NTNCQlx1OTFDRCxcdTRFMERcdTc2RjJcdTc2RUVcdTkxQ0RcdTY1M0UpXHUzMDAyICovXHJcbiAgYXN5bmMgcG9zdEpzb248VD4ocGF0aDogc3RyaW5nLCBib2R5OiB1bmtub3duLCB0aW1lb3V0TXMgPSAxMF8wMDApOiBQcm9taXNlPFQ+IHtcclxuICAgIGxldCByZXM6IFJlc3BvbnNlO1xyXG4gICAgdHJ5IHtcclxuICAgICAgcmVzID0gYXdhaXQgZmV0Y2goYCR7dGhpcy5iYXNlVXJsfSR7cGF0aH1gLCB7XHJcbiAgICAgICAgbWV0aG9kOiAnUE9TVCcsXHJcbiAgICAgICAgaGVhZGVyczogdGhpcy5oZWFkZXJzKHtcclxuICAgICAgICAgICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsXHJcbiAgICAgICAgICAneC1pZGVtcG90ZW5jeS1rZXknOiByYW5kb21VVUlEKCksXHJcbiAgICAgICAgfSksXHJcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoYm9keSksXHJcbiAgICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KHRpbWVvdXRNcyksXHJcbiAgICAgIH0pO1xyXG4gICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgcmVxdWVzdCBmYWlsZWQ6ICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTYwKX1gLCB7IHJldHJ5YWJsZTogdHJ1ZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcclxuICAgIH1cclxuICAgIHJldHVybiB0aGlzLnBhcnNlUmVzcG9uc2U8VD4ocmVzKTtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgYXN5bmMgcGFyc2VSZXNwb25zZTxUPihyZXM6IFJlc3BvbnNlKTogUHJvbWlzZTxUPiB7XHJcbiAgICBpZiAocmVzLnN0YXR1cyA9PT0gNDAxIHx8IHJlcy5zdGF0dXMgPT09IDQwMykge1xyXG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgYGhvc3QgcmVqZWN0ZWQgdGhlIHNlc3Npb24gdG9rZW4gKEhUVFAgJHtyZXMuc3RhdHVzfSlgLCB7IHJldHJ5YWJsZTogZmFsc2UsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XHJcbiAgICB9XHJcbiAgICBjb25zdCB0ZXh0ID0gYXdhaXQgcmVzLnRleHQoKTtcclxuICAgIGxldCBwYXJzZWQ6IHVua25vd24gPSBudWxsO1xyXG4gICAgdHJ5IHtcclxuICAgICAgcGFyc2VkID0gdGV4dCA/IEpTT04ucGFyc2UodGV4dCkgOiBudWxsO1xyXG4gICAgfSBjYXRjaCB7XHJcbiAgICAgIHBhcnNlZCA9IG51bGw7XHJcbiAgICB9XHJcbiAgICBpZiAoIXJlcy5vaykge1xyXG4gICAgICBpZiAoaXNEZXNrdG9wRXJyb3IocGFyc2VkKSkgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IocGFyc2VkKTtcclxuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBIVFRQICR7cmVzLnN0YXR1c306ICR7dGV4dC5zbGljZSgwLCAxNjApfWAsIHsgcmV0cnlhYmxlOiByZXMuc3RhdHVzID49IDUwMCB9KSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gcGFyc2VkIGFzIFQ7XHJcbiAgfVxyXG5cclxuICAvKipcclxuICAgKiBcdThCQTJcdTk2MDVcdTUxNjhcdTkwRTggU1NFIFx1NUUyNyhcdTU0MkJcdTk3NUVcdTRGRTFcdTVDMDFcdTRFOEJcdTRFRjY6ZGVsdGEvbGluZSBcdTdCNDlcdTlBRDhcdTk4OTFcdTZENDEpXHUzMDAyXHU0RkUxXHU1QzAxXHU3NTMxXHU4QzAzXHU3NTI4XHU2NUI5XHJcbiAgICogXHU3NTI4IGVudmVsb3BlRnJvbUZyYW1lIFx1ODFFQVx1ODg0Q1x1NTIwNlx1NkQ0MTtcdTY1QURcdTdFQkZcdTkxQ0RcdThGREVcdThCRURcdTRFNDlcdTU0MEMgZXZlbnRzKClcdTMwMDJcclxuICAgKi9cclxuICBhc3luYyAqcmF3RXZlbnRzKGxhc3RFdmVudElkPzogc3RyaW5nLCBzaWduYWw/OiBBYm9ydFNpZ25hbCk6IEFzeW5jR2VuZXJhdG9yPFNzZUZyYW1lPiB7XHJcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgJHt0aGlzLmJhc2VVcmx9L2FwaS9ldmVudHNgLCB7XHJcbiAgICAgIGhlYWRlcnM6IHRoaXMuaGVhZGVycyh7XHJcbiAgICAgICAgYWNjZXB0OiAndGV4dC9ldmVudC1zdHJlYW0nLFxyXG4gICAgICAgIC4uLihsYXN0RXZlbnRJZCAhPT0gdW5kZWZpbmVkID8geyAnbGFzdC1ldmVudC1pZCc6IGxhc3RFdmVudElkIH0gOiB7fSksXHJcbiAgICAgIH0pLFxyXG4gICAgICAuLi4oc2lnbmFsICE9PSB1bmRlZmluZWQgPyB7IHNpZ25hbCB9IDoge30pLFxyXG4gICAgfSk7XHJcbiAgICBpZiAocmVzLnN0YXR1cyA9PT0gNDAxIHx8IHJlcy5zdGF0dXMgPT09IDQwMykge1xyXG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgYGhvc3QgcmVqZWN0ZWQgdGhlIHNlc3Npb24gdG9rZW4gKEhUVFAgJHtyZXMuc3RhdHVzfSlgLCB7IHJldHJ5YWJsZTogZmFsc2UsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XHJcbiAgICB9XHJcbiAgICBpZiAoIXJlcy5vayB8fCByZXMuYm9keSA9PT0gbnVsbCkge1xyXG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYFNTRSBIVFRQICR7cmVzLnN0YXR1c31gLCB7IHJldHJ5YWJsZTogdHJ1ZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHJlYWRlciA9IHJlcy5ib2R5LmdldFJlYWRlcigpO1xyXG4gICAgY29uc3QgZGVjb2RlciA9IG5ldyBUZXh0RGVjb2RlcigpO1xyXG4gICAgbGV0IGJ1ZmZlciA9ICcnO1xyXG4gICAgZm9yICg7Oykge1xyXG4gICAgICBjb25zdCB7IGRvbmUsIHZhbHVlIH0gPSBhd2FpdCByZWFkZXIucmVhZCgpO1xyXG4gICAgICBpZiAoZG9uZSkgcmV0dXJuO1xyXG4gICAgICBidWZmZXIgKz0gZGVjb2Rlci5kZWNvZGUodmFsdWUsIHsgc3RyZWFtOiB0cnVlIH0pO1xyXG4gICAgICBsZXQgaWR4OiBudW1iZXI7XHJcbiAgICAgIHdoaWxlICgoaWR4ID0gYnVmZmVyLmluZGV4T2YoJ1xcblxcbicpKSAhPT0gLTEpIHtcclxuICAgICAgICBjb25zdCBibG9jayA9IGJ1ZmZlci5zbGljZSgwLCBpZHgpO1xyXG4gICAgICAgIGJ1ZmZlciA9IGJ1ZmZlci5zbGljZShpZHggKyAyKTtcclxuICAgICAgICBmb3IgKGNvbnN0IGZyYW1lIG9mIHBhcnNlU3NlQ2h1bmsoYmxvY2spKSB5aWVsZCBmcmFtZTtcclxuICAgICAgfVxyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgLyoqXHJcbiAgICogXHU4QkEyXHU5NjA1IFNTRSBcdTRFOEJcdTRFRjZcdTZENDEoYXN5bmMgaXRlcmF0b3IpXHUzMDAyXHU2NUFEXHU3RUJGXHU3NTMxXHU4QzAzXHU3NTI4XHU2NUI5XHU5MUNEXHU4RkRFO1x1OTFDRFx1OEZERVx1NjVGNlx1NjI4QVx1NjcwMFx1NTQwRVxyXG4gICAqIFx1NjUzNlx1NTIzMFx1NzY4NCBldmVudElkIFx1NEYyMFx1NTE2NSBsYXN0RXZlbnRJZCxob3N0IFx1N0FFRlx1NEVDRVx1OTFDRFx1NjUzRVx1NzNBRlx1ODg2NVx1NTNEMVx1MzAwMlxyXG4gICAqL1xyXG4gIGFzeW5jICpldmVudHMobGFzdEV2ZW50SWQ/OiBzdHJpbmcsIHNpZ25hbD86IEFib3J0U2lnbmFsKTogQXN5bmNHZW5lcmF0b3I8RXZlbnRFbnZlbG9wZT4ge1xyXG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYCR7dGhpcy5iYXNlVXJsfS9hcGkvZXZlbnRzYCwge1xyXG4gICAgICBoZWFkZXJzOiB0aGlzLmhlYWRlcnMoe1xyXG4gICAgICAgIGFjY2VwdDogJ3RleHQvZXZlbnQtc3RyZWFtJyxcclxuICAgICAgICAuLi4obGFzdEV2ZW50SWQgIT09IHVuZGVmaW5lZCA/IHsgJ2xhc3QtZXZlbnQtaWQnOiBsYXN0RXZlbnRJZCB9IDoge30pLFxyXG4gICAgICB9KSxcclxuICAgICAgLi4uKHNpZ25hbCAhPT0gdW5kZWZpbmVkID8geyBzaWduYWwgfSA6IHt9KSxcclxuICAgIH0pO1xyXG4gICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSB8fCByZXMuc3RhdHVzID09PSA0MDMpIHtcclxuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdBVVRIX0ZBSUxFRCcsIGBob3N0IHJlamVjdGVkIHRoZSBzZXNzaW9uIHRva2VuIChIVFRQICR7cmVzLnN0YXR1c30pYCwgeyByZXRyeWFibGU6IGZhbHNlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xyXG4gICAgfVxyXG4gICAgaWYgKCFyZXMub2sgfHwgIXJlcy5ib2R5KSB7XHJcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgU1NFIEhUVFAgJHtyZXMuc3RhdHVzfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgcmVhZGVyID0gcmVzLmJvZHkuZ2V0UmVhZGVyKCk7XHJcbiAgICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKCk7XHJcbiAgICBsZXQgYnVmZmVyID0gJyc7XHJcbiAgICBmb3IgKDs7KSB7XHJcbiAgICAgIGNvbnN0IHsgZG9uZSwgdmFsdWUgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XHJcbiAgICAgIGlmIChkb25lKSByZXR1cm47XHJcbiAgICAgIGJ1ZmZlciArPSBkZWNvZGVyLmRlY29kZSh2YWx1ZSwgeyBzdHJlYW06IHRydWUgfSk7XHJcbiAgICAgIC8vIFx1NEVFNVx1N0E3QVx1ODg0Q1x1NTIwNlx1NUUyNztcdTRGRERcdTc1NTlcdTRFMERcdTVCOENcdTY1NzRcdTc2ODRcdTVDM0VcdTkwRThcclxuICAgICAgbGV0IGlkeDogbnVtYmVyO1xyXG4gICAgICB3aGlsZSAoKGlkeCA9IGJ1ZmZlci5pbmRleE9mKCdcXG5cXG4nKSkgIT09IC0xKSB7XHJcbiAgICAgICAgY29uc3QgYmxvY2sgPSBidWZmZXIuc2xpY2UoMCwgaWR4KTtcclxuICAgICAgICBidWZmZXIgPSBidWZmZXIuc2xpY2UoaWR4ICsgMik7XHJcbiAgICAgICAgZm9yIChjb25zdCBmcmFtZSBvZiBwYXJzZVNzZUNodW5rKGJsb2NrKSkge1xyXG4gICAgICAgICAgY29uc3QgZW52ID0gZW52ZWxvcGVGcm9tRnJhbWUoZnJhbWUpO1xyXG4gICAgICAgICAgaWYgKGVudiAhPT0gbnVsbCkgeWllbGQgZW52O1xyXG4gICAgICAgIH1cclxuICAgICAgfVxyXG4gICAgfVxyXG4gIH1cclxufVxyXG4iLCAiLyoqXHJcbiAqIGZha2UgaG9zdCBcdTIwMTQgaG1oYXJuZXNzIHJ1bnRpbWUgXHU3Njg0XHU2RDRCXHU4QkQ1XHU2NkZGXHU4RUFCKE1hc3RlclByb21wdCBcdTk2MzZcdTZCQjUgRC9FOlxyXG4gKiBcIlx1NTE0OFx1NEY3Rlx1NzUyOCBmYWtlIGhvc3QgXHU3RjE2XHU1MTk5XHU3MkI2XHU2MDAxXHU2NzNBXHU2RDRCXHU4QkQ1LFx1NTE4RFx1NjNBNVx1NzcxRlx1NUI5RSBBUElcIjtcdTk2MzZcdTZCQjUgRSBcdTc2ODRcdTRGMUFcdThCRERcdTdFQjVcdTUyMDdcdTcyNDdcclxuICogZTJlIFx1NEU1Rlx1NTE0OFx1NTcyOCBmYWtlIFx1NUM0Mlx1OTVFRFx1NzNBRilcdTMwMDJcclxuICpcclxuICogXHU2ODRDXHU5NzYyIGhvc3QgXHU1NDA4XHU1NDBDOlxyXG4gKiAgLSBcdTUzRUFcdTdFRDEgMTI3LjAuMC4xLFx1N0FFRlx1NTNFMyBPUyBcdTUyMDZcdTkxNEQsXHU1QjlFXHU5NjQ1XHU3QUVGXHU1M0UzXHU1MTk5IHN0ZG91dCBcdTVGMTVcdTVCRkNcdTg4NEM7XHJcbiAqICAtIFx1NjI0MFx1NjcwOSAvYXBpLyogXHU4OTgxXHU2QzQyIFgtSG1oLUtleSA9PT0gSE1IX0RFU0tUT1BfVE9LRU4sXHU1NDI2XHU1MjE5IDQwMSArIERlc2t0b3BFcnJvcjtcclxuICogIC0gR0VUIC9hcGkvc3RhdGUgXHU1MDY1XHU1RUI3XHU2M0EyXHU2RDRCO0dFVCAvYXBpL2V2ZW50cyBTU0UoZXZlbnQ6IGhtaCBcdTRGRTFcdTVDMDFcdTZENDEgKyBcdTkxQ0RcdTY1M0VcdTczQUYpO1xyXG4gKiAgLSBQT1NUIC9hcGkvZGVza3RvcC9zaHV0ZG93biBcdTRGMThcdTk2QzVcdTkwMDBcdTUxRkFcdTMwMDJcclxuICpcclxuICogXHU5NjM2XHU2QkI1IEUgXHU2QTIxXHU2MkRGXHU5NzYyKFx1NEUwRSBobWhhcm5lc3MgZGVza3RvcCBcdTZBMjFcdTVGMEZcdTU0MENcdTVGNjIpOlxyXG4gKiAgLSBQT1NUIC9hcGkvdGFzayB7dGV4dCwgc2Vzc2lvbklkLCBtb2RlfTpcdTYzOTJcdTk2MUZcdTVFNzZcdTYzMDlcdTgxMUFcdTY3MkNcdTUzRDFcclxuICogICAgcnVuLnN0YXJ0ZWQgXHUyMTkyIHRvb2wuc3RhcnRlZC9jb21wbGV0ZWQgXHUyMTkyKG1vZGU9PT0nYXNrJyBcdTY1RjYpXHJcbiAqICAgIGFwcHJvdmFsLnJlcXVpcmVkKFx1N0I0OSAvYXBpL2FwcHJvdmUpXHUyMTkyIHJ1bi5jb21wbGV0ZWQ7XHJcbiAqICAtIFBPU1QgL2FwaS9hcHByb3ZlIHtncmFudGVkLCBzZXNzaW9uSWR9O1xyXG4gKiAgLSBQT1NUIC9hcGkvaW50ZXJydXB0IHtzZXNzaW9uSWR9O1xyXG4gKiAgLSBHRVQgL2FwaS9zZXNzaW9uc1x1MzAwMlxyXG4gKlxyXG4gKiBcdTZENEJcdThCRDVcdTk0QTlcdTVCNTA6RkFLRV9IT1NUX0RJRV9BRlRFUl9NUyAvIEZBS0VfSE9TVF9ESUVfQVRfQk9PVCAvXHJcbiAqIEZBS0VfSE9TVF9FWFBFQ1RfVE9LRU4gLyBGQUtFX0hPU1RfVEFTS19ERUxBWV9NUyAvIEZBS0VfSE9TVF9UQVNLX0ZBSUw9MVxyXG4gKiAoXHU0RUZCXHU1MkExXHU0RUU1IHJ1bi5mYWlsZWQgXHU3RUQzXHU2NzVGLFx1Njc4NFx1OTAyMFx1OTUxOVx1OEJFRlx1NjA2Mlx1NTkwRFx1NTczQVx1NjY2RilcdTMwMDJcclxuICovXHJcbmltcG9ydCB7IGNyZWF0ZVNlcnZlciwgdHlwZSBTZXJ2ZXJSZXNwb25zZSB9IGZyb20gJ25vZGU6aHR0cCc7XHJcbmltcG9ydCB7IHJhbmRvbVVVSUQgfSBmcm9tICdub2RlOmNyeXB0byc7XHJcbmltcG9ydCB7IHBhdGhUb0ZpbGVVUkwgfSBmcm9tICdub2RlOnVybCc7XHJcbmltcG9ydCB7IHJlYWxwYXRoU3luYyB9IGZyb20gJ25vZGU6ZnMnO1xyXG5pbXBvcnQgeyBFVkVOVF9TQ0hFTUFfVkVSU0lPTiwgZGVza3RvcEVycm9yLCB0eXBlIEV2ZW50RW52ZWxvcGUsIHR5cGUgRXZlbnRLaW5kIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyc7XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIEZha2VIb3N0SGFuZGxlIHtcclxuICBwb3J0OiBudW1iZXI7XHJcbiAgZW1pdChzZXNzaW9uSWQ6IHN0cmluZywgcnVuSWQ6IHN0cmluZywga2luZDogRXZlbnRLaW5kLCBwYXlsb2FkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IG51bWJlcjtcclxuICBjbG9zZSgpOiBQcm9taXNlPHZvaWQ+O1xyXG59XHJcblxyXG5pbnRlcmZhY2UgRmFrZVNlc3Npb24ge1xyXG4gIGlkOiBzdHJpbmc7XHJcbiAgY3JlYXRlZEF0OiBzdHJpbmc7XHJcbiAgdXBkYXRlZEF0OiBzdHJpbmc7XHJcbn1cclxuXHJcbmludGVyZmFjZSBQZW5kaW5nQXBwcm92YWwge1xyXG4gIHNlc3Npb25JZDogc3RyaW5nO1xyXG4gIGFwcHJvdmFsSWQ6IHN0cmluZztcclxuICByZXNvbHZlKGdyYW50ZWQ6IGJvb2xlYW4pOiB2b2lkO1xyXG59XHJcblxyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc3RhcnRGYWtlSG9zdChvcHRzOiB7IHRva2VuOiBzdHJpbmc7IHF1aWV0PzogYm9vbGVhbiB9KTogUHJvbWlzZTxGYWtlSG9zdEhhbmRsZT4ge1xyXG4gIGNvbnN0IHRva2VuID0gb3B0cy50b2tlbjtcclxuICAvLyBcdTZENEJcdThCRDVcdTk0QTlcdTVCNTA6RkFLRV9IT1NUX0VYUEVDVF9UT0tFTiBcdThCQTkgaG9zdCBcdTY4MjFcdTlBOENcdTRFMDBcdTRFMkFcdTRFMEUgSE1IX0RFU0tUT1BfVE9LRU5cclxuICAvLyBcdTRFMERcdTU0MENcdTc2ODRcdTUwM0MoXHU2Nzg0XHU5MDIwIEFVVEhfRkFJTEVEIFx1NTczQVx1NjY2RjtzdXBlcnZpc29yIFx1NjAzQlx1NjYyRlx1ODk4Nlx1NzZENiBITUhfREVTS1RPUF9UT0tFTilcclxuICBjb25zdCBleHBlY3RlZCA9IHByb2Nlc3MuZW52LkZBS0VfSE9TVF9FWFBFQ1RfVE9LRU4gPz8gdG9rZW47XHJcbiAgY29uc3QgdGFza0RlbGF5ID0gTnVtYmVyKHByb2Nlc3MuZW52LkZBS0VfSE9TVF9UQVNLX0RFTEFZX01TID8/IDMwKTtcclxuICBjb25zdCBmYWlsVGFza3MgPSBwcm9jZXNzLmVudi5GQUtFX0hPU1RfVEFTS19GQUlMID09PSAnMSc7XHJcblxyXG4gIGNvbnN0IHNzZUNsaWVudHMgPSBuZXcgU2V0PFNlcnZlclJlc3BvbnNlPigpO1xyXG4gIGNvbnN0IHNlcUJ5UnVuID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcclxuICAvLyBcdTkxQ0RcdTY1M0VcdTczQUY6XHU2NzAwXHU4RkQxIDIwMCBcdTVFMjcoTGFzdC1FdmVudC1JRCBcdTY1QURcdTdFQkZcdTg4NjVcdTYyQzkpLFx1NEUwRSBobWhhcm5lc3Mgd2ViIFx1NTQwQ1x1NkIzRVx1OEJFRFx1NEU0OVxyXG4gIGNvbnN0IHJpbmc6IEFycmF5PHsgaWQ6IG51bWJlcjsgZXZlbnQ6IHN0cmluZzsgZGF0YTogdW5rbm93biB9PiA9IFtdO1xyXG4gIGxldCByaW5nU2VxID0gMDtcclxuICBjb25zdCBzZXNzaW9ucyA9IG5ldyBNYXA8c3RyaW5nLCBGYWtlU2Vzc2lvbj4oKTtcclxuICBsZXQgcGVuZGluZzogUGVuZGluZ0FwcHJvdmFsIHwgbnVsbCA9IG51bGw7XHJcbiAgY29uc3QgcnVuVGltZXJzID0gbmV3IE1hcDxzdHJpbmcsIE5vZGVKUy5UaW1lb3V0PigpO1xyXG4gIC8vIFx1NURFNVx1NEY1Q1x1NTMzQS9Qcm92aWRlciBcdTcyQjZcdTYwMDEoXHU0RTBFIGhtaGFybmVzcyBcdTU0MENcdTVGNjJcdTc2ODRcdTY3MDBcdTVDMEZcdTZBMjFcdTYyREYpXHJcbiAgY29uc3QgZmFrZVdvcmtzcGFjZXMgPSB7XHJcbiAgICBjdXJyZW50OiAnd3MtZGVtbycsXHJcbiAgICBpdGVtczogW1xyXG4gICAgICB7IGlkOiAnd3MtZGVtbycsIG5hbWU6ICdkZW1vLXdvcmtzcGFjZScsIHBhdGg6ICdDOlxcXFxkZW1vJyB9LFxyXG4gICAgXSxcclxuICB9O1xyXG4gIGNvbnN0IGZha2VQcm92aWRlcnMgPSBuZXcgTWFwPHN0cmluZywgeyBiYXNlVXJsOiBzdHJpbmc7IG1vZGVsOiBzdHJpbmc7IGFwaUtleTogc3RyaW5nIH0+KFtcclxuICAgIFsnZGVtbycsIHsgYmFzZVVybDogJ2h0dHA6Ly8xMjcuMC4wLjE6OS92MScsIG1vZGVsOiAnZmFrZS1tJywgYXBpS2V5OiAnc2stZGVtby0xMjM0JyB9XSxcclxuICAgIFsnZGVtby12aXNpb24nLCB7IGJhc2VVcmw6ICdodHRwOi8vMTI3LjAuMC4xOjkvdjEnLCBtb2RlbDogJ2Zha2UtbS12aXNpb24nLCBhcGlLZXk6ICdzay1kZW1vLTU2NzgnIH1dLFxyXG4gIF0pO1xyXG4gIGxldCBmYWtlQ2hhdFByb3ZpZGVyID0gJ2RlbW8nO1xyXG5cclxuICBjb25zdCBlbWl0ID0gKHNlc3Npb25JZDogc3RyaW5nLCBydW5JZDogc3RyaW5nLCBraW5kOiBFdmVudEtpbmQsIHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogbnVtYmVyID0+IHtcclxuICAgIGNvbnN0IGtleSA9IGAke3Nlc3Npb25JZH1cXDAke3J1bklkfWA7XHJcbiAgICBjb25zdCBzZXEgPSAoc2VxQnlSdW4uZ2V0KGtleSkgPz8gMCkgKyAxO1xyXG4gICAgc2VxQnlSdW4uc2V0KGtleSwgc2VxKTtcclxuICAgIGNvbnN0IGVudjogRXZlbnRFbnZlbG9wZSA9IHtcclxuICAgICAgc2NoZW1hVmVyc2lvbjogRVZFTlRfU0NIRU1BX1ZFUlNJT04sXHJcbiAgICAgIGV2ZW50SWQ6IHJhbmRvbVVVSUQoKSxcclxuICAgICAgc2Vzc2lvbklkLFxyXG4gICAgICBydW5JZCxcclxuICAgICAgc2VxLFxyXG4gICAgICBvY2N1cnJlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXHJcbiAgICAgIGtpbmQsXHJcbiAgICAgIHBheWxvYWQsXHJcbiAgICB9O1xyXG4gICAgY29uc3QgaWQgPSArK3JpbmdTZXE7XHJcbiAgICByaW5nLnB1c2goeyBpZCwgZXZlbnQ6ICdobWgnLCBkYXRhOiBlbnYgfSk7XHJcbiAgICBpZiAocmluZy5sZW5ndGggPiAyMDApIHJpbmcuc3BsaWNlKDAsIHJpbmcubGVuZ3RoIC0gMjAwKTtcclxuICAgIGZvciAoY29uc3QgYyBvZiBzc2VDbGllbnRzKSB7XHJcbiAgICAgIGMud3JpdGUoYGlkOiAke2lkfVxcbmV2ZW50OiBobWhcXG5kYXRhOiAke0pTT04uc3RyaW5naWZ5KGVudil9XFxuXFxuYCk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gc2VxO1xyXG4gIH07XHJcblxyXG4gIGNvbnN0IHRvdWNoID0gKHNlc3Npb25JZDogc3RyaW5nKTogRmFrZVNlc3Npb24gPT4ge1xyXG4gICAgbGV0IHMgPSBzZXNzaW9ucy5nZXQoc2Vzc2lvbklkKTtcclxuICAgIGlmIChzID09PSB1bmRlZmluZWQpIHtcclxuICAgICAgcyA9IHsgaWQ6IHNlc3Npb25JZCwgY3JlYXRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksIHVwZGF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpIH07XHJcbiAgICAgIHNlc3Npb25zLnNldChzZXNzaW9uSWQsIHMpO1xyXG4gICAgfVxyXG4gICAgcy51cGRhdGVkQXQgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XHJcbiAgICByZXR1cm4gcztcclxuICB9O1xyXG5cclxuICAvKiogXHU2QTIxXHU2MkRGXHU0RTAwXHU2QjIxXHU0RUZCXHU1MkExOlx1NjI3OVx1NTFDNlx1NkEyMVx1NUYwRlx1NjMwMlx1OEQ3N1x1N0I0OVx1NUY4NSAvYXBpL2FwcHJvdmVcdTMwMDIgKi9cclxuICBjb25zdCBydW5UYXNrID0gKHNlc3Npb25JZDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcsIG1vZGU6IHN0cmluZyk6IHN0cmluZyA9PiB7XHJcbiAgICBjb25zdCBydW5JZCA9IGBydW4tJHtEYXRlLm5vdygpLnRvU3RyaW5nKDM2KX0tJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCA4KX1gO1xyXG4gICAgdG91Y2goc2Vzc2lvbklkKTtcclxuICAgIGNvbnN0IHN0ZXBzOiBBcnJheTwoKSA9PiB2b2lkPiA9IFtdO1xyXG4gICAgY29uc3Qgd2FpdCA9IChmbjogKCkgPT4gdm9pZCwgbXMgPSB0YXNrRGVsYXkpOiB2b2lkID0+IHtcclxuICAgICAgY29uc3QgdCA9IHNldFRpbWVvdXQoZm4sIG1zKTtcclxuICAgICAgcnVuVGltZXJzLnNldChgJHtzZXNzaW9uSWR9XFwwJHtydW5JZH1gLCB0KTtcclxuICAgIH07XHJcbiAgICBjb25zdCBjaGFpbiA9IChmbnM6IEFycmF5PCgpID0+IHZvaWQ+KTogdm9pZCA9PiB7XHJcbiAgICAgIGNvbnN0IFtmaXJzdCwgLi4ucmVzdF0gPSBmbnM7XHJcbiAgICAgIGlmIChmaXJzdCA9PT0gdW5kZWZpbmVkKSByZXR1cm47XHJcbiAgICAgIHdhaXQoKCkgPT4ge1xyXG4gICAgICAgIGZpcnN0KCk7XHJcbiAgICAgICAgY2hhaW4ocmVzdCk7XHJcbiAgICAgIH0pO1xyXG4gICAgfTtcclxuXHJcbiAgICBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICdydW4uc3RhcnRlZCcsIHsgdGFzazogdGV4dCwgbW9kZSB9KTtcclxuICAgIGlmIChmYWlsVGFza3MpIHtcclxuICAgICAgd2FpdCgoKSA9PiBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICdydW4uZmFpbGVkJywge1xyXG4gICAgICAgIGVycm9yOiB7IGNvZGU6ICdBVVRIX0ZBSUxFRCcsIG1lc3NhZ2U6ICdzaW11bGF0ZWQgcHJvdmlkZXIgYXV0aCBmYWlsdXJlJywgcmV0cnlhYmxlOiBmYWxzZSB9LFxyXG4gICAgICB9KSk7XHJcbiAgICAgIHJldHVybiBydW5JZDtcclxuICAgIH1cclxuXHJcbiAgICBjb25zdCBmaW5pc2hSdW4gPSAoYW5zd2VyOiBzdHJpbmcsIHRvb2xVc2VzOiBudW1iZXIpOiB2b2lkID0+IHtcclxuICAgICAgcnVuVGltZXJzLmRlbGV0ZShgJHtzZXNzaW9uSWR9XFwwJHtydW5JZH1gKTtcclxuICAgICAgLy8gXHU0RUE0XHU0RUQ4XHU3MjY5XHU1MTQ4XHU0RThFXHU3RUM4XHU2MDAxKFx1NEUwRSBobWhhcm5lc3MgZGVza3RvcCBcdTY4NjVcdTU0MENcdTVFOEY6YXJ0aWZhY3QuY3JlYXRlZCBcdTIxOTIgcnVuLmNvbXBsZXRlZClcclxuICAgICAgZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAnYXJ0aWZhY3QuY3JlYXRlZCcsIHtcclxuICAgICAgICBhcnRpZmFjdDogeyByZWxQYXRoOiAnb3V0LnR4dCcsIGtpbmQ6ICdmaWxlJywgdGl0bGU6ICdvdXQudHh0JyB9LFxyXG4gICAgICB9KTtcclxuICAgICAgZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAncnVuLmNvbXBsZXRlZCcsIHsgdGV4dDogYW5zd2VyLCB0dXJuczogMSwgdG9vbFVzZXMgfSk7XHJcbiAgICB9O1xyXG5cclxuICAgIGNvbnN0IHNjcmlwdGVkOiBBcnJheTwoKSA9PiB2b2lkPiA9IFtcclxuICAgICAgKCkgPT4gZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAndG9vbC5zdGFydGVkJywgeyBuYW1lOiAncmVhZF9maWxlJywgYXJnc1ByZXZpZXc6ICd7XCJwYXRoXCI6XCJSRUFETUUubWRcIn0nIH0pLFxyXG4gICAgICAoKSA9PiBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICd0b29sLmNvbXBsZXRlZCcsIHsgbmFtZTogJ3JlYWRfZmlsZScsIGlzRXJyb3I6IGZhbHNlLCBvdXRwdXRQcmV2aWV3OiAnIyBkZW1vJyB9KSxcclxuICAgIF07XHJcblxyXG4gICAgaWYgKG1vZGUgPT09ICdhc2snKSB7XHJcbiAgICAgIHNjcmlwdGVkLnB1c2goKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IGFwcHJvdmFsSWQgPSBgYXAtJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCA4KX1gO1xyXG4gICAgICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ2FwcHJvdmFsLnJlcXVpcmVkJywge1xyXG4gICAgICAgICAgYXBwcm92YWxJZCxcclxuICAgICAgICAgIHRvb2w6ICd3cml0ZV9maWxlJyxcclxuICAgICAgICAgIGFyZ3NQcmV2aWV3OiAne1wicGF0aFwiOlwib3V0LnR4dFwiLFwiY29udGVudFwiOlwiaGlcIn0nLFxyXG4gICAgICAgICAgcmlzazogJ1x1NTE5OVx1NTE2NVx1NURFNVx1NEY1Q1x1NTMzQVx1NjU4N1x1NEVGNiBvdXQudHh0KFx1NkEyMVx1NjJERiknLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHBlbmRpbmcgPSB7XHJcbiAgICAgICAgICBzZXNzaW9uSWQsXHJcbiAgICAgICAgICBhcHByb3ZhbElkLFxyXG4gICAgICAgICAgcmVzb2x2ZTogKGdyYW50ZWQpID0+IHtcclxuICAgICAgICAgICAgcGVuZGluZyA9IG51bGw7XHJcbiAgICAgICAgICAgIGlmIChncmFudGVkKSB7XHJcbiAgICAgICAgICAgICAgZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAndG9vbC5zdGFydGVkJywgeyBuYW1lOiAnd3JpdGVfZmlsZScsIGFyZ3NQcmV2aWV3OiAne1wicGF0aFwiOlwib3V0LnR4dFwifScgfSk7XHJcbiAgICAgICAgICAgICAgd2FpdCgoKSA9PiBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICd0b29sLmNvbXBsZXRlZCcsIHsgbmFtZTogJ3dyaXRlX2ZpbGUnLCBpc0Vycm9yOiBmYWxzZSwgb3V0cHV0UHJldmlldzogJ3dyb3RlIDIgYnl0ZXMnIH0pKTtcclxuICAgICAgICAgICAgICB3YWl0KCgpID0+IGZpbmlzaFJ1bihgZWNobzogJHt0ZXh0fShcdTVERjJcdTYyNjdcdTg4NENcdTUxOTlcdTUxNjUpYCwgMyksIHRhc2tEZWxheSAqIDIpO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgIGZpbmlzaFJ1bihgZWNobzogJHt0ZXh0fShcdTVCQTFcdTYyNzlcdTg4QUJcdTYyRDJcdTdFREQsXHU2NzJBXHU2MjY3XHU4ODRDXHU1MTk5XHU1MTY1KWAsIDEpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICB9LFxyXG4gICAgICAgIH07XHJcbiAgICAgIH0pO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgc2NyaXB0ZWQucHVzaCgoKSA9PiBmaW5pc2hSdW4oYGVjaG86ICR7dGV4dH1gLCAxKSk7XHJcbiAgICB9XHJcbiAgICBjaGFpbihzY3JpcHRlZCk7XHJcbiAgICByZXR1cm4gcnVuSWQ7XHJcbiAgfTtcclxuXHJcbiAgY29uc3Qgc2VydmVyID0gY3JlYXRlU2VydmVyKChyZXEsIHJlcykgPT4ge1xyXG4gICAgY29uc3QgdXJsID0gbmV3IFVSTChyZXEudXJsID8/ICcvJywgJ2h0dHA6Ly8xMjcuMC4wLjEnKTtcclxuICAgIGNvbnN0IGF1dGhvcml6ZWQgPSByZXEuaGVhZGVyc1sneC1obWgta2V5J10gPT09IGV4cGVjdGVkO1xyXG4gICAgY29uc3QgZGVueSA9ICgpOiB2b2lkID0+IHtcclxuICAgICAgcmVzLndyaXRlSGVhZCg0MDEsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgJ21pc3Npbmcgb3IgaW52YWxpZCB4LWhtaC1rZXknLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcclxuICAgIH07XHJcblxyXG4gICAgY29uc3QgcmVhZEJvZHkgPSAoKTogUHJvbWlzZTxzdHJpbmc+ID0+XHJcbiAgICAgIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XHJcbiAgICAgICAgbGV0IGIgPSAnJztcclxuICAgICAgICByZXEub24oJ2RhdGEnLCAoYzogQnVmZmVyKSA9PiB7IGIgKz0gYy50b1N0cmluZygpOyB9KTtcclxuICAgICAgICByZXEub24oJ2VuZCcsICgpID0+IHJlc29sdmUoYikpO1xyXG4gICAgICB9KTtcclxuXHJcbiAgICBpZiAodXJsLnBhdGhuYW1lID09PSAnL2FwaS9ldmVudHMnKSB7XHJcbiAgICAgIGlmICghYXV0aG9yaXplZCkgeyBkZW55KCk7IHJldHVybjsgfVxyXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ3RleHQvZXZlbnQtc3RyZWFtJywgJ2NhY2hlLWNvbnRyb2wnOiAnbm8tY2FjaGUnLCBjb25uZWN0aW9uOiAna2VlcC1hbGl2ZScgfSk7XHJcbiAgICAgIHJlcy5mbHVzaEhlYWRlcnM/LigpO1xyXG4gICAgICBzc2VDbGllbnRzLmFkZChyZXMpO1xyXG4gICAgICAvLyBcdTY1QURcdTdFQkZcdTg4NjVcdTYyQzk6TGFzdC1FdmVudC1JRCBcdTRFNEJcdTUyNERcdTc2ODRcdTVFMjdcdTVERjJcdTU3MjhcdTVCQTJcdTYyMzdcdTdBRUYsXHU5MUNEXHU1M0QxXHU1MTc2XHU1NDBFXHU3Njg0XHU3M0FGXHU1RjYyXHU3RjEzXHU1MUIyXHJcbiAgICAgIGNvbnN0IGxhc3RJZCA9IE51bWJlcihyZXEuaGVhZGVyc1snbGFzdC1ldmVudC1pZCddID8/IDApO1xyXG4gICAgICBpZiAoTnVtYmVyLmlzRmluaXRlKGxhc3RJZCkgJiYgbGFzdElkID4gMCkge1xyXG4gICAgICAgIGZvciAoY29uc3QgZSBvZiByaW5nKSB7XHJcbiAgICAgICAgICBpZiAoZS5pZCA+IGxhc3RJZCkgcmVzLndyaXRlKGBpZDogJHtlLmlkfVxcbmV2ZW50OiAke2UuZXZlbnR9XFxuZGF0YTogJHtKU09OLnN0cmluZ2lmeShlLmRhdGEpfVxcblxcbmApO1xyXG4gICAgICAgIH1cclxuICAgICAgfVxyXG4gICAgICByZXEub24oJ2Nsb3NlJywgKCkgPT4gc3NlQ2xpZW50cy5kZWxldGUocmVzKSk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmICghYXV0aG9yaXplZCkgeyBkZW55KCk7IHJldHVybjsgfVxyXG5cclxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3N0YXRlJykge1xyXG4gICAgICAvLyBwcm92aWRlcnNEZXRhaWw6XHU0RTBFIGhtaGFybmVzcyBcdTU0MENcdTVGNjJcdTIwMTRcdTIwMTRrZXkgXHU1M0VBXHU1MUZBIGhhc0tleS9cdTY3MkJcdTU2REJcdTRGNEQsXHU2QzM4XHU0RTBEXHU2NjBFXHU2NTg3XHJcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xyXG4gICAgICAgIGRhZW1vblZlcnNpb246ICdmYWtlLTAuMC4wJywgZGVza3RvcDogdHJ1ZSwgbW9kZWw6IGZha2VQcm92aWRlcnMuZ2V0KGZha2VDaGF0UHJvdmlkZXIpPy5tb2RlbCA/PyAnZmFrZS1tb2RlbCcsXHJcbiAgICAgICAgY2hhdFByb3ZpZGVyOiBmYWtlQ2hhdFByb3ZpZGVyLCBsb2NhbGU6ICd6aCcsXHJcbiAgICAgICAgYnVzeVNlc3Npb25zOiBbLi4uc2Vzc2lvbnMua2V5cygpXS5zbGljZSgwLCAyKSxcclxuICAgICAgICBhcHByb3ZhbFBlbmRpbmc6IHBlbmRpbmcgIT09IG51bGwsXHJcbiAgICAgICAgc2V0dGluZ3M6IHsgYXBwcm92YWw6ICdhc2snIH0sXHJcbiAgICAgICAgd29ya3NwYWNlOiBmYWtlV29ya3NwYWNlcy5pdGVtcy5maW5kKCh3KSA9PiB3LmlkID09PSBmYWtlV29ya3NwYWNlcy5jdXJyZW50KSA/PyBudWxsLFxyXG4gICAgICAgIHByb3ZpZGVyc0RldGFpbDogWy4uLmZha2VQcm92aWRlcnMuZW50cmllcygpXS5tYXAoKFtuYW1lLCBwXSkgPT4gKHtcclxuICAgICAgICAgIG5hbWUsIG1vZGVsOiBwLm1vZGVsLCBiYXNlVXJsOiBwLmJhc2VVcmwsXHJcbiAgICAgICAgICBoYXNLZXk6IHAuYXBpS2V5ICE9PSAnJyxcclxuICAgICAgICAgIGtleVRhaWw6IHAuYXBpS2V5Lmxlbmd0aCA+PSA0ID8gcC5hcGlLZXkuc2xpY2UoLTQpIDogdW5kZWZpbmVkLFxyXG4gICAgICAgICAgcHVycG9zZXM6IFsnY2hhdCddLFxyXG4gICAgICAgIH0pKSxcclxuICAgICAgfSkpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZGVza3RvcC9zaHV0ZG93bicpIHtcclxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlIH0pKTtcclxuICAgICAgc2VydmVyLmNsb3NlKCgpID0+IHByb2Nlc3MuZXhpdCgwKSk7XHJcbiAgICAgIHNldFRpbWVvdXQoKCkgPT4gcHJvY2Vzcy5leGl0KDApLCAxXzAwMCkudW5yZWYoKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2Zha2UvZGllJykge1xyXG4gICAgICAvLyBcdTZENEJcdThCRDVcdTk0QTlcdTVCNTA6XHU2QTIxXHU2MkRGIGhvc3QgXHU1RDI5XHU2RTgzKFx1NTE0OFx1NUU5NFx1N0I1NFx1NTE4RFx1OTAwMFx1NTFGQSxcdTRGRERcdThCQzFcdTU0Q0RcdTVFOTRcdTVERjJcdTUzRDFcdTUxRkEpXHJcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSB9KSk7XHJcbiAgICAgIHNldFRpbWVvdXQoKCkgPT4gcHJvY2Vzcy5leGl0KDEpLCA1MCk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9tb2RlbCcpIHtcclxuICAgICAgLy8gXHU2QTIxXHU1NzhCXHU1MjA3XHU2MzYyKFx1NEUwRSBobWhhcm5lc3MgL2FwaS9tb2RlbCBcdTU0MENcdTVGNjI6XHU1MjA3IGNoYXQgXHU4REVGXHU3NTMxKVxyXG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoKGF3YWl0IHJlYWRCb2R5KCkpIHx8ICd7fScpIGFzIHsgbmFtZT86IHVua25vd24gfTtcclxuICAgICAgICBjb25zdCBuYW1lID0gdHlwZW9mIGJvZHkubmFtZSA9PT0gJ3N0cmluZycgPyBib2R5Lm5hbWUudHJpbSgpIDogJyc7XHJcbiAgICAgICAgaWYgKCFmYWtlUHJvdmlkZXJzLmhhcyhuYW1lKSkge1xyXG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAncHJvdmlkZXIgbm90IGZvdW5kJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XHJcbiAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGZha2VDaGF0UHJvdmlkZXIgPSBuYW1lO1xyXG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlLCBtb2RlbDogZmFrZVByb3ZpZGVycy5nZXQobmFtZSk/Lm1vZGVsIH0pKTtcclxuICAgICAgfSkoKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3Rhc2snKSB7XHJcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoKGF3YWl0IHJlYWRCb2R5KCkpIHx8ICd7fScpIGFzIHsgdGV4dD86IHVua25vd247IHNlc3Npb25JZD86IHVua25vd247IG1vZGU/OiB1bmtub3duOyBhdHRhY2htZW50cz86IHVua25vd247IGltYWdlcz86IHVua25vd24gfTtcclxuICAgICAgICAgIGNvbnN0IHRleHQgPSB0eXBlb2YgYm9keS50ZXh0ID09PSAnc3RyaW5nJyA/IGJvZHkudGV4dCA6ICcnO1xyXG4gICAgICAgICAgY29uc3Qgc2Vzc2lvbklkID0gdHlwZW9mIGJvZHkuc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IGJvZHkuc2Vzc2lvbklkIDogYHdlYi0ke0RhdGUubm93KCkudG9TdHJpbmcoMzYpfWA7XHJcbiAgICAgICAgICBjb25zdCBtb2RlID0gYm9keS5tb2RlID09PSAnYXNrJyB8fCBib2R5Lm1vZGUgPT09ICdhdXRvJyB8fCBib2R5Lm1vZGUgPT09ICd5b2xvJyA/IGJvZHkubW9kZSA6ICdhc2snO1xyXG4gICAgICAgICAgY29uc3QgYXR0YWNobWVudHMgPSBBcnJheS5pc0FycmF5KGJvZHkuYXR0YWNobWVudHMpID8gYm9keS5hdHRhY2htZW50cy5maWx0ZXIoKGEpOiBhIGlzIHN0cmluZyA9PiB0eXBlb2YgYSA9PT0gJ3N0cmluZycpIDogW107XHJcbiAgICAgICAgICAvLyBcdTU2RkVcdTcyNDdcdTk2NDRcdTRFRjY6XHU0RTBFIGhtaGFybmVzcyB2aXNpb24gXHU1MzRGXHU4QkFFXHU1NDBDXHU1RjYyKHtuYW1lLGRhdGFVcmx9KTtmYWtlIFx1NjgyMVx1OUE4Q1x1NUY2Mlx1NzJCNlx1NTM3M1x1NjUzNlxyXG4gICAgICAgICAgY29uc3QgaW1hZ2VzID0gQXJyYXkuaXNBcnJheShib2R5LmltYWdlcylcclxuICAgICAgICAgICAgPyBib2R5LmltYWdlcy5maWx0ZXIoKGltKTogaW0gaXMgeyBuYW1lOiBzdHJpbmc7IGRhdGFVcmw6IHN0cmluZyB9ID0+IHtcclxuICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgaW0gIT09ICdvYmplY3QnIHx8IGltID09PSBudWxsKSByZXR1cm4gZmFsc2U7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBvID0gaW0gYXMgeyBuYW1lPzogdW5rbm93bjsgZGF0YVVybD86IHVua25vd24gfTtcclxuICAgICAgICAgICAgICAgIHJldHVybiB0eXBlb2Ygby5uYW1lID09PSAnc3RyaW5nJyAmJiB0eXBlb2Ygby5kYXRhVXJsID09PSAnc3RyaW5nJyAmJiBvLmRhdGFVcmwuc3RhcnRzV2l0aCgnZGF0YTppbWFnZS8nKTtcclxuICAgICAgICAgICAgICB9KVxyXG4gICAgICAgICAgICA6IFtdO1xyXG4gICAgICAgICAgaWYgKCF0ZXh0KSB7XHJcbiAgICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAndGV4dCByZXF1aXJlZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgICAvLyBcdTRFMEUgaG1oYXJuZXNzIFx1NTQwQ1x1OEJFRFx1NEU0OTpcdTU0MDhcdTZDRDVcdTk2NDRcdTRFRjZcdTRFRTUgW3JlZmVyZW5jZWQgZmlsZXNdIFx1NTI0RFx1N0YwMFx1NUU3Nlx1NTE2NVx1NEVGQlx1NTJBMVx1NjU4N1x1NjcyQztcclxuICAgICAgICAgIC8vIFx1NTZGRVx1NzI0N1x1NEVFNSBbaW1hZ2VzXSBcdTUyNERcdTdGMDBcdTY4MDdcdTZDRThcdTVGMjBcdTY1NzAodmlzaW9uIFx1NjNDRlx1OEZGMFx1OTRGRVx1NTcyOFx1NzcxRlx1NUI5RSBydW50aW1lIFx1OTFDQ1x1NTNEMVx1NzUxRilcclxuICAgICAgICAgIGNvbnN0IGNvbXBvc2VkID0gYXR0YWNobWVudHMubGVuZ3RoID4gMFxyXG4gICAgICAgICAgICA/IGBbcmVmZXJlbmNlZCBmaWxlc11cXG4ke2F0dGFjaG1lbnRzLm1hcCgoYSkgPT4gYC0gJHthLnNwbGl0KC9bXFxcXC9dLykucG9wKCl9YCkuam9pbignXFxuJyl9XFxuXFxuJHt0ZXh0fWBcclxuICAgICAgICAgICAgOiB0ZXh0O1xyXG4gICAgICAgICAgY29uc3Qgd2l0aEltYWdlcyA9IGltYWdlcy5sZW5ndGggPiAwID8gYFtpbWFnZXM6ICR7aW1hZ2VzLmxlbmd0aH1dXFxuJHtjb21wb3NlZH1gIDogY29tcG9zZWQ7XHJcbiAgICAgICAgICBjb25zdCBydW5JZCA9IHJ1blRhc2soc2Vzc2lvbklkLCB3aXRoSW1hZ2VzLCBtb2RlKTtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIHJ1bklkLCBpbWFnZXM6IGltYWdlcy5sZW5ndGggfSkpO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCBTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcclxuICAgICAgICB9XHJcbiAgICAgIH0pKCk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9hcHByb3ZlJykge1xyXG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoKGF3YWl0IHJlYWRCb2R5KCkpIHx8ICd7fScpIGFzIHsgZ3JhbnRlZD86IHVua25vd247IHNlc3Npb25JZD86IHVua25vd24gfTtcclxuICAgICAgICBjb25zdCBzaWQgPSB0eXBlb2YgYm9keS5zZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gYm9keS5zZXNzaW9uSWQgOiAnJztcclxuICAgICAgICBpZiAocGVuZGluZyA9PT0gbnVsbCB8fCAoc2lkICE9PSAnJyAmJiBwZW5kaW5nLnNlc3Npb25JZCAhPT0gc2lkKSkge1xyXG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnbm8gYXBwcm92YWwgcGVuZGluZycsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xyXG4gICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBwID0gcGVuZGluZztcclxuICAgICAgICBwZW5kaW5nID0gbnVsbDtcclxuICAgICAgICBwLnJlc29sdmUoYm9keS5ncmFudGVkID09PSB0cnVlKTtcclxuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgZ3JhbnRlZDogYm9keS5ncmFudGVkID09PSB0cnVlIH0pKTtcclxuICAgICAgfSkoKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUuc3RhcnRzV2l0aCgnL2FwaS9zZXNzaW9ucy8nKSAmJiAodXJsLnBhdGhuYW1lLmVuZHNXaXRoKCcvYXJjaGl2ZScpIHx8IHVybC5wYXRobmFtZS5lbmRzV2l0aCgnL2RlbGV0ZScpKSkge1xyXG4gICAgICAvLyBcdTRGMUFcdThCRERcdTVGNTJcdTY4NjMvXHU1MjIwXHU5NjY0KGhtaGFybmVzcyBcdTU0MENcdTVGNjI6XHU3OUZCXHU1MTY1IGFyY2hpdmUvdHJhc2gsXHU1M0VGXHU2MDYyXHU1OTBELFx1NEUwRFx1Nzg2Q1x1NTIyMClcclxuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHBhcnRzID0gdXJsLnBhdGhuYW1lLnNsaWNlKCcvYXBpL3Nlc3Npb25zLycubGVuZ3RoKS5zcGxpdCgnLycpO1xyXG4gICAgICAgIGNvbnN0IG9wID0gcGFydHNbMV0gPz8gJyc7XHJcbiAgICAgICAgY29uc3Qgb2lkID0gZGVjb2RlVVJJQ29tcG9uZW50KHBhcnRzWzBdID8/ICcnKS5yZXBsYWNlKC9bXmEtekEtWjAtOV86LkAtXS9nLCAnJyk7XHJcbiAgICAgICAgaWYgKG9pZCA9PT0gJycgfHwgKG9wICE9PSAnYXJjaGl2ZScgJiYgb3AgIT09ICdkZWxldGUnKSkge1xyXG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnYmFkIG9wJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XHJcbiAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICghc2Vzc2lvbnMuaGFzKG9pZCkpIHtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3Nlc3Npb24gbm90IGZvdW5kJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XHJcbiAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHNlc3Npb25zLmRlbGV0ZShvaWQpO1xyXG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlIH0pKTtcclxuICAgICAgfSkoKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2luamVjdCcpIHtcclxuICAgICAgLy8gXHU4RkQwXHU4ODRDXHU0RTJEXHU2Q0U4XHU1MTY1KFx1NEUwRSBobWhhcm5lc3MgL2FwaS9pbmplY3QgXHU1NDBDXHU1RjYyO2Zha2UgXHU1M0VBXHU1NkRFXHU2MjY3KVxyXG4gICAgICB2b2lkIHJlYWRCb2R5KCk7XHJcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSB9KSk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9pbnRlcnJ1cHQnKSB7XHJcbiAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKCcnKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjsgLy8gaW50ZXJydXB0IFx1NjVFMCBib2R5IFx1OEJFRFx1NEU0OVxyXG4gICAgICB2b2lkIGJvZHk7XHJcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSB9KSk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3Nlc3Npb25zJykge1xyXG4gICAgICBjb25zdCBsaXN0ID0gWy4uLnNlc3Npb25zLnZhbHVlcygpXS5tYXAoKHMpID0+ICh7XHJcbiAgICAgICAgaWQ6IHMuaWQsIHRpdGxlOiAnJywgdGFzazogJycsIG91dGNvbWU6ICdvaycsIHR1cm5zOiAxLCB0b29sVXNlczogMSxcclxuICAgICAgICB0aW1lOiBzLnVwZGF0ZWRBdCwgY3dkOiAnQzpcXFxcZGVtbycsIGJyYW5jaDogJycsIGNyZWF0ZWRBdDogcy5jcmVhdGVkQXQsIHVwZGF0ZWRBdDogcy51cGRhdGVkQXQsXHJcbiAgICAgIH0pKTtcclxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IHNlc3Npb25zOiBsaXN0LCBuZXh0Q3Vyc29yOiBudWxsIH0pKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZS5zdGFydHNXaXRoKCcvYXBpL3Nlc3Npb25zLycpKSB7XHJcbiAgICAgIGNvbnN0IHNlZyA9IGRlY29kZVVSSUNvbXBvbmVudCh1cmwucGF0aG5hbWUuc2xpY2UoJy9hcGkvc2Vzc2lvbnMvJy5sZW5ndGgpKTtcclxuICAgICAgLy8gXHU1QkZDXHU1MUZBKFx1NEUwRSBobWhhcm5lc3MgL2FwaS9zZXNzaW9ucy86aWQvZXhwb3J0Lm1kIFx1NTQwQ1x1NUY2Mjp0ZXh0L21hcmtkb3duIFx1NEUwQlx1OEY3RClcclxuICAgICAgY29uc3QgZXhwb3J0TWF0Y2ggPSAvXiguKilcXC9leHBvcnRcXC5tZCQvLmV4ZWMoc2VnKSA/PyAvXiguKilcXC5leHBvcnRcXC5tZCQvLmV4ZWMoc2VnKTtcclxuICAgICAgaWYgKGV4cG9ydE1hdGNoICE9PSBudWxsICYmIGV4cG9ydE1hdGNoWzFdICE9PSB1bmRlZmluZWQgJiYgZXhwb3J0TWF0Y2hbMV0gIT09ICcnKSB7XHJcbiAgICAgICAgY29uc3QgZWlkID0gZXhwb3J0TWF0Y2hbMV0ucmVwbGFjZSgvW15hLXpBLVowLTlfOi5ALV0vZywgJycpO1xyXG4gICAgICAgIGNvbnN0IGVzID0gc2Vzc2lvbnMuZ2V0KGVpZCk7XHJcbiAgICAgICAgaWYgKGVzID09PSB1bmRlZmluZWQpIHtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3Nlc3Npb24gbm90IGZvdW5kJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XHJcbiAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAndGV4dC9tYXJrZG93bjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgcmVzLmVuZChgIyBobWhhcm5lc3MgXHU0RjFBXHU4QkREXHU1QkZDXHU1MUZBKGZha2UpXFxuXFxuLSBcdTRGMUFcdThCREQ6JHtlaWR9XFxuXFxuIyMgXHU3NTI4XHU2MjM3XFxuXFxuXHU0RTRCXHU1MjREXHU3Njg0XHU0RUZCXHU1MkExKGZha2UgXHU5ODg0XHU4OUM4KVxcblxcbiMjIFx1NTJBOVx1NjI0Qlxcblxcblx1OEZEOVx1NjYyRlx1NUJGQ1x1NTFGQVx1NzY4NFx1NTZERVx1NTkwRFx1OTg4NFx1ODlDOChmYWtlKVx1MzAwMlxcbmApO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgICAgfVxyXG4gICAgICAvLyBcdTRGMUFcdThCRERcdTk4ODRcdTg5QzgoXHU0RTBFIGhtaGFybmVzcyBHRVQgL2FwaS9zZXNzaW9ucy86aWQgXHU1NDBDXHU1RjYyOlx1NjcwMFx1NTQwRSA4MCBcdTY3NjEsXHU2QkNGXHU2NzYxIDUwMCBcdTVCNTcpXHJcbiAgICAgIGNvbnN0IGlkID0gc2VnLnJlcGxhY2UoL1teYS16QS1aMC05XzouQC1dL2csICcnKTtcclxuICAgICAgY29uc3QgcyA9IHNlc3Npb25zLmdldChpZCk7XHJcbiAgICAgIGlmIChzID09PSB1bmRlZmluZWQpIHtcclxuICAgICAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnc2Vzc2lvbiBub3QgZm91bmQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcclxuICAgICAgICByZXR1cm47XHJcbiAgICAgIH1cclxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XHJcbiAgICAgICAgaWQsIG1vZGVsOiAnZmFrZS1tb2RlbCcsIGN3ZDogJ0M6XFxcXGRlbW8nLFxyXG4gICAgICAgIG1lc3NhZ2VzOiBbXHJcbiAgICAgICAgICB7IHJvbGU6ICd1c2VyJywgdGV4dDogJ1x1NEU0Qlx1NTI0RFx1NzY4NFx1NEVGQlx1NTJBMShmYWtlIFx1OTg4NFx1ODlDOCknLCB0b29sczogW10gfSxcclxuICAgICAgICAgIHsgcm9sZTogJ2Fzc2lzdGFudCcsIHRleHQ6ICdcdThGRDlcdTY2MkZcdTUzODZcdTUzRjJcdTRGMUFcdThCRERcdTc2ODRcdTU2REVcdTU5MERcdTk4ODRcdTg5QzgoZmFrZSlcdTMwMDInLCB0b29sczogWydyZWFkX2ZpbGUnXSB9LFxyXG4gICAgICAgIF0sXHJcbiAgICAgIH0pKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZnMnKSB7XHJcbiAgICAgIC8vIFx1NzZFRVx1NUY1NVx1NkQ0Rlx1ODlDOChcdTRFMEUgaG1oYXJuZXNzIFx1NTQwQ1x1NUY2MjpwYXRoIFx1NzcwMVx1NzU2NT1cdTY4Mzk7ZmlsZXM9MSBcdTk2NDRcdTVFMjZcdTY1ODdcdTRFRjZcdTUyMTdcdTg4NjgpXHJcbiAgICAgIGNvbnN0IHEgPSB1cmwuc2VhcmNoUGFyYW1zLmdldCgncGF0aCcpID8/ICcnO1xyXG4gICAgICBjb25zdCB3aXRoRmlsZXMgPSB1cmwuc2VhcmNoUGFyYW1zLmdldCgnZmlsZXMnKSA9PT0gJzEnO1xyXG4gICAgICBpZiAocSA9PT0gJycpIHtcclxuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xyXG4gICAgICAgICAgcGF0aDogJycsIHNlZ21lbnRzOiBbXSwgcGFyZW50OiAnJyxcclxuICAgICAgICAgIGRpcnM6IFt7IG5hbWU6ICdkZW1vLXdvcmtzcGFjZScsIHBhdGg6ICdDOlxcXFxkZW1vJyB9XSxcclxuICAgICAgICAgIC4uLih3aXRoRmlsZXMgPyB7IGZpbGVzOiBbXSB9IDoge30pLFxyXG4gICAgICAgIH0pKTtcclxuICAgICAgICByZXR1cm47XHJcbiAgICAgIH1cclxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XHJcbiAgICAgICAgcGF0aDogcSwgc2VnbWVudHM6IFt7IG5hbWU6IHEuc3BsaXQoL1tcXFxcL10vKS5maWx0ZXIoQm9vbGVhbikucG9wKCkgPz8gcSwgcGF0aDogcSB9XSwgcGFyZW50OiAnJyxcclxuICAgICAgICBkaXJzOiBbeyBuYW1lOiAnc3JjJywgcGF0aDogYCR7cS5yZXBsYWNlKC9bXFxcXC9dJC8sICcnKX1cXFxcc3JjYCB9XSxcclxuICAgICAgICAuLi4od2l0aEZpbGVzID8geyBmaWxlczogW1xyXG4gICAgICAgICAgeyBuYW1lOiAnUkVBRE1FLm1kJywgcGF0aDogYCR7cS5yZXBsYWNlKC9bXFxcXC9dJC8sICcnKX1cXFxcUkVBRE1FLm1kYCwgcmVsOiAnUkVBRE1FLm1kJyB9LFxyXG4gICAgICAgICAgeyBuYW1lOiAncGFja2FnZS5qc29uJywgcGF0aDogYCR7cS5yZXBsYWNlKC9bXFxcXC9dJC8sICcnKX1cXFxccGFja2FnZS5qc29uYCwgcmVsOiAncGFja2FnZS5qc29uJyB9LFxyXG4gICAgICAgIF0gfSA6IHt9KSxcclxuICAgICAgfSkpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9mcy9yZWFkJykge1xyXG4gICAgICAvLyBcdTY1ODdcdTRFRjZcdTk4ODRcdTg5QzgoNjRLQiBcdTRFMEFcdTk2NTBcdThCRURcdTRFNDk7ZmFrZSBcdThGRDRcdTU2REVcdTU2RkFcdTVCOUFcdTY1ODdcdTY3MkMpXHJcbiAgICAgIGNvbnN0IHAgPSB1cmwuc2VhcmNoUGFyYW1zLmdldCgncGF0aCcpID8/ICcnO1xyXG4gICAgICBpZiAocCA9PT0gJycpIHtcclxuICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAncGF0aCByZXF1aXJlZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgICAgfVxyXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcclxuICAgICAgICBwYXRoOiBwLCByZWw6IHAuc3BsaXQoL1tcXFxcL10vKS5wb3AoKSA/PyBwLCBzaXplOiA0MixcclxuICAgICAgICB0ZXh0OiAnIyBkZW1vIHdvcmtzcGFjZVxcblxcblx1OEZEOVx1NjYyRiBmYWtlIGhvc3QgXHU3Njg0XHU2NTg3XHU0RUY2XHU5ODg0XHU4OUM4XHU1MTg1XHU1QkI5XHUzMDAyXFxuJyxcclxuICAgICAgfSkpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9kaWZmJykge1xyXG4gICAgICAvLyBEaWZmIFx1OTc2Mlx1Njc3RihcdTRFMEUgaG1oYXJuZXNzIC9hcGkvZGlmZiBcdTU0MENcdTVGNjI7ZmFrZSBcdThGRDRcdTU2REVcdTU2RkFcdTVCOUFcdTVDMEZcdTUzRDhcdTY2RjRcdTk2QzYpXHJcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xyXG4gICAgICAgIGdpdDogdHJ1ZSwgY3dkOiAnQzpcXFxcZGVtbycsXHJcbiAgICAgICAgY2hhbmdlZDogW1xyXG4gICAgICAgICAgeyBzdGF0ZTogJ00nLCBwYXRoOiAnc3JjL2FwcC50cycgfSxcclxuICAgICAgICAgIHsgc3RhdGU6ICdBJywgcGF0aDogJ2RvY3Mvbm90ZXMubWQnIH0sXHJcbiAgICAgICAgXSxcclxuICAgICAgICBzdGF0OiAnIHNyYy9hcHAudHMgICAgICB8IDEyICsrKysrKystLS1cXG4gZG9jcy9ub3Rlcy5tZCAgIHwgIDQgKysrK1xcbiAyIGZpbGVzIGNoYW5nZWQsIDE2IGluc2VydGlvbnMoKyksIDMgZGVsZXRpb25zKC0pJyxcclxuICAgICAgfSkpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS93b3Jrc3BhY2VzJykge1xyXG4gICAgICAvLyBcdTVERTVcdTRGNUNcdTUzM0EoXHU0RTBFIGhtaGFybmVzcyBcdTU0MENcdTVGNjI6Y3VycmVudCArIGl0ZW1zKVxyXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcclxuICAgICAgICBjdXJyZW50OiBmYWtlV29ya3NwYWNlcy5jdXJyZW50LFxyXG4gICAgICAgIGl0ZW1zOiBmYWtlV29ya3NwYWNlcy5pdGVtcyxcclxuICAgICAgfSkpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvd29ya3NwYWNlcycpIHtcclxuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7IG5hbWU/OiB1bmtub3duOyBwYXRoPzogdW5rbm93biB9O1xyXG4gICAgICAgIGNvbnN0IHBhdGggPSB0eXBlb2YgYm9keS5wYXRoID09PSAnc3RyaW5nJyA/IGJvZHkucGF0aCA6ICcnO1xyXG4gICAgICAgIGNvbnN0IG5hbWUgPSB0eXBlb2YgYm9keS5uYW1lID09PSAnc3RyaW5nJyAmJiBib2R5Lm5hbWUgIT09ICcnID8gYm9keS5uYW1lIDogKHBhdGguc3BsaXQoL1tcXFxcL10vKS5maWx0ZXIoQm9vbGVhbikucG9wKCkgPz8gJycpO1xyXG4gICAgICAgIGlmIChwYXRoID09PSAnJyB8fCBuYW1lID09PSAnJykge1xyXG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnYWJzb2x1dGUgcGF0aCBhbmQgbmFtZSByZXF1aXJlZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xyXG4gICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoZmFrZVdvcmtzcGFjZXMuaXRlbXMuc29tZSgodykgPT4gdy5wYXRoLnRvTG93ZXJDYXNlKCkgPT09IHBhdGgudG9Mb3dlckNhc2UoKSkpIHtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA5LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3dvcmtzcGFjZSBhbHJlYWR5IHJlZ2lzdGVyZWQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcclxuICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgaXRlbSA9IHsgaWQ6IGB3cy0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDgpfWAsIG5hbWUsIHBhdGggfTtcclxuICAgICAgICBmYWtlV29ya3NwYWNlcy5pdGVtcy5wdXNoKGl0ZW0pO1xyXG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlLCBjdXJyZW50OiBmYWtlV29ya3NwYWNlcy5jdXJyZW50LCBpdGVtczogZmFrZVdvcmtzcGFjZXMuaXRlbXMgfSkpO1xyXG4gICAgICB9KSgpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvd29ya3NwYWNlcy91c2UnKSB7XHJcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgoYXdhaXQgcmVhZEJvZHkoKSkgfHwgJ3t9JykgYXMgeyBpZD86IHVua25vd24gfTtcclxuICAgICAgICBjb25zdCBoaXQgPSBmYWtlV29ya3NwYWNlcy5pdGVtcy5maW5kKCh3KSA9PiB3LmlkID09PSBib2R5LmlkKTtcclxuICAgICAgICBpZiAoaGl0ID09PSB1bmRlZmluZWQpIHtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3dvcmtzcGFjZSBub3QgZm91bmQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcclxuICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgZmFrZVdvcmtzcGFjZXMuY3VycmVudCA9IGhpdC5pZDtcclxuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgY3VycmVudDogZmFrZVdvcmtzcGFjZXMuY3VycmVudCwgaXRlbXM6IGZha2VXb3Jrc3BhY2VzLml0ZW1zIH0pKTtcclxuICAgICAgfSkoKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3Byb3ZpZGVycycpIHtcclxuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7IG5hbWU/OiB1bmtub3duOyBiYXNlVXJsPzogdW5rbm93bjsgbW9kZWw/OiB1bmtub3duOyBhcGlLZXk/OiB1bmtub3duIH07XHJcbiAgICAgICAgY29uc3QgbmFtZSA9IHR5cGVvZiBib2R5Lm5hbWUgPT09ICdzdHJpbmcnID8gYm9keS5uYW1lLnRyaW0oKSA6ICcnO1xyXG4gICAgICAgIGNvbnN0IGJhc2VVcmwgPSB0eXBlb2YgYm9keS5iYXNlVXJsID09PSAnc3RyaW5nJyA/IGJvZHkuYmFzZVVybC50cmltKCkgOiAnJztcclxuICAgICAgICBjb25zdCBtb2RlbCA9IHR5cGVvZiBib2R5Lm1vZGVsID09PSAnc3RyaW5nJyA/IGJvZHkubW9kZWwudHJpbSgpIDogJyc7XHJcbiAgICAgICAgaWYgKG5hbWUgPT09ICcnIHx8IGJhc2VVcmwgPT09ICcnIHx8IG1vZGVsID09PSAnJykge1xyXG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnbmFtZSwgYmFzZVVybCBhbmQgbW9kZWwgYXJlIHJlcXVpcmVkJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XHJcbiAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGZha2VQcm92aWRlcnMuc2V0KG5hbWUsIHsgYmFzZVVybCwgbW9kZWwsIGFwaUtleTogdHlwZW9mIGJvZHkuYXBpS2V5ID09PSAnc3RyaW5nJyA/IGJvZHkuYXBpS2V5IDogJycgfSk7XHJcbiAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIG5hbWUgfSkpO1xyXG4gICAgICB9KSgpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9mcy9zZWFyY2gnKSB7XHJcbiAgICAgIC8vIFx1NURFNVx1NEY1Q1x1NTMzQVx1NjU4N1x1NEVGNlx1NjQxQ1x1N0QyMihcdTRFMEUgaG1oYXJuZXNzIFx1NTQwQ1x1NUY2MjpAXHU5NjQ0XHU0RUY2XHU5MDA5XHU2MkU5XHU1NjY4XHU3Njg0XHU2NTcwXHU2MzZFXHU2RTkwKVxyXG4gICAgICBjb25zdCBxID0gKHVybC5zZWFyY2hQYXJhbXMuZ2V0KCdxJykgPz8gJycpLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xyXG4gICAgICBjb25zdCBhbGwgPSBbXHJcbiAgICAgICAgeyByZWw6ICdSRUFETUUubWQnLCBwYXRoOiAnQzpcXFxcZGVtb1xcXFxSRUFETUUubWQnLCBraW5kOiAnZmlsZScgfSxcclxuICAgICAgICB7IHJlbDogJ3NyYy9hcHAudHMnLCBwYXRoOiAnQzpcXFxcZGVtb1xcXFxzcmNcXFxcYXBwLnRzJywga2luZDogJ2ZpbGUnIH0sXHJcbiAgICAgICAgeyByZWw6ICdkb2NzL25vdGVzLm1kJywgcGF0aDogJ0M6XFxcXGRlbW9cXFxcZG9jc1xcXFxub3Rlcy5tZCcsIGtpbmQ6ICdmaWxlJyB9LFxyXG4gICAgICBdO1xyXG4gICAgICBjb25zdCBoaXRzID0gcSA9PT0gJycgPyBhbGwgOiBhbGwuZmlsdGVyKChmKSA9PiBmLnJlbC50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHEpKTtcclxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IHJlc3VsdHM6IGhpdHMuc2xpY2UoMCwgMjApLCB0cnVuY2F0ZWQ6IGZhbHNlLCB0b3RhbDogaGl0cy5sZW5ndGggfSkpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9jb2duaXRpdmUnKSB7XHJcbiAgICAgIC8vIFx1OEJBNFx1NzdFNVx1NzJCNlx1NjAwMShcdTRFMEUgaG1oYXJuZXNzIGNvZ25pdGl2ZVN0YXR1cyBcdTU0MENcdTVGNjJcdTVCNTBcdTk2QzY7XHU3RjNBXHU2NTcwXHU2MzZFXHU2NjNFXHU1RjBGIG51bGwpXHJcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xyXG4gICAgICAgIG1lbW9yeTogeyBsYXllcnM6IDMsIGVudHJpZXM6IDEyLCBjb250cmFkaWN0aW9uczogMCB9LFxyXG4gICAgICAgIHRyYWplY3RvcmllczogNyxcclxuICAgICAgICBhdWRpdEV2ZW50czogMjEsXHJcbiAgICAgICAgd29ybGRNb2RlbDogeyB2ZXJzaW9uOiA0LCBiZWxpZWZzOiA5LCB0cnVzdGVkOiA1LCBicmllcjogMC4zMSB9LFxyXG4gICAgICAgIGNhbGlicmF0aW9uOiB7IHByZWRpY3Rpb25zOiA0NiwgcmVsaWFiaWxpdHk6IDAuNzIgfSxcclxuICAgICAgfSkpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZmFrZS9lbWl0Jykge1xyXG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7XHJcbiAgICAgICAgICAgIHNlc3Npb25JZDogc3RyaW5nOyBydW5JZDogc3RyaW5nOyBraW5kOiBFdmVudEtpbmQ7IHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xyXG4gICAgICAgICAgfTtcclxuICAgICAgICAgIGNvbnN0IHNlcSA9IGVtaXQoYm9keS5zZXNzaW9uSWQsIGJvZHkucnVuSWQsIGJvZHkua2luZCwgYm9keS5wYXlsb2FkKTtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIHNlcSB9KSk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsIFN0cmluZyhlcnIpLnNsaWNlKDAsIDEyMCksIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xyXG4gICAgICAgIH1cclxuICAgICAgfSkoKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCBgbm8gcm91dGUgJHtyZXEubWV0aG9kfSAke3VybC5wYXRobmFtZX1gLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcclxuICB9KTtcclxuXHJcbiAgYXdhaXQgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xyXG4gICAgc2VydmVyLm9uY2UoJ2Vycm9yJywgcmVqZWN0KTtcclxuICAgIHNlcnZlci5saXN0ZW4oMCwgJzEyNy4wLjAuMScsICgpID0+IHJlc29sdmUoKSk7XHJcbiAgfSk7XHJcbiAgY29uc3QgYWRkcmVzcyA9IHNlcnZlci5hZGRyZXNzKCk7XHJcbiAgaWYgKGFkZHJlc3MgPT09IG51bGwgfHwgdHlwZW9mIGFkZHJlc3MgIT09ICdvYmplY3QnKSB0aHJvdyBuZXcgRXJyb3IoJ2Zha2UgaG9zdDogbm8gcG9ydCcpO1xyXG4gIGNvbnN0IHBvcnQgPSBhZGRyZXNzLnBvcnQ7XHJcblxyXG4gIGlmICghb3B0cy5xdWlldCkge1xyXG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7SlNPTi5zdHJpbmdpZnkoeyBobWhEZXNrdG9wSG9zdFJlYWR5OiB0cnVlLCBwb3J0LCB2ZXJzaW9uOiAnZmFrZS0wLjAuMCcgfSl9XFxuYCk7XHJcbiAgfVxyXG4gIGNvbnN0IGRpZUFmdGVyID0gTnVtYmVyKHByb2Nlc3MuZW52LkZBS0VfSE9TVF9ESUVfQUZURVJfTVMgPz8gMCk7XHJcbiAgaWYgKE51bWJlci5pc0Zpbml0ZShkaWVBZnRlcikgJiYgZGllQWZ0ZXIgPiAwKSB7XHJcbiAgICBzZXRUaW1lb3V0KCgpID0+IHByb2Nlc3MuZXhpdCgxKSwgZGllQWZ0ZXIpLnVucmVmKCk7XHJcbiAgfVxyXG5cclxuICAvLyBjbG9zZSgpOiBcdTUxNDhcdTY1QURcdTVGMDBcdTUxNjhcdTkwRTggU1NFIFx1OEZERVx1NjNBNShcdTVCODNcdTRFRUNcdTZDMzhcdTRFMERcdTgxRUFcdTcxMzZcdTUxNzNcdTk1RUQpLFx1NTQyNlx1NTIxOSBzZXJ2ZXIuY2xvc2VcclxuICAvLyBcdTRGMUFcdTRFMDBcdTc2RjRcdTdCNDlcdTZEM0JcdThEQzNcdThGREVcdTYzQTUsXHU2RDRCXHU4QkQ1XHU4RkRCXHU3QTBCXHU2MzAyXHU2QjdCXHUzMDAyXHJcbiAgY29uc3QgY2xvc2UgPSAoKTogUHJvbWlzZTx2b2lkPiA9PlxyXG4gICAgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUpID0+IHtcclxuICAgICAgZm9yIChjb25zdCBjIG9mIHNzZUNsaWVudHMpIHtcclxuICAgICAgICB0cnkgeyBjLmVuZCgpOyBjLmRlc3Ryb3koKTsgfSBjYXRjaCB7IC8qIGFscmVhZHkgZ29uZSAqLyB9XHJcbiAgICAgIH1cclxuICAgICAgc3NlQ2xpZW50cy5jbGVhcigpO1xyXG4gICAgICBzZXJ2ZXIuY2xvc2UoKCkgPT4gcmVzb2x2ZSgpKTtcclxuICAgICAgc2V0VGltZW91dCgoKSA9PiByZXNvbHZlKCksIDFfMDAwKS51bnJlZigpO1xyXG4gICAgfSk7XHJcblxyXG4gIHJldHVybiB7IHBvcnQsIGVtaXQsIGNsb3NlIH07XHJcbn1cclxuXHJcbi8vIFx1NzZGNFx1NjNBNVx1OEZEMFx1ODg0QyhzdXBlcnZpc29yIHNwYXduIFx1NzY4NFx1NUI1MFx1OEZEQlx1N0EwQlx1NUY2Mlx1NjAwMSlcdTMwMDJyZWFscGF0aCBcdTZCRDRcdThGODM6bnBtIHdvcmtzcGFjZVxyXG4vLyBqdW5jdGlvbiAvIFx1NTkyN1x1NUMwRlx1NTE5OVx1NURFRVx1NUYwMlx1OTBGRFx1NEUwRFx1ODBGRFx1OEJBOVx1OEZEOVx1NEUyQVx1NjhDMFx1NkQ0Qlx1NTkzMVx1NjI0QihcdTU5MzFcdTYyNEI9XHU5NzU5XHU5RUQ4XHU5MDAwXHU1MUZBIGNvZGUgMCxcdTk2QkVcdTY3RTUpXHUzMDAyXHJcbi8vIGNqcyBidW5kbGUoZXNidWlsZCxcdTYyNTNcdTUzMDVcdTRFQTdcdTU0QzEpXHU0RTBCIF9fZmlsZW5hbWUgXHU1QjU4XHU1NzI4O0VTTSh0c3gvXHU2RTkwXHU3ODAxKVx1NzUyOCBpbXBvcnQubWV0YVx1MzAwMlxyXG5jb25zdCBzZWxmVXJsOiBzdHJpbmcgPSB0eXBlb2YgX19maWxlbmFtZSA9PT0gJ3N0cmluZydcclxuICA/IHBhdGhUb0ZpbGVVUkwocmVhbHBhdGhTeW5jKF9fZmlsZW5hbWUpKS5ocmVmXHJcbiAgOiBpbXBvcnQubWV0YS51cmw7XHJcbmNvbnN0IGludm9rZWRBc1NjcmlwdCA9ICgoKSA9PiB7XHJcbiAgaWYgKHByb2Nlc3MuYXJndlsxXSA9PT0gdW5kZWZpbmVkKSByZXR1cm4gZmFsc2U7XHJcbiAgdHJ5IHtcclxuICAgIHJldHVybiBzZWxmVXJsID09PSBwYXRoVG9GaWxlVVJMKHJlYWxwYXRoU3luYyhwcm9jZXNzLmFyZ3ZbMV0pKS5ocmVmO1xyXG4gIH0gY2F0Y2gge1xyXG4gICAgcmV0dXJuIGZhbHNlO1xyXG4gIH1cclxufSkoKTtcclxuaWYgKGludm9rZWRBc1NjcmlwdCkge1xyXG4gIGNvbnN0IHRva2VuID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVE9LRU4gPz8gJyc7XHJcbiAgLy8gRkFLRV9IT1NUX0RJRV9BVF9CT09UPTE6XHU1RjE1XHU1QkZDXHU4ODRDXHU4RjkzXHU1MUZBXHU1MjREXHU1MzczXHU2QjdCKFx1Njc4NFx1OTAyMFx1NTQyRlx1NTJBOFx1NjcxRiBSVU5USU1FX0NSQVNIRUQpXHJcbiAgaWYgKHByb2Nlc3MuZW52LkZBS0VfSE9TVF9ESUVfQVRfQk9PVCA9PT0gJzEnKSB7XHJcbiAgICBwcm9jZXNzLmV4aXQoMSk7XHJcbiAgfVxyXG4gIGNvbnN0IHNsb3cgPSBOdW1iZXIocHJvY2Vzcy5lbnYuRkFLRV9IT1NUX1NMT1dfQUZURVIgPz8gMCk7XHJcbiAgY29uc3QgYm9vdCA9ICgpOiB2b2lkID0+IHtcclxuICAgIHZvaWQgc3RhcnRGYWtlSG9zdCh7IHRva2VuIH0pLmNhdGNoKChlcnIpID0+IHtcclxuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYGZha2UtaG9zdCBmYWlsZWQ6ICR7U3RyaW5nKGVycil9XFxuYCk7XHJcbiAgICAgIHByb2Nlc3MuZXhpdCgxKTtcclxuICAgIH0pO1xyXG4gIH07XHJcbiAgaWYgKE51bWJlci5pc0Zpbml0ZShzbG93KSAmJiBzbG93ID4gMCkgc2V0VGltZW91dChib290LCBzbG93KTtcclxuICBlbHNlIGJvb3QoKTtcclxufVxyXG4iLCAiLyoqXHJcbiAqIFVJVkVSSUZZIFx1OTRBOVx1NUI1MCBcdTIwMTRcdTIwMTQgXHU5MDEwXHU1MjlGXHU4MEZEXHU3NzFGXHU1QjlFIFVJIFx1OUE3MVx1NTJBOFx1OUE4Q1x1NjUzNigyMDI2LTEwLTEwIFx1NzUyOFx1NjIzN1x1NjMwN1x1NEVFNDpcclxuICogXCJcdTVCRjlcdTZCQ0ZcdTRFMDBcdTRFMkFcdTUyOUZcdTgwRkQsXHU2QkNGXHU0RTAwXHU0RTJBXHU0RTFBXHU1MkExXHU2RDQxXHU3QTBCXHU1MTY4XHU5NzYyXHU3Njg0XHU5QThDXHU2NTM2XCIpXHUzMDAyXHJcbiAqXHJcbiAqIFx1NzZGNFx1NjNBNVx1NUJGOVx1NkUzMlx1NjdEM1x1NTQwRVx1NzY4NCBET00gXHU2NUFEXHU4QTAwKFx1NUUwM1x1NUM0MFx1NTFFMFx1NEY1NS9cdTUzRUZcdTg5QzFcdTYwMjcpLFx1NUU3Nlx1NzUyOFx1NTM5Rlx1NzUxRlx1NEU4Qlx1NEVGNlx1OUE3MVx1NTJBOCBSZWFjdFxyXG4gKiAoXHU1M0Q3XHU2M0E3XHU4RjkzXHU1MTY1XHU3NTI4XHU1MzlGXHU1NzhCIHNldHRlciArIGlucHV0IFx1NEU4Qlx1NEVGNjtcdTYzMDlcdTk0QUUgY2xpY2s7XHU5NTJFXHU3NkQ4XHU4RDcwIHdpbmRvd1xyXG4gKiBrZXlkb3duKVx1MzAwMmZha2UgXHU2QTIxXHU1RjBGXHU4REQxXHU1QjhDXHU2NTc0XHU0RUZCXHU1MkExXHU5NEZFKFx1NTNEMVx1OTAwMVx1MjE5Mlx1NURFNVx1NTE3N1x1MjE5Mlx1NUJBMVx1NjI3OVx1MjE5Mlx1NEVBNFx1NEVEOFx1NzI2OVx1MjE5Mlx1NkM0N1x1NjAzQik7XHJcbiAqIHJlYWwgXHU2QTIxXHU1RjBGXHU1M0VBXHU4REQxXHU1M0VBXHU4QkZCXHU1QjUwXHU5NkM2KFx1NEUwRFx1NTJBOFx1NzcxRlx1NUI5RVx1NEYxQVx1OEJERFx1MzAwMVx1NEUwRFx1NzBFNyB0b2tlbilcdTMwMDJcclxuICogXHU2QkNGXHU2QjY1XHU4RjkzXHU1MUZBIGBVSVZFUklGWSBQQVNTfEZBSUwgbmFtZSB8IGRldGFpbGAsXHU3RUQzXHU1QzNFIFNVTU1BUlksZXhpdCBjb2RlXHUzMDAyXHJcbiAqL1xyXG5pbXBvcnQgeyBhcHAsIHR5cGUgQnJvd3NlcldpbmRvdyB9IGZyb20gJ2VsZWN0cm9uJztcclxuaW1wb3J0IHsgbWtkaXIsIHdyaXRlRmlsZSB9IGZyb20gJ25vZGU6ZnMvcHJvbWlzZXMnO1xyXG5pbXBvcnQgeyBqb2luIH0gZnJvbSAnbm9kZTpwYXRoJztcclxuXHJcbmNvbnN0IHNsZWVwID0gKG1zOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+ID0+IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIG1zKSk7XHJcblxyXG5hc3luYyBmdW5jdGlvbiBydW5VaVZlcmlmeSh3aW46IEJyb3dzZXJXaW5kb3csIG1vZGU6ICdmYWtlJyB8ICdyZWFsJyk6IFByb21pc2U8dm9pZD4ge1xyXG4gIGNvbnN0IHNob3RzID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfU0hPVFMgPz8gam9pbihhcHAuZ2V0UGF0aCgndGVtcCcpLCAnaG1oLXVpdmVyaWZ5Jyk7XHJcbiAgYXdhaXQgbWtkaXIoc2hvdHMsIHsgcmVjdXJzaXZlOiB0cnVlIH0pLmNhdGNoKCgpID0+IHVuZGVmaW5lZCk7XHJcbiAgY29uc3QgcmVzdWx0czogQXJyYXk8W3N0cmluZywgYm9vbGVhbiwgc3RyaW5nXT4gPSBbXTtcclxuICBsZXQgc2hvdElkeCA9IDA7XHJcblxyXG4gIGNvbnN0IGpzID0gPFQ+KGNvZGU6IHN0cmluZyk6IFByb21pc2U8VD4gPT4gd2luLndlYkNvbnRlbnRzLmV4ZWN1dGVKYXZhU2NyaXB0KGNvZGUsIHRydWUpIGFzIFByb21pc2U8VD47XHJcbiAgY29uc3Qgc3RlcCA9IGFzeW5jIChuYW1lOiBzdHJpbmcsIGZuOiAoKSA9PiBQcm9taXNlPFtib29sZWFuLCBzdHJpbmddPik6IFByb21pc2U8dm9pZD4gPT4ge1xyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3QgW29rLCBkZXRhaWxdID0gYXdhaXQgZm4oKTtcclxuICAgICAgcmVzdWx0cy5wdXNoKFtuYW1lLCBvaywgZGV0YWlsXSk7XHJcbiAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgY29uc3QgZGV0YWlsID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgJiYgZXJyLnN0YWNrICE9PSB1bmRlZmluZWQgPyBlcnIuc3RhY2sgOiBTdHJpbmcoZXJyKTtcclxuICAgICAgcmVzdWx0cy5wdXNoKFtuYW1lLCBmYWxzZSwgZGV0YWlsLnNsaWNlKDAsIDMwMCldKTtcclxuICAgIH1cclxuICAgIGNvbnN0IGxhc3QgPSByZXN1bHRzW3Jlc3VsdHMubGVuZ3RoIC0gMV0hO1xyXG4gICAgY29uc29sZS5sb2coYFVJVkVSSUZZICR7bGFzdFsxXSA/ICdQQVNTJyA6ICdGQUlMJ30gfCAke2xhc3RbMF19IHwgJHtsYXN0WzJdfWApO1xyXG4gIH07XHJcbiAgLyoqIFx1OEY2RVx1OEJFMlx1NzZGNFx1NTIzMCBwcmVkaWNhdGVDb2RlIFx1OEZENFx1NTZERSB7b2s6dHJ1ZSwuLi59IFx1NjIxNlx1OEQ4NVx1NjVGNihcdThGRDRcdTU2REVcdTY3MDBcdTU0MEVcdTc2ODQgZGV0YWlsKVx1MzAwMiAqL1xyXG4gIGNvbnN0IHdhaXRGb3IgPSBhc3luYyAobGFiZWw6IHN0cmluZywgcHJlZGljYXRlQ29kZTogc3RyaW5nLCB0aW1lb3V0TXM6IG51bWJlcik6IFByb21pc2U8W2Jvb2xlYW4sIHN0cmluZ10+ID0+IHtcclxuICAgIGNvbnN0IHN0YXJ0ZWQgPSBEYXRlLm5vdygpO1xyXG4gICAgZm9yICg7Oykge1xyXG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdHJ5IHsgcmV0dXJuIEpTT04uc3RyaW5naWZ5KChmdW5jdGlvbigpeyAke3ByZWRpY2F0ZUNvZGV9IH0pKCkpOyB9IGNhdGNoKGUpeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe29rOmZhbHNlLCBkZXRhaWw6U3RyaW5nKGUpLnNsaWNlKDAsMTIwKX0pOyB9IH0pKClgKSkgYXMgc3RyaW5nO1xyXG4gICAgICBsZXQgcGFyc2VkOiB7IG9rPzogYm9vbGVhbjsgZGV0YWlsPzogc3RyaW5nIH07XHJcbiAgICAgIHRyeSB7IHBhcnNlZCA9IEpTT04ucGFyc2UocikgYXMgeyBvaz86IGJvb2xlYW47IGRldGFpbD86IHN0cmluZyB9OyB9IGNhdGNoIHsgcGFyc2VkID0geyBvazogZmFsc2UsIGRldGFpbDogU3RyaW5nKHIpLnNsaWNlKDAsIDEyMCkgfTsgfVxyXG4gICAgICBpZiAocGFyc2VkLm9rID09PSB0cnVlKSByZXR1cm4gW3RydWUsIFN0cmluZyhwYXJzZWQuZGV0YWlsID8/ICcnKV07XHJcbiAgICAgIGlmIChEYXRlLm5vdygpIC0gc3RhcnRlZCA+IHRpbWVvdXRNcykgcmV0dXJuIFtmYWxzZSwgYCR7bGFiZWx9OiAke1N0cmluZyhwYXJzZWQuZGV0YWlsID8/ICd0aW1lb3V0Jyl9YF07XHJcbiAgICAgIGF3YWl0IHNsZWVwKDI1MCk7XHJcbiAgICB9XHJcbiAgfTtcclxuICBjb25zdCBzaG90ID0gYXN5bmMgKGxhYmVsOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+ID0+IHtcclxuICAgIHNob3RJZHggKz0gMTtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IGltZyA9IGF3YWl0IHdpbi53ZWJDb250ZW50cy5jYXB0dXJlUGFnZSgpO1xyXG4gICAgICBhd2FpdCB3cml0ZUZpbGUoam9pbihzaG90cywgYCR7bW9kZX0tJHtTdHJpbmcoc2hvdElkeCkucGFkU3RhcnQoMiwgJzAnKX0tJHtsYWJlbH0ucG5nYCksIGltZy50b1BORygpKTtcclxuICAgIH0gY2F0Y2ggeyAvKiBcdTYyMkFcdTU2RkVcdTU5MzFcdThEMjVcdTRFMERcdTUyMjRcdTZCN0IgKi8gfVxyXG4gIH07XHJcblxyXG4gIC8qIC0tLS0gXHU1M0Q3XHU2M0E3XHU4RjkzXHU1MTY1KFJlYWN0Olx1NTM5Rlx1NTc4QiBzZXR0ZXIgXHU4OUU2XHU1M0QxIG9uQ2hhbmdlKSAtLS0tICovXHJcbiAgY29uc3QgdHlwZUludG8gPSAoc2VsOiBzdHJpbmcsIHRleHQ6IHN0cmluZyk6IFByb21pc2U8dW5rbm93bj4gPT5cclxuICAgIGpzKGAoZnVuY3Rpb24oKXtcclxuICAgICAgdmFyIGVsID0gZG9jdW1lbnQucXVlcnlTZWxlY3Rvcigke0pTT04uc3RyaW5naWZ5KHNlbCl9KTtcclxuICAgICAgaWYgKCFlbCkgcmV0dXJuICdOT0VMJztcclxuICAgICAgdmFyIHByb3RvID0gZWwudGFnTmFtZSA9PT0gJ1RFWFRBUkVBJyA/IEhUTUxUZXh0QXJlYUVsZW1lbnQucHJvdG90eXBlIDogSFRNTElucHV0RWxlbWVudC5wcm90b3R5cGU7XHJcbiAgICAgIE9iamVjdC5nZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IocHJvdG8sICd2YWx1ZScpLnNldC5jYWxsKGVsLCAke0pTT04uc3RyaW5naWZ5KHRleHQpfSk7XHJcbiAgICAgIGVsLmRpc3BhdGNoRXZlbnQobmV3IEV2ZW50KCdpbnB1dCcsIHsgYnViYmxlczogdHJ1ZSB9KSk7XHJcbiAgICAgIHJldHVybiAnT0snO1xyXG4gICAgfSkoKWApO1xyXG5cclxuICAvKiAtLS0tIFx1NTQyRlx1NTJBOFx1N0I0OVx1NUY4NTpSZWFjdCBcdTYzMDJcdThGN0QgKyBob3N0IFx1N0VGRlx1NzBCOShyZWFsIFx1NzY4NCBobWhhcm5lc3MgXHU1MUI3XHU1NDJGXHU1MkE4XHU4OTgxXHU3RjE2XHU4QkQxXHJcbiAgICAgXHU2NTc0XHU1OTU3IENMSSBcdTRGOURcdThENTYsXHU1M0VGXHU1MjMwIDMwcys7XHU0RTBEXHU3QjQ5XHU3RUZGXHU3MEI5XHU1QzMxXHU1RjAwXHU4REQxXHU0RjFBXHU1MTY4XHU5MEU4XHU4RDg1XHU2NUY2XHU4QkVGXHU2MkE1KSAtLS0tICovXHJcbiAgYXdhaXQgd2FpdEZvcignaG9zdCByZWFkeScsIGB2YXIgdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY29tcG9zZXIgdGV4dGFyZWEnKTsgcmV0dXJuIHtvazogISF0LCBkZXRhaWw6IHQgPyAnbW91bnRlZCcgOiAnbm8gY29tcG9zZXInfTtgLCAyMF8wMDApO1xyXG4gIGF3YWl0IHdhaXRGb3IoJ2hvc3QgZG90IG9uJywgYHZhciBkPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ob3N0LWRvdCcpOyByZXR1cm4ge29rOiAhIWQgJiYgZC5jbGFzc0xpc3QuY29udGFpbnMoJ29uJyksIGRldGFpbDogZCA/IGQuY2xhc3NOYW1lIDogJ25vIGRvdCd9O2AsIG1vZGUgPT09ICdyZWFsJyA/IDYwXzAwMCA6IDIwXzAwMCk7XHJcbiAgYXdhaXQgc2xlZXAoMV8yMDApOyAvLyBcdTRGMUFcdThCRERcdTUyMTdcdTg4NjgvXHU5ODc2XHU2ODBGXHU2NTcwXHU2MzZFXHU4NDNEXHU1NzMwXHJcblxyXG4gIC8qID09PT09PT09PT0gXHU5MDFBXHU3NTI4Olx1NUUwM1x1NUM0MFx1NTFFMFx1NEY1NShcdTc1MjhcdTYyMzdcdTYyQTVcdTk2OUNcdTc2ODRcdTc2RjRcdTYzQTVcdTY1QURcdThBMDApID09PT09PT09PT0gKi9cclxuICBhd2FpdCBzdGVwKCdcdTVFMDNcdTVDNDA6XHU2ODA3XHU5ODk4XHU2ODBGK1x1NEUwOVx1NjgwRitjb21wb3NlciBcdTU3MjhcdTg5QzZcdTUzRTNcdTUxODUoXHU4RjkzXHU1MTY1XHU2ODQ2XHU1M0VGXHU4OUMxKScsIGFzeW5jICgpID0+IHtcclxuICAgIGNvbnN0IHIgPSAoYXdhaXQganMoYChmdW5jdGlvbigpe1xyXG4gICAgICB2YXIgcSA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IuYmluZChkb2N1bWVudCk7XHJcbiAgICAgIHZhciB0YiA9IHEoJy50aXRsZWJhcicpLCBzaGVsbCA9IHEoJy5hcHAtc2hlbGwnKSwgc2IgPSBxKCcuc2lkZWJhcicpLCB3cyA9IHEoJy53b3Jrc3BhY2UnKSwgdGEgPSBxKCcuY29tcG9zZXIgdGV4dGFyZWEnKTtcclxuICAgICAgdmFyIG1pc3NpbmcgPSBbIXRiICYmICd0aXRsZWJhcicsICFzaGVsbCAmJiAnc2hlbGwnLCAhc2IgJiYgJ3NpZGViYXInLCAhd3MgJiYgJ3dvcmtzcGFjZScsICF0YSAmJiAndGV4dGFyZWEnXS5maWx0ZXIoQm9vbGVhbikuam9pbignLCcpO1xyXG4gICAgICBpZiAobWlzc2luZyAhPT0gJycpIHJldHVybiBKU09OLnN0cmluZ2lmeSh7b2s6ZmFsc2UsIGRldGFpbDonbWlzc2luZzonK21pc3Npbmd9KTtcclxuICAgICAgdmFyIHIgPSB0YS5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKSwgdmggPSB3aW5kb3cuaW5uZXJIZWlnaHQsIHZ3ID0gd2luZG93LmlubmVyV2lkdGg7XHJcbiAgICAgIHZhciBoaW50ID0gcSgnLmVtcHR5LWhpbnQuYmlnJyk7IHZhciBociA9IGhpbnQgPyBoaW50LmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpIDogbnVsbDtcclxuICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHsgb2s6IHIuaGVpZ2h0ID4gMzAgJiYgci5ib3R0b20gPD0gdmggJiYgci53aWR0aCA+IDEwMCAmJiBociAhPT0gbnVsbCAmJiBoci50b3AgPj0gMCAmJiBoci5ib3R0b20gPD0gdmgsXHJcbiAgICAgICAgZGV0YWlsOiAndGV4dGFyZWEgeT0nK01hdGgucm91bmQoci55KSsnIGg9JytNYXRoLnJvdW5kKHIuaGVpZ2h0KSsnIGJvdHRvbT0nK01hdGgucm91bmQoci5ib3R0b20pKycgdmg9Jyt2aCsoaHIgPyAnIGhpbnQgeT0nK01hdGgucm91bmQoaHIueSkgOiAnIG5vLWhpbnQnKSB9KTtcclxuICAgIH0pKClgKSkgYXMgc3RyaW5nO1xyXG4gICAgY29uc3QgcCA9IEpTT04ucGFyc2UocikgYXMgeyBvazogYm9vbGVhbjsgZGV0YWlsOiBzdHJpbmcgfTtcclxuICAgIHJldHVybiBbcC5vayA9PT0gdHJ1ZSwgcC5kZXRhaWxdO1xyXG4gIH0pO1xyXG5cclxuICBpZiAobW9kZSA9PT0gJ2Zha2UnKSB7XHJcbiAgICAvKiA9PT09PT09PT09IGZha2UoXHU1NDExXHU1QkZDXHU2Nzg0XHU5MDIwLEhNSF9ERVNLVE9QX1VJVkVSSUZZX1dJWkFSRD1mYWtlKTpcclxuICAgICAgIFx1NEYyQVx1OTAyMFx1NjcyQVx1OTE0RFx1N0Y2RVx1NjAwMSBcdTIxOTIgXHU1NDExXHU1QkZDXHU1MUZBXHU3M0IwIFx1MjE5MiBcdTY4QzBcdTZENEIoXHU2NzJBXHU4OEM1KVx1MjE5MiBcdTkwMDlcdTYyRTkgXHUyMTkyIFx1NTE4NVx1N0Y2RSBcdTIxOTIgXHU4RkRFXHU0RTBBID09PT09PT09PT0gKi9cclxuICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9XSVpBUkQgPT09ICdmYWtlJykge1xyXG4gICAgICBhd2FpdCBzdGVwKCdcdTU0MTFcdTVCRkM6XHU5OTk2XHU1NDJGXHU1RjM5XHU1MUZBXHU2QjIyXHU4RkNFXHU5ODc1KFx1NUYwMFx1NTlDQlx1OTE0RFx1N0Y2RS9cdTZGMTRcdTc5M0FcdTUxNjVcdTUzRTMpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCd3aXphcmQgb3ZlcmxheScsIGB2YXIgbz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKTtcclxuICAgICAgICAgIHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTVGMDBcdTU5Q0JcdTkxNERcdTdGNkUnO30pO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogISFvICYmICEhYiwgZGV0YWlsOiBvID8gJ292ZXJsYXkrXHU1RjAwXHU1OUNCXHU5MTREXHU3RjZFJyA6ICdubyBvdmVybGF5J307YCwgMTJfMDAwKTtcclxuICAgICAgICBhd2FpdCBzaG90KCd3aXphcmQtd2VsY29tZScpO1xyXG4gICAgICAgIHJldHVybiB3O1xyXG4gICAgICB9KTtcclxuICAgICAgYXdhaXQgc3RlcCgnXHU1NDExXHU1QkZDOlx1NUYwMFx1NTlDQlx1OTE0RFx1N0Y2RVx1MjE5Mlx1NjhDMFx1NkQ0QihcdTRGMkFcdTkwMjBcdTY3MkFcdTg4QzUpXHUyMTkyXHU4MUVBXHU1MkE4XHU4RkRCXHU5MDA5XHU2MkU5XHU5ODc1KFx1NEUwOVx1OTAwOVx1NEUwMCtcdTUxNjhcdTVDNDBcdTkxNERcdTdGNkVcdTYzRDBcdTc5M0EpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NUYwMFx1NTlDQlx1OTE0RFx1N0Y2RSc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdzZWxlY3QgcGFnZScsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2Utc2VsZWN0Jyk7XHJcbiAgICAgICAgICBpZighcCkgcmV0dXJuIHtvazpmYWxzZSwgZGV0YWlsOidub3Qgb24gc2VsZWN0J307XHJcbiAgICAgICAgICB2YXIgdD1wLnRleHRDb250ZW50O1xyXG4gICAgICAgICAgdmFyIG8xPXQuaW5kZXhPZignXHU0RTBCXHU4RjdEXHU1Qjg5XHU4OEM1XHU1QjhDXHU2NTc0IGhtaCBDTEknKT49MCwgbzI9dC5pbmRleE9mKCdcdTRGN0ZcdTc1MjhcdTUxODVcdTdGNkVcdTdDQkVcdTdCODBcdTUxODVcdTY4MzgnKT49MCwgbzM9dC5pbmRleE9mKCdcdThERjNcdThGQzcoXHU2RjE0XHU3OTNBXHU2QTIxXHU1RjBGKScpPj0wLCBub3RlPXQuaW5kZXhPZignLmhtaGFybmVzcycpPj0wO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogbzEmJm8yJiZvMyYmbm90ZSwgZGV0YWlsOiAnb3B0MT0nK28xKycgb3B0Mj0nK28yKycgb3B0Mz0nK28zKycgbm90ZT0nK25vdGV9O2AsIDEyXzAwMCk7XHJcbiAgICAgICAgYXdhaXQgc2hvdCgnd2l6YXJkLXNlbGVjdCcpO1xyXG4gICAgICAgIHJldHVybiB3O1xyXG4gICAgICB9KTtcclxuICAgICAgYXdhaXQgc3RlcCgnXHU1NDExXHU1QkZDOlx1OTAwOVx1NTE4NVx1N0Y2RVx1N0NCRVx1N0I4MFx1NTE4NVx1NjgzOFx1MjE5Mlx1OTE0RFx1N0Y2RVx1OERGM1x1OEZDN1x1MjE5Mlx1NUI4Q1x1NjIxMFx1OTg3NVx1MjE5Mlx1NUYwMFx1NTlDQlx1NEY3Rlx1NzUyOFx1MjE5Mlx1NTE3M1x1OTVFRFx1NEUxNFx1NURGMlx1OEZERVx1NjNBNScsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBvPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vcHQnKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTRGN0ZcdTc1MjhcdTUxODVcdTdGNkVcdTdDQkVcdTdCODBcdTUxODVcdTY4MzgnKT49MDt9KTsgaWYobykgby5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgYXdhaXQgc2xlZXAoMzAwKTtcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTRFMEJcdTRFMDBcdTZCNjUnfHx4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTVGMDBcdTU5Q0JcdTVCODlcdTg4QzUnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICAvLyBcdTkxNERcdTdGNkVcdTk4NzU6ZmFrZSBwcm92aWRlcnMgXHU1REYyXHU2NzA5XHU1QkM2XHU5NEE1IFx1MjE5MiBcdTgxRUFcdTUyQThcdThERjNcdThGQzc7XHU1MTVDXHU1RTk1XHU3MEI5XCJcdThERjNcdThGQzdcIlxyXG4gICAgICAgIGF3YWl0IHdhaXRGb3IoJ2NvbmZpZyBvciBkb25lJywgYHZhciBkPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1kb25lJyk7XHJcbiAgICAgICAgICBpZihkKSByZXR1cm4ge29rOnRydWUsIGRldGFpbDonZG9uZSd9O1xyXG4gICAgICAgICAgdmFyIGM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLWNvbmZpZycpO1xyXG4gICAgICAgICAgaWYoYyl7IHZhciBzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1OERGM1x1OEZDNycpPj0wO30pOyBpZihzKSBzLmNsaWNrKCk7IH1cclxuICAgICAgICAgIHJldHVybiB7b2s6ZmFsc2UsIGRldGFpbDond2FpdGluZyd9O2AsIDE1XzAwMCk7XHJcbiAgICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2RvbmUgcGFnZScsIGB2YXIgZD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtZG9uZScpO1xyXG4gICAgICAgICAgdmFyIHQ9ZD9kLnRleHRDb250ZW50OicnO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogISFkICYmIHQuaW5kZXhPZignXHU1QzMxXHU3RUVBJyk+PTAgJiYgdC5pbmRleE9mKCdcdTUxNzFcdTRFQUInKT49MCwgZGV0YWlsOiB0LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw2MCl9O2AsIDhfMDAwKTtcclxuICAgICAgICBhd2FpdCBzaG90KCd3aXphcmQtZG9uZScpO1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NUYwMFx1NTlDQlx1NEY3Rlx1NzUyOCc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgIGNvbnN0IGNsb3NlZCA9IGF3YWl0IHdhaXRGb3IoJ3dpemFyZCBjbG9zZWQgKyBjb25uZWN0ZWQnLCBgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3ZlcmxheScpICYmICEhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmhvc3QtZG90Lm9uJyksXHJcbiAgICAgICAgICBkZXRhaWw6ICdvdmVybGF5PScrKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3ZlcmxheScpPydvcGVuJzonY2xvc2VkJykrJyBkb3Q9JysoZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmhvc3QtZG90Lm9uJyk/J29uJzonb2ZmJyl9O2AsIDEwXzAwMCk7XHJcbiAgICAgICAgcmV0dXJuIFt3WzBdICYmIGNsb3NlZFswXSwgYGRvbmU6ICR7d1sxXX07ICR7Y2xvc2VkWzFdfWBdO1xyXG4gICAgICB9KTtcclxuICAgIH1cclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU5OTk2XHU4REQxXHU1RjE1XHU1QkZDXHU1QzQyID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1NUYxNVx1NUJGQ1x1NUM0MjpcdTZGMTRcdTc5M0FcdTZBMjFcdTVGMEZcdTYzRDBcdTc5M0FcdTUxRkFcdTczQjBcdTVFNzZcdTUzRUZcdTUxNzNcdTk1RUQnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdndWlkZScsIGB2YXIgZz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcucnVudGltZS1ndWlkZScpOyByZXR1cm4ge29rOiAhIWcsIGRldGFpbDogZyA/ICdzaG93bicgOiAnbm90IHNob3duJ307YCwgOF8wMDApO1xyXG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XHJcbiAgICAgICAgdmFyIGJ0bnMgPSBbXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5ydW50aW1lLWd1aWRlIGJ1dHRvbicpKTtcclxuICAgICAgICB2YXIgYiA9IGJ0bnMuZmluZChmdW5jdGlvbih4KXsgcmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU2RjE0XHU3OTNBJykgPj0gMDsgfSk7XHJcbiAgICAgICAgaWYgKGIpIGIuY2xpY2soKTtcclxuICAgICAgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignZ3VpZGUgZ29uZScsIGByZXR1cm4ge29rOiAhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnJ1bnRpbWUtZ3VpZGUnKSwgZGV0YWlsOiBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcucnVudGltZS1ndWlkZScpID8gJ3N0aWxsJyA6ICdkaXNtaXNzZWQnfTtgLCA1XzAwMCk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREKEN0cmwrTikgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnQ3RybCtOIFx1NjVCMFx1NUVGQVx1NEYxQVx1OEJERCxcdThGOTNcdTUxNjVcdTY4NDZcdTUzRUZcdTc1MjgnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J24nLCBjdHJsS2V5OnRydWUsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcigndGV4dGFyZWEgZW5hYmxlZCcsIGB2YXIgdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY29tcG9zZXIgdGV4dGFyZWEnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXQgJiYgdC5kaXNhYmxlZCA9PT0gZmFsc2UgJiYgKHQucGxhY2Vob2xkZXJ8fCcnKS5pbmRleE9mKCdcdTYzQ0ZcdThGRjBcdTc2RUVcdTY4MDcnKSA+PSAwLCBkZXRhaWw6IHQgPyAoJ2Rpc2FibGVkPScrdC5kaXNhYmxlZCsnIHBoPScrKHQucGxhY2Vob2xkZXJ8fCcnKS5zbGljZSgwLDIwKSkgOiAnbm8gdGEnfTtgLCA1XzAwMCk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU1M0QxXHU5MDAxXHU0RUZCXHU1MkExIFx1MjE5MiBcdTc1MjhcdTYyMzdcdThGNkVcdTUxRkFcdTczQjAoXHU0RTE0XHU0RUM1XHU0RTAwXHU2NzYxLFx1NTNDQ1x1NkQ4OFx1NjA2Rlx1NTZERVx1NUY1MikgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU4RjkzXHU1MTY1XHU1RTc2XHU1M0QxXHU5MDAxXHU0RUZCXHU1MkExLFx1NzUyOFx1NjIzN1x1NkQ4OFx1NjA2Rlx1NEUwQVx1NUM0Rlx1NEUxNFx1NEUwRFx1OTFDRFx1NTkwRCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQgdHlwZUludG8oJy5jb21wb3NlciB0ZXh0YXJlYScsICdcdTlBOENcdTY1MzZcdTRFRkJcdTUyQTE6XHU1MTk5XHU1MTY1XHU0RTAwXHU0RTJBXHU2NTg3XHU0RUY2Jyk7XHJcbiAgICAgIGF3YWl0IHNsZWVwKDIwMCk7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXtcclxuICAgICAgICB2YXIgYnRucyA9IFtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNvbXBvc2VyIGJ1dHRvbicpKTtcclxuICAgICAgICB2YXIgYiA9IGJ0bnMuZmluZChmdW5jdGlvbih4KXsgcmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpID09PSAnXHU1M0QxXHU5MDAxJzsgfSk7XHJcbiAgICAgICAgaWYgKGIpIGIuY2xpY2soKTtcclxuICAgICAgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignZXhhY3RseSBvbmUgdXNlciB0dXJuJywgYHZhciB0cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50dXJuLnVzZXInKSkuZmlsdGVyKGZ1bmN0aW9uKHgpeyByZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTlBOENcdTY1MzZcdTRFRkJcdTUyQTEnKSA+PSAwOyB9KTtcclxuICAgICAgICByZXR1cm4ge29rOiB0cy5sZW5ndGggPT09IDEsIGRldGFpbDogJ2NvdW50PScrdHMubGVuZ3RoKycgdGV4dD0nKyh0c1swXT90c1swXS50ZXh0Q29udGVudC5zbGljZSgwLDMwKTonbm9uZScpfTtgLCA4XzAwMCk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU1REU1XHU1MTc3XHU1MzYxKHJlYWRfZmlsZSBcdTVCOENcdTYyMTApID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1NURFNVx1NTE3N1x1NjI5OFx1NTNFMFx1NTM2MTpyZWFkX2ZpbGUgXHU2MjY3XHU4ODRDXHU1RTc2XHU1QjhDXHU2MjEwJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcigndG9vbCBjYXJkJywgYHZhciBjPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnRvb2wtY2FyZCcpKTtcclxuICAgICAgICB2YXIgZG9uZSA9IGMuZmlsdGVyKGZ1bmN0aW9uKHgpeyByZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdyZWFkX2ZpbGUnKSA+PSAwICYmIHgudGV4dENvbnRlbnQuaW5kZXhPZignIyBkZW1vJykgPj0gMDsgfSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogZG9uZS5sZW5ndGggPj0gMSwgZGV0YWlsOiAnY2FyZHM9JytjLmxlbmd0aCsnIGRvbmU9Jytkb25lLmxlbmd0aH07YCwgOF8wMDApO1xyXG4gICAgICByZXR1cm4gdztcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTVCQTFcdTYyNzlcdTdFQjVcdTUyMDdcdTcyNDcoXHU3NTI4XHU2MjM3XHU2MkE1XHU5NjlDXHU2ODM4XHU1RkMzXHU0RTRCXHU0RTAwKSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTVCQTFcdTYyNzk6YXBwcm92YWwgXHU1MzYxXHU1MUZBXHU3M0IwKFx1N0I0OVx1NUY4NVx1NEVCQVx1NURFNVx1NjI3OVx1NTFDNiknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IHNob3QoJ2FwcHJvdmFsLXBlbmRpbmcnKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2FwcHJvdmFsIGNhcmQnLCBgdmFyIGE9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmFwcHJvdmFsLWNhcmQnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWEgJiYgYS50ZXh0Q29udGVudC5pbmRleE9mKCdcdTk3MDBcdTg5ODFcdTVCQTFcdTYyNzknKSA+PSAwLCBkZXRhaWw6IGEgPyBhLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCwgNjApIDogJ25vIGFwcHJvdmFsIGNhcmQnfTtgLCA4XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ1x1NUJBMVx1NjI3OTpcdTcwQjlcdTYyNzlcdTUxQzYgXHUyMTkyIFx1NEVGQlx1NTJBMVx1N0VFN1x1N0VFRFx1NTIzMFx1NEVBNFx1NEVEOFx1NzI2OStcdTZDNDdcdTYwM0InLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXtcclxuICAgICAgICB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5hcHByb3ZhbC1jYXJkIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpeyByZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU2Mjc5XHU1MUM2JzsgfSk7XHJcbiAgICAgICAgaWYgKGIpIGIuY2xpY2soKTtcclxuICAgICAgfSkoKWApO1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignYXJ0aWZhY3Qrc3VtJywgYHZhciBhcnQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmFydGlmYWN0LWNhcmQnKTtcclxuICAgICAgICB2YXIgc3VtPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy50dXJuLXN1bScpO1xyXG4gICAgICAgIHZhciBhc3Q9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudHVybicpKS5maWx0ZXIoZnVuY3Rpb24oeCl7IHJldHVybiB4LmNsYXNzTmFtZS5pbmRleE9mKCd1c2VyJyk8MCAmJiB4LnRleHRDb250ZW50LmluZGV4T2YoJ2VjaG86Jyk+PTA7IH0pO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYXJ0ICYmICEhc3VtICYmIGFzdC5sZW5ndGg+PTEsIGRldGFpbDogJ2FydGlmYWN0PScrKGFydD9hcnQudGV4dENvbnRlbnQuc2xpY2UoMCwzMCk6J25vbmUnKSsnIHN1bT0nKyhzdW0/c3VtLnRleHRDb250ZW50Oidub25lJykrJyBhbnN3ZXJlZD0nK2FzdC5sZW5ndGh9O2AsIDEyXzAwMCk7XHJcbiAgICAgIGF3YWl0IHNob3QoJ3J1bi1jb21wbGV0ZWQnKTtcclxuICAgICAgcmV0dXJuIHc7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU1Mzg2XHU1M0YyXHU0RjFBXHU4QkREXHU1MTg1XHU1QkI5KFx1NzUyOFx1NjIzN1x1NjJBNVx1OTY5Q1wiXHU3NzBCXHU0RTBEXHU1MjMwXHU1MTg1XHU1QkI5XCIpID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1NzBCOVx1NTFGQlx1NTM4Nlx1NTNGMlx1NEYxQVx1OEJERCBcdTIxOTIgdHJhbnNjcmlwdCBcdTUxODVcdTVCQjlcdTUzRUZcdTg5QzEnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGl0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zZXNzaW9uLWl0ZW0nKTsgaWYgKGl0KSBpdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdoaXN0b3J5IHR1cm5zJywgYHZhciB0cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50dXJuJykpO1xyXG4gICAgICAgIHJldHVybiB7b2s6IHRzLmxlbmd0aCA+PSAyLCBkZXRhaWw6ICd0dXJucz0nK3RzLmxlbmd0aCsnIGZpcnN0PScrKHRzWzBdP3RzWzBdLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw0MCk6J25vbmUnKX07YCwgOF8wMDApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NEU5NFx1OTg3NVx1N0I3RSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdEb2NrOk92ZXJ2aWV3IFx1NjU3MFx1NjM2RVx1ODg0QycsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J092ZXJ2aWV3Jzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdvdmVydmlldyByb3dzJywgYHZhciByb3dzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stcm93JykpO1xyXG4gICAgICAgIHZhciB2ZXIgPSByb3dzLmZpbmQoZnVuY3Rpb24ocil7IHJldHVybiByLnRleHRDb250ZW50LmluZGV4T2YoJ3J1bnRpbWUgXHU3MjQ4XHU2NzJDJyk+PTA7IH0pO1xyXG4gICAgICAgIHJldHVybiB7b2s6IHJvd3MubGVuZ3RoID49IDUgJiYgISF2ZXIsIGRldGFpbDogJ3Jvd3M9Jytyb3dzLmxlbmd0aCsodmVyPycgdmVyPScrdmVyLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw0MCk6JycpfTtgLCA2XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ0RvY2s6RmlsZXMgXHU2RDRGXHU4OUM4K1x1NjU4N1x1NEVGNlx1OTg4NFx1ODlDOCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J1x1NjU4N1x1NEVGNid8fHgudGV4dENvbnRlbnQ9PT0nRmlsZXMnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2ZzIHJvd3MnLCBgdmFyIHJvd3M9ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmZzLXJvdycpLmxlbmd0aDtcclxuICAgICAgICByZXR1cm4ge29rOiByb3dzID49IDEsIGRldGFpbDogJ3Jvd3M9Jytyb3dzfTtgLCA2XzAwMCk7XHJcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgIC8vIFx1NjgzOVx1NzZFRVx1NUY1NVx1NTNFQVx1NjcwOVx1NURFNVx1NEY1Q1x1NTMzQVx1NzZFRVx1NUY1NShmYWtlIFx1NEUwRVx1NzcxRlx1NUI5RSBydW50aW1lIFx1NTQwQ1x1NUY2Mik6XHU1MTQ4XHU4RkRCXHU3NkVFXHU1RjU1LFx1NTE4RFx1NzBCOVx1NjU4N1x1NEVGNlxyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBkPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmZzLXJvdycpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ2RlbW8td29ya3NwYWNlJyk+PTAgfHwgeC50ZXh0Q29udGVudC5pbmRleE9mKCdcdUQ4M0RcdURDQzEnKT49MDt9KTsgaWYoZCkgZC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IHcyID0gYXdhaXQgd2FpdEZvcignZmlsZSByb3dzJywgYHZhciByb3dzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmZzLXJvdycpKTtcclxuICAgICAgICByZXR1cm4ge29rOiByb3dzLnNvbWUoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignUkVBRE1FJyk+PTA7fSksIGRldGFpbDogJ3Jvd3M9Jytyb3dzLmxlbmd0aH07YCwgNl8wMDApO1xyXG4gICAgICBpZiAoIXcyWzBdKSByZXR1cm4gdzI7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGY9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZnMtcm93JykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignUkVBRE1FJyk+PTA7fSk7IGlmKGYpIGYuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignZmlsZSBwcmV2aWV3JywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5mcy1wcmV2aWV3Jyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFwICYmIHAudGV4dENvbnRlbnQuaW5kZXhPZignZGVtbyB3b3Jrc3BhY2UnKSA+PSAwLCBkZXRhaWw6IHAgPyBwLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw0MCkgOiAnbm8gcHJldmlldyd9O2AsIDZfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnRG9jazpEaWZmIFx1NTNEOFx1NjZGNFx1ODg0QycsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J1x1NTNEOFx1NjZGNCd8fHgudGV4dENvbnRlbnQ9PT0nRGlmZic7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignZGlmZiByb3dzJywgYHZhciByb3dzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kaWZmLXJvdycpLmxlbmd0aDtcclxuICAgICAgICByZXR1cm4ge29rOiByb3dzID49IDEsIGRldGFpbDogJ2RpZmYgcm93cz0nK3Jvd3N9O2AsIDZfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnRG9jazpFdmlkZW5jZSBcdThCQTRcdTc3RTVcdTY1NzBcdTYzNkUnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdcdThCQzFcdTYzNkUnfHx4LnRleHRDb250ZW50PT09J0V2aWRlbmNlJzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdldmlkZW5jZSByb3dzJywgYHZhciByb3dzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stcm93JykpO1xyXG4gICAgICAgIHZhciBtZW0gPSByb3dzLmZpbmQoZnVuY3Rpb24ocil7IHJldHVybiByLnRleHRDb250ZW50LmluZGV4T2YoJ1x1OEJCMFx1NUZDNlx1NUM0MicpPj0wIHx8IHIudGV4dENvbnRlbnQuaW5kZXhPZignTWVtb3J5IGxheWVycycpPj0wOyB9KTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIW1lbSAmJiBtZW0udGV4dENvbnRlbnQuaW5kZXhPZignMycpID49IDAsIGRldGFpbDogbWVtID8gbWVtLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykgOiAnbm8gbWVtb3J5IHJvdyd9O2AsIDZfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnRG9jazpMb2dzIFx1OTc2Mlx1Njc3RihcdTdBN0FcdTYwMDFcdTYzRDBcdTc5M0EpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nXHU2NUU1XHU1RkQ3J3x8eC50ZXh0Q29udGVudD09PSdMb2dzJzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdsb2dzIHBhbmUnLCBgdmFyIGw9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmxvZ3MtbGlzdCcpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhbCwgZGV0YWlsOiBsID8gKCdyb3dzPScrbC5xdWVyeVNlbGVjdG9yQWxsKCcubG9nLXJvdycpLmxlbmd0aCkgOiAnbm8gbG9ncyBsaXN0J307YCwgNV8wMDApO1xyXG4gICAgICByZXR1cm4gdztcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpEb2NrOlx1OEZEQ1x1N0EwQlx1OTg3NVx1N0I3RShcdTYyNEJcdTY3M0FcdThGRENcdTdBMEJcdTYzQTdcdTUyMzZcdTk3NjJcdTY3N0YrXHU1RjAwXHU2NzNBXHU4MUVBXHU1NDJGXHU4ODRDKSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdEb2NrOlx1OEZEQ1x1N0EwQlx1OTg3NVx1N0I3RShcdTYyNEJcdTY3M0FcdThGRENcdTdBMEJcdTYzQTdcdTUyMzZcdTk3NjJcdTY3N0YpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nXHU4RkRDXHU3QTBCJ3x8eC50ZXh0Q29udGVudD09PSdSZW1vdGUnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ3JlbW90ZSBwYW5lJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5kb2NrLWJvZHknKTtcclxuICAgICAgICB2YXIgdCA9IHAgPyBwLnRleHRDb250ZW50IDogJyc7XHJcbiAgICAgICAgdmFyIG9rVCA9IHQuaW5kZXhPZignXHU2MjRCXHU2NzNBXHU4RkRDXHU3QTBCXHU2M0E3XHU1MjM2Jyk+PTAgfHwgdC5pbmRleE9mKCdQaG9uZSByZW1vdGUnKT49MDtcclxuICAgICAgICB2YXIgb2tBID0gdC5pbmRleE9mKCdcdTVGMDBcdTY3M0FcdTgxRUFcdTU0MkYnKT49MCB8fCB0LmluZGV4T2YoJ0F1dG9zdGFydCcpPj0wO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhcCAmJiBva1QgJiYgb2tBLCBkZXRhaWw6IHQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDYwKX07YCwgNl8wMDApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NjQxQ1x1N0QyMlx1OEZDN1x1NkVFNCA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTRGMUFcdThCRERcdTY0MUNcdTdEMjI6XHU4RkM3XHU2RUU0XHU3NTFGXHU2NTQ4JywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCBiZWZvcmUgPSAoYXdhaXQganMoYGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGhgKSkgYXMgbnVtYmVyO1xyXG4gICAgICBhd2FpdCB0eXBlSW50bygnLnNlc3Npb24tc2VhcmNoJywgJ3p6ei1cdTRFMERcdTVCNThcdTU3MjhcdTc2ODRcdTRGMUFcdThCREQnKTtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2ZpbHRlcmVkIGVtcHR5JywgYHZhciBuPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGg7XHJcbiAgICAgICAgcmV0dXJuIHtvazogbiA9PT0gMCwgZGV0YWlsOiAnYWZ0ZXI9JytufTtgLCA1XzAwMCk7XHJcbiAgICAgIGF3YWl0IHR5cGVJbnRvKCcuc2Vzc2lvbi1zZWFyY2gnLCAnJyk7XHJcbiAgICAgIGF3YWl0IHNsZWVwKDQwMCk7XHJcbiAgICAgIGNvbnN0IGFmdGVyID0gKGF3YWl0IGpzKGBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoYCkpIGFzIG51bWJlcjtcclxuICAgICAgcmV0dXJuIFt3WzBdICYmIGFmdGVyID09PSBiZWZvcmUsIGAke3dbMV19OyBcdTYwNjJcdTU5MERcdTU0MEUgJHthZnRlcn09PT0ke2JlZm9yZX1gXTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpDdHJsK0sgXHU1NDdEXHU0RUU0XHU5NzYyXHU2NzdGID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ0N0cmwrSyBcdTU0N0RcdTRFRTRcdTk3NjJcdTY3N0Y6XHU2MjUzXHU1RjAwXHU1RTc2XHU2MjY3XHU4ODRDXHU1NDdEXHU0RUU0JywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidrJywgY3RybEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2NtZGsgb3BlbicsIGB2YXIgYz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kaycpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYywgZGV0YWlsOiBjID8gJ29wZW4nIDogJ25vdCBvcGVuJ307YCwgNV8wMDApO1xyXG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBpdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jbWRrLWl0ZW0nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTY1ODdcdTRFRjYnKT49MCB8fCB4LnRleHRDb250ZW50LmluZGV4T2YoJ0ZpbGVzJyk+PTA7fSk7IGlmKGl0KSBpdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCd0YWIgc3dpdGNoZWQnLCBgdmFyIHQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmRvY2stdGFiLmFjdGl2ZScpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhdCAmJiAodC50ZXh0Q29udGVudD09PSdcdTY1ODdcdTRFRjYnfHx0LnRleHRDb250ZW50PT09J0ZpbGVzJyksIGRldGFpbDogJ2FjdGl2ZT0nKyh0P3QudGV4dENvbnRlbnQ6J25vbmUnKX07YCwgNV8wMDApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1OEJCRVx1N0Y2RVx1OTc2Mlx1Njc3RiA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdThCQkVcdTdGNkUoQ3RybCtTaGlmdCtQKTpQcm92aWRlciBcdTg4NjhcdTUzNTVcdTUzRUZcdTg5QzEsRXNjIFx1NTE3M1x1OTVFRCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleToncCcsIGN0cmxLZXk6dHJ1ZSwgc2hpZnRLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdzZXR0aW5ncyBvcGVuJywgYHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrLnNldHRpbmdzJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFzICYmICEhcy5xdWVyeVNlbGVjdG9yKCcucHJvdmlkZXItZm9ybScpLCBkZXRhaWw6IHMgPyAnb3Blbitmb3JtJyA6ICdub3Qgb3Blbid9O2AsIDVfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleTonRXNjYXBlJywgYnViYmxlczp0cnVlfSkpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdzZXR0aW5ncyBjbG9zZWQnLCBgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrLW92ZXJsYXknKSwgZGV0YWlsOiAnY2xvc2VkJ307YCwgNV8wMDApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOmkxOG4gXHU4QkVEXHU4QTAwXHU1MjA3XHU2MzYyID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1OEJFRFx1OEEwMFx1NTIwN1x1NjM2MjpcdTRFMkRcdTY1ODcgXHUyMTkyIEVuZ2xpc2ggXHUyMTkyIFx1NjA2Mlx1NTkwRFx1NEUyRFx1NjU4NycsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleToncCcsIGN0cmxLZXk6dHJ1ZSwgc2hpZnRLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdzZXR0aW5ncyBvcGVuJywgYHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrLnNldHRpbmdzJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFzLCBkZXRhaWw6IHMgPyAnb3BlbicgOiAnbm90IG9wZW4nfTtgLCA1XzAwMCk7XHJcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY21kay5zZXR0aW5ncyBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nRW5nbGlzaCc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBlbiA9IGF3YWl0IHdhaXRGb3IoJ2VuZ2xpc2ggc2hvd24nLCBgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXItaGVhZCAuYnRuLnByaW1hcnknKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWIgJiYgYi50ZXh0Q29udGVudCA9PT0gJysgTmV3IFNlc3Npb24nLCBkZXRhaWw6ICdidG49JysoYj9iLnRleHRDb250ZW50Oidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgICAgYXdhaXQgc2hvdCgnZW5nbGlzaCcpO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNtZGsuc2V0dGluZ3MgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NEUyRFx1NjU4Nyc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCB6aCA9IGF3YWl0IHdhaXRGb3IoJ2NoaW5lc2UgYmFjaycsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhci1oZWFkIC5idG4ucHJpbWFyeScpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYiAmJiBiLnRleHRDb250ZW50ID09PSAnKyBcdTY1QjBcdTVFRkFcdTRGMUFcdThCREQnLCBkZXRhaWw6ICdidG49JysoYj9iLnRleHRDb250ZW50Oidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleTonRXNjYXBlJywgYnViYmxlczp0cnVlfSkpYCk7XHJcbiAgICAgIHJldHVybiBbZW5bMF0gJiYgemhbMF0sIGBlbjogJHtlblsxXX07IHpoOiAke3poWzFdfWBdO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NURFNVx1NEY1Q1x1NTMzQVx1N0JBMVx1NzQwNihcdTVERTZcdTY4MEZcdTY4MEZcdTRGNEQgKyBcdTgzRENcdTUzNTUgKyBcdTY1QjBcdTVFRkFcdTRGMUFcdThCRERcdTkwMDlcdTVERTVcdTRGNUNcdTUzM0EpID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1NURFNVx1NEY1Q1x1NTMzQTpcdTVERTZcdTY4MEZcdTVERTVcdTRGNUNcdTUzM0FcdTY4MEZcdTUzRUZcdTg5QzEoXHU1RjUzXHU1MjREXHU1REU1XHU0RjVDXHU1MzNBXHU1NDBEKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ3dvcmtzcGFjZSBiYXInLCBgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndvcmtzcGFjZS1iYXInKTtcclxuICAgICAgICB2YXIgbiA9IGIgPyAoYi5xdWVyeVNlbGVjdG9yKCcud3MtYmFyLW5hbWUnKXx8e30pLnRleHRDb250ZW50IDogJyc7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFiICYmICEhbiAmJiBuLmxlbmd0aCA+IDAgJiYgbi5pbmRleE9mKCdcdTUyQTBcdThGN0QnKSA8IDAsIGRldGFpbDogJ2Jhcj0nKyhiPyd5ZXMnOidubycpKycgbmFtZT0nK259O2AsIDhfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnXHU1REU1XHU0RjVDXHU1MzNBOlx1ODNEQ1x1NTM1NVx1NUYzOVx1NTFGQSxcdTUyMTdcdTg4NjgrXHU1RjUzXHU1MjREXHU5QUQ4XHU0RUFFK1x1NkRGQlx1NTJBMFx1NTE2NVx1NTNFMztcdTU3MjhcdTYzMDdcdTVCOUFcdTVERTVcdTRGNUNcdTUzM0FcdTY1QjBcdTVFRkFcdTRGMUFcdThCREQnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndvcmtzcGFjZS1iYXInKTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCd3cyBtZW51JywgYHZhciBtPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1tZW51Jyk7XHJcbiAgICAgICAgdmFyIGl0ZW1zID0gbSA/IG0ucXVlcnlTZWxlY3RvckFsbCgnLndzLW1lbnUtaXRlbScpLmxlbmd0aCA6IDA7XHJcbiAgICAgICAgdmFyIGN1ciA9IG0gPyBtLnF1ZXJ5U2VsZWN0b3JBbGwoJy53cy1tZW51LWl0ZW0uY3VycmVudCcpLmxlbmd0aCA6IDA7XHJcbiAgICAgICAgdmFyIGFkZCA9IG0gPyAobS50ZXh0Q29udGVudC5pbmRleE9mKCdcdTZERkJcdTUyQTBcdTVERTVcdTRGNUNcdTUzM0EnKT49MCB8fCBtLnRleHRDb250ZW50LmluZGV4T2YoJ0FkZCB3b3Jrc3BhY2UnKT49MCkgOiBmYWxzZTtcclxuICAgICAgICByZXR1cm4ge29rOiBpdGVtcyA+PSAxICYmIGN1ciA+PSAxICYmIGFkZCwgZGV0YWlsOiAnaXRlbXM9JytpdGVtcysnIGN1cnJlbnQ9JytjdXIrJyBhZGQ9JythZGR9O2AsIDZfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQgc2hvdCgnd3MtbWVudScpO1xyXG4gICAgICAvLyBcdTcwQjlcdTdCMkNcdTRFMDBcdTRFMkFcdTVERTVcdTRGNUNcdTUzM0FcdTk4NzkgPSBcdTU3MjhcdThCRTVcdTVERTVcdTRGNUNcdTUzM0FcdTY1QjBcdTVFRkFcdTRGMUFcdThCREQoXHU4M0RDXHU1MzU1XHU1MTczXHU5NUVEXHUzMDAxY29tcG9zZXIgXHU1M0VGXHU3NTI4KVxyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBpdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtbWVudS1pdGVtJyk7IGlmKGl0KSBpdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IGNsb3NlZCA9IGF3YWl0IHdhaXRGb3IoJ21lbnUgY2xvc2VkICsgc2Vzc2lvbiBhY3RpdmUnLCBgdmFyIHRhPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jb21wb3NlciB0ZXh0YXJlYScpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtbWVudScpICYmICEhdGEgJiYgdGEuZGlzYWJsZWQgPT09IGZhbHNlLCBkZXRhaWw6ICdtZW51PScrKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1tZW51Jyk/J29wZW4nOidjbG9zZWQnKSsnIHRhPScrKHRhP3RhLmRpc2FibGVkOidub25lJyl9O2AsIDZfMDAwKTtcclxuICAgICAgcmV0dXJuIFtjbG9zZWRbMF0sIGAke3dbMV19OyAke2Nsb3NlZFsxXX1gXTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTRGMUFcdThCRERcdTYzMDlcdTVERTVcdTRGNUNcdTUzM0FcdTUyMDZcdTdFQzQgKyBcdTVDNTVcdTVGMDAvXHU2NTM2XHU4RDc3ID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1NEYxQVx1OEJERFx1NTIwNlx1N0VDNDpcdTdFQzRcdTU5MzRcdTUxRkFcdTczQjAoXHU1REU1XHU0RjVDXHU1MzNBXHU1NDBEK1x1NjU3MFx1OTFDRiknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdncm91cCBoZWFkJywgYHZhciBoPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1ncm91cC1oZWFkJyk7XHJcbiAgICAgICAgdmFyIG4gPSBoID8gKGgucXVlcnlTZWxlY3RvcignLndzLWdyb3VwLW5hbWUnKXx8e30pLnRleHRDb250ZW50IDogJyc7XHJcbiAgICAgICAgdmFyIGMgPSBoID8gKGgucXVlcnlTZWxlY3RvcignLndzLWdyb3VwLWNvdW50Jyl8fHt9KS50ZXh0Q29udGVudCA6ICcnO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhaCAmJiBuLmxlbmd0aCA+IDAgJiYgYy5sZW5ndGggPiAwLCBkZXRhaWw6ICduYW1lPScrbisnIGNvdW50PScrY307YCwgOF8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdcdTRGMUFcdThCRERcdTUyMDZcdTdFQzQ6XHU3MEI5XHU1MUZCXHU3RUM0XHU1OTM0XHU2NTM2XHU4RDc3LFx1NTE4RFx1NzBCOVx1NUM1NVx1NUYwMFx1NjA2Mlx1NTkwRCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgYmVmb3JlID0gKGF3YWl0IGpzKGBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoYCkpIGFzIG51bWJlcjtcclxuICAgICAgaWYgKGJlZm9yZSA9PT0gMCkgcmV0dXJuIFtmYWxzZSwgJ25vIHNlc3Npb25zIHRvIGdyb3VwJ107XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGg9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLWdyb3VwLWhlYWQnKTsgaWYoaCkgaC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IGNvbGxhcHNlZCA9IGF3YWl0IHdhaXRGb3IoJ2NvbGxhcHNlZCcsIGB2YXIgZz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtZ3JvdXAnKTtcclxuICAgICAgICB2YXIgaGlkZGVuID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aCA8ICR7YmVmb3JlfTtcclxuICAgICAgICByZXR1cm4ge29rOiBoaWRkZW4sIGRldGFpbDogJ2l0ZW1zPScrZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aCsnIGJlZm9yZT0ke2JlZm9yZX0nfTtgLCA1XzAwMCk7XHJcbiAgICAgIGF3YWl0IHNob3QoJ3dzLWdyb3VwLWNvbGxhcHNlZCcpO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBoPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1ncm91cC1oZWFkJyk7IGlmKGgpIGguY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBleHBhbmRlZCA9IGF3YWl0IHdhaXRGb3IoJ2V4cGFuZGVkIGJhY2snLCBgdmFyIG49ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aDtcclxuICAgICAgICByZXR1cm4ge29rOiBuID49ICR7YmVmb3JlfSwgZGV0YWlsOiAnaXRlbXM9JytufTtgLCA1XzAwMCk7XHJcbiAgICAgIHJldHVybiBbY29sbGFwc2VkWzBdICYmIGV4cGFuZGVkWzBdLCBgY29sbGFwc2U6ICR7Y29sbGFwc2VkWzFdfTsgZXhwYW5kOiAke2V4cGFuZGVkWzFdfWBdO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NUZFQlx1NjM3N1x1OTUyRVx1NUUyRVx1NTJBOVx1OTc2Mlx1Njc3RihDdHJsKy8pID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1NUZFQlx1NjM3N1x1OTUyRVx1NUUyRVx1NTJBOTpDdHJsKy8gXHU2MjUzXHU1RjAwLEVzYyBcdTUxNzNcdTk1RUQnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6Jy8nLCBjdHJsS2V5OnRydWUsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignc2hvcnRjdXRzIG9wZW4nLCBgdmFyIHM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNtZGsnKTtcclxuICAgICAgICB2YXIgcm93cyA9IHMgPyBzLnF1ZXJ5U2VsZWN0b3JBbGwoJy5zaG9ydGN1dC1yb3cnKS5sZW5ndGggOiAwO1xyXG4gICAgICAgIHJldHVybiB7b2s6IHJvd3MgPj0gNSwgZGV0YWlsOiAncm93cz0nK3Jvd3N9O2AsIDVfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQgc2hvdCgnc2hvcnRjdXRzJyk7XHJcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J0VzY2FwZScsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignc2hvcnRjdXRzIGNsb3NlZCcsIGByZXR1cm4ge29rOiAhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNtZGstb3ZlcmxheScpLCBkZXRhaWw6ICdjbG9zZWQnfTtgLCA1XzAwMCk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU0RkE3XHU2ODBGXHU2NTM2XHU3RjI5ICsgXHU3MkI2XHU2MDAxXHU4RkM3XHU2RUU0ID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1NEZBN1x1NjgwRlx1NjUzNlx1N0YyOTpcdTIxRTQgXHU2NTM2XHU4RDc3XHU1REU2XHU2ODBGLFx1MjFFNSBcdTVDNTVcdTVGMDBcdTYwNjJcdTU5MEQnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIC8vIEhJRyBQMyBcdTdFQzQyOlx1MjFFNC9cdTIxRTUgRW1vamkgXHU1REYyXHU2MzYyIFNWRyBpY29uLFx1NjMwOVx1OTRBRVx1NEVFNSBhcmlhLWxhYmVsKFx1NTQyQlwiXHU0RkE3XHU2ODBGXCIpXHU1QjlBXHU0RjREXHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCd0b2dnbGUgYnRuJywgYHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnRvcGJhciBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4gKHguZ2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJyl8fCcnKS5pbmRleE9mKCdcdTRGQTdcdTY4MEYnKT49MDt9KTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWIsIGRldGFpbDogJ2J0bj0nKyhiP2IuZ2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJyk6J25vbmUnKX07YCwgNV8wMDApO1xyXG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnRvcGJhciBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4gKHguZ2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJyl8fCcnKS5pbmRleE9mKCdcdTRGQTdcdTY4MEYnKT49MDt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IGhpZGRlbiA9IGF3YWl0IHdhaXRGb3IoJ3NpZGViYXIgaGlkZGVuJywgYHZhciBzYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhcicpO1xyXG4gICAgICAgIHZhciBnb25lID0gIXNiIHx8IGdldENvbXB1dGVkU3R5bGUoc2IpLmRpc3BsYXkgPT09ICdub25lJztcclxuICAgICAgICByZXR1cm4ge29rOiBnb25lLCBkZXRhaWw6ICdkaXNwbGF5PScrKHNiP2dldENvbXB1dGVkU3R5bGUoc2IpLmRpc3BsYXk6J25vbmUnKX07YCwgNV8wMDApO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnRvcGJhciBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4gKHguZ2V0QXR0cmlidXRlKCdhcmlhLWxhYmVsJyl8fCcnKS5pbmRleE9mKCdcdTRGQTdcdTY4MEYnKT49MDt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IHNob3duID0gYXdhaXQgd2FpdEZvcignc2lkZWJhciBiYWNrJywgYHZhciBzYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhcicpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhc2IgJiYgZ2V0Q29tcHV0ZWRTdHlsZShzYikuZGlzcGxheSAhPT0gJ25vbmUnLCBkZXRhaWw6ICdkaXNwbGF5PScrKHNiP2dldENvbXB1dGVkU3R5bGUoc2IpLmRpc3BsYXk6J25vbmUnKX07YCwgNV8wMDApO1xyXG4gICAgICByZXR1cm4gW2hpZGRlblswXSAmJiBzaG93blswXSwgYGhpZGU6ICR7aGlkZGVuWzFdfTsgc2hvdzogJHtzaG93blsxXX1gXTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnXHU3MkI2XHU2MDAxXHU4RkM3XHU2RUU0Olx1NEUwQlx1NjJDOVx1NTIwN1x1NjM2Mlx1NTIzMFwiXHU4RkQwXHU4ODRDXHU0RTJEXCJcdTRFMERcdTVEMjlcdTZFODNcdTVFNzZcdTYwNjJcdTU5MEQnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHNlbCA9IGF3YWl0IHdhaXRGb3IoJ2ZpbHRlciBzZWxlY3QnLCBgdmFyIHM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnN0YXR1cy1maWx0ZXInKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXMgJiYgcy5vcHRpb25zLmxlbmd0aCA+PSA0LCBkZXRhaWw6ICdvcHRpb25zPScrKHM/cy5vcHRpb25zLmxlbmd0aDowKX07YCwgNV8wMDApO1xyXG4gICAgICBpZiAoIXNlbFswXSkgcmV0dXJuIHNlbDtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgcz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc3RhdHVzLWZpbHRlcicpOyBzLnZhbHVlPSdydW5uaW5nJzsgcy5kaXNwYXRjaEV2ZW50KG5ldyBFdmVudCgnY2hhbmdlJyx7YnViYmxlczp0cnVlfSkpOyB9KSgpYCk7XHJcbiAgICAgIGF3YWl0IHNsZWVwKDUwMCk7XHJcbiAgICAgIGNvbnN0IHIxID0gKGF3YWl0IGpzKGBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoYCkpIGFzIG51bWJlcjtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgcz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc3RhdHVzLWZpbHRlcicpOyBzLnZhbHVlPSdhbGwnOyBzLmRpc3BhdGNoRXZlbnQobmV3IEV2ZW50KCdjaGFuZ2UnLHtidWJibGVzOnRydWV9KSk7IH0pKClgKTtcclxuICAgICAgYXdhaXQgc2xlZXAoNTAwKTtcclxuICAgICAgY29uc3QgcjIgPSAoYXdhaXQganMoYGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGhgKSkgYXMgbnVtYmVyO1xyXG4gICAgICByZXR1cm4gW3IyID49IHIxICYmIHIyID49IDEsIGBydW5uaW5nPSR7cjF9IGFsbD0ke3IyfWBdO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NkEyMVx1NTc4Qlx1OTAwOVx1NjJFOVx1NTY2OChcdTk4NzZcdTY4MEZcdTUyMDdcdTYzNjIgY2hhdCBcdThERUZcdTc1MzEpID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1NkEyMVx1NTc4Qlx1OTAwOVx1NjJFOVx1NTY2ODpcdTk4NzZcdTY4MEZcdTgzRENcdTUzNTVcdTUyMTdcdTUxRkEgcHJvdmlkZXJzIFx1NUU3Nlx1NTNFRlx1NTIwN1x1NjM2MicsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ21vZGVsIGJ1dHRvbicsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudG9wYmFyLW1vZGVsLmFzLWJ1dHRvbicpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYiAmJiBiLmRpc2FibGVkID09PSBmYWxzZSwgZGV0YWlsOiBiID8gYi50ZXh0Q29udGVudCA6ICdub25lJ307YCwgNl8wMDApO1xyXG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy50b3BiYXItbW9kZWwuYXMtYnV0dG9uJyk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBtID0gYXdhaXQgd2FpdEZvcignbW9kZWwgbWVudScsIGB2YXIgbT1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcubW9kZWwtbWVudScpO1xyXG4gICAgICAgIHZhciBpdGVtcyA9IG0gPyBtLnF1ZXJ5U2VsZWN0b3JBbGwoJy53cy1tZW51LWl0ZW0nKS5sZW5ndGggOiAwO1xyXG4gICAgICAgIHZhciBjdXIgPSBtID8gbS5xdWVyeVNlbGVjdG9yQWxsKCcud3MtbWVudS1pdGVtLmN1cnJlbnQnKS5sZW5ndGggOiAwO1xyXG4gICAgICAgIHJldHVybiB7b2s6IGl0ZW1zID49IDIgJiYgY3VyID49IDEsIGRldGFpbDogJ2l0ZW1zPScraXRlbXMrJyBjdXJyZW50PScrY3VyfTtgLCA1XzAwMCk7XHJcbiAgICAgIGlmICghbVswXSkgcmV0dXJuIG07XHJcbiAgICAgIGF3YWl0IHNob3QoJ21vZGVsLW1lbnUnKTtcclxuICAgICAgLy8gXHU1MjA3XHU1MjMwXHU3QjJDXHU0RThDXHU0RTJBIHByb3ZpZGVyKGZha2U6IGRlbW8tdmlzaW9uL2Zha2UtbS12aXNpb24pXHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGl0cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5tb2RlbC1tZW51IC53cy1tZW51LWl0ZW0nKSk7IHZhciBpdD1pdHNbaXRzLmxlbmd0aC0xXTsgaWYoaXQpIGl0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ21vZGVsIHN3aXRjaGVkJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy50b3BiYXItbW9kZWwuYXMtYnV0dG9uJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFiICYmIGIudGV4dENvbnRlbnQuaW5kZXhPZignZmFrZS1tLXZpc2lvbicpID49IDAsIGRldGFpbDogJ2JhZGdlPScrKGI/Yi50ZXh0Q29udGVudDonbm9uZScpfTtgLCA2XzAwMCk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU0RTNCXHU5ODk4KFx1NkQ0NVx1ODI3Mlx1NzUxRlx1NjU0OFx1MjE5Mlx1NjA2Mlx1NTkwRFx1NkRGMVx1ODI3MikgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU0RTNCXHU5ODk4Olx1OEJCRVx1N0Y2RVx1NTIwN1x1NkQ0NVx1ODI3Mlx1NzUxRlx1NjU0OCxcdTYwNjJcdTU5MERcdTZERjFcdTgyNzInLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J3AnLCBjdHJsS2V5OnRydWUsIHNoaWZ0S2V5OnRydWUsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignc2V0dGluZ3Mgb3BlbicsIGB2YXIgcz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kay5zZXR0aW5ncycpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhcywgZGV0YWlsOiBzID8gJ29wZW4nIDogJ25vdCBvcGVuJ307YCwgNV8wMDApO1xyXG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNtZGsuc2V0dGluZ3MgLnNlZyBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU2RDQ1XHU4MjcyJ3x8eC50ZXh0Q29udGVudC50cmltKCk9PT0nTGlnaHQnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgbGlnaHQgPSBhd2FpdCB3YWl0Rm9yKCdsaWdodCB0aGVtZScsIGB2YXIgZHQ9ZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LmRhdGFzZXQudGhlbWU7XHJcbiAgICAgICAgdmFyIGJnID0gZ2V0Q29tcHV0ZWRTdHlsZShkb2N1bWVudC5ib2R5KS5iYWNrZ3JvdW5kQ29sb3I7XHJcbiAgICAgICAgdmFyIG0gPSAvXFxcXGQrL2c7IHZhciBudW1zPShiZy5tYXRjaChtKXx8WycwJywnMCcsJzAnXSkubWFwKE51bWJlcik7XHJcbiAgICAgICAgcmV0dXJuIHtvazogZHQ9PT0nbGlnaHQnICYmIG51bXNbMF0+MjAwICYmIG51bXNbMV0+MjAwICYmIG51bXNbMl0+MjAwLCBkZXRhaWw6ICd0aGVtZT0nK2R0KycgYmc9JytiZ307YCwgNV8wMDApO1xyXG4gICAgICBhd2FpdCBzaG90KCdsaWdodC10aGVtZScpO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNtZGsuc2V0dGluZ3MgLnNlZyBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU2REYxXHU4MjcyJ3x8eC50ZXh0Q29udGVudC50cmltKCk9PT0nRGFyayc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBkYXJrID0gYXdhaXQgd2FpdEZvcignZGFyayBiYWNrJywgYHJldHVybiB7b2s6IGRvY3VtZW50LmRvY3VtZW50RWxlbWVudC5kYXRhc2V0LnRoZW1lPT09J2RhcmsnLCBkZXRhaWw6ICd0aGVtZT0nK2RvY3VtZW50LmRvY3VtZW50RWxlbWVudC5kYXRhc2V0LnRoZW1lfTtgLCA1XzAwMCk7XHJcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J0VzY2FwZScsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICByZXR1cm4gW2xpZ2h0WzBdICYmIGRhcmtbMF0sIGBsaWdodDogJHtsaWdodFsxXX07IGRhcms6ICR7ZGFya1sxXX1gXTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTk4NzZcdTY4MEYgXHU0RTJEL0VOIFx1NUZFQlx1NjM3N1x1NTIwN1x1NjM2MihcdTUzRUZcdTUzRDFcdTczQjBcdTYwMjcpID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1OTg3Nlx1NjgwRlx1NUZFQlx1NjM3N1x1NTIwN1x1NjM2MjpcdTRFMkQvRU4gXHU0RTAwXHU5NTJFXHU1MjA3XHU2MzYyJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignbGFuZyBzZWcnLCBgdmFyIHM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmxhbmctc2VnJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFzICYmIHMucXVlcnlTZWxlY3RvckFsbCgnYnV0dG9uJykubGVuZ3RoID09PSAyLCBkZXRhaWw6IHMgPyAncHJlc2VudCcgOiAnYWJzZW50J307YCwgNV8wMDApO1xyXG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmxhbmctc2VnIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdFTic7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBlbiA9IGF3YWl0IHdhaXRGb3IoJ2VuZ2xpc2gnLCBgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXItaGVhZCAuYnRuLnByaW1hcnknKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWIgJiYgYi50ZXh0Q29udGVudCA9PT0gJysgTmV3IFNlc3Npb24nLCBkZXRhaWw6ICdidG49JysoYj9iLnRleHRDb250ZW50Oidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5sYW5nLXNlZyBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU0RTJEJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IHpoID0gYXdhaXQgd2FpdEZvcignY2hpbmVzZSBiYWNrJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyLWhlYWQgLmJ0bi5wcmltYXJ5Jyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFiICYmIGIudGV4dENvbnRlbnQgPT09ICcrIFx1NjVCMFx1NUVGQVx1NEYxQVx1OEJERCcsIGRldGFpbDogJ2J0bj0nKyhiP2IudGV4dENvbnRlbnQ6J25vbmUnKX07YCwgNV8wMDApO1xyXG4gICAgICByZXR1cm4gW2VuWzBdICYmIHpoWzBdLCBgZW46ICR7ZW5bMV19OyB6aDogJHt6aFsxXX1gXTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTdDOThcdThEMzRcdTU2RkVcdTcyNDcgXHUyMTkyIFx1N0YyOVx1NzU2NVx1NTZGRSBjaGlwIFx1MjE5MiBcdTUzRDFcdTkwMDEgXHUyMTkyIHJ1bnRpbWUgXHU2NTM2XHU1MjMwID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1N0M5OFx1OEQzNFx1NTZGRVx1NzI0NzpcdTdGMjlcdTc1NjVcdTU2RkUgY2hpcCArIFx1NTNEMVx1OTAwMVx1NTQwRSBydW50aW1lIFx1NjUzNlx1NTIzMFx1NTZGRVx1NzI0NycsIGFzeW5jICgpID0+IHtcclxuICAgICAgLy8gXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREXHU3ODZFXHU0RkREIGNvbXBvc2VyIFx1NTNFRlx1NzUyOFxyXG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OiduJywgY3RybEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgYXdhaXQgc2xlZXAoMzAwKTtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpe1xyXG4gICAgICAgIHZhciB0YSA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jb21wb3NlciB0ZXh0YXJlYScpO1xyXG4gICAgICAgIGlmICghdGEpIHJldHVybjtcclxuICAgICAgICB2YXIgYyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2NhbnZhcycpO1xyXG4gICAgICAgIGMud2lkdGggPSA4OyBjLmhlaWdodCA9IDg7XHJcbiAgICAgICAgdmFyIGN0eCA9IGMuZ2V0Q29udGV4dCgnMmQnKTtcclxuICAgICAgICBjdHguZmlsbFN0eWxlID0gJyMzZjk2NTAnOyBjdHguZmlsbFJlY3QoMCwgMCwgOCwgOCk7XHJcbiAgICAgICAgYy50b0Jsb2IoZnVuY3Rpb24oYmxvYil7XHJcbiAgICAgICAgICB2YXIgZHQgPSBuZXcgRGF0YVRyYW5zZmVyKCk7XHJcbiAgICAgICAgICBkdC5pdGVtcy5hZGQobmV3IEZpbGUoW2Jsb2JdLCAncGFzdGVkLnBuZycsIHt0eXBlOiAnaW1hZ2UvcG5nJ30pKTtcclxuICAgICAgICAgIHRhLmRpc3BhdGNoRXZlbnQobmV3IENsaXBib2FyZEV2ZW50KCdwYXN0ZScsIHtjbGlwYm9hcmREYXRhOiBkdCwgYnViYmxlczogdHJ1ZSwgY2FuY2VsYWJsZTogdHJ1ZX0pKTtcclxuICAgICAgICB9LCAnaW1hZ2UvcG5nJyk7XHJcbiAgICAgIH0pKClgKTtcclxuICAgICAgY29uc3QgY2hpcCA9IGF3YWl0IHdhaXRGb3IoJ2ltYWdlIGNoaXAnLCBgdmFyIG49ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmF0dC1jaGlwLmltZycpLmxlbmd0aDtcclxuICAgICAgICByZXR1cm4ge29rOiBuID49IDEsIGRldGFpbDogJ2ltZyBjaGlwcz0nK259O2AsIDZfMDAwKTtcclxuICAgICAgaWYgKCFjaGlwWzBdKSByZXR1cm4gY2hpcDtcclxuICAgICAgYXdhaXQgdHlwZUludG8oJy5jb21wb3NlciB0ZXh0YXJlYScsICdcdTc3MEJcdThGRDlcdTVGMjBcdTU2RkUnKTtcclxuICAgICAgYXdhaXQgc2xlZXAoMjAwKTtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jb21wb3NlciBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1M0QxXHU5MDAxJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IGRvbmUgPSBhd2FpdCB3YWl0Rm9yKCdpbWFnZSBzZW50JywgYFxyXG4gICAgICAgIHZhciBhcCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5hcHByb3ZhbC1jYXJkIGJ1dHRvbicpO1xyXG4gICAgICAgIGlmIChhcCAmJiBhcC50ZXh0Q29udGVudC50cmltKCkuaW5kZXhPZignXHU2Mjc5XHU1MUM2Jyk+PTApIGFwLmNsaWNrKCk7XHJcbiAgICAgICAgdmFyIHRzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnR1cm4nKSk7XHJcbiAgICAgICAgdmFyIGhpdCA9IHRzLmZpbHRlcihmdW5jdGlvbih4KXsgcmV0dXJuIHguY2xhc3NOYW1lLmluZGV4T2YoJ3VzZXInKTwwICYmIHgudGV4dENvbnRlbnQuaW5kZXhPZignW2ltYWdlczogMV0nKSA+PSAwOyB9KTtcclxuICAgICAgICByZXR1cm4ge29rOiBoaXQubGVuZ3RoID49IDEsIGRldGFpbDogJ3J1bnRpbWUtZWNoby13aXRoLWltYWdlPScraGl0Lmxlbmd0aH07XHJcbiAgICAgIGAsIDE1XzAwMCk7XHJcbiAgICAgIGF3YWl0IHNob3QoJ3Bhc3RlZC1pbWFnZScpO1xyXG4gICAgICByZXR1cm4gZG9uZTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdUQ4M0RcdURDQ0UgXHU0RTBBXHU0RjIwL1x1RDgzRFx1RENDMSBcdTZENEZcdTg5QzhcdTYzMDlcdTk0QUVcdTVDMzFcdTRGNEQgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU5NjQ0XHU0RUY2XHU0RTBFXHU3NkVFXHU1RjU1XHU1MTY1XHU1M0UzOlx1RDgzRFx1RENDRSBcdTRFMEFcdTRGMjAgKyBcdUQ4M0RcdURDQzEgXHU2RDRGXHU4OUM4XHU2MzA5XHU5NEFFXHU1QjU4XHU1NzI4JywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKGAoZnVuY3Rpb24oKXtcclxuICAgICAgICB2YXIgdXAgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY29tcG9zZXIgYnV0dG9uW2FyaWEtbGFiZWwqPVwiXHU0RTBBXHU0RjIwXCJdLCAuY29tcG9zZXIgYnV0dG9uW2FyaWEtbGFiZWwqPVwiVXBsb2FkXCJdJyk7XHJcbiAgICAgICAgdmFyIGJyID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLXBpY2tlciBidXR0b24nKTtcclxuICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe3VwOiAhIXVwLCBicm93c2U6ICEhYnJ9KTtcclxuICAgICAgfSkoKWApKSBhcyBzdHJpbmc7XHJcbiAgICAgIGNvbnN0IHAgPSBKU09OLnBhcnNlKHIpIGFzIHsgdXA6IGJvb2xlYW47IGJyb3dzZTogYm9vbGVhbiB9O1xyXG4gICAgICByZXR1cm4gW3AudXAgJiYgcC5icm93c2UsIGBcdUQ4M0RcdURDQ0U9JHtwLnVwfSBcdUQ4M0RcdURDQzE9JHtwLmJyb3dzZX1gXTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpAIFx1OTY0NFx1NEVGNlx1OTAwOVx1NjJFOVx1NTY2OCA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdAIFx1OTY0NFx1NEVGNjpcdTkwMDlcdTYyRTlcdTU2NjhcdTUxRkFcdTczQjBcdTVFNzZcdTUzRUZcdTkwMDlcdTY1ODdcdTRFRjYnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY29tcG9zZXIgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J0AnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2F0dCBwaWNrZXInLCBgdmFyIHA9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmF0dC1waWNrZXInKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXAsIGRldGFpbDogcCA/ICdvcGVuJyA6ICdub3Qgb3Blbid9O2AsIDVfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQgdHlwZUludG8oJy5hdHQtcGlja2VyIGlucHV0JywgJ3JlYWQnKTtcclxuICAgICAgY29uc3QgdzIgPSBhd2FpdCB3YWl0Rm9yKCdhdHQgcmVzdWx0cycsIGB2YXIgcj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuYXR0LXJlc3VsdHMgLmZzLXJvdycpLmxlbmd0aDtcclxuICAgICAgICByZXR1cm4ge29rOiByID49IDEsIGRldGFpbDogJ3Jlc3VsdHM9JytyfTtgLCA2XzAwMCk7XHJcbiAgICAgIGlmICghdzJbMF0pIHJldHVybiB3MjtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgZj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuYXR0LXJlc3VsdHMgLmZzLXJvdycpOyBpZihmKSBmLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2F0dCBjaGlwJywgYHZhciBjPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5hdHQtY2hpcCcpLmxlbmd0aDtcclxuICAgICAgICByZXR1cm4ge29rOiBjID49IDEsIGRldGFpbDogJ2NoaXBzPScrY307YCwgNV8wMDApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlKFx1NTQxMVx1NUJGQ1x1Njc4NFx1OTAyMCk6XHU4QkJFXHU3RjZFXHUzMDBDXHU5MUNEXHU2NUIwXHU5MTREXHU3RjZFXHUzMDBEXHU5MUNEXHU1MTY1ICsgXHU5MDA5XHU2MkU5XHU2MzAxXHU0RTQ1ID09PT09PT09PT0gKi9cclxuICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9XSVpBUkQgPT09ICdmYWtlJykge1xyXG4gICAgICBhd2FpdCBzdGVwKCdcdTU0MTFcdTVCRkM6XHU4QkJFXHU3RjZFXHUzMDBDXHU5MUNEXHU2NUIwXHU5MTREXHU3RjZFXHUzMDBEXHU5MUNEXHU1MTY1ICsgXHU5MDA5XHU2MkU5XHU2MzAxXHU0RTQ1KHdpemFyZC5qc29uKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidwJywgY3RybEtleTp0cnVlLCBzaGlmdEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgICBjb25zdCBvcGVuID0gYXdhaXQgd2FpdEZvcignc2V0dGluZ3Mgb3BlbicsIGB2YXIgcz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kay5zZXR0aW5ncycpO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogISFzLCBkZXRhaWw6IHMgPyAnb3BlbicgOiAnY2xvc2VkJ307YCwgNV8wMDApO1xyXG4gICAgICAgIGlmICghb3BlblswXSkgcmV0dXJuIG9wZW47XHJcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jbWRrLnNldHRpbmdzIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1OTFDRFx1NjVCMFx1OTE0RFx1N0Y2RScpPj0wO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICBjb25zdCBzaG93biA9IGF3YWl0IHdhaXRGb3IoJ3dpemFyZCByZW9wZW5lZCcsIGByZXR1cm4ge29rOiAhIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3ZlcmxheScpLFxyXG4gICAgICAgICAgZGV0YWlsOiBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKSA/ICdvcGVuJyA6ICdjbG9zZWQnfTtgLCA1XzAwMCk7XHJcbiAgICAgICAgaWYgKCFzaG93blswXSkgcmV0dXJuIHNob3duO1xyXG4gICAgICAgIGF3YWl0IHNob3QoJ3dpemFyZC1yZWVudHJ5Jyk7XHJcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1M0Q2XHU2RDg4Jzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgY29uc3QgY2xvc2VkID0gYXdhaXQgd2FpdEZvcignd2l6YXJkIGNsb3NlZCcsIGByZXR1cm4ge29rOiAhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1vdmVybGF5JyksIGRldGFpbDogJ2Nsb3NlZCd9O2AsIDVfMDAwKTtcclxuICAgICAgICBjb25zdCBzdCA9IChhd2FpdCBqcyhgd2luZG93LmhtaC5nZXRXaXphcmQoKS50aGVuKGZ1bmN0aW9uKHIpe3JldHVybiBKU09OLnN0cmluZ2lmeShyKTt9KWApKSBhcyBzdHJpbmc7XHJcbiAgICAgICAgY29uc3QgcCA9IEpTT04ucGFyc2Uoc3QpIGFzIHsgcGVyc2lzdGVkPzogeyBkb25lPzogYm9vbGVhbjsgY2hvaWNlPzogc3RyaW5nIH0gfTtcclxuICAgICAgICBjb25zdCBwZXJzaXN0ZWQgPSBwLnBlcnNpc3RlZD8uZG9uZSA9PT0gdHJ1ZSAmJiBwLnBlcnNpc3RlZD8uY2hvaWNlID09PSAnYnVuZGxlZCc7XHJcbiAgICAgICAgcmV0dXJuIFtjbG9zZWRbMF0gJiYgcGVyc2lzdGVkLCBgY2xvc2VkPSR7Y2xvc2VkWzBdfSBwZXJzaXN0ZWQ9JHtKU09OLnN0cmluZ2lmeShwLnBlcnNpc3RlZCA/PyBudWxsKX1gXTtcclxuICAgICAgfSk7XHJcbiAgICB9XHJcblxyXG4gICAgYXdhaXQgc2hvdCgnZmluYWwnKTtcclxuICB9IGVsc2UgaWYgKChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9XSVpBUkQgPz8gJycpICE9PSAnJykge1xyXG4gICAgLyogPT09PT09PT09PSByZWFsKFx1NTQxMVx1NUJGQ1x1Njc4NFx1OTAyMCxcdTRFOTJcdTY1QTVcdTRFOEVcdTVFMzhcdTg5QzQgcmVhbCBcdTZCNjVcdTlBQTQpOlxyXG4gICAgICAgV1oyIFx1NjcyQ1x1NjczQVx1NzcxRlx1NUI5RVx1NjhDMFx1NkQ0QihcdTlFRDhcdThCQTRcdTUxNzFcdTRFQUJcdTk4NzUpLyBXWjMgXHU0RTBCXHU4RjdEXHU1Qjg5XHU4OEM1XHU1QjlFXHU2RDRCID09PT09PT09PT0gKi9cclxuICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9XSVpBUkQgPT09ICdkZXRlY3QnKSB7XHJcbiAgICAgIGF3YWl0IHN0ZXAoJ1x1NTQxMVx1NUJGQyhcdTc3MUZcdTVCOUUpOlx1NkIyMlx1OEZDRVx1MjE5Mlx1NjhDMFx1NkQ0Qlx1NTIzMFx1NjcyQ1x1NjczQVx1NURGMlx1ODhDNSBDTEkoXHU5RUQ4XHU4QkE0XHU1MTcxXHU0RUFCLFx1NTJGRVx1OTAwOVx1NkI2M1x1Nzg2RSknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3dpemFyZCBvdmVybGF5JywgYHZhciBvPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3ZlcmxheScpO1xyXG4gICAgICAgICAgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NUYwMFx1NTlDQlx1OTE0RFx1N0Y2RSc7fSk7XHJcbiAgICAgICAgICByZXR1cm4ge29rOiAhIW8gJiYgISFiLCBkZXRhaWw6IG8gPyAnb3ZlcmxheStcdTVGMDBcdTU5Q0JcdTkxNERcdTdGNkUnIDogJ25vIG92ZXJsYXknfTtgLCAxMl8wMDApO1xyXG4gICAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgICAgYXdhaXQgc2hvdCgnd2l6YXJkLXJlYWwtd2VsY29tZScpO1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NUYwMFx1NTlDQlx1OTE0RFx1N0Y2RSc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgIGNvbnN0IGZvdW5kID0gYXdhaXQgd2FpdEZvcignZGV0ZWN0IGZvdW5kJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1kZXRlY3QnKTtcclxuICAgICAgICAgIGlmKCFwKSByZXR1cm4ge29rOmZhbHNlLCBkZXRhaWw6J2RldGVjdCBwYWdlIG5vdCBzaG93bid9O1xyXG4gICAgICAgICAgdmFyIHQ9cC50ZXh0Q29udGVudDtcclxuICAgICAgICAgIHZhciBvazE9dC5pbmRleE9mKCdcdTY4QzBcdTZENEJcdTUyMzBcdTVERjJcdTVCODlcdTg4QzUgaG1oYXJuZXNzIHYnKT49MDtcclxuICAgICAgICAgIHZhciBvazI9dC5pbmRleE9mKCdcdTlFRDhcdThCQTRcdTUxNzFcdTRFQUJcdTRGN0ZcdTc1MjhcdTVCODMoXHU2M0E4XHU4MzUwKScpPj0wO1xyXG4gICAgICAgICAgdmFyIHJhZGlvPXAucXVlcnlTZWxlY3RvcignLndpemFyZC1vcHQub24nKTtcclxuICAgICAgICAgIHJldHVybiB7b2s6IG9rMSYmb2syJiYhIXJhZGlvLCBkZXRhaWw6IHQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDkwKX07YCwgMjBfMDAwKTtcclxuICAgICAgICBhd2FpdCBzaG90KCd3aXphcmQtcmVhbC1kZXRlY3QnKTtcclxuICAgICAgICByZXR1cm4gZm91bmQ7XHJcbiAgICAgIH0pO1xyXG4gICAgfSBlbHNlIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9XSVpBUkQgPT09ICdpbnN0YWxsJykge1xyXG4gICAgICBhd2FpdCBzdGVwKCdcdTU0MTFcdTVCRkMoXHU3NzFGXHU1QjlFKTpcdTY4QzBcdTZENEJcdTIxOTJcdTRFQ0RcdTg5ODFcdTRFMEJcdThGN0RcdTY1QjBcdTcyNDhcdTIxOTJcdTkwMDlcdTYyRTlcdTI0NjBcdTIxOTJcdThGREJcdTUxNjVcdTVCODlcdTg4QzVcdTk4NzUnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3dpemFyZCBvdmVybGF5JywgYHZhciBvPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3ZlcmxheScpO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogISFvLCBkZXRhaWw6IG8gPyAnb3BlbicgOiAnY2xvc2VkJ307YCwgMTJfMDAwKTtcclxuICAgICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NUYwMFx1NTlDQlx1OTE0RFx1N0Y2RSc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgIGNvbnN0IGZvdW5kID0gYXdhaXQgd2FpdEZvcignZGV0ZWN0IGZvdW5kJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1kZXRlY3QnKTtcclxuICAgICAgICAgIHJldHVybiB7b2s6ICEhcCAmJiBwLnRleHRDb250ZW50LmluZGV4T2YoJ1x1NjhDMFx1NkQ0Qlx1NTIzMFx1NURGMlx1NUI4OVx1ODhDNSBobWhhcm5lc3MgdicpPj0wLCBkZXRhaWw6IHAgPyBwLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw2MCkgOiAnbm8gZGV0ZWN0IHBhZ2UnfTtgLCAyMF8wMDApO1xyXG4gICAgICAgIGlmICghZm91bmRbMF0pIHJldHVybiBmb3VuZDtcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBvPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vcHQnKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTRFQ0RcdTg5ODFcdTRFMEJcdThGN0RcdTY1QjBcdTcyNDgnKT49MDt9KTsgaWYobykgby5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgYXdhaXQgc2xlZXAoMjAwKTtcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTRFMEJcdTRFMDBcdTZCNjUnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICBjb25zdCBzZWwgPSBhd2FpdCB3YWl0Rm9yKCdzZWxlY3QgcGFnZSBcdTI0NjAgb24nLCBgdmFyIHA9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLXNlbGVjdCcpO1xyXG4gICAgICAgICAgdmFyIG9uPXA/cC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW9wdC5vbicpOm51bGw7XHJcbiAgICAgICAgICByZXR1cm4ge29rOiAhIXAgJiYgISFvbiAmJiBvbi50ZXh0Q29udGVudC5pbmRleE9mKCdcdTRFMEJcdThGN0RcdTVCODlcdTg4QzVcdTVCOENcdTY1NzQgaG1oIENMSScpPj0wLCBkZXRhaWw6IHAgPyAnc2VsZWN0IFx1MjQ2MCBvbicgOiAnbm8gc2VsZWN0J307YCwgOF8wMDApO1xyXG4gICAgICAgIGlmICghc2VsWzBdKSByZXR1cm4gc2VsO1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NUYwMFx1NTlDQlx1NUI4OVx1ODhDNSc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgIHJldHVybiB3YWl0Rm9yKCdpbnN0YWxsIHBhZ2UnLCBgdmFyIHA9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLWluc3RhbGwnKTtcclxuICAgICAgICAgIHJldHVybiB7b2s6ICEhcCwgZGV0YWlsOiBwID8gJ2luc3RhbGxpbmcnIDogJ25vdCBzaG93bid9O2AsIDhfMDAwKTtcclxuICAgICAgfSk7XHJcbiAgICAgIGF3YWl0IHN0ZXAoJ1x1NTQxMVx1NUJGQyhcdTc3MUZcdTVCOUUpOlx1NUI4OVx1ODhDNVx1OEZEQlx1NUVBNlx1NTNFRlx1ODlDMShcdTZCNjVcdTlBQTRcdTY1ODdcdTY4NDgvXHU0RTBCXHU4RjdEXHU3NjdFXHU1MjA2XHU2QkQ0XHU2RURBXHU1MkE4KScsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcigncHJvZ3Jlc3MgdmlzaWJsZScsIGB2YXIgYmFyPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtcHJvZ3Jlc3MnKTtcclxuICAgICAgICAgIHZhciBsb2c9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1pbnN0YWxsLWxvZycpO1xyXG4gICAgICAgICAgdmFyIGxpbmVzPWxvZz9sb2cudGV4dENvbnRlbnQuc3BsaXQoJ1xcXFxuJykuZmlsdGVyKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRyaW0oKSE9PScnO30pOltdO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogISFiYXIgJiYgbGluZXMubGVuZ3RoPj0xLCBkZXRhaWw6ICdiYXI9JysoYmFyPyd5JzonbicpKycgbGluZXM9JytsaW5lcy5sZW5ndGgrKGxpbmVzLmxlbmd0aD4wPygnIGxhc3Q9JysobGluZXNbbGluZXMubGVuZ3RoLTFdfHwnJykuc2xpY2UoMCw1MCkpOicnKX07YCwgNjBfMDAwKTtcclxuICAgICAgICBhd2FpdCBzaG90KCd3aXphcmQtcmVhbC1pbnN0YWxsJyk7XHJcbiAgICAgICAgcmV0dXJuIHc7XHJcbiAgICAgIH0pO1xyXG4gICAgICBhd2FpdCBzdGVwKCdcdTU0MTFcdTVCRkMoXHU3NzFGXHU1QjlFKTpcdTVCODlcdTg4QzVcdTVCOENcdTYyMTBcdTIxOTJcdTkxNERcdTdGNkVcdThERjNcdThGQzcoXHU1REYyXHU2NzA5XHU1QkM2XHU5NEE1KVx1MjE5Mlx1NUI4Q1x1NjIxMFx1OTg3NVx1MjE5Mlx1NUYwMFx1NTlDQlx1NEY3Rlx1NzUyOFx1MjE5Mlx1NjVCMCBydW50aW1lIFx1OEZERVx1NjNBNScsIGFzeW5jICgpID0+IHtcclxuICAgICAgICAvLyBcdTVCODlcdTg4QzVcdTUxNjhcdTdBMEIobnBtIFx1ODlFM1x1Njc5MCtcdTRFMEJcdThGN0QrXHU4NDNEXHU3NkQ4O1x1OTU1Q1x1NTBDRiBucG1taXJyb3IgXHU5MDFBXHU1RTM4IDwyIFx1NTIwNlx1OTQ5RiksXHU0RTBBXHU5NjUwIDggXHU1MjA2XHU5NDlGXHJcbiAgICAgICAgYXdhaXQgd2FpdEZvcignZG9uZSBwYWdlJywgYHZhciBkPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1kb25lJyk7XHJcbiAgICAgICAgICBpZihkKSByZXR1cm4ge29rOnRydWUsIGRldGFpbDonZG9uZSd9O1xyXG4gICAgICAgICAgdmFyIGM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLWNvbmZpZycpO1xyXG4gICAgICAgICAgaWYoYyl7IHZhciBzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1OERGM1x1OEZDNycpPj0wO30pOyBpZihzKSBzLmNsaWNrKCk7IH1cclxuICAgICAgICAgIHZhciBlcnI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1lcnJvcicpO1xyXG4gICAgICAgICAgaWYoZXJyKSByZXR1cm4ge29rOmZhbHNlLCBkZXRhaWw6J2luc3RhbGwgZXJyb3I6ICcrZXJyLnRleHRDb250ZW50LnNsaWNlKDAsODApfTtcclxuICAgICAgICAgIHJldHVybiB7b2s6ZmFsc2UsIGRldGFpbDonaW5zdGFsbGluZ1x1MjAyNid9O2AsIDggKiA2MF8wMDApO1xyXG4gICAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdkb25lIHJlYWR5IHRleHQnLCBgdmFyIGQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLWRvbmUnKTtcclxuICAgICAgICAgIHZhciB0PWQ/ZC50ZXh0Q29udGVudDonJztcclxuICAgICAgICAgIHJldHVybiB7b2s6ICEhZCAmJiB0LmluZGV4T2YoJ1x1NUMzMVx1N0VFQScpPj0wLCBkZXRhaWw6IHQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDYwKX07YCwgMTBfMDAwKTtcclxuICAgICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICAgIGF3YWl0IHNob3QoJ3dpemFyZC1yZWFsLWRvbmUnKTtcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTVGMDBcdTU5Q0JcdTRGN0ZcdTc1MjgnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICBjb25zdCBjb25uZWN0ZWQgPSBhd2FpdCB3YWl0Rm9yKCduZXcgcnVudGltZSBjb25uZWN0ZWQnLCBgdmFyIGRvdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuaG9zdC1kb3Qub24nKTtcclxuICAgICAgICAgIHZhciBsPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ob3N0LWxhYmVsJyk7XHJcbiAgICAgICAgICByZXR1cm4ge29rOiAhIWRvdCAmJiAhIWwgJiYgbC50ZXh0Q29udGVudC5pbmRleE9mKCdydW50aW1lJyk+PTAsIGRldGFpbDogJ2RvdD0nKyhkb3Q/J29uJzonb2ZmJykrJyBsYWJlbD0nKyhsP2wudGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDUwKTonbm9uZScpfTtgLCA2MF8wMDApO1xyXG4gICAgICAgIGNvbnN0IHN0ID0gKGF3YWl0IGpzKGB3aW5kb3cuaG1oLmdldFN0YXRlKCkudGhlbihmdW5jdGlvbihyKXtyZXR1cm4gSlNPTi5zdHJpbmdpZnkoe21vZGU6ci5tb2RlLCBydW50aW1lRW50cnk6ci5ydW50aW1lRW50cnl9KTt9KWApKSBhcyBzdHJpbmc7XHJcbiAgICAgICAgY29uc3QgcCA9IEpTT04ucGFyc2Uoc3QpIGFzIHsgbW9kZT86IHN0cmluZzsgcnVudGltZUVudHJ5Pzogc3RyaW5nIHwgbnVsbCB9O1xyXG4gICAgICAgIGNvbnN0IGVudHJ5T2sgPSAocC5ydW50aW1lRW50cnkgPz8gJycpLmluZGV4T2YoJy5obWhhcm5lc3MtZ2xvYmFsJykgPj0gMDtcclxuICAgICAgICBhd2FpdCBzaG90KCd3aXphcmQtcmVhbC1maW5hbCcpO1xyXG4gICAgICAgIHJldHVybiBbY29ubmVjdGVkWzBdICYmIGVudHJ5T2ssIGBjb25uZWN0ZWQ6ICR7Y29ubmVjdGVkWzFdfTsgc3RhdGU9JHtzdC5zbGljZSgwLCA5MCl9YF07XHJcbiAgICAgIH0pO1xyXG4gICAgfVxyXG4gICAgYXdhaXQgc2hvdCgnZmluYWwnKTtcclxuICB9IGVsc2Uge1xyXG4gICAgLyogPT09PT09PT09PSByZWFsOlx1NTNFQVx1OEJGQlx1NUI1MFx1OTZDNihcdTRFMERcdTUyQThcdTc3MUZcdTVCOUVcdTRGMUFcdThCREQpID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1OTg3Nlx1NjgwRjpydW50aW1lIFx1NzI0OFx1NjcyQ1x1NEUwRVx1N0FFRlx1NTNFM1x1NURGMlx1NjYzRVx1NzkzQShcdTk3NUUgPyknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdob3N0IGxhYmVsJywgYHZhciBsPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ob3N0LWxhYmVsJyk7XHJcbiAgICAgICAgdmFyIHQgPSBsID8gbC50ZXh0Q29udGVudCA6ICcnO1xyXG4gICAgICAgIHJldHVybiB7b2s6IHQuaW5kZXhPZignPycpIDwgMCAmJiB0LmluZGV4T2YoJ3J1bnRpbWUnKSA+PSAwLCBkZXRhaWw6IHQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDYwKX07YCwgMTVfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnXHU0RjFBXHU4QkREXHU1MjE3XHU4ODY4Olx1NzcxRlx1NUI5RVx1NTM4Nlx1NTNGMlx1NTJBMFx1OEY3RChcdTY1NzBcdTkxQ0Y+MCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdzZXNzaW9ucycsIGB2YXIgbj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoO1xyXG4gICAgICAgIHJldHVybiB7b2s6IG4gPiAwLCBkZXRhaWw6ICdzZXNzaW9ucz0nK259O2AsIDE1XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ1x1NzBCOVx1NTFGQlx1NTM4Nlx1NTNGMlx1NEYxQVx1OEJERCBcdTIxOTIgXHU3NzFGXHU1QjlFIHRyYW5zY3JpcHQgXHU1MTg1XHU1QkI5XHU1M0VGXHU4OUMxJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCBuID0gKGF3YWl0IGpzKGBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoYCkpIGFzIG51bWJlcjtcclxuICAgICAgaWYgKG4gPT09IDApIHJldHVybiBbZmFsc2UsICdubyBzZXNzaW9ucyB0byBjbGljayddO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBpdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2Vzc2lvbi1pdGVtJyk7IGlmIChpdCkgaXQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignaGlzdG9yeSB0dXJucycsIGB2YXIgdHM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudHVybicpKTtcclxuICAgICAgICByZXR1cm4ge29rOiB0cy5sZW5ndGggPj0gMSwgZGV0YWlsOiAndHVybnM9Jyt0cy5sZW5ndGgrJyBmaXJzdD0nKyh0c1swXT90c1swXS50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNDApOidub25lJyl9O2AsIDE1XzAwMCk7XHJcbiAgICAgIGF3YWl0IHNob3QoJ3JlYWwtaGlzdG9yeScpO1xyXG4gICAgICByZXR1cm4gdztcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnRG9jazpPdmVydmlldyBcdTc3MUZcdTVCOUVcdTY1NzBcdTYzNkUocnVudGltZSBcdTcyNDhcdTY3MkNcdTk3NUVcdTY1RTBcdTY1NzBcdTYzNkUpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nT3ZlcnZpZXcnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ292ZXJ2aWV3JywgYHZhciByb3dzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stcm93JykpO1xyXG4gICAgICAgIHZhciB2ZXIgPSByb3dzLmZpbmQoZnVuY3Rpb24ocil7IHJldHVybiByLnRleHRDb250ZW50LmluZGV4T2YoJ3J1bnRpbWUgXHU3MjQ4XHU2NzJDJyk+PTA7IH0pO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhdmVyICYmIHZlci50ZXh0Q29udGVudC5pbmRleE9mKCdcdTY1RTBcdTY1NzBcdTYzNkUnKSA8IDAsIGRldGFpbDogdmVyID8gdmVyLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw1MCkgOiAnbm8gdmVyIHJvdyd9O2AsIDEwXzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ0RvY2s6RGlmZiBcdTc3MUZcdTVCOUUgZ2l0IFx1NzJCNlx1NjAwMShcdTk3NUVcdTUyQTBcdThGN0RcdTRFMkQpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nXHU1M0Q4XHU2NkY0J3x8eC50ZXh0Q29udGVudD09PSdEaWZmJzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdkaWZmJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5kaWZmLXBhbmUnKTtcclxuICAgICAgICB2YXIgdCA9IHAgPyBwLnRleHRDb250ZW50IDogJyc7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFwICYmIHQuaW5kZXhPZignXHU1MkEwXHU4RjdEXHU0RTJEJykgPCAwLCBkZXRhaWw6IHQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDYwKX07YCwgMTVfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnRG9jazpFdmlkZW5jZSBcdTc3MUZcdTVCOUVcdThCQTRcdTc3RTVcdTY1NzBcdTYzNkUnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdcdThCQzFcdTYzNkUnfHx4LnRleHRDb250ZW50PT09J0V2aWRlbmNlJzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdldmlkZW5jZScsIGB2YXIgcm93cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXJvdycpKTtcclxuICAgICAgICB2YXIgbWVtID0gcm93cy5maW5kKGZ1bmN0aW9uKHIpeyByZXR1cm4gci50ZXh0Q29udGVudC5pbmRleE9mKCdcdThCQjBcdTVGQzZcdTVDNDInKT49MCB8fCByLnRleHRDb250ZW50LmluZGV4T2YoJ01lbW9yeSBsYXllcnMnKT49MDsgfSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFtZW0gJiYgbWVtLnRleHRDb250ZW50LmluZGV4T2YoJ1x1MjAyNicpIDwgMCwgZGV0YWlsOiBtZW0gPyBtZW0udGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDUwKSA6ICdubyByb3cnfTtgLCAxNV8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdcdTk2NDRcdTRFRjZcdTRFMEVcdTc2RUVcdTVGNTVcdTUxNjVcdTUzRTM6XHVEODNEXHVEQ0NFIFx1NEUwQVx1NEYyMCArIFx1OTg3Nlx1NjgwRlx1NEUyRC9FTiArIFx1RDgzRFx1RENDMSBcdTZENEZcdTg5QzhcdTYzMDlcdTk0QUVcdTVCNThcdTU3MjgnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdcdTY1ODdcdTRFRjYnfHx4LnRleHRDb250ZW50PT09J0ZpbGVzJzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGF3YWl0IHdhaXRGb3IoJ2ZpbGVzIHRhYicsIGB2YXIgdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuZG9jay10YWIuYWN0aXZlJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISF0ICYmICh0LnRleHRDb250ZW50PT09J1x1NjU4N1x1NEVGNid8fHQudGV4dENvbnRlbnQ9PT0nRmlsZXMnKSwgZGV0YWlsOiAnYWN0aXZlPScrKHQ/dC50ZXh0Q29udGVudDonbm9uZScpfTtgLCA1XzAwMCk7XHJcbiAgICAgIC8vIHJlYWwgXHU2QTIxXHU1RjBGIHdvcmtzcGFjZXMgXHU4QkY3XHU2QzQyXHU4RDcwIHJ1bnRpbWUoXHU1MUI3XHU1NDJGXHU1MkE4XHU1NDBFXHU1M0VGXHU4MEZEXHU2MzkyXHU5NjFGKSxcdTY1M0VcdTVCQkRcdTUyMzAgMTVzXHJcbiAgICAgIGNvbnN0IHdzID0gYXdhaXQgd2FpdEZvcignd3MgcGlja2VyJywgYHZhciB3PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1waWNrZXInKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXcsIGRldGFpbDogdyA/ICdsb2FkZWQnIDogJ3dvcmtzcGFjZXMgbm90IGxvYWRlZCB5ZXQnfTtgLCBtb2RlID09PSAncmVhbCcgPyAxNV8wMDAgOiA2XzAwMCk7XHJcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoYChmdW5jdGlvbigpe1xyXG4gICAgICAgIHZhciB1cCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jb21wb3NlciBidXR0b25bYXJpYS1sYWJlbCo9XCJcdTRFMEFcdTRGMjBcIl0sIC5jb21wb3NlciBidXR0b25bYXJpYS1sYWJlbCo9XCJVcGxvYWRcIl0nKTtcclxuICAgICAgICB2YXIgbGFuZyA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5sYW5nLXNlZycpO1xyXG4gICAgICAgIHZhciBiciA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1waWNrZXIgYnV0dG9uJyk7XHJcbiAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHt1cDogISF1cCwgbGFuZzogISFsYW5nLCBicm93c2U6ICEhYnJ9KTtcclxuICAgICAgfSkoKWApKSBhcyBzdHJpbmc7XHJcbiAgICAgIGNvbnN0IHAgPSBKU09OLnBhcnNlKHIpIGFzIHsgdXA6IGJvb2xlYW47IGxhbmc6IGJvb2xlYW47IGJyb3dzZTogYm9vbGVhbiB9O1xyXG4gICAgICByZXR1cm4gW3AudXAgJiYgcC5sYW5nICYmIHAuYnJvd3NlLCBgXHVEODNEXHVEQ0NFPSR7cC51cH0gXHU0RTJEL0VOPSR7cC5sYW5nfSBcdUQ4M0RcdURDQzE9JHtwLmJyb3dzZX07ICR7d3NbMV19YF07XHJcbiAgICB9KTtcclxuICAgIC8qID09PT09PT09PT0gcmVhbDpcdTc3MUZcdTVCOUVcdTRFRkJcdTUyQTFcdTdBRUZcdTUyMzBcdTdBRUZcdTk5OTZcdTlBOEMoXHU1M0QxXHU3N0VEXHU0RUZCXHU1MkExXHUyMTkyXHU2QTIxXHU1NzhCXHU1NkRFXHU1OTBEKSA9PT09PT09PT09XHJcbiAgICAgICBcdTc1MjhcdTYyMzcgZ2xtLTUuMyBcdTVERjJcdTkxNERcdTdGNkU7XHU2M0QwXHU3OTNBXHU4QkNEXHU3RUE2XHU2NzVGXHU3NkY0XHU2M0E1XHU1NkRFXHU1OTBEXHUzMDAyXHU4MkU1IGFnZW50IFx1OEJGN1x1NkM0Mlx1NUJBMVx1NjI3OSxcdThGNkVcdThCRTJcdTkxQ0NcclxuICAgICAgIFx1ODFFQVx1NTJBOFx1NzBCOVx1NjI3OVx1NTFDNihcdTY3MDBcdTU5MUFcdTg5QzFcdTUzNjFcdTUzNzNcdTcwQjksXHU1RTQyXHU3QjQ5KVx1MzAwMlx1OEQ4NVx1NjVGNiAxNTBzXHUzMDAyICovXHJcbiAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfUkVBTF9UQVNLID09PSAnMScpIHtcclxuICAgICAgYXdhaXQgc3RlcCgnXHU3NzFGXHU1QjlFXHU0RUZCXHU1MkExOlx1NTNEMVx1OTAwMVx1MjE5Mlx1NkEyMVx1NTc4Qlx1NTZERVx1NTkwRChcdTdBRUZcdTUyMzBcdTdBRUZcdTk5OTZcdTlBOEMpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J24nLCBjdHJsS2V5OnRydWUsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICAgIGF3YWl0IHNsZWVwKDQwMCk7XHJcbiAgICAgICAgYXdhaXQgdHlwZUludG8oJy5jb21wb3NlciB0ZXh0YXJlYScsICdcdThCRjdcdTUzRUFcdTU2REVcdTU5MERcdTRFMjRcdTRFMkFcdTVCNTc6XHU2NTM2XHU1MjMwKFx1NjcyQ1x1NkIyMVx1OUE4Q1x1NjUzNlx1NEVGQlx1NTJBMSxcdTRFMERcdTg5ODFcdTRGN0ZcdTc1MjhcdTRFRkJcdTRGNTVcdTVERTVcdTUxNzcsXHU3NkY0XHU2M0E1XHU1NkRFXHU1OTBEKScpO1xyXG4gICAgICAgIGF3YWl0IHNsZWVwKDIwMCk7XHJcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jb21wb3NlciBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1M0QxXHU5MDAxJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgY29uc3Qgc2VudCA9IGF3YWl0IHdhaXRGb3IoJ3VzZXIgdHVybicsIGB2YXIgdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudHVybi51c2VyJyk7XHJcbiAgICAgICAgICB2YXIgcyA9ICh0ICYmIHQudGV4dENvbnRlbnQpID8gU3RyaW5nKHQudGV4dENvbnRlbnQpIDogJyc7XHJcbiAgICAgICAgICByZXR1cm4ge29rOiBzLmluZGV4T2YoJ1x1NjUzNlx1NTIzMCcpPj0wIHx8IHMuaW5kZXhPZignXHU5QThDXHU2NTM2XHU0RUZCXHU1MkExJyk+PTAsIGRldGFpbDogcy5zbGljZSgwLDMwKSB8fCAnbm9uZSd9O2AsIDEwXzAwMCk7XHJcbiAgICAgICAgaWYgKCFzZW50WzBdKSByZXR1cm4gc2VudDtcclxuICAgICAgICBjb25zdCByZXBseSA9IGF3YWl0IHdhaXRGb3IoJ2Fzc2lzdGFudCByZXBseScsIGBcclxuICAgICAgICAgIHZhciBhcCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5hcHByb3ZhbC1jYXJkIGJ1dHRvbicpO1xyXG4gICAgICAgICAgaWYgKGFwICYmIGFwLnRleHRDb250ZW50LnRyaW0oKS5pbmRleE9mKCdcdTYyNzlcdTUxQzYnKT49MCkgYXAuY2xpY2soKTtcclxuICAgICAgICAgIHZhciB0cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50dXJuJykpLmZpbHRlcihmdW5jdGlvbih4KXsgcmV0dXJuIHguY2xhc3NOYW1lLmluZGV4T2YoJ3VzZXInKTwwICYmIHguY2xhc3NOYW1lLmluZGV4T2YoJ2FwcHJvdmFsJyk8MCAmJiB4LmNsYXNzTmFtZS5pbmRleE9mKCdzeXN0ZW0nKTwwICYmIHgudGV4dENvbnRlbnQudHJpbSgpLmxlbmd0aD4wICYmIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU1NkRFXHU1NDA4Jyk8MDsgfSk7XHJcbiAgICAgICAgICB2YXIgc3VtID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnR1cm4tc3VtJyk7XHJcbiAgICAgICAgICByZXR1cm4ge29rOiB0cy5sZW5ndGg+PTEgJiYgISFzdW0sIGRldGFpbDogJ2Fzc2lzdGFudD0nK3RzLmxlbmd0aCsnIHN1bT0nKyhzdW0/c3VtLnRleHRDb250ZW50Oidub25lJykrJyBmaXJzdD0nKyh0c1swXT90c1swXS50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNDApOidub25lJyl9O1xyXG4gICAgICAgIGAsIDE1MF8wMDApO1xyXG4gICAgICAgIGF3YWl0IHNob3QoJ3JlYWwtdGFzaycpO1xyXG4gICAgICAgIHJldHVybiByZXBseTtcclxuICAgICAgfSk7XHJcbiAgICB9XHJcbiAgICBhd2FpdCBzdGVwKCdcdTRGMUFcdThCRERcdTUyMDZcdTdFQzQ6XHU1REU2XHU2ODBGXHU2MzA5XHU1REU1XHU0RjVDXHU1MzNBXHU1MjA2XHU3RUM0KFx1N0VDNFx1NTkzNFx1NTNFRlx1ODlDMSknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdncm91cCBoZWFkJywgYHZhciBoPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1ncm91cC1oZWFkJyk7XHJcbiAgICAgICAgdmFyIG4gPSBoID8gKGgucXVlcnlTZWxlY3RvcignLndzLWdyb3VwLW5hbWUnKXx8e30pLnRleHRDb250ZW50IDogJyc7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFoICYmIG4ubGVuZ3RoID4gMCwgZGV0YWlsOiAnbmFtZT0nK259O2AsIDE1XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ1x1NURFNVx1NEY1Q1x1NTMzQTpcdTVERTZcdTY4MEZcdTVERTVcdTRGNUNcdTUzM0FcdTY4MEZcdTUzRUZcdTg5QzEoXHU3NzFGXHU1QjlFXHU1REU1XHU0RjVDXHU1MzNBXHU1NDBEKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ3dvcmtzcGFjZSBiYXInLCBgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndvcmtzcGFjZS1iYXInKTtcclxuICAgICAgICB2YXIgbiA9IGIgPyAoYi5xdWVyeVNlbGVjdG9yKCcud3MtYmFyLW5hbWUnKXx8e30pLnRleHRDb250ZW50IDogJyc7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFiICYmICEhbiAmJiBuLmxlbmd0aCA+IDAgJiYgbi5pbmRleE9mKCdcdTUyQTBcdThGN0QnKSA8IDAgJiYgbi5pbmRleE9mKCdMb2FkaW5nJykgPCAwLCBkZXRhaWw6ICduYW1lPScrbn07YCwgMTVfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc2hvdCgnZmluYWwnKTtcclxuICB9XHJcblxyXG4gIGNvbnN0IGZhaWxlZCA9IHJlc3VsdHMuZmlsdGVyKChyKSA9PiAhclsxXSkubGVuZ3RoO1xyXG4gIGNvbnNvbGUubG9nKGBVSVZFUklGWSBTVU1NQVJZIHBhc3M9JHtyZXN1bHRzLmxlbmd0aCAtIGZhaWxlZH0vJHtyZXN1bHRzLmxlbmd0aH0gbW9kZT0ke21vZGV9IHNob3RzPSR7c2hvdHN9YCk7XHJcbiAgYXBwLmV4aXQoZmFpbGVkID09PSAwID8gMCA6IDEpO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gYXR0YWNoVWlWZXJpZnkod2luOiBCcm93c2VyV2luZG93KTogdm9pZCB7XHJcbiAgY29uc3QgbW9kZSA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX01PREUgPT09ICdyZWFsJyA/ICdyZWFsJyA6ICdmYWtlJztcclxuICB3aW4ud2ViQ29udGVudHMub25jZSgnZGlkLWZpbmlzaC1sb2FkJywgKCkgPT4ge1xyXG4gICAgLy8gXHU3RUQ5IGhvc3QgXHU1NDJGXHU1MkE4XHU3NTU5XHU2NUY2XHU5NUY0O1x1NkI2NVx1OUFBNFx1NTE4NVx1OTBFOFx1NTQwNFx1ODFFQVx1OEY2RVx1OEJFMlx1N0I0OVx1NUY4NVxyXG4gICAgc2V0VGltZW91dCgoKSA9PiB7IHZvaWQgcnVuVWlWZXJpZnkod2luLCBtb2RlKTsgfSwgM18wMDApO1xyXG4gIH0pO1xyXG59XHJcbiIsICIvKipcclxuICogdjUuMSBcdTVCODlcdTg4QzVcdTU0MTFcdTVCRkMgXHUwMEI3IEBobWhhcm5lc3MvY2xpIFx1NUI4OVx1ODhDNVx1N0YxNlx1NjM5MihcdTRFM0JcdThGREJcdTdBMEIpXHUzMDAyXHJcbiAqXHJcbiAqIFx1NEUyNFx1Njc2MVx1OERFRlx1NUY4NChcdTYzRDBcdTc5M0FcdThCQ0QgdjUuMSBcdTU0MDhcdTU0MEMpOlxyXG4gKiAgLSBucG0gXHU1M0VGXHU3NTI4KFx1OUVEOFx1OEJBNCk6YG5wbSBpbnN0YWxsIC0tcHJlZml4ICVVU0VSUFJPRklMRSVcXC5obWhhcm5lc3MtZ2xvYmFsXHJcbiAqICAgIEBobWhhcm5lc3MvY2xpYCBcdTIwMTRcdTIwMTQgXHU1M0VBXHU1MTk5XHU3NTI4XHU2MjM3XHU3NkVFXHU1RjU1LFx1NEUwRFx1NzhCMFx1N0NGQlx1N0VERi9ucG0gXHU1MTY4XHU1QzQwO25wbSBcdTgxRUFcdTVFMjZcdTRGOURcdThENTZcdTg5RTNcdTY3OTAsXHJcbiAqICAgIFx1OEZEQlx1NUVBNlx1OEY2Q1x1NTNEMVx1NTE3Nlx1OEY5M1x1NTFGQVx1ODg0QyhcdTVCODlcdTg4QzVcdTZCNjVcdTlBQTRcdTY1ODdcdTY4NDgpXHUzMDAyXHJcbiAqICAtIFx1NjVFMCBucG0oXHU2MjE2XHU2NjNFXHU1RjBGXHU1RjNBXHU1MjM2KTpcdTgxRUFcdTc4MTQgdGd6IFx1NUI4OVx1ODhDNVx1NTY2OCBcdTIwMTRcdTIwMTQgXHU0RjlEXHU4RDU2XHU5NUVEXHU1MzA1XHU2NzY1XHU4MUVBXHJcbiAqICAgIEBobWgtZGVza3RvcC9jbGktaW5zdGFsbGVyKFx1N0VBRlx1OTAzQlx1OEY5MSxcdTVERjJcdTUzNTVcdTZENEIpLHRhcmJhbGwgXHU5MDEwXHU1MzA1XHU2RDQxXHU1RjBGXHU0RTBCXHU4RjdEXHJcbiAqICAgIChcdTc3MUZcdTVCNTdcdTgyODJcdThGREJcdTVFQTYgKyByZWdpc3RyeS5ucG1qcy5vcmdcdTIxOTJyZWdpc3RyeS5ucG1taXJyb3IuY29tIFx1OTU1Q1x1NTBDRlx1NTZERVx1OTAwMCxcclxuICogICAgXHU1OTBEXHU3NTI4IHY0IFx1NjZGNFx1NjVCMFx1NTY2OFx1NTZERVx1OTAwMFx1NjAxRFx1NjBGMyArIGludGVncml0eSBcdTY4MjFcdTlBOEMpLFx1N0NGQlx1N0VERiB0YXIuZXhlIFx1ODlFM1x1NTM4Qlx1NTIzMFxyXG4gKiAgICBub2RlX21vZHVsZXMgXHU2MjQxXHU1RTczXHU1RTAzXHU1QzQwXHUzMDAyXHJcbiAqIFx1OEZEQlx1NUVBNlx1NEUwMFx1NUY4Qlx1N0VDRiBpbnN0YWxsOnByb2dyZXNzIFx1NEU4Qlx1NEVGNlx1NjNBOCByZW5kZXJlcjtcdTYyMTBcdTUyOUZcdTU2REVcdThDMDMgb25JbnN0YWxsZWQoZW50cnkpXHJcbiAqIFx1NzUzMSBtYWluIFx1NjMwMVx1NEU0NVx1NTMxNiBydW50aW1lLmpzb24gXHU1RTc2XHU3MEVEXHU5MUNEXHU1NDJGIGhvc3RcdTMwMDJcclxuICovXHJcbmltcG9ydCB7IHNwYXduIH0gZnJvbSAnbm9kZTpjaGlsZF9wcm9jZXNzJztcclxuaW1wb3J0IHsgZXhpc3RzU3luYywgbWtkaXJTeW5jLCBybVN5bmMsIHJlbmFtZVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tICdub2RlOmZzJztcclxuaW1wb3J0IHsgaG9tZWRpciB9IGZyb20gJ25vZGU6b3MnO1xyXG5pbXBvcnQgeyBqb2luIH0gZnJvbSAnbm9kZTpwYXRoJztcclxuaW1wb3J0IHsgYnl0ZXNMYWJlbCwgaW50ZWdyaXR5T2ssIG1vZHVsZURpciwgcmVzb2x2ZUNsb3N1cmUsIHRhcmJhbGxNaXJyb3JzLCB0eXBlIFBhY2t1bWVudCwgdHlwZSBSZXNvbHZlZFBrZyB9IGZyb20gJ0BobWgtZGVza3RvcC9jbGktaW5zdGFsbGVyJztcclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgSW5zdGFsbFByb2dyZXNzIHtcclxuICBwaGFzZTogJ2NoZWNrJyB8ICdtZXRhJyB8ICdkb3dubG9hZCcgfCAnZXh0cmFjdCcgfCAnbnBtJyB8ICdkb25lJyB8ICdlcnJvcic7XHJcbiAgcGN0PzogbnVtYmVyO1xyXG4gIHRleHQ6IHN0cmluZztcclxuICBtaXJyb3I/OiBzdHJpbmc7XHJcbiAgZW50cnk/OiBzdHJpbmc7XHJcbiAgZXJyb3I/OiBzdHJpbmc7XHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgSW5zdGFsbE9wdGlvbnMge1xyXG4gIC8qKiBcdTVGM0FcdTUyMzZcdThENzBcdTgxRUFcdTc4MTQgdGd6IFx1OERFRlx1NUY4NChcdTZENEJcdThCRDUvXHU2NUUwIG5wbSBcdTczQUZcdTU4ODMpXHUzMDAyICovXHJcbiAgZm9yY2VUZ3o/OiBib29sZWFuIHwgdW5kZWZpbmVkO1xyXG4gIC8qKiBcdTk1NUNcdTUwQ0ZcdTRGMThcdTUxNDhcdTdFQTcoXHU2MzYyXHU2RTkwXHU2MzA5XHU5NEFFXHU3RkZCXHU4RjZDKVx1MzAwMiAqL1xyXG4gIG1pcnJvckZpcnN0PzogJ25wbWpzJyB8ICducG1taXJyb3InIHwgdW5kZWZpbmVkO1xyXG59XHJcblxyXG5leHBvcnQgY29uc3QgUkVHSVNUUklFUzogUmVjb3JkPCducG1qcycgfCAnbnBtbWlycm9yJywgc3RyaW5nPiA9IHtcclxuICBucG1qczogJ2h0dHBzOi8vcmVnaXN0cnkubnBtanMub3JnJyxcclxuICBucG1taXJyb3I6ICdodHRwczovL3JlZ2lzdHJ5Lm5wbW1pcnJvci5jb20nLFxyXG59O1xyXG5cclxuLyoqIFx1NUI4OVx1ODhDNVx1NjgzOVx1NzZFRVx1NUY1NShcdTc1MjhcdTYyMzdcdTc2RUVcdTVGNTUsXHU3RUREXHU0RTBEXHU1MTk5XHU3Q0ZCXHU3RURGL1x1NTE2OFx1NUM0MCBucG0pXHUzMDAyICovXHJcbmV4cG9ydCBmdW5jdGlvbiBpbnN0YWxsVGFyZ2V0KCk6IHN0cmluZyB7XHJcbiAgcmV0dXJuIGpvaW4oaG9tZWRpcigpLCAnLmhtaGFybmVzcy1nbG9iYWwnKTtcclxufVxyXG5cclxuLyoqIFx1NUI4OVx1ODhDNVx1NUI4Q1x1NjIxMFx1NTQwRVx1NzY4NCBkZXNrdG9wLWhvc3QgXHU1MTY1XHU1M0UzKG5wbSBcdTVENENcdTU5NTdcdTRFMEVcdTYzRDBcdTUzNDdcdTRFMjRcdTc5Q0RcdTVFMDNcdTVDNDBcdTkwRkRcdThCQTQpXHUzMDAyICovXHJcbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlSW5zdGFsbGVkRW50cnkodGFyZ2V0OiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gIGNvbnN0IG5lc3RlZCA9IGpvaW4odGFyZ2V0LCAnbm9kZV9tb2R1bGVzJywgJ0BobWhhcm5lc3MnLCAnY2xpJywgJ25vZGVfbW9kdWxlcycsICdAaG1oYXJuZXNzJywgJ3dlYicsICdkaXN0JywgJ2Rlc2t0b3AtaG9zdC5qcycpO1xyXG4gIGNvbnN0IGhvaXN0ZWQgPSBqb2luKHRhcmdldCwgJ25vZGVfbW9kdWxlcycsICdAaG1oYXJuZXNzJywgJ3dlYicsICdkaXN0JywgJ2Rlc2t0b3AtaG9zdC5qcycpO1xyXG4gIGlmIChleGlzdHNTeW5jKG5lc3RlZCkpIHJldHVybiBuZXN0ZWQ7XHJcbiAgaWYgKGV4aXN0c1N5bmMoaG9pc3RlZCkpIHJldHVybiBob2lzdGVkO1xyXG4gIHJldHVybiAnJztcclxufVxyXG5cclxuZXhwb3J0IGludGVyZmFjZSBJbnN0YWxsZXJIb3N0IHtcclxuICBzZW5kUHJvZ3Jlc3MocDogSW5zdGFsbFByb2dyZXNzKTogdm9pZDtcclxuICBsb2cobXNnOiBzdHJpbmcpOiB2b2lkO1xyXG4gIC8qKiBcdTVCODlcdTg4QzVcdTYyMTBcdTUyOUYoXHU1MTY1XHU1M0UzXHU1REYyXHU5QThDXHU4QkMxXHU1QjU4XHU1NzI4KVx1MjAxNFx1MjAxNCBtYWluIFx1NTcyOFx1NkI2NFx1NjMwMVx1NEU0NVx1NTMxNlx1NUU3Nlx1OTFDRFx1NTQyRiBob3N0XHUzMDAyICovXHJcbiAgb25JbnN0YWxsZWQoZW50cnk6IHN0cmluZywgdmlhOiAnbnBtJyB8ICd0Z3onKTogdm9pZDtcclxufVxyXG5cclxubGV0IHJ1bm5pbmcgPSBmYWxzZTtcclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpbnN0YWxsUnVubmluZygpOiBib29sZWFuIHtcclxuICByZXR1cm4gcnVubmluZztcclxufVxyXG5cclxuLyoqIFx1NTQyRlx1NTJBOFx1NUI4OVx1ODhDNShcdTU0MEVcdTUzRjBcdTYyNjdcdTg4NEM7XHU4RkRCXHU1RUE2L1x1N0VEM1x1Njc5Q1x1NTE2OFx1OTBFOFx1N0VDRlx1NEU4Qlx1NEVGNlx1NTZERVx1NkQ0MSxQcm9taXNlIFx1NTNFQVx1ODg2OFx1OEZCRVwiXHU1REYyXHU1M0Q3XHU3NDA2XCIpXHUzMDAyICovXHJcbmV4cG9ydCBmdW5jdGlvbiBzdGFydENsaUluc3RhbGwoaG9zdDogSW5zdGFsbGVySG9zdCwgb3B0czogSW5zdGFsbE9wdGlvbnMgPSB7fSk6IHsgb2s6IGJvb2xlYW47IGVycm9yPzogc3RyaW5nIH0ge1xyXG4gIGlmIChydW5uaW5nKSByZXR1cm4geyBvazogZmFsc2UsIGVycm9yOiAnXHU1Qjg5XHU4OEM1XHU1REYyXHU1NzI4XHU4RkRCXHU4ODRDXHU0RTJEJyB9O1xyXG4gIHJ1bm5pbmcgPSB0cnVlO1xyXG4gIGNvbnN0IGZpbmlzaCA9IChwOiBJbnN0YWxsUHJvZ3Jlc3MpOiB2b2lkID0+IHtcclxuICAgIGhvc3Quc2VuZFByb2dyZXNzKHApO1xyXG4gICAgcnVubmluZyA9IGZhbHNlO1xyXG4gIH07XHJcbiAgY29uc3QgZmFpbCA9ICh0ZXh0OiBzdHJpbmcsIGVycjogdW5rbm93bik6IHZvaWQgPT4ge1xyXG4gICAgaG9zdC5sb2coYGluc3RhbGwgZmFpbGVkOiAke3RleHR9ICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTgwKX1gKTtcclxuICAgIGZpbmlzaCh7IHBoYXNlOiAnZXJyb3InLCB0ZXh0LCBlcnJvcjogYCR7dGV4dH06JHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxNjApfWAgfSk7XHJcbiAgfTtcclxuICB2b2lkIChhc3luYyAoKSA9PiB7XHJcbiAgICBjb25zdCB0YXJnZXQgPSBpbnN0YWxsVGFyZ2V0KCk7XHJcbiAgICB0cnkge1xyXG4gICAgICBta2RpclN5bmModGFyZ2V0LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcclxuICAgICAgY29uc3QgbnBtT2sgPSBvcHRzLmZvcmNlVGd6ID09PSB0cnVlID8gZmFsc2UgOiBhd2FpdCBwcm9iZU5wbShob3N0KTtcclxuICAgICAgaWYgKG5wbU9rKSBhd2FpdCBpbnN0YWxsVmlhTnBtKGhvc3QsIHRhcmdldCwgb3B0cyk7XHJcbiAgICAgIGVsc2UgYXdhaXQgaW5zdGFsbFZpYVRhcmJhbGxzKGhvc3QsIHRhcmdldCwgb3B0cyk7XHJcbiAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgZmFpbCgnXHU1Qjg5XHU4OEM1XHU1OTMxXHU4RDI1JywgZXJyKTtcclxuICAgIH1cclxuICB9KSgpO1xyXG4gIHJldHVybiB7IG9rOiB0cnVlIH07XHJcbn1cclxuXHJcbi8qIC0tLS0gbnBtIFx1NTNFRlx1NzUyOFx1NjAyNyhcdTZDRThcdTYxMEY6V2luZG93cyBcdTRFMEIgc3Bhd24oJ25wbScpIFx1NTNFRlx1ODg0QywnbnBtLmNtZCcgXHU1M0NEXHU4MDBDIEVJTlZBTCkgLS0tLSAqL1xyXG5hc3luYyBmdW5jdGlvbiBwcm9iZU5wbShob3N0OiBJbnN0YWxsZXJIb3N0KTogUHJvbWlzZTxib29sZWFuPiB7XHJcbiAgaG9zdC5zZW5kUHJvZ3Jlc3MoeyBwaGFzZTogJ2NoZWNrJywgdGV4dDogJ1x1NjhDMFx1NjdFNSBucG1cdTIwMjYnIH0pO1xyXG4gIGNvbnN0IG9rID0gYXdhaXQgbmV3IFByb21pc2U8Ym9vbGVhbj4oKHJlc29sdmUpID0+IHtcclxuICAgIGNvbnN0IGMgPSBzcGF3bignbnBtJywgWyctLXZlcnNpb24nXSwgeyB3aW5kb3dzSGlkZTogdHJ1ZSwgc3RkaW86ICdpZ25vcmUnIH0pO1xyXG4gICAgY29uc3QgdCA9IHNldFRpbWVvdXQoKCkgPT4geyB0cnkgeyBjLmtpbGwoKTsgfSBjYXRjaCB7IC8qIG5vb3AgKi8gfSByZXNvbHZlKGZhbHNlKTsgfSwgMTVfMDAwKTtcclxuICAgIGMub24oJ2Vycm9yJywgKCkgPT4geyBjbGVhclRpbWVvdXQodCk7IHJlc29sdmUoZmFsc2UpOyB9KTtcclxuICAgIGMub24oJ2V4aXQnLCAoY29kZSkgPT4geyBjbGVhclRpbWVvdXQodCk7IHJlc29sdmUoY29kZSA9PT0gMCk7IH0pO1xyXG4gIH0pO1xyXG4gIGhvc3QubG9nKGBucG0gJHtvayA/ICdhdmFpbGFibGUnIDogJ3VuYXZhaWxhYmxlJ30gXHUyMTkyICR7b2sgPyAnbnBtIHByZWZpeCcgOiAndGd6J30gcGF0aGApO1xyXG4gIHJldHVybiBvaztcclxufVxyXG5cclxuLyogLS0tLSBcdThERUZcdTVGODQgQTpucG0gLS1wcmVmaXgoXHU1Qjg5XHU4OEM1XHU2QjY1XHU5QUE0XHU2NTg3XHU2ODQ4ID0gbnBtIFx1OEY5M1x1NTFGQVx1ODg0QykgLS0tLSAqL1xyXG5hc3luYyBmdW5jdGlvbiBpbnN0YWxsVmlhTnBtKGhvc3Q6IEluc3RhbGxlckhvc3QsIHRhcmdldDogc3RyaW5nLCBvcHRzOiBJbnN0YWxsT3B0aW9ucyk6IFByb21pc2U8dm9pZD4ge1xyXG4gIGhvc3Quc2VuZFByb2dyZXNzKHsgcGhhc2U6ICducG0nLCB0ZXh0OiBgbnBtIGluc3RhbGwgQGhtaGFybmVzcy9jbGkgXHUyMTkyICR7dGFyZ2V0fShcdTRFQzVcdTc1MjhcdTYyMzdcdTc2RUVcdTVGNTUpYCB9KTtcclxuICBjb25zdCByZWdpc3RyeSA9IG9wdHMubWlycm9yRmlyc3QgPT09ICducG1taXJyb3InID8gWyctLXJlZ2lzdHJ5JywgUkVHSVNUUklFUy5ucG1taXJyb3JdIDogb3B0cy5taXJyb3JGaXJzdCA9PT0gJ25wbWpzJyA/IFsnLS1yZWdpc3RyeScsIFJFR0lTVFJJRVMubnBtanNdIDogW107XHJcbiAgY29uc3QgYXJncyA9IFsnaW5zdGFsbCcsICctLXByZWZpeCcsIHRhcmdldCwgJy0tbm8tYXVkaXQnLCAnLS1uby1mdW5kJywgJy0tbG9nbGV2ZWwnLCAnbm90aWNlJywgLi4ucmVnaXN0cnksICdAaG1oYXJuZXNzL2NsaUBsYXRlc3QnXTtcclxuICBjb25zdCBjb2RlID0gYXdhaXQgbmV3IFByb21pc2U8bnVtYmVyPigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XHJcbiAgICBjb25zdCBjID0gc3Bhd24oJ25wbScsIGFyZ3MsIHsgd2luZG93c0hpZGU6IHRydWUsIGN3ZDogaG9tZWRpcigpIH0pO1xyXG4gICAgbGV0IGxhc3QgPSAnJztcclxuICAgIGNvbnN0IG9uTGluZSA9IChkOiBCdWZmZXIpOiB2b2lkID0+IHtcclxuICAgICAgZm9yIChjb25zdCByYXcgb2YgZC50b1N0cmluZygpLnNwbGl0KC9cXHI/XFxuLykpIHtcclxuICAgICAgICBjb25zdCBsaW5lID0gcmF3LnJlcGxhY2UoL1tcXHUwMDAwLVxcdTAwMWZdL2csICcnKS50cmltKCkuc2xpY2UoMCwgMTgwKTtcclxuICAgICAgICBpZiAobGluZSA9PT0gJycgfHwgbGluZSA9PT0gbGFzdCkgY29udGludWU7XHJcbiAgICAgICAgbGFzdCA9IGxpbmU7XHJcbiAgICAgICAgaG9zdC5zZW5kUHJvZ3Jlc3MoeyBwaGFzZTogJ25wbScsIHRleHQ6IGxpbmUgfSk7XHJcbiAgICAgIH1cclxuICAgIH07XHJcbiAgICBjLnN0ZG91dD8ub24oJ2RhdGEnLCBvbkxpbmUpO1xyXG4gICAgYy5zdGRlcnI/Lm9uKCdkYXRhJywgb25MaW5lKTtcclxuICAgIGMub24oJ2Vycm9yJywgcmVqZWN0KTtcclxuICAgIGNvbnN0IGtpbGxlciA9IHNldFRpbWVvdXQoKCkgPT4geyB0cnkgeyBjLmtpbGwoKTsgfSBjYXRjaCB7IC8qIG5vb3AgKi8gfSByZWplY3QobmV3IEVycm9yKCducG0gXHU1Qjg5XHU4OEM1XHU4RDg1XHU2NUY2KDggXHU1MjA2XHU5NDlGKScpKTsgfSwgOCAqIDYwXzAwMCk7XHJcbiAgICBjLm9uKCdleGl0JywgKHgpID0+IHsgY2xlYXJUaW1lb3V0KGtpbGxlcik7IHJlc29sdmUoeCA/PyAxKTsgfSk7XHJcbiAgfSk7XHJcbiAgaWYgKGNvZGUgIT09IDApIHRocm93IG5ldyBFcnJvcihgbnBtIGluc3RhbGwgXHU5MDAwXHU1MUZBXHU3ODAxICR7Y29kZX1gKTtcclxuICBjb25zdCBlbnRyeSA9IHJlc29sdmVJbnN0YWxsZWRFbnRyeSh0YXJnZXQpO1xyXG4gIGlmIChlbnRyeSA9PT0gJycpIHRocm93IG5ldyBFcnJvcignbnBtIFx1NUI4OVx1ODhDNVx1NUI4Q1x1NjIxMFx1NEY0Nlx1NjcyQVx1NjI3RVx1NTIzMCBkZXNrdG9wLWhvc3QgXHU1MTY1XHU1M0UzJyk7XHJcbiAgd3JpdGVTdGFtcCh0YXJnZXQsICducG0nKTtcclxuICBmaW5pc2hJbnN0YWxsKGhvc3QsIGVudHJ5LCAnbnBtJyk7XHJcbn1cclxuXHJcbi8qIC0tLS0gXHU4REVGXHU1Rjg0IEI6XHU4MUVBXHU3ODE0IHRneihcdTc3MUZcdTRFMEJcdThGN0RcdThGREJcdTVFQTYgKyBcdTk1NUNcdTUwQ0ZcdTU2REVcdTkwMDAgKyBpbnRlZ3JpdHkgKyB0YXIgXHU4OUUzXHU1MzhCKSAtLS0tICovXHJcbmFzeW5jIGZ1bmN0aW9uIGluc3RhbGxWaWFUYXJiYWxscyhob3N0OiBJbnN0YWxsZXJIb3N0LCB0YXJnZXQ6IHN0cmluZywgb3B0czogSW5zdGFsbE9wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcclxuICBjb25zdCBvcmRlcjogQXJyYXk8J25wbWpzJyB8ICducG1taXJyb3InPiA9IG9wdHMubWlycm9yRmlyc3QgPT09ICducG1taXJyb3InID8gWyducG1taXJyb3InLCAnbnBtanMnXSA6IFsnbnBtanMnLCAnbnBtbWlycm9yJ107XHJcbiAgY29uc3QgbWlycm9ycyA9IG9yZGVyLm1hcCgoaykgPT4gUkVHSVNUUklFU1trXSk7XHJcbiAgaG9zdC5zZW5kUHJvZ3Jlc3MoeyBwaGFzZTogJ21ldGEnLCB0ZXh0OiAnXHU4OUUzXHU2NzkwXHU0RjlEXHU4RDU2XHU2RTA1XHU1MzU1KEBobWhhcm5lc3MvY2xpIFx1NTE2OFx1NUJCNilcdTIwMjYnIH0pO1xyXG5cclxuICBjb25zdCBwYWNrdW1lbnRzID0gbmV3IE1hcDxzdHJpbmcsIFBhY2t1bWVudD4oKTtcclxuICBjb25zdCBnZXRQYWNrdW1lbnQgPSBhc3luYyAobmFtZTogc3RyaW5nKTogUHJvbWlzZTxQYWNrdW1lbnQ+ID0+IHtcclxuICAgIGNvbnN0IGhpdCA9IHBhY2t1bWVudHMuZ2V0KG5hbWUpO1xyXG4gICAgaWYgKGhpdCAhPT0gdW5kZWZpbmVkKSByZXR1cm4gaGl0O1xyXG4gICAgbGV0IGxhc3RFcnIgPSAnJztcclxuICAgIGZvciAoY29uc3QgbSBvZiBtaXJyb3JzKSB7XHJcbiAgICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgciA9IGF3YWl0IGZldGNoKGAke219LyR7ZW5jb2RlVVJJQ29tcG9uZW50KG5hbWUpfWAsIHtcclxuICAgICAgICAgIGhlYWRlcnM6IHsgYWNjZXB0OiAnYXBwbGljYXRpb24vdm5kLm5wbS5pbnN0YWxsLXYxK2pzb24nIH0sXHJcbiAgICAgICAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoMjVfMDAwKSxcclxuICAgICAgICB9KTtcclxuICAgICAgICBpZiAoIXIub2spIHsgbGFzdEVyciA9IGBIVFRQICR7ci5zdGF0dXN9YDsgY29udGludWU7IH1cclxuICAgICAgICBjb25zdCBkb2MgPSAoYXdhaXQgci5qc29uKCkpIGFzIFBhY2t1bWVudDtcclxuICAgICAgICBpZiAoZG9jLnZlcnNpb25zID09PSB1bmRlZmluZWQpIHsgbGFzdEVyciA9ICdtYWxmb3JtZWQgcGFja3VtZW50JzsgY29udGludWU7IH1cclxuICAgICAgICBwYWNrdW1lbnRzLnNldChuYW1lLCBkb2MpO1xyXG4gICAgICAgIHJldHVybiBkb2M7XHJcbiAgICAgIH0gY2F0Y2ggKGVycikgeyBsYXN0RXJyID0gU3RyaW5nKGVycikuc2xpY2UoMCwgNjApOyB9XHJcbiAgICB9XHJcbiAgICB0aHJvdyBuZXcgRXJyb3IoYFx1ODNCN1x1NTNENiAke25hbWV9IFx1NTE0M1x1NjU3MFx1NjM2RVx1NTkzMVx1OEQyNShcdTUxNjhcdTkwRThcdTk1NUNcdTUwQ0Y6JHtsYXN0RXJyfSlgKTtcclxuICB9O1xyXG5cclxuICBjb25zdCBjbG9zdXJlID0gYXdhaXQgcmVzb2x2ZUNsb3N1cmUoeyBuYW1lOiAnQGhtaGFybmVzcy9jbGknLCBzcGVjOiAnbGF0ZXN0JyB9LCBnZXRQYWNrdW1lbnQpO1xyXG4gIGNvbnN0IHJvb3QgPSBjbG9zdXJlLmZpbmQoKHApID0+IHAubmFtZSA9PT0gJ0BobWhhcm5lc3MvY2xpJyk7XHJcbiAgaG9zdC5sb2coYGNsb3N1cmU6ICR7Y2xvc3VyZS5sZW5ndGh9IHBhY2thZ2VzIChyb290IEBobWhhcm5lc3MvY2xpQCR7cm9vdD8udmVyc2lvbiA/PyAnPyd9KWApO1xyXG4gIGhvc3Quc2VuZFByb2dyZXNzKHsgcGhhc2U6ICdtZXRhJywgdGV4dDogYFx1NEY5RFx1OEQ1Nlx1NkUwNVx1NTM1NVx1NUMzMVx1N0VFQToke2Nsb3N1cmUubGVuZ3RofSBcdTRFMkFcdTUzMDUoQGhtaGFybmVzcy9jbGlAJHtyb290Py52ZXJzaW9uID8/ICc/J30pYCB9KTtcclxuXHJcbiAgY29uc3Qgc3RhZ2luZyA9IGpvaW4odGFyZ2V0LCAnLnN0YWdpbmcnKTtcclxuICBybVN5bmMoc3RhZ2luZywgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xyXG4gIG1rZGlyU3luYyhzdGFnaW5nLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcclxuXHJcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBjbG9zdXJlLmxlbmd0aDsgaSsrKSB7XHJcbiAgICBjb25zdCBwa2cgPSBjbG9zdXJlW2ldITtcclxuICAgIGNvbnN0IHVybHMgPSB0YXJiYWxsTWlycm9ycyhwa2cudGFyYmFsbCwgbWlycm9ycyk7XHJcbiAgICBsZXQgYnVmOiBCdWZmZXIgfCBudWxsID0gbnVsbDtcclxuICAgIGxldCB1c2VkTWlycm9yID0gJyc7XHJcbiAgICBsZXQgbGFzdEVyciA9ICcnO1xyXG4gICAgZm9yIChjb25zdCB1IG9mIHVybHMpIHtcclxuICAgICAgdHJ5IHtcclxuICAgICAgICBjb25zdCByID0gYXdhaXQgZmV0Y2godSwgeyBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoMzAwXzAwMCkgfSk7XHJcbiAgICAgICAgaWYgKCFyLm9rKSB7IGxhc3RFcnIgPSBgSFRUUCAke3Iuc3RhdHVzfWA7IGNvbnRpbnVlOyB9XHJcbiAgICAgICAgY29uc3QgdG90YWwgPSBOdW1iZXIoci5oZWFkZXJzLmdldCgnY29udGVudC1sZW5ndGgnKSA/PyAnMCcpO1xyXG4gICAgICAgIGNvbnN0IHJlYWRlciA9IHIuYm9keT8uZ2V0UmVhZGVyKCk7XHJcbiAgICAgICAgaWYgKHJlYWRlciA9PT0gdW5kZWZpbmVkKSB0aHJvdyBuZXcgRXJyb3IoJ25vIGJvZHknKTtcclxuICAgICAgICBjb25zdCBjaHVua3M6IEJ1ZmZlcltdID0gW107XHJcbiAgICAgICAgbGV0IGdvdCA9IDA7XHJcbiAgICAgICAgbGV0IGxhc3RFbWl0ID0gMDtcclxuICAgICAgICBmb3IgKDs7KSB7XHJcbiAgICAgICAgICBjb25zdCB7IGRvbmUsIHZhbHVlIH0gPSBhd2FpdCByZWFkZXIucmVhZCgpO1xyXG4gICAgICAgICAgaWYgKGRvbmUgPT09IHRydWUpIGJyZWFrO1xyXG4gICAgICAgICAgY29uc3QgYiA9IEJ1ZmZlci5mcm9tKHZhbHVlKTtcclxuICAgICAgICAgIGNodW5rcy5wdXNoKGIpO1xyXG4gICAgICAgICAgZ290ICs9IGIubGVuZ3RoO1xyXG4gICAgICAgICAgaWYgKGdvdCAtIGxhc3RFbWl0ID4gMjU2ICogMTAyNCkge1xyXG4gICAgICAgICAgICBsYXN0RW1pdCA9IGdvdDtcclxuICAgICAgICAgICAgaG9zdC5zZW5kUHJvZ3Jlc3Moe1xyXG4gICAgICAgICAgICAgIHBoYXNlOiAnZG93bmxvYWQnLFxyXG4gICAgICAgICAgICAgIHBjdDogTWF0aC5yb3VuZCgoKGkgKyBNYXRoLm1pbihnb3QgLyAodG90YWwgfHwgZ290KSwgMSkpIC8gY2xvc3VyZS5sZW5ndGgpICogMTAwKSxcclxuICAgICAgICAgICAgICB0ZXh0OiBgXHU0RTBCXHU4RjdEICR7cGtnLm5hbWV9QCR7cGtnLnZlcnNpb259KCR7aSArIDF9LyR7Y2xvc3VyZS5sZW5ndGh9KVx1MDBCNyAke2J5dGVzTGFiZWwoZ290KX0ke3RvdGFsID4gMCA/IGAgLyAke2J5dGVzTGFiZWwodG90YWwpfWAgOiAnJ31gLFxyXG4gICAgICAgICAgICAgIG1pcnJvcjogbmV3IFVSTCh1KS5ob3N0LFxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICAgICAgYnVmID0gQnVmZmVyLmNvbmNhdChjaHVua3MpO1xyXG4gICAgICAgIGlmICghaW50ZWdyaXR5T2soYnVmLCBwa2cuaW50ZWdyaXR5KSkgeyBsYXN0RXJyID0gJ2ludGVncml0eSBcdTRFMERcdTUzMzlcdTkxNEQnOyBidWYgPSBudWxsOyBjb250aW51ZTsgfVxyXG4gICAgICAgIHVzZWRNaXJyb3IgPSBuZXcgVVJMKHUpLmhvc3Q7XHJcbiAgICAgICAgYnJlYWs7XHJcbiAgICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICAgIGxhc3RFcnIgPSBTdHJpbmcoZXJyKS5zbGljZSgwLCA2MCk7XHJcbiAgICAgIH1cclxuICAgIH1cclxuICAgIGlmIChidWYgPT09IG51bGwpIHRocm93IG5ldyBFcnJvcihgXHU0RTBCXHU4RjdEICR7cGtnLm5hbWV9IFx1NTkzMVx1OEQyNShcdTUxNjhcdTkwRThcdTk1NUNcdTUwQ0Y6JHtsYXN0RXJyfSlgKTtcclxuICAgIGNvbnN0IHRneiA9IGpvaW4oc3RhZ2luZywgYCR7aX0udGd6YCk7XHJcbiAgICB3cml0ZUZpbGVTeW5jKHRneiwgYnVmKTtcclxuICAgIGhvc3Quc2VuZFByb2dyZXNzKHtcclxuICAgICAgcGhhc2U6ICdkb3dubG9hZCcsXHJcbiAgICAgIHBjdDogTWF0aC5yb3VuZCgoKGkgKyAxKSAvIGNsb3N1cmUubGVuZ3RoKSAqIDEwMCksXHJcbiAgICAgIHRleHQ6IGBcdTRFMEJcdThGN0QgJHtwa2cubmFtZX1AJHtwa2cudmVyc2lvbn0gXHU1QjhDXHU2MjEwKCR7Ynl0ZXNMYWJlbChidWYubGVuZ3RoKX0sdmlhICR7dXNlZE1pcnJvcn0pYCxcclxuICAgICAgbWlycm9yOiB1c2VkTWlycm9yLFxyXG4gICAgfSk7XHJcbiAgfVxyXG5cclxuICBob3N0LnNlbmRQcm9ncmVzcyh7IHBoYXNlOiAnZXh0cmFjdCcsIHRleHQ6ICdcdTg5RTNcdTUzOEJcdTVFNzZcdTVFMDNcdTVDNDAgbm9kZV9tb2R1bGVzXHUyMDI2JyB9KTtcclxuICBmb3IgKGxldCBpID0gMDsgaSA8IGNsb3N1cmUubGVuZ3RoOyBpKyspIHtcclxuICAgIGNvbnN0IHBrZyA9IGNsb3N1cmVbaV0hO1xyXG4gICAgYXdhaXQgZXh0cmFjdFRneihqb2luKHN0YWdpbmcsIGAke2l9LnRnemApLCBzdGFnaW5nLCBwa2cpO1xyXG4gICAgaG9zdC5zZW5kUHJvZ3Jlc3MoeyBwaGFzZTogJ2V4dHJhY3QnLCBwY3Q6IE1hdGgucm91bmQoKChpICsgMSkgLyBjbG9zdXJlLmxlbmd0aCkgKiAxMDApLCB0ZXh0OiBgXHU4OUUzXHU1MzhCICR7cGtnLm5hbWV9KCR7aSArIDF9LyR7Y2xvc3VyZS5sZW5ndGh9KWAgfSk7XHJcbiAgfVxyXG4gIHJtU3luYyhzdGFnaW5nLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XHJcblxyXG4gIGNvbnN0IGVudHJ5ID0gcmVzb2x2ZUluc3RhbGxlZEVudHJ5KHRhcmdldCk7XHJcbiAgaWYgKGVudHJ5ID09PSAnJykgdGhyb3cgbmV3IEVycm9yKCd0Z3ogXHU1Qjg5XHU4OEM1XHU1QjhDXHU2MjEwXHU0RjQ2XHU2NzJBXHU2MjdFXHU1MjMwIGRlc2t0b3AtaG9zdCBcdTUxNjVcdTUzRTMnKTtcclxuICB3cml0ZVN0YW1wKHRhcmdldCwgJ3RneicpO1xyXG4gIGZpbmlzaEluc3RhbGwoaG9zdCwgZW50cnksICd0Z3onKTtcclxufVxyXG5cclxuLyoqIHRhci5leGUoV2luMTArIFx1ODFFQVx1NUUyNilcdTg5RTNcdTUzOEIgdGd6IFx1NTIzMCBleERpcixcdTUxOERcdTYyOEEgcGFja2FnZS8gXHU2MzJBXHU1MjMwIG5vZGVfbW9kdWxlcyBcdTVFMDNcdTVDNDBcdTMwMDIgKi9cclxuYXN5bmMgZnVuY3Rpb24gZXh0cmFjdFRneih0Z3o6IHN0cmluZywgc3RhZ2luZzogc3RyaW5nLCBwa2c6IFJlc29sdmVkUGtnKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgY29uc3QgZXhEaXIgPSBqb2luKHN0YWdpbmcsIGB4LSR7cGtnLm5hbWUucmVwbGFjZSgvW15cXHcuLV0vZywgJ18nKX1gKTtcclxuICBybVN5bmMoZXhEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcclxuICBta2RpclN5bmMoZXhEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xyXG4gIGNvbnN0IGNvZGUgPSBhd2FpdCBuZXcgUHJvbWlzZTxudW1iZXI+KChyZXNvbHZlLCByZWplY3QpID0+IHtcclxuICAgIGNvbnN0IGMgPSBzcGF3bigndGFyJywgWycteHpmJywgdGd6LCAnLUMnLCBleERpcl0sIHsgd2luZG93c0hpZGU6IHRydWUsIHN0ZGlvOiAnaWdub3JlJyB9KTtcclxuICAgIGMub24oJ2Vycm9yJywgcmVqZWN0KTtcclxuICAgIGMub24oJ2V4aXQnLCAoeCkgPT4gcmVzb2x2ZSh4ID8/IDEpKTtcclxuICB9KTtcclxuICBpZiAoY29kZSAhPT0gMCkgdGhyb3cgbmV3IEVycm9yKGB0YXIgXHU4OUUzXHU1MzhCICR7cGtnLm5hbWV9IFx1NTkzMVx1OEQyNShcdTkwMDBcdTUxRkFcdTc4MDEgJHtjb2RlfSlgKTtcclxuICBjb25zdCBkZXN0ID0gbW9kdWxlRGlyKGluc3RhbGxUYXJnZXQoKSwgcGtnLm5hbWUpO1xyXG4gIGNvbnN0IHBhcmVudCA9IGRlc3Quc2xpY2UoMCwgZGVzdC5sYXN0SW5kZXhPZignXFxcXCcpKTtcclxuICBta2RpclN5bmMocGFyZW50LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcclxuICBybVN5bmMoZGVzdCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xyXG4gIHJlbmFtZVN5bmMoam9pbihleERpciwgJ3BhY2thZ2UnKSwgZGVzdCk7XHJcbiAgcm1TeW5jKGV4RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XHJcbn1cclxuXHJcbi8qKiBcdTVCODlcdTg4QzVcdTYyMzMoXHU1NDExXHU1QkZDXHU1QjhDXHU2MjEwXHU5ODc1L1x1OEJCRVx1N0Y2RVx1OTc2Mlx1Njc3Rlx1NUM1NVx1NzkzQVx1NUI4OVx1ODhDNVx1NjVCOVx1NUYwRlx1NEUwRVx1NjVGNlx1OTVGNDtcdTRFMERcdTYyN0ZcdThGN0RcdThGRDBcdTg4NENcdTY1RjZcdTkwM0JcdThGOTEpXHUzMDAyICovXHJcbmZ1bmN0aW9uIHdyaXRlU3RhbXAodGFyZ2V0OiBzdHJpbmcsIHZpYTogJ25wbScgfCAndGd6Jyk6IHZvaWQge1xyXG4gIHRyeSB7XHJcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4odGFyZ2V0LCAnaW5zdGFsbGVkLWJ5LWhtaC1kZXNrdG9wLmpzb24nKSwgSlNPTi5zdHJpbmdpZnkoeyB2aWEsIGF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkgfSwgbnVsbCwgMiksICd1dGY4Jyk7XHJcbiAgfSBjYXRjaCB7IC8qIGJlc3QgZWZmb3J0ICovIH1cclxufVxyXG5cclxuZnVuY3Rpb24gZmluaXNoSW5zdGFsbChob3N0OiBJbnN0YWxsZXJIb3N0LCBlbnRyeTogc3RyaW5nLCB2aWE6ICducG0nIHwgJ3RneicpOiB2b2lkIHtcclxuICBob3N0LmxvZyhgaW5zdGFsbCBkb25lIHZpYSAke3ZpYX06ICR7ZW50cnl9YCk7XHJcbiAgaG9zdC5zZW5kUHJvZ3Jlc3MoeyBwaGFzZTogJ2RvbmUnLCB0ZXh0OiBgXHU1Qjg5XHU4OEM1XHU1QjhDXHU2MjEwKCR7dmlhfSlgLCBlbnRyeSB9KTtcclxuICBob3N0Lm9uSW5zdGFsbGVkKGVudHJ5LCB2aWEpO1xyXG4gIHJ1bm5pbmcgPSBmYWxzZTtcclxufVxyXG4iLCAiLyoqXHJcbiAqIEBobWhhcm5lc3MvY2xpIFx1NUI4OVx1ODhDNVx1NjgzOFx1NUZDMyhcdTdFQUZcdTkwM0JcdThGOTEsXHU5NkY2IElPIFx1MjAxNFx1MjAxNCBmZXRjaC9cdTg5RTNcdTUzOEIvXHU4NDNEXHU3NkQ4XHU1NzI4XHU0RTNCXHU4RkRCXHU3QTBCIGluc3RhbGxlciBcdTkxQ0MpXHUzMDAyXHJcbiAqXHJcbiAqIFx1ODA0Q1x1OEQyMyh2NS4xIFx1NUI4OVx1ODhDNVx1NTQxMVx1NUJGQyk6XHU3RUQ5XHU1QjlBIHJlZ2lzdHJ5IFx1NTE0M1x1NjU3MFx1NjM2RVx1ODNCN1x1NTNENlx1NTFGRFx1NjU3MCxcdTg5RTNcdTY3OTAgQGhtaGFybmVzcy9jbGkgXHU3Njg0XHJcbiAqIFx1NUI4Q1x1NjU3NFx1NEY5RFx1OEQ1Nlx1OTVFRFx1NTMwNShAaG1oYXJuZXNzLyogXHU1MTY4XHU1QkI2XHU0RTNBXHU3Q0JFXHU3ODZFXHU3MjQ4XHU2NzJDXHU0RTkyXHU5NDg5O1x1NTkxNlx1OTBFOFx1NEY5RFx1OEQ1NiBxcmNvZGUgXHU5NEZFXHU0RTNBIF4gXHU4MzAzXHU1NkY0KSxcclxuICogXHU0RUE3XHU1MUZBXCJcdTg4QzVcdTRFQzBcdTRFNDhcdTMwMDFcdTRFQ0VcdTU0RUFcdTRFOUJcdTk1NUNcdTUwQ0ZcdTRFMEJcdTMwMDFcdTg4QzVcdTUyMzBcdTU0RUFcIlx1NzY4NFx1Nzg2RVx1NUI5QVx1NjAyN1x1OEJBMVx1NTIxMlx1MzAwMlx1OEJCRVx1OEJBMVx1N0VBNlx1Njc1RjpcclxuICogIC0gXHU5NUVEXHU1MzA1XHU2MzA5XHU1MzA1XHU1NDBEXHU1M0JCXHU5MUNEKFx1OTRCQlx1NzdGM1x1NEY5RFx1OEQ1Nlx1NTNFQVx1ODhDNVx1NEUwMFx1NEVGRCxucG0gXHU4QkVEXHU0RTQ5KTtcclxuICogIC0gXHU4MzAzXHU1NkY0XHU4OUUzXHU2NzkwXHU1M0VBXHU2NTJGXHU2MzAxIG5wbSBcdTc1MUZcdTYwMDFcdTVCOUVcdTk2NDVcdTc1MjhcdTUyMzBcdTc2ODRcdTVGNjJcdTYwMDE6XHU3Q0JFXHU3ODZFIC8gbGF0ZXN0IC8gKiAvIF4gLyB+IC8gPj0sXHJcbiAqICAgIFx1NEUwRFx1NUYxNSBzZW12ZXIgXHU1RTkzKFx1OTZGNlx1NEY5RFx1OEQ1Nlx1NTM5Rlx1NTIxOSxcdTRFMEVcdTgxRUFcdTc4MTRcdTY2RjRcdTY1QjBcdTU2NjhcdTRFMDBcdTgxRjQpO1xyXG4gKiAgLSBvcHRpb25hbERlcGVuZGVuY2llcyBcdTRFMERcdTg4QzU6XHU5NUVEXHU1MzA1XHU1MTg1XHU1QjlFXHU5NjQ1XHU1OEYwXHU2NjBFXHU3Njg0IG9wdGlvbmFsIFx1NTc0N1x1NEUzQVx1NUU3M1x1NTNGMFx1NzI3OVx1NUI5QVxyXG4gKiAgICAoZnNldmVudHMgXHU3QjQ5KSx0Z3ogXHU4REVGXHU1Rjg0XHU0RTBEXHU4REQxXHU3NTFGXHU1NDdEXHU1NDY4XHU2NzFGXHU4MTFBXHU2NzJDLFx1ODhDNVx1NEU4Nlx1NEU1Rlx1NTNFQVx1NjYyRlx1NkI3Qlx1OTFDRFx1MzAwMlxyXG4gKi9cclxuaW1wb3J0IHsgY3JlYXRlSGFzaCB9IGZyb20gJ25vZGU6Y3J5cHRvJztcclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgUGtnVmVyc2lvbk1ldGEge1xyXG4gIHZlcnNpb246IHN0cmluZztcclxuICBkZXBlbmRlbmNpZXM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XHJcbiAgdGFyYmFsbDogc3RyaW5nO1xyXG4gIGludGVncml0eT86IHN0cmluZyB8IHVuZGVmaW5lZDtcclxufVxyXG5cclxuLyoqIHJlZ2lzdHJ5IHBhY2t1bWVudCBcdTc2ODRcdTY3MDBcdTVDMEZcdThCRkJcdTUzRDZcdTk3NjIoZGlzdC10YWdzICsgXHU1MTY4XHU3MjQ4XHU2NzJDXHU0RjlEXHU4RDU2L3RhcmJhbGwgXHU1MTQzXHU2NTcwXHU2MzZFKVx1MzAwMiAqL1xyXG5leHBvcnQgaW50ZXJmYWNlIFBhY2t1bWVudCB7XHJcbiAgJ2Rpc3QtdGFncyc6IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XHJcbiAgdmVyc2lvbnM6IFJlY29yZDxzdHJpbmcsIHsgZGVwZW5kZW5jaWVzPzogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB8IHVuZGVmaW5lZDsgZGlzdD86IHsgdGFyYmFsbD86IHN0cmluZzsgaW50ZWdyaXR5Pzogc3RyaW5nIHwgdW5kZWZpbmVkIH0gfCB1bmRlZmluZWQgfT47XHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgUmVzb2x2ZWRQa2cge1xyXG4gIG5hbWU6IHN0cmluZztcclxuICB2ZXJzaW9uOiBzdHJpbmc7XHJcbiAgLyoqIHJlZ2lzdHJ5IFx1NTM5Rlx1NTlDQlx1NTczMFx1NTc0MChcdTk1NUNcdTUwQ0ZcdTUyMTdcdTg4NjhcdTc1MzEgdGFyYmFsbE1pcnJvcnMgXHU2RDNFXHU3NTFGKVx1MzAwMiAqL1xyXG4gIHRhcmJhbGw6IHN0cmluZztcclxuICBpbnRlZ3JpdHk/OiBzdHJpbmcgfCB1bmRlZmluZWQ7XHJcbn1cclxuXHJcbi8qIC0tLS0gc2VtdmVyKFx1NjcwMFx1NUMwRlx1NUI5RVx1NzNCMDpcdTk1RURcdTUzMDVcdTUxODVcdTVCOUVcdTk2NDVcdTUxRkFcdTczQjBcdTc2ODRcdTVGNjJcdTYwMDEpIC0tLS0gKi9cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBjbXBTZW12ZXIoYTogc3RyaW5nLCBiOiBzdHJpbmcpOiBudW1iZXIge1xyXG4gIGNvbnN0IHBhID0gYS5yZXBsYWNlKC9edi8sICcnKS5zcGxpdCgnLScpWzBdIS5zcGxpdCgnLicpLm1hcChOdW1iZXIpO1xyXG4gIGNvbnN0IHBiID0gYi5yZXBsYWNlKC9edi8sICcnKS5zcGxpdCgnLScpWzBdIS5zcGxpdCgnLicpLm1hcChOdW1iZXIpO1xyXG4gIGZvciAobGV0IGkgPSAwOyBpIDwgMzsgaSsrKSB7XHJcbiAgICBjb25zdCB4ID0gcGFbaV0gPz8gMDtcclxuICAgIGNvbnN0IHkgPSBwYltpXSA/PyAwO1xyXG4gICAgaWYgKHggIT09IHkpIHJldHVybiB4IDwgeSA/IC0xIDogMTtcclxuICB9XHJcbiAgcmV0dXJuIDA7XHJcbn1cclxuXHJcbi8qKiByYW5nZSBcdTY2MkZcdTU0MjZcdTYzQTVcdTUzRDcgdmVyc2lvbihcdTY1MkZcdTYzMDEgXHU3Q0JFXHU3ODZFIC8gbGF0ZXN0IC8gKiAvIHggLyBeIC8gfiAvID49O1x1NEUwRFx1OEJDNlx1NTIyQlx1NTIxOSBmYWxzZSlcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHNhdGlzZmllcyhyYW5nZTogc3RyaW5nLCB2ZXJzaW9uOiBzdHJpbmcpOiBib29sZWFuIHtcclxuICBjb25zdCByID0gcmFuZ2UudHJpbSgpO1xyXG4gIGlmIChyID09PSAnJyB8fCByID09PSAnKicgfHwgciA9PT0gJ2xhdGVzdCcgfHwgciA9PT0gJ3gnKSByZXR1cm4gdHJ1ZTtcclxuICBpZiAociA9PT0gdmVyc2lvbikgcmV0dXJuIHRydWU7XHJcbiAgY29uc3QgYm91bmQgPSAvXihcXF58fnw+PT8pXFxzKihcXGQrKVxcLihcXGQrKVxcLihcXGQrKS8uZXhlYyhyKTtcclxuICBpZiAoYm91bmQgIT09IG51bGwpIHtcclxuICAgIGNvbnN0IG9wID0gYm91bmRbMV0hO1xyXG4gICAgY29uc3QgbWFqb3IgPSBOdW1iZXIoYm91bmRbMl0pO1xyXG4gICAgY29uc3QgbWlub3IgPSBOdW1iZXIoYm91bmRbM10pO1xyXG4gICAgY29uc3QgcGF0Y2ggPSBOdW1iZXIoYm91bmRbNF0pO1xyXG4gICAgY29uc3QgYyA9IGNtcFNlbXZlcih2ZXJzaW9uLCBgJHttYWpvcn0uJHttaW5vcn0uJHtwYXRjaH1gKTtcclxuICAgIGlmIChjIDwgMCkgcmV0dXJuIGZhbHNlO1xyXG4gICAgaWYgKG9wID09PSAnPj0nKSByZXR1cm4gdHJ1ZTsgLy8gJz49JyBcdTRFMEJcdTc1NENcdTUzNzNcdTUzRUY6XHU5NUVEXHU1MzA1XHU1MTg1XHU1M0VBXHU0RUU1ICc+PXgueS56IDx6JyBcdTU5MERcdTU0MDhcdTVGNjJcdTYwMDFcdTUxRkFcdTczQjAsXHU0RkREXHU1Qjg4XHU1M0Q2XHU0RTBCXHU3NTRDXHJcbiAgICBpZiAob3AgPT09ICd+JykgcmV0dXJuIGNtcFNlbXZlcih2ZXJzaW9uLCBgJHttYWpvcn0uJHttaW5vciArIDF9LjBgKSA8IDA7XHJcbiAgICAvLyAnXic6MC54IFx1NzI3OVx1NTIyNCgwLjIuMyBcdTUxNDFcdThCQjggMC4yLnopLFx1NTE3Nlx1NEY1OVx1OTUwMVx1NEUzQlx1NzI0OFx1NjcyQ1xyXG4gICAgaWYgKG1ham9yID09PSAwKSByZXR1cm4gbWlub3IgPT09IDAgPyBjbXBTZW12ZXIodmVyc2lvbiwgYDAuMC4ke3BhdGNoICsgMX1gKSA8IDAgOiBjbXBTZW12ZXIodmVyc2lvbiwgYDAuJHttaW5vciArIDF9LjBgKSA8IDA7XHJcbiAgICByZXR1cm4gY21wU2VtdmVyKHZlcnNpb24sIGAke21ham9yICsgMX0uMC4wYCkgPCAwO1xyXG4gIH1cclxuICByZXR1cm4gZmFsc2U7XHJcbn1cclxuXHJcbi8qKiBcdTRFQ0UgcGFja3VtZW50IFx1OTAwOVx1NTFGQSBzcGVjKFx1N0NCRVx1Nzg2RS9sYXRlc3QvXi9+LyopXHU2MzA3XHU1NDExXHU3Njg0XHU3MjQ4XHU2NzJDO1x1NjVFMFx1NTMzOVx1OTE0RFx1OEZENFx1NTZERSAnJ1x1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gcGlja1ZlcnNpb24oZG9jOiBQYWNrdW1lbnQsIHNwZWM6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgY29uc3QgcyA9IHNwZWMudHJpbSgpO1xyXG4gIGNvbnN0IHRhZyA9IHMgPT09ICcnIHx8IHMgPT09ICdsYXRlc3QnIHx8IHMgPT09ICcqJyA/IGRvY1snZGlzdC10YWdzJ10/LmxhdGVzdCA6IHVuZGVmaW5lZDtcclxuICBpZiAodGFnICE9PSB1bmRlZmluZWQgJiYgZG9jLnZlcnNpb25zW3RhZ10gIT09IHVuZGVmaW5lZCkgcmV0dXJuIHRhZztcclxuICBpZiAoZG9jLnZlcnNpb25zW3NdICE9PSB1bmRlZmluZWQpIHJldHVybiBzO1xyXG4gIGxldCBiZXN0ID0gJyc7XHJcbiAgZm9yIChjb25zdCB2IG9mIE9iamVjdC5rZXlzKGRvYy52ZXJzaW9ucykpIHtcclxuICAgIGlmIChzYXRpc2ZpZXMocywgdikgJiYgY21wU2VtdmVyKHYsIGJlc3QpID4gMCkgYmVzdCA9IHY7XHJcbiAgfVxyXG4gIHJldHVybiBiZXN0O1xyXG59XHJcblxyXG4vKiAtLS0tIFx1NEY5RFx1OEQ1Nlx1OTVFRFx1NTMwNSAtLS0tICovXHJcblxyXG4vKipcclxuICogXHU4OUUzXHU2NzkwIHJvb3QgXHU1M0NBXHU1MTc2XHU1MTY4XHU5MEU4XHU0RjIwXHU5MDEyXHU0RjlEXHU4RDU2KEJGUyxcdTYzMDlcdTUzMDVcdTU0MERcdTUzQkJcdTkxQ0RcdTUzRDZcdTk5OTZcdTRFMkFcdTg5RTNcdTY3OTBcdTdFRDNcdTY3OUMgXHUyMDE0XHUyMDE0IFx1NEUwRSBucG0gXHU2MjQxXHU1RTczXHJcbiAqIFx1NUUwM1x1NUM0MFx1NEUwMFx1ODFGNClcdTMwMDJnZXRQYWNrdW1lbnQgXHU3NTMxXHU4QzAzXHU3NTI4XHU2NUI5XHU2Q0U4XHU1MTY1KGZldGNoIFx1N0Y1MVx1N0VEQyAvIFx1NkQ0Qlx1OEJENVx1NkNFOFx1NTE2NVx1NUI1N1x1NTE3OClcdTMwMDJcclxuICogXHU0RUZCXHU0RTAwXHU0RjlEXHU4RDU2XHU2NUUwXHU2RUUxXHU4REIzXHU3MjQ4XHU2NzJDXHU2NUY2XHU2MjlCXHU5NTE5KFx1NUUyNlx1NTMwNVx1NTQwRFx1NEUwRSByYW5nZSxcdTk3NjJcdTU0MTFcdTVCODlcdTg4QzVcdTk4NzVcdTk1MTlcdThCRUZcdTY1ODdcdTY4NDgpXHUzMDAyXHJcbiAqL1xyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZUNsb3N1cmUoXHJcbiAgcm9vdDogeyBuYW1lOiBzdHJpbmc7IHNwZWM6IHN0cmluZyB9LFxyXG4gIGdldFBhY2t1bWVudDogKG5hbWU6IHN0cmluZykgPT4gUHJvbWlzZTxQYWNrdW1lbnQ+LFxyXG4pOiBQcm9taXNlPFJlc29sdmVkUGtnW10+IHtcclxuICBjb25zdCByZXNvbHZlZCA9IG5ldyBNYXA8c3RyaW5nLCBQa2dWZXJzaW9uTWV0YT4oKTtcclxuICBjb25zdCBxdWV1ZTogQXJyYXk8eyBuYW1lOiBzdHJpbmc7IHNwZWM6IHN0cmluZyB9PiA9IFtyb290XTtcclxuICB3aGlsZSAocXVldWUubGVuZ3RoID4gMCkge1xyXG4gICAgY29uc3QgeyBuYW1lLCBzcGVjIH0gPSBxdWV1ZS5zaGlmdCgpITtcclxuICAgIGlmIChyZXNvbHZlZC5oYXMobmFtZSkpIGNvbnRpbnVlOyAvLyBcdTVERjJcdTVCOUFcdTcyNDg6XHU1NDBFXHU3RUVEIHJhbmdlIFx1NUYxNVx1NzUyOFx1NEUwRFx1NTE4RFx1OTFDRFx1ODlFMyhucG0gXHU2MjQxXHU1RTczXHU4QkVEXHU0RTQ5KVxyXG4gICAgY29uc3QgZG9jID0gYXdhaXQgZ2V0UGFja3VtZW50KG5hbWUpO1xyXG4gICAgY29uc3QgdmVyc2lvbiA9IHBpY2tWZXJzaW9uKGRvYywgc3BlYyk7XHJcbiAgICBjb25zdCBtZXRhID0gdmVyc2lvbiAhPT0gJycgPyBkb2MudmVyc2lvbnNbdmVyc2lvbl0gOiB1bmRlZmluZWQ7XHJcbiAgICBpZiAobWV0YSA9PT0gdW5kZWZpbmVkIHx8IG1ldGEuZGlzdD8udGFyYmFsbCA9PT0gdW5kZWZpbmVkKSB7XHJcbiAgICAgIHRocm93IG5ldyBFcnJvcihgbm8gdmVyc2lvbiBvZiAke25hbWV9IHNhdGlzZmllcyAke3NwZWMgfHwgJ2xhdGVzdCd9YCk7XHJcbiAgICB9XHJcbiAgICBjb25zdCBpdGVtOiBQa2dWZXJzaW9uTWV0YSA9IHtcclxuICAgICAgdmVyc2lvbixcclxuICAgICAgZGVwZW5kZW5jaWVzOiBtZXRhLmRlcGVuZGVuY2llcyA/PyB7fSxcclxuICAgICAgdGFyYmFsbDogbWV0YS5kaXN0LnRhcmJhbGwsXHJcbiAgICAgIGludGVncml0eTogbWV0YS5kaXN0LmludGVncml0eSxcclxuICAgIH07XHJcbiAgICByZXNvbHZlZC5zZXQobmFtZSwgaXRlbSk7XHJcbiAgICBmb3IgKGNvbnN0IFtkZXAsIHJhbmdlXSBvZiBPYmplY3QuZW50cmllcyhpdGVtLmRlcGVuZGVuY2llcykpIHtcclxuICAgICAgaWYgKCFyZXNvbHZlZC5oYXMoZGVwKSkgcXVldWUucHVzaCh7IG5hbWU6IGRlcCwgc3BlYzogcmFuZ2UgfSk7XHJcbiAgICB9XHJcbiAgfVxyXG4gIHJldHVybiBbLi4ucmVzb2x2ZWQuZW50cmllcygpXS5tYXAoKFtuYW1lLCBtXSkgPT4gKHsgbmFtZSwgdmVyc2lvbjogbS52ZXJzaW9uLCB0YXJiYWxsOiBtLnRhcmJhbGwsIGludGVncml0eTogbS5pbnRlZ3JpdHkgfSkpO1xyXG59XHJcblxyXG4vKiAtLS0tIFx1OTU1Q1x1NTBDRlx1NEUwRVx1NUUwM1x1NUM0MCAtLS0tICovXHJcblxyXG5jb25zdCBSRUdJU1RSWV9IT1NUUyA9IC9eKGh0dHBzPzpcXC9cXC9bXi9dKylcXC8oLiopJC87XHJcblxyXG4vKipcclxuICogdGFyYmFsbCBcdTc2ODRcdTk1NUNcdTUwQ0ZcdTUwMTlcdTkwMDkoXHU5ODdBXHU1RThGXHU1MzczXHU1NkRFXHU5MDAwXHU5ODdBXHU1RThGKTpcdTUzOUZcdTU5Q0JcdTU3MzBcdTU3NDAgXHUyMTkyIFx1NTQwNCByZWdpc3RyeSBcdTU0MENcdThERUZcdTVGODRcdTY1MzlcdTUxOTlcdTMwMDJcclxuICogcGFja3VtZW50IFx1OTFDQ1x1NzY4NCBkaXN0LnRhcmJhbGwgXHU2MDUyXHU2MzA3XHU1NDExXHU1M0QxXHU1RTAzXHU2RTkwKHJlZ2lzdHJ5Lm5wbWpzLm9yZyksXHU1NkZEXHU1MTg1XHU3RjUxXHU3RURDXHJcbiAqIFx1NEUwRFx1NTNFRlx1OEZCRVx1NjVGNlx1NjMwOSByZWdpc3RyeSBcdTUyMTdcdTg4NjhcdTY1MzlcdTUxOTkgaG9zdChcdThERUZcdTVGODRcdTRFMERcdTUzRDggXHUyMDE0XHUyMDE0IG5wbW1pcnJvciBcdTRFMEUgbnBtanMgXHU1NDBDXHU2Nzg0KVx1MzAwMlxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHRhcmJhbGxNaXJyb3JzKHRhcmJhbGw6IHN0cmluZywgcmVnaXN0cmllczogc3RyaW5nW10pOiBzdHJpbmdbXSB7XHJcbiAgY29uc3QgbSA9IFJFR0lTVFJZX0hPU1RTLmV4ZWModGFyYmFsbCk7XHJcbiAgY29uc3QgcGF0aCA9IG0/LlsyXSA/PyAnJztcclxuICBjb25zdCBvdXQgPSBbdGFyYmFsbF07XHJcbiAgZm9yIChjb25zdCByZWcgb2YgcmVnaXN0cmllcykge1xyXG4gICAgY29uc3QgYmFzZSA9IHJlZy5yZXBsYWNlKC9cXC8rJC8sICcnKTtcclxuICAgIGlmIChiYXNlID09PSBtPy5bMV0pIGNvbnRpbnVlO1xyXG4gICAgY29uc3QgdSA9IGAke2Jhc2V9LyR7cGF0aH1gO1xyXG4gICAgaWYgKCFvdXQuaW5jbHVkZXModSkpIG91dC5wdXNoKHUpO1xyXG4gIH1cclxuICByZXR1cm4gb3V0O1xyXG59XHJcblxyXG4vKiogXHU1MzA1XHU1NzI4IG5vZGVfbW9kdWxlcyBcdTRFMEJcdTc2ODRcdTc2RUVcdTY4MDdcdTc2RUVcdTVGNTUoc2NvcGVkIFx1NTMwNVx1NEZERFx1NjMwMSBAc2NvcGUvbmFtZSBcdTRFMjRcdTdFQTcpXHUzMDAyICovXHJcbmV4cG9ydCBmdW5jdGlvbiBtb2R1bGVEaXIocHJlZml4OiBzdHJpbmcsIG5hbWU6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgY29uc3QgcGFydHMgPSBuYW1lLnNwbGl0KCcvJykuZmlsdGVyKChwKSA9PiBwICE9PSAnJyAmJiBwICE9PSAnLicpO1xyXG4gIGlmIChuYW1lLnN0YXJ0c1dpdGgoJ0AnKSAmJiBwYXJ0cy5sZW5ndGggIT09IDIpIHRocm93IG5ldyBFcnJvcihgaW52YWxpZCBwYWNrYWdlIG5hbWU6ICR7bmFtZX1gKTtcclxuICBpZiAoIW5hbWUuc3RhcnRzV2l0aCgnQCcpICYmIHBhcnRzLmxlbmd0aCAhPT0gMSkgdGhyb3cgbmV3IEVycm9yKGBpbnZhbGlkIHBhY2thZ2UgbmFtZTogJHtuYW1lfWApO1xyXG4gIHJldHVybiBbLi4ucGFydHNdLnJlZHVjZSgoZGlyLCBwKSA9PiBgJHtkaXJ9XFxcXCR7cH1gLCBgJHtwcmVmaXh9XFxcXG5vZGVfbW9kdWxlc2ApO1xyXG59XHJcblxyXG4vKiAtLS0tIGludGVncml0eSAtLS0tICovXHJcblxyXG4vKiogbnBtIGRpc3QuaW50ZWdyaXR5KCdzaGE1MTItYmFzZTY0JykgXHU2ODIxXHU5QThDO1x1NEUwRFx1NTMzOVx1OTE0RFx1OEZENFx1NTZERSBmYWxzZShcdTY3MkFcdTc3RTVcdTdCOTdcdTZDRDVcdThGRDRcdTU2REUgdHJ1ZSBcdTY1M0VcdTg4NEMpXHUzMDAyICovXHJcbmV4cG9ydCBmdW5jdGlvbiBpbnRlZ3JpdHlPayhkYXRhOiBCdWZmZXIsIGludGVncml0eT86IHN0cmluZyk6IGJvb2xlYW4ge1xyXG4gIGlmIChpbnRlZ3JpdHkgPT09IHVuZGVmaW5lZCB8fCBpbnRlZ3JpdHkgPT09ICcnKSByZXR1cm4gdHJ1ZTtcclxuICBjb25zdCBtID0gL15zaGE1MTItKFtBLVphLXowLTkrLz1dKykkLy5leGVjKGludGVncml0eS50cmltKCkpO1xyXG4gIGlmIChtID09PSBudWxsKSByZXR1cm4gdHJ1ZTtcclxuICByZXR1cm4gY3JlYXRlSGFzaCgnc2hhNTEyJykudXBkYXRlKGRhdGEpLmRpZ2VzdCgnYmFzZTY0JykgPT09IG1bMV07XHJcbn1cclxuXHJcbi8qKiBcdTRFQkFcdTdDN0JcdTUzRUZcdThCRkJcdTVCNTdcdTgyODIoXHU1Qjg5XHU4OEM1XHU4RkRCXHU1RUE2XHU2NTg3XHU2ODQ4XHU3NTI4KVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gYnl0ZXNMYWJlbChuOiBudW1iZXIpOiBzdHJpbmcge1xyXG4gIGlmIChuIDwgMTAyNCkgcmV0dXJuIGAke259IEJgO1xyXG4gIGlmIChuIDwgMTAyNCAqIDEwMjQpIHJldHVybiBgJHsobiAvIDEwMjQpLnRvRml4ZWQoMCl9IEtCYDtcclxuICByZXR1cm4gYCR7KG4gLyAxMDI0IC8gMTAyNCkudG9GaXhlZCgxKX0gTUJgO1xyXG59XHJcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFjQSxTQUFTLE9BQUFBLE1BQUssZUFBZSxRQUFRLFNBQVMsU0FBUyxPQUFPLE1BQU0sY0FBYyxNQUFNLGFBQWEsbUJBQW1CO0FBQ3hILFNBQVMsUUFBQUMsT0FBTSxTQUFTLFVBQVUsWUFBWSxlQUFlO0FBQzdELFNBQVMsY0FBQUMsYUFBWSxnQkFBQUMsZUFBYyxvQkFBb0I7QUFDdkQsU0FBUyxhQUFBQyxZQUFXLGdCQUFnQjtBQUNwQyxTQUFTLFdBQUFDLFVBQVMseUJBQXlCO0FB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QUFhLEdBQUcsV0FBVyxFQUFFLE9BQU8sUUFBUSxFQUFFLFFBQVEsRUFBRTtBQUFBLElBQ2pHLENBQUM7QUFFRCxRQUFJLFNBQVM7QUFDYixlQUFXLENBQUMsTUFBTSxJQUFJLE1BQU0sS0FBSyxTQUFTO0FBQ3hDLGNBQVEsSUFBSSxpQkFBaUIsS0FBSyxTQUFTLE1BQU0sTUFBTSxJQUFJLE1BQU0sT0FBTyxNQUFNLENBQUMsRUFBRTtBQUNqRixVQUFJLENBQUMsR0FBSSxXQUFVO0FBQUEsSUFDckI7QUFDQSxZQUFRLElBQUksOEJBQThCLFFBQVEsU0FBUyxNQUFNLElBQUksUUFBUSxNQUFNLEVBQUU7QUFDckYsSUFBQUEsS0FBSSxLQUFLLFdBQVcsSUFBSSxJQUFJLENBQUM7QUFBQSxFQUMvQjtBQUdBLEVBQUFBLEtBQUksR0FBRyxlQUFlLENBQUMsTUFBTTtBQUMzQixRQUFJLGVBQWUsUUFBUSxXQUFXLFVBQVUsV0FBVztBQUN6RCxRQUFFLGVBQWU7QUFDakIsZ0JBQVUsTUFBTTtBQUNoQixXQUFLLFdBQVcsS0FBSyxFQUFFLFFBQVEsTUFBTUEsS0FBSSxLQUFLLENBQUM7QUFBQSxJQUNqRDtBQUFBLEVBQ0YsQ0FBQztBQUNELEVBQUFBLEtBQUksR0FBRyxxQkFBcUIsTUFBTTtBQUNoQyxRQUFJLFFBQVEsYUFBYSxTQUFVLENBQUFBLEtBQUksS0FBSztBQUFBLEVBQzlDLENBQUM7QUFDSDtBQTEyQ1c7QUF5QkE7QUFPQTtBQWVBO0FBNEJBO0FBMEZBO0FBbUJBO0FBNEJBO0FBNERBO0FBVUE7QUFnQkE7QUFnQkE7QUFlQTtBQTJFQTtBQU9BO0FBUUE7QUFXQTtBQWtFQTtBQUtBO0FBaUJBO0FBS0E7QUFZQTtBQW9CQTtBQW1IQTtBQVlBO0FBV0E7IiwKICAibmFtZXMiOiBbImFwcCIsICJqb2luIiwgImV4aXN0c1N5bmMiLCAicmVhbHBhdGhTeW5jIiwgIndyaXRlRmlsZSIsICJob21lZGlyIiwgInNwYXduIiwgInBhdGhUb0ZpbGVVUkwiLCAicmVzb2x2ZSIsICJyYW5kb21VVUlEIiwgInJhbmRvbVVVSUQiLCAicmVzb2x2ZSIsICJzcGF3biIsICJqb2luIiwgImpvaW4iLCAicmVzb2x2ZSIsICJzcGF3biIsICJqb2luIiwgImpvaW4iLCAiYXBwIiwgInB1c2hFdmVudCIsICJub3RpZnlFdmVudCIsICJmb2N1c01haW5XaW5kb3ciLCAic2V0dXBUcmF5IiwgImFwcGx5Q2hyb21lIiwgImFwcGx5VXBkYXRlIiwgInNwYXduIiwgImJ1aWxkQXBwTWVudSIsICJwb3B1cE1haW5NZW51IiwgIndlYkF1dG9zdGFydEluc3RhbGxlZCIsICJleGlzdHNTeW5jIiwgImxhbklwT2YiLCAiY2xpRW50cnlPZiIsICJyZXBvUm9vdE9mIiwgInBrZ05hbWVBdCIsICJydW5DbGkiLCAiYnJvYWRjYXN0SG9zdFN0YXRlIiwgInBrZ1ZlcnNpb25BdCIsICJlbnRyeUZyb21DbGlEaXIiLCAiZGV0ZWN0RXh0ZXJuYWxSdW50aW1lIiwgInJlYWxwYXRoU3luYyIsICJob21lZGlyIiwgImRldGVjdFJlYWxFbnRyeSIsICJidW5kbGVkUnVudGltZVBhdGgiLCAiYnVuZGxlZFJ1bnRpbWVJbmZvIiwgIm5wbU9uUGF0aCIsICJ3aXphcmRTdXBwcmVzc2VkIiwgInNlbmRlclRydXN0ZWQiLCAiaG9zdENhbGwiLCAicmVnaXN0ZXJJcGMiLCAid3JpdGVGaWxlIiwgInciLCAicGF0aFRvRmlsZVVSTCIsICJhcHAyIl0KfQo=
