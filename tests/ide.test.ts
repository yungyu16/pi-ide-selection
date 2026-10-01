/**
 * `ide` 扩展纯逻辑测试：协议解码、lock 选路、注入格式、状态机。
 *
 * fixture 来自本机实测抓到的报文（JetBrains 插件 0.1.14-beta）。不依赖真实 IDE
 * 插件；测试覆盖 WebSocket 主动关闭与 Pi 输入装配，界面效果仍需 `/reload` 人工验证。
 * 运行：`npm test`
 */

import assert from "node:assert/strict";
import test from "node:test";
import { pickLock, type LockInfo } from "../src/lock.ts";
import {
  decodeServerMessage,
  parseSelectionChanged,
  encodeInitialize,
  encodeResult,
} from "../src/protocol.ts";
import {
  alreadyContains,
  describeSelection,
  prepareSelectionMessage,
} from "../src/selection.ts";
import { IDEState } from "../src/state.ts";
import type { SelectionState } from "../src/selection.ts";

const sel = (overrides: Partial<SelectionState> = {}): SelectionState => ({
  filePath: "/Users/example/projects/demo/a.ts",
  startLine: 10,
  endLine: 12,
  text: "line1\nline2\nline3",
  ...overrides,
});

const lock = (overrides: Partial<LockInfo>): LockInfo => ({
  port: 1,
  workspaceFolders: [],
  ...overrides,
});

test("协议：实测载荷归一化（0-based、end 排他）", () => {
  assert.deepEqual(parseSelectionChanged({
    selection: { start: { line: 28, character: 0 }, end: { line: 29, character: 0 } },
    text: "hello\n",
    filePath: "/Users/example/config/agent/README.md",
  }), {
    filePath: "/Users/example/config/agent/README.md",
    startLine: 29,
    endLine: 29,
    text: "hello\n",
  });
});

test("协议：end 落在行首时该行不计入范围，跨行选区正常", () => {
  assert.deepEqual(parseSelectionChanged({
    selection: { start: { line: 9, character: 4 }, end: { line: 12, character: 7 } },
    text: "a\nb\nc",
    filePath: "/x/y.ts",
  }), { filePath: "/x/y.ts", startLine: 10, endLine: 13, text: "a\nb\nc" });
});

for (const [name, params] of [
  ["光标移动（无 text）", { selection: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, filePath: "/x" }],
  ["纯空白 text", { selection: { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } }, text: "  \n\t", filePath: "/x" }],
  ["取消选择", { selection: {} }],
  ["缺 filePath", { selection: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } }, text: "abc" }],
  ["行号为负", { selection: { start: { line: -1, character: 0 }, end: { line: 1, character: 0 } }, text: "abc", filePath: "/x" }],
  ["params 不是对象", "nope"],
] as const) {
  test(`协议：过滤噪音推送（${name}）`, () => {
    assert.equal(parseSelectionChanged(params), null);
  });
}

test("协议：ping 请求必须能被识别以便应答", () => {
  const event = decodeServerMessage('{"jsonrpc":"2.0","id":39,"method":"ping","params":{"method":"ping"}}');
  assert.deepEqual(event, { type: "ping", id: 39 });
});

test("协议：initialize 回包提取 serverInfo", () => {
  const event = decodeServerMessage(
    '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","serverInfo":{"name":"Claude Code JetBrains Plugin","version":"0.1.14-beta"}}}',
  );
  assert.deepEqual(event, { type: "serverInfo", name: "Claude Code JetBrains Plugin", version: "0.1.14-beta" });
});

test("协议：selection_changed 通知与空载荷清空", () => {
  assert.deepEqual(
    decodeServerMessage('{"jsonrpc":"2.0","method":"selection_changed","params":{"selection":{"start":{"line":0,"character":0},"end":{"line":1,"character":0}},"text":"ab\\n","filePath":"/x/a.ts"}}'),
    { type: "selection", selection: { filePath: "/x/a.ts", startLine: 1, endLine: 1, text: "ab\n" } },
  );
  assert.deepEqual(
    decodeServerMessage('{"jsonrpc":"2.0","method":"selection_changed","params":{}}'),
    { type: "selection", selection: null },
  );
});

