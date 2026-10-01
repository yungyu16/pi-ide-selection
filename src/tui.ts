import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";

/**
 * 从左侧截断（丢头部、保留尾部）。扩展状态行的尾部通常是文件名、行范围、
 * 计数等识别信息，右截断会把它们挤掉。
 * 输入为纯文本（着色在截断后做），逐码点保留避免切断宽字符/代理对。
 */
export function truncateKeepTail(text: string, maxWidth: number, ellipsis = "…"): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(ellipsis) > maxWidth) return truncateToWidth(ellipsis, maxWidth, "");
  if (visibleWidth(text) <= maxWidth) return text;
  const budget = Math.max(0, maxWidth - visibleWidth(ellipsis));
  const chars = [...text];
  let kept = "";
  let width = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const cw = visibleWidth(chars[i]!);
    if (width + cw > budget) break;
    kept = chars[i]! + kept;
    width += cw;
  }
  return ellipsis + kept;
}
