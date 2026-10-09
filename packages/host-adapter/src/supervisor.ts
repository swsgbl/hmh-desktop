/**
 * DesktopRuntimeSupervisor — hmharness host 进程的生命周期状态机(ADR-003)。
 *
 * 安全不变量:
 *  - 只绑定/探测 127.0.0.1;host 使用操作系统分配端口(port 0),实际端口
 *    由 host 的 stdout 引导行回传(HostReadyLine)。
 *  - 高熵 token 只通过子进程环境变量传递,绝不进 URL/日志/IPC 明文负载。
 *  - 只停止本 supervisor spawn 的进程句柄;绝不按进程名 kill。
 *  - host crash 后有限重启;重启不重放任何用户动作(非幂等动作由用户确认)。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { desktopError, isDesktopError, type DesktopError } from '@hmh-desktop/contracts';

export type HostState =
  | 'stopped'
  | 'starting'
  | 'ready'
  | 'disconnected'
  | 'restarting'
  | 'stopping'
  | 'failed';

export interface HostSpec {
  /** 可执行文件(通常 process.execPath)。 */
  command: string;
  args: string[];
  cwd?: string;
  /** 额外环境变量(会与 process.env 合并)。 */
  env?: Record<string, string>;
}

export interface SupervisorOptions {
  /** 期望 host 校验的 bearer token;不传则每次 start 生成高熵随机值。 */
  token?: string;
  maxRestarts?: number;
  startTimeoutMs?: number;
  gracefulShutdownMs?: number;
  onStateChange?(state: HostState, info: { restartCount: number; lastError?: string }): void;
  /** 每次 host 就绪(含 crash 自愈后的重启)都会触发,携带端点(含 token,
   *  仅供同信任域的宿主进程重建桥客户端;不要跨进 renderer)。 */
  onReady?(endpoint: HostEndpoint): void;
}

export interface HostEndpoint {
  port: number;
  version: string;
  token: string;
}

/** HostReadyLine 的类型守卫从 contracts 引入,避免双实现。 */
import { isHostReadyLine } from '@hmh-desktop/contracts';

const DEFAULT_START_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESTARTS = 3;
const DEFAULT_GRACEFUL_MS = 5_000;

export class DesktopRuntimeSupervisor {
  private child: ChildProcess | null = null;
  private _state: HostState = 'stopped';
  private restartCount = 0;
  private lastError = '';
  private stopping = false;
  private readonly token: string;
  private readonly opts: Required<Pick<SupervisorOptions, 'maxRestarts' | 'startTimeoutMs' | 'gracefulShutdownMs'>> & SupervisorOptions;
  private exitWaiters: Array<() => void> = [];

  constructor(
    private readonly spec: HostSpec,
    opts: SupervisorOptions = {},
  ) {
    this.token = opts.token ?? randomBytes(32).toString('base64url');
    this.opts = {
      maxRestarts: opts.maxRestarts ?? DEFAULT_MAX_RESTARTS,
      startTimeoutMs: opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
      gracefulShutdownMs: opts.gracefulShutdownMs ?? DEFAULT_GRACEFUL_MS,
      ...opts,
    };
  }

  get state(): HostState {
    return this._state;
  }

  get restartsUsed(): number {
    return this.restartCount;
  }

  private setState(s: HostState, err?: string): void {
    this._state = s;
    if (err !== undefined) this.lastError = err;
    const info: { restartCount: number; lastError?: string } = { restartCount: this.restartCount };
    if (this.lastError !== '') info.lastError = this.lastError;
    this.opts.onStateChange?.(s, info);
  }

  /** 启动 host 并等待 ready(引导行 + 带 token 的健康探测)。 */
  async start(): Promise<HostEndpoint> {
    if (this._state === 'ready' || this._state === 'starting') {
      throw desktopError('HOST_NOT_READY', `supervisor already ${this._state}`);
    }
    this.restartCount = 0;
    this.stopping = false;
    return this.launch();
  }

