import {
  BetaAbstractBrowserToolset20260801,
  type BetaBrowserNavigateResult,
  type BetaBrowserState,
  type BetaBrowserToolsetOptions,
  type BetaScreenshotResult,
  type BetaToolsetCallContext,
  ToolError,
} from "@anthropic-ai/sdk/helpers/beta/toolsets";
import type {
  BetaBrowserClickTarget,
  BetaBrowserCloseTabInput,
  BetaBrowserCoordinateTarget,
  BetaBrowserDoubleClickInput,
  BetaBrowserFindInput,
  BetaBrowserFormInputInput,
  BetaBrowserHoldKeyInput,
  BetaBrowserHoverInput,
  BetaBrowserKeyInput,
  BetaBrowserLeftClickDragInput,
  BetaBrowserLeftClickInput,
  BetaBrowserLeftMouseDownInput,
  BetaBrowserLeftMouseUpInput,
  BetaBrowserMiddleClickInput,
  BetaBrowserMouseMoveInput,
  BetaBrowserNavigateInput,
  BetaBrowserReadPageInput,
  BetaBrowserRightClickInput,
  BetaBrowserScreenshotInput,
  BetaBrowserScrollInput,
  BetaBrowserScrollToInput,
  BetaBrowserStateChange,
  BetaBrowserStateTabEntry,
  BetaBrowserSwitchTabInput,
  BetaBrowserTripleClickInput,
  BetaBrowserTypeInput,
  BetaBrowserWaitInput,
  BetaBrowserZoomInput,
} from "@anthropic-ai/sdk/resources/beta";
import { chromium, type BrowserContext, type CDPSession, type ElementHandle, type Page, type Request } from "playwright";
import { KeyError, chord, modifiers, sequence } from "./keys.ts";
import { pageText, pageTree, resolveRef, type TreeArgs } from "./pageScripts.ts";
import { refusal, withScheme } from "./urlPolicy.ts";

/** Fits the model's image limits as-is (1,024,000 px, long edge under 1568), so no scaling. */
export const VIEWPORT = { width: 1280, height: 800 };

type StateChange = NonNullable<BetaBrowserState["state_changes"]>[number];

/**
 * Whether a navigation request loads a tab's main frame. A link that opens a new tab issues its
 * request before the tab's frame exists, and `frame()` throws then; that request is top-level.
 */
export function isTopLevel(request: Request): boolean {
  try {
    const frame = request.frame();
    return frame === frame.page().mainFrame();
  } catch {
    return true;
  }
}

export interface LaunchOptions {
  profileDir: string;
  headless: boolean;
  /** Runs once the context is ready, e.g. to serve test pages with context.route. */
  setup?: (context: BrowserContext) => Promise<void>;
}

/** A frame of the live view: the active tab as a JPEG. */
export type FrameListener = (jpeg: Buffer) => void;

/**
 * Drives a real Chromium through Playwright for the browser use toolset. The SDK base class routes
 * each member call, checks the URL policy, and builds the tool results; this class does the clicking.
 * It also streams the active tab to the web UI and lets the person click and type into it.
 */
export class PlaywrightBrowser extends BetaAbstractBrowserToolset20260801 {
  private tabs = new Map<string, Page>();
  private ids = new WeakMap<Page, string>();
  private activeId: string | null = null;
  private nextTab = 1;
  private changes: StateChange[] = [];
  private nextDownload = 1;
  private screencast: { page: Page; cdp: CDPSession } | null = null;
  private frameListeners = new Set<FrameListener>();
  private tabListeners = new Set<() => void>();

  private constructor(
    private readonly context: BrowserContext,
    options: Omit<BetaBrowserToolsetOptions, "browserState"> = {},
  ) {
    super({ ...options, browserState: () => this.report() });
  }

  static async launch(launch: LaunchOptions): Promise<PlaywrightBrowser> {
    const context = await chromium.launchPersistentContext(launch.profileDir, {
      headless: launch.headless,
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      acceptDownloads: true,
      args: [`--window-size=${VIEWPORT.width},${VIEWPORT.height + 90}`],
    });
    const browser = new PlaywrightBrowser(context, {
      urlPolicy: (_ctx, url) => {
        const why = refusal(url);
        if (why) throw new ToolError(`Error: ${why}`);
      },
    });
    context.on("page", (page) => browser.adopt(page, true));
    // Pages the page itself starts (links, redirects, form posts) to private addresses are blocked
    // here; Claude's own navigate calls are checked by the URL policy before they reach us.
    await context.route("**/*", (route) => {
      const request = route.request();
      if (request.isNavigationRequest() && isTopLevel(request)) {
        const why = refusal(request.url());
        if (why && !request.url().startsWith("about:") && !request.url().startsWith("data:")) {
          browser.changes.push({ type: "navigation_refused" });
          return route.abort("blockedbyclient");
        }
      }
      return route.fallback();
    });
    await launch.setup?.(context);
    for (const page of context.pages()) browser.adopt(page, false);
    if (browser.tabs.size === 0) await context.newPage();
    return browser;
  }

