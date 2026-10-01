/**
 * 会话状态机：连接状态 + 待注入选区的生命周期。
 *
 * 不依赖 Pi API 和 WebSocket，只描述"发生了什么、现在该显示什么、该注入什么"，
 * 因此可以脱离 IDE 与 pi 直接单测。
 *
 * 触发语义是「自动跟随 + 一次性消费」：
 * - 选区到达即武装；
 * - `take()` 取出后立刻解除武装，直到下一次真正的选区推送才重新武装。
 *   这样避免自动跟随最大的缺陷 —— 同一段选区被重复附加到后续每条消息。
 */

import type { ConnectionState } from "./client.ts";
import { describeSelection, type SelectionState } from "./selection.ts";

export interface IDESnapshot {
  /** footer 状态；undefined 表示不占用状态位。由 footer 渲染方决定展示形式。 */
  statusText: string | undefined;
  /** `/ide status` 的多行详情。 */
  details: string[];
}

export class IDEState {
  private connection: ConnectionState = { status: "unavailable" };
  private selection: SelectionState | null = null;
  private armed = false;
  private enabled: boolean;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** 开关切换都重置易失状态：关闭后重新开启时，旧的异常状态（如“已关闭”）不应残留到 footer。 */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.selection = null;
    this.armed = false;
    this.connection = enabled ? { status: "unavailable" } : { status: "unavailable", detail: "已关闭" };
  }

  setConnection(state: ConnectionState): void {
    this.connection = state;
    if (state.status !== "connected") {
      // 断开后旧选区不再可信：它对应的是断开前的编辑器状态。
      this.selection = null;
      this.armed = false;
    }
  }

  /**
   * 消费一条选区推送。null（取消选择、光标移动等空推送）解除武装。
   * @returns 是否真的发生变化，调用方据此决定是否重绘。
   */
  applySelection(selection: SelectionState | null): boolean {
    if (selection === null) {
      if (!this.armed && this.selection === null) return false;
      this.selection = null;
      this.armed = false;
      return true;
    }
    this.selection = selection;
    this.armed = true;
    return true;
  }

  /** 丢弃待注入选区（`/ide clear`）。 */
  clearSelection(): void {
    this.selection = null;
    this.armed = false;
  }

  /**
   * 取出本轮该注入的选区并解除武装；未启用、未武装时返回 null。
   * 取出即消费，即使调用方随后因为去重而放弃注入，也不会再用于下一条消息。
   */
  take(): SelectionState | null {
    if (!this.enabled || !this.armed || !this.selection) return null;
    const selection = this.selection;
    this.selection = null;
    this.armed = false;
    return selection;
  }

  snapshot(cwd: string): IDESnapshot {
    const details = [
      `cwd: ${cwd}`,
      `启用: ${this.enabled ? "on" : "off"}（启动时禁用：--no-ide-selection 或 PI_IDE_SELECTION=0）`,
    ];

    if (!this.enabled) {
      return { statusText: undefined, details };
    }

    if (this.connection.status === "connected") {
      details.push(
        `连接: ${this.connection.ideName ?? "IDE"} 插件 ${this.connection.serverVersion ?? "?"} · 端口 ${this.connection.port ?? "?"}`,
      );
    } else if (this.connection.status === "retrying") {
      details.push(`连接: 重连中（${this.connection.detail ?? ""}）`);
    } else {
      details.push(`连接: ${this.connection.detail ?? "未连接"}`);
    }

    // 选区摘要只算一次，同时供 footer 提示与 /ide status 详情使用。
    const pending = this.armed && this.selection ? describeSelection(this.selection, cwd) : undefined;
    details.push(`待注入: ${pending ?? "无"}`);

    return { statusText: this.footerText(pending), details };
  }

  /**
   * footer 状态文本：有选区时提示选区，其余情况只在“该管”的连接故障上占位。
   *
   * 未发现匹配插件（`missing`）是在 IDE 外跑 pi 的常态，不是故障，因此不占 footer，
   * 只在 `/ide status` 的详情里体现；重连中（`retrying`）与连接错误（`unavailable`
   * 带 detail）仍占位，否则“连过但断了”这类需要处理的情况会静默。
   */
  private footerText(pending: string | undefined): string | undefined {
    if (pending) return `⧉ ${pending}`;
    if (this.connection.status === "connected" || this.connection.status === "missing") return undefined;
    return this.connection.detail ? `IDE ✗ ${this.connection.detail}` : undefined;
  }
}
