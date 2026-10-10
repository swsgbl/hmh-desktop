// apps/desktop/electron/main/index.ts
import { app, BrowserWindow, dialog, ipcMain, session, shell } from "electron";
import { join, dirname, isAbsolute, resolve } from "node:path";
import { existsSync, realpathSync as realpathSync2 } from "node:fs";
import { writeFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
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
var DEFAULT_START_TIMEOUT_MS = 2e4;
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
    ["demo", { baseUrl: "http://127.0.0.1:9/v1", model: "fake-m", apiKey: "sk-demo-1234" }]
  ]);
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
        model: "fake-model",
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
    if (req.method === "POST" && url.pathname === "/api/task") {
      void (async () => {
        try {
          const body = JSON.parse(await readBody() || "{}");
          const text = typeof body.text === "string" ? body.text : "";
          const sessionId = typeof body.sessionId === "string" ? body.sessionId : `web-${Date.now().toString(36)}`;
          const mode = body.mode === "ask" || body.mode === "auto" || body.mode === "yolo" ? body.mode : "ask";
          const attachments = Array.isArray(body.attachments) ? body.attachments.filter((a) => typeof a === "string") : [];
          if (!text) {
            res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify(desktopError("SCHEMA_MISMATCH", "text required", { retryable: false })));
            return;
          }
          const composed = attachments.length > 0 ? `[referenced files]
${attachments.map((a) => `- ${a.split(/[\\/]/).pop()}`).join("\n")}

${text}` : text;
          const runId = runTask(sessionId, composed, mode);
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true, runId }));
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

