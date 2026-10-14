import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { BrowserAgent, MODELS, anthropicCreate, type Outcome } from "./agent.ts";
import { PlaywrightBrowser, VIEWPORT } from "./browser.ts";
import { jevFromEnv } from "./jev/client.ts";
import { isFast, runFast } from "./jev/fastActions.ts";
import { JevRouter } from "./jev/router.ts";
import { slim, validHistory, validTabs } from "./session.ts";
import { DEFAULT_VOICE, Speaker, VOICES, chunks } from "./tts.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC = join(ROOT, "public");
const ENV_FILE = join(ROOT, ".env");
const PORT = Number(process.env.PORT ?? 4477);
const HOST = "127.0.0.1";

if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const log = (...parts: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...parts);

// MARK: Browser and agent

const browser = await PlaywrightBrowser.launch({
  profileDir: join(ROOT, ".browser-profile"),
  headless: process.env.HEADED !== "1",
});

let client = makeClient();
function makeClient() {
  return process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
}

const agent = new BrowserAgent(
  (params, options) => {
    if (!client) throw new MissingKeyError();
    return anthropicCreate(client)(params, options);
  },
  browser,
  {
    onNote: (text) => broadcast({ type: "note", text }),
    onAction: (text) => broadcast({ type: "action", text }),
    onLog: (text) => log(text),
  },
);

class MissingKeyError extends Error {
  constructor() {
    super("No Anthropic API key yet. Add one in Settings.");
  }
}

// Jev reads each spoken command first and runs the simple ones directly; the rest go to Claude.
const router = new JevRouter(jevFromEnv());
log(router.enabled ? "Jev fast path: on" : "Jev fast path: off (no TYPESAFE_API_KEY)");

// Claude's replies are read out in a natural voice made on this computer; load it now so the first
// reply doesn't wait. If it fails, the page falls back to the browser's own voices.
const speaker = new Speaker(log);
speaker.warm().then(() => broadcastStatus(), () => {});

let running: AbortController | null = null;
/** The page's id for the current conversation, so it can save it and pick it up again. */
let sessionId: string | null = null;
/** Claude's last reply when it asked something, so Jev can read "no" as an answer. */
let lastQuestion: string | null = null;
/** What the fast path did since Claude's last turn; told to Claude so follow-ups make sense. */
let fastSinceClaude: string[] = [];

async function runCommand(text: string) {
  if (running) return;
  const controller = new AbortController();
  running = controller;
  log(`command: ${text}`);
  broadcast({ type: "working", text });
  const question = lastQuestion;
  lastQuestion = null;
  const t0 = performance.now();
  const jevWasOn = router.enabled;
  try {
    let forClaude = text;
    const routed = await router.decide(
      {
        utterance: text,
        claudeQuestion: question,
        tabs: (await browser.tabList()).map((t) => ({ id: t.tab_id, title: t.title, active: !!t.active })),
        clickTargets: () => browser.clickTargets(),
      },
      controller.signal,
    );
    const d = routed.decision;
    log(`jev: ${d.kind}${d.kind === "claude" ? ` (${d.reason})` : ""} in ${routed.ms} ms`, routed.requestId ? `request ${routed.requestId} ${routed.model}` : "");
    if (controller.signal.aborted) throw new Error("aborted");
    if (jevWasOn && !router.enabled) broadcast({ type: "note", text: "Jev rejected the TypeSafe key; using Claude for everything." });

    switch (d.kind) {
      case "stop":
        broadcast({ type: "stopped" });
        return;
      case "reset":
        agent.reset();
        fastSinceClaude = [];
        sessionId = null;
        broadcast({ type: "fast", text: "⚡ Jev: started a new conversation", reset: true });
        return;
      case "decline":
        fastSinceClaude.push(`declined your question ("${question}")`);
        broadcast({ type: "reply", text: "Okay, I won't.", expectsAnswer: false, chunks: ["Okay, I won't."] });
        return;
    }
    if (isFast(d)) {
      try {
        const did = await runFast(browser, d);
        fastSinceClaude.push(did);
        broadcast({ type: "fast", text: `⚡ Jev: ${did} (${((performance.now() - t0) / 1000).toFixed(2)} s)` });
        return;
      } catch (err) {
        log("fast action failed:", err);
        forClaude = `${text}\n\n(A quick action for this failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)})`;
      }
    }

    if (!client) throw new MissingKeyError();
    if (fastSinceClaude.length) {
      forClaude = `(Since your last turn the user, without you: ${fastSinceClaude.join("; ")}.)\n\n${forClaude}`;
      fastSinceClaude = [];
    }
    const outcome = await agent.run(forClaude, controller.signal);
    const { spoken, expectsAnswer } = speech(outcome);
    if (expectsAnswer) lastQuestion = spoken;
    log(`reply: ${spoken}`);
    broadcast({ type: "reply", text: spoken, expectsAnswer, chunks: chunks(spoken) });
  } catch (err) {
    if (controller.signal.aborted) {
      broadcast({ type: "stopped" });
    } else {
      log("error:", err);
      broadcast({ type: "error", text: describeError(err) });
    }
  } finally {
    await browser.releaseInput();
    running = null;
    broadcastStatus();
    void broadcastSnapshot();
  }
}

