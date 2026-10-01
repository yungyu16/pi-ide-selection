/** 界面突出文件名、行号与代码；模型仍收到 XML 正文。 */
import { getLanguageFromPath, highlightCode, type MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Box, Spacer, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { truncateKeepTail } from "./tui.ts";
import type { SelectionMessageDetails, SelectionState } from "./selection.ts";

/** 旧会话没有 details，回退到 Pi 默认渲染器，避免解析代码中的 XML 标签。 */
function selectionDetails(value: unknown): SelectionMessageDetails | undefined {
  if (!value || typeof value !== "object") return;
  const selection = value as Partial<SelectionState>;
  if (typeof selection.filePath !== "string" || typeof selection.text !== "string"
    || typeof selection.startLine !== "number" || typeof selection.endLine !== "number") return;
  const displayPath = (value as Partial<SelectionMessageDetails>).displayPath;
  return { ...selection as SelectionState, displayPath: typeof displayPath === "string" ? displayPath : selection.filePath };
}

/** 长选区跳过语法高亮，避免组件重建时反复解析大段代码。 */
const HIGHLIGHT_MAX_LINES = 80;
const HIGHLIGHT_MAX_CHARS = 8_192;

export function renderSelectionCode(text: string, filePath: string): string {
  if (text.length > HIGHLIGHT_MAX_CHARS || text.split("\n").length > HIGHLIGHT_MAX_LINES) return text;
  return highlightCode(text, getLanguageFromPath(filePath)).join("\n");
}

export const renderSelectionMessage: MessageRenderer = (message, options, theme) => {
  const selection = selectionDetails(message.details);
  if (!selection) return undefined;
  const range = selection.startLine === selection.endLine
    ? `${selection.startLine}` : `${selection.startLine}-${selection.endLine}`;
  const location = `${selection.displayPath}:${range}`;
  const box = new Box(options.outputPad, 1, (text) => theme.bg("customMessageBg", text));
  // 单行内尽量展示路径；过长时从左侧省略，优先保留文件名和行号。
  box.addChild({
    render(width) {
      const prefix = "IDE 选区 · ";
      const budget = Math.max(0, width - visibleWidth(prefix));
      const tail = truncateKeepTail(location, budget);
      return [theme.fg("customMessageLabel", theme.bold(truncateToWidth(`${prefix}${tail}`, width)))];
    },
    invalidate() {},
  });
  box.addChild(new Spacer(1));
  // 用代码高亮而非 Markdown，保留注释、围栏、分隔线和 XML 的字面内容。
  box.addChild(new Text(renderSelectionCode(selection.text, selection.filePath), 0, 0));
  return box;
};
