/**
 * 与 Claude Code IDE 插件之间的 JSON-RPC 报文编解码（纯函数，无 IO）。
 *
 * 这一层集中存放所有未公开协议知识，插件升级导致协议变化时只需要改这里。实测要点：
 * - 握手只支持标准 `initialize`；服务端**不认识** `notifications/initialized`
 *   （发过去返回 -32601），因此不要发送。
 * - 插件每约 5s 主动发 `ping` 请求，必须回 `result: {}`，否则约 3s 后它会用
 *   `notifications/cancelled` 清理该请求，长连接不稳。
 * - 选区没有对应 tool，只能靠 `selection_changed` 通知获得，且 `initialize` 之后
 *   就会开始推送（含切换标签页、光标移动）。
 * - 行号 0-based、`end` 排他；VS Code 侧多 `fileUrl` 和 `selection.isEmpty` 字段，
 *   JetBrains 侧没有，全部按 optional 处理。
 *
 * 所有解码失败都降级为「无事件」，不抛错。
 */

import type { SelectionState } from "./selection.ts";

/** 与 JetBrains 插件 0.1.14-beta 对齐的协商版本。 */
const PROTOCOL_VERSION = "2024-11-05";
/** 未实现方法的 JSON-RPC 标准错误码。 */
export const METHOD_NOT_FOUND = -32601;

export type RequestId = number | string;

/** JSON-RPC 请求 id；插件侧实际只用数字，字符串一并容忍。非此形态无法回包。 */
function isRequestId(value: unknown): value is RequestId {
  return typeof value === "number" || typeof value === "string";
}

/** 选区变化通知，null 表示选区被清空（取消选择/关闭编辑器）。 */
export interface SelectionEvent {
  type: "selection";
  selection: SelectionState | null;
}
/** initialize 成功回包，携带用于诊断和能力探测的 serverInfo。 */
export interface ServerInfoEvent {
  type: "serverInfo";
  name: string;
  version: string;
}
/** 插件心跳，必须应答。 */
export interface PingEvent {
  type: "ping";
  id: RequestId;
}
/** 本机用不到的插件请求，回 METHOD_NOT_FOUND 以免悬挂。 */
export interface UnsupportedRequestEvent {
  type: "unsupportedRequest";
  id: RequestId;
  method: string;
}
/** 与选区无关或无法理解的报文：静默忽略。 */
export interface IgnoredEvent {
  type: "ignored";
  reason: "unknown" | "malformed";
}

export type ServerEvent =
  | SelectionEvent
  | ServerInfoEvent
  | PingEvent
  | UnsupportedRequestEvent
  | IgnoredEvent;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readPosition(value: unknown): { line: number; character: number } | null {
  const position = asRecord(value);
  if (!position) return null;
  if (typeof position.line !== "number" || !Number.isInteger(position.line) || position.line < 0) return null;
  if (typeof position.character !== "number" || !Number.isInteger(position.character) || position.character < 0) {
    return null;
  }
  return { line: position.line, character: position.character };
}

/**
 * 解析 `selection_changed` 载荷。
 *
 * 返回 null（等价于"清空选区"）的情况：
 * - 缺 filePath / selection / text，或 text 纯空白 —— 插件对纯光标移动也会推送，
 *   这类高频噪音必须在这里过滤，否则状态栏会一直闪；
 * - 字段类型不符 —— 协议未公开，宁可降级。
 *
 * 行号从 0-based 转成 1-based；`end` 排他，落在某行第 0 列时该行不计入范围。
 */
export function parseSelectionChanged(params: unknown): SelectionState | null {
  const payload = asRecord(params);
  if (!payload) return null;

  const filePath = payload.filePath;
  if (typeof filePath !== "string" || filePath.length === 0) return null;

  const text = payload.text;
  if (typeof text !== "string" || text.trim().length === 0) return null;

  const selection = asRecord(payload.selection);
  const start = readPosition(selection?.start);
  const end = readPosition(selection?.end);
  if (!start || !end) return null;

  const endLineZeroBased = end.character === 0 && end.line > start.line ? end.line - 1 : end.line;
  const startLine = start.line + 1;
  return {
    filePath,
    startLine,
    endLine: Math.max(startLine, endLineZeroBased + 1),
    text,
  };
}

/** 把一条原始报文解码成本机关心的事件；不认识的报文一律 `ignored`。 */
export function decodeServerMessage(raw: string): ServerEvent {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { type: "ignored", reason: "malformed" };
  }
  if (typeof message !== "object" || message === null) return { type: "ignored", reason: "malformed" };

  const { method, id, result } = message;

  // 响应：只有 initialize 回包有用（识别 serverInfo），其余响应忽略。
  if (typeof method !== "string") {
    const info = asRecord(asRecord(result)?.serverInfo);
    if (info && typeof info.name === "string") {
      return { type: "serverInfo", name: info.name, version: typeof info.version === "string" ? info.version : "?" };
    }
    return { type: "ignored", reason: "unknown" };
  }

  if (method === "selection_changed") {
    return { type: "selection", selection: parseSelectionChanged(message.params) };
  }
  // at_mentioned / diagnostics_changed 等通知 v1 不消费；无合法 id 的消息无法回包。
  if (!isRequestId(id)) return { type: "ignored", reason: "unknown" };

  if (method === "ping") return { type: "ping", id };
  return { type: "unsupportedRequest", id, method };
}

function frame(payload: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", ...payload });
}

function encodeRequest(id: RequestId, method: string, params: unknown): string {
  return frame({ id, method, params });
}

export function encodeResult(id: RequestId, result: unknown): string {
  return frame({ id, result });
}

export function encodeError(id: RequestId, code: number, message: string): string {
  return frame({ id, error: { code, message } });
}

/** initialize 参数：`clientInfo.name` 会出现在插件侧日志与 serverInfo 对照里。 */
export function encodeInitialize(id: RequestId, clientName = "pi-ide"): string {
  return encodeRequest(id, "initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: clientName, version: "1.0.0" },
  });
}
