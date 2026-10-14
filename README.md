# VoiceUse

Say what you want, and Claude does it in a web browser while you watch. It reads its answer back
out loud.

The main app is the **web app** in [`web/`](web/). The original macOS menu-bar app (Swift, controls
the whole Mac) is still here under `Sources/`, see [The macOS app](#the-macos-app).

## Get started

VoiceUse runs on your own computer with your own Anthropic API key. Nothing is hosted for you, and
your key never leaves your machine except to call the Anthropic API.

1. Install [Node.js 22 or newer](https://nodejs.org).
2. Get an API key: sign in at <https://console.anthropic.com/settings/keys>, click **Create Key**,
   and add some credit under **Billing**. You pay Anthropic directly for what you use; longer tasks
   with many steps cost more, and Claude Sonnet 5.5 (in Settings) is cheaper than Opus.
3. Download and start VoiceUse:

   ```bash
   git clone https://github.com/kxhyra-sys/voiceuse.git
   cd voiceuse/web
   npm install          # also downloads Chromium for Playwright
   npm start
   ```

4. Open <http://localhost:4477> in Chrome, Edge or Safari (they have speech recognition; in Firefox
   you can type requests), paste your key in **Settings**, and press **Space** to talk.

The key is saved to `web/.env`, which git ignores. You can also start with
`ANTHROPIC_API_KEY=sk-ant-… npm start`.

## Using it

- **Space** or the talk bar: talk / finish talking / stop a running task / skip the spoken reply
- **Esc**: stop everything
- Say "stop" or "never mind" to cancel, "start over" to forget the conversation
- When Claude asks a question, the mic opens again so you can just answer
- Before anything irreversible (sending, buying, deleting) Claude asks first
- **Click the live view** to take over the page yourself: log in, type a password, solve a CAPTCHA.
  Claude never types passwords. Click outside the page to hand the keyboard back.

Options: `HEADED=1 npm start` also shows the Chromium window; `PORT=5000` changes the port;
`VOICEUSE_MODEL=claude-sonnet-5-5` picks the starting model (also switchable in Settings).

## Voice and sessions

Replies are read in a natural voice made on this computer by [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M)
(`server/tts.ts`). The model (~90 MB) downloads on the first start; nothing is sent anywhere. Pick
one of ten voices, or a browser voice, in **Settings** and press **Play sample**.

Every conversation is saved in the page's localStorage after each reply: what was said, Claude's
history (without screenshots), and the open tabs. **Sessions** lists them; **Continue** picks one up
and reopens its tabs. After a server restart the page continues the last session by itself.

## Jev fast path (optional)

Without a TypeSafe key, everything goes to Claude and this section doesn't apply. With one, every spoken command first goes to [Jev](https://docs.typesafe.ai) (`jev-1.13.0`),
which decides in ~250 ms what you asked for. Simple commands then run directly, without Claude:
scroll, back/forward, reload, new/close/switch tab, "click <something on the page>", "go to <site>",
stop, start over, and "no" to a question Claude asked. Everything else, anything Jev is unsure
about, and any click that might send/buy/delete goes to Claude as before. Fast actions show as
`⚡ Jev: …` in the log, and Claude is told about them on its next turn.

```bash
echo 'TYPESAFE_API_KEY=…' >> web/.env   # or export it before npm start
```

Questions and thresholds live in `web/server/jev/questions.ts`. `npm test` runs a live routing check
against Jev (`test/jev.live.test.ts`) when the key is set, and reports accuracy and latency.

## How it works

```
 your browser (web/public)              Node server (web/server)                 Anthropic API
 ┌──────────────────────────┐  WebSocket  ┌────────────────────────────┐  HTTPS  ┌────────────────┐
 │ speech in (Web Speech)   │────────────▶│ agent.ts  Messages API loop │────────▶│ claude-opus-5-5│
 │ speech out (speechSynth) │◀────────────│ browser.ts  Playwright      │◀────────│ browser toolset│
 │ live view, your clicks   │ JPEG frames │   driving Chromium          │         └────────────────┘
 └──────────────────────────┘             └────────────────────────────┘
```

- `server/agent.ts`: the agent loop on the `browser_toolset_20260801` tool. Keeps the conversation
  between requests, stops a batch at the first failed action, survives cancels mid-turn, and drops the
  optional betas (refusal fallback, progress notes, old-screenshot clearing) if the API rejects them.
- `server/browser.ts`: the toolset driver, a subclass of the SDK's `BetaAbstractBrowserToolset20260801`.
  Clicks, typing, scrolling, tabs, page reading with element refs (`read_page`, `find`), form filling,
  screenshots at 1280×800. Also streams the active tab to the page and replays your own clicks and keys.
- `server/urlPolicy.ts`: Claude may only open public `http(s)` sites. `localhost`, private networks and
  other schemes are refused, both for Claude's own navigations and for links and redirects in pages.
- The browser profile is kept in `web/.browser-profile`, so logins survive restarts. Delete the folder
  to start clean. Only sign in to accounts you're comfortable letting Claude act in.
- The server listens on `127.0.0.1` only and accepts WebSocket connections from its own page only.

```bash
npm test             # key mapping, URL policy, agent loop, and the driver in real headless Chromium
npm run typecheck
```

## The macOS app

A menu-bar app that controls the whole Mac (any app, not only a browser) with the computer use
toolset. Press **⌃⌥Space** and speak.

```bash
scripts/build-app.sh
open build/VoiceUse.app
```

Then from the menu-bar icon: **Set API Key…** and grant **Microphone & Speech**, **Accessibility** and
**Screen Recording**. Log: `~/Library/Logs/VoiceUse.log`. Tests: `swift test`.

## License

[MIT](LICENSE)
