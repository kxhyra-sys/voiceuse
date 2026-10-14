import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { PlaywrightBrowser } from "../server/browser.ts";
import { runFast } from "../server/jev/fastActions.ts";

const SITE = "https://voiceuse-fast.test";
const PAGE = `<!doctype html><title>Fast page</title>
<button id="in" onclick="document.getElementById('out').textContent='Signed in'">Sign in</button>
<a href="/second">Second page</a>
<p id="out"></p>
<div style="height:4000px"></div><p>Bottom</p>`;

let browser: PlaywrightBrowser;
let profile: string;

before(async () => {
  profile = mkdtempSync(join(tmpdir(), "voiceuse-fast-"));
  browser = await PlaywrightBrowser.launch({
    profileDir: profile,
    headless: true,
    setup: async (context) => {
      await context.route(`${SITE}/**`, (route) => {
        const path = new URL(route.request().url()).pathname;
        return route.fulfill({ contentType: "text/html", body: path === "/second" ? "<title>Second</title><h1>Second</h1>" : PAGE });
      });
    },
  });
  await browser.human.navigate(SITE);
});

after(async () => {
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
});

const scrollY = () => browser.fast.evaluate(() => window.scrollY);

test("clickTargets lists visible interactive elements with refs", async () => {
  const targets = await browser.clickTargets();
  const signIn = targets.find((t) => t.label === 'button "Sign in"');
  assert.ok(signIn, JSON.stringify(targets));
  assert.match(signIn.ref, /^ref_\d+$/);
  assert.ok(targets.some((t) => /^link "Second page"/.test(t.label)));
});

test("click by ref", async () => {
  const signIn = (await browser.clickTargets()).find((t) => t.label === 'button "Sign in"')!;
  assert.equal(await runFast(browser, { kind: "click", ref: signIn.ref, label: signIn.label }), 'clicked button "Sign in"');
  assert.equal(await browser.fast.evaluate(() => document.getElementById("out")!.textContent), "Signed in");
});

test("scroll down, bottom and top", async () => {
  await runFast(browser, { kind: "scroll", dir: "down" });
  assert.ok((await scrollY()) > 100);
  await runFast(browser, { kind: "scroll", dir: "bottom" });
  assert.ok((await scrollY()) > 3000);
  await runFast(browser, { kind: "scroll", dir: "top" });
  assert.equal(await scrollY(), 0);
});

test("navigate, back, forward", async () => {
  await runFast(browser, { kind: "navigate", url: `${SITE}/second` });
  assert.equal((await browser.tabList()).find((t) => t.active)?.title, "Second");
  await runFast(browser, { kind: "history", dir: "back" });
  assert.equal((await browser.tabList()).find((t) => t.active)?.title, "Fast page");
  await runFast(browser, { kind: "history", dir: "forward" });
  assert.equal((await browser.tabList()).find((t) => t.active)?.title, "Second");
});

test("new, switch and close tabs", async () => {
  const before = await browser.tabList();
  await runFast(browser, { kind: "newTab" });
  const opened = await browser.tabList();
  assert.equal(opened.length, before.length + 1);
  const first = opened[0];
  await runFast(browser, { kind: "switchTab", tabId: first.tab_id, title: first.title });
  assert.equal((await browser.tabList()).find((t) => t.active)?.tab_id, first.tab_id);
  const last = opened.at(-1)!;
  await runFast(browser, { kind: "closeTab", tabId: last.tab_id, title: last.title });
  assert.equal((await browser.tabList()).length, before.length);
});

test("private addresses are refused even on the fast path", async () => {
  await assert.rejects(runFast(browser, { kind: "navigate", url: "http://192.168.1.1" }));
});
