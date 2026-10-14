import assert from "node:assert/strict";
import { test } from "node:test";
import { JevAuthError, type Answer, type JevClient, type JevQuestions } from "../server/jev/client.ts";
import { JevRouter, type RouterInput } from "../server/jev/router.ts";

const choice = (picked: string, confidence: number): Answer => ({ type: "choice", choice: picked, confidence, probabilities: { [picked]: confidence } });
const noul = (p: number): Answer => ({ type: "noul", noul: p });

/** A fake Jev that answers from a table and records what it was asked. */
class FakeJev implements JevClient {
  calls: Array<{ state: any; questions: JevQuestions }> = [];
  constructor(private answers: Record<string, Answer> | Error) {}
  async ask(state: object, questions: JevQuestions) {
    this.calls.push({ state, questions });
    if (this.answers instanceof Error) throw this.answers;
    const answers: Record<string, Answer> = {};
    for (const key of Object.keys(questions)) answers[key] = this.answers[key] ?? noul(0);
    return { answers, model: "jev-1.13.0", requestId: "req_1" };
  }
}

const base = (over: Partial<RouterInput> = {}): RouterInput => ({
  utterance: "scroll down",
  claudeQuestion: null,
  tabs: [{ id: "tab-1", title: "Inbox", active: true }],
  clickTargets: async () => [
    { ref: "ref_4", label: 'button "Sign in"' },
    { ref: "ref_9", label: 'button "Send"' },
  ],
  ...over,
});

const decide = async (answers: Record<string, Answer> | Error, input = base()) => {
  const jev = new FakeJev(answers);
  const router = new JevRouter(jev);
  return { result: await router.decide(input, new AbortController().signal), jev, router };
};

test("scroll with enough confidence runs directly", async () => {
  const { result } = await decide({ intent: choice("scroll", 0.9), scroll_dir: choice("down", 0.95), multi_step: noul(0.05) });
  assert.deepEqual(result.decision, { kind: "scroll", dir: "down" });
});

test("multi_step overrides any intent", async () => {
  const { result } = await decide({ intent: choice("scroll", 0.99), scroll_dir: choice("down", 0.99), multi_step: noul(0.6) });
  assert.equal(result.decision.kind, "claude");
});

test("low intent confidence goes to Claude", async () => {
  const { result } = await decide({ intent: choice("scroll", 0.5), scroll_dir: choice("down", 0.99) });
  assert.equal(result.decision.kind, "claude");
});

test("low-risk threshold edge is inclusive", async () => {
  const { result } = await decide({ intent: choice("reload", 0.6) });
  assert.deepEqual(result.decision, { kind: "reload" });
});

test("stop needs 0.8, reset needs 0.85", async () => {
  assert.deepEqual((await decide({ intent: choice("stop", 0.8) })).result.decision, { kind: "stop" });
  assert.equal((await decide({ intent: choice("reset", 0.84) })).result.decision.kind, "claude");
  assert.deepEqual((await decide({ intent: choice("reset", 0.9) })).result.decision, { kind: "reset" });
});

test("click on a confidently picked, harmless element", async () => {
  const input = base({ utterance: "click sign in" });
  const { result, jev } = await decide({ intent: choice("click", 0.9), click_target: choice("e1", 0.95), risky_request: noul(0.02) }, input);
  assert.deepEqual(result.decision, { kind: "click", ref: "ref_4", label: 'button "Sign in"' });
  assert.deepEqual(jev.calls[0].state.page_elements, ['e1: button "Sign in"', 'e2: button "Send"']);
});

test("click on a risky-labelled element goes to Claude", async () => {
  const input = base({ utterance: "click send" });
  const { result } = await decide({ intent: choice("click", 0.95), click_target: choice("e2", 0.95), risky_request: noul(0.0) }, input);
  assert.equal(result.decision.kind, "claude");
});

test("a risky request goes to Claude even with a harmless label", async () => {
  const input = base({ utterance: "click sign in and pay" });
  const { result } = await decide({ intent: choice("click", 0.95), click_target: choice("e1", 0.95), risky_request: noul(0.5) }, input);
  assert.equal(result.decision.kind, "claude");
});

