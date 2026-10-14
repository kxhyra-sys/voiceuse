import Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BetaMessage, BetaToolResultBlockParam, BetaToolUseBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { BrowserAgent, type CreateMessage, type Toolset } from "../server/agent.ts";

const quiet = { onNote() {}, onAction() {}, onLog() {} };

function message(stop_reason: string, content: unknown[]): BetaMessage {
  return { id: "msg", type: "message", role: "assistant", model: "m", content, stop_reason, usage: {} } as unknown as BetaMessage;
}
const use = (id: string, name: string, input: object = {}) =>
  ({ type: "tool_use", id, name, input, toolset_name: "browser" }) as unknown as BetaToolUseBlock;

class FakeToolset implements Toolset {
  readonly toolsetName = "browser";
  calls: string[] = [];
  failOn = new Set<string>();
  toJSON() { return { type: "browser_toolset_20260801" as const }; }
  async toolResult(call: BetaToolUseBlock): Promise<BetaToolResultBlockParam> {
    this.calls.push(call.name);
    const failed = this.failOn.has(call.name);
    return { type: "tool_result", tool_use_id: call.id, toolset_name: "browser", content: failed ? "Error: boom" : "OK", ...(failed ? { is_error: true } : {}) } as BetaToolResultBlockParam;
  }
}

function scripted(responses: BetaMessage[]) {
  const sent: any[] = [];
  const create: CreateMessage = async (params) => {
    sent.push(structuredClone(params));
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return next;
  };
  return { create, sent };
}

test("runs tool calls and returns the final reply", async () => {
  const tools = new FakeToolset();
  const { create, sent } = scripted([
    message("tool_use", [{ type: "text", text: "Opening it." }, use("t1", "navigate", { url: "example.com" }), use("t2", "screenshot")]),
    message("end_turn", [{ type: "text", text: "The heading says Example Domain." }]),
  ]);
  const agent = new BrowserAgent(create, tools, quiet);
  const outcome = await agent.run("open example.com", new AbortController().signal);

  assert.deepEqual(outcome, { kind: "reply", text: "The heading says Example Domain." });
  assert.deepEqual(tools.calls, ["navigate", "screenshot"]);
  // user, assistant(tool_use), user(results), assistant(final)
  assert.equal(agent.messageCount, 4);
  assert.deepEqual(sent[0].tools, [{ type: "browser_toolset_20260801" }]);
  assert.equal(sent[0].fallbacks, "default");
  const results = sent[1].messages[2].content;
  assert.deepEqual(results.map((r: any) => r.tool_use_id), ["t1", "t2"]);
});

test("stops a batch at the first failure with the exact halt text", async () => {
  const tools = new FakeToolset();
  tools.failOn.add("left_click");
  const { create, sent } = scripted([
    message("tool_use", [use("a", "left_click"), use("b", "type", { text: "hi" }), use("c", "key", { text: "Enter" })]),
    message("end_turn", [{ type: "text", text: "That button didn't respond." }]),
  ]);
  const agent = new BrowserAgent(create, tools, quiet);
  await agent.run("search", new AbortController().signal);

  assert.deepEqual(tools.calls, ["left_click"]);
  const results = sent[1].messages[2].content;
  assert.equal(results[0].is_error, true);
  for (const r of results.slice(1)) {
    assert.equal(r.content, "Not executed: an earlier action in this turn failed.");
    assert.equal(r.toolset_name, "browser");
    assert.equal(r.is_error, true);
  }
});

test("retries once without the optional betas on a 400", async () => {
  const tools = new FakeToolset();
  let calls = 0;
  const sent: any[] = [];
  const create: CreateMessage = async (params) => {
    sent.push(params);
    if (calls++ === 0) {
      throw new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: "unknown beta" } }, "unknown beta", new Headers());
    }
    return message("end_turn", [{ type: "text", text: "Hi." }]);
  };
  const agent = new BrowserAgent(create, tools, quiet);
  const outcome = await agent.run("hello", new AbortController().signal);
  assert.equal(outcome.kind, "reply");
  assert.ok(sent[0].betas);
  assert.equal(sent[1].betas, undefined);
  assert.equal(sent[1].fallbacks, undefined);
  assert.equal(agent.config.useBetas, false);
});

test("a cancel mid-turn leaves a valid history", async () => {
  const tools = new FakeToolset();
  const controller = new AbortController();
  const create: CreateMessage = async () => {
    controller.abort();
    return message("tool_use", [use("x", "screenshot")]);
  };
  const agent = new BrowserAgent(create, tools, quiet);
  await assert.rejects(agent.run("do it", controller.signal));
  // user, assistant(tool_use), user(error results): every tool_use has a result.
  assert.equal(agent.messageCount, 3);
  assert.deepEqual(tools.calls, []);
});

test("refusal and step limit", async () => {
  const tools = new FakeToolset();
  const refused = new BrowserAgent(scripted([
    { ...message("refusal", []), stop_details: { type: "refusal", category: null, explanation: "Not that." } } as unknown as BetaMessage,
  ]).create, tools, quiet);
  assert.deepEqual(await refused.run("x", new AbortController().signal), { kind: "refused", text: "Not that." });

  const looping = new BrowserAgent(async () => message("tool_use", [use("s", "screenshot")]), tools, quiet);
  looping.config.maxSteps = 3;
  assert.deepEqual(await looping.run("x", new AbortController().signal), { kind: "stepLimit" });
});

test("zoom results go out without a browser_state block", async () => {
  const tools = new FakeToolset();
  tools.toolResult = async (call) => ({
    type: "tool_result", tool_use_id: call.id, toolset_name: "browser",
    content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "x" } }, { type: "browser_state", tabs: [] }],
  }) as unknown as BetaToolResultBlockParam;
  const { create, sent } = scripted([
    message("tool_use", [use("z", "zoom", { region: [0, 0, 10, 10] })]),
    message("end_turn", [{ type: "text", text: "Done." }]),
  ]);
  await new BrowserAgent(create, tools, quiet).run("zoom", new AbortController().signal);
  assert.deepEqual(sent[1].messages[2].content[0].content.map((b: any) => b.type), ["image"]);
});