test("协议：未知请求报 METHOD_NOT_FOUND，坏 JSON 与无关通知静默忽略", () => {
  assert.equal(decodeServerMessage('{"jsonrpc":"2.0","id":7,"method":"sampling/createMessage","params":{}}').type, "unsupportedRequest");
  assert.equal(decodeServerMessage("not-json").type, "ignored");
  assert.equal(
    decodeServerMessage('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":39}}').type,
    "ignored",
  );
});

test("协议：编码器产出合法 JSON-RPC 帧", () => {
  assert.equal(encodeInitialize(1), '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"pi-ide","version":"1.0.0"}}}');
  assert.equal(encodeResult(39, {}), '{"jsonrpc":"2.0","id":39,"result":{}}');
});

test("lock：命中覆盖 cwd 的 lock，多候选取最长匹配", () => {
  const locks = [
    lock({ port: 1, transport: "ws", authToken: "t", workspaceFolders: ["/Users/example/projects/demo"] }),
    lock({ port: 2, transport: "ws", authToken: "t", workspaceFolders: ["/Users/example/projects/notes"] }),
  ];
  assert.equal(pickLock(locks, "/Users/example/projects/demo")?.port, 1);

  const nested = [
    lock({ port: 5, transport: "ws", authToken: "t", workspaceFolders: ["/a"] }),
    lock({ port: 9, transport: "ws", authToken: "t", workspaceFolders: ["/a/b"] }),
  ];
  assert.equal(pickLock(nested, "/a/b/c")?.port, 9);
});

test("lock：匹配不到时返回 null，绝不乱连别的项目", () => {
  const locks = [lock({ port: 1, transport: "ws", authToken: "t", workspaceFolders: ["/x"] })];
  assert.equal(pickLock(locks, "/tmp/other"), null);
});

test("lock：拒绝非 ws 传输 / 缺 token / 死进程", () => {
  assert.equal(pickLock([lock({ transport: "sse", authToken: "t", workspaceFolders: ["/a"] })], "/a"), null);
  assert.equal(pickLock([lock({ transport: "ws", workspaceFolders: ["/a"] })], "/a"), null);
  assert.equal(
    pickLock([lock({ transport: "ws", authToken: "t", pid: 999_999_999, workspaceFolders: ["/a"] })], "/a"),
    null,
  );
});

test("注入：块格式保留绝对路径与行范围", () => {
  assert.equal(
    prepareSelectionMessage(sel()).content,
    '<ide_selection file="/Users/example/projects/demo/a.ts" lines="10-12">\nline1\nline2\nline3\n</ide_selection>',
  );
});

test("注入：超出行数上限时截断并留提示", () => {
  const big = sel({ text: Array.from({ length: 500 }, (_, i) => `L${i}`).join("\n") });
  const block = prepareSelectionMessage(big, { maxLines: 400, maxChars: 32_768 }).content;
  assert.equal(block.split("\n").length, 403); // header + 400 行 + 提示 + footer
  assert.equal(block.split("\n").filter((l) => /^L\d+$/.test(l)).length, 400);
  assert.match(block, /已按 400 行/);
});

test("注入：超出字符上限时按字符截断", () => {
  const wide = sel({ text: "x".repeat(50_000) });
  const block = prepareSelectionMessage(wide, { maxLines: 400, maxChars: 1_000 }).content;
  assert.ok(block.includes("x".repeat(1_000)));
  assert.ok(!block.includes("x".repeat(1_001)));
});

test("注入：用户文本已含选区时跳过（去重）", () => {
  assert.equal(alreadyContains("看下这段：\nline1\nline2\nline3", sel()), true);
  assert.equal(alreadyContains("完全无关的内容", sel()), false);
});

test("摘要：相对 cwd 显示", () => {
  assert.equal(
    describeSelection(sel({ startLine: 3, endLine: 3, text: "q\nw" }), "/Users/example/projects/demo"),
    "a.ts:3 · 1 行",
  );
});

test("摘要：单行选区带结尾换行时仍显示 1 行", () => {
  assert.equal(
    describeSelection(
      sel({ startLine: 18, endLine: 18, text: "这是单行内容\\n" }),
      "/Users/example/projects/demo",
    ),
    "a.ts:18 · 1 行",
  );
});