// apps/desktop/electron/main/index.ts
var here = import.meta.dirname ?? ".";
var isDev = process.env.HMH_DESKTOP_DEV === "1";
var rendererDevUrl = process.env.HMH_DESKTOP_RENDERER_URL ?? "";
var preloadPath = join(here, "../preload/index.cjs");
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
if (!app.requestSingleInstanceLock()) {
  app.quit();
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
  }, broadcastHostState2 = function(s, info) {
    bridge = { ...bridge, hostState: s, hostPort: supervisor?.endpoint?.port ?? null, hostVersion: supervisor?.endpoint?.version ?? null };
    logInfo("host", `state=${s}${info.lastError !== void 0 ? ` err=${info.lastError}` : ""}`);
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send("bridge:host-state", s, info);
    }
  }, detectRealEntry2 = function() {
    const envEntry = process.env.HMH_DESKTOP_REAL_ENTRY;
    if (envEntry !== void 0 && envEntry !== "" && isAbsolute(envEntry)) return envEntry;
    const repos = /* @__PURE__ */ new Set();
    try {
      const out = execFileSync("where", ["hmh"], { encoding: "utf8", timeout: 4e3, windowsHide: true });
      for (const line of out.split(/\r?\n/)) {
        const bin = line.trim();
        if (bin === "") continue;
        try {
          const linked = join(dirname(bin), "node_modules", "hmharness");
          if (existsSync(linked)) repos.add(realpathSync2(linked));
        } catch {
        }
      }
    } catch {
    }
    try {
      const out = execFileSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 6e3, windowsHide: true });
      const p = join(out.trim(), "hmharness");
      if (existsSync(p)) repos.add(realpathSync2(p));
    } catch {
    }
    const bases = ["C:\\", "D:\\", "E:\\", "F:\\", "G:\\", "H:\\", homedir(), join(homedir(), "Developer")];
    for (const base of bases) {
      try {
        const p = resolve(base, "hmharness");
        if (existsSync(p)) repos.add(p);
      } catch {
      }
    }
    for (const repo of repos) {
      const entry = join(repo, "packages", "web", "src", "desktop-host.ts");
      if (existsSync(entry) && existsSync(join(repo, "node_modules"))) return entry;
    }
    return "";
  }, repoRootOf2 = function(entry) {
    let dir = dirname(entry);
    for (let i = 0; i < 6; i++) {
      if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "packages", "web"))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return dirname(entry);
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
    ipcMain.handle("bridge:send-task", (event, text, sessionId, mode, attachments) => {
      const task = typeof text === "string" ? text.slice(0, 2e4) : "";
      const sid = typeof sessionId === "string" ? sessionId.slice(0, 80) : "";
      const m = mode === "auto" || mode === "yolo" ? mode : "ask";
      const atts = Array.isArray(attachments) ? attachments.filter((a) => typeof a === "string").slice(0, 10) : [];
      if (task === "" || sid === "") return Promise.resolve({ ok: false, code: "BAD_REQUEST" });
      return hostCall2(event, (c) => c.postJson("/api/task", { text: task, sessionId: sid, mode: m, attachments: atts }));
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
    ipcMain.handle("bridge:export-session", async (event, id) => {
      if (!senderTrusted2(event.senderFrame)) return { error: "untrusted sender", code: "FORBIDDEN" };
      const sid = typeof id === "string" ? id.replace(/[^a-zA-Z0-9_:.@-]/g, "").slice(0, 80) : "";
      if (sid === "") return { error: "id required", code: "BAD_REQUEST" };
      if (client === null || bridge.hostState !== "ready") return { error: `host not ready (${bridge.hostState})`, code: "HOST_NOT_READY" };
      try {
        const md = await client.getText(`/api/sessions/${encodeURIComponent(sid)}/export.md`);
        const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
        if (win === void 0) return { error: "no window", code: "BRIDGE_ERROR" };
        const r = await dialog.showSaveDialog(win, {
          title: "\u5BFC\u51FA\u4F1A\u8BDD",
          defaultPath: `hmh-${sid}.md`,
          filters: [{ name: "Markdown", extensions: ["md"] }]
        });
        if (r.canceled || r.filePath === void 0 || r.filePath === "") return { ok: false, canceled: true };
        await writeFile(r.filePath, md, "utf8");
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
    ipcMain.handle("bridge:runtime-info", (event) => {
      if (!senderTrusted2(event.senderFrame)) return { error: "untrusted sender", code: "FORBIDDEN" };
      return {
        mode: bridge.mode,
        runtimeEntry: bridge.runtimeEntry,
        override: loadRuntimeEntryOverride(),
        detected: detectRealEntry2()
      };
    });
    ipcMain.handle("bridge:browse-runtime", async (event) => {
      if (!senderTrusted2(event.senderFrame)) return { error: "untrusted sender", code: "FORBIDDEN" };
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
      if (win === void 0) return { error: "no window", code: "BRIDGE_ERROR" };
      const r = await dialog.showOpenDialog(win, {
        title: "\u9009\u62E9 hmharness \u7684 desktop-host \u5165\u53E3",
        properties: ["openFile"],
        filters: [{ name: "desktop-host", extensions: ["ts", "js"] }]
      });
      if (r.canceled || r.filePaths[0] === void 0) return { ok: false, canceled: true };
      return { ok: true, entry: r.filePaths[0] };
    });
    ipcMain.handle("bridge:set-runtime", async (event, entry) => {
      if (!senderTrusted2(event.senderFrame)) return { error: "untrusted sender", code: "FORBIDDEN" };
      const e = typeof entry === "string" ? entry.trim() : "";
      if (e !== "" && (!isAbsolute(e) || !existsSync(e))) {
        return { error: "\u5165\u53E3\u5FC5\u987B\u662F\u5B58\u5728\u7684\u7EDD\u5BF9\u8DEF\u5F84(desktop-host.ts)", code: "BAD_REQUEST" };
      }
      await saveRuntimeEntryOverride(e);
      sseAbort?.abort();
      if (supervisor !== null) await supervisor.stop();
      await startHost();
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
        app.quit();
      })();
      return { ok: true };
    });
  };
  pushEvent = pushEvent2, broadcastHostState = broadcastHostState2, detectRealEntry = detectRealEntry2, repoRootOf = repoRootOf2, senderTrusted = senderTrusted2, hostCall = hostCall2, registerIpc = registerIpc2;
  app.on("second-instance", () => {
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
  const runtimeConfigFile = () => join(app.getPath("userData"), "runtime.json");
  async function loadRuntimeEntryOverride() {
    try {
      const v = JSON.parse(await readFile(runtimeConfigFile(), "utf8"));
      return typeof v.entry === "string" && v.entry !== "" && isAbsolute(v.entry) ? v.entry : "";
    } catch {
      return "";
    }
  }
  async function saveRuntimeEntryOverride(entry) {
    await writeFile(runtimeConfigFile(), JSON.stringify({ entry }, null, 2), "utf8").catch(() => void 0);
  }
  let runtimeEntry = "";
  async function startHost() {
    const repoRoot = join(here, "..", "..", "..", "..");
    const packaged = app.isPackaged;
    const forceFake = process.env.HMH_DESKTOP_FAKE === "1";
    const override = await loadRuntimeEntryOverride();
    runtimeEntry = forceFake ? "" : override !== "" ? override : packaged ? detectRealEntry2() : join(repoRoot, "..", "hmharness", "packages", "web", "src", "desktop-host.ts");
    const useReal = runtimeEntry !== "" && existsSync(runtimeEntry);
    bridge = { ...bridge, mode: useReal ? "real" : "fake", runtimeEntry: useReal ? runtimeEntry : null };
    let spec;
    if (useReal) {
      const repo = repoRootOf2(runtimeEntry);
      spec = {
        command: process.execPath,
        args: ["--import", "tsx", runtimeEntry],
        cwd: repo,
        // bare 'tsx' 与 workspace 依赖都从 repo 的 node_modules 解析
        env: { ELECTRON_RUN_AS_NODE: "1" }
      };
    } else if (packaged) {
      spec = {
        command: process.execPath,
        args: [join(process.resourcesPath, "fake-host.cjs")],
        env: { ELECTRON_RUN_AS_NODE: "1" }
      };
    } else {
      spec = {
        command: process.execPath,
        // 直接走包真实路径(node_modules 里的 workspace junction 会被 ESM
        // realpath 化,导致 fake-host 的 argv[1]/import.meta.url 匹配失效)
        args: ["--import", "tsx", join(repoRoot, "packages", "host-adapter", "src", "fake-host.ts")],
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
        logInfo("host", `bridge ready on 127.0.0.1:${ep.port} (runtime ${ep.version}, mode ${bridge.mode}${useReal ? `, entry=${runtimeEntry}` : ""})`);
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
    isDev && rendererDevUrl ? [rendererDevUrl] : [pathToFileURL2(join(here, "..", "..", "dist-renderer", "index.html")).href]
  );
  const windowStateFile = () => join(app.getPath("userData"), "window-state.json");
  async function loadBounds() {
    try {
      return JSON.parse(await readFile(windowStateFile(), "utf8"));
    } catch {
      return null;
    }
  }
  async function saveBounds(win) {
    try {
      await writeFile(windowStateFile(), JSON.stringify(win.getBounds()), "utf8");
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
      backgroundColor: "#141416",
      title: "HMH Desktop",
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
      void win.loadFile(join(here, "..", "..", "dist-renderer", "index.html"));
    }
    return win;
  }
  app.whenReady().then(() => {
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
      if (process.env.HMH_DESKTOP_SECURITY_TEST === "1") {
        win.webContents.once("did-finish-load", () => {
          void securitySelfTest(win);
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
                app.exit(ok ? 0 : 1);
              } catch (err) {
                console.log(`RENDER-TEST ERROR ${String(err).slice(0, 120)}`);
                app.exit(1);
              }
            })();
          }, 2500);
        });
      }
    });
    void startHost();
    app.on("activate", () => {
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
      const allow = ["approve", "approvalGet", "approvalSet", "browseRuntime", "cognitive", "diff", "exportSession", "fsList", "fsRead", "fsSearch", "getState", "inject", "interrupt", "onEventBatches", "onHostState", "onStreamChunks", "providerSave", "providers", "runtimeInfo", "sendTask", "sessionOp", "sessionPreview", "sessions", "setRuntime", "stopHost", "workspaces", "workspaceAdd", "workspaceUse"];
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
    app.exit(failed === 0 ? 0 : 1);
  }
  app.on("before-quit", (e) => {
    if (supervisor !== null && supervisor.state !== "stopped") {
      e.preventDefault();
      sseAbort?.abort();
      void supervisor.stop().finally(() => app.quit());
    }
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
var pushEvent;
var broadcastHostState;
var detectRealEntry;
var repoRootOf;
var senderTrusted;
var hostCall;
var registerIpc;
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vZWxlY3Ryb24vbWFpbi9pbmRleC50cyIsICIuLi8uLi8uLi8uLi9wYWNrYWdlcy9ob3N0LWFkYXB0ZXIvc3JjL3N1cGVydmlzb3IudHMiLCAiLi4vLi4vLi4vLi4vcGFja2FnZXMvY29udHJhY3RzL3NyYy9ldmVudC50cyIsICIuLi8uLi8uLi8uLi9wYWNrYWdlcy9jb250cmFjdHMvc3JjL2Vycm9yLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2NvbnRyYWN0cy9zcmMvZ3VhcmRzLnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2hvc3QtYWRhcHRlci9zcmMvY2xpZW50LnRzIiwgIi4uLy4uLy4uLy4uL3BhY2thZ2VzL2hvc3QtYWRhcHRlci9zcmMvZmFrZS1ob3N0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIEhNSCBEZXNrdG9wIFx1MjAxNCBFbGVjdHJvbiBcdTRFM0JcdThGREJcdTdBMEIoQURSLTAwMS8wMDMvMDA0KVx1MzAwMlxuICpcbiAqIFx1NUI4OVx1NTE2OFx1NEUwRFx1NTNEOFx1OTFDRihcdTVGMDBcdTUzRDFcdThCQTFcdTUyMTIgTTAgXHU1MUZBXHU1M0UzXHU5NUU4ICsgRWxlY3Ryb24gXHU1Qjk4XHU2NUI5XHU1Qjg5XHU1MTY4XHU2RTA1XHU1MzU1KTpcbiAqICAtIHJlbmRlcmVyOmNvbnRleHRJc29sYXRpb24gKyBzYW5kYm94ICsgXHU3OTgxIG5vZGVJbnRlZ3JhdGlvbixcdTRFMjVcdTY4M0MgQ1NQO1xuICogIC0gXHU1QkZDXHU4MjJBL1x1NjVCMFx1N0E5N1x1NTNFM1x1NEUwMFx1NUY4Qlx1NjJEMlx1N0VERChcdTUzRUFcdTUyQTBcdThGN0RcdTYyMTFcdTRFRUNcdTgxRUFcdTVERjFcdTc2ODQgcmVuZGVyZXIpO1xuICogIC0gXHU2QkNGXHU2NzYxIElQQyBcdTY4MjFcdTlBOEMgc2VuZGVyIFx1NzY4NFx1OTg3Nlx1NUM0MiBmcmFtZSBVUkwgXHU1QzVFXHU0RThFXHU2NzJDXHU1RTk0XHU3NTI4LFx1OTAxQVx1OTA1M1x1NzY3RFx1NTQwRFx1NTM1NTtcbiAqICAtIGhvc3QgdG9rZW4gXHU1M0VBXHU1QjU4XHU1NzI4XHU0RThFXHU2NzJDXHU4RkRCXHU3QTBCXHU0RTBFXHU1QjUwXHU4RkRCXHU3QTBCIGVudixcdTY1RTVcdTVGRDdcdThGOTNcdTUxRkFcdTUyNERcdTUxNDhcdTgxMzFcdTY1NEY7XG4gKiAgLSBcdTUzNTVcdTVCOUVcdTRGOEJcdTk1MDE7XHU5MDAwXHU1MUZBXHU2NUY2XHU1M0VBXHU1MDVDXHU2QjYyXHU4MUVBXHU1REYxIHNwYXduIFx1NzY4NCBob3N0KFx1NEYxOFx1OTZDNVx1MjE5Mlx1NTE1Q1x1NUU5NSBraWxsKVx1MzAwMlxuICpcbiAqIFx1OTYzNlx1NkJCNUUoMjAyNi0xMC0xMCk6bWFpbiBcdTYzMDFcdTY3MDkgRGVza3RvcEhvc3RDbGllbnQsU1NFIFx1NEZFMVx1NUMwMVx1NkQ0MShldmVudDogaG1oKVxuICogXHU3RUNGIDUwbXMgXHU2Mjc5XHU5MUNGXHU2M0E4XHU3RUQ5IHJlbmRlcmVyO3NlbmRUYXNrL2FwcHJvdmUvaW50ZXJydXB0L3Nlc3Npb25zIFx1NTE2OFx1OTBFOFx1OEY2Q1x1NTNEMVxuICogXHU3RUQ5IGhvc3QgXHUyMDE0XHUyMDE0IGZha2UgXHU0RTBFXHU3NzFGXHU1QjlFIGhtaGFybmVzcyBkZXNrdG9wLWhvc3QgXHU4RDcwXHU1NDBDXHU0RTAwXHU2NzYxXHU0RUUzXHU3ODAxXHU4REVGXHU1Rjg0XHUzMDAyXG4gKi9cbmltcG9ydCB7IGFwcCwgQnJvd3NlcldpbmRvdywgZGlhbG9nLCBpcGNNYWluLCBzZXNzaW9uLCBzaGVsbCB9IGZyb20gJ2VsZWN0cm9uJztcbmltcG9ydCB7IGpvaW4sIGRpcm5hbWUsIGlzQWJzb2x1dGUsIHJlc29sdmUgfSBmcm9tICdub2RlOnBhdGgnO1xuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhbHBhdGhTeW5jIH0gZnJvbSAnbm9kZTpmcyc7XG5pbXBvcnQgeyB3cml0ZUZpbGUsIHJlYWRGaWxlIH0gZnJvbSAnbm9kZTpmcy9wcm9taXNlcyc7XG5pbXBvcnQgeyBob21lZGlyIH0gZnJvbSAnbm9kZTpvcyc7XG5pbXBvcnQgeyBleGVjRmlsZVN5bmMgfSBmcm9tICdub2RlOmNoaWxkX3Byb2Nlc3MnO1xuaW1wb3J0IHsgcGF0aFRvRmlsZVVSTCB9IGZyb20gJ25vZGU6dXJsJztcbmltcG9ydCB7IHJhbmRvbVVVSUQgfSBmcm9tICdub2RlOmNyeXB0byc7XG5pbXBvcnQgeyBEZXNrdG9wUnVudGltZVN1cGVydmlzb3IsIERlc2t0b3BIb3N0Q2xpZW50LCBlbnZlbG9wZUZyb21GcmFtZSwgdHlwZSBIb3N0U3RhdGUgfSBmcm9tICdAaG1oLWRlc2t0b3AvaG9zdC1hZGFwdGVyJztcbmltcG9ydCB7IGlzRXZlbnRFbnZlbG9wZSwgdHlwZSBFdmVudEVudmVsb3BlIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyc7XG5cbmNvbnN0IGhlcmUgPSBpbXBvcnQubWV0YS5kaXJuYW1lID8/ICcuJztcbmNvbnN0IGlzRGV2ID0gcHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfREVWID09PSAnMSc7XG5jb25zdCByZW5kZXJlckRldlVybCA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1JFTkRFUkVSX1VSTCA/PyAnJztcbmNvbnN0IHByZWxvYWRQYXRoID0gam9pbihoZXJlLCAnLi4vcHJlbG9hZC9pbmRleC5janMnKTtcblxuLyogLS0tLSBcdTY1RTVcdTVGRDdcdTgxMzFcdTY1NEY6dG9rZW4vYXV0aG9yaXphdGlvbiBcdTZDMzhcdTRFMERcdThGREJcdTYzQTdcdTUyMzZcdTUzRjAgLS0tLSAqL1xuY29uc3Qgc2VjcmV0czogc3RyaW5nW10gPSBbXTtcbmZ1bmN0aW9uIHJlZGFjdChzOiBzdHJpbmcpOiBzdHJpbmcge1xuICBsZXQgb3V0ID0gcztcbiAgZm9yIChjb25zdCBzZWMgb2Ygc2VjcmV0cykge1xuICAgIGlmIChzZWMubGVuZ3RoID49IDgpIG91dCA9IG91dC5zcGxpdChzZWMpLmpvaW4oJ1tyZWRhY3RlZF0nKTtcbiAgfVxuICByZXR1cm4gb3V0O1xufVxuZnVuY3Rpb24gbG9nSW5mbyh0YWc6IHN0cmluZywgbXNnOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc29sZS5sb2coYFtobWgtZGVza3RvcDoke3RhZ31dICR7cmVkYWN0KG1zZyl9YCk7XG59XG5cbi8qIC0tLS0gXHU1MzU1XHU1QjlFXHU0RjhCIC0tLS0gKi9cbmlmICghYXBwLnJlcXVlc3RTaW5nbGVJbnN0YW5jZUxvY2soKSkge1xuICBhcHAucXVpdCgpO1xufSBlbHNlIHtcbiAgYXBwLm9uKCdzZWNvbmQtaW5zdGFuY2UnLCAoKSA9PiB7XG4gICAgY29uc3Qgd2luID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKClbMF07XG4gICAgaWYgKHdpbikge1xuICAgICAgaWYgKHdpbi5pc01pbmltaXplZCgpKSB3aW4ucmVzdG9yZSgpO1xuICAgICAgd2luLmZvY3VzKCk7XG4gICAgfVxuICB9KTtcblxuICAvKiAtLS0tIGhvc3QgXHU3NkQxXHU3QkExICsgXHU2ODY1XHU1QkEyXHU2MjM3XHU3QUVGIC0tLS0gKi9cbiAgaW50ZXJmYWNlIEJyaWRnZVNuYXBzaG90IHtcbiAgICBob3N0U3RhdGU6IEhvc3RTdGF0ZTtcbiAgICBob3N0UG9ydDogbnVtYmVyIHwgbnVsbDtcbiAgICBob3N0VmVyc2lvbjogc3RyaW5nIHwgbnVsbDtcbiAgICBsYXN0RXJyb3I6IHN0cmluZyB8IG51bGw7XG4gICAgbW9kZTogJ2Zha2UnIHwgJ3JlYWwnO1xuICAgIHJ1bnRpbWVFbnRyeTogc3RyaW5nIHwgbnVsbDtcbiAgfVxuICBsZXQgc3VwZXJ2aXNvcjogRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yIHwgbnVsbCA9IG51bGw7XG4gIGxldCBjbGllbnQ6IERlc2t0b3BIb3N0Q2xpZW50IHwgbnVsbCA9IG51bGw7XG4gIGxldCBicmlkZ2U6IEJyaWRnZVNuYXBzaG90ID0geyBob3N0U3RhdGU6ICdzdG9wcGVkJywgaG9zdFBvcnQ6IG51bGwsIGhvc3RWZXJzaW9uOiBudWxsLCBsYXN0RXJyb3I6IG51bGwsIG1vZGU6ICdmYWtlJywgcnVudGltZUVudHJ5OiBudWxsIH07XG4gIC8qKiBcdTRFOEJcdTRFRjZcdTYyNzlcdTkxQ0ZcdTdGMTNcdTUxQjI6XHU5QUQ4XHU5ODkxIFNTRSBcdTRFMERcdTkwMTBcdTY3NjFcdThGQzcgSVBDLDUwbXMgXHU2Mjc5XHU5MUNGIGZsdXNoKFx1NkUzMlx1NjdEM1x1NEUwRFx1NTM2MSlcdTMwMDIgKi9cbiAgbGV0IGV2ZW50QnVmZmVyOiBFdmVudEVudmVsb3BlW10gPSBbXTtcbiAgbGV0IGZsdXNoVGltZXI6IE5vZGVKUy5UaW1lb3V0IHwgbnVsbCA9IG51bGw7XG4gIGxldCBzc2VBYm9ydDogQWJvcnRDb250cm9sbGVyIHwgbnVsbCA9IG51bGw7XG4gIGxldCBsYXN0RXZlbnRJZCA9ICcnO1xuICAvKiogXHU2NzJBXHU3N0U1L1x1NzU3OFx1NUY2Mlx1NEZFMVx1NUMwMVx1OEJBMVx1NjU3MChTQ0hFTUFfTUlTTUFUQ0ggXHU5NzYyXHU1NDExXHU4QkNBXHU2NUFELFx1NEUwRFx1NUQyOSlcdTMwMDIgKi9cbiAgbGV0IGRyb3BwZWRGcmFtZXMgPSAwO1xuXG4gIGZ1bmN0aW9uIHB1c2hFdmVudChlbnY6IEV2ZW50RW52ZWxvcGUpOiB2b2lkIHtcbiAgICBldmVudEJ1ZmZlci5wdXNoKGVudik7XG4gICAgaWYgKGV2ZW50QnVmZmVyLmxlbmd0aCA+IDJfMDAwKSBldmVudEJ1ZmZlci5zcGxpY2UoMCwgZXZlbnRCdWZmZXIubGVuZ3RoIC0gMl8wMDApO1xuICAgIGlmIChmbHVzaFRpbWVyID09PSBudWxsKSB7XG4gICAgICBmbHVzaFRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgIGZsdXNoVGltZXIgPSBudWxsO1xuICAgICAgICBjb25zdCBiYXRjaCA9IGV2ZW50QnVmZmVyO1xuICAgICAgICBldmVudEJ1ZmZlciA9IFtdO1xuICAgICAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcbiAgICAgICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCdicmlkZ2U6ZXZlbnQtYmF0Y2gnLCBiYXRjaCk7XG4gICAgICAgIH1cbiAgICAgIH0sIDUwKTtcbiAgICB9XG4gIH1cblxuICBmdW5jdGlvbiBicm9hZGNhc3RIb3N0U3RhdGUoczogSG9zdFN0YXRlLCBpbmZvOiB7IHJlc3RhcnRDb3VudDogbnVtYmVyOyBsYXN0RXJyb3I/OiBzdHJpbmcgfSk6IHZvaWQge1xuICAgIGJyaWRnZSA9IHsgLi4uYnJpZGdlLCBob3N0U3RhdGU6IHMsIGhvc3RQb3J0OiBzdXBlcnZpc29yPy5lbmRwb2ludD8ucG9ydCA/PyBudWxsLCBob3N0VmVyc2lvbjogc3VwZXJ2aXNvcj8uZW5kcG9pbnQ/LnZlcnNpb24gPz8gbnVsbCB9O1xuICAgIGxvZ0luZm8oJ2hvc3QnLCBgc3RhdGU9JHtzfSR7aW5mby5sYXN0RXJyb3IgIT09IHVuZGVmaW5lZCA/IGAgZXJyPSR7aW5mby5sYXN0RXJyb3J9YCA6ICcnfWApO1xuICAgIGZvciAoY29uc3QgdyBvZiBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKSkge1xuICAgICAgaWYgKCF3LmlzRGVzdHJveWVkKCkpIHcud2ViQ29udGVudHMuc2VuZCgnYnJpZGdlOmhvc3Qtc3RhdGUnLCBzLCBpbmZvKTtcbiAgICB9XG4gIH1cblxuICAvKiogU1NFIFx1NkQ0MVx1OEJBMlx1OTYwNTpcdTRGRTFcdTVDMDEoZXZlbnQ6IGhtaClcdTYyNzlcdTkxQ0ZcdTYzQTggcmVuZGVyZXI7XHU5QUQ4XHU5ODkxIGRlbHRhL2xpbmUgXHU1MzlGXHU1RTI3XG4gICAqICBcdTRGNUNcdTRFM0FcdTZENDFcdTU3NTdcdThGNkNcdTUzRDEocmVuZGVyZXIgXHU2MkZDXHU2M0E1XHU1RjUzXHU1MjREIGFzc2lzdGFudCBcdTUzNjBcdTRGNEQpXHUzMDAyXHU2NUFEXHU3RUJGXHU4MUVBXHU1MkE4XHU5MUNEXHU4RkRFXHUzMDAyICovXG4gIGFzeW5jIGZ1bmN0aW9uIHB1bXBFdmVudHMoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKGNsaWVudCA9PT0gbnVsbCkgcmV0dXJuO1xuICAgIGZvciAoOzspIHtcbiAgICAgIGNvbnN0IGMgPSBjbGllbnQ7XG4gICAgICBpZiAoYyA9PT0gbnVsbCkgcmV0dXJuO1xuICAgICAgdHJ5IHtcbiAgICAgICAgZm9yIGF3YWl0IChjb25zdCBmcmFtZSBvZiBjLnJhd0V2ZW50cyhsYXN0RXZlbnRJZCA9PT0gJycgPyB1bmRlZmluZWQgOiBsYXN0RXZlbnRJZCwgc3NlQWJvcnQ/LnNpZ25hbCkpIHtcbiAgICAgICAgICBpZiAoZnJhbWUuZXZlbnQgPT09ICdobWgnKSB7XG4gICAgICAgICAgICBjb25zdCBlbnYgPSBlbnZlbG9wZUZyb21GcmFtZShmcmFtZSk7XG4gICAgICAgICAgICBpZiAoZW52ID09PSBudWxsKSB7XG4gICAgICAgICAgICAgIGRyb3BwZWRGcmFtZXMgKz0gMTtcbiAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBsYXN0RXZlbnRJZCA9IGVudi5ldmVudElkO1xuICAgICAgICAgICAgcHVzaEV2ZW50KGVudik7XG4gICAgICAgICAgfSBlbHNlIGlmIChmcmFtZS5ldmVudCA9PT0gJ2RlbHRhJyB8fCBmcmFtZS5ldmVudCA9PT0gJ2xpbmUnKSB7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICBjb25zdCBkID0gSlNPTi5wYXJzZShmcmFtZS5kYXRhKSBhcyB7IHNlc3Npb25JZD86IHN0cmluZzsgaz86IHN0cmluZzsgY2h1bms/OiBzdHJpbmc7IHRleHQ/OiBzdHJpbmcgfTtcbiAgICAgICAgICAgICAgY29uc3QgcGF5bG9hZCA9IGZyYW1lLmV2ZW50ID09PSAnZGVsdGEnXG4gICAgICAgICAgICAgICAgPyB7IHNlc3Npb25JZDogZC5zZXNzaW9uSWQgPz8gJycsIGtpbmQ6IGQuayA/PyAndGV4dCcsIGNodW5rOiBTdHJpbmcoZC5jaHVuayA/PyAnJykgfVxuICAgICAgICAgICAgICAgIDogeyBzZXNzaW9uSWQ6IGQuc2Vzc2lvbklkID8/ICcnLCBraW5kOiAnbGluZScsIGNodW5rOiBTdHJpbmcoZC50ZXh0ID8/ICcnKSB9O1xuICAgICAgICAgICAgICBmb3IgKGNvbnN0IHcgb2YgQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkpIHtcbiAgICAgICAgICAgICAgICBpZiAoIXcuaXNEZXN0cm95ZWQoKSkgdy53ZWJDb250ZW50cy5zZW5kKCdicmlkZ2U6c3RyZWFtLWNodW5rJywgcGF5bG9hZCk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gY2F0Y2ggeyAvKiBtYWxmb3JtZWQgc3RyZWFtIGZyYW1lOiBza2lwICovIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuOyAvLyBcdTZENDFcdTZCNjNcdTVFMzhcdTdFRDNcdTY3NUYoaG9zdCBcdTUxNzNcdTk1RUQpXG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLy8gXHU2NUFEXHU3RUJGOlx1NzdFRFx1OTAwMFx1OTA3Rlx1NTQwRVx1OTFDRFx1OEZERShzdXBlcnZpc29yIFx1NTNFRlx1ODBGRFx1NkI2M1x1NTcyOFx1OTFDRFx1NTQyRiBob3N0KVxuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCAxXzAwMCkpO1xuICAgICAgICBpZiAoc3NlQWJvcnQ/LnNpZ25hbC5hYm9ydGVkKSByZXR1cm47XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLyogLS0tLSBobWhhcm5lc3MgcnVudGltZSBcdTgxRUFcdTUyQThcdTUzRDFcdTczQjAoMjAyNi0xMC0xMCBcdTc1MjhcdTYyMzdcdTVCOUFcdThDMDM6XHU4OEM1XHU4RkM3IGhtaGFybmVzcyBcdTc2ODRcbiAgICAgXHU2NzNBXHU1NjY4XHU5NkY2XHU5MTREXHU3RjZFXHU3NkY0XHU4RkRFLFx1NTkwRFx1NzUyOCBDTEkvVFVJL3dlYiA3Nzg4IFx1NzY4NFx1NTQwQ1x1NEUwMCBITUhfSE9NRVx1MjAxNFx1MjAxNGNvbmZpZy9wcm92aWRlcnMvXG4gICAgIFx1NEYxQVx1OEJERFx1NTM4Nlx1NTNGMlx1NTkyOVx1NzEzNlx1NTE3MVx1NEVBQilcdTMwMDJcdTUzRDFcdTczQjBcdTk4N0FcdTVFOEY6XHU2NjNFXHU1RjBGXHU5MTREXHU3RjZFID4gd2hlcmUgaG1oID4gbnBtIFx1NTE2OFx1NUM0MCA+IFx1NUUzOFx1ODlDMVx1NkU5MFx1NzgwMVx1NEY0RFx1N0Y2RVx1MzAwMiAqL1xuICBjb25zdCBydW50aW1lQ29uZmlnRmlsZSA9ICgpOiBzdHJpbmcgPT4gam9pbihhcHAuZ2V0UGF0aCgndXNlckRhdGEnKSwgJ3J1bnRpbWUuanNvbicpO1xuICBhc3luYyBmdW5jdGlvbiBsb2FkUnVudGltZUVudHJ5T3ZlcnJpZGUoKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgdiA9IEpTT04ucGFyc2UoYXdhaXQgcmVhZEZpbGUocnVudGltZUNvbmZpZ0ZpbGUoKSwgJ3V0ZjgnKSkgYXMgeyBlbnRyeT86IHVua25vd24gfTtcbiAgICAgIHJldHVybiB0eXBlb2Ygdi5lbnRyeSA9PT0gJ3N0cmluZycgJiYgdi5lbnRyeSAhPT0gJycgJiYgaXNBYnNvbHV0ZSh2LmVudHJ5KSA/IHYuZW50cnkgOiAnJztcbiAgICB9IGNhdGNoIHsgcmV0dXJuICcnOyB9XG4gIH1cbiAgYXN5bmMgZnVuY3Rpb24gc2F2ZVJ1bnRpbWVFbnRyeU92ZXJyaWRlKGVudHJ5OiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBhd2FpdCB3cml0ZUZpbGUocnVudGltZUNvbmZpZ0ZpbGUoKSwgSlNPTi5zdHJpbmdpZnkoeyBlbnRyeSB9LCBudWxsLCAyKSwgJ3V0ZjgnKS5jYXRjaCgoKSA9PiB1bmRlZmluZWQpO1xuICB9XG5cbiAgZnVuY3Rpb24gZGV0ZWN0UmVhbEVudHJ5KCk6IHN0cmluZyB7XG4gICAgLy8gMSkgXHU3M0FGXHU1ODgzXHU1M0Q4XHU5MUNGXHU2NjNFXHU1RjBGXHU4OTg2XHU3NkQ2KFx1OUFEOFx1N0VBN1x1NzUyOFx1NjIzNylcbiAgICBjb25zdCBlbnZFbnRyeSA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX1JFQUxfRU5UUlk7XG4gICAgaWYgKGVudkVudHJ5ICE9PSB1bmRlZmluZWQgJiYgZW52RW50cnkgIT09ICcnICYmIGlzQWJzb2x1dGUoZW52RW50cnkpKSByZXR1cm4gZW52RW50cnk7XG5cbiAgICBjb25zdCByZXBvcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICAgIC8vIDIpIHdoZXJlIGhtaDpucG0gbGluay9cdTUxNjhcdTVDNDBcdTVCODlcdTg4QzVcdTc2ODQgYmluIFx1MjE5MiBub2RlX21vZHVsZXMvaG1oYXJuZXNzIFx1MjE5MiBcdTc3MUYgcmVwbyhucG0gbGluayBcdTY2MkYgc3ltbGluaylcbiAgICB0cnkge1xuICAgICAgY29uc3Qgb3V0ID0gZXhlY0ZpbGVTeW5jKCd3aGVyZScsIFsnaG1oJ10sIHsgZW5jb2Rpbmc6ICd1dGY4JywgdGltZW91dDogNF8wMDAsIHdpbmRvd3NIaWRlOiB0cnVlIH0pO1xuICAgICAgZm9yIChjb25zdCBsaW5lIG9mIG91dC5zcGxpdCgvXFxyP1xcbi8pKSB7XG4gICAgICAgIGNvbnN0IGJpbiA9IGxpbmUudHJpbSgpO1xuICAgICAgICBpZiAoYmluID09PSAnJykgY29udGludWU7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgbGlua2VkID0gam9pbihkaXJuYW1lKGJpbiksICdub2RlX21vZHVsZXMnLCAnaG1oYXJuZXNzJyk7XG4gICAgICAgICAgaWYgKGV4aXN0c1N5bmMobGlua2VkKSkgcmVwb3MuYWRkKHJlYWxwYXRoU3luYyhsaW5rZWQpKTtcbiAgICAgICAgfSBjYXRjaCB7IC8qIGJpbiBcdTVFMDNcdTVDNDBcdTRFMERcdTdCMjYsXHU4REYzXHU4RkM3ICovIH1cbiAgICAgIH1cbiAgICB9IGNhdGNoIHsgLyogaG1oIFx1NEUwRFx1NTcyOCBQQVRIICovIH1cbiAgICAvLyAzKSBucG0gXHU1MTY4XHU1QzQwXHU2ODM5XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IG91dCA9IGV4ZWNGaWxlU3luYygnbnBtJywgWydyb290JywgJy1nJ10sIHsgZW5jb2Rpbmc6ICd1dGY4JywgdGltZW91dDogNl8wMDAsIHdpbmRvd3NIaWRlOiB0cnVlIH0pO1xuICAgICAgY29uc3QgcCA9IGpvaW4ob3V0LnRyaW0oKSwgJ2htaGFybmVzcycpO1xuICAgICAgaWYgKGV4aXN0c1N5bmMocCkpIHJlcG9zLmFkZChyZWFscGF0aFN5bmMocCkpO1xuICAgIH0gY2F0Y2ggeyAvKiBucG0gXHU0RTBEXHU1M0VGXHU3NTI4ICovIH1cbiAgICAvLyA0KSBcdTVFMzhcdTg5QzFcdTZFOTBcdTc4MDFcdTRGNERcdTdGNkUoXHU2NzJDXHU2NzNBXHU1RjAwXHU1M0QxXHU1RTAzXHU1QzQwKVxuICAgIGNvbnN0IGJhc2VzID0gWydDOlxcXFwnLCAnRDpcXFxcJywgJ0U6XFxcXCcsICdGOlxcXFwnLCAnRzpcXFxcJywgJ0g6XFxcXCcsIGhvbWVkaXIoKSwgam9pbihob21lZGlyKCksICdEZXZlbG9wZXInKV07XG4gICAgZm9yIChjb25zdCBiYXNlIG9mIGJhc2VzKSB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBwID0gcmVzb2x2ZShiYXNlLCAnaG1oYXJuZXNzJyk7XG4gICAgICAgIGlmIChleGlzdHNTeW5jKHApKSByZXBvcy5hZGQocCk7XG4gICAgICB9IGNhdGNoIHsgLyogXHU3NkQ4XHU0RTBEXHU1QjU4XHU1NzI4ICovIH1cbiAgICB9XG4gICAgLy8gXHU1NDdEXHU0RTJEXHU3Njg0IHJlcG8gXHU1RkM1XHU5ODdCXHU2NzA5IGRlc2t0b3AtaG9zdCBcdTUxNjVcdTUzRTNcdTRFMEVcdTRGOURcdThENTZcdTVFMDNcdTVDNDBcbiAgICBmb3IgKGNvbnN0IHJlcG8gb2YgcmVwb3MpIHtcbiAgICAgIGNvbnN0IGVudHJ5ID0gam9pbihyZXBvLCAncGFja2FnZXMnLCAnd2ViJywgJ3NyYycsICdkZXNrdG9wLWhvc3QudHMnKTtcbiAgICAgIGlmIChleGlzdHNTeW5jKGVudHJ5KSAmJiBleGlzdHNTeW5jKGpvaW4ocmVwbywgJ25vZGVfbW9kdWxlcycpKSkgcmV0dXJuIGVudHJ5O1xuICAgIH1cbiAgICByZXR1cm4gJyc7XG4gIH1cblxuICAvKiogXHU4OUUzXHU2NzkwIHJ1bnRpbWUgXHU1MTY1XHU1M0UzXHU2MjQwXHU1QzVFXHU3Njg0IGhtaGFybmVzcyBcdTRFRDNcdTVFOTNcdTY4MzkocGFja2FnZXMvd2ViL3NyY3xkaXN0IFx1NEUwQVx1NkVBRilcdTMwMDIgKi9cbiAgZnVuY3Rpb24gcmVwb1Jvb3RPZihlbnRyeTogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBsZXQgZGlyID0gZGlybmFtZShlbnRyeSk7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCA2OyBpKyspIHtcbiAgICAgIGlmIChleGlzdHNTeW5jKGpvaW4oZGlyLCAncGFja2FnZS5qc29uJykpICYmIGV4aXN0c1N5bmMoam9pbihkaXIsICdwYWNrYWdlcycsICd3ZWInKSkpIHJldHVybiBkaXI7XG4gICAgICBjb25zdCBwYXJlbnQgPSBkaXJuYW1lKGRpcik7XG4gICAgICBpZiAocGFyZW50ID09PSBkaXIpIGJyZWFrO1xuICAgICAgZGlyID0gcGFyZW50O1xuICAgIH1cbiAgICByZXR1cm4gZGlybmFtZShlbnRyeSk7XG4gIH1cblxuICBsZXQgcnVudGltZUVudHJ5ID0gJyc7IC8vIFx1NUY1M1x1NTI0RFx1NUI5RVx1OTY0NVx1NEY3Rlx1NzUyOFx1NzY4NFx1NzcxRlx1NUI5RSBydW50aW1lIFx1NTE2NVx1NTNFMygnJz1cdTY3MkFcdTYzQTUpXG5cbiAgLyoqIGRldiBcdThGREVcdTRFRDNcdTVFOTNcdTUxODUgaG1oYXJuZXNzO1x1NjI1M1x1NTMwNVx1NEVBN1x1NTRDMVx1ODFFQVx1NTJBOFx1NTNEMVx1NzNCMChcdTUzRDFcdTczQjBcdTRFMERcdTUyMzBcdTIxOTJcdTZGMTRcdTc5M0FcdTZBMjFcdTVGMEYrXHU1RjE1XHU1QkZDKVx1MzAwMiAqL1xuICBhc3luYyBmdW5jdGlvbiBzdGFydEhvc3QoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgcmVwb1Jvb3QgPSBqb2luKGhlcmUsICcuLicsICcuLicsICcuLicsICcuLicpOyAvLyBhcHBzL2Rlc2t0b3AvZGlzdC1lbGVjdHJvbi9tYWluIFx1MjE5MiByZXBvIHJvb3RcbiAgICBjb25zdCBwYWNrYWdlZCA9IGFwcC5pc1BhY2thZ2VkO1xuICAgIC8vIFx1NzcxRlx1NUI5RVx1NTE2NVx1NTNFM1x1ODlFM1x1Njc5MDpcdTkxNERcdTdGNkVcdTg5ODZcdTc2RDYgPiBcdTgxRUFcdTUyQThcdTUzRDFcdTczQjAoZGV2IFx1NzZGNFx1NjNBNVx1NzUyOFx1NzZGOFx1OTBCQlx1NEVEM1x1NUU5Myk7XG4gICAgLy8gSE1IX0RFU0tUT1BfRkFLRT0xIFx1NUYzQVx1NTIzNlx1NkYxNFx1NzkzQVx1NkEyMVx1NUYwRihcdTVGRUJcdTkwMUYvXHU3ODZFXHU1QjlBXHU2MDI3XHU2RDRCXHU4QkQ1XHU0RTBFXHU1MTkyXHU3MERGKVxuICAgIGNvbnN0IGZvcmNlRmFrZSA9IHByb2Nlc3MuZW52LkhNSF9ERVNLVE9QX0ZBS0UgPT09ICcxJztcbiAgICBjb25zdCBvdmVycmlkZSA9IGF3YWl0IGxvYWRSdW50aW1lRW50cnlPdmVycmlkZSgpO1xuICAgIHJ1bnRpbWVFbnRyeSA9IGZvcmNlRmFrZVxuICAgICAgPyAnJ1xuICAgICAgOiBvdmVycmlkZSAhPT0gJydcbiAgICAgICAgPyBvdmVycmlkZVxuICAgICAgICA6IHBhY2thZ2VkXG4gICAgICAgICAgPyBkZXRlY3RSZWFsRW50cnkoKVxuICAgICAgICAgIDogam9pbihyZXBvUm9vdCwgJy4uJywgJ2htaGFybmVzcycsICdwYWNrYWdlcycsICd3ZWInLCAnc3JjJywgJ2Rlc2t0b3AtaG9zdC50cycpO1xuICAgIGNvbnN0IHVzZVJlYWwgPSBydW50aW1lRW50cnkgIT09ICcnICYmIGV4aXN0c1N5bmMocnVudGltZUVudHJ5KTtcbiAgICBicmlkZ2UgPSB7IC4uLmJyaWRnZSwgbW9kZTogdXNlUmVhbCA/ICdyZWFsJyA6ICdmYWtlJywgcnVudGltZUVudHJ5OiB1c2VSZWFsID8gcnVudGltZUVudHJ5IDogbnVsbCB9O1xuICAgIGxldCBzcGVjOiB7IGNvbW1hbmQ6IHN0cmluZzsgYXJnczogc3RyaW5nW107IGVudjogUmVjb3JkPHN0cmluZywgc3RyaW5nPjsgY3dkPzogc3RyaW5nIH07XG4gICAgaWYgKHVzZVJlYWwpIHtcbiAgICAgIGNvbnN0IHJlcG8gPSByZXBvUm9vdE9mKHJ1bnRpbWVFbnRyeSk7XG4gICAgICBzcGVjID0ge1xuICAgICAgICBjb21tYW5kOiBwcm9jZXNzLmV4ZWNQYXRoLFxuICAgICAgICBhcmdzOiBbJy0taW1wb3J0JywgJ3RzeCcsIHJ1bnRpbWVFbnRyeV0sXG4gICAgICAgIGN3ZDogcmVwbywgLy8gYmFyZSAndHN4JyBcdTRFMEUgd29ya3NwYWNlIFx1NEY5RFx1OEQ1Nlx1OTBGRFx1NEVDRSByZXBvIFx1NzY4NCBub2RlX21vZHVsZXMgXHU4OUUzXHU2NzkwXG4gICAgICAgIGVudjogeyBFTEVDVFJPTl9SVU5fQVNfTk9ERTogJzEnIH0sXG4gICAgICB9O1xuICAgIH0gZWxzZSBpZiAocGFja2FnZWQpIHtcbiAgICAgIHNwZWMgPSB7XG4gICAgICAgIGNvbW1hbmQ6IHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgICAgIGFyZ3M6IFtqb2luKHByb2Nlc3MucmVzb3VyY2VzUGF0aCwgJ2Zha2UtaG9zdC5janMnKV0sXG4gICAgICAgIGVudjogeyBFTEVDVFJPTl9SVU5fQVNfTk9ERTogJzEnIH0sXG4gICAgICB9O1xuICAgIH0gZWxzZSB7XG4gICAgICBzcGVjID0ge1xuICAgICAgICBjb21tYW5kOiBwcm9jZXNzLmV4ZWNQYXRoLFxuICAgICAgICAvLyBcdTc2RjRcdTYzQTVcdThENzBcdTUzMDVcdTc3MUZcdTVCOUVcdThERUZcdTVGODQobm9kZV9tb2R1bGVzIFx1OTFDQ1x1NzY4NCB3b3Jrc3BhY2UganVuY3Rpb24gXHU0RjFBXHU4OEFCIEVTTVxuICAgICAgICAvLyByZWFscGF0aCBcdTUzMTYsXHU1QkZDXHU4MUY0IGZha2UtaG9zdCBcdTc2ODQgYXJndlsxXS9pbXBvcnQubWV0YS51cmwgXHU1MzM5XHU5MTREXHU1OTMxXHU2NTQ4KVxuICAgICAgICBhcmdzOiBbJy0taW1wb3J0JywgJ3RzeCcsIGpvaW4ocmVwb1Jvb3QsICdwYWNrYWdlcycsICdob3N0LWFkYXB0ZXInLCAnc3JjJywgJ2Zha2UtaG9zdC50cycpXSxcbiAgICAgICAgZW52OiB7IEVMRUNUUk9OX1JVTl9BU19OT0RFOiAnMScgfSxcbiAgICAgIH07XG4gICAgfVxuICAgIHN1cGVydmlzb3IgPSBuZXcgRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yKHNwZWMsIHtcbiAgICAgIG9uU3RhdGVDaGFuZ2U6IGJyb2FkY2FzdEhvc3RTdGF0ZSxcbiAgICAgIC8vIFx1OTk5Nlx1NkIyMVx1NTQyRlx1NTJBOFx1NEUwRSBjcmFzaCBcdTgxRUFcdTYxMDhcdTU0MEVcdTc2ODRcdTkxQ0RcdTU0MkZcdTkwRkRcdTRGMUFcdThENzBcdThGRDlcdTkxQ0M6XHU3QUVGXHU1M0UzL3Rva2VuIFx1OTBGRFx1NjYyRlx1NjVCMFx1NzY4NCxcbiAgICAgIC8vIFx1OTFDRFx1NUVGQVx1Njg2NVx1NUJBMlx1NjIzN1x1N0FFRlx1NUU3Nlx1OTFDRFx1NjVCMFx1OEJBMlx1OTYwNSBTU0UocmVuZGVyZXIgXHU3Njg0IEV2ZW50U3RvcmUgXHU5NzYwIGV2ZW50SWQgXHU1M0JCXHU5MUNEKVxuICAgICAgb25SZWFkeTogKGVwKSA9PiB7XG4gICAgICAgIGNsaWVudCA9IG5ldyBEZXNrdG9wSG9zdENsaWVudChgaHR0cDovLzEyNy4wLjAuMToke2VwLnBvcnR9YCwgZXAudG9rZW4pO1xuICAgICAgICBzc2VBYm9ydD8uYWJvcnQoKTtcbiAgICAgICAgc3NlQWJvcnQgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gICAgICAgIGxhc3RFdmVudElkID0gJyc7XG4gICAgICAgIHZvaWQgcHVtcEV2ZW50cygpO1xuICAgICAgICBsb2dJbmZvKCdob3N0JywgYGJyaWRnZSByZWFkeSBvbiAxMjcuMC4wLjE6JHtlcC5wb3J0fSAocnVudGltZSAke2VwLnZlcnNpb259LCBtb2RlICR7YnJpZGdlLm1vZGV9JHt1c2VSZWFsID8gYCwgZW50cnk9JHtydW50aW1lRW50cnl9YCA6ICcnfSlgKTtcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IHN1cGVydmlzb3Iuc3RhcnQoKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGNvbnN0IGRldGFpbCA9ICgoKSA9PiB7IHRyeSB7IHJldHVybiBKU09OLnN0cmluZ2lmeShlcnIpOyB9IGNhdGNoIHsgcmV0dXJuIFN0cmluZyhlcnIpOyB9IH0pKCkuc2xpY2UoMCwgNDAwKTtcbiAgICAgIGJyaWRnZSA9IHsgLi4uYnJpZGdlLCBob3N0U3RhdGU6ICdmYWlsZWQnLCBsYXN0RXJyb3I6IGRldGFpbCB9O1xuICAgICAgbG9nSW5mbygnaG9zdCcsIGBzdGFydCBmYWlsZWQ6ICR7ZGV0YWlsfWApO1xuICAgIH1cbiAgfVxuXG4gIC8qIC0tLS0gSVBDIFx1NzY3RFx1NTQwRFx1NTM1NSArIHNlbmRlciBcdTY4MjFcdTlBOEMgLS0tLSAqL1xuICBjb25zdCBhbGxvd2VkT3JpZ2lucyA9IG5ldyBTZXQ8c3RyaW5nPihcbiAgICBpc0RldiAmJiByZW5kZXJlckRldlVybFxuICAgICAgPyBbcmVuZGVyZXJEZXZVcmxdXG4gICAgICA6IFtwYXRoVG9GaWxlVVJMKGpvaW4oaGVyZSwgJy4uJywgJy4uJywgJ2Rpc3QtcmVuZGVyZXInLCAnaW5kZXguaHRtbCcpKS5ocmVmXSxcbiAgKTtcblxuICBmdW5jdGlvbiBzZW5kZXJUcnVzdGVkKHNlbmRlckZyYW1lOiBFbGVjdHJvbi5XZWJGcmFtZU1haW4gfCBudWxsIHwgdW5kZWZpbmVkKTogYm9vbGVhbiB7XG4gICAgaWYgKHNlbmRlckZyYW1lID09PSBudWxsIHx8IHNlbmRlckZyYW1lID09PSB1bmRlZmluZWQpIHJldHVybiBmYWxzZTtcbiAgICBsZXQgdG9wOiBFbGVjdHJvbi5XZWJGcmFtZU1haW4gfCBudWxsID0gc2VuZGVyRnJhbWU7XG4gICAgd2hpbGUgKHRvcD8ucGFyZW50ICE9PSBudWxsICYmIHRvcD8ucGFyZW50ICE9PSB1bmRlZmluZWQpIHRvcCA9IHRvcC5wYXJlbnQ7XG4gICAgY29uc3QgdXJsID0gdG9wPy51cmwgPz8gJyc7XG4gICAgZm9yIChjb25zdCBvcmlnaW4gb2YgYWxsb3dlZE9yaWdpbnMpIHtcbiAgICAgIGlmICh1cmwgPT09IG9yaWdpbiB8fCB1cmwuc3RhcnRzV2l0aChgJHtvcmlnaW59L2ApIHx8IHVybC5zdGFydHNXaXRoKGAke29yaWdpbn0/YCkpIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICAvKiogXHU5NzAwXHU4OTgxIGhvc3QgXHU1QzMxXHU3RUVBXHU3Njg0IElQQyBoYW5kbGVyIFx1NTE2Q1x1NTE3MVx1NThGMzpcdTY3MkFcdTVDMzFcdTdFRUFcdThGRDRcdTU2REVcdTdFRDNcdTY3ODRcdTUzMTZcdTk1MTlcdThCRUZcdTMwMDIgKi9cbiAgZnVuY3Rpb24gaG9zdENhbGw8VD4oZXZlbnQ6IEVsZWN0cm9uLklwY01haW5JbnZva2VFdmVudCwgZm46IChjOiBEZXNrdG9wSG9zdENsaWVudCkgPT4gUHJvbWlzZTxUPik6IFByb21pc2U8VCB8IHsgZXJyb3I6IHN0cmluZzsgY29kZTogc3RyaW5nIH0+IHtcbiAgICBpZiAoIXNlbmRlclRydXN0ZWQoZXZlbnQuc2VuZGVyRnJhbWUpKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfSk7XG4gICAgaWYgKGNsaWVudCA9PT0gbnVsbCB8fCBicmlkZ2UuaG9zdFN0YXRlICE9PSAncmVhZHknKSB7XG4gICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6IGBob3N0IG5vdCByZWFkeSAoJHticmlkZ2UuaG9zdFN0YXRlfSlgLCBjb2RlOiAnSE9TVF9OT1RfUkVBRFknIH0pO1xuICAgIH1cbiAgICByZXR1cm4gZm4oY2xpZW50KS5jYXRjaCgoZXJyOiB1bmtub3duKSA9PiB7XG4gICAgICBjb25zdCBkZXRhaWwgPSAoKCkgPT4geyB0cnkgeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkoZXJyKTsgfSBjYXRjaCB7IHJldHVybiBTdHJpbmcoZXJyKTsgfSB9KSgpLnNsaWNlKDAsIDMwMCk7XG4gICAgICByZXR1cm4geyBlcnJvcjogZGV0YWlsLCBjb2RlOiAnQlJJREdFX0VSUk9SJyB9O1xuICAgIH0pO1xuICB9XG5cbiAgZnVuY3Rpb24gcmVnaXN0ZXJJcGMoKTogdm9pZCB7XG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpnZXQtc3RhdGUnLCAoZXZlbnQpID0+IHtcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicgfTtcbiAgICAgIHJldHVybiB7IC4uLmJyaWRnZSwgZHJvcHBlZEZyYW1lcyB9O1xuICAgIH0pO1xuXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpzZXNzaW9ucycsIChldmVudCkgPT5cbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPHsgc2Vzc2lvbnM6IEFycmF5PHsgaWQ6IHN0cmluZzsgdGl0bGU6IHN0cmluZzsgdGFzazogc3RyaW5nOyBvdXRjb21lOiBzdHJpbmc7IHR1cm5zOiBudW1iZXI7IHRvb2xVc2VzOiBudW1iZXI7IHRpbWU6IHN0cmluZzsgY3dkOiBzdHJpbmc7IGNyZWF0ZWRBdDogc3RyaW5nOyB1cGRhdGVkQXQ6IHN0cmluZyB9PiB9PignL2FwaS9zZXNzaW9ucz9saW1pdD0xMDAnKSkpO1xuXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpzZW5kLXRhc2snLCAoZXZlbnQsIHRleHQ6IHVua25vd24sIHNlc3Npb25JZDogdW5rbm93biwgbW9kZTogdW5rbm93biwgYXR0YWNobWVudHM6IHVua25vd24pID0+IHtcbiAgICAgIGNvbnN0IHRhc2sgPSB0eXBlb2YgdGV4dCA9PT0gJ3N0cmluZycgPyB0ZXh0LnNsaWNlKDAsIDIwXzAwMCkgOiAnJztcbiAgICAgIGNvbnN0IHNpZCA9IHR5cGVvZiBzZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gc2Vzc2lvbklkLnNsaWNlKDAsIDgwKSA6ICcnO1xuICAgICAgY29uc3QgbSA9IG1vZGUgPT09ICdhdXRvJyB8fCBtb2RlID09PSAneW9sbycgPyBtb2RlIDogJ2Fzayc7XG4gICAgICAvLyBcdTk2NDRcdTRFRjY6XHU1NDBFXHU3QUVGXHU2Mzg4XHU2NzQzIERUTyBcdTc2ODRcdTdFRERcdTVCRjlcdThERUZcdTVGODQoQCBcdTkwMDlcdTYyRTlcdTU2NjhcdTUzRUFcdTY3NjVcdTgxRUEgL2FwaS9mcy9zZWFyY2gpXG4gICAgICBjb25zdCBhdHRzID0gQXJyYXkuaXNBcnJheShhdHRhY2htZW50cykgPyBhdHRhY2htZW50cy5maWx0ZXIoKGEpOiBhIGlzIHN0cmluZyA9PiB0eXBlb2YgYSA9PT0gJ3N0cmluZycpLnNsaWNlKDAsIDEwKSA6IFtdO1xuICAgICAgaWYgKHRhc2sgPT09ICcnIHx8IHNpZCA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBvazogZmFsc2UsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW47IHJ1bklkPzogc3RyaW5nIH0+KCcvYXBpL3Rhc2snLCB7IHRleHQ6IHRhc2ssIHNlc3Npb25JZDogc2lkLCBtb2RlOiBtLCBhdHRhY2htZW50czogYXR0cyB9KSk7XG4gICAgfSk7XG5cbiAgICAvLyAtLS0tIEAgXHU5NjQ0XHU0RUY2Olx1NURFNVx1NEY1Q1x1NTMzQVx1NjU4N1x1NEVGNlx1NjQxQ1x1N0QyMihydW50aW1lIFx1NjM4OFx1Njc0M1x1NzY4NFx1OERFRlx1NUY4NFx1Njc2NVx1NkU5MCkgLS0tLVxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6ZnMtc2VhcmNoJywgKGV2ZW50LCBxOiB1bmtub3duKSA9PiB7XG4gICAgICBjb25zdCBxdWVyeSA9IHR5cGVvZiBxID09PSAnc3RyaW5nJyA/IHEuc2xpY2UoMCwgMjAwKSA6ICcnO1xuICAgICAgaWYgKHF1ZXJ5ID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IHJlc3VsdHM6IFtdIH0pO1xuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPHsgcmVzdWx0czogQXJyYXk8eyByZWw6IHN0cmluZzsgcGF0aDogc3RyaW5nIH0+IH0+KGAvYXBpL2ZzL3NlYXJjaD9xPSR7ZW5jb2RlVVJJQ29tcG9uZW50KHF1ZXJ5KX1gKSk7XG4gICAgfSk7XG5cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmFwcHJvdmUnLCAoZXZlbnQsIGdyYW50ZWQ6IHVua25vd24sIHNlc3Npb25JZDogdW5rbm93bikgPT5cbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KCcvYXBpL2FwcHJvdmUnLCB7XG4gICAgICAgIGdyYW50ZWQ6IGdyYW50ZWQgPT09IHRydWUsXG4gICAgICAgIHNlc3Npb25JZDogdHlwZW9mIHNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBzZXNzaW9uSWQuc2xpY2UoMCwgODApIDogJycsXG4gICAgICB9KSkpO1xuXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTppbnRlcnJ1cHQnLCAoZXZlbnQsIHNlc3Npb25JZDogdW5rbm93bikgPT5cbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5wb3N0SnNvbjx7IG9rOiBib29sZWFuIH0+KCcvYXBpL2ludGVycnVwdCcsIHtcbiAgICAgICAgc2Vzc2lvbklkOiB0eXBlb2Ygc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IHNlc3Npb25JZC5zbGljZSgwLCA4MCkgOiAnJyxcbiAgICAgIH0pKSk7XG5cbiAgICAvLyAtLS0tIE00Olx1NURFNVx1NEY1Q1x1NTMzQVx1NjU4N1x1NEVGNlx1OTc2MihcdThERUZcdTVGODRcdTYzODhcdTY3NDNcdTU3MjggcnVudGltZTppbnNpZGVXcyBcdTY4MjFcdTlBOEMpIC0tLS1cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmZzLWxpc3QnLCAoZXZlbnQsIHBhdGg6IHVua25vd24pID0+IHtcbiAgICAgIGNvbnN0IHAgPSB0eXBlb2YgcGF0aCA9PT0gJ3N0cmluZycgPyBwYXRoLnNsaWNlKDAsIDEwMDApIDogJyc7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KGAvYXBpL2ZzP2ZpbGVzPTEke3AgIT09ICcnID8gYCZwYXRoPSR7ZW5jb2RlVVJJQ29tcG9uZW50KHApfWAgOiAnJ31gKSk7XG4gICAgfSk7XG5cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmZzLXJlYWQnLCAoZXZlbnQsIHBhdGg6IHVua25vd24pID0+IHtcbiAgICAgIGNvbnN0IHAgPSB0eXBlb2YgcGF0aCA9PT0gJ3N0cmluZycgPyBwYXRoLnNsaWNlKDAsIDEwMDApIDogJyc7XG4gICAgICBpZiAocCA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ3BhdGggcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xuICAgICAgcmV0dXJuIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPFJlY29yZDxzdHJpbmcsIHVua25vd24+PihgL2FwaS9mcy9yZWFkP3BhdGg9JHtlbmNvZGVVUklDb21wb25lbnQocCl9YCkpO1xuICAgIH0pO1xuXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTppbmplY3QnLCAoZXZlbnQsIHRleHQ6IHVua25vd24sIHNlc3Npb25JZDogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3QgdCA9IHR5cGVvZiB0ZXh0ID09PSAnc3RyaW5nJyA/IHRleHQuc2xpY2UoMCwgMjBfMDAwKSA6ICcnO1xuICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIHNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBzZXNzaW9uSWQuc2xpY2UoMCwgODApIDogJyc7XG4gICAgICBpZiAodCA9PT0gJycgfHwgc2lkID09PSAnJykgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IG9rOiBmYWxzZSwgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PignL2FwaS9pbmplY3QnLCB7IHRleHQ6IHQsIHNlc3Npb25JZDogc2lkIH0pKTtcbiAgICB9KTtcblxuICAgIC8vIC0tLS0gXHU0RjFBXHU4QkREXHU1QkZDXHU1MUZBKGV4cG9ydC5tZCBcdTIxOTIgXHU0RkREXHU1QjU4XHU1QkY5XHU4QkREXHU2ODQ2O1x1NjU4N1x1NEVGNlx1NTE5OVx1NTE2NVx1NTNFQVx1NTcyOCBtYWluKSAtLS0tXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpleHBvcnQtc2Vzc2lvbicsIGFzeW5jIChldmVudCwgaWQ6IHVua25vd24pID0+IHtcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XG4gICAgICBjb25zdCBzaWQgPSB0eXBlb2YgaWQgPT09ICdzdHJpbmcnID8gaWQucmVwbGFjZSgvW15hLXpBLVowLTlfOi5ALV0vZywgJycpLnNsaWNlKDAsIDgwKSA6ICcnO1xuICAgICAgaWYgKHNpZCA9PT0gJycpIHJldHVybiB7IGVycm9yOiAnaWQgcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH07XG4gICAgICBpZiAoY2xpZW50ID09PSBudWxsIHx8IGJyaWRnZS5ob3N0U3RhdGUgIT09ICdyZWFkeScpIHJldHVybiB7IGVycm9yOiBgaG9zdCBub3QgcmVhZHkgKCR7YnJpZGdlLmhvc3RTdGF0ZX0pYCwgY29kZTogJ0hPU1RfTk9UX1JFQURZJyB9O1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgbWQgPSBhd2FpdCBjbGllbnQuZ2V0VGV4dChgL2FwaS9zZXNzaW9ucy8ke2VuY29kZVVSSUNvbXBvbmVudChzaWQpfS9leHBvcnQubWRgKTtcbiAgICAgICAgY29uc3Qgd2luID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkuZmluZCgodykgPT4gIXcuaXNEZXN0cm95ZWQoKSk7XG4gICAgICAgIGlmICh3aW4gPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgZXJyb3I6ICdubyB3aW5kb3cnLCBjb2RlOiAnQlJJREdFX0VSUk9SJyB9O1xuICAgICAgICBjb25zdCByID0gYXdhaXQgZGlhbG9nLnNob3dTYXZlRGlhbG9nKHdpbiwge1xuICAgICAgICAgIHRpdGxlOiAnXHU1QkZDXHU1MUZBXHU0RjFBXHU4QkREJyxcbiAgICAgICAgICBkZWZhdWx0UGF0aDogYGhtaC0ke3NpZH0ubWRgLFxuICAgICAgICAgIGZpbHRlcnM6IFt7IG5hbWU6ICdNYXJrZG93bicsIGV4dGVuc2lvbnM6IFsnbWQnXSB9XSxcbiAgICAgICAgfSk7XG4gICAgICAgIGlmIChyLmNhbmNlbGVkIHx8IHIuZmlsZVBhdGggPT09IHVuZGVmaW5lZCB8fCByLmZpbGVQYXRoID09PSAnJykgcmV0dXJuIHsgb2s6IGZhbHNlLCBjYW5jZWxlZDogdHJ1ZSB9O1xuICAgICAgICBhd2FpdCB3cml0ZUZpbGUoci5maWxlUGF0aCwgbWQsICd1dGY4Jyk7XG4gICAgICAgIGxvZ0luZm8oJ2V4cG9ydCcsIGBzZXNzaW9uICR7c2lkfSBcdTIxOTIgJHtyLmZpbGVQYXRofWApO1xuICAgICAgICByZXR1cm4geyBvazogdHJ1ZSwgcGF0aDogci5maWxlUGF0aCB9O1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGNvbnN0IGRldGFpbCA9ICgoKSA9PiB7IHRyeSB7IHJldHVybiBKU09OLnN0cmluZ2lmeShlcnIpOyB9IGNhdGNoIHsgcmV0dXJuIFN0cmluZyhlcnIpOyB9IH0pKCkuc2xpY2UoMCwgMzAwKTtcbiAgICAgICAgcmV0dXJuIHsgZXJyb3I6IGRldGFpbCwgY29kZTogJ0JSSURHRV9FUlJPUicgfTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIC8vIC0tLS0gXHU1QkExXHU2Mjc5XHU2QTIxXHU1RjBGXHU4QkZCXHU1MTk5KFx1Njc0M1x1NUEwMVx1NTcyOCBydW50aW1lIGNvbmZpZztcdTUyMDdcdTYzNjJcdTVGQzVcdTk4N0JcdTY2M0VcdTVGMEYpIC0tLS1cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmFwcHJvdmFsLWdldCcsIChldmVudCkgPT5cbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPHsgc2V0dGluZ3M/OiB7IGFwcHJvdmFsPzogc3RyaW5nIH0gfT4oJy9hcGkvc3RhdGUnKSkpO1xuXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTphcHByb3ZhbC1zZXQnLCAoZXZlbnQsIG1vZGU6IHVua25vd24pID0+IHtcbiAgICAgIGNvbnN0IG0gPSBtb2RlID09PSAnYXV0bycgPyAnYXV0bycgOiBtb2RlID09PSAnYXNrJyA/ICdhc2snIDogJyc7XG4gICAgICBpZiAobSA9PT0gJycpIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBlcnJvcjogJ21vZGUgbXVzdCBiZSBhc2t8YXV0bycsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvY29uZmlnJywgeyBhcHByb3ZhbDogbSB9KSk7XG4gICAgfSk7XG5cbiAgICAvLyAtLS0tIGhtaGFybmVzcyBydW50aW1lIFx1OEZERVx1NjNBNShcdTgxRUFcdTUyQThcdTUzRDFcdTczQjAgKyBcdTYyNEJcdTUyQThcdTg5ODZcdTc2RDYgKyBcdTcwRURcdTUyMDdcdTYzNjIpIC0tLS1cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnJ1bnRpbWUtaW5mbycsIChldmVudCkgPT4ge1xuICAgICAgaWYgKCFzZW5kZXJUcnVzdGVkKGV2ZW50LnNlbmRlckZyYW1lKSkgcmV0dXJuIHsgZXJyb3I6ICd1bnRydXN0ZWQgc2VuZGVyJywgY29kZTogJ0ZPUkJJRERFTicgfTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG1vZGU6IGJyaWRnZS5tb2RlLFxuICAgICAgICBydW50aW1lRW50cnk6IGJyaWRnZS5ydW50aW1lRW50cnksXG4gICAgICAgIG92ZXJyaWRlOiBsb2FkUnVudGltZUVudHJ5T3ZlcnJpZGUoKSxcbiAgICAgICAgZGV0ZWN0ZWQ6IGRldGVjdFJlYWxFbnRyeSgpLFxuICAgICAgfTtcbiAgICB9KTtcblxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6YnJvd3NlLXJ1bnRpbWUnLCBhc3luYyAoZXZlbnQpID0+IHtcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XG4gICAgICBjb25zdCB3aW4gPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5maW5kKCh3KSA9PiAhdy5pc0Rlc3Ryb3llZCgpKTtcbiAgICAgIGlmICh3aW4gPT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgZXJyb3I6ICdubyB3aW5kb3cnLCBjb2RlOiAnQlJJREdFX0VSUk9SJyB9O1xuICAgICAgY29uc3QgciA9IGF3YWl0IGRpYWxvZy5zaG93T3BlbkRpYWxvZyh3aW4sIHtcbiAgICAgICAgdGl0bGU6ICdcdTkwMDlcdTYyRTkgaG1oYXJuZXNzIFx1NzY4NCBkZXNrdG9wLWhvc3QgXHU1MTY1XHU1M0UzJyxcbiAgICAgICAgcHJvcGVydGllczogWydvcGVuRmlsZSddLFxuICAgICAgICBmaWx0ZXJzOiBbeyBuYW1lOiAnZGVza3RvcC1ob3N0JywgZXh0ZW5zaW9uczogWyd0cycsICdqcyddIH1dLFxuICAgICAgfSk7XG4gICAgICBpZiAoci5jYW5jZWxlZCB8fCByLmZpbGVQYXRoc1swXSA9PT0gdW5kZWZpbmVkKSByZXR1cm4geyBvazogZmFsc2UsIGNhbmNlbGVkOiB0cnVlIH07XG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgZW50cnk6IHIuZmlsZVBhdGhzWzBdIH07XG4gICAgfSk7XG5cbiAgICAvKiogXHU4QkJFXHU3RjZFL1x1NkUwNVx1OTY2NFx1NjI0Qlx1NTJBOFx1NTE2NVx1NTNFM1x1NTQwRVx1NzBFRFx1OTFDRFx1NTQyRiBob3N0KFx1N0E3QVx1NEUzMj1cdTU2REVcdTUyMzBcdTgxRUFcdTUyQThcdTUzRDFcdTczQjApXHUzMDAyICovXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpzZXQtcnVudGltZScsIGFzeW5jIChldmVudCwgZW50cnk6IHVua25vd24pID0+IHtcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicsIGNvZGU6ICdGT1JCSURERU4nIH07XG4gICAgICBjb25zdCBlID0gdHlwZW9mIGVudHJ5ID09PSAnc3RyaW5nJyA/IGVudHJ5LnRyaW0oKSA6ICcnO1xuICAgICAgaWYgKGUgIT09ICcnICYmICghaXNBYnNvbHV0ZShlKSB8fCAhZXhpc3RzU3luYyhlKSkpIHtcbiAgICAgICAgcmV0dXJuIHsgZXJyb3I6ICdcdTUxNjVcdTUzRTNcdTVGQzVcdTk4N0JcdTY2MkZcdTVCNThcdTU3MjhcdTc2ODRcdTdFRERcdTVCRjlcdThERUZcdTVGODQoZGVza3RvcC1ob3N0LnRzKScsIGNvZGU6ICdCQURfUkVRVUVTVCcgfTtcbiAgICAgIH1cbiAgICAgIGF3YWl0IHNhdmVSdW50aW1lRW50cnlPdmVycmlkZShlKTtcbiAgICAgIC8vIFx1NzBFRFx1NTIwN1x1NjM2MjpcdTUxNDhcdTRGMThcdTk2QzVcdTUwNUNcdTYzODlcdTVGNTNcdTUyNEQgaG9zdCxcdTUxOERcdTYzMDlcdTY1QjBcdTkxNERcdTdGNkVcdTYyQzlcdThENzdcbiAgICAgIHNzZUFib3J0Py5hYm9ydCgpO1xuICAgICAgaWYgKHN1cGVydmlzb3IgIT09IG51bGwpIGF3YWl0IHN1cGVydmlzb3Iuc3RvcCgpO1xuICAgICAgYXdhaXQgc3RhcnRIb3N0KCk7XG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgbW9kZTogYnJpZGdlLm1vZGUgfTtcbiAgICB9KTtcblxuICAgIC8vIC0tLS0gUHJvdmlkZXIgXHU4QkJFXHU3RjZFKDAzIFx1MDBBN1x1NEUwMzprZXkgXHU1M0VBXHU1MUZBIGhhc0tleS9cdTY3MkJcdTU2REJcdTRGNEQ7XHU0RkREXHU1QjU4XHU3NkY0XHU1MTk5IHJ1bnRpbWUpIC0tLS1cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnByb3ZpZGVycycsIChldmVudCkgPT5cbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPHsgcHJvdmlkZXJzRGV0YWlsPzogQXJyYXk8eyBuYW1lOiBzdHJpbmc7IG1vZGVsOiBzdHJpbmc7IGJhc2VVcmw6IHN0cmluZzsgaGFzS2V5OiBib29sZWFuOyBrZXlUYWlsPzogc3RyaW5nIH0+OyBtb2RlbD86IHN0cmluZyB9PignL2FwaS9zdGF0ZScpKSk7XG5cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOnByb3ZpZGVyLXNhdmUnLCAoZXZlbnQsIHByb3ZpZGVyOiB1bmtub3duKSA9PiB7XG4gICAgICBjb25zdCBwID0gcHJvdmlkZXIgYXMgeyBuYW1lPzogdW5rbm93bjsgYmFzZVVybD86IHVua25vd247IG1vZGVsPzogdW5rbm93bjsgYXBpS2V5PzogdW5rbm93biB9O1xuICAgICAgY29uc3QgbmFtZSA9IHR5cGVvZiBwPy5uYW1lID09PSAnc3RyaW5nJyA/IHAubmFtZS5zbGljZSgwLCA4MCkgOiAnJztcbiAgICAgIGNvbnN0IGJhc2VVcmwgPSB0eXBlb2YgcD8uYmFzZVVybCA9PT0gJ3N0cmluZycgPyBwLmJhc2VVcmwuc2xpY2UoMCwgMzAwKSA6ICcnO1xuICAgICAgY29uc3QgbW9kZWwgPSB0eXBlb2YgcD8ubW9kZWwgPT09ICdzdHJpbmcnID8gcC5tb2RlbC5zbGljZSgwLCAxMjApIDogJyc7XG4gICAgICBpZiAobmFtZSA9PT0gJycgfHwgYmFzZVVybCA9PT0gJycgfHwgbW9kZWwgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICduYW1lL2Jhc2VVcmwvbW9kZWwgcmVxdWlyZWQnLCBjb2RlOiAnQkFEX1JFUVVFU1QnIH0pO1xuICAgICAgY29uc3QgYm9keTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7IG5hbWUsIGJhc2VVcmwsIG1vZGVsIH07XG4gICAgICAvLyBhcGlLZXkgXHU1M0VBXHU1NzI4XHU2NjNFXHU1RjBGXHU4RjkzXHU1MTY1XHU2NUY2XHU0RTBBXHU0RjIwLFx1N0VERFx1NEUwRFx1NTZERVx1NjYzRShyZW5kZXJlciBcdTg4NjhcdTUzNTVcdTYzRDBcdTRFQTRcdTU0MEVcdTUzNzNcdTZFMDVcdTdBN0EpXG4gICAgICBpZiAodHlwZW9mIHA/LmFwaUtleSA9PT0gJ3N0cmluZycgJiYgcC5hcGlLZXkgIT09ICcnKSBib2R5LmFwaUtleSA9IHAuYXBpS2V5LnNsaWNlKDAsIDMwMCk7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvcHJvdmlkZXJzJywgYm9keSkpO1xuICAgIH0pO1xuXG4gICAgLy8gLS0tLSBcdTVERTVcdTRGNUNcdTUzM0EoMDMgXHUwMEE3XHU1MTZEO1x1NTIwN1x1NjM2Mlx1OEJFRFx1NEU0OVx1NEUwRSB3ZWIgXHU3NkY4XHU1NDBDOnJ1bnRpbWUgXHU1MzU1XHU5MDA5IGN3ZCkgLS0tLVxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6d29ya3NwYWNlcycsIChldmVudCkgPT5cbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPHsgY3VycmVudDogc3RyaW5nOyBpdGVtczogQXJyYXk8eyBpZDogc3RyaW5nOyBuYW1lOiBzdHJpbmc7IHBhdGg6IHN0cmluZyB9PiB9PignL2FwaS93b3Jrc3BhY2VzJykpKTtcblxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6d29ya3NwYWNlLXVzZScsIChldmVudCwgaWQ6IHVua25vd24pID0+IHtcbiAgICAgIGNvbnN0IHdpZCA9IHR5cGVvZiBpZCA9PT0gJ3N0cmluZycgPyBpZC5zbGljZSgwLCA2MCkgOiAnJztcbiAgICAgIGlmICh3aWQgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICdpZCByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLnBvc3RKc29uPHsgb2s6IGJvb2xlYW4gfT4oJy9hcGkvd29ya3NwYWNlcy91c2UnLCB7IGlkOiB3aWQgfSkpO1xuICAgIH0pO1xuXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTp3b3Jrc3BhY2UtYWRkJywgKGV2ZW50LCBuYW1lOiB1bmtub3duLCBwYXRoOiB1bmtub3duKSA9PiB7XG4gICAgICBjb25zdCBuID0gdHlwZW9mIG5hbWUgPT09ICdzdHJpbmcnID8gbmFtZS5zbGljZSgwLCAxMjApIDogJyc7XG4gICAgICBjb25zdCBwID0gdHlwZW9mIHBhdGggPT09ICdzdHJpbmcnID8gcGF0aC5zbGljZSgwLCAxMDAwKSA6ICcnO1xuICAgICAgaWYgKHAgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICdwYXRoIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PignL2FwaS93b3Jrc3BhY2VzJywgeyBuYW1lOiBuID09PSAnJyA/IHVuZGVmaW5lZCA6IG4sIHBhdGg6IHAgfSkpO1xuICAgIH0pO1xuXG4gICAgLy8gLS0tLSBcdTRGMUFcdThCRERcdTVGNTJcdTY4NjMvXHU1MjIwXHU5NjY0KFx1NzlGQlx1NTE2NSBhcmNoaXZlL3RyYXNoLFx1NTNFRlx1NjA2Mlx1NTkwRDtydW50aW1lIFx1Njc0M1x1NUEwMSkgLS0tLVxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6c2Vzc2lvbi1vcCcsIChldmVudCwgaWQ6IHVua25vd24sIG9wOiB1bmtub3duKSA9PiB7XG4gICAgICBjb25zdCBzaWQgPSB0eXBlb2YgaWQgPT09ICdzdHJpbmcnID8gaWQucmVwbGFjZSgvW15hLXpBLVowLTlfOi5ALV0vZywgJycpLnNsaWNlKDAsIDgwKSA6ICcnO1xuICAgICAgY29uc3QgbyA9IG9wID09PSAnYXJjaGl2ZScgfHwgb3AgPT09ICdkZWxldGUnID8gb3AgOiAnJztcbiAgICAgIGlmIChzaWQgPT09ICcnIHx8IG8gPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICdpZCBhbmQgb3AoYXJjaGl2ZXxkZWxldGUpIHJlcXVpcmVkJywgY29kZTogJ0JBRF9SRVFVRVNUJyB9KTtcbiAgICAgIHJldHVybiBob3N0Q2FsbChldmVudCwgKGMpID0+IGMucG9zdEpzb248eyBvazogYm9vbGVhbiB9PihgL2FwaS9zZXNzaW9ucy8ke2VuY29kZVVSSUNvbXBvbmVudChzaWQpfS8ke299YCwge30pKTtcbiAgICB9KTtcblxuICAgIC8vIC0tLS0gTTQ6RGlmZiBcdTk3NjJcdTY3N0YoXHU1M0VBXHU4QkZCIGdpdCBcdTUzRDhcdTY2RjQ7XHU2Mzg4XHU2NzQzXHU1NzI4IHJ1bnRpbWUpIC0tLS1cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmRpZmYnLCAoZXZlbnQsIHNlc3Npb25JZDogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIHNlc3Npb25JZCA9PT0gJ3N0cmluZycgPyBzZXNzaW9uSWQuc2xpY2UoMCwgODApIDogJyc7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KGAvYXBpL2RpZmYke3NpZCAhPT0gJycgPyBgP3Nlc3Npb25JZD0ke2VuY29kZVVSSUNvbXBvbmVudChzaWQpfWAgOiAnJ31gKSk7XG4gICAgfSk7XG5cbiAgICAvLyAtLS0tIE01Olx1OEJBNFx1NzdFNVx1NzJCNlx1NjAwMShcdTdFRDNcdTY3ODRcdTUzMTZcdTRFOEJcdTVCOUU7XHU3RjNBXHU2NTcwXHU2MzZFXHU1QjU3XHU2QkI1XHU3NTMxIFVJIFx1NjYzRVx1NzkzQVwiXHU2NUUwXHU2NTcwXHU2MzZFXCIpIC0tLS1cbiAgICBpcGNNYWluLmhhbmRsZSgnYnJpZGdlOmNvZ25pdGl2ZScsIChldmVudCkgPT5cbiAgICAgIGhvc3RDYWxsKGV2ZW50LCAoYykgPT4gYy5nZXRKc29uPFJlY29yZDxzdHJpbmcsIHVua25vd24+PignL2FwaS9jb2duaXRpdmUnKSkpO1xuXG4gICAgLy8gLS0tLSBcdTUzODZcdTUzRjJcdTRGMUFcdThCRERcdTk4ODRcdTg5QzgoXHU2NzAwXHU1NDBFIDgwIFx1Njc2MSxcdTZCQ0ZcdTY3NjEgNTAwIFx1NUI1NztydW50aW1lIFx1Njc0M1x1NUEwMVx1NjU3MFx1NjM2RSkgLS0tLVxuICAgIGlwY01haW4uaGFuZGxlKCdicmlkZ2U6c2Vzc2lvbi1wcmV2aWV3JywgKGV2ZW50LCBpZDogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3Qgc2lkID0gdHlwZW9mIGlkID09PSAnc3RyaW5nJyA/IGlkLnJlcGxhY2UoL1teYS16QS1aMC05XzouQC1dL2csICcnKS5zbGljZSgwLCA4MCkgOiAnJztcbiAgICAgIGlmIChzaWQgPT09ICcnKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHsgZXJyb3I6ICdpZCByZXF1aXJlZCcsIGNvZGU6ICdCQURfUkVRVUVTVCcgfSk7XG4gICAgICByZXR1cm4gaG9zdENhbGwoZXZlbnQsIChjKSA9PiBjLmdldEpzb248UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KGAvYXBpL3Nlc3Npb25zLyR7ZW5jb2RlVVJJQ29tcG9uZW50KHNpZCl9YCkpO1xuICAgIH0pO1xuXG4gICAgaXBjTWFpbi5oYW5kbGUoJ2JyaWRnZTpzdG9wLWhvc3QnLCAoZXZlbnQpID0+IHtcbiAgICAgIGlmICghc2VuZGVyVHJ1c3RlZChldmVudC5zZW5kZXJGcmFtZSkpIHJldHVybiB7IGVycm9yOiAndW50cnVzdGVkIHNlbmRlcicgfTtcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcbiAgICAgICAgc3NlQWJvcnQ/LmFib3J0KCk7XG4gICAgICAgIGF3YWl0IHN1cGVydmlzb3I/LnN0b3AoKTtcbiAgICAgICAgYXBwLnF1aXQoKTtcbiAgICAgIH0pKCk7XG4gICAgICByZXR1cm4geyBvazogdHJ1ZSB9O1xuICAgIH0pO1xuICB9XG5cbiAgLyogLS0tLSBcdTdBOTdcdTUzRTNcdTRFMEVcdTVCODlcdTUxNjhcdTdCNTZcdTc1NjUgLS0tLSAqL1xuICAvLyAwMyBcdTAwQTdcdTRFMDM6RGVza3RvcCBcdTY3MkNcdTU3MzBcdTUzRUFcdTVCNTggVUkgXHU1MDRGXHU1OTdEL1x1N0E5N1x1NTNFM1x1NzJCNlx1NjAwMSh1c2VyRGF0YS93aW5kb3ctc3RhdGUuanNvbilcbiAgY29uc3Qgd2luZG93U3RhdGVGaWxlID0gKCk6IHN0cmluZyA9PiBqb2luKGFwcC5nZXRQYXRoKCd1c2VyRGF0YScpLCAnd2luZG93LXN0YXRlLmpzb24nKTtcbiAgYXN5bmMgZnVuY3Rpb24gbG9hZEJvdW5kcygpOiBQcm9taXNlPHsgd2lkdGg6IG51bWJlcjsgaGVpZ2h0OiBudW1iZXI7IHg/OiBudW1iZXI7IHk/OiBudW1iZXIgfSB8IG51bGw+IHtcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIEpTT04ucGFyc2UoYXdhaXQgcmVhZEZpbGUod2luZG93U3RhdGVGaWxlKCksICd1dGY4JykpIGFzIHsgd2lkdGg6IG51bWJlcjsgaGVpZ2h0OiBudW1iZXI7IHg/OiBudW1iZXI7IHk/OiBudW1iZXIgfTtcbiAgICB9IGNhdGNoIHsgcmV0dXJuIG51bGw7IH1cbiAgfVxuICBhc3luYyBmdW5jdGlvbiBzYXZlQm91bmRzKHdpbjogQnJvd3NlcldpbmRvdyk6IFByb21pc2U8dm9pZD4ge1xuICAgIHRyeSB7IGF3YWl0IHdyaXRlRmlsZSh3aW5kb3dTdGF0ZUZpbGUoKSwgSlNPTi5zdHJpbmdpZnkod2luLmdldEJvdW5kcygpKSwgJ3V0ZjgnKTsgfSBjYXRjaCB7IC8qIGJlc3QgZWZmb3J0ICovIH1cbiAgfVxuXG4gIGFzeW5jIGZ1bmN0aW9uIGNyZWF0ZVdpbmRvdygpOiBQcm9taXNlPEJyb3dzZXJXaW5kb3cgfCBudWxsPiB7XG4gICAgY29uc3Qgc2F2ZWQgPSBhd2FpdCBsb2FkQm91bmRzKCk7XG4gICAgY29uc3Qgd2luID0gbmV3IEJyb3dzZXJXaW5kb3coe1xuICAgICAgd2lkdGg6IHNhdmVkPy53aWR0aCA/PyAxNDQwLFxuICAgICAgaGVpZ2h0OiBzYXZlZD8uaGVpZ2h0ID8/IDkwMCxcbiAgICAgIC4uLihzYXZlZD8ueCAhPT0gdW5kZWZpbmVkICYmIHNhdmVkPy55ICE9PSB1bmRlZmluZWQgPyB7IHg6IHNhdmVkLngsIHk6IHNhdmVkLnkgfSA6IHt9KSxcbiAgICAgIG1pbldpZHRoOiA5NjAsXG4gICAgICBtaW5IZWlnaHQ6IDYwMCxcbiAgICAgIHNob3c6IGZhbHNlLFxuICAgICAgYmFja2dyb3VuZENvbG9yOiAnIzE0MTQxNicsXG4gICAgICB0aXRsZTogJ0hNSCBEZXNrdG9wJyxcbiAgICAgIHdlYlByZWZlcmVuY2VzOiB7XG4gICAgICAgIHByZWxvYWQ6IHByZWxvYWRQYXRoLFxuICAgICAgICBjb250ZXh0SXNvbGF0aW9uOiB0cnVlLFxuICAgICAgICBzYW5kYm94OiB0cnVlLFxuICAgICAgICBub2RlSW50ZWdyYXRpb246IGZhbHNlLFxuICAgICAgICBub2RlSW50ZWdyYXRpb25JbldvcmtlcjogZmFsc2UsXG4gICAgICAgIHdlYlNlY3VyaXR5OiB0cnVlLFxuICAgICAgICBzcGVsbGNoZWNrOiBmYWxzZSxcbiAgICAgICAgZGV2VG9vbHM6IGlzRGV2LFxuICAgICAgfSxcbiAgICB9KTtcbiAgICB3aW4ub25jZSgncmVhZHktdG8tc2hvdycsICgpID0+IHdpbi5zaG93KCkpO1xuICAgIHdpbi5vbignY2xvc2UnLCAoKSA9PiB7IHZvaWQgc2F2ZUJvdW5kcyh3aW4pOyB9KTtcblxuICAgIC8vIFx1NTNFQVx1NTE0MVx1OEJCOFx1NTJBMFx1OEY3RFx1NjIxMVx1NEVFQ1x1ODFFQVx1NURGMVx1NzY4NCByZW5kZXJlcjtcdTRFRkJcdTRGNTVcdTVCRkNcdTgyMkEvXHU2NUIwXHU3QTk3XHU1M0UzXHU0RTAwXHU1RjhCXHU2MkQyXHU3RUREXG4gICAgd2luLndlYkNvbnRlbnRzLnNldFdpbmRvd09wZW5IYW5kbGVyKCh7IHVybCB9KSA9PiB7XG4gICAgICBpZiAoL15odHRwcz86XFwvXFwvLy50ZXN0KHVybCkpIHZvaWQgc2hlbGwub3BlbkV4dGVybmFsKHVybCk7XG4gICAgICByZXR1cm4geyBhY3Rpb246ICdkZW55JyB9O1xuICAgIH0pO1xuICAgIHdpbi53ZWJDb250ZW50cy5vbignd2lsbC1uYXZpZ2F0ZScsIChlLCB1cmwpID0+IHtcbiAgICAgIGNvbnN0IG9rID0gWy4uLmFsbG93ZWRPcmlnaW5zXS5zb21lKChvKSA9PiB1cmwgPT09IG8gfHwgdXJsLnN0YXJ0c1dpdGgoYCR7b30vYCkgfHwgdXJsLnN0YXJ0c1dpdGgoYCR7b30/YCkpO1xuICAgICAgaWYgKCFvaykge1xuICAgICAgICBsb2dJbmZvKCduYXYnLCBgYmxvY2tlZCBuYXZpZ2F0aW9uIHRvICR7dXJsLnNsaWNlKDAsIDEyMCl9YCk7XG4gICAgICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIGlmIChpc0RldiAmJiByZW5kZXJlckRldlVybCkge1xuICAgICAgdm9pZCB3aW4ubG9hZFVSTChyZW5kZXJlckRldlVybCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHZvaWQgd2luLmxvYWRGaWxlKGpvaW4oaGVyZSwgJy4uJywgJy4uJywgJ2Rpc3QtcmVuZGVyZXInLCAnaW5kZXguaHRtbCcpKTtcbiAgICB9XG4gICAgcmV0dXJuIHdpbjtcbiAgfVxuXG4gIGFwcC53aGVuUmVhZHkoKS50aGVuKCgpID0+IHtcbiAgICAvLyBDU1AoZGV2IFx1NEUwRSBwcm9kIFx1NEUwRFx1NTQwQztwcm9kIFx1NEUwRFx1NTE0MVx1OEJCOFx1NEVGQlx1NEY1NVx1OEZEQ1x1N0EwQlx1NkU5MClcbiAgICBjb25zdCBjc3AgPSBpc0RldlxuICAgICAgPyBbXG4gICAgICAgICAgXCJkZWZhdWx0LXNyYyAnc2VsZidcIixcbiAgICAgICAgICBgc2NyaXB0LXNyYyAnc2VsZicgJHtyZW5kZXJlckRldlVybH1gLFxuICAgICAgICAgIFwic3R5bGUtc3JjICdzZWxmJyAndW5zYWZlLWlubGluZSdcIixcbiAgICAgICAgICBgY29ubmVjdC1zcmMgJ3NlbGYnICR7cmVuZGVyZXJEZXZVcmx9IHdzOi8vMTI3LjAuMC4xOipgLFxuICAgICAgICAgIFwiaW1nLXNyYyAnc2VsZicgZGF0YTpcIixcbiAgICAgICAgICBcImZvbnQtc3JjICdzZWxmJyBkYXRhOlwiLFxuICAgICAgICBdLmpvaW4oJzsgJylcbiAgICAgIDogXCJkZWZhdWx0LXNyYyAnc2VsZic7IHNjcmlwdC1zcmMgJ3NlbGYnOyBzdHlsZS1zcmMgJ3NlbGYnICd1bnNhZmUtaW5saW5lJzsgaW1nLXNyYyAnc2VsZicgZGF0YTo7IGZvbnQtc3JjICdzZWxmJyBkYXRhOlwiO1xuICAgIHNlc3Npb24uZGVmYXVsdFNlc3Npb24ud2ViUmVxdWVzdC5vbkhlYWRlcnNSZWNlaXZlZCgoZGV0YWlscywgY2FsbGJhY2spID0+IHtcbiAgICAgIGNhbGxiYWNrKHtcbiAgICAgICAgcmVzcG9uc2VIZWFkZXJzOiB7XG4gICAgICAgICAgLi4uZGV0YWlscy5yZXNwb25zZUhlYWRlcnMsXG4gICAgICAgICAgJ0NvbnRlbnQtU2VjdXJpdHktUG9saWN5JzogW2NzcF0sXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHJlZ2lzdGVySXBjKCk7XG4gICAgLy8gY3JlYXRlV2luZG93IFx1NjYyRiBhc3luYyhib3VuZHMgXHU2MDYyXHU1OTBEKTtcdTVCODlcdTUxNjhcdTgxRUFcdTZENEIvXHU2RTMyXHU2N0QzXHU4MUVBXHU2OEMwXHU1NzI4XHU3QTk3XHU1M0UzXHU1QzMxXHU3RUVBXHU1NDBFXHU2MzAyXHU4RjdEXG4gICAgdm9pZCBjcmVhdGVXaW5kb3coKS50aGVuKCh3aW4pID0+IHtcbiAgICAgIGlmICh3aW4gPT09IG51bGwpIHJldHVybjtcbiAgICAgIGlmIChwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9TRUNVUklUWV9URVNUID09PSAnMScpIHtcbiAgICAgICAgd2luLndlYkNvbnRlbnRzLm9uY2UoJ2RpZC1maW5pc2gtbG9hZCcsICgpID0+IHtcbiAgICAgICAgICB2b2lkIHNlY3VyaXR5U2VsZlRlc3Qod2luKTtcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgICAvLyBcdTZFMzJcdTY3RDNcdTgxRUFcdTY4QzAoMjAyNi0xMC0xMCBcdTg4QzVcdTY3M0FcdTlFRDFcdTVDNEZcdTY1NTlcdThCQUQ6YnJpZGdlIHJlYWR5IFx1MjI2MCBcdTc1NENcdTk3NjJcdTZFMzJcdTY3RDNcdTRFODYpXHUzMDAyXG4gICAgICAvLyAjcm9vdCBcdTU3MjggUmVhY3QgXHU2MzAyXHU4RjdEXHU1NDBFXHU1RkM1XHU2NzA5XHU1QjUwXHU4MjgyXHU3MEI5O1x1N0E3QSA9IFx1OEQ0NFx1NkU5MFx1OERFRlx1NUY4NC9DU1AvXHU4MTFBXHU2NzJDXHU1MkEwXHU4RjdEXHU1NzRGXHU0RTg2XHUzMDAyXG4gICAgICBpZiAocHJvY2Vzcy5lbnYuSE1IX0RFU0tUT1BfUkVOREVSX1RFU1QgPT09ICcxJykge1xuICAgICAgICB3aW4ud2ViQ29udGVudHMub25jZSgnZGlkLWZpbmlzaC1sb2FkJywgKCkgPT4ge1xuICAgICAgICAgIHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIGNvbnN0IG4gPSAoYXdhaXQgd2luLndlYkNvbnRlbnRzLmV4ZWN1dGVKYXZhU2NyaXB0KFxuICAgICAgICAgICAgICAgICAgJ2RvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwicm9vdFwiKSA/IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwicm9vdFwiKS5jaGlsZHJlbi5sZW5ndGggOiAtMScsIHRydWUsXG4gICAgICAgICAgICAgICAgKSkgYXMgbnVtYmVyO1xuICAgICAgICAgICAgICAgIGNvbnN0IG9rID0gbiA+IDA7XG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYFJFTkRFUi1URVNUICR7b2sgPyAnb2snIDogJ0VNUFRZJ30gcm9vdENoaWxkcmVuPSR7bn1gKTtcbiAgICAgICAgICAgICAgICBhcHAuZXhpdChvayA/IDAgOiAxKTtcbiAgICAgICAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYFJFTkRFUi1URVNUIEVSUk9SICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTIwKX1gKTtcbiAgICAgICAgICAgICAgICBhcHAuZXhpdCgxKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSkoKTtcbiAgICAgICAgICB9LCAyXzUwMCk7XG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH0pO1xuICAgIHZvaWQgc3RhcnRIb3N0KCk7XG5cbiAgICBhcHAub24oJ2FjdGl2YXRlJywgKCkgPT4ge1xuICAgICAgaWYgKEJyb3dzZXJXaW5kb3cuZ2V0QWxsV2luZG93cygpLmxlbmd0aCA9PT0gMCkgdm9pZCBjcmVhdGVXaW5kb3coKTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgYXN5bmMgZnVuY3Rpb24gc2VjdXJpdHlTZWxmVGVzdCh3aW46IEJyb3dzZXJXaW5kb3cpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCByZXN1bHRzOiBBcnJheTxbc3RyaW5nLCBib29sZWFuLCBzdHJpbmddPiA9IFtdO1xuICAgIGNvbnN0IGNoZWNrID0gYXN5bmMgKG5hbWU6IHN0cmluZywgcHJvYmU6ICgpID0+IFByb21pc2U8W2Jvb2xlYW4sIHN0cmluZ10+KTogUHJvbWlzZTx2b2lkPiA9PiB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBbb2ssIGRldGFpbF0gPSBhd2FpdCBwcm9iZSgpO1xuICAgICAgICByZXN1bHRzLnB1c2goW25hbWUsIG9rLCBkZXRhaWxdKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICByZXN1bHRzLnB1c2goW25hbWUsIGZhbHNlLCBTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApXSk7XG4gICAgICB9XG4gICAgfTtcbiAgICBjb25zdCBqcyA9IChjb2RlOiBzdHJpbmcpOiBQcm9taXNlPHVua25vd24+ID0+IHdpbi53ZWJDb250ZW50cy5leGVjdXRlSmF2YVNjcmlwdChjb2RlLCB0cnVlKTtcblxuICAgIGF3YWl0IGNoZWNrKCdyZW5kZXJlciBcdTY1RTBcdTUzRUZcdTc1MjhcdTc2ODQgcHJvY2Vzcy9yZXF1aXJlKHNhbmRib3ggXHU3NTFGXHU2NTQ4KScsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoYChmdW5jdGlvbigpe1xuICAgICAgICB2YXIgdCA9IGZ1bmN0aW9uKGYpeyB0cnkgeyB2YXIgdiA9IGYoKTsgcmV0dXJuICh2ID09PSB1bmRlZmluZWQgfHwgdiA9PT0gbnVsbCkgPyAndW5hdmFpbGFibGUnIDogdHlwZW9mIHY7IH0gY2F0Y2goZSl7IHJldHVybiAnYmxvY2tlZCc7IH0gfTtcbiAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KFt0KGZ1bmN0aW9uKCl7cmV0dXJuIHByb2Nlc3N9KSwgdChmdW5jdGlvbigpe3JldHVybiByZXF1aXJlfSksIHQoZnVuY3Rpb24oKXtyZXR1cm4gZ2xvYmFsVGhpcy5wcm9jZXNzfSldKTtcbiAgICAgIH0pKClgKSkgYXMgc3RyaW5nO1xuICAgICAgY29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShyKSBhcyBzdHJpbmdbXTtcbiAgICAgIGNvbnN0IHAgPSBwYXJzZWRbMF0gPz8gJ3Vua25vd24nO1xuICAgICAgY29uc3QgcmVxID0gcGFyc2VkWzFdID8/ICd1bmtub3duJztcbiAgICAgIGNvbnN0IHNhZmUgPSAodjogc3RyaW5nKTogYm9vbGVhbiA9PiB2ID09PSAndW5hdmFpbGFibGUnIHx8IHYgPT09ICdibG9ja2VkJztcbiAgICAgIHJldHVybiBbc2FmZShwKSAmJiBzYWZlKHJlcSksIGBwcm9jZXNzPSR7cH0gcmVxdWlyZT0ke3JlcX1gXTtcbiAgICB9KTtcbiAgICBhd2FpdCBjaGVjaygnd2luZG93LmhtaCBcdTUzRUFcdTY3MDlcdTc2N0RcdTU0MERcdTUzNTVcdTY1QjlcdTZDRDUoXHU2NUUwIGlwY1JlbmRlcmVyL1x1OTg5RFx1NTkxNlx1OTc2MiknLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKCdPYmplY3Qua2V5cyh3aW5kb3cuaG1oIHx8IHt9KS5zb3J0KCkuam9pbihcIixcIiknKSkgYXMgc3RyaW5nO1xuICAgICAgY29uc3QgYWxsb3cgPSBbJ2FwcHJvdmUnLCAnYXBwcm92YWxHZXQnLCAnYXBwcm92YWxTZXQnLCAnYnJvd3NlUnVudGltZScsICdjb2duaXRpdmUnLCAnZGlmZicsICdleHBvcnRTZXNzaW9uJywgJ2ZzTGlzdCcsICdmc1JlYWQnLCAnZnNTZWFyY2gnLCAnZ2V0U3RhdGUnLCAnaW5qZWN0JywgJ2ludGVycnVwdCcsICdvbkV2ZW50QmF0Y2hlcycsICdvbkhvc3RTdGF0ZScsICdvblN0cmVhbUNodW5rcycsICdwcm92aWRlclNhdmUnLCAncHJvdmlkZXJzJywgJ3J1bnRpbWVJbmZvJywgJ3NlbmRUYXNrJywgJ3Nlc3Npb25PcCcsICdzZXNzaW9uUHJldmlldycsICdzZXNzaW9ucycsICdzZXRSdW50aW1lJywgJ3N0b3BIb3N0JywgJ3dvcmtzcGFjZXMnLCAnd29ya3NwYWNlQWRkJywgJ3dvcmtzcGFjZVVzZSddO1xuICAgICAgY29uc3QgZ290ID0gciA9PT0gJycgPyBbXSA6IHIuc3BsaXQoJywnKTtcbiAgICAgIGNvbnN0IHVuZXhwZWN0ZWQgPSBnb3QuZmlsdGVyKChrKSA9PiAhYWxsb3cuaW5jbHVkZXMoaykpO1xuICAgICAgcmV0dXJuIFt1bmV4cGVjdGVkLmxlbmd0aCA9PT0gMCwgYGtleXM9JHtyfWBdO1xuICAgIH0pO1xuICAgIGF3YWl0IGNoZWNrKCdcdTU5MTZcdTkwRThcdTVCRkNcdTgyMkFcdTg4QUJcdTYyRTZcdTYyMkEoVVJMIFx1NEUwRFx1NTNEOCknLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBiZWZvcmUgPSB3aW4ud2ViQ29udGVudHMuZ2V0VVJMKCk7XG4gICAgICBhd2FpdCBqcygnbG9jYXRpb24uaHJlZiA9IFwiaHR0cHM6Ly9leGFtcGxlLmludmFsaWQveFwiOyBcIm5vb3BcIicpLmNhdGNoKCgpID0+ICdub29wJyk7XG4gICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocjIpID0+IHNldFRpbWVvdXQocjIsIDFfMjAwKSk7XG4gICAgICBjb25zdCBhZnRlciA9IHdpbi53ZWJDb250ZW50cy5nZXRVUkwoKTtcbiAgICAgIHJldHVybiBbYWZ0ZXIgPT09IGJlZm9yZSwgYCR7YmVmb3JlfSBcdTIxOTIgJHthZnRlcn1gXTtcbiAgICB9KTtcbiAgICBhd2FpdCBjaGVjaygnd2luZG93Lm9wZW4gXHU4OEFCXHU2MkQyXHU3RUREKFx1OEZENFx1NTZERSBudWxsIFx1NEUxNFx1NjVFMFx1NjVCMFx1N0E5N1x1NTNFMyknLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBiZWZvcmUgPSBCcm93c2VyV2luZG93LmdldEFsbFdpbmRvd3MoKS5sZW5ndGg7XG4gICAgICBjb25zdCByID0gKGF3YWl0IGpzKCdTdHJpbmcod2luZG93Lm9wZW4oXCJodHRwczovL2V4YW1wbGUuaW52YWxpZFwiKSknKSkgYXMgc3RyaW5nO1xuICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHIyKSA9PiBzZXRUaW1lb3V0KHIyLCA0MDApKTtcbiAgICAgIGNvbnN0IGFmdGVyID0gQnJvd3NlcldpbmRvdy5nZXRBbGxXaW5kb3dzKCkubGVuZ3RoO1xuICAgICAgcmV0dXJuIFtyID09PSAnbnVsbCcgJiYgYWZ0ZXIgPT09IGJlZm9yZSwgYG9wZW4oKT0ke3J9IHdpbmRvd3M9JHtiZWZvcmV9XHUyMTkyJHthZnRlcn1gXTtcbiAgICB9KTtcbiAgICBhd2FpdCBjaGVjaygnQ1NQIFx1NUI1OFx1NTcyOChtZXRhIFx1NkNFOFx1NTE2NVx1NjIxNlx1NTRDRFx1NUU5NFx1NTkzNCknLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBtZXRhID0gKGF3YWl0IGpzKCdCb29sZWFuKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoXCJtZXRhW2h0dHAtZXF1aXY9XFwnQ29udGVudC1TZWN1cml0eS1Qb2xpY3lcXCddXCIpKScpKSBhcyBib29sZWFuO1xuICAgICAgY29uc3QgaGVhZGVyQ3NwID0gaXNEZXYgPyAnZGV2OiBoZWFkZXIgQ1NQIFx1NzUzMSBvbkhlYWRlcnNSZWNlaXZlZCBcdTZDRThcdTUxNjUoXHU0RTBEXHU5MDAyXHU3NTI4IG1ldGEgXHU2NUFEXHU4QTAwKScgOiAncHJvZCc7XG4gICAgICByZXR1cm4gW21ldGEgfHwgaXNEZXYsIGBtZXRhPSR7bWV0YX0gJHtoZWFkZXJDc3B9YF07XG4gICAgfSk7XG4gICAgYXdhaXQgY2hlY2soJ2JyaWRnZTpnZXQtc3RhdGUgXHU2QjYzXHU1RTM4XHU4RkQ0XHU1NkRFKGhvc3QgXHU2ODY1XHU1M0VGXHU3NTI4KScsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQganMoJ3dpbmRvdy5obWguZ2V0U3RhdGUoKS50aGVuKHMgPT4gSlNPTi5zdHJpbmdpZnkocykpLmNhdGNoKGUgPT4gXCJFUlI6XCIrZSknKSkgYXMgc3RyaW5nO1xuICAgICAgcmV0dXJuIFtyLnN0YXJ0c1dpdGgoJ3snKSAmJiByLmluY2x1ZGVzKCdob3N0U3RhdGUnKSwgci5zbGljZSgwLCA4MCldO1xuICAgIH0pO1xuICAgIGF3YWl0IGNoZWNrKCdYU1M6XHU2MDc2XHU2MTBGXHU0RUZCXHU1MkExXHU2NTg3XHU2NzJDXHU1M0VBXHU0RUU1XHU2NTg3XHU2NzJDXHU2RTMyXHU2N0QzKFx1NEUwRFx1NjI2N1x1ODg0QyknLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBwYXlsb2FkID0gJzxpbWcgc3JjPXggb25lcnJvcj1cIndpbmRvdy5fX3hzcz0xXCI+PHNjcmlwdD53aW5kb3cuX194c3M9MjxcXC9zY3JpcHQ+XCImXFwnJztcbiAgICAgIGNvbnN0IHNlbmRSID0gKGF3YWl0IGpzKGB3aW5kb3cuaG1oLnNlbmRUYXNrKCR7SlNPTi5zdHJpbmdpZnkocGF5bG9hZCl9LCAnc2VjLXhzcy0xJywgJ2F1dG8nKS50aGVuKHI9PkpTT04uc3RyaW5naWZ5KHIpKS5jYXRjaChlPT4nRVJSOicrZSlgKSkgYXMgc3RyaW5nO1xuICAgICAgaWYgKCFzZW5kUi5pbmNsdWRlcygnXCJva1wiOnRydWUnKSkgcmV0dXJuIFtmYWxzZSwgYHNlbmRUYXNrIFx1NjcyQVx1NTNEN1x1NzQwNjogJHtzZW5kUi5zbGljZSgwLCA4MCl9YF07XG4gICAgICAvLyBmYWtlIGhvc3QgZWNobyBcdTU2REVcdTY3NjVcdTU0MEVcdTdFQ0YgUmVhY3QgXHU2RTMyXHU2N0QzKFx1NzUyOFx1NjIzN1x1NkQ4OFx1NjA2RiArIFx1NTJBOVx1NjI0QiBlY2hvIFx1NTNDQ1x1OERFRlx1NUY4NClcbiAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyMikgPT4gc2V0VGltZW91dChyMiwgM18wMDApKTtcbiAgICAgIGNvbnN0IHByb2JlID0gKGF3YWl0IGpzKGBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIHhzc0ZsYWc6IHR5cGVvZiB3aW5kb3cuX194c3MsXG4gICAgICAgIGltZ0NvdW50OiBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdpbWdbc3JjPVwieFwiXScpLmxlbmd0aCxcbiAgICAgICAgc2NyaXB0UmFuOiBkb2N1bWVudC5ib2R5LmlubmVyVGV4dC5pbmRleE9mKCd3aW5kb3cuX194c3M9MicpID49IDBcbiAgICAgIH0pYCkpIGFzIHN0cmluZztcbiAgICAgIGNvbnN0IHAgPSBKU09OLnBhcnNlKHByb2JlKSBhcyB7IHhzc0ZsYWc6IHN0cmluZzsgaW1nQ291bnQ6IG51bWJlcjsgc2NyaXB0UmFuOiBib29sZWFuIH07XG4gICAgICByZXR1cm4gW3AueHNzRmxhZyA9PT0gJ3VuZGVmaW5lZCcgJiYgcC5pbWdDb3VudCA9PT0gMCwgYHhzc0ZsYWc9JHtwLnhzc0ZsYWd9IGltZz0ke3AuaW1nQ291bnR9YF07XG4gICAgfSk7XG5cbiAgICBsZXQgZmFpbGVkID0gMDtcbiAgICBmb3IgKGNvbnN0IFtuYW1lLCBvaywgZGV0YWlsXSBvZiByZXN1bHRzKSB7XG4gICAgICBjb25zb2xlLmxvZyhgU0VDVVJJVFktVEVTVCAke29rID8gJ1BBU1MnIDogJ0ZBSUwnfSB8ICR7bmFtZX0gfCAke3JlZGFjdChkZXRhaWwpfWApO1xuICAgICAgaWYgKCFvaykgZmFpbGVkICs9IDE7XG4gICAgfVxuICAgIGNvbnNvbGUubG9nKGBTRUNVUklUWS1URVNUIFNVTU1BUlkgcGFzcz0ke3Jlc3VsdHMubGVuZ3RoIC0gZmFpbGVkfS8ke3Jlc3VsdHMubGVuZ3RofWApO1xuICAgIGFwcC5leGl0KGZhaWxlZCA9PT0gMCA/IDAgOiAxKTtcbiAgfVxuXG4gIC8vIFx1OTAwMFx1NTFGQTpcdTRGMThcdTk2QzVcdTUwNUNcdTZCNjJcdTgxRUFcdTVERjEgc3Bhd24gXHU3Njg0IGhvc3Qoc2h1dGRvd24gXHU3QUVGXHU3MEI5IFx1MjE5MiBcdTUxNUNcdTVFOTVcdTUzRUEga2lsbCBcdTgxRUFcdTVERjFcdTc2ODRcdTUzRTVcdTY3QzQpXG4gIGFwcC5vbignYmVmb3JlLXF1aXQnLCAoZSkgPT4ge1xuICAgIGlmIChzdXBlcnZpc29yICE9PSBudWxsICYmIHN1cGVydmlzb3Iuc3RhdGUgIT09ICdzdG9wcGVkJykge1xuICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgc3NlQWJvcnQ/LmFib3J0KCk7XG4gICAgICB2b2lkIHN1cGVydmlzb3Iuc3RvcCgpLmZpbmFsbHkoKCkgPT4gYXBwLnF1aXQoKSk7XG4gICAgfVxuICB9KTtcbiAgYXBwLm9uKCd3aW5kb3ctYWxsLWNsb3NlZCcsICgpID0+IHtcbiAgICBpZiAocHJvY2Vzcy5wbGF0Zm9ybSAhPT0gJ2RhcndpbicpIGFwcC5xdWl0KCk7XG4gIH0pO1xufVxuIiwgIi8qKlxuICogRGVza3RvcFJ1bnRpbWVTdXBlcnZpc29yIFx1MjAxNCBobWhhcm5lc3MgaG9zdCBcdThGREJcdTdBMEJcdTc2ODRcdTc1MUZcdTU0N0RcdTU0NjhcdTY3MUZcdTcyQjZcdTYwMDFcdTY3M0EoQURSLTAwMylcdTMwMDJcbiAqXG4gKiBcdTVCODlcdTUxNjhcdTRFMERcdTUzRDhcdTkxQ0Y6XG4gKiAgLSBcdTUzRUFcdTdFRDFcdTVCOUEvXHU2M0EyXHU2RDRCIDEyNy4wLjAuMTtob3N0IFx1NEY3Rlx1NzUyOFx1NjRDRFx1NEY1Q1x1N0NGQlx1N0VERlx1NTIwNlx1OTE0RFx1N0FFRlx1NTNFMyhwb3J0IDApLFx1NUI5RVx1OTY0NVx1N0FFRlx1NTNFM1xuICogICAgXHU3NTMxIGhvc3QgXHU3Njg0IHN0ZG91dCBcdTVGMTVcdTVCRkNcdTg4NENcdTU2REVcdTRGMjAoSG9zdFJlYWR5TGluZSlcdTMwMDJcbiAqICAtIFx1OUFEOFx1NzFCNSB0b2tlbiBcdTUzRUFcdTkwMUFcdThGQzdcdTVCNTBcdThGREJcdTdBMEJcdTczQUZcdTU4ODNcdTUzRDhcdTkxQ0ZcdTRGMjBcdTkwMTIsXHU3RUREXHU0RTBEXHU4RkRCIFVSTC9cdTY1RTVcdTVGRDcvSVBDIFx1NjYwRVx1NjU4N1x1OEQxRlx1OEY3RFx1MzAwMlxuICogIC0gXHU1M0VBXHU1MDVDXHU2QjYyXHU2NzJDIHN1cGVydmlzb3Igc3Bhd24gXHU3Njg0XHU4RkRCXHU3QTBCXHU1M0U1XHU2N0M0O1x1N0VERFx1NEUwRFx1NjMwOVx1OEZEQlx1N0EwQlx1NTQwRCBraWxsXHUzMDAyXG4gKiAgLSBob3N0IGNyYXNoIFx1NTQwRVx1NjcwOVx1OTY1MFx1OTFDRFx1NTQyRjtcdTkxQ0RcdTU0MkZcdTRFMERcdTkxQ0RcdTY1M0VcdTRFRkJcdTRGNTVcdTc1MjhcdTYyMzdcdTUyQThcdTRGNUMoXHU5NzVFXHU1RTQyXHU3QjQ5XHU1MkE4XHU0RjVDXHU3NTMxXHU3NTI4XHU2MjM3XHU3ODZFXHU4QkE0KVx1MzAwMlxuICovXG5pbXBvcnQgeyBzcGF3biwgdHlwZSBDaGlsZFByb2Nlc3MgfSBmcm9tICdub2RlOmNoaWxkX3Byb2Nlc3MnO1xuaW1wb3J0IHsgY3JlYXRlSW50ZXJmYWNlIH0gZnJvbSAnbm9kZTpyZWFkbGluZSc7XG5pbXBvcnQgeyByYW5kb21CeXRlcyB9IGZyb20gJ25vZGU6Y3J5cHRvJztcbmltcG9ydCB7IGRlc2t0b3BFcnJvciwgaXNEZXNrdG9wRXJyb3IsIHR5cGUgRGVza3RvcEVycm9yIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyc7XG5cbmV4cG9ydCB0eXBlIEhvc3RTdGF0ZSA9XG4gIHwgJ3N0b3BwZWQnXG4gIHwgJ3N0YXJ0aW5nJ1xuICB8ICdyZWFkeSdcbiAgfCAnZGlzY29ubmVjdGVkJ1xuICB8ICdyZXN0YXJ0aW5nJ1xuICB8ICdzdG9wcGluZydcbiAgfCAnZmFpbGVkJztcblxuZXhwb3J0IGludGVyZmFjZSBIb3N0U3BlYyB7XG4gIC8qKiBcdTUzRUZcdTYyNjdcdTg4NENcdTY1ODdcdTRFRjYoXHU5MDFBXHU1RTM4IHByb2Nlc3MuZXhlY1BhdGgpXHUzMDAyICovXG4gIGNvbW1hbmQ6IHN0cmluZztcbiAgYXJnczogc3RyaW5nW107XG4gIGN3ZD86IHN0cmluZztcbiAgLyoqIFx1OTg5RFx1NTkxNlx1NzNBRlx1NTg4M1x1NTNEOFx1OTFDRihcdTRGMUFcdTRFMEUgcHJvY2Vzcy5lbnYgXHU1NDA4XHU1RTc2KVx1MzAwMiAqL1xuICBlbnY/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFN1cGVydmlzb3JPcHRpb25zIHtcbiAgLyoqIFx1NjcxRlx1NjcxQiBob3N0IFx1NjgyMVx1OUE4Q1x1NzY4NCBiZWFyZXIgdG9rZW47XHU0RTBEXHU0RjIwXHU1MjE5XHU2QkNGXHU2QjIxIHN0YXJ0IFx1NzUxRlx1NjIxMFx1OUFEOFx1NzFCNVx1OTY4Rlx1NjczQVx1NTAzQ1x1MzAwMiAqL1xuICB0b2tlbj86IHN0cmluZztcbiAgbWF4UmVzdGFydHM/OiBudW1iZXI7XG4gIHN0YXJ0VGltZW91dE1zPzogbnVtYmVyO1xuICBncmFjZWZ1bFNodXRkb3duTXM/OiBudW1iZXI7XG4gIG9uU3RhdGVDaGFuZ2U/KHN0YXRlOiBIb3N0U3RhdGUsIGluZm86IHsgcmVzdGFydENvdW50OiBudW1iZXI7IGxhc3RFcnJvcj86IHN0cmluZyB9KTogdm9pZDtcbiAgLyoqIFx1NkJDRlx1NkIyMSBob3N0IFx1NUMzMVx1N0VFQShcdTU0MkIgY3Jhc2ggXHU4MUVBXHU2MTA4XHU1NDBFXHU3Njg0XHU5MUNEXHU1NDJGKVx1OTBGRFx1NEYxQVx1ODlFNlx1NTNEMSxcdTY0M0FcdTVFMjZcdTdBRUZcdTcwQjkoXHU1NDJCIHRva2VuLFxuICAgKiAgXHU0RUM1XHU0RjlCXHU1NDBDXHU0RkUxXHU0RUZCXHU1N0RGXHU3Njg0XHU1QkJGXHU0RTNCXHU4RkRCXHU3QTBCXHU5MUNEXHU1RUZBXHU2ODY1XHU1QkEyXHU2MjM3XHU3QUVGO1x1NEUwRFx1ODk4MVx1OERFOFx1OEZEQiByZW5kZXJlcilcdTMwMDIgKi9cbiAgb25SZWFkeT8oZW5kcG9pbnQ6IEhvc3RFbmRwb2ludCk6IHZvaWQ7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgSG9zdEVuZHBvaW50IHtcbiAgcG9ydDogbnVtYmVyO1xuICB2ZXJzaW9uOiBzdHJpbmc7XG4gIHRva2VuOiBzdHJpbmc7XG59XG5cbi8qKiBIb3N0UmVhZHlMaW5lIFx1NzY4NFx1N0M3Qlx1NTc4Qlx1NUI4OFx1NTM2Qlx1NEVDRSBjb250cmFjdHMgXHU1RjE1XHU1MTY1LFx1OTA3Rlx1NTE0RFx1NTNDQ1x1NUI5RVx1NzNCMFx1MzAwMiAqL1xuaW1wb3J0IHsgaXNIb3N0UmVhZHlMaW5lIH0gZnJvbSAnQGhtaC1kZXNrdG9wL2NvbnRyYWN0cyc7XG5cbmNvbnN0IERFRkFVTFRfU1RBUlRfVElNRU9VVF9NUyA9IDIwXzAwMDtcbmNvbnN0IERFRkFVTFRfTUFYX1JFU1RBUlRTID0gMztcbmNvbnN0IERFRkFVTFRfR1JBQ0VGVUxfTVMgPSA1XzAwMDtcblxuZXhwb3J0IGNsYXNzIERlc2t0b3BSdW50aW1lU3VwZXJ2aXNvciB7XG4gIHByaXZhdGUgY2hpbGQ6IENoaWxkUHJvY2VzcyB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIF9zdGF0ZTogSG9zdFN0YXRlID0gJ3N0b3BwZWQnO1xuICBwcml2YXRlIHJlc3RhcnRDb3VudCA9IDA7XG4gIHByaXZhdGUgbGFzdEVycm9yID0gJyc7XG4gIHByaXZhdGUgc3RvcHBpbmcgPSBmYWxzZTtcbiAgcHJpdmF0ZSByZWFkb25seSB0b2tlbjogc3RyaW5nO1xuICBwcml2YXRlIHJlYWRvbmx5IG9wdHM6IFJlcXVpcmVkPFBpY2s8U3VwZXJ2aXNvck9wdGlvbnMsICdtYXhSZXN0YXJ0cycgfCAnc3RhcnRUaW1lb3V0TXMnIHwgJ2dyYWNlZnVsU2h1dGRvd25Ncyc+PiAmIFN1cGVydmlzb3JPcHRpb25zO1xuICBwcml2YXRlIGV4aXRXYWl0ZXJzOiBBcnJheTwoKSA9PiB2b2lkPiA9IFtdO1xuXG4gIGNvbnN0cnVjdG9yKFxuICAgIHByaXZhdGUgcmVhZG9ubHkgc3BlYzogSG9zdFNwZWMsXG4gICAgb3B0czogU3VwZXJ2aXNvck9wdGlvbnMgPSB7fSxcbiAgKSB7XG4gICAgdGhpcy50b2tlbiA9IG9wdHMudG9rZW4gPz8gcmFuZG9tQnl0ZXMoMzIpLnRvU3RyaW5nKCdiYXNlNjR1cmwnKTtcbiAgICB0aGlzLm9wdHMgPSB7XG4gICAgICBtYXhSZXN0YXJ0czogb3B0cy5tYXhSZXN0YXJ0cyA/PyBERUZBVUxUX01BWF9SRVNUQVJUUyxcbiAgICAgIHN0YXJ0VGltZW91dE1zOiBvcHRzLnN0YXJ0VGltZW91dE1zID8/IERFRkFVTFRfU1RBUlRfVElNRU9VVF9NUyxcbiAgICAgIGdyYWNlZnVsU2h1dGRvd25Nczogb3B0cy5ncmFjZWZ1bFNodXRkb3duTXMgPz8gREVGQVVMVF9HUkFDRUZVTF9NUyxcbiAgICAgIC4uLm9wdHMsXG4gICAgfTtcbiAgfVxuXG4gIGdldCBzdGF0ZSgpOiBIb3N0U3RhdGUge1xuICAgIHJldHVybiB0aGlzLl9zdGF0ZTtcbiAgfVxuXG4gIGdldCByZXN0YXJ0c1VzZWQoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gdGhpcy5yZXN0YXJ0Q291bnQ7XG4gIH1cblxuICBwcml2YXRlIHNldFN0YXRlKHM6IEhvc3RTdGF0ZSwgZXJyPzogc3RyaW5nKTogdm9pZCB7XG4gICAgdGhpcy5fc3RhdGUgPSBzO1xuICAgIGlmIChlcnIgIT09IHVuZGVmaW5lZCkgdGhpcy5sYXN0RXJyb3IgPSBlcnI7XG4gICAgY29uc3QgaW5mbzogeyByZXN0YXJ0Q291bnQ6IG51bWJlcjsgbGFzdEVycm9yPzogc3RyaW5nIH0gPSB7IHJlc3RhcnRDb3VudDogdGhpcy5yZXN0YXJ0Q291bnQgfTtcbiAgICBpZiAodGhpcy5sYXN0RXJyb3IgIT09ICcnKSBpbmZvLmxhc3RFcnJvciA9IHRoaXMubGFzdEVycm9yO1xuICAgIHRoaXMub3B0cy5vblN0YXRlQ2hhbmdlPy4ocywgaW5mbyk7XG4gIH1cblxuICAvKiogXHU1NDJGXHU1MkE4IGhvc3QgXHU1RTc2XHU3QjQ5XHU1Rjg1IHJlYWR5KFx1NUYxNVx1NUJGQ1x1ODg0QyArIFx1NUUyNiB0b2tlbiBcdTc2ODRcdTUwNjVcdTVFQjdcdTYzQTJcdTZENEIpXHUzMDAyICovXG4gIGFzeW5jIHN0YXJ0KCk6IFByb21pc2U8SG9zdEVuZHBvaW50PiB7XG4gICAgaWYgKHRoaXMuX3N0YXRlID09PSAncmVhZHknIHx8IHRoaXMuX3N0YXRlID09PSAnc3RhcnRpbmcnKSB7XG4gICAgICB0aHJvdyBkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYHN1cGVydmlzb3IgYWxyZWFkeSAke3RoaXMuX3N0YXRlfWApO1xuICAgIH1cbiAgICB0aGlzLnJlc3RhcnRDb3VudCA9IDA7XG4gICAgdGhpcy5zdG9wcGluZyA9IGZhbHNlO1xuICAgIHJldHVybiB0aGlzLmxhdW5jaCgpO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBsYXVuY2goKTogUHJvbWlzZTxIb3N0RW5kcG9pbnQ+IHtcbiAgICB0aGlzLnNldFN0YXRlKCdzdGFydGluZycpO1xuICAgIGNvbnN0IGNoaWxkID0gc3Bhd24odGhpcy5zcGVjLmNvbW1hbmQsIHRoaXMuc3BlYy5hcmdzLCB7XG4gICAgICBjd2Q6IHRoaXMuc3BlYy5jd2QsXG4gICAgICBlbnY6IHtcbiAgICAgICAgLi4ucHJvY2Vzcy5lbnYsXG4gICAgICAgIC4uLnRoaXMuc3BlYy5lbnYsXG4gICAgICAgIEhNSF9ERVNLVE9QX1RPS0VOOiB0aGlzLnRva2VuLFxuICAgICAgfSxcbiAgICAgIHN0ZGlvOiBbJ2lnbm9yZScsICdwaXBlJywgJ3BpcGUnXSxcbiAgICAgIHdpbmRvd3NIaWRlOiB0cnVlLFxuICAgIH0pO1xuICAgIHRoaXMuY2hpbGQgPSBjaGlsZDtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCBlbmRwb2ludCA9IGF3YWl0IHRoaXMuYXdhaXRSZWFkeShjaGlsZCk7XG4gICAgICB0aGlzLmN1cnJlbnRFbmRwb2ludCA9IHsgcG9ydDogZW5kcG9pbnQucG9ydCwgdmVyc2lvbjogZW5kcG9pbnQudmVyc2lvbiB9O1xuICAgICAgdGhpcy5zZXRTdGF0ZSgncmVhZHknKTtcbiAgICAgIHRoaXMub3B0cy5vblJlYWR5Py4oZW5kcG9pbnQpO1xuICAgICAgLy8gcmVhZHkgXHU0RTRCXHU1NDBFXHU4RkRCXHU3QTBCXHU2QjdCXHU0RUExID0gXHU2MTBGXHU1OTE2XHU5MDAwXHU1MUZBIFx1MjE5MiBcdTY3MDlcdTk2NTBcdTkxQ0RcdTU0MkZcbiAgICAgIGNoaWxkLm9uY2UoJ2V4aXQnLCAoKSA9PiB7XG4gICAgICAgIHRoaXMuZXhpdFdhaXRlcnMuZm9yRWFjaCgodykgPT4gdygpKTtcbiAgICAgICAgdGhpcy5leGl0V2FpdGVycyA9IFtdO1xuICAgICAgICB0aGlzLm9uVW5leHBlY3RlZEV4aXQoKTtcbiAgICAgIH0pO1xuICAgICAgcmV0dXJuIGVuZHBvaW50O1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgaWYgKCFjaGlsZC5raWxsZWQpIGNoaWxkLmtpbGwoKTtcbiAgICAgIGlmICh0aGlzLmNoaWxkID09PSBjaGlsZCkgdGhpcy5jaGlsZCA9IG51bGw7XG4gICAgICB0aHJvdyBlcnI7XG4gICAgfVxuICB9XG5cbiAgLyoqIFx1NEVDRSBzdGRvdXQgXHU2MjdFIEhvc3RSZWFkeUxpbmUsXHU3MTM2XHU1NDBFXHU1MDY1XHU1RUI3XHU2M0EyXHU2RDRCXHUzMDAyICovXG4gIHByaXZhdGUgYXdhaXRSZWFkeShjaGlsZDogQ2hpbGRQcm9jZXNzKTogUHJvbWlzZTxIb3N0RW5kcG9pbnQ+IHtcbiAgICByZXR1cm4gbmV3IFByb21pc2U8SG9zdEVuZHBvaW50PigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICByZWplY3QoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBob3N0IGRpZCBub3Qgc2lnbmFsIHJlYWR5IHdpdGhpbiAke3RoaXMub3B0cy5zdGFydFRpbWVvdXRNc31tc2AsIHsgcmV0cnlhYmxlOiB0cnVlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgICAgfSwgdGhpcy5vcHRzLnN0YXJ0VGltZW91dE1zKTtcblxuICAgICAgY29uc3QgZG9uZSA9IChmbjogKCkgPT4gdm9pZCk6IHZvaWQgPT4ge1xuICAgICAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgICAgICBmbigpO1xuICAgICAgfTtcblxuICAgICAgaWYgKCFjaGlsZC5zdGRvdXQpIHtcbiAgICAgICAgZG9uZSgoKSA9PiByZWplY3QoZGVza3RvcEVycm9yKCdSVU5USU1FX0NSQVNIRUQnLCAnaG9zdCBzcGF3bmVkIHdpdGhvdXQgc3Rkb3V0IHBpcGUnKSkpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHJsID0gY3JlYXRlSW50ZXJmYWNlKHsgaW5wdXQ6IGNoaWxkLnN0ZG91dCB9KTtcbiAgICAgIGNvbnN0IG9uTGluZSA9IChsaW5lOiBzdHJpbmcpOiB2b2lkID0+IHtcbiAgICAgICAgbGV0IHBhcnNlZDogdW5rbm93bjtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBwYXJzZWQgPSBKU09OLnBhcnNlKGxpbmUpO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICByZXR1cm47IC8vIGhvc3QgXHU3Njg0XHU2NjZFXHU5MDFBXHU2NUU1XHU1RkQ3XHU4ODRDLFx1NUZGRFx1NzU2NVxuICAgICAgICB9XG4gICAgICAgIGlmIChpc0hvc3RSZWFkeUxpbmUocGFyc2VkKSkge1xuICAgICAgICAgIHJsLmNsb3NlKCk7XG4gICAgICAgICAgdm9pZCB0aGlzLnByb2JlQW5kUmVtZW1iZXIocGFyc2VkLnBvcnQsIHBhcnNlZC52ZXJzaW9uKVxuICAgICAgICAgICAgLnRoZW4oKGVuZHBvaW50KSA9PiBkb25lKCgpID0+IHJlc29sdmUoZW5kcG9pbnQpKSlcbiAgICAgICAgICAgIC5jYXRjaCgoZXJyOiB1bmtub3duKSA9PiBkb25lKCgpID0+IHJlamVjdChlcnIpKSk7XG4gICAgICAgIH1cbiAgICAgIH07XG4gICAgICBybC5vbignbGluZScsIG9uTGluZSk7XG5cbiAgICAgIGNoaWxkLm9uY2UoJ2V4aXQnLCAoY29kZSkgPT4ge1xuICAgICAgICBkb25lKCgpID0+IHJlamVjdChkZXNrdG9wRXJyb3IoJ1JVTlRJTUVfQ1JBU0hFRCcsIGBob3N0IGV4aXRlZCBkdXJpbmcgc3RhcnR1cCAoY29kZSAke2NvZGUgPz8gJ251bGwnfSlgLCB7IHJldHJ5YWJsZTogZmFsc2UsIHJlY292ZXJ5QWN0aW9uOiAnT1BFTl9MT0dTJyB9KSkpO1xuICAgICAgfSk7XG4gICAgfSk7XG4gIH1cblxuICAvKiogXHU1RTI2IHRva2VuIFx1NzY4NFx1NTA2NVx1NUVCN1x1NjNBMlx1NkQ0QjpHRVQgL2FwaS9zdGF0ZVx1MzAwMjQwMSBcdTIxOTIgQVVUSF9GQUlMRUQoXHU0RTBEXHU5MUNEXHU4QkQ1KVx1MzAwMiAqL1xuICBwcml2YXRlIGFzeW5jIHByb2JlKHBvcnQ6IG51bWJlciwgdmVyc2lvbjogc3RyaW5nKTogUHJvbWlzZTxIb3N0RW5kcG9pbnQ+IHtcbiAgICBsZXQgcmVzOiBSZXNwb25zZTtcbiAgICB0cnkge1xuICAgICAgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9hcGkvc3RhdGVgLCB7XG4gICAgICAgIGhlYWRlcnM6IHsgJ3gtaG1oLWtleSc6IHRoaXMudG9rZW4gfSxcbiAgICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDNfMDAwKSxcbiAgICAgIH0pO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgdGhyb3cgZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBoZWFsdGggcHJvYmUgZmFpbGVkOiAke1N0cmluZyhlcnIpLnNsaWNlKDAsIDE2MCl9YCwgeyByZXRyeWFibGU6IHRydWUgfSk7XG4gICAgfVxuICAgIGlmIChyZXMuc3RhdHVzID09PSA0MDEgfHwgcmVzLnN0YXR1cyA9PT0gNDAzKSB7XG4gICAgICB0aHJvdyBkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgYGhvc3QgcmVqZWN0ZWQgdGhlIHNlc3Npb24gdG9rZW4gKEhUVFAgJHtyZXMuc3RhdHVzfSlgLCB7IHJldHJ5YWJsZTogZmFsc2UsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KTtcbiAgICB9XG4gICAgaWYgKCFyZXMub2spIHtcbiAgICAgIHRocm93IGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgaGVhbHRoIHByb2JlIEhUVFAgJHtyZXMuc3RhdHVzfWAsIHsgcmV0cnlhYmxlOiB0cnVlIH0pO1xuICAgIH1cbiAgICByZXR1cm4geyBwb3J0LCB2ZXJzaW9uLCB0b2tlbjogdGhpcy50b2tlbiB9O1xuICB9XG5cbiAgcHJpdmF0ZSBvblVuZXhwZWN0ZWRFeGl0KCk6IHZvaWQge1xuICAgIGlmICh0aGlzLnN0b3BwaW5nIHx8IHRoaXMuX3N0YXRlID09PSAnc3RvcHBlZCcgfHwgdGhpcy5fc3RhdGUgPT09ICdzdG9wcGluZycpIHJldHVybjtcbiAgICB0aGlzLmNoaWxkID0gbnVsbDtcbiAgICBpZiAodGhpcy5yZXN0YXJ0Q291bnQgPCB0aGlzLm9wdHMubWF4UmVzdGFydHMpIHtcbiAgICAgIHRoaXMucmVzdGFydENvdW50ICs9IDE7XG4gICAgICB0aGlzLnNldFN0YXRlKCdyZXN0YXJ0aW5nJyk7XG4gICAgICB2b2lkIHRoaXMubGF1bmNoKCkuY2F0Y2goKCkgPT4ge1xuICAgICAgICAvLyBcdTkxQ0RcdTU0MkZcdTVDMURcdThCRDVcdTU5MzFcdThEMjUoXHU1NDJGXHU1MkE4XHU1MzczXHU1RDI5L1x1OEQ4NVx1NjVGNi9cdTYyRDJcdThCQTQpOlx1N0VFN1x1N0VFRFx1NkQ4OFx1ODAxN1x1OTFDRFx1NTQyRlx1NkIyMVx1NjU3MFx1NzZGNFx1NTIzMFx1NjUzRVx1NUYwM1xuICAgICAgICB0aGlzLnJldHJ5T3JGYWlsKCk7XG4gICAgICB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5zZXRTdGF0ZSgnZmFpbGVkJywgYGhvc3QgZXhpdGVkIHVuZXhwZWN0ZWRseSAke3RoaXMucmVzdGFydENvdW50ICsgMX0gdGltZXM7IGdpdmluZyB1cGApO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgcmV0cnlPckZhaWwoKTogdm9pZCB7XG4gICAgaWYgKHRoaXMuc3RvcHBpbmcgfHwgdGhpcy5fc3RhdGUgPT09ICdzdG9wcGVkJyB8fCB0aGlzLl9zdGF0ZSA9PT0gJ3N0b3BwaW5nJykgcmV0dXJuO1xuICAgIGlmICh0aGlzLnJlc3RhcnRDb3VudCA8IHRoaXMub3B0cy5tYXhSZXN0YXJ0cykge1xuICAgICAgdGhpcy5yZXN0YXJ0Q291bnQgKz0gMTtcbiAgICAgIHRoaXMuc2V0U3RhdGUoJ3Jlc3RhcnRpbmcnKTtcbiAgICAgIHZvaWQgdGhpcy5sYXVuY2goKS5jYXRjaCgoKSA9PiB0aGlzLnJldHJ5T3JGYWlsKCkpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLnNldFN0YXRlKCdmYWlsZWQnLCBgaG9zdCBmYWlsZWQgdG8gc3RheSB1cCBhZnRlciAke3RoaXMucmVzdGFydENvdW50fSByZXN0YXJ0IGF0dGVtcHRzYCk7XG4gICAgfVxuICB9XG5cbiAgLyoqIFx1NEYxOFx1OTZDNVx1NTA1Q1x1NkI2MjpcdTUxNDggSFRUUCBzaHV0ZG93bixcdThEODVcdTY1RjZcdTYyNERcdTVCRjlcdTY3MkNcdThGREJcdTdBMEJcdTUzRTVcdTY3QzQga2lsbFx1MzAwMiAqL1xuICBhc3luYyBzdG9wKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIHRoaXMuc3RvcHBpbmcgPSB0cnVlO1xuICAgIGlmICh0aGlzLl9zdGF0ZSA9PT0gJ3N0b3BwZWQnKSByZXR1cm47XG4gICAgdGhpcy5zZXRTdGF0ZSgnc3RvcHBpbmcnKTtcbiAgICBjb25zdCBjaGlsZCA9IHRoaXMuY2hpbGQ7XG4gICAgdGhpcy5jaGlsZCA9IG51bGw7XG4gICAgdGhpcy5jdXJyZW50RW5kcG9pbnQgPSBudWxsO1xuICAgIGlmICghY2hpbGQpIHtcbiAgICAgIHRoaXMuc2V0U3RhdGUoJ3N0b3BwZWQnKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgZXhpdGVkID0gbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUpID0+IHtcbiAgICAgIGlmIChjaGlsZC5leGl0Q29kZSAhPT0gbnVsbCB8fCBjaGlsZC5zaWduYWxDb2RlICE9PSBudWxsKSByZXNvbHZlKCk7XG4gICAgICBlbHNlIHtcbiAgICAgICAgY29uc3QgdyA9ICgpOiB2b2lkID0+IHJlc29sdmUoKTtcbiAgICAgICAgdGhpcy5leGl0V2FpdGVycy5wdXNoKHcpO1xuICAgICAgICBjaGlsZC5vbmNlKCdleGl0Jywgdyk7XG4gICAgICB9XG4gICAgfSk7XG4gICAgLy8gXHU1REYyXHU3N0U1XHU3QUVGXHU1M0UzXHU2MjREXHU1QzFEXHU4QkQ1IEhUVFAgXHU0RjE4XHU5NkM1XHU1MTczXHU5NUVEO1x1NjcyQVx1NzdFNVx1N0FFRlx1NTNFM1x1NzZGNFx1NjNBNVx1OEQ3MCBraWxsIFx1NTE1Q1x1NUU5NVxuICAgIGlmICh0aGlzLmxhc3RFbmRwb2ludCAhPT0gbnVsbCkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHt0aGlzLmxhc3RFbmRwb2ludH0vYXBpL2Rlc2t0b3Avc2h1dGRvd25gLCB7XG4gICAgICAgICAgbWV0aG9kOiAnUE9TVCcsXG4gICAgICAgICAgaGVhZGVyczogeyAneC1obWgta2V5JzogdGhpcy50b2tlbiB9LFxuICAgICAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCgxXzAwMCksXG4gICAgICAgIH0pO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8vIGhvc3QgXHU1REYyXHU2QjdCXHU2MjE2XHU0RTBEXHU1RTk0XHU3QjU0Olx1OEQ3MCBraWxsIFx1NTE1Q1x1NUU5NVxuICAgICAgfVxuICAgIH1cbiAgICBjb25zdCBncmFjZWZ1bCA9IGF3YWl0IFByb21pc2UucmFjZShbXG4gICAgICBleGl0ZWQudGhlbigoKSA9PiB0cnVlKSxcbiAgICAgIG5ldyBQcm9taXNlPGJvb2xlYW4+KChyZXNvbHZlKSA9PiBzZXRUaW1lb3V0KCgpID0+IHJlc29sdmUoZmFsc2UpLCB0aGlzLm9wdHMuZ3JhY2VmdWxTaHV0ZG93bk1zKSksXG4gICAgXSk7XG4gICAgaWYgKCFncmFjZWZ1bCAmJiBjaGlsZC5leGl0Q29kZSA9PT0gbnVsbCAmJiBjaGlsZC5zaWduYWxDb2RlID09PSBudWxsKSB7XG4gICAgICBjaGlsZC5raWxsKCk7IC8vIFx1NTNFQVx1Njc0MFx1ODFFQVx1NURGMVx1NjMwMVx1NjcwOVx1NzY4NFx1NTNFNVx1NjdDNCxcdTdFRERcdTRFMERcdTYzMDlcdThGREJcdTdBMEJcdTU0MERcbiAgICB9XG4gICAgYXdhaXQgZXhpdGVkLmNhdGNoKCgpID0+IHVuZGVmaW5lZCk7XG4gICAgdGhpcy5zZXRTdGF0ZSgnc3RvcHBlZCcpO1xuICB9XG5cbiAgcHJpdmF0ZSBsYXN0RW5kcG9pbnQ6IG51bWJlciB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIGN1cnJlbnRFbmRwb2ludDogeyBwb3J0OiBudW1iZXI7IHZlcnNpb246IHN0cmluZyB9IHwgbnVsbCA9IG51bGw7XG5cbiAgLyoqIFx1NUY1M1x1NTI0RCBob3N0IFx1N0FFRlx1NzBCOShyZWFkeSBcdTU0MEVcdTY3MDlcdTUwM0M7XHU0RTBEXHU1NDJCIHRva2VuKVx1MzAwMiAqL1xuICBnZXQgZW5kcG9pbnQoKTogeyBwb3J0OiBudW1iZXI7IHZlcnNpb246IHN0cmluZyB9IHwgbnVsbCB7XG4gICAgcmV0dXJuIHRoaXMuY3VycmVudEVuZHBvaW50O1xuICB9XG5cbiAgLyoqIFx1NjNBMlx1NkQ0Qlx1NjIxMFx1NTI5Rlx1NTQwRVx1OEJCMFx1NEY0Rlx1N0FFRlx1NTNFMyxcdTRGOUIgc3RvcCgpIFx1NzY4NFx1NEYxOFx1OTZDNVx1NTE3M1x1OTVFRFx1NEY3Rlx1NzUyOFx1MzAwMiAqL1xuICBwcml2YXRlIGFzeW5jIHByb2JlQW5kUmVtZW1iZXIocG9ydDogbnVtYmVyLCB2ZXJzaW9uOiBzdHJpbmcpOiBQcm9taXNlPEhvc3RFbmRwb2ludD4ge1xuICAgIGNvbnN0IGVwID0gYXdhaXQgdGhpcy5wcm9iZShwb3J0LCB2ZXJzaW9uKTtcbiAgICB0aGlzLmxhc3RFbmRwb2ludCA9IGVwLnBvcnQ7XG4gICAgcmV0dXJuIGVwO1xuICB9XG59XG5cbi8qKiBcdTYyOEFcdTY3MkFcdTc3RTVcdTk1MTlcdThCRUZcdTg5QzRcdTdFQTZcdTRFM0EgRGVza3RvcEVycm9yKFx1NURGMlx1NjYyRlx1NTIxOVx1NTM5Rlx1NjgzN1x1OEZENFx1NTZERSlcdTMwMDIgKi9cbmV4cG9ydCBmdW5jdGlvbiB0b0Rlc2t0b3BFcnJvcihlcnI6IHVua25vd24pOiBEZXNrdG9wRXJyb3Ige1xuICBpZiAoaXNEZXNrdG9wRXJyb3IoZXJyKSkgcmV0dXJuIGVycjtcbiAgY29uc3QgbWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgcmV0dXJuIGRlc2t0b3BFcnJvcignUlVOVElNRV9DUkFTSEVEJywgbWVzc2FnZS5zbGljZSgwLCAzMDApLCB7IHJldHJ5YWJsZTogZmFsc2UgfSk7XG59XG4iLCAiLyoqXG4gKiBAaG1oLWRlc2t0b3AvY29udHJhY3RzIFx1MjAxNCBcdTRFOEJcdTRFRjZcdTRGRTFcdTVDMDEoXHU1RjAwXHU1M0QxXHU4QkExXHU1MjEyXHU2NTg3XHU2ODYzIDA0IFx1MDBBN1x1NEUwOSlcbiAqXG4gKiBcdTRFMDBcdTY3NjEgVUkgXHU0RThCXHU0RUY2XHU3Njg0XHU1NTJGXHU0RTAwXHU1RjYyXHU3MkI2XHUzMDAyXHU1MjREXHU3QUVGIHJlZHVjZXIgXHU1RkM1XHU5ODdCXHU2MzA5IHNlc3Npb25JZC9ydW5JZC9zZXEgXHU1OTA0XHU3NDA2O1xuICogXHU5MUNEXHU1OTBEIGV2ZW50SWQgXHU1RTQyXHU3QjQ5XHU0RTIyXHU1RjAzO3NlcSBcdTdGM0FcdTUzRTNcdTg5RTZcdTUzRDFcdTg4NjVcdTYyQzk7XHU5NzVFXHU1RTQyXHU3QjQ5XHU1MkE4XHU0RjVDXHU0RTBEXHU3NTMxIFNTRSBcdTgxRUFcdTUyQThcdTkxQ0RcdTUzRDFcdTMwMDJcbiAqL1xuXG5pbXBvcnQgdHlwZSB7IEFydGlmYWN0UmVmIH0gZnJvbSAnLi9kdG8udHMnO1xuaW1wb3J0IHR5cGUgeyBEZXNrdG9wRXJyb3IgfSBmcm9tICcuL2Vycm9yLnRzJztcblxuLyoqIFx1NEU4Qlx1NEVGNlx1NzlDRFx1N0M3QihcdTUyMjRcdTUyMkJcdTk1MkUpXHUzMDAyXHU2NUIwXHU1ODlFIGtpbmQgPSBzY2hlbWFWZXJzaW9uIFx1NTM0N1x1N0VBNyxcdTRFMERcdTUxNDFcdThCQjhcdTk3NTlcdTlFRDhcdTYyNjlcdTY3OUFcdTRFM0VcdTMwMDIgKi9cbmV4cG9ydCBjb25zdCBFVkVOVF9LSU5EUyA9IFtcbiAgJ3J1bi5zdGFydGVkJyxcbiAgJ3BsYW4udXBkYXRlZCcsXG4gICd0b29sLnN0YXJ0ZWQnLFxuICAndG9vbC5jb21wbGV0ZWQnLFxuICAnYXBwcm92YWwucmVxdWlyZWQnLFxuICAndmVyaWZpY2F0aW9uLnVwZGF0ZWQnLFxuICAnYXJ0aWZhY3QuY3JlYXRlZCcsXG4gICdydW4uY29tcGxldGVkJyxcbiAgJ3J1bi5mYWlsZWQnLFxuXSBhcyBjb25zdDtcblxuZXhwb3J0IHR5cGUgRXZlbnRLaW5kID0gKHR5cGVvZiBFVkVOVF9LSU5EUylbbnVtYmVyXTtcblxuZXhwb3J0IGNvbnN0IEVWRU5UX1NDSEVNQV9WRVJTSU9OID0gMTtcbmV4cG9ydCB0eXBlIEV2ZW50U2NoZW1hVmVyc2lvbiA9IDE7XG5cbi8qKiBTU0UgXHU2RDQxXHU0RTBBXHU3Njg0XHU2QkNGXHU0RTAwXHU2NzYxXHU0RThCXHU0RUY2XHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIEV2ZW50RW52ZWxvcGU8VCA9IHVua25vd24+IHtcbiAgc2NoZW1hVmVyc2lvbjogRXZlbnRTY2hlbWFWZXJzaW9uO1xuICAvKiogXHU1MTY4XHU1QzQwXHU1NTJGXHU0RTAwO1x1OTFDRFx1OEZERS9cdTg4NjVcdTYyQzlcdTU0MEVcdTkxQ0RcdTU5MERcdTUxRkFcdTczQjBcdTY1RjZcdTYzQTVcdTY1MzZcdTY1QjlcdTVFNDJcdTdCNDlcdTRFMjJcdTVGMDNcdTMwMDIgKi9cbiAgZXZlbnRJZDogc3RyaW5nO1xuICBzZXNzaW9uSWQ6IHN0cmluZztcbiAgcnVuSWQ6IHN0cmluZztcbiAgLyoqIFx1NEYxQVx1OEJERFx1NTE4NVx1NTM1NVx1OEMwM1x1OTAxMlx1NTg5RTtcdTdGM0FcdTUzRTNcdTYxMEZcdTU0NzNcdTc3NDBcdTRFMjJcdTRFOEJcdTRFRjYsXHU5NzAwXHU4OTgxXHU4ODY1XHU2MkM5XHUzMDAyICovXG4gIHNlcTogbnVtYmVyO1xuICAvKiogUkZDMzMzOVx1MzAwMiAqL1xuICBvY2N1cnJlZEF0OiBzdHJpbmc7XG4gIGtpbmQ6IEV2ZW50S2luZDtcbiAgcGF5bG9hZDogVDtcbn1cblxuLyoqIHJ1bi5zdGFydGVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyICovXG5leHBvcnQgaW50ZXJmYWNlIFJ1blN0YXJ0ZWRQYXlsb2FkIHtcbiAgdGFzazogc3RyaW5nO1xuICBtb2RlOiAnYXNrJyB8ICdhdXRvJyB8ICd5b2xvJztcbn1cblxuLyoqIHBsYW4udXBkYXRlZCBcdTc2ODQgcGF5bG9hZChcdThCQTFcdTUyMTJcdTZCNjVcdTlBQTRcdTUyMTdcdTg4NjgsXHU2NzY1XHU4MUVBIHJ1bnRpbWUgXHU3Njg0XHU3RUQzXHU2Nzg0XHU1MzE2XHU4QkExXHU1MjEyLFx1NEUwRFx1NjYyRiBjaGFpbi1vZi10aG91Z2h0KVx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBQbGFuVXBkYXRlZFBheWxvYWQge1xuICBzdGVwczogQXJyYXk8eyB0aXRsZTogc3RyaW5nOyBzdGF0dXM6ICdwZW5kaW5nJyB8ICdhY3RpdmUnIHwgJ2RvbmUnIHwgJ2ZhaWxlZCcgfT47XG59XG5cbi8qKiB0b29sLnN0YXJ0ZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgVG9vbFN0YXJ0ZWRQYXlsb2FkIHtcbiAgbmFtZTogc3RyaW5nO1xuICAvKiogXHU1M0MyXHU2NTcwXHU0RUU1XHU2NTg3XHU2NzJDXHU1NDQ4XHU3M0IwLFx1NkUzMlx1NjdEM1x1N0FFRlx1NkMzOFx1NEUwRCBldmFsO1x1NTkyN1x1NUJGOVx1OEM2MVx1NzUzMSBydW50aW1lIFx1NjIyQVx1NjVBRFx1MzAwMiAqL1xuICBhcmdzUHJldmlldzogc3RyaW5nO1xufVxuXG4vKiogdG9vbC5jb21wbGV0ZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgVG9vbENvbXBsZXRlZFBheWxvYWQge1xuICBuYW1lOiBzdHJpbmc7XG4gIGlzRXJyb3I6IGJvb2xlYW47XG4gIG91dHB1dFByZXZpZXc6IHN0cmluZztcbn1cblxuLyoqIGFwcHJvdmFsLnJlcXVpcmVkIFx1NzY4NCBwYXlsb2FkXHUzMDAyXHU1QkExXHU2Mjc5XHU2NzQzXHU1QTAxXHU1NzI4IHJ1bnRpbWUgXHU1NDBFXHU3QUVGO1VJIFx1NTNFQVx1NjYyRlx1OEY2Q1x1OEZGMFx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHByb3ZhbFJlcXVpcmVkUGF5bG9hZCB7XG4gIGFwcHJvdmFsSWQ6IHN0cmluZztcbiAgdG9vbDogc3RyaW5nO1xuICBhcmdzUHJldmlldzogc3RyaW5nO1xuICAvKiogXHU1RjcxXHU1NENEXHU4MzAzXHU1NkY0L1x1OThDRVx1OTY2OVx1NzY4NFx1NEVCQVx1N0M3Qlx1NTNFRlx1OEJGQlx1OEJGNFx1NjYwRSxcdTc1MzEgcnVudGltZSBcdTc1MUZcdTYyMTBcdTMwMDIgKi9cbiAgcmlzazogc3RyaW5nO1xufVxuXG4vKiogdmVyaWZpY2F0aW9uLnVwZGF0ZWQgXHU3Njg0IHBheWxvYWRcdTMwMDIgKi9cbmV4cG9ydCBpbnRlcmZhY2UgVmVyaWZpY2F0aW9uVXBkYXRlZFBheWxvYWQge1xuICBzdW1tYXJ5OiBzdHJpbmc7XG4gIHBhc3NlZDogYm9vbGVhbiB8IG51bGw7IC8vIG51bGwgPSBcdTY3MkFcdTc3RTUvXHU4RkRCXHU4ODRDXHU0RTJEKE5FRURTLURBVEEgXHU2NUY2XHU0RTBEXHU1MDQ3XHU1ODZCKVxufVxuXG4vKiogYXJ0aWZhY3QuY3JlYXRlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcnRpZmFjdENyZWF0ZWRQYXlsb2FkIHtcbiAgYXJ0aWZhY3Q6IEFydGlmYWN0UmVmO1xufVxuXG4vKiogcnVuLmNvbXBsZXRlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBSdW5Db21wbGV0ZWRQYXlsb2FkIHtcbiAgdGV4dDogc3RyaW5nO1xuICB0dXJuczogbnVtYmVyO1xuICB0b29sVXNlczogbnVtYmVyO1xuICB1c2FnZT86IHsgcHJvbXB0VG9rZW5zOiBudW1iZXI7IGNvbXBsZXRpb25Ub2tlbnM6IG51bWJlciB9O1xufVxuXG4vKiogcnVuLmZhaWxlZCBcdTc2ODQgcGF5bG9hZFx1MzAwMiAqL1xuZXhwb3J0IGludGVyZmFjZSBSdW5GYWlsZWRQYXlsb2FkIHtcbiAgZXJyb3I6IERlc2t0b3BFcnJvcjtcbn1cbiIsICIvKipcbiAqIEBobWgtZGVza3RvcC9jb250cmFjdHMgXHUyMDE0IFx1N0VEM1x1Njc4NFx1NTMxNlx1Njg0Q1x1OTc2Mlx1OTUxOVx1OEJFRihcdTVGMDBcdTUzRDFcdThCQTFcdTUyMTJcdTY1ODdcdTY4NjMgMDQgXHUwMEE3XHU0RTA5KVx1MzAwMlxuICpcbiAqIGhvc3Qtbm90LXJlYWR5IC8gYXV0aC1mYWlsZWQgLyBzdGFsZS12ZXJzaW9uIC8gcnVudGltZS1jcmFzaGVkIC9cbiAqIHBvcnQtYmluZC1mYWlsZWQgLyBzY2hlbWEtbWlzbWF0Y2ggXHU1RkM1XHU5ODdCXHU2NjJGXHU3RUQzXHU2Nzg0XHU1MzE2XHU5NTE5XHU4QkVGXHU3ODAxLFx1NUU3Nlx1NjNEMFx1NEY5Qlx1NEUwQlx1NEUwMFx1NkI2NVx1NTJBOFx1NEY1Q1x1MzAwMlxuICogbWVzc2FnZSBcdTY2MkZcdTdFQUZcdTY1ODdcdTY3MkMsXHU2RTMyXHU2N0QzXHU3QUVGXHU2QzM4XHU0RTBEXHU2MjhBXHU1QjgzXHU1RjUzIEhUTUxcdTMwMDJcbiAqL1xuZXhwb3J0IGNvbnN0IEVSUk9SX0NPREVTID0gW1xuICAnSE9TVF9OT1RfUkVBRFknLFxuICAnQVVUSF9GQUlMRUQnLFxuICAnUlVOVElNRV9DUkFTSEVEJyxcbiAgJ1BPUlRfQklORF9GQUlMRUQnLFxuICAnU1RBTEVfVkVSU0lPTicsXG4gICdTQ0hFTUFfTUlTTUFUQ0gnLFxuXSBhcyBjb25zdDtcblxuZXhwb3J0IHR5cGUgRXJyb3JDb2RlID0gKHR5cGVvZiBFUlJPUl9DT0RFUylbbnVtYmVyXTtcblxuZXhwb3J0IGNvbnN0IFJFQ09WRVJZX0FDVElPTlMgPSBbJ1JFQ09OTkVDVCcsICdSRVNVTUUnLCAnRVhQT1JUJywgJ09QRU5fTE9HUyddIGFzIGNvbnN0O1xuZXhwb3J0IHR5cGUgUmVjb3ZlcnlBY3Rpb24gPSAodHlwZW9mIFJFQ09WRVJZX0FDVElPTlMpW251bWJlcl07XG5cbmV4cG9ydCBpbnRlcmZhY2UgRGVza3RvcEVycm9yIHtcbiAgY29kZTogRXJyb3JDb2RlO1xuICAvKiogXHU3RUFGXHU2NTg3XHU2NzJDLFx1NkMzOFx1NEUwRFx1NEZFMVx1NEVGQlx1NEUzQSBIVE1MXHUzMDAyICovXG4gIG1lc3NhZ2U6IHN0cmluZztcbiAgcmV0cnlhYmxlOiBib29sZWFuO1xuICBzZXNzaW9uSWQ/OiBzdHJpbmc7XG4gIHJ1bklkPzogc3RyaW5nO1xuICByZWNvdmVyeUFjdGlvbj86IFJlY292ZXJ5QWN0aW9uO1xufVxuXG4vKiogXHU2Nzg0XHU5MDIwXHU0RTAwXHU0RTJBIERlc2t0b3BFcnJvcihleGFjdE9wdGlvbmFsUHJvcGVydHlUeXBlcyBcdTUzQ0JcdTU5N0QpXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gZGVza3RvcEVycm9yKFxuICBjb2RlOiBFcnJvckNvZGUsXG4gIG1lc3NhZ2U6IHN0cmluZyxcbiAgb3B0czogeyByZXRyeWFibGU/OiBib29sZWFuOyBzZXNzaW9uSWQ/OiBzdHJpbmc7IHJ1bklkPzogc3RyaW5nOyByZWNvdmVyeUFjdGlvbj86IFJlY292ZXJ5QWN0aW9uIH0gPSB7fSxcbik6IERlc2t0b3BFcnJvciB7XG4gIGNvbnN0IGU6IERlc2t0b3BFcnJvciA9IHsgY29kZSwgbWVzc2FnZSwgcmV0cnlhYmxlOiBvcHRzLnJldHJ5YWJsZSA9PT0gdHJ1ZSB9O1xuICBpZiAob3B0cy5zZXNzaW9uSWQgIT09IHVuZGVmaW5lZCkgZS5zZXNzaW9uSWQgPSBvcHRzLnNlc3Npb25JZDtcbiAgaWYgKG9wdHMucnVuSWQgIT09IHVuZGVmaW5lZCkgZS5ydW5JZCA9IG9wdHMucnVuSWQ7XG4gIGlmIChvcHRzLnJlY292ZXJ5QWN0aW9uICE9PSB1bmRlZmluZWQpIGUucmVjb3ZlcnlBY3Rpb24gPSBvcHRzLnJlY292ZXJ5QWN0aW9uO1xuICByZXR1cm4gZTtcbn1cbiIsICIvKipcbiAqIEBobWgtZGVza3RvcC9jb250cmFjdHMgXHUyMDE0IHJ1bnRpbWUgXHU2ODIxXHU5QThDKGd1YXJkcylcdTMwMDJcbiAqXG4gKiBcdTZCQ0ZcdTRFMkFcdThERThcdTRGRTFcdTRFRkJcdThGQjlcdTc1NENcdTc2ODRcdTY1NzBcdTYzNkUocnVudGltZVx1MjE5MnJlbmRlcmVyXHUzMDAxaG9zdFx1MjE5Mm1haW4pXHU4RkRCXHU1MTY1XHU1MjREXHU1MTQ4XHU4RkM3IGd1YXJkO1xuICogXHU2ODIxXHU5QThDXHU1OTMxXHU4RDI1XHU3Njg0XHU2NTcwXHU2MzZFXHU2MzA5IFNDSEVNQV9NSVNNQVRDSCBcdTdFRDNcdTY3ODRcdTUzMTZcdTk1MTlcdThCRUZcdTU5MDRcdTc0MDYsXHU0RTBEXHU5NzU5XHU5RUQ4XHU2M0E1XHU1M0Q3XHUzMDAyXG4gKiBcdTYyNEJcdTUxOTlcdTVCODhcdTUzNkJcdTgwMENcdTRFMERcdTY2MkZcdTVGMTVcdTdCMkNcdTRFMDlcdTY1Qjkgc2NoZW1hIFx1NUU5MzpcdTU5NTFcdTdFQTZcdTk3NjJcdTVDMEYsXHU5NkY2XHU0RjlEXHU4RDU2XHU2NTg3XHU1MzE2KGhtaGFybmVzcyBcdTU0MENcdTZFOTApXHUzMDAyXG4gKi9cbmltcG9ydCB7XG4gIEVWRU5UX0tJTkRTLFxuICBFVkVOVF9TQ0hFTUFfVkVSU0lPTixcbiAgdHlwZSBFdmVudEVudmVsb3BlLFxuICB0eXBlIEV2ZW50S2luZCxcbn0gZnJvbSAnLi9ldmVudC50cyc7XG5pbXBvcnQgeyBFUlJPUl9DT0RFUywgUkVDT1ZFUllfQUNUSU9OUywgdHlwZSBEZXNrdG9wRXJyb3IgfSBmcm9tICcuL2Vycm9yLnRzJztcbmltcG9ydCB7IFJVTl9TVEFUVVNFUywgdHlwZSBSdW5TdGF0dXMgfSBmcm9tICcuL2R0by50cyc7XG5cbmNvbnN0IGlzUmVjb3JkID0gKHY6IHVua25vd24pOiB2IGlzIFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0+XG4gIHR5cGVvZiB2ID09PSAnb2JqZWN0JyAmJiB2ICE9PSBudWxsICYmICFBcnJheS5pc0FycmF5KHYpO1xuXG5jb25zdCBpc05vbkVtcHR5U3RyaW5nID0gKHY6IHVua25vd24pOiB2IGlzIHN0cmluZyA9PiB0eXBlb2YgdiA9PT0gJ3N0cmluZycgJiYgdi5sZW5ndGggPiAwO1xuXG5jb25zdCBpc1JmYzMzMzkgPSAodjogc3RyaW5nKTogYm9vbGVhbiA9PiB7XG4gIGNvbnN0IHQgPSBEYXRlLnBhcnNlKHYpO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKHQpICYmIC9cXGR7NH0tXFxkezJ9LVxcZHsyfVQvLnRlc3Qodik7XG59O1xuXG5leHBvcnQgZnVuY3Rpb24gaXNFdmVudEVudmVsb3BlKHY6IHVua25vd24pOiB2IGlzIEV2ZW50RW52ZWxvcGUge1xuICBpZiAoIWlzUmVjb3JkKHYpKSByZXR1cm4gZmFsc2U7XG4gIGlmICh2LnNjaGVtYVZlcnNpb24gIT09IEVWRU5UX1NDSEVNQV9WRVJTSU9OKSByZXR1cm4gZmFsc2U7XG4gIGlmICghaXNOb25FbXB0eVN0cmluZyh2LmV2ZW50SWQpKSByZXR1cm4gZmFsc2U7XG4gIGlmICghaXNOb25FbXB0eVN0cmluZyh2LnNlc3Npb25JZCkpIHJldHVybiBmYWxzZTtcbiAgaWYgKCFpc05vbkVtcHR5U3RyaW5nKHYucnVuSWQpKSByZXR1cm4gZmFsc2U7XG4gIGlmICh0eXBlb2Ygdi5zZXEgIT09ICdudW1iZXInIHx8ICFOdW1iZXIuaXNJbnRlZ2VyKHYuc2VxKSB8fCB2LnNlcSA8IDApIHJldHVybiBmYWxzZTtcbiAgaWYgKCFpc05vbkVtcHR5U3RyaW5nKHYub2NjdXJyZWRBdCkgfHwgIWlzUmZjMzMzOSh2Lm9jY3VycmVkQXQpKSByZXR1cm4gZmFsc2U7XG4gIGlmICghRVZFTlRfS0lORFMuaW5jbHVkZXModi5raW5kIGFzIEV2ZW50S2luZCkpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIGlzUmVjb3JkKHYucGF5bG9hZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0Rlc2t0b3BFcnJvcih2OiB1bmtub3duKTogdiBpcyBEZXNrdG9wRXJyb3Ige1xuICBpZiAoIWlzUmVjb3JkKHYpKSByZXR1cm4gZmFsc2U7XG4gIGlmICghRVJST1JfQ09ERVMuaW5jbHVkZXModi5jb2RlIGFzIG5ldmVyKSkgcmV0dXJuIGZhbHNlO1xuICBpZiAodHlwZW9mIHYubWVzc2FnZSAhPT0gJ3N0cmluZycpIHJldHVybiBmYWxzZTtcbiAgaWYgKHR5cGVvZiB2LnJldHJ5YWJsZSAhPT0gJ2Jvb2xlYW4nKSByZXR1cm4gZmFsc2U7XG4gIGlmICh2LnNlc3Npb25JZCAhPT0gdW5kZWZpbmVkICYmICFpc05vbkVtcHR5U3RyaW5nKHYuc2Vzc2lvbklkKSkgcmV0dXJuIGZhbHNlO1xuICBpZiAodi5ydW5JZCAhPT0gdW5kZWZpbmVkICYmICFpc05vbkVtcHR5U3RyaW5nKHYucnVuSWQpKSByZXR1cm4gZmFsc2U7XG4gIGlmICh2LnJlY292ZXJ5QWN0aW9uICE9PSB1bmRlZmluZWQgJiYgIVJFQ09WRVJZX0FDVElPTlMuaW5jbHVkZXModi5yZWNvdmVyeUFjdGlvbiBhcyBuZXZlcikpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpc1J1blN0YXR1cyh2OiB1bmtub3duKTogdiBpcyBSdW5TdGF0dXMge1xuICByZXR1cm4gdHlwZW9mIHYgPT09ICdzdHJpbmcnICYmIFJVTl9TVEFUVVNFUy5pbmNsdWRlcyh2IGFzIFJ1blN0YXR1cyk7XG59XG5cbi8qKiBIb3N0IFx1NUYxNVx1NUJGQ1x1ODg0QyhzdGRvdXQgXHU3QjJDXHU0RTAwXHU4ODRDKVx1MzAwMiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzSG9zdFJlYWR5TGluZSh2OiB1bmtub3duKTogdiBpcyB7IGhtaERlc2t0b3BIb3N0UmVhZHk6IHRydWU7IHBvcnQ6IG51bWJlcjsgdmVyc2lvbjogc3RyaW5nIH0ge1xuICBpZiAoIWlzUmVjb3JkKHYpKSByZXR1cm4gZmFsc2U7XG4gIGlmICh2LmhtaERlc2t0b3BIb3N0UmVhZHkgIT09IHRydWUpIHJldHVybiBmYWxzZTtcbiAgaWYgKHR5cGVvZiB2LnBvcnQgIT09ICdudW1iZXInIHx8ICFOdW1iZXIuaXNJbnRlZ2VyKHYucG9ydCkgfHwgdi5wb3J0IDw9IDAgfHwgdi5wb3J0ID4gNjU1MzUpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIGlzTm9uRW1wdHlTdHJpbmcodi52ZXJzaW9uKTtcbn1cbiIsICIvKipcbiAqIERlc2t0b3BIb3N0Q2xpZW50IFx1MjAxNCBcdTVCRjkgaG1oIGhvc3QgXHU3Njg0IEhUVFArU1NFIFx1NUJBMlx1NjIzN1x1N0FFRlx1MzAwMlxuICpcbiAqIC0gXHU2QkNGXHU0RTJBIEhUVFAgXHU4QkY3XHU2QzQyXHU4MUVBXHU1MkE4XHU1RTI2IFgtSG1oLUtleSh0b2tlbiBcdTRFMERcdThGREIgVVJMKTtcbiAqIC0gXHU3RUQzXHU2Nzg0XHU1MzE2XHU5NTE5XHU4QkVGKHJlcy5ib2R5IFx1OTFDQ1x1NzY4NCBEZXNrdG9wRXJyb3IgXHU1RjYyXHU3MkI2XHU2MjE2IEhUVFAgXHU3MkI2XHU2MDAxKVx1ODlDNFx1N0VBNlx1NjIxMFx1NUYwMlx1NUUzOFx1NjI5Qlx1NTFGQTtcbiAqIC0gU1NFIFx1NzUyOCBmZXRjaCBcdTZENDFcdTYyNEJcdTUxOTlcdTg5RTNcdTY3OTAoaWQvZXZlbnQvZGF0YSBcdTVFMjcpLFx1NjUyRlx1NjMwMSBMYXN0LUV2ZW50LUlEIFx1ODg2NVx1NjJDOVx1OTFDRFx1OEZERVx1MzAwMlxuICovXG5pbXBvcnQgeyBkZXNrdG9wRXJyb3IsIGlzRGVza3RvcEVycm9yLCBpc0V2ZW50RW52ZWxvcGUsIHR5cGUgRGVza3RvcEVycm9yLCB0eXBlIEV2ZW50RW52ZWxvcGUgfSBmcm9tICdAaG1oLWRlc2t0b3AvY29udHJhY3RzJztcbmltcG9ydCB7IHJhbmRvbVVVSUQgfSBmcm9tICdub2RlOmNyeXB0byc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3NlRnJhbWUge1xuICBpZD86IHN0cmluZztcbiAgZXZlbnQ6IHN0cmluZztcbiAgZGF0YTogc3RyaW5nO1xufVxuXG4vKiogXHU4OUUzXHU2NzkwXHU0RTAwXHU2QkI1IFNTRSBcdTY1ODdcdTY3MkNcdTRFM0FcdTVFMjcoXHU0RTBEXHU1NDJCXHU4REU4IGNodW5rIFx1NzY4NFx1N0YxM1x1NTFCMlx1OTAzQlx1OEY5MSxcdTdFQUZcdTUxRkRcdTY1NzBcdTRGQkZcdTRFOEVcdTZENEJcdThCRDUpXHUzMDAyICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VTc2VDaHVuayhjaHVuazogc3RyaW5nKTogU3NlRnJhbWVbXSB7XG4gIGNvbnN0IGZyYW1lczogU3NlRnJhbWVbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGJsb2NrIG9mIGNodW5rLnNwbGl0KC9cXG5cXG4vKSkge1xuICAgIGlmICghYmxvY2sudHJpbSgpKSBjb250aW51ZTtcbiAgICBsZXQgaWQ6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICBsZXQgZXZlbnQgPSAnbWVzc2FnZSc7XG4gICAgY29uc3QgZGF0YUxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGxldCBzYXdGaWVsZCA9IGZhbHNlO1xuICAgIGZvciAoY29uc3QgbGluZSBvZiBibG9jay5zcGxpdCgnXFxuJykpIHtcbiAgICAgIGlmIChsaW5lLnN0YXJ0c1dpdGgoJzonKSkgY29udGludWU7IC8vIFx1NkNFOFx1OTFDQS9cdTVGQzNcdThERjNcbiAgICAgIGlmIChsaW5lLnN0YXJ0c1dpdGgoJ2lkOicpKSB7IGlkID0gbGluZS5zbGljZSgzKS50cmltKCk7IHNhd0ZpZWxkID0gdHJ1ZTsgfVxuICAgICAgZWxzZSBpZiAobGluZS5zdGFydHNXaXRoKCdldmVudDonKSkgeyBldmVudCA9IGxpbmUuc2xpY2UoNikudHJpbSgpOyBzYXdGaWVsZCA9IHRydWU7IH1cbiAgICAgIGVsc2UgaWYgKGxpbmUuc3RhcnRzV2l0aCgnZGF0YTonKSkgeyBkYXRhTGluZXMucHVzaChsaW5lLnNsaWNlKDUpLnJlcGxhY2UoL14gLywgJycpKTsgc2F3RmllbGQgPSB0cnVlOyB9XG4gICAgfVxuICAgIGlmICghc2F3RmllbGQpIGNvbnRpbnVlOyAvLyBcdTdFQUZcdTZDRThcdTkxQ0EvXHU1RkMzXHU4REYzXHU1NzU3XHU0RTBEXHU0RUE3XHU3NTFGXHU1RTI3XG4gICAgZnJhbWVzLnB1c2goeyAuLi4oaWQgIT09IHVuZGVmaW5lZCA/IHsgaWQgfSA6IHt9KSwgZXZlbnQsIGRhdGE6IGRhdGFMaW5lcy5qb2luKCdcXG4nKSB9KTtcbiAgfVxuICByZXR1cm4gZnJhbWVzO1xufVxuXG4vKiogXHU0RUNFIFNTRSBcdTVFMjdcdTY1NzBcdTYzNkVcdTRFMkRcdTg5RTNcdTUxRkFcdTU0MDhcdTZDRDUgRXZlbnRFbnZlbG9wZTtcdTRFMERcdTU0MDhcdTZDRDVcdTc2ODRcdThGRDRcdTU2REUgbnVsbChTQ0hFTUFfTUlTTUFUQ0ggXHU3NTMxXHU4QzAzXHU3NTI4XHU2NUI5XHU4QkExXHU2NTcwKVx1MzAwMiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVudmVsb3BlRnJvbUZyYW1lKGZyYW1lOiBTc2VGcmFtZSk6IEV2ZW50RW52ZWxvcGUgfCBudWxsIHtcbiAgaWYgKGZyYW1lLmV2ZW50ICE9PSAnaG1oJykgcmV0dXJuIG51bGw7IC8vIFx1NjIxMVx1NEVFQ1x1NzY4NFx1NEU4Qlx1NEVGNlx1NEZFMVx1NUMwMVx1N0VERlx1NEUwMFx1OEQ3MCBldmVudDogaG1oXG4gIHRyeSB7XG4gICAgY29uc3QgcGFyc2VkOiB1bmtub3duID0gSlNPTi5wYXJzZShmcmFtZS5kYXRhKTtcbiAgICByZXR1cm4gaXNFdmVudEVudmVsb3BlKHBhcnNlZCkgPyBwYXJzZWQgOiBudWxsO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5leHBvcnQgY2xhc3MgRGVza3RvcEh0dHBFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IocHVibGljIHJlYWRvbmx5IGRldGFpbDogRGVza3RvcEVycm9yKSB7XG4gICAgc3VwZXIoZGV0YWlsLm1lc3NhZ2UpO1xuICB9XG59XG5cbmV4cG9ydCBjbGFzcyBEZXNrdG9wSG9zdENsaWVudCB7XG4gIGNvbnN0cnVjdG9yKFxuICAgIHByaXZhdGUgcmVhZG9ubHkgYmFzZVVybDogc3RyaW5nLFxuICAgIHByaXZhdGUgcmVhZG9ubHkgdG9rZW46IHN0cmluZyxcbiAgKSB7fVxuXG4gIHByaXZhdGUgaGVhZGVycyhleHRyYTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9KTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB7XG4gICAgcmV0dXJuIHsgJ3gtaG1oLWtleSc6IHRoaXMudG9rZW4sIC4uLmV4dHJhIH07XG4gIH1cblxuICBhc3luYyBnZXRKc29uPFQ+KHBhdGg6IHN0cmluZywgdGltZW91dE1zID0gNV8wMDApOiBQcm9taXNlPFQ+IHtcbiAgICBsZXQgcmVzOiBSZXNwb25zZTtcbiAgICB0cnkge1xuICAgICAgcmVzID0gYXdhaXQgZmV0Y2goYCR7dGhpcy5iYXNlVXJsfSR7cGF0aH1gLCB7IGhlYWRlcnM6IHRoaXMuaGVhZGVycygpLCBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQodGltZW91dE1zKSB9KTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgcmVxdWVzdCBmYWlsZWQ6ICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTYwKX1gLCB7IHJldHJ5YWJsZTogdHJ1ZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcbiAgICB9XG4gICAgcmV0dXJuIHRoaXMucGFyc2VSZXNwb25zZTxUPihyZXMpO1xuICB9XG5cbiAgLyoqIFx1NjJDOVx1NTNENlx1N0VBRlx1NjU4N1x1NjcyQ1x1N0FFRlx1NzBCOShcdTU5ODIgL2FwaS9zZXNzaW9ucy86aWQvZXhwb3J0Lm1kKVx1MzAwMiAqL1xuICBhc3luYyBnZXRUZXh0KHBhdGg6IHN0cmluZywgdGltZW91dE1zID0gMTBfMDAwKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgICBsZXQgcmVzOiBSZXNwb25zZTtcbiAgICB0cnkge1xuICAgICAgcmVzID0gYXdhaXQgZmV0Y2goYCR7dGhpcy5iYXNlVXJsfSR7cGF0aH1gLCB7IGhlYWRlcnM6IHRoaXMuaGVhZGVycygpLCBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQodGltZW91dE1zKSB9KTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgcmVxdWVzdCBmYWlsZWQ6ICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTYwKX1gLCB7IHJldHJ5YWJsZTogdHJ1ZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcbiAgICB9XG4gICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSB8fCByZXMuc3RhdHVzID09PSA0MDMpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignQVVUSF9GQUlMRUQnLCBgaG9zdCByZWplY3RlZCB0aGUgc2Vzc2lvbiB0b2tlbiAoSFRUUCAke3Jlcy5zdGF0dXN9KWAsIHsgcmV0cnlhYmxlOiBmYWxzZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcbiAgICB9XG4gICAgaWYgKCFyZXMub2spIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgSFRUUCAke3Jlcy5zdGF0dXN9YCwgeyByZXRyeWFibGU6IHJlcy5zdGF0dXMgPj0gNTAwIH0pKTtcbiAgICB9XG4gICAgcmV0dXJuIHJlcy50ZXh0KCk7XG4gIH1cblxuICAvKiogXHU2QkNGXHU0RTJBXHU1RTI2XHU1MjZGXHU0RjVDXHU3NTI4XHU3Njg0IFBPU1QgXHU4MUVBXHU1MkE4XHU2NDNBXHU1RTI2XHU1RTQyXHU3QjQ5XHU5NTJFKDAzIFx1MDBBN1x1NTZEQlx1OTYzMlx1OTFDRFx1NjUzRTpcdThCRjdcdTZDNDJcdTRGN0ZcdTc1MjggaWRlbXBvdGVuY3lLZXk7XG4gICAqICBydW50aW1lIFx1NEZBN1x1NzdFRFx1NjcxRlx1NTE3Q1x1NUJCOVx1NUZGRFx1NzU2NSxcdTUzNEZcdThCQUVcdTUxNDhcdTg4NENcdTIwMTRcdTIwMTRcdTkxQ0RcdThCRDVcdTUzRUZcdTUxRURcdTk1MkVcdTUzQkJcdTkxQ0QsXHU0RTBEXHU3NkYyXHU3NkVFXHU5MUNEXHU2NTNFKVx1MzAwMiAqL1xuICBhc3luYyBwb3N0SnNvbjxUPihwYXRoOiBzdHJpbmcsIGJvZHk6IHVua25vd24sIHRpbWVvdXRNcyA9IDEwXzAwMCk6IFByb21pc2U8VD4ge1xuICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgIHRyeSB7XG4gICAgICByZXMgPSBhd2FpdCBmZXRjaChgJHt0aGlzLmJhc2VVcmx9JHtwYXRofWAsIHtcbiAgICAgICAgbWV0aG9kOiAnUE9TVCcsXG4gICAgICAgIGhlYWRlcnM6IHRoaXMuaGVhZGVycyh7XG4gICAgICAgICAgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICAgICAgICAneC1pZGVtcG90ZW5jeS1rZXknOiByYW5kb21VVUlEKCksXG4gICAgICAgIH0pLFxuICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KSxcbiAgICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KHRpbWVvdXRNcyksXG4gICAgICB9KTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignSE9TVF9OT1RfUkVBRFknLCBgcmVxdWVzdCBmYWlsZWQ6ICR7U3RyaW5nKGVycikuc2xpY2UoMCwgMTYwKX1gLCB7IHJldHJ5YWJsZTogdHJ1ZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcbiAgICB9XG4gICAgcmV0dXJuIHRoaXMucGFyc2VSZXNwb25zZTxUPihyZXMpO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBwYXJzZVJlc3BvbnNlPFQ+KHJlczogUmVzcG9uc2UpOiBQcm9taXNlPFQ+IHtcbiAgICBpZiAocmVzLnN0YXR1cyA9PT0gNDAxIHx8IHJlcy5zdGF0dXMgPT09IDQwMykge1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdBVVRIX0ZBSUxFRCcsIGBob3N0IHJlamVjdGVkIHRoZSBzZXNzaW9uIHRva2VuIChIVFRQICR7cmVzLnN0YXR1c30pYCwgeyByZXRyeWFibGU6IGZhbHNlLCByZWNvdmVyeUFjdGlvbjogJ1JFQ09OTkVDVCcgfSkpO1xuICAgIH1cbiAgICBjb25zdCB0ZXh0ID0gYXdhaXQgcmVzLnRleHQoKTtcbiAgICBsZXQgcGFyc2VkOiB1bmtub3duID0gbnVsbDtcbiAgICB0cnkge1xuICAgICAgcGFyc2VkID0gdGV4dCA/IEpTT04ucGFyc2UodGV4dCkgOiBudWxsO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcGFyc2VkID0gbnVsbDtcbiAgICB9XG4gICAgaWYgKCFyZXMub2spIHtcbiAgICAgIGlmIChpc0Rlc2t0b3BFcnJvcihwYXJzZWQpKSB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihwYXJzZWQpO1xuICAgICAgdGhyb3cgbmV3IERlc2t0b3BIdHRwRXJyb3IoZGVza3RvcEVycm9yKCdIT1NUX05PVF9SRUFEWScsIGBIVFRQICR7cmVzLnN0YXR1c306ICR7dGV4dC5zbGljZSgwLCAxNjApfWAsIHsgcmV0cnlhYmxlOiByZXMuc3RhdHVzID49IDUwMCB9KSk7XG4gICAgfVxuICAgIHJldHVybiBwYXJzZWQgYXMgVDtcbiAgfVxuXG4gIC8qKlxuICAgKiBcdThCQTJcdTk2MDVcdTUxNjhcdTkwRTggU1NFIFx1NUUyNyhcdTU0MkJcdTk3NUVcdTRGRTFcdTVDMDFcdTRFOEJcdTRFRjY6ZGVsdGEvbGluZSBcdTdCNDlcdTlBRDhcdTk4OTFcdTZENDEpXHUzMDAyXHU0RkUxXHU1QzAxXHU3NTMxXHU4QzAzXHU3NTI4XHU2NUI5XG4gICAqIFx1NzUyOCBlbnZlbG9wZUZyb21GcmFtZSBcdTgxRUFcdTg4NENcdTUyMDZcdTZENDE7XHU2NUFEXHU3RUJGXHU5MUNEXHU4RkRFXHU4QkVEXHU0RTQ5XHU1NDBDIGV2ZW50cygpXHUzMDAyXG4gICAqL1xuICBhc3luYyAqcmF3RXZlbnRzKGxhc3RFdmVudElkPzogc3RyaW5nLCBzaWduYWw/OiBBYm9ydFNpZ25hbCk6IEFzeW5jR2VuZXJhdG9yPFNzZUZyYW1lPiB7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYCR7dGhpcy5iYXNlVXJsfS9hcGkvZXZlbnRzYCwge1xuICAgICAgaGVhZGVyczogdGhpcy5oZWFkZXJzKHtcbiAgICAgICAgYWNjZXB0OiAndGV4dC9ldmVudC1zdHJlYW0nLFxuICAgICAgICAuLi4obGFzdEV2ZW50SWQgIT09IHVuZGVmaW5lZCA/IHsgJ2xhc3QtZXZlbnQtaWQnOiBsYXN0RXZlbnRJZCB9IDoge30pLFxuICAgICAgfSksXG4gICAgICAuLi4oc2lnbmFsICE9PSB1bmRlZmluZWQgPyB7IHNpZ25hbCB9IDoge30pLFxuICAgIH0pO1xuICAgIGlmIChyZXMuc3RhdHVzID09PSA0MDEgfHwgcmVzLnN0YXR1cyA9PT0gNDAzKSB7XG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgYGhvc3QgcmVqZWN0ZWQgdGhlIHNlc3Npb24gdG9rZW4gKEhUVFAgJHtyZXMuc3RhdHVzfSlgLCB7IHJldHJ5YWJsZTogZmFsc2UsIHJlY292ZXJ5QWN0aW9uOiAnUkVDT05ORUNUJyB9KSk7XG4gICAgfVxuICAgIGlmICghcmVzLm9rIHx8IHJlcy5ib2R5ID09PSBudWxsKSB7XG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYFNTRSBIVFRQICR7cmVzLnN0YXR1c31gLCB7IHJldHJ5YWJsZTogdHJ1ZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcbiAgICB9XG4gICAgY29uc3QgcmVhZGVyID0gcmVzLmJvZHkuZ2V0UmVhZGVyKCk7XG4gICAgY29uc3QgZGVjb2RlciA9IG5ldyBUZXh0RGVjb2RlcigpO1xuICAgIGxldCBidWZmZXIgPSAnJztcbiAgICBmb3IgKDs7KSB7XG4gICAgICBjb25zdCB7IGRvbmUsIHZhbHVlIH0gPSBhd2FpdCByZWFkZXIucmVhZCgpO1xuICAgICAgaWYgKGRvbmUpIHJldHVybjtcbiAgICAgIGJ1ZmZlciArPSBkZWNvZGVyLmRlY29kZSh2YWx1ZSwgeyBzdHJlYW06IHRydWUgfSk7XG4gICAgICBsZXQgaWR4OiBudW1iZXI7XG4gICAgICB3aGlsZSAoKGlkeCA9IGJ1ZmZlci5pbmRleE9mKCdcXG5cXG4nKSkgIT09IC0xKSB7XG4gICAgICAgIGNvbnN0IGJsb2NrID0gYnVmZmVyLnNsaWNlKDAsIGlkeCk7XG4gICAgICAgIGJ1ZmZlciA9IGJ1ZmZlci5zbGljZShpZHggKyAyKTtcbiAgICAgICAgZm9yIChjb25zdCBmcmFtZSBvZiBwYXJzZVNzZUNodW5rKGJsb2NrKSkgeWllbGQgZnJhbWU7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFx1OEJBMlx1OTYwNSBTU0UgXHU0RThCXHU0RUY2XHU2RDQxKGFzeW5jIGl0ZXJhdG9yKVx1MzAwMlx1NjVBRFx1N0VCRlx1NzUzMVx1OEMwM1x1NzUyOFx1NjVCOVx1OTFDRFx1OEZERTtcdTkxQ0RcdThGREVcdTY1RjZcdTYyOEFcdTY3MDBcdTU0MEVcbiAgICogXHU2NTM2XHU1MjMwXHU3Njg0IGV2ZW50SWQgXHU0RjIwXHU1MTY1IGxhc3RFdmVudElkLGhvc3QgXHU3QUVGXHU0RUNFXHU5MUNEXHU2NTNFXHU3M0FGXHU4ODY1XHU1M0QxXHUzMDAyXG4gICAqL1xuICBhc3luYyAqZXZlbnRzKGxhc3RFdmVudElkPzogc3RyaW5nLCBzaWduYWw/OiBBYm9ydFNpZ25hbCk6IEFzeW5jR2VuZXJhdG9yPEV2ZW50RW52ZWxvcGU+IHtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgJHt0aGlzLmJhc2VVcmx9L2FwaS9ldmVudHNgLCB7XG4gICAgICBoZWFkZXJzOiB0aGlzLmhlYWRlcnMoe1xuICAgICAgICBhY2NlcHQ6ICd0ZXh0L2V2ZW50LXN0cmVhbScsXG4gICAgICAgIC4uLihsYXN0RXZlbnRJZCAhPT0gdW5kZWZpbmVkID8geyAnbGFzdC1ldmVudC1pZCc6IGxhc3RFdmVudElkIH0gOiB7fSksXG4gICAgICB9KSxcbiAgICAgIC4uLihzaWduYWwgIT09IHVuZGVmaW5lZCA/IHsgc2lnbmFsIH0gOiB7fSksXG4gICAgfSk7XG4gICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwMSB8fCByZXMuc3RhdHVzID09PSA0MDMpIHtcbiAgICAgIHRocm93IG5ldyBEZXNrdG9wSHR0cEVycm9yKGRlc2t0b3BFcnJvcignQVVUSF9GQUlMRUQnLCBgaG9zdCByZWplY3RlZCB0aGUgc2Vzc2lvbiB0b2tlbiAoSFRUUCAke3Jlcy5zdGF0dXN9KWAsIHsgcmV0cnlhYmxlOiBmYWxzZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcbiAgICB9XG4gICAgaWYgKCFyZXMub2sgfHwgIXJlcy5ib2R5KSB7XG4gICAgICB0aHJvdyBuZXcgRGVza3RvcEh0dHBFcnJvcihkZXNrdG9wRXJyb3IoJ0hPU1RfTk9UX1JFQURZJywgYFNTRSBIVFRQICR7cmVzLnN0YXR1c31gLCB7IHJldHJ5YWJsZTogdHJ1ZSwgcmVjb3ZlcnlBY3Rpb246ICdSRUNPTk5FQ1QnIH0pKTtcbiAgICB9XG4gICAgY29uc3QgcmVhZGVyID0gcmVzLmJvZHkuZ2V0UmVhZGVyKCk7XG4gICAgY29uc3QgZGVjb2RlciA9IG5ldyBUZXh0RGVjb2RlcigpO1xuICAgIGxldCBidWZmZXIgPSAnJztcbiAgICBmb3IgKDs7KSB7XG4gICAgICBjb25zdCB7IGRvbmUsIHZhbHVlIH0gPSBhd2FpdCByZWFkZXIucmVhZCgpO1xuICAgICAgaWYgKGRvbmUpIHJldHVybjtcbiAgICAgIGJ1ZmZlciArPSBkZWNvZGVyLmRlY29kZSh2YWx1ZSwgeyBzdHJlYW06IHRydWUgfSk7XG4gICAgICAvLyBcdTRFRTVcdTdBN0FcdTg4NENcdTUyMDZcdTVFMjc7XHU0RkREXHU3NTU5XHU0RTBEXHU1QjhDXHU2NTc0XHU3Njg0XHU1QzNFXHU5MEU4XG4gICAgICBsZXQgaWR4OiBudW1iZXI7XG4gICAgICB3aGlsZSAoKGlkeCA9IGJ1ZmZlci5pbmRleE9mKCdcXG5cXG4nKSkgIT09IC0xKSB7XG4gICAgICAgIGNvbnN0IGJsb2NrID0gYnVmZmVyLnNsaWNlKDAsIGlkeCk7XG4gICAgICAgIGJ1ZmZlciA9IGJ1ZmZlci5zbGljZShpZHggKyAyKTtcbiAgICAgICAgZm9yIChjb25zdCBmcmFtZSBvZiBwYXJzZVNzZUNodW5rKGJsb2NrKSkge1xuICAgICAgICAgIGNvbnN0IGVudiA9IGVudmVsb3BlRnJvbUZyYW1lKGZyYW1lKTtcbiAgICAgICAgICBpZiAoZW52ICE9PSBudWxsKSB5aWVsZCBlbnY7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH1cbn1cbiIsICIvKipcbiAqIGZha2UgaG9zdCBcdTIwMTQgaG1oYXJuZXNzIHJ1bnRpbWUgXHU3Njg0XHU2RDRCXHU4QkQ1XHU2NkZGXHU4RUFCKE1hc3RlclByb21wdCBcdTk2MzZcdTZCQjUgRC9FOlxuICogXCJcdTUxNDhcdTRGN0ZcdTc1MjggZmFrZSBob3N0IFx1N0YxNlx1NTE5OVx1NzJCNlx1NjAwMVx1NjczQVx1NkQ0Qlx1OEJENSxcdTUxOERcdTYzQTVcdTc3MUZcdTVCOUUgQVBJXCI7XHU5NjM2XHU2QkI1IEUgXHU3Njg0XHU0RjFBXHU4QkREXHU3RUI1XHU1MjA3XHU3MjQ3XG4gKiBlMmUgXHU0RTVGXHU1MTQ4XHU1NzI4IGZha2UgXHU1QzQyXHU5NUVEXHU3M0FGKVx1MzAwMlxuICpcbiAqIFx1Njg0Q1x1OTc2MiBob3N0IFx1NTQwOFx1NTQwQzpcbiAqICAtIFx1NTNFQVx1N0VEMSAxMjcuMC4wLjEsXHU3QUVGXHU1M0UzIE9TIFx1NTIwNlx1OTE0RCxcdTVCOUVcdTk2NDVcdTdBRUZcdTUzRTNcdTUxOTkgc3Rkb3V0IFx1NUYxNVx1NUJGQ1x1ODg0QztcbiAqICAtIFx1NjI0MFx1NjcwOSAvYXBpLyogXHU4OTgxXHU2QzQyIFgtSG1oLUtleSA9PT0gSE1IX0RFU0tUT1BfVE9LRU4sXHU1NDI2XHU1MjE5IDQwMSArIERlc2t0b3BFcnJvcjtcbiAqICAtIEdFVCAvYXBpL3N0YXRlIFx1NTA2NVx1NUVCN1x1NjNBMlx1NkQ0QjtHRVQgL2FwaS9ldmVudHMgU1NFKGV2ZW50OiBobWggXHU0RkUxXHU1QzAxXHU2RDQxICsgXHU5MUNEXHU2NTNFXHU3M0FGKTtcbiAqICAtIFBPU1QgL2FwaS9kZXNrdG9wL3NodXRkb3duIFx1NEYxOFx1OTZDNVx1OTAwMFx1NTFGQVx1MzAwMlxuICpcbiAqIFx1OTYzNlx1NkJCNSBFIFx1NkEyMVx1NjJERlx1OTc2MihcdTRFMEUgaG1oYXJuZXNzIGRlc2t0b3AgXHU2QTIxXHU1RjBGXHU1NDBDXHU1RjYyKTpcbiAqICAtIFBPU1QgL2FwaS90YXNrIHt0ZXh0LCBzZXNzaW9uSWQsIG1vZGV9Olx1NjM5Mlx1OTYxRlx1NUU3Nlx1NjMwOVx1ODExQVx1NjcyQ1x1NTNEMVxuICogICAgcnVuLnN0YXJ0ZWQgXHUyMTkyIHRvb2wuc3RhcnRlZC9jb21wbGV0ZWQgXHUyMTkyKG1vZGU9PT0nYXNrJyBcdTY1RjYpXG4gKiAgICBhcHByb3ZhbC5yZXF1aXJlZChcdTdCNDkgL2FwaS9hcHByb3ZlKVx1MjE5MiBydW4uY29tcGxldGVkO1xuICogIC0gUE9TVCAvYXBpL2FwcHJvdmUge2dyYW50ZWQsIHNlc3Npb25JZH07XG4gKiAgLSBQT1NUIC9hcGkvaW50ZXJydXB0IHtzZXNzaW9uSWR9O1xuICogIC0gR0VUIC9hcGkvc2Vzc2lvbnNcdTMwMDJcbiAqXG4gKiBcdTZENEJcdThCRDVcdTk0QTlcdTVCNTA6RkFLRV9IT1NUX0RJRV9BRlRFUl9NUyAvIEZBS0VfSE9TVF9ESUVfQVRfQk9PVCAvXG4gKiBGQUtFX0hPU1RfRVhQRUNUX1RPS0VOIC8gRkFLRV9IT1NUX1RBU0tfREVMQVlfTVMgLyBGQUtFX0hPU1RfVEFTS19GQUlMPTFcbiAqIChcdTRFRkJcdTUyQTFcdTRFRTUgcnVuLmZhaWxlZCBcdTdFRDNcdTY3NUYsXHU2Nzg0XHU5MDIwXHU5NTE5XHU4QkVGXHU2MDYyXHU1OTBEXHU1NzNBXHU2NjZGKVx1MzAwMlxuICovXG5pbXBvcnQgeyBjcmVhdGVTZXJ2ZXIsIHR5cGUgU2VydmVyUmVzcG9uc2UgfSBmcm9tICdub2RlOmh0dHAnO1xuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gJ25vZGU6Y3J5cHRvJztcbmltcG9ydCB7IHBhdGhUb0ZpbGVVUkwgfSBmcm9tICdub2RlOnVybCc7XG5pbXBvcnQgeyByZWFscGF0aFN5bmMgfSBmcm9tICdub2RlOmZzJztcbmltcG9ydCB7IEVWRU5UX1NDSEVNQV9WRVJTSU9OLCBkZXNrdG9wRXJyb3IsIHR5cGUgRXZlbnRFbnZlbG9wZSwgdHlwZSBFdmVudEtpbmQgfSBmcm9tICdAaG1oLWRlc2t0b3AvY29udHJhY3RzJztcblxuZXhwb3J0IGludGVyZmFjZSBGYWtlSG9zdEhhbmRsZSB7XG4gIHBvcnQ6IG51bWJlcjtcbiAgZW1pdChzZXNzaW9uSWQ6IHN0cmluZywgcnVuSWQ6IHN0cmluZywga2luZDogRXZlbnRLaW5kLCBwYXlsb2FkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IG51bWJlcjtcbiAgY2xvc2UoKTogUHJvbWlzZTx2b2lkPjtcbn1cblxuaW50ZXJmYWNlIEZha2VTZXNzaW9uIHtcbiAgaWQ6IHN0cmluZztcbiAgY3JlYXRlZEF0OiBzdHJpbmc7XG4gIHVwZGF0ZWRBdDogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgUGVuZGluZ0FwcHJvdmFsIHtcbiAgc2Vzc2lvbklkOiBzdHJpbmc7XG4gIGFwcHJvdmFsSWQ6IHN0cmluZztcbiAgcmVzb2x2ZShncmFudGVkOiBib29sZWFuKTogdm9pZDtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHN0YXJ0RmFrZUhvc3Qob3B0czogeyB0b2tlbjogc3RyaW5nOyBxdWlldD86IGJvb2xlYW4gfSk6IFByb21pc2U8RmFrZUhvc3RIYW5kbGU+IHtcbiAgY29uc3QgdG9rZW4gPSBvcHRzLnRva2VuO1xuICAvLyBcdTZENEJcdThCRDVcdTk0QTlcdTVCNTA6RkFLRV9IT1NUX0VYUEVDVF9UT0tFTiBcdThCQTkgaG9zdCBcdTY4MjFcdTlBOENcdTRFMDBcdTRFMkFcdTRFMEUgSE1IX0RFU0tUT1BfVE9LRU5cbiAgLy8gXHU0RTBEXHU1NDBDXHU3Njg0XHU1MDNDKFx1Njc4NFx1OTAyMCBBVVRIX0ZBSUxFRCBcdTU3M0FcdTY2NkY7c3VwZXJ2aXNvciBcdTYwM0JcdTY2MkZcdTg5ODZcdTc2RDYgSE1IX0RFU0tUT1BfVE9LRU4pXG4gIGNvbnN0IGV4cGVjdGVkID0gcHJvY2Vzcy5lbnYuRkFLRV9IT1NUX0VYUEVDVF9UT0tFTiA/PyB0b2tlbjtcbiAgY29uc3QgdGFza0RlbGF5ID0gTnVtYmVyKHByb2Nlc3MuZW52LkZBS0VfSE9TVF9UQVNLX0RFTEFZX01TID8/IDMwKTtcbiAgY29uc3QgZmFpbFRhc2tzID0gcHJvY2Vzcy5lbnYuRkFLRV9IT1NUX1RBU0tfRkFJTCA9PT0gJzEnO1xuXG4gIGNvbnN0IHNzZUNsaWVudHMgPSBuZXcgU2V0PFNlcnZlclJlc3BvbnNlPigpO1xuICBjb25zdCBzZXFCeVJ1biA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG4gIC8vIFx1OTFDRFx1NjUzRVx1NzNBRjpcdTY3MDBcdThGRDEgMjAwIFx1NUUyNyhMYXN0LUV2ZW50LUlEIFx1NjVBRFx1N0VCRlx1ODg2NVx1NjJDOSksXHU0RTBFIGhtaGFybmVzcyB3ZWIgXHU1NDBDXHU2QjNFXHU4QkVEXHU0RTQ5XG4gIGNvbnN0IHJpbmc6IEFycmF5PHsgaWQ6IG51bWJlcjsgZXZlbnQ6IHN0cmluZzsgZGF0YTogdW5rbm93biB9PiA9IFtdO1xuICBsZXQgcmluZ1NlcSA9IDA7XG4gIGNvbnN0IHNlc3Npb25zID0gbmV3IE1hcDxzdHJpbmcsIEZha2VTZXNzaW9uPigpO1xuICBsZXQgcGVuZGluZzogUGVuZGluZ0FwcHJvdmFsIHwgbnVsbCA9IG51bGw7XG4gIGNvbnN0IHJ1blRpbWVycyA9IG5ldyBNYXA8c3RyaW5nLCBOb2RlSlMuVGltZW91dD4oKTtcbiAgLy8gXHU1REU1XHU0RjVDXHU1MzNBL1Byb3ZpZGVyIFx1NzJCNlx1NjAwMShcdTRFMEUgaG1oYXJuZXNzIFx1NTQwQ1x1NUY2Mlx1NzY4NFx1NjcwMFx1NUMwRlx1NkEyMVx1NjJERilcbiAgY29uc3QgZmFrZVdvcmtzcGFjZXMgPSB7XG4gICAgY3VycmVudDogJ3dzLWRlbW8nLFxuICAgIGl0ZW1zOiBbXG4gICAgICB7IGlkOiAnd3MtZGVtbycsIG5hbWU6ICdkZW1vLXdvcmtzcGFjZScsIHBhdGg6ICdDOlxcXFxkZW1vJyB9LFxuICAgIF0sXG4gIH07XG4gIGNvbnN0IGZha2VQcm92aWRlcnMgPSBuZXcgTWFwPHN0cmluZywgeyBiYXNlVXJsOiBzdHJpbmc7IG1vZGVsOiBzdHJpbmc7IGFwaUtleTogc3RyaW5nIH0+KFtcbiAgICBbJ2RlbW8nLCB7IGJhc2VVcmw6ICdodHRwOi8vMTI3LjAuMC4xOjkvdjEnLCBtb2RlbDogJ2Zha2UtbScsIGFwaUtleTogJ3NrLWRlbW8tMTIzNCcgfV0sXG4gIF0pO1xuXG4gIGNvbnN0IGVtaXQgPSAoc2Vzc2lvbklkOiBzdHJpbmcsIHJ1bklkOiBzdHJpbmcsIGtpbmQ6IEV2ZW50S2luZCwgcGF5bG9hZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBudW1iZXIgPT4ge1xuICAgIGNvbnN0IGtleSA9IGAke3Nlc3Npb25JZH1cXDAke3J1bklkfWA7XG4gICAgY29uc3Qgc2VxID0gKHNlcUJ5UnVuLmdldChrZXkpID8/IDApICsgMTtcbiAgICBzZXFCeVJ1bi5zZXQoa2V5LCBzZXEpO1xuICAgIGNvbnN0IGVudjogRXZlbnRFbnZlbG9wZSA9IHtcbiAgICAgIHNjaGVtYVZlcnNpb246IEVWRU5UX1NDSEVNQV9WRVJTSU9OLFxuICAgICAgZXZlbnRJZDogcmFuZG9tVVVJRCgpLFxuICAgICAgc2Vzc2lvbklkLFxuICAgICAgcnVuSWQsXG4gICAgICBzZXEsXG4gICAgICBvY2N1cnJlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICBraW5kLFxuICAgICAgcGF5bG9hZCxcbiAgICB9O1xuICAgIGNvbnN0IGlkID0gKytyaW5nU2VxO1xuICAgIHJpbmcucHVzaCh7IGlkLCBldmVudDogJ2htaCcsIGRhdGE6IGVudiB9KTtcbiAgICBpZiAocmluZy5sZW5ndGggPiAyMDApIHJpbmcuc3BsaWNlKDAsIHJpbmcubGVuZ3RoIC0gMjAwKTtcbiAgICBmb3IgKGNvbnN0IGMgb2Ygc3NlQ2xpZW50cykge1xuICAgICAgYy53cml0ZShgaWQ6ICR7aWR9XFxuZXZlbnQ6IGhtaFxcbmRhdGE6ICR7SlNPTi5zdHJpbmdpZnkoZW52KX1cXG5cXG5gKTtcbiAgICB9XG4gICAgcmV0dXJuIHNlcTtcbiAgfTtcblxuICBjb25zdCB0b3VjaCA9IChzZXNzaW9uSWQ6IHN0cmluZyk6IEZha2VTZXNzaW9uID0+IHtcbiAgICBsZXQgcyA9IHNlc3Npb25zLmdldChzZXNzaW9uSWQpO1xuICAgIGlmIChzID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHMgPSB7IGlkOiBzZXNzaW9uSWQsIGNyZWF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLCB1cGRhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSB9O1xuICAgICAgc2Vzc2lvbnMuc2V0KHNlc3Npb25JZCwgcyk7XG4gICAgfVxuICAgIHMudXBkYXRlZEF0ID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuICAgIHJldHVybiBzO1xuICB9O1xuXG4gIC8qKiBcdTZBMjFcdTYyREZcdTRFMDBcdTZCMjFcdTRFRkJcdTUyQTE6XHU2Mjc5XHU1MUM2XHU2QTIxXHU1RjBGXHU2MzAyXHU4RDc3XHU3QjQ5XHU1Rjg1IC9hcGkvYXBwcm92ZVx1MzAwMiAqL1xuICBjb25zdCBydW5UYXNrID0gKHNlc3Npb25JZDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcsIG1vZGU6IHN0cmluZyk6IHN0cmluZyA9PiB7XG4gICAgY29uc3QgcnVuSWQgPSBgcnVuLSR7RGF0ZS5ub3coKS50b1N0cmluZygzNil9LSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMiwgOCl9YDtcbiAgICB0b3VjaChzZXNzaW9uSWQpO1xuICAgIGNvbnN0IHN0ZXBzOiBBcnJheTwoKSA9PiB2b2lkPiA9IFtdO1xuICAgIGNvbnN0IHdhaXQgPSAoZm46ICgpID0+IHZvaWQsIG1zID0gdGFza0RlbGF5KTogdm9pZCA9PiB7XG4gICAgICBjb25zdCB0ID0gc2V0VGltZW91dChmbiwgbXMpO1xuICAgICAgcnVuVGltZXJzLnNldChgJHtzZXNzaW9uSWR9XFwwJHtydW5JZH1gLCB0KTtcbiAgICB9O1xuICAgIGNvbnN0IGNoYWluID0gKGZuczogQXJyYXk8KCkgPT4gdm9pZD4pOiB2b2lkID0+IHtcbiAgICAgIGNvbnN0IFtmaXJzdCwgLi4ucmVzdF0gPSBmbnM7XG4gICAgICBpZiAoZmlyc3QgPT09IHVuZGVmaW5lZCkgcmV0dXJuO1xuICAgICAgd2FpdCgoKSA9PiB7XG4gICAgICAgIGZpcnN0KCk7XG4gICAgICAgIGNoYWluKHJlc3QpO1xuICAgICAgfSk7XG4gICAgfTtcblxuICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ3J1bi5zdGFydGVkJywgeyB0YXNrOiB0ZXh0LCBtb2RlIH0pO1xuICAgIGlmIChmYWlsVGFza3MpIHtcbiAgICAgIHdhaXQoKCkgPT4gZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAncnVuLmZhaWxlZCcsIHtcbiAgICAgICAgZXJyb3I6IHsgY29kZTogJ0FVVEhfRkFJTEVEJywgbWVzc2FnZTogJ3NpbXVsYXRlZCBwcm92aWRlciBhdXRoIGZhaWx1cmUnLCByZXRyeWFibGU6IGZhbHNlIH0sXG4gICAgICB9KSk7XG4gICAgICByZXR1cm4gcnVuSWQ7XG4gICAgfVxuXG4gICAgY29uc3QgZmluaXNoUnVuID0gKGFuc3dlcjogc3RyaW5nLCB0b29sVXNlczogbnVtYmVyKTogdm9pZCA9PiB7XG4gICAgICBydW5UaW1lcnMuZGVsZXRlKGAke3Nlc3Npb25JZH1cXDAke3J1bklkfWApO1xuICAgICAgLy8gXHU0RUE0XHU0RUQ4XHU3MjY5XHU1MTQ4XHU0RThFXHU3RUM4XHU2MDAxKFx1NEUwRSBobWhhcm5lc3MgZGVza3RvcCBcdTY4NjVcdTU0MENcdTVFOEY6YXJ0aWZhY3QuY3JlYXRlZCBcdTIxOTIgcnVuLmNvbXBsZXRlZClcbiAgICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ2FydGlmYWN0LmNyZWF0ZWQnLCB7XG4gICAgICAgIGFydGlmYWN0OiB7IHJlbFBhdGg6ICdvdXQudHh0Jywga2luZDogJ2ZpbGUnLCB0aXRsZTogJ291dC50eHQnIH0sXG4gICAgICB9KTtcbiAgICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ3J1bi5jb21wbGV0ZWQnLCB7IHRleHQ6IGFuc3dlciwgdHVybnM6IDEsIHRvb2xVc2VzIH0pO1xuICAgIH07XG5cbiAgICBjb25zdCBzY3JpcHRlZDogQXJyYXk8KCkgPT4gdm9pZD4gPSBbXG4gICAgICAoKSA9PiBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICd0b29sLnN0YXJ0ZWQnLCB7IG5hbWU6ICdyZWFkX2ZpbGUnLCBhcmdzUHJldmlldzogJ3tcInBhdGhcIjpcIlJFQURNRS5tZFwifScgfSksXG4gICAgICAoKSA9PiBlbWl0KHNlc3Npb25JZCwgcnVuSWQsICd0b29sLmNvbXBsZXRlZCcsIHsgbmFtZTogJ3JlYWRfZmlsZScsIGlzRXJyb3I6IGZhbHNlLCBvdXRwdXRQcmV2aWV3OiAnIyBkZW1vJyB9KSxcbiAgICBdO1xuXG4gICAgaWYgKG1vZGUgPT09ICdhc2snKSB7XG4gICAgICBzY3JpcHRlZC5wdXNoKCgpID0+IHtcbiAgICAgICAgY29uc3QgYXBwcm92YWxJZCA9IGBhcC0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsIDgpfWA7XG4gICAgICAgIGVtaXQoc2Vzc2lvbklkLCBydW5JZCwgJ2FwcHJvdmFsLnJlcXVpcmVkJywge1xuICAgICAgICAgIGFwcHJvdmFsSWQsXG4gICAgICAgICAgdG9vbDogJ3dyaXRlX2ZpbGUnLFxuICAgICAgICAgIGFyZ3NQcmV2aWV3OiAne1wicGF0aFwiOlwib3V0LnR4dFwiLFwiY29udGVudFwiOlwiaGlcIn0nLFxuICAgICAgICAgIHJpc2s6ICdcdTUxOTlcdTUxNjVcdTVERTVcdTRGNUNcdTUzM0FcdTY1ODdcdTRFRjYgb3V0LnR4dChcdTZBMjFcdTYyREYpJyxcbiAgICAgICAgfSk7XG4gICAgICAgIHBlbmRpbmcgPSB7XG4gICAgICAgICAgc2Vzc2lvbklkLFxuICAgICAgICAgIGFwcHJvdmFsSWQsXG4gICAgICAgICAgcmVzb2x2ZTogKGdyYW50ZWQpID0+IHtcbiAgICAgICAgICAgIHBlbmRpbmcgPSBudWxsO1xuICAgICAgICAgICAgaWYgKGdyYW50ZWQpIHtcbiAgICAgICAgICAgICAgZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAndG9vbC5zdGFydGVkJywgeyBuYW1lOiAnd3JpdGVfZmlsZScsIGFyZ3NQcmV2aWV3OiAne1wicGF0aFwiOlwib3V0LnR4dFwifScgfSk7XG4gICAgICAgICAgICAgIHdhaXQoKCkgPT4gZW1pdChzZXNzaW9uSWQsIHJ1bklkLCAndG9vbC5jb21wbGV0ZWQnLCB7IG5hbWU6ICd3cml0ZV9maWxlJywgaXNFcnJvcjogZmFsc2UsIG91dHB1dFByZXZpZXc6ICd3cm90ZSAyIGJ5dGVzJyB9KSk7XG4gICAgICAgICAgICAgIHdhaXQoKCkgPT4gZmluaXNoUnVuKGBlY2hvOiAke3RleHR9KFx1NURGMlx1NjI2N1x1ODg0Q1x1NTE5OVx1NTE2NSlgLCAzKSwgdGFza0RlbGF5ICogMik7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICBmaW5pc2hSdW4oYGVjaG86ICR7dGV4dH0oXHU1QkExXHU2Mjc5XHU4OEFCXHU2MkQyXHU3RURELFx1NjcyQVx1NjI2N1x1ODg0Q1x1NTE5OVx1NTE2NSlgLCAxKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9LFxuICAgICAgICB9O1xuICAgICAgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHNjcmlwdGVkLnB1c2goKCkgPT4gZmluaXNoUnVuKGBlY2hvOiAke3RleHR9YCwgMSkpO1xuICAgIH1cbiAgICBjaGFpbihzY3JpcHRlZCk7XG4gICAgcmV0dXJuIHJ1bklkO1xuICB9O1xuXG4gIGNvbnN0IHNlcnZlciA9IGNyZWF0ZVNlcnZlcigocmVxLCByZXMpID0+IHtcbiAgICBjb25zdCB1cmwgPSBuZXcgVVJMKHJlcS51cmwgPz8gJy8nLCAnaHR0cDovLzEyNy4wLjAuMScpO1xuICAgIGNvbnN0IGF1dGhvcml6ZWQgPSByZXEuaGVhZGVyc1sneC1obWgta2V5J10gPT09IGV4cGVjdGVkO1xuICAgIGNvbnN0IGRlbnkgPSAoKTogdm9pZCA9PiB7XG4gICAgICByZXMud3JpdGVIZWFkKDQwMSwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ0FVVEhfRkFJTEVEJywgJ21pc3Npbmcgb3IgaW52YWxpZCB4LWhtaC1rZXknLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICB9O1xuXG4gICAgY29uc3QgcmVhZEJvZHkgPSAoKTogUHJvbWlzZTxzdHJpbmc+ID0+XG4gICAgICBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xuICAgICAgICBsZXQgYiA9ICcnO1xuICAgICAgICByZXEub24oJ2RhdGEnLCAoYzogQnVmZmVyKSA9PiB7IGIgKz0gYy50b1N0cmluZygpOyB9KTtcbiAgICAgICAgcmVxLm9uKCdlbmQnLCAoKSA9PiByZXNvbHZlKGIpKTtcbiAgICAgIH0pO1xuXG4gICAgaWYgKHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZXZlbnRzJykge1xuICAgICAgaWYgKCFhdXRob3JpemVkKSB7IGRlbnkoKTsgcmV0dXJuOyB9XG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ3RleHQvZXZlbnQtc3RyZWFtJywgJ2NhY2hlLWNvbnRyb2wnOiAnbm8tY2FjaGUnLCBjb25uZWN0aW9uOiAna2VlcC1hbGl2ZScgfSk7XG4gICAgICByZXMuZmx1c2hIZWFkZXJzPy4oKTtcbiAgICAgIHNzZUNsaWVudHMuYWRkKHJlcyk7XG4gICAgICAvLyBcdTY1QURcdTdFQkZcdTg4NjVcdTYyQzk6TGFzdC1FdmVudC1JRCBcdTRFNEJcdTUyNERcdTc2ODRcdTVFMjdcdTVERjJcdTU3MjhcdTVCQTJcdTYyMzdcdTdBRUYsXHU5MUNEXHU1M0QxXHU1MTc2XHU1NDBFXHU3Njg0XHU3M0FGXHU1RjYyXHU3RjEzXHU1MUIyXG4gICAgICBjb25zdCBsYXN0SWQgPSBOdW1iZXIocmVxLmhlYWRlcnNbJ2xhc3QtZXZlbnQtaWQnXSA/PyAwKTtcbiAgICAgIGlmIChOdW1iZXIuaXNGaW5pdGUobGFzdElkKSAmJiBsYXN0SWQgPiAwKSB7XG4gICAgICAgIGZvciAoY29uc3QgZSBvZiByaW5nKSB7XG4gICAgICAgICAgaWYgKGUuaWQgPiBsYXN0SWQpIHJlcy53cml0ZShgaWQ6ICR7ZS5pZH1cXG5ldmVudDogJHtlLmV2ZW50fVxcbmRhdGE6ICR7SlNPTi5zdHJpbmdpZnkoZS5kYXRhKX1cXG5cXG5gKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmVxLm9uKCdjbG9zZScsICgpID0+IHNzZUNsaWVudHMuZGVsZXRlKHJlcykpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAoIWF1dGhvcml6ZWQpIHsgZGVueSgpOyByZXR1cm47IH1cblxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3N0YXRlJykge1xuICAgICAgLy8gcHJvdmlkZXJzRGV0YWlsOlx1NEUwRSBobWhhcm5lc3MgXHU1NDBDXHU1RjYyXHUyMDE0XHUyMDE0a2V5IFx1NTNFQVx1NTFGQSBoYXNLZXkvXHU2NzJCXHU1NkRCXHU0RjRELFx1NkMzOFx1NEUwRFx1NjYwRVx1NjU4N1xuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBkYWVtb25WZXJzaW9uOiAnZmFrZS0wLjAuMCcsIGRlc2t0b3A6IHRydWUsIG1vZGVsOiAnZmFrZS1tb2RlbCcsIGxvY2FsZTogJ3poJyxcbiAgICAgICAgYnVzeVNlc3Npb25zOiBbLi4uc2Vzc2lvbnMua2V5cygpXS5zbGljZSgwLCAyKSxcbiAgICAgICAgYXBwcm92YWxQZW5kaW5nOiBwZW5kaW5nICE9PSBudWxsLFxuICAgICAgICBzZXR0aW5nczogeyBhcHByb3ZhbDogJ2FzaycgfSxcbiAgICAgICAgd29ya3NwYWNlOiBmYWtlV29ya3NwYWNlcy5pdGVtcy5maW5kKCh3KSA9PiB3LmlkID09PSBmYWtlV29ya3NwYWNlcy5jdXJyZW50KSA/PyBudWxsLFxuICAgICAgICBwcm92aWRlcnNEZXRhaWw6IFsuLi5mYWtlUHJvdmlkZXJzLmVudHJpZXMoKV0ubWFwKChbbmFtZSwgcF0pID0+ICh7XG4gICAgICAgICAgbmFtZSwgbW9kZWw6IHAubW9kZWwsIGJhc2VVcmw6IHAuYmFzZVVybCxcbiAgICAgICAgICBoYXNLZXk6IHAuYXBpS2V5ICE9PSAnJyxcbiAgICAgICAgICBrZXlUYWlsOiBwLmFwaUtleS5sZW5ndGggPj0gNCA/IHAuYXBpS2V5LnNsaWNlKC00KSA6IHVuZGVmaW5lZCxcbiAgICAgICAgICBwdXJwb3NlczogWydjaGF0J10sXG4gICAgICAgIH0pKSxcbiAgICAgIH0pKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2Rlc2t0b3Avc2h1dGRvd24nKSB7XG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlIH0pKTtcbiAgICAgIHNlcnZlci5jbG9zZSgoKSA9PiBwcm9jZXNzLmV4aXQoMCkpO1xuICAgICAgc2V0VGltZW91dCgoKSA9PiBwcm9jZXNzLmV4aXQoMCksIDFfMDAwKS51bnJlZigpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZmFrZS9kaWUnKSB7XG4gICAgICAvLyBcdTZENEJcdThCRDVcdTk0QTlcdTVCNTA6XHU2QTIxXHU2MkRGIGhvc3QgXHU1RDI5XHU2RTgzKFx1NTE0OFx1NUU5NFx1N0I1NFx1NTE4RFx1OTAwMFx1NTFGQSxcdTRGRERcdThCQzFcdTU0Q0RcdTVFOTRcdTVERjJcdTUzRDFcdTUxRkEpXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlIH0pKTtcbiAgICAgIHNldFRpbWVvdXQoKCkgPT4gcHJvY2Vzcy5leGl0KDEpLCA1MCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS90YXNrJykge1xuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7IHRleHQ/OiB1bmtub3duOyBzZXNzaW9uSWQ/OiB1bmtub3duOyBtb2RlPzogdW5rbm93bjsgYXR0YWNobWVudHM/OiB1bmtub3duIH07XG4gICAgICAgICAgY29uc3QgdGV4dCA9IHR5cGVvZiBib2R5LnRleHQgPT09ICdzdHJpbmcnID8gYm9keS50ZXh0IDogJyc7XG4gICAgICAgICAgY29uc3Qgc2Vzc2lvbklkID0gdHlwZW9mIGJvZHkuc2Vzc2lvbklkID09PSAnc3RyaW5nJyA/IGJvZHkuc2Vzc2lvbklkIDogYHdlYi0ke0RhdGUubm93KCkudG9TdHJpbmcoMzYpfWA7XG4gICAgICAgICAgY29uc3QgbW9kZSA9IGJvZHkubW9kZSA9PT0gJ2FzaycgfHwgYm9keS5tb2RlID09PSAnYXV0bycgfHwgYm9keS5tb2RlID09PSAneW9sbycgPyBib2R5Lm1vZGUgOiAnYXNrJztcbiAgICAgICAgICBjb25zdCBhdHRhY2htZW50cyA9IEFycmF5LmlzQXJyYXkoYm9keS5hdHRhY2htZW50cykgPyBib2R5LmF0dGFjaG1lbnRzLmZpbHRlcigoYSk6IGEgaXMgc3RyaW5nID0+IHR5cGVvZiBhID09PSAnc3RyaW5nJykgOiBbXTtcbiAgICAgICAgICBpZiAoIXRleHQpIHtcbiAgICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3RleHQgcmVxdWlyZWQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8gXHU0RTBFIGhtaGFybmVzcyBcdTU0MENcdThCRURcdTRFNDk6XHU1NDA4XHU2Q0Q1XHU5NjQ0XHU0RUY2XHU0RUU1IFtyZWZlcmVuY2VkIGZpbGVzXSBcdTUyNERcdTdGMDBcdTVFNzZcdTUxNjVcdTRFRkJcdTUyQTFcdTY1ODdcdTY3MkNcbiAgICAgICAgICBjb25zdCBjb21wb3NlZCA9IGF0dGFjaG1lbnRzLmxlbmd0aCA+IDAgPyBgW3JlZmVyZW5jZWQgZmlsZXNdXFxuJHthdHRhY2htZW50cy5tYXAoKGEpID0+IGAtICR7YS5zcGxpdCgvW1xcXFwvXS8pLnBvcCgpfWApLmpvaW4oJ1xcbicpfVxcblxcbiR7dGV4dH1gIDogdGV4dDtcbiAgICAgICAgICBjb25zdCBydW5JZCA9IHJ1blRhc2soc2Vzc2lvbklkLCBjb21wb3NlZCwgbW9kZSk7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIHJ1bklkIH0pKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgU3RyaW5nKGVycikuc2xpY2UoMCwgMTIwKSwgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgIH1cbiAgICAgIH0pKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9hcHByb3ZlJykge1xuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgoYXdhaXQgcmVhZEJvZHkoKSkgfHwgJ3t9JykgYXMgeyBncmFudGVkPzogdW5rbm93bjsgc2Vzc2lvbklkPzogdW5rbm93biB9O1xuICAgICAgICBjb25zdCBzaWQgPSB0eXBlb2YgYm9keS5zZXNzaW9uSWQgPT09ICdzdHJpbmcnID8gYm9keS5zZXNzaW9uSWQgOiAnJztcbiAgICAgICAgaWYgKHBlbmRpbmcgPT09IG51bGwgfHwgKHNpZCAhPT0gJycgJiYgcGVuZGluZy5zZXNzaW9uSWQgIT09IHNpZCkpIHtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnbm8gYXBwcm92YWwgcGVuZGluZycsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBwID0gcGVuZGluZztcbiAgICAgICAgcGVuZGluZyA9IG51bGw7XG4gICAgICAgIHAucmVzb2x2ZShib2R5LmdyYW50ZWQgPT09IHRydWUpO1xuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIGdyYW50ZWQ6IGJvZHkuZ3JhbnRlZCA9PT0gdHJ1ZSB9KSk7XG4gICAgICB9KSgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZS5zdGFydHNXaXRoKCcvYXBpL3Nlc3Npb25zLycpICYmICh1cmwucGF0aG5hbWUuZW5kc1dpdGgoJy9hcmNoaXZlJykgfHwgdXJsLnBhdGhuYW1lLmVuZHNXaXRoKCcvZGVsZXRlJykpKSB7XG4gICAgICAvLyBcdTRGMUFcdThCRERcdTVGNTJcdTY4NjMvXHU1MjIwXHU5NjY0KGhtaGFybmVzcyBcdTU0MENcdTVGNjI6XHU3OUZCXHU1MTY1IGFyY2hpdmUvdHJhc2gsXHU1M0VGXHU2MDYyXHU1OTBELFx1NEUwRFx1Nzg2Q1x1NTIyMClcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgcGFydHMgPSB1cmwucGF0aG5hbWUuc2xpY2UoJy9hcGkvc2Vzc2lvbnMvJy5sZW5ndGgpLnNwbGl0KCcvJyk7XG4gICAgICAgIGNvbnN0IG9wID0gcGFydHNbMV0gPz8gJyc7XG4gICAgICAgIGNvbnN0IG9pZCA9IGRlY29kZVVSSUNvbXBvbmVudChwYXJ0c1swXSA/PyAnJykucmVwbGFjZSgvW15hLXpBLVowLTlfOi5ALV0vZywgJycpO1xuICAgICAgICBpZiAob2lkID09PSAnJyB8fCAob3AgIT09ICdhcmNoaXZlJyAmJiBvcCAhPT0gJ2RlbGV0ZScpKSB7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ2JhZCBvcCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIXNlc3Npb25zLmhhcyhvaWQpKSB7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ3Nlc3Npb24gbm90IGZvdW5kJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHNlc3Npb25zLmRlbGV0ZShvaWQpO1xuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUgfSkpO1xuICAgICAgfSkoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2luamVjdCcpIHtcbiAgICAgIC8vIFx1OEZEMFx1ODg0Q1x1NEUyRFx1NkNFOFx1NTE2NShcdTRFMEUgaG1oYXJuZXNzIC9hcGkvaW5qZWN0IFx1NTQwQ1x1NUY2MjtmYWtlIFx1NTNFQVx1NTZERVx1NjI2NylcbiAgICAgIHZvaWQgcmVhZEJvZHkoKTtcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUgfSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvaW50ZXJydXB0Jykge1xuICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoJycpIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+OyAvLyBpbnRlcnJ1cHQgXHU2NUUwIGJvZHkgXHU4QkVEXHU0RTQ5XG4gICAgICB2b2lkIGJvZHk7XG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlIH0pKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvc2Vzc2lvbnMnKSB7XG4gICAgICBjb25zdCBsaXN0ID0gWy4uLnNlc3Npb25zLnZhbHVlcygpXS5tYXAoKHMpID0+ICh7XG4gICAgICAgIGlkOiBzLmlkLCB0aXRsZTogJycsIHRhc2s6ICcnLCBvdXRjb21lOiAnb2snLCB0dXJuczogMSwgdG9vbFVzZXM6IDEsXG4gICAgICAgIHRpbWU6IHMudXBkYXRlZEF0LCBjd2Q6ICdDOlxcXFxkZW1vJywgYnJhbmNoOiAnJywgY3JlYXRlZEF0OiBzLmNyZWF0ZWRBdCwgdXBkYXRlZEF0OiBzLnVwZGF0ZWRBdCxcbiAgICAgIH0pKTtcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgc2Vzc2lvbnM6IGxpc3QsIG5leHRDdXJzb3I6IG51bGwgfSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lLnN0YXJ0c1dpdGgoJy9hcGkvc2Vzc2lvbnMvJykpIHtcbiAgICAgIGNvbnN0IHNlZyA9IGRlY29kZVVSSUNvbXBvbmVudCh1cmwucGF0aG5hbWUuc2xpY2UoJy9hcGkvc2Vzc2lvbnMvJy5sZW5ndGgpKTtcbiAgICAgIC8vIFx1NUJGQ1x1NTFGQShcdTRFMEUgaG1oYXJuZXNzIC9hcGkvc2Vzc2lvbnMvOmlkL2V4cG9ydC5tZCBcdTU0MENcdTVGNjI6dGV4dC9tYXJrZG93biBcdTRFMEJcdThGN0QpXG4gICAgICBjb25zdCBleHBvcnRNYXRjaCA9IC9eKC4qKVxcL2V4cG9ydFxcLm1kJC8uZXhlYyhzZWcpID8/IC9eKC4qKVxcLmV4cG9ydFxcLm1kJC8uZXhlYyhzZWcpO1xuICAgICAgaWYgKGV4cG9ydE1hdGNoICE9PSBudWxsICYmIGV4cG9ydE1hdGNoWzFdICE9PSB1bmRlZmluZWQgJiYgZXhwb3J0TWF0Y2hbMV0gIT09ICcnKSB7XG4gICAgICAgIGNvbnN0IGVpZCA9IGV4cG9ydE1hdGNoWzFdLnJlcGxhY2UoL1teYS16QS1aMC05XzouQC1dL2csICcnKTtcbiAgICAgICAgY29uc3QgZXMgPSBzZXNzaW9ucy5nZXQoZWlkKTtcbiAgICAgICAgaWYgKGVzID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnc2Vzc2lvbiBub3QgZm91bmQnLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICd0ZXh0L21hcmtkb3duOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgcmVzLmVuZChgIyBobWhhcm5lc3MgXHU0RjFBXHU4QkREXHU1QkZDXHU1MUZBKGZha2UpXFxuXFxuLSBcdTRGMUFcdThCREQ6JHtlaWR9XFxuXFxuIyMgXHU3NTI4XHU2MjM3XFxuXFxuXHU0RTRCXHU1MjREXHU3Njg0XHU0RUZCXHU1MkExKGZha2UgXHU5ODg0XHU4OUM4KVxcblxcbiMjIFx1NTJBOVx1NjI0Qlxcblxcblx1OEZEOVx1NjYyRlx1NUJGQ1x1NTFGQVx1NzY4NFx1NTZERVx1NTkwRFx1OTg4NFx1ODlDOChmYWtlKVx1MzAwMlxcbmApO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICAvLyBcdTRGMUFcdThCRERcdTk4ODRcdTg5QzgoXHU0RTBFIGhtaGFybmVzcyBHRVQgL2FwaS9zZXNzaW9ucy86aWQgXHU1NDBDXHU1RjYyOlx1NjcwMFx1NTQwRSA4MCBcdTY3NjEsXHU2QkNGXHU2NzYxIDUwMCBcdTVCNTcpXG4gICAgICBjb25zdCBpZCA9IHNlZy5yZXBsYWNlKC9bXmEtekEtWjAtOV86LkAtXS9nLCAnJyk7XG4gICAgICBjb25zdCBzID0gc2Vzc2lvbnMuZ2V0KGlkKTtcbiAgICAgIGlmIChzID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICdzZXNzaW9uIG5vdCBmb3VuZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIGlkLCBtb2RlbDogJ2Zha2UtbW9kZWwnLCBjd2Q6ICdDOlxcXFxkZW1vJyxcbiAgICAgICAgbWVzc2FnZXM6IFtcbiAgICAgICAgICB7IHJvbGU6ICd1c2VyJywgdGV4dDogJ1x1NEU0Qlx1NTI0RFx1NzY4NFx1NEVGQlx1NTJBMShmYWtlIFx1OTg4NFx1ODlDOCknLCB0b29sczogW10gfSxcbiAgICAgICAgICB7IHJvbGU6ICdhc3Npc3RhbnQnLCB0ZXh0OiAnXHU4RkQ5XHU2NjJGXHU1Mzg2XHU1M0YyXHU0RjFBXHU4QkREXHU3Njg0XHU1NkRFXHU1OTBEXHU5ODg0XHU4OUM4KGZha2UpXHUzMDAyJywgdG9vbHM6IFsncmVhZF9maWxlJ10gfSxcbiAgICAgICAgXSxcbiAgICAgIH0pKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZnMnKSB7XG4gICAgICAvLyBcdTc2RUVcdTVGNTVcdTZENEZcdTg5QzgoXHU0RTBFIGhtaGFybmVzcyBcdTU0MENcdTVGNjI6cGF0aCBcdTc3MDFcdTc1NjU9XHU2ODM5O2ZpbGVzPTEgXHU5NjQ0XHU1RTI2XHU2NTg3XHU0RUY2XHU1MjE3XHU4ODY4KVxuICAgICAgY29uc3QgcSA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KCdwYXRoJykgPz8gJyc7XG4gICAgICBjb25zdCB3aXRoRmlsZXMgPSB1cmwuc2VhcmNoUGFyYW1zLmdldCgnZmlsZXMnKSA9PT0gJzEnO1xuICAgICAgaWYgKHEgPT09ICcnKSB7XG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgIHBhdGg6ICcnLCBzZWdtZW50czogW10sIHBhcmVudDogJycsXG4gICAgICAgICAgZGlyczogW3sgbmFtZTogJ2RlbW8td29ya3NwYWNlJywgcGF0aDogJ0M6XFxcXGRlbW8nIH1dLFxuICAgICAgICAgIC4uLih3aXRoRmlsZXMgPyB7IGZpbGVzOiBbXSB9IDoge30pLFxuICAgICAgICB9KSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgcGF0aDogcSwgc2VnbWVudHM6IFt7IG5hbWU6IHEuc3BsaXQoL1tcXFxcL10vKS5maWx0ZXIoQm9vbGVhbikucG9wKCkgPz8gcSwgcGF0aDogcSB9XSwgcGFyZW50OiAnJyxcbiAgICAgICAgZGlyczogW3sgbmFtZTogJ3NyYycsIHBhdGg6IGAke3EucmVwbGFjZSgvW1xcXFwvXSQvLCAnJyl9XFxcXHNyY2AgfV0sXG4gICAgICAgIC4uLih3aXRoRmlsZXMgPyB7IGZpbGVzOiBbXG4gICAgICAgICAgeyBuYW1lOiAnUkVBRE1FLm1kJywgcGF0aDogYCR7cS5yZXBsYWNlKC9bXFxcXC9dJC8sICcnKX1cXFxcUkVBRE1FLm1kYCwgcmVsOiAnUkVBRE1FLm1kJyB9LFxuICAgICAgICAgIHsgbmFtZTogJ3BhY2thZ2UuanNvbicsIHBhdGg6IGAke3EucmVwbGFjZSgvW1xcXFwvXSQvLCAnJyl9XFxcXHBhY2thZ2UuanNvbmAsIHJlbDogJ3BhY2thZ2UuanNvbicgfSxcbiAgICAgICAgXSB9IDoge30pLFxuICAgICAgfSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9mcy9yZWFkJykge1xuICAgICAgLy8gXHU2NTg3XHU0RUY2XHU5ODg0XHU4OUM4KDY0S0IgXHU0RTBBXHU5NjUwXHU4QkVEXHU0RTQ5O2Zha2UgXHU4RkQ0XHU1NkRFXHU1NkZBXHU1QjlBXHU2NTg3XHU2NzJDKVxuICAgICAgY29uc3QgcCA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KCdwYXRoJykgPz8gJyc7XG4gICAgICBpZiAocCA9PT0gJycpIHtcbiAgICAgICAgcmVzLndyaXRlSGVhZCg0MDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICdwYXRoIHJlcXVpcmVkJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgcGF0aDogcCwgcmVsOiBwLnNwbGl0KC9bXFxcXC9dLykucG9wKCkgPz8gcCwgc2l6ZTogNDIsXG4gICAgICAgIHRleHQ6ICcjIGRlbW8gd29ya3NwYWNlXFxuXFxuXHU4RkQ5XHU2NjJGIGZha2UgaG9zdCBcdTc2ODRcdTY1ODdcdTRFRjZcdTk4ODRcdTg5QzhcdTUxODVcdTVCQjlcdTMwMDJcXG4nLFxuICAgICAgfSkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ0dFVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9kaWZmJykge1xuICAgICAgLy8gRGlmZiBcdTk3NjJcdTY3N0YoXHU0RTBFIGhtaGFybmVzcyAvYXBpL2RpZmYgXHU1NDBDXHU1RjYyO2Zha2UgXHU4RkQ0XHU1NkRFXHU1NkZBXHU1QjlBXHU1QzBGXHU1M0Q4XHU2NkY0XHU5NkM2KVxuICAgICAgcmVzLndyaXRlSGVhZCgyMDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBnaXQ6IHRydWUsIGN3ZDogJ0M6XFxcXGRlbW8nLFxuICAgICAgICBjaGFuZ2VkOiBbXG4gICAgICAgICAgeyBzdGF0ZTogJ00nLCBwYXRoOiAnc3JjL2FwcC50cycgfSxcbiAgICAgICAgICB7IHN0YXRlOiAnQScsIHBhdGg6ICdkb2NzL25vdGVzLm1kJyB9LFxuICAgICAgICBdLFxuICAgICAgICBzdGF0OiAnIHNyYy9hcHAudHMgICAgICB8IDEyICsrKysrKystLS1cXG4gZG9jcy9ub3Rlcy5tZCAgIHwgIDQgKysrK1xcbiAyIGZpbGVzIGNoYW5nZWQsIDE2IGluc2VydGlvbnMoKyksIDMgZGVsZXRpb25zKC0pJyxcbiAgICAgIH0pKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvd29ya3NwYWNlcycpIHtcbiAgICAgIC8vIFx1NURFNVx1NEY1Q1x1NTMzQShcdTRFMEUgaG1oYXJuZXNzIFx1NTQwQ1x1NUY2MjpjdXJyZW50ICsgaXRlbXMpXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIGN1cnJlbnQ6IGZha2VXb3Jrc3BhY2VzLmN1cnJlbnQsXG4gICAgICAgIGl0ZW1zOiBmYWtlV29ya3NwYWNlcy5pdGVtcyxcbiAgICAgIH0pKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdQT1NUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL3dvcmtzcGFjZXMnKSB7XG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGJvZHkgPSBKU09OLnBhcnNlKChhd2FpdCByZWFkQm9keSgpKSB8fCAne30nKSBhcyB7IG5hbWU/OiB1bmtub3duOyBwYXRoPzogdW5rbm93biB9O1xuICAgICAgICBjb25zdCBwYXRoID0gdHlwZW9mIGJvZHkucGF0aCA9PT0gJ3N0cmluZycgPyBib2R5LnBhdGggOiAnJztcbiAgICAgICAgY29uc3QgbmFtZSA9IHR5cGVvZiBib2R5Lm5hbWUgPT09ICdzdHJpbmcnICYmIGJvZHkubmFtZSAhPT0gJycgPyBib2R5Lm5hbWUgOiAocGF0aC5zcGxpdCgvW1xcXFwvXS8pLmZpbHRlcihCb29sZWFuKS5wb3AoKSA/PyAnJyk7XG4gICAgICAgIGlmIChwYXRoID09PSAnJyB8fCBuYW1lID09PSAnJykge1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICdhYnNvbHV0ZSBwYXRoIGFuZCBuYW1lIHJlcXVpcmVkJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGlmIChmYWtlV29ya3NwYWNlcy5pdGVtcy5zb21lKCh3KSA9PiB3LnBhdGgudG9Mb3dlckNhc2UoKSA9PT0gcGF0aC50b0xvd2VyQ2FzZSgpKSkge1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDA5LCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeShkZXNrdG9wRXJyb3IoJ1NDSEVNQV9NSVNNQVRDSCcsICd3b3Jrc3BhY2UgYWxyZWFkeSByZWdpc3RlcmVkJywgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGl0ZW0gPSB7IGlkOiBgd3MtJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCA4KX1gLCBuYW1lLCBwYXRoIH07XG4gICAgICAgIGZha2VXb3Jrc3BhY2VzLml0ZW1zLnB1c2goaXRlbSk7XG4gICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBvazogdHJ1ZSwgY3VycmVudDogZmFrZVdvcmtzcGFjZXMuY3VycmVudCwgaXRlbXM6IGZha2VXb3Jrc3BhY2VzLml0ZW1zIH0pKTtcbiAgICAgIH0pKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS93b3Jrc3BhY2VzL3VzZScpIHtcbiAgICAgIHZvaWQgKGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoKGF3YWl0IHJlYWRCb2R5KCkpIHx8ICd7fScpIGFzIHsgaWQ/OiB1bmtub3duIH07XG4gICAgICAgIGNvbnN0IGhpdCA9IGZha2VXb3Jrc3BhY2VzLml0ZW1zLmZpbmQoKHcpID0+IHcuaWQgPT09IGJvZHkuaWQpO1xuICAgICAgICBpZiAoaGl0ID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwNCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCAnd29ya3NwYWNlIG5vdCBmb3VuZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBmYWtlV29ya3NwYWNlcy5jdXJyZW50ID0gaGl0LmlkO1xuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIGN1cnJlbnQ6IGZha2VXb3Jrc3BhY2VzLmN1cnJlbnQsIGl0ZW1zOiBmYWtlV29ya3NwYWNlcy5pdGVtcyB9KSk7XG4gICAgICB9KSgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gJ1BPU1QnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvcHJvdmlkZXJzJykge1xuICAgICAgdm9pZCAoYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCBib2R5ID0gSlNPTi5wYXJzZSgoYXdhaXQgcmVhZEJvZHkoKSkgfHwgJ3t9JykgYXMgeyBuYW1lPzogdW5rbm93bjsgYmFzZVVybD86IHVua25vd247IG1vZGVsPzogdW5rbm93bjsgYXBpS2V5PzogdW5rbm93biB9O1xuICAgICAgICBjb25zdCBuYW1lID0gdHlwZW9mIGJvZHkubmFtZSA9PT0gJ3N0cmluZycgPyBib2R5Lm5hbWUudHJpbSgpIDogJyc7XG4gICAgICAgIGNvbnN0IGJhc2VVcmwgPSB0eXBlb2YgYm9keS5iYXNlVXJsID09PSAnc3RyaW5nJyA/IGJvZHkuYmFzZVVybC50cmltKCkgOiAnJztcbiAgICAgICAgY29uc3QgbW9kZWwgPSB0eXBlb2YgYm9keS5tb2RlbCA9PT0gJ3N0cmluZycgPyBib2R5Lm1vZGVsLnRyaW0oKSA6ICcnO1xuICAgICAgICBpZiAobmFtZSA9PT0gJycgfHwgYmFzZVVybCA9PT0gJycgfHwgbW9kZWwgPT09ICcnKSB7XG4gICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDAsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgJ25hbWUsIGJhc2VVcmwgYW5kIG1vZGVsIGFyZSByZXF1aXJlZCcsIHsgcmV0cnlhYmxlOiBmYWxzZSB9KSkpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBmYWtlUHJvdmlkZXJzLnNldChuYW1lLCB7IGJhc2VVcmwsIG1vZGVsLCBhcGlLZXk6IHR5cGVvZiBib2R5LmFwaUtleSA9PT0gJ3N0cmluZycgPyBib2R5LmFwaUtleSA6ICcnIH0pO1xuICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIG5hbWUgfSkpO1xuICAgICAgfSkoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcS5tZXRob2QgPT09ICdHRVQnICYmIHVybC5wYXRobmFtZSA9PT0gJy9hcGkvZnMvc2VhcmNoJykge1xuICAgICAgLy8gXHU1REU1XHU0RjVDXHU1MzNBXHU2NTg3XHU0RUY2XHU2NDFDXHU3RDIyKFx1NEUwRSBobWhhcm5lc3MgXHU1NDBDXHU1RjYyOkBcdTk2NDRcdTRFRjZcdTkwMDlcdTYyRTlcdTU2NjhcdTc2ODRcdTY1NzBcdTYzNkVcdTZFOTApXG4gICAgICBjb25zdCBxID0gKHVybC5zZWFyY2hQYXJhbXMuZ2V0KCdxJykgPz8gJycpLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuICAgICAgY29uc3QgYWxsID0gW1xuICAgICAgICB7IHJlbDogJ1JFQURNRS5tZCcsIHBhdGg6ICdDOlxcXFxkZW1vXFxcXFJFQURNRS5tZCcsIGtpbmQ6ICdmaWxlJyB9LFxuICAgICAgICB7IHJlbDogJ3NyYy9hcHAudHMnLCBwYXRoOiAnQzpcXFxcZGVtb1xcXFxzcmNcXFxcYXBwLnRzJywga2luZDogJ2ZpbGUnIH0sXG4gICAgICAgIHsgcmVsOiAnZG9jcy9ub3Rlcy5tZCcsIHBhdGg6ICdDOlxcXFxkZW1vXFxcXGRvY3NcXFxcbm90ZXMubWQnLCBraW5kOiAnZmlsZScgfSxcbiAgICAgIF07XG4gICAgICBjb25zdCBoaXRzID0gcSA9PT0gJycgPyBhbGwgOiBhbGwuZmlsdGVyKChmKSA9PiBmLnJlbC50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHEpKTtcbiAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgcmVzdWx0czogaGl0cy5zbGljZSgwLCAyMCksIHRydW5jYXRlZDogZmFsc2UsIHRvdGFsOiBoaXRzLmxlbmd0aCB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnR0VUJyAmJiB1cmwucGF0aG5hbWUgPT09ICcvYXBpL2NvZ25pdGl2ZScpIHtcbiAgICAgIC8vIFx1OEJBNFx1NzdFNVx1NzJCNlx1NjAwMShcdTRFMEUgaG1oYXJuZXNzIGNvZ25pdGl2ZVN0YXR1cyBcdTU0MENcdTVGNjJcdTVCNTBcdTk2QzY7XHU3RjNBXHU2NTcwXHU2MzZFXHU2NjNFXHU1RjBGIG51bGwpXG4gICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIG1lbW9yeTogeyBsYXllcnM6IDMsIGVudHJpZXM6IDEyLCBjb250cmFkaWN0aW9uczogMCB9LFxuICAgICAgICB0cmFqZWN0b3JpZXM6IDcsXG4gICAgICAgIGF1ZGl0RXZlbnRzOiAyMSxcbiAgICAgICAgd29ybGRNb2RlbDogeyB2ZXJzaW9uOiA0LCBiZWxpZWZzOiA5LCB0cnVzdGVkOiA1LCBicmllcjogMC4zMSB9LFxuICAgICAgICBjYWxpYnJhdGlvbjogeyBwcmVkaWN0aW9uczogNDYsIHJlbGlhYmlsaXR5OiAwLjcyIH0sXG4gICAgICB9KSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXEubWV0aG9kID09PSAnUE9TVCcgJiYgdXJsLnBhdGhuYW1lID09PSAnL2FwaS9mYWtlL2VtaXQnKSB7XG4gICAgICB2b2lkIChhc3luYyAoKSA9PiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgYm9keSA9IEpTT04ucGFyc2UoKGF3YWl0IHJlYWRCb2R5KCkpIHx8ICd7fScpIGFzIHtcbiAgICAgICAgICAgIHNlc3Npb25JZDogc3RyaW5nOyBydW5JZDogc3RyaW5nOyBraW5kOiBFdmVudEtpbmQ7IHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgICAgIH07XG4gICAgICAgICAgY29uc3Qgc2VxID0gZW1pdChib2R5LnNlc3Npb25JZCwgYm9keS5ydW5JZCwgYm9keS5raW5kLCBib2R5LnBheWxvYWQpO1xuICAgICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCcgfSk7XG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlLCBzZXEgfSkpO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyAnY29udGVudC10eXBlJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnIH0pO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoZGVza3RvcEVycm9yKCdTQ0hFTUFfTUlTTUFUQ0gnLCBTdHJpbmcoZXJyKS5zbGljZSgwLCAxMjApLCB7IHJldHJ5YWJsZTogZmFsc2UgfSkpKTtcbiAgICAgICAgfVxuICAgICAgfSkoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgcmVzLndyaXRlSGVhZCg0MDQsIHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyB9KTtcbiAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KGRlc2t0b3BFcnJvcignU0NIRU1BX01JU01BVENIJywgYG5vIHJvdXRlICR7cmVxLm1ldGhvZH0gJHt1cmwucGF0aG5hbWV9YCwgeyByZXRyeWFibGU6IGZhbHNlIH0pKSk7XG4gIH0pO1xuXG4gIGF3YWl0IG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICBzZXJ2ZXIub25jZSgnZXJyb3InLCByZWplY3QpO1xuICAgIHNlcnZlci5saXN0ZW4oMCwgJzEyNy4wLjAuMScsICgpID0+IHJlc29sdmUoKSk7XG4gIH0pO1xuICBjb25zdCBhZGRyZXNzID0gc2VydmVyLmFkZHJlc3MoKTtcbiAgaWYgKGFkZHJlc3MgPT09IG51bGwgfHwgdHlwZW9mIGFkZHJlc3MgIT09ICdvYmplY3QnKSB0aHJvdyBuZXcgRXJyb3IoJ2Zha2UgaG9zdDogbm8gcG9ydCcpO1xuICBjb25zdCBwb3J0ID0gYWRkcmVzcy5wb3J0O1xuXG4gIGlmICghb3B0cy5xdWlldCkge1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KHsgaG1oRGVza3RvcEhvc3RSZWFkeTogdHJ1ZSwgcG9ydCwgdmVyc2lvbjogJ2Zha2UtMC4wLjAnIH0pfVxcbmApO1xuICB9XG4gIGNvbnN0IGRpZUFmdGVyID0gTnVtYmVyKHByb2Nlc3MuZW52LkZBS0VfSE9TVF9ESUVfQUZURVJfTVMgPz8gMCk7XG4gIGlmIChOdW1iZXIuaXNGaW5pdGUoZGllQWZ0ZXIpICYmIGRpZUFmdGVyID4gMCkge1xuICAgIHNldFRpbWVvdXQoKCkgPT4gcHJvY2Vzcy5leGl0KDEpLCBkaWVBZnRlcikudW5yZWYoKTtcbiAgfVxuXG4gIC8vIGNsb3NlKCk6IFx1NTE0OFx1NjVBRFx1NUYwMFx1NTE2OFx1OTBFOCBTU0UgXHU4RkRFXHU2M0E1KFx1NUI4M1x1NEVFQ1x1NkMzOFx1NEUwRFx1ODFFQVx1NzEzNlx1NTE3M1x1OTVFRCksXHU1NDI2XHU1MjE5IHNlcnZlci5jbG9zZVxuICAvLyBcdTRGMUFcdTRFMDBcdTc2RjRcdTdCNDlcdTZEM0JcdThEQzNcdThGREVcdTYzQTUsXHU2RDRCXHU4QkQ1XHU4RkRCXHU3QTBCXHU2MzAyXHU2QjdCXHUzMDAyXG4gIGNvbnN0IGNsb3NlID0gKCk6IFByb21pc2U8dm9pZD4gPT5cbiAgICBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4ge1xuICAgICAgZm9yIChjb25zdCBjIG9mIHNzZUNsaWVudHMpIHtcbiAgICAgICAgdHJ5IHsgYy5lbmQoKTsgYy5kZXN0cm95KCk7IH0gY2F0Y2ggeyAvKiBhbHJlYWR5IGdvbmUgKi8gfVxuICAgICAgfVxuICAgICAgc3NlQ2xpZW50cy5jbGVhcigpO1xuICAgICAgc2VydmVyLmNsb3NlKCgpID0+IHJlc29sdmUoKSk7XG4gICAgICBzZXRUaW1lb3V0KCgpID0+IHJlc29sdmUoKSwgMV8wMDApLnVucmVmKCk7XG4gICAgfSk7XG5cbiAgcmV0dXJuIHsgcG9ydCwgZW1pdCwgY2xvc2UgfTtcbn1cblxuLy8gXHU3NkY0XHU2M0E1XHU4RkQwXHU4ODRDKHN1cGVydmlzb3Igc3Bhd24gXHU3Njg0XHU1QjUwXHU4RkRCXHU3QTBCXHU1RjYyXHU2MDAxKVx1MzAwMnJlYWxwYXRoIFx1NkJENFx1OEY4MzpucG0gd29ya3NwYWNlXG4vLyBqdW5jdGlvbiAvIFx1NTkyN1x1NUMwRlx1NTE5OVx1NURFRVx1NUYwMlx1OTBGRFx1NEUwRFx1ODBGRFx1OEJBOVx1OEZEOVx1NEUyQVx1NjhDMFx1NkQ0Qlx1NTkzMVx1NjI0QihcdTU5MzFcdTYyNEI9XHU5NzU5XHU5RUQ4XHU5MDAwXHU1MUZBIGNvZGUgMCxcdTk2QkVcdTY3RTUpXHUzMDAyXG4vLyBjanMgYnVuZGxlKGVzYnVpbGQsXHU2MjUzXHU1MzA1XHU0RUE3XHU1NEMxKVx1NEUwQiBfX2ZpbGVuYW1lIFx1NUI1OFx1NTcyODtFU00odHN4L1x1NkU5MFx1NzgwMSlcdTc1MjggaW1wb3J0Lm1ldGFcdTMwMDJcbmNvbnN0IHNlbGZVcmw6IHN0cmluZyA9IHR5cGVvZiBfX2ZpbGVuYW1lID09PSAnc3RyaW5nJ1xuICA/IHBhdGhUb0ZpbGVVUkwocmVhbHBhdGhTeW5jKF9fZmlsZW5hbWUpKS5ocmVmXG4gIDogaW1wb3J0Lm1ldGEudXJsO1xuY29uc3QgaW52b2tlZEFzU2NyaXB0ID0gKCgpID0+IHtcbiAgaWYgKHByb2Nlc3MuYXJndlsxXSA9PT0gdW5kZWZpbmVkKSByZXR1cm4gZmFsc2U7XG4gIHRyeSB7XG4gICAgcmV0dXJuIHNlbGZVcmwgPT09IHBhdGhUb0ZpbGVVUkwocmVhbHBhdGhTeW5jKHByb2Nlc3MuYXJndlsxXSkpLmhyZWY7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufSkoKTtcbmlmIChpbnZva2VkQXNTY3JpcHQpIHtcbiAgY29uc3QgdG9rZW4gPSBwcm9jZXNzLmVudi5ITUhfREVTS1RPUF9UT0tFTiA/PyAnJztcbiAgLy8gRkFLRV9IT1NUX0RJRV9BVF9CT09UPTE6XHU1RjE1XHU1QkZDXHU4ODRDXHU4RjkzXHU1MUZBXHU1MjREXHU1MzczXHU2QjdCKFx1Njc4NFx1OTAyMFx1NTQyRlx1NTJBOFx1NjcxRiBSVU5USU1FX0NSQVNIRUQpXG4gIGlmIChwcm9jZXNzLmVudi5GQUtFX0hPU1RfRElFX0FUX0JPT1QgPT09ICcxJykge1xuICAgIHByb2Nlc3MuZXhpdCgxKTtcbiAgfVxuICBjb25zdCBzbG93ID0gTnVtYmVyKHByb2Nlc3MuZW52LkZBS0VfSE9TVF9TTE9XX0FGVEVSID8/IDApO1xuICBjb25zdCBib290ID0gKCk6IHZvaWQgPT4ge1xuICAgIHZvaWQgc3RhcnRGYWtlSG9zdCh7IHRva2VuIH0pLmNhdGNoKChlcnIpID0+IHtcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBmYWtlLWhvc3QgZmFpbGVkOiAke1N0cmluZyhlcnIpfVxcbmApO1xuICAgICAgcHJvY2Vzcy5leGl0KDEpO1xuICAgIH0pO1xuICB9O1xuICBpZiAoTnVtYmVyLmlzRmluaXRlKHNsb3cpICYmIHNsb3cgPiAwKSBzZXRUaW1lb3V0KGJvb3QsIHNsb3cpO1xuICBlbHNlIGJvb3QoKTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICI7QUFjQSxTQUFTLEtBQUssZUFBZSxRQUFRLFNBQVMsU0FBUyxhQUFhO0FBQ3BFLFNBQVMsTUFBTSxTQUFTLFlBQVksZUFBZTtBQUNuRCxTQUFTLFlBQVksZ0JBQUFBLHFCQUFvQjtBQUN6QyxTQUFTLFdBQVcsZ0JBQWdCO0FBQ3BDLFNBQVMsZUFBZTtBQUN4QixTQUFTLG9CQUFvQjtBQUM3QixTQUFTLGlCQUFBQyxzQkFBcUI7OztB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QUEsRUFDL0I7QUFHQSxNQUFJLEdBQUcsZUFBZSxDQUFDLE1BQU07QUFDM0IsUUFBSSxlQUFlLFFBQVEsV0FBVyxVQUFVLFdBQVc7QUFDekQsUUFBRSxlQUFlO0FBQ2pCLGdCQUFVLE1BQU07QUFDaEIsV0FBSyxXQUFXLEtBQUssRUFBRSxRQUFRLE1BQU0sSUFBSSxLQUFLLENBQUM7QUFBQSxJQUNqRDtBQUFBLEVBQ0YsQ0FBQztBQUNELE1BQUksR0FBRyxxQkFBcUIsTUFBTTtBQUNoQyxRQUFJLFFBQVEsYUFBYSxTQUFVLEtBQUksS0FBSztBQUFBLEVBQzlDLENBQUM7QUFDSDtBQWxuQlc7QUFlQTtBQTREQTtBQXlDQTtBQW1GQTtBQVlBO0FBV0E7IiwKICAibmFtZXMiOiBbInJlYWxwYXRoU3luYyIsICJwYXRoVG9GaWxlVVJMIiwgInJlc29sdmUiLCAicmFuZG9tVVVJRCIsICJyYW5kb21VVUlEIiwgInJlc29sdmUiLCAicHVzaEV2ZW50IiwgImJyb2FkY2FzdEhvc3RTdGF0ZSIsICJkZXRlY3RSZWFsRW50cnkiLCAicmVhbHBhdGhTeW5jIiwgInJlcG9Sb290T2YiLCAic2VuZGVyVHJ1c3RlZCIsICJob3N0Q2FsbCIsICJyZWdpc3RlcklwYyIsICJwYXRoVG9GaWxlVVJMIl0KfQo=
