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
      // UIVERIFY 窄屏验收(wizard 360×640 全元素可达)需临时放宽下限;
      // 正常使用仍锁 960×600。
      minWidth: process.env.HMH_DESKTOP_UIVERIFY === "1" ? 320 : 960,
      minHeight: process.env.HMH_DESKTOP_UIVERIFY === "1" ? 360 : 600,
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vZWxlY3Ryb24vbWFpbi9pbmRleC50cyIsICIuLi8uLi8uLi8uLi9wYWNrYWdlcy9ob3N0LWFkYXB0ZXIvc3JjL3N1cGVydmlzb3IudHMiLCAiLi4vLi4vLi4vLi4vcGFja2FnZXMvY29udHJhY3RzL3NyYy9ldmVudC50cyIsICIuLi8uLi8uLi8uLi9wYWNrYWdlcy9jb250cmFjdHMvc3JjL2Vycm9yLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2NvbnRyYWN0cy9zcmMvZ3VhcmRzLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2hvc3QtYWRhcHRlci9zcmMvY2xpZW50LnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2hvc3QtYWRhcHRlci9zcmMvZmFrZS1ob3N0LnRzIiwgIi4uLy4uL2VsZWN0cm9uL21haW4vdWl2ZXJpZnkudHMiLCAiLi4vLi4vZWxlY3Ryb24vbWFpbi9pbnN0YWxsZXIudHMiLCAiLi4vLi4vLi4vLi4vcGFja2FnZXMvY2xpLWluc3RhbGxlci9zcmMvaW5kZXgudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxyXG4gKiBITUggRGVza3RvcCBcdTIwMTQgRWxlY3Ryb24gXHU0RTNCXHU4RkRCXHU3QTBCKEFEUi0wMDEvMDAzLzAwNClcdTMwMDJcclxuICpcclxuICogXHU1Qjg5XHU1MTY4XHU0RTBEXHU1M0Q4XHU5MUNGKFx1NUYwMFx1NTNEMVx1OEJBMVx1NTIxMiBNMCBcdTUxRkFcdTUzRTNcdTk1RTggKyBFbGVjdHJvbiBcdTVCOThcdTY1QjlcdTVCODlcdTUxNjhcdTZFMDVcdTUzNTUpOlxyXG4gKiAgLSByZW5kZXJlcjpjb250ZXh0SXNvbGF0aW9uICsgc2FuZGJveCArIFx1Nzk4MSBub2RlSW50ZWdyYXRpb24sXHU0RTI1XHU2ODNDIENTUDtcclxuICogIC0gXHU1QkZDXHU4MjJBL1x1NjVCMFx1N0E5N1x1NTNFM1x1NEUwMFx1NUY4Qlx1NjJEMlx1N0VERChcdTUzRUFcdTUyQTBcdThGN0RcdTYyMTFcdTRFRUNcdTgxRUFcdTVERjFcdTc2ODQgcmVuZGVyZXIpO1xyXG4gKiAgLSBcdTZCQ0ZcdTY3NjEgSVBDIFx1NjgyMVx1OUE4QyBzZW5kZXIgXHU3Njg0XHU5ODc2XHU1QzQyIGZyYW1lIFVSTCBcdTVDNUVcdTRFOEVcdTY3MkNcdTVFOTRcdTc1MjgsXHU5MDFBXHU5MDUzXHU3NjdEXHU1NDBEXHU1MzU1O1xyXG4gKiAgLSBob3N0IHRva2VuIFx1NTNFQVx1NUI1OFx1NTcyOFx1NEU4RVx1NjcyQ1x1OEZEQlx1N0EwQlx1NEUwRVx1NUI1MFx1OEZEQlx1N0EwQiBlbnYsXHU2NUU1XHU1RkQ3XHU4RjkzXHU1MUZBXHU1MjREXHU1MTQ4XHU4MTMxXHU2NTRGO1xyXG4gKiAgLSBcdTUzNTVcdTVCOUVcdTRGOEJcdTk1MDE7XHU5MDAwXHU1MUZBXHU2NUY2XHU1M0VBXHU1MDVDXHU2QjYyXHU4MUVBXHU1REYxIHNwYXduIFx1NzY4NCBob3N0KFx1NEYxOFx1OTZDNVx1MjE5Mlx1NTE1Q1x1NUU5NSBraWxsKVx1MzAwMlxyXG4gKlxyXG4gKiBcdTk2MzZcdTZCQjVFKDIwMjYtMTAtMTApOm1haW4gXHU2MzAxXHU2NzA5IERlc2t0b3BIb3N0Q2xpZW50LFNTRSBcdTRGRTFcdTVDMDFcdTZENDEoZXZlbnQ6IGhtaClcclxuICogXHU3RUNGIDUwbXMgXHU2Mjc5XHU5MUNGXHU2M0E4XHU3RUQ5IHJlbmRlcmVyO3NlbmRUYXNrL2FwcHJvdmUvaW50ZXJydXB0L3Nlc3Npb25zIFx1NTE2OFx1OTBFOFx1OEY2Q1x1NTNEMVxyXG4gKiBcdTdFRDkgaG9zdCBcdTIwMTRcdTIwMTQgZmFrZSBcdTRFMEVcdTc3MUZcdTVCOUUgaG1oYXJuZXNzIGRlc2t0b3AtaG9zdCBcdThENzBcdTU0MENcdTRFMDBcdTY3NjFcdTRFRTNcdTc4MDFcdThERUZcdTVGODRcdTMwMDJcclxuICovXHJcbmltcG9ydCB7IGFwcCwgQnJvd3NlcldpbmRvdywgZGlhbG9nLCBpcGNNYWluLCBzZXNzaW9uLCBzaGVsbCwgVHJheSwgTm90aWZpY2F0aW9uLCBNZW51LCBuYXRpdmVJbWFnZSwgbmF0aXZlVGhlbWUgfSBmcm9tICdlbGVjdHJvbic7XHJcbmltcG9ydCB7IGpvaW4sIGRpcm5hbWUsIGJhc2VuYW1lLCBpc0Fic29sdXRlLCByZXNvbHZlIH0gZnJvbSAnbm9kZTpwYXRoJztcclxuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhbHBhdGhTeW5jLCByZWFkRmlsZVN5bmMgfSBmcm9tICdub2RlOmZzJztcclxuaW1wb3J0IHsgd3JpdGVGaWxlLCByZWFkRmlsZSB9IGZyb20gJ25vZGU6ZnMvcHJvbWlzZXMnO1xyXG5pbXBvcnQgeyBob21lZGlyLCBuZXR3b3JrSW50ZXJmYWNlcyB9IGZyb20gJ25vZGU6b3MnO1xyXG5pbXBvcnQgeyBleGVjRmlsZVN5bmMsIHNwYXduIH0gZnJvbSAnbm9kZTpjaGlsZF9wcm9jZXNzJztcclxuaW1wb3J0IHsgcGF0aFRvRmlsZVVSTCB9IGZyb20gJ25vZGU6dXJsJztcclxuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gJ25vZGU6Y3J5cHRvJztcclxuaW1wb3J0IHsgRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yLCBEZXNrdG9wSG9zdENsaWVudCwgZW52ZWxvcGVGcm9tRnJhbWUsIHR5cGUgSG9zdFN0YXRlIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2hvc3QtYWRhcHRlcic7XHJcbmltcG9ydCB7IGlzRXZlbnRFbnZlbG9wZSwgdHlwZSBFdmVudEVudmVsb3BlIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyc7XHJcbmltcG9ydCB7IGF0dGFjaFVpVmVyaWZ5IH0gZnJvbSAnLi91aXZlcmlmeS50cyc7XHJcbmltcG9ydCB7IGluc3RhbGxUYXJnZXQsIHJlc29sdmVJbnN0YWxsZWRFbnRyeSwgc3RhcnRDbGlJbnN0YWxsLCB0eXBlIEluc3RhbGxQcm9ncmVzcyB9IGZyb20gJy4vaW5zdGFsbGVyLnRzJztcclxuXHJcbmNvbnN0IGhlcmUgPSBpbXBvcnQubWV0YS5kaXJuYW1lID8/ICcuJztcclxuY29uc3QgaXNEZXYgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9ERVYgPT09ICcxJztcclxuY29uc3QgcmVuZGVyZXJEZXZVcmwgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9SRU5ERVJFUl9VUkwgPz8gJyc7XHJcbmNvbnN0IHByZWxvYWRQYXRoID0gam9pbihoZXJlLCAnLi4vcHJlbG9hZC9pbmRleC5janMnKTtcclxuXHJcbi8qIC0tLS0gXHU2NUU1XHU1RkQ3XHU4MTMxXHU2NTRGOnRva2VuL2F1dGhvcml6YXRpb24gXHU2QzM4XHU0RTBEXHU4RkRCXHU2M0E3XHU1MjM2XHU1M0YwIC0tLS0gKi9cclxuY29uc3Qgc2VjcmV0czogc3RyaW5nW10gPSBbXTtcclxuZnVuY3Rpb24gcmVkYWN0KHM6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgbGV0IG91dCA9IHM7XHJcbiAgZm9yIChjb25zdCBzZWMgb2Ygc2VjcmV0cykge1xyXG4gICAgaWYgKHNlYy5sZW5ndGggPj0gOCkgb3V0ID0gb3V0LnNwbGl0KHNlYykuam9pbignW3JlZGFjdGVkXScpO1xyXG4gIH1cclxuICByZXR1cm4gb3V0O1xyXG59XHJcbmZ1bmN0aW9uIGxvZ0luZm8odGFnOiBzdHJpbmcsIG1zZzogc3RyaW5nKTogdm9pZCB7XHJcbiAgY29uc29sZS5sb2coYFtobWgtZGVza3RvcDoke3RhZ31dICR7cmVkYWN0KG1zZyl9YCk7XHJcbn1cclxuXHJcbi8qIC0tLS0gXHU1MzU1XHU1QjlFXHU0RjhCIC0tLS0gKi9cclxuaWYgKCFhcHAucmVxdWVzdFNpbmdsZUluc3RhbmNlTG9jaygpKSB7XHJcbiAgYXBwLnF1aXQoKTtcclxufSBlbHNlIHtcclxuICBhcHAub24oJ3NlY29uZC1pbnN0YW5jZScsICgpID0+IHtcclxuICAgIGNvbnN0IHdpbiA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpWzBdO1xyXG4gICAgaWYgKHdpbikge1xyXG4gICAgICBpZiAod2luLmlzTWluaW1pemVkKCkpIHdpbi5yZXN0b3JlKCk7XHJcbiAgICAgIHdpbi5mb2N1cygpO1xyXG4gICAgfVxyXG4gIH0pO1xyXG5cclxuICAvKiAtLS0tIGhvc3QgXHU3NkQxXHU3QkExICsgXHU2ODY1XHU1QkEyXHU2MjM3XHU3QUVGIC0tLS0gKi9cclxuICBpbnRlcmZhY2UgQnJpZGdlU25hcHNob3Qge1xyXG4gICAgaG9zdFN0YXRlOiBIb3N0U3RhdGU7XHJcbiAgICBob3N0UG9ydDogbnVtYmVyIHwgbnVsbDtcclxuICAgIGhvc3RWZXJzaW9uOiBzdHJpbmcgfCBudWxsO1xyXG4gICAgbGFzdEVycm9yOiBzdHJpbmcgfCBudWxsO1xyXG4gICAgbW9kZTogJ2Zha2UnIHwgJ3JlYWwnO1xyXG4gICAgcnVudGltZUVudHJ5OiBzdHJpbmcgfCBudWxsO1xyXG4gIH1cclxuICBsZXQgc3VwZXJ2aXNvcjogRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yIHwgbnVsbCA9IG51bGw7XHJcbiAgbGV0IGNsaWVudDogRGVza3RvcEhvc3RDbGllbnQgfCBudWxsID0gbnVsbDtcclxuICBsZXQgYnJpZGdlOiBCcmlkZ2VTbmFwc2hvdCA9IHsgaG9zdFN0YXRlOiAnc3RvcHBlZCcsIGhvc3RQb3J0OiBudWxsLCBob3N0VmVyc2lvbjogbnVsbCwgbGFzdEVycm9yOiBudWxsLCBtb2RlOiAnZmFrZScsIHJ1bnRpbWVFbnRyeTogbnVsbCB9O1xyXG4gIC8qKiBcdTRFOEJcdTRFRjZcdTYyNzlcdTkxQ0ZcdTdGMTNcdTUxQjI6XHU5QUQ4XHU5ODkxIFNTRSBcdTRFMERcdTkwMTBcdTY3NjFcdThGQzcgSVBDLDUwbXMgXHU2Mjc5XHU5MUNGIGZsdXNoKFx1NkUzMlx1NjdEM1x1NEUwRFx1NTM2MSlcdTMwMDIgKi9cclxuICBsZXQgZXZlbnRCdWZmZXI6IEV2ZW50RW52ZWxvcGVbXSA9IFtdO1xyXG4gIGxldCBmbHVzaFRpbWVyOiBOb2RlSlMuVGltZW91dCB8IG51bGwgPSBudWxsO1xyXG4gIGxldCBzc2VBYm9ydDogQWJvcnRDb250cm9sbGVyIHwgbnVsbCA9IG51bGw7XHJcbiAgbGV0IGxhc3RFdmVudElkID0gJyc7XHJcbiAgLyoqIFx1NjcyQVx1NzdFNS9cdTc1NzhcdTVGNjJcdTRGRTFcdTVDMDFcdThCQTFcdTY1NzAoU0NIRU1BX01JU01BVENIIFx1OTc2Mlx1NTQxMVx1OEJDQVx1NjVBRCxcdTRFMERcdTVEMjkpXHUzMDAyICovXHJcbiAgbGV0IGRyb3BwZWRGcmFtZXMgPSAwO1xyXG5cclxuICBmdW5jdGlvbiBwdXNoRXZlbnQoZW52OiBFdmVudEVudmVsb3BlKTogdm9pZCB7XHJcbiAgICBldmVudEJ1ZmZlci5wdXNoKGVudik7XHJcbiAgICBpZiAoZXZlbnRCdWZmZXIubGVuZ3RoID4gMl8wMDApIGV2ZW50QnVmZmVyLnNwbGljZSgwLCBldmVudEJ1ZmZlci5sZW5ndGggLSAyXzAwMCk7XHJcbiAgICBpZiAoZmx1c2hUaW1lciA9PT0gbnVsbCkge1xyXG4gICAgICBmbHVzaFRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XHJcbiAgICAgICAgZmx1c2hUaW1lciA9IG51bGw7XHJcbiAgICAgICAgY29uc3QgYmF0Y2ggPSBldmVudEJ1ZmZlcjtcclxuICAgICAgICBldmVudEJ1ZmZlciA9IFtdO1xyXG4gICAgICAgIGZvciAoY29uc3QgdyBvZiBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKSkge1xyXG4gICAgICAgICAgaWYgKCF3LmlzRGVzdHJveWVkKCkpIHcud2ViQ29udGVudHMuc2VuZCgnYnJpZGdlOmV2ZW50LWJhdGNoJywgYmF0Y2gpO1xyXG4gICAgICAgIH1cclxuICAgICAgfSwgNTApO1xyXG4gICAgfVxyXG4gICAgbm90aWZ5RXZlbnQoZW52KTtcclxuICB9XHJcblxyXG4gIC8qIC0tLS0gXHU3Q0ZCXHU3RURGXHU2MjU4XHU3NkQ4ICsgXHU5MDFBXHU3N0U1KDAzIFx1NTNGNyBcdTAwQTdcdTRFMDA6XHU2ODRDXHU5NzYyXHU0RUE3XHU1NEMxXHU5NzAwXHU4OTgxXHU3Q0ZCXHU3RURGXHU2MjU4XHU3NkQ4XHUzMDAxXHU5MDFBXHU3N0U1KSAtLS0tXHJcbiAgICAgXHU1QkExXHU2Mjc5XHU3QjQ5XHU1Rjg1XHU1RkM1XHU5ODdCXHU2MjUzXHU2MjcwKFx1NzUyOFx1NjIzN1x1NUZDNVx1OTg3Qlx1NTFCM1x1N0I1Nik7XHU1QjhDXHU2MjEwL1x1NTkzMVx1OEQyNVx1NEVDNVx1NTcyOFx1N0E5N1x1NTNFM1x1NTkzMVx1NzEyNlx1NjVGNlx1NjNEMFx1OTE5Mlx1MzAwMiAqL1xyXG4gIGNvbnN0IFRSQVlfSUNPTl9CQVNFNjQgPSAnaVZCT1J3MEtHZ29BQUFBTlNVaEVVZ0FBQUJBQUFBQVFDQVlBQUFBZjgvOWhBQUFBUjBsRVFWUjRuR05nUUFQU3Nvci84V0YwOVVScnhHc1FxWm94RElFSjZEZCtCMk4waGJqRU1Xd24xUUN3SVlQVEFGeVlmZ1lNZkJpUVpBREZDWWtxU1puaXpFUkpkZ1lBbEw1cnNEYzJhVGNBQUFBQVNVVk9SSzVDWUlJPSc7XHJcbiAgbGV0IHRyYXk6IFRyYXkgfCBudWxsID0gbnVsbDtcclxuICBjb25zdCBzZW5kTWVudUFjdGlvbiA9IChhOiBzdHJpbmcpOiB2b2lkID0+IHtcclxuICAgIGZvciAoY29uc3QgdyBvZiBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKSkge1xyXG4gICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCdtZW51OmFjdGlvbicsIGEpO1xyXG4gICAgfVxyXG4gIH07XHJcbiAgZnVuY3Rpb24gZm9jdXNNYWluV2luZG93KCk6IHZvaWQge1xyXG4gICAgY29uc3Qgd2luID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkuZmluZCgodykgPT4gIXcuaXNEZXN0cm95ZWQoKSk7XHJcbiAgICBpZiAod2luID09PSB1bmRlZmluZWQpIHJldHVybjtcclxuICAgIGlmICh3aW4uaXNNaW5pbWl6ZWQoKSkgd2luLnJlc3RvcmUoKTtcclxuICAgIHdpbi5zaG93KCk7XHJcbiAgICB3aW4uZm9jdXMoKTtcclxuICB9XHJcbiAgZnVuY3Rpb24gc2V0dXBUcmF5KCk6IHZvaWQge1xyXG4gICAgaWYgKHRyYXkgIT09IG51bGwpIHJldHVybjtcclxuICAgIGNvbnN0IGljb24gPSBuYXRpdmVJbWFnZS5jcmVhdGVGcm9tRGF0YVVSTChgZGF0YTppbWFnZS9wbmc7YmFzZTY0LCR7VFJBWV9JQ09OX0JBU0U2NH1gKTtcclxuICAgIHRyYXkgPSBuZXcgVHJheShpY29uKTtcclxuICAgIHRyYXkuc2V0VG9vbFRpcCgnSE1IIERlc2t0b3AnKTtcclxuICAgIHRyYXkub24oJ2NsaWNrJywgZm9jdXNNYWluV2luZG93KTtcclxuICAgIHRyYXkuc2V0Q29udGV4dE1lbnUoTWVudS5idWlsZEZyb21UZW1wbGF0ZShbXHJcbiAgICAgIHsgbGFiZWw6ICdcdTY1QjBcdTVFRkFcdTRGMUFcdThCREQnLCBjbGljazogKCk6IHZvaWQgPT4gc2VuZE1lbnVBY3Rpb24oJ25ldy1zZXNzaW9uJykgfSxcclxuICAgICAgeyBsYWJlbDogJ1x1NjYzRVx1NzkzQVx1NEUzQlx1N0E5N1x1NTNFMycsIGNsaWNrOiBmb2N1c01haW5XaW5kb3cgfSxcclxuICAgICAgeyBsYWJlbDogJ1x1NjI0Qlx1NjczQVx1OEZEQ1x1N0EwQlx1NjNBN1x1NTIzNicsIGNsaWNrOiAoKTogdm9pZCA9PiBzZW5kTWVudUFjdGlvbignb3Blbi1yZW1vdGUnKSB9LFxyXG4gICAgICB7IGxhYmVsOiAnXHU4QkJFXHU3RjZFJywgY2xpY2s6ICgpOiB2b2lkID0+IHNlbmRNZW51QWN0aW9uKCdvcGVuLXNldHRpbmdzJykgfSxcclxuICAgICAgeyB0eXBlOiAnc2VwYXJhdG9yJyB9LFxyXG4gICAgICB7IGxhYmVsOiAnXHU5MDAwXHU1MUZBJywgY2xpY2s6ICgpOiB2b2lkID0+IHsgYXBwLnF1aXQoKTsgfSB9LFxyXG4gICAgXSkpO1xyXG4gIH1cclxuICBmdW5jdGlvbiBub3RpZnlFdmVudChlbnY6IEV2ZW50RW52ZWxvcGUpOiB2b2lkIHtcclxuICAgIC8vIFx1OUE4Q1x1NjUzNi9cdTYyMkFcdTU2RkUvXHU2RTMyXHU2N0QzXHU2M0EyXHU5NDg4XHU2QTIxXHU1RjBGXHU5NzU5XHU5RUQ4KFx1NEUwRFx1NUY4MFx1NzUyOFx1NjIzN1x1Njg0Q1x1OTc2Mlx1NUYzOVx1NkQ0Qlx1OEJENVx1OTAxQVx1NzdFNSlcclxuICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWSA9PT0gJzEnIHx8IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NOQVBTSE9UICE9PSB1bmRlZmluZWQgfHwgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfUkVOREVSX1RFU1QgPT09ICcxJykgcmV0dXJuO1xyXG4gICAgaWYgKCFOb3RpZmljYXRpb24uaXNTdXBwb3J0ZWQoKSkgcmV0dXJuO1xyXG4gICAgY29uc3Qgd2luID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkuZmluZCgodykgPT4gIXcuaXNEZXN0cm95ZWQoKSk7XHJcbiAgICBjb25zdCBmb2N1c2VkID0gd2luPy5pc0ZvY3VzZWQoKSA/PyBmYWxzZTtcclxuICAgIGNvbnN0IG1rID0gKHRpdGxlOiBzdHJpbmcsIGJvZHk6IHN0cmluZyk6IHZvaWQgPT4ge1xyXG4gICAgICBjb25zdCBuID0gbmV3IE5vdGlmaWNhdGlvbih7IHRpdGxlLCBib2R5LCBpY29uOiBuYXRpdmVJbWFnZS5jcmVhdGVGcm9tRGF0YVVSTChgZGF0YTppbWFnZS9wbmc7YmFzZTY0LCR7VFJBWV9JQ09OX0JBU0U2NH1gKSB9KTtcclxuICAgICAgbi5vbignY2xpY2snLCBmb2N1c01haW5XaW5kb3cpO1xyXG4gICAgICBuLnNob3coKTtcclxuICAgIH07XHJcbiAgICBpZiAoZW52LmtpbmQgPT09ICdhcHByb3ZhbC5yZXF1aXJlZCcpIHtcclxuICAgICAgY29uc3QgcCA9IGVudi5wYXlsb2FkIGFzIHsgdG9vbD86IHN0cmluZyB9O1xyXG4gICAgICBtaygnSE1IIFx1OTcwMFx1ODk4MVx1NUJBMVx1NjI3OScsIGAke1N0cmluZyhwLnRvb2wgPz8gJ1x1NjRDRFx1NEY1QycpfSBcdTdCNDlcdTVGODVcdTRGNjBcdTc2ODRcdTYyNzlcdTUxQzZgKTtcclxuICAgIH0gZWxzZSBpZiAoZW52LmtpbmQgPT09ICdydW4uY29tcGxldGVkJyAmJiAhZm9jdXNlZCkge1xyXG4gICAgICBtaygnSE1IIFx1NEVGQlx1NTJBMVx1NUI4Q1x1NjIxMCcsIGBcdTRGMUFcdThCREQgJHtlbnYuc2Vzc2lvbklkfSBcdTc2ODRcdTRFRkJcdTUyQTFcdTVERjJcdTVCOENcdTYyMTBgKTtcclxuICAgIH0gZWxzZSBpZiAoZW52LmtpbmQgPT09ICdydW4uZmFpbGVkJyAmJiAhZm9jdXNlZCkge1xyXG4gICAgICBtaygnSE1IIFx1NEVGQlx1NTJBMVx1NTkzMVx1OEQyNScsIGBcdTRGMUFcdThCREQgJHtlbnYuc2Vzc2lvbklkfSBcdTc2ODRcdTRFRkJcdTUyQTFcdTU5MzFcdThEMjUsXHU3MEI5XHU1MUZCXHU2N0U1XHU3NzBCYCk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvKiAtLS0tIFx1ODFFQVx1NUI5QVx1NEU0OVx1NjgwN1x1OTg5OFx1NjgwRigyMDI2LTEwLTExIFx1NzUyOFx1NjIzN1x1NTNDRFx1OTk4ODpcdTRFQUVcdTgyNzJcdTZBMjFcdTVGMEZcdTk4NzZcdTkwRThcdTlFRDFcdTY3NjE9XHU1MzlGXHU3NTFGXHU4M0RDXHU1MzU1XHU2ODBGXHJcbiAgICAgXHU0RTBEXHU4RERGXHU0RTNCXHU5ODk4O1x1ODNEQ1x1NTM1NVx1NEUwRVx1OEJCRVx1N0Y2RVx1OTFDRFx1NTkwRCkgLS0tLSBcdTY1QjlcdTY4NDg6XHU5NjkwXHU4NUNGXHU1RjBGXHU2ODA3XHU5ODk4XHU2ODBGICsgdGl0bGVCYXJPdmVybGF5XHJcbiAgICAgKFx1OTg5Q1x1ODI3Mlx1OTY4Rlx1NEUzQlx1OTg5OCksXHU4M0RDXHU1MzU1XHU2ODBGIGF1dG9IaWRlKEFsdCBcdTU0N0NcdTUxRkEpXHU0RTE0XHU3Q0JFXHU3QjgwXHU0RTNBXHU3Q0ZCXHU3RURGXHU3RUE3XHU4MEZEXHU1MjlCO1xyXG4gICAgIFx1NUUzOFx1NzUyOFx1NTJBOFx1NEY1Q1x1OEQ3MCByZW5kZXJlciBcdTY4MDdcdTk4OThcdTY4MEYgXHUyNjMwIFx1NEUzQlx1ODNEQ1x1NTM1NShcdTU1MkZcdTRFMDBcdTUxNjVcdTUzRTMpXHUzMDAyICovXHJcbiAgLy8gdjQgRFNIIFx1OEJCRVx1OEJBMVx1OEJFRFx1OEEwMDpvdmVybGF5IFx1ODI3Mlx1OERERlx1OTY4RiB0aXRsZWJhciBcdTc2ODQgYmctbGF5ZXItMShcdTZENDUgI2ZmZi9cdTZERjEgIzE2MTgxZClcclxuICBjb25zdCBjaHJvbWVGb3IgPSAoZGFyazogYm9vbGVhbik6IHsgY29sb3I6IHN0cmluZzsgc3ltYm9sQ29sb3I6IHN0cmluZyB9ID0+XHJcbiAgICBkYXJrID8geyBjb2xvcjogJyMxNjE4MWQnLCBzeW1ib2xDb2xvcjogJyNmNWY2ZjgnIH0gOiB7IGNvbG9yOiAnI2ZmZmZmZicsIHN5bWJvbENvbG9yOiAnIzBmMTExNScgfTtcclxuICBmdW5jdGlvbiBhcHBseUNocm9tZShkYXJrOiBib29sZWFuKTogdm9pZCB7XHJcbiAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcclxuICAgICAgaWYgKCF3LmlzRGVzdHJveWVkKCkpIHtcclxuICAgICAgICB0cnkgeyB3LnNldFRpdGxlQmFyT3ZlcmxheShjaHJvbWVGb3IoZGFyaykpOyB9IGNhdGNoIHsgLyogXHU0RUM1IFdpbmRvd3MgXHU2NTJGXHU2MzAxICovIH1cclxuICAgICAgfVxyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgLyogLS0tLSBcdTVFOTRcdTc1MjhcdTUxODVcdTY2RjRcdTY1QjAoMjAyNi0xMC0yNjpcdTgxRUFcdTc4MTRcdThGN0JcdTkxQ0ZcdTY2RjRcdTY1QjBcdTU2NjgsXHU5NkY2XHU0RjlEXHU4RDU2O0dpdEh1YiBSZWxlYXNlcyBcdTkwMUFcdTkwNTMpXHJcbiAgICAgXHU2RDQxXHU3QTBCOlx1MjYzMFwiXHU2OEMwXHU2N0U1XHU2NkY0XHU2NUIwXCJcdTIxOTIgZmV0Y2ggbGF0ZXN0IHJlbGVhc2UgdGFnIFx1MjE5MiBcdTZCRDRcdTcyNDhcdTY3MkMgXHUyMTkyIFx1NTQwRVx1NTNGMFx1NEUwQlx1OEY3RCBTZXR1cFxyXG4gICAgIGV4ZSBcdTUyMzBcdTRFMzRcdTY1RjZcdTc2RUVcdTVGNTUgXHUyMTkyIFx1ODNEQ1x1NTM1NVx1NTNEOFwiXHU5MUNEXHU1NDJGXHU1RTc2XHU1Qjg5XHU4OEM1XHU2NkY0XHU2NUIwXCJcdTIxOTIgXHU5MDAwXHU1MUZBXHU1RTk0XHU3NTI4XHU1NDBFIE5TSVMgL1MgL0Q9XHU1MzlGXHU3NkVFXHU1RjU1XHJcbiAgICAgXHU5NzU5XHU5RUQ4XHU4OTg2XHU3NkQ2XHU1Qjg5XHU4OEM1KFx1NEUwQlx1NkIyMVx1NTQyRlx1NTJBOFx1NTM3M1x1NjVCMFx1NzI0OClcdTMwMDJcdTY1RTBcdTdCN0VcdTU0MERcdThCQzFcdTRFNjZcdTk2MzZcdTZCQjVcdTUzRUZcdTc1Mjg7XHU2QjYzXHU1RjBGXHU3QjdFXHU1NDBEXHU1NDBFXHU1M0VGXHU1MkEwXHU2ODIxXHU5QThDXHUzMDAyICovXHJcbiAgY29uc3QgVVBEQVRFX1JFUE8gPSAnc3dzZ2JsL2htaC1kZXNrdG9wJztcclxuICBpbnRlcmZhY2UgVXBkYXRlU3RhdGUgeyBjaGVja2luZzogYm9vbGVhbjsgY3VycmVudFZlcnNpb246IHN0cmluZzsgbGF0ZXN0OiBzdHJpbmcgfCBudWxsOyBub3Rlczogc3RyaW5nOyBkb3dubG9hZGVkOiBib29sZWFuOyBlcnJvcjogc3RyaW5nIH1cclxuICBsZXQgdXBkYXRlU3RhdGU6IFVwZGF0ZVN0YXRlID0geyBjaGVja2luZzogZmFsc2UsIGN1cnJlbnRWZXJzaW9uOiBhcHAuZ2V0VmVyc2lvbigpLCBsYXRlc3Q6IG51bGwsIG5vdGVzOiAnJywgZG93bmxvYWRlZDogZmFsc2UsIGVycm9yOiAnJyB9O1xyXG4gIGxldCBpbnN0YWxsZXJQYXRoOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcclxuICBjb25zdCBidW1wVXBkYXRlID0gKHBhdGNoOiBQYXJ0aWFsPFVwZGF0ZVN0YXRlPik6IHZvaWQgPT4ge1xyXG4gICAgdXBkYXRlU3RhdGUgPSB7IC4uLnVwZGF0ZVN0YXRlLCAuLi5wYXRjaCB9O1xyXG4gICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XHJcbiAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ3VwZGF0ZTpzdGF0ZScsIHVwZGF0ZVN0YXRlKTtcclxuICAgIH1cclxuICB9O1xyXG4gIGNvbnN0IGNtcFZlcnNpb24gPSAoYTogc3RyaW5nLCBiOiBzdHJpbmcpOiBudW1iZXIgPT4ge1xyXG4gICAgY29uc3QgcGEgPSBhLnJlcGxhY2UoL152LywgJycpLnNwbGl0KCcuJykubWFwKE51bWJlcik7XHJcbiAgICBjb25zdCBwYiA9IGIucmVwbGFjZSgvXnYvLCAnJykuc3BsaXQoJy4nKS5tYXAoTnVtYmVyKTtcclxuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgMzsgaSsrKSB7IGlmICgocGFbaV0gPz8gMCkgIT09IChwYltpXSA/PyAwKSkgcmV0dXJuIChwYVtpXSA/PyAwKSA8IChwYltpXSA/PyAwKSA/IC0xIDogMTsgfVxyXG4gICAgcmV0dXJuIDA7XHJcbiAgfTtcclxuICBhc3luYyBmdW5jdGlvbiBjaGVja0ZvclVwZGF0ZXMoKTogUHJvbWlzZTxVcGRhdGVTdGF0ZT4ge1xyXG4gICAgaWYgKHVwZGF0ZVN0YXRlLmNoZWNraW5nIHx8IHVwZGF0ZVN0YXRlLmRvd25sb2FkZWQpIHJldHVybiB1cGRhdGVTdGF0ZTtcclxuICAgIGJ1bXBVcGRhdGUoeyBjaGVja2luZzogdHJ1ZSwgZXJyb3I6ICcnIH0pO1xyXG4gICAgbG9nSW5mbygndXBkYXRlJywgYGNoZWNraW5nXHUyMDI2IChjdXJyZW50IHYke2FwcC5nZXRWZXJzaW9uKCl9KWApO1xyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3QgciA9IGF3YWl0IGZldGNoKGBodHRwczovL2FwaS5naXRodWIuY29tL3JlcG9zLyR7VVBEQVRFX1JFUE99L3JlbGVhc2VzL2xhdGVzdGAsIHtcclxuICAgICAgICBoZWFkZXJzOiB7ICd1c2VyLWFnZW50JzogJ2htaC1kZXNrdG9wLXVwZGF0ZXInIH0sXHJcbiAgICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDE1XzAwMCksXHJcbiAgICAgIH0pO1xyXG4gICAgICBpZiAoIXIub2spIHRocm93IG5ldyBFcnJvcihgR2l0SHViIEFQSSAke3Iuc3RhdHVzfWApO1xyXG4gICAgICBjb25zdCByZWwgPSAoYXdhaXQgci5qc29uKCkpIGFzIHsgdGFnX25hbWU/OiBzdHJpbmc7IGJvZHk/OiBzdHJpbmc7IGFzc2V0cz86IEFycmF5PHsgbmFtZTogc3RyaW5nOyBicm93c2VyX2Rvd25sb2FkX3VybDogc3RyaW5nOyBzaXplOiBudW1iZXIgfT4gfTtcclxuICAgICAgY29uc3QgdGFnID0gU3RyaW5nKHJlbC50YWdfbmFtZSA/PyAnJyk7XHJcbiAgICAgIGxvZ0luZm8oJ3VwZGF0ZScsIGBsYXRlc3Q9JHt0YWd9IGFzc2V0cz0keyhyZWwuYXNzZXRzID8/IFtdKS5sZW5ndGh9YCk7XHJcbiAgICAgIGJ1bXBVcGRhdGUoeyBjaGVja2luZzogZmFsc2UsIGxhdGVzdDogdGFnLCBub3RlczogU3RyaW5nKHJlbC5ib2R5ID8/ICcnKS5zbGljZSgwLCA2MDApIH0pO1xyXG4gICAgICAvLyBcdTY3MDlcdTY1QjBcdTcyNDhcdTRFMTRcdTY3MkFcdTRFMEJcdThGN0RcdThGQzcgXHUyMTkyIFx1NTQwRVx1NTNGMFx1NEUwQlx1OEY3RFx1NUI4OVx1ODhDNVx1NTMwNVxyXG4gICAgICBpZiAodGFnICE9PSAnJyAmJiBjbXBWZXJzaW9uKGFwcC5nZXRWZXJzaW9uKCksIHRhZykgPCAwICYmICF1cGRhdGVTdGF0ZS5kb3dubG9hZGVkKSB7XHJcbiAgICAgICAgdm9pZCBkb3dubG9hZEluc3RhbGxlcihyZWwuYXNzZXRzID8/IFtdKTtcclxuICAgICAgfVxyXG4gICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgIGxvZ0luZm8oJ3VwZGF0ZScsIGBjaGVjayBmYWlsZWQ6ICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTQwKX1gKTtcclxuICAgICAgYnVtcFVwZGF0ZSh7IGNoZWNraW5nOiBmYWxzZSwgZXJyb3I6IFN0cmluZyhlcnIpLnNsaWNlKDAsIDEyMCkgfSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gdXBkYXRlU3RhdGU7XHJcbiAgfVxyXG4gIGFzeW5jIGZ1bmN0aW9uIGRvd25sb2FkSW5zdGFsbGVyKGFzc2V0czogQXJyYXk8eyBuYW1lOiBzdHJpbmc7IGJyb3dzZXJfZG93bmxvYWRfdXJsOiBzdHJpbmc7IHNpemU6IG51bWJlciB9Pik6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3QgYXNzZXQgPSBhc3NldHMuZmluZCgoYSkgPT4gL15ITUgtRGVza3RvcC1TZXR1cC0uKlxcLmV4ZSQvaS50ZXN0KGEubmFtZSkpID8/IGFzc2V0cy5maW5kKChhKSA9PiBhLm5hbWUuZW5kc1dpdGgoJy5leGUnKSk7XHJcbiAgICAgIGlmIChhc3NldCA9PT0gdW5kZWZpbmVkKSB7IGJ1bXBVcGRhdGUoeyBlcnJvcjogJ3JlbGVhc2UgXHU2NUUwXHU1Qjg5XHU4OEM1XHU1MzA1XHU4RDQ0XHU0RUE3JyB9KTsgcmV0dXJuOyB9XHJcbiAgICAgIGNvbnN0IGRlc3QgPSBqb2luKGFwcC5nZXRQYXRoKCd0ZW1wJyksIGFzc2V0Lm5hbWUpO1xyXG4gICAgICAvLyBnaXRodWIuY29tIFx1NzZGNFx1OEZERVx1NTcyOFx1OTBFOFx1NTIwNlx1N0Y1MVx1N0VEQ1x1OEQ4NVx1NjVGNiBcdTIxOTIgXHU5NTVDXHU1MENGXHU1NkRFXHU5MDAwXHU5NEZFKFx1NUI5RVx1NkQ0QiBnaGZhc3QvZ2gtcHJveHkgXHU1M0VGXHU3NTI4KVxyXG4gICAgICBjb25zdCBtaXJyb3JzID0gW1xyXG4gICAgICAgIGFzc2V0LmJyb3dzZXJfZG93bmxvYWRfdXJsLFxyXG4gICAgICAgIGBodHRwczovL2doZmFzdC50b3AvJHthc3NldC5icm93c2VyX2Rvd25sb2FkX3VybH1gLFxyXG4gICAgICAgIGBodHRwczovL2doLXByb3h5LmNvbS8ke2Fzc2V0LmJyb3dzZXJfZG93bmxvYWRfdXJsfWAsXHJcbiAgICAgICAgYGh0dHBzOi8vZ2hwcm94eS5jbi8ke2Fzc2V0LmJyb3dzZXJfZG93bmxvYWRfdXJsfWAsXHJcbiAgICAgIF07XHJcbiAgICAgIGxldCBidWY6IEJ1ZmZlciB8IG51bGwgPSBudWxsO1xyXG4gICAgICBsZXQgbGFzdEVyciA9ICcnO1xyXG4gICAgICBmb3IgKGNvbnN0IHUgb2YgbWlycm9ycykge1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICBsb2dJbmZvKCd1cGRhdGUnLCBgdHJ5aW5nICR7bmV3IFVSTCh1KS5ob3N0fVx1MjAyNmApO1xyXG4gICAgICAgICAgY29uc3QgciA9IGF3YWl0IGZldGNoKHUsIHsgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDYwMF8wMDApIH0pO1xyXG4gICAgICAgICAgaWYgKCFyLm9rKSB7IGxhc3RFcnIgPSBgSFRUUCAke3Iuc3RhdHVzfWA7IGxvZ0luZm8oJ3VwZGF0ZScsIGBcdTIxOTIgSFRUUCAke3Iuc3RhdHVzfWApOyBjb250aW51ZTsgfVxyXG4gICAgICAgICAgYnVmID0gQnVmZmVyLmZyb20oYXdhaXQgci5hcnJheUJ1ZmZlcigpKTtcclxuICAgICAgICAgIGlmIChidWYubGVuZ3RoID4gMV8wMDBfMDAwKSB7IGxvZ0luZm8oJ3VwZGF0ZScsIGBcdTIxOTIgb2sgJHtNYXRoLnJvdW5kKGJ1Zi5sZW5ndGggLyAxZTYpfU1CYCk7IGJyZWFrOyB9XHJcbiAgICAgICAgICBsYXN0RXJyID0gJ1x1NTE4NVx1NUJCOVx1NUYwMlx1NUUzOCc7IGJ1ZiA9IG51bGw7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgICBjb25zdCBlID0gZXJyIGFzIHsgY2F1c2U/OiB7IGNvZGU/OiB1bmtub3duIH0gfTtcclxuICAgICAgICAgIGxhc3RFcnIgPSBTdHJpbmcoZS5jYXVzZT8uY29kZSA/PyBlcnIpLnNsaWNlKDAsIDYwKTtcclxuICAgICAgICAgIGxvZ0luZm8oJ3VwZGF0ZScsIGBcdTIxOTIgZmFpbCAke2xhc3RFcnJ9YCk7XHJcbiAgICAgICAgfVxyXG4gICAgICB9XHJcbiAgICAgIGlmIChidWYgPT09IG51bGwpIHRocm93IG5ldyBFcnJvcihgXHU1MTY4XHU5MEU4XHU0RTBCXHU4RjdEXHU5MDFBXHU5MDUzXHU1OTMxXHU4RDI1KCR7bGFzdEVycn0pYCk7XHJcbiAgICAgIGNvbnN0IHsgd3JpdGVGaWxlOiB3ZiB9ID0gYXdhaXQgaW1wb3J0KCdub2RlOmZzL3Byb21pc2VzJyk7XHJcbiAgICAgIGF3YWl0IHdmKGRlc3QsIGJ1Zik7XHJcbiAgICAgIGluc3RhbGxlclBhdGggPSBkZXN0O1xyXG4gICAgICBidW1wVXBkYXRlKHsgZG93bmxvYWRlZDogdHJ1ZSB9KTtcclxuICAgICAgbG9nSW5mbygndXBkYXRlJywgYFx1NURGMlx1NEUwQlx1OEY3RCAke2Fzc2V0Lm5hbWV9KCR7TWF0aC5yb3VuZChidWYubGVuZ3RoIC8gMWU2KX1NQikgXHUyMTkyICR7ZGVzdH1gKTtcclxuICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICBidW1wVXBkYXRlKHsgZXJyb3I6IGBcdTRFMEJcdThGN0RcdTU5MzFcdThEMjU6ICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTIwKX1gIH0pO1xyXG4gICAgfVxyXG4gIH1cclxuICBmdW5jdGlvbiBhcHBseVVwZGF0ZSgpOiB2b2lkIHtcclxuICAgIGlmIChpbnN0YWxsZXJQYXRoID09PSBudWxsKSByZXR1cm47XHJcbiAgICAvLyBcdTkwMDBcdTUxRkFcdTVGNTNcdTUyNERcdTVFOTRcdTc1MjhcdTU0MEVcdTc1MzFcdTVCODlcdTg4QzVcdTU2NjhcdTk3NTlcdTlFRDhcdTg5ODZcdTc2RDZcdTVCODlcdTg4QzUoXHU4OEM1XHU1NkRFXHU1MzlGXHU3NkVFXHU1RjU1KVx1MzAwMk5TSVMgYXNzaXN0ZWQgXHU4OUM0XHU1MjE5OlxyXG4gICAgLy8gL1MgXHU0RTE0IC9EPXBhdGggXHU1RkM1XHU5ODdCXHU2NzAwXHU1NDBFXHU0RTAwXHU0RTJBXHU1M0MyXHU2NTcwXHUzMDAxXHU1MDNDXHU0RTBEXHU1MkEwXHU1RjE1XHU1M0Y3KFx1NTQyQlx1N0E3QVx1NjgzQ1x1NEU1Rlx1NEUwRFx1NTJBMClcdTIwMTRcdTIwMTRub2RlIHNwYXduXHJcbiAgICAvLyBcdTlFRDhcdThCQTRcdTRGMUFcdTdFRDlcdTU0MkJcdTdBN0FcdTY4M0NcdTUzQzJcdTY1NzBcdTUyQTBcdTVGMTVcdTUzRjdcdTVCRkNcdTgxRjQgTlNJUyBcdTg5RTNcdTY3OTBcdTk1MTlcdThERUZcdTVGODQoXHU1QjlFXHU2RDRCXHU4OEM1XHU1NzRGXHU3NkVFXHU1RjU1KSxcdTY1NDVcdTc1MjhcclxuICAgIC8vIHdpbmRvd3NWZXJiYXRpbUFyZ3VtZW50cyBcdTUzOUZcdTY4MzdcdTRGMjBcdTkwMTJcdTMwMDJcclxuICAgIGNvbnN0IGluc3RhbGxEaXIgPSBkaXJuYW1lKHByb2Nlc3MuZXhlY1BhdGgpO1xyXG4gICAgY29uc3QgY2hpbGQgPSBzcGF3bihgXCIke2luc3RhbGxlclBhdGh9XCIgL1MgL0Q9JHtpbnN0YWxsRGlyfWAsIHtcclxuICAgICAgZGV0YWNoZWQ6IHRydWUsXHJcbiAgICAgIHN0ZGlvOiAnaWdub3JlJyxcclxuICAgICAgd2luZG93c0hpZGU6IHRydWUsXHJcbiAgICAgIHNoZWxsOiBmYWxzZSxcclxuICAgICAgd2luZG93c1ZlcmJhdGltQXJndW1lbnRzOiB0cnVlLFxyXG4gICAgfSk7XHJcbiAgICBjaGlsZC51bnJlZigpO1xyXG4gICAgbG9nSW5mbygndXBkYXRlJywgYGFwcGx5OiAke2luc3RhbGxlclBhdGh9IFx1MjE5MiAke2luc3RhbGxEaXJ9YCk7XHJcbiAgICBhcHAuZXhpdCgwKTtcclxuICB9XHJcblxyXG4gIGZ1bmN0aW9uIGJ1aWxkQXBwTWVudSgpOiB2b2lkIHtcclxuICAgIC8vIFx1N0NCRVx1N0I4MDpcdTUzRUFcdTRGRERcdTc1NTkgVUkgXHU2Q0ExXHU2NzA5XHU3Njg0XHU3Q0ZCXHU3RURGXHU3RUE3XHU4MEZEXHU1MjlCKFx1NTI2QVx1OEQzNFx1Njc3Ri9cdTdBOTdcdTUzRTMpO1x1NTE3Nlx1NEY1OVx1NTUyRlx1NEUwMFx1NTE2NVx1NTNFM1x1NTcyOCBVSVx1MzAwMlxyXG4gICAgY29uc3QgdGVtcGxhdGU6IEFycmF5PEVsZWN0cm9uLk1lbnVJdGVtQ29uc3RydWN0b3JPcHRpb25zPiA9IFtcclxuICAgICAge1xyXG4gICAgICAgIGxhYmVsOiAnXHU3RjE2XHU4RjkxJyxcclxuICAgICAgICBzdWJtZW51OiBbXHJcbiAgICAgICAgICB7IHJvbGU6ICd1bmRvJywgbGFiZWw6ICdcdTY0QTRcdTk1MDAnIH0sXHJcbiAgICAgICAgICB7IHJvbGU6ICdyZWRvJywgbGFiZWw6ICdcdTkxQ0RcdTUwNUEnIH0sXHJcbiAgICAgICAgICB7IHR5cGU6ICdzZXBhcmF0b3InIH0sXHJcbiAgICAgICAgICB7IHJvbGU6ICdjdXQnLCBsYWJlbDogJ1x1NTI2QVx1NTIwNycgfSxcclxuICAgICAgICAgIHsgcm9sZTogJ2NvcHknLCBsYWJlbDogJ1x1NTkwRFx1NTIzNicgfSxcclxuICAgICAgICAgIHsgcm9sZTogJ3Bhc3RlJywgbGFiZWw6ICdcdTdDOThcdThEMzQnIH0sXHJcbiAgICAgICAgICB7IHJvbGU6ICdzZWxlY3RBbGwnLCBsYWJlbDogJ1x1NTE2OFx1OTAwOScgfSxcclxuICAgICAgICBdLFxyXG4gICAgICB9LFxyXG4gICAgICB7XHJcbiAgICAgICAgbGFiZWw6ICdcdTdBOTdcdTUzRTMnLFxyXG4gICAgICAgIHN1Ym1lbnU6IFtcclxuICAgICAgICAgIHsgcm9sZTogJ21pbmltaXplJywgbGFiZWw6ICdcdTY3MDBcdTVDMEZcdTUzMTYnIH0sXHJcbiAgICAgICAgICB7IHJvbGU6ICd6b29tJywgbGFiZWw6ICdcdTdGMjlcdTY1M0UnIH0sXHJcbiAgICAgICAgICB7IHR5cGU6ICdzZXBhcmF0b3InIH0sXHJcbiAgICAgICAgICB7IHJvbGU6ICdjbG9zZScsIGxhYmVsOiAnXHU1MTczXHU5NUVEJyB9LFxyXG4gICAgICAgIF0sXHJcbiAgICAgIH0sXHJcbiAgICBdO1xyXG4gICAgTWVudS5zZXRBcHBsaWNhdGlvbk1lbnUoTWVudS5idWlsZEZyb21UZW1wbGF0ZSh0ZW1wbGF0ZSkpO1xyXG4gIH1cclxuICAvKiogXHU2ODA3XHU5ODk4XHU2ODBGIFx1MjYzMCBcdTRFM0JcdTgzRENcdTUzNTUoXHU1RTM4XHU3NTI4XHU1MkE4XHU0RjVDXHU3Njg0XHU1NTJGXHU0RTAwXHU1MTY1XHU1M0UzO1x1ODlDNlx1NTZGRVx1NjAwMVx1N0VDRiBtZW51OmFjdGlvbiBcdThGNkNcdTUzRDEpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gcG9wdXBNYWluTWVudSgpOiB2b2lkIHtcclxuICAgIGNvbnN0IHNlbmQgPSAoYTogc3RyaW5nKTogdm9pZCA9PiB7XHJcbiAgICAgIGZvciAoY29uc3QgdyBvZiBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKSkge1xyXG4gICAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ21lbnU6YWN0aW9uJywgYSk7XHJcbiAgICAgIH1cclxuICAgIH07XHJcbiAgICBjb25zdCB3aW4gPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5maW5kKCh3KSA9PiAhdy5pc0Rlc3Ryb3llZCgpKTtcclxuICAgIGlmICh3aW4gPT09IHVuZGVmaW5lZCkgcmV0dXJuO1xyXG4gICAgTWVudS5idWlsZEZyb21UZW1wbGF0ZShbXHJcbiAgICAgIHsgbGFiZWw6ICdcdTY1QjBcdTVFRkFcdTRGMUFcdThCREQnLCBhY2NlbGVyYXRvcjogJ0NtZE9yQ3RybCtOJywgY2xpY2s6ICgpOiB2b2lkID0+IHNlbmQoJ25ldy1zZXNzaW9uJykgfSxcclxuICAgICAgeyBsYWJlbDogJ1x1OEJCRVx1N0Y2RScsIGFjY2VsZXJhdG9yOiAnQ21kT3JDdHJsK1NoaWZ0K1AnLCBjbGljazogKCk6IHZvaWQgPT4gc2VuZCgnb3Blbi1zZXR0aW5ncycpIH0sXHJcbiAgICAgIHsgbGFiZWw6ICdcdTVGRUJcdTYzNzdcdTk1MkUnLCBhY2NlbGVyYXRvcjogJ0NtZE9yQ3RybCsvJywgY2xpY2s6ICgpOiB2b2lkID0+IHNlbmQoJ3Nob3J0Y3V0cycpIH0sXHJcbiAgICAgIHsgdHlwZTogJ3NlcGFyYXRvcicgfSxcclxuICAgICAgeyBsYWJlbDogJ1x1NjI0Qlx1NjczQVx1OEZEQ1x1N0EwQlx1NjNBN1x1NTIzNicsIGNsaWNrOiAoKTogdm9pZCA9PiBzZW5kKCdvcGVuLXJlbW90ZScpIH0sXHJcbiAgICAgIHsgdHlwZTogJ3NlcGFyYXRvcicgfSxcclxuICAgICAge1xyXG4gICAgICAgIGxhYmVsOiB1cGRhdGVTdGF0ZS5kb3dubG9hZGVkID8gYFx1OTFDRFx1NTQyRlx1NUU3Nlx1NUI4OVx1ODhDNVx1NjZGNFx1NjVCMCh2JHt1cGRhdGVTdGF0ZS5sYXRlc3QgPz8gJz8nfSlgIDogJ1x1NjhDMFx1NjdFNVx1NjZGNFx1NjVCMFx1MjAyNicsXHJcbiAgICAgICAgY2xpY2s6ICgpOiB2b2lkID0+IHtcclxuICAgICAgICAgIGlmICh1cGRhdGVTdGF0ZS5kb3dubG9hZGVkKSB7IGFwcGx5VXBkYXRlKCk7IHJldHVybjsgfVxyXG4gICAgICAgICAgdm9pZCBjaGVja0ZvclVwZGF0ZXMoKS50aGVuKChzdCkgPT4ge1xyXG4gICAgICAgICAgICBjb25zdCBuZXdlciA9IHN0LmxhdGVzdCAhPT0gbnVsbCAmJiBjbXBWZXJzaW9uKHN0LmN1cnJlbnRWZXJzaW9uLCBzdC5sYXRlc3QpIDwgMDtcclxuICAgICAgICAgICAgY29uc3QgZGV0YWlsID0gbmV3ZXIgPyBgJHtzdC5ub3Rlc31cXG5cXG5cdTVCODlcdTg4QzVcdTUzMDVcdTZCNjNcdTU3MjhcdTU0MEVcdTUzRjBcdTRFMEJcdThGN0QsXHU1QjhDXHU2MjEwXHU1NDBFIFx1MjYzMCBcdTgzRENcdTUzNTVcdTRGMUFcdTUxRkFcdTczQjBcIlx1OTFDRFx1NTQyRlx1NUU3Nlx1NUI4OVx1ODhDNVx1NjZGNFx1NjVCMFwiXHUzMDAyYCA6ICcnO1xyXG4gICAgICAgICAgICB2b2lkIGRpYWxvZy5zaG93TWVzc2FnZUJveCh3aW4sIHtcclxuICAgICAgICAgICAgICB0eXBlOiAnaW5mbycsXHJcbiAgICAgICAgICAgICAgdGl0bGU6ICdcdTY4QzBcdTY3RTVcdTY2RjRcdTY1QjAnLFxyXG4gICAgICAgICAgICAgIG1lc3NhZ2U6IG5ld2VyXHJcbiAgICAgICAgICAgICAgICA/IGBcdTUzRDFcdTczQjBcdTY1QjBcdTcyNDhcdTY3MkMgdiR7c3QubGF0ZXN0fSFgXHJcbiAgICAgICAgICAgICAgICA6IChzdC5lcnJvciAhPT0gJycgPyBgXHU2OEMwXHU2N0U1XHU1OTMxXHU4RDI1OiR7c3QuZXJyb3J9YCA6IGBcdTVERjJcdTY2MkZcdTY3MDBcdTY1QjBcdTcyNDhcdTY3MkModiR7c3QuY3VycmVudFZlcnNpb259KWApLFxyXG4gICAgICAgICAgICAgIGRldGFpbCxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICB9KTtcclxuICAgICAgICB9LFxyXG4gICAgICB9LFxyXG4gICAgICB7XHJcbiAgICAgICAgbGFiZWw6ICdcdTUxNzNcdTRFOEUgSE1IIERlc2t0b3AnLFxyXG4gICAgICAgIGNsaWNrOiAoKTogdm9pZCA9PiB7XHJcbiAgICAgICAgICB2b2lkIGRpYWxvZy5zaG93TWVzc2FnZUJveCh3aW4sIHtcclxuICAgICAgICAgICAgdHlwZTogJ2luZm8nLFxyXG4gICAgICAgICAgICB0aXRsZTogJ1x1NTE3M1x1NEU4RSBITUggRGVza3RvcCcsXHJcbiAgICAgICAgICAgIG1lc3NhZ2U6ICdITUggRGVza3RvcCcsXHJcbiAgICAgICAgICAgIGRldGFpbDogYFx1NjcyQ1x1NTczMFx1NEYxOFx1NTE0OFx1NzY4NCBITUggQWdlbnQgXHU1NkZFXHU1RjYyXHU1REU1XHU0RjVDXHU1M0YwIHYke2FwcC5nZXRWZXJzaW9uKCl9XFxucnVudGltZTogaG1oYXJuZXNzICR7YnJpZGdlLmhvc3RWZXJzaW9uID8/ICcoXHU2NzJBXHU4RkRFXHU2M0E1KSd9JHt1c2VCdW5kbGVkUnVudGltZSA/ICcoXHU1MTg1XHU3RjZFKScgOiAnJ31cXG5cdTZBMjFcdTVGMEY6ICR7YnJpZGdlLm1vZGUgPT09ICdyZWFsJyA/ICh1c2VCdW5kbGVkUnVudGltZSA/ICdcdTc3MUZcdTVCOUUgaG1oYXJuZXNzKFx1NTE4NVx1N0Y2RSBydW50aW1lKScgOiAnXHU3NzFGXHU1QjlFIGhtaGFybmVzcyhcdTU5MTZcdTkwRThcdTVCODlcdTg4QzUpJykgOiAnXHU2RjE0XHU3OTNBKFx1NTA0N1x1NjU3MFx1NjM2RSknfVxcblxcblx1NEUwRSBDTEkgLyBUVUkgLyBcdTdGNTFcdTk4NzVcdTcyNDhcdTUxNzFcdTRFQUJcdTU0MENcdTRFMDAgSE1IX0hPTUVcdTMwMDJgLFxyXG4gICAgICAgICAgfSk7XHJcbiAgICAgICAgfSxcclxuICAgICAgfSxcclxuICAgICAgeyBsYWJlbDogJ1x1OTAwMFx1NTFGQScsIHJvbGU6ICdxdWl0JyB9LFxyXG4gICAgXSkucG9wdXAoeyB3aW5kb3c6IHdpbiB9KTtcclxuICB9XHJcblxyXG4gIC8qIC0tLS0gXHU2MjRCXHU2NzNBXHU4RkRDXHU3QTBCXHU2M0E3XHU1MjM2KDAzIFx1NTNGNzpXZWIgNzc4OCBcdTY2MkZcdTZENEZcdTg5QzhcdTU2NjgvXHU4RkRDXHU3QTBCL1x1NjI0Qlx1NjczQVx1NTE2NVx1NTNFMyxBRFItMDA1OlxyXG4gICAgIERlc2t0b3AgXHU0RTBEXHU5RUQ4XHU4QkE0XHU2MjUzXHU1RjAwIExBTiBcdTIwMTRcdTIwMTQgXHU4RkQ5XHU5MUNDXHU2NjJGXHU3NTI4XHU2MjM3XHU2NjNFXHU1RjBGXHU1NDJGXHU1MkE4XHU3Njg0XHU1MTY1XHU1M0UzKSAtLS0tICovXHJcbiAgY29uc3QgV0VCX1BPUlQgPSA3Nzg4O1xyXG4gIGFzeW5jIGZ1bmN0aW9uIHByb2JlV2ViUmVtb3RlKCk6IFByb21pc2U8eyB1cDogYm9vbGVhbjsgdmVyc2lvbjogc3RyaW5nIH0+IHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHIgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke1dFQl9QT1JUfS9hcGkvc3RhdGVgLCB7IHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCgxNTAwKSB9KTtcclxuICAgICAgaWYgKCFyLm9rKSByZXR1cm4geyB1cDogZmFsc2UsIHZlcnNpb246ICcnIH07XHJcbiAgICAgIGNvbnN0IGQgPSAoYXdhaXQgci5qc29uKCkpIGFzIHsgZGFlbW9uVmVyc2lvbj86IHN0cmluZyB9O1xyXG4gICAgICByZXR1cm4geyB1cDogdHJ1ZSwgdmVyc2lvbjogU3RyaW5nKGQuZGFlbW9uVmVyc2lvbiA/PyAnJykgfTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4geyB1cDogZmFsc2UsIHZlcnNpb246ICcnIH07IH1cclxuICB9XHJcbiAgLyoqIFx1NUYwMFx1NjczQVx1ODFFQVx1NTQyRlx1NjYyRlx1NTQyNlx1NURGMlx1ODhDNShydW50aW1lIHdlYi1kYWVtb24gXHU3Njg0XHU1NDJGXHU1MkE4XHU5ODc5XHU2NTg3XHU0RUY2XHU1QjU4XHU1NzI4XHU2MDI3OzAuMjMuMzcgXHU2NUIwXHU4MEZEXHU1MjlCKVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIHdlYkF1dG9zdGFydEluc3RhbGxlZCgpOiBib29sZWFuIHtcclxuICAgIGNvbnN0IGhvbWUgPSBwcm9jZXNzLmVudi5IT01FID8/ICcnO1xyXG4gICAgY29uc3QgY2FuZGlkYXRlcyA9IHByb2Nlc3MucGxhdGZvcm0gPT09ICd3aW4zMidcclxuICAgICAgPyBbam9pbihwcm9jZXNzLmVudi5BUFBEQVRBID8/ICcnLCAnTWljcm9zb2Z0JywgJ1dpbmRvd3MnLCAnU3RhcnQgTWVudScsICdQcm9ncmFtcycsICdTdGFydHVwJywgJ2htaGFybmVzcy13ZWItZGFlbW9uLmNtZCcpXVxyXG4gICAgICA6IHByb2Nlc3MucGxhdGZvcm0gPT09ICdkYXJ3aW4nXHJcbiAgICAgICAgPyBbam9pbihob21lLCAnTGlicmFyeScsICdMYXVuY2hBZ2VudHMnLCAnaG1oYXJuZXNzLXdlYi1kYWVtb24ucGxpc3QnKV1cclxuICAgICAgICA6IFtqb2luKGhvbWUsICcuY29uZmlnJywgJ3N5c3RlbWQnLCAndXNlcicsICdobWhhcm5lc3Mtd2ViLWRhZW1vbi5zZXJ2aWNlJyldO1xyXG4gICAgcmV0dXJuIGNhbmRpZGF0ZXMuc29tZSgocCkgPT4geyB0cnkgeyByZXR1cm4gZXhpc3RzU3luYyhwKTsgfSBjYXRjaCB7IHJldHVybiBmYWxzZTsgfSB9KTtcclxuICB9XHJcbiAgLyoqIFx1NjI0Qlx1NjczQVx1NTNFRlx1OERFRlx1NzUzMVx1NzY4NCBMQU4gSVAoUkZDMTkxOCxcdTYzOTJcdTk2NjRcdTg2NUFcdTYyREZcdTdGNTFcdTUzNjEpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gbGFuSXBPZigpOiBzdHJpbmcge1xyXG4gICAgY29uc3QgVklSVFVBTCA9IC92bXdhcmV8dmlydHVhbHxoeXBlci0/dnx2ZXRoZXJuZXR8d3NsfHRhaWxzY2FsZXxsb29wYmFja3xibHVldG9vdGh8dmJveHxkb2NrZXJ8dGFwLXxwc2V1ZG8vaTtcclxuICAgIGNvbnN0IGlzUmZjMTkxOCA9IChhOiBzdHJpbmcpOiBib29sZWFuID0+IC9eMTBcXC4vLnRlc3QoYSkgfHwgL14xOTJcXC4xNjhcXC4vLnRlc3QoYSkgfHwgL14xNzJcXC4oMVs2LTldfDJcXGR8M1swMV0pXFwuLy50ZXN0KGEpO1xyXG4gICAgbGV0IGxhbklwID0gJyc7XHJcbiAgICBsZXQgZmFsbGJhY2sgPSAnJztcclxuICAgIGZvciAoY29uc3QgW25hbWUsIGxpc3RdIG9mIE9iamVjdC5lbnRyaWVzKG5ldHdvcmtJbnRlcmZhY2VzKCkpKSB7XHJcbiAgICAgIGZvciAoY29uc3QgbiBvZiBsaXN0ID8/IFtdKSB7XHJcbiAgICAgICAgaWYgKG4uZmFtaWx5ICE9PSAnSVB2NCcgfHwgbi5pbnRlcm5hbCB8fCAhaXNSZmMxOTE4KG4uYWRkcmVzcykpIGNvbnRpbnVlO1xyXG4gICAgICAgIGlmICghVklSVFVBTC50ZXN0KG5hbWUpKSBsYW5JcCA9IGxhbklwIHx8IG4uYWRkcmVzcztcclxuICAgICAgICBlbHNlIGZhbGxiYWNrID0gZmFsbGJhY2sgfHwgbi5hZGRyZXNzO1xyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gbGFuSXAgfHwgZmFsbGJhY2s7XHJcbiAgfVxyXG4gIC8qKiBDTEkgXHU1MTY1XHU1M0UzOlx1NkU5MFx1NzgwMSByZXBvIFx1NUUwM1x1NUM0MChtYWluLnRzLFx1N0VDRiB0c3gpXHU2MjE2IG5wbSBcdTVCODlcdTg4QzVcdTVFMDNcdTVDNDAoZGlzdC9tYWluLmpzXHJcbiAgICogIFx1NzZGNFx1OEREMVx1MjAxNFx1MjAxNFx1NEVDRSBydW50aW1lIFx1NTE2NVx1NTNFM1x1NEUwQVx1NkVBRlx1NjI3RSBAaG1oYXJuZXNzL2NsaSBcdTUzMDU7XHU1RDRDXHU1OTU3L1x1NjNEMFx1NTM0Ny9cdTZFOTBcdTc4MDFcdTRFMDlcdTc5Q0RcdTVFMDNcdTVDNDBcdTkwMUFcdTU0MDMpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gY2xpRW50cnlPZigpOiBzdHJpbmcge1xyXG4gICAgaWYgKHJ1bnRpbWVFbnRyeSA9PT0gJycgfHwgcnVudGltZUVudHJ5ID09PSBudWxsKSByZXR1cm4gJyc7XHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCBwID0gam9pbihyZXBvUm9vdE9mKHJ1bnRpbWVFbnRyeSksICdwYWNrYWdlcycsICdjbGknLCAnc3JjJywgJ21haW4udHMnKTtcclxuICAgICAgaWYgKGV4aXN0c1N5bmMocCkpIHJldHVybiBwO1xyXG4gICAgfSBjYXRjaCB7IC8qIFx1OTc1RSByZXBvIFx1NUUwM1x1NUM0MCAqLyB9XHJcbiAgICBsZXQgZGlyID0gZGlybmFtZShydW50aW1lRW50cnkpO1xyXG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCA4OyBpKyspIHtcclxuICAgICAgaWYgKGV4aXN0c1N5bmMoam9pbihkaXIsICdkaXN0JywgJ21haW4uanMnKSkgJiYgcGtnTmFtZUF0KGRpcikgPT09ICdAaG1oYXJuZXNzL2NsaScpIHJldHVybiBqb2luKGRpciwgJ2Rpc3QnLCAnbWFpbi5qcycpO1xyXG4gICAgICBpZiAoYmFzZW5hbWUoZGlyKSA9PT0gJ0BobWhhcm5lc3MnICYmIGV4aXN0c1N5bmMoam9pbihkaXIsICdjbGknLCAnZGlzdCcsICdtYWluLmpzJykpKSByZXR1cm4gam9pbihkaXIsICdjbGknLCAnZGlzdCcsICdtYWluLmpzJyk7XHJcbiAgICAgIGNvbnN0IHBhcmVudCA9IGRpcm5hbWUoZGlyKTtcclxuICAgICAgaWYgKHBhcmVudCA9PT0gZGlyKSBicmVhaztcclxuICAgICAgZGlyID0gcGFyZW50O1xyXG4gICAgfVxyXG4gICAgcmV0dXJuICcnO1xyXG4gIH1cclxuICBmdW5jdGlvbiBydW5DbGkoYXJnczogc3RyaW5nW10pOiB2b2lkIHtcclxuICAgIGNvbnN0IGVudHJ5ID0gY2xpRW50cnlPZigpO1xyXG4gICAgaWYgKGVudHJ5ID09PSAnJykgcmV0dXJuO1xyXG4gICAgY29uc3QgaXNUcyA9IGVudHJ5LmVuZHNXaXRoKCcudHMnKTtcclxuICAgIGNvbnN0IHJlcG8gPSByZXBvUm9vdE9mKHJ1bnRpbWVFbnRyeSA/PyBlbnRyeSk7XHJcbiAgICBjb25zdCBjaGlsZCA9IHNwYXduKHByb2Nlc3MuZXhlY1BhdGgsIGlzVHMgPyBbJy0taW1wb3J0JywgJ3RzeCcsIGVudHJ5LCAuLi5hcmdzXSA6IFtlbnRyeSwgLi4uYXJnc10sIHtcclxuICAgICAgY3dkOiBpc1RzID8gcmVwbyA6IGRpcm5hbWUoZW50cnkpLFxyXG4gICAgICBkZXRhY2hlZDogdHJ1ZSxcclxuICAgICAgc3RkaW86ICdpZ25vcmUnLFxyXG4gICAgICB3aW5kb3dzSGlkZTogdHJ1ZSxcclxuICAgICAgZW52OiB7IEVMRUNUUk9OX1JVTl9BU19OT0RFOiAnMScgfSxcclxuICAgIH0pO1xyXG4gICAgY2hpbGQudW5yZWYoKTtcclxuICB9XHJcblxyXG4gIGZ1bmN0aW9uIGJyb2FkY2FzdEhvc3RTdGF0ZShzOiBIb3N0U3RhdGUsIGluZm86IHsgcmVzdGFydENvdW50OiBudW1iZXI7IGxhc3RFcnJvcj86IHN0cmluZyB9KTogdm9pZCB7XHJcbiAgICBicmlkZ2UgPSB7IC4uLmJyaWRnZSwgaG9zdFN0YXRlOiBzLCBob3N0UG9ydDogc3VwZXJ2aXNvcj8uZW5kcG9pbnQ/LnBvcnQgPz8gbnVsbCwgaG9zdFZlcnNpb246IHN1cGVydmlzb3I/LmVuZHBvaW50Py52ZXJzaW9uID8/IG51bGwgfTtcclxuICAgIGxvZ0luZm8oJ2hvc3QnLCBgc3RhdGU9JHtzfSR7aW5mby5sYXN0RXJyb3IgIT09IHVuZGVmaW5lZCA/IGAgZXJyPSR7aW5mby5sYXN0RXJyb3J9YCA6ICcnfWApO1xyXG4gICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XHJcbiAgICAgIGlmICghdy5pc0Rlc3Ryb3llZCgpKSB3LndlYkNvbnRlbnRzLnNlbmQoJ2JyaWRnZTpob3N0LXN0YXRlJywgcywgaW5mbyk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvKiogU1NFIFx1NkQ0MVx1OEJBMlx1OTYwNTpcdTRGRTFcdTVDMDEoZXZlbnQ6IGhtaClcdTYyNzlcdTkxQ0ZcdTYzQTggcmVuZGVyZXI7XHU5QUQ4XHU5ODkxIGRlbHRhL2xpbmUgXHU1MzlGXHU1RTI3XHJcbiAgICogIFx1NEY1Q1x1NEUzQVx1NkQ0MVx1NTc1N1x1OEY2Q1x1NTNEMShyZW5kZXJlciBcdTYyRkNcdTYzQTVcdTVGNTNcdTUyNEQgYXNzaXN0YW50IFx1NTM2MFx1NEY0RClcdTMwMDJcdTY1QURcdTdFQkZcdTgxRUFcdTUyQThcdTkxQ0RcdThGREVcdTMwMDIgKi9cclxuICBhc3luYyBmdW5jdGlvbiBwdW1wRXZlbnRzKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgaWYgKGNsaWVudCA9PT0gbnVsbCkgcmV0dXJuO1xyXG4gICAgZm9yICg7Oykge1xyXG4gICAgICBjb25zdCBjID0gY2xpZW50O1xyXG4gICAgICBpZiAoYyA9PT0gbnVsbCkgcmV0dXJuO1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGZvciBhd2FpdCAoY29uc3QgZnJhbWUgb2YgYy5yYXdFdmVudHMobGFzdEV2ZW50SWQgPT09ICcnID8gdW5kZWZpbmVkIDogbGFzdEV2ZW50SWQsIHNzZUFib3J0Py5zaWduYWwpKSB7XHJcbiAgICAgICAgICBpZiAoZnJhbWUuZXZlbnQgPT09ICdobWgnKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGVudiA9IGVudmVsb3BlRnJvbUZyYW1lKGZyYW1lKTtcclxuICAgICAgICAgICAgaWYgKGVudiA9PT0gbnVsbCkge1xyXG4gICAgICAgICAgICAgIGRyb3BwZWRGcmFtZXMgKz0gMTtcclxuICAgICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBsYXN0RXZlbnRJZCA9IGVudi5ldmVudElkO1xyXG4gICAgICAgICAgICBwdXNoRXZlbnQoZW52KTtcclxuICAgICAgICAgIH0gZWxzZSBpZiAoZnJhbWUuZXZlbnQgPT09ICdkZWx0YScgfHwgZnJhbWUuZXZlbnQgPT09ICdsaW5lJykge1xyXG4gICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgIGNvbnN0IGQgPSBKU09OLnBhcnNlKGZyYW1lLmRhdGEpIGFzIHsgc2Vzc2lvbklkPzogc3RyaW5nOyBrPzogc3RyaW5nOyBjaHVuaz86IHN0cmluZzsgdGV4dD86IHN0cmluZyB9O1xyXG4gICAgICAgICAgICAgIGNvbnN0IHBheWxvYWQgPSBmcmFtZS5ldmVudCA9PT0gJ2RlbHRhJ1xyXG4gICAgICAgICAgICAgICAgPyB7IHNlc3Npb25JZDogZC5zZXNzaW9uSWQgPz8gJycsIGtpbmQ6IGQuayA/PyAndGV4dCcsIGNodW5rOiBTdHJpbmcoZC5jaHVuayA/PyAnJykgfVxyXG4gICAgICAgICAgICAgICAgOiB7IHNlc3Npb25JZDogZC5zZXNzaW9uSWQgPz8gJycsIGtpbmQ6ICdsaW5lJywgY2h1bms6IFN0cmluZyhkLnRleHQgPz8gJycpIH07XHJcbiAgICAgICAgICAgICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XHJcbiAgICAgICAgICAgICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCdicmlkZ2U6c3RyZWFtLWNodW5rJywgcGF5bG9hZCk7XHJcbiAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9IGNhdGNoIHsgLyogbWFsZm9ybWVkIHN0cmVhbSBmcmFtZTogc2tpcCAqLyB9XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybjsgLy8gXHU2RDQxXHU2QjYzXHU1RTM4XHU3RUQzXHU2NzVGKGhvc3QgXHU1MTczXHU5NUVEKVxyXG4gICAgICB9IGNhdGNoIHtcclxuICAgICAgICAvLyBcdTY1QURcdTdFQkY6XHU3N0VEXHU5MDAwXHU5MDdGXHU1NDBFXHU5MUNEXHU4RkRFKHN1cGVydmlzb3IgXHU1M0VGXHU4MEZEXHU2QjYzXHU1NzI4XHU5MUNEXHU1NDJGIGhvc3QpXHJcbiAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgMV8wMDApKTtcclxuICAgICAgICBpZiAoc3NlQWJvcnQ/LnNpZ25hbC5hYm9ydGVkKSByZXR1cm47XHJcbiAgICAgIH1cclxuICAgIH1cclxuICB9XHJcblxyXG4gIC8qIC0tLS0gaG1oYXJuZXNzIHJ1bnRpbWUgXHU4MUVBXHU1MkE4XHU1M0QxXHU3M0IwKDIwMjYtMTAtMTAgXHU3NTI4XHU2MjM3XHU1QjlBXHU4QzAzOlx1ODhDNVx1OEZDNyBobWhhcm5lc3MgXHU3Njg0XHJcbiAgICAgXHU2NzNBXHU1NjY4XHU5NkY2XHU5MTREXHU3RjZFXHU3NkY0XHU4RkRFLFx1NTkwRFx1NzUyOCBDTEkvVFVJL3dlYiA3Nzg4IFx1NzY4NFx1NTQwQ1x1NEUwMCBITUhfSE9NRVx1MjAxNFx1MjAxNGNvbmZpZy9wcm92aWRlcnMvXHJcbiAgICAgXHU0RjFBXHU4QkREXHU1Mzg2XHU1M0YyXHU1OTI5XHU3MTM2XHU1MTcxXHU0RUFCKVx1MzAwMnY1LjEgXHU1M0QxXHU3M0IwXHU5ODdBXHU1RThGOlx1NjYzRVx1NUYwRlx1OTE0RFx1N0Y2RSA+IHdoZXJlIGhtaChcdTZFOTBcdTc4MDEgbGluayBcdTRFMEVcclxuICAgICBAaG1oYXJuZXNzL2NsaSBucG0gXHU1Qjg5XHU4OEM1XHU0RTI0XHU3OUNEXHU1RTAzXHU1QzQwKT4gbnBtIFx1NTE2OFx1NUM0MFx1NjgzOShcdTU0MEMpPiBcdTU0MTFcdTVCRkNcdTVCODlcdTg4QzVcdTc2RUVcdTVGNTVcclxuICAgICB+Ly5obWhhcm5lc3MtZ2xvYmFsID4gXHU1RTM4XHU4OUMxXHU2RTkwXHU3ODAxXHU0RjREXHU3RjZFXHUzMDAyICovXHJcbiAgY29uc3QgcnVudGltZUNvbmZpZ0ZpbGUgPSAoKTogc3RyaW5nID0+IGpvaW4oYXBwLmdldFBhdGgoJ3VzZXJEYXRhJyksICdydW50aW1lLmpzb24nKTtcclxuICAvKiogcnVudGltZS5qc29uOnsgZW50cnkoXHU2MjRCXHU1MkE4L1x1NTQxMVx1NUJGQ1x1OTAwOVx1NjJFOVx1NzY4NFx1NTE2NVx1NTNFMyksIGRlbW8oXHU2MzAxXHU0RTQ1XHU2RjE0XHU3OTNBXHU2QTIxXHU1RjBGKSB9XHUzMDAyICovXHJcbiAgYXN5bmMgZnVuY3Rpb24gbG9hZFJ1bnRpbWVDb25maWcoKTogUHJvbWlzZTx7IGVudHJ5OiBzdHJpbmc7IGRlbW86IGJvb2xlYW4gfT4ge1xyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3QgdiA9IEpTT04ucGFyc2UoYXdhaXQgcmVhZEZpbGUocnVudGltZUNvbmZpZ0ZpbGUoKSwgJ3V0ZjgnKSkgYXMgeyBlbnRyeT86IHVua25vd247IGRlbW8/OiB1bmtub3duIH07XHJcbiAgICAgIHJldHVybiB7XHJcbiAgICAgICAgZW50cnk6IHR5cGVvZiB2LmVudHJ5ID09PSAnc3RyaW5nJyAmJiB2LmVudHJ5ICE9PSAnJyAmJiBpc0Fic29sdXRlKHYuZW50cnkpID8gdi5lbnRyeSA6ICcnLFxyXG4gICAgICAgIGRlbW86IHYuZGVtbyA9PT0gdHJ1ZSxcclxuICAgICAgfTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4geyBlbnRyeTogJycsIGRlbW86IGZhbHNlIH07IH1cclxuICB9XHJcbiAgYXN5bmMgZnVuY3Rpb24gc2F2ZVJ1bnRpbWVDb25maWcoY2ZnOiB7IGVudHJ5OiBzdHJpbmc7IGRlbW86IGJvb2xlYW4gfSk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgYXdhaXQgd3JpdGVGaWxlKHJ1bnRpbWVDb25maWdGaWxlKCksIEpTT04uc3RyaW5naWZ5KGNmZywgbnVsbCwgMiksICd1dGY4JykuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcclxuICB9XHJcbiAgYXN5bmMgZnVuY3Rpb24gbG9hZFJ1bnRpbWVFbnRyeU92ZXJyaWRlKCk6IFByb21pc2U8c3RyaW5nPiB7XHJcbiAgICByZXR1cm4gKGF3YWl0IGxvYWRSdW50aW1lQ29uZmlnKCkpLmVudHJ5O1xyXG4gIH1cclxuICBhc3luYyBmdW5jdGlvbiBzYXZlUnVudGltZUVudHJ5T3ZlcnJpZGUoZW50cnk6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgYXdhaXQgc2F2ZVJ1bnRpbWVDb25maWcoeyBlbnRyeSwgZGVtbzogKGF3YWl0IGxvYWRSdW50aW1lQ29uZmlnKCkpLmRlbW8gfSk7XHJcbiAgfVxyXG5cclxuICBpbnRlcmZhY2UgRXh0ZXJuYWxSdW50aW1lIHsgZW50cnk6IHN0cmluZzsgdmVyc2lvbjogc3RyaW5nOyBzb3VyY2U6IHN0cmluZyB9XHJcblxyXG4gIC8qKiBcdThCRkJcdTUzMDVcdTcyNDhcdTY3MkMocGFja2FnZS5qc29uIFx1NzY4NCB2ZXJzaW9uIFx1NUI1N1x1NkJCNTtcdTU5MzFcdThEMjVcdTdBN0FcdTRFMzIpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gcGtnVmVyc2lvbkF0KGRpcjogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHYgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKGRpciwgJ3BhY2thZ2UuanNvbicpLCAndXRmOCcpKSBhcyB7IHZlcnNpb24/OiB1bmtub3duIH07XHJcbiAgICAgIHJldHVybiB0eXBlb2Ygdi52ZXJzaW9uID09PSAnc3RyaW5nJyA/IHYudmVyc2lvbiA6ICcnO1xyXG4gICAgfSBjYXRjaCB7IHJldHVybiAnJzsgfVxyXG4gIH1cclxuICAvKiogXHU4QkZCXHU1MzA1XHU1NDBEKFx1NTQwQ1x1NEUwQTtAaG1oYXJuZXNzL2NsaSBcdTVFMDNcdTVDNDBcdThCQzZcdTUyMkJcdTc1MjgpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gcGtnTmFtZUF0KGRpcjogc3RyaW5nKTogc3RyaW5nIHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHYgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKGRpciwgJ3BhY2thZ2UuanNvbicpLCAndXRmOCcpKSBhcyB7IG5hbWU/OiB1bmtub3duIH07XHJcbiAgICAgIHJldHVybiB0eXBlb2Ygdi5uYW1lID09PSAnc3RyaW5nJyA/IHYubmFtZSA6ICcnO1xyXG4gICAgfSBjYXRjaCB7IHJldHVybiAnJzsgfVxyXG4gIH1cclxuXHJcbiAgLyoqIG5wbSBcdTVCODlcdTg4QzVcdTc2ODQgQGhtaGFybmVzcy9jbGkgXHUyMTkyIGRlc2t0b3AtaG9zdCBcdTdGMTZcdThCRDFcdTUxNjVcdTUzRTMoXHU1RDRDXHU1OTU3XHU0RTBFXHU2M0QwXHU1MzQ3XHU0RTI0XHU3OUNEXHU1RTAzXHU1QzQwKVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIGVudHJ5RnJvbUNsaURpcihjbGlEaXI6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICBjb25zdCBuZXN0ZWQgPSBqb2luKGNsaURpciwgJ25vZGVfbW9kdWxlcycsICdAaG1oYXJuZXNzJywgJ3dlYicsICdkaXN0JywgJ2Rlc2t0b3AtaG9zdC5qcycpO1xyXG4gICAgaWYgKGV4aXN0c1N5bmMobmVzdGVkKSkgcmV0dXJuIG5lc3RlZDtcclxuICAgIGNvbnN0IGhvaXN0ZWQgPSBqb2luKGRpcm5hbWUoY2xpRGlyKSwgJ3dlYicsICdkaXN0JywgJ2Rlc2t0b3AtaG9zdC5qcycpO1xyXG4gICAgaWYgKGV4aXN0c1N5bmMoaG9pc3RlZCkpIHJldHVybiBob2lzdGVkO1xyXG4gICAgcmV0dXJuICcnO1xyXG4gIH1cclxuXHJcbiAgLyoqIFx1NTkxNlx1OTBFOFx1NTNEMVx1NzNCMChcdTRGOUJcdTgxRUFcdTUyQThcdThGREVcdTYzQTVcdTRFMEVcdTU0MTFcdTVCRkNcdTY4QzBcdTZENEJcdTk4NzVcdTUxNzFcdTc1MjgpXHUzMDAyXHU0RjE4XHU1MTQ4XHU3RUE3OmVudiA+IHdoZXJlIGhtaCA+IG5wbVxyXG4gICAqICBcdTUxNjhcdTVDNDBcdTY4MzkgPiBcdTU0MTFcdTVCRkNcdTVCODlcdTg4QzVcdTc2RUVcdTVGNTUgfi8uaG1oYXJuZXNzLWdsb2JhbCA+IFx1NkU5MFx1NzgwMVx1NEVEM1x1NjI2Qlx1NjNDRjtcdTU0MENcdTRFMDBcdTVDNDJcdTUxODVcclxuICAgKiAgXCJcdTVERjJcdTg4QzUgQ0xJKG5wbSBcdTVFMDNcdTVDNDApXCIgXHU1MTQ4XHU0RThFIFwiXHU2RTkwXHU3ODAxIHJlcG8gXHU1RTAzXHU1QzQwXCJcdTMwMDIgKi9cclxuICBmdW5jdGlvbiBkZXRlY3RFeHRlcm5hbFJ1bnRpbWUoKTogRXh0ZXJuYWxSdW50aW1lIHtcclxuICAgIC8vIDEpIFx1NzNBRlx1NTg4M1x1NTNEOFx1OTFDRlx1NjYzRVx1NUYwRlx1ODk4Nlx1NzZENihcdTlBRDhcdTdFQTdcdTc1MjhcdTYyMzcpXHJcbiAgICBjb25zdCBlbnZFbnRyeSA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1JFQUxfRU5UUlk7XHJcbiAgICBpZiAoZW52RW50cnkgIT09IHVuZGVmaW5lZCAmJiBlbnZFbnRyeSAhPT0gJycgJiYgaXNBYnNvbHV0ZShlbnZFbnRyeSkpIHtcclxuICAgICAgcmV0dXJuIHsgZW50cnk6IGVudkVudHJ5LCB2ZXJzaW9uOiAnJywgc291cmNlOiAnZW52JyB9O1xyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IHdoZXJlUmVwb3MgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuICAgIGNvbnN0IHdoZXJlQ2xpczogc3RyaW5nW10gPSBbXTtcclxuICAgIGNvbnN0IG5wbVJlcG9zID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcbiAgICBsZXQgbnBtQ2xpID0gJyc7XHJcbiAgICAvLyAyKSB3aGVyZSBobWg6bnBtIGxpbmsoXHU2RTkwXHU3ODAxXHU2ODM5XHU1RTAzXHU1QzQwKVx1NEUwRSBAaG1oYXJuZXNzL2NsaSBucG0gXHU1Qjg5XHU4OEM1XHU1RTAzXHU1QzQwXHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCBvdXQgPSBleGVjRmlsZVN5bmMoJ3doZXJlJywgWydobWgnXSwgeyBlbmNvZGluZzogJ3V0ZjgnLCB0aW1lb3V0OiA0XzAwMCwgd2luZG93c0hpZGU6IHRydWUgfSk7XHJcbiAgICAgIGZvciAoY29uc3QgbGluZSBvZiBvdXQuc3BsaXQoL1xccj9cXG4vKSkge1xyXG4gICAgICAgIGNvbnN0IGJpbiA9IGxpbmUudHJpbSgpO1xyXG4gICAgICAgIGlmIChiaW4gPT09ICcnKSBjb250aW51ZTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgY29uc3QgYmluRGlyID0gZGlybmFtZShiaW4pO1xyXG4gICAgICAgICAgY29uc3QgbGlua2VkID0gam9pbihiaW5EaXIsICdub2RlX21vZHVsZXMnLCAnaG1oYXJuZXNzJyk7XHJcbiAgICAgICAgICBpZiAoZXhpc3RzU3luYyhsaW5rZWQpKSB3aGVyZVJlcG9zLmFkZChyZWFscGF0aFN5bmMobGlua2VkKSk7XHJcbiAgICAgICAgICBjb25zdCBjbGkgPSBqb2luKGJpbkRpciwgJ25vZGVfbW9kdWxlcycsICdAaG1oYXJuZXNzJywgJ2NsaScpO1xyXG4gICAgICAgICAgaWYgKGV4aXN0c1N5bmMoY2xpKSkgd2hlcmVDbGlzLnB1c2goY2xpKTtcclxuICAgICAgICB9IGNhdGNoIHsgLyogYmluIFx1NUUwM1x1NUM0MFx1NEUwRFx1N0IyNixcdThERjNcdThGQzcgKi8gfVxyXG4gICAgICB9XHJcbiAgICB9IGNhdGNoIHsgLyogaG1oIFx1NEUwRFx1NTcyOCBQQVRIICovIH1cclxuICAgIC8vIDMpIG5wbSBcdTUxNjhcdTVDNDBcdTY4MzkoXHU0RTI0XHU3OUNEXHU1RTAzXHU1QzQwXHU1NDBDIHdoZXJlKVxyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3Qgb3V0ID0gZXhlY0ZpbGVTeW5jKCducG0nLCBbJ3Jvb3QnLCAnLWcnXSwgeyBlbmNvZGluZzogJ3V0ZjgnLCB0aW1lb3V0OiA2XzAwMCwgd2luZG93c0hpZGU6IHRydWUgfSk7XHJcbiAgICAgIGNvbnN0IHJvb3QgPSBvdXQudHJpbSgpO1xyXG4gICAgICBjb25zdCBsaW5rZWQgPSBqb2luKHJvb3QsICdobWhhcm5lc3MnKTtcclxuICAgICAgaWYgKGV4aXN0c1N5bmMobGlua2VkKSkgbnBtUmVwb3MuYWRkKHJlYWxwYXRoU3luYyhsaW5rZWQpKTtcclxuICAgICAgY29uc3QgY2xpID0gam9pbihyb290LCAnQGhtaGFybmVzcycsICdjbGknKTtcclxuICAgICAgaWYgKGV4aXN0c1N5bmMoY2xpKSkgbnBtQ2xpID0gY2xpO1xyXG4gICAgfSBjYXRjaCB7IC8qIG5wbSBcdTRFMERcdTUzRUZcdTc1MjggKi8gfVxyXG5cclxuICAgIC8vIFx1NURGMlx1ODhDNSBDTEkoQGhtaGFybmVzcy9jbGkgbnBtIFx1NUUwM1x1NUM0MDtkZXNrdG9wLWhvc3QgXHU0RTNBXHU3RjE2XHU4QkQxXHU0RUE3XHU3MjY5XHU1M0VGXHU3NkY0XHU4REQxKTpcclxuICAgIC8vIHdoZXJlKFBBVEggXHU3NzFGXHU3NkY4KT4gbnBtIFx1NTE2OFx1NUM0MFx1NjgzOSA+IFx1NTQxMVx1NUJGQ1x1NUI4OVx1ODhDNVx1NzZFRVx1NUY1NVxyXG4gICAgZm9yIChjb25zdCBbY2xpLCBzb3VyY2VdIG9mIFtbd2hlcmVDbGlzWzBdID8/ICcnLCAnd2hlcmUtaG1oJ10sIFtucG1DbGksICducG0tZ2xvYmFsJ11dIGFzIEFycmF5PFtzdHJpbmcsIHN0cmluZ10+KSB7XHJcbiAgICAgIGlmIChjbGkgPT09ICcnKSBjb250aW51ZTtcclxuICAgICAgY29uc3QgZW50cnkgPSBlbnRyeUZyb21DbGlEaXIoY2xpKTtcclxuICAgICAgaWYgKGVudHJ5ICE9PSAnJykgcmV0dXJuIHsgZW50cnksIHZlcnNpb246IHBrZ1ZlcnNpb25BdChjbGkpLCBzb3VyY2UgfTtcclxuICAgIH1cclxuICAgIGNvbnN0IHdpemFyZEVudHJ5ID0gcmVzb2x2ZUluc3RhbGxlZEVudHJ5KGluc3RhbGxUYXJnZXQoKSk7XHJcbiAgICBpZiAod2l6YXJkRW50cnkgIT09ICcnKSB7XHJcbiAgICAgIHJldHVybiB7IGVudHJ5OiB3aXphcmRFbnRyeSwgdmVyc2lvbjogcGtnVmVyc2lvbkF0KGpvaW4oaW5zdGFsbFRhcmdldCgpLCAnbm9kZV9tb2R1bGVzJywgJ0BobWhhcm5lc3MnLCAnY2xpJykpLCBzb3VyY2U6ICd3aXphcmQtaW5zdGFsbCcgfTtcclxuICAgIH1cclxuXHJcbiAgICAvLyBcdTZFOTBcdTc4MDEgcmVwbyBcdTVFMDNcdTVDNDAod2hlcmUgPiBucG0gXHU1MTY4XHU1QzQwID4gXHU1RTM4XHU4OUMxXHU2RTkwXHU3ODAxXHU0RjREXHU3RjZFO1x1NTQ3RFx1NEUyRFx1OTg3Qlx1NjcwOVx1NTE2NVx1NTNFM1x1NEUwRVx1NEY5RFx1OEQ1NilcclxuICAgIGNvbnN0IHJlcG9zID0gbmV3IFNldDxzdHJpbmc+KFsuLi53aGVyZVJlcG9zLCAuLi5ucG1SZXBvc10pO1xyXG4gICAgY29uc3QgYmFzZXMgPSBbJ0M6XFxcXCcsICdEOlxcXFwnLCAnRTpcXFxcJywgJ0Y6XFxcXCcsICdHOlxcXFwnLCAnSDpcXFxcJywgaG9tZWRpcigpLCBqb2luKGhvbWVkaXIoKSwgJ0RldmVsb3BlcicpXTtcclxuICAgIGZvciAoY29uc3QgYmFzZSBvZiBiYXNlcykge1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHAgPSByZXNvbHZlKGJhc2UsICdobWhhcm5lc3MnKTtcclxuICAgICAgICBpZiAoZXhpc3RzU3luYyhwKSkgcmVwb3MuYWRkKHApO1xyXG4gICAgICB9IGNhdGNoIHsgLyogXHU3NkQ4XHU0RTBEXHU1QjU4XHU1NzI4ICovIH1cclxuICAgIH1cclxuICAgIGZvciAoY29uc3QgcmVwbyBvZiByZXBvcykge1xyXG4gICAgICBjb25zdCBlbnRyeSA9IGpvaW4ocmVwbywgJ3BhY2thZ2VzJywgJ3dlYicsICdzcmMnLCAnZGVza3RvcC1ob3N0LnRzJyk7XHJcbiAgICAgIGlmIChleGlzdHNTeW5jKGVudHJ5KSAmJiBleGlzdHNTeW5jKGpvaW4ocmVwbywgJ25vZGVfbW9kdWxlcycpKSkge1xyXG4gICAgICAgIHJldHVybiB7IGVudHJ5LCB2ZXJzaW9uOiBwa2dWZXJzaW9uQXQocmVwbyksIHNvdXJjZTogJ3NvdXJjZS1yZXBvJyB9O1xyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4geyBlbnRyeTogJycsIHZlcnNpb246ICcnLCBzb3VyY2U6ICcnIH07XHJcbiAgfVxyXG5cclxuICBmdW5jdGlvbiBkZXRlY3RSZWFsRW50cnkoKTogc3RyaW5nIHtcclxuICAgIHJldHVybiBkZXRlY3RFeHRlcm5hbFJ1bnRpbWUoKS5lbnRyeTtcclxuICB9XHJcblxyXG4gIC8qKiBcdTg5RTNcdTY3OTAgcnVudGltZSBcdTUxNjVcdTUzRTNcdTYyNDBcdTVDNUVcdTc2ODQgaG1oYXJuZXNzIFx1NEVEM1x1NUU5M1x1NjgzOShwYWNrYWdlcy93ZWIvc3JjfGRpc3QgXHU0RTBBXHU2RUFGKVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIHJlcG9Sb290T2YoZW50cnk6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgICBsZXQgZGlyID0gZGlybmFtZShlbnRyeSk7XHJcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IDY7IGkrKykge1xyXG4gICAgICBpZiAoZXhpc3RzU3luYyhqb2luKGRpciwgJ3BhY2thZ2UuanNvbicpKSAmJiBleGlzdHNTeW5jKGpvaW4oZGlyLCAncGFja2FnZXMnLCAnd2ViJykpKSByZXR1cm4gZGlyO1xyXG4gICAgICBjb25zdCBwYXJlbnQgPSBkaXJuYW1lKGRpcik7XHJcbiAgICAgIGlmIChwYXJlbnQgPT09IGRpcikgYnJlYWs7XHJcbiAgICAgIGRpciA9IHBhcmVudDtcclxuICAgIH1cclxuICAgIHJldHVybiBkaXJuYW1lKGVudHJ5KTtcclxuICB9XHJcblxyXG4gIGxldCBydW50aW1lRW50cnkgPSAnJzsgLy8gXHU1RjUzXHU1MjREXHU1QjlFXHU5NjQ1XHU0RjdGXHU3NTI4XHU3Njg0XHU3NzFGXHU1QjlFIHJ1bnRpbWUgXHU1MTY1XHU1M0UzKCcnPVx1NjcyQVx1NjNBNSlcclxuICBsZXQgdXNlQnVuZGxlZFJ1bnRpbWUgPSBmYWxzZTsgLy8gdjU6XHU2NjJGXHU1NDI2XHU1NzI4XHU3NTI4XHU1MTg1XHU3RjZFIHJ1bnRpbWUoXHU1MTczXHU0RThFL1x1OTc2Mlx1Njc3Rlx1NjgwN1x1NkNFOClcclxuXHJcbiAgLyoqIFx1NTE4NVx1N0Y2RSBydW50aW1lKHY1IFx1NUYwMFx1N0JCMVx1NTM3M1x1NzUyOCk6XHU2MjUzXHU1MzA1XHU1NDBFXHU5NjhGIGV4dHJhUmVzb3VyY2VzIFx1NUU3M1x1OTRGQVx1NTcyOCByZXNvdXJjZXMvO1xyXG4gICAgIGRldiBcdTc1MjhcdTRFRDNcdTVFOTNcdTUxODVcdTY3ODRcdTVFRkFcdTRFQTdcdTcyNjkoc2NyaXB0cy9idW5kbGUtcnVudGltZS5tanMpXHUzMDAyXHU4MUVBXHU1MzA1XHU1NDJCXHU1MzU1XHU2NTg3XHU0RUY2LFx1NjVFMCB0c3hcdTMwMDFcclxuICAgICBcdTY1RTAgcmVwbyBub2RlX21vZHVsZXMgXHU0RjlEXHU4RDU2XHUzMDAyICovXHJcbiAgZnVuY3Rpb24gYnVuZGxlZFJ1bnRpbWVQYXRoKHJlcG9Sb290OiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIGpvaW4oYXBwLmlzUGFja2FnZWQgPyBwcm9jZXNzLnJlc291cmNlc1BhdGggOiBqb2luKHJlcG9Sb290LCAnYXBwcycsICdkZXNrdG9wJywgJ3Jlc291cmNlcycpLCAncnVudGltZScsICdydW50aW1lLmNqcycpO1xyXG4gIH1cclxuXHJcbiAgLyoqIFx1NTE4NVx1N0Y2RSBydW50aW1lIFx1NTE0M1x1NEZFMVx1NjA2RihcdTU0MTFcdTVCRkNcIlx1NTE4NVx1N0Y2RVx1N0NCRVx1N0I4MFx1NTE4NVx1NjgzOFwiXHU5MDA5XHU5ODc5XHU3Njg0XHU3MjQ4XHU2NzJDXHU2ODA3XHU2Q0U4KVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIGJ1bmRsZWRSdW50aW1lSW5mbygpOiB7IHJlYWR5OiBib29sZWFuOyB2ZXJzaW9uOiBzdHJpbmcgfSB7XHJcbiAgICBjb25zdCByZXBvUm9vdCA9IGpvaW4oaGVyZSwgJy4uJywgJy4uJywgJy4uJywgJy4uJyk7XHJcbiAgICBjb25zdCBwID0gYnVuZGxlZFJ1bnRpbWVQYXRoKHJlcG9Sb290KTtcclxuICAgIGxldCB2ZXJzaW9uID0gJyc7XHJcbiAgICB0cnkge1xyXG4gICAgICBjb25zdCB2ID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoam9pbihkaXJuYW1lKHApLCAncGFja2FnZS5qc29uJyksICd1dGY4JykpIGFzIHsgdmVyc2lvbj86IHVua25vd24gfTtcclxuICAgICAgdmVyc2lvbiA9IHR5cGVvZiB2LnZlcnNpb24gPT09ICdzdHJpbmcnID8gdi52ZXJzaW9uIDogJyc7XHJcbiAgICB9IGNhdGNoIHsgLyogXHU1MTQzXHU2NTcwXHU2MzZFXHU3RjNBXHU1OTMxXHU1MjE5XHU1M0VBXHU2MkE1IHJlYWR5ICovIH1cclxuICAgIHJldHVybiB7IHJlYWR5OiBleGlzdHNTeW5jKHApLCB2ZXJzaW9uIH07XHJcbiAgfVxyXG5cclxuICAvKiogbnBtIFx1NjYyRlx1NTQyNlx1NTcyOCBQQVRIKFx1NTQxMVx1NUJGQ1x1OTAwOVx1NjJFOVx1OTg3NSBcdTI0NjAgXHU3Njg0XHU1Qjg5XHU4OEM1XHU2NUI5XHU1RjBGXHU2ODA3XHU2Q0U4O3doZXJlIFx1NUZFQlx1NjNBMixcdTRFMERcdTUwNUFcdTVCOENcdTY1NzRcdTYzQTJcdTZENEIpXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gbnBtT25QYXRoKCk6IGJvb2xlYW4ge1xyXG4gICAgdHJ5IHtcclxuICAgICAgZXhlY0ZpbGVTeW5jKCd3aGVyZScsIFsnbnBtJ10sIHsgZW5jb2Rpbmc6ICd1dGY4JywgdGltZW91dDogNF8wMDAsIHdpbmRvd3NIaWRlOiB0cnVlIH0pO1xyXG4gICAgICByZXR1cm4gdHJ1ZTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4gZmFsc2U7IH1cclxuICB9XHJcblxyXG4gIC8qIC0tLS0gXHU5OTk2XHU1NDJGXHU1Qjg5XHU4OEM1XHU1NDExXHU1QkZDXHU3MkI2XHU2MDAxKHY1LjEpIC0tLS0gKi9cclxuICBjb25zdCB3aXphcmRGaWxlID0gKCk6IHN0cmluZyA9PiBqb2luKGFwcC5nZXRQYXRoKCd1c2VyRGF0YScpLCAnd2l6YXJkLmpzb24nKTtcclxuICBhc3luYyBmdW5jdGlvbiBsb2FkV2l6YXJkU3RhdGUoKTogUHJvbWlzZTx7IGRvbmU6IGJvb2xlYW47IGNob2ljZTogc3RyaW5nIH0+IHtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IHYgPSBKU09OLnBhcnNlKGF3YWl0IHJlYWRGaWxlKHdpemFyZEZpbGUoKSwgJ3V0ZjgnKSkgYXMgeyBkb25lPzogdW5rbm93bjsgY2hvaWNlPzogdW5rbm93biB9O1xyXG4gICAgICByZXR1cm4geyBkb25lOiB2LmRvbmUgPT09IHRydWUsIGNob2ljZTogdHlwZW9mIHYuY2hvaWNlID09PSAnc3RyaW5nJyA/IHYuY2hvaWNlIDogJycgfTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4geyBkb25lOiBmYWxzZSwgY2hvaWNlOiAnJyB9OyB9XHJcbiAgfVxyXG4gIGFzeW5jIGZ1bmN0aW9uIHNhdmVXaXphcmRTdGF0ZShjaG9pY2U6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgYXdhaXQgd3JpdGVGaWxlKHdpemFyZEZpbGUoKSwgSlNPTi5zdHJpbmdpZnkoeyBkb25lOiB0cnVlLCBjaG9pY2UgfSwgbnVsbCwgMiksICd1dGY4JykuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcclxuICB9XHJcbiAgLyoqIFx1NTQxMVx1NUJGQ1x1ODFFQVx1NTJBOFx1NUYzOVx1NTFGQVx1NjI5MVx1NTIzNjpcdTZENEJcdThCRDUvXHU1RjAwXHU1M0QxXHU3M0FGXHU1ODgzXHU0RTBEXHU1RjM5KFVJVkVSSUZZL1NOQVBTSE9UL1JFTkRFUl9URVNUL1xyXG4gICAqICBET01QUk9CRS9TRUNVUklUWV9URVNUL0ZBS0UvZGV2KTtITUhfREVTS1RPUF9XSVpBUkRfRk9SQ0U9MSBcdTVGM0FcdTUyMzZcdTVGMzkoXHU5QThDXHU2NTM2KVx1MzAwMiAqL1xyXG4gIGZ1bmN0aW9uIHdpemFyZFN1cHByZXNzZWQoKTogYm9vbGVhbiB7XHJcbiAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfV0laQVJEX0ZPUkNFID09PSAnMScpIHJldHVybiBmYWxzZTtcclxuICAgIHJldHVybiBpc0RldlxyXG4gICAgICB8fCBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWSA9PT0gJzEnXHJcbiAgICAgIHx8IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NOQVBTSE9UICE9PSB1bmRlZmluZWRcclxuICAgICAgfHwgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfUkVOREVSX1RFU1QgPT09ICcxJ1xyXG4gICAgICB8fCBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9ET01QUk9CRSA9PT0gJzEnXHJcbiAgICAgIHx8IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NFQ1VSSVRZX1RFU1QgPT09ICcxJ1xyXG4gICAgICB8fCBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9GQUtFID09PSAnMSc7XHJcbiAgfVxyXG5cclxuICAvKiogXHU1M0QxXHU3M0IwXHU5ODdBXHU1RThGOlx1NjYzRVx1NUYwRlx1ODk4Nlx1NzZENihcdTU0MkJcdTU0MTFcdTVCRkNcdTkwMDlcdTYyRTk6XHU1OTE2XHU5MEU4XHU1MTY1XHU1M0UzL1x1NTE4NVx1N0Y2RVx1OERFRlx1NUY4NC9cdTZGMTRcdTc5M0EpPiBcdTUxODVcdTdGNkVcdTVGMDBcdTUxNzNcclxuICAgICAoSE1IX0RFU0tUT1BfQlVORExFRD0xKT4gXHU1OTE2XHU5MEU4XHU1M0QxXHU3M0IwKGRldiBcdTc2RjhcdTkwQkJcdTRFRDNcdTVFOTMgLyB3aGVyZSBobWggLyBucG0gXHU1MTY4XHU1QzQwIC9cclxuICAgICBcdTU0MTFcdTVCRkNcdTVCODlcdTg4QzVcdTc2RUVcdTVGNTUgLyBcdTZFOTBcdTc4MDFcdTRGNERcdTdGNkUpPiBcdTUxODVcdTdGNkVcdTUxNUNcdTVFOTVcdTMwMDJcdTU5MTZcdTkwRThcdTRGMThcdTUxNDg9XHU4MDAxXHU3NTI4XHU2MjM3XHU3RUU3XHU3RUVEXHU3NTI4XHU4MUVBXHU1REYxXHU4OEM1XHU3Njg0XHU3MjQ4XHU2NzJDO1xyXG4gICAgIFx1NTE4NVx1N0Y2RT1cdTY1QjBcdTY3M0FcdTU2NjhcdTg4QzVcdTVCOENcdTc2RjRcdThGREVcdTc3MUZcdTVCOUVcdTUxODVcdTY4MzhcdTMwMDJITUhfREVTS1RPUF9GQUtFPTEgXHU2MjE2IHJ1bnRpbWUuanNvbiBkZW1vPXRydWVcclxuICAgICAoXHU1NDExXHU1QkZDXCJcdTZGMTRcdTc5M0FcdTZBMjFcdTVGMEZcIlx1OTAwOVx1NjJFOSxcdTYzMDFcdTRFNDUpXHU4RkRCXHU2RjE0XHU3OTNBXHUzMDAyICovXHJcbiAgYXN5bmMgZnVuY3Rpb24gc3RhcnRIb3N0KCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgY29uc3QgcmVwb1Jvb3QgPSBqb2luKGhlcmUsICcuLicsICcuLicsICcuLicsICcuLicpOyAvLyBhcHBzL2Rlc2t0b3AvZGlzdC1lbGVjdHJvbi9tYWluIFx1MjE5MiByZXBvIHJvb3RcclxuICAgIGNvbnN0IHBhY2thZ2VkID0gYXBwLmlzUGFja2FnZWQ7XHJcbiAgICBjb25zdCBjZmcgPSBhd2FpdCBsb2FkUnVudGltZUNvbmZpZygpO1xyXG4gICAgY29uc3QgZm9yY2VGYWtlID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfRkFLRSA9PT0gJzEnIHx8IGNmZy5kZW1vO1xyXG4gICAgY29uc3QgZm9yY2VCdW5kbGVkID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfQlVORExFRCA9PT0gJzEnO1xyXG4gICAgY29uc3Qgb3ZlcnJpZGUgPSBjZmcuZW50cnk7XHJcbiAgICBjb25zdCBhZGphY2VudCA9IGpvaW4ocmVwb1Jvb3QsICcuLicsICdobWhhcm5lc3MnLCAncGFja2FnZXMnLCAnd2ViJywgJ3NyYycsICdkZXNrdG9wLWhvc3QudHMnKTtcclxuICAgIGNvbnN0IGJ1bmRsZWQgPSBidW5kbGVkUnVudGltZVBhdGgocmVwb1Jvb3QpO1xyXG4gICAgY29uc3QgYnVuZGxlZFJlYWR5ID0gZXhpc3RzU3luYyhidW5kbGVkKTtcclxuICAgIC8vIFx1ODlFM1x1Njc5MChcdTdFRDNcdTY3OUNcdTVGNTJcdTRFMDA6b3ZlcnJpZGU9YnVuZGxlZCBcdThERUZcdTVGODRcdTIxOTJcdTUxODVcdTdGNkU7XHU2RTkwXHU3ODAxIC50cyBcdTk3MDAgdHN4O1xyXG4gICAgLy8gbnBtIFx1NUI4OVx1ODhDNSAuanMgXHU3RjE2XHU4QkQxXHU0RUE3XHU3MjY5XHU3NkY0XHU4REQxO2J1bmRsZWQ9XHU4MUVBXHU1MzA1XHU1NDJCIGNqcyBcdTc2RjRcdThERDEpXHJcbiAgICBsZXQgZW50cnkgPSAnJztcclxuICAgIHVzZUJ1bmRsZWRSdW50aW1lID0gZmFsc2U7XHJcbiAgICBpZiAoZm9yY2VGYWtlKSB7XHJcbiAgICAgIC8vIFx1NkYxNFx1NzkzQVx1NkEyMVx1NUYwRlxyXG4gICAgfSBlbHNlIGlmIChvdmVycmlkZSAhPT0gJycpIHtcclxuICAgICAgZW50cnkgPSBvdmVycmlkZTtcclxuICAgICAgaWYgKG92ZXJyaWRlID09PSBidW5kbGVkKSB1c2VCdW5kbGVkUnVudGltZSA9IHRydWU7IC8vIFx1NTQxMVx1NUJGQ1x1OTAwOVwiXHU1MTg1XHU3RjZFXHU3Q0JFXHU3QjgwXHU1MTg1XHU2ODM4XCJcdTc2ODRcdTYzMDFcdTRFNDVcdTVGNjJcdTYwMDFcclxuICAgIH0gZWxzZSBpZiAoZm9yY2VCdW5kbGVkKSB7XHJcbiAgICAgIGlmIChidW5kbGVkUmVhZHkpIHsgZW50cnkgPSBidW5kbGVkOyB1c2VCdW5kbGVkUnVudGltZSA9IHRydWU7IH1cclxuICAgICAgZWxzZSBsb2dJbmZvKCdob3N0JywgJ0hNSF9ERVNLVE9QX0JVTkRMRUQ9MSBcdTRGNDZcdTUxODVcdTdGNkUgcnVudGltZSBcdTdGM0FcdTU5MzEoXHU1MTQ4XHU4REQxIHNjcmlwdHMvYnVuZGxlLXJ1bnRpbWUubWpzKScpO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgZW50cnkgPSBwYWNrYWdlZCA/IGRldGVjdFJlYWxFbnRyeSgpIDogKGV4aXN0c1N5bmMoYWRqYWNlbnQpID8gYWRqYWNlbnQgOiBkZXRlY3RSZWFsRW50cnkoKSk7XHJcbiAgICAgIGlmIChlbnRyeSA9PT0gJycgJiYgYnVuZGxlZFJlYWR5KSB7IGVudHJ5ID0gYnVuZGxlZDsgdXNlQnVuZGxlZFJ1bnRpbWUgPSB0cnVlOyB9XHJcbiAgICB9XHJcbiAgICBydW50aW1lRW50cnkgPSBlbnRyeTtcclxuICAgIGNvbnN0IHVzZVJlYWwgPSBlbnRyeSAhPT0gJycgJiYgKHVzZUJ1bmRsZWRSdW50aW1lIHx8IGV4aXN0c1N5bmMoZW50cnkpKTtcclxuICAgIGJyaWRnZSA9IHtcclxuICAgICAgLi4uYnJpZGdlLFxyXG4gICAgICBtb2RlOiB1c2VSZWFsID8gJ3JlYWwnIDogJ2Zha2UnLFxyXG4gICAgICBydW50aW1lRW50cnk6IHVzZVJlYWwgPyAodXNlQnVuZGxlZFJ1bnRpbWUgPyBgJHtlbnRyeX0gKGJ1bmRsZWQpYCA6IGVudHJ5KSA6IG51bGwsXHJcbiAgICB9O1xyXG4gICAgbGV0IHNwZWM6IHsgY29tbWFuZDogc3RyaW5nOyBhcmdzOiBzdHJpbmdbXTsgZW52OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+OyBjd2Q/OiBzdHJpbmcgfTtcclxuICAgIGlmICh1c2VCdW5kbGVkUnVudGltZSkge1xyXG4gICAgICBzcGVjID0ge1xyXG4gICAgICAgIGNvbW1hbmQ6IHByb2Nlc3MuZXhlY1BhdGgsXHJcbiAgICAgICAgYXJnczogW2VudHJ5XSwgLy8gXHU4MUVBXHU1MzA1XHU1NDJCXHU1MzU1XHU2NTg3XHU0RUY2OmVsZWN0cm9uLWFzLW5vZGUgXHU3NkY0XHU4REQxLFx1NjVFMCB0c3ggXHU2NUUwIHJlcG9cclxuICAgICAgICBlbnY6IHsgRUxFQ1RST05fUlVOX0FTX05PREU6ICcxJyB9LFxyXG4gICAgICB9O1xyXG4gICAgfSBlbHNlIGlmICh1c2VSZWFsICYmIGVudHJ5LmVuZHNXaXRoKCcuanMnKSkge1xyXG4gICAgICBzcGVjID0ge1xyXG4gICAgICAgIGNvbW1hbmQ6IHByb2Nlc3MuZXhlY1BhdGgsXHJcbiAgICAgICAgYXJnczogW2VudHJ5XSwgLy8gbnBtIFx1NUI4OVx1ODhDNVx1NzY4NFx1N0YxNlx1OEJEMVx1NEVBN1x1NzI2OTpFU00gXHU0RjlEXHU4RDU2XHU2MzA5XHU2NTg3XHU0RUY2XHU0RjREXHU3RjZFXHU4OUUzXHU2NzkwLFx1NzZGNFx1OEREMVx1NTM3M1x1NTNFRlxyXG4gICAgICAgIGN3ZDogZGlybmFtZShlbnRyeSksXHJcbiAgICAgICAgZW52OiB7IEVMRUNUUk9OX1JVTl9BU19OT0RFOiAnMScgfSxcclxuICAgICAgfTtcclxuICAgIH0gZWxzZSBpZiAodXNlUmVhbCkge1xyXG4gICAgICBjb25zdCByZXBvID0gcmVwb1Jvb3RPZihlbnRyeSk7XHJcbiAgICAgIHNwZWMgPSB7XHJcbiAgICAgICAgY29tbWFuZDogcHJvY2Vzcy5leGVjUGF0aCxcclxuICAgICAgICBhcmdzOiBbJy0taW1wb3J0JywgJ3RzeCcsIGVudHJ5XSxcclxuICAgICAgICBjd2Q6IHJlcG8sIC8vIGJhcmUgJ3RzeCcgXHU0RTBFIHdvcmtzcGFjZSBcdTRGOURcdThENTZcdTkwRkRcdTRFQ0UgcmVwbyBcdTc2ODQgbm9kZV9tb2R1bGVzIFx1ODlFM1x1Njc5MFxyXG4gICAgICAgIGVudjogeyBFTEVDVFJPTl9SVU5fQVNfTk9ERTogJzEnIH0sXHJcbiAgICAgIH07XHJcbiAgICB9IGVsc2UgaWYgKHBhY2thZ2VkKSB7XHJcbiAgICAgIHNwZWMgPSB7XHJcbiAgICAgICAgY29tbWFuZDogcHJvY2Vzcy5leGVjUGF0aCxcclxuICAgICAgICBhcmdzOiBbam9pbihwcm9jZXNzLnJlc291cmNlc1BhdGgsICdmYWtlLWhvc3QuY2pzJyldLFxyXG4gICAgICAgIGVudjogeyBFTEVDVFJPTl9SVU5fQVNfTk9ERTogJzEnIH0sXHJcbiAgICAgIH07XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICBzcGVjID0ge1xyXG4gICAgICAgIGNvbW1hbmQ6IHByb2Nlc3MuZXhlY1BhdGgsXHJcbiAgICAgICAgLy8gXHU3NkY0XHU2M0E1XHU4RDcwXHU1MzA1XHU3NzFGXHU1QjlFXHU4REVGXHU1Rjg0KG5vZGVfbW9kdWxlcyBcdTkxQ0NcdTc2ODQgd29ya3NwYWNlIGp1bmN0aW9uIFx1NEYxQVx1ODhBQiBFU01cclxuICAgICAgICAvLyByZWFscGF0aCBcdTUzMTYsXHU1QkZDXHU4MUY0IGZha2UtaG9zdCBcdTc2ODQgYXJndlsxXS9pbXBvcnQubWV0YS51cmwgXHU1MzM5XHU5MTREXHU1OTMxXHU2NTQ4KVxyXG4gICAgICAgIGFyZ3M6IFsnLS1pbXBvcnQnLCAndHN4Jywgam9pbihyZXBvUm9vdCwgJ3BhY2thZ2VzJywgJ2hvc3QtYWRhcHRlcicsICdzcmMnLCAnZmFrZS1ob3N0LnRzJyldLFxyXG4gICAgICAgIGVudjogeyBFTEVDVFJPTl9SVU5fQVNfTk9ERTogJzEnIH0sXHJcbiAgICAgIH07XHJcbiAgICB9XHJcbiAgICBzdXBlcnZpc29yID0gbmV3IERlc2t0b3BSdW50aW1lU3VwZXJ2aXNvcihzcGVjLCB7XHJcbiAgICAgIG9uU3RhdGVDaGFuZ2U6IGJyb2FkY2FzdEhvc3RTdGF0ZSxcclxuICAgICAgLy8gXHU5OTk2XHU2QjIxXHU1NDJGXHU1MkE4XHU0RTBFIGNyYXNoIFx1ODFFQVx1NjEwOFx1NTQwRVx1NzY4NFx1OTFDRFx1NTQyRlx1OTBGRFx1NEYxQVx1OEQ3MFx1OEZEOVx1OTFDQzpcdTdBRUZcdTUzRTMvdG9rZW4gXHU5MEZEXHU2NjJGXHU2NUIwXHU3Njg0LFxyXG4gICAgICAvLyBcdTkxQ0RcdTVFRkFcdTY4NjVcdTVCQTJcdTYyMzdcdTdBRUZcdTVFNzZcdTkxQ0RcdTY1QjBcdThCQTJcdTk2MDUgU1NFKHJlbmRlcmVyIFx1NzY4NCBFdmVudFN0b3JlIFx1OTc2MCBldmVudElkIFx1NTNCQlx1OTFDRClcclxuICAgICAgb25SZWFkeTogKGVwKSA9PiB7XHJcbiAgICAgICAgY2xpZW50ID0gbmV3IERlc2t0b3BIb3N0Q2xpZW50KGBodHRwOi8vMTI3LjAuMC4xOiR7ZXAucG9ydH1gLCBlcC50b2tlbik7XHJcbiAgICAgICAgc3NlQWJvcnQ/LmFib3J0KCk7XHJcbiAgICAgICAgc3NlQWJvcnQgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XHJcbiAgICAgICAgbGFzdEV2ZW50SWQgPSAnJztcclxuICAgICAgICB2b2lkIHB1bXBFdmVudHMoKTtcclxuICAgICAgICBsb2dJbmZvKCdob3N0JywgYGJyaWRnZSByZWFkeSBvbiAxMjcuMC4wLjE6JHtlcC5wb3J0fSAocnVudGltZSAke2VwLnZlcnNpb259LCBtb2RlICR7YnJpZGdlLm1vZGV9JHt1c2VSZWFsID8gYCwgZW50cnk9JHtydW50aW1lRW50cnl9JHt1c2VCdW5kbGVkUnVudGltZSA/ICcgW2J1bmRsZWRdJyA6ICcnfWAgOiAnJ30pYCk7XHJcbiAgICAgIH0sXHJcbiAgICB9KTtcclxuICAgIHRyeSB7XHJcbiAgICAgIGF3YWl0IHN1cGVydmlzb3Iuc3RhcnQoKTtcclxuICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICBjb25zdCBkZXRhaWwgPSAoKCkgPT4geyB0cnkgeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkoZXJyKTsgfSBjYXRjaCB7IHJldHVybiBTdHJpbmcoZXJyKTsgfSB9KSgpLnNsaWNlKDAsIDQwMCk7XHJcbiAgICAgIGJyaWRnZSA9IHsgLi4uYnJpZGdlLCBob3N0U3RhdGU6ICdmYWlsZWQnLCBsYXN0RXJyb3I6IGRldGFpbCB9O1xyXG4gICAgICBsb2dJbmZvKCdob3N0JywgYHN0YXJ0IGZhaWxlZDogJHtkZXRhaWx9YCk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvKiAtLS0tIElQQyBcdTc2N0RcdTU0MERcdTUzNTUgKyBzZW5kZXIgXHU2ODIxXHU5QThDIC0tLS0gKi9cclxuICBjb25zdCBhbGxvd2VkT3JpZ2lucyA9IG5ldyBTZXQ8c3RyaW5nPihcclxuICAgIGlzRGV2ICYmIHJlbmRlcmVyRGV2VXJsXHJcbiAgICAgID8gW3JlbmRlcmVyRGV2VXJsXVxyXG4gICAgICA6IFtwYXRoVG9GaWxlVVJMKGpvaW4oaGVyZSwgJy4uJywgJy4uJywgJ2Rpc3QtcmVuZGVyZXInLCAnaW5kZXguaHRtbCcpKS5ocmVmXSxcclxuICApO1xyXG5cclxuICBmdW5jdGlvbiBzZW5kZXJUcnVzdGVkKHNlbmRlckZyYW1lOiBFbGVjdHJvbi5XZWJGcmFtZU1haW4gfCBudWxsIHwgdW5kZWZpbmVkKTogYm9vbGVhbiB7XHJcbiAgICBpZiAoc2VuZGVyRnJhbWUgPT09IG51bGwgfHwgc2VuZGVyRnJhbWUgPT09IHVuZGVmaW5lZCkgcmV0dXJuIGZhbHNlO1xyXG4gICAgbGV0IHRvcDogRWxlY3Ryb24uV2ViRnJhbWVNYWluIHwgbnVsbCA9IHNlbmRlckZyYW1lO1xyXG4gICAgd2hpbGUgKHRvcD8ucGFyZW50ICE9PSBudWxsICYmIHRvcD8ucGFyZW50ICE9PSB1bmRlZmluZWQpIHRvcCA9IHRvcC5wYXJlbnQ7XHJcbiAgICBjb25zdCB1cmwgPSB0b3A/LnVybCA/PyAnJztcclxuICAgIGZvciAoY29uc3Qgb3JpZ2luIG9mIGFsbG93ZWRPcmlnaW5zKSB7XHJcbiAgICAgIGlmICh1cmwgPT09IG9yaWdpbiB8fCB1cmwuc3RhcnRzV2l0aChgJHtvcmlnaW59L2ApIHx8IHVybC5zdGFydHNXaXRoKGAke29yaWdpbn0/YCkpIHJldHVybiB0cnVlO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGZhbHNlO1xyXG4gIH1cclxuXHJcbiAgLyoqIFx1OTcwMFx1ODk4MSBob3N0IFx1NUMzMVx1N0VFQVx1NzY4NCBJUEMgaGFuZGxlciBcdTUxNkNcdTUxNzFcdTU4RjM6XHU2NzJBXHU1QzMxXHU3RUVBXHU4RkQ0XHU1NkRFXHU3RUQzXHU2Nzg0XHU1MzE2XHU5NTE5XHU4QkVGXHUzMDAyICovXHJcbiAgZnVuY3Rpb24gaG9zdENhbGw8VD4oZXZlbnQ6IEVsZWN0cm9uLklwY01haW5JbnZva2VFdmVudCwgZm46IChjOiBEZXNrdG9wSG9zdENsaWVudCkgPT4gUHJvbWlzZTxUPik6IFByb21pc2U8VCB8IHsgZXJyb3I6IHN0cmluZzsgY29kZTogc3RyaW5nIH0+IHtcclxuICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9KTtcclxuICAgIGlmIChjbGllbnQgPT09IG51bGwgfHwgYnJpZGdlLmhvc3RTdGF0ZSAhPT0gJ3JlYWR5Jykge1xyXG4gICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6IGBob3N0IG5vdCByZWFkeSAoJHticmlkZ2UuaG9zdFN0YXRlfSlgLCBjb2RlOiAnSE9TVF9OT1RfUkVBRFknIH0pO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGZuKGNsaWVudCkuY2F0Y2goKGVycjogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBkZXRhaWwgPSAoKCkgPT4geyB0cnkgeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkoZXJyKTsgfSBjYXRjaCB7IHJldHVybiBTdHJpbmcoZXJyKTsgfSB9KSgpLnNsaWNlKDAsIDMwMCk7XHJcbiAgICAgIHJldHVybiB7IGVycm9yOiBkZXRhaWwsIGNvZGU6ICdCUklER0VfRVJST1InIH07XHJcbiAgICB9KTtcclxuICB9XHJcblxyXG4gIGZ1bmN0aW9uIHJlZ2lzdGVySXBjKCk6IHZvaWQge1xyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpnZXQtc3RhdGUnLCAoZXZlbnQpID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJyB9O1xyXG4gICAgICByZXR1cm4geyAuLi5icmlkZ2UsIGRyb3BwZWRGcmFtZXMgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6c2Vzc2lvbnMnLCAoZXZlbnQpID0+XHJcbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPHsgc2Vzc2lvbnM6IEFycmF5PHsgaWQ6IHN0cmluZzsgdGl0bGU6IHN0cmluZzsgdGFzazogc3RyaW5nOyBvdXRjb21lOiBzdHJpbmc7IHR1cm5zOiBudW1iZXI7IHRvb2xVc2VzOiBudW1iZXI7IHRpbWU6IHN0cmluZzsgY3dkOiBzdHJpbmc7IGNyZWF0ZWRBdDogc3RyaW5nOyB1cGRhdGVkQXQ6IHN0cmluZyB9PiB9PignL2FwaS9zZXNzaW9ucz9saW1pdD0xMDAnKSkpO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6c2VuZC10YXNrJywgKGV2ZW50LCB0ZXh0OiB1bmtub3duLCBzZXNzaW9uSWQ6IHVua25vd24sIG1vZGU6IHVua25vd24sIGF0dGFjaG1lbnRzOiB1bmtub3duLCBpbWFnZXM6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3QgdGFzayA9IHR5cGVvZiB0ZXh0ID09PSAnc3RyaW5nJyA/IHRleHQuc2xpY2UoMCwgMjBfMDAwKSA6ICcnO1xyXG4gICAgICBjb25zdCBzaWQgPSB0eXBlb2Ygc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IHNlc3Npb25JZC5zbGljZSgwLCA4MCkgOiAnJztcclxuICAgICAgY29uc3QgbSA9IG1vZGUgPT09ICdhdXRvJyB8fCBtb2RlID09PSAneW9sbycgPyBtb2RlIDogJ2Fzayc7XHJcbiAgICAgIC8vIFx1OTY0NFx1NEVGNjpcdTU0MEVcdTdBRUZcdTYzODhcdTY3NDMgRFRPIFx1NzY4NFx1N0VERFx1NUJGOVx1OERFRlx1NUY4NChAIFx1OTAwOVx1NjJFOVx1NTY2OC9cdUQ4M0RcdURDQ0UgXHU0RTBBXHU0RjIwXHU1M0VBXHU2NzY1XHU4MUVBXHU2NzJDXHU1NzMwXHU2NTg3XHU0RUY2XHU3Q0ZCXHU3RURGKVxyXG4gICAgICBjb25zdCBhdHRzID0gQXJyYXkuaXNBcnJheShhdHRhY2htZW50cykgPyBhdHRhY2htZW50cy5maWx0ZXIoKGEpOiBhIGlzIHN0cmluZyA9PiB0eXBlb2YgYSA9PT0gJ3N0cmluZycpLnNsaWNlKDAsIDEwKSA6IFtdO1xyXG4gICAgICAvLyBcdTU2RkVcdTcyNDc6cnVudGltZSB2aXNpb24gXHU5NEZFXHU1MzRGXHU4QkFFIHtuYW1lLCBkYXRhVXJsfSBiYXNlNjQoXHUyMjY0MyBcdTVGMjAgXHUyMjY0Nk1CLHJlbmRlcmVyIFx1NzUxRlx1NjIxMClcclxuICAgICAgY29uc3QgaW1ncyA9IEFycmF5LmlzQXJyYXkoaW1hZ2VzKVxyXG4gICAgICAgID8gaW1hZ2VzXHJcbiAgICAgICAgICAgIC5maWx0ZXIoKGltKTogaW0gaXMgeyBuYW1lOiBzdHJpbmc7IGRhdGFVcmw6IHN0cmluZyB9ID0+XHJcbiAgICAgICAgICAgICAgdHlwZW9mIGltID09PSAnb2JqZWN0JyAmJiBpbSAhPT0gbnVsbCAmJiB0eXBlb2YgKGltIGFzIHsgbmFtZT86IHVua25vd24gfSkubmFtZSA9PT0gJ3N0cmluZycgJiYgdHlwZW9mIChpbSBhcyB7IGRhdGFVcmw/OiB1bmtub3duIH0pLmRhdGFVcmwgPT09ICdzdHJpbmcnKVxyXG4gICAgICAgICAgICAuc2xpY2UoMCwgMylcclxuICAgICAgICAgICAgLm1hcCgoaW0pID0+ICh7IG5hbWU6IGltLm5hbWUuc2xpY2UoMCwgMTIwKSwgZGF0YVVybDogaW0uZGF0YVVybC5zbGljZSgwLCA4XzUwMF8wMDApIH0pKVxyXG4gICAgICAgIDogW107XHJcbiAgICAgIGlmICh0YXNrID09PSAnJyB8fCBzaWQgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgb2s6IGZhbHNlLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW47IHJ1bklkPzogc3RyaW5nIH0+KCcvYXBpL3Rhc2snLCB7IHRleHQ6IHRhc2ssIHNlc3Npb25JZDogc2lkLCBtb2RlOiBtLCBhdHRhY2htZW50czogYXR0cywgaW1hZ2VzOiBpbWdzIH0pKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gXHU2QTIxXHU1NzhCXHU1MjA3XHU2MzYyKHJ1bnRpbWUgUE9TVCAvYXBpL21vZGVsOlx1NTIwNyBjaGF0IFx1OERFRlx1NzUzMSxjb25maWcgXHU1MzczXHU2NUY2XHU3NTFGXHU2NTQ4KSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOm1vZGVsLXNldCcsIChldmVudCwgbmFtZTogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBuID0gdHlwZW9mIG5hbWUgPT09ICdzdHJpbmcnID8gbmFtZS50cmltKCkuc2xpY2UoMCwgODApIDogJyc7XHJcbiAgICAgIGlmIChuID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAnbmFtZSByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbjsgbW9kZWw/OiBzdHJpbmcgfT4oJy9hcGkvbW9kZWwnLCB7IG5hbWU6IG4gfSkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBcdTVFOTRcdTc1MjhcdTUxODVcdTY2RjRcdTY1QjAoR2l0SHViIFJlbGVhc2VzO1x1ODFFQVx1NzgxNFx1OTZGNlx1NEY5RFx1OEQ1Nlx1NjZGNFx1NjVCMFx1NTY2OCkgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpjaGVjay11cGRhdGUnLCBhc3luYyAoZXZlbnQpID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgcmV0dXJuIGNoZWNrRm9yVXBkYXRlcygpO1xyXG4gICAgfSk7XHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmFwcGx5LXVwZGF0ZScsIChldmVudCkgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBpZiAoaW5zdGFsbGVyUGF0aCA9PT0gbnVsbCkgcmV0dXJuIHsgZXJyb3I6ICdubyBpbnN0YWxsZXIgZG93bmxvYWRlZCcsIGNvZGU6ICdIT1NUX05PVF9SRUFEWScgfTtcclxuICAgICAgYXBwbHlVcGRhdGUoKTtcclxuICAgICAgcmV0dXJuIHsgb2s6IHRydWUgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gXHU2ODA3XHU5ODk4XHU2ODBGXHU0RTNCXHU5ODk4XHU1NDBDXHU2QjY1KFx1NkQ0NVx1ODI3Mlx1NkEyMVx1NUYwRlx1NEUwRFx1NTE4RFx1NjcwOVx1OUVEMVx1Njc2MSkrIFx1MjYzMCBcdTRFM0JcdTgzRENcdTUzNTUgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpjaHJvbWUtdGhlbWUnLCAoZXZlbnQsIGRhcms6IHVua25vd24pID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgYXBwbHlDaHJvbWUoZGFyayA9PT0gdHJ1ZSk7XHJcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlIH07XHJcbiAgICB9KTtcclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cG9wdXAtbWFpbi1tZW51JywgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIHBvcHVwTWFpbk1lbnUoKTtcclxuICAgICAgcmV0dXJuIHsgb2s6IHRydWUgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gXHU2MjRCXHU2NzNBXHU4RkRDXHU3QTBCXHU2M0E3XHU1MjM2KDc3ODggd2ViIFx1NUI4OFx1NjJBNDtcdTc1MjhcdTYyMzdcdTY2M0VcdTVGMEZcdTU0MkZcdTUyQTgsQURSLTAwNSBcdTRFMERcdTlFRDhcdThCQTRcdTVGMDAgTEFOKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnJlbW90ZS13ZWItc3RhdHVzJywgYXN5bmMgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IHAgPSBhd2FpdCBwcm9iZVdlYlJlbW90ZSgpO1xyXG4gICAgICByZXR1cm4geyB1cDogcC51cCwgdmVyc2lvbjogcC52ZXJzaW9uLCBsYW5JcDogbGFuSXBPZigpLCBwb3J0OiBXRUJfUE9SVCwgYXZhaWxhYmxlOiBjbGlFbnRyeU9mKCkgIT09ICcnLCBhdXRvc3RhcnQ6IHdlYkF1dG9zdGFydEluc3RhbGxlZCgpIH07XHJcbiAgICB9KTtcclxuICAgIC8vIC0tLS0gXHU1RjAwXHU2NzNBXHU4MUVBXHU1NDJGKDAuMjMuMzcgd2ViIGluc3RhbGwtZGFlbW9uL3VuaW5zdGFsbC1kYWVtb247XHU3NjdCXHU1RjU1XHU1MzczXHU1Qjg4XHU2MkE0XHU1NzI4XHU3RUJGKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnJlbW90ZS13ZWItYXV0b3N0YXJ0JywgYXN5bmMgKGV2ZW50LCBlbmFibGVkOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGlmIChjbGlFbnRyeU9mKCkgPT09ICcnKSByZXR1cm4geyBlcnJvcjogJ25vIGhtaGFybmVzcyBydW50aW1lIGRldGVjdGVkJywgY29kZTogJ0hPU1RfTk9UX1JFQURZJyB9O1xyXG4gICAgICBydW5DbGkoWyd3ZWInLCBlbmFibGVkID09PSB0cnVlID8gJ2luc3RhbGwtZGFlbW9uJyA6ICd1bmluc3RhbGwtZGFlbW9uJ10pO1xyXG4gICAgICAvLyBpbnN0YWxsLWRhZW1vbiBcdTdBQ0JcdTUzNzNcdTYyQzlcdThENzdcdTVCODhcdTYyQTQ6XHU4RjZFXHU4QkUyXHU3ODZFXHU4QkE0O3VuaW5zdGFsbCBcdTUzNzNcdTY1RjZcdTc1MUZcdTY1NDhcclxuICAgICAgaWYgKGVuYWJsZWQgPT09IHRydWUpIHtcclxuICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IDUwOyBpKyspIHtcclxuICAgICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDUwMCkpO1xyXG4gICAgICAgICAgaWYgKChhd2FpdCBwcm9iZVdlYlJlbW90ZSgpKS51cCkgcmV0dXJuIHsgb2s6IHRydWUsIGF1dG9zdGFydDogd2ViQXV0b3N0YXJ0SW5zdGFsbGVkKCkgfTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHsgZXJyb3I6ICdkYWVtb24gZGlkIG5vdCBjb21lIHVwIHdpdGhpbiAyNXMnLCBjb2RlOiAnUlVOVElNRV9DUkFTSEVEJyB9O1xyXG4gICAgICB9XHJcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBhdXRvc3RhcnQ6IHdlYkF1dG9zdGFydEluc3RhbGxlZCgpIH07XHJcbiAgICB9KTtcclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cmVtb3RlLXdlYi1zdGFydCcsIGFzeW5jIChldmVudCkgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBpZiAoY2xpRW50cnlPZigpID09PSAnJykgcmV0dXJuIHsgZXJyb3I6ICdubyBobWhhcm5lc3MgcnVudGltZSBkZXRlY3RlZCcsIGNvZGU6ICdIT1NUX05PVF9SRUFEWScgfTtcclxuICAgICAgaWYgKChhd2FpdCBwcm9iZVdlYlJlbW90ZSgpKS51cCkge1xyXG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBhbHJlYWR5OiB0cnVlLCBsYW5Vcmw6IGBodHRwOi8vJHtsYW5JcE9mKCkgfHwgJzEyNy4wLjAuMSd9OiR7V0VCX1BPUlR9YCB9O1xyXG4gICAgICB9XHJcbiAgICAgIHJ1bkNsaShbJ3dlYicsICdzdGFydCcsICctLWV4cG9zdXJlPWxhbiddKTtcclxuICAgICAgLy8gXHU1Qjg4XHU2MkE0XHU4RkRCXHU3QTBCXHU1MUI3XHU1NDJGXHU1MkE4KHRzeCBcdTdGMTZcdThCRDFcdTY1NzRcdTU5NTcgQ0xJKTpcdThGNkVcdThCRTIgMjVzXHJcbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgNTA7IGkrKykge1xyXG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDUwMCkpO1xyXG4gICAgICAgIGlmICgoYXdhaXQgcHJvYmVXZWJSZW1vdGUoKSkudXApIHtcclxuICAgICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBsYW5Vcmw6IGBodHRwOi8vJHtsYW5JcE9mKCkgfHwgJzEyNy4wLjAuMSd9OiR7V0VCX1BPUlR9YCB9O1xyXG4gICAgICAgIH1cclxuICAgICAgfVxyXG4gICAgICByZXR1cm4geyBlcnJvcjogJ3dlYiBkYWVtb24gZGlkIG5vdCBjb21lIHVwIHdpdGhpbiAyNXMgKHNlZSBITUhfSE9NRS93ZWIubG9nKScsIGNvZGU6ICdSVU5USU1FX0NSQVNIRUQnIH07XHJcbiAgICB9KTtcclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6cmVtb3RlLXdlYi1zdG9wJywgYXN5bmMgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIHJ1bkNsaShbJ3dlYicsICdzdG9wJ10pO1xyXG4gICAgICBmb3IgKGxldCBpID0gMDsgaSA8IDIwOyBpKyspIHtcclxuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCA0MDApKTtcclxuICAgICAgICBpZiAoIShhd2FpdCBwcm9iZVdlYlJlbW90ZSgpKS51cCkgcmV0dXJuIHsgb2s6IHRydWUgfTtcclxuICAgICAgfVxyXG4gICAgICBjb25zdCBzdGlsbCA9IChhd2FpdCBwcm9iZVdlYlJlbW90ZSgpKS51cDtcclxuICAgICAgcmV0dXJuIHN0aWxsID8geyBlcnJvcjogJ3N0aWxsIHJ1bm5pbmcnLCBjb2RlOiAnQlJJREdFX0VSUk9SJyB9IDogeyBvazogdHJ1ZSB9O1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBcdUQ4M0RcdURDQ0UgXHU2NTg3XHU0RUY2XHU0RTBBXHU0RjIwKFx1NjcyQ1x1NTczMFx1NTkxQVx1OTAwOTtydW50aW1lIFx1NjgyMVx1OUE4QyBpbnNpZGVXcyxcdTVERTVcdTRGNUNcdTUzM0FcdTU5MTZcdTY1ODdcdTRFRjZcdTRGMUFcdTg4QUIgNDAwKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnBpY2stZmlsZXMnLCBhc3luYyAoZXZlbnQsIHRpdGxlOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IHdpbiA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmZpbmQoKHcpID0+ICF3LmlzRGVzdHJveWVkKCkpO1xyXG4gICAgICBpZiAod2luID09PSB1bmRlZmluZWQpIHJldHVybiB7IGVycm9yOiAnbm8gd2luZG93JywgY29kZTogJ0JSSURHRV9FUlJPUicgfTtcclxuICAgICAgY29uc3QgciA9IGF3YWl0IGRpYWxvZy5zaG93T3BlbkRpYWxvZyh3aW4sIHtcclxuICAgICAgICB0aXRsZTogdHlwZW9mIHRpdGxlID09PSAnc3RyaW5nJyAmJiB0aXRsZSAhPT0gJycgPyB0aXRsZS5zbGljZSgwLCAxMjApIDogJ1x1OTAwOVx1NjJFOVx1ODk4MVx1OTY0NFx1NTJBMFx1NzY4NFx1NjU4N1x1NEVGNihcdTUzRUZcdTU5MUFcdTkwMDkpJyxcclxuICAgICAgICBwcm9wZXJ0aWVzOiBbJ29wZW5GaWxlJywgJ211bHRpU2VsZWN0aW9ucyddLFxyXG4gICAgICB9KTtcclxuICAgICAgaWYgKHIuY2FuY2VsZWQgfHwgci5maWxlUGF0aHMubGVuZ3RoID09PSAwKSByZXR1cm4geyBvazogZmFsc2UsIGNhbmNlbGVkOiB0cnVlIH07XHJcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBwYXRoczogci5maWxlUGF0aHMuc2xpY2UoMCwgMTApIH07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIFx1RDgzRFx1RENDMSBcdTc2RUVcdTVGNTVcdTkwMDlcdTYyRTkoXHU1REU1XHU0RjVDXHU1MzNBXHU2REZCXHU1MkEwXHU3Njg0XHU2RDRGXHU4OUM4XHU2MzA5XHU5NEFFO1x1NTM5Rlx1NzUxRiBjaG9vc2VyKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnBpY2stZGlyZWN0b3J5JywgYXN5bmMgKGV2ZW50LCB0aXRsZTogdW5rbm93bikgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBjb25zdCB3aW4gPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5maW5kKCh3KSA9PiAhdy5pc0Rlc3Ryb3llZCgpKTtcclxuICAgICAgaWYgKHdpbiA9PT0gdW5kZWZpbmVkKSByZXR1cm4geyBlcnJvcjogJ25vIHdpbmRvdycsIGNvZGU6ICdCUklER0VfRVJST1InIH07XHJcbiAgICAgIGNvbnN0IHIgPSBhd2FpdCBkaWFsb2cuc2hvd09wZW5EaWFsb2cod2luLCB7XHJcbiAgICAgICAgdGl0bGU6IHR5cGVvZiB0aXRsZSA9PT0gJ3N0cmluZycgJiYgdGl0bGUgIT09ICcnID8gdGl0bGUuc2xpY2UoMCwgMTIwKSA6ICdcdTkwMDlcdTYyRTlcdTY1ODdcdTRFRjZcdTU5MzknLFxyXG4gICAgICAgIHByb3BlcnRpZXM6IFsnb3BlbkRpcmVjdG9yeSddLFxyXG4gICAgICB9KTtcclxuICAgICAgaWYgKHIuY2FuY2VsZWQgfHwgci5maWxlUGF0aHNbMF0gPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBjYW5jZWxlZDogdHJ1ZSB9O1xyXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgcGF0aDogci5maWxlUGF0aHNbMF0gfTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gQCBcdTk2NDRcdTRFRjY6XHU1REU1XHU0RjVDXHU1MzNBXHU2NTg3XHU0RUY2XHU2NDFDXHU3RDIyKHJ1bnRpbWUgXHU2Mzg4XHU2NzQzXHU3Njg0XHU4REVGXHU1Rjg0XHU2NzY1XHU2RTkwKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmZzLXNlYXJjaCcsIChldmVudCwgcTogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBxdWVyeSA9IHR5cGVvZiBxID09PSAnc3RyaW5nJyA/IHEuc2xpY2UoMCwgMjAwKSA6ICcnO1xyXG4gICAgICBpZiAocXVlcnkgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgcmVzdWx0czogW10gfSk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjx7IHJlc3VsdHM6IEFycmF5PHsgcmVsOiBzdHJpbmc7IHBhdGg6IHN0cmluZyB9PiB9PihgL2FwaS9mcy9zZWFyY2g/cT0ke2VuY29kZVVSSUNvbXBvbmVudChxdWVyeSl9YCkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTphcHByb3ZlJywgKGV2ZW50LCBncmFudGVkOiB1bmtub3duLCBzZXNzaW9uSWQ6IHVua25vd24pID0+XHJcbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KCcvYXBpL2FwcHJvdmUnLCB7XHJcbiAgICAgICAgZ3JhbnRlZDogZ3JhbnRlZCA9PT0gdHJ1ZSxcclxuICAgICAgICBzZXNzaW9uSWQ6IHR5cGVvZiBzZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gc2Vzc2lvbklkLnNsaWNlKDAsIDgwKSA6ICcnLFxyXG4gICAgICB9KSkpO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6aW50ZXJydXB0JywgKGV2ZW50LCBzZXNzaW9uSWQ6IHVua25vd24pID0+XHJcbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KCcvYXBpL2ludGVycnVwdCcsIHtcclxuICAgICAgICBzZXNzaW9uSWQ6IHR5cGVvZiBzZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gc2Vzc2lvbklkLnNsaWNlKDAsIDgwKSA6ICcnLFxyXG4gICAgICB9KSkpO1xyXG5cclxuICAgIC8vIC0tLS0gTTQ6XHU1REU1XHU0RjVDXHU1MzNBXHU2NTg3XHU0RUY2XHU5NzYyKFx1OERFRlx1NUY4NFx1NjM4OFx1Njc0M1x1NTcyOCBydW50aW1lOmluc2lkZVdzIFx1NjgyMVx1OUE4QykgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpmcy1saXN0JywgKGV2ZW50LCBwYXRoOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IHAgPSB0eXBlb2YgcGF0aCA9PT0gJ3N0cmluZycgPyBwYXRoLnNsaWNlKDAsIDEwMDApIDogJyc7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oYC9hcGkvZnM/ZmlsZXM9MSR7cCAhPT0gJycgPyBgJnBhdGg9JHtlbmNvZGVVUklDb21wb25lbnQocCl9YCA6ICcnfWApKTtcclxuICAgIH0pO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6ZnMtcmVhZCcsIChldmVudCwgcGF0aDogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBwID0gdHlwZW9mIHBhdGggPT09ICdzdHJpbmcnID8gcGF0aC5zbGljZSgwLCAxMDAwKSA6ICcnO1xyXG4gICAgICBpZiAocCA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ3BhdGggcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KGAvYXBpL2ZzL3JlYWQ/cGF0aD0ke2VuY29kZVVSSUNvbXBvbmVudChwKX1gKSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmluamVjdCcsIChldmVudCwgdGV4dDogdW5rbm93biwgc2Vzc2lvbklkOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IHQgPSB0eXBlb2YgdGV4dCA9PT0gJ3N0cmluZycgPyB0ZXh0LnNsaWNlKDAsIDIwXzAwMCkgOiAnJztcclxuICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIHNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBzZXNzaW9uSWQuc2xpY2UoMCwgODApIDogJyc7XHJcbiAgICAgIGlmICh0ID09PSAnJyB8fCBzaWQgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgb2s6IGZhbHNlLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvaW5qZWN0JywgeyB0ZXh0OiB0LCBzZXNzaW9uSWQ6IHNpZCB9KSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIFx1NEYxQVx1OEJERFx1NUJGQ1x1NTFGQShleHBvcnQubWQgXHUyMTkyIFx1NEZERFx1NUI1OFx1NUJGOVx1OEJERFx1Njg0NjtcdTY1ODdcdTRFRjZcdTUxOTlcdTUxNjVcdTUzRUFcdTU3MjggbWFpbikgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpleHBvcnQtc2Vzc2lvbicsIGFzeW5jIChldmVudCwgaWQ6IHVua25vd24sIHRpdGxlOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IHNpZCA9IHR5cGVvZiBpZCA9PT0gJ3N0cmluZycgPyBpZC5yZXBsYWNlKC9bXmEtekEtWjAtOV86LkAtXS9nLCAnJykuc2xpY2UoMCwgODApIDogJyc7XHJcbiAgICAgIGlmIChzaWQgPT09ICcnKSByZXR1cm4geyBlcnJvcjogJ2lkIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9O1xyXG4gICAgICBpZiAoY2xpZW50ID09PSBudWxsIHx8IGJyaWRnZS5ob3N0U3RhdGUgIT09ICdyZWFkeScpIHJldHVybiB7IGVycm9yOiBgaG9zdCBub3QgcmVhZHkgKCR7YnJpZGdlLmhvc3RTdGF0ZX0pYCwgY29kZTogJ0hPU1RfTk9UX1JFQURZJyB9O1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IG1kID0gYXdhaXQgY2xpZW50LmdldFRleHQoYC9hcGkvc2Vzc2lvbnMvJHtlbmNvZGVVUklDb21wb25lbnQoc2lkKX0vZXhwb3J0Lm1kYCk7XHJcbiAgICAgICAgY29uc3Qgd2luID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkuZmluZCgodykgPT4gIXcuaXNEZXN0cm95ZWQoKSk7XHJcbiAgICAgICAgaWYgKHdpbiA9PT0gdW5kZWZpbmVkKSByZXR1cm4geyBlcnJvcjogJ25vIHdpbmRvdycsIGNvZGU6ICdCUklER0VfRVJST1InIH07XHJcbiAgICAgICAgY29uc3QgciA9IGF3YWl0IGRpYWxvZy5zaG93U2F2ZURpYWxvZyh3aW4sIHtcclxuICAgICAgICAgIHRpdGxlOiB0eXBlb2YgdGl0bGUgPT09ICdzdHJpbmcnICYmIHRpdGxlICE9PSAnJyA/IHRpdGxlLnNsaWNlKDAsIDgwKSA6ICdcdTVCRkNcdTUxRkFcdTRGMUFcdThCREQnLFxyXG4gICAgICAgICAgZGVmYXVsdFBhdGg6IGBobWgtJHtzaWR9Lm1kYCxcclxuICAgICAgICAgIGZpbHRlcnM6IFt7IG5hbWU6ICdNYXJrZG93bicsIGV4dGVuc2lvbnM6IFsnbWQnXSB9XSxcclxuICAgICAgICB9KTtcclxuICAgICAgICBpZiAoci5jYW5jZWxlZCB8fCByLmZpbGVQYXRoID09PSB1bmRlZmluZWQgfHwgci5maWxlUGF0aCA9PT0gJycpIHJldHVybiB7IG9rOiBmYWxzZSwgY2FuY2VsZWQ6IHRydWUgfTtcclxuICAgICAgICBhd2FpdCB3cml0ZUZpbGUoci5maWxlUGF0aCwgbWQsICd1dGY4Jyk7XHJcbiAgICAgICAgbG9nSW5mbygnZXhwb3J0JywgYHNlc3Npb24gJHtzaWR9IFx1MjE5MiAke3IuZmlsZVBhdGh9YCk7XHJcbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHBhdGg6IHIuZmlsZVBhdGggfTtcclxuICAgICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgY29uc3QgZGV0YWlsID0gKCgpID0+IHsgdHJ5IHsgcmV0dXJuIEpTT04uc3RyaW5naWZ5KGVycik7IH0gY2F0Y2ggeyByZXR1cm4gU3RyaW5nKGVycik7IH0gfSkoKS5zbGljZSgwLCAzMDApO1xyXG4gICAgICAgIHJldHVybiB7IGVycm9yOiBkZXRhaWwsIGNvZGU6ICdCUklER0VfRVJST1InIH07XHJcbiAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gXHU1QkExXHU2Mjc5XHU2QTIxXHU1RjBGXHU4QkZCXHU1MTk5KFx1Njc0M1x1NUEwMVx1NTcyOCBydW50aW1lIGNvbmZpZztcdTUyMDdcdTYzNjJcdTVGQzVcdTk4N0JcdTY2M0VcdTVGMEYpIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6YXBwcm92YWwtZ2V0JywgKGV2ZW50KSA9PlxyXG4gICAgICBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjx7IHNldHRpbmdzPzogeyBhcHByb3ZhbD86IHN0cmluZyB9IH0+KCcvYXBpL3N0YXRlJykpKTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmFwcHJvdmFsLXNldCcsIChldmVudCwgbW9kZTogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBtID0gbW9kZSA9PT0gJ2F1dG8nID8gJ2F1dG8nIDogbW9kZSA9PT0gJ2FzaycgPyAnYXNrJyA6ICcnO1xyXG4gICAgICBpZiAobSA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ21vZGUgbXVzdCBiZSBhc2t8YXV0bycsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PignL2FwaS9jb25maWcnLCB7IGFwcHJvdmFsOiBtIH0pKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gaG1oYXJuZXNzIHJ1bnRpbWUgXHU4RkRFXHU2M0E1KFx1ODFFQVx1NTJBOFx1NTNEMVx1NzNCMCArIFx1NjI0Qlx1NTJBOFx1ODk4Nlx1NzZENiArIFx1NzBFRFx1NTIwN1x1NjM2MikgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpydW50aW1lLWluZm8nLCBhc3luYyAoZXZlbnQpID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgY29uc3QgZCA9IGRldGVjdEV4dGVybmFsUnVudGltZSgpO1xyXG4gICAgICBjb25zdCBjZmcgPSBhd2FpdCBsb2FkUnVudGltZUNvbmZpZygpO1xyXG4gICAgICByZXR1cm4ge1xyXG4gICAgICAgIG1vZGU6IGJyaWRnZS5tb2RlLFxyXG4gICAgICAgIHJ1bnRpbWVFbnRyeTogYnJpZGdlLnJ1bnRpbWVFbnRyeSxcclxuICAgICAgICBvdmVycmlkZTogY2ZnLmVudHJ5LFxyXG4gICAgICAgIGRlbW86IGNmZy5kZW1vLFxyXG4gICAgICAgIGRldGVjdGVkOiBkLmVudHJ5LFxyXG4gICAgICAgIGRldGVjdGVkVmVyc2lvbjogZC52ZXJzaW9uLFxyXG4gICAgICAgIGRldGVjdGVkU291cmNlOiBkLnNvdXJjZSxcclxuICAgICAgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6YnJvd3NlLXJ1bnRpbWUnLCBhc3luYyAoZXZlbnQsIHRpdGxlOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IHdpbiA9IEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmZpbmQoKHcpID0+ICF3LmlzRGVzdHJveWVkKCkpO1xyXG4gICAgICBpZiAod2luID09PSB1bmRlZmluZWQpIHJldHVybiB7IGVycm9yOiAnbm8gd2luZG93JywgY29kZTogJ0JSSURHRV9FUlJPUicgfTtcclxuICAgICAgY29uc3QgciA9IGF3YWl0IGRpYWxvZy5zaG93T3BlbkRpYWxvZyh3aW4sIHtcclxuICAgICAgICB0aXRsZTogdHlwZW9mIHRpdGxlID09PSAnc3RyaW5nJyAmJiB0aXRsZSAhPT0gJycgPyB0aXRsZS5zbGljZSgwLCAxMjApIDogJ1x1OTAwOVx1NjJFOSBobWhhcm5lc3MgXHU3Njg0IGRlc2t0b3AtaG9zdCBcdTUxNjVcdTUzRTMnLFxyXG4gICAgICAgIHByb3BlcnRpZXM6IFsnb3BlbkZpbGUnXSxcclxuICAgICAgICBmaWx0ZXJzOiBbeyBuYW1lOiAnZGVza3RvcC1ob3N0JywgZXh0ZW5zaW9uczogWyd0cycsICdqcyddIH1dLFxyXG4gICAgICB9KTtcclxuICAgICAgaWYgKHIuY2FuY2VsZWQgfHwgci5maWxlUGF0aHNbMF0gPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgb2s6IGZhbHNlLCBjYW5jZWxlZDogdHJ1ZSB9O1xyXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgZW50cnk6IHIuZmlsZVBhdGhzWzBdIH07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiogXHU4QkJFXHU3RjZFL1x1NkUwNVx1OTY2NFx1NjI0Qlx1NTJBOFx1NTE2NVx1NTNFM1x1NTQwRVx1NzBFRFx1OTFDRFx1NTQyRiBob3N0KFx1N0E3QVx1NEUzMj1cdTU2REVcdTUyMzBcdTgxRUFcdTUyQThcdTUzRDFcdTczQjApXHUzMDAyICovXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnNldC1ydW50aW1lJywgYXN5bmMgKGV2ZW50LCBlbnRyeTogdW5rbm93bikgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBjb25zdCBlID0gdHlwZW9mIGVudHJ5ID09PSAnc3RyaW5nJyA/IGVudHJ5LnRyaW0oKSA6ICcnO1xyXG4gICAgICBpZiAoZSAhPT0gJycgJiYgKCFpc0Fic29sdXRlKGUpIHx8ICFleGlzdHNTeW5jKGUpKSkge1xyXG4gICAgICAgIHJldHVybiB7IGVycm9yOiAnXHU1MTY1XHU1M0UzXHU1RkM1XHU5ODdCXHU2NjJGXHU1QjU4XHU1NzI4XHU3Njg0XHU3RUREXHU1QkY5XHU4REVGXHU1Rjg0KGRlc2t0b3AtaG9zdC50cyknLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH07XHJcbiAgICAgIH1cclxuICAgICAgYXdhaXQgc2F2ZVJ1bnRpbWVFbnRyeU92ZXJyaWRlKGUpO1xyXG4gICAgICAvLyBcdTcwRURcdTUyMDdcdTYzNjI6XHU1MTQ4XHU0RjE4XHU5NkM1XHU1MDVDXHU2Mzg5XHU1RjUzXHU1MjREIGhvc3QsXHU1MThEXHU2MzA5XHU2NUIwXHU5MTREXHU3RjZFXHU2MkM5XHU4RDc3XHJcbiAgICAgIHNzZUFib3J0Py5hYm9ydCgpO1xyXG4gICAgICBpZiAoc3VwZXJ2aXNvciAhPT0gbnVsbCkgYXdhaXQgc3VwZXJ2aXNvci5zdG9wKCk7XHJcbiAgICAgIGF3YWl0IHN0YXJ0SG9zdCgpO1xyXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgbW9kZTogYnJpZGdlLm1vZGUgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gdjUuMSBcdTk5OTZcdTU0MkZcdTVCODlcdTg4QzVcdTU0MTFcdTVCRkM6XHU2NzJDXHU2NzNBXHU2OEMwXHU2RDRCIC8gXHU0RTBCXHU4RjdEXHU1Qjg5XHU4OEM1KFx1OEZEQlx1NUVBNlx1NEU4Qlx1NEVGNikgLyBcdTU0MTFcdTVCRkNcdTcyQjZcdTYwMDEgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpkZXRlY3QtcnVudGltZScsIChldmVudCkgPT4ge1xyXG4gICAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4geyBlcnJvcjogJ3VudHJ1c3RlZCBzZW5kZXInLCBjb2RlOiAnRk9SQklEREVOJyB9O1xyXG4gICAgICBjb25zdCBpbmZvID0gYnVuZGxlZFJ1bnRpbWVJbmZvKCk7XHJcbiAgICAgIC8vIFVJVkVSSUZZIFx1NTQxMVx1NUJGQ1x1NkI2NVx1NzY4NFwiXHU0RjJBXHU5MDIwXHU2NzJBXHU5MTREXHU3RjZFXHU2MDAxXCI6ZmFrZSBcdTZBMjFcdTVGMEZcdTRFMEJcdTYwNTJcdTYyQTVcdTY3MkFcdTY4QzBcdTZENEJcclxuICAgICAgLy8gKFx1NzcxRlx1NUI5RVx1NjhDMFx1NkQ0Qlx1OERFRlx1NUY4NFx1NzUzMSByZWFsIFx1NTNEOFx1NEY1M1x1OUE4Q1x1NjUzNixcdTg5QzEgZXZpZGVuY2Uvc2V0dXAtd2l6YXJkLylcdTMwMDJcclxuICAgICAgLy8gVUlWRVJJRllfRkFLRV9ERVRFQ1RfRk9VTkQ9MSh1aXZlcmlmeSBcdTdBODRcdTVDNEZcdTU3M0FcdTY2NkZcdThGRDBcdTg4NENcdTRFMkRcdTUyQThcdTYwMDFcdTdGNkVcdTRGNEQpOlxyXG4gICAgICAvLyBcdTRGMkFcdTkwMjBcIlx1NjhDMFx1NkQ0Qlx1NTIzMFx1NURGMlx1ODhDNVwiLFx1OEJBOVx1NTQxMVx1NUJGQ1x1NTFGQVx1NzNCMFx1NjhDMFx1NkQ0Qlx1OTg3NVx1NEUwOVx1OTAwOVx1OTg3OSBcdTIxOTIgXHU1MzU1XHU1MUZCXHU1MjREXHU4RkRCIFx1MjE5MiBcdTkwMDlcdTYyRTlcdTk4NzVcdTMwMDJcclxuICAgICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX1dJWkFSRCA9PT0gJ2Zha2UnICYmIHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX0ZBS0UgPT09ICcxJykge1xyXG4gICAgICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9GQUtFX0RFVEVDVF9GT1VORCA9PT0gJzEnKSB7XHJcbiAgICAgICAgICByZXR1cm4geyBmb3VuZDogdHJ1ZSwgdmVyc2lvbjogJzAuMC4wLXZlcmlmeScsIGVudHJ5OiAndmVyaWZ5Oi8vZmFrZS1lbnRyeScsIHNvdXJjZTogJ3ZlcmlmeScsIGJ1bmRsZWQ6IGluZm8sIG5wbTogbnBtT25QYXRoKCkgfTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHsgZm91bmQ6IGZhbHNlLCB2ZXJzaW9uOiAnJywgZW50cnk6ICcnLCBzb3VyY2U6ICcnLCBidW5kbGVkOiBpbmZvLCBucG06IG5wbU9uUGF0aCgpIH07XHJcbiAgICAgIH1cclxuICAgICAgY29uc3QgZCA9IGRldGVjdEV4dGVybmFsUnVudGltZSgpO1xyXG4gICAgICByZXR1cm4geyBmb3VuZDogZC5lbnRyeSAhPT0gJycsIHZlcnNpb246IGQudmVyc2lvbiwgZW50cnk6IGQuZW50cnksIHNvdXJjZTogZC5zb3VyY2UsIGJ1bmRsZWQ6IGluZm8sIG5wbTogbnBtT25QYXRoKCkgfTtcclxuICAgIH0pO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6aW5zdGFsbC1jbGknLCAoZXZlbnQsIG9wdHM6IHVua25vd24pID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgY29uc3QgbyA9IChvcHRzID8/IHt9KSBhcyB7IGZvcmNlVGd6PzogdW5rbm93bjsgbWlycm9yRmlyc3Q/OiB1bmtub3duIH07XHJcbiAgICAgIC8vIFVJVkVSSUZZIGZha2UgXHU1NDExXHU1QkZDOlx1ODFFQVx1NTJBOFx1NUI4OVx1ODhDNVx1OERFRlx1NUY4NFx1OEQ3MFx1NkEyMVx1NjJERlx1OEZEQlx1NUVBNihcdTRFMERcdTc4QjBcdTc4QzFcdTc2RDgvXHU3RjUxXHU3RURDL1x1NEUwRFx1NzBFRFx1NTIwN1x1NjM2MiksXHJcbiAgICAgIC8vIFx1NEUxNFx1NEUwRFx1NTNEMSBkb25lXHUyMDE0XHUyMDE0XHU5QThDXHU2NTM2XHU4OTgxXHU1NzI4XHU1Qjg5XHU4OEM1XHU5ODc1XHU3MEI5XCJcdTY1MzlcdTc1MjhcdTUxODVcdTdGNkVcIlx1NTIwN1x1NjM2Mlx1OTRGRVx1NjNBNVx1MzAwMlxyXG4gICAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfV0laQVJEID09PSAnZmFrZScgJiYgcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfRkFLRSA9PT0gJzEnKSB7XHJcbiAgICAgICAgY29uc3Qgc2VuZFNpbSA9IChwOiBJbnN0YWxsUHJvZ3Jlc3MpOiB2b2lkID0+IHtcclxuICAgICAgICAgIGZvciAoY29uc3QgdyBvZiBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKSkge1xyXG4gICAgICAgICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCdpbnN0YWxsOnByb2dyZXNzJywgcCk7XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgfTtcclxuICAgICAgICB2b2lkIChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgICBzZW5kU2ltKHsgcGhhc2U6ICdjaGVjaycsIHRleHQ6ICdcdTY4QzBcdTY3RTUgbnBtXHUyMDI2KHZlcmlmeSBcdTZBMjFcdTYyREYpJyB9KTtcclxuICAgICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDQwMCkpO1xyXG4gICAgICAgICAgc2VuZFNpbSh7IHBoYXNlOiAnbnBtJywgdGV4dDogJ25wbSBpbnN0YWxsIEBobWhhcm5lc3MvY2xpIFx1MjE5MiB+Ly5obWhhcm5lc3MtZ2xvYmFsKHZlcmlmeSBcdTZBMjFcdTYyREYsXHU0RTBEXHU4NDNEXHU3NkQ4KScgfSk7XHJcbiAgICAgICAgfSkoKTtcclxuICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgdGVzdDogdHJ1ZSB9O1xyXG4gICAgICB9XHJcbiAgICAgIHJldHVybiBzdGFydENsaUluc3RhbGwoXHJcbiAgICAgICAge1xyXG4gICAgICAgICAgc2VuZFByb2dyZXNzOiAocDogSW5zdGFsbFByb2dyZXNzKTogdm9pZCA9PiB7XHJcbiAgICAgICAgICAgIGxvZ0luZm8oJ2luc3RhbGwnLCBgJHtwLnBoYXNlfSR7cC5wY3QgIT09IHVuZGVmaW5lZCA/IGAgJHtwLnBjdH0lYCA6ICcnfSAke3AudGV4dH1gKTtcclxuICAgICAgICAgICAgZm9yIChjb25zdCB3IG9mIEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpKSB7XHJcbiAgICAgICAgICAgICAgaWYgKCF3LmlzRGVzdHJveWVkKCkpIHcud2ViQ29udGVudHMuc2VuZCgnaW5zdGFsbDpwcm9ncmVzcycsIHApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICB9LFxyXG4gICAgICAgICAgbG9nOiAobTogc3RyaW5nKTogdm9pZCA9PiB7IGxvZ0luZm8oJ2luc3RhbGwnLCBtKTsgfSxcclxuICAgICAgICAgIC8vIFx1NUI4OVx1ODhDNVx1NjIxMFx1NTI5Rlx1NTM3M1x1NjMwMVx1NEU0NVx1NTMxNlx1NUU3Nlx1NzBFRFx1NTIwN1x1NjM2MihcdTU0MTFcdTVCRkNcdTk2OEZcdTU0MEVcdTY1MzZcdTVDM0U7XHU0RTJEXHU5MDE0XHU1M0Q2XHU2RDg4XHU0RTVGXHU1REYyXHU3NTFGXHU2NTQ4KVxyXG4gICAgICAgICAgb25JbnN0YWxsZWQ6IChlbnRyeTogc3RyaW5nKTogdm9pZCA9PiB7XHJcbiAgICAgICAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcclxuICAgICAgICAgICAgICBhd2FpdCBzYXZlUnVudGltZUNvbmZpZyh7IGVudHJ5LCBkZW1vOiBmYWxzZSB9KTtcclxuICAgICAgICAgICAgICBzc2VBYm9ydD8uYWJvcnQoKTtcclxuICAgICAgICAgICAgICBpZiAoc3VwZXJ2aXNvciAhPT0gbnVsbCkgYXdhaXQgc3VwZXJ2aXNvci5zdG9wKCk7XHJcbiAgICAgICAgICAgICAgYXdhaXQgc3RhcnRIb3N0KCk7XHJcbiAgICAgICAgICAgIH0pKCk7XHJcbiAgICAgICAgICB9LFxyXG4gICAgICAgIH0sXHJcbiAgICAgICAge1xyXG4gICAgICAgICAgZm9yY2VUZ3o6IG8uZm9yY2VUZ3ogPT09IHRydWUsXHJcbiAgICAgICAgICBtaXJyb3JGaXJzdDogby5taXJyb3JGaXJzdCA9PT0gJ25wbW1pcnJvcicgPyAnbnBtbWlycm9yJyA6IG8ubWlycm9yRmlyc3QgPT09ICducG1qcycgPyAnbnBtanMnIDogdW5kZWZpbmVkLFxyXG4gICAgICAgIH0sXHJcbiAgICAgICk7XHJcbiAgICB9KTtcclxuXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmdldC13aXphcmQnLCBhc3luYyAoZXZlbnQpID0+IHtcclxuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcclxuICAgICAgY29uc3QgdmFyaWFudCA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX1dJWkFSRDtcclxuICAgICAgaWYgKHZhcmlhbnQgIT09IHVuZGVmaW5lZCAmJiB2YXJpYW50ICE9PSAnJykge1xyXG4gICAgICAgIC8vIFx1OUE4Q1x1NjUzNlx1Njc4NFx1OTAyMDpcdTVGM0FcdTUyMzZcdTU0MTFcdTVCRkNcdTUzRUZcdTg5QzFcdTRFMTRcdTg5QzZcdTRFM0FcdTY3MkFcdTkxNERcdTdGNkUoXHU1M0VGXHU5MUNEXHU1OTBEXHU4REQxKTtwZXJzaXN0ZWQ9XHU3NzFGXHU1QjlFXHU4NDNEXHU3NkQ4XHJcbiAgICAgICAgLy8gXHU3MkI2XHU2MDAxKFx1NTQxMVx1NUJGQ1x1NkI2NVx1NjVBRFx1OEEwMFwiXHU5MDA5XHU2MkU5XHU2MzAxXHU0RTQ1XCJcdTc1MjgsXHU0RTBEXHU1RjcxXHU1NENEIFVJIFx1NTIyNFx1NUI5QSlcclxuICAgICAgICBjb25zdCB3ID0gYXdhaXQgbG9hZFdpemFyZFN0YXRlKCk7XHJcbiAgICAgICAgcmV0dXJuIHsgZG9uZTogZmFsc2UsIGNob2ljZTogJycsIHN1cHByZXNzZWQ6IGZhbHNlLCBwZXJzaXN0ZWQ6IHsgZG9uZTogdy5kb25lLCBjaG9pY2U6IHcuY2hvaWNlIH0gfTtcclxuICAgICAgfVxyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgbG9hZFdpemFyZFN0YXRlKCk7XHJcbiAgICAgIGNvbnN0IGNmZyA9IGF3YWl0IGxvYWRSdW50aW1lQ29uZmlnKCk7XHJcbiAgICAgIC8vIFx1NURGMlx1OTE0RFx1N0Y2RVx1OEZDNyBydW50aW1lKFx1NjI0Qlx1NTJBOFx1NTE2NVx1NTNFMy9cdTU0MTFcdTVCRkNcdTkwMDlcdTYyRTkvXHU2RjE0XHU3OTNBKVx1ODlDNlx1NTQwQ1x1NURGMlx1NUI4Q1x1NjIxMFx1OTk5Nlx1NTQyRlxyXG4gICAgICByZXR1cm4geyBkb25lOiB3LmRvbmUgfHwgY2ZnLmVudHJ5ICE9PSAnJyB8fCBjZmcuZGVtbywgY2hvaWNlOiB3LmNob2ljZSwgc3VwcHJlc3NlZDogd2l6YXJkU3VwcHJlc3NlZCgpIH07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiogXHU1NDExXHU1QkZDXHU2NTM2XHU1QzNFOlx1NjMwMVx1NEU0NVx1NTMxNlx1OTAwOVx1NjJFOVx1NUU3Nlx1NUU5NFx1NzUyOChleHRlcm5hbC9idW5kbGVkXHUyMTkyXHU1MTY1XHU1M0UzXHU4OTg2XHU3NkQ2O2RlbW9cdTIxOTJcdTYzMDFcdTRFNDVcdTZGMTRcdTc5M0E7XHJcbiAgICAgKiAgaW5zdGFsbFx1MjE5Mlx1NTE2NVx1NTNFM1x1NURGMlx1NzUzMVx1NUI4OVx1ODhDNVx1NTY2OFx1NjMwMVx1NEU0NVx1NTMxNixcdTUzRUFcdThCQjBcdTcyQjZcdTYwMDEpXHUzMDAyZmFrZS9cdTZENEJcdThCRDVcdTczQUZcdTU4ODNcdTUzRUFcdThCQjBcdTcyQjZcdTYwMDFcdTMwMDIgKi9cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6d2l6YXJkLWNvbXBsZXRlJywgYXN5bmMgKGV2ZW50LCBjaG9pY2U6IHVua25vd24sIGVudHJ5OiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XHJcbiAgICAgIGNvbnN0IGMgPSBjaG9pY2UgPT09ICdleHRlcm5hbCcgfHwgY2hvaWNlID09PSAnaW5zdGFsbCcgfHwgY2hvaWNlID09PSAnYnVuZGxlZCcgfHwgY2hvaWNlID09PSAnZGVtbycgPyBjaG9pY2UgOiAnJztcclxuICAgICAgaWYgKGMgPT09ICcnKSByZXR1cm4geyBlcnJvcjogJ2Nob2ljZSBtdXN0IGJlIGV4dGVybmFsfGluc3RhbGx8YnVuZGxlZHxkZW1vJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9O1xyXG4gICAgICBjb25zdCBlID0gdHlwZW9mIGVudHJ5ID09PSAnc3RyaW5nJyA/IGVudHJ5IDogJyc7XHJcbiAgICAgIGF3YWl0IHNhdmVXaXphcmRTdGF0ZShjKTtcclxuICAgICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX0ZBS0UgPT09ICcxJykgcmV0dXJuIHsgb2s6IHRydWUsIG1vZGU6IGJyaWRnZS5tb2RlLCB0ZXN0OiB0cnVlIH07XHJcbiAgICAgIGNvbnN0IHJlcG9Sb290ID0gam9pbihoZXJlLCAnLi4nLCAnLi4nLCAnLi4nLCAnLi4nKTtcclxuICAgICAgaWYgKGMgPT09ICdleHRlcm5hbCcgfHwgYyA9PT0gJ2J1bmRsZWQnKSB7XHJcbiAgICAgICAgY29uc3QgdGFyZ2V0ID0gYyA9PT0gJ2J1bmRsZWQnID8gYnVuZGxlZFJ1bnRpbWVQYXRoKHJlcG9Sb290KSA6IGU7XHJcbiAgICAgICAgaWYgKHRhcmdldCA9PT0gJycgfHwgIWlzQWJzb2x1dGUodGFyZ2V0KSB8fCAhZXhpc3RzU3luYyh0YXJnZXQpKSB7XHJcbiAgICAgICAgICByZXR1cm4geyBlcnJvcjogJ3J1bnRpbWUgXHU1MTY1XHU1M0UzXHU0RTBEXHU1QjU4XHU1NzI4JywgY29kZTogJ0JBRF9SRVFVRVNUJyB9O1xyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCBzYXZlUnVudGltZUNvbmZpZyh7IGVudHJ5OiB0YXJnZXQsIGRlbW86IGZhbHNlIH0pO1xyXG4gICAgICB9IGVsc2UgaWYgKGMgPT09ICdkZW1vJykge1xyXG4gICAgICAgIGF3YWl0IHNhdmVSdW50aW1lQ29uZmlnKHsgZW50cnk6ICcnLCBkZW1vOiB0cnVlIH0pO1xyXG4gICAgICB9XHJcbiAgICAgIGlmIChjICE9PSAnaW5zdGFsbCcpIHtcclxuICAgICAgICAvLyBpbnN0YWxsOlx1NUI4OVx1ODhDNVx1NTY2OFx1NURGMlx1NTcyOCBvbkluc3RhbGxlZCBcdTYzMDFcdTRFNDVcdTUzMTZcdTVFNzZcdTcwRURcdTUyMDdcdTYzNjIsXHU4RkQ5XHU5MUNDXHU0RTBEXHU1MThEXHU5MUNEXHU1NDJGXHJcbiAgICAgICAgc3NlQWJvcnQ/LmFib3J0KCk7XHJcbiAgICAgICAgaWYgKHN1cGVydmlzb3IgIT09IG51bGwpIGF3YWl0IHN1cGVydmlzb3Iuc3RvcCgpO1xyXG4gICAgICAgIGF3YWl0IHN0YXJ0SG9zdCgpO1xyXG4gICAgICB9XHJcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBtb2RlOiBicmlkZ2UubW9kZSB9O1xyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gLS0tLSBQcm92aWRlciBcdThCQkVcdTdGNkUoMDMgXHUwMEE3XHU0RTAzOmtleSBcdTUzRUFcdTUxRkEgaGFzS2V5L1x1NjcyQlx1NTZEQlx1NEY0RDtcdTRGRERcdTVCNThcdTc2RjRcdTUxOTkgcnVudGltZSkgLS0tLVxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpwcm92aWRlcnMnLCAoZXZlbnQpID0+XHJcbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPHsgcHJvdmlkZXJzRGV0YWlsPzogQXJyYXk8eyBuYW1lOiBzdHJpbmc7IG1vZGVsOiBzdHJpbmc7IGJhc2VVcmw6IHN0cmluZzsgaGFzS2V5OiBib29sZWFuOyBrZXlUYWlsPzogc3RyaW5nIH0+OyBtb2RlbD86IHN0cmluZyB9PignL2FwaS9zdGF0ZScpKSk7XHJcblxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpwcm92aWRlci1zYXZlJywgKGV2ZW50LCBwcm92aWRlcjogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBwID0gcHJvdmlkZXIgYXMgeyBuYW1lPzogdW5rbm93bjsgYmFzZVVybD86IHVua25vd247IG1vZGVsPzogdW5rbm93bjsgYXBpS2V5PzogdW5rbm93biB9O1xyXG4gICAgICBjb25zdCBuYW1lID0gdHlwZW9mIHA/Lm5hbWUgPT09ICdzdHJpbmcnID8gcC5uYW1lLnNsaWNlKDAsIDgwKSA6ICcnO1xyXG4gICAgICBjb25zdCBiYXNlVXJsID0gdHlwZW9mIHA/LmJhc2VVcmwgPT09ICdzdHJpbmcnID8gcC5iYXNlVXJsLnNsaWNlKDAsIDMwMCkgOiAnJztcclxuICAgICAgY29uc3QgbW9kZWwgPSB0eXBlb2YgcD8ubW9kZWwgPT09ICdzdHJpbmcnID8gcC5tb2RlbC5zbGljZSgwLCAxMjApIDogJyc7XHJcbiAgICAgIGlmIChuYW1lID09PSAnJyB8fCBiYXNlVXJsID09PSAnJyB8fCBtb2RlbCA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ25hbWUvYmFzZVVybC9tb2RlbCByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XHJcbiAgICAgIGNvbnN0IGJvZHk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0geyBuYW1lLCBiYXNlVXJsLCBtb2RlbCB9O1xyXG4gICAgICAvLyBhcGlLZXkgXHU1M0VBXHU1NzI4XHU2NjNFXHU1RjBGXHU4RjkzXHU1MTY1XHU2NUY2XHU0RTBBXHU0RjIwLFx1N0VERFx1NEUwRFx1NTZERVx1NjYzRShyZW5kZXJlciBcdTg4NjhcdTUzNTVcdTYzRDBcdTRFQTRcdTU0MEVcdTUzNzNcdTZFMDVcdTdBN0EpXHJcbiAgICAgIGlmICh0eXBlb2YgcD8uYXBpS2V5ID09PSAnc3RyaW5nJyAmJiBwLmFwaUtleSAhPT0gJycpIGJvZHkuYXBpS2V5ID0gcC5hcGlLZXkuc2xpY2UoMCwgMzAwKTtcclxuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KCcvYXBpL3Byb3ZpZGVycycsIGJvZHkpKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gXHU1REU1XHU0RjVDXHU1MzNBKDAzIFx1MDBBN1x1NTE2RDtcdTUyMDdcdTYzNjJcdThCRURcdTRFNDlcdTRFMEUgd2ViIFx1NzZGOFx1NTQwQzpydW50aW1lIFx1NTM1NVx1OTAwOSBjd2QpIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6d29ya3NwYWNlcycsIChldmVudCkgPT5cclxuICAgICAgaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248eyBjdXJyZW50OiBzdHJpbmc7IGl0ZW1zOiBBcnJheTx7IGlkOiBzdHJpbmc7IG5hbWU6IHN0cmluZzsgcGF0aDogc3RyaW5nIH0+IH0+KCcvYXBpL3dvcmtzcGFjZXMnKSkpO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6d29ya3NwYWNlLXVzZScsIChldmVudCwgaWQ6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3Qgd2lkID0gdHlwZW9mIGlkID09PSAnc3RyaW5nJyA/IGlkLnNsaWNlKDAsIDYwKSA6ICcnO1xyXG4gICAgICBpZiAod2lkID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAnaWQgcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvd29ya3NwYWNlcy91c2UnLCB7IGlkOiB3aWQgfSkpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTp3b3Jrc3BhY2UtYWRkJywgKGV2ZW50LCBuYW1lOiB1bmtub3duLCBwYXRoOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IG4gPSB0eXBlb2YgbmFtZSA9PT0gJ3N0cmluZycgPyBuYW1lLnNsaWNlKDAsIDEyMCkgOiAnJztcclxuICAgICAgY29uc3QgcCA9IHR5cGVvZiBwYXRoID09PSAnc3RyaW5nJyA/IHBhdGguc2xpY2UoMCwgMTAwMCkgOiAnJztcclxuICAgICAgaWYgKHAgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICdwYXRoIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcclxuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KCcvYXBpL3dvcmtzcGFjZXMnLCB7IG5hbWU6IG4gPT09ICcnID8gdW5kZWZpbmVkIDogbiwgcGF0aDogcCB9KSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIFx1NEYxQVx1OEJERFx1NUY1Mlx1Njg2My9cdTUyMjBcdTk2NjQoXHU3OUZCXHU1MTY1IGFyY2hpdmUvdHJhc2gsXHU1M0VGXHU2MDYyXHU1OTBEO3J1bnRpbWUgXHU2NzQzXHU1QTAxKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnNlc3Npb24tb3AnLCAoZXZlbnQsIGlkOiB1bmtub3duLCBvcDogdW5rbm93bikgPT4ge1xyXG4gICAgICBjb25zdCBzaWQgPSB0eXBlb2YgaWQgPT09ICdzdHJpbmcnID8gaWQucmVwbGFjZSgvW15hLXpBLVowLTlfOi5ALV0vZywgJycpLnNsaWNlKDAsIDgwKSA6ICcnO1xyXG4gICAgICBjb25zdCBvID0gb3AgPT09ICdhcmNoaXZlJyB8fCBvcCA9PT0gJ2RlbGV0ZScgPyBvcCA6ICcnO1xyXG4gICAgICBpZiAoc2lkID09PSAnJyB8fCBvID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGVycm9yOiAnaWQgYW5kIG9wKGFyY2hpdmV8ZGVsZXRlKSByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XHJcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PihgL2FwaS9zZXNzaW9ucy8ke2VuY29kZVVSSUNvbXBvbmVudChzaWQpfS8ke299YCwge30pKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIC0tLS0gTTQ6RGlmZiBcdTk3NjJcdTY3N0YoXHU1M0VBXHU4QkZCIGdpdCBcdTUzRDhcdTY2RjQ7XHU2Mzg4XHU2NzQzXHU1NzI4IHJ1bnRpbWUpIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6ZGlmZicsIChldmVudCwgc2Vzc2lvbklkOiB1bmtub3duKSA9PiB7XHJcbiAgICAgIGNvbnN0IHNpZCA9IHR5cGVvZiBzZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gc2Vzc2lvbklkLnNsaWNlKDAsIDgwKSA6ICcnO1xyXG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KGAvYXBpL2RpZmYke3NpZCAhPT0gJycgPyBgP3Nlc3Npb25JZD0ke2VuY29kZVVSSUNvbXBvbmVudChzaWQpfWAgOiAnJ31gKSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyAtLS0tIE01Olx1OEJBNFx1NzdFNVx1NzJCNlx1NjAwMShcdTdFRDNcdTY3ODRcdTUzMTZcdTRFOEJcdTVCOUU7XHU3RjNBXHU2NTcwXHU2MzZFXHU1QjU3XHU2QkI1XHU3NTMxIFVJIFx1NjYzRVx1NzkzQVwiXHU2NUUwXHU2NTcwXHU2MzZFXCIpIC0tLS1cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6Y29nbml0aXZlJywgKGV2ZW50KSA9PlxyXG4gICAgICBob3N0Q2FsbChldmVudCwgKGMpID0+IGMuZ2V0SnNvbjxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4oJy9hcGkvY29nbml0aXZlJykpKTtcclxuXHJcbiAgICAvLyAtLS0tIFx1NTM4Nlx1NTNGMlx1NEYxQVx1OEJERFx1OTg4NFx1ODlDOChcdTY3MDBcdTU0MEUgODAgXHU2NzYxLFx1NkJDRlx1Njc2MSA1MDAgXHU1QjU3O3J1bnRpbWUgXHU2NzQzXHU1QTAxXHU2NTcwXHU2MzZFKSAtLS0tXHJcbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnNlc3Npb24tcHJldmlldycsIChldmVudCwgaWQ6IHVua25vd24pID0+IHtcclxuICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIGlkID09PSAnc3RyaW5nJyA/IGlkLnJlcGxhY2UoL1teYS16QS1aMC05XzouQC1dL2csICcnKS5zbGljZSgwLCA4MCkgOiAnJztcclxuICAgICAgaWYgKHNpZCA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ2lkIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcclxuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPFJlY29yZDxzdHJpbmcsIHVua25vd24+PihgL2FwaS9zZXNzaW9ucy8ke2VuY29kZVVSSUNvbXBvbmVudChzaWQpfWApKTtcclxuICAgIH0pO1xyXG5cclxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6c3RvcC1ob3N0JywgKGV2ZW50KSA9PiB7XHJcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicgfTtcclxuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIHNzZUFib3J0Py5hYm9ydCgpO1xyXG4gICAgICAgIGF3YWl0IHN1cGVydmlzb3I/LnN0b3AoKTtcclxuICAgICAgICBhcHAucXVpdCgpO1xyXG4gICAgICB9KSgpO1xyXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSB9O1xyXG4gICAgfSk7XHJcbiAgfVxyXG5cclxuICAvKiAtLS0tIFx1N0E5N1x1NTNFM1x1NEUwRVx1NUI4OVx1NTE2OFx1N0I1Nlx1NzU2NSAtLS0tICovXHJcbiAgLy8gMDMgXHUwMEE3XHU0RTAzOkRlc2t0b3AgXHU2NzJDXHU1NzMwXHU1M0VBXHU1QjU4IFVJIFx1NTA0Rlx1NTk3RC9cdTdBOTdcdTUzRTNcdTcyQjZcdTYwMDEodXNlckRhdGEvd2luZG93LXN0YXRlLmpzb24pXHJcbiAgY29uc3Qgd2luZG93U3RhdGVGaWxlID0gKCk6IHN0cmluZyA9PiBqb2luKGFwcC5nZXRQYXRoKCd1c2VyRGF0YScpLCAnd2luZG93LXN0YXRlLmpzb24nKTtcclxuICBhc3luYyBmdW5jdGlvbiBsb2FkQm91bmRzKCk6IFByb21pc2U8eyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlcjsgeD86IG51bWJlcjsgeT86IG51bWJlciB9IHwgbnVsbD4ge1xyXG4gICAgdHJ5IHtcclxuICAgICAgcmV0dXJuIEpTT04ucGFyc2UoYXdhaXQgcmVhZEZpbGUod2luZG93U3RhdGVGaWxlKCksICd1dGY4JykpIGFzIHsgd2lkdGg6IG51bWJlcjsgaGVpZ2h0OiBudW1iZXI7IHg/OiBudW1iZXI7IHk/OiBudW1iZXIgfTtcclxuICAgIH0gY2F0Y2ggeyByZXR1cm4gbnVsbDsgfVxyXG4gIH1cclxuICBhc3luYyBmdW5jdGlvbiBzYXZlQm91bmRzKHdpbjogQnJvd3NlcldpbmRvdyk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgdHJ5IHsgYXdhaXQgd3JpdGVGaWxlKHdpbmRvd1N0YXRlRmlsZSgpLCBKU09OLnN0cmluZ2lmeSh3aW4uZ2V0Qm91bmRzKCkpLCAndXRmOCcpOyB9IGNhdGNoIHsgLyogYmVzdCBlZmZvcnQgKi8gfVxyXG4gIH1cclxuXHJcbiAgYXN5bmMgZnVuY3Rpb24gY3JlYXRlV2luZG93KCk6IFByb21pc2U8QnJvd3NlcldpbmRvdyB8IG51bGw+IHtcclxuICAgIGNvbnN0IHNhdmVkID0gYXdhaXQgbG9hZEJvdW5kcygpO1xyXG4gICAgY29uc3Qgd2luID0gbmV3IEJyb3dzZXJXaW5kb3coe1xyXG4gICAgICB3aWR0aDogc2F2ZWQ/LndpZHRoID8/IDE0NDAsXHJcbiAgICAgIGhlaWdodDogc2F2ZWQ/LmhlaWdodCA/PyA5MDAsXHJcbiAgICAgIC4uLihzYXZlZD8ueCAhPT0gdW5kZWZpbmVkICYmIHNhdmVkPy55ICE9PSB1bmRlZmluZWQgPyB7IHg6IHNhdmVkLngsIHk6IHNhdmVkLnkgfSA6IHt9KSxcclxuICAgICAgLy8gVUlWRVJJRlkgXHU3QTg0XHU1QzRGXHU5QThDXHU2NTM2KHdpemFyZCAzNjBcdTAwRDc2NDAgXHU1MTY4XHU1MTQzXHU3RDIwXHU1M0VGXHU4RkJFKVx1OTcwMFx1NEUzNFx1NjVGNlx1NjUzRVx1NUJCRFx1NEUwQlx1OTY1MDtcclxuICAgICAgLy8gXHU2QjYzXHU1RTM4XHU0RjdGXHU3NTI4XHU0RUNEXHU5NTAxIDk2MFx1MDBENzYwMFx1MzAwMlxyXG4gICAgICBtaW5XaWR0aDogcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRlkgPT09ICcxJyA/IDMyMCA6IDk2MCxcclxuICAgICAgbWluSGVpZ2h0OiBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWSA9PT0gJzEnID8gMzYwIDogNjAwLFxyXG4gICAgICBzaG93OiBmYWxzZSxcclxuICAgICAgYmFja2dyb3VuZENvbG9yOiAnI2Y5ZmFmYicsIC8vIHY0IERTSDpcdTZENDVcdTgyNzJcdTlFRDhcdThCQTQoYmctYmFzZSksXHU5MDdGXHU1MTREXHU2REYxXHU4MjcyXHU5NUVBXHU1QzRGXHJcbiAgICAgIHRpdGxlOiAnSE1IIERlc2t0b3AnLFxyXG4gICAgICAvLyBcdTk2OTBcdTg1Q0ZcdTVGMEZcdTY4MDdcdTk4OThcdTY4MEY6XHU1MzlGXHU3NTFGXHU3QTk3XHU1M0UzXHU2M0E3XHU1MjM2KG92ZXJsYXkgXHU2M0QwXHU0RjlCKStcdTk4OUNcdTgyNzJcdTk2OEZcdTRFM0JcdTk4OTgocmVuZGVyZXIgXHU3RUNGXHJcbiAgICAgIC8vIGNocm9tZS10aGVtZSBcdTU0MENcdTZCNjUpXHUyMDE0XHUyMDE0XHU2ODM5XHU2Q0JCXHU0RUFFXHU4MjcyXHU2QTIxXHU1RjBGXHU5ODc2XHU5MEU4XHU5RUQxXHU2NzYxO1x1ODNEQ1x1NTM1NVx1NjgwRiBhdXRvSGlkZShBbHQgXHU1NDdDXHU1MUZBKVx1MzAwMlxyXG4gICAgICB0aXRsZUJhclN0eWxlOiAnaGlkZGVuJyxcclxuICAgICAgdGl0bGVCYXJPdmVybGF5OiB7IC4uLmNocm9tZUZvcihuYXRpdmVUaGVtZS5zaG91bGRVc2VEYXJrQ29sb3JzKSwgaGVpZ2h0OiAzNiB9LFxyXG4gICAgICBhdXRvSGlkZU1lbnVCYXI6IHRydWUsXHJcbiAgICAgIHdlYlByZWZlcmVuY2VzOiB7XHJcbiAgICAgICAgcHJlbG9hZDogcHJlbG9hZFBhdGgsXHJcbiAgICAgICAgY29udGV4dElzb2xhdGlvbjogdHJ1ZSxcclxuICAgICAgICBzYW5kYm94OiB0cnVlLFxyXG4gICAgICAgIG5vZGVJbnRlZ3JhdGlvbjogZmFsc2UsXHJcbiAgICAgICAgbm9kZUludGVncmF0aW9uSW5Xb3JrZXI6IGZhbHNlLFxyXG4gICAgICAgIHdlYlNlY3VyaXR5OiB0cnVlLFxyXG4gICAgICAgIHNwZWxsY2hlY2s6IGZhbHNlLFxyXG4gICAgICAgIGRldlRvb2xzOiBpc0RldixcclxuICAgICAgfSxcclxuICAgIH0pO1xyXG4gICAgd2luLm9uY2UoJ3JlYWR5LXRvLXNob3cnLCAoKSA9PiB3aW4uc2hvdygpKTtcclxuICAgIHdpbi5vbignY2xvc2UnLCAoKSA9PiB7IHZvaWQgc2F2ZUJvdW5kcyh3aW4pOyB9KTtcclxuXHJcbiAgICAvLyBcdTUzRUFcdTUxNDFcdThCQjhcdTUyQTBcdThGN0RcdTYyMTFcdTRFRUNcdTgxRUFcdTVERjFcdTc2ODQgcmVuZGVyZXI7XHU0RUZCXHU0RjU1XHU1QkZDXHU4MjJBL1x1NjVCMFx1N0E5N1x1NTNFM1x1NEUwMFx1NUY4Qlx1NjJEMlx1N0VERFxyXG4gICAgd2luLndlYkNvbnRlbnRzLnNldFdpbmRvd09wZW5IYW5kbGVyKCh7IHVybCB9KSA9PiB7XHJcbiAgICAgIGlmICgvXmh0dHBzPzpcXC9cXC8vLnRlc3QodXJsKSkgdm9pZCBzaGVsbC5vcGVuRXh0ZXJuYWwodXJsKTtcclxuICAgICAgcmV0dXJuIHsgYWN0aW9uOiAnZGVueScgfTtcclxuICAgIH0pO1xyXG4gICAgd2luLndlYkNvbnRlbnRzLm9uKCd3aWxsLW5hdmlnYXRlJywgKGUsIHVybCkgPT4ge1xyXG4gICAgICBjb25zdCBvayA9IFsuLi5hbGxvd2VkT3JpZ2luc10uc29tZSgobykgPT4gdXJsID09PSBvIHx8IHVybC5zdGFydHNXaXRoKGAke299L2ApIHx8IHVybC5zdGFydHNXaXRoKGAke299P2ApKTtcclxuICAgICAgaWYgKCFvaykge1xyXG4gICAgICAgIGxvZ0luZm8oJ25hdicsIGBibG9ja2VkIG5hdmlnYXRpb24gdG8gJHt1cmwuc2xpY2UoMCwgMTIwKX1gKTtcclxuICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7XHJcbiAgICAgIH1cclxuICAgIH0pO1xyXG5cclxuICAgIGlmIChpc0RldiAmJiByZW5kZXJlckRldlVybCkge1xyXG4gICAgICB2b2lkIHdpbi5sb2FkVVJMKHJlbmRlcmVyRGV2VXJsKTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgIHZvaWQgd2luLmxvYWRGaWxlKGpvaW4oaGVyZSwgJy4uJywgJy4uJywgJ2Rpc3QtcmVuZGVyZXInLCAnaW5kZXguaHRtbCcpKTtcclxuICAgIH1cclxuICAgIC8vIFx1OTg3NVx1OTc2Mlx1NTJBMFx1OEY3RFx1NUI4Q1x1OTFDRFx1NjRBRFx1NUY1M1x1NTI0RCBob3N0IFx1NzJCNlx1NjAwMTpyZWFkeSBcdTVFN0ZcdTY0QURcdTgyRTVcdTY1RTlcdTRFOEUgcmVuZGVyZXIgXHU4QkEyXHU5NjA1XHU1MzczXHU0RTIyXHU1OTMxLFxyXG4gICAgLy8gcmVuZGVyZXIgXHU3Njg0IGdldC1zdGF0ZSBcdTVGRUJcdTcxNjcgKyBcdThGRDlcdTkxQ0NcdTc2ODRcdTkxQ0RcdTY0QURcdTUzQ0NcdTRGRERcdTk2NjkoXHU1OTFBXHU3QTk3XHU1M0UzL1x1OTFDRFx1OEY3RFx1NTczQVx1NjY2Rlx1NEU1Rlx1ODk4Nlx1NzZENilcdTMwMDJcclxuICAgIHdpbi53ZWJDb250ZW50cy5vbmNlKCdkaWQtZmluaXNoLWxvYWQnLCAoKSA9PiB7XHJcbiAgICAgIGlmICghd2luLmlzRGVzdHJveWVkKCkpIHtcclxuICAgICAgICB3aW4ud2ViQ29udGVudHMuc2VuZCgnYnJpZGdlOmhvc3Qtc3RhdGUnLCBicmlkZ2UuaG9zdFN0YXRlLCB7IHJlc3RhcnRDb3VudDogMCB9KTtcclxuICAgICAgfVxyXG4gICAgfSk7XHJcbiAgICByZXR1cm4gd2luO1xyXG4gIH1cclxuXHJcbiAgYXBwLndoZW5SZWFkeSgpLnRoZW4oKCkgPT4ge1xyXG4gICAgLy8gVUlWRVJJRlk6ZmFrZSBcdTZBMjFcdTVGMEZcdTlBOENcdTY1MzZcdTk4N0JcdTU3Mjggc3RhcnRIb3N0IFx1OEJGQiBlbnYgXHU0RTRCXHU1MjREXHU1RjNBXHU1MjM2IGZha2VcclxuICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWSA9PT0gJzEnICYmIHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX01PREUgIT09ICdyZWFsJykge1xyXG4gICAgICBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9GQUtFID0gJzEnO1xyXG4gICAgfVxyXG4gICAgLy8gV2luZG93cyBcdTkwMUFcdTc3RTVcdTVGNTJcdTVDNUUoXHU1NDI2XHU1MjE5XHU2NjNFXHU3OTNBXHU0RTNBIGVsZWN0cm9uLmV4ZSlcclxuICAgIGFwcC5zZXRBcHBVc2VyTW9kZWxJZCgnZGV2LmhtaC5kZXNrdG9wJyk7XHJcbiAgICBzZXR1cFRyYXkoKTtcclxuICAgIGJ1aWxkQXBwTWVudSgpO1xyXG4gICAgLy8gXHU1NDJGXHU1MkE4IDMwcyBcdTU0MEVcdTk3NTlcdTlFRDhcdTY4QzBcdTY3RTVcdTY2RjRcdTY1QjAoXHU2NzA5XHU2NUIwXHU3MjQ4XHU0RUM1XHU1NDBFXHU1M0YwXHU0RTBCXHU4RjdELFx1NEUwRFx1NjI1M1x1NjI3MDtcdTc1MjhcdTYyMzdcdTdFQ0YgXHUyNjMwIFx1ODNEQ1x1NTM1NVx1NTFCM1x1NUI5QVx1ODhDNSlcclxuICAgIGlmIChhcHAuaXNQYWNrYWdlZCkgc2V0VGltZW91dCgoKSA9PiB7IHZvaWQgY2hlY2tGb3JVcGRhdGVzKCk7IH0sIDMwXzAwMCk7XHJcbiAgICAvLyBDU1AoZGV2IFx1NEUwRSBwcm9kIFx1NEUwRFx1NTQwQztwcm9kIFx1NEUwRFx1NTE0MVx1OEJCOFx1NEVGQlx1NEY1NVx1OEZEQ1x1N0EwQlx1NkU5MClcclxuICAgIGNvbnN0IGNzcCA9IGlzRGV2XHJcbiAgICAgID8gW1xyXG4gICAgICAgICAgXCJkZWZhdWx0LXNyYyAnc2VsZidcIixcclxuICAgICAgICAgIGBzY3JpcHQtc3JjICdzZWxmJyAke3JlbmRlcmVyRGV2VXJsfWAsXHJcbiAgICAgICAgICBcInN0eWxlLXNyYyAnc2VsZicgJ3Vuc2FmZS1pbmxpbmUnXCIsXHJcbiAgICAgICAgICBgY29ubmVjdC1zcmMgJ3NlbGYnICR7cmVuZGVyZXJEZXZVcmx9IHdzOi8vMTI3LjAuMC4xOipgLFxyXG4gICAgICAgICAgXCJpbWctc3JjICdzZWxmJyBkYXRhOlwiLFxyXG4gICAgICAgICAgXCJmb250LXNyYyAnc2VsZicgZGF0YTpcIixcclxuICAgICAgICBdLmpvaW4oJzsgJylcclxuICAgICAgOiBcImRlZmF1bHQtc3JjICdzZWxmJzsgc2NyaXB0LXNyYyAnc2VsZic7IHN0eWxlLXNyYyAnc2VsZicgJ3Vuc2FmZS1pbmxpbmUnOyBpbWctc3JjICdzZWxmJyBkYXRhOjsgZm9udC1zcmMgJ3NlbGYnIGRhdGE6XCI7XHJcbiAgICBzZXNzaW9uLmRlZmF1bHRTZXNzaW9uLndlYlJlcXVlc3Qub25IZWFkZXJzUmVjZWl2ZWQoKGRldGFpbHMsIGNhbGxiYWNrKSA9PiB7XHJcbiAgICAgIGNhbGxiYWNrKHtcclxuICAgICAgICByZXNwb25zZUhlYWRlcnM6IHtcclxuICAgICAgICAgIC4uLmRldGFpbHMucmVzcG9uc2VIZWFkZXJzLFxyXG4gICAgICAgICAgJ0NvbnRlbnQtU2VjdXJpdHktUG9saWN5JzogW2NzcF0sXHJcbiAgICAgICAgfSxcclxuICAgICAgfSk7XHJcbiAgICB9KTtcclxuXHJcbiAgICByZWdpc3RlcklwYygpO1xyXG4gICAgLy8gY3JlYXRlV2luZG93IFx1NjYyRiBhc3luYyhib3VuZHMgXHU2MDYyXHU1OTBEKTtcdTVCODlcdTUxNjhcdTgxRUFcdTZENEIvXHU2RTMyXHU2N0QzXHU4MUVBXHU2OEMwXHU1NzI4XHU3QTk3XHU1M0UzXHU1QzMxXHU3RUVBXHU1NDBFXHU2MzAyXHU4RjdEXHJcbiAgICB2b2lkIGNyZWF0ZVdpbmRvdygpLnRoZW4oKHdpbikgPT4ge1xyXG4gICAgICBpZiAod2luID09PSBudWxsKSByZXR1cm47XHJcbiAgICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWSA9PT0gJzEnKSBhdHRhY2hVaVZlcmlmeSh3aW4pO1xyXG4gICAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfU0VDVVJJVFlfVEVTVCA9PT0gJzEnKSB7XHJcbiAgICAgICAgd2luLndlYkNvbnRlbnRzLm9uY2UoJ2RpZC1maW5pc2gtbG9hZCcsICgpID0+IHtcclxuICAgICAgICAgIHZvaWQgc2VjdXJpdHlTZWxmVGVzdCh3aW4pO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICB9XHJcbiAgICAgIC8vIFVJIFx1NjIyQVx1NTZGRVx1OTRBOVx1NUI1MDpITUhfREVTS1RPUF9TTkFQU0hPVD08ZmlsZS5wbmc+IFx1NTcyOFx1NzU0Q1x1OTc2Mlx1NUMzMVx1N0VFQVx1NTQwRVx1NjIyQVx1NTZGRVx1OTAwMFx1NTFGQVxyXG4gICAgICAvLyAoXHU4OEM1XHU2NzNBXHU4QkNBXHU2NUFEXHU3NTI4Olx1NEVCMlx1NzczQ1x1NzcwQlx1NkUzMlx1NjdEM1x1N0VEM1x1Njc5QyxcdTgwMENcdTRFMERcdTY2MkZcdTUzRUFcdTY1NzAgcm9vdCBcdTVCNTBcdTgyODJcdTcwQjkpXHUzMDAyXHJcbiAgICAgIGNvbnN0IHNuYXAgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9TTkFQU0hPVDtcclxuICAgICAgaWYgKHNuYXAgIT09IHVuZGVmaW5lZCAmJiBzbmFwICE9PSAnJykge1xyXG4gICAgICAgIHdpbi53ZWJDb250ZW50cy5vbmNlKCdkaWQtZmluaXNoLWxvYWQnLCAoKSA9PiB7XHJcbiAgICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHtcclxuICAgICAgICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBpbWcgPSBhd2FpdCB3aW4ud2ViQ29udGVudHMuY2FwdHVyZVBhZ2UoKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHsgd3JpdGVGaWxlOiB3ZiB9ID0gYXdhaXQgaW1wb3J0KCdub2RlOmZzL3Byb21pc2VzJyk7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCB3ZihzbmFwLCBpbWcudG9QTkcoKSk7XHJcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgU05BUFNIT1Qgb2sgJHtzbmFwfSAke2ltZy5nZXRTaXplKCkud2lkdGh9eCR7aW1nLmdldFNpemUoKS5oZWlnaHR9YCk7XHJcbiAgICAgICAgICAgICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgU05BUFNIT1QgZXJyb3IgJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApfWApO1xyXG4gICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICBjb25zdCBhcHAyID0gYXBwO1xyXG4gICAgICAgICAgICAgIHNldFRpbWVvdXQoKCkgPT4gYXBwMi5leGl0KDApLCA1MDApO1xyXG4gICAgICAgICAgICB9KSgpO1xyXG4gICAgICAgICAgfSwgTnVtYmVyKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1NOQVBTSE9UX0RFTEFZX01TID8/IDEyXzAwMCkpO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICB9XHJcbiAgICAgIC8vIERPTSBcdTdFRDNcdTY3ODRcdTYzQTJcdTk0ODg6SE1IX0RFU0tUT1BfRE9NUFJPQkU9MSBcdThGOTNcdTUxRkFcdTUxNzNcdTk1MkVcdTUxNDNcdTdEMjBcdTc2ODQgYm94L2Rpc3BsYXkvY2hpbGRyZW4sXHJcbiAgICAgIC8vIFx1NTE4RFx1OTAwMFx1NTFGQShcdThCQ0FcdTY1QURcIlJlYWN0IFx1NjMwMlx1OEY3RFx1NEU4Nlx1NEY0Nlx1NjdEMFx1NTc1NyBVSSBcdTRFMERcdTUzRUZcdTg5QzFcIlx1OEZEOVx1N0M3Qlx1OTVFRVx1OTg5ODtcdTYyMkFcdTU2RkVcdTRFNEJcdTU5MTZcdTc2ODRcdTc4NkNcdThCQzFcdTYzNkUpXHUzMDAyXHJcbiAgICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9ET01QUk9CRSA9PT0gJzEnKSB7XHJcbiAgICAgICAgd2luLndlYkNvbnRlbnRzLm9uY2UoJ2RpZC1maW5pc2gtbG9hZCcsICgpID0+IHtcclxuICAgICAgICAgIHNldFRpbWVvdXQoKCkgPT4ge1xyXG4gICAgICAgICAgICB2b2lkIChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHIgPSAoYXdhaXQgd2luLndlYkNvbnRlbnRzLmV4ZWN1dGVKYXZhU2NyaXB0KGAoZnVuY3Rpb24oKXtcclxuICAgICAgICAgICAgICAgICAgdmFyIHBpY2sgPSBmdW5jdGlvbihzZWwpe1xyXG4gICAgICAgICAgICAgICAgICAgIHZhciBlbHMgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKHNlbCk7XHJcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGVscywgMCwgNCkubWFwKGZ1bmN0aW9uKGVsKXtcclxuICAgICAgICAgICAgICAgICAgICAgIHZhciBjcyA9IGdldENvbXB1dGVkU3R5bGUoZWwpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgdmFyIGIgPSBlbC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcclxuICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB7IGNsczogKGVsLmNsYXNzTmFtZXx8JycpLnRvU3RyaW5nKCkuc2xpY2UoMCw4MCksIHRhZzogZWwudGFnTmFtZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgZGlzcGxheTogY3MuZGlzcGxheSwgdmlzOiBjcy52aXNpYmlsaXR5LCBvcGFjaXR5OiBjcy5vcGFjaXR5LFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBwb3M6IGNzLnBvc2l0aW9uLCB6OiBjcy56SW5kZXgsIG92ZXJmbG93OiBjcy5vdmVyZmxvdyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgeDogTWF0aC5yb3VuZChiLngpLCB5OiBNYXRoLnJvdW5kKGIueSksIHc6IE1hdGgucm91bmQoYi53aWR0aCksIGg6IE1hdGgucm91bmQoYi5oZWlnaHQpLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB0ZXh0OiAoZWwuaW5uZXJUZXh0fHwnJykucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDYwKSB9O1xyXG4gICAgICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgICB9O1xyXG4gICAgICAgICAgICAgICAgICB2YXIgc2VscyA9IFsnaHRtbCcsJ2JvZHknLCcjcm9vdCcsJy5hcHAtc2hlbGwnLCcuc2lkZWJhcicsJy53b3Jrc3BhY2UnLCcudG9wYmFyJywnLnN0cmVhbScsJy5lbXB0eS1oaW50JywnLmNvbXBvc2VyJywnLmNvbXBvc2VyLXJvdycsJy5jb21wb3NlciB0ZXh0YXJlYScsJy5jb21wb3Nlci1zaWRlJywnLmF0dC1waWNrZXInLCcuYXR0LWNoaXBzJywnLnNpZGVwYW5lbCcsJy5ydW50aW1lLWd1aWRlJywnLm92ZXJsYXknLCcudHVybicsJy5jYXJkJ107XHJcbiAgICAgICAgICAgICAgICAgIHZhciBvdXQgPSB7fTtcclxuICAgICAgICAgICAgICAgICAgc2Vscy5mb3JFYWNoKGZ1bmN0aW9uKHMpeyB0cnkgeyBvdXRbc10gPSBwaWNrKHMpOyB9IGNhdGNoKGUpeyBvdXRbc10gPSBbe2VycjogU3RyaW5nKGUpLnNsaWNlKDAsODApfV07IH0gfSk7XHJcbiAgICAgICAgICAgICAgICAgIG91dC5fX21ldGEgPSB7XHJcbiAgICAgICAgICAgICAgICAgICAgc3R5bGVTaGVldHM6IGRvY3VtZW50LnN0eWxlU2hlZXRzLmxlbmd0aCxcclxuICAgICAgICAgICAgICAgICAgICBzaGVldDBydWxlczogKGRvY3VtZW50LnN0eWxlU2hlZXRzWzBdICYmIGRvY3VtZW50LnN0eWxlU2hlZXRzWzBdLmNzc1J1bGVzKSA/IGRvY3VtZW50LnN0eWxlU2hlZXRzWzBdLmNzc1J1bGVzLmxlbmd0aCA6IC0xLFxyXG4gICAgICAgICAgICAgICAgICAgIHJvb3RDaGlsZHJlbjogZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Jvb3QnKSA/IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyb290JykuY2hpbGRyZW4ubGVuZ3RoIDogLTEsXHJcbiAgICAgICAgICAgICAgICAgICAgYm9keUNoaWxkcmVuOiBkb2N1bWVudC5ib2R5LmNoaWxkcmVuLmxlbmd0aCxcclxuICAgICAgICAgICAgICAgICAgICBpbm5lckhUTUxMZW46IGRvY3VtZW50LmJvZHkuaW5uZXJIVE1MLmxlbmd0aCxcclxuICAgICAgICAgICAgICAgICAgICB2aWV3cG9ydDogd2luZG93LmlubmVyV2lkdGggKyAneCcgKyB3aW5kb3cuaW5uZXJIZWlnaHRcclxuICAgICAgICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KG91dCk7XHJcbiAgICAgICAgICAgICAgICB9KSgpYCwgdHJ1ZSkpIGFzIHN0cmluZztcclxuICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBET01QUk9CRSAke3J9YCk7XHJcbiAgICAgICAgICAgICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgRE9NUFJPQkUgZXJyb3IgJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAyMDApfWApO1xyXG4gICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICBhcHAuZXhpdCgwKTtcclxuICAgICAgICAgICAgfSkoKTtcclxuICAgICAgICAgIH0sIE51bWJlcihwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9ET01QUk9CRV9ERUxBWV9NUyA/PyA5XzAwMCkpO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICB9XHJcbiAgICAgIC8vIFx1NkUzMlx1NjdEM1x1ODFFQVx1NjhDMCgyMDI2LTEwLTEwIFx1ODhDNVx1NjczQVx1OUVEMVx1NUM0Rlx1NjU1OVx1OEJBRDpicmlkZ2UgcmVhZHkgXHUyMjYwIFx1NzU0Q1x1OTc2Mlx1NkUzMlx1NjdEM1x1NEU4NilcdTMwMDJcclxuICAgICAgLy8gI3Jvb3QgXHU1NzI4IFJlYWN0IFx1NjMwMlx1OEY3RFx1NTQwRVx1NUZDNVx1NjcwOVx1NUI1MFx1ODI4Mlx1NzBCOTtcdTdBN0EgPSBcdThENDRcdTZFOTBcdThERUZcdTVGODQvQ1NQL1x1ODExQVx1NjcyQ1x1NTJBMFx1OEY3RFx1NTc0Rlx1NEU4Nlx1MzAwMlxyXG4gICAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfUkVOREVSX1RFU1QgPT09ICcxJykge1xyXG4gICAgICAgIHdpbi53ZWJDb250ZW50cy5vbmNlKCdkaWQtZmluaXNoLWxvYWQnLCAoKSA9PiB7XHJcbiAgICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHtcclxuICAgICAgICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBuID0gKGF3YWl0IHdpbi53ZWJDb250ZW50cy5leGVjdXRlSmF2YVNjcmlwdChcclxuICAgICAgICAgICAgICAgICAgJ2RvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwicm9vdFwiKSA/IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwicm9vdFwiKS5jaGlsZHJlbi5sZW5ndGggOiAtMScsIHRydWUsXHJcbiAgICAgICAgICAgICAgICApKSBhcyBudW1iZXI7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBvayA9IG4gPiAwO1xyXG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYFJFTkRFUi1URVNUICR7b2sgPyAnb2snIDogJ0VNUFRZJ30gcm9vdENoaWxkcmVuPSR7bn1gKTtcclxuICAgICAgICAgICAgICAgIGFwcC5leGl0KG9rID8gMCA6IDEpO1xyXG4gICAgICAgICAgICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYFJFTkRFUi1URVNUIEVSUk9SICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTIwKX1gKTtcclxuICAgICAgICAgICAgICAgIGFwcC5leGl0KDEpO1xyXG4gICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfSkoKTtcclxuICAgICAgICAgIH0sIDJfNTAwKTtcclxuICAgICAgICB9KTtcclxuICAgICAgfVxyXG4gICAgfSk7XHJcbiAgICB2b2lkIHN0YXJ0SG9zdCgpO1xyXG5cclxuICAgIGFwcC5vbignYWN0aXZhdGUnLCAoKSA9PiB7XHJcbiAgICAgIGlmIChCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5sZW5ndGggPT09IDApIHZvaWQgY3JlYXRlV2luZG93KCk7XHJcbiAgICB9KTtcclxuICB9KTtcclxuXHJcbiAgYXN5bmMgZnVuY3Rpb24gc2VjdXJpdHlTZWxmVGVzdCh3aW46IEJyb3dzZXJXaW5kb3cpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IHJlc3VsdHM6IEFycmF5PFtzdHJpbmcsIGJvb2xlYW4sIHN0cmluZ10+ID0gW107XHJcbiAgICBjb25zdCBjaGVjayA9IGFzeW5jIChuYW1lOiBzdHJpbmcsIHByb2JlOiAoKSA9PiBQcm9taXNlPFtib29sZWFuLCBzdHJpbmddPik6IFByb21pc2U8dm9pZD4gPT4ge1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IFtvaywgZGV0YWlsXSA9IGF3YWl0IHByb2JlKCk7XHJcbiAgICAgICAgcmVzdWx0cy5wdXNoKFtuYW1lLCBvaywgZGV0YWlsXSk7XHJcbiAgICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICAgIHJlc3VsdHMucHVzaChbbmFtZSwgZmFsc2UsIFN0cmluZyhlcnIpLnNsaWNlKDAsIDEyMCldKTtcclxuICAgICAgfVxyXG4gICAgfTtcclxuICAgIGNvbnN0IGpzID0gKGNvZGU6IHN0cmluZyk6IFByb21pc2U8dW5rbm93bj4gPT4gd2luLndlYkNvbnRlbnRzLmV4ZWN1dGVKYXZhU2NyaXB0KGNvZGUsIHRydWUpO1xyXG5cclxuICAgIGF3YWl0IGNoZWNrKCdyZW5kZXJlciBcdTY1RTBcdTUzRUZcdTc1MjhcdTc2ODQgcHJvY2Vzcy9yZXF1aXJlKHNhbmRib3ggXHU3NTFGXHU2NTQ4KScsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgciA9IChhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XHJcbiAgICAgICAgdmFyIHQgPSBmdW5jdGlvbihmKXsgdHJ5IHsgdmFyIHYgPSBmKCk7IHJldHVybiAodiA9PT0gdW5kZWZpbmVkIHx8IHYgPT09IG51bGwpID8gJ3VuYXZhaWxhYmxlJyA6IHR5cGVvZiB2OyB9IGNhdGNoKGUpeyByZXR1cm4gJ2Jsb2NrZWQnOyB9IH07XHJcbiAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KFt0KGZ1bmN0aW9uKCl7cmV0dXJuIHByb2Nlc3N9KSwgdChmdW5jdGlvbigpe3JldHVybiByZXF1aXJlfSksIHQoZnVuY3Rpb24oKXtyZXR1cm4gZ2xvYmFsVGhpcy5wcm9jZXNzfSldKTtcclxuICAgICAgfSkoKWApKSBhcyBzdHJpbmc7XHJcbiAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocikgYXMgc3RyaW5nW107XHJcbiAgICAgIGNvbnN0IHAgPSBwYXJzZWRbMF0gPz8gJ3Vua25vd24nO1xyXG4gICAgICBjb25zdCByZXEgPSBwYXJzZWRbMV0gPz8gJ3Vua25vd24nO1xyXG4gICAgICBjb25zdCBzYWZlID0gKHY6IHN0cmluZyk6IGJvb2xlYW4gPT4gdiA9PT0gJ3VuYXZhaWxhYmxlJyB8fCB2ID09PSAnYmxvY2tlZCc7XHJcbiAgICAgIHJldHVybiBbc2FmZShwKSAmJiBzYWZlKHJlcSksIGBwcm9jZXNzPSR7cH0gcmVxdWlyZT0ke3JlcX1gXTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgY2hlY2soJ3dpbmRvdy5obWggXHU1M0VBXHU2NzA5XHU3NjdEXHU1NDBEXHU1MzU1XHU2NUI5XHU2Q0Q1KFx1NjVFMCBpcGNSZW5kZXJlci9cdTk4OURcdTU5MTZcdTk3NjIpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKCdPYmplY3Qua2V5cyh3aW5kb3cuaG1oIHx8IHt9KS5zb3J0KCkuam9pbihcIixcIiknKSkgYXMgc3RyaW5nO1xyXG4gICAgICBjb25zdCBhbGxvdyA9IFsnYXBwbHlVcGRhdGUnLCAnYXBwcm92ZScsICdhcHByb3ZhbEdldCcsICdhcHByb3ZhbFNldCcsICdicm93c2VSdW50aW1lJywgJ2NoZWNrVXBkYXRlJywgJ2Nocm9tZVRoZW1lJywgJ2NvZ25pdGl2ZScsICdkZXRlY3RSdW50aW1lJywgJ2RpZmYnLCAnZXhwb3J0U2Vzc2lvbicsICdmc0xpc3QnLCAnZnNSZWFkJywgJ2ZzU2VhcmNoJywgJ2dldFN0YXRlJywgJ2dldFdpemFyZCcsICdpbmplY3QnLCAnaW5zdGFsbENsaScsICdpbnRlcnJ1cHQnLCAnbW9kZWxTZXQnLCAnb25FdmVudEJhdGNoZXMnLCAnb25Ib3N0U3RhdGUnLCAnb25JbnN0YWxsUHJvZ3Jlc3MnLCAnb25NZW51QWN0aW9uJywgJ29uU3RyZWFtQ2h1bmtzJywgJ29uVXBkYXRlU3RhdGUnLCAncGlja0RpcmVjdG9yeScsICdwaWNrRmlsZXMnLCAncG9wdXBNYWluTWVudScsICdwcm92aWRlclNhdmUnLCAncHJvdmlkZXJzJywgJ3JlbW90ZVdlYkF1dG9zdGFydCcsICdyZW1vdGVXZWJTdGFydCcsICdyZW1vdGVXZWJTdGF0dXMnLCAncmVtb3RlV2ViU3RvcCcsICdydW50aW1lSW5mbycsICdzZW5kVGFzaycsICdzZXNzaW9uT3AnLCAnc2Vzc2lvblByZXZpZXcnLCAnc2Vzc2lvbnMnLCAnc2V0UnVudGltZScsICdzdG9wSG9zdCcsICd3aXphcmRDb21wbGV0ZScsICd3b3Jrc3BhY2VzJywgJ3dvcmtzcGFjZUFkZCcsICd3b3Jrc3BhY2VVc2UnXTtcclxuICAgICAgY29uc3QgZ290ID0gciA9PT0gJycgPyBbXSA6IHIuc3BsaXQoJywnKTtcclxuICAgICAgY29uc3QgdW5leHBlY3RlZCA9IGdvdC5maWx0ZXIoKGspID0+ICFhbGxvdy5pbmNsdWRlcyhrKSk7XHJcbiAgICAgIHJldHVybiBbdW5leHBlY3RlZC5sZW5ndGggPT09IDAsIGBrZXlzPSR7cn1gXTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgY2hlY2soJ1x1NTkxNlx1OTBFOFx1NUJGQ1x1ODIyQVx1ODhBQlx1NjJFNlx1NjIyQShVUkwgXHU0RTBEXHU1M0Q4KScsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgYmVmb3JlID0gd2luLndlYkNvbnRlbnRzLmdldFVSTCgpO1xyXG4gICAgICBhd2FpdCBqcygnbG9jYXRpb24uaHJlZiA9IFwiaHR0cHM6Ly9leGFtcGxlLmludmFsaWQveFwiOyBcIm5vb3BcIicpLmNhdGNoKCgpID0+ICdub29wJyk7XHJcbiAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyMikgPT4gc2V0VGltZW91dChyMiwgMV8yMDApKTtcclxuICAgICAgY29uc3QgYWZ0ZXIgPSB3aW4ud2ViQ29udGVudHMuZ2V0VVJMKCk7XHJcbiAgICAgIHJldHVybiBbYWZ0ZXIgPT09IGJlZm9yZSwgYCR7YmVmb3JlfSBcdTIxOTIgJHthZnRlcn1gXTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgY2hlY2soJ3dpbmRvdy5vcGVuIFx1ODhBQlx1NjJEMlx1N0VERChcdThGRDRcdTU2REUgbnVsbCBcdTRFMTRcdTY1RTBcdTY1QjBcdTdBOTdcdTUzRTMpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCBiZWZvcmUgPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5sZW5ndGg7XHJcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoJ1N0cmluZyh3aW5kb3cub3BlbihcImh0dHBzOi8vZXhhbXBsZS5pbnZhbGlkXCIpKScpKSBhcyBzdHJpbmc7XHJcbiAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyMikgPT4gc2V0VGltZW91dChyMiwgNDAwKSk7XHJcbiAgICAgIGNvbnN0IGFmdGVyID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkubGVuZ3RoO1xyXG4gICAgICByZXR1cm4gW3IgPT09ICdudWxsJyAmJiBhZnRlciA9PT0gYmVmb3JlLCBgb3BlbigpPSR7cn0gd2luZG93cz0ke2JlZm9yZX1cdTIxOTIke2FmdGVyfWBdO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBjaGVjaygnQ1NQIFx1NUI1OFx1NTcyOChtZXRhIFx1NkNFOFx1NTE2NVx1NjIxNlx1NTRDRFx1NUU5NFx1NTkzNCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IG1ldGEgPSAoYXdhaXQganMoJ0Jvb2xlYW4oZG9jdW1lbnQucXVlcnlTZWxlY3RvcihcIm1ldGFbaHR0cC1lcXVpdj1cXCdDb250ZW50LVNlY3VyaXR5LVBvbGljeVxcJ11cIikpJykpIGFzIGJvb2xlYW47XHJcbiAgICAgIGNvbnN0IGhlYWRlckNzcCA9IGlzRGV2ID8gJ2RldjogaGVhZGVyIENTUCBcdTc1MzEgb25IZWFkZXJzUmVjZWl2ZWQgXHU2Q0U4XHU1MTY1KFx1NEUwRFx1OTAwMlx1NzUyOCBtZXRhIFx1NjVBRFx1OEEwMCknIDogJ3Byb2QnO1xyXG4gICAgICByZXR1cm4gW21ldGEgfHwgaXNEZXYsIGBtZXRhPSR7bWV0YX0gJHtoZWFkZXJDc3B9YF07XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IGNoZWNrKCdicmlkZ2U6Z2V0LXN0YXRlIFx1NkI2M1x1NUUzOFx1OEZENFx1NTZERShob3N0IFx1Njg2NVx1NTNFRlx1NzUyOCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoJ3dpbmRvdy5obWguZ2V0U3RhdGUoKS50aGVuKHMgPT4gSlNPTi5zdHJpbmdpZnkocykpLmNhdGNoKGUgPT4gXCJFUlI6XCIrZSknKSkgYXMgc3RyaW5nO1xyXG4gICAgICByZXR1cm4gW3Iuc3RhcnRzV2l0aCgneycpICYmIHIuaW5jbHVkZXMoJ2hvc3RTdGF0ZScpLCByLnNsaWNlKDAsIDgwKV07XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IGNoZWNrKCdYU1M6XHU2MDc2XHU2MTBGXHU0RUZCXHU1MkExXHU2NTg3XHU2NzJDXHU1M0VBXHU0RUU1XHU2NTg3XHU2NzJDXHU2RTMyXHU2N0QzKFx1NEUwRFx1NjI2N1x1ODg0QyknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHBheWxvYWQgPSAnPGltZyBzcmM9eCBvbmVycm9yPVwid2luZG93Ll9feHNzPTFcIj48c2NyaXB0PndpbmRvdy5fX3hzcz0yPFxcL3NjcmlwdD5cIiZcXCcnO1xyXG4gICAgICBjb25zdCBzZW5kUiA9IChhd2FpdCBqcyhgd2luZG93LmhtaC5zZW5kVGFzaygke0pTT04uc3RyaW5naWZ5KHBheWxvYWQpfSwgJ3NlYy14c3MtMScsICdhdXRvJykudGhlbihyPT5KU09OLnN0cmluZ2lmeShyKSkuY2F0Y2goZT0+J0VSUjonK2UpYCkpIGFzIHN0cmluZztcclxuICAgICAgaWYgKCFzZW5kUi5pbmNsdWRlcygnXCJva1wiOnRydWUnKSkgcmV0dXJuIFtmYWxzZSwgYHNlbmRUYXNrIFx1NjcyQVx1NTNEN1x1NzQwNjogJHtzZW5kUi5zbGljZSgwLCA4MCl9YF07XHJcbiAgICAgIC8vIGZha2UgaG9zdCBlY2hvIFx1NTZERVx1Njc2NVx1NTQwRVx1N0VDRiBSZWFjdCBcdTZFMzJcdTY3RDMoXHU3NTI4XHU2MjM3XHU2RDg4XHU2MDZGICsgXHU1MkE5XHU2MjRCIGVjaG8gXHU1M0NDXHU4REVGXHU1Rjg0KVxyXG4gICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocjIpID0+IHNldFRpbWVvdXQocjIsIDNfMDAwKSk7XHJcbiAgICAgIGNvbnN0IHByb2JlID0gKGF3YWl0IGpzKGBKU09OLnN0cmluZ2lmeSh7XHJcbiAgICAgICAgeHNzRmxhZzogdHlwZW9mIHdpbmRvdy5fX3hzcyxcclxuICAgICAgICBpbWdDb3VudDogZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnaW1nW3NyYz1cInhcIl0nKS5sZW5ndGgsXHJcbiAgICAgICAgc2NyaXB0UmFuOiBkb2N1bWVudC5ib2R5LmlubmVyVGV4dC5pbmRleE9mKCd3aW5kb3cuX194c3M9MicpID49IDBcclxuICAgICAgfSlgKSkgYXMgc3RyaW5nO1xyXG4gICAgICBjb25zdCBwID0gSlNPTi5wYXJzZShwcm9iZSkgYXMgeyB4c3NGbGFnOiBzdHJpbmc7IGltZ0NvdW50OiBudW1iZXI7IHNjcmlwdFJhbjogYm9vbGVhbiB9O1xyXG4gICAgICByZXR1cm4gW3AueHNzRmxhZyA9PT0gJ3VuZGVmaW5lZCcgJiYgcC5pbWdDb3VudCA9PT0gMCwgYHhzc0ZsYWc9JHtwLnhzc0ZsYWd9IGltZz0ke3AuaW1nQ291bnR9YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICBsZXQgZmFpbGVkID0gMDtcclxuICAgIGZvciAoY29uc3QgW25hbWUsIG9rLCBkZXRhaWxdIG9mIHJlc3VsdHMpIHtcclxuICAgICAgY29uc29sZS5sb2coYFNFQ1VSSVRZLVRFU1QgJHtvayA/ICdQQVNTJyA6ICdGQUlMJ30gfCAke25hbWV9IHwgJHtyZWRhY3QoZGV0YWlsKX1gKTtcclxuICAgICAgaWYgKCFvaykgZmFpbGVkICs9IDE7XHJcbiAgICB9XHJcbiAgICBjb25zb2xlLmxvZyhgU0VDVVJJVFktVEVTVCBTVU1NQVJZIHBhc3M9JHtyZXN1bHRzLmxlbmd0aCAtIGZhaWxlZH0vJHtyZXN1bHRzLmxlbmd0aH1gKTtcclxuICAgIGFwcC5leGl0KGZhaWxlZCA9PT0gMCA/IDAgOiAxKTtcclxuICB9XHJcblxyXG4gIC8vIFx1OTAwMFx1NTFGQTpcdTRGMThcdTk2QzVcdTUwNUNcdTZCNjJcdTgxRUFcdTVERjEgc3Bhd24gXHU3Njg0IGhvc3Qoc2h1dGRvd24gXHU3QUVGXHU3MEI5IFx1MjE5MiBcdTUxNUNcdTVFOTVcdTUzRUEga2lsbCBcdTgxRUFcdTVERjFcdTc2ODRcdTUzRTVcdTY3QzQpXHJcbiAgYXBwLm9uKCdiZWZvcmUtcXVpdCcsIChlKSA9PiB7XHJcbiAgICBpZiAoc3VwZXJ2aXNvciAhPT0gbnVsbCAmJiBzdXBlcnZpc29yLnN0YXRlICE9PSAnc3RvcHBlZCcpIHtcclxuICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xyXG4gICAgICBzc2VBYm9ydD8uYWJvcnQoKTtcclxuICAgICAgdm9pZCBzdXBlcnZpc29yLnN0b3AoKS5maW5hbGx5KCgpID0+IGFwcC5xdWl0KCkpO1xyXG4gICAgfVxyXG4gIH0pO1xyXG4gIGFwcC5vbignd2luZG93LWFsbC1jbG9zZWQnLCAoKSA9PiB7XHJcbiAgICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSAhPT0gJ2RhcndpbicpIGFwcC5xdWl0KCk7XHJcbiAgfSk7XHJcbn1cclxuIiwgIi8qKlxyXG4gKiBEZXNrdG9wUnVudGltZVN1cGVydmlzb3IgXHUyMDE0IGhtaGFybmVzcyBob3N0IFx1OEZEQlx1N0EwQlx1NzY4NFx1NzUxRlx1NTQ3RFx1NTQ2OFx1NjcxRlx1NzJCNlx1NjAwMVx1NjczQShBRFItMDAzKVx1MzAwMlxyXG4gKlxyXG4gKiBcdTVCODlcdTUxNjhcdTRFMERcdTUzRDhcdTkxQ0Y6XHJcbiAqICAtIFx1NTNFQVx1N0VEMVx1NUI5QS9cdTYzQTJcdTZENEIgMTI3LjAuMC4xO2hvc3QgXHU0RjdGXHU3NTI4XHU2NENEXHU0RjVDXHU3Q0ZCXHU3RURGXHU1MjA2XHU5MTREXHU3QUVGXHU1M0UzKHBvcnQgMCksXHU1QjlFXHU5NjQ1XHU3QUVGXHU1M0UzXHJcbiAqICAgIFx1NzUzMSBob3N0IFx1NzY4NCBzdGRvdXQgXHU1RjE1XHU1QkZDXHU4ODRDXHU1NkRFXHU0RjIwKEhvc3RSZWFkeUxpbmUpXHUzMDAyXHJcbiAqICAtIFx1OUFEOFx1NzFCNSB0b2tlbiBcdTUzRUFcdTkwMUFcdThGQzdcdTVCNTBcdThGREJcdTdBMEJcdTczQUZcdTU4ODNcdTUzRDhcdTkxQ0ZcdTRGMjBcdTkwMTIsXHU3RUREXHU0RTBEXHU4RkRCIFVSTC9cdTY1RTVcdTVGRDcvSVBDIFx1NjYwRVx1NjU4N1x1OEQxRlx1OEY3RFx1MzAwMlxyXG4gKiAgLSBcdTUzRUFcdTUwNUNcdTZCNjJcdTY3MkMgc3VwZXJ2aXNvciBzcGF3biBcdTc2ODRcdThGREJcdTdBMEJcdTUzRTVcdTY3QzQ7XHU3RUREXHU0RTBEXHU2MzA5XHU4RkRCXHU3QTBCXHU1NDBEIGtpbGxcdTMwMDJcclxuICogIC0gaG9zdCBjcmFzaCBcdTU0MEVcdTY3MDlcdTk2NTBcdTkxQ0RcdTU0MkY7XHU5MUNEXHU1NDJGXHU0RTBEXHU5MUNEXHU2NTNFXHU0RUZCXHU0RjU1XHU3NTI4XHU2MjM3XHU1MkE4XHU0RjVDKFx1OTc1RVx1NUU0Mlx1N0I0OVx1NTJBOFx1NEY1Q1x1NzUzMVx1NzUyOFx1NjIzN1x1Nzg2RVx1OEJBNClcdTMwMDJcclxuICovXHJcbmltcG9ydCB7IHNwYXduLCB0eXBlIENoaWxkUHJvY2VzcyB9IGZyb20gJ25vZGU6Y2hpbGRfcHJvY2Vzcyc7XHJcbmltcG9ydCB7IGNyZWF0ZUludGVyZmFjZSB9IGZyb20gJ25vZGU6cmVhZGxpbmUnO1xyXG5pbXBvcnQgeyByYW5kb21CeXRlcyB9IGZyb20gJ25vZGU6Y3J5cHRvJztcclxuaW1wb3J0IHsgZGVza3RvcEVycm9yLCBpc0Rlc2t0b3BFcnJvciwgdHlwZSBEZXNrdG9wRXJyb3IgfSBmcm9tICdAaG1oLWRlc2t0b3AvY29udHJhY3RzJztcclxuXHJcbmV4cG9ydCB0eXBlIEhvc3RTdGF0ZSA9XHJcbiAgfCAnc3RvcHBlZCdcclxuICB8ICdzdGFydGluZydcclxuICB8ICdyZWFkeSdcclxuICB8ICdkaXNjb25uZWN0ZWQnXHJcbiAgfCAncmVzdGFydGluZydcclxuICB8ICdzdG9wcGluZydcclxuICB8ICdmYWlsZWQnO1xyXG5cclxuZXhwb3J0IGludGVyZmFjZSBIb3N0U3BlYyB7XHJcbiAgLyoqIFx1NTNFRlx1NjI2N1x1ODg0Q1x1NjU4N1x1NEVGNihcdTkwMUFcdTVFMzggcHJvY2Vzcy5leGVjUGF0aClcdTMwMDIgKi9cclxuICBjb21tYW5kOiBzdHJpbmc7XHJcbiAgYXJnczogc3RyaW5nW107XHJcbiAgY3dkPzogc3RyaW5nO1xyXG4gIC8qKiBcdTk4OURcdTU5MTZcdTczQUZcdTU4ODNcdTUzRDhcdTkxQ0YoXHU0RjFBXHU0RTBFIHByb2Nlc3MuZW52IFx1NTQwOFx1NUU3NilcdTMwMDIgKi9cclxuICBlbnY/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xyXG59XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIFN1cGVydmlzb3JPcHRpb25zIHtcclxuICAvKiogXHU2NzFGXHU2NzFCIGhvc3QgXHU2ODIxXHU5QThDXHU3Njg0IGJlYXJlciB0b2tlbjtcdTRFMERcdTRGMjBcdTUyMTlcdTZCQ0ZcdTZCMjEgc3RhcnQgXHU3NTFGXHU2MjEwXHU5QUQ4XHU3MUI1XHU5NjhGXHU2NzNBXHU1MDNDXHUzMDAyICovXHJcbiAgdG9rZW4/OiBzdHJpbmc7XHJcbiAgbWF4UmVzdGFydHM/OiBudW1iZXI7XHJcbiAgc3RhcnRUaW1lb3V0TXM/OiBudW1iZXI7XHJcbiAgZ3JhY2VmdWxTaHV0ZG93bk1zPzogbnVtYmVyO1xyXG4gIG9uU3RhdGVDaGFuZ2U/KHN0YXRlOiBIb3N0U3RhdGUsIGluZm86IHsgcmVzdGFydENvdW50OiBudW1iZXI7IGxhc3RFcnJvcj86IHN0cmluZyB9KTogdm9pZDtcclxuICAvKiogXHU2QkNGXHU2QjIxIGhvc3QgXHU1QzMxXHU3RUVBKFx1NTQyQiBjcmFzaCBcdTgxRUFcdTYxMDhcdTU0MEVcdTc2ODRcdTkxQ0RcdTU0MkYpXHU5MEZEXHU0RjFBXHU4OUU2XHU1M0QxLFx1NjQzQVx1NUUyNlx1N0FFRlx1NzBCOShcdTU0MkIgdG9rZW4sXHJcbiAgICogIFx1NEVDNVx1NEY5Qlx1NTQwQ1x1NEZFMVx1NEVGQlx1NTdERlx1NzY4NFx1NUJCRlx1NEUzQlx1OEZEQlx1N0EwQlx1OTFDRFx1NUVGQVx1Njg2NVx1NUJBMlx1NjIzN1x1N0FFRjtcdTRFMERcdTg5ODFcdThERThcdThGREIgcmVuZGVyZXIpXHUzMDAyICovXHJcbiAgb25SZWFkeT8oZW5kcG9pbnQ6IEhvc3RFbmRwb2ludCk6IHZvaWQ7XHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgSG9zdEVuZHBvaW50IHtcclxuICBwb3J0OiBudW1iZXI7XHJcbiAgdmVyc2lvbjogc3RyaW5nO1xyXG4gIHRva2VuOiBzdHJpbmc7XHJcbn1cclxuXHJcbi8qKiBIb3N0UmVhZHlMaW5lIFx1NzY4NFx1N0M3Qlx1NTc4Qlx1NUI4OFx1NTM2Qlx1NEVDRSBjb250cmFjdHMgXHU1RjE1XHU1MTY1LFx1OTA3Rlx1NTE0RFx1NTNDQ1x1NUI5RVx1NzNCMFx1MzAwMiAqL1xyXG5pbXBvcnQgeyBpc0hvc3RSZWFkeUxpbmUgfSBmcm9tICdAaG1oLWRlc2t0b3AvY29udHJhY3RzJztcclxuXHJcbi8vIDQ1czpobWhhcm5lc3MgXHU3NzFGXHU1QjlFXHU1MTY1XHU1M0UzXHU3RUNGIHRzeCBcdTUxQjdcdTdGMTZcdThCRDFcdTY1NzRcdTU5NTcgQ0xJLFx1NjczQVx1NTY2OFx1OUFEOFx1OEQxRlx1OEY3RFx1NjVGNlx1NTNFRlx1OEQ4NSAyMHNcclxuLy8gKDIwMjYtMTAtMTEgXHU4RkRFXHU3RUVEXHU5QThDXHU2NTM2XHU0RTJEXHU5NUY0XHU2QjQ3XHU2MDI3IEhPU1RfTk9UX1JFQURZIFx1NzY4NFx1NjgzOVx1NTZFMDtcdTdBN0FcdTk1RjJcdTVCOUVcdTZENEIgNnMpXHUzMDAyXHJcbmNvbnN0IERFRkFVTFRfU1RBUlRfVElNRU9VVF9NUyA9IDQ1XzAwMDtcclxuY29uc3QgREVGQVVMVF9NQVhfUkVTVEFSVFMgPSAzO1xyXG5jb25zdCBERUZBVUxUX0dSQUNFRlVMX01TID0gNV8wMDA7XHJcblxyXG5leHBvcnQgY2xhc3MgRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yIHtcclxuICBwcml2YXRlIGNoaWxkOiBDaGlsZFByb2Nlc3MgfCBudWxsID0gbnVsbDtcclxuICBwcml2YXRlIF9zdGF0ZTogSG9zdFN0YXRlID0gJ3N0b3BwZWQnO1xyXG4gIHByaXZhdGUgcmVzdGFydENvdW50ID0gMDtcclxuICBwcml2YXRlIGxhc3RFcnJvciA9ICcnO1xyXG4gIHByaXZhdGUgc3RvcHBpbmcgPSBmYWxzZTtcclxuICBwcml2YXRlIHJlYWRvbmx5IHRva2VuOiBzdHJpbmc7XHJcbiAgcHJpdmF0ZSByZWFkb25seSBvcHRzOiBSZXF1aXJlZDxQaWNrPFN1cGVydmlzb3JPcHRpb25zLCAnbWF4UmVzdGFydHMnIHwgJ3N0YXJ0VGltZW91dE1zJyB8ICdncmFjZWZ1bFNodXRkb3duTXMnPj4gJiBTdXBlcnZpc29yT3B0aW9ucztcclxuICBwcml2YXRlIGV4aXRXYWl0ZXJzOiBBcnJheTwoKSA9PiB2b2lkPiA9IFtdO1xyXG5cclxuICBjb25zdHJ1Y3RvcihcclxuICAgIHByaXZhdGUgcmVhZG9ubHkgc3BlYzogSG9zdFNwZWMsXHJcbiAgICBvcHRzOiBTdXBlcnZpc29yT3B0aW9ucyA9IHt9LFxyXG4gICkge1xyXG4gICAgdGhpcy50b2tlbiA9IG9wdHMudG9rZW4gPz8gcmFuZG9tQnl0ZXMoMzIpLnRvU3RyaW5nKCdiYXNlNjR1cmwnKTtcclxuICAgIHRoaXMub3B0cyA9IHtcclxuICAgICAgbWF4UmVzdGFydHM6IG9wdHMubWF4UmVzdGFydHMgPz8gREVGQVVMVF9NQVhfUkVTVEFSVFMsXHJcbiAgICAgIHN0YXJ0VGltZW91dE1zOiBvcHRzLnN0YXJ0VGltZW91dE1zID8/IERFRkFVTFRfU1RBUlRfVElNRU9VVF9NUyxcclxuICAgICAgZ3JhY2VmdWxTaHV0ZG93bk1zOiBvcHRzLmdyYWNlZnVsU2h1dGRvd25NcyA/PyBERUZBVUxUX0dSQUNFRlVMX01TLFxyXG4gICAgICAuLi5vcHRzLFxyXG4gICAgfTtcclxuICB9XHJcblxyXG4gIGdldCBzdGF0ZSgpOiBIb3N0U3RhdGUge1xyXG4gICAgcmV0dXJuIHRoaXMuX3N0YXRlO1xyXG4gIH1cclxuXHJcbiAgZ2V0IHJlc3RhcnRzVXNlZCgpOiBudW1iZXIge1xyXG4gICAgcmV0dXJuIHRoaXMucmVzdGFydENvdW50O1xyXG4gIH1cclxuXHJcbiAgcHJpdmF0ZSBzZXRTdGF0ZShzOiBIb3N0U3RhdGUsIGVycj86IHN0cmluZyk6IHZvaWQge1xyXG4gICAgdGhpcy5fc3RhdGUgPSBzO1xyXG4gICAgaWYgKGVyciAhPT0gdW5kZWZpbmVkKSB0aGlzLmxhc3RFcnJvciA9IGVycjtcclxuICAgIGNvbnN0IGluZm86IHsgcmVzdGFydENvdW50OiBudW1iZXI7IGxhc3RFcnJvcj86IHN0cmluZyB9ID0geyByZXN0YXJ0Q291bnQ6IHRoaXMucmVzdGFydENvdW50IH07XHJcbiAgICBpZiAodGhpcy5sYXN0RXJyb3IgIT09ICcnKSBpbmZvLmxhc3RFcnJvciA9IHRoaXMubGFzdEVycm9yO1xyXG4gICAgdGhpcy5vcHRzLm9uU3RhdGVDaGFuZ2U/LihzLCBpbmZvKTtcclxuICB9XHJcblxyXG4gIC8qKiBcdTU0MkZcdTUyQTggaG9zdCBcdTVFNzZcdTdCNDlcdTVGODUgcmVhZHkoXHU1RjE1XHU1QkZDXHU4ODRDICsgXHU1RTI2IHRva2VuIFx1NzY4NFx1NTA2NVx1NUVCN1x1NjNBMlx1NkQ0QilcdTMwMDIgKi9cclxuICBhc3luYyBzdGFydCgpOiBQcm9taXNlPEhvc3RFbmRwb2ludD4ge1xyXG4gICAgaWYgKHRoaXMuX3N0YXRlID09PSAncmVhZHknIHx8IHRoaXMuX3N0YXRlID09PSAnc3RhcnRpbmcnKSB7XHJcbiAgICAgIHRocm93IGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgc3VwZXJ2aXNvciBhbHJlYWR5ICR7dGhpcy5fc3RhdGV9YCk7XHJcbiAgICB9XHJcbiAgICB0aGlzLnJlc3RhcnRDb3VudCA9IDA7XHJcbiAgICB0aGlzLnN0b3BwaW5nID0gZmFsc2U7XHJcbiAgICByZXR1cm4gdGhpcy5sYXVuY2goKTtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgYXN5bmMgbGF1bmNoKCk6IFByb21pc2U8SG9zdEVuZHBvaW50PiB7XHJcbiAgICB0aGlzLnNldFN0YXRlKCdzdGFydGluZycpO1xyXG4gICAgY29uc3QgY2hpbGQgPSBzcGF3bih0aGlzLnNwZWMuY29tbWFuZCwgdGhpcy5zcGVjLmFyZ3MsIHtcclxuICAgICAgY3dkOiB0aGlzLnNwZWMuY3dkLFxyXG4gICAgICBlbnY6IHtcclxuICAgICAgICAuLi5wcm9jZXNzLmVudixcclxuICAgICAgICAuLi50aGlzLnNwZWMuZW52LFxyXG4gICAgICAgIEhNSF9ERVNLVE9QX1RPS0VOOiB0aGlzLnRva2VuLFxyXG4gICAgICB9LFxyXG4gICAgICBzdGRpbzogWydpZ25vcmUnLCAncGlwZScsICdwaXBlJ10sXHJcbiAgICAgIHdpbmRvd3NIaWRlOiB0cnVlLFxyXG4gICAgfSk7XHJcbiAgICB0aGlzLmNoaWxkID0gY2hpbGQ7XHJcblxyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3QgZW5kcG9pbnQgPSBhd2FpdCB0aGlzLmF3YWl0UmVhZHkoY2hpbGQpO1xyXG4gICAgICB0aGlzLmN1cnJlbnRFbmRwb2ludCA9IHsgcG9ydDogZW5kcG9pbnQucG9ydCwgdmVyc2lvbjogZW5kcG9pbnQudmVyc2lvbiB9O1xyXG4gICAgICB0aGlzLnNldFN0YXRlKCdyZWFkeScpO1xyXG4gICAgICB0aGlzLm9wdHMub25SZWFkeT8uKGVuZHBvaW50KTtcclxuICAgICAgLy8gcmVhZHkgXHU0RTRCXHU1NDBFXHU4RkRCXHU3QTBCXHU2QjdCXHU0RUExID0gXHU2MTBGXHU1OTE2XHU5MDAwXHU1MUZBIFx1MjE5MiBcdTY3MDlcdTk2NTBcdTkxQ0RcdTU0MkZcclxuICAgICAgY2hpbGQub25jZSgnZXhpdCcsICgpID0+IHtcclxuICAgICAgICB0aGlzLmV4aXRXYWl0ZXJzLmZvckVhY2goKHcpID0+IHcoKSk7XHJcbiAgICAgICAgdGhpcy5leGl0V2FpdGVycyA9IFtdO1xyXG4gICAgICAgIHRoaXMub25VbmV4cGVjdGVkRXhpdCgpO1xyXG4gICAgICB9KTtcclxuICAgICAgcmV0dXJuIGVuZHBvaW50O1xyXG4gICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgIGlmICghY2hpbGQua2lsbGVkKSBjaGlsZC5raWxsKCk7XHJcbiAgICAgIGlmICh0aGlzLmNoaWxkID09PSBjaGlsZCkgdGhpcy5jaGlsZCA9IG51bGw7XHJcbiAgICAgIHRocm93IGVycjtcclxuICAgIH1cclxuICB9XHJcblxyXG4gIC8qKiBcdTRFQ0Ugc3Rkb3V0IFx1NjI3RSBIb3N0UmVhZHlMaW5lLFx1NzEzNlx1NTQwRVx1NTA2NVx1NUVCN1x1NjNBMlx1NkQ0Qlx1MzAwMiAqL1xyXG4gIHByaXZhdGUgYXdhaXRSZWFkeShjaGlsZDogQ2hpbGRQcm9jZXNzKTogUHJvbWlzZTxIb3N0RW5kcG9pbnQ+IHtcclxuICAgIHJldHVybiBuZXcgUHJvbWlzZTxIb3N0RW5kcG9pbnQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcclxuICAgICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHtcclxuICAgICAgICByZWplY3QoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBob3N0IGRpZCBub3Qgc2lnbmFsIHJlYWR5IHdpdGhpbiAke3RoaXMub3B0cy5zdGFydFRpbWVvdXRNc31tc2AsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xyXG4gICAgICB9LCB0aGlzLm9wdHMuc3RhcnRUaW1lb3V0TXMpO1xyXG5cclxuICAgICAgY29uc3QgZG9uZSA9IChmbjogKCkgPT4gdm9pZCk6IHZvaWQgPT4ge1xyXG4gICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XHJcbiAgICAgICAgZm4oKTtcclxuICAgICAgfTtcclxuXHJcbiAgICAgIGlmICghY2hpbGQuc3Rkb3V0KSB7XHJcbiAgICAgICAgZG9uZSgoKSA9PiByZWplY3QoZGVza3RvcEVycm9yKCdSVU5USU1FX0NSQVNIRUQnLCAnaG9zdCBzcGF3bmVkIHdpdGhvdXQgc3Rkb3V0IHBpcGUnKSkpO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgICAgfVxyXG5cclxuICAgICAgY29uc3QgcmwgPSBjcmVhdGVJbnRlcmZhY2UoeyBpbnB1dDogY2hpbGQuc3Rkb3V0IH0pO1xyXG4gICAgICBjb25zdCBvbkxpbmUgPSAobGluZTogc3RyaW5nKTogdm9pZCA9PiB7XHJcbiAgICAgICAgbGV0IHBhcnNlZDogdW5rbm93bjtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgcGFyc2VkID0gSlNPTi5wYXJzZShsaW5lKTtcclxuICAgICAgICB9IGNhdGNoIHtcclxuICAgICAgICAgIHJldHVybjsgLy8gaG9zdCBcdTc2ODRcdTY2NkVcdTkwMUFcdTY1RTVcdTVGRDdcdTg4NEMsXHU1RkZEXHU3NTY1XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChpc0hvc3RSZWFkeUxpbmUocGFyc2VkKSkge1xyXG4gICAgICAgICAgcmwuY2xvc2UoKTtcclxuICAgICAgICAgIHZvaWQgdGhpcy5wcm9iZUFuZFJlbWVtYmVyKHBhcnNlZC5wb3J0LCBwYXJzZWQudmVyc2lvbilcclxuICAgICAgICAgICAgLnRoZW4oKGVuZHBvaW50KSA9PiBkb25lKCgpID0+IHJlc29sdmUoZW5kcG9pbnQpKSlcclxuICAgICAgICAgICAgLmNhdGNoKChlcnI6IHVua25vd24pID0+IGRvbmUoKCkgPT4gcmVqZWN0KGVycikpKTtcclxuICAgICAgICB9XHJcbiAgICAgIH07XHJcbiAgICAgIHJsLm9uKCdsaW5lJywgb25MaW5lKTtcclxuXHJcbiAgICAgIGNoaWxkLm9uY2UoJ2V4aXQnLCAoY29kZSkgPT4ge1xyXG4gICAgICAgIGRvbmUoKCkgPT4gcmVqZWN0KGRlc2t0b3BFcnJvcignUlVOVElNRV9DUkFTSEVEJywgYGhvc3QgZXhpdGVkIGR1cmluZyBzdGFydHVwIChjb2RlICR7Y29kZSA/PyAnbnVsbCd9KWAsIHsgcmV0cnlhYmxlOiBmYWxzZSwgcmVjb3ZlcnlBY3Rpb246ICdPUEVOX0xPR1MnIH0pKSk7XHJcbiAgICAgIH0pO1xyXG4gICAgfSk7XHJcbiAgfVxyXG5cclxuICAvKiogXHU1RTI2IHRva2VuIFx1NzY4NFx1NTA2NVx1NUVCN1x1NjNBMlx1NkQ0QjpHRVQgL2FwaS9zdGF0ZVx1MzAwMjQwMSBcdTIxOTIgQVVUSF9GQUlMRUQoXHU0RTBEXHU5MUNEXHU4QkQ1KVx1MzAwMiAqL1xyXG4gIHByaXZhdGUgYXN5bmMgcHJvYmUocG9ydDogbnVtYmVyLCB2ZXJzaW9uOiBzdHJpbmcpOiBQcm9taXNlPEhvc3RFbmRwb2ludD4ge1xyXG4gICAgbGV0IHJlczogUmVzcG9uc2U7XHJcbiAgICB0cnkge1xyXG4gICAgICByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2FwaS9zdGF0ZWAsIHtcclxuICAgICAgICBoZWFkZXJzOiB7ICd4LWhtaC1rZXknOiB0aGlzLnRva2VuIH0sXHJcbiAgICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDNfMDAwKSxcclxuICAgICAgfSk7XHJcbiAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgdGhyb3cgZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBoZWFsdGggcHJvYmUgZmFpbGVkOiAke1N0cmluZyhlcnIpLnNsaWNlKDAsIDE2MCl9YCwgeyByZXRyeWFibGU6IHRydWUgfSk7XHJcbiAgICB9XHJcbiAgICBpZiAocmVzLnN0YXR1cyA9PT0gNDAxIHx8IHJlcy5zdGF0dXMgPT09IDQwMykge1xyXG4gICAgICB0aHJvdyBkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgYGhvc3QgcmVqZWN0ZWQgdGhlIHNlc3Npb24gdG9rZW4gKEhUVFAgJHtyZXMuc3RhdHVzfSlgLCB7IHJldHJ5YWJsZTogZmFsc2UsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KTtcclxuICAgIH1cclxuICAgIGlmICghcmVzLm9rKSB7XHJcbiAgICAgIHRocm93IGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgaGVhbHRoIHByb2JlIEhUVFAgJHtyZXMuc3RhdHVzfWAsIHsgcmV0cnlhYmxlOiB0cnVlIH0pO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHsgcG9ydCwgdmVyc2lvbiwgdG9rZW46IHRoaXMudG9rZW4gfTtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgb25VbmV4cGVjdGVkRXhpdCgpOiB2b2lkIHtcclxuICAgIGlmICh0aGlzLnN0b3BwaW5nIHx8IHRoaXMuX3N0YXRlID09PSAnc3RvcHBlZCcgfHwgdGhpcy5fc3RhdGUgPT09ICdzdG9wcGluZycpIHJldHVybjtcclxuICAgIHRoaXMuY2hpbGQgPSBudWxsO1xyXG4gICAgaWYgKHRoaXMucmVzdGFydENvdW50IDwgdGhpcy5vcHRzLm1heFJlc3RhcnRzKSB7XHJcbiAgICAgIHRoaXMucmVzdGFydENvdW50ICs9IDE7XHJcbiAgICAgIHRoaXMuc2V0U3RhdGUoJ3Jlc3RhcnRpbmcnKTtcclxuICAgICAgdm9pZCB0aGlzLmxhdW5jaCgpLmNhdGNoKCgpID0+IHtcclxuICAgICAgICAvLyBcdTkxQ0RcdTU0MkZcdTVDMURcdThCRDVcdTU5MzFcdThEMjUoXHU1NDJGXHU1MkE4XHU1MzczXHU1RDI5L1x1OEQ4NVx1NjVGNi9cdTYyRDJcdThCQTQpOlx1N0VFN1x1N0VFRFx1NkQ4OFx1ODAxN1x1OTFDRFx1NTQyRlx1NkIyMVx1NjU3MFx1NzZGNFx1NTIzMFx1NjUzRVx1NUYwM1xyXG4gICAgICAgIHRoaXMucmV0cnlPckZhaWwoKTtcclxuICAgICAgfSk7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICB0aGlzLnNldFN0YXRlKCdmYWlsZWQnLCBgaG9zdCBleGl0ZWQgdW5leHBlY3RlZGx5ICR7dGhpcy5yZXN0YXJ0Q291bnQgKyAxfSB0aW1lczsgZ2l2aW5nIHVwYCk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICBwcml2YXRlIHJldHJ5T3JGYWlsKCk6IHZvaWQge1xyXG4gICAgaWYgKHRoaXMuc3RvcHBpbmcgfHwgdGhpcy5fc3RhdGUgPT09ICdzdG9wcGVkJyB8fCB0aGlzLl9zdGF0ZSA9PT0gJ3N0b3BwaW5nJykgcmV0dXJuO1xyXG4gICAgaWYgKHRoaXMucmVzdGFydENvdW50IDwgdGhpcy5vcHRzLm1heFJlc3RhcnRzKSB7XHJcbiAgICAgIHRoaXMucmVzdGFydENvdW50ICs9IDE7XHJcbiAgICAgIHRoaXMuc2V0U3RhdGUoJ3Jlc3RhcnRpbmcnKTtcclxuICAgICAgdm9pZCB0aGlzLmxhdW5jaCgpLmNhdGNoKCgpID0+IHRoaXMucmV0cnlPckZhaWwoKSk7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICB0aGlzLnNldFN0YXRlKCdmYWlsZWQnLCBgaG9zdCBmYWlsZWQgdG8gc3RheSB1cCBhZnRlciAke3RoaXMucmVzdGFydENvdW50fSByZXN0YXJ0IGF0dGVtcHRzYCk7XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvKiogXHU0RjE4XHU5NkM1XHU1MDVDXHU2QjYyOlx1NTE0OCBIVFRQIHNodXRkb3duLFx1OEQ4NVx1NjVGNlx1NjI0RFx1NUJGOVx1NjcyQ1x1OEZEQlx1N0EwQlx1NTNFNVx1NjdDNCBraWxsXHUzMDAyICovXHJcbiAgYXN5bmMgc3RvcCgpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIHRoaXMuc3RvcHBpbmcgPSB0cnVlO1xyXG4gICAgaWYgKHRoaXMuX3N0YXRlID09PSAnc3RvcHBlZCcpIHJldHVybjtcclxuICAgIHRoaXMuc2V0U3RhdGUoJ3N0b3BwaW5nJyk7XHJcbiAgICBjb25zdCBjaGlsZCA9IHRoaXMuY2hpbGQ7XHJcbiAgICB0aGlzLmNoaWxkID0gbnVsbDtcclxuICAgIHRoaXMuY3VycmVudEVuZHBvaW50ID0gbnVsbDtcclxuICAgIGlmICghY2hpbGQpIHtcclxuICAgICAgdGhpcy5zZXRTdGF0ZSgnc3RvcHBlZCcpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBjb25zdCBleGl0ZWQgPSBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4ge1xyXG4gICAgICBpZiAoY2hpbGQuZXhpdENvZGUgIT09IG51bGwgfHwgY2hpbGQuc2lnbmFsQ29kZSAhPT0gbnVsbCkgcmVzb2x2ZSgpO1xyXG4gICAgICBlbHNlIHtcclxuICAgICAgICBjb25zdCB3ID0gKCk6IHZvaWQgPT4gcmVzb2x2ZSgpO1xyXG4gICAgICAgIHRoaXMuZXhpdFdhaXRlcnMucHVzaCh3KTtcclxuICAgICAgICBjaGlsZC5vbmNlKCdleGl0Jywgdyk7XHJcbiAgICAgIH1cclxuICAgIH0pO1xyXG4gICAgLy8gXHU1REYyXHU3N0U1XHU3QUVGXHU1M0UzXHU2MjREXHU1QzFEXHU4QkQ1IEhUVFAgXHU0RjE4XHU5NkM1XHU1MTczXHU5NUVEO1x1NjcyQVx1NzdFNVx1N0FFRlx1NTNFM1x1NzZGNFx1NjNBNVx1OEQ3MCBraWxsIFx1NTE1Q1x1NUU5NVxyXG4gICAgaWYgKHRoaXMubGFzdEVuZHBvaW50ICE9PSBudWxsKSB7XHJcbiAgICAgIHRyeSB7XHJcbiAgICAgICAgYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHt0aGlzLmxhc3RFbmRwb2ludH0vYXBpL2Rlc2t0b3Avc2h1dGRvd25gLCB7XHJcbiAgICAgICAgICBtZXRob2Q6ICdQT1NUJyxcclxuICAgICAgICAgIGhlYWRlcnM6IHsgJ3gtaG1oLWtleSc6IHRoaXMudG9rZW4gfSxcclxuICAgICAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCgxXzAwMCksXHJcbiAgICAgICAgfSk7XHJcbiAgICAgIH0gY2F0Y2gge1xyXG4gICAgICAgIC8vIGhvc3QgXHU1REYyXHU2QjdCXHU2MjE2XHU0RTBEXHU1RTk0XHU3QjU0Olx1OEQ3MCBraWxsIFx1NTE1Q1x1NUU5NVxyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgICBjb25zdCBncmFjZWZ1bCA9IGF3YWl0IFByb21pc2UucmFjZShbXHJcbiAgICAgIGV4aXRlZC50aGVuKCgpID0+IHRydWUpLFxyXG4gICAgICBuZXcgUHJvbWlzZTxib29sZWFuPigocmVzb2x2ZSkgPT4gc2V0VGltZW91dCgoKSA9PiByZXNvbHZlKGZhbHNlKSwgdGhpcy5vcHRzLmdyYWNlZnVsU2h1dGRvd25NcykpLFxyXG4gICAgXSk7XHJcbiAgICBpZiAoIWdyYWNlZnVsICYmIGNoaWxkLmV4aXRDb2RlID09PSBudWxsICYmIGNoaWxkLnNpZ25hbENvZGUgPT09IG51bGwpIHtcclxuICAgICAgY2hpbGQua2lsbCgpOyAvLyBcdTUzRUFcdTY3NDBcdTgxRUFcdTVERjFcdTYzMDFcdTY3MDlcdTc2ODRcdTUzRTVcdTY3QzQsXHU3RUREXHU0RTBEXHU2MzA5XHU4RkRCXHU3QTBCXHU1NDBEXHJcbiAgICB9XHJcbiAgICBhd2FpdCBleGl0ZWQuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcclxuICAgIHRoaXMuc2V0U3RhdGUoJ3N0b3BwZWQnKTtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgbGFzdEVuZHBvaW50OiBudW1iZXIgfCBudWxsID0gbnVsbDtcclxuICBwcml2YXRlIGN1cnJlbnRFbmRwb2ludDogeyBwb3J0OiBudW1iZXI7IHZlcnNpb246IHN0cmluZyB9IHwgbnVsbCA9IG51bGw7XHJcblxyXG4gIC8qKiBcdTVGNTNcdTUyNEQgaG9zdCBcdTdBRUZcdTcwQjkocmVhZHkgXHU1NDBFXHU2NzA5XHU1MDNDO1x1NEUwRFx1NTQyQiB0b2tlbilcdTMwMDIgKi9cclxuICBnZXQgZW5kcG9pbnQoKTogeyBwb3J0OiBudW1iZXI7IHZlcnNpb246IHN0cmluZyB9IHwgbnVsbCB7XHJcbiAgICByZXR1cm4gdGhpcy5jdXJyZW50RW5kcG9pbnQ7XHJcbiAgfVxyXG5cclxuICAvKiogXHU2M0EyXHU2RDRCXHU2MjEwXHU1MjlGXHU1NDBFXHU4QkIwXHU0RjRGXHU3QUVGXHU1M0UzLFx1NEY5QiBzdG9wKCkgXHU3Njg0XHU0RjE4XHU5NkM1XHU1MTczXHU5NUVEXHU0RjdGXHU3NTI4XHUzMDAyICovXHJcbiAgcHJpdmF0ZSBhc3luYyBwcm9iZUFuZFJlbWVtYmVyKHBvcnQ6IG51bWJlciwgdmVyc2lvbjogc3RyaW5nKTogUHJvbWlzZTxIb3N0RW5kcG9pbnQ+IHtcclxuICAgIGNvbnN0IGVwID0gYXdhaXQgdGhpcy5wcm9iZShwb3J0LCB2ZXJzaW9uKTtcclxuICAgIHRoaXMubGFzdEVuZHBvaW50ID0gZXAucG9ydDtcclxuICAgIHJldHVybiBlcDtcclxuICB9XHJcbn1cclxuXHJcbi8qKiBcdTYyOEFcdTY3MkFcdTc3RTVcdTk1MTlcdThCRUZcdTg5QzRcdTdFQTZcdTRFM0EgRGVza3RvcEVycm9yKFx1NURGMlx1NjYyRlx1NTIxOVx1NTM5Rlx1NjgzN1x1OEZENFx1NTZERSlcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHRvRGVza3RvcEVycm9yKGVycjogdW5rbm93bik6IERlc2t0b3BFcnJvciB7XHJcbiAgaWYgKGlzRGVza3RvcEVycm9yKGVycikpIHJldHVybiBlcnI7XHJcbiAgY29uc3QgbWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcclxuICByZXR1cm4gZGVza3RvcEVycm9yKCdSVU5USU1FX0NSQVNIRUQnLCBtZXNzYWdlLnNsaWNlKDAsIDMwMCksIHsgcmV0cnlhYmxlOiBmYWxzZSB9KTtcclxufVxyXG4iLCAiLyoqXHJcbiAqIEBobWgtZGVza3RvcC9jb250cmFjdHMgXHUyMDE0IFx1NEU4Qlx1NEVGNlx1NEZFMVx1NUMwMShcdTVGMDBcdTUzRDFcdThCQTFcdTUyMTJcdTY1ODdcdTY4NjMgMDQgXHUwMEE3XHU0RTA5KVxyXG4gKlxyXG4gKiBcdTRFMDBcdTY3NjEgVUkgXHU0RThCXHU0RUY2XHU3Njg0XHU1NTJGXHU0RTAwXHU1RjYyXHU3MkI2XHUzMDAyXHU1MjREXHU3QUVGIHJlZHVjZXIgXHU1RkM1XHU5ODdCXHU2MzA5IHNlc3Npb25JZC9ydW5JZC9zZXEgXHU1OTA0XHU3NDA2O1xyXG4gKiBcdTkxQ0RcdTU5MEQgZXZlbnRJZCBcdTVFNDJcdTdCNDlcdTRFMjJcdTVGMDM7c2VxIFx1N0YzQVx1NTNFM1x1ODlFNlx1NTNEMVx1ODg2NVx1NjJDOTtcdTk3NUVcdTVFNDJcdTdCNDlcdTUyQThcdTRGNUNcdTRFMERcdTc1MzEgU1NFIFx1ODFFQVx1NTJBOFx1OTFDRFx1NTNEMVx1MzAwMlxyXG4gKi9cclxuXHJcbmltcG9ydCB0eXBlIHsgQXJ0aWZhY3RSZWYgfSBmcm9tICcuL2R0by50cyc7XHJcbmltcG9ydCB0eXBlIHsgRGVza3RvcEVycm9yIH0gZnJvbSAnLi9lcnJvci50cyc7XHJcblxyXG4vKiogXHU0RThCXHU0RUY2XHU3OUNEXHU3QzdCKFx1NTIyNFx1NTIyQlx1OTUyRSlcdTMwMDJcdTY1QjBcdTU4OUUga2luZCA9IHNjaGVtYVZlcnNpb24gXHU1MzQ3XHU3RUE3LFx1NEUwRFx1NTE0MVx1OEJCOFx1OTc1OVx1OUVEOFx1NjI2OVx1Njc5QVx1NEUzRVx1MzAwMiAqL1xyXG5leHBvcnQgY29uc3QgRVZFTlRfS0lORFMgPSBbXHJcbiAgJ3J1bi5zdGFydGVkJyxcclxuICAncGxhbi51cGRhdGVkJyxcclxuICAndG9vbC5zdGFydGVkJyxcclxuICAndG9vbC5jb21wbGV0ZWQnLFxyXG4gICdhcHByb3ZhbC5yZXF1aXJlZCcsXHJcbiAgJ3ZlcmlmaWNhdGlvbi51cGRhdGVkJyxcclxuICAnYXJ0aWZhY3QuY3JlYXRlZCcsXHJcbiAgJ3J1bi5jb21wbGV0ZWQnLFxyXG4gICdydW4uZmFpbGVkJyxcclxuXSBhcyBjb25zdDtcclxuXHJcbmV4cG9ydCB0eXBlIEV2ZW50S2luZCA9ICh0eXBlb2YgRVZFTlRfS0lORFMpW251bWJlcl07XHJcblxyXG5leHBvcnQgY29uc3QgRVZFTlRfU0NIRU1BX1ZFUlNJT04gPSAxO1xyXG5leHBvcnQgdHlwZSBFdmVudFNjaGVtYVZlcnNpb24gPSAxO1xyXG5cclxuLyoqIFNTRSBcdTZENDFcdTRFMEFcdTc2ODRcdTZCQ0ZcdTRFMDBcdTY3NjFcdTRFOEJcdTRFRjZcdTMwMDIgKi9cclxuZXhwb3J0IGludGVyZmFjZSBFdmVudEVudmVsb3BlPFQgPSB1bmtub3duPiB7XHJcbiAgc2NoZW1hVmVyc2lvbjogRXZlbnRTY2hlbWFWZXJzaW9uO1xyXG4gIC8qKiBcdTUxNjhcdTVDNDBcdTU1MkZcdTRFMDA7XHU5MUNEXHU4RkRFL1x1ODg2NVx1NjJDOVx1NTQwRVx1OTFDRFx1NTkwRFx1NTFGQVx1NzNCMFx1NjVGNlx1NjNBNVx1NjUzNlx1NjVCOVx1NUU0Mlx1N0I0OVx1NEUyMlx1NUYwM1x1MzAwMiAqL1xyXG4gIGV2ZW50SWQ6IHN0cmluZztcclxuICBzZXNzaW9uSWQ6IHN0cmluZztcclxuICBydW5JZDogc3RyaW5nO1xyXG4gIC8qKiBcdTRGMUFcdThCRERcdTUxODVcdTUzNTVcdThDMDNcdTkwMTJcdTU4OUU7XHU3RjNBXHU1M0UzXHU2MTBGXHU1NDczXHU3NzQwXHU0RTIyXHU0RThCXHU0RUY2LFx1OTcwMFx1ODk4MVx1ODg2NVx1NjJDOVx1MzAwMiAqL1xyXG4gIHNlcTogbnVtYmVyO1xyXG4gIC8qKiBSRkMzMzM5XHUzMDAyICovXHJcbiAgb2NjdXJyZWRBdDogc3RyaW5nO1xyXG4gIGtpbmQ6IEV2ZW50S2luZDtcclxuICBwYXlsb2FkOiBUO1xyXG59XHJcblxyXG4vKiogcnVuLnN0YXJ0ZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cclxuZXhwb3J0IGludGVyZmFjZSBSdW5TdGFydGVkUGF5bG9hZCB7XHJcbiAgdGFzazogc3RyaW5nO1xyXG4gIG1vZGU6ICdhc2snIHwgJ2F1dG8nIHwgJ3lvbG8nO1xyXG59XHJcblxyXG4vKiogcGxhbi51cGRhdGVkIFx1NzY4NCBwYXlsb2FkKFx1OEJBMVx1NTIxMlx1NkI2NVx1OUFBNFx1NTIxN1x1ODg2OCxcdTY3NjVcdTgxRUEgcnVudGltZSBcdTc2ODRcdTdFRDNcdTY3ODRcdTUzMTZcdThCQTFcdTUyMTIsXHU0RTBEXHU2NjJGIGNoYWluLW9mLXRob3VnaHQpXHUzMDAyICovXHJcbmV4cG9ydCBpbnRlcmZhY2UgUGxhblVwZGF0ZWRQYXlsb2FkIHtcclxuICBzdGVwczogQXJyYXk8eyB0aXRsZTogc3RyaW5nOyBzdGF0dXM6ICdwZW5kaW5nJyB8ICdhY3RpdmUnIHwgJ2RvbmUnIHwgJ2ZhaWxlZCcgfT47XHJcbn1cclxuXHJcbi8qKiB0b29sLnN0YXJ0ZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cclxuZXhwb3J0IGludGVyZmFjZSBUb29sU3RhcnRlZFBheWxvYWQge1xyXG4gIG5hbWU6IHN0cmluZztcclxuICAvKiogXHU1M0MyXHU2NTcwXHU0RUU1XHU2NTg3XHU2NzJDXHU1NDQ4XHU3M0IwLFx1NkUzMlx1NjdEM1x1N0FFRlx1NkMzOFx1NEUwRCBldmFsO1x1NTkyN1x1NUJGOVx1OEM2MVx1NzUzMSBydW50aW1lIFx1NjIyQVx1NjVBRFx1MzAwMiAqL1xyXG4gIGFyZ3NQcmV2aWV3OiBzdHJpbmc7XHJcbn1cclxuXHJcbi8qKiB0b29sLmNvbXBsZXRlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xyXG5leHBvcnQgaW50ZXJmYWNlIFRvb2xDb21wbGV0ZWRQYXlsb2FkIHtcclxuICBuYW1lOiBzdHJpbmc7XHJcbiAgaXNFcnJvcjogYm9vbGVhbjtcclxuICBvdXRwdXRQcmV2aWV3OiBzdHJpbmc7XHJcbn1cclxuXHJcbi8qKiBhcHByb3ZhbC5yZXF1aXJlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMlx1NUJBMVx1NjI3OVx1Njc0M1x1NUEwMVx1NTcyOCBydW50aW1lIFx1NTQwRVx1N0FFRjtVSSBcdTUzRUFcdTY2MkZcdThGNkNcdThGRjBcdTMwMDIgKi9cclxuZXhwb3J0IGludGVyZmFjZSBBcHByb3ZhbFJlcXVpcmVkUGF5bG9hZCB7XHJcbiAgYXBwcm92YWxJZDogc3RyaW5nO1xyXG4gIHRvb2w6IHN0cmluZztcclxuICBhcmdzUHJldmlldzogc3RyaW5nO1xyXG4gIC8qKiBcdTVGNzFcdTU0Q0RcdTgzMDNcdTU2RjQvXHU5OENFXHU5NjY5XHU3Njg0XHU0RUJBXHU3QzdCXHU1M0VGXHU4QkZCXHU4QkY0XHU2NjBFLFx1NzUzMSBydW50aW1lIFx1NzUxRlx1NjIxMFx1MzAwMiAqL1xyXG4gIHJpc2s6IHN0cmluZztcclxufVxyXG5cclxuLyoqIHZlcmlmaWNhdGlvbi51cGRhdGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXHJcbmV4cG9ydCBpbnRlcmZhY2UgVmVyaWZpY2F0aW9uVXBkYXRlZFBheWxvYWQge1xyXG4gIHN1bW1hcnk6IHN0cmluZztcclxuICBwYXNzZWQ6IGJvb2xlYW4gfCBudWxsOyAvLyBudWxsID0gXHU2NzJBXHU3N0U1L1x1OEZEQlx1ODg0Q1x1NEUyRChORUVEUy1EQVRBIFx1NjVGNlx1NEUwRFx1NTA0N1x1NTg2QilcclxufVxyXG5cclxuLyoqIGFydGlmYWN0LmNyZWF0ZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cclxuZXhwb3J0IGludGVyZmFjZSBBcnRpZmFjdENyZWF0ZWRQYXlsb2FkIHtcclxuICBhcnRpZmFjdDogQXJ0aWZhY3RSZWY7XHJcbn1cclxuXHJcbi8qKiBydW4uY29tcGxldGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXHJcbmV4cG9ydCBpbnRlcmZhY2UgUnVuQ29tcGxldGVkUGF5bG9hZCB7XHJcbiAgdGV4dDogc3RyaW5nO1xyXG4gIHR1cm5zOiBudW1iZXI7XHJcbiAgdG9vbFVzZXM6IG51bWJlcjtcclxuICB1c2FnZT86IHsgcHJvbXB0VG9rZW5zOiBudW1iZXI7IGNvbXBsZXRpb25Ub2tlbnM6IG51bWJlciB9O1xyXG59XHJcblxyXG4vKiogcnVuLmZhaWxlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xyXG5leHBvcnQgaW50ZXJmYWNlIFJ1bkZhaWxlZFBheWxvYWQge1xyXG4gIGVycm9yOiBEZXNrdG9wRXJyb3I7XHJcbn1cclxuIiwgIi8qKlxyXG4gKiBAaG1oLWRlc2t0b3AvY29udHJhY3RzIFx1MjAxNCBcdTdFRDNcdTY3ODRcdTUzMTZcdTY4NENcdTk3NjJcdTk1MTlcdThCRUYoXHU1RjAwXHU1M0QxXHU4QkExXHU1MjEyXHU2NTg3XHU2ODYzIDA0IFx1MDBBN1x1NEUwOSlcdTMwMDJcclxuICpcclxuICogaG9zdC1ub3QtcmVhZHkgLyBhdXRoLWZhaWxlZCAvIHN0YWxlLXZlcnNpb24gLyBydW50aW1lLWNyYXNoZWQgL1xyXG4gKiBwb3J0LWJpbmQtZmFpbGVkIC8gc2NoZW1hLW1pc21hdGNoIFx1NUZDNVx1OTg3Qlx1NjYyRlx1N0VEM1x1Njc4NFx1NTMxNlx1OTUxOVx1OEJFRlx1NzgwMSxcdTVFNzZcdTYzRDBcdTRGOUJcdTRFMEJcdTRFMDBcdTZCNjVcdTUyQThcdTRGNUNcdTMwMDJcclxuICogbWVzc2FnZSBcdTY2MkZcdTdFQUZcdTY1ODdcdTY3MkMsXHU2RTMyXHU2N0QzXHU3QUVGXHU2QzM4XHU0RTBEXHU2MjhBXHU1QjgzXHU1RjUzIEhUTUxcdTMwMDJcclxuICovXHJcbmV4cG9ydCBjb25zdCBFUlJPUl9DT0RFUyA9IFtcclxuICAnSE9TVF9OT1RfUkVBRFknLFxyXG4gICdBVVRIX0ZBSUxFRCcsXHJcbiAgJ1JVTlRJTUVfQ1JBU0hFRCcsXHJcbiAgJ1BPUlRfQklORF9GQUlMRUQnLFxyXG4gICdTVEFMRV9WRVJTSU9OJyxcclxuICAnU0NIRU1BX01JU01BVENIJyxcclxuXSBhcyBjb25zdDtcclxuXHJcbmV4cG9ydCB0eXBlIEVycm9yQ29kZSA9ICh0eXBlb2YgRVJST1JfQ09ERVMpW251bWJlcl07XHJcblxyXG5leHBvcnQgY29uc3QgUkVDT1ZFUllfQUNUSU9OUyA9IFsnUkVDT05ORUNUJywgJ1JFU1VNRScsICdFWFBPUlQnLCAnT1BFTl9MT0dTJ10gYXMgY29uc3Q7XHJcbmV4cG9ydCB0eXBlIFJlY292ZXJ5QWN0aW9uID0gKHR5cGVvZiBSRUNPVkVSWV9BQ1RJT05TKVtudW1iZXJdO1xyXG5cclxuZXhwb3J0IGludGVyZmFjZSBEZXNrdG9wRXJyb3Ige1xyXG4gIGNvZGU6IEVycm9yQ29kZTtcclxuICAvKiogXHU3RUFGXHU2NTg3XHU2NzJDLFx1NkMzOFx1NEUwRFx1NEZFMVx1NEVGQlx1NEUzQSBIVE1MXHUzMDAyICovXHJcbiAgbWVzc2FnZTogc3RyaW5nO1xyXG4gIHJldHJ5YWJsZTogYm9vbGVhbjtcclxuICBzZXNzaW9uSWQ/OiBzdHJpbmc7XHJcbiAgcnVuSWQ/OiBzdHJpbmc7XHJcbiAgcmVjb3ZlcnlBY3Rpb24/OiBSZWNvdmVyeUFjdGlvbjtcclxufVxyXG5cclxuLyoqIFx1Njc4NFx1OTAyMFx1NEUwMFx1NEUyQSBEZXNrdG9wRXJyb3IoZXhhY3RPcHRpb25hbFByb3BlcnR5VHlwZXMgXHU1M0NCXHU1OTdEKVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gZGVza3RvcEVycm9yKFxyXG4gIGNvZGU6IEVycm9yQ29kZSxcclxuICBtZXNzYWdlOiBzdHJpbmcsXHJcbiAgb3B0czogeyByZXRyeWFibGU/OiBib29sZWFuOyBzZXNzaW9uSWQ/OiBzdHJpbmc7IHJ1bklkPzogc3RyaW5nOyByZWNvdmVyeUFjdGlvbj86IFJlY292ZXJ5QWN0aW9uIH0gPSB7fSxcclxuKTogRGVza3RvcEVycm9yIHtcclxuICBjb25zdCBlOiBEZXNrdG9wRXJyb3IgPSB7IGNvZGUsIG1lc3NhZ2UsIHJldHJ5YWJsZTogb3B0cy5yZXRyeWFibGUgPT09IHRydWUgfTtcclxuICBpZiAob3B0cy5zZXNzaW9uSWQgIT09IHVuZGVmaW5lZCkgZS5zZXNzaW9uSWQgPSBvcHRzLnNlc3Npb25JZDtcclxuICBpZiAob3B0cy5ydW5JZCAhPT0gdW5kZWZpbmVkKSBlLnJ1bklkID0gb3B0cy5ydW5JZDtcclxuICBpZiAob3B0cy5yZWNvdmVyeUFjdGlvbiAhPT0gdW5kZWZpbmVkKSBlLnJlY292ZXJ5QWN0aW9uID0gb3B0cy5yZWNvdmVyeUFjdGlvbjtcclxuICByZXR1cm4gZTtcclxufVxyXG4iLCAiLyoqXHJcbiAqIEBobWgtZGVza3RvcC9jb250cmFjdHMgXHUyMDE0IHJ1bnRpbWUgXHU2ODIxXHU5QThDKGd1YXJkcylcdTMwMDJcclxuICpcclxuICogXHU2QkNGXHU0RTJBXHU4REU4XHU0RkUxXHU0RUZCXHU4RkI5XHU3NTRDXHU3Njg0XHU2NTcwXHU2MzZFKHJ1bnRpbWVcdTIxOTJyZW5kZXJlclx1MzAwMWhvc3RcdTIxOTJtYWluKVx1OEZEQlx1NTE2NVx1NTI0RFx1NTE0OFx1OEZDNyBndWFyZDtcclxuICogXHU2ODIxXHU5QThDXHU1OTMxXHU4RDI1XHU3Njg0XHU2NTcwXHU2MzZFXHU2MzA5IFNDSEVNQV9NSVNNQVRDSCBcdTdFRDNcdTY3ODRcdTUzMTZcdTk1MTlcdThCRUZcdTU5MDRcdTc0MDYsXHU0RTBEXHU5NzU5XHU5RUQ4XHU2M0E1XHU1M0Q3XHUzMDAyXHJcbiAqIFx1NjI0Qlx1NTE5OVx1NUI4OFx1NTM2Qlx1ODAwQ1x1NEUwRFx1NjYyRlx1NUYxNVx1N0IyQ1x1NEUwOVx1NjVCOSBzY2hlbWEgXHU1RTkzOlx1NTk1MVx1N0VBNlx1OTc2Mlx1NUMwRixcdTk2RjZcdTRGOURcdThENTZcdTY1ODdcdTUzMTYoaG1oYXJuZXNzIFx1NTQwQ1x1NkU5MClcdTMwMDJcclxuICovXHJcbmltcG9ydCB7XHJcbiAgRVZFTlRfS0lORFMsXHJcbiAgRVZFTlRfU0NIRU1BX1ZFUlNJT04sXHJcbiAgdHlwZSBFdmVudEVudmVsb3BlLFxyXG4gIHR5cGUgRXZlbnRLaW5kLFxyXG59IGZyb20gJy4vZXZlbnQudHMnO1xyXG5pbXBvcnQgeyBFUlJPUl9DT0RFUywgUkVDT1ZFUllfQUNUSU9OUywgdHlwZSBEZXNrdG9wRXJyb3IgfSBmcm9tICcuL2Vycm9yLnRzJztcclxuaW1wb3J0IHsgUlVOX1NUQVRVU0VTLCB0eXBlIFJ1blN0YXR1cyB9IGZyb20gJy4vZHRvLnRzJztcclxuXHJcbmNvbnN0IGlzUmVjb3JkID0gKHY6IHVua25vd24pOiB2IGlzIFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0+XHJcbiAgdHlwZW9mIHYgPT09ICdvYmplY3QnICYmIHYgIT09IG51bGwgJiYgIUFycmF5LmlzQXJyYXkodik7XHJcblxyXG5jb25zdCBpc05vbkVtcHR5U3RyaW5nID0gKHY6IHVua25vd24pOiB2IGlzIHN0cmluZyA9PiB0eXBlb2YgdiA9PT0gJ3N0cmluZycgJiYgdi5sZW5ndGggPiAwO1xyXG5cclxuY29uc3QgaXNSZmMzMzM5ID0gKHY6IHN0cmluZyk6IGJvb2xlYW4gPT4ge1xyXG4gIGNvbnN0IHQgPSBEYXRlLnBhcnNlKHYpO1xyXG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUodCkgJiYgL1xcZHs0fS1cXGR7Mn0tXFxkezJ9VC8udGVzdCh2KTtcclxufTtcclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpc0V2ZW50RW52ZWxvcGUodjogdW5rbm93bik6IHYgaXMgRXZlbnRFbnZlbG9wZSB7XHJcbiAgaWYgKCFpc1JlY29yZCh2KSkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICh2LnNjaGVtYVZlcnNpb24gIT09IEVWRU5UX1NDSEVNQV9WRVJTSU9OKSByZXR1cm4gZmFsc2U7XHJcbiAgaWYgKCFpc05vbkVtcHR5U3RyaW5nKHYuZXZlbnRJZCkpIHJldHVybiBmYWxzZTtcclxuICBpZiAoIWlzTm9uRW1wdHlTdHJpbmcodi5zZXNzaW9uSWQpKSByZXR1cm4gZmFsc2U7XHJcbiAgaWYgKCFpc05vbkVtcHR5U3RyaW5nKHYucnVuSWQpKSByZXR1cm4gZmFsc2U7XHJcbiAgaWYgKHR5cGVvZiB2LnNlcSAhPT0gJ251bWJlcicgfHwgIU51bWJlci5pc0ludGVnZXIodi5zZXEpIHx8IHYuc2VxIDwgMCkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICghaXNOb25FbXB0eVN0cmluZyh2Lm9jY3VycmVkQXQpIHx8ICFpc1JmYzMzMzkodi5vY2N1cnJlZEF0KSkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICghRVZFTlRfS0lORFMuaW5jbHVkZXModi5raW5kIGFzIEV2ZW50S2luZCkpIHJldHVybiBmYWxzZTtcclxuICByZXR1cm4gaXNSZWNvcmQodi5wYXlsb2FkKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGlzRGVza3RvcEVycm9yKHY6IHVua25vd24pOiB2IGlzIERlc2t0b3BFcnJvciB7XHJcbiAgaWYgKCFpc1JlY29yZCh2KSkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICghRVJST1JfQ09ERVMuaW5jbHVkZXModi5jb2RlIGFzIG5ldmVyKSkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICh0eXBlb2Ygdi5tZXNzYWdlICE9PSAnc3RyaW5nJykgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICh0eXBlb2Ygdi5yZXRyeWFibGUgIT09ICdib29sZWFuJykgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICh2LnNlc3Npb25JZCAhPT0gdW5kZWZpbmVkICYmICFpc05vbkVtcHR5U3RyaW5nKHYuc2Vzc2lvbklkKSkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICh2LnJ1bklkICE9PSB1bmRlZmluZWQgJiYgIWlzTm9uRW1wdHlTdHJpbmcodi5ydW5JZCkpIHJldHVybiBmYWxzZTtcclxuICBpZiAodi5yZWNvdmVyeUFjdGlvbiAhPT0gdW5kZWZpbmVkICYmICFSRUNPVkVSWV9BQ1RJT05TLmluY2x1ZGVzKHYucmVjb3ZlcnlBY3Rpb24gYXMgbmV2ZXIpKSByZXR1cm4gZmFsc2U7XHJcbiAgcmV0dXJuIHRydWU7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpc1J1blN0YXR1cyh2OiB1bmtub3duKTogdiBpcyBSdW5TdGF0dXMge1xyXG4gIHJldHVybiB0eXBlb2YgdiA9PT0gJ3N0cmluZycgJiYgUlVOX1NUQVRVU0VTLmluY2x1ZGVzKHYgYXMgUnVuU3RhdHVzKTtcclxufVxyXG5cclxuLyoqIEhvc3QgXHU1RjE1XHU1QkZDXHU4ODRDKHN0ZG91dCBcdTdCMkNcdTRFMDBcdTg4NEMpXHUzMDAyICovXHJcbmV4cG9ydCBmdW5jdGlvbiBpc0hvc3RSZWFkeUxpbmUodjogdW5rbm93bik6IHYgaXMgeyBobWhEZXNrdG9wSG9zdFJlYWR5OiB0cnVlOyBwb3J0OiBudW1iZXI7IHZlcnNpb246IHN0cmluZyB9IHtcclxuICBpZiAoIWlzUmVjb3JkKHYpKSByZXR1cm4gZmFsc2U7XHJcbiAgaWYgKHYuaG1oRGVza3RvcEhvc3RSZWFkeSAhPT0gdHJ1ZSkgcmV0dXJuIGZhbHNlO1xyXG4gIGlmICh0eXBlb2Ygdi5wb3J0ICE9PSAnbnVtYmVyJyB8fCAhTnVtYmVyLmlzSW50ZWdlcih2LnBvcnQpIHx8IHYucG9ydCA8PSAwIHx8IHYucG9ydCA+IDY1NTM1KSByZXR1cm4gZmFsc2U7XHJcbiAgcmV0dXJuIGlzTm9uRW1wdHlTdHJpbmcodi52ZXJzaW9uKTtcclxufVxyXG4iLCAiLyoqXHJcbiAqIERlc2t0b3BIb3N0Q2xpZW50IFx1MjAxNCBcdTVCRjkgaG1oIGhvc3QgXHU3Njg0IEhUVFArU1NFIFx1NUJBMlx1NjIzN1x1N0FFRlx1MzAwMlxyXG4gKlxyXG4gKiAtIFx1NkJDRlx1NEUyQSBIVFRQIFx1OEJGN1x1NkM0Mlx1ODFFQVx1NTJBOFx1NUUyNiBYLUhtaC1LZXkodG9rZW4gXHU0RTBEXHU4RkRCIFVSTCk7XHJcbiAqIC0gXHU3RUQzXHU2Nzg0XHU1MzE2XHU5NTE5XHU4QkVGKHJlcy5ib2R5IFx1OTFDQ1x1NzY4NCBEZXNrdG9wRXJyb3IgXHU1RjYyXHU3MkI2XHU2MjE2IEhUVFAgXHU3MkI2XHU2MDAxKVx1ODlDNFx1N0VBNlx1NjIxMFx1NUYwMlx1NUUzOFx1NjI5Qlx1NTFGQTtcclxuICogLSBTU0UgXHU3NTI4IGZldGNoIFx1NkQ0MVx1NjI0Qlx1NTE5OVx1ODlFM1x1Njc5MChpZC9ldmVudC9kYXRhIFx1NUUyNyksXHU2NTJGXHU2MzAxIExhc3QtRXZlbnQtSUQgXHU4ODY1XHU2MkM5XHU5MUNEXHU4RkRFXHUzMDAyXHJcbiAqL1xyXG5pbXBvcnQgeyBkZXNrdG9wRXJyb3IsIGlzRGVza3RvcEVycm9yLCBpc0V2ZW50RW52ZWxvcGUsIHR5cGUgRGVza3RvcEVycm9yLCB0eXBlIEV2ZW50RW52ZWxvcGUgfSBmcm9tICdAaG1oLWRlc2t0b3AvY29udHJhY3RzJztcclxuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gJ25vZGU6Y3J5cHRvJztcclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgU3NlRnJhbWUge1xyXG4gIGlkPzogc3RyaW5nO1xyXG4gIGV2ZW50OiBzdHJpbmc7XHJcbiAgZGF0YTogc3RyaW5nO1xyXG59XHJcblxyXG4vKiogXHU4OUUzXHU2NzkwXHU0RTAwXHU2QkI1IFNTRSBcdTY1ODdcdTY3MkNcdTRFM0FcdTVFMjcoXHU0RTBEXHU1NDJCXHU4REU4IGNodW5rIFx1NzY4NFx1N0YxM1x1NTFCMlx1OTAzQlx1OEY5MSxcdTdFQUZcdTUxRkRcdTY1NzBcdTRGQkZcdTRFOEVcdTZENEJcdThCRDUpXHUzMDAyICovXHJcbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVNzZUNodW5rKGNodW5rOiBzdHJpbmcpOiBTc2VGcmFtZVtdIHtcclxuICBjb25zdCBmcmFtZXM6IFNzZUZyYW1lW10gPSBbXTtcclxuICBmb3IgKGNvbnN0IGJsb2NrIG9mIGNodW5rLnNwbGl0KC9cXG5cXG4vKSkge1xyXG4gICAgaWYgKCFibG9jay50cmltKCkpIGNvbnRpbnVlO1xyXG4gICAgbGV0IGlkOiBzdHJpbmcgfCB1bmRlZmluZWQ7XHJcbiAgICBsZXQgZXZlbnQgPSAnbWVzc2FnZSc7XHJcbiAgICBjb25zdCBkYXRhTGluZXM6IHN0cmluZ1tdID0gW107XHJcbiAgICBsZXQgc2F3RmllbGQgPSBmYWxzZTtcclxuICAgIGZvciAoY29uc3QgbGluZSBvZiBibG9jay5zcGxpdCgnXFxuJykpIHtcclxuICAgICAgaWYgKGxpbmUuc3RhcnRzV2l0aCgnOicpKSBjb250aW51ZTsgLy8gXHU2Q0U4XHU5MUNBL1x1NUZDM1x1OERGM1xyXG4gICAgICBpZiAobGluZS5zdGFydHNXaXRoKCdpZDonKSkgeyBpZCA9IGxpbmUuc2xpY2UoMykudHJpbSgpOyBzYXdGaWVsZCA9IHRydWU7IH1cclxuICAgICAgZWxzZSBpZiAobGluZS5zdGFydHNXaXRoKCdldmVudDonKSkgeyBldmVudCA9IGxpbmUuc2xpY2UoNikudHJpbSgpOyBzYXdGaWVsZCA9IHRydWU7IH1cclxuICAgICAgZWxzZSBpZiAobGluZS5zdGFydHNXaXRoKCdkYXRhOicpKSB7IGRhdGFMaW5lcy5wdXNoKGxpbmUuc2xpY2UoNSkucmVwbGFjZSgvXiAvLCAnJykpOyBzYXdGaWVsZCA9IHRydWU7IH1cclxuICAgIH1cclxuICAgIGlmICghc2F3RmllbGQpIGNvbnRpbnVlOyAvLyBcdTdFQUZcdTZDRThcdTkxQ0EvXHU1RkMzXHU4REYzXHU1NzU3XHU0RTBEXHU0RUE3XHU3NTFGXHU1RTI3XHJcbiAgICBmcmFtZXMucHVzaCh7IC4uLihpZCAhPT0gdW5kZWZpbmVkID8geyBpZCB9IDoge30pLCBldmVudCwgZGF0YTogZGF0YUxpbmVzLmpvaW4oJ1xcbicpIH0pO1xyXG4gIH1cclxuICByZXR1cm4gZnJhbWVzO1xyXG59XHJcblxyXG4vKiogXHU0RUNFIFNTRSBcdTVFMjdcdTY1NzBcdTYzNkVcdTRFMkRcdTg5RTNcdTUxRkFcdTU0MDhcdTZDRDUgRXZlbnRFbnZlbG9wZTtcdTRFMERcdTU0MDhcdTZDRDVcdTc2ODRcdThGRDRcdTU2REUgbnVsbChTQ0hFTUFfTUlTTUFUQ0ggXHU3NTMxXHU4QzAzXHU3NTI4XHU2NUI5XHU4QkExXHU2NTcwKVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gZW52ZWxvcGVGcm9tRnJhbWUoZnJhbWU6IFNzZUZyYW1lKTogRXZlbnRFbnZlbG9wZSB8IG51bGwge1xyXG4gIGlmIChmcmFtZS5ldmVudCAhPT0gJ2htaCcpIHJldHVybiBudWxsOyAvLyBcdTYyMTFcdTRFRUNcdTc2ODRcdTRFOEJcdTRFRjZcdTRGRTFcdTVDMDFcdTdFREZcdTRFMDBcdThENzAgZXZlbnQ6IGhtaFxyXG4gIHRyeSB7XHJcbiAgICBjb25zdCBwYXJzZWQ6IHVua25vd24gPSBKU09OLnBhcnNlKGZyYW1lLmRhdGEpO1xyXG4gICAgcmV0dXJuIGlzRXZlbnRFbnZlbG9wZShwYXJzZWQpID8gcGFyc2VkIDogbnVsbDtcclxuICB9IGNhdGNoIHtcclxuICAgIHJldHVybiBudWxsO1xyXG4gIH1cclxufVxyXG5cclxuZXhwb3J0IGNsYXNzIERlc2t0b3BIdHRwRXJyb3IgZXh0ZW5kcyBFcnJvciB7XHJcbiAgY29uc3RydWN0b3IocHVibGljIHJlYWRvbmx5IGRldGFpbDogRGVza3RvcEVycm9yKSB7XHJcbiAgICBzdXBlcihkZXRhaWwubWVzc2FnZSk7XHJcbiAgfVxyXG59XHJcblxyXG5leHBvcnQgY2xhc3MgRGVza3RvcEhvc3RDbGllbnQge1xyXG4gIGNvbnN0cnVjdG9yKFxyXG4gICAgcHJpdmF0ZSByZWFkb25seSBiYXNlVXJsOiBzdHJpbmcsXHJcbiAgICBwcml2YXRlIHJlYWRvbmx5IHRva2VuOiBzdHJpbmcsXHJcbiAgKSB7fVxyXG5cclxuICBwcml2YXRlIGhlYWRlcnMoZXh0cmE6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fSk6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4ge1xyXG4gICAgcmV0dXJuIHsgJ3gtaG1oLWtleSc6IHRoaXMudG9rZW4sIC4uLmV4dHJhIH07XHJcbiAgfVxyXG5cclxuICBhc3luYyBnZXRKc29uPFQ+KHBhdGg6IHN0cmluZywgdGltZW91dE1zID0gNV8wMDApOiBQcm9taXNlPFQ+IHtcclxuICAgIGxldCByZXM6IFJlc3BvbnNlO1xyXG4gICAgdHJ5IHtcclxuICAgICAgcmVzID0gYXdhaXQgZmV0Y2goYCR7dGhpcy5iYXNlVXJsfSR7cGF0aH1gLCB7IGhlYWRlcnM6IHRoaXMuaGVhZGVycygpLCBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQodGltZW91dE1zKSB9KTtcclxuICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYHJlcXVlc3QgZmFpbGVkOiAke1N0cmluZyhlcnIpLnNsaWNlKDAsIDE2MCl9YCwgeyByZXRyeWFibGU6IHRydWUsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gdGhpcy5wYXJzZVJlc3BvbnNlPFQ+KHJlcyk7XHJcbiAgfVxyXG5cclxuICAvKiogXHU2MkM5XHU1M0Q2XHU3RUFGXHU2NTg3XHU2NzJDXHU3QUVGXHU3MEI5KFx1NTk4MiAvYXBpL3Nlc3Npb25zLzppZC9leHBvcnQubWQpXHUzMDAyICovXHJcbiAgYXN5bmMgZ2V0VGV4dChwYXRoOiBzdHJpbmcsIHRpbWVvdXRNcyA9IDEwXzAwMCk6IFByb21pc2U8c3RyaW5nPiB7XHJcbiAgICBsZXQgcmVzOiBSZXNwb25zZTtcclxuICAgIHRyeSB7XHJcbiAgICAgIHJlcyA9IGF3YWl0IGZldGNoKGAke3RoaXMuYmFzZVVybH0ke3BhdGh9YCwgeyBoZWFkZXJzOiB0aGlzLmhlYWRlcnMoKSwgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KHRpbWVvdXRNcykgfSk7XHJcbiAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGByZXF1ZXN0IGZhaWxlZDogJHtTdHJpbmcoZXJyKS5zbGljZSgwLCAxNjApfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSB8fCByZXMuc3RhdHVzID09PSA0MDMpIHtcclxuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdBVVRIX0ZBSUxFRCcsIGBob3N0IHJlamVjdGVkIHRoZSBzZXNzaW9uIHRva2VuIChIVFRQICR7cmVzLnN0YXR1c30pYCwgeyByZXRyeWFibGU6IGZhbHNlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xyXG4gICAgfVxyXG4gICAgaWYgKCFyZXMub2spIHtcclxuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBIVFRQICR7cmVzLnN0YXR1c31gLCB7IHJldHJ5YWJsZTogcmVzLnN0YXR1cyA+PSA1MDAgfSkpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHJlcy50ZXh0KCk7XHJcbiAgfVxyXG5cclxuICAvKiogXHU2QkNGXHU0RTJBXHU1RTI2XHU1MjZGXHU0RjVDXHU3NTI4XHU3Njg0IFBPU1QgXHU4MUVBXHU1MkE4XHU2NDNBXHU1RTI2XHU1RTQyXHU3QjQ5XHU5NTJFKDAzIFx1MDBBN1x1NTZEQlx1OTYzMlx1OTFDRFx1NjUzRTpcdThCRjdcdTZDNDJcdTRGN0ZcdTc1MjggaWRlbXBvdGVuY3lLZXk7XHJcbiAgICogIHJ1bnRpbWUgXHU0RkE3XHU3N0VEXHU2NzFGXHU1MTdDXHU1QkI5XHU1RkZEXHU3NTY1LFx1NTM0Rlx1OEJBRVx1NTE0OFx1ODg0Q1x1MjAxNFx1MjAxNFx1OTFDRFx1OEJENVx1NTNFRlx1NTFFRFx1OTUyRVx1NTNCQlx1OTFDRCxcdTRFMERcdTc2RjJcdTc2RUVcdTkxQ0RcdTY1M0UpXHUzMDAyICovXHJcbiAgYXN5bmMgcG9zdEpzb248VD4ocGF0aDogc3RyaW5nLCBib2R5OiB1bmtub3duLCB0aW1lb3V0TXMgPSAxMF8wMDApOiBQcm9taXNlPFQ+IHtcclxuICAgIGxldCByZXM6IFJlc3BvbnNlO1xyXG4gICAgdHJ5IHtcclxuICAgICAgcmVzID0gYXdhaXQgZmV0Y2goYCR7dGhpcy5iYXNlVXJsfSR7cGF0aH1gLCB7XHJcbiAgICAgICAgbWV0aG9kOiAnUE9TVCcsXHJcbiAgICAgICAgaGVhZGVyczogdGhpcy5oZWFkZXJzKHtcclxuICAgICAgICAgICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsXHJcbiAgICAgICAgICAneC1pZGVtcG90ZW5jeS1rZXknOiByYW5kb21VVUlEKCksXHJcbiAgICAgICAgfSksXHJcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoYm9keSksXHJcbiAgICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KHRpbWVvdXRNcyksXHJcbiAgICAgIH0pO1xyXG4gICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgcmVxdWVzdCBmYWlsZWQ6ICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTYwKX1gLCB7IHJldHJ5YWJsZTogdHJ1ZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcclxuICAgIH1cclxuICAgIHJldHVybiB0aGlzLnBhcnNlUmVzcG9uc2U8VD4ocmVzKTtcclxuICB9XHJcblxyXG4gIHByaXZhdGUgYXN5bmMgcGFyc2VSZXNwb25zZTxUPihyZXM6IFJlc3BvbnNlKTogUHJvbWlzZTxUPiB7XHJcbiAgICBpZiAocmVzLnN0YXR1cyA9PT0gNDAxIHx8IHJlcy5zdGF0dXMgPT09IDQwMykge1xyXG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgYGhvc3QgcmVqZWN0ZWQgdGhlIHNlc3Npb24gdG9rZW4gKEhUVFAgJHtyZXMuc3RhdHVzfSlgLCB7IHJldHJ5YWJsZTogZmFsc2UsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XHJcbiAgICB9XHJcbiAgICBjb25zdCB0ZXh0ID0gYXdhaXQgcmVzLnRleHQoKTtcclxuICAgIGxldCBwYXJzZWQ6IHVua25vd24gPSBudWxsO1xyXG4gICAgdHJ5IHtcclxuICAgICAgcGFyc2VkID0gdGV4dCA/IEpTT04ucGFyc2UodGV4dCkgOiBudWxsO1xyXG4gICAgfSBjYXRjaCB7XHJcbiAgICAgIHBhcnNlZCA9IG51bGw7XHJcbiAgICB9XHJcbiAgICBpZiAoIXJlcy5vaykge1xyXG4gICAgICBpZiAoaXNEZXNrdG9wRXJyb3IocGFyc2VkKSkgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IocGFyc2VkKTtcclxuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBIVFRQICR7cmVzLnN0YXR1c306ICR7dGV4dC5zbGljZSgwLCAxNjApfWAsIHsgcmV0cnlhYmxlOiByZXMuc3RhdHVzID49IDUwMCB9KSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gcGFyc2VkIGFzIFQ7XHJcbiAgfVxyXG5cclxuICAvKipcclxuICAgKiBcdThCQTJcdTk2MDVcdTUxNjhcdTkwRTggU1NFIFx1NUUyNyhcdTU0MkJcdTk3NUVcdTRGRTFcdTVDMDFcdTRFOEJcdTRFRjY6ZGVsdGEvbGluZSBcdTdCNDlcdTlBRDhcdTk4OTFcdTZENDEpXHUzMDAyXHU0RkUxXHU1QzAxXHU3NTMxXHU4QzAzXHU3NTI4XHU2NUI5XHJcbiAgICogXHU3NTI4IGVudmVsb3BlRnJvbUZyYW1lIFx1ODFFQVx1ODg0Q1x1NTIwNlx1NkQ0MTtcdTY1QURcdTdFQkZcdTkxQ0RcdThGREVcdThCRURcdTRFNDlcdTU0MEMgZXZlbnRzKClcdTMwMDJcclxuICAgKi9cclxuICBhc3luYyAqcmF3RXZlbnRzKGxhc3RFdmVudElkPzogc3RyaW5nLCBzaWduYWw/OiBBYm9ydFNpZ25hbCk6IEFzeW5jR2VuZXJhdG9yPFNzZUZyYW1lPiB7XHJcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgJHt0aGlzLmJhc2VVcmx9L2FwaS9ldmVudHNgLCB7XHJcbiAgICAgIGhlYWRlcnM6IHRoaXMuaGVhZGVycyh7XHJcbiAgICAgICAgYWNjZXB0OiAndGV4dC9ldmVudC1zdHJlYW0nLFxyXG4gICAgICAgIC4uLihsYXN0RXZlbnRJZCAhPT0gdW5kZWZpbmVkID8geyAnbGFzdC1ldmVudC1pZCc6IGxhc3RFdmVudElkIH0gOiB7fSksXHJcbiAgICAgIH0pLFxyXG4gICAgICAuLi4oc2lnbmFsICE9PSB1bmRlZmluZWQgPyB7IHNpZ25hbCB9IDoge30pLFxyXG4gICAgfSk7XHJcbiAgICBpZiAocmVzLnN0YXR1cyA9PT0gNDAxIHx8IHJlcy5zdGF0dXMgPT09IDQwMykge1xyXG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgYGhvc3QgcmVqZWN0ZWQgdGhlIHNlc3Npb24gdG9rZW4gKEhUVFAgJHtyZXMuc3RhdHVzfSlgLCB7IHJldHJ5YWJsZTogZmFsc2UsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XHJcbiAgICB9XHJcbiAgICBpZiAoIXJlcy5vayB8fCByZXMuYm9keSA9PT0gbnVsbCkge1xyXG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYFNTRSBIVFRQICR7cmVzLnN0YXR1c31gLCB7IHJldHJ5YWJsZTogdHJ1ZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcclxuICAgIH1cclxuICAgIGNvbnN0IHJlYWRlciA9IHJlcy5ib2R5LmdldFJlYWRlcigpO1xyXG4gICAgY29uc3QgZGVjb2RlciA9IG5ldyBUZXh0RGVjb2RlcigpO1xyXG4gICAgbGV0IGJ1ZmZlciA9ICcnO1xyXG4gICAgZm9yICg7Oykge1xyXG4gICAgICBjb25zdCB7IGRvbmUsIHZhbHVlIH0gPSBhd2FpdCByZWFkZXIucmVhZCgpO1xyXG4gICAgICBpZiAoZG9uZSkgcmV0dXJuO1xyXG4gICAgICBidWZmZXIgKz0gZGVjb2Rlci5kZWNvZGUodmFsdWUsIHsgc3RyZWFtOiB0cnVlIH0pO1xyXG4gICAgICBsZXQgaWR4OiBudW1iZXI7XHJcbiAgICAgIHdoaWxlICgoaWR4ID0gYnVmZmVyLmluZGV4T2YoJ1xcblxcbicpKSAhPT0gLTEpIHtcclxuICAgICAgICBjb25zdCBibG9jayA9IGJ1ZmZlci5zbGljZSgwLCBpZHgpO1xyXG4gICAgICAgIGJ1ZmZlciA9IGJ1ZmZlci5zbGljZShpZHggKyAyKTtcclxuICAgICAgICBmb3IgKGNvbnN0IGZyYW1lIG9mIHBhcnNlU3NlQ2h1bmsoYmxvY2spKSB5aWVsZCBmcmFtZTtcclxuICAgICAgfVxyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgLyoqXHJcbiAgICogXHU4QkEyXHU5NjA1IFNTRSBcdTRFOEJcdTRFRjZcdTZENDEoYXN5bmMgaXRlcmF0b3IpXHUzMDAyXHU2NUFEXHU3RUJGXHU3NTMxXHU4QzAzXHU3NTI4XHU2NUI5XHU5MUNEXHU4RkRFO1x1OTFDRFx1OEZERVx1NjVGNlx1NjI4QVx1NjcwMFx1NTQwRVxyXG4gICAqIFx1NjUzNlx1NTIzMFx1NzY4NCBldmVudElkIFx1NEYyMFx1NTE2NSBsYXN0RXZlbnRJZCxob3N0IFx1N0FFRlx1NEVDRVx1OTFDRFx1NjUzRVx1NzNBRlx1ODg2NVx1NTNEMVx1MzAwMlxyXG4gICAqL1xyXG4gIGFzeW5jICpldmVudHMobGFzdEV2ZW50SWQ/OiBzdHJpbmcsIHNpZ25hbD86IEFib3J0U2lnbmFsKTogQXN5bmNHZW5lcmF0b3I8RXZlbnRFbnZlbG9wZT4ge1xyXG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYCR7dGhpcy5iYXNlVXJsfS9hcGkvZXZlbnRzYCwge1xyXG4gICAgICBoZWFkZXJzOiB0aGlzLmhlYWRlcnMoe1xyXG4gICAgICAgIGFjY2VwdDogJ3RleHQvZXZlbnQtc3RyZWFtJyxcclxuICAgICAgICAuLi4obGFzdEV2ZW50SWQgIT09IHVuZGVmaW5lZCA/IHsgJ2xhc3QtZXZlbnQtaWQnOiBsYXN0RXZlbnRJZCB9IDoge30pLFxyXG4gICAgICB9KSxcclxuICAgICAgLi4uKHNpZ25hbCAhPT0gdW5kZWZpbmVkID8geyBzaWduYWwgfSA6IHt9KSxcclxuICAgIH0pO1xyXG4gICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSB8fCByZXMuc3RhdHVzID09PSA0MDMpIHtcclxuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdBVVRIX0ZBSUxFRCcsIGBob3N0IHJlamVjdGVkIHRoZSBzZXNzaW9uIHRva2VuIChIVFRQICR7cmVzLnN0YXR1c30pYCwgeyByZXRyeWFibGU6IGZhbHNlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xyXG4gICAgfVxyXG4gICAgaWYgKCFyZXMub2sgfHwgIXJlcy5ib2R5KSB7XHJcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgU1NFIEhUVFAgJHtyZXMuc3RhdHVzfWAsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgcmVhZGVyID0gcmVzLmJvZHkuZ2V0UmVhZGVyKCk7XHJcbiAgICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKCk7XHJcbiAgICBsZXQgYnVmZmVyID0gJyc7XHJcbiAgICBmb3IgKDs7KSB7XHJcbiAgICAgIGNvbnN0IHsgZG9uZSwgdmFsdWUgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XHJcbiAgICAgIGlmIChkb25lKSByZXR1cm47XHJcbiAgICAgIGJ1ZmZlciArPSBkZWNvZGVyLmRlY29kZSh2YWx1ZSwgeyBzdHJlYW06IHRydWUgfSk7XHJcbiAgICAgIC8vIFx1NEVFNVx1N0E3QVx1ODg0Q1x1NTIwNlx1NUUyNztcdTRGRERcdTc1NTlcdTRFMERcdTVCOENcdTY1NzRcdTc2ODRcdTVDM0VcdTkwRThcclxuICAgICAgbGV0IGlkeDogbnVtYmVyO1xyXG4gICAgICB3aGlsZSAoKGlkeCA9IGJ1ZmZlci5pbmRleE9mKCdcXG5cXG4nKSkgIT09IC0xKSB7XHJcbiAgICAgICAgY29uc3QgYmxvY2sgPSBidWZmZXIuc2xpY2UoMCwgaWR4KTtcclxuICAgICAgICBidWZmZXIgPSBidWZmZXIuc2xpY2UoaWR4ICsgMik7XHJcbiAgICAgICAgZm9yIChjb25zdCBmcmFtZSBvZiBwYXJzZVNzZUNodW5rKGJsb2NrKSkge1xyXG4gICAgICAgICAgY29uc3QgZW52ID0gZW52ZWxvcGVGcm9tRnJhbWUoZnJhbWUpO1xyXG4gICAgICAgICAgaWYgKGVudiAhPT0gbnVsbCkgeWllbGQgZW52O1xyXG4gICAgICAgIH1cclxuICAgICAgfVxyXG4gICAgfVxyXG4gIH1cclxufVxyXG4iLCAiLyoqXHJcbiAqIGZha2UgaG9zdCBcdTIwMTQgaG1oYXJuZXNzIHJ1bnRpbWUgXHU3Njg0XHU2RDRCXHU4QkQ1XHU2NkZGXHU4RUFCKE1hc3RlclByb21wdCBcdTk2MzZcdTZCQjUgRC9FOlxyXG4gKiBcIlx1NTE0OFx1NEY3Rlx1NzUyOCBmYWtlIGhvc3QgXHU3RjE2XHU1MTk5XHU3MkI2XHU2MDAxXHU2NzNBXHU2RDRCXHU4QkQ1LFx1NTE4RFx1NjNBNVx1NzcxRlx1NUI5RSBBUElcIjtcdTk2MzZcdTZCQjUgRSBcdTc2ODRcdTRGMUFcdThCRERcdTdFQjVcdTUyMDdcdTcyNDdcclxuICogZTJlIFx1NEU1Rlx1NTE0OFx1NTcyOCBmYWtlIFx1NUM0Mlx1OTVFRFx1NzNBRilcdTMwMDJcclxuICpcclxuICogXHU2ODRDXHU5NzYyIGhvc3QgXHU1NDA4XHU1NDBDOlxyXG4gKiAgLSBcdTUzRUFcdTdFRDEgMTI3LjAuMC4xLFx1N0FFRlx1NTNFMyBPUyBcdTUyMDZcdTkxNEQsXHU1QjlFXHU5NjQ1XHU3QUVGXHU1M0UzXHU1MTk5IHN0ZG91dCBcdTVGMTVcdTVCRkNcdTg4NEM7XHJcbiAqICAtIFx1NjI0MFx1NjcwOSAvYXBpLyogXHU4OTgxXHU2QzQyIFgtSG1oLUtleSA9PT0gSE1IX0RFU0tUT1BfVE9LRU4sXHU1NDI2XHU1MjE5IDQwMSArIERlc2t0b3BFcnJvcjtcclxuICogIC0gR0VUIC9hcGkvc3RhdGUgXHU1MDY1XHU1RUI3XHU2M0EyXHU2RDRCO0dFVCAvYXBpL2V2ZW50cyBTU0UoZXZlbnQ6IGhtaCBcdTRGRTFcdTVDMDFcdTZENDEgKyBcdTkxQ0RcdTY1M0VcdTczQUYpO1xyXG4gKiAgLSBQT1NUIC9hcGkvZGVza3RvcC9zaHV0ZG93biBcdTRGMThcdTk2QzVcdTkwMDBcdTUxRkFcdTMwMDJcclxuICpcclxuICogXHU5NjM2XHU2QkI1IEUgXHU2QTIxXHU2MkRGXHU5NzYyKFx1NEUwRSBobWhhcm5lc3MgZGVza3RvcCBcdTZBMjFcdTVGMEZcdTU0MENcdTVGNjIpOlxyXG4gKiAgLSBQT1NUIC9hcGkvdGFzayB7dGV4dCwgc2Vzc2lvbklkLCBtb2RlfTpcdTYzOTJcdTk2MUZcdTVFNzZcdTYzMDlcdTgxMUFcdTY3MkNcdTUzRDFcclxuICogICAgcnVuLnN0YXJ0ZWQgXHUyMTkyIHRvb2wuc3RhcnRlZC9jb21wbGV0ZWQgXHUyMTkyKG1vZGU9PT0nYXNrJyBcdTY1RjYpXHJcbiAqICAgIGFwcHJvdmFsLnJlcXVpcmVkKFx1N0I0OSAvYXBpL2FwcHJvdmUpXHUyMTkyIHJ1bi5jb21wbGV0ZWQ7XHJcbiAqICAtIFBPU1QgL2FwaS9hcHByb3ZlIHtncmFudGVkLCBzZXNzaW9uSWR9O1xyXG4gKiAgLSBQT1NUIC9hcGkvaW50ZXJydXB0IHtzZXNzaW9uSWR9O1xyXG4gKiAgLSBHRVQgL2FwaS9zZXNzaW9uc1x1MzAwMlxyXG4gKlxyXG4gKiBcdTZENEJcdThCRDVcdTk0QTlcdTVCNTA6RkFLRV9IT1NUX0RJRV9BRlRFUl9NUyAvIEZBS0VfSE9TVF9ESUVfQVRfQk9PVCAvXHJcbiAqIEZBS0VfSE9TVF9FWFBFQ1RfVE9LRU4gLyBGQUtFX0hPU1RfVEFTS19ERUxBWV9NUyAvIEZBS0VfSE9TVF9UQVNLX0ZBSUw9MVxyXG4gKiAoXHU0RUZCXHU1MkExXHU0RUU1IHJ1bi5mYWlsZWQgXHU3RUQzXHU2NzVGLFx1Njc4NFx1OTAyMFx1OTUxOVx1OEJFRlx1NjA2Mlx1NTkwRFx1NTczQVx1NjY2RilcdTMwMDJcclxuICovXHJcbmltcG9ydCB7IGNyZWF0ZVNlcnZlciwgdHlwZSBTZXJ2ZXJSZXNwb25zZSB9IGZyb20gJ25vZGU6aHR0cCc7XHJcbmltcG9ydCB7IHJhbmRvbVVVSUQgfSBmcm9tICdub2RlOmNyeXB0byc7XHJcbmltcG9ydCB7IHBhdGhUb0ZpbGVVUkwgfSBmcm9tICdub2RlOnVybCc7XHJcbmltcG9ydCB7IHJlYWxwYXRoU3luYyB9IGZyb20gJ25vZGU6ZnMnO1xyXG5pbXBvcnQgeyBFVkVOVF9TQ0hFTUFfVkVSU0lPTiwgZGVza3RvcEVycm9yLCB0eXBlIEV2ZW50RW52ZWxvcGUsIHR5cGUgRXZlbnRLaW5kIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyc7XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIEZha2VIb3N0SGFuZGxlIHtcclxuICBwb3J0OiBudW1iZXI7XHJcbiAgZW1pdChzZXNzaW9uSWQ6IHN0cmluZywgcnVuSWQ6IHN0cmluZywga2luZDogRXZlbnRLaW5kLCBwYXlsb2FkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IG51bWJlcjtcclxuICBjbG9zZSgpOiBQcm9taXNlPHZvaWQ+O1xyXG59XHJcblxyXG5pbnRlcmZhY2UgRmFrZVNlc3Npb24ge1xyXG4gIGlkOiBzdHJpbmc7XHJcbiAgY3JlYXRlZEF0OiBzdHJpbmc7XHJcbiAgdXBkYXRlZEF0OiBzdHJpbmc7XHJcbn1cclxuXHJcbmludGVyZmFjZSBQZW5kaW5nQXBwcm92YWwge1xyXG4gIHNlc3Npb25JZDogc3RyaW5nO1xyXG4gIGFwcHJvdmFsSWQ6IHN0cmluZztcclxuICByZXNvbHZlKGdyYW50ZWQ6IGJvb2xlYW4pOiB2b2lkO1xyXG59XHJcblxyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc3RhcnRGYWtlSG9zdChvcHRzOiB7IHRva2VuOiBzdHJpbmc7IHF1aWV0PzogYm9vbGVhbiB9KTogUHJvbWlzZTxGYWtlSG9zdEhhbmRsZT4ge1xyXG4gIGNvbnN0IHRva2VuID0gb3B0cy50b2tlbjtcclxuICAvLyBcdTZENEJcdThCRDVcdTk0QTlcdTVCNTA6RkFLRV9IT1NUX0VYUEVDVF9UT0tFTiBcdThCQTkgaG9zdCBcdTY4MjFcdTlBOENcdTRFMDBcdTRFMkFcdTRFMEUgSE1IX0RFU0tUT1BfVE9LRU5cclxuICAvLyBcdTRFMERcdTU0MENcdTc2ODRcdTUwM0MoXHU2Nzg0XHU5MDIwIEFVVEhfRkFJTEVEIFx1NTczQVx1NjY2RjtzdXBlcnZpc29yIFx1NjAzQlx1NjYyRlx1ODk4Nlx1NzZENiBITUhfREVTS1RPUF9UT0tFTilcclxuICBjb25zdCBleHBlY3RlZCA9IHByb2Nlc3MuZW52LkZBS0VfSE9TVF9FWFBFQ1RfVE9LRU4gPz8gdG9rZW47XHJcbiAgY29uc3QgdGFza0RlbGF5ID0gTnVtYmVyKHByb2Nlc3MuZW52LkZBS0VfSE9TVF9UQVNLX0RFTEFZX01TID8/IDMwKTtcclxuICBjb25zdCBmYWlsVGFza3MgPSBwcm9jZXNzLmVudi5GQUtFX0hPU1RfVEFTS19GQUlMID09PSAnMSc7XHJcblxyXG4gIGNvbnN0IHNzZUNsaWVudHMgPSBuZXcgU2V0PFNlcnZlclJlc3BvbnNlPigpO1xyXG4gIGNvbnN0IHNlcUJ5UnVuID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcclxuICAvLyBcdTkxQ0RcdTY1M0VcdTczQUY6XHU2NzAwXHU4RkQxIDIwMCBcdTVFMjcoTGFzdC1FdmVudC1JRCBcdTY1QURcdTdFQkZcdTg4NjVcdTYyQzkpLFx1NEUwRSBobWhhcm5lc3Mgd2ViIFx1NTQwQ1x1NkIzRVx1OEJFRFx1NEU0OVxyXG4gIGNvbnN0IHJpbmc6IEFycmF5PHsgaWQ6IG51bWJlcjsgZXZlbnQ6IHN0cmluZzsgZGF0YTogdW5rbm93biB9PiA9IFtdO1xyXG4gIGxldCByaW5nU2VxID0gMDtcclxuICBjb25zdCBzZXNzaW9ucyA9IG5ldyBNYXA8c3RyaW5nLCBGYWtlU2Vzc2lvbj4oKTtcclxuICBsZXQgcGVuZGluZzogUGVuZGluZ0FwcHJvdmFsIHwgbnVsbCA9IG51bGw7XHJcbiAgY29uc3QgcnVuVGltZXJzID0gbmV3IE1hcDxzdHJpbmcsIE5vZGVKUy5UaW1lb3V0PigpO1xyXG4gIC8vIFx1NURFNVx1NEY1Q1x1NTMzQS9Qcm92aWRlciBcdTcyQjZcdTYwMDEoXHU0RTBFIGhtaGFybmVzcyBcdTU0MENcdTVGNjJcdTc2ODRcdTY3MDBcdTVDMEZcdTZBMjFcdTYyREYpXHJcbiAgY29uc3QgZmFrZVdvcmtzcGFjZXMgPSB7XHJcbiAgICBjdXJyZW50OiAnd3MtZGVtbycsXHJcbiAgICBpdGVtczogW1xyXG4gICAgICB7IGlkOiAnd3MtZGVtbycsIG5hbWU6ICdkZW1vLXdvcmtzcGFjZScsIHBhdGg6ICdDOlxcXFxkZW1vJyB9LFxyXG4gICAgXSxcclxuICB9O1xyXG4gIGNvbnN0IGZha2VQcm92aWRlcnMgPSBuZXcgTWFwPHN0cmluZywgeyBiYXNlVXJsOiBzdHJpbmc7IG1vZGVsOiBzdHJpbmc7IGFwaUtleTogc3RyaW5nIH0+KFtcclxuICAgIFsnZGVtbycsIHsgYmFzZVVybDogJ2h0dHA6Ly8xMjcuMC4wLjE6OS92MScsIG1vZGVsOiAnZmFrZS1tJywgYXBpS2V5OiAnc2stZGVtby0xMjM0JyB9XSxcclxuICAgIFsnZGVtby12aXNpb24nLCB7IGJhc2VVcmw6ICdodHRwOi8vMTI3LjAuMC4xOjkvdjEnLCBtb2RlbDogJ2Zha2UtbS12aXNpb24nLCBhcGlLZXk6ICdzay1kZW1vLTU2NzgnIH1dLFxyXG4gIF0pO1xyXG4gIGxldCBmYWtlQ2hhdFByb3ZpZGVyID0gJ2RlbW8nO1xyXG5cclxuICBjb25zdCBlbWl0ID0gKHNlc3Npb25JZDogc3RyaW5nLCBydW5JZDogc3RyaW5nLCBraW5kOiBFdmVudEtpbmQsIHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogbnVtYmVyID0+IHtcclxuICAgIGNvbnN0IGtleSA9IGAke3Nlc3Npb25JZH1cXDAke3J1bklkfWA7XHJcbiAgICBjb25zdCBzZXEgPSAoc2VxQnlSdW4uZ2V0KGtleSkgPz8gMCkgKyAxO1xyXG4gICAgc2VxQnlSdW4uc2V0KGtleSwgc2VxKTtcclxuICAgIGNvbnN0IGVudjogRXZlbnRFbnZlbG9wZSA9IHtcclxuICAgICAgc2NoZW1hVmVyc2lvbjogRVZFTlRfU0NIRU1BX1ZFUlNJT04sXHJcbiAgICAgIGV2ZW50SWQ6IHJhbmRvbVVVSUQoKSxcclxuICAgICAgc2Vzc2lvbklkLFxyXG4gICAgICBydW5JZCxcclxuICAgICAgc2VxLFxyXG4gICAgICBvY2N1cnJlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXHJcbiAgICAgIGtpbmQsXHJcbiAgICAgIHBheWxvYWQsXHJcbiAgICB9O1xyXG4gICAgY29uc3QgaWQgPSArK3JpbmdTZXE7XHJcbiAgICByaW5nLnB1c2goeyBpZCwgZXZlbnQ6ICdobWgnLCBkYXRhOiBlbnYgfSk7XHJcbiAgICBpZiAocmluZy5sZW5ndGggPiAyMDApIHJpbmcuc3BsaWNlKDAsIHJpbmcubGVuZ3RoIC0gMjAwKTtcclxuICAgIGZvciAoY29uc3QgYyBvZiBzc2VDbGllbnRzKSB7XHJcbiAgICAgIGMud3JpdGUoYGlkOiAke2lkfVxcbmV2ZW50OiBobWhcXG5kYXRhOiAke0pTT04uc3RyaW5naWZ5KGVudil9XFxuXFxuYCk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gc2VxO1xyXG4gIH07XHJcblxyXG4gIGNvbnN0IHRvdWNoID0gKHNlc3Npb25JZDogc3RyaW5nKTogRmFrZVNlc3Npb24gPT4ge1xyXG4gICAgbGV0IHMgPSBzZXNzaW9ucy5nZXQoc2Vzc2lvbklkKTtcclxuICAgIGlmIChzID09PSB1bmRlZmluZWQpIHtcclxuICAgICAgcyA9IHsgaWQ6IHNlc3Npb25JZCwgY3JlYXRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksIHVwZGF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpIH07XHJcbiAgICAgIHNlc3Npb25zLnNldChzZXNzaW9uSWQsIHMpO1xyXG4gICAgfVxyXG4gICAgcy51cGRhdGVkQXQgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XHJcbiAgICByZXR1cm4gcztcclxuICB9O1xyXG5cclxuICAvKiogXHU2QTIxXHU2MkRGXHU0RTAwXHU2QjIxXHU0RUZCXHU1MkExOlx1NjI3OVx1NTFDNlx1NkEyMVx1NUYwRlx1NjMwMlx1OEQ3N1x1N0I0OVx1NUY4NSAvYXBpL2FwcHJvdmVcdTMwMDIgKi9cclxuICBjb25zdCBydW5UYXNrID0gKHNlc3Npb25JZDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcsIG1vZGU6IHN0cmluZyk6IHN0cmluZyA9PiB7XHJcbiAgICBjb25zdCBydW5JZCA9IGBydW4tJHtEYXRlLm5vdygpLnRvU3RyaW5nKDM2KX0tJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCA4KX1gO1xyXG4gICAgdG91Y2goc2Vzc2lvbklkKTtcclxuICAgIGNvbnN0IHN0ZXBzOiBBcnJheTwoKSA9PiB2b2lkPiA9IFtdO1xyXG4gICAgY29uc3Qgd2FpdCA9IChmbjogKCkgPT4gdm9pZCwgbXMgPSB0YXNrRGVsYXkpOiB2b2lkID0+IHtcclxuICAgICAgY29uc3QgdCA9IHNldFRpbWVvdXQoZm4sIG1zKTtcclxuICAgICAgcnVuVGltZXJzLnNldChgJHtzZXNzaW9uSWR9XFwwJHtydW5JZH1gLCB0KTtcclxuICAgIH07XHJcbiAgICBjb25zdCBjaGFpbiA9IChmbnM6IEFycmF5PCgpID0+IHZvaWQ+KTogdm9pZCA9PiB7XHJcbiAgICAgIGNvbnN0IFtmaXJzdCwgLi4ucmVzdF0gPSBmbnM7XHJcbiAgICAgIGlmIChmaXJzdCA9PT0gdW5kZWZpbmVkKSByZXR1cm47XHJcbiAgICAgIHdhaXQoKCkgPT4ge1xyXG4gICAgICAgIGZpcnN0KCk7XHJcbiAgICAgICAgY2hhaW4ocmVzdCk7XHJcbiAgICAgIH0pO1xyXG4gICAgfTtcclxuXHJcbiAgICBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICdydW4uc3RhcnRlZCcsIHsgdGFzazogdGV4dCwgbW9kZSB9KTtcclxuICAgIGlmIChmYWlsVGFza3MpIHtcclxuICAgICAgd2FpdCgoKSA9PiBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICdydW4uZmFpbGVkJywge1xyXG4gICAgICAgIGVycm9yOiB7IGNvZGU6ICdBVVRIX0ZBSUxFRCcsIG1lc3NhZ2U6ICdzaW11bGF0ZWQgcHJvdmlkZXIgYXV0aCBmYWlsdXJlJywgcmV0cnlhYmxlOiBmYWxzZSB9LFxyXG4gICAgICB9KSk7XHJcbiAgICAgIHJldHVybiBydW5JZDtcclxuICAgIH1cclxuXHJcbiAgICBjb25zdCBmaW5pc2hSdW4gPSAoYW5zd2VyOiBzdHJpbmcsIHRvb2xVc2VzOiBudW1iZXIpOiB2b2lkID0+IHtcclxuICAgICAgcnVuVGltZXJzLmRlbGV0ZShgJHtzZXNzaW9uSWR9XFwwJHtydW5JZH1gKTtcclxuICAgICAgLy8gXHU0RUE0XHU0RUQ4XHU3MjY5XHU1MTQ4XHU0RThFXHU3RUM4XHU2MDAxKFx1NEUwRSBobWhhcm5lc3MgZGVza3RvcCBcdTY4NjVcdTU0MENcdTVFOEY6YXJ0aWZhY3QuY3JlYXRlZCBcdTIxOTIgcnVuLmNvbXBsZXRlZClcclxuICAgICAgZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAnYXJ0aWZhY3QuY3JlYXRlZCcsIHtcclxuICAgICAgICBhcnRpZmFjdDogeyByZWxQYXRoOiAnb3V0LnR4dCcsIGtpbmQ6ICdmaWxlJywgdGl0bGU6ICdvdXQudHh0JyB9LFxyXG4gICAgICB9KTtcclxuICAgICAgZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAncnVuLmNvbXBsZXRlZCcsIHsgdGV4dDogYW5zd2VyLCB0dXJuczogMSwgdG9vbFVzZXMgfSk7XHJcbiAgICB9O1xyXG5cclxuICAgIGNvbnN0IHNjcmlwdGVkOiBBcnJheTwoKSA9PiB2b2lkPiA9IFtcclxuICAgICAgKCkgPT4gZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAndG9vbC5zdGFydGVkJywgeyBuYW1lOiAncmVhZF9maWxlJywgYXJnc1ByZXZpZXc6ICd7XCJwYXRoXCI6XCJSRUFETUUubWRcIn0nIH0pLFxyXG4gICAgICAoKSA9PiBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICd0b29sLmNvbXBsZXRlZCcsIHsgbmFtZTogJ3JlYWRfZmlsZScsIGlzRXJyb3I6IGZhbHNlLCBvdXRwdXRQcmV2aWV3OiAnIyBkZW1vJyB9KSxcclxuICAgIF07XHJcblxyXG4gICAgaWYgKG1vZGUgPT09ICdhc2snKSB7XHJcbiAgICAgIHNjcmlwdGVkLnB1c2goKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IGFwcHJvdmFsSWQgPSBgYXAtJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCA4KX1gO1xyXG4gICAgICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ2FwcHJvdmFsLnJlcXVpcmVkJywge1xyXG4gICAgICAgICAgYXBwcm92YWxJZCxcclxuICAgICAgICAgIHRvb2w6ICd3cml0ZV9maWxlJyxcclxuICAgICAgICAgIGFyZ3NQcmV2aWV3OiAne1wicGF0aFwiOlwib3V0LnR4dFwiLFwiY29udGVudFwiOlwiaGlcIn0nLFxyXG4gICAgICAgICAgcmlzazogJ1x1NTE5OVx1NTE2NVx1NURFNVx1NEY1Q1x1NTMzQVx1NjU4N1x1NEVGNiBvdXQudHh0KFx1NkEyMVx1NjJERiknLFxyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHBlbmRpbmcgPSB7XHJcbiAgICAgICAgICBzZXNzaW9uSWQsXHJcbiAgICAgICAgICBhcHByb3ZhbElkLFxyXG4gICAgICAgICAgcmVzb2x2ZTogKGdyYW50ZWQpID0+IHtcclxuICAgICAgICAgICAgcGVuZGluZyA9IG51bGw7XHJcbiAgICAgICAgICAgIGlmIChncmFudGVkKSB7XHJcbiAgICAgICAgICAgICAgZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAndG9vbC5zdGFydGVkJywgeyBuYW1lOiAnd3JpdGVfZmlsZScsIGFyZ3NQcmV2aWV3OiAne1wicGF0aFwiOlwib3V0LnR4dFwifScgfSk7XHJcbiAgICAgICAgICAgICAgd2FpdCgoKSA9PiBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICd0b29sLmNvbXBsZXRlZCcsIHsgbmFtZTogJ3dyaXRlX2ZpbGUnLCBpc0Vycm9yOiBmYWxzZSwgb3V0cHV0UHJldmlldzogJ3dyb3RlIDIgYnl0ZXMnIH0pKTtcclxuICAgICAgICAgICAgICB3YWl0KCgpID0+IGZpbmlzaFJ1bihgZWNobzogJHt0ZXh0fShcdTVERjJcdTYyNjdcdTg4NENcdTUxOTlcdTUxNjUpYCwgMyksIHRhc2tEZWxheSAqIDIpO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgIGZpbmlzaFJ1bihgZWNobzogJHt0ZXh0fShcdTVCQTFcdTYyNzlcdTg4QUJcdTYyRDJcdTdFREQsXHU2NzJBXHU2MjY3XHU4ODRDXHU1MTk5XHU1MTY1KWAsIDEpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICB9LFxyXG4gICAgICAgIH07XHJcbiAgICAgIH0pO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgc2NyaXB0ZWQucHVzaCgoKSA9PiBmaW5pc2hSdW4oYGVjaG86ICR7dGV4dH1gLCAxKSk7XHJcbiAgICB9XHJcbiAgICBjaGFpbihzY3JpcHRlZCk7XHJcbiAgICByZXR1cm4gcnVuSWQ7XHJcbiAgfTtcclxuXHJcbiAgY29uc3Qgc2VydmVyID0gY3JlYXRlU2VydmVyKChyZXEsIHJlcykgPT4ge1xyXG4gICAgY29uc3QgdXJsID0gbmV3IFVSTChyZXEudXJsID8/ICcvJywgJ2h0dHA6Ly8xMjcuMC4wLjEnKTtcclxuICAgIGNvbnN0IGF1dGhvcml6ZWQgPSByZXEuaGVhZGVyc1sneC1obWgta2V5J10gPT09IGV4cGVjdGVkO1xyXG4gICAgY29uc3QgZGVueSA9ICgpOiB2b2lkID0+IHtcclxuICAgICAgcmVzLndyaXRlSGVhZCg0MDEsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgJ21pc3Npbmcgb3IgaW52YWxpZCB4LWhtaC1rZXknLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcclxuICAgIH07XHJcblxyXG4gICAgY29uc3QgcmVhZEJvZHkgPSAoKTogUHJvbWlzZTxzdHJpbmc+ID0+XHJcbiAgICAgIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XHJcbiAgICAgICAgbGV0IGIgPSAnJztcclxuICAgICAgICByZXEub24oJ2RhdGEnLCAoYzogQnVmZmVyKSA9PiB7IGIgKz0gYy50b1N0cmluZygpOyB9KTtcclxuICAgICAgICByZXEub24oJ2VuZCcsICgpID0+IHJlc29sdmUoYikpO1xyXG4gICAgICB9KTtcclxuXHJcbiAgICBpZiAodXJsLnBhdGhuYW1lID09PSAnL2FwaS9ldmVudHMnKSB7XHJcbiAgICAgIGlmICghYXV0aG9yaXplZCkgeyBkZW55KCk7IHJldHVybjsgfVxyXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ3RleHQvZXZlbnQtc3RyZWFtJywgJ2NhY2hlLWNvbnRyb2wnOiAnbm8tY2FjaGUnLCBjb25uZWN0aW9uOiAna2VlcC1hbGl2ZScgfSk7XHJcbiAgICAgIHJlcy5mbHVzaEhlYWRlcnM/LigpO1xyXG4gICAgICBzc2VDbGllbnRzLmFkZChyZXMpO1xyXG4gICAgICAvLyBcdTY1QURcdTdFQkZcdTg4NjVcdTYyQzk6TGFzdC1FdmVudC1JRCBcdTRFNEJcdTUyNERcdTc2ODRcdTVFMjdcdTVERjJcdTU3MjhcdTVCQTJcdTYyMzdcdTdBRUYsXHU5MUNEXHU1M0QxXHU1MTc2XHU1NDBFXHU3Njg0XHU3M0FGXHU1RjYyXHU3RjEzXHU1MUIyXHJcbiAgICAgIGNvbnN0IGxhc3RJZCA9IE51bWJlcihyZXEuaGVhZGVyc1snbGFzdC1ldmVudC1pZCddID8/IDApO1xyXG4gICAgICBpZiAoTnVtYmVyLmlzRmluaXRlKGxhc3RJZCkgJiYgbGFzdElkID4gMCkge1xyXG4gICAgICAgIGZvciAoY29uc3QgZSBvZiByaW5nKSB7XHJcbiAgICAgICAgICBpZiAoZS5pZCA+IGxhc3RJZCkgcmVzLndyaXRlKGBpZDogJHtlLmlkfVxcbmV2ZW50OiAke2UuZXZlbnR9XFxuZGF0YTogJHtKU09OLnN0cmluZ2lmeShlLmRhdGEpfVxcblxcbmApO1xyXG4gICAgICAgIH1cclxuICAgICAgfVxyXG4gICAgICByZXEub24oJ2Nsb3NlJywgKCkgPT4gc3NlQ2xpZW50cy5kZWxldGUocmVzKSk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmICghYXV0aG9yaXplZCkgeyBkZW55KCk7IHJldHVybjsgfVxyXG5cclxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3N0YXRlJykge1xyXG4gICAgICAvLyBwcm92aWRlcnNEZXRhaWw6XHU0RTBFIGhtaGFybmVzcyBcdTU0MENcdTVGNjJcdTIwMTRcdTIwMTRrZXkgXHU1M0VBXHU1MUZBIGhhc0tleS9cdTY3MkJcdTU2REJcdTRGNEQsXHU2QzM4XHU0RTBEXHU2NjBFXHU2NTg3XHJcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xyXG4gICAgICAgIGRhZW1vblZlcnNpb246ICdmYWtlLTAuMC4wJywgZGVza3RvcDogdHJ1ZSwgbW9kZWw6IGZha2VQcm92aWRlcnMuZ2V0KGZha2VDaGF0UHJvdmlkZXIpPy5tb2RlbCA/PyAnZmFrZS1tb2RlbCcsXHJcbiAgICAgICAgY2hhdFByb3ZpZGVyOiBmYWtlQ2hhdFByb3ZpZGVyLCBsb2NhbGU6ICd6aCcsXHJcbiAgICAgICAgYnVzeVNlc3Npb25zOiBbLi4uc2Vzc2lvbnMua2V5cygpXS5zbGljZSgwLCAyKSxcclxuICAgICAgICBhcHByb3ZhbFBlbmRpbmc6IHBlbmRpbmcgIT09IG51bGwsXHJcbiAgICAgICAgc2V0dGluZ3M6IHsgYXBwcm92YWw6ICdhc2snIH0sXHJcbiAgICAgICAgd29ya3NwYWNlOiBmYWtlV29ya3NwYWNlcy5pdGVtcy5maW5kKCh3KSA9PiB3LmlkID09PSBmYWtlV29ya3NwYWNlcy5jdXJyZW50KSA/PyBudWxsLFxyXG4gICAgICAgIHByb3ZpZGVyc0RldGFpbDogWy4uLmZha2VQcm92aWRlcnMuZW50cmllcygpXS5tYXAoKFtuYW1lLCBwXSkgPT4gKHtcclxuICAgICAgICAgIG5hbWUsIG1vZGVsOiBwLm1vZGVsLCBiYXNlVXJsOiBwLmJhc2VVcmwsXHJcbiAgICAgICAgICBoYXNLZXk6IHAuYXBpS2V5ICE9PSAnJyxcclxuICAgICAgICAgIGtleVRhaWw6IHAuYXBpS2V5Lmxlbmd0aCA+PSA0ID8gcC5hcGlLZXkuc2xpY2UoLTQpIDogdW5kZWZpbmVkLFxyXG4gICAgICAgICAgcHVycG9zZXM6IFsnY2hhdCddLFxyXG4gICAgICAgIH0pKSxcclxuICAgICAgfSkpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZGVza3RvcC9zaHV0ZG93bicpIHtcclxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlIH0pKTtcclxuICAgICAgc2VydmVyLmNsb3NlKCgpID0+IHByb2Nlc3MuZXhpdCgwKSk7XHJcbiAgICAgIHNldFRpbWVvdXQoKCkgPT4gcHJvY2Vzcy5leGl0KDApLCAxXzAwMCkudW5yZWYoKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2Zha2UvZGllJykge1xyXG4gICAgICAvLyBcdTZENEJcdThCRDVcdTk0QTlcdTVCNTA6XHU2QTIxXHU2MkRGIGhvc3QgXHU1RDI5XHU2RTgzKFx1NTE0OFx1NUU5NFx1N0I1NFx1NTE4RFx1OTAwMFx1NTFGQSxcdTRGRERcdThCQzFcdTU0Q0RcdTVFOTRcdTVERjJcdTUzRDFcdTUxRkEpXHJcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSB9KSk7XHJcbiAgICAgIHNldFRpbWVvdXQoKCkgPT4gcHJvY2Vzcy5leGl0KDEpLCA1MCk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9tb2RlbCcpIHtcclxuICAgICAgLy8gXHU2QTIxXHU1NzhCXHU1MjA3XHU2MzYyKFx1NEUwRSBobWhhcm5lc3MgL2FwaS9tb2RlbCBcdTU0MENcdTVGNjI6XHU1MjA3IGNoYXQgXHU4REVGXHU3NTMxKVxyXG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoKGF3YWl0IHJlYWRCb2R5KCkpIHx8ICd7fScpIGFzIHsgbmFtZT86IHVua25vd24gfTtcclxuICAgICAgICBjb25zdCBuYW1lID0gdHlwZW9mIGJvZHkubmFtZSA9PT0gJ3N0cmluZycgPyBib2R5Lm5hbWUudHJpbSgpIDogJyc7XHJcbiAgICAgICAgaWYgKCFmYWtlUHJvdmlkZXJzLmhhcyhuYW1lKSkge1xyXG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAncHJvdmlkZXIgbm90IGZvdW5kJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XHJcbiAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGZha2VDaGF0UHJvdmlkZXIgPSBuYW1lO1xyXG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlLCBtb2RlbDogZmFrZVByb3ZpZGVycy5nZXQobmFtZSk/Lm1vZGVsIH0pKTtcclxuICAgICAgfSkoKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3Rhc2snKSB7XHJcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoKGF3YWl0IHJlYWRCb2R5KCkpIHx8ICd7fScpIGFzIHsgdGV4dD86IHVua25vd247IHNlc3Npb25JZD86IHVua25vd247IG1vZGU/OiB1bmtub3duOyBhdHRhY2htZW50cz86IHVua25vd247IGltYWdlcz86IHVua25vd24gfTtcclxuICAgICAgICAgIGNvbnN0IHRleHQgPSB0eXBlb2YgYm9keS50ZXh0ID09PSAnc3RyaW5nJyA/IGJvZHkudGV4dCA6ICcnO1xyXG4gICAgICAgICAgY29uc3Qgc2Vzc2lvbklkID0gdHlwZW9mIGJvZHkuc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IGJvZHkuc2Vzc2lvbklkIDogYHdlYi0ke0RhdGUubm93KCkudG9TdHJpbmcoMzYpfWA7XHJcbiAgICAgICAgICBjb25zdCBtb2RlID0gYm9keS5tb2RlID09PSAnYXNrJyB8fCBib2R5Lm1vZGUgPT09ICdhdXRvJyB8fCBib2R5Lm1vZGUgPT09ICd5b2xvJyA/IGJvZHkubW9kZSA6ICdhc2snO1xyXG4gICAgICAgICAgY29uc3QgYXR0YWNobWVudHMgPSBBcnJheS5pc0FycmF5KGJvZHkuYXR0YWNobWVudHMpID8gYm9keS5hdHRhY2htZW50cy5maWx0ZXIoKGEpOiBhIGlzIHN0cmluZyA9PiB0eXBlb2YgYSA9PT0gJ3N0cmluZycpIDogW107XHJcbiAgICAgICAgICAvLyBcdTU2RkVcdTcyNDdcdTk2NDRcdTRFRjY6XHU0RTBFIGhtaGFybmVzcyB2aXNpb24gXHU1MzRGXHU4QkFFXHU1NDBDXHU1RjYyKHtuYW1lLGRhdGFVcmx9KTtmYWtlIFx1NjgyMVx1OUE4Q1x1NUY2Mlx1NzJCNlx1NTM3M1x1NjUzNlxyXG4gICAgICAgICAgY29uc3QgaW1hZ2VzID0gQXJyYXkuaXNBcnJheShib2R5LmltYWdlcylcclxuICAgICAgICAgICAgPyBib2R5LmltYWdlcy5maWx0ZXIoKGltKTogaW0gaXMgeyBuYW1lOiBzdHJpbmc7IGRhdGFVcmw6IHN0cmluZyB9ID0+IHtcclxuICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgaW0gIT09ICdvYmplY3QnIHx8IGltID09PSBudWxsKSByZXR1cm4gZmFsc2U7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBvID0gaW0gYXMgeyBuYW1lPzogdW5rbm93bjsgZGF0YVVybD86IHVua25vd24gfTtcclxuICAgICAgICAgICAgICAgIHJldHVybiB0eXBlb2Ygby5uYW1lID09PSAnc3RyaW5nJyAmJiB0eXBlb2Ygby5kYXRhVXJsID09PSAnc3RyaW5nJyAmJiBvLmRhdGFVcmwuc3RhcnRzV2l0aCgnZGF0YTppbWFnZS8nKTtcclxuICAgICAgICAgICAgICB9KVxyXG4gICAgICAgICAgICA6IFtdO1xyXG4gICAgICAgICAgaWYgKCF0ZXh0KSB7XHJcbiAgICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAndGV4dCByZXF1aXJlZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgICAvLyBcdTRFMEUgaG1oYXJuZXNzIFx1NTQwQ1x1OEJFRFx1NEU0OTpcdTU0MDhcdTZDRDVcdTk2NDRcdTRFRjZcdTRFRTUgW3JlZmVyZW5jZWQgZmlsZXNdIFx1NTI0RFx1N0YwMFx1NUU3Nlx1NTE2NVx1NEVGQlx1NTJBMVx1NjU4N1x1NjcyQztcclxuICAgICAgICAgIC8vIFx1NTZGRVx1NzI0N1x1NEVFNSBbaW1hZ2VzXSBcdTUyNERcdTdGMDBcdTY4MDdcdTZDRThcdTVGMjBcdTY1NzAodmlzaW9uIFx1NjNDRlx1OEZGMFx1OTRGRVx1NTcyOFx1NzcxRlx1NUI5RSBydW50aW1lIFx1OTFDQ1x1NTNEMVx1NzUxRilcclxuICAgICAgICAgIGNvbnN0IGNvbXBvc2VkID0gYXR0YWNobWVudHMubGVuZ3RoID4gMFxyXG4gICAgICAgICAgICA/IGBbcmVmZXJlbmNlZCBmaWxlc11cXG4ke2F0dGFjaG1lbnRzLm1hcCgoYSkgPT4gYC0gJHthLnNwbGl0KC9bXFxcXC9dLykucG9wKCl9YCkuam9pbignXFxuJyl9XFxuXFxuJHt0ZXh0fWBcclxuICAgICAgICAgICAgOiB0ZXh0O1xyXG4gICAgICAgICAgY29uc3Qgd2l0aEltYWdlcyA9IGltYWdlcy5sZW5ndGggPiAwID8gYFtpbWFnZXM6ICR7aW1hZ2VzLmxlbmd0aH1dXFxuJHtjb21wb3NlZH1gIDogY29tcG9zZWQ7XHJcbiAgICAgICAgICBjb25zdCBydW5JZCA9IHJ1blRhc2soc2Vzc2lvbklkLCB3aXRoSW1hZ2VzLCBtb2RlKTtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIHJ1bklkLCBpbWFnZXM6IGltYWdlcy5sZW5ndGggfSkpO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xyXG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCBTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcclxuICAgICAgICB9XHJcbiAgICAgIH0pKCk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9hcHByb3ZlJykge1xyXG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoKGF3YWl0IHJlYWRCb2R5KCkpIHx8ICd7fScpIGFzIHsgZ3JhbnRlZD86IHVua25vd247IHNlc3Npb25JZD86IHVua25vd24gfTtcclxuICAgICAgICBjb25zdCBzaWQgPSB0eXBlb2YgYm9keS5zZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gYm9keS5zZXNzaW9uSWQgOiAnJztcclxuICAgICAgICBpZiAocGVuZGluZyA9PT0gbnVsbCB8fCAoc2lkICE9PSAnJyAmJiBwZW5kaW5nLnNlc3Npb25JZCAhPT0gc2lkKSkge1xyXG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnbm8gYXBwcm92YWwgcGVuZGluZycsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xyXG4gICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBwID0gcGVuZGluZztcclxuICAgICAgICBwZW5kaW5nID0gbnVsbDtcclxuICAgICAgICBwLnJlc29sdmUoYm9keS5ncmFudGVkID09PSB0cnVlKTtcclxuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgZ3JhbnRlZDogYm9keS5ncmFudGVkID09PSB0cnVlIH0pKTtcclxuICAgICAgfSkoKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUuc3RhcnRzV2l0aCgnL2FwaS9zZXNzaW9ucy8nKSAmJiAodXJsLnBhdGhuYW1lLmVuZHNXaXRoKCcvYXJjaGl2ZScpIHx8IHVybC5wYXRobmFtZS5lbmRzV2l0aCgnL2RlbGV0ZScpKSkge1xyXG4gICAgICAvLyBcdTRGMUFcdThCRERcdTVGNTJcdTY4NjMvXHU1MjIwXHU5NjY0KGhtaGFybmVzcyBcdTU0MENcdTVGNjI6XHU3OUZCXHU1MTY1IGFyY2hpdmUvdHJhc2gsXHU1M0VGXHU2MDYyXHU1OTBELFx1NEUwRFx1Nzg2Q1x1NTIyMClcclxuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHBhcnRzID0gdXJsLnBhdGhuYW1lLnNsaWNlKCcvYXBpL3Nlc3Npb25zLycubGVuZ3RoKS5zcGxpdCgnLycpO1xyXG4gICAgICAgIGNvbnN0IG9wID0gcGFydHNbMV0gPz8gJyc7XHJcbiAgICAgICAgY29uc3Qgb2lkID0gZGVjb2RlVVJJQ29tcG9uZW50KHBhcnRzWzBdID8/ICcnKS5yZXBsYWNlKC9bXmEtekEtWjAtOV86LkAtXS9nLCAnJyk7XHJcbiAgICAgICAgaWYgKG9pZCA9PT0gJycgfHwgKG9wICE9PSAnYXJjaGl2ZScgJiYgb3AgIT09ICdkZWxldGUnKSkge1xyXG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnYmFkIG9wJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XHJcbiAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICghc2Vzc2lvbnMuaGFzKG9pZCkpIHtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3Nlc3Npb24gbm90IGZvdW5kJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XHJcbiAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHNlc3Npb25zLmRlbGV0ZShvaWQpO1xyXG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlIH0pKTtcclxuICAgICAgfSkoKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2luamVjdCcpIHtcclxuICAgICAgLy8gXHU4RkQwXHU4ODRDXHU0RTJEXHU2Q0U4XHU1MTY1KFx1NEUwRSBobWhhcm5lc3MgL2FwaS9pbmplY3QgXHU1NDBDXHU1RjYyO2Zha2UgXHU1M0VBXHU1NkRFXHU2MjY3KVxyXG4gICAgICB2b2lkIHJlYWRCb2R5KCk7XHJcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSB9KSk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9pbnRlcnJ1cHQnKSB7XHJcbiAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKCcnKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjsgLy8gaW50ZXJydXB0IFx1NjVFMCBib2R5IFx1OEJFRFx1NEU0OVxyXG4gICAgICB2b2lkIGJvZHk7XHJcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSB9KSk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3Nlc3Npb25zJykge1xyXG4gICAgICBjb25zdCBsaXN0ID0gWy4uLnNlc3Npb25zLnZhbHVlcygpXS5tYXAoKHMpID0+ICh7XHJcbiAgICAgICAgaWQ6IHMuaWQsIHRpdGxlOiAnJywgdGFzazogJycsIG91dGNvbWU6ICdvaycsIHR1cm5zOiAxLCB0b29sVXNlczogMSxcclxuICAgICAgICB0aW1lOiBzLnVwZGF0ZWRBdCwgY3dkOiAnQzpcXFxcZGVtbycsIGJyYW5jaDogJycsIGNyZWF0ZWRBdDogcy5jcmVhdGVkQXQsIHVwZGF0ZWRBdDogcy51cGRhdGVkQXQsXHJcbiAgICAgIH0pKTtcclxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IHNlc3Npb25zOiBsaXN0LCBuZXh0Q3Vyc29yOiBudWxsIH0pKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZS5zdGFydHNXaXRoKCcvYXBpL3Nlc3Npb25zLycpKSB7XHJcbiAgICAgIGNvbnN0IHNlZyA9IGRlY29kZVVSSUNvbXBvbmVudCh1cmwucGF0aG5hbWUuc2xpY2UoJy9hcGkvc2Vzc2lvbnMvJy5sZW5ndGgpKTtcclxuICAgICAgLy8gXHU1QkZDXHU1MUZBKFx1NEUwRSBobWhhcm5lc3MgL2FwaS9zZXNzaW9ucy86aWQvZXhwb3J0Lm1kIFx1NTQwQ1x1NUY2Mjp0ZXh0L21hcmtkb3duIFx1NEUwQlx1OEY3RClcclxuICAgICAgY29uc3QgZXhwb3J0TWF0Y2ggPSAvXiguKilcXC9leHBvcnRcXC5tZCQvLmV4ZWMoc2VnKSA/PyAvXiguKilcXC5leHBvcnRcXC5tZCQvLmV4ZWMoc2VnKTtcclxuICAgICAgaWYgKGV4cG9ydE1hdGNoICE9PSBudWxsICYmIGV4cG9ydE1hdGNoWzFdICE9PSB1bmRlZmluZWQgJiYgZXhwb3J0TWF0Y2hbMV0gIT09ICcnKSB7XHJcbiAgICAgICAgY29uc3QgZWlkID0gZXhwb3J0TWF0Y2hbMV0ucmVwbGFjZSgvW15hLXpBLVowLTlfOi5ALV0vZywgJycpO1xyXG4gICAgICAgIGNvbnN0IGVzID0gc2Vzc2lvbnMuZ2V0KGVpZCk7XHJcbiAgICAgICAgaWYgKGVzID09PSB1bmRlZmluZWQpIHtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3Nlc3Npb24gbm90IGZvdW5kJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XHJcbiAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAndGV4dC9tYXJrZG93bjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgcmVzLmVuZChgIyBobWhhcm5lc3MgXHU0RjFBXHU4QkREXHU1QkZDXHU1MUZBKGZha2UpXFxuXFxuLSBcdTRGMUFcdThCREQ6JHtlaWR9XFxuXFxuIyMgXHU3NTI4XHU2MjM3XFxuXFxuXHU0RTRCXHU1MjREXHU3Njg0XHU0RUZCXHU1MkExKGZha2UgXHU5ODg0XHU4OUM4KVxcblxcbiMjIFx1NTJBOVx1NjI0Qlxcblxcblx1OEZEOVx1NjYyRlx1NUJGQ1x1NTFGQVx1NzY4NFx1NTZERVx1NTkwRFx1OTg4NFx1ODlDOChmYWtlKVx1MzAwMlxcbmApO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgICAgfVxyXG4gICAgICAvLyBcdTRGMUFcdThCRERcdTk4ODRcdTg5QzgoXHU0RTBFIGhtaGFybmVzcyBHRVQgL2FwaS9zZXNzaW9ucy86aWQgXHU1NDBDXHU1RjYyOlx1NjcwMFx1NTQwRSA4MCBcdTY3NjEsXHU2QkNGXHU2NzYxIDUwMCBcdTVCNTcpXHJcbiAgICAgIGNvbnN0IGlkID0gc2VnLnJlcGxhY2UoL1teYS16QS1aMC05XzouQC1dL2csICcnKTtcclxuICAgICAgY29uc3QgcyA9IHNlc3Npb25zLmdldChpZCk7XHJcbiAgICAgIGlmIChzID09PSB1bmRlZmluZWQpIHtcclxuICAgICAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnc2Vzc2lvbiBub3QgZm91bmQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcclxuICAgICAgICByZXR1cm47XHJcbiAgICAgIH1cclxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XHJcbiAgICAgICAgaWQsIG1vZGVsOiAnZmFrZS1tb2RlbCcsIGN3ZDogJ0M6XFxcXGRlbW8nLFxyXG4gICAgICAgIG1lc3NhZ2VzOiBbXHJcbiAgICAgICAgICB7IHJvbGU6ICd1c2VyJywgdGV4dDogJ1x1NEU0Qlx1NTI0RFx1NzY4NFx1NEVGQlx1NTJBMShmYWtlIFx1OTg4NFx1ODlDOCknLCB0b29sczogW10gfSxcclxuICAgICAgICAgIHsgcm9sZTogJ2Fzc2lzdGFudCcsIHRleHQ6ICdcdThGRDlcdTY2MkZcdTUzODZcdTUzRjJcdTRGMUFcdThCRERcdTc2ODRcdTU2REVcdTU5MERcdTk4ODRcdTg5QzgoZmFrZSlcdTMwMDInLCB0b29sczogWydyZWFkX2ZpbGUnXSB9LFxyXG4gICAgICAgIF0sXHJcbiAgICAgIH0pKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZnMnKSB7XHJcbiAgICAgIC8vIFx1NzZFRVx1NUY1NVx1NkQ0Rlx1ODlDOChcdTRFMEUgaG1oYXJuZXNzIFx1NTQwQ1x1NUY2MjpwYXRoIFx1NzcwMVx1NzU2NT1cdTY4Mzk7ZmlsZXM9MSBcdTk2NDRcdTVFMjZcdTY1ODdcdTRFRjZcdTUyMTdcdTg4NjgpXHJcbiAgICAgIGNvbnN0IHEgPSB1cmwuc2VhcmNoUGFyYW1zLmdldCgncGF0aCcpID8/ICcnO1xyXG4gICAgICBjb25zdCB3aXRoRmlsZXMgPSB1cmwuc2VhcmNoUGFyYW1zLmdldCgnZmlsZXMnKSA9PT0gJzEnO1xyXG4gICAgICBpZiAocSA9PT0gJycpIHtcclxuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xyXG4gICAgICAgICAgcGF0aDogJycsIHNlZ21lbnRzOiBbXSwgcGFyZW50OiAnJyxcclxuICAgICAgICAgIGRpcnM6IFt7IG5hbWU6ICdkZW1vLXdvcmtzcGFjZScsIHBhdGg6ICdDOlxcXFxkZW1vJyB9XSxcclxuICAgICAgICAgIC4uLih3aXRoRmlsZXMgPyB7IGZpbGVzOiBbXSB9IDoge30pLFxyXG4gICAgICAgIH0pKTtcclxuICAgICAgICByZXR1cm47XHJcbiAgICAgIH1cclxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XHJcbiAgICAgICAgcGF0aDogcSwgc2VnbWVudHM6IFt7IG5hbWU6IHEuc3BsaXQoL1tcXFxcL10vKS5maWx0ZXIoQm9vbGVhbikucG9wKCkgPz8gcSwgcGF0aDogcSB9XSwgcGFyZW50OiAnJyxcclxuICAgICAgICBkaXJzOiBbeyBuYW1lOiAnc3JjJywgcGF0aDogYCR7cS5yZXBsYWNlKC9bXFxcXC9dJC8sICcnKX1cXFxcc3JjYCB9XSxcclxuICAgICAgICAuLi4od2l0aEZpbGVzID8geyBmaWxlczogW1xyXG4gICAgICAgICAgeyBuYW1lOiAnUkVBRE1FLm1kJywgcGF0aDogYCR7cS5yZXBsYWNlKC9bXFxcXC9dJC8sICcnKX1cXFxcUkVBRE1FLm1kYCwgcmVsOiAnUkVBRE1FLm1kJyB9LFxyXG4gICAgICAgICAgeyBuYW1lOiAncGFja2FnZS5qc29uJywgcGF0aDogYCR7cS5yZXBsYWNlKC9bXFxcXC9dJC8sICcnKX1cXFxccGFja2FnZS5qc29uYCwgcmVsOiAncGFja2FnZS5qc29uJyB9LFxyXG4gICAgICAgIF0gfSA6IHt9KSxcclxuICAgICAgfSkpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9mcy9yZWFkJykge1xyXG4gICAgICAvLyBcdTY1ODdcdTRFRjZcdTk4ODRcdTg5QzgoNjRLQiBcdTRFMEFcdTk2NTBcdThCRURcdTRFNDk7ZmFrZSBcdThGRDRcdTU2REVcdTU2RkFcdTVCOUFcdTY1ODdcdTY3MkMpXHJcbiAgICAgIGNvbnN0IHAgPSB1cmwuc2VhcmNoUGFyYW1zLmdldCgncGF0aCcpID8/ICcnO1xyXG4gICAgICBpZiAocCA9PT0gJycpIHtcclxuICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAncGF0aCByZXF1aXJlZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgICAgfVxyXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcclxuICAgICAgICBwYXRoOiBwLCByZWw6IHAuc3BsaXQoL1tcXFxcL10vKS5wb3AoKSA/PyBwLCBzaXplOiA0MixcclxuICAgICAgICB0ZXh0OiAnIyBkZW1vIHdvcmtzcGFjZVxcblxcblx1OEZEOVx1NjYyRiBmYWtlIGhvc3QgXHU3Njg0XHU2NTg3XHU0RUY2XHU5ODg0XHU4OUM4XHU1MTg1XHU1QkI5XHUzMDAyXFxuJyxcclxuICAgICAgfSkpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9kaWZmJykge1xyXG4gICAgICAvLyBEaWZmIFx1OTc2Mlx1Njc3RihcdTRFMEUgaG1oYXJuZXNzIC9hcGkvZGlmZiBcdTU0MENcdTVGNjI7ZmFrZSBcdThGRDRcdTU2REVcdTU2RkFcdTVCOUFcdTVDMEZcdTUzRDhcdTY2RjRcdTk2QzYpXHJcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xyXG4gICAgICAgIGdpdDogdHJ1ZSwgY3dkOiAnQzpcXFxcZGVtbycsXHJcbiAgICAgICAgY2hhbmdlZDogW1xyXG4gICAgICAgICAgeyBzdGF0ZTogJ00nLCBwYXRoOiAnc3JjL2FwcC50cycgfSxcclxuICAgICAgICAgIHsgc3RhdGU6ICdBJywgcGF0aDogJ2RvY3Mvbm90ZXMubWQnIH0sXHJcbiAgICAgICAgXSxcclxuICAgICAgICBzdGF0OiAnIHNyYy9hcHAudHMgICAgICB8IDEyICsrKysrKystLS1cXG4gZG9jcy9ub3Rlcy5tZCAgIHwgIDQgKysrK1xcbiAyIGZpbGVzIGNoYW5nZWQsIDE2IGluc2VydGlvbnMoKyksIDMgZGVsZXRpb25zKC0pJyxcclxuICAgICAgfSkpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS93b3Jrc3BhY2VzJykge1xyXG4gICAgICAvLyBcdTVERTVcdTRGNUNcdTUzM0EoXHU0RTBFIGhtaGFybmVzcyBcdTU0MENcdTVGNjI6Y3VycmVudCArIGl0ZW1zKVxyXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcclxuICAgICAgICBjdXJyZW50OiBmYWtlV29ya3NwYWNlcy5jdXJyZW50LFxyXG4gICAgICAgIGl0ZW1zOiBmYWtlV29ya3NwYWNlcy5pdGVtcyxcclxuICAgICAgfSkpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvd29ya3NwYWNlcycpIHtcclxuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7IG5hbWU/OiB1bmtub3duOyBwYXRoPzogdW5rbm93biB9O1xyXG4gICAgICAgIGNvbnN0IHBhdGggPSB0eXBlb2YgYm9keS5wYXRoID09PSAnc3RyaW5nJyA/IGJvZHkucGF0aCA6ICcnO1xyXG4gICAgICAgIGNvbnN0IG5hbWUgPSB0eXBlb2YgYm9keS5uYW1lID09PSAnc3RyaW5nJyAmJiBib2R5Lm5hbWUgIT09ICcnID8gYm9keS5uYW1lIDogKHBhdGguc3BsaXQoL1tcXFxcL10vKS5maWx0ZXIoQm9vbGVhbikucG9wKCkgPz8gJycpO1xyXG4gICAgICAgIGlmIChwYXRoID09PSAnJyB8fCBuYW1lID09PSAnJykge1xyXG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnYWJzb2x1dGUgcGF0aCBhbmQgbmFtZSByZXF1aXJlZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xyXG4gICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoZmFrZVdvcmtzcGFjZXMuaXRlbXMuc29tZSgodykgPT4gdy5wYXRoLnRvTG93ZXJDYXNlKCkgPT09IHBhdGgudG9Mb3dlckNhc2UoKSkpIHtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA5LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3dvcmtzcGFjZSBhbHJlYWR5IHJlZ2lzdGVyZWQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcclxuICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgaXRlbSA9IHsgaWQ6IGB3cy0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDgpfWAsIG5hbWUsIHBhdGggfTtcclxuICAgICAgICBmYWtlV29ya3NwYWNlcy5pdGVtcy5wdXNoKGl0ZW0pO1xyXG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlLCBjdXJyZW50OiBmYWtlV29ya3NwYWNlcy5jdXJyZW50LCBpdGVtczogZmFrZVdvcmtzcGFjZXMuaXRlbXMgfSkpO1xyXG4gICAgICB9KSgpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvd29ya3NwYWNlcy91c2UnKSB7XHJcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcclxuICAgICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgoYXdhaXQgcmVhZEJvZHkoKSkgfHwgJ3t9JykgYXMgeyBpZD86IHVua25vd24gfTtcclxuICAgICAgICBjb25zdCBoaXQgPSBmYWtlV29ya3NwYWNlcy5pdGVtcy5maW5kKCh3KSA9PiB3LmlkID09PSBib2R5LmlkKTtcclxuICAgICAgICBpZiAoaGl0ID09PSB1bmRlZmluZWQpIHtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA0LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3dvcmtzcGFjZSBub3QgZm91bmQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcclxuICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgZmFrZVdvcmtzcGFjZXMuY3VycmVudCA9IGhpdC5pZDtcclxuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgY3VycmVudDogZmFrZVdvcmtzcGFjZXMuY3VycmVudCwgaXRlbXM6IGZha2VXb3Jrc3BhY2VzLml0ZW1zIH0pKTtcclxuICAgICAgfSkoKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3Byb3ZpZGVycycpIHtcclxuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7IG5hbWU/OiB1bmtub3duOyBiYXNlVXJsPzogdW5rbm93bjsgbW9kZWw/OiB1bmtub3duOyBhcGlLZXk/OiB1bmtub3duIH07XHJcbiAgICAgICAgY29uc3QgbmFtZSA9IHR5cGVvZiBib2R5Lm5hbWUgPT09ICdzdHJpbmcnID8gYm9keS5uYW1lLnRyaW0oKSA6ICcnO1xyXG4gICAgICAgIGNvbnN0IGJhc2VVcmwgPSB0eXBlb2YgYm9keS5iYXNlVXJsID09PSAnc3RyaW5nJyA/IGJvZHkuYmFzZVVybC50cmltKCkgOiAnJztcclxuICAgICAgICBjb25zdCBtb2RlbCA9IHR5cGVvZiBib2R5Lm1vZGVsID09PSAnc3RyaW5nJyA/IGJvZHkubW9kZWwudHJpbSgpIDogJyc7XHJcbiAgICAgICAgaWYgKG5hbWUgPT09ICcnIHx8IGJhc2VVcmwgPT09ICcnIHx8IG1vZGVsID09PSAnJykge1xyXG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnbmFtZSwgYmFzZVVybCBhbmQgbW9kZWwgYXJlIHJlcXVpcmVkJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XHJcbiAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGZha2VQcm92aWRlcnMuc2V0KG5hbWUsIHsgYmFzZVVybCwgbW9kZWwsIGFwaUtleTogdHlwZW9mIGJvZHkuYXBpS2V5ID09PSAnc3RyaW5nJyA/IGJvZHkuYXBpS2V5IDogJycgfSk7XHJcbiAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIG5hbWUgfSkpO1xyXG4gICAgICB9KSgpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9mcy9zZWFyY2gnKSB7XHJcbiAgICAgIC8vIFx1NURFNVx1NEY1Q1x1NTMzQVx1NjU4N1x1NEVGNlx1NjQxQ1x1N0QyMihcdTRFMEUgaG1oYXJuZXNzIFx1NTQwQ1x1NUY2MjpAXHU5NjQ0XHU0RUY2XHU5MDA5XHU2MkU5XHU1NjY4XHU3Njg0XHU2NTcwXHU2MzZFXHU2RTkwKVxyXG4gICAgICBjb25zdCBxID0gKHVybC5zZWFyY2hQYXJhbXMuZ2V0KCdxJykgPz8gJycpLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xyXG4gICAgICBjb25zdCBhbGwgPSBbXHJcbiAgICAgICAgeyByZWw6ICdSRUFETUUubWQnLCBwYXRoOiAnQzpcXFxcZGVtb1xcXFxSRUFETUUubWQnLCBraW5kOiAnZmlsZScgfSxcclxuICAgICAgICB7IHJlbDogJ3NyYy9hcHAudHMnLCBwYXRoOiAnQzpcXFxcZGVtb1xcXFxzcmNcXFxcYXBwLnRzJywga2luZDogJ2ZpbGUnIH0sXHJcbiAgICAgICAgeyByZWw6ICdkb2NzL25vdGVzLm1kJywgcGF0aDogJ0M6XFxcXGRlbW9cXFxcZG9jc1xcXFxub3Rlcy5tZCcsIGtpbmQ6ICdmaWxlJyB9LFxyXG4gICAgICBdO1xyXG4gICAgICBjb25zdCBoaXRzID0gcSA9PT0gJycgPyBhbGwgOiBhbGwuZmlsdGVyKChmKSA9PiBmLnJlbC50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHEpKTtcclxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IHJlc3VsdHM6IGhpdHMuc2xpY2UoMCwgMjApLCB0cnVuY2F0ZWQ6IGZhbHNlLCB0b3RhbDogaGl0cy5sZW5ndGggfSkpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9jb2duaXRpdmUnKSB7XHJcbiAgICAgIC8vIFx1OEJBNFx1NzdFNVx1NzJCNlx1NjAwMShcdTRFMEUgaG1oYXJuZXNzIGNvZ25pdGl2ZVN0YXR1cyBcdTU0MENcdTVGNjJcdTVCNTBcdTk2QzY7XHU3RjNBXHU2NTcwXHU2MzZFXHU2NjNFXHU1RjBGIG51bGwpXHJcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xyXG4gICAgICAgIG1lbW9yeTogeyBsYXllcnM6IDMsIGVudHJpZXM6IDEyLCBjb250cmFkaWN0aW9uczogMCB9LFxyXG4gICAgICAgIHRyYWplY3RvcmllczogNyxcclxuICAgICAgICBhdWRpdEV2ZW50czogMjEsXHJcbiAgICAgICAgd29ybGRNb2RlbDogeyB2ZXJzaW9uOiA0LCBiZWxpZWZzOiA5LCB0cnVzdGVkOiA1LCBicmllcjogMC4zMSB9LFxyXG4gICAgICAgIGNhbGlicmF0aW9uOiB7IHByZWRpY3Rpb25zOiA0NiwgcmVsaWFiaWxpdHk6IDAuNzIgfSxcclxuICAgICAgfSkpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZmFrZS9lbWl0Jykge1xyXG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7XHJcbiAgICAgICAgICAgIHNlc3Npb25JZDogc3RyaW5nOyBydW5JZDogc3RyaW5nOyBraW5kOiBFdmVudEtpbmQ7IHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xyXG4gICAgICAgICAgfTtcclxuICAgICAgICAgIGNvbnN0IHNlcSA9IGVtaXQoYm9keS5zZXNzaW9uSWQsIGJvZHkucnVuSWQsIGJvZHkua2luZCwgYm9keS5wYXlsb2FkKTtcclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XHJcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIHNlcSB9KSk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xyXG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsIFN0cmluZyhlcnIpLnNsaWNlKDAsIDEyMCksIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xyXG4gICAgICAgIH1cclxuICAgICAgfSkoKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcclxuICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCBgbm8gcm91dGUgJHtyZXEubWV0aG9kfSAke3VybC5wYXRobmFtZX1gLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcclxuICB9KTtcclxuXHJcbiAgYXdhaXQgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xyXG4gICAgc2VydmVyLm9uY2UoJ2Vycm9yJywgcmVqZWN0KTtcclxuICAgIHNlcnZlci5saXN0ZW4oMCwgJzEyNy4wLjAuMScsICgpID0+IHJlc29sdmUoKSk7XHJcbiAgfSk7XHJcbiAgY29uc3QgYWRkcmVzcyA9IHNlcnZlci5hZGRyZXNzKCk7XHJcbiAgaWYgKGFkZHJlc3MgPT09IG51bGwgfHwgdHlwZW9mIGFkZHJlc3MgIT09ICdvYmplY3QnKSB0aHJvdyBuZXcgRXJyb3IoJ2Zha2UgaG9zdDogbm8gcG9ydCcpO1xyXG4gIGNvbnN0IHBvcnQgPSBhZGRyZXNzLnBvcnQ7XHJcblxyXG4gIGlmICghb3B0cy5xdWlldCkge1xyXG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7SlNPTi5zdHJpbmdpZnkoeyBobWhEZXNrdG9wSG9zdFJlYWR5OiB0cnVlLCBwb3J0LCB2ZXJzaW9uOiAnZmFrZS0wLjAuMCcgfSl9XFxuYCk7XHJcbiAgfVxyXG4gIGNvbnN0IGRpZUFmdGVyID0gTnVtYmVyKHByb2Nlc3MuZW52LkZBS0VfSE9TVF9ESUVfQUZURVJfTVMgPz8gMCk7XHJcbiAgaWYgKE51bWJlci5pc0Zpbml0ZShkaWVBZnRlcikgJiYgZGllQWZ0ZXIgPiAwKSB7XHJcbiAgICBzZXRUaW1lb3V0KCgpID0+IHByb2Nlc3MuZXhpdCgxKSwgZGllQWZ0ZXIpLnVucmVmKCk7XHJcbiAgfVxyXG5cclxuICAvLyBjbG9zZSgpOiBcdTUxNDhcdTY1QURcdTVGMDBcdTUxNjhcdTkwRTggU1NFIFx1OEZERVx1NjNBNShcdTVCODNcdTRFRUNcdTZDMzhcdTRFMERcdTgxRUFcdTcxMzZcdTUxNzNcdTk1RUQpLFx1NTQyNlx1NTIxOSBzZXJ2ZXIuY2xvc2VcclxuICAvLyBcdTRGMUFcdTRFMDBcdTc2RjRcdTdCNDlcdTZEM0JcdThEQzNcdThGREVcdTYzQTUsXHU2RDRCXHU4QkQ1XHU4RkRCXHU3QTBCXHU2MzAyXHU2QjdCXHUzMDAyXHJcbiAgY29uc3QgY2xvc2UgPSAoKTogUHJvbWlzZTx2b2lkPiA9PlxyXG4gICAgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUpID0+IHtcclxuICAgICAgZm9yIChjb25zdCBjIG9mIHNzZUNsaWVudHMpIHtcclxuICAgICAgICB0cnkgeyBjLmVuZCgpOyBjLmRlc3Ryb3koKTsgfSBjYXRjaCB7IC8qIGFscmVhZHkgZ29uZSAqLyB9XHJcbiAgICAgIH1cclxuICAgICAgc3NlQ2xpZW50cy5jbGVhcigpO1xyXG4gICAgICBzZXJ2ZXIuY2xvc2UoKCkgPT4gcmVzb2x2ZSgpKTtcclxuICAgICAgc2V0VGltZW91dCgoKSA9PiByZXNvbHZlKCksIDFfMDAwKS51bnJlZigpO1xyXG4gICAgfSk7XHJcblxyXG4gIHJldHVybiB7IHBvcnQsIGVtaXQsIGNsb3NlIH07XHJcbn1cclxuXHJcbi8vIFx1NzZGNFx1NjNBNVx1OEZEMFx1ODg0QyhzdXBlcnZpc29yIHNwYXduIFx1NzY4NFx1NUI1MFx1OEZEQlx1N0EwQlx1NUY2Mlx1NjAwMSlcdTMwMDJyZWFscGF0aCBcdTZCRDRcdThGODM6bnBtIHdvcmtzcGFjZVxyXG4vLyBqdW5jdGlvbiAvIFx1NTkyN1x1NUMwRlx1NTE5OVx1NURFRVx1NUYwMlx1OTBGRFx1NEUwRFx1ODBGRFx1OEJBOVx1OEZEOVx1NEUyQVx1NjhDMFx1NkQ0Qlx1NTkzMVx1NjI0QihcdTU5MzFcdTYyNEI9XHU5NzU5XHU5RUQ4XHU5MDAwXHU1MUZBIGNvZGUgMCxcdTk2QkVcdTY3RTUpXHUzMDAyXHJcbi8vIGNqcyBidW5kbGUoZXNidWlsZCxcdTYyNTNcdTUzMDVcdTRFQTdcdTU0QzEpXHU0RTBCIF9fZmlsZW5hbWUgXHU1QjU4XHU1NzI4O0VTTSh0c3gvXHU2RTkwXHU3ODAxKVx1NzUyOCBpbXBvcnQubWV0YVx1MzAwMlxyXG5jb25zdCBzZWxmVXJsOiBzdHJpbmcgPSB0eXBlb2YgX19maWxlbmFtZSA9PT0gJ3N0cmluZydcclxuICA/IHBhdGhUb0ZpbGVVUkwocmVhbHBhdGhTeW5jKF9fZmlsZW5hbWUpKS5ocmVmXHJcbiAgOiBpbXBvcnQubWV0YS51cmw7XHJcbmNvbnN0IGludm9rZWRBc1NjcmlwdCA9ICgoKSA9PiB7XHJcbiAgaWYgKHByb2Nlc3MuYXJndlsxXSA9PT0gdW5kZWZpbmVkKSByZXR1cm4gZmFsc2U7XHJcbiAgdHJ5IHtcclxuICAgIHJldHVybiBzZWxmVXJsID09PSBwYXRoVG9GaWxlVVJMKHJlYWxwYXRoU3luYyhwcm9jZXNzLmFyZ3ZbMV0pKS5ocmVmO1xyXG4gIH0gY2F0Y2gge1xyXG4gICAgcmV0dXJuIGZhbHNlO1xyXG4gIH1cclxufSkoKTtcclxuaWYgKGludm9rZWRBc1NjcmlwdCkge1xyXG4gIGNvbnN0IHRva2VuID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVE9LRU4gPz8gJyc7XHJcbiAgLy8gRkFLRV9IT1NUX0RJRV9BVF9CT09UPTE6XHU1RjE1XHU1QkZDXHU4ODRDXHU4RjkzXHU1MUZBXHU1MjREXHU1MzczXHU2QjdCKFx1Njc4NFx1OTAyMFx1NTQyRlx1NTJBOFx1NjcxRiBSVU5USU1FX0NSQVNIRUQpXHJcbiAgaWYgKHByb2Nlc3MuZW52LkZBS0VfSE9TVF9ESUVfQVRfQk9PVCA9PT0gJzEnKSB7XHJcbiAgICBwcm9jZXNzLmV4aXQoMSk7XHJcbiAgfVxyXG4gIGNvbnN0IHNsb3cgPSBOdW1iZXIocHJvY2Vzcy5lbnYuRkFLRV9IT1NUX1NMT1dfQUZURVIgPz8gMCk7XHJcbiAgY29uc3QgYm9vdCA9ICgpOiB2b2lkID0+IHtcclxuICAgIHZvaWQgc3RhcnRGYWtlSG9zdCh7IHRva2VuIH0pLmNhdGNoKChlcnIpID0+IHtcclxuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYGZha2UtaG9zdCBmYWlsZWQ6ICR7U3RyaW5nKGVycil9XFxuYCk7XHJcbiAgICAgIHByb2Nlc3MuZXhpdCgxKTtcclxuICAgIH0pO1xyXG4gIH07XHJcbiAgaWYgKE51bWJlci5pc0Zpbml0ZShzbG93KSAmJiBzbG93ID4gMCkgc2V0VGltZW91dChib290LCBzbG93KTtcclxuICBlbHNlIGJvb3QoKTtcclxufVxyXG4iLCAiLyoqXHJcbiAqIFVJVkVSSUZZIFx1OTRBOVx1NUI1MCBcdTIwMTRcdTIwMTQgXHU5MDEwXHU1MjlGXHU4MEZEXHU3NzFGXHU1QjlFIFVJIFx1OUE3MVx1NTJBOFx1OUE4Q1x1NjUzNigyMDI2LTEwLTEwIFx1NzUyOFx1NjIzN1x1NjMwN1x1NEVFNDpcclxuICogXCJcdTVCRjlcdTZCQ0ZcdTRFMDBcdTRFMkFcdTUyOUZcdTgwRkQsXHU2QkNGXHU0RTAwXHU0RTJBXHU0RTFBXHU1MkExXHU2RDQxXHU3QTBCXHU1MTY4XHU5NzYyXHU3Njg0XHU5QThDXHU2NTM2XCIpXHUzMDAyXHJcbiAqXHJcbiAqIFx1NzZGNFx1NjNBNVx1NUJGOVx1NkUzMlx1NjdEM1x1NTQwRVx1NzY4NCBET00gXHU2NUFEXHU4QTAwKFx1NUUwM1x1NUM0MFx1NTFFMFx1NEY1NS9cdTUzRUZcdTg5QzFcdTYwMjcpLFx1NUU3Nlx1NzUyOFx1NTM5Rlx1NzUxRlx1NEU4Qlx1NEVGNlx1OUE3MVx1NTJBOCBSZWFjdFxyXG4gKiAoXHU1M0Q3XHU2M0E3XHU4RjkzXHU1MTY1XHU3NTI4XHU1MzlGXHU1NzhCIHNldHRlciArIGlucHV0IFx1NEU4Qlx1NEVGNjtcdTYzMDlcdTk0QUUgY2xpY2s7XHU5NTJFXHU3NkQ4XHU4RDcwIHdpbmRvd1xyXG4gKiBrZXlkb3duKVx1MzAwMmZha2UgXHU2QTIxXHU1RjBGXHU4REQxXHU1QjhDXHU2NTc0XHU0RUZCXHU1MkExXHU5NEZFKFx1NTNEMVx1OTAwMVx1MjE5Mlx1NURFNVx1NTE3N1x1MjE5Mlx1NUJBMVx1NjI3OVx1MjE5Mlx1NEVBNFx1NEVEOFx1NzI2OVx1MjE5Mlx1NkM0N1x1NjAzQik7XHJcbiAqIHJlYWwgXHU2QTIxXHU1RjBGXHU1M0VBXHU4REQxXHU1M0VBXHU4QkZCXHU1QjUwXHU5NkM2KFx1NEUwRFx1NTJBOFx1NzcxRlx1NUI5RVx1NEYxQVx1OEJERFx1MzAwMVx1NEUwRFx1NzBFNyB0b2tlbilcdTMwMDJcclxuICogXHU2QkNGXHU2QjY1XHU4RjkzXHU1MUZBIGBVSVZFUklGWSBQQVNTfEZBSUwgbmFtZSB8IGRldGFpbGAsXHU3RUQzXHU1QzNFIFNVTU1BUlksZXhpdCBjb2RlXHUzMDAyXHJcbiAqL1xyXG5pbXBvcnQgeyBhcHAsIHR5cGUgQnJvd3NlcldpbmRvdyB9IGZyb20gJ2VsZWN0cm9uJztcclxuaW1wb3J0IHsgbWtkaXIsIHdyaXRlRmlsZSB9IGZyb20gJ25vZGU6ZnMvcHJvbWlzZXMnO1xyXG5pbXBvcnQgeyBqb2luIH0gZnJvbSAnbm9kZTpwYXRoJztcclxuXHJcbmNvbnN0IHNsZWVwID0gKG1zOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+ID0+IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIG1zKSk7XHJcblxyXG5hc3luYyBmdW5jdGlvbiBydW5VaVZlcmlmeSh3aW46IEJyb3dzZXJXaW5kb3csIG1vZGU6ICdmYWtlJyB8ICdyZWFsJyk6IFByb21pc2U8dm9pZD4ge1xyXG4gIGNvbnN0IHNob3RzID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfU0hPVFMgPz8gam9pbihhcHAuZ2V0UGF0aCgndGVtcCcpLCAnaG1oLXVpdmVyaWZ5Jyk7XHJcbiAgYXdhaXQgbWtkaXIoc2hvdHMsIHsgcmVjdXJzaXZlOiB0cnVlIH0pLmNhdGNoKCgpID0+IHVuZGVmaW5lZCk7XHJcbiAgY29uc3QgcmVzdWx0czogQXJyYXk8W3N0cmluZywgYm9vbGVhbiwgc3RyaW5nXT4gPSBbXTtcclxuICBsZXQgc2hvdElkeCA9IDA7XHJcblxyXG4gIGNvbnN0IGpzID0gPFQ+KGNvZGU6IHN0cmluZyk6IFByb21pc2U8VD4gPT4gd2luLndlYkNvbnRlbnRzLmV4ZWN1dGVKYXZhU2NyaXB0KGNvZGUsIHRydWUpIGFzIFByb21pc2U8VD47XHJcbiAgY29uc3Qgc3RlcCA9IGFzeW5jIChuYW1lOiBzdHJpbmcsIGZuOiAoKSA9PiBQcm9taXNlPFtib29sZWFuLCBzdHJpbmddPik6IFByb21pc2U8dm9pZD4gPT4ge1xyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3QgW29rLCBkZXRhaWxdID0gYXdhaXQgZm4oKTtcclxuICAgICAgcmVzdWx0cy5wdXNoKFtuYW1lLCBvaywgZGV0YWlsXSk7XHJcbiAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgY29uc3QgZGV0YWlsID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgJiYgZXJyLnN0YWNrICE9PSB1bmRlZmluZWQgPyBlcnIuc3RhY2sgOiBTdHJpbmcoZXJyKTtcclxuICAgICAgcmVzdWx0cy5wdXNoKFtuYW1lLCBmYWxzZSwgZGV0YWlsLnNsaWNlKDAsIDMwMCldKTtcclxuICAgIH1cclxuICAgIGNvbnN0IGxhc3QgPSByZXN1bHRzW3Jlc3VsdHMubGVuZ3RoIC0gMV0hO1xyXG4gICAgY29uc29sZS5sb2coYFVJVkVSSUZZICR7bGFzdFsxXSA/ICdQQVNTJyA6ICdGQUlMJ30gfCAke2xhc3RbMF19IHwgJHtsYXN0WzJdfWApO1xyXG4gIH07XHJcbiAgLyoqIFx1OEY2RVx1OEJFMlx1NzZGNFx1NTIzMCBwcmVkaWNhdGVDb2RlIFx1OEZENFx1NTZERSB7b2s6dHJ1ZSwuLi59IFx1NjIxNlx1OEQ4NVx1NjVGNihcdThGRDRcdTU2REVcdTY3MDBcdTU0MEVcdTc2ODQgZGV0YWlsKVx1MzAwMiAqL1xyXG4gIGNvbnN0IHdhaXRGb3IgPSBhc3luYyAobGFiZWw6IHN0cmluZywgcHJlZGljYXRlQ29kZTogc3RyaW5nLCB0aW1lb3V0TXM6IG51bWJlcik6IFByb21pc2U8W2Jvb2xlYW4sIHN0cmluZ10+ID0+IHtcclxuICAgIGNvbnN0IHN0YXJ0ZWQgPSBEYXRlLm5vdygpO1xyXG4gICAgZm9yICg7Oykge1xyXG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdHJ5IHsgcmV0dXJuIEpTT04uc3RyaW5naWZ5KChmdW5jdGlvbigpeyAke3ByZWRpY2F0ZUNvZGV9IH0pKCkpOyB9IGNhdGNoKGUpeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe29rOmZhbHNlLCBkZXRhaWw6U3RyaW5nKGUpLnNsaWNlKDAsMTIwKX0pOyB9IH0pKClgKSkgYXMgc3RyaW5nO1xyXG4gICAgICBsZXQgcGFyc2VkOiB7IG9rPzogYm9vbGVhbjsgZGV0YWlsPzogc3RyaW5nIH07XHJcbiAgICAgIHRyeSB7IHBhcnNlZCA9IEpTT04ucGFyc2UocikgYXMgeyBvaz86IGJvb2xlYW47IGRldGFpbD86IHN0cmluZyB9OyB9IGNhdGNoIHsgcGFyc2VkID0geyBvazogZmFsc2UsIGRldGFpbDogU3RyaW5nKHIpLnNsaWNlKDAsIDEyMCkgfTsgfVxyXG4gICAgICBpZiAocGFyc2VkLm9rID09PSB0cnVlKSByZXR1cm4gW3RydWUsIFN0cmluZyhwYXJzZWQuZGV0YWlsID8/ICcnKV07XHJcbiAgICAgIGlmIChEYXRlLm5vdygpIC0gc3RhcnRlZCA+IHRpbWVvdXRNcykgcmV0dXJuIFtmYWxzZSwgYCR7bGFiZWx9OiAke1N0cmluZyhwYXJzZWQuZGV0YWlsID8/ICd0aW1lb3V0Jyl9YF07XHJcbiAgICAgIGF3YWl0IHNsZWVwKDI1MCk7XHJcbiAgICB9XHJcbiAgfTtcclxuICBjb25zdCBzaG90ID0gYXN5bmMgKGxhYmVsOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+ID0+IHtcclxuICAgIHNob3RJZHggKz0gMTtcclxuICAgIHRyeSB7XHJcbiAgICAgIGNvbnN0IGltZyA9IGF3YWl0IHdpbi53ZWJDb250ZW50cy5jYXB0dXJlUGFnZSgpO1xyXG4gICAgICBhd2FpdCB3cml0ZUZpbGUoam9pbihzaG90cywgYCR7bW9kZX0tJHtTdHJpbmcoc2hvdElkeCkucGFkU3RhcnQoMiwgJzAnKX0tJHtsYWJlbH0ucG5nYCksIGltZy50b1BORygpKTtcclxuICAgIH0gY2F0Y2ggeyAvKiBcdTYyMkFcdTU2RkVcdTU5MzFcdThEMjVcdTRFMERcdTUyMjRcdTZCN0IgKi8gfVxyXG4gIH07XHJcblxyXG4gIC8qIC0tLS0gXHU1M0Q3XHU2M0E3XHU4RjkzXHU1MTY1KFJlYWN0Olx1NTM5Rlx1NTc4QiBzZXR0ZXIgXHU4OUU2XHU1M0QxIG9uQ2hhbmdlKSAtLS0tICovXHJcbiAgY29uc3QgdHlwZUludG8gPSAoc2VsOiBzdHJpbmcsIHRleHQ6IHN0cmluZyk6IFByb21pc2U8dW5rbm93bj4gPT5cclxuICAgIGpzKGAoZnVuY3Rpb24oKXtcclxuICAgICAgdmFyIGVsID0gZG9jdW1lbnQucXVlcnlTZWxlY3Rvcigke0pTT04uc3RyaW5naWZ5KHNlbCl9KTtcclxuICAgICAgaWYgKCFlbCkgcmV0dXJuICdOT0VMJztcclxuICAgICAgdmFyIHByb3RvID0gZWwudGFnTmFtZSA9PT0gJ1RFWFRBUkVBJyA/IEhUTUxUZXh0QXJlYUVsZW1lbnQucHJvdG90eXBlIDogSFRNTElucHV0RWxlbWVudC5wcm90b3R5cGU7XHJcbiAgICAgIE9iamVjdC5nZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IocHJvdG8sICd2YWx1ZScpLnNldC5jYWxsKGVsLCAke0pTT04uc3RyaW5naWZ5KHRleHQpfSk7XHJcbiAgICAgIGVsLmRpc3BhdGNoRXZlbnQobmV3IEV2ZW50KCdpbnB1dCcsIHsgYnViYmxlczogdHJ1ZSB9KSk7XHJcbiAgICAgIHJldHVybiAnT0snO1xyXG4gICAgfSkoKWApO1xyXG5cclxuICAvKiAtLS0tIFx1NTQyRlx1NTJBOFx1N0I0OVx1NUY4NTpSZWFjdCBcdTYzMDJcdThGN0QgKyBob3N0IFx1N0VGRlx1NzBCOShyZWFsIFx1NzY4NCBobWhhcm5lc3MgXHU1MUI3XHU1NDJGXHU1MkE4XHU4OTgxXHU3RjE2XHU4QkQxXHJcbiAgICAgXHU2NTc0XHU1OTU3IENMSSBcdTRGOURcdThENTYsXHU1M0VGXHU1MjMwIDMwcys7XHU0RTBEXHU3QjQ5XHU3RUZGXHU3MEI5XHU1QzMxXHU1RjAwXHU4REQxXHU0RjFBXHU1MTY4XHU5MEU4XHU4RDg1XHU2NUY2XHU4QkVGXHU2MkE1KSAtLS0tICovXHJcbiAgYXdhaXQgd2FpdEZvcignaG9zdCByZWFkeScsIGB2YXIgdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY29tcG9zZXIgdGV4dGFyZWEnKTsgcmV0dXJuIHtvazogISF0LCBkZXRhaWw6IHQgPyAnbW91bnRlZCcgOiAnbm8gY29tcG9zZXInfTtgLCAyMF8wMDApO1xyXG4gIGF3YWl0IHdhaXRGb3IoJ2hvc3QgZG90IG9uJywgYHZhciBkPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ob3N0LWRvdCcpOyByZXR1cm4ge29rOiAhIWQgJiYgZC5jbGFzc0xpc3QuY29udGFpbnMoJ29uJyksIGRldGFpbDogZCA/IGQuY2xhc3NOYW1lIDogJ25vIGRvdCd9O2AsIG1vZGUgPT09ICdyZWFsJyA/IDYwXzAwMCA6IDIwXzAwMCk7XHJcbiAgYXdhaXQgc2xlZXAoMV8yMDApOyAvLyBcdTRGMUFcdThCRERcdTUyMTdcdTg4NjgvXHU5ODc2XHU2ODBGXHU2NTcwXHU2MzZFXHU4NDNEXHU1NzMwXHJcblxyXG4gIC8qID09PT09PT09PT0gXHU5MDFBXHU3NTI4Olx1NUUwM1x1NUM0MFx1NTFFMFx1NEY1NShcdTc1MjhcdTYyMzdcdTYyQTVcdTk2OUNcdTc2ODRcdTc2RjRcdTYzQTVcdTY1QURcdThBMDApID09PT09PT09PT0gKi9cclxuICBhd2FpdCBzdGVwKCdcdTVFMDNcdTVDNDA6XHU2ODA3XHU5ODk4XHU2ODBGK1x1NEUwOVx1NjgwRitjb21wb3NlciBcdTU3MjhcdTg5QzZcdTUzRTNcdTUxODUoXHU4RjkzXHU1MTY1XHU2ODQ2XHU1M0VGXHU4OUMxKScsIGFzeW5jICgpID0+IHtcclxuICAgIGNvbnN0IHIgPSAoYXdhaXQganMoYChmdW5jdGlvbigpe1xyXG4gICAgICB2YXIgcSA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IuYmluZChkb2N1bWVudCk7XHJcbiAgICAgIHZhciB0YiA9IHEoJy50aXRsZWJhcicpLCBzaGVsbCA9IHEoJy5hcHAtc2hlbGwnKSwgc2IgPSBxKCcuc2lkZWJhcicpLCB3cyA9IHEoJy53b3Jrc3BhY2UnKSwgdGEgPSBxKCcuY29tcG9zZXIgdGV4dGFyZWEnKTtcclxuICAgICAgdmFyIG1pc3NpbmcgPSBbIXRiICYmICd0aXRsZWJhcicsICFzaGVsbCAmJiAnc2hlbGwnLCAhc2IgJiYgJ3NpZGViYXInLCAhd3MgJiYgJ3dvcmtzcGFjZScsICF0YSAmJiAndGV4dGFyZWEnXS5maWx0ZXIoQm9vbGVhbikuam9pbignLCcpO1xyXG4gICAgICBpZiAobWlzc2luZyAhPT0gJycpIHJldHVybiBKU09OLnN0cmluZ2lmeSh7b2s6ZmFsc2UsIGRldGFpbDonbWlzc2luZzonK21pc3Npbmd9KTtcclxuICAgICAgdmFyIHIgPSB0YS5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKSwgdmggPSB3aW5kb3cuaW5uZXJIZWlnaHQsIHZ3ID0gd2luZG93LmlubmVyV2lkdGg7XHJcbiAgICAgIHZhciBoaW50ID0gcSgnLmVtcHR5LWhpbnQuYmlnJyk7IHZhciBociA9IGhpbnQgPyBoaW50LmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpIDogbnVsbDtcclxuICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHsgb2s6IHIuaGVpZ2h0ID4gMzAgJiYgci5ib3R0b20gPD0gdmggJiYgci53aWR0aCA+IDEwMCAmJiBociAhPT0gbnVsbCAmJiBoci50b3AgPj0gMCAmJiBoci5ib3R0b20gPD0gdmgsXHJcbiAgICAgICAgZGV0YWlsOiAndGV4dGFyZWEgeT0nK01hdGgucm91bmQoci55KSsnIGg9JytNYXRoLnJvdW5kKHIuaGVpZ2h0KSsnIGJvdHRvbT0nK01hdGgucm91bmQoci5ib3R0b20pKycgdmg9Jyt2aCsoaHIgPyAnIGhpbnQgeT0nK01hdGgucm91bmQoaHIueSkgOiAnIG5vLWhpbnQnKSB9KTtcclxuICAgIH0pKClgKSkgYXMgc3RyaW5nO1xyXG4gICAgY29uc3QgcCA9IEpTT04ucGFyc2UocikgYXMgeyBvazogYm9vbGVhbjsgZGV0YWlsOiBzdHJpbmcgfTtcclxuICAgIHJldHVybiBbcC5vayA9PT0gdHJ1ZSwgcC5kZXRhaWxdO1xyXG4gIH0pO1xyXG5cclxuICBpZiAobW9kZSA9PT0gJ2Zha2UnKSB7XHJcbiAgICAvKiA9PT09PT09PT09IGZha2UoXHU1NDExXHU1QkZDXHU2Nzg0XHU5MDIwLEhNSF9ERVNLVE9QX1VJVkVSSUZZX1dJWkFSRD1mYWtlKTpcclxuICAgICAgIFx1NEYyQVx1OTAyMFx1NjcyQVx1OTE0RFx1N0Y2RVx1NjAwMSBcdTIxOTIgXHU1NDExXHU1QkZDXHU1MUZBXHU3M0IwIFx1MjE5MiBcdTY4QzBcdTZENEIoXHU2NzJBXHU4OEM1KVx1MjE5MiBcdTkwMDlcdTYyRTkgXHUyMTkyIFx1NTE4NVx1N0Y2RSBcdTIxOTIgXHU4RkRFXHU0RTBBID09PT09PT09PT0gKi9cclxuICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9XSVpBUkQgPT09ICdmYWtlJykge1xyXG4gICAgICBhd2FpdCBzdGVwKCdcdTU0MTFcdTVCRkM6XHU5OTk2XHU1NDJGXHU1RjM5XHU1MUZBXHU2QjIyXHU4RkNFXHU5ODc1KFx1NUYwMFx1NTlDQlx1OTE0RFx1N0Y2RS9cdTZGMTRcdTc5M0FcdTUxNjVcdTUzRTMpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCd3aXphcmQgb3ZlcmxheScsIGB2YXIgbz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKTtcclxuICAgICAgICAgIHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTVGMDBcdTU5Q0JcdTkxNERcdTdGNkUnO30pO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogISFvICYmICEhYiwgZGV0YWlsOiBvID8gJ292ZXJsYXkrXHU1RjAwXHU1OUNCXHU5MTREXHU3RjZFJyA6ICdubyBvdmVybGF5J307YCwgMTJfMDAwKTtcclxuICAgICAgICBhd2FpdCBzaG90KCd3aXphcmQtd2VsY29tZScpO1xyXG4gICAgICAgIHJldHVybiB3O1xyXG4gICAgICB9KTtcclxuICAgICAgYXdhaXQgc3RlcCgnXHU1NDExXHU1QkZDOlx1NUYwMFx1NTlDQlx1OTE0RFx1N0Y2RVx1MjE5Mlx1NjhDMFx1NkQ0QihcdTRGMkFcdTkwMjBcdTY3MkFcdTg4QzUpXHUyMTkyXHU2NzJBXHU4OEM1XHU1MzczXHU4MUVBXHU1MkE4XHU1Qjg5XHU4OEM1XHU5ODc1KFx1OEJGNFx1NjYwRVx1NkEyQVx1NUU0NStcdTUyMDdcdTYzNjJcdTk0RkVcdTYzQTUpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NUYwMFx1NTlDQlx1OTE0RFx1N0Y2RSc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdhdXRvIGluc3RhbGwgcGFnZScsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtaW5zdGFsbCcpO1xyXG4gICAgICAgICAgaWYoIXApIHJldHVybiB7b2s6ZmFsc2UsIGRldGFpbDonbm90IG9uIGluc3RhbGwnfTtcclxuICAgICAgICAgIHZhciB0PXAudGV4dENvbnRlbnQ7XHJcbiAgICAgICAgICB2YXIgbm90ZT10LmluZGV4T2YoJ1x1NjcyQVx1NjhDMFx1NkQ0Qlx1NTIzMCBobWggQ0xJLFx1NURGMlx1ODFFQVx1NTJBOFx1NUYwMFx1NTlDQlx1NUI4OVx1ODhDNScpPj0wO1xyXG4gICAgICAgICAgdmFyIGwxPXQuaW5kZXhPZignXHU2NTM5XHU3NTI4XHU1MTg1XHU3RjZFXHU3Q0JFXHU3QjgwXHU1MTg1XHU2ODM4Jyk+PTAsIGwyPXQuaW5kZXhPZignXHU2RjE0XHU3OTNBXHU2QTIxXHU1RjBGJyk+PTA7XHJcbiAgICAgICAgICB2YXIgYmFyPSEhcC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLXByb2dyZXNzJyk7XHJcbiAgICAgICAgICB2YXIgc2VsPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1zZWxlY3QnKTtcclxuICAgICAgICAgIHJldHVybiB7b2s6IG5vdGUmJmwxJiZsMiYmYmFyJiYhc2VsLCBkZXRhaWw6ICdub3RlPScrbm90ZSsnIFx1NTE4NVx1N0Y2RVx1OTRGRVx1NjNBNT0nK2wxKycgXHU2RjE0XHU3OTNBXHU5NEZFXHU2M0E1PScrbDIrJyBiYXI9JytiYXIrJyBzZWxlY3RMZWFrPScrISFzZWx9O2AsIDEyXzAwMCk7XHJcbiAgICAgICAgYXdhaXQgc2hvdCgnd2l6YXJkLWF1dG8taW5zdGFsbCcpO1xyXG4gICAgICAgIHJldHVybiB3O1xyXG4gICAgICB9KTtcclxuICAgICAgYXdhaXQgc3RlcCgnXHU1NDExXHU1QkZDOlx1NkEyQVx1NUU0NVwiXHU2NTM5XHU3NTI4XHU1MTg1XHU3RjZFXHU3Q0JFXHU3QjgwXHU1MTg1XHU2ODM4XCJcdTIxOTJcdTkxNERcdTdGNkVcdThERjNcdThGQzdcdTIxOTJcdTVCOENcdTYyMTBcdTk4NzVcdTIxOTJcdTVGMDBcdTU5Q0JcdTRGN0ZcdTc1MjhcdTIxOTJcdTUxNzNcdTk1RURcdTRFMTRcdTVERjJcdThGREVcdTYzQTUnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtcGFnZS1pbnN0YWxsIC53aXphcmQtYWx0LWxpbmsnKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTY1MzlcdTc1MjhcdTUxODVcdTdGNkVcdTdDQkVcdTdCODBcdTUxODVcdTY4MzgnKT49MDt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgLy8gXHU5MTREXHU3RjZFXHU5ODc1OmZha2UgcHJvdmlkZXJzIFx1NURGMlx1NjcwOVx1NUJDNlx1OTRBNSBcdTIxOTIgXHU4MUVBXHU1MkE4XHU4REYzXHU4RkM3O1x1NTE1Q1x1NUU5NVx1NzBCOVwiXHU4REYzXHU4RkM3XCJcclxuICAgICAgICBhd2FpdCB3YWl0Rm9yKCdjb25maWcgb3IgZG9uZScsIGB2YXIgZD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtZG9uZScpO1xyXG4gICAgICAgICAgaWYoZCkgcmV0dXJuIHtvazp0cnVlLCBkZXRhaWw6J2RvbmUnfTtcclxuICAgICAgICAgIHZhciBjPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1jb25maWcnKTtcclxuICAgICAgICAgIGlmKGMpeyB2YXIgcz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdcdThERjNcdThGQzcnKT49MDt9KTsgaWYocykgcy5jbGljaygpOyB9XHJcbiAgICAgICAgICByZXR1cm4ge29rOmZhbHNlLCBkZXRhaWw6J3dhaXRpbmcnfTtgLCAxNV8wMDApO1xyXG4gICAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdkb25lIHBhZ2UnLCBgdmFyIGQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1jYXJkLndpemFyZC1wYWdlLWRvbmUnKTtcclxuICAgICAgICAgIHZhciB0PWQ/ZC50ZXh0Q29udGVudDonJztcclxuICAgICAgICAgIHJldHVybiB7b2s6ICEhZCAmJiB0LmluZGV4T2YoJ1x1NUMzMVx1N0VFQScpPj0wICYmIHQuaW5kZXhPZignXHU1MTcxXHU0RUFCJyk+PTAsIGRldGFpbDogdC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNjApfTtgLCA4XzAwMCk7XHJcbiAgICAgICAgYXdhaXQgc2hvdCgnd2l6YXJkLWRvbmUnKTtcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTVGMDBcdTU5Q0JcdTRGN0ZcdTc1MjgnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICBjb25zdCBjbG9zZWQgPSBhd2FpdCB3YWl0Rm9yKCd3aXphcmQgY2xvc2VkICsgY29ubmVjdGVkJywgYHJldHVybiB7b2s6ICFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKSAmJiAhIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ob3N0LWRvdC5vbicpLFxyXG4gICAgICAgICAgZGV0YWlsOiAnb3ZlcmxheT0nKyhkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKT8nb3Blbic6J2Nsb3NlZCcpKycgZG90PScrKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ob3N0LWRvdC5vbicpPydvbic6J29mZicpfTtgLCAxMF8wMDApO1xyXG4gICAgICAgIHJldHVybiBbd1swXSAmJiBjbG9zZWRbMF0sIGBkb25lOiAke3dbMV19OyAke2Nsb3NlZFsxXX1gXTtcclxuICAgICAgfSk7XHJcbiAgICB9XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1OTk5Nlx1OEREMVx1NUYxNVx1NUJGQ1x1NUM0MiA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTVGMTVcdTVCRkNcdTVDNDI6XHU2RjE0XHU3OTNBXHU2QTIxXHU1RjBGXHU2M0QwXHU3OTNBXHU1MUZBXHU3M0IwXHU1RTc2XHU1M0VGXHU1MTczXHU5NUVEJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignZ3VpZGUnLCBgdmFyIGc9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnJ1bnRpbWUtZ3VpZGUnKTsgcmV0dXJuIHtvazogISFnLCBkZXRhaWw6IGcgPyAnc2hvd24nIDogJ25vdCBzaG93bid9O2AsIDhfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpe1xyXG4gICAgICAgIHZhciBidG5zID0gW10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcucnVudGltZS1ndWlkZSBidXR0b24nKSk7XHJcbiAgICAgICAgdmFyIGIgPSBidG5zLmZpbmQoZnVuY3Rpb24oeCl7IHJldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1NkYxNFx1NzkzQScpID49IDA7IH0pO1xyXG4gICAgICAgIGlmIChiKSBiLmNsaWNrKCk7XHJcbiAgICAgIH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2d1aWRlIGdvbmUnLCBgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5ydW50aW1lLWd1aWRlJyksIGRldGFpbDogZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnJ1bnRpbWUtZ3VpZGUnKSA/ICdzdGlsbCcgOiAnZGlzbWlzc2VkJ307YCwgNV8wMDApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NjVCMFx1NUVGQVx1NEYxQVx1OEJERChDdHJsK04pID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ0N0cmwrTiBcdTY1QjBcdTVFRkFcdTRGMUFcdThCREQsXHU4RjkzXHU1MTY1XHU2ODQ2XHU1M0VGXHU3NTI4JywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OiduJywgY3RybEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ3RleHRhcmVhIGVuYWJsZWQnLCBgdmFyIHQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNvbXBvc2VyIHRleHRhcmVhJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISF0ICYmIHQuZGlzYWJsZWQgPT09IGZhbHNlICYmICh0LnBsYWNlaG9sZGVyfHwnJykuaW5kZXhPZignXHU2M0NGXHU4RkYwXHU3NkVFXHU2ODA3JykgPj0gMCwgZGV0YWlsOiB0ID8gKCdkaXNhYmxlZD0nK3QuZGlzYWJsZWQrJyBwaD0nKyh0LnBsYWNlaG9sZGVyfHwnJykuc2xpY2UoMCwyMCkpIDogJ25vIHRhJ307YCwgNV8wMDApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NTNEMVx1OTAwMVx1NEVGQlx1NTJBMSBcdTIxOTIgXHU3NTI4XHU2MjM3XHU4RjZFXHU1MUZBXHU3M0IwKFx1NEUxNFx1NEVDNVx1NEUwMFx1Njc2MSxcdTUzQ0NcdTZEODhcdTYwNkZcdTU2REVcdTVGNTIpID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1OEY5M1x1NTE2NVx1NUU3Nlx1NTNEMVx1OTAwMVx1NEVGQlx1NTJBMSxcdTc1MjhcdTYyMzdcdTZEODhcdTYwNkZcdTRFMEFcdTVDNEZcdTRFMTRcdTRFMERcdTkxQ0RcdTU5MEQnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IHR5cGVJbnRvKCcuY29tcG9zZXIgdGV4dGFyZWEnLCAnXHU5QThDXHU2NTM2XHU0RUZCXHU1MkExOlx1NTE5OVx1NTE2NVx1NEUwMFx1NEUyQVx1NjU4N1x1NEVGNicpO1xyXG4gICAgICBhd2FpdCBzbGVlcCgyMDApO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XHJcbiAgICAgICAgdmFyIGJ0bnMgPSBbXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jb21wb3NlciBidXR0b24nKSk7XHJcbiAgICAgICAgdmFyIGIgPSBidG5zLmZpbmQoZnVuY3Rpb24oeCl7IHJldHVybiB4LnRleHRDb250ZW50LnRyaW0oKSA9PT0gJ1x1NTNEMVx1OTAwMSc7IH0pO1xyXG4gICAgICAgIGlmIChiKSBiLmNsaWNrKCk7XHJcbiAgICAgIH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2V4YWN0bHkgb25lIHVzZXIgdHVybicsIGB2YXIgdHM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudHVybi51c2VyJykpLmZpbHRlcihmdW5jdGlvbih4KXsgcmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU5QThDXHU2NTM2XHU0RUZCXHU1MkExJykgPj0gMDsgfSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogdHMubGVuZ3RoID09PSAxLCBkZXRhaWw6ICdjb3VudD0nK3RzLmxlbmd0aCsnIHRleHQ9JysodHNbMF0/dHNbMF0udGV4dENvbnRlbnQuc2xpY2UoMCwzMCk6J25vbmUnKX07YCwgOF8wMDApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NURFNVx1NTE3N1x1NTM2MShyZWFkX2ZpbGUgXHU1QjhDXHU2MjEwKSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTVERTVcdTUxNzdcdTYyOThcdTUzRTBcdTUzNjE6cmVhZF9maWxlIFx1NjI2N1x1ODg0Q1x1NUU3Nlx1NUI4Q1x1NjIxMCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3Rvb2wgY2FyZCcsIGB2YXIgYz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50b29sLWNhcmQnKSk7XHJcbiAgICAgICAgdmFyIGRvbmUgPSBjLmZpbHRlcihmdW5jdGlvbih4KXsgcmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZigncmVhZF9maWxlJykgPj0gMCAmJiB4LnRleHRDb250ZW50LmluZGV4T2YoJyMgZGVtbycpID49IDA7IH0pO1xyXG4gICAgICAgIHJldHVybiB7b2s6IGRvbmUubGVuZ3RoID49IDEsIGRldGFpbDogJ2NhcmRzPScrYy5sZW5ndGgrJyBkb25lPScrZG9uZS5sZW5ndGh9O2AsIDhfMDAwKTtcclxuICAgICAgcmV0dXJuIHc7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU1QkExXHU2Mjc5XHU3RUI1XHU1MjA3XHU3MjQ3KFx1NzUyOFx1NjIzN1x1NjJBNVx1OTY5Q1x1NjgzOFx1NUZDM1x1NEU0Qlx1NEUwMCkgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU1QkExXHU2Mjc5OmFwcHJvdmFsIFx1NTM2MVx1NTFGQVx1NzNCMChcdTdCNDlcdTVGODVcdTRFQkFcdTVERTVcdTYyNzlcdTUxQzYpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBzaG90KCdhcHByb3ZhbC1wZW5kaW5nJyk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdhcHByb3ZhbCBjYXJkJywgYHZhciBhPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5hcHByb3ZhbC1jYXJkJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFhICYmIGEudGV4dENvbnRlbnQuaW5kZXhPZignXHU5NzAwXHU4OTgxXHU1QkExXHU2Mjc5JykgPj0gMCwgZGV0YWlsOiBhID8gYS50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsIDYwKSA6ICdubyBhcHByb3ZhbCBjYXJkJ307YCwgOF8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdcdTVCQTFcdTYyNzk6XHU3MEI5XHU2Mjc5XHU1MUM2IFx1MjE5MiBcdTRFRkJcdTUyQTFcdTdFRTdcdTdFRURcdTUyMzBcdTRFQTRcdTRFRDhcdTcyNjkrXHU2QzQ3XHU2MDNCJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XHJcbiAgICAgICAgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuYXBwcm92YWwtY2FyZCBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXsgcmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NjI3OVx1NTFDNic7IH0pO1xyXG4gICAgICAgIGlmIChiKSBiLmNsaWNrKCk7XHJcbiAgICAgIH0pKClgKTtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2FydGlmYWN0K3N1bScsIGB2YXIgYXJ0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5hcnRpZmFjdC1jYXJkJyk7XHJcbiAgICAgICAgdmFyIHN1bT1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudHVybi1zdW0nKTtcclxuICAgICAgICB2YXIgYXN0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnR1cm4nKSkuZmlsdGVyKGZ1bmN0aW9uKHgpeyByZXR1cm4geC5jbGFzc05hbWUuaW5kZXhPZigndXNlcicpPDAgJiYgeC50ZXh0Q29udGVudC5pbmRleE9mKCdlY2hvOicpPj0wOyB9KTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWFydCAmJiAhIXN1bSAmJiBhc3QubGVuZ3RoPj0xLCBkZXRhaWw6ICdhcnRpZmFjdD0nKyhhcnQ/YXJ0LnRleHRDb250ZW50LnNsaWNlKDAsMzApOidub25lJykrJyBzdW09Jysoc3VtP3N1bS50ZXh0Q29udGVudDonbm9uZScpKycgYW5zd2VyZWQ9Jythc3QubGVuZ3RofTtgLCAxMl8wMDApO1xyXG4gICAgICBhd2FpdCBzaG90KCdydW4tY29tcGxldGVkJyk7XHJcbiAgICAgIHJldHVybiB3O1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NTM4Nlx1NTNGMlx1NEYxQVx1OEJERFx1NTE4NVx1NUJCOShcdTc1MjhcdTYyMzdcdTYyQTVcdTk2OUNcIlx1NzcwQlx1NEUwRFx1NTIzMFx1NTE4NVx1NUJCOVwiKSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTcwQjlcdTUxRkJcdTUzODZcdTUzRjJcdTRGMUFcdThCREQgXHUyMTkyIHRyYW5zY3JpcHQgXHU1MTg1XHU1QkI5XHU1M0VGXHU4OUMxJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBpdD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2Vzc2lvbi1pdGVtJyk7IGlmIChpdCkgaXQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignaGlzdG9yeSB0dXJucycsIGB2YXIgdHM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudHVybicpKTtcclxuICAgICAgICByZXR1cm4ge29rOiB0cy5sZW5ndGggPj0gMiwgZGV0YWlsOiAndHVybnM9Jyt0cy5sZW5ndGgrJyBmaXJzdD0nKyh0c1swXT90c1swXS50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNDApOidub25lJyl9O2AsIDhfMDAwKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTRFOTRcdTk4NzVcdTdCN0UgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnRG9jazpPdmVydmlldyBcdTY1NzBcdTYzNkVcdTg4NEMnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdPdmVydmlldyc7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignb3ZlcnZpZXcgcm93cycsIGB2YXIgcm93cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXJvdycpKTtcclxuICAgICAgICB2YXIgdmVyID0gcm93cy5maW5kKGZ1bmN0aW9uKHIpeyByZXR1cm4gci50ZXh0Q29udGVudC5pbmRleE9mKCdydW50aW1lIFx1NzI0OFx1NjcyQycpPj0wOyB9KTtcclxuICAgICAgICByZXR1cm4ge29rOiByb3dzLmxlbmd0aCA+PSA1ICYmICEhdmVyLCBkZXRhaWw6ICdyb3dzPScrcm93cy5sZW5ndGgrKHZlcj8nIHZlcj0nK3Zlci50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNDApOicnKX07YCwgNl8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdEb2NrOkZpbGVzIFx1NkQ0Rlx1ODlDOCtcdTY1ODdcdTRFRjZcdTk4ODRcdTg5QzgnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdcdTY1ODdcdTRFRjYnfHx4LnRleHRDb250ZW50PT09J0ZpbGVzJzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdmcyByb3dzJywgYHZhciByb3dzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5mcy1yb3cnKS5sZW5ndGg7XHJcbiAgICAgICAgcmV0dXJuIHtvazogcm93cyA+PSAxLCBkZXRhaWw6ICdyb3dzPScrcm93c307YCwgNl8wMDApO1xyXG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICAvLyBcdTY4MzlcdTc2RUVcdTVGNTVcdTUzRUFcdTY3MDlcdTVERTVcdTRGNUNcdTUzM0FcdTc2RUVcdTVGNTUoZmFrZSBcdTRFMEVcdTc3MUZcdTVCOUUgcnVudGltZSBcdTU0MENcdTVGNjIpOlx1NTE0OFx1OEZEQlx1NzZFRVx1NUY1NSxcdTUxOERcdTcwQjlcdTY1ODdcdTRFRjZcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgZD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5mcy1yb3cnKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdkZW1vLXdvcmtzcGFjZScpPj0wIHx8IHgudGV4dENvbnRlbnQuaW5kZXhPZignXHVEODNEXHVEQ0MxJyk+PTA7fSk7IGlmKGQpIGQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCB3MiA9IGF3YWl0IHdhaXRGb3IoJ2ZpbGUgcm93cycsIGB2YXIgcm93cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5mcy1yb3cnKSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogcm93cy5zb21lKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1JFQURNRScpPj0wO30pLCBkZXRhaWw6ICdyb3dzPScrcm93cy5sZW5ndGh9O2AsIDZfMDAwKTtcclxuICAgICAgaWYgKCF3MlswXSkgcmV0dXJuIHcyO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBmPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmZzLXJvdycpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1JFQURNRScpPj0wO30pOyBpZihmKSBmLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2ZpbGUgcHJldmlldycsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuZnMtcHJldmlldycpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhcCAmJiBwLnRleHRDb250ZW50LmluZGV4T2YoJ2RlbW8gd29ya3NwYWNlJykgPj0gMCwgZGV0YWlsOiBwID8gcC50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNDApIDogJ25vIHByZXZpZXcnfTtgLCA2XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ0RvY2s6RGlmZiBcdTUzRDhcdTY2RjRcdTg4NEMnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay10YWInKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudD09PSdcdTUzRDhcdTY2RjQnfHx4LnRleHRDb250ZW50PT09J0RpZmYnO30pOyBpZih0KSB0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ2RpZmYgcm93cycsIGB2YXIgcm93cz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZGlmZi1yb3cnKS5sZW5ndGg7XHJcbiAgICAgICAgcmV0dXJuIHtvazogcm93cyA+PSAxLCBkZXRhaWw6ICdkaWZmIHJvd3M9Jytyb3dzfTtgLCA2XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ0RvY2s6RXZpZGVuY2UgXHU4QkE0XHU3N0U1XHU2NTcwXHU2MzZFJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nXHU4QkMxXHU2MzZFJ3x8eC50ZXh0Q29udGVudD09PSdFdmlkZW5jZSc7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignZXZpZGVuY2Ugcm93cycsIGB2YXIgcm93cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXJvdycpKTtcclxuICAgICAgICB2YXIgbWVtID0gcm93cy5maW5kKGZ1bmN0aW9uKHIpeyByZXR1cm4gci50ZXh0Q29udGVudC5pbmRleE9mKCdcdThCQjBcdTVGQzZcdTVDNDInKT49MCB8fCByLnRleHRDb250ZW50LmluZGV4T2YoJ01lbW9yeSBsYXllcnMnKT49MDsgfSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFtZW0gJiYgbWVtLnRleHRDb250ZW50LmluZGV4T2YoJzMnKSA+PSAwLCBkZXRhaWw6IG1lbSA/IG1lbS50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpIDogJ25vIG1lbW9yeSByb3cnfTtgLCA2XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ0RvY2s6TG9ncyBcdTk3NjJcdTY3N0YoXHU3QTdBXHU2MDAxXHU2M0QwXHU3OTNBKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J1x1NjVFNVx1NUZENyd8fHgudGV4dENvbnRlbnQ9PT0nTG9ncyc7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignbG9ncyBwYW5lJywgYHZhciBsPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5sb2dzLWxpc3QnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWwsIGRldGFpbDogbCA/ICgncm93cz0nK2wucXVlcnlTZWxlY3RvckFsbCgnLmxvZy1yb3cnKS5sZW5ndGgpIDogJ25vIGxvZ3MgbGlzdCd9O2AsIDVfMDAwKTtcclxuICAgICAgcmV0dXJuIHc7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6RG9jazpcdThGRENcdTdBMEJcdTk4NzVcdTdCN0UoXHU2MjRCXHU2NzNBXHU4RkRDXHU3QTBCXHU2M0E3XHU1MjM2XHU5NzYyXHU2NzdGK1x1NUYwMFx1NjczQVx1ODFFQVx1NTQyRlx1ODg0QykgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnRG9jazpcdThGRENcdTdBMEJcdTk4NzVcdTdCN0UoXHU2MjRCXHU2NzNBXHU4RkRDXHU3QTBCXHU2M0E3XHU1MjM2XHU5NzYyXHU2NzdGKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J1x1OEZEQ1x1N0EwQid8fHgudGV4dENvbnRlbnQ9PT0nUmVtb3RlJzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdyZW1vdGUgcGFuZScsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuZG9jay1ib2R5Jyk7XHJcbiAgICAgICAgdmFyIHQgPSBwID8gcC50ZXh0Q29udGVudCA6ICcnO1xyXG4gICAgICAgIHZhciBva1QgPSB0LmluZGV4T2YoJ1x1NjI0Qlx1NjczQVx1OEZEQ1x1N0EwQlx1NjNBN1x1NTIzNicpPj0wIHx8IHQuaW5kZXhPZignUGhvbmUgcmVtb3RlJyk+PTA7XHJcbiAgICAgICAgdmFyIG9rQSA9IHQuaW5kZXhPZignXHU1RjAwXHU2NzNBXHU4MUVBXHU1NDJGJyk+PTAgfHwgdC5pbmRleE9mKCdBdXRvc3RhcnQnKT49MDtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXAgJiYgb2tUICYmIG9rQSwgZGV0YWlsOiB0LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw2MCl9O2AsIDZfMDAwKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTY0MUNcdTdEMjJcdThGQzdcdTZFRTQgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU0RjFBXHU4QkREXHU2NDFDXHU3RDIyOlx1OEZDN1x1NkVFNFx1NzUxRlx1NjU0OCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgYmVmb3JlID0gKGF3YWl0IGpzKGBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoYCkpIGFzIG51bWJlcjtcclxuICAgICAgYXdhaXQgdHlwZUludG8oJy5zZXNzaW9uLXNlYXJjaCcsICd6enotXHU0RTBEXHU1QjU4XHU1NzI4XHU3Njg0XHU0RjFBXHU4QkREJyk7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdmaWx0ZXJlZCBlbXB0eScsIGB2YXIgbj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoO1xyXG4gICAgICAgIHJldHVybiB7b2s6IG4gPT09IDAsIGRldGFpbDogJ2FmdGVyPScrbn07YCwgNV8wMDApO1xyXG4gICAgICBhd2FpdCB0eXBlSW50bygnLnNlc3Npb24tc2VhcmNoJywgJycpO1xyXG4gICAgICBhd2FpdCBzbGVlcCg0MDApO1xyXG4gICAgICBjb25zdCBhZnRlciA9IChhd2FpdCBqcyhgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aGApKSBhcyBudW1iZXI7XHJcbiAgICAgIHJldHVybiBbd1swXSAmJiBhZnRlciA9PT0gYmVmb3JlLCBgJHt3WzFdfTsgXHU2MDYyXHU1OTBEXHU1NDBFICR7YWZ0ZXJ9PT09JHtiZWZvcmV9YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6Q3RybCtLIFx1NTQ3RFx1NEVFNFx1OTc2Mlx1Njc3RiA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdDdHJsK0sgXHU1NDdEXHU0RUU0XHU5NzYyXHU2NzdGOlx1NjI1M1x1NUYwMFx1NUU3Nlx1NjI2N1x1ODg0Q1x1NTQ3RFx1NEVFNCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleTonaycsIGN0cmxLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdjbWRrIG9wZW4nLCBgdmFyIGM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNtZGsnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWMsIGRldGFpbDogYyA/ICdvcGVuJyA6ICdub3Qgb3Blbid9O2AsIDVfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgaXQ9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY21kay1pdGVtJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU2NTg3XHU0RUY2Jyk+PTAgfHwgeC50ZXh0Q29udGVudC5pbmRleE9mKCdGaWxlcycpPj0wO30pOyBpZihpdCkgaXQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcigndGFiIHN3aXRjaGVkJywgYHZhciB0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5kb2NrLXRhYi5hY3RpdmUnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXQgJiYgKHQudGV4dENvbnRlbnQ9PT0nXHU2NTg3XHU0RUY2J3x8dC50ZXh0Q29udGVudD09PSdGaWxlcycpLCBkZXRhaWw6ICdhY3RpdmU9JysodD90LnRleHRDb250ZW50Oidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdThCQkVcdTdGNkVcdTk3NjJcdTY3N0YgPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnXHU4QkJFXHU3RjZFKEN0cmwrU2hpZnQrUCk6UHJvdmlkZXIgXHU4ODY4XHU1MzU1XHU1M0VGXHU4OUMxLEVzYyBcdTUxNzNcdTk1RUQnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J3AnLCBjdHJsS2V5OnRydWUsIHNoaWZ0S2V5OnRydWUsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignc2V0dGluZ3Mgb3BlbicsIGB2YXIgcz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kay5zZXR0aW5ncycpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhcyAmJiAhIXMucXVlcnlTZWxlY3RvcignLnByb3ZpZGVyLWZvcm0nKSwgZGV0YWlsOiBzID8gJ29wZW4rZm9ybScgOiAnbm90IG9wZW4nfTtgLCA1XzAwMCk7XHJcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J0VzY2FwZScsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignc2V0dGluZ3MgY2xvc2VkJywgYHJldHVybiB7b2s6ICFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kay1vdmVybGF5JyksIGRldGFpbDogJ2Nsb3NlZCd9O2AsIDVfMDAwKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTppMThuIFx1OEJFRFx1OEEwMFx1NTIwN1x1NjM2MiA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdThCRURcdThBMDBcdTUyMDdcdTYzNjI6XHU0RTJEXHU2NTg3IFx1MjE5MiBFbmdsaXNoIFx1MjE5MiBcdTYwNjJcdTU5MERcdTRFMkRcdTY1ODcnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J3AnLCBjdHJsS2V5OnRydWUsIHNoaWZ0S2V5OnRydWUsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignc2V0dGluZ3Mgb3BlbicsIGB2YXIgcz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY21kay5zZXR0aW5ncycpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhcywgZGV0YWlsOiBzID8gJ29wZW4nIDogJ25vdCBvcGVuJ307YCwgNV8wMDApO1xyXG4gICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNtZGsuc2V0dGluZ3MgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J0VuZ2xpc2gnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgZW4gPSBhd2FpdCB3YWl0Rm9yKCdlbmdsaXNoIHNob3duJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyLWhlYWQgLmJ0bi5wcmltYXJ5Jyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFiICYmIGIudGV4dENvbnRlbnQgPT09ICcrIE5ldyBTZXNzaW9uJywgZGV0YWlsOiAnYnRuPScrKGI/Yi50ZXh0Q29udGVudDonbm9uZScpfTtgLCA1XzAwMCk7XHJcbiAgICAgIGF3YWl0IHNob3QoJ2VuZ2xpc2gnKTtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jbWRrLnNldHRpbmdzIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTRFMkRcdTY1ODcnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgemggPSBhd2FpdCB3YWl0Rm9yKCdjaGluZXNlIGJhY2snLCBgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXItaGVhZCAuYnRuLnByaW1hcnknKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWIgJiYgYi50ZXh0Q29udGVudCA9PT0gJysgXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREJywgZGV0YWlsOiAnYnRuPScrKGI/Yi50ZXh0Q29udGVudDonbm9uZScpfTtgLCA1XzAwMCk7XHJcbiAgICAgIGF3YWl0IGpzKGB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgS2V5Ym9hcmRFdmVudCgna2V5ZG93bicsIHtrZXk6J0VzY2FwZScsIGJ1YmJsZXM6dHJ1ZX0pKWApO1xyXG4gICAgICByZXR1cm4gW2VuWzBdICYmIHpoWzBdLCBgZW46ICR7ZW5bMV19OyB6aDogJHt6aFsxXX1gXTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTVERTVcdTRGNUNcdTUzM0FcdTdCQTFcdTc0MDYoXHU1REU2XHU2ODBGXHU2ODBGXHU0RjREICsgXHU4M0RDXHU1MzU1ICsgXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREXHU5MDA5XHU1REU1XHU0RjVDXHU1MzNBKSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTVERTVcdTRGNUNcdTUzM0E6XHU1REU2XHU2ODBGXHU1REU1XHU0RjVDXHU1MzNBXHU2ODBGXHU1M0VGXHU4OUMxKFx1NUY1M1x1NTI0RFx1NURFNVx1NEY1Q1x1NTMzQVx1NTQwRCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCd3b3Jrc3BhY2UgYmFyJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53b3Jrc3BhY2UtYmFyJyk7XHJcbiAgICAgICAgdmFyIG4gPSBiID8gKGIucXVlcnlTZWxlY3RvcignLndzLWJhci1uYW1lJyl8fHt9KS50ZXh0Q29udGVudCA6ICcnO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYiAmJiAhIW4gJiYgbi5sZW5ndGggPiAwICYmIG4uaW5kZXhPZignXHU1MkEwXHU4RjdEJykgPCAwLCBkZXRhaWw6ICdiYXI9JysoYj8neWVzJzonbm8nKSsnIG5hbWU9JytufTtgLCA4XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ1x1NURFNVx1NEY1Q1x1NTMzQTpcdTgzRENcdTUzNTVcdTVGMzlcdTUxRkEsXHU1MjE3XHU4ODY4K1x1NUY1M1x1NTI0RFx1OUFEOFx1NEVBRStcdTZERkJcdTUyQTBcdTUxNjVcdTUzRTM7XHU1NzI4XHU2MzA3XHU1QjlBXHU1REU1XHU0RjVDXHU1MzNBXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53b3Jrc3BhY2UtYmFyJyk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignd3MgbWVudScsIGB2YXIgbT1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtbWVudScpO1xyXG4gICAgICAgIHZhciBpdGVtcyA9IG0gPyBtLnF1ZXJ5U2VsZWN0b3JBbGwoJy53cy1tZW51LWl0ZW0nKS5sZW5ndGggOiAwO1xyXG4gICAgICAgIHZhciBjdXIgPSBtID8gbS5xdWVyeVNlbGVjdG9yQWxsKCcud3MtbWVudS1pdGVtLmN1cnJlbnQnKS5sZW5ndGggOiAwO1xyXG4gICAgICAgIHZhciBhZGQgPSBtID8gKG0udGV4dENvbnRlbnQuaW5kZXhPZignXHU2REZCXHU1MkEwXHU1REU1XHU0RjVDXHU1MzNBJyk+PTAgfHwgbS50ZXh0Q29udGVudC5pbmRleE9mKCdBZGQgd29ya3NwYWNlJyk+PTApIDogZmFsc2U7XHJcbiAgICAgICAgcmV0dXJuIHtvazogaXRlbXMgPj0gMSAmJiBjdXIgPj0gMSAmJiBhZGQsIGRldGFpbDogJ2l0ZW1zPScraXRlbXMrJyBjdXJyZW50PScrY3VyKycgYWRkPScrYWRkfTtgLCA2XzAwMCk7XHJcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgIGF3YWl0IHNob3QoJ3dzLW1lbnUnKTtcclxuICAgICAgLy8gXHU3MEI5XHU3QjJDXHU0RTAwXHU0RTJBXHU1REU1XHU0RjVDXHU1MzNBXHU5ODc5ID0gXHU1NzI4XHU4QkU1XHU1REU1XHU0RjVDXHU1MzNBXHU2NUIwXHU1RUZBXHU0RjFBXHU4QkREKFx1ODNEQ1x1NTM1NVx1NTE3M1x1OTVFRFx1MzAwMWNvbXBvc2VyIFx1NTNFRlx1NzUyOClcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgaXQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLW1lbnUtaXRlbScpOyBpZihpdCkgaXQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBjbG9zZWQgPSBhd2FpdCB3YWl0Rm9yKCdtZW51IGNsb3NlZCArIHNlc3Npb24gYWN0aXZlJywgYHZhciB0YT1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY29tcG9zZXIgdGV4dGFyZWEnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLW1lbnUnKSAmJiAhIXRhICYmIHRhLmRpc2FibGVkID09PSBmYWxzZSwgZGV0YWlsOiAnbWVudT0nKyhkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtbWVudScpPydvcGVuJzonY2xvc2VkJykrJyB0YT0nKyh0YT90YS5kaXNhYmxlZDonbm9uZScpfTtgLCA2XzAwMCk7XHJcbiAgICAgIHJldHVybiBbY2xvc2VkWzBdLCBgJHt3WzFdfTsgJHtjbG9zZWRbMV19YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU0RjFBXHU4QkREXHU2MzA5XHU1REU1XHU0RjVDXHU1MzNBXHU1MjA2XHU3RUM0ICsgXHU1QzU1XHU1RjAwL1x1NjUzNlx1OEQ3NyA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTRGMUFcdThCRERcdTUyMDZcdTdFQzQ6XHU3RUM0XHU1OTM0XHU1MUZBXHU3M0IwKFx1NURFNVx1NEY1Q1x1NTMzQVx1NTQwRCtcdTY1NzBcdTkxQ0YpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignZ3JvdXAgaGVhZCcsIGB2YXIgaD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtZ3JvdXAtaGVhZCcpO1xyXG4gICAgICAgIHZhciBuID0gaCA/IChoLnF1ZXJ5U2VsZWN0b3IoJy53cy1ncm91cC1uYW1lJyl8fHt9KS50ZXh0Q29udGVudCA6ICcnO1xyXG4gICAgICAgIHZhciBjID0gaCA/IChoLnF1ZXJ5U2VsZWN0b3IoJy53cy1ncm91cC1jb3VudCcpfHx7fSkudGV4dENvbnRlbnQgOiAnJztcclxuICAgICAgICByZXR1cm4ge29rOiAhIWggJiYgbi5sZW5ndGggPiAwICYmIGMubGVuZ3RoID4gMCwgZGV0YWlsOiAnbmFtZT0nK24rJyBjb3VudD0nK2N9O2AsIDhfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnXHU0RjFBXHU4QkREXHU1MjA2XHU3RUM0Olx1NzBCOVx1NTFGQlx1N0VDNFx1NTkzNFx1NjUzNlx1OEQ3NyxcdTUxOERcdTcwQjlcdTVDNTVcdTVGMDBcdTYwNjJcdTU5MEQnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IGJlZm9yZSA9IChhd2FpdCBqcyhgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aGApKSBhcyBudW1iZXI7XHJcbiAgICAgIGlmIChiZWZvcmUgPT09IDApIHJldHVybiBbZmFsc2UsICdubyBzZXNzaW9ucyB0byBncm91cCddO1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBoPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1ncm91cC1oZWFkJyk7IGlmKGgpIGguY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBjb2xsYXBzZWQgPSBhd2FpdCB3YWl0Rm9yKCdjb2xsYXBzZWQnLCBgdmFyIGc9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndzLWdyb3VwJyk7XHJcbiAgICAgICAgdmFyIGhpZGRlbiA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGggPCAke2JlZm9yZX07XHJcbiAgICAgICAgcmV0dXJuIHtvazogaGlkZGVuLCBkZXRhaWw6ICdpdGVtcz0nK2RvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGgrJyBiZWZvcmU9JHtiZWZvcmV9J307YCwgNV8wMDApO1xyXG4gICAgICBhd2FpdCBzaG90KCd3cy1ncm91cC1jb2xsYXBzZWQnKTtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgaD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtZ3JvdXAtaGVhZCcpOyBpZihoKSBoLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgZXhwYW5kZWQgPSBhd2FpdCB3YWl0Rm9yKCdleHBhbmRlZCBiYWNrJywgYHZhciBuPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5zZXNzaW9uLWl0ZW0nKS5sZW5ndGg7XHJcbiAgICAgICAgcmV0dXJuIHtvazogbiA+PSAke2JlZm9yZX0sIGRldGFpbDogJ2l0ZW1zPScrbn07YCwgNV8wMDApO1xyXG4gICAgICByZXR1cm4gW2NvbGxhcHNlZFswXSAmJiBleHBhbmRlZFswXSwgYGNvbGxhcHNlOiAke2NvbGxhcHNlZFsxXX07IGV4cGFuZDogJHtleHBhbmRlZFsxXX1gXTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTVGRUJcdTYzNzdcdTk1MkVcdTVFMkVcdTUyQTlcdTk3NjJcdTY3N0YoQ3RybCsvKSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTVGRUJcdTYzNzdcdTk1MkVcdTVFMkVcdTUyQTk6Q3RybCsvIFx1NjI1M1x1NUYwMCxFc2MgXHU1MTczXHU5NUVEJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OicvJywgY3RybEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3Nob3J0Y3V0cyBvcGVuJywgYHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrJyk7XHJcbiAgICAgICAgdmFyIHJvd3MgPSBzID8gcy5xdWVyeVNlbGVjdG9yQWxsKCcuc2hvcnRjdXQtcm93JykubGVuZ3RoIDogMDtcclxuICAgICAgICByZXR1cm4ge29rOiByb3dzID49IDUsIGRldGFpbDogJ3Jvd3M9Jytyb3dzfTtgLCA1XzAwMCk7XHJcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgIGF3YWl0IHNob3QoJ3Nob3J0Y3V0cycpO1xyXG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidFc2NhcGUnLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgcmV0dXJuIHdhaXRGb3IoJ3Nob3J0Y3V0cyBjbG9zZWQnLCBgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrLW92ZXJsYXknKSwgZGV0YWlsOiAnY2xvc2VkJ307YCwgNV8wMDApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NEZBN1x1NjgwRlx1NjUzNlx1N0YyOSArIFx1NzJCNlx1NjAwMVx1OEZDN1x1NkVFNCA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTRGQTdcdTY4MEZcdTY1MzZcdTdGMjk6XHUyMUU0IFx1NjUzNlx1OEQ3N1x1NURFNlx1NjgwRixcdTIxRTUgXHU1QzU1XHU1RjAwXHU2MDYyXHU1OTBEJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAvLyBISUcgUDMgXHU3RUM0MjpcdTIxRTQvXHUyMUU1IEVtb2ppIFx1NURGMlx1NjM2MiBTVkcgaWNvbixcdTYzMDlcdTk0QUVcdTRFRTUgYXJpYS1sYWJlbChcdTU0MkJcIlx1NEZBN1x1NjgwRlwiKVx1NUI5QVx1NEY0RFxyXG4gICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcigndG9nZ2xlIGJ0bicsIGB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50b3BiYXIgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuICh4LmdldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcpfHwnJykuaW5kZXhPZignXHU0RkE3XHU2ODBGJyk+PTA7fSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFiLCBkZXRhaWw6ICdidG49JysoYj9iLmdldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcpOidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50b3BiYXIgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuICh4LmdldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcpfHwnJykuaW5kZXhPZignXHU0RkE3XHU2ODBGJyk+PTA7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBoaWRkZW4gPSBhd2FpdCB3YWl0Rm9yKCdzaWRlYmFyIGhpZGRlbicsIGB2YXIgc2I9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXInKTtcclxuICAgICAgICB2YXIgZ29uZSA9ICFzYiB8fCBnZXRDb21wdXRlZFN0eWxlKHNiKS5kaXNwbGF5ID09PSAnbm9uZSc7XHJcbiAgICAgICAgcmV0dXJuIHtvazogZ29uZSwgZGV0YWlsOiAnZGlzcGxheT0nKyhzYj9nZXRDb21wdXRlZFN0eWxlKHNiKS5kaXNwbGF5Oidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50b3BiYXIgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuICh4LmdldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcpfHwnJykuaW5kZXhPZignXHU0RkE3XHU2ODBGJyk+PTA7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBzaG93biA9IGF3YWl0IHdhaXRGb3IoJ3NpZGViYXIgYmFjaycsIGB2YXIgc2I9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNpZGViYXInKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXNiICYmIGdldENvbXB1dGVkU3R5bGUoc2IpLmRpc3BsYXkgIT09ICdub25lJywgZGV0YWlsOiAnZGlzcGxheT0nKyhzYj9nZXRDb21wdXRlZFN0eWxlKHNiKS5kaXNwbGF5Oidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgICAgcmV0dXJuIFtoaWRkZW5bMF0gJiYgc2hvd25bMF0sIGBoaWRlOiAke2hpZGRlblsxXX07IHNob3c6ICR7c2hvd25bMV19YF07XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ1x1NzJCNlx1NjAwMVx1OEZDN1x1NkVFNDpcdTRFMEJcdTYyQzlcdTUyMDdcdTYzNjJcdTUyMzBcIlx1OEZEMFx1ODg0Q1x1NEUyRFwiXHU0RTBEXHU1RDI5XHU2RTgzXHU1RTc2XHU2MDYyXHU1OTBEJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCBzZWwgPSBhd2FpdCB3YWl0Rm9yKCdmaWx0ZXIgc2VsZWN0JywgYHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zdGF0dXMtZmlsdGVyJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFzICYmIHMub3B0aW9ucy5sZW5ndGggPj0gNCwgZGV0YWlsOiAnb3B0aW9ucz0nKyhzP3Mub3B0aW9ucy5sZW5ndGg6MCl9O2AsIDVfMDAwKTtcclxuICAgICAgaWYgKCFzZWxbMF0pIHJldHVybiBzZWw7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnN0YXR1cy1maWx0ZXInKTsgcy52YWx1ZT0ncnVubmluZyc7IHMuZGlzcGF0Y2hFdmVudChuZXcgRXZlbnQoJ2NoYW5nZScse2J1YmJsZXM6dHJ1ZX0pKTsgfSkoKWApO1xyXG4gICAgICBhd2FpdCBzbGVlcCg1MDApO1xyXG4gICAgICBjb25zdCByMSA9IChhd2FpdCBqcyhgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aGApKSBhcyBudW1iZXI7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIHM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnN0YXR1cy1maWx0ZXInKTsgcy52YWx1ZT0nYWxsJzsgcy5kaXNwYXRjaEV2ZW50KG5ldyBFdmVudCgnY2hhbmdlJyx7YnViYmxlczp0cnVlfSkpOyB9KSgpYCk7XHJcbiAgICAgIGF3YWl0IHNsZWVwKDUwMCk7XHJcbiAgICAgIGNvbnN0IHIyID0gKGF3YWl0IGpzKGBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuc2Vzc2lvbi1pdGVtJykubGVuZ3RoYCkpIGFzIG51bWJlcjtcclxuICAgICAgcmV0dXJuIFtyMiA+PSByMSAmJiByMiA+PSAxLCBgcnVubmluZz0ke3IxfSBhbGw9JHtyMn1gXTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZTpcdTZBMjFcdTU3OEJcdTkwMDlcdTYyRTlcdTU2NjgoXHU5ODc2XHU2ODBGXHU1MjA3XHU2MzYyIGNoYXQgXHU4REVGXHU3NTMxKSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTZBMjFcdTU3OEJcdTkwMDlcdTYyRTlcdTU2Njg6XHU5ODc2XHU2ODBGXHU4M0RDXHU1MzU1XHU1MjE3XHU1MUZBIHByb3ZpZGVycyBcdTVFNzZcdTUzRUZcdTUyMDdcdTYzNjInLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdtb2RlbCBidXR0b24nLCBgdmFyIGI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnRvcGJhci1tb2RlbC5hcy1idXR0b24nKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIWIgJiYgYi5kaXNhYmxlZCA9PT0gZmFsc2UsIGRldGFpbDogYiA/IGIudGV4dENvbnRlbnQgOiAnbm9uZSd9O2AsIDZfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudG9wYmFyLW1vZGVsLmFzLWJ1dHRvbicpOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgbSA9IGF3YWl0IHdhaXRGb3IoJ21vZGVsIG1lbnUnLCBgdmFyIG09ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLm1vZGVsLW1lbnUnKTtcclxuICAgICAgICB2YXIgaXRlbXMgPSBtID8gbS5xdWVyeVNlbGVjdG9yQWxsKCcud3MtbWVudS1pdGVtJykubGVuZ3RoIDogMDtcclxuICAgICAgICB2YXIgY3VyID0gbSA/IG0ucXVlcnlTZWxlY3RvckFsbCgnLndzLW1lbnUtaXRlbS5jdXJyZW50JykubGVuZ3RoIDogMDtcclxuICAgICAgICByZXR1cm4ge29rOiBpdGVtcyA+PSAyICYmIGN1ciA+PSAxLCBkZXRhaWw6ICdpdGVtcz0nK2l0ZW1zKycgY3VycmVudD0nK2N1cn07YCwgNV8wMDApO1xyXG4gICAgICBpZiAoIW1bMF0pIHJldHVybiBtO1xyXG4gICAgICBhd2FpdCBzaG90KCdtb2RlbC1tZW51Jyk7XHJcbiAgICAgIC8vIFx1NTIwN1x1NTIzMFx1N0IyQ1x1NEU4Q1x1NEUyQSBwcm92aWRlcihmYWtlOiBkZW1vLXZpc2lvbi9mYWtlLW0tdmlzaW9uKVxyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBpdHM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcubW9kZWwtbWVudSAud3MtbWVudS1pdGVtJykpOyB2YXIgaXQ9aXRzW2l0cy5sZW5ndGgtMV07IGlmKGl0KSBpdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdtb2RlbCBzd2l0Y2hlZCcsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcudG9wYmFyLW1vZGVsLmFzLWJ1dHRvbicpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYiAmJiBiLnRleHRDb250ZW50LmluZGV4T2YoJ2Zha2UtbS12aXNpb24nKSA+PSAwLCBkZXRhaWw6ICdiYWRnZT0nKyhiP2IudGV4dENvbnRlbnQ6J25vbmUnKX07YCwgNl8wMDApO1xyXG4gICAgfSk7XHJcblxyXG4gICAgLyogPT09PT09PT09PSBmYWtlOlx1NEUzQlx1OTg5OChcdTZENDVcdTgyNzJcdTc1MUZcdTY1NDhcdTIxOTJcdTYwNjJcdTU5MERcdTZERjFcdTgyNzIpID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1NEUzQlx1OTg5ODpcdThCQkVcdTdGNkVcdTUyMDdcdTZENDVcdTgyNzJcdTc1MUZcdTY1NDgsXHU2MDYyXHU1OTBEXHU2REYxXHU4MjcyJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidwJywgY3RybEtleTp0cnVlLCBzaGlmdEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3NldHRpbmdzIG9wZW4nLCBgdmFyIHM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNtZGsuc2V0dGluZ3MnKTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXMsIGRldGFpbDogcyA/ICdvcGVuJyA6ICdub3Qgb3Blbid9O2AsIDVfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jbWRrLnNldHRpbmdzIC5zZWcgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NkQ0NVx1ODI3Mid8fHgudGV4dENvbnRlbnQudHJpbSgpPT09J0xpZ2h0Jzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IGxpZ2h0ID0gYXdhaXQgd2FpdEZvcignbGlnaHQgdGhlbWUnLCBgdmFyIGR0PWRvY3VtZW50LmRvY3VtZW50RWxlbWVudC5kYXRhc2V0LnRoZW1lO1xyXG4gICAgICAgIHZhciBiZyA9IGdldENvbXB1dGVkU3R5bGUoZG9jdW1lbnQuYm9keSkuYmFja2dyb3VuZENvbG9yO1xyXG4gICAgICAgIHZhciBtID0gL1xcXFxkKy9nOyB2YXIgbnVtcz0oYmcubWF0Y2gobSl8fFsnMCcsJzAnLCcwJ10pLm1hcChOdW1iZXIpO1xyXG4gICAgICAgIHJldHVybiB7b2s6IGR0PT09J2xpZ2h0JyAmJiBudW1zWzBdPjIwMCAmJiBudW1zWzFdPjIwMCAmJiBudW1zWzJdPjIwMCwgZGV0YWlsOiAndGhlbWU9JytkdCsnIGJnPScrYmd9O2AsIDVfMDAwKTtcclxuICAgICAgYXdhaXQgc2hvdCgnbGlnaHQtdGhlbWUnKTtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jbWRrLnNldHRpbmdzIC5zZWcgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NkRGMVx1ODI3Mid8fHgudGV4dENvbnRlbnQudHJpbSgpPT09J0RhcmsnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgZGFyayA9IGF3YWl0IHdhaXRGb3IoJ2RhcmsgYmFjaycsIGByZXR1cm4ge29rOiBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuZGF0YXNldC50aGVtZT09PSdkYXJrJywgZGV0YWlsOiAndGhlbWU9Jytkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuZGF0YXNldC50aGVtZX07YCwgNV8wMDApO1xyXG4gICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidFc2NhcGUnLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgcmV0dXJuIFtsaWdodFswXSAmJiBkYXJrWzBdLCBgbGlnaHQ6ICR7bGlnaHRbMV19OyBkYXJrOiAke2RhcmtbMV19YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU5ODc2XHU2ODBGIFx1NEUyRC9FTiBcdTVGRUJcdTYzNzdcdTUyMDdcdTYzNjIoXHU1M0VGXHU1M0QxXHU3M0IwXHU2MDI3KSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTk4NzZcdTY4MEZcdTVGRUJcdTYzNzdcdTUyMDdcdTYzNjI6XHU0RTJEL0VOIFx1NEUwMFx1OTUyRVx1NTIwN1x1NjM2MicsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2xhbmcgc2VnJywgYHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5sYW5nLXNlZycpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhcyAmJiBzLnF1ZXJ5U2VsZWN0b3JBbGwoJ2J1dHRvbicpLmxlbmd0aCA9PT0gMiwgZGV0YWlsOiBzID8gJ3ByZXNlbnQnIDogJ2Fic2VudCd9O2AsIDVfMDAwKTtcclxuICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5sYW5nLXNlZyBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nRU4nO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgZW4gPSBhd2FpdCB3YWl0Rm9yKCdlbmdsaXNoJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5zaWRlYmFyLWhlYWQgLmJ0bi5wcmltYXJ5Jyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFiICYmIGIudGV4dENvbnRlbnQgPT09ICcrIE5ldyBTZXNzaW9uJywgZGV0YWlsOiAnYnRuPScrKGI/Yi50ZXh0Q29udGVudDonbm9uZScpfTtgLCA1XzAwMCk7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcubGFuZy1zZWcgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NEUyRCc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCB6aCA9IGF3YWl0IHdhaXRGb3IoJ2NoaW5lc2UgYmFjaycsIGB2YXIgYj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuc2lkZWJhci1oZWFkIC5idG4ucHJpbWFyeScpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYiAmJiBiLnRleHRDb250ZW50ID09PSAnKyBcdTY1QjBcdTVFRkFcdTRGMUFcdThCREQnLCBkZXRhaWw6ICdidG49JysoYj9iLnRleHRDb250ZW50Oidub25lJyl9O2AsIDVfMDAwKTtcclxuICAgICAgcmV0dXJuIFtlblswXSAmJiB6aFswXSwgYGVuOiAke2VuWzFdfTsgemg6ICR7emhbMV19YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHU3Qzk4XHU4RDM0XHU1NkZFXHU3MjQ3IFx1MjE5MiBcdTdGMjlcdTc1NjVcdTU2RkUgY2hpcCBcdTIxOTIgXHU1M0QxXHU5MDAxIFx1MjE5MiBydW50aW1lIFx1NjUzNlx1NTIzMCA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTdDOThcdThEMzRcdTU2RkVcdTcyNDc6XHU3RjI5XHU3NTY1XHU1NkZFIGNoaXAgKyBcdTUzRDFcdTkwMDFcdTU0MEUgcnVudGltZSBcdTY1MzZcdTUyMzBcdTU2RkVcdTcyNDcnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIC8vIFx1NjVCMFx1NUVGQVx1NEYxQVx1OEJERFx1Nzg2RVx1NEZERCBjb21wb3NlciBcdTUzRUZcdTc1MjhcclxuICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleTonbicsIGN0cmxLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XHJcbiAgICAgIGF3YWl0IHNsZWVwKDMwMCk7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXtcclxuICAgICAgICB2YXIgdGEgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY29tcG9zZXIgdGV4dGFyZWEnKTtcclxuICAgICAgICBpZiAoIXRhKSByZXR1cm47XHJcbiAgICAgICAgdmFyIGMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdjYW52YXMnKTtcclxuICAgICAgICBjLndpZHRoID0gODsgYy5oZWlnaHQgPSA4O1xyXG4gICAgICAgIHZhciBjdHggPSBjLmdldENvbnRleHQoJzJkJyk7XHJcbiAgICAgICAgY3R4LmZpbGxTdHlsZSA9ICcjM2Y5NjUwJzsgY3R4LmZpbGxSZWN0KDAsIDAsIDgsIDgpO1xyXG4gICAgICAgIGMudG9CbG9iKGZ1bmN0aW9uKGJsb2Ipe1xyXG4gICAgICAgICAgdmFyIGR0ID0gbmV3IERhdGFUcmFuc2ZlcigpO1xyXG4gICAgICAgICAgZHQuaXRlbXMuYWRkKG5ldyBGaWxlKFtibG9iXSwgJ3Bhc3RlZC5wbmcnLCB7dHlwZTogJ2ltYWdlL3BuZyd9KSk7XHJcbiAgICAgICAgICB0YS5kaXNwYXRjaEV2ZW50KG5ldyBDbGlwYm9hcmRFdmVudCgncGFzdGUnLCB7Y2xpcGJvYXJkRGF0YTogZHQsIGJ1YmJsZXM6IHRydWUsIGNhbmNlbGFibGU6IHRydWV9KSk7XHJcbiAgICAgICAgfSwgJ2ltYWdlL3BuZycpO1xyXG4gICAgICB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IGNoaXAgPSBhd2FpdCB3YWl0Rm9yKCdpbWFnZSBjaGlwJywgYHZhciBuPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5hdHQtY2hpcC5pbWcnKS5sZW5ndGg7XHJcbiAgICAgICAgcmV0dXJuIHtvazogbiA+PSAxLCBkZXRhaWw6ICdpbWcgY2hpcHM9JytufTtgLCA2XzAwMCk7XHJcbiAgICAgIGlmICghY2hpcFswXSkgcmV0dXJuIGNoaXA7XHJcbiAgICAgIGF3YWl0IHR5cGVJbnRvKCcuY29tcG9zZXIgdGV4dGFyZWEnLCAnXHU3NzBCXHU4RkQ5XHU1RjIwXHU1NkZFJyk7XHJcbiAgICAgIGF3YWl0IHNsZWVwKDIwMCk7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY29tcG9zZXIgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NTNEMVx1OTAwMSc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBjb25zdCBkb25lID0gYXdhaXQgd2FpdEZvcignaW1hZ2Ugc2VudCcsIGBcclxuICAgICAgICB2YXIgYXAgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuYXBwcm92YWwtY2FyZCBidXR0b24nKTtcclxuICAgICAgICBpZiAoYXAgJiYgYXAudGV4dENvbnRlbnQudHJpbSgpLmluZGV4T2YoJ1x1NjI3OVx1NTFDNicpPj0wKSBhcC5jbGljaygpO1xyXG4gICAgICAgIHZhciB0cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50dXJuJykpO1xyXG4gICAgICAgIHZhciBoaXQgPSB0cy5maWx0ZXIoZnVuY3Rpb24oeCl7IHJldHVybiB4LmNsYXNzTmFtZS5pbmRleE9mKCd1c2VyJyk8MCAmJiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1tpbWFnZXM6IDFdJykgPj0gMDsgfSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogaGl0Lmxlbmd0aCA+PSAxLCBkZXRhaWw6ICdydW50aW1lLWVjaG8td2l0aC1pbWFnZT0nK2hpdC5sZW5ndGh9O1xyXG4gICAgICBgLCAxNV8wMDApO1xyXG4gICAgICBhd2FpdCBzaG90KCdwYXN0ZWQtaW1hZ2UnKTtcclxuICAgICAgcmV0dXJuIGRvbmU7XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6XHVEODNEXHVEQ0NFIFx1NEUwQVx1NEYyMC9cdUQ4M0RcdURDQzEgXHU2RDRGXHU4OUM4XHU2MzA5XHU5NEFFXHU1QzMxXHU0RjREID09PT09PT09PT0gKi9cclxuICAgIGF3YWl0IHN0ZXAoJ1x1OTY0NFx1NEVGNlx1NEUwRVx1NzZFRVx1NUY1NVx1NTE2NVx1NTNFMzpcdUQ4M0RcdURDQ0UgXHU0RTBBXHU0RjIwICsgXHVEODNEXHVEQ0MxIFx1NkQ0Rlx1ODlDOFx1NjMwOVx1OTRBRVx1NUI1OFx1NTcyOCcsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgciA9IChhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7XHJcbiAgICAgICAgdmFyIHVwID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNvbXBvc2VyIGJ1dHRvblthcmlhLWxhYmVsKj1cIlx1NEUwQVx1NEYyMFwiXSwgLmNvbXBvc2VyIGJ1dHRvblthcmlhLWxhYmVsKj1cIlVwbG9hZFwiXScpO1xyXG4gICAgICAgIHZhciBiciA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53cy1waWNrZXIgYnV0dG9uJyk7XHJcbiAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHt1cDogISF1cCwgYnJvd3NlOiAhIWJyfSk7XHJcbiAgICAgIH0pKClgKSkgYXMgc3RyaW5nO1xyXG4gICAgICBjb25zdCBwID0gSlNPTi5wYXJzZShyKSBhcyB7IHVwOiBib29sZWFuOyBicm93c2U6IGJvb2xlYW4gfTtcclxuICAgICAgcmV0dXJuIFtwLnVwICYmIHAuYnJvd3NlLCBgXHVEODNEXHVEQ0NFPSR7cC51cH0gXHVEODNEXHVEQ0MxPSR7cC5icm93c2V9YF07XHJcbiAgICB9KTtcclxuXHJcbiAgICAvKiA9PT09PT09PT09IGZha2U6QCBcdTk2NDRcdTRFRjZcdTkwMDlcdTYyRTlcdTU2NjggPT09PT09PT09PSAqL1xyXG4gICAgYXdhaXQgc3RlcCgnQCBcdTk2NDRcdTRFRjY6XHU5MDA5XHU2MkU5XHU1NjY4XHU1MUZBXHU3M0IwXHU1RTc2XHU1M0VGXHU5MDA5XHU2NTg3XHU0RUY2JywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNvbXBvc2VyIGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdAJzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCdhdHQgcGlja2VyJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5hdHQtcGlja2VyJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISFwLCBkZXRhaWw6IHAgPyAnb3BlbicgOiAnbm90IG9wZW4nfTtgLCA1XzAwMCk7XHJcbiAgICAgIGlmICghd1swXSkgcmV0dXJuIHc7XHJcbiAgICAgIGF3YWl0IHR5cGVJbnRvKCcuYXR0LXBpY2tlciBpbnB1dCcsICdyZWFkJyk7XHJcbiAgICAgIGNvbnN0IHcyID0gYXdhaXQgd2FpdEZvcignYXR0IHJlc3VsdHMnLCBgdmFyIHI9ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmF0dC1yZXN1bHRzIC5mcy1yb3cnKS5sZW5ndGg7XHJcbiAgICAgICAgcmV0dXJuIHtvazogciA+PSAxLCBkZXRhaWw6ICdyZXN1bHRzPScrcn07YCwgNl8wMDApO1xyXG4gICAgICBpZiAoIXcyWzBdKSByZXR1cm4gdzI7XHJcbiAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGY9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmF0dC1yZXN1bHRzIC5mcy1yb3cnKTsgaWYoZikgZi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdhdHQgY2hpcCcsIGB2YXIgYz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuYXR0LWNoaXAnKS5sZW5ndGg7XHJcbiAgICAgICAgcmV0dXJuIHtvazogYyA+PSAxLCBkZXRhaWw6ICdjaGlwcz0nK2N9O2AsIDVfMDAwKTtcclxuICAgIH0pO1xyXG5cclxuICAgIC8qID09PT09PT09PT0gZmFrZShcdTU0MTFcdTVCRkNcdTY3ODRcdTkwMjApOlx1OEJCRVx1N0Y2RVx1MzAwQ1x1OTFDRFx1NjVCMFx1OTE0RFx1N0Y2RVx1MzAwRFx1OTFDRFx1NTE2NSArIFx1OTAwOVx1NjJFOVx1NjMwMVx1NEU0NSA9PT09PT09PT09ICovXHJcbiAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfV0laQVJEID09PSAnZmFrZScpIHtcclxuICAgICAgYXdhaXQgc3RlcCgnXHU1NDExXHU1QkZDOlx1OEJCRVx1N0Y2RVx1MzAwQ1x1OTFDRFx1NjVCMFx1OTE0RFx1N0Y2RVx1MzAwRFx1OTFDRFx1NTE2NSArIFx1OTAwOVx1NjJFOVx1NjMwMVx1NEU0NSh3aXphcmQuanNvbiknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgYXdhaXQganMoYHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBLZXlib2FyZEV2ZW50KCdrZXlkb3duJywge2tleToncCcsIGN0cmxLZXk6dHJ1ZSwgc2hpZnRLZXk6dHJ1ZSwgYnViYmxlczp0cnVlfSkpYCk7XHJcbiAgICAgICAgY29uc3Qgb3BlbiA9IGF3YWl0IHdhaXRGb3IoJ3NldHRpbmdzIG9wZW4nLCBgdmFyIHM9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmNtZGsuc2V0dGluZ3MnKTtcclxuICAgICAgICAgIHJldHVybiB7b2s6ICEhcywgZGV0YWlsOiBzID8gJ29wZW4nIDogJ2Nsb3NlZCd9O2AsIDVfMDAwKTtcclxuICAgICAgICBpZiAoIW9wZW5bMF0pIHJldHVybiBvcGVuO1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY21kay5zZXR0aW5ncyBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTkxQ0RcdTY1QjBcdTkxNERcdTdGNkUnKT49MDt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgY29uc3Qgc2hvd24gPSBhd2FpdCB3YWl0Rm9yKCd3aXphcmQgcmVvcGVuZWQnLCBgcmV0dXJuIHtvazogISFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKSxcclxuICAgICAgICAgIGRldGFpbDogZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLndpemFyZC1vdmVybGF5JykgPyAnb3BlbicgOiAnY2xvc2VkJ307YCwgNV8wMDApO1xyXG4gICAgICAgIGlmICghc2hvd25bMF0pIHJldHVybiBzaG93bjtcclxuICAgICAgICBhd2FpdCBzaG90KCd3aXphcmQtcmVlbnRyeScpO1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW92ZXJsYXkgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NTNENlx1NkQ4OCc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgIGNvbnN0IGNsb3NlZCA9IGF3YWl0IHdhaXRGb3IoJ3dpemFyZCBjbG9zZWQnLCBgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3ZlcmxheScpLCBkZXRhaWw6ICdjbG9zZWQnfTtgLCA1XzAwMCk7XHJcbiAgICAgICAgY29uc3Qgc3QgPSAoYXdhaXQganMoYHdpbmRvdy5obWguZ2V0V2l6YXJkKCkudGhlbihmdW5jdGlvbihyKXtyZXR1cm4gSlNPTi5zdHJpbmdpZnkocik7fSlgKSkgYXMgc3RyaW5nO1xyXG4gICAgICAgIGNvbnN0IHAgPSBKU09OLnBhcnNlKHN0KSBhcyB7IHBlcnNpc3RlZD86IHsgZG9uZT86IGJvb2xlYW47IGNob2ljZT86IHN0cmluZyB9IH07XHJcbiAgICAgICAgY29uc3QgcGVyc2lzdGVkID0gcC5wZXJzaXN0ZWQ/LmRvbmUgPT09IHRydWUgJiYgcC5wZXJzaXN0ZWQ/LmNob2ljZSA9PT0gJ2J1bmRsZWQnO1xyXG4gICAgICAgIHJldHVybiBbY2xvc2VkWzBdICYmIHBlcnNpc3RlZCwgYGNsb3NlZD0ke2Nsb3NlZFswXX0gcGVyc2lzdGVkPSR7SlNPTi5zdHJpbmdpZnkocC5wZXJzaXN0ZWQgPz8gbnVsbCl9YF07XHJcbiAgICAgIH0pO1xyXG5cclxuICAgICAgLyogPT09PT09PT09PSBmYWtlKFx1NTQxMVx1NUJGQ1x1Njc4NFx1OTAyMCk6XHU3QTg0XHU1QzRGIDM2MFx1MDBENzY0MCBcdTUxNjhcdTUxNDNcdTdEMjBcdTUzRUZcdThGQkUgKyBcdTUzNTVcdTUxRkJcdTkwMDlcdTk4NzlcdTUzNzNcdTUyNERcdThGREIgPT09PT09PT09PVxyXG4gICAgICAgICBcdTc1MjhcdTYyMzdcdTYyNEJcdTY3M0FcdTVCOUVcdTZENEJcdTc1REJcdTcwQjk6XHU3QTg0XHU4OUM2XHU1M0UzXHU0RTBCXHU5MDA5XHU5ODc5L1x1NjMwOVx1OTRBRVx1ODhBQlx1ODhDMVx1NTIwN1x1NzBCOVx1NEUwRFx1NTIzMFx1MzAwMlx1NEYyQVx1OTAyMFwiXHU2OEMwXHU2RDRCXHU1MjMwXHU1REYyXHU4OEM1XCJcclxuICAgICAgICAgKFx1NEUzQlx1OEZEQlx1N0EwQiBlbnYgXHU1MzczXHU2NUY2XHU4QkZCKVx1OEJBOVx1NTQxMVx1NUJGQ1x1NTFGQVx1NzNCMFx1NEUwOVx1OTAwOVx1OTg3OVx1OERFRlx1NUY4NCxcdTdGMjlcdTUyMzAgMzYwXHUwMEQ3NjQwIFx1NTQwRVx1OTAxMFx1NEUyQVxyXG4gICAgICAgICBlbGVtZW50RnJvbVBvaW50IFx1NjVBRFx1OEEwMChcdTRFMERcdTY2MkZcdTg4QUJcdTg4QzFcdTUyMDcpO1x1NTE4RFx1OUE4Q1x1OEJDMVx1NTM1NVx1NTFGQlx1NTI0RFx1OEZEQlx1NEUwRVx1NTNENlx1NkQ4OFx1MzAwMiAqL1xyXG4gICAgICBhd2FpdCBzdGVwKCdcdTU0MTFcdTVCRkM6XHU3QTg0XHU1QzRGIDM2MFx1MDBENzY0MFx1MjAxNFx1MjAxNFx1NEUwOVx1OTAwOVx1OTg3OShcdTU0MkIgbm90ZSBcdTY1NzRcdTY4MEYpXHU0RTBFXHU2MzA5XHU5NEFFXHU1MTY4XHU5MEU4XHU1M0VGXHU1NDdEXHU0RTJEK1x1NTM1NVx1NTFGQlx1NTM3M1x1NTI0RFx1OEZEQicsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9GQUtFX0RFVEVDVF9GT1VORCA9ICcxJztcclxuICAgICAgICBjb25zdCBzaXplMCA9IHdpbi5nZXRTaXplKCk7XHJcbiAgICAgICAgY29uc3QgdzAgPSBzaXplMFswXSA/PyAxMjgwO1xyXG4gICAgICAgIGNvbnN0IGgwID0gc2l6ZTBbMV0gPz8gODAwO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OidwJywgY3RybEtleTp0cnVlLCBzaGlmdEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgICAgIGNvbnN0IG9wZW4gPSBhd2FpdCB3YWl0Rm9yKCdzZXR0aW5ncyBvcGVuJywgYHZhciBzPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy5jbWRrLnNldHRpbmdzJyk7IHJldHVybiB7b2s6ICEhcywgZGV0YWlsOiBzID8gJ29wZW4nIDogJ2Nsb3NlZCd9O2AsIDVfMDAwKTtcclxuICAgICAgICAgIGlmICghb3BlblswXSkgcmV0dXJuIG9wZW47XHJcbiAgICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNtZGsuc2V0dGluZ3MgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU5MUNEXHU2NUIwXHU5MTREXHU3RjZFJyk+PTA7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgICAgY29uc3Qgc2hvd24gPSBhd2FpdCB3YWl0Rm9yKCd3aXphcmQgcmVvcGVuZWQnLCBgcmV0dXJuIHtvazogISFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKSwgZGV0YWlsOiBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKSA/ICdvcGVuJyA6ICdjbG9zZWQnfTtgLCA1XzAwMCk7XHJcbiAgICAgICAgICBpZiAoIXNob3duWzBdKSByZXR1cm4gc2hvd247XHJcbiAgICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTVGMDBcdTU5Q0JcdTkxNERcdTdGNkUnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICAgIGNvbnN0IGRldGVjdFBhZ2UgPSBhd2FpdCB3YWl0Rm9yKCdkZXRlY3QgZm91bmQgcGFnZSgzIG9wdGlvbnMpJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1kZXRlY3QnKTtcclxuICAgICAgICAgICAgdmFyIG9wdHM9cD9wLnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3B0JykubGVuZ3RoOjA7XHJcbiAgICAgICAgICAgIHJldHVybiB7b2s6ICEhcCAmJiBvcHRzPT09MywgZGV0YWlsOiAnb3B0cz0nK29wdHN9O2AsIDEyXzAwMCk7XHJcbiAgICAgICAgICBpZiAoIWRldGVjdFBhZ2VbMF0pIHJldHVybiBkZXRlY3RQYWdlO1xyXG4gICAgICAgICAgLy8gXHU1MzU1XHU1MUZCXHU5MDA5XHU5ODc5XHU1MzczXHU1MjREXHU4RkRCOlx1NzBCOVwiXHU0RUNEXHU4OTgxXHU0RTBCXHU4RjdEXHU2NUIwXHU3MjQ4XCJcdTVFOTRcdTc2RjRcdTYzQTVcdTg0M0RcdTUyMzBcdTkwMDlcdTYyRTlcdTk4NzUoXHU2NUUwXHU5NzAwXHU1MThEXHU3MEI5XCJcdTRFMEJcdTRFMDBcdTZCNjVcIilcclxuICAgICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIG89W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcud2l6YXJkLW9wdCcpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1NEVDRFx1ODk4MVx1NEUwQlx1OEY3RFx1NjVCMFx1NzI0OCcpPj0wO30pOyBpZihvKSBvLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICAgIGNvbnN0IHNlbGVjdFBhZ2UgPSBhd2FpdCB3YWl0Rm9yKCdzZWxlY3QgcGFnZSB2aWEgc2luZ2xlIGNsaWNrJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1zZWxlY3QnKTtcclxuICAgICAgICAgICAgcmV0dXJuIHtvazogISFwICYmIHAucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vcHQnKS5sZW5ndGg9PT0zLCBkZXRhaWw6IHAgPyAnc2VsZWN0JyA6ICdub3Qgc2VsZWN0J307YCwgNl8wMDApO1xyXG4gICAgICAgICAgaWYgKCFzZWxlY3RQYWdlWzBdKSByZXR1cm4gW2ZhbHNlLCBgXHU1MzU1XHU1MUZCXHU5MDA5XHU5ODc5XHU2NzJBXHU1MjREXHU4RkRCXHU1MjMwXHU5MDA5XHU2MkU5XHU5ODc1OiAke3NlbGVjdFBhZ2VbMV19YF07XHJcbiAgICAgICAgICAvLyBcdTdGMjlcdTUyMzAgMzYwXHUwMEQ3NjQwKG1pbldpZHRoIFx1NURGMlx1NTcyOCBVSVZFUklGWSBcdTRFMEJcdTY1M0VcdTVCQkQpLFx1NjVBRFx1OEEwMFx1NTE2OFx1OTBFOFx1NTNFRlx1NTQ3RFx1NEUyRFxyXG4gICAgICAgICAgd2luLnNldFNpemUoMzYwLCA2NDApO1xyXG4gICAgICAgICAgYXdhaXQgc2xlZXAoNTAwKTtcclxuICAgICAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoYChmdW5jdGlvbigpe1xyXG4gICAgICAgICAgICBmdW5jdGlvbiBoaXQoZWwpeyBlbC5zY3JvbGxJbnRvVmlldyh7YmxvY2s6J25lYXJlc3QnfSk7IHZhciByPWVsLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xyXG4gICAgICAgICAgICAgIHZhciB4PXIubGVmdCtyLndpZHRoLzIsIHk9ci50b3Arci5oZWlnaHQvMjtcclxuICAgICAgICAgICAgICB2YXIgZT1kb2N1bWVudC5lbGVtZW50RnJvbVBvaW50KHgseSk7XHJcbiAgICAgICAgICAgICAgcmV0dXJuICEhKGUgJiYgKGU9PT1lbCB8fCBlbC5jb250YWlucyhlKSkpOyB9XHJcbiAgICAgICAgICAgIHZhciBjYXJkPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1zZWxlY3QnKTtcclxuICAgICAgICAgICAgdmFyIG9wdHM9W10uc2xpY2UuY2FsbChjYXJkLnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3B0JykpO1xyXG4gICAgICAgICAgICB2YXIgb3B0SGl0PW9wdHMubWFwKGhpdCk7XHJcbiAgICAgICAgICAgIHZhciBub3Rlcz1bXS5zbGljZS5jYWxsKGNhcmQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vcHQtbm90ZScpKTtcclxuICAgICAgICAgICAgdmFyIG5vdGVIaXQ9bm90ZXMubWFwKGZ1bmN0aW9uKG4peyBuLnNjcm9sbEludG9WaWV3KHtibG9jazonbmVhcmVzdCd9KTsgdmFyIHI9bi5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcclxuICAgICAgICAgICAgICB2YXIgZT1kb2N1bWVudC5lbGVtZW50RnJvbVBvaW50KHIubGVmdCtyLndpZHRoLzIsIHIudG9wK01hdGgubWluKHIuaGVpZ2h0LzIsIDgpKTtcclxuICAgICAgICAgICAgICByZXR1cm4gISEoZSAmJiBvcHRzLnNvbWUoZnVuY3Rpb24obyl7IHJldHVybiBlPT09byB8fCBvLmNvbnRhaW5zKGUpOyB9KSk7IH0pO1xyXG4gICAgICAgICAgICB2YXIgYWN0PWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1zZWxlY3QgLndpemFyZC1hY3Rpb25zIC5idG4ucHJpbWFyeScpO1xyXG4gICAgICAgICAgICB2YXIgZm9vdGVyPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1mb290ZXIgYnV0dG9uJykpO1xyXG4gICAgICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe3Z3OiB3aW5kb3cuaW5uZXJXaWR0aCwgdmg6IHdpbmRvdy5pbm5lckhlaWdodCwgb3B0czogb3B0cy5sZW5ndGgsXHJcbiAgICAgICAgICAgICAgb3B0SGl0OiBvcHRIaXQsIG5vdGVIaXQ6IG5vdGVIaXQsIGFjdEhpdDogYWN0ID8gaGl0KGFjdCkgOiBmYWxzZSwgZnRIaXQ6IGZvb3Rlci5tYXAoaGl0KX0pO1xyXG4gICAgICAgICAgfSkoKWApKSBhcyBzdHJpbmc7XHJcbiAgICAgICAgICBjb25zdCBxID0gSlNPTi5wYXJzZShyKSBhcyB7IHZ3OiBudW1iZXI7IHZoOiBudW1iZXI7IG9wdHM6IG51bWJlcjsgb3B0SGl0OiBib29sZWFuW107IG5vdGVIaXQ6IGJvb2xlYW5bXTsgYWN0SGl0OiBib29sZWFuOyBmdEhpdDogYm9vbGVhbltdIH07XHJcbiAgICAgICAgICBhd2FpdCBzaG90KCd3aXphcmQtbmFycm93LTM2MC1zZWxlY3QnKTtcclxuICAgICAgICAgIGNvbnN0IG5hcnJvd09rID0gcS5vcHRzID09PSAzICYmIHEudncgPD0gMzgwICYmIHEub3B0SGl0LmV2ZXJ5KEJvb2xlYW4pICYmIHEubm90ZUhpdC5ldmVyeShCb29sZWFuKSAmJiBxLmFjdEhpdCAmJiBxLmZ0SGl0LmV2ZXJ5KEJvb2xlYW4pO1xyXG4gICAgICAgICAgLy8gXHU3QTg0XHU1QzRGXHU0RTBCXHU1MzU1XHU1MUZCXHU5MDA5XHU5ODc5XHUyNDYwID0gXHU5MDA5XHU0RTJEXHU1RTc2XHU1MjREXHU4RkRCXHU1MjMwXHU1Qjg5XHU4OEM1XHU5ODc1KHZlcmlmeSBcdTZBMjFcdTYyREZcdThGREJcdTVFQTYsXHU0RTBEXHU4NDNEXHU3NkQ4KVxyXG4gICAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgbz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3B0JykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU0RTBCXHU4RjdEXHU1Qjg5XHU4OEM1XHU1QjhDXHU2NTc0IGhtaCBDTEknKT49MDt9KTsgaWYobykgby5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgICBjb25zdCBhZHYgPSBhd2FpdCB3YWl0Rm9yKCdpbnN0YWxsIHBhZ2UgdmlhIHNpbmdsZSBjbGljaycsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtaW5zdGFsbCcpO1xyXG4gICAgICAgICAgICByZXR1cm4ge29rOiAhIXAsIGRldGFpbDogcCA/ICdpbnN0YWxsaW5nJyA6ICdub3Qgc2hvd24nfTtgLCA2XzAwMCk7XHJcbiAgICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTUzRDZcdTZEODgnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICAgIGNvbnN0IGNsb3NlZE5hcnJvdyA9IGF3YWl0IHdhaXRGb3IoJ3dpemFyZCBjbG9zZWQgYXQgMzYwcHgnLCBgcmV0dXJuIHtvazogIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3ZlcmxheScpLCBkZXRhaWw6ICdjbG9zZWQnfTtgLCA1XzAwMCk7XHJcbiAgICAgICAgICByZXR1cm4gW25hcnJvd09rICYmIGFkdlswXSAmJiBjbG9zZWROYXJyb3dbMF0sXHJcbiAgICAgICAgICAgIGB2cD0ke3Eudnd9eCR7cS52aH0gb3B0cz0ke3Eub3B0c30gb3B0SGl0PVske3Eub3B0SGl0LmpvaW4oJywnKX1dIG5vdGVIaXQ9WyR7cS5ub3RlSGl0LmpvaW4oJywnKX1dIFx1NEUzQlx1NjMwOVx1OTRBRT0ke3EuYWN0SGl0fSBmb290ZXI9WyR7cS5mdEhpdC5qb2luKCcsJyl9XTsgXHU1MzU1XHU1MUZCXHU1MjREXHU4RkRCOiAke2FkdlsxXX07IFx1N0E4NFx1NUM0Rlx1NTNENlx1NkQ4ODogJHtjbG9zZWROYXJyb3dbMV19YF07XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgIHdpbi5zZXRTaXplKHcwLCBoMCk7XHJcbiAgICAgICAgICBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9GQUtFX0RFVEVDVF9GT1VORCA9IHVuZGVmaW5lZDtcclxuICAgICAgICB9XHJcbiAgICAgIH0pO1xyXG4gICAgfVxyXG5cclxuICAgIGF3YWl0IHNob3QoJ2ZpbmFsJyk7XHJcbiAgfSBlbHNlIGlmICgocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfV0laQVJEID8/ICcnKSAhPT0gJycpIHtcclxuICAgIC8qID09PT09PT09PT0gcmVhbChcdTU0MTFcdTVCRkNcdTY3ODRcdTkwMjAsXHU0RTkyXHU2NUE1XHU0RThFXHU1RTM4XHU4OUM0IHJlYWwgXHU2QjY1XHU5QUE0KTpcclxuICAgICAgIFdaMiBcdTY3MkNcdTY3M0FcdTc3MUZcdTVCOUVcdTY4QzBcdTZENEIoXHU5RUQ4XHU4QkE0XHU1MTcxXHU0RUFCXHU5ODc1KS8gV1ozIFx1NEUwQlx1OEY3RFx1NUI4OVx1ODhDNVx1NUI5RVx1NkQ0QiA9PT09PT09PT09ICovXHJcbiAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfV0laQVJEID09PSAnZGV0ZWN0Jykge1xyXG4gICAgICBhd2FpdCBzdGVwKCdcdTU0MTFcdTVCRkMoXHU3NzFGXHU1QjlFKTpcdTZCMjJcdThGQ0VcdTIxOTJcdTY4QzBcdTZENEJcdTUyMzBcdTY3MkNcdTY3M0FcdTVERjJcdTg4QzUgQ0xJKFx1OUVEOFx1OEJBNFx1NTE3MVx1NEVBQixcdTUyRkVcdTkwMDlcdTZCNjNcdTc4NkUpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCd3aXphcmQgb3ZlcmxheScsIGB2YXIgbz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKTtcclxuICAgICAgICAgIHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTVGMDBcdTU5Q0JcdTkxNERcdTdGNkUnO30pO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogISFvICYmICEhYiwgZGV0YWlsOiBvID8gJ292ZXJsYXkrXHU1RjAwXHU1OUNCXHU5MTREXHU3RjZFJyA6ICdubyBvdmVybGF5J307YCwgMTJfMDAwKTtcclxuICAgICAgICBpZiAoIXdbMF0pIHJldHVybiB3O1xyXG4gICAgICAgIGF3YWl0IHNob3QoJ3dpemFyZC1yZWFsLXdlbGNvbWUnKTtcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTVGMDBcdTU5Q0JcdTkxNERcdTdGNkUnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICBjb25zdCBmb3VuZCA9IGF3YWl0IHdhaXRGb3IoJ2RldGVjdCBmb3VuZCcsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtZGV0ZWN0Jyk7XHJcbiAgICAgICAgICBpZighcCkgcmV0dXJuIHtvazpmYWxzZSwgZGV0YWlsOidkZXRlY3QgcGFnZSBub3Qgc2hvd24nfTtcclxuICAgICAgICAgIHZhciB0PXAudGV4dENvbnRlbnQ7XHJcbiAgICAgICAgICB2YXIgb2sxPXQuaW5kZXhPZignXHU2OEMwXHU2RDRCXHU1MjMwXHU1REYyXHU1Qjg5XHU4OEM1IGhtaGFybmVzcyB2Jyk+PTA7XHJcbiAgICAgICAgICB2YXIgb2syPXQuaW5kZXhPZignXHU5RUQ4XHU4QkE0XHU1MTcxXHU0RUFCXHU0RjdGXHU3NTI4XHU1QjgzKFx1NjNBOFx1ODM1MCknKT49MDtcclxuICAgICAgICAgIHZhciByYWRpbz1wLnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtb3B0Lm9uJyk7XHJcbiAgICAgICAgICByZXR1cm4ge29rOiBvazEmJm9rMiYmISFyYWRpbywgZGV0YWlsOiB0LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw5MCl9O2AsIDIwXzAwMCk7XHJcbiAgICAgICAgYXdhaXQgc2hvdCgnd2l6YXJkLXJlYWwtZGV0ZWN0Jyk7XHJcbiAgICAgICAgcmV0dXJuIGZvdW5kO1xyXG4gICAgICB9KTtcclxuICAgIH0gZWxzZSBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfVUlWRVJJRllfV0laQVJEID09PSAnaW5zdGFsbCcpIHtcclxuICAgICAgYXdhaXQgc3RlcCgnXHU1NDExXHU1QkZDKFx1NzcxRlx1NUI5RSk6XHU2OEMwXHU2RDRCXHUyMTkyXHU0RUNEXHU4OTgxXHU0RTBCXHU4RjdEXHU2NUIwXHU3MjQ4XHUyMTkyXHU5MDA5XHU2MkU5XHUyNDYwXHUyMTkyXHU4RkRCXHU1MTY1XHU1Qjg5XHU4OEM1XHU5ODc1JywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHcgPSBhd2FpdCB3YWl0Rm9yKCd3aXphcmQgb3ZlcmxheScsIGB2YXIgbz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLW92ZXJsYXknKTtcclxuICAgICAgICAgIHJldHVybiB7b2s6ICEhbywgZGV0YWlsOiBvID8gJ29wZW4nIDogJ2Nsb3NlZCd9O2AsIDEyXzAwMCk7XHJcbiAgICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTVGMDBcdTU5Q0JcdTkxNERcdTdGNkUnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICBjb25zdCBmb3VuZCA9IGF3YWl0IHdhaXRGb3IoJ2RldGVjdCBmb3VuZCcsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtZGV0ZWN0Jyk7XHJcbiAgICAgICAgICByZXR1cm4ge29rOiAhIXAgJiYgcC50ZXh0Q29udGVudC5pbmRleE9mKCdcdTY4QzBcdTZENEJcdTUyMzBcdTVERjJcdTVCODlcdTg4QzUgaG1oYXJuZXNzIHYnKT49MCwgZGV0YWlsOiBwID8gcC50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNjApIDogJ25vIGRldGVjdCBwYWdlJ307YCwgMjBfMDAwKTtcclxuICAgICAgICBpZiAoIWZvdW5kWzBdKSByZXR1cm4gZm91bmQ7XHJcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgbz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3B0JykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQuaW5kZXhPZignXHU0RUNEXHU4OTgxXHU0RTBCXHU4RjdEXHU2NUIwXHU3MjQ4Jyk+PTA7fSk7IGlmKG8pIG8uY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgIGF3YWl0IHNsZWVwKDIwMCk7XHJcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU0RTBCXHU0RTAwXHU2QjY1Jzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgY29uc3Qgc2VsID0gYXdhaXQgd2FpdEZvcignc2VsZWN0IHBhZ2UgXHUyNDYwIG9uJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1zZWxlY3QnKTtcclxuICAgICAgICAgIHZhciBvbj1wP3AucXVlcnlTZWxlY3RvcignLndpemFyZC1vcHQub24nKTpudWxsO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogISFwICYmICEhb24gJiYgb24udGV4dENvbnRlbnQuaW5kZXhPZignXHU0RTBCXHU4RjdEXHU1Qjg5XHU4OEM1XHU1QjhDXHU2NTc0IGhtaCBDTEknKT49MCwgZGV0YWlsOiBwID8gJ3NlbGVjdCBcdTI0NjAgb24nIDogJ25vIHNlbGVjdCd9O2AsIDhfMDAwKTtcclxuICAgICAgICBpZiAoIXNlbFswXSkgcmV0dXJuIHNlbDtcclxuICAgICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciBiPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLndpemFyZC1vdmVybGF5IGJ1dHRvbicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50LnRyaW0oKT09PSdcdTVGMDBcdTU5Q0JcdTVCODlcdTg4QzUnO30pOyBpZihiKSBiLmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgICByZXR1cm4gd2FpdEZvcignaW5zdGFsbCBwYWdlJywgYHZhciBwPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1pbnN0YWxsJyk7XHJcbiAgICAgICAgICByZXR1cm4ge29rOiAhIXAsIGRldGFpbDogcCA/ICdpbnN0YWxsaW5nJyA6ICdub3Qgc2hvd24nfTtgLCA4XzAwMCk7XHJcbiAgICAgIH0pO1xyXG4gICAgICBhd2FpdCBzdGVwKCdcdTU0MTFcdTVCRkMoXHU3NzFGXHU1QjlFKTpcdTVCODlcdTg4QzVcdThGREJcdTVFQTZcdTUzRUZcdTg5QzEoXHU2QjY1XHU5QUE0XHU2NTg3XHU2ODQ4L1x1NEUwQlx1OEY3RFx1NzY3RVx1NTIwNlx1NkJENFx1NkVEQVx1NTJBOCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ3Byb2dyZXNzIHZpc2libGUnLCBgdmFyIGJhcj1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLXByb2dyZXNzJyk7XHJcbiAgICAgICAgICB2YXIgbG9nPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtaW5zdGFsbC1sb2cnKTtcclxuICAgICAgICAgIHZhciBsaW5lcz1sb2c/bG9nLnRleHRDb250ZW50LnNwbGl0KCdcXFxcbicpLmZpbHRlcihmdW5jdGlvbih4KXtyZXR1cm4geC50cmltKCkhPT0nJzt9KTpbXTtcclxuICAgICAgICAgIHJldHVybiB7b2s6ICEhYmFyICYmIGxpbmVzLmxlbmd0aD49MSwgZGV0YWlsOiAnYmFyPScrKGJhcj8neSc6J24nKSsnIGxpbmVzPScrbGluZXMubGVuZ3RoKyhsaW5lcy5sZW5ndGg+MD8oJyBsYXN0PScrKGxpbmVzW2xpbmVzLmxlbmd0aC0xXXx8JycpLnNsaWNlKDAsNTApKTonJyl9O2AsIDYwXzAwMCk7XHJcbiAgICAgICAgYXdhaXQgc2hvdCgnd2l6YXJkLXJlYWwtaW5zdGFsbCcpO1xyXG4gICAgICAgIHJldHVybiB3O1xyXG4gICAgICB9KTtcclxuICAgICAgYXdhaXQgc3RlcCgnXHU1NDExXHU1QkZDKFx1NzcxRlx1NUI5RSk6XHU1Qjg5XHU4OEM1XHU1QjhDXHU2MjEwXHUyMTkyXHU5MTREXHU3RjZFXHU4REYzXHU4RkM3KFx1NURGMlx1NjcwOVx1NUJDNlx1OTRBNSlcdTIxOTJcdTVCOENcdTYyMTBcdTk4NzVcdTIxOTJcdTVGMDBcdTU5Q0JcdTRGN0ZcdTc1MjhcdTIxOTJcdTY1QjAgcnVudGltZSBcdThGREVcdTYzQTUnLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgLy8gXHU1Qjg5XHU4OEM1XHU1MTY4XHU3QTBCKG5wbSBcdTg5RTNcdTY3OTArXHU0RTBCXHU4RjdEK1x1ODQzRFx1NzZEODtcdTk1NUNcdTUwQ0YgbnBtbWlycm9yIFx1OTAxQVx1NUUzOCA8MiBcdTUyMDZcdTk0OUYpLFx1NEUwQVx1OTY1MCA4IFx1NTIwNlx1OTQ5RlxyXG4gICAgICAgIGF3YWl0IHdhaXRGb3IoJ2RvbmUgcGFnZScsIGB2YXIgZD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud2l6YXJkLWNhcmQud2l6YXJkLXBhZ2UtZG9uZScpO1xyXG4gICAgICAgICAgaWYoZCkgcmV0dXJuIHtvazp0cnVlLCBkZXRhaWw6J2RvbmUnfTtcclxuICAgICAgICAgIHZhciBjPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1jb25maWcnKTtcclxuICAgICAgICAgIGlmKGMpeyB2YXIgcz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC5pbmRleE9mKCdcdThERjNcdThGQzcnKT49MDt9KTsgaWYocykgcy5jbGljaygpOyB9XHJcbiAgICAgICAgICB2YXIgZXJyPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtZXJyb3InKTtcclxuICAgICAgICAgIGlmKGVycikgcmV0dXJuIHtvazpmYWxzZSwgZGV0YWlsOidpbnN0YWxsIGVycm9yOiAnK2Vyci50ZXh0Q29udGVudC5zbGljZSgwLDgwKX07XHJcbiAgICAgICAgICByZXR1cm4ge29rOmZhbHNlLCBkZXRhaWw6J2luc3RhbGxpbmdcdTIwMjYnfTtgLCA4ICogNjBfMDAwKTtcclxuICAgICAgICBjb25zdCB3ID0gYXdhaXQgd2FpdEZvcignZG9uZSByZWFkeSB0ZXh0JywgYHZhciBkPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53aXphcmQtY2FyZC53aXphcmQtcGFnZS1kb25lJyk7XHJcbiAgICAgICAgICB2YXIgdD1kP2QudGV4dENvbnRlbnQ6Jyc7XHJcbiAgICAgICAgICByZXR1cm4ge29rOiAhIWQgJiYgdC5pbmRleE9mKCdcdTVDMzFcdTdFRUEnKT49MCwgZGV0YWlsOiB0LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw2MCl9O2AsIDEwXzAwMCk7XHJcbiAgICAgICAgaWYgKCF3WzBdKSByZXR1cm4gdztcclxuICAgICAgICBhd2FpdCBzaG90KCd3aXphcmQtcmVhbC1kb25lJyk7XHJcbiAgICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgYj1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy53aXphcmQtb3ZlcmxheSBidXR0b24nKSkuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC50ZXh0Q29udGVudC50cmltKCk9PT0nXHU1RjAwXHU1OUNCXHU0RjdGXHU3NTI4Jzt9KTsgaWYoYikgYi5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgICAgY29uc3QgY29ubmVjdGVkID0gYXdhaXQgd2FpdEZvcignbmV3IHJ1bnRpbWUgY29ubmVjdGVkJywgYHZhciBkb3Q9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmhvc3QtZG90Lm9uJyk7XHJcbiAgICAgICAgICB2YXIgbD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuaG9zdC1sYWJlbCcpO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogISFkb3QgJiYgISFsICYmIGwudGV4dENvbnRlbnQuaW5kZXhPZigncnVudGltZScpPj0wLCBkZXRhaWw6ICdkb3Q9JysoZG90Pydvbic6J29mZicpKycgbGFiZWw9JysobD9sLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw1MCk6J25vbmUnKX07YCwgNjBfMDAwKTtcclxuICAgICAgICBjb25zdCBzdCA9IChhd2FpdCBqcyhgd2luZG93LmhtaC5nZXRTdGF0ZSgpLnRoZW4oZnVuY3Rpb24ocil7cmV0dXJuIEpTT04uc3RyaW5naWZ5KHttb2RlOnIubW9kZSwgcnVudGltZUVudHJ5OnIucnVudGltZUVudHJ5fSk7fSlgKSkgYXMgc3RyaW5nO1xyXG4gICAgICAgIGNvbnN0IHAgPSBKU09OLnBhcnNlKHN0KSBhcyB7IG1vZGU/OiBzdHJpbmc7IHJ1bnRpbWVFbnRyeT86IHN0cmluZyB8IG51bGwgfTtcclxuICAgICAgICBjb25zdCBlbnRyeU9rID0gKHAucnVudGltZUVudHJ5ID8/ICcnKS5pbmRleE9mKCcuaG1oYXJuZXNzLWdsb2JhbCcpID49IDA7XHJcbiAgICAgICAgYXdhaXQgc2hvdCgnd2l6YXJkLXJlYWwtZmluYWwnKTtcclxuICAgICAgICByZXR1cm4gW2Nvbm5lY3RlZFswXSAmJiBlbnRyeU9rLCBgY29ubmVjdGVkOiAke2Nvbm5lY3RlZFsxXX07IHN0YXRlPSR7c3Quc2xpY2UoMCwgOTApfWBdO1xyXG4gICAgICB9KTtcclxuICAgIH1cclxuICAgIGF3YWl0IHNob3QoJ2ZpbmFsJyk7XHJcbiAgfSBlbHNlIHtcclxuICAgIC8qID09PT09PT09PT0gcmVhbDpcdTUzRUFcdThCRkJcdTVCNTBcdTk2QzYoXHU0RTBEXHU1MkE4XHU3NzFGXHU1QjlFXHU0RjFBXHU4QkREKSA9PT09PT09PT09ICovXHJcbiAgICBhd2FpdCBzdGVwKCdcdTk4NzZcdTY4MEY6cnVudGltZSBcdTcyNDhcdTY3MkNcdTRFMEVcdTdBRUZcdTUzRTNcdTVERjJcdTY2M0VcdTc5M0EoXHU5NzVFID8pJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignaG9zdCBsYWJlbCcsIGB2YXIgbD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuaG9zdC1sYWJlbCcpO1xyXG4gICAgICAgIHZhciB0ID0gbCA/IGwudGV4dENvbnRlbnQgOiAnJztcclxuICAgICAgICByZXR1cm4ge29rOiB0LmluZGV4T2YoJz8nKSA8IDAgJiYgdC5pbmRleE9mKCdydW50aW1lJykgPj0gMCwgZGV0YWlsOiB0LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw2MCl9O2AsIDE1XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ1x1NEYxQVx1OEJERFx1NTIxN1x1ODg2ODpcdTc3MUZcdTVCOUVcdTUzODZcdTUzRjJcdTUyQTBcdThGN0QoXHU2NTcwXHU5MUNGPjApJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignc2Vzc2lvbnMnLCBgdmFyIG49ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aDtcclxuICAgICAgICByZXR1cm4ge29rOiBuID4gMCwgZGV0YWlsOiAnc2Vzc2lvbnM9JytufTtgLCAxNV8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdcdTcwQjlcdTUxRkJcdTUzODZcdTUzRjJcdTRGMUFcdThCREQgXHUyMTkyIFx1NzcxRlx1NUI5RSB0cmFuc2NyaXB0IFx1NTE4NVx1NUJCOVx1NTNFRlx1ODlDMScsIGFzeW5jICgpID0+IHtcclxuICAgICAgY29uc3QgbiA9IChhd2FpdCBqcyhgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNlc3Npb24taXRlbScpLmxlbmd0aGApKSBhcyBudW1iZXI7XHJcbiAgICAgIGlmIChuID09PSAwKSByZXR1cm4gW2ZhbHNlLCAnbm8gc2Vzc2lvbnMgdG8gY2xpY2snXTtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgaXQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnNlc3Npb24taXRlbScpOyBpZiAoaXQpIGl0LmNsaWNrKCk7IH0pKClgKTtcclxuICAgICAgY29uc3QgdyA9IGF3YWl0IHdhaXRGb3IoJ2hpc3RvcnkgdHVybnMnLCBgdmFyIHRzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnR1cm4nKSk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogdHMubGVuZ3RoID49IDEsIGRldGFpbDogJ3R1cm5zPScrdHMubGVuZ3RoKycgZmlyc3Q9JysodHNbMF0/dHNbMF0udGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDQwKTonbm9uZScpfTtgLCAxNV8wMDApO1xyXG4gICAgICBhd2FpdCBzaG90KCdyZWFsLWhpc3RvcnknKTtcclxuICAgICAgcmV0dXJuIHc7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ0RvY2s6T3ZlcnZpZXcgXHU3NzFGXHU1QjlFXHU2NTcwXHU2MzZFKHJ1bnRpbWUgXHU3MjQ4XHU2NzJDXHU5NzVFXHU2NUUwXHU2NTcwXHU2MzZFKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J092ZXJ2aWV3Jzt9KTsgaWYodCkgdC5jbGljaygpOyB9KSgpYCk7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCdvdmVydmlldycsIGB2YXIgcm93cz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXJvdycpKTtcclxuICAgICAgICB2YXIgdmVyID0gcm93cy5maW5kKGZ1bmN0aW9uKHIpeyByZXR1cm4gci50ZXh0Q29udGVudC5pbmRleE9mKCdydW50aW1lIFx1NzI0OFx1NjcyQycpPj0wOyB9KTtcclxuICAgICAgICByZXR1cm4ge29rOiAhIXZlciAmJiB2ZXIudGV4dENvbnRlbnQuaW5kZXhPZignXHU2NUUwXHU2NTcwXHU2MzZFJykgPCAwLCBkZXRhaWw6IHZlciA/IHZlci50ZXh0Q29udGVudC5yZXBsYWNlKC9cXFxccysvZywnICcpLnNsaWNlKDAsNTApIDogJ25vIHZlciByb3cnfTtgLCAxMF8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdEb2NrOkRpZmYgXHU3NzFGXHU1QjlFIGdpdCBcdTcyQjZcdTYwMDEoXHU5NzVFXHU1MkEwXHU4RjdEXHU0RTJEKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgYXdhaXQganMoYChmdW5jdGlvbigpeyB2YXIgdD1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5kb2NrLXRhYicpKS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LnRleHRDb250ZW50PT09J1x1NTNEOFx1NjZGNCd8fHgudGV4dENvbnRlbnQ9PT0nRGlmZic7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignZGlmZicsIGB2YXIgcD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuZGlmZi1wYW5lJyk7XHJcbiAgICAgICAgdmFyIHQgPSBwID8gcC50ZXh0Q29udGVudCA6ICcnO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhcCAmJiB0LmluZGV4T2YoJ1x1NTJBMFx1OEY3RFx1NEUyRCcpIDwgMCwgZGV0YWlsOiB0LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw2MCl9O2AsIDE1XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHN0ZXAoJ0RvY2s6RXZpZGVuY2UgXHU3NzFGXHU1QjlFXHU4QkE0XHU3N0U1XHU2NTcwXHU2MzZFJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nXHU4QkMxXHU2MzZFJ3x8eC50ZXh0Q29udGVudD09PSdFdmlkZW5jZSc7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignZXZpZGVuY2UnLCBgdmFyIHJvd3M9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZG9jay1yb3cnKSk7XHJcbiAgICAgICAgdmFyIG1lbSA9IHJvd3MuZmluZChmdW5jdGlvbihyKXsgcmV0dXJuIHIudGV4dENvbnRlbnQuaW5kZXhPZignXHU4QkIwXHU1RkM2XHU1QzQyJyk+PTAgfHwgci50ZXh0Q29udGVudC5pbmRleE9mKCdNZW1vcnkgbGF5ZXJzJyk+PTA7IH0pO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhbWVtICYmIG1lbS50ZXh0Q29udGVudC5pbmRleE9mKCdcdTIwMjYnKSA8IDAsIGRldGFpbDogbWVtID8gbWVtLnRleHRDb250ZW50LnJlcGxhY2UoL1xcXFxzKy9nLCcgJykuc2xpY2UoMCw1MCkgOiAnbm8gcm93J307YCwgMTVfMDAwKTtcclxuICAgIH0pO1xyXG4gICAgYXdhaXQgc3RlcCgnXHU5NjQ0XHU0RUY2XHU0RTBFXHU3NkVFXHU1RjU1XHU1MTY1XHU1M0UzOlx1RDgzRFx1RENDRSBcdTRFMEFcdTRGMjAgKyBcdTk4NzZcdTY4MEZcdTRFMkQvRU4gKyBcdUQ4M0RcdURDQzEgXHU2RDRGXHU4OUM4XHU2MzA5XHU5NEFFXHU1QjU4XHU1NzI4JywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBhd2FpdCBqcyhgKGZ1bmN0aW9uKCl7IHZhciB0PVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmRvY2stdGFiJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQ9PT0nXHU2NTg3XHU0RUY2J3x8eC50ZXh0Q29udGVudD09PSdGaWxlcyc7fSk7IGlmKHQpIHQuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICBhd2FpdCB3YWl0Rm9yKCdmaWxlcyB0YWInLCBgdmFyIHQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLmRvY2stdGFiLmFjdGl2ZScpO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhdCAmJiAodC50ZXh0Q29udGVudD09PSdcdTY1ODdcdTRFRjYnfHx0LnRleHRDb250ZW50PT09J0ZpbGVzJyksIGRldGFpbDogJ2FjdGl2ZT0nKyh0P3QudGV4dENvbnRlbnQ6J25vbmUnKX07YCwgNV8wMDApO1xyXG4gICAgICAvLyByZWFsIFx1NkEyMVx1NUYwRiB3b3Jrc3BhY2VzIFx1OEJGN1x1NkM0Mlx1OEQ3MCBydW50aW1lKFx1NTFCN1x1NTQyRlx1NTJBOFx1NTQwRVx1NTNFRlx1ODBGRFx1NjM5Mlx1OTYxRiksXHU2NTNFXHU1QkJEXHU1MjMwIDE1c1xyXG4gICAgICBjb25zdCB3cyA9IGF3YWl0IHdhaXRGb3IoJ3dzIHBpY2tlcicsIGB2YXIgdz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtcGlja2VyJyk7XHJcbiAgICAgICAgcmV0dXJuIHtvazogISF3LCBkZXRhaWw6IHcgPyAnbG9hZGVkJyA6ICd3b3Jrc3BhY2VzIG5vdCBsb2FkZWQgeWV0J307YCwgbW9kZSA9PT0gJ3JlYWwnID8gMTVfMDAwIDogNl8wMDApO1xyXG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKGAoZnVuY3Rpb24oKXtcclxuICAgICAgICB2YXIgdXAgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuY29tcG9zZXIgYnV0dG9uW2FyaWEtbGFiZWwqPVwiXHU0RTBBXHU0RjIwXCJdLCAuY29tcG9zZXIgYnV0dG9uW2FyaWEtbGFiZWwqPVwiVXBsb2FkXCJdJyk7XHJcbiAgICAgICAgdmFyIGxhbmcgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcubGFuZy1zZWcnKTtcclxuICAgICAgICB2YXIgYnIgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtcGlja2VyIGJ1dHRvbicpO1xyXG4gICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh7dXA6ICEhdXAsIGxhbmc6ICEhbGFuZywgYnJvd3NlOiAhIWJyfSk7XHJcbiAgICAgIH0pKClgKSkgYXMgc3RyaW5nO1xyXG4gICAgICBjb25zdCBwID0gSlNPTi5wYXJzZShyKSBhcyB7IHVwOiBib29sZWFuOyBsYW5nOiBib29sZWFuOyBicm93c2U6IGJvb2xlYW4gfTtcclxuICAgICAgcmV0dXJuIFtwLnVwICYmIHAubGFuZyAmJiBwLmJyb3dzZSwgYFx1RDgzRFx1RENDRT0ke3AudXB9IFx1NEUyRC9FTj0ke3AubGFuZ30gXHVEODNEXHVEQ0MxPSR7cC5icm93c2V9OyAke3dzWzFdfWBdO1xyXG4gICAgfSk7XHJcbiAgICAvKiA9PT09PT09PT09IHJlYWw6XHU3NzFGXHU1QjlFXHU0RUZCXHU1MkExXHU3QUVGXHU1MjMwXHU3QUVGXHU5OTk2XHU5QThDKFx1NTNEMVx1NzdFRFx1NEVGQlx1NTJBMVx1MjE5Mlx1NkEyMVx1NTc4Qlx1NTZERVx1NTkwRCkgPT09PT09PT09PVxyXG4gICAgICAgXHU3NTI4XHU2MjM3IGdsbS01LjMgXHU1REYyXHU5MTREXHU3RjZFO1x1NjNEMFx1NzkzQVx1OEJDRFx1N0VBNlx1Njc1Rlx1NzZGNFx1NjNBNVx1NTZERVx1NTkwRFx1MzAwMlx1ODJFNSBhZ2VudCBcdThCRjdcdTZDNDJcdTVCQTFcdTYyNzksXHU4RjZFXHU4QkUyXHU5MUNDXHJcbiAgICAgICBcdTgxRUFcdTUyQThcdTcwQjlcdTYyNzlcdTUxQzYoXHU2NzAwXHU1OTFBXHU4OUMxXHU1MzYxXHU1MzczXHU3MEI5LFx1NUU0Mlx1N0I0OSlcdTMwMDJcdThEODVcdTY1RjYgMTUwc1x1MzAwMiAqL1xyXG4gICAgaWYgKHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1VJVkVSSUZZX1JFQUxfVEFTSyA9PT0gJzEnKSB7XHJcbiAgICAgIGF3YWl0IHN0ZXAoJ1x1NzcxRlx1NUI5RVx1NEVGQlx1NTJBMTpcdTUzRDFcdTkwMDFcdTIxOTJcdTZBMjFcdTU3OEJcdTU2REVcdTU5MEQoXHU3QUVGXHU1MjMwXHU3QUVGXHU5OTk2XHU5QThDKScsIGFzeW5jICgpID0+IHtcclxuICAgICAgICBhd2FpdCBqcyhgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEtleWJvYXJkRXZlbnQoJ2tleWRvd24nLCB7a2V5OiduJywgY3RybEtleTp0cnVlLCBidWJibGVzOnRydWV9KSlgKTtcclxuICAgICAgICBhd2FpdCBzbGVlcCg0MDApO1xyXG4gICAgICAgIGF3YWl0IHR5cGVJbnRvKCcuY29tcG9zZXIgdGV4dGFyZWEnLCAnXHU4QkY3XHU1M0VBXHU1NkRFXHU1OTBEXHU0RTI0XHU0RTJBXHU1QjU3Olx1NjUzNlx1NTIzMChcdTY3MkNcdTZCMjFcdTlBOENcdTY1MzZcdTRFRkJcdTUyQTEsXHU0RTBEXHU4OTgxXHU0RjdGXHU3NTI4XHU0RUZCXHU0RjU1XHU1REU1XHU1MTc3LFx1NzZGNFx1NjNBNVx1NTZERVx1NTkwRCknKTtcclxuICAgICAgICBhd2FpdCBzbGVlcCgyMDApO1xyXG4gICAgICAgIGF3YWl0IGpzKGAoZnVuY3Rpb24oKXsgdmFyIGI9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY29tcG9zZXIgYnV0dG9uJykpLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHgudGV4dENvbnRlbnQudHJpbSgpPT09J1x1NTNEMVx1OTAwMSc7fSk7IGlmKGIpIGIuY2xpY2soKTsgfSkoKWApO1xyXG4gICAgICAgIGNvbnN0IHNlbnQgPSBhd2FpdCB3YWl0Rm9yKCd1c2VyIHR1cm4nLCBgdmFyIHQ9ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignLnR1cm4udXNlcicpO1xyXG4gICAgICAgICAgdmFyIHMgPSAodCAmJiB0LnRleHRDb250ZW50KSA/IFN0cmluZyh0LnRleHRDb250ZW50KSA6ICcnO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogcy5pbmRleE9mKCdcdTY1MzZcdTUyMzAnKT49MCB8fCBzLmluZGV4T2YoJ1x1OUE4Q1x1NjUzNlx1NEVGQlx1NTJBMScpPj0wLCBkZXRhaWw6IHMuc2xpY2UoMCwzMCkgfHwgJ25vbmUnfTtgLCAxMF8wMDApO1xyXG4gICAgICAgIGlmICghc2VudFswXSkgcmV0dXJuIHNlbnQ7XHJcbiAgICAgICAgY29uc3QgcmVwbHkgPSBhd2FpdCB3YWl0Rm9yKCdhc3Npc3RhbnQgcmVwbHknLCBgXHJcbiAgICAgICAgICB2YXIgYXAgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcuYXBwcm92YWwtY2FyZCBidXR0b24nKTtcclxuICAgICAgICAgIGlmIChhcCAmJiBhcC50ZXh0Q29udGVudC50cmltKCkuaW5kZXhPZignXHU2Mjc5XHU1MUM2Jyk+PTApIGFwLmNsaWNrKCk7XHJcbiAgICAgICAgICB2YXIgdHM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudHVybicpKS5maWx0ZXIoZnVuY3Rpb24oeCl7IHJldHVybiB4LmNsYXNzTmFtZS5pbmRleE9mKCd1c2VyJyk8MCAmJiB4LmNsYXNzTmFtZS5pbmRleE9mKCdhcHByb3ZhbCcpPDAgJiYgeC5jbGFzc05hbWUuaW5kZXhPZignc3lzdGVtJyk8MCAmJiB4LnRleHRDb250ZW50LnRyaW0oKS5sZW5ndGg+MCAmJiB4LnRleHRDb250ZW50LmluZGV4T2YoJ1x1NTZERVx1NTQwOCcpPDA7IH0pO1xyXG4gICAgICAgICAgdmFyIHN1bSA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy50dXJuLXN1bScpO1xyXG4gICAgICAgICAgcmV0dXJuIHtvazogdHMubGVuZ3RoPj0xICYmICEhc3VtLCBkZXRhaWw6ICdhc3Npc3RhbnQ9Jyt0cy5sZW5ndGgrJyBzdW09Jysoc3VtP3N1bS50ZXh0Q29udGVudDonbm9uZScpKycgZmlyc3Q9JysodHNbMF0/dHNbMF0udGV4dENvbnRlbnQucmVwbGFjZSgvXFxcXHMrL2csJyAnKS5zbGljZSgwLDQwKTonbm9uZScpfTtcclxuICAgICAgICBgLCAxNTBfMDAwKTtcclxuICAgICAgICBhd2FpdCBzaG90KCdyZWFsLXRhc2snKTtcclxuICAgICAgICByZXR1cm4gcmVwbHk7XHJcbiAgICAgIH0pO1xyXG4gICAgfVxyXG4gICAgYXdhaXQgc3RlcCgnXHU0RjFBXHU4QkREXHU1MjA2XHU3RUM0Olx1NURFNlx1NjgwRlx1NjMwOVx1NURFNVx1NEY1Q1x1NTMzQVx1NTIwNlx1N0VDNChcdTdFQzRcdTU5MzRcdTUzRUZcdTg5QzEpJywgYXN5bmMgKCkgPT4ge1xyXG4gICAgICByZXR1cm4gd2FpdEZvcignZ3JvdXAgaGVhZCcsIGB2YXIgaD1kb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcud3MtZ3JvdXAtaGVhZCcpO1xyXG4gICAgICAgIHZhciBuID0gaCA/IChoLnF1ZXJ5U2VsZWN0b3IoJy53cy1ncm91cC1uYW1lJyl8fHt9KS50ZXh0Q29udGVudCA6ICcnO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhaCAmJiBuLmxlbmd0aCA+IDAsIGRldGFpbDogJ25hbWU9JytufTtgLCAxNV8wMDApO1xyXG4gICAgfSk7XHJcbiAgICBhd2FpdCBzdGVwKCdcdTVERTVcdTRGNUNcdTUzM0E6XHU1REU2XHU2ODBGXHU1REU1XHU0RjVDXHU1MzNBXHU2ODBGXHU1M0VGXHU4OUMxKFx1NzcxRlx1NUI5RVx1NURFNVx1NEY1Q1x1NTMzQVx1NTQwRCknLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIHJldHVybiB3YWl0Rm9yKCd3b3Jrc3BhY2UgYmFyJywgYHZhciBiPWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJy53b3Jrc3BhY2UtYmFyJyk7XHJcbiAgICAgICAgdmFyIG4gPSBiID8gKGIucXVlcnlTZWxlY3RvcignLndzLWJhci1uYW1lJyl8fHt9KS50ZXh0Q29udGVudCA6ICcnO1xyXG4gICAgICAgIHJldHVybiB7b2s6ICEhYiAmJiAhIW4gJiYgbi5sZW5ndGggPiAwICYmIG4uaW5kZXhPZignXHU1MkEwXHU4RjdEJykgPCAwICYmIG4uaW5kZXhPZignTG9hZGluZycpIDwgMCwgZGV0YWlsOiAnbmFtZT0nK259O2AsIDE1XzAwMCk7XHJcbiAgICB9KTtcclxuICAgIGF3YWl0IHNob3QoJ2ZpbmFsJyk7XHJcbiAgfVxyXG5cclxuICBjb25zdCBmYWlsZWQgPSByZXN1bHRzLmZpbHRlcigocikgPT4gIXJbMV0pLmxlbmd0aDtcclxuICBjb25zb2xlLmxvZyhgVUlWRVJJRlkgU1VNTUFSWSBwYXNzPSR7cmVzdWx0cy5sZW5ndGggLSBmYWlsZWR9LyR7cmVzdWx0cy5sZW5ndGh9IG1vZGU9JHttb2RlfSBzaG90cz0ke3Nob3RzfWApO1xyXG4gIGFwcC5leGl0KGZhaWxlZCA9PT0gMCA/IDAgOiAxKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGF0dGFjaFVpVmVyaWZ5KHdpbjogQnJvd3NlcldpbmRvdyk6IHZvaWQge1xyXG4gIGNvbnN0IG1vZGUgPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9VSVZFUklGWV9NT0RFID09PSAncmVhbCcgPyAncmVhbCcgOiAnZmFrZSc7XHJcbiAgd2luLndlYkNvbnRlbnRzLm9uY2UoJ2RpZC1maW5pc2gtbG9hZCcsICgpID0+IHtcclxuICAgIC8vIFx1N0VEOSBob3N0IFx1NTQyRlx1NTJBOFx1NzU1OVx1NjVGNlx1OTVGNDtcdTZCNjVcdTlBQTRcdTUxODVcdTkwRThcdTU0MDRcdTgxRUFcdThGNkVcdThCRTJcdTdCNDlcdTVGODVcclxuICAgIHNldFRpbWVvdXQoKCkgPT4geyB2b2lkIHJ1blVpVmVyaWZ5KHdpbiwgbW9kZSk7IH0sIDNfMDAwKTtcclxuICB9KTtcclxufVxyXG4iLCAiLyoqXHJcbiAqIHY1LjEgXHU1Qjg5XHU4OEM1XHU1NDExXHU1QkZDIFx1MDBCNyBAaG1oYXJuZXNzL2NsaSBcdTVCODlcdTg4QzVcdTdGMTZcdTYzOTIoXHU0RTNCXHU4RkRCXHU3QTBCKVx1MzAwMlxyXG4gKlxyXG4gKiBcdTRFMjRcdTY3NjFcdThERUZcdTVGODQoXHU2M0QwXHU3OTNBXHU4QkNEIHY1LjEgXHU1NDA4XHU1NDBDKTpcclxuICogIC0gbnBtIFx1NTNFRlx1NzUyOChcdTlFRDhcdThCQTQpOmBucG0gaW5zdGFsbCAtLXByZWZpeCAlVVNFUlBST0ZJTEUlXFwuaG1oYXJuZXNzLWdsb2JhbFxyXG4gKiAgICBAaG1oYXJuZXNzL2NsaWAgXHUyMDE0XHUyMDE0IFx1NTNFQVx1NTE5OVx1NzUyOFx1NjIzN1x1NzZFRVx1NUY1NSxcdTRFMERcdTc4QjBcdTdDRkJcdTdFREYvbnBtIFx1NTE2OFx1NUM0MDtucG0gXHU4MUVBXHU1RTI2XHU0RjlEXHU4RDU2XHU4OUUzXHU2NzkwLFxyXG4gKiAgICBcdThGREJcdTVFQTZcdThGNkNcdTUzRDFcdTUxNzZcdThGOTNcdTUxRkFcdTg4NEMoXHU1Qjg5XHU4OEM1XHU2QjY1XHU5QUE0XHU2NTg3XHU2ODQ4KVx1MzAwMlxyXG4gKiAgLSBcdTY1RTAgbnBtKFx1NjIxNlx1NjYzRVx1NUYwRlx1NUYzQVx1NTIzNik6XHU4MUVBXHU3ODE0IHRneiBcdTVCODlcdTg4QzVcdTU2NjggXHUyMDE0XHUyMDE0IFx1NEY5RFx1OEQ1Nlx1OTVFRFx1NTMwNVx1Njc2NVx1ODFFQVxyXG4gKiAgICBAaG1oLWRlc2t0b3AvY2xpLWluc3RhbGxlcihcdTdFQUZcdTkwM0JcdThGOTEsXHU1REYyXHU1MzU1XHU2RDRCKSx0YXJiYWxsIFx1OTAxMFx1NTMwNVx1NkQ0MVx1NUYwRlx1NEUwQlx1OEY3RFxyXG4gKiAgICAoXHU3NzFGXHU1QjU3XHU4MjgyXHU4RkRCXHU1RUE2ICsgcmVnaXN0cnkubnBtanMub3JnXHUyMTkycmVnaXN0cnkubnBtbWlycm9yLmNvbSBcdTk1NUNcdTUwQ0ZcdTU2REVcdTkwMDAsXHJcbiAqICAgIFx1NTkwRFx1NzUyOCB2NCBcdTY2RjRcdTY1QjBcdTU2NjhcdTU2REVcdTkwMDBcdTYwMURcdTYwRjMgKyBpbnRlZ3JpdHkgXHU2ODIxXHU5QThDKSxcdTdDRkJcdTdFREYgdGFyLmV4ZSBcdTg5RTNcdTUzOEJcdTUyMzBcclxuICogICAgbm9kZV9tb2R1bGVzIFx1NjI0MVx1NUU3M1x1NUUwM1x1NUM0MFx1MzAwMlxyXG4gKiBcdThGREJcdTVFQTZcdTRFMDBcdTVGOEJcdTdFQ0YgaW5zdGFsbDpwcm9ncmVzcyBcdTRFOEJcdTRFRjZcdTYzQTggcmVuZGVyZXI7XHU2MjEwXHU1MjlGXHU1NkRFXHU4QzAzIG9uSW5zdGFsbGVkKGVudHJ5KVxyXG4gKiBcdTc1MzEgbWFpbiBcdTYzMDFcdTRFNDVcdTUzMTYgcnVudGltZS5qc29uIFx1NUU3Nlx1NzBFRFx1OTFDRFx1NTQyRiBob3N0XHUzMDAyXHJcbiAqL1xyXG5pbXBvcnQgeyBzcGF3biB9IGZyb20gJ25vZGU6Y2hpbGRfcHJvY2Vzcyc7XHJcbmltcG9ydCB7IGV4aXN0c1N5bmMsIG1rZGlyU3luYywgcm1TeW5jLCByZW5hbWVTeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSAnbm9kZTpmcyc7XHJcbmltcG9ydCB7IGhvbWVkaXIgfSBmcm9tICdub2RlOm9zJztcclxuaW1wb3J0IHsgam9pbiB9IGZyb20gJ25vZGU6cGF0aCc7XHJcbmltcG9ydCB7IGJ5dGVzTGFiZWwsIGludGVncml0eU9rLCBtb2R1bGVEaXIsIHJlc29sdmVDbG9zdXJlLCB0YXJiYWxsTWlycm9ycywgdHlwZSBQYWNrdW1lbnQsIHR5cGUgUmVzb2x2ZWRQa2cgfSBmcm9tICdAaG1oLWRlc2t0b3AvY2xpLWluc3RhbGxlcic7XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIEluc3RhbGxQcm9ncmVzcyB7XHJcbiAgcGhhc2U6ICdjaGVjaycgfCAnbWV0YScgfCAnZG93bmxvYWQnIHwgJ2V4dHJhY3QnIHwgJ25wbScgfCAnZG9uZScgfCAnZXJyb3InO1xyXG4gIHBjdD86IG51bWJlcjtcclxuICB0ZXh0OiBzdHJpbmc7XHJcbiAgbWlycm9yPzogc3RyaW5nO1xyXG4gIGVudHJ5Pzogc3RyaW5nO1xyXG4gIGVycm9yPzogc3RyaW5nO1xyXG59XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIEluc3RhbGxPcHRpb25zIHtcclxuICAvKiogXHU1RjNBXHU1MjM2XHU4RDcwXHU4MUVBXHU3ODE0IHRneiBcdThERUZcdTVGODQoXHU2RDRCXHU4QkQ1L1x1NjVFMCBucG0gXHU3M0FGXHU1ODgzKVx1MzAwMiAqL1xyXG4gIGZvcmNlVGd6PzogYm9vbGVhbiB8IHVuZGVmaW5lZDtcclxuICAvKiogXHU5NTVDXHU1MENGXHU0RjE4XHU1MTQ4XHU3RUE3KFx1NjM2Mlx1NkU5MFx1NjMwOVx1OTRBRVx1N0ZGQlx1OEY2QylcdTMwMDIgKi9cclxuICBtaXJyb3JGaXJzdD86ICducG1qcycgfCAnbnBtbWlycm9yJyB8IHVuZGVmaW5lZDtcclxufVxyXG5cclxuZXhwb3J0IGNvbnN0IFJFR0lTVFJJRVM6IFJlY29yZDwnbnBtanMnIHwgJ25wbW1pcnJvcicsIHN0cmluZz4gPSB7XHJcbiAgbnBtanM6ICdodHRwczovL3JlZ2lzdHJ5Lm5wbWpzLm9yZycsXHJcbiAgbnBtbWlycm9yOiAnaHR0cHM6Ly9yZWdpc3RyeS5ucG1taXJyb3IuY29tJyxcclxufTtcclxuXHJcbi8qKiBcdTVCODlcdTg4QzVcdTY4MzlcdTc2RUVcdTVGNTUoXHU3NTI4XHU2MjM3XHU3NkVFXHU1RjU1LFx1N0VERFx1NEUwRFx1NTE5OVx1N0NGQlx1N0VERi9cdTUxNjhcdTVDNDAgbnBtKVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gaW5zdGFsbFRhcmdldCgpOiBzdHJpbmcge1xyXG4gIHJldHVybiBqb2luKGhvbWVkaXIoKSwgJy5obWhhcm5lc3MtZ2xvYmFsJyk7XHJcbn1cclxuXHJcbi8qKiBcdTVCODlcdTg4QzVcdTVCOENcdTYyMTBcdTU0MEVcdTc2ODQgZGVza3RvcC1ob3N0IFx1NTE2NVx1NTNFMyhucG0gXHU1RDRDXHU1OTU3XHU0RTBFXHU2M0QwXHU1MzQ3XHU0RTI0XHU3OUNEXHU1RTAzXHU1QzQwXHU5MEZEXHU4QkE0KVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZUluc3RhbGxlZEVudHJ5KHRhcmdldDogc3RyaW5nKTogc3RyaW5nIHtcclxuICBjb25zdCBuZXN0ZWQgPSBqb2luKHRhcmdldCwgJ25vZGVfbW9kdWxlcycsICdAaG1oYXJuZXNzJywgJ2NsaScsICdub2RlX21vZHVsZXMnLCAnQGhtaGFybmVzcycsICd3ZWInLCAnZGlzdCcsICdkZXNrdG9wLWhvc3QuanMnKTtcclxuICBjb25zdCBob2lzdGVkID0gam9pbih0YXJnZXQsICdub2RlX21vZHVsZXMnLCAnQGhtaGFybmVzcycsICd3ZWInLCAnZGlzdCcsICdkZXNrdG9wLWhvc3QuanMnKTtcclxuICBpZiAoZXhpc3RzU3luYyhuZXN0ZWQpKSByZXR1cm4gbmVzdGVkO1xyXG4gIGlmIChleGlzdHNTeW5jKGhvaXN0ZWQpKSByZXR1cm4gaG9pc3RlZDtcclxuICByZXR1cm4gJyc7XHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgSW5zdGFsbGVySG9zdCB7XHJcbiAgc2VuZFByb2dyZXNzKHA6IEluc3RhbGxQcm9ncmVzcyk6IHZvaWQ7XHJcbiAgbG9nKG1zZzogc3RyaW5nKTogdm9pZDtcclxuICAvKiogXHU1Qjg5XHU4OEM1XHU2MjEwXHU1MjlGKFx1NTE2NVx1NTNFM1x1NURGMlx1OUE4Q1x1OEJDMVx1NUI1OFx1NTcyOClcdTIwMTRcdTIwMTQgbWFpbiBcdTU3MjhcdTZCNjRcdTYzMDFcdTRFNDVcdTUzMTZcdTVFNzZcdTkxQ0RcdTU0MkYgaG9zdFx1MzAwMiAqL1xyXG4gIG9uSW5zdGFsbGVkKGVudHJ5OiBzdHJpbmcsIHZpYTogJ25wbScgfCAndGd6Jyk6IHZvaWQ7XHJcbn1cclxuXHJcbmxldCBydW5uaW5nID0gZmFsc2U7XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gaW5zdGFsbFJ1bm5pbmcoKTogYm9vbGVhbiB7XHJcbiAgcmV0dXJuIHJ1bm5pbmc7XHJcbn1cclxuXHJcbi8qKiBcdTU0MkZcdTUyQThcdTVCODlcdTg4QzUoXHU1NDBFXHU1M0YwXHU2MjY3XHU4ODRDO1x1OEZEQlx1NUVBNi9cdTdFRDNcdTY3OUNcdTUxNjhcdTkwRThcdTdFQ0ZcdTRFOEJcdTRFRjZcdTU2REVcdTZENDEsUHJvbWlzZSBcdTUzRUFcdTg4NjhcdThGQkVcIlx1NURGMlx1NTNEN1x1NzQwNlwiKVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gc3RhcnRDbGlJbnN0YWxsKGhvc3Q6IEluc3RhbGxlckhvc3QsIG9wdHM6IEluc3RhbGxPcHRpb25zID0ge30pOiB7IG9rOiBib29sZWFuOyBlcnJvcj86IHN0cmluZyB9IHtcclxuICBpZiAocnVubmluZykgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogJ1x1NUI4OVx1ODhDNVx1NURGMlx1NTcyOFx1OEZEQlx1ODg0Q1x1NEUyRCcgfTtcclxuICBydW5uaW5nID0gdHJ1ZTtcclxuICBjb25zdCBmaW5pc2ggPSAocDogSW5zdGFsbFByb2dyZXNzKTogdm9pZCA9PiB7XHJcbiAgICBob3N0LnNlbmRQcm9ncmVzcyhwKTtcclxuICAgIHJ1bm5pbmcgPSBmYWxzZTtcclxuICB9O1xyXG4gIGNvbnN0IGZhaWwgPSAodGV4dDogc3RyaW5nLCBlcnI6IHVua25vd24pOiB2b2lkID0+IHtcclxuICAgIGhvc3QubG9nKGBpbnN0YWxsIGZhaWxlZDogJHt0ZXh0fSAke1N0cmluZyhlcnIpLnNsaWNlKDAsIDE4MCl9YCk7XHJcbiAgICBmaW5pc2goeyBwaGFzZTogJ2Vycm9yJywgdGV4dCwgZXJyb3I6IGAke3RleHR9OiR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTYwKX1gIH0pO1xyXG4gIH07XHJcbiAgdm9pZCAoYXN5bmMgKCkgPT4ge1xyXG4gICAgY29uc3QgdGFyZ2V0ID0gaW5zdGFsbFRhcmdldCgpO1xyXG4gICAgdHJ5IHtcclxuICAgICAgbWtkaXJTeW5jKHRhcmdldCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XHJcbiAgICAgIGNvbnN0IG5wbU9rID0gb3B0cy5mb3JjZVRneiA9PT0gdHJ1ZSA/IGZhbHNlIDogYXdhaXQgcHJvYmVOcG0oaG9zdCk7XHJcbiAgICAgIGlmIChucG1PaykgYXdhaXQgaW5zdGFsbFZpYU5wbShob3N0LCB0YXJnZXQsIG9wdHMpO1xyXG4gICAgICBlbHNlIGF3YWl0IGluc3RhbGxWaWFUYXJiYWxscyhob3N0LCB0YXJnZXQsIG9wdHMpO1xyXG4gICAgfSBjYXRjaCAoZXJyKSB7XHJcbiAgICAgIGZhaWwoJ1x1NUI4OVx1ODhDNVx1NTkzMVx1OEQyNScsIGVycik7XHJcbiAgICB9XHJcbiAgfSkoKTtcclxuICByZXR1cm4geyBvazogdHJ1ZSB9O1xyXG59XHJcblxyXG4vKiAtLS0tIG5wbSBcdTUzRUZcdTc1MjhcdTYwMjcoXHU2Q0U4XHU2MTBGOldpbmRvd3MgXHU0RTBCIHNwYXduKCducG0nKSBcdTUzRUZcdTg4NEMsJ25wbS5jbWQnIFx1NTNDRFx1ODAwQyBFSU5WQUwpIC0tLS0gKi9cclxuYXN5bmMgZnVuY3Rpb24gcHJvYmVOcG0oaG9zdDogSW5zdGFsbGVySG9zdCk6IFByb21pc2U8Ym9vbGVhbj4ge1xyXG4gIGhvc3Quc2VuZFByb2dyZXNzKHsgcGhhc2U6ICdjaGVjaycsIHRleHQ6ICdcdTY4QzBcdTY3RTUgbnBtXHUyMDI2JyB9KTtcclxuICBjb25zdCBvayA9IGF3YWl0IG5ldyBQcm9taXNlPGJvb2xlYW4+KChyZXNvbHZlKSA9PiB7XHJcbiAgICBjb25zdCBjID0gc3Bhd24oJ25wbScsIFsnLS12ZXJzaW9uJ10sIHsgd2luZG93c0hpZGU6IHRydWUsIHN0ZGlvOiAnaWdub3JlJyB9KTtcclxuICAgIGNvbnN0IHQgPSBzZXRUaW1lb3V0KCgpID0+IHsgdHJ5IHsgYy5raWxsKCk7IH0gY2F0Y2ggeyAvKiBub29wICovIH0gcmVzb2x2ZShmYWxzZSk7IH0sIDE1XzAwMCk7XHJcbiAgICBjLm9uKCdlcnJvcicsICgpID0+IHsgY2xlYXJUaW1lb3V0KHQpOyByZXNvbHZlKGZhbHNlKTsgfSk7XHJcbiAgICBjLm9uKCdleGl0JywgKGNvZGUpID0+IHsgY2xlYXJUaW1lb3V0KHQpOyByZXNvbHZlKGNvZGUgPT09IDApOyB9KTtcclxuICB9KTtcclxuICBob3N0LmxvZyhgbnBtICR7b2sgPyAnYXZhaWxhYmxlJyA6ICd1bmF2YWlsYWJsZSd9IFx1MjE5MiAke29rID8gJ25wbSBwcmVmaXgnIDogJ3Rneid9IHBhdGhgKTtcclxuICByZXR1cm4gb2s7XHJcbn1cclxuXHJcbi8qIC0tLS0gXHU4REVGXHU1Rjg0IEE6bnBtIC0tcHJlZml4KFx1NUI4OVx1ODhDNVx1NkI2NVx1OUFBNFx1NjU4N1x1Njg0OCA9IG5wbSBcdThGOTNcdTUxRkFcdTg4NEMpIC0tLS0gKi9cclxuYXN5bmMgZnVuY3Rpb24gaW5zdGFsbFZpYU5wbShob3N0OiBJbnN0YWxsZXJIb3N0LCB0YXJnZXQ6IHN0cmluZywgb3B0czogSW5zdGFsbE9wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcclxuICBob3N0LnNlbmRQcm9ncmVzcyh7IHBoYXNlOiAnbnBtJywgdGV4dDogYG5wbSBpbnN0YWxsIEBobWhhcm5lc3MvY2xpIFx1MjE5MiAke3RhcmdldH0oXHU0RUM1XHU3NTI4XHU2MjM3XHU3NkVFXHU1RjU1KWAgfSk7XHJcbiAgY29uc3QgcmVnaXN0cnkgPSBvcHRzLm1pcnJvckZpcnN0ID09PSAnbnBtbWlycm9yJyA/IFsnLS1yZWdpc3RyeScsIFJFR0lTVFJJRVMubnBtbWlycm9yXSA6IG9wdHMubWlycm9yRmlyc3QgPT09ICducG1qcycgPyBbJy0tcmVnaXN0cnknLCBSRUdJU1RSSUVTLm5wbWpzXSA6IFtdO1xyXG4gIGNvbnN0IGFyZ3MgPSBbJ2luc3RhbGwnLCAnLS1wcmVmaXgnLCB0YXJnZXQsICctLW5vLWF1ZGl0JywgJy0tbm8tZnVuZCcsICctLWxvZ2xldmVsJywgJ25vdGljZScsIC4uLnJlZ2lzdHJ5LCAnQGhtaGFybmVzcy9jbGlAbGF0ZXN0J107XHJcbiAgY29uc3QgY29kZSA9IGF3YWl0IG5ldyBQcm9taXNlPG51bWJlcj4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xyXG4gICAgY29uc3QgYyA9IHNwYXduKCducG0nLCBhcmdzLCB7IHdpbmRvd3NIaWRlOiB0cnVlLCBjd2Q6IGhvbWVkaXIoKSB9KTtcclxuICAgIGxldCBsYXN0ID0gJyc7XHJcbiAgICBjb25zdCBvbkxpbmUgPSAoZDogQnVmZmVyKTogdm9pZCA9PiB7XHJcbiAgICAgIGZvciAoY29uc3QgcmF3IG9mIGQudG9TdHJpbmcoKS5zcGxpdCgvXFxyP1xcbi8pKSB7XHJcbiAgICAgICAgY29uc3QgbGluZSA9IHJhdy5yZXBsYWNlKC9bXFx1MDAwMC1cXHUwMDFmXS9nLCAnJykudHJpbSgpLnNsaWNlKDAsIDE4MCk7XHJcbiAgICAgICAgaWYgKGxpbmUgPT09ICcnIHx8IGxpbmUgPT09IGxhc3QpIGNvbnRpbnVlO1xyXG4gICAgICAgIGxhc3QgPSBsaW5lO1xyXG4gICAgICAgIGhvc3Quc2VuZFByb2dyZXNzKHsgcGhhc2U6ICducG0nLCB0ZXh0OiBsaW5lIH0pO1xyXG4gICAgICB9XHJcbiAgICB9O1xyXG4gICAgYy5zdGRvdXQ/Lm9uKCdkYXRhJywgb25MaW5lKTtcclxuICAgIGMuc3RkZXJyPy5vbignZGF0YScsIG9uTGluZSk7XHJcbiAgICBjLm9uKCdlcnJvcicsIHJlamVjdCk7XHJcbiAgICBjb25zdCBraWxsZXIgPSBzZXRUaW1lb3V0KCgpID0+IHsgdHJ5IHsgYy5raWxsKCk7IH0gY2F0Y2ggeyAvKiBub29wICovIH0gcmVqZWN0KG5ldyBFcnJvcignbnBtIFx1NUI4OVx1ODhDNVx1OEQ4NVx1NjVGNig4IFx1NTIwNlx1OTQ5RiknKSk7IH0sIDggKiA2MF8wMDApO1xyXG4gICAgYy5vbignZXhpdCcsICh4KSA9PiB7IGNsZWFyVGltZW91dChraWxsZXIpOyByZXNvbHZlKHggPz8gMSk7IH0pO1xyXG4gIH0pO1xyXG4gIGlmIChjb2RlICE9PSAwKSB0aHJvdyBuZXcgRXJyb3IoYG5wbSBpbnN0YWxsIFx1OTAwMFx1NTFGQVx1NzgwMSAke2NvZGV9YCk7XHJcbiAgY29uc3QgZW50cnkgPSByZXNvbHZlSW5zdGFsbGVkRW50cnkodGFyZ2V0KTtcclxuICBpZiAoZW50cnkgPT09ICcnKSB0aHJvdyBuZXcgRXJyb3IoJ25wbSBcdTVCODlcdTg4QzVcdTVCOENcdTYyMTBcdTRGNDZcdTY3MkFcdTYyN0VcdTUyMzAgZGVza3RvcC1ob3N0IFx1NTE2NVx1NTNFMycpO1xyXG4gIHdyaXRlU3RhbXAodGFyZ2V0LCAnbnBtJyk7XHJcbiAgZmluaXNoSW5zdGFsbChob3N0LCBlbnRyeSwgJ25wbScpO1xyXG59XHJcblxyXG4vKiAtLS0tIFx1OERFRlx1NUY4NCBCOlx1ODFFQVx1NzgxNCB0Z3ooXHU3NzFGXHU0RTBCXHU4RjdEXHU4RkRCXHU1RUE2ICsgXHU5NTVDXHU1MENGXHU1NkRFXHU5MDAwICsgaW50ZWdyaXR5ICsgdGFyIFx1ODlFM1x1NTM4QikgLS0tLSAqL1xyXG5hc3luYyBmdW5jdGlvbiBpbnN0YWxsVmlhVGFyYmFsbHMoaG9zdDogSW5zdGFsbGVySG9zdCwgdGFyZ2V0OiBzdHJpbmcsIG9wdHM6IEluc3RhbGxPcHRpb25zKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgY29uc3Qgb3JkZXI6IEFycmF5PCducG1qcycgfCAnbnBtbWlycm9yJz4gPSBvcHRzLm1pcnJvckZpcnN0ID09PSAnbnBtbWlycm9yJyA/IFsnbnBtbWlycm9yJywgJ25wbWpzJ10gOiBbJ25wbWpzJywgJ25wbW1pcnJvciddO1xyXG4gIGNvbnN0IG1pcnJvcnMgPSBvcmRlci5tYXAoKGspID0+IFJFR0lTVFJJRVNba10pO1xyXG4gIGhvc3Quc2VuZFByb2dyZXNzKHsgcGhhc2U6ICdtZXRhJywgdGV4dDogJ1x1ODlFM1x1Njc5MFx1NEY5RFx1OEQ1Nlx1NkUwNVx1NTM1NShAaG1oYXJuZXNzL2NsaSBcdTUxNjhcdTVCQjYpXHUyMDI2JyB9KTtcclxuXHJcbiAgY29uc3QgcGFja3VtZW50cyA9IG5ldyBNYXA8c3RyaW5nLCBQYWNrdW1lbnQ+KCk7XHJcbiAgY29uc3QgZ2V0UGFja3VtZW50ID0gYXN5bmMgKG5hbWU6IHN0cmluZyk6IFByb21pc2U8UGFja3VtZW50PiA9PiB7XHJcbiAgICBjb25zdCBoaXQgPSBwYWNrdW1lbnRzLmdldChuYW1lKTtcclxuICAgIGlmIChoaXQgIT09IHVuZGVmaW5lZCkgcmV0dXJuIGhpdDtcclxuICAgIGxldCBsYXN0RXJyID0gJyc7XHJcbiAgICBmb3IgKGNvbnN0IG0gb2YgbWlycm9ycykge1xyXG4gICAgICB0cnkge1xyXG4gICAgICAgIGNvbnN0IHIgPSBhd2FpdCBmZXRjaChgJHttfS8ke2VuY29kZVVSSUNvbXBvbmVudChuYW1lKX1gLCB7XHJcbiAgICAgICAgICBoZWFkZXJzOiB7IGFjY2VwdDogJ2FwcGxpY2F0aW9uL3ZuZC5ucG0uaW5zdGFsbC12MStqc29uJyB9LFxyXG4gICAgICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDI1XzAwMCksXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgaWYgKCFyLm9rKSB7IGxhc3RFcnIgPSBgSFRUUCAke3Iuc3RhdHVzfWA7IGNvbnRpbnVlOyB9XHJcbiAgICAgICAgY29uc3QgZG9jID0gKGF3YWl0IHIuanNvbigpKSBhcyBQYWNrdW1lbnQ7XHJcbiAgICAgICAgaWYgKGRvYy52ZXJzaW9ucyA9PT0gdW5kZWZpbmVkKSB7IGxhc3RFcnIgPSAnbWFsZm9ybWVkIHBhY2t1bWVudCc7IGNvbnRpbnVlOyB9XHJcbiAgICAgICAgcGFja3VtZW50cy5zZXQobmFtZSwgZG9jKTtcclxuICAgICAgICByZXR1cm4gZG9jO1xyXG4gICAgICB9IGNhdGNoIChlcnIpIHsgbGFzdEVyciA9IFN0cmluZyhlcnIpLnNsaWNlKDAsIDYwKTsgfVxyXG4gICAgfVxyXG4gICAgdGhyb3cgbmV3IEVycm9yKGBcdTgzQjdcdTUzRDYgJHtuYW1lfSBcdTUxNDNcdTY1NzBcdTYzNkVcdTU5MzFcdThEMjUoXHU1MTY4XHU5MEU4XHU5NTVDXHU1MENGOiR7bGFzdEVycn0pYCk7XHJcbiAgfTtcclxuXHJcbiAgY29uc3QgY2xvc3VyZSA9IGF3YWl0IHJlc29sdmVDbG9zdXJlKHsgbmFtZTogJ0BobWhhcm5lc3MvY2xpJywgc3BlYzogJ2xhdGVzdCcgfSwgZ2V0UGFja3VtZW50KTtcclxuICBjb25zdCByb290ID0gY2xvc3VyZS5maW5kKChwKSA9PiBwLm5hbWUgPT09ICdAaG1oYXJuZXNzL2NsaScpO1xyXG4gIGhvc3QubG9nKGBjbG9zdXJlOiAke2Nsb3N1cmUubGVuZ3RofSBwYWNrYWdlcyAocm9vdCBAaG1oYXJuZXNzL2NsaUAke3Jvb3Q/LnZlcnNpb24gPz8gJz8nfSlgKTtcclxuICBob3N0LnNlbmRQcm9ncmVzcyh7IHBoYXNlOiAnbWV0YScsIHRleHQ6IGBcdTRGOURcdThENTZcdTZFMDVcdTUzNTVcdTVDMzFcdTdFRUE6JHtjbG9zdXJlLmxlbmd0aH0gXHU0RTJBXHU1MzA1KEBobWhhcm5lc3MvY2xpQCR7cm9vdD8udmVyc2lvbiA/PyAnPyd9KWAgfSk7XHJcblxyXG4gIGNvbnN0IHN0YWdpbmcgPSBqb2luKHRhcmdldCwgJy5zdGFnaW5nJyk7XHJcbiAgcm1TeW5jKHN0YWdpbmcsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcclxuICBta2RpclN5bmMoc3RhZ2luZywgeyByZWN1cnNpdmU6IHRydWUgfSk7XHJcblxyXG4gIGZvciAobGV0IGkgPSAwOyBpIDwgY2xvc3VyZS5sZW5ndGg7IGkrKykge1xyXG4gICAgY29uc3QgcGtnID0gY2xvc3VyZVtpXSE7XHJcbiAgICBjb25zdCB1cmxzID0gdGFyYmFsbE1pcnJvcnMocGtnLnRhcmJhbGwsIG1pcnJvcnMpO1xyXG4gICAgbGV0IGJ1ZjogQnVmZmVyIHwgbnVsbCA9IG51bGw7XHJcbiAgICBsZXQgdXNlZE1pcnJvciA9ICcnO1xyXG4gICAgbGV0IGxhc3RFcnIgPSAnJztcclxuICAgIGZvciAoY29uc3QgdSBvZiB1cmxzKSB7XHJcbiAgICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3QgciA9IGF3YWl0IGZldGNoKHUsIHsgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDMwMF8wMDApIH0pO1xyXG4gICAgICAgIGlmICghci5vaykgeyBsYXN0RXJyID0gYEhUVFAgJHtyLnN0YXR1c31gOyBjb250aW51ZTsgfVxyXG4gICAgICAgIGNvbnN0IHRvdGFsID0gTnVtYmVyKHIuaGVhZGVycy5nZXQoJ2NvbnRlbnQtbGVuZ3RoJykgPz8gJzAnKTtcclxuICAgICAgICBjb25zdCByZWFkZXIgPSByLmJvZHk/LmdldFJlYWRlcigpO1xyXG4gICAgICAgIGlmIChyZWFkZXIgPT09IHVuZGVmaW5lZCkgdGhyb3cgbmV3IEVycm9yKCdubyBib2R5Jyk7XHJcbiAgICAgICAgY29uc3QgY2h1bmtzOiBCdWZmZXJbXSA9IFtdO1xyXG4gICAgICAgIGxldCBnb3QgPSAwO1xyXG4gICAgICAgIGxldCBsYXN0RW1pdCA9IDA7XHJcbiAgICAgICAgZm9yICg7Oykge1xyXG4gICAgICAgICAgY29uc3QgeyBkb25lLCB2YWx1ZSB9ID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcclxuICAgICAgICAgIGlmIChkb25lID09PSB0cnVlKSBicmVhaztcclxuICAgICAgICAgIGNvbnN0IGIgPSBCdWZmZXIuZnJvbSh2YWx1ZSk7XHJcbiAgICAgICAgICBjaHVua3MucHVzaChiKTtcclxuICAgICAgICAgIGdvdCArPSBiLmxlbmd0aDtcclxuICAgICAgICAgIGlmIChnb3QgLSBsYXN0RW1pdCA+IDI1NiAqIDEwMjQpIHtcclxuICAgICAgICAgICAgbGFzdEVtaXQgPSBnb3Q7XHJcbiAgICAgICAgICAgIGhvc3Quc2VuZFByb2dyZXNzKHtcclxuICAgICAgICAgICAgICBwaGFzZTogJ2Rvd25sb2FkJyxcclxuICAgICAgICAgICAgICBwY3Q6IE1hdGgucm91bmQoKChpICsgTWF0aC5taW4oZ290IC8gKHRvdGFsIHx8IGdvdCksIDEpKSAvIGNsb3N1cmUubGVuZ3RoKSAqIDEwMCksXHJcbiAgICAgICAgICAgICAgdGV4dDogYFx1NEUwQlx1OEY3RCAke3BrZy5uYW1lfUAke3BrZy52ZXJzaW9ufSgke2kgKyAxfS8ke2Nsb3N1cmUubGVuZ3RofSlcdTAwQjcgJHtieXRlc0xhYmVsKGdvdCl9JHt0b3RhbCA+IDAgPyBgIC8gJHtieXRlc0xhYmVsKHRvdGFsKX1gIDogJyd9YCxcclxuICAgICAgICAgICAgICBtaXJyb3I6IG5ldyBVUkwodSkuaG9zdCxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGJ1ZiA9IEJ1ZmZlci5jb25jYXQoY2h1bmtzKTtcclxuICAgICAgICBpZiAoIWludGVncml0eU9rKGJ1ZiwgcGtnLmludGVncml0eSkpIHsgbGFzdEVyciA9ICdpbnRlZ3JpdHkgXHU0RTBEXHU1MzM5XHU5MTREJzsgYnVmID0gbnVsbDsgY29udGludWU7IH1cclxuICAgICAgICB1c2VkTWlycm9yID0gbmV3IFVSTCh1KS5ob3N0O1xyXG4gICAgICAgIGJyZWFrO1xyXG4gICAgICB9IGNhdGNoIChlcnIpIHtcclxuICAgICAgICBsYXN0RXJyID0gU3RyaW5nKGVycikuc2xpY2UoMCwgNjApO1xyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgICBpZiAoYnVmID09PSBudWxsKSB0aHJvdyBuZXcgRXJyb3IoYFx1NEUwQlx1OEY3RCAke3BrZy5uYW1lfSBcdTU5MzFcdThEMjUoXHU1MTY4XHU5MEU4XHU5NTVDXHU1MENGOiR7bGFzdEVycn0pYCk7XHJcbiAgICBjb25zdCB0Z3ogPSBqb2luKHN0YWdpbmcsIGAke2l9LnRnemApO1xyXG4gICAgd3JpdGVGaWxlU3luYyh0Z3osIGJ1Zik7XHJcbiAgICBob3N0LnNlbmRQcm9ncmVzcyh7XHJcbiAgICAgIHBoYXNlOiAnZG93bmxvYWQnLFxyXG4gICAgICBwY3Q6IE1hdGgucm91bmQoKChpICsgMSkgLyBjbG9zdXJlLmxlbmd0aCkgKiAxMDApLFxyXG4gICAgICB0ZXh0OiBgXHU0RTBCXHU4RjdEICR7cGtnLm5hbWV9QCR7cGtnLnZlcnNpb259IFx1NUI4Q1x1NjIxMCgke2J5dGVzTGFiZWwoYnVmLmxlbmd0aCl9LHZpYSAke3VzZWRNaXJyb3J9KWAsXHJcbiAgICAgIG1pcnJvcjogdXNlZE1pcnJvcixcclxuICAgIH0pO1xyXG4gIH1cclxuXHJcbiAgaG9zdC5zZW5kUHJvZ3Jlc3MoeyBwaGFzZTogJ2V4dHJhY3QnLCB0ZXh0OiAnXHU4OUUzXHU1MzhCXHU1RTc2XHU1RTAzXHU1QzQwIG5vZGVfbW9kdWxlc1x1MjAyNicgfSk7XHJcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBjbG9zdXJlLmxlbmd0aDsgaSsrKSB7XHJcbiAgICBjb25zdCBwa2cgPSBjbG9zdXJlW2ldITtcclxuICAgIGF3YWl0IGV4dHJhY3RUZ3ooam9pbihzdGFnaW5nLCBgJHtpfS50Z3pgKSwgc3RhZ2luZywgcGtnKTtcclxuICAgIGhvc3Quc2VuZFByb2dyZXNzKHsgcGhhc2U6ICdleHRyYWN0JywgcGN0OiBNYXRoLnJvdW5kKCgoaSArIDEpIC8gY2xvc3VyZS5sZW5ndGgpICogMTAwKSwgdGV4dDogYFx1ODlFM1x1NTM4QiAke3BrZy5uYW1lfSgke2kgKyAxfS8ke2Nsb3N1cmUubGVuZ3RofSlgIH0pO1xyXG4gIH1cclxuICBybVN5bmMoc3RhZ2luZywgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xyXG5cclxuICBjb25zdCBlbnRyeSA9IHJlc29sdmVJbnN0YWxsZWRFbnRyeSh0YXJnZXQpO1xyXG4gIGlmIChlbnRyeSA9PT0gJycpIHRocm93IG5ldyBFcnJvcigndGd6IFx1NUI4OVx1ODhDNVx1NUI4Q1x1NjIxMFx1NEY0Nlx1NjcyQVx1NjI3RVx1NTIzMCBkZXNrdG9wLWhvc3QgXHU1MTY1XHU1M0UzJyk7XHJcbiAgd3JpdGVTdGFtcCh0YXJnZXQsICd0Z3onKTtcclxuICBmaW5pc2hJbnN0YWxsKGhvc3QsIGVudHJ5LCAndGd6Jyk7XHJcbn1cclxuXHJcbi8qKiB0YXIuZXhlKFdpbjEwKyBcdTgxRUFcdTVFMjYpXHU4OUUzXHU1MzhCIHRneiBcdTUyMzAgZXhEaXIsXHU1MThEXHU2MjhBIHBhY2thZ2UvIFx1NjMyQVx1NTIzMCBub2RlX21vZHVsZXMgXHU1RTAzXHU1QzQwXHUzMDAyICovXHJcbmFzeW5jIGZ1bmN0aW9uIGV4dHJhY3RUZ3oodGd6OiBzdHJpbmcsIHN0YWdpbmc6IHN0cmluZywgcGtnOiBSZXNvbHZlZFBrZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gIGNvbnN0IGV4RGlyID0gam9pbihzdGFnaW5nLCBgeC0ke3BrZy5uYW1lLnJlcGxhY2UoL1teXFx3Li1dL2csICdfJyl9YCk7XHJcbiAgcm1TeW5jKGV4RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XHJcbiAgbWtkaXJTeW5jKGV4RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcclxuICBjb25zdCBjb2RlID0gYXdhaXQgbmV3IFByb21pc2U8bnVtYmVyPigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XHJcbiAgICBjb25zdCBjID0gc3Bhd24oJ3RhcicsIFsnLXh6ZicsIHRneiwgJy1DJywgZXhEaXJdLCB7IHdpbmRvd3NIaWRlOiB0cnVlLCBzdGRpbzogJ2lnbm9yZScgfSk7XHJcbiAgICBjLm9uKCdlcnJvcicsIHJlamVjdCk7XHJcbiAgICBjLm9uKCdleGl0JywgKHgpID0+IHJlc29sdmUoeCA/PyAxKSk7XHJcbiAgfSk7XHJcbiAgaWYgKGNvZGUgIT09IDApIHRocm93IG5ldyBFcnJvcihgdGFyIFx1ODlFM1x1NTM4QiAke3BrZy5uYW1lfSBcdTU5MzFcdThEMjUoXHU5MDAwXHU1MUZBXHU3ODAxICR7Y29kZX0pYCk7XHJcbiAgY29uc3QgZGVzdCA9IG1vZHVsZURpcihpbnN0YWxsVGFyZ2V0KCksIHBrZy5uYW1lKTtcclxuICBjb25zdCBwYXJlbnQgPSBkZXN0LnNsaWNlKDAsIGRlc3QubGFzdEluZGV4T2YoJ1xcXFwnKSk7XHJcbiAgbWtkaXJTeW5jKHBhcmVudCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XHJcbiAgcm1TeW5jKGRlc3QsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcclxuICByZW5hbWVTeW5jKGpvaW4oZXhEaXIsICdwYWNrYWdlJyksIGRlc3QpO1xyXG4gIHJtU3luYyhleERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xyXG59XHJcblxyXG4vKiogXHU1Qjg5XHU4OEM1XHU2MjMzKFx1NTQxMVx1NUJGQ1x1NUI4Q1x1NjIxMFx1OTg3NS9cdThCQkVcdTdGNkVcdTk3NjJcdTY3N0ZcdTVDNTVcdTc5M0FcdTVCODlcdTg4QzVcdTY1QjlcdTVGMEZcdTRFMEVcdTY1RjZcdTk1RjQ7XHU0RTBEXHU2MjdGXHU4RjdEXHU4RkQwXHU4ODRDXHU2NUY2XHU5MDNCXHU4RjkxKVx1MzAwMiAqL1xyXG5mdW5jdGlvbiB3cml0ZVN0YW1wKHRhcmdldDogc3RyaW5nLCB2aWE6ICducG0nIHwgJ3RneicpOiB2b2lkIHtcclxuICB0cnkge1xyXG4gICAgd3JpdGVGaWxlU3luYyhqb2luKHRhcmdldCwgJ2luc3RhbGxlZC1ieS1obWgtZGVza3RvcC5qc29uJyksIEpTT04uc3RyaW5naWZ5KHsgdmlhLCBhdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpIH0sIG51bGwsIDIpLCAndXRmOCcpO1xyXG4gIH0gY2F0Y2ggeyAvKiBiZXN0IGVmZm9ydCAqLyB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGZpbmlzaEluc3RhbGwoaG9zdDogSW5zdGFsbGVySG9zdCwgZW50cnk6IHN0cmluZywgdmlhOiAnbnBtJyB8ICd0Z3onKTogdm9pZCB7XHJcbiAgaG9zdC5sb2coYGluc3RhbGwgZG9uZSB2aWEgJHt2aWF9OiAke2VudHJ5fWApO1xyXG4gIGhvc3Quc2VuZFByb2dyZXNzKHsgcGhhc2U6ICdkb25lJywgdGV4dDogYFx1NUI4OVx1ODhDNVx1NUI4Q1x1NjIxMCgke3ZpYX0pYCwgZW50cnkgfSk7XHJcbiAgaG9zdC5vbkluc3RhbGxlZChlbnRyeSwgdmlhKTtcclxuICBydW5uaW5nID0gZmFsc2U7XHJcbn1cclxuIiwgIi8qKlxyXG4gKiBAaG1oYXJuZXNzL2NsaSBcdTVCODlcdTg4QzVcdTY4MzhcdTVGQzMoXHU3RUFGXHU5MDNCXHU4RjkxLFx1OTZGNiBJTyBcdTIwMTRcdTIwMTQgZmV0Y2gvXHU4OUUzXHU1MzhCL1x1ODQzRFx1NzZEOFx1NTcyOFx1NEUzQlx1OEZEQlx1N0EwQiBpbnN0YWxsZXIgXHU5MUNDKVx1MzAwMlxyXG4gKlxyXG4gKiBcdTgwNENcdThEMjModjUuMSBcdTVCODlcdTg4QzVcdTU0MTFcdTVCRkMpOlx1N0VEOVx1NUI5QSByZWdpc3RyeSBcdTUxNDNcdTY1NzBcdTYzNkVcdTgzQjdcdTUzRDZcdTUxRkRcdTY1NzAsXHU4OUUzXHU2NzkwIEBobWhhcm5lc3MvY2xpIFx1NzY4NFxyXG4gKiBcdTVCOENcdTY1NzRcdTRGOURcdThENTZcdTk1RURcdTUzMDUoQGhtaGFybmVzcy8qIFx1NTE2OFx1NUJCNlx1NEUzQVx1N0NCRVx1Nzg2RVx1NzI0OFx1NjcyQ1x1NEU5Mlx1OTQ4OTtcdTU5MTZcdTkwRThcdTRGOURcdThENTYgcXJjb2RlIFx1OTRGRVx1NEUzQSBeIFx1ODMwM1x1NTZGNCksXHJcbiAqIFx1NEVBN1x1NTFGQVwiXHU4OEM1XHU0RUMwXHU0RTQ4XHUzMDAxXHU0RUNFXHU1NEVBXHU0RTlCXHU5NTVDXHU1MENGXHU0RTBCXHUzMDAxXHU4OEM1XHU1MjMwXHU1NEVBXCJcdTc2ODRcdTc4NkVcdTVCOUFcdTYwMjdcdThCQTFcdTUyMTJcdTMwMDJcdThCQkVcdThCQTFcdTdFQTZcdTY3NUY6XHJcbiAqICAtIFx1OTVFRFx1NTMwNVx1NjMwOVx1NTMwNVx1NTQwRFx1NTNCQlx1OTFDRChcdTk0QkJcdTc3RjNcdTRGOURcdThENTZcdTUzRUFcdTg4QzVcdTRFMDBcdTRFRkQsbnBtIFx1OEJFRFx1NEU0OSk7XHJcbiAqICAtIFx1ODMwM1x1NTZGNFx1ODlFM1x1Njc5MFx1NTNFQVx1NjUyRlx1NjMwMSBucG0gXHU3NTFGXHU2MDAxXHU1QjlFXHU5NjQ1XHU3NTI4XHU1MjMwXHU3Njg0XHU1RjYyXHU2MDAxOlx1N0NCRVx1Nzg2RSAvIGxhdGVzdCAvICogLyBeIC8gfiAvID49LFxyXG4gKiAgICBcdTRFMERcdTVGMTUgc2VtdmVyIFx1NUU5MyhcdTk2RjZcdTRGOURcdThENTZcdTUzOUZcdTUyMTksXHU0RTBFXHU4MUVBXHU3ODE0XHU2NkY0XHU2NUIwXHU1NjY4XHU0RTAwXHU4MUY0KTtcclxuICogIC0gb3B0aW9uYWxEZXBlbmRlbmNpZXMgXHU0RTBEXHU4OEM1Olx1OTVFRFx1NTMwNVx1NTE4NVx1NUI5RVx1OTY0NVx1NThGMFx1NjYwRVx1NzY4NCBvcHRpb25hbCBcdTU3NDdcdTRFM0FcdTVFNzNcdTUzRjBcdTcyNzlcdTVCOUFcclxuICogICAgKGZzZXZlbnRzIFx1N0I0OSksdGd6IFx1OERFRlx1NUY4NFx1NEUwRFx1OEREMVx1NzUxRlx1NTQ3RFx1NTQ2OFx1NjcxRlx1ODExQVx1NjcyQyxcdTg4QzVcdTRFODZcdTRFNUZcdTUzRUFcdTY2MkZcdTZCN0JcdTkxQ0RcdTMwMDJcclxuICovXHJcbmltcG9ydCB7IGNyZWF0ZUhhc2ggfSBmcm9tICdub2RlOmNyeXB0byc7XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIFBrZ1ZlcnNpb25NZXRhIHtcclxuICB2ZXJzaW9uOiBzdHJpbmc7XHJcbiAgZGVwZW5kZW5jaWVzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xyXG4gIHRhcmJhbGw6IHN0cmluZztcclxuICBpbnRlZ3JpdHk/OiBzdHJpbmcgfCB1bmRlZmluZWQ7XHJcbn1cclxuXHJcbi8qKiByZWdpc3RyeSBwYWNrdW1lbnQgXHU3Njg0XHU2NzAwXHU1QzBGXHU4QkZCXHU1M0Q2XHU5NzYyKGRpc3QtdGFncyArIFx1NTE2OFx1NzI0OFx1NjcyQ1x1NEY5RFx1OEQ1Ni90YXJiYWxsIFx1NTE0M1x1NjU3MFx1NjM2RSlcdTMwMDIgKi9cclxuZXhwb3J0IGludGVyZmFjZSBQYWNrdW1lbnQge1xyXG4gICdkaXN0LXRhZ3MnOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xyXG4gIHZlcnNpb25zOiBSZWNvcmQ8c3RyaW5nLCB7IGRlcGVuZGVuY2llcz86IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gfCB1bmRlZmluZWQ7IGRpc3Q/OiB7IHRhcmJhbGw/OiBzdHJpbmc7IGludGVncml0eT86IHN0cmluZyB8IHVuZGVmaW5lZCB9IHwgdW5kZWZpbmVkIH0+O1xyXG59XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIFJlc29sdmVkUGtnIHtcclxuICBuYW1lOiBzdHJpbmc7XHJcbiAgdmVyc2lvbjogc3RyaW5nO1xyXG4gIC8qKiByZWdpc3RyeSBcdTUzOUZcdTU5Q0JcdTU3MzBcdTU3NDAoXHU5NTVDXHU1MENGXHU1MjE3XHU4ODY4XHU3NTMxIHRhcmJhbGxNaXJyb3JzIFx1NkQzRVx1NzUxRilcdTMwMDIgKi9cclxuICB0YXJiYWxsOiBzdHJpbmc7XHJcbiAgaW50ZWdyaXR5Pzogc3RyaW5nIHwgdW5kZWZpbmVkO1xyXG59XHJcblxyXG4vKiAtLS0tIHNlbXZlcihcdTY3MDBcdTVDMEZcdTVCOUVcdTczQjA6XHU5NUVEXHU1MzA1XHU1MTg1XHU1QjlFXHU5NjQ1XHU1MUZBXHU3M0IwXHU3Njg0XHU1RjYyXHU2MDAxKSAtLS0tICovXHJcblxyXG5leHBvcnQgZnVuY3Rpb24gY21wU2VtdmVyKGE6IHN0cmluZywgYjogc3RyaW5nKTogbnVtYmVyIHtcclxuICBjb25zdCBwYSA9IGEucmVwbGFjZSgvXnYvLCAnJykuc3BsaXQoJy0nKVswXSEuc3BsaXQoJy4nKS5tYXAoTnVtYmVyKTtcclxuICBjb25zdCBwYiA9IGIucmVwbGFjZSgvXnYvLCAnJykuc3BsaXQoJy0nKVswXSEuc3BsaXQoJy4nKS5tYXAoTnVtYmVyKTtcclxuICBmb3IgKGxldCBpID0gMDsgaSA8IDM7IGkrKykge1xyXG4gICAgY29uc3QgeCA9IHBhW2ldID8/IDA7XHJcbiAgICBjb25zdCB5ID0gcGJbaV0gPz8gMDtcclxuICAgIGlmICh4ICE9PSB5KSByZXR1cm4geCA8IHkgPyAtMSA6IDE7XHJcbiAgfVxyXG4gIHJldHVybiAwO1xyXG59XHJcblxyXG4vKiogcmFuZ2UgXHU2NjJGXHU1NDI2XHU2M0E1XHU1M0Q3IHZlcnNpb24oXHU2NTJGXHU2MzAxIFx1N0NCRVx1Nzg2RSAvIGxhdGVzdCAvICogLyB4IC8gXiAvIH4gLyA+PTtcdTRFMERcdThCQzZcdTUyMkJcdTUyMTkgZmFsc2UpXHUzMDAyICovXHJcbmV4cG9ydCBmdW5jdGlvbiBzYXRpc2ZpZXMocmFuZ2U6IHN0cmluZywgdmVyc2lvbjogc3RyaW5nKTogYm9vbGVhbiB7XHJcbiAgY29uc3QgciA9IHJhbmdlLnRyaW0oKTtcclxuICBpZiAociA9PT0gJycgfHwgciA9PT0gJyonIHx8IHIgPT09ICdsYXRlc3QnIHx8IHIgPT09ICd4JykgcmV0dXJuIHRydWU7XHJcbiAgaWYgKHIgPT09IHZlcnNpb24pIHJldHVybiB0cnVlO1xyXG4gIGNvbnN0IGJvdW5kID0gL14oXFxefH58Pj0/KVxccyooXFxkKylcXC4oXFxkKylcXC4oXFxkKykvLmV4ZWMocik7XHJcbiAgaWYgKGJvdW5kICE9PSBudWxsKSB7XHJcbiAgICBjb25zdCBvcCA9IGJvdW5kWzFdITtcclxuICAgIGNvbnN0IG1ham9yID0gTnVtYmVyKGJvdW5kWzJdKTtcclxuICAgIGNvbnN0IG1pbm9yID0gTnVtYmVyKGJvdW5kWzNdKTtcclxuICAgIGNvbnN0IHBhdGNoID0gTnVtYmVyKGJvdW5kWzRdKTtcclxuICAgIGNvbnN0IGMgPSBjbXBTZW12ZXIodmVyc2lvbiwgYCR7bWFqb3J9LiR7bWlub3J9LiR7cGF0Y2h9YCk7XHJcbiAgICBpZiAoYyA8IDApIHJldHVybiBmYWxzZTtcclxuICAgIGlmIChvcCA9PT0gJz49JykgcmV0dXJuIHRydWU7IC8vICc+PScgXHU0RTBCXHU3NTRDXHU1MzczXHU1M0VGOlx1OTVFRFx1NTMwNVx1NTE4NVx1NTNFQVx1NEVFNSAnPj14LnkueiA8eicgXHU1OTBEXHU1NDA4XHU1RjYyXHU2MDAxXHU1MUZBXHU3M0IwLFx1NEZERFx1NUI4OFx1NTNENlx1NEUwQlx1NzU0Q1xyXG4gICAgaWYgKG9wID09PSAnficpIHJldHVybiBjbXBTZW12ZXIodmVyc2lvbiwgYCR7bWFqb3J9LiR7bWlub3IgKyAxfS4wYCkgPCAwO1xyXG4gICAgLy8gJ14nOjAueCBcdTcyNzlcdTUyMjQoMC4yLjMgXHU1MTQxXHU4QkI4IDAuMi56KSxcdTUxNzZcdTRGNTlcdTk1MDFcdTRFM0JcdTcyNDhcdTY3MkNcclxuICAgIGlmIChtYWpvciA9PT0gMCkgcmV0dXJuIG1pbm9yID09PSAwID8gY21wU2VtdmVyKHZlcnNpb24sIGAwLjAuJHtwYXRjaCArIDF9YCkgPCAwIDogY21wU2VtdmVyKHZlcnNpb24sIGAwLiR7bWlub3IgKyAxfS4wYCkgPCAwO1xyXG4gICAgcmV0dXJuIGNtcFNlbXZlcih2ZXJzaW9uLCBgJHttYWpvciArIDF9LjAuMGApIDwgMDtcclxuICB9XHJcbiAgcmV0dXJuIGZhbHNlO1xyXG59XHJcblxyXG4vKiogXHU0RUNFIHBhY2t1bWVudCBcdTkwMDlcdTUxRkEgc3BlYyhcdTdDQkVcdTc4NkUvbGF0ZXN0L14vfi8qKVx1NjMwN1x1NTQxMVx1NzY4NFx1NzI0OFx1NjcyQztcdTY1RTBcdTUzMzlcdTkxNERcdThGRDRcdTU2REUgJydcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHBpY2tWZXJzaW9uKGRvYzogUGFja3VtZW50LCBzcGVjOiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gIGNvbnN0IHMgPSBzcGVjLnRyaW0oKTtcclxuICBjb25zdCB0YWcgPSBzID09PSAnJyB8fCBzID09PSAnbGF0ZXN0JyB8fCBzID09PSAnKicgPyBkb2NbJ2Rpc3QtdGFncyddPy5sYXRlc3QgOiB1bmRlZmluZWQ7XHJcbiAgaWYgKHRhZyAhPT0gdW5kZWZpbmVkICYmIGRvYy52ZXJzaW9uc1t0YWddICE9PSB1bmRlZmluZWQpIHJldHVybiB0YWc7XHJcbiAgaWYgKGRvYy52ZXJzaW9uc1tzXSAhPT0gdW5kZWZpbmVkKSByZXR1cm4gcztcclxuICBsZXQgYmVzdCA9ICcnO1xyXG4gIGZvciAoY29uc3QgdiBvZiBPYmplY3Qua2V5cyhkb2MudmVyc2lvbnMpKSB7XHJcbiAgICBpZiAoc2F0aXNmaWVzKHMsIHYpICYmIGNtcFNlbXZlcih2LCBiZXN0KSA+IDApIGJlc3QgPSB2O1xyXG4gIH1cclxuICByZXR1cm4gYmVzdDtcclxufVxyXG5cclxuLyogLS0tLSBcdTRGOURcdThENTZcdTk1RURcdTUzMDUgLS0tLSAqL1xyXG5cclxuLyoqXHJcbiAqIFx1ODlFM1x1Njc5MCByb290IFx1NTNDQVx1NTE3Nlx1NTE2OFx1OTBFOFx1NEYyMFx1OTAxMlx1NEY5RFx1OEQ1NihCRlMsXHU2MzA5XHU1MzA1XHU1NDBEXHU1M0JCXHU5MUNEXHU1M0Q2XHU5OTk2XHU0RTJBXHU4OUUzXHU2NzkwXHU3RUQzXHU2NzlDIFx1MjAxNFx1MjAxNCBcdTRFMEUgbnBtIFx1NjI0MVx1NUU3M1xyXG4gKiBcdTVFMDNcdTVDNDBcdTRFMDBcdTgxRjQpXHUzMDAyZ2V0UGFja3VtZW50IFx1NzUzMVx1OEMwM1x1NzUyOFx1NjVCOVx1NkNFOFx1NTE2NShmZXRjaCBcdTdGNTFcdTdFREMgLyBcdTZENEJcdThCRDVcdTZDRThcdTUxNjVcdTVCNTdcdTUxNzgpXHUzMDAyXHJcbiAqIFx1NEVGQlx1NEUwMFx1NEY5RFx1OEQ1Nlx1NjVFMFx1NkVFMVx1OERCM1x1NzI0OFx1NjcyQ1x1NjVGNlx1NjI5Qlx1OTUxOShcdTVFMjZcdTUzMDVcdTU0MERcdTRFMEUgcmFuZ2UsXHU5NzYyXHU1NDExXHU1Qjg5XHU4OEM1XHU5ODc1XHU5NTE5XHU4QkVGXHU2NTg3XHU2ODQ4KVx1MzAwMlxyXG4gKi9cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlc29sdmVDbG9zdXJlKFxyXG4gIHJvb3Q6IHsgbmFtZTogc3RyaW5nOyBzcGVjOiBzdHJpbmcgfSxcclxuICBnZXRQYWNrdW1lbnQ6IChuYW1lOiBzdHJpbmcpID0+IFByb21pc2U8UGFja3VtZW50PixcclxuKTogUHJvbWlzZTxSZXNvbHZlZFBrZ1tdPiB7XHJcbiAgY29uc3QgcmVzb2x2ZWQgPSBuZXcgTWFwPHN0cmluZywgUGtnVmVyc2lvbk1ldGE+KCk7XHJcbiAgY29uc3QgcXVldWU6IEFycmF5PHsgbmFtZTogc3RyaW5nOyBzcGVjOiBzdHJpbmcgfT4gPSBbcm9vdF07XHJcbiAgd2hpbGUgKHF1ZXVlLmxlbmd0aCA+IDApIHtcclxuICAgIGNvbnN0IHsgbmFtZSwgc3BlYyB9ID0gcXVldWUuc2hpZnQoKSE7XHJcbiAgICBpZiAocmVzb2x2ZWQuaGFzKG5hbWUpKSBjb250aW51ZTsgLy8gXHU1REYyXHU1QjlBXHU3MjQ4Olx1NTQwRVx1N0VFRCByYW5nZSBcdTVGMTVcdTc1MjhcdTRFMERcdTUxOERcdTkxQ0RcdTg5RTMobnBtIFx1NjI0MVx1NUU3M1x1OEJFRFx1NEU0OSlcclxuICAgIGNvbnN0IGRvYyA9IGF3YWl0IGdldFBhY2t1bWVudChuYW1lKTtcclxuICAgIGNvbnN0IHZlcnNpb24gPSBwaWNrVmVyc2lvbihkb2MsIHNwZWMpO1xyXG4gICAgY29uc3QgbWV0YSA9IHZlcnNpb24gIT09ICcnID8gZG9jLnZlcnNpb25zW3ZlcnNpb25dIDogdW5kZWZpbmVkO1xyXG4gICAgaWYgKG1ldGEgPT09IHVuZGVmaW5lZCB8fCBtZXRhLmRpc3Q/LnRhcmJhbGwgPT09IHVuZGVmaW5lZCkge1xyXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYG5vIHZlcnNpb24gb2YgJHtuYW1lfSBzYXRpc2ZpZXMgJHtzcGVjIHx8ICdsYXRlc3QnfWApO1xyXG4gICAgfVxyXG4gICAgY29uc3QgaXRlbTogUGtnVmVyc2lvbk1ldGEgPSB7XHJcbiAgICAgIHZlcnNpb24sXHJcbiAgICAgIGRlcGVuZGVuY2llczogbWV0YS5kZXBlbmRlbmNpZXMgPz8ge30sXHJcbiAgICAgIHRhcmJhbGw6IG1ldGEuZGlzdC50YXJiYWxsLFxyXG4gICAgICBpbnRlZ3JpdHk6IG1ldGEuZGlzdC5pbnRlZ3JpdHksXHJcbiAgICB9O1xyXG4gICAgcmVzb2x2ZWQuc2V0KG5hbWUsIGl0ZW0pO1xyXG4gICAgZm9yIChjb25zdCBbZGVwLCByYW5nZV0gb2YgT2JqZWN0LmVudHJpZXMoaXRlbS5kZXBlbmRlbmNpZXMpKSB7XHJcbiAgICAgIGlmICghcmVzb2x2ZWQuaGFzKGRlcCkpIHF1ZXVlLnB1c2goeyBuYW1lOiBkZXAsIHNwZWM6IHJhbmdlIH0pO1xyXG4gICAgfVxyXG4gIH1cclxuICByZXR1cm4gWy4uLnJlc29sdmVkLmVudHJpZXMoKV0ubWFwKChbbmFtZSwgbV0pID0+ICh7IG5hbWUsIHZlcnNpb246IG0udmVyc2lvbiwgdGFyYmFsbDogbS50YXJiYWxsLCBpbnRlZ3JpdHk6IG0uaW50ZWdyaXR5IH0pKTtcclxufVxyXG5cclxuLyogLS0tLSBcdTk1NUNcdTUwQ0ZcdTRFMEVcdTVFMDNcdTVDNDAgLS0tLSAqL1xyXG5cclxuY29uc3QgUkVHSVNUUllfSE9TVFMgPSAvXihodHRwcz86XFwvXFwvW14vXSspXFwvKC4qKSQvO1xyXG5cclxuLyoqXHJcbiAqIHRhcmJhbGwgXHU3Njg0XHU5NTVDXHU1MENGXHU1MDE5XHU5MDA5KFx1OTg3QVx1NUU4Rlx1NTM3M1x1NTZERVx1OTAwMFx1OTg3QVx1NUU4Rik6XHU1MzlGXHU1OUNCXHU1NzMwXHU1NzQwIFx1MjE5MiBcdTU0MDQgcmVnaXN0cnkgXHU1NDBDXHU4REVGXHU1Rjg0XHU2NTM5XHU1MTk5XHUzMDAyXHJcbiAqIHBhY2t1bWVudCBcdTkxQ0NcdTc2ODQgZGlzdC50YXJiYWxsIFx1NjA1Mlx1NjMwN1x1NTQxMVx1NTNEMVx1NUUwM1x1NkU5MChyZWdpc3RyeS5ucG1qcy5vcmcpLFx1NTZGRFx1NTE4NVx1N0Y1MVx1N0VEQ1xyXG4gKiBcdTRFMERcdTUzRUZcdThGQkVcdTY1RjZcdTYzMDkgcmVnaXN0cnkgXHU1MjE3XHU4ODY4XHU2NTM5XHU1MTk5IGhvc3QoXHU4REVGXHU1Rjg0XHU0RTBEXHU1M0Q4IFx1MjAxNFx1MjAxNCBucG1taXJyb3IgXHU0RTBFIG5wbWpzIFx1NTQwQ1x1Njc4NClcdTMwMDJcclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiB0YXJiYWxsTWlycm9ycyh0YXJiYWxsOiBzdHJpbmcsIHJlZ2lzdHJpZXM6IHN0cmluZ1tdKTogc3RyaW5nW10ge1xyXG4gIGNvbnN0IG0gPSBSRUdJU1RSWV9IT1NUUy5leGVjKHRhcmJhbGwpO1xyXG4gIGNvbnN0IHBhdGggPSBtPy5bMl0gPz8gJyc7XHJcbiAgY29uc3Qgb3V0ID0gW3RhcmJhbGxdO1xyXG4gIGZvciAoY29uc3QgcmVnIG9mIHJlZ2lzdHJpZXMpIHtcclxuICAgIGNvbnN0IGJhc2UgPSByZWcucmVwbGFjZSgvXFwvKyQvLCAnJyk7XHJcbiAgICBpZiAoYmFzZSA9PT0gbT8uWzFdKSBjb250aW51ZTtcclxuICAgIGNvbnN0IHUgPSBgJHtiYXNlfS8ke3BhdGh9YDtcclxuICAgIGlmICghb3V0LmluY2x1ZGVzKHUpKSBvdXQucHVzaCh1KTtcclxuICB9XHJcbiAgcmV0dXJuIG91dDtcclxufVxyXG5cclxuLyoqIFx1NTMwNVx1NTcyOCBub2RlX21vZHVsZXMgXHU0RTBCXHU3Njg0XHU3NkVFXHU2ODA3XHU3NkVFXHU1RjU1KHNjb3BlZCBcdTUzMDVcdTRGRERcdTYzMDEgQHNjb3BlL25hbWUgXHU0RTI0XHU3RUE3KVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gbW9kdWxlRGlyKHByZWZpeDogc3RyaW5nLCBuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gIGNvbnN0IHBhcnRzID0gbmFtZS5zcGxpdCgnLycpLmZpbHRlcigocCkgPT4gcCAhPT0gJycgJiYgcCAhPT0gJy4nKTtcclxuICBpZiAobmFtZS5zdGFydHNXaXRoKCdAJykgJiYgcGFydHMubGVuZ3RoICE9PSAyKSB0aHJvdyBuZXcgRXJyb3IoYGludmFsaWQgcGFja2FnZSBuYW1lOiAke25hbWV9YCk7XHJcbiAgaWYgKCFuYW1lLnN0YXJ0c1dpdGgoJ0AnKSAmJiBwYXJ0cy5sZW5ndGggIT09IDEpIHRocm93IG5ldyBFcnJvcihgaW52YWxpZCBwYWNrYWdlIG5hbWU6ICR7bmFtZX1gKTtcclxuICByZXR1cm4gWy4uLnBhcnRzXS5yZWR1Y2UoKGRpciwgcCkgPT4gYCR7ZGlyfVxcXFwke3B9YCwgYCR7cHJlZml4fVxcXFxub2RlX21vZHVsZXNgKTtcclxufVxyXG5cclxuLyogLS0tLSBpbnRlZ3JpdHkgLS0tLSAqL1xyXG5cclxuLyoqIG5wbSBkaXN0LmludGVncml0eSgnc2hhNTEyLWJhc2U2NCcpIFx1NjgyMVx1OUE4QztcdTRFMERcdTUzMzlcdTkxNERcdThGRDRcdTU2REUgZmFsc2UoXHU2NzJBXHU3N0U1XHU3Qjk3XHU2Q0Q1XHU4RkQ0XHU1NkRFIHRydWUgXHU2NTNFXHU4ODRDKVx1MzAwMiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gaW50ZWdyaXR5T2soZGF0YTogQnVmZmVyLCBpbnRlZ3JpdHk/OiBzdHJpbmcpOiBib29sZWFuIHtcclxuICBpZiAoaW50ZWdyaXR5ID09PSB1bmRlZmluZWQgfHwgaW50ZWdyaXR5ID09PSAnJykgcmV0dXJuIHRydWU7XHJcbiAgY29uc3QgbSA9IC9ec2hhNTEyLShbQS1aYS16MC05Ky89XSspJC8uZXhlYyhpbnRlZ3JpdHkudHJpbSgpKTtcclxuICBpZiAobSA9PT0gbnVsbCkgcmV0dXJuIHRydWU7XHJcbiAgcmV0dXJuIGNyZWF0ZUhhc2goJ3NoYTUxMicpLnVwZGF0ZShkYXRhKS5kaWdlc3QoJ2Jhc2U2NCcpID09PSBtWzFdO1xyXG59XHJcblxyXG4vKiogXHU0RUJBXHU3QzdCXHU1M0VGXHU4QkZCXHU1QjU3XHU4MjgyKFx1NUI4OVx1ODhDNVx1OEZEQlx1NUVBNlx1NjU4N1x1Njg0OFx1NzUyOClcdTMwMDIgKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGJ5dGVzTGFiZWwobjogbnVtYmVyKTogc3RyaW5nIHtcclxuICBpZiAobiA8IDEwMjQpIHJldHVybiBgJHtufSBCYDtcclxuICBpZiAobiA8IDEwMjQgKiAxMDI0KSByZXR1cm4gYCR7KG4gLyAxMDI0KS50b0ZpeGVkKDApfSBLQmA7XHJcbiAgcmV0dXJuIGAkeyhuIC8gMTAyNCAvIDEwMjQpLnRvRml4ZWQoMSl9IE1CYDtcclxufVxyXG4iXSwKICAibWFwcGluZ3MiOiAiO0FBY0EsU0FBUyxPQUFBQSxNQUFLLGVBQWUsUUFBUSxTQUFTLFNBQVMsT0FBTyxNQUFNLGNBQWMsTUFBTSxhQUFhLG1CQUFtQjtBQUN4SCxTQUFTLFFBQUFDLE9BQU0sU0FBUyxVQUFVLFlBQVksZUFBZTtBQUM3RCxTQUFTLGNBQUFDLGFBQVksZ0JBQUFDLGVBQWMsb0JBQW9CO0FBQ3ZELFNBQVMsYUFBQUMsWUFBVyxnQkFBZ0I7QUFDcEMsU0FBUyxXQUFBQyxVQUFTLHlCQUF5QjtBQUMzQyxTQUFTLGNBQWMsU0FBQUMsY0FBYTtBQUNwQyxTQUFTLGlCQUFBQyxzQkFBcUI7OztBQ1Y5QixTQUFTLGFBQWdDO0FBQ3pDLFNBQVMsdUJBQXVCO0FBQ2hDLFNBQVMsbUJBQW1COzs7QUNEckIsSUFBTSxjQUFjO0FBQUEsRUFDekI7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUNGO0FBSU8sSUFBTSx1QkFBdUI7OztBQ2xCN0IsSUFBTSxjQUFjO0FBQUEsRUFDekI7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUNGO0FBSU8sSUFBTSxtQkFBbUIsQ0FBQyxhQUFhLFVBQVUsVUFBVSxXQUFXO0FBY3RFLFNBQVMsYUFDZCxNQUNBLFNBQ0EsT0FBcUcsQ0FBQyxHQUN4RjtBQUNkLFFBQU0sSUFBa0IsRUFBRSxNQUFNLFNBQVMsV0FBVyxLQUFLLGNBQWMsS0FBSztBQUM1RSxNQUFJLEtBQUssY0FBYyxPQUFXLEdBQUUsWUFBWSxLQUFLO0FBQ3JELE1BQUksS0FBSyxVQUFVLE9BQVcsR0FBRSxRQUFRLEtBQUs7QUFDN0MsTUFBSSxLQUFLLG1CQUFtQixPQUFXLEdBQUUsaUJBQWlCLEtBQUs7QUFDL0QsU0FBTztBQUNUOzs7QUMxQkEsSUFBTSxXQUFXLENBQUMsTUFDaEIsT0FBTyxNQUFNLFlBQVksTUFBTSxRQUFRLENBQUMsTUFBTSxRQUFRLENBQUM7QUFFekQsSUFBTSxtQkFBbUIsQ0FBQyxNQUE0QixPQUFPLE1BQU0sWUFBWSxFQUFFLFNBQVM7QUFFMUYsSUFBTSxZQUFZLENBQUMsTUFBdUI7QUFDeEMsUUFBTSxJQUFJLEtBQUssTUFBTSxDQUFDO0FBQ3RCLFNBQU8sT0FBTyxTQUFTLENBQUMsS0FBSyxxQkFBcUIsS0FBSyxDQUFDO0FBQzFEO0FBRU8sU0FBUyxnQkFBZ0IsR0FBZ0M7QUFDOUQsTUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFHLFFBQU87QUFDekIsTUFBSSxFQUFFLGtCQUFrQixxQkFBc0IsUUFBTztBQUNyRCxNQUFJLENBQUMsaUJBQWlCLEVBQUUsT0FBTyxFQUFHLFFBQU87QUFDekMsTUFBSSxDQUFDLGlCQUFpQixFQUFFLFNBQVMsRUFBRyxRQUFPO0FBQzNDLE1BQUksQ0FBQyxpQkFBaUIsRUFBRSxLQUFLLEVBQUcsUUFBTztBQUN2QyxNQUFJLE9BQU8sRUFBRSxRQUFRLFlBQVksQ0FBQyxPQUFPLFVBQVUsRUFBRSxHQUFHLEtBQUssRUFBRSxNQUFNLEVBQUcsUUFBTztBQUMvRSxNQUFJLENBQUMsaUJBQWlCLEVBQUUsVUFBVSxLQUFLLENBQUMsVUFBVSxFQUFFLFVBQVUsRUFBRyxRQUFPO0FBQ3hFLE1BQUksQ0FBQyxZQUFZLFNBQVMsRUFBRSxJQUFpQixFQUFHLFFBQU87QUFDdkQsU0FBTyxTQUFTLEVBQUUsT0FBTztBQUMzQjtBQUVPLFNBQVMsZUFBZSxHQUErQjtBQUM1RCxNQUFJLENBQUMsU0FBUyxDQUFDLEVBQUcsUUFBTztBQUN6QixNQUFJLENBQUMsWUFBWSxTQUFTLEVBQUUsSUFBYSxFQUFHLFFBQU87QUFDbkQsTUFBSSxPQUFPLEVBQUUsWUFBWSxTQUFVLFFBQU87QUFDMUMsTUFBSSxPQUFPLEVBQUUsY0FBYyxVQUFXLFFBQU87QUFDN0MsTUFBSSxFQUFFLGNBQWMsVUFBYSxDQUFDLGlCQUFpQixFQUFFLFNBQVMsRUFBRyxRQUFPO0FBQ3hFLE1BQUksRUFBRSxVQUFVLFVBQWEsQ0FBQyxpQkFBaUIsRUFBRSxLQUFLLEVBQUcsUUFBTztBQUNoRSxNQUFJLEVBQUUsbUJBQW1CLFVBQWEsQ0FBQyxpQkFBaUIsU0FBUyxFQUFFLGNBQXVCLEVBQUcsUUFBTztBQUNwRyxTQUFPO0FBQ1Q7QUFPTyxTQUFTLGdCQUFnQixHQUErRTtBQUM3RyxNQUFJLENBQUMsU0FBUyxDQUFDLEVBQUcsUUFBTztBQUN6QixNQUFJLEVBQUUsd0JBQXdCLEtBQU0sUUFBTztBQUMzQyxNQUFJLE9BQU8sRUFBRSxTQUFTLFlBQVksQ0FBQyxPQUFPLFVBQVUsRUFBRSxJQUFJLEtBQUssRUFBRSxRQUFRLEtBQUssRUFBRSxPQUFPLE1BQU8sUUFBTztBQUNyRyxTQUFPLGlCQUFpQixFQUFFLE9BQU87QUFDbkM7OztBSEhBLElBQU0sMkJBQTJCO0FBQ2pDLElBQU0sdUJBQXVCO0FBQzdCLElBQU0sc0JBQXNCO0FBRXJCLElBQU0sMkJBQU4sTUFBK0I7QUFBQSxFQVVwQyxZQUNtQixNQUNqQixPQUEwQixDQUFDLEdBQzNCO0FBRmlCO0FBR2pCLFNBQUssUUFBUSxLQUFLLFNBQVMsWUFBWSxFQUFFLEVBQUUsU0FBUyxXQUFXO0FBQy9ELFNBQUssT0FBTztBQUFBLE1BQ1YsYUFBYSxLQUFLLGVBQWU7QUFBQSxNQUNqQyxnQkFBZ0IsS0FBSyxrQkFBa0I7QUFBQSxNQUN2QyxvQkFBb0IsS0FBSyxzQkFBc0I7QUFBQSxNQUMvQyxHQUFHO0FBQUEsSUFDTDtBQUFBLEVBQ0Y7QUFBQSxFQVZtQjtBQUFBLEVBVlgsUUFBNkI7QUFBQSxFQUM3QixTQUFvQjtBQUFBLEVBQ3BCLGVBQWU7QUFBQSxFQUNmLFlBQVk7QUFBQSxFQUNaLFdBQVc7QUFBQSxFQUNGO0FBQUEsRUFDQTtBQUFBLEVBQ1QsY0FBaUMsQ0FBQztBQUFBLEVBZTFDLElBQUksUUFBbUI7QUFDckIsV0FBTyxLQUFLO0FBQUEsRUFDZDtBQUFBLEVBRUEsSUFBSSxlQUF1QjtBQUN6QixXQUFPLEtBQUs7QUFBQSxFQUNkO0FBQUEsRUFFUSxTQUFTLEdBQWMsS0FBb0I7QUFDakQsU0FBSyxTQUFTO0FBQ2QsUUFBSSxRQUFRLE9BQVcsTUFBSyxZQUFZO0FBQ3hDLFVBQU0sT0FBcUQsRUFBRSxjQUFjLEtBQUssYUFBYTtBQUM3RixRQUFJLEtBQUssY0FBYyxHQUFJLE1BQUssWUFBWSxLQUFLO0FBQ2pELFNBQUssS0FBSyxnQkFBZ0IsR0FBRyxJQUFJO0FBQUEsRUFDbkM7QUFBQTtBQUFBLEVBR0EsTUFBTSxRQUErQjtBQUNuQyxRQUFJLEtBQUssV0FBVyxXQUFXLEtBQUssV0FBVyxZQUFZO0FBQ3pELFlBQU0sYUFBYSxrQkFBa0Isc0JBQXNCLEtBQUssTUFBTSxFQUFFO0FBQUEsSUFDMUU7QUFDQSxTQUFLLGVBQWU7QUFDcEIsU0FBSyxXQUFXO0FBQ2hCLFdBQU8sS0FBSyxPQUFPO0FBQUEsRUFDckI7QUFBQSxFQUVBLE1BQWMsU0FBZ0M7QUFDNUMsU0FBSyxTQUFTLFVBQVU7QUFDeEIsVUFBTSxRQUFRLE1BQU0sS0FBSyxLQUFLLFNBQVMsS0FBSyxLQUFLLE1BQU07QUFBQSxNQUNyRCxLQUFLLEtBQUssS0FBSztBQUFBLE1BQ2YsS0FBSztBQUFBLFFBQ0gsR0FBRyxRQUFRO0FBQUEsUUFDWCxHQUFHLEtBQUssS0FBSztBQUFBLFFBQ2IsbUJBQW1CLEtBQUs7QUFBQSxNQUMxQjtBQUFBLE1BQ0EsT0FBTyxDQUFDLFVBQVUsUUFBUSxNQUFNO0FBQUEsTUFDaEMsYUFBYTtBQUFBLElBQ2YsQ0FBQztBQUNELFNBQUssUUFBUTtBQUViLFFBQUk7QUFDRixZQUFNLFdBQVcsTUFBTSxLQUFLLFdBQVcsS0FBSztBQUM1QyxXQUFLLGtCQUFrQixFQUFFLE1BQU0sU0FBUyxNQUFNLFNBQVMsU0FBUyxRQUFRO0FBQ3hFLFdBQUssU0FBUyxPQUFPO0FBQ3JCLFdBQUssS0FBSyxVQUFVLFFBQVE7QUFFNUIsWUFBTSxLQUFLLFFBQVEsTUFBTTtBQUN2QixhQUFLLFlBQVksUUFBUSxDQUFDLE1BQU0sRUFBRSxDQUFDO0FBQ25DLGFBQUssY0FBYyxDQUFDO0FBQ3BCLGFBQUssaUJBQWlCO0FBQUEsTUFDeEIsQ0FBQztBQUNELGFBQU87QUFBQSxJQUNULFNBQVMsS0FBSztBQUNaLFVBQUksQ0FBQyxNQUFNLE9BQVEsT0FBTSxLQUFLO0FBQzlCLFVBQUksS0FBSyxVQUFVLE1BQU8sTUFBSyxRQUFRO0FBQ3ZDLFlBQU07QUFBQSxJQUNSO0FBQUEsRUFDRjtBQUFBO0FBQUEsRUFHUSxXQUFXLE9BQTRDO0FBQzdELFdBQU8sSUFBSSxRQUFzQixDQUFDQyxVQUFTLFdBQVc7QUFDcEQsWUFBTSxRQUFRLFdBQVcsTUFBTTtBQUM3QixlQUFPLGFBQWEsa0JBQWtCLG9DQUFvQyxLQUFLLEtBQUssY0FBYyxNQUFNLEVBQUUsV0FBVyxNQUFNLGdCQUFnQixZQUFZLENBQUMsQ0FBQztBQUFBLE1BQzNKLEdBQUcsS0FBSyxLQUFLLGNBQWM7QUFFM0IsWUFBTSxPQUFPLENBQUMsT0FBeUI7QUFDckMscUJBQWEsS0FBSztBQUNsQixXQUFHO0FBQUEsTUFDTDtBQUVBLFVBQUksQ0FBQyxNQUFNLFFBQVE7QUFDakIsYUFBSyxNQUFNLE9BQU8sYUFBYSxtQkFBbUIsa0NBQWtDLENBQUMsQ0FBQztBQUN0RjtBQUFBLE1BQ0Y7QUFFQSxZQUFNLEtBQUssZ0JBQWdCLEVBQUUsT0FBTyxNQUFNLE9BQU8sQ0FBQztBQUNsRCxZQUFNLFNBQVMsQ0FBQyxTQUF1QjtBQUNyQyxZQUFJO0FBQ0osWUFBSTtBQUNGLG1CQUFTLEtBQUssTUFBTSxJQUFJO0FBQUEsUUFDMUIsUUFBUTtBQUNOO0FBQUEsUUFDRjtBQUNBLFlBQUksZ0JBQWdCLE1BQU0sR0FBRztBQUMzQixhQUFHLE1BQU07QUFDVCxlQUFLLEtBQUssaUJBQWlCLE9BQU8sTUFBTSxPQUFPLE9BQU8sRUFDbkQsS0FBSyxDQUFDLGFBQWEsS0FBSyxNQUFNQSxTQUFRLFFBQVEsQ0FBQyxDQUFDLEVBQ2hELE1BQU0sQ0FBQyxRQUFpQixLQUFLLE1BQU0sT0FBTyxHQUFHLENBQUMsQ0FBQztBQUFBLFFBQ3BEO0FBQUEsTUFDRjtBQUNBLFNBQUcsR0FBRyxRQUFRLE1BQU07QUFFcEIsWUFBTSxLQUFLLFFBQVEsQ0FBQyxTQUFTO0FBQzNCLGFBQUssTUFBTSxPQUFPLGFBQWEsbUJBQW1CLG9DQUFvQyxRQUFRLE1BQU0sS0FBSyxFQUFFLFdBQVcsT0FBTyxnQkFBZ0IsWUFBWSxDQUFDLENBQUMsQ0FBQztBQUFBLE1BQzlKLENBQUM7QUFBQSxJQUNILENBQUM7QUFBQSxFQUNIO0FBQUE7QUFBQSxFQUdBLE1BQWMsTUFBTSxNQUFjLFNBQXdDO0FBQ3hFLFFBQUk7QUFDSixRQUFJO0FBQ0YsWUFBTSxNQUFNLE1BQU0sb0JBQW9CLElBQUksY0FBYztBQUFBLFFBQ3RELFNBQVMsRUFBRSxhQUFhLEtBQUssTUFBTTtBQUFBLFFBQ25DLFFBQVEsWUFBWSxRQUFRLEdBQUs7QUFBQSxNQUNuQyxDQUFDO0FBQUEsSUFDSCxTQUFTLEtBQUs7QUFDWixZQUFNLGFBQWEsa0JBQWtCLHdCQUF3QixPQUFPLEdBQUcsRUFBRSxNQUFNLEdBQUcsR0FBRyxDQUFDLElBQUksRUFBRSxXQUFXLEtBQUssQ0FBQztBQUFBLElBQy9HO0FBQ0EsUUFBSSxJQUFJLFdBQVcsT0FBTyxJQUFJLFdBQVcsS0FBSztBQUM1QyxZQUFNLGFBQWEsZUFBZSx5Q0FBeUMsSUFBSSxNQUFNLEtBQUssRUFBRSxXQUFXLE9BQU8sZ0JBQWdCLFlBQVksQ0FBQztBQUFBLElBQzdJO0FBQ0EsUUFBSSxDQUFDLElBQUksSUFBSTtBQUNYLFlBQU0sYUFBYSxrQkFBa0IscUJBQXFCLElBQUksTUFBTSxJQUFJLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFBQSxJQUM3RjtBQUNBLFdBQU8sRUFBRSxNQUFNLFNBQVMsT0FBTyxLQUFLLE1BQU07QUFBQSxFQUM1QztBQUFBLEVBRVEsbUJBQXlCO0FBQy9CLFFBQUksS0FBSyxZQUFZLEtBQUssV0FBVyxhQUFhLEtBQUssV0FBVyxXQUFZO0FBQzlFLFNBQUssUUFBUTtBQUNiLFFBQUksS0FBSyxlQUFlLEtBQUssS0FBSyxhQUFhO0FBQzdDLFdBQUssZ0JBQWdCO0FBQ3JCLFdBQUssU0FBUyxZQUFZO0FBQzFCLFdBQUssS0FBSyxPQUFPLEVBQUUsTUFBTSxNQUFNO0FBRTdCLGFBQUssWUFBWTtBQUFBLE1BQ25CLENBQUM7QUFBQSxJQUNILE9BQU87QUFDTCxXQUFLLFNBQVMsVUFBVSw0QkFBNEIsS0FBSyxlQUFlLENBQUMsbUJBQW1CO0FBQUEsSUFDOUY7QUFBQSxFQUNGO0FBQUEsRUFFUSxjQUFvQjtBQUMxQixRQUFJLEtBQUssWUFBWSxLQUFLLFdBQVcsYUFBYSxLQUFLLFdBQVcsV0FBWTtBQUM5RSxRQUFJLEtBQUssZUFBZSxLQUFLLEtBQUssYUFBYTtBQUM3QyxXQUFLLGdCQUFnQjtBQUNyQixXQUFLLFNBQVMsWUFBWTtBQUMxQixXQUFLLEtBQUssT0FBTyxFQUFFLE1BQU0sTUFBTSxLQUFLLFlBQVksQ0FBQztBQUFBLElBQ25ELE9BQU87QUFDTCxXQUFLLFNBQVMsVUFBVSxnQ0FBZ0MsS0FBSyxZQUFZLG1CQUFtQjtBQUFBLElBQzlGO0FBQUEsRUFDRjtBQUFBO0FBQUEsRUFHQSxNQUFNLE9BQXNCO0FBQzFCLFNBQUssV0FBVztBQUNoQixRQUFJLEtBQUssV0FBVyxVQUFXO0FBQy9CLFNBQUssU0FBUyxVQUFVO0FBQ3hCLFVBQU0sUUFBUSxLQUFLO0FBQ25CLFNBQUssUUFBUTtBQUNiLFNBQUssa0JBQWtCO0FBQ3ZCLFFBQUksQ0FBQyxPQUFPO0FBQ1YsV0FBSyxTQUFTLFNBQVM7QUFDdkI7QUFBQSxJQUNGO0FBQ0EsVUFBTSxTQUFTLElBQUksUUFBYyxDQUFDQSxhQUFZO0FBQzVDLFVBQUksTUFBTSxhQUFhLFFBQVEsTUFBTSxlQUFlLEtBQU0sQ0FBQUEsU0FBUTtBQUFBLFdBQzdEO0FBQ0gsY0FBTSxJQUFJLE1BQVlBLFNBQVE7QUFDOUIsYUFBSyxZQUFZLEtBQUssQ0FBQztBQUN2QixjQUFNLEtBQUssUUFBUSxDQUFDO0FBQUEsTUFDdEI7QUFBQSxJQUNGLENBQUM7QUFFRCxRQUFJLEtBQUssaUJBQWlCLE1BQU07QUFDOUIsVUFBSTtBQUNGLGNBQU0sTUFBTSxvQkFBb0IsS0FBSyxZQUFZLHlCQUF5QjtBQUFBLFVBQ3hFLFFBQVE7QUFBQSxVQUNSLFNBQVMsRUFBRSxhQUFhLEtBQUssTUFBTTtBQUFBLFVBQ25DLFFBQVEsWUFBWSxRQUFRLEdBQUs7QUFBQSxRQUNuQyxDQUFDO0FBQUEsTUFDSCxRQUFRO0FBQUEsTUFFUjtBQUFBLElBQ0Y7QUFDQSxVQUFNLFdBQVcsTUFBTSxRQUFRLEtBQUs7QUFBQSxNQUNsQyxPQUFPLEtBQUssTUFBTSxJQUFJO0FBQUEsTUFDdEIsSUFBSSxRQUFpQixDQUFDQSxhQUFZLFdBQVcsTUFBTUEsU0FBUSxLQUFLLEdBQUcsS0FBSyxLQUFLLGtCQUFrQixDQUFDO0FBQUEsSUFDbEcsQ0FBQztBQUNELFFBQUksQ0FBQyxZQUFZLE1BQU0sYUFBYSxRQUFRLE1BQU0sZUFBZSxNQUFNO0FBQ3JFLFlBQU0sS0FBSztBQUFBLElBQ2I7QUFDQSxVQUFNLE9BQU8sTUFBTSxNQUFNLE1BQVM7QUFDbEMsU0FBSyxTQUFTLFNBQVM7QUFBQSxFQUN6QjtBQUFBLEVBRVEsZUFBOEI7QUFBQSxFQUM5QixrQkFBNEQ7QUFBQTtBQUFBLEVBR3BFLElBQUksV0FBcUQ7QUFDdkQsV0FBTyxLQUFLO0FBQUEsRUFDZDtBQUFBO0FBQUEsRUFHQSxNQUFjLGlCQUFpQixNQUFjLFNBQXdDO0FBQ25GLFVBQU0sS0FBSyxNQUFNLEtBQUssTUFBTSxNQUFNLE9BQU87QUFDekMsU0FBSyxlQUFlLEdBQUc7QUFDdkIsV0FBTztBQUFBLEVBQ1Q7QUFDRjs7O0FJclJBLFNBQVMsa0JBQWtCO0FBU3BCLFNBQVMsY0FBYyxPQUEyQjtBQUN2RCxRQUFNLFNBQXFCLENBQUM7QUFDNUIsYUFBVyxTQUFTLE1BQU0sTUFBTSxNQUFNLEdBQUc7QUFDdkMsUUFBSSxDQUFDLE1BQU0sS0FBSyxFQUFHO0FBQ25CLFFBQUk7QUFDSixRQUFJLFFBQVE7QUFDWixVQUFNLFlBQXNCLENBQUM7QUFDN0IsUUFBSSxXQUFXO0FBQ2YsZUFBVyxRQUFRLE1BQU0sTUFBTSxJQUFJLEdBQUc7QUFDcEMsVUFBSSxLQUFLLFdBQVcsR0FBRyxFQUFHO0FBQzFCLFVBQUksS0FBSyxXQUFXLEtBQUssR0FBRztBQUFFLGFBQUssS0FBSyxNQUFNLENBQUMsRUFBRSxLQUFLO0FBQUcsbUJBQVc7QUFBQSxNQUFNLFdBQ2pFLEtBQUssV0FBVyxRQUFRLEdBQUc7QUFBRSxnQkFBUSxLQUFLLE1BQU0sQ0FBQyxFQUFFLEtBQUs7QUFBRyxtQkFBVztBQUFBLE1BQU0sV0FDNUUsS0FBSyxXQUFXLE9BQU8sR0FBRztBQUFFLGtCQUFVLEtBQUssS0FBSyxNQUFNLENBQUMsRUFBRSxRQUFRLE1BQU0sRUFBRSxDQUFDO0FBQUcsbUJBQVc7QUFBQSxNQUFNO0FBQUEsSUFDekc7QUFDQSxRQUFJLENBQUMsU0FBVTtBQUNmLFdBQU8sS0FBSyxFQUFFLEdBQUksT0FBTyxTQUFZLEVBQUUsR0FBRyxJQUFJLENBQUMsR0FBSSxPQUFPLE1BQU0sVUFBVSxLQUFLLElBQUksRUFBRSxDQUFDO0FBQUEsRUFDeEY7QUFDQSxTQUFPO0FBQ1Q7QUFHTyxTQUFTLGtCQUFrQixPQUF1QztBQUN2RSxNQUFJLE1BQU0sVUFBVSxNQUFPLFFBQU87QUFDbEMsTUFBSTtBQUNGLFVBQU0sU0FBa0IsS0FBSyxNQUFNLE1BQU0sSUFBSTtBQUM3QyxXQUFPLGdCQUFnQixNQUFNLElBQUksU0FBUztBQUFBLEVBQzVDLFFBQVE7QUFDTixXQUFPO0FBQUEsRUFDVDtBQUNGO0FBRU8sSUFBTSxtQkFBTixjQUErQixNQUFNO0FBQUEsRUFDMUMsWUFBNEIsUUFBc0I7QUFDaEQsVUFBTSxPQUFPLE9BQU87QUFETTtBQUFBLEVBRTVCO0FBQUEsRUFGNEI7QUFHOUI7QUFFTyxJQUFNLG9CQUFOLE1BQXdCO0FBQUEsRUFDN0IsWUFDbUIsU0FDQSxPQUNqQjtBQUZpQjtBQUNBO0FBQUEsRUFDaEI7QUFBQSxFQUZnQjtBQUFBLEVBQ0E7QUFBQSxFQUdYLFFBQVEsUUFBZ0MsQ0FBQyxHQUEyQjtBQUMxRSxXQUFPLEVBQUUsYUFBYSxLQUFLLE9BQU8sR0FBRyxNQUFNO0FBQUEsRUFDN0M7QUFBQSxFQUVBLE1BQU0sUUFBVyxNQUFjLFlBQVksS0FBbUI7QUFDNUQsUUFBSTtBQUNKLFFBQUk7QUFDRixZQUFNLE1BQU0sTUFBTSxHQUFHLEtBQUssT0FBTyxHQUFHLElBQUksSUFBSSxFQUFFLFNBQVMsS0FBSyxRQUFRLEdBQUcsUUFBUSxZQUFZLFFBQVEsU0FBUyxFQUFFLENBQUM7QUFBQSxJQUNqSCxTQUFTLEtBQUs7QUFDWixZQUFNLElBQUksaUJBQWlCLGFBQWEsa0JBQWtCLG1CQUFtQixPQUFPLEdBQUcsRUFBRSxNQUFNLEdBQUcsR0FBRyxDQUFDLElBQUksRUFBRSxXQUFXLE1BQU0sZ0JBQWdCLFlBQVksQ0FBQyxDQUFDO0FBQUEsSUFDN0o7QUFDQSxXQUFPLEtBQUssY0FBaUIsR0FBRztBQUFBLEVBQ2xDO0FBQUE7QUFBQSxFQUdBLE1BQU0sUUFBUSxNQUFjLFlBQVksS0FBeUI7QUFDL0QsUUFBSTtBQUNKLFFBQUk7QUFDRixZQUFNLE1BQU0sTUFBTSxHQUFHLEtBQUssT0FBTyxHQUFHLElBQUksSUFBSSxFQUFFLFNBQVMsS0FBSyxRQUFRLEdBQUcsUUFBUSxZQUFZLFFBQVEsU0FBUyxFQUFFLENBQUM7QUFBQSxJQUNqSCxTQUFTLEtBQUs7QUFDWixZQUFNLElBQUksaUJBQWlCLGFBQWEsa0JBQWtCLG1CQUFtQixPQUFPLEdBQUcsRUFBRSxNQUFNLEdBQUcsR0FBRyxDQUFDLElBQUksRUFBRSxXQUFXLE1BQU0sZ0JBQWdCLFlBQVksQ0FBQyxDQUFDO0FBQUEsSUFDN0o7QUFDQSxRQUFJLElBQUksV0FBVyxPQUFPLElBQUksV0FBVyxLQUFLO0FBQzVDLFlBQU0sSUFBSSxpQkFBaUIsYUFBYSxlQUFlLHlDQUF5QyxJQUFJLE1BQU0sS0FBSyxFQUFFLFdBQVcsT0FBTyxnQkFBZ0IsWUFBWSxDQUFDLENBQUM7QUFBQSxJQUNuSztBQUNBLFFBQUksQ0FBQyxJQUFJLElBQUk7QUFDWCxZQUFNLElBQUksaUJBQWlCLGFBQWEsa0JBQWtCLFFBQVEsSUFBSSxNQUFNLElBQUksRUFBRSxXQUFXLElBQUksVUFBVSxJQUFJLENBQUMsQ0FBQztBQUFBLElBQ25IO0FBQ0EsV0FBTyxJQUFJLEtBQUs7QUFBQSxFQUNsQjtBQUFBO0FBQUE7QUFBQSxFQUlBLE1BQU0sU0FBWSxNQUFjLE1BQWUsWUFBWSxLQUFvQjtBQUM3RSxRQUFJO0FBQ0osUUFBSTtBQUNGLFlBQU0sTUFBTSxNQUFNLEdBQUcsS0FBSyxPQUFPLEdBQUcsSUFBSSxJQUFJO0FBQUEsUUFDMUMsUUFBUTtBQUFBLFFBQ1IsU0FBUyxLQUFLLFFBQVE7QUFBQSxVQUNwQixnQkFBZ0I7QUFBQSxVQUNoQixxQkFBcUIsV0FBVztBQUFBLFFBQ2xDLENBQUM7QUFBQSxRQUNELE1BQU0sS0FBSyxVQUFVLElBQUk7QUFBQSxRQUN6QixRQUFRLFlBQVksUUFBUSxTQUFTO0FBQUEsTUFDdkMsQ0FBQztBQUFBLElBQ0gsU0FBUyxLQUFLO0FBQ1osWUFBTSxJQUFJLGlCQUFpQixhQUFhLGtCQUFrQixtQkFBbUIsT0FBTyxHQUFHLEVBQUUsTUFBTSxHQUFHLEdBQUcsQ0FBQyxJQUFJLEVBQUUsV0FBVyxNQUFNLGdCQUFnQixZQUFZLENBQUMsQ0FBQztBQUFBLElBQzdKO0FBQ0EsV0FBTyxLQUFLLGNBQWlCLEdBQUc7QUFBQSxFQUNsQztBQUFBLEVBRUEsTUFBYyxjQUFpQixLQUEyQjtBQUN4RCxRQUFJLElBQUksV0FBVyxPQUFPLElBQUksV0FBVyxLQUFLO0FBQzVDLFlBQU0sSUFBSSxpQkFBaUIsYUFBYSxlQUFlLHlDQUF5QyxJQUFJLE1BQU0sS0FBSyxFQUFFLFdBQVcsT0FBTyxnQkFBZ0IsWUFBWSxDQUFDLENBQUM7QUFBQSxJQUNuSztBQUNBLFVBQU0sT0FBTyxNQUFNLElBQUksS0FBSztBQUM1QixRQUFJLFNBQWtCO0FBQ3RCLFFBQUk7QUFDRixlQUFTLE9BQU8sS0FBSyxNQUFNLElBQUksSUFBSTtBQUFBLElBQ3JDLFFBQVE7QUFDTixlQUFTO0FBQUEsSUFDWDtBQUNBLFFBQUksQ0FBQyxJQUFJLElBQUk7QUFDWCxVQUFJLGVBQWUsTUFBTSxFQUFHLE9BQU0sSUFBSSxpQkFBaUIsTUFBTTtBQUM3RCxZQUFNLElBQUksaUJBQWlCLGFBQWEsa0JBQWtCLFFBQVEsSUFBSSxNQUFNLEtBQUssS0FBSyxNQUFNLEdBQUcsR0FBRyxDQUFDLElBQUksRUFBRSxXQUFXLElBQUksVUFBVSxJQUFJLENBQUMsQ0FBQztBQUFBLElBQzFJO0FBQ0EsV0FBTztBQUFBLEVBQ1Q7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLEVBTUEsT0FBTyxVQUFVLGFBQXNCLFFBQWdEO0FBQ3JGLFVBQU0sTUFBTSxNQUFNLE1BQU0sR0FBRyxLQUFLLE9BQU8sZUFBZTtBQUFBLE1BQ3BELFNBQVMsS0FBSyxRQUFRO0FBQUEsUUFDcEIsUUFBUTtBQUFBLFFBQ1IsR0FBSSxnQkFBZ0IsU0FBWSxFQUFFLGlCQUFpQixZQUFZLElBQUksQ0FBQztBQUFBLE1BQ3RFLENBQUM7QUFBQSxNQUNELEdBQUksV0FBVyxTQUFZLEVBQUUsT0FBTyxJQUFJLENBQUM7QUFBQSxJQUMzQyxDQUFDO0FBQ0QsUUFBSSxJQUFJLFdBQVcsT0FBTyxJQUFJLFdBQVcsS0FBSztBQUM1QyxZQUFNLElBQUksaUJBQWlCLGFBQWEsZUFBZSx5Q0FBeUMsSUFBSSxNQUFNLEtBQUssRUFBRSxXQUFXLE9BQU8sZ0JBQWdCLFlBQVksQ0FBQyxDQUFDO0FBQUEsSUFDbks7QUFDQSxRQUFJLENBQUMsSUFBSSxNQUFNLElBQUksU0FBUyxNQUFNO0FBQ2hDLFlBQU0sSUFBSSxpQkFBaUIsYUFBYSxrQkFBa0IsWUFBWSxJQUFJLE1BQU0sSUFBSSxFQUFFLFdBQVcsTUFBTSxnQkFBZ0IsWUFBWSxDQUFDLENBQUM7QUFBQSxJQUN2STtBQUNBLFVBQU0sU0FBUyxJQUFJLEtBQUssVUFBVTtBQUNsQyxVQUFNLFVBQVUsSUFBSSxZQUFZO0FBQ2hDLFFBQUksU0FBUztBQUNiLGVBQVM7QUFDUCxZQUFNLEVBQUUsTUFBTSxNQUFNLElBQUksTUFBTSxPQUFPLEtBQUs7QUFDMUMsVUFBSSxLQUFNO0FBQ1YsZ0JBQVUsUUFBUSxPQUFPLE9BQU8sRUFBRSxRQUFRLEtBQUssQ0FBQztBQUNoRCxVQUFJO0FBQ0osY0FBUSxNQUFNLE9BQU8sUUFBUSxNQUFNLE9BQU8sSUFBSTtBQUM1QyxjQUFNLFFBQVEsT0FBTyxNQUFNLEdBQUcsR0FBRztBQUNqQyxpQkFBUyxPQUFPLE1BQU0sTUFBTSxDQUFDO0FBQzdCLG1CQUFXLFNBQVMsY0FBYyxLQUFLLEVBQUcsT0FBTTtBQUFBLE1BQ2xEO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLEVBTUEsT0FBTyxPQUFPLGFBQXNCLFFBQXFEO0FBQ3ZGLFVBQU0sTUFBTSxNQUFNLE1BQU0sR0FBRyxLQUFLLE9BQU8sZUFBZTtBQUFBLE1BQ3BELFNBQVMsS0FBSyxRQUFRO0FBQUEsUUFDcEIsUUFBUTtBQUFBLFFBQ1IsR0FBSSxnQkFBZ0IsU0FBWSxFQUFFLGlCQUFpQixZQUFZLElBQUksQ0FBQztBQUFBLE1BQ3RFLENBQUM7QUFBQSxNQUNELEdBQUksV0FBVyxTQUFZLEVBQUUsT0FBTyxJQUFJLENBQUM7QUFBQSxJQUMzQyxDQUFDO0FBQ0QsUUFBSSxJQUFJLFdBQVcsT0FBTyxJQUFJLFdBQVcsS0FBSztBQUM1QyxZQUFNLElBQUksaUJBQWlCLGFBQWEsZUFBZSx5Q0FBeUMsSUFBSSxNQUFNLEtBQUssRUFBRSxXQUFXLE9BQU8sZ0JBQWdCLFlBQVksQ0FBQyxDQUFDO0FBQUEsSUFDbks7QUFDQSxRQUFJLENBQUMsSUFBSSxNQUFNLENBQUMsSUFBSSxNQUFNO0FBQ3hCLFlBQU0sSUFBSSxpQkFBaUIsYUFBYSxrQkFBa0IsWUFBWSxJQUFJLE1BQU0sSUFBSSxFQUFFLFdBQVcsTUFBTSxnQkFBZ0IsWUFBWSxDQUFDLENBQUM7QUFBQSxJQUN2STtBQUNBLFVBQU0sU0FBUyxJQUFJLEtBQUssVUFBVTtBQUNsQyxVQUFNLFVBQVUsSUFBSSxZQUFZO0FBQ2hDLFFBQUksU0FBUztBQUNiLGVBQVM7QUFDUCxZQUFNLEVBQUUsTUFBTSxNQUFNLElBQUksTUFBTSxPQUFPLEtBQUs7QUFDMUMsVUFBSSxLQUFNO0FBQ1YsZ0JBQVUsUUFBUSxPQUFPLE9BQU8sRUFBRSxRQUFRLEtBQUssQ0FBQztBQUVoRCxVQUFJO0FBQ0osY0FBUSxNQUFNLE9BQU8sUUFBUSxNQUFNLE9BQU8sSUFBSTtBQUM1QyxjQUFNLFFBQVEsT0FBTyxNQUFNLEdBQUcsR0FBRztBQUNqQyxpQkFBUyxPQUFPLE1BQU0sTUFBTSxDQUFDO0FBQzdCLG1CQUFXLFNBQVMsY0FBYyxLQUFLLEdBQUc7QUFDeEMsZ0JBQU0sTUFBTSxrQkFBa0IsS0FBSztBQUNuQyxjQUFJLFFBQVEsS0FBTSxPQUFNO0FBQUEsUUFDMUI7QUFBQSxNQUNGO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFDRjs7O0FDakxBLFNBQVMsb0JBQXlDO0FBQ2xELFNBQVMsY0FBQUMsbUJBQWtCO0FBQzNCLFNBQVMscUJBQXFCO0FBQzlCLFNBQVMsb0JBQW9CO0FBcUI3QixlQUFzQixjQUFjLE1BQW1FO0FBQ3JHLFFBQU0sUUFBUSxLQUFLO0FBR25CLFFBQU0sV0FBVyxRQUFRLElBQUksMEJBQTBCO0FBQ3ZELFFBQU0sWUFBWSxPQUFPLFFBQVEsSUFBSSwyQkFBMkIsRUFBRTtBQUNsRSxRQUFNLFlBQVksUUFBUSxJQUFJLHdCQUF3QjtBQUV0RCxRQUFNLGFBQWEsb0JBQUksSUFBb0I7QUFDM0MsUUFBTSxXQUFXLG9CQUFJLElBQW9CO0FBRXpDLFFBQU0sT0FBNEQsQ0FBQztBQUNuRSxNQUFJLFVBQVU7QUFDZCxRQUFNLFdBQVcsb0JBQUksSUFBeUI7QUFDOUMsTUFBSSxVQUFrQztBQUN0QyxRQUFNLFlBQVksb0JBQUksSUFBNEI7QUFFbEQsUUFBTSxpQkFBaUI7QUFBQSxJQUNyQixTQUFTO0FBQUEsSUFDVCxPQUFPO0FBQUEsTUFDTCxFQUFFLElBQUksV0FBVyxNQUFNLGtCQUFrQixNQUFNLFdBQVc7QUFBQSxJQUM1RDtBQUFBLEVBQ0Y7QUFDQSxRQUFNLGdCQUFnQixvQkFBSSxJQUFnRTtBQUFBLElBQ3hGLENBQUMsUUFBUSxFQUFFLFNBQVMseUJBQXlCLE9BQU8sVUFBVSxRQUFRLGVBQWUsQ0FBQztBQUFBLElBQ3RGLENBQUMsZUFBZSxFQUFFLFNBQVMseUJBQXlCLE9BQU8saUJBQWlCLFFBQVEsZUFBZSxDQUFDO0FBQUEsRUFDdEcsQ0FBQztBQUNELE1BQUksbUJBQW1CO0FBRXZCLFFBQU0sT0FBTyxDQUFDLFdBQW1CLE9BQWUsTUFBaUIsWUFBNkM7QUFDNUcsVUFBTSxNQUFNLEdBQUcsU0FBUyxLQUFLLEtBQUs7QUFDbEMsVUFBTSxPQUFPLFNBQVMsSUFBSSxHQUFHLEtBQUssS0FBSztBQUN2QyxhQUFTLElBQUksS0FBSyxHQUFHO0FBQ3JCLFVBQU0sTUFBcUI7QUFBQSxNQUN6QixlQUFlO0FBQUEsTUFDZixTQUFTQyxZQUFXO0FBQUEsTUFDcEI7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0EsYUFBWSxvQkFBSSxLQUFLLEdBQUUsWUFBWTtBQUFBLE1BQ25DO0FBQUEsTUFDQTtBQUFBLElBQ0Y7QUFDQSxVQUFNLEtBQUssRUFBRTtBQUNiLFNBQUssS0FBSyxFQUFFLElBQUksT0FBTyxPQUFPLE1BQU0sSUFBSSxDQUFDO0FBQ3pDLFFBQUksS0FBSyxTQUFTLElBQUssTUFBSyxPQUFPLEdBQUcsS0FBSyxTQUFTLEdBQUc7QUFDdkQsZUFBVyxLQUFLLFlBQVk7QUFDMUIsUUFBRSxNQUFNLE9BQU8sRUFBRTtBQUFBO0FBQUEsUUFBdUIsS0FBSyxVQUFVLEdBQUcsQ0FBQztBQUFBO0FBQUEsQ0FBTTtBQUFBLElBQ25FO0FBQ0EsV0FBTztBQUFBLEVBQ1Q7QUFFQSxRQUFNLFFBQVEsQ0FBQyxjQUFtQztBQUNoRCxRQUFJLElBQUksU0FBUyxJQUFJLFNBQVM7QUFDOUIsUUFBSSxNQUFNLFFBQVc7QUFDbkIsVUFBSSxFQUFFLElBQUksV0FBVyxZQUFXLG9CQUFJLEtBQUssR0FBRSxZQUFZLEdBQUcsWUFBVyxvQkFBSSxLQUFLLEdBQUUsWUFBWSxFQUFFO0FBQzlGLGVBQVMsSUFBSSxXQUFXLENBQUM7QUFBQSxJQUMzQjtBQUNBLE1BQUUsYUFBWSxvQkFBSSxLQUFLLEdBQUUsWUFBWTtBQUNyQyxXQUFPO0FBQUEsRUFDVDtBQUdBLFFBQU0sVUFBVSxDQUFDLFdBQW1CLE1BQWMsU0FBeUI7QUFDekUsVUFBTSxRQUFRLE9BQU8sS0FBSyxJQUFJLEVBQUUsU0FBUyxFQUFFLENBQUMsSUFBSSxLQUFLLE9BQU8sRUFBRSxTQUFTLEVBQUUsRUFBRSxNQUFNLEdBQUcsQ0FBQyxDQUFDO0FBQ3RGLFVBQU0sU0FBUztBQUNmLFVBQU0sUUFBMkIsQ0FBQztBQUNsQyxVQUFNLE9BQU8sQ0FBQyxJQUFnQixLQUFLLGNBQW9CO0FBQ3JELFlBQU0sSUFBSSxXQUFXLElBQUksRUFBRTtBQUMzQixnQkFBVSxJQUFJLEdBQUcsU0FBUyxLQUFLLEtBQUssSUFBSSxDQUFDO0FBQUEsSUFDM0M7QUFDQSxVQUFNLFFBQVEsQ0FBQyxRQUFpQztBQUM5QyxZQUFNLENBQUMsT0FBTyxHQUFHLElBQUksSUFBSTtBQUN6QixVQUFJLFVBQVUsT0FBVztBQUN6QixXQUFLLE1BQU07QUFDVCxjQUFNO0FBQ04sY0FBTSxJQUFJO0FBQUEsTUFDWixDQUFDO0FBQUEsSUFDSDtBQUVBLFNBQUssV0FBVyxPQUFPLGVBQWUsRUFBRSxNQUFNLE1BQU0sS0FBSyxDQUFDO0FBQzFELFFBQUksV0FBVztBQUNiLFdBQUssTUFBTSxLQUFLLFdBQVcsT0FBTyxjQUFjO0FBQUEsUUFDOUMsT0FBTyxFQUFFLE1BQU0sZUFBZSxTQUFTLG1DQUFtQyxXQUFXLE1BQU07QUFBQSxNQUM3RixDQUFDLENBQUM7QUFDRixhQUFPO0FBQUEsSUFDVDtBQUVBLFVBQU0sWUFBWSxDQUFDLFFBQWdCLGFBQTJCO0FBQzVELGdCQUFVLE9BQU8sR0FBRyxTQUFTLEtBQUssS0FBSyxFQUFFO0FBRXpDLFdBQUssV0FBVyxPQUFPLG9CQUFvQjtBQUFBLFFBQ3pDLFVBQVUsRUFBRSxTQUFTLFdBQVcsTUFBTSxRQUFRLE9BQU8sVUFBVTtBQUFBLE1BQ2pFLENBQUM7QUFDRCxXQUFLLFdBQVcsT0FBTyxpQkFBaUIsRUFBRSxNQUFNLFFBQVEsT0FBTyxHQUFHLFNBQVMsQ0FBQztBQUFBLElBQzlFO0FBRUEsVUFBTSxXQUE4QjtBQUFBLE1BQ2xDLE1BQU0sS0FBSyxXQUFXLE9BQU8sZ0JBQWdCLEVBQUUsTUFBTSxhQUFhLGFBQWEsdUJBQXVCLENBQUM7QUFBQSxNQUN2RyxNQUFNLEtBQUssV0FBVyxPQUFPLGtCQUFrQixFQUFFLE1BQU0sYUFBYSxTQUFTLE9BQU8sZUFBZSxTQUFTLENBQUM7QUFBQSxJQUMvRztBQUVBLFFBQUksU0FBUyxPQUFPO0FBQ2xCLGVBQVMsS0FBSyxNQUFNO0FBQ2xCLGNBQU0sYUFBYSxNQUFNLEtBQUssT0FBTyxFQUFFLFNBQVMsRUFBRSxFQUFFLE1BQU0sR0FBRyxDQUFDLENBQUM7QUFDL0QsYUFBSyxXQUFXLE9BQU8scUJBQXFCO0FBQUEsVUFDMUM7QUFBQSxVQUNBLE1BQU07QUFBQSxVQUNOLGFBQWE7QUFBQSxVQUNiLE1BQU07QUFBQSxRQUNSLENBQUM7QUFDRCxrQkFBVTtBQUFBLFVBQ1I7QUFBQSxVQUNBO0FBQUEsVUFDQSxTQUFTLENBQUMsWUFBWTtBQUNwQixzQkFBVTtBQUNWLGdCQUFJLFNBQVM7QUFDWCxtQkFBSyxXQUFXLE9BQU8sZ0JBQWdCLEVBQUUsTUFBTSxjQUFjLGFBQWEscUJBQXFCLENBQUM7QUFDaEcsbUJBQUssTUFBTSxLQUFLLFdBQVcsT0FBTyxrQkFBa0IsRUFBRSxNQUFNLGNBQWMsU0FBUyxPQUFPLGVBQWUsZ0JBQWdCLENBQUMsQ0FBQztBQUMzSCxtQkFBSyxNQUFNLFVBQVUsU0FBUyxJQUFJLG9DQUFXLENBQUMsR0FBRyxZQUFZLENBQUM7QUFBQSxZQUNoRSxPQUFPO0FBQ0wsd0JBQVUsU0FBUyxJQUFJLG1FQUFpQixDQUFDO0FBQUEsWUFDM0M7QUFBQSxVQUNGO0FBQUEsUUFDRjtBQUFBLE1BQ0YsQ0FBQztBQUFBLElBQ0gsT0FBTztBQUNMLGVBQVMsS0FBSyxNQUFNLFVBQVUsU0FBUyxJQUFJLElBQUksQ0FBQyxDQUFDO0FBQUEsSUFDbkQ7QUFDQSxVQUFNLFFBQVE7QUFDZCxXQUFPO0FBQUEsRUFDVDtBQUVBLFFBQU0sU0FBUyxhQUFhLENBQUMsS0FBSyxRQUFRO0FBQ3hDLFVBQU0sTUFBTSxJQUFJLElBQUksSUFBSSxPQUFPLEtBQUssa0JBQWtCO0FBQ3RELFVBQU0sYUFBYSxJQUFJLFFBQVEsV0FBVyxNQUFNO0FBQ2hELFVBQU0sT0FBTyxNQUFZO0FBQ3ZCLFVBQUksVUFBVSxLQUFLLEVBQUUsZ0JBQWdCLGtDQUFrQyxDQUFDO0FBQ3hFLFVBQUksSUFBSSxLQUFLLFVBQVUsYUFBYSxlQUFlLGdDQUFnQyxFQUFFLFdBQVcsTUFBTSxDQUFDLENBQUMsQ0FBQztBQUFBLElBQzNHO0FBRUEsVUFBTSxXQUFXLE1BQ2YsSUFBSSxRQUFRLENBQUNDLGFBQVk7QUFDdkIsVUFBSSxJQUFJO0FBQ1IsVUFBSSxHQUFHLFFBQVEsQ0FBQyxNQUFjO0FBQUUsYUFBSyxFQUFFLFNBQVM7QUFBQSxNQUFHLENBQUM7QUFDcEQsVUFBSSxHQUFHLE9BQU8sTUFBTUEsU0FBUSxDQUFDLENBQUM7QUFBQSxJQUNoQyxDQUFDO0FBRUgsUUFBSSxJQUFJLGFBQWEsZUFBZTtBQUNsQyxVQUFJLENBQUMsWUFBWTtBQUFFLGFBQUs7QUFBRztBQUFBLE1BQVE7QUFDbkMsVUFBSSxVQUFVLEtBQUssRUFBRSxnQkFBZ0IscUJBQXFCLGlCQUFpQixZQUFZLFlBQVksYUFBYSxDQUFDO0FBQ2pILFVBQUksZUFBZTtBQUNuQixpQkFBVyxJQUFJLEdBQUc7QUFFbEIsWUFBTSxTQUFTLE9BQU8sSUFBSSxRQUFRLGVBQWUsS0FBSyxDQUFDO0FBQ3ZELFVBQUksT0FBTyxTQUFTLE1BQU0sS0FBSyxTQUFTLEdBQUc7QUFDekMsbUJBQVcsS0FBSyxNQUFNO0FBQ3BCLGNBQUksRUFBRSxLQUFLLE9BQVEsS0FBSSxNQUFNLE9BQU8sRUFBRSxFQUFFO0FBQUEsU0FBWSxFQUFFLEtBQUs7QUFBQSxRQUFXLEtBQUssVUFBVSxFQUFFLElBQUksQ0FBQztBQUFBO0FBQUEsQ0FBTTtBQUFBLFFBQ3BHO0FBQUEsTUFDRjtBQUNBLFVBQUksR0FBRyxTQUFTLE1BQU0sV0FBVyxPQUFPLEdBQUcsQ0FBQztBQUM1QztBQUFBLElBQ0Y7QUFDQSxRQUFJLENBQUMsWUFBWTtBQUFFLFdBQUs7QUFBRztBQUFBLElBQVE7QUFFbkMsUUFBSSxJQUFJLFdBQVcsU0FBUyxJQUFJLGFBQWEsY0FBYztBQUV6RCxVQUFJLFVBQVUsS0FBSyxFQUFFLGdCQUFnQixrQ0FBa0MsQ0FBQztBQUN4RSxVQUFJLElBQUksS0FBSyxVQUFVO0FBQUEsUUFDckIsZUFBZTtBQUFBLFFBQWMsU0FBUztBQUFBLFFBQU0sT0FBTyxjQUFjLElBQUksZ0JBQWdCLEdBQUcsU0FBUztBQUFBLFFBQ2pHLGNBQWM7QUFBQSxRQUFrQixRQUFRO0FBQUEsUUFDeEMsY0FBYyxDQUFDLEdBQUcsU0FBUyxLQUFLLENBQUMsRUFBRSxNQUFNLEdBQUcsQ0FBQztBQUFBLFFBQzdDLGlCQUFpQixZQUFZO0FBQUEsUUFDN0IsVUFBVSxFQUFFLFVBQVUsTUFBTTtBQUFBLFFBQzVCLFdBQVcsZUFBZSxNQUFNLEtBQUssQ0FBQyxNQUFNLEVBQUUsT0FBTyxlQUFlLE9BQU8sS0FBSztBQUFBLFFBQ2hGLGlCQUFpQixDQUFDLEdBQUcsY0FBYyxRQUFRLENBQUMsRUFBRSxJQUFJLENBQUMsQ0FBQyxNQUFNLENBQUMsT0FBTztBQUFBLFVBQ2hFO0FBQUEsVUFBTSxPQUFPLEVBQUU7QUFBQSxVQUFPLFNBQVMsRUFBRTtBQUFBLFVBQ2pDLFFBQVEsRUFBRSxXQUFXO0FBQUEsVUFDckIsU0FBUyxFQUFFLE9BQU8sVUFBVSxJQUFJLEVBQUUsT0FBTyxNQUFNLEVBQUUsSUFBSTtBQUFBLFVBQ3JELFVBQVUsQ0FBQyxNQUFNO0FBQUEsUUFDbkIsRUFBRTtBQUFBLE1BQ0osQ0FBQyxDQUFDO0FBQ0Y7QUFBQSxJQUNGO0FBQ0EsUUFBSSxJQUFJLFdBQVcsVUFBVSxJQUFJLGFBQWEseUJBQXlCO0FBQ3JFLFVBQUksVUFBVSxLQUFLLEVBQUUsZ0JBQWdCLGtDQUFrQyxDQUFDO0FBQ3hFLFVBQUksSUFBSSxLQUFLLFVBQVUsRUFBRSxJQUFJLEtBQUssQ0FBQyxDQUFDO0FBQ3BDLGFBQU8sTUFBTSxNQUFNLFFBQVEsS0FBSyxDQUFDLENBQUM7QUFDbEMsaUJBQVcsTUFBTSxRQUFRLEtBQUssQ0FBQyxHQUFHLEdBQUssRUFBRSxNQUFNO0FBQy9DO0FBQUEsSUFDRjtBQUNBLFFBQUksSUFBSSxXQUFXLFVBQVUsSUFBSSxhQUFhLGlCQUFpQjtBQUU3RCxVQUFJLFVBQVUsS0FBSyxFQUFFLGdCQUFnQixrQ0FBa0MsQ0FBQztBQUN4RSxVQUFJLElBQUksS0FBSyxVQUFVLEVBQUUsSUFBSSxLQUFLLENBQUMsQ0FBQztBQUNwQyxpQkFBVyxNQUFNLFFBQVEsS0FBSyxDQUFDLEdBQUcsRUFBRTtBQUNwQztBQUFBLElBQ0Y7QUFDQSxRQUFJLElBQUksV0FBVyxVQUFVLElBQUksYUFBYSxjQUFjO0FBRTFELFlBQU0sWUFBWTtBQUNoQixjQUFNLE9BQU8sS0FBSyxNQUFPLE1BQU0sU0FBUyxLQUFNLElBQUk7QUFDbEQsY0FBTSxPQUFPLE9BQU8sS0FBSyxTQUFTLFdBQVcsS0FBSyxLQUFLLEtBQUssSUFBSTtBQUNoRSxZQUFJLENBQUMsY0FBYyxJQUFJLElBQUksR0FBRztBQUM1QixjQUFJLFVBQVUsS0FBSyxFQUFFLGdCQUFnQixrQ0FBa0MsQ0FBQztBQUN4RSxjQUFJLElBQUksS0FBSyxVQUFVLGFBQWEsbUJBQW1CLHNCQUFzQixFQUFFLFdBQVcsTUFBTSxDQUFDLENBQUMsQ0FBQztBQUNuRztBQUFBLFFBQ0Y7QUFDQSwyQkFBbUI7QUFDbkIsWUFBSSxVQUFVLEtBQUssRUFBRSxnQkFBZ0Isa0NBQWtDLENBQUM7QUFDeEUsWUFBSSxJQUFJLEtBQUssVUFBVSxFQUFFLElBQUksTUFBTSxPQUFPLGNBQWMsSUFBSSxJQUFJLEdBQUcsTUFBTSxDQUFDLENBQUM7QUFBQSxNQUM3RSxHQUFHO0FBQ0g7QUFBQSxJQUNGO0FBQ0EsUUFBSSxJQUFJLFdBQVcsVUFBVSxJQUFJLGFBQWEsYUFBYTtBQUN6RCxZQUFNLFlBQVk7QUFDaEIsWUFBSTtBQUNGLGdCQUFNLE9BQU8sS0FBSyxNQUFPLE1BQU0sU0FBUyxLQUFNLElBQUk7QUFDbEQsZ0JBQU0sT0FBTyxPQUFPLEtBQUssU0FBUyxXQUFXLEtBQUssT0FBTztBQUN6RCxnQkFBTSxZQUFZLE9BQU8sS0FBSyxjQUFjLFdBQVcsS0FBSyxZQUFZLE9BQU8sS0FBSyxJQUFJLEVBQUUsU0FBUyxFQUFFLENBQUM7QUFDdEcsZ0JBQU0sT0FBTyxLQUFLLFNBQVMsU0FBUyxLQUFLLFNBQVMsVUFBVSxLQUFLLFNBQVMsU0FBUyxLQUFLLE9BQU87QUFDL0YsZ0JBQU0sY0FBYyxNQUFNLFFBQVEsS0FBSyxXQUFXLElBQUksS0FBSyxZQUFZLE9BQU8sQ0FBQyxNQUFtQixPQUFPLE1BQU0sUUFBUSxJQUFJLENBQUM7QUFFNUgsZ0JBQU0sU0FBUyxNQUFNLFFBQVEsS0FBSyxNQUFNLElBQ3BDLEtBQUssT0FBTyxPQUFPLENBQUMsT0FBZ0Q7QUFDbEUsZ0JBQUksT0FBTyxPQUFPLFlBQVksT0FBTyxLQUFNLFFBQU87QUFDbEQsa0JBQU0sSUFBSTtBQUNWLG1CQUFPLE9BQU8sRUFBRSxTQUFTLFlBQVksT0FBTyxFQUFFLFlBQVksWUFBWSxFQUFFLFFBQVEsV0FBVyxhQUFhO0FBQUEsVUFDMUcsQ0FBQyxJQUNELENBQUM7QUFDTCxjQUFJLENBQUMsTUFBTTtBQUNULGdCQUFJLFVBQVUsS0FBSyxFQUFFLGdCQUFnQixrQ0FBa0MsQ0FBQztBQUN4RSxnQkFBSSxJQUFJLEtBQUssVUFBVSxhQUFhLG1CQUFtQixpQkFBaUIsRUFBRSxXQUFXLE1BQU0sQ0FBQyxDQUFDLENBQUM7QUFDOUY7QUFBQSxVQUNGO0FBR0EsZ0JBQU0sV0FBVyxZQUFZLFNBQVMsSUFDbEM7QUFBQSxFQUF1QixZQUFZLElBQUksQ0FBQyxNQUFNLEtBQUssRUFBRSxNQUFNLE9BQU8sRUFBRSxJQUFJLENBQUMsRUFBRSxFQUFFLEtBQUssSUFBSSxDQUFDO0FBQUE7QUFBQSxFQUFPLElBQUksS0FDbEc7QUFDSixnQkFBTSxhQUFhLE9BQU8sU0FBUyxJQUFJLFlBQVksT0FBTyxNQUFNO0FBQUEsRUFBTSxRQUFRLEtBQUs7QUFDbkYsZ0JBQU0sUUFBUSxRQUFRLFdBQVcsWUFBWSxJQUFJO0FBQ2pELGNBQUksVUFBVSxLQUFLLEVBQUUsZ0JBQWdCLGtDQUFrQyxDQUFDO0FBQ3hFLGNBQUksSUFBSSxLQUFLLFVBQVUsRUFBRSxJQUFJLE1BQU0sT0FBTyxRQUFRLE9BQU8sT0FBTyxDQUFDLENBQUM7QUFBQSxRQUNwRSxTQUFTLEtBQUs7QUFDWixjQUFJLFVBQVUsS0FBSyxFQUFFLGdCQUFnQixrQ0FBa0MsQ0FBQztBQUN4RSxjQUFJLElBQUksS0FBSyxVQUFVLGFBQWEsbUJBQW1CLE9BQU8sR0FBRyxFQUFFLE1BQU0sR0FBRyxHQUFHLEdBQUcsRUFBRSxXQUFXLE1BQU0sQ0FBQyxDQUFDLENBQUM7QUFBQSxRQUMxRztBQUFBLE1BQ0YsR0FBRztBQUNIO0FBQUEsSUFDRjtBQUNBLFFBQUksSUFBSSxXQUFXLFVBQVUsSUFBSSxhQUFhLGdCQUFnQjtBQUM1RCxZQUFNLFlBQVk7QUFDaEIsY0FBTSxPQUFPLEtBQUssTUFBTyxNQUFNLFNBQVMsS0FBTSxJQUFJO0FBQ2xELGNBQU0sTUFBTSxPQUFPLEtBQUssY0FBYyxXQUFXLEtBQUssWUFBWTtBQUNsRSxZQUFJLFlBQVksUUFBUyxRQUFRLE1BQU0sUUFBUSxjQUFjLEtBQU07QUFDakUsY0FBSSxVQUFVLEtBQUssRUFBRSxnQkFBZ0Isa0NBQWtDLENBQUM7QUFDeEUsY0FBSSxJQUFJLEtBQUssVUFBVSxhQUFhLG1CQUFtQix1QkFBdUIsRUFBRSxXQUFXLE1BQU0sQ0FBQyxDQUFDLENBQUM7QUFDcEc7QUFBQSxRQUNGO0FBQ0EsY0FBTSxJQUFJO0FBQ1Ysa0JBQVU7QUFDVixVQUFFLFFBQVEsS0FBSyxZQUFZLElBQUk7QUFDL0IsWUFBSSxVQUFVLEtBQUssRUFBRSxnQkFBZ0Isa0NBQWtDLENBQUM7QUFDeEUsWUFBSSxJQUFJLEtBQUssVUFBVSxFQUFFLElBQUksTUFBTSxTQUFTLEtBQUssWUFBWSxLQUFLLENBQUMsQ0FBQztBQUFBLE1BQ3RFLEdBQUc7QUFDSDtBQUFBLElBQ0Y7QUFDQSxRQUFJLElBQUksV0FBVyxVQUFVLElBQUksU0FBUyxXQUFXLGdCQUFnQixNQUFNLElBQUksU0FBUyxTQUFTLFVBQVUsS0FBSyxJQUFJLFNBQVMsU0FBUyxTQUFTLElBQUk7QUFFakosWUFBTSxZQUFZO0FBQ2hCLGNBQU0sUUFBUSxJQUFJLFNBQVMsTUFBTSxpQkFBaUIsTUFBTSxFQUFFLE1BQU0sR0FBRztBQUNuRSxjQUFNLEtBQUssTUFBTSxDQUFDLEtBQUs7QUFDdkIsY0FBTSxNQUFNLG1CQUFtQixNQUFNLENBQUMsS0FBSyxFQUFFLEVBQUUsUUFBUSxzQkFBc0IsRUFBRTtBQUMvRSxZQUFJLFFBQVEsTUFBTyxPQUFPLGFBQWEsT0FBTyxVQUFXO0FBQ3ZELGNBQUksVUFBVSxLQUFLLEVBQUUsZ0JBQWdCLGtDQUFrQyxDQUFDO0FBQ3hFLGNBQUksSUFBSSxLQUFLLFVBQVUsYUFBYSxtQkFBbUIsVUFBVSxFQUFFLFdBQVcsTUFBTSxDQUFDLENBQUMsQ0FBQztBQUN2RjtBQUFBLFFBQ0Y7QUFDQSxZQUFJLENBQUMsU0FBUyxJQUFJLEdBQUcsR0FBRztBQUN0QixjQUFJLFVBQVUsS0FBSyxFQUFFLGdCQUFnQixrQ0FBa0MsQ0FBQztBQUN4RSxjQUFJLElBQUksS0FBSyxVQUFVLGFBQWEsbUJBQW1CLHFCQUFxQixFQUFFLFdBQVcsTUFBTSxDQUFDLENBQUMsQ0FBQztBQUNsRztBQUFBLFFBQ0Y7QUFDQSxpQkFBUyxPQUFPLEdBQUc7QUFDbkIsWUFBSSxVQUFVLEtBQUssRUFBRSxnQkFBZ0Isa0NBQWtDLENBQUM7QUFDeEUsWUFBSSxJQUFJLEtBQUssVUFBVSxFQUFFLElBQUksS0FBSyxDQUFDLENBQUM7QUFBQSxNQUN0QyxHQUFHO0FBQ0g7QUFBQSxJQUNGO0FBQ0EsUUFBSSxJQUFJLFdBQVcsVUFBVSxJQUFJLGFBQWEsZUFBZTtBQUUzRCxXQUFLLFNBQVM7QUFDZCxVQUFJLFVBQVUsS0FBSyxFQUFFLGdCQUFnQixrQ0FBa0MsQ0FBQztBQUN4RSxVQUFJLElBQUksS0FBSyxVQUFVLEVBQUUsSUFBSSxLQUFLLENBQUMsQ0FBQztBQUNwQztBQUFBLElBQ0Y7QUFDQSxRQUFJLElBQUksV0FBVyxVQUFVLElBQUksYUFBYSxrQkFBa0I7QUFDOUQsWUFBTSxPQUFPLEtBQUssTUFBTSxFQUFFO0FBQzFCLFdBQUs7QUFDTCxVQUFJLFVBQVUsS0FBSyxFQUFFLGdCQUFnQixrQ0FBa0MsQ0FBQztBQUN4RSxVQUFJLElBQUksS0FBSyxVQUFVLEVBQUUsSUFBSSxLQUFLLENBQUMsQ0FBQztBQUNwQztBQUFBLElBQ0Y7QUFDQSxRQUFJLElBQUksV0FBVyxTQUFTLElBQUksYUFBYSxpQkFBaUI7QUFDNUQsWUFBTSxPQUFPLENBQUMsR0FBRyxTQUFTLE9BQU8sQ0FBQyxFQUFFLElBQUksQ0FBQyxPQUFPO0FBQUEsUUFDOUMsSUFBSSxFQUFFO0FBQUEsUUFBSSxPQUFPO0FBQUEsUUFBSSxNQUFNO0FBQUEsUUFBSSxTQUFTO0FBQUEsUUFBTSxPQUFPO0FBQUEsUUFBRyxVQUFVO0FBQUEsUUFDbEUsTUFBTSxFQUFFO0FBQUEsUUFBVyxLQUFLO0FBQUEsUUFBWSxRQUFRO0FBQUEsUUFBSSxXQUFXLEVBQUU7QUFBQSxRQUFXLFdBQVcsRUFBRTtBQUFBLE1BQ3ZGLEVBQUU7QUFDRixVQUFJLFVBQVUsS0FBSyxFQUFFLGdCQUFnQixrQ0FBa0MsQ0FBQztBQUN4RSxVQUFJLElBQUksS0FBSyxVQUFVLEVBQUUsVUFBVSxNQUFNLFlBQVksS0FBSyxDQUFDLENBQUM7QUFDNUQ7QUFBQSxJQUNGO0FBQ0EsUUFBSSxJQUFJLFdBQVcsU0FBUyxJQUFJLFNBQVMsV0FBVyxnQkFBZ0IsR0FBRztBQUNyRSxZQUFNLE1BQU0sbUJBQW1CLElBQUksU0FBUyxNQUFNLGlCQUFpQixNQUFNLENBQUM7QUFFMUUsWUFBTSxjQUFjLHFCQUFxQixLQUFLLEdBQUcsS0FBSyxxQkFBcUIsS0FBSyxHQUFHO0FBQ25GLFVBQUksZ0JBQWdCLFFBQVEsWUFBWSxDQUFDLE1BQU0sVUFBYSxZQUFZLENBQUMsTUFBTSxJQUFJO0FBQ2pGLGNBQU0sTUFBTSxZQUFZLENBQUMsRUFBRSxRQUFRLHNCQUFzQixFQUFFO0FBQzNELGNBQU0sS0FBSyxTQUFTLElBQUksR0FBRztBQUMzQixZQUFJLE9BQU8sUUFBVztBQUNwQixjQUFJLFVBQVUsS0FBSyxFQUFFLGdCQUFnQixrQ0FBa0MsQ0FBQztBQUN4RSxjQUFJLElBQUksS0FBSyxVQUFVLGFBQWEsbUJBQW1CLHFCQUFxQixFQUFFLFdBQVcsTUFBTSxDQUFDLENBQUMsQ0FBQztBQUNsRztBQUFBLFFBQ0Y7QUFDQSxZQUFJLFVBQVUsS0FBSyxFQUFFLGdCQUFnQiwrQkFBK0IsQ0FBQztBQUNyRSxZQUFJLElBQUk7QUFBQTtBQUFBLGlCQUFrQyxHQUFHO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLENBQTREO0FBQ3pHO0FBQUEsTUFDRjtBQUVBLFlBQU0sS0FBSyxJQUFJLFFBQVEsc0JBQXNCLEVBQUU7QUFDL0MsWUFBTSxJQUFJLFNBQVMsSUFBSSxFQUFFO0FBQ3pCLFVBQUksTUFBTSxRQUFXO0FBQ25CLFlBQUksVUFBVSxLQUFLLEVBQUUsZ0JBQWdCLGtDQUFrQyxDQUFDO0FBQ3hFLFlBQUksSUFBSSxLQUFLLFVBQVUsYUFBYSxtQkFBbUIscUJBQXFCLEVBQUUsV0FBVyxNQUFNLENBQUMsQ0FBQyxDQUFDO0FBQ2xHO0FBQUEsTUFDRjtBQUNBLFVBQUksVUFBVSxLQUFLLEVBQUUsZ0JBQWdCLGtDQUFrQyxDQUFDO0FBQ3hFLFVBQUksSUFBSSxLQUFLLFVBQVU7QUFBQSxRQUNyQjtBQUFBLFFBQUksT0FBTztBQUFBLFFBQWMsS0FBSztBQUFBLFFBQzlCLFVBQVU7QUFBQSxVQUNSLEVBQUUsTUFBTSxRQUFRLE1BQU0scURBQWtCLE9BQU8sQ0FBQyxFQUFFO0FBQUEsVUFDbEQsRUFBRSxNQUFNLGFBQWEsTUFBTSxrRkFBc0IsT0FBTyxDQUFDLFdBQVcsRUFBRTtBQUFBLFFBQ3hFO0FBQUEsTUFDRixDQUFDLENBQUM7QUFDRjtBQUFBLElBQ0Y7QUFDQSxRQUFJLElBQUksV0FBVyxTQUFTLElBQUksYUFBYSxXQUFXO0FBRXRELFlBQU0sSUFBSSxJQUFJLGFBQWEsSUFBSSxNQUFNLEtBQUs7QUFDMUMsWUFBTSxZQUFZLElBQUksYUFBYSxJQUFJLE9BQU8sTUFBTTtBQUNwRCxVQUFJLE1BQU0sSUFBSTtBQUNaLFlBQUksVUFBVSxLQUFLLEVBQUUsZ0JBQWdCLGtDQUFrQyxDQUFDO0FBQ3hFLFlBQUksSUFBSSxLQUFLLFVBQVU7QUFBQSxVQUNyQixNQUFNO0FBQUEsVUFBSSxVQUFVLENBQUM7QUFBQSxVQUFHLFFBQVE7QUFBQSxVQUNoQyxNQUFNLENBQUMsRUFBRSxNQUFNLGtCQUFrQixNQUFNLFdBQVcsQ0FBQztBQUFBLFVBQ25ELEdBQUksWUFBWSxFQUFFLE9BQU8sQ0FBQyxFQUFFLElBQUksQ0FBQztBQUFBLFFBQ25DLENBQUMsQ0FBQztBQUNGO0FBQUEsTUFDRjtBQUNBLFVBQUksVUFBVSxLQUFLLEVBQUUsZ0JBQWdCLGtDQUFrQyxDQUFDO0FBQ3hFLFVBQUksSUFBSSxLQUFLLFVBQVU7QUFBQSxRQUNyQixNQUFNO0FBQUEsUUFBRyxVQUFVLENBQUMsRUFBRSxNQUFNLEVBQUUsTUFBTSxPQUFPLEVBQUUsT0FBTyxPQUFPLEVBQUUsSUFBSSxLQUFLLEdBQUcsTUFBTSxFQUFFLENBQUM7QUFBQSxRQUFHLFFBQVE7QUFBQSxRQUM3RixNQUFNLENBQUMsRUFBRSxNQUFNLE9BQU8sTUFBTSxHQUFHLEVBQUUsUUFBUSxVQUFVLEVBQUUsQ0FBQyxRQUFRLENBQUM7QUFBQSxRQUMvRCxHQUFJLFlBQVksRUFBRSxPQUFPO0FBQUEsVUFDdkIsRUFBRSxNQUFNLGFBQWEsTUFBTSxHQUFHLEVBQUUsUUFBUSxVQUFVLEVBQUUsQ0FBQyxlQUFlLEtBQUssWUFBWTtBQUFBLFVBQ3JGLEVBQUUsTUFBTSxnQkFBZ0IsTUFBTSxHQUFHLEVBQUUsUUFBUSxVQUFVLEVBQUUsQ0FBQyxrQkFBa0IsS0FBSyxlQUFlO0FBQUEsUUFDaEcsRUFBRSxJQUFJLENBQUM7QUFBQSxNQUNULENBQUMsQ0FBQztBQUNGO0FBQUEsSUFDRjtBQUNBLFFBQUksSUFBSSxXQUFXLFNBQVMsSUFBSSxhQUFhLGdCQUFnQjtBQUUzRCxZQUFNLElBQUksSUFBSSxhQUFhLElBQUksTUFBTSxLQUFLO0FBQzFDLFVBQUksTUFBTSxJQUFJO0FBQ1osWUFBSSxVQUFVLEtBQUssRUFBRSxnQkFBZ0Isa0NBQWtDLENBQUM7QUFDeEUsWUFBSSxJQUFJLEtBQUssVUFBVSxhQUFhLG1CQUFtQixpQkFBaUIsRUFBRSxXQUFXLE1BQU0sQ0FBQyxDQUFDLENBQUM7QUFDOUY7QUFBQSxNQUNGO0FBQ0EsVUFBSSxVQUFVLEtBQUssRUFBRSxnQkFBZ0Isa0NBQWtDLENBQUM7QUFDeEUsVUFBSSxJQUFJLEtBQUssVUFBVTtBQUFBLFFBQ3JCLE1BQU07QUFBQSxRQUFHLEtBQUssRUFBRSxNQUFNLE9BQU8sRUFBRSxJQUFJLEtBQUs7QUFBQSxRQUFHLE1BQU07QUFBQSxRQUNqRCxNQUFNO0FBQUEsTUFDUixDQUFDLENBQUM7QUFDRjtBQUFBLElBQ0Y7QUFDQSxRQUFJLElBQUksV0FBVyxTQUFTLElBQUksYUFBYSxhQUFhO0FBRXhELFVBQUksVUFBVSxLQUFLLEVBQUUsZ0JBQWdCLGtDQUFrQyxDQUFDO0FBQ3hFLFVBQUksSUFBSSxLQUFLLFVBQVU7QUFBQSxRQUNyQixLQUFLO0FBQUEsUUFBTSxLQUFLO0FBQUEsUUFDaEIsU0FBUztBQUFBLFVBQ1AsRUFBRSxPQUFPLEtBQUssTUFBTSxhQUFhO0FBQUEsVUFDakMsRUFBRSxPQUFPLEtBQUssTUFBTSxnQkFBZ0I7QUFBQSxRQUN0QztBQUFBLFFBQ0EsTUFBTTtBQUFBLE1BQ1IsQ0FBQyxDQUFDO0FBQ0Y7QUFBQSxJQUNGO0FBQ0EsUUFBSSxJQUFJLFdBQVcsU0FBUyxJQUFJLGFBQWEsbUJBQW1CO0FBRTlELFVBQUksVUFBVSxLQUFLLEVBQUUsZ0JBQWdCLGtDQUFrQyxDQUFDO0FBQ3hFLFVBQUksSUFBSSxLQUFLLFVBQVU7QUFBQSxRQUNyQixTQUFTLGVBQWU7QUFBQSxRQUN4QixPQUFPLGVBQWU7QUFBQSxNQUN4QixDQUFDLENBQUM7QUFDRjtBQUFBLElBQ0Y7QUFDQSxRQUFJLElBQUksV0FBVyxVQUFVLElBQUksYUFBYSxtQkFBbUI7QUFDL0QsWUFBTSxZQUFZO0FBQ2hCLGNBQU0sT0FBTyxLQUFLLE1BQU8sTUFBTSxTQUFTLEtBQU0sSUFBSTtBQUNsRCxjQUFNLE9BQU8sT0FBTyxLQUFLLFNBQVMsV0FBVyxLQUFLLE9BQU87QUFDekQsY0FBTSxPQUFPLE9BQU8sS0FBSyxTQUFTLFlBQVksS0FBSyxTQUFTLEtBQUssS0FBSyxPQUFRLEtBQUssTUFBTSxPQUFPLEVBQUUsT0FBTyxPQUFPLEVBQUUsSUFBSSxLQUFLO0FBQzNILFlBQUksU0FBUyxNQUFNLFNBQVMsSUFBSTtBQUM5QixjQUFJLFVBQVUsS0FBSyxFQUFFLGdCQUFnQixrQ0FBa0MsQ0FBQztBQUN4RSxjQUFJLElBQUksS0FBSyxVQUFVLGFBQWEsbUJBQW1CLG1DQUFtQyxFQUFFLFdBQVcsTUFBTSxDQUFDLENBQUMsQ0FBQztBQUNoSDtBQUFBLFFBQ0Y7QUFDQSxZQUFJLGVBQWUsTUFBTSxLQUFLLENBQUMsTUFBTSxFQUFFLEtBQUssWUFBWSxNQUFNLEtBQUssWUFBWSxDQUFDLEdBQUc7QUFDakYsY0FBSSxVQUFVLEtBQUssRUFBRSxnQkFBZ0Isa0NBQWtDLENBQUM7QUFDeEUsY0FBSSxJQUFJLEtBQUssVUFBVSxhQUFhLG1CQUFtQixnQ0FBZ0MsRUFBRSxXQUFXLE1BQU0sQ0FBQyxDQUFDLENBQUM7QUFDN0c7QUFBQSxRQUNGO0FBQ0EsY0FBTSxPQUFPLEVBQUUsSUFBSSxNQUFNLEtBQUssT0FBTyxFQUFFLFNBQVMsRUFBRSxFQUFFLE1BQU0sR0FBRyxDQUFDLENBQUMsSUFBSSxNQUFNLEtBQUs7QUFDOUUsdUJBQWUsTUFBTSxLQUFLLElBQUk7QUFDOUIsWUFBSSxVQUFVLEtBQUssRUFBRSxnQkFBZ0Isa0NBQWtDLENBQUM7QUFDeEUsWUFBSSxJQUFJLEtBQUssVUFBVSxFQUFFLElBQUksTUFBTSxTQUFTLGVBQWUsU0FBUyxPQUFPLGVBQWUsTUFBTSxDQUFDLENBQUM7QUFBQSxNQUNwRyxHQUFHO0FBQ0g7QUFBQSxJQUNGO0FBQ0EsUUFBSSxJQUFJLFdBQVcsVUFBVSxJQUFJLGFBQWEsdUJBQXVCO0FBQ25FLFlBQU0sWUFBWTtBQUNoQixjQUFNLE9BQU8sS0FBSyxNQUFPLE1BQU0sU0FBUyxLQUFNLElBQUk7QUFDbEQsY0FBTSxNQUFNLGVBQWUsTUFBTSxLQUFLLENBQUMsTUFBTSxFQUFFLE9BQU8sS0FBSyxFQUFFO0FBQzdELFlBQUksUUFBUSxRQUFXO0FBQ3JCLGNBQUksVUFBVSxLQUFLLEVBQUUsZ0JBQWdCLGtDQUFrQyxDQUFDO0FBQ3hFLGNBQUksSUFBSSxLQUFLLFVBQVUsYUFBYSxtQkFBbUIsdUJBQXVCLEVBQUUsV0FBVyxNQUFNLENBQUMsQ0FBQyxDQUFDO0FBQ3BHO0FBQUEsUUFDRjtBQUNBLHVCQUFlLFVBQVUsSUFBSTtBQUM3QixZQUFJLFVBQVUsS0FBSyxFQUFFLGdCQUFnQixrQ0FBa0MsQ0FBQztBQUN4RSxZQUFJLElBQUksS0FBSyxVQUFVLEVBQUUsSUFBSSxNQUFNLFNBQVMsZUFBZSxTQUFTLE9BQU8sZUFBZSxNQUFNLENBQUMsQ0FBQztBQUFBLE1BQ3BHLEdBQUc7QUFDSDtBQUFBLElBQ0Y7QUFDQSxRQUFJLElBQUksV0FBVyxVQUFVLElBQUksYUFBYSxrQkFBa0I7QUFDOUQsWUFBTSxZQUFZO0FBQ2hCLGNBQU0sT0FBTyxLQUFLLE1BQU8sTUFBTSxTQUFTLEtBQU0sSUFBSTtBQUNsRCxjQUFNLE9BQU8sT0FBTyxLQUFLLFNBQVMsV0FBVyxLQUFLLEtBQUssS0FBSyxJQUFJO0FBQ2hFLGNBQU0sVUFBVSxPQUFPLEtBQUssWUFBWSxXQUFXLEtBQUssUUFBUSxLQUFLLElBQUk7QUFDekUsY0FBTSxRQUFRLE9BQU8sS0FBSyxVQUFVLFdBQVcsS0FBSyxNQUFNLEtBQUssSUFBSTtBQUNuRSxZQUFJLFNBQVMsTUFBTSxZQUFZLE1BQU0sVUFBVSxJQUFJO0FBQ2pELGNBQUksVUFBVSxLQUFLLEVBQUUsZ0JBQWdCLGtDQUFrQyxDQUFDO0FBQ3hFLGNBQUksSUFBSSxLQUFLLFVBQVUsYUFBYSxtQkFBbUIsd0NBQXdDLEVBQUUsV0FBVyxNQUFNLENBQUMsQ0FBQyxDQUFDO0FBQ3JIO0FBQUEsUUFDRjtBQUNBLHNCQUFjLElBQUksTUFBTSxFQUFFLFNBQVMsT0FBTyxRQUFRLE9BQU8sS0FBSyxXQUFXLFdBQVcsS0FBSyxTQUFTLEdBQUcsQ0FBQztBQUN0RyxZQUFJLFVBQVUsS0FBSyxFQUFFLGdCQUFnQixrQ0FBa0MsQ0FBQztBQUN4RSxZQUFJLElBQUksS0FBSyxVQUFVLEVBQUUsSUFBSSxNQUFNLEtBQUssQ0FBQyxDQUFDO0FBQUEsTUFDNUMsR0FBRztBQUNIO0FBQUEsSUFDRjtBQUNBLFFBQUksSUFBSSxXQUFXLFNBQVMsSUFBSSxhQUFhLGtCQUFrQjtBQUU3RCxZQUFNLEtBQUssSUFBSSxhQUFhLElBQUksR0FBRyxLQUFLLElBQUksS0FBSyxFQUFFLFlBQVk7QUFDL0QsWUFBTSxNQUFNO0FBQUEsUUFDVixFQUFFLEtBQUssYUFBYSxNQUFNLHVCQUF1QixNQUFNLE9BQU87QUFBQSxRQUM5RCxFQUFFLEtBQUssY0FBYyxNQUFNLHlCQUF5QixNQUFNLE9BQU87QUFBQSxRQUNqRSxFQUFFLEtBQUssaUJBQWlCLE1BQU0sNEJBQTRCLE1BQU0sT0FBTztBQUFBLE1BQ3pFO0FBQ0EsWUFBTSxPQUFPLE1BQU0sS0FBSyxNQUFNLElBQUksT0FBTyxDQUFDLE1BQU0sRUFBRSxJQUFJLFlBQVksRUFBRSxTQUFTLENBQUMsQ0FBQztBQUMvRSxVQUFJLFVBQVUsS0FBSyxFQUFFLGdCQUFnQixrQ0FBa0MsQ0FBQztBQUN4RSxVQUFJLElBQUksS0FBSyxVQUFVLEVBQUUsU0FBUyxLQUFLLE1BQU0sR0FBRyxFQUFFLEdBQUcsV0FBVyxPQUFPLE9BQU8sS0FBSyxPQUFPLENBQUMsQ0FBQztBQUM1RjtBQUFBLElBQ0Y7QUFDQSxRQUFJLElBQUksV0FBVyxTQUFTLElBQUksYUFBYSxrQkFBa0I7QUFFN0QsVUFBSSxVQUFVLEtBQUssRUFBRSxnQkFBZ0Isa0NBQWtDLENBQUM7QUFDeEUsVUFBSSxJQUFJLEtBQUssVUFBVTtBQUFBLFFBQ3JCLFFBQVEsRUFBRSxRQUFRLEdBQUcsU0FBUyxJQUFJLGdCQUFnQixFQUFFO0FBQUEsUUFDcEQsY0FBYztBQUFBLFFBQ2QsYUFBYTtBQUFBLFFBQ2IsWUFBWSxFQUFFLFNBQVMsR0FBRyxTQUFTLEdBQUcsU0FBUyxHQUFHLE9BQU8sS0FBSztBQUFBLFFBQzlELGFBQWEsRUFBRSxhQUFhLElBQUksYUFBYSxLQUFLO0FBQUEsTUFDcEQsQ0FBQyxDQUFDO0FBQ0Y7QUFBQSxJQUNGO0FBQ0EsUUFBSSxJQUFJLFdBQVcsVUFBVSxJQUFJLGFBQWEsa0JBQWtCO0FBQzlELFlBQU0sWUFBWTtBQUNoQixZQUFJO0FBQ0YsZ0JBQU0sT0FBTyxLQUFLLE1BQU8sTUFBTSxTQUFTLEtBQU0sSUFBSTtBQUdsRCxnQkFBTSxNQUFNLEtBQUssS0FBSyxXQUFXLEtBQUssT0FBTyxLQUFLLE1BQU0sS0FBSyxPQUFPO0FBQ3BFLGNBQUksVUFBVSxLQUFLLEVBQUUsZ0JBQWdCLGtDQUFrQyxDQUFDO0FBQ3hFLGNBQUksSUFBSSxLQUFLLFVBQVUsRUFBRSxJQUFJLE1BQU0sSUFBSSxDQUFDLENBQUM7QUFBQSxRQUMzQyxTQUFTLEtBQUs7QUFDWixjQUFJLFVBQVUsS0FBSyxFQUFFLGdCQUFnQixrQ0FBa0MsQ0FBQztBQUN4RSxjQUFJLElBQUksS0FBSyxVQUFVLGFBQWEsbUJBQW1CLE9BQU8sR0FBRyxFQUFFLE1BQU0sR0FBRyxHQUFHLEdBQUcsRUFBRSxXQUFXLE1BQU0sQ0FBQyxDQUFDLENBQUM7QUFBQSxRQUMxRztBQUFBLE1BQ0YsR0FBRztBQUNIO0FBQUEsSUFDRjtBQUNBLFFBQUksVUFBVSxLQUFLLEVBQUUsZ0JBQWdCLGtDQUFrQyxDQUFDO0FBQ3hFLFFBQUksSUFBSSxLQUFLLFVBQVUsYUFBYSxtQkFBbUIsWUFBWSxJQUFJLE1BQU0sSUFBSSxJQUFJLFFBQVEsSUFBSSxFQUFFLFdBQVcsTUFBTSxDQUFDLENBQUMsQ0FBQztBQUFBLEVBQ3pILENBQUM7QUFFRCxRQUFNLElBQUksUUFBYyxDQUFDQSxVQUFTLFdBQVc7QUFDM0MsV0FBTyxLQUFLLFNBQVMsTUFBTTtBQUMzQixXQUFPLE9BQU8sR0FBRyxhQUFhLE1BQU1BLFNBQVEsQ0FBQztBQUFBLEVBQy9DLENBQUM7QUFDRCxRQUFNLFVBQVUsT0FBTyxRQUFRO0FBQy9CLE1BQUksWUFBWSxRQUFRLE9BQU8sWUFBWSxTQUFVLE9BQU0sSUFBSSxNQUFNLG9CQUFvQjtBQUN6RixRQUFNLE9BQU8sUUFBUTtBQUVyQixNQUFJLENBQUMsS0FBSyxPQUFPO0FBQ2YsWUFBUSxPQUFPLE1BQU0sR0FBRyxLQUFLLFVBQVUsRUFBRSxxQkFBcUIsTUFBTSxNQUFNLFNBQVMsYUFBYSxDQUFDLENBQUM7QUFBQSxDQUFJO0FBQUEsRUFDeEc7QUFDQSxRQUFNLFdBQVcsT0FBTyxRQUFRLElBQUksMEJBQTBCLENBQUM7QUFDL0QsTUFBSSxPQUFPLFNBQVMsUUFBUSxLQUFLLFdBQVcsR0FBRztBQUM3QyxlQUFXLE1BQU0sUUFBUSxLQUFLLENBQUMsR0FBRyxRQUFRLEVBQUUsTUFBTTtBQUFBLEVBQ3BEO0FBSUEsUUFBTSxRQUFRLE1BQ1osSUFBSSxRQUFjLENBQUNBLGFBQVk7QUFDN0IsZUFBVyxLQUFLLFlBQVk7QUFDMUIsVUFBSTtBQUFFLFVBQUUsSUFBSTtBQUFHLFVBQUUsUUFBUTtBQUFBLE1BQUcsUUFBUTtBQUFBLE1BQXFCO0FBQUEsSUFDM0Q7QUFDQSxlQUFXLE1BQU07QUFDakIsV0FBTyxNQUFNLE1BQU1BLFNBQVEsQ0FBQztBQUM1QixlQUFXLE1BQU1BLFNBQVEsR0FBRyxHQUFLLEVBQUUsTUFBTTtBQUFBLEVBQzNDLENBQUM7QUFFSCxTQUFPLEVBQUUsTUFBTSxNQUFNLE1BQU07QUFDN0I7QUFLQSxJQUFNLFVBQWtCLE9BQU8sZUFBZSxXQUMxQyxjQUFjLGFBQWEsVUFBVSxDQUFDLEVBQUUsT0FDeEMsWUFBWTtBQUNoQixJQUFNLG1CQUFtQixNQUFNO0FBQzdCLE1BQUksUUFBUSxLQUFLLENBQUMsTUFBTSxPQUFXLFFBQU87QUFDMUMsTUFBSTtBQUNGLFdBQU8sWUFBWSxjQUFjLGFBQWEsUUFBUSxLQUFLLENBQUMsQ0FBQyxDQUFDLEVBQUU7QUFBQSxFQUNsRSxRQUFRO0FBQ04sV0FBTztBQUFBLEVBQ1Q7QUFDRixHQUFHO0FBQ0gsSUFBSSxpQkFBaUI7QUFDbkIsUUFBTSxRQUFRLFFBQVEsSUFBSSxxQkFBcUI7QUFFL0MsTUFBSSxRQUFRLElBQUksMEJBQTBCLEtBQUs7QUFDN0MsWUFBUSxLQUFLLENBQUM7QUFBQSxFQUNoQjtBQUNBLFFBQU0sT0FBTyxPQUFPLFFBQVEsSUFBSSx3QkFBd0IsQ0FBQztBQUN6RCxRQUFNLE9BQU8sTUFBWTtBQUN2QixTQUFLLGNBQWMsRUFBRSxNQUFNLENBQUMsRUFBRSxNQUFNLENBQUMsUUFBUTtBQUMzQyxjQUFRLE9BQU8sTUFBTSxxQkFBcUIsT0FBTyxHQUFHLENBQUM7QUFBQSxDQUFJO0FBQ3pELGNBQVEsS0FBSyxDQUFDO0FBQUEsSUFDaEIsQ0FBQztBQUFBLEVBQ0g7QUFDQSxNQUFJLE9BQU8sU0FBUyxJQUFJLEtBQUssT0FBTyxFQUFHLFlBQVcsTUFBTSxJQUFJO0FBQUEsTUFDdkQsTUFBSztBQUNaOzs7QUM1bEJBLFNBQVMsV0FBK0I7QUFDeEMsU0FBUyxPQUFPLGlCQUFpQjtBQUNqQyxTQUFTLFlBQVk7QUFFckIsSUFBTSxRQUFRLENBQUMsT0FBOEIsSUFBSSxRQUFRLENBQUMsTUFBTSxXQUFXLEdBQUcsRUFBRSxDQUFDO0FBRWpGLGVBQWUsWUFBWSxLQUFvQixNQUFzQztBQUNuRixRQUFNLFFBQVEsUUFBUSxJQUFJLDhCQUE4QixLQUFLLElBQUksUUFBUSxNQUFNLEdBQUcsY0FBYztBQUNoRyxRQUFNLE1BQU0sT0FBTyxFQUFFLFdBQVcsS0FBSyxDQUFDLEVBQUUsTUFBTSxNQUFNLE1BQVM7QUFDN0QsUUFBTSxVQUE0QyxDQUFDO0FBQ25ELE1BQUksVUFBVTtBQUVkLFFBQU0sS0FBSyxDQUFJLFNBQTZCLElBQUksWUFBWSxrQkFBa0IsTUFBTSxJQUFJO0FBQ3hGLFFBQU0sT0FBTyxPQUFPLE1BQWMsT0FBd0Q7QUFDeEYsUUFBSTtBQUNGLFlBQU0sQ0FBQyxJQUFJLE1BQU0sSUFBSSxNQUFNLEdBQUc7QUFDOUIsY0FBUSxLQUFLLENBQUMsTUFBTSxJQUFJLE1BQU0sQ0FBQztBQUFBLElBQ2pDLFNBQVMsS0FBSztBQUNaLFlBQU0sU0FBUyxlQUFlLFNBQVMsSUFBSSxVQUFVLFNBQVksSUFBSSxRQUFRLE9BQU8sR0FBRztBQUN2RixjQUFRLEtBQUssQ0FBQyxNQUFNLE9BQU8sT0FBTyxNQUFNLEdBQUcsR0FBRyxDQUFDLENBQUM7QUFBQSxJQUNsRDtBQUNBLFVBQU0sT0FBTyxRQUFRLFFBQVEsU0FBUyxDQUFDO0FBQ3ZDLFlBQVEsSUFBSSxZQUFZLEtBQUssQ0FBQyxJQUFJLFNBQVMsTUFBTSxNQUFNLEtBQUssQ0FBQyxDQUFDLE1BQU0sS0FBSyxDQUFDLENBQUMsRUFBRTtBQUFBLEVBQy9FO0FBRUEsUUFBTSxVQUFVLE9BQU8sT0FBZSxlQUF1QixjQUFrRDtBQUM3RyxVQUFNLFVBQVUsS0FBSyxJQUFJO0FBQ3pCLGVBQVM7QUFDUCxZQUFNLElBQUssTUFBTSxHQUFHLHlEQUF5RCxhQUFhLDhGQUE4RjtBQUN4TCxVQUFJO0FBQ0osVUFBSTtBQUFFLGlCQUFTLEtBQUssTUFBTSxDQUFDO0FBQUEsTUFBd0MsUUFBUTtBQUFFLGlCQUFTLEVBQUUsSUFBSSxPQUFPLFFBQVEsT0FBTyxDQUFDLEVBQUUsTUFBTSxHQUFHLEdBQUcsRUFBRTtBQUFBLE1BQUc7QUFDdEksVUFBSSxPQUFPLE9BQU8sS0FBTSxRQUFPLENBQUMsTUFBTSxPQUFPLE9BQU8sVUFBVSxFQUFFLENBQUM7QUFDakUsVUFBSSxLQUFLLElBQUksSUFBSSxVQUFVLFVBQVcsUUFBTyxDQUFDLE9BQU8sR0FBRyxLQUFLLEtBQUssT0FBTyxPQUFPLFVBQVUsU0FBUyxDQUFDLEVBQUU7QUFDdEcsWUFBTSxNQUFNLEdBQUc7QUFBQSxJQUNqQjtBQUFBLEVBQ0Y7QUFDQSxRQUFNLE9BQU8sT0FBTyxVQUFpQztBQUNuRCxlQUFXO0FBQ1gsUUFBSTtBQUNGLFlBQU0sTUFBTSxNQUFNLElBQUksWUFBWSxZQUFZO0FBQzlDLFlBQU0sVUFBVSxLQUFLLE9BQU8sR0FBRyxJQUFJLElBQUksT0FBTyxPQUFPLEVBQUUsU0FBUyxHQUFHLEdBQUcsQ0FBQyxJQUFJLEtBQUssTUFBTSxHQUFHLElBQUksTUFBTSxDQUFDO0FBQUEsSUFDdEcsUUFBUTtBQUFBLElBQWdCO0FBQUEsRUFDMUI7QUFHQSxRQUFNLFdBQVcsQ0FBQyxLQUFhLFNBQzdCLEdBQUc7QUFBQSx3Q0FDaUMsS0FBSyxVQUFVLEdBQUcsQ0FBQztBQUFBO0FBQUE7QUFBQSxxRUFHVSxLQUFLLFVBQVUsSUFBSSxDQUFDO0FBQUE7QUFBQTtBQUFBLFNBR2hGO0FBSVAsUUFBTSxRQUFRLGNBQWMsZ0hBQWdILEdBQU07QUFDbEosUUFBTSxRQUFRLGVBQWUsa0lBQWtJLFNBQVMsU0FBUyxNQUFTLEdBQU07QUFDaE0sUUFBTSxNQUFNLElBQUs7QUFHakIsUUFBTSxLQUFLLGtIQUFrQyxZQUFZO0FBQ3ZELFVBQU0sSUFBSyxNQUFNLEdBQUc7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsU0FTZjtBQUNMLFVBQU0sSUFBSSxLQUFLLE1BQU0sQ0FBQztBQUN0QixXQUFPLENBQUMsRUFBRSxPQUFPLE1BQU0sRUFBRSxNQUFNO0FBQUEsRUFDakMsQ0FBQztBQUVELE1BQUksU0FBUyxRQUFRO0FBR25CLFFBQUksUUFBUSxJQUFJLGdDQUFnQyxRQUFRO0FBQ3RELFlBQU0sS0FBSyw4R0FBeUIsWUFBWTtBQUM5QyxjQUFNLElBQUksTUFBTSxRQUFRLGtCQUFrQjtBQUFBO0FBQUEsb0dBRThCLElBQU07QUFDOUUsY0FBTSxLQUFLLGdCQUFnQjtBQUMzQixlQUFPO0FBQUEsTUFDVCxDQUFDO0FBQ0QsWUFBTSxLQUFLLDhMQUF3QyxZQUFZO0FBQzdELGNBQU0sR0FBRywyTEFBdUs7QUFDaEwsY0FBTSxJQUFJLE1BQU0sUUFBUSxxQkFBcUI7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSx5S0FPNEUsSUFBTTtBQUMvSCxjQUFNLEtBQUsscUJBQXFCO0FBQ2hDLGVBQU87QUFBQSxNQUNULENBQUM7QUFDRCxZQUFNLEtBQUssNk1BQXdDLFlBQVk7QUFDN0QsY0FBTSxHQUFHLHFPQUE2TDtBQUV0TSxjQUFNLFFBQVEsa0JBQWtCO0FBQUE7QUFBQTtBQUFBO0FBQUEsaURBSVMsSUFBTTtBQUMvQyxjQUFNLElBQUksTUFBTSxRQUFRLGFBQWE7QUFBQTtBQUFBLDBJQUV5RSxHQUFLO0FBQ25ILGNBQU0sS0FBSyxhQUFhO0FBQ3hCLGNBQU0sR0FBRywyTEFBdUs7QUFDaEwsY0FBTSxTQUFTLE1BQU0sUUFBUSw2QkFBNkI7QUFBQSx5SkFDdUYsR0FBTTtBQUN2SixlQUFPLENBQUMsRUFBRSxDQUFDLEtBQUssT0FBTyxDQUFDLEdBQUcsU0FBUyxFQUFFLENBQUMsQ0FBQyxLQUFLLE9BQU8sQ0FBQyxDQUFDLEVBQUU7QUFBQSxNQUMxRCxDQUFDO0FBQUEsSUFDSDtBQUdBLFVBQU0sS0FBSywrRkFBb0IsWUFBWTtBQUN6QyxZQUFNLElBQUksTUFBTSxRQUFRLFNBQVMsd0dBQXdHLEdBQUs7QUFDOUksVUFBSSxDQUFDLEVBQUUsQ0FBQyxFQUFHLFFBQU87QUFDbEIsWUFBTSxHQUFHO0FBQUE7QUFBQTtBQUFBO0FBQUEsV0FJSjtBQUNMLGFBQU8sUUFBUSxjQUFjLHFJQUFxSSxHQUFLO0FBQUEsSUFDekssQ0FBQztBQUdELFVBQU0sS0FBSyxrRUFBcUIsWUFBWTtBQUMxQyxZQUFNLEdBQUcsMkZBQTJGO0FBQ3BHLGFBQU8sUUFBUSxvQkFBb0I7QUFBQSwyTUFDOEksR0FBSztBQUFBLElBQ3hMLENBQUM7QUFHRCxVQUFNLEtBQUssMkdBQXNCLFlBQVk7QUFDM0MsWUFBTSxTQUFTLHNCQUFzQiwrREFBYTtBQUNsRCxZQUFNLE1BQU0sR0FBRztBQUNmLFlBQU0sR0FBRztBQUFBO0FBQUE7QUFBQTtBQUFBLFdBSUo7QUFDTCxhQUFPLFFBQVEseUJBQXlCO0FBQUEsMEhBQzRFLEdBQUs7QUFBQSxJQUMzSCxDQUFDO0FBR0QsVUFBTSxLQUFLLDJFQUF5QixZQUFZO0FBQzlDLFlBQU0sSUFBSSxNQUFNLFFBQVEsYUFBYTtBQUFBO0FBQUEseUZBRThDLEdBQUs7QUFDeEYsYUFBTztBQUFBLElBQ1QsQ0FBQztBQUdELFVBQU0sS0FBSyxrRkFBMkIsWUFBWTtBQUNoRCxZQUFNLEtBQUssa0JBQWtCO0FBQzdCLGFBQU8sUUFBUSxpQkFBaUI7QUFBQSx3S0FDOEcsR0FBSztBQUFBLElBQ3JKLENBQUM7QUFDRCxVQUFNLEtBQUssd0dBQXdCLFlBQVk7QUFDN0MsWUFBTSxHQUFHO0FBQUE7QUFBQTtBQUFBLFdBR0o7QUFDTCxZQUFNLElBQUksTUFBTSxRQUFRLGdCQUFnQjtBQUFBO0FBQUE7QUFBQSxtTEFHcUksSUFBTTtBQUNuTCxZQUFNLEtBQUssZUFBZTtBQUMxQixhQUFPO0FBQUEsSUFDVCxDQUFDO0FBR0QsVUFBTSxLQUFLLG1GQUE0QixZQUFZO0FBQ2pELFlBQU0sR0FBRyx1RkFBdUY7QUFDaEcsYUFBTyxRQUFRLGlCQUFpQjtBQUFBLCtJQUN5RyxHQUFLO0FBQUEsSUFDaEosQ0FBQztBQUdELFVBQU0sS0FBSyxvQ0FBcUIsWUFBWTtBQUMxQyxZQUFNLEdBQUcsdUpBQXVKO0FBQ2hLLGFBQU8sUUFBUSxpQkFBaUI7QUFBQTtBQUFBLGlKQUUyRyxHQUFLO0FBQUEsSUFDbEosQ0FBQztBQUNELFVBQU0sS0FBSyxvREFBc0IsWUFBWTtBQUMzQyxZQUFNLEdBQUcsb0xBQTBLO0FBQ25MLFlBQU0sSUFBSSxNQUFNLFFBQVEsV0FBVztBQUFBLHdEQUNlLEdBQUs7QUFDdkQsVUFBSSxDQUFDLEVBQUUsQ0FBQyxFQUFHLFFBQU87QUFFbEIsWUFBTSxHQUFHLDhNQUF1TTtBQUNoTixZQUFNLEtBQUssTUFBTSxRQUFRLGFBQWE7QUFBQSx3SEFDNEUsR0FBSztBQUN2SCxVQUFJLENBQUMsR0FBRyxDQUFDLEVBQUcsUUFBTztBQUNuQixZQUFNLEdBQUcsNkpBQTZKO0FBQ3RLLGFBQU8sUUFBUSxnQkFBZ0I7QUFBQSx1SkFDa0gsR0FBSztBQUFBLElBQ3hKLENBQUM7QUFDRCxVQUFNLEtBQUssZ0NBQWlCLFlBQVk7QUFDdEMsWUFBTSxHQUFHLG1MQUF5SztBQUNsTCxhQUFPLFFBQVEsYUFBYTtBQUFBLDZEQUMyQixHQUFLO0FBQUEsSUFDOUQsQ0FBQztBQUNELFVBQU0sS0FBSywwQ0FBc0IsWUFBWTtBQUMzQyxZQUFNLEdBQUcsdUxBQTZLO0FBQ3RMLGFBQU8sUUFBUSxpQkFBaUI7QUFBQTtBQUFBLHlJQUVtRyxHQUFLO0FBQUEsSUFDMUksQ0FBQztBQUNELFVBQU0sS0FBSyxvREFBc0IsWUFBWTtBQUMzQyxZQUFNLEdBQUcsbUxBQXlLO0FBQ2xMLFlBQU0sSUFBSSxNQUFNLFFBQVEsYUFBYTtBQUFBLDBHQUMrRCxHQUFLO0FBQ3pHLGFBQU87QUFBQSxJQUNULENBQUM7QUFHRCxVQUFNLEtBQUssbUZBQXVCLFlBQVk7QUFDNUMsWUFBTSxHQUFHLHFMQUEySztBQUNwTCxhQUFPLFFBQVEsZUFBZTtBQUFBO0FBQUE7QUFBQTtBQUFBLHNGQUlrRCxHQUFLO0FBQUEsSUFDdkYsQ0FBQztBQUdELFVBQU0sS0FBSyxxREFBYSxZQUFZO0FBQ2xDLFlBQU0sU0FBVSxNQUFNLEdBQUcsbURBQW1EO0FBQzVFLFlBQU0sU0FBUyxtQkFBbUIsMENBQVk7QUFDOUMsWUFBTSxJQUFJLE1BQU0sUUFBUSxrQkFBa0I7QUFBQSxvREFDSSxHQUFLO0FBQ25ELFlBQU0sU0FBUyxtQkFBbUIsRUFBRTtBQUNwQyxZQUFNLE1BQU0sR0FBRztBQUNmLFlBQU0sUUFBUyxNQUFNLEdBQUcsbURBQW1EO0FBQzNFLGFBQU8sQ0FBQyxFQUFFLENBQUMsS0FBSyxVQUFVLFFBQVEsR0FBRyxFQUFFLENBQUMsQ0FBQyx3QkFBUyxLQUFLLE1BQU0sTUFBTSxFQUFFO0FBQUEsSUFDdkUsQ0FBQztBQUdELFVBQU0sS0FBSyw4RUFBdUIsWUFBWTtBQUM1QyxZQUFNLEdBQUcsMkZBQTJGO0FBQ3BHLFlBQU0sSUFBSSxNQUFNLFFBQVEsYUFBYTtBQUFBLDZEQUNrQixHQUFLO0FBQzVELFVBQUksQ0FBQyxFQUFFLENBQUMsRUFBRyxRQUFPO0FBQ2xCLFlBQU0sR0FBRyw4TUFBb007QUFDN00sYUFBTyxRQUFRLGdCQUFnQjtBQUFBLHFJQUNzRixHQUFLO0FBQUEsSUFDNUgsQ0FBQztBQUdELFVBQU0sS0FBSyxpRkFBeUMsWUFBWTtBQUM5RCxZQUFNLEdBQUcsMEdBQTBHO0FBQ25ILFlBQU0sSUFBSSxNQUFNLFFBQVEsaUJBQWlCO0FBQUEseUdBQzBELEdBQUs7QUFDeEcsVUFBSSxDQUFDLEVBQUUsQ0FBQyxFQUFHLFFBQU87QUFDbEIsWUFBTSxHQUFHLGtGQUFrRjtBQUMzRixhQUFPLFFBQVEsbUJBQW1CLDRFQUE0RSxHQUFLO0FBQUEsSUFDckgsQ0FBQztBQUdELFVBQU0sS0FBSyx3RkFBNEIsWUFBWTtBQUNqRCxZQUFNLEdBQUcsMEdBQTBHO0FBQ25ILFlBQU0sSUFBSSxNQUFNLFFBQVEsaUJBQWlCO0FBQUEsNkRBQ2MsR0FBSztBQUM1RCxVQUFJLENBQUMsRUFBRSxDQUFDLEVBQUcsUUFBTztBQUNsQixZQUFNLEdBQUcseUtBQXlLO0FBQ2xMLFlBQU0sS0FBSyxNQUFNLFFBQVEsaUJBQWlCO0FBQUEsMEdBQzBELEdBQUs7QUFDekcsWUFBTSxLQUFLLFNBQVM7QUFDcEIsWUFBTSxHQUFHLDhLQUFvSztBQUM3SyxZQUFNLEtBQUssTUFBTSxRQUFRLGdCQUFnQjtBQUFBLHVIQUNvRCxHQUFLO0FBQ2xHLFlBQU0sR0FBRyxrRkFBa0Y7QUFDM0YsYUFBTyxDQUFDLEdBQUcsQ0FBQyxLQUFLLEdBQUcsQ0FBQyxHQUFHLE9BQU8sR0FBRyxDQUFDLENBQUMsU0FBUyxHQUFHLENBQUMsQ0FBQyxFQUFFO0FBQUEsSUFDdEQsQ0FBQztBQUdELFVBQU0sS0FBSyw2R0FBd0IsWUFBWTtBQUM3QyxhQUFPLFFBQVEsaUJBQWlCO0FBQUE7QUFBQSw4SEFFOEUsR0FBSztBQUFBLElBQ3JILENBQUM7QUFDRCxVQUFNLEtBQUssMktBQW9DLFlBQVk7QUFDekQsWUFBTSxHQUFHLG9GQUFvRjtBQUM3RixZQUFNLElBQUksTUFBTSxRQUFRLFdBQVc7QUFBQTtBQUFBO0FBQUE7QUFBQSwwR0FJaUUsR0FBSztBQUN6RyxVQUFJLENBQUMsRUFBRSxDQUFDLEVBQUcsUUFBTztBQUNsQixZQUFNLEtBQUssU0FBUztBQUVwQixZQUFNLEdBQUcsc0ZBQXNGO0FBQy9GLFlBQU0sU0FBUyxNQUFNLFFBQVEsZ0NBQWdDO0FBQUEsa01BQytILEdBQUs7QUFDak0sYUFBTyxDQUFDLE9BQU8sQ0FBQyxHQUFHLEdBQUcsRUFBRSxDQUFDLENBQUMsS0FBSyxPQUFPLENBQUMsQ0FBQyxFQUFFO0FBQUEsSUFDNUMsQ0FBQztBQUdELFVBQU0sS0FBSyw0RkFBc0IsWUFBWTtBQUMzQyxhQUFPLFFBQVEsY0FBYztBQUFBO0FBQUE7QUFBQSwyRkFHd0QsR0FBSztBQUFBLElBQzVGLENBQUM7QUFDRCxVQUFNLEtBQUssc0dBQXNCLFlBQVk7QUFDM0MsWUFBTSxTQUFVLE1BQU0sR0FBRyxtREFBbUQ7QUFDNUUsVUFBSSxXQUFXLEVBQUcsUUFBTyxDQUFDLE9BQU8sc0JBQXNCO0FBQ3ZELFlBQU0sR0FBRyxvRkFBb0Y7QUFDN0YsWUFBTSxZQUFZLE1BQU0sUUFBUSxhQUFhO0FBQUEsMkVBQ3dCLE1BQU07QUFBQSwwR0FDeUIsTUFBTSxPQUFPLEdBQUs7QUFDdEgsWUFBTSxLQUFLLG9CQUFvQjtBQUMvQixZQUFNLEdBQUcsb0ZBQW9GO0FBQzdGLFlBQU0sV0FBVyxNQUFNLFFBQVEsaUJBQWlCO0FBQUEsMkJBQzNCLE1BQU0sMEJBQTBCLEdBQUs7QUFDMUQsYUFBTyxDQUFDLFVBQVUsQ0FBQyxLQUFLLFNBQVMsQ0FBQyxHQUFHLGFBQWEsVUFBVSxDQUFDLENBQUMsYUFBYSxTQUFTLENBQUMsQ0FBQyxFQUFFO0FBQUEsSUFDMUYsQ0FBQztBQUdELFVBQU0sS0FBSyx1RUFBMEIsWUFBWTtBQUMvQyxZQUFNLEdBQUcsMkZBQTJGO0FBQ3BHLFlBQU0sSUFBSSxNQUFNLFFBQVEsa0JBQWtCO0FBQUE7QUFBQSx3REFFUSxHQUFLO0FBQ3ZELFVBQUksQ0FBQyxFQUFFLENBQUMsRUFBRyxRQUFPO0FBQ2xCLFlBQU0sS0FBSyxXQUFXO0FBQ3RCLFlBQU0sR0FBRyxrRkFBa0Y7QUFDM0YsYUFBTyxRQUFRLG9CQUFvQiw0RUFBNEUsR0FBSztBQUFBLElBQ3RILENBQUM7QUFHRCxVQUFNLEtBQUssNEZBQXNCLFlBQVk7QUFFM0MsWUFBTSxJQUFJLE1BQU0sUUFBUSxjQUFjO0FBQUEsb0ZBQ3dDLEdBQUs7QUFDbkYsVUFBSSxDQUFDLEVBQUUsQ0FBQyxFQUFHLFFBQU87QUFDbEIsWUFBTSxHQUFHLCtMQUFxTDtBQUM5TCxZQUFNLFNBQVMsTUFBTSxRQUFRLGtCQUFrQjtBQUFBO0FBQUEsMEZBRXFDLEdBQUs7QUFDekYsWUFBTSxHQUFHLCtMQUFxTDtBQUM5TCxZQUFNLFFBQVEsTUFBTSxRQUFRLGdCQUFnQjtBQUFBLHFJQUNtRixHQUFLO0FBQ3BJLGFBQU8sQ0FBQyxPQUFPLENBQUMsS0FBSyxNQUFNLENBQUMsR0FBRyxTQUFTLE9BQU8sQ0FBQyxDQUFDLFdBQVcsTUFBTSxDQUFDLENBQUMsRUFBRTtBQUFBLElBQ3hFLENBQUM7QUFDRCxVQUFNLEtBQUssbUhBQXlCLFlBQVk7QUFDOUMsWUFBTSxNQUFNLE1BQU0sUUFBUSxpQkFBaUI7QUFBQSxnR0FDK0MsR0FBSztBQUMvRixVQUFJLENBQUMsSUFBSSxDQUFDLEVBQUcsUUFBTztBQUNwQixZQUFNLEdBQUcsMklBQTJJO0FBQ3BKLFlBQU0sTUFBTSxHQUFHO0FBQ2YsWUFBTSxLQUFNLE1BQU0sR0FBRyxtREFBbUQ7QUFDeEUsWUFBTSxHQUFHLHVJQUF1STtBQUNoSixZQUFNLE1BQU0sR0FBRztBQUNmLFlBQU0sS0FBTSxNQUFNLEdBQUcsbURBQW1EO0FBQ3hFLGFBQU8sQ0FBQyxNQUFNLE1BQU0sTUFBTSxHQUFHLFdBQVcsRUFBRSxRQUFRLEVBQUUsRUFBRTtBQUFBLElBQ3hELENBQUM7QUFHRCxVQUFNLEtBQUssMEdBQStCLFlBQVk7QUFDcEQsWUFBTSxJQUFJLE1BQU0sUUFBUSxnQkFBZ0I7QUFBQSx3RkFDMEMsR0FBSztBQUN2RixVQUFJLENBQUMsRUFBRSxDQUFDLEVBQUcsUUFBTztBQUNsQixZQUFNLEdBQUcsNkZBQTZGO0FBQ3RHLFlBQU0sSUFBSSxNQUFNLFFBQVEsY0FBYztBQUFBO0FBQUE7QUFBQSx1RkFHMkMsR0FBSztBQUN0RixVQUFJLENBQUMsRUFBRSxDQUFDLEVBQUcsUUFBTztBQUNsQixZQUFNLEtBQUssWUFBWTtBQUV2QixZQUFNLEdBQUcsK0lBQStJO0FBQ3hKLGFBQU8sUUFBUSxrQkFBa0I7QUFBQSxzSEFDK0UsR0FBSztBQUFBLElBQ3ZILENBQUM7QUFHRCxVQUFNLEtBQUssb0ZBQW1CLFlBQVk7QUFDeEMsWUFBTSxHQUFHLDBHQUEwRztBQUNuSCxZQUFNLElBQUksTUFBTSxRQUFRLGlCQUFpQjtBQUFBLDZEQUNjLEdBQUs7QUFDNUQsVUFBSSxDQUFDLEVBQUUsQ0FBQyxFQUFHLFFBQU87QUFDbEIsWUFBTSxHQUFHLG1OQUF5TTtBQUNsTixZQUFNLFFBQVEsTUFBTSxRQUFRLGVBQWU7QUFBQTtBQUFBO0FBQUEsaUhBR2dFLEdBQUs7QUFDaEgsWUFBTSxLQUFLLGFBQWE7QUFDeEIsWUFBTSxHQUFHLGtOQUF3TTtBQUNqTixZQUFNLE9BQU8sTUFBTSxRQUFRLGFBQWEsMEhBQTBILEdBQUs7QUFDdkssWUFBTSxHQUFHLGtGQUFrRjtBQUMzRixhQUFPLENBQUMsTUFBTSxDQUFDLEtBQUssS0FBSyxDQUFDLEdBQUcsVUFBVSxNQUFNLENBQUMsQ0FBQyxXQUFXLEtBQUssQ0FBQyxDQUFDLEVBQUU7QUFBQSxJQUNyRSxDQUFDO0FBR0QsVUFBTSxLQUFLLDJFQUFvQixZQUFZO0FBQ3pDLFlBQU0sSUFBSSxNQUFNLFFBQVEsWUFBWTtBQUFBLDJHQUNpRSxHQUFLO0FBQzFHLFVBQUksQ0FBQyxFQUFFLENBQUMsRUFBRyxRQUFPO0FBQ2xCLFlBQU0sR0FBRywrSkFBK0o7QUFDeEssWUFBTSxLQUFLLE1BQU0sUUFBUSxXQUFXO0FBQUEsMEdBQ2dFLEdBQUs7QUFDekcsWUFBTSxHQUFHLG1LQUE4SjtBQUN2SyxZQUFNLEtBQUssTUFBTSxRQUFRLGdCQUFnQjtBQUFBLHVIQUNvRCxHQUFLO0FBQ2xHLGFBQU8sQ0FBQyxHQUFHLENBQUMsS0FBSyxHQUFHLENBQUMsR0FBRyxPQUFPLEdBQUcsQ0FBQyxDQUFDLFNBQVMsR0FBRyxDQUFDLENBQUMsRUFBRTtBQUFBLElBQ3RELENBQUM7QUFHRCxVQUFNLEtBQUssMEdBQW9DLFlBQVk7QUFFekQsWUFBTSxHQUFHLDJGQUEyRjtBQUNwRyxZQUFNLE1BQU0sR0FBRztBQUNmLFlBQU0sR0FBRztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxXQVlKO0FBQ0wsWUFBTSxPQUFPLE1BQU0sUUFBUSxjQUFjO0FBQUEsdURBQ1EsR0FBSztBQUN0RCxVQUFJLENBQUMsS0FBSyxDQUFDLEVBQUcsUUFBTztBQUNyQixZQUFNLFNBQVMsc0JBQXNCLDBCQUFNO0FBQzNDLFlBQU0sTUFBTSxHQUFHO0FBQ2YsWUFBTSxHQUFHLHlLQUErSjtBQUN4SyxZQUFNLE9BQU8sTUFBTSxRQUFRLGNBQWM7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsU0FNdEMsSUFBTTtBQUNULFlBQU0sS0FBSyxjQUFjO0FBQ3pCLGFBQU87QUFBQSxJQUNULENBQUM7QUFHRCxVQUFNLEtBQUssc0hBQTZCLFlBQVk7QUFDbEQsWUFBTSxJQUFLLE1BQU0sR0FBRztBQUFBO0FBQUE7QUFBQTtBQUFBLFdBSWY7QUFDTCxZQUFNLElBQUksS0FBSyxNQUFNLENBQUM7QUFDdEIsYUFBTyxDQUFDLEVBQUUsTUFBTSxFQUFFLFFBQVEsYUFBTSxFQUFFLEVBQUUsY0FBTyxFQUFFLE1BQU0sRUFBRTtBQUFBLElBQ3ZELENBQUM7QUFHRCxVQUFNLEtBQUssK0VBQW1CLFlBQVk7QUFDeEMsWUFBTSxHQUFHLDhKQUE4SjtBQUN2SyxZQUFNLElBQUksTUFBTSxRQUFRLGNBQWM7QUFBQSw2REFDaUIsR0FBSztBQUM1RCxVQUFJLENBQUMsRUFBRSxDQUFDLEVBQUcsUUFBTztBQUNsQixZQUFNLFNBQVMscUJBQXFCLE1BQU07QUFDMUMsWUFBTSxLQUFLLE1BQU0sUUFBUSxlQUFlO0FBQUEscURBQ08sR0FBSztBQUNwRCxVQUFJLENBQUMsR0FBRyxDQUFDLEVBQUcsUUFBTztBQUNuQixZQUFNLEdBQUcsMEZBQTBGO0FBQ25HLGFBQU8sUUFBUSxZQUFZO0FBQUEsbURBQ2tCLEdBQUs7QUFBQSxJQUNwRCxDQUFDO0FBR0QsUUFBSSxRQUFRLElBQUksZ0NBQWdDLFFBQVE7QUFDdEQsWUFBTSxLQUFLLHFIQUFxQyxZQUFZO0FBQzFELGNBQU0sR0FBRywwR0FBMEc7QUFDbkgsY0FBTSxPQUFPLE1BQU0sUUFBUSxpQkFBaUI7QUFBQSw2REFDUyxHQUFLO0FBQzFELFlBQUksQ0FBQyxLQUFLLENBQUMsRUFBRyxRQUFPO0FBQ3JCLGNBQU0sR0FBRyw2TEFBeUs7QUFDbEwsY0FBTSxRQUFRLE1BQU0sUUFBUSxtQkFBbUI7QUFBQSxvRkFDNkIsR0FBSztBQUNqRixZQUFJLENBQUMsTUFBTSxDQUFDLEVBQUcsUUFBTztBQUN0QixjQUFNLEtBQUssZ0JBQWdCO0FBQzNCLGNBQU0sR0FBRywrS0FBcUs7QUFDOUssY0FBTSxTQUFTLE1BQU0sUUFBUSxpQkFBaUIsOEVBQThFLEdBQUs7QUFDakksY0FBTSxLQUFNLE1BQU0sR0FBRyxxRUFBcUU7QUFDMUYsY0FBTSxJQUFJLEtBQUssTUFBTSxFQUFFO0FBQ3ZCLGNBQU0sWUFBWSxFQUFFLFdBQVcsU0FBUyxRQUFRLEVBQUUsV0FBVyxXQUFXO0FBQ3hFLGVBQU8sQ0FBQyxPQUFPLENBQUMsS0FBSyxXQUFXLFVBQVUsT0FBTyxDQUFDLENBQUMsY0FBYyxLQUFLLFVBQVUsRUFBRSxhQUFhLElBQUksQ0FBQyxFQUFFO0FBQUEsTUFDeEcsQ0FBQztBQU1ELFlBQU0sS0FBSywrS0FBK0MsWUFBWTtBQUNwRSxnQkFBUSxJQUFJLHlDQUF5QztBQUNyRCxjQUFNLFFBQVEsSUFBSSxRQUFRO0FBQzFCLGNBQU0sS0FBSyxNQUFNLENBQUMsS0FBSztBQUN2QixjQUFNLEtBQUssTUFBTSxDQUFDLEtBQUs7QUFDdkIsWUFBSTtBQUNGLGdCQUFNLEdBQUcsMEdBQTBHO0FBQ25ILGdCQUFNLE9BQU8sTUFBTSxRQUFRLGlCQUFpQixvR0FBb0csR0FBSztBQUNySixjQUFJLENBQUMsS0FBSyxDQUFDLEVBQUcsUUFBTztBQUNyQixnQkFBTSxHQUFHLDZMQUF5SztBQUNsTCxnQkFBTSxRQUFRLE1BQU0sUUFBUSxtQkFBbUIsb0lBQW9JLEdBQUs7QUFDeEwsY0FBSSxDQUFDLE1BQU0sQ0FBQyxFQUFHLFFBQU87QUFDdEIsZ0JBQU0sR0FBRywyTEFBdUs7QUFDaEwsZ0JBQU0sYUFBYSxNQUFNLFFBQVEsZ0NBQWdDO0FBQUE7QUFBQSxrRUFFVCxJQUFNO0FBQzlELGNBQUksQ0FBQyxXQUFXLENBQUMsRUFBRyxRQUFPO0FBRTNCLGdCQUFNLEdBQUcsK0xBQWlLO0FBQzFLLGdCQUFNLGFBQWEsTUFBTSxRQUFRLGdDQUFnQztBQUFBLHFIQUMwQyxHQUFLO0FBQ2hILGNBQUksQ0FBQyxXQUFXLENBQUMsRUFBRyxRQUFPLENBQUMsT0FBTyx1RUFBZ0IsV0FBVyxDQUFDLENBQUMsRUFBRTtBQUVsRSxjQUFJLFFBQVEsS0FBSyxHQUFHO0FBQ3BCLGdCQUFNLE1BQU0sR0FBRztBQUNmLGdCQUFNLElBQUssTUFBTSxHQUFHO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsZUFnQmY7QUFDTCxnQkFBTSxJQUFJLEtBQUssTUFBTSxDQUFDO0FBQ3RCLGdCQUFNLEtBQUssMEJBQTBCO0FBQ3JDLGdCQUFNLFdBQVcsRUFBRSxTQUFTLEtBQUssRUFBRSxNQUFNLE9BQU8sRUFBRSxPQUFPLE1BQU0sT0FBTyxLQUFLLEVBQUUsUUFBUSxNQUFNLE9BQU8sS0FBSyxFQUFFLFVBQVUsRUFBRSxNQUFNLE1BQU0sT0FBTztBQUV4SSxnQkFBTSxHQUFHLHVNQUF5SztBQUNsTCxnQkFBTSxNQUFNLE1BQU0sUUFBUSxpQ0FBaUM7QUFBQSx3RUFDRyxHQUFLO0FBQ25FLGdCQUFNLEdBQUcsK0tBQXFLO0FBQzlLLGdCQUFNLGVBQWUsTUFBTSxRQUFRLDBCQUEwQiw4RUFBOEUsR0FBSztBQUNoSixpQkFBTztBQUFBLFlBQUMsWUFBWSxJQUFJLENBQUMsS0FBSyxhQUFhLENBQUM7QUFBQSxZQUMxQyxNQUFNLEVBQUUsRUFBRSxJQUFJLEVBQUUsRUFBRSxTQUFTLEVBQUUsSUFBSSxZQUFZLEVBQUUsT0FBTyxLQUFLLEdBQUcsQ0FBQyxjQUFjLEVBQUUsUUFBUSxLQUFLLEdBQUcsQ0FBQyx3QkFBUyxFQUFFLE1BQU0sWUFBWSxFQUFFLE1BQU0sS0FBSyxHQUFHLENBQUMsZ0NBQVksSUFBSSxDQUFDLENBQUMsK0JBQVcsYUFBYSxDQUFDLENBQUM7QUFBQSxVQUFFO0FBQUEsUUFDaE0sVUFBRTtBQUNBLGNBQUksUUFBUSxJQUFJLEVBQUU7QUFDbEIsa0JBQVEsSUFBSSx5Q0FBeUM7QUFBQSxRQUN2RDtBQUFBLE1BQ0YsQ0FBQztBQUFBLElBQ0g7QUFFQSxVQUFNLEtBQUssT0FBTztBQUFBLEVBQ3BCLFlBQVksUUFBUSxJQUFJLCtCQUErQixRQUFRLElBQUk7QUFHakUsUUFBSSxRQUFRLElBQUksZ0NBQWdDLFVBQVU7QUFDeEQsWUFBTSxLQUFLLGtKQUFvQyxZQUFZO0FBQ3pELGNBQU0sSUFBSSxNQUFNLFFBQVEsa0JBQWtCO0FBQUE7QUFBQSxvR0FFOEIsSUFBTTtBQUM5RSxZQUFJLENBQUMsRUFBRSxDQUFDLEVBQUcsUUFBTztBQUNsQixjQUFNLEtBQUsscUJBQXFCO0FBQ2hDLGNBQU0sR0FBRywyTEFBdUs7QUFDaEwsY0FBTSxRQUFRLE1BQU0sUUFBUSxnQkFBZ0I7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsd0ZBTW9DLEdBQU07QUFDdEYsY0FBTSxLQUFLLG9CQUFvQjtBQUMvQixlQUFPO0FBQUEsTUFDVCxDQUFDO0FBQUEsSUFDSCxXQUFXLFFBQVEsSUFBSSxnQ0FBZ0MsV0FBVztBQUNoRSxZQUFNLEtBQUssaUpBQThCLFlBQVk7QUFDbkQsY0FBTSxJQUFJLE1BQU0sUUFBUSxrQkFBa0I7QUFBQSw2REFDVyxJQUFNO0FBQzNELFlBQUksQ0FBQyxFQUFFLENBQUMsRUFBRyxRQUFPO0FBQ2xCLGNBQU0sR0FBRywyTEFBdUs7QUFDaEwsY0FBTSxRQUFRLE1BQU0sUUFBUSxnQkFBZ0I7QUFBQSw2TEFDMkcsR0FBTTtBQUM3SixZQUFJLENBQUMsTUFBTSxDQUFDLEVBQUcsUUFBTztBQUN0QixjQUFNLEdBQUcsK0xBQWlLO0FBQzFLLGNBQU0sTUFBTSxHQUFHO0FBQ2YsY0FBTSxHQUFHLHFMQUFzSztBQUMvSyxjQUFNLE1BQU0sTUFBTSxRQUFRLHlCQUFvQjtBQUFBO0FBQUEsaUtBRXdFLEdBQUs7QUFDM0gsWUFBSSxDQUFDLElBQUksQ0FBQyxFQUFHLFFBQU87QUFDcEIsY0FBTSxHQUFHLDJMQUF1SztBQUNoTCxlQUFPLFFBQVEsZ0JBQWdCO0FBQUEsc0VBQytCLEdBQUs7QUFBQSxNQUNyRSxDQUFDO0FBQ0QsWUFBTSxLQUFLLHdJQUErQixZQUFZO0FBQ3BELGNBQU0sSUFBSSxNQUFNLFFBQVEsb0JBQW9CO0FBQUE7QUFBQTtBQUFBLCtLQUcySCxHQUFNO0FBQzdLLGNBQU0sS0FBSyxxQkFBcUI7QUFDaEMsZUFBTztBQUFBLE1BQ1QsQ0FBQztBQUNELFlBQU0sS0FBSyxzTUFBZ0QsWUFBWTtBQUVyRSxjQUFNLFFBQVEsYUFBYTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSwwREFNa0IsSUFBSSxHQUFNO0FBQ3ZELGNBQU0sSUFBSSxNQUFNLFFBQVEsbUJBQW1CO0FBQUE7QUFBQSwwR0FFNkMsR0FBTTtBQUM5RixZQUFJLENBQUMsRUFBRSxDQUFDLEVBQUcsUUFBTztBQUNsQixjQUFNLEtBQUssa0JBQWtCO0FBQzdCLGNBQU0sR0FBRywyTEFBdUs7QUFDaEwsY0FBTSxZQUFZLE1BQU0sUUFBUSx5QkFBeUI7QUFBQTtBQUFBLG1MQUVrSCxHQUFNO0FBQ2pMLGNBQU0sS0FBTSxNQUFNLEdBQUcsNkdBQTZHO0FBQ2xJLGNBQU0sSUFBSSxLQUFLLE1BQU0sRUFBRTtBQUN2QixjQUFNLFdBQVcsRUFBRSxnQkFBZ0IsSUFBSSxRQUFRLG1CQUFtQixLQUFLO0FBQ3ZFLGNBQU0sS0FBSyxtQkFBbUI7QUFDOUIsZUFBTyxDQUFDLFVBQVUsQ0FBQyxLQUFLLFNBQVMsY0FBYyxVQUFVLENBQUMsQ0FBQyxXQUFXLEdBQUcsTUFBTSxHQUFHLEVBQUUsQ0FBQyxFQUFFO0FBQUEsTUFDekYsQ0FBQztBQUFBLElBQ0g7QUFDQSxVQUFNLEtBQUssT0FBTztBQUFBLEVBQ3BCLE9BQU87QUFFTCxVQUFNLEtBQUssbUZBQTRCLFlBQVk7QUFDakQsYUFBTyxRQUFRLGNBQWM7QUFBQTtBQUFBLG9IQUVpRixJQUFNO0FBQUEsSUFDdEgsQ0FBQztBQUNELFVBQU0sS0FBSyxpRkFBcUIsWUFBWTtBQUMxQyxhQUFPLFFBQVEsWUFBWTtBQUFBLHFEQUNvQixJQUFNO0FBQUEsSUFDdkQsQ0FBQztBQUNELFVBQU0sS0FBSyxnR0FBK0IsWUFBWTtBQUNwRCxZQUFNLElBQUssTUFBTSxHQUFHLG1EQUFtRDtBQUN2RSxVQUFJLE1BQU0sRUFBRyxRQUFPLENBQUMsT0FBTyxzQkFBc0I7QUFDbEQsWUFBTSxHQUFHLHVGQUF1RjtBQUNoRyxZQUFNLElBQUksTUFBTSxRQUFRLGlCQUFpQjtBQUFBLCtJQUNnRyxJQUFNO0FBQy9JLFlBQU0sS0FBSyxjQUFjO0FBQ3pCLGFBQU87QUFBQSxJQUNULENBQUM7QUFDRCxVQUFNLEtBQUssd0ZBQXNDLFlBQVk7QUFDM0QsWUFBTSxHQUFHLHVKQUF1SjtBQUNoSyxhQUFPLFFBQVEsWUFBWTtBQUFBO0FBQUEsa0tBRWtILEdBQU07QUFBQSxJQUNySixDQUFDO0FBQ0QsVUFBTSxLQUFLLHFFQUE2QixZQUFZO0FBQ2xELFlBQU0sR0FBRyxtTEFBeUs7QUFDbEwsYUFBTyxRQUFRLFFBQVE7QUFBQTtBQUFBLCtHQUVtRSxJQUFNO0FBQUEsSUFDbEcsQ0FBQztBQUNELFVBQU0sS0FBSyxzREFBd0IsWUFBWTtBQUM3QyxZQUFNLEdBQUcsdUxBQTZLO0FBQ3RMLGFBQU8sUUFBUSxZQUFZO0FBQUE7QUFBQSxrSkFFNEcsSUFBTTtBQUFBLElBQy9JLENBQUM7QUFDRCxVQUFNLEtBQUssOElBQXNDLFlBQVk7QUFDM0QsWUFBTSxHQUFHLG9MQUEwSztBQUNuTCxZQUFNLFFBQVEsYUFBYTtBQUFBLHFJQUMwRixHQUFLO0FBRTFILFlBQU0sS0FBSyxNQUFNLFFBQVEsYUFBYTtBQUFBLGdGQUNvQyxTQUFTLFNBQVMsT0FBUyxHQUFLO0FBQzFHLFlBQU0sSUFBSyxNQUFNLEdBQUc7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLFdBS2Y7QUFDTCxZQUFNLElBQUksS0FBSyxNQUFNLENBQUM7QUFDdEIsYUFBTyxDQUFDLEVBQUUsTUFBTSxFQUFFLFFBQVEsRUFBRSxRQUFRLGFBQU0sRUFBRSxFQUFFLGNBQVMsRUFBRSxJQUFJLGNBQU8sRUFBRSxNQUFNLEtBQUssR0FBRyxDQUFDLENBQUMsRUFBRTtBQUFBLElBQzFGLENBQUM7QUFJRCxRQUFJLFFBQVEsSUFBSSxtQ0FBbUMsS0FBSztBQUN0RCxZQUFNLEtBQUssdUdBQXVCLFlBQVk7QUFDNUMsY0FBTSxHQUFHLDJGQUEyRjtBQUNwRyxjQUFNLE1BQU0sR0FBRztBQUNmLGNBQU0sU0FBUyxzQkFBc0IseUtBQWtDO0FBQ3ZFLGNBQU0sTUFBTSxHQUFHO0FBQ2YsY0FBTSxHQUFHLHlLQUErSjtBQUN4SyxjQUFNLE9BQU8sTUFBTSxRQUFRLGFBQWE7QUFBQTtBQUFBLG9JQUVzRCxHQUFNO0FBQ3BHLFlBQUksQ0FBQyxLQUFLLENBQUMsRUFBRyxRQUFPO0FBQ3JCLGNBQU0sUUFBUSxNQUFNLFFBQVEsbUJBQW1CO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLFdBTTVDLElBQU87QUFDVixjQUFNLEtBQUssV0FBVztBQUN0QixlQUFPO0FBQUEsTUFDVCxDQUFDO0FBQUEsSUFDSDtBQUNBLFVBQU0sS0FBSyx1R0FBdUIsWUFBWTtBQUM1QyxhQUFPLFFBQVEsY0FBYztBQUFBO0FBQUEsK0RBRTRCLElBQU07QUFBQSxJQUNqRSxDQUFDO0FBQ0QsVUFBTSxLQUFLLDZHQUF3QixZQUFZO0FBQzdDLGFBQU8sUUFBUSxpQkFBaUI7QUFBQTtBQUFBLG1JQUVtRixJQUFNO0FBQUEsSUFDM0gsQ0FBQztBQUNELFVBQU0sS0FBSyxPQUFPO0FBQUEsRUFDcEI7QUFFQSxRQUFNLFNBQVMsUUFBUSxPQUFPLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxDQUFDLEVBQUU7QUFDNUMsVUFBUSxJQUFJLHlCQUF5QixRQUFRLFNBQVMsTUFBTSxJQUFJLFFBQVEsTUFBTSxTQUFTLElBQUksVUFBVSxLQUFLLEVBQUU7QUFDNUcsTUFBSSxLQUFLLFdBQVcsSUFBSSxJQUFJLENBQUM7QUFDL0I7QUFFTyxTQUFTLGVBQWUsS0FBMEI7QUFDdkQsUUFBTSxPQUFPLFFBQVEsSUFBSSw4QkFBOEIsU0FBUyxTQUFTO0FBQ3pFLE1BQUksWUFBWSxLQUFLLG1CQUFtQixNQUFNO0FBRTVDLGVBQVcsTUFBTTtBQUFFLFdBQUssWUFBWSxLQUFLLElBQUk7QUFBQSxJQUFHLEdBQUcsR0FBSztBQUFBLEVBQzFELENBQUM7QUFDSDs7O0FDanVCQSxTQUFTLFNBQUFDLGNBQWE7QUFDdEIsU0FBUyxZQUFZLFdBQVcsUUFBUSxZQUFZLHFCQUFxQjtBQUN6RSxTQUFTLGVBQWU7QUFDeEIsU0FBUyxRQUFBQyxhQUFZOzs7QUNOckIsU0FBUyxrQkFBa0I7QUF5QnBCLFNBQVMsVUFBVSxHQUFXLEdBQW1CO0FBQ3RELFFBQU0sS0FBSyxFQUFFLFFBQVEsTUFBTSxFQUFFLEVBQUUsTUFBTSxHQUFHLEVBQUUsQ0FBQyxFQUFHLE1BQU0sR0FBRyxFQUFFLElBQUksTUFBTTtBQUNuRSxRQUFNLEtBQUssRUFBRSxRQUFRLE1BQU0sRUFBRSxFQUFFLE1BQU0sR0FBRyxFQUFFLENBQUMsRUFBRyxNQUFNLEdBQUcsRUFBRSxJQUFJLE1BQU07QUFDbkUsV0FBUyxJQUFJLEdBQUcsSUFBSSxHQUFHLEtBQUs7QUFDMUIsVUFBTSxJQUFJLEdBQUcsQ0FBQyxLQUFLO0FBQ25CLFVBQU0sSUFBSSxHQUFHLENBQUMsS0FBSztBQUNuQixRQUFJLE1BQU0sRUFBRyxRQUFPLElBQUksSUFBSSxLQUFLO0FBQUEsRUFDbkM7QUFDQSxTQUFPO0FBQ1Q7QUFHTyxTQUFTLFVBQVUsT0FBZSxTQUEwQjtBQUNqRSxRQUFNLElBQUksTUFBTSxLQUFLO0FBQ3JCLE1BQUksTUFBTSxNQUFNLE1BQU0sT0FBTyxNQUFNLFlBQVksTUFBTSxJQUFLLFFBQU87QUFDakUsTUFBSSxNQUFNLFFBQVMsUUFBTztBQUMxQixRQUFNLFFBQVEsb0NBQW9DLEtBQUssQ0FBQztBQUN4RCxNQUFJLFVBQVUsTUFBTTtBQUNsQixVQUFNLEtBQUssTUFBTSxDQUFDO0FBQ2xCLFVBQU0sUUFBUSxPQUFPLE1BQU0sQ0FBQyxDQUFDO0FBQzdCLFVBQU0sUUFBUSxPQUFPLE1BQU0sQ0FBQyxDQUFDO0FBQzdCLFVBQU0sUUFBUSxPQUFPLE1BQU0sQ0FBQyxDQUFDO0FBQzdCLFVBQU0sSUFBSSxVQUFVLFNBQVMsR0FBRyxLQUFLLElBQUksS0FBSyxJQUFJLEtBQUssRUFBRTtBQUN6RCxRQUFJLElBQUksRUFBRyxRQUFPO0FBQ2xCLFFBQUksT0FBTyxLQUFNLFFBQU87QUFDeEIsUUFBSSxPQUFPLElBQUssUUFBTyxVQUFVLFNBQVMsR0FBRyxLQUFLLElBQUksUUFBUSxDQUFDLElBQUksSUFBSTtBQUV2RSxRQUFJLFVBQVUsRUFBRyxRQUFPLFVBQVUsSUFBSSxVQUFVLFNBQVMsT0FBTyxRQUFRLENBQUMsRUFBRSxJQUFJLElBQUksVUFBVSxTQUFTLEtBQUssUUFBUSxDQUFDLElBQUksSUFBSTtBQUM1SCxXQUFPLFVBQVUsU0FBUyxHQUFHLFFBQVEsQ0FBQyxNQUFNLElBQUk7QUFBQSxFQUNsRDtBQUNBLFNBQU87QUFDVDtBQUdPLFNBQVMsWUFBWSxLQUFnQixNQUFzQjtBQUNoRSxRQUFNLElBQUksS0FBSyxLQUFLO0FBQ3BCLFFBQU0sTUFBTSxNQUFNLE1BQU0sTUFBTSxZQUFZLE1BQU0sTUFBTSxJQUFJLFdBQVcsR0FBRyxTQUFTO0FBQ2pGLE1BQUksUUFBUSxVQUFhLElBQUksU0FBUyxHQUFHLE1BQU0sT0FBVyxRQUFPO0FBQ2pFLE1BQUksSUFBSSxTQUFTLENBQUMsTUFBTSxPQUFXLFFBQU87QUFDMUMsTUFBSSxPQUFPO0FBQ1gsYUFBVyxLQUFLLE9BQU8sS0FBSyxJQUFJLFFBQVEsR0FBRztBQUN6QyxRQUFJLFVBQVUsR0FBRyxDQUFDLEtBQUssVUFBVSxHQUFHLElBQUksSUFBSSxFQUFHLFFBQU87QUFBQSxFQUN4RDtBQUNBLFNBQU87QUFDVDtBQVNBLGVBQXNCLGVBQ3BCLE1BQ0EsY0FDd0I7QUFDeEIsUUFBTSxXQUFXLG9CQUFJLElBQTRCO0FBQ2pELFFBQU0sUUFBK0MsQ0FBQyxJQUFJO0FBQzFELFNBQU8sTUFBTSxTQUFTLEdBQUc7QUFDdkIsVUFBTSxFQUFFLE1BQU0sS0FBSyxJQUFJLE1BQU0sTUFBTTtBQUNuQyxRQUFJLFNBQVMsSUFBSSxJQUFJLEVBQUc7QUFDeEIsVUFBTSxNQUFNLE1BQU0sYUFBYSxJQUFJO0FBQ25DLFVBQU0sVUFBVSxZQUFZLEtBQUssSUFBSTtBQUNyQyxVQUFNLE9BQU8sWUFBWSxLQUFLLElBQUksU0FBUyxPQUFPLElBQUk7QUFDdEQsUUFBSSxTQUFTLFVBQWEsS0FBSyxNQUFNLFlBQVksUUFBVztBQUMxRCxZQUFNLElBQUksTUFBTSxpQkFBaUIsSUFBSSxjQUFjLFFBQVEsUUFBUSxFQUFFO0FBQUEsSUFDdkU7QUFDQSxVQUFNLE9BQXVCO0FBQUEsTUFDM0I7QUFBQSxNQUNBLGNBQWMsS0FBSyxnQkFBZ0IsQ0FBQztBQUFBLE1BQ3BDLFNBQVMsS0FBSyxLQUFLO0FBQUEsTUFDbkIsV0FBVyxLQUFLLEtBQUs7QUFBQSxJQUN2QjtBQUNBLGFBQVMsSUFBSSxNQUFNLElBQUk7QUFDdkIsZUFBVyxDQUFDLEtBQUssS0FBSyxLQUFLLE9BQU8sUUFBUSxLQUFLLFlBQVksR0FBRztBQUM1RCxVQUFJLENBQUMsU0FBUyxJQUFJLEdBQUcsRUFBRyxPQUFNLEtBQUssRUFBRSxNQUFNLEtBQUssTUFBTSxNQUFNLENBQUM7QUFBQSxJQUMvRDtBQUFBLEVBQ0Y7QUFDQSxTQUFPLENBQUMsR0FBRyxTQUFTLFFBQVEsQ0FBQyxFQUFFLElBQUksQ0FBQyxDQUFDLE1BQU0sQ0FBQyxPQUFPLEVBQUUsTUFBTSxTQUFTLEVBQUUsU0FBUyxTQUFTLEVBQUUsU0FBUyxXQUFXLEVBQUUsVUFBVSxFQUFFO0FBQzlIO0FBSUEsSUFBTSxpQkFBaUI7QUFPaEIsU0FBUyxlQUFlLFNBQWlCLFlBQWdDO0FBQzlFLFFBQU0sSUFBSSxlQUFlLEtBQUssT0FBTztBQUNyQyxRQUFNLE9BQU8sSUFBSSxDQUFDLEtBQUs7QUFDdkIsUUFBTSxNQUFNLENBQUMsT0FBTztBQUNwQixhQUFXLE9BQU8sWUFBWTtBQUM1QixVQUFNLE9BQU8sSUFBSSxRQUFRLFFBQVEsRUFBRTtBQUNuQyxRQUFJLFNBQVMsSUFBSSxDQUFDLEVBQUc7QUFDckIsVUFBTSxJQUFJLEdBQUcsSUFBSSxJQUFJLElBQUk7QUFDekIsUUFBSSxDQUFDLElBQUksU0FBUyxDQUFDLEVBQUcsS0FBSSxLQUFLLENBQUM7QUFBQSxFQUNsQztBQUNBLFNBQU87QUFDVDtBQUdPLFNBQVMsVUFBVSxRQUFnQixNQUFzQjtBQUM5RCxRQUFNLFFBQVEsS0FBSyxNQUFNLEdBQUcsRUFBRSxPQUFPLENBQUMsTUFBTSxNQUFNLE1BQU0sTUFBTSxHQUFHO0FBQ2pFLE1BQUksS0FBSyxXQUFXLEdBQUcsS0FBSyxNQUFNLFdBQVcsRUFBRyxPQUFNLElBQUksTUFBTSx5QkFBeUIsSUFBSSxFQUFFO0FBQy9GLE1BQUksQ0FBQyxLQUFLLFdBQVcsR0FBRyxLQUFLLE1BQU0sV0FBVyxFQUFHLE9BQU0sSUFBSSxNQUFNLHlCQUF5QixJQUFJLEVBQUU7QUFDaEcsU0FBTyxDQUFDLEdBQUcsS0FBSyxFQUFFLE9BQU8sQ0FBQyxLQUFLLE1BQU0sR0FBRyxHQUFHLEtBQUssQ0FBQyxJQUFJLEdBQUcsTUFBTSxnQkFBZ0I7QUFDaEY7QUFLTyxTQUFTLFlBQVksTUFBYyxXQUE2QjtBQUNyRSxNQUFJLGNBQWMsVUFBYSxjQUFjLEdBQUksUUFBTztBQUN4RCxRQUFNLElBQUksNkJBQTZCLEtBQUssVUFBVSxLQUFLLENBQUM7QUFDNUQsTUFBSSxNQUFNLEtBQU0sUUFBTztBQUN2QixTQUFPLFdBQVcsUUFBUSxFQUFFLE9BQU8sSUFBSSxFQUFFLE9BQU8sUUFBUSxNQUFNLEVBQUUsQ0FBQztBQUNuRTtBQUdPLFNBQVMsV0FBVyxHQUFtQjtBQUM1QyxNQUFJLElBQUksS0FBTSxRQUFPLEdBQUcsQ0FBQztBQUN6QixNQUFJLElBQUksT0FBTyxLQUFNLFFBQU8sSUFBSSxJQUFJLE1BQU0sUUFBUSxDQUFDLENBQUM7QUFDcEQsU0FBTyxJQUFJLElBQUksT0FBTyxNQUFNLFFBQVEsQ0FBQyxDQUFDO0FBQ3hDOzs7QUQvSE8sSUFBTSxhQUFvRDtBQUFBLEVBQy9ELE9BQU87QUFBQSxFQUNQLFdBQVc7QUFDYjtBQUdPLFNBQVMsZ0JBQXdCO0FBQ3RDLFNBQU9DLE1BQUssUUFBUSxHQUFHLG1CQUFtQjtBQUM1QztBQUdPLFNBQVMsc0JBQXNCLFFBQXdCO0FBQzVELFFBQU0sU0FBU0EsTUFBSyxRQUFRLGdCQUFnQixjQUFjLE9BQU8sZ0JBQWdCLGNBQWMsT0FBTyxRQUFRLGlCQUFpQjtBQUMvSCxRQUFNLFVBQVVBLE1BQUssUUFBUSxnQkFBZ0IsY0FBYyxPQUFPLFFBQVEsaUJBQWlCO0FBQzNGLE1BQUksV0FBVyxNQUFNLEVBQUcsUUFBTztBQUMvQixNQUFJLFdBQVcsT0FBTyxFQUFHLFFBQU87QUFDaEMsU0FBTztBQUNUO0FBU0EsSUFBSSxVQUFVO0FBT1AsU0FBUyxnQkFBZ0IsTUFBcUIsT0FBdUIsQ0FBQyxHQUFvQztBQUMvRyxNQUFJLFFBQVMsUUFBTyxFQUFFLElBQUksT0FBTyxPQUFPLDZDQUFVO0FBQ2xELFlBQVU7QUFDVixRQUFNLFNBQVMsQ0FBQyxNQUE2QjtBQUMzQyxTQUFLLGFBQWEsQ0FBQztBQUNuQixjQUFVO0FBQUEsRUFDWjtBQUNBLFFBQU0sT0FBTyxDQUFDLE1BQWMsUUFBdUI7QUFDakQsU0FBSyxJQUFJLG1CQUFtQixJQUFJLElBQUksT0FBTyxHQUFHLEVBQUUsTUFBTSxHQUFHLEdBQUcsQ0FBQyxFQUFFO0FBQy9ELFdBQU8sRUFBRSxPQUFPLFNBQVMsTUFBTSxPQUFPLEdBQUcsSUFBSSxJQUFJLE9BQU8sR0FBRyxFQUFFLE1BQU0sR0FBRyxHQUFHLENBQUMsR0FBRyxDQUFDO0FBQUEsRUFDaEY7QUFDQSxRQUFNLFlBQVk7QUFDaEIsVUFBTSxTQUFTLGNBQWM7QUFDN0IsUUFBSTtBQUNGLGdCQUFVLFFBQVEsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNyQyxZQUFNLFFBQVEsS0FBSyxhQUFhLE9BQU8sUUFBUSxNQUFNLFNBQVMsSUFBSTtBQUNsRSxVQUFJLE1BQU8sT0FBTSxjQUFjLE1BQU0sUUFBUSxJQUFJO0FBQUEsVUFDNUMsT0FBTSxtQkFBbUIsTUFBTSxRQUFRLElBQUk7QUFBQSxJQUNsRCxTQUFTLEtBQUs7QUFDWixXQUFLLDRCQUFRLEdBQUc7QUFBQSxJQUNsQjtBQUFBLEVBQ0YsR0FBRztBQUNILFNBQU8sRUFBRSxJQUFJLEtBQUs7QUFDcEI7QUFHQSxlQUFlLFNBQVMsTUFBdUM7QUFDN0QsT0FBSyxhQUFhLEVBQUUsT0FBTyxTQUFTLE1BQU0seUJBQVUsQ0FBQztBQUNyRCxRQUFNLEtBQUssTUFBTSxJQUFJLFFBQWlCLENBQUNDLGFBQVk7QUFDakQsVUFBTSxJQUFJQyxPQUFNLE9BQU8sQ0FBQyxXQUFXLEdBQUcsRUFBRSxhQUFhLE1BQU0sT0FBTyxTQUFTLENBQUM7QUFDNUUsVUFBTSxJQUFJLFdBQVcsTUFBTTtBQUFFLFVBQUk7QUFBRSxVQUFFLEtBQUs7QUFBQSxNQUFHLFFBQVE7QUFBQSxNQUFhO0FBQUUsTUFBQUQsU0FBUSxLQUFLO0FBQUEsSUFBRyxHQUFHLElBQU07QUFDN0YsTUFBRSxHQUFHLFNBQVMsTUFBTTtBQUFFLG1CQUFhLENBQUM7QUFBRyxNQUFBQSxTQUFRLEtBQUs7QUFBQSxJQUFHLENBQUM7QUFDeEQsTUFBRSxHQUFHLFFBQVEsQ0FBQyxTQUFTO0FBQUUsbUJBQWEsQ0FBQztBQUFHLE1BQUFBLFNBQVEsU0FBUyxDQUFDO0FBQUEsSUFBRyxDQUFDO0FBQUEsRUFDbEUsQ0FBQztBQUNELE9BQUssSUFBSSxPQUFPLEtBQUssY0FBYyxhQUFhLFdBQU0sS0FBSyxlQUFlLEtBQUssT0FBTztBQUN0RixTQUFPO0FBQ1Q7QUFHQSxlQUFlLGNBQWMsTUFBcUIsUUFBZ0IsTUFBcUM7QUFDckcsT0FBSyxhQUFhLEVBQUUsT0FBTyxPQUFPLE1BQU0scUNBQWdDLE1BQU0sbUNBQVUsQ0FBQztBQUN6RixRQUFNLFdBQVcsS0FBSyxnQkFBZ0IsY0FBYyxDQUFDLGNBQWMsV0FBVyxTQUFTLElBQUksS0FBSyxnQkFBZ0IsVUFBVSxDQUFDLGNBQWMsV0FBVyxLQUFLLElBQUksQ0FBQztBQUM5SixRQUFNLE9BQU8sQ0FBQyxXQUFXLFlBQVksUUFBUSxjQUFjLGFBQWEsY0FBYyxVQUFVLEdBQUcsVUFBVSx1QkFBdUI7QUFDcEksUUFBTSxPQUFPLE1BQU0sSUFBSSxRQUFnQixDQUFDQSxVQUFTLFdBQVc7QUFDMUQsVUFBTSxJQUFJQyxPQUFNLE9BQU8sTUFBTSxFQUFFLGFBQWEsTUFBTSxLQUFLLFFBQVEsRUFBRSxDQUFDO0FBQ2xFLFFBQUksT0FBTztBQUNYLFVBQU0sU0FBUyxDQUFDLE1BQW9CO0FBQ2xDLGlCQUFXLE9BQU8sRUFBRSxTQUFTLEVBQUUsTUFBTSxPQUFPLEdBQUc7QUFDN0MsY0FBTSxPQUFPLElBQUksUUFBUSxvQkFBb0IsRUFBRSxFQUFFLEtBQUssRUFBRSxNQUFNLEdBQUcsR0FBRztBQUNwRSxZQUFJLFNBQVMsTUFBTSxTQUFTLEtBQU07QUFDbEMsZUFBTztBQUNQLGFBQUssYUFBYSxFQUFFLE9BQU8sT0FBTyxNQUFNLEtBQUssQ0FBQztBQUFBLE1BQ2hEO0FBQUEsSUFDRjtBQUNBLE1BQUUsUUFBUSxHQUFHLFFBQVEsTUFBTTtBQUMzQixNQUFFLFFBQVEsR0FBRyxRQUFRLE1BQU07QUFDM0IsTUFBRSxHQUFHLFNBQVMsTUFBTTtBQUNwQixVQUFNLFNBQVMsV0FBVyxNQUFNO0FBQUUsVUFBSTtBQUFFLFVBQUUsS0FBSztBQUFBLE1BQUcsUUFBUTtBQUFBLE1BQWE7QUFBRSxhQUFPLElBQUksTUFBTSw4Q0FBZ0IsQ0FBQztBQUFBLElBQUcsR0FBRyxJQUFJLEdBQU07QUFDM0gsTUFBRSxHQUFHLFFBQVEsQ0FBQyxNQUFNO0FBQUUsbUJBQWEsTUFBTTtBQUFHLE1BQUFELFNBQVEsS0FBSyxDQUFDO0FBQUEsSUFBRyxDQUFDO0FBQUEsRUFDaEUsQ0FBQztBQUNELE1BQUksU0FBUyxFQUFHLE9BQU0sSUFBSSxNQUFNLGtDQUFtQixJQUFJLEVBQUU7QUFDekQsUUFBTSxRQUFRLHNCQUFzQixNQUFNO0FBQzFDLE1BQUksVUFBVSxHQUFJLE9BQU0sSUFBSSxNQUFNLGdGQUE4QjtBQUNoRSxhQUFXLFFBQVEsS0FBSztBQUN4QixnQkFBYyxNQUFNLE9BQU8sS0FBSztBQUNsQztBQUdBLGVBQWUsbUJBQW1CLE1BQXFCLFFBQWdCLE1BQXFDO0FBQzFHLFFBQU0sUUFBc0MsS0FBSyxnQkFBZ0IsY0FBYyxDQUFDLGFBQWEsT0FBTyxJQUFJLENBQUMsU0FBUyxXQUFXO0FBQzdILFFBQU0sVUFBVSxNQUFNLElBQUksQ0FBQyxNQUFNLFdBQVcsQ0FBQyxDQUFDO0FBQzlDLE9BQUssYUFBYSxFQUFFLE9BQU8sUUFBUSxNQUFNLDBFQUE2QixDQUFDO0FBRXZFLFFBQU0sYUFBYSxvQkFBSSxJQUF1QjtBQUM5QyxRQUFNLGVBQWUsT0FBTyxTQUFxQztBQUMvRCxVQUFNLE1BQU0sV0FBVyxJQUFJLElBQUk7QUFDL0IsUUFBSSxRQUFRLE9BQVcsUUFBTztBQUM5QixRQUFJLFVBQVU7QUFDZCxlQUFXLEtBQUssU0FBUztBQUN2QixVQUFJO0FBQ0YsY0FBTSxJQUFJLE1BQU0sTUFBTSxHQUFHLENBQUMsSUFBSSxtQkFBbUIsSUFBSSxDQUFDLElBQUk7QUFBQSxVQUN4RCxTQUFTLEVBQUUsUUFBUSxzQ0FBc0M7QUFBQSxVQUN6RCxRQUFRLFlBQVksUUFBUSxJQUFNO0FBQUEsUUFDcEMsQ0FBQztBQUNELFlBQUksQ0FBQyxFQUFFLElBQUk7QUFBRSxvQkFBVSxRQUFRLEVBQUUsTUFBTTtBQUFJO0FBQUEsUUFBVTtBQUNyRCxjQUFNLE1BQU8sTUFBTSxFQUFFLEtBQUs7QUFDMUIsWUFBSSxJQUFJLGFBQWEsUUFBVztBQUFFLG9CQUFVO0FBQXVCO0FBQUEsUUFBVTtBQUM3RSxtQkFBVyxJQUFJLE1BQU0sR0FBRztBQUN4QixlQUFPO0FBQUEsTUFDVCxTQUFTLEtBQUs7QUFBRSxrQkFBVSxPQUFPLEdBQUcsRUFBRSxNQUFNLEdBQUcsRUFBRTtBQUFBLE1BQUc7QUFBQSxJQUN0RDtBQUNBLFVBQU0sSUFBSSxNQUFNLGdCQUFNLElBQUksNERBQWUsT0FBTyxHQUFHO0FBQUEsRUFDckQ7QUFFQSxRQUFNLFVBQVUsTUFBTSxlQUFlLEVBQUUsTUFBTSxrQkFBa0IsTUFBTSxTQUFTLEdBQUcsWUFBWTtBQUM3RixRQUFNLE9BQU8sUUFBUSxLQUFLLENBQUMsTUFBTSxFQUFFLFNBQVMsZ0JBQWdCO0FBQzVELE9BQUssSUFBSSxZQUFZLFFBQVEsTUFBTSxrQ0FBa0MsTUFBTSxXQUFXLEdBQUcsR0FBRztBQUM1RixPQUFLLGFBQWEsRUFBRSxPQUFPLFFBQVEsTUFBTSx3Q0FBVSxRQUFRLE1BQU0sZ0NBQXNCLE1BQU0sV0FBVyxHQUFHLElBQUksQ0FBQztBQUVoSCxRQUFNLFVBQVVFLE1BQUssUUFBUSxVQUFVO0FBQ3ZDLFNBQU8sU0FBUyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUNoRCxZQUFVLFNBQVMsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUV0QyxXQUFTLElBQUksR0FBRyxJQUFJLFFBQVEsUUFBUSxLQUFLO0FBQ3ZDLFVBQU0sTUFBTSxRQUFRLENBQUM7QUFDckIsVUFBTSxPQUFPLGVBQWUsSUFBSSxTQUFTLE9BQU87QUFDaEQsUUFBSSxNQUFxQjtBQUN6QixRQUFJLGFBQWE7QUFDakIsUUFBSSxVQUFVO0FBQ2QsZUFBVyxLQUFLLE1BQU07QUFDcEIsVUFBSTtBQUNGLGNBQU0sSUFBSSxNQUFNLE1BQU0sR0FBRyxFQUFFLFFBQVEsWUFBWSxRQUFRLEdBQU8sRUFBRSxDQUFDO0FBQ2pFLFlBQUksQ0FBQyxFQUFFLElBQUk7QUFBRSxvQkFBVSxRQUFRLEVBQUUsTUFBTTtBQUFJO0FBQUEsUUFBVTtBQUNyRCxjQUFNLFFBQVEsT0FBTyxFQUFFLFFBQVEsSUFBSSxnQkFBZ0IsS0FBSyxHQUFHO0FBQzNELGNBQU0sU0FBUyxFQUFFLE1BQU0sVUFBVTtBQUNqQyxZQUFJLFdBQVcsT0FBVyxPQUFNLElBQUksTUFBTSxTQUFTO0FBQ25ELGNBQU0sU0FBbUIsQ0FBQztBQUMxQixZQUFJLE1BQU07QUFDVixZQUFJLFdBQVc7QUFDZixtQkFBUztBQUNQLGdCQUFNLEVBQUUsTUFBTSxNQUFNLElBQUksTUFBTSxPQUFPLEtBQUs7QUFDMUMsY0FBSSxTQUFTLEtBQU07QUFDbkIsZ0JBQU0sSUFBSSxPQUFPLEtBQUssS0FBSztBQUMzQixpQkFBTyxLQUFLLENBQUM7QUFDYixpQkFBTyxFQUFFO0FBQ1QsY0FBSSxNQUFNLFdBQVcsTUFBTSxNQUFNO0FBQy9CLHVCQUFXO0FBQ1gsaUJBQUssYUFBYTtBQUFBLGNBQ2hCLE9BQU87QUFBQSxjQUNQLEtBQUssS0FBSyxPQUFRLElBQUksS0FBSyxJQUFJLE9BQU8sU0FBUyxNQUFNLENBQUMsS0FBSyxRQUFRLFNBQVUsR0FBRztBQUFBLGNBQ2hGLE1BQU0sZ0JBQU0sSUFBSSxJQUFJLElBQUksSUFBSSxPQUFPLElBQUksSUFBSSxDQUFDLElBQUksUUFBUSxNQUFNLFNBQU0sV0FBVyxHQUFHLENBQUMsR0FBRyxRQUFRLElBQUksTUFBTSxXQUFXLEtBQUssQ0FBQyxLQUFLLEVBQUU7QUFBQSxjQUNoSSxRQUFRLElBQUksSUFBSSxDQUFDLEVBQUU7QUFBQSxZQUNyQixDQUFDO0FBQUEsVUFDSDtBQUFBLFFBQ0Y7QUFDQSxjQUFNLE9BQU8sT0FBTyxNQUFNO0FBQzFCLFlBQUksQ0FBQyxZQUFZLEtBQUssSUFBSSxTQUFTLEdBQUc7QUFBRSxvQkFBVTtBQUFpQixnQkFBTTtBQUFNO0FBQUEsUUFBVTtBQUN6RixxQkFBYSxJQUFJLElBQUksQ0FBQyxFQUFFO0FBQ3hCO0FBQUEsTUFDRixTQUFTLEtBQUs7QUFDWixrQkFBVSxPQUFPLEdBQUcsRUFBRSxNQUFNLEdBQUcsRUFBRTtBQUFBLE1BQ25DO0FBQUEsSUFDRjtBQUNBLFFBQUksUUFBUSxLQUFNLE9BQU0sSUFBSSxNQUFNLGdCQUFNLElBQUksSUFBSSwwQ0FBWSxPQUFPLEdBQUc7QUFDdEUsVUFBTSxNQUFNQSxNQUFLLFNBQVMsR0FBRyxDQUFDLE1BQU07QUFDcEMsa0JBQWMsS0FBSyxHQUFHO0FBQ3RCLFNBQUssYUFBYTtBQUFBLE1BQ2hCLE9BQU87QUFBQSxNQUNQLEtBQUssS0FBSyxPQUFRLElBQUksS0FBSyxRQUFRLFNBQVUsR0FBRztBQUFBLE1BQ2hELE1BQU0sZ0JBQU0sSUFBSSxJQUFJLElBQUksSUFBSSxPQUFPLGlCQUFPLFdBQVcsSUFBSSxNQUFNLENBQUMsUUFBUSxVQUFVO0FBQUEsTUFDbEYsUUFBUTtBQUFBLElBQ1YsQ0FBQztBQUFBLEVBQ0g7QUFFQSxPQUFLLGFBQWEsRUFBRSxPQUFPLFdBQVcsTUFBTSxvREFBc0IsQ0FBQztBQUNuRSxXQUFTLElBQUksR0FBRyxJQUFJLFFBQVEsUUFBUSxLQUFLO0FBQ3ZDLFVBQU0sTUFBTSxRQUFRLENBQUM7QUFDckIsVUFBTSxXQUFXQSxNQUFLLFNBQVMsR0FBRyxDQUFDLE1BQU0sR0FBRyxTQUFTLEdBQUc7QUFDeEQsU0FBSyxhQUFhLEVBQUUsT0FBTyxXQUFXLEtBQUssS0FBSyxPQUFRLElBQUksS0FBSyxRQUFRLFNBQVUsR0FBRyxHQUFHLE1BQU0sZ0JBQU0sSUFBSSxJQUFJLElBQUksSUFBSSxDQUFDLElBQUksUUFBUSxNQUFNLElBQUksQ0FBQztBQUFBLEVBQy9JO0FBQ0EsU0FBTyxTQUFTLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBRWhELFFBQU0sUUFBUSxzQkFBc0IsTUFBTTtBQUMxQyxNQUFJLFVBQVUsR0FBSSxPQUFNLElBQUksTUFBTSxnRkFBOEI7QUFDaEUsYUFBVyxRQUFRLEtBQUs7QUFDeEIsZ0JBQWMsTUFBTSxPQUFPLEtBQUs7QUFDbEM7QUFHQSxlQUFlLFdBQVcsS0FBYSxTQUFpQixLQUFpQztBQUN2RixRQUFNLFFBQVFBLE1BQUssU0FBUyxLQUFLLElBQUksS0FBSyxRQUFRLFlBQVksR0FBRyxDQUFDLEVBQUU7QUFDcEUsU0FBTyxPQUFPLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQzlDLFlBQVUsT0FBTyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ3BDLFFBQU0sT0FBTyxNQUFNLElBQUksUUFBZ0IsQ0FBQ0YsVUFBUyxXQUFXO0FBQzFELFVBQU0sSUFBSUMsT0FBTSxPQUFPLENBQUMsUUFBUSxLQUFLLE1BQU0sS0FBSyxHQUFHLEVBQUUsYUFBYSxNQUFNLE9BQU8sU0FBUyxDQUFDO0FBQ3pGLE1BQUUsR0FBRyxTQUFTLE1BQU07QUFDcEIsTUFBRSxHQUFHLFFBQVEsQ0FBQyxNQUFNRCxTQUFRLEtBQUssQ0FBQyxDQUFDO0FBQUEsRUFDckMsQ0FBQztBQUNELE1BQUksU0FBUyxFQUFHLE9BQU0sSUFBSSxNQUFNLG9CQUFVLElBQUksSUFBSSxvQ0FBVyxJQUFJLEdBQUc7QUFDcEUsUUFBTSxPQUFPLFVBQVUsY0FBYyxHQUFHLElBQUksSUFBSTtBQUNoRCxRQUFNLFNBQVMsS0FBSyxNQUFNLEdBQUcsS0FBSyxZQUFZLElBQUksQ0FBQztBQUNuRCxZQUFVLFFBQVEsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNyQyxTQUFPLE1BQU0sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFDN0MsYUFBV0UsTUFBSyxPQUFPLFNBQVMsR0FBRyxJQUFJO0FBQ3ZDLFNBQU8sT0FBTyxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUNoRDtBQUdBLFNBQVMsV0FBVyxRQUFnQixLQUEwQjtBQUM1RCxNQUFJO0FBQ0Ysa0JBQWNBLE1BQUssUUFBUSwrQkFBK0IsR0FBRyxLQUFLLFVBQVUsRUFBRSxLQUFLLEtBQUksb0JBQUksS0FBSyxHQUFFLFlBQVksRUFBRSxHQUFHLE1BQU0sQ0FBQyxHQUFHLE1BQU07QUFBQSxFQUNySSxRQUFRO0FBQUEsRUFBb0I7QUFDOUI7QUFFQSxTQUFTLGNBQWMsTUFBcUIsT0FBZSxLQUEwQjtBQUNuRixPQUFLLElBQUksb0JBQW9CLEdBQUcsS0FBSyxLQUFLLEVBQUU7QUFDNUMsT0FBSyxhQUFhLEVBQUUsT0FBTyxRQUFRLE1BQU0sNEJBQVEsR0FBRyxLQUFLLE1BQU0sQ0FBQztBQUNoRSxPQUFLLFlBQVksT0FBTyxHQUFHO0FBQzNCLFlBQVU7QUFDWjs7O0FSbFBBLElBQU0sT0FBTyxZQUFZLFdBQVc7QUFDcEMsSUFBTSxRQUFRLFFBQVEsSUFBSSxvQkFBb0I7QUFDOUMsSUFBTSxpQkFBaUIsUUFBUSxJQUFJLDRCQUE0QjtBQUMvRCxJQUFNLGNBQWNDLE1BQUssTUFBTSxzQkFBc0I7QUFHckQsSUFBTSxVQUFvQixDQUFDO0FBQzNCLFNBQVMsT0FBTyxHQUFtQjtBQUNqQyxNQUFJLE1BQU07QUFDVixhQUFXLE9BQU8sU0FBUztBQUN6QixRQUFJLElBQUksVUFBVSxFQUFHLE9BQU0sSUFBSSxNQUFNLEdBQUcsRUFBRSxLQUFLLFlBQVk7QUFBQSxFQUM3RDtBQUNBLFNBQU87QUFDVDtBQUNBLFNBQVMsUUFBUSxLQUFhLEtBQW1CO0FBQy9DLFVBQVEsSUFBSSxnQkFBZ0IsR0FBRyxLQUFLLE9BQU8sR0FBRyxDQUFDLEVBQUU7QUFDbkQ7QUFHQSxJQUFJLENBQUNDLEtBQUksMEJBQTBCLEdBQUc7QUFDcEMsRUFBQUEsS0FBSSxLQUFLO0FBQ1gsT0FBTztBQTZCTCxNQUFTQyxhQUFULFNBQW1CLEtBQTBCO0FBQzNDLGdCQUFZLEtBQUssR0FBRztBQUNwQixRQUFJLFlBQVksU0FBUyxJQUFPLGFBQVksT0FBTyxHQUFHLFlBQVksU0FBUyxHQUFLO0FBQ2hGLFFBQUksZUFBZSxNQUFNO0FBQ3ZCLG1CQUFhLFdBQVcsTUFBTTtBQUM1QixxQkFBYTtBQUNiLGNBQU0sUUFBUTtBQUNkLHNCQUFjLENBQUM7QUFDZixtQkFBVyxLQUFLLGNBQWMsY0FBYyxHQUFHO0FBQzdDLGNBQUksQ0FBQyxFQUFFLFlBQVksRUFBRyxHQUFFLFlBQVksS0FBSyxzQkFBc0IsS0FBSztBQUFBLFFBQ3RFO0FBQUEsTUFDRixHQUFHLEVBQUU7QUFBQSxJQUNQO0FBQ0EsSUFBQUMsYUFBWSxHQUFHO0FBQUEsRUFDakIsR0FXU0MsbUJBQVQsV0FBaUM7QUFDL0IsVUFBTSxNQUFNLGNBQWMsY0FBYyxFQUFFLEtBQUssQ0FBQyxNQUFNLENBQUMsRUFBRSxZQUFZLENBQUM7QUFDdEUsUUFBSSxRQUFRLE9BQVc7QUFDdkIsUUFBSSxJQUFJLFlBQVksRUFBRyxLQUFJLFFBQVE7QUFDbkMsUUFBSSxLQUFLO0FBQ1QsUUFBSSxNQUFNO0FBQUEsRUFDWixHQUNTQyxhQUFULFdBQTJCO0FBQ3pCLFFBQUksU0FBUyxLQUFNO0FBQ25CLFVBQU0sT0FBTyxZQUFZLGtCQUFrQix5QkFBeUIsZ0JBQWdCLEVBQUU7QUFDdEYsV0FBTyxJQUFJLEtBQUssSUFBSTtBQUNwQixTQUFLLFdBQVcsYUFBYTtBQUM3QixTQUFLLEdBQUcsU0FBU0QsZ0JBQWU7QUFDaEMsU0FBSyxlQUFlLEtBQUssa0JBQWtCO0FBQUEsTUFDekMsRUFBRSxPQUFPLDRCQUFRLE9BQU8sTUFBWSxlQUFlLGFBQWEsRUFBRTtBQUFBLE1BQ2xFLEVBQUUsT0FBTyxrQ0FBUyxPQUFPQSxpQkFBZ0I7QUFBQSxNQUN6QyxFQUFFLE9BQU8sd0NBQVUsT0FBTyxNQUFZLGVBQWUsYUFBYSxFQUFFO0FBQUEsTUFDcEUsRUFBRSxPQUFPLGdCQUFNLE9BQU8sTUFBWSxlQUFlLGVBQWUsRUFBRTtBQUFBLE1BQ2xFLEVBQUUsTUFBTSxZQUFZO0FBQUEsTUFDcEIsRUFBRSxPQUFPLGdCQUFNLE9BQU8sTUFBWTtBQUFFLFFBQUFILEtBQUksS0FBSztBQUFBLE1BQUcsRUFBRTtBQUFBLElBQ3BELENBQUMsQ0FBQztBQUFBLEVBQ0osR0FDU0UsZUFBVCxTQUFxQixLQUEwQjtBQUU3QyxRQUFJLFFBQVEsSUFBSSx5QkFBeUIsT0FBTyxRQUFRLElBQUkseUJBQXlCLFVBQWEsUUFBUSxJQUFJLDRCQUE0QixJQUFLO0FBQy9JLFFBQUksQ0FBQyxhQUFhLFlBQVksRUFBRztBQUNqQyxVQUFNLE1BQU0sY0FBYyxjQUFjLEVBQUUsS0FBSyxDQUFDLE1BQU0sQ0FBQyxFQUFFLFlBQVksQ0FBQztBQUN0RSxVQUFNLFVBQVUsS0FBSyxVQUFVLEtBQUs7QUFDcEMsVUFBTSxLQUFLLENBQUMsT0FBZSxTQUF1QjtBQUNoRCxZQUFNLElBQUksSUFBSSxhQUFhLEVBQUUsT0FBTyxNQUFNLE1BQU0sWUFBWSxrQkFBa0IseUJBQXlCLGdCQUFnQixFQUFFLEVBQUUsQ0FBQztBQUM1SCxRQUFFLEdBQUcsU0FBU0MsZ0JBQWU7QUFDN0IsUUFBRSxLQUFLO0FBQUEsSUFDVDtBQUNBLFFBQUksSUFBSSxTQUFTLHFCQUFxQjtBQUNwQyxZQUFNLElBQUksSUFBSTtBQUNkLFNBQUcsZ0NBQVksR0FBRyxPQUFPLEVBQUUsUUFBUSxjQUFJLENBQUMsdUNBQVM7QUFBQSxJQUNuRCxXQUFXLElBQUksU0FBUyxtQkFBbUIsQ0FBQyxTQUFTO0FBQ25ELFNBQUcsZ0NBQVksZ0JBQU0sSUFBSSxTQUFTLHVDQUFTO0FBQUEsSUFDN0MsV0FBVyxJQUFJLFNBQVMsZ0JBQWdCLENBQUMsU0FBUztBQUNoRCxTQUFHLGdDQUFZLGdCQUFNLElBQUksU0FBUywwREFBYTtBQUFBLElBQ2pEO0FBQUEsRUFDRixHQVNTRSxlQUFULFNBQXFCLE1BQXFCO0FBQ3hDLGVBQVcsS0FBSyxjQUFjLGNBQWMsR0FBRztBQUM3QyxVQUFJLENBQUMsRUFBRSxZQUFZLEdBQUc7QUFDcEIsWUFBSTtBQUFFLFlBQUUsbUJBQW1CLFVBQVUsSUFBSSxDQUFDO0FBQUEsUUFBRyxRQUFRO0FBQUEsUUFBcUI7QUFBQSxNQUM1RTtBQUFBLElBQ0Y7QUFBQSxFQUNGLEdBb0ZTQyxlQUFULFdBQTZCO0FBQzNCLFFBQUksa0JBQWtCLEtBQU07QUFLNUIsVUFBTSxhQUFhLFFBQVEsUUFBUSxRQUFRO0FBQzNDLFVBQU0sUUFBUUMsT0FBTSxJQUFJLGFBQWEsV0FBVyxVQUFVLElBQUk7QUFBQSxNQUM1RCxVQUFVO0FBQUEsTUFDVixPQUFPO0FBQUEsTUFDUCxhQUFhO0FBQUEsTUFDYixPQUFPO0FBQUEsTUFDUCwwQkFBMEI7QUFBQSxJQUM1QixDQUFDO0FBQ0QsVUFBTSxNQUFNO0FBQ1osWUFBUSxVQUFVLFVBQVUsYUFBYSxXQUFNLFVBQVUsRUFBRTtBQUMzRCxJQUFBUCxLQUFJLEtBQUssQ0FBQztBQUFBLEVBQ1osR0FFU1EsZ0JBQVQsV0FBOEI7QUFFNUIsVUFBTSxXQUF1RDtBQUFBLE1BQzNEO0FBQUEsUUFDRSxPQUFPO0FBQUEsUUFDUCxTQUFTO0FBQUEsVUFDUCxFQUFFLE1BQU0sUUFBUSxPQUFPLGVBQUs7QUFBQSxVQUM1QixFQUFFLE1BQU0sUUFBUSxPQUFPLGVBQUs7QUFBQSxVQUM1QixFQUFFLE1BQU0sWUFBWTtBQUFBLFVBQ3BCLEVBQUUsTUFBTSxPQUFPLE9BQU8sZUFBSztBQUFBLFVBQzNCLEVBQUUsTUFBTSxRQUFRLE9BQU8sZUFBSztBQUFBLFVBQzVCLEVBQUUsTUFBTSxTQUFTLE9BQU8sZUFBSztBQUFBLFVBQzdCLEVBQUUsTUFBTSxhQUFhLE9BQU8sZUFBSztBQUFBLFFBQ25DO0FBQUEsTUFDRjtBQUFBLE1BQ0E7QUFBQSxRQUNFLE9BQU87QUFBQSxRQUNQLFNBQVM7QUFBQSxVQUNQLEVBQUUsTUFBTSxZQUFZLE9BQU8scUJBQU07QUFBQSxVQUNqQyxFQUFFLE1BQU0sUUFBUSxPQUFPLGVBQUs7QUFBQSxVQUM1QixFQUFFLE1BQU0sWUFBWTtBQUFBLFVBQ3BCLEVBQUUsTUFBTSxTQUFTLE9BQU8sZUFBSztBQUFBLFFBQy9CO0FBQUEsTUFDRjtBQUFBLElBQ0Y7QUFDQSxTQUFLLG1CQUFtQixLQUFLLGtCQUFrQixRQUFRLENBQUM7QUFBQSxFQUMxRCxHQUVTQyxpQkFBVCxXQUErQjtBQUM3QixVQUFNLE9BQU8sQ0FBQyxNQUFvQjtBQUNoQyxpQkFBVyxLQUFLLGNBQWMsY0FBYyxHQUFHO0FBQzdDLFlBQUksQ0FBQyxFQUFFLFlBQVksRUFBRyxHQUFFLFlBQVksS0FBSyxlQUFlLENBQUM7QUFBQSxNQUMzRDtBQUFBLElBQ0Y7QUFDQSxVQUFNLE1BQU0sY0FBYyxjQUFjLEVBQUUsS0FBSyxDQUFDLE1BQU0sQ0FBQyxFQUFFLFlBQVksQ0FBQztBQUN0RSxRQUFJLFFBQVEsT0FBVztBQUN2QixTQUFLLGtCQUFrQjtBQUFBLE1BQ3JCLEVBQUUsT0FBTyw0QkFBUSxhQUFhLGVBQWUsT0FBTyxNQUFZLEtBQUssYUFBYSxFQUFFO0FBQUEsTUFDcEYsRUFBRSxPQUFPLGdCQUFNLGFBQWEscUJBQXFCLE9BQU8sTUFBWSxLQUFLLGVBQWUsRUFBRTtBQUFBLE1BQzFGLEVBQUUsT0FBTyxzQkFBTyxhQUFhLGVBQWUsT0FBTyxNQUFZLEtBQUssV0FBVyxFQUFFO0FBQUEsTUFDakYsRUFBRSxNQUFNLFlBQVk7QUFBQSxNQUNwQixFQUFFLE9BQU8sd0NBQVUsT0FBTyxNQUFZLEtBQUssYUFBYSxFQUFFO0FBQUEsTUFDMUQsRUFBRSxNQUFNLFlBQVk7QUFBQSxNQUNwQjtBQUFBLFFBQ0UsT0FBTyxZQUFZLGFBQWEsK0NBQVksWUFBWSxVQUFVLEdBQUcsTUFBTTtBQUFBLFFBQzNFLE9BQU8sTUFBWTtBQUNqQixjQUFJLFlBQVksWUFBWTtBQUFFLFlBQUFILGFBQVk7QUFBRztBQUFBLFVBQVE7QUFDckQsZUFBSyxnQkFBZ0IsRUFBRSxLQUFLLENBQUMsT0FBTztBQUNsQyxrQkFBTSxRQUFRLEdBQUcsV0FBVyxRQUFRLFdBQVcsR0FBRyxnQkFBZ0IsR0FBRyxNQUFNLElBQUk7QUFDL0Usa0JBQU0sU0FBUyxRQUFRLEdBQUcsR0FBRyxLQUFLO0FBQUE7QUFBQSxxS0FBd0M7QUFDMUUsaUJBQUssT0FBTyxlQUFlLEtBQUs7QUFBQSxjQUM5QixNQUFNO0FBQUEsY0FDTixPQUFPO0FBQUEsY0FDUCxTQUFTLFFBQ0wsbUNBQVUsR0FBRyxNQUFNLE1BQ2xCLEdBQUcsVUFBVSxLQUFLLDRCQUFRLEdBQUcsS0FBSyxLQUFLLHlDQUFXLEdBQUcsY0FBYztBQUFBLGNBQ3hFO0FBQUEsWUFDRixDQUFDO0FBQUEsVUFDSCxDQUFDO0FBQUEsUUFDSDtBQUFBLE1BQ0Y7QUFBQSxNQUNBO0FBQUEsUUFDRSxPQUFPO0FBQUEsUUFDUCxPQUFPLE1BQVk7QUFDakIsZUFBSyxPQUFPLGVBQWUsS0FBSztBQUFBLFlBQzlCLE1BQU07QUFBQSxZQUNOLE9BQU87QUFBQSxZQUNQLFNBQVM7QUFBQSxZQUNULFFBQVEsNEVBQTBCTixLQUFJLFdBQVcsQ0FBQztBQUFBLHFCQUF3QixPQUFPLGVBQWUsc0JBQU8sR0FBRyxvQkFBb0IsbUJBQVMsRUFBRTtBQUFBLGdCQUFTLE9BQU8sU0FBUyxTQUFVLG9CQUFvQixpREFBNkIscURBQXdCLGtDQUFTO0FBQUE7QUFBQTtBQUFBLFVBQ2hRLENBQUM7QUFBQSxRQUNIO0FBQUEsTUFDRjtBQUFBLE1BQ0EsRUFBRSxPQUFPLGdCQUFNLE1BQU0sT0FBTztBQUFBLElBQzlCLENBQUMsRUFBRSxNQUFNLEVBQUUsUUFBUSxJQUFJLENBQUM7QUFBQSxFQUMxQixHQWNTVSx5QkFBVCxXQUEwQztBQUN4QyxVQUFNLE9BQU8sUUFBUSxJQUFJLFFBQVE7QUFDakMsVUFBTSxhQUFhLFFBQVEsYUFBYSxVQUNwQyxDQUFDWCxNQUFLLFFBQVEsSUFBSSxXQUFXLElBQUksYUFBYSxXQUFXLGNBQWMsWUFBWSxXQUFXLDBCQUEwQixDQUFDLElBQ3pILFFBQVEsYUFBYSxXQUNuQixDQUFDQSxNQUFLLE1BQU0sV0FBVyxnQkFBZ0IsNEJBQTRCLENBQUMsSUFDcEUsQ0FBQ0EsTUFBSyxNQUFNLFdBQVcsV0FBVyxRQUFRLDhCQUE4QixDQUFDO0FBQy9FLFdBQU8sV0FBVyxLQUFLLENBQUMsTUFBTTtBQUFFLFVBQUk7QUFBRSxlQUFPWSxZQUFXLENBQUM7QUFBQSxNQUFHLFFBQVE7QUFBRSxlQUFPO0FBQUEsTUFBTztBQUFBLElBQUUsQ0FBQztBQUFBLEVBQ3pGLEdBRVNDLFdBQVQsV0FBMkI7QUFDekIsVUFBTSxVQUFVO0FBQ2hCLFVBQU0sWUFBWSxDQUFDLE1BQXVCLFFBQVEsS0FBSyxDQUFDLEtBQUssY0FBYyxLQUFLLENBQUMsS0FBSyw2QkFBNkIsS0FBSyxDQUFDO0FBQ3pILFFBQUksUUFBUTtBQUNaLFFBQUksV0FBVztBQUNmLGVBQVcsQ0FBQyxNQUFNLElBQUksS0FBSyxPQUFPLFFBQVEsa0JBQWtCLENBQUMsR0FBRztBQUM5RCxpQkFBVyxLQUFLLFFBQVEsQ0FBQyxHQUFHO0FBQzFCLFlBQUksRUFBRSxXQUFXLFVBQVUsRUFBRSxZQUFZLENBQUMsVUFBVSxFQUFFLE9BQU8sRUFBRztBQUNoRSxZQUFJLENBQUMsUUFBUSxLQUFLLElBQUksRUFBRyxTQUFRLFNBQVMsRUFBRTtBQUFBLFlBQ3ZDLFlBQVcsWUFBWSxFQUFFO0FBQUEsTUFDaEM7QUFBQSxJQUNGO0FBQ0EsV0FBTyxTQUFTO0FBQUEsRUFDbEIsR0FHU0MsY0FBVCxXQUE4QjtBQUM1QixRQUFJLGlCQUFpQixNQUFNLGlCQUFpQixLQUFNLFFBQU87QUFDekQsUUFBSTtBQUNGLFlBQU0sSUFBSWQsTUFBS2UsWUFBVyxZQUFZLEdBQUcsWUFBWSxPQUFPLE9BQU8sU0FBUztBQUM1RSxVQUFJSCxZQUFXLENBQUMsRUFBRyxRQUFPO0FBQUEsSUFDNUIsUUFBUTtBQUFBLElBQWtCO0FBQzFCLFFBQUksTUFBTSxRQUFRLFlBQVk7QUFDOUIsYUFBUyxJQUFJLEdBQUcsSUFBSSxHQUFHLEtBQUs7QUFDMUIsVUFBSUEsWUFBV1osTUFBSyxLQUFLLFFBQVEsU0FBUyxDQUFDLEtBQUtnQixXQUFVLEdBQUcsTUFBTSxpQkFBa0IsUUFBT2hCLE1BQUssS0FBSyxRQUFRLFNBQVM7QUFDdkgsVUFBSSxTQUFTLEdBQUcsTUFBTSxnQkFBZ0JZLFlBQVdaLE1BQUssS0FBSyxPQUFPLFFBQVEsU0FBUyxDQUFDLEVBQUcsUUFBT0EsTUFBSyxLQUFLLE9BQU8sUUFBUSxTQUFTO0FBQ2hJLFlBQU0sU0FBUyxRQUFRLEdBQUc7QUFDMUIsVUFBSSxXQUFXLElBQUs7QUFDcEIsWUFBTTtBQUFBLElBQ1I7QUFDQSxXQUFPO0FBQUEsRUFDVCxHQUNTaUIsVUFBVCxTQUFnQixNQUFzQjtBQUNwQyxVQUFNLFFBQVFILFlBQVc7QUFDekIsUUFBSSxVQUFVLEdBQUk7QUFDbEIsVUFBTSxPQUFPLE1BQU0sU0FBUyxLQUFLO0FBQ2pDLFVBQU0sT0FBT0MsWUFBVyxnQkFBZ0IsS0FBSztBQUM3QyxVQUFNLFFBQVFQLE9BQU0sUUFBUSxVQUFVLE9BQU8sQ0FBQyxZQUFZLE9BQU8sT0FBTyxHQUFHLElBQUksSUFBSSxDQUFDLE9BQU8sR0FBRyxJQUFJLEdBQUc7QUFBQSxNQUNuRyxLQUFLLE9BQU8sT0FBTyxRQUFRLEtBQUs7QUFBQSxNQUNoQyxVQUFVO0FBQUEsTUFDVixPQUFPO0FBQUEsTUFDUCxhQUFhO0FBQUEsTUFDYixLQUFLLEVBQUUsc0JBQXNCLElBQUk7QUFBQSxJQUNuQyxDQUFDO0FBQ0QsVUFBTSxNQUFNO0FBQUEsRUFDZCxHQUVTVSxzQkFBVCxTQUE0QixHQUFjLE1BQTBEO0FBQ2xHLGFBQVMsRUFBRSxHQUFHLFFBQVEsV0FBVyxHQUFHLFVBQVUsWUFBWSxVQUFVLFFBQVEsTUFBTSxhQUFhLFlBQVksVUFBVSxXQUFXLEtBQUs7QUFDckksWUFBUSxRQUFRLFNBQVMsQ0FBQyxHQUFHLEtBQUssY0FBYyxTQUFZLFFBQVEsS0FBSyxTQUFTLEtBQUssRUFBRSxFQUFFO0FBQzNGLGVBQVcsS0FBSyxjQUFjLGNBQWMsR0FBRztBQUM3QyxVQUFJLENBQUMsRUFBRSxZQUFZLEVBQUcsR0FBRSxZQUFZLEtBQUsscUJBQXFCLEdBQUcsSUFBSTtBQUFBLElBQ3ZFO0FBQUEsRUFDRixHQXFFU0MsZ0JBQVQsU0FBc0IsS0FBcUI7QUFDekMsUUFBSTtBQUNGLFlBQU0sSUFBSSxLQUFLLE1BQU0sYUFBYW5CLE1BQUssS0FBSyxjQUFjLEdBQUcsTUFBTSxDQUFDO0FBQ3BFLGFBQU8sT0FBTyxFQUFFLFlBQVksV0FBVyxFQUFFLFVBQVU7QUFBQSxJQUNyRCxRQUFRO0FBQUUsYUFBTztBQUFBLElBQUk7QUFBQSxFQUN2QixHQUVTZ0IsYUFBVCxTQUFtQixLQUFxQjtBQUN0QyxRQUFJO0FBQ0YsWUFBTSxJQUFJLEtBQUssTUFBTSxhQUFhaEIsTUFBSyxLQUFLLGNBQWMsR0FBRyxNQUFNLENBQUM7QUFDcEUsYUFBTyxPQUFPLEVBQUUsU0FBUyxXQUFXLEVBQUUsT0FBTztBQUFBLElBQy9DLFFBQVE7QUFBRSxhQUFPO0FBQUEsSUFBSTtBQUFBLEVBQ3ZCLEdBR1NvQixtQkFBVCxTQUF5QixRQUF3QjtBQUMvQyxVQUFNLFNBQVNwQixNQUFLLFFBQVEsZ0JBQWdCLGNBQWMsT0FBTyxRQUFRLGlCQUFpQjtBQUMxRixRQUFJWSxZQUFXLE1BQU0sRUFBRyxRQUFPO0FBQy9CLFVBQU0sVUFBVVosTUFBSyxRQUFRLE1BQU0sR0FBRyxPQUFPLFFBQVEsaUJBQWlCO0FBQ3RFLFFBQUlZLFlBQVcsT0FBTyxFQUFHLFFBQU87QUFDaEMsV0FBTztBQUFBLEVBQ1QsR0FLU1MseUJBQVQsV0FBa0Q7QUFFaEQsVUFBTSxXQUFXLFFBQVEsSUFBSTtBQUM3QixRQUFJLGFBQWEsVUFBYSxhQUFhLE1BQU0sV0FBVyxRQUFRLEdBQUc7QUFDckUsYUFBTyxFQUFFLE9BQU8sVUFBVSxTQUFTLElBQUksUUFBUSxNQUFNO0FBQUEsSUFDdkQ7QUFFQSxVQUFNLGFBQWEsb0JBQUksSUFBWTtBQUNuQyxVQUFNLFlBQXNCLENBQUM7QUFDN0IsVUFBTSxXQUFXLG9CQUFJLElBQVk7QUFDakMsUUFBSSxTQUFTO0FBRWIsUUFBSTtBQUNGLFlBQU0sTUFBTSxhQUFhLFNBQVMsQ0FBQyxLQUFLLEdBQUcsRUFBRSxVQUFVLFFBQVEsU0FBUyxLQUFPLGFBQWEsS0FBSyxDQUFDO0FBQ2xHLGlCQUFXLFFBQVEsSUFBSSxNQUFNLE9BQU8sR0FBRztBQUNyQyxjQUFNLE1BQU0sS0FBSyxLQUFLO0FBQ3RCLFlBQUksUUFBUSxHQUFJO0FBQ2hCLFlBQUk7QUFDRixnQkFBTSxTQUFTLFFBQVEsR0FBRztBQUMxQixnQkFBTSxTQUFTckIsTUFBSyxRQUFRLGdCQUFnQixXQUFXO0FBQ3ZELGNBQUlZLFlBQVcsTUFBTSxFQUFHLFlBQVcsSUFBSVUsY0FBYSxNQUFNLENBQUM7QUFDM0QsZ0JBQU0sTUFBTXRCLE1BQUssUUFBUSxnQkFBZ0IsY0FBYyxLQUFLO0FBQzVELGNBQUlZLFlBQVcsR0FBRyxFQUFHLFdBQVUsS0FBSyxHQUFHO0FBQUEsUUFDekMsUUFBUTtBQUFBLFFBQW9CO0FBQUEsTUFDOUI7QUFBQSxJQUNGLFFBQVE7QUFBQSxJQUFvQjtBQUU1QixRQUFJO0FBQ0YsWUFBTSxNQUFNLGFBQWEsT0FBTyxDQUFDLFFBQVEsSUFBSSxHQUFHLEVBQUUsVUFBVSxRQUFRLFNBQVMsS0FBTyxhQUFhLEtBQUssQ0FBQztBQUN2RyxZQUFNLE9BQU8sSUFBSSxLQUFLO0FBQ3RCLFlBQU0sU0FBU1osTUFBSyxNQUFNLFdBQVc7QUFDckMsVUFBSVksWUFBVyxNQUFNLEVBQUcsVUFBUyxJQUFJVSxjQUFhLE1BQU0sQ0FBQztBQUN6RCxZQUFNLE1BQU10QixNQUFLLE1BQU0sY0FBYyxLQUFLO0FBQzFDLFVBQUlZLFlBQVcsR0FBRyxFQUFHLFVBQVM7QUFBQSxJQUNoQyxRQUFRO0FBQUEsSUFBZ0I7QUFJeEIsZUFBVyxDQUFDLEtBQUssTUFBTSxLQUFLLENBQUMsQ0FBQyxVQUFVLENBQUMsS0FBSyxJQUFJLFdBQVcsR0FBRyxDQUFDLFFBQVEsWUFBWSxDQUFDLEdBQThCO0FBQ2xILFVBQUksUUFBUSxHQUFJO0FBQ2hCLFlBQU0sUUFBUVEsaUJBQWdCLEdBQUc7QUFDakMsVUFBSSxVQUFVLEdBQUksUUFBTyxFQUFFLE9BQU8sU0FBU0QsY0FBYSxHQUFHLEdBQUcsT0FBTztBQUFBLElBQ3ZFO0FBQ0EsVUFBTSxjQUFjLHNCQUFzQixjQUFjLENBQUM7QUFDekQsUUFBSSxnQkFBZ0IsSUFBSTtBQUN0QixhQUFPLEVBQUUsT0FBTyxhQUFhLFNBQVNBLGNBQWFuQixNQUFLLGNBQWMsR0FBRyxnQkFBZ0IsY0FBYyxLQUFLLENBQUMsR0FBRyxRQUFRLGlCQUFpQjtBQUFBLElBQzNJO0FBR0EsVUFBTSxRQUFRLG9CQUFJLElBQVksQ0FBQyxHQUFHLFlBQVksR0FBRyxRQUFRLENBQUM7QUFDMUQsVUFBTSxRQUFRLENBQUMsUUFBUSxRQUFRLFFBQVEsUUFBUSxRQUFRLFFBQVF1QixTQUFRLEdBQUd2QixNQUFLdUIsU0FBUSxHQUFHLFdBQVcsQ0FBQztBQUN0RyxlQUFXLFFBQVEsT0FBTztBQUN4QixVQUFJO0FBQ0YsY0FBTSxJQUFJLFFBQVEsTUFBTSxXQUFXO0FBQ25DLFlBQUlYLFlBQVcsQ0FBQyxFQUFHLE9BQU0sSUFBSSxDQUFDO0FBQUEsTUFDaEMsUUFBUTtBQUFBLE1BQWE7QUFBQSxJQUN2QjtBQUNBLGVBQVcsUUFBUSxPQUFPO0FBQ3hCLFlBQU0sUUFBUVosTUFBSyxNQUFNLFlBQVksT0FBTyxPQUFPLGlCQUFpQjtBQUNwRSxVQUFJWSxZQUFXLEtBQUssS0FBS0EsWUFBV1osTUFBSyxNQUFNLGNBQWMsQ0FBQyxHQUFHO0FBQy9ELGVBQU8sRUFBRSxPQUFPLFNBQVNtQixjQUFhLElBQUksR0FBRyxRQUFRLGNBQWM7QUFBQSxNQUNyRTtBQUFBLElBQ0Y7QUFDQSxXQUFPLEVBQUUsT0FBTyxJQUFJLFNBQVMsSUFBSSxRQUFRLEdBQUc7QUFBQSxFQUM5QyxHQUVTSyxtQkFBVCxXQUFtQztBQUNqQyxXQUFPSCx1QkFBc0IsRUFBRTtBQUFBLEVBQ2pDLEdBR1NOLGNBQVQsU0FBb0IsT0FBdUI7QUFDekMsUUFBSSxNQUFNLFFBQVEsS0FBSztBQUN2QixhQUFTLElBQUksR0FBRyxJQUFJLEdBQUcsS0FBSztBQUMxQixVQUFJSCxZQUFXWixNQUFLLEtBQUssY0FBYyxDQUFDLEtBQUtZLFlBQVdaLE1BQUssS0FBSyxZQUFZLEtBQUssQ0FBQyxFQUFHLFFBQU87QUFDOUYsWUFBTSxTQUFTLFFBQVEsR0FBRztBQUMxQixVQUFJLFdBQVcsSUFBSztBQUNwQixZQUFNO0FBQUEsSUFDUjtBQUNBLFdBQU8sUUFBUSxLQUFLO0FBQUEsRUFDdEIsR0FRU3lCLHNCQUFULFNBQTRCLFVBQTBCO0FBQ3BELFdBQU96QixNQUFLQyxLQUFJLGFBQWEsUUFBUSxnQkFBZ0JELE1BQUssVUFBVSxRQUFRLFdBQVcsV0FBVyxHQUFHLFdBQVcsYUFBYTtBQUFBLEVBQy9ILEdBR1MwQixzQkFBVCxXQUFtRTtBQUNqRSxVQUFNLFdBQVcxQixNQUFLLE1BQU0sTUFBTSxNQUFNLE1BQU0sSUFBSTtBQUNsRCxVQUFNLElBQUl5QixvQkFBbUIsUUFBUTtBQUNyQyxRQUFJLFVBQVU7QUFDZCxRQUFJO0FBQ0YsWUFBTSxJQUFJLEtBQUssTUFBTSxhQUFhekIsTUFBSyxRQUFRLENBQUMsR0FBRyxjQUFjLEdBQUcsTUFBTSxDQUFDO0FBQzNFLGdCQUFVLE9BQU8sRUFBRSxZQUFZLFdBQVcsRUFBRSxVQUFVO0FBQUEsSUFDeEQsUUFBUTtBQUFBLElBQXVCO0FBQy9CLFdBQU8sRUFBRSxPQUFPWSxZQUFXLENBQUMsR0FBRyxRQUFRO0FBQUEsRUFDekMsR0FHU2UsYUFBVCxXQUE4QjtBQUM1QixRQUFJO0FBQ0YsbUJBQWEsU0FBUyxDQUFDLEtBQUssR0FBRyxFQUFFLFVBQVUsUUFBUSxTQUFTLEtBQU8sYUFBYSxLQUFLLENBQUM7QUFDdEYsYUFBTztBQUFBLElBQ1QsUUFBUTtBQUFFLGFBQU87QUFBQSxJQUFPO0FBQUEsRUFDMUIsR0FlU0Msb0JBQVQsV0FBcUM7QUFDbkMsUUFBSSxRQUFRLElBQUksNkJBQTZCLElBQUssUUFBTztBQUN6RCxXQUFPLFNBQ0YsUUFBUSxJQUFJLHlCQUF5QixPQUNyQyxRQUFRLElBQUkseUJBQXlCLFVBQ3JDLFFBQVEsSUFBSSw0QkFBNEIsT0FDeEMsUUFBUSxJQUFJLHlCQUF5QixPQUNyQyxRQUFRLElBQUksOEJBQThCLE9BQzFDLFFBQVEsSUFBSSxxQkFBcUI7QUFBQSxFQUN4QyxHQTBHU0MsaUJBQVQsU0FBdUIsYUFBZ0U7QUFDckYsUUFBSSxnQkFBZ0IsUUFBUSxnQkFBZ0IsT0FBVyxRQUFPO0FBQzlELFFBQUksTUFBb0M7QUFDeEMsV0FBTyxLQUFLLFdBQVcsUUFBUSxLQUFLLFdBQVcsT0FBVyxPQUFNLElBQUk7QUFDcEUsVUFBTSxNQUFNLEtBQUssT0FBTztBQUN4QixlQUFXLFVBQVUsZ0JBQWdCO0FBQ25DLFVBQUksUUFBUSxVQUFVLElBQUksV0FBVyxHQUFHLE1BQU0sR0FBRyxLQUFLLElBQUksV0FBVyxHQUFHLE1BQU0sR0FBRyxFQUFHLFFBQU87QUFBQSxJQUM3RjtBQUNBLFdBQU87QUFBQSxFQUNULEdBR1NDLFlBQVQsU0FBcUIsT0FBb0MsSUFBd0Y7QUFDL0ksUUFBSSxDQUFDRCxlQUFjLE1BQU0sV0FBVyxFQUFHLFFBQU8sUUFBUSxRQUFRLEVBQUUsT0FBTyxvQkFBb0IsTUFBTSxZQUFZLENBQUM7QUFDOUcsUUFBSSxXQUFXLFFBQVEsT0FBTyxjQUFjLFNBQVM7QUFDbkQsYUFBTyxRQUFRLFFBQVEsRUFBRSxPQUFPLG1CQUFtQixPQUFPLFNBQVMsS0FBSyxNQUFNLGlCQUFpQixDQUFDO0FBQUEsSUFDbEc7QUFDQSxXQUFPLEdBQUcsTUFBTSxFQUFFLE1BQU0sQ0FBQyxRQUFpQjtBQUN4QyxZQUFNLFVBQVUsTUFBTTtBQUFFLFlBQUk7QUFBRSxpQkFBTyxLQUFLLFVBQVUsR0FBRztBQUFBLFFBQUcsUUFBUTtBQUFFLGlCQUFPLE9BQU8sR0FBRztBQUFBLFFBQUc7QUFBQSxNQUFFLEdBQUcsRUFBRSxNQUFNLEdBQUcsR0FBRztBQUMzRyxhQUFPLEVBQUUsT0FBTyxRQUFRLE1BQU0sZUFBZTtBQUFBLElBQy9DLENBQUM7QUFBQSxFQUNILEdBRVNFLGVBQVQsV0FBNkI7QUFDM0IsWUFBUSxPQUFPLG9CQUFvQixDQUFDLFVBQVU7QUFDNUMsVUFBSSxDQUFDRixlQUFjLE1BQU0sV0FBVyxFQUFHLFFBQU8sRUFBRSxPQUFPLG1CQUFtQjtBQUMxRSxhQUFPLEVBQUUsR0FBRyxRQUFRLGNBQWM7QUFBQSxJQUNwQyxDQUFDO0FBRUQsWUFBUSxPQUFPLG1CQUFtQixDQUFDLFVBQ2pDQyxVQUFTLE9BQU8sQ0FBQyxNQUFNLEVBQUUsUUFBNkwseUJBQXlCLENBQUMsQ0FBQztBQUVuUCxZQUFRLE9BQU8sb0JBQW9CLENBQUMsT0FBTyxNQUFlLFdBQW9CLE1BQWUsYUFBc0IsV0FBb0I7QUFDckksWUFBTSxPQUFPLE9BQU8sU0FBUyxXQUFXLEtBQUssTUFBTSxHQUFHLEdBQU0sSUFBSTtBQUNoRSxZQUFNLE1BQU0sT0FBTyxjQUFjLFdBQVcsVUFBVSxNQUFNLEdBQUcsRUFBRSxJQUFJO0FBQ3JFLFlBQU0sSUFBSSxTQUFTLFVBQVUsU0FBUyxTQUFTLE9BQU87QUFFdEQsWUFBTSxPQUFPLE1BQU0sUUFBUSxXQUFXLElBQUksWUFBWSxPQUFPLENBQUMsTUFBbUIsT0FBTyxNQUFNLFFBQVEsRUFBRSxNQUFNLEdBQUcsRUFBRSxJQUFJLENBQUM7QUFFeEgsWUFBTSxPQUFPLE1BQU0sUUFBUSxNQUFNLElBQzdCLE9BQ0csT0FBTyxDQUFDLE9BQ1AsT0FBTyxPQUFPLFlBQVksT0FBTyxRQUFRLE9BQVEsR0FBMEIsU0FBUyxZQUFZLE9BQVEsR0FBNkIsWUFBWSxRQUFRLEVBQzFKLE1BQU0sR0FBRyxDQUFDLEVBQ1YsSUFBSSxDQUFDLFFBQVEsRUFBRSxNQUFNLEdBQUcsS0FBSyxNQUFNLEdBQUcsR0FBRyxHQUFHLFNBQVMsR0FBRyxRQUFRLE1BQU0sR0FBRyxJQUFTLEVBQUUsRUFBRSxJQUN6RixDQUFDO0FBQ0wsVUFBSSxTQUFTLE1BQU0sUUFBUSxHQUFJLFFBQU8sUUFBUSxRQUFRLEVBQUUsSUFBSSxPQUFPLE1BQU0sY0FBYyxDQUFDO0FBQ3hGLGFBQU9BLFVBQVMsT0FBTyxDQUFDLE1BQU0sRUFBRSxTQUEwQyxhQUFhLEVBQUUsTUFBTSxNQUFNLFdBQVcsS0FBSyxNQUFNLEdBQUcsYUFBYSxNQUFNLFFBQVEsS0FBSyxDQUFDLENBQUM7QUFBQSxJQUNsSyxDQUFDO0FBR0QsWUFBUSxPQUFPLG9CQUFvQixDQUFDLE9BQU8sU0FBa0I7QUFDM0QsWUFBTSxJQUFJLE9BQU8sU0FBUyxXQUFXLEtBQUssS0FBSyxFQUFFLE1BQU0sR0FBRyxFQUFFLElBQUk7QUFDaEUsVUFBSSxNQUFNLEdBQUksUUFBTyxRQUFRLFFBQVEsRUFBRSxPQUFPLGlCQUFpQixNQUFNLGNBQWMsQ0FBQztBQUNwRixhQUFPQSxVQUFTLE9BQU8sQ0FBQyxNQUFNLEVBQUUsU0FBMEMsY0FBYyxFQUFFLE1BQU0sRUFBRSxDQUFDLENBQUM7QUFBQSxJQUN0RyxDQUFDO0FBR0QsWUFBUSxPQUFPLHVCQUF1QixPQUFPLFVBQVU7QUFDckQsVUFBSSxDQUFDRCxlQUFjLE1BQU0sV0FBVyxFQUFHLFFBQU8sRUFBRSxPQUFPLG9CQUFvQixNQUFNLFlBQVk7QUFDN0YsYUFBTyxnQkFBZ0I7QUFBQSxJQUN6QixDQUFDO0FBQ0QsWUFBUSxPQUFPLHVCQUF1QixDQUFDLFVBQVU7QUFDL0MsVUFBSSxDQUFDQSxlQUFjLE1BQU0sV0FBVyxFQUFHLFFBQU8sRUFBRSxPQUFPLG9CQUFvQixNQUFNLFlBQVk7QUFDN0YsVUFBSSxrQkFBa0IsS0FBTSxRQUFPLEVBQUUsT0FBTywyQkFBMkIsTUFBTSxpQkFBaUI7QUFDOUYsTUFBQXRCLGFBQVk7QUFDWixhQUFPLEVBQUUsSUFBSSxLQUFLO0FBQUEsSUFDcEIsQ0FBQztBQUdELFlBQVEsT0FBTyx1QkFBdUIsQ0FBQyxPQUFPLFNBQWtCO0FBQzlELFVBQUksQ0FBQ3NCLGVBQWMsTUFBTSxXQUFXLEVBQUcsUUFBTyxFQUFFLE9BQU8sb0JBQW9CLE1BQU0sWUFBWTtBQUM3RixNQUFBdkIsYUFBWSxTQUFTLElBQUk7QUFDekIsYUFBTyxFQUFFLElBQUksS0FBSztBQUFBLElBQ3BCLENBQUM7QUFDRCxZQUFRLE9BQU8sMEJBQTBCLENBQUMsVUFBVTtBQUNsRCxVQUFJLENBQUN1QixlQUFjLE1BQU0sV0FBVyxFQUFHLFFBQU8sRUFBRSxPQUFPLG9CQUFvQixNQUFNLFlBQVk7QUFDN0YsTUFBQW5CLGVBQWM7QUFDZCxhQUFPLEVBQUUsSUFBSSxLQUFLO0FBQUEsSUFDcEIsQ0FBQztBQUdELFlBQVEsT0FBTyw0QkFBNEIsT0FBTyxVQUFVO0FBQzFELFVBQUksQ0FBQ21CLGVBQWMsTUFBTSxXQUFXLEVBQUcsUUFBTyxFQUFFLE9BQU8sb0JBQW9CLE1BQU0sWUFBWTtBQUM3RixZQUFNLElBQUksTUFBTSxlQUFlO0FBQy9CLGFBQU8sRUFBRSxJQUFJLEVBQUUsSUFBSSxTQUFTLEVBQUUsU0FBUyxPQUFPaEIsU0FBUSxHQUFHLE1BQU0sVUFBVSxXQUFXQyxZQUFXLE1BQU0sSUFBSSxXQUFXSCx1QkFBc0IsRUFBRTtBQUFBLElBQzlJLENBQUM7QUFFRCxZQUFRLE9BQU8sK0JBQStCLE9BQU8sT0FBTyxZQUFxQjtBQUMvRSxVQUFJLENBQUNrQixlQUFjLE1BQU0sV0FBVyxFQUFHLFFBQU8sRUFBRSxPQUFPLG9CQUFvQixNQUFNLFlBQVk7QUFDN0YsVUFBSWYsWUFBVyxNQUFNLEdBQUksUUFBTyxFQUFFLE9BQU8saUNBQWlDLE1BQU0saUJBQWlCO0FBQ2pHLE1BQUFHLFFBQU8sQ0FBQyxPQUFPLFlBQVksT0FBTyxtQkFBbUIsa0JBQWtCLENBQUM7QUFFeEUsVUFBSSxZQUFZLE1BQU07QUFDcEIsaUJBQVMsSUFBSSxHQUFHLElBQUksSUFBSSxLQUFLO0FBQzNCLGdCQUFNLElBQUksUUFBUSxDQUFDLE1BQU0sV0FBVyxHQUFHLEdBQUcsQ0FBQztBQUMzQyxlQUFLLE1BQU0sZUFBZSxHQUFHLEdBQUksUUFBTyxFQUFFLElBQUksTUFBTSxXQUFXTix1QkFBc0IsRUFBRTtBQUFBLFFBQ3pGO0FBQ0EsZUFBTyxFQUFFLE9BQU8scUNBQXFDLE1BQU0sa0JBQWtCO0FBQUEsTUFDL0U7QUFDQSxhQUFPLEVBQUUsSUFBSSxNQUFNLFdBQVdBLHVCQUFzQixFQUFFO0FBQUEsSUFDeEQsQ0FBQztBQUNELFlBQVEsT0FBTywyQkFBMkIsT0FBTyxVQUFVO0FBQ3pELFVBQUksQ0FBQ2tCLGVBQWMsTUFBTSxXQUFXLEVBQUcsUUFBTyxFQUFFLE9BQU8sb0JBQW9CLE1BQU0sWUFBWTtBQUM3RixVQUFJZixZQUFXLE1BQU0sR0FBSSxRQUFPLEVBQUUsT0FBTyxpQ0FBaUMsTUFBTSxpQkFBaUI7QUFDakcsV0FBSyxNQUFNLGVBQWUsR0FBRyxJQUFJO0FBQy9CLGVBQU8sRUFBRSxJQUFJLE1BQU0sU0FBUyxNQUFNLFFBQVEsVUFBVUQsU0FBUSxLQUFLLFdBQVcsSUFBSSxRQUFRLEdBQUc7QUFBQSxNQUM3RjtBQUNBLE1BQUFJLFFBQU8sQ0FBQyxPQUFPLFNBQVMsZ0JBQWdCLENBQUM7QUFFekMsZUFBUyxJQUFJLEdBQUcsSUFBSSxJQUFJLEtBQUs7QUFDM0IsY0FBTSxJQUFJLFFBQVEsQ0FBQyxNQUFNLFdBQVcsR0FBRyxHQUFHLENBQUM7QUFDM0MsYUFBSyxNQUFNLGVBQWUsR0FBRyxJQUFJO0FBQy9CLGlCQUFPLEVBQUUsSUFBSSxNQUFNLFFBQVEsVUFBVUosU0FBUSxLQUFLLFdBQVcsSUFBSSxRQUFRLEdBQUc7QUFBQSxRQUM5RTtBQUFBLE1BQ0Y7QUFDQSxhQUFPLEVBQUUsT0FBTyxnRUFBZ0UsTUFBTSxrQkFBa0I7QUFBQSxJQUMxRyxDQUFDO0FBQ0QsWUFBUSxPQUFPLDBCQUEwQixPQUFPLFVBQVU7QUFDeEQsVUFBSSxDQUFDZ0IsZUFBYyxNQUFNLFdBQVcsRUFBRyxRQUFPLEVBQUUsT0FBTyxvQkFBb0IsTUFBTSxZQUFZO0FBQzdGLE1BQUFaLFFBQU8sQ0FBQyxPQUFPLE1BQU0sQ0FBQztBQUN0QixlQUFTLElBQUksR0FBRyxJQUFJLElBQUksS0FBSztBQUMzQixjQUFNLElBQUksUUFBUSxDQUFDLE1BQU0sV0FBVyxHQUFHLEdBQUcsQ0FBQztBQUMzQyxZQUFJLEVBQUUsTUFBTSxlQUFlLEdBQUcsR0FBSSxRQUFPLEVBQUUsSUFBSSxLQUFLO0FBQUEsTUFDdEQ7QUFDQSxZQUFNLFNBQVMsTUFBTSxlQUFlLEdBQUc7QUFDdkMsYUFBTyxRQUFRLEVBQUUsT0FBTyxpQkFBaUIsTUFBTSxlQUFlLElBQUksRUFBRSxJQUFJLEtBQUs7QUFBQSxJQUMvRSxDQUFDO0FBR0QsWUFBUSxPQUFPLHFCQUFxQixPQUFPLE9BQU8sVUFBbUI7QUFDbkUsVUFBSSxDQUFDWSxlQUFjLE1BQU0sV0FBVyxFQUFHLFFBQU8sRUFBRSxPQUFPLG9CQUFvQixNQUFNLFlBQVk7QUFDN0YsWUFBTSxNQUFNLGNBQWMsY0FBYyxFQUFFLEtBQUssQ0FBQyxNQUFNLENBQUMsRUFBRSxZQUFZLENBQUM7QUFDdEUsVUFBSSxRQUFRLE9BQVcsUUFBTyxFQUFFLE9BQU8sYUFBYSxNQUFNLGVBQWU7QUFDekUsWUFBTSxJQUFJLE1BQU0sT0FBTyxlQUFlLEtBQUs7QUFBQSxRQUN6QyxPQUFPLE9BQU8sVUFBVSxZQUFZLFVBQVUsS0FBSyxNQUFNLE1BQU0sR0FBRyxHQUFHLElBQUk7QUFBQSxRQUN6RSxZQUFZLENBQUMsWUFBWSxpQkFBaUI7QUFBQSxNQUM1QyxDQUFDO0FBQ0QsVUFBSSxFQUFFLFlBQVksRUFBRSxVQUFVLFdBQVcsRUFBRyxRQUFPLEVBQUUsSUFBSSxPQUFPLFVBQVUsS0FBSztBQUMvRSxhQUFPLEVBQUUsSUFBSSxNQUFNLE9BQU8sRUFBRSxVQUFVLE1BQU0sR0FBRyxFQUFFLEVBQUU7QUFBQSxJQUNyRCxDQUFDO0FBR0QsWUFBUSxPQUFPLHlCQUF5QixPQUFPLE9BQU8sVUFBbUI7QUFDdkUsVUFBSSxDQUFDQSxlQUFjLE1BQU0sV0FBVyxFQUFHLFFBQU8sRUFBRSxPQUFPLG9CQUFvQixNQUFNLFlBQVk7QUFDN0YsWUFBTSxNQUFNLGNBQWMsY0FBYyxFQUFFLEtBQUssQ0FBQyxNQUFNLENBQUMsRUFBRSxZQUFZLENBQUM7QUFDdEUsVUFBSSxRQUFRLE9BQVcsUUFBTyxFQUFFLE9BQU8sYUFBYSxNQUFNLGVBQWU7QUFDekUsWUFBTSxJQUFJLE1BQU0sT0FBTyxlQUFlLEtBQUs7QUFBQSxRQUN6QyxPQUFPLE9BQU8sVUFBVSxZQUFZLFVBQVUsS0FBSyxNQUFNLE1BQU0sR0FBRyxHQUFHLElBQUk7QUFBQSxRQUN6RSxZQUFZLENBQUMsZUFBZTtBQUFBLE1BQzlCLENBQUM7QUFDRCxVQUFJLEVBQUUsWUFBWSxFQUFFLFVBQVUsQ0FBQyxNQUFNLE9BQVcsUUFBTyxFQUFFLElBQUksT0FBTyxVQUFVLEtBQUs7QUFDbkYsYUFBTyxFQUFFLElBQUksTUFBTSxNQUFNLEVBQUUsVUFBVSxDQUFDLEVBQUU7QUFBQSxJQUMxQyxDQUFDO0FBR0QsWUFBUSxPQUFPLG9CQUFvQixDQUFDLE9BQU8sTUFBZTtBQUN4RCxZQUFNLFFBQVEsT0FBTyxNQUFNLFdBQVcsRUFBRSxNQUFNLEdBQUcsR0FBRyxJQUFJO0FBQ3hELFVBQUksVUFBVSxHQUFJLFFBQU8sUUFBUSxRQUFRLEVBQUUsU0FBUyxDQUFDLEVBQUUsQ0FBQztBQUN4RCxhQUFPQyxVQUFTLE9BQU8sQ0FBQyxNQUFNLEVBQUUsUUFBMkQsb0JBQW9CLG1CQUFtQixLQUFLLENBQUMsRUFBRSxDQUFDO0FBQUEsSUFDN0ksQ0FBQztBQUVELFlBQVEsT0FBTyxrQkFBa0IsQ0FBQyxPQUFPLFNBQWtCLGNBQ3pEQSxVQUFTLE9BQU8sQ0FBQyxNQUFNLEVBQUUsU0FBMEIsZ0JBQWdCO0FBQUEsTUFDakUsU0FBUyxZQUFZO0FBQUEsTUFDckIsV0FBVyxPQUFPLGNBQWMsV0FBVyxVQUFVLE1BQU0sR0FBRyxFQUFFLElBQUk7QUFBQSxJQUN0RSxDQUFDLENBQUMsQ0FBQztBQUVMLFlBQVEsT0FBTyxvQkFBb0IsQ0FBQyxPQUFPLGNBQ3pDQSxVQUFTLE9BQU8sQ0FBQyxNQUFNLEVBQUUsU0FBMEIsa0JBQWtCO0FBQUEsTUFDbkUsV0FBVyxPQUFPLGNBQWMsV0FBVyxVQUFVLE1BQU0sR0FBRyxFQUFFLElBQUk7QUFBQSxJQUN0RSxDQUFDLENBQUMsQ0FBQztBQUdMLFlBQVEsT0FBTyxrQkFBa0IsQ0FBQyxPQUFPLFNBQWtCO0FBQ3pELFlBQU0sSUFBSSxPQUFPLFNBQVMsV0FBVyxLQUFLLE1BQU0sR0FBRyxHQUFJLElBQUk7QUFDM0QsYUFBT0EsVUFBUyxPQUFPLENBQUMsTUFBTSxFQUFFLFFBQWlDLGtCQUFrQixNQUFNLEtBQUssU0FBUyxtQkFBbUIsQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUM7QUFBQSxJQUN4SSxDQUFDO0FBRUQsWUFBUSxPQUFPLGtCQUFrQixDQUFDLE9BQU8sU0FBa0I7QUFDekQsWUFBTSxJQUFJLE9BQU8sU0FBUyxXQUFXLEtBQUssTUFBTSxHQUFHLEdBQUksSUFBSTtBQUMzRCxVQUFJLE1BQU0sR0FBSSxRQUFPLFFBQVEsUUFBUSxFQUFFLE9BQU8saUJBQWlCLE1BQU0sY0FBYyxDQUFDO0FBQ3BGLGFBQU9BLFVBQVMsT0FBTyxDQUFDLE1BQU0sRUFBRSxRQUFpQyxxQkFBcUIsbUJBQW1CLENBQUMsQ0FBQyxFQUFFLENBQUM7QUFBQSxJQUNoSCxDQUFDO0FBRUQsWUFBUSxPQUFPLGlCQUFpQixDQUFDLE9BQU8sTUFBZSxjQUF1QjtBQUM1RSxZQUFNLElBQUksT0FBTyxTQUFTLFdBQVcsS0FBSyxNQUFNLEdBQUcsR0FBTSxJQUFJO0FBQzdELFlBQU0sTUFBTSxPQUFPLGNBQWMsV0FBVyxVQUFVLE1BQU0sR0FBRyxFQUFFLElBQUk7QUFDckUsVUFBSSxNQUFNLE1BQU0sUUFBUSxHQUFJLFFBQU8sUUFBUSxRQUFRLEVBQUUsSUFBSSxPQUFPLE1BQU0sY0FBYyxDQUFDO0FBQ3JGLGFBQU9BLFVBQVMsT0FBTyxDQUFDLE1BQU0sRUFBRSxTQUEwQixlQUFlLEVBQUUsTUFBTSxHQUFHLFdBQVcsSUFBSSxDQUFDLENBQUM7QUFBQSxJQUN2RyxDQUFDO0FBR0QsWUFBUSxPQUFPLHlCQUF5QixPQUFPLE9BQU8sSUFBYSxVQUFtQjtBQUNwRixVQUFJLENBQUNELGVBQWMsTUFBTSxXQUFXLEVBQUcsUUFBTyxFQUFFLE9BQU8sb0JBQW9CLE1BQU0sWUFBWTtBQUM3RixZQUFNLE1BQU0sT0FBTyxPQUFPLFdBQVcsR0FBRyxRQUFRLHNCQUFzQixFQUFFLEVBQUUsTUFBTSxHQUFHLEVBQUUsSUFBSTtBQUN6RixVQUFJLFFBQVEsR0FBSSxRQUFPLEVBQUUsT0FBTyxlQUFlLE1BQU0sY0FBYztBQUNuRSxVQUFJLFdBQVcsUUFBUSxPQUFPLGNBQWMsUUFBUyxRQUFPLEVBQUUsT0FBTyxtQkFBbUIsT0FBTyxTQUFTLEtBQUssTUFBTSxpQkFBaUI7QUFDcEksVUFBSTtBQUNGLGNBQU0sS0FBSyxNQUFNLE9BQU8sUUFBUSxpQkFBaUIsbUJBQW1CLEdBQUcsQ0FBQyxZQUFZO0FBQ3BGLGNBQU0sTUFBTSxjQUFjLGNBQWMsRUFBRSxLQUFLLENBQUMsTUFBTSxDQUFDLEVBQUUsWUFBWSxDQUFDO0FBQ3RFLFlBQUksUUFBUSxPQUFXLFFBQU8sRUFBRSxPQUFPLGFBQWEsTUFBTSxlQUFlO0FBQ3pFLGNBQU0sSUFBSSxNQUFNLE9BQU8sZUFBZSxLQUFLO0FBQUEsVUFDekMsT0FBTyxPQUFPLFVBQVUsWUFBWSxVQUFVLEtBQUssTUFBTSxNQUFNLEdBQUcsRUFBRSxJQUFJO0FBQUEsVUFDeEUsYUFBYSxPQUFPLEdBQUc7QUFBQSxVQUN2QixTQUFTLENBQUMsRUFBRSxNQUFNLFlBQVksWUFBWSxDQUFDLElBQUksRUFBRSxDQUFDO0FBQUEsUUFDcEQsQ0FBQztBQUNELFlBQUksRUFBRSxZQUFZLEVBQUUsYUFBYSxVQUFhLEVBQUUsYUFBYSxHQUFJLFFBQU8sRUFBRSxJQUFJLE9BQU8sVUFBVSxLQUFLO0FBQ3BHLGNBQU1HLFdBQVUsRUFBRSxVQUFVLElBQUksTUFBTTtBQUN0QyxnQkFBUSxVQUFVLFdBQVcsR0FBRyxXQUFNLEVBQUUsUUFBUSxFQUFFO0FBQ2xELGVBQU8sRUFBRSxJQUFJLE1BQU0sTUFBTSxFQUFFLFNBQVM7QUFBQSxNQUN0QyxTQUFTLEtBQUs7QUFDWixjQUFNLFVBQVUsTUFBTTtBQUFFLGNBQUk7QUFBRSxtQkFBTyxLQUFLLFVBQVUsR0FBRztBQUFBLFVBQUcsUUFBUTtBQUFFLG1CQUFPLE9BQU8sR0FBRztBQUFBLFVBQUc7QUFBQSxRQUFFLEdBQUcsRUFBRSxNQUFNLEdBQUcsR0FBRztBQUMzRyxlQUFPLEVBQUUsT0FBTyxRQUFRLE1BQU0sZUFBZTtBQUFBLE1BQy9DO0FBQUEsSUFDRixDQUFDO0FBR0QsWUFBUSxPQUFPLHVCQUF1QixDQUFDLFVBQ3JDRixVQUFTLE9BQU8sQ0FBQyxNQUFNLEVBQUUsUUFBOEMsWUFBWSxDQUFDLENBQUM7QUFFdkYsWUFBUSxPQUFPLHVCQUF1QixDQUFDLE9BQU8sU0FBa0I7QUFDOUQsWUFBTSxJQUFJLFNBQVMsU0FBUyxTQUFTLFNBQVMsUUFBUSxRQUFRO0FBQzlELFVBQUksTUFBTSxHQUFJLFFBQU8sUUFBUSxRQUFRLEVBQUUsT0FBTyx5QkFBeUIsTUFBTSxjQUFjLENBQUM7QUFDNUYsYUFBT0EsVUFBUyxPQUFPLENBQUMsTUFBTSxFQUFFLFNBQTBCLGVBQWUsRUFBRSxVQUFVLEVBQUUsQ0FBQyxDQUFDO0FBQUEsSUFDM0YsQ0FBQztBQUdELFlBQVEsT0FBTyx1QkFBdUIsT0FBTyxVQUFVO0FBQ3JELFVBQUksQ0FBQ0QsZUFBYyxNQUFNLFdBQVcsRUFBRyxRQUFPLEVBQUUsT0FBTyxvQkFBb0IsTUFBTSxZQUFZO0FBQzdGLFlBQU0sSUFBSVIsdUJBQXNCO0FBQ2hDLFlBQU0sTUFBTSxNQUFNLGtCQUFrQjtBQUNwQyxhQUFPO0FBQUEsUUFDTCxNQUFNLE9BQU87QUFBQSxRQUNiLGNBQWMsT0FBTztBQUFBLFFBQ3JCLFVBQVUsSUFBSTtBQUFBLFFBQ2QsTUFBTSxJQUFJO0FBQUEsUUFDVixVQUFVLEVBQUU7QUFBQSxRQUNaLGlCQUFpQixFQUFFO0FBQUEsUUFDbkIsZ0JBQWdCLEVBQUU7QUFBQSxNQUNwQjtBQUFBLElBQ0YsQ0FBQztBQUVELFlBQVEsT0FBTyx5QkFBeUIsT0FBTyxPQUFPLFVBQW1CO0FBQ3ZFLFVBQUksQ0FBQ1EsZUFBYyxNQUFNLFdBQVcsRUFBRyxRQUFPLEVBQUUsT0FBTyxvQkFBb0IsTUFBTSxZQUFZO0FBQzdGLFlBQU0sTUFBTSxjQUFjLGNBQWMsRUFBRSxLQUFLLENBQUMsTUFBTSxDQUFDLEVBQUUsWUFBWSxDQUFDO0FBQ3RFLFVBQUksUUFBUSxPQUFXLFFBQU8sRUFBRSxPQUFPLGFBQWEsTUFBTSxlQUFlO0FBQ3pFLFlBQU0sSUFBSSxNQUFNLE9BQU8sZUFBZSxLQUFLO0FBQUEsUUFDekMsT0FBTyxPQUFPLFVBQVUsWUFBWSxVQUFVLEtBQUssTUFBTSxNQUFNLEdBQUcsR0FBRyxJQUFJO0FBQUEsUUFDekUsWUFBWSxDQUFDLFVBQVU7QUFBQSxRQUN2QixTQUFTLENBQUMsRUFBRSxNQUFNLGdCQUFnQixZQUFZLENBQUMsTUFBTSxJQUFJLEVBQUUsQ0FBQztBQUFBLE1BQzlELENBQUM7QUFDRCxVQUFJLEVBQUUsWUFBWSxFQUFFLFVBQVUsQ0FBQyxNQUFNLE9BQVcsUUFBTyxFQUFFLElBQUksT0FBTyxVQUFVLEtBQUs7QUFDbkYsYUFBTyxFQUFFLElBQUksTUFBTSxPQUFPLEVBQUUsVUFBVSxDQUFDLEVBQUU7QUFBQSxJQUMzQyxDQUFDO0FBR0QsWUFBUSxPQUFPLHNCQUFzQixPQUFPLE9BQU8sVUFBbUI7QUFDcEUsVUFBSSxDQUFDQSxlQUFjLE1BQU0sV0FBVyxFQUFHLFFBQU8sRUFBRSxPQUFPLG9CQUFvQixNQUFNLFlBQVk7QUFDN0YsWUFBTSxJQUFJLE9BQU8sVUFBVSxXQUFXLE1BQU0sS0FBSyxJQUFJO0FBQ3JELFVBQUksTUFBTSxPQUFPLENBQUMsV0FBVyxDQUFDLEtBQUssQ0FBQ2pCLFlBQVcsQ0FBQyxJQUFJO0FBQ2xELGVBQU8sRUFBRSxPQUFPLDZGQUFpQyxNQUFNLGNBQWM7QUFBQSxNQUN2RTtBQUNBLFlBQU0seUJBQXlCLENBQUM7QUFFaEMsZ0JBQVUsTUFBTTtBQUNoQixVQUFJLGVBQWUsS0FBTSxPQUFNLFdBQVcsS0FBSztBQUMvQyxZQUFNLFVBQVU7QUFDaEIsYUFBTyxFQUFFLElBQUksTUFBTSxNQUFNLE9BQU8sS0FBSztBQUFBLElBQ3ZDLENBQUM7QUFHRCxZQUFRLE9BQU8seUJBQXlCLENBQUMsVUFBVTtBQUNqRCxVQUFJLENBQUNpQixlQUFjLE1BQU0sV0FBVyxFQUFHLFFBQU8sRUFBRSxPQUFPLG9CQUFvQixNQUFNLFlBQVk7QUFDN0YsWUFBTSxPQUFPSCxvQkFBbUI7QUFLaEMsVUFBSSxRQUFRLElBQUksZ0NBQWdDLFVBQVUsUUFBUSxJQUFJLHFCQUFxQixLQUFLO0FBQzlGLFlBQUksUUFBUSxJQUFJLDJDQUEyQyxLQUFLO0FBQzlELGlCQUFPLEVBQUUsT0FBTyxNQUFNLFNBQVMsZ0JBQWdCLE9BQU8sdUJBQXVCLFFBQVEsVUFBVSxTQUFTLE1BQU0sS0FBS0MsV0FBVSxFQUFFO0FBQUEsUUFDakk7QUFDQSxlQUFPLEVBQUUsT0FBTyxPQUFPLFNBQVMsSUFBSSxPQUFPLElBQUksUUFBUSxJQUFJLFNBQVMsTUFBTSxLQUFLQSxXQUFVLEVBQUU7QUFBQSxNQUM3RjtBQUNBLFlBQU0sSUFBSU4sdUJBQXNCO0FBQ2hDLGFBQU8sRUFBRSxPQUFPLEVBQUUsVUFBVSxJQUFJLFNBQVMsRUFBRSxTQUFTLE9BQU8sRUFBRSxPQUFPLFFBQVEsRUFBRSxRQUFRLFNBQVMsTUFBTSxLQUFLTSxXQUFVLEVBQUU7QUFBQSxJQUN4SCxDQUFDO0FBRUQsWUFBUSxPQUFPLHNCQUFzQixDQUFDLE9BQU8sU0FBa0I7QUFDN0QsVUFBSSxDQUFDRSxlQUFjLE1BQU0sV0FBVyxFQUFHLFFBQU8sRUFBRSxPQUFPLG9CQUFvQixNQUFNLFlBQVk7QUFDN0YsWUFBTSxJQUFLLFFBQVEsQ0FBQztBQUdwQixVQUFJLFFBQVEsSUFBSSxnQ0FBZ0MsVUFBVSxRQUFRLElBQUkscUJBQXFCLEtBQUs7QUFDOUYsY0FBTSxVQUFVLENBQUMsTUFBNkI7QUFDNUMscUJBQVcsS0FBSyxjQUFjLGNBQWMsR0FBRztBQUM3QyxnQkFBSSxDQUFDLEVBQUUsWUFBWSxFQUFHLEdBQUUsWUFBWSxLQUFLLG9CQUFvQixDQUFDO0FBQUEsVUFDaEU7QUFBQSxRQUNGO0FBQ0EsY0FBTSxZQUFZO0FBQ2hCLGtCQUFRLEVBQUUsT0FBTyxTQUFTLE1BQU0sOENBQXFCLENBQUM7QUFDdEQsZ0JBQU0sSUFBSSxRQUFRLENBQUMsTUFBTSxXQUFXLEdBQUcsR0FBRyxDQUFDO0FBQzNDLGtCQUFRLEVBQUUsT0FBTyxPQUFPLE1BQU0sZ0dBQWtFLENBQUM7QUFBQSxRQUNuRyxHQUFHO0FBQ0gsZUFBTyxFQUFFLElBQUksTUFBTSxNQUFNLEtBQUs7QUFBQSxNQUNoQztBQUNBLGFBQU87QUFBQSxRQUNMO0FBQUEsVUFDRSxjQUFjLENBQUMsTUFBNkI7QUFDMUMsb0JBQVEsV0FBVyxHQUFHLEVBQUUsS0FBSyxHQUFHLEVBQUUsUUFBUSxTQUFZLElBQUksRUFBRSxHQUFHLE1BQU0sRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFO0FBQ25GLHVCQUFXLEtBQUssY0FBYyxjQUFjLEdBQUc7QUFDN0Msa0JBQUksQ0FBQyxFQUFFLFlBQVksRUFBRyxHQUFFLFlBQVksS0FBSyxvQkFBb0IsQ0FBQztBQUFBLFlBQ2hFO0FBQUEsVUFDRjtBQUFBLFVBQ0EsS0FBSyxDQUFDLE1BQW9CO0FBQUUsb0JBQVEsV0FBVyxDQUFDO0FBQUEsVUFBRztBQUFBO0FBQUEsVUFFbkQsYUFBYSxDQUFDLFVBQXdCO0FBQ3BDLGtCQUFNLFlBQVk7QUFDaEIsb0JBQU0sa0JBQWtCLEVBQUUsT0FBTyxNQUFNLE1BQU0sQ0FBQztBQUM5Qyx3QkFBVSxNQUFNO0FBQ2hCLGtCQUFJLGVBQWUsS0FBTSxPQUFNLFdBQVcsS0FBSztBQUMvQyxvQkFBTSxVQUFVO0FBQUEsWUFDbEIsR0FBRztBQUFBLFVBQ0w7QUFBQSxRQUNGO0FBQUEsUUFDQTtBQUFBLFVBQ0UsVUFBVSxFQUFFLGFBQWE7QUFBQSxVQUN6QixhQUFhLEVBQUUsZ0JBQWdCLGNBQWMsY0FBYyxFQUFFLGdCQUFnQixVQUFVLFVBQVU7QUFBQSxRQUNuRztBQUFBLE1BQ0Y7QUFBQSxJQUNGLENBQUM7QUFFRCxZQUFRLE9BQU8scUJBQXFCLE9BQU8sVUFBVTtBQUNuRCxVQUFJLENBQUNBLGVBQWMsTUFBTSxXQUFXLEVBQUcsUUFBTyxFQUFFLE9BQU8sb0JBQW9CLE1BQU0sWUFBWTtBQUM3RixZQUFNLFVBQVUsUUFBUSxJQUFJO0FBQzVCLFVBQUksWUFBWSxVQUFhLFlBQVksSUFBSTtBQUczQyxjQUFNSSxLQUFJLE1BQU0sZ0JBQWdCO0FBQ2hDLGVBQU8sRUFBRSxNQUFNLE9BQU8sUUFBUSxJQUFJLFlBQVksT0FBTyxXQUFXLEVBQUUsTUFBTUEsR0FBRSxNQUFNLFFBQVFBLEdBQUUsT0FBTyxFQUFFO0FBQUEsTUFDckc7QUFDQSxZQUFNLElBQUksTUFBTSxnQkFBZ0I7QUFDaEMsWUFBTSxNQUFNLE1BQU0sa0JBQWtCO0FBRXBDLGFBQU8sRUFBRSxNQUFNLEVBQUUsUUFBUSxJQUFJLFVBQVUsTUFBTSxJQUFJLE1BQU0sUUFBUSxFQUFFLFFBQVEsWUFBWUwsa0JBQWlCLEVBQUU7QUFBQSxJQUMxRyxDQUFDO0FBSUQsWUFBUSxPQUFPLDBCQUEwQixPQUFPLE9BQU8sUUFBaUIsVUFBbUI7QUFDekYsVUFBSSxDQUFDQyxlQUFjLE1BQU0sV0FBVyxFQUFHLFFBQU8sRUFBRSxPQUFPLG9CQUFvQixNQUFNLFlBQVk7QUFDN0YsWUFBTSxJQUFJLFdBQVcsY0FBYyxXQUFXLGFBQWEsV0FBVyxhQUFhLFdBQVcsU0FBUyxTQUFTO0FBQ2hILFVBQUksTUFBTSxHQUFJLFFBQU8sRUFBRSxPQUFPLGdEQUFnRCxNQUFNLGNBQWM7QUFDbEcsWUFBTSxJQUFJLE9BQU8sVUFBVSxXQUFXLFFBQVE7QUFDOUMsWUFBTSxnQkFBZ0IsQ0FBQztBQUN2QixVQUFJLFFBQVEsSUFBSSxxQkFBcUIsSUFBSyxRQUFPLEVBQUUsSUFBSSxNQUFNLE1BQU0sT0FBTyxNQUFNLE1BQU0sS0FBSztBQUMzRixZQUFNLFdBQVc3QixNQUFLLE1BQU0sTUFBTSxNQUFNLE1BQU0sSUFBSTtBQUNsRCxVQUFJLE1BQU0sY0FBYyxNQUFNLFdBQVc7QUFDdkMsY0FBTSxTQUFTLE1BQU0sWUFBWXlCLG9CQUFtQixRQUFRLElBQUk7QUFDaEUsWUFBSSxXQUFXLE1BQU0sQ0FBQyxXQUFXLE1BQU0sS0FBSyxDQUFDYixZQUFXLE1BQU0sR0FBRztBQUMvRCxpQkFBTyxFQUFFLE9BQU8sMENBQWlCLE1BQU0sY0FBYztBQUFBLFFBQ3ZEO0FBQ0EsY0FBTSxrQkFBa0IsRUFBRSxPQUFPLFFBQVEsTUFBTSxNQUFNLENBQUM7QUFBQSxNQUN4RCxXQUFXLE1BQU0sUUFBUTtBQUN2QixjQUFNLGtCQUFrQixFQUFFLE9BQU8sSUFBSSxNQUFNLEtBQUssQ0FBQztBQUFBLE1BQ25EO0FBQ0EsVUFBSSxNQUFNLFdBQVc7QUFFbkIsa0JBQVUsTUFBTTtBQUNoQixZQUFJLGVBQWUsS0FBTSxPQUFNLFdBQVcsS0FBSztBQUMvQyxjQUFNLFVBQVU7QUFBQSxNQUNsQjtBQUNBLGFBQU8sRUFBRSxJQUFJLE1BQU0sTUFBTSxPQUFPLEtBQUs7QUFBQSxJQUN2QyxDQUFDO0FBR0QsWUFBUSxPQUFPLG9CQUFvQixDQUFDLFVBQ2xDa0IsVUFBUyxPQUFPLENBQUMsTUFBTSxFQUFFLFFBQTBJLFlBQVksQ0FBQyxDQUFDO0FBRW5MLFlBQVEsT0FBTyx3QkFBd0IsQ0FBQyxPQUFPLGFBQXNCO0FBQ25FLFlBQU0sSUFBSTtBQUNWLFlBQU0sT0FBTyxPQUFPLEdBQUcsU0FBUyxXQUFXLEVBQUUsS0FBSyxNQUFNLEdBQUcsRUFBRSxJQUFJO0FBQ2pFLFlBQU0sVUFBVSxPQUFPLEdBQUcsWUFBWSxXQUFXLEVBQUUsUUFBUSxNQUFNLEdBQUcsR0FBRyxJQUFJO0FBQzNFLFlBQU0sUUFBUSxPQUFPLEdBQUcsVUFBVSxXQUFXLEVBQUUsTUFBTSxNQUFNLEdBQUcsR0FBRyxJQUFJO0FBQ3JFLFVBQUksU0FBUyxNQUFNLFlBQVksTUFBTSxVQUFVLEdBQUksUUFBTyxRQUFRLFFBQVEsRUFBRSxPQUFPLCtCQUErQixNQUFNLGNBQWMsQ0FBQztBQUN2SSxZQUFNLE9BQWdDLEVBQUUsTUFBTSxTQUFTLE1BQU07QUFFN0QsVUFBSSxPQUFPLEdBQUcsV0FBVyxZQUFZLEVBQUUsV0FBVyxHQUFJLE1BQUssU0FBUyxFQUFFLE9BQU8sTUFBTSxHQUFHLEdBQUc7QUFDekYsYUFBT0EsVUFBUyxPQUFPLENBQUMsTUFBTSxFQUFFLFNBQTBCLGtCQUFrQixJQUFJLENBQUM7QUFBQSxJQUNuRixDQUFDO0FBR0QsWUFBUSxPQUFPLHFCQUFxQixDQUFDLFVBQ25DQSxVQUFTLE9BQU8sQ0FBQyxNQUFNLEVBQUUsUUFBdUYsaUJBQWlCLENBQUMsQ0FBQztBQUVySSxZQUFRLE9BQU8sd0JBQXdCLENBQUMsT0FBTyxPQUFnQjtBQUM3RCxZQUFNLE1BQU0sT0FBTyxPQUFPLFdBQVcsR0FBRyxNQUFNLEdBQUcsRUFBRSxJQUFJO0FBQ3ZELFVBQUksUUFBUSxHQUFJLFFBQU8sUUFBUSxRQUFRLEVBQUUsT0FBTyxlQUFlLE1BQU0sY0FBYyxDQUFDO0FBQ3BGLGFBQU9BLFVBQVMsT0FBTyxDQUFDLE1BQU0sRUFBRSxTQUEwQix1QkFBdUIsRUFBRSxJQUFJLElBQUksQ0FBQyxDQUFDO0FBQUEsSUFDL0YsQ0FBQztBQUVELFlBQVEsT0FBTyx3QkFBd0IsQ0FBQyxPQUFPLE1BQWUsU0FBa0I7QUFDOUUsWUFBTSxJQUFJLE9BQU8sU0FBUyxXQUFXLEtBQUssTUFBTSxHQUFHLEdBQUcsSUFBSTtBQUMxRCxZQUFNLElBQUksT0FBTyxTQUFTLFdBQVcsS0FBSyxNQUFNLEdBQUcsR0FBSSxJQUFJO0FBQzNELFVBQUksTUFBTSxHQUFJLFFBQU8sUUFBUSxRQUFRLEVBQUUsT0FBTyxpQkFBaUIsTUFBTSxjQUFjLENBQUM7QUFDcEYsYUFBT0EsVUFBUyxPQUFPLENBQUMsTUFBTSxFQUFFLFNBQTBCLG1CQUFtQixFQUFFLE1BQU0sTUFBTSxLQUFLLFNBQVksR0FBRyxNQUFNLEVBQUUsQ0FBQyxDQUFDO0FBQUEsSUFDM0gsQ0FBQztBQUdELFlBQVEsT0FBTyxxQkFBcUIsQ0FBQyxPQUFPLElBQWEsT0FBZ0I7QUFDdkUsWUFBTSxNQUFNLE9BQU8sT0FBTyxXQUFXLEdBQUcsUUFBUSxzQkFBc0IsRUFBRSxFQUFFLE1BQU0sR0FBRyxFQUFFLElBQUk7QUFDekYsWUFBTSxJQUFJLE9BQU8sYUFBYSxPQUFPLFdBQVcsS0FBSztBQUNyRCxVQUFJLFFBQVEsTUFBTSxNQUFNLEdBQUksUUFBTyxRQUFRLFFBQVEsRUFBRSxPQUFPLHNDQUFzQyxNQUFNLGNBQWMsQ0FBQztBQUN2SCxhQUFPQSxVQUFTLE9BQU8sQ0FBQyxNQUFNLEVBQUUsU0FBMEIsaUJBQWlCLG1CQUFtQixHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7QUFBQSxJQUNoSCxDQUFDO0FBR0QsWUFBUSxPQUFPLGVBQWUsQ0FBQyxPQUFPLGNBQXVCO0FBQzNELFlBQU0sTUFBTSxPQUFPLGNBQWMsV0FBVyxVQUFVLE1BQU0sR0FBRyxFQUFFLElBQUk7QUFDckUsYUFBT0EsVUFBUyxPQUFPLENBQUMsTUFBTSxFQUFFLFFBQWlDLFlBQVksUUFBUSxLQUFLLGNBQWMsbUJBQW1CLEdBQUcsQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDO0FBQUEsSUFDM0ksQ0FBQztBQUdELFlBQVEsT0FBTyxvQkFBb0IsQ0FBQyxVQUNsQ0EsVUFBUyxPQUFPLENBQUMsTUFBTSxFQUFFLFFBQWlDLGdCQUFnQixDQUFDLENBQUM7QUFHOUUsWUFBUSxPQUFPLDBCQUEwQixDQUFDLE9BQU8sT0FBZ0I7QUFDL0QsWUFBTSxNQUFNLE9BQU8sT0FBTyxXQUFXLEdBQUcsUUFBUSxzQkFBc0IsRUFBRSxFQUFFLE1BQU0sR0FBRyxFQUFFLElBQUk7QUFDekYsVUFBSSxRQUFRLEdBQUksUUFBTyxRQUFRLFFBQVEsRUFBRSxPQUFPLGVBQWUsTUFBTSxjQUFjLENBQUM7QUFDcEYsYUFBT0EsVUFBUyxPQUFPLENBQUMsTUFBTSxFQUFFLFFBQWlDLGlCQUFpQixtQkFBbUIsR0FBRyxDQUFDLEVBQUUsQ0FBQztBQUFBLElBQzlHLENBQUM7QUFFRCxZQUFRLE9BQU8sb0JBQW9CLENBQUMsVUFBVTtBQUM1QyxVQUFJLENBQUNELGVBQWMsTUFBTSxXQUFXLEVBQUcsUUFBTyxFQUFFLE9BQU8sbUJBQW1CO0FBQzFFLFlBQU0sWUFBWTtBQUNoQixrQkFBVSxNQUFNO0FBQ2hCLGNBQU0sWUFBWSxLQUFLO0FBQ3ZCLFFBQUE1QixLQUFJLEtBQUs7QUFBQSxNQUNYLEdBQUc7QUFDSCxhQUFPLEVBQUUsSUFBSSxLQUFLO0FBQUEsSUFDcEIsQ0FBQztBQUFBLEVBQ0g7QUF6bENTLGNBQUFDLFlBeUJBLGtCQUFBRSxrQkFPQSxZQUFBQyxZQWVBLGNBQUFGLGNBNEJBLGNBQUFHLGNBMEZBLGNBQUFDLGNBbUJBLGVBQUFFLGVBNEJBLGdCQUFBQyxnQkE0REEsd0JBQUFDLHdCQVVBLFVBQUFFLFVBZ0JBLGFBQUFDLGFBZ0JBLFNBQUFHLFNBZUEscUJBQUFDLHFCQTJFQSxlQUFBQyxlQU9BLFlBQUFILFlBUUEsa0JBQUFJLGtCQVdBLHdCQUFBQyx3QkFrRUEsa0JBQUFHLGtCQUtBLGFBQUFULGFBaUJBLHFCQUFBVSxxQkFLQSxxQkFBQUMscUJBWUEsWUFBQUMsWUFvQkEsbUJBQUFDLG1CQW1IQSxnQkFBQUMsZ0JBWUEsV0FBQUMsV0FXQSxjQUFBQztBQWp0QlQsRUFBQTlCLEtBQUksR0FBRyxtQkFBbUIsTUFBTTtBQUM5QixVQUFNLE1BQU0sY0FBYyxjQUFjLEVBQUUsQ0FBQztBQUMzQyxRQUFJLEtBQUs7QUFDUCxVQUFJLElBQUksWUFBWSxFQUFHLEtBQUksUUFBUTtBQUNuQyxVQUFJLE1BQU07QUFBQSxJQUNaO0FBQUEsRUFDRixDQUFDO0FBV0QsTUFBSSxhQUE4QztBQUNsRCxNQUFJLFNBQW1DO0FBQ3ZDLE1BQUksU0FBeUIsRUFBRSxXQUFXLFdBQVcsVUFBVSxNQUFNLGFBQWEsTUFBTSxXQUFXLE1BQU0sTUFBTSxRQUFRLGNBQWMsS0FBSztBQUUxSSxNQUFJLGNBQStCLENBQUM7QUFDcEMsTUFBSSxhQUFvQztBQUN4QyxNQUFJLFdBQW1DO0FBQ3ZDLE1BQUksY0FBYztBQUVsQixNQUFJLGdCQUFnQjtBQW9CcEIsUUFBTSxtQkFBbUI7QUFDekIsTUFBSSxPQUFvQjtBQUN4QixRQUFNLGlCQUFpQixDQUFDLE1BQW9CO0FBQzFDLGVBQVcsS0FBSyxjQUFjLGNBQWMsR0FBRztBQUM3QyxVQUFJLENBQUMsRUFBRSxZQUFZLEVBQUcsR0FBRSxZQUFZLEtBQUssZUFBZSxDQUFDO0FBQUEsSUFDM0Q7QUFBQSxFQUNGO0FBaURBLFFBQU0sWUFBWSxDQUFDLFNBQ2pCLE9BQU8sRUFBRSxPQUFPLFdBQVcsYUFBYSxVQUFVLElBQUksRUFBRSxPQUFPLFdBQVcsYUFBYSxVQUFVO0FBYW5HLFFBQU0sY0FBYztBQUVwQixNQUFJLGNBQTJCLEVBQUUsVUFBVSxPQUFPLGdCQUFnQkEsS0FBSSxXQUFXLEdBQUcsUUFBUSxNQUFNLE9BQU8sSUFBSSxZQUFZLE9BQU8sT0FBTyxHQUFHO0FBQzFJLE1BQUksZ0JBQStCO0FBQ25DLFFBQU0sYUFBYSxDQUFDLFVBQXNDO0FBQ3hELGtCQUFjLEVBQUUsR0FBRyxhQUFhLEdBQUcsTUFBTTtBQUN6QyxlQUFXLEtBQUssY0FBYyxjQUFjLEdBQUc7QUFDN0MsVUFBSSxDQUFDLEVBQUUsWUFBWSxFQUFHLEdBQUUsWUFBWSxLQUFLLGdCQUFnQixXQUFXO0FBQUEsSUFDdEU7QUFBQSxFQUNGO0FBQ0EsUUFBTSxhQUFhLENBQUMsR0FBVyxNQUFzQjtBQUNuRCxVQUFNLEtBQUssRUFBRSxRQUFRLE1BQU0sRUFBRSxFQUFFLE1BQU0sR0FBRyxFQUFFLElBQUksTUFBTTtBQUNwRCxVQUFNLEtBQUssRUFBRSxRQUFRLE1BQU0sRUFBRSxFQUFFLE1BQU0sR0FBRyxFQUFFLElBQUksTUFBTTtBQUNwRCxhQUFTLElBQUksR0FBRyxJQUFJLEdBQUcsS0FBSztBQUFFLFdBQUssR0FBRyxDQUFDLEtBQUssUUFBUSxHQUFHLENBQUMsS0FBSyxHQUFJLFNBQVEsR0FBRyxDQUFDLEtBQUssTUFBTSxHQUFHLENBQUMsS0FBSyxLQUFLLEtBQUs7QUFBQSxJQUFHO0FBQzlHLFdBQU87QUFBQSxFQUNUO0FBQ0EsaUJBQWUsa0JBQXdDO0FBQ3JELFFBQUksWUFBWSxZQUFZLFlBQVksV0FBWSxRQUFPO0FBQzNELGVBQVcsRUFBRSxVQUFVLE1BQU0sT0FBTyxHQUFHLENBQUM7QUFDeEMsWUFBUSxVQUFVLDRCQUF1QkEsS0FBSSxXQUFXLENBQUMsR0FBRztBQUM1RCxRQUFJO0FBQ0YsWUFBTSxJQUFJLE1BQU0sTUFBTSxnQ0FBZ0MsV0FBVyxvQkFBb0I7QUFBQSxRQUNuRixTQUFTLEVBQUUsY0FBYyxzQkFBc0I7QUFBQSxRQUMvQyxRQUFRLFlBQVksUUFBUSxJQUFNO0FBQUEsTUFDcEMsQ0FBQztBQUNELFVBQUksQ0FBQyxFQUFFLEdBQUksT0FBTSxJQUFJLE1BQU0sY0FBYyxFQUFFLE1BQU0sRUFBRTtBQUNuRCxZQUFNLE1BQU8sTUFBTSxFQUFFLEtBQUs7QUFDMUIsWUFBTSxNQUFNLE9BQU8sSUFBSSxZQUFZLEVBQUU7QUFDckMsY0FBUSxVQUFVLFVBQVUsR0FBRyxZQUFZLElBQUksVUFBVSxDQUFDLEdBQUcsTUFBTSxFQUFFO0FBQ3JFLGlCQUFXLEVBQUUsVUFBVSxPQUFPLFFBQVEsS0FBSyxPQUFPLE9BQU8sSUFBSSxRQUFRLEVBQUUsRUFBRSxNQUFNLEdBQUcsR0FBRyxFQUFFLENBQUM7QUFFeEYsVUFBSSxRQUFRLE1BQU0sV0FBV0EsS0FBSSxXQUFXLEdBQUcsR0FBRyxJQUFJLEtBQUssQ0FBQyxZQUFZLFlBQVk7QUFDbEYsYUFBSyxrQkFBa0IsSUFBSSxVQUFVLENBQUMsQ0FBQztBQUFBLE1BQ3pDO0FBQUEsSUFDRixTQUFTLEtBQUs7QUFDWixjQUFRLFVBQVUsaUJBQWlCLE9BQU8sR0FBRyxFQUFFLE1BQU0sR0FBRyxHQUFHLENBQUMsRUFBRTtBQUM5RCxpQkFBVyxFQUFFLFVBQVUsT0FBTyxPQUFPLE9BQU8sR0FBRyxFQUFFLE1BQU0sR0FBRyxHQUFHLEVBQUUsQ0FBQztBQUFBLElBQ2xFO0FBQ0EsV0FBTztBQUFBLEVBQ1Q7QUFDQSxpQkFBZSxrQkFBa0IsUUFBNEY7QUFDM0gsUUFBSTtBQUNGLFlBQU0sUUFBUSxPQUFPLEtBQUssQ0FBQyxNQUFNLCtCQUErQixLQUFLLEVBQUUsSUFBSSxDQUFDLEtBQUssT0FBTyxLQUFLLENBQUMsTUFBTSxFQUFFLEtBQUssU0FBUyxNQUFNLENBQUM7QUFDM0gsVUFBSSxVQUFVLFFBQVc7QUFBRSxtQkFBVyxFQUFFLE9BQU8sK0NBQWlCLENBQUM7QUFBRztBQUFBLE1BQVE7QUFDNUUsWUFBTSxPQUFPRCxNQUFLQyxLQUFJLFFBQVEsTUFBTSxHQUFHLE1BQU0sSUFBSTtBQUVqRCxZQUFNLFVBQVU7QUFBQSxRQUNkLE1BQU07QUFBQSxRQUNOLHNCQUFzQixNQUFNLG9CQUFvQjtBQUFBLFFBQ2hELHdCQUF3QixNQUFNLG9CQUFvQjtBQUFBLFFBQ2xELHNCQUFzQixNQUFNLG9CQUFvQjtBQUFBLE1BQ2xEO0FBQ0EsVUFBSSxNQUFxQjtBQUN6QixVQUFJLFVBQVU7QUFDZCxpQkFBVyxLQUFLLFNBQVM7QUFDdkIsWUFBSTtBQUNGLGtCQUFRLFVBQVUsVUFBVSxJQUFJLElBQUksQ0FBQyxFQUFFLElBQUksUUFBRztBQUM5QyxnQkFBTSxJQUFJLE1BQU0sTUFBTSxHQUFHLEVBQUUsUUFBUSxZQUFZLFFBQVEsR0FBTyxFQUFFLENBQUM7QUFDakUsY0FBSSxDQUFDLEVBQUUsSUFBSTtBQUFFLHNCQUFVLFFBQVEsRUFBRSxNQUFNO0FBQUksb0JBQVEsVUFBVSxlQUFVLEVBQUUsTUFBTSxFQUFFO0FBQUc7QUFBQSxVQUFVO0FBQzlGLGdCQUFNLE9BQU8sS0FBSyxNQUFNLEVBQUUsWUFBWSxDQUFDO0FBQ3ZDLGNBQUksSUFBSSxTQUFTLEtBQVc7QUFBRSxvQkFBUSxVQUFVLGFBQVEsS0FBSyxNQUFNLElBQUksU0FBUyxHQUFHLENBQUMsSUFBSTtBQUFHO0FBQUEsVUFBTztBQUNsRyxvQkFBVTtBQUFRLGdCQUFNO0FBQUEsUUFDMUIsU0FBUyxLQUFLO0FBQ1osZ0JBQU0sSUFBSTtBQUNWLG9CQUFVLE9BQU8sRUFBRSxPQUFPLFFBQVEsR0FBRyxFQUFFLE1BQU0sR0FBRyxFQUFFO0FBQ2xELGtCQUFRLFVBQVUsZUFBVSxPQUFPLEVBQUU7QUFBQSxRQUN2QztBQUFBLE1BQ0Y7QUFDQSxVQUFJLFFBQVEsS0FBTSxPQUFNLElBQUksTUFBTSxvREFBWSxPQUFPLEdBQUc7QUFDeEQsWUFBTSxFQUFFLFdBQVcsR0FBRyxJQUFJLE1BQU0sT0FBTyxrQkFBa0I7QUFDekQsWUFBTSxHQUFHLE1BQU0sR0FBRztBQUNsQixzQkFBZ0I7QUFDaEIsaUJBQVcsRUFBRSxZQUFZLEtBQUssQ0FBQztBQUMvQixjQUFRLFVBQVUsc0JBQU8sTUFBTSxJQUFJLElBQUksS0FBSyxNQUFNLElBQUksU0FBUyxHQUFHLENBQUMsY0FBUyxJQUFJLEVBQUU7QUFBQSxJQUNwRixTQUFTLEtBQUs7QUFDWixpQkFBVyxFQUFFLE9BQU8sNkJBQVMsT0FBTyxHQUFHLEVBQUUsTUFBTSxHQUFHLEdBQUcsQ0FBQyxHQUFHLENBQUM7QUFBQSxJQUM1RDtBQUFBLEVBQ0Y7QUFrR0EsUUFBTSxXQUFXO0FBQ2pCLGlCQUFlLGlCQUE0RDtBQUN6RSxRQUFJO0FBQ0YsWUFBTSxJQUFJLE1BQU0sTUFBTSxvQkFBb0IsUUFBUSxjQUFjLEVBQUUsUUFBUSxZQUFZLFFBQVEsSUFBSSxFQUFFLENBQUM7QUFDckcsVUFBSSxDQUFDLEVBQUUsR0FBSSxRQUFPLEVBQUUsSUFBSSxPQUFPLFNBQVMsR0FBRztBQUMzQyxZQUFNLElBQUssTUFBTSxFQUFFLEtBQUs7QUFDeEIsYUFBTyxFQUFFLElBQUksTUFBTSxTQUFTLE9BQU8sRUFBRSxpQkFBaUIsRUFBRSxFQUFFO0FBQUEsSUFDNUQsUUFBUTtBQUFFLGFBQU8sRUFBRSxJQUFJLE9BQU8sU0FBUyxHQUFHO0FBQUEsSUFBRztBQUFBLEVBQy9DO0FBcUVBLGlCQUFlLGFBQTRCO0FBQ3pDLFFBQUksV0FBVyxLQUFNO0FBQ3JCLGVBQVM7QUFDUCxZQUFNLElBQUk7QUFDVixVQUFJLE1BQU0sS0FBTTtBQUNoQixVQUFJO0FBQ0YseUJBQWlCLFNBQVMsRUFBRSxVQUFVLGdCQUFnQixLQUFLLFNBQVksYUFBYSxVQUFVLE1BQU0sR0FBRztBQUNyRyxjQUFJLE1BQU0sVUFBVSxPQUFPO0FBQ3pCLGtCQUFNLE1BQU0sa0JBQWtCLEtBQUs7QUFDbkMsZ0JBQUksUUFBUSxNQUFNO0FBQ2hCLCtCQUFpQjtBQUNqQjtBQUFBLFlBQ0Y7QUFDQSwwQkFBYyxJQUFJO0FBQ2xCLFlBQUFDLFdBQVUsR0FBRztBQUFBLFVBQ2YsV0FBVyxNQUFNLFVBQVUsV0FBVyxNQUFNLFVBQVUsUUFBUTtBQUM1RCxnQkFBSTtBQUNGLG9CQUFNLElBQUksS0FBSyxNQUFNLE1BQU0sSUFBSTtBQUMvQixvQkFBTSxVQUFVLE1BQU0sVUFBVSxVQUM1QixFQUFFLFdBQVcsRUFBRSxhQUFhLElBQUksTUFBTSxFQUFFLEtBQUssUUFBUSxPQUFPLE9BQU8sRUFBRSxTQUFTLEVBQUUsRUFBRSxJQUNsRixFQUFFLFdBQVcsRUFBRSxhQUFhLElBQUksTUFBTSxRQUFRLE9BQU8sT0FBTyxFQUFFLFFBQVEsRUFBRSxFQUFFO0FBQzlFLHlCQUFXLEtBQUssY0FBYyxjQUFjLEdBQUc7QUFDN0Msb0JBQUksQ0FBQyxFQUFFLFlBQVksRUFBRyxHQUFFLFlBQVksS0FBSyx1QkFBdUIsT0FBTztBQUFBLGNBQ3pFO0FBQUEsWUFDRixRQUFRO0FBQUEsWUFBcUM7QUFBQSxVQUMvQztBQUFBLFFBQ0Y7QUFDQTtBQUFBLE1BQ0YsUUFBUTtBQUVOLGNBQU0sSUFBSSxRQUFRLENBQUMsTUFBTSxXQUFXLEdBQUcsR0FBSyxDQUFDO0FBQzdDLFlBQUksVUFBVSxPQUFPLFFBQVM7QUFBQSxNQUNoQztBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBT0EsUUFBTSxvQkFBb0IsTUFBY0YsTUFBS0MsS0FBSSxRQUFRLFVBQVUsR0FBRyxjQUFjO0FBRXBGLGlCQUFlLG9CQUErRDtBQUM1RSxRQUFJO0FBQ0YsWUFBTSxJQUFJLEtBQUssTUFBTSxNQUFNLFNBQVMsa0JBQWtCLEdBQUcsTUFBTSxDQUFDO0FBQ2hFLGFBQU87QUFBQSxRQUNMLE9BQU8sT0FBTyxFQUFFLFVBQVUsWUFBWSxFQUFFLFVBQVUsTUFBTSxXQUFXLEVBQUUsS0FBSyxJQUFJLEVBQUUsUUFBUTtBQUFBLFFBQ3hGLE1BQU0sRUFBRSxTQUFTO0FBQUEsTUFDbkI7QUFBQSxJQUNGLFFBQVE7QUFBRSxhQUFPLEVBQUUsT0FBTyxJQUFJLE1BQU0sTUFBTTtBQUFBLElBQUc7QUFBQSxFQUMvQztBQUNBLGlCQUFlLGtCQUFrQixLQUFzRDtBQUNyRixVQUFNK0IsV0FBVSxrQkFBa0IsR0FBRyxLQUFLLFVBQVUsS0FBSyxNQUFNLENBQUMsR0FBRyxNQUFNLEVBQUUsTUFBTSxNQUFNLE1BQVM7QUFBQSxFQUNsRztBQUNBLGlCQUFlLDJCQUE0QztBQUN6RCxZQUFRLE1BQU0sa0JBQWtCLEdBQUc7QUFBQSxFQUNyQztBQUNBLGlCQUFlLHlCQUF5QixPQUE4QjtBQUNwRSxVQUFNLGtCQUFrQixFQUFFLE9BQU8sT0FBTyxNQUFNLGtCQUFrQixHQUFHLEtBQUssQ0FBQztBQUFBLEVBQzNFO0FBaUhBLE1BQUksZUFBZTtBQUNuQixNQUFJLG9CQUFvQjtBQThCeEIsUUFBTSxhQUFhLE1BQWNoQyxNQUFLQyxLQUFJLFFBQVEsVUFBVSxHQUFHLGFBQWE7QUFDNUUsaUJBQWUsa0JBQThEO0FBQzNFLFFBQUk7QUFDRixZQUFNLElBQUksS0FBSyxNQUFNLE1BQU0sU0FBUyxXQUFXLEdBQUcsTUFBTSxDQUFDO0FBQ3pELGFBQU8sRUFBRSxNQUFNLEVBQUUsU0FBUyxNQUFNLFFBQVEsT0FBTyxFQUFFLFdBQVcsV0FBVyxFQUFFLFNBQVMsR0FBRztBQUFBLElBQ3ZGLFFBQVE7QUFBRSxhQUFPLEVBQUUsTUFBTSxPQUFPLFFBQVEsR0FBRztBQUFBLElBQUc7QUFBQSxFQUNoRDtBQUNBLGlCQUFlLGdCQUFnQixRQUErQjtBQUM1RCxVQUFNK0IsV0FBVSxXQUFXLEdBQUcsS0FBSyxVQUFVLEVBQUUsTUFBTSxNQUFNLE9BQU8sR0FBRyxNQUFNLENBQUMsR0FBRyxNQUFNLEVBQUUsTUFBTSxNQUFNLE1BQVM7QUFBQSxFQUM5RztBQW1CQSxpQkFBZSxZQUEyQjtBQUN4QyxVQUFNLFdBQVdoQyxNQUFLLE1BQU0sTUFBTSxNQUFNLE1BQU0sSUFBSTtBQUNsRCxVQUFNLFdBQVdDLEtBQUk7QUFDckIsVUFBTSxNQUFNLE1BQU0sa0JBQWtCO0FBQ3BDLFVBQU0sWUFBWSxRQUFRLElBQUkscUJBQXFCLE9BQU8sSUFBSTtBQUM5RCxVQUFNLGVBQWUsUUFBUSxJQUFJLHdCQUF3QjtBQUN6RCxVQUFNLFdBQVcsSUFBSTtBQUNyQixVQUFNLFdBQVdELE1BQUssVUFBVSxNQUFNLGFBQWEsWUFBWSxPQUFPLE9BQU8saUJBQWlCO0FBQzlGLFVBQU0sVUFBVXlCLG9CQUFtQixRQUFRO0FBQzNDLFVBQU0sZUFBZWIsWUFBVyxPQUFPO0FBR3ZDLFFBQUksUUFBUTtBQUNaLHdCQUFvQjtBQUNwQixRQUFJLFdBQVc7QUFBQSxJQUVmLFdBQVcsYUFBYSxJQUFJO0FBQzFCLGNBQVE7QUFDUixVQUFJLGFBQWEsUUFBUyxxQkFBb0I7QUFBQSxJQUNoRCxXQUFXLGNBQWM7QUFDdkIsVUFBSSxjQUFjO0FBQUUsZ0JBQVE7QUFBUyw0QkFBb0I7QUFBQSxNQUFNLE1BQzFELFNBQVEsUUFBUSx3R0FBcUU7QUFBQSxJQUM1RixPQUFPO0FBQ0wsY0FBUSxXQUFXWSxpQkFBZ0IsSUFBS1osWUFBVyxRQUFRLElBQUksV0FBV1ksaUJBQWdCO0FBQzFGLFVBQUksVUFBVSxNQUFNLGNBQWM7QUFBRSxnQkFBUTtBQUFTLDRCQUFvQjtBQUFBLE1BQU07QUFBQSxJQUNqRjtBQUNBLG1CQUFlO0FBQ2YsVUFBTSxVQUFVLFVBQVUsT0FBTyxxQkFBcUJaLFlBQVcsS0FBSztBQUN0RSxhQUFTO0FBQUEsTUFDUCxHQUFHO0FBQUEsTUFDSCxNQUFNLFVBQVUsU0FBUztBQUFBLE1BQ3pCLGNBQWMsVUFBVyxvQkFBb0IsR0FBRyxLQUFLLGVBQWUsUUFBUztBQUFBLElBQy9FO0FBQ0EsUUFBSTtBQUNKLFFBQUksbUJBQW1CO0FBQ3JCLGFBQU87QUFBQSxRQUNMLFNBQVMsUUFBUTtBQUFBLFFBQ2pCLE1BQU0sQ0FBQyxLQUFLO0FBQUE7QUFBQSxRQUNaLEtBQUssRUFBRSxzQkFBc0IsSUFBSTtBQUFBLE1BQ25DO0FBQUEsSUFDRixXQUFXLFdBQVcsTUFBTSxTQUFTLEtBQUssR0FBRztBQUMzQyxhQUFPO0FBQUEsUUFDTCxTQUFTLFFBQVE7QUFBQSxRQUNqQixNQUFNLENBQUMsS0FBSztBQUFBO0FBQUEsUUFDWixLQUFLLFFBQVEsS0FBSztBQUFBLFFBQ2xCLEtBQUssRUFBRSxzQkFBc0IsSUFBSTtBQUFBLE1BQ25DO0FBQUEsSUFDRixXQUFXLFNBQVM7QUFDbEIsWUFBTSxPQUFPRyxZQUFXLEtBQUs7QUFDN0IsYUFBTztBQUFBLFFBQ0wsU0FBUyxRQUFRO0FBQUEsUUFDakIsTUFBTSxDQUFDLFlBQVksT0FBTyxLQUFLO0FBQUEsUUFDL0IsS0FBSztBQUFBO0FBQUEsUUFDTCxLQUFLLEVBQUUsc0JBQXNCLElBQUk7QUFBQSxNQUNuQztBQUFBLElBQ0YsV0FBVyxVQUFVO0FBQ25CLGFBQU87QUFBQSxRQUNMLFNBQVMsUUFBUTtBQUFBLFFBQ2pCLE1BQU0sQ0FBQ2YsTUFBSyxRQUFRLGVBQWUsZUFBZSxDQUFDO0FBQUEsUUFDbkQsS0FBSyxFQUFFLHNCQUFzQixJQUFJO0FBQUEsTUFDbkM7QUFBQSxJQUNGLE9BQU87QUFDTCxhQUFPO0FBQUEsUUFDTCxTQUFTLFFBQVE7QUFBQTtBQUFBO0FBQUEsUUFHakIsTUFBTSxDQUFDLFlBQVksT0FBT0EsTUFBSyxVQUFVLFlBQVksZ0JBQWdCLE9BQU8sY0FBYyxDQUFDO0FBQUEsUUFDM0YsS0FBSyxFQUFFLHNCQUFzQixJQUFJO0FBQUEsTUFDbkM7QUFBQSxJQUNGO0FBQ0EsaUJBQWEsSUFBSSx5QkFBeUIsTUFBTTtBQUFBLE1BQzlDLGVBQWVrQjtBQUFBO0FBQUE7QUFBQSxNQUdmLFNBQVMsQ0FBQyxPQUFPO0FBQ2YsaUJBQVMsSUFBSSxrQkFBa0Isb0JBQW9CLEdBQUcsSUFBSSxJQUFJLEdBQUcsS0FBSztBQUN0RSxrQkFBVSxNQUFNO0FBQ2hCLG1CQUFXLElBQUksZ0JBQWdCO0FBQy9CLHNCQUFjO0FBQ2QsYUFBSyxXQUFXO0FBQ2hCLGdCQUFRLFFBQVEsNkJBQTZCLEdBQUcsSUFBSSxhQUFhLEdBQUcsT0FBTyxVQUFVLE9BQU8sSUFBSSxHQUFHLFVBQVUsV0FBVyxZQUFZLEdBQUcsb0JBQW9CLGVBQWUsRUFBRSxLQUFLLEVBQUUsR0FBRztBQUFBLE1BQ3hMO0FBQUEsSUFDRixDQUFDO0FBQ0QsUUFBSTtBQUNGLFlBQU0sV0FBVyxNQUFNO0FBQUEsSUFDekIsU0FBUyxLQUFLO0FBQ1osWUFBTSxVQUFVLE1BQU07QUFBRSxZQUFJO0FBQUUsaUJBQU8sS0FBSyxVQUFVLEdBQUc7QUFBQSxRQUFHLFFBQVE7QUFBRSxpQkFBTyxPQUFPLEdBQUc7QUFBQSxRQUFHO0FBQUEsTUFBRSxHQUFHLEVBQUUsTUFBTSxHQUFHLEdBQUc7QUFDM0csZUFBUyxFQUFFLEdBQUcsUUFBUSxXQUFXLFVBQVUsV0FBVyxPQUFPO0FBQzdELGNBQVEsUUFBUSxpQkFBaUIsTUFBTSxFQUFFO0FBQUEsSUFDM0M7QUFBQSxFQUNGO0FBR0EsUUFBTSxpQkFBaUIsSUFBSTtBQUFBLElBQ3pCLFNBQVMsaUJBQ0wsQ0FBQyxjQUFjLElBQ2YsQ0FBQ2dCLGVBQWNsQyxNQUFLLE1BQU0sTUFBTSxNQUFNLGlCQUFpQixZQUFZLENBQUMsRUFBRSxJQUFJO0FBQUEsRUFDaEY7QUFpY0EsUUFBTSxrQkFBa0IsTUFBY0EsTUFBS0MsS0FBSSxRQUFRLFVBQVUsR0FBRyxtQkFBbUI7QUFDdkYsaUJBQWUsYUFBd0Y7QUFDckcsUUFBSTtBQUNGLGFBQU8sS0FBSyxNQUFNLE1BQU0sU0FBUyxnQkFBZ0IsR0FBRyxNQUFNLENBQUM7QUFBQSxJQUM3RCxRQUFRO0FBQUUsYUFBTztBQUFBLElBQU07QUFBQSxFQUN6QjtBQUNBLGlCQUFlLFdBQVcsS0FBbUM7QUFDM0QsUUFBSTtBQUFFLFlBQU0rQixXQUFVLGdCQUFnQixHQUFHLEtBQUssVUFBVSxJQUFJLFVBQVUsQ0FBQyxHQUFHLE1BQU07QUFBQSxJQUFHLFFBQVE7QUFBQSxJQUFvQjtBQUFBLEVBQ2pIO0FBRUEsaUJBQWUsZUFBOEM7QUFDM0QsVUFBTSxRQUFRLE1BQU0sV0FBVztBQUMvQixVQUFNLE1BQU0sSUFBSSxjQUFjO0FBQUEsTUFDNUIsT0FBTyxPQUFPLFNBQVM7QUFBQSxNQUN2QixRQUFRLE9BQU8sVUFBVTtBQUFBLE1BQ3pCLEdBQUksT0FBTyxNQUFNLFVBQWEsT0FBTyxNQUFNLFNBQVksRUFBRSxHQUFHLE1BQU0sR0FBRyxHQUFHLE1BQU0sRUFBRSxJQUFJLENBQUM7QUFBQTtBQUFBO0FBQUEsTUFHckYsVUFBVSxRQUFRLElBQUkseUJBQXlCLE1BQU0sTUFBTTtBQUFBLE1BQzNELFdBQVcsUUFBUSxJQUFJLHlCQUF5QixNQUFNLE1BQU07QUFBQSxNQUM1RCxNQUFNO0FBQUEsTUFDTixpQkFBaUI7QUFBQTtBQUFBLE1BQ2pCLE9BQU87QUFBQTtBQUFBO0FBQUEsTUFHUCxlQUFlO0FBQUEsTUFDZixpQkFBaUIsRUFBRSxHQUFHLFVBQVUsWUFBWSxtQkFBbUIsR0FBRyxRQUFRLEdBQUc7QUFBQSxNQUM3RSxpQkFBaUI7QUFBQSxNQUNqQixnQkFBZ0I7QUFBQSxRQUNkLFNBQVM7QUFBQSxRQUNULGtCQUFrQjtBQUFBLFFBQ2xCLFNBQVM7QUFBQSxRQUNULGlCQUFpQjtBQUFBLFFBQ2pCLHlCQUF5QjtBQUFBLFFBQ3pCLGFBQWE7QUFBQSxRQUNiLFlBQVk7QUFBQSxRQUNaLFVBQVU7QUFBQSxNQUNaO0FBQUEsSUFDRixDQUFDO0FBQ0QsUUFBSSxLQUFLLGlCQUFpQixNQUFNLElBQUksS0FBSyxDQUFDO0FBQzFDLFFBQUksR0FBRyxTQUFTLE1BQU07QUFBRSxXQUFLLFdBQVcsR0FBRztBQUFBLElBQUcsQ0FBQztBQUcvQyxRQUFJLFlBQVkscUJBQXFCLENBQUMsRUFBRSxJQUFJLE1BQU07QUFDaEQsVUFBSSxlQUFlLEtBQUssR0FBRyxFQUFHLE1BQUssTUFBTSxhQUFhLEdBQUc7QUFDekQsYUFBTyxFQUFFLFFBQVEsT0FBTztBQUFBLElBQzFCLENBQUM7QUFDRCxRQUFJLFlBQVksR0FBRyxpQkFBaUIsQ0FBQyxHQUFHLFFBQVE7QUFDOUMsWUFBTSxLQUFLLENBQUMsR0FBRyxjQUFjLEVBQUUsS0FBSyxDQUFDLE1BQU0sUUFBUSxLQUFLLElBQUksV0FBVyxHQUFHLENBQUMsR0FBRyxLQUFLLElBQUksV0FBVyxHQUFHLENBQUMsR0FBRyxDQUFDO0FBQzFHLFVBQUksQ0FBQyxJQUFJO0FBQ1AsZ0JBQVEsT0FBTyx5QkFBeUIsSUFBSSxNQUFNLEdBQUcsR0FBRyxDQUFDLEVBQUU7QUFDM0QsVUFBRSxlQUFlO0FBQUEsTUFDbkI7QUFBQSxJQUNGLENBQUM7QUFFRCxRQUFJLFNBQVMsZ0JBQWdCO0FBQzNCLFdBQUssSUFBSSxRQUFRLGNBQWM7QUFBQSxJQUNqQyxPQUFPO0FBQ0wsV0FBSyxJQUFJLFNBQVNoQyxNQUFLLE1BQU0sTUFBTSxNQUFNLGlCQUFpQixZQUFZLENBQUM7QUFBQSxJQUN6RTtBQUdBLFFBQUksWUFBWSxLQUFLLG1CQUFtQixNQUFNO0FBQzVDLFVBQUksQ0FBQyxJQUFJLFlBQVksR0FBRztBQUN0QixZQUFJLFlBQVksS0FBSyxxQkFBcUIsT0FBTyxXQUFXLEVBQUUsY0FBYyxFQUFFLENBQUM7QUFBQSxNQUNqRjtBQUFBLElBQ0YsQ0FBQztBQUNELFdBQU87QUFBQSxFQUNUO0FBRUEsRUFBQUMsS0FBSSxVQUFVLEVBQUUsS0FBSyxNQUFNO0FBRXpCLFFBQUksUUFBUSxJQUFJLHlCQUF5QixPQUFPLFFBQVEsSUFBSSw4QkFBOEIsUUFBUTtBQUNoRyxjQUFRLElBQUksbUJBQW1CO0FBQUEsSUFDakM7QUFFQSxJQUFBQSxLQUFJLGtCQUFrQixpQkFBaUI7QUFDdkMsSUFBQUksV0FBVTtBQUNWLElBQUFJLGNBQWE7QUFFYixRQUFJUixLQUFJLFdBQVksWUFBVyxNQUFNO0FBQUUsV0FBSyxnQkFBZ0I7QUFBQSxJQUFHLEdBQUcsR0FBTTtBQUV4RSxVQUFNLE1BQU0sUUFDUjtBQUFBLE1BQ0U7QUFBQSxNQUNBLHFCQUFxQixjQUFjO0FBQUEsTUFDbkM7QUFBQSxNQUNBLHNCQUFzQixjQUFjO0FBQUEsTUFDcEM7QUFBQSxNQUNBO0FBQUEsSUFDRixFQUFFLEtBQUssSUFBSSxJQUNYO0FBQ0osWUFBUSxlQUFlLFdBQVcsa0JBQWtCLENBQUMsU0FBUyxhQUFhO0FBQ3pFLGVBQVM7QUFBQSxRQUNQLGlCQUFpQjtBQUFBLFVBQ2YsR0FBRyxRQUFRO0FBQUEsVUFDWCwyQkFBMkIsQ0FBQyxHQUFHO0FBQUEsUUFDakM7QUFBQSxNQUNGLENBQUM7QUFBQSxJQUNILENBQUM7QUFFRCxJQUFBOEIsYUFBWTtBQUVaLFNBQUssYUFBYSxFQUFFLEtBQUssQ0FBQyxRQUFRO0FBQ2hDLFVBQUksUUFBUSxLQUFNO0FBQ2xCLFVBQUksUUFBUSxJQUFJLHlCQUF5QixJQUFLLGdCQUFlLEdBQUc7QUFDaEUsVUFBSSxRQUFRLElBQUksOEJBQThCLEtBQUs7QUFDakQsWUFBSSxZQUFZLEtBQUssbUJBQW1CLE1BQU07QUFDNUMsZUFBSyxpQkFBaUIsR0FBRztBQUFBLFFBQzNCLENBQUM7QUFBQSxNQUNIO0FBR0EsWUFBTSxPQUFPLFFBQVEsSUFBSTtBQUN6QixVQUFJLFNBQVMsVUFBYSxTQUFTLElBQUk7QUFDckMsWUFBSSxZQUFZLEtBQUssbUJBQW1CLE1BQU07QUFDNUMscUJBQVcsTUFBTTtBQUNmLGtCQUFNLFlBQVk7QUFDaEIsa0JBQUk7QUFDRixzQkFBTSxNQUFNLE1BQU0sSUFBSSxZQUFZLFlBQVk7QUFDOUMsc0JBQU0sRUFBRSxXQUFXLEdBQUcsSUFBSSxNQUFNLE9BQU8sa0JBQWtCO0FBQ3pELHNCQUFNLEdBQUcsTUFBTSxJQUFJLE1BQU0sQ0FBQztBQUMxQix3QkFBUSxJQUFJLGVBQWUsSUFBSSxJQUFJLElBQUksUUFBUSxFQUFFLEtBQUssSUFBSSxJQUFJLFFBQVEsRUFBRSxNQUFNLEVBQUU7QUFBQSxjQUNsRixTQUFTLEtBQUs7QUFDWix3QkFBUSxJQUFJLGtCQUFrQixPQUFPLEdBQUcsRUFBRSxNQUFNLEdBQUcsR0FBRyxDQUFDLEVBQUU7QUFBQSxjQUMzRDtBQUNBLG9CQUFNSSxRQUFPbEM7QUFDYix5QkFBVyxNQUFNa0MsTUFBSyxLQUFLLENBQUMsR0FBRyxHQUFHO0FBQUEsWUFDcEMsR0FBRztBQUFBLFVBQ0wsR0FBRyxPQUFPLFFBQVEsSUFBSSxpQ0FBaUMsSUFBTSxDQUFDO0FBQUEsUUFDaEUsQ0FBQztBQUFBLE1BQ0g7QUFHQSxVQUFJLFFBQVEsSUFBSSx5QkFBeUIsS0FBSztBQUM1QyxZQUFJLFlBQVksS0FBSyxtQkFBbUIsTUFBTTtBQUM1QyxxQkFBVyxNQUFNO0FBQ2Ysa0JBQU0sWUFBWTtBQUNoQixrQkFBSTtBQUNGLHNCQUFNLElBQUssTUFBTSxJQUFJLFlBQVksa0JBQWtCO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsdUJBeUI1QyxJQUFJO0FBQ1gsd0JBQVEsSUFBSSxZQUFZLENBQUMsRUFBRTtBQUFBLGNBQzdCLFNBQVMsS0FBSztBQUNaLHdCQUFRLElBQUksa0JBQWtCLE9BQU8sR0FBRyxFQUFFLE1BQU0sR0FBRyxHQUFHLENBQUMsRUFBRTtBQUFBLGNBQzNEO0FBQ0EsY0FBQWxDLEtBQUksS0FBSyxDQUFDO0FBQUEsWUFDWixHQUFHO0FBQUEsVUFDTCxHQUFHLE9BQU8sUUFBUSxJQUFJLGlDQUFpQyxHQUFLLENBQUM7QUFBQSxRQUMvRCxDQUFDO0FBQUEsTUFDSDtBQUdBLFVBQUksUUFBUSxJQUFJLDRCQUE0QixLQUFLO0FBQy9DLFlBQUksWUFBWSxLQUFLLG1CQUFtQixNQUFNO0FBQzVDLHFCQUFXLE1BQU07QUFDZixrQkFBTSxZQUFZO0FBQ2hCLGtCQUFJO0FBQ0Ysc0JBQU0sSUFBSyxNQUFNLElBQUksWUFBWTtBQUFBLGtCQUMvQjtBQUFBLGtCQUEwRjtBQUFBLGdCQUM1RjtBQUNBLHNCQUFNLEtBQUssSUFBSTtBQUNmLHdCQUFRLElBQUksZUFBZSxLQUFLLE9BQU8sT0FBTyxpQkFBaUIsQ0FBQyxFQUFFO0FBQ2xFLGdCQUFBQSxLQUFJLEtBQUssS0FBSyxJQUFJLENBQUM7QUFBQSxjQUNyQixTQUFTLEtBQUs7QUFDWix3QkFBUSxJQUFJLHFCQUFxQixPQUFPLEdBQUcsRUFBRSxNQUFNLEdBQUcsR0FBRyxDQUFDLEVBQUU7QUFDNUQsZ0JBQUFBLEtBQUksS0FBSyxDQUFDO0FBQUEsY0FDWjtBQUFBLFlBQ0YsR0FBRztBQUFBLFVBQ0wsR0FBRyxJQUFLO0FBQUEsUUFDVixDQUFDO0FBQUEsTUFDSDtBQUFBLElBQ0YsQ0FBQztBQUNELFNBQUssVUFBVTtBQUVmLElBQUFBLEtBQUksR0FBRyxZQUFZLE1BQU07QUFDdkIsVUFBSSxjQUFjLGNBQWMsRUFBRSxXQUFXLEVBQUcsTUFBSyxhQUFhO0FBQUEsSUFDcEUsQ0FBQztBQUFBLEVBQ0gsQ0FBQztBQUVELGlCQUFlLGlCQUFpQixLQUFtQztBQUNqRSxVQUFNLFVBQTRDLENBQUM7QUFDbkQsVUFBTSxRQUFRLE9BQU8sTUFBYyxVQUEyRDtBQUM1RixVQUFJO0FBQ0YsY0FBTSxDQUFDLElBQUksTUFBTSxJQUFJLE1BQU0sTUFBTTtBQUNqQyxnQkFBUSxLQUFLLENBQUMsTUFBTSxJQUFJLE1BQU0sQ0FBQztBQUFBLE1BQ2pDLFNBQVMsS0FBSztBQUNaLGdCQUFRLEtBQUssQ0FBQyxNQUFNLE9BQU8sT0FBTyxHQUFHLEVBQUUsTUFBTSxHQUFHLEdBQUcsQ0FBQyxDQUFDO0FBQUEsTUFDdkQ7QUFBQSxJQUNGO0FBQ0EsVUFBTSxLQUFLLENBQUMsU0FBbUMsSUFBSSxZQUFZLGtCQUFrQixNQUFNLElBQUk7QUFFM0YsVUFBTSxNQUFNLDJFQUE2QyxZQUFZO0FBQ25FLFlBQU0sSUFBSyxNQUFNLEdBQUc7QUFBQTtBQUFBO0FBQUEsV0FHZjtBQUNMLFlBQU0sU0FBUyxLQUFLLE1BQU0sQ0FBQztBQUMzQixZQUFNLElBQUksT0FBTyxDQUFDLEtBQUs7QUFDdkIsWUFBTSxNQUFNLE9BQU8sQ0FBQyxLQUFLO0FBQ3pCLFlBQU0sT0FBTyxDQUFDLE1BQXVCLE1BQU0saUJBQWlCLE1BQU07QUFDbEUsYUFBTyxDQUFDLEtBQUssQ0FBQyxLQUFLLEtBQUssR0FBRyxHQUFHLFdBQVcsQ0FBQyxZQUFZLEdBQUcsRUFBRTtBQUFBLElBQzdELENBQUM7QUFDRCxVQUFNLE1BQU0sZ0dBQXlDLFlBQVk7QUFDL0QsWUFBTSxJQUFLLE1BQU0sR0FBRyxnREFBZ0Q7QUFDcEUsWUFBTSxRQUFRLENBQUMsZUFBZSxXQUFXLGVBQWUsZUFBZSxpQkFBaUIsZUFBZSxlQUFlLGFBQWEsaUJBQWlCLFFBQVEsaUJBQWlCLFVBQVUsVUFBVSxZQUFZLFlBQVksYUFBYSxVQUFVLGNBQWMsYUFBYSxZQUFZLGtCQUFrQixlQUFlLHFCQUFxQixnQkFBZ0Isa0JBQWtCLGlCQUFpQixpQkFBaUIsYUFBYSxpQkFBaUIsZ0JBQWdCLGFBQWEsc0JBQXNCLGtCQUFrQixtQkFBbUIsaUJBQWlCLGVBQWUsWUFBWSxhQUFhLGtCQUFrQixZQUFZLGNBQWMsWUFBWSxrQkFBa0IsY0FBYyxnQkFBZ0IsY0FBYztBQUN0ckIsWUFBTSxNQUFNLE1BQU0sS0FBSyxDQUFDLElBQUksRUFBRSxNQUFNLEdBQUc7QUFDdkMsWUFBTSxhQUFhLElBQUksT0FBTyxDQUFDLE1BQU0sQ0FBQyxNQUFNLFNBQVMsQ0FBQyxDQUFDO0FBQ3ZELGFBQU8sQ0FBQyxXQUFXLFdBQVcsR0FBRyxRQUFRLENBQUMsRUFBRTtBQUFBLElBQzlDLENBQUM7QUFDRCxVQUFNLE1BQU0sZ0VBQW1CLFlBQVk7QUFDekMsWUFBTSxTQUFTLElBQUksWUFBWSxPQUFPO0FBQ3RDLFlBQU0sR0FBRyxxREFBcUQsRUFBRSxNQUFNLE1BQU0sTUFBTTtBQUNsRixZQUFNLElBQUksUUFBUSxDQUFDLE9BQU8sV0FBVyxJQUFJLElBQUssQ0FBQztBQUMvQyxZQUFNLFFBQVEsSUFBSSxZQUFZLE9BQU87QUFDckMsYUFBTyxDQUFDLFVBQVUsUUFBUSxHQUFHLE1BQU0sV0FBTSxLQUFLLEVBQUU7QUFBQSxJQUNsRCxDQUFDO0FBQ0QsVUFBTSxNQUFNLG9GQUFrQyxZQUFZO0FBQ3hELFlBQU0sU0FBUyxjQUFjLGNBQWMsRUFBRTtBQUM3QyxZQUFNLElBQUssTUFBTSxHQUFHLGdEQUFnRDtBQUNwRSxZQUFNLElBQUksUUFBUSxDQUFDLE9BQU8sV0FBVyxJQUFJLEdBQUcsQ0FBQztBQUM3QyxZQUFNLFFBQVEsY0FBYyxjQUFjLEVBQUU7QUFDNUMsYUFBTyxDQUFDLE1BQU0sVUFBVSxVQUFVLFFBQVEsVUFBVSxDQUFDLFlBQVksTUFBTSxTQUFJLEtBQUssRUFBRTtBQUFBLElBQ3BGLENBQUM7QUFDRCxVQUFNLE1BQU0sK0RBQXVCLFlBQVk7QUFDN0MsWUFBTSxPQUFRLE1BQU0sR0FBRywrRUFBaUY7QUFDeEcsWUFBTSxZQUFZLFFBQVEsZ0dBQXdEO0FBQ2xGLGFBQU8sQ0FBQyxRQUFRLE9BQU8sUUFBUSxJQUFJLElBQUksU0FBUyxFQUFFO0FBQUEsSUFDcEQsQ0FBQztBQUNELFVBQU0sTUFBTSxzRUFBbUMsWUFBWTtBQUN6RCxZQUFNLElBQUssTUFBTSxHQUFHLHlFQUF5RTtBQUM3RixhQUFPLENBQUMsRUFBRSxXQUFXLEdBQUcsS0FBSyxFQUFFLFNBQVMsV0FBVyxHQUFHLEVBQUUsTUFBTSxHQUFHLEVBQUUsQ0FBQztBQUFBLElBQ3RFLENBQUM7QUFDRCxVQUFNLE1BQU0sb0dBQXlCLFlBQVk7QUFDL0MsWUFBTSxVQUFVO0FBQ2hCLFlBQU0sUUFBUyxNQUFNLEdBQUcsdUJBQXVCLEtBQUssVUFBVSxPQUFPLENBQUMsc0VBQXNFO0FBQzVJLFVBQUksQ0FBQyxNQUFNLFNBQVMsV0FBVyxFQUFHLFFBQU8sQ0FBQyxPQUFPLGdDQUFpQixNQUFNLE1BQU0sR0FBRyxFQUFFLENBQUMsRUFBRTtBQUV0RixZQUFNLElBQUksUUFBUSxDQUFDLE9BQU8sV0FBVyxJQUFJLEdBQUssQ0FBQztBQUMvQyxZQUFNLFFBQVMsTUFBTSxHQUFHO0FBQUE7QUFBQTtBQUFBO0FBQUEsU0FJckI7QUFDSCxZQUFNLElBQUksS0FBSyxNQUFNLEtBQUs7QUFDMUIsYUFBTyxDQUFDLEVBQUUsWUFBWSxlQUFlLEVBQUUsYUFBYSxHQUFHLFdBQVcsRUFBRSxPQUFPLFFBQVEsRUFBRSxRQUFRLEVBQUU7QUFBQSxJQUNqRyxDQUFDO0FBRUQsUUFBSSxTQUFTO0FBQ2IsZUFBVyxDQUFDLE1BQU0sSUFBSSxNQUFNLEtBQUssU0FBUztBQUN4QyxjQUFRLElBQUksaUJBQWlCLEtBQUssU0FBUyxNQUFNLE1BQU0sSUFBSSxNQUFNLE9BQU8sTUFBTSxDQUFDLEVBQUU7QUFDakYsVUFBSSxDQUFDLEdBQUksV0FBVTtBQUFBLElBQ3JCO0FBQ0EsWUFBUSxJQUFJLDhCQUE4QixRQUFRLFNBQVMsTUFBTSxJQUFJLFFBQVEsTUFBTSxFQUFFO0FBQ3JGLElBQUFBLEtBQUksS0FBSyxXQUFXLElBQUksSUFBSSxDQUFDO0FBQUEsRUFDL0I7QUFHQSxFQUFBQSxLQUFJLEdBQUcsZUFBZSxDQUFDLE1BQU07QUFDM0IsUUFBSSxlQUFlLFFBQVEsV0FBVyxVQUFVLFdBQVc7QUFDekQsUUFBRSxlQUFlO0FBQ2pCLGdCQUFVLE1BQU07QUFDaEIsV0FBSyxXQUFXLEtBQUssRUFBRSxRQUFRLE1BQU1BLEtBQUksS0FBSyxDQUFDO0FBQUEsSUFDakQ7QUFBQSxFQUNGLENBQUM7QUFDRCxFQUFBQSxLQUFJLEdBQUcscUJBQXFCLE1BQU07QUFDaEMsUUFBSSxRQUFRLGFBQWEsU0FBVSxDQUFBQSxLQUFJLEtBQUs7QUFBQSxFQUM5QyxDQUFDO0FBQ0g7QUFoNENXO0FBeUJBO0FBT0E7QUFlQTtBQTRCQTtBQTBGQTtBQW1CQTtBQTRCQTtBQTREQTtBQVVBO0FBZ0JBO0FBZ0JBO0FBZUE7QUEyRUE7QUFPQTtBQVFBO0FBV0E7QUFrRUE7QUFLQTtBQWlCQTtBQUtBO0FBWUE7QUFvQkE7QUFtSEE7QUFZQTtBQVdBOyIsCiAgIm5hbWVzIjogWyJhcHAiLCAiam9pbiIsICJleGlzdHNTeW5jIiwgInJlYWxwYXRoU3luYyIsICJ3cml0ZUZpbGUiLCAiaG9tZWRpciIsICJzcGF3biIsICJwYXRoVG9GaWxlVVJMIiwgInJlc29sdmUiLCAicmFuZG9tVVVJRCIsICJyYW5kb21VVUlEIiwgInJlc29sdmUiLCAic3Bhd24iLCAiam9pbiIsICJqb2luIiwgInJlc29sdmUiLCAic3Bhd24iLCAiam9pbiIsICJqb2luIiwgImFwcCIsICJwdXNoRXZlbnQiLCAibm90aWZ5RXZlbnQiLCAiZm9jdXNNYWluV2luZG93IiwgInNldHVwVHJheSIsICJhcHBseUNocm9tZSIsICJhcHBseVVwZGF0ZSIsICJzcGF3biIsICJidWlsZEFwcE1lbnUiLCAicG9wdXBNYWluTWVudSIsICJ3ZWJBdXRvc3RhcnRJbnN0YWxsZWQiLCAiZXhpc3RzU3luYyIsICJsYW5JcE9mIiwgImNsaUVudHJ5T2YiLCAicmVwb1Jvb3RPZiIsICJwa2dOYW1lQXQiLCAicnVuQ2xpIiwgImJyb2FkY2FzdEhvc3RTdGF0ZSIsICJwa2dWZXJzaW9uQXQiLCAiZW50cnlGcm9tQ2xpRGlyIiwgImRldGVjdEV4dGVybmFsUnVudGltZSIsICJyZWFscGF0aFN5bmMiLCAiaG9tZWRpciIsICJkZXRlY3RSZWFsRW50cnkiLCAiYnVuZGxlZFJ1bnRpbWVQYXRoIiwgImJ1bmRsZWRSdW50aW1lSW5mbyIsICJucG1PblBhdGgiLCAid2l6YXJkU3VwcHJlc3NlZCIsICJzZW5kZXJUcnVzdGVkIiwgImhvc3RDYWxsIiwgInJlZ2lzdGVySXBjIiwgIndyaXRlRmlsZSIsICJ3IiwgInBhdGhUb0ZpbGVVUkwiLCAiYXBwMiJdCn0K