test("状态机：有选区时 statusText 输出 ⧉ 提示", () => {
  const state = new IDEState(true);
  state.setConnection({ status: "connected", ideName: "IntelliJ IDEA", serverVersion: "0.1.14", port: 59546 });
  state.applySelection(sel());
  const view = state.snapshot("/Users/example/projects/demo");
  assert.equal(view.statusText, "⧉ a.ts:10-12 · 3 行");
  assert.ok(view.details.some((l) => l.startsWith("连接: IntelliJ IDEA 插件 0.1.14")));
  assert.ok(view.details.some((l) => l.startsWith("待注入: a.ts:10-12")));
});

test("状态机：连接正常但无选区时 footer 不占位", () => {
  const state = new IDEState(true);
  state.setConnection({ status: "connected", ideName: "IntelliJ IDEA", serverVersion: "0.1.14", port: 59546 });
  const view = state.snapshot("/Users/example/projects/demo");
  assert.equal(view.statusText, undefined);
});

test("状态机：未发现匹配插件不占 footer，只在 /ide status 详情里体现", () => {
  const state = new IDEState(true);
  state.setConnection({ status: "missing", detail: "未发现匹配当前目录的 IDE 插件" });
  const view = state.snapshot("/Users/example/config");
  assert.equal(view.statusText, undefined);
  assert.ok(view.details.includes("连接: 未发现匹配当前目录的 IDE 插件"));
});

test("状态机：重连中仍占 footer", () => {
  const state = new IDEState(true);
  state.setConnection({ status: "retrying", detail: "连接已断开，重连中" });
  assert.equal(state.snapshot("/any").statusText, "IDE ✗ 连接已断开，重连中");
});

test("状态机：连接错误（已选到端口但连不上）仍占 footer", () => {
  const state = new IDEState(true);
  state.setConnection({ status: "unavailable", ideName: "IntelliJ IDEA", port: 59546, detail: "connect ECONNREFUSED" });
  assert.equal(state.snapshot("/any").statusText, "IDE ✗ connect ECONNREFUSED");
});

test("状态机：武装一次，消费一次", () => {
  const state = new IDEState(true);
  assert.equal(state.applySelection(sel()), true);
  assert.deepEqual(state.take(), sel());
  assert.equal(state.take(), null);
});

test("状态机：空推送解除武装，重复空推送不触发重绘", () => {
  const state = new IDEState(true);
  state.applySelection(sel());
  assert.equal(state.applySelection(null), true);
  assert.equal(state.applySelection(null), false);
  assert.equal(state.take(), null);
});

test("状态机：连接断开清空待注入选区", () => {
  const state = new IDEState(true);
  state.setConnection({ status: "connected", ideName: "IntelliJ IDEA", serverVersion: "0.1.14", port: 59546 });
  state.applySelection(sel());
  state.setConnection({ status: "retrying", detail: "连接已断开，重连中" });
  assert.equal(state.take(), null);
});

test("状态机：关闭后不注入也不展示，take 返回 null", () => {
  const state = new IDEState(true);
  state.applySelection(sel());
  state.setEnabled(false);
  assert.equal(state.take(), null);
  const view = state.snapshot("/any");
  assert.equal(view.statusText, undefined);
});

test("状态机：重新开启不残留“已关闭”异常提示", () => {
  const state = new IDEState(true);
  state.setEnabled(false);
  state.setEnabled(true);
  // 新连接事件到达前，footer 不应闪现 IDE ✗ 已关闭。
  assert.equal(state.snapshot("/any").statusText, undefined);
});

test("状态行：扩展提示左截断保留尾部识别信息", async () => {
  const { truncateKeepTail } = await import("../src/tui.ts");
  const text = "⧉ demo-server/demo-support/src/main/java/com/example/demo/server/support/Foo.java:120-131 · 12 行";

  // 放得下时原样返回。
  assert.equal(truncateKeepTail(text, 200), text);

  // 放不下时丢头部、保留尾部（文件名、行范围、计数可见）。
  const narrow = truncateKeepTail(text, 40);
  assert.ok(narrow.startsWith("…"));
  assert.ok(narrow.endsWith("12 行"));
  assert.ok(narrow.includes("Foo.java:120-131"));
  assert.ok(narrow.length <= 40);
});

test("提示词 section：键名符合 Pi 的校验规则，否则 Pi 构建提示词时抛错", async () => {
  const { IDE_CONTEXT_SECTION } = await import("../src/prompt.ts");
  assert.match(IDE_CONTEXT_SECTION, /^[a-z][a-z0-9_-]*$/);
  assert.notEqual(IDE_CONTEXT_SECTION, "preamble");
});