/** Sends the page what it needs to save this conversation: Claude's history (slimmed) and the tabs. */
async function broadcastSnapshot() {
  if (!sessionId) return;
  const tabs = (await browser.tabList()).map((t) => ({ url: t.url, title: t.title, active: !!t.active }));
  broadcast({ type: "snapshot", sessionId, model: agent.config.model, messages: slim([...agent.history]), tabs });
}

/** Picks up a saved conversation: Claude's history, the model it used, and its tabs. */
async function resume(msg: Record<string, unknown>) {
  stop();
  while (running) await new Promise((r) => setTimeout(r, 50));
  const history = validHistory(msg.messages);
  const id = str(msg.sessionId);
  if (!id || !history) throw new Error("That saved session couldn't be read, so it can't be continued.");
  const model = str(msg.model);
  if (MODELS.some((m) => m.id === model)) agent.config.model = model;
  agent.load(history);
  sessionId = id;
  lastQuestion = null;
  const tabs = validTabs(msg.tabs);
  fastSinceClaude = history.length
    ? ["came back to this conversation later; the tabs were reopened at their saved addresses, so anything not in the address (scroll position, typed text, open menus) is gone and earlier screenshots were not kept"]
    : [];
  await browser.restoreTabs(tabs);
  log(`resumed session ${id}: ${history.length} messages, ${tabs.length} tabs`);
  broadcast({ type: "resumed", sessionId: id });
  broadcastStatus();
}

function speech(outcome: Outcome): { spoken: string; expectsAnswer: boolean } {
  switch (outcome.kind) {
    case "reply":
      return { spoken: outcome.text || "Done.", expectsAnswer: outcome.text.trim().endsWith("?") };
    case "stepLimit":
      return {
        spoken: `I stopped after ${agent.config.maxSteps} steps without finishing. Tell me to continue if you want me to keep going.`,
        expectsAnswer: false,
      };
    case "refused":
      return { spoken: outcome.text, expectsAnswer: false };
    case "truncated":
      return { spoken: outcome.text || "I ran out of room to answer. Try asking again.", expectsAnswer: false };
  }
}

function describeError(err: unknown): string {
  if (err instanceof MissingKeyError) return err.message;
  if (err instanceof Anthropic.AuthenticationError) return "Anthropic rejected the API key. Check it in Settings.";
  if (err instanceof Anthropic.PermissionDeniedError) return "This API key can't use that model.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by Anthropic. Try again in a moment.";
  if (err instanceof Anthropic.InternalServerError) return "Anthropic is having trouble right now. Try again in a moment.";
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach Anthropic. Check the internet connection.";
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status ?? ""}: ${err.message}`.slice(0, 300);
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

function stop() {
  running?.abort();
}

function saveKey(key: string) {
  const trimmed = key.trim();
  const lines = existsSync(ENV_FILE)
    ? readFileSync(ENV_FILE, "utf8").split("\n").filter((l) => l && !l.startsWith("ANTHROPIC_API_KEY="))
    : [];
  if (trimmed) lines.push(`ANTHROPIC_API_KEY=${trimmed}`);
  writeFileSync(ENV_FILE, lines.join("\n") + "\n", { mode: 0o600 });
  chmodSync(ENV_FILE, 0o600);
  if (trimmed) process.env.ANTHROPIC_API_KEY = trimmed;
  else delete process.env.ANTHROPIC_API_KEY;
  client = makeClient();
}

// MARK: HTTP

const allowedOrigins = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}`);
  if (url.pathname === "/tts") return tts(req, res);
  const path = normalize(url.pathname === "/" ? "/index.html" : url.pathname);
  const file = join(PUBLIC, path);
  if (!file.startsWith(PUBLIC) || !TYPES[extname(file)]) {
    res.writeHead(404).end("Not found");
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": TYPES[extname(file)],
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
});

/** POST /tts {text, voice}: one chunk of a reply as WAV. Only for our own page. */
async function tts(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST" || !allowedOrigins.has(req.headers.origin ?? "")) {
    res.writeHead(403).end();
    return;
  }
  let body = "";
  for await (const part of req) {
    body += part;
    if (body.length > 10_000) {
      res.writeHead(413).end();
      return;
    }
  }
  try {
    const { text, voice } = JSON.parse(body) as { text?: unknown; voice?: unknown };
    const say = str(text).trim().slice(0, 1000);
    if (!say) {
      res.writeHead(400).end();
      return;
    }
    const wav = await speaker.speak(say, str(voice) || DEFAULT_VOICE);
    res.writeHead(200, { "content-type": "audio/wav", "cache-control": "no-store" }).end(wav);
  } catch (err) {
    log("tts failed:", err instanceof Error ? err.message : err);
    res.writeHead(503).end();
  }
}

