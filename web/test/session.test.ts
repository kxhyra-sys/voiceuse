import assert from "node:assert/strict";
import { test } from "node:test";
import { SCREENSHOT_DROPPED, slim, validHistory, validTabs } from "../server/session.ts";
import { chunks } from "../server/tts.ts";

const history: any[] = [
  { role: "user", content: [{ type: "text", text: "find flights" }] },
  { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "screenshot", input: {} }] },
  {
    role: "user",
    content: [{
      type: "tool_result",
      tool_use_id: "t1",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "A".repeat(50_000) } },
        { type: "text", text: "x".repeat(10_000) },
        { type: "browser_state", tabs: [] },
      ],
    }],
  },
  { role: "assistant", content: [{ type: "text", text: "Done." }] },
];

test("slim drops screenshots and cuts long tool output, leaving the original alone", () => {
  const out = slim(history) as any[];
  const parts = out[2].content[0].content;
  assert.deepEqual(parts[0], { type: "text", text: SCREENSHOT_DROPPED });
  assert.ok(parts[1].text.length < 4100);
  assert.match(parts[1].text, /cut when the session was saved/);
  assert.equal(parts[2].type, "browser_state");
  assert.equal(out[2].content[0].tool_use_id, "t1");
  assert.deepEqual(out[0], history[0]);
  assert.equal(history[2].content[0].content[0].type, "image");
  assert.ok(JSON.stringify(out).length < 6000);
});

test("validHistory accepts saved histories and rejects junk", () => {
  assert.deepEqual(validHistory(history), history);
  assert.deepEqual(validHistory([]), []);
  assert.equal(validHistory("nope"), null);
  assert.equal(validHistory([{ role: "assistant", content: "hi" }]), null);
  assert.equal(validHistory([{ role: "system", content: "hi" }]), null);
  assert.equal(validHistory([{ role: "user", content: [{ text: "no type" }] }]), null);
});

test("validTabs keeps http(s) tabs only", () => {
  assert.deepEqual(
    validTabs([{ url: "https://a.com", active: true }, { url: "file:///etc/passwd" }, { url: "javascript:alert(1)" }, { url: "http://b.com" }, null]),
    [{ url: "https://a.com", active: true }, { url: "http://b.com", active: false }],
  );
  assert.deepEqual(validTabs("x"), []);
});

test("chunks keeps sentences whole, joins short ones and starts small", () => {
  assert.deepEqual(chunks("Okay. Done."), ["Okay. Done."]);
  const reply = "The best flight is on your screen now. It's Wizz Air nonstop from Dortmund on Christmas Day at 9 AM. Bags cost extra. Have a great trip!";
  const parts = chunks(reply);
  assert.equal(parts.join(" "), reply);
  assert.equal(parts[0], "The best flight is on your screen now.");
  assert.ok(parts.every((p) => p.length <= 220));
  assert.deepEqual(chunks("No punctuation at the end"), ["No punctuation at the end"]);
  assert.deepEqual(chunks(""), []);
  assert.deepEqual(chunks("It costs €5.99 on wizzair.com today. Want it?"), ["It costs €5.99 on wizzair.com today.", "Want it?"]);
});
