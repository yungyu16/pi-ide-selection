/**
 * Pi 装配层：把 IDEClient（传输）与 IDEState（状态机）接到 Pi 的事件、命令与 UI 上。
 *
 * 本文件不包含业务决策 —— 「何时注入、何时显示」在 `state.ts`，「协议怎么讲」在
 * `protocol.ts`，「连哪个端口」在 `lock.ts`。
 *
 * 用法：在 IDE 里选中一段代码，切到 pi 直接提问；选区会作为可见的自定义消息（保留 <ide_selection> 块）
 * 随该条用户消息提供给模型，发送后自动清空，等待下一次选中。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { IDEClient } from "./client.ts";
import { IDE_CONTEXT_PROMPT, IDE_CONTEXT_SECTION } from "./prompt.ts";
import { renderSelectionMessage } from "./render.ts";
import { IDEState } from "./state.ts";
import { alreadyContains, prepareSelectionMessage } from "./selection.ts";

const STATUS_KEY = "ide";

export default function ide(pi: ExtensionAPI): void {
  pi.registerMessageRenderer("ide_selection", renderSelectionMessage);
  const state = new IDEState(process.env.PI_IDE_SELECTION !== "0");
  let client: IDEClient | null = null;

  /** 选区提示通过 setStatus 交给 footer 通道，由 footer 渲染方（statusline/默认 footer）展示。 */
  const render = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    const view = state.snapshot(ctx.cwd);
    ctx.ui.setStatus(STATUS_KEY, view.statusText);
  };

  const connect = (ctx: ExtensionContext): void => {
    if (client || !state.isEnabled()) return;
    client = new IDEClient(ctx.cwd, {
      onSelection: (selection) => {
        // 光标移动产生的空推送返回 false，跳过无谓重绘。
        if (state.applySelection(selection)) render(ctx);
      },
      onConnection: (connection) => {
        state.setConnection(connection);
        render(ctx);
      },
    });
    client.start();
    render(ctx);
  };

  pi.on("session_start", (_event, ctx) => {
    // flag 的解析在扩展加载后才可靠，因此在这里读而不是工厂执行期。
    if (pi.getFlag("no-ide-selection") === true) {
      state.setEnabled(false);
      return;
    }
    connect(ctx);
  });

  pi.on("input", (event, ctx) => {
    // 扩展自己注入的消息不再附加，避免套娃，也不能消费武装状态。
    if (event.source === "extension") return { action: "continue" };

    const selection = state.take();
    if (!selection) return { action: "continue" };

    // 取出即消费：去重放弃注入时也已解除武装，不会滞留到下一条消息。
    render(ctx);
    if (alreadyContains(event.text, selection)) return { action: "continue" };

    // 空闲时先追加选区但不触发运行，用户输入随后启动请求，保持「选区 → 问题」。
    // 生成中按相同顺序进入用户输入的队列；两条消息独立入队，非原子绑定。
    // one-at-a-time 或入队间被调度时可能单独处理选区，当前不修改宿主队列策略。
    pi.sendMessage(
      { customType: "ide_selection", ...prepareSelectionMessage(selection, undefined, ctx.cwd), display: true },
      event.streamingBehavior ? { deliverAs: event.streamingBehavior } : { triggerTurn: false },
    );
    return { action: "continue" };
  });

  pi.on("before_agent_start", (event) => {
    // 关闭注入时不贡献 section，避免为不可能出现的块占用提示词预算。
    if (!state.isEnabled()) return;
    event.systemPromptOptions.sections[IDE_CONTEXT_SECTION] = IDE_CONTEXT_PROMPT;
  });

  pi.on("session_shutdown", () => {
    client?.stop();
    client = null;
  });

  pi.registerFlag("no-ide-selection", {
    description: "禁用 IDE 选区注入（不连接 Claude Code IDE 插件）",
    type: "boolean",
    default: false,
  });

  pi.registerCommand("ide", {
    description: "IDE 选区注入：status | on | off | clear | reconnect",
    handler: async (args, ctx) => {
      const sub = (args ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "status";

      switch (sub) {
        case "on":
          state.setEnabled(true);
          connect(ctx);
          ctx.ui.notify("已开启 IDE 选区注入", "info");
          break;
        case "off":
          state.setEnabled(false);
          client?.stop();
          client = null;
          render(ctx);
          ctx.ui.notify("已关闭 IDE 选区注入（仅本次会话，重启后恢复）", "info");
          break;
        case "clear":
          state.clearSelection();
          render(ctx);
          ctx.ui.notify("已丢弃待注入的 IDE 选区", "info");
          break;
        case "reconnect":
          if (!state.isEnabled()) {
            ctx.ui.notify("当前已关闭，先执行 /ide on", "warning");
            break;
          }
          // IDE 重启会换端口，重连=重建客户端（dial 会重新扫 lock）。
          client?.stop();
          client = null;
          connect(ctx);
          ctx.ui.notify("正在重新连接 IDE 插件", "info");
          break;
        case "status":
        default: {
          // 提示词 section 挂载态靠状态命令自查，否则只能 dump 提示词才能确认。
          const promptState = state.isEnabled() ? `${IDE_CONTEXT_SECTION} 已挂载` : "未挂载（ide 已关闭）";
          ctx.ui.notify([...state.snapshot(ctx.cwd).details, `提示词: ${promptState}`].join("\n"), "info");
          break;
        }
      }
    },
  });
}
