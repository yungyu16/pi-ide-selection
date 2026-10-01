/**
 * WebSocket 传输与连接生命周期。
 *
 * 只负责：连上正确的端口、带上认证头、发 initialize、应答心跳、断线退避重连、
 * 把解码出来的事件抛给上层。报文含义见 `protocol.ts`，lock 选路见 `lock.ts`。
 *
 * 必须依赖 `ws`：Node 内置 WebSocket 不支持自定义请求头（实测 header 被静默忽略，
 * 服务端随即以 1008 "Invalid or missing authentication token" 关闭连接），而认证
 * 恰恰只能通过 `X-Claude-Code-Ide-Authorization` 头传递。
 */

import { WebSocket } from "ws";
import { pickLock, readLocks, type LockInfo } from "./lock.ts";
import {
  decodeServerMessage,
  encodeError,
  encodeInitialize,
  encodeResult,
  METHOD_NOT_FOUND,
  type ServerEvent,
} from "./protocol.ts";
import type { SelectionState } from "./selection.ts";

/** IDE 重启会换端口，因此每次重连都重新扫 lock，而不是复用旧端口。 */
const MIN_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 5_000;
/** 与 Claude Code CLI 同等地位的客户端标识，出现在插件侧日志。 */
const CLIENT_NAME = "pi-ide";

export interface ConnectionState {
  /**
   * 连接成功后从 initialize 回包与 lock 得到的展示信息；断开时由 status/detail 表达。
   *
   * - `connected`：已连上；
   * - `retrying`：选到过端口但连接失败/断开，正在重连；
   * - `missing`：当前目录没有可连的插件（在 IDE 外跑 pi 的常态）；
   * - `unavailable`：其他不可用（如构造 WebSocket 抛错）。
   */
  status: "connected" | "retrying" | "missing" | "unavailable";
  ideName?: string;
  serverVersion?: string;
  port?: number;
  /** 供 `/ide status` 排障的简短原因。 */
  detail?: string;
}

export interface IDEClientHandlers {
  onSelection: (selection: SelectionState | null) => void;
  onConnection: (state: ConnectionState) => void;
}

export class IDEClient {
  private readonly cwd: string;
  private readonly handlers: IDEClientHandlers;
  private socket: WebSocket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private nextId = 1;
  private activeLock: LockInfo | null = null;
  /** 未主动 stop 之前为 true，用于区分"插件重启"与"本端退出"。 */
  private running = false;
  private attempts = 0;

  constructor(cwd: string, handlers: IDEClientHandlers) {
    this.cwd = cwd;
    this.handlers = handlers;
  }

  /** 幂等：重复调用不会产生第二条连接。 */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.attempts = 0;
    void this.dial();
  }

  /** 主动停止：不再重连，并清空选区（会话关闭/手动 off 时使用）。 */
  stop(): void {
    this.running = false;
    this.clearTimer();
    const socket = this.socket;
    this.socket = null;
    this.activeLock = null;
    if (socket) {
      socket.removeAllListeners();
      // CONNECTING 阶段 close 会异步发出 error，主动关闭也必须保留错误接收方。
      socket.on("error", () => {});
      try {
        socket.close();
      } catch {
        /* 关闭异常无需处理 */
      }
    }
    this.handlers.onSelection(null);
  }

  /** 不抛错：调用方以 `void dial()` 形式触发，异常会变成 unhandled rejection。 */
  private async dial(): Promise<void> {
    // readLocks 内部已吞掉所有 IO 错误，不会 reject。
    const locks = await readLocks();
    // off/退出可能发生在异步扫描期间；停止后不再创建连接或发送状态回调。
    if (!this.running) return;
    const lock = pickLock(locks, this.cwd);
    if (!lock) {
      this.handlers.onConnection({
        status: "missing",
        detail: "未发现匹配当前目录的 IDE 插件",
      });
      this.scheduleReconnect();
      return;
    }

    this.activeLock = lock;
    let socket: WebSocket;
    try {
      socket = new WebSocket(`ws://127.0.0.1:${lock.port}`, ["mcp"], {
        headers: { "X-Claude-Code-Ide-Authorization": lock.authToken! },
        handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      });
    } catch (error) {
      this.handlers.onConnection({
        status: "unavailable",
        ideName: lock.ideName,
        port: lock.port,
        detail: (error as Error).message,
      });
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.on("open", () => {
      this.attempts = 0;
      this.send(encodeInitialize(this.nextId++, CLIENT_NAME));
    });
    socket.on("message", (data) => this.handleEvent(decodeServerMessage(data.toString())));
    socket.on("error", (error) => {
      this.handlers.onConnection({
        status: "retrying",
        ideName: lock.ideName,
        port: lock.port,
        detail: error.message.split("\n")[0] ?? "连接错误",
      });
    });
    socket.on("close", () => {
      if (this.socket === socket) this.socket = null;
      this.handlers.onSelection(null);
      if (!this.running) return;
      this.handlers.onConnection({
        status: "retrying",
        ideName: lock.ideName,
        port: lock.port,
        detail: "连接已断开，重连中",
      });
      this.scheduleReconnect();
    });
  }

  private handleEvent(event: ServerEvent): void {
    switch (event.type) {
      case "selection":
        this.handlers.onSelection(event.selection);
        return;
      case "serverInfo":
        // 展示优先用 lock 里的 ideName（如 IntelliJ IDEA），serverInfo.name 是插件名。
        this.handlers.onConnection({
          status: "connected",
          ideName: this.activeLock?.ideName ?? event.name,
          serverVersion: event.version,
          port: this.activeLock?.port,
        });
        return;
      case "ping":
        // 不应答会被插件侧超时清理，长连接不稳定。
        this.send(encodeResult(event.id, {}));
        return;
      case "unsupportedRequest":
        // 明确拒绝，避免插件侧请求悬挂。
        this.send(encodeError(event.id, METHOD_NOT_FOUND, `unsupported by ${CLIENT_NAME}: ${event.method}`));
        return;
      case "ignored":
        return;
    }
  }

  private scheduleReconnect(): void {
    if (!this.running || this.timer) return;
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, MIN_RECONNECT_DELAY_MS * 2 ** this.attempts);
    this.attempts += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.dial();
    }, delay);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private send(payload: string): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(payload);
    } catch {
      /* 发送失败由 close 事件统一处理 */
    }
  }
}
