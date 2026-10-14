import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { BetaToolResultBlockParam, BetaToolUseBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { PlaywrightBrowser, isTopLevel } from "../server/browser.ts";

const SITE = "https://voiceuse.test";
const PAGE = `<!doctype html><title>Ticket shop</title>
<h1>Concert tickets</h1>
<label for="q">Search</label><input id="q" placeholder="Artist">
<button id="go" onclick="document.getElementById('out').textContent = 'Searched: ' + document.getElementById('q').value">Search</button>
<select id="n" aria-label="Quantity"><option value="1">One</option><option value="2">Two</option></select>
<label><input type="checkbox" id="agree"> I agree</label>
<p id="out"></p>
<a href="/second" target="_blank">Open second</a>
<div style="height:3000px"></div><p id="bottom">Bottom of page</p>`;

let browser: PlaywrightBrowser;
let profile: string;
let seq = 0;

before(async () => {
  profile = mkdtempSync(join(tmpdir(), "voiceuse-test-"));
  browser = await PlaywrightBrowser.launch({
    profileDir: profile,
    headless: true,
    setup: async (context) => {
      await context.route(`${SITE}/**`, (route) => {
        const path = new URL(route.request().url()).pathname;
        return route.fulfill({ contentType: "text/html", body: path === "/second" ? "<title>Second</title><h1>Second page</h1>" : PAGE });
      });
    },
  });
});

after(async () => {
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
});

function call(name: string, input: object = {}): Promise<BetaToolResultBlockParam> {
  const block = { type: "tool_use", id: `toolu_${++seq}`, name, input, toolset_name: "browser" } as unknown as BetaToolUseBlock;
  return browser.toolResult(block);
}
const text = (r: BetaToolResultBlockParam) =>
  typeof r.content === "string" ? r.content : (r.content ?? []).map((b: any) => b.text ?? "").join("\n");
const state = (r: BetaToolResultBlockParam) => (r.content as any[]).find((b) => b.type === "browser_state");

test("navigate, read, fill, click and read back", async () => {
  const nav = await call("navigate", { url: SITE });
  assert.equal(nav.is_error, undefined, text(nav));
  assert.match(text(nav), /Ticket shop/);
  assert.equal(nav.toolset_name, "browser");
  assert.equal(state(nav).tabs[0].active, true);

  const tree = text(await call("read_page", { filter: "interactive" }));
  const ref = (pattern: RegExp) => tree.split("\n").find((l) => pattern.test(l))?.match(/\[(ref_\d+)\]/)?.[1];
  const search = ref(/textbox "Search"/), go = ref(/button "Search"/), qty = ref(/combobox "Quantity"/), agree = ref(/checkbox/);
  assert.ok(search && go && qty && agree, tree);

  assert.equal((await call("left_click", { target: { type: "ref", ref: search } })).is_error, undefined);
  assert.equal((await call("type", { text: "Radiohead" })).is_error, undefined);
  assert.equal((await call("left_click", { target: { type: "ref", ref: go } })).is_error, undefined);
  assert.equal((await call("form_input", { target: { type: "ref", ref: qty }, value: "Two" })).is_error, undefined);
  assert.equal((await call("form_input", { target: { type: "ref", ref: agree }, value: true })).is_error, undefined);

  const after = text(await call("read_page", {}));
  assert.match(after, /Searched: Radiohead/);
  assert.match(after, /selected="Two"/);
  assert.match(after, /checkbox "I agree" \[ref_\d+\] checked/);
  // Refs stay stable across reads.
  assert.match(after, new RegExp(`textbox "Search" \\[${search}\\]`));

  const found = text(await call("find", { query: "search button" }));
  assert.match(found.split("\n")[0], /button "Search"/);
  assert.match(text(await call("get_page_text", {})), /Bottom of page/);
});

test("keys, scrolling, screenshots and zoom", async () => {
  const key = await call("key", { text: "ctrl+a Backspace" });
  assert.equal(key.is_error, undefined, text(key));
  const scroll = await call("scroll", { target: { type: "coordinate", x: 640, y: 400 }, scroll_direction: "down", scroll_amount: 10 });
  assert.equal(scroll.is_error, undefined, text(scroll));

  const shot = await call("screenshot", {});
  const img = (shot.content as any[]).find((b) => b.type === "image");
  assert.equal(img.source.media_type, "image/png");
  const png = Buffer.from(img.source.data, "base64");
  assert.equal(png.readUInt32BE(16), 1280);
  assert.equal(png.readUInt32BE(20), 800);

  const zoom = await call("zoom", { region: [0, 0, 320, 200] });
  const zimg = (zoom.content as any[]).find((b) => b.type === "image");
  const zpng = Buffer.from(zimg.source.data, "base64");
  assert.equal(zpng.readUInt32BE(16), 1280, "zoom renders the region at 4x");
});

test("refuses private URLs and unknown refs", async () => {
  const local = await call("navigate", { url: "http://127.0.0.1:4477" });
  assert.equal(local.is_error, true);
  assert.match(text(local), /private network/);
  const stale = await call("left_click", { target: { type: "ref", ref: "ref_9999" } });
  assert.equal(stale.is_error, true);
  assert.match(text(stale), /stale or not found/);
  const badKey = await call("key", { text: "Hyper+q" });
  assert.equal(badKey.is_error, true);
});

test("tabs: a link that opens a new tab is reported, switch and close work", async () => {
  await call("navigate", { url: SITE });
  await call("scroll_to", { target: { type: "ref", ref: (text(await call("find", { query: "Open second" })).match(/\[(ref_\d+)\]/) ?? [])[1] } });
  const linkRef = text(await call("find", { query: "Open second" })).match(/\[(ref_\d+)\]/)![1];
  const click = await call("left_click", { target: { type: "ref", ref: linkRef } });
  const s = state(click);
  assert.ok(s.state_changes?.some((c: any) => c.type === "tab_opened"), JSON.stringify(s));
  assert.equal(s.tabs.length, 2);

  const list = await call("list_tabs", {});
  const tabs = state(list).tabs;
  const first = tabs[0].tab_id, second = tabs[1].tab_id;
  assert.equal(tabs.find((t: any) => t.active).tab_id, second);

  const sw = await call("switch_tab", { tab_id: first });
  assert.equal(state(sw).tabs.find((t: any) => t.active).tab_id, first);
  const closed = await call("close_tab", { tab_id: second });
  assert.equal(state(closed).tabs.length, 1);

  const opened = await call("new_tab", {});
  assert.equal(state(opened).tabs.length, 2);
  assert.ok(state(opened).state_changes.some((c: any) => c.type === "tab_opened"));
});

test("navigate opens a tab when every tab is closed", async () => {
  for (const tab of state(await call("list_tabs", {})).tabs) await call("close_tab", { tab_id: tab.tab_id });
  const nav = await call("navigate", { url: SITE });
  assert.equal(nav.is_error, undefined, text(nav));
  assert.equal(state(nav).tabs.length, 1);
});

test("a new tab's first navigation counts as top-level instead of throwing", () => {
  const early = { frame: () => { throw new Error("Frame for this navigation request is not available"); } };
  assert.equal(isTopLevel(early as any), true);
  const main = { page: () => ({ mainFrame: () => main }) };
  const child = { page: () => ({ mainFrame: () => main }) };
  assert.equal(isTopLevel({ frame: () => main } as any), true);
  assert.equal(isTopLevel({ frame: () => child } as any), false);
});
