/**
 * IDE 选区的系统提示词：解释 `<ide_selection>` 块的来源与使用边界。
 *
 * 走 Pi 的 `systemPromptOptions.sections` 通道，而不是返回整段 `systemPrompt`：Pi 只对
 * 变化的 section 增量下发补丁，固定文本在一个会话里随首个请求发送一次即不再变动，
 * 不破坏 provider 的 prompt cache（返回 `systemPrompt` 会转成 forceSystemPrompt，整段替换、
 * 每次变更都是缓存未命中）。
 *
 * 文案要点与 `selection.ts:prepareSelectionMessage` 的注入格式配套：选区**可能相关也可能无
 * 关**（用户随手选中、忘记取消、甚至误选），因此相关性由用户问题判定，不由选区自证。
 */

/**
 * section 键名，同时是渲染出的标签名。Pi 要求匹配 `/^[a-z][a-z0-9_-]*$/` 且不得为
 * `preamble`，否则构建提示词时抛错；取 `ide_context` 而非 `ide_selection`，避免与数据块
 * 同名让模型把「说明」误读成「此处有一段选区」。
 */
export const IDE_CONTEXT_SECTION = "ide_context";

/** 纯正文，Pi 会自动包裹为 `<ide_context>…</ide_context>`，此处不要再加标签。 */
export const IDE_CONTEXT_PROMPT = `用户在 IDE 编辑器里选中的代码，会由 ide 扩展注入为 <ide_selection> 块，作为独立上下文消息随当前用户问题提供。

- 该块携带编辑器内存中的当前内容，可能包含尚未保存到磁盘的改动，与磁盘文件不一定一致。
- 选区只代表「用户此刻在编辑器里选中了什么」，与当前问题的相关性不确定：可能是刻意提供的上下文，也可能是随手选中、忘记取消，甚至是误选。
- 相关性以用户问题为准。判定无关时直接忽略，不要提及或解释这段代码，更不要因为存在选区就假定用户想改动它。
- 判定相关时把它当作定位线索与阅读范围；据此编辑或下结论前，先用 read 读取该文件对应行核对磁盘现状，不要把选区文本当作唯一依据。
- 选区只对一起提供的那一条用户问题有效；后续消息没有新的选区块，只说明用户没有重新选中，不代表想法变了。`;
