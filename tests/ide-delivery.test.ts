/** 运行宿主的实际消息转换和队列；模型响应为本地桩，不请求外部 API。 */
import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Message, type Model } from "@earendil-works/pi-ai";
import { AgentSession, convertToLlm } from "@earendil-works/pi-coding-agent";

const model: Model<"openai-completions"> = {
  id: "test", name: "test", api: "openai-completions", provider: "test", baseUrl: "http://unused",
  reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const selection = { customType: "ide_selection", content: "选区正文", display: true };
const question = { role: "user" as const, content: [{ type: "text" as const, text: "对应问题" }], timestamp: 0 };

function recordingAgent(mode: "all" | "one-at-a-time" = "all") {
  const requests: Message[][] = [];
  const agent = new Agent({
    initialState: { model }, followUpMode: mode, convertToLlm,
    streamFn() {
      // 请求快照在下面包装一次，响应始终是无工具调用的最终回复。
      const stream = createAssistantMessageEventStream();
      const response: AssistantMessage = {
        role: "assistant", content: [{ type: "text", text: "完成" }], api: model.api, provider: model.provider, model: model.id,
        stopReason: "stop", timestamp: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message: response }); });
      return stream;
    },
  });
  const streamFn = agent.streamFunction;
  agent.streamFunction = (currentModel, context, options) => {
    requests.push([...context.messages]);
    return streamFn(currentModel, context, options);
  };
  return { agent, requests };
}

function fakeSession(agent: Agent) {
  return Object.assign(Object.create(AgentSession.prototype), {
    agent,
    sessionManager: { appendCustomMessageEntry() {} },
    _emit() {},
  }) as AgentSession;
}

function text(message: Message) {
  return message.role === "user" && Array.isArray(message.content)
    ? message.content.filter((part) => part.type === "text").map((part) => part.text).join("") : "";
}

test("宿主交付：空闲时选区先追加，不单独发起请求，随后问题与选区一起到达", async () => {
  const { agent, requests } = recordingAgent();
  await fakeSession(agent).sendCustomMessage(selection, { triggerTurn: false });
  assert.equal(requests.length, 0);
  await agent.prompt(question);
  assert.deepEqual(requests[0].map(text), ["选区正文", "对应问题"]);
});

test("宿主交付：all 队列一起交付；one-at-a-time 会拆开独立消息", async () => {
  for (const mode of ["all", "one-at-a-time"] as const) {
    const { agent, requests } = recordingAgent(mode);
    agent.followUp({ role: "custom", ...selection, timestamp: 0 });
    agent.followUp(question);
    await agent.prompt("原问题");
    const paired = requests.find((request) => request.some((message) => text(message) === "选区正文"));
    assert.ok(paired);
    assert.equal(paired.some((message) => text(message) === "对应问题"), mode === "all");
    assert.equal(requests.length, mode === "all" ? 2 : 3);
  }
});
