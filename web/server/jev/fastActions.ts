import type { PlaywrightBrowser } from "../browser.ts";
import type { Decision } from "./router.ts";

export type FastDecision = Exclude<Decision, { kind: "claude" | "stop" | "reset" | "decline" }>;

export function isFast(decision: Decision): decision is FastDecision {
  return !["claude", "stop", "reset", "decline"].includes(decision.kind);
}

/** Carries out a fast-path decision and returns what happened, in words, for the log and Claude. */
export async function runFast(browser: PlaywrightBrowser, d: FastDecision): Promise<string> {
  switch (d.kind) {
    case "scroll":
      await browser.fast.scroll(d.dir);
      return d.dir === "top" || d.dir === "bottom" ? `scrolled to the ${d.dir}` : `scrolled ${d.dir}`;
    case "history":
      await (d.dir === "back" ? browser.human.back() : browser.human.forward());
      return `went ${d.dir}`;
    case "reload":
      await browser.human.reload();
      return "reloaded the page";
    case "newTab":
      await browser.human.newTab();
      return "opened a new tab";
    case "closeTab":
      await browser.human.closeTab(d.tabId);
      return `closed the tab "${d.title}"`;
    case "switchTab":
      await browser.human.switchTab(d.tabId);
      return `switched to the tab "${d.title}"`;
    case "click":
      await browser.fast.click(d.ref);
      return `clicked ${d.label}`;
    case "navigate":
      await browser.human.navigate(d.url); // checks the URL policy
      return `opened ${d.url}`;
  }
}
