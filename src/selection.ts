/**
 * 选区领域模型与呈现：如何给人看、如何给模型看。
 *
 * 不做协议解析（见 `protocol.ts`）、不碰传输（见 `client.ts`）、不依赖 Pi API。
 */

/** 归一化后的选区。行号为 1-based，`endLine` 为闭合行（含）。 */
export interface SelectionState {
  filePath: string;
  startLine: number;
  endLine: number;
  text: string;
}

/** 消息界面数据，text 是与模型正文一致的截断后文本。 */
export interface SelectionMessageDetails extends SelectionState {
  displayPath: string;
}

export interface SelectionLimits {
  /** 注入文本最大行数。 */
  maxLines: number;
  /** 注入文本最大字符数。 */
  maxChars: number;
}

/** token 护栏：超出的选区不整段塞进 prompt，模型可用 read 工具续读。 */
export const DEFAULT_LIMITS: SelectionLimits = { maxLines: 400, maxChars: 32_768 };

/**
 * 用户是否已经把同一段选区手写进输入（例如自己粘贴过）。
 * 命中则跳过注入，避免同一内容出现两次。
 */
export function alreadyContains(text: string, selection: SelectionState): boolean {
  const needle = selection.text.trim();
  return needle.length > 0 && text.includes(needle);
}

/** footer 选区摘要，如 `src/client.ts:120-131 · 12 行`。 */
export function describeSelection(selection: SelectionState, cwd: string): string {
  const range =
    selection.startLine === selection.endLine
      ? `${selection.startLine}`
      : `${selection.startLine}-${selection.endLine}`;
  const lineCount = Math.max(1, selection.endLine - selection.startLine + 1);
  return `${relativePath(selection.filePath, cwd)}:${range} · ${lineCount} 行`;
}

/** 模型正文与界面数据共用同一次截断，details 不参与模型上下文。 */
export function prepareSelectionMessage(
  selection: SelectionState,
  limits: SelectionLimits = DEFAULT_LIMITS,
  cwd = "",
): { content: string; details: SelectionMessageDetails } {
  const header = `<ide_selection file="${selection.filePath}" lines="${selection.startLine}-${selection.endLine}">`;
  const footer = "</ide_selection>";

  const sourceLines = selection.text.split("\n");
  let bodyLines = sourceLines;
  let truncated = false;

  if (sourceLines.length > limits.maxLines) {
    bodyLines = sourceLines.slice(0, limits.maxLines);
    truncated = true;
  }

  let body = bodyLines.join("\n");
  if (body.length > limits.maxChars) {
    body = body.slice(0, limits.maxChars);
    truncated = true;
  }

  const marker = truncated
    ? `\n… (选区共 ${sourceLines.length} 行，已按 ${limits.maxLines} 行 / ${limits.maxChars} 字符截断，完整内容请用 read 工具读取该文件)`
    : "";

  return {
    content: `${header}\n${body}${marker}\n${footer}`,
    details: { ...selection, text: `${body}${marker}`, displayPath: relativePath(selection.filePath, cwd) },
  };
}

/** 相对 cwd，其次相对 HOME，都不满足时保留绝对路径。 */
function relativePath(filePath: string, cwd: string): string {
  if (!filePath.startsWith("/")) return filePath;
  const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  if (filePath.startsWith(prefix)) return filePath.slice(prefix.length);
  const home = process.env.HOME?.endsWith("/") ? process.env.HOME : `${process.env.HOME}/`;
  if (home && home !== "/" && filePath.startsWith(home)) return `~/${filePath.slice(home.length)}`;
  return filePath;
}
