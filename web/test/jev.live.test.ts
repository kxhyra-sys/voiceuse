/**
 * Real Jev calls. Skipped unless TYPESAFE_API_KEY is set. Reports how often the router lands on the
 * expected decision and how long Jev takes; use it to tune THRESHOLDS in server/jev/questions.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { jevFromEnv } from "../server/jev/client.ts";
import { JevRouter, type Decision, type RouterInput } from "../server/jev/router.ts";

const jev = jevFromEnv();

const tabs = [
  { id: "tab-1", title: "Inbox (3) - Gmail", active: true },
  { id: "tab-2", title: "GitHub - pulls", active: false },
];
const elements = [
  { ref: "ref_1", label: 'button "Sign in"' },
  { ref: "ref_2", label: 'button "Compose"' },
  { ref: "ref_3", label: 'button "Send"' },
  { ref: "ref_4", label: 'link "Pricing"' },
  { ref: "ref_5", label: 'textbox "Search mail"' },
  { ref: "ref_6", label: 'button "Delete"' },
];

type Case = [utterance: string, expected: Decision["kind"], claudeQuestion?: string];
const CASES: Case[] = [
  ["scroll down", "scroll"],
  ["scroll up a bit", "scroll"],
  ["go to the bottom of the page", "scroll"],
  ["back to the top", "scroll"],
  ["go back", "history"],
  ["previous page", "history"],
  ["go forward", "history"],
  ["refresh the page", "reload"],
  ["open a new tab", "newTab"],
  ["close this tab", "closeTab"],
  ["switch to the github tab", "switchTab"],
  ["click sign in", "click"],
  ["press compose", "click"],
  ["open the pricing page", "click"],
  ["go to github dot com", "navigate"],
  ["open youtube", "navigate"],
  ["stop", "stop"],
  ["never mind, cancel that", "stop"],
  ["start over", "reset"],
  ["no don't do that", "decline", "Should I send the email to Sam?"],
  ["yes go ahead", "claude", "Should I send the email to Sam?"],
  ["click send", "claude"],
  ["delete this email", "claude"],
  ["scroll down and open the first result", "claude"],
  ["find me a cheap flight to Rome next week", "claude"],
  ["what does this page say about pricing", "claude"],
  ["search my mail for invoices from October", "claude"],
  ["reply to Sam saying I'll be late", "claude"],
  ["sign in with my work account and open the dashboard", "claude"],
  ["summarise this page", "claude"],
];

test("live Jev routing", { skip: !jev && "TYPESAFE_API_KEY not set" }, async () => {
  const router = new JevRouter(jev);
  const rows: string[] = [];
  const times: number[] = [];
  let right = 0;
  let unsafe = 0;
  for (const [utterance, expected, claudeQuestion] of CASES) {
    const input: RouterInput = { utterance, claudeQuestion: claudeQuestion ?? null, tabs, clickTargets: async () => elements };
    const { decision, ms } = await router.decide(input, new AbortController().signal);
    times.push(ms);
    const ok = decision.kind === expected;
    if (ok) right++;
    // The one failure that matters: something that should go to Claude ran directly.
    if (expected === "claude" && decision.kind !== "claude") unsafe++;
    rows.push(`${ok ? "✓" : "✗"} ${utterance.padEnd(52)} want ${expected.padEnd(9)} got ${decision.kind}${decision.kind === "claude" ? ` (${decision.reason})` : ""} ${ms}ms`);
  }
  times.sort((a, b) => a - b);
  console.log(rows.join("\n"));
  console.log(`accuracy ${right}/${CASES.length} · median ${times[times.length >> 1]} ms · p90 ${times[Math.floor(times.length * 0.9)]} ms · unsafe ${unsafe}`);
  assert.equal(router.enabled, true, "Jev key rejected");
  assert.equal(unsafe, 0, "a command that should have gone to Claude ran directly");
});