  private async launch(): Promise<HostEndpoint> {
    this.setState('starting');
    const child = spawn(this.spec.command, this.spec.args, {
      cwd: this.spec.cwd,
      env: {
        ...process.env,
        ...this.spec.env,
        HMH_DESKTOP_TOKEN: this.token,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

    try {
      const endpoint = await this.awaitReady(child);
      this.currentEndpoint = { port: endpoint.port, version: endpoint.version };
      this.setState('ready');
      this.opts.onReady?.(endpoint);
      // ready 之后进程死亡 = 意外退出 → 有限重启
      child.once('exit', () => {
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
  private awaitReady(child: ChildProcess): Promise<HostEndpoint> {
    return new Promise<HostEndpoint>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(desktopError('HOST_NOT_READY', `host did not signal ready within ${this.opts.startTimeoutMs}ms`, { retryable: true, recoveryAction: 'RECONNECT' }));
      }, this.opts.startTimeoutMs);

      const done = (fn: () => void): void => {
        clearTimeout(timer);
        fn();
      };

      if (!child.stdout) {
        done(() => reject(desktopError('RUNTIME_CRASHED', 'host spawned without stdout pipe')));
        return;
      }

      const rl = createInterface({ input: child.stdout });
      const onLine = (line: string): void => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          return; // host 的普通日志行,忽略
        }
        if (isHostReadyLine(parsed)) {
          rl.close();
          void this.probeAndRemember(parsed.port, parsed.version)
            .then((endpoint) => done(() => resolve(endpoint)))
            .catch((err: unknown) => done(() => reject(err)));
        }
      };
      rl.on('line', onLine);

      child.once('exit', (code) => {
        done(() => reject(desktopError('RUNTIME_CRASHED', `host exited during startup (code ${code ?? 'null'})`, { retryable: false, recoveryAction: 'OPEN_LOGS' })));
      });
    });
  }

  /** 带 token 的健康探测:GET /api/state。401 → AUTH_FAILED(不重试)。 */
  private async probe(port: number, version: string): Promise<HostEndpoint> {
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${port}/api/state`, {
        headers: { 'x-hmh-key': this.token },
        signal: AbortSignal.timeout(3_000),
      });
    } catch (err) {
      throw desktopError('HOST_NOT_READY', `health probe failed: ${String(err).slice(0, 160)}`, { retryable: true });
    }
    if (res.status === 401 || res.status === 403) {
      throw desktopError('AUTH_FAILED', `host rejected the session token (HTTP ${res.status})`, { retryable: false, recoveryAction: 'RECONNECT' });
    }
    if (!res.ok) {
      throw desktopError('HOST_NOT_READY', `health probe HTTP ${res.status}`, { retryable: true });
    }
    return { port, version, token: this.token };
  }

  private onUnexpectedExit(): void {
    if (this.stopping || this._state === 'stopped' || this._state === 'stopping') return;
    this.child = null;
    if (this.restartCount < this.opts.maxRestarts) {
      this.restartCount += 1;
      this.setState('restarting');
      void this.launch().catch(() => {
        // 重启尝试失败(启动即崩/超时/拒认):继续消耗重启次数直到放弃
        this.retryOrFail();
      });
    } else {
      this.setState('failed', `host exited unexpectedly ${this.restartCount + 1} times; giving up`);
    }
  }

  private retryOrFail(): void {
    if (this.stopping || this._state === 'stopped' || this._state === 'stopping') return;
    if (this.restartCount < this.opts.maxRestarts) {
      this.restartCount += 1;
      this.setState('restarting');
      void this.launch().catch(() => this.retryOrFail());
    } else {
      this.setState('failed', `host failed to stay up after ${this.restartCount} restart attempts`);
    }
  }

  /** 优雅停止:先 HTTP shutdown,超时才对本进程句柄 kill。 */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this._state === 'stopped') return;
    this.setState('stopping');
    const child = this.child;
    this.child = null;
    this.currentEndpoint = null;
    if (!child) {
      this.setState('stopped');
      return;
    }
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else {
        const w = (): void => resolve();
        this.exitWaiters.push(w);
        child.once('exit', w);
      }
    });
    // 已知端口才尝试 HTTP 优雅关闭;未知端口直接走 kill 兜底
    if (this.lastEndpoint !== null) {
      try {
        await fetch(`http://127.0.0.1:${this.lastEndpoint}/api/desktop/shutdown`, {
          method: 'POST',
          headers: { 'x-hmh-key': this.token },
          signal: AbortSignal.timeout(1_000),
        });
      } catch {
        // host 已死或不应答:走 kill 兜底
      }
    }
    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), this.opts.gracefulShutdownMs)),
    ]);
    if (!graceful && child.exitCode === null && child.signalCode === null) {
      child.kill(); // 只杀自己持有的句柄,绝不按进程名
    }
    await exited.catch(() => undefined);
    this.setState('stopped');
  }

  private lastEndpoint: number | null = null;
  private currentEndpoint: { port: number; version: string } | null = null;

  /** 当前 host 端点(ready 后有值;不含 token)。 */
  get endpoint(): { port: number; version: string } | null {
    return this.currentEndpoint;
  }

  /** 探测成功后记住端口,供 stop() 的优雅关闭使用。 */
  private async probeAndRemember(port: number, version: string): Promise<HostEndpoint> {
    const ep = await this.probe(port, version);
    this.lastEndpoint = ep.port;
    return ep;
  }
}

/** 把未知错误规约为 DesktopError(已是则原样返回)。 */
export function toDesktopError(err: unknown): DesktopError {
  if (isDesktopError(err)) return err;
  const message = err instanceof Error ? err.message : String(err);
  return desktopError('RUNTIME_CRASHED', message.slice(0, 300), { retryable: false });
}