  // MARK: Tabs

  private adopt(page: Page, announce: boolean) {
    if (this.ids.has(page)) return;
    const id = `tab-${this.nextTab++}`;
    this.ids.set(page, id);
    this.tabs.set(id, page);
    if (announce) this.changes.push({ type: "tab_opened", tab_id: id });
    this.setActive(id);

    page.on("close", () => {
      this.tabs.delete(id);
      if (this.activeId === id) {
        const last = [...this.tabs.keys()].at(-1) ?? null;
        this.setActive(last);
      }
      this.emitTabs();
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) this.emitTabs();
    });
    page.on("dialog", (dialog) => {
      this.changes.push({ type: "dialog_dismissed", kind: dialog.type(), message: dialog.message().slice(0, 300) });
      dialog.dismiss().catch(() => {});
    });
    page.on("download", (download) => {
      const download_id = `dl-${this.nextDownload++}`;
      const url = stripQuery(download.url());
      this.changes.push({ type: "download_started", download_id, url } satisfies BetaBrowserStateChange);
      download.path().then(
        () => this.changes.push({ type: "download_completed", download_id, url }),
        (err: Error) => this.changes.push({ type: "download_failed", download_id, url, error: err.message.slice(0, 200) }),
      );
    });
  }

  private setActive(id: string | null) {
    if (this.activeId === id) return;
    this.activeId = id;
    void this.restartScreencast();
    this.emitTabs();
  }

  private page(tabId?: string | null): Page {
    const id = tabId ?? this.activeId;
    const page = id ? this.tabs.get(id) : undefined;
    if (!page) {
      throw new ToolError(tabId ? `Error: no tab with tab_id ${tabId}. Call list_tabs to see the open tabs.` : "Error: no tab is open.");
    }
    return page;
  }

  /** Like page(), but opens a tab first when every tab has been closed. */
  private async pageOrNew(tabId?: string | null): Promise<Page> {
    if (!tabId && this.tabs.size === 0) await this.context.newPage();
    return this.page(tabId);
  }

  private async entry(id: string, page: Page): Promise<BetaBrowserStateTabEntry> {
    const title = await page.title().catch(() => "");
    return { tab_id: id, title: oneLine(title) || "(untitled)", url: oneLine(page.url()) || "about:blank", active: id === this.activeId };
  }

  async tabList(): Promise<BetaBrowserStateTabEntry[]> {
    return Promise.all([...this.tabs].map(([id, page]) => this.entry(id, page)));
  }

  private async report(): Promise<BetaBrowserState> {
    const tabs = (await this.tabList()).slice(-100);
    if (tabs.length && !tabs.some((t) => t.active)) tabs[tabs.length - 1].active = true;
    const state_changes = this.changes.splice(0).filter(
      (c) => c.type !== "tab_opened" || this.tabs.has(c.tab_id),
    );
    return state_changes.length ? { tabs, state_changes } : { tabs };
  }

  // MARK: Navigation and capture

  protected override async navigate(_ctx: BetaToolsetCallContext, input: BetaBrowserNavigateInput): Promise<BetaBrowserNavigateResult> {
    const page = await this.pageOrNew(input.tab_id);
    const keyword = input.url.trim().toLowerCase();
    let response;
    try {
      if (keyword === "back") response = await page.goBack({ waitUntil: "domcontentloaded" });
      else if (keyword === "forward") response = await page.goForward({ waitUntil: "domcontentloaded" });
      else if (keyword === "reload") response = await page.reload({ waitUntil: "domcontentloaded" });
      else response = await page.goto(withScheme(input.url), { waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch (err) {
      throw new ToolError(`Error: navigation failed: ${shortError(err)}`);
    }
    await settle(page);
    return { url: page.url(), status: response?.status(), title: await page.title().catch(() => "") };
  }

  protected override async screenshot(_ctx: BetaToolsetCallContext, input: BetaBrowserScreenshotInput): Promise<BetaScreenshotResult> {
    const page = this.page(input.tab_id);
    const png = await page.screenshot({ type: "png", timeout: 15_000 });
    return { data: png.toString("base64"), mediaType: "image/png" };
  }

  protected override async zoom(_ctx: BetaToolsetCallContext, input: BetaBrowserZoomInput): Promise<BetaScreenshotResult> {
    const page = this.page(input.tab_id);
    const [a, b, c, d] = input.region;
    if ([a, b, c, d].some((n) => typeof n !== "number" || !Number.isFinite(n))) {
      throw new ToolError("Error: region must be [x0, y0, x1, y1].");
    }
    const x0 = clamp(Math.min(a, c), 0, VIEWPORT.width), x1 = clamp(Math.max(a, c), 0, VIEWPORT.width);
    const y0 = clamp(Math.min(b, d), 0, VIEWPORT.height), y1 = clamp(Math.max(b, d), 0, VIEWPORT.height);
    const width = Math.max(1, x1 - x0), height = Math.max(1, y1 - y0);
    // Render the region larger, up to the viewport size, so small text becomes readable.
    const scale = Math.min(VIEWPORT.width / width, VIEWPORT.height / height, 4);
    const cdp = await page.context().newCDPSession(page);
    try {
      const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
      const shot = await cdp.send("Page.captureScreenshot", {
        format: "png",
        clip: { x: x0 + scroll.x, y: y0 + scroll.y, width, height, scale },
      });
      return { data: shot.data, mediaType: "image/png" };
    } finally {
      await cdp.detach().catch(() => {});
    }
  }

  // MARK: Pointer

  private async point(page: Page, target: BetaBrowserClickTarget): Promise<{ x: number; y: number }> {
    if (target.type === "coordinate") return { x: target.x, y: target.y };
    const el = await this.element(page, target.ref);
    try {
      await el.scrollIntoViewIfNeeded({ timeout: 5_000 });
      const box = await el.boundingBox();
      if (!box) throw new ToolError(`Error: ${target.ref} is not visible on the page.`);
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    } finally {
      await el.dispose();
    }
  }

  private async element(page: Page, ref: string): Promise<ElementHandle<Element>> {
    const handle = await page.evaluateHandle(inPage(resolveRef, ref));
    const el = handle.asElement();
    if (!el) {
      await handle.dispose();
      throw new ToolError(`Error: ${ref} is stale or not found on the current page. Re-read the page to get fresh references.`);
    }
    return el as ElementHandle<Element>;
  }

  private async click(
    input: { target: BetaBrowserClickTarget; modifiers?: string | null; tab_id?: string | null },
    button: "left" | "right" | "middle",
    clickCount: number,
  ) {
    const page = this.page(input.tab_id);
    const mods = keyMods(input.modifiers);
    const { x, y } = await this.point(page, input.target);
    for (const m of mods) await page.keyboard.down(m);
    try {
      await page.mouse.click(x, y, { button, clickCount, delay: 30 });
    } finally {
      for (const m of mods.reverse()) await page.keyboard.up(m);
    }
    await settle(page);
  }

  protected override async left_click(_c: BetaToolsetCallContext, i: BetaBrowserLeftClickInput) { await this.click(i, "left", 1); }
  protected override async right_click(_c: BetaToolsetCallContext, i: BetaBrowserRightClickInput) { await this.click(i, "right", 1); }
  protected override async middle_click(_c: BetaToolsetCallContext, i: BetaBrowserMiddleClickInput) { await this.click(i, "middle", 1); }
  protected override async double_click(_c: BetaToolsetCallContext, i: BetaBrowserDoubleClickInput) { await this.click(i, "left", 2); }
  protected override async triple_click(_c: BetaToolsetCallContext, i: BetaBrowserTripleClickInput) { await this.click(i, "left", 3); }

  protected override async hover(_ctx: BetaToolsetCallContext, input: BetaBrowserHoverInput) {
    const page = this.page(input.tab_id);
    const { x, y } = await this.point(page, input.target);
    await page.mouse.move(x, y, { steps: 4 });
  }

  protected override async left_click_drag(_ctx: BetaToolsetCallContext, input: BetaBrowserLeftClickDragInput) {
    const page = this.page(input.tab_id);
    await page.mouse.move(input.from.x, input.from.y);
    await page.mouse.down();
    await page.mouse.move(input.target.x, input.target.y, { steps: 12 });
    await page.mouse.up();
    await settle(page);
  }

  protected override async left_mouse_down(_ctx: BetaToolsetCallContext, input: BetaBrowserLeftMouseDownInput) {
    const page = this.page(input.tab_id);
    await page.mouse.move(input.target.x, input.target.y);
    await page.mouse.down();
  }

  protected override async left_mouse_up(_ctx: BetaToolsetCallContext, input: BetaBrowserLeftMouseUpInput) {
    const page = this.page(input.tab_id);
    await page.mouse.move(input.target.x, input.target.y, { steps: 6 });
    await page.mouse.up();
    await settle(page);
  }

  protected override async mouse_move(_ctx: BetaToolsetCallContext, input: BetaBrowserMouseMoveInput) {
    const page = this.page(input.tab_id);
    await page.mouse.move(input.target.x, input.target.y, { steps: 4 });
  }

  protected override async scroll(_ctx: BetaToolsetCallContext, input: BetaBrowserScrollInput) {
    const page = this.page(input.tab_id);
    const amount = clamp(input.scroll_amount ?? 3, 1, 10) * 100;
    const [dx, dy] = {
      up: [0, -amount], down: [0, amount], left: [-amount, 0], right: [amount, 0],
    }[input.scroll_direction];
    await page.mouse.move(input.target.x, input.target.y);
    await page.mouse.wheel(dx, dy);
    await page.waitForTimeout(250);
  }

  protected override async scroll_to(_ctx: BetaToolsetCallContext, input: BetaBrowserScrollToInput) {
    const page = this.page(input.tab_id);
    const el = await this.element(page, input.target.ref);
    try {
      await el.scrollIntoViewIfNeeded({ timeout: 5_000 });
    } finally {
      await el.dispose();
    }
  }

  // MARK: Keyboard and timing

  protected override async type_(_ctx: BetaToolsetCallContext, input: BetaBrowserTypeInput) {
    const page = this.page(input.tab_id);
    await page.keyboard.type(input.text, { delay: input.text.length > 200 ? 0 : 12 });
  }

  protected override async key(_ctx: BetaToolsetCallContext, input: BetaBrowserKeyInput) {
    const page = this.page(input.tab_id);
    const chords = keyCall(() => sequence(input.text));
    const repeat = clamp(input.repeat ?? 1, 1, 100);
    for (let i = 0; i < repeat; i++) {
      for (const c of chords) await page.keyboard.press(c);
    }
    await settle(page);
  }

  protected override async hold_key(ctx: BetaToolsetCallContext, input: BetaBrowserHoldKeyInput) {
    const page = this.page(input.tab_id);
    const keys = keyCall(() => chord(input.text)).split("+");
    for (const k of keys) await page.keyboard.down(k);
    try {
      await sleep(clamp(input.duration, 0, 30) * 1000, ctx.signal);
    } finally {
      for (const k of keys.reverse()) await page.keyboard.up(k);
    }
  }

  protected override async wait(ctx: BetaToolsetCallContext, input: BetaBrowserWaitInput) {
    await sleep(clamp(input.duration, 0, 30) * 1000, ctx.signal);
  }

  // MARK: Page reading and forms

  private async tree(page: Page, args: TreeArgs): Promise<string> {
    const text = (await page.evaluate(inPage(pageTree, args))) as string;
    if (text === "__STALE__") {
      throw new ToolError(`Error: ${args.ref} is stale or not found on the current page. Re-read the page to get fresh references.`);
    }
    return text;
  }

  protected override async read_page(_ctx: BetaToolsetCallContext, input: BetaBrowserReadPageInput): Promise<string> {
    const page = this.page(input.tab_id);
    return this.tree(page, { mode: "read", filter: input.filter, depth: input.depth, ref: input.ref });
  }

  protected override async find(_ctx: BetaToolsetCallContext, input: BetaBrowserFindInput): Promise<string> {
    return this.tree(this.page(input.tab_id), { mode: "find", query: input.query });
  }

  protected override async get_page_text(_ctx: BetaToolsetCallContext, input: { tab_id?: string | null }): Promise<string> {
    return (await this.page(input.tab_id).evaluate(inPage(pageText, undefined))) as string;
  }

  protected override async form_input(_ctx: BetaToolsetCallContext, input: BetaBrowserFormInputInput) {
    const page = this.page(input.tab_id);
    const el = await this.element(page, input.target.ref);
    try {
      const kind = await el.evaluate((node) => {
        const tag = node.tagName.toLowerCase();
        if (tag === "select") return "select";
        const type = (node as HTMLInputElement).type?.toLowerCase();
        if (tag === "input" && (type === "checkbox" || type === "radio")) return "check";
        return "fill";
      });
      if (kind === "select") {
        const value = String(input.value);
        const picked = await el.selectOption([{ value }]).catch(() => [] as string[]);
        if (picked.length === 0) await el.selectOption([{ label: value }]);
      } else if (kind === "check") {
        await el.setChecked(input.value === true || input.value === "true");
      } else {
        await el.fill(String(input.value));
      }
    } catch (err) {
      if (err instanceof ToolError) throw err;
      throw new ToolError(`Error: could not set ${input.target.ref}: ${shortError(err)}`);
    } finally {
      await el.dispose();
    }
  }

  // MARK: Tab management

  protected override async new_tab(): Promise<BetaBrowserStateTabEntry> {
    const page = await this.context.newPage(); // adopt() records tab_opened and makes it active
    const id = this.ids.get(page)!;
    return this.entry(id, page);
  }

  protected override async list_tabs(): Promise<BetaBrowserStateTabEntry[]> {
    return this.tabList();
  }

  protected override async switch_tab(_ctx: BetaToolsetCallContext, input: BetaBrowserSwitchTabInput): Promise<BetaBrowserStateTabEntry> {
    const page = this.page(input.tab_id);
    this.setActive(input.tab_id);
    await page.bringToFront().catch(() => {});
    return this.entry(input.tab_id, page);
  }

  protected override async close_tab(_ctx: BetaToolsetCallContext, input: BetaBrowserCloseTabInput) {
    await this.page(input.tab_id).close();
  }

  // MARK: Live view and the person's own input

  onFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener);
    if (this.frameListeners.size === 1) void this.restartScreencast();
    return () => {
      this.frameListeners.delete(listener);
      if (this.frameListeners.size === 0) void this.stopScreencast();
    };
  }

  onTabsChanged(listener: () => void): () => void {
    this.tabListeners.add(listener);
    return () => this.tabListeners.delete(listener);
  }

  private emitTabs() {
    for (const l of this.tabListeners) l();
  }

  private async stopScreencast() {
    const current = this.screencast;
    this.screencast = null;
    if (current) {
      await current.cdp.send("Page.stopScreencast").catch(() => {});
      await current.cdp.detach().catch(() => {});
    }
  }

  private async restartScreencast() {
    await this.stopScreencast();
    const page = this.activeId ? this.tabs.get(this.activeId) : undefined;
    if (!page || this.frameListeners.size === 0) return;
    try {
      const cdp = await page.context().newCDPSession(page);
      this.screencast = { page, cdp };
      cdp.on("Page.screencastFrame", (frame) => {
        cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
        if (this.screencast?.cdp !== cdp) return;
        const jpeg = Buffer.from(frame.data, "base64");
        for (const l of this.frameListeners) l(jpeg);
      });
      await cdp.send("Page.startScreencast", {
        format: "jpeg", quality: 70, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height, everyNthFrame: 1,
      });
    } catch {
      // The page closed while we attached; the next tab change starts a new one.
    }
  }

  /** The person clicks, scrolls or types into the live view (to log in, solve a CAPTCHA, and so on). */
  readonly human = {
    click: async (x: number, y: number, button: "left" | "right" = "left", clickCount = 1) => {
      await this.page().mouse.click(x, y, { button, clickCount });
    },
    wheel: async (x: number, y: number, dx: number, dy: number) => {
      const page = this.page();
      await page.mouse.move(x, y);
      await page.mouse.wheel(dx, dy);
    },
    key: async (key: string) => {
      await this.page().keyboard.press(key);
    },
    type: async (text: string) => {
      await this.page().keyboard.insertText(text);
    },
    navigate: async (url: string) => {
      const why = refusal(url);
      if (why) throw new Error(why);
      await (await this.pageOrNew()).goto(withScheme(url), { waitUntil: "domcontentloaded", timeout: 30_000 });
    },
    back: async () => { await this.page().goBack().catch(() => null); },
    forward: async () => { await this.page().goForward().catch(() => null); },
    reload: async () => { await this.page().reload().catch(() => null); },
    switchTab: async (id: string) => {
      const page = this.page(id);
      this.setActive(id);
      await page.bringToFront().catch(() => {});
    },
    newTab: async () => { await this.context.newPage(); },
    closeTab: async (id: string) => { await this.page(id).close(); },
  };

  /**
   * Replaces the open tabs with saved ones, for a resumed session. Addresses the URL policy refuses
   * are skipped. Pages load in the background; returns once the tabs exist.
   */
  async restoreTabs(saved: Array<{ url: string; active?: boolean }>) {
    const open = saved.filter((t) => !refusal(t.url));
    if (open.length === 0) return;
    const old = [...this.tabs.keys()];
    let activeId: string | undefined;
    for (const tab of open) {
      const page = await this.context.newPage();
      this.adopt(page, false);
      void page.goto(withScheme(tab.url), { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
      if (tab.active || !activeId) activeId = this.ids.get(page);
    }
    for (const id of old) await this.tabs.get(id)?.close().catch(() => {});
    if (activeId) await this.human.switchTab(activeId);
    // The resumed conversation is told about the reopened tabs in words; no stale tab events.
    this.changes.splice(0);
  }

  /** Visible interactive elements of the active tab (`button "Sign in"` + ref), for Jev to pick from. */
  async clickTargets(): Promise<Array<{ ref: string; label: string }>> {
    const tree = await this.tree(this.page(), { mode: "read", filter: "interactive" });
    const targets: Array<{ ref: string; label: string }> = [];
    for (const line of tree.split("\n")) {
      const match = line.trim().match(/^(.*?) \[(ref_\d+)\]/);
      if (match && !match[1].endsWith('""')) targets.push({ ref: match[2], label: match[1] });
    }
    return targets;
  }

  /** Direct actions for the Jev fast path, on the active tab. */
  readonly fast = {
    click: async (ref: string) => {
      const page = this.page();
      const { x, y } = await this.point(page, { type: "ref", ref });
      await page.mouse.click(x, y);
    },
    scroll: async (dir: "up" | "down" | "top" | "bottom") => {
      const page = this.page();
      if (dir === "top" || dir === "bottom") {
        await page.evaluate((toBottom) => scrollTo({ top: toBottom ? document.documentElement.scrollHeight : 0, behavior: "instant" }), dir === "bottom");
        return;
      }
      await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);
      await page.mouse.wheel(0, (dir === "down" ? 1 : -1) * VIEWPORT.height * 0.8);
      await page.waitForTimeout(150);
    },
    evaluate: <T>(fn: () => T): Promise<T> => this.page().evaluate(fn),
  };

  /** The active tab as a JPEG, for a viewer that just connected (the screencast only sends on repaint). */
  async snapshot(): Promise<Buffer | null> {
    const page = this.activeId ? this.tabs.get(this.activeId) : undefined;
    return page ? page.screenshot({ type: "jpeg", quality: 70, timeout: 5_000 }).catch(() => null) : null;
  }

  /** Releases a mouse button a cancelled run may have left held down. */
  async releaseInput() {
    const page = this.activeId ? this.tabs.get(this.activeId) : undefined;
    await page?.mouse.up().catch(() => {});
  }

  override async close(): Promise<void> {
    await super.close();
    await this.stopScreencast();
    await this.context.close().catch(() => {});
  }
}

// MARK: Helpers

/**
 * Wraps a page function as a source string. tsx compiles with keepNames, which inserts calls to an
 * `__name` helper the page doesn't have, so the string defines a no-op one first.
 */
function inPage<A, R>(fn: (arg: A) => R, arg: A): string {
  return `(() => { const __name = (f) => f; return (${fn.toString()})(${JSON.stringify(arg ?? null)}); })()`;
}

/** Lets a click's effects start: a short pause, then a brief wait for a navigation it began. */
async function settle(page: Page) {
  await page.waitForTimeout(150);
  await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
}

function keyMods(text: string | null | undefined) {
  return keyCall(() => modifiers(text));
}

function keyCall<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof KeyError) throw new ToolError(`Error: ${err.message}`);
    throw err;
  }
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(Math.max(n, lo), hi);
}

function oneLine(s: string) {
  return s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim().slice(0, 4096);
}

function stripQuery(url: string) {
  const parsed = URL.parse(url);
  if (!parsed) return oneLine(url);
  parsed.search = "";
  parsed.hash = "";
  parsed.username = "";
  parsed.password = "";
  return oneLine(parsed.toString());
}

function shortError(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return oneLine(msg.split("\n")[0]).slice(0, 200);
}

export type { BetaBrowserCoordinateTarget };