// MARK: WebSocket

const wss = new WebSocketServer({
  server,
  // Only our own page may connect: blocks other sites (and pages in the driven browser) from the socket.
  verifyClient: ({ origin }: { origin?: string }) => !!origin && allowedOrigins.has(origin),
  // A resumed session's history comes in one message.
  maxPayload: 16 << 20,
});

const sockets = new Set<WebSocket>();

function broadcast(message: Record<string, unknown>) {
  const data = JSON.stringify(message);
  for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(data);
}

async function status() {
  return {
    type: "status",
    working: running !== null,
    hasKey: client !== null,
    jev: router.enabled,
    sessionId,
    voices: VOICES,
    defaultVoice: DEFAULT_VOICE,
    voiceReady: speaker.ready,
    model: agent.config.model,
    models: MODELS,
    viewport: VIEWPORT,
    tabs: await browser.tabList(),
  };
}

function broadcastStatus() {
  void status().then(broadcast);
}

// A tab switch starts a new screencast, which stays silent until the page repaints: send a still.
browser.onTabsChanged(() => {
  broadcastStatus();
  setTimeout(async () => {
    const still = await browser.snapshot();
    if (still) for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(still, { binary: true });
  }, 300);
});

wss.on("connection", async (ws) => {
  sockets.add(ws);
  // Messages run one at a time, in order, so a click lands before the typing that follows it.
  let queue = Promise.resolve();
  ws.on("message", (raw, isBinary) => {
    if (isBinary) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    queue = queue.then(() => handle(msg)).catch((err) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "error", text: describeError(err) }));
    });
  });
  // Live view: binary JPEG frames of the active tab. Skip frames when the socket is backed up.
  const unsubscribe = browser.onFrame((jpeg) => {
    if (ws.readyState === ws.OPEN && ws.bufferedAmount < 2_000_000) ws.send(jpeg, { binary: true });
  });
  ws.on("close", () => {
    sockets.delete(ws);
    unsubscribe();
  });
  ws.send(JSON.stringify(await status()));
  const first = await browser.snapshot();
  if (first && ws.readyState === ws.OPEN) ws.send(first, { binary: true });
});

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown) => (typeof v === "string" ? v : "");

async function handle(msg: Record<string, unknown>) {
  switch (msg.type) {
    case "command": {
      const text = str(msg.text).trim().slice(0, 4000);
      if (str(msg.sessionId) && !running) sessionId = str(msg.sessionId);
      if (text) void runCommand(text);
      return;
    }
    case "resume":
      await resume(msg);
      return;
    case "stop":
      stop();
      return;
    case "reset":
      stop();
      agent.reset();
      fastSinceClaude = [];
      lastQuestion = null;
      sessionId = str(msg.sessionId) || null;
      broadcast({ type: "note", text: "Started a new conversation." });
      return;
    case "model": {
      const id = str(msg.id);
      if (id !== agent.config.model && MODELS.some((m) => m.id === id)) {
        agent.config.model = id;
        agent.config.useBetas = true;
        // Thinking blocks belong to the model that wrote them; start clean on a switch.
        if (agent.messageCount) broadcast({ type: "cleared" });
        agent.reset();
        sessionId = null;
      }
      broadcastStatus();
      return;
    }
    case "key":
      saveKey(str(msg.key));
      broadcastStatus();
      return;
    case "input":
      await humanInput(msg);
      return;
  }
}

async function humanInput(msg: Record<string, unknown>) {
  const h = browser.human;
  switch (msg.kind) {
    case "click": return h.click(num(msg.x), num(msg.y), msg.button === "right" ? "right" : "left", Math.min(3, Math.max(1, num(msg.count) || 1)));
    case "wheel": return h.wheel(num(msg.x), num(msg.y), num(msg.dx), num(msg.dy));
    case "key": return h.key(str(msg.key));
    case "type": return h.type(str(msg.text));
    case "navigate": return h.navigate(str(msg.url));
    case "back": return h.back();
    case "forward": return h.forward();
    case "reload": return h.reload();
    case "switchTab": return h.switchTab(str(msg.id));
    case "newTab": return h.newTab();
    case "closeTab": return h.closeTab(str(msg.id));
  }
}

server.listen(PORT, HOST, () => {
  log(`VoiceUse is running: open http://localhost:${PORT}`);
  if (!client) log("No ANTHROPIC_API_KEY yet: add one in the page's Settings, or put it in web/.env");
});

async function shutdown() {
  stop();
  wss.close();
  server.close();
  await browser.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