test("click with an unsure target or none goes to Claude", async () => {
  const input = base({ utterance: "click the thing" });
  assert.equal((await decide({ intent: choice("click", 0.9), click_target: choice("e1", 0.7) }, input)).result.decision.kind, "claude");
  assert.equal((await decide({ intent: choice("click", 0.9), click_target: choice("none", 0.99) }, input)).result.decision.kind, "claude");
});

test("page elements are only read for click-like utterances", async () => {
  let read = 0;
  const input = base({ utterance: "scroll down", clickTargets: async () => { read++; return []; } });
  const { jev } = await decide({ intent: choice("scroll", 0.9), scroll_dir: choice("down", 0.9) }, input);
  assert.equal(read, 0);
  assert.equal("click_target" in jev.calls[0].questions, false);
});

test("a spoken domain is extracted in code", async () => {
  const input = base({ utterance: "go to github dot com" });
  const { result } = await decide({ intent: choice("go_to_site", 0.9) }, input);
  assert.deepEqual(result.decision, { kind: "navigate", url: "https://github.com" });
});

test("a known site name is picked by Jev", async () => {
  const input = base({ utterance: "open youtube" });
  const { result } = await decide({ intent: choice("go_to_site", 0.9), site: choice("youtube", 0.9) }, input);
  assert.deepEqual(result.decision, { kind: "navigate", url: "https://www.youtube.com" });
});

test("private addresses are never fast-navigated", async () => {
  const input = base({ utterance: "go to 192.168.1.1" });
  const { result } = await decide({ intent: choice("go_to_site", 0.99) }, input);
  assert.equal(result.decision.kind, "claude");
});

test("a confident no to Claude's question declines without Claude", async () => {
  const input = base({ utterance: "no don't", claudeQuestion: "Should I send it?" });
  const { result, jev } = await decide({ intent: choice("answer", 0.9), reply: choice("no", 0.9) }, input);
  assert.deepEqual(result.decision, { kind: "decline" });
  assert.ok("reply" in jev.calls[0].questions);
});

test("yes to Claude's question goes to Claude", async () => {
  const input = base({ utterance: "yes", claudeQuestion: "Should I send it?" });
  const { result } = await decide({ intent: choice("answer", 0.95), reply: choice("yes", 0.95) }, input);
  assert.equal(result.decision.kind, "claude");
});

test("reply question is left out when Claude asked nothing", async () => {
  const { jev } = await decide({ intent: choice("scroll", 0.9) });
  assert.equal("reply" in jev.calls[0].questions, false);
  assert.equal("tab_target" in jev.calls[0].questions, false, "only one tab, so no tab question");
});

test("switch tab picks the named tab", async () => {
  const input = base({ utterance: "switch to github", tabs: [{ id: "tab-1", title: "Inbox", active: true }, { id: "tab-2", title: "GitHub", active: false }] });
  const { result } = await decide({ intent: choice("tab_switch", 0.9), tab_target: choice("t2", 0.9) }, input);
  assert.deepEqual(result.decision, { kind: "switchTab", tabId: "tab-2", title: "GitHub" });
});

test("close tab without a named tab closes the active one", async () => {
  const { result } = await decide({ intent: choice("tab_close", 0.9) });
  assert.deepEqual(result.decision, { kind: "closeTab", tabId: "tab-1", title: "Inbox" });
});

test("Jev errors go to Claude; a rejected key turns the router off", async () => {
  const { result: failed, router } = await decide(new Error("timeout"));
  assert.equal(failed.decision.kind, "claude");
  assert.equal(router.enabled, true);

  const auth = await decide(new JevAuthError());
  assert.equal(auth.result.decision.kind, "claude");
  assert.equal(auth.router.enabled, false);
});

test("a router without a client always hands to Claude", async () => {
  const router = new JevRouter(null);
  assert.equal(router.enabled, false);
  const result = await router.decide(base(), new AbortController().signal);
  assert.equal(result.decision.kind, "claude");
});