test("提示词 section：说明选区可能无关或误选，且不自行包裹标签", async () => {
  const { IDE_CONTEXT_PROMPT, IDE_CONTEXT_SECTION } = await import("../src/prompt.ts");

  // 必须点名注入格式，否则模型无法把说明与消息里的块对应起来。
  assert.ok(IDE_CONTEXT_PROMPT.includes("<ide_selection>"));
  // 核心语义：相关性不确定，可能是误选。
  assert.match(IDE_CONTEXT_PROMPT, /相关/);
  assert.ok(IDE_CONTEXT_PROMPT.includes("误选"));
  // 选区来自内存，需要 read 复核磁盘现状。
  assert.ok(IDE_CONTEXT_PROMPT.includes("read"));

  // Pi 会自动包 <section> 标签，正文自带同名标签会被误解为「存在一段选区」。
  assert.ok(!IDE_CONTEXT_PROMPT.includes(`<${IDE_CONTEXT_SECTION}>`));
});

test("装配：选区作为可见独立消息发送，保留 XML，匹配空闲与生成中的输入队列", async (t) => {
  const { default: ide } = await import("../src/index.ts");
  const { convertToLlm } = await import("@earendil-works/pi-coding-agent");
  type API = import("@earendil-works/pi-coding-agent").ExtensionAPI;
  type Context = import("@earendil-works/pi-coding-agent").ExtensionContext;
  type Input = import("@earendil-works/pi-coding-agent").InputEvent;
  type Result = import("@earendil-works/pi-coding-agent").InputEventResult;
  let input!: (event: Input, ctx: Context) => Result;
  const sent: Array<{ message: Parameters<API["sendMessage"]>[0]; options: Parameters<API["sendMessage"]>[1] }> = [];
  const api = {
    on(name: string, handler: typeof input) { if (name === "input") input = handler; },
    registerMessageRenderer() {},
    registerFlag() {},
    registerCommand() {},
    sendMessage(message: Parameters<API["sendMessage"]>[0], options: Parameters<API["sendMessage"]>[1]) {
      sent.push({ message, options });
    },
  } as unknown as API;
  // 用真实状态机消费选区，只替换连接外部 IDE 的装配边界。
  const state = new IDEState(true);
  const originalTake = IDEState.prototype.take;
  const take = t.mock.method(IDEState.prototype, "take", () => originalTake.call(state));
  ide(api);
  const ctx = { hasUI: false, cwd: "/Users/example/projects/demo" } as Context;

  for (const streamingBehavior of [undefined, "steer", "followUp"] as const) {
    state.applySelection(sel());
    const event: Input = { type: "input", source: "interactive", text: "解释一下", streamingBehavior };
    assert.deepEqual(input(event, ctx), { action: "continue" });
    const { message, options } = sent.at(-1)!;
    assert.deepEqual(message, { customType: "ide_selection", ...prepareSelectionMessage(sel(), undefined, ctx.cwd), display: true });
    assert.deepEqual(options, streamingBehavior ? { deliverAs: streamingBehavior } : { triggerTurn: false });
    const llm = convertToLlm([{ ...message, role: "custom", timestamp: 0 }]);
    assert.equal(llm[0].role, "user");
    assert.deepEqual(llm[0].content, [{ type: "text", text: prepareSelectionMessage(sel()).content }]);
    input(event, ctx);
  }
  assert.equal(sent.length, 3); // 一次性消费，第二次输入不重复发送。

  state.applySelection(sel());
  const calls = take.mock.callCount();
  input({ type: "input", source: "extension", text: "扩展输入" }, ctx);
  assert.equal(take.mock.callCount(), calls); // 扩展输入不消费选区。
  input({ type: "input", source: "interactive", text: sel().text }, ctx);
  input({ type: "input", source: "interactive", text: "下一条" }, ctx);
  assert.equal(sent.length, 3); // 用户已粘贴时跳过，并消费待注入选区。
});


