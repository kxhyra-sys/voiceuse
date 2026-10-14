# Jev fast path for VoiceUse web — design

Date: 2026-10-08 · Status: approved in chat (user waived written-spec review)

## Goal

Use TypeSafe's Jev (`jev-1.13.0`) to decide what a spoken command means, so simple commands run
directly in the browser in under ~1 s without a Claude call. Anything complex or uncertain goes to
the existing Claude agent loop unchanged.

Scope: the web app (`web/`) only. Not the Swift app, not Jev checking Claude's own steps, no voice
disambiguation prompts.

## Flow

```
speech → app.js heard() → WS "command" → index.ts runCommand
  → jev/router.ts: ONE Jev call (speculative fan-out of all questions)
      control (stop/reset) | answer to Claude's question | fast action | Claude (default)
  → fast action: jev/fastActions.ts → PlaywrightBrowser (human-style methods)
  → otherwise: agent.run(text) as today, prefixed with a note of fast actions since Claude's last turn
```

The hardcoded phrase list in `app.js` stays as a zero-latency, offline fallback.

## Modules (`web/server/jev/`)

- `client.ts` — `JevClient` interface (`decide(state, questions, signal)`), real implementation on
  `@typesafe-ai/sdk` with the model pinned to `jev-1.13.0`, 1.5 s timeout, max 1 retry. Key from
  `TYPESAFE_API_KEY`, never sent to the page or logged.
- `questions.ts` — every question, option description and threshold, in one file.
- `router.ts` — builds the state, calls Jev, applies the rules, returns a `Decision`.
- `fastActions.ts` — executes a `Decision` against the browser.
- `browser.ts` gains `clickTargets()` (visible interactive elements as `eN: role "name"`, ≤ 255)
  and `fast.*` actions (scroll, click by ref).

## Jev request

State: `{ utterance, claude_question | null, tabs[], page_elements[] (only if the utterance looks
like a click), known_sites[] }`.

Questions: `intent` (Choice, `task` listed first so option-order bias favours the fallback) ·
`multi_step` (Noul) · `scroll_dir` · `history_dir` · `tab_target` · `click_target` · `site` ·
`reply` (only when Claude asked) · `risky_request` (Noul). Questions whose options would be empty
are left out.

## Rules (all thresholds in `questions.ts`)

| Condition | Result |
|---|---|
| `multi_step` > 0.3 | Claude |
| stop, confidence ≥ 0.8 | stop |
| reset, confidence ≥ 0.85 | reset conversation |
| scroll / history / reload / tab actions, confidence ≥ 0.6 | fast action |
| click: intent ≥ 0.75, target ≥ 0.8, `risky_request` ≤ 0.15, label not matching send/buy/pay/delete/submit/post/order/checkout | fast click |
| go to site: domain via regex in code, or `site` ≥ 0.8 | fast navigate (through `urlPolicy`) |
| answer: no (≥ 0.75) | "Okay, I won't." spoken, no Claude call |
| answer: yes / something else | Claude (it has to act on it) |
| anything else, Jev error/timeout, no key | Claude |

## Errors

No key → router off, status shows "Jev: off". Timeout / 429 / 5xx / network → that command goes to
Claude. 401 → router off until restart, error shown once. Fast action throws → command goes to
Claude with a note. Stop aborts the Jev call too.

## Visibility

Each fast action appears in the activity log as `⚡ Jev: <what> (0.21 s)`. The server log records the
Jev request ID, model, answers and decision.

## Tests

- `router.test.ts`: fake `JevClient`, every rule and threshold edge, errors → Claude.
- `fastActions.test.ts`: real headless Chromium on a local page.
- `jev.live.test.ts`: skipped without `TYPESAFE_API_KEY`; ~30 utterances against the real model,
  reports accuracy and latency.
- Existing tests and `npm run typecheck` still pass.