test("选区视图：标题合并路径与行号，正文按代码显示，截断与模型保持一致", async () => {
  const { initTheme, Theme } = await import("@earendil-works/pi-coding-agent");
  const { renderSelectionMessage } = await import("../src/render.ts");
  const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
  initTheme("dark");
  const theme = { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: (text: string) => text } as unknown as InstanceType<typeof Theme>;
  const selection = sel({ startLine: 22, endLine: 22, text: " * 注释\n----\n```\n</ide_selection>" });
  const prepared = prepareSelectionMessage(selection, undefined, "/Users/example/projects/demo");
  const message = { ...prepared, customType: "ide_selection", display: true, role: "custom" as const, timestamp: 0 };
  const component = renderSelectionMessage(message, { expanded: false, outputPad: 1 }, theme)!;
  const lines = component.render(100).map(stripAnsi);
  assert.ok(lines.some((line) => line.trim() === "IDE 选区 · a.ts:22"));
  assert.ok(!lines.some((line) => line.includes("/Users/example")));
  assert.ok(lines.some((line) => line.trim() === "----"));
  assert.ok(lines.some((line) => line.trim() === "```"));
  assert.ok(lines.some((line) => line.trim() === "</ide_selection>")); // 选中代码中的标签仍显示。
  const clipped = prepareSelectionMessage(sel({ text: "a\nb\nc" }), { maxLines: 2, maxChars: 100 });
  assert.ok(!clipped.details.text.includes("\nc"));
  assert.ok(clipped.details.text.includes("已按 2 行"));
  assert.ok(clipped.content.includes(clipped.details.text));
  const longPath = prepareSelectionMessage(sel({ filePath: "/project/src/very-long-directory/EchoService.java", startLine: 22, endLine: 22 }), undefined, "/project");
  const pathComponent = renderSelectionMessage({ ...message, ...longPath }, { expanded: false, outputPad: 1 }, theme)!;
  assert.ok(pathComponent.render(100).map(stripAnsi).some((line) => line.includes("src/very-long-directory/EchoService.java:22")));
  assert.ok(pathComponent.render(40).map(stripAnsi).some((line) => line.includes("…") && line.includes("EchoService.java:22")));
  const narrow = component.render(15).map(stripAnsi);
  assert.equal(narrow.filter((line) => line.includes("IDE 选区")).length, 1);
  assert.equal(renderSelectionMessage({ ...message, details: undefined }, { expanded: false, outputPad: 1 }, theme), undefined);
});


test("选区视图：长选区保留纯文本，尊重 Pi 左右间距", async () => {
  const { initTheme, Theme } = await import("@earendil-works/pi-coding-agent");
  const { renderSelectionCode, renderSelectionMessage } = await import("../src/render.ts");
  initTheme("dark");
  const longLines = Array.from({ length: 81 }, () => "const value = 1;").join("\n");
  const longText = "x".repeat(8_193);
  assert.equal(renderSelectionCode(longLines, "a.ts"), longLines);
  assert.equal(renderSelectionCode(longText, "a.ts"), longText);
  assert.ok(renderSelectionCode("const value = 1;", "a.ts").includes("\x1b["));
  const theme = { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: (text: string) => text } as unknown as InstanceType<typeof Theme>;
  const message = { ...prepareSelectionMessage(sel()), customType: "ide_selection", role: "custom" as const, display: true, timestamp: 0 };
  const component = renderSelectionMessage(message, { expanded: false, outputPad: 3 }, theme)!;
  assert.ok(component.render(100).some((line) => line.startsWith("   IDE 选区")));
});


test("IDE 关闭：握手尚未完成时主动关闭，不留下未处理的 WebSocket 错误", async () => {
  const { IDEClient } = await import("../src/client.ts");
  const { WebSocket } = await import("ws");
  const socket = new WebSocket("ws://127.0.0.1:9");
  const client = new IDEClient("/tmp", { onSelection() {}, onConnection() {} });
  // 直接构造握手中的连接，不依赖真实 IDE lock、插件或监听端口。
  (client as unknown as { socket: InstanceType<typeof WebSocket> }).socket = socket;
  client.stop();
  // 主动关闭异步完成，等待 ws 发出 close。
  await new Promise<void>((resolve) => socket.once("close", () => resolve()));
});

test("IDE 关闭：扫描中的 dial 在停止后不再发出状态回调", async () => {
  const { IDEClient } = await import("../src/client.ts");
  const connections: unknown[] = [];
  const client = new IDEClient("/private/tmp/pi-ide-selection-no-project", { onSelection() {}, onConnection(state) { connections.push(state); } });
  const scanning = (client as unknown as { dial(): Promise<void> }).dial();
  client.stop();
  await scanning;
  assert.deepEqual(connections, []);
});
